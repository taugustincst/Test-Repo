'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../auth');
const { removeByUrl } = require('../upload');
const mailer = require('../mailer');

const router = express.Router();
router.use(requireAdmin);

const overview = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM users WHERE role = 'artist') AS artists,
    (SELECT COUNT(*) FROM users WHERE role = 'client') AS clients,
    (SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL) AS suspended,
    (SELECT COUNT(*) FROM artworks) AS artworks,
    (SELECT COUNT(*) FROM tattoo_requests WHERE status = 'open') AS open_requests,
    (SELECT COUNT(*) FROM appointments WHERE status IN ('pending', 'confirmed')) AS active_bookings,
    (SELECT COUNT(*) FROM reports WHERE status = 'open') AS open_reports,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status IN ('paid', 'forfeited')) AS payments_collected,
    (SELECT COUNT(*) FROM users WHERE created_at > datetime('now', '-7 days')) AS signups_7d
`);

const REPORT_SELECT = `
  SELECT rp.*, u.name AS reporter_name, u.email AS reporter_email
  FROM reports rp JOIN users u ON u.id = rp.reporter_id
`;
const listReports = db.prepare(`${REPORT_SELECT} WHERE rp.status = ? ORDER BY rp.created_at ASC, rp.id ASC LIMIT 200`);
const listClosed = db.prepare(`${REPORT_SELECT} WHERE rp.status IN ('resolved', 'dismissed') ORDER BY rp.resolved_at DESC, rp.id DESC LIMIT 200`);
const getReport = db.prepare(`${REPORT_SELECT} WHERE rp.id = ?`);
const resolveReport = db.prepare(`
  UPDATE reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
`);

const targetDetail = {
  artwork: db.prepare(`
    SELECT a.id, a.title, a.image_url, a.thumb_url, a.description, a.artist_id AS owner_id, u.name AS owner_name
    FROM artworks a JOIN users u ON u.id = a.artist_id WHERE a.id = ?`),
  comment: db.prepare(`
    SELECT c.id, c.body, c.artwork_id, c.user_id AS owner_id, u.name AS owner_name
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`),
  user: db.prepare('SELECT id, name, email, role, bio, avatar_url, suspended_at, id AS owner_id, name AS owner_name FROM users WHERE id = ?'),
  request: db.prepare(`
    SELECT r.id, r.title, r.description, r.reference_image_url, r.client_id AS owner_id, u.name AS owner_name
    FROM tattoo_requests r JOIN users u ON u.id = r.client_id WHERE r.id = ?`),
  review: db.prepare(`
    SELECT rv.id, rv.rating, rv.body, rv.artist_id, rv.client_id AS owner_id, u.name AS owner_name
    FROM reviews rv JOIN users u ON u.id = rv.client_id WHERE rv.id = ?`),
};

const remove = {
  artwork: (id) => {
    const row = db.prepare('SELECT image_url FROM artworks WHERE id = ?').get(id);
    db.prepare('DELETE FROM artworks WHERE id = ?').run(id);
    if (row) removeByUrl(row.image_url);
  },
  comment: (id) => db.prepare('DELETE FROM comments WHERE id = ?').run(id),
  request: (id) => {
    const row = db.prepare('SELECT reference_image_url FROM tattoo_requests WHERE id = ?').get(id);
    db.prepare('DELETE FROM tattoo_requests WHERE id = ?').run(id);
    if (row) removeByUrl(row.reference_image_url);
  },
  review: (id) => db.prepare('DELETE FROM reviews WHERE id = ?').run(id),
  user: () => { throw new Error('Users are suspended, not deleted, from the moderation queue.'); },
};

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.role, u.avatar_url, u.location, u.is_admin, u.suspended_at, u.suspended_reason, u.created_at,
         (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'user' AND r.target_id = u.id AND r.status = 'open') AS open_reports
  FROM users u
`;
const listUsers = db.prepare(`${USER_SELECT} ORDER BY u.created_at DESC, u.id DESC LIMIT 100`);
const searchUsers = db.prepare(`${USER_SELECT} WHERE LOWER(u.name) LIKE ? OR LOWER(u.email) LIKE ? ORDER BY u.created_at DESC LIMIT 100`);
const getUser = db.prepare(`${USER_SELECT} WHERE u.id = ?`);
const suspendUser = db.prepare(`UPDATE users SET suspended_at = datetime('now'), suspended_reason = ? WHERE id = ?`);
const unsuspendUser = db.prepare('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?');
const killSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const setAdmin = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');

