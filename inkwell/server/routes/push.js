'use strict';

const express = require('express');
const { requireAuth } = require('../auth');
const push = require('../push');

const pushRouter = express.Router();
const notificationsRouter = express.Router();

pushRouter.get('/config', (_req, res) => {
  res.json({ web: true, public_key: push.vapidPublicKey, native: push.nativeEnabled() });
});

pushRouter.get('/subscriptions', requireAuth, (req, res) => {
  res.json({ subscriptions: push.subsForUser(req.user.id).map((s) => ({ id: s.id, kind: s.kind, device_name: s.device_name, created_at: s.created_at, last_used_at: s.last_used_at, endpoint: s.kind === 'web' ? s.endpoint : `${s.endpoint.slice(0, 12)}…` })) });
});

/**
 * Web:    { kind: 'web', subscription: PushSubscription.toJSON(), device_name }
 * Native: { kind: 'fcm', token, device_name }
 */
pushRouter.post('/subscribe', requireAuth, (req, res) => {
  const body = req.body || {};
  if (body.kind === 'web') {
    const sub = body.subscription || {};
    const keys = sub.keys || {};
    if (!sub.endpoint || !/^https?:\/\//.test(sub.endpoint) || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid push subscription.' });
    }
    push.subscribe(req.user.id, { kind: 'web', endpoint: String(sub.endpoint).slice(0, 2000), p256dh: String(keys.p256dh), auth: String(keys.auth), device_name: body.device_name });
  } else if (body.kind === 'fcm') {
    if (!body.token || String(body.token).length < 20) return res.status(400).json({ error: 'Invalid device token.' });
    push.subscribe(req.user.id, { kind: 'fcm', endpoint: String(body.token).slice(0, 4096), device_name: body.device_name });
  } else {
    return res.status(400).json({ error: 'kind must be web or fcm.' });
  }
  res.status(201).json({ ok: true, subscriptions: push.subsForUser(req.user.id).length });
});

pushRouter.delete('/subscribe', requireAuth, (req, res) => {
  const endpoint = (req.body || {}).endpoint || (req.body || {}).token;
  if (!endpoint) return res.status(400).json({ error: 'Send the endpoint or token to remove.' });
  res.json({ ok: true, removed: push.unsubscribe(req.user.id, String(endpoint)) });
});

pushRouter.post('/test', requireAuth, async (req, res) => {
  const result = await push.sendToUser(req.user.id, { title: 'Inkwell is set up', body: 'This is what a booking or message alert looks like.', url: '/notifications', tag: 'inkwell-test' });
  res.json(result);
});

notificationsRouter.get('/', requireAuth, (req, res) => {
  res.json({ notifications: push.listNotifications(req.user.id, Number(req.query.limit) || 50), unread: push.unreadCount(req.user.id) });
});

notificationsRouter.get('/unread', requireAuth, (req, res) => {
  res.json({ unread: push.unreadCount(req.user.id) });
});

notificationsRouter.post('/read', requireAuth, (req, res) => {
  const body = req.body || {};
  let changed = 0;
  if (body.all) changed = push.markAllRead(req.user.id);
  else if (Array.isArray(body.ids)) body.ids.forEach((id) => { changed += push.markRead(req.user.id, Number(id)); });
  else if (body.id) changed = push.markRead(req.user.id, Number(body.id));
  res.json({ ok: true, changed, unread: push.unreadCount(req.user.id) });
});

module.exports = { push: pushRouter, notifications: notificationsRouter };
