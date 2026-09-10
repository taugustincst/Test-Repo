'use strict';

/**
 * Messaging support: the live event hub (server-sent events), the "usually replies within" stat
 * shown on artist profiles, and the booking context shown beside a conversation.
 */

const { db } = require('./db');

/* ---------- live events ---------- */

const streams = new Map(); // userId -> Set<res>
const HEARTBEAT_MS = 25000;

/** Attach a response as a server-sent-events stream for a user. Returns a detach function. */
function subscribe(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, HEARTBEAT_MS);
  return () => {
    clearInterval(beat);
    const set = streams.get(userId);
    if (set) { set.delete(res); if (!set.size) streams.delete(userId); }
  };
}

/** Send an event to every open stream of a user. */
function emit(userId, event, data) {
  const set = streams.get(userId);
  if (!set) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(frame); } catch { set.delete(res); } }
  return set.size;
}

/** Close every stream (used on shutdown so the server can exit). */
function closeAll() {
  for (const set of streams.values()) for (const res of set) { try { res.end(); } catch { /* ignore */ } }
  streams.clear();
}

function streamCount(userId) {
  const set = streams.get(userId);
  return set ? set.size : 0;
}

/* ---------- reply time ---------- */

const recentForArtist = db.prepare(`
  SELECT m.sender_id, m.recipient_id, m.created_at FROM messages m
  JOIN users other ON other.id = CASE WHEN m.sender_id = @artist THEN m.recipient_id ELSE m.sender_id END
  WHERE (m.sender_id = @artist OR m.recipient_id = @artist) AND other.role = 'client'
    AND m.created_at > datetime('now', '-90 days')
  ORDER BY m.created_at ASC, m.id ASC
`);

/**
 * Median time (seconds) an artist takes to answer a client, over the last 90 days. Each client
 * "burst" (messages since the artist's last reply) counts once, from its first message to the reply.
 * Returns null when there are fewer than three answered bursts.
 */
function replyTime(artistId) {
  const rows = recentForArtist.all({ artist: artistId });
  const waiting = new Map(); // clientId -> first unanswered client message time
  const samples = [];
  for (const m of rows) {
    const t = Date.parse(`${m.created_at.replace(' ', 'T')}Z`);
    if (m.recipient_id === artistId) {
      if (!waiting.has(m.sender_id)) waiting.set(m.sender_id, t);
    } else if (waiting.has(m.recipient_id)) {
      samples.push(Math.max(0, t - waiting.get(m.recipient_id)) / 1000);
      waiting.delete(m.recipient_id);
    }
  }
  if (samples.length < 3) return null;
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]);
}

/** Human label for a reply time in seconds. */
function replyLabel(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 3600) return 'Usually replies within an hour';
  if (seconds < 6 * 3600) return 'Usually replies within a few hours';
  if (seconds < 24 * 3600) return 'Usually replies within a day';
  if (seconds < 3 * 24 * 3600) return 'Usually replies within a few days';
  return 'Usually replies within a week';
}

/* ---------- conversation context ---------- */

const apptsBetween = db.prepare(`
  SELECT id, starts_at, ends_at, status, price, deposit_amount, note FROM appointments
  WHERE artist_id = ? AND client_id = ? ORDER BY starts_at DESC LIMIT 40
`);
const paidBetween = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE payer_id = ? AND payee_id = ? AND status = 'paid'
`);
const openRequestsFor = db.prepare(`
  SELECT r.id, r.title, r.style, r.budget_min, r.budget_max, r.created_at,
         (SELECT status FROM proposals p WHERE p.request_id = r.id AND p.artist_id = ?) AS my_proposal
  FROM tattoo_requests r WHERE r.client_id = ? AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 5
`);
const reviewBetween = db.prepare('SELECT rating, body, created_at FROM reviews WHERE artist_id = ? AND client_id = ? ORDER BY created_at DESC LIMIT 1');
const firstContact = db.prepare(`
  SELECT MIN(created_at) AS at FROM messages
  WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
`);

/** Booking history between an artist and a client, shown beside the thread. */
function context(artistId, clientId) {
  const appts = apptsBetween.all(artistId, clientId);
  const now = new Date().toISOString().slice(0, 16);
  const upcoming = appts.filter((a) => a.starts_at >= now && ['pending', 'confirmed'].includes(a.status)).sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
  const past = appts.filter((a) => !(a.starts_at >= now && ['pending', 'confirmed'].includes(a.status)));
  return {
    next_appointment: upcoming[0] || null,
    upcoming_count: upcoming.length,
    completed_count: past.filter((a) => a.status === 'completed').length,
    cancelled_count: past.filter((a) => ['cancelled', 'declined'].includes(a.status)).length,
    recent: past.slice(0, 3),
    total_paid: paidBetween.get(clientId, artistId).total,
    open_requests: openRequestsFor.all(artistId, clientId),
    review: reviewBetween.get(artistId, clientId) || null,
    since: (firstContact.get(artistId, clientId, clientId, artistId) || {}).at || null,
  };
}

/* ---------- attachments ---------- */

const ATTACHMENT_TYPES = new Set(['image', 'artwork']);

function parseAttachments(json) {
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((a) => a && ATTACHMENT_TYPES.has(a.type)) : [];
  } catch {
    return [];
  }
}

/** One-line preview of a message for the conversation list. */
function preview(row) {
  if (row.deleted_at) return 'Message removed';
  if (row.body) return row.body;
  const atts = parseAttachments(row.attachments);
  if (atts.some((a) => a.type === 'artwork')) return 'Shared a tattoo';
  if (atts.length) return atts.length > 1 ? `${atts.length} photos` : 'Photo';
  return '';
}

module.exports = { subscribe, emit, closeAll, streamCount, replyTime, replyLabel, context, parseAttachments, preview, HEARTBEAT_MS };
