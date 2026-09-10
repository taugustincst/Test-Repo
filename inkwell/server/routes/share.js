'use strict';

const express = require('express');
const share = require('../share');
const { embedHeaders } = require('../security');

const router = express.Router();

const CARD_HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'Cross-Origin-Resource-Policy': 'cross-origin' };

function card(maker) {
  return async (req, res, next) => {
    try {
      const buf = await maker(req.params.id);
      if (!buf) return res.status(404).type('text/plain').send('Not found');
      res.set(CARD_HEADERS).send(buf);
    } catch (err) { next(err); }
  };
}

/* Share cards used as link previews (og:image). */
router.get('/og/artists/:id.png', card(share.artistCard));
router.get('/og/artworks/:id.png', card(share.artworkCard));
router.get('/og/galleries/:id.png', card(share.galleryCard));
router.get('/og/collections/:id.png', card(share.collectionCard));

/* QR code for any Inkwell URL. */
router.get('/api/share/qr.svg', async (req, res, next) => {
  try {
    const svg = await share.qrSvg(String(req.query.url || '/'));
    if (!svg) return res.status(400).json({ error: 'Only Inkwell links can be encoded.' });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }).send(svg);
  } catch (err) { next(err); }
});

/* Embeddable portfolio widget for artists' own websites. */
router.get('/embed/artists/:id', embedHeaders, (req, res) => {
  const html = share.embedHtml(req.params.id, { limit: req.query.limit, theme: req.query.theme });
  if (!html) return res.status(404).type('text/plain').send('Not found');
  res.set('Cache-Control', 'public, max-age=600').type('html').send(html);
});

module.exports = router;
