/* Measure (Cody 11/10): a ruler on every map. Click (tap) points: each leg shows its length and bearing, the label at the
   end the running total; click the first point again to close an area (its area and perimeter). Double-click, Enter or
   Done finishes and leaves the measurement on the map; Esc, Clear or the ruler again removes it. Works with no signal;
   nothing is saved or sent anywhere. Distances and areas are on the earth's surface (a sphere of mean radius), so they
   agree with the map's other distances (Leaflet's map.distance) to well under a percent at site scale.
   Used by the PC app (core.js addMapLayers) and the phone (phone/app.js, phone/hunt.js; copied by phone/publish.py). */
(function(){
  const R = 6371008.8, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const bearing = (a, b) => { const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lng - a.lng);
    return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360; };
  // area of a polygon on the sphere (the excess-sum formula Leaflet.draw uses: good to a fraction of a percent at site scale)
  const area = ll => { let s = 0; for(let i = 0; i < ll.length; i++){ const a = ll[i], b = ll[(i + 1) % ll.length];
    s += rad(b.lng - a.lng) * (2 + Math.sin(rad(a.lat)) + Math.sin(rad(b.lat))); } return Math.abs(s * R * R / 2); };
  const n = (v, d) => v.toLocaleString(undefined, {minimumFractionDigits: d, maximumFractionDigits: d});
  const len = m => { const mi = m / 1609.344, ft = m * 3.28084;
    return `${mi >= 0.2 ? `${n(mi, mi < 10 ? 2 : 1)} mi` : `${n(ft, 0)} ft`} · ${m >= 1000 ? `${n(m / 1000, 2)} km` : `${n(m, 0)} m`}`; };
  const sq = m2 => { const mi2 = m2 / 2589988.11, ac = m2 / 4046.8564;
    return `${mi2 >= 0.5 ? `${n(mi2, 2)} sq mi` : ac >= 0.1 ? `${n(ac, ac < 10 ? 2 : 1)} acres` : `${n(m2 * 10.7639, 0)} sq ft`} · ${m2 >= 1e6 ? `${n(m2 / 1e6, 2)} km²` : `${n(m2, 0)} m²`}`; };
  const brg = b => `${n(b, 0)}°`;
  const COLOR = "#ff7a1a";
  const TOUCH = window.matchMedia && matchMedia("(pointer: coarse)").matches;  // a phone or tablet: tap and Done, not click, double-click and Esc

  const css = document.createElement("style");
  // Leaflet's control-box border drew a faint frame round the button and its panel together (seen on the phone 11/10)
  css.textContent = `.leaflet-bar.rf-ms, .leaflet-bar.rf-dr, .leaflet-bar.rf-ex { border: 0; box-shadow: none; background: none; }
    .rf-measuring .leaflet-container, .leaflet-container.rf-measuring { cursor: crosshair; }
    .rf-ms-btn { width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; border-radius: 10px;
      background: var(--panel, rgba(30,30,30,.85)); color: var(--ink, #fff); border: 1px solid var(--line, rgba(255,255,255,.18)); }
    .rf-ms-btn.on { background: ${COLOR}; color: #111; border-color: ${COLOR}; }
    .rf-ms-panel { margin-top: 6px; padding: 8px 10px; border-radius: 10px; max-width: 260px; font: 12px/1.35 system-ui, sans-serif;
      background: rgba(20,20,20,.88); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    .rf-ms-panel b { font-weight: 600; } .rf-ms-panel .row { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    .rf-ms-panel button { font: inherit; padding: 3px 8px; border-radius: 7px; border: 1px solid rgba(255,255,255,.3); background: transparent; color: #fff; cursor: pointer; }
    .rf-ms-label { background: rgba(20,20,20,.85); color: #fff; border: 0; border-radius: 6px; padding: 2px 6px; font: 11px/1.3 system-ui, sans-serif; box-shadow: none; white-space: nowrap; }
    .rf-ms-label::before { display: none; } .rf-ms-total { background: ${COLOR}; color: #111; font-weight: 600; }`;
  document.head.appendChild(css);
  const RULER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2m1-5 2 2m1-5 2 2m1-5 2 2"/></svg>';

  const Measure = L.Control.extend({
    options: {position: "topleft"},
    onAdd(map){
      this._map = map; this._pts = []; this._closed = false; this._done = false; this._g = L.layerGroup();
      const box = L.DomUtil.create("div", "leaflet-bar rf-ms");
      const b = this._btn = L.DomUtil.create("a", "rf-ms-btn", box);
      b.href = "#"; b.title = "Measure distance and area"; b.setAttribute("role", "button"); b.setAttribute("aria-label", "Measure distance and area"); b.innerHTML = RULER;
      this._panel = L.DomUtil.create("div", "rf-ms-panel", box); this._panel.hidden = true;
      L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(b, "click", e => { L.DomEvent.preventDefault(e); this._on ? this.stop() : this.start(); });
      this._key = e => { if(!this._on) return; if(e.key === "Escape") this.stop(); else if(e.key === "Enter") this.finish(); };
      document.addEventListener("keydown", this._key);
      map.on("unload", () => document.removeEventListener("keydown", this._key));
      return box;
    },
    start(){ const m = this._map; if(m._rfDraw?._tool) m._rfDraw._cancel();  // one tool at a time (markup.js)
      this._on = true; m._rfMeasuring = true; this._btn.classList.add("on"); m.getContainer().classList.add("rf-measuring");
      this._dbl = m.doubleClickZoom.enabled(); m.doubleClickZoom.disable(); this._g.addTo(m); this._reset();
      m.on("click", this._click, this); m.on("mousemove", this._move, this); m.on("dblclick", this._dblclick, this); this._show(); },
    stop(){ const m = this._map; this._on = false; m._rfMeasuring = false; this._btn.classList.remove("on"); m.getContainer().classList.remove("rf-measuring");
      if(this._dbl) m.doubleClickZoom.enable(); m.off("click", this._click, this); m.off("mousemove", this._move, this); m.off("dblclick", this._dblclick, this);
      this._reset(); this._g.remove(); this._panel.hidden = true; },
    _reset(){ this._pts = []; this._closed = false; this._done = false; this._g.clearLayers(); this._rubber = null; },
    finish(){ if(this._pts.length < 2) return; this._done = true; if(this._rubber){ this._g.removeLayer(this._rubber); this._rubber = null; } this._draw(); this._show(); },
    _click(e){ if(this._done){ this._reset(); }  // a click after Done starts a new measurement
      const p = this._pts, pt = this._map.latLngToContainerPoint(e.latlng);
      if(p.length >= 3 && pt.distanceTo(this._map.latLngToContainerPoint(p[0])) < 12){ this._closed = true; this.finish(); return; }  // the first point: close an area
      if(p.length && pt.distanceTo(this._map.latLngToContainerPoint(p[p.length - 1])) < 4) return;  // a double-click's second click
      p.push(e.latlng); this._draw(); this._show(); },
    _dblclick(e){ L.DomEvent.stop(e); this.finish(); },
    _move(e){ const p = this._pts; if(!p.length || this._done) return; const a = p[p.length - 1];
      const ll = [a, e.latlng], d = this._map.distance(a, e.latlng);
      const txt = `${len(d)} · ${brg(bearing(a, e.latlng))}`;
      if(!this._rubber){ this._rubber = L.polyline(ll, {color: COLOR, weight: 2, dashArray: "4 6", interactive: false}).addTo(this._g)
        .bindTooltip(txt, {permanent: true, direction: "right", offset: [10, 0], className: "rf-ms-label"}); }
      else{ this._rubber.setLatLngs(ll).setTooltipContent(txt); if(!this._g.hasLayer(this._rubber)) this._g.addLayer(this._rubber); }
      this._rubber.openTooltip(e.latlng); },
    _draw(){ const g = this._g, p = this._pts, m = this._map; const rubber = this._rubber; g.clearLayers(); if(rubber && !this._done) g.addLayer(rubber);
      if(!p.length) return;
      const ring = this._closed ? [...p, p[0]] : p;
      if(this._closed) L.polygon(p, {color: COLOR, weight: 2.5, fillColor: COLOR, fillOpacity: .15, interactive: false}).addTo(g);
      else L.polyline(p, {color: COLOR, weight: 2.5, interactive: false}).addTo(g);
      p.forEach((ll, i) => L.circleMarker(ll, {radius: i ? 4 : 5, color: "#111", weight: 1.5, fillColor: i ? "#fff" : COLOR, fillOpacity: 1, interactive: false}).addTo(g));
      for(let i = 1; i < ring.length; i++){ const a = ring[i - 1], b = ring[i], mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
        if(ring.length > 2 || this._done) L.tooltip({permanent: true, direction: "center", className: "rf-ms-label", interactive: false})
          .setLatLng(mid).setContent(`${len(m.distance(a, b))} · ${brg(bearing(a, b))}`).addTo(g); }
      // the total at the line's last point; an area's in its middle (at a corner it covered that side's own label)
      const t = this._totals(); if(p.length >= 2) // "auto": the side with room (on a phone the total ran off the right edge, 11/10)
        L.tooltip({permanent: true, direction: this._closed ? "center" : "auto", offset: this._closed ? [0, 0] : [10, 0],
        className: "rf-ms-label rf-ms-total", interactive: false})
        .setLatLng(this._closed ? L.latLngBounds(p).getCenter() : p[p.length - 1]).setContent(this._closed ? `Area ${sq(t.area)}` : `Total ${len(t.total)}`).addTo(g); },
    _totals(){ const p = this._pts, m = this._map, ring = this._closed ? [...p, p[0]] : p; let total = 0;
      for(let i = 1; i < ring.length; i++) total += m.distance(ring[i - 1], ring[i]);
      return {total, area: this._closed ? area(p) : 0}; },
    _text(){ const p = this._pts, t = this._totals();
      if(this._closed) return `Area ${sq(t.area)}\nPerimeter ${len(t.total)}\n${p.length} corners`;
      return `Distance ${len(t.total)}\n${p.length} points` + (p.length === 2 ? `\nBearing ${brg(bearing(p[0], p[1]))} (true)` : ""); },
    _show(){ const pn = this._panel, p = this._pts; pn.hidden = false;
      if(!p.length){ pn.innerHTML = TOUCH ? `<b>Measure</b><br>Tap points on the map. Tap the first point again to measure an area. Done finishes; Clear starts again.<div class="row"><button data-x>Close</button></div>`
        : `<b>Measure</b><br>Click points on the map. Click the first point again to measure an area. Double-click or Enter to finish; Esc to clear.<div class="row"><button data-x>Close</button></div>`; }
      else{ const t = this._text().split("\n");
        pn.innerHTML = `<b>${t[0]}</b>${t.slice(1).map(x => `<br>${x}`).join("")}${!this._done ? `<br><span style="opacity:.75">${p.length >= 3 ? `${TOUCH ? "Tap" : "Click"} the first point to close an area. ` : ""}${TOUCH ? "Done to finish." : "Double-click or Done to finish."}</span>` : ""}
          <div class="row">${!this._done && p.length >= 2 ? "<button data-d>Done</button>" : ""}<button data-c>Copy</button><button data-r>Clear</button><button data-x>Close</button></div>`; }
      // each button stops its click here: the panel is redrawn inside the handler, so by the time the map saw the click
      // the button was no longer in the panel and the map took it for a point (seen in testing 11/10)
      const q = s => pn.querySelector(s), on = (s, fn) => { const el = q(s); if(el) el.onclick = e => { L.DomEvent.stop(e); fn(el); }; };
      on("[data-d]", () => this.finish());
      on("[data-c]", async el => { const pts = this._pts.map(ll => `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`).join("\n");
        try{ await navigator.clipboard.writeText(`${this._text()}\n${pts}`); el.textContent = "Copied"; }catch(e){ el.textContent = "Can't copy here"; } });
      on("[data-r]", () => { this._reset(); this._show(); });
      on("[data-x]", () => this.stop()); },
  });
  // opts.position: where on the map (default top left; the phone's full-screen map puts it bottom left, as its header
  // covers the top of the map)
  window.RFMeasure = {add(map, opts){ if(!map._rfMeasure){ map._rfMeasure = new Measure(opts).addTo(map); } return map._rfMeasure; }, bearing, area};
})();
