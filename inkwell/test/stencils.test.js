'use strict';

/* Stencil library: passive tracing of gallery and flash uploads, backfill, library routes, print-size download. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-stencils-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const stencils = require('../server/stencils');
const sharp = require('sharp');

let server;
let base;

function client() {
  let cookie = '';
  async function call(method, url, body, raw = false) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }
  return { get: (u) => call('GET', u), raw: (u) => call('GET', u, undefined, true), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u) };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, id: r.data.user.id };
}

/** A drawing with real lines: a circle, a triangle and a thin spiral on a cream ground. */
const drawing = () => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">
  <rect width="400" height="500" fill="#f4ede4"/>
  <circle cx="200" cy="220" r="120" fill="none" stroke="#111" stroke-width="10"/>
  <polygon points="200,330 80,470 320,470" fill="#b3262e"/>
  <path d="M200 220 m-60 0 a60 60 0 1 0 120 0 a45 45 0 1 1 -90 0 a30 30 0 1 0 60 0" fill="none" stroke="#111" stroke-width="2"/>
</svg>`)).png().toBuffer();
const blank = () => sharp({ create: { width: 200, height: 250, channels: 3, background: '#e8e8e8' } }).png().toBuffer();
const file = (url) => path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(url));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const gone = (f) => waitFor(() => !fs.existsSync(f), 3000);

async function waitFor(fn, ms = 6000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await sleep(120);
  }
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

test('renderStencil pulls lines out of a drawing as black on transparent; blank images carry no ink', async () => {
  const src = path.join(tmp, 'drawing.png');
  fs.writeFileSync(src, await drawing());
  const r = await stencils.renderStencil(src, { detail: 3 });
  assert.equal(r.width, 400);
  assert.equal(r.height, 500);
  assert.ok(r.ink > 0.02 && r.ink < 0.3, `ink share ${r.ink}`);
  const meta = await sharp(r.png).metadata();
  assert.equal(meta.channels, 4, 'transparent PNG');
  const { data } = await sharp(r.png).raw().toBuffer({ resolveWithObject: true });
  let lines = 0;
  let coloured = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) { lines += 1; if (data[i] || data[i + 1] || data[i + 2]) coloured += 1; }
  }
  assert.ok(lines > 0);
  assert.equal(coloured, 0, 'lines are pure black');
  // The circle's outline lands where the circle is: a pixel on its ring is inked, the centre is not.
  const at = (x, y) => data[(y * 400 + x) * 4 + 3];
  assert.equal(at(200, 220), 0, 'centre of the circle is empty');
  assert.ok([112, 116, 120, 124, 128].some((dx) => at(200 - dx, 220) === 255), 'the ring is traced');
  // Every level traces the thin spiral inside the ring; higher levels draw it with thinner lines.
  const fine = await stencils.renderStencil(src, { detail: 5 });
  const coarse = await stencils.renderStencil(src, { detail: 1 });
  const inner = async (png) => {
    const raw = (await sharp(png).raw().toBuffer({ resolveWithObject: true })).data;
    let n = 0;
    for (let yy = 130; yy < 310; yy += 1) for (let xx = 110; xx < 290; xx += 1) { if (raw[(yy * 400 + xx) * 4 + 3] === 255 && Math.hypot(xx - 200, yy - 220) < 100) n += 1; }
    return n;
  };
  assert.ok(await inner(fine.png) > 500 && await inner(coarse.png) > 500, 'the spiral is traced at both ends of the scale');
  assert.ok(fine.ink < coarse.ink, 'fine detail draws thinner lines');
  const blankFile = path.join(tmp, 'blank.png');
  fs.writeFileSync(blankFile, await blank());
  const b = await stencils.renderStencil(blankFile, { detail: 3 });
  assert.equal(b.ink, 0);
});

test('uploading a gallery piece or a flash design traces a stencil in the background; deleting the piece drops it', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  let r = await mara.post('/api/galleries', { title: 'Stencil tests', description: '' });
  const galleryId = r.data.gallery.id;
  const form = new FormData();
  form.append('image', new Blob([await drawing()], { type: 'image/png' }), 'drawing.png');
  form.append('title', 'Ring and spiral');
  r = await mara.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 201);
  const artworkId = r.data.artwork.id;
  const row = await waitFor(() => { const s = db.prepare(`SELECT * FROM stencils WHERE source_type = 'artwork' AND source_id = ?`).get(artworkId); return s && s.status !== 'pending' ? s : null; });
  assert.equal(row.status, 'ready', row.error);
  assert.equal(row.artist_id, maraId);
  assert.equal(row.title, 'Ring and spiral');
  assert.equal(row.detail, stencils.DEFAULT_DETAIL);
  assert.ok(fs.existsSync(file(row.image_url)) && fs.existsSync(file(row.thumb_url)));
  r = await mara.get('/api/stencils?source=artwork');
  const mine = r.data.stencils.find((s) => s.source_id === artworkId);
  assert.ok(mine);
  assert.equal(mine.source_link, `/galleries/${galleryId}`);
  assert.equal(mine.print_url, `/api/stencils/${mine.id}/print.png`);
  assert.equal(r.data.dpi, 300);
  assert.deepEqual(r.data.levels, [1, 2, 3, 4, 5]);

  const fd = new FormData();
  fd.append('image', new Blob([await drawing()], { type: 'image/png' }), 'flash.png');
  fd.append('title', 'Spiral flash');
  fd.append('price', '150');
  r = await mara.post('/api/flash', fd);
  assert.equal(r.status, 201);
  const flashId = r.data.flash.id;
  const flashRow = await waitFor(() => { const s = db.prepare(`SELECT * FROM stencils WHERE source_type = 'flash' AND source_id = ?`).get(flashId); return s && s.status !== 'pending' ? s : null; });
  assert.equal(flashRow.status, 'ready', flashRow.error);
  r = await mara.get('/api/stencils?source=flash');
  assert.ok(r.data.stencils.some((s) => s.source_id === flashId && s.source_link === `/flash/${flashId}`));

  // Deleting the source removes the stencil and its files; the flash design goes the same way.
  r = await mara.del(`/api/artworks/${artworkId}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM stencils WHERE source_type = 'artwork' AND source_id = ?`).get(artworkId).n, 0);
  await gone(file(row.image_url));
  r = await mara.del(`/api/flash/${flashId}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM stencils WHERE source_type = 'flash' AND source_id = ?`).get(flashId).n, 0);
});

test('the scheduler backfills pieces that predate the library; artists can trace their missing pieces on demand', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM stencils`).get().n;
  const r1 = await stencils.backfill(4);
  assert.equal(r1.queued, 4);
  assert.equal(r1.processed, 4);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM stencils WHERE status = 'ready'`).get().n - before, 4, 'seeded SVG art traces cleanly');
  const r2 = await stencils.backfill(4);
  assert.equal(r2.queued, 4, 'the next run picks up the next pieces');

  // Mara's seeded pieces are the oldest, so the two runs above did not reach them.
  const { c: sofia, id: sofiaId } = await login('mara@inkwell.demo');
  const r = await sofia.post('/api/stencils/backfill');
  assert.equal(r.status, 200);
  const sofiaPieces = db.prepare(`SELECT (SELECT COUNT(*) FROM artworks WHERE artist_id = ?) + (SELECT COUNT(*) FROM flash_designs WHERE artist_id = ?) AS n`).get(sofiaId, sofiaId).n;
  const sofiaStencils = db.prepare(`SELECT COUNT(*) AS n FROM stencils WHERE artist_id = ?`).get(sofiaId).n;
  assert.equal(sofiaStencils, sofiaPieces, 'every one of her pieces now has a stencil row');
  assert.ok(r.data.queued > 0 && r.data.processed > 0);
  const again = await sofia.post('/api/stencils/backfill');
  assert.equal(again.data.queued, 0, 'nothing left to queue');
  const list = await sofia.get('/api/stencils');
  assert.equal(list.data.counts.total, sofiaPieces);
  assert.equal(list.data.counts.pending, 0);
  assert.ok(list.data.counts.ready >= sofiaPieces - list.data.counts.failed);
});

test('library routes: upload, rename, favourite, detail change, regenerate, filters, print size, delete, access', async () => {
  const { c: diego, id: diegoId } = await login('diego@inkwell.demo');
  const { c: mara } = await login('mara@inkwell.demo');
  const { c: hana } = await login('hana@inkwell.demo');
  const anon = client();
  let r = await hana.get('/api/stencils');
  assert.equal(r.status, 403, 'clients have no stencil library');
  r = await anon.get('/api/stencils');
  assert.equal(r.status, 401);

  // Upload straight into the library.
  let fd = new FormData();
  fd.append('image', new Blob([await drawing()], { type: 'image/png' }), 'sketch.png');
  fd.append('title', 'Snake sketch');
  fd.append('detail', '4');
  r = await diego.post('/api/stencils', fd);
  assert.equal(r.status, 201);
  const s = r.data.stencil;
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.source_type, 'upload');
  assert.equal(s.source_id, s.id);
  assert.equal(s.detail, 4);
  assert.equal(s.title, 'Snake sketch');
  assert.equal(s.source_link, null);
  assert.ok(s.ink > 0);
  r = await diego.post('/api/stencils', new FormData());
  assert.equal(r.status, 400);

  // A blank image cannot be traced: the row is kept as failed with a reason.
  fd = new FormData();
  fd.append('image', new Blob([await blank()], { type: 'image/png' }), 'grey.png');
  r = await diego.post('/api/stencils', fd);
  assert.equal(r.status, 201);
  assert.equal(r.data.stencil.status, 'failed');
  assert.match(r.data.stencil.error, /contrast/);
  assert.equal(r.data.stencil.title, 'grey', 'title falls back to the file name');
  assert.equal(r.data.stencil.print_url, null);
  const failedId = r.data.stencil.id;
  r = await diego.raw(`/api/stencils/${failedId}/print.png`);
  assert.equal(r.status, 409);
  r = await diego.post(`/api/stencils/${failedId}/regenerate`);
  assert.equal(r.data.stencil.status, 'failed', 'still blank');

  // Rename and favourite.
  r = await diego.put(`/api/stencils/${s.id}`, { title: '  Snake and dagger  ', favorite: true });
  assert.equal(r.data.stencil.title, 'Snake and dagger');
  assert.equal(r.data.stencil.favorite, true);
  r = await diego.get('/api/stencils?favorites=1');
  assert.deepEqual(r.data.stencils.map((x) => x.id), [s.id]);
  assert.equal(r.data.counts.favorites, 1);
  r = await diego.get('/api/stencils?source=upload');
  assert.deepEqual(r.data.stencils.map((x) => x.id).sort(), [s.id, failedId].sort());
  assert.equal(r.data.stencils[0].id, s.id, 'favourites first');

  // Changing the detail level re-traces and replaces the file.
  const oldImage = s.image_url;
  r = await diego.put(`/api/stencils/${s.id}`, { detail: 1 });
  assert.equal(r.data.stencil.detail, 1);
  assert.equal(r.data.stencil.status, 'ready');
  assert.notEqual(r.data.stencil.image_url, oldImage);
  await gone(file(oldImage));
  assert.ok(fs.existsSync(file(r.data.stencil.image_url)));
  r = await diego.put(`/api/stencils/${s.id}`, { detail: 9 });
  assert.equal(r.status, 400);
  r = await diego.post(`/api/stencils/${s.id}/regenerate`);
  assert.equal(r.data.stencil.status, 'ready');

  // Print at real size: 10 cm wide at 300 dpi is 1181 px; mirrored flips the drawing; white unless transparent.
  r = await diego.raw(`/api/stencils/${s.id}/print.png?width_cm=10`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="snake-and-dagger-10cm\.png"/);
  let meta = await sharp(r.buffer).metadata();
  assert.equal(meta.width, Math.round((10 / 2.54) * 300));
  assert.equal(meta.height, Math.round(meta.width * 500 / 400));
  assert.equal(meta.density, 300);
  assert.equal(meta.channels, 3, 'flattened on white');
  const plain = await sharp(r.buffer).raw().toBuffer();
  r = await diego.raw(`/api/stencils/${s.id}/print.png?width_cm=10&mirror=1`);
  assert.match(r.headers.get('content-disposition'), /-mirrored\.png/);
  const mirrored = await sharp(r.buffer).raw().toBuffer();
  const w = meta.width;
  const y = Math.round(meta.height * 0.9);
  let differs = false;
  let matchesFlip = 0;
  let checked = 0;
  for (let x = 0; x < w; x += 7) {
    const a = plain[(y * w + x) * 3];
    const b = mirrored[(y * w + x) * 3];
    const bf = mirrored[(y * w + (w - 1 - x)) * 3];
    if (a !== b) differs = true;
    checked += 1;
    if (Math.abs(a - bf) < 40) matchesFlip += 1;
  }
  assert.ok(differs, 'mirroring changes the asymmetric drawing');
  assert.ok(matchesFlip / checked > 0.95, 'mirrored image is the flipped original');
  r = await diego.raw(`/api/stencils/${s.id}/print.png?height_cm=5&transparent=1&dpi=150`);
  meta = await sharp(r.buffer).metadata();
  assert.equal(meta.height, Math.round((5 / 2.54) * 150));
  assert.equal(meta.channels, 4);
  r = await diego.raw(`/api/stencils/${s.id}/print.png?width_cm=900`);
  meta = await sharp(r.buffer).metadata();
  assert.equal(meta.width, 6000, 'capped');

  // Only the owner sees or changes a stencil.
  r = await mara.get(`/api/stencils/${s.id}`);
  assert.equal(r.status, 404);
  r = await mara.put(`/api/stencils/${s.id}`, { title: 'Mine now' });
  assert.equal(r.status, 404);
  r = await mara.raw(`/api/stencils/${s.id}/print.png`);
  assert.equal(r.status, 404);
  r = await mara.del(`/api/stencils/${s.id}`);
  assert.equal(r.status, 404);
  r = await mara.get('/api/stencils');
  assert.ok(!r.data.stencils.some((x) => x.artist_id === diegoId || x.id === s.id));

  // Delete: an uploaded source goes with the stencil.
  const sourceFile = file(s.source_url);
  const imageFile = file((await diego.get(`/api/stencils/${s.id}`)).data.stencil.image_url);
  assert.ok(fs.existsSync(sourceFile) && fs.existsSync(imageFile));
  r = await diego.del(`/api/stencils/${s.id}`);
  assert.equal(r.status, 200);
  await gone(sourceFile); await gone(imageFile);
  r = await diego.get(`/api/stencils/${s.id}`);
  assert.equal(r.status, 404);
});
