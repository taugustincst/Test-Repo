'use strict';

/**
 * Inspiration: popular tattoo motifs, openly licensed reference images for them, and stencils
 * recreated from those references.
 *
 * "Popular" is measured two ways: what clients on Inkwell are asking for (request titles, flash
 * that gets claimed, pieces that get liked) and a curated list of classic motifs. For each motif
 * the harvester searches openly licensed image sources (Openverse, which aggregates Creative
 * Commons and public-domain images, and Wikimedia Commons), keeps only images whose licence
 * allows reuse and modification, and indexes them locally with a hashed text embedding so the
 * library can be searched by description. The scheduler harvests one motif per run, so the
 * reference library fills itself in the background like the stencil library does.
 *
 * When Claude credentials are configured, retrieved references are handed to Claude to write a
 * short design brief for the artist (retrieval-augmented generation). Without credentials a
 * brief is assembled from the retrieved tags instead. Recreating a reference downloads the
 * image, keeps its attribution, and traces it with the stencil tracer.
 */

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const { requireRole } = require('./auth');
const { UPLOAD_DIR } = require('./upload');
const { processArtwork } = require('./images');
const stencils = require('./stencils');

const ENABLED = process.env.INKWELL_INSPIRATION !== '0';
const OPENVERSE_URL = process.env.INKWELL_OPENVERSE_URL || 'https://api.openverse.org/v1/images/';
const COMMONS_URL = process.env.INKWELL_COMMONS_URL || 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = `Inkwell/1.1 (${process.env.APP_URL || 'https://inkwell.example'}; stencil reference harvester)`;
const FETCH_TIMEOUT_MS = 12000;
const HARVEST_TTL_HOURS = Number(process.env.INKWELL_HARVEST_TTL_HOURS) || 24;
const RETRY_AFTER_ERROR_HOURS = 6;
const BRIEF_TTL_DAYS = 7;
const PER_PROVIDER = 20;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const VEC_DIM = 256;

// Classic motifs: a baseline of what is asked for in every studio, with the words people use.
const CLASSIC_MOTIFS = [
  ['swallow', 'swallow bird sparrow'], ['rose', 'rose flower'], ['dagger', 'dagger knife'], ['snake', 'snake serpent'],
  ['panther', 'panther black cat'], ['skull', 'skull'], ['anchor', 'anchor nautical'], ['sacred heart', 'sacred heart flaming'],
  ['moth', 'moth'], ['butterfly', 'butterfly'], ['tiger', 'tiger'], ['koi', 'koi carp fish'], ['dragon', 'dragon'],
  ['eagle', 'eagle'], ['wolf', 'wolf'], ['mandala', 'mandala geometric'], ['lotus', 'lotus flower'], ['peony', 'peony flower'],
  ['ship', 'ship sailing'], ['lighthouse', 'lighthouse'], ['moon', 'crescent moon'], ['sun', 'sun'], ['spider', 'spider web'],
  ['scorpion', 'scorpion'], ['hand', 'hand hamsa'], ['eye', 'eye all-seeing'], ['heart', 'heart'], ['compass', 'compass'],
  ['sword', 'sword'], ['crown', 'crown'], ['dove', 'dove'], ['owl', 'owl'], ['bee', 'bee honeybee'], ['fern', 'fern leaf botanical'],
];
const STOPWORDS = new Set('a an the and or of for with on in to my me i we our your their this that some any small large big tattoo tattoos design designs piece idea ideas want would like looking get please style black grey gray color colour fine line work arm leg forearm shoulder back chest thigh calf wrist ankle hand neck sleeve half full'.split(' '));

/* ---------- text embedding (dependency-free) ---------- */

const tokens = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((t) => t.length > 1);

function hashTo(dim, str) {
  const h = crypto.createHash('md5').update(str).digest();
  return { idx: h.readUInt32LE(0) % dim, sign: h[4] & 1 ? 1 : -1 };
}

/**
 * Hashed embedding of a text: word unigrams, bigrams and character trigrams projected into a
 * fixed-size vector and normalised. Deterministic, offline, and good enough to rank a few
 * thousand captions by similarity to a query.
 */
