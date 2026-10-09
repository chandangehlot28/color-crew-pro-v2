const CACHE_NAME = 'chandan-card-club-v2-20261009';
const SHELL = ['./', './index.html', './config.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => { const cache = await caches.open(CACHE_NAME); try { await cache.addAll(SHELL); } catch (_) {} await self.skipWaiting(); })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => { const keys = await caches.keys(); await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))); await self.clients.claim(); })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const url = new URL(req.url);
  if (url.pathname.endsWith('/socket.io/socket.io.js') || url.pathname.includes('/socket.io/')) return;
  event.respondWith((async () => {
    try { const response = await fetch(req); if (response.ok) { const cache = await caches.open(CACHE_NAME); cache.put(req, response.clone()); } return response; }
    catch (_) { return (await caches.match(req)) || (await caches.match('./index.html')); }
  })());
});
