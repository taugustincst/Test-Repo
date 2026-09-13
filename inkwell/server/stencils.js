'use strict';

/**
 * Stencil library. Every piece an artist uploads (gallery work, flash, or an image dropped into
 * the library) gets a line-art stencil derived from it: edges are pulled out of the image, kept
 * where they are strongest, thickened slightly and written as black lines on a transparent PNG.
 * Generation is passive: uploads are queued and processed in the background, and the scheduler
 * backfills anything that was uploaded before the library existed. Stencils download at real
 * print size (300 dpi) and can be mirrored for thermal transfer paper.
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const { db } = require('./db');
const { requireRole } = require('./auth');
const { upload, removeByUrl, UPLOAD_DIR, publicUrl } = require('./upload');
const { processArtwork } = require('./images');

const MAX_EDGE = 1400;
const DEFAULT_DETAIL = 3;
const DPI = 300;
const MAX_PRINT_PX = 6000;
const BACKFILL_PER_RUN = Number(process.env.INKWELL_STENCIL_BACKFILL) || 20;
const SOURCES = ['artwork', 'flash', 'upload'];

// Per detail level: pre-blur (less blur keeps finer lines), share of strongest edge pixels kept,
// and how many passes of line thickening are applied so lines survive printing and transfer.
const LEVELS = {
  1: { blur: 2.4, keep: 0.030, thicken: 1 },
  2: { blur: 1.8, keep: 0.045, thicken: 1 },
  3: { blur: 1.2, keep: 0.065, thicken: 1 },
  4: { blur: 0.8, keep: 0.095, thicken: 0 },
  5: { blur: 0.5, keep: 0.140, thicken: 0 },
};
// Edge strength below this (Sobel magnitude, 0..1443) is noise, whatever the percentile says.
const EDGE_FLOOR = 48;
// Never cut above this share of the strongest edge: sparse line art keeps all its real lines.
const EDGE_CEIL_SHARE = 0.3;

/* ---------- rendering ---------- */

function localFile(url) {
  if (!url || !url.startsWith('/uploads/')) return null;
  return path.join(UPLOAD_DIR, path.basename(url));
}

/**
 * Turn an image file into stencil pixels. Returns { png, width, height, ink } where ink is the
 * share of pixels that carry a line (used to reject blank or noisy results).
 */
async function renderStencil(file, { detail = DEFAULT_DETAIL } = {}) {
  const level = LEVELS[detail] || LEVELS[DEFAULT_DETAIL];
  const { data, info } = await sharp(file, { pages: 1, failOn: 'error' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .normalise()
    .blur(level.blur)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;

  // Sobel gradient magnitude: how strongly the tone changes at each pixel.
  const mag = new Uint16Array(n);
  const hist = new Uint32Array(1500);
  let maxMag = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = data[i - width - 1]; const t = data[i - width]; const tr = data[i - width + 1];
      const l = data[i - 1]; const r = data[i + 1];
      const bl = data[i + width - 1]; const b = data[i + width]; const br = data[i + width + 1];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      const m = Math.round(Math.sqrt(gx * gx + gy * gy));
      mag[i] = m;
      hist[m] += 1;
      if (m > maxMag) maxMag = m;
    }
  }

  // Keep the strongest `keep` share of pixels, but never drop real lines in sparse art (ceiling)
  // and never promote sensor noise to a line (floor).
  const wanted = Math.max(1, Math.round(n * level.keep));
  let cutoff = EDGE_FLOOR;
  let seen = 0;
  for (let v = maxMag; v > EDGE_FLOOR; v -= 1) { seen += hist[v]; if (seen >= wanted) { cutoff = v; break; } }
  cutoff = Math.max(EDGE_FLOOR, Math.min(cutoff, Math.round(maxMag * EDGE_CEIL_SHARE)));
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mask[i] = mag[i] >= cutoff ? 1 : 0;

  // Thicken lines so they survive printing and transfer.
  let lines = mask;
  for (let pass = 0; pass < level.thicken; pass += 1) {
    const next = new Uint8Array(lines);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        if (lines[i]) continue;
        if (lines[i - 1] || lines[i + 1] || lines[i - width] || lines[i + width]) next[i] = 1;
      }
    }
    lines = next;
  }
  // The picture's own border is not a line (the blur smears the edge rows, so clear a margin).
  const margin = Math.ceil(level.blur * 3) + 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < margin || y < margin || x >= width - margin || y >= height - margin) lines[y * width + x] = 0;
    }
  }

  const rgba = Buffer.alloc(n * 4);
  let inkCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (lines[i]) { rgba[i * 4 + 3] = 255; inkCount += 1; }
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, width, height, ink: inkCount / n };
}

