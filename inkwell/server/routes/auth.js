'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, STYLES } = require('../db');
const mailer = require('../mailer');
const {
  COOKIE_NAME, SUSPENDED_MESSAGE, createSession, destroySession, hashPassword, verifyPassword, withProfile, requireAuth, wantsToken,
} = require('../auth');
const { upload, removeByUrl } = require('../upload');
const { processAvatar } = require('../images');
const ledger = require('../ledger');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare(`
  SELECT id, email, name, role, avatar_url, bio, location, email_notifications, push_notifications, is_admin, suspended_at, suspended_reason, terms_accepted_at, created_at
  FROM users WHERE id = ?
`);
const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, name, role, location, bio, terms_accepted_at)
  VALUES (@email, @password_hash, @name, @role, @location, @bio, datetime('now'))
`);
const MAX_PASSWORD = 200;

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > MAX_PASSWORD) return `Password must be ${MAX_PASSWORD} characters or fewer.`;
  return null;
}
const insertProfile = db.prepare(`
  INSERT INTO artist_profiles (user_id, studio_name, styles) VALUES (?, ?, ?)
`);

router.post('/register', (req, res) => {
  const { email, password, name, role, location = '', studio_name = '', styles = [], accept_terms: acceptTerms } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Enter a valid email address.' });
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!['artist', 'client'].includes(role)) return res.status(400).json({ error: 'Choose whether you are an artist or a client.' });
  if (!acceptTerms || acceptTerms === 'false') return res.status(400).json({ error: 'You need to accept the Terms of Service and Privacy Policy.' });
  if (findByEmail.get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const chosenStyles = Array.isArray(styles) ? styles.filter((s) => STYLES.includes(s)) : [];

  const create = db.transaction(() => {
    const info = insertUser.run({
      email: String(email).trim().toLowerCase(),
      password_hash: hashPassword(String(password)),
      name: String(name).trim(),
      role,
      location: String(location).trim(),
      bio: '',
    });
    if (role === 'artist') {
      insertProfile.run(info.lastInsertRowid, String(studio_name).trim(), JSON.stringify(chosenStyles));
    }
    return info.lastInsertRowid;
  });

  const userId = create();
  const token = createSession(res, userId);
  const user = withProfile(findById.get(userId));
  mailer.notify(mailer.templates.welcome(user));
  res.status(201).json(wantsToken(req) ? { user, token } : { user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? findByEmail.get(String(email).trim()) : null;
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (user.suspended_at) return res.status(403).json({ error: SUSPENDED_MESSAGE, suspended: true });
  const token = createSession(res, user.id);
  const payload = { user: withProfile(findById.get(user.id)) };
  if (wantsToken(req)) payload.token = token;
  res.json(payload);
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.post('/logout-all', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user, styles: STYLES });
});

const updateUser = db.prepare(`
  UPDATE users SET name = @name, bio = @bio, location = @location, email_notifications = @email_notifications, push_notifications = @push_notifications WHERE id = @id
`);
const upsertProfile = db.prepare(`
  INSERT INTO artist_profiles
    (user_id, studio_name, styles, hourly_rate, min_price, session_minutes, years_experience, instagram, website, accepting_clients, deposit_amount)
  VALUES
    (@user_id, @studio_name, @styles, @hourly_rate, @min_price, @session_minutes, @years_experience, @instagram, @website, @accepting_clients, @deposit_amount)
  ON CONFLICT(user_id) DO UPDATE SET
    studio_name = excluded.studio_name,
    styles = excluded.styles,
    hourly_rate = excluded.hourly_rate,
    min_price = excluded.min_price,
    session_minutes = excluded.session_minutes,
    years_experience = excluded.years_experience,
    instagram = excluded.instagram,
    website = excluded.website,
    accepting_clients = excluded.accepting_clients,
    deposit_amount = excluded.deposit_amount
