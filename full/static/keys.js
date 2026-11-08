"use strict";
/* DAStastic — keyboard shortcuts. One document listener for the whole app; each part registers a scope that says when
   it's on screen and which keys it takes:
     RFKeys.scope("walls", {active: () => bool, keys: {"w": fn, "shift+s": fn, "ctrl+z": fn, "escape": fn}})
   The newest active scope that has the key wins; a handler that returns false passes the key on. Keys are left alone
   while typing (inputs, text areas, lists, contentEditable) and while a dialog is open. Keys taken elsewhere stay
   theirs: N (Notes), ? and F1 (Help), Ctrl/Cmd+K (Search), and the browser's Ctrl+S/P/F/W.
   Also: Shift held (RFKeys.shift(), RFKeys.onShift(fn); reset when the window loses focus), RFKeys.cycle(select, +1/-1)
   to step a list the way a repeated key should, RFKeys.legend([[keys, what], ...]) for a <kbd> strip, and app-wide
   [ / ] for the previous / next floor wherever a floor list is on screen. */
(() => {
const scopes = [];
let shiftDown = false;
const shiftFns = new Set();
const setShift = v => { if (v === shiftDown) return; shiftDown = v; for (const f of shiftFns) { try { f(v); } catch (e) { console.error(e); } } };
// true while the person is typing somewhere: keys then belong to the field (help.js and notes.js ask this too)
function typing(el = document.activeElement) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const t = el.tagName;
  if (t === "TEXTAREA" || t === "SELECT") return true;
  if (t === "INPUT") return !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(el.type || "");
  return false;
}
const combo = e => {  // a keydown with no key (Chrome's autofill sends one) has no combo
  if (typeof e.key !== "string" || !e.key) return "";
  let k = e.key; if (k === " ") k = "space"; k = k.length === 1 ? k.toLowerCase() : k.toLowerCase();
  return [(e.ctrlKey || e.metaKey) && "ctrl", e.altKey && "alt", e.shiftKey && k !== "shift" && "shift", k].filter(Boolean).join("+");
};
function scope(id, def) {
  const i = scopes.findIndex(s => s.id === id); const s = {id, ...def};
  if (i >= 0) scopes[i] = s; else scopes.push(s);
  return s;
}
// step a list by d (wrapping), as the change event a person's pick would send
function cycle(sel, d = 1) {
  if (!sel || sel.disabled || !sel.options.length) return null;
  const n = sel.options.length; sel.selectedIndex = ((sel.selectedIndex < 0 ? 0 : sel.selectedIndex) + d + n) % n;
  sel.dispatchEvent(new Event("change", {bubbles: true}));
  return sel.value;
}
const visible = el => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
// a strip of <kbd> keys and what they do: [["W", "wall"], ["Shift+S", "smart snip"], ["1-9", "wall type"]]
const kbd = k => String(k).split("+").map(p => `<kbd>${p.replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]))}</kbd>`).join("+");
function legend(items, cls = "") {
  return `<div class="rfk-legend ${cls}" role="note" aria-label="Keyboard shortcuts">${items.map(([k, what]) => `<span>${kbd(k)} ${what}</span>`).join("")}</div>`;
}
function style() {
  if (document.getElementById("rfkStyle")) return;
  const s = document.createElement("style"); s.id = "rfkStyle";
  s.textContent = `.rfk-legend{display:flex;flex-wrap:wrap;gap:3px 12px;margin:4px 0 8px;font-size:12px;color:var(--muted,#888);line-height:1.6}
.rfk-legend span{white-space:nowrap}
kbd{display:inline-block;min-width:1.4em;padding:0 4px;font:600 11px/1.5 ui-monospace,Consolas,monospace;text-align:center;color:inherit;
  border:1px solid var(--line,#8886);border-bottom-width:2px;border-radius:4px;background:var(--panel,transparent)}
@media (pointer:coarse){.rfk-legend{display:none}}`;
  document.head.appendChild(s);
}

document.addEventListener("keydown", e => {
  if (e.key === "Shift") { if (!e.repeat) setShift(true); return; }
  if (e.defaultPrevented || e.isComposing) return;
  if (typing() || document.querySelector("dialog[open]")) return;
  const c = combo(e);
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i], fn = s.keys && s.keys[c];
    if (!fn) continue;
    let on = false; try { on = s.active ? !!s.active() : true; } catch (err) { on = false; }
    if (!on) continue;
    if (fn(e) === false) continue;
    e.preventDefault();
    return;
  }
});
document.addEventListener("keyup", e => { if (e.key === "Shift") setShift(false); });
window.addEventListener("blur", () => setShift(false));
document.addEventListener("visibilitychange", () => { if (document.hidden) setShift(false); });
// a pointer event knows Shift for certain: keep the flag honest when the window got focus with Shift already held
document.addEventListener("pointerdown", e => setShift(!!e.shiftKey), true);

// [ / ]: the previous / next floor wherever a floor list is on screen (Design, Grid test, Screening)
const FLOOR_LISTS = ["#dfF", "#dgF", "#scF", "select[data-floorpick]"];
scope("floors", {active: () => FLOOR_LISTS.some(q => visible(document.querySelector(q))),
  keys: {"[": () => cycle(FLOOR_LISTS.map(q => document.querySelector(q)).find(visible), -1),
    "]": () => cycle(FLOOR_LISTS.map(q => document.querySelector(q)).find(visible), 1)}});

window.RFKeys = {scope, typing, cycle, legend, kbd, style, visible, shift: () => shiftDown, onShift: fn => { shiftFns.add(fn); return () => shiftFns.delete(fn); }};
if (document.head) style(); else document.addEventListener("DOMContentLoaded", style);
})();
