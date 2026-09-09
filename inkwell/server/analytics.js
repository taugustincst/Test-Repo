'use strict';

/**
 * Artist analytics: lightweight view tracking plus the aggregate report behind the dashboard.
 *
 * Tracking stores one row per view with a visitor key. Signed-in viewers are keyed by user id;
 * anonymous viewers by a hash of IP + user agent + a salt that rotates daily, so nobody can be
 * followed across days and no raw address is kept. An artist's own views are never counted.
 */

const crypto = require('crypto');
const { db } = require('./db');

const KINDS = new Set(['profile_view', 'artwork_view', 'gallery_view', 'booking_page_view']);
const RETENTION_DAYS = Number(process.env.INKWELL_ANALYTICS_RETENTION_DAYS) || 400;

const insertEvent = db.prepare('INSERT INTO analytics_events (artist_id, kind, target_id, visitor_key) VALUES (?, ?, ?, ?)');
const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setSetting = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
db.prepare(`DELETE FROM analytics_events WHERE created_at < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`);

let salt = { day: null, value: null };
function dailySalt() {
  const day = new Date().toISOString().slice(0, 10);
  if (salt.day === day) return salt.value;
  const stored = getSetting.get('analytics_salt');
  let parsed = stored ? JSON.parse(stored.value) : null;
  if (!parsed || parsed.day !== day) {
    parsed = { day, value: crypto.randomBytes(16).toString('hex') };
    setSetting.run('analytics_salt', JSON.stringify(parsed));
  }
  salt = parsed;
  return salt.value;
}

