"use strict";
/* DAStastic — a floor plan's own lines, for the DAS wall tools (dswalls.js). Pure: no page needed, so node runs it too
   (tests/planlines_check.mjs scores it against drawn truth).
   Where the lines come from, best first:
     1. the PDF's vectors (opsToSegments over pdf.js's operator list, with the words from its text layer): exact lines,
        line weights, layers, fills, hatching, door swings and dimension lines;
     2. the plan image (rasterLines): dark runs stacked into bands, the drawing's angle found first;
     3. neither (a photo): nothing found, and it says so.
   Every wall found carries a confidence and the reason for it; every material guess carries its own. The editor adds
   walls without review only from vectors with every guess at 0.75 or better (dswalls.js).
   All geometry here is in the plan's own frame: PDF points (scale 1) or image pixels, y down. */
(() => {
const ALGO = 1;
const R2D = 180 / Math.PI;
// material keys: the wall types in dasdesign.js DS_WALLS (dswalls.js maps them by name)
const MAT = {drywall: "Drywall", conc4: "Concrete 4 in", conc8: "Concrete 8 in", conc12: "Concrete 12 in", rc8: "Reinforced concrete 8 in",
  cmu: "CMU block 8 in", brick: "Brick", brickcmu: "Brick veneer on CMU", glass: "Clear glass", lowe: "Low-E glass", wood: "Wood framing", shaft: "Elevator shaft"};

/* ---------- geometry ---------- */
const len = s => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
const angOf = s => ((Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * R2D) % 180 + 180) % 180;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d); };
const axisDiff = (a, main) => Math.min(angDiff(a, main), angDiff(a, main + 90));
function tOn(px, py, s) { const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy || 1e-12; return ((px - s.x1) * dx + (py - s.y1) * dy) / L2; }
function lineDist(px, py, s) { const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L = Math.hypot(dx, dy) || 1e-12; return Math.abs((px - s.x1) * dy - (py - s.y1) * dx) / L; }
function segDist(px, py, s) { const t = Math.max(0, Math.min(1, tOn(px, py, s))); return Math.hypot(px - (s.x1 + t * (s.x2 - s.x1)), py - (s.y1 + t * (s.y2 - s.y1))); }
function segSegDist(a, b) { if (cross(a, b)) return 0; return Math.min(segDist(a.x1, a.y1, b), segDist(a.x2, a.y2, b), segDist(b.x1, b.y1, a), segDist(b.x2, b.y2, a)); }
// where two segments cross: {x, y, t, u} with t, u along each (0-1), or null
function cross(a, b, ext = 0) {
  const rx = a.x2 - a.x1, ry = a.y2 - a.y1, sx = b.x2 - b.x1, sy = b.y2 - b.y1, d = rx * sy - ry * sx;
  if (Math.abs(d) < 1e-12) return null;
  const qx = b.x1 - a.x1, qy = b.y1 - a.y1, t = (qx * sy - qy * sx) / d, u = (qx * ry - qy * rx) / d;
  const ea = ext / (Math.hypot(rx, ry) || 1), eb = ext / (Math.hypot(sx, sy) || 1);
  if (t < -ea || t > 1 + ea || u < -eb || u > 1 + eb) return null;
  return {x: a.x1 + t * rx, y: a.y1 + t * ry, t, u};
}
// the part of b that lies along a (both projected on a's line): [t0, t1] in a's 0-1, or null
function overlapOn(a, b) {
  const t0 = tOn(b.x1, b.y1, a), t1 = tOn(b.x2, b.y2, a), lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
  return hi > lo ? [lo, hi] : null;
}
const at = (s, t) => [s.x1 + t * (s.x2 - s.x1), s.y1 + t * (s.y2 - s.y1)];
const mid = s => [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// a segment's direction folded to 0-90 against the plan's main angle; the main angle from long lines (length-weighted)
function mainAngle(segs, minLen) {
  const bins = new Float64Array(180);  // 0.5 degree bins over 0-90
  for (const s of segs) { const L = len(s); if (L < minLen) continue; bins[Math.floor((angOf(s) % 90) * 2) % 180] += L; }
  let best = 0; for (let i = 1; i < 180; i++) if (bins[i] + bins[(i + 1) % 180] + bins[(i + 179) % 180] > bins[best] + bins[(best + 1) % 180] + bins[(best + 179) % 180]) best = i;
  return best / 2;
}

/* ---------- 1. PDF vectors ---------- */
// pdf.js's operator list (page.getOperatorList()) to lines in the shown page's frame (viewport at scale 1).
//   view: {transform, width, height} from page.getViewport({scale:1}); ocNames: {OCG id: layer name}
// Returns {W, H, segs:[{x1,y1,x2,y2,w,oc,k:"s"|"f"}], curves:[{x1,y1,x2,y2,w,oc}], fills:[{x0,y0,x1,y1,oc}]}
function opsToSegments(fnArray, argsArray, OPS, view, ocNames = {}) {
  const segs = [], curves = [], fills = [];
  let ctm = view.transform.slice(), lw = 1, path = [];
  const stack = [], oc = [];
  const curOc = () => oc.length ? oc[oc.length - 1] : null;
  const sc = () => Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
  const push = () => stack.push([ctm, lw]);
  const pop = () => { if (stack.length) [ctm, lw] = stack.pop(); };
  const build = (ops, a) => {  // pdf.js constructPath: [ops], flat args
    let k = 0, cx = 0, cy = 0, sub = null;
    const P = (x, y) => apply(ctm, x, y);
    for (const op of ops) {
      if (op === OPS.moveTo) { cx = a[k++]; cy = a[k++]; sub = {start: P(cx, cy), cur: P(cx, cy), edges: [], closed: false}; path.push(sub); }
      else if (op === OPS.lineTo) { const p = P(a[k], a[k + 1]); cx = a[k++]; cy = a[k++]; if (!sub) { sub = {start: p, cur: p, edges: [], closed: false}; path.push(sub); continue; } sub.edges.push({c: 0, a: sub.cur, b: p}); sub.cur = p; }
      else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
        let c1, c2, e;
        if (op === OPS.curveTo) { c1 = P(a[k], a[k + 1]); c2 = P(a[k + 2], a[k + 3]); e = P(a[k + 4], a[k + 5]); cx = a[k + 4]; cy = a[k + 5]; k += 6; }
        else if (op === OPS.curveTo2) { c1 = sub ? sub.cur : P(cx, cy); c2 = P(a[k], a[k + 1]); e = P(a[k + 2], a[k + 3]); cx = a[k + 2]; cy = a[k + 3]; k += 4; }
        else { c1 = P(a[k], a[k + 1]); e = P(a[k + 2], a[k + 3]); c2 = e; cx = a[k + 2]; cy = a[k + 3]; k += 4; }
        if (!sub) { sub = {start: e, cur: e, edges: [], closed: false}; path.push(sub); continue; }
        sub.edges.push({c: 1, a: sub.cur, b: e, c1, c2}); sub.cur = e;
      }
      else if (op === OPS.closePath) { if (sub) { if (Math.hypot(sub.cur[0] - sub.start[0], sub.cur[1] - sub.start[1]) > 1e-9) sub.edges.push({c: 0, a: sub.cur, b: sub.start}); sub.closed = true; sub.cur = sub.start; } }
      else if (op === OPS.rectangle) {
        const x = a[k++], y = a[k++], w = a[k++], h = a[k++], p = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)];
        sub = {start: p[0], cur: p[0], edges: p.map((q, i) => ({c: 0, a: q, b: p[(i + 1) % 4]})), closed: true, rect: true}; path.push(sub);
      }
    }
  };
  const stroke = () => {
    const w = (lw > 0 ? lw : 0.25) * sc(), o = curOc();
    for (const sp of path) for (const e of sp.edges) {
      if (e.c) curves.push({x1: e.a[0], y1: e.a[1], x2: e.b[0], y2: e.b[1], c1: e.c1, c2: e.c2, w, oc: o});
      else if (e.a[0] !== e.b[0] || e.a[1] !== e.b[1]) segs.push({x1: e.a[0], y1: e.a[1], x2: e.b[0], y2: e.b[1], w, oc: o, k: "s"});
    }
  };
  const fill = () => {
    const o = curOc();
    for (const sp of path) {
      if (sp.edges.some(e => e.c) || sp.edges.length < 3) continue;
      const pts = sp.edges.map(e => e.a);
      // a thin quadrilateral: a wall band (poche); its centreline, as wide as its short side
      if (pts.length === 4) {
        const L = i => Math.hypot(pts[(i + 1) % 4][0] - pts[i][0], pts[(i + 1) % 4][1] - pts[i][1]), a = L(0), b = L(1);
        const [lng, sht] = a >= b ? [0, 1] : [1, 0], Ls = Math.min(a, b), Ll = Math.max(a, b);
        if (Ls > 0 && Ll >= 3 * Ls) {
          const m1 = [(pts[sht][0] + pts[(sht + 1) % 4][0]) / 2, (pts[sht][1] + pts[(sht + 1) % 4][1]) / 2], m2 = [(pts[sht + 2][0] + pts[(sht + 3) % 4][0]) / 2, (pts[sht + 2][1] + pts[(sht + 3) % 4][1]) / 2];
          segs.push({x1: m1[0], y1: m1[1], x2: m2[0], y2: m2[1], w: Ls, oc: o, k: "f"}); void lng; continue;
        }
      }
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      fills.push({x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), oc: o});
    }
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: push(); break;
      case OPS.restore: pop(); break;
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.paintFormXObjectBegin: push(); if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = mul(ctm, a[0]); break;
      case OPS.paintFormXObjectEnd: pop(); break;
      case OPS.beginGroup: push(); if (a && a[0] && Array.isArray(a[0].matrix)) ctm = mul(ctm, a[0].matrix); break;
      case OPS.endGroup: pop(); break;
      case OPS.setLineWidth: lw = a[0]; break;
      case OPS.setGState: for (const kv of a[0] || []) if (kv[0] === "LW") lw = kv[1]; break;
      case OPS.beginMarkedContentProps: {
        const p = a && a[1];
        oc.push(a && a[0] === "OC" && p ? (p.type === "OCG" ? (ocNames[p.id] ?? String(p.id)) : (p.ids || []).map(x => ocNames[x] ?? x).join(" ") || curOc()) : curOc()); break; }
      case OPS.beginMarkedContent: oc.push(curOc()); break;
      case OPS.endMarkedContent: oc.pop(); break;
      case OPS.constructPath: build(a[0], a[1]); break;
      case OPS.stroke: stroke(); path = []; break;
      case OPS.closeStroke: for (const sp of path) if (!sp.closed && sp.edges.length) sp.edges.push({c: 0, a: sp.cur, b: sp.start}); stroke(); path = []; break;
      case OPS.fill: case OPS.eoFill: fill(); path = []; break;
      case OPS.fillStroke: case OPS.eoFillStroke: fill(); stroke(); path = []; break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: for (const sp of path) if (!sp.closed && sp.edges.length) sp.edges.push({c: 0, a: sp.cur, b: sp.start}); fill(); stroke(); path = []; break;
      case OPS.endPath: path = []; break;
      default: break;
    }
  }
  return {W: view.width, H: view.height, segs, curves, fills};
}
// pdf.js text items (page.getTextContent()) to words in the same frame: {s, x, y, h} (centre, height)
function textWords(items, view) {
  const T = view.transform, out = [];
  for (const it of items || []) {
    const s = String(it.str || "").trim(); if (!s) continue;
    const m = it.transform, h = it.height || Math.hypot(m[2], m[3]) || 8, wd = it.width || s.length * h * 0.5;
    const dl = Math.hypot(m[0], m[1]) || 1, ul = Math.hypot(m[2], m[3]) || 1;
    const bx = m[4] + m[0] / dl * wd / 2 + m[2] / ul * h * 0.35, by = m[5] + m[1] / dl * wd / 2 + m[3] / ul * h * 0.35;
    const [x, y] = apply(T, bx, by), sc = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2])) || 1;
    // rot: the way the word reads on the shown page, in quarter turns (0 across, 270 up the sheet: the title strip on many drawings)
    const rot = (Math.round(Math.atan2(T[1] * m[0] + T[3] * m[1], T[0] * m[0] + T[2] * m[1]) * R2D / 90) * 90 + 360) % 360;
    out.push({s, x, y, h: h * sc, w: wd * sc, rot});
  }
  return out;
}
// a scale as written: 1/8" = 1'-0", 1 1/2" = 1'-0", 1/4 in = 1 ft, 1" = 20', 1:96 -> page points per foot, or null
function scaleOfText(raw) {
  const s = String(raw || "").replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'");
  let m = /(?:(?<![\w.-])(\d)[\s-]+)?(\d+)\s*\/\s*(\d+)\s*(?:"|''|in\.?|inch(?:es)?)?\s*=\s*1\s*(?:'|ft|foot)/i.exec(s);
  if (m) { const inches = (+m[1] || 0) + +m[2] / +m[3]; return inches > 0 && inches <= 3 ? 72 * inches : null; }
  m = /(\d+(?:\.\d+)?)\s*(?:"|in\.?)\s*=\s*(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)/i.exec(s);  // an engineer's scale: 1 in = 20 ft
  if (m) { const k = +m[1] / +m[2]; return k > 0 && k <= 3 ? 72 * k : null; }
  m = /(?<![\d:])1\s*:\s*(\d{2,4})(?![\d:])/.exec(s);  // a ratio counts only beside the word, or alone: 1:30 can be a time
  if (m && (/\bscale\b/i.test(s) || /^\s*1\s*:\s*\d{2,4}\s*$/.test(s))) return 864 / +m[1];
  return null;
}
// the drawing's scale from its words ("SCALE: 1/8" = 1'-0"", "1/4 in = 1 ft"): page points per foot, or null
function scaleFromWords(words) {
  for (const w of words || []) { const k = scaleOfText(w.s); if (k) return k; }
  return null;
}

// collinear pieces into one (the same line drawn in parts); keeps the heavier width
function mergeCollinear(segs, o = {}) {
  const ang = o.ang ?? 0.6, dist = o.dist ?? 1, gap = o.gap ?? 1, same = o.same || (() => true);
  const S = segs.map(s => ({...s})), dead = new Uint8Array(S.length);
  let changed = true;
  while (changed) {
    changed = false;
    const order = S.map((_, i) => i).filter(i => !dead[i]).sort((i, j) => len(S[j]) - len(S[i]));
    for (const i of order) {
      if (dead[i]) continue; const a = S[i], aa = angOf(a), La = len(a);
      for (const j of order) {
        if (j === i || dead[j]) continue; const b = S[j];
        if (!same(a, b) || angDiff(aa, angOf(b)) > ang) continue;
        const d = Math.max(o.dist ? 0 : 0, Math.max(dist, Math.min(a.w || 0, b.w || 0) / 2));
        if (lineDist(b.x1, b.y1, a) > d || lineDist(b.x2, b.y2, a) > d) continue;
        const t0 = tOn(b.x1, b.y1, a), t1 = tOn(b.x2, b.y2, a), lo = Math.min(t0, t1), hi = Math.max(t0, t1), g = gap / (La || 1);
        if (hi < -g || lo > 1 + g) continue;
        const nl = Math.min(0, lo), nh = Math.max(1, hi), p = at(a, nl), q = at(a, nh);
        a.x1 = p[0]; a.y1 = p[1]; a.x2 = q[0]; a.y2 = q[1]; a.w = Math.max(a.w || 0, b.w || 0); a.px = (a.px || 0) + (b.px || 0);
        dead[j] = 1; changed = true;
      }
    }
  }
  return S.filter((_, i) => !dead[i]);
}
// parallel lines a wall's thickness apart, as one wall on its centreline: triples (curtain wall, glazing) first, then
// pairs. range: [min, max] gap between the lines' centres. Returns {walls, rest}
function pairWalls(segs, range, o = {}) {
  const [gmin, gmax] = range, n = segs.length, used = new Uint8Array(n), walls = [], A = segs.map(angOf);
  const ovFrac = (a, b) => { const ov = overlapOn(a, b); if (!ov) return 0; return (ov[1] - ov[0]) * len(a) / Math.min(len(a), len(b)); };
  const off = (a, b) => { const [mx, my] = mid(b), dx = a.x2 - a.x1, dy = a.y2 - a.y1, L = Math.hypot(dx, dy) || 1; return ((mx - a.x1) * dy - (my - a.y1) * dx) / L; };
  const cand = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = segs[i], b = segs[j];
    if (angDiff(A[i], A[j]) > 2) continue;
    if (o.sameWeight && Math.max(a.w || 1, b.w || 1) / Math.max(1e-6, Math.min(a.w || 1, b.w || 1)) > 2.6) continue;
    const d = Math.abs(off(a, b)); if (d < gmin || d > gmax) continue;
    if (d - ((a.w || 0) + (b.w || 0)) / 2 < 0.6) continue;  // they touch: one thick line, not two
    const f = ovFrac(a, b); if (f < 0.5) continue;
    cand.push([i, j, d, f]);
  }
  // triples: a line with partners on both sides at about half the spread each
  const byI = new Map(); for (const c of cand) { for (const [p, q] of [[c[0], c[1]], [c[1], c[0]]]) { if (!byI.has(p)) byI.set(p, []); byI.get(p).push([q, off(segs[p], segs[q]), c[3]]); } }
  for (const [m, list] of byI) {
    if (used[m]) continue;
    const L = list.filter(x => x[1] < 0 && !used[x[0]]), R = list.filter(x => x[1] > 0 && !used[x[0]]);
    let best = null;
    for (const l of L) for (const r of R) { const dl = -l[1], dr = r[1]; if (dl + dr > gmax || Math.abs(dl - dr) > 0.3 * (dl + dr)) continue;
      if (o.tripleGap && Math.min(dl, dr) < Math.max(o.tripleGap, 1.5 * Math.max(segs[l[0]].w || 0, segs[r[0]].w || 0, segs[m].w || 0))) continue;
      { const lm = len(segs[m]), ll = len(segs[l[0]]), lr = len(segs[r[0]]); if (lm < 0.6 * Math.min(ll, lr) || Math.min(ll, lr) < 0.6 * Math.max(ll, lr)) continue; }
      if ((segs[l[0]].w || 0) > 1.6 * (segs[m].w || 1) && (segs[r[0]].w || 0) > 1.6 * (segs[m].w || 1)) continue;
      if (!best || l[2] + r[2] > best[2]) best = [l[0], r[0], l[2] + r[2], dl + dr]; }
    if (!best) continue;
    const [li, ri, , spread] = best, s = segs[m], ov = overlapOn(s, segs[li]), ov2 = overlapOn(s, segs[ri]);
    if (!ov || !ov2) continue;
    // a triple of a heavier pair with a thin middle line is a wall with its centre line drawn, not glazing: let pairs take it
    if (o.tripleThin && Math.max(segs[li].w || 0, segs[ri].w || 0, s.w || 0) > o.tripleThin) continue;
    const lo = Math.min(ov[0], ov2[0]), hi = Math.max(ov[1], ov2[1]), p = at(s, Math.min(lo, 0)), q = at(s, Math.max(hi, 1));
    used[m] = used[li] = used[ri] = 1;
    walls.push({x1: p[0], y1: p[1], x2: q[0], y2: q[1], t: spread, k: "triple", faces: [segs[li], s, segs[ri]], fw: s.w || 0});
  }
  cand.sort((x, y) => (x[2] - y[2]) || (y[3] - x[3]));
  const rest = [];
  for (const [i, j, d] of cand) {
    if (used[i] || used[j]) continue;
    const a = segs[i], b = segs[j], La = len(a), Lb = len(b), [l, s] = La >= Lb ? [a, b] : [b, a];
    const ov = overlapOn(l, s); if (!ov) continue;
    const dir = off(l, s) > 0 ? 1 : -1, dx = l.x2 - l.x1, dy = l.y2 - l.y1, L = Math.hypot(dx, dy), nx = -dy / L * dir * d / 2, ny = dx / L * dir * d / 2;
    const cover = (ov[1] - ov[0]);
    const [t0, t1] = cover >= 0.8 ? [Math.min(0, tOn(s.x1, s.y1, l), tOn(s.x2, s.y2, l)), Math.max(1, tOn(s.x1, s.y1, l), tOn(s.x2, s.y2, l))] : ov;
    const p = at(l, t0), q = at(l, t1);
    walls.push({x1: p[0] - nx, y1: p[1] - ny, x2: q[0] - nx, y2: q[1] - ny, t: d, k: "pair", faces: [a, b], fw: Math.max(a.w || 0, b.w || 0)});
    used[i] = used[j] = 1;
    if (cover < 0.8) for (const [u0, u1] of [[0, ov[0]], [ov[1], 1]]) if ((u1 - u0) * L >= (o.minLen || 0)) { const pp = at(l, u0), qq = at(l, u1); rest.push({...l, x1: pp[0], y1: pp[1], x2: qq[0], y2: qq[1]}); }
  }
  for (let i = 0; i < n; i++) if (!used[i]) rest.push(segs[i]);
  return {walls, rest};
}
// a shorter line lying on a longer, heavier one (a grey room outline over a dark exterior, a dock door on its wall)
function absorb(segs) {
  const S = segs.slice().sort((a, b) => len(b) - len(a)), keep = [];
  for (const a of S) {
    const ta = a.t ?? a.w ?? 1, aa = angOf(a);
    const host = keep.find(b => { const tb = b.t ?? b.w ?? 1, d = (ta + tb) / 2 + 1.5;
      if (angDiff(aa, angOf(b)) > 3 || lineDist(a.x1, a.y1, b) > d || lineDist(a.x2, a.y2, b) > d) return false;
      const t0 = tOn(a.x1, a.y1, b), t1 = tOn(a.x2, a.y2, b), slack = 3 / (len(b) || 1);
      return Math.min(t0, t1) >= -slack && Math.max(t0, t1) <= 1 + slack; });
    if (host) { host.t = Math.max(host.t ?? host.w ?? 1, Math.min(ta + lineDist(...mid(a), host) , ta * 3)); continue; }
    keep.push(a);
  }
  return keep;
}
// lines touching each other, grouped; returns cluster id per segment and each cluster's {len, box}
function clusters(segs, tol, keyOf) {
  const n = segs.length, par = Array.from({length: n}, (_, i) => i), f = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  if (keyOf) { const first = new Map(); segs.forEach((s, i) => { const k = keyOf(s); if (!k) return; if (first.has(k)) par[f(i)] = f(first.get(k)); else first.set(k, i); }); }
  const box = s => [Math.min(s.x1, s.x2) - tol, Math.min(s.y1, s.y2) - tol, Math.max(s.x1, s.x2) + tol, Math.max(s.y1, s.y2) + tol];
  const B = segs.map(box);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = B[i], b = B[j]; if (a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]) continue;
    if (segSegDist(segs[i], segs[j]) <= tol + (keyOf ? 0 : ((segs[i].t || 0) + (segs[j].t || 0)) / 2)) par[f(i)] = f(j);
  }
  const id = segs.map((_, i) => f(i)), info = new Map();
  segs.forEach((s, i) => { const c = info.get(id[i]) || {len: 0, n: 0, box: [Infinity, Infinity, -Infinity, -Infinity], kinds: new Set()};
    c.len += len(s); c.wlen = (c.wlen || 0) + len(s) * (s.k === "single" ? 1 : 2.5); c.n++; c.box = [Math.min(c.box[0], s.x1, s.x2), Math.min(c.box[1], s.y1, s.y2), Math.max(c.box[2], s.x1, s.x2), Math.max(c.box[3], s.y1, s.y2)]; c.kinds.add(s.k); info.set(id[i], c); });
  return {id, info};
}

