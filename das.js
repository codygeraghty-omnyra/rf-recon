"use strict";
/* RF Recon phone app: DAS in the field. A grid test entered square by square with no signal (kept on this phone,
   exported as a CSV that RF Recon on the PC reads in a DAS job's Grid test, Import results), the PIM calculator,
   and the code numbers at a glance. Profiles, pass rules and floor percentages match the PC's DAS tab (static/das.js). */

const DAS_PROFILES = {  // the PC's AHJ presets
  "IFC 2021 + NFPA 1225": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12},
  "IFC 2024 / NFPA 1225 (DAQ only)": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12},
  "Strict (DAQ 3.4, 24 h, as OCSD)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 100, battery_h: 24},
  "Older NFPA 72 (90% general)": {threshold: -95, daq: 3.0, general_pct: 90, critical_pct: 99, battery_h: 12},
};
const DAS_DAQ = ["", "1", "2", "2.5", "3", "3.4", "3.5", "4", "4.5", "5"];
// uplink bands a PIM product can land in (the PC's PIM tab, static/fieldref.js)
const DAS_RX = [["B71 600 UL", 663, 698], ["B12/17 700 UL", 699, 716], ["B13 700 UL", 777, 787], ["B14 FirstNet UL", 788, 798], ["700 public safety UL", 799, 805],
  ["800 public safety / SMR UL", 806, 824], ["B5 850 UL", 824, 849], ["B26 UL", 814, 849], ["B66/4 AWS UL", 1710, 1780], ["B2/25 PCS UL", 1850, 1915],
  ["B30 WCS UL", 2305, 2315], ["n41 2.5 GHz (TDD)", 2496, 2690]];
const DAS = {tests: null, cur: null, floor: null, view: "grid"};
const dHas = v => v !== null && v !== undefined && v !== "" && !isNaN(v);
const dProfile = t => DAS_PROFILES[t.profile] || DAS_PROFILES["IFC 2021 + NFPA 1225"];
const dSave = () => kv.set("das.tests", DAS.tests);

function dasPass(t, r) {  // null when untested; the same rule as the PC (gridPass)
  if (!r || !(dHas(r.dl) || dHas(r.daq))) return null;
  const P = dProfile(t), lvl = v => P.threshold == null || !dHas(v) || +v >= P.threshold;
  return lvl(r.dl) && lvl(r.ul) && (!dHas(r.daq) || +r.daq >= P.daq);
}
function dasFloor(t, f) {  // squares marked not tested leave the count; critical squares are judged on their own percentage
  const skip = new Set(f.skip || []), crit = new Set(f.critical || []), o = {n: f.grids, gen: 0, genPass: 0, crit: 0, critPass: 0, untested: 0};
  for (let g = 1; g <= f.grids; g++) {
    if (skip.has(g)) continue;
    const c = crit.has(g), p = dasPass(t, t.results[`${f.name}|${g}`]);
    c ? o.crit++ : o.gen++;
    if (p == null) o.untested++; else if (p) c ? o.critPass++ : o.genPass++;
  }
  const P = dProfile(t);
  o.genPct = o.gen ? Math.round(100 * o.genPass / o.gen) : 100; o.critPct = o.crit ? Math.round(100 * o.critPass / o.crit) : 100;
  o.ok = !o.untested && o.genPct >= P.general_pct && o.critPct >= P.critical_pct;
  return o;
}
const dColor = s => s.untested ? "var(--muted)" : s.ok ? "#3ccf7a" : "#e5534b";

