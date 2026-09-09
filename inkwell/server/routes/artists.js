'use strict';

const express = require('express');
const { db, STYLES } = require('../db');
const { requireAuth, safeParse } = require('../auth');
const analytics = require('../analytics');

const router = express.Router();

const ARTIST_SELECT = `
  SELECT u.id, u.name, u.avatar_url, u.bio, u.location, u.created_at,
         p.studio_name, p.styles, p.hourly_rate, p.min_price, p.session_minutes,
         p.years_experience, p.instagram, p.website, p.accepting_clients, p.deposit_amount,
         (SELECT COUNT(*) FROM artworks a WHERE a.artist_id = u.id) AS artwork_count,
         (SELECT COUNT(*) FROM follows f WHERE f.artist_id = u.id) AS follower_count,
         (SELECT COUNT(*) FROM likes l JOIN artworks a ON a.id = l.artwork_id WHERE a.artist_id = u.id) AS like_count,
         (SELECT COALESCE(a.thumb_url, a.image_url) FROM artworks a WHERE a.artist_id = u.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS cover_url,
         (SELECT ROUND(AVG(rating), 1) FROM reviews rv WHERE rv.artist_id = u.id) AS rating,
         (SELECT COUNT(*) FROM reviews rv WHERE rv.artist_id = u.id) AS review_count
  FROM users u JOIN artist_profiles p ON p.user_id = u.id
  WHERE u.role = 'artist' AND u.suspended_at IS NULL
`;

const listArtists = db.prepare(`${ARTIST_SELECT} ORDER BY like_count DESC, artwork_count DESC, u.created_at ASC`);
const getArtist = db.prepare(`${ARTIST_SELECT} AND u.id = ?`);
const galleriesForArtist = db.prepare(`
  SELECT g.id, g.title, g.description, g.created_at,
         (SELECT COUNT(*) FROM artworks a WHERE a.gallery_id = g.id) AS artwork_count,
         (SELECT COALESCE(a.thumb_url, a.image_url) FROM artworks a WHERE a.gallery_id = g.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS cover_url
  FROM galleries g WHERE g.artist_id = ? ORDER BY g.created_at DESC, g.id DESC
`);
const isFollowing = db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND artist_id = ?');
const insertFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, artist_id) VALUES (?, ?)');
const deleteFollow = db.prepare('DELETE FROM follows WHERE follower_id = ? AND artist_id = ?');
const followerCount = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE artist_id = ?');

function shapeArtist(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    avatar_url: row.avatar_url,
    bio: row.bio,
    location: row.location,
    created_at: row.created_at,
    studio_name: row.studio_name,
    styles: safeParse(row.styles, []),
    hourly_rate: row.hourly_rate,
    min_price: row.min_price,
    session_minutes: row.session_minutes,
    years_experience: row.years_experience,
    instagram: row.instagram,
    website: row.website,
    accepting_clients: !!row.accepting_clients,
    deposit_amount: row.deposit_amount || 0,
    artwork_count: row.artwork_count,
    follower_count: row.follower_count,
    like_count: row.like_count,
    rating: row.rating,
    review_count: row.review_count,
    cover_url: row.cover_url,
  };
}

/** GET /api/artists?style=&location=&q=&accepting=1 */
router.get('/', (req, res) => {
  const style = String(req.query.style || '').trim();
  const location = String(req.query.location || '').trim().toLowerCase();
  const q = String(req.query.q || '').trim().toLowerCase();
  const accepting = req.query.accepting === '1';

  let artists = listArtists.all().map(shapeArtist);
  if (style) artists = artists.filter((a) => a.styles.includes(style));
  if (location) artists = artists.filter((a) => (a.location || '').toLowerCase().includes(location));
  if (accepting) artists = artists.filter((a) => a.accepting_clients);
  if (q) {
    artists = artists.filter((a) =>
      [a.name, a.studio_name, a.bio, a.location, ...a.styles].join(' ').toLowerCase().includes(q));
  }
  res.json({ artists, styles: STYLES });
});

router.get('/:id', (req, res) => {
  const artist = shapeArtist(getArtist.get(req.params.id));
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  artist.galleries = galleriesForArtist.all(artist.id);
  artist.is_following = req.user ? !!isFollowing.get(req.user.id, artist.id) : false;
  analytics.track(req, 'profile_view', artist.id);
  res.json({ artist });
});

router.post('/:id/follow', requireAuth, (req, res) => {
  const artist = getArtist.get(req.params.id);
  if (!artist) return res.status(404).json({ error: 'Artist not found.' });
  if (artist.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  insertFollow.run(req.user.id, artist.id);
  res.json({ following: true, follower_count: followerCount.get(artist.id).n });
});

router.delete('/:id/follow', requireAuth, (req, res) => {
  deleteFollow.run(req.user.id, req.params.id);
  res.json({ following: false, follower_count: followerCount.get(req.params.id).n });
});

module.exports = router;
