/* Inkwell single-page app: hash router + views. Depends on window.api. */
(function () {
  'use strict';

  const state = { user: null, styles: [], unread: 0, notifUnread: 0, ready: false, pay: { provider: 'demo', mode: 'inline', test_cards: [], refund_window_hours: 48 }, installPrompt: null, swRegistration: null };
  const isNative = () => api.isNative();
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
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

  function openModal(html, { small = false, onClose = null } = {}) {
    closeModal();
    modalRoot.innerHTML = `<div class="modal-backdrop" data-close><div class="modal${small ? ' modal--sm' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    document.body.style.overflow = 'hidden';
    const backdrop = modalRoot.firstElementChild;
    backdrop._onClose = onClose;
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop || e.target.closest('[data-close-modal]')) closeModal(); });
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    backdrop._onKey = onKey;
    return backdrop.querySelector('.modal');
  }

  function closeModal({ silent = false } = {}) {
    const backdrop = modalRoot.firstElementChild;
    if (backdrop && backdrop._onKey) document.removeEventListener('keydown', backdrop._onKey);
    const onClose = backdrop && !silent ? backdrop._onClose : null;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    if (onClose) onClose();
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
              <button class="like-btn${artwork.saved ? ' liked' : ''}" data-save title="Save to a board">${artwork.saved ? SHARE_ICONS.saved : SHARE_ICONS.save} <span>${artwork.saved ? 'Saved' : 'Save'}</span></button>
              <button class="like-btn" data-share-art-btn title="Share">${SHARE_ICONS.share} <span>Share</span></button>
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

      // Save and Share open their own dialog; the artwork comes back when it closes.
      $('[data-save]', modal).addEventListener('click', () => savePicker(artwork, (saved) => { artwork.saved = saved; }, () => render()));
      $('[data-share-art-btn]', modal).addEventListener('click', () => shareSheet({ title: `${artwork.title} by ${artwork.artist_name}`, text: `${artwork.title}${artwork.style ? ` (${artwork.style})` : ''} by ${artwork.artist_name} on Inkwell`, path: `/artworks/${artwork.id}`, card: `/og/artworks/${artwork.id}.png`, onClose: () => render() }));
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
      <a href="/flash" class="${active('/flash')}">Flash</a>
      <a href="/requests" class="${active('/requests')}">Client requests</a>
      ${u ? `
        <a href="/notifications" class="${active('/notifications')}" title="Notifications" aria-label="Notifications">🔔<span class="nav-label">Notifications</span>${state.notifUnread ? `<span class="badge-dot">${state.notifUnread}</span>` : ''}</a>
        <a href="/messages" class="${active('/messages')}">Messages${state.unread ? `<span class="badge-dot">${state.unread}</span>` : ''}</a>
        <a href="/appointments" class="${active('/appointments')}">Bookings</a>
        ${u.role === 'client' ? `<a href="/collections" class="${active('/collections') || active('/c/')}">Boards</a>` : ''}
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
      try { await disablePush().catch(() => {}); await api.post('/api/auth/logout'); } catch { /* already out */ }
      api.clearToken();
      state.user = null; state.unread = 0; state.notifUnread = 0;
      toast('Signed out');
      navigate('/');
      renderNav();
    });
    navEl.classList.remove('open');
    document.getElementById('nav-toggle').setAttribute('aria-expanded', 'false');
    renderTabbar();
  }

  const ICONS = {
    explore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    artists: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
    requests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v11H8l-4 4z"/></svg>',
    bookings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    login: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 17l5-5-5-5M15 12H3M21 4v16"/></svg>',
  };

  function renderTabbar() {
    const bar = document.getElementById('tabbar');
    if (!bar) return;
    const path = location.pathname || '/';
    const u = state.user;
    const tab = (href, icon, label, badge) => `<a href="${href}" class="${path === href || (href !== '/' && path.startsWith(href)) ? 'active' : ''}" aria-label="${label}">${ICONS[icon]}<span>${label}</span>${badge ? `<b class="badge-dot">${badge}</b>` : ''}</a>`;
    bar.innerHTML = [
      tab('/', 'explore', 'Explore'),
      tab('/artists', 'artists', 'Artists'),
      u ? tab('/appointments', 'bookings', 'Bookings') : tab('/requests', 'requests', 'Requests'),
      u ? tab('/notifications', 'inbox', 'Inbox', state.notifUnread + state.unread) : tab('/login', 'login', 'Log in'),
      `<button type="button" data-tab-menu aria-label="Menu">${ICONS.menu}<span>Menu</span></button>`,
    ].join('');
    bar.querySelector('[data-tab-menu]').addEventListener('click', () => {
      const open = navEl.classList.toggle('open');
      document.getElementById('nav-toggle').setAttribute('aria-expanded', String(open));
    });
  }

  document.getElementById('nav-toggle').addEventListener('click', (e) => {
    const open = navEl.classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  async function refreshUnread() {
    if (!state.user) return;
    try {
      const [{ unread }, notif] = await Promise.all([api.get('/api/messages/unread'), api.get('/api/notifications/unread')]);
      if (unread !== state.unread || notif.unread !== state.notifUnread) { state.unread = unread; state.notifUnread = notif.unread; renderNav(); }
    } catch { /* ignore */ }
  }

  /* ---------- progressive web app: service worker, install, push ---------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || isNative()) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      state.swRegistration = reg;
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            const el = document.createElement('div');
            el.className = 'toast';
            el.innerHTML = 'A new version is ready. <button class="link" style="color:inherit;text-decoration:underline">Reload</button>';
            el.querySelector('button').addEventListener('click', () => worker.postMessage({ type: 'SKIP_WAITING' }));
            toastRoot.appendChild(el);
          }
        });
      });
    }).catch(() => {});
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
  window.addEventListener('appinstalled', () => { state.installPrompt = null; toast('Inkwell is on your home screen'); });

  async function promptInstall() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const { outcome } = await state.installPrompt.userChoice;
      if (outcome === 'accepted') state.installPrompt = null;
      return;
    }
    if (isIOS()) {
      openModal(`<div class="modal__panel"><div class="modal__head"><h3 style="margin:0">Add Inkwell to your home screen</h3><button class="modal__close" data-close-modal>×</button></div><div class="modal__body"><p>In Safari, tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>. Inkwell will open full screen and can send you notifications.</p></div></div>`, { small: true });
      return;
    }
    toast('Use your browser menu to install Inkwell');
  }

  const urlBase64ToUint8Array = (base64) => {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  };

  function pushSupported() { return !isNative() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }

  async function currentPushSubscription() {
    if (!pushSupported()) return null;
    const reg = state.swRegistration || await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function enablePush() {
    if (isNative()) return enableNativePush();
    if (!pushSupported()) { toast(isIOS() && !isStandalone() ? 'Add Inkwell to your home screen first, then enable notifications' : 'Notifications are not supported in this browser', 'error'); return false; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Notifications are blocked for this site', 'error'); return false; }
    const { public_key: key } = await api.get('/api/push/config');
    const reg = state.swRegistration || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await api.post('/api/push/subscribe', { kind: 'web', subscription: sub.toJSON(), device_name: navigator.userAgent.slice(0, 80) });
    return true;
  }

  async function disablePush() {
    const sub = await currentPushSubscription();
    if (sub) { await api.del('/api/push/subscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
  }

  /* Native shell (Capacitor): register the device with Firebase and hand the token to the server. */
  async function enableNativePush() {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!plugin) { toast('Push is not available in this build', 'error'); return false; }
    const perm = await plugin.requestPermissions();
    if (perm.receive !== 'granted') { toast('Notifications are off for Inkwell in your phone settings', 'error'); return false; }
    await plugin.register();
    return true;
  }

  function setupNativeBridge() {
    if (!isNative()) return;
    document.documentElement.classList.add('native');
    const plugins = window.Capacitor.Plugins || {};
    if (plugins.PushNotifications) {
      plugins.PushNotifications.addListener('registration', (token) => {
        if (state.user) api.post('/api/push/subscribe', { kind: 'fcm', token: token.value, device_name: window.Capacitor.getPlatform() }).catch(() => {});
      });
      plugins.PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const url = action.notification && action.notification.data && action.notification.data.url;
        if (url) navigate(url);
      });
    }
    if (plugins.App) {
      plugins.App.addListener('appUrlOpen', (event) => {
        try { const u = new URL(event.url); navigate(u.pathname + u.search); } catch { /* ignore */ }
      });
      plugins.App.addListener('backButton', ({ canGoBack }) => { if (canGoBack) history.back(); else plugins.App.exitApp(); });
    }
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
      ${!isStandalone() && !isNative() && (state.installPrompt || isIOS()) && !localStorage.getItem('inkwell_install_dismissed') ? `
      <div class="install-banner" data-install-banner>
        <img src="/icon-192.png" alt="" width="44" height="44">
        <div><strong>Get the Inkwell app</strong><div class="small muted">Add it to your home screen for full-screen browsing and notifications.</div></div>
        <button class="btn btn--sm" data-install>Install</button>
        <button class="modal__close" data-install-dismiss aria-label="Dismiss">×</button>
      </div>` : ''}
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

    const banner = $('[data-install-banner]');
    if (banner) {
      $('[data-install]', banner).addEventListener('click', promptInstall);
      $('[data-install-dismiss]', banner).addEventListener('click', () => { try { localStorage.setItem('inkwell_install_dismissed', '1'); } catch { /* ignore */ } banner.remove(); });
    }
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
            ${artist.replies_within ? `<span>${esc(artist.replies_within)}</span>` : ''}
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
            <span data-waitlist-btn></span>
            <a class="btn btn--ghost" href="/messages/${artist.id}">Message</a>
            ${!me || me.role === 'client' ? `<a class="btn" href="/book/${artist.id}">Book a session</a>` : ''}
            ${me ? '<button class="link small" data-report-user>Report</button>' : ''}`}
          ${shareButton({ title: `${artist.name} on Inkwell`, text: `${artist.name}${artist.studio_name ? ` · ${artist.studio_name}` : ''}: galleries, reviews and booking on Inkwell`, path: `/artists/${artist.id}`, card: `/og/artists/${artist.id}.png` })}
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
      <section class="section" data-flash-section hidden></section>
      <section class="section">
        <div class="section__head"><h2>Recent work</h2></div>
        ${work.artworks.length ? `<div class="grid-art">${work.artworks.map(artCard).join('')}</div>` : '<div class="empty"><p>No pieces shared yet.</p></div>'}
      </section>
      <section class="section" data-reviews></section>`;
    reviewsSection($('[data-reviews]'), artist, reviews, () => viewArtist(id));
    bindShare();
    renderWaitlistButton($('[data-waitlist-btn]'), artist);
    api.get('/api/flash', { artist_id: artist.id, limit: 12 }).then(({ flash }) => {
      const el = $('[data-flash-section]');
      if (!el || !flash.length) return;
      el.hidden = false;
      el.innerHTML = `<div class="section__head"><h2>Flash</h2><a class="link" href="/flash?artist_id=${artist.id}">Ready to book, fixed price</a></div><div class="grid-art">${flash.map((f) => flashCard(f)).join('')}</div>`;
    }).catch(() => {});
    const reportUser = $('[data-report-user]');
    if (reportUser) reportUser.addEventListener('click', () => reportModal('user', artist.id, 'artist'));
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
        <div class="row">${shareButton({ title: `${gallery.title} by ${gallery.artist_name}`, text: `${gallery.title}, a gallery by ${gallery.artist_name} on Inkwell`, path: `/galleries/${gallery.id}`, card: `/og/galleries/${gallery.id}.png` })}${isOwner ? '<button class="btn" data-upload>Upload artwork</button><button class="btn btn--ghost" data-edit>Edit</button><button class="btn btn--danger" data-delete>Delete gallery</button>' : ''}</div>
      </div>
      ${gallery.artworks.length ? `<div class="grid-art">${gallery.artworks.map(artCard).join('')}</div>` : `<div class="empty"><h3>This gallery is empty</h3>${isOwner ? '<p>Upload your first piece to get started.</p>' : ''}</div>`}`;

    bindShare();
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

  async function viewNewRequest(params) {
    if (!requireLogin('/requests/new')) return;
    if (state.user.role !== 'client') { main.innerHTML = '<div class="empty"><h3>Only clients can post requests</h3><p>Browse <a class="link" href="/requests">open requests</a> instead.</p></div>'; return; }
    loading();
    let boards = [];
    try { ({ collections: boards } = await api.get('/api/collections')); } catch { boards = []; }
    const preset = params ? params.get('board') : null;
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
          <div class="field"><label>Reference board (optional)</label><select name="collection_id"><option value="">None</option>${boards.map((c) => `<option value="${c.id}" ${String(c.id) === String(preset) ? 'selected' : ''}>${esc(c.title)} (${c.item_count})</option>`).join('')}</select><span class="hint">${boards.length ? 'Attaching a board makes it viewable by anyone with the link, so artists can open it.' : 'Save tattoos you like into a board and attach it here so artists see your taste.'}</span></div>
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
          ${request.collection ? `<a class="board board--inline" href="/c/${attr(request.collection.token)}"><div class="board__cover">${request.collection.cover_url ? `<img src="${attr(request.collection.cover_url)}" alt="">` : ''}</div><div class="board__body"><span class="small muted">Reference board</span><strong>${esc(request.collection.title)}</strong><span class="small muted">${request.collection.item_count} saved piece${request.collection.item_count === 1 ? '' : 's'} · open board</span></div></a>` : ''}
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
    const flashId = params.get('flash') || '';
    let flashDesign = null;
    if (flashId) { try { ({ flash: flashDesign } = await api.get(`/api/flash/${flashId}`)); } catch { flashDesign = null; } if (flashDesign && (!flashDesign.available || flashDesign.artist_id !== artist.id)) flashDesign = null; }
    const days = [];
    for (let i = 0; i < 28; i += 1) {
      const d = new Date(); d.setDate(d.getDate() + i);
      days.push(d);
    }
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const wantedDate = params.get('date') || '';
    let selectedDate = days.find((d) => iso(d) === wantedDate && openDays.has(d.getDay())) || days.find((d) => openDays.has(d.getDay()));
    let selectedSlot = null;
    let autoAdvancing = !wantedDate;

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
            <div class="row" style="margin-top:14px"><span class="small muted">Nothing that works?</span><span data-waitlist-btn></span></div>
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
            ${flashDesign ? `<hr class="divider" style="margin:14px 0"><a class="board board--inline flash-pick" href="/flash/${flashDesign.id}"><div class="board__cover"><img src="${attr(flashDesign.thumb_url || flashDesign.image_url)}" alt=""></div><div class="board__body"><span class="small muted">Flash design</span><strong>${esc(flashDesign.title)}</strong><span class="small muted">${money(flashDesign.price)} fixed price · ${flashDesign.repeatable ? 'repeatable' : 'one-off, yours once you book'}</span></div></a>` : (flashId ? '<hr class="divider" style="margin:14px 0"><div class="error">That flash design is no longer available. You can still book a regular session.</div>' : '')}
            <hr class="divider" style="margin:14px 0">
            <div class="small muted">Studio hours</div>
            ${avail.availability.map((w) => `<div class="row row--between small"><span>${WEEKDAYS[w.weekday]}</span><span>${w.start_time} – ${w.end_time}</span></div>`).join('') || '<div class="small faint">Not published</div>'}
            <p class="small faint" style="margin-top:14px">${avail.deposit_amount
              ? `A ${money(avail.deposit_amount)} deposit holds your slot and is paid right after you book. It is refunded in full if the artist declines or if you cancel at least ${avail.refund_window_hours || state.pay.refund_window_hours} hours ahead. The remaining balance is settled after the session.`
              : 'This artist does not take a deposit. Payment is settled after the session.'}</p>
          </div>
        </aside>
      </div>`;

    renderWaitlistButton($('[data-waitlist-btn]'), artist, { flash: flashDesign });
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
        slotsEl.innerHTML = r.slots.length ? r.slots.map((s) => `<button type="button" class="slot ${s.busy ? 'slot--busy' : ''}" data-slot="${attr(s.starts_at)}" ${s.available ? '' : 'disabled'} ${s.busy ? 'title="The artist is busy then"' : ''}>${fmtTime(s.starts_at)}</button>`).join('') : '<p class="faint">No sessions on this day.</p>';
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
        await api.post('/api/appointments', { artist_id: artist.id, starts_at: selectedSlot, note: e.target.note.value, request_id: requestId || undefined, flash_id: flashDesign ? flashDesign.id : undefined });
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
    if (a.consent && a.consent.signed_at) actions.push(`<a class="btn btn--ghost btn--sm" href="/appointments/${a.id}/consent">View consent</a>`);
    else if (a.consent && !isArtist && ['pending', 'confirmed'].includes(a.status)) actions.unshift(`<a class="btn btn--sm ${a.consent.required ? '' : 'btn--subtle'}" href="/appointments/${a.id}/consent">Sign consent form</a>`);
    actions.push(`<a class="btn btn--ghost btn--sm" href="/messages/${other.id}">Message</a>`);
    if (a.calendar) actions.push(`<details class="menu"><summary class="btn btn--ghost btn--sm">Add to calendar</summary><div class="menu__list"><a class="menu__item" href="${attr(a.calendar.google)}" target="_blank" rel="noopener">Google Calendar</a><a class="menu__item" href="${attr(a.calendar.outlook)}" target="_blank" rel="noopener">Outlook.com</a><a class="menu__item" href="${attr(a.calendar.ics)}" download rel="external">Apple / other (.ics)</a><a class="menu__item" href="/settings#calendar">Subscribe to all sessions</a></div></details>`);
    if (!isArtist && ['pending', 'confirmed', 'completed'].includes(a.status)) {
      (a.payments || []).filter((p) => p.status === 'pending').forEach((p) => actions.unshift(
        `<button class="btn btn--sm" data-pay="${p.id}" data-amount="${p.amount}" data-kind="${p.kind}">Pay ${money(p.amount)} ${p.kind}</button>`,
      ));
    }
    return `
      <div class="card appt">
        <div class="appt__date"><span>${d.toLocaleDateString(undefined, { month: 'short' })}</span><strong>${d.getDate()}</strong><span>${d.toLocaleDateString(undefined, { weekday: 'short' })}</span></div>
        <div>
          <div class="row"><strong>${fmtTime(a.starts_at)} – ${fmtTime(a.ends_at)}</strong>${pill(a.status)}${consentBadge(a)}</div>
          <div class="row" style="margin-top:6px">${avatar(other.avatar, other.name, 'avatar--xs')}<a href="/artists/${isArtist ? me.id : a.artist_id}"><strong>${esc(other.name)}</strong></a><span class="muted small">${esc(other.label)}</span></div>
          ${a.request_title ? `<div class="small muted" style="margin-top:4px">For request: <a class="link" href="/requests/${a.request_id}">${esc(a.request_title)}</a></div>` : ''}
          ${a.flash_title ? `<a class="appt__flash" href="/flash/${a.flash_id}"><img src="${attr(a.flash_thumb_url || a.flash_image_url)}" alt=""><span>Flash: <strong>${esc(a.flash_title)}</strong> · ${money(a.flash_price)}</span></a>` : ''}
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
    $$('[data-review-appt]', root).forEach((b) => b.addEventListener('click', () => reviewModal({ appointmentId: b.dataset.reviewAppt }, reload)));
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
        try {
          await api.post(`/api/appointments/${id}/complete`, { price: form.price.value });
        } catch (err) {
          if (!(err.data && err.data.consent_missing) || !confirm(`${err.message}\n\nComplete the session without a signed form?`)) throw err;
          await api.post(`/api/appointments/${id}/complete`, { price: form.price.value, skip_consent: true });
        }
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

  async function viewAppointments(params) {
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
      ${!isArtist ? '<section class="section" data-waitlist-section></section>' : ''}
      <section class="section"><div class="section__head"><h2>Past &amp; closed</h2></div>
        <div class="stack">${past.length ? past.map(apptCard).join('') : '<p class="faint">No history yet.</p>'}</div>
      </section>`;
    bindApptActions(main, viewAppointments);
    renderClientWaitlist($('[data-waitlist-section]'));
    const wanted = params && params.get('review');
    if (wanted && !isArtist) {
      const appt = list.find((a) => String(a.id) === String(wanted));
      history.replaceState({}, '', '/appointments');
      if (appt && appt.status === 'completed' && !appt.review_id) reviewModal({ appointmentId: appt.id }, () => viewAppointments());
    }
  }

  /* ---------- waitlist ---------- */

  function waitlistModal(artist, { flash = null } = {}, onDone) {
    const today = new Date().toISOString().slice(0, 10);
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Join ${esc(artist.name.split(' ')[0])}'s waitlist</h3><p class="small muted" style="margin:4px 0 0">You hear first when a slot frees up or the books reopen. It goes to whoever books it.</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          ${flash ? `<div class="board board--inline flash-pick" style="margin:0 0 12px"><div class="board__cover"><img src="${attr(flash.thumb_url || flash.image_url)}" alt=""></div><div class="board__body"><span class="small muted">For the flash design</span><strong>${esc(flash.title)}</strong></div></div>` : ''}
          <div class="form-row">
            <div class="field"><label>From (optional)</label><input name="from_date" type="date" min="${today}"></div>
            <div class="field"><label>Until (optional)</label><input name="to_date" type="date" min="${today}"></div>
          </div>
          <div class="field"><label>Note for ${esc(artist.name.split(' ')[0])} (optional)</label><textarea name="note" maxlength="500" placeholder="What you want, how flexible you are, weekday evenings only..."></textarea></div>
          <button class="btn btn--block">Join the waitlist</button>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api.post('/api/waitlist', { artist_id: artist.id, flash_id: flash ? flash.id : undefined, from_date: form.from_date.value || undefined, to_date: form.to_date.value || undefined, note: form.note.value });
        closeModal(); toast('You are on the waitlist'); if (onDone) onDone(r.entry);
      } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  /** Button for profiles and booking pages: join, or leave if already waiting. */
  async function renderWaitlistButton(el, artist, { flash = null } = {}) {
    if (!el) return;
    const me = state.user;
    if (!me || me.role !== 'client') return;
    let entry = null;
    try { ({ entry } = await api.get(`/api/waitlist/artists/${artist.id}`)); } catch { entry = null; }
    const render = () => {
      el.innerHTML = entry
        ? `<span class="waitlist-state">On the waitlist${entry.status === 'notified' ? ' · you have been told about a slot' : ''} <button type="button" class="link small" data-leave-waitlist>Leave</button></span>`
        : `<button type="button" class="btn btn--ghost btn--sm" data-join-waitlist>${artist.accepting_clients === false ? 'Join the waitlist' : 'Waitlist for cancellations'}</button>`;
      const join = $('[data-join-waitlist]', el);
      if (join) join.addEventListener('click', () => waitlistModal(artist, { flash }, (created) => { entry = created; render(); }));
      const leave = $('[data-leave-waitlist]', el);
      if (leave) leave.addEventListener('click', async () => { try { await api.del(`/api/waitlist/${entry.id}`); entry = null; toast('Left the waitlist'); render(); } catch (err) { handleError(err); } });
    };
    render();
  }

  function waitlistEntryHtml(w, { artistView }) {
    const who = artistView ? { name: w.client_name, avatar: w.client_avatar_url, sub: w.client_location || 'Client' } : { name: w.artist_name, avatar: w.artist_avatar_url, sub: w.studio_name || 'Artist' };
    const window = w.from_date || w.to_date ? `${w.from_date || 'Now'} → ${w.to_date || 'any time'}` : 'Any time';
    return `<div class="card waitlist-entry" data-entry="${w.id}">
      <div class="row">${avatar(who.avatar, who.name, 'avatar--sm')}<div>${artistView ? `<strong>${esc(who.name)}</strong>` : `<a href="/artists/${w.artist_id}"><strong>${esc(who.name)}</strong></a>`}<div class="small muted">${esc(who.sub)} · joined ${timeAgo(w.created_at)}</div></div></div>
      <div class="small" style="margin-top:8px"><span class="tag">${esc(window)}</span>${w.flash_title ? `<a class="tag" href="/flash/${w.flash_id}">Flash: ${esc(w.flash_title)}</a>` : ''}${w.status === 'notified' ? `<span class="tag" title="${attr(w.notified_at || '')}">told ${w.notify_count}×, last ${timeAgo(w.notified_at)}</span>` : ''}</div>
      ${w.note ? `<p class="small muted" style="margin:8px 0 0">${esc(w.note)}</p>` : ''}
      <div class="row" style="margin-top:10px">
        ${artistView ? `<button class="btn btn--sm" data-invite="${w.id}">Invite to book</button><a class="btn btn--ghost btn--sm" href="/messages/${w.client_id}">Message</a><button class="link small" data-remove-entry="${w.id}">Remove</button>` : `<a class="btn btn--sm" href="/book/${w.artist_id}${w.flash_id ? `?flash=${w.flash_id}` : ''}">Check for slots</a><button class="link small" data-remove-entry="${w.id}">Leave</button>`}
      </div>
    </div>`;
  }

  function bindWaitlistEntries(root, reload) {
    $$('[data-remove-entry]', root).forEach((b) => b.addEventListener('click', async () => {
      try { await api.del(`/api/waitlist/${b.dataset.removeEntry}`); toast('Removed'); reload(); } catch (err) { handleError(err); }
    }));
    $$('[data-invite]', root).forEach((b) => b.addEventListener('click', () => {
      const modal = openModal(`<div class="modal__panel"><div class="modal__head"><h3 style="margin:0">Invite to book</h3><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form><div class="error" hidden></div><div class="field"><label>Message (optional)</label><textarea name="message" maxlength="500" placeholder="I have Thursday afternoons open next month."></textarea></div><button class="btn btn--block">Send invite</button></form></div>`, { small: true });
      $('[data-form]', modal).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api.post(`/api/waitlist/${b.dataset.invite}/invite`, { message: e.target.message.value }); closeModal(); toast('Invite sent'); reload(); } catch (err) { handleError(err, $('.error', e.target)); }
      });
    }));
  }

  /** Client: waitlist section on the bookings page. */
  async function renderClientWaitlist(el) {
    if (!el) return;
    let entries;
    try { ({ entries } = await api.get('/api/waitlist')); } catch { el.innerHTML = ''; return; }
    if (!entries.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="section__head"><h2>Waitlists</h2><span class="muted small">You hear first when a slot frees up</span></div><div class="grid grid--2">${entries.map((w) => waitlistEntryHtml(w, { artistView: false })).join('')}</div>`;
    bindWaitlistEntries(el, () => renderClientWaitlist(el));
  }

  /* ---------- stencil library ---------- */

  const STENCIL_SOURCES = { artwork: 'From a gallery piece', flash: 'From flash', upload: 'Uploaded' };

  function stencilCard(s) {
    const src = STENCIL_SOURCES[s.source_type] || s.source_type;
    const link = s.source_link;
    const body = s.status === 'ready'
      ? `<img src="${attr(s.thumb_url)}" alt="${attr(s.title)}" loading="lazy" ${s.width && s.height ? `width="${s.width}" height="${s.height}"` : ''}>`
      : `<div class="stencil-card__state"><img src="${attr(s.source_url)}" alt="" loading="lazy"><span class="pill pill--${s.status === 'failed' ? 'declined' : 'pending'}">${s.status === 'failed' ? 'Could not trace' : 'Tracing'}</span></div>`;
    return `<div class="art stencil-card ${s.status !== 'ready' ? 'stencil-card--waiting' : ''}" data-stencil="${s.id}">
      <button class="stencil-card__fav ${s.favorite ? 'active' : ''}" data-fav="${s.id}" aria-label="${s.favorite ? 'Remove from favourites' : 'Add to favourites'}" title="Favourite">${s.favorite ? '★' : '☆'}</button>
      <div class="stencil-card__img" data-open="${s.id}">${body}</div>
      <div class="art__body">
        <div class="art__title"><span>${esc(s.title)}</span><span class="small muted">detail ${s.detail}</span></div>
        <div class="art__meta">${link ? `<a class="tag" href="${link}">${src}</a>` : `<span class="tag">${src}</span>`}${s.status === 'ready' && s.width ? `<span>${s.width}×${s.height}</span>` : ''}</div>
        ${s.status === 'failed' ? `<p class="small" style="margin:8px 0 0;color:var(--accent)">${esc(s.error || 'Tracing failed.')}</p>` : ''}
        <div class="row stencil-card__actions">
          ${s.status === 'ready' ? `<button class="btn btn--sm" data-download="${s.id}">Download</button>` : ''}
          <button class="btn btn--ghost btn--sm" data-open="${s.id}">${s.status === 'ready' ? 'Adjust' : 'Retry'}</button>
        </div>
      </div>
    </div>`;
  }

  /** Print-size download: choose a width or height in cm and whether to mirror for transfer paper. */
  function stencilDownloadModal(s) {
    const ratio = s.width && s.height ? s.height / s.width : 1.25;
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Download at print size</h3><p class="small muted" style="margin:4px 0 0">${esc(s.title)} · 300 dpi PNG, black lines on white.</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <form class="form modal__body" data-form>
          <div class="form-row">
            <div class="field"><label>Width (cm)</label><input name="width_cm" type="number" min="1" max="50" step="0.5" value="10"></div>
            <div class="field"><label>Height (cm)</label><input name="height_cm" type="number" min="1" max="50" step="0.5" value="${(10 * ratio).toFixed(1)}"></div>
          </div>
          <span class="hint">The design keeps its proportions; whichever side is tighter wins.</span>
          <label class="check"><input type="checkbox" name="mirror" checked> Mirror for thermal transfer paper</label>
          <label class="check"><input type="checkbox" name="transparent"> Transparent background instead of white</label>
          <div class="stencil-print-preview"><img src="${attr(s.thumb_url)}" alt="" data-preview style="transform:scaleX(-1)"></div>
          <a class="btn btn--block" data-print-link href="${attr(s.print_url)}" download>Download PNG</a>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    const link = $('[data-print-link]', modal);
    const preview = $('[data-preview]', modal);
    let lock = false;
    const sync = () => {
      const p = new URLSearchParams();
      if (Number(form.width_cm.value) > 0) p.set('width_cm', form.width_cm.value);
      if (Number(form.height_cm.value) > 0) p.set('height_cm', form.height_cm.value);
      if (form.mirror.checked) p.set('mirror', '1');
      if (form.transparent.checked) p.set('transparent', '1');
      link.href = `${s.print_url}?${p}`;
      preview.style.transform = form.mirror.checked ? 'scaleX(-1)' : '';
      const w = Number(form.width_cm.value) || 0;
      link.textContent = `Download PNG${w ? ` · ${w} cm wide` : ''}${form.mirror.checked ? ', mirrored' : ''}`;
    };
    form.width_cm.addEventListener('input', () => { if (lock) return; lock = true; form.height_cm.value = (Number(form.width_cm.value) * ratio).toFixed(1); lock = false; sync(); });
    form.height_cm.addEventListener('input', () => { if (lock) return; lock = true; form.width_cm.value = (Number(form.height_cm.value) / ratio).toFixed(1); lock = false; sync(); });
    form.addEventListener('change', sync);
    form.addEventListener('submit', (e) => { e.preventDefault(); link.click(); });
    link.addEventListener('click', () => toast('Preparing your stencil'));
    sync();
  }

  /** One stencil: full preview, rename, detail level, regenerate, delete. */
  function stencilModal(s, levels, onChange) {
    const modal = openModal(`
      <div class="modal__panel stencil-modal">
        <div class="modal__head"><div><h3 style="margin:0" data-title>${esc(s.title)}</h3><p class="small muted" style="margin:4px 0 0">${esc(STENCIL_SOURCES[s.source_type] || '')}${s.generated_at ? ` · traced ${timeAgo(s.generated_at)}` : ''}</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <div class="modal__body stencil-modal__body">
          <div class="stencil-modal__preview" data-preview>
            ${s.status === 'ready' ? `<img src="${attr(s.image_url)}" alt="${attr(s.title)}">` : `<div class="stencil-modal__state"><img src="${attr(s.source_url)}" alt=""><p class="small ${s.status === 'failed' ? '' : 'muted'}">${esc(s.status === 'failed' ? (s.error || 'Tracing failed.') : 'Still tracing. This takes a moment.')}</p></div>`}
          </div>
          <form class="form stencil-modal__side" data-form>
            <div class="error" hidden></div>
            <div class="field"><label>Name</label><input name="title" value="${attr(s.title)}" maxlength="120" required></div>
            <div class="field"><label>Detail level</label>
              <div class="chips" data-levels>${levels.map((l) => `<button type="button" class="chip ${l === s.detail ? 'active' : ''}" data-level="${l}">${l}</button>`).join('')}</div>
              <span class="hint">1 keeps only the boldest outlines; 5 traces fine lines and texture. Changing it re-traces the piece.</span>
            </div>
            <div class="row" style="flex-wrap:wrap;gap:8px">
              <button class="btn btn--sm">Save name</button>
              ${s.status === 'ready' ? `<button type="button" class="btn btn--ghost btn--sm" data-download>Download</button>` : ''}
              <button type="button" class="btn btn--ghost btn--sm" data-regen>${s.status === 'failed' ? 'Try again' : 'Re-trace'}</button>
              <button type="button" class="link small" data-delete>Delete stencil</button>
            </div>
            <p class="small faint" style="margin:0">Stencils are traced from the original image and never change it. Prints at 300 dpi.</p>
          </form>
        </div>
      </div>`);
    const form = $('[data-form]', modal);
    const busy = (on) => { $$('button', form).forEach((b) => { b.disabled = on; }); if (on) $('[data-preview]', modal).classList.add('is-busy'); };
    const swap = (next) => { closeModal({ silent: true }); onChange(next); stencilModal(next, levels, onChange); };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { const r = await api.put(`/api/stencils/${s.id}`, { title: form.title.value }); $('[data-title]', modal).textContent = r.stencil.title; toast('Renamed'); onChange(r.stencil); } catch (err) { handleError(err, $('.error', form)); }
    });
    $$('[data-level]', form).forEach((b) => b.addEventListener('click', async () => {
      const level = Number(b.dataset.level);
      if (level === s.detail) return;
      busy(true);
      try { const r = await api.put(`/api/stencils/${s.id}`, { detail: level }); toast(r.stencil.status === 'ready' ? `Re-traced at detail ${level}` : 'Could not trace at that level'); swap(r.stencil); } catch (err) { busy(false); handleError(err, $('.error', form)); }
    }));
    $('[data-regen]', form).addEventListener('click', async () => {
      busy(true);
      try { const r = await api.post(`/api/stencils/${s.id}/regenerate`); toast(r.stencil.status === 'ready' ? 'Re-traced' : 'Still could not trace it'); swap(r.stencil); } catch (err) { busy(false); handleError(err, $('.error', form)); }
    });
    const dl = $('[data-download]', form);
    if (dl) dl.addEventListener('click', () => { closeModal({ silent: true }); stencilDownloadModal(s); });
    $('[data-delete]', form).addEventListener('click', async () => {
      if (!window.confirm('Delete this stencil? The original piece is not affected.')) return;
      try { await api.del(`/api/stencils/${s.id}`); closeModal({ silent: true }); toast('Stencil deleted'); onChange(null, s.id); } catch (err) { handleError(err, $('.error', form)); }
    });
  }

  function stencilUploadModal(levels, onDone) {
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Trace an image</h3><p class="small muted" style="margin:4px 0 0">A drawing, a photo of a sketch, a reference. It joins the library as a stencil.</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          <div class="field"><label>Image</label><input type="file" name="image" accept="image/*" required><span class="hint">JPEG, PNG, WebP or GIF up to 8 MB. Flat, well-lit images trace best.</span></div>
          <div class="field"><label>Name</label><input name="title" maxlength="120" placeholder="Snake and dagger sketch"></div>
          <div class="field"><label>Detail level</label><div class="chips" data-levels>${levels.map((l) => `<button type="button" class="chip ${l === 3 ? 'active' : ''}" data-level="${l}">${l}</button>`).join('')}</div></div>
          <button class="btn btn--block">Trace it</button>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    let level = 3;
    $$('[data-level]', form).forEach((b) => b.addEventListener('click', () => { level = Number(b.dataset.level); $$('[data-level]', form).forEach((x) => x.classList.toggle('active', x === b)); }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('image', form.image.files[0]);
      fd.append('title', form.title.value);
      fd.append('detail', String(level));
      const btn = form.querySelector('button.btn');
      btn.disabled = true; btn.textContent = 'Tracing…';
      try { const r = await api.post('/api/stencils', fd); closeModal(); toast(r.stencil.status === 'ready' ? 'Stencil ready' : 'Added, but it could not be traced'); onDone(r.stencil); } catch (err) { handleError(err, $('.error', form)); btn.disabled = false; btn.textContent = 'Trace it'; }
    });
  }

  /** Dashboard tab: the artist's stencil library. */
  function renderStencilLibrary(panel) {
    const filter = { source: '', favorites: false };
    let data = null;
    let pollTimer = null;
    const load = async () => {
      try { data = await api.get('/api/stencils', { source: filter.source || undefined, favorites: filter.favorites ? '1' : undefined }); } catch (err) { return handleError(err); }
      draw();
      clearTimeout(pollTimer);
      if (data.counts.pending && panel.isConnected) pollTimer = setTimeout(load, 2500);
    };
    const patch = (next, removedId) => {
      if (!data) return load();
      if (removedId) data.stencils = data.stencils.filter((x) => x.id !== removedId);
      else if (next) { const i = data.stencils.findIndex((x) => x.id === next.id); if (i >= 0) data.stencils[i] = next; else data.stencils.unshift(next); }
      load();
    };
    const draw = () => {
      const { stencils, counts, levels } = data;
      const chip = (label, active, attrs) => `<button type="button" class="chip ${active ? 'active' : ''}" ${attrs}>${label}</button>`;
      panel.innerHTML = `
        <div class="section__head"><h2>Stencil library</h2><div class="row"><button class="btn btn--ghost btn--sm" data-backfill>Trace missing pieces</button><button class="btn btn--sm" data-upload>Trace an image</button></div></div>
        <p class="small muted" style="margin-top:-6px">Every piece you upload to a gallery or the flash board is traced into a line stencil in the background, so the library fills itself. Download at real size, mirrored for transfer paper.</p>
        <div class="stencil-toolbar">
          <div class="chips" data-filters>
            ${chip(`All <span class="muted">${counts.total}</span>`, !filter.source && !filter.favorites, 'data-source=""')}
            ${chip('Gallery pieces', filter.source === 'artwork', 'data-source="artwork"')}
            ${chip('Flash', filter.source === 'flash', 'data-source="flash"')}
            ${chip('Uploaded', filter.source === 'upload', 'data-source="upload"')}
            ${chip(`★ Favourites <span class="muted">${counts.favorites}</span>`, filter.favorites, 'data-favorites')}
          </div>
          <span class="small muted" data-status>${counts.pending ? `${counts.pending} tracing…` : `${counts.ready} ready`}${counts.failed ? ` · ${counts.failed} could not be traced` : ''}</span>
        </div>
        ${stencils.length ? `<div class="grid-art stencil-grid">${stencils.map(stencilCard).join('')}</div>` : `<div class="empty"><h3>${counts.total ? 'Nothing here' : 'No stencils yet'}</h3><p>${counts.total ? 'Try another filter.' : 'Upload a piece to a gallery, post flash, or trace an image directly. Pieces uploaded before the library existed are traced by the scheduler; "Trace missing pieces" does it now.'}</p></div>`}`;
      $$('[data-source]', panel).forEach((b) => b.addEventListener('click', () => { filter.source = b.dataset.source; filter.favorites = false; load(); }));
      $('[data-favorites]', panel).addEventListener('click', () => { filter.favorites = !filter.favorites; filter.source = ''; load(); });
      $('[data-upload]', panel).addEventListener('click', () => stencilUploadModal(levels, (s) => patch(s)));
      $('[data-backfill]', panel).addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = 'Tracing…';
        try { const r = await api.post('/api/stencils/backfill'); toast(r.queued ? `Traced ${r.processed} of ${r.queued} pieces` : 'Every piece already has a stencil'); } catch (err) { handleError(err); }
        load();
      });
      $$('[data-fav]', panel).forEach((b) => b.addEventListener('click', async () => {
        const s = stencils.find((x) => x.id === Number(b.dataset.fav));
        try { const r = await api.put(`/api/stencils/${s.id}`, { favorite: !s.favorite }); toast(r.stencil.favorite ? 'Added to favourites' : 'Removed from favourites'); patch(r.stencil); } catch (err) { handleError(err); }
      }));
      $$('[data-download]', panel).forEach((b) => b.addEventListener('click', () => stencilDownloadModal(stencils.find((x) => x.id === Number(b.dataset.download)))));
      $$('[data-open]', panel).forEach((b) => b.addEventListener('click', () => stencilModal(stencils.find((x) => x.id === Number(b.dataset.open)), levels, patch)));
    };
    panel.innerHTML = '<div class="loading">Loading</div>';
    load();
  }

  /* ---------- flash designs ---------- */

  function flashCard(f, { manage = false } = {}) {
    const statusPill = f.status === 'available' ? '' : `<span class="pill pill--${f.status === 'claimed' ? 'pending' : (f.status === 'sold' ? 'completed' : 'closed')}">${esc(f.status)}</span>`;
    return `<a class="art flash-card" href="/flash/${f.id}">
      <img src="${attr(f.thumb_url || f.image_url)}" alt="${attr(f.title)}" loading="lazy" ${f.width && f.height ? `width="${f.width}" height="${f.height}"` : ''}>
      <div class="art__body">
        <div class="art__title"><span>${esc(f.title)}</span><span class="flash-card__price">${money(f.price)}</span></div>
        <div class="art__meta">${manage ? statusPill || '<span class="pill pill--open">available</span>' : `${avatar(f.artist_avatar_url, f.artist_name, 'avatar--xs')}<span>${esc(f.artist_name)}</span>`}${f.style ? `<span class="tag">${esc(f.style)}</span>` : ''}${f.repeatable ? '<span class="tag" title="Can be tattooed more than once">repeatable</span>' : '<span class="tag" title="Only one person gets this design">one-off</span>'}</div>
      </div>
    </a>`;
  }

  async function viewFlashBoard(params) {
    loading();
    const filters = { style: params.get('style') || '', max_price: params.get('max_price') || '', sort: params.get('sort') || 'newest' };
    let data;
    try { data = await api.get('/api/flash', filters); } catch (e) { return handleError(e); }
    const me = state.user;
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Flash</h1><p class="muted">Pre-drawn designs at a fixed price. Pick one, book a slot, done. One-off designs go to the first person who books.</p></div>
        ${me && me.role === 'artist' ? '<a class="btn" href="/dashboard?tab=flash">Manage your flash</a>' : ''}
      </div>
      <form class="filters" data-filters>
        <select name="style" aria-label="Style">${styleOptions(filters.style, true)}</select>
        <select name="max_price" aria-label="Maximum price">
          <option value="">Any price</option>
          ${[150, 250, 400, 600, 1000].map((p) => `<option value="${p}" ${String(p) === filters.max_price ? 'selected' : ''}>Up to ${money(p)}</option>`).join('')}
        </select>
        <select name="sort" aria-label="Sort">
          <option value="newest" ${filters.sort === 'newest' ? 'selected' : ''}>Newest</option>
          <option value="price_asc" ${filters.sort === 'price_asc' ? 'selected' : ''}>Price: low to high</option>
          <option value="price_desc" ${filters.sort === 'price_desc' ? 'selected' : ''}>Price: high to low</option>
        </select>
      </form>
      ${data.flash.length ? `<div class="grid-art">${data.flash.map((f) => flashCard(f)).join('')}</div>` : '<div class="empty"><h3>Nothing on the board right now</h3><p>Try another style or price, or follow artists to hear when they post new flash.</p></div>'}`;
    $('[data-filters]').addEventListener('change', (e) => {
      const p = new URLSearchParams();
      ['style', 'max_price', 'sort'].forEach((k) => { const v = e.currentTarget[k].value; if (v && !(k === 'sort' && v === 'newest')) p.set(k, v); });
      navigate(`/flash${p.toString() ? `?${p}` : ''}`);
    });
  }

  function flashEditorHtml(f = {}) {
    const sizes = ['Tiny (under 2 in)', 'Small (2-4 in)', 'Medium (4-6 in)', 'Large (6-10 in)', 'Extra large'];
    return `
      <div class="error" hidden></div>
      ${f.id ? '' : '<div class="field"><label>Design image</label><input type="file" name="image" accept="image/*" required><span class="hint">JPEG, PNG, WebP or GIF up to 8 MB.</span></div>'}
      <div class="field"><label>Title</label><input name="title" value="${attr(f.title || '')}" placeholder="Moth & moon" required maxlength="100"></div>
      <div class="form-row">
        <div class="field"><label>Price ($)</label><input name="price" type="number" min="0" step="1" value="${attr(f.price ?? '')}" required></div>
        <div class="field"><label>Size</label><select name="size_label"><option value="">Not set</option>${sizes.map((s) => `<option ${f.size_label === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Style</label><select name="style">${styleOptions(f.style || '', true)}</select></div>
      <div class="field"><label>Notes</label><textarea name="description" placeholder="Placement it suits, sittings, what is included">${esc(f.description || '')}</textarea></div>
      <label class="check"><input type="checkbox" name="repeatable" ${f.repeatable ? 'checked' : ''}> Repeatable: more than one person can get this design</label>
      ${f.id ? `<label class="check"><input type="checkbox" name="hidden" ${f.status === 'hidden' ? 'checked' : ''} ${f.status === 'claimed' ? 'disabled' : ''}> Hide from the board</label>` : ''}`;
  }

  function flashPayload(form) {
    return { title: form.title.value, price: Number(form.price.value), size_label: form.size_label.value, style: form.style.value, description: form.description.value, repeatable: form.repeatable.checked, status: form.hidden && form.hidden.checked ? 'hidden' : (form.hidden ? 'available' : undefined) };
  }

  function newFlashModal(onDone) {
    const modal = openModal(`<div class="modal__panel"><div class="modal__head"><h3 style="margin:0">New flash design</h3><button class="modal__close" data-close-modal>×</button></div>
      <form class="form modal__body" data-form>${flashEditorHtml()}<button class="btn btn--block">Post to the board</button></form></div>`, { small: true });
    const form = $('[data-form]', modal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('image', form.image.files[0]);
      Object.entries(flashPayload(form)).forEach(([k, v]) => { if (v !== undefined) fd.append(k, v); });
      form.querySelector('button.btn').disabled = true;
      try { const r = await api.post('/api/flash', fd); closeModal(); toast('Flash posted'); onDone(r.flash); } catch (err) { handleError(err, $('.error', form)); form.querySelector('button.btn').disabled = false; }
    });
  }

  async function viewFlash(id) {
    loading();
    let f;
    try { ({ flash: f } = await api.get(`/api/flash/${id}`)); } catch (e) { main.innerHTML = '<div class="empty"><h3>Design not found</h3><p><a class="link" href="/flash">Back to the board</a></p></div>'; return; }
    const me = state.user;
    const canBook = !me || me.role === 'client';
    const status = { available: 'Available', claimed: 'Claimed, a booking is in progress', sold: 'Sold', hidden: 'Hidden from the board' }[f.status];
    main.innerHTML = `
      <div class="two-col flash">
        <div class="flash__image"><img src="${attr(f.image_url)}" alt="${attr(f.title)}"></div>
        <aside class="stack">
          <div class="card">
            <a class="muted small" href="/flash">← Flash board</a>
            <div class="row row--between" style="margin-top:6px"><h1 style="margin:0">${esc(f.title)}</h1><strong class="flash__price">${money(f.price)}</strong></div>
            <div class="chips" style="margin:12px 0">${f.style ? `<span class="tag">${esc(f.style)}</span>` : ''}${f.size_label ? `<span class="tag">${esc(f.size_label)}</span>` : ''}<span class="tag">${f.repeatable ? 'Repeatable' : 'One-off'}</span>${f.times_done ? `<span class="tag">Done ${f.times_done}×</span>` : ''}</div>
            ${f.description ? `<p style="white-space:pre-wrap">${esc(f.description)}</p>` : ''}
            <div class="row" style="margin-top:10px">${avatar(f.artist_avatar_url, f.artist_name, 'avatar--sm')}<div><a href="/artists/${f.artist_id}"><strong>${esc(f.artist_name)}</strong></a><div class="small muted">${esc(f.studio_name || 'Artist')}${f.artist_location ? ` · ${esc(f.artist_location)}` : ''}</div></div></div>
            <hr class="divider" style="margin:14px 0">
            <div class="row row--between"><span class="muted">Status</span><span class="pill pill--${f.status === 'available' ? 'open' : (f.status === 'claimed' ? 'pending' : (f.status === 'sold' ? 'completed' : 'closed'))}">${esc(status)}</span></div>
            ${f.deposit_amount && f.available && f.accepting_clients ? `<p class="small muted" style="margin-top:10px">Book a slot and pay the ${money(Math.min(f.deposit_amount, f.price))} deposit to claim it. The rest (${money(f.price - Math.min(f.deposit_amount, f.price))}) is settled after the session.</p>` : ''}
            <div class="row" style="margin-top:14px">
              ${f.available && canBook ? (f.accepting_clients ? `<a class="btn" href="${me ? `/book/${f.artist_id}?flash=${f.id}` : `/login?next=${encodeURIComponent(`/book/${f.artist_id}?flash=${f.id}`)}`}">Book this design</a>` : '<span class="muted small">This artist is not taking bookings right now.</span>') : ''}
              ${canBook && me && (!f.available || !f.accepting_clients) && f.status !== 'sold' ? '<span data-waitlist-btn></span>' : ''}
              ${me && !f.is_owner ? `<a class="btn btn--ghost" href="/messages/${f.artist_id}">Ask about it</a>` : ''}
              ${shareButton({ title: `${f.title} by ${f.artist_name}`, text: `Flash by ${f.artist_name}: ${f.title}, ${money(f.price)} on Inkwell`, path: `/flash/${f.id}` })}
            </div>
          </div>
          ${f.is_owner ? `
          <div class="card">
            <h3>Manage this design</h3>
            <form class="form" data-edit-flash>${flashEditorHtml(f)}<div class="row row--between"><button class="btn btn--sm">Save</button><button type="button" class="btn btn--danger btn--sm" data-delete-flash ${f.status === 'claimed' ? 'disabled title="Cancel the booking first"' : ''}>Delete</button></div></form>
            ${f.claims && f.claims.length ? `<h3 style="margin-top:18px">Bookings for this design</h3><div class="stack">${f.claims.map((c) => `<div class="row row--between small"><span>${esc(c.client_name)} · ${esc(fmtSlot(c.starts_at))}</span>${pill(c.status)}</div>`).join('')}</div>` : '<p class="small faint" style="margin-top:14px">No bookings yet.</p>'}
          </div>` : ''}
        </aside>
      </div>`;
    bindShare();
    renderWaitlistButton($('[data-waitlist-btn]'), { id: f.artist_id, name: f.artist_name, accepting_clients: f.accepting_clients }, { flash: f });
    const edit = $('[data-edit-flash]');
    if (edit) {
      edit.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api.put(`/api/flash/${f.id}`, flashPayload(edit)); toast('Design updated'); viewFlash(id); } catch (err) { handleError(err, $('.error', edit)); }
      });
      $('[data-delete-flash]').addEventListener('click', async () => {
        if (!confirm('Delete this design?')) return;
        try { await api.del(`/api/flash/${f.id}`); toast('Design deleted'); navigate('/dashboard?tab=flash'); } catch (err) { handleError(err); }
      });
    }
  }

  /* ---------- consent forms ---------- */

  function signaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    const scale = window.devicePixelRatio || 1;
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * scale); canvas.height = Math.round(rect.height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a1a1c';
    };
    size();
    let drawing = false;
    let strokes = 0;
    const point = (e) => { const r = canvas.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
    const start = (e) => { e.preventDefault(); drawing = true; const p = point(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke(); strokes += 1; canvas.classList.add('signed'); };
    const move = (e) => { if (!drawing) return; e.preventDefault(); const p = point(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const end = () => { drawing = false; };
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); canvas.addEventListener('touchend', end);
    return {
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); strokes = 0; canvas.classList.remove('signed'); },
      isEmpty() { return strokes === 0; },
      toDataURL() { return canvas.toDataURL('image/png'); },
    };
  }

  function consentBadge(a) {
    if (!a.consent) return '';
    if (a.consent.signed_at) return '<span class="pill pill--completed" title="Consent form signed">Consent ✓</span>';
    if (['pending', 'confirmed'].includes(a.status)) return `<span class="pill pill--pending" title="Consent form not signed yet">Consent ${a.consent.required ? 'required' : 'pending'}</span>`;
    return '';
  }

  async function viewConsent(apptId) {
    if (!requireLogin(`/appointments/${apptId}/consent`)) return;
    loading();
    let data;
    try { data = await api.get(`/api/appointments/${apptId}/consent`); } catch (e) { main.innerHTML = `<div class="empty"><h3>${e.status === 403 ? 'This is not your session' : 'Session not found'}</h3><p><a class="link" href="/appointments">Back to bookings</a></p></div>`; return; }
    const me = state.user;
    const { appointment: a, definition: def, form } = data;
    const isClient = me.id === a.client_id;
    const other = isClient ? `${a.artist_name}${a.studio_name ? ` · ${a.studio_name}` : ''}` : a.client_name;
    const head = `
      <div class="page-head consent__head">
        <div>
          <a class="muted small" href="/appointments">← Bookings</a>
          <h1 style="margin-top:6px">Consent form</h1>
          <p class="muted">Session ${fmtSlot(a.starts_at)} with ${esc(other)}.</p>
        </div>
        ${form ? '<div class="row"><button type="button" class="btn btn--ghost btn--sm" data-print>Print / save as PDF</button></div>' : ''}
      </div>`;

    if (form) {
      const yes = (k) => form.answers[k] && form.answers[k].yes;
      main.innerHTML = `<div class="narrow consent">${head}
        <div class="card consent__signed">
          <div class="row row--between"><div><strong>Signed by ${esc(form.full_name)}</strong><div class="small muted">Date of birth ${esc(form.date_of_birth)} · signed ${esc(new Date(`${form.signed_at.replace(' ', 'T')}Z`).toLocaleString())} · form v${form.form_version}</div></div><span class="pill pill--completed">Signed</span></div>
          ${form.flags.length ? `<div class="consent__flags"><strong>Health items to read before the session</strong><ul>${form.flags.map((f) => `<li><span>${esc(f.label)}</span>${f.detail ? `<em>${esc(f.detail)}</em>` : ''}</li>`).join('')}</ul></div>` : '<p class="consent__ok">No health items flagged.</p>'}
          <h3>Health questionnaire</h3>
          <table class="consent__table"><tbody>${def.health.map((q) => `<tr><td>${esc(q.label)}</td><td class="${yes(q.key) ? 'consent__yes' : ''}">${yes(q.key) ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>
          ${form.photo_consent !== null ? `<p class="small"><strong>Photos:</strong> ${form.photo_consent ? 'agreed that photos of the finished tattoo may be shared in the artist\'s portfolio.' : 'did not agree to photos being shared.'}</p>` : ''}
          <h3>Acknowledged</h3>
          <ul class="consent__acks">${def.acknowledgements.map((k) => `<li>✓ ${esc(k.label)}</li>`).join('')}</ul>
          <h3>Studio terms</h3>
          <p class="small muted" style="white-space:pre-wrap">${esc(form.terms_text)}</p>
          <h3>Signature</h3>
          <div class="consent__sig"><img src="${attr(form.signature_url)}" alt="Signature of ${attr(form.full_name)}"></div>
        </div></div>`;
      $('[data-print]').addEventListener('click', () => window.print());
      return;
    }

    if (!data.can_sign) {
      main.innerHTML = `<div class="narrow consent">${head}<div class="empty"><h3>Not signed yet</h3><p>${isClient ? 'This session is no longer open for a consent form.' : `${esc(a.client_name)} has not signed the consent form yet. They can do it from their bookings page, and the day-before reminder asks them to.`}</p></div></div>`;
      return;
    }

    main.innerHTML = `<div class="narrow consent">${head}
      <form class="form" data-consent-form>
        <div class="error" hidden></div>
        <div class="card">
          <h3>About you</h3>
          <div class="form-row">
            <div class="field"><label>Full legal name (as on your ID)</label><input name="full_name" value="${attr(me.name)}" required maxlength="120" autocomplete="name"></div>
            <div class="field"><label>Date of birth</label><input name="date_of_birth" type="date" required max="${new Date().toISOString().slice(0, 10)}"><span class="hint">You must be at least ${def.min_age}. Bring photo ID to the session.</span></div>
          </div>
        </div>
        <div class="card" style="margin-top:14px">
          <h3>Health</h3>
          <p class="small muted">Honest answers keep you safe. Only ${esc(a.artist_name.split(' ')[0])} sees them.</p>
          ${def.health.map((q) => `
            <fieldset class="consent__q" data-q="${attr(q.key)}">
              <legend>${esc(q.label)}</legend>
              <div class="row">
                <label class="check"><input type="radio" name="q_${attr(q.key)}" value="no" required> No</label>
                <label class="check"><input type="radio" name="q_${attr(q.key)}" value="yes"> Yes</label>
              </div>
              ${q.detail ? `<input class="consent__detail" name="d_${attr(q.key)}" placeholder="${attr(q.detail)}" maxlength="500" hidden>` : ''}
            </fieldset>`).join('')}
        </div>
        <div class="card" style="margin-top:14px">
          <h3>Studio terms</h3>
          <p class="small" style="white-space:pre-wrap">${esc(def.terms)}</p>
          <h3 style="margin-top:16px">Please confirm</h3>
          ${def.acknowledgements.map((k) => `<label class="check consent__ack"><input type="checkbox" name="ack_${attr(k.key)}" required> ${esc(k.label)}</label>`).join('')}
          ${def.photo_ask ? '<label class="check consent__ack consent__ack--optional"><input type="checkbox" name="photo_consent"> Optional: photos of the finished tattoo may be shared in the artist\'s portfolio and social media, without my name.</label>' : ''}
        </div>
        <div class="card" style="margin-top:14px">
          <h3>Signature</h3>
          <p class="small muted">Sign with your finger or mouse.</p>
          <div class="consent__pad"><canvas data-pad aria-label="Signature pad"></canvas><button type="button" class="link small" data-clear>Clear</button></div>
          <p class="small faint">By signing you confirm the answers above are true. Signed ${new Date().toLocaleDateString()} · recorded with time, address and browser for the artist's records.</p>
          <button class="btn btn--lg btn--block" style="margin-top:12px">Sign and submit</button>
        </div>
      </form></div>`;

    const form$ = $('[data-consent-form]');
    const pad = signaturePad($('[data-pad]', form$));
    $('[data-clear]', form$).addEventListener('click', () => pad.clear());
    $$('.consent__q', form$).forEach((fs) => fs.addEventListener('change', () => {
      const detail = $('.consent__detail', fs);
      if (!detail) return;
      const yes = fs.querySelector('input[value="yes"]').checked;
      detail.hidden = !yes;
      detail.required = yes;
      if (yes) detail.focus();
    }));
    form$.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('.error', form$);
      if (pad.isEmpty()) { errBox.textContent = 'Sign in the box before submitting.'; errBox.hidden = false; $('[data-pad]', form$).scrollIntoView({ block: 'center' }); return; }
      const answers = {};
      def.health.forEach((q) => { const yes = form$[`q_${q.key}`].value === 'yes'; answers[q.key] = { yes, detail: yes && form$[`d_${q.key}`] ? form$[`d_${q.key}`].value : '' }; });
      const acknowledgements = {};
      def.acknowledgements.forEach((k) => { acknowledgements[k.key] = form$[`ack_${k.key}`].checked; });
      const btn = form$.querySelector('button.btn'); btn.disabled = true;
      try {
        await api.post(`/api/appointments/${apptId}/consent`, { full_name: form$.full_name.value, date_of_birth: form$.date_of_birth.value, answers, acknowledgements, photo_consent: form$.photo_consent ? form$.photo_consent.checked : undefined, signature: pad.toDataURL() });
        toast('Consent form signed. Thank you.');
        viewConsent(apptId);
      } catch (err) { handleError(err, errBox); btn.disabled = false; errBox.scrollIntoView({ block: 'center' }); }
    });
  }

  /** Artist settings: the studio's consent form. */
  async function renderConsentSettings(box) {
    if (!box) return;
    let data;
    try { data = await api.get('/api/consent/settings'); } catch { box.innerHTML = ''; return; }
    const s = data.settings;
    box.innerHTML = `
      <h3>Consent form</h3>
      <p class="small muted">Clients sign a consent form before each session: identity and age, a health questionnaire, your studio terms and a signature. Signed forms stay with the booking as your record. <a class="link" href="/appointments">See status on your bookings.</a></p>
      <form data-consent-settings class="stack">
        <div class="field"><label>Studio terms shown on the form</label><textarea name="terms" rows="4" maxlength="4000">${esc(s.terms)}</textarea><span class="hint">Deposits, lateness, ID, rescheduling. <button type="button" class="link" data-reset-terms>Reset to the default text</button></span></div>
        <div class="form-row">
          <div class="field"><label>Minimum age</label><input name="min_age" type="number" min="16" max="21" value="${attr(s.min_age)}"></div>
          <div class="field" style="justify-content:flex-end">
            <label class="check"><input type="checkbox" name="require_consent" ${s.require_consent ? 'checked' : ''}> Require a signed form before I can mark a session completed</label>
            <label class="check"><input type="checkbox" name="photo_ask" ${s.photo_ask ? 'checked' : ''}> Ask clients for photo consent for my portfolio</label>
          </div>
        </div>
        <div class="row"><button class="btn btn--sm btn--subtle">Save consent settings</button></div>
      </form>`;
    const form = $('[data-consent-settings]', box);
    $('[data-reset-terms]', box).addEventListener('click', () => { form.terms.value = data.defaults.terms; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api.put('/api/consent/settings', { terms: form.terms.value, min_age: form.min_age.value, require_consent: form.require_consent.checked, photo_ask: form.photo_ask.checked }); toast('Consent settings saved'); } catch (err) { handleError(err); }
    });
  }

  /* ---------- calendar sync ---------- */

  async function renderCalendarCard(box) {
    if (!box) return;
    let cal;
    try { cal = await api.get('/api/calendar'); } catch (err) { box.innerHTML = ''; return; }
    const u = state.user;
    const busy = cal.busy;
    const syncedLine = (b) => (b.error ? `<span style="color:var(--accent)">Could not read it: ${esc(b.error)}</span>` : (b.synced_at ? `${b.count} busy block${b.count === 1 ? '' : 's'} imported, checked ${timeAgo(b.synced_at)}. Refreshes every 30 minutes.` : 'Not checked yet.'));
    box.innerHTML = `
      <h3>Calendar</h3>
      <p class="small muted">Subscribe once and every ${u.role === 'artist' ? 'session' : 'booking'} shows up in your own calendar, with changes and cancellations. Times are in ${esc(cal.timezone)}. Anyone with this link can read your sessions, so keep it to yourself.</p>
      <div class="share__link"><input readonly value="${attr(cal.feed.https)}" aria-label="Calendar feed link" data-feed-link><button class="btn btn--sm" data-copy-feed>Copy</button></div>
      <div class="row" style="margin-top:10px">
        <a class="btn btn--ghost btn--sm" href="${attr(cal.feed.google)}" target="_blank" rel="noopener">Add to Google Calendar</a>
        <a class="btn btn--ghost btn--sm" href="${attr(cal.feed.webcal)}">Apple Calendar / Outlook</a>
        <button type="button" class="link small" data-reset-feed>Reset link</button>
      </div>
      ${busy ? `
        <hr class="divider" style="margin:16px 0">
        <h3 style="font-size:1rem">Block time from another calendar</h3>
        <p class="small muted">Paste the private iCal address of your personal or studio calendar (Google: calendar settings → "Secret address in iCal format"). Its events are treated as busy, so clients cannot book over them. Repeating events are not expanded.</p>
        <form class="share__link" data-busy-form><input name="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value="${attr(busy.url)}" aria-label="Busy calendar address"><button class="btn btn--sm">${busy.url ? 'Update' : 'Connect'}</button></form>
        <div class="small muted" style="margin-top:8px" data-busy-status>${busy.url ? syncedLine(busy) : 'No calendar connected.'}</div>
        ${busy.url ? '<div class="row" style="margin-top:8px"><button type="button" class="btn btn--ghost btn--sm" data-busy-sync>Check now</button><button type="button" class="link small" data-busy-remove>Disconnect</button></div>' : ''}` : ''}`;
    $('[data-copy-feed]', box).addEventListener('click', async () => { toast((await copyText(cal.feed.https)) ? 'Calendar link copied' : 'Could not copy'); });
    $('[data-feed-link]', box).addEventListener('focus', (e) => e.target.select());
    $('[data-reset-feed]', box).addEventListener('click', async () => {
      if (!confirm('Reset the calendar link? Calendars subscribed with the old link will stop updating.')) return;
      try { await api.post('/api/calendar/reset'); toast('New calendar link created'); renderCalendarCard(box); } catch (err) { handleError(err); }
    });
    const busyForm = $('[data-busy-form]', box);
    if (busyForm) busyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = busyForm.querySelector('button'); btn.disabled = true;
      try { await api.put('/api/calendar/busy', { url: busyForm.url.value }); toast('Calendar connected'); renderCalendarCard(box); } catch (err) { handleError(err); btn.disabled = false; if (err.data && err.data.busy) $('[data-busy-status]', box).innerHTML = syncedLine(err.data.busy); }
    });
    const sync = $('[data-busy-sync]', box);
    if (sync) sync.addEventListener('click', async () => {
      sync.disabled = true;
      try { const r = await api.post('/api/calendar/busy/sync'); $('[data-busy-status]', box).innerHTML = syncedLine(r.busy); toast('Calendar checked'); } catch (err) { handleError(err); if (err.data && err.data.busy) $('[data-busy-status]', box).innerHTML = syncedLine(err.data.busy); } finally { sync.disabled = false; }
    });
    const remove = $('[data-busy-remove]', box);
    if (remove) remove.addEventListener('click', async () => {
      try { await api.del('/api/calendar/busy'); toast('Calendar disconnected'); renderCalendarCard(box); } catch (err) { handleError(err); }
    });
  }

  /* ---------- sharing, boards and reviews ---------- */

  const SHARE_ICONS = {
    share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6h14v-6"/></svg>',
    save: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    saved: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    qr: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v7h-3"/></svg>',
    mail: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    card: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15l5-5 4 4 3-3 6 6"/></svg>',
    device: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.7l6.8-4M8.6 13.3l6.8 4"/></svg>',
  };
  const absUrl = (p) => (p.startsWith('http') ? p : `${location.origin}${p}`);

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); return ok;
    }
  }

  /** Share sheet: native share where the browser has it, plus copy, QR, share card and the usual apps. */
  function shareSheet({ title, text, path, card, onClose }) {
    const url = absUrl(path);
    const enc = encodeURIComponent;
    const canNative = !!navigator.share;
    const apps = [
      ['WhatsApp', `https://wa.me/?text=${enc(`${text} ${url}`)}`],
      ['X', `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}`],
      ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`],
      ...(card ? [['Pinterest', `https://pinterest.com/pin/create/button/?url=${enc(url)}&media=${enc(absUrl(card))}&description=${enc(text)}`]] : []),
    ];
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Share</h3><p class="small muted" style="margin:4px 0 0">${esc(title)}</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <div class="modal__body share">
          <div class="share__link"><input readonly value="${attr(url)}" aria-label="Link" data-link><button class="btn btn--sm" data-copy>Copy</button></div>
          <div class="share__grid">
            ${canNative ? `<button type="button" class="share__opt" data-native>${SHARE_ICONS.device}<span>Share…</span></button>` : ''}
            <button type="button" class="share__opt" data-qr>${SHARE_ICONS.qr}<span>QR code</span></button>
            ${card ? `<a class="share__opt" href="${attr(card)}" target="_blank" rel="noopener">${SHARE_ICONS.card}<span>Share card</span></a>` : ''}
            <a class="share__opt" href="mailto:?subject=${enc(title)}&body=${enc(`${text}\n\n${url}`)}">${SHARE_ICONS.mail}<span>Email</span></a>
            ${apps.map(([name, href]) => `<a class="share__opt" href="${attr(href)}" target="_blank" rel="noopener noreferrer"><b>${esc(name[0])}</b><span>${esc(name)}</span></a>`).join('')}
          </div>
          <div class="share__qr" data-qr-box hidden><img alt="QR code for ${attr(url)}" width="220" height="220"><p class="small muted">Scan to open on a phone. Right-click or long-press to save it for flyers and studio cards.</p></div>
        </div>
      </div>`, { small: true, onClose });
    $('[data-copy]', modal).addEventListener('click', async () => { toast((await copyText(url)) ? 'Link copied' : 'Could not copy. Select the link and copy it.', 'ok'); });
    $('[data-link]', modal).addEventListener('focus', (e) => e.target.select());
    const native = $('[data-native]', modal);
    if (native) native.addEventListener('click', async () => { try { await navigator.share({ title, text, url }); closeModal(); } catch { /* dismissed */ } });
    $('[data-qr]', modal).addEventListener('click', () => {
      const box = $('[data-qr-box]', modal);
      box.hidden = !box.hidden;
      if (!box.hidden) box.querySelector('img').src = `/api/share/qr.svg?url=${enc(path)}`;
    });
  }

  function shareButton(opts, cls = 'btn btn--ghost btn--sm') {
    return `<button type="button" class="${cls}" data-share='${attr(JSON.stringify(opts))}'>${SHARE_ICONS.share} Share</button>`;
  }
  function bindShare(root = main) {
    $$('[data-share]', root).forEach((b) => b.addEventListener('click', () => shareSheet(JSON.parse(b.dataset.share))));
  }

  /* ---- boards (collections) ---- */

  function boardCard(c, { owner = true } = {}) {
    return `<a class="board" href="/c/${attr(c.token)}">
      <div class="board__cover">${c.cover_url ? `<img src="${attr(c.cover_url)}" alt="" loading="lazy">` : `<span>${SHARE_ICONS.save}</span>`}</div>
      <div class="board__body"><strong>${esc(c.title)}</strong><span class="small muted">${c.item_count} piece${c.item_count === 1 ? '' : 's'}${owner ? ` · ${c.is_public ? 'Shared by link' : 'Private'}` : ` · by ${esc(c.owner.name)}`}</span></div>
    </a>`;
  }

  /** Save-to-board picker for an artwork. */
  async function savePicker(artwork, onChange, onClose) {
    if (!requireLogin()) { closeModal(); return; }
    let boards;
    try { ({ collections: boards } = await api.get('/api/collections', { artwork_id: artwork.id })); } catch (err) { return handleError(err); }
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">Save to a board</h3><p class="small muted" style="margin:4px 0 0">${esc(artwork.title)}</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <div class="modal__body" data-boards></div>
      </div>`, { small: true, onClose });
    const box = $('[data-boards]', modal);
    function render() {
      box.innerHTML = `${boards.length ? `<div class="pick-list">${boards.map((c) => `
        <label class="pick-row"><input type="checkbox" data-board="${c.id}" ${c.has_artwork ? 'checked' : ''}>
          <span class="pick-row__cover">${c.cover_url ? `<img src="${attr(c.cover_url)}" alt="">` : ''}</span>
          <span class="pick-row__text"><strong>${esc(c.title)}</strong><span class="small muted">${c.item_count} piece${c.item_count === 1 ? '' : 's'}${c.is_public ? ' · shared' : ''}</span></span>
        </label>`).join('')}</div>` : '<p class="muted">No boards yet. Make one for this piece:</p>'}
        <form class="row" data-new-board style="margin-top:12px"><input name="title" placeholder="New board, e.g. Sleeve ideas" required maxlength="80" style="flex:1"><button class="btn btn--sm">Create &amp; save</button></form>`;
      $$('[data-board]', box).forEach((cb) => cb.addEventListener('change', async () => {
        const id = cb.dataset.board;
        try {
          if (cb.checked) await api.post(`/api/collections/${id}/items`, { artwork_id: artwork.id }); else await api.del(`/api/collections/${id}/items/${artwork.id}`);
          const b = boards.find((x) => String(x.id) === id); b.has_artwork = cb.checked; b.item_count += cb.checked ? 1 : -1;
          toast(cb.checked ? `Saved to ${b.title}` : `Removed from ${b.title}`);
          if (onChange) onChange(boards.some((x) => x.has_artwork));
        } catch (err) { cb.checked = !cb.checked; handleError(err); }
      }));
      $('[data-new-board]', box).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api.post('/api/collections', { title: e.target.title.value, artwork_id: artwork.id });
          boards.unshift({ ...r.collection, has_artwork: true });
          toast(`Saved to ${r.collection.title}`);
          if (onChange) onChange(true);
          render();
        } catch (err) { handleError(err); }
      });
    }
    render();
  }

  /** Pick one of my boards (used by messages and requests). */
  async function boardPicker(onPick) {
    let boards;
    try { ({ collections: boards } = await api.get('/api/collections')); } catch (err) { return handleError(err); }
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><h3 style="margin:0">Share a board</h3><button class="modal__close" data-close-modal aria-label="Close">×</button></div>
        <div class="modal__body">${boards.length ? `<div class="pick-list">${boards.map((c) => `<button type="button" class="pick-row" data-pick="${c.id}"><span class="pick-row__cover">${c.cover_url ? `<img src="${attr(c.cover_url)}" alt="">` : ''}</span><span class="pick-row__text"><strong>${esc(c.title)}</strong><span class="small muted">${c.item_count} piece${c.item_count === 1 ? '' : 's'}</span></span></button>`).join('')}</div><p class="small faint" style="margin-top:10px">Sharing a board makes it viewable by anyone with its link.</p>` : '<p class="muted">You have no boards yet. Save tattoos you like from any artist page and they collect here.</p>'}</div>
      </div>`, { small: true });
    $$('[data-pick]', modal).forEach((b) => b.addEventListener('click', () => { const c = boards.find((x) => String(x.id) === b.dataset.pick); closeModal(); onPick(c); }));
  }

  async function viewCollections() {
    if (!requireLogin('/collections')) return;
    loading();
    let boards;
    try { ({ collections: boards } = await api.get('/api/collections')); } catch (e) { return handleError(e); }
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Your boards</h1><p class="muted">Tattoos you have saved, grouped the way you like. Share a board with an artist or attach it to a request.</p></div>
        <button class="btn" data-new>New board</button>
      </div>
      ${boards.length ? `<div class="grid grid--3 boards">${boards.map((c) => boardCard(c)).join('')}</div>` : '<div class="empty"><h3>No boards yet</h3><p>Open any tattoo and choose <strong>Save</strong> to start one.</p><p><a class="btn btn--ghost btn--sm" href="/">Explore work</a></p></div>'}`;
    $('[data-new]').addEventListener('click', () => {
      const modal = openModal(`<div class="modal__panel"><div class="modal__head"><h3 style="margin:0">New board</h3><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form><div class="error" hidden></div>
          <div class="field"><label>Name</label><input name="title" placeholder="Sleeve ideas" required maxlength="80"></div>
          <div class="field"><label>Notes (optional)</label><textarea name="description" placeholder="Placement, size, what you like about these..."></textarea></div>
          <button class="btn btn--block">Create board</button></form></div>`, { small: true });
      $('[data-form]', modal).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { const r = await api.post('/api/collections', formData(e.target)); closeModal(); navigate(`/c/${r.collection.token}`); } catch (err) { handleError(err, $('.error', e.target)); }
      });
    });
  }

  async function viewCollection(token) {
    loading();
    let c;
    try { ({ collection: c } = await api.get(`/api/collections/shared/${token}`)); } catch (e) { main.innerHTML = `<div class="empty"><h3>${e.status === 404 ? 'This board is private or no longer exists' : 'Could not load this board'}</h3><p>${state.user ? '' : '<a class="link" href="/login">Sign in</a> if it is yours.'}</p></div>`; return; }
    const me = state.user;
    const share = { title: c.title, text: `${c.title}: ${c.item_count} tattoo${c.item_count === 1 ? '' : 's'} saved on Inkwell`, path: `/c/${c.token}`, card: `/og/collections/${c.token}.png` };
    const render = () => {
      main.innerHTML = `
        <div class="page-head">
          <div>
            ${c.is_owner ? '<a class="muted small" href="/collections">← Your boards</a>' : `<div class="row muted small">${avatar(c.owner.avatar_url, c.owner.name, 'avatar--xs')} ${esc(c.owner.name)}'s board</div>`}
            <div class="row" style="margin-top:6px"><h1 style="margin:0">${esc(c.title)}</h1>${c.is_owner ? `<span class="pill ${c.is_public ? 'pill--open' : 'pill--closed'}">${c.is_public ? 'Shared' : 'Private'}</span>` : ''}</div>
            ${c.description ? `<p class="muted" style="max-width:70ch">${esc(c.description)}</p>` : ''}
            <p class="small muted">${c.item_count} piece${c.item_count === 1 ? '' : 's'}${c.artists.length ? ` · ${c.artists.map((a) => `<a class="link" href="/artists/${a.id}">${esc(a.name)}</a>`).join(', ')}` : ''}</p>
          </div>
          <div class="row">
            ${c.is_owner ? `<button class="btn btn--ghost btn--sm" data-edit>Edit</button>${me.role === 'client' ? `<a class="btn btn--ghost btn--sm" href="/requests/new?board=${c.id}">Use in a request</a>` : ''}` : ''}
            ${c.is_public || c.is_owner ? shareButton(share, 'btn btn--sm') : ''}
          </div>
        </div>
        ${!c.is_public && c.is_owner ? '<div class="banner banner--soft">This board is private. Sharing it, or attaching it to a request, makes it viewable by anyone with the link.</div>' : ''}
        ${c.items.length ? `<div class="grid-art">${c.items.map((a) => `
          <article class="art" data-artwork="${a.id}">
            <img src="${attr(a.thumb_url || a.image_url)}" alt="${attr(a.title)}" loading="lazy" ${a.width && a.height ? `width="${a.width}" height="${a.height}"` : ''}>
            <div class="art__body">
              <div class="art__title"><span>${esc(a.title)}</span>${c.is_owner ? `<button class="link small" data-remove="${a.id}" title="Remove from board">Remove</button>` : `<span class="art__likes">♥ ${a.like_count}</span>`}</div>
              <div class="art__meta">${avatar(a.artist_avatar_url, a.artist_name, 'avatar--xs')}<span>${esc(a.artist_name)}</span>${a.style ? `<span class="tag">${esc(a.style)}</span>` : ''}</div>
              ${a.note ? `<div class="small muted" style="margin-top:6px">${esc(a.note)}</div>` : ''}
            </div>
          </article>`).join('')}</div>` : `<div class="empty"><h3>Nothing saved yet</h3><p>${c.is_owner ? 'Open any tattoo and choose Save.' : 'This board is empty.'}</p></div>`}`;
      bindShare();
      $$('[data-remove]').forEach((b) => b.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { ({ collection: c } = await api.del(`/api/collections/${c.id}/items/${b.dataset.remove}`)); render(); } catch (err) { handleError(err); }
      }));
      const edit = $('[data-edit]');
      if (edit) edit.addEventListener('click', () => {
        const modal = openModal(`<div class="modal__panel"><div class="modal__head"><h3 style="margin:0">Edit board</h3><button class="modal__close" data-close-modal>×</button></div>
          <form class="form modal__body" data-form><div class="error" hidden></div>
            <div class="field"><label>Name</label><input name="title" value="${attr(c.title)}" required maxlength="80"></div>
            <div class="field"><label>Notes</label><textarea name="description">${esc(c.description)}</textarea></div>
            <label class="check"><input type="checkbox" name="is_public" ${c.is_public ? 'checked' : ''}> Anyone with the link can view this board</label>
            <div class="row row--between" style="margin-top:8px"><button class="btn">Save</button><button type="button" class="btn btn--danger btn--sm" data-delete-board>Delete board</button></div>
          </form></div>`, { small: true });
        $('[data-form]', modal).addEventListener('submit', async (e) => {
          e.preventDefault();
          try { ({ collection: c } = await api.put(`/api/collections/${c.id}`, { title: e.target.title.value, description: e.target.description.value, is_public: e.target.is_public.checked })); closeModal(); render(); } catch (err) { handleError(err, $('.error', e.target)); }
        });
        $('[data-delete-board]', modal).addEventListener('click', async () => {
          if (!confirm('Delete this board? The tattoos themselves are not affected.')) return;
          try { await api.del(`/api/collections/${c.id}`); closeModal(); toast('Board deleted'); navigate('/collections'); } catch (err) { handleError(err); }
        });
      });
    };
    render();
  }

  /* ---- reviews ---- */

  function reviewPhotosHtml(photos) {
    if (!photos || !photos.length) return '';
    return `<div class="review__photos">${photos.map((p) => `<a href="${attr(p.url)}" data-photo="${attr(p.url)}"><img src="${attr(p.thumb_url || p.url)}" alt="Client photo" loading="lazy"></a>`).join('')}</div>`;
  }

  function reviewCard(rv, { artistName, isArtistPage = true } = {}) {
    const me = state.user;
    const isMe = me && me.id === rv.artist_id;
    const who = isArtistPage
      ? `${avatar(rv.client_avatar_url, rv.client_name, 'avatar--sm')}<div><strong>${esc(rv.client_name)}</strong><div class="small muted">${stars(rv.rating)} · <span class="review__verified" title="Written after a session booked and completed on Inkwell">✓ Verified session</span> · ${fmtSlot(rv.starts_at).split(',').slice(0, 2).join(',')}</div></div>`
      : `${avatar(rv.artist_avatar_url, rv.artist_name, 'avatar--sm')}<div><a href="/artists/${rv.artist_id}"><strong>${esc(rv.artist_name)}</strong></a><div class="small muted">${stars(rv.rating)} · session ${fmtSlot(rv.starts_at).split(',').slice(0, 2).join(',')}</div></div>`;
    return `
      <div class="card review" data-review="${rv.id}">
        <div class="row row--between">
          <div class="row">${who}</div>
          <span class="faint small">${timeAgo(rv.created_at)}${rv.edited ? ' · edited' : ''}</span>
        </div>
        ${rv.body ? `<p style="margin:10px 0 0;white-space:pre-wrap">${esc(rv.body)}</p>` : ''}
        ${reviewPhotosHtml(rv.photos)}
        ${rv.artist_reply ? `<div class="review__reply"><strong class="small">Reply from ${esc((artistName || rv.artist_name || '').split(' ')[0])}</strong><p style="margin:4px 0 0">${esc(rv.artist_reply)}</p></div>` : ''}
        <div class="row small review__actions">
          ${me && me.id !== rv.client_id ? `<button class="link review__helpful ${rv.voted ? 'on' : ''}" data-helpful="${rv.id}">${rv.voted ? 'Helpful ✓' : 'Helpful'}${rv.helpful_count ? ` · ${rv.helpful_count}` : ''}</button>` : (rv.helpful_count ? `<span class="muted">${rv.helpful_count} found this helpful</span>` : '')}
          ${isMe && !rv.artist_reply ? `<button class="link" data-reply="${rv.id}">Reply</button>` : ''}
          ${rv.can_edit ? `<button class="link" data-edit-review="${rv.id}">Edit</button>` : ''}
          ${me && (me.id === rv.client_id || me.is_admin) ? `<button class="link" data-del-review="${rv.id}">Delete</button>` : ''}
          ${me && me.id !== rv.client_id && !isMe ? `<button class="link" data-report-review="${rv.id}">Report</button>` : ''}
        </div>
      </div>`;
  }

  function bindReviewCards(root, reviews, reload) {
    $$('[data-photo]', root).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openPhoto(a.dataset.photo); }));
    $$('[data-helpful]', root).forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await api.post(`/api/reviews/${b.dataset.helpful}/helpful`);
        b.classList.toggle('on', r.voted);
        b.textContent = `${r.voted ? 'Helpful ✓' : 'Helpful'}${r.helpful_count ? ` · ${r.helpful_count}` : ''}`;
      } catch (err) { handleError(err); }
    }));
    $$('[data-report-review]', root).forEach((b) => b.addEventListener('click', () => reportModal('review', Number(b.dataset.reportReview), 'review')));
    $$('[data-del-review]', root).forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this review?')) return;
      try { await api.del(`/api/reviews/${b.dataset.delReview}`); toast('Review deleted'); reload(); } catch (err) { handleError(err); }
    }));
    $$('[data-edit-review]', root).forEach((b) => b.addEventListener('click', () => {
      const rv = reviews.find((x) => String(x.id) === b.dataset.editReview);
      if (rv) reviewModal({ review: rv }, reload);
    }));
    $$('[data-reply]', root).forEach((b) => b.addEventListener('click', () => {
      const card = b.closest('[data-review]');
      card.insertAdjacentHTML('beforeend', '<form class="row" data-reply-form style="margin-top:10px"><input name="body" placeholder="Thank them or add context" required style="flex:1;padding:9px 12px;border-radius:999px;border:1px solid var(--line-strong);background:var(--bg);color:var(--text)"><button class="btn btn--sm">Post reply</button></form>');
      b.remove();
      $('[data-reply-form]', card).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api.post(`/api/reviews/${card.dataset.review}/reply`, { body: e.target.body.value }); reload(); } catch (err) { handleError(err); }
      });
    }));
  }

  function ratingBreakdown(summary) {
    const rows = [['five', 5], ['four', 4], ['three', 3], ['two', 2], ['one', 1]];
    const total = summary.review_count || 1;
    return `<div class="rating-summary">
      <div class="rating-summary__big"><strong>${summary.rating ?? '–'}</strong>${stars(summary.rating || 0)}<span class="small muted">${summary.review_count} review${summary.review_count === 1 ? '' : 's'}</span></div>
      <div class="rating-summary__bars">${rows.map(([k, n]) => `<div class="rating-bar"><span>${n}★</span><i><b style="width:${Math.round((summary[k] / total) * 100)}%"></b></i><span class="muted">${summary[k]}</span></div>`).join('')}</div>
      <div class="rating-summary__facts">${summary.recommend_pct !== null ? `<div><strong>${summary.recommend_pct}%</strong><span>rated 4 stars or more</span></div>` : ''}${summary.with_photos ? `<div><strong>${summary.with_photos}</strong><span>with photos</span></div>` : ''}</div>
    </div>`;
  }

  /** Reviews section on an artist page with sort, client photos and paging. */
  function reviewsSection(el, artist, initial, reload) {
    let data = initial;
    const SORTS_UI = [['newest', 'Newest'], ['highest', 'Highest'], ['lowest', 'Lowest'], ['photos', 'With photos'], ['helpful', 'Most helpful']];
    async function load(sort, page = 1, append = false) {
      try {
        const r = await api.get(`/api/artists/${artist.id}/reviews`, { sort, page });
        data = append ? { ...r, reviews: [...data.reviews, ...r.reviews] } : r;
        render();
      } catch (err) { handleError(err); }
    }
    function render() {
      const s = data.summary;
      el.innerHTML = `
        <div class="section__head"><h2 id="reviews">Reviews</h2>${s.review_count ? `<span class="row" style="gap:8px">${shareButton({ title: `Reviews of ${artist.name}`, text: `${artist.name} is rated ${s.rating} out of 5 by ${s.review_count} client${s.review_count === 1 ? '' : 's'} on Inkwell`, path: `/artists/${artist.id}#reviews`, card: `/og/artists/${artist.id}.png` }, 'btn btn--subtle btn--sm')}</span>` : ''}</div>
        ${s.review_count ? ratingBreakdown(s) : ''}
        ${data.photos.length ? `<div class="client-photos"><div class="small muted" style="margin-bottom:8px">Client photos</div><div class="client-photos__strip">${data.photos.map((p) => `<a href="${attr(p.url)}" data-photo="${attr(p.url)}"><img src="${attr(p.thumb_url || p.url)}" alt="Client photo" loading="lazy"></a>`).join('')}</div></div>` : ''}
        ${s.review_count > 1 ? `<div class="chips" style="margin:14px 0">${SORTS_UI.map(([k, label]) => `<button type="button" class="chip ${data.sort === k ? 'active' : ''}" data-sort="${k}">${label}</button>`).join('')}</div>` : ''}
        ${data.reviews.length ? `<div class="stack">${data.reviews.map((rv) => reviewCard(rv, { artistName: artist.name })).join('')}</div>` : `<div class="empty"><p>${data.sort === 'photos' ? 'No reviews with photos yet.' : 'No reviews yet. Clients can review after a completed session.'}</p></div>`}
        ${data.has_more ? '<div style="text-align:center;margin-top:14px"><button class="btn btn--ghost btn--sm" data-more-reviews>More reviews</button></div>' : ''}`;
      bindShare(el);
      $$('[data-photo]', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openPhoto(a.dataset.photo); }));
      bindReviewCards(el, data.reviews, reload);
      $$('[data-sort]', el).forEach((b) => b.addEventListener('click', () => load(b.dataset.sort)));
      const more = $('[data-more-reviews]', el);
      if (more) more.addEventListener('click', () => { more.disabled = true; load(data.sort, data.page + 1, true); });
    }
    render();
  }

  /** Post or edit a review, with up to three photos. */
  function reviewModal({ appointmentId, review }, reload) {
    let rating = review ? review.rating : 5;
    let kept = review ? [...review.photos] : [];
    let pending = [];
    const modal = openModal(`
      <div class="modal__panel">
        <div class="modal__head"><div><h3 style="margin:0">${review ? 'Edit your review' : 'How was your session?'}</h3>${review ? '' : '<p class="small muted" style="margin:4px 0 0">Reviews are public and marked as a verified session.</p>'}</div><button class="modal__close" data-close-modal>×</button></div>
        <form class="form modal__body" data-form>
          <div class="error" hidden></div>
          <div class="field"><span class="label">Rating</span><div class="star-picker" data-picker>${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" class="${i <= rating ? 'on' : ''}" aria-label="${i} star${i === 1 ? '' : 's'}">★</button>`).join('')}</div></div>
          <div class="field"><label>Tell others about it (optional)</label><textarea name="body" placeholder="How did the artist handle the design, the session, the healing advice?">${esc(review ? review.body : '')}</textarea></div>
          <div class="field"><span class="label">Photos (optional, up to 3)</span><div class="review-photos" data-photos></div><label class="btn btn--ghost btn--sm" style="margin-top:8px"><input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple hidden data-file>Add photos</label><span class="hint">Healed photos help other clients most.</span></div>
          <button class="btn btn--block">${review ? 'Save changes' : 'Post review'}</button>
        </form>
      </div>`, { small: true });
    const form = $('[data-form]', modal);
    const photosEl = $('[data-photos]', form);
    const fileInput = $('[data-file]', form);
    const removed = [];
    function renderPhotos() {
      photosEl.innerHTML = [
        ...kept.map((p) => `<span class="pending"><img src="${attr(p.thumb_url || p.url)}" alt=""><button type="button" data-drop="${attr(p.url)}" aria-label="Remove photo">×</button></span>`),
        ...pending.map((f, i) => `<span class="pending"><img src="${attr(URL.createObjectURL(f))}" alt=""><span>${esc(f.name)}</span><button type="button" data-unpick="${i}" aria-label="Remove photo">×</button></span>`),
      ].join('');
      $$('[data-drop]', photosEl).forEach((b) => b.addEventListener('click', () => { removed.push(b.dataset.drop); kept = kept.filter((p) => p.url !== b.dataset.drop); renderPhotos(); }));
      $$('[data-unpick]', photosEl).forEach((b) => b.addEventListener('click', () => { pending.splice(Number(b.dataset.unpick), 1); renderPhotos(); }));
    }
    renderPhotos();
    fileInput.addEventListener('change', () => {
      const room = 3 - kept.length - pending.length;
      const files = Array.from(fileInput.files).slice(0, Math.max(0, room));
      if (fileInput.files.length > room) toast('Up to 3 photos per review', 'error');
      pending = [...pending, ...files]; fileInput.value = ''; renderPhotos();
    });
    $$('[data-star]', modal).forEach((b) => b.addEventListener('click', () => {
      rating = Number(b.dataset.star);
      $$('[data-star]', modal).forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= rating));
    }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('rating', rating);
      fd.append('body', form.body.value);
      pending.forEach((f) => fd.append('photos', f));
      if (review) fd.append('remove_photos', JSON.stringify(removed));
      form.querySelector('button.btn--block').disabled = true;
      try {
        if (review) await api.put(`/api/reviews/${review.id}`, fd); else await api.post(`/api/appointments/${appointmentId}/review`, fd);
        closeModal(); toast(review ? 'Review updated' : 'Review posted'); reload();
      } catch (err) { handleError(err, $('.error', form)); form.querySelector('button.btn--block').disabled = false; }
    });
  }

  /** "Your reviews" block for the client dashboard: sessions waiting for a review, then past reviews. */
  async function clientReviewsSection(el, reload) {
    let data;
    try { data = await api.get('/api/reviews/mine'); } catch { el.innerHTML = ''; return; }
    if (!data.pending.length && !data.reviews.length) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="section__head"><h2>Your reviews</h2></div>
      ${data.pending.length ? `<div class="stack" style="margin-bottom:14px">${data.pending.slice(0, 3).map((p) => `<div class="card review-prompt"><div class="row">${avatar(p.artist_avatar_url, p.artist_name, 'avatar--sm')}<div><strong>How was your session with ${esc(p.artist_name.split(' ')[0])}?</strong><div class="small muted">${fmtSlot(p.starts_at)}</div></div></div><button class="btn btn--sm" data-review-appt="${p.id}">Leave a review</button></div>`).join('')}${data.pending.length > 3 ? `<p class="small muted">${data.pending.length - 3} more session${data.pending.length - 3 === 1 ? '' : 's'} waiting for a review, under <a class="link" href="/appointments">Bookings</a>.</p>` : ''}</div>` : ''}
      ${data.reviews.length ? `<div class="stack">${data.reviews.map((rv) => reviewCard(rv, { isArtistPage: false })).join('')}</div>` : ''}`;
    $$('[data-review-appt]', el).forEach((b) => b.addEventListener('click', () => reviewModal({ appointmentId: b.dataset.reviewAppt }, reload)));
    bindReviewCards(el, data.reviews, reload);
  }

  /** "Share your portfolio" card for the artist dashboard. */
  function portfolioShareCard(artist) {
    const path = `/artists/${artist.id}`;
    const embed = `<iframe src="${absUrl(`/embed/artists/${artist.id}`)}" width="100%" height="420" style="border:0;border-radius:12px" loading="lazy" title="${attr(artist.name)} on Inkwell"></iframe>`;
    return `<div class="card share-card">
      <div class="share-card__main">
        <h3>Share your portfolio</h3>
        <p class="muted small">Your profile link comes with a share card, so it looks right in messages and on social. The QR code works on flyers and studio counters. The embed puts your latest work on your own website.</p>
        <div class="share__link"><input readonly value="${attr(absUrl(path))}" aria-label="Profile link" data-link><button class="btn btn--sm" data-copy-profile>Copy</button></div>
        <div class="row" style="margin-top:10px">${shareButton({ title: `${artist.name} on Inkwell`, text: `${artist.name}${artist.studio_name ? ` · ${artist.studio_name}` : ''}: galleries, reviews and booking on Inkwell`, path, card: `/og/artists/${artist.id}.png` }, 'btn btn--sm')}<a class="btn btn--ghost btn--sm" href="/og/artists/${artist.id}.png" target="_blank" rel="noopener">Share card</a><a class="btn btn--ghost btn--sm" href="/embed/artists/${artist.id}" target="_blank" rel="noopener">Preview embed</a></div>
        <details style="margin-top:12px"><summary class="link small">Embed code for your website</summary><textarea readonly class="share-card__code" rows="3" aria-label="Embed code" data-embed>${esc(embed)}</textarea><div class="small faint" style="margin-top:4px">Add <code>?theme=light</code> or <code>&amp;limit=9</code> to the iframe address to match your site.</div></details>
      </div>
      <div class="share-card__qr"><img src="/api/share/qr.svg?url=${encodeURIComponent(path)}" alt="QR code for your profile" width="150" height="150"><span class="small muted">Scan to open your profile</span></div>
    </div>`;
  }

  /* ---------- messages ---------- */

  const MSG_FILTERS = [['all', 'All'], ['unread', 'Unread'], ['starred', 'Starred'], ['archived', 'Archived']];
  const UNSEND_MS = 15 * 60000;
  const draftKey = (id) => `inkwell_draft_${id}`;
  const readDraft = (id) => { try { return localStorage.getItem(draftKey(id)) || ''; } catch { return ''; } };
  const writeDraft = (id, text) => { try { if (text) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); } catch { /* storage unavailable */ } };

  const MSG_ICONS = {
    star: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/></svg>',
    starFilled: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/></svg>',
    photo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>',
    art: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2 0-1.2-1-1.5-1-2.5 0-1 .8-1.5 2-1.5h1.5A4.5 4.5 0 0 0 21 10.5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/></svg>',
    reply: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 12l16-8-5 16-3-6z"/></svg>',
    mute: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8a6 6 0 0 1 12 0v5l2 3H4l2-3z"/><path d="M4 4l16 16"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/></svg>',
  };

  function dayLabel(ts) {
    const d = parseDb(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function clockTime(ts) {
    const d = parseDb(ts);
    return d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  }

  function attachmentHtml(a) {
    if (a.type === 'image') return `<a class="bubble__photo" href="${attr(a.url)}" data-photo="${attr(a.url)}"><img src="${attr(a.thumb_url || a.url)}" alt="Photo" loading="lazy" ${a.width && a.height ? `style="aspect-ratio:${a.width}/${a.height}"` : ''}></a>`;
    if (a.type === 'artwork') return `<a class="bubble__art" href="/artworks/${a.id}"><img src="${attr(a.thumb_url)}" alt="" loading="lazy"><span><strong>${esc(a.title || 'Tattoo')}</strong><small>${esc(a.style || '')}</small></span></a>`;
    if (a.type === 'collection') return `<a class="bubble__art" href="/c/${attr(a.token)}">${a.thumb_url ? `<img src="${attr(a.thumb_url)}" alt="" loading="lazy">` : `<span class="bubble__art-icon">${SHARE_ICONS.save}</span>`}<span><strong>${esc(a.title || 'Board')}</strong><small>Reference board · ${a.item_count || 0} piece${a.item_count === 1 ? '' : 's'}</small></span></a>`;
    return '';
  }

  function bubbleHtml(m, me, seenId) {
    const mine = m.sender_id === me.id;
    const canUnsend = mine && !m.deleted && Date.now() - parseDb(m.created_at).getTime() < UNSEND_MS;
    const body = m.deleted ? '<em class="bubble__deleted">Message removed</em>' : `${(m.attachments || []).map(attachmentHtml).join('')}${m.body ? `<p>${esc(m.body).replace(/\n/g, '<br>')}</p>` : ''}`;
    return `<div class="bubble ${mine ? 'bubble--mine' : ''} ${m.deleted ? 'bubble--deleted' : ''}" data-id="${m.id}">
      ${body}
      <div class="bubble__meta"><time datetime="${attr(m.created_at)}">${clockTime(m.created_at)}</time>${canUnsend ? '<button type="button" class="bubble__unsend" data-unsend>Unsend</button>' : ''}</div>
      ${seenId === m.id ? `<span class="bubble__seen">${m.read_at ? 'Seen' : 'Delivered'}</span>` : ''}
    </div>`;
  }

  function messagesHtml(messages, me) {
    if (!messages.length) return '<p class="faint thread__empty">Say hello. Photos of the placement or reference ideas help a lot.</p>';
    const last = messages[messages.length - 1];
    const seenId = last.sender_id === me.id && !last.deleted ? last.id : null;
    let out = '';
    let lastDay = '';
    messages.forEach((m) => {
      const day = dayLabel(m.created_at);
      if (day !== lastDay) { out += `<div class="thread__day"><span>${esc(day)}</span></div>`; lastDay = day; }
      out += bubbleHtml(m, me, seenId);
    });
    return out;
  }

  function contextHtml(ctx, other, me) {
    if (!ctx) return '';
    const isArtist = me.role === 'artist';
    const next = ctx.next_appointment;
    const rows = [];
    if (next) rows.push(`<a class="ctx__item" href="/appointments"><span class="ctx__label">Next session</span><strong>${esc(fmtSlot(next.starts_at))}</strong><span class="small muted">${pill(next.status)}${next.deposit_amount ? ` · ${money(next.deposit_amount)} deposit` : ''}</span></a>`);
    else rows.push(`<div class="ctx__item"><span class="ctx__label">Next session</span><span class="muted">Nothing booked</span>${isArtist ? '' : `<a class="btn btn--sm" style="margin-top:8px" href="/book/${other.id}">Book a session</a>`}</div>`);
    rows.push(`<div class="ctx__stats"><div><strong>${ctx.completed_count}</strong><span>done</span></div><div><strong>${ctx.upcoming_count}</strong><span>upcoming</span></div><div><strong>${ctx.cancelled_count}</strong><span>cancelled</span></div><div><strong>${money(ctx.total_paid)}</strong><span>${isArtist ? 'paid you' : 'paid'}</span></div></div>`);
    if (ctx.open_requests.length) rows.push(`<div class="ctx__item"><span class="ctx__label">Open request${ctx.open_requests.length > 1 ? 's' : ''}</span>${ctx.open_requests.map((r) => `<a class="ctx__link" href="/requests/${r.id}"><strong>${esc(r.title)}</strong><span class="small muted">${esc(r.style || '')}${r.budget_min || r.budget_max ? ` · ${money(r.budget_min || 0)}–${money(r.budget_max || 0)}` : ''}${r.my_proposal ? ` · you proposed (${esc(r.my_proposal)})` : ''}</span></a>`).join('')}</div>`);
    if (ctx.recent.length) rows.push(`<div class="ctx__item"><span class="ctx__label">History</span>${ctx.recent.map((a) => `<div class="ctx__row"><span>${esc(fmtSlot(a.starts_at).split(',').slice(0, 2).join(','))}</span>${pill(a.status)}</div>`).join('')}</div>`);
    if (ctx.review) rows.push(`<div class="ctx__item"><span class="ctx__label">${isArtist ? 'Their review' : 'Your review'}</span><span>${'★'.repeat(ctx.review.rating)}<span class="faint">${'★'.repeat(5 - ctx.review.rating)}</span></span>${ctx.review.body ? `<span class="small muted">${esc(ctx.review.body.slice(0, 140))}</span>` : ''}</div>`);
    if (ctx.since) rows.push(`<div class="small faint">In touch since ${esc(parseDb(ctx.since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}</div>`);
    return `<div class="ctx"><div class="ctx__head"><h3>${isArtist ? 'About this client' : 'Your bookings'}</h3><button type="button" class="modal__close" data-close-context aria-label="Close details">×</button></div>${rows.join('')}</div>`;
  }

  function convoHtml(c, activeId, me) {
    const preview = `${c.last_sender_id === me.id ? 'You: ' : ''}${c.last_body}`;
    return `<a class="convo ${String(c.user_id) === String(activeId) ? 'active' : ''} ${c.unread ? 'convo--unread' : ''}" href="/messages/${c.user_id}${location.search}">
      ${avatar(c.avatar_url, c.name, 'avatar--sm')}
      <div class="convo__body">
        <div class="convo__name"><span>${esc(c.name)}${c.starred ? `<i class="convo__star">${MSG_ICONS.starFilled}</i>` : ''}${c.muted ? `<i class="convo__mute">${MSG_ICONS.mute}</i>` : ''}</span><span class="faint small">${timeAgo(c.last_at)}</span></div>
        <div class="convo__preview">${esc(preview)}</div>
      </div>
      ${c.unread ? `<span class="convo__unread">${c.unread}</span>` : ''}
    </a>`;
  }

  function expandReply(text, other, me) {
    const profile = me.profile || {};
    return text
      .replace(/\{first_name\}/g, (other.name || '').split(' ')[0])
      .replace(/\{name\}/g, other.name || '')
      .replace(/\{studio\}/g, profile.studio_name || me.name)
      .replace(/\{deposit\}/g, money(profile.deposit_amount || 0));
  }

  function openSavedReplies({ onInsert, other } = {}) {
    const me = state.user;
    let replies = [];
    const modal = openModal('<div class="modal__panel"><div class="modal__head"><div><h3>Saved replies</h3><p class="small muted">Answers you send often. Use {first_name}, {name}, {studio} and {deposit} and they are filled in.</p></div><button class="modal__close" data-close-modal aria-label="Close">×</button></div><div class="modal__body" data-replies><div class="loading">Loading</div></div></div>', { small: true });
    const box = modal.querySelector('[data-replies]');
    const editorHtml = (r = {}) => `<form class="reply-editor" data-editor data-id="${r.id || ''}">
        <input name="title" placeholder="Title, e.g. Deposit policy" value="${attr(r.title || '')}" required maxlength="60">
        <textarea name="body" placeholder="Reply text" required>${esc(r.body || '')}</textarea>
        <div class="row"><button class="btn btn--sm">${r.id ? 'Save' : 'Add reply'}</button><button type="button" class="btn btn--ghost btn--sm" data-cancel-edit>Cancel</button></div>
      </form>`;
    function render(editing = null) {
      box.innerHTML = `${replies.length ? `<div class="reply-list">${replies.map((r) => editing === r.id ? editorHtml(r) : `
        <div class="reply-item">
          <div class="reply-item__text">${onInsert ? `<button type="button" class="reply-item__insert" data-insert="${r.id}"><strong>${esc(r.title)}</strong><span>${esc(r.body.length > 140 ? `${r.body.slice(0, 140)}…` : r.body)}</span></button>` : `<strong>${esc(r.title)}</strong><span class="small muted">${esc(r.body)}</span>`}</div>
          <div class="reply-item__actions"><button type="button" class="link small" data-edit="${r.id}">Edit</button><button type="button" class="link small" data-delete="${r.id}">Delete</button></div>
        </div>`).join('')}</div>` : (editing === 'new' ? '' : '<p class="muted">No saved replies yet. Add the answers you type most: booking steps, deposit policy, aftercare.</p>')}
        ${editing === 'new' ? editorHtml() : '<button type="button" class="btn btn--ghost btn--sm" data-new style="margin-top:12px">New saved reply</button>'}`;
      const editor = box.querySelector('[data-editor]');
      if (editor) {
        editor.addEventListener('submit', async (e) => {
          e.preventDefault();
          const id = editor.dataset.id;
          try {
            const r = id ? await api.put(`/api/messages/saved-replies/${id}`, formData(editor)) : await api.post('/api/messages/saved-replies', formData(editor));
            replies = r.replies; render();
          } catch (err) { handleError(err); }
        });
        editor.querySelector('[data-cancel-edit]').addEventListener('click', () => render());
        editor.querySelector('input').focus();
      }
      box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => render(Number(b.dataset.edit))));
      box.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
        try { ({ replies } = await api.del(`/api/messages/saved-replies/${b.dataset.delete}`)); render(); } catch (err) { handleError(err); }
      }));
      box.querySelectorAll('[data-insert]').forEach((b) => b.addEventListener('click', () => {
        const r = replies.find((x) => String(x.id) === b.dataset.insert);
        if (r && onInsert) onInsert(expandReply(r.body, other || {}, me));
        closeModal();
      }));
      const add = box.querySelector('[data-new]');
      if (add) add.addEventListener('click', () => render('new'));
    }
    api.get('/api/messages/saved-replies').then((r) => { replies = r.replies; render(); }).catch((err) => handleError(err));
  }

  function openPhoto(url) {
    openModal(`<div class="modal__photo"><img src="${attr(url)}" alt="Photo"><button class="modal__close" data-close-modal aria-label="Close">×</button></div>`, { small: true });
    modalRoot.querySelector('.modal').classList.add('modal--photo');
  }

  function openArtworkPicker(onPick) {
    const me = state.user;
    const modal = openModal('<div class="modal__panel"><div class="modal__head"><h3>Share a tattoo</h3><button class="modal__close" data-close-modal aria-label="Close">×</button></div><div class="modal__body" data-grid><div class="loading">Loading</div></div></div>', { small: true });
    const grid = modal.querySelector('[data-grid]');
    api.get('/api/feed', { artist_id: me.id, limit: 60 }).then((r) => {
      const items = r.artworks || r.items || [];
      grid.innerHTML = items.length ? `<div class="pick-grid">${items.map((a) => `<button type="button" class="pick" data-pick="${a.id}" title="${attr(a.title)}"><img src="${attr(a.thumb_url || a.image_url)}" alt="${attr(a.title)}" loading="lazy"><span>${esc(a.title)}</span></button>`).join('')}</div>` : '<p class="muted">Upload some work to a gallery first.</p>';
      grid.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { const a = items.find((x) => String(x.id) === b.dataset.pick); closeModal(); onPick(a); }));
    }).catch((err) => handleError(err));
  }

  async function viewMessages(otherId, params) {
    if (!requireLogin(otherId ? `/messages/${otherId}` : '/messages')) return;
    loading();
    const me = state.user;
    const filter = MSG_FILTERS.some(([k]) => k === params.get('filter')) ? params.get('filter') : 'all';
    const q = params.get('q') || '';
    let inbox;
    try { inbox = await api.get('/api/messages', { filter, q }); } catch (e) { return handleError(e); }

    main.innerHTML = `
      <div class="inbox-page ${otherId ? 'inbox-page--thread' : ''}">
      <div class="page-head">
        <div><h1>Messages</h1><p class="muted">${me.role === 'artist' ? 'Clients, requests and bookings in one inbox.' : 'Your conversations with artists.'}</p></div>
        <div class="row">
          ${me.role === 'artist' ? `<button class="btn btn--ghost btn--sm" data-saved-replies>${MSG_ICONS.reply} Saved replies</button>` : ''}
          <button class="btn btn--ghost btn--sm" data-read-all ${inbox.counts.unread ? '' : 'disabled'}>Mark all read</button>
        </div>
      </div>
      <div class="inbox ${otherId ? 'inbox--thread' : ''}" data-inbox>
        <aside class="inbox__list" data-list>
          <form class="inbox__search" data-search role="search"><input type="search" name="q" placeholder="Search people and messages" value="${attr(q)}" aria-label="Search messages"></form>
          <div class="inbox__filters chips" data-filters></div>
          <div class="inbox__convos" data-convos></div>
        </aside>
        <section class="inbox__thread" data-thread aria-live="polite">
          ${otherId ? '<div class="loading">Loading</div>' : `<div class="empty inbox__blank"><h3>${inbox.conversations.length ? 'Pick a conversation' : 'No conversations yet'}</h3><p>${me.role === 'artist' ? 'Clients who message you or book a session show up here.' : 'Message an artist from their profile to get started.'}</p></div>`}
        </section>
        <aside class="inbox__context" data-context hidden></aside>
      </div>
      </div>`;

    const listEl = $('[data-convos]');
    const filtersEl = $('[data-filters]');
    const threadEl = $('[data-thread]');
    const contextEl = $('[data-context]');
    const inboxEl = $('[data-inbox]');
    const link = (f, query) => `/messages${otherId ? `/${otherId}` : ''}${(() => { const p = new URLSearchParams(); if (f !== 'all') p.set('filter', f); if (query) p.set('q', query); const s = p.toString(); return s ? `?${s}` : ''; })()}`;

    function renderList() {
      filtersEl.innerHTML = MSG_FILTERS.map(([k, label]) => `<a class="chip ${k === inbox.filter ? 'active' : ''}" href="${link(k, inbox.q)}">${label}${inbox.counts[k] && (k === 'unread' || k === 'archived') ? ` <b>${inbox.counts[k]}</b>` : ''}</a>`).join('');
      listEl.innerHTML = inbox.conversations.length ? inbox.conversations.map((c) => convoHtml(c, otherId, me)).join('')
        : `<div class="empty inbox__none"><p>${inbox.q ? 'Nothing matches that search.' : inbox.filter === 'unread' ? 'You are all caught up.' : inbox.filter === 'starred' ? 'Star conversations you want to find fast.' : inbox.filter === 'archived' ? 'Archived conversations land here.' : 'No conversations yet.'}</p></div>`;
      const readAll = $('[data-read-all]');
      if (readAll) readAll.disabled = !inbox.counts.unread;
    }
    async function refreshList() {
      try { inbox = await api.get('/api/messages', { filter, q }); renderList(); } catch { /* keep what we have */ }
    }
    renderList();

    $('[data-search]').addEventListener('submit', (e) => { e.preventDefault(); navigate(link(filter, e.target.q.value.trim())); });
    $('[data-read-all]').addEventListener('click', async () => {
      try { await api.post('/api/messages/read-all'); await refreshList(); refreshUnread(); toast('Everything marked as read'); } catch (err) { handleError(err); }
    });
    const savedBtn = $('[data-saved-replies]');
    if (savedBtn) savedBtn.addEventListener('click', () => openSavedReplies());

    /* live updates: server-sent events when the session is a cookie, polling otherwise */
    let thread = null; // { other, messages, state, context, has_more }
    const handlers = {
      message: async (data) => {
        if (thread && data.from === thread.other.id) {
          thread.messages.push(data.message);
          renderThreadBody(true);
          try { await api.post(`/api/messages/${thread.other.id}/read`); } catch { /* ignore */ }
        }
        refreshList(); refreshUnread();
      },
      sent: (data) => { if (thread && data.to === thread.other.id && !thread.messages.some((m) => m.id === data.message.id)) { thread.messages.push(data.message); renderThreadBody(true); } refreshList(); },
      read: (data) => { if (thread && data.by === thread.other.id) { thread.messages.forEach((m) => { if (m.sender_id === me.id && !m.read_at) m.read_at = data.at; }); renderThreadBody(false); } },
      unsent: (data) => { if (thread && data.from === thread.other.id) { const i = thread.messages.findIndex((m) => m.id === data.message.id); if (i >= 0) thread.messages[i] = data.message; renderThreadBody(false); } refreshList(); },
    };
    let es = null;
    let poll = null;
    function startPolling() {
      if (poll) return;
      poll = setInterval(async () => {
        if (thread) {
          try {
            const r = await api.get(`/api/messages/${thread.other.id}`);
            const changed = r.messages.length !== thread.messages.length || (r.messages.length && (r.messages[r.messages.length - 1].id !== thread.messages[thread.messages.length - 1].id || (r.messages[r.messages.length - 1].read_at || '') !== (thread.messages[thread.messages.length - 1].read_at || '')));
            if (changed) { thread.messages = r.messages; thread.has_more = r.has_more; renderThreadBody(true); }
          } catch { /* ignore */ }
        }
        refreshList(); refreshUnread();
      }, 8000);
    }
    if (window.EventSource && !isNative()) {
      es = new EventSource('/api/messages/stream');
      Object.keys(handlers).forEach((name) => es.addEventListener(name, (e) => { try { handlers[name](JSON.parse(e.data)); } catch { /* ignore */ } }));
      es.onerror = () => { if (es.readyState === EventSource.CLOSED) { es = null; startPolling(); } };
    } else startPolling();
    onCleanup(() => { if (es) es.close(); if (poll) clearInterval(poll); });

    if (!otherId) return;

    /* ---- thread ---- */
    let stickToBottom = true;
    function bodyEl() { return $('[data-body]', threadEl); }

    function renderThreadBody(scroll) {
      const body = bodyEl();
      if (!body) return;
      const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
      body.innerHTML = `${thread.has_more ? '<button type="button" class="btn btn--ghost btn--sm thread__more" data-more>Load earlier messages</button>' : ''}${messagesHtml(thread.messages, me)}`;
      if (scroll || nearBottom || stickToBottom) body.scrollTop = body.scrollHeight;
      stickToBottom = false;
      const more = $('[data-more]', body);
      if (more) more.addEventListener('click', async () => {
        more.disabled = true;
        try {
          const r = await api.get(`/api/messages/${thread.other.id}`, { before: thread.messages[0].id });
          const before = body.scrollHeight;
          thread.messages = [...r.messages, ...thread.messages];
          thread.has_more = r.has_more;
          renderThreadBody(false);
          body.scrollTop = body.scrollHeight - before;
        } catch (err) { handleError(err); more.disabled = false; }
      });
      $$('[data-unsend]', body).forEach((b) => b.addEventListener('click', async () => {
        const bubble = b.closest('.bubble');
        try {
          const r = await api.del(`/api/messages/${thread.other.id}/messages/${bubble.dataset.id}`);
          const i = thread.messages.findIndex((m) => String(m.id) === bubble.dataset.id);
          if (i >= 0) thread.messages[i] = r.message;
          renderThreadBody(false); refreshList();
        } catch (err) { handleError(err); }
      }));
      $$('[data-photo]', body).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openPhoto(a.dataset.photo); }));
    }

    function stateMenu() {
      const s = thread.state;
      const item = (action, label) => `<button type="button" class="menu__item" data-action="${action}">${label}</button>`;
      return `<details class="menu" data-menu>
        <summary class="btn btn--ghost btn--sm" aria-label="Conversation options">More</summary>
        <div class="menu__list">
          ${item('star', s.starred ? 'Unstar' : 'Star')}
          ${item('mute', s.muted ? 'Unmute notifications' : 'Mute notifications')}
          ${item('archive', s.archived ? 'Move to inbox' : 'Archive')}
          ${item('unread', 'Mark as unread')}
          <hr>
          ${item('block', s.blocked ? 'Unblock' : 'Block')}
          ${item('report', 'Report')}
        </div>
      </details>`;
    }

    function composeHtml() {
      const s = thread.state;
      if (s.blocked) return `<div class="thread__notice">You blocked ${esc(thread.other.name)}. <button type="button" class="link" data-action="block">Unblock</button> to message them again.</div>`;
      if (s.blocked_by) return '<div class="thread__notice">You cannot message this person.</div>';
      if (thread.other.suspended) return '<div class="thread__notice">This account is no longer active.</div>';
      return `<form class="thread__compose" data-compose>
        <div class="compose__pending" data-pending hidden></div>
        <div class="compose__row">
          <label class="compose__tool" title="Attach a photo"><input type="file" name="image" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-file>${MSG_ICONS.photo}<span class="sr-only">Attach a photo</span></label>
          ${me.role === 'artist' ? `<button type="button" class="compose__tool" title="Share a tattoo from your galleries" data-share-art>${MSG_ICONS.art}<span class="sr-only">Share a tattoo</span></button><button type="button" class="compose__tool" title="Insert a saved reply" data-insert-reply>${MSG_ICONS.reply}<span class="sr-only">Saved replies</span></button>` : `<button type="button" class="compose__tool" title="Share one of your boards" data-share-board>${SHARE_ICONS.save}<span class="sr-only">Share a board</span></button>`}
          <textarea name="body" rows="1" placeholder="Message" aria-label="Message">${esc(readDraft(thread.other.id))}</textarea>
          <button class="btn compose__send" aria-label="Send">${MSG_ICONS.send}</button>
        </div>
        <div class="small faint compose__hint">Enter to send, Shift+Enter for a new line.</div>
      </form>`;
    }

    function renderThread() {
      const o = thread.other;
      const s = thread.state;
      threadEl.innerHTML = `
        <div class="thread__head">
          <a href="/messages${location.search}" class="thread__back" aria-label="Back to inbox">←</a>
          ${avatar(o.avatar_url, o.name, 'avatar--sm')}
          <div class="thread__who">
            ${o.role === 'artist' ? `<a href="/artists/${o.id}"><strong>${esc(o.name)}</strong></a>` : `<strong>${esc(o.name)}</strong>`}${s.starred ? `<i class="convo__star">${MSG_ICONS.starFilled}</i>` : ''}
            <div class="small muted">${o.role === 'artist' ? `${esc(o.studio_name || 'Artist')}${o.replies_within ? ` · ${esc(o.replies_within)}` : ''}` : `Client${o.location ? `<span class="thread__loc"> · ${esc(o.location)}</span>` : ''}`}</div>
          </div>
          <div class="thread__actions">
            ${thread.context ? `<button type="button" class="btn btn--ghost btn--sm thread__details" data-toggle-context>${MSG_ICONS.info}<span>Details</span></button>` : ''}
            ${me.role === 'client' && o.role === 'artist' ? `<a class="btn btn--sm" href="/book/${o.id}">Book</a>` : ''}
            ${stateMenu()}
          </div>
        </div>
        ${s.muted ? '<div class="thread__notice thread__notice--soft">Notifications are muted for this conversation.</div>' : ''}
        <div class="thread__body" data-body></div>
        ${composeHtml()}`;
      contextEl.innerHTML = contextHtml(thread.context, o, me);
      contextEl.hidden = !thread.context;
      renderThreadBody(true);
      bindThread();
    }

    async function setState(patch) {
      try { const r = await api.patch(`/api/messages/${thread.other.id}`, patch); thread.state = r.state; renderThread(); refreshList(); } catch (err) { handleError(err); }
    }

    function bindThread() {
      const toggle = $('[data-toggle-context]', threadEl);
      if (toggle) toggle.addEventListener('click', () => inboxEl.classList.toggle('inbox--context'));
      const closeCtx = $('[data-close-context]', contextEl);
      if (closeCtx) closeCtx.addEventListener('click', () => inboxEl.classList.remove('inbox--context'));

      $$('[data-action]', threadEl).forEach((b) => b.addEventListener('click', async () => {
        const menu = $('[data-menu]', threadEl);
        if (menu) menu.open = false;
        const s = thread.state;
        const other = thread.other;
        switch (b.dataset.action) {
          case 'star': return setState({ starred: !s.starred });
          case 'mute': return setState({ muted: !s.muted });
          case 'archive': {
            await setState({ archived: !s.archived });
            toast(s.archived ? 'Moved back to your inbox' : 'Conversation archived');
            if (!s.archived) navigate('/messages');
            return undefined;
          }
          case 'unread':
            try { await api.post(`/api/messages/${other.id}/unread`); toast('Marked as unread'); navigate('/messages'); } catch (err) { handleError(err); }
            return undefined;
          case 'block':
            try {
              const r = s.blocked ? await api.del(`/api/messages/${other.id}/block`) : await api.post(`/api/messages/${other.id}/block`);
              thread.state = r.state; renderThread(); refreshList();
              toast(s.blocked ? `${other.name} unblocked` : `${other.name} blocked. They can no longer message you.`);
            } catch (err) { handleError(err); }
            return undefined;
          case 'report': return reportModal('user', other.id, other.role);
          default: return undefined;
        }
      }));

      const form = $('[data-compose]', threadEl);
      if (!form) return;
      const textarea = form.body;
      const fileInput = $('[data-file]', form);
      const pendingEl = $('[data-pending]', form);
      let pendingFile = null;
      let pendingArt = null;
      let pendingBoard = null;
      const autosize = () => { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`; };
      autosize();
      textarea.addEventListener('input', () => { autosize(); writeDraft(thread.other.id, textarea.value); });
      textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
      function renderPending() {
        const bits = [];
        if (pendingFile) bits.push(`<span class="pending"><img src="${attr(URL.createObjectURL(pendingFile))}" alt=""><span>${esc(pendingFile.name)}</span><button type="button" data-clear-file aria-label="Remove photo">×</button></span>`);
        if (pendingArt) bits.push(`<span class="pending"><img src="${attr(pendingArt.thumb_url || pendingArt.image_url)}" alt=""><span>${esc(pendingArt.title)}</span><button type="button" data-clear-art aria-label="Remove tattoo">×</button></span>`);
        if (pendingBoard) bits.push(`<span class="pending">${pendingBoard.cover_url ? `<img src="${attr(pendingBoard.cover_url)}" alt="">` : ''}<span>Board: ${esc(pendingBoard.title)}</span><button type="button" data-clear-board aria-label="Remove board">×</button></span>`);
        pendingEl.innerHTML = bits.join('');
        pendingEl.hidden = !bits.length;
        const cf = $('[data-clear-file]', pendingEl); if (cf) cf.addEventListener('click', () => { pendingFile = null; fileInput.value = ''; renderPending(); });
        const ca = $('[data-clear-art]', pendingEl); if (ca) ca.addEventListener('click', () => { pendingArt = null; renderPending(); });
        const cb = $('[data-clear-board]', pendingEl); if (cb) cb.addEventListener('click', () => { pendingBoard = null; renderPending(); });
      }
      fileInput.addEventListener('change', () => { pendingFile = fileInput.files[0] || null; renderPending(); textarea.focus(); });
      const share = $('[data-share-art]', form);
      if (share) share.addEventListener('click', () => openArtworkPicker((a) => { pendingArt = a; renderPending(); textarea.focus(); }));
      const shareBoard = $('[data-share-board]', form);
      if (shareBoard) shareBoard.addEventListener('click', () => boardPicker((c) => { pendingBoard = c; renderPending(); textarea.focus(); }));
      const insert = $('[data-insert-reply]', form);
      if (insert) insert.addEventListener('click', () => openSavedReplies({ other: thread.other, onInsert: (text) => { textarea.value = textarea.value ? `${textarea.value.replace(/\s+$/, '')}\n${text}` : text; autosize(); writeDraft(thread.other.id, textarea.value); textarea.focus(); } }));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = textarea.value.trim();
        if (!text && !pendingFile && !pendingArt && !pendingBoard) return;
        const send = $('.compose__send', form);
        send.disabled = true;
        try {
          let r;
          if (pendingFile) {
            const fd = new FormData();
            fd.append('body', text);
            fd.append('image', pendingFile);
            if (pendingArt) fd.append('artwork_id', pendingArt.id);
            if (pendingBoard) fd.append('collection_id', pendingBoard.id);
            r = await api.post(`/api/messages/${thread.other.id}`, fd);
          } else {
            r = await api.post(`/api/messages/${thread.other.id}`, { body: text, artwork_id: pendingArt ? pendingArt.id : undefined, collection_id: pendingBoard ? pendingBoard.id : undefined });
          }
          textarea.value = ''; autosize(); writeDraft(thread.other.id, '');
          pendingFile = null; pendingArt = null; pendingBoard = null; fileInput.value = ''; renderPending();
          if (!thread.messages.some((m) => m.id === r.message.id)) thread.messages.push(r.message);
          if (thread.state.archived) thread.state.archived = false;
          renderThreadBody(true); refreshList();
        } catch (err) { handleError(err); } finally { send.disabled = false; textarea.focus(); }
      });
    }

    try {
      const r = await api.get(`/api/messages/${otherId}`);
      thread = { other: r.other, messages: r.messages, has_more: r.has_more, state: r.state, context: r.context };
    } catch (err) {
      threadEl.innerHTML = `<div class="empty inbox__blank"><h3>${err.status === 404 ? 'User not found' : 'Could not open this conversation'}</h3><p>${esc(err.message || '')}</p></div>`;
      return;
    }
    renderThread();
    refreshUnread();
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
      ${portfolioShareCard(artist)}
      <div class="tabs" style="margin-top:24px">
        <button data-tab="galleries" class="${tab === 'galleries' ? 'active' : ''}">Galleries</button>
        <button data-tab="flash" class="${tab === 'flash' ? 'active' : ''}">Flash</button>
        <button data-tab="stencils" class="${tab === 'stencils' ? 'active' : ''}">Stencils</button>
        <button data-tab="availability" class="${tab === 'availability' ? 'active' : ''}">Availability</button>
        <button data-tab="bookings" class="${tab === 'bookings' ? 'active' : ''}">Bookings${pending ? ` (${pending})` : ''}</button>
        <button data-tab="proposals" class="${tab === 'proposals' ? 'active' : ''}">Proposals</button>
        <button data-tab="payments" class="${tab === 'payments' ? 'active' : ''}">Payments</button>
        <button data-tab="waitlist" class="${tab === 'waitlist' ? 'active' : ''}">Waitlist</button>
        <a href="/analytics" class="tab-link">Analytics ↗</a>
      </div>
      <div data-panel></div>`;

    const panel = $('[data-panel]');
    const renderTab = (name) => {
    bindShare();
    const copyProfile = $('[data-copy-profile]');
    if (copyProfile) copyProfile.addEventListener('click', async () => { toast((await copyText(absUrl(`/artists/${me.id}`))) ? 'Profile link copied' : 'Could not copy'); });
    const embedCode = $('[data-embed]');
    if (embedCode) embedCode.addEventListener('focus', (e) => e.target.select());
      $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      if (name === 'waitlist') {
        panel.innerHTML = '<div class="loading">Loading</div>';
        const load = () => api.get('/api/waitlist').then(({ entries }) => {
          panel.innerHTML = `
            <div class="section__head"><h2>Waitlist</h2><span class="muted small">${entries.length} waiting</span></div>
            <p class="small muted" style="margin-top:-6px">Clients queue here from your profile. When a booked slot frees up the first five whose window covers it are told automatically; when you reopen your books everyone is. Invite anyone to book now.</p>
            ${entries.length ? `<div class="grid grid--2">${entries.map((w) => waitlistEntryHtml(w, { artistView: true })).join('')}</div>` : '<div class="empty"><h3>Nobody waiting</h3><p>Clients can join from your profile, especially while your books are closed.</p></div>'}`;
          bindWaitlistEntries(panel, load);
        }).catch((err) => handleError(err));
        load();
        return;
      }
      if (name === 'stencils') { renderStencilLibrary(panel); return; }
      if (name === 'flash') {
        panel.innerHTML = '<div class="loading">Loading</div>';
        api.get('/api/flash', { mine: '1', limit: 60 }).then(({ flash }) => {
          panel.innerHTML = `
            <div class="section__head"><h2>Flash</h2><button class="btn btn--sm" data-new-flash>New flash design</button></div>
            <p class="small muted" style="margin-top:-6px">Pre-drawn designs at a fixed price. Clients book them straight from the <a class="link" href="/flash">flash board</a> and your profile; one-off designs leave the board when claimed.</p>
            ${flash.length ? `<div class="grid-art">${flash.map((f) => flashCard(f, { manage: true })).join('')}</div>` : '<div class="empty"><h3>No flash yet</h3><p>Post a design with a price and let clients claim it.</p></div>'}`;
          $('[data-new-flash]', panel).addEventListener('click', () => newFlashModal((f) => navigate(`/flash/${f.id}`)));
        }).catch((err) => handleError(err));
        return;
      }
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
      <section class="section" data-client-reviews></section>
      <section class="section" data-boards><div class="section__head"><h2>Your boards</h2><a class="link" href="/collections">All boards</a></div><div class="loading">Loading</div></section>
      <section class="section">
        <div class="section__head"><h2>Payments</h2></div>
        ${paymentsTable(pay.payments)}
      </section>`;
    bindApptActions(main, viewClientDashboard);
    clientReviewsSection($('[data-client-reviews]'), viewClientDashboard);
    api.get('/api/collections').then(({ collections }) => {
      const el = $('[data-boards]');
      if (!el) return;
      el.innerHTML = `<div class="section__head"><h2>Your boards</h2><a class="link" href="/collections">${collections.length ? 'All boards' : 'New board'}</a></div>${collections.length ? `<div class="grid grid--3 boards">${collections.slice(0, 3).map((c) => boardCard(c)).join('')}</div>` : '<div class="empty"><p>Save tattoos you like into boards, then share a board with an artist or attach it to a request.</p></div>'}`;
    }).catch(() => {});
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
          <label class="check"><input type="checkbox" name="session_reminders" ${u.session_reminders !== false ? 'checked' : ''}> Remind me the day before and two hours before a session</label>
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
        <div class="card" style="margin-top:14px" data-push-card><div class="loading">Loading</div></div>
        <div class="card" style="margin-top:14px" id="calendar" data-calendar-card><div class="loading">Loading</div></div>
        ${u.role === 'artist' ? '<div class="card" style="margin-top:14px" id="consent" data-consent-card><div class="loading">Loading</div></div>' : ''}
        <div class="card" style="margin-top:14px">
          <h3>Your account</h3>
          <div class="list-item"><div><strong>Download your data</strong><div class="small muted">Everything we hold about you, as a JSON file.</div></div><a class="btn btn--ghost btn--sm" href="/api/auth/me/export" download rel="external">Export</a></div>
          <div class="list-item"><div><strong>Sign out everywhere</strong><div class="small muted">Ends every session, including this one.</div></div><button class="btn btn--ghost btn--sm" data-logout-all>Sign out all</button></div>
          <div class="list-item"><div><strong>Delete account</strong><div class="small muted">Removes your profile, galleries, requests and messages. Payment records are kept without your details.</div></div><button class="btn btn--danger btn--sm" data-delete-account>Delete</button></div>
        </div>
      </div>`;
    renderPushCard($('[data-push-card]'));
    renderCalendarCard($('[data-calendar-card]'));
    renderConsentSettings($('[data-consent-card]'));
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
      data.session_reminders = form.session_reminders.checked;
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
        if (isNative()) enableNativePush().catch(() => {});
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

  /* ---------- notifications ---------- */

  async function viewNotifications() {
    if (!requireLogin('/notifications')) return;
    loading();
    let r;
    try { r = await api.get('/api/notifications', { limit: 100 }); } catch (e) { return handleError(e); }
    main.innerHTML = `
      <div class="page-head">
        <div><h1>Notifications</h1><p class="muted">Bookings, payments, proposals and messages, in one place.</p></div>
        <div class="row">${r.unread ? '<button class="btn btn--ghost btn--sm" data-read-all>Mark all read</button>' : ''}<a class="btn btn--subtle btn--sm" href="/settings#notifications">Settings</a></div>
      </div>
      ${r.notifications.length ? `<div class="stack">${r.notifications.map((n) => `
        <a class="card notif ${n.read_at ? '' : 'notif--unread'}" href="${attr(n.url || '/notifications')}" data-notif="${n.id}">
          <div class="row row--between"><strong>${esc(n.title)}</strong><span class="faint small">${timeAgo(n.created_at)}</span></div>
          ${n.body ? `<div class="muted small" style="margin-top:4px">${esc(n.body)}</div>` : ''}
        </a>`).join('')}</div>` : '<div class="empty"><h3>Nothing yet</h3><p>When something happens with your bookings or messages it shows up here.</p></div>'}`;
    const readAll = $('[data-read-all]');
    if (readAll) readAll.addEventListener('click', async () => { await api.post('/api/notifications/read', { all: true }); state.notifUnread = 0; renderNav(); viewNotifications(); });
    $$('[data-notif]').forEach((a) => a.addEventListener('click', () => {
      if (a.classList.contains('notif--unread')) api.post('/api/notifications/read', { id: Number(a.dataset.notif) }).then((x) => { state.notifUnread = x.unread; renderNav(); }).catch(() => {});
    }));
  }

  async function renderPushCard(box) {
    const u = state.user;
    let status = 'unsupported';
    let sub = null;
    if (isNative()) status = 'native';
    else if (pushSupported()) {
      sub = await currentPushSubscription().catch(() => null);
      status = Notification.permission === 'denied' ? 'blocked' : (sub ? 'on' : 'off');
    } else if (isIOS() && !isStandalone()) status = 'ios-install';
    const lines = {
      unsupported: 'This browser cannot receive push notifications. Email notifications still work.',
      'ios-install': 'On iPhone and iPad, add Inkwell to your home screen first (Share → Add to Home Screen), then enable notifications here.',
      blocked: 'Notifications are blocked for this site in your browser settings.',
      off: 'Get alerts on this device for booking requests, payments, proposals and messages.',
      on: 'This device receives push notifications.',
      native: 'Notifications are delivered through the Inkwell app on this phone.',
    };
    box.innerHTML = `
      <h3 id="notifications">Notifications on this device</h3>
      <p class="muted small">${lines[status]}</p>
      <div class="row">
        ${status === 'off' ? '<button class="btn btn--sm" data-push-on>Enable push notifications</button>' : ''}
        ${status === 'on' ? '<button class="btn btn--ghost btn--sm" data-push-off>Turn off on this device</button><button class="btn btn--subtle btn--sm" data-push-test>Send a test</button>' : ''}
        ${status === 'native' ? '<button class="btn btn--sm" data-push-on>Allow notifications</button><button class="btn btn--subtle btn--sm" data-push-test>Send a test</button>' : ''}
        ${status === 'ios-install' || (!isStandalone() && !isNative() && state.installPrompt) ? '<button class="btn btn--ghost btn--sm" data-install>Add to home screen</button>' : ''}
      </div>
      <label class="check small" style="margin-top:12px"><input type="checkbox" data-push-pref ${u.push_notifications !== false ? 'checked' : ''}> Send me push notifications about bookings, payments, proposals and messages</label>`;
    const on = $('[data-push-on]', box); const off = $('[data-push-off]', box); const test = $('[data-push-test]', box); const install = $('[data-install]', box);
    if (on) on.addEventListener('click', async () => { try { if (await enablePush()) { toast('Push notifications enabled'); renderPushCard(box); } } catch (err) { handleError(err); } });
    if (off) off.addEventListener('click', async () => { try { await disablePush(); toast('Push turned off on this device'); renderPushCard(box); } catch (err) { handleError(err); } });
    if (test) test.addEventListener('click', async () => { try { const r = await api.post('/api/push/test'); toast(r.sent ? 'Test notification sent' : 'No device could be reached', r.sent ? 'ok' : 'error'); } catch (err) { handleError(err); } });
    if (install) install.addEventListener('click', promptInstall);
    $('[data-push-pref]', box).addEventListener('change', async (e) => {
      try { const r = await api.put('/api/auth/me', { push_notifications: e.target.checked }); state.user = r.user; toast(e.target.checked ? 'Push notifications on' : 'Push notifications off'); } catch (err) { handleError(err); }
    });
  }

  /* ---------- artist analytics ---------- */

  const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HOURS = Array.from({ length: 24 }, (_, h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`);

  function deltaHtml(current, previous, { money: isMoney = false, upIsGood = true } = {}) {
    if (!previous && !current) return '<span class="viz-delta viz-delta--flat">no change</span>';
    if (!previous) return '<span class="viz-delta viz-delta--flat">new</span>';
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) return '<span class="viz-delta viz-delta--flat">→ same as before</span>';
    const up = pct > 0;
    const good = up === upIsGood;
    return `<span class="viz-delta ${good ? 'viz-delta--good' : 'viz-delta--bad'}" title="Previous period: ${isMoney ? charts.money(previous) : charts.compact(previous)}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
  }

  function vizCard(id, title, subtitle, extra = '') {
    return `
      <figure class="viz-card" data-viz="${id}">
        <figcaption class="viz-card__head">
          <div><h3>${esc(title)}</h3>${subtitle ? `<div class="small muted">${esc(subtitle)}</div>` : ''}</div>
          <div class="row">${extra}<button type="button" class="chip" data-viz-toggle aria-pressed="false">Table</button></div>
        </figcaption>
        <div class="viz-card__plot" data-plot></div>
        <div class="viz-card__table" data-table hidden></div>
      </figure>`;
  }

  async function viewAnalytics(params) {
    if (!requireLogin('/analytics')) return;
    if (state.user.role !== 'artist') { main.innerHTML = '<div class="empty"><h3>Analytics are for artist accounts</h3></div>'; return; }
    const rangeKey = ['7d', '30d', '90d', '12m'].includes(params.get('range')) ? params.get('range') : '30d';
    const first = !$('.analytics');
    if (first) loading(); else main.classList.add('viz-loading');
    let r;
    try { r = await api.get('/api/artists/me/analytics', { range: rangeKey }); } catch (e) { main.classList.remove('viz-loading'); return handleError(e); }
    const sm = r.summary; const pv = r.previous;
    const labels = r.series.map((b) => b.label);
    const pick = (k) => r.series.map((b) => b[k]);
    const money = charts.money; const num = charts.compact;

    main.innerHTML = `
      <div class="analytics">
        <div class="page-head">
          <div><h1>Analytics</h1><p class="muted">How people find you, book you, and what they pay. ${esc(r.range.label)}, compared with the ${r.range.days} days before.</p></div>
        </div>
        <div class="filters viz-filters" role="group" aria-label="Date range">
          ${[['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months']].map(([k, l]) => `<a class="chip ${k === rangeKey ? 'active' : ''}" href="/analytics?range=${k}">${k === rangeKey ? '✓ ' : ''}${l}</a>`).join('')}
          <a class="btn btn--ghost btn--sm" style="margin-left:auto" href="/api/artists/me/analytics/export.csv?range=${rangeKey}" download rel="external">Export bookings CSV</a>
        </div>

        <section class="viz-hero">
          <div class="viz-hero__label">Revenue collected</div>
          <div class="viz-hero__value">${money(sm.revenue)}</div>
          <div class="row">${deltaHtml(sm.revenue, pv.revenue, { money: true })}<span class="muted small">${sm.completed} completed session${sm.completed === 1 ? '' : 's'}${sm.avg_session_value ? ` · ${money(sm.avg_session_value)} average` : ''}</span></div>
        </section>

        <div class="kpis viz-kpis">
          <div class="kpi"><span>Profile views</span><strong>${num(sm.profile_views)}</strong><div class="row row--between">${deltaHtml(sm.profile_views, pv.profile_views)}<span data-spark="profile_views"></span></div></div>
          <div class="kpi"><span>Unique visitors</span><strong>${num(sm.unique_visitors)}</strong><div class="row row--between">${deltaHtml(sm.unique_visitors, pv.unique_visitors)}<span class="faint small">${num(sm.artwork_views)} artwork views</span></div></div>
          <div class="kpi"><span>Booking requests</span><strong>${num(sm.booking_requests)}</strong><div class="row row--between">${deltaHtml(sm.booking_requests, pv.booking_requests)}<span data-spark="booking_requests"></span></div></div>
          <div class="kpi"><span>Confirmed</span><strong>${sm.confirmation_rate === null ? '–' : `${sm.confirmation_rate}%`}</strong><div class="faint small">${sm.confirmed} of ${sm.booking_requests} requests${sm.booking_conversion !== null ? ` · ${sm.booking_conversion}% of booking page views convert` : ''}</div></div>
          <div class="kpi"><span>New followers</span><strong>${num(sm.new_followers)}</strong><div class="row row--between">${deltaHtml(sm.new_followers, pv.new_followers)}<span data-spark="new_followers"></span></div></div>
          <div class="kpi"><span>Rating</span><strong>${sm.rating === null ? '–' : sm.rating}</strong><div class="faint small">${sm.review_count} review${sm.review_count === 1 ? '' : 's'} all time · ${sm.reviews_in_range} new</div></div>
        </div>

        ${vizCard('views', 'Views', 'Profile and artwork views per ' + r.range.bucket)}
        <div class="viz-grid">
          ${vizCard('revenue', 'Revenue', 'Deposits and balances collected per ' + r.range.bucket)}
          ${vizCard('bookings', 'Booking requests', 'New requests per ' + r.range.bucket)}
        </div>
        <div class="viz-grid">
          ${vizCard('funnel', 'Booking funnel', 'From the booking page to a finished session')}
          ${vizCard('clients', 'Clients', 'People who booked in this period')}
        </div>
        ${vizCard('heat', 'Busiest times', 'Confirmed and completed sessions by weekday and start hour')}
        <div class="viz-grid">
          ${vizCard('top', 'Top artworks', 'Most viewed pieces in this period')}
          ${vizCard('ratings', 'Ratings', 'All reviews, by stars')}
        </div>
        ${vizCard('demand', 'Demand for your styles', 'Open client requests right now, in the styles you list')}
      </div>`;
    main.classList.remove('viz-loading');

    const plot = (id) => $(`[data-viz="${id}"] [data-plot]`);
    const tbl = (id) => $(`[data-viz="${id}"] [data-table]`);
    const C = charts.TOKENS.series;

    ['profile_views', 'booking_requests', 'new_followers'].forEach((k) => { const el = $(`[data-spark="${k}"]`); if (el) charts.sparkline({ el, values: pick(k) }); });

    charts.line({ el: plot('views'), labels, series: [{ name: 'Profile views', values: pick('profile_views') }, { name: 'Artwork views', values: pick('artwork_views') }] });
    $('[data-viz="views"] .viz-card__head .row').insertAdjacentHTML('afterbegin', `<span class="viz-legend"><i style="background:${C[0]}"></i>Profile views <i style="background:${C[1]}"></i>Artwork views</span>`);
    charts.table({ el: tbl('views'), columns: ['Period', 'Profile views', 'Artwork views', 'Booking page views'], rows: r.series.map((b) => [b.label, b.profile_views, b.artwork_views, b.booking_page_views]) });

    charts.column({ el: plot('revenue'), labels, values: pick('revenue'), format: money });
    charts.table({ el: tbl('revenue'), columns: ['Period', 'Revenue'], rows: r.series.map((b) => [b.label, money(b.revenue)]) });

    charts.column({ el: plot('bookings'), labels, values: pick('booking_requests') });
    charts.table({ el: tbl('bookings'), columns: ['Period', 'Requests', 'Completed'], rows: r.series.map((b) => [b.label, b.booking_requests, b.completed]) });

    const funnelRows = r.funnel.map((f, i) => ({ label: f.stage, value: f.count, detail: i > 0 && r.funnel[i - 1].count ? `(${Math.round((f.count / r.funnel[i - 1].count) * 100)}%)` : '' }));
    charts.barsH({ el: plot('funnel'), rows: funnelRows, colors: charts.TOKENS.ordinal, labelWidth: 140 });
    charts.table({ el: tbl('funnel'), columns: ['Stage', 'Count', 'Of previous stage'], rows: funnelRows.map((f) => [f.label, f.value, f.detail.replace(/[()]/g, '') || '–']) });

    plot('clients').innerHTML = `
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        <div class="kpi"><strong>${r.clients.total}</strong><span>clients booked</span></div>
        <div class="kpi"><strong>${r.clients.new}</strong><span>first time with you</span></div>
        <div class="kpi"><strong>${r.clients.returning}</strong><span>returning</span></div>
      </div>
      <p class="small muted" style="margin:12px 0 0">${r.clients.total ? `${Math.round((r.clients.returning / r.clients.total) * 100)}% of the people who booked had been tattooed by you before.` : 'No bookings in this period yet.'}</p>`;
    charts.table({ el: tbl('clients'), columns: ['Clients', 'Count'], rows: [['Booked', r.clients.total], ['First time', r.clients.new], ['Returning', r.clients.returning]] });

    charts.heatmap({ el: plot('heat'), grid: r.heatmap, rowLabels: WEEKDAYS_SHORT, colLabels: HOURS });
    charts.table({ el: tbl('heat'), columns: ['Weekday', ...HOURS.slice(8, 22)], rows: r.heatmap.map((row, i) => [WEEKDAYS_SHORT[i], ...row.slice(8, 22)]) });

    plot('top').innerHTML = r.top_artworks.length ? `<div class="stack">${r.top_artworks.map((a, i) => `
      <a class="viz-top" href="/artworks/${a.id}" data-artwork-link>
        <span class="viz-top__rank">${i + 1}</span>
        <img src="${attr(a.thumb_url || a.image_url)}" alt="" width="44" height="55">
        <span class="viz-top__title"><strong>${esc(a.title)}</strong><span class="small muted">${esc(a.style || '')}</span></span>
        <span class="viz-top__nums"><strong>${num(a.views)}</strong><span class="small muted">views</span></span>
        <span class="viz-top__nums"><strong>${num(a.likes)}</strong><span class="small muted">likes</span></span>
      </a>`).join('')}</div>` : '<div class="empty"><p>No artwork views yet in this period.</p></div>';
    $$('[data-artwork-link]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openArtwork(a.getAttribute('href').split('/').pop()); }));
    charts.table({ el: tbl('top'), columns: ['Artwork', 'Views', 'Likes', 'Comments'], rows: r.top_artworks.map((a) => [a.title, a.views, a.likes, a.comments]) });

    const ratingRows = [5, 4, 3, 2, 1].map((k) => ({ label: `${k} star${k === 1 ? '' : 's'}`, value: r.ratings[k] }));
    charts.barsH({ el: plot('ratings'), rows: ratingRows, labelWidth: 80 });
    charts.table({ el: tbl('ratings'), columns: ['Stars', 'Reviews'], rows: ratingRows.map((x) => [x.label, x.value]) });

    if (r.demand.length) {
      charts.barsH({ el: plot('demand'), rows: r.demand.map((d) => ({ label: d.style, value: d.open_requests, detail: d.open_requests === 1 ? 'open request' : 'open requests' })), labelWidth: 130 });
    } else {
      plot('demand').innerHTML = '<div class="empty"><p>No open requests match your styles right now. <a class="link" href="/requests">Browse all requests</a>.</p></div>';
    }
    charts.table({ el: tbl('demand'), columns: ['Style', 'Open requests'], rows: r.demand.map((d) => [d.style, d.open_requests]) });

    $$('[data-viz-toggle]').forEach((b) => b.addEventListener('click', () => {
      const card = b.closest('[data-viz]');
      const showTable = card.querySelector('[data-table]').hidden;
      card.querySelector('[data-table]').hidden = !showTable;
      card.querySelector('[data-plot]').hidden = showTable;
      b.setAttribute('aria-pressed', String(showTable));
      b.classList.toggle('active', showTable);
      b.textContent = showTable ? 'Chart' : 'Table';
    }));
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
        <h3>What we collect</h3><p>Account details (name, email, password hash, location, bio, profile photo), the content you post (galleries, requests, proposals, messages, reviews), booking and payment records (amounts, status and the last four digits of a card, never the full number), consent forms you sign before a session (legal name, date of birth, health answers, signature, and the time, address and browser of signing), and technical logs (IP address, browser, pages requested) kept for security.</p>
        <h3>Consent forms</h3><p>Health answers are shared only with the artist for that session. Signed consent forms are the artist's liability record: when you delete your account the health answers are erased but the signed form with your name, date of birth and signature stays with the booking.</p>
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
    [/^\/flash$/, (_m, params) => viewFlashBoard(params)],
    [/^\/flash\/(\d+)$/, (m) => viewFlash(m[1])],
    [/^\/collections$/, () => viewCollections()],
    [/^\/c\/([A-Za-z0-9_-]+)$/, (m) => viewCollection(m[1])],
    [/^\/requests$/, (m, p) => viewRequests(p)],
    [/^\/requests\/new$/, (_m, params) => viewNewRequest(params)],
    [/^\/requests\/(\d+)$/, (m) => viewRequest(m[1])],
    [/^\/book\/(\d+)$/, (m, p) => viewBook(m[1], p)],
    [/^\/appointments$/, (_m, params) => viewAppointments(params)],
    [/^\/appointments\/(\d+)\/consent$/, (m) => viewConsent(m[1])],
    [/^\/messages$/, (_m, params) => viewMessages(null, params)],
    [/^\/messages\/(\d+)$/, (m, params) => viewMessages(m[1], params)],
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
    [/^\/notifications$/, () => viewNotifications()],
    [/^\/analytics$/, (m, p) => viewAnalytics(p)],
  ];

  function route() {
    if (!state.ready) return;
    cleanupFns.forEach((fn) => fn());
    cleanupFns = [];
    closeModal({ silent: true });
    if (window.charts) charts.hideTip();
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
    setupNativeBridge();
    registerServiceWorker();
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
