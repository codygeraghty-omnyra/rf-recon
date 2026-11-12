"use strict";
/* DAStastic — the map holds still (Cody 11/10, after Andy's demo on 11/9: clicking things on the map moved the pin or the
   view and "we may have lost the site"). On every map, clicking a result shows it without the map moving, re-zooming,
   re-fitting, rebuilding or scrolling the page; only an explicit "Zoom to" moves it.

   RFMaps: one live map per slot. Each view used to make a new Leaflet map every time it drew its HTML, fitted to its
   contents, so a filter, a sort or a tick threw the view away; some left the old map running too.
     RFMaps.keep(key, placeholder, create, {tab, gone}) gives the slot's map: the first time create(placeholder) makes it
       on the placeholder; after that a view that drew its HTML again gets the same map moved back into place (sized
       again only if its size changed), never a new one. The slot is the key up to its first ":" ("presurvey:12"): a
       different job or mission in the same slot removes the old map first.
     RFMaps.sweep(tab) removes the maps of other tabs, after keeping their view (centre and zoom) for when they come back.
     RFMaps.first(map, sig, fit) fits a map only when it's new or what it shows moved (sig: the job's pin, the search's
       spot); a map made again for the same thing gets its kept view back instead.
     RFMaps.made (maps ever made) and RFMaps.live (maps alive) let the tests prove there's no rebuild and no leak.
   RFResults: the results viewer, below.
   PC app, web version and the phone app (publish.py copies this file). Needs Leaflet. */
