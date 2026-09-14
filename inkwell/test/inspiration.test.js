'use strict';

/*
 * Inspiration: trending motifs from platform demand, harvesting openly licensed references from
 * mocked Openverse and Wikimedia Commons endpoints, the local embedding index, design briefs
 * (with a mocked Claude endpoint), and recreating a reference as an attributed stencil.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-inspiration-'));
process.env.INKWELL_DB_PATH = path.join(tmp, 'test.db');
process.env.INKWELL_UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const sharp = require('sharp');

/* ---------- a stand-in for the outside world ---------- */

const seen = { openverse: [], commons: [], claude: [], images: [] };
let claudeMode = 'ok';
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/openverse/') {
    seen.openverse.push(url.searchParams.get('q'));
    const motif = url.searchParams.get('q').replace(/ tattoo$/, '');
    return json(200, { results: [
      { id: `ov-${motif}-1`, title: `${motif} flash sheet`, creator: 'Old Sailor', license: 'pdm', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/mark/1.0/', url: `http://127.0.0.1:${mock.address().port}/img/${motif}-1.png`, thumbnail: `http://127.0.0.1:${mock.address().port}/img/${motif}-1.png`, foreign_landing_url: 'https://example.org/flash/1', width: 400, height: 500, tags: [{ name: motif }, { name: 'traditional' }, { name: 'flash' }] },
      { id: `ov-${motif}-2`, title: `${motif} line drawing`, creator: 'Ada', license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', url: `http://127.0.0.1:${mock.address().port}/img/${motif}-2.png`, foreign_landing_url: 'https://example.org/2', width: 400, height: 500, tags: [{ name: motif }, { name: 'line art' }] },
      { id: `ov-${motif}-nc`, title: `${motif} photo (non-commercial)`, creator: 'Someone', license: 'by-nc', url: `http://127.0.0.1:${mock.address().port}/img/nc.png`, foreign_landing_url: 'https://example.org/nc', tags: [] },
    ] });
  }
  if (url.pathname === '/commons') {
    seen.commons.push(url.searchParams.get('gsrsearch'));
    const motif = url.searchParams.get('gsrsearch').split(' tattoo')[0];
    return json(200, { query: { pages: {
      101: { pageid: 101, title: `File:${motif} vintage engraving.jpg`, imageinfo: [{ url: `http://127.0.0.1:${mock.address().port}/img/${motif}-c.png`, thumburl: `http://127.0.0.1:${mock.address().port}/img/${motif}-c.png`, descriptionurl: 'https://commons.wikimedia.org/wiki/File:x.jpg', width: 400, height: 500, mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: '<a href="#">Unknown engraver</a>' }, Categories: { value: `${motif}|Engravings|1890s` }, ImageDescription: { value: `An 1890s engraving of a ${motif}` } } }] },
      102: { pageid: 102, title: 'File:nd-licensed.jpg', imageinfo: [{ url: 'http://x/nd.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:nd.jpg', mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-ND 4.0' } } }] },
      103: { pageid: 103, title: 'File:vector.svg', imageinfo: [{ url: 'http://x/v.svg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:v.svg', mime: 'image/svg+xml', extmetadata: { LicenseShortName: { value: 'CC0' } } }] },
    } } });
  }
  if (url.pathname.startsWith('/img/')) {
    seen.images.push(url.pathname);
    const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#f7f3ee"/><circle cx="200" cy="220" r="120" fill="none" stroke="#111" stroke-width="10"/><path d="M60 420 C 120 300, 280 300, 340 420" fill="none" stroke="#111" stroke-width="6"/></svg>`)).png().toBuffer();
    res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png);
  }
  if (url.pathname === '/v1/messages') {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.claude.push({ headers: req.headers, body: JSON.parse(body) });
    if (claudeMode === 'refuse') return json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    const brief = { summary: 'Swallows are drawn in profile with the wings swept back.', composition: ['Pair facing each other', 'Banner across the chest'], stencil_tips: ['One bold outline', 'Simplify the feather detail'], search_terms: ['swallow flash', 'sailor swallow'] };
    return json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(brief) }], usage: { input_tokens: 10, output_tokens: 20 } });
  }
  json(404, { error: 'nope' });
});

