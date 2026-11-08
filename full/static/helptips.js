"use strict";
/* DAStastic: the small "?" buttons and their windows (Cody 11/8, items 2 and 10). The texts are static/research/help_tips.json:
   one per feature guide, and extra ones marked "extra" for Cody to pick from (docs/guides/tips-preview.html shows every window).
   Only the tips marked "on": true get a "?" in the app: the eight guides Cody named. An extra goes live when he sets "on" on it.
   index.html loads this file with data-wire: wire() reads the texts and keeps each "on" tip's "?" beside its anchor (a CSS
   selector in the tip; "place" says after it or inside it at its end). The tabs redraw their own HTML, so a watch on the page
   puts a "?" back whenever its anchor is drawn again. No "?" goes in the header or the tab bar.
   By hand: RFHelpTips.button(id) makes one, RFHelpTips.attach() adds one to every [data-tip] element.
   The window: role="dialog", named by its title; the "?" says whether it's open (aria-expanded). It opens beside the "?" on a
   wide screen and as a sheet from the bottom on a phone (600 px and under), where the "?" is 32 px to tap. Escape, the ✕, or a
   press outside it closes it, and the focus goes back to the "?". Tab stays inside the window while it's open. "All help"
   opens the Help window (help.js) on that guide in its Guides section, or on the tab's own section for an extra. Needs
   nothing else: no core.js, no theme (it reads the theme's colours when they're there). The web version (full/) loads the
   same file and the same texts. */
