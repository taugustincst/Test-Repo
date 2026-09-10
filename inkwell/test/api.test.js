'use strict';

/* End-to-end API tests. Runs the app on a random port with a throwaway database. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-test-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const sharp = require('sharp');
const png = (w = 24, h = 32, bg = '#d4553f') => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).png().toBuffer();

let server;
let base;

/** Minimal cookie-jar client so each "user" keeps their own session. */
function client() {
  let cookie = '';
  async function call(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
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
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b),
    put: (u, b) => call('PUT', u, b),
    del: (u) => call('DELETE', u),
  };
}

function futureDate(daysAhead, weekday) {
  // First date at least daysAhead days out that falls on the given weekday.
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

test('public browsing: artists, feed, galleries, artwork', async () => {
  const c = client();
  const artists = await c.get('/api/artists');
  assert.equal(artists.status, 200);
  assert.ok(artists.data.artists.length >= 6);
  assert.ok(artists.data.artists[0].styles.length > 0);

  const filtered = await c.get('/api/artists?style=Japanese');
  assert.ok(filtered.data.artists.every((a) => a.styles.includes('Japanese')));

  const feed = await c.get('/api/feed?limit=5');
  assert.equal(feed.data.artworks.length, 5);
  assert.equal(feed.data.has_more, true);

  const first = feed.data.artworks[0];
  const gallery = await c.get(`/api/galleries/${first.gallery_id}`);
  assert.equal(gallery.status, 200);
  assert.ok(gallery.data.gallery.artworks.some((a) => a.id === first.id));

  const artwork = await c.get(`/api/artworks/${first.id}`);
  assert.equal(artwork.status, 200);
  assert.ok(Array.isArray(artwork.data.artwork.comments));
  assert.equal(artwork.data.artwork.liked, false);
});

test('registration validation and session lifecycle', async () => {
  const c = client();
  let r = await c.post('/api/auth/register', { email: 'bad', password: 'short', name: '', role: 'nope' });
  assert.equal(r.status, 400);

  r = await c.post('/api/auth/register', { email: 'new.artist@example.com', password: 'supersecret', name: 'New Artist', role: 'artist', styles: ['Realism', 'Not A Style'] });
  assert.equal(r.status, 400, 'terms must be accepted');
  r = await c.post('/api/auth/register', { email: 'new.artist@example.com', password: 'supersecret', name: 'New Artist', role: 'artist', styles: ['Realism', 'Not A Style'], accept_terms: true });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'artist');
  assert.deepEqual(r.data.user.profile.styles, ['Realism']);

  r = await c.post('/api/auth/register', { email: 'NEW.ARTIST@example.com', password: 'supersecret', name: 'Dup', role: 'artist', accept_terms: true });
  assert.equal(r.status, 409);

  r = await c.get('/api/auth/me');
  assert.equal(r.data.user.email, 'new.artist@example.com');

  r = await c.post('/api/auth/logout');
  assert.equal(r.status, 200);
  r = await c.get('/api/auth/me');
  assert.equal(r.data.user, null);

  r = await c.post('/api/auth/login', { email: 'new.artist@example.com', password: 'wrong' });
  assert.equal(r.status, 401);
  r = await c.post('/api/auth/login', { email: 'new.artist@example.com', password: 'supersecret' });
  assert.equal(r.status, 200);
});