let server;
let base;
let inspiration;
let stencilsMod;
let db;
let createApp;
let seed;
let DEMO_PASSWORD;

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const init = { method, headers: {} };
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + url, init);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b), del: (u) => call('DELETE', u), cookie: () => cookie };
}

async function login(email) {
  const c = client();
  const r = await c.post('/api/auth/login', { email, password: DEMO_PASSWORD });
  assert.equal(r.status, 200, `login ${email}`);
  return { c, id: r.data.user.id };
}

before(async () => {
  await new Promise((resolve) => { mock.listen(0, '127.0.0.1', resolve); });
  const m = `http://127.0.0.1:${mock.address().port}`;
  process.env.INKWELL_OPENVERSE_URL = `${m}/openverse/`;
  process.env.INKWELL_COMMONS_URL = `${m}/commons`;
  process.env.ANTHROPIC_BASE_URL = m;
  ({ createApp } = require('../server/index'));
  ({ seed, DEMO_PASSWORD } = require('../server/seed'));
  ({ db } = require('../server/db'));
  inspiration = require('../server/inspiration');
  stencilsMod = require('../server/stencils');
  seed();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('embedding: similar descriptions land close, unrelated ones far; motif detection reads synonyms', () => {
  const { embed, cosine, motifHits } = inspiration;
  const a = embed('traditional swallow bird with a banner');
  const b = embed('sailor swallow, banner, traditional flash');
  const c = embed('geometric mandala on the sternum');
  assert.ok(cosine(a, b) > 0.35, `related ${cosine(a, b)}`);
  assert.ok(cosine(a, c) < 0.15, `unrelated ${cosine(a, c)}`);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-5, 'normalised');
  assert.deepEqual(motifHits('Two sparrows and a dagger through a rose'), ['swallow', 'rose', 'dagger']);
  assert.deepEqual(motifHits('Something abstract'), []);
});

test('trending motifs come from what clients ask for, with every classic motif as a baseline', async () => {
  const { c: hana } = await login('hana@inkwell.demo');
  for (let i = 0; i < 5; i += 1) {
    const r = await hana.post('/api/requests', { title: `Traditional swallow ${i}`, description: 'Two swallows with a banner on the chest', style: 'Traditional', placement: 'Chest', size: 'Small (2-4 in)', budget_min: 200, budget_max: 400, location: 'Portland' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const motifs = inspiration.trendingMotifs(5);
  assert.equal(motifs[0].motif, 'swallow');
  assert.ok(motifs[0].requests >= 5);
  assert.ok(motifs[0].score > motifs[4].score);
  assert.equal(inspiration.trendingMotifs(100).length, inspiration.CLASSIC_MOTIFS.length, 'every classic motif is listed');
  const { c: mara } = await login('mara@inkwell.demo');
  const r = await mara.get('/api/inspiration/trending?limit=3');
  assert.equal(r.status, 200);
  assert.equal(r.data.motifs.length, 3);
  assert.equal(r.data.motifs[0].motif, 'swallow');
  assert.equal(r.data.motifs[0].references, 0, 'nothing harvested yet');
  assert.equal(r.data.claude, false);
  const anon = client();
  assert.equal((await anon.get('/api/inspiration/trending')).status, 401);
  assert.equal((await hana.get('/api/inspiration/trending')).status, 403, 'artists only');
});

test('harvesting keeps only openly licensed images from both providers and the scheduler picks the most wanted motif first', async () => {
  assert.equal(inspiration.nextMotifToHarvest(), 'swallow');
  const out = await inspiration.harvestTrending();
  assert.equal(out.motif, 'swallow');
  assert.equal(out.added, 3, 'two open Openverse results plus one public-domain Commons file');
  assert.deepEqual(out.errors, []);
  assert.deepEqual(seen.openverse, ['swallow tattoo']);
  assert.match(seen.commons[0], /^swallow tattoo/);
  const rows = db.prepare('SELECT provider, license, creator, title FROM reference_images ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.license), ['PDM 1.0', 'CC BY 4.0', 'Public domain']);
  assert.ok(!rows.some((r) => /non-commercial|nd-licensed|vector/.test(r.title)), 'NC, ND and non-bitmap files are skipped');
  assert.equal(rows[2].creator, 'Unknown engraver', 'HTML stripped from the Commons artist field');
  assert.notEqual(inspiration.nextMotifToHarvest(), 'swallow', 'a fresh harvest is not repeated');
  // Harvesting twice does not duplicate rows.
  const again = await inspiration.harvest('swallow');
  assert.equal(again.added, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reference_images').get().n, 3);
  // Search ranks by description; the motif filter narrows.
  const hits = inspiration.search('vintage engraving of a swallow');
  assert.ok(hits.length >= 3);
  assert.match(hits[0].title, /engraving/);
  assert.equal(inspiration.search('anything', { motif: 'rose' }).length, 0);
});

test('artists search, harvest on demand (rate limited), and get a brief without Claude configured', async () => {
  const { c: mara } = await login('mara@inkwell.demo');
  let r = await mara.get('/api/inspiration/search?q=swallow%20flash%20sheet');
  assert.equal(r.status, 200);
  assert.equal(r.data.results[0].title, 'swallow flash sheet');
  assert.equal(r.data.results[0].license, 'PDM 1.0');
  assert.equal(r.data.results[0].creator, 'Old Sailor');
  assert.equal(r.data.brief, null);
  assert.equal(r.data.results[0].thumb, `/api/inspiration/references/${r.data.results[0].id}/thumb`);
  const thumb = await fetch(`${base}${r.data.results[0].thumb}`, { headers: { cookie: mara.cookie() } });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  assert.ok(fs.existsSync(path.join(process.env.INKWELL_UPLOAD_DIR, `refthumb-${r.data.results[0].id}.webp`)), 'cached on disk');
  const fetched = seen.images.length;
  assert.equal((await fetch(`${base}${r.data.results[0].thumb}`, { headers: { cookie: mara.cookie() } })).status, 200);
  assert.equal(seen.images.length, fetched, 'second view served from the cache');
  assert.equal((await client().get(`/api/inspiration/references/1/thumb`)).status, 401);
  r = await mara.get('/api/inspiration/search');
  assert.equal(r.status, 400);
  r = await mara.post('/api/inspiration/harvest', { motif: 'swallow' });
  assert.equal(r.data.fresh, true, 'harvested a moment ago: served from the index');
  assert.equal(r.data.results.length, 3);
  assert.equal(seen.openverse.length, 2, 'no third provider call');
  r = await mara.post('/api/inspiration/harvest', { motif: 'Rose!' });
  assert.equal(r.status, 200);
  assert.equal(r.data.motif, 'rose');
  assert.equal(r.data.added, 3);
  assert.ok(r.data.results.every((x) => x.motif === 'rose'));
  r = await mara.post('/api/inspiration/brief', { motif: 'rose' });
  assert.equal(r.status, 200);
  assert.equal(r.data.brief.generated_by, 'tags');
  assert.match(r.data.brief.summary, /3 openly licensed references for "rose"/);
  assert.ok(r.data.brief.composition.length > 0 && r.data.brief.stencil_tips.length === 3);
  assert.equal(seen.claude.length, 0, 'Claude is not called without credentials');
  r = await mara.get('/api/inspiration/search?motif=rose&q=rose');
  assert.equal(r.data.brief.generated_by, 'tags');
  assert.equal(r.data.brief.cached, true);
});

test('with Claude configured the brief is written from the retrieved references; refusals are reported', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const { c: mara } = await login('mara@inkwell.demo');
  let r = await mara.post('/api/inspiration/brief', { motif: 'swallow', refresh: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.brief.generated_by, 'claude-opus-5');
  assert.equal(r.data.brief.summary, 'Swallows are drawn in profile with the wings swept back.');
  assert.deepEqual(r.data.brief.search_terms, ['swallow flash', 'sailor swallow']);
  assert.equal(seen.claude.length, 1);
  const call = seen.claude[0];
  assert.equal(call.body.model, 'claude-opus-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.equal(call.body.output_config.effort, 'medium');
  assert.match(call.body.messages[0].content, /Motif: swallow/);
  assert.match(call.body.messages[0].content, /"swallow flash sheet" by Old Sailor \(PDM 1.0, openverse\)/, 'retrieved references are in the prompt');
  assert.match(call.body.system, /never suggest copying/i);
  // Cached for a week: a second call does not hit the API.
  r = await mara.post('/api/inspiration/brief', { motif: 'swallow' });
  assert.equal(r.data.brief.cached, true);
  assert.equal(seen.claude.length, 1);
  claudeMode = 'refuse';
  r = await mara.post('/api/inspiration/brief', { motif: 'swallow', refresh: true });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /declined/);
  claudeMode = 'ok';
  delete process.env.ANTHROPIC_API_KEY;
});

test('recreating a reference downloads it, traces it, and keeps the attribution on the stencil', async () => {
  const { c: mara, id: maraId } = await login('mara@inkwell.demo');
  const { c: sofia } = await login('sofia@inkwell.demo');
  const ref = db.prepare(`SELECT id FROM reference_images WHERE title = 'swallow flash sheet'`).get();
  let r = await mara.post(`/api/inspiration/references/${ref.id}/recreate`, { detail: 4 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = r.data.stencil;
  assert.equal(s.source_type, 'reference');
  assert.equal(s.source_id, ref.id);
  assert.equal(s.status, 'ready', s.error);
  assert.equal(s.detail, 4);
  assert.equal(s.title, 'swallow flash sheet');
  assert.deepEqual(s.attribution, { provider: 'openverse', external_id: 'ov-swallow-1', creator: 'Old Sailor', license: 'PDM 1.0', license_url: 'https://creativecommons.org/publicdomain/mark/1.0/', page_url: 'https://example.org/flash/1', motif: 'swallow' });
  assert.ok(seen.images.includes('/img/swallow-1.png'));
  const file = (u) => path.join(process.env.INKWELL_UPLOAD_DIR, path.basename(u));
  assert.ok(fs.existsSync(file(s.source_url)) && fs.existsSync(file(s.image_url)));
  // Another artist can recreate the same reference: the library is per artist.
  r = await sofia.post(`/api/inspiration/references/${ref.id}/recreate`, {});
  assert.equal(r.status, 201);
  assert.equal(r.data.stencil.detail, stencilsMod.DEFAULT_DETAIL);
  r = await mara.get('/api/stencils?source=reference');
  assert.equal(r.data.stencils.length, 1);
  assert.equal(r.data.stencils[0].id, s.id);
  assert.equal(r.data.stencils[0].attribution.creator, 'Old Sailor');
  r = await mara.post('/api/inspiration/references/999999/recreate', {});
  assert.equal(r.status, 404);
  // Deleting the stencil removes the downloaded copy too.
  r = await mara.del(`/api/stencils/${s.id}`);
  assert.equal(r.status, 200);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  assert.ok(!fs.existsSync(file(s.source_url)) && !fs.existsSync(file(s.image_url)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stencils WHERE artist_id = ? AND source_type = ?').get(maraId, 'reference').n, 0);
});
