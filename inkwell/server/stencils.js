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
// Bump when the tracing changes: stencils traced by an older version are re-traced by the scheduler.
const ALGO_VERSION = 2;
const DEFAULT_DETAIL = 3;
const DPI = 300;
const MAX_PRINT_PX = 6000;
const BACKFILL_PER_RUN = Number(process.env.INKWELL_STENCIL_BACKFILL) || 20;
const SOURCES = ['artwork', 'flash', 'upload', 'reference'];

// Per detail level: pre-blur for edge finding (less blur keeps finer edges), share of the picture
// allowed to become edge lines and stroke lines, the smallest blob kept (despeckling, in pixels
// at the working size) and how many passes of line thickening are applied so lines survive
// printing and transfer.
const LEVELS = {
  1: { blur: 2.2, edges: 0.012, strokes: 0.020, speck: 40, thicken: 2 },
  2: { blur: 1.6, edges: 0.020, strokes: 0.030, speck: 28, thicken: 2 },
  3: { blur: 1.1, edges: 0.030, strokes: 0.045, speck: 18, thicken: 1 },
  4: { blur: 0.8, edges: 0.045, strokes: 0.060, speck: 14, thicken: 1 },
  5: { blur: 0.5, edges: 0.070, strokes: 0.080, speck: 12, thicken: 1 },
};
// Edge strength below this (Sobel magnitude, 0..1443) is noise, whatever the percentile says.
const EDGE_FLOOR = 48;
// Stroke contrast (0..255) below this is paper texture, not ink.
const STROKE_FLOOR = 48;
// Never cut above this share of the strongest response: sparse line art keeps all its real lines.
const CEIL_SHARE = 0.3;
// Strokes up to this many pixels wide (at the working size) are traced as strokes, not as two edges.
const STROKE_RADIUS = 5;

/* ---------- rendering ---------- */

function localFile(url) {
  if (!url || !url.startsWith('/uploads/')) return null;
  return path.join(UPLOAD_DIR, path.basename(url));
}

/**
 * Running min or max over a window of 2r+1 along one line (van Herk / Gil-Werman): the line is cut
 * into blocks of the window size, a forward and a backward running extreme are computed per block,
 * and each output is the extreme of two lookups, whatever the radius.
 */
function extremeLine(src, out, offset, stride, len, r, useMax, fwd, bwd) {
  const w = 2 * r + 1;
  for (let b = 0; b < len; b += w) {
    const end = Math.min(len, b + w);
    let v = src[offset + b * stride];
    fwd[b] = v;
    for (let i = b + 1; i < end; i += 1) { const c = src[offset + i * stride]; if (useMax ? c > v : c < v) v = c; fwd[i] = v; }
    v = src[offset + (end - 1) * stride];
    bwd[end - 1] = v;
    for (let i = end - 2; i >= b; i -= 1) { const c = src[offset + i * stride]; if (useMax ? c > v : c < v) v = c; bwd[i] = v; }
  }
  for (let i = 0; i < len; i += 1) {
    const lo = Math.max(0, i - r); const hi = Math.min(len - 1, i + r);
    // The window [lo, hi] spans at most two blocks: bwd[lo] covers lo to the end of its block,
    // fwd[hi] covers the start of hi's block to hi. When both fall in one block, take that part only.
    const sameBlock = Math.floor(lo / w) === Math.floor(hi / w);
    let v;
    if (sameBlock) {
      v = src[offset + lo * stride];
      for (let k = lo + 1; k <= hi; k += 1) { const c = src[offset + k * stride]; if (useMax ? c > v : c < v) v = c; }
    } else {
      const a = bwd[lo]; const c = fwd[hi];
      v = useMax ? (a > c ? a : c) : (a < c ? a : c);
    }
    out[offset + i * stride] = v;
  }
}

/** Separable square min or max filter (greyscale erosion / dilation) with radius r. */
function rankFilter(src, width, height, r, useMax) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const len = Math.max(width, height);
  const fwd = new Uint8Array(len);
  const bwd = new Uint8Array(len);
  for (let y = 0; y < height; y += 1) extremeLine(src, tmp, y * width, 1, width, r, useMax, fwd, bwd);
  for (let x = 0; x < width; x += 1) extremeLine(tmp, out, x, width, height, r, useMax, fwd, bwd);
  return out;
}

/**
 * Pick a cutoff for a response map: the strongest `share` of candidate pixels, but never below
 * `floor` (noise) and never above CEIL_SHARE of the strongest response (sparse art keeps its lines).
 */
function cutoffFor(hist, maxValue, candidates, share, floor) {
  const wanted = Math.max(1, Math.round(candidates * share));
  let cutoff = floor;
  let seen = 0;
  for (let v = maxValue; v > floor; v -= 1) { seen += hist[v]; if (seen >= wanted) { cutoff = v; break; } }
  return Math.max(floor, Math.min(cutoff, Math.round(maxValue * CEIL_SHARE)));
}

