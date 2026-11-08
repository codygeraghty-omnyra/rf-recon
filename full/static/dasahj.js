"use strict";
/* DAStastic — the AHJ side of a DAS job's report (lane A, 11/4): the acceptance tests beyond the grid (entered on the Grid
   test, printed on the report), the AHJ's own packet list checked against the job (static/research/ahj_packets.json,
   printed as the packet index), the tester's statement and signature with the independence statement, the calibration
   certificate register (Overview), and the sealed report: printed as final, the server keeps a SHA-256 of what printed
   and a verify code, which goes on every page. Needs das.js (DAS_ACCEPT, DASJ, floorStats, eff, scored, ulSquare,
   calOf, instKey, instName, instState, today, daysTo, dasPrintCopy, readingsOf, isCell, hasUl). */

const AHJ_SAY = {pass: ["pass", "#1a7f37"], fail: ["fail", "#cf222e"], "not done": ["not done", "#6e7781"]};
const ahjTests = d => ((d.acceptance || {}).tests) || {};
const ahjAddMonths = (d, m) => { if (!d) return ""; const t = new Date(d + "T12:00:00"); if (!isFinite(t)) return ""; t.setMonth(t.getMonth() + m); t.setDate(t.getDate() - 1); return ymd(t); };

/* ---------- acceptance tests (Grid test › Acceptance tests): DAS_ACCEPT, one row each ---------- */
window.dasAcceptPanel = (el, j, save) => {
  if (!el) return;
  const d = j.data || {}, T = ahjTests(d), who = (d.testing || {}).tester || "";
  const done = DAS_ACCEPT.filter(x => T[x.id] && T[x.id].status !== "not done").length;
  el.innerHTML = `<div class="panel" id="acPanel" style="margin-top:10px"><h3>Acceptance tests <span class="hint">· ${done} of ${DAS_ACCEPT.length} recorded · IFC 2021 510.5.4 (6)-(8), NFPA 1225 20.3.10.1.3; they print on the Report</span></h3>
    ${DAS_ACCEPT.map(x => { const t = T[x.id] || {}, st = t.status || "not done";
      return `<div class="ac-row" data-ac="${x.id}" style="border-top:1px solid var(--line);padding:7px 0">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${esc(x.label)}</b><span class="hint">${esc(x.cite)}</span></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:4px">
          <label>Result <select data-f="status">${DAS_ACCEPT_STATUS.map(s => `<option ${s === st ? "selected" : ""}>${s}</option>`).join("")}</select></label>
          <label>Value <input data-f="value" value="${esc(t.value ?? "")}" style="width:${x.id === "bda_identity" || x.id === "filters_agc" ? 220 : 100}px" placeholder="${x.id === "bda_identity" ? "maker model, serial, FCC ID, class" : ""}"></label>
          <label>Unit <input data-f="unit" value="${esc(t.unit ?? x.unit)}" style="width:64px"></label>
          <label class="grow" style="min-width:180px">Note <input data-f="note" value="${esc(t.note || "")}"></label>
          <label>By <input data-f="by" value="${esc(t.by ?? "")}" placeholder="${esc(who)}" style="width:130px"></label>
          <label>On <input data-f="at" type="date" value="${esc((t.at || "").slice(0, 10))}"></label></div>
        ${t.src && t.src !== "typed" ? `<div class="hint">Entered by ${esc(t.src)}</div>` : ""}</div>`; }).join("")}
    <p class="hint" style="margin:6px 0 0">A result with no date takes today's; with no name, the tester's from the Overview.</p></div>`;
  el.querySelectorAll(".ac-row").forEach(row => row.querySelectorAll("[data-f]").forEach(inp => inp.onchange = async () => {
    const id = row.dataset.ac, cur = ahjTests(j.data || {}), t = {...(cur[id] || {})};
    t[inp.dataset.f] = inp.value;
    if (!t.status) t.status = "not done";
    if (!t.at && t.status !== "not done") t.at = today();
    if (!t.by && t.status !== "not done") t.by = (j.data.testing || {}).tester || "";
    if (!t.unit) t.unit = (DAS_ACCEPT.find(x => x.id === id) || {}).unit || "";
    t.src = "typed";
    j = await save({acceptance: {...(j.data.acceptance || {}), tests: {...cur, [id]: t}}});
    window.dasAcceptPanel(el, j, save); }));
};
// the printed section
function ahjAcceptHtml(d){
  const T = ahjTests(d), n = DAS_ACCEPT.filter(x => T[x.id] && T[x.id].status !== "not done").length;
  return `<div style="margin-top:16px;break-inside:auto"><h3>Acceptance tests <span style="font-weight:400;font-size:12px">· ${n} of ${DAS_ACCEPT.length} recorded · IFC 2021 510.5.4 (6)-(8); NFPA 1225-2022 20.3.10.1.3 (8)-(11)</span></h3>
    <table><thead><tr><th>Test</th><th style="white-space:nowrap">Result</th><th class="n" style="white-space:nowrap">Value</th><th style="white-space:nowrap;min-width:4em">Note</th><th>By, on</th><th>Code</th></tr></thead><tbody>${DAS_ACCEPT.map(x => { const t = T[x.id] || {}, s = AHJ_SAY[t.status] || AHJ_SAY["not done"];
      return `<tr><td>${esc(x.label)}</td><td style="color:${s[1]};font-weight:600;white-space:nowrap">${s[0]}</td><td class="n" style="white-space:nowrap">${esc([t.value, t.value !== "" && t.value != null ? t.unit : ""].filter(v => v != null && v !== "").join(" "))}</td><td>${esc(t.note || "")}</td><td>${esc([t.by, (t.at || "").slice(0, 10)].filter(Boolean).join(", "))}</td><td style="font-size:11px">${esc(x.cite)}</td></tr>`; }).join("")}</tbody></table></div>`;
}

