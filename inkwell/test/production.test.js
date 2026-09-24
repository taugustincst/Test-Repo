'use strict';

/* Production hardening: headers, rate limits, origin checks, uploads, moderation, reviews, account deletion, webhooks, SEO. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-prod-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
delete process.env.STRIPE_SECRET_KEY;

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const { signStripePayload } = require('../server/payments');

let server; let base; let limited; let limitedBase;
const png = (w = 40, h = 60) => sharp({ create: { width: w, height: h, channels: 3, background: '#2d5a4c' } }).png().toBuffer();

function client(root) {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch((root || base) + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  }
  return { get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b) };
}
async function login(email, password = DEMO_PASSWORD) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  return { c, user: r.data.user };
}
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
async function openAllWeek(artistClient) {
  const availability = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:59' }));
  assert.equal((await artistClient.put('/api/artists/me/availability', { availability })).status, 200);
}
async function firstSlot(c, artistId, daysAhead) {
  const d = new Date(); d.setDate(d.getDate() + daysAhead);
  const r = await c.get(`/api/artists/${artistId}/slots?date=${isoDate(d)}`);
  const slot = r.data.slots.find((s) => s.available);
  assert.ok(slot);
  return slot.starts_at;
}
/** Book, confirm and complete a session between the given artist and client. */
async function completedSession(artist, artistId, cli, daysAhead = 3) {
  await openAllWeek(artist);
  const slot = await firstSlot(cli, artistId, daysAhead);
  let r = await cli.post('/api/appointments', { artist_id: artistId, starts_at: slot });
  assert.equal(r.status, 201);
  const appt = r.data.appointment;
  await artist.post(`/api/appointments/${appt.id}/confirm`);
  r = await artist.post(`/api/appointments/${appt.id}/complete`, {});
  assert.equal(r.data.appointment.status, 'completed');
  return appt;
}

before(async () => {
  seed();
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => { limited = createApp({ rateLimits: true, limits: { login: 3, api: 1000 } }).listen(0, resolve); });
  limitedBase = `http://127.0.0.1:${limited.address().port}`;
});
after(() => { server.close(); limited.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('security headers, health, robots, sitemap and share previews', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.ok(home.headers.get('referrer-policy'));
  const html = await home.text();
  assert.match(html, /og:title/);
  assert.match(html, /style\.css\?v=/, 'cache busting');

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.ok, true);
  assert.ok(health.version);

  const artist = await (await fetch(`${base}/artists/1`)).text();
  assert.match(artist, /<title>Mara Voss · Tattoo artist on Inkwell<\/title>/);
  assert.match(artist, /og:image" content="http:\/\/localhost/);
  const artwork = await (await fetch(`${base}/artworks/1`)).text();
  assert.match(artwork, /og:title" content="[^"]+ by Mara Voss/);

  const robots = await (await fetch(`${base}/robots.txt`)).text();
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: /);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  assert.match(sitemap, /<loc>[^<]+\/artists\/1<\/loc>/);
  assert.match(sitemap, /\/artworks\/1<\/loc>/);

  assert.equal((await fetch(`${base}/missing-file.png`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  const spa = await fetch(`${base}/some/deep/route`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('cache-control'), /no-cache/);

  const upload = await fetch(`${base}/uploads/seed-art-0.svg`);
  assert.equal(upload.status, 200);
  assert.match(upload.headers.get('content-security-policy'), /sandbox/);
});

test('origin check blocks cross-site state changes', async () => {
  const c = client();
  let r = await c.post('/api/auth/login', { email: 'ben@inkwell.demo', password: 'x' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await c.post('/api/auth/login', { email: 'ben@inkwell.demo', password: 'x' }, { origin: base.replace('127.0.0.1', '127.0.0.1') });
  assert.equal(r.status, 401, 'same-origin request reaches the handler');
  r = await c.get('/api/artists', { origin: 'https://evil.example' });
  assert.equal(r.status, 200, 'reads are not blocked');
});

test('login rate limit', async () => {
  const c = client(limitedBase);
  for (let i = 0; i < 3; i += 1) {
    const r = await c.post('/api/auth/login', { email: 'ben@inkwell.demo', password: 'wrong' });
    assert.equal(r.status, 401);
  }
  const r = await c.post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.match(r.data.error, /Too many sign-in attempts/);
});

test('uploads are validated by content and re-encoded; svg and fake images are rejected', async () => {
  const { c: artist } = await login('mara@inkwell.demo');
  const galleryId = (await artist.post('/api/galleries', { title: 'Upload tests' })).data.gallery.id;

  let form = new FormData();
  form.append('image', new Blob(['definitely not an image'], { type: 'image/png' }), 'fake.png');
  form.append('title', 'Fake');
  let r = await artist.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /could not be read as an image/);
  assert.equal(fs.readdirSync(process.env.INKWELL_UPLOAD_DIR).filter((f) => !f.startsWith('seed-')).length, 0, 'rejected file is cleaned up');

  form = new FormData();
  form.append('image', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/svg+xml' }), 'x.svg');
  r = await artist.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 400, 'svg uploads are refused');

  form = new FormData();
  form.append('image', new Blob([await png(3000, 2000)], { type: 'image/png' }), 'big.png');
  form.append('title', 'Big');
  r = await artist.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 201);
  assert.equal(r.data.artwork.width, 1800, 'long edge capped');
  assert.equal(r.data.artwork.height, 1200);
  assert.match(r.data.artwork.thumb_url, /\.thumb\.webp$/);
  const thumb = await sharp(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.artwork.thumb_url))).metadata();
  assert.equal(thumb.width, 480);

  const av = new FormData();
  av.append('avatar', new Blob([await png(500, 300)], { type: 'image/png' }), 'me.png');
  r = await artist.post('/api/auth/me/avatar', av);
  assert.equal(r.status, 200);
  assert.match(r.data.user.avatar_url, /\.webp$/);
  const meta = await sharp(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.user.avatar_url))).metadata();
  assert.deepEqual([meta.width, meta.height], [320, 320]);

  const bad = new FormData();
  bad.append('avatar', new Blob(['nope'], { type: 'image/jpeg' }), 'x.jpg');
  r = await artist.post('/api/auth/me/avatar', bad);
  assert.equal(r.status, 400);

  // WebP uploads share the processed file's name: they must still work, for pieces and avatars.
  const webp = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#445566' } }).webp().toBuffer();
  form = new FormData();
  form.append('image', new Blob([webp], { type: 'image/webp' }), 'piece.webp');
  form.append('title', 'WebP piece');
  r = await artist.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.artwork.image_url, /\.webp$/);
  assert.ok(fs.existsSync(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.artwork.image_url))));
  assert.ok(!fs.existsSync(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.artwork.image_url).replace(/\.webp$/, '.processed.webp'))), 'no temp file left');
  const avWebp = new FormData();
  avWebp.append('avatar', new Blob([await sharp({ create: { width: 200, height: 200, channels: 3, background: '#778899' } }).webp().toBuffer()], { type: 'image/webp' }), 'me.webp');
  r = await artist.post('/api/auth/me/avatar', avWebp);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(fs.existsSync(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.user.avatar_url))));
});

