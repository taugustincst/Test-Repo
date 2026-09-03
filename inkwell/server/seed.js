'use strict';

/**
 * Seeds the database with demo artists, clients, galleries, requests, bookings and messages.
 * Artwork images are generated as SVG files so the demo works fully offline.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { UPLOAD_DIR } = require('./upload');

const DEMO_PASSWORD = 'password123';

// Deterministic pseudo-random so seeds are reproducible.
let seedState = 42;
function rand() {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}
function pick(list) { return list[Math.floor(rand() * list.length)]; }
function between(min, max) { return min + Math.floor(rand() * (max - min + 1)); }

const PALETTES = [
  ['#0f0f0f', '#f4ede4', '#b3262e', '#2d5a4c'],
  ['#111318', '#e9e3d3', '#c98b2b', '#5a6a8c'],
  ['#161616', '#f1e7dc', '#8f2d56', '#e0a458'],
  ['#0d1b2a', '#e0e1dd', '#778da9', '#c9a227'],
  ['#1b1b1b', '#f5f1e8', '#3a5a40', '#a3b18a'],
  ['#1a1423', '#efe9f4', '#7b4b94', '#e07a5f'],
];

/** Build a simple procedural SVG "flash" piece in a given style. */
function makeSvg(style, index) {
  const [bg, fg, accent, accent2] = PALETTES[index % PALETTES.length];
  const W = 800;
  const H = 1000;
  const parts = [];
  const g = (s) => parts.push(s);

  g(`<rect width="${W}" height="${H}" fill="${bg}"/>`);

  switch (style) {
    case 'Geometric':
    case 'Dotwork': {
      const cx = W / 2; const cy = H / 2;
      for (let r = 60; r < 400; r += 45) {
        g(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${fg}" stroke-width="${r % 90 === 0 ? 2 : 1}" opacity="0.9"/>`);
      }
      const sides = between(5, 9);
      for (let k = 0; k < 3; k += 1) {
        const rr = 120 + k * 90;
        const pts = [];
        for (let i = 0; i < sides; i += 1) {
          const a = (Math.PI * 2 * i) / sides + k * 0.3;
          pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
        }
        g(`<polygon points="${pts.join(' ')}" fill="none" stroke="${k === 1 ? accent : fg}" stroke-width="3"/>`);
      }
      if (style === 'Dotwork') {
        for (let i = 0; i < 400; i += 1) {
          const a = rand() * Math.PI * 2; const d = 40 + rand() * 360;
          g(`<circle cx="${(cx + d * Math.cos(a)).toFixed(1)}" cy="${(cy + d * Math.sin(a)).toFixed(1)}" r="${(0.8 + rand() * 2.4).toFixed(1)}" fill="${fg}" opacity="${(0.4 + rand() * 0.6).toFixed(2)}"/>`);
        }
      }
      break;
    }
    case 'Traditional':
    case 'Neo-Traditional':
    case 'New School': {
      // Bold rose-like motif with banner
      const cx = W / 2; const cy = H / 2 - 60;
      for (let i = 6; i > 0; i -= 1) {
        const r = i * 42;
        g(`<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.8}" fill="${i % 2 ? accent : accent2}" stroke="${bg}" stroke-width="10" transform="rotate(${i * 15} ${cx} ${cy})"/>`);
      }
      g(`<circle cx="${cx}" cy="${cy}" r="30" fill="${fg}" stroke="${bg}" stroke-width="8"/>`);
      for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI * 2 * i) / 6;
        const x = cx + 300 * Math.cos(a); const y = cy + 260 * Math.sin(a);
        g(`<path d="M${cx} ${cy} Q ${(cx + x) / 2 + 60} ${(cy + y) / 2 - 60} ${x} ${y}" stroke="${fg}" stroke-width="12" fill="none" stroke-linecap="round"/>`);
        g(`<ellipse cx="${x}" cy="${y}" rx="60" ry="26" fill="${accent2}" stroke="${bg}" stroke-width="8" transform="rotate(${(a * 180) / Math.PI} ${x} ${y})"/>`);
      }
      g(`<path d="M120 ${H - 220} C 260 ${H - 300}, 540 ${H - 140}, 680 ${H - 220} L 660 ${H - 140} C 520 ${H - 60}, 280 ${H - 220}, 140 ${H - 140} Z" fill="${fg}" stroke="${bg}" stroke-width="8"/>`);
      g(`<text x="${W / 2}" y="${H - 168}" text-anchor="middle" font-family="Georgia, serif" font-size="46" font-weight="bold" fill="${bg}" letter-spacing="6">ALWAYS</text>`);
      break;
    }
    case 'Japanese': {
      // Waves and a rising sun
      g(`<circle cx="${W / 2}" cy="360" r="220" fill="${accent}"/>`);
      for (let row = 0; row < 6; row += 1) {
        const y = 520 + row * 80;
        let d = `M -100 ${y}`;
        for (let x = -100; x < W + 100; x += 120) d += ` q 60 -70 120 0`;
        g(`<path d="${d} L ${W + 100} ${H + 50} L -100 ${H + 50} Z" fill="${row % 2 ? bg : accent2}" stroke="${fg}" stroke-width="5"/>`);
      }
      g(`<text x="${W - 80}" y="140" text-anchor="end" font-family="serif" font-size="90" fill="${fg}">墨</text>`);
      break;
    }
    case 'Blackwork':
    case 'Tribal':
    case 'Ornamental': {
      const cx = W / 2; const cy = H / 2;
      for (let i = 0; i < 12; i += 1) {
        const a = (Math.PI * 2 * i) / 12;
        const x2 = cx + 380 * Math.cos(a); const y2 = cy + 380 * Math.sin(a);
        const x1 = cx + 90 * Math.cos(a + 0.35); const y1 = cy + 90 * Math.sin(a + 0.35);
        g(`<path d="M${cx} ${cy} L ${x1} ${y1} L ${x2} ${y2} Z" fill="${i % 2 ? fg : accent}"/>`);
      }
      g(`<circle cx="${cx}" cy="${cy}" r="120" fill="${bg}" stroke="${fg}" stroke-width="14"/>`);
      g(`<circle cx="${cx}" cy="${cy}" r="60" fill="${fg}"/>`);
      break;
    }
    case 'Fine Line':
    case 'Minimalist': {
      g(`<rect width="${W}" height="${H}" fill="${fg}"/>`);
      const cx = W / 2;
      // A single-line botanical
      g(`<path d="M${cx} ${H - 120} C ${cx - 40} ${H - 300}, ${cx + 60} ${H - 420}, ${cx} ${H - 600} S ${cx - 40} ${H - 800}, ${cx + 10} 140" stroke="${bg}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`);
      for (let i = 0; i < 9; i += 1) {
        const y = H - 200 - i * 80;
        const dir = i % 2 ? 1 : -1;
        g(`<path d="M${cx} ${y} q ${dir * 60} -30 ${dir * 130} 10 q ${dir * -60} 40 ${dir * -130} -10 z" stroke="${bg}" stroke-width="2" fill="none"/>`);
        g(`<path d="M${cx} ${y} q ${dir * 60} -10 ${dir * 120} 5" stroke="${bg}" stroke-width="1" fill="none"/>`);
      }
      g(`<circle cx="${cx + 10}" cy="140" r="6" fill="${accent}"/>`);
      break;
    }
    case 'Realism': {
      const cx = W / 2; const cy = H / 2;
      g(`<defs><radialGradient id="rg${index}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="${fg}"/><stop offset="0.6" stop-color="${accent2}"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs>`);
      g(`<ellipse cx="${cx}" cy="${cy}" rx="260" ry="330" fill="url(#rg${index})"/>`);
      g(`<ellipse cx="${cx - 90}" cy="${cy - 60}" rx="46" ry="26" fill="${bg}" opacity="0.85"/>`);
      g(`<ellipse cx="${cx + 90}" cy="${cy - 60}" rx="46" ry="26" fill="${bg}" opacity="0.85"/>`);
      g(`<circle cx="${cx - 90}" cy="${cy - 60}" r="10" fill="${fg}"/>`);
      g(`<circle cx="${cx + 90}" cy="${cy - 60}" r="10" fill="${fg}"/>`);
      g(`<path d="M${cx - 60} ${cy + 120} q 60 50 120 0" stroke="${bg}" stroke-width="6" fill="none" stroke-linecap="round"/>`);
      break;
    }
    case 'Watercolor': {
      g(`<rect width="${W}" height="${H}" fill="${fg}"/>`);
      for (let i = 0; i < 7; i += 1) {
        const x = between(150, 650); const y = between(200, 800);
        g(`<ellipse cx="${x}" cy="${y}" rx="${between(80, 220)}" ry="${between(60, 180)}" fill="${i % 2 ? accent : accent2}" opacity="0.45" transform="rotate(${between(0, 180)} ${x} ${y})"/>`);
      }
      g(`<path d="M260 700 C 320 520, 420 500, 460 380 C 480 300, 540 280, 560 240" stroke="${bg}" stroke-width="4" fill="none" stroke-linecap="round"/>`);
      g(`<path d="M460 380 c 20 -60 90 -90 130 -70 c -10 60 -70 100 -130 70 z" fill="${bg}"/>`);
      break;
    }
    case 'Lettering': {
      g(`<text x="${W / 2}" y="${H / 2 - 40}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="150" fill="${fg}">Stay</text>`);
      g(`<text x="${W / 2}" y="${H / 2 + 120}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="150" fill="${accent}">gold</text>`);
      g(`<line x1="160" y1="${H / 2 + 170}" x2="${W - 160}" y2="${H / 2 + 170}" stroke="${fg}" stroke-width="3"/>`);
      break;
    }
    default: {
      // Illustrative fallback: stylised moon and mountains
      g(`<circle cx="560" cy="260" r="120" fill="${fg}"/>`);
      g(`<circle cx="600" cy="230" r="110" fill="${bg}"/>`);
      g(`<polygon points="0,${H} 240,520 400,760 520,600 800,${H}" fill="${accent2}"/>`);
      g(`<polygon points="0,${H} 240,520 330,660 200,${H}" fill="${accent}"/>`);
      for (let i = 0; i < 40; i += 1) {
        g(`<circle cx="${between(20, 780)}" cy="${between(20, 480)}" r="${(1 + rand() * 2).toFixed(1)}" fill="${fg}"/>`);
      }
    }
  }
  g(`<rect x="24" y="24" width="${W - 48}" height="${H - 48}" fill="none" stroke="${fg}" stroke-width="2" opacity="0.35"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

function makeAvatar(name, index) {
  const [bg, fg, accent] = PALETTES[index % PALETTES.length];
  const initials = name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect width="200" height="200" rx="100" fill="${index % 2 ? accent : bg}"/>
  <text x="100" y="118" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="72" font-weight="bold" fill="${fg}">${initials}</text>
</svg>`;
}

