'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const mailer = require('../mailer');
const messaging = require('../messaging');
const { upload, removeByUrl } = require('../upload');
const { processArtwork } = require('../images');

const router = express.Router();

const FILTERS = ['all', 'unread', 'starred', 'archived'];
const PAGE = 50;
const UNSEND_MINUTES = 15;
const MAX_BODY = 4000;
const MAX_SAVED_REPLIES = 30;

/* ---------- queries ---------- */

const conversationsSql = (extraWhere) => db.prepare(`
  SELECT other.id AS user_id, other.name, other.avatar_url, other.role, other.location, other.suspended_at,
         m.id AS last_id, m.body AS last_body, m.attachments AS last_attachments, m.deleted_at AS last_deleted_at,
         m.created_at AS last_at, m.sender_id AS last_sender_id,
         (SELECT COUNT(*) FROM messages x WHERE x.sender_id = other.id AND x.recipient_id = @me AND x.read_at IS NULL) AS unread,
         COALESCE(cs.starred, 0) AS starred, COALESCE(cs.muted, 0) AS muted, cs.archived_at,
         (SELECT 1 FROM blocks b WHERE b.blocker_id = @me AND b.blocked_id = other.id) AS blocked
  FROM messages m
  JOIN users other ON other.id = CASE WHEN m.sender_id = @me THEN m.recipient_id ELSE m.sender_id END
  LEFT JOIN conversation_state cs ON cs.user_id = @me AND cs.other_id = other.id
  WHERE m.id IN (
    SELECT MAX(id) FROM messages
    WHERE sender_id = @me OR recipient_id = @me
    GROUP BY CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END
  ) ${extraWhere}
  ORDER BY m.created_at DESC, m.id DESC
`);
const conversationsAll = conversationsSql('');
const conversationsSearch = conversationsSql(`
  AND (other.name LIKE @q ESCAPE '\\' OR EXISTS (
    SELECT 1 FROM messages s WHERE ((s.sender_id = @me AND s.recipient_id = other.id) OR (s.sender_id = other.id AND s.recipient_id = @me))
      AND s.deleted_at IS NULL AND s.body LIKE @q ESCAPE '\\'
  ))`);

const threadPage = db.prepare(`
  SELECT id, sender_id, recipient_id, body, attachments, read_at, deleted_at, created_at FROM messages
  WHERE ((sender_id = @me AND recipient_id = @other) OR (sender_id = @other AND recipient_id = @me)) AND id < @before
  ORDER BY id DESC LIMIT @limit
`);
const messageById = db.prepare('SELECT * FROM messages WHERE id = ?');
const markRead = db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`);
const markAllRead = db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE recipient_id = ? AND read_at IS NULL`);
const lastIncoming = db.prepare('SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? ORDER BY id DESC LIMIT 1');
const markUnread = db.prepare('UPDATE messages SET read_at = NULL WHERE id = ?');
const insertMessage = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, attachments) VALUES (?, ?, ?, ?)');
const unsendMessage = db.prepare(`UPDATE messages SET body = '', attachments = NULL, deleted_at = datetime('now') WHERE id = ?`);
const getUser = db.prepare('SELECT id, name, avatar_url, role, location, suspended_at FROM users WHERE id = ?');
const unreadTotal = db.prepare(`
  SELECT COUNT(*) AS n FROM messages m
  LEFT JOIN conversation_state cs ON cs.user_id = m.recipient_id AND cs.other_id = m.sender_id
  WHERE m.recipient_id = ? AND m.read_at IS NULL AND COALESCE(cs.muted, 0) = 0
`);
const stillWaitingSince = db.prepare('SELECT 1 FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL AND id <= ? LIMIT 1');
const getState = db.prepare('SELECT starred, muted, archived_at, notified_id FROM conversation_state WHERE user_id = ? AND other_id = ?');
const rememberNotified = db.prepare(`
  INSERT INTO conversation_state (user_id, other_id, notified_id) VALUES (?, ?, ?)
  ON CONFLICT(user_id, other_id) DO UPDATE SET notified_id = excluded.notified_id
`);
const upsertState = db.prepare(`
  INSERT INTO conversation_state (user_id, other_id, starred, muted, archived_at) VALUES (@me, @other, @starred, @muted, @archived_at)
  ON CONFLICT(user_id, other_id) DO UPDATE SET starred = excluded.starred, muted = excluded.muted, archived_at = excluded.archived_at
`);
const unarchive = db.prepare('UPDATE conversation_state SET archived_at = NULL WHERE user_id = ? AND other_id = ?');
const isBlocked = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const insertBlock = db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)');
const deleteBlock = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
const artworkForShare = db.prepare('SELECT id, title, image_url, thumb_url, style FROM artworks WHERE id = ? AND artist_id = ?');
const collectionForShare = db.prepare(`
  SELECT c.id, c.title, c.token, (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count,
         (SELECT COALESCE(a.thumb_url, a.image_url) FROM collection_items ci JOIN artworks a ON a.id = ci.artwork_id WHERE ci.collection_id = c.id ORDER BY ci.created_at DESC LIMIT 1) AS cover_url
  FROM collections c WHERE c.id = ? AND c.user_id = ?
`);
const publishCollection = db.prepare(`UPDATE collections SET is_public = 1, updated_at = datetime('now') WHERE id = ?`);
const listReplies = db.prepare('SELECT id, title, body, created_at FROM saved_replies WHERE user_id = ? ORDER BY created_at ASC, id ASC');
const countReplies = db.prepare('SELECT COUNT(*) AS n FROM saved_replies WHERE user_id = ?');
const insertReply = db.prepare('INSERT INTO saved_replies (user_id, title, body) VALUES (?, ?, ?)');
const updateReply = db.prepare('UPDATE saved_replies SET title = ?, body = ? WHERE id = ? AND user_id = ?');
const deleteReply = db.prepare('DELETE FROM saved_replies WHERE id = ? AND user_id = ?');
const artistProfileBits = db.prepare('SELECT studio_name, deposit_amount FROM artist_profiles WHERE user_id = ?');

