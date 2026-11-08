"use strict";
/* DAStastic — the wall tools on a DAS floor plan (Design, Antennas and coverage): drag or click-click walls that snap to
   the drawn walls and the plan's own lines, a rectangle Snip and a free Lasso that find the walls inside (one material,
   or Smart: each wall's material from what the plan and the job say), a review of what was found with how sure each
   one is and why, undo / redo, keyboard shortcuts and a hint of the best tool for this plan.
   The plan's lines come from planlines.js: the PDF's vectors when the floor's page is known (floors[i].plan_src, or a
   plan image named "<pdf> p<n> (floor X).png"), else the plan image; they're kept as a job file
   "<plan>.walls-v<n>.json" (never in the job's data). Nothing is added without review unless it came from vectors and
   every wall found is 0.75 sure or better.
   Needs dasdesign.js (DS_WALLS, dsFloors calls DW.mount and DW.paint), das.js (jobFileSrc, render), plans.js (pdfjs),
   planlines.js, keys.js. */
window.DW = (() => {
const PL = () => window.PlanLines;
const MAT_RE = {drywall: /^Drywall/, conc4: /^Concrete 4 in/, conc8: /^Concrete wall or slab 8 in/, conc12: /^Concrete 12 in/, rc8: /^Reinforced concrete 8/,
  cmu: /^CMU/, brick: /^Brick, single/, brickcmu: /^Brick veneer/, glass: /^Clear glass/, lowe: /^Low-E/, wood: /^Wood/, shaft: /^Elevator shaft/};
const matIndex = key => { const re = MAT_RE[key]; const i = re ? DS_WALLS.findIndex(x => re.test(x[0])) : -1; return i; };
const keyOfLabel = label => Object.keys(MAT_RE).find(k => MAT_RE[k].test(label || "")) || null;
const wallOf = (i, extra = {}) => { const P = DS_WALLS[i] || DS_WALLS[0]; return {label: P[0], mat: P[3], cm: P[4], ...extra}; };
const TOOLS = {antenna: "Place antennas", wall: "Draw walls", snip: "Snip", lasso: "Lasso", erase: "Remove"};
const COLOR = c => c >= 0.75 ? "#2da44e" : c >= 0.5 ? "#d4a017" : "#8c959f";
let cur = null;  // the editor on screen (set by mount on every draw of the view)
const st = {down: null, hover: null, snap: null};  // pointer state; survives re-draws
const LS = new Map();  // `${job}|${plan}|${width}` -> Promise<line set | null>
const HIST = new Map();  // `${job}|${floor}` -> {u: [], r: []}

/* ---------- the plan's lines ---------- */
// the PDF page a floor's plan came from: recorded when saved (plans.js), else read from the image's name
function planSrc(f) {
  if (f.plan_src && f.plan_src.pdf && (!f.plan_src.png || f.plan_src.png === f.plan)) return f.plan_src;  // not when another image was picked since
  const m = /^(.*) p(\d+) \(floor [^)]*\)(?: \(\d+\))?\.png$/i.exec(f.plan || "");
  return m ? {pdf: `${m[1]}.pdf`, page: +m[2]} : null;
}
const cacheName = f => `${f.plan}.walls-v${PL().ALGO}.json`;
function lineSet(j, f, widthFt) {
  const key = `${j.id}|${f.plan}|${widthFt || ""}`;
  if (LS.has(key)) return LS.get(key);
  const p = (async () => {
    // the job's files, asked first so nothing is fetched that isn't there (no 404s in the console)
    const have = new Set(((await api(`/api/das/jobs/${j.id}/files`).catch(() => ({files: []}))).files || []).map(x => x.name));
    // kept from an earlier reading (made with this plan width)
    if (have.has(cacheName(f))) try { const r = await fetch(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(cacheName(f))}`);
      if (r.ok) { const js = await r.json(); if (js && js.v === PL().ALGO && (js.width_ft || null) === (widthFt || null)) return js; } } catch (e) { /* read it again */ }
    let ls = null, err = null;
    const src = planSrc(f);
    if (src && have.has(src.pdf)) try { ls = await fromPdf(j, src, widthFt); } catch (e) { err = e; }
    if (!ls || ls.walls.length < 4) { try { const r = await fromImage(j, f, widthFt); if (r && (!ls || r.walls.length > ls.walls.length)) ls = r; } catch (e) { err = err || e; } }
    if (!ls) { if (err) console.warn("plan lines:", err); return null; }
    ls.plan = f.plan; ls.width_ft = widthFt || null; ls.made = new Date().toISOString(); if (src && ls.src === "vector") ls.pdf = src;
    // kept with the job's files once the plan's width is known (job files are never overwritten)
    if (widthFt && !have.has(cacheName(f))) api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(cacheName(f))}`, {method: "POST", body: JSON.stringify(ls)}).catch(() => {});
    return ls;
  })();
  LS.set(key, p);
  p.then(v => { if (!v) LS.delete(key); });
  return p;
}
async function fromPdf(j, src, widthFt) {
  if (typeof pdfjs !== "function") return null;
  const r = await fetch(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(src.pdf)}`); if (!r.ok) return null;
  const lib = await pdfjs(), doc = await lib.getDocument({data: await r.arrayBuffer(), isEvalSupported: false}).promise;
  if (src.page > doc.numPages) return null;
  const page = await doc.getPage(src.page), view = page.getViewport({scale: 1});
  const [ops, text] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
  const names = {}; try { const g = (await doc.getOptionalContentConfig()).getGroups() || {}; for (const k in g) names[k] = g[k].name; } catch (e) { /* no layers */ }
  const raw = PL().opsToSegments(ops.fnArray, ops.argsArray, lib.OPS, {transform: view.transform, width: view.width, height: view.height}, names);
  return PL().vectorLines(raw, PL().textWords(text.items, view), {width_ft: widthFt});
}
async function fromImage(j, f, widthFt) {
  const url = await jobFileSrc(j.id, f.plan); if (!url) return null;
  const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("the plan image didn't load")); i.src = url; });
  const k = Math.min(1, 2400 / im.naturalWidth), w = Math.round(im.naturalWidth * k), h = Math.round(im.naturalHeight * k);
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const g = cv.getContext("2d", {willReadFrequently: true});
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(im, 0, 0, w, h);
  await new Promise(ok => setTimeout(ok, 0));  // let "Reading the plan" show first
  return PL().rasterLines(PL().toGray(g.getImageData(0, 0, w, h).data, w, h), w, h, {width_ft: widthFt});
}

/* ---------- what the job knows, for Smart ---------- */
const BTYPE = [[/warehouse|distribution|industrial|logistics|tilt[- ]?up|factory/i, "rc8", "a warehouse or industrial building: usually tilt-up concrete"],
  [/parking|garage/i, "conc8", "a parking structure: concrete"], [/school|hospital|church|library|courthouse/i, "brickcmu", "a school, hospital or civic building: usually brick on block"],
  [/apartment|residential|house|dorm|condo/i, "wood", "a residential building: usually wood framing"], [/office|commercial|retail|bank/i, "lowe", "an office or commercial building: usually a glass curtain wall"]];
function smartCtx(j, f) {
  const d = j.data || {}, all = (d.design || {}).floors || {}, ctx = {};
  // outside walls drawn on the job's other floors: the walls on each floor's outline, the type most used
  const tally = {};
  for (const [name, fl] of Object.entries(all)) { if (name === f.name) continue; const W = fl.walls || []; if (W.length < 3) continue;
    const xs = W.flatMap(w => [w.x1, w.x2]), ys = W.flatMap(w => [w.y1, w.y2]), b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], e = 0.03;
    for (const w of W) { const onEdge = (Math.abs(w.x1 - b[0]) < e && Math.abs(w.x2 - b[0]) < e) || (Math.abs(w.x1 - b[2]) < e && Math.abs(w.x2 - b[2]) < e)
      || (Math.abs(w.y1 - b[1]) < e && Math.abs(w.y2 - b[1]) < e) || (Math.abs(w.y1 - b[3]) < e && Math.abs(w.y2 - b[3]) < e);
      const k = keyOfLabel(w.label); if (onEdge && k) (tally[k] = tally[k] || {n: 0, floors: new Set()}).n++, tally[k].floors.add(name); } }
  const top = Object.entries(tally).sort((a, b) => b[1].n - a[1].n)[0];
  if (top && top[1].n >= 2) ctx.otherFloors = {key: top[0], why: `as drawn on floor ${[...top[1].floors].join(", ")} (${DS_WALLS[matIndex(top[0])]?.[0] || top[0]})`};
  const said = [d.construction, d.building?.material, d.building?.facade].filter(Boolean).join("; "), k = PL().materialFromText(said);
  if (k) ctx.facade = {key: k, why: `the job says "${said.slice(0, 60)}"`};
  const kind = [d.building?.kind, j.name, d.client].filter(Boolean).join(" ");
  const bt = BTYPE.find(([re]) => re.test(kind)); if (bt) ctx.btype = {key: bt[1], why: bt[2]};
  return ctx;
}

/* ---------- undo / redo: 30 steps per floor; a batch is one step ---------- */
const hist = () => { const k = `${cur.j.id}|${cur.f.name}`; if (!HIST.has(k)) HIST.set(k, {u: [], r: []}); return HIST.get(k); };
const snap = fl => JSON.stringify({walls: fl.walls || [], antennas: fl.antennas || []});
function before() { if (!cur) return; const H = hist(); H.u.push(snap(cur.fl)); if (H.u.length > 30) H.u.shift(); H.r.length = 0; }
function undo(redo) {
  if (!cur) return; const H = hist(), from = redo ? H.r : H.u, to = redo ? H.u : H.r; if (!from.length) { toast(redo ? "Nothing to redo." : "Nothing to undo."); return; }
  to.push(snap(cur.fl)); const s = JSON.parse(from.pop()); cur.D.dsReview = null; cur.D.dsWallStart = null;
  toast(redo ? "Redone." : `Undone. ${redo ? "" : "Ctrl+Shift+Z puts it back."}`); cur.keep(s);
}
const keepU = patch => { before(); return cur.keep(patch); };

/* ---------- geometry on screen ---------- */
const size = () => ({W: cur.svg.clientWidth || 1, H: cur.svg.clientHeight || 1});
const pt = e => { const r = cur.svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const toPx = w => { const {W, H} = size(); return {...w, x1: w.x1 * W, y1: w.y1 * H, x2: w.x2 * W, y2: w.y2 * H}; };
function lsPx() {  // the plan's lines in screen pixels (kept until the size or line set changes)
  const {W, H} = size(), ls = cur.ls; if (!ls) return null;
  if (cur.lsPx && cur.lsPx.W === W && cur.lsPx.H === H && cur.lsPx.ls === ls) return cur.lsPx;
  const sx = W / ls.W, sy = H / ls.H, m = s => ({...s, x1: s.x1 * sx, y1: s.y1 * sy, x2: s.x2 * sx, y2: s.y2 * sy, t: (s.t || 0) * sx});
  return cur.lsPx = {W, H, ls, lines: [...ls.walls, ...ls.lines.filter(l => l.conf >= 0.3)].map(m), pts: ls.pts.map(p => [p[0] * sx, p[1] * sy, p[2]])};
}
function snapAt(p, start, e) {
  const L = lsPx(), useSnap = cur.D.dsSnap !== false && !(e && (e.ctrlKey || e.metaKey));
  const o = {walls: useSnap ? (cur.fl.walls || []).map(toPx) : [], lines: useSnap && L ? L.lines : [], pts: useSnap && L ? L.pts : [], start, angle: cur.ls?.angle || 0, axis: !!(e && e.shiftKey && start)};
  if (!useSnap && !o.axis) return {x: p[0], y: p[1], kind: null};
  return PL().snapPoint(p, o);
}
const ftOf = (a, b) => { const w = +cur.fl.width_ft; if (!w) return null; const {W} = size(); return Math.hypot(b[0] - a[0], b[1] - a[1]) / W * w; };
function nearest(p) {  // the antenna or wall under the pointer
  const {W, H} = size(), A = cur.fl.antennas || [], Wl = cur.fl.walls || [];
  const ai = A.findIndex(a => Math.hypot(a.x * W - p[0], a.y * H - p[1]) < 14); if (ai >= 0) return {kind: "antenna", i: ai};
  let bi = -1, bd = 8; Wl.forEach((w, i) => { const d = PL().geom.segDist(p[0], p[1], toPx(w)); if (d < bd) { bd = d; bi = i; } });
  return bi >= 0 ? {kind: "wall", i: bi} : null;
}
function nearestProposal(p) {
  const R = cur.D.dsReview; if (!R) return -1; let bi = -1, bd = 9;
  R.items.forEach((w, i) => { if (w.dropped) return; const d = PL().geom.segDist(p[0], p[1], toPx(w)); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
// the tool in effect: Shift held swaps adding and removing (not while a wall is under way, where Shift squares it)
function tool(e) {
  const t = cur.D.dsTool || "antenna", sh = e ? e.shiftKey : RFKeys.shift();
  if (!sh || cur.D.dsWallStart || st.down) return t;
  return t === "erase" ? "wall" : "erase";
}

/* ---------- pointer ---------- */
function wire() {
  const svg = cur.svg;
  svg.style.touchAction = ["wall", "snip", "lasso", "erase"].includes(cur.D.dsTool) ? "none" : "manipulation";
  svg.onclick = null;
  svg.onpointerdown = e => {
    if (e.button !== 0) return; const p = pt(e);
    st.down = {p, tool: cur.D.dsReview ? "review" : tool(e), moved: false, path: [p], id: e.pointerId};
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  };
  svg.onpointermove = e => {
    const p = pt(e); st.hover = p;
    if (st.down) { if (Math.hypot(p[0] - st.down.p[0], p[1] - st.down.p[1]) > 4) st.down.moved = true;
      if (st.down.tool === "lasso") { const l = st.down.path[st.down.path.length - 1]; if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 3) st.down.path.push(p); } }
    st.e = {shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey};
    paint();
  };
  svg.onpointerup = e => {
    const dn = st.down; st.down = null; if (!dn) return;
    const p = pt(e);
    try { if (dn.moved) dragEnd(dn, p, e); else click(dn, p, e); } finally { paint(); }
  };
  svg.onpointercancel = () => { st.down = null; paint(); };
  svg.onpointerleave = () => { if (!st.down) { st.hover = null; paint(); } };
}
function addWall(a, b, extra = {}) {
  const {W, H} = size(); if (Math.hypot(b.x - a.x, b.y - a.y) < 3) { toast("Too short for a wall."); return; }
  const w = wallOf(+cur.D.dsWall || 0, {x1: a.x / W, y1: a.y / H, x2: b.x / W, y2: b.y / H, ...extra});
  cur.D.dsWallStart = null; keepU({walls: [...(cur.fl.walls || []), w]});
}
function click(dn, p, e) {
  const D = cur.D, {W, H} = size();
  if (dn.tool === "review") { const i = nearestProposal(p); if (i >= 0) { D.dsReview.items[i].dropped = true; review(); } return; }
  if (dn.tool === "antenna") { keepU({antennas: [...(cur.fl.antennas || []), {x: p[0] / W, y: p[1] / H, label: `A${(cur.fl.antennas || []).length + 1}`}]}); return; }
  if (dn.tool === "wall") {
    if (!D.dsWallStart) { const s = snapAt(p, null, e); D.dsWallStart = [s.x / W, s.y / H]; return; }
    const a = {x: D.dsWallStart[0] * W, y: D.dsWallStart[1] * H}, b = snapAt(p, [a.x, a.y], e);
    addWall(a, b); return;
  }
  if (dn.tool === "erase") { const n = nearest(p); if (!n) return;
    if (n.kind === "antenna") keepU({antennas: cur.fl.antennas.filter((_, i) => i !== n.i)}); else keepU({walls: cur.fl.walls.filter((_, i) => i !== n.i)}); return; }
  if (dn.tool === "snip" || dn.tool === "lasso") toast(dn.tool === "snip" ? "Drag a box around the walls to find." : "Drag a loop around the walls to find; it closes where you started.");
}
function dragEnd(dn, p, e) {
  const D = cur.D, {W, H} = size();
  if (dn.tool === "review") return;
  if (dn.tool === "wall") {
    const a0 = D.dsWallStart ? [D.dsWallStart[0] * W, D.dsWallStart[1] * H] : dn.p, A = D.dsWallStart ? {x: a0[0], y: a0[1]} : snapAt(a0, null, e), B = snapAt(p, [A.x, A.y], e);
    const L = cur.D.dsSnap !== false && !(e.ctrlKey || e.metaKey) && !e.shiftKey ? lsPx() : null, lock = L ? PL().lockDrag([A.x, A.y], [B.x, B.y], L.lines) : null;
    if (lock) addWall({x: lock.x1, y: lock.y1}, {x: lock.x2, y: lock.y2}, {src: cur.ls?.src, conf: lock.line.conf}); else addWall(A, B);
    return;
  }
  if (dn.tool === "antenna") { keepU({antennas: [...(cur.fl.antennas || []), {x: p[0] / W, y: p[1] / H, label: `A${(cur.fl.antennas || []).length + 1}`}]}); return; }
  if (dn.tool === "erase") {  // a box: every antenna in it and every wall mostly in it
    const poly = PL().rectPoly(dn.p[0], dn.p[1], p[0], p[1]);
    const keepA = (cur.fl.antennas || []).filter(a => !PL().inPoly(a.x * W, a.y * H, poly));
    const keepW = (cur.fl.walls || []).filter(w => PL().clipPoly(toPx(w), poly).reduce((s, [a, b]) => s + b - a, 0) <= 0.5);
    const n = (cur.fl.antennas || []).length - keepA.length + (cur.fl.walls || []).length - keepW.length;
    if (!n) { toast("Nothing in that box to remove."); return; }
    toast(`Removed ${n} · Ctrl+Z`); keepU({antennas: keepA, walls: keepW}); return;
  }
  if (dn.tool === "snip") return find(PL().rectPoly(dn.p[0], dn.p[1], p[0], p[1]), "snip");
  if (dn.tool === "lasso") { const path = [...dn.path, p]; if (path.length < 4) { toast("Draw a bigger loop."); return; } return find(path, "lasso"); }
}

/* ---------- snip and lasso ---------- */
function find(polyPx, how) {
  const D = cur.D;
  if (!cur.ls) { toast(cur.lsState === "none" ? "No lines could be read from this plan: draw the walls." : "Still reading the plan's lines: try again in a moment."); return; }
  const {W, H} = size(), ls = cur.ls, sx = ls.W / W, sy = ls.H / H, smart = !!D.dsSmart;
  const poly = polyPx.map(([x, y]) => [x * sx, y * sy]);
  const existing = (cur.fl.walls || []).map(w => ({...w, x1: w.x1 * ls.W, y1: w.y1 * ls.H, x2: w.x2 * ls.W, y2: w.y2 * ls.H, t: 0}));
  const lsUse = cur.fl.width_ft ? {...ls, ppi: ls.W / (cur.fl.width_ft * 12)} : ls;
  const r = PL().proposeWalls(lsUse, poly, {smart, mat: keyOfLabel(DS_WALLS[+D.dsWall || 0][0]), ctx: smart ? smartCtx(cur.j, cur.f) : {}, existing, minConf: 0.35});
  const items = r.walls.map(w => ({...w, x1: w.x1 / ls.W, y1: w.y1 / ls.H, x2: w.x2 / ls.W, y2: w.y2 / ls.H, mi: smart ? Math.max(0, matIndex(w.mat)) : +D.dsWall || 0}));
  if (!items.length) { toast(`Nothing found in the ${how}${r.dup ? `: ${r.dup} wall${r.dup === 1 ? " is" : "s are"} already drawn there` : ""}.`); return; }
  const auto = ls.src === "vector" && items.every(w => w.conf >= 0.75);
  if (auto) { accept(items, `Added ${items.length} wall${items.length === 1 ? "" : "s"} from the PDF`); return; }
  D.dsReview = {floor: cur.f.name, plan: cur.f.plan, items, dup: r.dup, smart, src: ls.src, how}; review();
}
// why the review is shown instead of adding straight away
function reviewWhy(R) {
  const live = R.items.filter(w => !w.dropped), low = live.filter(w => w.conf < 0.75);
  const why = R.src !== "vector" ? "Read from the plan image, so each find is shown first." : low.length ? `${low.length} of ${live.length} below 0.75 sure.` : "";
  const reasons = {}; for (const w of low) { const r = w.lineConf < 0.75 ? w.lineWhy : w.matWhy; reasons[r] = (reasons[r] || 0) + 1; }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r, n]) => `${n}: ${r}`);
  return `${why}${top.length ? ` Least sure: ${top.join("; ")}.` : ""}`;
}
function review() {
  const box = document.getElementById("dfReview"); if (!box || !cur) return;
  const R = cur.D.dsReview;
  if (!R || R.floor !== cur.f.name || R.plan !== cur.f.plan) { cur.D.dsReview = null; box.innerHTML = ""; box.hidden = true; paint(); return; }
  const live = R.items.filter(w => !w.dropped), sure = live.filter(w => w.conf >= 0.75).length;
  const mats = {}; for (const w of live) { const l = DS_WALLS[w.mi]?.[0] || "?"; mats[l] = (mats[l] || 0) + 1; }
  box.hidden = false;
  box.innerHTML = `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
      <b>${live.length} wall${live.length === 1 ? "" : "s"} found</b><span class="hint">${sure} sure, ${live.length - sure} to check${R.dup ? ` · ${R.dup} already drawn, left out` : ""} · ${R.smart ? "Smart materials" : "one material"} · from the ${R.src === "vector" ? "PDF" : "plan image"}</span>
      <button class="primary" data-dw="sure" ${sure ? "" : "disabled"}>Add the sure ones (${sure}) <kbd>Enter</kbd></button>
      <button data-dw="all" ${live.length ? "" : "disabled"}>Add all ${live.length} <kbd>Shift</kbd>+<kbd>Enter</kbd></button>
      <button data-dw="drop">Discard <kbd>Esc</kbd></button></div>
    <p class="hint" style="margin:4px 0 0">${esc(reviewWhy(R))} Green: sure (0.75 or more), amber: check it, grey: probably not a wall. Click a dashed wall to leave it out; <kbd>M</kbd> or <kbd>1</kbd>-<kbd>9</kbd> over one changes its type; hover for why.</p>
    <p class="hint" style="margin:2px 0 0">${Object.entries(mats).map(([l, n]) => `${esc(l)}: ${n}`).join(" · ")}</p>`;
  box.querySelector('[data-dw="sure"]').onclick = () => acceptReview(false);
  box.querySelector('[data-dw="all"]').onclick = () => acceptReview(true);
  box.querySelector('[data-dw="drop"]').onclick = () => { cur.D.dsReview = null; toast("Discarded."); review(); };
  paint();
}
function acceptReview(all) {
  const R = cur?.D.dsReview; if (!R) return;
  const items = R.items.filter(w => !w.dropped && (all || w.conf >= 0.75));
  if (!items.length) { const n = R.items.filter(w => !w.dropped).length; toast(n ? `None of the ${n} is sure enough to add by itself: check them, then Shift+Enter adds all.` : "Nothing left to add."); return; }
  accept(items, `Added ${items.length} wall${items.length === 1 ? "" : "s"}`);
}
function accept(items, msg) {
  const add = items.map(w => wallOf(w.mi, {x1: +w.x1.toFixed(5), y1: +w.y1.toFixed(5), x2: +w.x2.toFixed(5), y2: +w.y2.toFixed(5), src: w.src, conf: w.conf,
    ...(w.thick_in ? {thick_in: w.thick_in} : {})}));
  cur.D.dsReview = null; toast(`${msg} · Ctrl+Z takes ${items.length === 1 ? "it" : "them"} back.`);
  keepU({walls: [...(cur.fl.walls || []), ...add]});
}

/* ---------- drawing the tools' marks over the plan ---------- */
const MARK = {"wall-end": "a wall's end", "plan-end": "a line's end on the plan", crossing: "where plan lines meet", "on-line": "on a plan line", axis: "square to the plan"};
function paint() {
  if (!cur || !cur.svg.isConnected) return;
  const svg = cur.svg, D = cur.D, {W, H} = size(); let g = svg.querySelector("#dwOv");
  if (!g) { g = document.createElementNS("http://www.w3.org/2000/svg", "g"); g.id = "dwOv"; svg.appendChild(g); }
  const out = [], line = (a, b, c, extra = "") => out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" ${extra}/>`);
  const label = (x, y, s) => out.push(`<text x="${x + 8}" y="${y - 8}" font-size="12" fill="#111" style="paint-order:stroke;stroke:#fff;stroke-width:3px">${esc(s)}</text>`);
  // the review: dashed, coloured by how sure
  const R = D.dsReview; const hp = st.hover ? nearestProposal(st.hover) : -1;
  if (R) R.items.forEach((w, i) => { if (w.dropped) return; const p = toPx(w), c = COLOR(w.conf);
    out.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${c}" stroke-width="${i === hp ? 6 : 4}" stroke-dasharray="7 5" stroke-linecap="round" data-prop="${i}"><title>${esc(`${DS_WALLS[w.mi]?.[0]} · ${Math.round(w.conf * 100)}% sure\nWall: ${w.lineWhy} (${Math.round(w.lineConf * 100)}%)\nType: ${w.matWhy}${R.smart ? ` (${Math.round(w.matConf * 100)}%)` : ""}`)}</title></line>`); });
  if (R && hp >= 0 && st.hover) label(st.hover[0], st.hover[1], `${DS_WALLS[R.items[hp].mi]?.[0]} · ${Math.round(R.items[hp].conf * 100)}%`);
  // what's under the pointer for Remove / Delete
  const t = st.down ? st.down.tool : tool(st.e);
  if (!R && st.hover && !st.down && t === "erase") { const n = nearest(st.hover);
    if (n && n.kind === "wall") { const p = toPx(cur.fl.walls[n.i]); line([p.x1, p.y1], [p.x2, p.y2], "#cf222e", 'stroke-width="7" stroke-opacity=".45" stroke-linecap="round"'); }
    if (n && n.kind === "antenna") { const a = cur.fl.antennas[n.i]; out.push(`<circle cx="${a.x * W}" cy="${a.y * H}" r="14" fill="none" stroke="#cf222e" stroke-width="3"/>`); } }
  // a wall under way: from its start (click) or the drag's start, to the snapped pointer, with its length
  const startPx = D.dsWallStart ? [D.dsWallStart[0] * W, D.dsWallStart[1] * H] : st.down && st.down.moved && st.down.tool === "wall" ? (() => { const s = snapAt(st.down.p, null, st.e); return [s.x, s.y]; })() : null;
  st.snap = null;
  if (!R && st.hover && (t === "wall") && !(st.down && st.down.tool !== "wall")) {
    const s = snapAt(st.hover, startPx, st.e); st.snap = s;
    if (startPx) {
      let b = [s.x, s.y], a = startPx, locked = false;
      if (st.down && st.down.moved && !D.dsWallStart && D.dsSnap !== false && !st.e?.shiftKey && !st.e?.ctrlKey && !st.e?.metaKey) { const L = lsPx(), lk = L ? PL().lockDrag(a, b, L.lines) : null; if (lk) { a = [lk.x1, lk.y1]; b = [lk.x2, lk.y2]; locked = true; } }
      line(a, b, locked ? "#1f6feb" : "#e5534b", 'stroke-width="3" stroke-dasharray="6 4" stroke-linecap="round"');
      const ft = ftOf(a, b); label(b[0], b[1], `${ft != null ? `${ft.toFixed(1)} ft` : `${Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]))} px (set the plan width for feet)`}${locked ? " · on the plan's line" : ""}`);
    }
    if (s.kind) { const c = {"wall-end": "#e5534b", "plan-end": "#1f6feb", crossing: "#8250df", "on-line": "#1f6feb", axis: "#57606a"}[s.kind];
      out.push(s.kind === "crossing" ? `<path d="M${s.x - 6},${s.y - 6}L${s.x + 6},${s.y + 6}M${s.x - 6},${s.y + 6}L${s.x + 6},${s.y - 6}" stroke="${c}" stroke-width="2.5"/>`
        : s.kind === "on-line" ? `<rect x="${s.x - 5}" y="${s.y - 5}" width="10" height="10" transform="rotate(45 ${s.x} ${s.y})" fill="none" stroke="${c}" stroke-width="2"/>`
        : s.kind === "axis" ? `<circle cx="${s.x}" cy="${s.y}" r="4" fill="${c}"/>` : `<circle cx="${s.x}" cy="${s.y}" r="6" fill="none" stroke="${c}" stroke-width="2.5"/>`);
      if (!startPx) label(s.x, s.y, MARK[s.kind]); }
  }
  // snip box, lasso loop, remove box
  if (st.down && st.down.moved && st.hover) {
    const a = st.down.p, b = st.hover;
    if (st.down.tool === "snip" || st.down.tool === "erase") out.push(`<rect x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" fill="${st.down.tool === "erase" ? "#cf222e22" : "#1f6feb18"}" stroke="${st.down.tool === "erase" ? "#cf222e" : "#1f6feb"}" stroke-width="2" stroke-dasharray="6 4"/>`);
    if (st.down.tool === "lasso") out.push(`<path d="M${st.down.path.map(q => q.join(",")).join("L")}Z" fill="#1f6feb18" stroke="#1f6feb" stroke-width="2" stroke-dasharray="6 4"/>`);
  }
  g.innerHTML = out.join("");
  svg.style.cursor = R ? "pointer" : t === "erase" ? "not-allowed" : t === "antenna" ? "copy" : "crosshair";
  const hint = document.getElementById("dfHint"); if (hint) hint.textContent = hintText(t);
  document.querySelectorAll("#dfTool [data-t]").forEach(b => b.classList.toggle("dw-shift", !st.down && t !== (D.dsTool || "antenna") && b.dataset.t === t));
  const tw = document.getElementById("dfToast"); if (tw) { const on = D.dsToast && D.dsToast.until > Date.now(); tw.hidden = !on; if (on) tw.textContent = D.dsToast.text; }
}
function hintText(t) {
  const D = cur.D;
  if (D.dsReview) return "Reviewing what was found: Enter adds the sure ones, Shift+Enter adds all, Esc discards. Click a dashed wall to leave it out.";
  const sh = t !== (D.dsTool || "antenna") ? " (Shift held)" : "";
  if (t === "wall") return D.dsWallStart ? "Click the wall's end (Shift: square to the plan; Ctrl: no snap). Esc stops." : `Drag along a wall, or click its start then its end${D.dsSnap === false ? "" : "; it snaps to walls and the plan's lines (X turns snap off)"}${sh}.`;
  if (t === "erase") return `Click an antenna or a wall to remove it, or drag a box around several${sh}.`;
  if (t === "snip") return `Drag a box: the walls inside are found${D.dsSmart ? ", each with its own material (Smart)" : `, all as ${DS_WALLS[+D.dsWall || 0][0]}`}.`;
  if (t === "lasso") return `Draw a loop around the walls (it closes where you started)${D.dsSmart ? "; Smart picks each one's material" : ""}.`;
  return `Click to place a server antenna${sh}.`;
}
function toast(text, ms = 4500) { if (!cur) return; cur.D.dsToast = {text, until: Date.now() + ms}; paint(); setTimeout(() => cur && paint(), ms + 50); }

