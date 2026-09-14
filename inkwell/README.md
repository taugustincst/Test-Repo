# Inkwell

A social platform for tattoo artists. Artists share their work in galleries,
clients post what they want and receive proposals, and sessions are booked
straight from an artist's published hours.

## Features

**Galleries and social**
- Artists create galleries and upload pieces with style, placement and notes.
- Explore feed with style filters, search, and "recent" or "most loved" sorting.
- Lightbox view with likes and comments. Anyone signed in can follow an artist.

**Flash designs**
- Artists post pre-drawn designs at a fixed price with style and size, one-off or repeatable, and
  can hide or edit them. A public board at `/flash` lists what is available across artists with
  style, price and sort filters; each artist's profile shows their flash, and the dashboard has a
  Flash tab with claims per design.
- Clients claim a design by booking a slot with it attached: the session price is fixed to the
  flash price, the deposit is capped at it, and the booking request tells the artist which design.
  One-off designs leave the board while the booking is alive, come back if it is cancelled or
  declined, and are marked sold when the session completes.

**Finding clients**
- Clients post tattoo requests: idea, style, placement, size, budget, reference image.
- Artists browse open requests and send proposals with a quote and estimated hours.
- Clients see every proposal, accept one (the rest auto-decline), and can book the artist directly.
- Direct messaging between any artist and client, with unread counts (see Messaging inbox).

**Booking**
- Artists publish weekly hours and a session length. Free slots are computed automatically.
- Clients pick a day, pick a slot, add a note, and request a booking.
- Artists confirm, decline, or complete sessions. Either side can cancel. Taken slots are blocked.
- A "Books closed" switch stops new booking requests without hiding the profile.
- Reminders: artist and client each get an email, push and in-app reminder the day before and two
  hours before a confirmed session; artists get a nudge for bookings still unconfirmed two days
  out. Each reminder is sent once, whatever the process uptime. Clients and artists can turn
  session reminders off in settings.
- Calendar sync: every account has a private iCalendar feed (`/calendar/<token>.ics`) to
  subscribe to from Google Calendar, Apple Calendar or Outlook, with pending sessions tentative and
  cancellations propagated; the link can be reset. Each booking card has "Add to calendar" (Google,
  Outlook.com, .ics download), and confirmation emails carry the Google link.
- Busy calendar import: an artist can connect the private iCal address of a personal or studio
  calendar. Its events block booking slots, refreshed every 30 minutes
  (`INKWELL_BUSY_CALENDAR_REFRESH_MINUTES`). Recurring events are not expanded.
- Appointment times are wall-clock times in the server's timezone (set `TZ`); calendar files carry
  `INKWELL_TIMEZONE` (defaults to the server zone).

**Stencil library**
- Every gallery piece and flash design an artist uploads is traced into a line stencil in the
  background and saved as black lines on a transparent PNG. The tracer combines two passes: pen
  strokes of either polarity are found with a morphological top-hat and black-hat, so a stroke
  becomes one line rather than its two edges; everything else (fills, photos, shading) is traced
  by Sobel edges thinned to one pixel. Both are thresholded adaptively, small blobs (camera grain,
  JPEG noise) are dropped, and lines are thickened to survive transfer. Pieces that predate the
  library are picked up by the scheduler a batch at a time (`INKWELL_STENCIL_BACKFILL` per run),
  with a quarter of each run re-tracing stencils made by an older tracer, or all at once with
  "Trace missing pieces". Artists can also drop any image straight into the library.
- The dashboard Stencils tab filters by source and favourites, renames, favourites, re-traces at
  five detail levels (bold outlines only through fine lines and texture) and deletes. Deleting a
  piece removes its stencil.
- Download at real size: width or height in centimetres at 300 dpi (up to 6000 px), optionally
  mirrored for thermal transfer paper, on white or transparent.

**Waitlist**
- Clients join an artist's waitlist from the profile or booking page, optionally for a date window
  or a specific flash design, with a note. Artists see their queue on a dashboard tab and can
  invite anyone to book with a message.
- When a booked future slot is cancelled or declined, the first five waiting clients whose window
  covers that day are told, with a link straight to that day on the booking page; nobody is told
  about more than one slot per twelve hours. Reopening the books tells everyone waiting. Booking
  with the artist closes the client's entry.