/* ---------- calibration certificate register (Overview › Testing) ---------- */
// state of an instrument's certificate: expired, expiring within 30 days, current, or none on file
function ahjCertState(i, files){
  const exp = i.expires || ahjAddMonths(i.cal, DAS.cal_months), left = exp ? daysTo(exp) : null, has = i.cert && (!files || files.includes(i.cert));
  if (exp && left < 0) return {k: "bad", t: `expired ${exp}`, exp, left, has};
  if (exp && left <= 30) return {k: "warn", t: `expires ${exp}, in ${left} day${left === 1 ? "" : "s"}`, exp, left, has};
  if (!has) return {k: "warn", t: i.cert ? `certificate ${i.cert} isn't in Files` : "no certificate on file", exp, left, has};
  return {k: "good", t: exp ? `current to ${exp}` : "current", exp, left, has};
}
window.dasCertRegister = async (el, j, savePatch) => {
  if (!el) return;
  const insts = (j.data.testing || {}).instruments || [];
  if (!insts.length) { el.innerHTML = ""; return; }
  const files = ((await api(`/api/das/jobs/${j.id}/files`).catch(() => ({files: []}))).files || []).map(f => f.name);
  if (!el.isConnected) return;
  const docs = files.filter(n => /\.(pdf|png|jpe?g|webp|gif|heic)$/i.test(n));
  el.innerHTML = `<div style="margin-top:10px"><b>Calibration certificates</b> <span class="hint">· each instrument's certificate from the job's Files goes into the AHJ packet download; warned 30 days before it expires</span>
    ${insts.map((i, k) => { const s = ahjCertState(i, files);
      return `<div class="row" data-ci="${k}" style="gap:8px;flex-wrap:wrap;align-items:flex-end;border-top:1px solid var(--line);padding:6px 0">
        <span style="min-width:150px"><b>${esc(instName(i))}</b><div class="hint">calibrated ${esc(i.cal || "–")}</div></span>
        <label>Certificate <select data-c="cert" style="max-width:220px"><option value="">— none —</option>${docs.map(n => `<option ${n === i.cert ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <label title="The certificate's own due date. Empty: ${DAS.cal_months} months from the calibration date">Expires <input data-c="expires" type="date" value="${esc(i.expires || "")}"></label>
        <span class="tag" style="color:${s.k === "bad" ? "var(--bad)" : s.k === "warn" ? "var(--warn)" : "var(--good)"}">${esc(s.t)}</span></div>`; }).join("")}
    ${docs.length ? "" : '<p class="hint" style="margin:4px 0 0">Add the certificate PDFs under Files, then pick each one here.</p>'}</div>`;
  el.querySelectorAll("[data-ci] [data-c]").forEach(inp => inp.onchange = () => {
    const k = +inp.closest("[data-ci]").dataset.ci, list = insts.map((x, n) => n === k ? {...x, [inp.dataset.c]: inp.value} : x);
    savePatch({testing: {...(j.data.testing || {}), instruments: list}}); });
};

/* ---------- the AHJ packet: each item the AHJ lists, where the job fills it ---------- */
// which recorded kinds (intake.py KINDS) satisfy a file item, by the item's own name pattern in ahj_packets.json. A kind is an exact
// match: testing the pattern against a label would let "PE" find "spec sheet". tests/test_intake.py keeps this whole
const AHJ_FILE_KINDS = {
  "as.?built": ["as_built"], "photo|\\.jpe?g$|\\.png$|\\.heic$": ["photo"], "rebroadcast|retransmi": ["rebroadcast"], "maint": ["maintenance"], "permit": ["permit"],
  "seal|stamp": ["sealed_drawings"], "\\.zip$|audio|\\.wav$|\\.mp3$": ["audio"], "b-?03": ["b03"], "sequence": ["sequence"], "seal|stamp|PE": ["sealed_drawings"],
  "pass.?through|alignment": ["pass_through"], "survey information": ["survey_info"], "operator|pctel|anritsu": ["operator_cert"], "sweep": ["sweep"], "stamp|seal": ["sealed_drawings"],
  "DIT|design approval": ["design_approval"]};
let AHJ_PACKETS = null;
const ahjPackets = () => AHJ_PACKETS || (AHJ_PACKETS = fetch("static/research/ahj_packets.json")  /* relative: the web version serves the app under full/ */.then(r => { if (!r.ok) throw new Error(`the AHJ packet lists didn't load (${r.status})`); return r.json(); }).catch(e => { AHJ_PACKETS = null; throw e; }));
// fill key: where to fill it in the app (app), where it sits in the printed packet (pk), and whether the job has it (ok)
const AHJ_FILL = {
  building: {app: "Overview › Building: address, floors, area", pk: "Report: Building and people", ok: c => !!(c.d.address && c.floors.length && c.d.area_sqft)},
  grol: {app: "Overview › Testing: FCC GROL", pk: "Report: Tester and instruments", ok: c => !!c.T.grol},
  nicet: {app: "Overview › Testing: NICET", pk: "Report: Tester and instruments", ok: c => !!c.T.nicet},
  systems: {app: "Pre-survey: choose the systems", pk: "Report: Systems covered", ok: c => c.plan.length > 0},
  donor: {app: "Pre-survey: systems and the building's location", pk: "Design submittal: donor aiming sheet", ok: c => c.plan.length > 0 && c.d.lat != null},
  link_budget: {app: "Design › link budget (needs the Pre-survey systems)", pk: "Design submittal §2", ok: c => typeof dsBands === "function" && dsBands(c.d).length > 0},
  heat_maps: {app: "Design › antennas on every floor", pk: "Design submittal §3", ok: c => c.floors.length > 0 && c.floors.every(f => ((((c.d.design || {}).floors || {})[f.name] || {}).antennas || []).length > 0)},
  schematic: {app: "Materials › bill of materials", pk: "Report: System diagram", ok: c => (c.d.bom || []).length > 0},
  bom: {app: "Materials › bill of materials", pk: "Design submittal §4", ok: c => (c.d.bom || []).length > 0},
  spec_sheets: {app: "Materials › Build spec sheets", pk: "Attached: spec sheets", ok: c => c.files.some(n => /^Spec sheet - /.test(n) || (c.kinds || {})[n] === "spec_sheet")},
  battery_calc: {app: "Design › Battery", pk: "Design submittal §5", ok: c => ((((c.d.design || {}).battery) || {}).items || []).length > 0},
  test_plan: {app: "Overview: floors (Grid test squares)", pk: "Design submittal §7", ok: c => c.floors.length > 0},
  grid: {app: "Grid test: every square", pk: "Report: floor pages", ok: c => c.st.length > 0 && c.st.every(x => x.untested === 0)},
  grid_plan: {app: "Grid test: a floor plan under every floor's grid, every square tested", pk: "Report: floor pages, grid on the plan", ok: c => c.st.length > 0 && c.floors.every(f => f.plan) && c.st.every(x => x.untested === 0)},
  ul_grid: {app: "Grid test: an uplink reading in every square", pk: "Report: floor tables, UL columns", ok: c => c.st.length > 0 && c.st.every(x => x.untested === 0) && c.ulAll},
  critical: {app: "Requirements: critical areas, then their readings on the Grid test", pk: "Report: Named critical areas", ok: c => (c.crit.length > 0 && c.crit.every(a => scored(c.d, c.cr[a]) != null)) || (!c.crit.length && c.floors.some(f => (f.critical || []).length))},
  instruments: {app: "Overview › Testing: instruments with calibration dates", pk: "Report: Tester and instruments", ok: c => c.insts.length > 0 && c.insts.every(i => instState(i).ok)},
  cal_cert: {app: "Overview › Calibration certificates", pk: "Attached: calibration certificates", ok: c => c.insts.length > 0 && c.insts.every(i => i.cert && c.files.includes(i.cert) && ahjCertState(i, c.files).k !== "bad")},
  signoff: {app: "Report › Sign the report", pk: "Report: Tester's statement", ok: c => !!(c.so.name && c.so.date)},
  third_party: {app: "Report › Sign the report: independence statement", pk: "Report: Tester's statement (independence)", ok: c => !!(c.so.name && c.so.independent)},
  consent: {app: "Overview › Compliance: licensee consent date", pk: "Report: Compliance", ok: c => !!(c.d.checks || {}).consent},
  fcc_reg: {app: "Overview › Compliance: FCC registration (Class B)", pk: "Report: Compliance", ok: c => /^Class A/.test(c.d.booster_class || "Class A") || !!(c.d.checks || {}).fcc_reg},
};
function ahjCtx(d, files){
  const floors = Array.isArray(d.floors) ? d.floors : [], st = floors.map(f => floorStats(d, f)), res = (d.grid || {}).results || {};
  // every tested square holds a counted uplink reading (whatever the profile asks: the AHJ's list asks it)
  const ulAll = floors.every(f => { const skip = new Set(f.skip || []); for (let g = 1; g <= (f.grids || DAS.grids); g++) { if (skip.has(g)) continue;
    const r = eff(d, res[`${f.name}|${g}`]); if (!r || !(Array.isArray(r.readings) ? r.readings : [r]).some(x => x && !isCell(x) && hasUl(x) && calOf(d, x)?.ok)) return false; } return true; });
  return {d, files, floors, st, ulAll, T: d.testing || {}, insts: (d.testing || {}).instruments || [], plan: (d.presurvey || {}).plan || [], so: d.signoff || {},
    crit: [...((d.require || {}).critical || []), ...((d.require || {}).other || [])], cr: (d.grid || {}).critical || {}};
}
// one item: ok / missing / outside, with where it is (printed) and where to fill it (on screen)
function ahjItem(x, c){
  if (x.outside) return {state: "outside", pk: "Outside this packet", app: "Done outside the packet"};
  if (x.file) { let re; try { re = new RegExp(x.file, "i"); } catch (e) { re = /$^/; }
    const want = AHJ_FILE_KINDS[x.file] || [], hit = c.files.find(n => want.includes((c.kinds || {})[n])) || c.files.find(n => re.test(n));
    return hit ? {state: "ok", pk: `Attached: ${hit}`, app: `Files: ${hit}`} : {state: "missing", pk: "Not attached", app: `Files: add ${x.hint || "the document"}`}; }
  if (x.fill && x.fill.startsWith("acc:")) { const id = x.fill.slice(4), t = ahjTests(c.d)[id], a = DAS_ACCEPT.find(y => y.id === id);
    const ok = t && (t.status === "pass" || t.status === "fail");
    return {state: ok ? "ok" : "missing", pk: ok ? `Report: Acceptance tests (${t.status})` : "Not recorded", app: `Grid test › Acceptance tests: ${a ? a.label : id}`}; }
  const F = AHJ_FILL[x.fill];
  if (!F) return {state: "missing", pk: "Not recorded", app: x.fill || "?"};
  const ok = !!F.ok(c);
  return {state: ok ? "ok" : "missing", pk: ok ? F.pk : "Missing", app: F.app};
}
const ahjPacketKey = (d, P) => d.packet_ahj && P.packets[d.packet_ahj] ? d.packet_ahj : DASJ.packet && P.packets[DASJ.packet] ? DASJ.packet : "nfpa1225";
// files: names, or the Files route's own rows, which also say what each file is
function ahjPacketRows(d, P, files){
  const names = files.map(f => typeof f === "string" ? f : f.name), key = ahjPacketKey(d, P), pk = P.packets[key], c = ahjCtx(d, names);
  c.kinds = Object.fromEntries(files.filter(f => f && f.kind).map(f => [f.name, f.kind]));
  return {key, pk, rows: pk.items.map(x => ({...x, ...ahjItem(x, c)}))};
}
function ahjPacketHtml(R){
  const part = p => R.rows.filter(x => x.part === p);
  const tbl = (rows, title) => rows.length ? `<h4 style="margin:8px 0 4px">${title}</h4><table><thead><tr><th class="n" style="white-space:nowrap;width:2.4em">#</th><th>Item</th><th>Section</th><th>Where it is</th></tr></thead><tbody>${rows.map((x, i) =>
    `<tr><td class="n" style="white-space:nowrap">${i + 1}</td><td>${esc(x.t)}</td><td style="font-size:11px">${esc(x.s)}</td><td style="${x.state === "missing" ? "color:#cf222e;font-weight:600" : x.state === "outside" ? "color:#6e7781" : ""}">${esc(x.pk)}</td></tr>`).join("")}</tbody></table>` : "";
  const miss = R.rows.filter(x => x.state === "missing").length;
  return `<div style="margin:10px 0 14px"><h3 style="margin-bottom:2px">Packet index: ${esc(R.pk.name)}</h3>
    <p style="margin:0 0 4px;font-size:12px">${esc(R.pk.doc)} · <a href="${esc(R.pk.url)}">${esc(R.pk.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a>${miss ? ` · <b style="color:#cf222e">${miss} item${miss === 1 ? "" : "s"} missing</b>` : " · every item is in the packet"}</p>
    ${tbl(part("a"), "Acceptance test report")}${tbl(part("d"), "Design submittal")}</div>`;
}