function embed(text) {
  const vec = new Float32Array(VEC_DIM);
  const words = tokens(text).filter((w) => !STOPWORDS.has(w));
  const add = (feature, weight) => { const { idx, sign } = hashTo(VEC_DIM, feature); vec[idx] += sign * weight; };
  words.forEach((w, i) => {
    add(`w:${w}`, 1);
    if (i > 0) add(`b:${words[i - 1]} ${w}`, 0.7);
    const padded = `_${w}_`;
    for (let k = 0; k + 3 <= padded.length; k += 1) add(`c:${padded.slice(k, k + 3)}`, 0.25);
  });
  let norm = 0;
  for (let i = 0; i < VEC_DIM; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VEC_DIM; i += 1) vec[i] /= norm;
  return vec;
}

const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
const fromBlob = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < VEC_DIM; i += 1) dot += a[i] * b[i];
  return dot;
}

/* ---------- popularity ---------- */

const requestText = db.prepare(`SELECT title, description, style FROM tattoo_requests WHERE created_at >= datetime('now', '-180 days') ORDER BY id DESC LIMIT 500`);
const flashText = db.prepare(`SELECT title, style, status, (SELECT COUNT(*) FROM appointments a WHERE a.flash_id = f.id) AS bookings FROM flash_designs f ORDER BY id DESC LIMIT 500`);
const artworkText = db.prepare(`SELECT a.title, a.style, (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) AS likes FROM artworks a ORDER BY a.id DESC LIMIT 1000`);

/** Count how often each classic motif (or its synonyms) appears in a text. */
function motifHits(text) {
  const words = new Set(tokens(text));
  const hits = [];
  for (const [motif, synonyms] of CLASSIC_MOTIFS) {
    if (synonyms.split(' ').some((w) => words.has(w) || words.has(`${w}s`))) hits.push(motif);
  }
  return hits;
}

/**
 * Motifs ranked by demand on Inkwell: client requests count most (they are unmet demand), then
 * flash that was booked, then pieces that were liked (capped per piece, so one viral photo does
 * not define the trend). Every classic motif keeps a baseline so the list is never empty on a
 * fresh install.
 */
function trendingMotifs(limit = 12) {
  const score = new Map(CLASSIC_MOTIFS.map(([m]) => [m, { motif: m, score: 1, requests: 0, flash: 0, likes: 0 }]));
  for (const r of requestText.all()) for (const m of motifHits(`${r.title} ${r.description} ${r.style}`)) { const s = score.get(m); s.requests += 1; s.score += 4; }
  for (const f of flashText.all()) for (const m of motifHits(`${f.title} ${f.style}`)) { const s = score.get(m); s.flash += 1; s.score += 1 + 2 * f.bookings; }
  for (const a of artworkText.all()) for (const m of motifHits(`${a.title} ${a.style}`)) { const s = score.get(m); s.likes += a.likes; s.score += 0.5 + 0.2 * Math.min(a.likes, 10); }
  const harvests = new Map(db.prepare('SELECT motif, fetched_at, results FROM motif_harvests').all().map((h) => [h.motif, h]));
  return [...score.values()]
    .sort((a, b) => b.score - a.score || a.motif.localeCompare(b.motif))
    .slice(0, limit)
    .map((s) => ({ ...s, score: Number(s.score.toFixed(1)), references: countForMotif.get(s.motif).n, harvested_at: (harvests.get(s.motif) || {}).fetched_at || null }));
}

/* ---------- providers ---------- */

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

// Licences that allow reuse and modification. Anything with NC or ND terms is skipped.
const OPEN_LICENSES = new Set(['cc0', 'pdm', 'by', 'by-sa']);
const openCommonsLicense = (name) => /public domain|cc0|^cc[- ]by(-sa)?\b/i.test(name || '') && !/nc|nd/i.test(name || '');

