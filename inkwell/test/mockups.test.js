'use strict';

/* Placement previews: rendering, creating from a photo or a request reference, sending, the client's answer, bookings, access. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-mockups-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const mockups = require('../server/mockups');
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

// A "skin" photo: flat warm tone, so any purple pixel is the stencil.
const skin = (w = 600, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: '#d9a98a' } }).png().toBuffer();
// A drawing that traces to a clean ring.
const drawing = () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/><circle cx="200" cy="200" r="150" fill="none" stroke="#111" stroke-width="12"/></svg>')).png().toBuffer();
const file = (u) => path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(u));

/** Bounding box of purple-ish pixels in a rendered composite. */
async function inkBox(url) {
  const { data, info } = await sharp(file(url)).raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let n = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (b > r + 20 && b > g + 40) { n += 1; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    }
  }
  return { n, minX, minY, maxX, maxY, width: info.width, height: info.height };
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

test('render: the stencil lands where the transform says, in the chosen ink, clipped at the edge, mirrored and turned', async () => {
  const photo = path.join(tmp, 'skin.png'); fs.writeFileSync(photo, await skin());
  const stencilPng = path.join(tmp, 'ring.png');
  // A stencil PNG: black ring on transparent, with a dot in the top-left so mirroring is visible.
  const ring = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><circle cx="200" cy="200" r="150" fill="none" stroke="#000" stroke-width="12"/><circle cx="60" cy="60" r="30" fill="#000"/></svg>')).png().toBuffer();
  fs.writeFileSync(stencilPng, ring);
  const t = mockups.normaliseTransform({ x: 0.5, y: 0.25, width: 0.5, rotation: 0, opacity: 1, color: 'purple' });
  let r = await mockups.render(photo, stencilPng, t);
  assert.equal(r.width, 600); assert.equal(r.height, 800);
  const out = path.join(process.env.INKWELL_UPLOAD_DIR, 'r1.webp'); fs.mkdirSync(process.env.INKWELL_UPLOAD_DIR, { recursive: true }); fs.writeFileSync(out, r.buffer);
  let box = await inkBox('/uploads/r1.webp');
  assert.ok(box.n > 2000, `ink present (${box.n})`);
  // 50% of 600 = 300 px wide, centred at (300, 200), so the 400 px art is scaled by 0.75 and offset
  // by (150, 50): the ring spans x 183..417, y 83..317 and the dot reaches x 172, y 72.
  assert.ok(Math.abs(box.minX - 172) < 12 && Math.abs(box.maxX - 417) < 12, `x span ${box.minX}..${box.maxX}`);
  assert.ok(Math.abs(box.minY - 72) < 12 && Math.abs(box.maxY - 317) < 12, `y span ${box.minY}..${box.maxY}`);
  // The dot sits top-left; mirrored it moves to the top-right.
  const dotSide = async (url) => { const { data, info } = await sharp(file(url)).raw().toBuffer({ resolveWithObject: true }); const at = (x, y) => { const i = (y * info.width + x) * info.channels; return data[i + 2] > data[i] + 20; }; return { left: at(195, 95), right: at(405, 95) }; };
  let side = await dotSide('/uploads/r1.webp');
  assert.ok(side.left && !side.right, 'dot top-left');
  r = await mockups.render(photo, stencilPng, { ...t, mirror: true });
  fs.writeFileSync(path.join(process.env.INKWELL_UPLOAD_DIR, 'r2.webp'), r.buffer);
  side = await dotSide('/uploads/r2.webp');
  assert.ok(!side.left && side.right, 'mirrored: dot top-right');
  // Turned 90 degrees the dot goes to the top-right too (clockwise), and the box stays put.
  r = await mockups.render(photo, stencilPng, { ...t, rotation: 90 });
  fs.writeFileSync(path.join(process.env.INKWELL_UPLOAD_DIR, 'r3.webp'), r.buffer);
  side = await dotSide('/uploads/r3.webp');
  assert.ok(!side.left && side.right, 'rotated: dot moved');
  // Half off the left edge: still renders, ink only on the left third.
  r = await mockups.render(photo, stencilPng, { ...t, x: 0 });
  fs.writeFileSync(path.join(process.env.INKWELL_UPLOAD_DIR, 'r4.webp'), r.buffer);
  box = await inkBox('/uploads/r4.webp');
  assert.ok(box.n > 500 && box.maxX <= 160, `clipped at the edge (${box.maxX})`);
  // Black ink is not purple.
  r = await mockups.render(photo, stencilPng, { ...t, color: 'black' });
  fs.writeFileSync(path.join(process.env.INKWELL_UPLOAD_DIR, 'r5.webp'), r.buffer);
  box = await inkBox('/uploads/r5.webp');
  assert.equal(box.n, 0);
  // Transform validation clamps and defaults.
  assert.deepEqual(mockups.normaliseTransform('{"width": 9, "color": "neon", "mirror": "true"}'), { ...mockups.DEFAULT_TRANSFORM, width: 2, mirror: true });
  assert.deepEqual(mockups.normaliseTransform('garbage'), mockups.DEFAULT_TRANSFORM);
});