// the sheet's frame: a long line hugging each of the four page edges with nothing drawn beyond any of them. A plan drawn
// close to the edge isn't a frame: something (its title, a scale bar) lies outside one side. outside(side, line) says
// whether there's ink beyond that line.
function frameOf(segs, W, H, outside, e = 0.045) {
  const pick = {top: null, bottom: null, left: null, right: null};
  for (const s of segs) { const a = angOf(s);
    if (angDiff(a, 0) < 2 && len(s) > 0.5 * W) { const y = Math.max(s.y1, s.y2), y0 = Math.min(s.y1, s.y2);
      if (y < e * H && (!pick.top || y < Math.max(pick.top.y1, pick.top.y2))) pick.top = s; if (y0 > (1 - e) * H && (!pick.bottom || y0 > Math.min(pick.bottom.y1, pick.bottom.y2))) pick.bottom = s; }
    if (angDiff(a, 90) < 2 && len(s) > 0.5 * H) { const x = Math.max(s.x1, s.x2), x0 = Math.min(s.x1, s.x2);
      if (x < e * W && (!pick.left || x < Math.max(pick.left.x1, pick.left.x2))) pick.left = s; if (x0 > (1 - e) * W && (!pick.right || x0 > Math.min(pick.right.x1, pick.right.x2))) pick.right = s; } }
  if (!pick.top || !pick.bottom || !pick.left || !pick.right) return [];
  for (const k in pick) if (outside(k, pick[k])) return [];
  return Object.values(pick);
}

