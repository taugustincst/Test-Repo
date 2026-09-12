'use strict';

/**
 * Flash: pre-drawn designs an artist offers at a fixed price. A client claims one by booking a
 * slot with it attached; one-off designs are taken off the board while the booking is alive and
 * marked sold when the session completes. Repeatable designs stay available.
 */

const express = require('express');
const { db, STYLES } = require('../db');
const { requireRole } = require('../auth');
const { upload, removeByUrl } = require('../upload');
const { processArtwork } = require('../images');
const analytics = require('../analytics');

const router = express.Router();

const SIZES = ['Tiny (under 2 in)', 'Small (2-4 in)', 'Medium (4-6 in)', 'Large (6-10 in)', 'Extra large'];
const STATUSES = ['available', 'claimed', 'sold', 'hidden'];
const SORTS = { newest: 'f.created_at DESC, f.id DESC', price_asc: 'f.price ASC, f.created_at DESC', price_desc: 'f.price DESC, f.created_at DESC' };

const FLASH_SELECT = `
  SELECT f.*, u.name AS artist_name, u.avatar_url AS artist_avatar_url, u.location AS artist_location, p.studio_name, p.deposit_amount, p.accepting_clients,
         (SELECT COUNT(*) FROM appointments ap WHERE ap.flash_id = f.id AND ap.status = 'completed') AS times_done
  FROM flash_designs f JOIN users u ON u.id = f.artist_id LEFT JOIN artist_profiles p ON p.user_id = f.artist_id
`;
const getFlash = db.prepare(`${FLASH_SELECT} WHERE f.id = ?`);
const insertFlash = db.prepare(`
  INSERT INTO flash_designs (artist_id, title, description, image_url, thumb_url, width, height, style, size_label, price, repeatable, status)
  VALUES (@artist_id, @title, @description, @image_url, @thumb_url, @width, @height, @style, @size_label, @price, @repeatable, @status)
`);
const updateFlash = db.prepare(`
  UPDATE flash_designs SET title = @title, description = @description, style = @style, size_label = @size_label, price = @price, repeatable = @repeatable, status = @status, updated_at = datetime('now') WHERE id = @id
`);
const deleteFlash = db.prepare('DELETE FROM flash_designs WHERE id = ?');
const liveClaim = db.prepare(`SELECT id FROM appointments WHERE flash_id = ? AND status IN ('pending', 'confirmed') LIMIT 1`);
const claimsFor = db.prepare(`
  SELECT ap.id, ap.status, ap.starts_at, c.name AS client_name FROM appointments ap JOIN users c ON c.id = ap.client_id
  WHERE ap.flash_id = ? ORDER BY ap.starts_at DESC LIMIT 20
`);

function shape(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    artist_id: row.artist_id,
    artist_name: row.artist_name,
    artist_avatar_url: row.artist_avatar_url,
    artist_location: row.artist_location,
    studio_name: row.studio_name,
    deposit_amount: row.deposit_amount || 0,
    accepting_clients: !!row.accepting_clients,
    title: row.title,
    description: row.description || '',
    image_url: row.image_url,
    thumb_url: row.thumb_url,
    width: row.width,
    height: row.height,
    style: row.style || '',
    size_label: row.size_label || '',
    price: row.price,
    repeatable: !!row.repeatable,
    status: row.status,
    available: row.status === 'available',
    times_done: row.times_done,
    is_owner: !!user && user.id === row.artist_id,
    created_at: row.created_at,
  };
}

function validate(body, current = {}) {
  const b = body || {};
  const title = b.title === undefined ? current.title : String(b.title || '').trim().slice(0, 100);
  if (!title) return { error: 'Give the design a title.' };
  const price = b.price === undefined ? current.price : Number(b.price);
  if (!Number.isInteger(price) || price < 0 || price > 100000) return { error: 'Enter a whole-dollar price.' };
  const style = b.style === undefined ? (current.style || '') : (STYLES.includes(b.style) ? b.style : '');
  const size = b.size_label === undefined ? (current.size_label || '') : (SIZES.includes(b.size_label) ? b.size_label : '');
  const status = b.status === undefined ? (current.status || 'available') : String(b.status);
  if (!['available', 'hidden'].includes(status) && status !== current.status) return { error: 'A design can be available or hidden.' };
  return {
    title,
    description: b.description === undefined ? (current.description || '') : String(b.description || '').trim().slice(0, 1000),
    style,
    size_label: size,
    price,
    repeatable: b.repeatable === undefined ? (current.repeatable ? 1 : 0) : (b.repeatable === true || b.repeatable === 'true' || b.repeatable === 'on' || b.repeatable === '1' ? 1 : 0),
    status,
  };
}