function writeSvg(name, svg) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), svg);
  return `/uploads/${name}`;
}

const ARTISTS = [
  {
    name: 'Mara Voss', deposit: 100, email: 'mara@inkwell.demo', location: 'Portland, OR', studio: 'Black Lantern Tattoo',
    styles: ['Blackwork', 'Dotwork', 'Ornamental'], rate: 180, min: 150, years: 11, session: 180,
    bio: 'Large-scale blackwork and ornamental pieces built to flow with the body. I love multi-session sleeves and back pieces, and I keep a few walk-in flash slots open every month.',
    galleries: [
      { title: 'Ornamental Sleeves', description: 'Multi-session blackwork sleeves, mostly healed photos.', styles: ['Ornamental', 'Blackwork', 'Dotwork'], n: 5 },
      { title: 'Dotwork Mandalas', description: 'Hand-poked and machine dotwork mandalas.', styles: ['Dotwork', 'Geometric'], n: 4 },
    ],
  },
  {
    name: 'Diego Santamaria', deposit: 50, email: 'diego@inkwell.demo', location: 'Austin, TX', studio: 'Lone Star Electric',
    styles: ['Traditional', 'Neo-Traditional'], rate: 150, min: 120, years: 9, session: 120,
    bio: 'Bold lines, solid color, tattoos that will still read from across the room in forty years. Flash always available, custom by appointment.',
    galleries: [
      { title: 'Traditional Flash', description: 'Classic American traditional from my flash sheets.', styles: ['Traditional'], n: 6 },
      { title: 'Neo-Trad Customs', description: 'Custom neo-traditional work, mostly animals and florals.', styles: ['Neo-Traditional', 'New School'], n: 3 },
    ],
  },
  {
    name: 'Yuki Hasegawa', deposit: 200, email: 'yuki@inkwell.demo', location: 'Los Angeles, CA', studio: 'Kuro Tide',
    styles: ['Japanese', 'Illustrative'], rate: 220, min: 300, years: 14, session: 240,
    bio: 'Traditional Japanese motifs: koi, dragons, waves, and peonies. I work mostly on large bodysuit-scale projects and take on a handful of new clients each season.',
    galleries: [
      { title: 'Irezumi', description: 'Full-body and half-sleeve Japanese work.', styles: ['Japanese'], n: 5 },
      { title: 'Illustrative Pieces', description: 'Smaller illustrative designs between the big projects.', styles: ['Illustrative', 'Japanese'], n: 3 },
    ],
  },
  {
    name: 'Priya Natarajan', deposit: 50, email: 'priya@inkwell.demo', location: 'Brooklyn, NY', studio: 'Thin Air Studio',
    styles: ['Fine Line', 'Minimalist', 'Lettering'], rate: 160, min: 100, years: 6, session: 90,
    bio: 'Delicate fine line botanicals, tiny script, and minimalist symbols. Single-needle specialist. Private studio, one client at a time.',
    galleries: [
      { title: 'Botanicals', description: 'Single-needle florals and foliage.', styles: ['Fine Line', 'Minimalist'], n: 6 },
      { title: 'Script & Lettering', description: 'Hand-drawn lettering and short quotes.', styles: ['Lettering'], n: 3 },
    ],
  },
  {
    name: 'Tomasz Kowal', deposit: 150, email: 'tomasz@inkwell.demo', location: 'Chicago, IL', studio: 'Northside Realism',
    styles: ['Realism', 'Blackwork'], rate: 200, min: 250, years: 12, session: 240,
    bio: 'Black and grey realism, portraits, and photorealistic animals. I book about three months out and require a consultation for every custom piece.',
    galleries: [
      { title: 'Portraits', description: 'Black and grey portrait work.', styles: ['Realism'], n: 4 },
      { title: 'Wildlife', description: 'Realistic animals, healed and fresh.', styles: ['Realism', 'Blackwork'], n: 4 },
    ],
  },
  {
    name: 'Sofia Reinholt', deposit: 60, email: 'sofia@inkwell.demo', location: 'Denver, CO', studio: 'Pigment & Co.',
    styles: ['Watercolor', 'Geometric', 'Illustrative'], rate: 140, min: 120, years: 5, session: 120,
    bio: 'Color-forward watercolor and geometric pieces. I like combining crisp linework with loose washes of color. Open to collaborations and guest spots.',
    galleries: [
      { title: 'Watercolor', description: 'Splashy color pieces, mostly florals and animals.', styles: ['Watercolor'], n: 5 },
      { title: 'Geometric Color', description: 'Geometric shapes with color accents.', styles: ['Geometric', 'Illustrative'], n: 3 },
    ],
  },
];