router.get('/overview', (_req, res) => {
  res.json({ overview: overview.get() });
});

router.get('/reports', (req, res) => {
  const status = ['open', 'resolved', 'dismissed', 'closed'].includes(req.query.status) ? req.query.status : 'open';
  const reports = (status === 'closed' ? listClosed.all() : listReports.all(status)).map((r) => ({
    ...r,
    target: targetDetail[r.target_type] ? targetDetail[r.target_type].get(r.target_id) || null : null,
  }));
  res.json({ reports });
});

/** Resolve a report: dismiss, remove the content, or suspend the owner (which also removes content). */
router.post('/reports/:id/resolve', (req, res) => {
  const report = getReport.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (report.status !== 'open') return res.status(400).json({ error: 'This report is already closed.' });
  const action = String((req.body || {}).action || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 1000);
  const target = targetDetail[report.target_type].get(report.target_id);

  if (action === 'dismiss') {
    resolveReport.run('dismissed', note || 'No action needed', req.user.id, report.id);
  } else if (action === 'remove') {
    if (report.target_type === 'user') return res.status(400).json({ error: 'Suspend the user instead of removing them.' });
    if (target) remove[report.target_type](report.target_id);
    resolveReport.run('resolved', note || 'Content removed', req.user.id, report.id);
  } else if (action === 'suspend') {
    const ownerId = target && target.owner_id;
    if (!ownerId) return res.status(400).json({ error: 'The content owner no longer exists.' });
    if (ownerId === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself.' });
    db.transaction(() => {
      suspendUser.run(note || `Reported for ${report.reason}`, ownerId);
      killSessions.run(ownerId);
      if (report.target_type !== 'user' && target) remove[report.target_type](report.target_id);
      resolveReport.run('resolved', note || 'Owner suspended', req.user.id, report.id);
    })();
    mailer.notify(mailer.templates.accountSuspended(ownerId, note || `Reported for ${report.reason}`));
  } else {
    return res.status(400).json({ error: 'Choose dismiss, remove, or suspend.' });
  }
  res.json({ report: getReport.get(report.id) });
});

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  res.json({ users: q ? searchUsers.all(`%${q}%`, `%${q}%`) : listUsers.all() });
});

router.post('/users/:id/suspend', (req, res) => {
  const user = getUser.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself.' });
  if (user.is_admin) return res.status(400).json({ error: 'Remove admin rights before suspending an admin.' });
  const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
  db.transaction(() => { suspendUser.run(reason || null, user.id); killSessions.run(user.id); })();
  mailer.notify(mailer.templates.accountSuspended(user.id, reason));
  res.json({ user: getUser.get(user.id) });
});

router.post('/users/:id/unsuspend', (req, res) => {
  const user = getUser.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  unsuspendUser.run(user.id);
  mailer.notify(mailer.templates.accountReinstated(user.id));
  res.json({ user: getUser.get(user.id) });
});

router.post('/users/:id/admin', (req, res) => {
  const user = getUser.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const makeAdmin = !!(req.body || {}).is_admin;
  if (!makeAdmin && user.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own admin rights.' });
  setAdmin.run(makeAdmin ? 1 : 0, user.id);
  res.json({ user: getUser.get(user.id) });
});

router.delete('/content/:type/:id', (req, res) => {
  const { type, id } = req.params;
  if (!remove[type] || type === 'user') return res.status(400).json({ error: 'Unknown content type.' });
  if (!targetDetail[type].get(id)) return res.status(404).json({ error: 'Content not found.' });
  remove[type](Number(id));
  res.json({ ok: true });
});

module.exports = router;
