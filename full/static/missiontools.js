"use strict";
/* RF Recon — a mission over time, under Compare in an opened mission (mission.js): replay its readings on a map,
   when signals are heard (hour by weekday), and lines of bearing with where they cross (geo.bearing_fix). */

const MT_VIEWS = [["replay", "Replay"], ["wheel", "When heard"], ["bearing", "Lines of bearing"]];
const MT_SPEEDS = [[60, "1 min a second"], [300, "5 min a second"], [900, "15 min a second"], [3600, "1 hour a second"], [21600, "6 hours a second"]];
const MT_WINDOWS = [[60, "the last minute"], [300, "the last 5 min"], [900, "the last 15 min"], [3600, "the last hour"], [0, "everything so far"]];
const MT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const mtTime = s => { const t = Date.parse(s); return isNaN(t) ? null : t; };
const mtColor = t => S.lib?.[t]?.color || "#7aa7c7";
// the maps draw on a canvas, which can't read CSS variables: look the theme's colour up instead
const mtCss = (v, dflt) => getComputedStyle(document.body).getPropertyValue(v).trim() || dflt;
const mtKey = p => p.ident ? `id:${p.ident.toLowerCase()}` : p.freq_mhz != null ? `f:${(Math.round(p.freq_mhz / 0.00625) * 0.00625).toFixed(5)}` : `l:${p.label}`;
const mtName = p => p.freq_mhz != null ? `${fmtF(p.freq_mhz)} MHz` : (p.ident || p.label || "signal");
// the filter box: blank = everything; a number = that frequency (within 12.5 kHz); words = in the label, type, ID or file
function mtMatch(q, p){
  q = (q || "").trim(); if(!q) return true;
  const f = parseFloat(q);
  if(/^[\d.]+$/.test(q) && isFinite(f)) return p.freq_mhz != null && Math.abs(p.freq_mhz - f) <= 0.0125;
  const s = `${p.label} ${p.sig_type} ${p.ident} ${p.capture}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => s.includes(w));
}
// a point `km` along `brg` degrees from lat/lon (great circle)
function mtDest(lat, lon, brg, km){
  const R = 6371.0088, d = km / R, b = brg * Math.PI / 180, p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * 180 / Math.PI, ((l2 * 180 / Math.PI) + 540) % 360 - 180];
}

window.missionTools = async (v, m) => {
  clearInterval(S.mtTimer);
  const M = S.mt = S.mt?.mid === m.id ? S.mt : {mid: m.id, view: "replay", q: "", speed: 300, win: 900, len: 5, sel: null};
  v.insertAdjacentHTML("beforeend", `<div class="panel" style="margin-top:10px" id="mtPanel"><h3>This mission over time <span class="hint">· replay, when signals are heard, lines of bearing</span></h3><p class="status">Loading…</p></div>`);
  const box = $("#mtPanel");
  let T, B;
  try { [T, B] = await Promise.all([api(`/api/missions/${m.id}/timeline`), api(`/api/missions/${m.id}/bearings`)]); }
  catch(e){ box.innerHTML = `<h3>This mission over time</h3><p class="status err">${esc(e.message)}</p>`; return; }
  for(const p of T.points) p.t = mtTime(p.ts);
  T.points = T.points.filter(p => p.t != null).sort((a, b) => a.t - b.t);
  T.track = T.track.map(([ts, lat, lon]) => [mtTime(ts), lat, lon]).filter(x => x[0] != null).sort((a, b) => a[0] - b[0]);
  box.innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h3 style="margin:0">This mission over time</h3>
      <div class="seg" id="mtSeg">${MT_VIEWS.map(([k, l]) => `<button data-v="${k}" class="${M.view === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="row" style="margin-top:8px;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <label class="grow">Signal <input id="mtQ" value="${esc(M.q)}" placeholder="all signals, or a frequency (155.475), a type (P25) or words in the label"></label>
      <span class="hint">${T.points.length.toLocaleString()} readings with a time${T.untimed ? ` · ${T.untimed.toLocaleString()} without one, left out` : ""}${T.every > 1 ? ` · every ${T.every}th shown` : ""}</span></div>
    <div id="mtBody" style="margin-top:8px"></div>`;
  $("#mtSeg").onclick = e => { const b = e.target.closest("[data-v]"); if(!b) return; M.view = b.dataset.v; $$("#mtSeg button").forEach(x => x.classList.toggle("on", x === b)); show(); };
  $("#mtQ").onchange = () => { M.q = $("#mtQ").value; show(); };
  const show = () => { clearInterval(S.mtTimer); ({replay: mtReplay, wheel: mtWheel, bearing: mtBearings}[M.view])($("#mtBody"), T, B, M); };
  show();
};

/* ---------- replay: readings appear on the map in time order, the GPS track draws behind them ---------- */
function mtReplay(el, T, B, M){
  const pts = T.points.filter(p => mtMatch(M.q, p) && p.lat != null);
  if(!pts.length && !T.track.length){ el.innerHTML = `<p class="hint">Nothing to replay${M.q ? " for that signal" : ""}: the readings need a time and a position. Import captures with a time column (WiGLE, GPX, an analyzer CSV) or use the field log.</p>`; return; }
  const t0 = Math.min(pts[0]?.t ?? Infinity, T.track[0]?.[0] ?? Infinity), t1 = Math.max(pts.at(-1)?.t ?? -Infinity, T.track.at(-1)?.[0] ?? -Infinity);
  M.t = M.t != null && M.t >= t0 && M.t <= t1 ? M.t : t0;
  el.innerHTML = `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
      <button id="rpPlay" class="primary" style="min-width:90px">▶ Play</button>
      <input type="range" id="rpT" min="0" max="1000" step="1" style="flex:1;min-width:200px">
      <span class="mono" id="rpNow" style="min-width:150px"></span></div>
    <div class="row" style="gap:10px;margin-top:6px;flex-wrap:wrap;align-items:center">
      <label class="inl">Speed <select id="rpSpd">${MT_SPEEDS.map(([s, l]) => `<option value="${s}" ${s === M.speed ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="inl">Show what was heard in <select id="rpWin">${MT_WINDOWS.map(([s, l]) => `<option value="${s}" ${s === M.win ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <span class="hint">Quiet stretches are skipped. ${esc(new Date(t0).toLocaleString())} to ${esc(new Date(t1).toLocaleString())}.</span></div>
    <div class="grid2" style="margin-top:8px;grid-template-columns:minmax(320px,1.6fr) minmax(260px,1fr)">
      <div id="rpMap" style="height:400px;border-radius:12px"></div>
      <div><h3 style="margin-top:0">Heard <span class="hint" id="rpCount"></span></h3><div class="tw" style="max-height:370px" id="rpList"></div></div></div>`;
  if(typeof L === "undefined") return;
  const map = L.map("rpMap", {preferCanvas: true}); addMapLayers(map);
  const ll = [...pts.map(p => [p.lat, p.lon]), ...T.track.map(x => [x[1], x[2]])];
  map.fitBounds(L.latLngBounds(ll).pad(0.08));
  if(T.track.length > 1) L.polyline(T.track.map(x => [x[1], x[2]]), {color: "#888", weight: 2, opacity: .35}).addTo(map);
  const acc = mtCss("--accent", "#e07a3f");
  const done = L.polyline([], {color: acc, weight: 3, opacity: .9}).addTo(map);
  const me = L.circleMarker([0, 0], {radius: 7, color: "#fff", weight: 2, fillColor: acc, fillOpacity: 1}).addTo(map);
  const dots = L.layerGroup().addTo(map);
  const paint = () => {
    const t = M.t, w = M.win * 1000;
    $("#rpT").value = Math.round((t - t0) / Math.max(1, t1 - t0) * 1000);
    $("#rpNow").textContent = new Date(t).toLocaleString();
    let i = 0; while(i < T.track.length && T.track[i][0] <= t) i++;
    done.setLatLngs(T.track.slice(0, i).map(x => [x[1], x[2]]));
    const here = i ? T.track[i - 1] : null, lastPt = pts.filter(p => p.t <= t).at(-1);
    const pos = here && (!lastPt || here[0] >= lastPt.t) ? [here[1], here[2]] : lastPt ? [lastPt.lat, lastPt.lon] : null;
    if(pos){ me.setLatLng(pos); me.setStyle({opacity: 1, fillOpacity: 1}); } else me.setStyle({opacity: 0, fillOpacity: 0});
    const shown = pts.filter(p => p.t <= t && (!w || p.t > t - w)).slice(-3000);
    dots.clearLayers();
    for(const p of shown){ const age = w ? (t - p.t) / w : 0;
      L.circleMarker([p.lat, p.lon], {radius: 5, color: "#fff", weight: 1, fillColor: mtColor(p.sig_type), fillOpacity: .9 - .7 * age, opacity: 1 - .6 * age})
        .bindTooltip(`${esc(mtName(p))}${p.dbm != null ? ` · ${num(p.dbm, 0)} dBm` : ""}${p.label ? ` · ${esc(p.label)}` : ""}<br>${esc(new Date(p.t).toLocaleTimeString())} · ${esc(p.capture)}`).addTo(dots); }
    const by = new Map(); for(const p of shown){ const k = mtKey(p), x = by.get(k); if(!x || (p.dbm ?? -999) > (x.dbm ?? -999)) by.set(k, {...p, n: (x?.n || 0) + 1}); else x.n++; }
    const rows = [...by.values()].sort((a, b) => (b.dbm ?? -999) - (a.dbm ?? -999));
    $("#rpCount").textContent = `· ${rows.length} signal${rows.length === 1 ? "" : "s"}, ${shown.length} reading${shown.length === 1 ? "" : "s"}`;
    $("#rpList").innerHTML = rows.length ? `<table><thead><tr><th>Signal</th><th>Type</th><th class="n">Strongest</th><th class="n">Readings</th></tr></thead><tbody>${rows.slice(0, 40).map(r =>
      `<tr><td><span class="dot" style="background:${mtColor(r.sig_type)}"></span> ${esc(mtName(r))}${r.label ? `<br><span class="hint">${esc(r.label)}</span>` : ""}</td><td>${esc(r.sig_type)}</td><td class="n">${num(r.dbm, 0)}</td><td class="n">${r.n}</td></tr>`).join("")}</tbody></table>`
      : '<p class="hint">Nothing heard in this stretch.</p>';
  };
  const stop = () => { clearInterval(S.mtTimer); S.mtTimer = null; $("#rpPlay").textContent = "▶ Play"; };
  $("#rpPlay").onclick = () => {
    if(S.mtTimer){ stop(); return; }
    if(M.t >= t1) M.t = t0;
    $("#rpPlay").textContent = "⏸ Pause";
    S.mtTimer = setInterval(() => {
      if(!document.body.contains($("#rpMap"))){ stop(); return; }
      const step = M.speed * 100, nxt = M.t + step;
      const ahead = pts.find(p => p.t > M.t), trk = T.track.find(x => x[0] > M.t);
      const next = Math.min(ahead?.t ?? Infinity, trk?.[0] ?? Infinity);
      M.t = next > M.t + step * 20 && next !== Infinity ? next - step : nxt;  // skip a quiet stretch
      if(M.t >= t1){ M.t = t1; paint(); stop(); return; }
      paint();
    }, 100);
  };
  $("#rpT").oninput = () => { M.t = t0 + (t1 - t0) * $("#rpT").value / 1000; paint(); };
  $("#rpSpd").onchange = () => { M.speed = +$("#rpSpd").value; };
  $("#rpWin").onchange = () => { M.win = +$("#rpWin").value; paint(); };
  paint();
}

/* ---------- when heard: a wheel of 24 hours (midnight at the top) by 7 rings (Monday inside, Sunday outside) ---------- */
function mtWheel(el, T, B, M){
  const pts = T.points.filter(p => mtMatch(M.q, p));
  if(!pts.length){ el.innerHTML = `<p class="hint">No readings with a time${M.q ? " for that signal" : ""}.</p>`; return; }
  M.measure = M.measure || "readings";
  const cell = Array.from({length: 7}, () => Array.from({length: 24}, () => ({n: 0, keys: new Set()})));
  for(const p of pts){ const d = new Date(p.t), c = cell[(d.getDay() + 6) % 7][d.getHours()]; c.n++; c.keys.add(mtKey(p)); }
  const val = c => M.measure === "signals" ? c.keys.size : c.n, flat = cell.flat(), max = Math.max(1, ...flat.map(val));
  const R0 = 46, RW = 24, C = R0 + 7 * RW + 26, a = h => (h / 24) * 2 * Math.PI - Math.PI / 2;
  const arc = (d, h) => { const r1 = R0 + d * RW, r2 = r1 + RW - 2, s = a(h) + .01, e = a(h + 1) - .01, P = (r, t) => `${(C + r * Math.cos(t)).toFixed(1)},${(C + r * Math.sin(t)).toFixed(1)}`;
    return `M${P(r1, s)} L${P(r2, s)} A${r2},${r2} 0 0 1 ${P(r2, e)} L${P(r1, e)} A${r1},${r1} 0 0 0 ${P(r1, s)}Z`; };
  const unit = M.measure === "signals" ? "signals" : "readings";
  const cells = cell.map((row, d) => row.map((c, h) => { const x = val(c);
    return `<path d="${arc(d, h)}" fill="var(--accent)" fill-opacity="${x ? (.12 + .88 * x / max).toFixed(3) : 0}" stroke="var(--line, rgba(128,128,128,.35))" stroke-width=".6"><title>${MT_DAYS[d]} ${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00 · ${x} ${unit}</title></path>`; }).join("")).join("");
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map(h => { const r = R0 + 7 * RW + 12, t = a(h); return `<text x="${(C + r * Math.cos(t)).toFixed(1)}" y="${(C + r * Math.sin(t) + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".75">${String(h).padStart(2, "0")}</text>`; }).join("");
  const days = MT_DAYS.map((d, i) => `<text x="${C + 3}" y="${(C - R0 - i * RW - RW / 2 + 4).toFixed(1)}" font-size="9.5" fill="currentColor" opacity=".8">${d}</text>`).join("");
  const top = flat.map((c, i) => ({d: Math.floor(i / 24), h: i % 24, x: val(c)})).filter(x => x.x).sort((p, q) => q.x - p.x).slice(0, 6);
  const byDay = cell.map(r => r.reduce((s, c) => s + val(c), 0)), byHour = Array.from({length: 24}, (_, h) => cell.reduce((s, r) => s + val(r[h]), 0));
  const bars = (vals, labels) => { const mx = Math.max(1, ...vals); return `<div style="display:flex;align-items:flex-end;gap:2px;height:70px">${vals.map((x, i) =>
    `<div title="${labels[i]} · ${x} ${unit}" style="flex:1;background:var(--accent);opacity:${x ? .25 + .75 * x / mx : .08};height:${Math.max(2, 70 * x / mx)}px;border-radius:3px 3px 0 0"></div>`).join("")}</div>
    <div style="display:flex;gap:2px">${labels.map((l, i) => `<span class="hint" style="flex:1;text-align:center;font-size:10px">${vals.length > 12 && i % 3 ? "" : l}</span>`).join("")}</div>`; };
  el.innerHTML = `<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
      <div class="seg" id="whM"><button data-m="readings" class="${M.measure === "readings" ? "on" : ""}">Readings</button><button data-m="signals" class="${M.measure === "signals" ? "on" : ""}">Different signals</button></div>
      <span class="hint">Shown in this PC's local time. Capture files with no time zone are read as UTC, as GPS and WiGLE logs are.</span></div>
    <div class="grid2" style="margin-top:8px;grid-template-columns:minmax(300px,${2 * C}px) minmax(240px,1fr);align-items:start">
      <svg viewBox="0 0 ${2 * C} ${2 * C}" style="width:100%" role="img" aria-label="Readings by hour and weekday">${cells}${hours}${days}
        <text x="${C}" y="${C - 4}" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">${pts.length.toLocaleString()}</text>
        <text x="${C}" y="${C + 12}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".7">readings</text></svg>
      <div><h3 style="margin-top:0">Busiest</h3>${top.map(x => `<div class="row" style="justify-content:space-between;max-width:360px"><span>${MT_DAYS[x.d]} ${String(x.h).padStart(2, "0")}:00–${String((x.h + 1) % 24).padStart(2, "0")}:00</span><b>${x.x} ${unit}</b></div>`).join("")}
        <h3>By weekday</h3>${bars(byDay, MT_DAYS)}<h3>By hour</h3>${bars(byHour, byHour.map((_, h) => String(h).padStart(2, "0")))}</div></div>`;
  $("#whM").onclick = e => { const b = e.target.closest("[data-m]"); if(b){ M.measure = b.dataset.m; mtWheel(el, T, B, M); } };
}

/* ---------- lines of bearing: each reading's bearing drawn out from where it was taken, and where they cross ---------- */
function mtBearings(el, T, B, M){
  const groups = B.groups.filter(g => mtMatch(M.q, {...g, capture: ""}));
  if(!groups.length){ el.innerHTML = `<p class="hint">${B.groups.length ? "No bearings for that signal." : "No bearings in this mission yet. Add one in the field log (Bearing °, the direction the signal came from), or import a capture with a bearing, azimuth or DOA column, for example from a direction-finding antenna."}</p>`; return; }
  const g = groups.find(x => x.key === M.sel) || groups[0]; M.sel = g.key;
  const q = f => !f ? "no fix" : {good: "good", fair: "fair", poor: "poor"}[f.quality];
  const qc = f => !f ? "var(--muted)" : f.quality === "good" ? "var(--good)" : f.quality === "fair" ? "var(--warn)" : "var(--bad)";
  el.innerHTML = `<div class="grid2" style="margin-top:0;grid-template-columns:minmax(240px,1fr) minmax(320px,1.6fr)">
    <div><div class="tw" style="max-height:420px"><table><thead><tr><th>Signal</th><th class="n">Bearings</th><th>Fix</th></tr></thead><tbody>${groups.map(x =>
      `<tr data-g="${esc(x.key)}" style="cursor:pointer;${x.key === g.key ? "background:var(--sel)" : ""}"><td>${esc(mtName(x))}${x.label ? `<br><span class="hint">${esc(x.label)}</span>` : ""}</td><td class="n">${x.readings.length}</td>
        <td style="color:${qc(x.fix)}">${q(x.fix)}${x.fix ? ` · ±${num(x.fix.rms_m, 0)} m` : ""}</td></tr>`).join("")}</tbody></table></div>
      <label class="inl" style="margin-top:8px">Draw lines <select id="brLen">${[1, 2, 5, 10, 20].map(n => `<option ${n === M.len ? "selected" : ""}>${n}</option>`).join("")}</select> mi long</label></div>
    <div><div id="brMap" style="height:380px;border-radius:12px"></div><div id="brFix" style="margin-top:8px"></div></div></div>`;
  el.querySelectorAll("[data-g]").forEach(r => r.onclick = () => { M.sel = r.dataset.g; mtBearings(el, T, B, M); });
  $("#brLen").onchange = () => { M.len = +$("#brLen").value; mtBearings(el, T, B, M); };
  // lines in the accent with a dark casing (a type colour such as Analog FM's grey vanishes on a dark map); the dots keep the type colour
  const f = g.fix, km = M.len * 1.609344, col = mtColor(g.sig_type), acc = mtCss("--accent", "#e07a3f");
  $("#brFix").innerHTML = f ? `<p style="margin:0"><b style="color:${qc(f)}">Fix (${q(f)})</b> <span class="mono">${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}</span> from ${f.n} bearings.
      The lines miss it by ${num(f.rms_m, 0)} m on average; the widest crossing is ${num(f.crossing_deg, 0)}°.</p>
      ${f.behind ? `<p class="status err" style="margin:4px 0 0">${f.behind} bearing${f.behind === 1 ? " points" : "s point"} away from the fix: check ${f.behind === 1 ? "it" : "them"} (a reflection, or a bearing 180° out).</p>` : ""}
      ${f.crossing_deg < 20 ? `<p class="hint" style="margin:4px 0 0">The lines cross at a shallow angle, so the fix stretches along them. A bearing from further round the signal sharpens it.</p>` : ""}
      ${f.n < 3 ? `<p class="hint" style="margin:4px 0 0">Two bearings always meet somewhere; a third shows whether they agree.</p>` : ""}
      <div class="row" style="margin-top:6px"><button class="primary" id="brPin">Put the pin on the fix</button><button id="brCopy">Copy the position</button><span class="hint" id="brMsg"></span></div>`
    : `<p class="hint" style="margin:0">${g.readings.length < 2 ? "One bearing: a second, from somewhere else, gives a fix." : "These bearings run parallel, so they don't cross: take one from further round the signal."}</p>`;
  if(typeof L === "undefined") return;
  const map = L.map("brMap", {preferCanvas: true}); addMapLayers(map);
  const ll = [];
  for(const r of g.readings){ const end = mtDest(r.lat, r.lon, r.bearing, km); ll.push([r.lat, r.lon], end);
    L.polyline([[r.lat, r.lon], end], {color: "#000", weight: 5, opacity: .35}).addTo(map);
    L.polyline([[r.lat, r.lon], end], {color: acc, weight: 2.5, opacity: .95, dashArray: "8 6"}).addTo(map);
    L.circleMarker([r.lat, r.lon], {radius: 5, color: "#fff", weight: 1.5, fillColor: col, fillOpacity: 1})
      .bindTooltip(`${num(r.bearing, 0)}°${r.dbm != null ? ` · ${num(r.dbm, 0)} dBm` : ""}${r.ts ? `<br>${esc(new Date(r.ts).toLocaleString())}` : ""}`).addTo(map); }
  if(f){ ll.push([f.lat, f.lon]);
    const fc = {good: mtCss("--good", "#3fb950"), fair: mtCss("--warn", "#d29922"), poor: mtCss("--bad", "#f85149")}[f.quality];
    L.circle([f.lat, f.lon], {radius: Math.max(30, f.rms_m), color: fc, weight: 2, fillOpacity: .15}).addTo(map);
    L.marker([f.lat, f.lon], {icon: pinIcon(), title: "Fix"}).bindTooltip(`Fix · ±${num(f.rms_m, 0)} m`).addTo(map);
    $("#brPin").onclick = () => { $("#loc").value = `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`; setTab("map"); runSearch(); };
    $("#brCopy").onclick = async () => { try{ await navigator.clipboard.writeText(`${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`); $("#brMsg").textContent = "Copied."; }catch(e){ $("#brMsg").textContent = `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`; } }; }
  map.fitBounds(L.latLngBounds(ll).pad(0.12));
}