(function(){
  const slots = new Map();   // slot -> {key, map, tab, gone}
  const views = new Map();   // key -> {center, zoom, sig}: the view a map had when it went, for when it comes back
  // S is a const in core.js (and phone/app.js), so it isn't on window: read it by name, once those have loaded
  const tabNow = () => (typeof S === "object" && S && S.tab) || "";
  const slotOf = key => String(key).split(":")[0];
  const remember = (key, map) => { try{ if(!map._loaded) return; const c = map.getCenter(); views.set(key, {center: [c.lat, c.lng], zoom: map.getZoom(), sig: map._rfSig}); }
    catch(e){ /* a map torn down half way has no view to keep */ } };
  // tells Leaflet the container's size changed, and nothing else: no fit, no pan of its own. Leaflet's invalidateSize
  // forgets the exact centre it was given (it reads it back from whole pixels), so it's called only when the size moved.
  function size(map){
    const b = map.getContainer(); if(!b || !b.isConnected || !b.clientWidth || !b.clientHeight) return false;
    const s = map.getSize(); if(s.x === b.clientWidth && s.y === b.clientHeight) return false;
    map.invalidateSize(); return true;
  }
  function drop(slot){
    const e = slots.get(slot); if(!e) return;
    slots.delete(slot); remember(e.key, e.map);
    try{ e.map.remove(); }catch(err){ /* its container was already gone: nothing more to take down */ }
    if(e.gone) try{ e.gone(e.map); }catch(err){ console.error(err); }
  }
  function keep(key, el, create, opt = {}){
    if(typeof el === "string") el = document.getElementById(el);
    if(!el || typeof L === "undefined") return null;
    const slot = slotOf(key), cur = slots.get(slot);
    if(cur && cur.key === key){
      const box = cur.map.getContainer();
      if(box !== el){
        // the view's new placeholder: the kept map takes its place, with the placeholder's own size and look
        const css = el.getAttribute("style") || "";
        if(css !== (box._rfStyle ?? css)){ box.setAttribute("style", css); box._rfStyle = css; }
        el.replaceWith(box);
        if(getComputedStyle(box).position === "static") box.style.position = "relative";
        // taken out of the page and put back, its results viewer lost where its body was scrolled and the focus (a draft
        // being typed lost its letters to the page): both are put back (review 11/11)
        window.RFResults?.restore?.(box);
      }
      cur.tab = opt.tab ?? tabNow(); if(opt.gone) cur.gone = opt.gone;
      size(cur.map);
      return cur.map;
    }
    if(cur) drop(slot);
    el._rfStyle = el.getAttribute("style") || "";
    const map = create(el); if(!map) return null;
    RFMaps.made++;
    map._rfKey = key; map._rfNew = true; map._rfKept = views.get(key) || null;
    slots.set(slot, {key, map, tab: opt.tab ?? tabNow(), gone: opt.gone});
    // one watcher per map, for life: a container that changes size is sized again, nothing more (no fit)
    if(window.ResizeObserver){ const ro = new ResizeObserver(() => size(map)); ro.observe(map.getContainer()); map.on("unload", () => ro.disconnect()); }
    map.on("unload", () => { const e = slots.get(slot); if(e && e.map === map) slots.delete(slot); });
    return map;
  }
  // fit only when the map is new or what it shows has moved; a map made again for the same thing gets its kept view back
  function first(map, sig, fit){
    sig = String(sig ?? "");
    if(map._rfNew){ map._rfNew = false; const v = map._rfKept; map._rfSig = sig;
      if(v && v.sig === sig){ map.setView(v.center, v.zoom, {animate: false}); return false; }
      fit(); return true; }
    if(map._rfSig !== sig){ map._rfSig = sig; fit(); return true; }
    return false;
  }
  function sweep(tab = tabNow()){ for(const [slot, e] of [...slots]) if(e.tab !== tab) drop(slot); }
  // what a slot showed is gone for good (a mission deleted): its map goes and its kept view too, so a new one that gets the
  // same id (SQLite reuses a deleted row's id) starts fresh and is fitted, not shown where the old one was (review 11/11)
  function forget(key){ const slot = slotOf(key), e = slots.get(slot); if(e && e.key === key) drop(slot); views.delete(key); }
  // the map whose container is this element (or matches this selector), for the tests and for code that has only the element
  function at(el){ if(typeof el === "string") el = document.querySelector(el); for(const e of slots.values()) if(e.map.getContainer() === el) return e.map; return null; }
  const RFMaps = window.RFMaps = {made: 0, get live(){ return slots.size; }, keep, first, sweep, drop, forget, size, at,
    view: key => views.get(key) || null, get: slot => slots.get(slotOf(slot))?.map || null,
    list: () => [...slots].map(([slot, e]) => ({slot, key: e.key, tab: e.tab, onPage: !!e.map.getContainer()?.isConnected}))};
})();
/* RFResults: the results viewer (Cody 11/10). A click on a result shows it here, inside the map's frame, and the map stays
   where it is. RFResults.show(host, {key, title, sub, html | node | fill, tabs, tab, onTab, actions, zoom, onClose}, anchor):
     host: a Leaflet map, or a page element (Cell sites and Topology show their rows here without leaving their tab).
     key: what it shows; showing the same key again keeps the tab picked and where the body was scrolled.
     title, sub: HTML (escaped by the caller). html, node or fill(body): the body; or tabs [{id, label, html | node | fill}]
       with tab (the one shown) and onTab(id) when the caller draws each tab itself.
     actions: [{label, title, primary, run(button)}]. zoom: [lat, lon], bounds or points, or a function giving one: "Zoom to",
       the one thing here that moves the map. anchor: [lat, lon], where a Card sits beside.
   Layouts, picked in the viewer's header and kept in this browser (rfr.viewer) for every map: Automatic (a side panel when
   the map is 700 px wide or more, a bottom sheet under that), Side panel (360 px, Wider for 540), Bottom sheet (peek, half,
   full) or Card (beside the item, following it as the map moves, never panning it). The map's own controls move aside for a
   side panel or a sheet. It's a div in the map's frame but outside Leaflet's panes, so a map saved as an image (mapexport.js)
   leaves it out. Clicks, presses and the wheel stop at it; Esc closes it (RFKeys "results"), except while measuring or
   drawing. */
