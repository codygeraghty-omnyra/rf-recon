"use strict";
/* DAStastic — Boundaries (Cody's list, item 6: "Map layer: state/county/cities-towns, switchable alone and together"): state,
   county and city / town lines from the Census Bureau's 1:500,000 cartographic boundary files (tools/build_boundaries.py
   writes static/data/boundaries/). Four entries in every map's layers menu: State boundaries, County boundaries,
   City / town boundaries, each on its own, and All boundaries, which switches the three together (and ticks itself when all
   three are on). They draw under every other layer: their own panes just over the map tiles (the base map, the Census tile
   lines, radar) and under the overlay, marker and popup panes, never taking a click, so dots, links, markers and the pin stay
   clickable. (Not inside the tile pane: the layers menu numbers the base maps 1, 2, 3... so Topo sits at 5, over anything
   placed between; found 11/8, lines drawn but hidden.) A dark casing under each line keeps it readable on every base map and
   skin (Haze's accent is near-white); lines only, no fill. What loads when: index.json once any of them is on;
   states.json.gz (one file) with State at any zoom; a state's counties from zoom 7 and its places from zoom 9, for the
   states in view only. Names in their line's colour where they fit, larger first, none overlapping: states at zoom 4 to 8,
   counties 9 to 11, and cities and towns from 12 only on a base map that doesn't name places itself (USGS satellite, Esri,
   relief, ATAK style): on the others every town was named twice.
   DAStastic lite (phone/app.js) has its own switches in Layers and filters and points base at the site's copy. */
