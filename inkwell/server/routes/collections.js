'use strict';

/**
 * Collections: boards of saved tattoos. Anyone signed in can keep them; clients use them as
 * reference boards to share with artists (in a request or a message) or with friends by link.
 */

const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const MAX_COLLECTIONS = 50;
const MAX_ITEMS = 200;

const COLLECTION_SELECT = `
  SELECT c.*, u.name AS owner_name, u.avatar_url AS owner_avatar_url, u.role AS owner_role,
         (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count,
         (SELECT COALESCE(a.thumb_url, a.image_url) FROM collection_items ci JOIN artworks a ON a.id = ci.artwork_id WHERE ci.collection_id = c.id ORDER BY ci.created_at DESC, ci.artwork_id DESC LIMIT 1) AS cover_url
  FROM collections c JOIN users u ON u.id = c.user_id
`;
const listMine = db.prepare(`${COLLECTION_SELECT} WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC`);
const getById = db.prepare(`${COLLECTION_SELECT} WHERE c.id = ?`);
const getByToken = db.prepare(`${COLLECTION_SELECT} WHERE c.token = ?`);
const countMine = db.prepare('SELECT COUNT(*) AS n FROM collections WHERE user_id = ?');
const insertCollection = db.prepare('INSERT INTO collections (user_id, title, description, token, is_public) VALUES (?, ?, ?, ?, ?)');
const updateCollection = db.prepare(`UPDATE collections SET title = ?, description = ?, is_public = ?, updated_at = datetime('now') WHERE id = ?`);
const touch = db.prepare(`UPDATE collections SET updated_at = datetime('now') WHERE id = ?`);
const deleteCollection = db.prepare('DELETE FROM collections WHERE id = ?');
const items = db.prepare(`
  SELECT a.id, a.title, a.style, a.placement, a.image_url, a.thumb_url, a.width, a.height, a.artist_id, u.name AS artist_name, u.avatar_url AS artist_avatar_url,
         ci.note, ci.created_at AS saved_at,
         (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) AS like_count
  FROM collection_items ci JOIN artworks a ON a.id = ci.artwork_id JOIN users u ON u.id = a.artist_id
  WHERE ci.collection_id = ? AND u.suspended_at IS NULL
  ORDER BY ci.created_at DESC, ci.artwork_id DESC
`);
const countItems = db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?');
const artworkExists = db.prepare('SELECT id FROM artworks WHERE id = ?');
const insertItem = db.prepare('INSERT OR IGNORE INTO collection_items (collection_id, artwork_id, note) VALUES (?, ?, ?)');
const deleteItem = db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND artwork_id = ?');
const collectionsHolding = db.prepare('SELECT collection_id FROM collection_items ci JOIN collections c ON c.id = ci.collection_id WHERE c.user_id = ? AND ci.artwork_id = ?');
const artistsIn = db.prepare(`
  SELECT DISTINCT u.id, u.name FROM collection_items ci JOIN artworks a ON a.id = ci.artwork_id JOIN users u ON u.id = a.artist_id
  WHERE ci.collection_id = ? ORDER BY u.name LIMIT 6
`);

const newToken = () => crypto.randomBytes(9).toString('base64url');

function shape(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    token: row.token,
    url: `/c/${row.token}`,
    is_public: !!row.is_public,
    item_count: row.item_count,
    cover_url: row.cover_url,
    owner: { id: row.user_id, name: row.owner_name, avatar_url: row.owner_avatar_url, role: row.owner_role },
    is_owner: !!user && user.id === row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function full(row, user) {
  const out = shape(row, user);
  out.items = items.all(row.id);
  out.artists = artistsIn.all(row.id);
  return out;
}

function validate(body, current = {}) {
  const b = body || {};
  const title = b.title === undefined ? current.title : String(b.title || '').trim().slice(0, 80);
  if (!title) return { error: 'Give the board a name.' };
  return {
    title,
    description: b.description === undefined ? (current.description || '') : String(b.description || '').trim().slice(0, 500),
    is_public: b.is_public === undefined ? (current.is_public ? 1 : 0) : (b.is_public ? 1 : 0),
  };
}

function own(req, res) {
  const row = getById.get(req.params.id);
  if (!row || row.user_id !== req.user.id) { res.status(404).json({ error: 'Board not found.' }); return null; }
  return row;
}

/* Public, by share token. Private boards are only visible to their owner. */
router.get('/shared/:token', (req, res) => {
  const row = getByToken.get(req.params.token);
  if (!row || (!row.is_public && !(req.user && req.user.id === row.user_id))) return res.status(404).json({ error: 'This board is private or no longer exists.' });
  res.json({ collection: full(row, req.user) });
});

router.use(requireAuth);

router.get('/', (req, res) => {
  const list = listMine.all(req.user.id).map((r) => shape(r, req.user));
  const artworkId = Number(req.query.artwork_id);
  const holding = artworkId ? new Set(collectionsHolding.all(req.user.id, artworkId).map((r) => r.collection_id)) : null;
  if (holding) list.forEach((c) => { c.has_artwork = holding.has(c.id); });
  res.json({ collections: list });
});

router.post('/', (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (countMine.get(req.user.id).n >= MAX_COLLECTIONS) return res.status(400).json({ error: `You can keep up to ${MAX_COLLECTIONS} boards.` });
  const info = insertCollection.run(req.user.id, v.title, v.description, newToken(), v.is_public);
  const artworkId = Number((req.body || {}).artwork_id);
  if (artworkId && artworkExists.get(artworkId)) insertItem.run(info.lastInsertRowid, artworkId, '');
  res.status(201).json({ collection: full(getById.get(info.lastInsertRowid), req.user) });
});

router.get('/:id', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  res.json({ collection: full(row, req.user) });
});

router.put('/:id', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  const v = validate(req.body, row);
  if (v.error) return res.status(400).json({ error: v.error });
  updateCollection.run(v.title, v.description, v.is_public, row.id);
  res.json({ collection: full(getById.get(row.id), req.user) });
});

router.delete('/:id', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  deleteCollection.run(row.id);
  res.json({ ok: true });
});

router.post('/:id/items', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  const artworkId = Number((req.body || {}).artwork_id);
  if (!artworkId || !artworkExists.get(artworkId)) return res.status(404).json({ error: 'That tattoo no longer exists.' });
  if (countItems.get(row.id).n >= MAX_ITEMS) return res.status(400).json({ error: `A board holds up to ${MAX_ITEMS} pieces.` });
  insertItem.run(row.id, artworkId, String((req.body || {}).note || '').trim().slice(0, 200));
  touch.run(row.id);
  res.status(201).json({ collection: full(getById.get(row.id), req.user) });
});

router.delete('/:id/items/:artworkId', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  deleteItem.run(row.id, req.params.artworkId);
  touch.run(row.id);
  res.json({ collection: full(getById.get(row.id), req.user) });
});

module.exports = router;
module.exports.getByToken = getByToken;
module.exports.getById = getById;
module.exports.shape = shape;
module.exports.items = items;
