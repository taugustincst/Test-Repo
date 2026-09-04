'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const mailer = require('../mailer');

const router = express.Router();

const REASONS = ['spam', 'harassment', 'hate', 'nudity', 'copyright', 'scam', 'other'];

const TARGETS = {
  artwork: db.prepare('SELECT id FROM artworks WHERE id = ?'),
  comment: db.prepare('SELECT id FROM comments WHERE id = ?'),
  user: db.prepare('SELECT id FROM users WHERE id = ?'),
  request: db.prepare('SELECT id FROM tattoo_requests WHERE id = ?'),
  review: db.prepare('SELECT id FROM reviews WHERE id = ?'),
};
const existingOpen = db.prepare(`
  SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'
`);
const insertReport = db.prepare(`
  INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?)
`);
const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1 AND suspended_at IS NULL');

router.post('/', requireAuth, (req, res) => {
  const { target_type: targetType, target_id: targetId, reason, details = '' } = req.body || {};
  const lookup = TARGETS[targetType];
  if (!lookup) return res.status(400).json({ error: 'Unknown report target.' });
  if (!lookup.get(targetId)) return res.status(404).json({ error: 'That content no longer exists.' });
  if (!REASONS.includes(reason)) return res.status(400).json({ error: 'Pick a reason.' });
  if (targetType === 'user' && Number(targetId) === req.user.id) return res.status(400).json({ error: 'You cannot report yourself.' });
  if (existingOpen.get(req.user.id, targetType, targetId)) return res.json({ ok: true, duplicate: true });
  const info = insertReport.run(req.user.id, targetType, Number(targetId), reason, String(details).trim().slice(0, 2000));
  const report = { id: info.lastInsertRowid, target_type: targetType, target_id: Number(targetId), reason, details };
  admins.all().forEach((a) => mailer.notify(mailer.templates.reportFiled(a.id, report)));
  res.status(201).json({ ok: true, report_id: report.id, reasons: REASONS });
});

router.get('/reasons', (_req, res) => res.json({ reasons: REASONS }));

module.exports = router;