/**
 * Edge lines: Sobel gradient, thinned to one pixel along the gradient direction (non-maximum
 * suppression), then thresholded adaptively. Returns a mask.
 */
function edgeMask(data, width, height, level) {
  const n = width * height;
  const gx = new Int16Array(n);
  const gy = new Int16Array(n);
  const mag = new Uint16Array(n);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = data[i - width - 1]; const t = data[i - width]; const tr = data[i - width + 1];
      const l = data[i - 1]; const r = data[i + 1];
      const bl = data[i + width - 1]; const b = data[i + width]; const br = data[i + width + 1];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      gx[i] = dx; gy[i] = dy;
      mag[i] = Math.round(Math.sqrt(dx * dx + dy * dy));
    }
  }
  // Keep only ridge pixels: those at least as strong as their two neighbours across the edge.
  const ridge = new Uint8Array(n);
  const hist = new Uint32Array(1500);
  let maxMag = 0;
  let candidates = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = mag[i];
      if (m < EDGE_FLOOR) continue;
      const ax = Math.abs(gx[i]); const ay = Math.abs(gy[i]);
      let a; let b;
      if (ax > 2.414 * ay) { a = mag[i - 1]; b = mag[i + 1]; } // horizontal gradient: vertical edge
      else if (ay > 2.414 * ax) { a = mag[i - width]; b = mag[i + width]; }
      else if ((gx[i] > 0) === (gy[i] > 0)) { a = mag[i - width - 1]; b = mag[i + width + 1]; }
      else { a = mag[i - width + 1]; b = mag[i + width - 1]; }
      if (m < a || m < b) continue;
      ridge[i] = 1;
      hist[m] += 1;
      candidates += 1;
      if (m > maxMag) maxMag = m;
    }
  }
  const cutoff = cutoffFor(hist, maxMag, n, level.edges, EDGE_FLOOR);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) if (ridge[i] && mag[i] >= cutoff) mask[i] = 1;
  return mask;
}

/**
 * Stroke lines: thin marks of either polarity (dark ink on paper, light lines on a dark ground)
 * found with a morphological top-hat and black-hat, so a pen stroke becomes one line instead of
 * its two edges. Broad areas do not respond, so fills are left to the edge pass.
 */
function strokeMask(data, width, height, level) {
  const n = width * height;
  const opened = rankFilter(rankFilter(data, width, height, STROKE_RADIUS, false), width, height, STROKE_RADIUS, true);
  const closed = rankFilter(rankFilter(data, width, height, STROKE_RADIUS, true), width, height, STROKE_RADIUS, false);
  const hat = new Uint8Array(n);
  const hist = new Uint32Array(256);
  let maxHat = 0;
  for (let i = 0; i < n; i += 1) {
    const h = Math.max(data[i] - opened[i], closed[i] - data[i]);
    hat[i] = h;
    hist[h] += 1;
    if (h > maxHat) maxHat = h;
  }
  const cutoff = cutoffFor(hist, maxHat, n, level.strokes, STROKE_FLOOR);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) if (hat[i] >= cutoff) mask[i] = 1;
  return mask;
}

/** Drop connected blobs smaller than `minArea` pixels (8-connected): dust, grain, JPEG noise. */
function despeckle(mask, width, height, minArea) {
  if (minArea <= 1) return mask;
  const n = width * height;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let start = 0; start < n; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = 0; let count = 0;
    stack[top++] = start; seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      members[count++] = i;
      const x = i % width; const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy; if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx; if (xx < 0 || xx >= width) continue;
          const j = yy * width + xx;
          if (mask[j] && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    if (count < minArea) for (let k = 0; k < count; k += 1) mask[members[k]] = 0;
  }
  return mask;
}

/** One pass of 4-neighbour dilation. */
function thicken(mask, width, height) {
  const next = new Uint8Array(mask);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      if (mask[i]) continue;
      if (mask[i - 1] || mask[i + 1] || mask[i - width] || mask[i + width]) next[i] = 1;
    }
  }
  return next;
}

/**
 * Turn an image file into stencil pixels. Returns { png, width, height, ink } where ink is the
 * share of pixels that carry a line (used to reject blank or noisy results).
 */
