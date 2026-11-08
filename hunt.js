"use strict";
/* DAStastic phone app: Find a signal, with no signal (the PC's Mission tab, static/hunt.js, on the phone). Walk toward
   it: at each stop the phone's own GPS position (a fresh fix, never a kept one), the level read off any receiver, and
   optionally the direction from the phone's compass. Each stop is a field log reading kept on this phone (so the
   Field log's CSV takes it to the PC); the estimate is worked out here (geofix.js: geo.py's level_fix, bearing_fix and
   combine_fixes), with warmer / colder and a map of the estimate and the area it's probably in.
   Needs app.js (S, $, esc, num, fmtF, kv, idb, head, toast, loadLog, licenceCheck, setTab, setCenter, BASES), geofix.js
   and wmm.js (the PC's static/wmm.js, copied in by publish.py). */

const HUNT = {freq: "", tol: 12.5, since: "", here: null, mag: null, spread: null, acc: null, how: "", last: 0, samples: [], paint: 0,
  listening: false, map: null, loaded: false, ref: "mag"};
const HUNT_TOL = [[6.25, "6.25 kHz (one channel)"], [12.5, "12.5 kHz"], [25, "25 kHz"], [1000, "1 MHz (a booster's whole band)"], [5000, "5 MHz"]];
const hSave = () => kv.set("hunt", {freq: HUNT.freq, tol: HUNT.tol, since: HUNT.since, ref: HUNT.ref});
const hSay = (t, bad) => { const m = $("#hn_msg"); if (m) { m.textContent = t; m.style.color = bad ? "var(--bad-ink)" : ""; } };
const hFreq = () => { const f = parseFloat($("#hn_f")?.value ?? HUNT.freq); return isFinite(f) && f > 0 ? f : null; };

