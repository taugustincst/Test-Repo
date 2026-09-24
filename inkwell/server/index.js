'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

/*
 * Express 4 does not catch rejected promises from async handlers, and Node exits on an unhandled
 * rejection. Wrap every route handler as it is registered so a rejection reaches the error
 * handler like a thrown error would. This must run before any router is created.
 */
const Layer = require('express/lib/router/layer');
Object.defineProperty(Layer.prototype, 'handle', {
  configurable: true,
  enumerable: true,
  get() { return this.__handle; },
  set(fn) {
    this.__handle = typeof fn === 'function' && fn.length < 4
      ? function wrapped(req, res, next) {
        let out;
        try { out = fn.call(this, req, res, next); } catch (err) { return next(err); }
        if (out && typeof out.catch === 'function') out.catch(next);
        return out;
      }
      : fn;
  },
});
process.on('unhandledRejection', (err) => { console.error('[process] unhandled rejection', err); });
process.on('uncaughtException', (err) => { console.error('[process] uncaught exception, exiting', err); process.exit(1); });
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { db } = require('./db');
const { loadUser } = require('./auth');
const { UPLOAD_DIR } = require('./upload');
const { securityHeaders, uploadHeaders, rateLimit, originCheck, cors, requestLogger } = require('./security');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
// Origins the native shell loads from, plus anything listed in CORS_ORIGINS (comma separated).
const APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'http://localhost', 'https://localhost',
  ...String(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)];
const SW_SOURCE = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- share previews (Open Graph) for crawlers and link unfurls ---------- */

const metaQueries = {
  flash: db.prepare(`
    SELECT f.title, f.style, f.price, f.size_label, f.status, f.image_url, u.name AS artist_name
    FROM flash_designs f JOIN users u ON u.id = f.artist_id WHERE f.id = ? AND u.suspended_at IS NULL AND f.status != 'hidden'`),
  collection: db.prepare(`
    SELECT c.title, c.description, c.token, c.is_public, u.name AS owner_name,
           (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS item_count
    FROM collections c JOIN users u ON u.id = c.user_id WHERE c.token = ?`),
  artist: db.prepare(`
    SELECT u.id, u.name, u.bio, u.location, u.avatar_url, p.studio_name,
           (SELECT image_url FROM artworks a WHERE a.artist_id = u.id ORDER BY a.created_at DESC LIMIT 1) AS cover
    FROM users u JOIN artist_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'artist' AND u.suspended_at IS NULL`),
  artwork: db.prepare(`
    SELECT a.id, a.title, a.description, a.image_url, a.style, u.name AS artist_name
    FROM artworks a JOIN users u ON u.id = a.artist_id WHERE a.id = ? AND u.suspended_at IS NULL`),
  gallery: db.prepare(`
    SELECT g.id, g.title, g.description, u.name AS artist_name,
           (SELECT image_url FROM artworks a WHERE a.gallery_id = g.id ORDER BY a.created_at DESC LIMIT 1) AS cover
    FROM galleries g JOIN users u ON u.id = g.artist_id WHERE g.id = ? AND u.suspended_at IS NULL`),
  request: db.prepare(`
    SELECT r.title, r.description, r.style FROM tattoo_requests r JOIN users u ON u.id = r.client_id
    WHERE r.id = ? AND u.suspended_at IS NULL`),
};