/* ---------- shaping ---------- */

function shapeConversation(row, meId) {
  return {
    user_id: row.user_id,
    name: row.name,
    avatar_url: row.avatar_url,
    role: row.role,
    location: row.location,
    suspended: !!row.suspended_at,
    last_id: row.last_id,
    last_body: messaging.preview({ body: row.last_body, attachments: row.last_attachments, deleted_at: row.last_deleted_at }),
    last_at: row.last_at,
    last_sender_id: row.last_sender_id,
    unread: row.unread,
    starred: !!row.starred,
    muted: !!row.muted,
    archived: !!row.archived_at,
    blocked: !!row.blocked,
    mine: row.last_sender_id === meId,
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    body: row.deleted_at ? '' : row.body,
    attachments: row.deleted_at ? [] : messaging.parseAttachments(row.attachments),
    read_at: row.read_at,
    deleted: !!row.deleted_at,
    created_at: row.created_at,
  };
}

function loadThread(meId, otherId, before) {
  const rows = threadPage.all({ me: meId, other: otherId, before: before || Number.MAX_SAFE_INTEGER, limit: PAGE + 1 });
  const hasMore = rows.length > PAGE;
  return { messages: rows.slice(0, PAGE).reverse().map(shapeMessage), has_more: hasMore };
}

function stateFor(meId, otherId) {
  const s = getState.get(meId, otherId) || {};
  return {
    starred: !!s.starred,
    muted: !!s.muted,
    archived: !!s.archived_at,
    blocked: !!isBlocked.get(meId, otherId),
    blocked_by: !!isBlocked.get(otherId, meId),
  };
}

function shapeOther(other) {
  const out = { id: other.id, name: other.name, avatar_url: other.avatar_url, role: other.role, location: other.location, suspended: !!other.suspended_at };
  if (other.role === 'artist') {
    const bits = artistProfileBits.get(other.id) || {};
    out.studio_name = bits.studio_name || '';
    out.deposit_amount = bits.deposit_amount || 0;
    out.replies_within = messaging.replyLabel(messaging.replyTime(other.id));
  }
  return out;
}

function lookupOther(req, res) {
  const other = getUser.get(req.params.userId);
  if (!other) { res.status(404).json({ error: 'User not found.' }); return null; }
  if (other.id === req.user.id) { res.status(400).json({ error: 'You cannot message yourself.' }); return null; }
  return other;
}

function notifyRecipient(sender, other, message) {
  const state = getState.get(other.id, sender.id) || {};
  // Live update for anyone with the inbox open, whatever their notification settings.
  messaging.emit(other.id, 'message', { from: sender.id, message, unread: unreadTotal.get(other.id).n });
  messaging.emit(sender.id, 'sent', { to: other.id, message });
  if (state.muted) return;
  // Email/push once per unread burst: skip if we already told them about a message they have not read yet.
  const alreadyWaiting = state.notified_id && stillWaitingSince.get(sender.id, other.id, state.notified_id);
  if (alreadyWaiting) return;
  rememberNotified.run(other.id, sender.id, message.id);
  mailer.notify(mailer.templates.newMessage(sender, other.id, message.body || messaging.preview({ attachments: JSON.stringify(message.attachments) })));
}