const CLIENTS = [
  { name: 'Jordan Lee', email: 'jordan@inkwell.demo', location: 'Portland, OR', bio: 'Collecting a full sleeve one artist at a time.' },
  { name: 'Amara Okafor', email: 'amara@inkwell.demo', location: 'Brooklyn, NY', bio: 'First tattoo soon. Nervous and excited.' },
  { name: 'Ben Carter', email: 'ben@inkwell.demo', location: 'Austin, TX', bio: 'Traditional fan. Bold will hold.' },
  { name: 'Lucía Fernández', email: 'lucia@inkwell.demo', location: 'Los Angeles, CA', bio: 'Working on a Japanese back piece.' },
];

const TITLES = {
  Blackwork: ['Solar Crown', 'Thorn Band', 'Obsidian Wings', 'Night Bloom', 'Ash Serpent'],
  Dotwork: ['Stippled Mandala', 'Dot Lotus', 'Gradient Sphere', 'Fading Moon'],
  Ornamental: ['Lace Sternum', 'Filigree Cuff', 'Baroque Shoulder', 'Chandelier Back'],
  Geometric: ['Hexagon Field', 'Sacred Grid', 'Fractal Forearm', 'Tessellated Calf'],
  Traditional: ['Rose & Dagger', 'Swallow Pair', 'Panther Head', 'Anchor Heart', 'Ship in Storm', 'Lady Head'],
  'Neo-Traditional': ['Fox & Foxglove', 'Owl Keeper', 'Peony Skull'],
  'New School': ['Candy Koi', 'Rocket Cat'],
  Japanese: ['Koi Ascending', 'Dragon Half Sleeve', 'Peony Waves', 'Hannya Mask', 'Tiger & Bamboo'],
  Illustrative: ['Moth Lantern', 'Fox Tale', 'Paper Boat'],
  'Fine Line': ['Single-Needle Fern', 'Wildflower Stem', 'Olive Branch', 'Lavender Sprig', 'Tiny Orchid', 'Eucalyptus'],
  Minimalist: ['Crescent Line', 'Wave Dash', 'Mountain Trio'],
  Lettering: ['"stay gold"', 'Mother\'s Handwriting', 'Latin Motto'],
  Realism: ['Grandfather Portrait', 'Wolf Study', 'Eye Detail', 'Lion in Shadow', 'Owl in Flight'],
  Watercolor: ['Hummingbird Splash', 'Poppy Wash', 'Fox in Color', 'Whale Bloom', 'Loose Peony'],
};

