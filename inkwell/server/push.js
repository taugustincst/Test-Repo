'use strict';

/**
 * Notifications for phones: an in-app notification center plus push delivery.
 *
 * - Web Push (VAPID) for the installed PWA on Android, desktop and iOS 16.4+.
 * - Firebase Cloud Messaging (HTTP v1) for the native Capacitor shell on Android and iOS. Firebase
 *   relays to APNs, so one integration covers both stores. Set FCM_SERVICE_ACCOUNT_JSON (the
 *   service account JSON, inline or a file path) to enable it.
 *
 * VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once and kept in
 * app_settings so subscriptions survive restarts.
 */

const fs = require('fs');
const crypto = require('crypto');
const webpush = require('web-push');
const { db } = require('./db');

const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:hello@inkwell.local';
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');

function loadVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const stored = getSetting.get('vapid');
  if (stored) return JSON.parse(stored.value);
  const keys = webpush.generateVAPIDKeys();
  setSetting.run('vapid', JSON.stringify(keys));
  return keys;
}
const vapid = loadVapid();
webpush.setVapidDetails(VAPID_CONTACT, vapid.publicKey, vapid.privateKey);

/* ---------- subscriptions ---------- */

const upsertSub = db.prepare(`
  INSERT INTO push_subscriptions (user_id, kind, endpoint, p256dh, auth, device_name)
  VALUES (@user_id, @kind, @endpoint, @p256dh, @auth, @device_name)
  ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device_name = excluded.device_name
`);
const subsForUser = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC');
const deleteSub = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?');
const deleteSubById = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
const touchSub = db.prepare(`UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE id = ?`);
const userPrefs = db.prepare('SELECT push_notifications FROM users WHERE id = ?');

function subscribe(userId, { kind, endpoint, p256dh = null, auth = null, device_name: deviceName = '' }) {
  upsertSub.run({ user_id: userId, kind, endpoint, p256dh, auth, device_name: String(deviceName || '').slice(0, 120) });
  return subsForUser.all(userId);
}

function unsubscribe(userId, endpoint) {
  return deleteSub.run(endpoint, userId).changes > 0;
}

/* ---------- notification center ---------- */

const insertNotification = db.prepare('INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)');
const listNotifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL');
const markAllRead = db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`);
const markRead = db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id = ? AND read_at IS NULL`);
const trimNotifications = db.prepare(`
  DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
    SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200)
`);

/** Make the URL relative so it opens inside the app regardless of host. */
function relativeUrl(url) {
  if (!url) return null;
  if (url.startsWith(APP_URL)) return url.slice(APP_URL.length) || '/';
  return url.replace(/^https?:\/\/[^/]+/, '') || '/';
}

function record(userId, { title, body, url }) {
  const info = insertNotification.run(userId, String(title).slice(0, 200), String(body || '').slice(0, 500), relativeUrl(url));
  trimNotifications.run(userId, userId);
  return info.lastInsertRowid;
}

/* ---------- senders ---------- */

async function sendWeb(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 24 * 3600, urgency: 'normal' },
    );
    touchSub.run(sub.id);
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) deleteSubById.run(sub.id); // browser dropped the subscription
    else console.error(`[push] web push failed (${err.statusCode || err.message})`);
    return false;
  }
}

/** Firebase Cloud Messaging over HTTP v1 with a service account. `fetchImpl` is injectable for tests. */
function createFcmSender(serviceAccount, fetchImpl = globalThis.fetch, { now = () => Date.now() } = {}) {
  let cached = { token: null, expires: 0 };

  function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  async function accessToken() {
    if (cached.token && cached.expires > now() + 60000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    }));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), serviceAccount.private_key);
    const assertion = `${header}.${claims}.${base64url(signature)}`;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(`FCM auth failed: ${(data.error_description || data.error || res.status)}`);
    cached = { token: data.access_token, expires: now() + (data.expires_in || 3600) * 1000 };
    return cached.token;
  }

  return {
    name: 'fcm',
    /** Returns { ok, gone } where gone means the token is no longer valid and should be dropped. */
    async send(deviceToken, payload) {
      const token = await accessToken();
      const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title: payload.title, body: payload.body },
            data: { url: payload.url || '/' },
            android: { priority: 'high', notification: { click_action: 'OPEN_URL' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
      });
      if (res.ok) return { ok: true, gone: false };
      const data = await res.json().catch(() => ({}));
      const status = data.error && data.error.status;
      const detail = JSON.stringify(data.error && data.error.details || []);
      const gone = res.status === 404 || status === 'NOT_FOUND' || detail.includes('UNREGISTERED');
      return { ok: false, gone, error: (data.error && data.error.message) || `FCM error ${res.status}` };
    },
  };
}

function loadFcm() {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
    const account = JSON.parse(json);
    if (!account.client_email || !account.private_key || !account.project_id) throw new Error('missing fields');
    return createFcmSender(account);
  } catch (err) {
    console.error(`[push] FCM_SERVICE_ACCOUNT_JSON is not usable: ${err.message}`);
    return null;
  }
}
let fcm = loadFcm();

async function sendNative(sub, payload) {
  if (!fcm) return false;
  try {
    const result = await fcm.send(sub.endpoint, payload);
    if (result.ok) { touchSub.run(sub.id); return true; }
    if (result.gone) deleteSubById.run(sub.id);
    else console.error(`[push] FCM failed: ${result.error}`);
    return false;
  } catch (err) {
    console.error(`[push] FCM error: ${err.message}`);
    return false;
  }
}

/** Push a payload to every device the user registered. Returns { sent, failed }. */
async function sendToUser(userId, payload) {
  const subs = subsForUser.all(userId);
  let sent = 0;
  let failed = 0;
  for (const sub of subs) {
    const ok = sub.kind === 'web' ? await sendWeb(sub, payload) : await sendNative(sub, payload);
    if (ok) sent += 1; else failed += 1;
  }
  return { sent, failed };
}

/** Record in the notification center and push if the user opted in. */
async function deliver(userId, { title, body, url }) {
  const notificationId = record(userId, { title, body, url });
  const prefs = userPrefs.get(userId);
  if (!prefs || prefs.push_notifications === 0) return { notificationId, sent: 0, failed: 0, skipped: true };
  const result = await sendToUser(userId, { title, body, url: relativeUrl(url) || '/', tag: `inkwell-${notificationId}` });
  return { notificationId, ...result };
}

module.exports = {
  vapidPublicKey: vapid.publicKey,
  nativeEnabled: () => !!fcm,
  subscribe,
  unsubscribe,
  subsForUser: (userId) => subsForUser.all(userId),
  record,
  deliver,
  sendToUser,
  listNotifications: (userId, limit = 50) => listNotifications.all(userId, Math.min(200, Math.max(1, limit))),
  unreadCount: (userId) => unreadCount.get(userId).n,
  markAllRead: (userId) => markAllRead.run(userId).changes,
  markRead: (userId, id) => markRead.run(userId, id).changes,
  createFcmSender,
  relativeUrl,
  _setFcm: (sender) => { fcm = sender; },
};
