"use strict";
/* RF Recon — DAS jobs: in-building public safety radio (ERCES / ERRCS / BDA / public safety DAS) from lead to annual
   retest. A board of jobs by stage, each job with its building, contacts and compliance dates, a pre-survey from the
   FCC data (agency systems, downlink and uplink channels, donor sites, levels inside), the code requirements, a grid
   test per floor (over the floor plan when there is one), files, a log and a report for the AHJ. Any tool's results
   come in as CSV, TSV, Excel, JSON, KML/KMZ or GPX; everything goes out as CSV, JSON, KML, vCard, ATAK or print. */

/* ---------- the numbers (set in one place; see DAS_SOURCES for where each comes from) ---------- */
const DAS = {
  threshold: -95,            // dBm, minimum signal at each test location (IFC 510 / NFPA 1225 default; AHJs may change it)
  daq: 3.0,                  // delivered audio quality, minimum, downlink and uplink (NFPA 1225 ch. 18)
  sinr: 18, ber: 2.5,        // measured equivalent of DAQ 3.0 for P25: SINR >= 18 dB with BER <= 2.5% (NFPA 1225 A.20.3.10)
  general_pct: 95,           // % of general building areas that must pass (NFPA 1225 ch. 18; older NFPA 72 used 90)
  critical_pct: 99,          // % of critical areas that must pass
  grids: 20,                 // grid squares per floor (NFPA 1225 ch. 18)
  cell_ft: [20, 80],         // each grid square 20-80 ft across; floors over 128,000 sq ft are split into sectors
  sector_sqft: 128000,
  battery_h: 12,             // standby hours at 100% capacity (NFPA 1225 / IFC; some AHJs 24)
  cal_months: 12,            // a test instrument's calibration counts for 12 months from its date (the usual annual cycle; check the AHJ)
  critical_areas: ["Fire command center", "Fire pump room", "Exit stairs", "Exit passageways", "Elevator lobbies",
    "Standpipe cabinets", "Sprinkler sectional valve locations", "Other areas the AHJ designates"],
  // building entry loss, ITU-R P.2109-2 at 770-850 MHz, outer wall only (VHF is close: 14/26 and 37/55 dB)
  loss: {"Traditional build, typical (14 dB)": 14, "Traditional build, worst 5% (28 dB)": 28,
    "Thermally efficient (low-E glass, foil insulation), typical (31 dB)": 31, "Thermally efficient, worst 5% (51 dB)": 51,
    "Deep interior or below grade (50 dB)": 50},
};
// the app's bands (uls_import.BANDS), so uplinks count in their own band; 700 MHz holds 799-805 up, 800 MHz 806-824 up
const DAS_BANDS = [[0,30,"HF"],[30,50,"VHF Low"],[50,54,"6m"],[54,72,"VHF TV low"],[72,76,"72-76 MHz"],[76,108,"FM broadcast"],[108,137,"Aviation VHF"],
  [137,174,"VHF High"],[174,216,"VHF TV/Aux"],[216,225,"220 MHz"],[225,400,"Gov UHF/Other"],[400,470,"UHF"],[470,512,"UHF T-Band"],[512,698,"UHF TV/Aux"],
  [698,806,"700 MHz"],[806,896,"800 MHz"],[896,960,"900 MHz"],[960,1e9,"Above 960 MHz"]];
const dasBand = f => (DAS_BANDS.find(([lo,hi])=>f>=lo&&f<hi)||[0,0,"Other"])[2];
// where the numbers come from (the full research, with every source, is the DAS research database in Drive)
const DAS_SOURCES = `Sources: <a href="https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download" target="_blank" rel="noopener">NFPA 1225-2022 ch. 18</a>,
  <a href="https://www.oswegofire.com/wp-content/uploads/2025/11/2021_ifc_510-Comm-Coverage.pdf" target="_blank" rel="noopener">IFC 2021 §510</a>,
  <a href="https://www.law.cornell.edu/cfr/text/47/90.219" target="_blank" rel="noopener">47 CFR 90.219</a>,
  <a href="https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2109-2-202308-I!!PDF-E.pdf" target="_blank" rel="noopener">ITU-R P.2109-2</a> (entry loss),
  <a href="https://sbc.memberclicks.net/assets/Useful_Links/2025/ocsd-errcs-deployment-guidelines-deployment-rev4-5.pdf" target="_blank" rel="noopener">OCSD ERRCS guidelines</a>,
  <a href="https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf" target="_blank" rel="noopener">San Diego FD C-1</a>.
  All of it, with every source: the <a href="https://drive.google.com/drive/folders/1QRpqPV35gINsrQVGQAxbT4ik-ibcsfxu" target="_blank" rel="noopener">DAS research database</a>
  (<span class="mono">RF Recon\\docs\\research\\DAS-ERCES\\das_research.db</span> in Drive, with a CSV per table).`;
// a job's AHJ profile: the defaults above, with what this AHJ changes (presets below, editable under Requirements)
let DASJ = DAS;
const DAS_PROFILES = {
  "IFC 2021 + NFPA 1225": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12},
  "IFC 2024 / NFPA 1225 (DAQ only)": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12},
  "Strict (DAQ 3.4, 24 h, as OCSD)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 100, battery_h: 24},
  "Older NFPA 72 (90% general)": {threshold: -95, daq: 3.0, general_pct: 90, critical_pct: 99, battery_h: 12},
};
const DAS_CHECKS = [  // the dates a job is tracked by; a date means done
  ["consent", "Licensee / agency consent to retransmit (47 CFR 90.219(b)(1))"], ["fcc_reg", "FCC signal booster registration (Class B: 47 CFR 90.219(d)(5))"],
  ["permit", "AHJ permit"], ["design_ok", "Design approved"], ["monitoring", "Monitoring connected to the fire alarm panel"],
  ["accepted_on", "Acceptance test passed"], ["battery", "Battery test"]];
const DAS_ROLES = [["ahj", "AHJ / fire marshal"], ["owner", "Building owner"], ["agency", "Radio system owner"], ["gc", "General contractor"], ["tech", "Our technician"]];

// the AHJ report prints on its own (the rest of the page is hidden while it prints)
document.head.insertAdjacentHTML("beforeend", `<style>@media print{body.print-das *{visibility:hidden}body.print-das #dasPrint,body.print-das #dasPrint *{visibility:visible}
  body.print-das #dasPrint{position:absolute;left:0;top:0;width:100%;background:#fff;color:#000;border:0;box-shadow:none}body.print-das #dasPrint .hint{color:#444}}</style>`);