/* ---------- the hint of the best tool for this plan ---------- */
function showBest() {
  const b = document.getElementById("dfBest"); if (!b || !cur) return;
  if (cur.lsState === "reading") { b.textContent = "Reading the plan's lines…"; b.disabled = true; b.title = ""; return; }
  const bv = PL().bestVariant(cur.ls); b.disabled = false;
  b.innerHTML = `<span aria-hidden="true">💡</span> ${esc(bv.text)}`; b.title = `${bv.why}${cur.ls ? ` (${cur.ls.src === "vector" ? "PDF vectors" : "the plan image"}, ${Math.round((cur.ls.conf || 0) * 100)}% sure of its lines)` : ""} Click to use it.`;
  b.dataset.conf = bv.conf >= 0.75 ? "hi" : bv.conf >= 0.5 ? "mid" : "lo";
  b.onclick = () => setTool(bv.tool, bv.smart);
  const sw = document.getElementById("dfScaleW");
  if (sw) { const ppi = cur.ls?.docPpi, wft = ppi ? cur.ls.W / (ppi * 12) : null;
    sw.hidden = !(wft && !cur.fl.width_ft); if (wft) { sw.textContent = `Use ${Math.round(wft)} ft (the drawing's scale)`; sw.onclick = () => cur.keep({width_ft: Math.round(wft * 10) / 10}); } }
}
function setTool(t, smart) { if (!cur) return; const D = cur.D; D.dsTool = t; if (smart != null) D.dsSmart = smart; D.dsWallStart = null; render(); }