// The phone's compass, as the PC's Find a signal reads it (static/hunt.js huntHeadingOf, 11/4): iOS gives
// webkitCompassHeading (after a permission asked from a tap) and its accuracy (negative: not calibrated); Android Chrome
// an absolute alpha/beta/gamma (a relative alpha is never used). Held flat, the heading is where the top edge points
// (the screen's top when it's turned sideways); held upright, where the back (the camera) points, tilt-compensated
// (the W3C DeviceOrientation spec's compass formula). Readings are averaged over the last second (circular mean) with
// their spread shown. Phones read magnetic north: every bearing is turned to true north with NOAA's World Magnetic
// Model (wmm.js) at the stop's own position as it's saved.
function hHeadingOf(e) {
  const d = Math.PI / 180, scr = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  const upright = e.beta != null && Math.abs(e.beta) > 45;
  if (e.webkitCompassHeading != null) return {mag: ((e.webkitCompassHeading + (upright ? 0 : scr)) % 360 + 360) % 360, acc: e.webkitCompassAccuracy, how: upright ? "camera side" : "top edge"};
  if (!e.absolute || e.alpha == null) return null;
  if (upright && e.gamma != null) {  // rear-camera direction, tilt-compensated
    const x = e.beta * d, y = e.gamma * d, z = e.alpha * d, cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const Vx = -cZ * sY - sZ * sX * cY, Vy = -sZ * sY + cZ * sX * cY;
    let hd = Math.atan(Vx / Vy); if (Vy < 0) hd += Math.PI; else if (Vx < 0) hd += 2 * Math.PI;
    return {mag: hd / d, acc: null, how: "camera side"};
  }
  return {mag: ((360 - e.alpha + scr) % 360 + 360) % 360, acc: null, how: "top edge"};
}
function hCircMean(xs) {
  const d = Math.PI / 180; let s = 0, c = 0;
  for (const x of xs) { s += Math.sin(x * d); c += Math.cos(x * d); }
  const m = ((Math.atan2(s, c) / d) + 360) % 360, R = Math.hypot(s, c) / xs.length;
  return {mean: m, spread: R >= 1 ? 0 : Math.sqrt(-2 * Math.log(R)) / d};  // circular standard deviation, degrees
}
const hDecl = p => p && window.WMM ? WMM.declination(p.lat, p.lon) : null;  // east positive; null outside WMM2025's years
const hTrue = (mag, p) => { const dc = hDecl(p); return dc == null ? mag : ((mag + dc) % 360 + 360) % 360; };
const hLive = () => HUNT.listening && HUNT.mag != null && Date.now() - HUNT.last < 3000;  // a compass silent for 3 s (screen off, app left) isn't used
// The steadiness gate, as the PC's (static/hunt.js huntSteady, 11/4): a compass bearing is saved only when the last half
// second or more of readings agree within H_STEADY degrees and the phone doesn't say it's uncalibrated or rough
// (iOS: a negative accuracy, or over 20 degrees). Simulated hunts: it halves the estimate's miss. A level is saved either way.
const H_STEADY = 5;
function hSteady() {
  const s = HUNT.samples, acc = HUNT.acc;
  if (!hLive()) return {ok: false, why: "stopped", say: "The compass stopped: press the compass button again, or type the bearing."};
  if (acc != null && acc < 0) return {ok: false, why: "uncal", say: "not calibrated: wave the phone in a figure 8, then hold it still"};
  if (acc != null && acc > 20) return {ok: false, why: "rough", say: `the phone says it's off by up to ±${Math.round(acc)}°: wave it in a figure 8, away from cars and metal`};
  if (s.length >= 5 && HUNT.spread > H_STEADY) return {ok: false, why: "jumping", say: "jumping, not steady yet: hold it flat or upright and still, away from cars and metal; a figure 8 if it stays jumpy"};
  if (s.length < 5 || s[s.length - 1].t - s[0].t < 500) return {ok: false, why: "settling", say: "hold it still a moment"};
  return {ok: true, why: "steady", say: "steady: ready to save"};
}
function hShowHeading() {
  const o = $("#hn_head"), q = $("#hn_cq"); if (!o) return;
  if (HUNT.mag == null) { o.textContent = "—"; return; }
  const dc = hDecl(HUNT.here), h = hTrue(HUNT.mag, HUNT.here), acc = HUNT.acc, st = hSteady();
  o.textContent = `${Math.round(h)}° ${compass(h)}`;
  if (!q) return;
  q.style.color = st.ok ? "var(--good-ink)" : st.why === "settling" ? "" : "var(--bad-ink)";
  q.dataset.steady = st.why;
  q.textContent = `${HUNT.how === "camera side" ? "Upright: the camera side is the direction" : "Flat: the top edge is the direction"} · ±${Math.round(Math.max(HUNT.spread || 0, acc > 0 ? acc : 0))}°`
    + (dc == null ? " · magnetic (true north once the phone has your position)" : ` · true north (${Math.abs(dc).toFixed(1)}° ${dc < 0 ? "W" : "E"} corrected)`)
    + ` · ${st.say}`;
}
function hRead(e) {
  const r = hHeadingOf(e); if (!r) return;
  const now = Date.now();
  HUNT.samples = HUNT.samples.filter(s => now - s.t < 1000); HUNT.samples.push({t: now, h: r.mag});
  const {mean, spread} = hCircMean(HUNT.samples.map(s => s.h));
  Object.assign(HUNT, {mag: mean, spread, acc: r.acc, how: r.how, last: now});
  if (now - HUNT.paint < 150) return;
  HUNT.paint = now; hShowHeading();
}
function hCompass() {
  if (HUNT.listening) {  // a second tap turns it off: stops are then saved without a direction unless one is typed
    removeEventListener("deviceorientationabsolute", hRead); removeEventListener("deviceorientation", hRead);
    Object.assign(HUNT, {listening: false, mag: null, samples: []}); render(); return;
  }
  if (typeof DeviceOrientationEvent === "undefined") return hSay("This phone's browser has no compass: type the bearing instead.", true);
  const start = () => {
    addEventListener("deviceorientationabsolute", hRead); addEventListener("deviceorientation", hRead); HUNT.listening = true;
    const b = $("#hn_cmp"); if (b) { b.textContent = "🧭 Compass on"; b.classList.add("primary"); }
    hSay("Compass on: point the phone where it's strongest, then save.");
    setTimeout(() => { if (HUNT.listening && HUNT.mag == null) hSay("The compass isn't giving a heading here (some phones only give one outdoors or after a figure 8): type the bearing instead.", true); }, 4000);
  };
  if (typeof DeviceOrientationEvent.requestPermission === "function")  // iOS 13+: asked from this tap
    DeviceOrientationEvent.requestPermission().then(r => r === "granted" ? start() : hSay("The compass needs permission: type the bearing instead.", true))
      .catch(() => hSay("No compass here: type the bearing instead.", true));
  else start();
}