(() => {
  if (typeof L === "undefined") return;
  const KINDS = ["state", "county", "place"];
  const NAMES = {state: "State boundaries", county: "County boundaries", place: "City / town boundaries", all: "All boundaries"};
  const WHAT = {state: "State lines", county: "County lines", place: "City and town lines"};
  const FROM_Z = {state: 0, county: 7, place: 9};
  const LABEL_Z = {state: [4, 8], county: [9, 11], place: [12, 19]};
  // Leaflet's panes: tiles 200, overlays (dots, links, heatmap) 400, shadows 500, markers 600, tooltips 650, popups 700
  const PANES = [["rfbPlace", 201], ["rfbCounty", 202], ["rfbState", 203], ["rfbLabel", 204]];
  const PANE = {state: "rfbState", county: "rfbCounty", place: "rfbPlace"};
  const MAX_STATES = 10, KEEP_PARTS = 16, KEEP_FILES = 24, MAX_LABELS = 120;
  const live = new Set();

  const RB = window.RFBounds = {
    base: "/static/data/boundaries/",  // DAStastic lite sets the site's copy (full/static/data/boundaries/)
    kinds: KINDS, names: NAMES, fromZoom: FROM_Z,
    say: msg => { const el = document.getElementById("status"); if (el) el.textContent = msg; },
    pack: null,  // DAStastic lite: () => the pack in use; the web version's is RFPack.info()
  };
  const later = fn => Promise.resolve().then(fn);
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

  /* ---------- the files: fetched once a page, gzipped GeoJSON unpacked here ---------- */
  const files = new Map();
  async function readJson(res) {
    const u8 = new Uint8Array(await res.arrayBuffer());
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
      if (!("DecompressionStream" in window)) throw new Error("this browser can't unpack them: update it");
      return JSON.parse(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
    }
    return JSON.parse(new TextDecoder().decode(u8));  // unpacked on the way by a server
  }
  function get(name) {
    let p = files.get(name);
    if (p) { files.delete(name); files.set(name, p); return p; }  // most recently used last
    p = fetch(RB.base + name).then(r => { if (!r.ok) throw new Error(`${name}: ${r.status}`); return readJson(r); });
    p.catch(() => { if (files.get(name) === p) files.delete(name); });  // no signal: asked again next time
    files.set(name, p);
    for (const k of files.keys()) { if (files.size <= KEEP_FILES) break; if (k !== "index.json" && !/^states/.test(k)) files.delete(k); }
    return p;
  }
  const index = () => get("index.json");
  const fileOf = (idx, kind, st) => (idx.layers?.[kind] || {state: "states.json.gz", county: "counties/<ST>.json.gz", place: "places/<ST>.json.gz"}[kind]).replace("<ST>", st);
  // a file that didn't come: said once a page for each kind (the PC app draws its map afresh on every search)
  const said = new Set();
  const sayMiss = (kind, msg) => { if (!said.has(kind)) { said.add(kind); RB.say(msg); } };
  const missWord = e => navigator.onLine === false ? "not kept on this device yet: switch them on once with signal and they're kept"
    : `didn't load (${e?.message || e})`;

  /* ---------- look ---------- */
  const cssVar = (n, d) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d; } catch (e) { return d; } };
  function styles(kind) {
    const a = cssVar("--accent", "#f0a07a"), a2 = cssVar("--accent-2", a);
    // state heaviest, county dashed, city / town lightest (suburbs hold a CDP every few miles)
    const s = {state: [{color: "#000", opacity: .55, weight: 5.4}, {color: a, opacity: .95, weight: 2.6}],
      county: [{color: "#000", opacity: .5, weight: 3.6}, {color: a, opacity: .95, weight: 1.6, dashArray: "8 5"}],
      place: [{color: "#000", opacity: .3, weight: 2.4}, {color: a2, opacity: .8, weight: 1.1}]}[kind];  // lines only: a fill tinted whole metro areas
    return s.map(x => ({fill: false, interactive: false, lineJoin: "round", lineCap: "round", ...x}));
  }
  // names in their line's colour, so they read as the boundary's and not the base map's
  function addCss() {
    if (document.getElementById("rfbCss")) return;
    document.head.insertAdjacentHTML("beforeend", `<style id="rfbCss">
.rfb-lbl{pointer-events:none!important;width:0!important;height:0!important}
.rfb-lbl span{position:absolute;left:0;top:0;transform:translate(-50%,-50%);white-space:nowrap;font:600 11px/1.15 var(--font,system-ui,sans-serif);
  color:var(--accent,#f0a07a);text-shadow:0 0 2px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.85),0 1px 1px #000}
.rfb-lbl.state span{font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}
.rfb-lbl.county span{font-style:italic}
.rfb-lbl.place span{font-weight:500;font-size:10.5px;color:var(--accent-2,var(--accent,#f0a07a))}
</style>`);
  }
  // city and town names only on a base map that doesn't name places itself (the base maps with names had every town twice):
  // the map on screen, not a saved choice this copy can't show (11/11 review: a saved Esri drew names over Topo on a sold copy)
  const PLAIN = /^(Satellite \(USGS\)|Satellite hi-res \(Esri\)|Terrain relief \(USGS\))$/;
  // The base layer on this map now (core.js map._rfBases), so the no-signal stand-in counts too (11/11 follow-up review: a
  // saved Esri drew names over the Topo standing in for it); ATAK style still names places over a map of your own
  const plainBase = map => { try {
    if (RB.plainBase) return !!RB.plainBase();
    const on = map?._rfBases && Object.entries(map._rfBases).find(([, l]) => map.hasLayer(l))?.[0];
    if (on) return PLAIN.test(on) || (S.mapStyle === "atak" && !!(typeof BASEMAPS === "object" && BASEMAPS[on]?.own));
    return typeof mapPrefs === "function" && (PLAIN.test(typeof baseShown === "function" ? baseShown(mapPrefs().base) : mapPrefs().base) || S.mapStyle === "atak");
  } catch (e) { return false; } };
  function panes(map) {
    const mp = map.getPane("mapPane");
    for (const [n, z] of PANES) {
      const p = map.getPane(n) || map.createPane(n, mp);
      p.style.zIndex = z; p.style.pointerEvents = "none";
    }
  }

  /* ---------- geometry ---------- */
  const polysOf = g => g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
  function ringBox(r) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return [w, s, e, n];
  }
  function boxOf(f) {
    if (f._bb) return f._bb;
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of polysOf(f.geometry)) { const r = ringBox(p[0]); b = [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])]; }
    return f._bb = b;
  }
  // where a name goes: the middle of the widest stretch across the largest outer ring, on a few lines across it
  function labelAt(f) {
    if (f._lp !== undefined) return f._lp;
    let ring = null, big = -1;
    for (const p of polysOf(f.geometry)) { const b = ringBox(p[0]), a = (b[2] - b[0]) * (b[3] - b[1]); if (a > big) { big = a; ring = p[0]; } }
    if (!ring) return f._lp = null;
    const [w, s, e, n] = ringBox(ring);
    let best = null, bw = -1;
    for (const t of [.5, .38, .62, .27, .73]) {
      const y = s + (n - s) * t, xs = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[j];
        if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > bw) { bw = xs[k + 1] - xs[k]; best = [y, (xs[k] + xs[k + 1]) / 2]; }
    }
    return f._lp = best || [(s + n) / 2, (w + e) / 2];
  }
  // the states whose box meets the view, nearest the middle first
  function inView(idx, map, kind) {
    const b = map.getBounds().pad(.1), c = map.getCenter(), w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const has = kind === "county" ? "counties" : "places";
    return Object.entries(idx.states || {}).filter(([, x]) => x.bbox && x[has] && x.bbox[0] <= e && x.bbox[2] >= w && x.bbox[1] <= n && x.bbox[3] >= s)
      .map(([st, x]) => [st, Math.hypot((x.bbox[0] + x.bbox[2]) / 2 - c.lng, (x.bbox[1] + x.bbox[3]) / 2 - c.lat)])
      .sort((a, b) => a[1] - b[1]).slice(0, MAX_STATES).map(x => x[0]);
  }
  // the pack in use (DAStastic lite, the web version): its states, so they're kept for no signal while a layer is on
  function packStates(idx) {
    let p = null;
    try { p = RB.pack ? RB.pack() : window.RFPack?.info?.(); } catch (e) { /* no pack */ }
    if (!p) return [];
    const areas = p.area?.areas || (p.area ? [p.area] : []), sts = new Set(areas.flatMap(a => a.states || []));
    if (!sts.size) for (const [s, n, w, e] of p.bboxes || (p.bbox ? [p.bbox] : [])) {
      const mid = [(s + n) / 2, (w + e) / 2];
      Object.entries(idx.states || {}).filter(([, x]) => x.bbox && x.bbox[0] <= e && x.bbox[2] >= w && x.bbox[1] <= n && x.bbox[3] >= s)
        .sort((a, b) => Math.hypot((a[1].bbox[0] + a[1].bbox[2]) / 2 - mid[1], (a[1].bbox[1] + a[1].bbox[3]) / 2 - mid[0])
          - Math.hypot((b[1].bbox[0] + b[1].bbox[2]) / 2 - mid[1], (b[1].bbox[1] + b[1].bbox[3]) / 2 - mid[0]))
        .slice(0, 4).forEach(([st]) => sts.add(st));
    }
    return [...sts].filter(st => idx.states?.[st]);
  }
  const kept = new Set();
  function keepPack(idx, kind) {
    // only where a service worker keeps what's fetched (the site): the PC and the server serve these themselves
    if (kind === "state" || !navigator.serviceWorker?.controller || navigator.onLine === false) return;
    for (const st of packStates(idx)) {
      const f = fileOf(idx, kind, st);
      if (kept.has(f)) continue;
      kept.add(f);
      fetch(RB.base + f).then(r => r.arrayBuffer()).catch(() => kept.delete(f));
    }
  }

  /* ---------- the layer: one kind on one map ---------- */
  const Bounds = L.Layer.extend({
    options: {attribution: "Boundaries: US Census Bureau"},
    initialize(kind) { this.kind = kind; this._parts = new Map(); this._shown = []; this._gen = 0; },
    onAdd(map) {
      addCss(); panes(map);
      this._r = L.canvas({pane: PANE[this.kind], padding: .3});
      this._g = L.layerGroup().addTo(map);
      this._labels = L.layerGroup().addTo(map);
      this._mv = () => { clearTimeout(this._t); this._t = setTimeout(() => this.update(false), 80); };
      this._lb = () => this._label();  // another base map: city and town names follow whether it names places itself
      map.on("moveend", this._mv); map.on("baselayerchange", this._lb);
      live.add(this);
      // a note only when switched on by hand: a choice put back as the map is made (before it has a view) says nothing, nor
      // one DAStastic lite puts back as it starts (it marks the layer .restoring)
      const byHand = !!map._loaded && !this.restoring;
      this.restoring = false;
      map.whenReady(() => { if (this._map === map) this.update(byHand); });
      if (this._all) later(() => syncAll(this._all, map));
    },
    onRemove(map) {
      map.off("moveend", this._mv); map.off("baselayerchange", this._lb); clearTimeout(this._t); this._gen++;
      for (const l of [this._g, this._labels, this._r]) if (l) map.removeLayer(l);
      this._parts.clear(); this._shown = [];
      live.delete(this);
      if (this._all) later(() => syncAll(this._all, map));
    },
    async update(first) {
      const map = this._map, kind = this.kind;
      if (!map) return;
      const gen = ++this._gen, z = map.getZoom();
      if (z < FROM_Z[kind]) {
        this._show([]);
        if (first) RB.say(`${WHAT[kind]} show from zoom ${FROM_Z[kind]}: zoom in and they load for the states in view.`);
        return;
      }
      let idx;
      try { idx = await index(); } catch (e) { sayMiss(kind, `${WHAT[kind]} ${missWord(e)}.`); return; }
      if (gen !== this._gen || this._map !== map) return;
      const want = kind === "state" ? ["US"] : inView(idx, map, kind);
      const got = await Promise.all(want.filter(st => !this._parts.has(st))
        .map(st => get(st === "US" ? fileOf(idx, "state") : fileOf(idx, kind, st)).then(j => [st, j], e => [st, null, e])));
      if (gen !== this._gen || this._map !== map) return;
      const miss = got.filter(x => !x[1]);
      for (const [st, j] of got) if (j) this._parts.set(st, this._make(j));
      this._show(want.filter(st => this._parts.has(st)));
      if (miss.length) sayMiss(kind, `${WHAT[kind]} for ${miss.map(x => x[0] === "US" ? "the states" : x[0]).join(", ")} ${missWord(miss[0][2])}.`);
      keepPack(idx, kind);
    },
    _make(j) {
      const [cs, ls] = styles(this.kind), o = {renderer: this._r, interactive: false, bubblingMouseEvents: false};
      const casing = L.geoJSON(j, {...o, style: () => cs}), line = L.geoJSON(j, {...o, style: () => ls});
      return {casing, line, feats: j.features || []};
    },
    _show(want) {
      const keep = new Set(want);
      let added = false;
      for (const [st, p] of this._parts) {
        const on = keep.has(st);
        for (const l of [p.casing, p.line]) {
          if (on && !this._g.hasLayer(l)) { this._g.addLayer(l); added = true; } else if (!on && this._g.hasLayer(l)) this._g.removeLayer(l);
        }
      }
      // every casing under every line, whatever order the states came in
      if (added && want.length > 1) for (const st of want) this._parts.get(st)?.line.bringToFront();
      for (const st of want) { const p = this._parts.get(st); if (p) { this._parts.delete(st); this._parts.set(st, p); } }
      for (const st of this._parts.keys()) { if (this._parts.size <= KEEP_PARTS) break; if (!keep.has(st)) this._parts.delete(st); }
      this._shown = want;
      this._label();
    },
    _label() {
      const map = this._map, lab = this._labels;
      if (!map || !lab) return;
      lab.clearLayers();
      const z = map.getZoom(), [z0, z1] = LABEL_Z[this.kind];
      if (z < z0 || z > z1 || !this._shown.length || (this.kind === "place" && !plainBase(map))) return;
      const vb = map.getBounds().pad(-.03), cand = [], big = this.kind === "state";
      for (const st of this._shown) for (const f of this._parts.get(st)?.feats || []) {
        const b = boxOf(f);
        if (b[2] < vb.getWest() || b[0] > vb.getEast() || b[3] < vb.getSouth() || b[1] > vb.getNorth()) continue;
        const lp = labelAt(f);
        if (!lp || !vb.contains(lp)) continue;
        const p0 = map.latLngToContainerPoint([b[1], b[0]]), p1 = map.latLngToContainerPoint([b[3], b[2]]);
        const wpx = Math.abs(p1.x - p0.x), hpx = Math.abs(p1.y - p0.y), em = big ? 9.5 : 6.3;
        let name = f.properties?.name || "";
        if (name.length * em + 8 > wpx * 1.1 && big && f.properties?.st) name = f.properties.st;  // a small state: its two letters
        const tw = name.length * em + 8;
        if (!name || tw > wpx * 1.1 || hpx < 14) continue;  // too small for its name at this zoom
        cand.push({lp, name, tw, area: wpx * hpx});
      }
      cand.sort((a, b) => b.area - a.area);
      const placed = [];
      for (const c of cand) {
        if (placed.length >= MAX_LABELS) break;
        const p = map.latLngToContainerPoint(c.lp), r = [p.x - c.tw / 2 - 4, p.y - 10, p.x + c.tw / 2 + 4, p.y + 10];
        if (placed.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
        placed.push(r);
        L.marker(c.lp, {pane: "rfbLabel", interactive: false, keyboard: false,
          icon: L.divIcon({className: `rfb-lbl ${this.kind}`, html: `<span>${escH(c.name)}</span>`, iconSize: null})}).addTo(lab);
      }
    },
    restyle() {
      const [cs, ls] = styles(this.kind);
      for (const p of this._parts.values()) { p.casing.setStyle(cs); p.line.setStyle(ls); }
      this._label();
    },
  });

  /* ---------- All boundaries: the three together ---------- */
  const All = L.Layer.extend({
    onAdd(map) {
      if (this._quiet) return;
      later(() => { if (!this._gone) for (const p of this._parts || []) if (!map.hasLayer(p)) map.addLayer(p); });
    },
    onRemove(map) {
      if (this._quiet || this._gone) return;
      later(() => { if (!this._gone) for (const p of this._parts || []) if (map.hasLayer(p)) map.removeLayer(p); });
    },
  });
  // All ticks itself when the three are on and unticks when one goes, without switching the others
  function syncAll(all, map) {
    if (all._gone || !all._parts) return;
    const every = all._parts.every(p => map.hasLayer(p));
    if (every === map.hasLayer(all)) return;
    all._quiet = true;
    try { if (every) map.addLayer(all); else map.removeLayer(all); } finally { all._quiet = false; }
  }

  RB.layer = kind => new Bounds(kind);
  RB.all = () => new All();
  // one map's four layers-menu entries (core.js addMapLayers, before the saved choices are put back)
  RB.link = (map, overs) => {
    const parts = KINDS.map(k => overs[NAMES[k]]), all = overs[NAMES.all];
    if (!all || parts.some(p => !p)) return;
    all._parts = parts;
    for (const p of parts) p._all = all;
    map.once("unload", () => { all._gone = true; });
  };
  // what's drawn on a map now (the browser checks read it)
  RB.inspect = map => {
    const out = {};
    map.eachLayer(l => {
      if (!(l instanceof Bounds)) return;
      const feats = l._shown.flatMap(st => l._parts.get(st)?.feats || []);
      out[l.kind] = {states: l._shown.slice(), features: feats.length, names: feats.map(f => f.properties?.name),
        labels: l._labels ? l._labels.getLayers().map(m => m.getElement()?.textContent || "") : []};
    });
    map.eachLayer(l => { if (l instanceof All) out.all = true; });
    return out;
  };
  RB.restyle = () => { for (const l of live) l.restyle(); };
  // a skin or accent change (DashSkin writes data-skin, data-tint and the accent on <html>): the lines follow it
  let rt;
  new MutationObserver(() => { clearTimeout(rt); rt = setTimeout(RB.restyle, 60); })
    .observe(document.documentElement, {attributes: true, attributeFilter: ["data-skin", "data-tint", "data-theme", "style"]});

  // the PC app, the server and the web version: entries in every map's layers menu (core.js)
  // the four sit under the Census's own "County + state lines" tiles, the menu's other entries keep their order
  if (typeof OVERLAYS !== "undefined") {
    const mine = [...KINDS.map(k => [NAMES[k], () => new Bounds(k)]), [NAMES.all, () => new All()]], rest = Object.entries(OVERLAYS);
    for (const [k] of rest) delete OVERLAYS[k];
    let put = false;
    for (const [k, v] of rest) {
      OVERLAYS[k] = v;
      if (k === "County + state lines") { for (const [n, f] of mine) OVERLAYS[n] = f; put = true; }
    }
    if (!put) for (const [n, f] of mine) OVERLAYS[n] = f;
  }
})();