window.viewDas = async v => {
  if (!DAS.tests) DAS.tests = (await kv.get("das.tests")) || [];
  const t = DAS.tests.find(x => x.id === DAS.cur);
  if (t) return dasTest(v, t);
  const seg = `<div class="chips" style="margin:0 2px 12px">${[["grid", "Grid tests"], ["pim", "PIM calculator"], ["codes", "Code numbers"]].map(([k, l]) =>
    `<button class="chip ${DAS.view === k ? "on" : ""}" data-act="dasview" data-v="${k}">${l}</button>`).join("")}</div>`;
  if (DAS.view === "pim") { v.innerHTML = head("DAS", "Where the intermod products land, and the result in dBc.") + seg + dasPim(); dasPimWire(); return; }
  if (DAS.view === "codes") { v.innerHTML = head("DAS", "The numbers ERCES / BDA work is judged by.") + seg + dasCodes(); return; }
  v.innerHTML = head("DAS", "Grid tests square by square, with no signal. They stay on this phone; export one to RF Recon on the PC.") + seg
    + `<div class="row" style="margin:0 2px 12px"><button class="btn primary" data-act="dasnew">＋ New grid test</button></div>`
    + (DAS.tests.length ? DAS.tests.map((x, i) => { const st = x.floors.map(f => dasFloor(x, f)), passed = st.filter(s => s.ok).length,
        tested = st.reduce((s, o) => s + (o.gen + o.crit - o.untested), 0), all = st.reduce((s, o) => s + o.gen + o.crit, 0);
      return `<div class="card glass" style="--i:${Math.min(i, 8)};cursor:pointer" data-act="dasopen" data-id="${esc(x.id)}">
        <div class="row" style="justify-content:space-between;align-items:baseline"><b style="font-size:17px">${esc(x.name)}</b><span class="hint">${esc(new Date(x.updated).toLocaleDateString())}</span></div>
        <div class="s" style="color:var(--ink-2)">${esc([x.address, x.profile].filter(Boolean).join(" · "))}</div>
        <p style="margin:6px 0 0">${passed} of ${x.floors.length} floor${x.floors.length === 1 ? "" : "s"} pass · ${tested} of ${all} squares tested</p></div>`; }).join("")
      : `<div class="card glass empty"><p>No grid tests yet. Start one when you're on site: name the building, set the floors, then tap each square as you test it.</p></div>`);
};

function dasTest(v, t) {
  const f = t.floors.find(x => x.name === DAS.floor) || t.floors[0]; DAS.floor = f.name;
  const st = dasFloor(t, f), P = dProfile(t), skip = new Set(f.skip || []), crit = new Set(f.critical || []);
  const sq = g => { const r = t.results[`${f.name}|${g}`], p = skip.has(g) ? "skip" : dasPass(t, r);
    const bg = p === "skip" ? "transparent" : p == null ? "var(--wash)" : p ? "rgba(60,207,122,.28)" : "rgba(229,83,75,.32)";
    return `<button data-act="dassq" data-g="${g}" style="aspect-ratio:1;border-radius:12px;border:${crit.has(g) ? "2px solid #fab219" : "1px solid var(--g-border)"};background:${bg};color:var(--ink);font:inherit;padding:2px;${p === "skip" ? "opacity:.45;text-decoration:line-through" : ""}">
      <b style="display:block;font-size:15px">${g}</b><small style="font-size:10px;color:var(--ink-2)">${p === "skip" ? "not tested" : r && dHas(r.dl) ? `${num(r.dl)}` : r && dHas(r.daq) ? `DAQ ${r.daq}` : ""}</small></button>`; };
  v.innerHTML = head(esc(t.name), esc([t.address, `${t.profile}: ${P.threshold != null ? `${P.threshold} dBm, ` : ""}DAQ ${P.daq.toFixed(1)}, ${P.general_pct}% / ${P.critical_pct}% critical`].filter(Boolean).join(" · ")))
    + `<div class="row" style="margin:0 2px 10px;gap:8px;flex-wrap:wrap"><button class="btn small" data-act="dasback">‹ All tests</button>
        <button class="btn small" data-act="dasexport">Export CSV for the PC</button><button class="btn small" data-act="dasfloors">Floors</button>
        <button class="btn small danger" data-act="dasdel">Delete</button></div>`
    + `<div class="chips" style="margin:0 2px 10px">${t.floors.map(x => { const s = dasFloor(t, x);
        return `<button class="chip ${x.name === f.name ? "on" : ""}" data-act="dasfloor" data-f="${esc(x.name)}"><span class="dot" style="background:${dColor(s)}"></span> ${esc(x.name)}</button>`; }).join("")}</div>`
    + `<div class="kpis"><div class="kpi glass" style="--i:0"><div class="v" style="color:${dColor(st)}">${st.genPct}%</div><div class="k">General · need ${P.general_pct}%</div></div>
        <div class="kpi glass" style="--i:1"><div class="v">${st.crit ? `${st.critPct}%` : "–"}</div><div class="k">Critical · need ${P.critical_pct}%</div></div>
        <div class="kpi glass" style="--i:2"><div class="v">${st.untested}</div><div class="k">Untested</div></div></div>`
    + `<div class="card glass" style="--i:3"><h2>Floor ${esc(f.name)} · ${f.grids} squares</h2>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px">${Array.from({length: f.grids}, (_, i) => sq(i + 1)).join("")}</div>
        <p class="hint" style="margin:8px 0 0">Tap a square to enter its reading. Amber edge: critical area. Squares marked not tested leave the count.</p></div>`;
}

