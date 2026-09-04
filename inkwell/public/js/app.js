/* Inkwell single-page app: hash router + views. Depends on window.api. */
(function () {
  'use strict';

  const state = { user: null, styles: [], unread: 0, ready: false, pay: { provider: 'demo', mode: 'inline', test_cards: [], refund_window_hours: 48 } };
  const main = document.getElementById('main');
  const navEl = document.getElementById('nav');
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-root');
  let cleanupFns = [];

  /* ---------- helpers ---------- */

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = esc;
  const $ = (sel, root = main) => root.querySelector(sel);
  const $$ = (sel, root = main) => Array.from(root.querySelectorAll(sel));

  function toast(message, kind = 'ok') {
    const el = document.createElement('div');
    el.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
    el.textContent = message;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function money(n) {
    if (n === null || n === undefined) return '';
    return `$${Number(n).toLocaleString()}`;
  }

  function parseDb(ts) {
    // SQLite datetime('now') is UTC: "YYYY-MM-DD HH:MM:SS".
    if (!ts) return null;
    if (ts.includes('T') && !ts.endsWith('Z') && ts.length <= 16) return new Date(ts); // local appointment stamp
    return new Date(`${ts.replace(' ', 'T')}Z`);
  }

  function timeAgo(ts) {
    const d = parseDb(ts);
    if (!d) return '';
    const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtSlot(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SIZES = ['Tiny (under 2 in)', 'Small (2-4 in)', 'Medium (4-6 in)', 'Large (6-10 in)', 'Extra large (sleeve/back)'];

  function avatar(url, name, cls = '') {
    const src = url || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="50" fill="#2a2a31"/><text x="50" y="62" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#f1ece3">${(name || '?')[0].toUpperCase()}</text></svg>`)}`;
    return `<img class="avatar ${cls}" src="${attr(src)}" alt="${attr(name || '')}">`;
  }

  function pill(status) {
    return `<span class="pill pill--${attr(status)}">${esc(String(status).replace('_', ' '))}</span>`;
  }

  function styleOptions(selected = '', includeAny = true) {
    return `${includeAny ? '<option value="">Any style</option>' : ''}${state.styles.map((s) => `<option value="${attr(s)}" ${s === selected ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
  }

  function formData(form) {
    const out = {};
    new FormData(form).forEach((v, k) => { out[k] = v; });
    return out;
  }

  function onCleanup(fn) { cleanupFns.push(fn); }

  function navigate(path, { replace = false } = {}) {
    if (path === location.pathname + location.search) { route(); return; }
    history[replace ? 'replaceState' : 'pushState']({}, '', path);
    route();
  }

  function renderBanner() {
    const el = document.getElementById('banner');
    if (state.user && state.user.suspended) {
      el.innerHTML = `<div class="banner banner--danger"><strong>Your account is suspended.</strong> ${esc(state.user.suspended_reason || '')} You can browse, but you cannot post, book or message. Contact support if you think this is a mistake.</div>`;
    } else if (state.user && state.user.is_admin && location.pathname.startsWith('/admin')) {
      el.innerHTML = '';
    } else {
      el.innerHTML = '';
    }
  }

  function requireLogin(next) {
    if (state.user) return true;
    navigate(`/login?next=${encodeURIComponent(next || location.pathname + location.search)}`);
    return false;
  }

  function handleError(err, box) {
    const msg = err && err.message ? err.message : 'Something went wrong.';
    if (box) { box.textContent = msg; box.hidden = false; } else toast(msg, 'error');
  }

  /* ---------- modal ---------- */

  function openModal(html, { small = false } = {}) {
    closeModal();
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close><div class="modal${small ? ' modal--sm' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.style.overflow = 'hidden';
    const backdrop = modalRoot.firstElementChild;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close-modal]')) closeModal(); });
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    backdrop._onKey = onKey;
    return backdrop.querySelector('.modal');
  }

  function closeModal() {
    const backdrop = modalRoot.firstElementChild;
    if (backdrop && backdrop._onKey) document.removeEventListener('keydown', backdrop._onKey);
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
  }

  /* ---------- artwork card + lightbox ---------- */

  function artCard(a) {
    return `
      <article class="art" data-artwork="${a.id}">
        <img src="${attr(a.thumb_url || a.image_url)}" alt="${attr(a.title)}" loading="lazy" ${a.width && a.height ? `width="${a.width}" height="${a.height}"` : ''}>
        <div class="art__body">
          <div class="art__title"><span>${esc(a.title)}</span><span class="art__likes${a.liked ? ' liked' : ''}">♥ ${a.like_count}</span></div>
          <div class="art__meta">${avatar(a.artist_avatar_url, a.artist_name, 'avatar--xs')}<span>${esc(a.artist_name)}</span>${a.style ? `<span class="tag">${esc(a.style)}</span>` : ''}</div>
        </div>
      </article>`;
  }

  async function openArtwork(id) {
    let artwork;
    try { ({ artwork } = await api.get(`/api/artworks/${id}`)); } catch (e) { return handleError(e); }
    const me = state.user;
    const render = () => {
      const canEdit = me && me.id === artwork.artist_id;
      const modal = openModal(`
        <div class="modal__image"><img src="${attr(artwork.image_url)}" alt="${attr(artwork.title)}"></div>
        <div class="modal__panel">
          <div class="modal__head">
            <div>
              <h3 style="margin:0">${esc(artwork.title)}</h3>
              <a href="/artists/${artwork.artist_id}" class="row muted small" style="margin-top:6px" data-close-modal>${avatar(artwork.artist_avatar_url, artwork.artist_name, 'avatar--xs')} ${esc(artwork.artist_name)} · ${esc(artwork.gallery_title)}</a>
            </div>
            <button class="modal__close" data-close-modal aria-label="Close">×</button>
          </div>
          <div class="modal__body">
            <div class="chips" style="margin-bottom:12px">
              ${artwork.style ? `<span class="tag">${esc(artwork.style)}</span>` : ''}
              ${artwork.placement ? `<span class="tag">${esc(artwork.placement)}</span>` : ''}
              <span class="tag">${timeAgo(artwork.created_at)}</span>
            </div>
            ${artwork.description ? `<p class="muted">${esc(artwork.description)}</p>` : ''}
            <div class="row" style="margin-bottom:16px">
              <button class="like-btn${artwork.liked ? ' liked' : ''}" data-like>♥ <span>${artwork.like_count}</span></button>
              ${me && me.id !== artwork.artist_id ? `<a class="btn btn--ghost btn--sm" href="/messages/${artwork.artist_id}" data-close-modal>Message artist</a>` : ''}
              ${me && me.role === 'client' ? `<a class="btn btn--sm" href="/book/${artwork.artist_id}" data-close-modal>Book ${esc(artwork.artist_name.split(' ')[0])}</a>` : ''}
              ${canEdit ? '<button class="btn btn--danger btn--sm" data-delete-art>Delete</button>' : ''}
              ${me && !canEdit ? '<button class="link small" data-report-art>Report</button>' : ''}
            </div>
            <h4 style="margin-bottom:4px">Comments (${artwork.comments.length})</h4>
            <div data-comments>
              ${artwork.comments.length ? artwork.comments.map((c) => `
                <div class="comment">
                  ${avatar(c.user_avatar_url, c.user_name, 'avatar--sm')}
                  <div class="comment__body">
                    <div class="comment__meta"><strong style="color:var(--text)">${esc(c.user_name)}</strong><span>${timeAgo(c.created_at)}</span>
                      ${me && (me.id === c.user_id || canEdit) ? `<button class="link" data-del-comment="${c.id}">delete</button>` : ''}
                      ${me && me.id !== c.user_id ? `<button class="link" data-report-comment="${c.id}">report</button>` : ''}</div>
                    <div>${esc(c.body)}</div>
                  </div>
                </div>`).join('') : '<p class="faint small">No comments yet.</p>'}
            </div>
            ${me ? `<form class="row" data-comment-form style="margin-top:10px"><input name="body" placeholder="Add a comment" required style="flex:1;padding:10px 14px;border-radius:999px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text)"><button class="btn btn--sm">Post</button></form>`
              : '<p class="faint small" style="margin-top:10px"><a class="link" href="/login" data-close-modal>Sign in</a> to like or comment.</p>'}
          </div>
        </div>`);

      $('[data-like]', modal).addEventListener('click', async () => {
        if (!requireLogin()) { closeModal(); return; }
        try {
          const r = await api.post(`/api/artworks/${artwork.id}/like`);
          artwork.liked = r.liked; artwork.like_count = r.like_count;
          const btn = $('[data-like]', modal);
          btn.classList.toggle('liked', r.liked);
          btn.querySelector('span').textContent = r.like_count;
          const card = $(`.art[data-artwork="${artwork.id}"] .art__likes`);
          if (card) { card.textContent = `♥ ${r.like_count}`; card.classList.toggle('liked', r.liked); }
        } catch (e) { handleError(e); }
      });
      const form = $('[data-comment-form]', modal);
      if (form) form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api.post(`/api/artworks/${artwork.id}/comments`, { body: form.body.value });
          artwork.comments = r.comments; render();
        } catch (err) { handleError(err); }
      });
      $$('[data-del-comment]', modal).forEach((b) => b.addEventListener('click', async () => {
        try { const r = await api.del(`/api/comments/${b.dataset.delComment}`); artwork.comments = r.comments; render(); } catch (err) { handleError(err); }
      }));
      const rep = $('[data-report-art]', modal);
      if (rep) rep.addEventListener('click', () => reportModal('artwork', artwork.id, 'artwork'));
      $$('[data-report-comment]', modal).forEach((b) => b.addEventListener('click', () => reportModal('comment', Number(b.dataset.reportComment), 'comment')));
      const del = $('[data-delete-art]', modal);
      if (del) del.addEventListener('click', async () => {
        if (!confirm('Delete this artwork? This cannot be undone.')) return;
        try { await api.del(`/api/artworks/${artwork.id}`); closeModal(); toast('Artwork deleted'); route(); } catch (err) { handleError(err); }
      });
    };
    render();
  }

  main.addEventListener('click', (e) => {
    const card = e.target.closest('.art[data-artwork]');
    if (card) openArtwork(card.dataset.artwork);
  });

  /* ---------- nav ---------- */

  function renderNav() {
    const path = location.pathname || '/';
    const active = (p) => (path === p || (p !== '/' && path.startsWith(p)) ? 'active' : '');
    const u = state.user;
    navEl.innerHTML = `
      <a href="/" class="${active('/')}">Explore</a>
      <a href="/artists" class="${active('/artists')}">Artists</a>
      <a href="/requests" class="${active('/requests')}">Client requests</a>
      ${u ? `
        <a href="/messages" class="${active('/messages')}">Messages${state.unread ? `<span class="badge-dot">${state.unread}</span>` : ''}</a>
        <a href="/appointments" class="${active('/appointments')}">Bookings</a>
        <a href="/dashboard" class="${active('/dashboard')}">Dashboard</a>
        ${u.is_admin ? `<a href="/admin" class="${active('/admin')}">Admin</a>` : ''}
        <a href="/settings" class="${active('/settings')}" title="Settings">${avatar(u.avatar_url, u.name, 'nav-avatar')} <span>${esc(u.name.split(' ')[0])}</span></a>
        <button data-logout>Log out</button>
      ` : `
        <a href="/login" class="${active('/login')}">Log in</a>
        <a href="/register" class="btn btn--sm">Join Inkwell</a>
      `}`;
    const logout = navEl.querySelector('[data-logout]');
    if (logout) logout.addEventListener('click', async () => {
      await api.post('/api/auth/logout');
      state.user = null; state.unread = 0;
      toast('Signed out');
      navigate('/');
      renderNav();
    });
    navEl.classList.remove('open');
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
  }

  document.getElementById('nav-toggle').addEventListener('click', (e) => {
    const open = navEl.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  async function refreshUnread() {
    if (!state.user) return;
    try {
      const { unread } = await api.get('/api/messages/unread');
      if (unread !== state.unread) { state.unread = unread; renderNav(); }
    } catch { /* ignore */ }
  }

  /* ---------- views ---------- */

  function loading() { main.innerHTML = '<div class="loading">Loading</div>'; }

  const REPORT_REASONS = [['spam', 'Spam or advertising'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate or discrimination'], ['nudity', 'Sexual content'], ['copyright', 'Stolen or copied work'], ['scam', 'Scam or fraud'], ['other', 'Something else']];

  function reportModal(targetType, targetId, label) {
    if (!requireLogin()) return;
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><h3 style="margin:0">Report ${esc(label || targetType)}</h3><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Reason</label><select name="reason" required>${REPORT_REASONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field"><label>Details (optional)</label><textarea name="details" placeholder="Anything that helps a moderator understand the problem."></textarea></div>
          <button class="btn btn--block">Send report</button>
          <p class="faint small" style="margin:0">Reports are reviewed by moderators. The person you report is not told who reported them.</p>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post('/api/reports', { target_type: targetType, target_id: targetId, ...formData(form) }); closeModal(); toast('Thanks, a moderator will take a look'); } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  function stars(rating, { size = '' } = {}) {
    const r = Number(rating) || 0;
    return `<span class="stars ${size}" aria-label="${r} out of 5">${[1, 2, 3, 4, 5].map((i) => `<span class="${i <= Math.round(r) ? 'on' : ''}">★</span>`).join('')}</span>`;
  }

  function ratingLine(a) {
    if (!a.review_count) return '<span class="faint small">No reviews yet</span>';
    return `<span class="row" style="gap:6px">${stars(a.rating)}<span class="small muted">${a.rating} · ${a.review_count} review${a.review_count === 1 ? '' : 's'}</span></span>`;
  }

  function reviewModal(apptId, reload) {
    let rating = 5;
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><h3 style="margin:0">How was your session?</h3><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          <div class="field"><span class="label">Rating</span><div class="star-picker" data-picker>${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" class="on">★</button>`).join('')}</div></div>
          <div class="field"><label>Tell others about it (optional)</label><textarea name="body" placeholder="How did the artist handle the design, the session, the healing advice?"></textarea></div>
          <button class="btn btn--block">Post review</button>
        </form>
      </div>`, { small: true });
    $$('[data-star]', modal).forEach((b) => b.addEventListener('click', () => {
      rating = Number(b.dataset.star);
      $$('[data-star]', modal).forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= rating));
    }));
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post(`/api/appointments/${apptId}/review`, { rating, body: form.body.value }); closeModal(); toast('Review posted'); reload(); } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  async function viewHome() {
    loading();
    let feed;
    let artists;
    try {
      [feed, artists] = await Promise.all([api.get('/api/feed', { limit: 24 }), api.get('/api/artists')]);
    } catch (e) { return handleError(e); }
    const filters = { style: '', sort: 'recent', q: '', offset: 0 };
    const mosaic = feed.artworks.slice(0, 6);
    const totalArt = artists.artists.reduce((n, a) => n + a.artwork_count, 0);

    main.innerHTML = `
      <section class="hero">
        <div>
          <h1>Where ink finds <em>its people.</em></h1>
          <p>Inkwell is a home for tattoo artists to show healed work, meet the right clients, and fill their books without the back-and-forth.</p>
          <div class="hero__actions">
            <a class="btn btn--lg" href="${state.user ? (state.user.role === 'artist' ? '/dashboard' : '/artists') : '/register'}">${state.user ? (state.user.role === 'artist' ? 'Manage your studio' : 'Find an artist') : 'Join as an artist'}</a>
            <a class="btn btn--ghost btn--lg" href="/requests">${state.user && state.user.role === 'artist' ? 'Browse client requests' : 'Post what you want'}</a>
          </div>
          <div class="stats-row">
            <div class="stat"><strong>${artists.artists.length}</strong><span>artists</span></div>
            <div class="stat"><strong>${totalArt}</strong><span>pieces shared</span></div>
            <div class="stat"><strong>${state.styles.length}</strong><span>styles</span></div>
          </div>
        </div>
        <div class="hero__mosaic" aria-hidden="true">${mosaic.map((a) => `<img src="${attr(a.thumb_url || a.image_url)}" alt="">`).join('')}</div>
      </section>
      <section class="section" style="margin-top:10px">
        <div class="section__head">
          <h2>Fresh work</h2>
          <div class="row">
            <input data-q placeholder="Search pieces or artists" style="padding:8px 14px;border-radius:999px;border:1px solid var(--line-strong);background:var(--bg-elev);color:var(--text)">
            <div class="chips">
              <button class="chip active" data-sort="recent">Recent</button>
              <button class="chip" data-sort="popular">Most loved</button>
            </div>
          </div>
        </div>
        <div class="chips" style="margin-bottom:18px" data-styles>
          <button class="chip active" data-style="">All styles</button>
          ${state.styles.map((s) => `<button class="chip" data-style="${attr(s)}">${esc(s)}</button>`).join('')}
        </div>
        <div class="masonry" data-feed></div>
        <div class="row" style="justify-content:center;margin-top:10px"><button class="btn btn--ghost" data-more hidden>Load more</button></div>
      </section>`;

    const feedEl = $('[data-feed]');
    const moreBtn = $('[data-more]');
    async function load(append = false) {
      if (!append) { filters.offset = 0; feedEl.innerHTML = '<div class="loading">Loading</div>'; }
      try {
        const r = await api.get('/api/feed', { style: filters.style, sort: filters.sort, q: filters.q, offset: filters.offset, limit: 24 });
        const html = r.artworks.map(artCard).join('');
        if (append) feedEl.insertAdjacentHTML('beforeend', html);
        else feedEl.innerHTML = html || '<div class="empty"><h3>Nothing here yet</h3><p>Try a different style or search.</p></div>';
        filters.offset += r.artworks.length;
        moreBtn.hidden = !r.has_more;
      } catch (e) { handleError(e); }
    }
    $$('[data-style]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-style]').forEach((x) => x.classList.toggle('active', x === b));
      filters.style = b.dataset.style; load();
    }));
    $$('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-sort]').forEach((x) => x.classList.toggle('active', x === b));
      filters.sort = b.dataset.sort; load();
    }));
    let t;
    $('[data-q]').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filters.q = e.target.value.trim(); load(); }, 300); });
    moreBtn.addEventListener('click', () => load(true));
    load();
  }

  function artistCard(a) {
    return `
      <a class="artist-card" href="/artists/${a.id}">
        ${a.cover_url ? `<img class="artist-card__cover" src="${attr(a.cover_url)}" alt="">` : '<div class="artist-card__cover"></div>'}
        <div class="artist-card__body">
          <div class="artist-card__head">${avatar(a.avatar_url, a.name)}</div>
          <div class="artist-card__name" style="margin-top:0">${esc(a.name)}</div>
          <div class="muted small">${esc(a.studio_name || 'Independent')}${a.location ? ` · ${esc(a.location)}` : ''}</div>
          <div class="chips">${a.styles.slice(0, 3).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
          ${ratingLine(a)}
          <div class="artist-card__stats">
            <span>${a.artwork_count} pieces</span><span>${a.follower_count} followers</span>
            ${a.hourly_rate ? `<span>${money(a.hourly_rate)}/hr</span>` : ''}
            ${a.accepting_clients ? '<span style="color:var(--green)">● Booking</span>' : '<span>● Books closed</span>'}
          </div>
        </div>
      </a>`;
  }

  async function viewArtists(params) {
    loading();
    const filters = { q: params.get('q') || '', style: params.get('style') || '', location: params.get('location') || '', accepting: params.get('accepting') || '' };
    main.innerHTML = `
      <div class="page-head"><div><h1>Artists</h1><p class="muted">Find someone whose work speaks your language.</p></div></div>
      <form class="filters" data-filters>
        <input name="q" placeholder="Search name, studio, or style" value="${attr(filters.q)}">
        <select name="style">${styleOptions(filters.style)}</select>
        <input name="location" placeholder="City" value="${attr(filters.location)}">
        <label class="check"><input type="checkbox" name="accepting" value="1" ${filters.accepting ? 'checked' : ''}> Taking bookings</label>
        <button class="btn btn--subtle btn--sm">Filter</button>
      </form>
      <div class="grid grid--3" data-list><div class="loading">Loading</div></div>`;
    async function load() {
      try {
        const r = await api.get('/api/artists', filters);
        $('[data-list]').innerHTML = r.artists.length ? r.artists.map(artistCard).join('') : '<div class="empty"><h3>No artists match</h3><p>Loosen the filters a little.</p></div>';
      } catch (e) { handleError(e); }
    }
    $('[data-filters]').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(filters, formData(e.target), { accepting: e.target.accepting.checked ? '1' : '' });
      load();
    });
    load();
  }

  async function viewArtist(id) {
    loading();
    let artist;
    let work;
    let reviews;
    try {
      [{ artist }, work, reviews] = await Promise.all([api.get(`/api/artists/${id}`), api.get('/api/feed', { artist_id: id, limit: 12 }), api.get(`/api/artists/${id}/reviews`)]);
    } catch (e) { main.innerHTML = '<div class="empty"><h3>Artist not found</h3></div>'; return; }
    const me = state.user;
    const isMe = me && me.id === artist.id;
    main.innerHTML = `
      <div class="profile-head">
        ${avatar(artist.avatar_url, artist.name, 'avatar--lg')}
        <div class="profile-head__info">
          <h1>${esc(artist.name)}</h1>
          <div class="muted">${esc(artist.studio_name || 'Independent artist')}${artist.location ? ` · ${esc(artist.location)}` : ''}</div>
          <div style="margin-top:6px">${ratingLine(artist)}</div>
          <div class="chips" style="margin-top:10px">${artist.styles.map((s) => `<a class="chip" href="/artists?style=${encodeURIComponent(s)}">${esc(s)}</a>`).join('')}</div>
          <div class="profile-meta">
            <span><strong>${artist.artwork_count}</strong> pieces</span>
            <span><strong data-followers>${artist.follower_count}</strong> followers</span>
            <span><strong>${artist.like_count}</strong> likes</span>
            ${artist.years_experience ? `<span><strong>${artist.years_experience}</strong> years</span>` : ''}
            ${artist.hourly_rate ? `<span><strong>${money(artist.hourly_rate)}</strong>/hour</span>` : ''}
            ${artist.min_price ? `<span><strong>${money(artist.min_price)}</strong> minimum</span>` : ''}
            <span>${artist.accepting_clients ? '<span style="color:var(--green)">● Taking new clients</span>' : '<span class="faint">● Books closed</span>'}</span>
          </div>
          ${artist.bio ? `<p style="max-width:70ch">${esc(artist.bio)}</p>` : ''}
          <div class="row small muted">
            ${artist.instagram ? `<span>@${esc(artist.instagram)}</span>` : ''}
            ${artist.website ? `<a class="link" href="${attr(artist.website.startsWith('http') ? artist.website : `https://${artist.website}`)}" target="_blank" rel="noopener">${esc(artist.website)}</a>` : ''}
          </div>
        </div>
        <div class="profile-head__actions">
          ${isMe ? '<a class="btn btn--ghost" href="/dashboard">Manage studio</a><a class="btn btn--subtle" href="/settings">Edit profile</a>' : `
            <button class="btn btn--ghost" data-follow>${artist.is_following ? 'Following' : 'Follow'}</button>
            <a class="btn btn--ghost" href="/messages/${artist.id}">Message</a>
            ${!me || me.role === 'client' ? `<a class="btn" href="/book/${artist.id}">Book a session</a>` : ''}
            ${me ? '<button class="link small" data-report-user>Report</button>' : ''}`}
        </div>
      </div>
      <section class="section">
        <div class="section__head"><h2>Galleries</h2>${isMe ? '<a class="link" href="/dashboard">Add a gallery</a>' : ''}</div>
        ${artist.galleries.length ? `<div class="grid grid--3">${artist.galleries.map((g) => `
          <a class="gallery-card" href="/galleries/${g.id}">
            ${g.cover_url ? `<img src="${attr(g.cover_url)}" alt="">` : '<div class="gallery-card--empty" style="height:100%">Empty gallery</div>'}
            <div class="gallery-card__label"><strong>${esc(g.title)}</strong><span>${g.artwork_count} pieces</span></div>
          </a>`).join('')}</div>` : '<div class="empty"><h3>No galleries yet</h3></div>'}
      </section>
      <section class="section">
        <div class="section__head"><h2>Recent work</h2></div>
        ${work.artworks.length ? `<div class="grid-art">${work.artworks.map(artCard).join('')}</div>` : '<div class="empty"><p>No pieces shared yet.</p></div>'}
      </section>
      <section class="section">
        <div class="section__head"><h2>Reviews</h2>${reviews.summary.review_count ? `<span class="row" style="gap:8px">${stars(reviews.summary.rating)}<strong>${reviews.summary.rating}</strong><span class="muted small">from ${reviews.summary.review_count} completed session${reviews.summary.review_count === 1 ? '' : 's'}</span></span>` : ''}</div>
        ${reviews.reviews.length ? `<div class="stack">${reviews.reviews.map((rv) => `
          <div class="card review" data-review="${rv.id}">
            <div class="row row--between">
              <div class="row">${avatar(rv.client_avatar_url, rv.client_name, 'avatar--sm')}<div><strong>${esc(rv.client_name)}</strong><div class="small muted">${stars(rv.rating)} · session on ${fmtSlot(rv.starts_at).split(',').slice(0, 2).join(',')}</div></div></div>
              <span class="faint small">${timeAgo(rv.created_at)}</span>
            </div>
            ${rv.body ? `<p style="margin:10px 0 0">${esc(rv.body)}</p>` : ''}
            ${rv.artist_reply ? `<div class="review__reply"><strong class="small">Reply from ${esc(artist.name.split(' ')[0])}</strong><p style="margin:4px 0 0">${esc(rv.artist_reply)}</p></div>` : ''}
            <div class="row small" style="margin-top:8px">
              ${isMe && !rv.artist_reply ? `<button class="link" data-reply="${rv.id}">Reply</button>` : ''}
              ${me && (me.id === rv.client_id || me.is_admin) ? `<button class="link" data-del-review="${rv.id}">Delete</button>` : ''}
              ${me && me.id !== rv.client_id && !isMe ? `<button class="link" data-report-review="${rv.id}">Report</button>` : ''}
            </div>
          </div>`).join('')}</div>` : '<div class="empty"><p>No reviews yet. Clients can review after a completed session.</p></div>'}
      </section>`;
    const reportUser = $('[data-report-user]');
    if (reportUser) reportUser.addEventListener('click', () => reportModal('user', artist.id, 'artist'));
    $$('[data-report-review]').forEach((b) => b.addEventListener('click', () => reportModal('review', Number(b.dataset.reportReview), 'review')));
    $$('[data-del-review]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this review?')) return;
      try { await api.del(`/api/reviews/${b.dataset.delReview}`); toast('Review deleted'); viewArtist(id); } catch (err) { handleError(err); }
    }));
    $$('[data-reply]').forEach((b) => b.addEventListener('click', () => {
      const card = b.closest('[data-review]');
      card.insertAdjacentHTML('beforeend', `<form class="row" data-reply-form style="margin-top:10px"><input name="body" placeholder="Thank them or add context" required style="flex:1;padding:9px 12px;border-radius:999px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text)"><button class="btn btn--sm">Post reply</button></form>`);
      b.remove();
      $('[data-reply-form]', card).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api.post(`/api/reviews/${card.dataset.review}/reply`, { body: e.target.body.value }); viewArtist(id); } catch (err) { handleError(err); }
      });
    }));
    const follow = $('[data-follow]');
    if (follow) follow.addEventListener('click', async () => {
      if (!requireLogin()) return;
      try {
        const r = artist.is_following ? await api.del(`/api/artists/${artist.id}/follow`) : await api.post(`/api/artists/${artist.id}/follow`);
        artist.is_following = r.following;
        follow.textContent = r.following ? 'Following' : 'Follow';
        $('[data-followers]').textContent = r.follower_count;
      } catch (e) { handleError(e); }
    });
  }

  async function viewGallery(id) {
    loading();
    let gallery;
    try { ({ gallery } = await api.get(`/api/galleries/${id}`)); } catch (e) { main.innerHTML = '<div class="empty"><h3>Gallery not found</h3></div>'; return; }
    const isOwner = state.user && state.user.id === gallery.artist_id;
    main.innerHTML = `
      <div class="page-head">
        <div>
          <a class="muted small" href="/artists/${gallery.artist_id}">← ${esc(gallery.artist_name)}</a>
          <h1>${esc(gallery.title)}</h1>
          ${gallery.description ? `<p class="muted">${esc(gallery.description)}</p>` : ''}
        </div>
        ${isOwner ? '<div class="row"><button class="btn" data-upload>Upload artwork</button><button class="btn btn--ghost" data-edit>Edit</button><button class="btn btn--danger" data-delete>Delete gallery</button></div>' : ''}
      </div>
      ${gallery.artworks.length ? `<div class="grid-art">${gallery.artworks.map(artCard).join('')}</div>` : `<div class="empty"><h3>This gallery is empty</h3>${isOwner ? '<p>Upload your first piece to get started.</p>' : ''}</div>`}`;

    if (!isOwner) return;
    $('[data-upload]').addEventListener('click', () => {
      const modal = openModal(`
        <div class="modal__panel">
          <div class="modal__head"><h3 style="margin:0">Upload artwork</h3><button class="modal__close" data-close-modal>×</button></div>
          <form class="form modal__body" data-form>
            <div class="error" hidden></div>
            <div class="field"><label>Image</label><input type="file" name="image" accept="image/*" required><span class="hint">JPEG, PNG, WebP or GIF up to 8 MB.</span></div>
            <div class="field"><label>Title</label><input name="title" placeholder="Koi ascending" required></div>
            <div class="form-row">
              <div class="field"><label>Style</label><select name="style">${styleOptions('', true)}</select></div>
              <div class="field"><label>Placement</label><input name="placement" placeholder="Forearm"></div>
            </div>
            <div class="field"><label>Description</label><textarea name="description" placeholder="Healed photo, two sessions..."></textarea></div>
            <button class="btn btn--block">Publish</button>
          </form>
        </div>`, { small: true });
      const form = $('[data-form]', modal);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button.btn'); btn.disabled = true;
        try {
          await api.post(`/api/galleries/${gallery.id}/artworks`, new FormData(form));
          closeModal(); toast('Artwork published'); viewGallery(id);
        } catch (err) { handleError(err, $('.error', form)); btn.disabled = false; }
      });
    });
    $('[data-edit]').addEventListener('click', () => {
      const modal = openModal(`
        <div class="modal__panel">
          <div class="modal__head"><h3 style="margin:0">Edit gallery</h3><button class="modal__close" data-close-modal>×</button></div>
          <form class="form modal__body" data-form>
            <div class="error" hidden></div>
            <div class="field"><label>Title</label><input name="title" value="${attr(gallery.title)}" required></div>
            <div class="field"><label>Description</label><textarea name="description">${esc(gallery.description)}</textarea></div>
            <button class="btn btn--block">Save</button>
          </form>
        </div>`, { small: true });
      const form = $('[data-form]', modal);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api.put(`/api/galleries/${gallery.id}`, formData(form)); closeModal(); toast('Gallery updated'); viewGallery(id); } catch (err) { handleError(err, $('.error', form)); }
      });
    });
    $('[data-delete]').addEventListener('click', async () => {
      if (!confirm(`Delete "${gallery.title}" and all ${gallery.artworks.length} pieces in it?`)) return;
      try { await api.del(`/api/galleries/${gallery.id}`); toast('Gallery deleted'); navigate('/dashboard'); } catch (err) { handleError(err); }
    });
  }

  /* ---------- requests ---------- */

  function requestCard(r) {
    const budget = r.budget_min || r.budget_max
      ? `${r.budget_min ? money(r.budget_min) : ''}${r.budget_min && r.budget_max ? ' – ' : ''}${r.budget_max ? money(r.budget_max) : ''}`
      : 'Open budget';
    return `
      <a class="card request-card" href="/requests/${r.id}">
        <div class="row row--between"><span class="request-card__title">${esc(r.title)}</span>${pill(r.status)}</div>
        <div class="request-card__meta">
          ${r.style ? `<span class="tag">${esc(r.style)}</span>` : ''}
          ${r.placement ? `<span class="tag">${esc(r.placement)}</span>` : ''}
          ${r.size ? `<span class="tag">${esc(r.size)}</span>` : ''}
        </div>
        <div class="request-card__desc">${esc(r.description)}</div>
        <div class="request-card__foot">
          <span class="row">${avatar(r.client_avatar_url, r.client_name, 'avatar--xs')} ${esc(r.client_name)}${r.location ? ` · ${esc(r.location)}` : ''}</span>
          <span class="row"><span class="budget">${budget}</span><span>· ${r.proposal_count} proposal${r.proposal_count === 1 ? '' : 's'}</span></span>
        </div>
      </a>`;
  }

  async function viewRequests(params) {
    loading();
    const me = state.user;
    const tab = params.get('tab') || 'open';
    const filters = { style: params.get('style') || '', location: params.get('location') || '' };
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Client requests</h1><p class="muted">${me && me.role === 'artist' ? 'People looking for an artist. Send a proposal to start the conversation.' : 'Describe the tattoo you want and let artists come to you.'}</p></div>
        ${!me || me.role === 'client' ? '<a class="btn" href="/requests/new">Post a request</a>' : ''}
      </div>
      ${me ? `<div class="tabs">
        <button class="${tab === 'open' ? 'active' : ''}" data-tab="open">Open requests</button>
        <button class="${tab === 'mine' ? 'active' : ''}" data-tab="mine">${me.role === 'client' ? 'My requests' : 'My proposals'}</button>
      </div>` : ''}
      <form class="filters" data-filters>
        <select name="style">${styleOptions(filters.style)}</select>
        <input name="location" placeholder="City" value="${attr(filters.location)}">
        <button class="btn btn--subtle btn--sm">Filter</button>
      </form>
      <div class="grid grid--2" data-list><div class="loading">Loading</div></div>`;
    let current = tab;
    async function load() {
      try {
        const r = await api.get('/api/requests', { ...filters, mine: current === 'mine' ? '1' : '' });
        $('[data-list]').innerHTML = r.requests.length ? r.requests.map(requestCard).join('')
          : `<div class="empty" style="grid-column:1/-1"><h3>${current === 'mine' ? 'Nothing here yet' : 'No open requests match'}</h3><p>${current === 'mine' && me.role === 'client' ? 'Post a request and artists will send proposals.' : 'Check back soon.'}</p></div>`;
      } catch (e) { handleError(e); }
    }
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      current = b.dataset.tab; load();
    }));
    $('[data-filters]').addEventListener('submit', (e) => { e.preventDefault(); Object.assign(filters, formData(e.target)); load(); });
    load();
  }

  function viewNewRequest() {
    if (!requireLogin('/requests/new')) return;
    if (state.user.role !== 'client') { main.innerHTML = '<div class="empty"><h3>Only clients can post requests</h3><p>Browse <a class="link" href="/requests">open requests</a> instead.</p></div>'; return; }
    main.innerHTML = `
      <div class="narrow">
        <h1>Post a request</h1>
        <p class="muted">Be specific about the idea, size and placement. Artists whose style fits will send you proposals with a quote.</p>
        <form class="form card" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Title</label><input name="title" placeholder="Fine line moon and stars on the wrist" required></div>
          <div class="field"><label>Describe the tattoo</label><textarea name="description" required placeholder="What is it, what does it mean to you, what references do you have, what should the artist know?"></textarea></div>
          <div class="form-row">
            <div class="field"><label>Style</label><select name="style">${styleOptions('', true)}</select></div>
            <div class="field"><label>Placement</label><input name="placement" placeholder="Wrist"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Size</label><select name="size"><option value="">Not sure</option>${SIZES.map((s) => `<option>${esc(s)}</option>`).join('')}</select></div>
            <div class="field"><label>Location</label><input name="location" value="${attr(state.user.location || '')}" placeholder="City"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>Budget from ($)</label><input name="budget_min" type="number" min="0" step="10"></div>
            <div class="field"><label>Budget up to ($)</label><input name="budget_max" type="number" min="0" step="10"></div>
          </div>
          <div class="field"><label>Reference image (optional)</label><input type="file" name="reference" accept="image/*"></div>
          <button class="btn btn--lg">Post request</button>
        </form>
      </div>`;
    const form = $('[data-form]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.querySelector('button').disabled = true;
      try {
        const r = await api.post('/api/requests', new FormData(form));
        toast('Request posted'); navigate(`/requests/${r.request.id}`);
      } catch (err) { handleError(err, $('.error', form)); form.querySelector('button').disabled = false; }
    });
  }

  async function viewRequest(id) {
    loading();
    let request;
    try { ({ request } = await api.get(`/api/requests/${id}`)); } catch (e) { main.innerHTML = '<div class="empty"><h3>Request not found</h3></div>'; return; }
    const me = state.user;
    const isOwner = request.is_owner;
    const isArtist = me && me.role === 'artist';
    const accepted = request.proposals.find((p) => p.status === 'accepted');
    const budget = request.budget_min || request.budget_max
      ? `${request.budget_min ? money(request.budget_min) : ''}${request.budget_min && request.budget_max ? ' – ' : ''}${request.budget_max ? money(request.budget_max) : ''}` : 'Open budget';

    const proposalHtml = (p) => `
      <div class="proposal">
        <div class="proposal__head">
          <a href="/artists/${p.artist_id}">${avatar(p.artist_avatar_url, p.artist_name, 'avatar--sm')}</a>
          <div style="flex:1"><a href="/artists/${p.artist_id}"><strong>${esc(p.artist_name)}</strong></a><div class="small muted">${esc(p.studio_name || '')}${p.artist_location ? ` · ${esc(p.artist_location)}` : ''} · ${timeAgo(p.created_at)}</div></div>
          ${pill(p.status)}
        </div>
        <p>${esc(p.message)}</p>
        <div class="row small muted">
          ${p.quoted_price ? `<span class="budget">${money(p.quoted_price)}</span>` : '<span>No quote given</span>'}
          ${p.estimated_hours ? `<span>· about ${p.estimated_hours} hour${p.estimated_hours === 1 ? '' : 's'}</span>` : ''}
        </div>
        ${isOwner ? `<div class="row" style="margin-top:12px">
          ${p.status === 'pending' ? `<button class="btn btn--sm" data-accept="${p.id}">Accept proposal</button><button class="btn btn--ghost btn--sm" data-decline="${p.id}">Decline</button>` : ''}
          ${p.status === 'accepted' ? `<a class="btn btn--sm" href="/book/${p.artist_id}?request=${request.id}">Book a session with ${esc(p.artist_name.split(' ')[0])}</a>` : ''}
          <a class="btn btn--ghost btn--sm" href="/messages/${p.artist_id}">Message</a>
        </div>` : ''}
      </div>`;

    main.innerHTML = `
      <div class="two-col">
        <div>
          <a class="muted small" href="/requests">← All requests</a>
          <div class="row row--between" style="margin-top:6px"><h1 style="margin:0">${esc(request.title)}</h1>${pill(request.status)}</div>
          <div class="chips" style="margin:12px 0">
            ${request.style ? `<span class="tag">${esc(request.style)}</span>` : ''}
            ${request.placement ? `<span class="tag">${esc(request.placement)}</span>` : ''}
            ${request.size ? `<span class="tag">${esc(request.size)}</span>` : ''}
            ${request.location ? `<span class="tag">${esc(request.location)}</span>` : ''}
            <span class="tag">Posted ${timeAgo(request.created_at)}</span>
          </div>
          <p style="white-space:pre-wrap">${esc(request.description)}</p>
          ${request.reference_image_url ? `<img src="${attr(request.reference_image_url)}" alt="Reference" style="max-width:360px;border-radius:12px;border:1px solid var(--line)">` : ''}
          <section class="section">
            <div class="section__head"><h2>Proposals ${isOwner ? `(${request.proposals.length})` : ''}</h2></div>
            ${isOwner ? (request.proposals.length ? request.proposals.map(proposalHtml).join('') : '<div class="empty"><h3>No proposals yet</h3><p>Artists are browsing. You can also message an artist directly.</p></div>') : ''}
            ${isArtist ? (request.my_proposal ? `<div class="card"><div class="row row--between"><strong>Your proposal</strong>${pill(request.my_proposal.status)}</div><p style="margin-top:8px">${esc(request.my_proposal.message)}</p><div class="row small muted">${request.my_proposal.quoted_price ? `<span class="budget">${money(request.my_proposal.quoted_price)}</span>` : ''}${request.my_proposal.estimated_hours ? `<span>· ${request.my_proposal.estimated_hours} hours</span>` : ''}</div>${request.my_proposal.status === 'accepted' ? '<p class="small" style="color:var(--green);margin-top:10px">The client accepted. They can now book a slot from your availability.</p>' : ''}</div>`
              : (request.status === 'open' ? `
                <form class="form card" data-proposal>
                  <h3>Send a proposal</h3>
                  <div class="error" hidden></div>
                  <div class="field"><label>How would you approach it?</label><textarea name="message" required placeholder="Talk about your take on the design, sessions needed, and anything the client should know."></textarea></div>
                  <div class="form-row">
                    <div class="field"><label>Quote ($)</label><input name="quoted_price" type="number" min="0" step="10"></div>
                    <div class="field"><label>Estimated hours</label><input name="estimated_hours" type="number" min="0.5" step="0.5"></div>
                  </div>
                  <button class="btn">Send proposal</button>
                </form>` : '<div class="empty"><p>This request is no longer accepting proposals.</p></div>')) : ''}
            ${!me ? '<div class="empty"><p><a class="link" href="/login">Sign in</a> as an artist to send a proposal.</p></div>' : ''}
            ${me && me.role === 'client' && !isOwner ? '<div class="empty"><p>Only the person who posted this can see proposals.</p></div>' : ''}
          </section>
        </div>
        <aside class="stack">
          <div class="card">
            <div class="row">${avatar(request.client_avatar_url, request.client_name)}<div><strong>${esc(request.client_name)}</strong><div class="small muted">Client${request.location ? ` · ${esc(request.location)}` : ''}</div></div></div>
            <hr class="divider" style="margin:14px 0">
            <div class="row row--between"><span class="muted">Budget</span><span class="budget">${budget}</span></div>
            <div class="row row--between" style="margin-top:6px"><span class="muted">Proposals</span><span>${request.proposal_count}</span></div>
            ${isArtist && !isOwner ? `<a class="btn btn--ghost btn--block" style="margin-top:14px" href="/messages/${request.client_id}">Message ${esc(request.client_name.split(' ')[0])}</a>` : ''}
            ${me && !isOwner ? '<div style="margin-top:10px;text-align:center"><button class="link small" data-report-request>Report this request</button></div>' : ''}
          </div>
          ${isOwner ? `<div class="card">
            <h3>Manage</h3>
            <div class="field"><label>Status</label><select data-status>
              <option value="open" ${request.status === 'open' ? 'selected' : ''}>Open for proposals</option>
              <option value="in_progress" ${request.status === 'in_progress' ? 'selected' : ''}>In progress</option>
              <option value="closed" ${request.status === 'closed' ? 'selected' : ''}>Closed</option>
            </select></div>
            ${accepted ? `<p class="small muted" style="margin-top:10px">Working with <strong>${esc(accepted.artist_name)}</strong>.</p>` : ''}
            <button class="btn btn--danger btn--sm" style="margin-top:12px" data-delete>Delete request</button>
          </div>` : ''}
        </aside>
      </div>`;

    const reportReq = $('[data-report-request]');
    if (reportReq) reportReq.addEventListener('click', () => reportModal('request', request.id, 'request'));
    const pf = $('[data-proposal]');
    if (pf) pf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.post(`/api/requests/${id}/proposals`, formData(pf)); toast('Proposal sent'); viewRequest(id); } catch (err) { handleError(err, $('.error', pf)); }
    });
    $$('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/api/requests/proposals/${b.dataset.accept}/accept`); toast('Proposal accepted'); viewRequest(id); } catch (err) { handleError(err); }
    }));
    $$('[data-decline]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/api/requests/proposals/${b.dataset.decline}/decline`); viewRequest(id); } catch (err) { handleError(err); }
    }));
    const status = $('[data-status]');
    if (status) status.addEventListener('change', async () => {
      try { await api.put(`/api/requests/${id}/status`, { status: status.value }); toast('Status updated'); viewRequest(id); } catch (err) { handleError(err); }
    });
    const del = $('[data-delete]');
    if (del) del.addEventListener('click', async () => {
      if (!confirm('Delete this request?')) return;
      try { await api.del(`/api/requests/${id}`); toast('Request deleted'); navigate('/requests?tab=mine'); } catch (err) { handleError(err); }
    });
  }

  /* ---------- booking ---------- */

  async function viewBook(artistId, params) {
    if (!requireLogin(`/book/${artistId}`)) return;
    if (state.user.role !== 'client') { main.innerHTML = '<div class="empty"><h3>Artists book through their dashboard</h3><p>Clients book sessions with you from your profile.</p></div>'; return; }
    loading();
    let artist;
    let avail;
    try {
      [{ artist }, avail] = await Promise.all([api.get(`/api/artists/${artistId}`), api.get(`/api/artists/${artistId}/availability`)]);
    } catch (e) { main.innerHTML = '<div class="empty"><h3>Artist not found</h3></div>'; return; }
    const openDays = new Set(avail.availability.map((w) => w.weekday));
    const requestId = params.get('request') || '';
    const days = [];
    for (let i = 0; i < 28; i += 1) {
      const d = new Date(); d.setDate(d.getDate() + i);
      days.push(d);
    }
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let selectedDate = days.find((d) => openDays.has(d.getDay()));
    let selectedSlot = null;
    let autoAdvancing = true;

    main.innerHTML = `
      <div class="two-col">
        <div>
          <a class="muted small" href="/artists/${artist.id}">← ${esc(artist.name)}</a>
          <h1>Book a session</h1>
          ${!artist.accepting_clients ? '<div class="error">This artist is not taking new bookings right now.</div>' : ''}
          ${!openDays.size ? '<div class="empty"><h3>No hours published yet</h3><p>Send the artist a message to arrange a time.</p></div>' : `
          <div class="card">
            <h3>Pick a day</h3>
            <div class="date-strip" data-days>
              ${days.map((d) => `<button type="button" data-date="${iso(d)}" ${openDays.has(d.getDay()) ? '' : 'disabled'} class="${selectedDate && iso(d) === iso(selectedDate) ? 'active' : ''}"><small>${d.toLocaleDateString(undefined, { weekday: 'short' })}</small><strong>${d.getDate()}</strong><small>${d.toLocaleDateString(undefined, { month: 'short' })}</small></button>`).join('')}
            </div>
            <h3 style="margin-top:20px">Available times <span class="muted small">(${avail.session_minutes} minute sessions)</span></h3>
            <div class="slots" data-slots><div class="loading">Loading</div></div>
          </div>
          <form class="card form" data-form style="margin-top:14px">
            <div class="error" hidden></div>
            <div class="field"><label>Tell ${esc(artist.name.split(' ')[0])} about the piece</label><textarea name="note" placeholder="What you want, size, placement, references..."></textarea></div>
            <div class="row row--between">
              <span class="muted" data-summary>Choose a time above.</span>
              <button class="btn btn--lg" disabled data-submit>Request booking</button>
            </div>
          </form>`}
        </div>
        <aside>
          <div class="card">
            <div class="row">${avatar(artist.avatar_url, artist.name)}<div><strong>${esc(artist.name)}</strong><div class="small muted">${esc(artist.studio_name || '')}${artist.location ? ` · ${esc(artist.location)}` : ''}</div></div></div>
            <hr class="divider" style="margin:14px 0">
            ${artist.hourly_rate ? `<div class="row row--between"><span class="muted">Hourly rate</span><strong>${money(artist.hourly_rate)}</strong></div>` : ''}
            ${artist.min_price ? `<div class="row row--between"><span class="muted">Minimum</span><strong>${money(artist.min_price)}</strong></div>` : ''}
            <div class="row row--between"><span class="muted">Session length</span><strong>${avail.session_minutes} min</strong></div>
            <div class="row row--between"><span class="muted">Deposit</span><strong>${avail.deposit_amount ? money(avail.deposit_amount) : 'None'}</strong></div>
            <hr class="divider" style="margin:14px 0">
            <div class="small muted">Studio hours</div>
            ${avail.availability.map((w) => `<div class="row row--between small"><span>${WEEKDAYS[w.weekday]}</span><span>${w.start_time} – ${w.end_time}</span></div>`).join('') || '<div class="small faint">Not published</div>'}
            <p class="small faint" style="margin-top:14px">${avail.deposit_amount
              ? `A ${money(avail.deposit_amount)} deposit holds your slot and is paid right after you book. It is refunded in full if the artist declines or if you cancel at least ${avail.refund_window_hours || state.pay.refund_window_hours} hours ahead. The remaining balance is settled after the session.`
              : 'This artist does not take a deposit. Payment is settled after the session.'}</p>
          </div>
        </aside>
      </div>`;

    if (!openDays.size) return;
    const slotsEl = $('[data-slots]');
    const summary = $('[data-summary]');
    const submit = $('[data-submit]');
    async function loadSlots(autoAdvance = false) {
      selectedSlot = null; submit.disabled = true; summary.textContent = 'Choose a time above.';
      slotsEl.innerHTML = '<div class="loading">Loading</div>';
      try {
        const r = await api.get(`/api/artists/${artist.id}/slots`, { date: iso(selectedDate) });
        if (autoAdvance && !r.slots.some((s) => s.available)) {
          // Skip past days that are already fully booked or over, so the first view shows something bookable.
          const buttons = $$('[data-date]');
          const idx = buttons.findIndex((b) => b.dataset.date === iso(selectedDate));
          const next = buttons.slice(idx + 1).find((b) => !b.disabled);
          if (next) { next.click(); return; }
        }
        slotsEl.innerHTML = r.slots.length ? r.slots.map((s) => `<button type="button" class="slot" data-slot="${attr(s.starts_at)}" ${s.available ? '' : 'disabled'}>${fmtTime(s.starts_at)}</button>`).join('') : '<p class="faint">No sessions on this day.</p>';
        autoAdvancing = false;
        $$('[data-slot]').forEach((b) => b.addEventListener('click', () => {
          $$('[data-slot]').forEach((x) => x.classList.toggle('active', x === b));
          selectedSlot = b.dataset.slot;
          summary.textContent = fmtSlot(selectedSlot);
          submit.disabled = !artist.accepting_clients;
        }));
      } catch (e) { handleError(e); }
    }
    $$('[data-date]').forEach((b) => b.addEventListener('click', (ev) => {
      if (ev.isTrusted) autoAdvancing = false;
      $$('[data-date]').forEach((x) => x.classList.toggle('active', x === b));
      const [y, m, d] = b.dataset.date.split('-').map(Number);
      selectedDate = new Date(y, m - 1, d);
      loadSlots(autoAdvancing);
    }));
    $('[data-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!selectedSlot) return;
      submit.disabled = true;
      try {
        await api.post('/api/appointments', { artist_id: artist.id, starts_at: selectedSlot, note: e.target.note.value, request_id: requestId || undefined });
        toast('Booking requested');
        navigate('/appointments');
      } catch (err) { handleError(err, $('.error', e.target)); submit.disabled = false; }
    });
    loadSlots(true);
  }

  function apptCard(a) {
    const me = state.user;
    const isArtist = me.id === a.artist_id;
    const other = isArtist ? { name: a.client_name, avatar: a.client_avatar_url, id: a.client_id, label: 'Client' } : { name: a.artist_name, avatar: a.artist_avatar_url, id: a.artist_id, label: a.studio_name || 'Artist' };
    const d = new Date(a.starts_at);
    const actions = [];
    if (isArtist && a.status === 'pending') actions.push(`<button class="btn btn--sm" data-act="confirm" data-id="${a.id}">Confirm</button>`, `<button class="btn btn--ghost btn--sm" data-act="decline" data-id="${a.id}">Decline</button>`);
    if (isArtist && a.status === 'confirmed') actions.push(`<button class="btn btn--sm" data-act="complete" data-id="${a.id}">Mark completed</button>`);
    if (['pending', 'confirmed'].includes(a.status)) actions.push(`<button class="btn btn--danger btn--sm" data-act="cancel" data-id="${a.id}">Cancel</button>`);
    if (!isArtist && a.status === 'completed' && !a.review_id) actions.push(`<button class="btn btn--sm btn--subtle" data-review-appt="${a.id}">Leave a review</button>`);
    if (!isArtist && a.review_id) actions.push(`<a class="btn btn--ghost btn--sm" href="/artists/${a.artist_id}">See your review</a>`);
    actions.push(`<a class="btn btn--ghost btn--sm" href="/messages/${other.id}">Message</a>`);
    if (!isArtist && ['pending', 'confirmed', 'completed'].includes(a.status)) {
      (a.payments || []).filter((p) => p.status === 'pending').forEach((p) => actions.unshift(
        `<button class="btn btn--sm" data-pay="${p.id}" data-amount="${p.amount}" data-kind="${p.kind}">Pay ${money(p.amount)} ${p.kind}</button>`,
      ));
    }
    return `
      <div class="card appt">
        <div class="appt__date"><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span><strong>${d.getDate()}</strong><span>${d.toLocaleDateString(undefined, { weekday: 'short' })}</span></div>
        <div>
          <div class="row"><strong>${fmtTime(a.starts_at)} – ${fmtTime(a.ends_at)}</strong>${pill(a.status)}</div>
          <div class="row" style="margin-top:6px">${avatar(other.avatar, other.name, 'avatar--xs')}<a href="/artists/${isArtist ? me.id : a.artist_id}"><strong>${esc(other.name)}</strong></a><span class="muted small">${esc(other.label)}</span></div>
          ${a.request_title ? `<div class="small muted" style="margin-top:4px">For request: <a class="link" href="/requests/${a.request_id}">${esc(a.request_title)}</a></div>` : ''}
          ${a.note ? `<p class="small muted" style="margin:6px 0 0">${esc(a.note)}</p>` : ''}
          ${paymentsLine(a)}
        </div>
        <div class="appt__actions">${actions.join('')}</div>
      </div>`;
  }

  function paymentsLine(a) {
    const bits = [];
    if (a.price) bits.push(`<span class="tag">Total ${money(a.price)}</span>`);
    (a.payments || []).forEach((p) => {
      const label = { pending: 'due', paid: 'paid', refunded: 'refunded', forfeited: 'kept', cancelled: 'void' }[p.status] || p.status;
      bits.push(`<span class="pill pill--${attr(p.status)}" title="${attr(p.note || '')}">${money(p.amount)} ${esc(p.kind)} ${label}${p.card_last4 ? ` ·· ${esc(p.card_last4)}` : ''}</span>`);
    });
    if (!bits.length && !a.deposit_amount) return '';
    return `<div class="chips" style="margin-top:8px">${bits.join('')}</div>`;
  }

  /** Wire appointment action buttons (confirm/decline/cancel/complete/pay) inside `root`. */
  function bindApptActions(root, reload) {
    $$('[data-act]', root).forEach((b) => b.addEventListener('click', async () => {
      const { act, id } = b.dataset;
      if (act === 'cancel' && !confirm('Cancel this appointment?')) return;
      if (act === 'complete') return completeModal(id, reload);
      try {
        await api.post(`/api/appointments/${id}/${act}`);
        toast({ confirm: 'Booking confirmed', decline: 'Booking declined', cancel: 'Booking cancelled' }[act] || 'Updated');
        reload();
      } catch (err) { handleError(err); }
    }));
    $$('[data-pay]', root).forEach((b) => b.addEventListener('click', () => payModal(b.dataset.pay, Number(b.dataset.amount), b.dataset.kind, reload)));
    $$('[data-review-appt]', root).forEach((b) => b.addEventListener('click', () => reviewModal(b.dataset.reviewAppt, reload)));
  }

  function completeModal(id, reload) {
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><h3 style="margin:0">Complete session</h3><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Session total ($)</label><input name="price" type="number" min="0" step="5" placeholder="Leave blank if nothing more is owed"><span class="hint">Any paid deposit is subtracted and the client is asked to pay the remaining balance.</span></div>
          <button class="btn btn--block">Mark completed</button>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.post(`/api/appointments/${id}/complete`, { price: form.price.value });
        closeModal(); toast('Session completed'); reload();
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  async function payModal(paymentId, amount, kind, reload) {
    if (state.pay.mode === 'redirect') {
      try {
        const { url } = await api.post(`/api/payments/${paymentId}/checkout`);
        window.location.href = url;
      } catch (err) { handleError(err); }
      return;
    }
    const year = new Date().getFullYear();
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Pay ${money(amount)} ${esc(kind)}</h3><div class="small muted">Card details are processed by the ${esc(state.pay.provider)} provider.</div></div><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form autocomplete="off">
          <div class="error" hidden></div>
          <div class="field"><label>Name on card</label><input name="name" value="${attr(state.user.name)}" required></div>
          <div class="field"><label>Card number</label><input name="number" inputmode="numeric" placeholder="4242 4242 4242 4242" required></div>
          <div class="form-row">
            <div class="field"><label>Expiry</label><div class="row" style="gap:6px"><input name="exp_month" placeholder="MM" inputmode="numeric" maxlength="2" required style="width:70px"><input name="exp_year" placeholder="YYYY" inputmode="numeric" maxlength="4" value="${year + 2}" required style="width:90px"></div></div>
            <div class="field"><label>Security code</label><input name="cvc" inputmode="numeric" maxlength="4" placeholder="123" required style="width:90px"></div>
          </div>
          ${state.pay.test_cards.length ? `<div class="demo-box">Test cards: ${state.pay.test_cards.map((c) => `<code>${esc(c.number)}</code> ${esc(c.outcome)}`).join(' · ')}</div>` : ''}
          <button class="btn btn--block btn--lg">Pay ${money(amount)}</button>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button.btn'); btn.disabled = true;
      try {
        await api.post(`/api/payments/${paymentId}/pay`, { card: formData(form) });
        closeModal(); toast(`${money(amount)} ${kind} paid`); reload();
      } catch (err) { handleError(err, $('.error', form)); btn.disabled = false; }
    });
  }

  function paymentsTable(payments) {
    const me = state.user;
    if (!payments.length) return '<div class="empty"><p>No payments yet.</p></div>';
    return `<div style="overflow-x:auto"><table class="table">
      <thead><tr><th>When</th><th>${me.role === 'artist' ? 'Client' : 'Artist'}</th><th>Session</th><th>Type</th><th>Amount</th><th>Status</th></tr></thead>
      <tbody>${payments.map((p) => `<tr>
        <td>${timeAgo(p.paid_at || p.created_at)}</td>
        <td>${esc(me.role === 'artist' ? p.client_name : p.artist_name)}</td>
        <td>${fmtSlot(p.starts_at)}</td>
        <td>${esc(p.kind)}${p.card_last4 ? ` <span class="faint">·· ${esc(p.card_last4)}</span>` : ''}</td>
        <td><strong>${money(p.amount)}</strong></td>
        <td><span class="pill pill--${attr(p.status)}" title="${attr(p.note || '')}">${esc(p.status)}</span></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  async function viewPaymentsReturn(params) {
    if (!requireLogin('/appointments')) return;
    loading();
    const id = params.get('payment');
    const sessionId = params.get('session_id');
    try {
      await api.post(`/api/payments/${id}/confirm`, { session_id: sessionId });
      toast('Payment received');
    } catch (err) { handleError(err); }
    navigate('/appointments');
  }

  async function viewAppointments() {
    if (!requireLogin('/appointments')) return;
    loading();
    let list;
    try { ({ appointments: list } = await api.get('/api/appointments')); } catch (e) { return handleError(e); }
    const now = new Date();
    const upcoming = list.filter((a) => new Date(a.ends_at) >= now && !['declined', 'cancelled', 'completed'].includes(a.status));
    const past = list.filter((a) => !upcoming.includes(a)).reverse();
    const isArtist = state.user.role === 'artist';
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Bookings</h1><p class="muted">${isArtist ? 'Confirm requests, and mark sessions complete when the work is done.' : 'Your sessions, pending and confirmed.'}</p></div>
        ${!isArtist ? '<a class="btn" href="/artists">Find an artist</a>' : '<a class="btn btn--ghost" href="/dashboard?tab=availability">Edit availability</a>'}
      </div>
      <section><div class="section__head"><h2>Upcoming</h2><span class="muted small">${upcoming.filter((a) => a.status === 'pending').length} pending</span></div>
        <div class="stack" data-upcoming>${upcoming.length ? upcoming.map(apptCard).join('') : `<div class="empty"><h3>Nothing scheduled</h3><p>${isArtist ? 'When clients request a session it will show up here.' : 'Browse artists and book a session.'}</p></div>`}</div>
      </section>
      <section class="section"><div class="section__head"><h2>Past &amp; closed</h2></div>
        <div class="stack">${past.length ? past.map(apptCard).join('') : '<p class="faint">No history yet.</p>'}</div>
      </section>`;
    bindApptActions(main, viewAppointments);
  }

  /* ---------- messages ---------- */

  async function viewMessages(otherId) {
    if (!requireLogin(otherId ? `/messages/${otherId}` : '/messages')) return;
    loading();
    let convos;
    try { ({ conversations: convos } = await api.get('/api/messages')); } catch (e) { return handleError(e); }
    const me = state.user;
    main.innerHTML = `
      <div class="page-head"><div><h1>Messages</h1></div></div>
      <div class="messages">
        <div class="messages__list ${otherId ? 'hide-mobile' : ''}" data-list>
          ${convos.length ? convos.map((c) => `
            <a class="convo ${String(c.user_id) === String(otherId) ? 'active' : ''}" href="/messages/${c.user_id}">
              ${avatar(c.avatar_url, c.name, 'avatar--sm')}
              <div class="convo__body">
                <div class="convo__name"><span>${esc(c.name)}</span><span class="faint small">${timeAgo(c.last_at)}</span></div>
                <div class="convo__preview">${c.last_sender_id === me.id ? 'You: ' : ''}${esc(c.last_body)}</div>
              </div>
              ${c.unread ? `<span class="convo__unread">${c.unread}</span>` : ''}
            </a>`).join('') : '<div class="empty" style="border:0"><p>No conversations yet. Message an artist from their profile.</p></div>'}
        </div>
        <div class="messages__thread ${otherId ? '' : 'hide-mobile'}" data-thread>
          ${otherId ? '<div class="loading">Loading</div>' : '<div class="empty" style="border:0;margin:auto"><h3>Pick a conversation</h3><p>Or start one from an artist or client profile.</p></div>'}
        </div>
      </div>`;
    if (!otherId) return;
    const threadEl = $('[data-thread]');
    let lastCount = -1;
    async function loadThread(scroll = true) {
      let r;
      try { r = await api.get(`/api/messages/${otherId}`); } catch (e) { threadEl.innerHTML = '<div class="empty" style="border:0;margin:auto"><h3>User not found</h3></div>'; return; }
      if (r.messages.length === lastCount) return;
      lastCount = r.messages.length;
      const draft = threadEl.querySelector('input[name="body"]');
      const draftValue = draft ? draft.value : '';
      threadEl.innerHTML = `
        <div class="thread__head">
          <a href="/messages" class="muted" style="display:none" data-back>←</a>
          ${avatar(r.other.avatar_url, r.other.name, 'avatar--sm')}
          <div>${r.other.role === 'artist' ? `<a href="/artists/${r.other.id}"><strong>${esc(r.other.name)}</strong></a>` : `<strong>${esc(r.other.name)}</strong>`}<div class="small muted">${r.other.role === 'artist' ? 'Artist' : 'Client'}${r.other.location ? ` · ${esc(r.other.location)}` : ''}</div></div>
          <div style="margin-left:auto" class="row">${me.role === 'client' && r.other.role === 'artist' ? `<a class="btn btn--sm" href="/book/${r.other.id}">Book</a>` : ''}</div>
        </div>
        <div class="thread__body" data-body>
          ${r.messages.length ? r.messages.map((m) => `<div class="bubble ${m.sender_id === me.id ? 'bubble--mine' : ''}">${esc(m.body)}<time>${timeAgo(m.created_at)}</time></div>`).join('') : '<p class="faint" style="text-align:center;margin:auto">Say hello.</p>'}
        </div>
        <form class="thread__compose" data-compose>
          <input name="body" placeholder="Write a message" autocomplete="off" required value="${attr(draftValue)}">
          <button class="btn">Send</button>
        </form>`;
      const body = $('[data-body]', threadEl);
      if (scroll) body.scrollTop = body.scrollHeight;
      $('[data-compose]', threadEl).addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = e.target.body;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        try { await api.post(`/api/messages/${otherId}`, { body: text }); lastCount = -1; await loadThread(); refreshUnread(); } catch (err) { handleError(err); }
      });
      refreshUnread();
    }
    await loadThread();
    const timer = setInterval(() => loadThread(true), 8000);
    onCleanup(() => clearInterval(timer));
  }

  /* ---------- dashboard ---------- */

  async function viewDashboard(params) {
    if (!requireLogin('/dashboard')) return;
    loading();
    const me = state.user;
    if (me.role === 'artist') return viewArtistDashboard(params);
    return viewClientDashboard();
  }

  async function viewArtistDashboard(params) {
    const me = state.user;
    let artist;
    let appts;
    let avail;
    let proposals;
    let pay;
    try {
      [{ artist }, { appointments: appts }, avail, { requests: proposals }, pay] = await Promise.all([
        api.get(`/api/artists/${me.id}`), api.get('/api/appointments'), api.get(`/api/artists/${me.id}/availability`), api.get('/api/requests', { mine: '1' }), api.get('/api/payments'),
      ]);
    } catch (e) { return handleError(e); }
    const tab = params.get('tab') || 'galleries';
    const pending = appts.filter((a) => a.status === 'pending').length;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Your studio</h1><p class="muted">${esc(artist.studio_name || 'Independent')} · <a class="link" href="/artists/${me.id}">View public profile</a></p></div>
        <div class="row">${artist.accepting_clients ? '<span class="pill pill--open">Taking bookings</span>' : '<span class="pill pill--closed">Books closed</span>'}<a class="btn btn--ghost btn--sm" href="/settings">Edit profile</a></div>
      </div>
      <div class="kpis">
        <div class="kpi"><strong>${artist.artwork_count}</strong><span>pieces shared</span></div>
        <div class="kpi"><strong>${artist.follower_count}</strong><span>followers</span></div>
        <div class="kpi"><strong>${artist.like_count}</strong><span>likes</span></div>
        <div class="kpi"><strong>${pending}</strong><span>booking requests</span></div>
        <div class="kpi"><strong>${proposals.length}</strong><span>proposals sent</span></div>
        <div class="kpi"><strong>${money(pay.summary.collected)}</strong><span>collected${pay.summary.outstanding ? ` · ${money(pay.summary.outstanding)} due` : ''}</span></div>
      </div>
      <div class="tabs" style="margin-top:24px">
        <button data-tab="galleries" class="${tab === 'galleries' ? 'active' : ''}">Galleries</button>
        <button data-tab="availability" class="${tab === 'availability' ? 'active' : ''}">Availability</button>
        <button data-tab="bookings" class="${tab === 'bookings' ? 'active' : ''}">Bookings${pending ? ` (${pending})` : ''}</button>
        <button data-tab="proposals" class="${tab === 'proposals' ? 'active' : ''}">Proposals</button>
        <button data-tab="payments" class="${tab === 'payments' ? 'active' : ''}">Payments</button>
      </div>
      <div data-panel></div>`;

    const panel = $('[data-panel]');
    const renderTab = (name) => {
      $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (name === 'galleries') {
        panel.innerHTML = `
          <div class="section__head"><h2>Galleries</h2><button class="btn btn--sm" data-new-gallery>New gallery</button></div>
          ${artist.galleries.length ? `<div class="grid grid--3">${artist.galleries.map((g) => `
            <a class="gallery-card" href="/galleries/${g.id}">
              ${g.cover_url ? `<img src="${attr(g.cover_url)}" alt="">` : '<div class="gallery-card--empty" style="height:100%">No pieces yet</div>'}
              <div class="gallery-card__label"><strong>${esc(g.title)}</strong><span>${g.artwork_count} pieces · open to upload</span></div>
            </a>`).join('')}</div>` : '<div class="empty"><h3>Create your first gallery</h3><p>Group your work by style, body part, or project.</p></div>'}`;
        $('[data-new-gallery]', panel).addEventListener('click', () => {
          const modal = openModal(`
            <div class="modal__panel">
              <div class="modal__head"><h3 style="margin:0">New gallery</h3><button class="modal__close" data-close-modal>×</button></div>
              <form class="form modal__body" data-form>
                <div class="error" hidden></div>
                <div class="field"><label>Title</label><input name="title" placeholder="Healed blackwork" required></div>
                <div class="field"><label>Description</label><textarea name="description" placeholder="What goes in this gallery?"></textarea></div>
                <button class="btn btn--block">Create gallery</button>
              </form>
            </div>`, { small: true });
          const form = $('[data-form]', modal);
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            try { const r = await api.post('/api/galleries', formData(form)); closeModal(); toast('Gallery created'); navigate(`/galleries/${r.gallery.id}`); } catch (err) { handleError(err, $('.error', form)); }
          });
        });
      } else if (name === 'availability') {
        const rows = avail.availability.slice();
        const draw = () => {
          panel.innerHTML = `
            <div class="section__head"><h2>Weekly hours</h2><span class="muted small">Sessions are ${artist.session_minutes} minutes. <a class="link" href="/settings">Change</a></span></div>
            <p class="muted">Clients can book any ${artist.session_minutes}-minute slot inside these windows. Times are your studio's local time.</p>
            <div class="avail-editor" data-rows>
              ${rows.map((w, i) => `
                <div class="avail-row">
                  <select data-i="${i}" data-k="weekday">${WEEKDAYS.map((d, di) => `<option value="${di}" ${di === Number(w.weekday) ? 'selected' : ''}>${d}</option>`).join('')}</select>
                  <input type="time" data-i="${i}" data-k="start_time" value="${attr(w.start_time)}">
                  <input type="time" data-i="${i}" data-k="end_time" value="${attr(w.end_time)}">
                  <button class="btn btn--ghost btn--sm" data-remove="${i}">Remove</button>
                </div>`).join('')}
              ${rows.length ? '' : '<p class="faint">No hours yet. Add a window to open your books.</p>'}
            </div>
            <div class="row" style="margin-top:16px"><button class="btn btn--ghost" data-add>Add hours</button><button class="btn" data-save>Save hours</button></div>`;
          $$('select,[type=time]', panel).forEach((el) => el.addEventListener('change', () => { rows[el.dataset.i][el.dataset.k] = el.value; }));
          $$('[data-remove]', panel).forEach((b) => b.addEventListener('click', () => { rows.splice(Number(b.dataset.remove), 1); draw(); }));
          $('[data-add]', panel).addEventListener('click', () => { rows.push({ weekday: 2, start_time: '10:00', end_time: '18:00' }); draw(); });
          $('[data-save]', panel).addEventListener('click', async () => {
            try { avail = await api.put('/api/artists/me/availability', { availability: rows }); toast('Hours saved'); } catch (err) { handleError(err); }
          });
        };
        draw();
      } else if (name === 'bookings') {
        const upcoming = appts.filter((a) => ['pending', 'confirmed'].includes(a.status));
        panel.innerHTML = `
          <div class="section__head"><h2>Requests &amp; upcoming sessions</h2><a class="link" href="/appointments">Full schedule</a></div>
          <div class="stack">${upcoming.length ? upcoming.map(apptCard).join('') : '<div class="empty"><h3>No upcoming sessions</h3><p>Publish your hours so clients can book.</p></div>'}</div>`;
        bindApptActions(panel, () => viewArtistDashboard(new URLSearchParams('tab=bookings')));
      } else if (name === 'proposals') {
        panel.innerHTML = `
          <div class="section__head"><h2>Requests you proposed on</h2><a class="link" href="/requests">Browse open requests</a></div>
          ${proposals.length ? `<div class="grid grid--2">${proposals.map(requestCard).join('')}</div>` : '<div class="empty"><h3>No proposals yet</h3><p>Browse client requests and send a proposal to find new clients.</p></div>'}`;
      } else if (name === 'payments') {
        panel.innerHTML = `
          <div class="section__head"><h2>Payments</h2><span class="muted small">Deposit: ${artist.deposit_amount ? money(artist.deposit_amount) : 'none'} · <a class="link" href="/settings">Change</a></span></div>
          <div class="kpis" style="margin-bottom:18px">
            <div class="kpi"><strong>${money(pay.summary.collected)}</strong><span>collected</span></div>
            <div class="kpi"><strong>${money(pay.summary.outstanding)}</strong><span>awaiting payment</span></div>
            <div class="kpi"><strong>${money(pay.summary.refunded)}</strong><span>refunded</span></div>
          </div>
          ${paymentsTable(pay.payments)}
          <p class="small faint" style="margin-top:14px">Deposits are refunded automatically when you decline or cancel, and when a client cancels ${state.pay.refund_window_hours}+ hours ahead. Late client cancellations keep the deposit.</p>`;
      }
    };
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => renderTab(b.dataset.tab)));
    renderTab(tab);
  }

  async function viewClientDashboard() {
    const me = state.user;
    let requests;
    let appts;
    let pay;
    try { [{ requests }, { appointments: appts }, pay] = await Promise.all([api.get('/api/requests', { mine: '1' }), api.get('/api/appointments'), api.get('/api/payments')]); } catch (e) { return handleError(e); }
    const upcoming = appts.filter((a) => ['pending', 'confirmed'].includes(a.status));
    const dueNow = pay.payments.filter((p) => p.status === 'pending' && ['pending', 'confirmed', 'completed'].includes(p.appointment_status)).reduce((n, p) => n + p.amount, 0);
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Hi, ${esc(me.name.split(' ')[0])}</h1><p class="muted">Your requests and sessions in one place.</p></div>
        <div class="row"><a class="btn btn--ghost" href="/artists">Find an artist</a><a class="btn" href="/requests/new">Post a request</a></div>
      </div>
      <div class="kpis">
        <div class="kpi"><strong>${requests.filter((r) => r.status === 'open').length}</strong><span>open requests</span></div>
        <div class="kpi"><strong>${requests.reduce((n, r) => n + r.proposal_count, 0)}</strong><span>proposals received</span></div>
        <div class="kpi"><strong>${upcoming.length}</strong><span>upcoming sessions</span></div>
        <div class="kpi"><strong>${money(dueNow)}</strong><span>due now</span></div>
      </div>
      <section class="section">
        <div class="section__head"><h2>Upcoming sessions</h2><a class="link" href="/appointments">All bookings</a></div>
        <div class="stack">${upcoming.length ? upcoming.map(apptCard).join('') : '<div class="empty"><p>No sessions booked. Pick an artist and request a slot.</p></div>'}</div>
      </section>
      <section class="section">
        <div class="section__head"><h2>Your requests</h2></div>
        ${requests.length ? `<div class="grid grid--2">${requests.map(requestCard).join('')}</div>` : '<div class="empty"><h3>No requests yet</h3><p>Describe what you want and let artists send proposals.</p></div>'}
      </section>
      <section class="section">
        <div class="section__head"><h2>Payments</h2></div>
        ${paymentsTable(pay.payments)}
      </section>`;
    bindApptActions(main, viewClientDashboard);
  }

  /* ---------- settings ---------- */

  function viewSettings() {
    if (!requireLogin('/settings')) return;
    const u = state.user;
    const p = u.profile || {};
    main.innerHTML = `
      <div class="narrow">
        <h1>Profile settings</h1>
        <div class="card">
          <div class="row">${avatar(u.avatar_url, u.name, 'avatar--lg')}<form data-avatar class="stack"><div class="field"><label>Profile photo</label><input type="file" name="avatar" accept="image/*"></div><button class="btn btn--sm btn--subtle">Upload photo</button></form></div>
        </div>
        <form class="form card" data-form style="margin-top:14px">
          <div class="error" hidden></div>
          <div class="form-row">
            <div class="field"><label>Name</label><input name="name" value="${attr(u.name)}" required></div>
            <div class="field"><label>Location</label><input name="location" value="${attr(u.location || '')}" placeholder="City, State"></div>
          </div>
          <div class="field"><label>Bio</label><textarea name="bio" placeholder="${u.role === 'artist' ? 'Your style, your studio, what you love to tattoo.' : 'A little about you and what you collect.'}">${esc(u.bio || '')}</textarea></div>
          <label class="check"><input type="checkbox" name="email_notifications" ${u.email_notifications !== false ? 'checked' : ''}> Email me about bookings, proposals, payments and messages</label>
          ${u.role === 'artist' ? `
            <hr class="divider" style="margin:6px 0">
            <h3>Studio</h3>
            <div class="form-row">
              <div class="field"><label>Studio name</label><input name="studio_name" value="${attr(p.studio_name || '')}"></div>
              <div class="field"><label>Years tattooing</label><input name="years_experience" type="number" min="0" max="80" value="${attr(p.years_experience ?? '')}"></div>
            </div>
            <div class="field"><span class="label">Styles</span><div class="chips">${state.styles.map((s) => `<label class="chip ${p.styles.includes(s) ? 'active' : ''}"><input type="checkbox" name="styles" value="${attr(s)}" ${p.styles.includes(s) ? 'checked' : ''} hidden>${esc(s)}</label>`).join('')}</div></div>
            <div class="form-row">
              <div class="field"><label>Hourly rate ($)</label><input name="hourly_rate" type="number" min="0" value="${attr(p.hourly_rate ?? '')}"></div>
              <div class="field"><label>Minimum price ($)</label><input name="min_price" type="number" min="0" value="${attr(p.min_price ?? '')}"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Session length (minutes)</label><input name="session_minutes" type="number" min="30" max="720" step="15" value="${attr(p.session_minutes)}"><span class="hint">Booking slots are this long.</span></div>
              <div class="field"><label>Instagram</label><input name="instagram" value="${attr(p.instagram || '')}" placeholder="handle"></div>
            </div>
            <div class="form-row">
              <div class="field"><label>Website</label><input name="website" value="${attr(p.website || '')}" placeholder="yourstudio.com"></div>
              <div class="field"><label>Booking deposit ($)</label><input name="deposit_amount" type="number" min="0" step="5" value="${attr(p.deposit_amount || 0)}"><span class="hint">Charged when a client books. 0 means no deposit.</span></div>
            </div>
            <label class="check"><input type="checkbox" name="accepting_clients" ${p.accepting_clients ? 'checked' : ''}> Taking new clients and bookings</label>
          ` : ''}
          <button class="btn">Save changes</button>
        </form>
        <form class="form card" data-password style="margin-top:14px">
          <h3>Change password</h3>
          <div class="error" hidden></div>
          <div class="form-row">
            <div class="field"><label>Current password</label><input name="current_password" type="password" required autocomplete="current-password"></div>
            <div class="field"><label>New password</label><input name="new_password" type="password" minlength="8" required autocomplete="new-password"></div>
          </div>
          <div class="row row--between"><span class="hint">Other devices are signed out when you change it.</span><button class="btn btn--subtle">Update password</button></div>
        </form>
        <div class="card" style="margin-top:14px" data-emails>
          <h3>Recent emails</h3>
          <div class="loading">Loading</div>
        </div>
        <div class="card" style="margin-top:14px">
          <h3>Your account</h3>
          <div class="list-item"><div><strong>Download your data</strong><div class="small muted">Everything we hold about you, as a JSON file.</div></div><a class="btn btn--ghost btn--sm" href="/api/auth/me/export" download rel="external">Export</a></div>
          <div class="list-item"><div><strong>Sign out everywhere</strong><div class="small muted">Ends every session, including this one.</div></div><button class="btn btn--ghost btn--sm" data-logout-all>Sign out all</button></div>
          <div class="list-item"><div><strong>Delete account</strong><div class="small muted">Removes your profile, galleries, requests and messages. Payment records are kept without your details.</div></div><button class="btn btn--danger btn--sm" data-delete-account>Delete</button></div>
        </div>
      </div>`;
    $('[data-logout-all]').addEventListener('click', async () => {
      if (!confirm('Sign out of every device?')) return;
      try { await api.post('/api/auth/logout-all'); state.user = null; renderNav(); navigate('/'); } catch (err) { handleError(err); }
    });
    $('[data-delete-account]').addEventListener('click', () => {
      const modal = openModal(`
        <div class="modal__panel">
          <div class="modal__head"><h3 style="margin:0">Delete your account</h3><button class="modal__close" data-close-modal>×</button></div>
          <form class="form modal__body" data-form>
            <div class="error" hidden></div>
            <p class="muted">This cannot be undone. Active bookings are cancelled and deposits refunded under the usual policy.</p>
            <div class="field"><label>Confirm with your password</label><input name="password" type="password" required autocomplete="current-password"></div>
            <button class="btn btn--danger btn--block">Delete my account</button>
          </form>
        </div>`, { small: true });
      const form = $('[data-form]', modal);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await fetch('/api/auth/me', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.password.value }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
          closeModal(); state.user = null; renderNav(); toast('Your account has been deleted'); navigate('/');
        } catch (err) { handleError(err, $('.error', form)); }
      });
    });
    const pwForm = $('[data-password]');
    pwForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.put('/api/auth/me/password', formData(pwForm)); pwForm.reset(); toast('Password updated'); } catch (err) { handleError(err, $('.error', pwForm)); }
    });
    api.get('/api/auth/me/emails').then((r) => {
      const box = $('[data-emails]');
      if (!box) return;
      box.innerHTML = `<h3>Recent emails</h3>
        <p class="small muted">${r.live ? 'Delivered through the configured mail server.' : 'No mail server is configured, so notifications are recorded here instead of being delivered.'}</p>
        ${r.emails.length ? r.emails.map((m) => `
          <details class="list-item" style="display:block">
            <summary style="cursor:pointer;display:flex;justify-content:space-between;gap:12px"><span>${esc(m.subject)}</span><span class="faint small">${m.status === 'skipped' ? 'muted · ' : ''}${timeAgo(m.created_at)}</span></summary>
            <pre class="small muted" style="white-space:pre-wrap;margin:10px 0 0;font-family:inherit">${esc(m.body_text)}</pre>
          </details>`).join('') : '<p class="faint small">Nothing yet.</p>'}`;
    }).catch(() => {});
    $$('label.chip').forEach((l) => l.addEventListener('click', () => setTimeout(() => l.classList.toggle('active', l.querySelector('input').checked), 0)));
    const form = $('[data-form]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formData(form);
      data.email_notifications = form.email_notifications.checked;
      if (u.role === 'artist') {
        data.styles = $$('input[name="styles"]:checked').map((i) => i.value);
        data.accepting_clients = form.accepting_clients.checked;
      }
      try { const r = await api.put('/api/auth/me', data); state.user = r.user; renderNav(); toast('Profile saved'); } catch (err) { handleError(err, $('.error', form)); }
    });
    $('[data-avatar]').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!e.target.avatar.files.length) return toast('Choose a photo first', 'error');
      try { const r = await api.post('/api/auth/me/avatar', new FormData(e.target)); state.user = r.user; renderNav(); toast('Photo updated'); viewSettings(); } catch (err) { handleError(err); }
    });
  }

  /* ---------- auth ---------- */

  function viewLogin(params) {
    const next = params.get('next') || '/';
    main.innerHTML = `
      <div class="narrow" style="max-width:440px">
        <h1>Welcome back</h1>
        <form class="form card" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Email</label><input name="email" type="email" required autofocus></div>
          <div class="field"><label>Password</label><input name="password" type="password" required></div>
          <button class="btn btn--block btn--lg">Log in</button>
          <p class="muted small" style="text-align:center;margin:0">New here? <a class="link" href="/register">Create an account</a> · <a class="link" href="/forgot">Forgot password?</a></p>
        </form>
        <div class="demo-box" style="margin-top:14px">
          <strong>Try a demo account</strong> · password <code>password123</code><br>
          Artist: <code>mara@inkwell.demo</code> · Client: <code>jordan@inkwell.demo</code>
        </div>
      </div>`;
    const form = $('[data-form]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/auth/login', formData(form));
        state.user = r.user; renderNav(); refreshUnread();
        toast(`Welcome back, ${r.user.name.split(' ')[0]}`);
        navigate(next);
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  function viewRegister() {
    main.innerHTML = `
      <div class="narrow" style="max-width:520px">
        <h1>Join Inkwell</h1>
        <form class="form card" data-form>
          <div class="error" hidden></div>
          <div class="role-picker">
            <label><input type="radio" name="role" value="artist" checked><strong>I'm an artist</strong><span class="muted small">Share galleries, take bookings, find clients.</span></label>
            <label><input type="radio" name="role" value="client"><strong>I'm a client</strong><span class="muted small">Discover artists, post requests, book sessions.</span></label>
          </div>
          <div class="form-row">
            <div class="field"><label>Name</label><input name="name" required></div>
            <div class="field"><label>Location</label><input name="location" placeholder="City, State"></div>
          </div>
          <div class="field"><label>Email</label><input name="email" type="email" required></div>
          <div class="field"><label>Password</label><input name="password" type="password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
          <div data-artist-fields>
            <div class="field"><label>Studio name</label><input name="studio_name" placeholder="Optional"></div>
            <div class="field" style="margin-top:14px"><span class="label">Styles you work in</span><div class="chips">${state.styles.map((s) => `<label class="chip"><input type="checkbox" name="styles" value="${attr(s)}" hidden>${esc(s)}</label>`).join('')}</div></div>
          </div>
          <label class="check small"><input type="checkbox" name="accept_terms" required> I agree to the <a class="link" href="/terms" target="_blank" rel="external">Terms of Service</a> and <a class="link" href="/privacy" target="_blank" rel="external">Privacy Policy</a>.</label>
          <button class="btn btn--block btn--lg">Create account</button>
          <p class="muted small" style="text-align:center;margin:0">Already have an account? <a class="link" href="/login">Log in</a></p>
        </form>
      </div>`;
    const form = $('[data-form]');
    const artistFields = $('[data-artist-fields]');
    form.addEventListener('change', (e) => { if (e.target.name === 'role') artistFields.hidden = e.target.value !== 'artist'; });
    $$('label.chip').forEach((l) => l.addEventListener('click', () => setTimeout(() => l.classList.toggle('active', l.querySelector('input').checked), 0)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = formData(form);
      data.styles = $$('input[name="styles"]:checked').map((i) => i.value);
      data.accept_terms = form.accept_terms.checked;
      try {
        const r = await api.post('/api/auth/register', data);
        state.user = r.user; renderNav();
        toast('Welcome to Inkwell');
        navigate(r.user.role === 'artist' ? '/dashboard' : '/artists');
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  function viewForgot() {
    main.innerHTML = `
      <div class="narrow" style="max-width:440px">
        <h1>Forgot your password?</h1>
        <p class="muted">Enter your email and we will send a link to choose a new one.</p>
        <form class="form card" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Email</label><input name="email" type="email" required autofocus></div>
          <button class="btn btn--block btn--lg">Send reset link</button>
          <p class="muted small" style="text-align:center;margin:0"><a class="link" href="/login">Back to log in</a></p>
        </form>
      </div>`;
    const form = $('[data-form]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/auth/forgot', formData(form));
        main.innerHTML = `
          <div class="narrow" style="max-width:440px">
            <h1>Check your inbox</h1>
            <div class="card"><p>${esc(r.message)}</p><p class="muted small" style="margin:0">The link works for one hour.</p></div>
            ${r.dev_reset_url ? `<div class="demo-box" style="margin-top:14px"><strong>No mail server is configured.</strong> For this demo, here is the link that would have been emailed:<br><a class="link" href="${attr(r.dev_reset_url.replace(/^https?:\/\/[^/]+/, ''))}">Reset password</a></div>` : ''}
          </div>`;
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  function viewReset(params) {
    const token = params.get('token') || '';
    main.innerHTML = `
      <div class="narrow" style="max-width:440px">
        <h1>Choose a new password</h1>
        <form class="form card" data-form>
          <div class="error" hidden></div>
          ${token ? '' : '<div class="error">This reset link is missing its token. <a class="link" href="/forgot">Request a new one.</a></div>'}
          <div class="field"><label>New password</label><input name="password" type="password" minlength="8" required autocomplete="new-password" autofocus></div>
          <div class="field"><label>Confirm password</label><input name="confirm" type="password" minlength="8" required autocomplete="new-password"></div>
          <button class="btn btn--block btn--lg" ${token ? '' : 'disabled'}>Save password</button>
        </form>
      </div>`;
    const form = $('[data-form]');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.password.value !== form.confirm.value) return handleError(new Error('Passwords do not match.'), $('.error', form));
      try {
        const r = await api.post('/api/auth/reset', { token, password: form.password.value });
        state.user = r.user; renderNav(); refreshUnread();
        toast('Password updated. You are signed in.');
        navigate('/');
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  /* ---------- legal pages ---------- */

  const LEGAL_NOTE = '<div class="demo-box" style="margin-bottom:18px">This is a starting template. Have a lawyer in your jurisdiction review it before launch and replace the placeholders.</div>';

  function viewTerms() {
    main.innerHTML = `
      <div class="narrow legal">
        <h1>Terms of Service</h1>
        <p class="muted">Last updated: ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        ${LEGAL_NOTE}
        <h3>1. Who we are</h3><p>Inkwell ("we", "us") operates this website, a marketplace where tattoo artists ("Artists") present their work and clients ("Clients") request and book tattoo sessions. Inkwell is not a party to the agreement between an Artist and a Client and does not perform tattoo services.</p>
        <h3>2. Accounts</h3><p>You must be at least 18 years old to use Inkwell. You are responsible for keeping your password private and for everything that happens under your account. Provide accurate information and keep it up to date.</p>
        <h3>3. Artists</h3><p>Artists confirm that they hold any licence or registration required where they work, that they own or have rights to the images they upload, and that the work shown is their own. Artists set their own prices, deposits and hours.</p>
        <h3>4. Bookings, deposits and refunds</h3><p>A booking request becomes an appointment when the Artist confirms it. Deposits are charged when a booking is requested and are refunded in full if the Artist declines or cancels, or if the Client cancels at least ${state.pay.refund_window_hours} hours before the session. Later cancellations by the Client forfeit the deposit to the Artist. Balance payments are due after the session. Payment processing is handled by our payment provider; Inkwell does not store card numbers.</p>
        <h3>5. Content and conduct</h3><p>Do not upload content you do not have the right to share, or content that is illegal, hateful, harassing, sexually explicit, or that impersonates someone else. We may remove content and suspend accounts that break these rules. You keep the rights to your content and grant us a licence to display it on Inkwell for the purpose of running the service.</p>
        <h3>6. Health and safety</h3><p>Tattooing carries health risks. Clients are responsible for disclosing relevant medical information to the Artist and following aftercare advice. Artists are responsible for hygiene and safe practice. Inkwell provides no medical advice.</p>
        <h3>7. Liability</h3><p>Inkwell is provided "as is". To the extent permitted by law we are not liable for the quality of any tattoo, for disputes between Artists and Clients, or for indirect or consequential losses.</p>
        <h3>8. Changes and termination</h3><p>We may update these terms; continued use after a change means you accept it. You can delete your account at any time from settings. We may suspend or terminate accounts that break these terms.</p>
        <h3>9. Contact</h3><p>Questions about these terms: <a class="link" href="mailto:support@inkwell.example">support@inkwell.example</a>.</p>
      </div>`;
  }

  function viewPrivacy() {
    main.innerHTML = `
      <div class="narrow legal">
        <h1>Privacy Policy</h1>
        <p class="muted">Last updated: ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        ${LEGAL_NOTE}
        <h3>What we collect</h3><p>Account details (name, email, password hash, location, bio, profile photo), the content you post (galleries, requests, proposals, messages, reviews), booking and payment records (amounts, status and the last four digits of a card, never the full number), and technical logs (IP address, browser, pages requested) kept for security.</p>
        <h3>How we use it</h3><p>To run the marketplace: show profiles and galleries, connect Clients with Artists, process bookings and payments, send the emails you have asked for, keep the site safe, and comply with legal obligations such as accounting rules.</p>
        <h3>Emails</h3><p>We send transactional emails about bookings, payments, proposals, messages and your account. You can turn off notification emails in settings. Account security emails are always sent.</p>
        <h3>Cookies</h3><p>We use one strictly necessary cookie to keep you signed in. We do not use advertising or tracking cookies.</p>
        <h3>Sharing</h3><p>Your public profile and content are visible to anyone. Payment details are shared with our payment processor to complete a charge. We share data with authorities only when legally required. We do not sell personal data.</p>
        <h3>Retention</h3><p>Content is kept while your account exists. When you delete your account we remove your profile, content and messages and anonymise records we must keep for accounting.</p>
        <h3>Your rights</h3><p>You can export your data and delete your account from settings at any time. Depending on where you live you may have further rights to access, correct or restrict processing; contact us to exercise them.</p>
        <h3>Contact</h3><p><a class="link" href="mailto:privacy@inkwell.example">privacy@inkwell.example</a></p>
      </div>`;
  }

  /* ---------- admin ---------- */

  async function viewAdmin(params) {
    if (!requireLogin('/admin')) return;
    if (!state.user.is_admin) { main.innerHTML = '<div class="empty"><h3>Admins only</h3></div>'; return; }
    loading();
    let overview;
    try { ({ overview } = await api.get('/api/admin/overview')); } catch (e) { return handleError(e); }
    const tab = params.get('tab') || 'reports';
    main.innerHTML = `
      <div class="page-head"><div><h1>Moderation</h1><p class="muted">Reports, users and site health.</p></div></div>
      <div class="kpis">
        <div class="kpi"><strong>${overview.open_reports}</strong><span>open reports</span></div>
        <div class="kpi"><strong>${overview.users}</strong><span>users · ${overview.signups_7d} new this week</span></div>
        <div class="kpi"><strong>${overview.artists}</strong><span>artists</span></div>
        <div class="kpi"><strong>${overview.artworks}</strong><span>artworks</span></div>
        <div class="kpi"><strong>${overview.active_bookings}</strong><span>active bookings</span></div>
        <div class="kpi"><strong>${money(overview.payments_collected)}</strong><span>collected</span></div>
        <div class="kpi"><strong>${overview.suspended}</strong><span>suspended</span></div>
      </div>
      <div class="tabs" style="margin-top:24px">
        <button data-tab="reports" class="${tab === 'reports' ? 'active' : ''}">Open reports</button>
        <button data-tab="closed" class="${tab === 'closed' ? 'active' : ''}">Closed reports</button>
        <button data-tab="users" class="${tab === 'users' ? 'active' : ''}">Users</button>
      </div>
      <div data-panel></div>`;
    const panel = $('[data-panel]');

    const targetHtml = (r) => {
      const t = r.target;
      if (!t) return '<span class="faint">Content already removed</span>';
      const owner = t.role === 'artist' ? `<a class="link" href="/artists/${t.owner_id}">${esc(t.owner_name)}</a>` : `<strong>${esc(t.owner_name)}</strong>`;
      switch (r.target_type) {
        case 'artwork': return `<div class="row"><img src="${attr(t.thumb_url || t.image_url)}" alt="" style="width:64px;height:80px;object-fit:cover;border-radius:6px"><div><strong>${esc(t.title)}</strong><div class="small muted">by ${owner}</div><div class="small muted">${esc((t.description || '').slice(0, 120))}</div></div></div>`;
        case 'comment': return `<div><em>"${esc(t.body)}"</em><div class="small muted">comment by ${owner}</div></div>`;
        case 'user': return `<div class="row">${avatar(t.avatar_url, t.name, 'avatar--sm')}<div><strong>${esc(t.name)}</strong> <span class="tag">${esc(t.role)}</span>${t.suspended_at ? ' <span class="pill pill--closed">suspended</span>' : ''}<div class="small muted">${esc(t.email)}</div></div></div>`;
        case 'request': return `<div><strong>${esc(t.title)}</strong><div class="small muted">request by ${owner}</div><div class="small muted">${esc((t.description || '').slice(0, 160))}</div></div>`;
        case 'review': return `<div>${stars(t.rating)} <em>"${esc(t.body || '')}"</em><div class="small muted">review by ${owner}</div></div>`;
        default: return '';
      }
    };

    async function renderReports(status) {
      panel.innerHTML = '<div class="loading">Loading</div>';
      let reports;
      try { ({ reports } = await api.get('/api/admin/reports', { status })); } catch (e) { return handleError(e); }
      if (status === 'closed') {
        let more;
        try { ({ reports: more } = await api.get('/api/admin/reports', { status: 'dismissed' })); } catch { more = []; }
        reports = [...reports, ...more].sort((a, b) => (a.resolved_at < b.resolved_at ? 1 : -1));
      }
      panel.innerHTML = reports.length ? `<div class="stack">${reports.map((r) => `
        <div class="card" data-report="${r.id}">
          <div class="row row--between">
            <div class="row"><span class="tag">${esc(r.target_type)} #${r.target_id}</span><strong>${esc(r.reason)}</strong>${pill(r.status)}</div>
            <span class="faint small">by ${esc(r.reporter_name)} · ${timeAgo(r.created_at)}</span>
          </div>
          ${r.details ? `<p class="small muted" style="margin:8px 0 0">${esc(r.details)}</p>` : ''}
          <div style="margin-top:12px;padding:12px;background:var(--bg);border-radius:10px">${targetHtml(r)}</div>
          ${r.status === 'open' ? `
            <div class="row" style="margin-top:12px">
              <input data-note placeholder="Note for the record (optional)" style="flex:1;min-width:200px;padding:8px 12px;border-radius:999px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text)">
              <button class="btn btn--ghost btn--sm" data-resolve="dismiss">Dismiss</button>
              ${r.target_type !== 'user' && r.target ? '<button class="btn btn--sm btn--subtle" data-resolve="remove">Remove content</button>' : ''}
              ${r.target ? '<button class="btn btn--danger btn--sm" data-resolve="suspend">Suspend owner</button>' : ''}
            </div>` : `<div class="small muted" style="margin-top:8px">${esc(r.resolution || '')} · ${timeAgo(r.resolved_at)}</div>`}
        </div>`).join('')}</div>` : '<div class="empty"><h3>Queue is clear</h3></div>';
      $$('[data-resolve]', panel).forEach((b) => b.addEventListener('click', async () => {
        const card = b.closest('[data-report]');
        const action = b.dataset.resolve;
        if (action === 'suspend' && !confirm('Suspend this user and remove the reported content?')) return;
        try { await api.post(`/api/admin/reports/${card.dataset.report}/resolve`, { action, note: $('[data-note]', card).value }); toast('Report closed'); viewAdmin(new URLSearchParams(`tab=${status === 'open' ? 'reports' : 'closed'}`)); } catch (err) { handleError(err); }
      }));
    }

    async function renderUsers(q = '') {
      panel.innerHTML = `
        <form class="filters" data-search><input name="q" placeholder="Search name or email" value="${attr(q)}"><button class="btn btn--subtle btn--sm">Search</button></form>
        <div data-users><div class="loading">Loading</div></div>`;
      $('[data-search]', panel).addEventListener('submit', (e) => { e.preventDefault(); renderUsers(e.target.q.value.trim()); });
      let users;
      try { ({ users } = await api.get('/api/admin/users', { q })); } catch (e) { return handleError(e); }
      $('[data-users]', panel).innerHTML = `<div style="overflow-x:auto"><table class="table">
        <thead><tr><th>User</th><th>Role</th><th>Joined</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-user="${u.id}">
          <td><div class="row">${avatar(u.avatar_url, u.name, 'avatar--xs')}<div><strong>${esc(u.name)}</strong>${u.is_admin ? ' <span class="tag">admin</span>' : ''}<div class="small muted">${esc(u.email)}</div></div></div></td>
          <td>${esc(u.role)}</td>
          <td class="small muted">${timeAgo(u.created_at)}</td>
          <td>${u.suspended_at ? `<span class="pill pill--closed" title="${attr(u.suspended_reason || '')}">suspended</span>` : '<span class="pill pill--open">active</span>'}${u.open_reports ? ` <span class="pill pill--pending">${u.open_reports} report${u.open_reports === 1 ? '' : 's'}</span>` : ''}</td>
          <td class="row" style="justify-content:flex-end">
            ${u.id === state.user.id ? '<span class="faint small">you</span>' : `
              ${u.suspended_at ? `<button class="btn btn--ghost btn--sm" data-unsuspend="${u.id}">Reinstate</button>` : `<button class="btn btn--danger btn--sm" data-suspend="${u.id}">Suspend</button>`}
              <button class="btn btn--ghost btn--sm" data-admin="${u.id}" data-value="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Remove admin' : 'Make admin'}</button>`}
          </td>
        </tr>`).join('')}</tbody></table></div>`;
      $$('[data-suspend]', panel).forEach((b) => b.addEventListener('click', async () => {
        const reason = prompt('Reason for suspension (sent to the user):');
        if (reason === null) return;
        try { await api.post(`/api/admin/users/${b.dataset.suspend}/suspend`, { reason }); toast('User suspended'); renderUsers(q); } catch (err) { handleError(err); }
      }));
      $$('[data-unsuspend]', panel).forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/api/admin/users/${b.dataset.unsuspend}/unsuspend`); toast('User reinstated'); renderUsers(q); } catch (err) { handleError(err); }
      }));
      $$('[data-admin]', panel).forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/api/admin/users/${b.dataset.admin}/admin`, { is_admin: b.dataset.value === '1' }); renderUsers(q); } catch (err) { handleError(err); }
      }));
    }

    const show = (name) => {
      $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (name === 'reports') renderReports('open');
      else if (name === 'closed') renderReports('closed');
      else renderUsers();
    };
    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    show(tab);
  }

  /* ---------- router ---------- */

  const routes = [
    [/^\/$/, () => viewHome()],
    [/^\/artists$/, (m, p) => viewArtists(p)],
    [/^\/artists\/(\d+)$/, (m) => viewArtist(m[1])],
    [/^\/galleries\/(\d+)$/, (m) => viewGallery(m[1])],
    [/^\/requests$/, (m, p) => viewRequests(p)],
    [/^\/requests\/new$/, () => viewNewRequest()],
    [/^\/requests\/(\d+)$/, (m) => viewRequest(m[1])],
    [/^\/book\/(\d+)$/, (m, p) => viewBook(m[1], p)],
    [/^\/appointments$/, () => viewAppointments()],
    [/^\/messages$/, () => viewMessages(null)],
    [/^\/messages\/(\d+)$/, (m) => viewMessages(m[1])],
    [/^\/dashboard$/, (m, p) => viewDashboard(p)],
    [/^\/settings$/, () => viewSettings()],
    [/^\/login$/, (m, p) => viewLogin(p)],
    [/^\/register$/, () => viewRegister()],
    [/^\/forgot$/, () => viewForgot()],
    [/^\/reset$/, (m, p) => viewReset(p)],
    [/^\/payments\/return$/, (m, p) => viewPaymentsReturn(p)],
    [/^\/terms$/, () => viewTerms()],
    [/^\/privacy$/, () => viewPrivacy()],
    [/^\/admin$/, (m, p) => viewAdmin(p)],
  ];

  function route() {
    if (!state.ready) return;
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    closeModal();
    renderBanner();
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const params = new URLSearchParams(location.search);
    renderNav();
    window.scrollTo({ top: 0 });
    for (const [re, handler] of routes) {
      const m = path.match(re);
      if (m) { handler(m, params); return; }
    }
    main.innerHTML = '<div class="empty"><h3>Page not found</h3><p><a class="link" href="/">Back to explore</a></p></div>';
  }

  async function boot() {
    try {
      const [r, pay] = await Promise.all([api.get('/api/auth/me'), api.get('/api/payments/config').catch(() => null)]);
      state.user = r.user; state.styles = r.styles;
      if (pay) state.pay = pay;
    } catch { state.styles = []; }
    state.ready = true;
    route();
    refreshUnread();
    setInterval(refreshUnread, 30000);
  }

  window.addEventListener('popstate', route);
  // Intercept same-origin link clicks so the app navigates without a full reload.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.getAttribute('rel') === 'external') return;
    const href = a.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/') || href.startsWith('/uploads/')) return;
    e.preventDefault();
    navigate(href);
  });
  boot();
})();
