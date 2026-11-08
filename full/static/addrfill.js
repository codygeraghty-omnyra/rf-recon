"use strict";
/* DAStastic — address completion on every address box (Cody 11/4: "make sure the address bar finishes the address for
   you"). Type three letters or more and the full address comes up underneath: street, city, state and ZIP (Photon /
   OpenStreetMap, the same lookup as the Pin box; towns and counties from the FCC data work with no signal). A house number
   and street are enough, misspelled or not: the Census knows the rest, nearby states at once and every state if you pause
   (Cody 11/6: "like google maps"). ↑ / ↓ move, Enter or a click takes it, Esc closes. Enter and Tab take what you moved to
   with the arrows or, in a job's address box, the one address that carries the number you typed: the same door, spelled
   properly. Otherwise a typed address is never swapped out from under you.
   Boxes: a DAS job's Address, the firm's mailing address, Prospects' Where, and any input marked data-addr. The Pin box
   on the map has its own (search.js). A taken suggestion fires an "rf-addr" event with {label, full, lat, lon, kind} for
   pages that want the coordinates too, then input and change (so the page saves it as if typed, coordinates included). */
(function addrFill() {
  const SEL = 'input[data-k="address"], input[data-pf="address"], input[data-addr], #prWhere';
  const st = { el: null, items: [], active: -1, auto: -1, timer: null, wide: null, widening: false, seq: 0, box: null, moved: false };
  const box = () => st.box || (st.box = Object.assign(document.createElement("div"), { id: "addrSuggest", role: "listbox" }));
  const close = () => { const b = st.box; clearTimeout(st.wide); st.widening = false; if (b) { b.hidden = true; b.innerHTML = ""; } st.items = []; st.active = -1; st.auto = -1; st.moved = false; };
  const place = () => { const b = box(), r = st.el.getBoundingClientRect(), vw = document.documentElement.clientWidth || innerWidth;
    const w = Math.min(Math.max(r.width, 380), vw - 8), left = Math.max(4, Math.min(r.left, vw - 4 - w));  // never past either edge
    Object.assign(b.style, { position: "fixed", left: `${left}px`, top: `${r.bottom + 4}px`, width: `${w}px`, boxSizing: "border-box", zIndex: 9999,
      background: "var(--panel, #fff)", border: "1px solid var(--line, #ccc)", borderRadius: "10px", padding: "4px",
      boxShadow: "0 10px 30px -12px rgba(0,0,0,.35)", maxHeight: "50vh", overflow: "auto" });
    if (!b.isConnected) document.body.append(b); };
  const text = r => r.full || r.label;
  const chosen = () => st.moved && st.active >= 0 ? st.active : st.auto;  // what you moved to, else the one address that carries your number
  const numberOf = q => (q.match(/^\d+[a-z]?(?=\s)/i) || [""])[0].toLowerCase();
  const hasNo = (r, no) => !!no && text(r).toLowerCase().startsWith(no + " ");
  // nearby is where the map is, or else the last address picked: a fresh sign-in has no map position yet
  const lastPick = () => { try { return JSON.parse(localStorage.getItem("rfr.addrNear") || "null"); } catch (e) { return null; } };
  // S is a const in core.js, so it isn't on window: window.S here silently sent no position at all until 11/6
  const near = () => { const c = (typeof S !== "undefined" && S.center) || lastPick(); return c ? `&lat=${c[0]}&lon=${c[1]}` : ""; };
  // the house number typed first, then other street addresses, then places, then towns. A house number has a space after it: "36th Street
  // West" is a street, and a bus stop on it came first for "3440 Beltline Blvd" (11/5)
  const order = (rows, no) => { const rank = x => x.kind !== "address" ? 3 : hasNo(x, no) ? (x.source === "census" ? 0 : 1) : /^\d+\s/.test(text(x)) ? 2 : 3; return rows.slice().sort((a, b) => rank(a) - rank(b)); };
  // the one address with the typed number, in a job's address box: Enter or Tab finishes it. Two with that number are two buildings: it's yours to pick
  // the arrows still start from the top: this only offers it to Enter and Tab
  const settle = no => { const same = st.items.filter(x => hasNo(x, no)); st.active = -1; st.moved = false; st.auto = -1;
    if (same.length === 1 && st.el?.matches('[data-k="address"], [data-addr]')) st.auto = st.items.indexOf(same[0]); };
  function paint(online, looking) {
    if (!st.el) return; const b = box(); place();
    if (!st.items.length) { b.innerHTML = `<div class="hint" style="padding:6px 8px">${looking || st.widening ? (st.widening ? "Looking in every state…" : "Looking up the address…") : online === false ? "The address lookup isn't answering. Towns and counties still work." : "No address matches yet: keep typing."}</div>`; b.hidden = false; return; }
    b.innerHTML = st.items.map((r, i) => `<div class="item" role="option" data-i="${i}" aria-selected="${i === chosen()}" style="cursor:pointer;padding:8px;border-radius:8px;min-height:32px;${i === chosen() ? "background:var(--sel, rgba(0,0,0,.06))" : ""}">
      <span class="t">${esc(text(r))}</span> <span class="hint">${esc(r.sub || "")}</span></div>`).join("") + (st.widening ? `<div class="hint" style="padding:6px 8px">Looking in every state…</div>` : "");
    b.hidden = false;
    b.querySelectorAll("[data-i]").forEach(d => d.onmousedown = e => { e.preventDefault(); take(st.items[+d.dataset.i]); });
  }
  async function lookup(q) {
    const seq = ++st.seq, no = numberOf(q); clearTimeout(st.wide); st.widening = false;
    if (!st.items.length) paint(null, true);  // an empty box while it looks reads as broken: the lookup can take seconds
    try {
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}${near()}`);
      if (!st.el) return;
      // still typing: an answer to the first part beats an empty list, as long as it's the newest there is and the box still starts with it
      const now = st.el.value.trim(), current = seq === st.seq && now === q, early = !current && !st.items.length && now.toLowerCase().startsWith(q.toLowerCase());
      if (!current && !early) return;
      st.items = order(r.results || [], no); settle(no);
      // nothing the Census knows with that number nearby: a pause asks every state. Photon's one house across the country doesn't count
      if (current && no && q.length >= 6 && !/\b\d{5}\b/.test(q) && !st.items.some(x => hasNo(x, no) && x.source === "census")) {
        st.widening = true;
        st.wide = setTimeout(() => wider(q, seq, no, r.online), 700);
      }
      paint(r.online);
    } catch (e) { if (seq === st.seq) close(); }
  }
  async function wider(q, seq, no, online) {
    try {
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}${near()}&wide=1`);
      if (seq !== st.seq || !st.el || st.el.value.trim() !== q) return;
      const seen = new Set(st.items.map(text));
      st.items = order([...st.items, ...(r.results || []).filter(x => !seen.has(text(x)))], no); settle(no);
    } catch (e) { /* what's on the list stays */ }
    if (seq === st.seq) { st.widening = false; paint(online); }
  }
  function take(r) {
    const el = st.el; close(); if (!el || !r) return;
    el.value = text(r);
    if (r.lat != null) try { localStorage.setItem("rfr.addrNear", JSON.stringify([r.lat, r.lon])); } catch (e) { /* storage blocked: the map's position still works */ }
    el.dispatchEvent(new CustomEvent("rf-addr", { bubbles: true, detail: { label: r.label, full: text(r), lat: r.lat, lon: r.lon, kind: r.kind } }));
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  document.addEventListener("input", e => {
    const el = e.target; if (!(el instanceof HTMLInputElement) || !el.matches(SEL) || !e.isTrusted && !el.dataset.addrTest) return;
    st.el = el; const q = el.value.trim(); clearTimeout(st.timer);
    if (q.length < 3 || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(q) || /^https?:/i.test(q)) { close(); return; }
    st.timer = setTimeout(() => lookup(q), 200);
  });
  document.addEventListener("keydown", e => {
    if (!st.el || e.target !== st.el || !st.box || st.box.hidden || !st.items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); st.moved = true;
      st.active = (st.active + (e.key === "ArrowDown" ? 1 : -1) + st.items.length + (st.active < 0 && e.key === "ArrowUp" ? 1 : 0)) % st.items.length; paint(); }
    else if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "Enter" && chosen() >= 0) { e.preventDefault(); e.stopPropagation(); take(st.items[chosen()]); }
    else if (e.key === "Tab" && chosen() >= 0) take(st.items[chosen()]);
  }, true);
  document.addEventListener("focusout", e => { if (e.target === st.el) setTimeout(close, 150); });
  addEventListener("scroll", () => { if (st.box && !st.box.hidden && st.el) place(); }, true);
  addEventListener("resize", () => { if (st.box && !st.box.hidden && st.el) place(); });
})();