function dasSquare(t, f, g) {
  const key = `${f.name}|${g}`, r = t.results[key] || {}, skip = (f.skip || []).includes(g), crit = (f.critical || []).includes(g), P = dProfile(t);
  openSheet(`Floor ${f.name} · square ${g}`, `Pass: ${P.threshold != null ? `${P.threshold} dBm or better, ` : ""}DAQ ${P.daq.toFixed(1)} or better.`, `
    <form id="dsqForm">
      <div class="two"><div class="field"><label for="dq_dl">Downlink, dBm</label><input id="dq_dl" inputmode="decimal" value="${dHas(r.dl) ? r.dl : ""}" placeholder="-85"></div>
        <div class="field"><label for="dq_ul">Uplink, dBm (optional)</label><input id="dq_ul" inputmode="decimal" value="${dHas(r.ul) ? r.ul : ""}"></div></div>
      <div class="field"><label for="dq_daq">Delivered audio quality (DAQ)</label><select id="dq_daq">${DAS_DAQ.map(d => `<option value="${d}" ${String(r.daq ?? "") === d ? "selected" : ""}>${d || "not scored"}</option>`).join("")}</select></div>
      <div class="field"><label><input type="checkbox" id="dq_crit" ${crit ? "checked" : ""}> Critical area (stairwell, fire command, pump room…)</label></div>
      <div class="field"><label><input type="checkbox" id="dq_skip" ${skip ? "checked" : ""}> Not tested (no access): leaves the count</label></div>
      <div class="field"><label for="dq_n">Notes</label><input id="dq_n" value="${esc(r.note || "")}"></div>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="dq_next">Save, next square</button>
        ${t.results[key] ? '<button class="btn danger" type="button" id="dq_clear">Clear</button>' : ""}</div>
    </form>`, sh => {
    const lv = id => { const x = parseFloat($(id).value); return isFinite(x) ? -Math.abs(x) : null; };  // received levels are negative; "85" means -85 dBm
    let me = null;  // where the reading was taken, if the phone knows by the time it's saved; quietly none indoors
    navigator.geolocation?.getCurrentPosition(p => { me = {lat: p.coords.latitude, lon: p.coords.longitude}; }, () => {}, {maximumAge: 120000, timeout: 8000});
    const store = async () => {
      const dl = lv("#dq_dl"), ul = lv("#dq_ul"), daq = $("#dq_daq").value, note = $("#dq_n").value.trim();
      if (dl != null || ul != null || daq) t.results[key] = {dl, ul, daq: daq ? +daq : null, note, ts: new Date().toISOString(), lat: me?.lat ?? null, lon: me?.lon ?? null};
      const tog = (list, on) => on ? [...new Set([...(list || []), g])] : (list || []).filter(x => x !== g);
      f.critical = tog(f.critical, $("#dq_crit").checked); f.skip = tog(f.skip, $("#dq_skip").checked);
      t.updated = new Date().toISOString(); await dSave();
    };
    $("#dsqForm", sh).onsubmit = async e => { e.preventDefault(); await store(); closeSheet(); render(); };
    $("#dq_next", sh).onclick = async () => { await store(); closeSheet(); render(); if (g < f.grids) dasSquare(t, f, g + 1); };
    $("#dq_clear", sh) && ($("#dq_clear", sh).onclick = async () => { delete t.results[key]; t.updated = new Date().toISOString(); await dSave(); closeSheet(); render(); });
  });
}

