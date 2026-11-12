"use strict";
/* DAStastic — the survey map (Cody 11/10 and 11/12: a survey "war mapping" tool, colour coded like the heat map's tiles, part of the
   tower tool; Andy Masur records his own sites on his Android). A run's readings (survey.py: a mission's, a DAS job's or this
   copy's) painted as squares on the Towers tab's map and the Map tab's map, with fewest clicks, and the map holds still: only
   Zoom to moves it.
   - The ▦ Survey button (beside Measure and Draw): the runs kept with the open job, mission or this copy, Import a file
     (G-NetTrack Pro, a scanner's CSV or Excel, the template: POST /api/survey/import), the template, the sample run, and Record
     on DAStastic for Android (surveyrec.js). After an import a note offers Zoom to run; nothing fits the map by itself.
   - The squares: one canvas in a pane under the tower dots (z 350; the dots' canvas and the markers sit above), drawn at the
     screen's pixel ratio (at most 3), only the squares in view, 25, 50, 100 or 200 m by zoom (survey.js tileSize) unless the
     legend sets one. Colours and pass lines are RFScale's; faint under 3 moments of measurement, hatched where they fail.
     Judged as survey.js judges them: o.kind from the run's source (a scanner's or a phone's), and a part of a big run (over
     60,000 readings: the part in view) judged as the whole run measures (heard()).
   - The legend (bottom right): what the colours mean, "Not measured by this run", the metric (RSRP, RSRQ, SINR, Best server),
     carrier, band and technology chips (on the Towers tab its carrier chips filter the squares too), the square size, and the
     readings as CSV, KML or KMZ. A map image (mapexport.js) has the squares drawn again sharp (the canvas's _rfDraw) and the
     legend (map._rfLegends).
   - A square clicked opens the results viewer (results.js): per carrier and band its count, median, best and worst, PCIs,
     serving towers, time span and device; Zoom to, Readings CSV, Only this site.
   - The sample run (survey.js sample): made up, drawn where the map is, kept in the page only, never with the real runs.
   RFSurveyMap.add(map, {slot, carriers, site, towerOf, changed}) on a map; get(map); seenFor(map, tower entries) for the
   Towers tab's "Seen on site"; draw(map, view) for the printed report's off-screen map. Needs Leaflet, RFScale, RFSurvey and
   results.js; core.js's api when it's there. */
