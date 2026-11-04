"use strict";
/* RF Recon — the zoom bar every map gets (Cody 11/4: "next to the + and − zoom buttons at the top of every map, a
   button that locks zooming with the mouse wheel, so you can only use + and − when it's locked"). − and + zoom; the
   lock turns mouse-wheel zoom off on every map at once (the wheel then scrolls the page) and is remembered
   (rfr.wheelZoom). Pinch and double-tap still zoom. Used by the PC/server/web pages (core.js addMapLayers) and the
   phone app (app.js, hunt.js). Needs Leaflet. */
(() => {
  const KEY = "rfr.wheelZoom";
  let on = true;
  try { on = localStorage.getItem(KEY) !== "0"; } catch (e) { /* storage blocked: the wheel zooms */ }
  const maps = new Set(), paints = new Set();
  const apply = m => { if (m.scrollWheelZoom) on ? m.scrollWheelZoom.enable() : m.scrollWheelZoom.disable(); };
  function set(v) {
    on = !!v;
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) { /* not remembered: still applies now */ }
    if (typeof S === "object" && S) S.wheelZoom = on;  // the Search map's own setting reads this
    for (const m of maps) apply(m);
    for (const p of paints) p();
  }
  function add(map, position = "topleft") {
    if (!map || map._rfZoomBar) return;
    map._rfZoomBar = true;
    if (map.zoomControl) map.removeControl(map.zoomControl);  // the bar has its own − and +
    maps.add(map); apply(map);
    let paint = null;
    const Bar = L.Control.extend({ onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar rf-zoombar");
      const btn = (txt, title, cls) => { const b = L.DomUtil.create("a", cls || "", d); b.href = "#"; b.textContent = txt; b.title = title;
        b.setAttribute("role", "button"); b.setAttribute("aria-label", title); return b; };
      const out = btn("−", "Zoom out"), inn = btn("+", "Zoom in"), lock = btn("", "", "rf-wheel");
      paint = () => {
        lock.textContent = on ? "🖱" : "🔒";
        lock.setAttribute("aria-pressed", on ? "false" : "true");
        const t = on ? "Mouse-wheel zoom is on. Click to lock it: then only − and + zoom, and the wheel scrolls the page."
                     : "Mouse-wheel zoom is locked: only − and + zoom. Click to zoom with the wheel again.";
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
    map.on("unload", () => { maps.delete(map); if (paint) paints.delete(paint); });
  }
  if (!document.getElementById("rfZoomCss")) {
    const st = document.createElement("style"); st.id = "rfZoomCss";
    st.textContent = `.rf-zoombar{display:flex!important;background:var(--panel,#fff)}
.rf-zoombar a{width:auto!important;min-width:30px;height:30px;padding:0 8px;display:flex!important;align-items:center;justify-content:center;
  font:600 14px system-ui;color:var(--ink,#111)!important;background:transparent!important;border-bottom:0!important;border-right:1px solid rgba(127,127,127,.35)}
.rf-zoombar a:last-child{border-right:0}
.rf-zoombar a.rf-wheel[aria-pressed=true]{background:var(--accent,#2f6fed)!important;color:#fff!important}
@media (pointer:coarse){.rf-zoombar a{min-width:40px;height:40px}}`;
    (document.head || document.documentElement).appendChild(st);
  }
  window.rfZoomBar = add;
  window.rfWheelZoom = { get on() { return on; }, set };
})();
