"use strict";
/* RF Recon — Spectrum: an analyzer-style view of every frequency in the results.
   Exact frequencies down to kHz (channel widths from the emission designators), min / max range, band presets,
   drag to zoom, Ctrl+wheel zoom, Shift+drag pan, an overview strip, band-plan markings, and markers with deltas. */

const SPEC_PRESETS = [["All results", null, null], ["HF 1.6-30", 1.6, 30], ["VHF low 30-50", 30, 50], ["Aviation VHF 108-137", 108, 137],
  ["VHF high 136-174", 136, 174], ["Marine VHF 156-163", 156, 163], ["220 MHz", 216, 225], ["UHF 380-512", 380, 512],
  ["UHF land mobile 450-470", 450, 470], ["T-band 470-512", 470, 512], ["700 MHz 758-806", 758, 806],
  ["800 MHz 806-870", 806, 870], ["900 MHz 896-941", 896, 941], ["Microwave > 1 GHz", 1000, 30000]];
const SPEC_M = {l: 56, r: 14, t: 22, b: 34};  // plot margins (px)

function specState() {
  if (!S.spec) {
    let markers = [];
    try { markers = JSON.parse(localStorage.getItem("rfr.spec.markers")) || []; } catch (e) {}
    S.spec = {lo: null, hi: null, metric: "count", plan: true, widths: true, known: true, scale: "auto", markers};
  }
  return S.spec;
}
// Frequency scale: log when the range spans more than 20x (HF to microwave), else linear. T maps MHz to axis units.
function specScale(lo, hi, choice) {
  const log = choice === "log" || (choice === "auto" && hi / Math.max(lo, 1e-3) > 20);
  return log ? {log, T: f => Math.log10(Math.max(f, 1e-3)), Ti: u => 10 ** u} : {log, T: f => f, Ti: u => u};
}
const saveMarkers = () => { try { localStorage.setItem("rfr.spec.markers", JSON.stringify(S.spec.markers)); } catch (e) {} };
// tick step giving about n ticks over span
function niceTick(span, n = 9) { const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)); for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p; return raw; }
const fDigits = span => span > 200 ? 0 : span > 20 ? 1 : span > 2 ? 2 : span > 0.2 ? 3 : span > 0.02 ? 4 : 5;

