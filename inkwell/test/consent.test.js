'use strict';

/* Consent forms: definition and settings, signing with validation, access rules, booking status, completion gate, reminders and export. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-consent-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const consent = require('../server/consent');
const reminders = require('../server/reminders');
const sharp = require('sharp');

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
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
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

function insertAppt(artistId, clientId, hoursAhead, status = 'confirmed') {
  const start = new Date(Date.now() + hoursAhead * 3600000); start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 2 * 3600000);
  const info = db.prepare(`INSERT INTO appointments (artist_id, client_id, starts_at, ends_at, note, status, deposit_amount) VALUES (?, ?, ?, ?, '', ?, 0)`).run(artistId, clientId, stamp(start), stamp(end), status);
  return Number(info.lastInsertRowid);
}

async function signatureDataUrl(blank = false) {
  const canvas = sharp({ create: { width: 400, height: 140, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const buf = blank ? await canvas.png().toBuffer() : await canvas.composite([{ input: await sharp({ create: { width: 180, height: 14, channels: 4, background: { r: 26, g: 26, b: 28, alpha: 1 } } }).png().toBuffer(), top: 60, left: 80 }]).png().toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function goodAnswers(overrides = {}) {
  const answers = {};
  consent.HEALTH_QUESTIONS.forEach((q) => { answers[q.key] = { yes: false, detail: '' }; });
  return { ...answers, ...overrides };
}
function allAcks() { const a = {}; consent.ACKNOWLEDGEMENTS.forEach((k) => { a[k.key] = true; }); return a; }

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

test('artist consent settings and the form definition clients see', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan } = await login('jordan@inkwell.demo');
  let r = await mara.get('/api/consent/settings');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.settings, { terms: consent.DEFAULT_TERMS, require_consent: false, photo_ask: true, min_age: 18 });
  assert.equal(r.data.preview.health.length, consent.HEALTH_QUESTIONS.length);
  assert.match(r.data.preview.acknowledgements[0].label, /at least 18/);
  r = await mara.put('/api/consent/settings', { terms: 'Bring ID. No plus-ones in the room.', require_consent: true, photo_ask: false, min_age: 21 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.settings, { terms: 'Bring ID. No plus-ones in the room.', require_consent: true, photo_ask: false, min_age: 21 });
  assert.match(r.data.preview.acknowledgements[0].label, /at least 21/);
  r = await mara.put('/api/consent/settings', { min_age: 12 });
  assert.equal(r.status, 400);
  r = await jordan.get('/api/consent/settings');
  assert.equal(r.status, 403);
  await mara.put('/api/consent/settings', { terms: consent.DEFAULT_TERMS, require_consent: false, photo_ask: true, min_age: 18 });
  void maraId;
});

test('signing: validation, one per session, access rules, signature image, booking status and artist notification', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan, id: jordanId } = await login('jordan@inkwell.demo');
  const { c: hana } = await login('hana@inkwell.demo');
  const apptId = insertAppt(maraId, jordanId, 72);

  let r = await jordan.get(`/api/appointments/${apptId}/consent`);
  assert.equal(r.status, 200);
  assert.equal(r.data.form, null);
  assert.equal(r.data.can_sign, true);
  assert.equal(r.data.definition.min_age, 18);
  r = await mara.get(`/api/appointments/${apptId}/consent`);
  assert.equal(r.data.can_sign, false, 'artists do not sign');
  r = await hana.get(`/api/appointments/${apptId}/consent`);
  assert.equal(r.status, 403);

  const sig = await signatureDataUrl();
  const good = { full_name: 'Jordan A. Lee', date_of_birth: '1996-04-12', answers: goodAnswers({ allergies: { yes: true, detail: 'Nickel' } }), acknowledgements: allAcks(), photo_consent: true, signature: sig };
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, full_name: 'J' });
  assert.match(r.data.error, /full legal name/);
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, date_of_birth: '2012-01-01' });
  assert.match(r.data.error, /at least 18/);
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, answers: goodAnswers({ allergies: { yes: true, detail: '' } }) });
  assert.match(r.data.error, /Add a few words about: Do you have any allergies/);
  const partial = goodAnswers(); delete partial.pregnant;
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, answers: partial });
  assert.match(r.data.error, /Answer every health question/);
  const acks = allAcks(); acks.risks = false;
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, acknowledgements: acks });
  assert.match(r.data.error, /Tick every acknowledgement/);
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, signature: await signatureDataUrl(true) });
  assert.match(r.data.error, /Sign in the box/);
  r = await jordan.post(`/api/appointments/${apptId}/consent`, { ...good, signature: 'data:image/jpeg;base64,AAAA' });
  assert.match(r.data.error, /Sign in the box/);
  r = await mara.post(`/api/appointments/${apptId}/consent`, good);
  assert.equal(r.status, 403, 'artist cannot sign for the client');

  const mailsBefore = db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(maraId).n;
  r = await jordan.post(`/api/appointments/${apptId}/consent`, good);
  assert.equal(r.status, 201);
  assert.equal(r.data.form.full_name, 'Jordan A. Lee');
  assert.equal(r.data.form.photo_consent, true);
  assert.deepEqual(r.data.form.flags.map((f) => f.key), ['allergies']);
  assert.equal(r.data.form.flags[0].detail, 'Nickel');
  assert.equal(r.data.form.form_version, consent.FORM_VERSION);
  assert.ok(r.data.form.signed_at);
  r = await jordan.post(`/api/appointments/${apptId}/consent`, good);
  assert.equal(r.status, 409, 'one form per session');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const mail = db.prepare('SELECT subject, body_text FROM email_log WHERE to_user_id = ? ORDER BY id DESC LIMIT 1').get(maraId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(maraId).n, mailsBefore + 1);
  assert.match(mail.subject, /Jordan Lee signed the consent form/);
  assert.match(mail.body_text, /flagged 1 health item/);

  // Both parties read it; the signature image is private and non-cacheable.
  r = await mara.get(`/api/appointments/${apptId}/consent`);
  assert.equal(r.data.form.full_name, 'Jordan A. Lee');
  assert.equal(r.data.form.answers.allergies.detail, 'Nickel');
  assert.equal(r.data.form.terms_text, consent.DEFAULT_TERMS);
  assert.equal(r.data.can_sign, false);
  r = await mara.get(`/api/appointments/${apptId}/consent/signature.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.equal((await sharp(r.data).metadata()).format, 'png');
  r = await hana.get(`/api/appointments/${apptId}/consent/signature.png`);
  assert.equal(r.status, 403);
  r = await client().get(`/api/appointments/${apptId}/consent/signature.png`);
  assert.equal(r.status, 401);

  // Booking cards carry the status.
  r = await mara.get('/api/appointments');
  const mine = r.data.appointments.find((a) => a.id === apptId);
  assert.ok(mine.consent.signed_at);
  assert.equal(mine.consent.required, false);
  const unsigned = insertAppt(maraId, jordanId, 96);
  r = await jordan.get('/api/appointments');
  assert.deepEqual(r.data.appointments.find((a) => a.id === unsigned).consent, { signed_at: null, required: false });

  // Closed sessions cannot be signed.
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(unsigned);
  r = await jordan.post(`/api/appointments/${unsigned}/consent`, good);
  assert.equal(r.status, 400);
  r = await jordan.get(`/api/appointments/${unsigned}/consent`);
  assert.equal(r.data.can_sign, false);
});

test('completion gate, day-before reminder nudge and data export', async () => {
  const artistId = idOf('diego@inkwell.demo');
  const { c: diego } = await login('diego@inkwell.demo');
  const { c: kwame, id: kwameId } = await login('kwame@inkwell.demo');
  await diego.put('/api/consent/settings', { require_consent: true });
  const soon = insertAppt(artistId, kwameId, 20);
  const past = insertAppt(artistId, kwameId, -3);

  // Reminder for an unsigned session points the client at the form and tells the artist.
  const before = db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n;
  reminders.sendSessionReminders();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const mails = db.prepare('SELECT to_user_id, body_text FROM email_log WHERE id > (SELECT MAX(id) - ? FROM email_log)').all(db.prepare('SELECT COUNT(*) AS n FROM email_log').get().n - before);
  assert.match(mails.find((m) => m.to_user_id === kwameId).body_text, new RegExp(`/appointments/${soon}/consent`));
  assert.match(mails.find((m) => m.to_user_id === artistId).body_text, /has not signed the consent form yet/);

  // Completing requires the form when the artist asks for it, unless they override.
  let r = await diego.post(`/api/appointments/${past}/complete`, { price: 300 });
  assert.equal(r.status, 400);
  assert.equal(r.data.consent_missing, true);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id = ?').get(past).status, 'confirmed');
  r = await kwame.post(`/api/appointments/${past}/consent`, { full_name: 'Kwame Mensah', date_of_birth: '1990-09-09', answers: goodAnswers(), acknowledgements: allAcks(), signature: await signatureDataUrl() });
  assert.equal(r.status, 201);
  assert.equal(r.data.form.photo_consent, false, 'photo consent defaults to no when not ticked');
  r = await diego.post(`/api/appointments/${past}/complete`, { price: 300 });
  assert.equal(r.status, 200);
  const override = insertAppt(artistId, kwameId, -30);
  r = await diego.post(`/api/appointments/${override}/complete`, { price: 200, skip_consent: true });
  assert.equal(r.status, 200, 'artist can complete anyway');
  await diego.put('/api/consent/settings', { require_consent: false });

  // The client's export includes the signed forms without the signature image or address.
  r = await kwame.get('/api/auth/me/export');
  assert.equal(r.status, 200);
  const exported = r.data;
  assert.equal(exported.consent_forms.length, 1);
  assert.equal(exported.consent_forms[0].full_name, 'Kwame Mensah');
  assert.equal(exported.consent_forms[0].signature, undefined);
  assert.equal(exported.consent_forms[0].ip, undefined);
  assert.equal(consent.ageOn('2008-02-29', new Date(2026, 1, 28)), 17);
  assert.equal(consent.ageOn('2008-02-29', new Date(2026, 2, 1)), 18);
});
