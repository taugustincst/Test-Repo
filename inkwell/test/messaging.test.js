'use strict';

/* Messaging inbox: filters and search, attachments, live stream, receipts, unsend, state, blocking, saved replies. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-msg-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const messaging = require('../server/messaging');
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
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b),
    put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b),
    del: (u) => call('DELETE', u),
    cookie: () => cookie,
  };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, id: r.data.user.id, user: r.data.user };
}

const png = (w = 40, h = 50) => sharp({ create: { width: w, height: h, channels: 3, background: '#2b6cb0' } }).png().toBuffer();

/** Open the SSE stream for a session and collect events until `count` named events arrive. */
function listen(c, wanted, count) {
  const ac = new AbortController();
  const events = [];
  const done = new Promise((resolve, reject) => {
    fetch(`${base}/api/messages/stream`, { headers: { cookie: c.cookie() }, signal: ac.signal }).then(async (res) => {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const reader = res.body.getReader();
      let buf = '';
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const name = (frame.match(/^event: (.+)$/m) || [])[1];
          const data = (frame.match(/^data: (.+)$/m) || [])[1];
          if (name) events.push({ name, data: data ? JSON.parse(data) : null });
          if (events.filter((e) => wanted.includes(e.name)).length >= count) { ac.abort(); resolve(events); return; }
        }
      }
      resolve(events);
    }).catch((err) => { if (err.name === 'AbortError') resolve(events); else reject(err); });
  });
  return { done, stop: () => ac.abort() };
}