// thresholds by Otsu over values with weights (line widths by length; gray levels by count)
function otsu(vals, wts) {
  const idx = vals.map((_, i) => i).sort((i, j) => vals[i] - vals[j]); let W = 0, M = 0;
  for (const i of idx) { W += wts[i]; M += wts[i] * vals[i]; }
  let w0 = 0, m0 = 0, best = -1, thr = vals[idx[0]];
  for (let k = 0; k < idx.length - 1; k++) {
    const i = idx[k]; w0 += wts[i]; m0 += wts[i] * vals[i]; if (vals[idx[k + 1]] === vals[i]) continue;
    const w1 = W - w0; if (!w0 || !w1) continue; const mu0 = m0 / w0, mu1 = (M - m0) / w1, v = w0 * w1 * (mu0 - mu1) ** 2;
    if (v > best) { best = v; thr = (vals[i] + vals[idx[k + 1]]) / 2; }
  }
  return thr;
}

const WALL_LAYER = /WALL|PARTN|PARTITION/i;
// the vector pipeline: raw segments (opsToSegments) and words to wall candidates
//   opts.width_ft: the plan's real width, for wall thickness in inches (else the drawing's scale words)
function vectorLines(raw, words = [], opts = {}) {
  const W = raw.W, H = raw.H, diag = Math.hypot(W, H), tol = 0.0025 * diag;
  const all = raw.segs.filter(s => len(s) > 1e-6 * diag).map(s => ({...s}));
  const ptPerFt = opts.width_ft ? W / opts.width_ft : scaleFromWords(words), ppi = ptPerFt ? ptPerFt / 12 : null;
  const main = mainAngle(all.filter(s => s.k === "s"), 0.02 * diag);
  const st = {raw: all.length, border: 0, door: 0, dim: 0, hatch: 0, tiny: 0};
  // the sheet's frame
  { const beyond = (side, l) => { const m = 1.5 + (l.w || 0), lim = side === "top" ? Math.min(l.y1, l.y2) - m : side === "bottom" ? Math.max(l.y1, l.y2) + m : side === "left" ? Math.min(l.x1, l.x2) - m : Math.max(l.x1, l.x2) + m;
      const out = (x, y) => side === "top" ? y < lim : side === "bottom" ? y > lim : side === "left" ? x < lim : x > lim;
      return all.some(s => s !== l && out(...mid(s))) || words.some(wd => out(wd.x, wd.y)); };
    for (const s of frameOf(all, W, H, beyond)) { s.drop = "border"; st.border++; } }
  // door leaves: a straight line from an arc's end, about the arc's radius long
  for (const c of raw.curves) {
    const chord = Math.hypot(c.x2 - c.x1, c.y2 - c.y1); if (chord < 0.004 * diag) continue;
    const r = chord / Math.SQRT2;
    for (const s of all) { if (s.drop) continue; const L = len(s); if (Math.abs(L - r) > 0.3 * r) continue;
      for (const [ex, ey] of [[c.x1, c.y1], [c.x2, c.y2]]) if (Math.min(Math.hypot(s.x1 - ex, s.y1 - ey), Math.hypot(s.x2 - ex, s.y2 - ey)) < tol) { s.drop = "door"; st.door++; break; } }
  }
  // hatching: short lines off the main axes, several parallel together
  const hc = all.filter(s => !s.drop && s.k === "s" && len(s) < 0.03 * diag && axisDiff(angOf(s), main) > 10);
  const hatch = [];
  for (const s of hc) { const [mx, my] = mid(s), a = angOf(s);
    if (hc.filter(t => t !== s && angDiff(angOf(t), a) < 3 && Math.hypot(...mid(t).map((v, i) => v - [mx, my][i])) < 0.03 * diag).length >= 2) { s.drop = "hatch"; hatch.push(mid(s)); st.hatch++; } }
  // dimension lines: ticks at 30-60 degrees across both ends; then their extension lines
  const short = all.filter(s => !s.drop && len(s) < 0.015 * diag), wsorted = all.filter(s => !s.drop).map(s => s.w || 0).sort((a, b) => a - b), thinW = wsorted.length ? wsorted[Math.floor(wsorted.length * 0.5)] : 0;
  const ticked = (s, x, y) => short.some(t => t !== s && segDist(x, y, t) < tol && Math.hypot(...mid(t).map((v, i) => v - [x, y][i])) < 0.6 * len(t) + tol && angDiff(angOf(t), angOf(s)) >= 28 && angDiff(angOf(t), angOf(s)) <= 62);
  const dims = [];
  for (const s of all) { if (s.drop || len(s) < 0.02 * diag || (s.w || 0) > thinW * 1.01) continue;
    if (ticked(s, s.x1, s.y1) && ticked(s, s.x2, s.y2)) { s.drop = "dim"; dims.push(s); st.dim++; } }
  for (const s of short) if (!s.drop && dims.some(d => (segDist(s.x1, s.y1, d) < tol || segDist(s.x2, s.y2, d) < tol) && angDiff(angOf(s), angOf(d)) >= 28 && angDiff(angOf(s), angOf(d)) <= 62)) { s.drop = "dim"; st.dim++; }
  for (const s of all) { if (s.drop || len(s) > 0.06 * diag || (s.w || 0) > thinW * 1.01) continue;
    if (dims.some(d => angDiff(angOf(s), angOf(d)) > 80 && [[d.x1, d.y1], [d.x2, d.y2]].some(([x, y]) => lineDist(x, y, s) < tol && segDist(x, y, s) < 0.035 * diag && segDist(x, y, s) > 0.2 * tol))) { s.drop = "dim"; st.dim++; } }
  const minLen = 0.008 * diag;
  for (const s of all) if (!s.drop && len(s) < minLen) { s.drop = "tiny"; st.tiny++; }
  let cand = all.filter(s => !s.drop);
  const layered = cand.some(s => s.oc && WALL_LAYER.test(s.oc));
  // the same line drawn in pieces, then the wall faces into walls
  cand = mergeCollinear(cand, {ang: 0.5, dist: 0.0008 * diag, gap: 0.001 * diag, same: (a, b) => a.k === b.k && a.oc === b.oc && Math.abs((a.w || 0) - (b.w || 0)) <= 0.25 * Math.max(a.w || 0, b.w || 0)});
  const fillsegs = cand.filter(s => s.k === "f"), strokes = cand.filter(s => s.k === "s");
  const range = ppi ? [2.5 * ppi, 16.5 * ppi] : [0.0012 * W, 0.012 * W];
  const lw = strokes.map(s => s.w || 0), lwLen = strokes.map(len);
  const {walls: paired, rest} = pairWalls(strokes, range, {sameWeight: true, minLen});
  // a fill along a pair is its poche (solid); hatching between the faces makes it hatched; a fill alone is a wall band
  for (const p of paired) {
    const f = fillsegs.find(fs => !fs.used && angDiff(angOf(fs), angOf(p)) < 2 && lineDist(...mid(fs), p) < p.t / 2 && (overlapOn(p, fs)?.[1] - overlapOn(p, fs)?.[0] || 0) * len(p) > 0.5 * Math.min(len(p), len(fs)));
    if (f) { f.used = true; p.fill = "solid"; continue; }
    const inside = hatch.filter(([x, y]) => lineDist(x, y, p) < p.t / 2 + tol * 0.2 && tOn(x, y, p) > -0.01 && tOn(x, y, p) < 1.01).length;
    if (inside >= 2) p.fill = "hatch";
    if (raw.fills.some(fr => { const [mx, my] = mid(p); return mx >= fr.x0 && mx <= fr.x1 && my >= fr.y0 && my <= fr.y1 && Math.min(fr.x1 - fr.x0, fr.y1 - fr.y0) < p.t * 1.6; })) p.fill = p.fill || "solid";
  }
  const bands = fillsegs.filter(f => !f.used).map(f => ({x1: f.x1, y1: f.y1, x2: f.x2, y2: f.y2, t: f.w, k: "fill", fill: "solid", oc: f.oc}));
  // single lines: heavy ones may be walls, light ones are details
  const faceW = paired.flatMap(p => p.faces.map(f => f.w || 0)).sort((a, b) => a - b), faceMed = faceW.length ? faceW[faceW.length >> 1] : null;
  const heavyThr = lw.length ? (faceMed != null ? 0.75 * faceMed : otsu(lw.map(v => Math.log(v + 1e-6)), lwLen)) : 0;
  const distinct = lw.length && Math.max(...lw) / Math.max(1e-6, Math.min(...lw)) >= 1.4;
  const singles = rest.map(s => {
    const heavy = faceMed != null ? (s.w || 0) >= heavyThr : distinct ? Math.log((s.w || 0) + 1e-6) >= heavyThr : null;
    return {x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, t: s.w || 0, k: "single", oc: s.oc, heavy}; });
  let W2 = [...paired.map(p => ({...p, oc: p.faces[0].oc})), ...bands, ...singles];
  W2.forEach(w => {
    if (layered) { const on = w.oc && WALL_LAYER.test(w.oc);
      w.conf = on ? 0.96 : 0.2; w.why = on ? `on the drawing's wall layer (${w.oc})` : `on layer ${w.oc || "none"}, not a wall layer`; return; }
    if (w.k === "pair") { w.conf = 0.92; w.why = "two parallel lines a wall's thickness apart"; }
    else if (w.k === "triple") { w.conf = 0.9; w.why = "three thin parallel lines: a glazed wall"; }
    else if (w.k === "fill") { w.conf = 0.88; w.why = "a filled band (poche)"; }
    else if (w.heavy === true) { w.conf = 0.72; w.why = "a single heavy line"; }
    else if (w.heavy === false) { w.conf = 0.3; w.why = "a thin line: furniture, a fixture or a detail"; }
    else { w.conf = 0.55; w.why = "a single line (every line is the same weight here)"; }
  });
  // the building: the biggest group of touching walls; anything outside it is title block, notes or a key plan
  W2 = placeAndScore(W2, W, H, ppi, {vector: true, angle: main > 45 ? main - 90 : main});
  const walls = W2.filter(w => w.conf >= 0.5), lines = W2.filter(w => w.conf < 0.5);
  const wl = walls.reduce((a, w) => a + len(w), 0), strong = walls.filter(w => w.k !== "single").reduce((a, w) => a + len(w), 0);
  const quality = layered ? "layer" : !walls.length ? "none" : strong >= 0.5 * wl || (distinct && walls.length >= 4) ? "clean" : "messy";
  const conf = layered ? 0.95 : quality === "clean" ? 0.9 : quality === "messy" ? 0.6 : 0.1;
  const docPt = scaleFromWords(words);
  return finish({src: "vector", W, H, ppi, docPpi: docPt ? docPt / 12 : null, angle: main, quality, conf, walls, lines, words, stats: {...st, pairs: paired.length, bands: bands.length, singles: singles.length}});
}