window.RFHelpTips = (() => {
  let TIPS = new Map(), pop = null, from = null, uid = 0;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const phone = () => matchMedia("(max-width: 600px)").matches;
  const HELP_OF = { Start: "start", Map: "map", Search: "find", "Area report": "report", Analyzer: "analyzer", Dashboard: "dashboard", Topology: "topology",
    "Site profile": "profile", Agencies: "agencies", Spectrum: "spectrum", "Cell sites": "cells", Mission: "mission", "Data & updates": "data" };

  function css() {
    if (document.getElementById("htCss")) return;
    const s = document.createElement("style"); s.id = "htCss";
    s.textContent = `
.ht-q{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;min-width:22px;min-height:22px;margin:0 0 0 6px;padding:0;
  border-radius:50%;border:1px solid var(--line,#c9c3ba);background:var(--chip,var(--wash,#f3efe9));color:var(--ink,#1f1b17);font:700 12px/1 system-ui,sans-serif;
  cursor:pointer;vertical-align:middle}
.ht-q:hover,.ht-q[aria-expanded=true]{background:var(--accent,#2a6fdb);color:var(--on-accent,#fff);border-color:var(--accent,#2a6fdb)}
.ht-q:focus-visible{outline:2px solid var(--accent,#2a6fdb);outline-offset:2px}
@media (pointer:coarse),(max-width:600px){.ht-q{width:32px;height:32px;min-width:32px;min-height:32px;font-size:14px}}
@media print{.ht-q{display:none!important}}
.ht-pop{position:fixed;z-index:4000;width:min(360px,calc(100vw - 24px));max-height:min(70vh,560px);overflow:auto;box-sizing:border-box;
  padding:14px 16px 12px;border-radius:14px;border:1px solid var(--g-border,var(--line,#d8d2c8));background:var(--surface,var(--panel,#fffdf9));
  color:var(--ink,#1f1b17);box-shadow:0 14px 40px rgba(0,0,0,.28);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.ht-pop:focus{outline:none}
.ht-pop h4{margin:0 30px 6px 0;font-size:15px;line-height:1.3}
.ht-pop p{margin:0 0 8px}
.ht-pop ol{margin:0 0 8px;padding-left:20px}.ht-pop li{margin:2px 0}
.ht-pop .ht-if{margin:0 0 8px;padding:8px 10px;border-radius:10px;background:var(--wash,rgba(127,127,127,.08))}
.ht-pop .ht-if div{margin:2px 0}.ht-pop .ht-if b{font-weight:600}
.ht-pop .ht-more{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--muted,var(--ink-2,#6b645b))}
.ht-pop .ht-x{position:absolute;top:8px;right:8px;width:30px;height:30px;min-width:30px;min-height:30px;padding:0;border-radius:50%;border:0;
  background:transparent;color:inherit;font-size:16px;cursor:pointer}
.ht-pop .ht-x:hover{background:var(--wash,rgba(127,127,127,.12))}
.ht-pop .ht-all{flex:none;white-space:nowrap;border:1px solid var(--line,#c9c3ba);background:transparent;color:inherit;border-radius:999px;padding:4px 10px;font:inherit;cursor:pointer}
.ht-pop.ht-sheet{left:0!important;right:0;top:auto!important;bottom:0;width:100%;max-height:72vh;border-radius:18px 18px 0 0;
  padding:18px 18px calc(14px + env(safe-area-inset-bottom))}
.ht-pop.ht-sheet .ht-x,.ht-pop.ht-sheet .ht-all{min-width:44px;min-height:44px}
@media (prefers-reduced-motion:no-preference){.ht-pop{animation:htIn .16s ease-out}.ht-pop.ht-sheet{animation:htUp .2s ease-out}}
@keyframes htIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes htUp{from{transform:translateY(24px);opacity:.6}to{transform:none;opacity:1}}`;
    document.head.appendChild(s);
  }

  /* ---------- the texts ---------- */
  async function load(src = "static/research/help_tips.json") {
    const d = typeof src === "string" ? await (await fetch(src, { cache: "no-cache" })).json() : src;
    use(d); return TIPS;
  }
  function use(d) { TIPS = new Map(((d && d.tips) || []).map(t => [t.id, t])); }
  const get = id => TIPS.get(id);

  /* ---------- the window ---------- */
  function html(t, titleId) {
    const ifs = (t.if_you_see || []).map(x => `<div>If you see <b>${esc(x.see)}</b>: ${esc(x.check)}</div>`).join("");
    const help = typeof window.openHelp === "function" && helpOf(t);
    return `<button type="button" class="ht-x" aria-label="Close">✕</button>
      <h4 id="${titleId}">${esc(t.title)}</h4>
      <p>${esc(t.short)}</p>
      ${(t.steps || []).length ? `<ol>${t.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
      ${ifs ? `<div class="ht-if">${ifs}</div>` : ""}
      <div class="ht-more"><span>${esc(t.more || "")}</span>${help ? `<button type="button" class="ht-all" data-help-go="${esc(help)}">All help</button>` : ""}</div>`;
  }
  // a guide's tip opens its own entry in Help's Guides section; an extra opens its tab's section
  const helpOf = t => t.extra ? HELP_OF[t.tab] : `guide-${t.id}`;
  function place() {
    if (!pop || !from || !from.isConnected) return;  // the tab redrew under it: the window stays where it is
    const sheet = phone();
    pop.classList.toggle("ht-sheet", sheet);
    if (sheet) { pop.style.left = ""; pop.style.top = ""; return; }
    const r = from.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, gap = 8, vw = innerWidth, vh = innerHeight;
    let left = Math.min(Math.max(12, r.left + r.width / 2 - 24), vw - w - 12);
    let top = r.bottom + gap;
    if (top + h > vh - 12 && r.top - gap - h >= 12) top = r.top - gap - h;  // no room below: above it
    top = Math.max(12, Math.min(top, vh - h - 12));
    pop.style.left = `${Math.round(left)}px`; pop.style.top = `${Math.round(top)}px`;
  }
  const focusables = () => [...pop.querySelectorAll("button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(e => !e.disabled);
  function onKey(e) {
    if (!pop) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(true); return; }
    if (e.key === "Tab") {  // the focus stays in the window while it's open
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function onDown(e) {  // a press outside the window closes it; a press on its own "?" is that button's toggle
    if (!pop || pop.contains(e.target) || (from && from.contains(e.target))) return;
    hide(false);
  }
  function show(id, btn) {
    const t = get(id); if (!t) return null;
    hide(false); css();
    const titleId = `htTitle${++uid}`;
    pop = document.createElement("div");
    pop.className = "ht-pop"; pop.id = `htPop${uid}`;
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-modal", "false"); pop.setAttribute("aria-labelledby", titleId); pop.tabIndex = -1;
    pop.dataset.tip = id;
    pop.innerHTML = html(t, titleId);
    document.body.appendChild(pop);
    from = btn || null;
    if (from) { from.setAttribute("aria-expanded", "true"); from.setAttribute("aria-controls", pop.id); }
    pop.querySelector(".ht-x").onclick = () => hide(true);
    const all = pop.querySelector("[data-help-go]");
    if (all) all.onclick = () => { const s = all.dataset.helpGo; hide(false); window.openHelp(s);
      const sec = document.getElementById(`help-${s}`); if (sec && sec.tagName === "DETAILS") sec.open = true; };
    place();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    addEventListener("resize", place); addEventListener("scroll", place, true);
    pop.querySelector(".ht-x").focus({ preventScroll: true });
    return pop;
  }
  function hide(back) {
    if (!pop) return;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    removeEventListener("resize", place); removeEventListener("scroll", place, true);
    const id = pop.dataset.tip;
    pop.remove(); pop = null;
    if (from) { from.setAttribute("aria-expanded", "false"); from.removeAttribute("aria-controls");
      // the tab redrew while it was open: the focus goes to the "?" drawn in its place
      const to = from.isConnected ? from : document.querySelector(`.ht-q[data-tip-for="${id}"]`);
      if (back && to) to.focus({ preventScroll: true }); }
    from = null;
  }

  /* ---------- the "?" ---------- */
  function button(id) {
    css();
    const t = get(id), b = document.createElement("button");
    b.type = "button"; b.className = "ht-q no-print"; b.textContent = "?"; b.dataset.tipFor = id;
    b.setAttribute("aria-label", `What is this: ${t ? t.title : id}`); b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false");
    b.title = t ? t.title : "";
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); if (pop && from === b) hide(true); else show(id, b); };
    return b;
  }
  // a "?" for every [data-tip] element under root (once each): inside a heading or label, at its end; beside a control
  function attach(root = document) {
    for (const el of root.querySelectorAll("[data-tip]")) {
      if (el.dataset.tipDone || !get(el.dataset.tip)) continue;
      el.dataset.tipDone = "1";
      const b = button(el.dataset.tip);
      if (el.matches("button, input, select, textarea, a")) el.insertAdjacentElement("afterend", b); else el.appendChild(b);
    }
  }

  /* ---------- in the app: each "on" tip's "?" beside its anchor, put back whenever a tab redraws ---------- */
  let wired = false, queued = false;
  const CONTROL = "button, input, select, textarea, a, .seg";
  const hasQ = (el, id, inside) => inside ? [...el.children].some(c => c.matches(`.ht-q[data-tip-for="${id}"]`))
    : !!(el.nextElementSibling && el.nextElementSibling.matches(`.ht-q[data-tip-for="${id}"]`));
  function scan() {
    queued = false;
    for (const t of TIPS.values()) {
      if (!t.on || !t.anchor) continue;
      let els; try { els = document.querySelectorAll(t.anchor); } catch (e) { continue; }  // a bad selector in the texts: that tip only
      for (const el of els) {
        if (el.closest("header, #tabs")) continue;  // never in the top bar or the tab bar: they'd crowd
        const inside = t.place ? t.place === "inside" : !el.matches(CONTROL);
        if (hasQ(el, t.id, inside)) continue;
        const b = button(t.id);
        if (inside) el.appendChild(b); else el.insertAdjacentElement("afterend", b);
      }
    }
  }
  async function wire(src) {
    if (wired) return; wired = true;
    try { await load(src); } catch (e) { return; }  // no texts (no signal on a first visit): the app works as before, with no "?"
    css(); scan();
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(scan); } }).observe(document.body, { childList: true, subtree: true });
  }
  const list = () => [...TIPS.values()];
  const api = { load, use, get, list, button, attach, wire, show, hide, isOpen: () => !!pop, ready: () => TIPS.size > 0 };
  // index.html loads this with data-wire: the app's "?" buttons
  const me = document.currentScript;
  if (me && me.hasAttribute("data-wire")) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => wire()); else wire(); }
  return api;
})();
