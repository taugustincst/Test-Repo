'use strict';

/**
 * Image pipeline for user uploads. Every upload is decoded by sharp (which rejects anything that
 * is not really an image), auto-rotated, stripped of metadata, resized to a sane web size and
 * re-encoded. A thumbnail is produced for grids. GIFs keep their animation.
 */

const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');
const { UPLOAD_DIR, publicUrl } = require('./upload');

const MAX_EDGE = Number(process.env.INKWELL_IMAGE_MAX_EDGE) || 1800;
const THUMB_WIDTH = 480;
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

async function inspect(file) {
  const meta = await sharp(file, { failOn: 'error' }).metadata();
  if (!FORMATS.has(meta.format)) throw new Error('That file is not a supported image.');
  if (!meta.width || !meta.height) throw new Error('Could not read the image dimensions.');
  if (meta.width * meta.height > 60e6) throw new Error('That image is too large. Keep it under 60 megapixels.');
  return meta;
}

/**
 * Process an artwork upload in place. Returns { url, thumb_url, width, height }.
 * The original multer file is removed once the processed versions are written.
 */
async function processArtwork(file) {
  const src = path.join(UPLOAD_DIR, file.filename);
  const base = file.filename.replace(/\.[a-z0-9]+$/i, '');
  try {
    const meta = await inspect(src);
    const thumbName = `${base}.thumb.webp`;
    let outName;
    let width = meta.width;
    let height = meta.height;

    if (meta.format === 'gif') {
      outName = file.filename; // keep animation and original bytes
    } else {
      outName = `${base}.webp`;
      // A WebP upload already has this name: write beside it, then swap in the processed file.
      const tmpName = outName === file.filename ? `${base}.processed.webp` : outName;
      const info = await sharp(src, { failOn: 'error' })
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 84 })
        .toFile(path.join(UPLOAD_DIR, tmpName));
      if (tmpName !== outName) await fs.rename(path.join(UPLOAD_DIR, tmpName), path.join(UPLOAD_DIR, outName));
      width = info.width;
      height = info.height;
    }
    await sharp(src, { failOn: 'error', pages: 1 })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(path.join(UPLOAD_DIR, thumbName));
    if (outName !== file.filename) await fs.rm(src, { force: true });
    return { url: publicUrl(outName), thumb_url: publicUrl(thumbName), width, height };
  } catch (err) {
    await fs.rm(src, { force: true });
    throw new Error(err.message && err.message.startsWith('That') ? err.message : 'That file could not be read as an image.');
  }
}

/** Avatars become a 320px square WebP. Returns the public URL. */
async function processAvatar(file) {
  const src = path.join(UPLOAD_DIR, file.filename);
  const outName = `${file.filename.replace(/\.[a-z0-9]+$/i, '')}.webp`;
  try {
    await inspect(src);
    const tmpName = outName === file.filename ? `${outName.replace(/\.webp$/, '')}.processed.webp` : outName;
    await sharp(src, { failOn: 'error', pages: 1 })
      .rotate()
      .resize({ width: 320, height: 320, fit: 'cover' })
      .webp({ quality: 84 })
      .toFile(path.join(UPLOAD_DIR, tmpName));
    if (tmpName !== outName) await fs.rename(path.join(UPLOAD_DIR, tmpName), path.join(UPLOAD_DIR, outName));
    else if (outName !== file.filename) await fs.rm(src, { force: true });
    return publicUrl(outName);
  } catch (err) {
    await fs.rm(src, { force: true });
    throw new Error('That file could not be read as an image.');
  }
}

/** Reference images on requests: web-sized, no thumbnail. */
async function processReference(file) {
  const result = await processArtwork(file);
  return result.url;
}

module.exports = { processArtwork, processAvatar, processReference };