// a fresh GPS fix every time (maximumAge 0): the stop is where the phone is now, not where it was a minute ago
const hFix = () => new Promise((ok, no) => {
  if (!navigator.geolocation) return no(new Error("This phone isn't sharing its location with the browser."));
  navigator.geolocation.getCurrentPosition(p => ok({lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now()}),
    e => no(new Error(e.code === 1 ? "Location is off for this app: allow it in the phone's settings (Safari or Chrome, Location)." : "No position yet: step outside or near a window and try again.")),
    {enableHighAccuracy: true, timeout: 20000, maximumAge: 0});
});
async function hLocate() {
  hSay("Finding you…");
  try {
    HUNT.here = await hFix();
    const w = $("#hn_where"); if (w) w.textContent = `±${Math.round(HUNT.here.acc)} m`;
    hSay(HUNT.here.acc > 50 ? "Position is rough (over 50 m): step outside or wait a moment, then try again." : "Position set.");
    hShowHeading(); hDraw();
  } catch (e) { hSay(e.message, true); }
}

async function hStop(b, levelOnly = false) {
  if (b.disabled) return;
  const f = hFreq(), lv = parseFloat($("#hn_l").value), typed = levelOnly ? NaN : parseFloat($("#hn_b").value), ref = $("#hn_ref").value;
  const lo = $("#hn_lvonly"); if (lo) lo.hidden = true;
  if (!f) return hSay("Say what you're looking for: its frequency in MHz.", true);
  if (levelOnly && !isFinite(lv)) return hSay("Enter the level you read.", true);
  if (!isFinite(lv) && !isFinite(typed) && !hLive()) {
    return hSay(HUNT.listening && HUNT.mag != null ? "The compass stopped: press the compass button again, or type the bearing." : "Enter the level you read, a direction, or both.", true);
  }
  b.disabled = true;
  if (!levelOnly && !isFinite(typed) && hLive()) {  // the gate: wait up to 4 s for a steady compass
    let st = hSteady();
    if (!st.ok) hSay("Waiting for a steady compass: hold it still…");
    for (const until = Date.now() + 4000; !st.ok && Date.now() < until;) { await new Promise(r => setTimeout(r, 200)); st = hSteady(); }
    if (!st.ok) {
      b.disabled = false; hShowHeading();
      if (lo) lo.hidden = !isFinite(lv);
      return hSay(st.why === "stopped" ? st.say
          : (st.why === "uncal" ? "Not saved yet: the compass isn't calibrated. Wave the phone in a figure 8, then hold it still"
            : st.why === "rough" ? "Not saved yet: the phone says its compass is rough. Wave it in a figure 8, away from cars and metal, then hold it still"
            : `Not saved yet: the compass is ${st.why === "settling" ? "still settling" : "not steady"}. Hold it flat or upright and still, away from cars and metal${st.why === "settling" ? "" : ", and wave it in a figure 8"}`)
            + `; then save again${isFinite(lv) ? ", or save the level only" : ""}.`, true);
    }
  }
  const mag = isFinite(typed) || levelOnly ? null : hLive() ? HUNT.mag : null, how = `${HUNT.how}, ±${Math.round(HUNT.spread || 0)}°`;  // the compass as it read once steady
  try {
    hSay("Finding you…");
    HUNT.here = await hFix();  // every stop its own fresh fix: the phone has moved since the last one
    const w = $("#hn_where"); if (w) w.textContent = `±${Math.round(HUNT.here.acc)} m`;
    // to true north at this stop (wmm.js), as the PC saves it: a typed bearing off a hand compass is magnetic, off a map true
    const brg = isFinite(typed) ? (ref === "mag" ? hTrue(typed, HUNT.here) : typed) : mag != null ? hTrue(mag, HUNT.here) : null;
    const corrected = hDecl(HUNT.here) != null;
    const e = {ts: new Date().toISOString(), lat: HUNT.here.lat, lon: HUNT.here.lon, acc: HUNT.here.acc, freq_mhz: f,
      dbm: isFinite(lv) ? -Math.abs(lv) : null,  // received levels are negative; "72" means -72 dBm, as in the Field log
      sig_type: null, label: "Find a signal", pack: S.pack?.name || "",
      bearing: brg == null ? null : Math.round((((brg % 360) + 360) % 360) * 10) / 10,
      notes: brg == null ? (levelOnly ? "level only (the compass wasn't steady)" : "") : isFinite(typed) ? `bearing typed (${ref === "mag" ? corrected ? "magnetic, corrected to true" : "magnetic, not corrected" : "true"})`
        : `phone compass (${how}, ${corrected ? "true north" : "magnetic"})`};
    e.check = licenceCheck(e);
    e.id = await idb.put("log", e);
    await loadLog();
    HUNT.freq = String(f); hSave();
    $("#hn_l").value = ""; $("#hn_b").value = "";
    hSay(`Stop saved${levelOnly ? ", the level only" : ""}${HUNT.here.acc > 50 ? ` (position ±${Math.round(HUNT.here.acc)} m: rough)` : ""}.`);
    hDraw();
  } catch (err) { hSay(`Not saved: ${err.message}`, true); }
  b.disabled = false;
}