async function searchOpenverse(motif) {
  const q = new URLSearchParams({ q: `${motif} tattoo`, license: [...OPEN_LICENSES].join(','), page_size: String(PER_PROVIDER), mature: 'false' });
  const data = await getJson(`${OPENVERSE_URL}?${q}`);
  return (data.results || []).filter((r) => OPEN_LICENSES.has(String(r.license || '').toLowerCase())).map((r) => ({
    provider: 'openverse',
    external_id: String(r.id),
    title: String(r.title || motif).slice(0, 200),
    creator: r.creator ? String(r.creator).slice(0, 120) : null,
    license: `${String(r.license).toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`.replace(/^(BY|BY-SA)/, 'CC $1'),
    license_url: r.license_url || null,
    page_url: r.foreign_landing_url || r.url,
    image_url: r.url,
    thumb_url: r.thumbnail || r.url,
    width: r.width || null,
    height: r.height || null,
    tags: (r.tags || []).map((t) => t.name).filter(Boolean).slice(0, 30),
  }));
}

async function searchCommons(motif) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${motif} tattoo filetype:bitmap|drawing`, gsrnamespace: '6', gsrlimit: String(PER_PROVIDER),
    prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: '480', iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription|Categories',
  });
  const data = await getJson(`${COMMONS_URL}?${q}`);
  const pages = Object.values((data.query || {}).pages || {});
  return pages.map((p) => {
    const info = (p.imageinfo || [])[0];
    if (!info || !/^image\/(jpeg|png|webp|gif)$/.test(info.mime || '')) return null;
    const meta = info.extmetadata || {};
    const licence = (meta.LicenseShortName || {}).value || '';
    if (!openCommonsLicense(licence)) return null;
    const strip = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      provider: 'commons',
      external_id: String(p.pageid),
      title: String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').slice(0, 200) || motif,
      creator: strip((meta.Artist || {}).value).slice(0, 120) || null,
      license: licence,
      license_url: (meta.LicenseUrl || {}).value || null,
      page_url: info.descriptionurl,
      image_url: info.url,
      thumb_url: info.thumburl || info.url,
      width: info.width || null,
      height: info.height || null,
      tags: strip((meta.Categories || {}).value).split('|').map((t) => t.trim()).filter(Boolean).slice(0, 30).concat([strip((meta.ImageDescription || {}).value).slice(0, 200)]).filter(Boolean),
    };
  }).filter(Boolean);
}

const PROVIDERS = { openverse: searchOpenverse, commons: searchCommons };

/* ---------- index ---------- */

const upsertReference = db.prepare(`
  INSERT INTO reference_images (provider, external_id, motif, title, creator, license, license_url, page_url, image_url, thumb_url, width, height, tags, text, vec, fetched_at)
  VALUES (@provider, @external_id, @motif, @title, @creator, @license, @license_url, @page_url, @image_url, @thumb_url, @width, @height, @tags, @text, @vec, datetime('now'))
  ON CONFLICT(provider, external_id) DO UPDATE SET title = excluded.title, creator = excluded.creator, license = excluded.license, license_url = excluded.license_url,
    page_url = excluded.page_url, image_url = excluded.image_url, thumb_url = excluded.thumb_url, width = excluded.width, height = excluded.height,
    tags = excluded.tags, text = excluded.text, vec = excluded.vec, fetched_at = datetime('now')
`);
const allReferences = db.prepare('SELECT * FROM reference_images');
const getReference = db.prepare('SELECT * FROM reference_images WHERE id = ?');
const countForMotif = db.prepare('SELECT COUNT(*) AS n FROM reference_images WHERE motif = ?');
const countReferences = db.prepare('SELECT COUNT(*) AS n FROM reference_images');
const getHarvest = db.prepare('SELECT * FROM motif_harvests WHERE motif = ?');
const recordHarvest = db.prepare(`
  INSERT INTO motif_harvests (motif, fetched_at, results, error) VALUES (?, datetime('now'), ?, ?)
  ON CONFLICT(motif) DO UPDATE SET fetched_at = datetime('now'), results = excluded.results, error = excluded.error
