'use strict';

/**
 * Calendar sync. Appointment times are naive local stamps ("2026-06-23T15:00") in the server's
 * timezone, the same convention the booking code uses. This module turns them into iCalendar
 * feeds (one private feed per user, one .ics per appointment), builds "add to calendar" links,
 * and imports an artist's external busy calendar so booked-elsewhere time never shows as free.
 */

const crypto = require('crypto');
const { db } = require('./db');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const TIMEZONE = process.env.INKWELL_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const BUSY_REFRESH_MINUTES = Number(process.env.INKWELL_BUSY_CALENDAR_REFRESH_MINUTES) || 30;
const BUSY_MAX_BYTES = 5 * 1024 * 1024;
const FEED_PAST_DAYS = 90;
const FEED_FUTURE_DAYS = 365;

const pad = (n) => String(n).padStart(2, '0');

/* ---------- time helpers ---------- */

/** "2026-06-23T15:00" (server local) -> Date. */
function fromLocal(stamp) {
  const m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Date -> "2026-06-23T15:00" in server local time. */
function toLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date -> iCalendar UTC stamp "20260623T220000Z". */
function toUtcStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Local stamp -> iCalendar floating stamp "20260623T150000" (used with TZID). */
function toIcsLocal(stamp) {
  return `${stamp.slice(0, 4)}${stamp.slice(5, 7)}${stamp.slice(8, 10)}T${stamp.slice(11, 13)}${stamp.slice(14, 16)}00`;
}

/** Offset (minutes) of an IANA zone at a given instant, via Intl. */
function zoneOffsetMinutes(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - date.getTime()) / 60000);
  } catch {
    return null;
  }
}

/** Wall-clock components in `tz` -> Date (instant). Returns null for unknown zones. */
function zonedToDate(y, mo, d, h, mi, s, tz) {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const off1 = zoneOffsetMinutes(tz, guess);
  if (off1 === null) return null;
  const first = new Date(guess.getTime() - off1 * 60000);
  const off2 = zoneOffsetMinutes(tz, first);
  return off2 === off1 ? first : new Date(guess.getTime() - off2 * 60000);
}

/* ---------- iCalendar parsing (external busy calendars) ---------- */

function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function parseProp(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const [name, ...paramParts] = line.slice(0, idx).split(';');
  const params = {};
  paramParts.forEach((p) => { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, ''); });
  return { name: name.toUpperCase(), params, value: line.slice(idx + 1) };
}

/** Parse an iCalendar date/time value into a local stamp, honouring Z, TZID and all-day dates. */
function parseIcsDate(value, params = {}) {
  const v = String(value).trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { stamp: `${m[1]}-${m[2]}-${m[3]}T00:00`, allDay: true };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  let date;
  if (m[7] === 'Z') date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  else if (params.TZID) date = zonedToDate(y, mo, d, h, mi, s, params.TZID) || new Date(y, mo - 1, d, h, mi, s);
  else date = new Date(y, mo - 1, d, h, mi, s);
  return { stamp: toLocal(date), allDay: false };
}

function parseDuration(v) {
  const m = String(v).match(/^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const minutes = (Number(m[2] || 0) * 7 * 1440) + (Number(m[3] || 0) * 1440) + (Number(m[4] || 0) * 60) + Number(m[5] || 0) + Math.round(Number(m[6] || 0) / 60);
  return m[1] ? -minutes : minutes;
}

/** Events from an iCalendar file: [{ uid, starts_at, ends_at, summary, all_day }]. Recurrence rules are not expanded. */
function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) {
        let end = cur.end;
        if (!end && cur.duration !== undefined) end = { stamp: toLocal(new Date(fromLocal(cur.start.stamp).getTime() + cur.duration * 60000)), allDay: false };
        if (!end) end = cur.start.allDay ? { stamp: toLocal(new Date(fromLocal(cur.start.stamp).getTime() + 1440 * 60000)), allDay: true } : { stamp: toLocal(new Date(fromLocal(cur.start.stamp).getTime() + 60 * 60000)), allDay: false };
        if (cur.status !== 'CANCELLED' && cur.transp !== 'TRANSPARENT' && end.stamp > cur.start.stamp) {
          events.push({ uid: cur.uid || crypto.createHash('sha1').update(`${cur.start.stamp}|${cur.summary || ''}`).digest('hex').slice(0, 24), starts_at: cur.start.stamp, ends_at: end.stamp, summary: (cur.summary || 'Busy').slice(0, 120), all_day: cur.start.allDay });
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parseProp(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': cur.uid = prop.value.slice(0, 200); break;
      case 'SUMMARY': cur.summary = prop.value.replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\\\/g, '\\'); break;
      case 'DTSTART': cur.start = parseIcsDate(prop.value, prop.params); break;
      case 'DTEND': cur.end = parseIcsDate(prop.value, prop.params); break;
      case 'DURATION': cur.duration = parseDuration(prop.value); break;
      case 'STATUS': cur.status = prop.value.toUpperCase(); break;
      case 'TRANSP': cur.transp = prop.value.toUpperCase(); break;
      default: break;
    }
  }
  return events;
}

