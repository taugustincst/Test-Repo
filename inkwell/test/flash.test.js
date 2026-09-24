'use strict';

/* Flash designs: publishing, browsing, claiming through bookings, release on cancel, sold on completion. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-flash-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp, pageMeta } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const sharp = require('sharp');

let server;
let base;

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
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
const png = () => sharp({ create: { width: 80, height: 100, channels: 3, background: '#1b1b1f' } }).png().toBuffer();

async function nextSlot(c, artistId) {
  for (let d = 2; d < 40; d += 1) {
    const day = new Date(Date.now() + d * 86400000);
    const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
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

test('browse and detail: seeded board, filters, sorting, hidden designs, page meta', async () => {
  const anon = client();
  let r = await anon.get('/api/flash');
  assert.equal(r.status, 200);
  assert.ok(r.data.flash.length >= 7, 'seeded designs');
  assert.ok(r.data.flash.every((f) => f.status === 'available'), 'only available designs on the public board');
  assert.ok(r.data.flash.some((f) => f.title === 'Moth & Moon'));
  assert.ok(!r.data.flash.some((f) => f.title === 'Ship in Storm'), 'sold designs are off the board');
  r = await anon.get('/api/flash?style=Traditional');
  assert.ok(r.data.flash.length >= 2 && r.data.flash.every((f) => f.style === 'Traditional'));
  r = await anon.get('/api/flash?max_price=200&sort=price_asc');
  assert.ok(r.data.flash.every((f) => f.price <= 200));
  const prices = r.data.flash.map((f) => f.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  r = await anon.get('/api/flash?sort=price_desc');
  assert.equal(r.data.flash[0].price, Math.max(...r.data.flash.map((f) => f.price)));
  const moth = r.data.flash.find((f) => f.title === 'Moth & Moon');
  r = await anon.get(`/api/flash/${moth.id}`);
  assert.equal(r.data.flash.artist_name, 'Mara Voss');
  assert.equal(r.data.flash.repeatable, false);
  assert.equal(r.data.flash.deposit_amount, 100);
  assert.equal(r.data.flash.claims, undefined, 'claims are for the owner');
  assert.match(pageMeta(`/flash/${moth.id}`).title, /Moth & Moon · flash by Mara Voss/);
  assert.match(pageMeta('/flash').title, /Flash designs/);
  r = await anon.get('/api/flash/999999');
  assert.equal(r.status, 404);
});

test('artists publish, edit, hide and delete flash; clients cannot', async () => {
  const { c: sofia, id: sofiaId } = await login('sofia@inkwell.demo');
  const { c: hana } = await login('hana@inkwell.demo');
  const anon = client();
  const fd = new FormData();
  fd.append('image', new Blob([await png()], { type: 'image/png' }), 'flash.png');
  fd.append('title', 'Colour Sparrow');
  fd.append('description', 'Small colour sparrow, one sitting.');
  fd.append('style', 'Neo-Traditional');
  fd.append('size_label', 'Small (2-4 in)');
  fd.append('price', '240');
  fd.append('repeatable', 'true');
  let r = await sofia.post('/api/flash', fd);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const design = r.data.flash;
  assert.equal(design.price, 240);
  assert.equal(design.repeatable, true);
  assert.match(design.image_url, /\.webp$/);
  assert.ok(design.thumb_url);
  assert.equal(design.is_owner, true);

  const bad = new FormData();
  bad.append('image', new Blob([await png()], { type: 'image/png' }), 'x.png');
  bad.append('title', 'No price');
  bad.append('price', 'lots');
  r = await sofia.post('/api/flash', bad);
  assert.equal(r.status, 400);
  const noImage = new FormData(); noImage.append('title', 'x'); noImage.append('price', '10');
  r = await sofia.post('/api/flash', noImage);
  assert.equal(r.status, 400);
  const asClient = new FormData(); asClient.append('image', new Blob([await png()], { type: 'image/png' }), 'x.png'); asClient.append('title', 'x'); asClient.append('price', '10');
  r = await hana.post('/api/flash', asClient);
  assert.equal(r.status, 403);

  r = await sofia.put(`/api/flash/${design.id}`, { price: 260, status: 'hidden' });
  assert.equal(r.data.flash.price, 260);
  assert.equal(r.data.flash.status, 'hidden');
  r = await anon.get(`/api/flash/${design.id}`);
  assert.equal(r.status, 404, 'hidden designs are private');
  r = await sofia.get(`/api/flash/${design.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.flash.claims, []);
  r = await sofia.get('/api/flash?mine=1');
  assert.ok(r.data.flash.some((f) => f.id === design.id), 'owners see hidden designs in their list');
  r = await anon.get(`/api/flash?artist_id=${sofiaId}`);
  assert.ok(!r.data.flash.some((f) => f.id === design.id));
  r = await sofia.put(`/api/flash/${design.id}`, { status: 'sold' });
  assert.equal(r.status, 400, 'status is driven by bookings');
  // Editing a sold one-off (the edit form always sends a status) must not put it back on sale.
  const ship = db.prepare(`SELECT id, artist_id FROM flash_designs WHERE title = 'Ship in Storm'`).get();
  const { c: diego } = await login('diego@inkwell.demo');
  assert.equal(ship.artist_id, (await diego.get('/api/auth/me')).data.user.id);
  r = await diego.put(`/api/flash/${ship.id}`, { title: 'Ship in Storm (sold)', status: 'available' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.flash.status, 'sold', 'stays sold');
  assert.equal(r.data.flash.title, 'Ship in Storm (sold)');
  const { c: mara } = await login('mara@inkwell.demo');
  r = await mara.put(`/api/flash/${design.id}`, { price: 1 });
  assert.equal(r.status, 404, 'only the owner edits');
  r = await sofia.del(`/api/flash/${design.id}`);
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(tmp, 'uploads', path.basename(design.image_url))), false, 'image file removed');
  r = await sofia.get(`/api/flash/${design.id}`);
  assert.equal(r.status, 404);
});

test('claiming: booking with a one-off design fixes the price, takes it off the board, releases on cancel, sells on completion', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan } = await login('jordan@inkwell.demo');
  const { c: hana } = await login('hana@inkwell.demo');
  const board = (await jordan.get(`/api/flash?artist_id=${maraId}`)).data.flash;
  const moth = board.find((f) => f.title === 'Moth & Moon');
  const band = board.find((f) => f.title === 'Thorn Band');
  assert.ok(moth && band);

  const slot1 = await nextSlot(jordan, maraId);
  let r = await jordan.post('/api/appointments', { artist_id: maraId, starts_at: slot1, note: 'The moth, on my forearm', flash_id: moth.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const appt = r.data.appointment;
  assert.equal(appt.flash_id, moth.id);
  assert.equal(appt.price, 220, 'session price fixed to the flash price');
  assert.equal(appt.flash_title, 'Moth & Moon');
  assert.equal(appt.payments.find((p) => p.kind === 'deposit').amount, 100);
  r = await jordan.get(`/api/flash/${moth.id}`);
  assert.equal(r.data.flash.status, 'claimed');
  r = await jordan.get(`/api/flash?artist_id=${maraId}`);
  assert.ok(!r.data.flash.some((f) => f.id === moth.id), 'claimed design leaves the board');
  // The owner can still edit a claimed design; the status the form sends is ignored.
  const { c: maraEdit } = await login('mara@inkwell.demo');
  r = await maraEdit.put(`/api/flash/${moth.id}`, { description: 'Claimed, but the notes can change.', status: 'available' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.flash.status, 'claimed');
  assert.equal(r.data.flash.description, 'Claimed, but the notes can change.');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const mail = db.prepare('SELECT body_text FROM email_log WHERE to_user_id = ? ORDER BY id DESC LIMIT 2').all(maraId).map((m) => m.body_text).join('\n');
  assert.match(mail, /flash design "Moth & Moon" \(\$220\)/);

  // Someone else cannot take the same one-off; the owner sees the claim.
  const slot2 = await nextSlot(hana, maraId);
  r = await hana.post('/api/appointments', { artist_id: maraId, starts_at: slot2, note: 'me too', flash_id: moth.id });
  assert.equal(r.status, 409);
  r = await mara.get(`/api/flash/${moth.id}`);
  assert.equal(r.data.flash.claims.length, 1);
  assert.equal(r.data.flash.claims[0].client_name, 'Jordan Lee');
  r = await mara.del(`/api/flash/${moth.id}`);
  assert.equal(r.status, 400, 'cannot delete a claimed design');
  r = await mara.put(`/api/flash/${moth.id}`, { status: 'hidden' });
  assert.equal(r.status, 200);
  assert.equal(r.data.flash.status, 'claimed', 'a claimed design cannot be hidden; the state is driven by the booking');

  // Cancelling releases it.
  r = await jordan.post(`/api/appointments/${appt.id}/cancel`);
  assert.equal(r.status, 200);
  r = await jordan.get(`/api/flash/${moth.id}`);
  assert.equal(r.data.flash.status, 'available');

  // Repeatable designs stay available; completion of a one-off marks it sold and the total defaults to the flash price.
  const slot3 = await nextSlot(hana, maraId);
  r = await hana.post('/api/appointments', { artist_id: maraId, starts_at: slot3, flash_id: band.id });
  assert.equal(r.status, 201);
  r = await hana.get(`/api/flash/${band.id}`);
  assert.equal(r.data.flash.status, 'available', 'repeatable stays on the board');
  const slot4 = await nextSlot(jordan, maraId);
  r = await jordan.post('/api/appointments', { artist_id: maraId, starts_at: slot4, flash_id: moth.id });
  assert.equal(r.status, 201);
  const second = r.data.appointment.id;
  await mara.post(`/api/appointments/${second}/confirm`);
  r = await mara.post(`/api/appointments/${second}/complete`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.appointment.price, 220);
  assert.equal(r.data.appointment.payments.find((p) => p.kind === 'balance').amount, 220, 'the deposit was never paid, so the whole flash price is due as the balance');
  r = await jordan.get(`/api/flash/${moth.id}`);
  assert.equal(r.data.flash.status, 'sold');
  assert.equal(r.data.flash.times_done, 1);

  // Wrong artist, missing design.
  const { id: diegoId } = await login('diego@inkwell.demo');
  const slot5 = await nextSlot(jordan, diegoId);
  r = await jordan.post('/api/appointments', { artist_id: diegoId, starts_at: slot5, flash_id: band.id });
  assert.equal(r.status, 404);
});
