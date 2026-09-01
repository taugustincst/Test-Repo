'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const COOKIE_NAME = 'inkwell_session';
const SESSION_DAYS = 30;

const getUserByToken = db.prepare(`
  SELECT u.id, u.email, u.name, u.role, u.avatar_url, u.bio, u.location, u.created_at
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token = ? AND s.created_at > datetime('now', ?)
`);
const insertSession = db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
const getProfile = db.prepare('SELECT * FROM artist_profiles WHERE user_id = ?');

/** Attach artist profile fields (parsed) to a user object when the user is an artist. */
function withProfile(user) {
  if (!user) return user;
  if (user.role === 'artist') {
    const profile = getProfile.get(user.id) || {};
    user.profile = {
      studio_name: profile.studio_name || '',
      styles: safeParse(profile.styles, []),
      hourly_rate: profile.hourly_rate ?? null,
      min_price: profile.min_price ?? null,
      session_minutes: profile.session_minutes ?? 120,
      years_experience: profile.years_experience ?? null,
      instagram: profile.instagram || '',
      website: profile.website || '',
      accepting_clients: profile.accepting_clients === undefined ? true : !!profile.accepting_clients,
    };
  }
  return user;
}

function safeParse(json, fallback) {
  try {
    const value = JSON.parse(json);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Express middleware: loads req.user from the session cookie if present. */
function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  req.user = null;
  if (token) {
    const user = getUserByToken.get(token, `-${SESSION_DAYS} days`);
    if (user) req.user = withProfile(user);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to be signed in to do that.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'You need to be signed in to do that.' });
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do that.` });
    }
    next();
  };
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(token, userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
  return token;
}

function destroySession(req, res) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (token) deleteSession.run(token);
  res.clearCookie(COOKIE_NAME);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

module.exports = {
  COOKIE_NAME,
  loadUser,
  requireAuth,
  requireRole,
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  withProfile,
  safeParse,
};