// shared by both: where each candidate sits (inside the building or out), small isolated boxes, and the final confidence
function placeAndScore(W2, W, H, ppi, o) {
  const diag = Math.hypot(W, H), strong = W2.filter(w => w.conf >= 0.5);
  if (!strong.length) return W2;
  const {id, info} = o.keyOf ? clusters(strong, 2, o.keyOf) : clusters(strong, 0.004 * diag);
  let mainId = null; for (const [k, c] of info) if (mainId == null || c.wlen > info.get(mainId).wlen) mainId = k;
  const a = -(o.angle || 0) / R2D, ca = Math.cos(a), sa = Math.sin(a), turn = (x, y) => [W / 2 + (x - W / 2) * ca - (y - H / 2) * sa, H / 2 + (x - W / 2) * sa + (y - H / 2) * ca];
  const mb = [Infinity, Infinity, -Infinity, -Infinity]; strong.forEach((w, i) => { if (id[i] !== mainId) return; for (const [x, y] of [turn(w.x1, w.y1), turn(w.x2, w.y2)]) { mb[0] = Math.min(mb[0], x); mb[1] = Math.min(mb[1], y); mb[2] = Math.max(mb[2], x); mb[3] = Math.max(mb[3], y); } });
  const pad = 0.004 * diag;
  strong.forEach((w, i) => {
    const c = info.get(id[i]); if (id[i] === mainId) return;
    const [mx, my] = turn(...mid(w));
    if (mx < mb[0] - pad || mx > mb[2] + pad || my < mb[1] - pad || my > mb[3] + pad) { w.conf = Math.min(w.conf, 0.25); w.why = "outside the building's outline (title block, notes or a key)"; return; }
    const bw = c.box[2] - c.box[0], bh = c.box[3] - c.box[1], small = Math.max(bw, bh), narrow = Math.min(bw, bh);
    const onlySingles = c.kinds.size === 1 && c.kinds.has("single");
    if (onlySingles && c.n <= 6 && (ppi ? small < 7 * 12 * ppi : small < 0.06 * Math.min(W, H))) { w.conf = Math.min(w.conf, 0.35); w.why = "a small box on its own: furniture or a fixture?"; return; }
    if (onlySingles && c.n <= 6 && narrow > 0 && small / narrow >= 5) { w.conf = Math.min(w.conf, 0.4); w.why = "a long narrow box on its own: racking, shelving or a counter?"; }
  });
  return W2;
}

// the finished line set: walls with their crossings and ends (snap points), rounded for the cache
function finish(ls) {
  const W = ls.walls, pts = [], diag = Math.hypot(ls.W, ls.H), tol = 0.004 * diag;
  for (const w of W) pts.push([w.x1, w.y1, "end"], [w.x2, w.y2, "end"]);
  for (let i = 0; i < W.length; i++) for (let j = i + 1; j < W.length; j++) { const c = cross(W[i], W[j], tol); if (c) pts.push([c.x, c.y, "cross"]); }
  const seen = new Set(), P = [];
  for (const p of pts) { const k = `${Math.round(p[0] / 2)},${Math.round(p[1] / 2)}`; if (seen.has(k)) continue; seen.add(k); P.push([r1(p[0]), r1(p[1]), p[2]]); }
  const rs = w => { const o = {x1: r1(w.x1), y1: r1(w.y1), x2: r1(w.x2), y2: r1(w.y2), t: r1(w.t || 0), k: w.k, conf: Math.round(w.conf * 100) / 100, why: w.why};
    for (const k of ["fill", "tint", "oc"]) if (w[k]) o[k] = w[k]; return o; };
  return {v: ALGO, src: ls.src, W: ls.W, H: ls.H, ppi: ls.ppi ? Math.round(ls.ppi * 1000) / 1000 : null, docPpi: ls.docPpi ? Math.round(ls.docPpi * 1000) / 1000 : null, angle: Math.round((ls.angle || 0) * 100) / 100,
    quality: ls.quality, conf: Math.round(ls.conf * 100) / 100, walls: W.map(rs), lines: ls.lines.filter(w => w.conf > 0.2).map(rs).slice(0, 4000),
    words: (ls.words || []).slice(0, 3000).map(w => ({s: w.s, x: r1(w.x), y: r1(w.y), h: r1(w.h || 0)})), pts: P.slice(0, 20000), stats: ls.stats || {}};
}