/* Browse: GET /api/flash?style=&artist_id=&max_price=&sort=&mine=1 */
router.get('/', (req, res) => {
  const where = ["u.suspended_at IS NULL"];
  const params = [];
  const artistId = Number(req.query.artist_id);
  const mine = req.query.mine === '1' && req.user && req.user.role === 'artist';
  if (mine) { where.push('f.artist_id = ?'); params.push(req.user.id); } else {
    where.push("f.status = 'available'");
    if (Number.isInteger(artistId) && artistId > 0) { where.push('f.artist_id = ?'); params.push(artistId); }
  }
  if (STYLES.includes(req.query.style)) { where.push('f.style = ?'); params.push(req.query.style); }
  const max = Number(req.query.max_price);
  if (max > 0) { where.push('f.price <= ?'); params.push(max); }
  const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 40));
  const rows = db.prepare(`${FLASH_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort]} LIMIT ?`).all(...params, limit + 1);
  res.json({ flash: rows.slice(0, limit).map((r) => shape(r, req.user)), has_more: rows.length > limit, styles: STYLES, sizes: SIZES, sort });
});

router.get('/:id', (req, res) => {
  const row = getFlash.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Design not found.' });
  const isOwner = req.user && req.user.id === row.artist_id;
  if (row.status === 'hidden' && !isOwner && !(req.user && req.user.is_admin)) return res.status(404).json({ error: 'Design not found.' });
  const out = shape(row, req.user);
  if (isOwner) out.claims = claimsFor.all(row.id);
  if (!isOwner) analytics.track(req, 'artwork_view', row.artist_id, null);
  res.json({ flash: out });
});

router.post('/', requireRole('artist'), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload the design image.' });
  const v = validate(req.body);
  if (v.error) { removeByUrl(`/uploads/${req.file.filename}`); return res.status(400).json({ error: v.error }); }
  let image;
  try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
  const info = insertFlash.run({ ...v, artist_id: req.user.id, image_url: image.url, thumb_url: image.thumb_url, width: image.width, height: image.height });
  res.status(201).json({ flash: shape(getFlash.get(info.lastInsertRowid), req.user) });
});

router.put('/:id', requireRole('artist'), (req, res) => {
  const row = getFlash.get(req.params.id);
  if (!row || row.artist_id !== req.user.id) return res.status(404).json({ error: 'Design not found.' });
  if (row.status === 'claimed' && (req.body || {}).status && req.body.status !== 'claimed') return res.status(400).json({ error: 'This design is claimed by a booking. Cancel the booking first.' });
  const v = validate(req.body, row);
  if (v.error) return res.status(400).json({ error: v.error });
  updateFlash.run({ ...v, id: row.id });
  res.json({ flash: shape(getFlash.get(row.id), req.user) });
});

router.delete('/:id', requireRole('artist'), (req, res) => {
  const row = getFlash.get(req.params.id);
  if (!row || row.artist_id !== req.user.id) return res.status(404).json({ error: 'Design not found.' });
  if (liveClaim.get(row.id)) return res.status(400).json({ error: 'This design has a live booking. Cancel it first or hide the design.' });
  deleteFlash.run(row.id);
  removeByUrl(row.image_url);
  res.json({ ok: true });
});

/* Called by the bookings router. */
const setStatus = db.prepare(`UPDATE flash_designs SET status = ?, updated_at = datetime('now') WHERE id = ?`);
function claim(flashId) { const row = getFlash.get(flashId); if (row && !row.repeatable) setStatus.run('claimed', flashId); }
function release(flashId) { const row = getFlash.get(flashId); if (row && row.status === 'claimed' && !liveClaim.get(flashId)) setStatus.run('available', flashId); }
function sold(flashId) { const row = getFlash.get(flashId); if (row && !row.repeatable) setStatus.run('sold', flashId); }

module.exports = router;
module.exports.getFlash = getFlash;
module.exports.shape = shape;
module.exports.claim = claim;
module.exports.release = release;
module.exports.sold = sold;
module.exports.SIZES = SIZES;
module.exports.STATUSES = STATUSES;