function pageMeta(urlPath) {
  const base = { title: 'Inkwell · Tattoo artists, galleries and bookings', description: 'Inkwell is where tattoo artists share their galleries, meet clients, and book appointments.', image: null };
  let m;
  if ((m = urlPath.match(/^\/artists\/(\d+)$/))) {
    const a = metaQueries.artist.get(m[1]);
    if (a) return { title: `${a.name} · Tattoo artist on Inkwell`, description: `${a.studio_name ? `${a.studio_name}${a.location ? `, ${a.location}` : ''}. ` : ''}${a.bio || 'See galleries, reviews and open booking slots.'}`.slice(0, 300), image: `/og/artists/${a.id}.png` };
  } else if ((m = urlPath.match(/^\/artworks\/(\d+)$/))) {
    const a = metaQueries.artwork.get(m[1]);
    if (a) return { title: `${a.title} by ${a.artist_name} · Inkwell`, description: (a.description || `${a.style || 'Tattoo'} by ${a.artist_name}`).slice(0, 300), image: `/og/artworks/${a.id}.png` };
  } else if ((m = urlPath.match(/^\/galleries\/(\d+)$/))) {
    const g = metaQueries.gallery.get(m[1]);
    if (g) return { title: `${g.title} · ${g.artist_name} on Inkwell`, description: (g.description || `A gallery by ${g.artist_name}`).slice(0, 300), image: `/og/galleries/${g.id}.png` };
  } else if ((m = urlPath.match(/^\/requests\/(\d+)$/))) {
    const r = metaQueries.request.get(m[1]);
    if (r) return { title: `${r.title} · Client request on Inkwell`, description: r.description.slice(0, 300), image: null };
  } else if ((m = urlPath.match(/^\/c\/([A-Za-z0-9_-]+)$/))) {
    const c = metaQueries.collection.get(m[1]);
    if (c && c.is_public) return { title: `${c.title} · a reference board on Inkwell`, description: (c.description || `${c.item_count} tattoo${c.item_count === 1 ? '' : 's'} saved by ${c.owner_name}. Share it with your artist or your friends.`).slice(0, 300), image: `/og/collections/${c.token}.png` };
  } else if ((m = urlPath.match(/^\/flash\/(\d+)$/))) {
    const f = metaQueries.flash.get(m[1]);
    if (f) return { title: `${f.title} · flash by ${f.artist_name} on Inkwell`, description: `${f.style ? `${f.style} flash design` : 'Flash design'} by ${f.artist_name}, $${f.price}${f.size_label ? `, ${f.size_label.toLowerCase()}` : ''}. ${f.status === 'available' ? 'Available to book now.' : 'Already claimed.'}`.slice(0, 300), image: f.image_url };
  } else if (urlPath === '/flash') {
    return { ...base, title: 'Flash designs ready to book · Inkwell', description: 'Pre-drawn tattoo designs at a fixed price. Pick one, book a slot, done.' };
  } else if (urlPath === '/artists') {
    return { ...base, title: 'Find a tattoo artist · Inkwell' };
  } else if (urlPath === '/requests') {
    return { ...base, title: 'Client requests · Inkwell' };
  }
  return base;
}