/* ---------- the tester's statement, signature and independence (Report) ---------- */
const AHJ_STATEMENT = (d, j) => typeof dasCellOnly === "function" && dasCellOnly(d)
  ? `I tested this building's commercial cellular coverage${(d.testing || {}).date ? ` on ${[d.testing.date, d.testing.date2].filter(Boolean).join(" to ")}` : ""} with the calibrated instruments listed in this report, against ${d.code || "the owner's carrier requirements"}. The results are the readings taken; none were changed.`
  : `I tested this emergency responder radio coverage system${(d.testing || {}).date ? ` on ${[d.testing.date, d.testing.date2].filter(Boolean).join(" to ")}` : ""} with the calibrated instruments listed in this report, to ${d.code || "IFC 510 and NFPA 1225"}${d.ahj ? ` as ${d.ahj} applies them` : ""}. The results are the readings taken; none were changed.`;
const AHJ_INDEPENDENT = "I am independent of this system's designer and installer: neither I nor my employer designed, sold or installed it, and neither has a financial interest in its acceptance.";
function ahjSignHtml(d, j){
  const s = d.signoff || {};
  return `<div style="margin-top:18px;break-inside:avoid;border-top:1px solid #999;padding-top:8px"><h3 style="margin:0 0 6px">Tester's statement</h3>
    <p style="margin:0 0 6px">${esc(s.statement || AHJ_STATEMENT(d, j))}</p>
    ${s.independent ? `<p style="margin:0 0 6px"><b>Independence.</b> ${esc(s.independence || AHJ_INDEPENDENT)}</p>` : DASJ.third_party ? `<p style="margin:0 0 6px;color:#cf222e"><b>This AHJ requires a third-party tester${DASJ.cite?.third_party ? ` (${esc(DASJ.cite.third_party)})` : ""}: no independence statement is signed.</b></p>` : ""}
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
      <div><div style="min-width:220px;height:56px;border-bottom:1px solid #000;display:flex;align-items:flex-end">${s.sig ? `<img src="${esc(s.sig)}" alt="Signature" style="max-height:54px;max-width:260px">` : ""}</div><div style="font-size:11px">Signature</div></div>
      <div><div style="min-width:200px;border-bottom:1px solid #000;padding:2px 0">${esc([s.name, s.title].filter(Boolean).join(", ")) || "&nbsp;"}</div><div style="font-size:11px">Name${s.company ? `, ${esc(s.company)}` : ""}</div></div>
      <div><div style="min-width:110px;border-bottom:1px solid #000;padding:2px 0">${esc(s.date || "") || "&nbsp;"}</div><div style="font-size:11px">Date</div></div></div></div>`;
}
function ahjSignForm(box, j, done){
  const d = j.data || {}, s = d.signoff || {}, T = d.testing || {};
  box.innerHTML = `<div class="panel" style="margin:8px 0"><h3 style="margin-top:0">Sign the report <span class="hint">· typed name and date, the statement, and a signature if you draw one</span></h3>
    <div class="row" style="gap:8px;flex-wrap:wrap"><label class="grow">Name<input id="sgName" value="${esc(s.name || T.tester || "")}"></label><label>Title<input id="sgTitle" value="${esc(s.title || "")}" style="width:160px"></label>
      <label class="grow">Company<input id="sgCo" value="${esc(s.company || "")}"></label><label>Date<input id="sgDate" type="date" value="${esc(s.date || today())}"></label></div>
    <label style="margin-top:6px;display:block">Statement<textarea id="sgText" rows="3" style="width:100%">${esc(s.statement || AHJ_STATEMENT(d, j))}</textarea></label>
    <label class="inl" style="display:flex;gap:6px;margin-top:6px;align-items:flex-start"><input type="checkbox" id="sgInd" ${s.independent ? "checked" : ""} style="margin-top:3px"> <span>${esc(AHJ_INDEPENDENT)}${DASJ.third_party ? ` <b style="color:var(--warn)">This AHJ requires a third-party tester.</b>` : ""}</span></label>
    <div style="margin-top:8px"><span class="hint">Signature (draw with a mouse, pen or finger)</span>
      <canvas id="sgPad" style="display:block;width:100%;max-width:420px;height:110px;border:1px solid var(--line);border-radius:10px;background:#fff;touch-action:none;cursor:crosshair"></canvas>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap"><button id="sgClear">Clear signature</button><button class="primary" id="sgSave">Save</button><button id="sgX">Cancel</button><span class="hint" id="sgMsg"></span></div></div></div>`;
  const cv = box.querySelector("#sgPad"), ctx = cv.getContext("2d"); let drawn = false, last = null;
  const size = () => { const r = cv.getBoundingClientRect(), k = window.devicePixelRatio || 1; cv.width = Math.round(r.width * k); cv.height = Math.round(r.height * k); ctx.setTransform(k, 0, 0, k, 0, 0); ctx.lineWidth = 2.2; ctx.lineCap = ctx.lineJoin = "round"; ctx.strokeStyle = "#111"; };
  size();
  if (s.sig) { const im = new Image(); im.onload = () => { const r = cv.getBoundingClientRect(); ctx.drawImage(im, 0, 0, r.width, r.height); drawn = true; }; im.src = s.sig; }
  const at = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); last = at(e); e.preventDefault(); };
  cv.onpointermove = e => { if (!last) return; const p = at(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; drawn = true; };
  cv.onpointerup = cv.onpointercancel = () => { last = null; };
  box.querySelector("#sgClear").onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); drawn = false; };
  box.querySelector("#sgX").onclick = () => { box.innerHTML = ""; };
  box.querySelector("#sgSave").onclick = async () => { const name = box.querySelector("#sgName").value.trim(), date = box.querySelector("#sgDate").value;
    if (!name || !date) { box.querySelector("#sgMsg").textContent = "A name and a date sign the report."; return; }
    // the signature as a small PNG, trimmed of nothing: 420 x 110 at most, so the job stays light
    let sig = "";
    if (drawn) { const out = document.createElement("canvas"), r = cv.getBoundingClientRect(); out.width = Math.min(420, Math.round(r.width)); out.height = Math.round(out.width * r.height / r.width);
      out.getContext("2d").drawImage(cv, 0, 0, out.width, out.height); sig = out.toDataURL("image/png"); }
    const so = {name, title: box.querySelector("#sgTitle").value.trim(), company: box.querySelector("#sgCo").value.trim(), date, statement: box.querySelector("#sgText").value.trim(),
      independent: box.querySelector("#sgInd").checked, independence: AHJ_INDEPENDENT, sig, at: new Date().toISOString()};
    try { await post(`/api/das/jobs/${j.id}`, {data: {signoff: so}}); done(); } catch (e) { box.querySelector("#sgMsg").textContent = "Not saved: " + e.message; } };
}