/* ---------- 2. the plan image ---------- */
// RGBA (canvas getImageData) to gray, transparent as white
function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) { const a = rgba[j + 3] / 255; g[i] = Math.round((0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a)); }
  return g;
}
// the drawing's angle off square, by which turn makes the dark pixels' row and column profiles sharpest (deskew)
function deskew(mask, w, h) {
  const xs = [], ys = []; let k = 0;
  for (let y = 0; y < h; y++) for (let x = 0, r = y * w; x < w; x++) if (mask[r + x] && (k++ & 3) === 0) { xs.push(x - w / 2); ys.push(y - h / 2); }
  if (xs.length < 50) return 0;
  const R = Math.ceil(Math.hypot(w, h)) + 4, rowB = new Float64Array(2 * R + 1), colB = new Float64Array(2 * R + 1);
  const score = deg => { const a = deg / R2D, c = Math.cos(a), s = Math.sin(a); rowB.fill(0); colB.fill(0);
    for (let i = 0; i < xs.length; i++) { rowB[Math.round(-xs[i] * s + ys[i] * c) + R]++; colB[Math.round(xs[i] * c + ys[i] * s) + R]++; }
    let v = 0; for (let i = 0; i < rowB.length; i++) v += rowB[i] * rowB[i] + colB[i] * colB[i]; return v; };
  let best = 0, bv = score(0);
  for (let d = -44; d <= 45; d += 1) { if (!d) continue; const v = score(d); if (v > bv * 1.0001) { bv = v; best = d; } }
  for (const step of [0.2, 0.05, 0.0125]) { const c0 = best; for (let d = c0 - step * 5; d <= c0 + step * 5 + 1e-9; d += step) { const v = score(d); if (v > bv) { bv = v; best = d; } } }
  return Math.abs(best) < 0.03 ? 0 : best;
}
// horizontal dark runs at least minLen long, stacked row to row into bands; each band a line through its runs' middles
function bandsOf(mask, w, h, minLen) {
  const out = []; let act = [];
  for (let y = 0; y < h; y++) {
    const runs = [], row = y * w;
    for (let x = 0; x < w;) { if (mask[row + x]) { let e = x; while (e < w && mask[row + e]) e++; if (e - x >= minLen) runs.push([x, e]); x = e; } else x++; }
    // each run joins the band it lies along (a band may take several pieces of one broken row); a band whose row is
    // mostly missing ends, and its pieces start bands of their own
    const claim = runs.map(r => { let best = -1, bo = 0;
      for (let k = 0; k < act.length; k++) { const b = act[k], ov = Math.min(r[1], b.lb) - Math.max(r[0], b.la);
        if (ov > 0 && ov >= 0.6 * (r[1] - r[0]) && ov > bo) { bo = ov; best = k; } } return best; });
    const next = [];
    for (let k = 0; k < act.length; k++) {
      const b = act[k], mine = runs.filter((_, i) => claim[i] === k); if (!mine.length) { out.push(b); continue; }
      const cov = mine.reduce((a, r) => a + r[1] - r[0], 0);
      if (cov >= 0.5 * (b.lb - b.la)) { for (const r of mine) b.rows.push(y, r[0], r[1]); b.la = Math.min(...mine.map(r => r[0])); b.lb = Math.max(...mine.map(r => r[1])); next.push(b); }
      else { out.push(b); runs.forEach((r, i) => { if (claim[i] === k) claim[i] = -1; }); }
    }
    runs.forEach((r, i) => { if (claim[i] < 0) next.push({la: r[0], lb: r[1], rows: [y, r[0], r[1]]}); });
    act = next;
  }
  out.push(...act);
  return out.map(b => {
    const R = b.rows, n = R.length / 3; let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, px = 0, x0 = Infinity, x1 = -Infinity;
    for (let i = 0; i < R.length; i += 3) { const y = R[i] + 0.5, a = R[i + 1], e = R[i + 2], m = (a + e) / 2, wt = e - a;
      sw += wt; sx += wt * m; sy += wt * y; sxx += wt * m * m; sxy += wt * m * y; px += wt; x0 = Math.min(x0, a); x1 = Math.max(x1, e); }
    const mx = sx / sw, my = sy / sw, vx = sxx / sw - mx * mx;
    const slope = 0; void sxx; void sxy; void vx; void n;  // the plan is turned square first (deskew): a band is level
    const yA = my + slope * (x0 - mx), yB = my + slope * (x1 - mx), L = Math.hypot(x1 - x0, yB - yA);
    return {x1: x0, y1: yA, x2: x1, y2: yB, w: px / Math.max(1, L), px, n};
  });
}
function components(mask, w, h) {
  const lab = new Int32Array(w * h); let cnt = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) cnt++;
  const par = new Int32Array(cnt + 2); let next = 1;
  const f = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (a, b) => { a = f(a); b = f(b); if (a !== b) { if (a < b) par[b] = a; else par[a] = b; } return Math.min(a, b); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    let l = 0;
    const nb = [x > 0 ? lab[i - 1] : 0, y > 0 && x > 0 ? lab[i - w - 1] : 0, y > 0 ? lab[i - w] : 0, y > 0 && x < w - 1 ? lab[i - w + 1] : 0];
    for (const v of nb) if (v) l = l ? uni(l, v) : f(v);
    if (!l) { l = next; par[next] = next; next++; }
    lab[i] = l;
  }
  const root = new Int32Array(next); for (let i = 1; i < next; i++) root[i] = f(i);
  const count = new Int32Array(next), maxRun = new Int32Array(next), x0 = new Int32Array(next).fill(1e9), y0 = new Int32Array(next).fill(1e9), x1 = new Int32Array(next), y1 = new Int32Array(next);
  for (let i = 0; i < lab.length; i++) if (lab[i]) { const r = lab[i] = root[lab[i]]; count[r]++; const x = i % w, y = (i - x) / w;
    if (x < x0[r]) x0[r] = x; if (x > x1[r]) x1[r] = x; if (y < y0[r]) y0[r] = y; if (y > y1[r]) y1[r] = y; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w;) { const i = y * w + x; if (!lab[i]) { x++; continue; } let e = x; while (e < w && lab[y * w + e]) e++; const r = lab[i]; if (e - x > maxRun[r]) maxRun[r] = e - x; x = e; }
  for (let x = 0; x < w; x++) for (let y = 0; y < h;) { const i = y * w + x; if (!lab[i]) { y++; continue; } let e = y; while (e < h && lab[e * w + x]) e++; const r = lab[i]; if (e - y > maxRun[r]) maxRun[r] = e - y; y = e; }
  return {lab, count, maxRun, size: r => Math.max(x1[r] - x0[r], y1[r] - y0[r]) + 1, density: r => count[r] / ((x1[r] - x0[r] + 1) * (y1[r] - y0[r] + 1))};
}
// the raster pipeline. opts.width_ft: the plan's real width (thickness in inches, furniture size)
function rasterLines(gray, w, h, opts = {}) {
  const N = w * h, mn = Math.min(w, h), diag = Math.hypot(w, h);
  // paper and ink: the paper level (90th percentile), Otsu's split, a local paper level for uneven light
  const hist = new Float64Array(256); for (let i = 0; i < N; i++) hist[gray[i]]++;
  let acc = 0, bg = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.9 * N) { bg = v; break; } }
  const vals = [], wts = []; for (let v = 0; v < 256; v++) if (hist[v]) { vals.push(v); wts.push(hist[v]); }
  let T = otsu(vals, wts);
  { let d = 0; for (let v = 0; v <= T; v++) d += hist[v]; if (d > 0.25 * N) { const v2 = vals.filter(v => v <= T), w2 = v2.map(v => hist[v]); if (v2.length > 1) T = otsu(v2, w2); } }
  let si = 0, sn = 0; for (let v = 0; v <= T; v++) { si += v * hist[v]; sn += hist[v]; } const ink = sn ? si / sn : 0;
  const B = Math.max(24, Math.round(Math.max(w, h) / 40)), bw = Math.ceil(w / B), bh = Math.ceil(h / B), bgL = new Float32Array(bw * bh);
  { const bh2 = new Int32Array(256); for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) { bh2.fill(0); let n = 0;
      for (let y = by * B; y < Math.min(h, by * B + B); y += 2) for (let x = bx * B; x < Math.min(w, bx * B + B); x += 2) { bh2[gray[y * w + x]]++; n++; }
      let a = 0, v = 255; for (let q = 0; q < 256; q++) { a += bh2[q]; if (a >= 0.9 * n) { v = q; break; } } bgL[by * bw + bx] = v; } }
  // paper noise (90th less 50th percentile; uniform or gaussian alike) and the darkest ink
  let p50 = 255; acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.5 * N) { p50 = v; break; } }
  let inkD = 0; acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= 0.004 * N) { inkD = v; break; } }
  const sigma = (bg - p50) / 1.28;
  // a noisy page is read along each direction after a 5 px average that way: the noise drops, a line along it doesn't
  const noisy = sigma > 4, smooth = horiz => { const o = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0, n = 0; for (let k = -2; k <= 2; k++) { const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { a += gray[yy * w + xx]; n++; } } o[y * w + x] = a / n; } return o; };
  const gH = noisy ? smooth(true) : gray, gV = noisy ? smooth(false) : gray, sg = noisy ? sigma / Math.sqrt(5) : sigma;
  const maskH = new Uint8Array(N), maskV = new Uint8Array(N), mask = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const lb = bgL[Math.floor(y / B) * bw + Math.floor(x / B)], thr = lb - Math.max(3.2 * sg + 4, 0.3 * (lb - inkD), 10), i = y * w + x;
    if (gH[i] < thr) maskH[i] = 1; if (gV[i] < thr) maskV[i] = 1; if (maskH[i] || maskV[i] || gray[i] < thr - 2 * sg) mask[i] = 1; }
  const contrast = clamp((bg - Math.min(ink, inkD + 30)) / 120, 0, 1);
  // marks that can't be lines (text, specks) out; the rest kept
  const minLen = Math.max(14, Math.round(0.012 * mn));
  const {lab, count, maxRun, size, density} = components(mask, w, h), small = Math.max(minLen * 1.5, 0.05 * mn), big = new Uint8Array(count.length);
  for (let r = 1; r < count.length; r++) big[r] = count[r] > 4 && size(r) >= small ? 1 : 0;
  let dark = 0, speck = 0, kept = 0;
  const clean = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const r = lab[i]; if (!r) continue; dark++; if (count[r] <= 4) { speck++; continue; } if (big[r] && (maxRun[r] >= minLen || density(r) < 0.2)) { clean[i] = 1; kept++; } }
  const speckFrac = dark ? speck / dark : 0;
  // the drawing's angle; turned square before the runs are read
  const ang = opts.angle ?? deskew(clean, w, h);
  let M = clean, MV0 = clean, mw = w, mh = h, back = (x, y) => [x, y];
  if (!ang && noisy) { M = new Uint8Array(N); MV0 = new Uint8Array(N); for (let i = 0; i < N; i++) if (clean[i] || !lab[i]) { if (maskH[i]) M[i] = 1; if (maskV[i]) MV0[i] = 1; } }
  if (ang) {
    const a = -ang / R2D, c = Math.cos(a), s = Math.sin(a), cx = w / 2, cy = h / 2;
    mw = Math.ceil(Math.abs(w * c) + Math.abs(h * s)); mh = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
    const ox = mw / 2, oy = mh / 2; M = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const dx = x + 0.5 - ox, dy = y + 0.5 - oy, fx = cx + dx * c + dy * s - 0.5, fy = cy - dx * s + dy * c - 0.5, sx = Math.floor(fx), sy = Math.floor(fy);
      if (sx < -1 || sy < -1 || sx >= w || sy >= h) continue;
      const g = (u, v) => u >= 0 && v >= 0 && u < w && v < h && clean[v * w + u];
      if (g(sx, sy) || g(sx + 1, sy) || g(sx, sy + 1) || g(sx + 1, sy + 1)) M[y * mw + x] = 1; }
    back = (x, y) => { const dx = x - ox, dy = y - oy; return [cx + dx * c + dy * s, cy - dx * s + dy * c]; };
  }
  if (ang) MV0 = M;
  const MT = new Uint8Array(mw * mh); for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) MT[x * mh + y] = MV0[y * mw + x];
  const maxT = Math.max(6, 0.035 * mn);
  let segs = [];
  let bandPx = 0;
  for (const b of bandsOf(M, mw, mh, minLen)) if (b.w <= maxT && b.w <= 0.4 * (b.x2 - b.x1)) { bandPx += b.px; segs.push(b); }
  for (const b of bandsOf(MT, mh, mw, minLen)) if (b.w <= maxT && b.w <= 0.4 * (b.x2 - b.x1)) { bandPx += b.px; segs.push({x1: b.y1, y1: b.x1, x2: b.y2, y2: b.x2, w: b.w, px: b.px, n: b.n}); }
  segs = segs.map(s => { const p = back(s.x1, s.y1), q = back(s.x2, s.y2); return {x1: p[0], y1: p[1], x2: q[0], y2: q[1], w: s.w, px: s.px, k: "s"}; });
  segs = segs.filter(sg => !(len(sg) < 0.06 * mn && segs.some(v => v !== sg && v.w > 2 && angDiff(angOf(v), angOf(sg)) > 75 && len(sg) <= v.w * 1.7 + 2 && segDist(...mid(sg), v) <= v.w / 2 + 1)));
  const explained = kept ? Math.min(1, bandPx / kept) : 0;
  // one line in pieces, then the wall faces
  segs = mergeCollinear(segs, {ang: 1.5, dist: 1.5, gap: 2.5});
  const ppi = opts.width_ft ? w / (opts.width_ft * 12) : null;
  const range = ppi ? [2.5 * ppi, 16.5 * ppi] : [0.0015 * w, 0.011 * w];
  const thin = segs.map(s => s.w).sort((a, b) => a - b), thinMed = thin.length ? thin[thin.length >> 1] : 1;
  const {walls: paired, rest} = pairWalls(segs.filter(s => s.w <= Math.max(3, 2.5 * thinMed)), [Math.max(range[0], 3), range[1]], {minLen, tripleGap: 3});
  const notPaired = new Set(rest); segs.forEach(s => { if (s.w > Math.max(3, 2.5 * thinMed)) notPaired.add(s); });
  // inside a pair: solid (poche), hatched, or empty
  const G = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? 255 : gray[yi * w + xi]; };
  const Mk = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : mask[yi * w + xi]; };
  const strip = (s, o0, o1) => { const L = len(s), ux = (s.x2 - s.x1) / L, uy = (s.y2 - s.y1) / L, nx = -uy, ny = ux; let n = 0, dk = 0, mk = 0;
    for (let d = Math.min(6, L * 0.1); d < L - Math.min(6, L * 0.1); d += 2) for (let o = o0; o <= o1; o += 1) { const x = s.x1 + ux * d + nx * o, y = s.y1 + uy * d + ny * o; n++; dk += Math.max(0, bg - G(x, y)); mk += Mk(x, y); }
    return n ? {dark: dk / n / Math.max(1, bg - ink), mask: mk / n} : {dark: 0, mask: 0}; };
  for (const p of paired) { const half = p.t / 2 - p.fw / 2 - 1.5; if (half < 1) continue;  // too tight to see inside
    const q = strip(p, -half, half); p.fill = noisy ? (q.mask >= 0.08 || q.dark >= 0.22 ? "dark" : null)  // blur and noise hide hatching: say so
      : q.mask >= 0.6 ? "solid" : q.mask >= 0.08 ? "hatch" : q.dark >= 0.22 ? "solid" : null; }
  let W2 = [...paired.map(p => ({...p, conf: 0.85, why: "two parallel lines a wall's thickness apart"})),
    ...[...notPaired].map(s => ({x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, t: s.w, k: "single", conf: 0.78, why: "a dark line on the plan"}))];
  W2 = absorb(W2);
  // a mark no longer than a wall is thick, across a longer line: an end cap, hatching or a jamb, not a wall
  { const cap = range[1] + 4, longs = W2.filter(o => len(o) >= 0.05 * mn);
    W2 = W2.filter(s => len(s) > cap || !longs.some(v => v !== s && angDiff(angOf(v), angOf(s)) > 60 && segDist(...mid(s), v) <= len(s) / 2 + (v.t || 1) / 2 + 2)); }
  // a line broken by light gaps along its middle is text smeared by the reading, or a dashed line: not a wall
  for (const s of W2) {
    if (s.k !== "single") continue;
    const L = len(s), ux = (s.x2 - s.x1) / L, uy = (s.y2 - s.y1) / L, half = Math.max(0, Math.floor((s.t - 1) / 2)); let n = 0, gaps = 0;
    const along = noisy ? 2 : 0, thrS = (x, y) => { const lb = bgL[clamp(Math.floor(y / B), 0, bh - 1) * bw + clamp(Math.floor(x / B), 0, bw - 1)];
      return lb - Math.max(3.2 * sigma / Math.sqrt((2 * along + 1) * (2 * half + 1)) + 4, 0.3 * (lb - inkD), 10); };
    for (let d = 1 + along; d < L - 1 - along; d += 1) { let a = 0, k = 0;
      for (let e = -along; e <= along; e++) for (let o = -half; o <= half; o++) { a += G(s.x1 + ux * (d + e) - uy * o, s.y1 + uy * (d + e) + ux * o); k++; }
      n++; if (a / k > thrS(s.x1 + ux * d, s.y1 + uy * d)) gaps++; }
    if (n && gaps / n > 0.3) { s.conf = 0.3; s.why = "broken along its length: text or a dashed line"; }
  }
  // the sheet's frame: nothing inked beyond it on any side
  { const beyond = (side, l) => { const m = Math.ceil((l.t || 1) / 2 + 3); let n = 0;
      if (side === "top" || side === "bottom") { const y0 = side === "top" ? 0 : Math.ceil(Math.max(l.y1, l.y2) + m), y1 = side === "top" ? Math.floor(Math.min(l.y1, l.y2) - m) : h - 1;
        for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) for (let x = 0; x < w; x++) n += mask[y * w + x]; }
      else { const x0 = side === "left" ? 0 : Math.ceil(Math.max(l.x1, l.x2) + m), x1 = side === "left" ? Math.floor(Math.min(l.x1, l.x2) - m) : w - 1;
        for (let y = 0; y < h; y++) for (let x = Math.max(0, x0); x <= Math.min(w - 1, x1); x++) n += mask[y * w + x]; }
      return n > 40; };
    for (const s of frameOf(W2, w, h, beyond)) { s.conf = 0.1; s.why = "the sheet border"; } }
  const singlesT = W2.filter(s => s.k === "single" && s.conf > 0.5).map(s => s.t).sort((a, b) => a - b), sMed = singlesT.length ? singlesT[singlesT.length >> 1] : 1;
  for (const s of W2) {
    if (s.k !== "single" || s.conf <= 0.5) continue;
    const core = ppi && s.t >= 3.5 * sMed && s.t >= 5.5 * ppi && s.t <= 20 * ppi ? strip(s, -Math.max(1, s.t / 4), Math.max(1, s.t / 4)) : null;
    if (core && (core.dark >= 0.7 || (core.mask >= 0.9 && core.dark >= 0.3))) { s.k = "fill"; s.fill = "solid"; s.why = `a solid band about ${Math.round(s.t / ppi)} in thick`; continue; }
    const L = len(s), o0 = s.t / 2 + 3, o1 = s.t / 2 + 9, A = strip(s, o0, o1), Bq = strip(s, -o1, -o0);
    const tint = x => x.mask < 0.2 && x.dark >= 0.08 && x.dark < 0.6;
    if ((tint(A) || tint(Bq)) && L > 0.03 * mn) s.tint = true;
    if (L < 0.05 * mn) {  // a short line ending in a curve: a door leaf
      for (const [ex, ey] of [[s.x1, s.y1], [s.x2, s.y2]]) { const R = 2 * s.t + 6; let hits = 0;
        for (let k = 0; k < 64; k++) { const x = ex + R * Math.cos(k * Math.PI / 32), y = ey + R * Math.sin(k * Math.PI / 32), xi = Math.round(x), yi = Math.round(y);
          if (xi < 0 || yi < 0 || xi >= w || yi >= h || !(noisy ? mask : clean)[yi * w + xi]) continue; if (W2.some(o => o !== s && len(o) >= 0.05 * mn && segDist(x, y, o) <= (o.t || 1) / 2 + 2)) continue; hits++; }
        if (hits >= 1) { s.conf = 0.4; s.why = "a short line ending in a curve: a door leaf?"; break; } }
    }
  }
  const labOf = sg => { const f0 = sg.faces ? sg.faces[0] : sg; for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) { const [x, y] = at(f0, t);
      for (let d = 0; d <= Math.ceil((f0.w || 1) / 2) + 2; d++) for (const [ox, oy] of [[0, d], [0, -d], [d, 0], [-d, 0]]) { const xi = Math.round(x + ox), yi = Math.round(y + oy);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h && lab[yi * w + xi]) return lab[yi * w + xi]; } } return 0; };
  W2 = placeAndScore(W2, w, h, ppi, {keyOf: labOf, angle: ang});
  // how far the result can be trusted: dark ink explained by lines, contrast, specks, a sane count
  const nW = W2.filter(s => s.conf >= 0.5).length, sane = nW >= 4 && nW <= 4000 ? 1 : nW >= 2 ? 0.6 : 0.2;
  const G0 = clamp(0.1 + 0.9 * Math.pow(explained, 0.8) * Math.sqrt(contrast) * sane * (1 - Math.min(1, speckFrac * 2.5)), 0, 0.9);  // an image is never read with certainty
  const f = Math.min(1, G0 / 0.7);
  for (const s of W2) s.conf = Math.round(s.conf * f * 100) / 100;
  if (f < 1) for (const s of W2) if (s.conf < 0.5 && s.why && !/border|outside|furniture|door|racking/.test(s.why)) s.why += ` (the plan is hard to read: ${Math.round(G0 * 100)}% sure of its lines)`;
  const walls = W2.filter(s => s.conf >= 0.5), lines = W2.filter(s => s.conf < 0.5);
  return finish({src: "raster", W: w, H: h, ppi, angle: ang, quality: G0 >= 0.6 ? "clean" : G0 >= 0.4 ? "fair" : "poor", conf: G0, walls, lines, words: [],
    stats: {threshold: Math.round(T), paper: bg, ink: Math.round(ink), contrast: Math.round(contrast * 100) / 100, explained: Math.round(explained * 100) / 100,
      specks: Math.round(speckFrac * 100) / 100, angle: Math.round(ang * 100) / 100, pairs: paired.length}});
}

