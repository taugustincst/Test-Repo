'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mailer = require('../mailer');
const { upload, removeByUrl } = require('../upload');
const { processArtwork } = require('../images');

const router = express.Router();

const MAX_PHOTOS = 3;
const EDIT_DAYS = 30;
const SORTS = {
  newest: 'rv.created_at DESC, rv.id DESC',
  highest: 'rv.rating DESC, rv.created_at DESC',
  lowest: 'rv.rating ASC, rv.created_at DESC',
  photos: "(rv.photos IS NOT NULL AND rv.photos != '[]') DESC, rv.created_at DESC",
  helpful: 'helpful_count DESC, rv.created_at DESC',
};
const PAGE = 10;

const REVIEW_SELECT = `
  SELECT rv.*, c.name AS client_name, c.avatar_url AS client_avatar_url, ap.starts_at, a.name AS artist_name, a.avatar_url AS artist_avatar_url,
         (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = rv.id) AS helpful_count
  FROM reviews rv
  JOIN users c ON c.id = rv.client_id
  JOIN users a ON a.id = rv.artist_id
  JOIN appointments ap ON ap.id = rv.appointment_id
`;
const listForArtist = Object.fromEntries(Object.entries(SORTS).map(([k, order]) => [k, db.prepare(`${REVIEW_SELECT} WHERE rv.artist_id = @artist ${k === 'photos' ? "AND rv.photos IS NOT NULL AND rv.photos != '[]'" : ''} ORDER BY ${order} LIMIT @limit OFFSET @offset`)]));
const summaryForArtist = db.prepare(`
  SELECT ROUND(AVG(rating), 1) AS rating, COUNT(*) AS review_count,
         SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five,
         SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four,
         SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three,
         SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one,
         SUM(CASE WHEN photos IS NOT NULL AND photos != '[]' THEN 1 ELSE 0 END) AS with_photos,
         SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS recommend
  FROM reviews WHERE artist_id = ?
`);
const photosForArtist = db.prepare(`SELECT id, photos FROM reviews WHERE artist_id = ? AND photos IS NOT NULL AND photos != '[]' ORDER BY created_at DESC LIMIT 12`);
const getReview = db.prepare(`${REVIEW_SELECT} WHERE rv.id = ?`);
const listMine = db.prepare(`${REVIEW_SELECT} WHERE rv.client_id = ? ORDER BY rv.created_at DESC, rv.id DESC`);
const pendingMine = db.prepare(`
  SELECT ap.id, ap.starts_at, ap.artist_id, a.name AS artist_name, a.avatar_url AS artist_avatar_url
  FROM appointments ap JOIN users a ON a.id = ap.artist_id
  WHERE ap.client_id = ? AND ap.status = 'completed' AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.appointment_id = ap.id)
  ORDER BY ap.starts_at DESC LIMIT 10
`);
const getAppointment = db.prepare('SELECT * FROM appointments WHERE id = ?');
const insertReview = db.prepare('INSERT INTO reviews (appointment_id, artist_id, client_id, rating, body, photos) VALUES (?, ?, ?, ?, ?, ?)');
const updateReview = db.prepare(`UPDATE reviews SET rating = ?, body = ?, photos = ?, updated_at = datetime('now') WHERE id = ?`);
const setReply = db.prepare('UPDATE reviews SET artist_reply = ? WHERE id = ?');
const deleteReview = db.prepare('DELETE FROM reviews WHERE id = ?');
const voted = db.prepare('SELECT 1 FROM review_votes WHERE user_id = ? AND review_id = ?');
const insertVote = db.prepare('INSERT OR IGNORE INTO review_votes (user_id, review_id) VALUES (?, ?)');
const deleteVote = db.prepare('DELETE FROM review_votes WHERE user_id = ? AND review_id = ?');
const voteCount = db.prepare('SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ?');