function dasNew() {
  openSheet("New grid test", "NFPA 1225 tests each floor in 20 squares (floors over 128,000 sq ft in sectors of 20).", `
    <form id="dnForm">
      <div class="field"><label for="dn_name">Building</label><input id="dn_name" placeholder="e.g. 1200 Main St tower" required></div>
      <div class="field"><label for="dn_addr">Address (optional)</label><input id="dn_addr"></div>
      <div class="two"><div class="field"><label for="dn_fl">Floors</label><input id="dn_fl" inputmode="numeric" value="1"></div>
        <div class="field"><label for="dn_g">Squares a floor</label><input id="dn_g" inputmode="numeric" value="20"></div></div>
      <div class="field"><label for="dn_bl">Basement levels</label><input id="dn_bl" inputmode="numeric" value="0"></div>
      <div class="field"><label for="dn_p">Requirements</label><select id="dn_p">${Object.keys(DAS_PROFILES).map(p => `<option>${esc(p)}</option>`).join("")}</select></div>
      <div class="row"><button class="btn primary" type="submit">Start</button><button class="btn" type="button" data-act="close">Cancel</button></div>
    </form>`, sh => {
    $("#dnForm", sh).onsubmit = async e => {
      e.preventDefault();
      const n = Math.max(1, Math.min(200, parseInt($("#dn_fl").value) || 1)), b = Math.max(0, Math.min(10, parseInt($("#dn_bl").value) || 0));
      const g = Math.max(1, Math.min(100, parseInt($("#dn_g").value) || 20)), now = new Date().toISOString();
      const floors = [...Array.from({length: b}, (_, i) => ({name: `B${b - i}`, grids: g})), ...Array.from({length: n}, (_, i) => ({name: String(i + 1), grids: g}))];
      const t = {id: `t${Date.now()}`, name: $("#dn_name").value.trim() || "Grid test", address: $("#dn_addr").value.trim(), profile: $("#dn_p").value,
        floors, results: {}, made: now, updated: now};
      DAS.tests.unshift(t); await dSave(); DAS.cur = t.id; DAS.floor = floors[0].name; closeSheet(); render();
    };
  });
}

function dasFloors(t) {
  openSheet("Floors", "Squares per floor, and floors to add. Removing a floor removes its readings.", `
    <form id="dfForm">${t.floors.map((f, i) => `<div class="two"><div class="field"><label>Floor</label><input data-fn="${i}" value="${esc(f.name)}"></div>
        <div class="field"><label>Squares</label><input data-fg="${i}" inputmode="numeric" value="${f.grids}"></div></div>`).join("")}
      <div class="field"><label for="df_add">Add a floor named</label><input id="df_add" placeholder="e.g. 12, Roof or P2"></div>
      <div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="close">Cancel</button></div></form>`, sh => {
    $("#dfForm", sh).onsubmit = async e => {
      e.preventDefault();
      const floors = t.floors.map((f, i) => { const name = $(`[data-fn="${i}"]`).value.trim(), grids = Math.max(1, Math.min(100, parseInt($(`[data-fg="${i}"]`).value) || f.grids));
        if (name && name !== f.name) for (const k of Object.keys(t.results)) if (k.startsWith(`${f.name}|`)) { t.results[`${name}|${k.split("|")[1]}`] = t.results[k]; delete t.results[k]; }
        return name ? {...f, name, grids} : null; }).filter(Boolean);
      const add = $("#df_add").value.trim();
      if (add && !floors.some(f => f.name === add)) floors.push({name: add, grids: 20});
      t.floors = floors.length ? floors : t.floors; t.updated = new Date().toISOString(); await dSave(); closeSheet(); render();
    };
  });
}

