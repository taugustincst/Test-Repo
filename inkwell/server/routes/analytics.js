'use strict';

const express = require('express');
const { requireRole } = require('../auth');
const analytics = require('../analytics');

const router = express.Router();
router.use(requireRole('artist'));

router.get('/', (req, res) => {
  const key = String(req.query.range || '30d');
  if (!analytics.RANGES[key]) return res.status(400).json({ error: `range must be one of ${Object.keys(analytics.RANGES).join(', ')}.` });
  res.json(analytics.report(req.user.id, key));
});

router.get('/export.csv', (req, res) => {
  const key = String(req.query.range || '30d');
  if (!analytics.RANGES[key]) return res.status(400).json({ error: 'Unknown range.' });
  const { filename, csv } = analytics.exportCsv(req.user.id, key);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('text/csv').send(csv);
});

module.exports = router;
