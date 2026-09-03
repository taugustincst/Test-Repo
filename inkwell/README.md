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
npm test       # API test suite against a throwaway database
```

Delete `data/inkwell.db` and `uploads/seed-*` to reset the demo data.

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

## Project layout

```
inkwell/
  server/
    index.js        Express app and startup
    db.js           SQLite schema
    auth.js         Sessions, password hashing, role guards
    upload.js       Image upload handling
    payments.js     Payment providers (demo card processor, Stripe Checkout)
    ledger.js       Deposit/balance payments and the refund policy
    mailer.js       Email delivery and templates
    seed.js         Demo data and SVG artwork generator
    routes/         auth, artists, galleries, requests, bookings, payments, messages
  public/
    index.html      App shell
    css/style.css   Styles
    js/api.js       Fetch wrapper
    js/app.js       Router and views
  test/             End-to-end API tests (core flows, payments, reset, email)
```
