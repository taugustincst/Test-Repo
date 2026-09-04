#!/usr/bin/env node
'use strict';
/* Consistent SQLite backup using the online backup API. Usage: node scripts/backup.js [dest-dir] */
const path = require('path');
const fs = require('fs');
const { db, DB_PATH } = require('../server/db');

const dest = process.argv[2] || path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(dest, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(dest, `inkwell-${stamp}.db`);
db.backup(file).then(() => {
  console.log(`Backup written to ${file}`);
  const keep = Number(process.env.INKWELL_BACKUP_KEEP) || 14;
  const files = fs.readdirSync(dest).filter((f) => f.startsWith('inkwell-') && f.endsWith('.db')).sort();
  files.slice(0, Math.max(0, files.length - keep)).forEach((f) => fs.rmSync(path.join(dest, f)));
  db.close();
}).catch((err) => { console.error('Backup failed:', err.message); process.exit(1); });