`);

function optionalInt(value, { min = 0, max = 1000000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

router.put('/me', requireAuth, (req, res) => {
  const body = req.body || {};
  const name = String(body.name ?? req.user.name).trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  db.transaction(() => {
    updateUser.run({
      id: req.user.id,
      name,
      bio: String(body.bio ?? req.user.bio ?? '').slice(0, 2000),
      location: String(body.location ?? req.user.location ?? '').slice(0, 120),
      email_notifications: body.email_notifications === undefined
        ? (req.user.email_notifications === false ? 0 : 1)
        : (body.email_notifications ? 1 : 0),
      push_notifications: body.push_notifications === undefined
        ? (req.user.push_notifications === false ? 0 : 1)
        : (body.push_notifications ? 1 : 0),
    });
    if (req.user.role === 'artist') {
      const current = req.user.profile;
      const styles = Array.isArray(body.styles)
        ? body.styles.filter((s) => STYLES.includes(s))
        : current.styles;
      upsertProfile.run({
        user_id: req.user.id,
        studio_name: String(body.studio_name ?? current.studio_name).slice(0, 120),
        styles: JSON.stringify(styles),
        hourly_rate: body.hourly_rate === undefined ? current.hourly_rate : optionalInt(body.hourly_rate),
        min_price: body.min_price === undefined ? current.min_price : optionalInt(body.min_price),
        session_minutes: body.session_minutes === undefined
          ? current.session_minutes
          : (optionalInt(body.session_minutes, { min: 30, max: 720 }) || 120),
        years_experience: body.years_experience === undefined
          ? current.years_experience
          : optionalInt(body.years_experience, { max: 80 }),
        instagram: String(body.instagram ?? current.instagram).replace(/^@/, '').slice(0, 60),
        website: String(body.website ?? current.website).slice(0, 200),
        accepting_clients: body.accepting_clients === undefined ? (current.accepting_clients ? 1 : 0) : (body.accepting_clients ? 1 : 0),
        deposit_amount: body.deposit_amount === undefined ? current.deposit_amount : (optionalInt(body.deposit_amount, { max: 100000 }) || 0),
      });
    }
  })();

  res.json({ user: withProfile(findById.get(req.user.id)) });
});

const updateAvatar = db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?');
const updatePassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteOtherSessions = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?');
const deleteAllSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const insertReset = db.prepare(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))`);
const findReset = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`);
const useReset = db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`);
const voidResets = db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL`);
const recentEmails = db.prepare(`
  SELECT id, subject, body_text, status, created_at FROM email_log WHERE to_user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
`);

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

router.put('/me/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = findByEmail.get(req.user.email);
  if (!verifyPassword(String(current_password || ''), user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  const problem = passwordProblem(new_password);
  if (problem) return res.status(400).json({ error: problem.replace('Password', 'New password') });
  updatePassword.run(hashPassword(String(new_password)), user.id);
  deleteOtherSessions.run(user.id, req.authToken);
  voidResets.run(user.id);
  mailer.notify(mailer.templates.passwordChanged(user));
  res.json({ ok: true });
});

/** Always responds 200 so the endpoint cannot be used to discover accounts. */
router.post('/forgot', async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  const user = email ? findByEmail.get(email) : null;
  const response = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
  if (!user) return res.json(response);
  const token = crypto.randomBytes(32).toString('hex');
  voidResets.run(user.id);
  insertReset.run(user.id, hashToken(token));
  const url = `${mailer.APP_URL}/reset?token=${token}`;
  await mailer.send(mailer.templates.passwordReset(user, url));
  // Without a mail server there is no way to receive the link, so expose it outside production.
  if (!mailer.live && process.env.NODE_ENV !== 'production') response.dev_reset_url = url;
  res.json(response);
});

router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!token) return res.status(400).json({ error: 'This reset link is missing its token.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const reset = findReset.get(hashToken(String(token)));
  if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  db.transaction(() => {
    updatePassword.run(hashPassword(String(password)), reset.user_id);
    useReset.run(reset.id);
    deleteAllSessions.run(reset.user_id);
  })();
  const sessionToken = createSession(res, reset.user_id);
  const user = withProfile(findById.get(reset.user_id));
  mailer.notify(mailer.templates.passwordChanged(user));
  res.json(wantsToken(req) ? { user, token: sessionToken } : { user });
});

/** Recent emails sent to the signed-in user (handy when no SMTP server is configured). */
router.get('/me/emails', requireAuth, (req, res) => {
  res.json({ emails: recentEmails.all(req.user.id), live: mailer.live });
});

router.post('/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  let url;
  try { url = await processAvatar(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
  removeByUrl(req.user.avatar_url);
  updateAvatar.run(url, req.user.id);
  res.json({ user: withProfile(findById.get(req.user.id)) });
});

/* ---------- data export and account deletion ---------- */

const exportQueries = {
  galleries: db.prepare('SELECT * FROM galleries WHERE artist_id = ?'),
  artworks: db.prepare('SELECT * FROM artworks WHERE artist_id = ?'),
  comments: db.prepare('SELECT * FROM comments WHERE user_id = ?'),
  likes: db.prepare('SELECT * FROM likes WHERE user_id = ?'),
  follows: db.prepare('SELECT * FROM follows WHERE follower_id = ?'),
  requests: db.prepare('SELECT * FROM tattoo_requests WHERE client_id = ?'),
  proposals: db.prepare('SELECT * FROM proposals WHERE artist_id = ?'),
  availability: db.prepare('SELECT * FROM availability WHERE artist_id = ?'),
  appointments: db.prepare('SELECT * FROM appointments WHERE artist_id = ? OR client_id = ?'),
  payments: db.prepare('SELECT * FROM payments WHERE payer_id = ? OR payee_id = ?'),
  messages: db.prepare('SELECT * FROM messages WHERE sender_id = ? OR recipient_id = ?'),
  reviews: db.prepare('SELECT * FROM reviews WHERE client_id = ? OR artist_id = ?'),
  saved_replies: db.prepare('SELECT * FROM saved_replies WHERE user_id = ?'),
  conversation_state: db.prepare('SELECT * FROM conversation_state WHERE user_id = ?'),
  blocks: db.prepare('SELECT * FROM blocks WHERE blocker_id = ?'),
};

router.get('/me/export', requireAuth, (req, res) => {
  const id = req.user.id;
  const two = new Set(['appointments', 'payments', 'messages', 'reviews']);
  const data = { exported_at: new Date().toISOString(), profile: req.user };
  for (const [key, stmt] of Object.entries(exportQueries)) data[key] = two.has(key) ? stmt.all(id, id) : stmt.all(id);
  res.setHeader('Content-Disposition', `attachment; filename="inkwell-export-${id}.json"`);
  res.json(data);
});

const activeAppointments = db.prepare(`
  SELECT ap.*, a.name AS artist_name, c.name AS client_name FROM appointments ap
  JOIN users a ON a.id = ap.artist_id JOIN users c ON c.id = ap.client_id
  WHERE (ap.artist_id = ? OR ap.client_id = ?) AND ap.status IN ('pending', 'confirmed')