/** Write the stencil PNG and a thumbnail (lines on white) into the uploads directory. */
async function writeStencilFiles(png) {
  const base = `stencil-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await fs.writeFile(path.join(UPLOAD_DIR, `${base}.png`), png);
  await sharp(png).flatten({ background: '#ffffff' }).resize({ width: 480, withoutEnlargement: true }).webp({ quality: 80 }).toFile(path.join(UPLOAD_DIR, `${base}.thumb.webp`));
  return { url: publicUrl(`${base}.png`), thumb_url: publicUrl(`${base}.thumb.webp`) };
}

/* ---------- queue ---------- */

const insertStencil = db.prepare(`
  INSERT OR IGNORE INTO stencils (artist_id, source_type, source_id, source_url, title, detail, status)
  VALUES (?, ?, ?, ?, ?, ?, 'pending')
`);
const STENCIL_SELECT = `SELECT s.*, a.gallery_id AS artwork_gallery_id FROM stencils s LEFT JOIN artworks a ON s.source_type = 'artwork' AND a.id = s.source_id`;
const getStencil = db.prepare(`${STENCIL_SELECT} WHERE s.id = ?`);
const bySource = db.prepare('SELECT * FROM stencils WHERE source_type = ? AND source_id = ?');
const pendingRows = db.prepare(`SELECT * FROM stencils WHERE status = 'pending' ORDER BY id ASC LIMIT ?`);
const markReady = db.prepare(`UPDATE stencils SET status = 'ready', image_url = ?, thumb_url = ?, width = ?, height = ?, ink = ?, error = NULL, generated_at = datetime('now') WHERE id = ?`);
const markFailed = db.prepare(`UPDATE stencils SET status = 'failed', error = ?, generated_at = datetime('now') WHERE id = ?`);
const setPending = db.prepare(`UPDATE stencils SET status = 'pending', detail = ?, error = NULL WHERE id = ?`);
const artworksWithout = db.prepare(`
  SELECT a.id, a.artist_id, a.image_url, a.title FROM artworks a JOIN users u ON u.id = a.artist_id
  WHERE u.suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM stencils s WHERE s.source_type = 'artwork' AND s.source_id = a.id)
  ORDER BY a.id DESC LIMIT ?
`);
const flashWithout = db.prepare(`
  SELECT f.id, f.artist_id, f.image_url, f.title FROM flash_designs f JOIN users u ON u.id = f.artist_id
  WHERE u.suspended_at IS NULL AND NOT EXISTS (SELECT 1 FROM stencils s WHERE s.source_type = 'flash' AND s.source_id = f.id)
  ORDER BY f.id DESC LIMIT ?
`);
const listMine = db.prepare(`${STENCIL_SELECT} WHERE s.artist_id = ? ORDER BY s.favorite DESC, s.created_at DESC, s.id DESC`);
const countsMine = db.prepare(`
  SELECT SUM(status = 'ready') AS ready, SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed, SUM(favorite) AS favorites, COUNT(*) AS total
  FROM stencils WHERE artist_id = ?
