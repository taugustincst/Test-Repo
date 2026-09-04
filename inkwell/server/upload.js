'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = process.env.INKWELL_UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// SVG is deliberately excluded for user uploads: it can carry scripts. Demo seed art is written directly.
const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ALLOWED[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed.'));
  },
});

/** Public URL for a stored upload filename. */
function publicUrl(filename) {
  return `/uploads/${filename}`;
}

/** Delete an uploaded file (and its thumbnail, if any) by its public URL, ignoring missing files. */
function removeByUrl(url) {
  if (!url || !url.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.rm(file, { force: true }, () => {});
  fs.rm(file.replace(/\.[a-z0-9]+$/i, '.thumb.webp'), { force: true }, () => {});
}

module.exports = { upload, UPLOAD_DIR, publicUrl, removeByUrl };
