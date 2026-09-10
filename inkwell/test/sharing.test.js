'use strict';

/* Client reviews with photos, review reminders, boards (collections) and portfolio sharing. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-share-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp, pageMeta } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const reminders = require('../server/reminders');
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
    const type = res.headers.get('content-type') || '';
    if (type.includes('json')) { try { data = await res.json(); } catch { data = null; } } else data = Buffer.from(await res.arrayBuffer());
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

const png = (bg = '#8a4b2a') => sharp({ create: { width: 60, height: 80, channels: 3, background: bg } }).png().toBuffer();
const idOf = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

/** A completed session between the client and artist, dated `daysAgo` days back. */
function completedSession(clientId, artistId, daysAgo = 3) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const day = d.toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO appointments (artist_id, client_id, starts_at, ends_at, note, status, deposit_amount, price) VALUES (?, ?, ?, ?, '', 'completed', 0, 300)`).run(artistId, clientId, `${day}T10:00`, `${day}T13:00`);
  return Number(info.lastInsertRowid);
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

test('reviews: photos, verified sessions, edit window, helpful votes, sorting and summary', async () => {
  const { c: hana, id: hanaId } = await login('hana@inkwell.demo');
  const { c: noah } = await login('noah@inkwell.demo');
  const yukiId = idOf('yuki@inkwell.demo');
  const apptId = completedSession(hanaId, yukiId);

  const fd = new FormData();
  fd.append('rating', '5');
  fd.append('body', 'Healed beautifully. Yuki was patient with all my questions.');
  fd.append('photos', new Blob([await png()], { type: 'image/png' }), 'healed-1.png');
  fd.append('photos', new Blob([await png('#2a4b8a')], { type: 'image/png' }), 'healed-2.png');
  let r = await hana.post(`/api/appointments/${apptId}/review`, fd);
  assert.equal(r.status, 201);
  const review = r.data.review;
  assert.equal(review.photos.length, 2);
  assert.match(review.photos[0].url, /^\/uploads\/.+\.webp$/);
  assert.equal(review.verified, true);
  assert.equal(review.can_edit, true);
  assert.equal(review.edited, false);

  r = await hana.post(`/api/appointments/${apptId}/review`, { rating: 4 });
  assert.equal(r.status, 409, 'one review per session');

  // Anyone can read the reviews; photos surface in the strip; summary has recommend% and photo counts.
  const anon = client();
  r = await anon.get(`/api/artists/${yukiId}/reviews?sort=photos`);
  assert.equal(r.status, 200);
  assert.ok(r.data.reviews.length >= 1);
  assert.equal(r.data.reviews[0].id, review.id);
  assert.ok(r.data.photos.some((p) => p.review_id === review.id));
  assert.ok(r.data.summary.with_photos >= 1);
  assert.equal(typeof r.data.summary.recommend_pct, 'number');
  r = await anon.get(`/api/artists/${yukiId}/reviews?sort=lowest`);
  const ratings = r.data.reviews.map((x) => x.rating);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => a - b), 'lowest first');
  r = await anon.get(`/api/artists/${yukiId}/reviews?sort=bogus&page=99`);
  assert.equal(r.data.sort, 'newest');
  assert.equal(r.data.reviews.length, 0);
  assert.equal(r.data.has_more, false);

  // Helpful votes: not on your own review, toggle for others.
  r = await hana.post(`/api/reviews/${review.id}/helpful`);
  assert.equal(r.status, 400);
  r = await noah.post(`/api/reviews/${review.id}/helpful`);
  assert.deepEqual([r.data.voted, r.data.helpful_count], [true, 1]);
  r = await noah.get(`/api/artists/${yukiId}/reviews?sort=helpful`);
  const counts = r.data.reviews.map((x) => x.helpful_count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'most helpful first');
  assert.equal(r.data.reviews.find((x) => x.id === review.id).voted, true);
  r = await noah.post(`/api/reviews/${review.id}/helpful`);
  assert.deepEqual([r.data.voted, r.data.helpful_count], [false, 0]);

  // Edit: change rating, drop one photo, add one.
  const edit = new FormData();
  edit.append('rating', '4');
  edit.append('remove_photos', JSON.stringify([review.photos[0].url]));
  edit.append('photos', new Blob([await png('#4b8a2a')], { type: 'image/png' }), 'healed-3.png');
  r = await hana.put(`/api/reviews/${review.id}`, edit);
  assert.equal(r.status, 200);
  assert.equal(r.data.review.rating, 4);
  assert.equal(r.data.review.photos.length, 2);
  assert.equal(r.data.review.edited, true);
  assert.ok(!r.data.review.photos.some((p) => p.url === review.photos[0].url), 'removed photo is gone');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(tmp, 'uploads', path.basename(review.photos[0].url))), false, 'file deleted');
  r = await noah.put(`/api/reviews/${review.id}`, { rating: 1 });
  assert.equal(r.status, 403);
  const tooMany = new FormData();
  for (let i = 0; i < 2; i += 1) tooMany.append('photos', new Blob([await png()], { type: 'image/png' }), `x${i}.png`);
  r = await hana.put(`/api/reviews/${review.id}`, tooMany);
  assert.equal(r.status, 400, 'photo limit');
  db.prepare(`UPDATE reviews SET created_at = datetime('now', '-40 days') WHERE id = ?`).run(review.id);
  r = await hana.put(`/api/reviews/${review.id}`, { rating: 5 });
  assert.equal(r.status, 400, 'edit window closed');

  // Mine: the review and a pending session prompt.
  const pendingAppt = completedSession(hanaId, idOf('priya@inkwell.demo'), 1);
  r = await hana.get('/api/reviews/mine');
  assert.ok(r.data.reviews.some((x) => x.id === review.id));
  assert.ok(r.data.pending.some((p) => p.id === pendingAppt));
  r = await noah.get('/api/reviews/mine');
  assert.equal(r.status, 200);

  // Deleting removes the remaining photo files.
  const files = r.data && (await hana.get('/api/reviews/mine')).data.reviews.find((x) => x.id === review.id).photos.map((p) => path.join(tmp, 'uploads', path.basename(p.url)));
  r = await hana.del(`/api/reviews/${review.id}`);
  assert.equal(r.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  files.forEach((f) => assert.equal(fs.existsSync(f), false));
});

test('review reminders go out once, two days after a completed session, only when unreviewed', async () => {
  const inesId = idOf('ines@inkwell.demo');
  const tomaszId = idOf('tomasz@inkwell.demo');
  const due = completedSession(inesId, tomaszId, 3);
  const fresh = completedSession(inesId, tomaszId, 1);
  const reviewedAppt = completedSession(inesId, tomaszId, 4);
  db.prepare("INSERT INTO reviews (appointment_id, artist_id, client_id, rating, body) VALUES (?, ?, ?, 5, 'great')").run(reviewedAppt, tomaszId, inesId);
  const before = db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(inesId).n;

  const sent = reminders.sendReviewReminders();
  assert.ok(sent >= 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = db.prepare('SELECT id, review_reminded_at FROM appointments WHERE id IN (?, ?, ?)').all(due, fresh, reviewedAppt);
  assert.ok(rows.find((x) => x.id === due).review_reminded_at, 'due session reminded');
  assert.equal(rows.find((x) => x.id === fresh).review_reminded_at, null, 'too soon');
  assert.equal(rows.find((x) => x.id === reviewedAppt).review_reminded_at, null, 'already reviewed');
  const log = db.prepare('SELECT subject, body_text FROM email_log WHERE to_user_id = ? ORDER BY id DESC LIMIT 1').get(inesId);
  assert.match(log.subject, /How was your session with Tomasz/);
  assert.match(log.body_text, new RegExp(`/appointments\\?review=${due}`));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(inesId).n, before + 1);
  assert.equal(reminders.sendReviewReminders(), 0, 'no double sends');
});

test('boards: save tattoos, share by link, attach to requests and messages', async () => {
  const { c: jordan, id: jordanId } = await login('jordan@inkwell.demo');
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const anon = client();
  const priyaId = idOf('priya@inkwell.demo'); // no seeded board holds Priya's work
  const art = db.prepare('SELECT id, title FROM artworks WHERE artist_id = ? ORDER BY id LIMIT 3').all(priyaId);

  let r = await jordan.post('/api/collections', { title: 'Sleeve ideas', description: 'Blackwork, forearm', artwork_id: art[0].id });
  assert.equal(r.status, 201);
  const board = r.data.collection;
  assert.equal(board.item_count, 1);
  assert.equal(board.is_public, false);
  assert.match(board.token, /^[A-Za-z0-9_-]{12}$/);
  r = await jordan.post(`/api/collections/${board.id}/items`, { artwork_id: art[1].id, note: 'love the linework' });
  assert.equal(r.status, 201);
  assert.equal(r.data.collection.item_count, 2);
  assert.equal(r.data.collection.items[0].note, 'love the linework');
  assert.deepEqual(r.data.collection.artists.map((a) => a.id), [priyaId]);
  r = await jordan.post(`/api/collections/${board.id}/items`, { artwork_id: 999999 });
  assert.equal(r.status, 404);

  // Which boards hold a piece; artwork detail says "saved".
  r = await jordan.get(`/api/collections?artwork_id=${art[1].id}`);
  assert.equal(r.data.collections.find((c) => c.id === board.id).has_artwork, true);
  r = await jordan.get(`/api/artworks/${art[1].id}`);
  assert.equal(r.data.artwork.saved, true);
  r = await jordan.get(`/api/artworks/${art[2].id}`);
  assert.equal(r.data.artwork.saved, false);

  // Private: only the owner can open it, even by token; no share card, no page meta.
  r = await anon.get(`/api/collections/shared/${board.token}`);
  assert.equal(r.status, 404);
  r = await mara.get(`/api/collections/shared/${board.token}`);
  assert.equal(r.status, 404);
  r = await jordan.get(`/api/collections/shared/${board.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.collection.is_owner, true);
  r = await anon.get(`/og/collections/${board.token}.png`);
  assert.equal(r.status, 404);
  assert.equal(pageMeta(`/c/${board.token}`).image, null);

  // Make it public: anyone with the link can view; the share card and page meta exist.
  r = await jordan.put(`/api/collections/${board.id}`, { is_public: true });
  assert.equal(r.data.collection.is_public, true);
  r = await anon.get(`/api/collections/shared/${board.token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.collection.is_owner, false);
  assert.equal(r.data.collection.items.length, 2);
  r = await anon.get(`/og/collections/${board.token}.png`);
  assert.equal(r.status, 200);
  assert.equal((await sharp(r.data).metadata()).width, 1200);
  assert.equal(pageMeta(`/c/${board.token}`).image, `/og/collections/${board.token}.png`);
  assert.match(pageMeta(`/c/${board.token}`).title, /Sleeve ideas/);
  r = await mara.put(`/api/collections/${board.id}`, { title: 'hijack' });
  assert.equal(r.status, 404, 'only the owner edits');

  // A private board attached to a request becomes viewable by link, and artists see it on the request.
  r = await jordan.post('/api/collections', { title: 'Private board' });
  const priv = r.data.collection;
  await jordan.post(`/api/collections/${priv.id}/items`, { artwork_id: art[2].id });
  const req = new FormData();
  req.append('title', 'Forearm blackwork piece');
  req.append('description', 'Something bold that wraps the forearm, see the board for references.');
  req.append('collection_id', String(priv.id));
  r = await jordan.post('/api/requests', req);
  assert.equal(r.status, 201);
  assert.equal(r.data.request.collection.id, priv.id);
  r = await mara.get(`/api/requests/${r.data.request.id}`);
  assert.equal(r.data.request.collection.title, 'Private board');
  assert.equal(r.data.request.collection.item_count, 1);
  r = await anon.get(`/api/collections/shared/${priv.token}`);
  assert.equal(r.status, 200, 'attached boards are viewable by link');
  const bad = new FormData();
  bad.append('title', 'x'); bad.append('description', 'long enough description here'); bad.append('collection_id', String(board.id));
  r = await mara.post('/api/requests', bad);
  assert.equal(r.status, 403, 'artists cannot post requests');

  // Share a board in a message.
  r = await jordan.post(`/api/messages/${maraId}`, { body: 'Here is what I have in mind', collection_id: board.id });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.attachments[0].type, 'collection');
  assert.equal(r.data.message.attachments[0].token, board.token);
  r = await mara.post(`/api/messages/${jordanId}`, { body: 'x', collection_id: board.id });
  assert.equal(r.status, 404, 'cannot share someone else\'s board');
  r = await mara.get('/api/messages');
  assert.equal(r.data.conversations.find((c) => c.user_id === jordanId).last_body, 'Here is what I have in mind');

  // Remove and delete.
  r = await jordan.del(`/api/collections/${board.id}/items/${art[0].id}`);
  assert.equal(r.data.collection.item_count, 1);
  r = await jordan.del(`/api/collections/${board.id}`);
  assert.equal(r.status, 200);
  r = await anon.get(`/api/collections/shared/${board.token}`);
  assert.equal(r.status, 404);
  r = await anon.get('/api/collections');
  assert.equal(r.status, 401);
});

test('share cards, QR codes and the embed widget', async () => {
  const anon = client();
  const maraId = idOf('mara@inkwell.demo');
  const art = db.prepare('SELECT id FROM artworks WHERE artist_id = ? LIMIT 1').get(maraId);
  const gal = db.prepare('SELECT id FROM galleries WHERE artist_id = ? LIMIT 1').get(maraId);
  for (const url of [`/og/artists/${maraId}.png`, `/og/artworks/${art.id}.png`, `/og/galleries/${gal.id}.png`]) {
    const r = await anon.get(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get('content-type'), 'image/png');
    const meta = await sharp(r.data).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 630]);
    assert.match(r.headers.get('cache-control'), /max-age/);
  }
  let r = await anon.get('/og/artists/999999.png');
  assert.equal(r.status, 404);
  // Page meta points at the cards, and the rendered page carries them.
  assert.equal(pageMeta(`/artists/${maraId}`).image, `/og/artists/${maraId}.png`);
  assert.equal(pageMeta(`/artworks/${art.id}`).image, `/og/artworks/${art.id}.png`);
  r = await anon.get(`/artworks/${art.id}`);
  assert.match(r.data.toString(), new RegExp(`og:image" content="[^"]+/og/artworks/${art.id}\\.png`));

  // QR: only Inkwell links.
  r = await anon.get(`/api/share/qr.svg?url=${encodeURIComponent(`/artists/${maraId}`)}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(r.data.toString(), /<svg/);
  r = await anon.get(`/api/share/qr.svg?url=${encodeURIComponent('https://evil.example/phish')}`);
  assert.equal(r.status, 400);

  // Embed: frameable, links back, honours theme and limit.
  r = await anon.get(`/embed/artists/${maraId}?theme=light&limit=3`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors \*/);
  const html = r.data.toString();
  assert.equal((html.match(/\/artworks\//g) || []).length, 3);
  assert.match(html, /color-scheme: light/);
  assert.match(html, new RegExp(`/book/${maraId}`));
  r = await anon.get('/embed/artists/999999');
  assert.equal(r.status, 404);
  // Everything else stays un-frameable.
  r = await anon.get(`/artists/${maraId}`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});
