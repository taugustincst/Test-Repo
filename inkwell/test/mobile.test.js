'use strict';

/* Mobile support: bearer tokens, CORS for the native shell, web push, FCM, notification center, PWA assets. */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const express = require('express');
const selfsigned = require('selfsigned');

// Push services are always HTTPS and web-push refuses plain http, so the stand-in below runs TLS
// with a throwaway certificate. Only this test process trusts it.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-mobile-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'https://app.example.test';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FCM_SERVICE_ACCOUNT_JSON;

const { createApp } = require('../server/index');
const { seed, DEMO_PASSWORD } = require('../server/seed');
const { db } = require('../server/db');
const push = require('../server/push');

let server; let base;
let pushEndpoint; let pushBase;
const received = [];
let pushStatus = 201;

function client() {
  let cookie = '';
  let bearer = null;
  async function call(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (bearer) init.headers.authorization = `Bearer ${bearer}`;
    else if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set && !bearer) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, h) => call('GET', u, undefined, h), post: (u, b, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b),
    options: (u, h) => call('OPTIONS', u, undefined, h),
    useBearer: (t) => { bearer = t; cookie = ''; },
  };
}
async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200);
  return { c, user: r.data.user };
}

/** Browser-side keys for a web push subscription: an ECDH P-256 key pair and a 16-byte auth secret. */
function fakeBrowserSubscription(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

before(async () => {
  seed();
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  // A stand-in for a browser push service that records what the server sends.
  const fake = express();
  // Read the body by hand: body-parser rejects the aes128gcm content encoding real push payloads use.
  fake.post('/push/:id', (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ id: req.params.id, headers: req.headers, size: Buffer.concat(chunks).length });
      res.status(pushStatus).end();
    });
  });
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], { days: 1, keySize: 2048 });
  pushEndpoint = https.createServer({ key: pems.private, cert: pems.cert }, fake);
  await new Promise((resolve) => { pushEndpoint.listen(0, resolve); });
  pushBase = `https://127.0.0.1:${pushEndpoint.address().port}`;
});
after(() => { server.close(); pushEndpoint.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('native clients get a bearer token and can use it instead of cookies', async () => {
  const c = client();
  let r = await c.post('/api/auth/login', { email: 'jordan@inkwell.demo', password: DEMO_PASSWORD });
  assert.equal(r.data.token, undefined, 'web clients do not receive the token in the body');

  const native = client();
  r = await native.post('/api/auth/login', { email: 'jordan@inkwell.demo', password: DEMO_PASSWORD }, { 'x-inkwell-client': 'native' });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^[a-f0-9]{64}$/);
  const token = r.data.token;

  const bearerOnly = client();
  bearerOnly.useBearer(token);
  r = await bearerOnly.get('/api/auth/me');
  assert.equal(r.data.user.email, 'jordan@inkwell.demo', 'bearer token authenticates without a cookie');
  r = await bearerOnly.get('/api/appointments');
  assert.equal(r.status, 200);

  const bad = client();
  bad.useBearer('deadbeef');
  r = await bad.get('/api/auth/me');
  assert.equal(r.data.user, null);

  r = await bearerOnly.post('/api/auth/logout');
  assert.equal(r.status, 200);
  r = await bearerOnly.get('/api/auth/me');
  assert.equal(r.data.user, null, 'logout revokes the bearer session');

  r = await client().post('/api/auth/register', { email: 'native@example.com', password: 'nativepass1', name: 'Native User', role: 'client', accept_terms: true }, { 'x-inkwell-client': 'native' });
  assert.equal(r.status, 201);
  assert.ok(r.data.token);
});

test('CORS for the app shell origins only', async () => {
  const c = client();
  let r = await c.options('/api/auth/login', { origin: 'capacitor://localhost', 'access-control-request-method': 'POST' });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
  assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);

  r = await c.post('/api/auth/login', { email: 'ben@inkwell.demo', password: DEMO_PASSWORD }, { origin: 'capacitor://localhost' });
  assert.equal(r.status, 200, 'origin check accepts the shell');
  assert.equal(r.headers.get('access-control-allow-origin'), 'capacitor://localhost');

  r = await c.get('/api/artists', { origin: 'https://app.example.test' });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example.test', 'CORS_ORIGINS entries are honoured');

  r = await c.options('/api/auth/login', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
  assert.notEqual(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('web push: subscribe, deliver on events, test send, unsubscribe, dead endpoints pruned', async () => {
  const { c: cli, user: lucia } = await login('lucia@inkwell.demo');
  const { c: artist, user: sofia } = await login('sofia@inkwell.demo');

  let r = await cli.get('/api/push/config');
  assert.equal(r.data.web, true);
  assert.equal(r.data.public_key.length, 87);
  assert.equal(r.data.native, false);

  r = await cli.post('/api/push/subscribe', { kind: 'web', subscription: { endpoint: 'not a url' } });
  assert.equal(r.status, 400);
  const sub = fakeBrowserSubscription(`${pushBase}/push/lucia-phone`);
  r = await cli.post('/api/push/subscribe', { kind: 'web', subscription: sub, device_name: 'Pixel' });
  assert.equal(r.status, 201);
  assert.equal(r.data.subscriptions, 1);
  r = await cli.post('/api/push/subscribe', { kind: 'web', subscription: sub, device_name: 'Pixel again' });
  assert.equal(r.data.subscriptions, 1, 'same endpoint is upserted, not duplicated');

  received.length = 0;
  r = await cli.post('/api/push/test');
  assert.deepEqual(r.data, { sent: 1, failed: 0 });
  assert.equal(received.length, 1);
  assert.equal(received[0].headers['content-encoding'], 'aes128gcm', 'payload is encrypted for the browser');
  assert.equal(received[0].headers.ttl, '86400');
  assert.match(received[0].headers.authorization, /^vapid t=/);
  assert.ok(received[0].size > 50);

  // A real event: the artist messages Lucía. She gets an email, an in-app notification and a push.
  received.length = 0;
  r = await artist.post(`/api/messages/${lucia.id}`, { body: 'Sketch is ready when you are.' });
  assert.equal(r.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, 1, 'push delivered for the message');
  r = await cli.get('/api/notifications');
  assert.ok(r.data.unread >= 1);
  const note = r.data.notifications.find((n) => n.title.includes('sent you a message'));
  assert.ok(note);
  assert.equal(note.url, `/messages/${sofia.id}`, 'urls are stored relative so they open in-app');

  // Preference off: notification center still records, push is skipped.
  await cli.put('/api/auth/me', { push_notifications: false });
  received.length = 0;
  const before = (await cli.get('/api/notifications')).data.notifications.length;
  await artist.post(`/api/messages/${lucia.id}`, { body: 'Second message' });
  await cli.get(`/api/messages/${sofia.id}`); // read so the next one emails again
  await artist.post(`/api/messages/${lucia.id}`, { body: 'Third message' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(received.length, 0, 'no push while the preference is off');
  assert.ok((await cli.get('/api/notifications')).data.notifications.length > before, 'notification center still records');
  await cli.put('/api/auth/me', { push_notifications: true });

  // Push service says the subscription is gone: it is removed automatically.
  pushStatus = 410;
  r = await cli.post('/api/push/test');
  assert.deepEqual(r.data, { sent: 0, failed: 1 });
  pushStatus = 201;
  r = await cli.get('/api/push/subscriptions');
  assert.equal(r.data.subscriptions.length, 0, 'dead endpoint pruned');

  r = await cli.post('/api/push/subscribe', { kind: 'web', subscription: fakeBrowserSubscription(`${pushBase}/push/lucia-laptop`) });
  r = await cli.del('/api/push/subscribe', { endpoint: `${pushBase}/push/lucia-laptop` });
  assert.equal(r.data.removed, true);
  r = await cli.get('/api/push/subscriptions');
  assert.equal(r.data.subscriptions.length, 0);
});

test('notification center: list, unread, mark read', async () => {
  const { c, user } = await login('mara@inkwell.demo');
  push.record(user.id, { title: 'One', body: 'first', url: `${process.env.APP_URL || 'http://localhost:3000'}/appointments` });
  push.record(user.id, { title: 'Two', body: 'second', url: 'https://other.example/artists/1' });
  let r = await c.get('/api/notifications?limit=10');
  assert.ok(r.data.unread >= 2);
  const [latest] = r.data.notifications;
  assert.equal(latest.title, 'Two');
  assert.equal(latest.url, '/artists/1');
  r = await c.post('/api/notifications/read', { id: latest.id });
  assert.equal(r.data.changed, 1);
  r = await c.get('/api/notifications/unread');
  const remaining = r.data.unread;
  r = await c.post('/api/notifications/read', { all: true });
  assert.equal(r.data.changed, remaining);
  assert.equal(r.data.unread, 0);
  assert.equal((await client().get('/api/notifications')).status, 401);
});

test('native device tokens and Firebase delivery', async () => {
  const { c, user } = await login('diego@inkwell.demo');
  let r = await c.post('/api/push/subscribe', { kind: 'fcm', token: 'short' });
  assert.equal(r.status, 400);
  r = await c.post('/api/push/subscribe', { kind: 'fcm', token: 'fcm-device-token-abcdefghijklmnopqrstuvwxyz', device_name: 'android' });
  assert.equal(r.status, 201);

  // Without Firebase configured the token is stored but nothing is sent.
  r = await c.post('/api/push/test');
  assert.deepEqual(r.data, { sent: 0, failed: 1 });

  // Plug in a fake Firebase: OAuth token exchange, then messages:send.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { project_id: 'inkwell-test', client_email: 'svc@inkwell-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  let nextSendStatus = 200;
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(init.body);
      const [header, claims] = params.get('assertion').split('.');
      assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
      assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, account.client_email);
      return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.fake', expires_in: 3600 }) };
    }
    if (nextSendStatus === 200) return { ok: true, status: 200, json: async () => ({ name: 'projects/inkwell-test/messages/1' }) };
    return { ok: false, status: nextSendStatus, json: async () => ({ error: { status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ errorCode: 'UNREGISTERED' }] } }) };
  };
  push._setFcm(push.createFcmSender(account, fakeFetch));
  try {
    r = await c.post('/api/push/test');
    assert.deepEqual(r.data, { sent: 1, failed: 0 });
    const send = calls.find((x) => x.url.includes('messages:send'));
    assert.ok(send);
    assert.equal(send.init.headers.Authorization, 'Bearer ya29.fake');
    const message = JSON.parse(send.init.body).message;
    assert.equal(message.token, 'fcm-device-token-abcdefghijklmnopqrstuvwxyz');
    assert.equal(message.data.url, '/notifications');
    assert.equal(message.notification.title, 'Inkwell is set up');

    const tokenCalls = calls.filter((x) => x.url.includes('oauth2')).length;
    await c.post('/api/push/test');
    assert.equal(calls.filter((x) => x.url.includes('oauth2')).length, tokenCalls, 'access token is cached');

    nextSendStatus = 404;
    r = await c.post('/api/push/test');
    assert.deepEqual(r.data, { sent: 0, failed: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(user.id).n, 0, 'unregistered device removed');
  } finally {
    push._setFcm(null);
  }
});

test('PWA assets: service worker, manifest, offline page, deep-link files', async () => {
  const sw = await fetch(`${base}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(sw.headers.get('cache-control'), /no-cache/);
  const swText = await sw.text();
  assert.doesNotMatch(swText, /__VERSION__/, 'version placeholder is filled in');
  assert.match(swText, /addEventListener\('push'/);
  assert.match(swText, /notificationclick/);

  const manifest = await (await fetch(`${base}/manifest.json`)).json();
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  assert.ok(manifest.shortcuts.length >= 2);

  const offline = await fetch(`${base}/offline.html`);
  assert.equal(offline.status, 200);
  assert.match(await offline.text(), /offline/i);

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="tabbar"/);

  assert.equal((await fetch(`${base}/.well-known/assetlinks.json`)).status, 404, 'unconfigured deep links are not served');
  process.env.ANDROID_PACKAGE = 'com.inkwell.app';
  process.env.ANDROID_CERT_SHA256 = 'AA:BB';
  const links = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
  assert.equal(links[0].target.package_name, 'com.inkwell.app');
  delete process.env.ANDROID_PACKAGE;
  delete process.env.ANDROID_CERT_SHA256;
});