/* ---------- keys ---------- */
const active = () => !!(cur && cur.svg.isConnected && window.RFKeys && RFKeys.visible(cur.svg));
function matStep(d) {
  const R = cur.D.dsReview, hp = R && st.hover ? nearestProposal(st.hover) : -1;
  if (hp >= 0) { const w = R.items[hp]; w.mi = (w.mi + d + DS_WALLS.length) % DS_WALLS.length; w.matConf = 1; w.matWhy = "you picked it"; w.conf = w.lineConf; review(); return; }
  RFKeys.cycle(document.getElementById("dfWall"), d);
}
function matSet(i) {
  if (i >= DS_WALLS.length) return; const R = cur.D.dsReview, hp = R && st.hover ? nearestProposal(st.hover) : -1;
  if (hp >= 0) { const w = R.items[hp]; w.mi = i; w.matConf = 1; w.matWhy = "you picked it"; w.conf = w.lineConf; review(); return; }
  const s = document.getElementById("dfWall"); if (s) { s.value = String(i); s.dispatchEvent(new Event("change", {bubbles: true})); }
  toast(`Wall type: ${DS_WALLS[i][0]}`, 2000);
}
function removeHovered() {
  if (!st.hover) return false; const R = cur.D.dsReview;
  if (R) { const i = nearestProposal(st.hover); if (i >= 0) { R.items[i].dropped = true; review(); } return; }
  const n = nearest(st.hover); if (!n) return false;
  if (n.kind === "antenna") keepU({antennas: cur.fl.antennas.filter((_, i) => i !== n.i)}); else keepU({walls: cur.fl.walls.filter((_, i) => i !== n.i)});
}
function escape() {
  const D = cur.D;
  if (st.down) { st.down = null; paint(); return; }
  if (D.dsReview) { D.dsReview = null; toast("Discarded."); review(); return; }
  if (D.dsWallStart) { D.dsWallStart = null; paint(); return; }
  return false;
}
const KEYS = {
  w: () => setTool("wall"), a: () => setTool("antenna"), e: () => setTool("erase"),
  s: () => setTool("snip", false), "shift+s": () => setTool("snip", true), l: () => setTool("lasso", false), "shift+l": () => setTool("lasso", true),
  delete: removeHovered, backspace: removeHovered,
  m: () => matStep(1), "shift+m": () => matStep(-1),
  b: () => RFKeys.cycle(document.getElementById("dfB"), 1), "shift+b": () => RFKeys.cycle(document.getElementById("dfB"), -1),
  f: () => RFKeys.cycle(document.getElementById("dfF"), 1), "shift+f": () => RFKeys.cycle(document.getElementById("dfF"), -1),
  x: () => { cur.D.dsSnap = cur.D.dsSnap === false; try { localStorage.setItem("rfr.wallSnap", cur.D.dsSnap ? "1" : "0"); } catch (e) { /* private window */ }
    const b = document.getElementById("dfSnap"); if (b) { b.setAttribute("aria-pressed", String(cur.D.dsSnap)); b.classList.toggle("on", cur.D.dsSnap); }
    toast(cur.D.dsSnap ? "Snap on." : "Snap off: walls go exactly where you click.", 2500); },
  "ctrl+z": () => undo(false), "ctrl+shift+z": () => undo(true), "ctrl+y": () => undo(true),
  enter: () => cur.D.dsReview ? acceptReview(false) : false, "shift+enter": () => cur.D.dsReview ? acceptReview(true) : false,
  escape,
};
for (let i = 1; i <= 10; i++) KEYS[String(i % 10)] = () => matSet(i - 1);
const LEGEND = [["W", "walls"], ["A", "antennas"], ["E", "remove"], ["S", "snip"], ["Shift+S", "smart snip"], ["L", "lasso"], ["Shift", "held: add ↔ remove"],
  ["M", "next wall type"], ["1-9", "wall type"], ["X", "snap"], ["Ctrl+Z", "undo"], ["Ctrl+Shift+Z", "redo"], ["Enter", "add found"], ["Esc", "cancel"], ["B", "band"], ["F", "floor"], ["[ ]", "floor"]];

