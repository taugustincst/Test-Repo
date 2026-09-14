'use strict';

/* Appointment reminders and calendar sync: ICS feeds, add-to-calendar links, busy-calendar import, reminder jobs. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-cal-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const calendar = require('../server/calendar');
const reminders = require('../server/reminders');

let server;
let base;
let icsServer;
let icsBase;
let icsBody = '';
let icsStatus = 200;

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, id: r.data.user.id };
}

const idOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const icsStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

function insertAppt(artistId, clientId, startsIn, { status = 'confirmed', minutes = 120 } = {}) {
  const start = new Date(Date.now() + startsIn * 60000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + minutes * 60000);
  const info = db.prepare(`INSERT INTO appointments (artist_id, client_id, starts_at, ends_at, note, status, deposit_amount) VALUES (?, ?, ?, ?, 'Bring references', ?, 100)`).run(artistId, clientId, stamp(start), stamp(end), status);
  return { id: Number(info.lastInsertRowid), starts_at: stamp(start), ends_at: stamp(end) };
}

const emails = (userId) => db.prepare('SELECT subject, body_text FROM email_log WHERE to_user_id = ? ORDER BY id').all(userId);

before(async () => {
  seed();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  icsServer = http.createServer((req, res) => { res.writeHead(icsStatus, { 'Content-Type': 'text/calendar' }); res.end(icsBody); });
  await new Promise((resolve) => { icsServer.listen(0, resolve); });
  icsBase = `http://127.0.0.1:${icsServer.address().port}`;
});

after(() => {
  server.close();
  icsServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('iCalendar parsing: TZID, UTC, all-day, duration, folding, cancelled and transparent events', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:tz', 'DTSTART;TZID=America/New_York:20260920T100000', 'DTEND;TZID=America/New_York:20260920T120000', 'SUMMARY:Guest spot\\, NYC with a very long title that keeps going', '  and is folded across lines', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:utc', 'DTSTART:20260921T170000Z', 'DURATION:PT1H30M', 'SUMMARY:Dentist', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:day', 'DTSTART;VALUE=DATE:20260922', 'DTEND;VALUE=DATE:20260924', 'SUMMARY:Off', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:gone', 'DTSTART:20260923T090000', 'DTEND:20260923T100000', 'STATUS:CANCELLED', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:free', 'DTSTART:20260923T090000', 'DTEND:20260923T100000', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20260924T090000', 'DTEND:20260924T100000', 'SUMMARY:No uid', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = calendar.parseIcs(ics);
  assert.deepEqual(events.map((e) => e.uid.length > 0 && e.uid), [ 'tz', 'utc', 'day', events[3].uid ]);
  const tz = events.find((e) => e.uid === 'tz');
  const nyStart = new Date(Date.UTC(2026, 8, 20, 14, 0)); // 10:00 New York (EDT) = 14:00 UTC
  assert.equal(tz.starts_at, calendar.toLocal(nyStart));
  assert.equal(tz.summary, 'Guest spot, NYC with a very long title that keeps going and is folded across lines');
  const utc = events.find((e) => e.uid === 'utc');
  assert.equal(utc.starts_at, calendar.toLocal(new Date(Date.UTC(2026, 8, 21, 17, 0))));
  assert.equal(utc.ends_at, calendar.toLocal(new Date(Date.UTC(2026, 8, 21, 18, 30))));
  const day = events.find((e) => e.uid === 'day');
  assert.deepEqual([day.starts_at, day.ends_at, day.all_day], ['2026-09-22T00:00', '2026-09-24T00:00', true]);
  assert.equal(events[3].summary, 'No uid');
  assert.equal(events.some((e) => e.uid === 'gone' || e.uid === 'free'), false);
});

test('private calendar feed per user, single-event downloads and add-to-calendar links', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan, id: jordanId } = await login('jordan@inkwell.demo');
  const anon = client();
  const appt = insertAppt(maraId, jordanId, 3 * 24 * 60);

  let r = await mara.get('/api/calendar');
  assert.equal(r.status, 200);
  assert.match(r.data.feed.https, /\/calendar\/[A-Za-z0-9_-]{24}\.ics$/);
  assert.match(r.data.feed.webcal, /^webcal:/);
  assert.equal(r.data.timezone, calendar.TIMEZONE);
  assert.equal(r.data.session_reminders, true);
  assert.deepEqual(Object.keys(r.data.busy), ['url', 'synced_at', 'error', 'count']);
  const token = r.data.feed.https.match(/\/calendar\/(.+)\.ics$/)[1];
  const again = await mara.get('/api/calendar');
  assert.equal(again.data.feed.https, r.data.feed.https, 'token is stable');

  r = await anon.get(`/calendar/${token}.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.data, /BEGIN:VCALENDAR/);
  assert.match(r.data, /X-WR-CALNAME:Inkwell/);
  assert.match(r.data, new RegExp(`UID:appointment-${appt.id}@inkwell`));
  assert.match(r.data, new RegExp(`DTSTART;TZID=${calendar.TIMEZONE.replace('/', '\\/')}:${icsStamp(new Date(appt.starts_at))}`));
  assert.match(r.data, /SUMMARY:Tattoo session with Jordan Lee/, 'artist sees the client');
  assert.match(r.data, /TRIGGER:-PT120M/);
  assert.match(r.data, /Bring references/);
  r = await anon.get('/calendar/not-a-real-token.ics');
  assert.equal(r.status, 404);

  // Client feed names the artist; pending sessions are tentative.
  const pending = insertAppt(maraId, jordanId, 5 * 24 * 60, { status: 'pending' });
  const jt = (await jordan.get('/api/calendar')).data.feed.https.match(/\/calendar\/(.+)\.ics$/)[1];
  r = await anon.get(`/calendar/${jt}.ics`);
  assert.match(r.data, /SUMMARY:Tattoo session with Mara Voss/);
  assert.match(r.data, new RegExp(`UID:appointment-${pending.id}@inkwell[\\s\\S]*?SUMMARY:Pending: Tattoo session with Mara Voss[\\s\\S]*?STATUS:TENTATIVE`));

  // Resetting the link kills the old one.
  r = await mara.post('/api/calendar/reset');
  assert.notEqual(r.data.feed.https, again.data.feed.https);
  r = await anon.get(`/calendar/${token}.ics`);
  assert.equal(r.status, 404);

  // Single event file: only the parties.
  r = await jordan.get(`/api/appointments/${appt.id}/calendar.ics`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.match(r.data, /METHOD:PUBLISH/);
  const { c: hana } = await login('hana@inkwell.demo');
  r = await hana.get(`/api/appointments/${appt.id}/calendar.ics`);
  assert.equal(r.status, 403);
  r = await anon.get(`/api/appointments/${appt.id}/calendar.ics`);
  assert.equal(r.status, 401);

  // Links on the appointments list.
  r = await jordan.get('/api/appointments');
  const mine = r.data.appointments.find((a) => a.id === appt.id);
  assert.match(mine.calendar.google, /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Tattoo%20session%20with%20Mara%20Voss&dates=\d{8}T\d{6}Z%2F\d{8}T\d{6}Z/);
  assert.match(mine.calendar.outlook, /outlook\.live\.com/);
  assert.equal(mine.calendar.ics, `/api/appointments/${appt.id}/calendar.ics`);
  assert.equal(r.data.timezone, calendar.TIMEZONE);
  const done = r.data.appointments.find((a) => a.status === 'completed');
  if (done) assert.equal(done.calendar, null, 'no links for finished sessions');
});

test('session reminders: day before, two hours before, once each, honouring the preference; confirmation nudges', async () => {
  const artistId = idOf('diego@inkwell.demo');
  const { c: kwame, id: kwameId } = await login('kwame@inkwell.demo');
  const inTwoDays = insertAppt(artistId, kwameId, 2 * 24 * 60);
  const tomorrow = insertAppt(artistId, kwameId, 20 * 60);
  const soon = insertAppt(artistId, kwameId, 90);
  const pendingSoon = insertAppt(artistId, kwameId, 30 * 60, { status: 'pending' });
  const pendingLater = insertAppt(artistId, kwameId, 5 * 24 * 60, { status: 'pending' });
  const artistBefore = emails(artistId).length;
  const clientBefore = emails(kwameId).length;

  let sent = reminders.sendSessionReminders();
  assert.equal(sent, 4, 'two sessions x two people');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const clientMail = emails(kwameId).slice(clientBefore);
  assert.deepEqual(clientMail.map((m) => m.subject).sort(), ['Starting soon: session with Diego Santamaria', 'Tomorrow: your session with Diego Santamaria']);
  assert.match(clientMail.find((m) => m.subject.startsWith('Tomorrow')).body_text, /calendar\.google\.com/);
  assert.match(clientMail.find((m) => m.subject.startsWith('Tomorrow')).body_text, /Bring references/);
  assert.equal(emails(artistId).slice(artistBefore).length, 2);
  const kinds = db.prepare('SELECT appointment_id, user_id, kind FROM appointment_reminders WHERE appointment_id IN (?, ?, ?) ORDER BY appointment_id, user_id, kind').all(inTwoDays.id, tomorrow.id, soon.id);
  assert.equal(kinds.filter((k) => k.appointment_id === inTwoDays.id).length, 0, 'not due yet');
  assert.deepEqual(kinds.filter((k) => k.appointment_id === soon.id && k.user_id === kwameId).map((k) => k.kind), ['day', 'soon'], 'a soon reminder also closes the day slot');
  assert.equal(reminders.sendSessionReminders(), 0, 'nothing sent twice');

  // Later, the "tomorrow" session becomes "soon" and gets exactly one more per person.
  sent = reminders.sendSessionReminders(new Date(Date.now() + 19 * 3600000));
  assert.equal(sent, 2);
  assert.equal(reminders.sendSessionReminders(new Date(Date.now() + 19 * 3600000)), 0);

  // Opting out stops emails but still records the slot; artists are unaffected.
  let r = await kwame.put('/api/auth/me', { session_reminders: false });
  assert.equal(r.data.user.session_reminders, false);
  const quiet = insertAppt(artistId, kwameId, 60);
  const before = emails(kwameId).length;
  sent = reminders.sendSessionReminders();
  assert.equal(sent, 1, 'only the artist');
  assert.equal(emails(kwameId).length, before);
  assert.ok(db.prepare('SELECT 1 FROM appointment_reminders WHERE appointment_id = ? AND user_id = ?').get(quiet.id, kwameId));
  await kwame.put('/api/auth/me', { session_reminders: true });

  // Pending bookings within two days nudge the artist once.
  const artistMails = emails(artistId).length;
  assert.equal(reminders.sendConfirmationNudges(), 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const nudge = emails(artistId).slice(artistMails);
  assert.equal(nudge.length, 1);
  assert.match(nudge[0].subject, /Kwame Mensah's booking still needs your confirmation/);
  assert.equal(reminders.sendConfirmationNudges(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointment_reminders WHERE appointment_id = ?').get(pendingLater.id).n, 0);
  assert.ok(db.prepare('SELECT 1 FROM appointment_reminders WHERE appointment_id = ? AND kind = ?').get(pendingSoon.id, 'confirm'));

  // Cancelled sessions never remind.
  const cancelled = insertAppt(artistId, kwameId, 60, { status: 'cancelled' });
  assert.equal(reminders.sendSessionReminders(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointment_reminders WHERE appointment_id = ?').get(cancelled.id).n, 0);
  const out = await reminders.runAll();
  assert.deepEqual(Object.keys(out).sort(), ['busy_calendars', 'confirmation_nudges', 'inspiration', 'review_reminders', 'session_reminders', 'stencils']);
});

test('busy calendar import blocks slots and bookings; validation, errors and removal', async () => {
  const { c: sofia, id: sofiaId } = await login('sofia@inkwell.demo');
  const { c: lucia } = await login('lucia@inkwell.demo');

  // Find the next bookable slot for Sofia, then publish a busy event over it.
  const avail = (await sofia.get(`/api/artists/${sofiaId}/availability`)).data.availability;
  assert.ok(avail.length, 'Sofia has hours');
  let slot = null;
  let date = null;
  for (let d = 2; d < 30 && !slot; d += 1) {
    const day = new Date(Date.now() + d * 86400000);
    date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const r = await lucia.get(`/api/artists/${sofiaId}/slots?date=${date}`);
    slot = (r.data.slots || []).find((s) => s.available) || null;
  }
  assert.ok(slot, 'found a free slot');
  const busyStart = new Date(slot.starts_at);
  const busyEnd = new Date(busyStart.getTime() + 30 * 60000);
  icsBody = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:guest-spot', `DTSTART:${icsStamp(busyStart)}`, `DTEND:${icsStamp(busyEnd)}`, 'SUMMARY:Guest spot', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

  let r = await lucia.put('/api/calendar/busy', { url: `${icsBase}/cal.ics` });
  assert.equal(r.status, 403, 'clients have no busy calendar');
  r = await sofia.put('/api/calendar/busy', { url: 'ftp://nope/cal.ics' });
  assert.equal(r.status, 400);
  // webcal:// is stored as https://; the plain-http test server cannot answer https, so the read fails but the address is kept.
  r = await sofia.put('/api/calendar/busy', { url: `webcal://127.0.0.1:${icsServer.address().port}/cal.ics` });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Saved, but the calendar could not be read/);
  assert.match(r.data.busy.url, /^https:\/\//, 'webcal is stored as https');
  assert.ok(r.data.busy.error);
  r = await sofia.put('/api/calendar/busy', { url: `${icsBase}/cal.ics` });
  assert.equal(r.status, 200);
  assert.equal(r.data.busy.count, 1);
  assert.ok(r.data.busy.synced_at);

  r = await lucia.get(`/api/artists/${sofiaId}/slots?date=${date}`);
  const blocked = r.data.slots.find((s) => s.starts_at === slot.starts_at);
  assert.deepEqual([blocked.available, blocked.busy], [false, true]);
  r = await lucia.post('/api/appointments', { artist_id: sofiaId, starts_at: slot.starts_at, note: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /busy/);

  // Calendar changes: re-sync clears the block. Fetch failures keep the last good data and report the error.
  icsBody = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
  r = await sofia.post('/api/calendar/busy/sync');
  assert.equal(r.status, 200);
  assert.equal(r.data.busy.count, 0);
  r = await lucia.get(`/api/artists/${sofiaId}/slots?date=${date}`);
  assert.equal(r.data.slots.find((s) => s.starts_at === slot.starts_at).available, true);
  icsStatus = 500;
  r = await sofia.post('/api/calendar/busy/sync');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /answered 500/);
  assert.match(r.data.busy.error, /500/);
  icsStatus = 200;
  icsBody = '<html>not a calendar</html>';
  r = await sofia.post('/api/calendar/busy/sync');
  assert.equal(r.status, 400);
  assert.match(r.data.error, /did not return a calendar/);

  // The scheduler refreshes stale calendars.
  db.prepare("UPDATE artist_profiles SET busy_calendar_synced_at = datetime('now', '-2 hours') WHERE user_id = ?").run(sofiaId);
  icsBody = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', `DTSTART:${icsStamp(busyStart)}`, `DTEND:${icsStamp(busyEnd)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  assert.equal(await calendar.syncStaleBusyCalendars(), 1);
  assert.equal(calendar.busyStatus(sofiaId).count, 1);
  assert.equal(await calendar.syncStaleBusyCalendars(), 0, 'fresh calendars are left alone');

  r = await sofia.del('/api/calendar/busy');
  assert.deepEqual([r.data.busy.url, r.data.busy.count], ['', 0]);
  r = await lucia.get(`/api/artists/${sofiaId}/slots?date=${date}`);
  assert.equal(r.data.slots.find((s) => s.starts_at === slot.starts_at).available, true);
});