(() => {
  if (typeof L === "undefined" || !window.RFSurvey || !window.RFScale) return;
  const SV = window.RFSurvey, SC = window.RFScale;
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const hasS = () => typeof S === "object" && S;
  const TOUCH = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const n0 = v => Number(v || 0).toLocaleString();
  const PART = 60000;  // a run bigger than this is summed up for the part in view (and judged as the whole run measures)
  const BIG3 = ["AT&T", "Verizon", "T-Mobile"];
  const SRC = {android: "DAStastic for Android", gnettrack: "G-NetTrack Pro", phone: "a phone app's log", scanner: "a scanner", csv: "the survey template"};
  const METRICS = [["rsrp", "RSRP"], ["rsrq", "RSRQ"], ["sinr", "SINR"], ["best", "Best server"]];
  const kindOf = run => run && run.source === "scanner" ? "scanner" : "phone";
  const isPhone = run => kindOf(run) === "phone";
  const call = async (url, o) => { if (typeof api === "function") return api(url, o);
    const r = await fetch(url, o), j = await r.json().catch(() => ({})); if (!r.ok || j.error) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), {status: r.status, body: j}); return j; };
  const defScope = () => hasS() && S.missionId ? {scope: "mission", id: S.missionId, name: `the mission “${S.mission?.name || S.missionId}”`} : {scope: "scratch", id: 0, name: "this copy (no mission open)"};
  const scopeOf = map => (map && map._rfScope && map._rfScope()) || defScope();
  const canPost = () => !(hasS() && S.me && !["full", "admin"].includes(S.me.role)) && !(hasS() && S.remote && !["full", "admin"].includes(S.remote.role));
  const day = ms => { if (ms == null) return ""; const d = new Date(ms), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const clock = ms => { if (ms == null) return ""; const d = new Date(ms), p = x => String(x).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
  const span = (a, b) => a == null ? "" : day(a) === day(b) ? `${day(a)} ${clock(a)}–${clock(b)}` : `${day(a)} ${clock(a)} to ${day(b)} ${clock(b)}`;
  const bandTxt = b => b == null ? "band not known" : /^n/i.test(String(b)) ? String(b) : `B${b}`;
  const techTxt = t => t === "NR" ? "5G NR" : t;
  const fileSafe = s => String(s || "survey").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80).trim();
  const serverTxt = k => { if (!k) return ""; const [c, t, x] = k.split("|"); return x && x.startsWith("pci ") ? `${c} ${techTxt(t)} PCI ${x.slice(4).replace("@", " on ")}` : `${c} ${t === "NR" ? "gNB" : "eNB"} ${x}`; };
  const byBand = (a, b) => (/^n/i.test(a) - /^n/i.test(b)) || String(a).localeCompare(String(b), undefined, {numeric: true});
  const byCarrier = (a, b) => ((BIG3.indexOf(a) + 1 || 9) - (BIG3.indexOf(b) + 1 || 9)) || a.localeCompare(b);
  const slots = new Map();  // a map's slot ("towers", "search") -> what it shows, kept while the tab's map is made again
  const all = new Set();    // every live map's survey, for RFKeys and the recorder

  const css = document.createElement("style");
  css.textContent = `.leaflet-bar.rf-sv{border:0;box-shadow:none;background:none}
    /* the menu over the column under it, not in it: open, it pushed Measure, Draw and the rest down over the scale bar (412 px) */
    .leaflet-control.rf-sv{position:relative}.leaflet-bar.rf-sv{overflow:visible}.rf-sv-open .leaflet-control.rf-sv{z-index:810}  /* the bar clips (index.html): the menu hangs out of it */
    .rf-sv-panel{position:absolute;left:0;top:100%;margin-top:6px;padding:8px 10px;border-radius:10px;width:270px;font:12px/1.35 system-ui,sans-serif;background:rgb(24,24,24);color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35);overflow:auto}  /* opaque: over the column, its buttons showed through */
    .rf-sv-panel b{font-weight:600}.rf-sv-panel .row{display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;align-items:center}
    .rf-sv-panel button,.rf-sv-panel label.rf-sv-file{font:inherit;padding:3px 8px;border-radius:7px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fff;cursor:pointer}
    .rf-sv-panel button.primary,.rf-sv-panel label.rf-sv-file{background:#ff7a1a;color:#111;border-color:#ff7a1a;font-weight:600}
    .rf-sv-panel button:disabled{opacity:.5;cursor:default}
    .rf-sv-run{display:flex;gap:6px;align-items:center;width:100%;text-align:left;margin-top:4px;padding:4px 6px!important}
    .rf-sv-run.on{background:rgba(255,122,26,.22)!important;border-color:#ff7a1a!important}.rf-sv-run .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rf-sv-hint{opacity:.78;margin-top:4px}.rf-sv-msg{color:#ffb38a;margin-top:6px;white-space:pre-wrap}.rf-sv-panel label{color:#fff;font-weight:400}.rf-sv-panel label.rf-sv-file{display:inline-flex;flex-direction:row;align-items:center}
    .rf-sv-panel label.rf-sv-chk{display:flex;flex-direction:row;align-items:center;gap:6px;margin-top:6px;font-size:12px}.rf-sv-panel label.rf-sv-chk input{margin:0;flex:none}
    .rf-sv-leg label{display:inline-flex;flex-direction:row;align-items:center;gap:4px;color:inherit;font-weight:400}
    .rf-sv-panel button.rf-sv-q{padding:0 7px;border-radius:999px;margin-left:2px;vertical-align:middle;line-height:1.2}
    @media (pointer:coarse){.rf-sv-panel button.rf-sv-q{min-height:32px;min-width:32px;margin:2px 0 2px 4px}}  /* a 40 px circle sat over the line it ends (390 px) */
    .rf-sv-tag{display:inline-block;padding:0 6px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.03em;background:#ffd33d;color:#111;vertical-align:1px}
    .rf-sv-leg{background:var(--g-strong,var(--panel,#fff));color:var(--ink,#111);border:1px solid var(--line,rgba(127,127,127,.35));border-radius:12px;box-shadow:var(--g-shadow,0 2px 10px rgba(0,0,0,.25));
      -webkit-backdrop-filter:var(--g-blur,none);backdrop-filter:var(--g-blur,none);padding:6px 9px;font:12px/1.35 system-ui,sans-serif;width:min(330px,calc(100vw - 40px));max-height:min(60vh,var(--rf-sv-max,520px));overflow:auto;box-sizing:border-box}
    .rf-sv-leg .hd{display:flex;gap:6px;align-items:flex-start}.rf-sv-leg .hd .tt{flex:1;min-width:0;font-weight:650;overflow-wrap:anywhere}
    .rf-sv-leg .hd button{padding:1px 7px;font-size:12px}.rf-sv-leg .sub{color:var(--ink-2,var(--muted,#666));font-size:11.5px;margin-top:1px}
    .rf-sv-leg .grp{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-top:5px}.rf-sv-leg .grp>span.k{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2,var(--muted,#666));min-width:44px}
    .rf-sv-leg .chip{font-size:11.5px;padding:1px 8px}.rf-sv-leg .rfs-legend{margin-top:6px}.rf-sv-leg .hint{font-size:11px}
    .rf-sv-leg .rows{margin-top:4px}.rf-sv-leg .rows div{display:flex;gap:6px;align-items:center;font-size:11.5px}.rf-sv-sw{display:inline-block;width:12px;height:12px;border-radius:3px;flex:none}
    .rf-sv-leg .acts{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.rf-sv-leg .acts button,.rf-sv-leg select{padding:2px 8px;font-size:11.5px}
    .rf-sv-leg .note{margin-top:5px;font-size:11.5px;padding:3px 6px;border-radius:7px;background:color-mix(in srgb,var(--warn,#d29922) 16%,transparent)}
    .rf-sv-say{position:absolute;z-index:1002;left:50%;bottom:34px;transform:translateX(-50%);max-width:calc(100% - 40px);display:flex;gap:8px;align-items:center;padding:6px 8px 6px 12px;border-radius:10px;
      background:rgba(20,20,20,.92);color:#fff;font:12.5px/1.35 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35)}
    .rf-res-on-sheet>.rf-sv-say{bottom:calc(var(--rf-res-hpx,0px) + 12px)}
    .rf-sv-say[hidden],.rf-sv-leg[hidden],.rf-sv-panel[hidden]{display:none}  /* the note's display:flex beat the hidden attribute: it never went */
    .rf-sv-open>.leaflet-control-container .leaflet-top.leaflet-left{z-index:1004}  /* the open menu over the legend, the scale, the credits and a results sheet */
    .rf-sv-say button{flex:none;font:inherit;padding:3px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;cursor:pointer;white-space:nowrap}
    .rf-sv-tile .g{border:1px solid var(--line,#8884);border-radius:10px;padding:5px 8px;margin:6px 0}.rf-sv-tile .g b{font-weight:650}
    .rf-sv-tile .verdict{margin:2px 0 6px;font-weight:600}.rf-sv-tile .verdict.fail{color:var(--bad-ink,#cf222e)}.rf-sv-tile .verdict.pass{color:var(--good-ink,#1a7f37)}
    .rf-sv-tile .kv{font-size:12px;color:var(--ink-2,var(--muted,#555))}.rf-sv-tile .mono{font-family:ui-monospace,monospace}
    @media (max-width:699px){.leaflet-right .rf-sv-leg{margin-bottom:62px!important}}  /* above a phone's scale bar and credit line, not over them */
    @media (pointer:coarse){.rf-sv-panel button,.rf-sv-panel label.rf-sv-file{min-height:40px}.rf-sv-leg .chip,.rf-sv-leg .acts button,.rf-sv-leg select,.rf-sv-leg .hd button{min-height:40px}}`;
  document.head.appendChild(css);
  const ICON = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="#2fa35f"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="#fab219"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="#fab219" opacity=".55"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="#e5534b"/><path d="M13 21 21 13M16 21l5-5M13 18l5-5" stroke="rgba(20,20,20,.6)" stroke-width="1.2"/></svg>';

  /* ---------- the squares: one canvas in its own pane, under the tower dots ---------- */
  const Tiles = L.Layer.extend({
    initialize(c){ this._c = c; },
    onAdd(map){
      const pane = map.getPane("rfSurvey") || map.createPane("rfSurvey");
      pane.style.zIndex = 350; pane.style.pointerEvents = "none";  // under the overlay pane's dots (400) and the markers (600); clicks go to the map
      const cv = this._cv = L.DomUtil.create("canvas", "rf-sv-cv leaflet-zoom-animated", pane);
      cv.style.position = "absolute"; cv.style.pointerEvents = "none";
      cv._rfDraw = (g, k) => { g.scale(k, k); return this._paint(g, k, ll => map.latLngToContainerPoint(ll), map.getBounds()); };  // mapexport.js: drawn again at the image's scale
      map.on("moveend resize viewreset", this._draw, this); map.on("zoomanim", this._anim, this); map.on("zoom", this._zoom, this);
      this._draw();
    },
    onRemove(map){ map.off("moveend resize viewreset", this._draw, this); map.off("zoomanim", this._anim, this); map.off("zoom", this._zoom, this); this._cv.remove(); this._cv = null; },
    // as Leaflet's own renderers do: while the map zooms the canvas is scaled with it, then drawn again where it lands
    _anim(e){ this._move(e.center, e.zoom); },
    _zoom(){ if (!this._map._animatingZoom) this._move(this._map.getCenter(), this._map.getZoom()); },
    _move(center, zoom){ const m = this._map; if (!this._at || !this._cv) return;
      const scale = m.getZoomScale(zoom, this._at.zoom), half = m.getSize().multiplyBy(0.5 + this._pad), cp = m.project(this._at.center, zoom);
      const tl = half.multiplyBy(-scale).add(cp).subtract(m._getNewPixelOrigin(center, zoom));
      L.DomUtil.setTransform(this._cv, tl, scale); },
    redraw(){ if (this._map) this._draw(); },
    _draw(){
      const m = this._map, cv = this._cv; if (!m || !cv || !m._loaded) return;
      const size = m.getSize(), pad = this._pad = 0.25, dpr = Math.min(3, window.devicePixelRatio || 1);
      const p0 = size.multiplyBy(-pad).round(), full = size.multiplyBy(1 + 2 * pad).round();
      this._at = {center: m.getCenter(), zoom: m.getZoom()};
      L.DomUtil.setPosition(cv, m.containerPointToLayerPoint(p0));
      cv.style.width = `${full.x}px`; cv.style.height = `${full.y}px`;
      const W = Math.round(full.x * dpr), H = Math.round(full.y * dpr); if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
      const g = cv.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const box = L.latLngBounds(m.containerPointToLatLng(p0), m.containerPointToLatLng(p0.add(full)));
      this._n = this._paint(g, dpr, ll => m.latLngToContainerPoint(ll).subtract(p0), box);
    },
    // every square in box: its fill and alpha (survey.js look), hatching where it fails, a hairline round each, the open one
    // outlined. -> how many were drawn
    _paint(g, scale, toPx, box){
      const c = this._c, tiles = c.tiles(box); if (!tiles) return 0;
      // the pattern is made at the device's pixels and the context is already scaled: it's scaled back, or the stripes came out
      // scale times sparser (2-3x on a phone, k in a saved image) and small failing squares had none (review 11/12)
      const o = c.lookOpts(tiles), hatch = SC.hatch(g, scale); let n = 0, selT = null;
      if (hatch && hatch.setTransform && typeof DOMMatrix === "function" && scale !== 1) hatch.setTransform(new DOMMatrix().scale(1 / scale));
      const v = window.RFResults && RFResults.get(this._map), sel = c.sel && v && v.key === `sv:t:${c.sel}` ? c.sel : null;
      const s = box.getSouth(), w = box.getWest(), nn = box.getNorth(), e = box.getEast();
      for (const t of tiles.values()) {
        if (t.n < s || t.s > nn || t.e < w || t.w > e) continue;
        const lk = SV.look(t, o); if (!lk) continue;
        const a = toPx([t.n, t.w]), b = toPx([t.s, t.e]), x = Math.round(a.x * 2) / 2, y = Math.round(a.y * 2) / 2, ww = Math.max(1, b.x - a.x), hh = Math.max(1, b.y - a.y);
        g.globalAlpha = lk.alpha; g.fillStyle = lk.fill; g.fillRect(x, y, ww, hh);
        if (lk.hatch && hatch && ww > 3) { g.globalAlpha = Math.min(1, lk.alpha + 0.25); g.fillStyle = hatch; g.fillRect(x, y, ww, hh); }
        if (ww >= 6) { g.globalAlpha = 0.35; g.strokeStyle = "rgba(20,20,20,.55)"; g.lineWidth = 0.6; g.strokeRect(x + 0.3, y + 0.3, ww - 0.6, hh - 0.6); }
        if (sel === t.key) selT = [x, y, ww, hh];
        n++;
      }
      if (selT) { g.globalAlpha = 1; g.strokeStyle = "#ff7a1a"; g.lineWidth = 2.5; g.strokeRect(selT[0] - 1, selT[1] - 1, selT[2] + 2, selT[3] + 2); }
      this._sel = selT ? sel : null;  // the square outlined now, for the checks
      g.globalAlpha = 1;
      return n;
    }
  });

  /* ---------- one map's survey ---------- */
  function make(map, opt){
    const slot = opt.slot || String(map._rfKey || "map").split(":")[0];
    const kept = slots.get(slot) || {run: null, rs: [], f: {metric: "rsrp", carriers: null, bands: null, techs: null, size: 0, only: null}, open: null};
    slots.set(slot, kept);
    const c = {map, opt, slot, kept, sel: null, cache: null, msg: "", runs: null, listFor: null, profile: null, profFor: null};
    Object.defineProperty(c, "run", {get: () => kept.run}); Object.defineProperty(c, "rs", {get: () => kept.rs}); Object.defineProperty(c, "f", {get: () => kept.f});
    c.scope = () => scopeOf(map);
    c.site = () => (opt.site && opt.site()) || (hasS() && S.center) || null;
    // the carriers on: the legend's chips, within the Towers tab's when it has some picked (FirstNet goes with AT&T)
    c.outer = () => { const o = opt.carriers && opt.carriers(); if (!o || !o.length) return null; const s = new Set(o); if (s.has("AT&T")) s.add("FirstNet"); return s; };
    c.filt = () => { const own = kept.f.carriers, out = c.outer();
      const cs = own && out ? [...own].filter(x => out.has(x)) : own ? [...own] : out ? [...out] : null;
      return {carriers: cs, bands: kept.f.bands ? [...kept.f.bands] : null, techs: kept.f.techs ? [...kept.f.techs] : null, kind: kindOf(kept.run), profile: c.profile || undefined}; };
    // the readings shown: the run's, or only one site's (the tile viewer's Only this site), that site's carrier and technology alone
    c.shown = () => { const k = kept.f.only; if (!k) return kept.rs; return kept.rs.filter(r => r.serving >= 1 && SV.serverOf(r) === k); };
    // what the squares, the exports and the colours show: the chips, and within them Only this site's carrier and technology
    // (with a chip that hides that site's carrier, nothing: the squares and the CSV said different things, review 11/12)
    c.eff = () => { const F = c.filt(), only = kept.f.only; if (!only) return F;
      const [oc, ot] = only.split("|"); return {...F, carriers: F.carriers ? F.carriers.filter(x => x === oc) : [oc], techs: F.techs ? F.techs.filter(x => x === ot) : [ot]}; };
    c.size = () => SV.tileSize(map.getZoom(), kept.f.size || undefined);
    c.key = () => { const F = c.filt(); return [c.size(), kept.f.metric, F.carriers ? F.carriers.join("+") : "*", F.bands ? F.bands.join("+") : "*", F.techs ? F.techs.join("+") : "*", kept.f.only || "", kept.rs.length, kept.run?.id ?? "", c.profile ? c.profile.name || "p" : ""].join("|"); };
    // the squares: the whole run summed up once per size and filter; a big run, the part in view, judged as the whole run measures
    c.tiles = box => {
      if (!kept.run || !kept.rs.length) return null;
      const F = c.eff(), rs = c.shown(), big = rs.length > PART, k = c.key();
      const o = {...F, size: c.size(), metric: kept.f.metric === "best" ? "rsrp" : kept.f.metric};
      if (!big) { if (c.cache && c.cache.k === k) return c.cache.tiles; c.cache = {k, tiles: SV.aggregate(rs, o)}; return c.cache.tiles; }
      const pb = (box || map.getBounds()).pad(0.5), bk = `${k}|${pb.toBBoxString()}`;
      if (c.cache && c.cache.bk === bk) return c.cache.tiles;
      const hk = `${k}|heard`; if (!c.heardC || c.heardC.k !== hk) c.heardC = {k: hk, v: SV.heard(rs, o)};
      const part = rs.filter(r => pb.contains([r.lat, r.lon]));
      c.cache = {k, bk, tiles: SV.aggregate(part, {...o, heard: c.heardC.v})}; return c.cache.tiles;
    };
    c.coloursFor = () => { const k = `${c.key()}|best`; if (!c.colC || c.colC.k !== k) c.colC = {k, v: SV.colours(c.shown(), c.eff())}; return c.colC.v; };
    // Best server's legend rows: the sites of the squares drawn, each its colour, in the colours' order; a colour on the map is
    // never one the legend gives a hidden site (review 11/12). -> [[server, colour]], up to six, and whether any other is drawn
    c.bestRows = tiles => { const cols = c.coloursFor(), drawn = new Set(); let other = false;
      for (const t of (tiles || new Map()).values()) if (SV.look(t, {mode: "best", colours: cols})) { if (t.server && cols.get(t.server) !== SC.OTHER) drawn.add(t.server); else other = true; }
      const rows = [...cols].filter(([k]) => drawn.has(k)); return {rows: rows.slice(0, 6), other: other || rows.length > 6}; };
    // the higher pass line (3.3 GHz and up: C-band, CBRS) when it differs from the one the bar shows and the run has readings there
    c.hiLine = sc => { if (kept.f.metric !== "rsrp" || sc.thr == null) return null; const P = c.profile || undefined;
      // each carrier the run has at 3.3 GHz and up, its own line (a profile's hi_by: Cooper's Verizon -105): the legend said -100 for
      // squares judged at -105, and nothing at all where only hi_by was set (review 11/12, round 2). -> "-100 dBm", "Verizon -105, AT&T -100 dBm" or null
      const cars = new Set(); for (const r of kept.rs) if (r.serving >= 1 && SV.layerOf(r) === "hi") cars.add(r.carrier || "");
      const by = [...cars].map(x => [x, SC.passLine("rsrp", x || null, "hi", P)]).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const vals = [...new Set(by.map(([, v]) => v))];
      if (!vals.length || (vals.length === 1 && vals[0] === sc.thr)) return null;
      return vals.length === 1 ? `${vals[0]} dBm` : `${by.map(([x, v]) => `${x || "other"} ${v}`).join(", ")} dBm`; };
    c.lookOpts = tiles => { const m = kept.f.metric;
      if (m === "best") return {mode: "best", colours: c.coloursFor()};
      const sc = c.scale(tiles); return {metric: m, range: sc.thr == null ? {thr: null, lo: sc.lo, hi: sc.hi} : undefined}; };
    // the legend's scale: the pass line below 3.3 GHz (the job's profile, else Common); a metric with none, the squares' lowest to highest
    c.scale = tiles => { const m = kept.f.metric === "best" ? "rsrp" : kept.f.metric, P = c.profile || undefined, line = SC.passLine(m, null, "lo", P);
      if (line != null) return SC.forCell(m, null, "lo", P, null);
      const vals = []; for (const t of (tiles || c.tiles() || new Map()).values()) if (t.value != null) vals.push(t.value);
      return SC.scale(m, null, vals); };

    c.layer = new Tiles(c);
    c.redraw = () => { if (map.hasLayer(c.layer)) c.layer.redraw(); paintLegend(c); };
    c.changed = why => { try{ opt.changed && opt.changed(c, why || ""); }catch(e){ console.error(e); } };
    // a run on the map: the squares, the legend, the profile it's judged by; the map doesn't move
    c.set = (run, rs, o = {}) => {
      const was = kept.run && kept.run.id;
      kept.run = run; kept.rs = rs || []; c.cache = null; c.colC = null; c.heardC = null; c.idx = null; c.sel = null;
      if (was !== (run && run.id)) { kept.f.only = null; kept.f.carriers = null; kept.f.bands = null; kept.f.techs = null; }
      if (run && !map.hasLayer(c.layer)) c.layer.addTo(map);
      if (!run && map.hasLayer(c.layer)) map.removeLayer(c.layer);
      if (run) { map._rfLegends = map._rfLegends || new Set(); map._rfLegends.add(c.legendPaint); } else if (map._rfLegends) map._rfLegends.delete(c.legendPaint);
      const v = window.RFResults && RFResults.get(map); if (v && /^sv:/.test(v.key) && !o.keepViewer) RFResults.close(map, false);
      c.loadProfile(); c.redraw(); paintPanel(c); if (!o.quiet) c.changed();
    };
    c.hide = () => c.set(null, []);
    // more readings of the run on the map (a recording's): drawn again, the viewer and the filters as they are
    c.more = (rs) => { if (!kept.run || !rs.length) return; kept.rs.push(...rs); c.cache = null; c.colC = null; c.heardC = null; c.idx = null; c.redraw();
      c.changed("more"); };  // the open tower's Seen on site follows a recording (towers.js redraws only when what it says changed)
    // the open job's cellular profile sets the pass lines (dascell.js cellProfile); none: Common
    c.loadProfile = async () => { const s = c.scope(), k = `${s.scope}:${s.id}`; if (c.profFor === k) return; c.profFor = k; c.profile = null;
      if (s.scope !== "job" || typeof cellProfile !== "function") return;
      try{ const j = await call(`/api/das/jobs/${s.id}`, {dasRaw: true}); if (c.profFor !== k) return; const d = j.data || {};
        if ((d.cellular || {}).profile) { c.profile = cellProfile(d); c.cache = null; c.redraw(); c.changed(); } }
      catch(e){ /* the job isn't readable here: Common's lines */ } };
    c.list = async () => { const s = c.scope(), k = `${s.scope}:${s.id}`;
      try{ const r = await call(`/api/survey?scope=${s.scope}&id=${s.id}`); if (c.scope().scope !== s.scope || c.scope().id !== s.id) return; c.runs = r.runs || []; c.listFor = k; c.listMsg = ""; }
      catch(e){ c.runs = []; c.listFor = k; const none = /runs on the PC only|not found/i.test(e.message);
        if (none) c.noServer = "surveys are kept by a DAStastic copy with a server: the PC app or the 24/7 server";
        c.listMsg = none ? "Surveys are kept by a DAStastic copy with a server (the PC app or the 24/7 server): this one can show the sample." : `Surveys: ${e.message}`; }
      paintPanel(c); };
    // a run's readings, a page at a time (survey.py PAGE: 50,000), drawn as they come
    c.open = async run => {
      const s = c.scope(), seq = c.seq = (c.seq || 0) + 1; c.msg = ""; c.loading = {run, got: 0}; paintPanel(c);
      let since = null, first = true;
      try{
        for (;;) { const r = await call(`/api/survey/readings?scope=${s.scope}&id=${s.id}&run=${run.id}${since != null ? `&since=${since}` : ""}`); if (seq !== c.seq) return;
          const got = SV.fromRows(r.cols, r.rows);
          if (!first && kept.run !== run) { c.loading = null; paintPanel(c); return; }  // hidden, or another run shown, while it came
          if (first) { c.set(run, got.slice()); first = false; } else c.more(got);
          c.loading = {run, got: kept.rs.length};
          paintLegend(c);
          if (!r.more || !got.length) break; since = got[got.length - 1].ts; }
        if (first) c.set(run, []);
      }catch(e){ if (seq !== c.seq) return; c.msg = `Not loaded: ${e.message}`; }
      c.loading = null; paintPanel(c); paintLegend(c); c.changed();
    };
    c.sample = () => { const ct = map.getCenter(), s = SV.sample(+ct.lat.toFixed(5), +ct.lng.toFixed(5)); c.set(s.run, s.readings); c.say(`${SV.SAMPLE_NAME}: ${n0(s.readings.length)} made-up readings, drawn where the map is. Nothing is saved.`); };
    // a file in: POST /api/survey/import with the file as the body (any size: the server reads it in pieces); then shown, and a
    // note offers Zoom to run. The map doesn't fit by itself
    c.importFile = async file => {
      if (!file) return; const s = c.scope();
      if (!canPost()) { c.msg = "A view-only login can't import: ask whoever runs this copy."; paintPanel(c); c.say(c.msg); return; }
      c.msg = `Importing ${file.name} (${(file.size / 1048576).toFixed(file.size > 1048576 ? 1 : 2)} MB)…`; c.busy = true; paintPanel(c);
      const q = new URLSearchParams({scope: s.scope, id: s.id, name: file.name, utc_offset: String(-new Date().getTimezoneOffset())});
      if (kept.keep) { const st = c.site(); q.set("keep_mi", "2"); if (st && s.scope === "scratch") { q.set("lat", st[0]); q.set("lon", st[1]); } }
      try{
        const r = await fetch(`/api/survey/import?${q}`, {method: "POST", headers: {"Content-Type": "application/octet-stream"}, body: file});
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.run) { c.busy = false; c.msg = `${j.error}`; await c.list(); const old = (c.runs || []).find(x => x.id === j.run.id); if (old) { c.open(old); c.say(`Already imported: showing “${old.name}”.`, ["Zoom to run", () => c.zoomRun()]); } return; }
        if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
        c.busy = false; c.msg = ""; await c.list();
        await c.open(j);
        const drop = Object.entries(j.dropped || {}).map(([w, n]) => `${n0(n)} ${w}`).join(", ");
        c.say(`Imported ${n0(j.added)} readings from ${file.name}${drop ? ` (left out: ${drop})` : ""}${j.trimmed ? `, ${n0(j.trimmed)} beyond 2 mi of the site` : ""}.`, ["Zoom to run", () => c.zoomRun()]);
        if ((j.notes || []).length) { c.msg = j.notes.join("\n"); paintPanel(c); }
      }catch(e){ c.busy = false; c.msg = `Not imported: ${e.message}`; paintPanel(c); c.say(c.msg, null, 15000); }  // said where the person looks too
    };
    c.bounds = (rs = c.shown()) => { let s = 90, w = 180, n = -90, e = -180; for (const r of rs) { if (r.lat < s) s = r.lat; if (r.lat > n) n = r.lat; if (r.lon < w) w = r.lon; if (r.lon > e) e = r.lon; }
      return n >= s ? [[s, w], [n, e]] : null; };
    // Zoom to run: the one thing here that moves the map (asked for)
    c.zoomRun = () => { const b = c.bounds(); if (!b) return; const v = map.getContainer().querySelector(":scope > .rf-res"), lay = v && v.dataset.lay, br = [30, 30];
      if (lay === "side") br[0] += v.offsetWidth + 10; else if (lay === "sheet") br[1] += v.offsetHeight + 6;  // into the part the viewer leaves free, as its Zoom to
      map.fitBounds(b, {paddingTopLeft: [30, 30], paddingBottomRight: br, maxZoom: 17}); map.fire("rfzoomto"); };  // Follow me lets go (surveyrec.js)
    // a line on the map for a few seconds, with one button when there's something to do
    c.say = (msg, btn, ms) => { const box = map.getContainer(); let el = box.querySelector(":scope > .rf-sv-say");
      if (!el) { el = L.DomUtil.create("div", "rf-sv-say", box); el.setAttribute("role", "status"); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
      el.innerHTML = `<span>${h(msg)}</span>${btn ? `<button type="button" data-svsay>${h(btn[0])}</button>` : ""}<button type="button" data-svx aria-label="Close" title="Close">✕</button>`; el.hidden = false;
      placeSay(c, el);
      clearTimeout(c.sayT); c.sayT = setTimeout(() => c.hideSay(), ms || (btn ? 12000 : 6000));
      const b = el.querySelector("[data-svsay]"); if (b) b.onclick = ev => { L.DomEvent.stop(ev); c.hideSay(); btn[1](); };
      el.querySelector("[data-svx]").onclick = ev => { L.DomEvent.stop(ev); c.hideSay(); }; };
    // the note gone, and the room it took from the open legend given back
    c.hideSay = () => { const el = map.getContainer().querySelector(":scope > .rf-sv-say"); if (el) el.hidden = true; clearTimeout(c.sayT);
      if (c.legRoom) { c.legRoom = 0; c.fitLegend(); } };
    c.download = (name, data, type) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], {type})); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
    // the run's readings the chips leave (a carrier's, a band's, a technology's, neighbours included), for the legend's exports
    c.exportRs = () => { const F = c.eff(), C = F.carriers && new Set(F.carriers), B = F.bands && new Set(F.bands), T = F.techs && new Set(F.techs);
      return c.shown().filter(r => (!C || C.has(r.carrier)) && (!B || B.has(String(r.band))) && (!T || T.has(r.tech))); };
    // the sample's files say "SAMPLE: made-up data" first, and the import refuses them (survey.py SAMPLE_MARK)
    c.save = (fmt, rs = c.exportRs(), what = "") => { const run = kept.run; if (!run) return; const smp = !!run.sample, base = fileSafe(`${smp ? "SAMPLE made-up data - " : ""}${run.name}${what ? ` - ${what}` : ""}`);
      if (fmt === "csv") return c.download(`${base}.csv`, SV.csv(rs, run.source, {sample: smp}), "text/csv;charset=utf-8");
      const k = SV.kml(rs, {name: `${run.name}${what ? ` - ${what}` : ""}`, sample: smp, metric: kept.f.metric === "best" ? "rsrp" : kept.f.metric, profile: c.profile || undefined,
        note: `${run.sample ? "MADE UP: a sample, not a real site. " : ""}Serving readings from ${SRC[run.source] || run.source}${isPhone(run) ? " (a phone: indicative, not calibrated)" : ""}, coloured against the pass line (red weak, amber on the line, green good).`});
      if (fmt === "kml") return c.download(`${base}.kml`, k, "application/vnd.google-earth.kml+xml");
      if (window.RFTak) return c.download(`${base}.kmz`, RFTak.zip([{name: "doc.kml", data: k}]), "application/vnd.google-earth.kmz"); };
    c.tileAt = ll => { const t = c.tiles(); if (!t) return null; const k = SV.tileKey(ll.lat, ll.lng, c.size()); const x = t.get(k); return x && SV.look(x, c.lookOpts(t)) ? x : null; };
    c.openTile = t => openTile(c, t);
    // Seen on site for a tower's carrier entries: the run's serving readings matched to it (survey.js seenOf). Never the sample's
    c.seen = entries => { if (!kept.run || kept.run.sample || !kept.rs.length) return null;
      const st = c.site(), k = `${kept.run.id}|${kept.rs.length}|${st ? st.join(",") : ""}`;
      if (!c.idx || c.idx.k !== k) c.idx = {k, v: SV.seenIndex(kept.rs, {site: st, near: 100})};
      return SV.seenOf(c.idx.v, entries); };
    c.legendPaint = (g, k, xr, yb) => legendCanvas(c, g, k, xr, yb);
    c.paint = () => paintPanel(c);
    // the legend no taller than the map leaves under the top right controls (the zoom bar, a recording's status line), and on a
    // narrow map clear of the left column of buttons: at 390 px it covered ▦ Survey, + Marker and, opened, Stop (review 11/12)
    c.fitLegend = () => { const el = c.legEl; if (!el || el.hidden) return; const box = map.getContainer(), b0 = box.getBoundingClientRect(), W = box.clientWidth;
      el.style.width = `${Math.max(200, Math.min(330, W - 86))}px`;
      const tr = Math.max(0, ...[...box.querySelectorAll(".leaflet-top.leaflet-right .leaflet-control")].map(x => x.getBoundingClientRect().bottom - b0.top));
      // no taller than the room under the top-right controls; and while a note needs room (c.legRoom), that much shorter than it
      // is: a legend shorter than its room gave nothing
      el.style.maxHeight = ""; const r = el.getBoundingClientRect(), room = r.bottom - b0.top - tr - 8;
      const take = Math.max(c.legRoom || 0, c.legFollow || 0);  // a note's room, or Follow me's (surveyrec.js), whichever is more
      el.style.maxHeight = `${Math.max(56, (take ? Math.min(room, r.height) : room) - take)}px`; };  // 56: its header row, the rest scrolling (a phone with a sheet and the status line up)
    all.add(c);
    map.on("unload", () => { all.delete(c); clearTimeout(c.sayT); });
    map.on("resize", () => c.fitLegend());
    return c;
  }
  // the note's place: centred in the part a side panel leaves free, and above whatever sits at the bottom under it (the legend, the
  // scale and credit line, a results sheet): at 1700x950 it covered the legend's square size and Zoom to run (review 11/12)
  function placeSay(c, el){
    const box = c.map.getContainer(), b0 = box.getBoundingClientRect(), v = box.querySelector(":scope > .rf-res"), W = box.clientWidth;
    const free = v && v.dataset.lay === "side" ? Math.max(120, W - v.offsetWidth - 10) : W, w = Math.min(el.offsetWidth || 300, free - 20), cx = free / 2;
    el.style.left = `${Math.round(cx)}px`;
    // above a sheet and the bottom controls it would meet (the legend, the scale bar)
    const under = () => { let b = 34;
      if (v && v.dataset.lay === "sheet") b = Math.max(b, v.offsetHeight + 12);
      for (const x of box.querySelectorAll(".leaflet-bottom .leaflet-control")) { if (x.hidden || !x.offsetHeight) continue; const r = x.getBoundingClientRect();
        if (r.right - b0.left > cx - w / 2 && r.left - b0.left < cx + w / 2) b = Math.max(b, b0.bottom - r.top + 8); }
      return b; };
    if (c.legRoom) { c.legRoom = 0; c.fitLegend(); }
    let bottom = under();
    // and never over the top right corner's controls it would meet (the recording's status line with its ■ Stop, the zoom bar)
    let top = 0; const nh = el.offsetHeight || 60;
    for (const x of box.querySelectorAll(".leaflet-top.leaflet-right .leaflet-control")) { if (x.hidden || !x.offsetHeight) continue; const r = x.getBoundingClientRect();
      if (r.right - b0.left > cx - w / 2 && r.left - b0.left < cx + w / 2) top = Math.max(top, r.bottom - b0.top + 8); }
    // no room between them (a phone with a sheet and the legend open): the legend gives the note its room for as long as the note
    // shows, scrolling inside meanwhile (the note sat over its chips at 390 px); then, if still short, the note goes under the top
    // controls and over the legend
    const short = top ? top + nh - (box.clientHeight - bottom) : 0, leg = c.legEl;
    if (short > 0 && leg && !leg.hidden && leg.offsetHeight > 90) { c.legRoom = short + 4; c.fitLegend(); bottom = under(); }
    if (top && box.clientHeight - bottom - nh < top) bottom = Math.max(8, box.clientHeight - top - nh);
    el.style.bottom = `${Math.round(Math.min(bottom, box.clientHeight - 60))}px`;
  }

  /* ---------- the Survey button and its panel ---------- */
  const Ctl = L.Control.extend({
    options: {position: "topleft"},
    onAdd(map){
      const c = this._c, box = L.DomUtil.create("div", "leaflet-bar rf-sv"), b = L.DomUtil.create("a", "rf-ms-btn", box);
      b.href = "#"; b.title = "Survey: show a drive or walk survey's squares, import a log, or record (DAStastic for Android)"; b.setAttribute("role", "button"); b.setAttribute("aria-label", "Survey");
      b.dataset.svBtn = ""; b.innerHTML = ICON;
      const pn = L.DomUtil.create("div", "rf-sv-panel", box); pn.hidden = true;
      L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(b, "click", ev => { L.DomEvent.preventDefault(ev); pn.hidden ? c.openPanel() : c.closePanel(); });
      c.btn = b; c.panel = pn;
      c.openPanel = () => { if (map._rfMeasure?._on) map._rfMeasure.stop(); pn.hidden = false; b.classList.add("on"); map.getContainer().classList.add("rf-sv-open"); paintPanel(c); c.list(); };
      c.closePanel = () => { pn.hidden = true; b.classList.remove("on"); map.getContainer().classList.remove("rf-sv-open"); };
      return box;
    }
  });
  function paintPanel(c){
    const pn = c.panel; if (!pn || pn.hidden) return;
    const s = c.scope(), run = c.run, mine = c.listFor === `${s.scope}:${s.id}` ? c.runs : null, post = canPost();
    // no taller than the map below where it opens (it opens under the last button of the left column: on a phone that's
    // half way down, and it ran off the map's bottom with Record below the runs)
    const mb = c.map.getContainer().getBoundingClientRect(), at = pn.getBoundingClientRect().top - mb.top;
    pn.style.maxHeight = `${Math.max(180, Math.min(c.map.getSize().y - 120, mb.height - at - 12))}px`;
    // on the phone (the app's bridge there) Record comes first: it's what the phone is for; on a computer the line saying it
    // needs the app goes last
    const rec = window.RFSurveyRec ? RFSurveyRec.section(c) : "", recFirst = !!(window.RFSurveyRec && RFSurveyRec.available());
    pn.innerHTML = `<b>Survey</b> <span class="rf-sv-hint">· kept with ${h(s.name)}</span> <button type="button" class="rf-sv-q" data-svhelp="survey" title="Help: what the colours mean, how to record and import" aria-label="Help: the survey map">?</button>
      ${c.busy ? '<div class="rf-sv-hint">Working…</div>' : ""}${c.msg ? `<div class="rf-sv-msg" data-svmsg>${h(c.msg)}</div>` : ""}${c.listMsg ? `<div class="rf-sv-msg">${h(c.listMsg)}</div>` : ""}
      ${recFirst ? rec : ""}
      <div class="rf-sv-hint">Pick a run to paint its squares; the map stays where it is.</div>
      ${mine == null ? '<div class="rf-sv-hint">Asking for the runs…</div>' : !mine.length ? '<div class="rf-sv-hint">No surveys kept here yet: import one, record one or load the sample.</div>'
        : mine.map(r => `<button type="button" class="rf-sv-run${run && run.id === r.id ? " on" : ""}" data-svrun="${r.id}" title="${h(`${r.name}: ${n0(r.readings)} readings from ${SRC[r.source] || r.source}${r.created_by ? `, by ${r.created_by}` : ""}`)}">
          <span class="grow">${h(r.name)}</span><span class="rf-sv-hint" style="margin:0">${h(day(r.started_at))} · ${n0(r.readings)}</span></button>`).join("")}
      <button type="button" class="rf-sv-run${run && run.sample ? " on" : ""}" data-svsample title="Made-up readings drawn where the map is, for a demo: never saved, never with the real runs"><span class="grow">${h(SV.SAMPLE_NAME)}</span><span class="rf-sv-tag">SAMPLE</span></button>
      ${c.loading ? `<div class="rf-sv-hint">Loading “${h(c.loading.run.name)}”: ${n0(c.loading.got)} readings so far…</div>` : ""}
      <div class="row">${post && !c.noServer ? `<label class="rf-sv-file" title="G-NetTrack Pro, a scanner's CSV or Excel export (PCTEL and others), or the template">⇪ Import a file<input type="file" data-svfile hidden accept=".csv,.txt,.xlsx,.xls,.json,.kml,.kmz,.gpx,.tsv"></label>` : ""}
        <button type="button" data-svtpl title="The template's columns, with four example readings: fill it from any log">⇩ Template</button>
        ${run ? `<button type="button" data-svhide>Hide squares</button>` : ""}<button type="button" data-svclose>Close</button></div>
      ${post && !c.noServer ? `<label class="rf-sv-chk" title="Privacy: readings further than 2 mi from the site are never stored (the next import or recording)"><input type="checkbox" data-svkeep ${c.kept.keep ? "checked" : ""}><span>Keep only what's within 2 mi of the site</span></label>` : ""}
      ${recFirst ? "" : rec}`;
    pn.scrollTop = 0;
    const on = (q, fn) => pn.querySelectorAll(q).forEach(el => el.onclick = ev => { L.DomEvent.stop(ev); fn(el); });  // each stops its own click (measure.js)
    on("[data-svrun]", el => { const r = (c.runs || []).find(x => x.id === +el.dataset.svrun); if (r) { if (c.run && c.run.id === r.id) c.hide(); else c.open(r); } });
    on("[data-svsample]", () => { if (c.run && c.run.sample) c.hide(); else c.sample(); });
    on("[data-svhide]", () => c.hide());
    on("[data-svclose]", () => c.closePanel());
    on("[data-svtpl]", async () => { try{ const r = await fetch("/api/survey/template"); if (!r.ok) throw new Error(`HTTP ${r.status}`); c.download("DAStastic survey template.csv", await r.blob(), "text/csv"); }
      catch(e){ c.msg = `Template: ${e.message}`; paintPanel(c); } });
    const f = pn.querySelector("[data-svfile]"); if (f) { f.onclick = ev => ev.stopPropagation(); f.onchange = () => { const file = f.files && f.files[0]; f.value = ""; c.importFile(file); }; }
    const k = pn.querySelector("[data-svkeep]"); if (k) k.onchange = () => { c.kept.keep = k.checked; paintPanel(c); };  // Record says if it now needs the site
    on("[data-svhelp]", el => { if (typeof openHelp === "function") openHelp(el.dataset.svhelp); });
    if (window.RFSurveyRec) RFSurveyRec.wire(c, pn);
  }

  /* ---------- the legend: what the colours mean, the chips, the exports ---------- */
  const Legend = L.Control.extend({
    options: {position: "bottomright"},
    onAdd(){ const el = L.DomUtil.create("div", "leaflet-control rf-sv-leg"); el.hidden = true; el.dataset.shrink = "90"; L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); this._c.legEl = el; return el; }
  });
  function legendFacts(c){
    const rs = c.rs, cars = new Set(), bands = new Set(), techs = new Set();
    for (const r of rs) if (r.serving >= 1) { cars.add(r.carrier); if (r.band != null) bands.add(String(r.band)); techs.add(r.tech); }
    return {cars: [...cars].sort(byCarrier), bands: [...bands].sort(byBand), techs: [...techs].sort()};
  }
  function paintLegend(c){
    const el = c.legEl; if (!el) return;
    const run = c.run; if (!run) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false; el.style.setProperty("--rf-sv-max", `${Math.max(160, c.map.getSize().y - 150)}px`);
    if (c.kept.open == null) { const z = c.map.getSize(); c.kept.open = !TOUCH && z.x >= 1000 && z.y >= 600; }
    const f = c.f, F = c.filt(), tiles = c.tiles(), facts = legendFacts(c), m = f.metric, sc = c.scale(tiles), outer = c.outer();
    const chip = (grp, val, label, on, title) => `<button type="button" class="chip${on ? " on" : ""}" data-svc="${grp}" data-v="${h(val)}" aria-pressed="${on}"${title ? ` title="${h(title)}"` : ""}>${h(label)}</button>`;
    const group = (grp, k, vals, set, lab = x => x) => vals.length < 2 ? "" : `<div class="grp" role="group" aria-label="${h(k)}"><span class="k">${h(k)}</span>${chip(grp, "", "All", !set)}${vals.map(v => chip(grp, v, lab(v), !!set && set.has(v))).join("")}</div>`;
    let n = 0, fails = 0, dead = 0; if (tiles) { const o = c.lookOpts(tiles); for (const t of tiles.values()) { const lk = SV.look(t, o); if (lk) { n++; if (lk.hatch) fails++; if (t.missing && t.missing.length) dead++; } } }
    const um = (tiles && tiles.unmeasured) || [];
    const label = {rsrp: "RSRP", rsrq: "RSRQ", sinr: "SINR"}[m];
    const hiLine = c.hiLine(sc), best = m === "best" ? c.bestRows(tiles) : {rows: [], other: false};
    // below the line only where there is one (RSRQ has none: it said "0 below the line" under "no requirement"); dead spots apart
    const counted = m === "best" ? "" : sc.thr != null ? `, ${n0(fails)} below the line` : dead ? `, ${n0(dead)} dead spot${dead === 1 ? "" : "s"}` : "";
    // Only <site> with chips that leave none of it: its carrier, or its band or technology (review 11/12, round 2: only the carrier said)
    const onlyHidden = f.only && (!(c.eff().carriers || []).length ? "its carrier" : !(c.eff().techs || []).length || (tiles && !tiles.size) ? "its band or technology" : "");
    el.innerHTML = `<div class="hd"><div class="tt">▦ ${h(run.name)} ${run.sample ? '<span class="rf-sv-tag">SAMPLE</span>' : ""}</div>
        <button type="button" data-svl="fold" aria-expanded="${!!c.kept.open}" title="${c.kept.open ? "Fewer options" : "Metric, carrier, band and technology, square size, exports"}">${c.kept.open ? "▾" : "▸"}</button>
        <button type="button" data-svl="hide" aria-label="Hide the squares" title="Hide the squares">✕</button></div>
      <div class="sub">${run.sample ? "Made-up readings, not a real site · " : ""}${n0(c.rs.length)} readings · ${h(SRC[run.source] || run.source)}${isPhone(run) ? " (indicative)" : ""} · ${n0(n)} square${n === 1 ? "" : "s"} of ${c.size()} m${n ? counted : ""}${c.loading ? " · loading…" : ""}</div>
      ${c.kept.open || !TOUCH ? `<div class="grp" role="group" aria-label="Show"><span class="k">Show</span>${METRICS.map(([v, l]) => chip("metric", v, l, m === v)).join("")}</div>` : ""}
      ${c.kept.open ? group("carrier", "Carrier", facts.cars, f.carriers) + group("band", "Band", facts.bands, f.bands, bandTxt) + group("tech", "Tech", facts.techs, f.techs, techTxt) : ""}
      ${outer ? `<div class="hint" style="margin-top:4px">The Towers chips show ${h([...outer].filter(x => x !== "FirstNet").join(", "))}: only ${F.carriers && F.carriers.length ? h(F.carriers.join(", ")) : "no carrier of this run"} here.</div>` : ""}
      ${f.only ? `<div class="note">Only ${h(serverTxt(f.only))}${onlyHidden ? `: the chips hide ${onlyHidden}, so no squares` : ""} <button type="button" data-svl="all">Show all sites</button></div>` : ""}
      ${m === "best" ? `<div class="rows">${best.rows.map(([k, col]) => `<div><span class="rf-sv-sw" style="background:${col}"></span>${h(serverTxt(k))}</div>`).join("")}${best.other ? `<div><span class="rf-sv-sw" style="background:${SC.OTHER}"></span>any other site</div>` : ""}</div>
          <div class="hint">Each square is its best server's colour: the site whose cell has most readings in it. Faint: fewer than 3 moments.</div>`
        : `${SC.legendHtml(sc, {label, metric: m, hatch: true})}${hiLine != null ? `<div class="hint">3.3 GHz and up (C-band, CBRS): pass at ≥ ${hiLine}.</div>` : ""}${c.kept.open ? `
          <div class="hint">Each square: its weakest carrier's median${F.carriers && F.carriers.length === 1 ? "" : " (the one a DAS would have to fix)"}. Faint: fewer than 3 moments of measurement.</div>` : ""}`}
      ${um.length ? `<div class="note">Not measured by this run: ${h(um.join(", "))} (no pass, no fail).</div>` : ""}
      ${c.kept.open ? `<div class="acts"><label class="hint">Squares <select data-svl="size" aria-label="Square size">${[[0, `Auto (${SV.tileSize(c.map.getZoom())} m)`], [25, "25 m"], [50, "50 m"], [100, "100 m"], [200, "200 m"]].map(([v, l]) => `<option value="${v}" ${(+f.size || 0) === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <button type="button" data-svl="zoom" title="Zoom the map to the run (the only thing here that moves it)">Zoom to run</button>
          <button type="button" data-svl="csv" title="Every reading shown, as the template's columns (it imports back)">⇩ CSV</button><button type="button" data-svl="kml" title="The serving readings as points for Google Earth or ATAK">⇩ KML</button><button type="button" data-svl="kmz">⇩ KMZ</button></div>` : ""}`;
    const on = (q, fn) => el.querySelectorAll(q).forEach(b => { if (b.tagName === "SELECT") b.onchange = () => fn(b); else b.onclick = ev => { L.DomEvent.stop(ev); fn(b); }; });
    on("[data-svc]", b => { const g = b.dataset.svc, v = b.dataset.v;
      if (g === "metric") { c.f.metric = v || "rsrp"; c.cache = null; return c.redraw(); }
      const key = {carrier: "carriers", band: "bands", tech: "techs"}[g], vals = g === "carrier" ? facts.cars : g === "band" ? facts.bands : facts.techs;
      let set = c.f[key] ? new Set(c.f[key]) : null;
      if (!v) set = null; else if (!set) set = new Set([v]); else if (set.has(v)) set.delete(v); else set.add(v);
      if (set && (!set.size || set.size === vals.length)) set = null;
      c.f[key] = set; c.cache = null; c.colC = null; c.redraw(); c.changed(); });
    on("[data-svl]", b => { const k = b.dataset.svl;
      if (k === "fold") { c.kept.open = !c.kept.open; return paintLegend(c); }
      if (k === "hide") return c.hide();
      if (k === "all") { c.f.only = null; c.cache = null; c.colC = null; c.redraw(); return c.changed(); }
      if (k === "size") { c.f.size = +b.value || 0; c.cache = null; return c.redraw(); }
      if (k === "zoom") return c.zoomRun();
      if (["csv", "kml", "kmz"].includes(k)) return c.save(k, c.exportRs(), c.f.only ? serverTxt(c.f.only) : ""); });
    c.fitLegend();
  }
  // the legend for a map image (mapexport.js map._rfLegends): its right edge at xr, its bottom at yb, at the image's scale k -> its height
  function legendCanvas(c, g, k, xr, yb){
    const run = c.run; if (!run) return 0;
    const tiles = c.tiles(), m = c.f.metric, sc = c.scale(tiles), um = (tiles && tiles.unmeasured) || [], W = 300, lines = [];
    lines.push([`${run.sample ? "SAMPLE (made up) · " : ""}${run.name}`, "600 12px system-ui, sans-serif", "#111"]);
    lines.push([`${n0(c.rs.length)} readings · ${SRC[run.source] || run.source}${isPhone(run) ? " (indicative)" : ""} · ${c.size()} m squares`, "11px system-ui, sans-serif", "#333"]);
    const H0 = 8 + lines.length * 15, bar = m !== "best", tail = [], hi = c.hiLine(sc), F = c.filt();
    if (bar) tail.push(sc.thr != null ? `${{rsrp: "RSRP", rsrq: "RSRQ", sinr: "SINR"}[m]}: pass at ≥ ${sc.thr}${sc.unit}; hatched: below the line; faint: under 3 moments` : `${m.toUpperCase()}: no requirement set, lowest to highest`);
    else tail.push("Best server: each square its site's colour");
    if (hi != null) tail.push(`3.3 GHz and up (C-band, CBRS): pass at ≥ ${hi}`);
    // what the view leaves out, so missing squares don't read as unmeasured (review 11/12)
    const shownTo = [c.f.only ? `only ${serverTxt(c.f.only)}` : "", F.carriers ? F.carriers.join(", ") : "", F.bands ? F.bands.map(bandTxt).join(" ") : "", F.techs ? F.techs.map(techTxt).join(", ") : ""].filter(Boolean);
    if (shownTo.length) tail.push(`Showing ${shownTo.join(" · ")}`);
    if (um.length) tail.push(`Not measured by this run: ${um.join(", ")}`);
    const bb = m === "best" ? c.bestRows(tiles) : {rows: [], other: false}, best = bb.rows;
    const H = H0 + (bar ? 30 : (best.length + (bb.other ? 1 : 0)) * 14 + 4) + tail.length * 14 + 6;
    g.scale(k, k); const X = Math.max(4, xr / k - W), Y = yb / k - H;
    g.fillStyle = "rgba(255,255,255,.92)"; g.strokeStyle = "rgba(0,0,0,.35)"; g.lineWidth = 1; g.beginPath(); if (g.roundRect) g.roundRect(X, Y, W, H, 8); else g.rect(X, Y, W, H); g.fill(); g.stroke();
    g.textBaseline = "middle"; g.textAlign = "left";
    lines.forEach(([t, font, col], i) => { g.font = font; g.fillStyle = col; g.fillText(t, X + 8, Y + 12 + i * 15, W - 16); });
    let y = Y + H0;
    if (bar) { const [lo, hi] = SC.range(sc); SC.legendBar(g, X + 44, y + 2, W - 96, 10, sc); g.font = "10.5px system-ui, sans-serif"; g.fillStyle = "#111";
      g.fillText(SC.fmt(lo), X + 8, y + 7); g.textAlign = "right"; g.fillText(`${SC.fmt(hi)}${sc.unit}`, X + W - 8, y + 7); g.textAlign = "left";
      if (sc.thr != null) { const px = X + 44 + (W - 96) * (sc.thr - lo) / (hi - lo); g.strokeStyle = "#111"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, y); g.lineTo(px, y + 14); g.stroke(); }
      y += 30; }
    else { for (const [key, col] of [...best, ...(bb.other ? [[null, SC.OTHER]] : [])]) { g.fillStyle = col; g.fillRect(X + 8, y + 1, 10, 10); g.fillStyle = "#111"; g.font = "11px system-ui, sans-serif";
        g.fillText(key ? serverTxt(key) : "any other site", X + 24, y + 6, W - 32); y += 14; } y += 4; }  // the grey squares said too (they went unexplained in print)
    g.font = "10.5px system-ui, sans-serif"; g.fillStyle = "#333"; for (const t of tail) { g.fillText(t, X + 8, y + 6, W - 16); y += 14; }
    return H * k;
  }

  /* ---------- a square clicked: the results viewer ---------- */
  function openTile(c, t){
    const map = c.map, run = c.run, d = SV.detail(t), mid = [(t.s + t.n) / 2, (t.w + t.e) / 2], o = c.lookOpts(c.tiles()), lk = SV.look(t, o);
    const towerOf = k => { if (!k || !c.opt.towerOf) return ""; try{ return c.opt.towerOf(k) || ""; }catch(e){ return ""; } };
    const sz = Math.round((t.n - t.s) * 111320);
    const W = t.weakest ? t.weakest.split("|") : [], lay = {lo: "below 3.3 GHz", hi: "3.3 GHz and up", unknown: "band not known"};
    const verdict = t.missing && t.missing.length ? [`Fails: ${t.missing.map(x => x.endsWith("|hi") ? `${x.slice(0, -3)} C-band` : x).join(", ")} not heard here (a dead spot for what ${kindOf(run) === "scanner" ? "the scanner" : "this phone"} measures all along)`, "fail"]
      : c.f.metric === "best" ? [t.server ? `Best server: ${serverTxt(t.server)}${towerOf(t.server) ? `, ${towerOf(t.server)}` : ""} (${n0(t.serverN)} readings)` : "No best server: no site or PCI in these readings", ""]
      : t.value == null ? ["Not judged here", ""]
      : [`${W[0]} ${lay[W[1]] || ""}: median ${SC.fmt(t.value, 1)}${(SC.METRICS[c.f.metric] || {}).unit || ""}${t.thr != null ? `, ${t.value >= t.thr ? "at or above" : "below"} the ${t.thr}${(SC.METRICS[c.f.metric] || {}).unit || ""} line` : ""}`, t.thr == null ? "" : t.value >= t.thr ? "pass" : "fail"];
    const html = `<div class="rf-sv-tile">${run.sample ? '<p class="hint"><span class="rf-sv-tag">SAMPLE</span> Made-up readings, not a real site.</p>' : ""}
      <p class="verdict ${verdict[1]}">${h(verdict[0])}</p>
      ${t.faint ? `<p class="hint">Faint: ${n0(t.moments)} moment${t.moments === 1 ? "" : "s"} of measurement here, fewer than 3: indicative only.</p>` : ""}
      ${(t.unmeasured || []).length ? `<p class="hint">Not measured by this run: ${h(t.unmeasured.join(", "))}.</p>` : ""}
      ${d.map(g => `<div class="g" data-g="${h(`${g.carrier}|${g.tech}|${g.band}`)}"><b>${h(g.carrier)}</b> · ${h(bandTxt(g.band))} · ${h(techTxt(g.tech))} <span class="hint">· ${n0(g.n)} reading${g.n === 1 ? "" : "s"}</span>
          <div class="kv">RSRP median <b>${SC.fmt(g.rsrp.med, 1)}</b> · best ${SC.fmt(g.rsrp.best, 1)} · worst ${SC.fmt(g.rsrp.worst, 1)} dBm${g.rsrq != null ? ` · RSRQ ${SC.fmt(g.rsrq, 1)} dB` : ""}${g.sinr != null ? ` · SINR ${SC.fmt(g.sinr, 1)} dB` : ""}</div>
          <div class="kv">PCI${g.pcis.length === 1 ? "" : "s"} <span class="mono">${g.pcis.length ? h(g.pcis.join(", ")) : "not known"}</span>${g.servers.length ? ` · serving: ${g.servers.slice(0, 4).map(s => `${h(serverTxt(s.server))}${towerOf(s.server) ? ` <span class="hint">(${h(towerOf(s.server))})</span>` : ""} ×${s.n}`).join(", ")}` : ""}</div>
          <div class="kv">${h(span(g.from, g.to))}</div></div>`).join("")}
      <p class="hint">Device: ${h(run.device || SRC[run.source] || run.source)}${run.created_by && run.created_by !== "local" ? ` · by ${h(run.created_by)}` : ""}. ${isPhone(run) ? "Phone readings are indicative: a phone isn't calibrated, so they never count toward a public-safety pass." : run.calibrated ? "A calibrated scanner." : "A scanner's readings (not marked calibrated)."}</p></div>`;
    // Only <site>: the site the verdict is about (the weakest carrier's top server here), or in Best server the square's best server;
    // named on the button, as a phone has no hover (review 11/12)
    const vg = c.f.metric !== "best" && W[0] ? d.filter(g => g.carrier === W[0]).flatMap(g => g.servers).sort((a, b) => b.n - a.n)[0] : null;
    const only = c.f.only, srv = only || (vg && vg.server) || t.server;
    const acts = [{label: "⇩ Readings CSV", title: "This square's readings as the template's columns", run: () => c.save("csv", t.readings, `square ${t.key.replace(/\|/g, "-")}`)},
      ...(srv ? [{label: only === srv ? "Show all sites" : `Only ${serverTxt(srv)}`, title: only === srv ? "Every site's readings again" : `Only ${serverTxt(srv)}'s readings on the map`,
        run: () => { c.f.only = only === srv ? null : srv; c.cache = null; c.colC = null; c.redraw(); c.changed(); openTile(c, c.tiles()?.get(t.key) || t); }}] : [])];
    c.sel = t.key;
    c.hideSay();  // on a phone the note sat over the sheet's buttons
    RFResults.show(map, {key: `sv:t:${t.key}`, label: "Survey square", title: `▦ ${sz} m square${lk && lk.hatch ? " · below the line" : ""}`,
      sub: `${h(run.name)} · ${n0(t.count)} serving reading${t.count === 1 ? "" : "s"} · ${h(span(d.reduce((a, g) => Math.min(a, g.from), Infinity), d.reduce((a, g) => Math.max(a, g.to), -Infinity)))}`,
      html, actions: acts, zoom: [[t.s, t.w], [t.n, t.e]], maxZoom: 18, mark: mid, markName: `Survey square ${sz} m`,
      onClose: () => { c.sel = null; c.layer.redraw(); }}, mid);
    c.layer.redraw();  // after the viewer has the square: the outline is drawn only while it's the square's (drawn before, it never was)
  }

  /* ---------- on a map ---------- */
  function add(map, opt = {}){
    if (map._rfSurvey) return map._rfSurvey;
    const c = make(map, opt), ctl = new Ctl(); ctl._c = c; ctl.addTo(map);
    // second in the left column, under the layers button: the sixth, at 390x844 it sat under a results sheet's grip (review 11/12)
    { const lay = map.getContainer().querySelector(".leaflet-top.leaflet-left .leaflet-control-layers"); if (lay) lay.after(ctl.getContainer()); }
    const leg = new Legend(); leg._c = c; leg.addTo(map);
    map._rfSurvey = c;
    // a square clicked opens its viewer; not while measuring, drawing, moving the pin or placing a marker (those take the click)
    map.on("click", ev => { if (!c.run || map._rfMeasuring || map._rfDraw?._tool || map._rfPinArmed || map._rfMarkArmed) return;
      const t = c.tileAt(ev.latlng); if (t) c.openTile(t); });
    map.on("zoomend", () => { if (c.run) paintLegend(c); });
    // a run over PART is summed for the part in view: after a pan its legend (Best server's sites, the counts) is the new part's
    // (it kept the old view's sites, review 11/12 round 2)
    map.on("moveend", () => { if (!c.run || c.rs.length <= PART) return; clearTimeout(c.legT); c.legT = setTimeout(() => { if (c.run) paintLegend(c); }, 250); });
    // the viewer laid out again (a sheet up, dragged, closed): the legend fits what's left (results.js lifts it onto a sheet)
    map.on("rflayout rfresults", () => requestAnimationFrame(() => c.fitLegend()));
    // another item in the viewer, or the viewer closed: the open square's outline goes (it stayed, in saved images too)
    map.on("rfresults", e => { if (c.sel && e.key !== `sv:t:${c.sel}`) { c.sel = null; c.layer.redraw(); } });
    if (window.RFSurveyRec) RFSurveyRec.attach(c);
    // what this map's slot showed before the map was made again (the tab left and come back to)
    if (c.run) map.whenReady(() => c.set(c.run, c.rs, {quiet: true}));
    return c;
  }
  // the printed report's off-screen map: the same run, filters and size, drawn on it with its legend; -> a function that takes it off
  function draw(map, view){
    const c = make(map, {slot: `print:${Math.random()}`, site: view.site, carriers: view.carriers});
    Object.assign(c.kept, {run: view.run, rs: view.all || view.rs, f: {...view.f}});
    c.profile = view.profile || null; c.profFor = "print";
    c.layer.addTo(map); map._rfLegends = map._rfLegends || new Set(); map._rfLegends.add(c.legendPaint);
    return () => { if (map.hasLayer(c.layer)) map.removeLayer(c.layer); map._rfLegends.delete(c.legendPaint); all.delete(c); slots.delete(c.slot); };
  }
  window.RFSurveyMap = {add, draw, get: map => map && map._rfSurvey || null, all: () => [...all], kindOf, serverTxt, canPost, srcTxt: run => SRC[run && run.source] || (run && run.source) || "",
    // what the Towers tab's printed report takes: the run on this map, its readings shown, its filters and profile
    view: map => { const c = map && map._rfSurvey; if (!c || !c.run) return null; return {run: c.run, rs: c.shown(), all: c.rs, f: {...c.f}, profile: c.profile, kind: kindOf(c.run), size: c.size(), carriers: c.opt.carriers, site: c.opt.site}; },
    seenFor: (map, entries) => { const c = map && map._rfSurvey; return c ? c.seen(entries) : null; },
    // the run on a map and its kind, with nothing worked out (a tower's tile asks it for every tower drawn)
    runOf: map => { const c = map && map._rfSurvey; return c && c.run ? {run: c.run, kind: kindOf(c.run)} : null; }};
})();