function renderIndex(urlPath) {
  const meta = pageMeta(urlPath);
  const url = `${APP_URL}${urlPath}`;
  const image = meta.image ? (meta.image.startsWith('http') ? meta.image : `${APP_URL}${meta.image}`) : `${APP_URL}/og-default.png`;
  const tags = [
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:site_name" content="Inkwell">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n  ');
  return INDEX_HTML
    .replace(/<title>.*?<\/title>/, `<title>${esc(meta.title)}</title>`)
    .replace(/<meta name="description" content=".*?">/, `<meta name="description" content="${esc(meta.description)}">`)
    .replace('<!--META-->', tags)
    .replace('/css/style.css"', `/css/style.css?v=${pkg.version}"`)
    .replace('/js/api.js"', `/js/api.js?v=${pkg.version}"`)
    .replace('/js/charts.js"', `/js/charts.js?v=${pkg.version}"`)
    .replace('/js/app.js"', `/js/app.js?v=${pkg.version}"`);
}

const sitemapRows = {
  artists: db.prepare("SELECT id, created_at FROM users WHERE role = 'artist' AND suspended_at IS NULL"),
  galleries: db.prepare('SELECT g.id, g.created_at FROM galleries g JOIN users u ON u.id = g.artist_id WHERE u.suspended_at IS NULL'),
  artworks: db.prepare('SELECT a.id, a.created_at FROM artworks a JOIN users u ON u.id = a.artist_id WHERE u.suspended_at IS NULL'),
};

function sitemap() {
  const urls = [['/', '1.0'], ['/artists', '0.9'], ['/requests', '0.6'], ['/terms', '0.2'], ['/privacy', '0.2']]
    .map(([p, pr]) => `<url><loc>${esc(APP_URL + p)}</loc><priority>${pr}</priority></url>`);
  for (const [kind, stmt] of Object.entries(sitemapRows)) {
    for (const row of stmt.all()) urls.push(`<url><loc>${esc(`${APP_URL}/${kind}/${row.id}`)}</loc><lastmod>${row.created_at.slice(0, 10)}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
}

/* ---------- app ---------- */

function createApp(options = {}) {
  const useRateLimits = options.rateLimits ?? !isTest;
  const useLogger = options.log ?? !isTest;
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set('trust proxy', v === 'true' || v === '1' ? 1 : (Number(v) || v));
  }

  app.use(securityHeaders);
  app.use(compression());
  if (useLogger) app.use(requestLogger());

  // The Stripe webhook needs the raw body for signature verification; everything else is JSON.
  app.post('/api/payments/webhook/stripe', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser);
  app.use('/api', cors(APP_ORIGINS));
  app.use('/api', originCheck([APP_URL, ...APP_ORIGINS]));

  if (useRateLimits) {
    const limits = options.limits || {};
    app.use('/api', rateLimit({ name: 'api', windowMs: 60000, max: limits.api || 600, keyFn: (r) => (r.user ? `u${r.user.id}` : r.ip) }));
    app.use('/api/auth/login', rateLimit({ name: 'login', windowMs: 15 * 60000, max: limits.login || 20, message: 'Too many sign-in attempts. Try again in a few minutes.' }));
    app.use('/api/auth/register', rateLimit({ name: 'register', windowMs: 60 * 60000, max: limits.register || 10, message: 'Too many accounts created from this network. Try again later.' }));
    app.use('/api/auth/forgot', rateLimit({ name: 'forgot', windowMs: 15 * 60000, max: limits.forgot || 5, message: 'Too many reset requests. Check your inbox or try again later.' }));
    app.use('/api/reports', rateLimit({ name: 'reports', windowMs: 60 * 60000, max: limits.reports || 30 }));
    app.use('/api/messages', rateLimit({ name: 'messages', windowMs: 60000, max: limits.messages || 120, keyFn: (r) => (r.user ? `u${r.user.id}` : r.ip), message: 'Slow down a little. Try again in a minute.' }));
  }

  app.get('/api/health', (_req, res) => {
    let dbOk = false;
    try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { dbOk = false; }
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, version: pkg.version, uptime: Math.round(process.uptime()) });
  });

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/artists/me/analytics', require('./routes/analytics')); // before the artists router's /:id
  app.use('/api/artists', require('./routes/artists'));
  app.use('/api', require('./routes/reviews')); // before bookings: its /appointments/:id/review must win over /appointments/:id/:action
  app.use('/api', require('./routes/consent')); // same reason: /appointments/:id/consent
  app.use('/api', require('./routes/bookings'));
  app.use('/api', require('./routes/galleries'));
  app.use('/api/requests', require('./routes/requests'));
  app.use('/api/messages', require('./routes/messages'));
  app.use('/api/collections', require('./routes/collections'));
  app.use('/api/flash', require('./routes/flash'));
  app.use('/api/waitlist', require('./waitlist').router);
  app.use('/api/stencils', require('./stencils').router);
  app.use('/api/inspiration', require('./inspiration').router);
  app.use('/api/mockups', require('./mockups').router);
  const calendarRoutes = require('./routes/calendar');
  app.use('/api/calendar', calendarRoutes.api);
  app.use(calendarRoutes.pub); // /calendar/:token.ics
  app.use(require('./routes/share')); // /og/*.png share cards, /api/share/qr.svg, /embed/artists/:id
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/admin', require('./routes/admin'));
  const pushRoutes = require('./routes/push');
  app.use('/api/push', pushRoutes.push);
  app.use('/api/notifications', pushRoutes.notifications);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use('/uploads', uploadHeaders, express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny' }));
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin', 'Disallow: /settings', 'Disallow: /messages', 'Disallow: /dashboard', 'Disallow: /appointments', `Sitemap: ${APP_URL}/sitemap.xml`, ''].join('\n'));
  });
  app.get('/sitemap.xml', (_req, res) => { res.type('application/xml').send(sitemap()); });
  // The service worker must never be cached by intermediaries and carries the app version so a
  // deploy invalidates the offline shell.
  app.get('/sw.js', (_req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.type('application/javascript').send(SW_SOURCE.replace(/__VERSION__/g, pkg.version));
  });
  // Deep-link association files for the native apps, served only once the ids are configured.
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    if (!process.env.ANDROID_PACKAGE || !process.env.ANDROID_CERT_SHA256) return res.status(404).json({ error: 'Not configured.' });
    res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: process.env.ANDROID_PACKAGE, sha256_cert_fingerprints: process.env.ANDROID_CERT_SHA256.split(',').map((f) => f.trim()) } }]);
  });
  app.get('/.well-known/apple-app-site-association', (_req, res) => {
    if (!process.env.IOS_TEAM_ID || !process.env.IOS_BUNDLE_ID) return res.status(404).json({ error: 'Not configured.' });
    res.json({ applinks: { apps: [], details: [{ appID: `${process.env.IOS_TEAM_ID}.${process.env.IOS_BUNDLE_ID}`, paths: ['/artists/*', '/artworks/*', '/galleries/*', '/requests/*', '/appointments', '/messages/*', '/notifications', '/reset'] }] }, webcredentials: { apps: [`${process.env.IOS_TEAM_ID}.${process.env.IOS_BUNDLE_ID}`] } });
  });
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: isProd ? '7d' : 0, dotfiles: 'deny' }));

  // Any other path is the single-page app, with share metadata for the page in question.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || path.extname(req.path)) return res.status(404).type('text/plain').send('Not found');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderIndex(req.path));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    // Programming errors (a TypeError from an odd JSON shape, a database error) are ours, not the caller's.
    const internal = err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || /^SQLITE_/.test(err.code || '');
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.type === 'entity.too.large' ? 413 : (internal ? 500 : 400)));
    let message = err.message || 'Something went wrong.';
    if (err.code === 'LIMIT_FILE_SIZE') message = 'Images must be 8 MB or smaller.';
    if (err.type === 'entity.parse.failed') message = 'Malformed request body.';
    if (status >= 500) { console.error(`[error] ${req.method} ${req.originalUrl}`, err); message = 'Something went wrong on our side.'; }
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  return app;
}

/* ---------- startup ---------- */

function ensureSeeded() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
    console.log('Empty database detected. Seeding demo data...');
    require('./seed').seed();
  }
}

function bootstrapAdmin() {
  const email = process.env.INKWELL_ADMIN_EMAIL;
  if (!email) return;
  const info = db.prepare('UPDATE users SET is_admin = 1 WHERE email = ? AND is_admin = 0').run(email);
  if (info.changes) console.log(`Granted admin to ${email}.`);
}

/** Loud warnings for configurations that are fine in development but not for a live site. */
function configWarnings() {
  const warnings = [];
  if (isProd) {
    if (!process.env.APP_URL) warnings.push('APP_URL is not set; email links and share previews will point at localhost.');
    if (!process.env.STRIPE_SECRET_KEY) warnings.push('STRIPE_SECRET_KEY is not set: the DEMO card processor is active. Real money is not being charged.');
    if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) warnings.push('STRIPE_WEBHOOK_SECRET is not set; payments completed without the client returning will not be recorded.');
    if (!process.env.SMTP_URL && !process.env.SMTP_HOST) warnings.push('No SMTP configuration: emails are only logged, and password resets cannot reach users.');
    if (!process.env.VAPID_PUBLIC_KEY) warnings.push('VAPID keys are not set; generated keys are stored in the database, which is fine unless you run several instances.');
    if (!process.env.FCM_SERVICE_ACCOUNT_JSON) warnings.push('FCM_SERVICE_ACCOUNT_JSON is not set: the native iOS/Android apps will not receive push notifications.');
    if (!process.env.TRUST_PROXY) warnings.push('TRUST_PROXY is not set; behind a reverse proxy, rate limits will see the proxy address and secure cookies may not work.');
    if (process.env.INKWELL_SKIP_SEED !== '1') warnings.push('INKWELL_SKIP_SEED is not 1: an empty database would be filled with demo accounts that share a public password.');
  }
  return warnings;
}

if (require.main === module) {
  if (process.env.INKWELL_SKIP_SEED !== '1') ensureSeeded();
  bootstrapAdmin();
  configWarnings().forEach((w) => console.warn(`[config] ${w}`));
  require('./reminders').start();
  const port = Number(process.env.PORT) || 3000;
  const server = createApp().listen(port, () => {
    console.log(`Inkwell ${pkg.version} running at http://localhost:${port} (${isProd ? 'production' : 'development'})`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    require('./messaging').closeAll();
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { createApp, renderIndex, pageMeta, configWarnings };
