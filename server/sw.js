/* ══════════════════════════════════════════════════════════════════
   Harmony service worker
   ══════════════════════════════════════════════════════════════════
   index.html has registered this file since day one and it has never
   existed, so registration 404'd and the .catch() swallowed it in
   silence. Result: no offline, no install prompt, no update control.

   Strategy, and why each choice:

     /api/*        NEVER touched. Two reasons, either one sufficient:
                   it is Server-Sent Events, which a cache would buffer
                   into a single blob and destroy the streaming; and it
                   carries what someone typed when they were not okay,
                   which has no business sitting in a disk cache.

     navigations   Network-first, cache fallback. The whole app is one
                   HTML file, so cache-first would pin users to a stale
                   build until the cache name changed. Network-first
                   means an update lands on the next online load, and
                   the cached copy still works on the underground.

     same-origin   Cache-first. Icons and the manifest do not change
     assets        without a version bump.

     fonts         Stale-while-revalidate. Serve instantly from cache,
                   refresh quietly in the background.
   ══════════════════════════════════════════════════════════════════ */

const VERSION = 'harmony-v1';
const SHELL = `${VERSION}-shell`;
const FONTS = `${VERSION}-fonts`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll() is atomic: one 404 fails the whole install and leaves the
    // user with no worker at all. Individual puts degrade instead.
    await Promise.all(PRECACHE.map(u =>
      c.add(new Request(u, { cache: 'reload' })).catch(() => {})
    ));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ── Hard bypass. Not a cache miss — never seen by the worker at all.
  if (url.pathname.startsWith('/api/') || req.headers.get('accept') === 'text/event-stream') return;

  // ── Navigations: network first, fall back to the cached shell.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // ── Fonts: stale-while-revalidate.
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(FONTS);
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  // ── Same-origin assets: cache first.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(SHELL)).put(req, r.clone());
        return r;
      } catch {
        return Response.error();
      }
    })());
  }
});

// index.html can post {type:'SKIP_WAITING'} to adopt an update at a
// moment the user chose, rather than mid-sentence in a conversation.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
