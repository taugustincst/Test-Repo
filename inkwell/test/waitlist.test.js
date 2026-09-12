'use strict';

/* Waitlist: joining and leaving, slot-freed notifications with windows and cooldown, books reopening, artist invites, booking closes the entry. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-waitlist-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');

let server;
let base;

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, id: r.data.user.id };
}

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mails = (userId) => db.prepare('SELECT subject, body_text FROM email_log WHERE to_user_id = ? ORDER BY id').all(userId);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function nextSlot(c, artistId, fromDays = 2) {
  for (let d = fromDays; d < 40; d += 1) {
    const day = new Date(Date.now() + d * 86400000);
    const date = isoDay(day);
    const r = await c.get(`/api/artists/${artistId}/slots?date=${date}`);
    const slot = (r.data.slots || []).find((s) => s.available);
    if (slot) return slot.starts_at;
  }
  throw new Error('no free slot');
}

before(async () => {
  seed();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('join, duplicates, validation, artist queue, leave and remove', async () => {
  const { c: hana, id: hanaId } = await login('hana@inkwell.demo');
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const flash = db.prepare("SELECT id FROM flash_designs WHERE artist_id = ? AND status = 'available' LIMIT 1").get(maraId);

  let r = await hana.get(`/api/waitlist/artists/${maraId}`);
  assert.equal(r.data.entry, null);
  r = await hana.post('/api/waitlist', { artist_id: maraId, from_date: '2026-13-01' });
  assert.equal(r.status, 400);
  r = await hana.post('/api/waitlist', { artist_id: maraId, from_date: '2026-11-10', to_date: '2026-11-01' });
  assert.equal(r.status, 400);
  r = await hana.post('/api/waitlist', { artist_id: 999999 });
  assert.equal(r.status, 404);
  const artistMails = mails(maraId).length;
  r = await hana.post('/api/waitlist', { artist_id: maraId, flash_id: flash.id, from_date: '2026-10-01', to_date: '2026-12-31', note: 'Weekday evenings work best' });
  assert.equal(r.status, 201);
  const entry = r.data.entry;
  assert.equal(entry.status, 'waiting');
  assert.equal(entry.flash_id, flash.id);
  assert.equal(entry.artist_name, 'Mara Voss');
  r = await hana.post('/api/waitlist', { artist_id: maraId });
  assert.equal(r.status, 409, 'one active entry per artist');
  r = await mara.post('/api/waitlist', { artist_id: maraId });
  assert.equal(r.status, 403, 'artists do not join waitlists');
  await wait(60);
  assert.equal(mails(maraId).length, artistMails + 1);
  assert.match(mails(maraId).pop().subject, /Hana Sato joined your waitlist/);

  r = await hana.get(`/api/waitlist/artists/${maraId}`);
  assert.equal(r.data.entry.id, entry.id);
  r = await hana.get('/api/waitlist');
  assert.equal(r.data.entries.length, 1);
  r = await mara.get('/api/waitlist');
  assert.equal(r.data.count, 1);
  assert.equal(r.data.entries[0].client_name, 'Hana Sato');
  assert.equal(r.data.entries[0].note, 'Weekday evenings work best');
  r = await mara.get(`/api/waitlist/artists/${maraId}`);
  assert.equal(r.data.count, 1);

  const { c: noah } = await login('noah@inkwell.demo');
  r = await noah.del(`/api/waitlist/${entry.id}`);
  assert.equal(r.status, 404, 'others cannot remove it');
  r = await hana.del(`/api/waitlist/${entry.id}`);
  assert.equal(r.status, 200);
  r = await hana.get(`/api/waitlist/artists/${maraId}`);
  assert.equal(r.data.entry, null);
  r = await hana.post('/api/waitlist', { artist_id: maraId });
  assert.equal(r.status, 201, 'can rejoin after leaving');
  r = await mara.del(`/api/waitlist/${r.data.entry.id}`);
  assert.equal(r.status, 200, 'the artist can remove entries');
  assert.equal((await mara.get('/api/waitlist')).data.count, 0);
  r = await client().get('/api/waitlist');
  assert.equal(r.status, 401);
});

test('a cancelled future slot notifies waiting clients whose window covers it, once per cooldown, up to the cap', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan, id: jordanId } = await login('jordan@inkwell.demo');
  const waiting = [];
  for (const email of ['hana@inkwell.demo', 'noah@inkwell.demo', 'ines@inkwell.demo', 'sasha@inkwell.demo', 'kwame@inkwell.demo', 'elena@inkwell.demo', 'lucia@inkwell.demo']) waiting.push(await login(email));
  const slot = await nextSlot(jordan, maraId, 3);
  const slotDay = slot.slice(0, 10);
  const nextDay = isoDay(new Date(new Date(slot).getTime() + 86400000));

  // Six general entries plus one whose window misses the slot.
  for (const w of waiting.slice(0, 6)) assert.equal((await w.c.post('/api/waitlist', { artist_id: maraId })).status, 201);
  assert.equal((await waiting[6].c.post('/api/waitlist', { artist_id: maraId, from_date: nextDay })).status, 201);
  const before = Object.fromEntries(waiting.map((w) => [w.id, mails(w.id).length]));

  // Jordan books the slot, then cancels it.
  let r = await jordan.post('/api/appointments', { artist_id: maraId, starts_at: slot, note: 'x' });
  assert.equal(r.status, 201);
  r = await jordan.post(`/api/appointments/${r.data.appointment.id}/cancel`);
  assert.equal(r.status, 200);
  await wait(120);
  const told = waiting.filter((w) => mails(w.id).length > before[w.id]);
  assert.equal(told.length, 5, 'first five in the queue are told');
  assert.deepEqual(told.map((w) => w.id), waiting.slice(0, 5).map((w) => w.id), 'queue order');
  const mail = mails(told[0].id).pop();
  assert.match(mail.subject, /A slot with Mara Voss just opened up/);
  assert.match(mail.body_text, new RegExp(`/book/${maraId}\\?date=${slotDay}`));
  assert.equal(mails(waiting[6].id).length, before[waiting[6].id], 'window does not cover the day');
  r = await mara.get('/api/waitlist');
  assert.equal(r.data.entries.filter((e) => e.status === 'notified').length, 5);
  assert.equal(r.data.entries.find((e) => e.client_id === waiting[5].id).status, 'waiting');

  // Another cancellation within the cooldown skips the five already told and reaches the sixth.
  const slot2 = await nextSlot(jordan, maraId, 3);
  r = await jordan.post('/api/appointments', { artist_id: maraId, starts_at: slot2, note: 'y' });
  assert.equal(r.status, 201);
  await jordan.post(`/api/appointments/${r.data.appointment.id}/cancel`);
  await wait(120);
  assert.equal(mails(waiting[0].id).length, before[waiting[0].id] + 1, 'cooldown: not told twice');
  assert.equal(mails(waiting[5].id).length, before[waiting[5].id] + 1, 'sixth is told on the next freed slot');

  // Booking with the artist closes the entry; past cancellations notify nobody.
  const slot3 = await nextSlot(waiting[0].c, maraId, 3);
  r = await waiting[0].c.post('/api/appointments', { artist_id: maraId, starts_at: slot3 });
  assert.equal(r.status, 201);
  r = await waiting[0].c.get(`/api/waitlist/artists/${maraId}`);
  assert.equal(r.data.entry, null, 'booking closes the waitlist entry');
  assert.equal(db.prepare('SELECT status FROM waitlist WHERE client_id = ? AND artist_id = ?').get(waiting[0].id, maraId).status, 'booked');
  const past = db.prepare(`INSERT INTO appointments (artist_id, client_id, starts_at, ends_at, note, status, deposit_amount) VALUES (?, ?, '2020-01-01T10:00', '2020-01-01T12:00', '', 'confirmed', 0)`).run(maraId, jordanId);
  const countBefore = db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n;
  await mara.post(`/api/appointments/${past.lastInsertRowid}/cancel`);
  await wait(60);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n - countBefore, 1, 'only the cancellation email itself');
  for (const w of waiting) await w.c.del(`/api/waitlist/${(await w.c.get(`/api/waitlist/artists/${maraId}`)).data.entry?.id || 0}`).catch(() => {});
});

test('reopening the books and artist invites reach the waitlist', async () => {
  const { c: sofia, id: sofiaId } = await login('sofia@inkwell.demo');
  const { c: ben, id: benId } = await login('ben@inkwell.demo');
  const { c: lucia, id: luciaId } = await login('lucia@inkwell.demo');
  await sofia.put('/api/auth/me', { accepting_clients: false });
  assert.equal((await ben.post('/api/waitlist', { artist_id: sofiaId, note: 'Ready whenever' })).status, 201);
  assert.equal((await lucia.post('/api/waitlist', { artist_id: sofiaId })).status, 201);
  const benBefore = mails(benId).length;
  const luciaBefore = mails(luciaId).length;

  let r = await sofia.put('/api/auth/me', { accepting_clients: false });
  assert.equal(r.status, 200);
  await wait(60);
  assert.equal(mails(benId).length, benBefore, 'no change, no email');
  r = await sofia.put('/api/auth/me', { accepting_clients: true });
  assert.equal(r.status, 200);
  await wait(100);
  assert.equal(mails(benId).length, benBefore + 1);
  assert.equal(mails(luciaId).length, luciaBefore + 1);
  assert.match(mails(benId).pop().subject, /Sofia .* is taking bookings again/);

  r = await sofia.get('/api/waitlist');
  const benEntry = r.data.entries.find((e) => e.client_id === benId);
  assert.equal(benEntry.status, 'notified');
  r = await sofia.post(`/api/waitlist/${benEntry.id}/invite`, { message: 'Thursday afternoons are open next month.' });
  assert.equal(r.status, 200);
  assert.equal(r.data.entry.notify_count, 2);
  await wait(60);
  const invite = mails(benId).pop();
  assert.match(invite.subject, /has time for you/);
  assert.match(invite.body_text, /Thursday afternoons are open next month/);
  assert.match(invite.body_text, new RegExp(`/book/${sofiaId}`));
  r = await lucia.post(`/api/waitlist/${benEntry.id}/invite`, {});
  assert.equal(r.status, 403);
  const { c: mara } = await login('mara@inkwell.demo');
  r = await mara.post(`/api/waitlist/${benEntry.id}/invite`, {});
  assert.equal(r.status, 404, 'only the artist on the entry');
  await ben.del(`/api/waitlist/${benEntry.id}`);
  r = await sofia.post(`/api/waitlist/${benEntry.id}/invite`, {});
  assert.equal(r.status, 400, 'inactive entry');
});
