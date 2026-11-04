"use strict";
/* RF Recon phone app: where a signal probably is, worked out on the phone with no signal. A faithful port of the PC
   app's geo.py: level_fix (levels alone: a grid search over spots and path loss exponents 2-4, SHADOW_DB, the
   chi-square 95% region), bearing_fix with its error_ellipse, combine_fixes, and app.py's mission_hunt (the readings
   on one frequency, the estimate, and which way and how far it is from you). Keep it in step with geo.py:
   tests/test_phone_geofix.py runs both on the same readings. No DOM here, so Node can load it for that test. */
const GeoFix = (() => {
  const EARTH_KM = 6371.0088, SHADOW_DB = 6.0, BEARING_ERR_DEG = 5.0;
  const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  const pmod = (a, n) => ((a % n) + n) % n;  // Python's %: the result takes the divisor's sign
  const r6 = v => Math.round(v * 1e6) / 1e6;
  const pyRound = v => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1; };  // halves to even, as Python's round()
  const sum = a => a.reduce((s, x) => s + x, 0);
  const have = v => v !== null && v !== undefined && v !== "" && isFinite(v);

  function haversineKm(lat1, lon1, lat2, lon2) {
    const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = b => POINTS[Math.floor((b + 11.25) / 22.5) % 16];

  // geo.error_ellipse: the 95% ellipse of a bearing fix (each line's sideways error grows with distance)
  function errorEllipse(lines, fx, fy, lat0, lon0, kx, ky, conf = 0.95) {
    const dist = lines.map(([x, y]) => Math.max(30, Math.hypot(fx - x, fy - y)));
    let err = BEARING_ERR_DEG;
    if (lines.length >= 3) {
      const ang = lines.map(([x, y, ux, uy], i) => deg(Math.atan2(Math.abs((fx - x) * uy - (fy - y) * ux), dist[i])));
      err = Math.max(err, Math.sqrt(sum(ang.map(a => a * a)) / (ang.length - 2)));
    }
    let s11 = 0, s12 = 0, s22 = 0;
    lines.forEach(([, , ux, uy], i) => {
      const w = 1 / (dist[i] * Math.tan(rad(err))) ** 2;
      s11 += w * (1 - ux * ux); s12 -= w * ux * uy; s22 += w * (1 - uy * uy);
    });
    const det = s11 * s22 - s12 * s12;
    if (det <= 0) return null;
    const c11 = s22 / det, c12 = -s12 / det, c22 = s11 / det;
    const tr = (c11 + c22) / 2, dif = Math.sqrt(((c11 - c22) / 2) ** 2 + c12 * c12);
    const l1 = tr + dif, l2 = Math.max(tr - dif, 0);
    const k = Math.sqrt(-2 * Math.log(1 - conf));
    const a = k * Math.sqrt(l1), b = k * Math.sqrt(l2);
    const theta = 0.5 * Math.atan2(2 * c12, c11 - c22);
    const ring = [];
    for (let i = 0; i < 49; i++) {
      const t = 2 * Math.PI * i / 48;
      const ex = a * Math.cos(t) * Math.cos(theta) - b * Math.sin(t) * Math.sin(theta);
      const ey = a * Math.cos(t) * Math.sin(theta) + b * Math.sin(t) * Math.cos(theta);
      ring.push([r6(lat0 + (fy + ey) / ky), r6(lon0 + (fx + ex) / kx)]);
    }
    return {a_m: pyRound(a), b_m: pyRound(b), axis_deg: pyRound(pmod(90 - deg(theta), 180)), bearing_err_deg: Math.round(err * 10) / 10, conf, ring};
  }

  // geo.bearing_fix: where lines of bearing cross, least squares on a flat local plane. readings: [[lat, lon, bearing]]
  function bearingFix(readings) {
    const pts = readings.filter(([a, o, b]) => have(a) && have(o) && have(b)).map(([a, o, b]) => [+a, +o, pmod(+b, 360)]);
    if (pts.length < 2) return null;
    const lat0 = sum(pts.map(p => p[0])) / pts.length, lon0 = sum(pts.map(p => p[1])) / pts.length;
    const kx = 1000 * EARTH_KM * rad(1) * Math.cos(rad(lat0)), ky = 1000 * EARTH_KM * rad(1);
    const lines = pts.map(([a, o, b]) => [(o - lon0) * kx, (a - lat0) * ky, Math.sin(rad(b)), Math.cos(rad(b))]);
    let s11 = 0, s12 = 0, s22 = 0, t1 = 0, t2 = 0;
    for (const [x, y, ux, uy] of lines) {
      const a11 = 1 - ux * ux, a12 = -ux * uy, a22 = 1 - uy * uy;
      s11 += a11; s12 += a12; s22 += a22;
      t1 += a11 * x + a12 * y; t2 += a12 * x + a22 * y;
    }
    const det = s11 * s22 - s12 * s12;
    if (Math.abs(det) < 1e-6 * lines.length ** 2) return null;
    const fx = (s22 * t1 - s12 * t2) / det, fy = (s11 * t2 - s12 * t1) / det;
    const miss = lines.map(([x, y, ux, uy]) => Math.abs((fx - x) * uy - (fy - y) * ux));
    const behind = lines.filter(([x, y, ux, uy]) => (fx - x) * ux + (fy - y) * uy < 0).length;
    const bs = pts.map(p => p[2]).slice(0, 200);
    let crossing = -Infinity;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const m = pmod(bs[i] - bs[j], 180); crossing = Math.max(crossing, Math.min(m, 180 - m)); }
    const rms = Math.sqrt(sum(miss.map(m => m * m)) / miss.length);
    const quality = behind || crossing < 20 ? "poor" : crossing < 45 || pts.length < 3 ? "fair" : "good";
    const out = {lat: lat0 + fy / ky, lon: lon0 + fx / kx, n: pts.length, rms_m: rms, crossing_deg: crossing, behind, quality};
    out.ellipse = errorEllipse(lines, fx, fy, lat0, lon0, kx, ky);
    return out;
  }

  // geo.level_fix: levels alone. P = A - 10 n log10(d); every spot on a grid around the readings, n from 2 to 4, the
  // best-fitting A; the best spot is the estimate and the ones that fit nearly as well (95%) the area. readings: [[lat, lon, dbm]]
  function levelFix(readings, grid = 70) {
    const pts = readings.filter(([a, o, p]) => have(a) && have(o) && have(p)).map(([a, o, p]) => [+a, +o, +p]);
    if (pts.length < 3 || Math.max(...pts.map(p => p[2])) - Math.min(...pts.map(p => p[2])) < 6) return null;
    const lat0 = sum(pts.map(p => p[0])) / pts.length, lon0 = sum(pts.map(p => p[1])) / pts.length;
    const kx = 1000 * EARTH_KM * rad(1) * Math.cos(rad(lat0)), ky = 1000 * EARTH_KM * rad(1);
    const xy = pts.map(([a, o, p]) => [(o - lon0) * kx, (a - lat0) * ky, p]);
    const xs = xy.map(q => q[0]), ys = xy.map(q => q[1]);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 100);
    const pad = Math.max(300, span);  // the source can be outside the walked area, more so when the readings only rise one way
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    const step = Math.max(x1 - x0, y1 - y0) / grid;
    const exps = [2.0, 2.5, 3.0, 3.5, 4.0], m = xy.length, lg = new Array(m);
    const cells = [];
    for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) {
      const cx = x0 + i * step, cy = y0 + j * step;
      for (let k = 0; k < m; k++) lg[k] = Math.log10(Math.max(10, Math.hypot(cx - xy[k][0], cy - xy[k][1])));
      let best = null;
      for (const n of exps) {
        let a = 0;
        for (let k = 0; k < m; k++) a += xy[k][2] - -10 * n * lg[k];
        a /= m;
        let sse = 0;
        for (let k = 0; k < m; k++) sse += (xy[k][2] - a - -10 * n * lg[k]) ** 2;
        if (best === null || sse < best[0]) best = [sse, n];
      }
      cells.push([best[0], cx, cy, best[1]]);
    }
    let top = cells[0];  // min(cells): the tuples compared in turn, as Python does
    for (const c of cells) if (c[0] < top[0] || (c[0] === top[0] && (c[1] < top[1] || (c[1] === top[1] && (c[2] < top[2] || (c[2] === top[2] && c[3] < top[3])))))) top = c;
    const [sse0, bx, by, bn] = top;
    const sigma2 = Math.max(SHADOW_DB ** 2, sse0 / Math.max(1, m - 2));
    const region = cells.filter(c => c[0] <= sse0 + 5.99 * sigma2);  // chi-square, 2 dof, 95%
    const radius = Math.sqrt(region.length * step * step / Math.PI);
    const ring = [];  // the outline: the farthest region cell in each of 36 directions from the estimate
    for (let k = 0; k < 37; k++) {
      const t = rad(k * 10);
      let far = null;
      for (const c of region) {
        if (Math.abs(pmod((deg(Math.atan2(c[1] - bx, c[2] - by)) - k * 10) + 180, 360) - 180) > 6) continue;
        const h = Math.hypot(c[1] - bx, c[2] - by);
        if (far === null || h > far) far = h;
      }
      if (far === null) far = step;
      ring.push([r6(lat0 + (by + far * Math.cos(t)) / ky), r6(lon0 + (bx + far * Math.sin(t)) / kx)]);
    }
    let strong = pts[0];
    for (const p of pts) if (p[2] > strong[2]) strong = p;
    const quality = pts.length >= 5 && radius < 250 ? "good" : radius < 700 ? "fair" : "poor";
    return {lat: lat0 + by / ky, lon: lon0 + bx / kx, n: pts.length, radius_m: pyRound(radius), n_exp: bn, quality, ring,
      strongest: {lat: strong[0], lon: strong[1], dbm: strong[2]}};
  }

  // geo.combine_fixes: one best guess, each estimate weighted by how small its area is
  function combineFixes(level, bearing) {
    if (!level || !bearing) return level || bearing || null;
    const rb = Math.max(30, (bearing.ellipse || {}).a_m || bearing.rms_m || 300), rl = Math.max(30, level.radius_m);
    const wb = 1 / rb ** 2, wl = 1 / rl ** 2;
    return {lat: (bearing.lat * wb + level.lat * wl) / (wb + wl), lon: (bearing.lon * wb + level.lon * wl) / (wb + wl),
      radius_m: pyRound(1 / Math.sqrt(wb + wl)), from: "levels and bearings"};
  }

  // app.py mission_hunt: readings [{ts, lat, lon, freq_mhz, dbm, bearing}] on one frequency (within tolKhz; any when none
  // is given), the latest 400, their levels (the latest 120) and bearings, the best guess, and from where you are
  function hunt(readings, freq, tolKhz = 12.5, hereLat = null, hereLon = null) {
    const pts = readings.filter(r => have(r.lat) && have(r.lon) && (!freq || (have(r.freq_mhz) && Math.abs(r.freq_mhz - freq) <= tolKhz / 1000 + 1e-9)))
      .slice().sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, 400)
      .map(r => ({ts: r.ts, lat: +r.lat, lon: +r.lon, freq_mhz: r.freq_mhz, dbm: have(r.dbm) ? +r.dbm : null, bearing: have(r.bearing) ? +r.bearing : null, id: r.id}));
    const lv = pts.filter(p => p.dbm != null).slice(0, 120);
    const level = levelFix(lv.map(p => [p.lat, p.lon, p.dbm]));
    const bearing = bearingFix(pts.filter(p => p.bearing != null).map(p => [p.lat, p.lon, p.bearing]));
    const best = combineFixes(level, bearing);
    const out = {readings: pts, level, bearing, best};
    if (best && have(hereLat) && have(hereLon)) {
      const b = bearingDeg(hereLat, hereLon, best.lat, best.lon);
      out.from_you = {m: pyRound(1000 * haversineKm(hereLat, hereLon, best.lat, best.lon)), deg: pyRound(b), compass: compass(b)};
    }
    return out;
  }

  return {levelFix, bearingFix, combineFixes, errorEllipse, hunt, haversineKm, bearingDeg, compass, SHADOW_DB};
})();
if (typeof module === "object" && module.exports) module.exports = GeoFix;
