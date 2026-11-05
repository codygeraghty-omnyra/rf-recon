"use strict";
/* RF Recon — the zoom bar every map gets (Cody 11/4: "next to the + and − zoom buttons at the top of every map, a
   button that locks zooming with the mouse wheel, so you can only use + and − when it's locked"; later: "keep mouse
   scroll locked on login by default - but left click hold and scroll works always - have the layers and zoom buttons
   switch sides"). − and + zoom; the lock turns mouse-wheel zoom off on every map at once (the wheel then scrolls the
   page). It is locked whenever RF Recon opens; unlocking lasts until it's opened again. Locked, holding the left mouse
   button (or Ctrl) while scrolling still zooms, and the click that ends a held zoom doesn't move the pin. Pinch and
   double-tap still zoom. The bar sits top right (the layers button top left). Used by the PC/server/web pages
   (core.js addMapLayers) and the phone app (app.js, hunt.js). Needs Leaflet. */
(() => {
  let on = false;  // locked as RF Recon opens (Cody 11/4); nothing remembered, so every sign-in starts locked
  const maps = new Set(), paints = new Set();
  const apply = m => { if (m.scrollWheelZoom) on || m._rfHeld ? m.scrollWheelZoom.enable() : m.scrollWheelZoom.disable(); };
  function set(v) {
    on = !!v;
    if (typeof S === "object" && S) S.wheelZoom = on;  // the Search map's own setting reads this
    for (const m of maps) apply(m);
    for (const p of paints) p();
  }
  function hint(box) {  // locked and the wheel was turned over the map: say how to zoom anyway, briefly
    let h = box.querySelector(".rf-wheelhint");
    if (!h) { h = document.createElement("div"); h.className = "rf-wheelhint"; h.textContent = "Hold the left mouse button (or Ctrl) and scroll to zoom"; box.appendChild(h); }
    h.classList.add("on"); clearTimeout(h._t); h._t = setTimeout(() => h.classList.remove("on"), 1600);
  }
  function add(map, position = "topright") {
    if (!map || map._rfZoomBar) return;
    map._rfZoomBar = true;
    if (map.zoomControl) map.removeControl(map.zoomControl);  // the bar has its own − and +
    maps.add(map); apply(map);
    // locked: the left button held down lets the wheel zoom (Leaflet's own wheel zoom, switched on while it's held)
    const box = map.getContainer();
    let swallow = false, hintAt = 0, ctrlAt = 0;
    const hold = v => { map._rfHeld = v; apply(map); };
    const down = e => { if (e.button === 0) { swallow = false; hold(true); } };
    const up = () => { if (map._rfHeld) hold(false); };
    box.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up); window.addEventListener("blur", up);
    box.addEventListener("wheel", e => {
      if (on) return;
      if (map._rfHeld) { swallow = true; return; }  // zooming while held: the click that ends it isn't a pin move
      if (e.ctrlKey) {  // Ctrl + wheel zooms at the cursor, as on the spectrum, topology and floor plans
        e.preventDefault(); e.stopPropagation();
        const now = Date.now(); if (now - ctrlAt < 180) return; ctrlAt = now;
        map.setZoomAround(map.mouseEventToContainerPoint(e), map.getZoom() + (e.deltaY < 0 ? 1 : -1)); return;
      }
      const now = Date.now(); if (now - hintAt > 4000) { hintAt = now; hint(box); }
    }, { passive: false, capture: true });
    const eat = e => { if (swallow && box.contains(e.target)) { swallow = false; e.stopPropagation(); e.preventDefault(); } };
    document.addEventListener("click", eat, true);
    let paint = null;
    const Bar = L.Control.extend({ onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar rf-zoombar");
      const btn = (txt, title, cls) => { const b = L.DomUtil.create("a", cls || "", d); b.href = "#"; b.textContent = txt; b.title = title;
        b.setAttribute("role", "button"); b.setAttribute("aria-label", title); return b; };
      const out = btn("−", "Zoom out"), inn = btn("+", "Zoom in"), lock = btn("", "", "rf-wheel");
      paint = () => {
        lock.textContent = on ? "🖱" : "🔒";
        lock.setAttribute("aria-pressed", on ? "false" : "true");
        const t = on ? "Mouse-wheel zoom is on until RF Recon is opened again. Click to lock it: the wheel then scrolls the page."
                     : "Mouse-wheel zoom is locked (it always is when RF Recon opens): the wheel scrolls the page. Hold the left mouse button (or Ctrl) and scroll to zoom, or use − and +. Click to let the wheel zoom.";
        lock.title = t; lock.setAttribute("aria-label", t);
      };
      paint(); paints.add(paint);
      L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d);
      L.DomEvent.on(out, "click", e => { L.DomEvent.preventDefault(e); map.zoomOut(); });
      L.DomEvent.on(inn, "click", e => { L.DomEvent.preventDefault(e); map.zoomIn(); });
      L.DomEvent.on(lock, "click", e => { L.DomEvent.preventDefault(e); set(!on); });
      return d;
    } });
    new Bar({ position }).addTo(map);
    map.on("unload", () => { maps.delete(map); if (paint) paints.delete(paint);
      document.removeEventListener("mouseup", up); window.removeEventListener("blur", up); document.removeEventListener("click", eat, true); });
  }
  if (!document.getElementById("rfZoomCss")) {
    const st = document.createElement("style"); st.id = "rfZoomCss";
    st.textContent = `.rf-zoombar{display:flex!important;background:var(--panel,#fff)}
.rf-zoombar a{width:auto!important;min-width:30px;height:30px;padding:0 8px;display:flex!important;align-items:center;justify-content:center;
  font:600 14px system-ui;color:var(--ink,#111)!important;background:transparent!important;border-bottom:0!important;border-right:1px solid rgba(127,127,127,.35)}
.rf-zoombar a:last-child{border-right:0}
.rf-zoombar a.rf-wheel[aria-pressed=true]{background:var(--accent,#2f6fed)!important;color:#fff!important}
.rf-wheelhint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1001;padding:10px 14px;border-radius:10px;
  background:rgba(0,0,0,.7);color:#fff;font:600 14px system-ui;pointer-events:none;opacity:0;transition:opacity .25s;white-space:nowrap}
.rf-wheelhint.on{opacity:1}
@media (pointer:coarse){.rf-zoombar a{min-width:40px;height:40px}}`;
    (document.head || document.documentElement).appendChild(st);
  }
  window.rfZoomBar = add;
  window.rfWheelZoom = { get on() { return on; }, set };
})();
