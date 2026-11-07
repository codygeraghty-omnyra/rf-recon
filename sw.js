/* RF Recon (beta) phone app: keeps the app, and the map tiles you look at, on the phone so it opens with no signal.
   VERSION changes on every publish (publish.py writes it), which swaps in the new app files. */
const VERSION = "1307dc363b";
const SHELL = `rfr-shell-${VERSION}`, TILES = "rfr-tiles", FONTS = "rfr-fonts";
// the full version's Python engine (Pyodide, full/pyodide/, served from this site since 11/4): kept apart from the app
// files, by the engine's version (publish.py writes it), so a new build doesn't download it again
const ENGINE = "rfr-engine-0.27.7";
const FILES = ["./", "index.html", "app.js", "manifest.webmanifest", "theme/glass.css", "theme/skins.js", "theme/look.js",
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/sqljs/sql-wasm.js", "vendor/sqljs/sql-wasm.wasm",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "tak.js", "notes.js", "das.js", "geofix.js", "wmm.js", "hunt.js", "zoombar.js"];
// USGS tiles only: they're public domain. OpenStreetMap's tile policy says "Offline use is not permitted", so its tiles
// go through the browser's own cache (their caching headers) and are never saved here; the app shows Topo with no signal.
const TILE_HOSTS = ["basemap.nationalmap.gov"];
const NOT_KEPT = ["tile.openstreetmap.org"];  // saved here before 2026-11-02: removed on the next update

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, {cache: "reload"})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith("rfr-shell-") && k !== SHELL) || (k.startsWith("rfr-engine-") && k !== ENGINE)).map(k => caches.delete(k))))
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
  if (url.pathname.includes("/full/pyodide/")) { e.respondWith(cacheFirst(ENGINE, req)); return; }  // the engine: never changes within a version
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

// The full version, kept for use with no signal (11/4): its page asks once per visit (web.js), and every file in
// full/offline.json that isn't kept yet is fetched and kept: the page, its scripts and research, the app's Python, and
// the engine. With no signal the list kept last time answers, so the page still reads "kept".
async function keepFull(listUrl) {
  const shell = await caches.open(SHELL), engine = await caches.open(ENGINE);
  let res = await fetch(listUrl, {cache: "no-cache"}).catch(() => null);
  if (res && res.ok) await shell.put(listUrl, res.clone());
  else res = await shell.match(listUrl, {ignoreSearch: true});
  if (!res) throw new Error("the list of files isn't reachable: open this page once with signal");
  const list = await res.json(), base = new URL(".", listUrl);
  const todo = [...list.app.map(f => [shell, f]), ...list.engine.map(f => [engine, f])], failed = [];
  let fetched = 0;
  const one = async ([c, f]) => {
    const u = new URL(f, base).href;
    if (await c.match(u, {ignoreSearch: true})) return;
    try {
      const r = await fetch(u, {cache: "no-cache"});  // the browser's copy from this visit when it is current
      if (!r.ok) throw new Error(`${r.status}`);
      await c.put(u, r);
      fetched++;
    } catch (err) { failed.push(`${f} (${err.message || err})`); }
  };
  for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(one));  // a few at a time
  return {files: todo.length - failed.length, of: todo.length, fetched, failed: failed.slice(0, 5), bytes: list.bytes || 0,
          engine_bytes: list.engine_bytes || 0, at: new Date().toISOString()};
}
self.addEventListener("message", e => {
  const m = e.data || {}, port = e.ports && e.ports[0];
  if (m.kind !== "keep-full" || !m.list || new URL(m.list).origin !== location.origin) return;
  e.waitUntil(keepFull(m.list).then(r => port && port.postMessage(r), err => port && port.postMessage({error: err.message || String(err)})));
});
