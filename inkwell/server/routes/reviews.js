'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const mailer = require('../mailer');

const router = express.Router();

const REVIEW_SELECT = `
  SELECT rv.*, c.name AS client_name, c.avatar_url AS client_avatar_url, ap.starts_at
  FROM reviews rv
  JOIN users c ON c.id = rv.client_id
  JOIN appointments ap ON ap.id = rv.appointment_id
`;
const listForArtist = db.prepare(`${REVIEW_SELECT} WHERE rv.artist_id = ? ORDER BY rv.created_at DESC, rv.id DESC`);
const summaryForArtist = db.prepare(`
  SELECT ROUND(AVG(rating), 1) AS rating, COUNT(*) AS review_count,
         SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five,
         SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four,
         SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three,
         SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one
  FROM reviews WHERE artist_id = ?
`);
const getReview = db.prepare(`${REVIEW_SELECT} WHERE rv.id = ?`);
const getAppointment = db.prepare('SELECT * FROM appointments WHERE id = ?');
const insertReview = db.prepare('INSERT INTO reviews (appointment_id, artist_id, client_id, rating, body) VALUES (?, ?, ?, ?, ?)');
const setReply = db.prepare('UPDATE reviews SET artist_reply = ? WHERE id = ?');
const deleteReview = db.prepare('DELETE FROM reviews WHERE id = ?');

router.get('/artists/:id/reviews', (req, res) => {
  const summary = summaryForArtist.get(req.params.id);
  res.json({ reviews: listForArtist.all(req.params.id), summary });
});

router.post('/appointments/:id/review', requireRole('client'), (req, res) => {
  const appt = getAppointment.get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Appointment not found.' });
  if (appt.client_id !== req.user.id) return res.status(403).json({ error: 'This is not your appointment.' });
  if (appt.status !== 'completed') return res.status(400).json({ error: 'You can review a session once it is completed.' });
  const rating = Number((req.body || {}).rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Pick a rating from 1 to 5.' });
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  let info;
  try {
    info = insertReview.run(appt.id, appt.artist_id, req.user.id, rating, body);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'You already reviewed this session.' });
    throw err;
  }
  const review = getReview.get(info.lastInsertRowid);
  mailer.notify(mailer.templates.reviewReceived(review, appt.artist_id));
  res.status(201).json({ review });
});

router.post('/reviews/:id/reply', requireRole('artist'), (req, res) => {
  const review = getReview.get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.artist_id !== req.user.id) return res.status(403).json({ error: 'This review is not about you.' });
  const body = String((req.body || {}).body || '').trim().slice(0, 2000);
  if (!body) return res.status(400).json({ error: 'Write a reply first.' });
  setReply.run(body, review.id);
  res.json({ review: getReview.get(review.id) });
});

router.delete('/reviews/:id', requireAuth, (req, res) => {
  const review = getReview.get(req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found.' });
  if (review.client_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'You cannot delete that review.' });
  deleteReview.run(review.id);
  res.json({ ok: true });
});

module.exports = router;
