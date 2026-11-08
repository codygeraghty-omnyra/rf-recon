"use strict";
/* DAStastic — lists of checkboxes (Cody 11/4): one All / None box on each list (a dash when only some are ticked), the
   count beside it ("3 of 12 done"), and long lists that fold like the map's filters: folded at first, each list
   remembering that you opened it.
     rfChecks(panel, {key, sel, commit, word, fold, head})
       panel   the list's element; its first <h3> is the header (or pass head: the element to put All / None in)
       sel     the list's item checkboxes (a CSS selector inside panel)
       commit(boxes, on)  saves once after All / None; without it each box's own change handler runs
       word    the count's word: "done" (default), "ticked", "chosen", "shown"
       fold    false: never fold (filters, tables)
       key     where the fold remembers being open (localStorage rfr.fold.<key>); no key, no memory
   Returns {update} (call it after changing boxes from code), or null when the list has no boxes. */
(() => {
const style = () => {
  if (document.getElementById("rfcStyle")) return;
  const s = document.createElement("style"); s.id = "rfcStyle";
  s.textContent = `.rfc-all{display:inline-flex !important;flex-direction:row !important;gap:6px;align-items:center;margin:0 0 0 10px;
  font-weight:400;font-size:12px;cursor:pointer;vertical-align:middle;white-space:nowrap}
.rfc-all input{width:auto !important;margin:0}
.rfc-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.rfc-head .rfc-all{margin-left:auto}
.rfc-head .rfc-caret{border:0;background:none;padding:0 2px;font:inherit;color:inherit;cursor:pointer;min-width:1.2em;text-align:left}
.rfc-body[hidden]{display:none !important}`;
  document.head.appendChild(s);
};
const remembered = k => { try { return localStorage.getItem("rfr.fold." + k) === "1"; } catch (e) { return false; } };
const remember = (k, open) => { try { open ? localStorage.setItem("rfr.fold." + k, "1") : localStorage.removeItem("rfr.fold." + k); } catch (e) { /* private mode */ } };

function rfChecks(panel, o = {}) {
  if (!panel || !o.sel) return null;
  if (panel._rfChecks) return panel._rfChecks;
  style();
  const boxes = () => [...panel.querySelectorAll(o.sel)].filter(b => b.type === "checkbox" && !b.closest(".rfc-all"));
  if (!boxes().length) return null;
  const head = o.head || panel.querySelector("h3");
  const m = document.createElement("label");
  m.className = "rfc-all";
  m.title = "Tick or clear every item in this list";
  m.innerHTML = `<input type="checkbox" aria-label="All or none"><span class="rfc-n hint"></span>`;
  const all = m.querySelector("input"), n = m.querySelector(".rfc-n");
  const update = () => {
    const b = boxes(), on = b.filter(x => x.checked).length;
    all.checked = b.length > 0 && on === b.length;
    all.indeterminate = on > 0 && on < b.length;
    n.textContent = `${on} of ${b.length} ${o.word || "done"}`;
  };
  m.addEventListener("click", e => e.stopPropagation());  // a click on All / None never folds the list
  all.addEventListener("change", () => {
    const want = all.checked, b = boxes().filter(x => !x.disabled && x.checked !== want);
    b.forEach(x => { x.checked = want; });
    if (b.length) { if (o.commit) o.commit(boxes(), want); else b.forEach(x => x.dispatchEvent(new Event("change", { bubbles: true }))); }
    update();
  });
  panel.addEventListener("change", e => { if (e.target !== all) update(); });
  if (head) head.appendChild(m); else panel.prepend(m);
  update();
  // fold: the header opens and closes the list; folded until opened once (then remembered)
  if (o.fold !== false && head && head.parentElement === panel) {
    const body = document.createElement("div");
    body.className = "rfc-body";
    let x = head.nextSibling;
    while (x) { const next = x.nextSibling; body.appendChild(x); x = next; }
    panel.appendChild(body);
    const caret = document.createElement("button");
    caret.type = "button"; caret.className = "rfc-caret";
    head.classList.add("rfc-head"); head.prepend(caret);
    const set = open => { body.hidden = !open; caret.textContent = open ? "▾" : "▸"; caret.setAttribute("aria-expanded", String(open));
      caret.title = open ? "Fold this list" : "Open this list"; };
    set(o.key ? remembered(o.key) : false);
    head.addEventListener("click", e => { if (e.target.closest("a, input, select, textarea, label.rfc-all") && e.target !== caret) return;
      const open = body.hidden; set(open); if (o.key) remember(o.key, open); });
  }
  panel._rfChecks = { update };
  return panel._rfChecks;
}
window.rfChecks = rfChecks;
})();
