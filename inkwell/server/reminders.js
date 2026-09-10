'use strict';

/**
 * Scheduled nudges. Today: one review reminder per completed session, sent two days after the
 * session when the client has not reviewed yet. Runs at startup and then hourly.
 */

const { db } = require('./db');
const mailer = require('./mailer');

const REVIEW_AFTER_DAYS = Number(process.env.INKWELL_REVIEW_REMINDER_DAYS) || 2;
const REVIEW_WINDOW_DAYS = 30;

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

/** Send review reminders that are due. Returns how many were sent. */
function sendReviewReminders() {
  const rows = dueForReviewReminder.all(`-${REVIEW_AFTER_DAYS} days`, `-${REVIEW_WINDOW_DAYS} days`);
  for (const appt of rows) {
    markReminded.run(appt.id);
    mailer.notify(mailer.templates.reviewReminder(appt, appt.client_id));
  }
  return rows.length;
}

function runAll() {
  try { return { review_reminders: sendReviewReminders() }; } catch (err) { console.error('[reminders]', err.message); return null; }
}

/** Start the hourly schedule. The timer is unref'd so it never keeps a process alive. */
function start(intervalMs = 60 * 60000) {
  runAll();
  const timer = setInterval(runAll, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { sendReviewReminders, runAll, start, REVIEW_AFTER_DAYS };
