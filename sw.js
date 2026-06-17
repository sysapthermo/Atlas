// ============================================================
//  sw.js  —  Atlas service worker
//  ------------------------------------------------------------
//  Makes Atlas installable and usable offline (the shell, not
//  the AI itself — that always needs the network).
//
//  Strategy chosen for LONG-TERM use:
//   - Page (HTML): network-first, so every GitHub update you push
//     actually shows up. Falls back to cache only when offline.
//   - Static assets (icons, libraries): cache-first for speed.
//   - The /api/ proxy: never touched, so streaming works untouched.
//
//  Bump CACHE (v1 -> v2 ...) if you ever need to force-clear caches.
// ============================================================
const CACHE = "atlas-v1";
const SHELL = [
  "/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.9/purify.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css"
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // add individually so one failed asset doesn't break the whole install
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // leave POSTs (the API) alone
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;      // never cache the AI proxy

  // Page: network-first so updates always win, cache as offline fallback.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    e.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return r;
      }).catch(() => caches.match(req).then((m) => m || caches.match("/index.html")))
    );
    return;
  }

  // Static assets: cache-first, then network.
  e.respondWith(
    caches.match(req).then((m) => m || fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return r;
    }).catch(() => m))
  );
});