const dasDl = (name, text, type) => { const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000); };
const csvOf = rows => { const keys=[]; for(const r of rows) for(const k of Object.keys(r)) if(!keys.includes(k)) keys.push(k);
  const c=v=>{ const s=v==null?"":String(v); return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  return [keys.join(","), ...rows.map(r=>keys.map(k=>c(r[k])).join(","))].join("\r\n")+"\r\n"; };
const fileSafe = s => (s||"job").replace(/[\\/:*?"<>|]+/g,"-").slice(0,80);
const today = () => new Date().toISOString().slice(0,10);
const addYear = d => { if(!d) return ""; const t=new Date(d+"T12:00:00"); t.setFullYear(t.getFullYear()+1); return t.toISOString().slice(0,10); };
const daysTo = d => d ? Math.round((Date.parse(d+"T12:00:00")-Date.now())/864e5) : null;

S.views.das = async v => {
  const D=S.das=S.das||{view:"board", q:"", job:null, sub:"overview"};
  const gen=D.gen=(D.gen||0)+1;  // a draw overtaken by a newer one while it waited stops, instead of binding to the newer one's screen
  try{ const r=await api("/api/das/jobs"); D.jobs=r.jobs; D.stages=r.stages; D.folder=r.folder; D.contacts=(await api("/api/das/contacts")).contacts; }
  catch(e){ if(gen===D.gen) v.innerHTML=`<p class="status err">DAS jobs: ${esc(e.message)}</p>`; return; }
  if(gen!==D.gen) return;
  if(D.job){ const j=D.jobs.find(x=>x.id===D.job); if(j) return dasJob(v, D.job); D.job=null; }
  const q=D.q.trim().toLowerCase(), jobs=D.jobs.filter(j=>!q||`${j.name} ${j.address||""} ${j.ahj||""} ${j.client||""}`.toLowerCase().includes(q));
  // what needs you: retests coming due, overdue next steps, open checks on jobs past design
  const need=[];
  for(const j of D.jobs){ const rd=daysTo(j.retest_due), dd=daysTo(j.due), ck=j.checks||{};
    if(rd!=null&&rd<=60) need.push([j, rd<0?`annual retest overdue by ${-rd} days`:`annual retest due in ${rd} days`, rd]);
    if(dd!=null&&dd<0&&!["In service","Closed"].includes(j.stage)) need.push([j, `${j.next_step||"next step"} overdue by ${-dd} days`, dd]);
    if(["Install","Commission","Acceptance"].includes(j.stage)&&!ck.consent) need.push([j, "no licensee consent on file", 0]);
    if(["Commission","Acceptance","In service"].includes(j.stage)&&!ck.fcc_reg) need.push([j, "no FCC booster registration on file", 0]); }
  need.sort((a,b)=>a[2]-b[2]);
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <button class="primary" id="dsNew">+ New job</button>
      <div class="seg" id="dsView">${[["board","Board"],["list","List"],["contacts","Contacts"],["data","Data & links"]].map(([k,l])=>`<button data-v="${k}" class="${D.view===k?"on":""}">${l}</button>`).join("")}</div>
      <label class="inl" title="Filters the board, and searches everything in DAS: every field in every job (readings, channels, notes), contacts, the log, job files and the DAS research">Find <input id="dsQ" value="${esc(D.q)}" placeholder="search all DAS data: jobs, readings, channels, contacts, files, code rules" style="width:330px"></label>
      <label class="inl" title="A job exported from RF Recon (JSON)">Import job <input type="file" id="dsImpJob" accept=".json"></label>
      <button id="dsExpCsv">⇩ Jobs CSV</button><button id="dsExpJson">⇩ All jobs JSON</button>
      <span class="hint">${(D.folder||"").startsWith("/rfr/") ? "Files for each job are kept in this browser."  /* the web version (web/webhost.py) */
        : `Files for each job are kept in <span class="mono">${esc(D.folder||"")}</span>.`}</span></div>
    <p style="margin:2px 2px 10px"><b>${D.jobs.length} job${D.jobs.length===1?"":"s"}</b>${need.length?` · <b style="color:var(--warn)">${need.length} need${need.length===1?"s":""} you</b>`:" · nothing waiting on you"}</p>
    ${need.length?`<div class="panel"><h3>Needs you</h3>${need.slice(0,8).map(([j,t])=>`<div class="row" style="justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid var(--line)"><span><b>${esc(j.name)}</b> <span class="hint">${esc(j.stage)}</span> · ${esc(t)}</span><button data-open="${j.id}">Open</button></div>`).join("")}</div>`:""}
    <div id="dsFind"></div>
    <div id="dsGuide"></div>
    <div id="dsBody"></div>`;
  window.dasBoardGuide?.($("#dsGuide"), D);  // how a job moves, and the example jobs (dasexample.js)
  const body=$("#dsBody");
  if(q.length>=2&&window.findRender){  // everything in DAS that matches, above the board (the board below is filtered by name / address / AHJ / client)
    const box=$("#dsFind"); box.innerHTML='<p class="hint">Searching all DAS data…</p>';
    api(`/api/das/search?q=${encodeURIComponent(D.q.trim())}`).then(res=>{ if(S.das!==D||D.q.trim().toLowerCase()!==q) return;
      box.innerHTML='<div class="panel"><h3 style="margin:0">Everything in DAS matching “'+esc(D.q.trim())+'”</h3><div id="dsFindOut"></div></div>'; findRender($("#dsFindOut"), res, D.q.trim()); })
      .catch(e=>{ box.innerHTML=`<p class="status err">${esc(e.message)}</p>`; }); }
  if(D.view==="contacts") dasContacts(body);
  else if(D.view==="data") dasData(body);
  else if(D.view==="list") body.innerHTML=jobs.length?`<div class="tw"><table><thead><tr><th>Job</th><th>Stage</th><th>Address</th><th>AHJ</th><th>Next step</th><th>Due</th><th>Retest due</th><th>Updated</th></tr></thead><tbody>${
      jobs.map(j=>`<tr data-open="${j.id}" style="cursor:pointer"><td><b>${esc(j.name)}</b></td><td>${esc(j.stage)}</td><td>${esc(j.address||"")}</td><td>${esc(j.ahj||"")}</td><td>${esc(j.next_step||"")}</td><td class="mono">${esc(j.due||"")}</td><td class="mono">${esc(j.retest_due||"")}</td><td class="mono">${esc((j.updated_at||"").slice(0,16))}</td></tr>`).join("")}</tbody></table></div>`
      :'<p class="status">No jobs yet. Start one with + New job.</p>';
  else {  // board: a column per stage; drag a card to move the job
    body.innerHTML=`<div style="display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);gap:10px;overflow-x:auto;padding-bottom:6px">${D.stages.map(st=>{ const js=jobs.filter(j=>j.stage===st);
      return `<div class="panel ds-col" data-stage="${esc(st)}" style="margin:0;min-height:160px"><h3 style="display:flex;justify-content:space-between">${esc(st)} <span class="hint">${js.length}</span></h3>${js.map(j=>{ const ck=j.checks||{}, done=DAS_CHECKS.filter(([k])=>ck[k]).length, rd=daysTo(j.retest_due);
        return `<div class="ds-card" draggable="true" data-open="${j.id}" data-id="${j.id}" style="border:1px solid var(--line);border-radius:12px;padding:9px 10px;margin-top:8px;cursor:grab;background:var(--wash,transparent)">
          <b>${esc(j.name)}</b><div class="hint">${esc(j.address||"No address yet")}</div>
          ${j.next_step?`<div style="font-size:12px;margin-top:4px">Next: ${esc(j.next_step)}${j.due?` · <span class="mono">${esc(j.due)}</span>`:""}</div>`:""}
          <div class="row" style="gap:4px;margin-top:6px"><span class="tag" title="Compliance dates on file">${done}/${DAS_CHECKS.length} checks</span>${j.ahj?`<span class="tag">${esc(j.ahj)}</span>`:""}${rd!=null?`<span class="tag ${rd<0?"w":""}">retest ${rd<0?"overdue":`in ${rd} d`}</span>`:""}</div></div>`; }).join("")||'<p class="hint" style="margin-top:8px">Drop a job here.</p>'}</div>`; }).join("")}</div>`;
    let dragId=null;
    body.querySelectorAll(".ds-card").forEach(c=>{ c.addEventListener("dragstart",e=>{ dragId=+c.dataset.id; e.dataTransfer.effectAllowed="move"; c.style.opacity=".5"; }); c.addEventListener("dragend",()=>{ c.style.opacity=""; }); });
    body.querySelectorAll(".ds-col").forEach(col=>{
      col.addEventListener("dragover",e=>{ e.preventDefault(); col.style.outline="2px dashed var(--accent)"; });
      col.addEventListener("dragleave",()=>{ col.style.outline=""; });
      col.addEventListener("drop",async e=>{ e.preventDefault(); col.style.outline=""; if(dragId==null) return; const j=D.jobs.find(x=>x.id===dragId);
        if(j&&j.stage!==col.dataset.stage){ await post(`/api/das/jobs/${dragId}`,{stage:col.dataset.stage}); render(); } dragId=null; }); });
  }
  v.querySelectorAll("[data-open]").forEach(el=>el.addEventListener("click",()=>{ D.job=+el.dataset.open; D.sub="overview"; render(); }));
  $("#dsView").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.view=b.dataset.v; render(); } };
  let t; $("#dsQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ D.q=e.target.value; render(); const i=$("#dsQ"); i.focus(); i.setSelectionRange(i.value.length,i.value.length); },300); };
  $("#dsNew").onclick=async()=>{ const p=parseLoc($("#loc").value); const j=await post("/api/das/jobs",{name:"New job",stage:"Lead",data:p?{lat:p[0],lon:p[1]}:{}}); D.job=j.id; D.sub="overview"; render(); };
  $("#dsExpCsv").onclick=()=>dasDl("RF Recon DAS jobs.csv", csvOf(D.jobs.map(j=>({id:j.id,name:j.name,stage:j.stage,address:j.address,lat:j.lat,lon:j.lon,ahj:j.ahj,client:j.client,
    next_step:j.next_step,due:j.due,floors:Array.isArray(j.floors)?j.floors.length:"",accepted_on:j.accepted_on,retest_due:j.retest_due,...Object.fromEntries(DAS_CHECKS.map(([k])=>[k,(j.checks||{})[k]||""])),updated_at:j.updated_at}))), "text/csv");
  $("#dsExpJson").onclick=async()=>{ const full=[]; for(const j of D.jobs) full.push(await api(`/api/das/jobs/${j.id}`));
    dasDl("RF Recon DAS jobs.json", JSON.stringify({rfrecon_das_jobs:1, exported:new Date().toISOString(), jobs:full.map(({id,log,...x})=>x)},null,1), "application/json"); };
  $("#dsImpJob").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); const list=j.jobs||[j];
      for(const x of list) await post("/api/das/jobs",{name:x.name||"Imported job",stage:x.stage||"Lead",data:x.data||{}}); render(); }catch(err){ alert("That file isn't an RF Recon job: "+err.message); } };
};

/* ---------- data and links: what DAS work reads, what to download, where the codes and lookups are ---------- */
// every link checked 2026-10-28; the design, PIM, parts and plans ones 2026-10-29 from the cited research
// (static/research). FCC and ICC pages refuse scripted checks: opened in a browser instead
const DAS_LINKS = [
  ["Codes", [["NFPA 1225 (free read-only access, NFPA account)", "https://www.nfpa.org/codes-and-standards/nfpa-1225-standard-development/1225", "Chapter 18 ERCES, 20.3.10 testing"],
    ["NFPA free access list", "https://www.nfpa.org/for-professionals/codes-and-standards/list-of-codes-and-standards/free-access", "Every NFPA code you can read free"],
    ["IFC 2024 chapter 5 (ICC, free to read)", "https://codes.iccsafe.org/content/IFC2024V1.0/chapter-5-fire-service-features", "Section 510, emergency responder communication coverage"],
    ["47 CFR 90.219 (eCFR)", "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-I/section-90.219", "Signal booster classes, consent, power and noise limits"],
    ["47 CFR 90.613 (eCFR)", "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-S/section-90.613", "800 MHz channel table (the 45 MHz pairs)"],
    ["ITU-R P.2109 building entry loss", "https://www.itu.int/rec/R-REC-P.2109/en", "The construction loss presets"],
    ["ITU-R P.526 diffraction", "https://www.itu.int/rec/R-REC-P.526/en", "The knife-edge loss used for terrain"]]],
  ["Design: link budget, coverage, walls", [["ITU-R P.1238 indoor propagation", "https://www.itu.int/rec/R-REC-P.1238/en", "The in-building path loss the link budget and the coverage on the plans use (no VHF values)"],
    ["ITU-R P.2040 building materials", "https://www.itu.int/rec/R-REC-P.2040/en", "Loss through walls and floors by material: the wall loss calculator"],
    ["NIST NISTIR 6055 measured wall loss", "https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir6055.pdf", "Concrete, brick, block and glass measured: the wall presets use these (the ITU model gives about a third of the loss for concrete)"],
    ["TIA TSB-88 portable antenna loss (draft, free)", "http://www.simulcastsolutions.com/userfiles/file/appnotes/pTR8.18-06-10-0035-PN3-4744.1-RV3-Fb.pdf", "Portable antenna and body loss by band: the uplink default"],
    ["NPSTC in-building white paper", "https://www.npstc.org/documents/20071212_IBWG%20White%20Paper%20Appendix%20A-E.pdf", "Isolation, booster headroom and link budget practice"]]],
  ["AHJ guidelines with numbers", [["Orange County (CA) Sheriff ERRCS guidelines", "https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf", "Uplink −95 to −75 dBm at the site, 65 dB gain cap, 27 dBm at the donor port, −150 dBm noise"],
    ["Durham (NC) BDA permit requirements", "https://www.durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-", "Uplink under −80 dBm at the tower, −153 dBm noise, Class A only"],
    ["San Diego Fire-Rescue C-1", "https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf", "Gain cap, noise at the donor site, grid testing"],
    ["Fairfax County (VA) ERCES submittal guidelines", "https://www.fairfaxcounty.gov/fire-ems/sites/fire-ems/files/Assets/Documents/PDF/fire%20marshal/ERCES%20Submittal%20and%20Permit%20Requirements%20Guidelines.pdf", "What the submittal must include, plans included"]]],
  ["PIM and parts", [["IEC 62037 PIM measurement (abstract; the standard is paid)", "https://webstore.iec.ch/en/publication/6331", "How PIM is measured; part 7 covers field measurement"],
    ["Anritsu: PIM in in-building DAS", "https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf", "Where PIM comes from in a DAS and how to find it"],
    ["Anritsu: testing a DAS", "https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf", "Sweeps, distance-to-fault and PIM on a DAS"],
    ["RFS DragonSkin 2-hour fire-rated coax (UL 2196)", "https://www.rfstechnologies.com/pim/product/pdf/2HB12-50JPLR", "The kind of cable a 2-hour pathway rule asks for"]]],
  ["FCC lookups", [["ULS licence search", "https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp", "Any licence by call sign, name, frequency or area"],
    ["Antenna structure (ASR) search", "https://wireless2.fcc.gov/UlsApp/AsrSearch/asrRegistrationSearch.jsp", "Towers by registration, owner or location"],
    ["Equipment authorization (FCC ID) search", "https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm", "A device's grant: frequencies, power, test reports (Data & updates, Look up an FCC ID, links here)"],
    ["National Broadband Map", "https://broadbandmap.fcc.gov/", "Carriers' modelled coverage: RF Recon's Carrier coverage heatmap (your own free FCC key)"],
    ["Signal boosters (FCC)", "https://www.fcc.gov/wireless/bureau-divisions/mobility-division/signal-boosters", "Rules, classes, how to register"],
    ["Class B booster registration and list", "https://signalboosters.fcc.gov/", "Register a Class B booster; search registered ones (refuses scripted downloads; was down for maintenance 2026-10-28)"]]],
  ["Planning and agencies", [["CAPRAD", "https://caprad.org/", "700 / 800 MHz public safety regional planning and channel assignments"],
    ["NPSTC", "https://www.npstc.org/", "Channel naming, interoperability, in-building reports"],
    ["RadioReference database", "https://www.radioreference.com/db/", "Systems, sites and talk groups (look up there; RF Recon only links to it)"],
    ["FirstNet Authority", "https://www.firstnet.gov/", "Band 14 and in-building questions go to FirstNet / AT&T"],
    ["Safer Buildings Coalition", "https://www.saferbuildings.org/", "Industry guidance, AHJ resources"]]],
  ["Bulk downloads", [["USGS National Map downloader", "https://apps.nationalmap.gov/downloader/", "3DEP elevation and building data, by area"],
    ["AWS Terrain Tiles", "https://registry.opendata.aws/terrain-tiles/", "The terrain RF Recon uses (free, no account)"],
    ["Microsoft US building footprints", "https://github.com/microsoft/USBuildingFootprints", "Every US building outline, by state (large)"],
    ["OpenStreetMap", "https://www.openstreetmap.org/copyright", "Building outlines RF Recon fetches per job (ODbL)"]]],
];
// the research sets beside DAS-ERCES in Drive (docs/research, built by build_field_research.py): name, folder id, what it holds
const DAS_RESEARCH = [["PIM", "1baexagIqzgUM9fdpTeNfJ2UcB8dImiko", "limits, checklists, procedures, torque"],
  ["RF-Parts", "15NOO7YMst9rCSCB12s3HrwQz3h1rX7Vh", "cables, connectors, components, suppliers"],
  ["Building-Plans-Materials", "1MUQ1pM4NTvRYabItL5Ssj7mecDjyjuhB", "getting plans, wall losses by material"],
  ["Link-Budget", "1LUi4ERK8vyhKEZAuGBRFSVCKLqQZEBzr", "defaults, formulas, P.1238, 90.219 and AHJ limits"]];
async function dasData(el){
  el.innerHTML='<p class="status">Checking the data…</p>';
  let upd={sources:{}}, ter={tiles:0, mb:0, folder:""};
  try{ [upd, ter]=await Promise.all([api("/api/update/status"), api("/api/das/terrain/status")]); }catch(e){}
  const jobs=[]; for(const j of S.das.jobs) if(j.lat!=null) jobs.push(j);
  const full=[]; for(const j of jobs) full.push((await api(`/api/das/jobs/${j.id}`)).data||{});
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const outlined=full.filter(d=>d.building).length;
  // the sources the DAS tab reads (DAS_USES, mission.js): one switch keeps them all updating by themselves
  const ids=Object.keys(DAS_USES).filter(id=>upd.sources[id]), auto=upd.auto&&ids.length&&ids.every(id=>upd.sources[id].enabled);
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Data the DAS tab reads</h3>${ids.length?`
      <div class="row" style="align-items:center"><label class="switch"><input type="checkbox" id="ddAuto" ${auto?"checked":""}><span></span></label><b>Auto-update DAS data when online</b></div>
      <div class="row" style="margin-top:8px;align-items:center;flex-wrap:wrap"><button class="primary" id="ddRunAll">⟳ Update all DAS data now</button><span class="hint" id="ddRunMsg"></span></div>`
      :'<p class="hint">Updates run in the PC version.</p>'}
      ${ids.map(id=>{ const s=upd.sources[id];
        return `<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(s.label)}</b><div class="hint">${esc(DAS_USES[id])}</div>
          <div class="hint">${s.enabled?"":'<b style="color:var(--bad)">not updating by itself</b> · '}${s.access?.needs_key&&!s.access.key_saved?'<b style="color:var(--bad)">no key saved</b> · ':""}${freshness(s, upd.auto)}${s.state==="error"?` · <span style="color:var(--bad)">${esc(s.message)}</span>`:""}</div></span>
          <button data-run="${esc(id)}" ${s.running?"disabled":""}>${s.running?"Updating…":"Update now"}</button></div>`; }).join("")}
      <p class="hint">On, the switch turns on automatic updates and selects all ${ids.length} of these; each then updates on its own schedule, over the connections Data &amp; updates allows. Off stops these ${ids.length} updating by themselves, on the map and in search too (they're the same data). Update all leaves out a source whose key isn't saved.
        Schedules, keys and Update over (Wi-Fi, Ethernet, cellular) are in Data &amp; updates.</p></div>
    <div class="panel"><h3>Terrain and building outlines</h3>
      <p style="margin:0 0 6px">Terrain on this PC: <b>${ter.tiles.toLocaleString()}</b> tiles, ${ter.mb} MB${ter.folder?` <span class="hint mono">${esc(ter.folder)}</span>`:""}</p>
      <div class="row"><button id="ddTer" ${jobs.length?"":"disabled"}>⇩ Download terrain around every job (${jobs.length})</button><span class="hint" id="ddTerMsg"></span></div>
      <p class="hint">For terrain paths and coverage with no signal in the field. ${esc(ter.attribution||"")}</p>
      <p style="margin:10px 0 6px">Building outlines: <b>${outlined}</b> of ${jobs.length} jobs have one.</p>
      <div class="row"><button id="ddOut" ${jobs.length>outlined?"":"disabled"}>⌂ Get the missing outlines</button><span class="hint" id="ddOutMsg"></span></div>
      <p class="hint">From OpenStreetMap (ODbL), with Overture Maps (ODbL) where OpenStreetMap has no outline or height: footprint, floors and height, for the floor area, sector split and donor height.</p></div></div>
    <div class="panel"><h3>Codes, rules, lookups and downloads</h3>
      ${DAS_LINKS.map(([g,ls])=>`<h4 style="margin:10px 0 4px">${esc(g)}</h4>${ls.map(([t,u,w])=>`<div style="padding:2px 0"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a> <span class="hint">· ${esc(w)}</span></div>`).join("")}`).join("")}
      <h4 style="margin:10px 0 4px">Research</h4><div>${DAS_SOURCES}</div>
      <p style="margin:8px 0 0">The rest of the research, each a database with a CSV per table and its report, in Drive under <span class="mono">RF Recon\\docs\\research</span>:
        ${DAS_RESEARCH.map(([n,id,w])=>`<a href="https://drive.google.com/drive/folders/${id}" target="_blank" rel="noopener">${esc(n)}</a> <span class="hint">(${esc(w)})</span>`).join(", ")}.</p></div>`;
  el.querySelectorAll("[data-run]").forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent="Updating…"; await post("/api/update/run",{ids:[b.dataset.run],force:true}); });
  if($("#ddAuto")) $("#ddAuto").onchange=async e=>{ const on=e.target.checked;
    await post("/api/update/config",{...(on?{auto:true}:{}), sources:Object.fromEntries(ids.map(id=>[id,{enabled:on}]))}); if(el.isConnected) dasData(el); };
  if($("#ddRunAll")) $("#ddRunAll").onclick=async()=>{ const b=$("#ddRunAll"); b.disabled=true;
    try{ const r=await post("/api/update/run",{ids, skip_no_key:true}), nm=id=>r.sources[id]?.label||id;
      if(!el.isConnected) return;
      $("#ddRunMsg").textContent=`${r.started.length?`Updating ${r.started.length}.`:"All already updating."}${r.skipped.length?` Left out, no key saved: ${r.skipped.map(nm).join(", ")}.`:""}`;
      el.querySelectorAll("[data-run]").forEach(x=>{ if(r.started.includes(x.dataset.run)){ x.disabled=true; x.textContent="Updating…"; } }); }
    catch(e){ $("#ddRunMsg").textContent=e.message; } b.disabled=false; };
  $("#ddTer").onclick=async()=>{ const b=$("#ddTer"); b.disabled=true; $("#ddTerMsg").textContent="Downloading…";
    try{ const r=await post("/api/das/terrain/download",{areas:jobs.map((j,i)=>({lat:j.lat, lon:j.lon, radius:full[i].presurvey?.radius||15}))});
      const got=r.areas.reduce((a,x)=>a+x.fetched,0), bad=r.areas.reduce((a,x)=>a+x.failed,0);
      $("#ddTerMsg").textContent=`${got} new tiles${bad?`, ${bad} failed (offline?)`:""}. ${r.tiles.toLocaleString()} tiles, ${r.mb} MB on this PC.`; }catch(e){ $("#ddTerMsg").textContent=e.message; } b.disabled=false; };
  $("#ddOut").onclick=async()=>{ const b=$("#ddOut"); b.disabled=true; let n=0, bad=[];
    for(let i=0;i<jobs.length;i++){ if(full[i].building) continue; $("#ddOutMsg").textContent=`${jobs[i].name}…`;
      try{ const bd=await api(`/api/das/building?lat=${jobs[i].lat}&lon=${jobs[i].lon}`), patch={building:bd};
        if(full[i].area_sqft==null&&bd.footprint_sqft) patch.area_sqft=bd.footprint_sqft;
        await post(`/api/das/jobs/${jobs[i].id}`,{data:patch}); n++; }catch(e){ bad.push(`${jobs[i].name}: ${e.message}`); }
      await new Promise(r=>setTimeout(r,1100)); }  // OpenStreetMap's Overpass asks for gentle use
    $("#ddOutMsg").textContent=`${n} outlines added.${bad.length?` ${bad.join(" · ")}`:""}`; };
}

/* ---------- contacts: the CRM side ---------- */
function dasContacts(el){
  const D=S.das, cs=D.contacts;
  el.innerHTML=`<div class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Contacts <span class="hint">· ${cs.length}</span></h3>
      <div class="row"><label class="inl">Import (CSV, Excel, vCard) <input type="file" id="dcImp" accept=".csv,.tsv,.txt,.xlsx,.vcf,.json"></label><button id="dcCsv">⇩ CSV</button><button id="dcVcf">⇩ vCard</button></div></div>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Phone</th><th>Email</th><th>Notes</th><th></th></tr></thead><tbody>
    ${cs.map(c=>`<tr data-cid="${c.id}">${["name","org","role","phone","email","notes"].map(f=>`<td><input data-f="${f}" value="${esc(c[f]||"")}" style="width:100%;min-width:90px"></td>`).join("")}<td><button data-del="${c.id}">Delete</button></td></tr>`).join("")}
    <tr id="dcNewRow">${["name","org","role","phone","email","notes"].map(f=>`<td><input data-f="${f}" placeholder="${f==="org"?"organisation":f}" style="width:100%;min-width:90px"></td>`).join("")}<td><button class="primary" id="dcAdd">Add</button></td></tr></tbody></table></div>
    <p class="hint" id="dcMsg">Changes save when you leave a field. Roles: AHJ / fire marshal, building owner, radio system owner (agency), general contractor, technician, or anything you like.</p></div>`;
  el.querySelectorAll("tr[data-cid] input").forEach(i=>i.onchange=async()=>{ const tr=i.closest("tr"), d={}; tr.querySelectorAll("input").forEach(x=>d[x.dataset.f]=x.value);
    await post(`/api/das/contacts/${tr.dataset.cid}`, d); $("#dcMsg").textContent="Saved."; });
  el.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{ await post(`/api/das/contacts/${b.dataset.del}/delete`); render(); });
  $("#dcAdd").onclick=async()=>{ const d={}; $$("#dcNewRow input").forEach(x=>d[x.dataset.f]=x.value); if(!d.name&&!d.org) return; await post("/api/das/contacts", d); render(); };
  $("#dcImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const r=await api(`/api/das/contacts/import?name=${encodeURIComponent(f.name)}`,{method:"POST",body:await f.arrayBuffer()});
      $("#dcMsg").textContent=`${r.found} found, ${r.added} added (the rest were already here).`; setTimeout(render,900); }catch(err){ $("#dcMsg").textContent="Import: "+err.message; } };
  $("#dcCsv").onclick=()=>dasDl("RF Recon contacts.csv", csvOf(cs.map(({id,updated_at,...c})=>c)), "text/csv");
  $("#dcVcf").onclick=()=>dasDl("RF Recon contacts.vcf", cs.map(c=>["BEGIN:VCARD","VERSION:3.0",`FN:${c.name||c.org}`,c.org?`ORG:${c.org}`:"",c.role?`TITLE:${c.role}`:"",c.phone?`TEL:${c.phone}`:"",c.email?`EMAIL:${c.email}`:"",c.notes?`NOTE:${c.notes.replace(/\n/g,"\\n")}`:"","END:VCARD"].filter(Boolean).join("\r\n")).join("\r\n")+"\r\n", "text/vcard");
}

