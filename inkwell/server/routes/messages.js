'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const mailer = require('../mailer');

const router = express.Router();

const conversations = db.prepare(`
  SELECT other.id AS user_id, other.name, other.avatar_url, other.role,
         m.body AS last_body, m.created_at AS last_at, m.sender_id AS last_sender_id,
         (SELECT COUNT(*) FROM messages x WHERE x.sender_id = other.id AND x.recipient_id = @me AND x.read_at IS NULL) AS unread
  FROM messages m
  JOIN users other ON other.id = CASE WHEN m.sender_id = @me THEN m.recipient_id ELSE m.sender_id END
  WHERE m.id IN (
    SELECT MAX(id) FROM messages
    WHERE sender_id = @me OR recipient_id = @me
    GROUP BY CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END
  )
  ORDER BY m.created_at DESC, m.id DESC
`);
const thread = db.prepare(`
  SELECT id, sender_id, recipient_id, body, read_at, created_at FROM messages
  WHERE (sender_id = @me AND recipient_id = @other) OR (sender_id = @other AND recipient_id = @me)
  ORDER BY created_at ASC, id ASC
`);
const markRead = db.prepare(`
  UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
`);
const insertMessage = db.prepare('INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)');
const getUser = db.prepare('SELECT id, name, avatar_url, role, location FROM users WHERE id = ?');
const unreadTotal = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL');
const unreadFrom = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL');

router.get('/', requireAuth, (req, res) => {
  res.json({ conversations: conversations.all({ me: req.user.id }) });
});

router.get('/unread', requireAuth, (req, res) => {
  res.json({ unread: unreadTotal.get(req.user.id).n });
});

router.get('/:userId', requireAuth, (req, res) => {
  const other = getUser.get(req.params.userId);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  markRead.run(other.id, req.user.id);
  res.json({ other, messages: thread.all({ me: req.user.id, other: other.id }) });
});

router.post('/:userId', requireAuth, (req, res) => {
  const other = getUser.get(req.params.userId);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  // Email once per unread burst: if they already have unread messages from us, they were told.
  const alreadyWaiting = unreadFrom.get(req.user.id, other.id).n > 0;
  insertMessage.run(req.user.id, other.id, body.slice(0, 4000));
  if (!alreadyWaiting) mailer.notify(mailer.templates.newMessage(req.user, other.id, body));
  res.status(201).json({ other, messages: thread.all({ me: req.user.id, other: other.id }) });
});

module.exports = router;
