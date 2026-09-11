'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const ledger = require('../ledger');
const mailer = require('../mailer');
const analytics = require('../analytics');
const calendar = require('../calendar');
const consent = require('../consent');
const flash = require('./flash');

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
  SELECT u.id, u.name, p.session_minutes, p.accepting_clients, p.deposit_amount
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
         p.studio_name, a.location AS artist_location, r.title AS request_title,
         f.title AS flash_title, f.thumb_url AS flash_thumb_url, f.image_url AS flash_image_url, f.price AS flash_price,
         (SELECT rv.id FROM reviews rv WHERE rv.appointment_id = ap.id) AS review_id
  FROM appointments ap
  JOIN users a ON a.id = ap.artist_id
  JOIN users c ON c.id = ap.client_id
  LEFT JOIN artist_profiles p ON p.user_id = ap.artist_id
  LEFT JOIN tattoo_requests r ON r.id = ap.request_id
  LEFT JOIN flash_designs f ON f.id = ap.flash_id
`;
const getAppointment = db.prepare(`${APPT_SELECT} WHERE ap.id = ?`);
const appointmentsForUser = db.prepare(
  `${APPT_SELECT} WHERE ap.artist_id = ? OR ap.client_id = ? ORDER BY ap.starts_at ASC`,
);
const insertAppointment = db.prepare(`
  INSERT INTO appointments (artist_id, client_id, request_id, starts_at, ends_at, note, deposit_amount, flash_id, price)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const setStatus = db.prepare('UPDATE appointments SET status = ? WHERE id = ?');
const setPrice = db.prepare('UPDATE appointments SET price = ? WHERE id = ?');
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
      const external = calendar.busyBetween.get(artist.id, endsAt, startsAt);
      slots.set(startsAt, { starts_at: startsAt, ends_at: endsAt, available: !taken && !external && startsAt > now, busy: !!external });
    }
  }
  return Array.from(slots.values()).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
}

