// Service worker: app shell cached for offline start, map tiles cached as you fly (bounded).
const VERSION = 'starforge-v7';
const SHELL = ['./', './index.html', './style.css', './manifest.webmanifest', './icon.svg', './icon-192.png', './vendor/three.module.js', './data/airports.json', './data/cities.json'];
const TILE_CACHE = 'starforge-tiles';
const TILE_LIMIT = 1500;
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const isTile = (u) => /tiles\.maps\.eox\.at|elevation-tiles-prod|gibs\.earthdata|trek\.nasa\.gov/.test(u);
let pending = 0;
async function trim() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await c.delete(keys[i]);
}
self.addEventListener('fetch', (e) => {
  const u = e.request.url;
  if (e.request.method !== 'GET') return;
  if (isTile(u)) {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) { c.put(e.request, r.clone()); if (++pending % 100 === 0) trim(); }
      return r;
    }));
    return;
  }
  if (u.startsWith(self.registration.scope)) {
    // network first for the app, always revalidated (so an update never mixes old and new code files),
    // falling back to the cache offline
    const nav = e.request.mode === 'navigate';
    const req = nav ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(e.request, { cache: 'no-cache' });
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: nav }).then((r) => r || (nav ? caches.match('./index.html') : undefined))));
  }
});