async function dasExport(t) {  // the columns the PC's Grid test import reads (das.py GRID_ALIASES)
  const rows = [["floor", "grid", "dl_dbm", "ul_dbm", "daq", "critical", "pass", "notes", "lat", "lon", "time"]];
  for (const f of t.floors) for (let g = 1; g <= f.grids; g++) {
    const r = t.results[`${f.name}|${g}`]; if (!r || (f.skip || []).includes(g)) continue;
    const p = dasPass(t, r);
    rows.push([f.name, g, r.dl ?? "", r.ul ?? "", r.daq ?? "", (f.critical || []).includes(g) ? "yes" : "", p == null ? "" : p ? "pass" : "fail", r.note || "", r.lat ?? "", r.lon ?? "", r.ts || ""]);
  }
  const text = rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n", file = new File([text], `${t.name} grid test.csv`.replace(/[\\/:*?"<>|]+/g, "-"), {type: "text/csv"});
  try { if (navigator.canShare?.({files: [file]})) { await navigator.share({files: [file], title: file.name}); return; } }
  catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Saved ${rows.length - 1} readings. On the PC: the DAS job, Grid test, Import results.`);
}

function dasPim() {
  return `<div class="card glass" style="--i:1"><h2>PIM calculator</h2>
    <div class="two"><div class="field"><label for="pm_f1">F1, MHz</label><input id="pm_f1" inputmode="decimal" value="869"></div>
      <div class="field"><label for="pm_f2">F2, MHz</label><input id="pm_f2" inputmode="decimal" value="894"></div></div>
    <div class="two"><div class="field"><label for="pm_t">Tone power, dBm each</label><input id="pm_t" inputmode="decimal" value="43"></div>
      <div class="field"><label for="pm_r">Measured PIM, dBm</label><input id="pm_r" inputmode="decimal" value="-110"></div></div>
    <div id="pm_out"></div>
    <p class="hint" style="margin:8px 0 0">A common system pass is −140 dBc at 2 × 43 dBm (Anritsu; Australian carriers' DAS spec); −150 dBc is the stricter target. −153 dBc is a part rating, not a system pass.</p></div>`;
}
function dasPimWire() {
  const go = () => {
    const f1 = parseFloat($("#pm_f1").value), f2 = parseFloat($("#pm_f2").value), tone = parseFloat($("#pm_t").value), res = parseFloat($("#pm_r").value);
    if (!isFinite(f1) || !isFinite(f2)) { $("#pm_out").innerHTML = ""; return; }
    const prods = [];
    for (let n = 3; n <= 9; n += 2) { const a = (n + 1) / 2, b = (n - 1) / 2;
      prods.push({n, e: `${a}F1 − ${b}F2`, f: a * f1 - b * f2}, {n, e: `${a}F2 − ${b}F1`, f: a * f2 - b * f1}); }
    const dbc = isFinite(tone) && isFinite(res) ? res - tone : null;
    $("#pm_out").innerHTML = (dbc != null ? `<p style="margin:4px 0 8px"><b style="font-size:20px;color:${dbc <= -140 ? "#3ccf7a" : "#e5534b"}">${num(dbc, 1)} dBc</b> <span class="hint">${dbc <= -150 ? "meets −150 dBc" : dbc <= -140 ? "meets −140 dBc" : "worse than −140 dBc"}</span></p>` : "")
      + prods.map(p => { const hits = DAS_RX.filter(([, lo, hi]) => p.f >= lo && p.f <= hi).map(([l]) => l);
        return `<div class="row" style="justify-content:space-between;padding:4px 0;border-top:1px solid var(--g-border)"><span>IM${p.n} <span class="hint">${p.e}</span></span>
          <span><b class="mono">${num(p.f, 3)}</b> <span style="color:${hits.length ? "#e5534b" : "var(--ink-2)"}">${hits.length ? esc(hits.join(", ")) : "no uplink"}</span></span></div>`; }).join("");
  };
  ["#pm_f1", "#pm_f2", "#pm_t", "#pm_r"].forEach(id => $(id).oninput = go);
  go();
}