before(async () => {
  seed();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  messaging.closeAll();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('inbox: seeded conversations, filters, counts and search', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  let r = await mara.get('/api/messages');
  assert.equal(r.status, 200);
  assert.ok(r.data.conversations.length >= 4, 'Mara has a populated inbox');
  assert.equal(r.data.filter, 'all');
  assert.ok(r.data.conversations.every((x) => !x.archived), 'archived threads stay out of the default list');
  const jordan = r.data.conversations.find((x) => x.name === 'Jordan Lee');
  assert.ok(jordan.starred, 'seeded star');
  assert.equal(jordan.last_sender_id, maraId);
  const hana = r.data.conversations.find((x) => x.name === 'Hana Sato');
  assert.equal(hana.unread, 2);
  assert.equal(r.data.conversations[0].name, 'Hana Sato', 'newest conversation first');
  const sasha = r.data.conversations.find((x) => x.name === 'Sasha Ivanova');
  assert.equal(sasha.last_body, 'That healed beautifully. Thanks for sending it, made my day.');

  r = await mara.get('/api/messages?filter=unread');
  assert.ok(r.data.conversations.length >= 2);
  assert.ok(r.data.conversations.every((x) => x.unread > 0));
  assert.equal(r.data.counts.unread, r.data.conversations.length);
  r = await mara.get('/api/messages?filter=starred');
  assert.deepEqual(r.data.conversations.map((x) => x.name), ['Jordan Lee']);
  r = await mara.get('/api/messages?filter=archived');
  assert.deepEqual(r.data.conversations.map((x) => x.name), ['Noah Williams']);
  assert.equal(r.data.counts.archived, 1);
  r = await mara.get('/api/messages?filter=bogus');
  assert.equal(r.data.filter, 'all');

  r = await mara.get('/api/messages?q=deposit');
  assert.deepEqual(r.data.conversations.map((x) => x.name), ['Elena Rossi'], 'search matches message text');
  r = await mara.get('/api/messages?q=sasha');
  assert.deepEqual(r.data.conversations.map((x) => x.name), ['Sasha Ivanova'], 'search matches names');
  r = await mara.get('/api/messages?q=%25');
  assert.equal(r.data.conversations.length, 0, 'LIKE wildcards are escaped');

  // Thread payload: paging, state and booking context.
  r = await mara.get(`/api/messages/${jordan.user_id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.has_more, false);
  assert.ok(r.data.messages.length >= 6);
  assert.deepEqual(r.data.state, { starred: true, muted: false, archived: false, blocked: false, blocked_by: false });
  assert.ok(r.data.context, 'artist sees booking context for a client');
  assert.ok(r.data.context.open_requests.length >= 1);
  assert.equal(typeof r.data.context.total_paid, 'number');
  const withPhoto = r.data.messages.find((m) => m.attachments.some((a) => a.type === 'image'));
  const withArt = r.data.messages.find((m) => m.attachments.some((a) => a.type === 'artwork'));
  assert.ok(withPhoto && withArt, 'seeded attachments come back parsed');
  const preview = (await mara.get('/api/messages')).data.conversations.find((x) => x.name === 'Jordan Lee');
  assert.ok(preview.last_body.length > 0);

  // Anonymous and clients-vs-artists.
  r = await client().get('/api/messages');
  assert.equal(r.status, 401);
});

test('sending with a photo and a shared tattoo; previews and validation', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: ben, id: benId } = await login('ben@inkwell.demo');

  const fd = new FormData();
  fd.append('body', '');
  fd.append('image', new Blob([await png()], { type: 'image/png' }), 'placement.png');
  let r = await mara.post(`/api/messages/${benId}`, fd);
  assert.equal(r.status, 201);
  assert.equal(r.data.message.body, '');
  assert.equal(r.data.message.attachments.length, 1);
  assert.equal(r.data.message.attachments[0].type, 'image');
  assert.match(r.data.message.attachments[0].url, /^\/uploads\/.+\.webp$/);
  assert.ok(fs.existsSync(path.join(tmp, 'uploads', path.basename(r.data.message.attachments[0].url))));
  const photoId = r.data.message.id;

  r = await ben.get('/api/messages');
  assert.equal(r.data.conversations[0].user_id, maraId);
  assert.equal(r.data.conversations[0].last_body, 'Photo', 'photo-only messages get a preview');

  const art = db.prepare('SELECT id, title FROM artworks WHERE artist_id = ? LIMIT 1').get(maraId);
  r = await mara.post(`/api/messages/${benId}`, { body: 'Something like this?', artwork_id: art.id });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.attachments[0].type, 'artwork');
  assert.equal(r.data.message.attachments[0].title, art.title);

  // Only the artist's own work can be shared; clients cannot share at all.
  const otherArt = db.prepare('SELECT id FROM artworks WHERE artist_id != ? LIMIT 1').get(maraId);
  r = await mara.post(`/api/messages/${benId}`, { body: 'x', artwork_id: otherArt.id });
  assert.equal(r.status, 404);
  r = await ben.post(`/api/messages/${maraId}`, { body: 'x', artwork_id: art.id });
  assert.equal(r.status, 400);

  // Not an image.
  const bad = new FormData();
  bad.append('image', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], { type: 'image/png' }), 'evil.png');
  r = await mara.post(`/api/messages/${benId}`, bad);
  assert.equal(r.status, 400);
  r = await mara.post(`/api/messages/${benId}`, { body: '   ' });
  assert.equal(r.status, 400);

  // Unsend removes the body, the attachment and the file; it only works for the sender and within the window.
  r = await ben.del(`/api/messages/${maraId}/messages/${photoId}`);
  assert.equal(r.status, 404, 'recipient cannot unsend');
  const file = path.join(tmp, 'uploads', path.basename(JSON.parse(db.prepare('SELECT attachments FROM messages WHERE id = ?').get(photoId).attachments)[0].url));
  r = await mara.del(`/api/messages/${benId}/messages/${photoId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.message.deleted, true);
  assert.deepEqual(r.data.message.attachments, []);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(file), false, 'attachment file removed');
  r = await ben.get(`/api/messages/${maraId}`);
  assert.equal(r.data.messages.find((m) => m.id === photoId).deleted, true);
  db.prepare(`UPDATE messages SET created_at = datetime('now', '-20 minutes') WHERE id = ?`).run(r.data.messages[r.data.messages.length - 1].id);
  r = await mara.del(`/api/messages/${benId}/messages/${r.data.messages[r.data.messages.length - 1].id}`);
  assert.equal(r.status, 400, 'window expired');
});

test('live stream delivers new messages and read receipts; opening marks read', async () => {
  const { c: lucia, id: luciaId } = await login('lucia@inkwell.demo');
  const { c: yuki, id: yukiId } = await login('yuki@inkwell.demo');

  const luciaStream = listen(lucia, ['message'], 1);
  const yukiStream = listen(yuki, ['read'], 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(messaging.streamCount(luciaId), 1);

  let r = await yuki.post(`/api/messages/${luciaId}`, { body: 'Your sketch is ready, want to see it?' });
  assert.equal(r.status, 201);
  const events = await luciaStream.done;
  assert.equal(events[0].name, 'hello');
  const msg = events.find((e) => e.name === 'message');
  assert.equal(msg.data.from, yukiId);
  assert.equal(msg.data.message.body, 'Your sketch is ready, want to see it?');
  assert.equal(msg.data.unread, 1);

  // Not read yet on Yuki's side.
  r = await yuki.get(`/api/messages/${luciaId}`);
  assert.equal(r.data.messages[r.data.messages.length - 1].read_at, null);
  // Lucía opens the thread: marked read, and Yuki gets a receipt.
  r = await lucia.get(`/api/messages/${yukiId}`);
  assert.equal(r.data.unread, 0);
  const receipts = await yukiStream.done;
  const read = receipts.find((e) => e.name === 'read');
  assert.equal(read.data.by, luciaId);
  r = await yuki.get(`/api/messages/${luciaId}`);
  assert.ok(r.data.messages[r.data.messages.length - 1].read_at);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messaging.streamCount(luciaId), 0, 'closed streams are detached');

  // Paging before an id.
  r = await lucia.get(`/api/messages/${yukiId}?before=${r.data.messages[0].id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.messages.length, 0);
  assert.equal(r.data.state, undefined, 'pages carry only messages');

  // Mark unread, then mark all read.
  r = await lucia.post(`/api/messages/${yukiId}/unread`);
  assert.equal(r.data.unread, 1);
  r = await lucia.post('/api/messages/read-all');
  assert.equal(r.data.marked >= 1, true);
  r = await lucia.get('/api/messages/unread');
  assert.equal(r.data.unread, 0);
});

test('star, mute and archive; muted threads send no email or push, a reply un-archives', async () => {
  const { c: kwame, id: kwameId } = await login('kwame@inkwell.demo');
  const { c: tomasz, id: tomaszId } = await login('tomasz@inkwell.demo');

  let r = await tomasz.patch(`/api/messages/${kwameId}`, { starred: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.state.starred, true);
  r = await tomasz.patch(`/api/messages/${kwameId}`, { muted: true });
  assert.deepEqual([r.data.state.starred, r.data.state.muted], [true, true], 'patch keeps other flags');

  const emailsBefore = db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(tomaszId).n;
  const notifsBefore = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(tomaszId).n;
  r = await kwame.post(`/api/messages/${tomaszId}`, { body: 'Can we do Friday instead?' });
  assert.equal(r.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(tomaszId).n, emailsBefore, 'muted: no email');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(tomaszId).n, notifsBefore, 'muted: no notification');
  r = await tomasz.get('/api/messages/unread');
  assert.equal(r.data.unread, 0, 'muted conversations do not count toward the badge');
  r = await tomasz.get('/api/messages');
  assert.equal(r.data.conversations.find((x) => x.user_id === kwameId).unread, 1, 'but the thread itself shows unread');

  r = await tomasz.patch(`/api/messages/${kwameId}`, { muted: false, archived: true });
  assert.equal(r.data.state.archived, true);
  r = await tomasz.get('/api/messages');
  assert.equal(r.data.conversations.some((x) => x.user_id === kwameId), false);
  r = await tomasz.get('/api/messages?filter=archived');
  assert.equal(r.data.conversations.some((x) => x.user_id === kwameId), true);

  r = await kwame.post(`/api/messages/${tomaszId}`, { body: 'Friday it is?' });
  assert.equal(r.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE to_user_id = ?').get(tomaszId).n, emailsBefore + 1, 'unmuted: one email for the burst');
  r = await tomasz.get('/api/messages');
  assert.equal(r.data.conversations.some((x) => x.user_id === kwameId), true, 'a new message brings the thread back');
  assert.equal(r.data.conversations.find((x) => x.user_id === kwameId).archived, false);
});

test('blocking stops messages both ways; suspended users cannot message', async () => {
  const { c: ines, id: inesId } = await login('ines@inkwell.demo');
  const { c: diego, id: diegoId } = await login('diego@inkwell.demo');

  let r = await ines.post(`/api/messages/${diegoId}/block`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.state.blocked, r.data.state.blocked_by], [true, false]);
  r = await diego.get(`/api/messages/${inesId}`);
  assert.equal(r.data.state.blocked_by, true);
  r = await diego.post(`/api/messages/${inesId}`, { body: 'hello?' });
  assert.equal(r.status, 403);
  assert.equal(r.data.blocked_by, true);
  r = await ines.post(`/api/messages/${diegoId}`, { body: 'hello?' });
  assert.equal(r.status, 403);
  assert.equal(r.data.blocked, true);
  r = await ines.del(`/api/messages/${diegoId}/block`);
  assert.equal(r.data.state.blocked, false);
  r = await diego.post(`/api/messages/${inesId}`, { body: 'hello again' });
  assert.equal(r.status, 201);

  r = await ines.post(`/api/messages/${inesId}`, { body: 'me' });
  assert.equal(r.status, 400);
  r = await ines.post('/api/messages/999999', { body: 'ghost' });
  assert.equal(r.status, 404);

  db.prepare(`UPDATE users SET suspended_at = datetime('now') WHERE id = ?`).run(diegoId);
  r = await diego.post(`/api/messages/${inesId}`, { body: 'still here' });
  assert.equal(r.status, 403);
  r = await ines.post(`/api/messages/${diegoId}`, { body: 'are you there' });
  assert.equal(r.status, 403, 'nobody can message a suspended account');
  db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(diegoId);
});

test('saved replies: seeded, CRUD, validation and limits', async () => {
  const { c: sofia } = await login('sofia@inkwell.demo');
  let r = await sofia.get('/api/messages/saved-replies');
  assert.equal(r.status, 200);
  assert.equal(r.data.replies.length, 3);
  assert.deepEqual(r.data.variables, ['first_name', 'name', 'studio', 'deposit']);

  r = await sofia.post('/api/messages/saved-replies', { title: 'Consult', body: 'Hi {first_name}, consults are free and take 20 minutes.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.replies.length, 4);
  const id = r.data.replies[3].id;
  r = await sofia.put(`/api/messages/saved-replies/${id}`, { title: 'Consultation', body: 'Updated' });
  assert.equal(r.data.replies.find((x) => x.id === id).title, 'Consultation');
  r = await sofia.post('/api/messages/saved-replies', { title: '', body: 'x' });
  assert.equal(r.status, 400);
  r = await sofia.put('/api/messages/saved-replies/999999', { title: 'a', body: 'b' });
  assert.equal(r.status, 404);

  // Other users cannot touch them.
  const { c: hana } = await login('hana@inkwell.demo');
  r = await hana.del(`/api/messages/saved-replies/${id}`);
  assert.equal(r.status, 200);
  r = await sofia.get('/api/messages/saved-replies');
  assert.equal(r.data.replies.some((x) => x.id === id), true, 'delete is scoped to the owner');
  r = await sofia.del(`/api/messages/saved-replies/${id}`);
  assert.equal(r.data.replies.length, 3);

  for (let i = 0; i < 27; i += 1) await sofia.post('/api/messages/saved-replies', { title: `r${i}`, body: 'b' });
  r = await sofia.post('/api/messages/saved-replies', { title: 'one too many', body: 'b' });
  assert.equal(r.status, 400);
});

test('artist profiles show how fast they usually reply', async () => {
  const anon = client();
  const mara = db.prepare("SELECT id FROM users WHERE email = 'mara@inkwell.demo'").get().id;
  let r = await anon.get(`/api/artists/${mara}`);
  assert.equal(r.data.artist.replies_within, 'Usually replies within a few hours');
  const sofia = db.prepare("SELECT id FROM users WHERE email = 'sofia@inkwell.demo'").get().id;
  r = await anon.get(`/api/artists/${sofia}`);
  assert.equal(r.data.artist.replies_within, null, 'no label without enough answered conversations');
  assert.equal(messaging.replyLabel(600), 'Usually replies within an hour');
  assert.equal(messaging.replyLabel(20 * 3600), 'Usually replies within a day');
  assert.equal(messaging.replyLabel(4 * 86400), 'Usually replies within a week');
});