S.views.spectrum = (v, rows) => {
  const sp = specState();
  const sig = rows.filter(r => r.freq_mhz);
  if (!sig.length) { v.innerHTML = '<p class="status">No frequencies in the current results.</p>'; return; }
  // one entry per exact frequency
  const agg = new Map();
  for (const r of sig) {
    const k = fmtF(r.freq_mhz);
    const a = agg.get(k) || {f: r.freq_mhz, n: 0, meas: 0, types: new Map(), names: new Set(), bw: 0, est: null, mdbm: null};
    a.n++;
    if (r.layer === "captures" || r.layer === "wigle" || r.layer === "custom") { a.meas++; if (r.dbm != null) a.mdbm = Math.max(a.mdbm ?? -999, r.dbm); }
    if (r.est_rx_dbm != null) a.est = Math.max(a.est ?? -999, r.est_rx_dbm);
    a.bw = Math.max(a.bw, r.bandwidth_khz || r.bw_khz || 0);
    a.types.set(typeOf(r), (a.types.get(typeOf(r)) || 0) + 1);
    if (a.names.size < 6) a.names.add(titleOf(r));
    agg.set(k, a);
  }
  const all = [...agg.values()].sort((a, b) => a.f - b.f);
  const fmin = all[0].f, fmax = all[all.length - 1].f;
  if (sp.lo == null || sp.hi == null || sp.hi <= sp.lo) {  // fit the results, padded in the axis's own units
    if (specScale(fmin, fmax, sp.scale).log) { sp.lo = fmin / 1.2; sp.hi = fmax * 1.2; }
    else { const pad = Math.max((fmax - fmin) * 0.02, 0.0125); sp.lo = Math.max(0.001, fmin - pad); sp.hi = fmax + pad; }
  }

  v.innerHTML = `
  <div class="maptools no-print" style="flex-wrap:wrap;gap:8px">
    <label class="inl">From <input id="spLo" type="number" step="any" style="width:110px"></label>
    <label class="inl">to <input id="spHi" type="number" step="any" style="width:110px"> MHz</label>
    <label class="inl">Preset <select id="spPreset">${SPEC_PRESETS.map(([l], i) => `<option value="${i}">${l}</option>`).join("")}</select></label>
    <button id="spOut" title="Zoom out">−</button><button id="spIn" title="Zoom in">+</button><button id="spLeft" title="Pan left">◀</button><button id="spRight" title="Pan right">▶</button>
    <span style="flex:1"></span>
    <label class="inl">Scale <select id="spScale"><option value="auto">Auto</option><option value="linear">Linear</option><option value="log">Log</option></select></label>
    <label class="inl">Height <select id="spMetric"><option value="count">Entries</option><option value="est">Strongest predicted dBm</option><option value="meas">Measured dBm</option></select></label>
    <label class="inl"><input type="checkbox" id="spPlan"> Band plan</label>
    <label class="inl"><input type="checkbox" id="spWidths"> Channel widths</label>
    <label class="inl" title="Signals from the Signal Identification Wiki whose frequencies fall in view"><input type="checkbox" id="spKnown"> Known signals</label>
  </div>
  <div class="panel" style="padding:6px;position:relative">
    <canvas id="spCv" style="width:100%;height:360px;display:block;cursor:crosshair"></canvas>
    <canvas id="spOv" style="width:100%;height:46px;display:block;margin-top:4px;cursor:pointer"></canvas>
    <div id="spTip" class="panel" hidden style="position:absolute;pointer-events:none;z-index:5;padding:6px 8px;font-size:12px;max-width:340px"></div>
  </div>
  <p class="hint no-print">Click to drop a marker (snaps to the nearest signal). Drag to zoom into a range. Ctrl + wheel zooms at the cursor, Shift + drag pans.
    The strip underneath is the whole result: click or drag it to move the window. <span id="spInfo"></span></p>
  <div class="panel" style="margin-top:8px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Markers</h3>
    <span class="row no-print"><label class="inl">Add at <input id="spAddF" type="number" step="any" placeholder="MHz" style="width:120px"></label><button id="spAdd">Add</button><button id="spClear">Clear all</button></span></div>
    <div id="spMarkers" style="margin-top:6px"></div></div>`;

  const cv = $("#spCv"), ov = $("#spOv"), tip = $("#spTip");
  $("#spMetric").value = sp.metric; $("#spPlan").checked = sp.plan; $("#spWidths").checked = sp.widths; $("#spScale").value = sp.scale; $("#spKnown").checked = sp.known;
  // Signal ID Wiki entries for the visible range, fetched when the range changes
  let knownKey = null;
  const loadKnown = () => {
    if (!sp.known) return;
    const key = `${sp.lo.toFixed(5)}-${sp.hi.toFixed(5)}`;
    if (key === knownKey) return;
    knownKey = key; clearTimeout(S.specKnownT);
    S.specKnownT = setTimeout(() => api(`/api/sigwiki/range?lo=${sp.lo}&hi=${sp.hi}`)
      .then(r => { S.specKnown = {key, list: r.signals}; if ($("#spCv") && knownKey === key) draw(); }).catch(() => {}), 200);
  };
  const knownAt = f => (sp.known && S.specKnown?.list || []).filter(k => k.ranges.some(([a, b]) => a - 0.005 <= f && f <= b + 0.005));
  const setRange = (lo, hi) => {
    const minSpan = 0.005;  // 5 kHz: enough to see a 6.25 kHz channel
    lo = Math.max(lo, 0.001);
    if (hi - lo < minSpan) { const c = (lo + hi) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
    sp.lo = lo; sp.hi = hi; draw();
  };
  // zoom / pan in axis units, so log and linear behave the same
  const around = (f, k) => { const {T, Ti} = specScale(sp.lo, sp.hi, sp.scale), c = T(f); setRange(Ti(c - (c - T(sp.lo)) * k), Ti(c + (T(sp.hi) - c) * k)); };
  const ctxOf = (c, h) => { const dpr = window.devicePixelRatio || 1, w = c.clientWidth; c.width = w * dpr; c.height = h * dpr; const x = c.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [x, w, h]; };
  const css = getComputedStyle(document.documentElement), INK = css.getPropertyValue("--ink").trim(), MUTED = css.getPropertyValue("--muted").trim(),
    LINE = css.getPropertyValue("--line").trim(), ACC = css.getPropertyValue("--accent").trim();
  let geom = null;

  function value(a) { return sp.metric === "est" ? a.est : sp.metric === "meas" ? a.mdbm : a.n; }
  function draw() {
    $("#spLo").value = (+sp.lo.toFixed(6)); $("#spHi").value = (+sp.hi.toFixed(6));
    SPEC_M.t = sp.known ? 40 : 22;  // room for the known-signals strip under the band plan
    const [g, W, H] = ctxOf(cv, 360), {l, r, t, b} = SPEC_M, pw = W - l - r, ph = H - t - b, span = sp.hi - sp.lo;
    const sc = specScale(sp.lo, sp.hi, sp.scale), tlo = sc.T(sp.lo), tspan = sc.T(sp.hi) - tlo;
    const X = f => l + pw * (sc.T(f) - tlo) / tspan;
    const vis = all.filter(a => a.f >= sp.lo && a.f <= sp.hi && value(a) != null);
    const vals = vis.map(value);
    let vmin = sp.metric === "count" ? 0 : Math.floor(Math.min(...vals, -100) / 10) * 10, vmax = sp.metric === "count" ? Math.max(1, ...vals) : Math.ceil(Math.max(...vals, -40) / 10) * 10;
    if (vmax <= vmin) vmax = vmin + 1;
    const Y = val => t + ph - ph * (val - vmin) / (vmax - vmin);
    geom = {X, Y, l, pw, span, vis, sc, tlo, tspan};
    g.clearRect(0, 0, W, H);
    g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle";
    // band plan strip
    if (sp.plan && S.bandplan) {
      S.bandplan.filter(p => p.hi > sp.lo && p.lo < sp.hi).sort((a, c) => (c.hi - c.lo) - (a.hi - a.lo)).forEach((p, i) => {
        const x0 = Math.max(l, X(p.lo)), x1 = Math.min(l + pw, X(p.hi));
        g.fillStyle = i % 2 ? "rgba(130,150,140,.18)" : "rgba(63,185,131,.16)"; g.fillRect(x0, 3, x1 - x0, 15);
        g.fillStyle = MUTED; if (x1 - x0 > 50) { g.save(); g.beginPath(); g.rect(x0, 3, x1 - x0, 15); g.clip(); g.fillText(p.label, x0 + 4, 11); g.restore(); }
      });
    }
    // known signals (Signal ID Wiki): wide ranges faint underneath, narrow ones on top; names where there's room
    if (sp.known && S.specKnown?.list) {
      let labelEnd = -1;
      for (const k of S.specKnown.list.slice().sort((a, c) => (c.ranges[0]?.[1] - c.ranges[0]?.[0]) - (a.ranges[0]?.[1] - a.ranges[0]?.[0])))
        for (const [a, c] of k.ranges) {
          const x0 = Math.max(l, X(a)), x1 = Math.min(l + pw, X(c)), w = Math.max(2, x1 - x0);
          g.fillStyle = "rgba(130,80,223,.28)"; g.fillRect(x0 - (w === 2 ? 1 : 0), 21, w, 14);
          if (w > 70 && x0 > labelEnd) { g.save(); g.beginPath(); g.rect(x0, 21, w, 14); g.clip(); g.fillStyle = INK; g.fillText(k.title, x0 + 3, 28); g.restore(); labelEnd = x0 + Math.min(w, g.measureText(k.title).width + 8); }
        }
    }
    // grid and axes: linear ticks, or decades with 1-2-5 labels and 1..9 minor ticks on a log axis
    const dg = fDigits(span), majors = [], minors = [];
    if (sc.log) {
      for (let d = Math.floor(tlo); d <= Math.ceil(tlo + tspan); d++) for (let m = 1; m <= 9; m++) {
        const f = m * 10 ** d; if (f < sp.lo || f > sp.hi) continue;
        (m === 1 || m === 2 || m === 5 ? majors : minors).push(f);
      }
    } else {
      const step = niceTick(span), minor = step / 5;
      for (let f = Math.ceil(sp.lo / minor) * minor; f <= sp.hi; f += minor) minors.push(f);
      for (let f = Math.ceil(sp.lo / step) * step; f <= sp.hi + 1e-9; f += step) majors.push(f);
    }
    const fLabel = f => sc.log ? (f >= 1000 ? `${+(f / 1000).toFixed(2)} GHz` : `${+f.toFixed(f < 10 ? 1 : 0)}`) : f.toFixed(dg);
    g.strokeStyle = LINE; g.lineWidth = 1;
    for (const f of minors) { const x = Math.round(X(f)) + .5; g.globalAlpha = .35; g.beginPath(); g.moveTo(x, t + ph); g.lineTo(x, t + ph + 4); g.stroke(); }
    g.globalAlpha = 1; g.fillStyle = MUTED; g.textAlign = "center";
    for (const f of majors) {
      const x = Math.round(X(f)) + .5;
      g.globalAlpha = .5; g.beginPath(); g.moveTo(x, t); g.lineTo(x, t + ph + 7); g.stroke(); g.globalAlpha = 1;
      g.fillText(fLabel(f), x, t + ph + 16);
    }
    g.fillText(sc.log ? "MHz (log scale)" : "MHz", l + pw / 2, H - 6);
    const ystep = niceTick(vmax - vmin, 5);
    g.textAlign = "right";
    for (let y = Math.ceil(vmin / ystep) * ystep; y <= vmax + 1e-9; y += ystep) {
      const yy = Math.round(Y(y)) + .5; g.globalAlpha = .35; g.beginPath(); g.moveTo(l, yy); g.lineTo(l + pw, yy); g.stroke(); g.globalAlpha = 1;
      g.fillText(sp.metric === "count" ? String(Math.round(y)) : `${Math.round(y)}`, l - 6, yy);
    }
    g.save(); g.translate(12, t + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.fillText(sp.metric === "count" ? "entries" : "dBm", 0, 0); g.restore();
    g.strokeStyle = MUTED; g.beginPath(); g.moveTo(l, t); g.lineTo(l, t + ph); g.lineTo(l + pw, t + ph); g.stroke();
    // signals: exact frequency; a channel-width box once it's 2 px or wider
    for (const a of vis) {
      const top = [...a.types].sort((p, q) => q[1] - p[1])[0][0], col = typeColor(top), x = X(a.f), y = Y(value(a));
      const wpx = sp.widths && a.bw ? X(a.f + a.bw / 2000) - X(a.f - a.bw / 2000) : 0;
      g.fillStyle = col; g.strokeStyle = col;
      if (wpx >= 2) { g.globalAlpha = .35; g.fillRect(x - wpx / 2, y, wpx, t + ph - y); g.globalAlpha = 1; g.fillRect(x - wpx / 2, y, wpx, 2); }
      g.lineWidth = a.meas ? 2.5 : 1.5; g.beginPath(); g.moveTo(x, t + ph); g.lineTo(x, y); g.stroke();
      if (a.meas) { g.fillStyle = "#cf222e"; g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x - 4, y - 1); g.lineTo(x + 4, y - 1); g.fill(); }
    }
    // markers
    sp.markers.forEach((m, i) => {
      if (m.f < sp.lo || m.f > sp.hi) return;
      const x = Math.round(X(m.f)) + .5;
      g.strokeStyle = ACC; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x, t); g.lineTo(x, t + ph); g.stroke(); g.setLineDash([]);
      const txt = `M${i + 1} ${m.f.toFixed(Math.max(4, dg))}`; g.font = "bold 11px system-ui, sans-serif";
      const tw = g.measureText(txt).width + 8, bx = Math.min(x + 2, l + pw - tw);
      g.fillStyle = ACC; g.fillRect(bx, t + 2, tw, 15); g.fillStyle = "#08130e"; g.textAlign = "left"; g.fillText(txt, bx + 4, t + 10); g.font = "11px system-ui, sans-serif";
    });
    drawOverview();
    loadKnown();
    $("#spInfo").textContent = `Showing ${vis.length.toLocaleString()} of ${all.length.toLocaleString()} frequencies · ${(span * 1000).toLocaleString(undefined, {maximumFractionDigits: 1})} kHz wide.`;
    paintMarkers();
  }
  function drawOverview() {
    const [g, W, H] = ctxOf(ov, 46), pad = 4, lo = Math.max(0.001, Math.min(fmin, sp.lo)), hi = Math.max(fmax, sp.hi);
    const sc = specScale(lo, hi, sp.scale === "linear" ? "linear" : "auto"), tl = sc.T(lo), ts = Math.max(sc.T(hi) - tl, 1e-9);
    const X = f => SPEC_M.l + (W - SPEC_M.l - SPEC_M.r) * (sc.T(f) - tl) / ts, bins = new Array(400).fill(0);
    for (const a of all) bins[Math.max(0, Math.min(399, Math.floor(399 * (sc.T(a.f) - tl) / ts)))] += a.n;
    const mx = Math.max(...bins), bw = (W - SPEC_M.l - SPEC_M.r) / 400;
    g.fillStyle = MUTED; bins.forEach((n, i) => { if (n) { const h = (H - 2 * pad) * Math.sqrt(n / mx); g.fillRect(SPEC_M.l + i * bw, H - pad - h, Math.max(1, bw), h); } });
    g.fillStyle = "rgba(63,185,131,.22)"; g.strokeStyle = ACC; const x0 = X(sp.lo), x1 = X(sp.hi);
    g.fillRect(x0, 1, Math.max(2, x1 - x0), H - 2); g.strokeRect(x0 + .5, 1.5, Math.max(2, x1 - x0), H - 3);
    g.fillStyle = MUTED; g.font = "10px system-ui, sans-serif"; g.textBaseline = "top"; g.textAlign = "left"; g.fillText(fmtF(lo), SPEC_M.l, 2); g.textAlign = "right"; g.fillText(fmtF(hi), W - SPEC_M.r, 2);
    ov._map = {sc, tl, ts, w: W - SPEC_M.l - SPEC_M.r};
  }
  // nearest signal to an x position, within 6 px
  const near = px => { let best = null, bd = 7; for (const a of geom.vis) { const d = Math.abs(geom.X(a.f) - px); if (d < bd) { bd = d; best = a; } } return best; };
  const fAt = px => geom.sc.Ti(geom.tlo + (px - geom.l) * geom.tspan / geom.pw);
  const evX = e => e.clientX - cv.getBoundingClientRect().left;

  let drag = null;
  cv.onmousedown = e => { drag = {x0: evX(e), lo: sp.lo, hi: sp.hi, pan: e.shiftKey}; };
  window.onmouseup = e => {
    if (!drag || !$("#spCv")) { drag = null; return; }
    const x1 = evX(e), d = drag; drag = null;
    if (d.pan) return;
    if (Math.abs(x1 - d.x0) > 6) setRange(fAt(Math.min(d.x0, x1)), fAt(Math.max(d.x0, x1)));
    else { const a = near(x1); addMarker(a ? a.f : fAt(x1)); }
  };
  cv.onmousemove = e => {
    const x = evX(e);
    if (drag && drag.pan) { const {T, Ti} = geom.sc, du = (x - drag.x0) * (T(drag.hi) - T(drag.lo)) / geom.pw; sp.lo = Ti(T(drag.lo) - du); sp.hi = Ti(T(drag.hi) - du); draw(); return; }
    if (drag) { draw(); const g = cv.getContext("2d"); g.fillStyle = "rgba(63,185,131,.18)"; g.fillRect(Math.min(drag.x0, x), SPEC_M.t, Math.abs(x - drag.x0), cv.clientHeight - SPEC_M.t - SPEC_M.b); return; }
    const y = e.clientY - cv.getBoundingClientRect().top;
    if (sp.known && y >= 19 && y <= 37) {  // hovering the known-signals strip
      const ks = knownAt(fAt(x));
      if (!ks.length) { tip.hidden = true; return; }
      tip.innerHTML = `<b>Signal ID Wiki</b> at ${fmtF(fAt(x))} MHz<br>${ks.slice(0, 8).map(k => `${esc(k.title)} <span class="hint">${esc([k.mode, k.modulation].filter(Boolean).join(" · "))}</span>`).join("<br>")}${ks.length > 8 ? `<br><span class="hint">+${ks.length - 8} more</span>` : ""}`;
      tip.hidden = false; tip.style.left = Math.min(x + 14, cv.clientWidth - 330) + "px"; tip.style.top = (y + 14) + "px";
      return;
    }
    const a = near(x);
    if (!a) { tip.hidden = true; return; }
    tip.innerHTML = `<b class="mono">${fmtF(a.f)} MHz</b>${a.bw ? ` · ${num(a.bw, 2)} kHz wide` : ""}<br>${a.n} entr${a.n === 1 ? "y" : "ies"}${a.meas ? ` (${a.meas} measured${a.mdbm != null ? `, up to ${num(a.mdbm, 0)} dBm` : ""})` : ""}${a.est != null ? ` · strongest predicted ${num(a.est, 0)} dBm` : ""}<br>
      ${[...a.types].map(([k, n]) => `<span class="dot" style="background:${typeColor(k)}"></span>${esc(k)} ${n}`).join(" · ")}<br><span class="hint">${esc([...a.names].slice(0, 4).join("; "))}</span>`;
    tip.hidden = false; tip.style.left = Math.min(x + 14, cv.clientWidth - 330) + "px"; tip.style.top = (e.clientY - cv.getBoundingClientRect().top + 14) + "px";
  };
  cv.onmouseleave = () => { tip.hidden = true; };
  cv.addEventListener("wheel", e => {  // plain wheel scrolls the page; Ctrl + wheel zooms here
    if (!e.ctrlKey) return;
    e.preventDefault();
    around(fAt(evX(e)), e.deltaY > 0 ? 1.25 : 0.8);
  }, {passive: false});
  let ovDrag = false;
  const ovMove = e => {  // centre the window on the overview position, keeping its width in axis units
    const m = ov._map, x = e.clientX - ov.getBoundingClientRect().left - SPEC_M.l, c = m.tl + m.ts * x / m.w;
    const {T, Ti} = specScale(sp.lo, sp.hi, sp.scale), half = (T(sp.hi) - T(sp.lo)) / 2, cc = T(m.sc.Ti(c));
    sp.lo = Math.max(0.001, Ti(cc - half)); sp.hi = Ti(cc + half); draw();
  };
  ov.onmousedown = e => { ovDrag = true; ovMove(e); };
  ov.onmousemove = e => { if (ovDrag) ovMove(e); };
  ov.onmouseup = ov.onmouseleave = () => { ovDrag = false; };

  $("#spLo").onchange = $("#spHi").onchange = () => { const lo = +$("#spLo").value, hi = +$("#spHi").value; if (hi > lo) setRange(lo, hi); };
  $("#spPreset").onchange = e => { const [, lo, hi] = SPEC_PRESETS[+e.target.value]; if (lo == null) { sp.lo = sp.hi = null; render(); } else setRange(lo, hi); };
  const mid = () => { const {T, Ti} = specScale(sp.lo, sp.hi, sp.scale); return Ti((T(sp.lo) + T(sp.hi)) / 2); };
  $("#spIn").onclick = () => around(mid(), 0.5); $("#spOut").onclick = () => around(mid(), 2);
  const pan = d => { const {T, Ti} = specScale(sp.lo, sp.hi, sp.scale), s = (T(sp.hi) - T(sp.lo)) * d; setRange(Ti(T(sp.lo) + s), Ti(T(sp.hi) + s)); };
  $("#spScale").onchange = e => { sp.scale = e.target.value; draw(); };
  $("#spLeft").onclick = () => pan(-0.5); $("#spRight").onclick = () => pan(0.5);
  $("#spMetric").onchange = e => { sp.metric = e.target.value; draw(); };
  $("#spPlan").onchange = e => { sp.plan = e.target.checked; draw(); };
  $("#spWidths").onchange = e => { sp.widths = e.target.checked; draw(); };
  $("#spKnown").onchange = e => { sp.known = e.target.checked; knownKey = null; draw(); };
  $("#spAdd").onclick = () => { const f = parseFloat($("#spAddF").value); if (f) { addMarker(f); $("#spAddF").value = ""; } };
  $("#spAddF").onkeydown = e => { if (e.key === "Enter") $("#spAdd").onclick(); };
  $("#spClear").onclick = () => { sp.markers = []; saveMarkers(); draw(); };

  function addMarker(f) { sp.markers.push({f: +f.toFixed(6), label: ""}); saveMarkers(); draw(); }
  function paintMarkers() {
    const box = $("#spMarkers");
    if (!sp.markers.length) { box.innerHTML = '<p class="hint">No markers yet. Click the spectrum, or type a frequency and Add.</p>'; return; }
    const m1 = sp.markers[0].f;
    box.innerHTML = `<div class="tw"><table><thead><tr><th>Marker</th><th>MHz</th><th>Δ from M1</th><th>Label</th><th>On or within ±6.25 kHz</th><th>Could be (Signal ID Wiki)</th><th class="no-print"></th></tr></thead><tbody>
      ${sp.markers.map((m, i) => { const hits = sig.filter(r => Math.abs(r.freq_mhz - m.f) <= 0.00625 + 1e-9);
        const who = [...new Set(hits.map(titleOf))].slice(0, 3);
        return `<tr><td><b>M${i + 1}</b></td><td class="mono">${m.f.toFixed(5)}</td><td class="mono">${i ? `${((m.f - m1) * 1000).toFixed(2)} kHz` : "—"}</td>
          <td><input data-ml="${i}" value="${esc(m.label)}" placeholder="name it" style="width:150px"></td>
          <td>${hits.length ? `${hits.length} entr${hits.length === 1 ? "y" : "ies"}: ${esc(who.join("; "))}` : '<span style="color:var(--good)">nothing licensed or recorded</span>'}</td>
          <td data-msw="${i}" class="hint">…</td>
          <td class="no-print"><button data-mz="${i}" title="Centre here">⌖</button>${S.missionId ? `<button data-mw="${i}" title="Add to the active mission's watch list">→ Watch list</button>` : ""}<button data-mx="${i}" class="danger">✕</button></td></tr>`; }).join("")}</tbody></table></div>`;
    box.querySelectorAll("[data-msw]").forEach(td => {
      const m = sp.markers[+td.dataset.msw], hit = sig.find(r => Math.abs(r.freq_mhz - m.f) <= 0.00625 + 1e-9);
      api(`/api/sigwiki/match?limit=3&freq=${m.f}&type=${encodeURIComponent(hit?.sig_type || "")}&bw=${hit?.bandwidth_khz || hit?.bw_khz || ""}`)
        .then(r => { td.innerHTML = r.candidates.length ? r.candidates.map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.why.join(" · "))}">${esc(c.title)}</a>`).join(", ") : "—"; })
        .catch(() => { td.textContent = "—"; });
    });
    box.querySelectorAll("[data-ml]").forEach(el => el.onchange = () => { sp.markers[+el.dataset.ml].label = el.value; saveMarkers(); });
    box.querySelectorAll("[data-mx]").forEach(el => el.onclick = () => { sp.markers.splice(+el.dataset.mx, 1); saveMarkers(); draw(); });
    box.querySelectorAll("[data-mz]").forEach(el => el.onclick = () => { const f = sp.markers[+el.dataset.mz].f, h = Math.min((sp.hi - sp.lo) / 2, 0.05); setRange(f - h, f + h); });
    box.querySelectorAll("[data-mw]").forEach(el => el.onclick = async () => {
      const m = sp.markers[+el.dataset.mw], watch = [...(S.mission?.settings?.watch || []), {freq: m.f, tol_khz: 12.5, label: m.label || `Spectrum M${+el.dataset.mw + 1}`}];
      try { await post(`/api/missions/${S.missionId}`, {settings: {watch}}); await loadMission(S.missionId); el.textContent = "✓ Added"; } catch (e) { el.textContent = "Error"; el.title = e.message; }
    });
  }
  draw();
  window.onresize = () => { if ($("#spCv")) draw(); };
};
