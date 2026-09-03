# Inkwell

A social platform for tattoo artists. Artists share their work in galleries,
clients post what they want and receive proposals, and sessions are booked
straight from an artist's published hours.

## Features

**Galleries and social**
- Artists create galleries and upload pieces with style, placement and notes.
- Explore feed with style filters, search, and "recent" or "most loved" sorting.
- Lightbox view with likes and comments. Anyone signed in can follow an artist.

**Finding clients**
- Clients post tattoo requests: idea, style, placement, size, budget, reference image.
- Artists browse open requests and send proposals with a quote and estimated hours.
- Clients see every proposal, accept one (the rest auto-decline), and can book the artist directly.
- Direct messaging between any artist and client, with unread counts.

**Booking**
- Artists publish weekly hours and a session length. Free slots are computed automatically.
- Clients pick a day, pick a slot, add a note, and request a booking.
- Artists confirm, decline, or complete sessions. Either side can cancel. Taken slots are blocked.
- A "Books closed" switch stops new booking requests without hiding the profile.

**Payments and deposits**
- Artists set a booking deposit. It is charged when a client books and holds the slot.
- When an artist completes a session they can enter the total. The remainder after the deposit
  becomes a balance payment for the client.
- Refund policy is automatic: artist declines or cancels, everything is refunded. A client who
  cancels 48+ hours ahead gets the deposit back; later than that the deposit is kept.
- Two providers. The built-in `demo` provider takes card details in-app with test card numbers
  (4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is declined). Set `STRIPE_SECRET_KEY` to
  switch to Stripe Checkout, where the client is redirected to Stripe and card data never touches
  the server.
- Artists see collected, outstanding and refunded totals in their dashboard. Clients see what is due.

**Email notifications**
- Booking requests and status changes, deposits due and received, refunds, proposals and
  decisions, new messages (once per unread burst), welcome and password emails.
- With SMTP configured, mail is delivered through nodemailer. Without it, every email is rendered
  and stored, and shows up under "Recent emails" in profile settings so the flow can be inspected.
- Users can turn notifications off in settings. Account emails (password reset and changes) are
  always sent.

**Password reset**
- "Forgot password?" on the login page emails a one-hour, single-use link. Using it signs the user
  in and revokes all older sessions. Without a mail server the link is shown on screen in
  development so the flow can still be tried.
- Signed-in users change their password from settings, which signs out other devices.

**Reviews**
- Clients review an artist after a completed session (1 to 5 stars and text). Artists can reply.
- Average rating and review count show on artist cards and profiles.

**Trust and safety**
- Anyone signed in can report an artwork, comment, request, review or user.
- Admins get a moderation queue: dismiss, remove the content, or suspend the owner. Suspended
  accounts cannot sign in, their content leaves the feeds, and they are emailed the reason.
- User management: search, suspend, reinstate, grant or revoke admin.
- Terms of Service and Privacy Policy pages (templates for legal review), accepted at signup.
- Users can export all their data as JSON, sign out everywhere, and delete their account. Deletion
  removes content and personal data, cancels active bookings with the usual refunds, and keeps
  anonymised payment records.

**Production hardening**
- Uploads are decoded by sharp, re-encoded (metadata stripped, long edge capped at 1800px), and
  get a 480px thumbnail. Anything that is not really an image is rejected. SVG uploads are refused
  and served uploads carry a sandboxing CSP.
- Security headers on every response (CSP with `script-src 'self'`, HSTS in production,
  nosniff, frame denial, referrer and permissions policies).
- Rate limits on sign-in, registration, password reset, reports and the API in general.
- Cross-site request blocking on state changes via an Origin check on top of SameSite cookies.
- Stripe webhook (`checkout.session.completed`) with signature verification and idempotency, so
  payments are recorded even when the client never returns from Checkout.
- Real URLs (`/artists/3`) with server-injected Open Graph tags for link previews, a sitemap,
  robots.txt, a web app manifest, cache-busted assets, gzip, a health endpoint, request logging
  (JSON optional), graceful shutdown, and loud startup warnings for unsafe production settings.

## Run it

```bash
cd inkwell
npm install
npm start
```