async function renderStencil(file, { detail = DEFAULT_DETAIL } = {}) {
  const level = LEVELS[detail] || LEVELS[DEFAULT_DETAIL];
  const base = sharp(file, { pages: 1, failOn: 'error' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .normalise();
  const [{ data: soft, info }, { data: crisp }] = await Promise.all([
    base.clone().blur(level.blur).raw().toBuffer({ resolveWithObject: true }),
    base.clone().median(3).raw().toBuffer({ resolveWithObject: true }),
  ]);
  const { width, height } = info;
  const n = width * height;

  const edges = edgeMask(soft, width, height, level);
  const strokes = strokeMask(crisp, width, height, level);
  let lines = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) lines[i] = edges[i] | strokes[i];
  lines = despeckle(lines, width, height, level.speck);
  for (let pass = 0; pass < level.thicken; pass += 1) lines = thicken(lines, width, height);

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
const markReady = db.prepare(`UPDATE stencils SET status = 'ready', image_url = ?, thumb_url = ?, width = ?, height = ?, ink = ?, algo = ${ALGO_VERSION}, error = NULL, generated_at = datetime('now') WHERE id = ?`);
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
const staleRows = db.prepare(`SELECT id, detail FROM stencils WHERE status = 'ready' AND algo < ? ORDER BY id ASC LIMIT ?`);
const staleMine = db.prepare(`SELECT id, detail FROM stencils WHERE artist_id = ? AND status = 'ready' AND algo < ? ORDER BY id ASC LIMIT ?`);
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
let kickedWhileRunning = false;
/**
 * Work through the queue, one at a time so image processing never floods the CPU. A call that
 * arrives while a run is in progress (an upload during the scheduler's backfill, say) is not
 * lost: the running pass schedules one more pass when it finishes.
 */
async function processPending(limit = 10) {
  if (running) { kickedWhileRunning = true; return 0; }
  running = true;
  kickedWhileRunning = false;
  let done = 0;
  try {
    for (const row of pendingRows.all(limit)) { await processOne(row); done += 1; }
  } finally {
    running = false;
    if (kickedWhileRunning) setImmediate(() => { processPending(Math.max(limit, 10)).catch((err) => console.error('[stencils]', err.message)); });
  }
  return done;
}

/**
 * Queue stencils for pieces that do not have one yet, re-queue stencils traced by an older
 * version of the tracer, then process a batch. Called by the scheduler.
 */
async function backfill(limit = BACKFILL_PER_RUN) {
  let queued = 0;
  for (const a of artworksWithout.all(limit)) { enqueue(a.artist_id, 'artwork', a.id, a.image_url, a.title); queued += 1; }
  for (const f of flashWithout.all(Math.max(0, limit - queued))) { enqueue(f.artist_id, 'flash', f.id, f.image_url, f.title); queued += 1; }
  // A quarter of each run goes to upgrading old traces, so the library improves even while it fills.
  let refreshed = 0;
  for (const row of staleRows.all(ALGO_VERSION, Math.max(1, Math.ceil(limit / 4)))) { setPending.run(row.detail, row.id); refreshed += 1; }
  const processed = await processPending(queued + refreshed);
  return { queued, refreshed, processed };
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

/**
 * Add an image that already lives in the uploads directory to an artist's library and trace it
 * now. `sourceType` 'upload' rows point at themselves; 'reference' rows point at the reference
 * image they were traced from and carry its attribution.
 */
async function createFromFile(artistId, { sourceType = 'upload', sourceId = 0, sourceUrl, title, detail = DEFAULT_DETAIL, attribution = null }) {
  const level = LEVELS[Number(detail)] ? Number(detail) : DEFAULT_DETAIL;
  const info = db.prepare(`INSERT INTO stencils (artist_id, source_type, source_id, source_url, title, detail, status, attribution) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(artistId, sourceType, sourceId, sourceUrl, String(title || 'Stencil').slice(0, 120), level, attribution ? JSON.stringify(attribution) : null);
  if (sourceType === 'upload') db.prepare('UPDATE stencils SET source_id = id WHERE id = ?').run(info.lastInsertRowid);
  await processOne(getStencil.get(info.lastInsertRowid));
  return getStencil.get(info.lastInsertRowid);
}

/* ---------- shaping and routes ---------- */

function shape(row) {
  return {
    id: row.id,
    source_type: row.source_type,
    source_id: row.source_id,
    source_url: row.source_url,
    source_link: row.source_type === 'flash' ? `/flash/${row.source_id}` : (row.source_type === 'artwork' && row.artwork_gallery_id ? `/galleries/${row.artwork_gallery_id}` : null),
    attribution: row.attribution ? JSON.parse(row.attribution) : null,
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
    let refreshed = 0;
    for (const row of staleMine.all(req.user.id, ALGO_VERSION, 25)) { setPending.run(row.detail, row.id); refreshed += 1; }
    const processed = await processPending(25);
    res.json({ queued, refreshed, processed });
  } catch (err) { next(err); }
});

/** Drop any image into the library. The original is kept as the source so detail can be changed later. */
router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an image to trace.' });
    let image;
    try { image = await processArtwork(req.file); } catch (err) { return res.status(400).json({ error: err.message }); }
    removeByUrl(image.thumb_url);
    const row = await createFromFile(req.user.id, { sourceUrl: image.url, title: (req.body || {}).title || req.file.originalname.replace(/\.[a-z0-9]+$/i, ''), detail: (req.body || {}).detail });
    res.status(201).json({ stencil: shape(row) });
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
  if (row.source_type === 'upload' || row.source_type === 'reference') removeByUrl(row.source_url);
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

module.exports = { router, renderStencil, enqueue, processPending, backfill, kick, dropSource, createFromFile, shape, LEVELS, DEFAULT_DETAIL, DPI, BACKFILL_PER_RUN, ALGO_VERSION, rankFilter, despeckle };