function parsePhotos(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

function shape(row, user) {
  if (!row) return null;
  const photos = parsePhotos(row.photos);
  const ageDays = (Date.now() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`)) / 86400000;
  return {
    id: row.id,
    appointment_id: row.appointment_id,
    artist_id: row.artist_id,
    artist_name: row.artist_name,
    artist_avatar_url: row.artist_avatar_url,
    client_id: row.client_id,
    client_name: row.client_name,
    client_avatar_url: row.client_avatar_url,
    rating: row.rating,
    body: row.body,
    photos,
    artist_reply: row.artist_reply,
    helpful_count: row.helpful_count,
    voted: user ? !!voted.get(user.id, row.id) : false,
    starts_at: row.starts_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    edited: !!row.updated_at,
    can_edit: !!user && user.id === row.client_id && ageDays <= EDIT_DAYS,
    verified: true,
  };
}

async function processPhotos(files) {
  const out = [];
  for (const file of files || []) {
    const image = await processArtwork(file);
    out.push({ url: image.url, thumb_url: image.thumb_url, width: image.width, height: image.height });
  }
  return out;
}

function discardFiles(files) {
  (files || []).forEach((f) => removeByUrl(`/uploads/${f.filename}`));
}

router.get('/artists/:id/reviews', (req, res) => {
  const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
  const page = Math.max(1, Number(req.query.page) || 1);
  const rows = listForArtist[sort].all({ artist: req.params.id, limit: PAGE + 1, offset: (page - 1) * PAGE });
  const summary = summaryForArtist.get(req.params.id);
  summary.recommend_pct = summary.review_count ? Math.round((summary.recommend / summary.review_count) * 100) : null;
  const photos = [];
  photosForArtist.all(req.params.id).forEach((r) => parsePhotos(r.photos).forEach((p) => photos.push({ ...p, review_id: r.id })));
  res.json({
    reviews: rows.slice(0, PAGE).map((r) => shape(r, req.user)),
    has_more: rows.length > PAGE,
    page,
    sort,
    summary,
    photos: photos.slice(0, 12),
  });
});

router.get('/reviews/mine', requireRole('client'), (req, res) => {
  res.json({ reviews: listMine.all(req.user.id).map((r) => shape(r, req.user)), pending: pendingMine.all(req.user.id) });
});

router.post('/appointments/:id/review', requireRole('client'), upload.array('photos', MAX_PHOTOS), async (req, res) => {
  const appt = getAppointment.get(req.params.id);
  if (!appt) { discardFiles(req.files); return res.status(404).json({ error: 'Appointment not found.' }); }
  if (appt.client_id !== req.user.id) { discardFiles(req.files); return res.status(403).json({ error: 'This is not your appointment.' }); }
  if (appt.status !== 'completed') { discardFiles(req.files); return res.status(400).json({ error: 'You can review a session once it is completed.' }); }
  const rating = Number((req.body || {}).rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) { discardFiles(req.files); return res.status(400).json({ error: 'Pick a rating from 1 to 5.' }); }
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  let photos;
  try { photos = await processPhotos(req.files); } catch (err) { return res.status(400).json({ error: err.message }); }
  let info;
  try {
    info = insertReview.run(appt.id, appt.artist_id, req.user.id, rating, body, JSON.stringify(photos));
  } catch (err) {
    photos.forEach((p) => removeByUrl(p.url));
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'You already reviewed this session.' });
    throw err;
  }
  const review = shape(getReview.get(info.lastInsertRowid), req.user);
  mailer.notify(mailer.templates.reviewReceived(review, appt.artist_id));
  res.status(201).json({ review });
});

/** Clients can revise a review for 30 days: rating, text, add photos, drop photos. */
router.put('/reviews/:id', requireRole('client'), upload.array('photos', MAX_PHOTOS), async (req, res) => {
  const row = getReview.get(req.params.id);
  if (!row) { discardFiles(req.files); return res.status(404).json({ error: 'Review not found.' }); }
  const current = shape(row, req.user);
  if (row.client_id !== req.user.id) { discardFiles(req.files); return res.status(403).json({ error: 'This is not your review.' }); }
  if (!current.can_edit) { discardFiles(req.files); return res.status(400).json({ error: `Reviews can be edited for ${EDIT_DAYS} days after posting.` }); }
  const b = req.body || {};
  const rating = b.rating === undefined ? row.rating : Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) { discardFiles(req.files); return res.status(400).json({ error: 'Pick a rating from 1 to 5.' }); }
  const body = b.body === undefined ? row.body : String(b.body).trim().slice(0, 2000);
  let removeList = [];
  try { removeList = typeof b.remove_photos === 'string' ? JSON.parse(b.remove_photos) : (b.remove_photos || []); } catch { removeList = []; }
  removeList = Array.isArray(removeList) ? removeList.map(String) : [];
  const kept = current.photos.filter((p) => !removeList.includes(p.url));
  if (kept.length + (req.files || []).length > MAX_PHOTOS) { discardFiles(req.files); return res.status(400).json({ error: `Up to ${MAX_PHOTOS} photos per review.` }); }
  let added;
  try { added = await processPhotos(req.files); } catch (err) { return res.status(400).json({ error: err.message }); }
  const photos = [...kept, ...added];
  updateReview.run(rating, body, JSON.stringify(photos), row.id);
  current.photos.filter((p) => removeList.includes(p.url)).forEach((p) => removeByUrl(p.url));
  res.json({ review: shape(getReview.get(row.id), req.user) });
});

router.post('/reviews/:id/helpful', requireAuth, (req, res) => {
  const row = getReview.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Review not found.' });
  if (row.client_id === req.user.id) return res.status(400).json({ error: 'You cannot vote on your own review.' });
  if (voted.get(req.user.id, row.id)) deleteVote.run(req.user.id, row.id); else insertVote.run(req.user.id, row.id);
  res.json({ voted: !!voted.get(req.user.id, row.id), helpful_count: voteCount.get(row.id).n });
});

router.post('/reviews/:id/reply', requireRole('artist'), (req, res) => {
  const review = getReview.get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.artist_id !== req.user.id) return res.status(403).json({ error: 'This review is not about you.' });
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  setReply.run(body, review.id);
  res.json({ review: shape(getReview.get(review.id), req.user) });
});

router.delete('/reviews/:id', requireAuth, (req, res) => {
  const review = getReview.get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.client_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'You cannot delete that review.' });
  parsePhotos(review.photos).forEach((p) => removeByUrl(p.url));
  deleteReview.run(review.id);
  res.json({ ok: true });
});

module.exports = router;