function dasCodes() {
  const row = (k, v, src) => `<dt>${esc(k)}</dt><dd>${esc(v)}${src ? `<br><span class="hint">${esc(src)}</span>` : ""}</dd>`;
  return `<div class="card glass" style="--i:1"><h2>Coverage</h2><dl class="kv">
      ${row("Signal", "−95 dBm downlink and uplink, in 95% of each floor", "IFC 2021 510.4.1.1, NFPA 1225 (IFC 2024 and NFPA 1225 use DAQ only)")}
      ${row("Audio quality", "DAQ 3.0 both ways; design to 3.4", "NFPA 1225 ch. 18")}
      ${row("Critical areas", "99% (fire command, stairs, elevator lobbies, pump rooms…)", "NFPA 1225 ch. 18")}
      ${row("Grid", "20 squares a floor; floors over 128,000 sq ft in sectors of 20", "NFPA 1225 20.3.10")}</dl></div>
    <div class="card glass" style="--i:2"><h2>Signal boosters (47 CFR 90.219)</h2><dl class="kv">
      ${row("Power", "5 W ERP (37 dBm) per channel, both ways")}
      ${row("Uplink noise", "−43 dBm ERP per 10 kHz in band")}
      ${row("Noise figure", "9 dB or less")}
      ${row("Consent", "The licensee's written consent before it goes on the air")}</dl></div>
    <div class="card glass" style="--i:3"><h2>Design and acceptance</h2><dl class="kv">
      ${row("Isolation", "Donor to server at least the system gain + 20 dB", "NFPA 1225; warn under +20, fail under +15")}
      ${row("Uplink at the site", "−95 to −75 dBm per channel", "Orange County (CA) Sheriff; Durham NC under −80")}
      ${row("Uplink gain", "65 dB at most without the AHJ's approval", "OCSD, San Diego, Durham")}
      ${row("BDA noise at the site", "−150 dBm or less (Durham −153)", "OCSD, San Diego, Santa Clara")}
      ${row("Standby power", "12 hours at full load (24 h where the AHJ asks); low battery signal at 70% used", "NFPA 1225")}
      ${row("PIM", "−140 dBc at 2 × 43 dBm system pass; −150 dBc stricter", "Anritsu; carriers' DAS specs")}</dl>
    <p class="hint" style="margin:6px 0 0">The AHJ's own rules win. The full research, with every source, is in RF Recon on the PC (DAS, Data &amp; links).</p></div>`;
}

document.addEventListener("click", async e => {  // the DAS screen's buttons (app.js handles the rest)
  const a = e.target.closest("[data-act]"); if (!a || !a.dataset.act.startsWith("das")) return;
  const act = a.dataset.act, t = DAS.tests?.find(x => x.id === DAS.cur), f = t?.floors.find(x => x.name === DAS.floor);
  if (act === "dasview") { DAS.view = a.dataset.v; render(); }
  else if (act === "dasnew") dasNew();
  else if (act === "dasopen") { DAS.cur = a.dataset.id; DAS.floor = null; render(); }
  else if (act === "dasback") { DAS.cur = null; render(); }
  else if (act === "dasfloor") { DAS.floor = a.dataset.f; render(); }
  else if (act === "dassq" && t && f) dasSquare(t, f, +a.dataset.g);
  else if (act === "dasexport" && t) dasExport(t);
  else if (act === "dasfloors" && t) dasFloors(t);
  else if (act === "dasdel" && t) {
    const i = DAS.tests.indexOf(t); DAS.tests.splice(i, 1); DAS.cur = null; await dSave(); render();
    toast(`Deleted ${t.name}.`, async () => { DAS.tests.splice(i, 0, t); await dSave(); render(); });
  }
});