/* ---------- the sealed report ---------- */
// what is sealed: the printed report's text, whitespace evened out (the plans and signature are images: the job data's
// own hash covers them)
const ahjSealText = el => { const off = [...el.querySelectorAll(".no-print")], was = off.map(x => x.style.display);  // what doesn't print isn't sealed: a dropped PDF is checked against this, letter by letter (das.py seal_of_pdf)
  off.forEach(x => { x.style.display = "none"; });
  const t = (el.innerText || el.textContent || "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  off.forEach((x, i) => { x.style.display = was[i]; });
  return t; };
window.dasSealPrint = async (el, j) => {
  const src = el.querySelector("#dasPrint"); if (!src) return;
  const r = await post("/api/das/seal", {job_id: j.id, title: (src.querySelector("h2") || {}).textContent || "Report", result: (src.querySelector(".res-pass,.res-fail") || {}).textContent || "not complete", text: ahjSealText(src)});
  // the code and date on every page: CSS page margin boxes (Chrome 131+), and once at the end for any other browser
  const foot = `Sealed ${r.at.slice(0, 10)} · verify code ${r.code} · SHA-256 ${r.sha256.slice(0, 16)}`;
  const css = document.createElement("style"); css.id = "ahjSealCss";
  css.textContent = `@page{margin:14mm 12mm 16mm;@bottom-left{content:${JSON.stringify(foot)};font:9px sans-serif;color:#333}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:9px sans-serif;color:#333}}`;
  document.head.appendChild(css);
  const tail = document.createElement("p"); tail.className = "ahj-seal-tail"; tail.style.cssText = "margin-top:14px;font-size:11px;border-top:1px solid #999;padding-top:6px";
  tail.textContent = `${foot}. Sealed copy of this report kept with the job; a changed job no longer matches it.`;
  src.appendChild(tail);
  // the next step is on the page before the print window opens, and stays there until the PDF is filed. A browser won't hand a print to the
  // page, so the shortest way is: the name filled in (Save as PDF offers the page's title), then one drop or one press
  await ahjSealList($("#apSeals"), j).catch(() => {});
  $("#apNext")?.scrollIntoView({ block: "center" });
  await new Promise(ok => setTimeout(ok, 60));
  const title = document.title; if (r.file) document.title = r.file.replace(/\.pdf$/i, "");
  dasPrintCopy(src);
  setTimeout(() => { tail.remove(); css.remove(); document.title = title; }, 600);
  return r;
};
function ahjSealList(box, j){
  return api(`/api/das/seal?job=${j.id}`).then(r => { if (!box || !box.isConnected) return; const s = r.seals || [], wait = s[0] && !s[0].file && !s[0].changed ? s[0] : null;
    const where = x => x.packet ? " · PDF in Files and the packet" : x.file && x.changed ? " · PDF left out of the packet" : x.file ? " · PDF in Files" : "";
    box.innerHTML = `${wait ? `<div class="ap-next" id="apNext"><b>Next: file the PDF</b><ol><li>In the print window, pick <b>Save as PDF</b>. The name is filled in for you.</li><li>Drop the saved PDF anywhere on this page, or press Choose the PDF.</li></ol>
        <p class="hint">DAStastic checks its verify code, <span class="mono">${esc(wait.code)}</span>, then files it on this job, adds it to the AHJ packet and ticks it in the email box. Nothing is sent.</p>${window.intakePick ? `<button class="primary" id="apPdf">Choose the PDF</button>` : ""}</div>` : ""}
      ${s.length ? `<div class="hint" style="margin:6px 2px">Sealed: ${s.slice(0, 6).map(x => `<span class="mono">${esc(x.code)}</span> ${esc(x.at.slice(0, 16))}${where(x)}${x.changed ? ' <b style="color:var(--warn)">job changed since</b>' : ""}`).join(" · ")}${s.length > 6 ? ` · ${s.length - 6} earlier` : ""}</div>` : ""}`;
    const b = box.querySelector("#apPdf"); if (b) b.onclick = () => window.intakePick(j.id); }).catch(() => {});
}
// Verify a report (DAS board): what was sealed under a code, and whether the job changed since
window.dasVerifyBox = el => {
  if (!el) return;
  if (el.innerHTML) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="panel"><h3 style="margin-top:0">Verify a report <span class="hint">· the code printed in a sealed report's footer</span></h3>
    <div class="row" style="gap:8px;flex-wrap:wrap"><input id="vfCode" placeholder="e.g. 7K2M-QX4D" style="width:180px;font-family:var(--mono,monospace);text-transform:uppercase"><button class="primary" id="vfGo">Verify</button><button id="vfX">Close</button></div>
    <div id="vfOut" style="margin-top:8px"></div></div>`;
  const go = async () => { const code = $("#vfCode").value.trim(), out = $("#vfOut"); if (!code) { $("#vfCode").focus(); return; }
    out.innerHTML = '<p class="hint">Checking…</p>';
    try { const v = await api(`/api/das/seal/verify?code=${encodeURIComponent(code)}`);
      if (!v.found) { out.innerHTML = `<p class="status err">No sealed report has the code ${esc(code.toUpperCase())}.</p>`; return; }
      out.innerHTML = `<div class="kvg"><div>Code</div><div class="mono">${esc(v.code)}</div><div>Report</div><div>${esc(v.title)}</div><div>Job</div><div>${esc(v.job_name || `job ${v.job_id}`)}${v.job_deleted ? ' <b style="color:var(--bad)">deleted since</b>' : ""}</div>
        <div>Result</div><div>${esc(v.result)}</div><div>Sealed</div><div>${esc(v.at)}${v.by ? ` by ${esc(v.by)}` : ""}</div><div>SHA-256</div><div class="mono" style="overflow-wrap:anywhere">${esc(v.sha256)}</div>
        <div>Sealed text</div><div>${v.content_ok ? '<span style="color:var(--good)">matches its hash</span>' : '<b style="color:var(--bad)">doesn\'t match its hash</b>'}</div>
        <div>Job since</div><div>${v.job_deleted ? "deleted" : v.job_changed ? `<b style="color:var(--warn)">changed</b> (last saved ${esc(v.job_updated || "")}): ${esc((v.changes || []).slice(0, 12).join(", "))}${(v.changes || []).length > 12 ? ` and ${v.changes.length - 12} more` : ""}` : '<span style="color:var(--good)">unchanged</span>'}</div></div>
        <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">What was sealed (the report's text)</summary><pre style="white-space:pre-wrap;max-height:320px;overflow:auto;font-size:12px">${esc(v.content)}</pre></details>
        ${!v.job_deleted ? `<button style="margin-top:6px" id="vfOpen">Open the job</button>` : ""}`;
      $("#vfOpen") && ($("#vfOpen").onclick = () => { S.das.job = v.job_id; S.das.sub = "report"; render(); });
    } catch (e) { out.innerHTML = `<p class="status err">${esc(e.message)}</p>`; } };
  $("#vfGo").onclick = go; $("#vfCode").onkeydown = e => { if (e.key === "Enter") go(); }; $("#vfX").onclick = () => { el.innerHTML = ""; };
  $("#vfCode").focus();
};

/* ---------- the report's AHJ parts: packet index, acceptance tests, sign-off, seal ---------- */
window.dasReportAhj = async (el, j) => {
  const d = j.data || {}, top = el.querySelector("#drAhjTop"), acc = el.querySelector("#drAccept"), sign = el.querySelector("#drSign"), pkBox = el.querySelector("#drPacket");
  const cellOnly = typeof dasCellOnly === "function" && dasCellOnly(d);
  if (acc) acc.innerHTML = cellOnly ? "" : ahjAcceptHtml(d);  // IFC 510.5.4 / NFPA 1225 tests: public safety only
  if (sign) sign.innerHTML = ahjSignHtml(d, j);
  if (cellOnly) {  // a cellular job: no AHJ ERCES packet; the sign-off and the seal still apply
    if (pkBox) pkBox.innerHTML = "";
    if (!top) return;
    top.innerHTML = `<div class="panel" style="margin:8px 0"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <span class="hint">A cellular job: judged per carrier against its target; the emergency responder packet and acceptance tests don't apply.</span>
      <button id="apSign">${d.signoff?.name ? "✎ Edit the signature" : "✎ Sign the report"}</button></div><div id="apSignBox"></div><div id="apSeals"></div></div>`;
    $("#apSign").onclick = () => ahjSignForm($("#apSignBox"), j, () => render());
    ahjSealList($("#apSeals"), j);
    const fin = el.querySelector("#drFinal");
    if (fin) fin.onclick = async () => { fin.disabled = true;
      try { const r = await window.dasSealPrint(el, j); ahjSealList($("#apSeals"), j); if (r) dasSay(`Sealed: verify code ${r.code}`); }
      catch (e) { dasSay(`Not sealed: ${e.message}`); } finally { fin.disabled = false; } };
    return;
  }
  let P, files;
  try { [P, files] = await Promise.all([ahjPackets(), api(`/api/das/jobs/${j.id}/files`).then(r => r.files || []).catch(() => [])]); }
  catch (e) { if (top) top.innerHTML = `<p class="status err">${esc(e.message)}</p>`; return; }
  if (!el.isConnected) return;
  const R = ahjPacketRows(d, P, files), miss = R.rows.filter(x => x.state === "missing");
  if (pkBox) pkBox.innerHTML = ahjPacketHtml(R);
  if (!top) return;
  const missA = miss.filter(x => x.part === "a"), missD = miss.filter(x => x.part === "d");
  const list = rows => rows.map(x => `<li><b>${esc(x.t)}</b> <span class="hint">(${esc(x.s)})</span>: ${esc(x.app)}</li>`).join("");
  top.innerHTML = `<div class="panel" style="margin:8px 0"><div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <label class="inl">AHJ packet <select id="apPick">${Object.entries(P.packets).map(([k, v]) => `<option value="${esc(k)}" ${k === R.key ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
      <span class="row" style="gap:8px;flex-wrap:wrap"><button id="apSign">${d.signoff?.name ? "✎ Edit the signature" : "✎ Sign the report"}</button><button id="apZip" title="The bill of materials, every spec sheet, every calibration certificate and the sealed report's PDF, in one zip">⇩ Packet files (zip)</button></span></div>
    ${miss.length ? `<p class="status err" style="margin:8px 0 4px"><b>Missing before you print: ${miss.length} of ${R.rows.length}</b> items ${esc(R.pk.name)} lists.</p>
      ${missA.length ? `<b>Acceptance report</b><ul style="margin:2px 0 6px">${list(missA)}</ul>` : ""}${missD.length ? `<details><summary style="cursor:pointer"><b>Design submittal</b> (${missD.length})</summary><ul style="margin:2px 0 6px">${list(missD)}</ul></details>` : ""}`
      : `<p class="status" style="margin:8px 0 4px">Every item ${esc(R.pk.name)} lists is in the packet.</p>`}
    ${DASJ.tool_lock ? `<p class="status err" style="margin:4px 0">${esc(DASJ.tool_lock)}</p>` : ""}
    <p class="hint" style="margin:4px 0 0">The packet index prints at the top of the report. ${esc(R.pk.doc)}, ${esc(R.pk.checked)}. Acceptance tests are entered on the Grid test.</p>
    <div id="apSignBox"></div><div id="apSeals"></div></div>`;
  $("#apPick").onchange = async e => { await post(`/api/das/jobs/${j.id}`, {data: {packet_ahj: e.target.value}}); render(); };
  $("#apSign").onclick = () => ahjSignForm($("#apSignBox"), j, () => render());
  $("#apZip").onclick = () => { const a = document.createElement("a"); a.href = `/api/das/jobs/${j.id}/packet`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); };
  ahjSealList($("#apSeals"), j);
  const fin = el.querySelector("#drFinal");
  if (fin) fin.onclick = async () => {
    if (miss.length && !confirm(`${miss.length} item${miss.length === 1 ? " is" : "s are"} missing from the ${R.pk.name} packet. Seal and print anyway?`)) return;
    fin.disabled = true;
    try { const r = await window.dasSealPrint(el, j); ahjSealList($("#apSeals"), j); if (r) dasSay?.(`Sealed: verify code ${r.code}`); }
    catch (e) { dasSay(`Not sealed: ${e.message}`); }
    finally { fin.disabled = false; } };
};