/* ---------- 3. snapping and locking (display pixels) ---------- */
// The point to use for a pointer at p: drawn walls' ends (10 px), then the plan's ends and crossings (10 px), then on a
// plan line (8 px past its half-thickness), then along the plan's main axes from the wall's start (within 5 degrees).
//   o: {walls, lines (with t), pts [[x,y,kind]], start [x,y], angle, axis (force the axis), tolEnd, tolOn, axisTol}
function snapPoint(p, o) {
  const [px, py] = p, te = o.tolEnd ?? 10, to = o.tolOn ?? 8;
  let best = null, bd = te;
  for (const w of o.walls || []) for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) { const d = Math.hypot(x - px, y - py); if (d <= bd) { bd = d; best = {x, y, kind: "wall-end"}; } }
  if (best) return best;
  bd = te;
  for (const q of o.pts || []) { const d = Math.hypot(q[0] - px, q[1] - py); if (d <= bd) { bd = d; best = {x: q[0], y: q[1], kind: q[2] === "cross" ? "crossing" : "plan-end"}; } }
  if (best) return best;
  if (o.start && o.axis) return axisLock(p, o.start, o.angle || 0, 90) || {x: px, y: py, kind: null};
  bd = Infinity;
  for (const l of o.lines || []) { const d = segDist(px, py, l), lim = to + (l.t || 0) / 2; if (d <= lim && d < bd) { bd = d; const t = clamp(tOn(px, py, l), 0, 1), [x, y] = at(l, t); best = {x, y, kind: "on-line", line: l}; } }
  if (best && o.start) {  // on a line and square to the start: where the two meet
    const ax = axisLock(p, o.start, o.angle || 0, o.axisTol ?? 5);
    if (ax) { const c = cross({x1: o.start[0], y1: o.start[1], x2: ax.x + (ax.x - o.start[0]) * 1e3, y2: ax.y + (ax.y - o.start[1]) * 1e3}, best.line, 0);
      if (c && Math.hypot(c.x - px, c.y - py) <= to + (best.line.t || 0) / 2) return {x: c.x, y: c.y, kind: "on-line", line: best.line, axis: true}; }
  }
  if (best) return best;
  if (o.start) { const ax = axisLock(p, o.start, o.angle || 0, o.axisTol ?? 5); if (ax) return ax; }
  return {x: px, y: py, kind: null};
}
function axisLock(p, s, main, tolDeg) {
  const dx = p[0] - s[0], dy = p[1] - s[1], L = Math.hypot(dx, dy); if (L < 1) return null;
  const a = ((Math.atan2(dy, dx) * R2D) % 180 + 180) % 180;
  for (const base of [main, main + 90]) { if (angDiff(a, base) <= tolDeg) { const r = base / R2D, ux = Math.cos(r), uy = Math.sin(r), t = dx * ux + dy * uy; return {x: s[0] + ux * t, y: s[1] + uy * t, kind: "axis", deg: base % 180}; } }
  return null;
}
// a dragged wall that runs along one plan line locks onto it: both ends projected on the line (its centre for a
// double-line wall), stretched to the line's own ends when they're near. Returns {x1,y1,x2,y2,line} or null
function lockDrag(a, b, lines, o = {}) {
  const tol = o.tol ?? 12, reach = o.reach ?? 16, ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * R2D;
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 8) return null;
  let best = null, bd = Infinity;
  for (const l of lines || []) {
    const lim = tol + (l.t || 0) / 2; if (angDiff(((ang % 180) + 180) % 180, angOf(l)) > 8) continue;
    const da = lineDist(a[0], a[1], l), db = lineDist(b[0], b[1], l); if (da > lim || db > lim) continue;
    const ta = tOn(a[0], a[1], l), tb = tOn(b[0], b[1], l), L = len(l), sl = reach / L;
    if (Math.max(ta, tb) < -sl || Math.min(ta, tb) > 1 + sl) continue;
    if (da + db < bd) { bd = da + db; best = {l, ta, tb, sl}; }
  }
  if (!best) return null;
  let {l, ta, tb, sl} = best;
  const snapT = t => t < sl && t > -sl ? 0 : t > 1 - sl && t < 1 + sl ? 1 : clamp(t, 0, 1);
  ta = snapT(ta); tb = snapT(tb);
  const p = at(l, ta), q = at(l, tb);
  return {x1: p[0], y1: p[1], x2: q[0], y2: q[1], line: l};
}

