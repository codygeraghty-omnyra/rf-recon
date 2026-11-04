"use strict";
/* RF Recon — Find a signal (Cody 11/3: "DF / geolocation capabilities any user could easily use, no matter their
   skill level", for hunting a rogue BDA or any signal). A guided panel on the Mission tab, laid out for a phone:
   at each stop, the phone's position, the level read off any receiver, and optionally the direction from the phone's
   compass; after each stop, where the signal probably is (from levels, geo.level_fix, and bearings,
   geo.bearing_fix), which way and how far that is, and whether the last stop was warmer or colder. Each stop is a
   field log reading of the active mission (so Lines of bearing and Replay show them too).
   Needs core.js (api, post, esc, num, fmtF, $, S) and Leaflet. */

const HUNT = { heading: null, listening: false, here: null, samples: [], acc: null, how: "", spread: null, last: 0 };

function huntSay(t, bad) { const m = $("#hnMsg"); if (m) { m.textContent = t; m.className = bad ? "status err" : "hint"; } }

// The phone's compass (11/4, for real phones): iOS gives webkitCompassHeading (after a permission tap) and its
// accuracy; Android Chrome gives absolute alpha/beta/gamma. Held flat, the heading is where the top edge points
// (the screen's top when it's turned sideways); held upright, where the back (the camera) points, tilt-compensated
// (the W3C DeviceOrientation spec's compass formula). Readings are averaged over the last second (circular mean) and
// their spread shown, so a jittery compass is visible. Phones read magnetic north: each bearing is turned to true
// north with NOAA's World Magnetic Model (wmm.js) at your position before it's saved.
function huntHeadingOf(e) {
  const d = Math.PI / 180, scr = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  const upright = e.beta != null && Math.abs(e.beta) > 45;
  if (e.webkitCompassHeading != null) return { mag: ((e.webkitCompassHeading + (upright ? 0 : scr)) % 360 + 360) % 360, acc: e.webkitCompassAccuracy, how: upright ? "camera side" : "top edge" };
  if (!e.absolute || e.alpha == null) return null;
  if (upright && e.gamma != null) {  // rear-camera direction, tilt-compensated
    const x = e.beta * d, y = e.gamma * d, z = e.alpha * d, cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const Vx = -cZ * sY - sZ * sX * cY, Vy = -sZ * sY + cZ * sX * cY;
    let hd = Math.atan(Vx / Vy); if (Vy < 0) hd += Math.PI; else if (Vx < 0) hd += 2 * Math.PI;
    return { mag: hd / d, acc: null, how: "camera side" };
  }
  return { mag: ((360 - e.alpha + scr) % 360 + 360) % 360, acc: null, how: "top edge" };
}
function huntCircMean(xs) {
  const d = Math.PI / 180; let s = 0, c = 0;
  for (const x of xs) { s += Math.sin(x * d); c += Math.cos(x * d); }
  const m = ((Math.atan2(s, c) / d) + 360) % 360, R = Math.hypot(s, c) / xs.length;
  return { mean: m, spread: R >= 1 ? 0 : Math.sqrt(-2 * Math.log(R)) / d };  // circular standard deviation, degrees
}
const huntDecl = () => HUNT.here && window.WMM ? WMM.declination(HUNT.here.lat, HUNT.here.lon) : null;
const huntTrue = mag => { const dc = huntDecl(); return dc == null ? mag : ((mag + dc) % 360 + 360) % 360; };
function huntCompass(on) {
  const read = e => {
    const r = huntHeadingOf(e); if (!r) return;
    const now = Date.now();
    HUNT.samples = HUNT.samples.filter(s => now - s.t < 1000); HUNT.samples.push({ t: now, h: r.mag });
    const { mean, spread } = huntCircMean(HUNT.samples.map(s => s.h));
    HUNT.heading = huntTrue(mean); HUNT.spread = spread; HUNT.acc = r.acc; HUNT.how = r.how; HUNT.last = now;
    HUNT.r = r;
    if (now - (HUNT.paint || 0) < 150) { if (!HUNT.trail) HUNT.trail = setTimeout(() => { HUNT.trail = null; huntPaint(); }, 160); return; }
    huntPaint();
  };
  const huntPaint = () => {
    const r = HUNT.r, spread = HUNT.spread; if (!r) return; HUNT.paint = Date.now();
    const o = $("#hnHeading"); if (o) o.textContent = `${Math.round(HUNT.heading)}° ${huntPoint(HUNT.heading)}`;
    const q = $("#hnCompassQ"); if (!q) return;
    const dc = huntDecl(), bad = (r.acc != null && (r.acc < 0 || r.acc > 20)) || spread > 12;
    q.className = bad ? "status err" : "hint";
    q.textContent = `${r.how === "camera side" ? "Upright: the camera side is the direction" : "Flat: the top edge is the direction"} · ±${Math.round(Math.max(spread, r.acc > 0 ? r.acc : 0))}°`
      + (dc == null ? " · magnetic (set your position to turn it to true north)" : ` · true north (${Math.abs(dc).toFixed(1)}° ${dc < 0 ? "W" : "E"} corrected)`)
      + (bad ? (r.acc != null && r.acc < 0 ? " · not calibrated: wave the phone in a figure 8" : " · jumping: hold still, step away from cars and metal, or wave it in a figure 8") : "");
  };
  if (!on || HUNT.listening) return;
  const start = () => { window.addEventListener("deviceorientationabsolute", read); window.addEventListener("deviceorientation", read); HUNT.listening = true; };
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function")
    DeviceOrientationEvent.requestPermission().then(r => r === "granted" ? start() : huntSay("The compass needs permission: type the bearing instead.", true)).catch(() => huntSay("No compass here: type the bearing instead.", true));
  else if (typeof DeviceOrientationEvent !== "undefined") start();
  else huntSay("This device has no compass: type the bearing instead.", true);
}
const huntPoint = b => ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(((b % 360) + 360) % 360 / 22.5) % 16];

