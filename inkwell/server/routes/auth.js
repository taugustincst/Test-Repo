'use strict';

const express = require('express');
const { db, STYLES } = require('../db');
const {
  createSession, destroySession, hashPassword, verifyPassword, withProfile, requireAuth,
} = require('../auth');
const { upload, publicUrl, removeByUrl } = require('../upload');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare(
  'SELECT id, email, name, role, avatar_url, bio, location, created_at FROM users WHERE id = ?',
);
const insertUser = db.prepare(`
  INSERT INTO users (email, password_hash, name, role, location, bio)
  VALUES (@email, @password_hash, @name, @role, @location, @bio)
`);
const insertProfile = db.prepare(`
  INSERT INTO artist_profiles (user_id, studio_name, styles) VALUES (?, ?, ?)
`);

router.post('/register', (req, res) => {
  const { email, password, name, role, location = '', studio_name = '', styles = [] } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email))) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!['artist', 'client'].includes(role)) return res.status(400).json({ error: 'Choose whether you are an artist or a client.' });
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
  createSession(res, userId);
  res.status(201).json({ user: withProfile(findById.get(userId)) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? findByEmail.get(String(email).trim()) : null;
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  createSession(res, user.id);
  res.json({ user: withProfile(findById.get(user.id)) });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user, styles: STYLES });
});

const updateUser = db.prepare(`
  UPDATE users SET name = @name, bio = @bio, location = @location WHERE id = @id
`);
const upsertProfile = db.prepare(`
  INSERT INTO artist_profiles
    (user_id, studio_name, styles, hourly_rate, min_price, session_minutes, years_experience, instagram, website, accepting_clients)
  VALUES
    (@user_id, @studio_name, @styles, @hourly_rate, @min_price, @session_minutes, @years_experience, @instagram, @website, @accepting_clients)
  ON CONFLICT(user_id) DO UPDATE SET
    studio_name = excluded.studio_name,
    styles = excluded.styles,
    hourly_rate = excluded.hourly_rate,
    min_price = excluded.min_price,
    session_minutes = excluded.session_minutes,
    years_experience = excluded.years_experience,
    instagram = excluded.instagram,
    website = excluded.website,
    accepting_clients = excluded.accepting_clients
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
      });
    }
  })();

  res.json({ user: withProfile(findById.get(req.user.id)) });
});

const updateAvatar = db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?');

router.post('/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  removeByUrl(req.user.avatar_url);
  const url = publicUrl(req.file.filename);
  updateAvatar.run(url, req.user.id);
  res.json({ user: withProfile(findById.get(req.user.id)) });
});

module.exports = router;
