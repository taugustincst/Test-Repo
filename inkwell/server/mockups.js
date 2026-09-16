'use strict';

/**
 * Placement previews. An artist lays a stencil from their library over a photo of the client
 * (the spot the tattoo will go), sizes and turns it, and the server renders the composite so
 * both sides see the same picture. The preview can be tied to a booking and sent to the client,
 * who approves it or asks for changes; either answer lands in the conversation and on the
 * booking card.
 *
 * The transform is stored as fractions of the photo so it survives re-rendering at any size:
 * { x, y } centre of the stencil, `width` as a share of the photo width, `rotation` in degrees,
 * `mirror`, `opacity` and the ink `color`.
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { db } = require('./db');
const { requireAuth, requireRole } = require('./auth');
const { upload, UPLOAD_DIR, publicUrl, removeByUrl } = require('./upload');
const { processArtwork } = require('./images');
const mailer = require('./mailer');
const messaging = require('./messaging');

const MAX_EDGE = 1600;
const COLORS = { purple: [75, 42, 138], black: [17, 17, 17], red: [179, 38, 46] };
const DEFAULT_TRANSFORM = { x: 0.5, y: 0.5, width: 0.4, rotation: 0, mirror: false, opacity: 0.85, color: 'purple' };

/* ---------- transform ---------- */

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);

function normaliseTransform(input) {
  const t = typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch { return {}; } })() : (input || {});
  return {
    x: clamp(t.x, -0.5, 1.5, DEFAULT_TRANSFORM.x),
    y: clamp(t.y, -0.5, 1.5, DEFAULT_TRANSFORM.y),
    width: clamp(t.width, 0.05, 2, DEFAULT_TRANSFORM.width),
    rotation: clamp(t.rotation, -180, 180, DEFAULT_TRANSFORM.rotation),
    mirror: t.mirror === true || t.mirror === 'true' || t.mirror === 1,
    opacity: clamp(t.opacity, 0.2, 1, DEFAULT_TRANSFORM.opacity),
    color: COLORS[t.color] ? t.color : DEFAULT_TRANSFORM.color,
  };
}

/* ---------- rendering ---------- */

const localFile = (url) => (url && url.startsWith('/uploads/') ? path.join(UPLOAD_DIR, path.basename(url)) : null);

/** Recolour a stencil (black on transparent) to the chosen ink and apply the opacity. */
async function inkStencil(file, color, opacity) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = COLORS[color];
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
    data[i + 3] = Math.round(data[i + 3] * opacity);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/**
 * Composite the stencil over the photo. Returns { buffer (webp), width, height }.
 * The overlay is clipped to the photo before compositing, so a stencil dragged half off the
 * edge renders the visible half instead of failing.
 */
