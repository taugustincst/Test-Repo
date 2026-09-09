'use strict';

const express = require('express');
const { db, STYLES } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { upload, removeByUrl } = require('../upload');
const { processArtwork } = require('../images');
const analytics = require('../analytics');

const router = express.Router();

const ARTWORK_SELECT = `
  SELECT a.id, a.gallery_id, a.artist_id, a.image_url, a.thumb_url, a.width, a.height, a.title, a.description, a.style, a.placement, a.created_at,
         u.name AS artist_name, u.avatar_url AS artist_avatar_url, u.location AS artist_location,
         g.title AS gallery_title,
         (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.artwork_id = a.id) AS comment_count
  FROM artworks a
  JOIN users u ON u.id = a.artist_id
  JOIN galleries g ON g.id = a.gallery_id
`;

const getGallery = db.prepare(`
  SELECT g.*, u.name AS artist_name, u.avatar_url AS artist_avatar_url
  FROM galleries g JOIN users u ON u.id = g.artist_id WHERE g.id = ?
`);
const artworksForGallery = db.prepare(`${ARTWORK_SELECT} WHERE a.gallery_id = ? ORDER BY a.created_at DESC, a.id DESC`);
const artworksForGalleryRaw = db.prepare('SELECT id, image_url FROM artworks WHERE gallery_id = ?');
const getArtwork = db.prepare(`${ARTWORK_SELECT} WHERE a.id = ?`);
const insertGallery = db.prepare('INSERT INTO galleries (artist_id, title, description) VALUES (?, ?, ?)');
const updateGallery = db.prepare('UPDATE galleries SET title = ?, description = ? WHERE id = ?');
const deleteGallery = db.prepare('DELETE FROM galleries WHERE id = ?');
const insertArtwork = db.prepare(`
  INSERT INTO artworks (gallery_id, artist_id, image_url, thumb_url, width, height, title, description, style, placement)
  VALUES (@gallery_id, @artist_id, @image_url, @thumb_url, @width, @height, @title, @description, @style, @placement)
`);
const updateArtwork = db.prepare(`
  UPDATE artworks SET title = @title, description = @description, style = @style, placement = @placement WHERE id = @id
`);
const deleteArtwork = db.prepare('DELETE FROM artworks WHERE id = ?');
const userLiked = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND artwork_id = ?');
const insertLike = db.prepare('INSERT OR IGNORE INTO likes (user_id, artwork_id) VALUES (?, ?)');
const deleteLike = db.prepare('DELETE FROM likes WHERE user_id = ? AND artwork_id = ?');
const likeCount = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE artwork_id = ?');
const commentsFor = db.prepare(`
  SELECT c.id, c.body, c.created_at, c.user_id, u.name AS user_name, u.avatar_url AS user_avatar_url, u.role AS user_role
  FROM comments c JOIN users u ON u.id = c.user_id WHERE c.artwork_id = ? ORDER BY c.created_at ASC, c.id ASC
`);
const insertComment = db.prepare('INSERT INTO comments (artwork_id, user_id, body) VALUES (?, ?, ?)');
const getComment = db.prepare('SELECT * FROM comments WHERE id = ?');
const deleteComment = db.prepare('DELETE FROM comments WHERE id = ?');

function cleanStyle(style) {
  return STYLES.includes(style) ? style : '';
}

function decorate(artwork, user) {
  if (!artwork) return artwork;
  artwork.liked = user ? !!userLiked.get(user.id, artwork.id) : false;
  return artwork;
}

