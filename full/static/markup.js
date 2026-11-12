/* Draw (Cody 11/10, "draw and mark up"): points, lines and areas on the maps, kept with the open mission, the DAS job
   whose map this is, or this copy's own drawings when neither is open (markup.py). Each shows its name, and a line its
   length, an area its area (measure.js's arithmetic). Click a line or an area to rename it, change its colour, add a note
   or delete it. Export as KML (Google Earth, ATAK) or GeoJSON. A view-only login sees the drawings but can't change them.
   PC app and web version; the phone has no server to keep them (it keeps its own markers: phone/app.js). A map can say
   what it belongs to with map._rfScope = () => ({scope: "job", id, name}) before addMapLayers (das.js's pre-survey map does).

   Markers (Cody 11/11, "add ways to add pins or markers to the map without having the location of the scan/search"): a
   marker is a Draw point, kept, listed and exported with the drawings, shown as a flag. None of the ways to add one moves
   the search pin or searches again:
     ＋ Marker here on the right-click menu (a long press on a touch screen), beside Move pin here (core.js pinMenu) on the
       Search map, alone on the other maps;
     the ＋ Marker button (RFMarkup.button, beside Move pin, Draw and Measure): armed for the next click, the cursor and the
       button show it; Shift-click keeps it armed for several; Esc or the button again cancels; a search, Measure, Draw or
       Move pin ends it;
     ＋ Mark beside the Pin box (search.js), for a typed or picked address, place or coordinates (RFMarkup.markAt);
     Mark it in the results viewer, on anything there with a place, named after it (results.js reads map._rfMark).
   A new marker is "Marker N" and opens in the results viewer with its name ready to type over (not on a touch screen, where
   the keyboard would cover the map). A click on a marker opens it there: name, note, colour, where it is (Copy, Street
   View, Google Maps), Move (armed for one click), Delete (Undo for a few seconds), Zoom to, and Search here on a map that
   shows the search pin: the one thing here that moves it. A view-only login sees them and can't add or change them. */
