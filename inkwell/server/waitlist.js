'use strict';

/**
 * Waitlist. Clients queue for an artist (optionally for a date window or a flash design). When a
 * booked slot frees up, when the artist reopens their books, or when the artist invites someone,
 * waiting clients get a first-come booking link. Booking with the artist closes the entry.
 */

const express = require('express');
const { db } = require('./db');
const { requireAuth, requireRole } = require('./auth');
const mailer = require('./mailer');

const MAX_NOTIFY_PER_SLOT = Number(process.env.INKWELL_WAITLIST_NOTIFY_MAX) || 5;
const RENOTIFY_HOURS = 12;

const ENTRY_SELECT = `
  SELECT w.*, c.name AS client_name, c.avatar_url AS client_avatar_url, c.location AS client_location,
         a.name AS artist_name, a.avatar_url AS artist_avatar_url, p.studio_name, p.accepting_clients,
         f.title AS flash_title, f.thumb_url AS flash_thumb_url, f.status AS flash_status
  FROM waitlist w
  JOIN users c ON c.id = w.client_id
  JOIN users a ON a.id = w.artist_id
  LEFT JOIN artist_profiles p ON p.user_id = w.artist_id
  LEFT JOIN flash_designs f ON f.id = w.flash_id
`;
const getEntry = db.prepare(`${ENTRY_SELECT} WHERE w.id = ?`);
const activeFor = db.prepare(`${ENTRY_SELECT} WHERE w.client_id = ? AND w.artist_id = ? AND w.status IN ('waiting', 'notified')`);
const listForClient = db.prepare(`${ENTRY_SELECT} WHERE w.client_id = ? AND w.status IN ('waiting', 'notified') ORDER BY w.created_at DESC`);
const listForArtist = db.prepare(`${ENTRY_SELECT} WHERE w.artist_id = ? AND w.status IN ('waiting', 'notified') ORDER BY w.created_at ASC`);
const countForArtist = db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE artist_id = ? AND status IN ('waiting', 'notified')`);
const insertEntry = db.prepare('INSERT INTO waitlist (client_id, artist_id, flash_id, from_date, to_date, note) VALUES (?, ?, ?, ?, ?, ?)');
const setStatus = db.prepare(`UPDATE waitlist SET status = ?, updated_at = datetime('now') WHERE id = ?`);
const markNotified = db.prepare(`UPDATE waitlist SET status = 'notified', notified_at = datetime('now'), notify_count = notify_count + 1, updated_at = datetime('now') WHERE id = ?`);
const markBookedStmt = db.prepare(`UPDATE waitlist SET status = 'booked', updated_at = datetime('now') WHERE client_id = ? AND artist_id = ? AND status IN ('waiting', 'notified')`);
const candidatesForSlot = db.prepare(`
  ${ENTRY_SELECT}
  WHERE w.artist_id = @artist AND w.status IN ('waiting', 'notified') AND c.suspended_at IS NULL
    AND (w.from_date IS NULL OR w.from_date <= @date) AND (w.to_date IS NULL OR w.to_date >= @date)
    AND (w.notified_at IS NULL OR w.notified_at < datetime('now', @cooldown))
  ORDER BY w.created_at ASC LIMIT @limit