const PLACEMENTS = ['Forearm', 'Upper arm', 'Back', 'Thigh', 'Calf', 'Sternum', 'Shoulder', 'Ribs', 'Ankle', 'Wrist', 'Chest', 'Hand'];

const COMMENTS = [
  'The line weight on this is unreal.', 'Healed beautifully!', 'Saving this for reference, incredible work.',
  'How many sessions did this take?', 'That placement is perfect.', 'Absolutely stunning composition.',
  'Booking with you next time I am in town.', 'The shading here is so smooth.',
];

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0) {
    console.log('Database already has users; skipping seed. Delete data/inkwell.db to reseed.');
    return;
  }

  const passwordHash = hashPassword(DEMO_PASSWORD);
  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, name, role, avatar_url, bio, location, terms_accepted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?))
  `);
  const insertProfile = db.prepare(`
    INSERT INTO artist_profiles (user_id, studio_name, styles, hourly_rate, min_price, session_minutes, years_experience, instagram, website, accepting_clients, deposit_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  const insertGallery = db.prepare('INSERT INTO galleries (artist_id, title, description, created_at) VALUES (?, ?, ?, datetime(\'now\', ?))');
  const insertArtwork = db.prepare(`
    INSERT INTO artworks (gallery_id, artist_id, image_url, title, description, style, placement, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  const insertLike = db.prepare('INSERT OR IGNORE INTO likes (user_id, artwork_id) VALUES (?, ?)');
  const insertComment = db.prepare('INSERT INTO comments (artwork_id, user_id, body) VALUES (?, ?, ?)');
  const insertFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, artist_id) VALUES (?, ?)');
  const insertAvailability = db.prepare('INSERT INTO availability (artist_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
  const insertRequest = db.prepare(`
    INSERT INTO tattoo_requests (client_id, title, description, style, placement, size, budget_min, budget_max, location, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?))
  `);
  const insertProposal = db.prepare('INSERT INTO proposals (request_id, artist_id, message, quoted_price, estimated_hours, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insertAppointment = db.prepare('INSERT INTO appointments (artist_id, client_id, request_id, starts_at, ends_at, note, status, deposit_amount, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertPayment = db.prepare(`
    INSERT INTO payments (appointment_id, payer_id, payee_id, kind, amount, status, provider, provider_ref, card_last4, note, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'paid' THEN datetime('now', '-2 days') ELSE NULL END)
  `);
  const insertMessage = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, read_at, created_at) VALUES (?, ?, ?, ?, datetime(\'now\', ?))');

  const run = db.transaction(() => {
    const artistIds = [];
    const clientIds = [];
    const artworkIds = [];
    let imageIndex = 0;

    ARTISTS.forEach((a, i) => {
      const avatar = writeSvg(`seed-avatar-${i}.svg`, makeAvatar(a.name, i));
      const info = insertUser.run(a.email, passwordHash, a.name, 'artist', avatar, a.bio, a.location, `-${120 - i * 10} days`);
      const id = Number(info.lastInsertRowid);
      artistIds.push(id);
      insertProfile.run(id, a.studio, JSON.stringify(a.styles), a.rate, a.min, a.session, a.years, a.name.toLowerCase().replace(/\s+/g, '.'), '', a.deposit || 0);

      a.galleries.forEach((gal, gi) => {
        const ginfo = insertGallery.run(id, gal.title, gal.description, `-${100 - i * 8 - gi * 5} days`);
        const galleryId = Number(ginfo.lastInsertRowid);
        const used = new Set();
        for (let k = 0; k < gal.n; k += 1) {
          const style = gal.styles[k % gal.styles.length];
          const options = (TITLES[style] || TITLES.Illustrative).filter((t) => !used.has(t));
          const title = options.length ? pick(options) : `${style} study ${k + 1}`;
          used.add(title);
          const url = writeSvg(`seed-art-${imageIndex}.svg`, makeSvg(style, imageIndex));
          imageIndex += 1;
          const daysAgo = between(1, 90);
          const ainfo = insertArtwork.run(
            galleryId, id, url, title,
            `${style} piece on the ${pick(PLACEMENTS).toLowerCase()}. ${pick(['Healed photo.', 'Fresh, right after the session.', 'Two sessions, about five hours total.', 'Client brought the idea, I drew it up on the spot.', 'Part of a larger ongoing project.'])}`,
            style, pick(PLACEMENTS), `-${daysAgo} days`,
          );
          artworkIds.push(Number(ainfo.lastInsertRowid));
        }
      });

      // Weekly availability: Tue-Sat with varied hours.
      const days = [2, 3, 4, 5, 6];
      days.forEach((d) => {
        if (i % 3 === 0 && d === 6) return;
        insertAvailability.run(id, d, i % 2 ? '10:00' : '11:00', i % 2 ? '18:00' : '19:00');
      });
    });

    CLIENTS.forEach((c, i) => {
      const avatar = writeSvg(`seed-client-${i}.svg`, makeAvatar(c.name, i + 3));
      const info = insertUser.run(c.email, passwordHash, c.name, 'client', avatar, c.bio, c.location, `-${60 - i * 7} days`);
      clientIds.push(Number(info.lastInsertRowid));
    });

    // A moderator account for the admin panel.
    const adminAvatar = writeSvg('seed-admin.svg', makeAvatar('Ada Moderator', 4));
    const adminId = Number(insertUser.run('admin@inkwell.demo', passwordHash, 'Ada Moderator', 'client', adminAvatar, 'Keeps Inkwell tidy.', 'Remote', '-200 days').lastInsertRowid);
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(adminId);

    const everyone = [...artistIds, ...clientIds];
    artworkIds.forEach((artworkId) => {
      const likers = everyone.filter(() => rand() < 0.45);
      likers.forEach((uid) => insertLike.run(uid, artworkId));
      if (rand() < 0.5) insertComment.run(artworkId, pick(everyone), pick(COMMENTS));
      if (rand() < 0.2) insertComment.run(artworkId, pick(clientIds), pick(COMMENTS));
    });
    clientIds.forEach((cid) => artistIds.filter(() => rand() < 0.5).forEach((aid) => insertFollow.run(cid, aid)));
    artistIds.forEach((aid) => artistIds.filter((o) => o !== aid && rand() < 0.3).forEach((o) => insertFollow.run(aid, o)));

    const requests = [
      { client: 0, title: 'Blackwork forearm band with botanical detail', style: 'Blackwork', placement: 'Forearm', size: 'Medium (4-6 in)', min: 300, max: 600, location: 'Portland, OR', status: 'open', desc: 'Looking for a solid blackwork band around the forearm, roughly two inches wide, with some fern or leaf shapes breaking out of the top and bottom edges. Open to the artist\'s interpretation.' },
      { client: 1, title: 'Tiny fine line moon and stars on wrist', style: 'Fine Line', placement: 'Wrist', size: 'Tiny (under 2 in)', min: 100, max: 200, location: 'Brooklyn, NY', status: 'open', desc: 'My first tattoo! A small crescent moon with two or three tiny stars on the inside of my wrist. Very thin lines, nothing bold. Would love advice on placement.' },
      { client: 2, title: 'Traditional panther head on the outer thigh', style: 'Traditional', placement: 'Thigh', size: 'Large (6-10 in)', min: 500, max: 900, location: 'Austin, TX', status: 'in_progress', desc: 'Classic crawling panther head, bold outlines, solid black with red mouth and green eyes. Want it big enough to hold up over time.' },
      { client: 3, title: 'Koi and waves half sleeve, right arm', style: 'Japanese', placement: 'Upper arm', size: 'Extra large (sleeve/back)', min: 1500, max: 3000, location: 'Los Angeles, CA', status: 'open', desc: 'Two koi swimming upward through waves with maple leaves. Multi-session is fine. Traditional Japanese approach preferred, with a strong background.' },
      { client: 0, title: 'Geometric dotwork on the sternum', style: 'Dotwork', placement: 'Sternum', size: 'Medium (4-6 in)', min: 350, max: 700, location: 'Portland, OR', status: 'open', desc: 'Symmetrical dotwork piece that sits under the collarbones and points down the sternum. Something ornamental with a lot of dot gradients.' },
      { client: 1, title: 'Watercolor hummingbird on the shoulder blade', style: 'Watercolor', placement: 'Shoulder', size: 'Medium (4-6 in)', min: 300, max: 500, location: 'Brooklyn, NY', status: 'closed', desc: 'A hummingbird mid-flight with loose splashes of teal and purple behind it. Minimal outlines if possible.' },
    ];
    const requestIds = requests.map((r, i) => Number(insertRequest.run(
      clientIds[r.client], r.title, r.desc, r.style, r.placement, r.size, r.min, r.max, r.location, r.status, `-${20 - i * 3} days`,
    ).lastInsertRowid));

    // Proposals: artists whose styles match.
    insertProposal.run(requestIds[0], artistIds[0], 'I do a lot of forearm bands like this. I would draw the ferns so they wrap naturally around the muscle rather than sitting flat. Two hour session, healed photo included after.', 450, 2, 'pending');
    insertProposal.run(requestIds[1], artistIds[3], 'This is exactly my thing. Single needle, hairline stars. I would suggest placing it slightly off-center so it follows the tendon line. Fifteen minute consult first, then we tattoo the same day.', 150, 0.75, 'pending');
    insertProposal.run(requestIds[2], artistIds[1], 'Panther heads are my bread and butter. Drawn from my own flash, sized to your thigh. One sitting, about three hours.', 700, 3, 'accepted');
    insertProposal.run(requestIds[3], artistIds[2], 'Happy to take this on. I would plan three sessions: outline, background, then color. Expect to start around six weeks out.', 2400, 12, 'pending');
    insertProposal.run(requestIds[3], artistIds[5], 'I could do a color-heavy illustrative take on koi and waves if you want something a little less traditional.', 1800, 9, 'pending');
    insertProposal.run(requestIds[4], artistIds[0], 'Sternum dotwork is a specialty of mine, see the Dotwork Mandalas gallery. One long session or two shorter ones.', 600, 4, 'pending');

    // Appointments in the near future.
    const future = (days, hhmm, minutes) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      const pad = (n) => String(n).padStart(2, '0');
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const [h, m] = hhmm.split(':').map(Number);
      const endTotal = h * 60 + m + minutes;
      return [`${date}T${hhmm}`, `${date}T${pad(Math.floor(endTotal / 60))}:${pad(endTotal % 60)}`];
    };
    let [s, e] = future(7, '11:00', 120);
    let appt = Number(insertAppointment.run(artistIds[1], clientIds[2], requestIds[2], s, e, 'Panther head, outer thigh.', 'confirmed', 50, null).lastInsertRowid);
    insertPayment.run(appt, clientIds[2], artistIds[1], 'deposit', 50, 'paid', 'demo', 'demo_ch_seed1', '4242', 'Booking deposit', 'paid');
    [s, e] = future(9, '10:00', 180);
    appt = Number(insertAppointment.run(artistIds[0], clientIds[0], null, s, e, 'Consult plus first session on the forearm band if we agree on the design.', 'pending', 100, null).lastInsertRowid);
    insertPayment.run(appt, clientIds[0], artistIds[0], 'deposit', 100, 'pending', null, null, null, 'Booking deposit', 'pending');
    [s, e] = future(-14, '10:00', 90);
    appt = Number(insertAppointment.run(artistIds[3], clientIds[1], null, s, e, 'Tiny wrist piece.', 'completed', 50, 150).lastInsertRowid);
    insertPayment.run(appt, clientIds[1], artistIds[3], 'deposit', 50, 'paid', 'demo', 'demo_ch_seed2', '4242', 'Booking deposit', 'paid');
    insertPayment.run(appt, clientIds[1], artistIds[3], 'balance', 100, 'paid', 'demo', 'demo_ch_seed3', '4242', 'Session balance', 'paid');

    // Messages.
    const chat = [
      [clientIds[0], artistIds[0], 'Hi Mara! Saw your sternum mandalas. Would you be up for something similar but on the forearm?', '-5 days', true],
      [artistIds[0], clientIds[0], 'Hey Jordan, absolutely. Send over any references and I will sketch some options before our consult.', '-5 days', true],
      [clientIds[0], artistIds[0], 'Perfect, I just posted a request with the details. Booked a slot for next week too.', '-4 days', true],
      [artistIds[0], clientIds[0], 'Saw it, looks great. I will confirm the booking once I have looked at my schedule.', '-4 days', false],
      [clientIds[1], artistIds[3], 'Hello! I am very new to this. Does a wrist tattoo hurt a lot?', '-3 days', true],
      [artistIds[3], clientIds[1], 'It is one of the more sensitive spots, but for something tiny it is over in minutes. I will walk you through everything.', '-3 days', false],
      [clientIds[2], artistIds[1], 'Stoked for the panther. Should I shave the area beforehand?', '-2 days', true],
      [artistIds[1], clientIds[2], 'No need, I will handle that. Just eat a proper meal and bring water.', '-1 days', false],
    ];
    const readStamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    chat.forEach(([from, to, body, when, read]) => insertMessage.run(from, to, body, read ? readStamp : null, when));
  });

  run();
  console.log(`Seeded ${ARTISTS.length} artists, ${CLIENTS.length} clients and an admin (admin@inkwell.demo). Every demo account uses the password "${DEMO_PASSWORD}".`);
}

if (require.main === module) seed();

module.exports = { seed, DEMO_PASSWORD, ARTISTS, CLIENTS };