`);
const cancelAppointment = db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`);
const filesFor = {
  artworks: db.prepare('SELECT image_url AS url FROM artworks WHERE artist_id = ?'),
  references: db.prepare('SELECT reference_image_url AS url FROM tattoo_requests WHERE client_id = ? AND reference_image_url IS NOT NULL'),
};
const sentAttachments = db.prepare('SELECT attachments FROM messages WHERE sender_id = ? AND attachments IS NOT NULL');
const purge = [
  'DELETE FROM galleries WHERE artist_id = ?',
  'DELETE FROM comments WHERE user_id = ?',
  'DELETE FROM likes WHERE user_id = ?',
  'DELETE FROM follows WHERE follower_id = ? OR artist_id = ?',
  'DELETE FROM tattoo_requests WHERE client_id = ?',
  'DELETE FROM proposals WHERE artist_id = ?',
  'DELETE FROM availability WHERE artist_id = ?',
  'DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?',
  'DELETE FROM conversation_state WHERE user_id = ? OR other_id = ?',
  'DELETE FROM saved_replies WHERE user_id = ?',
  'DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?',
  'DELETE FROM reviews WHERE client_id = ?',
  'DELETE FROM sessions WHERE user_id = ?',
  'DELETE FROM password_resets WHERE user_id = ?',
  'DELETE FROM reports WHERE reporter_id = ?',
].map((sql) => ({ stmt: db.prepare(sql), two: (sql.match(/\?/g) || []).length === 2 }));
const anonymize = db.prepare(`
  UPDATE users SET email = ?, password_hash = ?, name = 'Deleted user', avatar_url = NULL, bio = '', location = '',
    email_notifications = 0, suspended_at = datetime('now'), suspended_reason = 'account deleted', is_admin = 0
  WHERE id = ?
`);
const closeProfile = db.prepare(`UPDATE artist_profiles SET accepting_clients = 0, studio_name = '', instagram = '', website = '' WHERE user_id = ?`);

/**
 * Delete the account: content and personal data are removed, while appointment and payment
 * records are kept (anonymised) for accounting. Active bookings are cancelled with the usual refunds.
 */
router.delete('/me', requireAuth, async (req, res) => {
  const user = findByEmail.get(req.user.email);
  if (!verifyPassword(String((req.body || {}).password || ''), user.password_hash)) {
    return res.status(400).json({ error: 'Enter your current password to delete the account.' });
  }
  const id = user.id;
  const actorRole = user.role;
  for (const appt of activeAppointments.all(id, id)) {
    cancelAppointment.run(appt.id);
    await ledger.settle(appt, 'cancel', actorRole);
    const other = appt.artist_id === id ? appt.client_id : appt.artist_id;
    mailer.notify({ to: other, ...mailer.templates.bookingStatus({ ...appt, status: 'cancelled' }, 'cancel', user.name) });
  }
  await mailer.send(mailer.templates.accountDeleted(user));
  const files = [...filesFor.artworks.all(id), ...filesFor.references.all(id)].map((f) => f.url);
  sentAttachments.all(id).forEach((row) => {
    try { JSON.parse(row.attachments).forEach((a) => { if (a && a.type === 'image' && a.url) files.push(a.url); }); } catch { /* ignore */ }
  });
  db.transaction(() => {
    purge.forEach(({ stmt, two }) => (two ? stmt.run(id, id) : stmt.run(id)));
    if (user.role === 'artist') closeProfile.run(id);
    anonymize.run(`deleted-${id}@deleted.invalid`, hashPassword(crypto.randomBytes(24).toString('hex')), id);
  })();
  files.forEach(removeByUrl);
  if (user.avatar_url) removeByUrl(user.avatar_url);
  destroySession(req, res);
  res.json({ ok: true });
});

module.exports = router;
