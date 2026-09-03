'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { db } = require('./db');
const { loadUser } = require('./auth');
const { UPLOAD_DIR } = require('./upload');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(loadUser);

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/artists', require('./routes/artists'));
  app.use('/api', require('./routes/bookings'));
  app.use('/api', require('./routes/galleries'));
  app.use('/api/requests', require('./routes/requests'));
  app.use('/api/messages', require('./routes/messages'));
  app.use('/api/payments', require('./routes/payments'));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Any non-API path serves the single-page app.
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Images must be 8 MB or smaller.' : err.message || 'Something went wrong.';
    if (status >= 500) console.error(err);
    res.status(status).json({ error: message });
  });

  return app;
}

function ensureSeeded() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
    console.log('Empty database detected. Seeding demo data...');
    require('./seed').seed();
  }
}

if (require.main === module) {
  if (process.env.INKWELL_SKIP_SEED !== '1') ensureSeeded();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Inkwell running at http://localhost:${port}`);
  });
}

module.exports = { createApp };