Open http://localhost:3000. On first start an empty database is seeded with six
artists, four clients, galleries, requests, proposals, bookings and messages.

Demo accounts all use the password `password123`:

| Role   | Email                 |
|--------|-----------------------|
| Artist | mara@inkwell.demo     |
| Artist | diego@inkwell.demo    |
| Artist | priya@inkwell.demo    |
| Client | jordan@inkwell.demo   |
| Client | amara@inkwell.demo    |

Other scripts:

```bash
npm run dev    # restart on file changes
npm run seed   # seed manually (no-op if users already exist)
npm test       # API test suites against a throwaway database
npm run check  # boot the server once to validate config and schema
npm run backup # consistent SQLite backup into data/backups
npm run make-admin -- you@example.com   # grant admin to an account
```

Delete `data/inkwell.db` and `uploads/seed-*` to reset the demo data.

The seed includes an admin account, `admin@inkwell.demo`, for the moderation panel at `/admin`.

## Deploying

The app is a single Node process with SQLite and a folder of uploads, so it runs on any VM, a
container host, or a PaaS with a persistent volume.

**Docker**

```bash
cp .env.example .env      # fill in APP_URL, SMTP, Stripe, admin email
docker compose up -d --build
```

The image runs as a non-root user, keeps the database and uploads in the `/data` volume, sets
`INKWELL_SKIP_SEED=1`, and exposes a health check on `/api/health`.

**Bare metal / PaaS**

```bash
npm ci --omit=dev
NODE_ENV=production APP_URL=https://your.domain TRUST_PROXY=1 INKWELL_SKIP_SEED=1 node server/index.js
```

Put a TLS-terminating reverse proxy in front (nginx, Caddy, or the platform router) and set
`TRUST_PROXY=1` so rate limits and secure cookies see the real client.

**Production checklist**

- `APP_URL` set to the public origin (email links, share previews, Stripe return URLs).
- `INKWELL_SKIP_SEED=1` so demo accounts with a public password are never created.
- SMTP configured, otherwise password resets cannot reach users.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set; add a webhook in Stripe for
  `checkout.session.completed` pointing at `https://your.domain/api/payments/webhook/stripe`.
  Without a Stripe key the demo card processor runs and no money moves.
- `INKWELL_ADMIN_EMAIL` set to an existing account, or run `npm run make-admin -- you@example.com`.
- Back up `/data` (or `data/` and `uploads/`). `npm run backup` writes a consistent SQLite copy
  and keeps the last 14.
- Replace the Terms and Privacy templates with text reviewed by a lawyer.
- The server prints `[config]` warnings at startup for anything above that is missing.

**Scaling notes.** SQLite in WAL mode comfortably serves a single node with thousands of
users. The in-memory rate limiter and local uploads folder assume one instance; for several,
put uploads on object storage behind the same `/uploads` path and rate limit at the proxy.

## Stack

- Node.js and Express, SQLite via better-sqlite3, bcrypt password hashing,
  cookie sessions, multer for image uploads, nodemailer for email.
- Vanilla JavaScript single-page frontend with hash routing. No build step.
- Demo artwork is generated as SVG so the seed works offline.

## Configuration

| Variable              | Default            | Purpose                             |
|-----------------------|--------------------|-------------------------------------|
| `PORT`                | `3000`             | HTTP port                           |
| `INKWELL_DB_PATH`     | `data/inkwell.db`  | SQLite database file                |
| `INKWELL_UPLOAD_DIR`  | `uploads/`         | Where uploaded images are stored    |
| `INKWELL_SKIP_SEED`   | unset              | Set to `1` to never auto-seed       |
| `NODE_ENV`            | unset              | `production` marks cookies secure and hides dev reset links |
| `APP_URL`             | `http://localhost:PORT` | Base URL used in email links   |
| `STRIPE_SECRET_KEY`   | unset              | Use Stripe Checkout instead of the demo card processor |
| `STRIPE_CURRENCY`     | `usd`              | Currency for Stripe charges         |
| `SMTP_URL`            | unset              | e.g. `smtp://user:pass@host:587` to deliver mail |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | unset | Alternative to `SMTP_URL` |
| `MAIL_FROM`           | `Inkwell <no-reply@inkwell.local>` | Sender address       |
| `INKWELL_REFUND_WINDOW_HOURS` | `48`       | Client cancellation window for a deposit refund |
| `STRIPE_WEBHOOK_SECRET` | unset            | Verifies Stripe webhook signatures  |
| `TRUST_PROXY`         | unset              | `1` (or hop count) when behind a reverse proxy |
| `INKWELL_ADMIN_EMAIL` | unset              | Grants admin to this account at startup |
| `INKWELL_IMAGE_MAX_EDGE` | `1800`          | Long-edge cap for processed uploads |
| `LOG_FORMAT`          | text               | `json` for structured request logs  |