**Consent forms**
- Before a session the client signs a consent form on any device: legal name and date of birth
  (checked against the artist's minimum age), a seven-question health questionnaire with details
  for anything flagged, the studio's terms, acknowledgements of risks and aftercare, optional
  photo consent, and a drawn signature.
- Signed forms stay with the booking as the artist's record: the artist is notified with the
  flagged health items, can open the form from the booking card and print or save it as a PDF.
  The signature image is served only to the two parties and never cached.
- Booking cards show "Consent ✓" or "Consent pending"; the day-before reminder asks unsigned
  clients to complete it. Artists set their terms, minimum age and photo-consent question in
  settings and can require a signed form before a session can be marked completed.
- When a client deletes their account the health answers are erased; the signed record stays for
  the artist's liability records.

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
- Clients review an artist after a completed session (1 to 5 stars, text and up to three photos,
  healed shots encouraged). Every review is marked as a verified session. Artists can reply.
- Artist profiles show the average, a star breakdown, the share rated 4 stars or more, a strip of
  client photos, and reviews sortable by newest, highest, lowest, with photos or most helpful.
  Signed-in users can mark a review helpful.
- Clients can edit a review for 30 days, see all their reviews and the sessions still waiting for
  one on their dashboard, and get one reminder email two days after a completed session
  (`INKWELL_REVIEW_REMINDER_DAYS`).

**Portfolio sharing**
- Share buttons on artist profiles, galleries and pieces: the device share sheet where the browser
  has one, copy link, QR code, email, WhatsApp, X, Facebook and Pinterest.
- Every artist, gallery, piece and shared board has a generated 1200×630 share card (`/og/...png`)
  used as its link preview, so shared links look right in messages and on social.
- Artists get a "Share your portfolio" panel on the dashboard with their link, QR code, share card
  and an embed snippet. The embed (`/embed/artists/:id?theme=light|dark&limit=`) is a small
  frameable page showing their most liked work with a booking button, for their own website.
- Boards: anyone signed in can save pieces into boards (reference boards, mood boards). Boards are
  private until shared; a board can be shared by link, attached to a tattoo request so artists can
  open it, or sent in a message.

**Trust and safety**
- Anyone signed in can report an artwork, comment, request, review or user.
- Admins get a moderation queue: dismiss, remove the content, or suspend the owner. Suspended
  accounts cannot sign in, their content leaves the feeds, and they are emailed the reason.
- User management: search, suspend, reinstate, grant or revoke admin.
- Terms of Service and Privacy Policy pages (templates for legal review), accepted at signup.
- Users can export all their data as JSON, sign out everywhere, and delete their account. Deletion
  removes content and personal data, cancels active bookings with the usual refunds, and keeps
  anonymised payment records.

**Artist analytics**
- A dashboard at `/analytics` for artists: revenue collected, profile and artwork views, unique
  visitors, booking requests and confirmation rate, new followers and rating, each compared with
  the previous period. Charts for views over time, revenue and requests per period, the booking
  funnel, busiest weekdays and hours, top artworks, the ratings breakdown, first-time versus
  returning clients, and open client requests in the artist's styles. Ranges of 7, 30, 90 days
  or 12 months; every chart has a table view; bookings export as CSV for accounting.
- View tracking is privacy-preserving: signed-in viewers are keyed by id, anonymous viewers by a
  hash of address, browser and a salt that rotates daily, so nobody is followed across days and
  no raw address is stored. Bots and an artist's own views are ignored; events expire after
  400 days (`INKWELL_ANALYTICS_RETENTION_DAYS`).

**Messaging inbox**
- One inbox at `/messages` for artists and clients: search across people and message text, filters
  for unread, starred and archived conversations, and a details pane beside each thread with the
  booking history between the two people (next session, sessions done, amount paid, open requests,
  the review) so an artist never has to leave the conversation to check.
- Threads update live over server-sent events (polling fallback for the native shell): new
  messages, "Seen" read receipts and unsends appear without a refresh. Messages group by day, load
  in pages of 50, and keep an unsent draft per conversation.
- Photos can be attached (same validation and re-encoding as artwork uploads) and artists can
  share a tattoo from their galleries as a card that links to the piece.
- Saved replies for answers artists type often, with `{first_name}`, `{name}`, `{studio}` and
  `{deposit}` filled in on insert.
- Per-conversation star, mute (no email or push for that person), archive (a new message brings it
  back), mark as unread, and "Mark all read". Blocking stops messages in both directions; the report
  flow is one click away. Messages can be unsent for 15 minutes; attachments are removed with them.
- Artist profiles show "Usually replies within an hour / a few hours / a day", the median time to
  answer a client over the last 90 days.

**Mobile**
- Installable Progressive Web App: home-screen install on Android, iOS and desktop, full-screen
  standalone mode, an offline shell with cached images, an "update available" prompt, a bottom
  tab bar and safe-area handling on phones.
- Push notifications on the web app (VAPID) for bookings, payments, proposals and messages, with a
  per-device opt-in in settings and a per-user preference. An in-app notification center with
  unread badges backs every push.
- Native iOS and Android apps via the Capacitor shell in `mobile/`: token authentication, CORS for
  the app origin, Firebase Cloud Messaging for native push (one setup covers APNs too), deep-link
  association files, and hardware back button support. See `mobile/README.md`.

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
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` set explicitly if you run more than one instance.
- For the store apps: `FCM_SERVICE_ACCOUNT_JSON` for push, and the `ANDROID_*` / `IOS_*` deep-link
  variables. Build steps are in `mobile/README.md`.
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
| `INKWELL_ANALYTICS_RETENTION_DAYS` | `400` | How long view events are kept       |
| `INKWELL_REVIEW_REMINDER_DAYS` | `2` | Days after a completed session before the review reminder |
| `INKWELL_TIMEZONE` | server zone | IANA timezone written into calendar files |
| `INKWELL_BUSY_CALENDAR_REFRESH_MINUTES` | `30` | How often artists' external busy calendars are re-fetched |
| `INKWELL_STENCIL_BACKFILL` | `20` | Pieces without a stencil traced per scheduler run |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | generated | Web push keys; generated and stored in the database if unset |
| `VAPID_CONTACT`       | `mailto:hello@inkwell.local` | Contact for push services |
| `FCM_SERVICE_ACCOUNT_JSON` | unset         | Firebase service account (JSON or path) for native push |
| `CORS_ORIGINS`        | unset              | Extra origins allowed to call the API with credentials |
| `ANDROID_PACKAGE` / `ANDROID_CERT_SHA256` | unset | Serve `/.well-known/assetlinks.json` |
| `IOS_TEAM_ID` / `IOS_BUNDLE_ID` | unset    | Serve `/.well-known/apple-app-site-association` |

## API overview

All endpoints live under `/api` and return JSON. Authentication is a session cookie.

| Area         | Endpoints |
|--------------|-----------|
| Auth         | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PUT /auth/me`, `POST /auth/me/avatar`, `PUT /auth/me/password`, `POST /auth/forgot`, `POST /auth/reset`, `GET /auth/me/emails` |
| Artists      | `GET /artists`, `GET /artists/:id`, `POST`/`DELETE /artists/:id/follow` |
| Galleries    | `GET /feed`, `POST /galleries`, `GET`/`PUT`/`DELETE /galleries/:id`, `POST /galleries/:id/artworks` |
| Artworks     | `GET`/`PUT`/`DELETE /artworks/:id`, `POST /artworks/:id/like`, `GET`/`POST /artworks/:id/comments`, `DELETE /comments/:id` |
| Requests     | `GET`/`POST /requests`, `GET`/`DELETE /requests/:id`, `PUT /requests/:id/status`, `POST /requests/:id/proposals`, `POST /requests/proposals/:id/accept|decline` |
| Flash        | `GET /flash?style=&artist_id=&max_price=&sort=newest|price_asc|price_desc&mine=1`, `GET /flash/:id`, `POST /flash` (multipart `image`), `PUT`/`DELETE /flash/:id`; `POST /appointments` accepts `flash_id` |
| Booking      | `GET /artists/:id/availability`, `PUT /artists/me/availability`, `GET /artists/:id/slots?date=`, `GET`/`POST /appointments`, `GET /appointments/:id`, `GET /appointments/:id/calendar.ics`, `POST /appointments/:id/confirm|decline|complete|cancel` (`complete` accepts `price`) |
| Calendar     | `GET /calendar` (feed links, busy status), `POST /calendar/reset`, `PUT`/`DELETE /calendar/busy`, `POST /calendar/busy/sync`; at the root: `GET /calendar/:token.ics` |
| Stencils     | `GET /stencils?source=artwork|flash|upload&favorites=1`, `POST /stencils` (multipart `image`, `title`, `detail`), `POST /stencils/backfill`, `GET`/`PUT`/`DELETE /stencils/:id` (`title`, `favorite`, `detail` re-traces), `POST /stencils/:id/regenerate`, `GET /stencils/:id/print.png?width_cm=&height_cm=&mirror=1&transparent=1&dpi=` (artists) |
| Waitlist     | `GET /waitlist` (mine, or the artist's queue), `GET /waitlist/artists/:id`, `POST /waitlist`, `DELETE /waitlist/:id`, `POST /waitlist/:id/invite` (artist) |
| Consent      | `GET`/`PUT /consent/settings` (artist), `GET`/`POST /appointments/:id/consent`, `GET /appointments/:id/consent/signature.png` |
| Payments     | `GET /payments/config`, `GET /payments`, `POST /payments/:id/pay` (demo card), `POST /payments/:id/checkout` and `POST /payments/:id/confirm` (Stripe) |
| Messages     | `GET /messages?filter=all|unread|starred|archived&q=`, `GET /messages/unread`, `POST /messages/read-all`, `GET /messages/stream` (SSE), `GET /messages/:userId?before=`, `POST /messages/:userId` (JSON or multipart with `image`, `artwork_id`), `PATCH /messages/:userId` (`starred`, `muted`, `archived`), `POST /messages/:userId/read|unread`, `DELETE /messages/:userId/messages/:id`, `POST`/`DELETE /messages/:userId/block`, `GET`/`POST /messages/saved-replies`, `PUT`/`DELETE /messages/saved-replies/:id` |
| Reviews      | `GET /artists/:id/reviews?sort=newest|highest|lowest|photos|helpful&page=`, `GET /reviews/mine`, `POST /appointments/:id/review` (multipart, `photos[]`), `PUT /reviews/:id` (edit, `remove_photos`), `POST /reviews/:id/helpful`, `POST /reviews/:id/reply`, `DELETE /reviews/:id` |
| Boards       | `GET /collections?artwork_id=`, `POST /collections`, `GET`/`PUT`/`DELETE /collections/:id`, `POST /collections/:id/items`, `DELETE /collections/:id/items/:artworkId`, `GET /collections/shared/:token` (public) |
| Sharing      | `GET /share/qr.svg?url=`; at the root: `GET /og/artists|artworks|galleries/:id.png`, `GET /og/collections/:token.png`, `GET /embed/artists/:id` |
| Reports      | `POST /reports`, `GET /reports/reasons` |
| Admin        | `GET /admin/overview`, `GET /admin/reports`, `POST /admin/reports/:id/resolve`, `GET /admin/users`, `POST /admin/users/:id/suspend|unsuspend|admin`, `DELETE /admin/content/:type/:id` |
| Account      | `GET /auth/me/export`, `DELETE /auth/me`, `POST /auth/logout-all` |
| Webhooks     | `POST /payments/webhook/stripe` |
| Push         | `GET /push/config`, `GET /push/subscriptions`, `POST`/`DELETE /push/subscribe`, `POST /push/test` |
| Notifications| `GET /notifications`, `GET /notifications/unread`, `POST /notifications/read` |
| Analytics    | `GET /artists/me/analytics?range=7d|30d|90d|12m`, `GET /artists/me/analytics/export.csv?range=` |
| Ops          | `GET /health`, plus `/robots.txt`, `/sitemap.xml`, `/sw.js`, `/manifest.json` and `/.well-known/*` at the root |

Native clients send `X-Inkwell-Client: native` on login or register and receive a `token` to use
as `Authorization: Bearer <token>` instead of the session cookie.

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
    security.js     Security headers, rate limiting, CORS, origin check, request log
    push.js         Web push (VAPID), Firebase Cloud Messaging, notification center
    analytics.js    View tracking and the artist analytics report
    messaging.js    Live message events (SSE), reply-time stat, booking context for threads
    share.js        Share cards (sharp), QR codes, embeddable portfolio widget
    reminders.js    Scheduled nudges: session reminders, confirmation nudges, review reminders, busy-calendar refresh, stencil backfill
    calendar.js     iCalendar feeds and files, add-to-calendar links, external busy-calendar import
    consent.js      Consent form definition, validation and signature handling
    waitlist.js     Waitlist queue, slot-freed and books-open notifications, artist invites
    stencils.js     Stencil tracing (sharp + Sobel), passive queue and backfill, library routes, print-size export
    seed.js         Demo data and SVG artwork generator
    routes/         auth, artists, galleries, flash, requests, bookings, payments, messages, collections, share, calendar, consent, reviews, reports, admin, push, analytics
  scripts/          backup.js, make-admin.js
  Dockerfile, docker-compose.yml, .env.example
  public/
    index.html      App shell
    css/style.css   Styles
    js/api.js       Fetch wrapper (cookie or bearer token)
    js/charts.js    Dependency-free SVG charts with tooltips and table twins
    js/app.js       Router and views
    sw.js           Service worker: offline shell, image cache, push
    manifest.json   Web app manifest
  mobile/           Capacitor shell for the iOS and Android store apps
  test/             End-to-end API tests (core flows, payments, reset, email, production hardening, mobile, analytics)
```