function visitorKey(req) {
  if (req.user) return `u:${req.user.id}`;
  const raw = `${dailySalt()}|${req.ip || ''}|${req.get('user-agent') || ''}`;
  return `a:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}

/** Record a view. Silent on any failure: analytics must never break a page. */
function track(req, kind, artistId, targetId = null) {
  try {
    if (!KINDS.has(kind) || !artistId) return;
    if (req.user && req.user.id === artistId) return;
    if (req.get && /bot|crawl|spider|slurp|preview/i.test(req.get('user-agent') || '')) return;
    insertEvent.run(artistId, kind, targetId, visitorKey(req));
  } catch (err) {
    console.error('[analytics]', err.message);
  }
}

/* ---------- report ---------- */

const RANGES = {
  '7d': { days: 7, bucket: 'day', label: 'Last 7 days' },
  '30d': { days: 30, bucket: 'day', label: 'Last 30 days' },
  '90d': { days: 90, bucket: 'week', label: 'Last 90 days' },
  '12m': { days: 365, bucket: 'month', label: 'Last 12 months' },
};

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** Resolve a range key into [from, to) date strings, the previous window, and bucket boundaries. */
function resolveRange(key) {
  const def = RANGES[key] || RANGES['30d'];
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const to = addDays(today, 1); // exclusive: through the end of today
  let from;
  const buckets = [];
  if (def.bucket === 'month') {
    from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));
    for (let i = 0; i < 12; i += 1) {
      const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1));
      const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i + 1, 1));
      buckets.push({ start: iso(start), end: iso(end), label: start.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) });
    }
  } else {
    from = addDays(today, -(def.days - 1));
    const step = def.bucket === 'week' ? 7 : 1;
    for (let d = from; d < to; d = addDays(d, step)) {
      const end = addDays(d, step) < to ? addDays(d, step) : to;
      buckets.push({ start: iso(d), end: iso(end), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) });
    }
  }
  const spanDays = Math.round((to - from) / 86400000);
  const previousFrom = addDays(from, -spanDays);
  return {
    key: RANGES[key] ? key : '30d', label: def.label, bucket: def.bucket,
    from: iso(from), to: iso(to), previous_from: iso(previousFrom), previous_to: iso(from), buckets, days: spanDays,
  };
}

const q = {
  eventsByDay: db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, kind, COUNT(*) AS n
    FROM analytics_events WHERE artist_id = ? AND created_at >= ? AND created_at < ? GROUP BY day, kind`),
  eventTotals: db.prepare(`
    SELECT kind, COUNT(*) AS n, COUNT(DISTINCT visitor_key) AS uniques
    FROM analytics_events WHERE artist_id = ? AND created_at >= ? AND created_at < ? GROUP BY kind`),
  uniqueVisitors: db.prepare(`
    SELECT COUNT(DISTINCT visitor_key) AS n FROM analytics_events
    WHERE artist_id = ? AND created_at >= ? AND created_at < ? AND kind IN ('profile_view', 'artwork_view', 'gallery_view')`),
  appointments: db.prepare(`
    SELECT id, substr(created_at, 1, 10) AS day, status, client_id, starts_at, price, created_at
    FROM appointments WHERE artist_id = ? AND created_at >= ? AND created_at < ?`),
  sessionsStarting: db.prepare(`
    SELECT starts_at, status FROM appointments
    WHERE artist_id = ? AND status IN ('confirmed', 'completed') AND substr(starts_at, 1, 10) >= ? AND substr(starts_at, 1, 10) < ?`),
  payments: db.prepare(`
    SELECT substr(paid_at, 1, 10) AS day, kind, amount, status
    FROM payments WHERE payee_id = ? AND status IN ('paid', 'forfeited') AND paid_at >= ? AND paid_at < ?`),
  follows: db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM follows
    WHERE artist_id = ? AND created_at >= ? AND created_at < ? GROUP BY day`),
  likes: db.prepare(`
    SELECT COUNT(*) AS n FROM likes l JOIN artworks a ON a.id = l.artwork_id
    WHERE a.artist_id = ? AND l.created_at >= ? AND l.created_at < ?`),
  comments: db.prepare(`
    SELECT COUNT(*) AS n FROM comments c JOIN artworks a ON a.id = c.artwork_id
    WHERE a.artist_id = ? AND c.created_at >= ? AND c.created_at < ?`),
  reviewsInRange: db.prepare(`
    SELECT rating FROM reviews WHERE artist_id = ? AND created_at >= ? AND created_at < ?`),
  reviewsAllTime: db.prepare(`SELECT rating, COUNT(*) AS n FROM reviews WHERE artist_id = ? GROUP BY rating`),
  topArtworks: db.prepare(`
    SELECT a.id, a.title, a.thumb_url, a.image_url, a.style,
           (SELECT COUNT(*) FROM analytics_events e WHERE e.kind = 'artwork_view' AND e.target_id = a.id AND e.created_at >= ? AND e.created_at < ?) AS views,
           (SELECT COUNT(*) FROM likes l WHERE l.artwork_id = a.id) AS likes,
           (SELECT COUNT(*) FROM comments c WHERE c.artwork_id = a.id) AS comments
    FROM artworks a WHERE a.artist_id = ?
    ORDER BY views DESC, likes DESC, a.created_at DESC LIMIT 6`),
  earlierClient: db.prepare(`SELECT 1 FROM appointments WHERE artist_id = ? AND client_id = ? AND created_at < ? LIMIT 1`),
  artistStyles: db.prepare('SELECT styles FROM artist_profiles WHERE user_id = ?'),
  openByStyle: db.prepare(`
    SELECT style, COUNT(*) AS n FROM tattoo_requests r JOIN users u ON u.id = r.client_id
    WHERE r.status = 'open' AND u.suspended_at IS NULL AND style != '' GROUP BY style`),
  followerTotal: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE artist_id = ?'),
};

function bucketIndex(range, day) {
  for (let i = range.buckets.length - 1; i >= 0; i -= 1) if (day >= range.buckets[i].start) return i;
  return -1;
}

function windowStats(artistId, from, to) {
  const totals = Object.fromEntries(q.eventTotals.all(artistId, from, to).map((r) => [r.kind, r]));
  const appts = q.appointments.all(artistId, from, to);
  const payments = q.payments.all(artistId, from, to);
  const followers = q.follows.all(artistId, from, to).reduce((n, r) => n + r.n, 0);
  return {
    profile_views: (totals.profile_view || {}).n || 0,
    artwork_views: (totals.artwork_view || {}).n || 0,
    gallery_views: (totals.gallery_view || {}).n || 0,
    booking_page_views: (totals.booking_page_view || {}).n || 0,
    unique_visitors: q.uniqueVisitors.get(artistId, from, to).n,
    booking_requests: appts.length,
    confirmed: appts.filter((a) => ['confirmed', 'completed'].includes(a.status)).length,
    completed: appts.filter((a) => a.status === 'completed').length,
    declined: appts.filter((a) => a.status === 'declined').length,
    cancelled: appts.filter((a) => a.status === 'cancelled').length,
    revenue: payments.reduce((n, p) => n + p.amount, 0),
    new_followers: followers,
    likes: q.likes.get(artistId, from, to).n,
    comments: q.comments.get(artistId, from, to).n,
    appts,
    payments,
  };
}

function report(artistId, rangeKey) {
  const range = resolveRange(rangeKey);
  const current = windowStats(artistId, range.from, range.to);
  const previous = windowStats(artistId, range.previous_from, range.previous_to);

  // Time series per bucket.
  const series = range.buckets.map((b) => ({ start: b.start, label: b.label, profile_views: 0, artwork_views: 0, booking_page_views: 0, booking_requests: 0, completed: 0, revenue: 0, new_followers: 0 }));
  for (const r of q.eventsByDay.all(artistId, range.from, range.to)) {
    const i = bucketIndex(range, r.day);
    if (i < 0) continue;
    if (r.kind === 'profile_view') series[i].profile_views += r.n;
    else if (r.kind === 'artwork_view') series[i].artwork_views += r.n;
    else if (r.kind === 'booking_page_view') series[i].booking_page_views += r.n;
  }
  for (const a of current.appts) {
    const i = bucketIndex(range, a.day);
    if (i >= 0) { series[i].booking_requests += 1; if (a.status === 'completed') series[i].completed += 1; }
  }
  for (const p of current.payments) {
    const i = bucketIndex(range, p.day);
    if (i >= 0) series[i].revenue += p.amount;
  }
  for (const f of q.follows.all(artistId, range.from, range.to)) {
    const i = bucketIndex(range, f.day);
    if (i >= 0) series[i].new_followers += f.n;
  }

  // Sessions by weekday and hour (confirmed or completed, by session start).
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const s of q.sessionsStarting.all(artistId, range.from, range.to)) {
    const [datePart, timePart] = s.starts_at.split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const hour = Number((timePart || '00:00').slice(0, 2));
    heatmap[weekday][hour] += 1;
  }

  // Clients: first-time versus returning within the window.
  const clientIds = [...new Set(current.appts.map((a) => a.client_id))];
  const returning = clientIds.filter((id) => q.earlierClient.get(artistId, id, range.from)).length;

  const ratingsAll = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  q.reviewsAllTime.all(artistId).forEach((r) => { ratingsAll[r.rating] = r.n; });
  const reviewCount = Object.values(ratingsAll).reduce((a, b) => a + b, 0);
  const ratingAvg = reviewCount ? Math.round((Object.entries(ratingsAll).reduce((s, [k, n]) => s + Number(k) * n, 0) / reviewCount) * 10) / 10 : null;
  const inRange = q.reviewsInRange.all(artistId, range.from, range.to).map((r) => r.rating);

  const styles = JSON.parse((q.artistStyles.get(artistId) || { styles: '[]' }).styles || '[]');
  const demand = q.openByStyle.all().filter((r) => styles.includes(r.style)).map((r) => ({ style: r.style, open_requests: r.n })).sort((a, b) => b.open_requests - a.open_requests);

  const completedWithPrice = current.appts.filter((a) => a.status === 'completed' && a.price);
  const strip = ({ appts, payments, ...rest }) => rest; // eslint-disable-line no-unused-vars

  return {
    range: { key: range.key, label: range.label, bucket: range.bucket, from: range.from, to: range.to, previous_from: range.previous_from, previous_to: range.previous_to, days: range.days },
    summary: {
      ...strip(current),
      avg_session_value: completedWithPrice.length ? Math.round(completedWithPrice.reduce((n, a) => n + a.price, 0) / completedWithPrice.length) : null,
      confirmation_rate: current.booking_requests ? Math.round((current.confirmed / current.booking_requests) * 100) : null,
      booking_conversion: current.booking_page_views ? Math.round((current.booking_requests / current.booking_page_views) * 1000) / 10 : null,
      followers_total: q.followerTotal.get(artistId).n,
      rating: ratingAvg,
      review_count: reviewCount,
      reviews_in_range: inRange.length,
    },
    previous: strip(previous),
    series,
    funnel: [
      { stage: 'Booking page views', count: current.booking_page_views },
      { stage: 'Booking requests', count: current.booking_requests },
      { stage: 'Confirmed', count: current.confirmed },
      { stage: 'Completed', count: current.completed },
    ],
    heatmap,
    top_artworks: q.topArtworks.all(range.from, range.to, artistId),
    ratings: ratingsAll,
    clients: { total: clientIds.length, returning, new: clientIds.length - returning },
    demand,
  };
}

/** Bookings in the window as CSV rows for accounting. */
const exportRows = db.prepare(`
  SELECT ap.id, ap.starts_at, ap.status, ap.price, c.name AS client_name,
         COALESCE((SELECT SUM(amount) FROM payments p WHERE p.appointment_id = ap.id AND p.status IN ('paid', 'forfeited')), 0) AS collected,
         COALESCE((SELECT SUM(amount) FROM payments p WHERE p.appointment_id = ap.id AND p.status = 'refunded'), 0) AS refunded,
         (SELECT rating FROM reviews r WHERE r.appointment_id = ap.id) AS rating
  FROM appointments ap JOIN users c ON c.id = ap.client_id
  WHERE ap.artist_id = ? AND ap.created_at >= ? AND ap.created_at < ? ORDER BY ap.starts_at ASC
`);

function exportCsv(artistId, rangeKey) {
  const range = resolveRange(rangeKey);
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['booking_id', 'session_start', 'status', 'client', 'session_total', 'collected', 'refunded', 'rating'];
  const lines = [header.join(',')];
  for (const r of exportRows.all(artistId, range.from, range.to)) {
    lines.push([r.id, r.starts_at, r.status, r.client_name, r.price ?? '', r.collected, r.refunded, r.rating ?? ''].map(cell).join(','));
  }
  return { filename: `inkwell-bookings-${range.from}-to-${range.to}.csv`, csv: `${lines.join('\n')}\n` };
}

module.exports = { track, report, exportCsv, resolveRange, RANGES, KINDS };