/* ---------- mount: called by dsFloors on every draw ---------- */
function mount(c) {
  const same = cur && cur.j.id === c.j.id && cur.f.name === c.f.name && cur.f.plan === c.f.plan;
  cur = {...c, ls: same ? cur.ls : null, lsState: same ? cur.lsState : null};
  if (c.D.dsSnap == null) { try { c.D.dsSnap = localStorage.getItem("rfr.wallSnap") !== "0"; } catch (e) { c.D.dsSnap = true; } }
  if (!same) { st.down = null; st.hover = null; c.D.dsWallStart = null; }
  wire();
  const keys = document.getElementById("dfKeys"); if (keys && window.RFKeys) keys.innerHTML = RFKeys.legend(LEGEND);
  const sn = document.getElementById("dfSnap"); if (sn) sn.onclick = () => KEYS.x();
  const sm = document.getElementById("dfSmart"); if (sm) sm.onchange = () => { c.D.dsSmart = sm.checked; paint(); review(); };
  const u = document.getElementById("dfUndo"), r = document.getElementById("dfRedo"), H = hist();
  if (u) { u.onclick = () => undo(false); u.disabled = !H.u.length; } if (r) { r.onclick = () => undo(true); r.disabled = !H.r.length; }
  review(); paint();
  if (!c.f.plan) { cur.lsState = "none"; showBest(); return; }
  if (!cur.ls) {
    cur.lsState = "reading"; showBest();
    const mine = cur;
    lineSet(c.j, c.f, +c.fl.width_ft || null).then(ls => {
      if (cur !== mine && !(cur && cur.j.id === mine.j.id && cur.f.name === mine.f.name && cur.f.plan === mine.f.plan)) return;
      cur.ls = ls; cur.lsState = ls ? "ready" : "none"; cur.lsPx = null; showBest(); paint();
    }).catch(() => { if (cur) { cur.lsState = "none"; showBest(); } });
  } else showBest();
}
if (window.RFKeys) {
  RFKeys.scope("walls", {active, keys: KEYS});
  RFKeys.onShift(v => { st.e = {...(st.e || {}), shiftKey: v}; if (active()) paint(); });  // Shift pressed or let go with the pointer still
}
const STYLE = document.createElement("style");
STYLE.textContent = `#dfTool button.dw-shift{outline:2px dashed var(--warn,#d4a017);outline-offset:-3px}
#dfBest{border-style:dashed}#dfBest[data-conf="hi"]{border-color:var(--good,#2da44e)}#dfBest[data-conf="mid"]{border-color:var(--warn,#d4a017)}
#dfToast{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:rgba(20,24,30,.88);color:#fff;padding:6px 12px;border-radius:8px;font-size:13px;line-height:1.35;pointer-events:none;max-width:90%;z-index:2}
#dfReview{margin:0 0 8px;padding:8px 10px;border:1px dashed var(--line,#8886);border-radius:8px}`;
document.head.appendChild(STYLE);
return {mount, paint, hint: () => cur ? hintText(tool(st.e)) : "", lineSet, smartCtx, planSrc, undo, toast, get state() { return {cur, st}; }};
})();
