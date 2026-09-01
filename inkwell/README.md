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
  cookie sessions, multer for image uploads.
- Vanilla JavaScript single-page frontend with hash routing. No build step.
- Demo artwork is generated as SVG so the seed works offline.

## Configuration

| Variable              | Default            | Purpose                             |
|-----------------------|--------------------|-------------------------------------|
| `PORT`                | `3000`             | HTTP port                           |
| `INKWELL_DB_PATH`     | `data/inkwell.db`  | SQLite database file                |
| `INKWELL_UPLOAD_DIR`  | `uploads/`         | Where uploaded images are stored    |
| `INKWELL_SKIP_SEED`   | unset              | Set to `1` to never auto-seed       |
| `NODE_ENV`            | unset              | `production` marks cookies secure   |

## API overview

All endpoints live under `/api` and return JSON. Authentication is a session cookie.

| Area         | Endpoints |
|--------------|-----------|
| Auth         | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PUT /auth/me`, `POST /auth/me/avatar` |
| Artists      | `GET /artists`, `GET /artists/:id`, `POST`/`DELETE /artists/:id/follow` |
| Galleries    | `GET /feed`, `POST /galleries`, `GET`/`PUT`/`DELETE /galleries/:id`, `POST /galleries/:id/artworks` |
| Artworks     | `GET`/`PUT`/`DELETE /artworks/:id`, `POST /artworks/:id/like`, `GET`/`POST /artworks/:id/comments`, `DELETE /comments/:id` |
| Requests     | `GET`/`POST /requests`, `GET`/`DELETE /requests/:id`, `PUT /requests/:id/status`, `POST /requests/:id/proposals`, `POST /requests/proposals/:id/accept|decline` |
| Booking      | `GET /artists/:id/availability`, `PUT /artists/me/availability`, `GET /artists/:id/slots?date=`, `GET`/`POST /appointments`, `POST /appointments/:id/confirm|decline|complete|cancel` |
| Messages     | `GET /messages`, `GET /messages/unread`, `GET`/`POST /messages/:userId` |

## Project layout

```
inkwell/
  server/
    index.js        Express app and startup
    db.js           SQLite schema
    auth.js         Sessions, password hashing, role guards
    upload.js       Image upload handling
    seed.js         Demo data and SVG artwork generator
    routes/         auth, artists, galleries, requests, bookings, messages
  public/
    index.html      App shell
    css/style.css   Styles
    js/api.js       Fetch wrapper
    js/app.js       Router and views
  test/api.test.js  End-to-end API tests
```