/* ---------- one job ---------- */
async function dasJob(v, id){
  const D=S.das, gen=D.gen; let j;
  try{ j=await api(`/api/das/jobs/${id}`); }catch(e){ if(gen===D.gen){ D.job=null; render(); } return; }
  if(gen!==D.gen) return;  // the board or another job was drawn while this waited
  DASJ={...DAS, ...(((j.data||{}).profile)||{})};
  const d=j.data||{}, save=async(patch,extra)=>{ j=await post(`/api/das/jobs/${id}`,{...(extra||{}),data:patch}); return j; };
  const subs=[["overview","Overview"],["presurvey","Pre-survey"],["plans","Plans"],["require","Requirements"],["design","Design"],["materials","Materials"],["grid","Grid test"],["screen","Screening"],["pim","PIM"],["files","Files"],["log","Log"],["report","Report"]];
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px"><button id="djBack">← All jobs</button>
      <input id="djName" value="${esc(j.name)}" style="font-size:18px;font-weight:700;min-width:260px">
      <label class="inl">Stage <select id="djStage">${D.stages.map(s=>`<option ${s===j.stage?"selected":""}>${esc(s)}</option>`).join("")}</select></label>
      <div class="seg" id="djSub">${subs.map(([k,l])=>`<button data-s="${k}" class="${D.sub===k?"on":""}">${l}</button>`).join("")}</div>
      <span style="margin-left:auto" class="row"><button id="djExp">⇩ Job JSON</button><button id="djDel">Delete job</button></span></div>
    <div id="djGuide"></div><div id="djBody"></div>`;
  window.dasJobGuide?.($("#djGuide"), j, D.sub);  // an example job explains each step (dasexample.js)
  $("#djBack").onclick=()=>{ D.job=null; render(); };
  $("#djName").onchange=async e=>{ await post(`/api/das/jobs/${id}`,{name:e.target.value}); };
  $("#djStage").onchange=async e=>{ await post(`/api/das/jobs/${id}`,{stage:e.target.value}); };
  $("#djSub").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.sub=b.dataset.s; render(); } };
  $("#djExp").onclick=()=>{ const {id:_,log,...x}=j; dasDl(`${fileSafe(j.name)} (RF Recon job).json`, JSON.stringify({rfrecon_das_job:1,...x},null,1), "application/json"); };
  $("#djDel").onclick=async()=>{ if(!confirm(`Delete “${j.name}”? Its files stay in the Drive folder.`)) return; await post(`/api/das/jobs/${id}/delete`); D.job=null; render(); };
  const body=$("#djBody");
  ({overview:dasOverview, presurvey:dasPresurvey, require:dasRequire, grid:dasGrid, files:dasFiles, log:dasLog, report:dasReport,
    pim:window.dasPim, screen:window.dasScreen, materials:window.dasMaterials, plans:window.dasPlans, design:window.dasDesign}[D.sub]||dasOverview)(body, j, save);  // fieldref.js, plans.js, dasdesign.js, dasscreen.js
}

function dasOverview(el, j, save){
  const d=j.data||{}, ck=d.checks||{}, cs=S.das.contacts, roles=d.contacts||{};
  const floors=Array.isArray(d.floors)?d.floors:[];
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Building</h3>
      <div class="row"><label class="grow">Client<input data-k="client" value="${esc(d.client||"")}"></label><label class="grow">Address<input data-k="address" value="${esc(d.address||"")}"></label></div>
      <div class="row" style="margin-top:6px"><label>Latitude<input data-k="lat" type="number" step="any" value="${d.lat??""}" style="width:130px"></label><label>Longitude<input data-k="lon" type="number" step="any" value="${d.lon??""}" style="width:130px"></label>
        <button id="doPin" title="Use the pin from the search panel">Use current pin</button><button id="doGo" title="Search the area around the building">Show on map</button></div>
      <div class="row" style="margin-top:6px"><label>Floors <input id="doFloors" type="number" min="0" value="${floors.length||""}" style="width:80px"></label>
        <label>Area (sq ft)<input data-k="area_sqft" type="number" value="${d.area_sqft??""}" style="width:110px"></label>
        <label>Construction <select data-k="construction">${Object.keys(DAS.loss).map(c=>`<option ${c===d.construction?"selected":""}>${esc(c)}</option>`).join("")}</select></label></div>
      <div class="row" style="margin-top:6px;align-items:center"><button id="doOutline" title="Footprint, floors and height from OpenStreetMap, for the floor area, sector split, roof height and map">⌂ Get the building's outline</button>
        <span class="hint" id="doOutMsg">${d.building?dasBuildingLine(d.building):"From OpenStreetMap (Overture Maps where it has none): footprint, floors and height."}</span></div>
      <div class="row" style="margin-top:6px"><label class="grow">AHJ (jurisdiction)<input data-k="ahj" value="${esc(d.ahj||"")}" placeholder="e.g. Arlington County Fire Marshal"></label>
        <label class="grow">Code basis<input data-k="code" value="${esc(d.code||"IFC 510 + NFPA 1225")}" placeholder="IFC 2024 510, NFPA 1225 2022, local amendments"></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">Next step<input data-k="next_step" value="${esc(d.next_step||"")}"></label><label>Due<input data-k="due" type="date" value="${esc(d.due||"")}"></label>
        <label>Value ($)<input data-k="value" type="number" value="${d.value??""}" style="width:110px"></label></div></div>
    <div class="panel"><h3>Compliance <span class="hint">· a date means done</span></h3>
      ${DAS_CHECKS.map(([k,l])=>`<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0"><span>${ck[k]?"✅":"⬜"} ${esc(l)}</span><input type="date" data-ck="${k}" value="${esc(ck[k]||"")}"></div>`).join("")}
      <p style="margin:8px 0 0">Annual retest due: <b class="mono">${esc(d.retest_due||"–")}</b>${d.retest_due?` <span class="hint">(${daysTo(d.retest_due)} days)</span>`:""} <span class="hint">· set from the acceptance date, one year on</span></p></div>
    <div class="panel"><h3>People</h3>
      ${DAS_ROLES.map(([k,l])=>`<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0"><span>${esc(l)}</span>
        <select data-role="${k}" style="max-width:60%"><option value="">—</option>${cs.map(c=>`<option value="${c.id}" ${String(roles[k])===String(c.id)?"selected":""}>${esc(c.name||c.org)}${c.org&&c.name?` · ${esc(c.org)}`:""}</option>`).join("")}</select></div>`).join("")}
      <p class="hint">Add people under All jobs, Contacts (or import a CSV / vCard there).</p></div>
    <div class="panel"><h3>Testing <span class="hint">· goes on the AHJ report</span></h3>
      <div class="row"><label class="grow">Tester<input data-t="tester" value="${esc((d.testing||{}).tester||"")}"></label><label>FCC GROL<input data-t="grol" value="${esc((d.testing||{}).grol||"")}" style="width:120px"></label>
        <label>NICET<input data-t="nicet" value="${esc((d.testing||{}).nicet||"")}" style="width:120px"></label></div>
      <div class="row" style="margin-top:6px"><label>Tested<input data-t="date" type="date" value="${esc((d.testing||{}).date||"")}"></label><label>to<input data-t="date2" type="date" value="${esc((d.testing||{}).date2||"")}"></label>
        <label>Booster <select data-k="booster_class">${["Class A (channelized)","Class B (wideband)","Not chosen yet"].map(c=>`<option ${c===(d.booster_class||"Class A (channelized)")?"selected":""}>${c}</option>`).join("")}</select></label></div>
      <label style="margin-top:6px">Instruments, one per line: model | serial | calibration date<textarea id="doInst" rows="3" style="width:100%" placeholder="PCTEL IBflex | 12345 | 2026-03-01">${esc(((d.testing||{}).instruments||[]).map(i=>[i.model,i.serial,i.cal].join(" | ")).join("\n"))}</textarea></label>
      <p class="hint" style="margin:4px 0 0">Grid readings count toward pass / fail only when they were taken with one of these, calibrated within ${DAS.cal_months} months (Grid test, <i>Taken with</i>). An SDR or a phone app has no calibration: its readings stay on the plan as pre-survey and aren't scored.</p></div>
    <div class="panel"><h3>Notes</h3><textarea data-k="notes" rows="7" style="width:100%">${esc(d.notes||"")}</textarea></div></div>`;
  el.querySelectorAll("[data-t]").forEach(i=>i.onchange=async()=>{ j=await save({testing:{...(j.data.testing||{}),[i.dataset.t]:i.value}}); });
  $("#doInst").onchange=async e=>{ const instruments=e.target.value.split("\n").map(l=>l.split("|").map(s=>s.trim())).filter(p=>p[0]).map(([model,serial,cal])=>({model,serial:serial||"",cal:cal||""}));
    j=await save({testing:{...(j.data.testing||{}),instruments}}); };
  el.querySelectorAll("[data-k]").forEach(i=>i.onchange=async()=>{ const k=i.dataset.k, val=i.type==="number"?(i.value===""?null:+i.value):i.value; j=await save({[k]:val}); });
  el.querySelectorAll("[data-ck]").forEach(i=>i.onchange=async()=>{ const checks={...(j.data.checks||{}),[i.dataset.ck]:i.value}; const patch={checks};
    if(i.dataset.ck==="accepted_on"){ patch.accepted_on=i.value; patch.retest_due=addYear(i.value); }
    j=await save(patch); render(); });
  el.querySelectorAll("[data-role]").forEach(s=>s.onchange=async()=>{ j=await save({contacts:{...(j.data.contacts||{}),[s.dataset.role]:s.value?+s.value:null}}); });
  $("#doFloors").onchange=async e=>{ const n=Math.max(0,Math.min(200,+e.target.value||0)); const cur=Array.isArray(j.data.floors)?j.data.floors:[];
    const fl=Array.from({length:n},(_,i)=>cur[i]||{name:String(i+1),grids:DAS.grids}); j=await save({floors:fl}); };
  $("#doOutline").onclick=async()=>{ const dd=j.data; if(dd.lat==null){ alert("Set the building's location first."); return; } $("#doOutMsg").textContent="Asking OpenStreetMap (can take up to a minute when it is busy)…";
    try{ const b=await api(`/api/das/building?lat=${dd.lat}&lon=${dd.lon}`), patch={building:b};
      if(dd.area_sqft==null&&b.footprint_sqft) patch.area_sqft=b.footprint_sqft;  // only fills what's empty
      if(!(Array.isArray(dd.floors)&&dd.floors.length)&&b.levels) patch.floors=Array.from({length:Math.min(200,b.levels)},(_,i)=>({name:String(i+1),grids:DAS.grids}));
      j=await save(patch); render(); }catch(e){ $("#doOutMsg").textContent=e.message; } };
  $("#doPin").onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ alert("Drop a pin or type the address in the search panel first."); return; } j=await save({lat:p[0],lon:p[1]}); render(); };
  $("#doGo").onclick=()=>{ const dd=j.data; if(dd.lat==null){ alert("Set the building's location first."); return; } $("#loc").value=`${dd.lat}, ${dd.lon}`; setMode("point"); setTab("map"); runSearch(); };
}

// a system's terrain path (from Terrain paths), when it was checked against today's strongest site
function dasTerrainCell(s, t){
  const st=s.sites[0]; if(!t||!st||t.site!==`${st.lat},${st.lon}`) return "";
  if(t.error) return `<span class="hint">${esc(t.error)}</span>`;
  const word=t.status==="clear"?["clear","var(--good)"]:t.status.startsWith("Fresnel")?["partly blocked","var(--warn)"]:["blocked by terrain","var(--bad)"];
  return `<span style="color:${word[1]}" title="${esc(`${t.status}; clearance ${t.clearance_f1} of the first Fresnel zone${t.worst_at_km!=null?`; worst point ${num(t.worst_at_km/1.609344,1)} mi from the site, ${t.worst_above_los_m} m above the line`:""}`)}">${word[0]}</span>`
    + `${t.loss_db?` −${num(t.loss_db,0)} dB`:""}${s.best_in!=null?`<div class="hint">${num(s.best_in-(t.loss_db||0),0)} dBm inside</div>`:""}`;
}
const dasBuildingLine = b => `${esc(b.name||"Building")} · ${(b.footprint_sqft||0).toLocaleString()} sq ft footprint${b.levels?` · ${b.levels} floors`:""}${b.height_m?` · ${Math.round(b.height_m)} m tall${b.height_est?` <span class="hint" title="${esc(b.height_source||"")}: machine-learned heights read low on tall buildings">(estimate)</span>`:""}`:""}`
  + `${b.contains_pin?"":` · nearest outline, ${b.dist_m} m from the pin`} · ${esc(b.source)} ${esc(b.osm||"")}${b.gers_id?` <span class="hint mono" title="Overture GERS id, release ${esc(b.release||b.overture_release||"")}">${esc(b.gers_id.slice(0,8))}</span>`:""}`
  + `${b.note?` · <i>${esc(b.note)}</i>`:""}`
  + `${b.footprint_sqft>DAS.sector_sqft?` · <b style="color:var(--warn)">over ${DAS.sector_sqft.toLocaleString()} sq ft a floor: NFPA 1225 splits each floor into sectors of ${DAS.grids} grids</b>`:""}`;
// the donor antenna's height: the building's height (or floors x 3.5 m) plus a 3 m mast
const dasRoof = d => (d.building?.height_m || ((d.building?.levels || (Array.isArray(d.floors)?d.floors.length:0) || 3) * 3.5)) + 3;

/* ---------- pre-survey: the agency systems serving the building ---------- */
async function dasPresurvey(el, j, save){
  const d=j.data||{}, ps=d.presurvey||{};
  if(d.lat==null){ el.innerHTML='<p class="status">Set the building\'s location on the Overview first (Use current pin).</p>'; return; }
  // the estimate needs a level to compare with even when the AHJ judges by DAQ alone: -95 dBm is the usual design floor
  const P={radius:ps.radius||15, loss:ps.loss??DAS.loss[d.construction]??14, threshold:ps.threshold||DASJ.threshold||-95};
  el.innerHTML='<p class="status">Finding the public safety systems around the building…</p>';
  let r; try{ r=await api(`/api/das/presurvey?lat=${d.lat}&lon=${d.lon}&radius=${P.radius}&loss=${P.loss}&threshold=${P.threshold}`); }
  catch(e){ if(!el.isConnected) return; el.innerHTML=`<p class="status err">${esc(e.message)}</p><div id="psCell" style="margin-top:10px"></div>`; window.dasCellPresurvey?.($("#psCell"), j, save); return; }  // the carriers need no FCC data
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const inc=new Set(ps.include||[]), any=inc.size>0;
  const chosen=r.systems.filter(s=>inc.has(s.call_sign));
  const need=chosen.filter(s=>s.margin_db!=null&&s.margin_db<0).length;
  const verdict=!any?"Tick the systems the AHJ requires (usually fire, police and EMS) to build the channel plan."
    : need?`${need} of ${chosen.length} chosen system${chosen.length===1?"":"s"} likely below ${P.threshold} dBm inside (best case): an ERCES is likely needed.`
    : `All ${chosen.length} chosen systems clear ${P.threshold} dBm inside on the free-space estimate. Free space is best case: a walk test decides.`;
  const planOf=list=>{ const out=[]; for(const s of list) for(const c of s.down) out.push({system:s.licensee, call_sign:s.call_sign, service:s.service_name, trunked:s.trunked?"yes":"no",
    technology:s.tech.join(" / "), downlink_mhz:c.freq, uplink_mhz:(c.up||[]).join(" "), band:c.band, emission:c.emission||"", bandwidth_khz:c.bw_khz??"", best_outdoor_dbm:c.best_out??""}); return out; };
  const plan=planOf(chosen);
  const bands=new Map(); for(const p of plan){ for(const f of [p.downlink_mhz, ...String(p.uplink_mhz).split(" ").filter(Boolean).map(Number)]){ const b=dasBand(f); const x=bands.get(b)||{lo:1e9,hi:0,set:new Set()}; x.lo=Math.min(x.lo,f); x.hi=Math.max(x.hi,f); x.set.add(f); x.n=x.set.size; bands.set(b,x); } }
  el.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Within <input id="psR" type="number" value="${P.radius}" min="1" max="60" style="width:70px"> mi</label>
      <label class="inl" title="Building entry loss, ITU-R P.2109-2 (outer wall only)">Building loss <select id="psLp"><option value="">custom</option>${Object.entries(DAS.loss).map(([k,v2])=>`<option value="${v2}" ${+P.loss===v2?"selected":""}>${esc(k)}</option>`).join("")}</select>
        <input id="psL" type="number" value="${P.loss}" min="0" max="80" style="width:64px"> dB</label>
      <label class="inl">Needs at least <input id="psT" type="number" value="${P.threshold}" style="width:80px"> dBm inside</label>
      <button id="psPick">Tick fire, police, EMS, 911</button><button id="psNone">Untick all</button>
      <button id="psTer" title="Line of sight from each system's strongest site to the roof, with the loss over hills (terrain data, cached on this PC). Ticked systems, or the 20 strongest.">⛰ Terrain paths</button>
      <button id="psPlan" ${plan.length?"":"disabled"}>⇩ Channel plan CSV</button><button id="psCsv">⇩ Systems CSV</button><button id="psKml">⇩ KML</button><button id="psTak">⇩ ATAK</button>
      <button id="psLet" ${chosen.length?"":"disabled"} title="One letter per licensee asking consent to retransmit (47 CFR 90.219(b)(1)); print or save as PDF">⎙ Consent letters</button></div>
    <p style="margin:2px 2px 10px"><b>${r.systems.length}</b> public safety systems within ${P.radius} mi. ${esc(verdict)}</p>
    <div class="grid2" style="margin-top:0">
      <div class="panel"><h3>Bands a booster must pass <span class="hint">· chosen systems, downlink and uplink</span></h3>${bands.size?`<table><thead><tr><th>Band</th><th>From MHz</th><th>To MHz</th><th class="n">Channels</th></tr></thead><tbody>${[...bands].sort((a,b)=>a[1].lo-b[1].lo).map(([b,x])=>`<tr><td>${esc(b)}</td><td class="mono">${fmtF(x.lo)}</td><td class="mono">${fmtF(x.hi)}</td><td class="n">${x.n}</td></tr>`).join("")}</tbody></table>
        <p class="hint">Class A (channelized): every passband 75 kHz or less, one filter per channel. Class B (wideband): passes each band's whole span and must be registered with the FCC; keep commercial ESMR (862–869 MHz) out of it. FirstNet (${esc(r.firstnet.band)}: ${r.firstnet.down.join("–")} MHz down, ${r.firstnet.up.join("–")} MHz up) needs FirstNet / AT&amp;T authorization and isn't in FCC site data. ⚠ marks channels to check: ESMR, Band 14, or simulcast from several sites (delay / TDI).</p>
        <div id="psBoost"></div>`:'<p class="hint">Tick systems below.</p>'}</div>
      <div class="panel" style="padding:0;overflow:hidden"><div id="psMap" style="height:300px"></div></div></div>
    <div class="panel" style="margin-top:10px"><h3>Systems <span class="hint">· strongest first · levels are free-space estimates from licensed power: best case, no terrain</span></h3>
      <div class="tw" style="max-height:60vh"><table><thead><tr><th></th><th>Agency</th><th>Call sign</th><th>Type</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Best site</th><th class="n">Outside dBm</th><th class="n">Inside dBm</th><th class="n">Margin dB</th><th>Terrain to the roof</th></tr></thead><tbody>
      ${r.systems.map(s=>{ const st=s.sites[0]; return `<tr><td><input type="checkbox" data-cs="${esc(s.call_sign)}" ${inc.has(s.call_sign)?"checked":""}></td><td><b>${esc(s.licensee)}</b><div class="hint">${esc(s.category||"")}</div></td>
        <td class="mono">${s.usi?`<a href="https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${s.usi}" target="_blank" rel="noopener">${esc(s.call_sign)}</a>`:esc(s.call_sign)}</td>
        <td>${esc(s.trunked?"Trunked":"Conventional")} · ${esc(s.tech.join(", "))}<div class="hint">${esc(s.service_name||"")}</div></td>
        <td class="mono">${s.down.slice(0,6).map(c=>`${fmtF(c.freq)}${(c.flags||[]).length?` <span title="${esc(c.flags.join("; "))}" style="color:var(--warn);cursor:help">⚠</span>`:""}`).join("<br>")}${s.down.length>6?`<br><span class="hint">+${s.down.length-6}</span>`:""}</td>
        <td class="mono">${s.up.slice(0,6).map(fmtF).join("<br>")||'<span class="hint">ask licensee</span>'}${s.up.length>6?`<br><span class="hint">+${s.up.length-6}</span>`:""}
          <div class="hint" style="font-family:var(--font)">${esc([...new Set(s.down.map(c=>c.up_src).filter(Boolean))].join(", "))}</div></td>
        <td>${st?`${num(st.dist_mi,2)} mi ${esc(st.compass)} (${st.bearing}°)<div class="hint">${s.n_sites} site${s.n_sites===1?"":"s"}</div>`:""}</td>
        <td class="n">${num(s.best_out,0)}</td><td class="n">${num(s.best_in,0)}</td><td class="n" style="color:${s.margin_db==null?"":s.margin_db<0?"var(--bad)":s.margin_db<10?"var(--warn)":"var(--good)"}">${num(s.margin_db,0)}</td>
        <td>${dasTerrainCell(s, (ps.terrain||{})[s.call_sign])}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="hint">Downlink: what the agency's sites transmit (the building's donor antenna hears it). Uplink: what the radios transmit, from each licence's mobile entries, or the fixed 800 MHz (−45 MHz) and 700 MHz (+30 MHz) offsets. Bearing is from the building to the site: point the donor antenna there.</p></div>
    <div id="psCell" style="margin-top:10px"></div>`;
  window.dasCellPresurvey?.($("#psCell"), j, save);  // the commercial carriers here (dascell.js)
  // the chosen systems' channel plan is saved with the job, so the AHJ report and exports have it without the FCC data
  const store=async patch=>{ const incl=new Set(patch.include??[...inc]);
    j=await save({presurvey:{...(j.data.presurvey||{}),...P,...patch, plan:planOf(r.systems.filter(s=>incl.has(s.call_sign)))}}); dasPresurvey(el, j, save); };
  $("#psLet").onclick=()=>dasConsent(j, chosen);
  el.querySelectorAll("[data-cs]").forEach(c=>c.onchange=()=>{ c.checked?inc.add(c.dataset.cs):inc.delete(c.dataset.cs); store({include:[...inc]}); });
  // the agencies an ERCES is for: fire, EMS, police, 911 and emergency management (not every government radio user)
  // whole words in the licensee's name (the importer's categories also match "Firebird" and "Marshall Academy"), plus
  // the county / city / state trunked systems most fire departments actually talk on
  $("#psPick").onclick=()=>{ for(const s of r.systems){ const n=s.licensee||"";
      if(/\b(FIRE|POLICE|SHERIFF|SHERIFF'S|RESCUE|EMS|911|E911|EMERGENCY COMMUNICATIONS|EMERGENCY MANAGEMENT|PUBLIC SAFETY)\b/i.test(n)
        ||(s.trunked&&/\b(COUNTY|CITY|STATE|COMMONWEALTH|TOWN|DISTRICT OF COLUMBIA|PARISH|BOROUGH)\b/i.test(n))) inc.add(s.call_sign); }
    store({include:[...inc]}); };
  $("#psNone").onclick=()=>store({include:[]});
  $("#psTer").onclick=async()=>{ const list=(inc.size?chosen:r.systems.slice(0,20)).filter(s=>s.sites[0]);
    const b=$("#psTer"); b.disabled=true; b.textContent="⛰ Checking paths…";
    try{ const res=await post("/api/das/terrain",{lat:d.lat, lon:d.lon, roof_m:dasRoof(d), sites:list.map(s=>({key:s.call_sign, lat:s.sites[0].lat, lon:s.sites[0].lon,
        height_m:s.sites[0].height_m, freq:s.down[0]?.freq}))});
      const terrain={...(ps.terrain||{})};
      for(const s of list){ const x=res.paths[s.call_sign]; if(x) terrain[s.call_sign]={...x, site:`${s.sites[0].lat},${s.sites[0].lon}`, roof_m:dasRoof(d)}; }
      store({terrain}); }catch(e){ b.disabled=false; b.textContent="⛰ Terrain paths"; alert(e.message); } };
  for(const [id,k] of [["#psR","radius"],["#psL","loss"],["#psT","threshold"]]) $(id).onchange=e=>{ P[k]=+e.target.value; store({}); };
  $("#psLp").onchange=e=>{ if(e.target.value!==""){ P.loss=+e.target.value; store({}); } };
  $("#psPlan").onclick=()=>dasDl(`${fileSafe(j.name)} channel plan.csv`, csvOf(plan), "text/csv");
  // boosters whose FCC grants take in every chosen channel, down and up (fccid.boosters_for), by booster class and power
  const byBand=[...bands].sort((a,b)=>a[1].lo-b[1].lo).map(([name,x])=>`band=${encodeURIComponent(name+"|"+[...x.set].join(","))}`);
  const pref=(k,d)=>{ try{ return localStorage.getItem(k)??d; }catch(e){ return d; } }, keepPref=(k,v)=>{ try{ localStorage.setItem(k,v); }catch(e){} };
  const CLS={"B9A,B9B":"Part 90 boosters (Class A or B)", "B9A":"Part 90 Class A (channelized)", "B9B":"Part 90 Class B (wideband)", "B2I,B2P,B2W":"Part 20 (cellular) boosters", "":"any device kept"};
  const short=cs=>[...new Set((cs||[]).map(c=>({B9A:"Class A", B9B:"Class B", B2I:"Part 20", B2P:"Part 20", B2W:"Part 20", BOS:"other booster"})[c]).filter(Boolean))].join(" / ");
  const boost=()=>{ const cls=pref("rfr.boostCls","B9A,B9B"), w=pref("rfr.boostW","");
    api(`/api/fccid/boosters?${byBand.join("&")}&cls=${encodeURIComponent(cls)}&watts=${encodeURIComponent(w)}`).then(b=>{ const box=$("#psBoost"), kept=b.kept||{}; if(!box?.isConnected||!kept.devices) return;
      const bandTxt=bs=>bs.slice(0,8).map(([lo,hi])=>lo===hi?`${+lo}`:`${+lo}–${+hi}`).join(", ")+(bs.length>8?` +${bs.length-8}`:"");
      const dev=x=>`<a href="${esc(x.view)}" target="_blank" rel="noopener" class="mono" title="${esc(bandTxt(x.bands))} MHz · granted ${esc(x.granted)}">${esc(x.fcc_id)}</a> <span class="hint">${esc([x.maker, short(x.classes), wattsTxt(x)].filter(Boolean).join(" · "))}</span>`;
      box.innerHTML=`<h3 style="margin:12px 0 4px">Boosters granted for these channels <span class="hint">· newest grant first</span></h3>
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin:2px 0 6px"><select id="pbCls">${Object.entries(CLS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("")}</select>
          <label class="inl">strongest band at least <select id="pbW"><option value="">any power</option>${[0.5,1,2,5,10].map(v=>`<option value="${v}">${v} W</option>`).join("")}</select></label></div>
        ${b.count?`<p style="margin:4px 0">${b.count} granted for every band here, the newest: ${b.devices.slice(0,6).map(dev).join(", ")}</p>`
          :`<p class="hint" style="margin:4px 0">None is granted for all ${b.by_band.length} bands: a multi-band system takes one unit (or module) per band, or per band group.</p>`}
        <div class="tw"><table><thead><tr><th>Band</th><th class="n">Granted for all its channels</th><th>Newest</th></tr></thead><tbody>${b.by_band.map(x=>`<tr><td>${esc(x.band)}</td><td class="n">${x.count}</td><td>${x.devices.slice(0,3).map(dev).join("<br>")||'<span class="hint">none</span>'}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint">From the FCC's grant search (${esc(kept.at||"")}): ${kept.devices.toLocaleString()} devices of ${(kept.makers||0).toLocaleString()} makers, every signal booster by class, and power ranges for Part 90 boosters (the range of each one's strongest band). A grant shows what a device is certified for, not that it suits this building: exact watts per band are on each device's FCC grant (its FCC ID opens it; point at it for its bands).</p>`;
      $("#pbCls").value=cls; $("#pbW").value=w;
      $("#pbCls").onchange=e=>{ keepPref("rfr.boostCls", e.target.value); boost(); };
      $("#pbW").onchange=e=>{ keepPref("rfr.boostW", e.target.value); boost(); }; }).catch(()=>{}); };
  if(byBand.length) boost();
  const sysRows=()=>r.systems.map(s=>({included:inc.has(s.call_sign)?"yes":"", agency:s.licensee, call_sign:s.call_sign, service:s.service_name, category:s.category, trunked:s.trunked?"yes":"no",
    technology:s.tech.join(" / "), downlink_mhz:s.down.map(c=>c.freq).join(" "), uplink_mhz:s.up.join(" "), best_site_mi:s.sites[0]?.dist_mi, bearing_deg:s.sites[0]?.bearing,
    outdoor_dbm:s.best_out, indoor_dbm:s.best_in, margin_db:s.margin_db}));
  $("#psCsv").onclick=()=>dasDl(`${fileSafe(j.name)} pre-survey.csv`, csvOf(sysRows()), "text/csv");
  const siteRows=()=>{ const out=[]; for(const s of (inc.size?chosen:r.systems)) for(const st of s.sites) out.push({layer:"uls", lat:st.lat, lon:st.lon, dist_mi:st.dist_mi, compass:st.compass, freq_mhz:st.freqs[0],
    licensee:s.licensee, call_sign:s.call_sign, label:s.licensee, sig_type:s.tech[0]||"Unknown", est_rx_dbm:st.best_out}); return out; };
  $("#psKml").onclick=()=>{ const x=s=>String(s??"").replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
    const pm=siteRows().map(s=>`<Placemark><name>${x(s.licensee)} ${x(s.call_sign)}</name><description>${x(`${s.dist_mi} mi ${s.compass}, est ${num(s.est_rx_dbm,0)} dBm outside`)}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`
      +`<Placemark><name>Donor bearing to ${x(s.call_sign)}</name><LineString><coordinates>${d.lon},${d.lat},0 ${s.lon},${s.lat},0</coordinates></LineString></Placemark>`).join("");
    const ol=d.building?.outline?`<Placemark><name>${x(j.name)} outline</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${d.building.outline.map(([a,b])=>`${b},${a},0`).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`:"";
    dasDl(`${fileSafe(j.name)} pre-survey.kml`, `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(j.name)} pre-survey</name><Placemark><name>${x(j.name)}</name><Point><coordinates>${d.lon},${d.lat},0</coordinates></Point></Placemark>${ol}${pm}</Document></kml>`, "application/vnd.google-earth.kml+xml"); };
  $("#psTak").onclick=()=>RFTak.save({rows:siteRows(), center:[d.lat,d.lon], radius:P.radius, name:`RF Recon - ${j.name} pre-survey`, colorOf, typeOf, fccDate:null,
    outline:d.building?.outline?{name:`${j.name} outline`, points:d.building.outline}:null});
  if(typeof L!=="undefined"){ const map=L.map("psMap",{preferCanvas:true}); addMapLayers(map); L.marker([d.lat,d.lon],{icon:pinIcon(),title:j.name}).addTo(map);
    if(d.building?.outline) L.polygon(d.building.outline,{color:"#f0a020", weight:2, fillOpacity:.15}).bindTooltip(dasBuildingLine(d.building)).addTo(map);
    const pts=[[d.lat,d.lon]];
    for(const s of (inc.size?chosen:r.systems.slice(0,25))) for(const st of s.sites.slice(0,3)){ pts.push([st.lat,st.lon]);
      L.polyline([[d.lat,d.lon],[st.lat,st.lon]],{color:inc.has(s.call_sign)?"var(--accent)":"#888",weight:inc.has(s.call_sign)?2:1,opacity:.7,dashArray:"4 4"}).addTo(map);
      L.circleMarker([st.lat,st.lon],{radius:5,color:"#0008",weight:1,fillColor:inc.has(s.call_sign)?"#e5534b":"#57606a",fillOpacity:.9}).bindTooltip(`${s.licensee} ${s.call_sign}<br>${st.dist_mi} mi ${st.compass}, est ${num(st.best_out,0)} dBm`).addTo(map); }
    map.fitBounds(L.latLngBounds(pts).pad(0.15)); }
}

