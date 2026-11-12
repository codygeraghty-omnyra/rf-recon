"use strict";
/* DAStastic: one colour scale for every signal map (11/10). Cody: survey tiles "colour coded like the tiles of the heat map".
   Until now the walk test ran red (fail) to green on the job's pass line while the outdoor heat map ran a turbo ramp whose red
   meant strong, so the same colour said opposite things on two tabs. Every map takes its colours from here:
   - a reading against its pass line: red weak, amber on the line, green good, with a hard step at the line so a failing reading
     is never amber (STOPS); a metric with no pass line runs the readings' lowest to highest, red to green (SMOOTH);
   - pass lines: the job's cellular profile (dascell.js cellProfile) when there is one, else the Common preset (COMMON:
     RSRP -95 dBm below 3.3 GHz, -100 dBm from 3.3 GHz, SINR 5 dB);
   - a change between two passes: red worse, white the same, blue better (DIFF);
   - best server: six colours that stay apart for colour-blind eyes on a map, where any two tiles can touch (BEST: Okabe-Ito
     without yellow and black, checked with every pair against every other by the dataviz palette validator, 11/10: normal
     vision 15.6, colour-blind 7.6, so the legend and the tile's own label carry the name too); a seventh server and on is OTHER;
   - hatching on failing tiles, so pass and fail never rest on red and green alone.
   rfscale.py keeps the same tables for the server's pictures; tests/test_rfscale.py checks the two match line for line and give
   the same colours. Each table below is written as JSON on its own line so that test can read it. */
