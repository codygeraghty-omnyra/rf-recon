/* Save the map as an image (Cody 11/10, "export map image"): this view as a PNG at 2x, 3x or 4x, for reports, PDFs and
   emails, looking as it does on screen (labels, dots and lines in proportion) but sharper. The map isn't touched: each
   tile layer's tiles for the view are fetched again at the zoom that gives that many pixels (Esri where it has the zoom,
   the zoom above where it doesn't, as on the map), then what's drawn over them is copied on at the same scale: the dot
   and line canvases, SVG, images (heatmaps), markers and labels (labels as text, so they're sharp too); a canvas with a redraw
   hook (canvas._rfDraw(g, k, map): the survey squares, surveymap.js) is drawn again at k, and the map's legends (map._rfLegends,
   each painting itself at k and saying how tall it was) go in its bottom right, clear of a scale bar. Underneath, a
   footer: the place, the date, the scale and the map's credits (the tile sources' terms ask for them).
   PC app and web version (the tiles come through this copy, so the canvas can read them; the web version relies on the
   sources' CORS, and a tile that can't be read is left out). */
(function(){
  const CAM = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
  const css = document.createElement("style");
  css.textContent = `.rf-ex-panel { margin-top: 6px; padding: 8px 10px; border-radius: 10px; width: 210px; font: 12px/1.35 system-ui, sans-serif;
      background: rgba(20,20,20,.9); color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
    .rf-ex-panel .row { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
    .rf-ex-panel button { font: inherit; padding: 3px 8px; border-radius: 7px; border: 1px solid rgba(255,255,255,.3); background: transparent; color: #fff; cursor: pointer; }
    .rf-ex-panel .hint { opacity: .75; margin-top: 4px; }`;
  document.head.appendChild(css);
  // tiles are fetched 6 at a time, each given 15 s: a copy that's busy (a sold copy's USGS Topo comes through it) took every tile
  // of a 2x image at once and the report's wait ran out (towers-tab, 11/11). Images already in the page (data:, blob:) don't queue
  let busy = 0; const waiting = [];
  const slot = () => busy < 6 ? (busy++, Promise.resolve()) : new Promise(r => waiting.push(r));
  const free = () => { const n = waiting.shift(); if(n) n(); else busy--; };
  const fetchImg = src => new Promise((ok, no) => { const i = new Image(); if(/^https?:/.test(src) && !src.startsWith(location.origin)) i.crossOrigin = "anonymous";
    const t = setTimeout(() => { i.src = ""; no(new Error("no tile in 15 s")); }, 15000);
    i.onload = () => { clearTimeout(t); ok(i); }; i.onerror = e => { clearTimeout(t); no(e); }; i.src = src; });
  const load = src => /^(data|blob):/.test(src) ? fetchImg(src) : slot().then(() => fetchImg(src).finally(free));
  const visible = el => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && +s.opacity !== 0; };
  const opacityOf = (el, stop) => { let o = 1; for(let e = el; e && e !== stop; e = e.parentElement) o *= +getComputedStyle(e).opacity || 1; return o; };
  // local time, as the person saving it reads it (toISOString's UTC said 16:58 at 10:58 Central, 11/10)
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const rectIn = (el, box, k) => { const r = el.getBoundingClientRect(); return {x: (r.left - box.left) * k, y: (r.top - box.top) * k, w: r.width * k, h: r.height * k}; };

  // one tile layer, fetched again for this view at the zoom that gives k times the pixels; or (fromMap) the layer's own tiles as
  // the map shows them, scaled k times: no fetch at all, for a copy too busy for the sharp one
  async function drawTiles(g, map, layer, k, W, H, fromMap){
    const o = layer.options, z = map.getZoom(), off = o.zoomOffset || 0;
    if(fromMap){ const box = map.getContainer().getBoundingClientRect(); let n = 0; g.globalAlpha = o.opacity ?? 1;
      for(const t of Object.values(layer._tiles || {})){ const im = t.el; if(!t.current || !im || !im.complete || !im.naturalWidth) continue;
        const r = rectIn(im, box, k); try{ g.drawImage(im, r.x, r.y, r.w, r.h); n++; }catch(e){ /* a tile the canvas can't read is left out */ } }
      g.globalAlpha = 1; return n; }
    if(z < (o.minZoom ?? 0) || z > (o.maxZoom ?? 30)) return 0;  // hidden at this zoom (Esri over USGS starts at 17)
    const deep = o.maxNativeZoom != null ? o.maxNativeZoom + off : (o.maxZoom ?? 19);  // the deepest zoom this source is asked for
    const want = Math.round(z + Math.log2(k)), tz = Math.max(0, Math.min(want, deep)), n = 2 ** tz;
    const s = k / 2 ** (tz - z);  // canvas pixels per tile pixel
    const tl = map.project(map.containerPointToLatLng([0, 0]), tz), pw = W / s, ph = H / s;
    const jobs = [], fb = o.fallback;
    for(let y = Math.floor(tl.y / 256); y <= Math.floor((tl.y + ph) / 256); y++){ if(y < 0 || y >= n) continue;
      for(let x = Math.floor(tl.x / 256); x <= Math.floor((tl.x + pw) / 256); x++){
        const wx = ((x % n) + n) % n, dx = (x * 256 - tl.x) * s, dy = (y * 256 - tl.y) * s, size = 256 * s;
        const url = zz => L.Util.template(layer._url, {...o, s: o.subdomains ? o.subdomains[0] : "a", r: "", x: zz === tz ? wx : Math.floor(wx / 2 ** (tz - zz)), y: zz === tz ? y : Math.floor(y / 2 ** (tz - zz)), z: zz});
        jobs.push(load(url(tz)).then(img => g.drawImage(img, dx, dy, size + .5, size + .5)).catch(async () => {
          if(fb == null || tz <= fb) return;  // as on the map (core.js RfTiles): a deeper tile that isn't there, cut from the zoom above
          const kk = 2 ** (tz - fb), sub = 256 / kk, img = await load(url(fb)).catch(() => null); if(!img) return;
          // a source pixel of the neighbours around the cut, so its edges blend (core.js RfTiles does the same)
          const sx = (wx % kk) * sub, sy = (y % kk) * sub, x0 = Math.max(0, sx - 1), y0 = Math.max(0, sy - 1), x1 = Math.min(256, sx + sub + 1), y1 = Math.min(256, sy + sub + 1), f = size / sub;
          g.drawImage(img, x0, y0, x1 - x0, y1 - y0, dx + (x0 - sx) * f, dy + (y0 - sy) * f, (x1 - x0) * f + .5, (y1 - y0) * f + .5); }));
      } }
    g.globalAlpha = o.opacity ?? 1; await Promise.all(jobs); g.globalAlpha = 1; return jobs.length;
  }
  async function svgImage(svg){
    const c = svg.cloneNode(true), r = svg.getBoundingClientRect(); c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if(svg.parentElement?.classList.contains("leaflet-pane")) for(const p of ["transform", "left", "top"]) c.style.removeProperty(p);
    if(!c.getAttribute("width")) c.setAttribute("width", r.width); if(!c.getAttribute("height")) c.setAttribute("height", r.height);
    const live = svg.querySelectorAll("*"), copy = c.querySelectorAll("*");  // the page's CSS on Leaflet's paths, written in
    live.forEach((n, i) => { const s = getComputedStyle(n); for(const p of ["stroke", "fill", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "stroke-dasharray"]) copy[i].style.setProperty(p, s.getPropertyValue(p)); });
    return load("data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(c)));
  }
  async function drawMarker(g, m, box, k){
    const svg = m.querySelector("svg");
    if(svg){ const r = rectIn(svg, box, k); g.drawImage(await svgImage(svg), r.x, r.y, r.w, r.h); return; }
    if(m.tagName === "IMG"){ const r = rectIn(m, box, k); g.drawImage(m, r.x, r.y, r.w, r.h); return; }
    const inner = m.firstElementChild || m, r = rectIn(inner, box, k), s = getComputedStyle(inner);
    const url = /url\("?(.*?)"?\)/.exec(s.backgroundImage || "")?.[1];
    if(url){ g.drawImage(await load(url), r.x, r.y, r.w, r.h); return; }
    const color = s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)" ? s.backgroundColor : "#e5534b";
    const mask = /url\("?(.*?)"?\)/.exec(s.webkitMaskImage || s.maskImage || "")?.[1];
    if(mask){ const img = await load(mask), t = document.createElement("canvas"); t.width = Math.ceil(r.w); t.height = Math.ceil(r.h);
      const tg = t.getContext("2d"); tg.drawImage(img, 0, 0, t.width, t.height); tg.globalCompositeOperation = "source-in"; tg.fillStyle = color; tg.fillRect(0, 0, t.width, t.height);
      g.drawImage(t, r.x, r.y); return; }
    g.fillStyle = color; g.beginPath(); g.arc(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) / 2, 0, 2 * Math.PI); g.fill();
  }
  function drawLabel(g, t, r, k){  // a tooltip as the page shows it: its box and its text, drawn at the image's scale
    const s = getComputedStyle(t), rad = (parseFloat(s.borderTopLeftRadius) || 0) * k;
    g.fillStyle = s.backgroundColor; g.beginPath(); if(g.roundRect) g.roundRect(r.x, r.y, r.w, r.h, rad); else g.rect(r.x, r.y, r.w, r.h); g.fill();
    g.fillStyle = s.color; g.font = `${s.fontWeight} ${parseFloat(s.fontSize) * k}px ${s.fontFamily}`; g.textBaseline = "middle"; g.textAlign = "left";
    const lines = t.innerText.split("\n"), lh = r.h / Math.max(1, lines.length), pad = (parseFloat(s.paddingLeft) || 4) * k;
    lines.forEach((ln, i) => g.fillText(ln, r.x + pad, r.y + lh * (i + .5), Math.max(1, r.w - 2 * pad)));
  }

  async function compose(map, k, opt = {}){
    const el = map.getContainer(), box = el.getBoundingClientRect(), W = Math.round(el.clientWidth * k), H = Math.round(el.clientHeight * k);
    const FOOT = Math.round(26 * k), cv = document.createElement("canvas"); cv.width = W; cv.height = H + FOOT;
    const g = cv.getContext("2d"); g.fillStyle = getComputedStyle(el).backgroundColor || "#ddd"; g.fillRect(0, 0, W, H);
    g.save(); g.beginPath(); g.rect(0, 0, W, H); g.clip();
    // the tile layers, bottom up, each fetched again at the image's resolution
    const tiles = []; map.eachLayer(l => { if(l instanceof L.TileLayer && l._url) tiles.push(l); });
    const paneZ = l => +getComputedStyle(l.getPane()).zIndex || 0;
    tiles.sort((a, b) => paneZ(a) - paneZ(b) || (a.options.zIndex || 1) - (b.options.zIndex || 1));
    let count = 0; for(const l of tiles) count += await drawTiles(g, map, l, k, W, H, !!opt.fromMap);
    // then what's drawn over them, pane by pane in stacking order, copied from the page at the same scale
    const panes = [...el.querySelectorAll(".leaflet-pane")].filter(p => !p.classList.contains("leaflet-map-pane") && !p.classList.contains("leaflet-tile-pane") && p.children.length && visible(p))
      .sort((a, b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0));
    for(const pane of panes) for(const n of pane.querySelectorAll("img, canvas, svg, .leaflet-marker-icon, .leaflet-tooltip")){
      if(n.closest(".leaflet-pane") !== pane || !visible(n)) continue;
      if(!n.matches(".leaflet-marker-icon, .leaflet-tooltip") && n.parentElement.closest("svg, .leaflet-marker-icon, .leaflet-tooltip")) continue;  // drawn with its parent
      const r = rectIn(n, box, k); if(r.w < 1 || r.h < 1 || r.x > W || r.y > H || r.x + r.w < 0 || r.y + r.h < 0) continue;
      g.globalAlpha = opacityOf(n, el);
      try{
        if(n.classList.contains("leaflet-tooltip")) drawLabel(g, n, r, k);
        else if(n.classList.contains("leaflet-marker-icon")) await drawMarker(g, n, box, k);
        else if(n.tagName === "IMG" && n.complete && n.naturalWidth) g.drawImage(n, r.x, r.y, r.w, r.h);
        else if(n.tagName === "CANVAS" && typeof n._rfDraw === "function"){ g.save(); n._rfDraw(g, k, map); g.restore(); }  // drawn again at k, sharp
        else if(n.tagName === "CANVAS") g.drawImage(n, r.x, r.y, r.w, r.h);
        else if(n.tagName.toLowerCase() === "svg") g.drawImage(await svgImage(n), r.x, r.y, r.w, r.h);
      }catch(err){ /* a piece that can't be read is left out; the rest is drawn */ }
      g.globalAlpha = 1;
    }
    // the map's legends (map._rfLegends: the survey tiles', surveymap.js), bottom right, the first lowest: each paints itself at k
    // with its right edge at x and its bottom at ly, and says how tall it was. A legend is a control, outside the panes, so the
    // image had the colours and not what they mean. The bottom left is a scale bar's (the tower report stamps one there)
    let ly = H - 10 * k;
    for(const lg of map._rfLegends ? [...map._rfLegends] : []){ try{ g.save(); const h = lg(g, k, W - 10 * k, ly); g.restore(); if(h > 0) ly -= h + 6 * k; }catch(err){ g.restore(); /* a legend that can't draw is left out */ } }
    g.restore();
    // the footer: what and where, the date, the scale and the map's credits
    g.fillStyle = "#14130f"; g.fillRect(0, H, W, FOOT); g.textBaseline = "middle"; g.font = `${Math.round(11 * k)}px system-ui, sans-serif`;
    const c = map.getCenter(), date = stamp();
    const scale = el.querySelector(".leaflet-control-scale-line")?.textContent || "";
    const credit = (el.querySelector(".leaflet-control-attribution")?.innerText || "").replace(/\s+/g, " ").trim();
    const mn = typeof S === "object" && S ? S.mission?.name : "";  // S is a top-level const (core.js), never on window
    const left = `DAStastic${mn ? ` · ${mn}` : ""} · ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} · ${date}${scale ? ` · scale bar ${scale}` : ""}`;
    g.fillStyle = "#fff"; g.textAlign = "left"; g.fillText(left, 8 * k, H + FOOT / 2);
    g.fillStyle = "#cfcfcf"; g.textAlign = "right"; g.fillText(credit, W - 8 * k, H + FOOT / 2, Math.max(60 * k, W - g.measureText(left).width - 24 * k));
    return {cv, tiles: count};
  }

  async function save(map, k, out){
    out.textContent = `Drawing the map at ${k}x…`;
    let r; try{ r = await compose(map, k); }catch(err){ out.textContent = `Couldn't draw the map: ${err.message}`; return; }
    const name = `DAStastic map ${stamp().replace(":", "")}.png`;
    try{ const blob = await new Promise((ok, no) => r.cv.toBlob(b => b ? ok(b) : no(new Error("no image")), "image/png"));
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      out.textContent = `Saved ${name}: ${r.cv.width} × ${r.cv.height} pixels.`; }
    catch(err){ out.textContent = `Couldn't save the image: ${err.message}. (In the web version a map whose source doesn't allow it can't be saved.)`; }
    return r;
  }

  const Export = L.Control.extend({
    options: {position: "topleft"},
    onAdd(map){
      const box = L.DomUtil.create("div", "leaflet-bar rf-ex"), b = L.DomUtil.create("a", "rf-ms-btn", box);
      b.href = "#"; b.title = "Save the map as an image"; b.setAttribute("role", "button"); b.setAttribute("aria-label", "Save the map as an image"); b.innerHTML = CAM;
      const pn = L.DomUtil.create("div", "rf-ex-panel", box); pn.hidden = true;
      pn.innerHTML = `<b>Save the map as an image</b><div class="hint">This view as a PNG, sharper than the screen, with the place, date, scale and map credits underneath.</div>
        <div class="row"><button data-k="2">2x</button><button data-k="3">3x</button><button data-k="4">4x</button><button data-x>Close</button></div><div class="hint" data-out></div>`;
      L.DomEvent.disableClickPropagation(box); L.DomEvent.disableScrollPropagation(box);
      L.DomEvent.on(b, "click", ev => { L.DomEvent.preventDefault(ev); pn.hidden = !pn.hidden; b.classList.toggle("on", !pn.hidden); });
      pn.querySelectorAll("[data-k]").forEach(btn => btn.onclick = async ev => { L.DomEvent.stop(ev); pn.querySelectorAll("button").forEach(x => x.disabled = true);
        try{ await save(map, +btn.dataset.k, pn.querySelector("[data-out]")); } finally{ pn.querySelectorAll("button").forEach(x => x.disabled = false); } });
      pn.querySelector("[data-x]").onclick = ev => { L.DomEvent.stop(ev); pn.hidden = true; b.classList.remove("on"); };
      return box;
    },
  });
  window.RFMapExport = {add(map){ if(!map._rfExport) map._rfExport = new Export().addTo(map); return map._rfExport; }, compose, save};
})();