/* ---------- requirements ---------- */
function dasRequire(el, j, save){
  const d=j.data||{}, req=d.require||{}, prof=d.profile||{};
  const rows=[["Signal at each test location", DASJ.threshold==null?"No dBm floor (DAQ decides)":`≥ ${DASJ.threshold} dBm downlink (uplink too where the AHJ asks)`],
    ["Audio quality", `DAQ ≥ ${DASJ.daq} downlink and uplink; design to 3.4. Measured equivalent: SINR ≥ ${daqEq().sinr} dB with BER ≤ ${daqEq().ber}%`],
    ["Coverage", `${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas, each floor`],
    ["Grid test", `${DAS.grids} roughly equal areas per floor, one test point near each centre; more than 1 failed area fails the floor. With exactly 2 failed, the floor may be re-divided into 40 and passes with no more than 2 non-adjacent failures. Areas 20–80 ft across; floors over 128,000 sq ft split into sectors`],
    ["Test radio", "A calibrated portable of the agency's current model, through the agency's system; two radios keyed at once on different channels (one within 10 ft of an indoor antenna, one at the farthest point)"],
    ["Isolation", "Donor to server antennas at least the system gain + 20 dB"],
    ["Standby power", `${DASJ.battery_h} h at 100% load (or 2 h battery plus a generator); low-battery signal at 70% depletion`],
    ["Equipment", "UL 2524 listed; amplifiers in NEMA 4 / 4X enclosures, batteries in NEMA 3R"],
    ["Supervision", "To a listed fire alarm panel: AC loss, charger failure, donor antenna / signal source, active RF device, battery at 70%, critical component, the panel link, oscillation; an annunciator in the fire command center"],
    ["Noise at the agency site", "Rise under 1 dB with the booster on (10 kHz RBW, 5 min average), then 3 dB more margin"],
    ["Annual", "Grid retest, gain checked against acceptance, 1 h battery load test, oscillation check, report to the fire code official"],
    ["FCC", "Licensee's written consent before activation (47 CFR 90.219(b)(1)); Class B registered with the FCC; 5 W ERP per channel; in-band noise −43 dBm ERP / 10 kHz"],
    ["People", "Tester holds an FCC GROL plus in-building or manufacturer training; many AHJs also ask NICET"]];
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>This AHJ's numbers <span class="hint">· pass / fail on the grid test and report use these</span></h3>
      <div class="row" style="margin-bottom:6px">${Object.keys(DAS_PROFILES).map(k=>`<button data-pf="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      <div class="row"><label>Downlink ≥ dBm<input id="pf_threshold" type="number" value="${DASJ.threshold??""}" placeholder="none" style="width:80px"></label><label>DAQ ≥<input id="pf_daq" type="number" step="0.1" value="${DASJ.daq}" style="width:64px"></label>
        <label>General %<input id="pf_general_pct" type="number" value="${DASJ.general_pct}" style="width:64px"></label><label>Critical %<input id="pf_critical_pct" type="number" value="${DASJ.critical_pct}" style="width:64px"></label>
        <label>Battery h<input id="pf_battery_h" type="number" value="${DASJ.battery_h}" style="width:64px"></label></div>
      <p class="hint">${Object.keys(prof).length?"Set for this job.":"Defaults (IFC 2021 + NFPA 1225)."} Local amendments differ: some AHJs ask DAQ 3.4 (Orange County Sheriff, Burbank, Pierce County), −95 dBm both ways, 24 h batteries, or Class A boosters only.</p></div>
    <div class="panel"><h3>What the code asks <span class="hint">· ${esc(d.code||"IFC 510 + NFPA 1225")}; your AHJ's amendments win</span></h3>
      <div class="kvg">${rows.map(([k,v2])=>`<div>${esc(k)}</div><div>${esc(v2)}</div>`).join("")}</div>
      <p class="hint" id="drSrc" style="margin-top:8px"></p></div>
    <div class="panel"><h3>Critical areas in this building</h3>${DAS.critical_areas.map(a=>`<label class="inl" style="display:flex;padding:3px 0"><input type="checkbox" data-ca="${esc(a)}" ${(req.critical||[]).includes(a)?"checked":""}> ${esc(a)}</label>`).join("")}
      <label style="margin-top:8px">Other critical areas (one per line)<textarea id="drOther" rows="3" style="width:100%">${esc((req.other||[]).join("\n"))}</textarea></label>
      <p class="hint">These become rows in the Grid test, each tested on its own.</p></div></div>
    <div id="drCell" style="margin-top:10px"></div>`;
  $("#drSrc").innerHTML=DAS_SOURCES;
  window.dasCellRequire?.($("#drCell"), j, save);  // commercial cellular targets (dascell.js)
  const setProf=async p=>{ j=await save({profile:p}); DASJ={...DAS,...p}; render(); };
  el.querySelectorAll("[data-pf]").forEach(b=>b.onclick=()=>setProf({...DAS_PROFILES[b.dataset.pf]}));
  const PK=["threshold","daq","general_pct","critical_pct","battery_h"];
  for(const k of PK) $(`#pf_${k}`).onchange=e=>setProf({...Object.fromEntries(PK.map(x=>[x,DASJ[x]])), [k]:e.target.value===""?null:+e.target.value});
  el.querySelectorAll("[data-ca]").forEach(c=>c.onchange=async()=>{ const set=new Set((j.data.require||{}).critical||[]); c.checked?set.add(c.dataset.ca):set.delete(c.dataset.ca); j=await save({require:{...(j.data.require||{}),critical:[...set]}}); });
  $("#drOther").onchange=async e=>{ j=await save({require:{...(j.data.require||{}),other:e.target.value.split("\n").map(s=>s.trim()).filter(Boolean)}}); };
}

/* ---------- grid test: a grid per floor (over the floor plan when there is one), critical areas, any tool's results ---------- */
// A reading passes with the downlink at or above the threshold and audio quality met: DAQ when it was scored, or the
// measured equivalent (SINR and BER) when that's what the tool reported. Uplink level and DAQ count when present.
// measured equivalent of the profile's DAQ for P25 Phase 1: DAQ 3.0 = SINR 18 dB / BER 2.5% (NFPA 1225 A.20.3.10),
// DAQ 3.4 = 17.7 dB / 2% (TSB-88.1-D/E, C4FM narrow IF, faded). The 19 dB often quoted for 3.4 is the VSELP/LSM row.
// 17.7 sits under NFPA's 18 dB for 3.0, and a stricter DAQ never accepts a lower SINR, so 3.4 keeps the higher of the two.
const daqEq = () => DASJ.daq>=3.4 ? {sinr:Math.max(17.7, DAS.sinr), ber:2} : {sinr:DAS.sinr, ber:DAS.ber};
const has = x => x!=null && x!=="";
const gridPass = r => { if(!r||!(has(r.dl)||has(r.daq)||has(r.sinr))) return null;
  const dq = has(r.daq) ? +r.daq>=DASJ.daq : (has(r.sinr)||has(r.ber)) ? (!has(r.sinr)||+r.sinr>=daqEq().sinr)&&(!has(r.ber)||+r.ber<=daqEq().ber) : true;
  const lvl = v => DASJ.threshold==null || !has(v) || +v>=DASJ.threshold;
  return lvl(r.dl) && dq && lvl(r.ul) && (!has(r.ul_daq)||+r.ul_daq>=DASJ.daq); };
// Only a reading taken with a calibrated instrument counts toward pass / fail: the code asks for calibrated test equipment
// and the AHJ report lists each instrument's calibration date. Each reading names what took it (r.inst: an instrument's
// "model|serial" from the Overview, or "uncal" for an SDR, a phone app or a quick check); the rest stay on the plan as
// pre-survey and are left out of the score. The instrument's calibration must be within DAS.cal_months of the reading.
const instKey = i => `${i.model}|${i.serial||""}`;
const instName = i => [i.model, i.serial].filter(Boolean).join(" ");
function instState(i, at=Date.now()){ const cal=Date.parse(i.cal||"");
  if(!isFinite(cal)) return {ok:false, why:"no calibration date"};
  return at-cal > DAS.cal_months*30.44*864e5 ? {ok:false, why:`calibration over ${DAS.cal_months} months old`} : {ok:true, why:`calibrated ${i.cal}`}; }
function calOf(d, r){ if(!r||!(has(r.dl)||has(r.daq)||has(r.sinr))) return null;
  if(r.inst==="uncal") return {ok:false, why:"not calibrated (pre-survey)", name:"not calibrated"};
  const i=((d.testing||{}).instruments||[]).find(x=>instKey(x)===r.inst);
  if(!i) return {ok:false, why:r.inst?"instrument no longer on the job's list":"no instrument recorded", name:r.inst?r.inst.replace("|"," "):"not recorded"};
  return {...instState(i, Date.parse(r.time||"")||Date.now()), name:instName(i)}; }
// A square can hold several readings (r.readings): one per channel or system, and cellular ones (LTE / 5G: kept and shown,
// never scored against these public-safety rules; an RSRP isn't a -95 dBm downlink). eff() gives the reading that decides
// the square: the worst one taken with a calibrated instrument (a failing one first, then the lowest level), so a square
// passes only when every channel does. A square saved before readings were kept per channel is one plain reading.
const CELL_TECH=/\b(LTE|NR|5G|4G|3G|UMTS|WCDMA|HSPA|GSM|CDMA|EV-?DO)\b/i;
const isCell = x => (has(x.tech)&&CELL_TECH.test(String(x.tech))) || has(x.rsrp) || has(x.rsrq);
const chKey = x => [x.tech, x.carrier, x.freq, x.pci].map(v=>String(v??"").trim().toLowerCase()).join("|");  // FirstNet and AT&T share Band 14 cells
const readingsOf = r => !r ? [] : Array.isArray(r.readings) ? r.readings : (has(r.dl)||has(r.daq)||has(r.sinr)) ? [r] : [];
function eff(d, r){ const rs=r&&Array.isArray(r.readings)?r.readings:null; if(!rs) return r;
  const lmr=rs.filter(x=>!isCell(x)&&(has(x.dl)||has(x.daq)||has(x.sinr))), ok=lmr.filter(x=>calOf(d,x)?.ok), pool=ok.length?ok:lmr;
  const lvl=x=>[has(x.dl)?+x.dl:1e9, has(x.daq)?+x.daq:1e9, has(x.sinr)?+x.sinr:1e9];
  const worst=[...pool].sort((a,b)=>{ const fa=gridPass(a)===false, fb=gridPass(b)===false; if(fa!==fb) return fa?-1:1;
    const ka=lvl(a), kb=lvl(b); return ka[0]-kb[0]||ka[1]-kb[1]||ka[2]-kb[2]; })[0];
  return {...(worst||{}), readings:rs, at:worst?rs.indexOf(worst):-1, channels:lmr.length, cellular:rs.length-lmr.length}; }
// pass / fail for the score: null when untested or not counted
const scored = (d, r) => { const c=calOf(d, r); return c&&c.ok ? gridPass(r) : null; };
const notCounted = (d, r) => { const c=calOf(d, r); return !!c && !c.ok; };
// per floor: do-not-test squares leave the count; squares marked critical are judged against the critical percentage
function floorStats(d, f){ const res=(d.grid||{}).results||{}, n=(f.grids||DAS.grids), skip=new Set(f.skip||[]), crit=new Set(f.critical||[]);
  const o={n, tested:0, pass:0, gen:0, genPass:0, crit:0, critPass:0, untested:0, notCounted:0};
  for(let g=1; g<=n; g++){ if(skip.has(g)) continue; const r=eff(d, res[`${f.name}|${g}`]), p=scored(d, r), c=crit.has(g);
    if(notCounted(d, r)) o.notCounted++;
    c?o.crit++:o.gen++; if(p==null){ o.untested++; continue; } o.tested++; if(p){ o.pass++; c?o.critPass++:o.genPass++; } }
  o.counted=o.gen+o.crit; o.pct=o.counted?Math.round(100*o.pass/o.counted):0;
  o.genPct=o.gen?Math.round(100*o.genPass/o.gen):100; o.critPct=o.crit?Math.round(100*o.critPass/o.crit):100;
  o.ok=o.untested===0 && o.genPct>=DASJ.general_pct && o.critPct>=DASJ.critical_pct; return o; }
async function dasGrid(el, j, save){
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], G=d.grid||{}, res=G.results||{}, base=d.baseline||null;
  if(!floors.length){ el.innerHTML='<p class="status">Set the number of floors on the Overview first.</p>'; return; }
  const D=S.das; D.floor=floors.some(f=>f.name===D.floor)?D.floor:floors[0].name; D.mark=D.mark||"read";
  const f=floors.find(x=>x.name===D.floor), n=f.grids||DAS.grids, cols=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), rows=Math.ceil(n/cols);
  const skip=new Set(f.skip||[]), critSet=new Set(f.critical||[]);
  // the grid sits on the plan where you put it (Place grid: drag, resize, rotate); the plan keeps its own shape. Its real
  // width in feet (shared with the Design tab) gives each square's size
  const planSrc=f.plan?await jobFileSrc(j.id, f.plan):null, hasPlan=!!planSrc;
  if(D.mark==="place"&&!hasPlan) D.mark="read";
  const box=boxOf(f), place=D.mark==="place", wft=(((d.design||{}).floors||{})[f.name]||{}).width_ft||null;
  // Show: the public-safety score, or one carrier's cellular coverage against the job's cellular target (dascell.js)
  const cl=window.cellLayers?cellLayers(d):[]; if(!cl.some(x=>x.key===D.gview)) D.gview="";
  const cv=D.gview||null, cvL=cl.find(x=>x.key===cv), cvP=cv?cellProfile(d):null;
  const cellCards=()=>floors.map(fl=>{ const s=cellFloor(d,fl,cv); return `<div class="card" data-fl="${esc(fl.name)}" style="cursor:pointer;${fl.name===D.floor?"outline:2px solid var(--accent)":""}">
    <div class="v" style="color:${!s.tested?"var(--muted)":s.ok?"var(--good)":"var(--bad)"}">${s.tested?s.pct+"%":"–"}</div><div class="k">Floor ${esc(fl.name)} · ${esc(cvL.carrier)} ${s.pass}/${s.tested} at target${s.untested?` · ${s.untested} untested`:""}${s.noSinr?` · ${s.noSinr} without SINR`:""}</div></div>`; }).join("");
  const files=(await api(`/api/das/jobs/${j.id}/files`).catch(()=>({files:[]}))).files.filter(x=>/\.(png|jpe?g|gif|webp|svg)$/i.test(x.name));
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])];
  const cr=G.critical||{}, critTested=crit.filter(a=>scored(d,cr[a])!=null), critPass=crit.filter(a=>scored(d,cr[a]));
  const st=floors.map(x=>({f:x, ...floorStats(d,x)}));
  // what takes the readings entered or imported here (kept with the job); readings saved before readings named their
  // instrument don't count until someone says what took them
  const insts=(d.testing||{}).instruments||[], inst=G.inst||"";
  const instOpts=sel=>`${insts.map(i=>{ const s=instState(i); return `<option value="${esc(instKey(i))}" ${instKey(i)===sel?"selected":""}>${esc(instName(i))} · ${esc(s.why)}${s.ok?"":" (won't count)"}</option>`; }).join("")}
    <option value="uncal" ${sel==="uncal"?"selected":""}>Not calibrated: an SDR, a phone app, a quick check (pre-survey)</option>`;
  const unnamedRes=Object.keys(res).filter(k=>readingsOf(res[k]).some(x=>calOf(d,x)&&!x.inst)), unnamedCr=Object.keys(cr).filter(k=>calOf(d,cr[k])&&!cr[k].inst), unnamed=unnamedRes.length+unnamedCr.length;
  // NFPA 1225: 20 squares per floor, each 20-80 ft across; floors over 128,000 sq ft split into sectors
  const per=d.area_sqft&&floors.length?d.area_sqft/floors.length:null, side=per?Math.sqrt(per/(n-skip.size||n)):null;
  const warn=[]; if(n<DAS.grids) warn.push(`${n} squares is fewer than the ${DAS.grids} the code asks for.`);
  if(per&&per>DAS.sector_sqft) warn.push(`About ${Math.round(per).toLocaleString()} sq ft per floor: floors over ${DAS.sector_sqft.toLocaleString()} sq ft are split into sectors of ${DAS.grids} squares each.`);
  else if(hasPlan&&wft) {}  // measured on the plan instead (#dgSize)
  else if(side&&side>DAS.cell_ft[1]) warn.push(`Each square is about ${Math.round(side)} ft across, over the ${DAS.cell_ft[1]} ft limit: add squares.`);
  else if(side&&side<DAS.cell_ft[0]) warn.push(`Each square is about ${Math.round(side)} ft across, under ${DAS.cell_ft[0]} ft: fewer squares will do.`);
  const delta=g=>{ const b=eff(d, base?.results?.[`${f.name}|${g}`]), r=eff(d, res[`${f.name}|${g}`]); return b&&r&&has(b.dl)&&has(r.dl)?Math.round(+r.dl-+b.dl):null; };
  el.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Floor <select id="dgF">${floors.map(x=>`<option ${x.name===D.floor?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="inl">Squares <input id="dgN" type="number" min="1" max="100" value="${n}" style="width:64px"></label>
      <label class="inl">Columns <input id="dgC" type="number" min="1" max="20" value="${cols}" style="width:56px"></label>
      <label class="inl">Floor plan <select id="dgPlan"><option value="">— none —</option>${files.map(x=>`<option ${x.name===f.plan?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      ${hasPlan?`<label class="inl" title="The plan's real width in feet, from the drawing's scale or dimensions. The Design tab uses the same number">Plan width <input id="dgW" type="number" step="any" min="1" value="${wft??""}" placeholder="ft" style="width:72px"> ft</label>`:""}
      <div class="seg" id="dgMark" title="What a click on a square does">${[["read","Enter readings"],["skip","Do not test"],["crit","Critical"],...(hasPlan?[["place","Place grid"]]:[])].map(([k,l])=>`<button data-m="${k}" class="${D.mark===k?"on":""}">${l}</button>`).join("")}</div>
      ${place?`<label class="inl" title="Turn the grid to line up with the building on the plan">Rotate <input id="dgRot" type="number" step="0.5" min="-180" max="180" value="${box.rot}" style="width:64px">°</label><button id="dgFit" title="The grid covers the whole plan again, square to it">Fit to plan</button>`:""}
      ${cl.length?`<label class="inl" title="The public-safety score, or one carrier's coverage against the cellular target (Requirements)">Show <select id="dgView"><option value="">Public safety</option>${cl.map(x=>`<option value="${esc(x.key)}" ${x.key===cv?"selected":""}>${esc(x.label)}${x.required?"":" (not required)"}</option>`).join("")}</select></label>`:""}
      <label class="inl" title="What takes the readings you enter or import here. Only an instrument calibrated within ${DAS.cal_months} months counts toward pass / fail; add instruments on the Overview (model | serial | calibration date)">Taken with
        <select id="dgInst"><option value="">— pick —</option>${instOpts(inst)}</select></label>
      <label class="inl" title="Results from any tool: CSV, TSV, Excel, JSON, KML/KMZ or GPX">Import results <input type="file" id="dgImp" accept=".csv,.tsv,.txt,.xlsx,.json,.kml,.kmz,.gpx"></label>
      <button id="dgCsv" title="One row per square: the reading that decides it">⇩ Results CSV</button><button id="dgAll" title="Every reading, one row per channel, cellular ones too: imports back into RF Recon or into another tool">⇩ All readings CSV</button><button id="dgJson">⇩ Results JSON</button>
      <button id="dgBase" title="Keep these results as the acceptance test, to compare each annual retest with">${base?`Baseline: ${esc(base.date)} · replace`:"Save as acceptance baseline"}</button></div>
    ${warn.length?`<p class="status err" style="margin:0 2px 8px">${warn.map(esc).join(" ")}</p>`:""}
    ${f.plan&&!hasPlan?`<p class="status err" style="margin:0 2px 8px">Couldn't open the floor plan ${esc(f.plan)}: is it still in the job's Files?</p>`:""}
    ${!inst?`<p class="status" style="margin:0 2px 8px">Pick what's taking the readings (<b>Taken with</b>) before you enter or import any.${insts.length?"":" Add your instruments on the Overview first: model | serial | calibration date."}</p>`:""}
    ${unnamed?`<p class="status err" style="margin:0 2px 8px">${unnamed} reading${unnamed===1?" doesn't":"s don't"} say what took ${unnamed===1?"it":"them"}, so ${unnamed===1?"it doesn't":"they don't"} count.
      Taken with <select id="dgFix"><option value="">— pick —</option>${instOpts("")}</select> <button id="dgFixGo">Apply to ${unnamed===1?"it":`these ${unnamed}`}</button></p>`:""}
    <div class="cards" style="margin-bottom:10px">${cv?cellCards():""}${(cv?[]:st).map(x=>`<div class="card" data-fl="${esc(x.f.name)}" style="cursor:pointer;${x.f.name===D.floor?"outline:2px solid var(--accent)":""}" title="General ${x.genPass}/${x.gen}, critical ${x.critPass}/${x.crit}, ${x.untested} untested${x.notCounted?`, ${x.notCounted} not counted (no calibrated instrument)`:""}">
        <div class="v" style="color:${x.untested?"var(--muted)":x.ok?"var(--good)":"var(--bad)"}">${x.genPct}%</div><div class="k">Floor ${esc(x.f.name)} · ${x.genPass}/${x.gen} general${x.crit?` · ${x.critPass}/${x.crit} critical`:""}${x.untested?` · ${x.untested} untested`:""}${x.notCounted?` · ${x.notCounted} not counted`:""}</div></div>`).join("")}
      ${crit.length&&!cv?`<div class="card"><div class="v" style="color:${critTested.length<crit.length?"var(--muted)":critPass.length===crit.length?"var(--good)":"var(--bad)"}">${critPass.length}/${crit.length}</div><div class="k">Named critical areas pass</div></div>`:""}</div>
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(320px,2fr) minmax(260px,1fr)">
      <div class="panel"><h3>Floor ${esc(f.name)} <span class="hint">· ${place?"drag the grid to move it, the corner dot to size it, the top dot to turn it":D.mark==="read"?"click a square to enter its readings":D.mark==="skip"?"click squares that aren't tested (shafts, closets the AHJ excludes)":"click squares that are critical areas"} · ${cv?`${esc(cvL.carrier)}, ${esc(LAYER_NAME[cvL.layer])}: pass = its best cell ≥ ${cellThr(cvP, cvL.carrier, cvL.layer)} dBm RSRP${cvP.sinr!=null?` and SINR ≥ ${cvP.sinr} dB`:""}; ${cvP.pct}% of tested squares (${esc(cvP.name)})`:`pass = ≥ ${DASJ.threshold} dBm and DAQ ≥ ${DASJ.daq} (or SINR ≥ ${daqEq().sinr} dB, BER ≤ ${daqEq().ber}%) on every channel, from a calibrated instrument; grey = not counted`}</span></h3>
        <div id="dgWrap" style="position:relative;width:100%;${hasPlan?"":`aspect-ratio:${cols}/${rows};`}border-radius:10px;overflow:${place?"visible":"hidden"}">
          ${hasPlan?`<img id="dgImg" src="${planSrc}" alt="Floor ${esc(f.name)} plan" draggable="false" style="display:block;width:100%;height:auto;user-select:none;pointer-events:none">`:""}
          <div id="dgCells" style="position:absolute;${boxCss(f, hasPlan)};display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)${place?";outline:2px dashed var(--accent);cursor:move;touch-action:none":""}">
          ${Array.from({length:n},(_,i)=>{ const g=i+1, r=eff(d, res[`${f.name}|${g}`]), p=scored(d,r), cal=calOf(d,r), nc=cal&&!cal.ok, sk=skip.has(g), c=critSet.has(g), dl=delta(g);
            if(cv&&!sk){ const s=cellSquare(d, res[`${f.name}|${g}`], cv);
              return `<button data-g="${g}" title="Square ${g}${c?" (critical)":""} · ${esc(s?s.why:"no cellular readings here")}" style="border:${c?"2px solid #fab219":"1px solid var(--line)"};border-radius:0;margin:0;padding:2px;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:12px;background:${s==null?"color-mix(in srgb,var(--panel) 35%,transparent)":s.pass?"color-mix(in srgb,#3ccf7a 45%,transparent)":"color-mix(in srgb,#e5534b 55%,transparent)"}${place?";pointer-events:none":""}">
                <b>${f.name}-${g}${c?" ★":""}</b><span class="mono">${s?.best?`${s.best.rsrp} RSRP`:s?"no signal":""}</span>${s?.best&&has(s.best.sinr)?`<span class="mono hint">SINR ${s.best.sinr}</span>`:""}${s?.best&&has(s.best.band)?`<span class="hint">band ${esc(s.best.band)}</span>`:""}</button>`; }
            const bg=sk?"repeating-linear-gradient(45deg,color-mix(in srgb,var(--panel) 60%,transparent) 0 6px,transparent 6px 12px)":nc?"color-mix(in srgb,#8c959f 40%,transparent)":p==null?"color-mix(in srgb,var(--panel) 35%,transparent)":p?"color-mix(in srgb,#3ccf7a 45%,transparent)":"color-mix(in srgb,#e5534b 55%,transparent)";
            return `<button data-g="${g}" title="Square ${g}${c?" (critical)":""}${sk?" (not tested)":""}${r?.channels>1?` · ${r.channels} channels; ${has(r.freq)?`${r.freq} decides`:"the worst decides"}`:""}${r?.cellular?` · ${r.cellular} cellular reading${r.cellular===1?"":"s"}, not scored`:""}${cal?(cal.ok?` · taken with ${cal.name}`:` · not counted: ${cal.why}${r.inst&&r.inst!=="uncal"?` (${cal.name})`:""}`):""}" style="border:${c?"2px solid #fab219":nc?"1px dashed var(--muted)":"1px solid var(--line)"};border-radius:0;margin:0;padding:2px;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:12px;background:${bg}${place?";pointer-events:none":""}">
              <b>${f.name}-${g}${c?" ★":""}</b>${sk?'<span class="hint">not tested</span>':`<span class="mono">${r&&has(r.dl)?`${r.dl} dBm`:""}</span><span class="mono hint">${r&&has(r.daq)?`DAQ ${r.daq}`:r&&has(r.sinr)?`${r.sinr} dB SINR`:""}</span>${r?.channels>1?`<span class="hint">worst of ${r.channels}</span>`:""}${r?.cellular?`<span class="hint">+${r.cellular} cellular</span>`:""}${nc?'<span class="hint">not counted</span>':""}${dl!=null?`<span class="mono hint">${dl>=0?"+":""}${dl} dB vs baseline</span>`:""}`}</button>`; }).join("")}
          ${place?`<span data-h="rot" title="Turn" style="position:absolute;left:50%;top:6px;width:16px;height:16px;margin-left:-8px;border-radius:50%;background:var(--accent);border:2px solid #fff;cursor:grab"></span>
            <span data-h="size" title="Size" style="position:absolute;right:4px;bottom:4px;width:16px;height:16px;border-radius:50%;background:var(--accent);border:2px solid #fff;cursor:nwse-resize"></span>`:""}</div></div>
        ${hasPlan?`<p class="hint" id="dgSize" style="margin:6px 2px 0">${wft?"":"Enter the plan's width in feet to check each square's size."}</p>`:""}
        <div id="dgEdit" style="margin-top:8px"></div></div>
      <div class="panel"><h3>Named critical areas</h3>${crit.length?`<table><thead><tr><th>Area</th><th>DL dBm</th><th>DAQ</th><th>UL dBm</th><th>UL DAQ</th><th></th></tr></thead><tbody>${crit.map(a=>{ const r=cr[a]||{}, p=scored(d,r), cal=calOf(d,r);
          return `<tr data-ca="${esc(a)}"><td>${esc(a)}</td>${["dl","daq","ul","ul_daq"].map(k=>`<td><input data-x="${k}" type="number" step="${/daq/.test(k)?"0.1":"1"}" value="${r[k]??""}" style="width:64px"></td>`).join("")}<td title="${cal?esc(cal.ok?`taken with ${cal.name}`:`not counted: ${cal.why}`):""}">${cal&&!cal.ok?'<span class="hint">not counted</span>':p==null?"":p?"✅":"❌"}</td></tr>`; }).join("")}</tbody></table>`
          :'<p class="hint">Pick the building\'s critical areas under Requirements, or mark critical squares on the plan.</p>'}</div></div>
    <div id="dgMap"></div>`;
  $("#dgF").onchange=e=>{ D.floor=e.target.value; render(); };
  el.querySelectorAll("[data-fl]").forEach(c=>c.onclick=()=>{ D.floor=c.dataset.fl; render(); });
  $("#dgMark").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.mark=b.dataset.m; render(); } };
  const setFloor=async patch=>{ const fl=(j.data.floors||[]).map(x=>x.name===f.name?{...x,...patch}:x); j=await save({floors:fl}); render(); };
  $("#dgN").onchange=e=>setFloor({grids:Math.max(1,Math.min(100,+e.target.value||DAS.grids))});
  $("#dgC").onchange=e=>setFloor({cols:Math.max(1,Math.min(20,+e.target.value||5))});
  $("#dgPlan").onchange=e=>setFloor({plan:e.target.value||null});
  $("#dgInst").onchange=async e=>{ j=await save({grid:{...(j.data.grid||{}), inst:e.target.value||null}}); render(); };
  $("#dgView")?.addEventListener("change", e=>{ D.gview=e.target.value; render(); });
  $("#dgFixGo")?.addEventListener("click", async()=>{ const v=$("#dgFix").value; if(!v){ $("#dgFix").focus(); return; }
    const G2=j.data.grid||{}, results={...(G2.results||{})}, critical={...(G2.critical||{})};
    for(const k of unnamedRes) results[k]=Array.isArray(results[k].readings)?{...results[k], readings:results[k].readings.map(x=>calOf(d,x)&&!x.inst?{...x, inst:v}:x)}:{...results[k], inst:v};
    for(const k of unnamedCr) critical[k]={...critical[k], inst:v};
    j=await save({grid:{...G2, results, critical}});
    await post(`/api/das/jobs/${j.id}/note`,{text:`Said what took ${unnamed} earlier reading${unnamed===1?"":"s"}: ${v==="uncal"?"not calibrated":v.replace("|"," ")}`}); render(); });
  const needInst=()=>{ if(inst) return false; $("#dgEdit").innerHTML='<p class="status err">Pick what\'s taking the readings first: <b>Taken with</b>, above.</p>'; $("#dgInst").focus(); return true; };
  $("#dgBase").onclick=async()=>{ if(base&&!confirm(`Replace the ${base.date} baseline with today's results?`)) return;
    j=await save({baseline:{date:today(), results:{...((j.data.grid||{}).results||{})}, critical:{...((j.data.grid||{}).critical||{})}}}); render(); };
  el.querySelectorAll("[data-g]").forEach(b=>b.onclick=()=>{ const g=+b.dataset.g;
    if(D.mark==="place") return;
    if(D.mark!=="read"){ const key=D.mark==="skip"?"skip":"critical", set=new Set(f[key]||[]); set.has(g)?set.delete(g):set.add(g); return setFloor({[key]:[...set].sort((a,c)=>a-c)}); }
    if(needInst()) return;
    // the square's readings, one per channel (and cellular ones): Save adds one, or replaces the one on the same channel
    const key=`${f.name}|${g}`, rs=readingsOf(res[key]), top=eff(d, res[key]);
    let editing=null;
    const KS=[["dl","DL dBm",1],["daq","DL DAQ",.1],["sinr","SINR dB",.1],["ber","BER %",.01],["ul","UL dBm",1],["ul_daq","UL DAQ",.1]];
    const cellTxt=x=>[x.carrier, x.tech, has(x.band)?`band ${x.band}`:"", has(x.rsrp)?`RSRP ${x.rsrp}`:"", has(x.rsrq)?`RSRQ ${x.rsrq}`:"", has(x.sinr)?`SINR ${x.sinr}`:"", has(x.pci)?`PCI ${x.pci}`:""].filter(Boolean).join(" · ");
    $("#dgEdit").innerHTML=`${rs.length?`<div class="tw" style="margin-bottom:8px"><table><thead><tr><th>Channel / MHz</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">SINR / BER</th><th class="n">UL dBm</th><th class="n">UL DAQ</th><th>Taken with</th><th>Result</th><th></th></tr></thead><tbody>${rs.map((x,i)=>{ const cal=calOf(d,x), p=gridPass(x), dec=top?.at===i;
        return `<tr><td>${esc(has(x.freq)?x.freq:"—")}${rs.length>1&&dec?' <span class="tag">decides</span>':""}</td>${isCell(x)?`<td colspan="5" class="hint">Cellular: ${esc(cellTxt(x))}</td>`:`<td class="n">${x.dl??""}</td><td class="n">${x.daq??""}</td><td class="n">${[x.sinr,has(x.ber)?x.ber+"%":""].filter(v=>has(v)).join(" / ")}</td><td class="n">${x.ul??""}</td><td class="n">${x.ul_daq??""}</td>`}
          <td>${esc(cal?cal.name:x.inst==="uncal"?"not calibrated":"")}</td><td>${isCell(x)?'<span class="hint">not scored</span>':cal&&!cal.ok?'<span class="hint">not counted</span>':p==null?"":p?"pass":"fail"}</td>
          <td style="white-space:nowrap">${isCell(x)?"":`<button data-ge="${i}">Edit</button> `}<button data-gx="${i}">Delete</button></td></tr>`; }).join("")}</tbody></table></div>`:""}
      <div class="row" style="align-items:flex-end"><b>Square ${f.name}-${g}</b><label>Channel / MHz<input id="ge_freq" placeholder="optional" style="width:110px"></label>${KS.map(([k,l,s])=>`<label>${l}<input id="ge_${k}" type="number" step="${s}" style="width:72px"></label>`).join("")}
      <label class="grow">Note<input id="ge_note"></label><button class="primary" id="geSave">${rs.length?"Save reading":"Save"}</button><button id="geClear" title="Remove every reading in this square">Clear square</button></div>
      <p class="hint" style="margin:4px 0 0">Saved as taken with ${esc(inst==="uncal"?"no calibrated instrument (pre-survey, not counted)":instName(insts.find(i=>instKey(i)===inst)||{model:inst}))}. ${rs.length?"A reading on a channel already here replaces it; a new channel adds a row. The square passes only when every channel passes.":"Add a channel to keep one reading per channel."}</p>`;
    const put=async list=>{ const results={...((j.data.grid||{}).results||{})}; if(list.length) results[key]={readings:list}; else delete results[key];
      j=await save({grid:{...(j.data.grid||{}),results}}); render(); };
    const fill=x=>{ $("#ge_freq").value=x?.freq??""; for(const [k] of KS) $(`#ge_${k}`).value=x?.[k]??""; $("#ge_note").value=x?.note||""; };
    // a square with one reading and no channel opens with it filled in, as before; otherwise the form adds a reading
    // (Edit on a row fills it in to change that one)
    if(rs.length===1&&!isCell(rs[0])&&!has(rs[0].freq)){ editing=0; fill(rs[0]); }
    $("#dgEdit").querySelectorAll("[data-ge]").forEach(b2=>b2.onclick=()=>{ editing=+b2.dataset.ge; fill(rs[editing]); $("#ge_dl").focus(); });
    $("#dgEdit").querySelectorAll("[data-gx]").forEach(b2=>b2.onclick=()=>put(rs.filter((_,i)=>i!==+b2.dataset.gx)));
    const v2=k=>$(`#ge_${k}`).value===""?null:+$(`#ge_${k}`).value;
    $("#geSave").onclick=()=>{ const x={freq:$("#ge_freq").value.trim()||null, dl:v2("dl"), daq:v2("daq"), sinr:v2("sinr"), ber:v2("ber"), ul:v2("ul"), ul_daq:v2("ul_daq"),
        note:$("#ge_note").value, time:new Date().toISOString(), source:"typed", inst};
      const rest=rs.filter((y,i)=>i!==editing&&chKey(y)!==chKey(x)); put([...rest, x]); };
    $("#geClear").onclick=()=>put([]); $("#ge_dl").focus(); });
  el.querySelectorAll("tr[data-ca] input").forEach(i=>i.onchange=async()=>{ if(needInst()){ render(); return; }
    const tr=i.closest("tr"), a=tr.dataset.ca, val={...((j.data.grid||{}).critical||{})[a]};
    val[i.dataset.x]=i.value===""?null:+i.value; val.inst=inst; val.time=new Date().toISOString();
    j=await save({grid:{...(j.data.grid||{}),critical:{...((j.data.grid||{}).critical||{}),[a]:val}}}); render(); });
  const flat=()=>dasFlat(j.data);
  $("#dgCsv").onclick=()=>dasDl(`${fileSafe(j.name)} grid test.csv`, csvOf(flat()), "text/csv");
  $("#dgJson").onclick=()=>dasDl(`${fileSafe(j.name)} grid test.json`, JSON.stringify({job:j.name, threshold_dbm:DASJ.threshold, daq:DASJ.daq, results:dasFlat(j.data, true)},null,1), "application/json");
  $("#dgImp").onchange=async e=>{ const file=e.target.files[0]; if(!file) return; let t;
    if(needInst()){ e.target.value=""; return; }
    try{ t=await api(`/api/das/parse?name=${encodeURIComponent(file.name)}`,{method:"POST",body:await file.arrayBuffer()}); }catch(err){ alert("Couldn't read that file: "+err.message); return; }
    dasMapImport($("#dgMap"), t, file.name, {floors, floor:D.floor}, async mapped=>{ const results={...((j.data.grid||{}).results||{})}; let n2=0, nCell=0;
      // every row is kept: several rows for one square (one per channel or system) all stay and the worst decides; a row
      // replaces what that square already had on the same channel, and the square's other channels stay
      const by={}, at=new Date().toISOString();
      for(const r of mapped){ const fl=r.floor||D.floor, g=r.grid; if(!g) continue; const {floor,grid,critical,...vals}=r;
        (by[`${fl}|${g}`]||=[]).push({...vals, time:vals.time||at, source:file.name, inst}); n2++; if(isCell(vals)) nCell++; }
      for(const [k,rows] of Object.entries(by)){ const keys=new Set(rows.map(chKey)); results[k]={readings:[...readingsOf(results[k]).filter(x=>!keys.has(chKey(x))), ...rows]}; }
      // floors named in the file that the job doesn't have yet are added; squares the file marks critical (the phone's
      // grid test does) join that floor's critical list
      const have=new Set((j.data.floors||[]).map(x=>x.name)), extra=[...new Set(mapped.map(r=>r.floor).filter(x=>x&&!have.has(x)))].map(x=>({name:x,grids:DAS.grids}));
      const isCrit=v=>/^(1|y|yes|true|critical)$/i.test(String(v??"").trim());
      const floors=[...(j.data.floors||[]),...extra].map(f=>{ const add=mapped.filter(r=>(r.floor||D.floor)===f.name&&isCrit(r.critical)).map(r=>+r.grid||r.grid);
        return add.length?{...f, critical:[...new Set([...(f.critical||[]),...add])]}:f; });
      j=await save({grid:{...(j.data.grid||{}),results}, floors});
      await post(`/api/das/jobs/${j.id}/note`,{text:`Imported ${n2} grid readings from ${file.name}${nCell?` (${nCell} cellular, kept but not scored)`:""}, taken with ${inst==="uncal"?"no calibrated instrument":inst.replace("|"," ")}`}); render(); }); };
  $("#dgAll").onclick=()=>dasDl(`${fileSafe(j.name)} all readings.csv`, csvOf(dasReadings(j.data)), "text/csv");
  // Place grid: drag the grid to move it, the corner dot to size it (about its centre, along its own sides), the top dot to turn it
  $("#dgW")?.addEventListener("change", async e=>{ const all=(j.data.design||{}).floors||{};
    j=await save({design:{...(j.data.design||{}), floors:{...all, [f.name]:{...(all[f.name]||{}), width_ft:+e.target.value||null}}}}); render(); });
  $("#dgRot")?.addEventListener("change", e=>setFloor({gridbox:{...box, rot:Math.max(-180,Math.min(180,+e.target.value||0))}}));
  $("#dgFit")?.addEventListener("click", ()=>setFloor({gridbox:null}));
  const img=$("#dgImg"), sizeNote=b=>{ const out=$("#dgSize"); if(!out||!wft||!img?.naturalWidth) return;
    const hft=wft*img.naturalHeight/img.naturalWidth, sw=b.w/100*wft/cols, sh=b.h/100*hft/rows, [lo,hi]=DAS.cell_ft, bad=Math.max(sw,sh)>hi||Math.min(sw,sh)<lo;
    out.innerHTML=`Each square is about <b>${Math.round(sw)} × ${Math.round(sh)} ft</b>${bad?` <span style="color:var(--bad)">· NFPA 1225 asks ${lo}–${hi} ft: ${Math.max(sw,sh)>hi?"add squares or shrink the grid":"fewer squares will do"}</span>`:` · within the ${lo}–${hi} ft NFPA 1225 asks`}.`; };
  if(img){ if(img.complete) sizeNote(box); else img.onload=()=>sizeNote(box); }
  if(place){ const wrap=$("#dgWrap"), gd=$("#dgCells"), b={...box}; let drag=null;
    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const paint=()=>{ Object.assign(gd.style,{left:`${b.cx-b.w/2}%`, top:`${b.cy-b.h/2}%`, width:`${b.w}%`, height:`${b.h}%`, transform:`rotate(${b.rot}deg)`}); $("#dgRot").value=b.rot; sizeNote(b); };
    gd.onpointerdown=e=>{ drag={h:e.target.dataset?.h||"move", x0:e.clientX, y0:e.clientY, b0:{...b}, R:wrap.getBoundingClientRect()}; gd.setPointerCapture(e.pointerId); e.preventDefault(); };
    gd.onpointermove=e=>{ if(!drag) return; const {R,b0}=drag, cx=R.left+b0.cx/100*R.width, cy=R.top+b0.cy/100*R.height;
      if(drag.h==="move"){ b.cx=clamp(b0.cx+(e.clientX-drag.x0)/R.width*100,0,100); b.cy=clamp(b0.cy+(e.clientY-drag.y0)/R.height*100,0,100); }
      else if(drag.h==="size"){ const a=b0.rot*Math.PI/180, vx=e.clientX-cx, vy=e.clientY-cy;
        b.w=clamp(2*Math.abs(vx*Math.cos(a)+vy*Math.sin(a))/R.width*100,3,300); b.h=clamp(2*Math.abs(-vx*Math.sin(a)+vy*Math.cos(a))/R.height*100,3,300); }
      else { let r2=Math.round((Math.atan2(e.clientY-cy, e.clientX-cx)*180/Math.PI+90)*2)/2; if(r2>180) r2-=360; b.rot=r2; }
      paint(); };
    gd.onpointerup=gd.onpointercancel=()=>{ if(!drag) return; drag=null;
      setFloor({gridbox:{cx:+b.cx.toFixed(2), cy:+b.cy.toFixed(2), w:+b.w.toFixed(2), h:+b.h.toFixed(2), rot:b.rot}}); }; }
}
// where a floor's grid sits on its plan, in percent of the plan (centre, size) and degrees; the whole plan by default
const boxOf = f => ({cx:50, cy:50, w:100, h:100, rot:0, ...(f.gridbox||{})});
const boxCss = (f, onPlan=!!f.plan) => { if(!onPlan) return "inset:0"; const b=boxOf(f); return `left:${b.cx-b.w/2}%;top:${b.cy-b.h/2}%;width:${b.w}%;height:${b.h}%;transform:rotate(${b.rot}deg)`; };
// a job file (a floor plan) as an address the page can show. Fetched through the page, because the web version answers
// /api/ itself and a plain <img src="/api/..."> would leave the site; kept for the visit (job files are never overwritten)
const JOB_SRC=new Map();
function jobFileSrc(jid, name){ const k=`${jid}|${name}`;
  if(!JOB_SRC.has(k)) JOB_SRC.set(k, fetch(`/api/das/jobs/${jid}/file?name=${encodeURIComponent(name)}`)
    .then(r=>{ if(!r.ok) throw new Error(String(r.status)); return r.blob(); }).then(b=>URL.createObjectURL(b))
    .catch(()=>{ JOB_SRC.delete(k); return null; }));
  return JOB_SRC.get(k); }