## API overview

All endpoints live under `/api` and return JSON. Authentication is a session cookie.

| Area         | Endpoints |
|--------------|-----------|
| Auth         | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PUT /auth/me`, `POST /auth/me/avatar`, `PUT /auth/me/password`, `POST /auth/forgot`, `POST /auth/reset`, `GET /auth/me/emails` |
| Artists      | `GET /artists`, `GET /artists/:id`, `POST`/`DELETE /artists/:id/follow` |
| Galleries    | `GET /feed`, `POST /galleries`, `GET`/`PUT`/`DELETE /galleries/:id`, `POST /galleries/:id/artworks` |
| Artworks     | `GET`/`PUT`/`DELETE /artworks/:id`, `POST /artworks/:id/like`, `GET`/`POST /artworks/:id/comments`, `DELETE /comments/:id` |
| Requests     | `GET`/`POST /requests`, `GET`/`DELETE /requests/:id`, `PUT /requests/:id/status`, `POST /requests/:id/proposals`, `POST /requests/proposals/:id/accept|decline` |
| Booking      | `GET /artists/:id/availability`, `PUT /artists/me/availability`, `GET /artists/:id/slots?date=`, `GET`/`POST /appointments`, `GET /appointments/:id`, `POST /appointments/:id/confirm|decline|complete|cancel` (`complete` accepts `price`) |
| Payments     | `GET /payments/config`, `GET /payments`, `POST /payments/:id/pay` (demo card), `POST /payments/:id/checkout` and `POST /payments/:id/confirm` (Stripe) |
| Messages     | `GET /messages`, `GET /messages/unread`, `GET`/`POST /messages/:userId` |
| Reviews      | `GET /artists/:id/reviews`, `POST /appointments/:id/review`, `POST /reviews/:id/reply`, `DELETE /reviews/:id` |
| Reports      | `POST /reports`, `GET /reports/reasons` |
| Admin        | `GET /admin/overview`, `GET /admin/reports`, `POST /admin/reports/:id/resolve`, `GET /admin/users`, `POST /admin/users/:id/suspend|unsuspend|admin`, `DELETE /admin/content/:type/:id` |
| Account      | `GET /auth/me/export`, `DELETE /auth/me`, `POST /auth/logout-all` |
| Webhooks     | `POST /payments/webhook/stripe` |
| Ops          | `GET /health`, plus `/robots.txt` and `/sitemap.xml` at the root |

## Project layout

```
inkwell/
  server/
    index.js        Express app and startup
    db.js           SQLite schema
    auth.js         Sessions, password hashing, role guards
    upload.js       Image upload handling
    payments.js     Payment providers (demo card processor, Stripe Checkout, webhook signatures)
    ledger.js       Deposit/balance payments and the refund policy
    mailer.js       Email delivery and templates
    images.js       Upload validation, re-encoding and thumbnails (sharp)
    security.js     Security headers, rate limiting, origin check, request log
    seed.js         Demo data and SVG artwork generator
    routes/         auth, artists, galleries, requests, bookings, payments, messages, reviews, reports, admin
  scripts/          backup.js, make-admin.js
  Dockerfile, docker-compose.yml, .env.example
  public/
    index.html      App shell
    css/style.css   Styles
    js/api.js       Fetch wrapper
    js/app.js       Router and views
  test/             End-to-end API tests (core flows, payments, reset, email, production hardening)
```