test('artist creates a placement from a photo, ties it to a booking, sends it; the client approves; both sides see it', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: jordan, id: jordanId } = await login('jordan@inkwell.demo');
  const { c: hana } = await login('hana@inkwell.demo');
  // A stencil to place.
  let fd = new FormData();
  fd.append('image', new Blob([await drawing()], { type: 'image/png' }), 'ring.png');
  fd.append('title', 'Ring');
  let r = await mara.post('/api/stencils', fd);
  assert.equal(r.status, 201);
  const stencil = r.data.stencil;
  assert.equal(stencil.status, 'ready', stencil.error);
  // Jordan's upcoming booking with Mara.
  const appt = db.prepare(`SELECT id FROM appointments WHERE artist_id = ? AND client_id = ? AND status IN ('pending', 'confirmed') ORDER BY starts_at LIMIT 1`).get(maraId, jordanId);
  assert.ok(appt, 'seeded booking');

  fd = new FormData();
  fd.append('photo', new Blob([await skin()], { type: 'image/png' }), 'arm.png');
  fd.append('stencil_id', String(stencil.id));
  fd.append('transform', JSON.stringify({ x: 0.5, y: 0.4, width: 0.6, rotation: 15, mirror: false, opacity: 0.9, color: 'purple' }));
  fd.append('title', 'Inner forearm');
  fd.append('appointment_id', String(appt.id));
  r = await mara.post('/api/mockups', fd);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const m = r.data.mockup;
  assert.equal(m.status, 'draft');
  assert.equal(m.client_id, jordanId, 'client taken from the booking');
  assert.equal(m.client_name, 'Jordan Lee');
  assert.equal(m.appointment_id, appt.id);
  assert.equal(m.transform.rotation, 15);
  assert.equal(m.stencil_title, 'Ring');
  assert.ok(fs.existsSync(file(m.image_url)) && fs.existsSync(file(m.thumb_url)) && fs.existsSync(file(m.photo_url)));
  assert.equal(m.width, 600);
  let box = await inkBox(m.image_url);
  assert.ok(box.n > 2000);
  // Drafts are private to the artist.
  assert.equal((await jordan.get(`/api/mockups/${m.id}`)).status, 404);
  assert.equal((await jordan.get('/api/mockups')).data.mockups.length, 0);
  assert.equal((await hana.get(`/api/mockups/${m.id}`)).status, 404);

  // Adjust: re-render, new file, still a draft.
  const oldImage = m.image_url;
  r = await mara.put(`/api/mockups/${m.id}`, { transform: { ...m.transform, width: 0.3, x: 0.5, y: 0.5 }, title: 'Inner forearm, smaller' });
  assert.equal(r.status, 200);
  assert.equal(r.data.mockup.title, 'Inner forearm, smaller');
  assert.equal(r.data.mockup.transform.width, 0.3);
  assert.notEqual(r.data.mockup.image_url, oldImage);
  const smaller = await inkBox(r.data.mockup.image_url);
  assert.ok(smaller.n < box.n, 'less ink when smaller');
  // The artist sees their own draft on the booking card; the client does not.
  r = await mara.get('/api/appointments');
  assert.equal(r.data.appointments.find((a) => a.id === appt.id).mockup.status, 'draft');
  assert.equal((await jordan.get('/api/appointments')).data.appointments.find((a) => a.id === appt.id).mockup, null);
  // Swapping the stencil re-renders with the new one.
  fd = new FormData();
  fd.append('image', new Blob([await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/><rect x="60" y="60" width="280" height="280" fill="none" stroke="#111" stroke-width="14"/></svg>')).png().toBuffer()], { type: 'image/png' }), 'square.png');
  fd.append('title', 'Square');
  const square = (await mara.post('/api/stencils', fd)).data.stencil;
  assert.equal(square.status, 'ready');
  r = await mara.put(`/api/mockups/${m.id}`, { stencil_id: square.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mockup.stencil_id, square.id);
  assert.equal(r.data.mockup.stencil_title, 'Square');
  const otherArtistStencil = db.prepare('SELECT id FROM stencils WHERE artist_id <> ? LIMIT 1').get(maraId);
  if (otherArtistStencil) assert.equal((await mara.put(`/api/mockups/${m.id}`, { stencil_id: otherArtistStencil.id })).status, 400);

  // Send: message with the preview, booking shows it, client can respond.
  r = await mara.post(`/api/mockups/${m.id}/send`, { message: 'About 9 cm across. What do you think?' });
  assert.equal(r.status, 200);
  assert.equal(r.data.mockup.status, 'sent');
  assert.ok(r.data.mockup.sent_at);
  r = await jordan.get(`/api/messages/${maraId}`);
  const last = r.data.messages[r.data.messages.length - 1];
  assert.equal(last.body, 'About 9 cm across. What do you think?');
  assert.equal(last.attachments[0].type, 'mockup');
  assert.equal(last.attachments[0].id, m.id);
  assert.equal(last.attachments[0].status, 'sent');
  r = await jordan.get(`/api/mockups/${m.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.mockup.can_respond, true);
  assert.equal(r.data.mockup.is_mine, false);
  r = await jordan.get('/api/appointments');
  assert.equal(r.data.appointments.find((a) => a.id === appt.id).mockup.status, 'sent');
  const note = db.prepare('SELECT title, url FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(jordanId);
  assert.match(note.title, /sits on you/);
  assert.equal(note.url, `/mockups/${m.id}`);

  // Only the client can answer; changes need a note; then approve.
  assert.equal((await hana.post(`/api/mockups/${m.id}/respond`, { status: 'approved' })).status, 404);
  assert.equal((await mara.post(`/api/mockups/${m.id}/respond`, { status: 'approved' })).status, 403);
  r = await jordan.post(`/api/mockups/${m.id}/respond`, { status: 'changes' });
  assert.equal(r.status, 400);
  r = await jordan.post(`/api/mockups/${m.id}/respond`, { status: 'changes', note: 'A touch smaller and turned to follow the muscle.' });
  assert.equal(r.data.mockup.status, 'changes');
  assert.equal(r.data.mockup.client_note, 'A touch smaller and turned to follow the muscle.');
  assert.equal(r.data.mockup.can_respond, false, 'answered');
  r = await mara.get(`/api/messages/${jordanId}`);
  assert.match(r.data.messages[r.data.messages.length - 1].body, /Could you adjust the placement/);
  const artistNote = db.prepare('SELECT title FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(maraId);
  assert.match(artistNote.title, /Changes requested/);
  // Artist adjusts (back to draft), sends again, client approves.
  r = await mara.put(`/api/mockups/${m.id}`, { transform: { ...m.transform, width: 0.25, rotation: 30 } });
  assert.equal(r.data.mockup.status, 'draft');
  r = await mara.post(`/api/mockups/${m.id}/send`, {});
  assert.equal(r.data.mockup.status, 'sent');
  assert.equal(r.data.mockup.client_note, null, 'old note cleared');
  r = await jordan.post(`/api/mockups/${m.id}/respond`, { status: 'approved' });
  assert.equal(r.data.mockup.status, 'approved');
  r = await mara.get('/api/appointments');
  assert.equal(r.data.appointments.find((a) => a.id === appt.id).mockup.status, 'approved');
  r = await jordan.get('/api/mockups');
  assert.equal(r.data.mockups.length, 1);
  r = await mara.get('/api/mockups');
  assert.equal(r.data.mockups.length, 1);

  // Delete cleans up the render and the uploaded photo.
  const photoFile = file(m.photo_url);
  r = await mara.del(`/api/mockups/${m.id}`);
  assert.equal(r.status, 200);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.ok(!fs.existsSync(photoFile), 'photo removed');
  assert.equal((await jordan.get(`/api/mockups/${m.id}`)).status, 404);
});

test('a placement can start from the client\'s request reference photo; links are validated', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: hana, id: hanaId } = await login('hana@inkwell.demo');
  const { c: noah } = await login('noah@inkwell.demo');
  let fd = new FormData();
  fd.append('image', new Blob([await drawing()], { type: 'image/png' }), 'ring.png');
  const stencil = (await mara.post('/api/stencils', fd)).data.stencil;
  // Hana posts a request with a reference photo.
  fd = new FormData();
  fd.append('title', 'Small ring on the wrist'); fd.append('description', 'A thin ring, inside of the wrist, black only.'); fd.append('style', 'Fine line'); fd.append('placement', 'Wrist'); fd.append('size', 'Small (2-4 in)');
  fd.append('reference', new Blob([await skin(500, 500)], { type: 'image/png' }), 'wrist.png');
  let r = await hana.post('/api/requests', fd);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const request = r.data.request;
  assert.ok(request.reference_image_url);
  fd = new FormData();
  fd.append('stencil_id', String(stencil.id));
  fd.append('request_id', String(request.id));
  fd.append('transform', JSON.stringify({ width: 0.3 }));
  r = await mara.post('/api/mockups', fd);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.mockup.client_id, hanaId, 'client taken from the request');
  assert.equal(r.data.mockup.photo_url, request.reference_image_url);
  assert.equal(r.data.mockup.width, 500);
  const m = r.data.mockup;
  // Bad links.
  fd = new FormData(); fd.append('stencil_id', String(stencil.id)); fd.append('mockup_id', String(m.id)); fd.append('client_id', String(maraId));
  assert.equal((await mara.post('/api/mockups', fd)).status, 400, 'an artist is not a client');
  const otherAppt = db.prepare(`SELECT id FROM appointments WHERE artist_id <> ? LIMIT 1`).get(maraId);
  fd = new FormData(); fd.append('stencil_id', String(stencil.id)); fd.append('mockup_id', String(m.id)); fd.append('appointment_id', String(otherAppt.id));
  assert.equal((await mara.post('/api/mockups', fd)).status, 400, 'someone else\'s booking');
  fd = new FormData(); fd.append('stencil_id', String(stencil.id));
  assert.equal((await mara.post('/api/mockups', fd)).status, 400, 'no photo');
  fd = new FormData(); fd.append('stencil_id', '999999'); fd.append('mockup_id', String(m.id));
  assert.equal((await mara.post('/api/mockups', fd)).status, 400, 'unknown stencil');
  // Reusing my own placement's photo, and clients cannot create.
  fd = new FormData(); fd.append('stencil_id', String(stencil.id)); fd.append('mockup_id', String(m.id)); fd.append('transform', JSON.stringify({ width: 0.2, x: 0.3, y: 0.7 }));
  r = await mara.post('/api/mockups', fd);
  assert.equal(r.status, 201);
  assert.equal(r.data.mockup.photo_url, m.photo_url);
  assert.equal((await noah.post('/api/mockups', fd)).status, 403);
  // Deleting a placement never removes a request's reference photo.
  r = await mara.del(`/api/mockups/${m.id}`);
  assert.equal(r.status, 200);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.ok(fs.existsSync(file(request.reference_image_url)), 'request photo kept');
  // Sending needs a client.
  fd = new FormData(); fd.append('stencil_id', String(stencil.id)); fd.append('photo', new Blob([await skin(300, 300)], { type: 'image/png' }), 'x.png');
  r = await mara.post('/api/mockups', fd);
  assert.equal(r.status, 201);
  assert.equal((await mara.post(`/api/mockups/${r.data.mockup.id}/send`, {})).status, 400);
});
