/* Inkwell service worker: offline app shell, cached images, push notifications. */
/* global self, caches, clients */

const VERSION = '__VERSION__';
const SHELL_CACHE = `inkwell-shell-${VERSION}`;
const MEDIA_CACHE = 'inkwell-media-v1';
const SHELL = ['/', '/offline.html', `/css/style.css?v=${VERSION}`, `/js/api.js?v=${VERSION}`, `/js/charts.js?v=${VERSION}`, `/js/app.js?v=${VERSION}`, '/manifest.json', '/icon-192.png', '/icon-512.png'];
const MEDIA_LIMIT = 300;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('inkwell-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: network only, with a friendly JSON error when offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ error: 'You are offline. Check your connection and try again.', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Navigations: network first, then the cached shell, then the offline page.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        return fresh;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('/')) || (await cache.match('/offline.html')) || Response.error();
      }
    })());
    return;
  }

  // Uploaded images and static assets: cache first, refresh in the background.
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') || /\.(png|ico|json)$/.test(url.pathname)) {
    const cacheName = url.pathname.startsWith('/uploads/') ? MEDIA_CACHE : SHELL_CACHE;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(request);
      const refresh = fetch(request).then((res) => {
        if (res && res.ok) { cache.put(request, res.clone()); if (cacheName === MEDIA_CACHE) trimCache(MEDIA_CACHE, MEDIA_LIMIT); }
        return res;
      }).catch(() => null);
      return cached || (await refresh) || Response.error();
    })());
  }
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Inkwell', body: '', url: '/' };
  try { payload = { ...payload, ...event.data.json() }; } catch { payload.body = event.data ? event.data.text() : ''; }
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => 'focus' in c);
    if (existing) { existing.navigate(target); return existing.focus(); }
    return clients.openWindow(target);
  })());
});