test('artist creates a gallery, uploads artwork, others like and comment', async () => {
  const artist = client();
  await artist.post('/api/auth/login', { email: 'mara@inkwell.demo', password: DEMO_PASSWORD });
  const fan = client();
  await fan.post('/api/auth/login', { email: 'jordan@inkwell.demo', password: DEMO_PASSWORD });

  let r = await fan.post('/api/galleries', { title: 'Nope' });
  assert.equal(r.status, 403, 'clients cannot create galleries');

  r = await artist.post('/api/galleries', { title: 'Test Gallery', description: 'For tests' });
  assert.equal(r.status, 201);
  const galleryId = r.data.gallery.id;

  const form = new FormData();
  form.append('image', new Blob([await png()], { type: 'image/png' }), 'piece.png');
  form.append('title', 'Uploaded piece');
  form.append('style', 'Blackwork');
  form.append('placement', 'Forearm');
  r = await artist.post(`/api/galleries/${galleryId}/artworks`, form);
  assert.equal(r.status, 201);
  const artworkId = r.data.artwork.id;
  assert.equal(r.data.artwork.style, 'Blackwork');
  assert.ok(fs.existsSync(path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(r.data.artwork.image_url))));
  assert.match(r.data.artwork.image_url, /\.webp$/, 'uploads are re-encoded');
  assert.match(r.data.artwork.thumb_url, /\.thumb\.webp$/);
  assert.equal(r.data.artwork.width, 24);
  assert.equal(r.data.artwork.height, 32);

  const badForm = new FormData();
  badForm.append('image', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
  r = await artist.post(`/api/galleries/${galleryId}/artworks`, badForm);
  assert.equal(r.status, 400, 'non-image uploads are rejected');

  r = await fan.post(`/api/artworks/${artworkId}/like`);
  assert.equal(r.data.liked, true);
  assert.equal(r.data.like_count, 1);
  r = await fan.post(`/api/artworks/${artworkId}/like`);
  assert.equal(r.data.liked, false);
  assert.equal(r.data.like_count, 0);

  r = await fan.post(`/api/artworks/${artworkId}/comments`, { body: 'Love this' });
  assert.equal(r.status, 201);
  const commentId = r.data.comments[0].id;
  const other = client();
  await other.post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD });
  r = await other.del(`/api/comments/${commentId}`);
  assert.equal(r.status, 403, 'only author or artist can delete');
  r = await artist.del(`/api/comments/${commentId}`);
  assert.equal(r.status, 200);

  r = await fan.post('/api/artists/1/follow');
  assert.equal(r.data.following, true);
  r = await fan.del('/api/artists/1/follow');
  assert.equal(r.data.following, false);

  r = await fan.del(`/api/galleries/${galleryId}`);
  assert.equal(r.status, 403);
  r = await artist.del(`/api/galleries/${galleryId}`);
  assert.equal(r.status, 200);
  r = await artist.get(`/api/artworks/${artworkId}`);
  assert.equal(r.status, 404, 'artwork removed with its gallery');
});

test('client posts a request, artist proposes, client accepts', async () => {
  const cli = client();
  await cli.post('/api/auth/login', { email: 'amara@inkwell.demo', password: DEMO_PASSWORD });
  const art = client();
  await art.post('/api/auth/login', { email: 'priya@inkwell.demo', password: DEMO_PASSWORD });
  const art2 = client();
  await art2.post('/api/auth/login', { email: 'diego@inkwell.demo', password: DEMO_PASSWORD });

  let r = await art.post('/api/requests', { title: 'x', description: 'artists cannot post requests' });
  assert.equal(r.status, 403);

  r = await cli.post('/api/requests', { title: 'Short', description: 'too short' });
  assert.equal(r.status, 400);
  r = await cli.post('/api/requests', { title: 'Budget', description: 'A long enough description here.', budget_min: 500, budget_max: 100 });
  assert.equal(r.status, 400);

  r = await cli.post('/api/requests', {
    title: 'Fine line fern', description: 'A single-needle fern along the inner forearm, about four inches.', style: 'Fine Line', placement: 'Forearm', budget_min: 150, budget_max: 300,
  });
  assert.equal(r.status, 201);
  const requestId = r.data.request.id;
  assert.equal(r.data.request.status, 'open');

  r = await art.post(`/api/requests/${requestId}/proposals`, { message: 'I would love to do this piece for you.', quoted_price: 220, estimated_hours: 1.5 });
  assert.equal(r.status, 201);
  const proposalId = r.data.proposal.id;
  r = await art.post(`/api/requests/${requestId}/proposals`, { message: 'Second proposal should fail.' });
  assert.equal(r.status, 409);
  r = await art2.post(`/api/requests/${requestId}/proposals`, { message: 'Bold lines could work here too.', quoted_price: 200 });
  assert.equal(r.status, 201);
  const proposal2Id = r.data.proposal.id;

  r = await art.get(`/api/requests/${requestId}`);
  assert.equal(r.data.request.proposals.length, 1, 'artists only see their own proposal');
  assert.equal(r.data.request.my_proposal.id, proposalId);
  r = await cli.get(`/api/requests/${requestId}`);
  assert.equal(r.data.request.proposals.length, 2, 'owner sees all proposals');

  r = await art2.post(`/api/requests/proposals/${proposalId}/accept`);
  assert.equal(r.status, 403, 'only the request owner can accept');
  r = await cli.post(`/api/requests/proposals/${proposalId}/accept`);
  assert.equal(r.status, 200);
  assert.equal(r.data.proposal.status, 'accepted');
  assert.equal(r.data.request.status, 'in_progress');

  r = await cli.get(`/api/requests/${requestId}`);
  const second = r.data.request.proposals.find((p) => p.id === proposal2Id);
  assert.equal(second.status, 'declined', 'other proposals auto-declined');

  r = await art2.post(`/api/requests/${requestId}/proposals`, { message: 'Too late for this one now.' });
  assert.equal(r.status, 400, 'no proposals after request leaves open state');

  r = await cli.get('/api/requests?mine=1');
  assert.ok(r.data.requests.some((q) => q.id === requestId));
  r = await art.get('/api/requests?mine=1');
  assert.ok(r.data.requests.some((q) => q.id === requestId));
});