(function(){
  const LAYOUTS = [["auto", "Automatic"], ["side", "Side panel"], ["sheet", "Bottom sheet"], ["card", "Card"]];
  const PREF = "rfr.viewer", SHEET = {peek: "30%", half: "52%", full: "calc(100% - 64px)"}, NEXT = {open: "full", peek: "half", half: "full", full: "peek"};
  let pref = "auto";
  try{ const p = localStorage.getItem(PREF); if(LAYOUTS.some(l => l[0] === p)) pref = p; }catch(e){ /* storage blocked (a private window): Automatic */ }
  const open = new Set();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const tabNow = () => (typeof S === "object" && S && S.tab) || "";
  let styled = false;
  function css(){
    if(styled) return; styled = true;
    const st = document.createElement("style"); st.id = "rfResCss";
    st.textContent = `.rf-res{position:absolute;z-index:1001;display:flex;flex-direction:column;min-height:0;box-sizing:border-box;overflow:hidden;
  background:var(--g-strong,var(--panel,#fff));color:var(--ink,#111);border:1px solid var(--line,rgba(127,127,127,.35));border-radius:14px;
  box-shadow:var(--g-shadow,0 6px 24px rgba(0,0,0,.28));-webkit-backdrop-filter:var(--g-blur,none);backdrop-filter:var(--g-blur,none);
  font:13px/1.45 var(--font,system-ui,-apple-system,"Segoe UI",sans-serif);cursor:auto;text-align:left;outline:0}
.rf-res.rf-res-page{position:fixed;z-index:1003}
.rf-res[data-lay=side]{top:var(--rf-res-t,10px);right:10px;bottom:var(--rf-res-b,10px);width:min(360px,calc(100% - 200px))}
.rf-res[data-lay=side].wide{width:min(540px,calc(100% - 240px))}
.rf-res-page[data-lay=side]{top:auto;bottom:84px;right:12px;height:min(80vh,calc(100vh - 192px))}
.rf-res[data-lay=sheet]{left:6px;right:6px;bottom:var(--rf-res-b,6px);height:var(--rf-res-h,52%);max-height:calc(100% - var(--rf-res-b,6px) - var(--rf-res-t,6px));border-radius:18px 18px 12px 12px}
.rf-res-page[data-lay=sheet]{height:var(--rf-res-h,52vh);bottom:78px;max-height:calc(100% - 84px)}
.rf-res[data-lay=card]{width:min(320px,calc(100% - 20px));max-height:min(72%,460px)}
.rf-res-top{display:flex;flex-direction:column;flex:none;min-height:0}
.rf-res-grip{display:block;flex:none;position:relative;width:100%;height:16px;min-height:0!important;margin:0;padding:0!important;border:0!important;border-radius:0;background:transparent!important;cursor:pointer}
.rf-res-grip::before{content:"";position:absolute;left:50%;top:6px;width:46px;height:5px;margin-left:-23px;border-radius:3px;background:var(--line,#8888)}
.rf-res-hd{display:flex;align-items:flex-start;gap:8px;padding:9px 8px 4px 12px;flex:none}
.rf-res-hd [data-rx]{flex:none;padding:2px 9px;font-size:13px}
.rf-res-tt{flex:1;min-width:0}
.rf-res-t{font-weight:650;font-size:14px;line-height:1.3;overflow-wrap:anywhere}
.rf-res-s{color:var(--ink-2,var(--muted,#666));font-size:12px;margin-top:2px}
.rf-res-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 10px 6px 12px;flex:none}
.rf-res-tools select{max-width:150px}
.rf-res-tools button,.rf-res-tools select{padding:3px 8px;font-size:12px}
.rf-res-tabs,.rf-res-acts{display:flex;gap:4px;flex-wrap:wrap;padding:0 10px 6px;flex:none}
.rf-res-tabs button{padding:3px 10px;font-size:12px;border-radius:999px}
.rf-res-tabs button.on{background:var(--accent,#2f6fed);color:#fff;border-color:transparent}
.rf-res-acts button{padding:4px 10px;font-size:12px}
.rf-res-bd{flex:1;min-height:0;overflow:auto;padding:2px 12px 12px;overscroll-behavior:contain;touch-action:pan-x pan-y;outline:0}
.rf-res-bd .tw{max-width:100%}
.rf-res-on-side>.leaflet-control-container .leaflet-right{right:calc(var(--rf-res-w,360px) + 10px)}
.rf-res-on-sheet>.leaflet-control-container .leaflet-bottom{bottom:var(--rf-res-hpx,0px)}
.rf-res-on-sheet #mapReadout,.rf-res-on-sheet .leaflet-control-scale{display:none}
@media (pointer:coarse){.rf-res-tools button,.rf-res-tools select,.rf-res-tabs button,.rf-res-acts button,.rf-res-hd [data-rx]{min-height:38px}.rf-res-grip{height:24px}.rf-res-grip::before{top:9px}}`;
    (document.head || document.documentElement).appendChild(st);
  }
  // Esc closes the newest viewer (RFKeys "results"), but not while measuring or drawing on its map: Esc ends those first
  let keyed = false;
  const busy = v => !!(v.map && (v.map._rfMeasuring || v.map._rfDraw?._tool || v.map._rfPinArmed
    || v.box.querySelector(":scope > .rf-pinmenu:not([hidden])")));  // Esc ends those first, the Move pin here menu too (it sits over the viewer)
  const newest = () => [...open].reverse().find(v => v.el.isConnected && !busy(v));
  function keys(){
    if(keyed) return; keyed = true;
    if(window.RFKeys) RFKeys.scope("results", {active: () => !!newest(), keys: {escape: () => { const v = newest(); if(!v) return false; close(v, true); }}});
    // no RFKeys (the phone app): seen first, in the capture phase, so the ruler's own Esc hasn't ended measuring by then (one
    // Esc ended both: review 11/11); never while typing in a box or with a dialog open
    else document.addEventListener("keydown", e => { if(e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if(typing || document.querySelector("dialog[open]")) return; const v = newest(); if(v) close(v, true); }, true);
  }
  const boxOf = host => host && typeof host.getContainer === "function" ? host.getContainer() : host;
  // what floats over the map (map._rfResInset {top, bottom, tight}, or a function giving it: the phone app measures its
  // header, chips and bottom bar). When the band between is short (a phone on its side), the viewer covers the chips and
  // the search box instead (top: tight), as a sheet, or it was a side panel 120 px tall (review 11/11)
  function insetOf(v){
    let i = v.map?._rfResInset; if(typeof i === "function") try{ i = i(); }catch(e){ i = null; }
    i = i || {}; const H = v.box.clientHeight;
    return H && H - (i.top || 0) - (i.bottom || 0) < 260 ? {...i, top: i.tight ?? 0, short: true} : i;
  }
  const find = box => { for(const v of open) if(v.box === box) return v; return null; };
  // a side panel needs room beside it: a map under 480 px wide, or one short of height, gets a sheet (review 11/11)
  const layOf = v => { const p = v.page && pref === "card" ? "side" : pref, W = v.page ? innerWidth : v.box.clientWidth;
    if(!v.page && (p === "side" || p === "auto") && W < 480 || !v.page && p !== "sheet" && insetOf(v).short) return "sheet";
    if(p !== "auto") return p; return W >= 700 ? "side" : "sheet"; };
  function attach(v){
    const el = v.el;
    // mousemove stops here (the map's readout under it), except while the map is being dragged: Leaflet follows a drag on
    // the document, and the drag froze as the pointer crossed the viewer (review 11/11)
    if(window.L){ L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el);
      L.DomEvent.on(el, "mousemove", e => { if(!v.map?.dragging?._draggable?._moving) L.DomEvent.stopPropagation(e); }); }
    // a click whose button the click itself drew away (the viewer drew again inside its handler) never reaches the map:
    // Leaflet looks for the viewer from the button up, and a button already off the page has none (measure.js, 11/10)
    el.addEventListener("click", e => { if(!e.target.isConnected) e.stopPropagation(); });
    // the arrow keys move a map only while it has the focus: a press in the viewer takes the focus off the map, and puts it
    // on the body, which scrolls (on the outer box PageDown, Space and the arrows scrolled the page: review 11/11)
    el.addEventListener("mousedown", e => { if(e.target.closest?.("button,a,input,select,textarea,label,summary")) return;
      if(v.body && (document.activeElement === v.box || !el.contains(document.activeElement))) v.body.focus({preventScroll: true}); });
    // what has the focus and where the body is scrolled, for restore() after the map (and this with it) was moved
    el.addEventListener("focusin", e => { v.focus = e.target; });
    el.addEventListener("focusout", e => { if(e.relatedTarget && !el.contains(e.relatedTarget)) v.focus = null; });
    v.away = e => { if(!el.contains(e.target)) setTimeout(() => { if(!el.contains(document.activeElement)) v.focus = null; }, 0); };  // a touch scroll leaves it in the draft
    document.addEventListener("pointerdown", v.away, true);
    if(v.map){
      v.box.appendChild(el);
      v.follow = () => { if(el.dataset.lay === "card") place(v); };
      v.resized = () => { if(layOf(v) !== el.dataset.lay) frame(v); else layout(v); };  // the body stays as it is
      v.unload = () => forget(v);  // taken off again in forget(): a closed viewer was held by its map all session (review 11/11)
      v.map.on("move zoom viewreset", v.follow); v.map.on("resize", v.resized); v.map.on("unload", v.unload);
      // a card that grows after it's placed (an answer arriving) is placed again, or it ran past the map's bottom
      if(window.ResizeObserver){ v.ro = new ResizeObserver(() => { if(el.dataset.lay === "card") place(v); }); v.ro.observe(el); }
    } else { el.classList.add("rf-res-page"); document.body.appendChild(el); v.tab0 = tabNow(); }
  }
  function forget(v){
    open.delete(v); v.el.remove();
    if(v.map){ v.box.classList.remove("rf-res-on-side", "rf-res-on-sheet", "rf-res-over"); v.map.off("move zoom viewreset", v.follow); v.map.off("resize", v.resized); v.map.off("unload", v.unload); }
    if(v.ro) v.ro.disconnect();
    document.removeEventListener("pointerdown", v.away, true);
  }
  function close(v, asked){
    if(!v || !open.has(v)) return;
    forget(v);
    if(asked && v.o.onClose) try{ v.o.onClose(); }catch(e){ console.error(e); }
  }
  // a card sits beside its item, on the side with room, and follows it as the map moves: it never pans the map to fit
  function place(v){
    const el = v.el; if(el.dataset.lay !== "card") return;
    const W = v.box.clientWidth, H = v.box.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
    const inset = v.map ? insetOf(v) : {}, top = (inset.top || 0) + 10, bottom = H - (inset.bottom || 0) - h - 10;
    let x = W - w - 10, y = top;
    if(v.map && v.anchor){ try{ const p = v.map.latLngToContainerPoint(v.anchor); x = p.x + 18 + w <= W - 10 ? p.x + 18 : p.x - 18 - w; y = p.y - h / 2; }catch(e){ /* no view yet: the corner */ } }
    el.style.left = `${Math.round(Math.max(10, Math.min(x, W - w - 10)))}px`; el.style.top = `${Math.round(Math.max(top, Math.min(y, bottom)))}px`;
  }
  function layout(v){
    const el = v.el, lay = el.dataset.lay, inset = v.map ? insetOf(v) : {};
    if(lay !== "card"){ el.style.left = ""; el.style.top = ""; }
    // clear of what floats over the map (the phone app's header and bottom bar: map._rfResInset {top, bottom})
    el.style.setProperty("--rf-res-t", `${(inset.top || 0) + (lay === "sheet" ? 6 : 10)}px`); el.style.setProperty("--rf-res-b", `${(inset.bottom || 0) + (lay === "sheet" ? 6 : 10)}px`);
    if(lay === "sheet"){ let hh = SHEET[v.size];
      if(!hh){ const H = v.page ? innerHeight : v.box.clientHeight, band = H - (inset.top || 0) - (inset.bottom || 0) - 12, fr = v.top?.offsetHeight || 0;
        hh = `${Math.round(inset.short ? Math.min(band - 40, fr + 80) : Math.min(Math.max(H * 0.52, fr + 120), band * 0.55))}px`; }
      el.style.setProperty("--rf-res-h", hh); }
    if(v.map){
      // the map's own controls make room: the right-hand ones move left of a side panel, the bottom ones up over a sheet
      v.box.classList.toggle("rf-res-on-side", lay === "side"); v.box.classList.toggle("rf-res-on-sheet", lay === "sheet");
      if(lay === "side") v.box.style.setProperty("--rf-res-w", `${el.offsetWidth}px`);
      if(lay === "sheet") v.box.style.setProperty("--rf-res-hpx", `${Math.min(el.offsetHeight + (inset.bottom || 0) + 6, v.box.clientHeight - (inset.top || 0) - 50)}px`);
      v.box.classList.toggle("rf-res-over", lay === "sheet" && !!inset.short);
    }
    if(lay === "card") place(v);
  }
  // the frame: grip, header, tools, tabs and actions, drawn again on their own; the body (and what's typed or scrolled in it)
  // is left alone. The control that had the focus gets it back (a keyboard press on Wider or a tab lost it: review 11/11)
  function frame(v){
    const o = v.o, el = v.el, lay = layOf(v);
    el.dataset.lay = lay; el.classList.toggle("wide", !!v.wide);
    el.setAttribute("aria-label", (o.label || String(o.title || "Result").replace(/<[^>]*>/g, "")).slice(0, 120));
    const tabs = (o.tabs || []).filter(Boolean), had = v.top && v.top.contains(document.activeElement) ? document.activeElement : null;
    const again = had && ["rx", "rz", "rw", "rg", "rl", "rt", "ra"].map(k => had.dataset[k] != null ? `[data-${k}${k === "rt" || k === "ra" ? `="${CSS.escape(had.dataset[k])}"` : ""}]` : "").find(Boolean);
    if(!v.top){ el.innerHTML = '<div class="rf-res-top"></div><div class="rf-res-bd" tabindex="-1"></div>'; v.top = el.firstChild; v.body = el.lastChild;
      v.body.addEventListener("scroll", () => { v.scroll = v.body.scrollTop; }, {passive: true}); }
    v.top.innerHTML = `${lay === "sheet" ? `<button class="rf-res-grip" data-rg aria-label="Bigger or smaller (peek, half, full)" title="Bigger or smaller"></button>` : ""}
      <div class="rf-res-hd"><div class="rf-res-tt"><div class="rf-res-t">${o.title || ""}</div>${o.sub ? `<div class="rf-res-s">${o.sub}</div>` : ""}</div>
        <button data-rx aria-label="Close" title="Close (Esc)">✕</button></div>
      <div class="rf-res-tools">${o.zoom && v.map ? `<button data-rz title="Zoom the map to it (the only thing here that moves the map)">Zoom to</button>` : ""}${lay === "side" ? `<button data-rw aria-pressed="${!!v.wide}">${v.wide ? "Narrower" : "Wider"}</button>` : ""}
        <select data-rl aria-label="Where results show" title="Where results show: beside the map, under it or as a card. Kept in this browser for every map.">${LAYOUTS.map(([k, l]) => `<option value="${k}" ${pref === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      ${tabs.length > 1 ? `<div class="rf-res-tabs" role="tablist">${tabs.map(t => `<button role="tab" data-rt="${esc(t.id)}" class="${t.id === v.tab ? "on" : ""}" aria-selected="${t.id === v.tab}">${t.label}</button>`).join("")}</div>` : ""}
      ${(o.actions || []).length ? `<div class="rf-res-acts">${o.actions.map((a, i) => `<button data-ra="${i}" class="${a.primary ? "primary" : ""}" ${a.title ? `title="${esc(a.title)}"` : ""}>${a.label}</button>`).join("")}</div>` : ""}`;
    const on = (q, fn) => v.top.querySelectorAll(q).forEach(b => b.onclick = e => { e.stopPropagation(); e.preventDefault(); fn(b); });  // each button stops its own click (measure.js)
    on("[data-rx]", () => close(v, true));
    on("[data-rz]", () => zoomTo(v));
    on("[data-rw]", () => { v.wide = !v.wide; frame(v); });
    on("[data-rg]", () => { v.size = NEXT[v.size] || "half"; layout(v); });
    on("[data-rt]", b => { const id = b.dataset.rt; if(o.onTab) o.onTab(id, handle(v)); else { v.tab = id; paint(v); } });
    on("[data-ra]", b => { const a = o.actions[+b.dataset.ra]; if(a && a.run) a.run(b, handle(v)); });
    const sel = v.top.querySelector("[data-rl]"); if(sel) sel.onchange = () => setLayout(sel.value);
    layout(v);
    if(again) v.top.querySelector(again)?.focus({preventScroll: true});
  }
  // the frame and the body: the body is filled again from html, node or fill (a new item or tab, or the same one with new
  // content). keepScroll: the same item on the same tab keeps where it was scrolled, from what was tracked (reading it
  // after the map had been moved gave 0)
  function paint(v, keepScroll){
    frame(v);
    const o = v.o, tabs = (o.tabs || []).filter(Boolean), top = keepScroll ? v.scroll || 0 : 0;
    const t = tabs.find(x => x.id === v.tab), src = t && (t.fill || t.node || t.html != null) ? t : o;
    v.body.innerHTML = "";
    try{ if(src.fill) src.fill(v.body, handle(v)); else if(src.node) v.body.append(src.node); else v.body.innerHTML = src.html || ""; }
    catch(e){ v.body.innerHTML = `<p class="status err">${esc(e.message)}</p>`; console.error(e); }
    v.body.scrollTop = top; v.scroll = top;
    if(v.el.dataset.lay === "card") place(v);
  }
  // after RFMaps moved a kept map back into place: its viewer's scroll and focus as they were
  function restore(box){
    const v = find(box); if(!v || !v.body) return;
    if(v.scroll) v.body.scrollTop = v.scroll;
    const lost = !document.activeElement || document.activeElement === document.body;
    if(v.focus && lost && v.el.contains(v.focus)) v.focus.focus({preventScroll: true});
  }
  // "Zoom to": the item fills the part of the map the viewer leaves free
  function zoomTo(v){
    const m = v.map; if(!m || !m._loaded) return false;
    let z = typeof v.o.zoom === "function" ? v.o.zoom() : v.o.zoom; if(!z) return false;
    const pts = typeof z[0] === "number" ? [z, z] : z, b = L.latLngBounds(pts); if(!b.isValid()) return false;
    // the free part: below what floats at the top (the phone's header and chips: it landed under them) and above what floats
    // at the bottom, beside a side panel or above a sheet (review 11/11)
    const lay = v.el.dataset.lay, W = v.box.clientWidth, H = v.box.clientHeight, inset = insetOf(v), band = H - (inset.top || 0) - (inset.bottom || 0);
    if(lay === "sheet" && (v.size === "full" || v.el.offsetHeight > band * 0.6)){ v.size = "open"; layout(v); }  // a big sheet covered where it went
    const sh = lay === "sheet" ? v.el.offsetHeight + 6 : 0, pad = Math.max(4, Math.min(28, (band - sh - 20) / 2));
    const tl = [28, pad + (inset.top || 0)], br = [28, pad + (inset.bottom || 0) + sh];
    if(lay === "side") br[0] = Math.min(W - 120, 28 + v.el.offsetWidth + 10);
    const one = b.getNorthEast().equals(b.getSouthWest());
    m.fitBounds(b, {paddingTopLeft: tl, paddingBottomRight: br, maxZoom: one ? Math.max(m.getZoom(), v.o.zoomLevel || 16) : (v.o.maxZoom || 17)});
    return true;
  }
  function handle(v){
    return {el: v.el, get body(){ return v.body; }, get tab(){ return v.tab; }, key: v.o.key, map: v.map,
      close: () => close(v, true), zoomTo: () => zoomTo(v), set: o => show(v.map || v.box, {...v.o, ...o}, v.anchor),
      // new actions (or title) only: the body, and a draft typed in it, stay as they are
      setFrame: o => { v.o = {...v.o, ...o}; frame(v); }};
  }
  function show(host, o = {}, anchor){
    const box = boxOf(host); if(!box) return null;
    css(); keys();
    let v = find(box);
    // a sheet opens at its opening size (layout): half, with room for the frame and some of the body
    if(!v){ const el = document.createElement("div"); el.className = "rf-res"; el.tabIndex = -1; el.setAttribute("role", "region");
      v = {map: typeof host.getContainer === "function" ? host : null, box, el, size: "open", wide: false}; v.page = !v.map; open.add(v); attach(v); }
    const same = !!v.o && v.o.key === o.key, tab0 = v.tab;
    v.o = o; v.anchor = anchor ?? o.anchor ?? null;
    if(!same || o.tab != null) v.tab = o.tab ?? (o.tabs || []).filter(Boolean)[0]?.id ?? null;
    paint(v, same && v.tab === tab0);
    return handle(v);
  }
  function setLayout(p){
    pref = LAYOUTS.some(l => l[0] === p) ? p : "auto";
    try{ localStorage.setItem(PREF, pref); }catch(e){ /* storage blocked: for this page only */ }
    for(const v of open) frame(v);  // the look only: the body stays as it is
  }
  // a viewer on a page (Cell sites, Topology) goes when its tab does; a map's goes with its map
  function sweep(tab = tabNow()){ for(const v of [...open]) if(v.page && v.tab0 !== tab) close(v, false); }
  window.RFResults = {show, sweep, setLayout, restore, LAYOUTS,
    close: (host, asked = true) => { const box = boxOf(host); for(const v of [...open]) if(!host || v.box === box) close(v, asked); },
    get: host => { const v = find(boxOf(host)); return v ? handle(v) : null; },
    get layout(){ return pref; }, layoutOf: host => { const v = find(boxOf(host)); return v ? v.el.dataset.lay : null; },
    get open(){ return open.size; }};
})();