`);
const updateMeta = db.prepare('UPDATE stencils SET title = ?, favorite = ? WHERE id = ?');
const deleteStencil = db.prepare('DELETE FROM stencils WHERE id = ?');
const deleteBySource = db.prepare('DELETE FROM stencils WHERE source_type = ? AND source_id = ? RETURNING image_url, thumb_url, source_url');

/** Queue a stencil for a piece. Safe to call twice; the second call is a no-op. */
function enqueue(artistId, sourceType, sourceId, sourceUrl, title, detail = DEFAULT_DETAIL) {
  if (!SOURCES.includes(sourceType)) throw new Error('Unknown stencil source.');
  insertStencil.run(artistId, sourceType, sourceId, sourceUrl, String(title || 'Untitled').slice(0, 120), detail);
  return bySource.get(sourceType, sourceId);
}

/** Generate one queued stencil now. */
async function processOne(row) {
  const file = localFile(row.source_url);
  try {
    if (!file) throw new Error('Source image is not available.');
    const result = await renderStencil(file, { detail: row.detail });
    if (result.ink < 0.002) throw new Error('Not enough contrast to trace. Try a higher detail level or a cleaner image.');
    if (result.ink > 0.6) throw new Error('The image is too busy to trace cleanly. Try a lower detail level.');
    const files = await writeStencilFiles(result.png);
    const old = getStencil.get(row.id);
    if (old && old.image_url) removeByUrl(old.image_url);
    markReady.run(files.url, files.thumb_url, result.width, result.height, Number(result.ink.toFixed(4)), row.id);
    return { ok: true };
  } catch (err) {
    markFailed.run(String(err.message || err).slice(0, 200), row.id);
    return { ok: false, error: err.message };
  }
}

let running = false;
/** Work through the queue, one at a time so image processing never floods the CPU. */
async function processPending(limit = 10) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    for (const row of pendingRows.all(limit)) { await processOne(row); done += 1; }
  } finally { running = false; }
  return done;
}

/** Queue stencils for pieces that do not have one yet, then process a batch. Called by the scheduler. */
async function backfill(limit = BACKFILL_PER_RUN) {
  let queued = 0;
  for (const a of artworksWithout.all(limit)) { enqueue(a.artist_id, 'artwork', a.id, a.image_url, a.title); queued += 1; }
  for (const f of flashWithout.all(Math.max(0, limit - queued))) { enqueue(f.artist_id, 'flash', f.id, f.image_url, f.title); queued += 1; }
  const processed = await processPending(limit);
  return { queued, processed };
}

/** Fire-and-forget: queue and start processing without holding up a request. */
function kick(artistId, sourceType, sourceId, sourceUrl, title) {
  try { enqueue(artistId, sourceType, sourceId, sourceUrl, title); } catch (err) { console.error('[stencils] enqueue', err.message); return; }
  setImmediate(() => { processPending(5).catch((err) => console.error('[stencils]', err.message)); });
}

/** A piece was deleted: drop its stencil and files. */
function dropSource(sourceType, sourceId) {
  for (const row of deleteBySource.all(sourceType, sourceId)) {
    removeByUrl(row.image_url);
    if (sourceType === 'upload') removeByUrl(row.source_url);
  }
}

/* ---------- shaping and routes ---------- */

function shape(row) {
  return {
    id: row.id,
    source_type: row.source_type,
    source_id: row.source_id,
    source_url: row.source_url,
    source_link: row.source_type === 'flash' ? `/flash/${row.source_id}` : (row.source_type === 'artwork' && row.artwork_gallery_id ? `/galleries/${row.artwork_gallery_id}` : null),
    title: row.title,
    detail: row.detail,
    status: row.status,
    error: row.error,
    image_url: row.image_url,
    thumb_url: row.thumb_url,
    width: row.width,
    height: row.height,
    ink: row.ink,
    favorite: !!row.favorite,
    generated_at: row.generated_at,
    created_at: row.created_at,
    print_url: row.status === 'ready' ? `/api/stencils/${row.id}/print.png` : null,
  };
}

const router = express.Router();
router.use(requireRole('artist'));

function own(req, res) {
  const row = getStencil.get(req.params.id);
  if (!row || row.artist_id !== req.user.id) { res.status(404).json({ error: 'Stencil not found.' }); return null; }
  return row;
}

router.get('/', (req, res) => {
  let rows = listMine.all(req.user.id);
  if (SOURCES.includes(req.query.source)) rows = rows.filter((r) => r.source_type === req.query.source);
  if (req.query.favorites === '1') rows = rows.filter((r) => r.favorite);
  const counts = countsMine.get(req.user.id);
  res.json({ stencils: rows.map(shape), counts: { ready: counts.ready || 0, pending: counts.pending || 0, failed: counts.failed || 0, favorites: counts.favorites || 0, total: counts.total || 0 }, levels: Object.keys(LEVELS).map(Number), dpi: DPI });
});

/** Queue every piece of mine that has no stencil yet and process a batch now. */
router.post('/backfill', async (req, res, next) => {
  try {
    let queued = 0;
    for (const a of artworksWithout.all(500).filter((x) => x.artist_id === req.user.id)) { enqueue(a.artist_id, 'artwork', a.id, a.image_url, a.title); queued += 1; }
    for (const f of flashWithout.all(500).filter((x) => x.artist_id === req.user.id)) { enqueue(f.artist_id, 'flash', f.id, f.image_url, f.title); queued += 1; }
    const processed = await processPending(25);
    res.json({ queued, processed });
  } catch (err) { next(err); }
});

/** Drop any image into the library. The original is kept as the source so detail can be changed later. */
router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an image to trace.' });
    let image;
    try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
    const detail = Number((req.body || {}).detail) || DEFAULT_DETAIL;
    const info = db.prepare(`INSERT INTO stencils (artist_id, source_type, source_id, source_url, title, detail, status) VALUES (?, 'upload', 0, ?, ?, ?, 'pending')`)
      .run(req.user.id, image.url, String((req.body || {}).title || req.file.originalname.replace(/\.[a-z0-9]+$/i, '') || 'Stencil').slice(0, 120), LEVELS[detail] ? detail : DEFAULT_DETAIL);
    db.prepare('UPDATE stencils SET source_id = id WHERE id = ?').run(info.lastInsertRowid);
    removeByUrl(image.thumb_url);
    await processOne(getStencil.get(info.lastInsertRowid));
    res.status(201).json({ stencil: shape(getStencil.get(info.lastInsertRowid)) });
  } catch (err) { next(err); }
});

router.get('/:id', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  res.json({ stencil: shape(row) });
});

/** Rename, favourite, or change the detail level (which regenerates). */
router.put('/:id', async (req, res, next) => {
  try {
    const row = own(req, res);
    if (!row) return;
    const b = req.body || {};
    const title = b.title === undefined ? row.title : String(b.title || '').trim().slice(0, 120) || row.title;
    const favorite = b.favorite === undefined ? row.favorite : (b.favorite ? 1 : 0);
    updateMeta.run(title, favorite, row.id);
    if (b.detail !== undefined) {
      const detail = Number(b.detail);
      if (!LEVELS[detail]) return res.status(400).json({ error: 'Detail is a level from 1 to 5.' });
      setPending.run(detail, row.id);
      await processOne(getStencil.get(row.id));
    }
    res.json({ stencil: shape(getStencil.get(row.id)) });
  } catch (err) { next(err); }
});

router.post('/:id/regenerate', async (req, res, next) => {
  try {
    const row = own(req, res);
    if (!row) return;
    setPending.run(row.detail, row.id);
    await processOne(getStencil.get(row.id));
    res.json({ stencil: shape(getStencil.get(row.id)) });
  } catch (err) { next(err); }
});

router.delete('/:id', (req, res) => {
  const row = own(req, res);
  if (!row) return;
  deleteStencil.run(row.id);
  removeByUrl(row.image_url);
  if (row.source_type === 'upload') removeByUrl(row.source_url);
  res.json({ ok: true });
});

/** The stencil at real size: width_cm or height_cm at 300 dpi, black on white, optionally mirrored. */
router.get('/:id/print.png', async (req, res, next) => {
  try {
    const row = own(req, res);
    if (!row) return;
    if (row.status !== 'ready') return res.status(409).json({ error: 'This stencil is not ready yet.' });
    const dpi = Math.min(600, Math.max(72, Number(req.query.dpi) || DPI));
    const widthCm = Number(req.query.width_cm) || 0;
    const heightCm = Number(req.query.height_cm) || 0;
    const mirror = req.query.mirror === '1';
    const transparent = req.query.transparent === '1';
    let image = sharp(localFile(row.image_url));
    if (widthCm > 0 || heightCm > 0) {
      const px = (cm) => Math.min(MAX_PRINT_PX, Math.max(50, Math.round((cm / 2.54) * dpi)));
      image = image.resize({ width: widthCm > 0 ? px(widthCm) : undefined, height: heightCm > 0 ? px(heightCm) : undefined, fit: 'inside', kernel: 'lanczos3' });
    }
    if (mirror) image = image.flop();
    if (!transparent) image = image.flatten({ background: '#ffffff' });
    const buf = await image.png({ compressionLevel: 6 }).withMetadata({ density: dpi }).toBuffer();
    const name = `${row.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'stencil'}${widthCm ? `-${widthCm}cm` : ''}${mirror ? '-mirrored' : ''}.png`;
    res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-cache' }).send(buf);
  } catch (err) { next(err); }
});

module.exports = { router, renderStencil, enqueue, processPending, backfill, kick, dropSource, LEVELS, DEFAULT_DETAIL, DPI, BACKFILL_PER_RUN };
