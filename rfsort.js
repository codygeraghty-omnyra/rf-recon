"use strict";
/* DAStastic — every table and list sorts like a spreadsheet (Cody 11/8: "every list and table in the app, web and lite sorts by its
   columns (name, power, distance, frequency, date), like a spreadsheet"). Shared by the PC app (static/index.html, before core.js),
   the web version (the same page) and DAStastic lite (phone/index.html; phone/publish.py copies it beside app.js). */
// A table with a header row sorts by a header's click, or Enter / Space on it: ascending, then descending, ▲ / ▼ beside it
// (aria-sort). Values compare as a spreadsheet's do: numbers as numbers with their units and signs ("12.5 mi", "-85 dBm",
// "1,200 W", "462.5625 MHz", "3.4 MB", "6 h"), dates as dates (2026-11-08 14:30, 11/08/2026, Nov 8, 2026), text without case and
// with 2 before 10, blanks (and "–") always last. A cell's data-v is its value where its text isn't one.
// In the body, a row marked data-srt-with (or a one-cell row across the table under a row) goes with the row above it, a detail;
// data-srt-head (or one-cell rows when the body starts with one) heads a section that sorts within itself; rows with one
// data-srt-group sort among themselves (folders above files); data-srt-foot, and rows at the end that start "Total", stay at the
// bottom. The sort is remembered for the session by the table's id (or data-srt-key, for tables that share one), else by its
// headers, and put back when a table is drawn again: one pass a frame over the page's tables only, after render(), an api()
// answer, or a click, change or input, and only once something has been sorted. Nothing watches the page, and a draw costs
// nothing more: a table's headers are made sortable (data-srt, focusable) when the pointer first comes over it, on the first
// Tab, or on a click. A table that draws part of its data sorts all of it in its own code (own, data); a table, or a part of
// the page, marked data-nosort is left as it is (forms, label and value tables, the Map table's own sort, th[data-sort]).
const rfSort = (() => {
  const mem = new Map(), owners = new Map();
  const MON = {jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11};
  // units that scale (a column of sizes, frequencies, powers or ages can mix them); the other known words after a number count 1
  const SCALE = {Hz: 1, kHz: 1e3, MHz: 1e6, GHz: 1e9, mW: 1e-3, W: 1, kW: 1e3, MW: 1e6, B: 1, bytes: 1, KB: 1024, kB: 1024, MB: 1048576,
    GB: 1073741824, TB: 1099511627776, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600,
    hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400, wk: 604800, week: 604800, weeks: 604800,
    mo: 2629800, month: 2629800, months: 2629800, yr: 31557600, yrs: 31557600, year: 31557600, years: 31557600};
  const WORDS = new Set(("est mi ft m km dbm db dbi dbd dbc w a v ah mah lb lbs in kg pct percent x ago of to per each mhz khz ghz hz " +
    "freq freqs frequency frequencies licence licences license licenses licensee licensees site sites cell cells record records point points " +
    "reading readings sample samples square squares band bands item items line lines step steps file files row rows test tests " +
    "n ne nne ene e ese se sse s ssw sw wsw wnw nw nnw true mag magnetic agl amsl haat ch channel channels").split(" "));
  const BLANK = /^(?:[-–—−?]|n\/a)?$/i;
  const date = (y, mo, d, h = 0, mi = 0, s = 0) => [0, Date.UTC(y, mo, d, h, mi, s)];
  const hr12 = (h, ap) => !ap ? +h : (+h % 12) + (/p/i.test(ap) ? 12 : 0);
  const mon = w => MON[w.slice(0, 3).toLowerCase()];
  // text compares without case or accents, a run of digits as its number ("Grid 2" before "Grid 10"): a plain string compare
  const nat = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\d+/g, d => d.replace(/^0+(?=\d)/, "").padStart(16, "0"));
  // a value's sort key: [0, number] (numbers, dates, times), [1, text], or null (a blank)
  function key(raw) {
    if (typeof raw === "number") return isFinite(raw) ? [0, raw] : null;
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (BLANK.test(s)) return null;
    let m;
    if (/^[A-Za-z]/.test(s)) {  // a word first: text, unless it's a month (Nov 8, 2026; Nov 2026)
      if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b/.exec(s)) && mon(m[1]) != null) return date(+m[3], mon(m[1]), +m[2]);
      if ((m = /^([A-Za-z]{3,9})\.? (\d{4})$/.exec(s)) && mon(m[1]) != null) return date(+m[2], mon(m[1]), 1);
      return [1, nat(s)];
    }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s))) return date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)?)?/i.exec(s)))
      return date(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[1] - 1, +m[2], hr12(m[4] || 0, m[7]), +(m[5] || 0), +(m[6] || 0));
    if ((m = /^(\d{1,2}) ([A-Za-z]{3,9})\.?,? (\d{4})\b/.exec(s)) && mon(m[2]) != null) return date(+m[3], mon(m[2]), +m[1]);
    if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))? ?([AP]M)?$/i.exec(s))) return [0, hr12(m[1], m[4]) * 3600 + m[2] * 60 + +(m[3] || 0)];
    // a number, with what may come before it (≤, ~, $, a sign) and a unit or a count after; "2-7", "12/40", "1.2.3" stay text
    if ((m = /^(?:[~≈≤≥<>] ?)?([+\-−–]?) ?[$£€]?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?![\d,]*[\/:.\-]\d)(.*)$/.exec(s))) {
      const rest = m[3].trim(), w = /^[A-Za-zµμ]+/.exec(rest)?.[0];
      if (!w || WORDS.has(w.toLowerCase()) || SCALE[w] != null)
        return [0, parseFloat(m[2].replace(/,/g, "")) * (m[1] && m[1] !== "+" ? -1 : 1) * (w && SCALE[w] != null ? SCALE[w] : 1)];
    }
    return [1, nat(s)];
  }
  // a before b in a column sorted dir (1 or -1)? blanks last either way, numbers before text going up and after it going down
  const cmp = (a, b, dir) => a === null ? (b === null ? 0 : 1) : b === null ? -1 : a[0] !== b[0] ? (a[0] - b[0]) * dir
    : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) * dir;
  // a stable, sorted copy of list by fn(item)'s value (text as shown, or a number), for code that sorts its own data
  const by = (list, fn, dir = 1) => list.map((x, i) => ({x, i, k: key(fn(x))})).sort((p, q) => cmp(p.k, q.k, dir) || p.i - q.i).map(p => p.x);

  const cellAt = (tr, col) => { let c = 0; for (const td of tr.cells) { c += td.colSpan || 1; if (col < c) return td; } return null; };
  // a cell's text as read: lines (a <br>, a hint under a name) kept apart, a button's or a picker's own words left out
  const SKIP = /^(?:BUTTON|SELECT|OPTION|TEXTAREA|SCRIPT|STYLE|svg)$/, BLOCKS = /^(?:BR|DIV|P|LI|DETAILS|SUMMARY|TABLE|TR|H\d)$/;
  const text = n => { let s = ""; for (const c of n.childNodes) { if (c.nodeType === 3) s += c.data;
    else if (c.nodeType === 1 && !SKIP.test(c.tagName)) s += BLOCKS.test(c.tagName) ? ` ${text(c)} ` : text(c); } return s; };
  // a cell's value: its data-v; its text; with no text, what its field holds (a typed value, a picked option, a tick), or else
  // the words on its button (a folder's name is a button)
  function cellVal(td) {
    if (!td) return "";
    if (td.dataset.v != null) return td.dataset.v;
    const t = text(td); if (t.trim()) return t;
    const f = td.querySelector("input:not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]),select,textarea");
    return !f ? td.textContent : f.type === "checkbox" || f.type === "radio" ? (f.checked ? "1" : "0") : f.tagName === "SELECT" ? (f.selectedOptions[0]?.text ?? f.value) : f.value;
  }
  const headRow = t => t.tHead?.rows[t.tHead.rows.length - 1] || (t.rows[0] && [...t.rows[0].cells].every(c => c.tagName === "TH") ? t.rows[0] : null);
  // a header's own words: a control put in it (the pre-survey's All / None and its "3 of 20 chosen") is no part of them
  const label = th => !th.firstElementChild ? th.textContent.replace(/\s+/g, " ").trim() : [...th.childNodes].map(c => c.nodeType === 3 ? c.data : c.nodeType === 1 && !/^(?:LABEL|INPUT)$/.test(c.tagName) && !SKIP.test(c.tagName) ? text(c) : "")
    .join(" ").replace(/\s+/g, " ").trim();
  const firstRow = (t, s) => { const b = t.tBodies[0]; return b && (b.rows[0] === s.hr ? b.rows[1] : b.rows[0]); };
  // a table's header row, its sortable columns and its key, read only; false: no header row of two or more headers, the Map
  // table's own sort, data-nosort, or body rows that start with a header cell (a label and value table). An empty header (a
  // column of buttons) doesn't sort.
  function info(t) {
    t._srt = false;
    if (t.closest("[data-nosort]")) return false;
    const hr = headRow(t); if (!hr || hr.cells.length < 2 || hr.querySelector("th[data-sort]")) return false;
    const b = t.tBodies[0], b0 = b && (b.rows[0] === hr ? b.rows[1] : b.rows[0]);
    if (b0?.cells[0]?.tagName === "TH") return false;
    let c = 0; const cols = [];
    for (const th of hr.cells) {
      if (th.tagName === "TH" && !th.hasAttribute("data-nosort") && label(th)) cols.push([th, c]);
      c += th.colSpan || 1; }
    if (!cols.length) return false;
    const key = t.dataset.srtKey || t.id || "h:" + [...hr.cells].map(label).join("|");  // data-srt-key: tables that share one sort
    return t._srt = {key, hr, ncol: c, cols, own: owners.has(key), armed: false};
  }
  // its headers made sortable: data-srt (the pointer, the click), focusable (Tab, Enter, Space)
  function arm(t) {
    const s = t._srt === undefined ? info(t) : t._srt; if (!s || s.armed) return s;
    for (const [th, c] of s.cols) { th.dataset.srt = c; th.tabIndex = 0; }
    s.armed = true; return s;
  }
  function paint(t, m) { for (const [th, c] of t._srt.cols) {
    if (m && c === m.c) th.setAttribute("aria-sort", m.d > 0 ? "ascending" : "descending"); else if (th.hasAttribute("aria-sort")) th.removeAttribute("aria-sort"); } }
  // the body in the order of column c: details with their row, sections within themselves, totals at the bottom
  function order(t, c, d) {
    const s = t._srt, one = r => r.cells.length === 1 && s.ncol > 1;
    for (const tb of t.tBodies) {
      const rows = [...tb.rows].filter(r => r !== s.hr); if (rows.length < 2) continue;
      const sectioned = rows[0].hasAttribute("data-srt-head") || (one(rows[0]) && !rows[0].hasAttribute("data-srt-with"));
      let end = rows.length;
      while (end > 0 && (rows[end - 1].hasAttribute("data-srt-foot") || /^(?:total|totals|grand total)\b/i.test(rows[end - 1].cells[0]?.textContent.trim() || ""))) end--;
      const foot = rows.slice(end), secs = [{head: null, units: []}];
      for (const r of rows.slice(0, end)) {
        const sec = secs[secs.length - 1];
        if (r.hasAttribute("data-srt-head") || (sectioned && one(r) && !r.hasAttribute("data-srt-with"))) secs.push({head: r, units: []});
        else if (r.hasAttribute("data-srt-foot")) foot.push(r);
        else if (sec.units.length && (r.hasAttribute("data-srt-with") || (!sectioned && one(r)))) sec.units[sec.units.length - 1].push(r);
        else sec.units.push([r]);
      }
      const want = [];
      for (const sec of secs) {
        if (sec.head) want.push(sec.head);
        const grp = new Map();  // data-srt-group: rows of one kind (folders, then files) sort among themselves, the kinds as they came
        for (const u of sec.units) { const g = u[0].dataset.srtGroup || ""; if (!grp.has(g)) grp.set(g, grp.size); }
        for (const p of sec.units.map((u, i) => ({u, i, g: grp.get(u[0].dataset.srtGroup || ""), k: key(cellVal(cellAt(u[0], c)))}))
          .sort((p, q) => p.g - q.g || cmp(p.k, q.k, d) || p.i - q.i)) want.push(...p.u);
      }
      want.push(...foot);
      if (want.every((r, i) => r === rows[i])) continue;  // already in this order: nothing moves
      const f = document.createDocumentFragment(); f.append(...want); tb.append(f);
    }
  }
  // put a remembered sort on a table drawn again (or whose rows changed); nothing when it's already in that order
  function keep(t) {
    const s = t._srt, m = mem.get(s.key); if (!m) return;
    if (s.at === m && s.first === firstRow(t, s) && s.n === t.rows.length) return;
    paint(t, m); if (!s.own) order(t, m.c, m.d);
    s.at = m; s.first = firstRow(t, s); s.n = t.rows.length;
  }
  // the pass: with nothing sorted yet it does nothing; else each table drawn since is read, and those with a remembered sort take it
  let raf = 0;
  // the page's tables, as a list taken once: a live collection walked while rows move is counted again from the top each step
  // (553 Agencies tables: 221 ms against 2)
  const tables = () => Array.from(document.getElementsByTagName("table"));
  function pass() { raf = 0; if (!mem.size) return; const ts = tables();
    for (let i = 0; i < ts.length; i++) { const t = ts[i], s = t._srt === undefined ? info(t) : t._srt; if (s && mem.has(s.key)) keep(t); } }
  const soon = () => { if (!raf) raf = requestAnimationFrame(pass); };
  const armAll = () => { const ts = tables(); for (let i = 0; i < ts.length; i++) if (!ts[i]._srt?.armed && ts[i]._srt !== false) arm(ts[i]); };
  function press(th) {
    const t = th.closest("table"); if (!t) return;
    const s = arm(t); if (!s || th.dataset.srt == null) return;
    const c = +th.dataset.srt, was = mem.get(s.key), m = {c, d: was && was.c === c ? -was.d : 1};
    mem.set(s.key, m);
    if (s.own) { paint(t, m); s.at = m; owners.get(s.key)(m); return; }  // its own code sorts all its data and draws it again
    const ts = tables();  // every table of this kind on the page takes the same order (a table a floor)
    for (let i = 0; i < ts.length; i++) { const x = ts[i], xs = x._srt === undefined ? info(x) : x._srt; if (xs && xs.key === s.key) { arm(x); keep(x); } }
  }
  document.addEventListener("click", e => {
    const th = e.target.closest?.("th");
    if (th && !e.target.closest("a,button,input,select,textarea,label,summary,[data-click]")) { const t = th.closest("table"); if (t && arm(t) && th.dataset.srt != null) press(th); }
    soon();
  });
  // the pointer over a table, or the first Tab: its headers become sortable before they're needed (a pointer cursor, a focus stop)
  document.addEventListener("mouseover", e => { const t = e.target.closest?.("table"); if (t && t._srt !== false && !t._srt?.armed) arm(t); }, {passive: true});
  document.addEventListener("keydown", e => {
    if (e.key === "Tab") armAll();
    else if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("th[data-srt]")) { e.preventDefault(); press(e.target); } });
  document.addEventListener("input", soon); document.addEventListener("change", soon);
  return {
    key, cmp, by, soon, pass,
    get: k => mem.get(k),                                       // {c: column, d: 1 | -1}, or undefined
    set: (k, m) => { if (m) mem.set(k, m); else mem.delete(k); },
    // own(key, redraw): the table whose id (or data-srt-key) is key draws part of its data, so its code sorts all of it with
    // data(); a header press remembers the column and calls redraw(sort). Registered again on each draw, redraw can be a closure.
    own: (k, redraw) => { owners.set(k, redraw); for (const t of tables()) if (t._srt && t._srt.key === k) t._srt.own = true; },
    // list sorted by key's remembered column, cols[c] giving an item's value in column c (no function there: it doesn't sort)
    data: (k, list, cols) => { const m = mem.get(k); return m && cols[m.c] ? by(list, cols[m.c], m.d) : list; },
  };
})();
