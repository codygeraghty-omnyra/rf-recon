/* RF Recon (beta) phone app: keeps the app, and the map tiles you look at, on the phone so it opens with no signal.
   VERSION changes on every publish (publish.py writes it), which swaps in the new app files. */
const VERSION = "70176729f4";
const SHELL = `rfr-shell-${VERSION}`, TILES = "rfr-tiles", FONTS = "rfr-fonts";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "theme/glass.css", "theme/skins.js", "theme/look.js",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/sqljs/sql-wasm.js", "vendor/sqljs/sql-wasm.wasm",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "tak.js", "notes.js", "das.js"];
// USGS tiles only: they're public domain. OpenStreetMap's tile policy says "Offline use is not permitted", so its tiles
// go through the browser's own cache (their caching headers) and are never saved here; the app shows Topo with no signal.
const TILE_HOSTS = ["basemap.nationalmap.gov"];
const NOT_KEPT = ["tile.openstreetmap.org"];  // saved here before 2026-11-02: removed on the next update

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("rfr-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => caches.open(TILES)).then(async c => { for (const r of await c.keys()) if (NOT_KEPT.includes(new URL(r.url).hostname)) await c.delete(r); })
    .catch(() => {}).then(() => self.clients.claim()));
});

async function cacheFirst(cacheName, req) {
  const c = await caches.open(cacheName), hit = await c.match(req, {ignoreVary: true});
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) c.put(req, res.clone()).catch(() => {});  // storage full: still show the tile
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(cacheFirst(TILES, req)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(FONTS, req).catch(() => new Response("", {status: 504}))); return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/packs/")) return;  // state packs: the app keeps a loaded one itself, so never cached twice
  // while testing on the PC ("dev"), the network first so edits show; published copies open from the phone
  if (VERSION === "dev") { e.respondWith(fetch(req).catch(() => caches.match(req, {ignoreSearch: true}))); return; }
  // the app itself: from the phone first (so it opens offline), the network when it isn't saved yet; anything
  // else of ours fetched once (the full web version in full/) is kept for next time
  e.respondWith(caches.open(SHELL).then(async c => {
    const hit = await c.match(req, {ignoreSearch: true});
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      return (req.mode === "navigate" && !new URL(req.url).pathname.includes("/full/") && await c.match("./")) || Response.error();
    }
  }));
});
