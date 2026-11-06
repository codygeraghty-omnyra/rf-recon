"use strict";
/* RF Recon — address completion on every address box (Cody 11/4: "make sure the address bar finishes the address for
   you"). Type three letters or more and the full address comes up underneath: street, city, state and ZIP (Photon /
   OpenStreetMap, the same lookup as the Pin box; towns and counties from the FCC data work with no signal). ↑ / ↓ move,
   Enter or a click takes it, Esc closes. Enter only takes a suggestion you moved to with the arrows, so a typed address
   is never swapped out from under you.
   Boxes: a DAS job's Address, the firm's mailing address, Prospects' Where, and any input marked data-addr. The Pin box
   on the map has its own (search.js). A taken suggestion fires an "rf-addr" event with {label, full, lat, lon, kind} for
   pages that want the coordinates too, then input and change (so the page saves it as if typed, coordinates included). */
(function addrFill() {
  const SEL = 'input[data-k="address"], input[data-pf="address"], input[data-addr], #prWhere';
  const st = { el: null, items: [], active: -1, timer: null, seq: 0, box: null, moved: false };
  const box = () => st.box || (st.box = Object.assign(document.createElement("div"), { id: "addrSuggest", role: "listbox" }));
  const close = () => { const b = st.box; if (b) { b.hidden = true; b.innerHTML = ""; } st.items = []; st.active = -1; st.moved = false; };
  const place = () => { const b = box(), r = st.el.getBoundingClientRect(), vw = document.documentElement.clientWidth || innerWidth;
    const w = Math.min(Math.max(r.width, 380), vw - 8), left = Math.max(4, Math.min(r.left, vw - 4 - w));  // never past either edge
    Object.assign(b.style, { position: "fixed", left: `${left}px`, top: `${r.bottom + 4}px`, width: `${w}px`, boxSizing: "border-box", zIndex: 9999,
      background: "var(--panel, #fff)", border: "1px solid var(--line, #ccc)", borderRadius: "10px", padding: "4px",
      boxShadow: "0 10px 30px -12px rgba(0,0,0,.35)", maxHeight: "50vh", overflow: "auto" });
    if (!b.isConnected) document.body.append(b); };
  const text = r => r.full || r.label;
  function paint(online) {
    if (!st.el) return; const b = box(); place();
    if (!st.items.length) { b.innerHTML = `<div class="hint" style="padding:6px 8px">${online === false ? "The address lookup isn't answering. Towns and counties still work." : "No address matches yet: keep typing."}</div>`; b.hidden = false; return; }
    b.innerHTML = st.items.map((r, i) => `<div class="item" role="option" data-i="${i}" aria-selected="${i === st.active}" style="cursor:pointer;padding:8px;border-radius:8px;min-height:32px;${i === st.active ? "background:var(--sel, rgba(0,0,0,.06))" : ""}">
      <span class="t">${esc(text(r))}</span> <span class="hint">${esc(r.sub || "")}</span></div>`).join("");
    b.hidden = false;
    b.querySelectorAll("[data-i]").forEach(d => d.onmousedown = e => { e.preventDefault(); take(st.items[+d.dataset.i]); });
  }
  async function lookup(q) {
    const seq = ++st.seq, near = window.S && S.center ? `&lat=${S.center[0]}&lon=${S.center[1]}` : "";
    try {
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}${near}`);
      if (seq !== st.seq || !st.el || st.el.value.trim() !== q) return;
      // the house number typed first, then other street addresses, then places, then towns. A house number has a space after
      // it: "36th Street West" is a street, and a bus stop on it came first for "3440 Beltline Blvd" (11/5)
      const no = (q.match(/^\d+/) || [""])[0], rank = x => x.kind !== "address" ? 2 : no && text(x).startsWith(no + " ") ? 0 : /^\d+\s/.test(text(x)) ? 1 : 2;
      st.items = (r.results || []).slice().sort((a, b) => rank(a) - rank(b));
      st.active = -1; st.moved = false; paint(r.online);
    } catch (e) { close(); }
  }
  function take(r) {
    const el = st.el; close(); if (!el || !r) return;
    el.value = text(r);
    el.dispatchEvent(new CustomEvent("rf-addr", { bubbles: true, detail: { label: r.label, full: text(r), lat: r.lat, lon: r.lon, kind: r.kind } }));
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.addEventListener("input", e => {
    const el = e.target; if (!(el instanceof HTMLInputElement) || !el.matches(SEL) || !e.isTrusted && !el.dataset.addrTest) return;
    st.el = el; const q = el.value.trim(); clearTimeout(st.timer);
    if (q.length < 3 || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(q) || /^https?:/i.test(q)) { close(); return; }
    st.timer = setTimeout(() => lookup(q), 250);
  });
  document.addEventListener("keydown", e => {
    if (!st.el || e.target !== st.el || !st.box || st.box.hidden || !st.items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); st.moved = true;
      st.active = (st.active + (e.key === "ArrowDown" ? 1 : -1) + st.items.length + (st.active < 0 && e.key === "ArrowUp" ? 1 : 0)) % st.items.length; paint(); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "Enter" && st.moved && st.active >= 0) { e.preventDefault(); e.stopPropagation(); take(st.items[st.active]); }
    else if (e.key === "Tab" && st.moved && st.active >= 0) take(st.items[st.active]);
  }, true);
  document.addEventListener("focusout", e => { if (e.target === st.el) setTimeout(close, 150); });
  addEventListener("scroll", () => { if (st.box && !st.box.hidden && st.el) place(); }, true);
  addEventListener("resize", () => { if (st.box && !st.box.hidden && st.el) place(); });
})();
