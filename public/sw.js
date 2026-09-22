// Our Diary — offline shell.
//
// This worker caches the shell that draws the diary, and the photos, which
// never change once written. The entries are not in this cache: store.js
// keeps a copy of them on the device, in IndexedDB, and the page draws from
// that copy when there is no signal. The server is still the source of
// truth — every pull goes to it, and replaces the copy.

const VERSION = 'diary-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const PHOTO_CACHE = `${VERSION}-photos`;
const PHOTO_KEEP = 80;

const SHELL = [
  '/',
  '/store.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

// keep the photo cache from growing without end
async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - PHOTO_KEEP))) {
    await cache.delete(k);
  }
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // entries always go to the server; the device's copy is store.js's, not this cache's
  if (url.pathname.startsWith('/api/')) return;

  // a photo, once written, is the same forever
  if (url.pathname.startsWith('/photos/')) {
    e.respondWith((async () => {
      const cache = await caches.open(PHOTO_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) { await cache.put(request, res.clone()); trim(cache); }
      return res;
    })());
    return;
  }

  // the shell: take the fresh one when there is a network, so a change lands
  // on both phones the moment it is deployed, and fall back to the last one
  // we saw when there is not
  e.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, res.clone());
      }
      return res;
    } catch (err) {
      const hit = await caches.match(request);
      if (hit) return hit;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
