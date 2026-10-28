"use strict";
/* RF Recon — Area report: everything licensed around a pin, predicted coverage per band,
   and survey / crowd signals that no FCC licence or allocation explains. */

const NON_FCC = ["captures", "wigle", "opencellid", "repeaterbook", "custom"];
// Coverage edge on the band map: show only where the predicted level is at least this (free-space, best case,
// so in a dense area everything inside a few miles clears -100; stronger levels show the real differences)
const REPORT_FLOORS = [-100, -90, -80, -70, -60, -50, -40, -30, -20];
const AUTH_COLOR = {"Unlisted":"#cf222e", "FCC licensed":"#0b6e4f", "Unlicensed (Part 15)":"#8250df",
  "Personal radio (Part 95)":"#bf8700", "Amateur (individual licence)":"#1f6feb", "Cellular (market licence)":"#bf3989",
  "Federal (NTIA; not in FCC data)":"#9a6700", "No frequency":"#8c959f"};
const authColor = c => AUTH_COLOR[c] || "#57606a";
const DIGITAL = /P25|DMR|NXDN|Digital|Data|TETRA/;
// a faint bar behind a number, scaled to the column max (reads like a bar chart, keeps the exact value)
const cellBar = (n, max) => `style="background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 22%,transparent) ${max ? Math.round(100 * n / max) : 0}%,transparent 0)"`;

