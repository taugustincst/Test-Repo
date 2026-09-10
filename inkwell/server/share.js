'use strict';

/**
 * Portfolio sharing: share-card images for link previews (1200x630, rendered with sharp), QR
 * codes for printed material and studio counters, and the embeddable portfolio widget.
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const QRCode = require('qrcode');
const { db } = require('./db');
const { UPLOAD_DIR } = require('./upload');

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const W = 1200;
const H = 630;
const SURFACE = '#151517';
const CARD_CACHE_MAX = 200;
const cards = new Map(); // key -> { buf, at }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const q = {
  artist: db.prepare(`
    SELECT u.id, u.name, u.avatar_url, u.location, p.studio_name, p.styles,
           (SELECT COUNT(*) FROM artworks a WHERE a.artist_id = u.id) AS artwork_count,
           (SELECT ROUND(AVG(rating), 1) FROM reviews r WHERE r.artist_id = u.id) AS rating,
           (SELECT COUNT(*) FROM reviews r WHERE r.artist_id = u.id) AS review_count,
           (SELECT COALESCE(a.thumb_url, a.image_url) FROM artworks a WHERE a.artist_id = u.id ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) DESC, a.created_at DESC LIMIT 1) AS cover,
           MAX(u.created_at, COALESCE((SELECT MAX(created_at) FROM artworks a WHERE a.artist_id = u.id), '')) AS version
    FROM users u JOIN artist_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'artist' AND u.suspended_at IS NULL
  `),
  artistWork: db.prepare(`
    SELECT a.id, a.title, a.style, a.image_url, a.thumb_url FROM artworks a WHERE a.artist_id = ?
    ORDER BY (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) DESC, a.created_at DESC LIMIT ?
  `),
  artwork: db.prepare(`
    SELECT a.id, a.title, a.style, a.placement, a.image_url, a.thumb_url, a.created_at AS version, u.name AS artist_name, p.studio_name
    FROM artworks a JOIN users u ON u.id = a.artist_id JOIN artist_profiles p ON p.user_id = u.id WHERE a.id = ? AND u.suspended_at IS NULL
  `),
  gallery: db.prepare(`
    SELECT g.id, g.title, g.description, u.name AS artist_name,
           (SELECT COUNT(*) FROM artworks a WHERE a.gallery_id = g.id) AS artwork_count,
           (SELECT COALESCE(a.thumb_url, a.image_url) FROM artworks a WHERE a.gallery_id = g.id ORDER BY a.created_at DESC LIMIT 1) AS cover,
           COALESCE((SELECT MAX(created_at) FROM artworks a WHERE a.gallery_id = g.id), g.created_at) AS version
    FROM galleries g JOIN users u ON u.id = g.artist_id WHERE g.id = ? AND u.suspended_at IS NULL
  `),
  collection: db.prepare(`
    SELECT c.id, c.title, c.description, c.token, c.is_public, c.updated_at AS version, u.name AS owner_name,
           (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
    FROM collections c JOIN users u ON u.id = c.user_id WHERE c.token = ?
  `),
  collectionCovers: db.prepare(`
    SELECT COALESCE(a.thumb_url, a.image_url) AS url FROM collection_items ci JOIN artworks a ON a.id = ci.artwork_id
    WHERE ci.collection_id = ? ORDER BY ci.created_at DESC LIMIT 3
  `),
};

/* ---------- image helpers ---------- */

function localFile(url) {
  if (!url) return null;
  if (url.startsWith('/uploads/')) return path.join(UPLOAD_DIR, path.basename(url));
  if (url.startsWith('/')) return path.join(PUBLIC_DIR, url.slice(1));
  return null;
}