async function render(photoFile, stencilFile, transform) {
  const photo = sharp(photoFile, { failOn: 'error' }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' });
  const { data: photoBuf, info } = await photo.raw().toBuffer({ resolveWithObject: true });
  const W = info.width; const H = info.height;
  const t = transform;
  let overlay = sharp(await inkStencil(stencilFile, t.color, t.opacity));
  if (t.mirror) overlay = overlay.flop();
  const targetW = Math.max(8, Math.round(t.width * W));
  const resized = await overlay.resize({ width: targetW }).png().toBuffer();
  const rotated = await sharp(resized).rotate(t.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const rm = await sharp(rotated).metadata();
  const left = Math.round(t.x * W - rm.width / 2);
  const top = Math.round(t.y * H - rm.height / 2);
  // Clip to the photo.
  const x0 = Math.max(0, left); const y0 = Math.max(0, top);
  const x1 = Math.min(W, left + rm.width); const y1 = Math.min(H, top + rm.height);
  let composed = sharp(photoBuf, { raw: { width: W, height: H, channels: info.channels } });
  if (x1 > x0 && y1 > y0) {
    const clipped = await sharp(rotated).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
    composed = composed.composite([{ input: clipped, left: x0, top: y0 }]);
  }
  const buffer = await composed.webp({ quality: 86 }).toBuffer();
  return { buffer, width: W, height: H, overlay: { left, top, width: rm.width, height: rm.height } };
}

async function writeRender(result) {
  const base = `mockup-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await fs.writeFile(path.join(UPLOAD_DIR, `${base}.webp`), result.buffer);
  await sharp(result.buffer).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 78 }).toFile(path.join(UPLOAD_DIR, `${base}.thumb.webp`));
  return { url: publicUrl(`${base}.webp`), thumb_url: publicUrl(`${base}.thumb.webp`) };
}

/* ---------- data ---------- */

const MOCKUP_SELECT = `
  SELECT m.*, a.name AS artist_name, a.avatar_url AS artist_avatar_url, c.name AS client_name, c.avatar_url AS client_avatar_url,
         s.title AS stencil_title, s.thumb_url AS stencil_thumb_url, s.image_url AS stencil_image_url, s.status AS stencil_status,
         ap.starts_at AS appointment_starts_at, ap.status AS appointment_status
  FROM mockups m
  JOIN users a ON a.id = m.artist_id
  LEFT JOIN users c ON c.id = m.client_id
  LEFT JOIN stencils s ON s.id = m.stencil_id
  LEFT JOIN appointments ap ON ap.id = m.appointment_id
`;
const getMockup = db.prepare(`${MOCKUP_SELECT} WHERE m.id = ?`);
const listForArtist = db.prepare(`${MOCKUP_SELECT} WHERE m.artist_id = ? ORDER BY m.updated_at DESC, m.id DESC LIMIT 200`);
const listForClient = db.prepare(`${MOCKUP_SELECT} WHERE m.client_id = ? AND m.status <> 'draft' ORDER BY m.updated_at DESC, m.id DESC LIMIT 200`);
const latestForAppointmentStmt = db.prepare(`SELECT id, status, thumb_url, title, sent_at, responded_at FROM mockups WHERE appointment_id = ? AND status <> 'draft' ORDER BY updated_at DESC, id DESC LIMIT 1`);
const insertMockup = db.prepare(`
  INSERT INTO mockups (artist_id, client_id, appointment_id, stencil_id, title, photo_url, transform, image_url, thumb_url, width, height)
  VALUES (@artist_id, @client_id, @appointment_id, @stencil_id, @title, @photo_url, @transform, @image_url, @thumb_url, @width, @height)
`);
const updateMockup = db.prepare(`
  UPDATE mockups SET client_id = @client_id, appointment_id = @appointment_id, title = @title, transform = @transform, image_url = @image_url, thumb_url = @thumb_url,
    width = @width, height = @height, status = @status, updated_at = datetime('now') WHERE id = @id
`);
const markSent = db.prepare(`UPDATE mockups SET status = 'sent', sent_at = datetime('now'), responded_at = NULL, client_note = NULL, updated_at = datetime('now') WHERE id = ?`);
const markResponded = db.prepare(`UPDATE mockups SET status = ?, client_note = ?, responded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`);
const deleteMockup = db.prepare('DELETE FROM mockups WHERE id = ?');
const stencilOf = db.prepare('SELECT id, artist_id, title, image_url, status FROM stencils WHERE id = ?');
const clientRow = db.prepare(`SELECT id, name, role, suspended_at FROM users WHERE id = ? AND role = 'client'`);
const appointmentRow = db.prepare('SELECT id, artist_id, client_id, starts_at, status FROM appointments WHERE id = ?');
const requestRow = db.prepare('SELECT id, client_id, reference_image_url FROM tattoo_requests WHERE id = ?');
const insertMessage = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, attachments) VALUES (?, ?, ?, ?)');
const messageById = db.prepare('SELECT * FROM messages WHERE id = ?');
const unreadTotal = db.prepare(`
  SELECT COUNT(*) AS n FROM messages m
  LEFT JOIN conversation_state cs ON cs.user_id = m.recipient_id AND cs.other_id = m.sender_id
  WHERE m.recipient_id = ? AND m.read_at IS NULL AND COALESCE(cs.muted, 0) = 0
`);
const otherPhotoUses = db.prepare('SELECT COUNT(*) AS n FROM mockups WHERE photo_url = ? AND id <> ?');

function shape(row, user) {
  if (!row) return null;
  return {
    id: row.id,
    artist_id: row.artist_id,
    artist_name: row.artist_name,
    artist_avatar_url: row.artist_avatar_url,
    client_id: row.client_id,
    client_name: row.client_name,
    client_avatar_url: row.client_avatar_url,
    appointment_id: row.appointment_id,
    appointment_starts_at: row.appointment_starts_at,
    appointment_status: row.appointment_status,
    stencil_id: row.stencil_id,
    stencil_title: row.stencil_title,
    stencil_thumb_url: row.stencil_thumb_url,
    stencil_image_url: row.stencil_image_url,
    title: row.title,
    photo_url: row.photo_url,
    transform: JSON.parse(row.transform),
    image_url: row.image_url,
    thumb_url: row.thumb_url,
    width: row.width,
    height: row.height,
    status: row.status,
    client_note: row.client_note,
    sent_at: row.sent_at,
    responded_at: row.responded_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_mine: !!user && user.id === row.artist_id,
    can_respond: !!user && user.id === row.client_id && row.status === 'sent',
  };
}

const latestForAppointment = (appointmentId) => latestForAppointmentStmt.get(appointmentId) || null;

/** Attachment card for the conversation. */
const attachment = (row) => ({ type: 'mockup', id: row.id, title: row.title, thumb_url: row.thumb_url, status: row.status });

function sendMessage(fromId, toId, body, row) {
  const info = insertMessage.run(fromId, toId, body, JSON.stringify([attachment(row)]));
  const m = messageById.get(info.lastInsertRowid);
  const message = { id: m.id, sender_id: m.sender_id, recipient_id: m.recipient_id, body: m.body, attachments: messaging.parseAttachments(m.attachments), read_at: null, deleted: false, created_at: m.created_at };
  messaging.emit(toId, 'message', { from: fromId, message, unread: unreadTotal.get(toId).n });
  messaging.emit(fromId, 'sent', { to: toId, message });
  return message;
}

/* ---------- routes ---------- */

const router = express.Router();
router.use(requireAuth);

function own(req, res) {
  const row = getMockup.get(req.params.id);
  if (!row || row.artist_id !== req.user.id) { res.status(404).json({ error: 'Placement not found.' }); return null; }
  return row;
}

/** Validate the client and appointment an artist wants to tie a placement to. */
function resolveLinks(req, body, res) {
  const clientId = body.client_id ? Number(body.client_id) : null;
  if (clientId) {
    const c = clientRow.get(clientId);
    if (!c || c.suspended_at) { res.status(400).json({ error: 'Choose a client account.' }); return null; }
  }
  const appointmentId = body.appointment_id ? Number(body.appointment_id) : null;
  let appt = null;
  if (appointmentId) {
    appt = appointmentRow.get(appointmentId);
    if (!appt || appt.artist_id !== req.user.id) { res.status(400).json({ error: 'That booking is not yours.' }); return null; }
    if (clientId && appt.client_id !== clientId) { res.status(400).json({ error: 'That booking belongs to a different client.' }); return null; }
  }
  return { client_id: clientId || (appt ? appt.client_id : null), appointment_id: appointmentId };
}

router.get('/', (req, res) => {
  const rows = req.user.role === 'artist' ? listForArtist.all(req.user.id) : listForClient.all(req.user.id);
  res.json({ mockups: rows.map((r) => shape(r, req.user)) });
});

/** Create: a photo (upload, or reuse one of my placements' photo, or the client's request reference) plus a stencil and a transform. */
router.post('/', requireRole('artist'), upload.single('photo'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const stencil = stencilOf.get(Number(body.stencil_id));
    if (!stencil || stencil.artist_id !== req.user.id) return res.status(400).json({ error: 'Pick a stencil from your library.' });
    if (stencil.status !== 'ready') return res.status(400).json({ error: 'That stencil has not been traced yet.' });
    const links = resolveLinks(req, body, res);
    if (!links) return;
    let photoUrl = null;
    if (req.file) {
      let image;
      try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
      removeByUrl(image.thumb_url);
      photoUrl = image.url;
    } else if (body.mockup_id) {
      const src = getMockup.get(Number(body.mockup_id));
      if (!src || src.artist_id !== req.user.id) return res.status(400).json({ error: 'That placement is not yours.' });
      photoUrl = src.photo_url;
    } else if (body.request_id) {
      const r = requestRow.get(Number(body.request_id));
      if (!r || !r.reference_image_url) return res.status(400).json({ error: 'That request has no reference photo.' });
      if (links.client_id && r.client_id !== links.client_id) return res.status(400).json({ error: 'That request belongs to a different client.' });
      links.client_id = links.client_id || r.client_id;
      photoUrl = r.reference_image_url;
    }
    if (!photoUrl) return res.status(400).json({ error: 'Add a photo of where the tattoo will go.' });
    const transform = normaliseTransform(body.transform);
    const result = await render(localFile(photoUrl), localFile(stencil.image_url), transform);
    const files = await writeRender(result);
    const info = insertMockup.run({
      artist_id: req.user.id, client_id: links.client_id, appointment_id: links.appointment_id, stencil_id: stencil.id,
      title: String(body.title || stencil.title || 'Placement').trim().slice(0, 120) || 'Placement', photo_url: photoUrl, transform: JSON.stringify(transform),
      image_url: files.url, thumb_url: files.thumb_url, width: result.width, height: result.height,
    });
    res.status(201).json({ mockup: shape(getMockup.get(info.lastInsertRowid), req.user) });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const row = getMockup.get(req.params.id);
  if (!row || (row.artist_id !== req.user.id && !(row.client_id === req.user.id && row.status !== 'draft'))) return res.status(404).json({ error: 'Placement not found.' });
  res.json({ mockup: shape(row, req.user) });
});

/** Adjust: a new transform re-renders; a sent placement goes back to draft until it is sent again. */
router.put('/:id', requireRole('artist'), async (req, res, next) => {
  try {
    const row = own(req, res);
    if (!row) return;
    const body = req.body || {};
    const links = resolveLinks(req, { client_id: body.client_id === undefined ? row.client_id : body.client_id, appointment_id: body.appointment_id === undefined ? row.appointment_id : body.appointment_id }, res);
    if (!links) return;
    let { image_url: imageUrl, thumb_url: thumbUrl, width, height, transform: transformJson, status } = row;
    if (body.transform !== undefined) {
      const stencil = stencilOf.get(row.stencil_id);
      if (!stencil || stencil.status !== 'ready') return res.status(400).json({ error: 'The stencil behind this placement is gone; make a new placement.' });
      const transform = normaliseTransform(body.transform);
      const result = await render(localFile(row.photo_url), localFile(stencil.image_url), transform);
      const files = await writeRender(result);
      removeByUrl(row.image_url);
      ({ url: imageUrl, thumb_url: thumbUrl } = files);
      ({ width, height } = result);
      transformJson = JSON.stringify(transform);
      if (status !== 'draft') status = 'draft';
    }
    if (links.client_id !== row.client_id && status !== 'draft') status = 'draft';
    updateMockup.run({
      id: row.id, client_id: links.client_id, appointment_id: links.appointment_id,
      title: body.title === undefined ? row.title : (String(body.title).trim().slice(0, 120) || row.title),
      transform: transformJson, image_url: imageUrl, thumb_url: thumbUrl, width, height, status,
    });
    res.json({ mockup: shape(getMockup.get(row.id), req.user) });
  } catch (err) { next(err); }
});

/** Send to the client: a message with the preview, plus a notification. */
router.post('/:id/send', requireRole('artist'), (req, res) => {
  const row = own(req, res);
  if (!row) return;
  if (!row.client_id) return res.status(400).json({ error: 'Choose which client this placement is for first.' });
  markSent.run(row.id);
  const fresh = getMockup.get(row.id);
  const note = String((req.body || {}).message || '').trim().slice(0, 500);
  sendMessage(req.user.id, row.client_id, note || `Here is how "${row.title}" would sit. Have a look and let me know.`, fresh);
  mailer.notify(mailer.templates.mockupSent(fresh, req.user));
  res.json({ mockup: shape(fresh, req.user) });
});

/** The client's answer. */
router.post('/:id/respond', requireRole('client'), (req, res) => {
  const row = getMockup.get(req.params.id);
  if (!row || row.client_id !== req.user.id || row.status === 'draft') return res.status(404).json({ error: 'Placement not found.' });
  const status = (req.body || {}).status;
  if (!['approved', 'changes'].includes(status)) return res.status(400).json({ error: 'Approve it, or ask for changes.' });
  const note = String((req.body || {}).note || '').trim().slice(0, 500);
  if (status === 'changes' && !note) return res.status(400).json({ error: 'Tell the artist what to change.' });
  markResponded.run(status, note || null, row.id);
  const fresh = getMockup.get(row.id);
  sendMessage(req.user.id, row.artist_id, status === 'approved' ? `Approved the placement for "${row.title}".${note ? ` ${note}` : ''}` : `Could you adjust the placement for "${row.title}"? ${note}`, fresh);
  mailer.notify(mailer.templates.mockupResponse(fresh, req.user));
  res.json({ mockup: shape(fresh, req.user) });
});

router.delete('/:id', requireRole('artist'), (req, res) => {
  const row = own(req, res);
  if (!row) return;
  deleteMockup.run(row.id);
  removeByUrl(row.image_url);
  // The photo was uploaded for placements; drop it once no other placement uses it.
  if (/\/uploads\//.test(row.photo_url) && otherPhotoUses.get(row.photo_url, row.id).n === 0 && !requestUsesPhoto(row.photo_url)) removeByUrl(row.photo_url);
  res.json({ ok: true });
});

const requestPhoto = db.prepare('SELECT 1 FROM tattoo_requests WHERE reference_image_url = ? LIMIT 1');
const requestUsesPhoto = (url) => !!requestPhoto.get(url);

module.exports = { router, render, normaliseTransform, latestForAppointment, attachment, COLORS, DEFAULT_TRANSFORM };