(function(){
  const COLORS = ["#ff7a1a", "#e5534b", "#2f81f7", "#3fb950", "#d29922", "#a371f7", "#ffffff"];
  const NAMES = {point: "Marker", line: "Line", area: "Area"};
  const e = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const call = async (url, body) => { const r = await fetch(url, body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const j = await r.json().catch(() => ({})); if(!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const n = (v, d) => v.toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
  const len = m => m / 1609.344 >= 0.2 ? `${n(m / 1609.344, 2)} mi` : `${n(m * 3.28084, 0)} ft`;
  const sq = m2 => m2 / 2589988.11 >= 0.5 ? `${n(m2 / 2589988.11, 2)} sq mi` : m2 / 4046.8564 >= 0.1 ? `${n(m2 / 4046.8564, 2)} acres` : `${n(m2 * 10.7639, 0)} sq ft`;
  const area = ll => window.RFMeasure ? RFMeasure.area(ll) : 0;
  const hasS = () => typeof S === "object" && S;
  const defScope = () => hasS() && S.missionId ? {scope: "mission", id: S.missionId, name: `mission “${S.mission?.name || S.missionId}”`} : {scope: "scratch", id: 0, name: "this copy (no mission open)"};
  const scopeOf = map => (map && map._rfScope && map._rfScope()) || defScope();
  const keyOf = s => `${s.scope}:${s.id}`;
  const all = new Set();  // every Draw on a live map, for refresh() after a mission is opened
  // a view-only (or AHJ) login can't change drawings: the server refuses (remote.refused), and the ways to add or change
  // a marker aren't offered. S.me is set for a signed-in login only (mission.js); this PC's own copy can always. A map's
  // own list says too (edit: false for a DAS job shared with this login to look at only: review 11/11)
  const canEdit = map => !(hasS() && S.me && !["full", "admin"].includes(S.me.role)) && !(map && map._rfDraw && map._rfDraw._editable === false);
  const TOUCH = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const color = c => /^#[0-9a-f]{6}$/i.test(c || "") ? c : COLORS[0];
  const posOf = ll => [+ll.lng.toFixed(7), +ll.lat.toFixed(7)];
  const latLngOf = it => L.latLng(it.geometry.coordinates[1], it.geometry.coordinates[0]);
  const okOf = i => ({label: i.label, note: i.note, color: i.color, geometry: i.geometry});  // what the server kept, for a save that fails
  // a press on the map itself: its panes, or the bare container where nothing is drawn (Leaflet's tiles take no pointer
  // events, so with no dots on the map a click lands on the container); not a control, a menu or the results viewer
  const onMap = (map, t) => t === map.getContainer() || !!t.closest?.(".leaflet-map-pane");
  // a marker is a flag on a pole, its foot on the spot: not the search pin's teardrop, nor a result's dot
  const flag = c => L.divIcon({className: "rf-mk", iconSize: [24, 30], iconAnchor: [6, 28], tooltipAnchor: [10, -17],
    html: `<svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true"><path d="M6 28V3" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/><path d="M6 28V3" stroke="#111" stroke-width="2" stroke-linecap="round"/><path d="M6.5 3.5h14l-4 5 4 5h-14z" fill="${color(c)}" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`});
  // how far and which way from the search pin, for a marker's viewer
  const fromPin = ll => { if(!hasS() || !S.center) return ""; const [la, lo] = S.center, R = 3958.8, rad = Math.PI / 180;
    const dLa = (ll.lat - la) * rad, dLo = (ll.lng - lo) * rad, h = Math.sin(dLa / 2) ** 2 + Math.cos(la * rad) * Math.cos(ll.lat * rad) * Math.sin(dLo / 2) ** 2, mi = 2 * R * Math.asin(Math.sqrt(h));
    const b = (Math.atan2(Math.sin(dLo) * Math.cos(ll.lat * rad), Math.cos(la * rad) * Math.sin(ll.lat * rad) - Math.sin(la * rad) * Math.cos(ll.lat * rad) * Math.cos(dLo)) / rad + 360) % 360;
    const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(b / 22.5) % 16];
    return `${mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`} ${pts} of the pin`; };
  const copyText = async t => { try{ await navigator.clipboard.writeText(t); return true; }
    catch(err){ const a = document.createElement("textarea"); a.value = t; a.style.cssText = "position:fixed;left:-9999px;top:0"; document.body.append(a); a.select();
      let ok = false; try{ ok = document.execCommand("copy"); }catch(er){ ok = false; } a.remove(); return ok; } };

  const css = document.createElement("style");
  css.textContent = `.rf-dr-panel { margin-top: 6px; padding: 8px 10px; border-radius: 10px; width: 250px; font: 12px/1.35 system-ui, sans-serif;
      background: rgba(20,20,20,.9); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); max-height: 60vh; overflow: auto; }
    .rf-dr-panel b { font-weight: 600; } .rf-dr-panel .row { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
    .rf-dr-panel button { font: inherit; padding: 3px 8px; border-radius: 7px; border: 1px solid rgba(255,255,255,.3); background: transparent; color: #fff; cursor: pointer; }
    .rf-dr-panel button.on { background: #ff7a1a; color: #111; border-color: #ff7a1a; }
    .rf-dr-panel input, .rf-dr-panel textarea { font: inherit; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 3px 6px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.08); color: #fff; }
    .rf-dr-sw { width: 16px; height: 16px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0 !important; }
    .rf-dr-sw.on { border-color: #fff; box-shadow: 0 0 0 1px #000; }
    .rf-dr-item { display: flex; gap: 6px; align-items: center; padding: 3px 0; border-top: 1px solid rgba(255,255,255,.12); cursor: pointer; }
    .rf-dr-item .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; } .rf-dr-item .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rf-dr-msg { color: #ffb38a; margin-top: 4px; } .rf-dr-hint { opacity: .75; margin-top: 4px; }
    .rf-dr-label { background: rgba(20,20,20,.85); color: #fff; border: 0; border-radius: 6px; padding: 2px 6px; font: 11px/1.3 system-ui, sans-serif; box-shadow: none; white-space: nowrap; }
    .rf-dr-label::before { display: none; }
    .rf-mk { background: none; border: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); cursor: pointer; }
    .rf-mk-add { padding: 4px 9px; font: 600 12px system-ui, sans-serif; cursor: pointer; background: var(--panel, #fff); color: var(--ink, #111); white-space: nowrap; }
    .rf-mk-add.on { background: #ff7a1a; color: #111; }
    body.rf-viewonly .rf-mk-add { display: none; }
    .leaflet-container.rf-mk-arming, .rf-mk-arming .leaflet-interactive, .rf-mk-arming .rf-mk { cursor: crosshair; }
    .rf-pinmenu:not([hidden]) { display: flex; gap: 4px; flex-wrap: wrap; }
    .rf-mk-say { position: absolute; z-index: 1002; left: 50%; bottom: 34px; transform: translateX(-50%); max-width: calc(100% - 40px); display: flex; gap: 8px; align-items: center;
      padding: 6px 8px 6px 12px; border-radius: 10px; background: rgba(20,20,20,.92); color: #fff; font: 12.5px/1.35 system-ui, sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    .rf-res-on-sheet > .rf-mk-say { bottom: calc(var(--rf-res-hpx, 0px) + 12px); }
    .rf-mk-say[hidden] { display: none; }
    .rf-mk-say button { font: inherit; padding: 3px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,.4); background: transparent; color: #fff; cursor: pointer; }
    .rf-mk-f { display: block; margin: 2px 0 8px; font-size: 12px; color: var(--ink-2, var(--muted, #666)); }
    .rf-mk-f input, .rf-mk-f textarea { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; font: inherit; font-size: 13px; color: var(--ink, inherit); }
    .rf-mk-sws { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
    .rf-mk-sw { width: 22px; height: 22px; min-height: 0 !important; border-radius: 50%; border: 2px solid rgba(127,127,127,.5); padding: 0 !important; cursor: pointer; }
    .rf-mk-sw.on { border-color: var(--ink, #111); box-shadow: 0 0 0 2px var(--panel, #fff) inset; }
    .rf-mk-at { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 2px 0 4px; }
    .rf-mk-at button { padding: 2px 9px; font-size: 12px; }
    .rf-mk-links { margin: 6px 0 4px; }
    .rf-dr-label.leaflet-interactive { cursor: pointer; }
    @media (pointer: coarse) { .rf-mk-add { min-height: 40px; } .rf-mk-sw { width: 44px; height: 44px; min-width: 44px; } }`;  /* a finger's 44 px, round (the app's button min-width made them 44 by 34) */
  document.head.appendChild(css);
  const PEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/></svg>';

  // Esc ends an armed ＋ Marker or Move, and closes ＋ Marker here on a map without the Search map's menu (core.js has that
  // one's): before the results viewer under it (results.js leaves an armed map's viewer alone). With Shift still held from
  // Shift-clicks too: RFKeys calls that "shift+escape", and it left ＋ Marker armed (review 11/11)
  let keyed = false;
  const keys = () => { if(keyed || !window.RFKeys) return; keyed = true;
    const esc = () => { for(const d of all){ d.disarm(); const m = d._menu(); if(m) m.hidden = true; } };
    RFKeys.scope("markers", {active: () => [...all].some(d => d._arm || d._menu()), keys: {escape: esc, "shift+escape": esc}}); };

  const Draw = L.Control.extend({
    options: {position: "topleft"},
    onAdd(map){
      this._map = map; this._items = []; this._g = L.layerGroup().addTo(map); this._tool = null; this._pts = []; this._color = COLORS[0];
      this._hidden = false; this._sel = null; this._msg = ""; this._scopeKey = null; this._arm = null; this._seq = 0; this._fresh = [];
      const box = L.DomUtil.create("div", "leaflet-bar rf-dr");
      const b = this._btn = L.DomUtil.create("a", "rf-ms-btn", box);
      b.href = "#"; b.title = "Draw and mark up"; b.setAttribute("role", "button"); b.setAttribute("aria-label", "Draw and mark up"); b.innerHTML = PEN;
      this._panel = L.DomUtil.create("div", "rf-dr-panel", box); this._panel.hidden = true;
      L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(b, "click", ev => { L.DomEvent.preventDefault(ev); this._panel.hidden ? this.open() : this.close(); });
      this._key = ev => { if(!this._tool) return; if(ev.key === "Escape") this._cancel(); else if(ev.key === "Enter") this._finish(); };
      document.addEventListener("keydown", this._key);
      map.on("click", this._click, this); map.on("mousemove", this._move, this); map.on("dblclick", this._dbl, this);
      map.on("moveend", () => { if(keyOf(scopeOf(map)) !== this._scopeKey) this.load(); });  // a mission opened while this map is up
      map.on("unload", () => { document.removeEventListener("keydown", this._key); all.delete(this); clearTimeout(this._sayT); });
      // Mark it in the results viewer (results.js): a marker on the item, named after it; the item stays in the viewer
      map._rfMark = (ll, label) => this.drop(ll, {label, open: false});
      // ＋ Marker here on its own, on a map without the Search map's menu (core.js sets _rfPinMenu and adds it to that one)
      map.on("contextmenu", ev => { if(map._rfPinMenu || map._rfMeasuring || this._tool) return; this._menuAt(ev); });
      map.on("rftool", () => this.disarm());  // Measure, Draw or Move pin started: one thing at a time
      // armed (＋ Marker, or a marker's Move): this click is where it goes, on a dot or a drawing too. Taken on its way down,
      // before those, as Move pin's is (core.js); not a click that ends a drag, nor one on a control or the viewer
      map.getContainer().addEventListener("click", ev => { const a = this._arm;
        if(!a || map._rfMeasuring || this._tool || !onMap(map, ev.target) || map.dragging?.moved()) return;
        ev.stopPropagation(); ev.preventDefault();
        const ll = map.mouseEventToLatLng(ev);
        if(a.mode === "move"){ this.disarm(); this._moveTo(a.id, ll); return; }
        const more = ev.shiftKey; if(!more) this.disarm();
        this.drop(ll, {open: !more}); }, true);
      all.add(this); keys(); this.load();
      return box;
    },
    // drawn at once with what's known, then again when the server's list arrives (until then the buttons weren't there)
    open(){ if(this._map._rfMeasure?._on) this._map._rfMeasure.stop(); this._map.fire("rftool"); this._panel.hidden = false; this._btn.classList.add("on"); this._show(); this.load(); },
    close(){ this._cancel(); this._sel = null; this._panel.hidden = true; this._btn.classList.remove("on"); },
    // a marker added while the list was on its way is kept: the list was read before it was saved
    async load(){ const s = scopeOf(this._map), seq = ++this._seq; this._scopeKey = keyOf(s); this._fresh = [];
      try{ const r = await call(`/api/markup?scope=${s.scope}&id=${s.id}`); if(seq !== this._seq) return;
        const have = new Set(r.items.map(i => i.id)); this._items = [...r.items, ...this._fresh.filter(i => !have.has(i.id))]; this._msg = "";
        this._ok = new Map(this._items.map(i => [i.id, okOf(i)]));
        this._editable = r.edit !== false; }  // a job shared to look at only, or a view login: no way to add or change one
      catch(err){ if(seq !== this._seq) return; this._items = []; this._msg = `Drawings: ${err.message}`; }
      if(!this._map) return;  // the map went while the list loaded (a tab left: RFMaps, 11/10)
      if(!canEdit(this._map)) this.disarm();
      this._armShow(); this._render(); this._show(); },
    _kept(r){ this._items.push(r); this._fresh.push(r); (this._ok ||= new Map()).set(r.id, okOf(r)); this._gone?.delete(r.id); },
    // ---- drawing one
    _start(tool){ this._sel = null; this._tool = tool; this._pts = []; const m = this._map; if(m._rfMeasure?._on) m._rfMeasure.stop();
      m.fire("rftool"); m._rfMeasuring = true;  // the ruler, Move pin and ＋ Marker, if on, are done (one thing at a time)
      this._dz = m.doubleClickZoom.enabled(); m.doubleClickZoom.disable(); m.getContainer().classList.add("rf-measuring"); this._show(); },
    // the click that finishes a drawing (a point, an area's first corner) is still on its way to the map's other click
    // handlers, so the pin stays put until it's done (in testing 11/10 that click moved the pin)
    _end(){ const m = this._map; this._tool = null; this._pts = []; setTimeout(() => { m._rfMeasuring = !!m._rfMeasure?._on; }, 0); if(this._dz) m.doubleClickZoom.enable();
      m.getContainer().classList.remove("rf-measuring"); if(this._draft){ this._draft.remove(); this._draft = null; } this._show(); },
    _cancel(){ if(this._tool) this._end(); },
    _click(ev){ if(!this._tool) return; const m = this._map, p = this._pts, pt = m.latLngToContainerPoint(ev.latlng);
      if(this._tool === "point"){ p.push(ev.latlng); return this._finish(); }
      if(this._tool === "area" && p.length >= 3 && pt.distanceTo(m.latLngToContainerPoint(p[0])) < 12) return this._finish();
      if(p.length && pt.distanceTo(m.latLngToContainerPoint(p[p.length - 1])) < 4) return;  // a double-click's second click
      p.push(ev.latlng); this._drawDraft(ev.latlng); this._show(); },
    _dbl(ev){ if(!this._tool) return; L.DomEvent.stop(ev); this._finish(); },
    _move(ev){ if(this._tool && this._tool !== "point" && this._pts.length) this._drawDraft(ev.latlng); },
    _drawDraft(cursor){ const ll = [...this._pts, cursor], o = {color: this._color, weight: 2.5, dashArray: "5 6", interactive: false};
      if(this._draft) this._draft.remove();
      this._draft = (this._tool === "area" && ll.length >= 3 ? L.polygon(ll, {...o, fillOpacity: .12}) : L.polyline(ll, o)).addTo(this._map); },
    async _finish(){ const t = this._tool, p = this._pts;
      if(!t || (t === "line" && p.length < 2) || (t === "area" && p.length < 3) || (t === "point" && !p.length)) return;
      const geometry = t === "point" ? {type: "Point", coordinates: posOf(p[0])} : t === "line" ? {type: "LineString", coordinates: p.map(posOf)}
        : {type: "Polygon", coordinates: [[...p, p[0]].map(posOf)]};
      const s = scopeOf(this._map);  // the name typed before drawing (the panel shows the drawing's hints meanwhile)
      const label = (this._next || "").trim() || (t === "point" ? this._nextName() : `${NAMES[t]} ${this._items.filter(i => i.kind === t).length + 1}`);
      this._end();
      try{ const r = await call("/api/markup", {scope: s.scope, scope_id: s.id, kind: t, geometry, label, color: this._color});
        this._kept(r); this._msg = ""; this._next = ""; }
      catch(err){ this._msg = `Not saved: ${err.message}`; }
      this._render(); this._show(); },
    // ---- markers
    // "Marker N": one more than the highest N here, so a deleted one's number isn't given twice
    _nextName(){ let k = 0; for(const i of this._items){ const m = /^Marker (\d+)$/.exec(i.label || ""); if(m) k = Math.max(k, +m[1]); } return `Marker ${k + 1}`; },
    // saved first, then drawn and (open) shown in the viewer with its name ready to type over: the map doesn't move
    async _put(ll, o = {}){ if(!canEdit(this._map)) throw new Error(this._editable === false ? "You can look at these drawings, not change them." : "View only: markers are added by a full login.");
      ll = L.latLng(ll); const s = scopeOf(this._map);
      const r = await call("/api/markup", {scope: s.scope, scope_id: s.id, kind: "point", geometry: {type: "Point", coordinates: posOf(ll)},
        label: String(o.label || "").trim().slice(0, 120) || this._nextName(), color: o.color || this._color});
      if(keyOf(scopeOf(this._map)) === keyOf(s)) this._kept(r);
      this._msg = ""; this._render(); this._show();
      if(o.open) this.view(r, {focus: o.focus !== false});
      return r; },
    async drop(ll, o = {}){ try{ return await this._put(ll, {open: true, ...o}); } catch(err){ this._say(`Marker not saved: ${err.message}`); return null; } },
    arm(){ const m = this._map; if(!canEdit(m)) return;
      if(m._rfMeasure?._on) m._rfMeasure.stop(); this._cancel(); m.fire("rftool");  // Measure, Draw's tool and Move pin end
      this._arm = {mode: "add"}; this._armShow(); },
    _moveArm(it){ const m = this._map; if(!canEdit(m)) return; if(m._rfMeasure?._on) m._rfMeasure.stop(); this._cancel(); m.fire("rftool");
      this._arm = {mode: "move", id: it.id}; this._armShow(); this._viewActs(it); },
    disarm(){ if(!this._arm) return; const was = this._arm; this._arm = null; this._armShow();
      if(was.mode === "move"){ const it = this._items.find(i => i.id === was.id); if(it) this._viewActs(it); } },
    // armed, box zoom is off: a Shift-click that slipped a pixel or two was Leaflet's Shift-drag zoom, and the map jumped
    // 8 or 9 levels with no marker added (review 11/11); it's back as it was when this ends
    _armShow(){ const m = this._map, a = this._arm, add = a?.mode === "add"; m._rfMarkArmed = !!a; m.getContainer().classList.toggle("rf-mk-arming", !!a);
      if(a && this._bz == null && m.boxZoom){ this._bz = m.boxZoom.enabled(); m.boxZoom.disable(); }
      else if(!a && this._bz != null){ if(this._bz) m.boxZoom.enable(); this._bz = null; }
      const b = this._addBtn; if(!b) return;
      b.hidden = !canEdit(m);  // a job shared to look at only (body.rf-viewonly hides it for a view login)
      b.classList.toggle("on", add); b.setAttribute("aria-pressed", String(add)); b.textContent = add ? "＋ Click where it goes" : "＋ Marker";
      b.title = add ? "Click where the marker goes (Shift-click for several). Esc or this button cancels." : "Drop a marker: then click where it goes, once (Shift-click for several). It doesn't move the pin."; },
    _menu(){ const m = this._map.getContainer().querySelector(":scope > .rf-pinmenu:not([hidden])"); return !this._map._rfPinMenu && m ? m : null; },
    // right-click or long press: ＋ Marker here where it was pressed; another press, a move of the map or Esc closes it
    _menuAt(ev){ if(!canEdit(this._map)) return; const map = this._map, box = map.getContainer(); this.disarm();
      let m = box.querySelector(":scope > .rf-pinmenu");
      if(!m){ m = L.DomUtil.create("div", "rf-pinmenu", box); L.DomEvent.disableClickPropagation(m); L.DomEvent.disableScrollPropagation(m); }
      m.innerHTML = '<button type="button" data-pmk>＋ Marker here</button>'; m.hidden = false;
      const p = ev.containerPoint; m.style.left = `${Math.max(4, Math.min(p.x, box.clientWidth - m.offsetWidth - 4))}px`; m.style.top = `${Math.max(4, Math.min(p.y, box.clientHeight - m.offsetHeight - 4))}px`;
      const off = () => { m.hidden = true; map.off("movestart click zoomstart", off); };
      m.querySelector("[data-pmk]").onclick = x => { L.DomEvent.stop(x); off(); this.drop(ev.latlng); };
      map.on("movestart click zoomstart", off); },
    // a line on the map for a few seconds, with Undo when there's something to undo
    _say(msg, undo){ const box = this._map?.getContainer(); if(!box) return; let el = box.querySelector(":scope > .rf-mk-say");
      if(!el){ el = L.DomUtil.create("div", "rf-mk-say", box); el.setAttribute("role", "status"); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
      el.innerHTML = `<span>${e(msg)}</span>${undo ? '<button type="button" data-mk-undo>Undo</button>' : ""}`; el.hidden = false;
      clearTimeout(this._sayT); this._sayT = setTimeout(() => { el.hidden = true; }, undo ? 7000 : 5000);
      const u = el.querySelector("[data-mk-undo]");
      if(u) u.onclick = async x => { L.DomEvent.stop(x); el.hidden = true; try{ await undo(); }catch(err){ this._say(`Not put back: ${err.message}`); } }; },
    // the actions of the marker's viewer, drawn again on their own (the name being typed stays)
    _acts(it){ const m = this._map, edit = canEdit(m), armed = this._arm?.mode === "move" && this._arm.id === it.id, ll = latLngOf(it);
      const searchable = typeof movePin === "function" && hasS() && [S.map, S.dashMap, S.reportMap].includes(m);
      return [...(edit ? [{label: armed ? "Click where it goes" : "Move", primary: armed, title: armed ? "Click where the marker goes. Esc or Move again cancels." : "Move it: then click where it goes (once)",
          run: () => armed ? this.disarm() : this._moveArm(it)},
        {label: "Delete", title: "Delete it (Undo for a few seconds)", run: () => this._del(it)}] : []),
        ...(searchable ? [{label: "Search here", title: "Move the search pin here and search: the one thing here that moves the pin", run: () => movePin(ll)}] : [])]; },
    _viewActs(it){ const h = window.RFResults && RFResults.get(this._map); if(h && h.key === `mk:${it.id}`) h.setFrame({actions: this._acts(it)}); },
    view(it, o = {}){ if(!window.RFResults) return; const m = this._map, ll = latLngOf(it), at = [ll.lat, ll.lng];
      RFResults.show(m, {key: `mk:${it.id}`, label: it.label || "Marker", title: `⚑ ${e(it.label || "Marker")}`, sub: e(`Marker · kept with ${scopeOf(m).name}`), mark: false,
        fill: body => this._fill(body, it, o.focus), actions: this._acts(it), zoom: at,
        onClose: () => { if(this._arm?.mode === "move" && this._arm.id === it.id) this.disarm(); }}, at);
      o.focus = false; },  // the focus once: a viewer drawn again (a move, the layout) doesn't take it back
    _fill(body, it, focus){ const ll = latLngOf(it), c = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`, edit = canEdit(this._map);
      const mgrs = window.toMGRS ? (() => { try{ return toMGRS(ll.lat, ll.lng); }catch(err){ return ""; } })() : "", from = fromPin(ll);
      body.innerHTML = `${edit ? `<label class="rf-mk-f">Name<input data-mk-name maxlength="120" value="${e(it.label)}" autocomplete="off"></label>
          <label class="rf-mk-f">Note<textarea data-mk-note rows="3" maxlength="2000" placeholder="What's here">${e(it.note)}</textarea></label>
          <div class="rf-mk-sws" role="group" aria-label="Colour">${COLORS.map(x => `<button type="button" class="rf-mk-sw${x === color(it.color) ? " on" : ""}" data-mk-c="${x}" style="background:${x}" title="Colour ${x}" aria-label="Colour ${x}" aria-pressed="${x === color(it.color)}"></button>`).join("")}</div>`
        : `${it.note ? `<p style="margin:2px 0 8px;white-space:pre-wrap">${e(it.note)}</p>` : ""}<p class="hint" style="margin:0 0 6px">${this._editable === false ? "You can look at these markers, not change them." : "View only: markers are changed by a full login."}</p>`}
        <div class="rf-mk-at"><span class="mono" data-mk-ll>${c}</span><button type="button" data-mk-copy title="Copy the coordinates">Copy</button></div>
        ${mgrs ? `<div class="hint mono">MGRS ${e(mgrs)}</div>` : ""}${from ? `<div class="hint">${e(from)}</div>` : ""}
        <div class="rf-mk-links"><a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll.lat},${ll.lng}" target="_blank" rel="noopener">Street View ↗</a> ·
          <a href="https://www.google.com/maps/search/?api=1&query=${ll.lat},${ll.lng}" target="_blank" rel="noopener">Google Maps ↗</a></div>
        <p class="hint" data-mk-msg style="margin:6px 0 0">${it.created_by ? `Added by ${e(it.created_by)}, ${e(it.created_at)}` : ""}</p>`;
      const q = s => body.querySelector(s), say = t => { const p = q("[data-mk-msg]"); if(p) p.textContent = t; };
      q("[data-mk-copy]").onclick = async () => say(await copyText(c) ? `Copied ${c}.` : "Couldn't copy: select the coordinates and copy them.");
      if(!edit) return;
      const name = q("[data-mk-name]"), note = q("[data-mk-note]");
      // saved as it's left (or on Enter): no Save to press. An emptied name keeps the one it had
      name.onchange = () => { const v = name.value.trim(); if(!v){ name.value = it.label; return; } if(v !== it.label) this._save(it, {label: v}, say); };
      name.onkeydown = x => { if(x.key === "Enter"){ x.preventDefault(); name.onchange(); } };
      note.onchange = () => { if(note.value.trim() !== (it.note || "")) this._save(it, {note: note.value}, say); };
      body.querySelectorAll("[data-mk-c]").forEach(b => b.onclick = () => { body.querySelectorAll("[data-mk-c]").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        this._save(it, {color: b.dataset.mkC}, say); });
      if(focus && !TOUCH){ name.focus({preventScroll: true}); name.select(); } },
    // only what changed is sent (the server keeps the rest as it has them), shown at once and put back if it isn't kept, and
    // one marker's saves go one after another: a rename then a colour on a slow link sent the old name with the colour, and
    // the name went back (review 11/11)
    // A save that fails puts back what the server last kept (this._ok), not what was showing when it was sent: two renames
    // that both failed left the first, never saved (follow-up review 11/11). A save still queued when its marker is deleted
    // here is dropped, so its "deleted" answer doesn't take the place of the Delete message and its Undo
    _save(it, patch, say = () => {}){ const s = scopeOf(this._map), cur = this._items.find(i => i.id === it.id) || it, id = cur.id;
      Object.assign(cur, patch); if(cur !== it) Object.assign(it, patch);
      this._render(); this._show(); this._title(cur);
      const send = async () => { if(this._gone?.has(id)) return false;
        try{ const r = await call("/api/markup", {id, scope: s.scope, scope_id: s.id, ...(patch.geometry ? {kind: cur.kind} : {}), ...patch});
          const ok = (this._ok ||= new Map()).get(id) || {}; for(const k of Object.keys(patch)){ ok[k] = r[k]; if(cur[k] === patch[k]) cur[k] = r[k]; } this._ok.set(id, ok);
          cur.updated_at = r.updated_at; if(cur !== it) Object.assign(it, cur); this._render(); this._show(); this._title(cur); say("Saved."); return true; }
        catch(err){ if(this._gone?.has(id)) return false;
          const ok = this._ok?.get(id) || {}; for(const k of Object.keys(patch)) if(cur[k] === patch[k] && k in ok){ cur[k] = ok[k]; if(cur !== it) it[k] = ok[k]; }
          this._render(); this._show(); this._title(cur); say(`Not saved: ${err.message}`); this._say(`Not saved: ${err.message}`); return false; } };
      return (this._q = (this._q || Promise.resolve()).then(send, send)); },
    // the title in place: rebuilding the viewer's frame from a name's change event took away the button the press that left
    // the name was on, so the first click on Delete, Move, ✕ or Zoom to did nothing (follow-up review 11/11)
    _title(cur){ const h = window.RFResults && RFResults.get(this._map); if(h && h.key === `mk:${cur.id}`) h.retitle(`⚑ ${e(cur.label || "Marker")}`, cur.label); },
    async _moveTo(id, ll){ const it = this._items.find(i => i.id === id); if(!it) return;
      if(await this._save(it, {geometry: {type: "Point", coordinates: posOf(ll)}})){ const h = window.RFResults && RFResults.get(this._map); if(h && h.key === `mk:${id}`) this.view(it); } },
    async _del(it){ const s = scopeOf(this._map), m = this._map;
      try{ await call("/api/markup/delete", {id: it.id, scope: s.scope, scope_id: s.id}); }
      catch(err){ this._say(`Not deleted: ${err.message}`); return; }
      (this._gone ||= new Set()).add(it.id);
      this._items = this._items.filter(i => i.id !== it.id); if(this._sel === it.id) this._sel = null; if(this._arm?.id === it.id) this.disarm();
      const h = window.RFResults && RFResults.get(m); if(h && h.key === `mk:${it.id}`) RFResults.close(m, false);
      this._render(); this._show();
      // Undo: the same marker back (the server keeps a delete a day): its id, who added it and when, as they were
      this._say(`Deleted “${it.label || "Marker"}”.`, async () => { const r = await call("/api/markup/restore", {id: it.id, scope: s.scope, scope_id: s.id});
        if(keyOf(scopeOf(m)) === keyOf(s) && !this._items.some(i => i.id === r.id)) this._kept(r); this._render(); this._show(); }); },
    // ---- the saved ones
    _measure(it){ const g = it.geometry, ll = c => L.latLng(c[1], c[0]);
      if(it.kind === "line"){ let d = 0; for(let i = 1; i < g.coordinates.length; i++) d += this._map.distance(ll(g.coordinates[i - 1]), ll(g.coordinates[i])); return len(d); }
      if(it.kind === "area") return sq(area(g.coordinates[0].slice(0, -1).map(ll)));
      return `${g.coordinates[1].toFixed(5)}, ${g.coordinates[0].toFixed(5)}`; },
    _render(){ const g = this._g; g.clearLayers(); if(this._hidden) return;
      for(const it of this._items){ const c = it.color || COLORS[0], ll = p => L.latLng(p[1], p[0]), geo = it.geometry;
        const tip = `${e(it.label || NAMES[it.kind])}${it.kind !== "point" ? ` · ${this._measure(it)}` : ""}`;
        if(it.kind === "point"){  // a marker: its viewer, never the map's click (a marker takes its own clicks)
          // its name opens it too (a label took no clicks: a click on it did nothing, review 11/11), and goes no further
          const open = ev => { if(ev && ev.originalEvent) L.DomEvent.stopPropagation(ev); if(window.RFMeasure?.toTool(this._map, ev, ll(geo.coordinates))) return;  // a point for the ruler or Draw's tool
            if(this._tool || this._arm) return; this.view(it); };
          const tt = L.tooltip({permanent: true, direction: "right", className: "rf-dr-label", interactive: true}).setContent(tip);
          L.marker(ll(geo.coordinates), {icon: flag(c), keyboard: false, riseOnHover: true, title: it.label || "Marker"}).bindTooltip(tt).on("click", open).addTo(g);
          tt.on("click", open);
          continue; }
        const o = {color: c, weight: this._sel === it.id ? 4.5 : 3, bubblingMouseEvents: false};
        const lyr = it.kind === "line" ? L.polyline(geo.coordinates.map(ll), o) : L.polygon(geo.coordinates[0].slice(0, -1).map(ll), {...o, fillOpacity: .15});
        lyr.bindTooltip(tip, {permanent: true, direction: "center", className: "rf-dr-label"});
        lyr.on("click", ev => { const m = this._map;  // bubblingMouseEvents:false keeps it off the map, so a tool on gets it here
          if(m._rfMeasuring){ m.fire("click", {latlng: ev.latlng, layerPoint: ev.layerPoint, containerPoint: ev.containerPoint, originalEvent: ev.originalEvent}); return; }
          this._sel = it.id; this.open(); this._render(); });
        lyr.addTo(g);
        // an area goes to the back of its canvas: on the Map tab the dots share it (core.js), and a click is the topmost shape's,
        // so a dot inside an area is the dot's and the area's elsewhere. Every change draws them all again, so it holds after one
        if(it.kind === "area" && lyr.bringToBack) lyr.bringToBack(); } },
    _show(){ const pn = this._panel; if(pn.hidden) return; const s = scopeOf(this._map), sel = this._items.find(i => i.id === this._sel);
      // no taller than the map, clear of its bottom-left readout and scale (seen 11/10 on a 600-pixel map), scrolling inside
      pn.style.maxHeight = `${Math.max(160, this._map.getSize().y - 230)}px`;
      const sw = cur => COLORS.map(c => `<button class="rf-dr-sw${c === cur ? " on" : ""}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join("");
      const edit = canEdit(this._map);
      let h = `<b>Draw</b> <span class="rf-dr-hint">· kept with ${e(s.name)}</span>`;
      if(this._tool){ const need = {point: "Click where it goes.", line: "Click each point. Double-click, Enter or Done to finish.", area: "Click each corner; click the first one, double-click or Done to close it."}[this._tool];
        h += `<div class="rf-dr-hint">${NAMES[this._tool]}: ${need} Esc to cancel.</div><div class="row">${this._tool !== "point" ? "<button data-done>Done</button>" : ""}<button data-cancel>Cancel</button></div>`; }
      else if(sel && !edit){ h += `<div class="row"><b>${e(sel.label || NAMES[sel.kind])}</b></div>${sel.note ? `<div class="rf-dr-hint" style="white-space:pre-wrap">${e(sel.note)}</div>` : ""}
          <div class="rf-dr-hint">${NAMES[sel.kind]} · ${this._measure(sel)}${sel.created_by ? ` · drawn by ${e(sel.created_by)}, ${e(sel.created_at)}` : ""}</div>
          <div class="rf-dr-hint">${this._editable === false ? "You can look at these drawings, not change them." : "View only: drawings are changed by a full login."}</div>
          <div class="row"><button data-ezoom>Zoom to</button><button data-eback>Back</button></div>`; }
      else if(sel){ h += `<div class="row"><b>Edit</b></div><input data-elabel maxlength="120" value="${e(sel.label)}" placeholder="Name">
          <div class="row">${sw(sel.color || COLORS[0])}</div><textarea data-enote rows="3" maxlength="2000" placeholder="Note">${e(sel.note)}</textarea>
          <div class="rf-dr-hint">${NAMES[sel.kind]} · ${this._measure(sel)}${sel.created_by ? ` · drawn by ${e(sel.created_by)}, ${e(sel.created_at)}` : ""}</div>
          <div class="row"><button data-esave>Save</button><button data-ezoom>Zoom to</button><button data-edel>Delete</button><button data-eback>Back</button></div>`; }
      else{ h += `${edit ? `<div class="row"><button data-t="point" title="A marker: then click where it goes">Marker</button><button data-t="line">Line</button><button data-t="area">Area</button></div>
          <div class="row">${sw(this._color)}</div><input data-name maxlength="120" placeholder="Name for the next one (optional)" value="${e(this._next || "")}">` : `<div class="rf-dr-hint">${this._editable === false ? "You can look at these drawings and export them, not change them." : "View only: you can see the drawings and export them."}</div>`}
          ${this._items.length ? this._items.map(it => `<div class="rf-dr-item" data-i="${it.id}"><span class="dot" style="background:${e(color(it.color))}"></span><span class="grow">${e(it.label || NAMES[it.kind])}</span><span class="rf-dr-hint">${it.kind === "point" ? "marker" : this._measure(it)}</span></div>`).join("")
            : `<div class="rf-dr-hint">Nothing drawn here yet.</div>`}
          <div class="row">${this._items.length ? `<button data-x="kml">⇩ KML</button><button data-x="geojson">⇩ GeoJSON</button>` : ""}
            <button data-hide>${this._hidden ? "Show drawings" : "Hide drawings"}</button><button data-close>Close</button></div>`; }
      if(this._msg) h += `<div class="rf-dr-msg">${e(this._msg)}</div>`;
      pn.innerHTML = h;
      // buttons stop their click: the panel is redrawn inside the handler (see measure.js)
      const on = (q, fn) => pn.querySelectorAll(q).forEach(el => el.onclick = ev => { L.DomEvent.stop(ev); fn(el); });
      const name = pn.querySelector("[data-name]"); if(name) name.oninput = () => { this._next = name.value; };
      on("[data-t]", el => this._start(el.dataset.t));
      on("[data-done]", () => this._finish()); on("[data-cancel]", () => this._cancel());
      on("[data-close]", () => this.close()); on("[data-hide]", () => { this._hidden = !this._hidden; this._render(); this._show(); });
      // the export through fetch, saved as a file: also works in the web version, whose server is in the page
      on("[data-x]", async el => { const f = el.dataset.x, name = `DAStastic drawings - ${s.name.replace(/[^\w .-]+/g, "")}`.slice(0, 80);
        try{ const r = await fetch(`/api/markup/export?scope=${s.scope}&id=${s.id}&format=${f}&name=${encodeURIComponent(name)}`); if(!r.ok) throw new Error(`HTTP ${r.status}`);
          const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `${name}.${f}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
        catch(err){ this._msg = `Export: ${err.message}`; this._show(); } });
      // a marker in the list opens in the viewer, as a click on it does; a line or an area here
      on("[data-i]", el => { const it = this._items.find(i => i.id === +el.dataset.i); if(it?.kind === "point"){ this.view(it); return; } this._sel = +el.dataset.i; this._render(); this._show(); });
      on(".rf-dr-sw", el => { if(sel){ sel._color = el.dataset.c; pn.querySelectorAll(".rf-dr-sw").forEach(x => x.classList.toggle("on", x === el)); } else { this._color = el.dataset.c; this._show(); } });
      on("[data-eback]", () => { this._sel = null; this._render(); this._show(); });
      on("[data-ezoom]", () => { const g = sel.geometry, ll = p => L.latLng(p[1], p[0]);
        if(sel.kind === "point") this._map.setView(ll(g.coordinates), Math.max(this._map.getZoom(), 17));
        else this._map.fitBounds(L.latLngBounds((sel.kind === "line" ? g.coordinates : g.coordinates[0]).map(ll)).pad(.3)); });
      // only what was changed here: a second tab's colour sent with the name it had loaded put an old name back (follow-up
      // review 11/11); nothing changed, nothing sent
      on("[data-esave]", async () => { const s2 = scopeOf(this._map), label = pn.querySelector("[data-elabel]").value.trim(), note = pn.querySelector("[data-enote]").value.trim();
        const patch = {...(label !== (sel.label || "") ? {label} : {}), ...(note !== (sel.note || "") ? {note} : {}), ...(sel._color && sel._color !== sel.color ? {color: sel._color} : {})};
        try{ if(Object.keys(patch).length){ const r = await call("/api/markup", {id: sel.id, scope: s2.scope, scope_id: s2.id, ...patch}); Object.assign(sel, r); }
          delete sel._color; this._msg = ""; this._sel = null; }
        catch(err){ this._msg = `Not saved: ${err.message}`; }
        this._render(); this._show(); });
      on("[data-edel]", async el => { if(el.dataset.sure !== "1"){ el.dataset.sure = "1"; el.textContent = "Press again to delete"; return; }
        const s2 = scopeOf(this._map);
        try{ await call("/api/markup/delete", {id: sel.id, scope: s2.scope, scope_id: s2.id}); this._items = this._items.filter(i => i.id !== sel.id); this._sel = null; this._msg = ""; }
        catch(err){ this._msg = `Not deleted: ${err.message}`; }
        this._render(); this._show(); }); },
  });
  // ＋ Marker: a button of its own beside Move pin, Draw and Measure (core.js adds it after the save-as-image button)
  const MarkBtn = L.Control.extend({options: {position: "topleft"},
    onAdd(map){ const d = map._rfDraw, b = L.DomUtil.create("button", "leaflet-bar rf-mk-add"); b.type = "button"; b.dataset.mkAdd = "";
      L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, "click", ev => { L.DomEvent.stop(ev); if(d._arm?.mode === "add") d.disarm(); else d.arm(); });
      d._addBtn = b; d._armShow(); return b; }});
  window.RFMarkup = {
    add(map){ if(!map._rfDraw) map._rfDraw = new Draw().addTo(map); return map._rfDraw; },
    button(map){ if(map._rfDraw && !map._rfMarkBtn) map._rfMarkBtn = new MarkBtn().addTo(map); },
    refresh(){ all.forEach(d => d.load()); },
    canEdit,
    disarm(map){ for(const d of map ? [map._rfDraw] : [...all]) if(d) d.disarm(); },
    // a marker from outside a map (＋ Mark by the Pin box, Mark it on a page's viewer): on the Search map when it's up, else
    // saved with the mission or this copy, and any map showing those draws it. Throws what went wrong
    async markAt(at, label){ const ll = L.latLng(at), d = hasS() && S.map && S.map._rfDraw;
      if(d && d._map) return d._put(ll, {label, open: false});
      if(!canEdit(d && d._map)) throw new Error("View only: markers are added by a full login.");
      const s = defScope(), k = keyOf(s), names = [...all].find(x => x._scopeKey === k);
      const r = await call("/api/markup", {scope: s.scope, scope_id: s.id, kind: "point", geometry: {type: "Point", coordinates: posOf(ll)},
        label: String(label || "").trim().slice(0, 120) || (names ? names._nextName() : "Marker"), color: COLORS[0]});
      for(const x of all) if(x._scopeKey === k){ x._kept(r); x._render(); x._show(); }
      return r; }};
})();