/* ---------- iCalendar output ---------- */

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function foldLine(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 73) {
    let cut = 73;
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut)) > 73) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

function vevent(e) {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${toUtcStamp(e.stamp || new Date())}`,
    `DTSTART;TZID=${TIMEZONE}:${toIcsLocal(e.starts_at)}`,
    `DTEND;TZID=${TIMEZONE}:${toIcsLocal(e.ends_at)}`,
    `SUMMARY:${icsEscape(e.summary)}`,
    e.description ? `DESCRIPTION:${icsEscape(e.description)}` : null,
    e.location ? `LOCATION:${icsEscape(e.location)}` : null,
    e.url ? `URL:${e.url}` : null,
    `STATUS:${e.status || 'CONFIRMED'}`,
    e.sequence ? `SEQUENCE:${e.sequence}` : null,
    ...(e.alarm ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(e.summary)}`, `TRIGGER:-PT${e.alarm}M`, 'END:VALARM'] : []),
    'END:VEVENT',
  ].filter(Boolean);
  return lines.map(foldLine).join('\r\n');
}

function vcalendar(events, { name, method } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Inkwell//Bookings//EN',
    'CALSCALE:GREGORIAN',
    method ? `METHOD:${method}` : null,
    name ? `X-WR-CALNAME:${icsEscape(name)}` : null,
    `X-WR-TIMEZONE:${TIMEZONE}`,
    name ? 'REFRESH-INTERVAL;VALUE=DURATION:PT1H' : null,
    ...events.map(vevent),
    'END:VCALENDAR',
    '',
  ].filter((l) => l !== null).join('\r\n');
}

/* ---------- appointments as events ---------- */

const apptsForFeed = db.prepare(`
  SELECT ap.*, a.name AS artist_name, c.name AS client_name, p.studio_name, a.location AS artist_location
  FROM appointments ap JOIN users a ON a.id = ap.artist_id JOIN users c ON c.id = ap.client_id
  LEFT JOIN artist_profiles p ON p.user_id = ap.artist_id
  WHERE (ap.artist_id = @user OR ap.client_id = @user) AND ap.starts_at >= @from AND ap.starts_at <= @to
  ORDER BY ap.starts_at ASC
`);

function apptEvent(appt, viewerId) {
  const isArtist = appt.artist_id === viewerId;
  const other = isArtist ? appt.client_name : appt.artist_name;
  const summary = `${appt.status === 'pending' ? 'Pending: ' : ''}Tattoo session with ${other}`;
  const bits = [];
  if (appt.note) bits.push(appt.note);
  if (appt.deposit_amount) bits.push(`Deposit: $${appt.deposit_amount}`);
  if (appt.price) bits.push(`Session total: $${appt.price}`);
  bits.push(`Manage this booking: ${APP_URL}/appointments`);
  return {
    uid: `appointment-${appt.id}@inkwell`,
    starts_at: appt.starts_at,
    ends_at: appt.ends_at,
    summary,
    description: bits.join('\n'),
    location: [appt.studio_name, appt.artist_location].filter(Boolean).join(', '),
    url: `${APP_URL}/appointments`,
    status: appt.status === 'pending' ? 'TENTATIVE' : (['cancelled', 'declined'].includes(appt.status) ? 'CANCELLED' : 'CONFIRMED'),
    alarm: 120,
    stamp: new Date(),
  };
}

/** The private feed for a user: three months back, a year ahead. Cancelled sessions stay so subscribed calendars drop them. */
function feedFor(user) {
  const from = toLocal(new Date(Date.now() - FEED_PAST_DAYS * 86400000));
  const to = toLocal(new Date(Date.now() + FEED_FUTURE_DAYS * 86400000));
  const events = apptsForFeed.all({ user: user.id, from, to }).map((a) => apptEvent(a, user.id));
  return vcalendar(events, { name: `Inkwell · ${user.role === 'artist' ? 'Sessions' : 'Tattoo sessions'}` });
}

function eventFile(appt, viewerId) {
  return vcalendar([apptEvent(appt, viewerId)], { method: 'PUBLISH' });
}

/** Links for "Add to calendar" buttons and emails. */
function links(appt, viewerId) {
  const e = apptEvent(appt, viewerId);
  const start = toUtcStamp(fromLocal(appt.starts_at));
  const end = toUtcStamp(fromLocal(appt.ends_at));
  const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return {
    google: `https://calendar.google.com/calendar/render?${q({ action: 'TEMPLATE', text: e.summary, dates: `${start}/${end}`, details: e.description, location: e.location, ctz: TIMEZONE })}`,
    outlook: `https://outlook.live.com/calendar/0/action/compose?${q({ rru: 'addevent', subject: e.summary, startdt: fromLocal(appt.starts_at).toISOString(), enddt: fromLocal(appt.ends_at).toISOString(), body: e.description, location: e.location })}`,
    ics: `/api/appointments/${appt.id}/calendar.ics`,
  };
}

/* ---------- feed tokens ---------- */

const getToken = db.prepare('SELECT calendar_token FROM users WHERE id = ?');
const setToken = db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?');
const userByToken = db.prepare('SELECT id, name, role, suspended_at FROM users WHERE calendar_token = ?');