test('odd request bodies are answered, logged as ours, and never take the server down', async () => {
  const anon = client();
  // A JSON object where a string is expected used to throw inside an async handler and exit the process.
  let r = await anon.post('/api/auth/forgot', { email: { toString: 1 } });
  assert.equal(r.status, 500);
  assert.equal(r.data.error, 'Something went wrong on our side.', 'internal errors are not echoed');
  r = await anon.get('/api/health');
  assert.equal(r.status, 200, 'still serving');
  const { c: cli } = await login('lucia@inkwell.demo');
  r = await cli.post('/api/messages/1', { body: { toString: 1 } });
  assert.ok([400, 500].includes(r.status));
  assert.equal((await cli.get('/api/health')).status, 200);
});

test('reviews after completed sessions', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const { c: cli } = await login('lucia@inkwell.demo');
  const { c: other } = await login('ben@inkwell.demo');
  await openAllWeek(artist);
  const slot = await firstSlot(cli, sofia.id, 4);
  let r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  const pending = r.data.appointment;
  r = await cli.post(`/api/appointments/${pending.id}/review`, { rating: 5 });
  assert.equal(r.status, 400, 'no review before completion');

  const appt = await completedSession(artist, sofia.id, cli, 5);
  r = await cli.post(`/api/appointments/${appt.id}/review`, { rating: 9 });
  assert.equal(r.status, 400);
  r = await other.post(`/api/appointments/${appt.id}/review`, { rating: 5 });
  assert.equal(r.status, 403);
  r = await cli.post(`/api/appointments/${appt.id}/review`, { rating: 4, body: 'Lovely linework, great aftercare tips.' });
  assert.equal(r.status, 201);
  const reviewId = r.data.review.id;
  r = await cli.post(`/api/appointments/${appt.id}/review`, { rating: 4 });
  assert.equal(r.status, 409);

  r = await cli.get('/api/appointments');
  assert.equal(r.data.appointments.find((a) => a.id === appt.id).review_id, reviewId);
  r = await client().get(`/api/artists/${sofia.id}/reviews`);
  assert.equal(r.data.summary.review_count, 1);
  assert.equal(r.data.summary.rating, 4);
  r = await client().get('/api/artists');
  const listed = r.data.artists.find((a) => a.id === sofia.id);
  assert.equal(listed.rating, 4);
  assert.equal(listed.review_count, 1);

  r = await other.post(`/api/reviews/${reviewId}/reply`, { body: 'not mine' });
  assert.equal(r.status, 403);
  r = await artist.post(`/api/reviews/${reviewId}/reply`, { body: 'Thank you! Heal well.' });
  assert.equal(r.data.review.artist_reply, 'Thank you! Heal well.');
  r = await other.del(`/api/reviews/${reviewId}`);
  assert.equal(r.status, 403);
  assert.ok(db.prepare('SELECT 1 FROM email_log WHERE to_user_id = ? AND subject LIKE ?').get(sofia.id, '%4-star review%'));
});

