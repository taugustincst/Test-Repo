#!/usr/bin/env node
'use strict';
/* Grant or revoke admin rights. Usage: node scripts/make-admin.js user@example.com [--revoke] */
const { db } = require('../server/db');
const email = process.argv[2];
const revoke = process.argv.includes('--revoke');
if (!email) { console.error('Usage: node scripts/make-admin.js user@example.com [--revoke]'); process.exit(1); }
const info = db.prepare('UPDATE users SET is_admin = ? WHERE email = ?').run(revoke ? 0 : 1, email);
if (!info.changes) { console.error(`No account with email ${email}.`); process.exit(1); }
console.log(`${email} is ${revoke ? 'no longer' : 'now'} an admin.`);
db.close();