// every reading as rows: the grid test's CSV / JSON and the report's tables (one row per square: the reading that decides it)
function dasFlat(d, withReadings=false){
  const floors=Array.isArray(d.floors)?d.floors:[], res=(d.grid||{}).results||{}, cr=(d.grid||{}).critical||{}, base=d.baseline;
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])], out=[];
  const row=(floor,grid,critical,r0,b0)=>{ const r=eff(d,r0)||{}, b=eff(d,b0), cal=calOf(d,r), p=gridPass(r);
    return {floor, grid, critical:critical?"yes":"", channel:r.freq??"", channels:r.channels??(has(r.dl)||has(r.daq)||has(r.sinr)?1:""), dl_dbm:r.dl??"", dl_daq:r.daq??"", sinr_db:r.sinr??"", ber_pct:r.ber??"", ul_dbm:r.ul??"", ul_daq:r.ul_daq??"",
      pass:p==null?"":cal&&!cal.ok?"not counted":p?"pass":"fail", instrument:cal?cal.name:"", counted:cal?(cal.ok?"yes":`no: ${cal.why}`):"",
      baseline_dl_dbm:b?.dl??"", change_db:has(r.dl)&&b&&has(b.dl)?Math.round(+r.dl-+b.dl):"", cellular:r.cellular||"", note:r.note||"", time:r.time||"", source:r.source||"",
      ...(withReadings?{readings:readingsOf(r0)}:{})}; };
  for(const x of floors){ const skip=new Set(x.skip||[]), cs=new Set(x.critical||[]);
    for(let g=1; g<=(x.grids||DAS.grids); g++) if(!skip.has(g)) out.push(row(x.name, `${x.name}-${g}`, cs.has(g), res[`${x.name}|${g}`]||{}, base?.results?.[`${x.name}|${g}`])); }
  for(const a of crit) out.push(row("named critical area", a, true, cr[a]||{}, base?.critical?.[a]));
  return out;
}
// every reading, one row per channel (cellular too), in the columns the grid import reads, so it goes back in as it came out
function dasReadings(d){
  const out=[];
  for(const x of (Array.isArray(d.floors)?d.floors:[])) for(let g=1; g<=(x.grids||DAS.grids); g++)
    for(const r of readingsOf(((d.grid||{}).results||{})[`${x.name}|${g}`])){ const cal=calOf(d,r), p=isCell(r)?null:gridPass(r);
      out.push({floor:x.name, grid:`${x.name}-${g}`, critical:(x.critical||[]).includes(g)?"yes":"", channel:r.freq??"", technology:r.tech??"", carrier:r.carrier??"", band:r.band??"", dl_mhz:r.mhz??"", pci:r.pci??"",
        dl_dbm:r.dl??"", dl_daq:r.daq??"", sinr_db:r.sinr??"", ber_pct:r.ber??"", ul_dbm:r.ul??"", ul_daq:r.ul_daq??"", rsrp_dbm:r.rsrp??"", rsrq_db:r.rsrq??"",
        x:r.x??"", y:r.y??"", latitude:r.lat??"", longitude:r.lon??"", instrument:cal?cal.name:r.inst==="uncal"?"not calibrated":"",
        result:isCell(r)?"cellular, not scored":p==null?"":cal&&!cal.ok?"not counted":p?"pass":"fail", time:r.time||"", source:r.source||"", note:r.note||""}); }
  return out;
}
// column mapping preview for any imported table
function dasMapImport(el, t, fname, where, done){
  const fields=[["floor","Floor"],["grid","Grid / area"],["freq","Channel / MHz"],["dl","DL dBm"],["daq","DL DAQ"],["sinr","SINR dB"],["ber","BER %"],["ul","UL dBm"],["ul_daq","UL DAQ"],
    ["tech","Technology"],["carrier","Carrier (cellular)"],["rsrp","RSRP dBm (cellular)"],["rsrq","RSRQ dB (cellular)"],["pci","PCI (cellular)"],["band","Band"],["mhz","DL MHz"],
    ["x","Plan X"],["y","Plan Y"],["lat","Latitude"],["lon","Longitude"],["critical","Critical area"],["note","Note"],["time","Time"]];
  const opts=h=>`<option value="">—</option>${t.headers.map(x=>`<option ${x===h?"selected":""}>${esc(x)}</option>`).join("")}`;
  // a report taken at one spot (a COMPASS Full Signal Report) or any table with no grid column: every row goes in one square
  const squares=(where.floors||[]).flatMap(fl=>Array.from({length:fl.grids||DAS.grids},(_,i)=>i+1).filter(g=>!(fl.skip||[]).includes(g)).map(g=>[`${fl.name}|${g}`,`${fl.name}-${g}`]));
  el.innerHTML=`<div class="panel" style="margin-top:10px"><h3>Import ${esc(fname)} <span class="hint">· ${esc(t.format==="compass"?"Cel-Fi COMPASS Full Signal Report":t.format.toUpperCase())}, ${t.total.toLocaleString()} rows · check the columns, then import</span></h3>
    ${t.format==="compass"?'<p class="status" style="margin:0 0 6px">A COMPASS report is one spot: pick the square it was taken in. Each cell it heard becomes a cellular reading there (carrier, band, PCI, RSRP, RSRQ); a cell listed twice under one carrier is kept once.</p>':""}
    <div class="row">${fields.map(([k,l])=>`<label>${l}<select data-m="${k}">${opts(t.guess[k])}</select></label>`).join("")}
      <label title="Rows with no grid or area (all of them when there's no grid column) go in this square">Rows with no grid go in<select id="dmAll"><option value="">— skip them —</option>${squares.map(([k,l])=>`<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select></label>
      <button class="primary" id="dmGo">Import</button><button id="dmNo">Cancel</button></div>
    <div class="tw" style="max-height:240px;margin-top:8px"><table><thead><tr>${t.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.slice(0,12).map(r=>`<tr>${t.headers.map(h=>`<td>${esc(r[h]??"")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="hint">Rows without a grid or area are skipped. Grid names like “Grid 7” or “2-7” are read as square 7. Floors the file names that this job doesn't have yet are added.
      Several rows for one square (one per channel or system) are all kept, and the worst decides it; a row replaces what that square already had on the same channel.
      Cellular rows (LTE or 5G, or any row with RSRP / RSRQ) are kept and shown but never scored against these public-safety rules.</p></div>`;
  el.scrollIntoView({behavior:"smooth",block:"start"});
  $("#dmNo").onclick=()=>{ el.innerHTML=""; };
  $("#dmGo").onclick=()=>{ const m={}; el.querySelectorAll("[data-m]").forEach(s=>{ if(s.value) m[s.dataset.m]=s.value; });
    const all=$("#dmAll").value, [allF, allG]=all?all.split("|"):["",""];
    if(!m.grid&&!all){ alert("Pick the column that names the grid square or area, or the square these readings were taken in (Rows with no grid go in)."); return; }
    const numv=x=>{ const v=parseFloat(String(x??"").replace(/[^\d.\-]/g,"")); return isFinite(v)?v:null; };
    done(t.rows.map(r=>{ const o={floor:m.floor?String(r[m.floor]||"").trim():"", grid:m.grid?String(r[m.grid]||"").trim().replace(/^(grid|area|square|cell)\s*#?\s*/i,"").replace(/^[^-]+-(\d+)$/,"$1"):""};
      if(!o.grid&&all){ o.floor=allF; o.grid=allG; }
      for(const k of ["dl","daq","sinr","ber","ul","ul_daq","rsrp","rsrq","x","y","lat","lon","mhz"]) if(m[k]) o[k]=numv(r[m[k]]);
      for(const k of ["freq","tech","pci","carrier","band"]) if(m[k]&&String(r[m[k]]??"").trim()!=="") o[k]=String(r[m[k]]).trim();
      if(m.note) o.note=r[m.note]; if(m.time) o.time=r[m.time]; if(m.critical) o.critical=r[m.critical]; return o; })); };
}

/* ---------- files: anything, kept in the job's Drive folder ---------- */
async function dasFiles(el, j){
  let f; try{ f=await api(`/api/das/jobs/${j.id}/files`); }catch(e){ el.innerHTML=`<p class="status err">${esc(e.message)}</p>`; return; }
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const size=b=>b>1e6?`${(b/1e6).toFixed(1)} MB`:`${Math.max(1,Math.round(b/1e3))} KB`;
  el.innerHTML=`<div class="panel"><h3>Files <span class="hint">· ${esc(f.folder)}</span></h3>
    <div id="dfDrop" style="border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;margin-bottom:10px">Drop any files here (floor plans, drawings, PDFs, photos, letters, test exports) or <label style="display:inline"><u>choose files</u><input type="file" id="dfIn" multiple hidden></label>.
      <div class="hint">They're saved in the job's folder in Drive, so anyone the folder is shared with sees them. A file with the same name is kept as a second copy, never overwritten.</div></div>
    ${f.files.length?`<div class="tw"><table><thead><tr><th>File</th><th class="n">Size</th><th>Added</th><th></th></tr></thead><tbody>${f.files.map(x=>`<tr><td><a href="/api/das/jobs/${j.id}/file?name=${encodeURIComponent(x.name)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td class="n">${size(x.size)}</td><td class="mono">${esc(x.modified)}</td><td><button data-rm="${esc(x.name)}">Delete</button></td></tr>`).join("")}</tbody></table></div>`:'<p class="hint">No files yet.</p>'}
    <p class="hint" id="dfMsg"></p></div>`;
  const up=async list=>{ for(const file of list){ $("#dfMsg").textContent=`Saving ${file.name}…`; await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(file.name)}`,{method:"POST",body:await file.arrayBuffer()}); } render(); };
  $("#dfIn").onchange=e=>up([...e.target.files]);
  const dz=$("#dfDrop"); dz.ondragover=e=>{ e.preventDefault(); dz.style.borderColor="var(--accent)"; }; dz.ondragleave=()=>{ dz.style.borderColor=""; };
  dz.ondrop=e=>{ e.preventDefault(); dz.style.borderColor=""; up([...e.dataTransfer.files]); };
  el.querySelectorAll("[data-rm]").forEach(b=>b.onclick=async()=>{ if(!confirm(`Delete ${b.dataset.rm}? Drive keeps it in the bin for 30 days.`)) return; await post(`/api/das/jobs/${j.id}/files/delete?name=${encodeURIComponent(b.dataset.rm)}`); render(); });
}

function dasLog(el, j){
  el.innerHTML=`<div class="panel"><h3>Log</h3><div class="row"><input id="dlNote" class="grow" placeholder="Add a note (site visit, call with the AHJ, punch item…)"><button class="primary" id="dlAdd">Add</button></div>
    <div class="tw" style="margin-top:8px;max-height:60vh"><table><tbody>${(j.log||[]).map(l=>`<tr><td class="mono" style="white-space:nowrap">${esc(l.ts)}</td><td>${esc(l.kind)}</td><td>${esc(l.detail)}</td></tr>`).join("")}</tbody></table></div></div>`;
  $("#dlAdd").onclick=async()=>{ const t=$("#dlNote").value.trim(); if(!t) return; await post(`/api/das/jobs/${j.id}/note`,{text:t}); render(); };
}

// the data notices a printed report must carry (build.py NOTICES): the FCC's always (the systems come from ULS);
// the ODbL one when the job has a building outline (OpenStreetMap, or Overture when OpenStreetMap had none)
function dasCredits(d){
  const n=(S.build||{}).notices||{}, b=d.building;
  const lines=[n.fcc, b&&(/Overture/.test(b.source||"")||b.gers_id?n.overture:n.osm)].filter(Boolean);
  return lines.length?`<p class="hint" style="margin-top:16px;font-size:11px">${lines.map(esc).join(" ")}</p>`:"";
}

/* ---------- report for the AHJ (print to PDF): summary, then each floor's plan and readings ---------- */
function dasReport(el, j){
  if(S.das.rview==="submittal"&&window.dasSubmittal) return window.dasSubmittal(el, j);  // the design submittal (dasdesign.js)
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], cs=S.das.contacts, who=k=>cs.find(c=>String(c.id)===String((d.contacts||{})[k]));
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])], cr=(d.grid||{}).critical||{}, res=(d.grid||{}).results||{}, T=d.testing||{};
  const st=floors.map(f=>({f,...floorStats(d,f)}));
  const allTested=st.every(x=>x.untested===0)&&crit.every(a=>scored(d,cr[a])!=null);
  const ok=allTested&&st.every(x=>x.ok)&&crit.every(a=>scored(d,cr[a]));
  const nc=st.reduce((s,x)=>s+x.notCounted,0)+crit.filter(a=>notCounted(d,cr[a])).length;
  const plan=(d.presurvey||{}).plan||[];
  const cell=(f,g)=>{ const r=eff(d, res[`${f.name}|${g}`]), p=scored(d,r), n2=notCounted(d,r), sk=(f.skip||[]).includes(g), c=(f.critical||[]).includes(g);
    return `<div style="border:${c?"2px solid #b8860b":n2?"1px dashed #777":"1px solid #999"};display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px;
      background:${sk?"repeating-linear-gradient(45deg,#ddd 0 5px,transparent 5px 10px)":n2?"rgba(140,149,159,.45)":p==null?"rgba(255,255,255,.55)":p?"rgba(60,207,122,.55)":"rgba(229,83,75,.6)"}">
      <b>${esc(f.name)}-${g}${c?" ★":""}</b>${sk?"not tested":r&&has(r.dl)?`${r.dl} dBm`:""}${n2?"<span>not counted</span>":""}</div>`; };
  el.innerHTML=`<div class="maptools no-print"><div class="seg" id="drView"><button data-rv="test" class="on">Test report</button><button data-rv="submittal">Design submittal</button></div>
    <button class="primary" id="drPrint">⎙ Print / save as PDF</button><span class="hint">Prints the report only. Choose “Save as PDF”, then add the PDF to the job's Files.</span></div>
  <div class="panel" id="dasPrint">
    <h2 style="margin:0 0 4px">Emergency responder radio coverage test: ${esc(j.name)}</h2>
    <p style="margin:0 0 10px">${esc(d.address||"")} · ${esc(d.ahj||"AHJ not set")} · ${esc(d.code||"IFC 510 + NFPA 1225")} · prepared ${esc(today())}</p>
    <p style="font-size:18px;margin:6px 0"><b>Result: ${allTested?(ok?'<span style="color:#1a7f37">PASS</span>':'<span style="color:#cf222e">FAIL</span>'):"Not complete (untested areas below)"}</b></p>
    <p class="hint">Pass criteria: each test location ≥ ${DASJ.threshold} dBm downlink and uplink, DAQ ≥ ${DASJ.daq} both ways (or SINR ≥ ${daqEq().sinr} dB with BER ≤ ${daqEq().ber}%), on every channel tested there (the worst channel is shown); ${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas on each floor; ${DAS.grids} grid squares per floor. Only readings taken with an instrument calibrated within ${DAS.cal_months} months of the reading are scored.</p>
    ${nc?`<p style="margin:4px 0"><b>${nc} reading${nc===1?" was":"s were"} not scored</b>: taken without a calibrated instrument, or with no instrument recorded. They are shown grey (“not counted”) as pre-survey information only.</p>`:""}
    <h3>Building and people</h3><div class="kvg"><div>Building</div><div>${esc([j.name, d.address, d.floors?.length?`${d.floors.length} floors`:"", d.area_sqft?`${Number(d.area_sqft).toLocaleString()} sq ft`:"", d.construction].filter(Boolean).join(" · "))}</div>
      ${DAS_ROLES.map(([k,l])=>{ const c=who(k); return c?`<div>${esc(l)}</div><div>${esc([c.name,c.org,c.phone,c.email].filter(Boolean).join(" · "))}</div>`:""; }).join("")}</div>
    <h3>Tester and instruments</h3><div class="kvg"><div>Tester</div><div>${esc(T.tester||"not set")}</div><div>FCC GROL</div><div>${esc(T.grol||"–")}</div><div>NICET</div><div>${esc(T.nicet||"–")}</div><div>Test date${T.date2?"s":""}</div><div>${esc([T.date,T.date2].filter(Boolean).join(" to ")||"–")}</div></div>
      ${(T.instruments||[]).length?`<table style="margin-top:6px"><thead><tr><th>Instrument</th><th>Serial</th><th>Calibrated</th><th>Status</th></tr></thead><tbody>${T.instruments.map(i=>{ const s=instState(i); return `<tr><td>${esc(i.model)}</td><td class="mono">${esc(i.serial)}</td><td class="mono">${esc(i.cal)}</td><td style="color:${s.ok?"#1a7f37":"#cf222e"}">${s.ok?"current":esc(s.why)}</td></tr>`; }).join("")}</tbody></table>`:'<p class="hint" style="color:#cf222e">No test instruments listed: no reading can be scored.</p>'}
    <h3>Compliance</h3><div class="kvg">${DAS_CHECKS.map(([k,l])=>`<div>${esc(l)}</div><div>${esc((d.checks||{})[k]||"not on file")}</div>`).join("")}<div>Annual retest due</div><div>${esc(d.retest_due||"–")}</div>
      ${d.baseline?`<div>Compared with</div><div>the acceptance test of ${esc(d.baseline.date)}</div>`:""}</div>
    <h3>Systems covered</h3>${plan.length?`<table><thead><tr><th>Agency</th><th>Call sign</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Type</th></tr></thead><tbody>${plan.map(p=>`<tr><td>${esc(p.system)}</td><td class="mono">${esc(p.call_sign)}</td><td class="mono">${esc(p.downlink_mhz)}</td><td class="mono">${esc(p.uplink_mhz)}</td><td>${esc(p.technology)}</td></tr>`).join("")}</tbody></table>`:'<p class="hint">None chosen in the pre-survey.</p>'}
    <h3>Summary by floor</h3><table><thead><tr><th>Floor</th><th class="n">General pass</th><th class="n">Critical pass</th><th class="n">Untested</th><th class="n">Not counted</th><th>Result</th></tr></thead><tbody>${st.map(x=>`<tr><td>${esc(x.f.name)}</td><td class="n">${x.genPass}/${x.gen} (${x.genPct}%)</td><td class="n">${x.crit?`${x.critPass}/${x.crit} (${x.critPct}%)`:"–"}</td><td class="n">${x.untested}</td><td class="n">${x.notCounted||""}</td><td>${x.untested?"incomplete":x.ok?"pass":"fail"}</td></tr>`).join("")}
      ${crit.length?`<tr><td>Named critical areas</td><td></td><td class="n">${crit.filter(a=>scored(d,cr[a])).length}/${crit.length}</td><td class="n">${crit.filter(a=>scored(d,cr[a])==null).length}</td><td class="n">${crit.filter(a=>notCounted(d,cr[a])).length||""}</td><td></td></tr>`:""}</tbody></table>
    ${st.map(x=>{ const f=x.f, n=f.grids||DAS.grids, cols=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), rows=Math.ceil(n/cols);
      return `<div style="break-before:page;margin-top:16px"><h3>Floor ${esc(f.name)}: ${x.genPass}/${x.gen} general${x.crit?`, ${x.critPass}/${x.crit} critical`:""} pass</h3>
        <div style="position:relative;width:100%;max-width:720px;${f.plan?"":`aspect-ratio:${cols}/${rows};`}border:1px solid #999;overflow:hidden">
          ${f.plan?`<img data-plan="${esc(f.plan)}" data-ar="${cols}/${rows}" alt="Floor ${esc(f.name)} plan" style="display:block;width:100%;height:auto;min-height:120px">`:""}
          <div style="position:absolute;${boxCss(f)};display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${Array.from({length:n},(_,i)=>cell(f,i+1)).join("")}</div></div>
        <table style="margin-top:8px"><thead><tr><th>Grid</th><th>Critical</th><th>Channel</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">SINR / BER</th><th class="n">UL dBm</th><th class="n">UL DAQ</th>${d.baseline?'<th class="n">vs baseline</th>':""}<th>Instrument</th><th>Result</th><th>Note</th></tr></thead><tbody>
        ${dasFlat(d).filter(r=>r.floor===f.name).map(r=>`<tr><td>${esc(r.grid)}</td><td>${r.critical?"★":""}</td><td>${esc(r.channel)}${r.channels>1?` <span class="hint">(worst of ${r.channels})</span>`:""}</td><td class="n">${r.dl_dbm}</td><td class="n">${r.dl_daq}</td><td class="n">${[r.sinr_db,r.ber_pct!==""?r.ber_pct+"%":""].filter(x=>x!=="").join(" / ")}</td><td class="n">${r.ul_dbm}</td><td class="n">${r.ul_daq}</td>${d.baseline?`<td class="n">${r.change_db!==""?(r.change_db>=0?"+":"")+r.change_db+" dB":""}</td>`:""}<td>${esc(r.instrument)}</td><td>${r.pass||"untested"}</td><td>${esc(r.note)}</td></tr>`).join("")}</tbody></table></div>`; }).join("")}
    ${crit.length?`<div style="margin-top:16px"><h3>Named critical areas</h3><table><thead><tr><th>Area</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">UL dBm</th><th class="n">UL DAQ</th><th>Instrument</th><th>Result</th></tr></thead><tbody>${crit.map(a=>{ const r=cr[a]||{}, p=scored(d,r), cal=calOf(d,r); return `<tr><td>${esc(a)}</td><td class="n">${r.dl??""}</td><td class="n">${r.daq??""}</td><td class="n">${r.ul??""}</td><td class="n">${r.ul_daq??""}</td><td>${esc(cal?cal.name:"")}</td><td>${cal&&!cal.ok?"not counted":p==null?"untested":p?"pass":"fail"}</td></tr>`; }).join("")}</tbody></table></div>`:""}
    ${window.dasCellReport?dasCellReport(d):""}
    ${dasCredits(d)}
  </div>`;
  // each floor's plan under its grid; a plan that won't open leaves the grid at its own shape
  el.querySelectorAll("img[data-plan]").forEach(async im=>{ const s=await jobFileSrc(j.id, im.dataset.plan);
    if(s){ im.src=s; im.style.minHeight=""; } else { const box=im.parentElement, g=box.querySelector("div"); box.style.aspectRatio=im.dataset.ar; if(g) g.style.cssText=g.style.cssText.replace(/left:[^;]+;top:[^;]+;width:[^;]+;height:[^;]+;transform:[^;]+/,"inset:0"); im.remove(); } });
  $("#drPrint").onclick=()=>{ document.body.classList.add("print-das"); window.print(); setTimeout(()=>document.body.classList.remove("print-das"),500); };
  $("#drView").onclick=e=>{ const b=e.target.closest("[data-rv]"); if(b){ S.das.rview=b.dataset.rv; render(); } };
}

/* ---------- consent letters: 47 CFR 90.219(b)(1) asks for the licensee's consent before a booster retransmits its signal ---------- */
function dasConsent(j, systems){
  const d=j.data||{}, cs=S.das.contacts, me=cs.find(c=>String(c.id)===String((d.contacts||{}).tech)), cls=(d.booster_class||"Class A (channelized)");
  const by=new Map(); for(const s of systems){ if(!by.has(s.licensee)) by.set(s.licensee, []); by.get(s.licensee).push(s); }
  const box=document.createElement("div"); box.id="dasPrint"; box.className="panel";
  box.innerHTML=[...by].map(([lic,ss],i)=>`<div style="${i?"break-before:page;":""}padding:24px 8px;font-size:14px;line-height:1.5">
    <p>${esc(today())}</p><p><b>${esc(lic)}</b><br>Radio system manager</p>
    <p><b>Re: Consent to retransmit under 47 CFR 90.219(b)(1): ${esc(j.name)}, ${esc(d.address||"")}</b></p>
    <p>We are installing an emergency responder communication enhancement system (${esc(cls)} signal booster) at the building above so that responders' radios work inside it, as ${esc(d.ahj||"the authority having jurisdiction")} requires under ${esc(d.code||"IFC 510 and NFPA 1225")}.</p>
    <p>The booster will retransmit only the following channels licensed to you:</p>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4"><thead><tr><th>Call sign</th><th>Downlink MHz (your sites)</th><th>Uplink MHz (radios)</th></tr></thead><tbody>
      ${ss.map(s=>`<tr><td>${esc(s.call_sign)}</td><td>${s.down.map(c=>fmtF(c.freq)).join(", ")}</td><td>${s.up.map(fmtF).join(", ")||"to be confirmed"}</td></tr>`).join("")}</tbody></table>
    <p>We ask for your written consent to retransmit these channels, and for any conditions you set (gain limits, donor site, filtering, monitoring, or contact for interference). ${cls.startsWith("Class B")?"As a Class B booster it will also be registered with the FCC under 47 CFR 90.219(d)(5).":""}</p>
    <p>Consent given by: ______________________________ Title: ____________________ Date: ____________</p>
    <p>Thank you,<br>${esc(me?[me.name, me.org, me.phone, me.email].filter(Boolean).join("<br>"):"")}</p></div>`).join("");
  document.body.appendChild(box); document.body.classList.add("print-das"); window.print();
  setTimeout(()=>{ document.body.classList.remove("print-das"); box.remove(); },500);
}
