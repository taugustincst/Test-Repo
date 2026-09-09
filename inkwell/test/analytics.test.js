'use strict';

/* Artist analytics: view tracking, the report, ranges, deltas and the CSV export. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-analytics-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.STRIPE_SECRET_KEY;

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const analytics = require('../server/analytics');

let server; let base;
const GOOD_CARD = { number: '4242424242424242', exp_month: 12, exp_year: new Date().getFullYear() + 2, cvc: '123', name: 'Client' };

function client(ua = 'test-browser/1.0') {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const init = { method, headers: { 'user-agent': ua, ...headers } };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null; let text = null;
    if ((res.headers.get('content-type') || '').includes('json')) data = await res.json(); else text = await res.text();
    return { status: res.status, data, text, headers: res.headers };
  }
  return { get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b) };
}
async function login(email, ua) {
  const c = client(ua);
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200);
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

before(async () => {
  seed();
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('access control and range validation', async () => {
  assert.equal((await client().get('/api/artists/me/analytics')).status, 401);
  const { c: cli } = await login('jordan@inkwell.demo');
  assert.equal((await cli.get('/api/artists/me/analytics')).status, 403, 'clients have no analytics');
  const { c: artist } = await login('sofia@inkwell.demo');
  assert.equal((await artist.get('/api/artists/me/analytics?range=1y')).status, 400);
  const r = await artist.get('/api/artists/me/analytics?range=7d');
  assert.equal(r.status, 200);
  assert.equal(r.data.range.key, '7d');
  assert.equal(r.data.series.length, 7);
  assert.equal((await artist.get('/api/artists/me/analytics?range=30d')).data.series.length, 30);
  assert.equal((await artist.get('/api/artists/me/analytics?range=90d')).data.series.length, 13, '90 days in weekly buckets');
  assert.equal((await artist.get('/api/artists/me/analytics?range=12m')).data.series.length, 12);
  assert.equal(analytics.resolveRange('bogus').key, '30d');
});

test('views are tracked with privacy-preserving visitor keys', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const baseline = (await artist.get('/api/artists/me/analytics?range=30d')).data.summary;
  assert.equal(baseline.profile_views, 0, 'seed leaves Sofia untouched');

  const anon = client('Mozilla/5.0 (test)');
  await anon.get(`/api/artists/${sofia.id}`);
  await anon.get(`/api/artists/${sofia.id}`);
  const other = client('Mozilla/5.0 (another device)');
  await other.get(`/api/artists/${sofia.id}`);
  await client('Googlebot/2.1').get(`/api/artists/${sofia.id}`);
  await artist.get(`/api/artists/${sofia.id}`); // own profile, never counted

  let s = (await artist.get('/api/artists/me/analytics?range=30d')).data.summary;
  assert.equal(s.profile_views, 3, 'two visitors, three views; bots and self excluded');
  assert.equal(s.unique_visitors, 2, 'same browser on the same day is one visitor');

  const artworkId = db.prepare('SELECT id FROM artworks WHERE artist_id = ? ORDER BY id LIMIT 1').get(sofia.id).id;
  const galleryId = db.prepare('SELECT gallery_id FROM artworks WHERE id = ?').get(artworkId).gallery_id;
  const { c: viewer } = await login('lucia@inkwell.demo', 'Mozilla/5.0 (phone)');
  await viewer.get(`/api/artworks/${artworkId}`);
  await viewer.get(`/api/artworks/${artworkId}`);
  await viewer.get(`/api/galleries/${galleryId}`);
  await viewer.get(`/api/artists/${sofia.id}/availability`);
  const r = (await artist.get('/api/artists/me/analytics?range=30d')).data;
  s = r.summary;
  assert.equal(s.artwork_views, 2);
  assert.equal(s.gallery_views, 1);
  assert.equal(s.booking_page_views, 1);
  assert.equal(s.unique_visitors, 3, 'signed-in viewer keyed by user id');
  assert.equal(r.top_artworks[0].id, artworkId);
  assert.equal(r.top_artworks[0].views, 2);
  assert.equal(r.funnel[0].count, 1);
  assert.equal(r.series.reduce((n, b) => n + b.profile_views, 0), 3, 'series sums to the summary');

  const keys = db.prepare('SELECT DISTINCT visitor_key FROM analytics_events WHERE artist_id = ?').all(sofia.id).map((k) => k.visitor_key);
  assert.ok(keys.every((k) => /^(u:\d+|a:[a-f0-9]{32})$/.test(k)), 'no raw addresses stored');
});

test('bookings, revenue, funnel, heatmap, clients, ratings, followers and deltas', async () => {
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');
  const { c: cli, user: lucia } = await login('lucia@inkwell.demo');
  await openAllWeek(artist);
  const before = (await artist.get('/api/artists/me/analytics?range=30d')).data.summary;

  const slot = await firstSlot(cli, sofia.id, 3);
  let r = await cli.post('/api/appointments', { artist_id: sofia.id, starts_at: slot });
  const appt = r.data.appointment;
  await cli.post(`/api/payments/${appt.payments[0].id}/pay`, { card: GOOD_CARD });
  await artist.post(`/api/appointments/${appt.id}/confirm`);
  r = await artist.post(`/api/appointments/${appt.id}/complete`, { price: 300 });
  const balance = r.data.appointment.payments.find((p) => p.kind === 'balance');
  await cli.post(`/api/payments/${balance.id}/pay`, { card: GOOD_CARD });
  await cli.post(`/api/appointments/${appt.id}/review`, { rating: 5, body: 'Perfect.' });
  await cli.post(`/api/artists/${sofia.id}/follow`);

  r = (await artist.get('/api/artists/me/analytics?range=30d')).data;
  const s = r.summary;
  assert.equal(s.booking_requests, 1);
  assert.equal(s.confirmed, 1);
  assert.equal(s.completed, 1);
  assert.equal(s.confirmation_rate, 100);
  assert.equal(s.revenue, 300, 'deposit plus balance');
  assert.equal(s.avg_session_value, 300);
  assert.equal(s.new_followers, before.new_followers + 1, 'seeded follows may already fall in the window');
  assert.equal(s.rating, 5);
  assert.equal(s.review_count, 1);
  assert.equal(s.reviews_in_range, 1);
  assert.deepEqual(r.funnel.map((f) => f.count).slice(1), [1, 1, 1]);
  assert.equal(r.series.reduce((n, b) => n + b.revenue, 0), 300);
  assert.equal(r.series.reduce((n, b) => n + b.booking_requests, 0), 1);
  assert.deepEqual(r.clients, { total: 1, returning: 0, new: 1 });
  assert.equal(r.ratings[5], 1);

  // Heatmap counts the session at its weekday and hour.
  const [datePart, timePart] = slot.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const hour = Number(timePart.slice(0, 2));
  const inRange = new Date(datePart) < new Date(r.range.to);
  if (inRange) assert.equal(r.heatmap[weekday][hour], 1);

  // Returning clients: an older appointment before the window makes Lucía a returning client.
  db.prepare(`INSERT INTO appointments (artist_id, client_id, starts_at, ends_at, status, created_at) VALUES (?, ?, '2025-01-10T10:00', '2025-01-10T12:00', 'completed', datetime('now', '-100 days'))`).run(sofia.id, lucia.id);
  r = (await artist.get('/api/artists/me/analytics?range=30d')).data;
  assert.deepEqual(r.clients, { total: 1, returning: 1, new: 0 });

  // Deltas: an event 40 days ago sits in the previous window for 30d and inside the window for 90d.
  db.prepare(`INSERT INTO analytics_events (artist_id, kind, visitor_key, created_at) VALUES (?, 'profile_view', 'a:old', datetime('now', '-40 days'))`).run(sofia.id);
  const thirty = (await artist.get('/api/artists/me/analytics?range=30d')).data;
  assert.equal(thirty.previous.profile_views, 1);
  assert.equal(thirty.summary.profile_views, 3);
  const ninety = (await artist.get('/api/artists/me/analytics?range=90d')).data;
  assert.equal(ninety.summary.profile_views, 4);
  assert.equal(ninety.previous.profile_views, 0);

  // Demand: open requests in the artist's styles.
  await cli.post('/api/requests', { title: 'Geometric forearm band', description: 'Clean geometric band around the forearm, black only.', style: 'Geometric' });
  r = (await artist.get('/api/artists/me/analytics?range=30d')).data;
  assert.ok(r.demand.some((x) => x.style === 'Geometric' && x.open_requests >= 1));
  assert.ok(r.demand.every((x) => sofia.profile.styles.includes(x.style)));
});

test('CSV export lists bookings in the window with what was collected', async () => {
  const { c: artist } = await login('sofia@inkwell.demo');
  const r = await artist.get('/api/artists/me/analytics/export.csv?range=30d');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="inkwell-bookings-/);
  const lines = r.text.trim().split('\n');
  assert.equal(lines[0], 'booking_id,session_start,status,client,session_total,collected,refunded,rating');
  const completed = lines.slice(1).find((l) => l.includes(',completed,'));
  assert.ok(completed);
  assert.match(completed, /Lucía Fernández,300,300,0,5$/);
  assert.equal((await client().get('/api/artists/me/analytics/export.csv')).status, 401);
});

test('seeded artists have a populated dashboard', async () => {
  const { c: artist } = await login('mara@inkwell.demo');
  const r = (await artist.get('/api/artists/me/analytics?range=90d')).data;
  assert.ok(r.summary.profile_views > 100);
  assert.ok(r.summary.revenue > 0);
  assert.ok(r.summary.completed > 0);
  assert.ok(r.top_artworks.length >= 3);
  assert.ok(r.heatmap.flat().some((v) => v > 0));
  assert.ok(r.summary.review_count > 0);
  assert.equal(r.series.length, 13);
});