test('reports, admin queue, suspension and reinstatement', async () => {
  const { c: reporter } = await login('jordan@inkwell.demo');
  const { c: admin, user: adminUser } = await login('admin@inkwell.demo');
  assert.equal(adminUser.is_admin, true);
  const { c: diego, user: diegoUser } = await login('diego@inkwell.demo');
  const diegoArt = db.prepare('SELECT id FROM artworks WHERE artist_id = ? ORDER BY id LIMIT 1').get(diegoUser.id).id;

  let r = await reporter.get('/api/admin/overview');
  assert.equal(r.status, 403, 'non-admins are refused');
  r = await reporter.post('/api/reports', { target_type: 'artwork', target_id: diegoArt, reason: 'nope' });
  assert.equal(r.status, 400);
  r = await reporter.post('/api/reports', { target_type: 'artwork', target_id: diegoArt, reason: 'copyright', details: 'This is traced from another artist.' });
  assert.equal(r.status, 201);
  r = await reporter.post('/api/reports', { target_type: 'artwork', target_id: diegoArt, reason: 'copyright' });
  assert.equal(r.data.duplicate, true);
  assert.ok(db.prepare('SELECT 1 FROM email_log WHERE to_user_id = ? AND subject LIKE ?').get(adminUser.id, 'New report:%'), 'admins are emailed');

  r = await admin.get('/api/admin/overview');
  assert.ok(r.data.overview.open_reports >= 1);
  r = await admin.get('/api/admin/reports?status=open');
  const report = r.data.reports.find((x) => x.target_type === 'artwork' && x.target_id === diegoArt);
  assert.ok(report);
  assert.equal(report.target.title.length > 0, true);
  r = await admin.post(`/api/admin/reports/${report.id}/resolve`, { action: 'remove', note: 'Traced work' });
  assert.equal(r.data.report.status, 'resolved');
  assert.equal((await client().get(`/api/artworks/${diegoArt}`)).status, 404, 'content removed');

  r = await reporter.post('/api/reports', { target_type: 'user', target_id: diegoUser.id, reason: 'scam' });
  const userReportId = r.data.report_id;
  r = await admin.post(`/api/admin/reports/${userReportId}/resolve`, { action: 'suspend', note: 'Taking deposits and vanishing' });
  assert.equal(r.status, 200);
  r = await diego.get('/api/auth/me');
  assert.equal(r.data.user, null, 'sessions were revoked');
  r = await client().post('/api/auth/login', { email: 'diego@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.status, 403);
  assert.equal(r.data.suspended, true);
  r = await client().get('/api/artists');
  assert.ok(!r.data.artists.some((a) => a.id === diegoUser.id), 'suspended artists are hidden');
  r = await client().get('/api/feed?limit=60');
  assert.ok(!r.data.artworks.some((a) => a.artist_id === diegoUser.id), 'their work leaves the feed');
  assert.ok(db.prepare('SELECT 1 FROM email_log WHERE to_user_id = ? AND subject LIKE ?').get(diegoUser.id, '%suspended%'));

  r = await admin.get('/api/admin/users?q=diego');
  assert.ok(r.data.users[0].suspended_at);
  r = await admin.post(`/api/admin/users/${diegoUser.id}/unsuspend`);
  assert.equal(r.data.user.suspended_at, null);
  r = await client().post('/api/auth/login', { email: 'diego@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.status, 200);

  r = await admin.post(`/api/admin/users/${adminUser.id}/suspend`, {});
  assert.equal(r.status, 400, 'cannot suspend yourself');
  r = await admin.post(`/api/admin/reports/${report.id}/resolve`, { action: 'dismiss' });
  assert.equal(r.status, 400, 'already closed');
  // The "Closed reports" tab asks for status=closed: resolved and dismissed together, nothing open.
  r = await admin.get('/api/admin/reports?status=closed');
  assert.equal(r.status, 200);
  assert.ok(r.data.reports.length >= 2);
  assert.ok(r.data.reports.every((x) => ['resolved', 'dismissed'].includes(x.status)));
  assert.ok(r.data.reports.some((x) => x.status === 'resolved'));
  assert.ok(!r.data.reports.some((x) => x.status === 'open'));
});

test('account export and deletion', async () => {
  const { c: artist, user: tomasz } = await login('tomasz@inkwell.demo');
  const { c: cli, user: ben } = await login('ben@inkwell.demo');
  await openAllWeek(artist);
  const slot = await firstSlot(cli, tomasz.id, 6);
  let r = await cli.post('/api/appointments', { artist_id: tomasz.id, starts_at: slot });
  const appt = r.data.appointment;
  const good = { number: '4242424242424242', exp_month: 12, exp_year: new Date().getFullYear() + 2, cvc: '123', name: 'Ben' };
  await cli.post(`/api/payments/${appt.payments[0].id}/pay`, { card: good });

  r = await cli.get('/api/auth/me/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.equal(r.data.profile.email, 'ben@inkwell.demo');
  assert.ok(r.data.appointments.some((a) => a.id === appt.id));
  assert.ok(r.data.payments.length >= 1);

  r = await cli.del('/api/auth/me', { password: 'wrong' });
  assert.equal(r.status, 400);
  r = await cli.del('/api/auth/me', { password: DEMO_PASSWORD });
  assert.equal(r.status, 200);
  r = await cli.get('/api/auth/me');
  assert.equal(r.data.user, null);
  r = await client().post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.status, 401, 'email no longer resolves');

  const row = db.prepare('SELECT name, email, bio FROM users WHERE id = ?').get(ben.id);
  assert.equal(row.name, 'Deleted user');
  assert.match(row.email, /deleted-\d+@deleted\.invalid/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tattoo_requests WHERE client_id = ?').get(ben.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? OR recipient_id = ?').get(ben.id, ben.id).n, 0);

  r = await artist.get('/api/appointments');
  const kept = r.data.appointments.find((a) => a.id === appt.id);
  assert.ok(kept, 'artist still sees the booking record');
  assert.equal(kept.status, 'cancelled');
  assert.equal(kept.client_name, 'Deleted user');
  assert.equal(kept.payments[0].status, 'refunded', 'early cancellation refunded the deposit');
});

test('stripe webhook records payments with signature verification and idempotency', async () => {
  const { c: artist, user: yuki } = await login('yuki@inkwell.demo');
  const { c: cli } = await login('amara@inkwell.demo');
  await openAllWeek(artist);
  const slot = await firstSlot(cli, yuki.id, 8);
  const r0 = await cli.post('/api/appointments', { artist_id: yuki.id, starts_at: slot });
  const payment = r0.data.appointment.payments[0];
  assert.equal(payment.status, 'pending');

  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_777', client_reference_id: String(payment.id) } } };
  const body = JSON.stringify(event);
  const post = (sig) => fetch(`${base}/api/payments/webhook/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });

  let res = await post('t=1,v1=deadbeef');
  assert.equal(res.status, 400);
  res = await post(signStripePayload(body, 'whsec_wrong'));
  assert.equal(res.status, 400);
  res = await post(signStripePayload(body, 'whsec_testsecret', Math.floor(Date.now() / 1000) - 3600));
  assert.equal(res.status, 400, 'stale timestamps are rejected');

  res = await post(signStripePayload(body, 'whsec_testsecret'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).received, true);
  const paid = db.prepare('SELECT status, provider, provider_ref FROM payments WHERE id = ?').get(payment.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.provider, 'stripe');
  assert.equal(paid.provider_ref, 'pi_777');

  res = await post(signStripePayload(body, 'whsec_testsecret'));
  assert.equal((await res.json()).duplicate, true, 'same event is not processed twice');
});

test('password limits and logout-all', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { email: 'long@example.com', password: 'x'.repeat(201), name: 'Long', role: 'client', accept_terms: true });
  assert.equal(r.status, 400);
  const { c: a } = await login('priya@inkwell.demo');
  const { c: b } = await login('priya@inkwell.demo');
  r = await a.post('/api/auth/logout-all');
  assert.equal(r.status, 200);
  assert.equal((await b.get('/api/auth/me')).data.user, null);
});