window.missionHunt = (v, m) => {
  const H = S.hunt = S.hunt || { freq: "", tol: 12.5, open: false };
  v.insertAdjacentHTML("afterbegin", `<details class="panel" id="hnPanel" ${H.open ? "open" : ""} style="margin-bottom:10px">
    <summary style="cursor:pointer;list-style:none"><h3 style="margin:0;display:inline">🎯 Find a signal</h3>
      <span class="hint"> · walk toward it: at each stop, your position and the level you read (and a direction if you can), and RF Recon says where it probably is</span></summary>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-top:8px">
      <label>Looking for (MHz)<input id="hnFreq" type="number" step="any" value="${esc(H.freq)}" placeholder="e.g. 851.0125" style="width:150px"></label>
      <label>Match within<select id="hnTol">${[[6.25, "6.25 kHz (one channel)"], [12.5, "12.5 kHz"], [25, "25 kHz"], [1000, "1 MHz (a booster's whole band)"], [5000, "5 MHz"]]
        .map(([k, l]) => `<option value="${k}" ${+H.tol === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <span class="hint" style="flex:1;min-width:200px">A rogue BDA rebroadcasts a whole band: look for it on the frequency the radio shop says is jammed, matched within 1 MHz.</span></div>
    <div class="grid2" style="margin-top:8px;grid-template-columns:minmax(260px,1fr) minmax(300px,1.4fr)">
      <div>
        <p style="margin:0 0 6px"><b>At this stop</b></p>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
          <button class="primary" id="hnGps">📍 Use my location</button><span class="hint" id="hnWhere">${HUNT.here ? `±${Math.round(HUNT.here.acc)} m` : "not set"}</span></div>
        <label style="display:block;margin-top:8px">Level you read (dBm)<input id="hnDbm" type="number" step="any" placeholder="e.g. -72" style="width:100%;font-size:18px">
          <span class="hint">Off any receiver, scanner or SDR app. Hold still a few seconds and take the strongest.</span></label>
        <div style="margin-top:8px"><span class="hint">Direction it's strongest (optional, with a directional antenna or your body as a shield)</span>
          <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px">
            <button id="hnCompass">🧭 Use the phone's compass</button><b id="hnHeading" class="mono">—</b>
            <input id="hnBrg" type="number" min="0" max="359" step="1" placeholder="or type °" style="width:90px">
            <select id="hnBrgRef" title="A bearing off a hand compass is magnetic; one off a map is true"><option value="mag">magnetic (a compass)</option><option value="true">true (a map)</option></select></div>
          <p class="hint" id="hnCompassQ" style="margin:4px 0 0">Flat: point the top edge at the strongest direction. Upright: point the camera side. Then save.</p></div>
        <div class="row" style="gap:8px;margin-top:10px"><button class="primary" id="hnSave" style="font-size:16px">Save this stop</button></div>
        <p class="hint" id="hnMsg" style="margin:6px 0 0"></p></div>
      <div><div id="hnMap" style="height:300px;border-radius:10px"></div><div id="hnOut" style="margin-top:8px"></div></div></div>
    <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">How it works, and tips for a rogue booster</summary>
      <ul class="hint" style="margin:6px 0 0;padding-left:18px">
        <li>Levels alone: a signal gets weaker with distance, so stops on different sides of it show where it is. Take stops around it, not in a line; 5 or more spread over the area give a tight answer.</li>
        <li>With directions: lines from each stop cross where it is. Two cross somewhere; three show whether they agree.</li>
        <li>A rogue booster usually sits inside a building: the level climbs sharply in the last 50 m. Walk the block, then the floors; look for a donor antenna on the roof or a booster in a telecom room.</li>
        <li>A booster retransmits with the licensee's consent only (47 CFR 90.219): tell the agency's radio shop what you found, with the readings (Mission, export).</li></ul></details>
  </details>`);
  const panel = $("#hnPanel");
  panel.addEventListener("toggle", () => { H.open = panel.open; if (panel.open) draw(); });
  $("#hnFreq").onchange = e => { H.freq = e.target.value.trim(); draw(); };
  $("#hnTol").onchange = e => { H.tol = +e.target.value; draw(); };
  $("#hnGps").onclick = () => { if (!navigator.geolocation) return huntSay("This device can't give a position: use the pin on the map.", true);
    huntSay("Finding you…");
    navigator.geolocation.getCurrentPosition(p => { HUNT.here = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      $("#hnWhere").textContent = `±${Math.round(p.coords.accuracy)} m`; huntSay(p.coords.accuracy > 50 ? "Position is rough (over 50 m): step outside or wait a moment, then try again." : "Position set."); draw(); },
      err => huntSay(`No position: ${err.message}. Allow location for this site, or use the pin.`, true), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }); };
  $("#hnCompass").onclick = () => { huntCompass(true); huntSay("Compass on: point the phone at the strongest direction."); };
  $("#hnSave").onclick = async e => {
    const b = e.currentTarget; if (b.disabled) return;
    const f = +($("#hnFreq").value || H.freq), dbm = $("#hnDbm").value, typed = $("#hnBrg").value;
    if (!HUNT.here) return huntSay("Set your position first (📍 Use my location).", true);
    if (!f) return huntSay("Say what you're looking for: its frequency in MHz.", true);
    if (dbm === "" && typed === "" && HUNT.heading == null) return huntSay("Enter the level you read, a direction, or both.", true);
    const live = HUNT.heading != null && Date.now() - HUNT.last < 3000;  // a compass that stopped (screen off, app left) isn't used
    if (typed === "" && HUNT.heading != null && !live && dbm === "") return huntSay("The compass stopped: press Use the phone's compass again, or type the bearing.", true);
    const brg = typed !== "" ? ($("#hnBrgRef").value === "mag" ? huntTrue(+typed) : +typed) : live ? HUNT.heading : null;
    b.disabled = true;
    try {
      await post("/api/fieldlog", { mission_id: m.id, lat: HUNT.here.lat, lon: HUNT.here.lon, acc: HUNT.here.acc, freq_mhz: f, dbm: dbm === "" ? null : +dbm,
        bearing: brg == null ? null : Math.round(brg * 10) / 10, label: "Find a signal",
        notes: brg == null ? "" : typed !== "" ? `bearing typed (${$("#hnBrgRef").value === "mag" ? "magnetic, corrected to true" : "true"})` : `phone compass (${HUNT.how}, ±${Math.round(HUNT.spread || 0)}°, true north)` });
      $("#hnDbm").value = ""; $("#hnBrg").value = ""; huntSay("Stop saved."); H.freq = String(f); await draw();
    } catch (err) { huntSay(`Not saved: ${err.message}`, true); }
    b.disabled = false; };

  let map = null, layer = null;
  async function draw() {
    if (!panel.open || !$("#hnOut")) return;
    const f = +($("#hnFreq").value || H.freq);
    const q = new URLSearchParams({ ...(f ? { freq: f, tol_khz: H.tol } : {}), ...(HUNT.here ? { lat: HUNT.here.lat, lon: HUNT.here.lon } : {}) });
    let r; try { r = await api(`/api/missions/${m.id}/hunt?${q}`); } catch (e) { $("#hnOut").innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
    if (!$("#hnOut")) return;  // the tab was left while it worked
    const pts = r.readings.filter(p => p.lat != null), lv = pts.filter(p => p.dbm != null);
    const last = lv[0], prev = lv[1], best = r.best;
    const word = !best ? null : (r.level && r.bearing) ? "from levels and directions" : r.bearing ? "from directions" : "from levels";
    const trend = last && prev ? (+last.dbm - +prev.dbm) : null;
    $("#hnOut").innerHTML = !pts.length ? `<p class="hint">No stops on this frequency yet. Set your position, read the level, and save the first stop.</p>`
      : `${best ? `<p style="margin:0 0 4px;font-size:16px"><b>${r.from_you ? `About ${r.from_you.m < 1000 ? `${Math.round(r.from_you.m / 10) * 10} m` : `${num(r.from_you.m / 1609.34, 1)} mi`} ${esc(r.from_you.compass)} of you (${r.from_you.deg}°)` : "Best guess on the map"}</b>
          <span class="hint">±${best.radius_m != null ? Math.round(best.radius_m) : "?"} m, ${word}, ${pts.length} stop${pts.length === 1 ? "" : "s"}</span></p>
          ${!r.from_you ? "" : (best.radius_m || 0) > 250 ? `<p style="margin:0 0 4px">Head ${esc(r.from_you.compass)}. The area is still wide (±${Math.round(best.radius_m)} m): stops further apart, some nearer and some further out, narrow it.</p>`
            : r.from_you.m > (best.radius_m || 0) ? `<p style="margin:0 0 4px">Head ${esc(r.from_you.compass)} and take the next stop about ${Math.max(30, Math.round(Math.min(r.from_you.m / 2, 300) / 10) * 10)} m on.</p>`
            : `<p style="margin:0 0 4px">You're inside the likely area: walk it slowly and watch for the level to jump.</p>`}`
        : `<p style="margin:0 0 4px"><b>${lv.length < 3 ? `${3 - Math.min(3, lv.length)} more stop${lv.length === 2 ? "" : "s"} with a level` : "The levels are too even to say yet"}</b> <span class="hint">to estimate where it is${pts.some(p => p.bearing != null) ? ", or one more direction from somewhere else" : ""}. Spread the stops out.</span></p>`}
        ${trend != null ? `<p style="margin:0 0 4px;color:${trend >= 3 ? "var(--good)" : trend <= -3 ? "var(--warn)" : "inherit"}">${trend >= 3 ? `Warmer: ${num(trend, 0)} dB stronger than the stop before.` : trend <= -3 ? `Colder: ${num(-trend, 0)} dB weaker than the stop before. Turn back toward the stronger stop.` : "About the same as the stop before."}</p>` : ""}
        ${r.level ? `<p class="hint" style="margin:0">Strongest so far: ${num(r.level.strongest.dbm, 0)} dBm. The readings fit a signal falling off as distance to the power ${r.level.n_exp} (${r.level.n_exp <= 2.5 ? "open ground" : r.level.n_exp >= 3.5 ? "built up" : "mixed"}).</p>` : ""}
        ${best ? `<div class="row" style="gap:8px;margin-top:6px"><button id="hnPin">Put the pin there</button><span class="hint">then Search shows what's licensed there and the buildings nearby</span></div>` : ""}`;
    if ($("#hnPin")) $("#hnPin").onclick = () => { $("#loc").value = `${best.lat.toFixed(6)}, ${best.lon.toFixed(6)}`; window.setMode?.("point"); window.runSearch?.(); huntSay("Pin moved to the best guess."); };
    if (typeof L === "undefined") return;
    if (!map || !document.body.contains(map.getContainer())) { map = L.map("hnMap", { preferCanvas: true }); addMapLayers(map); layer = L.layerGroup().addTo(map);
      new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer()); }
    layer.clearLayers();
    const all = [], lo = Math.min(...lv.map(p => +p.dbm), 0), hi = Math.max(...lv.map(p => +p.dbm), -200);
    for (const p of pts) { all.push([p.lat, p.lon]);
      const t = p.dbm != null && hi > lo ? (+p.dbm - lo) / (hi - lo) : 0.5;
      L.circleMarker([p.lat, p.lon], { radius: 6, weight: 1, color: "#0008", fillOpacity: .9, fillColor: `hsl(${Math.round(220 - 220 * t)},85%,50%)` })
        .bindTooltip(`${p.dbm != null ? `${num(p.dbm, 0)} dBm` : "no level"}${p.bearing != null ? ` · ${Math.round(p.bearing)}°` : ""}`).addTo(layer);
      if (p.bearing != null) { const d = 0.8, k = Math.cos(p.lat * Math.PI / 180);
        L.polyline([[p.lat, p.lon], [p.lat + d / 111 * Math.cos(p.bearing * Math.PI / 180), p.lon + d / 111 / k * Math.sin(p.bearing * Math.PI / 180)]], { color: "#e07a3f", weight: 2, dashArray: "5 4" }).addTo(layer); } }
    if (r.level && r.level.ring) L.polygon(r.level.ring, { color: "#1f6feb", weight: 1.5, fillOpacity: .12 }).bindTooltip("Probably in here (from levels)").addTo(layer);
    if (r.bearing && r.bearing.ellipse && r.bearing.ellipse.ring) L.polygon(r.bearing.ellipse.ring, { color: "#e07a3f", weight: 1.5, fillOpacity: .1 }).bindTooltip("Probably in here (from directions)").addTo(layer);
    if (best) { all.push([best.lat, best.lon]); L.marker([best.lat, best.lon], { title: "Best guess" }).bindTooltip("Best guess").addTo(layer); }
    if (HUNT.here) { all.push([HUNT.here.lat, HUNT.here.lon]); L.circleMarker([HUNT.here.lat, HUNT.here.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#1f6feb", fillOpacity: 1 }).bindTooltip("You").addTo(layer); }
    if (all.length) map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 18 }); else map.setView([m.lat, m.lon], 15);
  }
  if (H.open) draw();
};