// The stop counter, the next stop and the left-out directions in words (as the PC's static/hunt.js says them)
const H_NUM = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const hShare = p => p <= 12 ? "a tenth tighter" : p <= 22 ? "a fifth tighter" : p <= 29 ? "a quarter tighter" : p <= 40 ? "a third tighter" : p <= 60 ? "twice as tight" : "three times as tight";
function hCountSay(c) {
  if (!c) return "";
  const more = `${H_NUM[c.more] || c.more} more`, v = c.more === 1 ? "s" : "", gain = c.tighter_pct >= 5 ? ` make${v} the estimate about ${hShare(c.tighter_pct)}` : ` firm${v} it up`;
  return c.goal === 8 ? `${c.n} of 8 stops: ${more}${gain}.` : c.goal ? `${c.n} stops: a firm estimate. ${more[0].toUpperCase() + more.slice(1)}, from new sides,${gain}.` : `${c.n} stops: plenty. Walk the likely area.`;
}
function hNextSay(n, bearings) {
  if (!n) return "";
  if (n.m < 20) return "<b>Next stop:</b> about here is a good spot (the purple ring).";
  return `<b>Next stop:</b> walk about ${hFmtM(Math.max(10, n.m))} ${esc(n.compass)} (the purple ring)${n.off_line ? bearings ? ", off to the side of your lines, so the directions cross wider" : ", round to another side of it, so the levels pin it down" : ", to tighten the estimate"}.`;
}
const hDropSay = b => b && b.dropped > 0 ? `${H_NUM[b.dropped] || b.dropped} of ${b.n} directions left out: they point well away from the rest (a car or metal nearby?).` : "";
const hFmtM = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${num(m / 1609.344, 1)} mi`;
function hResult() {
  const f = hFreq(), log = S.log.filter(e => !HUNT.since || (e.ts || "") >= HUNT.since);
  const r = GeoFix.hunt(log, f, HUNT.tol, HUNT.here?.lat, HUNT.here?.lon);
  return {f, r};
}
function hDraw() {
  const out = $("#hn_out"); if (!out) return;
  const {f, r} = hResult(), pts = r.readings, lv = pts.filter(p => p.dbm != null), best = r.best;
  const word = !best ? null : r.level && r.bearing ? "from levels and directions" : r.bearing ? "from directions" : "from levels";
  const trend = lv[0] && lv[1] ? lv[0].dbm - lv[1].dbm : null, fy = r.from_you;
  const cnt = pts.length ? hCountSay(r.count) : "", nx = hNextSay(r.next, !!r.bearing), drop = hDropSay(r.bearing);
  out.innerHTML = !f ? `<p class="hint" style="margin:0">Type the frequency you're looking for above.</p>`
    : !pts.length ? `<p class="hint" style="margin:0">No stops on ${fmtF(f)} MHz yet. Read the level, then Save this stop: the phone takes your position as you save.</p>`
    : `${best ? `<p style="margin:0 0 4px;font-size:18px"><b>${fy ? `About ${hFmtM(fy.m)} ${esc(fy.compass)} of you (${fy.deg}°)` : "Best guess on the map"}</b></p>
        <p class="hint" style="margin:0 0 6px">±${best.radius_m != null ? Math.round(best.radius_m) : "?"} m, ${word}, ${pts.length} stop${pts.length === 1 ? "" : "s"}</p>
        ${cnt ? `<p class="hint" id="hn_count" style="margin:0 0 6px">${esc(cnt)}</p>` : ""}
        ${!fy ? `<p style="margin:0 0 4px">Tap 📍 to see which way it is from you.</p>${nx ? `<p style="margin:0 0 4px" id="hn_next">${nx}</p>` : ""}`
          : fy.m <= (best.radius_m || 0) && (best.radius_m || 0) <= 250 ? `<p style="margin:0 0 4px">You're inside the likely area: walk it slowly and watch for the level to jump.</p>`
          : nx ? `<p style="margin:0 0 4px" id="hn_next">${nx}</p>`
          : (best.radius_m || 0) > 250 ? `<p style="margin:0 0 4px">Head ${esc(fy.compass)}. The area is still wide (±${Math.round(best.radius_m)} m): stops further apart, some nearer and some further out, narrow it.</p>`
          : fy.m > (best.radius_m || 0) ? `<p style="margin:0 0 4px">Head ${esc(fy.compass)} and take the next stop about ${Math.max(30, Math.round(Math.min(fy.m / 2, 300) / 10) * 10)} m on.</p>`
          : `<p style="margin:0 0 4px">You're inside the likely area: walk it slowly and watch for the level to jump.</p>`}`
      : `<p style="margin:0 0 4px"><b>${lv.length < 3 ? `${3 - Math.min(3, lv.length)} more stop${lv.length === 2 ? "" : "s"} with a level` : "The levels are too even to say yet"}</b>
        <span class="hint">to estimate where it is${pts.some(p => p.bearing != null) ? ", or one more direction from somewhere else" : ""}. Spread the stops out.</span></p>${cnt ? `<p class="hint" id="hn_count" style="margin:0 0 6px">${esc(cnt)}</p>` : ""}`}
      ${best && drop ? `<p class="hint" style="margin:0 0 4px">${esc(drop)}</p>` : ""}
      ${trend != null ? `<div class="check ${trend >= 3 ? "licensed" : trend <= -3 ? "outside" : ""}" style="margin:6px 0">${trend >= 3 ? `Warmer: ${num(trend)} dB stronger than the stop before.` : trend <= -3 ? `Colder: ${num(-trend)} dB weaker than the stop before. Turn back toward the stronger stop.` : "About the same as the stop before."}</div>` : ""}
      ${r.level ? `<p class="hint" style="margin:4px 0 0">Strongest so far: ${num(r.level.strongest.dbm)} dBm. The readings fit a signal falling off as distance to the power ${r.level.n_exp} (${r.level.n_exp <= 2.5 ? "open ground" : r.level.n_exp >= 3.5 ? "built up" : "mixed"}).</p>` : ""}
      ${best ? `<div class="row" style="margin-top:10px"><button class="btn small" data-act="huntpin">Put the pin there</button><span class="hint">the Map and List then show what's licensed there</span></div>` : ""}`;
  hMap(r);
  const st = $("#hn_stops");
  if (st) st.innerHTML = pts.length ? pts.slice(0, 30).map((p, i) => `<div class="item" style="cursor:default"><span class="dot" style="background:${hColor(p, lv)};margin-top:6px"></span>
      <div class="main"><div class="t">${p.dbm != null ? `${num(p.dbm)} dBm` : "no level"}${p.bearing != null ? ` · ${Math.round(p.bearing)}° ${compass(p.bearing)}` : ""}</div>
      <div class="s">${esc(new Date(p.ts).toLocaleTimeString())}${best ? ` · ${hFmtM(1000 * distKm(p.lat, p.lon, best.lat, best.lon))} from the guess` : ""}${i === 0 ? " · latest" : ""}</div></div></div>`).join("")
    + (pts.length > 30 ? `<p class="hint">The latest 30 of ${pts.length}: the Field log has them all.</p>` : "")
    : `<p class="hint" style="margin:0">None yet.</p>`;
}
const hColor = (p, lv) => { if (p.dbm == null) return "#8c959f";
  const lo = Math.min(...lv.map(x => x.dbm)), hi = Math.max(...lv.map(x => x.dbm)), t = hi > lo ? (p.dbm - lo) / (hi - lo) : 0.5;
  return `hsl(${Math.round(220 - 220 * t)},85%,50%)`; };