/* ---------- inbox ---------- */

router.use(requireAuth);

router.get('/', (req, res) => {
  const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
  const q = String(req.query.q || '').trim().slice(0, 100);
  const params = { me: req.user.id };
  let rows;
  if (q) { params.q = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`; rows = conversationsSearch.all(params); } else rows = conversationsAll.all(params);
  const all = rows.map((r) => shapeConversation(r, req.user.id));
  const counts = {
    all: all.filter((c) => !c.archived).length,
    unread: all.filter((c) => c.unread > 0 && !c.archived).length,
    starred: all.filter((c) => c.starred && !c.archived).length,
    archived: all.filter((c) => c.archived).length,
  };
  const conversations = all.filter((c) => {
    if (filter === 'archived') return c.archived;
    if (c.archived) return false;
    if (filter === 'unread') return c.unread > 0;
    if (filter === 'starred') return c.starred;
    return true;
  });
  res.json({ conversations, counts, filter, q });
});

router.get('/unread', (req, res) => {
  res.json({ unread: unreadTotal.get(req.user.id).n });
});

router.post('/read-all', (req, res) => {
  const info = markAllRead.run(req.user.id);
  res.json({ ok: true, marked: info.changes, unread: 0 });
});

/** Server-sent events: new messages, sent confirmations and read receipts for the signed-in user. */
router.get('/stream', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ unread: unreadTotal.get(req.user.id).n })}\n\n`);
  const detach = messaging.subscribe(req.user.id, res);
  req.on('close', detach);
});

/* ---------- saved replies ---------- */

function validReply(body) {
  const title = String((body || {}).title || '').trim().slice(0, 60);
  const text = String((body || {}).body || '').trim().slice(0, MAX_BODY);
  if (!title) return { error: 'Give the reply a short title.' };
  if (!text) return { error: 'Write the reply text.' };
  return { title, body: text };
}

router.get('/saved-replies', (req, res) => {
  res.json({ replies: listReplies.all(req.user.id), variables: ['first_name', 'name', 'studio', 'deposit'] });
});