/** Explore feed: GET /api/feed?style=&sort=recent|popular&q=&artist_id=&limit=&offset= */
router.get('/feed', (req, res) => {
  const style = cleanStyle(String(req.query.style || ''));
  const q = String(req.query.q || '').trim().toLowerCase();
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent';
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where = ['u.suspended_at IS NULL'];
  const params = [];
  const artistId = Number(req.query.artist_id);
  if (Number.isInteger(artistId) && artistId > 0) { where.push('a.artist_id = ?'); params.push(artistId); }
  if (style) { where.push('a.style = ?'); params.push(style); }
  if (q) {
    where.push('(LOWER(a.title) LIKE ? OR LOWER(a.description) LIKE ? OR LOWER(u.name) LIKE ? OR LOWER(a.placement) LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const order = sort === 'popular'
    ? 'ORDER BY like_count DESC, comment_count DESC, a.created_at DESC'
    : 'ORDER BY a.created_at DESC, a.id DESC';
  const sql = `${ARTWORK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${order} LIMIT ? OFFSET ?`;
  const artworks = db.prepare(sql).all(...params, limit + 1, offset).map((a) => decorate(a, req.user));
  const hasMore = artworks.length > limit;
  res.json({ artworks: artworks.slice(0, limit), has_more: hasMore, styles: STYLES });
});

router.post('/galleries', requireRole('artist'), (req, res) => {
  const title = String((req.body || {}).title || '').trim();
  const description = String((req.body || {}).description || '').trim().slice(0, 1000);
  if (!title) return res.status(400).json({ error: 'Give your gallery a title.' });
  const info = insertGallery.run(req.user.id, title.slice(0, 120), description);
  res.status(201).json({ gallery: getGallery.get(info.lastInsertRowid) });
});

router.get('/galleries/:id', (req, res) => {
  const gallery = getGallery.get(req.params.id);
  if (!gallery) return res.status(404).json({ error: 'Gallery not found.' });
  gallery.artworks = artworksForGallery.all(gallery.id).map((a) => decorate(a, req.user));
  analytics.track(req, 'gallery_view', gallery.artist_id, gallery.id);
  res.json({ gallery });
});

function ownGallery(req, res) {
  const gallery = getGallery.get(req.params.id);
  if (!gallery) { res.status(404).json({ error: 'Gallery not found.' }); return null; }
  if (gallery.artist_id !== req.user.id) { res.status(403).json({ error: 'This is not your gallery.' }); return null; }
  return gallery;
}

router.put('/galleries/:id', requireRole('artist'), (req, res) => {
  const gallery = ownGallery(req, res);
  if (!gallery) return;
  const title = String((req.body || {}).title ?? gallery.title).trim();
  if (!title) return res.status(400).json({ error: 'Give your gallery a title.' });
  updateGallery.run(title.slice(0, 120), String((req.body || {}).description ?? gallery.description).slice(0, 1000), gallery.id);
  res.json({ gallery: getGallery.get(gallery.id) });
});

router.delete('/galleries/:id', requireRole('artist'), (req, res) => {
  const gallery = ownGallery(req, res);
  if (!gallery) return;
  const files = artworksForGalleryRaw.all(gallery.id);
  deleteGallery.run(gallery.id);
  files.forEach((f) => removeByUrl(f.image_url));
  res.json({ ok: true });
});

router.post('/galleries/:id/artworks', requireRole('artist'), upload.single('image'), async (req, res) => {
  const gallery = ownGallery(req, res);
  if (!gallery) { if (req.file) removeByUrl(`/uploads/${req.file.filename}`); return; }
  if (!req.file) return res.status(400).json({ error: 'Choose an image to upload.' });
  let image;
  try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
  const body = req.body || {};
  const title = String(body.title || '').trim() || 'Untitled';
  const info = insertArtwork.run({
    gallery_id: gallery.id,
    artist_id: req.user.id,
    image_url: image.url,
    thumb_url: image.thumb_url,
    width: image.width,
    height: image.height,
    title: title.slice(0, 120),
    description: String(body.description || '').slice(0, 2000),
    style: cleanStyle(body.style),
    placement: String(body.placement || '').slice(0, 60),
  });
  res.status(201).json({ artwork: decorate(getArtwork.get(info.lastInsertRowid), req.user) });
});

router.get('/artworks/:id', (req, res) => {
  const artwork = getArtwork.get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
  decorate(artwork, req.user);
  artwork.comments = commentsFor.all(artwork.id);
  analytics.track(req, 'artwork_view', artwork.artist_id, artwork.id);
  res.json({ artwork });
});

router.put('/artworks/:id', requireRole('artist'), (req, res) => {
  const artwork = getArtwork.get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
  if (artwork.artist_id !== req.user.id) return res.status(403).json({ error: 'This is not your artwork.' });
  const body = req.body || {};
  updateArtwork.run({
    id: artwork.id,
    title: (String(body.title ?? artwork.title).trim() || 'Untitled').slice(0, 120),
    description: String(body.description ?? artwork.description).slice(0, 2000),
    style: body.style === undefined ? artwork.style : cleanStyle(body.style),
    placement: String(body.placement ?? artwork.placement).slice(0, 60),
  });
  res.json({ artwork: decorate(getArtwork.get(artwork.id), req.user) });
});

router.delete('/artworks/:id', requireRole('artist'), (req, res) => {
  const artwork = getArtwork.get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
  if (artwork.artist_id !== req.user.id) return res.status(403).json({ error: 'This is not your artwork.' });
  deleteArtwork.run(artwork.id);
  removeByUrl(artwork.image_url);
  res.json({ ok: true });
});

router.post('/artworks/:id/like', requireAuth, (req, res) => {
  const artwork = getArtwork.get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
  const liked = !!userLiked.get(req.user.id, artwork.id);
  if (liked) deleteLike.run(req.user.id, artwork.id);
  else insertLike.run(req.user.id, artwork.id);
  res.json({ liked: !liked, like_count: likeCount.get(artwork.id).n });
});

router.get('/artworks/:id/comments', (req, res) => {
  res.json({ comments: commentsFor.all(req.params.id) });
});

router.post('/artworks/:id/comments', requireAuth, (req, res) => {
  const artwork = getArtwork.get(req.params.id);
  if (!artwork) return res.status(404).json({ error: 'Artwork not found.' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write something first.' });
  insertComment.run(artwork.id, req.user.id, body.slice(0, 1000));
  res.status(201).json({ comments: commentsFor.all(artwork.id) });
});

router.delete('/comments/:id', requireAuth, (req, res) => {
  const comment = getComment.get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  const artwork = getArtwork.get(comment.artwork_id);
  const canDelete = comment.user_id === req.user.id || (artwork && artwork.artist_id === req.user.id);
  if (!canDelete) return res.status(403).json({ error: 'You cannot delete that comment.' });
  deleteComment.run(comment.id);
  res.json({ comments: commentsFor.all(comment.artwork_id) });
});

module.exports = router;