function hMap(r) {
  const el = $("#hn_map"); if (!el || typeof L === "undefined") return;
  if (!HUNT.map || HUNT.map.getContainer() !== el) {
    HUNT.map?.remove();
    HUNT.map = L.map(el, {preferCanvas: true, zoomControl: true, attributionControl: true});
    if (window.rfZoomBar) rfZoomBar(HUNT.map);
    const b = BASES[navigator.onLine === false && !BASES[S.base]?.save ? "topo" : S.base] || BASES.topo;
    L.tileLayer(b.url, {maxNativeZoom: b.max, maxZoom: 19, crossOrigin: "anonymous", attribution: b.attr}).addTo(HUNT.map);
    HUNT.layer = L.layerGroup().addTo(HUNT.map);
  }
  const map = HUNT.map, layer = HUNT.layer, pts = r.readings, lv = pts.filter(p => p.dbm != null), all = [];
  layer.clearLayers();
  if (r.level?.ring) L.polygon(r.level.ring, {color: "#1f6feb", weight: 1.5, fillOpacity: .12}).bindTooltip("Probably in here (from levels)").addTo(layer);
  if (r.bearing?.ellipse?.ring) L.polygon(r.bearing.ellipse.ring, {color: "#e07a3f", weight: 1.5, fillOpacity: .1}).bindTooltip("Probably in here (from directions)").addTo(layer);
  for (const p of pts) {
    all.push([p.lat, p.lon]);
    if (p.bearing != null) { const d = 0.8, k = Math.cos(rad(p.lat));
      L.polyline([[p.lat, p.lon], [p.lat + d / 111 * Math.cos(rad(p.bearing)), p.lon + d / 111 / k * Math.sin(rad(p.bearing))]], {color: "#e07a3f", weight: 2, dashArray: "5 4", interactive: false}).addTo(layer); }
    L.circleMarker([p.lat, p.lon], {radius: 7, weight: 1, color: "#0008", fillOpacity: .92, fillColor: hColor(p, lv)})
      .bindTooltip(`${p.dbm != null ? `${num(p.dbm)} dBm` : "no level"}${p.bearing != null ? ` · ${Math.round(p.bearing)}°` : ""}`).addTo(layer);
  }
  if (r.next && hNextSay(r.next, !!r.bearing)) { const t = [r.next.lat, r.next.lon], from = HUNT.here ? [HUNT.here.lat, HUNT.here.lon] : pts[0] ? [pts[0].lat, pts[0].lon] : null; all.push(t);
    if (from) L.polyline([from, t], {color: "#8250df", weight: 2, dashArray: "2 6", interactive: false}).addTo(layer);
    L.circleMarker(t, {radius: 13, color: "#8250df", weight: 3, dashArray: "5 4", fillColor: "#8250df", fillOpacity: .12}).bindTooltip("Next stop").addTo(layer);
    L.circleMarker(t, {radius: 3, color: "#8250df", weight: 1, fillColor: "#8250df", fillOpacity: 1, interactive: false}).addTo(layer); }
  if (r.best) { all.push([r.best.lat, r.best.lon]);
    L.marker([r.best.lat, r.best.lon], {icon: pinIcon(), keyboard: false}).bindTooltip("Best guess").addTo(layer); }
  if (HUNT.here) { all.push([HUNT.here.lat, HUNT.here.lon]);
    L.marker([HUNT.here.lat, HUNT.here.lon], {icon: L.divIcon({className: "", html: '<div class="me"></div>', iconSize: [16, 16]}), interactive: false}).addTo(layer); }
  const fit = () => { map.invalidateSize(); if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.3), {maxZoom: 18, animate: false, padding: [18, 18]});
    else map.setView(S.center || [39.5, -98.35], S.center ? 14 : 4); };
  setTimeout(fit, 0);
}