S.views.report = (v, rows) => {
  if (S.reportMap) { S.reportMap.remove(); S.reportMap = null; }
  if (!S.center) {
    v.innerHTML = '<p class="status">The area report needs a pin: click the map, type coordinates or paste a Maps link above, set a radius, then Search.</p>';
    return;
  }
  const gen = S.reportGen = (S.reportGen || 0) + 1;  // a newer render wins over late fetches
  const uls = rows.filter(r => ["uls", "broadcast", "noaa", "faa"].includes(r.layer)), towers = rows.filter(r => r.layer === "towers");  // licensed and approved: land mobile etc., broadcast, NOAA, FAA
  const survey = rows.filter(r => NON_FCC.includes(r.layer));
  const freqs = new Set(uls.map(r => fmtF(r.freq_mhz))), lics = new Set(uls.map(r => r.licensee));
  const byBand = new Map();
  for (const r of uls) { const b = r.band || "Other"; if (!byBand.has(b)) byBand.set(b, []); byBand.get(b).push(r); }
  const bands = [...byBand.entries()].map(([band, rs]) => ({
    band, rs, lo: Math.min(...rs.map(r => r.freq_mhz)), hi: Math.max(...rs.map(r => r.freq_mhz)),
    freqs: new Set(rs.map(r => fmtF(r.freq_mhz))).size, lics: new Set(rs.map(r => r.licensee)).size,
    techs: countBy(rs, typeOf), near: Math.min(...rs.map(r => r.dist_mi ?? 1e9)),
    best: Math.max(...rs.map(r => r.est_rx_dbm ?? -1e9)) })).sort((a, b) => a.lo - b.lo);
  const techs = countBy(uls, typeOf);
  const digitalPct = uls.length ? Math.round(100 * uls.filter(r => DIGITAL.test(r.mode || "")).length / uls.length) : 0;
  const nearest = uls.length ? Math.min(...uls.map(r => r.dist_mi ?? 1e9)) : null;
  const filtersOn = Object.values(S.chips).some(s => s.size) || $("#q").value || $("#fmin").value || $("#fmax").value;
  if (!S.reportBand || !byBand.has(S.reportBand)) S.reportBand = bands.slice().sort((a, b) => b.freqs - a.freqs)[0]?.band;
  const maxF = Math.max(1, ...bands.map(b => b.freqs)), maxL = Math.max(1, ...bands.map(b => b.lics));

  v.innerHTML = `
  <div class="row no-print" style="justify-content:space-between;margin-bottom:6px">
    <h2 style="margin:0">Area report</h2><button id="rp_print">⎙ Print report</button></div>
  <p style="margin:2px 2px 10px">Within <b>${S.radius} mi</b> of <span class="mono">${S.center[0].toFixed(5)}, ${S.center[1].toFixed(5)}</span>:
    <b>${freqs.size.toLocaleString()}</b> licensed frequencies from <b>${lics.size.toLocaleString()}</b> licensees in <b>${bands.length}</b> bands,
    ${digitalPct}% digital (P25 / DMR / NXDN and data); <b>${towers.length}</b> registered towers${nearest != null ? `; nearest licensed site ${num(nearest, 2)} mi` : ""}.
    ${filtersOn ? '<span class="tag">filters on: counts follow them</span>' : ""} <span class="hint" id="rp_asof"></span>
    ${(() => { const st = countBy(uls, r => r.state || "?").find(([s]) => rrStateUrl(s))?.[0];
      return st ? `<br><span class="hint no-print">Compare with what scanner listeners have logged: <a href="${rrStateUrl(st)}" target="_blank" rel="noopener">RadioReference ${esc(st)} (pick the county)</a></span>` : ""; })()}</p>
  <div class="cards">
    <div class="card" data-jump="rp_bands"><div class="v">${freqs.size.toLocaleString()}</div><div class="k">Licensed frequencies</div></div>
    <div class="card" data-jump="rp_all"><div class="v">${lics.size.toLocaleString()}</div><div class="k">Licensees</div></div>
    <div class="card" data-jump="rp_bands"><div class="v">${bands.length}</div><div class="k">Bands</div></div>
    <div class="card" data-jump="rp_tech"><div class="v">${techs.length}</div><div class="k">Technologies</div></div>
    <div class="card" data-jump="rp_cov"><div class="v">${towers.length}</div><div class="k">Registered towers</div></div>
    <div class="card" data-jump="rp_sig"><div class="v">${survey.length.toLocaleString()}</div><div class="k">Survey + crowd points</div></div>
    <div class="card" data-jump="rp_sig"><div class="v" id="rp_unlisted">…</div><div class="k">Unlisted signals</div></div>
  </div>

  <div class="panel" id="rp_bands" style="margin-top:10px"><h3>Bands</h3>
    ${bands.length ? `<div class="tw"><table><thead><tr><th>Band</th><th>Range MHz</th><th>Frequencies</th><th>Licensees</th><th>Technologies</th><th>Nearest mi</th><th>Strongest est. dBm</th><th class="no-print"></th></tr></thead><tbody>
    ${bands.map(b => `<tr><td>${esc(b.band)}</td><td class="mono">${fmtF(b.lo)}${b.hi > b.lo ? `–${fmtF(b.hi)}` : ""}</td>
      <td class="n" ${cellBar(b.freqs, maxF)}>${b.freqs.toLocaleString()}</td><td class="n" ${cellBar(b.lics, maxL)}>${b.lics.toLocaleString()}</td>
      <td style="min-width:180px"><div style="display:flex;height:9px;border-radius:5px;overflow:hidden;margin-bottom:3px">${b.techs.map(([t, n]) => `<span title="${esc(t)}: ${n}" style="width:${100 * n / b.rs.length}%;background:${typeColor(t)}"></span>`).join("")}</div>
        <span class="hint">${b.techs.slice(0, 3).map(([t, n]) => `${esc(t)} ${n}`).join(" · ")}${b.techs.length > 3 ? ` · +${b.techs.length - 3}` : ""}</span></td>
      <td class="n">${b.near < 1e9 ? num(b.near, 2) : ""}</td><td class="n">${b.best > -1e9 ? num(b.best, 0) : ""}</td>
      <td class="no-print"><button data-cov="${esc(b.band)}">Coverage</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="hint">No licensed frequencies with the current layers and filters. Turn on the FCC licensed layer or clear filters.</p>'}
  </div>

  <div class="panel" id="rp_cov" style="margin-top:10px"><h3>Coverage by band <span class="hint">predicted from licensed ERP with Hata and the hills (strongest transmitters), handheld at 1.5 m</span></h3>
    <div class="row no-print" style="margin-bottom:6px"><label class="inl">Show where the band is at least
      <select id="rp_floor">${REPORT_FLOORS.map(f => `<option value="${f}" ${f === (S.reportFloor ?? -100) ? "selected" : ""}>${f} dBm</option>`).join("")}</select></label></div>
    <div class="chips no-print" id="rp_pills">${bands.map(b => `<span class="chip ${b.band === S.reportBand ? "on" : ""}" data-band="${esc(b.band)}">${esc(b.band)} <b>${b.freqs}</b></span>`).join("")}</div>
    <p class="hint" id="rp_covnote" style="margin:6px 2px"></p>
    <div id="rp_map" style="height:440px;border-radius:10px"></div></div>

  <div class="panel" id="rp_tech" style="margin-top:10px"><h3>Technologies</h3>
    ${techs.length ? `<div class="tw"><table><thead><tr><th>Technology</th><th>Frequencies</th><th>Licensees</th><th>Bands</th><th class="no-print">Identify</th></tr></thead><tbody>
    ${techs.map(([t]) => { const rs = uls.filter(r => typeOf(r) === t); const f = new Set(rs.map(r => fmtF(r.freq_mhz))).size;
      return `<tr><td><span class="dot" style="background:${typeColor(t)}"></span> ${esc(t)}</td><td class="n" ${cellBar(f, freqs.size)}>${f}</td>
        <td class="n">${new Set(rs.map(r => r.licensee)).size}</td><td>${esc([...new Set(rs.map(r => r.band || "Other"))].join(", "))}</td>
        <td class="no-print">${S.lib[t]?.url ? `<a href="${esc(S.lib[t].url)}" target="_blank" rel="noopener">Signal ID wiki</a>` : ""}</td></tr>`; }).join("")}</tbody></table></div>` : '<p class="hint">None.</p>'}</div>

  <div class="panel" id="rp_all" style="margin-top:10px"><h3>Every licensed frequency, by band</h3>
    ${bands.map(b => { const g = groupItems(b.rs).sort((x, y) => x.freq_mhz - y.freq_mhz || (x.dist_mi ?? 0) - (y.dist_mi ?? 0));
      return `<details><summary><b>${esc(b.band)}</b> <span class="hint">${b.freqs} frequencies · ${b.lics} licensees</span></summary>
      <div class="tw" style="max-height:420px"><table><thead><tr><th>MHz</th><th>Licensee</th><th>Call sign</th><th>Technology</th><th>Emission</th><th>ERP W</th><th>Distance</th><th>Est. dBm</th></tr></thead><tbody>
      ${g.slice(0, 60).map(r => `<tr><td class="mono">${fmtF(r.freq_mhz)}</td><td>${esc(r.ov_alpha_tag || r.licensee || "")}</td><td class="mono">${esc(r.call_sign || "")}</td>
        <td>${esc(typeOf(r))}</td><td class="mono">${esc(r.emissions || "")}</td><td class="n">${num(r.erp_w, 0)}</td>
        <td class="n">${num(r.dist_mi, 2)} ${esc(r.compass || "")}</td><td class="n">${num(r.est_rx_dbm, 0)}</td></tr>`).join("")}</tbody></table></div>
      ${g.length > 60 ? `<p class="hint">Showing 60 of ${g.length}. The Analyzer and Map table list them all, with the same filters.</p>` : ""}</details>`; }).join("") || '<p class="hint">None.</p>'}</div>

  <div class="panel" id="rp_sig" style="margin-top:10px"><h3>Signals not on the FCC licence list</h3>
    <p class="hint">Your captures and the crowd layers (WiGLE, OpenCelliD, RepeaterBook, imported layers) in this area. Each is checked against FCC licences on that frequency within 40 mi,
      then against bands where transmitting is allowed without a site licence (Part 15, Part 95, amateur, market-licensed cellular, broadcast, aviation, marine, federal).
      Whatever is left is <b style="color:${authColor("Unlisted")}">Unlisted</b>: worth a second look on site.</p>
    <div id="rp_sigbody">${survey.length ? '<p class="status">Checking…</p>' : `<p class="status">No survey or crowd data in this area yet.</p>
      <div class="row no-print"><button data-goto="mission">Import captures (Mission)</button><button data-goto="data">Fetch WiGLE / OpenCelliD / RepeaterBook (Data &amp; updates)</button></div>`}</div></div>`;

  v.querySelectorAll("[data-jump]").forEach(c => c.onclick = () => $("#" + c.dataset.jump)?.scrollIntoView({behavior: "smooth", block: "start"}));
  v.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => setTab(b.dataset.goto));
  $("#rp_print").onclick = () => window.print();
  const pick = band => { S.reportBand = band; v.querySelectorAll("#rp_pills .chip").forEach(c => c.classList.toggle("on", c.dataset.band === band)); drawBandHeat(gen); };
  v.querySelectorAll("#rp_pills .chip").forEach(c => c.onclick = () => pick(c.dataset.band));
  $("#rp_floor").onchange = e => { S.reportFloor = +e.target.value; drawBandHeat(gen); };
  v.querySelectorAll("[data-cov]").forEach(b => b.onclick = () => { pick(b.dataset.cov); $("#rp_cov").scrollIntoView({behavior: "smooth", block: "start"}); });

  if (typeof L !== "undefined") {
    const map = L.map("rp_map", {preferCanvas: true}); S.reportMap = map;
    addMapLayers(map);
    const rm = S.radius * 1609.344;
    L.circle(S.center, {radius: rm, color: "#555", weight: 2, fill: false, interactive: false}).addTo(map);
    L.marker(S.center, {icon: pinIcon(), interactive: false}).addTo(map);
    map.fitBounds(L.latLng(S.center).toBounds(rm * 2.1));
    drawBandHeat(gen);
  }
  api("/api/meta").then(m => { if (gen === S.reportGen) $("#rp_asof").textContent = `FCC data ${m.built_at || "?"}${m.towers_built_at ? `, towers ${m.towers_built_at}` : ""}.`; }).catch(() => {});
  if (survey.length) loadSignals(gen); else $("#rp_unlisted").textContent = "0";
};

async function drawBandHeat(gen) {
  const map = S.reportMap, note = $("#rp_covnote");
  if (!map || !S.reportBand) { if (note) note.textContent = "No licensed band to draw."; return; }
  if (S.reportHeat) { map.removeLayer(S.reportHeat); S.reportHeat = null; }
  note.textContent = `Building ${S.reportBand} coverage…`;
  try {
    const floor = S.reportFloor ?? -100;
    const h = await api("/api/heatmap?" + params({kind: "terrain", bands: S.reportBand, layers: "uls,broadcast,noaa", floor, size: 140, alpha: 200}));
    if (gen !== S.reportGen || !S.reportMap) return;
    S.reportHeat = L.imageOverlay("data:image/png;base64," + h.png, h.bounds, {opacity: .75, interactive: false}).addTo(map);
    note.textContent = `${S.reportBand}: ${h.desc}. Scale ${num(h.vmin, 0)} to ${num(h.vmax, 0)} ${h.unit} (blue weak, red strong); clear where below ${floor} dBm.`;
  } catch (e) { if (gen === S.reportGen) note.textContent = "Coverage: " + e.message; }
}

async function loadSignals(gen) {
  const body = $("#rp_sigbody");
  try {
    const layers = NON_FCC.filter(l => S.layerOn.has(l)).join(",");
    const res = await api("/api/report/signals?" + params({layers, all_captures: 1}));
    if (gen !== S.reportGen) return;
    const c = res.counts, n = res.rows.length, un = c["Unlisted"] || 0, lic = c["FCC licensed"] || 0;
    $("#rp_unlisted").textContent = un.toLocaleString();
    $("#rp_unlisted").style.color = un ? authColor("Unlisted") : "";
    const cats = Object.entries(c).sort((a, b) => (b[0] === "Unlisted") - (a[0] === "Unlisted") || b[1] - a[1]);
    const shown = S.reportSigAll ? res.rows : res.rows.slice(0, 200);
    body.innerHTML = `<p>${n.toLocaleString()} points: <b>${lic.toLocaleString()}</b> match an FCC licence, <b>${(n - lic - un - (c["No frequency"] || 0)).toLocaleString()}</b> sit in bands allowed without a site licence,
      <b style="color:${un ? authColor("Unlisted") : "inherit"}">${un.toLocaleString()} unlisted</b>${c["No frequency"] ? `, ${c["No frequency"]} without a frequency` : ""}.</p>
      <div class="chips">${cats.map(([k, m]) => `<span class="chip"><span class="dot" style="background:${authColor(k)}"></span>${esc(k)} <b>${m.toLocaleString()}</b></span>`).join("")}</div>
      <div class="tw" style="max-height:520px;margin-top:8px"><table><thead><tr><th>Finding</th><th>MHz</th><th>Type</th><th>dBm</th><th>Label / ID</th><th>Source</th><th>Distance</th><th>When</th><th>Why</th></tr></thead><tbody>
      ${shown.map(r => `<tr><td><span class="tag" style="border-color:${authColor(r.authority)};color:${authColor(r.authority)}">${esc(r.authority)}</span></td>
        <td class="mono">${fmtF(r.freq_mhz)}</td><td>${esc(r.sig_type || "")}</td><td class="n">${num(r.dbm, 0)}</td>
        <td>${esc(r.label || r.ident || "")}</td><td>${esc(LAYERS[r.layer]?.label || r.layer)}${r.capture_name ? ` · ${esc(r.capture_name)}` : ""}</td>
        <td class="n">${num(r.dist_mi, 2)} ${esc(r.compass || "")}</td><td class="mono">${esc((r.ts || "").slice(0, 16))}</td><td class="hint">${esc(r.authority_note || "")}
          ${r.sigwiki?.length ? `<br>Could be: ${r.sigwiki.map(c => `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.why.join(" · "))}">${esc(c.title)}</a>`).join(", ")} <span class="hint">(Signal ID Wiki)</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
      ${res.rows.length > shown.length ? `<button id="rp_sigall" class="no-print" style="margin-top:6px">Show all ${res.rows.length.toLocaleString()}</button>` : ""}`;
    const all = $("#rp_sigall"); if (all) all.onclick = () => { S.reportSigAll = true; loadSignals(gen); };
    if (S.reportMap) for (const r of res.rows) if (r.lat != null)
      L.circleMarker([r.lat, r.lon], {radius: r.authority === "Unlisted" ? 6 : 4, color: authColor(r.authority), weight: 1.5, fillOpacity: .7})
        .bindPopup(`<b>${esc(r.authority)}</b><br>${fmtF(r.freq_mhz)} MHz ${esc(r.sig_type || "")} ${r.dbm != null ? num(r.dbm, 0) + " dBm" : ""}<br><span class="hint">${esc(r.authority_note || "")}</span>`).addTo(S.reportMap);
  } catch (e) { if (gen === S.reportGen) body.innerHTML = `<p class="status">Couldn't check survey data: ${esc(e.message)}</p>`; }
}