router.post('/saved-replies', (req, res) => {
  const v = validReply(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (countReplies.get(req.user.id).n >= MAX_SAVED_REPLIES) return res.status(400).json({ error: `You can keep up to ${MAX_SAVED_REPLIES} saved replies.` });
  insertReply.run(req.user.id, v.title, v.body);
  res.status(201).json({ replies: listReplies.all(req.user.id) });
});

router.put('/saved-replies/:id', (req, res) => {
  const v = validReply(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const info = updateReply.run(v.title, v.body, req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Saved reply not found.' });
  res.json({ replies: listReplies.all(req.user.id) });
});

router.delete('/saved-replies/:id', (req, res) => {
  deleteReply.run(req.params.id, req.user.id);
  res.json({ replies: listReplies.all(req.user.id) });
});

/* ---------- threads ---------- */

router.get('/:userId', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  const before = Number(req.query.before) || null;
  if (!before) {
    const info = markRead.run(other.id, req.user.id);
    if (info.changes) messaging.emit(other.id, 'read', { by: req.user.id, at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  }
  const page = loadThread(req.user.id, other.id, before);
  const payload = { other: shapeOther(other), messages: page.messages, has_more: page.has_more };
  if (!before) {
    payload.state = stateFor(req.user.id, other.id);
    const artistId = req.user.role === 'artist' ? req.user.id : other.role === 'artist' ? other.id : null;
    const clientId = artistId === req.user.id ? other.id : req.user.id;
    payload.context = artistId && other.role !== req.user.role ? messaging.context(artistId, clientId) : null;
    payload.unread = unreadTotal.get(req.user.id).n;
  }
  res.json(payload);
});

router.post('/:userId', upload.single('image'), async (req, res) => {
  const cleanup = () => { if (req.file) removeByUrl(`/uploads/${req.file.filename}`); };
  const other = lookupOther(req, res);
  if (!other) return cleanup();
  if (other.suspended_at) { cleanup(); return res.status(403).json({ error: 'This account is no longer active.' }); }
  if (isBlocked.get(req.user.id, other.id)) { cleanup(); return res.status(403).json({ error: 'Unblock this person to message them.', blocked: true }); }
  if (isBlocked.get(other.id, req.user.id)) { cleanup(); return res.status(403).json({ error: 'You cannot message this person.', blocked_by: true }); }

  const body = String((req.body || {}).body || '').trim().slice(0, MAX_BODY);
  const attachments = [];
  if (req.file) {
    let image;
    try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
    attachments.push({ type: 'image', url: image.url, thumb_url: image.thumb_url, width: image.width, height: image.height });
  }
  const artworkId = Number((req.body || {}).artwork_id);
  if (artworkId) {
    if (req.user.role !== 'artist') { cleanup(); return res.status(400).json({ error: 'Only artists can share their tattoos.' }); }
    const art = artworkForShare.get(artworkId, req.user.id);
    if (!art) { cleanup(); return res.status(404).json({ error: 'That tattoo is not in your galleries.' }); }
    attachments.push({ type: 'artwork', id: art.id, title: art.title, style: art.style, thumb_url: art.thumb_url || art.image_url });
  }
  const collectionId = Number((req.body || {}).collection_id);
  if (collectionId) {
    const board = collectionForShare.get(collectionId, req.user.id);
    if (!board) { cleanup(); return res.status(404).json({ error: 'That board is not yours or no longer exists.' }); }
    publishCollection.run(board.id); // sharing by message makes the board viewable by link
    attachments.push({ type: 'collection', id: board.id, token: board.token, title: board.title, item_count: board.item_count, thumb_url: board.cover_url });
  }
  if (!body && !attachments.length) return res.status(400).json({ error: 'Write a message first.' });

  const info = insertMessage.run(req.user.id, other.id, body, attachments.length ? JSON.stringify(attachments) : null);
  const message = shapeMessage(messageById.get(info.lastInsertRowid));
  // Sending brings an archived conversation back to the inbox for both sides.
  unarchive.run(req.user.id, other.id);
  unarchive.run(other.id, req.user.id);
  notifyRecipient(req.user, other, message);
  res.status(201).json({ message, other: shapeOther(other) });
});

router.delete('/:userId/messages/:id', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  const row = messageById.get(req.params.id);
  if (!row || row.sender_id !== req.user.id || row.recipient_id !== other.id) return res.status(404).json({ error: 'Message not found.' });
  if (row.deleted_at) return res.json({ message: shapeMessage(row) });
  const age = Date.now() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
  if (age > UNSEND_MINUTES * 60000) return res.status(400).json({ error: `Messages can only be unsent within ${UNSEND_MINUTES} minutes.` });
  messaging.parseAttachments(row.attachments).forEach((a) => { if (a.type === 'image') removeByUrl(a.url); });
  unsendMessage.run(row.id);
  const message = shapeMessage(messageById.get(row.id));
  messaging.emit(other.id, 'unsent', { from: req.user.id, message });
  res.json({ message });
});

router.post('/:userId/read', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  const info = markRead.run(other.id, req.user.id);
  if (info.changes) messaging.emit(other.id, 'read', { by: req.user.id, at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  res.json({ ok: true, unread: unreadTotal.get(req.user.id).n });
});

router.post('/:userId/unread', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  const last = lastIncoming.get(other.id, req.user.id);
  if (last) markUnread.run(last.id);
  res.json({ ok: true, unread: unreadTotal.get(req.user.id).n });
});

router.patch('/:userId', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  const current = getState.get(req.user.id, other.id) || { starred: 0, muted: 0, archived_at: null };
  const b = req.body || {};
  const next = {
    me: req.user.id,
    other: other.id,
    starred: b.starred === undefined ? current.starred : b.starred ? 1 : 0,
    muted: b.muted === undefined ? current.muted : b.muted ? 1 : 0,
    archived_at: b.archived === undefined ? current.archived_at : b.archived ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
  };
  upsertState.run(next);
  res.json({ state: stateFor(req.user.id, other.id) });
});

router.post('/:userId/block', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  insertBlock.run(req.user.id, other.id);
  res.json({ state: stateFor(req.user.id, other.id) });
});

router.delete('/:userId/block', (req, res) => {
  const other = lookupOther(req, res);
  if (!other) return;
  deleteBlock.run(req.user.id, other.id);
  res.json({ state: stateFor(req.user.id, other.id) });
});

module.exports = router;