window.viewHunt = async v => {
  if (!HUNT.loaded) { Object.assign(HUNT, (await kv.get("hunt")) || {}); HUNT.loaded = true; }
  HUNT.map?.remove(); HUNT.map = null;
  v.innerHTML = head("Find a signal", "Walk toward it. At each stop, read the level and save: the phone takes its position as you save and says where the signal probably is. No signal needed.")
    + logSeg()
    + `<div class="card glass" style="--i:1"><h2>Looking for</h2>
        <div class="two"><div class="field"><label for="hn_f">Frequency, MHz</label><input id="hn_f" inputmode="decimal" placeholder="e.g. 851.0125" value="${esc(HUNT.freq)}"></div>
          <div class="field"><label for="hn_tol">Match within</label><select id="hn_tol">${HUNT_TOL.map(([k, l]) => `<option value="${k}" ${+HUNT.tol === k ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
        <p class="hint" style="margin:0">A rogue booster (BDA) rebroadcasts a whole band: look for it on the frequency the radio shop says is jammed, matched within 1 MHz.</p></div>
      <div class="card glass" style="--i:2"><h2>At this stop</h2>
        <div class="row" style="margin-bottom:10px"><button class="btn" data-act="huntgps">📍 Where am I</button><span class="hint" id="hn_where">${HUNT.here ? `±${Math.round(HUNT.here.acc)} m` : "taken as you save"}</span></div>
        <div class="field"><label for="hn_l">Level you read, dBm</label><input id="hn_l" inputmode="decimal" placeholder="-72" style="font-size:22px">
          <p class="hint" style="margin:2px 0 0">Off any receiver, scanner or SDR app. Hold still a few seconds and take the strongest.</p></div>
        <div class="field"><label for="hn_b">Direction it's strongest (optional)</label>
          <div class="row"><button class="btn small ${HUNT.listening ? "primary" : ""}" id="hn_cmp" data-act="huntcmp">🧭 ${HUNT.listening ? "Compass on" : "Use the compass"}</button>
            <b id="hn_head" class="mono" style="min-width:70px">—</b></div>
          <p class="hint" id="hn_cq" style="margin:4px 0 8px">Flat: point the top edge where it's strongest. Upright: point the camera side. Then save.</p>
          <div class="two"><input id="hn_b" inputmode="decimal" placeholder="or type the bearing °" aria-label="Bearing, degrees">
            <select id="hn_ref" aria-label="That bearing is" title="A bearing off a hand compass is magnetic; one off a map is true"><option value="mag" ${HUNT.ref !== "true" ? "selected" : ""}>magnetic (a compass)</option><option value="true" ${HUNT.ref === "true" ? "selected" : ""}>true (a map)</option></select></div>
          <p class="hint" style="margin:4px 0 0">With a directional antenna, or your body as a shield. Every bearing is saved to true north (NOAA's magnetic model at the stop).</p></div>
        <div class="row"><button class="btn primary" data-act="huntsave" style="font-size:17px;min-height:48px;flex:1">Save this stop</button>
          <button class="btn" id="hn_lvonly" data-act="huntlevel" hidden style="min-height:48px">Save the level only</button></div>
        <p class="hint" id="hn_msg" style="margin:8px 0 0"></p></div>
      <div class="card glass" style="--i:3"><h2>Where it probably is</h2><div id="hn_out"></div>
        <div id="hn_map" style="height:320px;border-radius:16px;margin-top:10px;overflow:hidden"></div>
        <p class="hint" style="margin:8px 0 0">Blue: the area from levels. Orange: from directions. Dots: your stops, red strongest. Purple ring: where to stand next.</p></div>
      <div class="card glass" style="--i:4"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Stops on this frequency</h2>
          <button class="btn small" data-act="huntnew" title="Leave the stops so far out of the estimate (they stay in the Field log)">New hunt</button></div>
        <div id="hn_stops" style="margin-top:6px"></div>${HUNT.since ? `<p class="hint" style="margin:6px 0 0">Counting stops since ${esc(new Date(HUNT.since).toLocaleString())}.</p>` : ""}</div>
      <div class="card glass" style="--i:5"><details><summary><b>How it works, and a rogue booster</b><span class="hint">tips</span></summary>
        <ul class="hint" style="margin:6px 0 0;padding-left:18px">
          <li>Levels alone: a signal gets weaker with distance, so stops on different sides of it show where it is. Take stops around it, not in a line; 5 or more spread over the area give a tight answer.</li>
          <li>With directions: lines from each stop cross where it is. Two cross somewhere; three show whether they agree.</li>
          <li>A direction is saved only once the compass is steady (within 5°): hold it still, away from cars and metal. Aim for 8 stops, and go where the purple ring says: from the side, the lines cross wider.</li>
          <li>A rogue booster usually sits inside a building: the level climbs sharply in the last 50 m. Walk the block, then the floors; look for a donor antenna on the roof or a booster in a telecom room.</li>
          <li>A booster retransmits with the licensee's consent only (47 CFR 90.219): tell the agency's radio shop what you found, with the readings (Field log, Export CSV).</li>
          <li>Worked out on this phone the same way as DAStastic on the PC (Mission, Find a signal).</li></ul></details></div>`;
  $("#hn_f").onchange = () => { HUNT.freq = $("#hn_f").value.trim(); hSave(); hDraw(); };
  $("#hn_tol").onchange = e => { HUNT.tol = +e.target.value; hSave(); hDraw(); };
  $("#hn_ref").onchange = e => { HUNT.ref = e.target.value; hSave(); };
  hShowHeading(); hDraw();
};

document.addEventListener("click", async e => {  // Find a signal's buttons (app.js handles the rest)
  const a = e.target.closest("[data-act]"); if (!a || !a.dataset.act.startsWith("hunt")) return;
  const act = a.dataset.act;
  if (act === "huntgps") hLocate();
  else if (act === "huntcmp") hCompass();
  else if (act === "huntsave") hStop(a);
  else if (act === "huntlevel") hStop(a, true);
  else if (act === "huntopen") { S.logView = "hunt"; setTab("log"); }
  else if (act === "huntnew") { const was = HUNT.since; HUNT.since = new Date().toISOString(); hSave(); render();
    toast("New hunt: the earlier stops stay in the Field log.", () => { HUNT.since = was; hSave(); render(); }); }
  else if (act === "huntpin") { const b = hResult().r.best; if (b) { setTab("map"); setCenter([b.lat, b.lon]); } }
});