function tokenFor(userId, { reset = false } = {}) {
  const row = getToken.get(userId);
  if (row && row.calendar_token && !reset) return row.calendar_token;
  const token = crypto.randomBytes(18).toString('base64url');
  setToken.run(token, userId);
  return token;
}

function feedUrls(token) {
  const https = `${APP_URL}/calendar/${token}.ics`;
  return { https, webcal: https.replace(/^https?:/, 'webcal:'), google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(https.replace(/^https?:/, 'webcal:'))}` };
}

/* ---------- external busy calendars ---------- */

const busyProfile = db.prepare('SELECT user_id, busy_calendar_url, busy_calendar_synced_at, busy_calendar_error FROM artist_profiles WHERE user_id = ?');
const staleBusy = db.prepare(`
  SELECT user_id FROM artist_profiles
  WHERE busy_calendar_url IS NOT NULL AND busy_calendar_url != '' AND (busy_calendar_synced_at IS NULL OR busy_calendar_synced_at < datetime('now', ?))
`);
const setBusyUrl = db.prepare('UPDATE artist_profiles SET busy_calendar_url = ?, busy_calendar_synced_at = NULL, busy_calendar_error = NULL WHERE user_id = ?');
const setBusyResult = db.prepare(`UPDATE artist_profiles SET busy_calendar_synced_at = datetime('now'), busy_calendar_error = ? WHERE user_id = ?`);
const clearBusy = db.prepare('DELETE FROM busy_events WHERE artist_id = ?');
const insertBusy = db.prepare('INSERT OR REPLACE INTO busy_events (artist_id, uid, starts_at, ends_at, summary, all_day) VALUES (?, ?, ?, ?, ?, ?)');
const countBusy = db.prepare('SELECT COUNT(*) AS n FROM busy_events WHERE artist_id = ?');
const busyBetween = db.prepare('SELECT starts_at, ends_at, summary FROM busy_events WHERE artist_id = ? AND starts_at < ? AND ends_at > ?');

function normalizeBusyUrl(input) {
  let url = String(input || '').trim();
  if (!url) return { url: '' };
  url = url.replace(/^webcal:/i, 'https:');
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'That does not look like a calendar address.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Calendar addresses must start with https://, http:// or webcal://.' };
  if (parsed.username || parsed.password) return { error: 'Remove the username and password from the address.' };
  return { url: parsed.href.slice(0, 500) };
}

async function fetchIcs(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'Inkwell calendar sync' } });
    if (!res.ok) throw new Error(`The calendar server answered ${res.status}.`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > BUSY_MAX_BYTES) throw new Error('That calendar is too large to import.');
    const text = await res.text();
    if (text.length > BUSY_MAX_BYTES) throw new Error('That calendar is too large to import.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address did not return a calendar (.ics) file.');
    return text;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The calendar server took too long to answer.');
    throw err;
  } finally { clearTimeout(timer); }
}

/** Fetch and cache an artist's external calendar. Only events from the last month onward are kept. */
async function syncBusyCalendar(artistId, { fetchImpl } = {}) {
  const profile = busyProfile.get(artistId);
  if (!profile || !profile.busy_calendar_url) return { count: 0, error: null, skipped: true };
  try {
    const text = await fetchIcs(profile.busy_calendar_url, fetchImpl);
    const cutoff = toLocal(new Date(Date.now() - 30 * 86400000));
    const events = parseIcs(text).filter((e) => e.ends_at >= cutoff).slice(0, 2000);
    db.transaction(() => {
      clearBusy.run(artistId);
      events.forEach((e) => insertBusy.run(artistId, e.uid, e.starts_at, e.ends_at, e.summary, e.all_day ? 1 : 0));
      setBusyResult.run(null, artistId);
    })();
    return { count: events.length, error: null };
  } catch (err) {
    setBusyResult.run(err.message.slice(0, 200), artistId);
    return { count: countBusy.get(artistId).n, error: err.message };
  }
}

async function syncStaleBusyCalendars(opts) {
  const rows = staleBusy.all(`-${BUSY_REFRESH_MINUTES} minutes`);
  let synced = 0;
  for (const row of rows) { await syncBusyCalendar(row.user_id, opts); synced += 1; }
  return synced;
}

function busyStatus(artistId) {
  const p = busyProfile.get(artistId) || {};
  return { url: p.busy_calendar_url || '', synced_at: p.busy_calendar_synced_at || null, error: p.busy_calendar_error || null, count: countBusy.get(artistId).n };
}

function setBusyCalendar(artistId, url) {
  setBusyUrl.run(url || null, artistId);
  if (!url) clearBusy.run(artistId);
}

module.exports = {
  TIMEZONE, BUSY_REFRESH_MINUTES,
  fromLocal, toLocal, toUtcStamp, parseIcs, parseIcsDate, vcalendar,
  feedFor, eventFile, links, tokenFor, feedUrls, userByToken,
  normalizeBusyUrl, syncBusyCalendar, syncStaleBusyCalendars, busyStatus, setBusyCalendar, busyBetween,
};