async function tile(url, width, height, { round = false } = {}) {
  const file = localFile(url);
  let img;
  try {
    if (!file || !fs.existsSync(file)) throw new Error('missing');
    img = await sharp(file, { pages: 1 }).rotate().resize({ width, height, fit: 'cover' }).png().toBuffer();
  } catch {
    img = await sharp({ create: { width, height, channels: 3, background: '#26262c' } }).png().toBuffer();
  }
  if (!round) return img;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${width / 2}"/></svg>`);
  return sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function wrap(text, maxChars, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  return lines;
}

function textPanel({ x, eyebrow, title, lines = [], footer }) {
  const titleLines = wrap(title, 22, 2);
  const titleSize = titleLines.some((l) => l.length > 16) ? 56 : 66;
  let y = 150;
  const parts = [];
  if (eyebrow) { parts.push(`<text x="${x}" y="${y}" class="eyebrow">${esc(eyebrow)}</text>`); y += 62; }
  titleLines.forEach((l) => { parts.push(`<text x="${x}" y="${y}" class="title" font-size="${titleSize}">${esc(l)}</text>`); y += titleSize + 8; });
  y += 18;
  lines.filter(Boolean).forEach((l) => { parts.push(`<text x="${x}" y="${y}" class="line">${esc(l)}</text>`); y += 40; });
  if (footer) parts.push(`<text x="${x}" y="${H - 58}" class="footer">${esc(footer)}</text>`);
  return parts.join('');
}

function svgOverlay(inner) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <style>
      text { font-family: 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif; }
      .eyebrow { font-size: 26px; fill: #c9a24a; letter-spacing: 3px; font-weight: 600; }
      .title { fill: #f3efe6; font-weight: 700; }
      .line { font-size: 30px; fill: #b9b3a8; }
      .footer { font-size: 26px; fill: #7c766d; }
      .brand { font-size: 30px; fill: #f3efe6; font-weight: 700; }
    </style>
    ${inner}
    <circle cx="${W - 166}" cy="58" r="12" fill="#d4553f"/>
    <text x="${W - 144}" y="69" class="brand">Inkwell</text>
  </svg>`);
}

async function compose(parts) {
  const key = parts.key;
  const hit = cards.get(key);
  if (hit) return hit;
  const base = sharp({ create: { width: W, height: H, channels: 3, background: SURFACE } });
  const layers = [...parts.layers, { input: svgOverlay(parts.svg), top: 0, left: 0 }];
  const buf = await base.composite(layers).png({ compressionLevel: 8 }).toBuffer();
  if (cards.size >= CARD_CACHE_MAX) cards.delete(cards.keys().next().value);
  cards.set(key, buf);
  return buf;
}

/* ---------- cards ---------- */

async function artistCard(id) {
  const a = q.artist.get(id);
  if (!a) return null;
  const styles = (() => { try { return JSON.parse(a.styles || '[]'); } catch { return []; } })();
  const work = q.artistWork.all(a.id, 4);
  const layers = [];
  // Left: a 2x2 grid of the most liked pieces, or one large cover.
  if (work.length >= 4) {
    for (let i = 0; i < 4; i += 1) layers.push({ input: await tile(work[i].thumb_url || work[i].image_url, 270, 315), top: Math.floor(i / 2) * 315, left: (i % 2) * 270 });
  } else {
    layers.push({ input: await tile(a.cover || a.avatar_url, 540, H), top: 0, left: 0 });
  }
  layers.push({ input: await tile(a.avatar_url, 96, 96, { round: true }), top: H - 150, left: 600 });
  const rating = a.review_count ? `★ ${a.rating} · ${a.review_count} review${a.review_count === 1 ? '' : 's'}` : null;
  const svg = `${textPanel({ x: 600, eyebrow: 'TATTOO ARTIST', title: a.name, lines: [[a.studio_name, a.location].filter(Boolean).join(' · '), styles.slice(0, 4).join(' · '), rating || `${a.artwork_count} pieces`], footer: null })}
    <text x="720" y="${H - 92}" class="line" fill="#f3efe6">${esc(a.name)}</text>
    <text x="720" y="${H - 58}" class="footer">Book a session on Inkwell</text>`;
  return compose({ key: `artist:${a.id}:${a.version}`, layers, svg });
}

async function artworkCard(id) {
  const a = q.artwork.get(id);
  if (!a) return null;
  const layers = [{ input: await tile(a.image_url, 630, H), top: 0, left: 0 }];
  const svg = `${textPanel({ x: 690, eyebrow: (a.style || 'TATTOO').toUpperCase(), title: a.title, lines: [`by ${a.artist_name}`, [a.studio_name, a.placement].filter(Boolean).join(' · ')], footer: 'See more and book on Inkwell' })}`;
  return compose({ key: `artwork:${a.id}:${a.version}`, layers, svg });
}

async function galleryCard(id) {
  const g = q.gallery.get(id);
  if (!g) return null;
  const layers = [{ input: await tile(g.cover, 630, H), top: 0, left: 0 }];
  const svg = `${textPanel({ x: 690, eyebrow: 'GALLERY', title: g.title, lines: [`by ${g.artist_name}`, `${g.artwork_count} piece${g.artwork_count === 1 ? '' : 's'}`], footer: 'See the full gallery on Inkwell' })}`;
  return compose({ key: `gallery:${g.id}:${g.version}`, layers, svg });
}

async function collectionCard(token) {
  const c = q.collection.get(token);
  if (!c || !c.is_public) return null;
  const covers = q.collectionCovers.all(c.id);
  const layers = [];
  if (covers.length >= 3) {
    layers.push({ input: await tile(covers[0].url, 360, H), top: 0, left: 0 });
    layers.push({ input: await tile(covers[1].url, 180, 315), top: 0, left: 360 });
    layers.push({ input: await tile(covers[2].url, 180, 315), top: 315, left: 360 });
  } else {
    layers.push({ input: await tile(covers[0] ? covers[0].url : null, 540, H), top: 0, left: 0 });
  }
  const svg = `${textPanel({ x: 600, eyebrow: 'REFERENCE BOARD', title: c.title, lines: [`${c.item_count} saved piece${c.item_count === 1 ? '' : 's'}`, `by ${c.owner_name}`], footer: 'Shared from Inkwell' })}`;
  return compose({ key: `collection:${c.id}:${c.version}:${c.item_count}`, layers, svg });
}

/* ---------- QR ---------- */

/** SVG QR code for an Inkwell URL. Only app URLs are encoded so the endpoint cannot be abused. */
async function qrSvg(target) {
  const url = /^https?:\/\//.test(target) ? target : `${APP_URL}${target.startsWith('/') ? '' : '/'}${target}`;
  if (!url.startsWith(`${APP_URL}/`) && url !== APP_URL) return null;
  return QRCode.toString(url, { type: 'svg', margin: 1, width: 320, color: { dark: '#151517', light: '#ffffff' } });
}

/* ---------- embed widget ---------- */

function embedHtml(id, opts = {}) {
  const a = q.artist.get(id);
  if (!a) return null;
  const limit = Math.min(12, Math.max(3, Number(opts.limit) || 6));
  const work = q.artistWork.all(a.id, limit);
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const colors = theme === 'light' ? { bg: '#ffffff', fg: '#1a1a1c', muted: '#6b6760', line: '#e7e2d8' } : { bg: '#151517', fg: '#f3efe6', muted: '#9a948a', line: '#2a2a31' };
  const url = `${APP_URL}/artists/${a.id}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(a.name)} on Inkwell</title>
<style>
  :root { color-scheme: ${theme}; }
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; background: ${colors.bg}; color: ${colors.fg}; }
  .w { padding: 14px; }
  .h { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .h img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
  .h strong { display: block; font-size: 15px; }
  .h span { color: ${colors.muted}; font-size: 12px; }
  .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .g a { display: block; aspect-ratio: 1; overflow: hidden; border-radius: 8px; background: ${colors.line}; }
  .g img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
  .g a:hover img { transform: scale(1.04); }
  .f { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 12px; color: ${colors.muted}; }
  .b { display: inline-block; padding: 8px 14px; border-radius: 999px; background: #d4553f; color: #fff; text-decoration: none; font-weight: 600; font-size: 13px; }
  a { color: inherit; }
</style></head>
<body><div class="w">
  <div class="h"><img src="${esc(a.avatar_url || '/icon-192.png')}" alt=""><div><strong>${esc(a.name)}</strong><span>${esc([a.studio_name, a.location].filter(Boolean).join(' · '))}${a.review_count ? ` · ★ ${a.rating} (${a.review_count})` : ''}</span></div></div>
  <div class="g">${work.map((w) => `<a href="${esc(`${APP_URL}/artworks/${w.id}`)}" target="_blank" rel="noopener" title="${esc(w.title)}"><img src="${esc(w.thumb_url || w.image_url)}" alt="${esc(w.title)}" loading="lazy"></a>`).join('')}</div>
  <div class="f"><a href="${esc(url)}" target="_blank" rel="noopener">${a.artwork_count} pieces on Inkwell</a><a class="b" href="${esc(`${APP_URL}/book/${a.id}`)}" target="_blank" rel="noopener">Book a session</a></div>
</div></body></html>`;
}

function clearCache() { cards.clear(); }

module.exports = { artistCard, artworkCard, galleryCard, collectionCard, qrSvg, embedHtml, clearCache, W, H, APP_URL };