`);
const saveBrief = db.prepare(`
  INSERT INTO motif_harvests (motif, brief, brief_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(motif) DO UPDATE SET brief = excluded.brief, brief_at = datetime('now')
`);

const referenceText = (r) => `${r.title} ${r.creator || ''} ${r.motif} ${(r.tags || []).join(' ')}`;

/** Search the open image sources for a motif and index what comes back. */
async function harvest(motif) {
  const clean = normaliseMotif(motif);
  if (!clean) throw new Error('Give a motif to look for.');
  let added = 0;
  const errors = [];
  for (const [name, search] of Object.entries(PROVIDERS)) {
    try {
      const rows = await search(clean);
      const tx = db.transaction((items) => { for (const r of items) { upsertReference.run({ ...r, motif: clean, tags: r.tags.join(', '), text: referenceText(r), vec: toBlob(embed(referenceText(r))) }); added += 1; } });
      tx(rows);
    } catch (err) { errors.push(`${name}: ${err.message}`); }
  }
  recordHarvest.run(clean, added, errors.length === Object.keys(PROVIDERS).length ? errors.join('; ') : null);
  return { motif: clean, added, errors };
}

const normaliseMotif = (m) => String(m || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Which motif should the scheduler fetch next: the most in-demand one that is stale or never fetched. */
function nextMotifToHarvest() {
  const now = Date.now();
  for (const m of trendingMotifs(CLASSIC_MOTIFS.length)) {
    const h = getHarvest.get(m.motif);
    if (!h || !h.fetched_at) return m.motif;
    const age = now - new Date(`${h.fetched_at.replace(' ', 'T')}Z`).getTime();
    if (age > (h.error ? RETRY_AFTER_ERROR_HOURS : HARVEST_TTL_HOURS) * 3600e3) return m.motif;
  }
  return null;
}

/** Scheduler hook: one motif per run, so a quiet server fills its reference library over a day. */
async function harvestTrending() {
  if (!ENABLED) return { skipped: 'disabled' };
  const motif = nextMotifToHarvest();
  if (!motif) return { motif: null, added: 0 };
  return harvest(motif);
}

function shapeReference(r) {
  return {
    id: r.id,
    provider: r.provider,
    motif: r.motif,
    title: r.title,
    creator: r.creator,
    license: r.license,
    license_url: r.license_url,
    page_url: r.page_url,
    image_url: r.image_url,
    thumb_url: r.thumb_url,
    thumb: `/api/inspiration/references/${r.id}/thumb`,
    width: r.width,
    height: r.height,
    tags: r.tags ? r.tags.split(', ').filter(Boolean) : [],
    fetched_at: r.fetched_at,
  };
}

/** Rank the indexed references against a description: embedding similarity plus a keyword boost. */
function search(query, { limit = 24, motif = null } = {}) {
  const q = embed(query);
  const words = tokens(query).filter((w) => !STOPWORDS.has(w));
  const scored = [];
  for (const r of allReferences.all()) {
    if (motif && r.motif !== motif) continue;
    let score = r.vec ? cosine(q, fromBlob(r.vec)) : 0;
    const text = ` ${r.text.toLowerCase()} `;
    for (const w of words) if (text.includes(` ${w} `) || text.includes(` ${w}s `)) score += 0.15;
    if (r.motif && words.includes(r.motif)) score += 0.2;
    if (score > 0.05) scored.push({ ...shapeReference(r), score: Number(score.toFixed(3)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ---------- design brief (retrieval-augmented) ---------- */

const hasClaude = () => process.env.INKWELL_CLAUDE !== '0' && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on how this motif is usually drawn and what makes it read well as a tattoo.' },
    composition: { type: 'array', items: { type: 'string' }, description: 'Concrete composition ideas drawn from the references: poses, framing, companion elements.' },
    stencil_tips: { type: 'array', items: { type: 'string' }, description: 'What to keep bold and what to simplify so the design survives as a stencil and ages well as a tattoo.' },
    search_terms: { type: 'array', items: { type: 'string' }, description: 'Three to five short phrases to find more references for this motif.' },
  },
  required: ['summary', 'composition', 'stencil_tips', 'search_terms'],
  additionalProperties: false,
};

let claudeClient = null;
function claude() {
  if (!claudeClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    claudeClient = new Anthropic({ maxRetries: 1, timeout: 60000 });
  }
  return claudeClient;
}

/** A brief written from the retrieved references by Claude, or assembled from their tags when Claude is not configured. */
async function writeBrief(motif, refs) {
  const tagCounts = new Map();
  for (const r of refs) for (const t of r.tags) { const k = t.toLowerCase(); if (!tokens(k).every((w) => STOPWORDS.has(w))) tagCounts.set(k, (tagCounts.get(k) || 0) + 1); }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  if (!hasClaude()) {
    return {
      summary: `${refs.length} openly licensed reference${refs.length === 1 ? '' : 's'} for "${motif}" in the library${topTags.length ? `, most often tagged ${topTags.slice(0, 5).join(', ')}` : ''}. Set up Claude to get composition notes written from the references themselves.`,
      composition: topTags.slice(0, 6).map((t) => `Seen in references: ${t}`),
      stencil_tips: ['Keep the silhouette readable at arm\'s length: one bold outline, then detail inside it.', 'Drop shading that reads as texture; the tracer keeps lines, not tone.', 'Leave breathing room between parallel lines so they do not blur as the tattoo ages.'],
      search_terms: [`${motif} tattoo flash`, `${motif} line drawing`, `${motif} vintage illustration`],
      generated_by: 'tags',
    };
  }
  const context = refs.slice(0, 20).map((r, i) => `${i + 1}. "${r.title}"${r.creator ? ` by ${r.creator}` : ''} (${r.license}${r.provider ? `, ${r.provider}` : ''}) tags: ${r.tags.slice(0, 12).join(', ') || 'none'}`).join('\n');
  const response = await claude().beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
    system: 'You write short design briefs for professional tattoo artists preparing a stencil. Ground everything in the reference list you are given: describe compositions and elements that actually recur in it, and say so when the references are thin. Never suggest copying a specific living artist\'s work; the goal is an original design in the tradition of the motif. Plain language, no hype.',
    messages: [{ role: 'user', content: `Motif: ${motif}\n\nOpenly licensed references retrieved from the library:\n${context || '(none yet)'}\n\nWrite the brief.` }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to write this brief.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const brief = JSON.parse(text);
  return { ...brief, generated_by: response.model || 'claude' };
}

async function briefFor(motif, { refresh = false } = {}) {
  const clean = normaliseMotif(motif);
  const h = getHarvest.get(clean);
  if (!refresh && h && h.brief && h.brief_at && Date.now() - new Date(`${h.brief_at.replace(' ', 'T')}Z`).getTime() < BRIEF_TTL_DAYS * 86400e3) {
    return { ...JSON.parse(h.brief), cached: true, brief_at: h.brief_at };
  }
  const refs = search(clean, { limit: 30 });
  const brief = await writeBrief(clean, refs);
  saveBrief.run(clean, JSON.stringify(brief));
  return { ...brief, cached: false, brief_at: getHarvest.get(clean).brief_at };
}

/* ---------- thumbnails ---------- */

const sharp = require('sharp');
const thumbFile = (id) => path.join(UPLOAD_DIR, `refthumb-${id}.webp`);

/**
 * Reference thumbnails are served from here rather than hot-linked: the page's content security
 * policy only allows same-origin images, and the source hosts are not hit once per viewer.
 */
async function thumbnail(ref) {
  const file = thumbFile(ref.id);
  try { await fs.access(file); return file; } catch { /* not cached yet */ }
  const res = await fetch(ref.thumb_url || ref.image_url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) throw Object.assign(new Error('Thumbnail unavailable.'), { status: 502 });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Thumbnail too large.'), { status: 502 });
  await sharp(bytes, { pages: 1 }).rotate().resize({ width: 480, height: 600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(file);
  return file;
}

/* ---------- recreate ---------- */

/** Download a reference image into the uploads directory, keep its attribution, and trace it. */
async function recreate(artistId, referenceId, { detail } = {}) {
  const ref = getReference.get(referenceId);
  if (!ref) throw Object.assign(new Error('Reference not found.'), { status: 404 });
  const res = await fetch(ref.image_url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2) });
  if (!res.ok) throw Object.assign(new Error(`The source answered ${res.status} for that image.`), { status: 502 });
  if (!/^image\//.test(res.headers.get('content-type') || '')) throw Object.assign(new Error('The source did not return an image.'), { status: 502 });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('That image is too large to trace.'), { status: 413 });
  const filename = `ref-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await fs.writeFile(path.join(UPLOAD_DIR, filename), bytes);
  let image;
  try { image = await processArtwork({ filename, path: path.join(UPLOAD_DIR, filename) }); } catch (err) { await fs.rm(path.join(UPLOAD_DIR, filename), { force: true }); throw Object.assign(new Error(err.message), { status: 400 }); }
  const { removeByUrl } = require('./upload');
  removeByUrl(image.thumb_url);
  const attribution = { provider: ref.provider, external_id: ref.external_id, creator: ref.creator, license: ref.license, license_url: ref.license_url, page_url: ref.page_url, motif: ref.motif };
  const row = await stencils.createFromFile(artistId, { sourceType: 'reference', sourceId: ref.id, sourceUrl: image.url, title: ref.title, detail, attribution });
  return stencils.shape(row);
}