const RFScale = (() => {
  // t: where a reading sits against its pass line, in spans: -1 a full span weaker, 0 on the line, 1 a full span stronger
  const STOPS = [[-1, [142, 27, 27]], [-0.000001, [229, 83, 75]], [0, [250, 178, 25]], [0.3333333333333333, [166, 212, 106]], [1, [47, 163, 95]]];
  const SMOOTH = [[-1, [229, 83, 75]], [0, [250, 178, 25]], [1, [47, 163, 95]]];
  const DIFF = [[-1, [207, 34, 46]], [0, [245, 245, 245]], [1, [31, 111, 235]]];
  // how far a full colour reaches either side of the pass line (span), the unit and the decimals, per metric
  const METRICS = {"rsrp": {"span": 15, "unit": " dBm", "dig": 0}, "rsrq": {"span": 6, "unit": " dB", "dig": 0}, "sinr": {"span": 8, "unit": " dB", "dig": 0}, "dl": {"span": 15, "unit": " dBm", "dig": 0}, "ul": {"span": 15, "unit": " dBm", "dig": 0}, "daq": {"span": 1.5, "unit": "", "dig": 1}};
  // the Common preset's pass lines (dascell.js CELL_PRESETS.common; tests/test_rfscale.py keeps the two the same)
  const COMMON = {"rsrp": -95, "rsrp_hi": -100, "sinr": 5};
  const BEST = ["#E69F00", "#56B4E9", "#009E73", "#0072B2", "#D55E00", "#CC79A7"];
  const OTHER = "#8c959f";
  // a failing tile's stripes: rising at angle degrees (lower left to upper right), gap px apart, width px wide
  const HATCH = {"angle": 45, "gap": 6, "width": 1.5, "ink": "rgba(20,20,20,0.55)"};

  const clamp = t => Math.max(-1, Math.min(1, t));
  // t (-1 to 1) along a table of stops -> [r, g, b]
  function ramp(t, st) {
    t = clamp(t);
    for (let i = 1; i < st.length; i++) if (t <= st[i][0]) {
      const [t0, c0] = st[i - 1], [t1, c1] = st[i], k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * k));
    }
    return st[st.length - 1][1];
  }
  // a reading against its scale: {thr, span} (a pass line) or {thr: null, lo, hi} (none: lowest to highest)
  function rgb(v, sc) {
    if (sc.thr != null) return ramp((v - sc.thr) / sc.span, STOPS);
    return ramp(sc.hi > sc.lo ? (v - sc.lo) / (sc.hi - sc.lo) * 2 - 1 : 0, SMOOTH);
  }
  // a change: worse red, the same white, better blue; full colour at plus or minus span
  const diff = (dv, span) => ramp(dv / span, DIFF);
  const pass = (v, sc) => sc.thr == null ? null : v >= sc.thr;
  const hex = c => "#" + c.map(x => x.toString(16).padStart(2, "0")).join("");
  const css = (c, a) => a == null ? `rgb(${c.join(",")})` : `rgba(${c.join(",")},${a})`;
  // outlines and marks in the scale's own colours: fail red, on-the-line amber, pass green
  const INK = {fail: hex(STOPS[1][1]), amber: hex(STOPS[2][1]), pass: hex(STOPS[4][1])};

  // a cellular pass line for a metric: the job's profile (dascell.js cellProfile) or Common; a carrier's own line from 3.3 GHz
  // (layer "hi") wins over the profile's, as dascell.js cellThr. RSRQ has none: no profile sets one.
  function passLine(metric, carrier, layer, P) {
    const p = P || COMMON;
    if (metric === "rsrp") return layer === "hi" ? (p.hi_by?.[carrier] ?? p.rsrp_hi ?? p.rsrp ?? null) : (p.rsrp ?? null);
    if (metric === "sinr") return p.sinr ?? null;
    return null;
  }
  // a metric's scale: its pass line when it has one, else the readings' lowest to highest. what: where the line came from
  function scale(metric, thr, vals, what) {
    const m = METRICS[metric] || METRICS.rsrp;
    if (thr == null || !isFinite(+thr)) {
      let lo = Infinity, hi = -Infinity;
      for (const x of vals || []) if (isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; }
      return {thr: null, lo: lo === Infinity ? 0 : lo, hi: hi === -Infinity ? 1 : hi, unit: m.unit, what};
    }
    return {thr: +thr, span: m.span, unit: m.unit, what};
  }
  // the readings' scale for one carrier and layer: the profile's line, or Common's when the job has none
  const forCell = (metric, carrier, layer, P, vals) => scale(metric, passLine(metric, carrier, layer, P), vals,
    P ? `the cellular target (${P.name || "this job's"})` : "the Common cellular target");
  // the ends the legend shows: a span either side of the pass line, or the lowest and highest reading
  const range = sc => sc.thr != null ? [sc.thr - sc.span, sc.thr + sc.span] : [sc.lo, sc.hi];

  /* ---------- legends ---------- */
  const fmt = (v, d = 0) => v == null || v === "" || isNaN(v) ? "" : Number(v).toFixed(d).replace(/^-(0(.0+)?)$/, "$1");
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  // the bar as CSS: each stop at its place between the ends, so the step at the pass line shows as a step. With no pass line
  // and every reading the same, rgb() draws every one amber, so the bar is amber too: a red-to-green bar between "-11" and
  // "-11 dB" said the opposite of the map, and of legendBar's picture (review 11/10)
  function gradient(sc) {
    if (sc.thr == null && !(sc.hi > sc.lo)) return css(rgb(sc.lo, sc));
    if (sc.thr == null) return `linear-gradient(90deg,${SMOOTH.map(([t, c]) => `${css(c)} ${fmt((t + 1) * 50, 1)}%`).join(",")})`;
    return `linear-gradient(90deg,${STOPS.map(([t, c]) => `${css(c)} ${fmt((t + 1) * 50, 1)}%`).join(",")})`;
  }
  // a swatch's CSS for a failing tile's hatching (the legend's "below the line"): the stripes hatch() draws on the tiles, rising
  // at HATCH.angle and HATCH.gap px apart. CSS turns a gradient's angle into stripes a right angle round from it, so 45 degrees
  // drew the mirror image, and 40% sparser than the canvas's (review 11/10)
  const hatchCss = () => `repeating-linear-gradient(${90 + HATCH.angle}deg,${HATCH.ink} 0 ${HATCH.width}px,transparent ${HATCH.width}px ${HATCH.gap}px)`;
  // the legend line: the ends, the bar, and what the colours mean. o: {label, dig, note (e.g. "3 of 5 points pass"), hatch}
  function legendHtml(sc, o = {}) {
    const [lo, hi] = range(sc), dig = o.dig ?? (METRICS[o.metric] || {}).dig ?? 0, label = o.label || "";
    const says = sc.thr != null ? `${escH(label)}: pass at ≥ ${fmt(sc.thr, dig)}${escH(sc.unit)}${sc.what ? `, from ${escH(sc.what)}` : ""}${o.note ? ` · ${escH(o.note)}` : ""}`
      : `${escH(label)}: no requirement set for it, so colours run from the lowest to the highest reading`;
    const sw = o.hatch && sc.thr != null ? `<span class="rfs-hatch" title="Below the pass line" style="display:inline-block;width:14px;height:12px;border-radius:3px;background:${hatchCss()},${INK.fail}"></span><span class="hint">below the line</span>` : "";
    return `<div class="rfs-legend" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="mono">${fmt(lo, dig)}</span>`
      + `<span style="flex:0 1 220px;min-width:120px;height:12px;border-radius:6px;background:${gradient(sc)}"></span><span class="mono">${fmt(hi, dig)}${escH(sc.unit)}</span>`
      + `${sw}<span class="hint">${says}</span></div>`;
  }
  // the bar on a canvas (a picture for the Report or Files): w pixels from x, h tall
  function legendBar(g, x, y, w, h, sc) {
    const [lo, hi] = range(sc);
    for (let k = 0; k < w; k++) { g.fillStyle = css(rgb(lo + (hi - lo) * k / w, sc)); g.fillRect(x + k, y, 1, h); }
  }
  // best server: each site its colour, the most readings first; a seventh site and on is OTHER. keys in that order
  // (a site keeps its colour while the view or a filter changes: the order comes from the whole run, never the screen)
  const bestColours = keys => new Map((keys || []).map((k, i) => [k, i < BEST.length ? BEST[i] : OTHER]));
  // hatching for a failing tile on a canvas: a pattern of thin lines rising at 45 degrees, HATCH.gap px apart (the pattern's
  // tile is the gap times the square root of 2 across, since its diagonal lines repeat along both edges), null where there's
  // no canvas, as in node
  function hatch(g, dpr = 1) {
    if (typeof document === "undefined" || !g || !g.createPattern) return null;
    const n = Math.max(2, Math.round(HATCH.gap * Math.SQRT2 * dpr)), c = document.createElement("canvas"); c.width = c.height = n;
    const x = c.getContext("2d"); if (!x) return null;
    x.strokeStyle = HATCH.ink; x.lineWidth = HATCH.width * dpr; x.lineCap = "square";
    x.beginPath(); x.moveTo(0, n); x.lineTo(n, 0); x.moveTo(-n / 2, n / 2); x.lineTo(n / 2, -n / 2); x.moveTo(n / 2, n * 1.5); x.lineTo(n * 1.5, n / 2); x.stroke();
    return g.createPattern(c, "repeat");
  }
  const T = Object.freeze;
  return T({STOPS: T(STOPS), SMOOTH: T(SMOOTH), DIFF: T(DIFF), METRICS: T(METRICS), COMMON: T(COMMON), BEST: T(BEST), OTHER, HATCH: T(HATCH), INK: T(INK),
    ramp, rgb, diff, pass, hex, css, passLine, scale, forCell, range, fmt, gradient, hatchCss, legendHtml, legendBar, bestColours, hatch});
})();
if (typeof window !== "undefined") window.RFScale = RFScale;
