'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

const availabilityFor = db.prepare(
  'SELECT id, weekday, start_time, end_time FROM availability WHERE artist_id = ? ORDER BY weekday, start_time',
);
const clearAvailability = db.prepare('DELETE FROM availability WHERE artist_id = ?');
const insertAvailability = db.prepare(
  'INSERT INTO availability (artist_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
);
const artistProfile = db.prepare(`
  SELECT u.id, u.name, p.session_minutes, p.accepting_clients
  FROM users u JOIN artist_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'artist'
`);
const busyOnDay = db.prepare(`
  SELECT starts_at, ends_at FROM appointments
  WHERE artist_id = ? AND status IN ('pending', 'confirmed') AND substr(starts_at, 1, 10) = ?
`);
const overlapping = db.prepare(`
  SELECT COUNT(*) AS n FROM appointments
  WHERE artist_id = ? AND status IN ('pending', 'confirmed') AND starts_at < ? AND ends_at > ?
`);

const APPT_SELECT = `
  SELECT ap.*,
         a.name AS artist_name, a.avatar_url AS artist_avatar_url,
         c.name AS client_name, c.avatar_url AS client_avatar_url,
         p.studio_name, r.title AS request_title
  FROM appointments ap
  JOIN users a ON a.id = ap.artist_id
  JOIN users c ON c.id = ap.client_id
  LEFT JOIN artist_profiles p ON p.user_id = ap.artist_id
  LEFT JOIN tattoo_requests r ON r.id = ap.request_id
`;
const getAppointment = db.prepare(`${APPT_SELECT} WHERE ap.id = ?`);
const appointmentsForUser = db.prepare(
  `${APPT_SELECT} WHERE ap.artist_id = ? OR ap.client_id = ? ORDER BY ap.starts_at ASC`,
);
const insertAppointment = db.prepare(`
  INSERT INTO appointments (artist_id, client_id, request_id, starts_at, ends_at, note)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const setStatus = db.prepare('UPDATE appointments SET status = ? WHERE id = ?');
const getRequestOwner = db.prepare('SELECT client_id FROM tattoo_requests WHERE id = ?');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Local "now" formatted like our stored timestamps (YYYY-MM-DDTHH:MM). */
function localNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Compute free slots for an artist on a given day. */
function slotsFor(artist, date) {
  const weekday = weekdayOf(date);
  const windows = availabilityFor.all(artist.id).filter((w) => w.weekday === weekday);
  const busy = busyOnDay.all(artist.id, date);
  const now = localNow();
  const length = artist.session_minutes || 120;
  const slots = new Map();
  for (const w of windows) {
    for (let start = toMinutes(w.start_time); start + length <= toMinutes(w.end_time); start += length) {
      const startsAt = `${date}T${fromMinutes(start)}`;
      if (slots.has(startsAt)) continue; // overlapping windows share slots
      const endsAt = `${date}T${fromMinutes(start + length)}`;
      const taken = busy.some((b) => b.starts_at < endsAt && b.ends_at > startsAt);
      slots.set(startsAt, { starts_at: startsAt, ends_at: endsAt, available: !taken && startsAt > now });
    }
  }
  return Array.from(slots.values()).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
}

router.get('/artists/:id/availability', (req, res) => {
  const artist = artistProfile.get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  res.json({
    availability: availabilityFor.all(artist.id),
    session_minutes: artist.session_minutes,
    accepting_clients: !!artist.accepting_clients,
  });
});

router.put('/artists/me/availability', requireRole('artist'), (req, res) => {
  const windows = Array.isArray((req.body || {}).availability) ? req.body.availability : null;
  if (!windows) return res.status(400).json({ error: 'Send an availability list.' });
  const cleaned = [];
  for (const w of windows) {
    const weekday = Number(w.weekday);
    const start = String(w.start_time || '');
    const end = String(w.end_time || '');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return res.status(400).json({ error: 'Invalid weekday.' });
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return res.status(400).json({ error: 'Times must look like 09:00.' });
    if (toMinutes(start) >= toMinutes(end)) return res.status(400).json({ error: 'End time must be after start time.' });
    cleaned.push([weekday, start, end]);
  }
  db.transaction(() => {
    clearAvailability.run(req.user.id);
    cleaned.forEach(([d, s, e]) => insertAvailability.run(req.user.id, d, s, e));
  })();
  res.json({ availability: availabilityFor.all(req.user.id) });
});

/** GET /api/artists/:id/slots?date=YYYY-MM-DD */
router.get('/artists/:id/slots', (req, res) => {
  const artist = artistProfile.get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  const date = String(req.query.date || '');
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Pass a date like 2026-09-15.' });
  res.json({ date, session_minutes: artist.session_minutes, slots: slotsFor(artist, date) });
});

router.get('/appointments', requireAuth, (req, res) => {
  const list = appointmentsForUser.all(req.user.id, req.user.id);
  res.json({ appointments: list });
});

router.post('/appointments', requireRole('client'), (req, res) => {
  const body = req.body || {};
  const artist = artistProfile.get(body.artist_id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  if (!artist.accepting_clients) return res.status(400).json({ error: 'This artist is not taking new bookings right now.' });
  const startsAt = String(body.starts_at || '');
  if (!DATETIME_RE.test(startsAt)) return res.status(400).json({ error: 'Pick a time slot.' });
  const date = startsAt.slice(0, 10);
  const slot = slotsFor(artist, date).find((s) => s.starts_at === startsAt);
  if (!slot) return res.status(400).json({ error: 'That time is outside the artist\'s hours.' });
  if (!slot.available) return res.status(409).json({ error: 'That slot has already been taken. Pick another one.' });
  if (overlapping.get(artist.id, slot.ends_at, slot.starts_at).n > 0) {
    return res.status(409).json({ error: 'That slot has already been taken. Pick another one.' });
  }

  let requestId = null;
  if (body.request_id) {
    const owner = getRequestOwner.get(body.request_id);
    if (owner && owner.client_id === req.user.id) requestId = Number(body.request_id);
  }

  const info = insertAppointment.run(
    artist.id, req.user.id, requestId, slot.starts_at, slot.ends_at, String(body.note || '').slice(0, 2000),
  );
  res.status(201).json({ appointment: getAppointment.get(info.lastInsertRowid) });
});

const TRANSITIONS = {
  confirm: { from: ['pending'], to: 'confirmed', by: 'artist' },
  decline: { from: ['pending'], to: 'declined', by: 'artist' },
  complete: { from: ['confirmed'], to: 'completed', by: 'artist' },
  cancel: { from: ['pending', 'confirmed'], to: 'cancelled', by: 'either' },
};

router.post('/appointments/:id/:action', requireAuth, (req, res) => {
  const rule = TRANSITIONS[req.params.action];
  if (!rule) return res.status(404).json({ error: 'Unknown action.' });
  const appt = getAppointment.get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
  const isArtist = appt.artist_id === req.user.id;
  const isClient = appt.client_id === req.user.id;
  if (!isArtist && !isClient) return res.status(403).json({ error: 'This is not your appointment.' });
  if (rule.by === 'artist' && !isArtist) return res.status(403).json({ error: 'Only the artist can do that.' });
  if (!rule.from.includes(appt.status)) {
    return res.status(400).json({ error: `You cannot ${req.params.action} an appointment that is ${appt.status}.` });
  }
  setStatus.run(rule.to, appt.id);
  res.json({ appointment: getAppointment.get(appt.id) });
});

module.exports = router;