/* ---------- 4. snip and lasso ---------- */
function inPoly(x, y, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j];
  if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi) c = !c; } return c; }
// the stretches of s inside the polygon, as [t0, t1] pairs (0-1 along s)
function clipPoly(s, poly) {
  const ts = [0, 1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const c = cross(s, {x1: poly[j][0], y1: poly[j][1], x2: poly[i][0], y2: poly[i][1]}); if (c) ts.push(c.t); }
  ts.sort((a, b) => a - b); const out = [];
  for (let k = 0; k < ts.length - 1; k++) { const a = ts[k], b = ts[k + 1]; if (b - a < 1e-6) continue; const [x, y] = at(s, (a + b) / 2);
    if (inPoly(x, y, poly)) { if (out.length && Math.abs(out[out.length - 1][1] - a) < 1e-6) out[out.length - 1][1] = b; else out.push([a, b]); } }
  return out;
}
const rectPoly = (x0, y0, x1, y1) => [[Math.min(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.max(y0, y1)], [Math.min(x0, x1), Math.max(y0, y1)]];

const MAT_WORDS = [
  [/LOW[- ]?E\b/i, "lowe"], [/CURTAIN\s*WALL|GLAZ|STOREFRONT|WINDOW\s*WALL|\bGLASS\b/i, "glass"], [/TILT[- ]?UP/i, "rc8"],
  [/BRICK.*(CMU|BLOCK)|(CMU|BLOCK).*BRICK/i, "brickcmu"], [/BRICK/i, "brick"], [/\bCMU\b|\bBLOCK\b|MASONRY/i, "cmu"],
  [/REINF|\bR\.?C\.?\b/i, "rc8"], [/\bCONC(RETE|\.)?\b|\bCONC\b/i, "conc8"], [/GYP|\bGWB\b|DRYWALL|PLASTERBOARD/i, "drywall"], [/WOOD|TIMBER|\bSTUD\b/i, "wood"]];
// a material from words (a plan note, the job's construction, the building's tags), or null
function materialFromText(s) { s = String(s || ""); for (const [re, k] of MAT_WORDS) if (re.test(s)) return k; return null; }
const CORE = /\bSTAIRS?\b|\bSTAIR\b|\bSTAIRWELL|\bELEV|\bSHAFT\b|\bLIFT\b/i;

// each proposed wall's material, the rule that chose it and how sure it is.
//   ctx: {otherFloors:{key, why}, facade:{key, why}, btype:{key, why}}
function chooseMaterial(w, ls, ctx, cache) {
  cache = cache || {ext: new Map()};
  const diag = Math.hypot(ls.W, ls.H), ppi = ls.ppi, tin = ppi ? w.t / ppi : null;
  // a word beside the wall, nearer it than any other wall
  const R = Math.max(0.012 * diag, (w.t || 0) / 2 + 4);
  let best = null;
  for (const wd of ls.words || []) {
    const k = materialFromText(wd.s); if (!k) continue;
    const d = segDist(wd.x, wd.y, w); if (d > R + (wd.h || 0)) continue;
    if (ls.walls.some(o => o !== w && segDist(wd.x, wd.y, o) < d - 0.5)) continue;
    if (!best || d < best.d) best = {d, k, s: wd.s};
  }
  if (best) { let k = best.k; if (k === "conc8" && tin) k = tin >= 11 ? "conc12" : tin <= 4.6 ? "conc4" : "conc8"; return {key: k, conf: 0.9, why: `the plan says "${best.s}" beside it`}; }
  // a box labelled stair, elevator or shaft
  const core = coreOf(w, ls, cache);
  if (core) return {key: /ELEV|SHAFT|LIFT/i.test(core) ? "shaft" : "conc8", conf: 0.85, why: `it boxes in "${core}"`};
  if (w.k === "triple") return {key: ctx.facade?.key === "lowe" ? "lowe" : "glass", conf: 0.85, why: "three thin lines: glazing" + (ctx.facade?.key === "lowe" ? ` (${ctx.facade.why}: low-E)` : "")};
  if ((w.k === "pair" || w.k === "fill") && tin) {
    if (tin >= 11) return {key: "conc12", conf: w.fill === "solid" ? 0.85 : 0.65, why: `about ${Math.round(tin)} in thick${w.fill === "solid" ? ", solid" : ""}`};
    if (tin >= 6.5) {
      if (w.fill === "hatch") return {key: "cmu", conf: 0.85, why: `about ${Math.round(tin)} in thick, hatched: block`};
      if (w.fill === "solid") return {key: "conc8", conf: 0.85, why: `about ${Math.round(tin)} in thick, solid: concrete`};
      if (w.fill === "dark") return {key: "conc8", conf: 0.55, why: `about ${Math.round(tin)} in thick and filled, too blurred to tell hatching (block) from solid (concrete)`};
    }
  }
  const ext = exteriorOf(w, ls, cache);
  if (ext) {
    if (ctx.otherFloors?.key) return {key: ctx.otherFloors.key, conf: 0.8, why: `outside wall: ${ctx.otherFloors.why}`};
    if (ctx.facade?.key) return {key: ctx.facade.key, conf: 0.75, why: `outside wall: ${ctx.facade.why}`};
    if (ctx.btype?.key) return {key: ctx.btype.key, conf: 0.5, why: `outside wall: ${ctx.btype.why}`};
  }
  if ((w.k === "pair" || w.k === "fill") && tin) {
    if (tin >= 6.5) return {key: "conc8", conf: 0.55, why: `about ${Math.round(tin)} in thick, plain: concrete or block?`};
    return {key: "drywall", conf: 0.8, why: `about ${Math.round(tin)} in thick: a stud partition`};
  }
  if (w.tint) return {key: "conc8", conf: 0.55, why: "it borders a shaded area: often a stair or shaft core"};
  if (ext) return {key: "brickcmu", conf: 0.4, why: "outside wall: nothing says what it's made of"};
  return {key: "drywall", conf: w.k === "single" ? 0.65 : 0.6, why: "an inside wall with nothing more said: drywall"};
}
// cast rays square to the wall from three points along it: no wall on one side for most of them = outside
function exteriorOf(w, ls, cache) {
  const key = `${w.x1},${w.y1},${w.x2},${w.y2}`; if (cache && cache.ext.has(key)) return cache.ext.get(key);
  const L = len(w), ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L, nx = -uy, ny = ux, far = Math.hypot(ls.W, ls.H) * 2;
  const others = ls.walls.filter(o => o !== w && !(angDiff(angOf(o), angOf(w)) < 3 && lineDist(...mid(o), w) < ((w.t || 0) + (o.t || 0)) / 2 + 1.5));
  let outA = 0, outB = 0;
  for (const f of [0.25, 0.5, 0.75]) { const [px, py] = at(w, f);
    for (const [sgn, k] of [[1, "a"], [-1, "b"]]) { const ox = px + nx * sgn * ((w.t || 0) / 2 + 1.5), oy = py + ny * sgn * ((w.t || 0) / 2 + 1.5), ray = {x1: ox, y1: oy, x2: ox + nx * sgn * far, y2: oy + ny * sgn * far};
      if (!others.some(o => cross(ray, o))) { if (k === "a") outA++; else outB++; } } }
  const r = outA >= 2 || outB >= 2;
  if (cache) cache.ext.set(key, r); return r;
}
// the word inside the small box this wall closes, when it's a stair, elevator or shaft
function coreOf(w, ls, cache) {
  if (!cache.core) { cache.core = new Map(); const far = Math.hypot(ls.W, ls.H);
    for (const wd of ls.words || []) { if (!CORE.test(wd.s)) continue; const hit = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = (ls.angle || 0) / R2D, rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
        const ray = {x1: wd.x, y1: wd.y, x2: wd.x + rx * far, y2: wd.y + ry * far}; let bt = Infinity, bo = null;
        for (const o of ls.walls) { const c = cross(ray, o); if (c && c.t < bt) { bt = c.t; bo = o; } }
        if (bo && bt * far < 0.2 * far) hit.push(bo); }
      if (hit.length === 4) for (const o of hit) if (!cache.core.has(o)) cache.core.set(o, wd.s.replace(/\s+/g, " ").slice(0, 30)); } }
  return cache.core.get(w) || null;
}
// the walls a snip or lasso finds: each wall more than half inside comes whole, else its stretch inside when that's
// long enough; each with its material (smart) or the chosen one, a confidence and the reason
//   poly: the region in the line set's frame; o: {smart, mat, ctx, existing (walls already drawn, same frame), minConf}
function proposeWalls(ls, poly, o = {}) {
  const diag = Math.hypot(ls.W, ls.H), out = [], cache = {ext: new Map()}, minPiece = Math.max(0.02 * diag, 12);
  let dup = 0;
  for (const w of ls.walls) {
    if (w.conf < (o.minConf ?? 0.35)) continue;
    const parts = clipPoly(w, poly), inside = parts.reduce((a, [p, q]) => a + q - p, 0);
    if (!parts.length) continue;
    const pieces = inside > 0.5 ? [[0, 1, false]] : parts.filter(([p, q]) => (q - p) * len(w) >= minPiece).map(([p, q]) => [p, q, true]);
    for (const [p, q, clipped] of pieces) {
      const [x1, y1] = at(w, p), [x2, y2] = at(w, q), seg = {...w, x1, y1, x2, y2};
      if ((o.existing || []).some(e => angDiff(angOf(e), angOf(seg)) < 4 && lineDist(...mid(seg), e) < Math.max(6, (w.t || 0)) && (overlapOn(seg, e)?.[1] - overlapOn(seg, e)?.[0] || 0) >= 0.8)) { dup++; continue; }
      const m = o.smart ? chooseMaterial(w, ls, o.ctx || {}, cache) : {key: o.mat || null, conf: 1, why: "the wall type you picked"};
      out.push({x1, y1, x2, y2, t: w.t, k: w.k, lineConf: w.conf, lineWhy: w.why + (clipped ? " (cut at the edge of your selection)" : ""), mat: m.key, matConf: m.conf, matWhy: m.why,
        conf: Math.round(Math.min(w.conf, m.conf) * 100) / 100, thick_in: ls.ppi && w.t ? Math.round(w.t / ls.ppi * 10) / 10 : null, src: ls.src});
    }
  }
  return {walls: out, dup};
}

