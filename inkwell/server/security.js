'use strict';

/**
 * Security middleware: response headers, rate limiting, origin checks and request logging.
 * All of it is dependency-free so behaviour is easy to audit.
 */

const isProd = process.env.NODE_ENV === 'production';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProd ? ['upgrade-insecure-requests'] : []),
].join('; ');

/** Standard hardening headers on every response. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (isProd || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** The embeddable portfolio widget may be framed by any site; everything else stays un-frameable. */
function embedHeaders(_req, res, next) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', CSP.replace("frame-ancestors 'none'", 'frame-ancestors *'));
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}

/** Uploads are user content: never let them run as documents. */
function uploadHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * Fixed-window in-memory rate limiter. Good for a single node; put a shared store in front of it
 * (or use the platform's limiter) when running several instances.
 */
function rateLimit({ windowMs, max, keyFn, message, name = 'limit' }) {
  const buckets = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.reset <= now) buckets.delete(key);
  }, Math.max(windowMs, 60000));
  if (sweep.unref) sweep.unref();

  const middleware = (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: message || `Too many requests. Try again in ${retry} seconds.` });
    }
    next();
  };
  middleware.reset = () => buckets.clear();
  return middleware;
}

/**
 * Reject state-changing requests whose Origin does not match this site. SameSite cookies already
 * block most cross-site requests; this closes the gap for older browsers and misconfigured proxies.
 */
function originCheck(allowedOrigins) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next(); // non-browser clients, same-origin form posts in some browsers, webhooks
    const self = `${req.protocol}://${req.get('host')}`;
    if (origin === self || allowed.has(origin)) return next();
    res.status(403).json({ error: 'Cross-site request blocked.' });
  };
}

/**
 * CORS for the native shell and any extra origins in CORS_ORIGINS. Only listed origins get
 * headers; browsers block everything else. Credentials are allowed so cookies work in webviews.
 */
function cors(allowedOrigins) {
  const allowed = new Set(allowedOrigins.filter(Boolean));
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Inkwell-Client');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  };
}

/** One line per request. JSON when LOG_FORMAT=json so log shippers can parse it. */
function requestLogger() {
  const json = process.env.LOG_FORMAT === 'json';
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path.startsWith('/uploads/') || req.path.startsWith('/css/') || req.path.startsWith('/js/')) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const entry = { time: new Date().toISOString(), method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms), ip: req.ip, user: req.user ? req.user.id : null };
      if (json) console.log(JSON.stringify(entry));
      else console.log(`${entry.method} ${entry.path} ${entry.status} ${entry.ms}ms${entry.user ? ` u${entry.user}` : ''}`);
    });
    next();
  };
}

module.exports = { securityHeaders, uploadHeaders, rateLimit, originCheck, cors, requestLogger, CSP, embedHeaders };
