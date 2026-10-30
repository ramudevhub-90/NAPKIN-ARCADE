// Installed games (PWA) keep working offline: the engine and three.js are cached on first play,
// pages and game data are network-first with the last good copy as a fallback.
const CACHE = "napkin-play-v1";
const STATIC = (u) => u.pathname.startsWith("/engine3d/") || u.href.startsWith("https://cdn.jsdelivr.net/npm/three@") || /^\/(logo|apple-touch-icon)/.test(u.pathname);
const FALLBACK = (u) => u.pathname.startsWith("/play/") || /^\/api\/projects\/[a-z0-9-]+\/(game3d|access)$/.test(u.pathname);
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  if (STATIC(u)) e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
  else if (FALLBACK(u)) e.respondWith(fetch(e.request).then((r) => { if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