router.get('/artists/:id/availability', (req, res) => {
  const artist = artistProfile.get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  analytics.track(req, 'booking_page_view', artist.id);
  res.json({
    availability: availabilityFor.all(artist.id),
    session_minutes: artist.session_minutes,
    accepting_clients: !!artist.accepting_clients,
    deposit_amount: artist.deposit_amount || 0,
    refund_window_hours: ledger.CANCEL_REFUND_HOURS,
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
  const list = ledger.attachPayments(appointmentsForUser.all(req.user.id, req.user.id));
  list.forEach((a) => {
    a.calendar = ['pending', 'confirmed'].includes(a.status) ? calendar.links(a, req.user.id) : null;
    a.consent = consent.statusFor(a.id, a.artist_id);
  });
  res.json({ appointments: list, timezone: calendar.TIMEZONE });
});

/** One appointment as an .ics file, for the parties involved. */
router.get('/appointments/:id/calendar.ics', requireAuth, (req, res) => {
  const appt = getAppointment.get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
  if (appt.artist_id !== req.user.id && appt.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your appointment.' });
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="inkwell-session-${appt.id}.ics"`, 'Cache-Control': 'private, no-cache' });
  res.send(calendar.eventFile(appt, req.user.id));
});

router.get('/appointments/:id', requireAuth, (req, res) => {
  const appt = getAppointment.get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
  if (appt.artist_id !== req.user.id && appt.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your appointment.' });
  res.json({ appointment: ledger.attachPayments([appt])[0] });
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
  if (slot.busy) return res.status(409).json({ error: 'The artist is busy then. Pick another slot.' });
  if (!slot.available) return res.status(409).json({ error: 'That slot has already been taken. Pick another one.' });
  if (overlapping.get(artist.id, slot.ends_at, slot.starts_at).n > 0) {
    return res.status(409).json({ error: 'That slot has already been taken. Pick another one.' });
  }
  if (calendar.busyBetween.get(artist.id, slot.ends_at, slot.starts_at)) {
    return res.status(409).json({ error: 'The artist is busy then. Pick another slot.' });
  }

  let requestId = null;
  if (body.request_id) {
    const owner = getRequestOwner.get(body.request_id);
    if (owner && owner.client_id === req.user.id) requestId = Number(body.request_id);
  }

  // A flash design can be attached: it fixes the session price and takes one-off designs off the board.
  let flashRow = null;
  if (body.flash_id) {
    flashRow = flash.getFlash.get(body.flash_id);
    if (!flashRow || flashRow.artist_id !== artist.id) return res.status(404).json({ error: 'That flash design is not offered by this artist.' });
    if (flashRow.status !== 'available') return res.status(409).json({ error: 'That design has just been claimed by someone else.' });
  }

  const deposit = flashRow ? Math.min(artist.deposit_amount || 0, flashRow.price) : (artist.deposit_amount || 0);
  const appointment = db.transaction(() => {
    const info = insertAppointment.run(
      artist.id, req.user.id, requestId, slot.starts_at, slot.ends_at, String(body.note || '').slice(0, 2000), deposit, flashRow ? flashRow.id : null, flashRow ? flashRow.price : null,
    );
    if (flashRow) flash.claim(flashRow.id);
    const appt = getAppointment.get(info.lastInsertRowid);
    ledger.createPending({ appointment: appt, kind: 'deposit', amount: deposit, note: 'Booking deposit' });
    return appt;
  })();

  const [withPayments] = ledger.attachPayments([appointment]);
  mailer.notify(mailer.templates.bookingRequested(withPayments));
  const depositPayment = withPayments.payments.find((p) => p.kind === 'deposit');
  if (depositPayment) mailer.notify(mailer.templates.paymentDue(depositPayment, withPayments));
  res.status(201).json({ appointment: withPayments });
});

const TRANSITIONS = {
  confirm: { from: ['pending'], to: 'confirmed', by: 'artist' },
  decline: { from: ['pending'], to: 'declined', by: 'artist' },
  complete: { from: ['confirmed'], to: 'completed', by: 'artist' },
  cancel: { from: ['pending', 'confirmed'], to: 'cancelled', by: 'either' },
};

router.post('/appointments/:id/:action', requireAuth, async (req, res) => {
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

  const action = req.params.action;
  const actorRole = isArtist ? 'artist' : 'client';

  if (action === 'complete') {
    const consentStatus = consent.statusFor(appt.id, appt.artist_id);
    if (consentStatus.required && !consentStatus.signed_at && !(req.body || {}).skip_consent) {
      return res.status(400).json({ error: `${appt.client_name} has not signed the consent form. Ask them to sign it, or complete anyway.`, consent_missing: true });
    }
    // The artist can record the session total; the remainder after the deposit becomes a balance payment.
    // Flash bookings default to the design's price.
    const raw = (req.body || {}).price === undefined || (req.body || {}).price === '' ? (appt.flash_id ? appt.price : undefined) : (req.body || {}).price;
    if (raw !== undefined && raw !== null && raw !== '') {
      const price = Number(raw);
      if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Enter a valid session total.' });
      const paidDeposit = ledger.paymentsForAppt.all(appt.id)
        .filter((p) => p.kind === 'deposit' && p.status === 'paid').reduce((n, p) => n + p.amount, 0);
      db.transaction(() => {
        setPrice.run(Math.round(price), appt.id);
        setStatus.run(rule.to, appt.id);
        const balance = ledger.createPending({ appointment: appt, kind: 'balance', amount: Math.round(price) - paidDeposit, note: 'Session balance' });
        if (balance) mailer.notify(mailer.templates.paymentDue(balance, appt));
      })();
    } else {
      setStatus.run(rule.to, appt.id);
    }
  } else {
    setStatus.run(rule.to, appt.id);
  }

  const updated = getAppointment.get(appt.id);
  if (updated.flash_id) {
    if (action === 'complete') flash.sold(updated.flash_id);
    else if (action === 'cancel' || action === 'decline') flash.release(updated.flash_id);
  }
  await ledger.settle(updated, action, actorRole);
  const recipient = isArtist ? updated.client_id : updated.artist_id;
  mailer.notify({ to: recipient, ...mailer.templates.bookingStatus(updated, action, req.user.name, action === 'confirm' ? calendar.links(updated, recipient) : null) });
  res.json({ appointment: ledger.attachPayments([updated])[0] });
});

module.exports = router;