/* ---------- routes ---------- */

const router = express.Router();
router.use(requireRole('artist'));

router.get('/trending', (req, res) => {
  res.json({ motifs: trendingMotifs(Number(req.query.limit) || 12), references: countReferences.get().n, enabled: ENABLED, claude: hasClaude() });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || req.query.motif || '').trim();
  if (!q) return res.status(400).json({ error: 'Describe what you are looking for.' });
  const motif = req.query.motif ? normaliseMotif(req.query.motif) : null;
  const h = motif ? getHarvest.get(motif) : null;
  res.json({ query: q, results: search(q, { motif, limit: Number(req.query.limit) || 24 }), harvested_at: h ? h.fetched_at : null, brief: h && h.brief ? { ...JSON.parse(h.brief), cached: true, brief_at: h.brief_at } : null });
});

/** Fetch references for a motif now instead of waiting for the scheduler. Once an hour per motif. */
router.post('/harvest', async (req, res, next) => {
  try {
    if (!ENABLED) return res.status(503).json({ error: 'Reference harvesting is turned off on this server.' });
    const motif = normaliseMotif((req.body || {}).motif);
    if (!motif) return res.status(400).json({ error: 'Give a motif to look for.' });
    const h = getHarvest.get(motif);
    if (h && h.fetched_at && !h.error && Date.now() - new Date(`${h.fetched_at.replace(' ', 'T')}Z`).getTime() < 3600e3) {
      return res.json({ motif, added: 0, fresh: true, results: search(motif, { motif }) });
    }
    const out = await harvest(motif);
    res.json({ ...out, fresh: false, results: search(motif, { motif }) });
  } catch (err) { next(err); }
});

router.post('/brief', async (req, res, next) => {
  try {
    const motif = normaliseMotif((req.body || {}).motif);
    if (!motif) return res.status(400).json({ error: 'Which motif?' });
    res.json({ motif, brief: await briefFor(motif, { refresh: !!(req.body || {}).refresh }) });
  } catch (err) {
    if (err && err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    if (/declined/.test(err.message)) return res.status(422).json({ error: err.message });
    next(err);
  }
});

router.get('/references/:id/thumb', async (req, res, next) => {
  try {
    const ref = getReference.get(req.params.id);
    if (!ref) return res.status(404).json({ error: 'Reference not found.' });
    const file = await thumbnail(ref);
    res.set('Cache-Control', 'private, max-age=86400').sendFile(file);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/references/:id/recreate', async (req, res, next) => {
  try {
    const stencil = await recreate(req.user.id, req.params.id, { detail: (req.body || {}).detail });
    res.status(201).json({ stencil });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = { router, embed, cosine, search, harvest, harvestTrending, nextMotifToHarvest, trendingMotifs, briefFor, recreate, motifHits, CLASSIC_MOTIFS, ENABLED, hasClaude };
