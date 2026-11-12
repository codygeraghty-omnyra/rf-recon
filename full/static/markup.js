/* Draw (Cody 11/10, "draw and mark up"): points, lines and areas on the maps, kept with the open mission, the DAS job
   whose map this is, or this copy's own drawings when neither is open (markup.py). Each shows its name, and a line its
   length, an area its area (measure.js's arithmetic). Click one to rename it, change its colour, add a note or delete it.
   Export as KML (Google Earth, ATAK) or GeoJSON. A view-only login sees the drawings but can't change them.
   PC app and web version; the phone has no server to keep them. A map can say what it belongs to with
   map._rfScope = () => ({scope: "job", id, name}) before addMapLayers (das.js's pre-survey map does). */
(function(){
  const COLORS = ["#ff7a1a", "#e5534b", "#2f81f7", "#3fb950", "#d29922", "#a371f7", "#ffffff"];
  const NAMES = {point: "Point", line: "Line", area: "Area"};
  const e = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const call = async (url, body) => { const r = await fetch(url, body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    const j = await r.json().catch(() => ({})); if(!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; };
  const n = (v, d) => v.toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
  const len = m => m / 1609.344 >= 0.2 ? `${n(m / 1609.344, 2)} mi` : `${n(m * 3.28084, 0)} ft`;
  const sq = m2 => m2 / 2589988.11 >= 0.5 ? `${n(m2 / 2589988.11, 2)} sq mi` : m2 / 4046.8564 >= 0.1 ? `${n(m2 / 4046.8564, 2)} acres` : `${n(m2 * 10.7639, 0)} sq ft`;
  const area = ll => window.RFMeasure ? RFMeasure.area(ll) : 0;
  const scopeOf = map => (map._rfScope && map._rfScope()) || (typeof S === "object" && S && S.missionId
    ? {scope: "mission", id: S.missionId, name: `mission “${S.mission?.name || S.missionId}”`} : {scope: "scratch", id: 0, name: "this copy (no mission open)"});
  const keyOf = s => `${s.scope}:${s.id}`;
  const all = new Set();  // every Draw on a live map, for refresh() after a mission is opened

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
    .rf-dr-label::before { display: none; }`;
  document.head.appendChild(css);
  const PEN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/></svg>';

  const Draw = L.Control.extend({
    options: {position: "topleft"},
    onAdd(map){
      this._map = map; this._items = []; this._g = L.layerGroup().addTo(map); this._tool = null; this._pts = []; this._color = COLORS[0];
      this._hidden = false; this._sel = null; this._msg = ""; this._scopeKey = null;
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
      map.on("unload", () => { document.removeEventListener("keydown", this._key); all.delete(this); });
      all.add(this); this.load();
      return box;
    },
    // drawn at once with what's known, then again when the server's list arrives (until then the buttons weren't there)
    open(){ if(this._map._rfMeasure?._on) this._map._rfMeasure.stop(); this._map.fire("rftool"); this._panel.hidden = false; this._btn.classList.add("on"); this._show(); this.load(); },
    close(){ this._cancel(); this._sel = null; this._panel.hidden = true; this._btn.classList.remove("on"); },
    async load(){ const s = scopeOf(this._map); this._scopeKey = keyOf(s);
      try{ const r = await call(`/api/markup?scope=${s.scope}&id=${s.id}`); this._items = r.items; this._msg = ""; }
      catch(err){ this._items = []; this._msg = `Drawings: ${err.message}`; }
      if(!this._map) return;  // the map went while the list loaded (a tab left: RFMaps, 11/10)
      this._render(); this._show(); },
    // ---- drawing one
    _start(tool){ this._sel = null; this._tool = tool; this._pts = []; const m = this._map; m.fire("rftool"); m._rfMeasuring = true;  // Move pin, if armed, is done
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
      const pos = ll => [+ll.lng.toFixed(7), +ll.lat.toFixed(7)];
      const geometry = t === "point" ? {type: "Point", coordinates: pos(p[0])} : t === "line" ? {type: "LineString", coordinates: p.map(pos)}
        : {type: "Polygon", coordinates: [[...p, p[0]].map(pos)]};
      const s = scopeOf(this._map);  // the name typed before drawing (the panel shows the drawing's hints meanwhile)
      const label = (this._next || "").trim() || `${NAMES[t]} ${this._items.filter(i => i.kind === t).length + 1}`;
      this._end();
      try{ const r = await call("/api/markup", {scope: s.scope, scope_id: s.id, kind: t, geometry, label, color: this._color});
        this._items.push(r); this._msg = ""; this._next = ""; }
      catch(err){ this._msg = `Not saved: ${err.message}`; }
      this._render(); this._show(); },
    // ---- the saved ones
    _measure(it){ const g = it.geometry, ll = c => L.latLng(c[1], c[0]);
      if(it.kind === "line"){ let d = 0; for(let i = 1; i < g.coordinates.length; i++) d += this._map.distance(ll(g.coordinates[i - 1]), ll(g.coordinates[i])); return len(d); }
      if(it.kind === "area") return sq(area(g.coordinates[0].slice(0, -1).map(ll)));
      return `${g.coordinates[1].toFixed(5)}, ${g.coordinates[0].toFixed(5)}`; },
    _render(){ const g = this._g; g.clearLayers(); if(this._hidden) return;
      for(const it of this._items){ const c = it.color || COLORS[0], ll = p => L.latLng(p[1], p[0]), geo = it.geometry;
        const tip = `${e(it.label || NAMES[it.kind])}${it.kind !== "point" ? ` · ${this._measure(it)}` : ""}`;
        const o = {color: c, weight: this._sel === it.id ? 4.5 : 3, bubblingMouseEvents: false};
        const lyr = it.kind === "point" ? L.circleMarker(ll(geo.coordinates), {...o, radius: 7, color: "#111", weight: 1.5, fillColor: c, fillOpacity: 1})
          : it.kind === "line" ? L.polyline(geo.coordinates.map(ll), o) : L.polygon(geo.coordinates[0].slice(0, -1).map(ll), {...o, fillOpacity: .15});
        lyr.bindTooltip(tip, {permanent: true, direction: it.kind === "point" ? "top" : "center", offset: it.kind === "point" ? [0, -8] : [0, 0], className: "rf-dr-label"});
        lyr.on("click", ev => { const m = this._map;  // bubblingMouseEvents:false keeps it off the map, so a tool on gets it here
          if(m._rfMeasuring){ m.fire("click", {latlng: ev.latlng, layerPoint: ev.layerPoint, containerPoint: ev.containerPoint, originalEvent: ev.originalEvent}); return; }
          this._sel = it.id; this.open(); this._render(); });
        lyr.addTo(g); } },
    _show(){ const pn = this._panel; if(pn.hidden) return; const s = scopeOf(this._map), sel = this._items.find(i => i.id === this._sel);
      // no taller than the map, clear of its bottom-left readout and scale (seen 11/10 on a 600-pixel map), scrolling inside
      pn.style.maxHeight = `${Math.max(160, this._map.getSize().y - 230)}px`;
      const sw = cur => COLORS.map(c => `<button class="rf-dr-sw${c === cur ? " on" : ""}" data-c="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join("");
      let h = `<b>Draw</b> <span class="rf-dr-hint">· kept with ${e(s.name)}</span>`;
      if(this._tool){ const need = {point: "Click where it goes.", line: "Click each point. Double-click, Enter or Done to finish.", area: "Click each corner; click the first one, double-click or Done to close it."}[this._tool];
        h += `<div class="rf-dr-hint">${NAMES[this._tool]}: ${need} Esc to cancel.</div><div class="row">${this._tool !== "point" ? "<button data-done>Done</button>" : ""}<button data-cancel>Cancel</button></div>`; }
      else if(sel){ h += `<div class="row"><b>Edit</b></div><input data-elabel maxlength="120" value="${e(sel.label)}" placeholder="Name">
          <div class="row">${sw(sel.color || COLORS[0])}</div><textarea data-enote rows="3" maxlength="2000" placeholder="Note">${e(sel.note)}</textarea>
          <div class="rf-dr-hint">${NAMES[sel.kind]} · ${this._measure(sel)}${sel.created_by ? ` · drawn by ${e(sel.created_by)}, ${e(sel.created_at)}` : ""}</div>
          <div class="row"><button data-esave>Save</button><button data-ezoom>Zoom to</button><button data-edel>Delete</button><button data-eback>Back</button></div>`; }
      else{ h += `<div class="row"><button data-t="point">Point</button><button data-t="line">Line</button><button data-t="area">Area</button></div>
          <div class="row">${sw(this._color)}</div><input data-name maxlength="120" placeholder="Name for the next one (optional)" value="${e(this._next || "")}">
          ${this._items.length ? this._items.map(it => `<div class="rf-dr-item" data-i="${it.id}"><span class="dot" style="background:${e(it.color)}"></span><span class="grow">${e(it.label || NAMES[it.kind])}</span><span class="rf-dr-hint">${it.kind === "point" ? "point" : this._measure(it)}</span></div>`).join("")
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
      on("[data-i]", el => { this._sel = +el.dataset.i; this._render(); this._show(); });
      on(".rf-dr-sw", el => { if(sel){ sel._color = el.dataset.c; pn.querySelectorAll(".rf-dr-sw").forEach(x => x.classList.toggle("on", x === el)); } else { this._color = el.dataset.c; this._show(); } });
      on("[data-eback]", () => { this._sel = null; this._render(); this._show(); });
      on("[data-ezoom]", () => { const g = sel.geometry, ll = p => L.latLng(p[1], p[0]);
        if(sel.kind === "point") this._map.setView(ll(g.coordinates), Math.max(this._map.getZoom(), 17));
        else this._map.fitBounds(L.latLngBounds((sel.kind === "line" ? g.coordinates : g.coordinates[0]).map(ll)).pad(.3)); });
      on("[data-esave]", async () => { const s2 = scopeOf(this._map);
        try{ const r = await call("/api/markup", {id: sel.id, scope: s2.scope, scope_id: s2.id, kind: sel.kind, geometry: sel.geometry,
            label: pn.querySelector("[data-elabel]").value, note: pn.querySelector("[data-enote]").value, color: sel._color || sel.color});
          Object.assign(sel, r); delete sel._color; this._msg = ""; this._sel = null; }
        catch(err){ this._msg = `Not saved: ${err.message}`; }
        this._render(); this._show(); });
      on("[data-edel]", async el => { if(el.dataset.sure !== "1"){ el.dataset.sure = "1"; el.textContent = "Press again to delete"; return; }
        const s2 = scopeOf(this._map);
        try{ await call("/api/markup/delete", {id: sel.id, scope: s2.scope, scope_id: s2.id}); this._items = this._items.filter(i => i.id !== sel.id); this._sel = null; this._msg = ""; }
        catch(err){ this._msg = `Not deleted: ${err.message}`; }
        this._render(); this._show(); }); },
  });
  window.RFMarkup = {add(map){ if(!map._rfDraw) map._rfDraw = new Draw().addTo(map); return map._rfDraw; }, refresh(){ all.forEach(d => d.load()); }};
})();