test('availability, slots and the appointment lifecycle', async () => {
  const art = client();
  await art.post('/api/auth/login', { email: 'sofia@inkwell.demo', password: DEMO_PASSWORD });
  const me = (await art.get('/api/auth/me')).data.user;
  const cli = client();
  await cli.post('/api/auth/login', { email: 'lucia@inkwell.demo', password: DEMO_PASSWORD });
  const cli2 = client();
  await cli2.post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD });

  let r = await art.put('/api/artists/me/availability', { availability: [{ weekday: 1, start_time: '18:00', end_time: '10:00' }] });
  assert.equal(r.status, 400);
  r = await art.put('/api/artists/me/availability', { availability: [{ weekday: 1, start_time: '10:00', end_time: '14:00' }] });
  assert.equal(r.status, 200);
  assert.equal(r.data.availability.length, 1);

  const monday = futureDate(2, 1);
  r = await cli.get(`/api/artists/${me.id}/slots?date=${monday}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.length, 2, 'two 120-minute slots in a 4 hour window');
  assert.ok(r.data.slots.every((s) => s.available));
  const slot = r.data.slots[0].starts_at;

  const tuesday = futureDate(2, 2);
  r = await cli.get(`/api/artists/${me.id}/slots?date=${tuesday}`);
  assert.equal(r.data.slots.length, 0, 'no hours published for Tuesday');

  r = await art.post('/api/appointments', { artist_id: me.id, starts_at: slot });
  assert.equal(r.status, 403, 'artists do not book themselves');
  r = await cli.post('/api/appointments', { artist_id: me.id, starts_at: `${monday}T09:00` });
  assert.equal(r.status, 400, 'outside published hours');

  r = await cli.post('/api/appointments', { artist_id: me.id, starts_at: slot, note: 'Koi piece' });
  assert.equal(r.status, 201);
  const apptId = r.data.appointment.id;
  assert.equal(r.data.appointment.status, 'pending');

  r = await cli2.post('/api/appointments', { artist_id: me.id, starts_at: slot });
  assert.equal(r.status, 409, 'double booking is rejected');
  r = await cli.get(`/api/artists/${me.id}/slots?date=${monday}`);
  assert.equal(r.data.slots.find((s) => s.starts_at === slot).available, false);

  r = await cli.post(`/api/appointments/${apptId}/confirm`);
  assert.equal(r.status, 403, 'only the artist confirms');
  r = await cli2.post(`/api/appointments/${apptId}/cancel`);
  assert.equal(r.status, 403, 'strangers cannot touch it');
  r = await art.post(`/api/appointments/${apptId}/complete`);
  assert.equal(r.status, 400, 'cannot complete before confirming');
  r = await art.post(`/api/appointments/${apptId}/confirm`);
  assert.equal(r.data.appointment.status, 'confirmed');
  r = await art.post(`/api/appointments/${apptId}/complete`);
  assert.equal(r.data.appointment.status, 'completed');

  r = await cli.get(`/api/artists/${me.id}/slots?date=${monday}`);
  assert.equal(r.data.slots.find((s) => s.starts_at === slot).available, true, 'completed sessions free the slot');

  r = await cli.get('/api/appointments');
  assert.ok(r.data.appointments.some((a) => a.id === apptId));

  r = await art.put('/api/auth/me', { accepting_clients: false });
  assert.equal(r.data.user.profile.accepting_clients, false);
  r = await cli.post('/api/appointments', { artist_id: me.id, starts_at: slot });
  assert.equal(r.status, 400, 'closed books reject bookings');
});

test('direct messages and unread counts', async () => {
  const a = client();
  await a.post('/api/auth/login', { email: 'tomasz@inkwell.demo', password: DEMO_PASSWORD });
  const b = client();
  await b.post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD });
  const aId = (await a.get('/api/auth/me')).data.user.id;
  const bId = (await b.get('/api/auth/me')).data.user.id;

  const baseline = (await b.get('/api/messages/unread')).data.unread;

  let r = await a.post(`/api/messages/${aId}`, { body: 'talking to myself' });
  assert.equal(r.status, 400);
  r = await a.post(`/api/messages/${bId}`, { body: '' });
  assert.equal(r.status, 400);

  r = await a.post(`/api/messages/${bId}`, { body: 'Hey Ben, saw your request.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.body, 'Hey Ben, saw your request.');
  assert.equal(r.data.message.sender_id, aId);

  r = await b.get('/api/messages/unread');
  assert.equal(r.data.unread, baseline + 1);
  r = await b.get('/api/messages');
  assert.equal(r.data.conversations[0].user_id, aId);
  assert.equal(r.data.conversations[0].unread, 1);

  r = await b.get(`/api/messages/${aId}`);
  assert.equal(r.data.messages.length, 1);
  r = await b.get('/api/messages/unread');
  assert.equal(r.data.unread, baseline, 'opening the thread marks it read');

  r = await b.post(`/api/messages/${aId}`, { body: 'Hi! Yes, still looking.' });
  assert.equal(r.status, 201);
  r = await a.get(`/api/messages/${bId}`);
  assert.equal(r.data.messages.length, 2);
  r = await a.get('/api/messages');
  assert.equal(r.data.conversations.find((c) => c.user_id === bId).last_body, 'Hi! Yes, still looking.');
});

test('profile updates', async () => {
  const c = client();
  await c.post('/api/auth/login', { email: 'yuki@inkwell.demo', password: DEMO_PASSWORD });
  let r = await c.put('/api/auth/me', { name: '', bio: 'x' });
  assert.equal(r.status, 400);
  r = await c.put('/api/auth/me', { name: 'Yuki H.', bio: 'Updated bio', styles: ['Japanese', 'Bogus'], hourly_rate: '250', session_minutes: 15, instagram: '@yuki' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Yuki H.');
  assert.deepEqual(r.data.user.profile.styles, ['Japanese']);
  assert.equal(r.data.user.profile.hourly_rate, 250);
  assert.equal(r.data.user.profile.session_minutes, 30, 'session length is clamped to the minimum');
  assert.equal(r.data.user.profile.instagram, 'yuki');

  r = await client().put('/api/auth/me', { name: 'Anon' });
  assert.equal(r.status, 401);
});

test('SPA fallback serves index.html and unknown API routes 404 as JSON', async () => {
  const res = await fetch(`${base}/artists/3`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>[^<]*Inkwell/);
  const api = await fetch(`${base}/api/nope`);
  assert.equal(api.status, 404);
  assert.equal((await api.json()).error, 'Not found.');
});