`);
const allWaiting = db.prepare(`${ENTRY_SELECT} WHERE w.artist_id = ? AND w.status IN ('waiting', 'notified') AND c.suspended_at IS NULL ORDER BY w.created_at ASC LIMIT 200`);
const artistRow = db.prepare('SELECT u.id, u.name, u.role, u.suspended_at, p.accepting_clients FROM users u LEFT JOIN artist_profiles p ON p.user_id = u.id WHERE u.id = ?');
const flashRow = db.prepare('SELECT id, artist_id, status FROM flash_designs WHERE id = ?');

const validDate = (v) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };

function shape(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name,
    client_avatar_url: row.client_avatar_url,
    client_location: row.client_location,
    artist_id: row.artist_id,
    artist_name: row.artist_name,
    artist_avatar_url: row.artist_avatar_url,
    studio_name: row.studio_name,
    accepting_clients: !!row.accepting_clients,
    flash_id: row.flash_id,
    flash_title: row.flash_title,
    flash_thumb_url: row.flash_thumb_url,
    from_date: row.from_date,
    to_date: row.to_date,
    note: row.note || '',
    status: row.status,
    notified_at: row.notified_at,
    notify_count: row.notify_count,
    created_at: row.created_at,
    is_mine: !!user && user.id === row.client_id,
  };
}

/* ---------- notifications ---------- */

/** A booked slot became free: tell the first few waiting clients whose window covers it. */
function slotFreed(artistId, startsAt) {
  const date = String(startsAt).slice(0, 10);
  const rows = candidatesForSlot.all({ artist: artistId, date, cooldown: `-${RENOTIFY_HOURS} hours`, limit: MAX_NOTIFY_PER_SLOT });
  for (const row of rows) {
    markNotified.run(row.id);
    mailer.notify(mailer.templates.waitlistSlot(shape(row), startsAt));
  }
  return rows.length;
}

/** The artist reopened their books: tell everyone waiting. */
function booksOpened(artistId) {
  const rows = allWaiting.all(artistId);
  for (const row of rows) {
    markNotified.run(row.id);
    mailer.notify(mailer.templates.waitlistOpen(shape(row)));
  }
  return rows.length;
}

/** A client booked with the artist: their waitlist entry is done. */
function markBooked(clientId, artistId) {
  return markBookedStmt.run(clientId, artistId).changes;
}

/* ---------- routes ---------- */

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  if (req.user.role === 'artist') return res.json({ entries: listForArtist.all(req.user.id).map((r) => shape(r, req.user)), count: countForArtist.get(req.user.id).n });
  res.json({ entries: listForClient.all(req.user.id).map((r) => shape(r, req.user)) });
});

/** Is this client waiting for this artist? Used by the profile and booking page. */
router.get('/artists/:artistId', (req, res) => {
  const row = req.user.role === 'client' ? activeFor.get(req.user.id, req.params.artistId) : null;
  res.json({ entry: shape(row, req.user), count: req.user.id === Number(req.params.artistId) ? countForArtist.get(req.user.id).n : undefined });
});

router.post('/', requireRole('client'), (req, res) => {
  const b = req.body || {};
  const artist = artistRow.get(b.artist_id);
  if (!artist || artist.role !== 'artist' || artist.suspended_at) return res.status(404).json({ error: 'Artist not found.' });
  if (activeFor.get(req.user.id, artist.id)) return res.status(409).json({ error: 'You are already on this waitlist.' });
  const from = b.from_date ? String(b.from_date) : null;
  const to = b.to_date ? String(b.to_date) : null;
  if ((from && !validDate(from)) || (to && !validDate(to))) return res.status(400).json({ error: 'Dates must look like 2026-10-01.' });
  if (from && to && from > to) return res.status(400).json({ error: 'The window ends before it starts.' });
  let flashId = null;
  if (b.flash_id) {
    const f = flashRow.get(b.flash_id);
    if (!f || f.artist_id !== artist.id) return res.status(404).json({ error: 'That flash design is not offered by this artist.' });
    flashId = f.id;
  }
  const info = insertEntry.run(req.user.id, artist.id, flashId, from, to, String(b.note || '').trim().slice(0, 500));
  const entry = shape(getEntry.get(info.lastInsertRowid), req.user);
  mailer.notify(mailer.templates.waitlistJoined(entry));
  res.status(201).json({ entry });
});

router.delete('/:id', (req, res) => {
  const row = getEntry.get(req.params.id);
  if (!row || (row.client_id !== req.user.id && row.artist_id !== req.user.id)) return res.status(404).json({ error: 'Waitlist entry not found.' });
  setStatus.run(row.client_id === req.user.id ? 'cancelled' : 'removed', row.id);
  res.json({ ok: true });
});

/** Artist invites one waiting client to book now. */
router.post('/:id/invite', requireRole('artist'), (req, res) => {
  const row = getEntry.get(req.params.id);
  if (!row || row.artist_id !== req.user.id) return res.status(404).json({ error: 'Waitlist entry not found.' });
  if (!['waiting', 'notified'].includes(row.status)) return res.status(400).json({ error: 'This entry is no longer active.' });
  markNotified.run(row.id);
  const message = String((req.body || {}).message || '').trim().slice(0, 500);
  mailer.notify(mailer.templates.waitlistInvite(shape(row), message));
  res.json({ entry: shape(getEntry.get(row.id), req.user) });
});

module.exports = { router, slotFreed, booksOpened, markBooked, countForArtist, MAX_NOTIFY_PER_SLOT, RENOTIFY_HOURS };
