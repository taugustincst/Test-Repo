'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../auth');
const calendar = require('../calendar');

const api = express.Router();
const pub = express.Router();

/* Private feed by token; the token is the only secret, so treat it like a password. */
pub.get('/calendar/:token.ics', (req, res) => {
  const user = calendar.userByToken.get(req.params.token);
  if (!user || user.suspended_at) return res.status(404).type('text/plain').send('Not found');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, no-cache', 'Content-Disposition': 'inline; filename="inkwell.ics"' });
  res.send(calendar.feedFor(user));
});

api.use(requireAuth);

api.get('/', (req, res) => {
  const token = calendar.tokenFor(req.user.id);
  const out = { feed: calendar.feedUrls(token), timezone: calendar.TIMEZONE, session_reminders: req.user.session_reminders !== false };
  if (req.user.role === 'artist') out.busy = calendar.busyStatus(req.user.id);
  res.json(out);
});

api.post('/reset', (req, res) => {
  const token = calendar.tokenFor(req.user.id, { reset: true });
  res.json({ feed: calendar.feedUrls(token) });
});

api.put('/busy', requireRole('artist'), async (req, res, next) => {
  try {
    const v = calendar.normalizeBusyUrl((req.body || {}).url);
    if (v.error) return res.status(400).json({ error: v.error });
    calendar.setBusyCalendar(req.user.id, v.url);
    if (!v.url) return res.json({ busy: calendar.busyStatus(req.user.id) });
    const result = await calendar.syncBusyCalendar(req.user.id);
    const busy = calendar.busyStatus(req.user.id);
    if (result.error) return res.status(400).json({ error: `Saved, but the calendar could not be read: ${result.error}`, busy });
    res.json({ busy });
  } catch (err) { next(err); }
});

api.post('/busy/sync', requireRole('artist'), async (req, res, next) => {
  try {
    const result = await calendar.syncBusyCalendar(req.user.id);
    const busy = calendar.busyStatus(req.user.id);
    if (result.skipped) return res.status(400).json({ error: 'Add a calendar address first.', busy });
    if (result.error) return res.status(400).json({ error: result.error, busy });
    res.json({ busy });
  } catch (err) { next(err); }
});

api.delete('/busy', requireRole('artist'), (req, res) => {
  calendar.setBusyCalendar(req.user.id, '');
  res.json({ busy: calendar.busyStatus(req.user.id) });
});

module.exports = { api, pub };
