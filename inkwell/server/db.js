'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.INKWELL_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.INKWELL_DB_PATH || path.join(DATA_DIR, 'inkwell.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('artist', 'client')),
  avatar_url TEXT,
  bio TEXT DEFAULT '',
  location TEXT DEFAULT '',
  email_notifications INTEGER NOT NULL DEFAULT 1,
  is_admin INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT,
  suspended_reason TEXT,
  terms_accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artist_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  studio_name TEXT DEFAULT '',
  styles TEXT NOT NULL DEFAULT '[]',
  hourly_rate INTEGER,
  min_price INTEGER,
  session_minutes INTEGER NOT NULL DEFAULT 120,
  years_experience INTEGER,
  instagram TEXT DEFAULT '',
  website TEXT DEFAULT '',
  accepting_clients INTEGER NOT NULL DEFAULT 1,
  deposit_amount INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS galleries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  thumb_url TEXT,
  width INTEGER,
  height INTEGER,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  style TEXT DEFAULT '',
  placement TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, artwork_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, artist_id)
);

CREATE TABLE IF NOT EXISTS tattoo_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  style TEXT DEFAULT '',
  placement TEXT DEFAULT '',
  size TEXT DEFAULT '',
  budget_min INTEGER,
  budget_max INTEGER,
  location TEXT DEFAULT '',
  reference_image_url TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES tattoo_requests(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  quoted_price INTEGER,
  estimated_hours REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, artist_id)
);

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id INTEGER REFERENCES tattoo_requests(id) ON DELETE SET NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled', 'completed')),
  deposit_amount INTEGER NOT NULL DEFAULT 0,
  price INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  payer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'balance')),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'refunded', 'forfeited', 'cancelled')),
  provider TEXT,
  provider_ref TEXT,
  card_last4 TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  refunded_at TEXT
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'logged' CHECK (status IN ('logged', 'sent', 'failed', 'skipped')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT DEFAULT '',
  artist_reply TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('artwork', 'comment', 'user', 'request', 'review')),
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'fcm')),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT,
  auth TEXT,
  device_name TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  url TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id INTEGER,
  visitor_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artworks_artist ON artworks(artist_id);
CREATE INDEX IF NOT EXISTS idx_artworks_gallery ON artworks(gallery_id);
CREATE INDEX IF NOT EXISTS idx_comments_artwork ON comments(artwork_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON tattoo_requests(status);
CREATE INDEX IF NOT EXISTS idx_appointments_artist ON appointments(artist_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_appt ON payments(appointment_id);
CREATE INDEX IF NOT EXISTS idx_payments_users ON payments(payer_id, payee_id);
CREATE INDEX IF NOT EXISTS idx_email_log_user ON email_log(to_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_artist ON reviews(artist_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_artist ON analytics_events(artist_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_target ON analytics_events(kind, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_follows_artist_time ON follows(artist_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_payee_time ON payments(payee_id, paid_at);
`;

db.exec(SCHEMA);

/** Add a column to an existing table if it is missing (lightweight migrations for older databases). */
function ensureColumn(table, column, ddl) {
  const cols = db.pragma(`table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
ensureColumn('users', 'email_notifications', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('artist_profiles', 'deposit_amount', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('appointments', 'deposit_amount', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('appointments', 'price', 'INTEGER');
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'suspended_at', 'TEXT');
ensureColumn('users', 'suspended_reason', 'TEXT');
ensureColumn('users', 'terms_accepted_at', 'TEXT');
ensureColumn('artworks', 'thumb_url', 'TEXT');
ensureColumn('artworks', 'width', 'INTEGER');
ensureColumn('artworks', 'height', 'INTEGER');
ensureColumn('users', 'push_notifications', 'INTEGER NOT NULL DEFAULT 1');
// Indexes on migrated columns must come after the columns exist.
db.exec('CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(suspended_at)');

/** Lists of styles used for filters and validation. */
const STYLES = [
  'Traditional', 'Neo-Traditional', 'Japanese', 'Blackwork', 'Fine Line',
  'Realism', 'Watercolor', 'Geometric', 'Tribal', 'Dotwork', 'Lettering',
  'Illustrative', 'Minimalist', 'New School', 'Ornamental',
];

module.exports = { db, DB_PATH, STYLES };