/* ---------- 5. which tool suits this plan ---------- */
function bestVariant(ls) {
  if (!ls) return {key: "draw", tool: "wall", smart: false, text: "Draw by hand: the plan isn't read yet", conf: 0};
  const n = ls.walls.length, sure = ls.walls.filter(w => w.conf >= 0.75).length;
  if (ls.src === "vector" && n >= 4 && (ls.quality === "layer" || ls.quality === "clean"))
    return {key: "smart-snip", tool: "snip", smart: true, conf: ls.conf, text: `Smart snip: ${n} vector walls`,
      why: ls.quality === "layer" ? "The PDF keeps its walls on their own layer: walls and materials can be read straight off it." : `The PDF's lines are clean: ${sure} of ${n} walls read with confidence; materials from its words, fills and hatching.`};
  if (ls.src === "vector" && n >= 4) return {key: "snip", tool: "snip", smart: false, conf: ls.conf, text: "Snip, then review", why: "The PDF's lines are mixed (one line weight, few double lines): check what a snip finds."};
  if (ls.src === "raster" && ls.conf >= 0.6 && n >= 4) return {key: "snip-confirm", tool: "snip", smart: false, conf: ls.conf, text: "Snip (detected): confirm", why: `Read from the image: ${Math.round(ls.conf * 100)}% sure of its lines. Each snip shows what it found before anything is added.`};
  if (ls.src === "raster" && ls.conf >= 0.4 && n >= 2) return {key: "draw-snap", tool: "wall", smart: false, conf: ls.conf, text: "Draw with snap", why: `The image is hard to read (${Math.round(ls.conf * 100)}% sure): draw each wall; the pointer snaps to the lines it did find.`};
  return {key: "draw", tool: "wall", smart: false, conf: ls.conf || 0, text: "Draw by hand: no lines found", why: "No reliable lines in this plan (a photo or a faint scan): draw the walls."};
}

/* ---------- 6. scoring against drawn truth (tests) ---------- */
// det and truth: walls in 0-1 of the plan; W, H: its size. A found wall is right when 80% of it lies on true walls
// (within 3 degrees and 0.5% of the diagonal); a true wall is found when 80% of it is covered. Materials are scored on
// the right ones. truth entries with ignore:true neither count nor penalise.
const MAT_CLASS = {drywall: "drywall", conc4: "conc4", conc8: "conc8", rc8: "conc8", shaft: "conc8", conc12: "conc12", cmu: "cmu", brick: "brick", brickcmu: "brick", glass: "glass", lowe: "lowe", wood: "wood"};
function scoreAgainst(det, truth, W, H, o = {}) {
  const diag = Math.hypot(W, H), dTol = (o.dist ?? 0.005) * diag, aTol = o.ang ?? 3, need = o.cover ?? 0.8;
  const px = s => ({...s, x1: s.x1 * W, y1: s.y1 * H, x2: s.x2 * W, y2: s.y2 * H});
  const D = det.map(px), T = truth.map(px);
  const coverBy = (s, others) => { const iv = [], hits = [];
    for (const t of others) { if (angDiff(angOf(s), angOf(t)) > aTol) continue; if (lineDist(t.x1, t.y1, s) > dTol + len(t) * Math.sin(aTol / R2D) && lineDist(t.x2, t.y2, s) > dTol + len(t) * Math.sin(aTol / R2D)) continue;
      const a = tOn(t.x1, t.y1, s), b = tOn(t.x2, t.y2, s), lo = Math.max(0, Math.min(a, b)), hi = Math.min(1, Math.max(a, b)); if (hi <= lo) continue;
      const pm = at(s, (lo + hi) / 2); if (segDist(pm[0], pm[1], t) > dTol) continue; iv.push([lo, hi]); hits.push([t, hi - lo]); }
    iv.sort((a, b) => a[0] - b[0]); let c = 0, e = 0; for (const [a, b] of iv) { if (b <= e) continue; c += b - Math.max(a, e); e = b; } return {c, hits}; };
  const real = T.filter(t => !t.ignore), ign = T.filter(t => t.ignore);
  let tp = 0, fp = 0, matOk = 0, matN = 0; const missed = [], extra = [], wrongMat = [];
  for (const s of D) { if (ign.length && coverBy(s, ign).c >= 0.5) continue;
    const {c, hits} = coverBy(s, real);
    if (c >= need) { tp++; if (s.mat != null) { const t = hits.sort((a, b) => b[1] - a[1])[0][0]; matN++; if (MAT_CLASS[s.mat] === MAT_CLASS[t.mat]) matOk++; else wrongMat.push({got: s.mat, want: t.mat, at: [r1(s.x1), r1(s.y1), r1(s.x2), r1(s.y2)]}); } }
    else { fp++; extra.push({at: [r1(s.x1), r1(s.y1), r1(s.x2), r1(s.y2)], cover: Math.round(c * 100) / 100, why: s.why}); } }
  let found = 0; for (const t of real) { if (coverBy(t, D).c >= need) found++; else missed.push([r1(t.x1), r1(t.y1), r1(t.x2), r1(t.y2)]); }
  return {precision: D.length ? tp / Math.max(1, tp + fp) : 0, recall: real.length ? found / real.length : 1, found, truth: real.length, detected: tp + fp,
    material: matN ? matOk / matN : null, missed, extra, wrongMat};
}

const api = {ALGO, MAT, opsToSegments, textWords, scaleOfText, scaleFromWords, vectorLines, rasterLines, toGray, deskew, mergeCollinear, pairWalls, absorb,
  snapPoint, axisLock, lockDrag, clipPoly, inPoly, rectPoly, proposeWalls, chooseMaterial, materialFromText, exteriorOf, bestVariant, scoreAgainst,
  geom: {len, angOf, angDiff, segDist, lineDist, tOn, cross, overlapOn, at, mid}};
if (typeof window !== "undefined") window.PlanLines = api;
if (typeof module !== "undefined") module.exports = api;
})();
