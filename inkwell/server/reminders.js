'use strict';

/**
 * Scheduled nudges, run at startup and then every ten minutes:
 * - session reminders the day before and two hours before a confirmed session (artist and client),
 * - a "still needs your confirmation" nudge to the artist for pending sessions two days out,
 * - one review reminder per completed session, two days later, when the client has not reviewed,
 * - refreshes of artists' external busy calendars,
 * - passive stencil generation for pieces that have none yet.
 * Every reminder is recorded so it is sent once, whatever the process uptime.
 */

const { db } = require('./db');
const mailer = require('./mailer');
const calendar = require('./calendar');
const consent = require('./consent');
const stencils = require('./stencils');

const REVIEW_AFTER_DAYS = Number(process.env.INKWELL_REVIEW_REMINDER_DAYS) || 2;
const REVIEW_WINDOW_DAYS = 30;
const LEADS = { day: 24 * 60, soon: 2 * 60 }; // minutes before the session
const CONFIRM_LEAD_MINUTES = 48 * 60;
const INTERVAL_MS = 10 * 60000;

const APPT = `
  SELECT ap.*, a.name AS artist_name, c.name AS client_name, p.studio_name, a.location AS artist_location,
         a.session_reminders AS artist_reminders, c.session_reminders AS client_reminders
  FROM appointments ap JOIN users a ON a.id = ap.artist_id JOIN users c ON c.id = ap.client_id
  LEFT JOIN artist_profiles p ON p.user_id = ap.artist_id
  WHERE a.suspended_at IS NULL AND c.suspended_at IS NULL
`;
const upcomingConfirmed = db.prepare(`${APPT} AND ap.status = 'confirmed' AND ap.starts_at > @now AND ap.starts_at <= @until ORDER BY ap.starts_at ASC LIMIT 500`);
const upcomingPending = db.prepare(`${APPT} AND ap.status = 'pending' AND ap.starts_at > @now AND ap.starts_at <= @until ORDER BY ap.starts_at ASC LIMIT 500`);
const alreadySent = db.prepare('SELECT 1 FROM appointment_reminders WHERE appointment_id = ? AND user_id = ? AND kind = ?');
const recordSent = db.prepare('INSERT OR IGNORE INTO appointment_reminders (appointment_id, user_id, kind) VALUES (?, ?, ?)');

const dueForReviewReminder = db.prepare(`
  SELECT ap.id, ap.client_id, ap.artist_id, ap.starts_at, a.name AS artist_name
  FROM appointments ap
  JOIN users a ON a.id = ap.artist_id
  JOIN users c ON c.id = ap.client_id
  WHERE ap.status = 'completed' AND ap.review_reminded_at IS NULL AND c.suspended_at IS NULL AND a.suspended_at IS NULL
    AND datetime(replace(ap.ends_at, 'T', ' ')) <= datetime('now', ?)
    AND datetime(replace(ap.ends_at, 'T', ' ')) >= datetime('now', ?)
    AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.appointment_id = ap.id)
  ORDER BY ap.ends_at ASC LIMIT 200
`);
const markReminded = db.prepare(`UPDATE appointments SET review_reminded_at = datetime('now') WHERE id = ?`);

function minutesUntil(stamp, now) {
  return Math.round((calendar.fromLocal(stamp).getTime() - now.getTime()) / 60000);
}

/**
 * Session reminders. For each confirmed session within a day, each party that wants reminders
 * gets the closest due reminder ("soon" beats "day"); both kinds are then marked so a restart
 * never repeats them.
 */
function sendSessionReminders(now = new Date()) {
  const nowStamp = calendar.toLocal(now);
  const until = calendar.toLocal(new Date(now.getTime() + LEADS.day * 60000));
  let sent = 0;
  for (const appt of upcomingConfirmed.all({ now: nowStamp, until })) {
    const left = minutesUntil(appt.starts_at, now);
    const due = left <= LEADS.soon ? 'soon' : (left <= LEADS.day ? 'day' : null);
    if (!due) continue;
    for (const [userId, wants] of [[appt.artist_id, appt.artist_reminders !== 0], [appt.client_id, appt.client_reminders !== 0]]) {
      if (alreadySent.get(appt.id, userId, due)) continue;
      recordSent.run(appt.id, userId, due);
      if (due === 'soon') recordSent.run(appt.id, userId, 'day'); // the day-before slot has passed
      if (!wants) continue;
      appt.consent_pending = !consent.statusFor(appt.id, appt.artist_id).signed_at;
      mailer.notify(mailer.templates.sessionReminder(appt, userId, due, calendar.links(appt, userId)));
      sent += 1;
    }
  }
  return sent;
}

/** Nudge artists about pending bookings starting within two days. */
function sendConfirmationNudges(now = new Date()) {
  const nowStamp = calendar.toLocal(now);
  const until = calendar.toLocal(new Date(now.getTime() + CONFIRM_LEAD_MINUTES * 60000));
  let sent = 0;
  for (const appt of upcomingPending.all({ now: nowStamp, until })) {
    if (alreadySent.get(appt.id, appt.artist_id, 'confirm')) continue;
    recordSent.run(appt.id, appt.artist_id, 'confirm');
    mailer.notify(mailer.templates.confirmationNudge(appt));
    sent += 1;
  }
  return sent;
}

/** Send review reminders that are due. Returns how many were sent. */
function sendReviewReminders() {
  const rows = dueForReviewReminder.all(`-${REVIEW_AFTER_DAYS} days`, `-${REVIEW_WINDOW_DAYS} days`);
  for (const appt of rows) {
    markReminded.run(appt.id);
    mailer.notify(mailer.templates.reviewReminder(appt, appt.client_id));
  }
  return rows.length;
}

async function runAll() {
  const out = {};
  try { out.session_reminders = sendSessionReminders(); } catch (err) { console.error('[reminders] sessions', err.message); }
  try { out.confirmation_nudges = sendConfirmationNudges(); } catch (err) { console.error('[reminders] confirmations', err.message); }
  try { out.review_reminders = sendReviewReminders(); } catch (err) { console.error('[reminders] reviews', err.message); }
  try { out.busy_calendars = await calendar.syncStaleBusyCalendars(); } catch (err) { console.error('[reminders] busy calendars', err.message); }
  try { out.stencils = await stencils.backfill(); } catch (err) { console.error('[reminders] stencils', err.message); }
  return out;
}

/** Start the schedule. The timer is unref'd so it never keeps a process alive. */
function start(intervalMs = INTERVAL_MS) {
  runAll();
  const timer = setInterval(runAll, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { sendSessionReminders, sendConfirmationNudges, sendReviewReminders, runAll, start, REVIEW_AFTER_DAYS, LEADS, INTERVAL_MS };
