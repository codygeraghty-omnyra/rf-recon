"use strict";
/* RF Recon — guided BDA commissioning (job › Commissioning). Step by step, with any analyzer and any maker's BDA (values
   typed, or a trace / log imported as CSV), graded with the AHJ's own numbers where we have them:
     1 donor-site noise test (NFPA 1225 A.18.9.3: booster off, then on; 10 kHz RBW, 5-minute average; a rise of 1 dB or more
       means cut the gain until it's gone, then 3 dB more)
     2 isolation, donor to server antennas (NFPA 1225 18.10: at least 20 dB over the system gain; some AHJs differ)
     3 gain, AGC and filter settings per band (NFPA 1225 20.3.10.1.3(11); IFC 2021 510.5.4(6): every amplifier's gain)
     4 oscillation check with a spectrum analyzer (IFC 2021 510.5.4(7))
     5 donor (signal source) level and source type (NFPA 1225 20.3.10.1.3(9), (10))
     6 talk-back and near-far log with the radio shop (IFC 2021 510.5.4(8): the two-radio test)
   Saved as data.commission; each step's result goes into the acceptance tests the Report prints:
     data.acceptance = {tests: {<id>: {status: "pass"|"fail"|"not done", value, unit, note, at, by, src: "commissioning"}}}
   with ids noise_floor, isolation, gain, oscillation, donor_level, two_radio. Merged into what's there: another id, or an
   entry typed somewhere else (src not "commissioning"), is never overwritten unless the person asks. */

const CM_NFPA = "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download";
const CM_IFC = "https://www.oswegofire.com/wp-content/uploads/2025/11/2021_ifc_510-Comm-Coverage.pdf";
// The numbers. "nfpa" is the default; an AHJ set changes only what its document says. checked: "read" = the primary text;
// "excerpt" = a search excerpt of the document (2026-11-04 research, beat-ahead.json area 8), not the whole document.
const CM_AHJ = {
  nfpa: {name: "NFPA 1225 (2022) and IFC 2021", rise_db: 1, extra_cut_db: 3, rbw_khz: 10, avg_min: 5, iso_margin_db: 20,
    src: CM_NFPA, checked: "read", says: "A.18.9.3 noise test, 18.10 isolation, 20.3.10.1.3 records; IFC 2021 510.5.4(6)-(8)."},
  san_diego: {name: "San Diego Fire-Rescue (C-1)", noise_max_dbm: -150, match: /san\s*diego/i,
    src: "https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf", checked: "excerpt",
    says: "Uplink noise at the donor site −150 dBm or lower."},
  ocsd: {name: "Orange County Sheriff (OCSD ERRCS)", noise_max_dbm: -150, match: /\bocsd\b|orange\s*county\s*sheriff/i,
    src: "https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf", checked: "excerpt",
    says: "Uplink noise at the donor site −150 dBm or lower."},
  sf: {name: "San Francisco (CCSF ERRCS v1.4)", donor_min_dbm: -95, donor_max_dbm: -70, noise_max_dbm: -130, iso_margin_db: 20, match: /san\s*francisco|\bccsf\b|\bsffd\b/i,
    src: "https://www.in-buildingwireless.com/wp-content/uploads/2021/03/ERRCS-CCSF-Requirements-v1.4.pdf", checked: "excerpt",
    says: "Donor receive level −95 to −70 dBm; noise under −130 dBm; gain 20 dB below the isolation."},
  sno911: {name: "SNO911 (Snohomish County, v2.1)", ul_over_noise_db: 30, rise_db: 1, match: /sno\s*911|snohomish/i,
    src: "https://sno911.org/wp-content/uploads/2026/07/SNO911-In-Building-ERCES-Technical-Criteria-v2.1.pdf", checked: "excerpt",
    says: "Uplink at the site no more than 30 dB over the site's noise floor; under 1 dB noise contribution."},
  greensboro: {name: "Guilford Metro 9-1-1 (Greensboro)", donor_min_dbm: -95, donor_max_dbm: -65, near_far: true, match: /greensboro|guilford/i,
    src: "https://www.greensboro-nc.gov/departments/guilford-metro-9-1-1/bda-erces-frequency-retransmission-requirements", checked: "excerpt",
    says: "Inbound level at the donor −95 to −65 dBm; a near-far test."},
  mckinney: {name: "McKinney TX", iso_margin_db: 15, match: /mckinney/i,
    src: "https://www.mckinneytexas.org/DocumentCenter/View/17102/Radio-BDA-Coverage-Systems", checked: "excerpt",
    says: "Isolation 15 dB over the gain."},
};
const CM_IDS = [["noise_floor", "Donor-site noise test"], ["isolation", "Isolation"], ["gain", "Gain, AGC and filter settings"],
  ["oscillation", "Oscillation check"], ["donor_level", "Donor level and source"], ["two_radio", "Talk-back and near-far"]];
const CM_SOURCES = ["Off-air donor antenna", "Fibre or base station fed", "Other"];
const CM = {busy: 0};  // saves and imports on their way

/* ---------- the numbers ---------- */
// the AHJ set a job uses: the one picked, else the one its AHJ name or profile matches, else NFPA. The job's AHJ profile
// (das.js) wins for isolation when it carries a margin (McKinney's 15 dB)
function cmAhjKey(d){ const k=(d.commission||{}).ahj; if(k&&CM_AHJ[k]) return k;
  const t=`${d.ahj||""} ${(typeof DASJ!=="undefined"&&DASJ.profile_name)||""} ${d.code||""}`;
  return Object.keys(CM_AHJ).find(x=>CM_AHJ[x].match&&CM_AHJ[x].match.test(t))||"nfpa"; }
function cmNumbers(d){ const key=cmAhjKey(d), A=CM_AHJ[key], B=CM_AHJ.nfpa, pm=typeof DASJ!=="undefined"?DASJ.isolation_margin_db:null;
  const N={...B, ...A, key, name:A.name, base:B};
  if(pm!=null&&isFinite(+pm)&&(key==="nfpa"||A.iso_margin_db==null)){ N.iso_margin_db=+pm; N.iso_from=`the job's AHJ profile${DASJ.profile_name?` (${DASJ.profile_name})`:""}`; }
  else N.iso_from=A.iso_margin_db!=null?A.name:B.name;
  return N; }
const cmN = v => v===""||v==null ? null : isFinite(+v) ? +v : null;
// readings averaged as power (mW), not as dB: what a 5-minute average of a noise floor means
function cmAvgDbm(vals){ const v=vals.map(Number).filter(isFinite); if(!v.length) return null;
  return 10*Math.log10(v.reduce((s,x)=>s+10**(x/10),0)/v.length); }
const cmR1 = x => Math.round(x*10)/10;

/* ---------- each step's grade: {status, value, unit, note} (null: nothing entered yet) ---------- */
function cmNoise(C, N){ const T=C.noise||{}, rows=(T.rows||[]).filter(r=>cmN(r.off)!=null||cmN(r.on)!=null);
  if(!rows.length) return null;
  const out=rows.map(r=>{ const off=cmN(r.off), on=cmN(r.on), after=cmN(r.after), cut=cmN(r.cut);
    if(off==null||on==null) return {r, done:false, why:"needs both readings, booster off and on"};
    const rise=on-off, cleared=after!=null?after-off:null, fin=rise>=N.rise_db?cleared:rise, lvl=rise>=N.rise_db?after:on;
    let ok=fin!=null&&fin<N.rise_db, why;
    if(rise<N.rise_db) why=`rise ${cmR1(rise)} dB, under ${N.rise_db} dB`;
    else if(cleared==null||cut==null) { ok=false; why=`rise ${cmR1(rise)} dB: cut the uplink gain until it's gone, then ${N.extra_cut_db} dB more, and enter the cut and the new reading`; }
    else if(cleared>=N.rise_db) why=`still ${cmR1(cleared)} dB over the booster-off floor after a ${cut} dB cut`;
    else why=`rise ${cmR1(rise)} dB cleared by a ${cut} dB cut; set ${cut+N.extra_cut_db} dB below the setting that rose (${N.extra_cut_db} dB more, A.18.9.3)`;
    if(ok&&N.noise_max_dbm!=null&&lvl>N.noise_max_dbm){ ok=false; why+=`; ${cmR1(lvl)} dBm is over ${N.name}'s ${N.noise_max_dbm} dBm`; }
    const ul=cmN(r.ul); if(ok&&N.ul_over_noise_db!=null&&ul!=null&&ul-off>N.ul_over_noise_db){ ok=false; why+=`; the uplink is ${cmR1(ul-off)} dB over the floor, more than ${N.name}'s ${N.ul_over_noise_db} dB`; }
    return {r, done:true, ok, rise, fin, why}; });
  const done=out.filter(x=>x.done), bad=done.filter(x=>!x.ok), rbw=cmN(T.rbw_khz), avg=cmN(T.avg_min);
  const method=[rbw!=null&&rbw!==N.rbw_khz?`RBW ${rbw} kHz (A.18.9.3 asks ${N.rbw_khz} kHz)`:"", avg!=null&&avg<N.avg_min?`a ${avg}-minute average (A.18.9.3 asks ${N.avg_min})`:""].filter(Boolean);
  const worst=done.length?Math.max(...done.map(x=>x.fin??x.rise)):null;
  const where=[T.site, T.contact?`with ${T.contact}`:""].filter(Boolean).join(" ");
  if(!done.length) return {status:"not done", value:null, unit:"dB rise", note:"no channel has both readings", rows:out};
  if(method.length) return {status:"not done", value:cmR1(worst), unit:"dB rise", note:`not to the method: ${method.join(", ")}`, rows:out};
  return {status:bad.length?"fail":done.length<out.length?"not done":"pass", value:cmR1(worst), unit:"dB rise",
    note:`${done.length-bad.length} of ${out.length} channel${out.length===1?"":"s"} under ${N.rise_db} dB${[...bad, ...done.filter(x=>x.ok&&x.rise>=N.rise_db)].map(x=>`; ${x.r.ch||"a channel"}: ${x.why}`).join("")}${where?` · ${where}`:""}`, rows:out}; }

// a band's gain: typed on the isolation row, else the higher of its UL and DL gain from step 3
function cmGainOf(C, band){ const g=((C.gain||{}).rows||[]).find(x=>String(x.band||"").trim()===String(band||"").trim());
  const v=g?[cmN(g.ul),cmN(g.dl)].filter(x=>x!=null):[]; return v.length?Math.max(...v):null; }
function cmIso(C, N){ const rows=((C.iso||{}).rows||[]).filter(r=>cmN(r.iso)!=null); if(!rows.length) return null;
  const out=rows.map(r=>{ const g=cmN(r.gain)??cmGainOf(C, r.band), iso=cmN(r.iso);
    if(g==null) return {r, done:false, why:"needs the band's gain (here or in step 3)"};
    const need=g+N.iso_margin_db; return {r, done:true, ok:iso>=need, over:iso-g, need, why:`${iso} dB vs ${need} dB needed (gain ${g} + ${N.iso_margin_db})`}; });
  const done=out.filter(x=>x.done), bad=done.filter(x=>!x.ok);
  return {status:!done.length?"not done":bad.length?"fail":done.length<out.length?"not done":"pass", value:done.length?cmR1(Math.min(...done.map(x=>x.over))):null, unit:"dB over gain",
    note:`${out.map(x=>`${x.r.band||"band"}: ${x.why}`).join("; ")} · margin ${N.iso_margin_db} dB from ${N.iso_from}`, rows:out}; }
function cmGain(C){ const G=C.gain||{}, rows=(G.rows||[]).filter(r=>r.band||cmN(r.ul)!=null||cmN(r.dl)!=null);
  if(!rows.some(r=>cmN(r.ul)!=null||cmN(r.dl)!=null||r.agc||r.filter)&&!G.model&&!G.maker) return null;
  const miss=rows.filter(r=>cmN(r.ul)==null||cmN(r.dl)==null), id=[G.maker, G.model, G.serial?`serial ${G.serial}`:"", G.fcc_id?`FCC ID ${G.fcc_id}`:"", G.fw?`firmware ${G.fw}`:""].filter(Boolean).join(" ");
  return {status:!rows.length?"not done":miss.length?"not done":"pass", value:rows.length, unit:`band${rows.length===1?"":"s"} recorded`,
    note:`${id||"BDA not named"}${miss.length?` · no UL or DL gain on ${miss.map(r=>r.band||"a row").join(", ")}`:""}${(G.shots||[]).length?` · ${G.shots.length} screenshot${G.shots.length===1?"":"s"} in Files`:""}`}; }
function cmOsc(C){ const O=C.osc||{}; if(!O.dl&&!O.ul&&!O.alarm) return null;
  const seen=[O.dl==="seen"?"downlink":"", O.ul==="seen"?"uplink":""].filter(Boolean), both=O.dl&&O.ul;
  return {status:seen.length||O.alarm==="no"?"fail":both?"pass":"not done", value:seen.length?`seen on the ${seen.join(" and ")}`:both?"none seen":"", unit:"",
    note:[!both?"check both directions":"", O.alarm==="yes"?"oscillation alarm and shutdown seen working":O.alarm==="no"?"oscillation alarm or shutdown did not work":"", O.analyzer?`with ${O.analyzer}`:"", O.note||""].filter(Boolean).join(" · ")}; }
function cmDonor(C, N){ const D=C.donor||{}, rows=(D.rows||[]).filter(r=>cmN(r.level)!=null); if(!rows.length&&!D.source) return null;
  const win=N.donor_min_dbm!=null, bad=win?rows.filter(r=>+r.level<N.donor_min_dbm||+r.level>N.donor_max_dbm):[];
  return {status:!rows.length?"not done":bad.length?"fail":"pass", value:rows.length?Math.min(...rows.map(r=>+r.level)):null, unit:"dBm",
    note:`${D.source||"source type not set"} · ${win?`${N.name}: ${N.donor_min_dbm} to ${N.donor_max_dbm} dBm${bad.length?`; outside it: ${bad.map(r=>`${r.ch||"a channel"} ${r.level} dBm`).join(", ")}`:""}`:`recorded; ${N.name} sets no window`}`}; }
function cmTalk(C, N){ const rows=((C.talk||{}).rows||[]).filter(r=>r.result); if(!rows.length) return null;
  const clear=rows.filter(r=>r.result==="clear").length, nf=rows.some(r=>r.kind==="near-far"), tb=rows.some(r=>r.kind!=="near-far");
  const need=[!tb?"no talk-back call logged":"", N.near_far&&!nf?`${N.name} asks for a near-far test`:""].filter(Boolean);
  return {status:clear<rows.length?"fail":need.length?"not done":"pass", value:`${clear} of ${rows.length}`, unit:"calls clear",
    note:[...need, [...new Set(rows.map(r=>r.contact).filter(Boolean))].join(", ")].filter(Boolean).join(" · ")}; }
// every step -> the acceptance tests it fills
function cmTests(d){ const C=d.commission||{}, N=cmNumbers(d);
  const g={noise_floor:cmNoise(C,N), isolation:cmIso(C,N), gain:cmGain(C), oscillation:cmOsc(C), donor_level:cmDonor(C,N), two_radio:cmTalk(C,N)};
  const out={}; for(const [k,v] of Object.entries(g)) if(v){ const {status,value,unit,note}=v; out[k]={status,value,unit,note}; } return out; }
// merge into data.acceptance: a commissioning entry is replaced (its time kept when nothing changed); a typed one is kept
// unless its id is in force; other ids untouched. A step emptied after it wrote leaves "not done"
function cmMerge(acc, tests, by, at, force){ const A=acc&&typeof acc==="object"?acc:{}, T={...(A.tests||{})}, kept=[]; let changed=false;
  const same=(a,b)=>a&&b&&a.status===b.status&&String(a.value??"")===String(b.value??"")&&(a.unit||"")===(b.unit||"")&&(a.note||"")===(b.note||"");
  for(const [id] of CM_IDS){ const now=T[id], t=tests[id];
    if(now&&now.src!=="commissioning"&&!(force||[]).includes(id)){ if(t) kept.push(id); continue; }
    if(!t){ if(now&&now.src==="commissioning"&&now.status!=="not done"){ T[id]={...now, status:"not done", note:"the commissioning step was cleared", at, by, src:"commissioning"}; changed=true; } continue; }
    if(same(now, t)&&now.src==="commissioning") continue;
    T[id]={...t, at, by, src:"commissioning"}; changed=true; }
  return {acceptance:{...A, tests:T}, kept, changed}; }

/* ---------- the page ---------- */
const CM_ROWS = {
  noise: [["ch","Channel / system","text",150],["off","Booster off dBm","num",96],["on","Booster on dBm","num",96],["cut","Gain cut that cleared it, dB","num",96],["after","After the cut dBm","num",96],["ul","Uplink at the site dBm","num",96]],
  iso: [["band","Band","text",110],["gain","System gain dB","num",90],["iso","Measured isolation dB","num",100],["how","How measured","text",170]],
  gain: [["band","Band / channel","text",120],["ul","UL gain dB","num",80],["dl","DL gain dB","num",80],["agc","AGC / ALC","text",110],["filter","Filter / passband","text",130],["out","Max out dBm","num",84],["note","Note","text",140]],
  donor: [["ch","Channel / system","text",150],["level","Level at the donor port dBm","num",110],["note","Note","text",160]],
  talk: [["t","Time","datetime",170],["kind","Test","kind",120],["where","Where (floor, square)","text",130],["radio","Radio / channel","text",130],["contact","Radio shop / dispatcher","text",150],["result","Result","result",110],["note","Note","text",140]],
};
// the job's bands and uplink channels, to start the tables with (not saved until something is typed)
function cmBands(d){ const L=typeof dsBands==="function"?(()=>{ try{ return dsBands(d).filter(b=>!b.cell).map(b=>b.band); }catch(e){ return []; } })():[];
  if(L.length) return L; const s=new Set(); for(const p of (d.presurvey||{}).plan||[]) if(p.downlink_mhz) s.add(dasBand(+p.downlink_mhz)); return [...s]; }
function cmUplinks(d){ const out=[], seen=new Set();
  for(const p of (d.presurvey||{}).plan||[]) for(const u of String(p.uplink_mhz||"").split(" ").filter(Boolean)) if(!seen.has(u)&&out.length<8){ seen.add(u); out.push(`${p.system?p.system+" ":""}${u} MHz`); }
  return out; }
const cmChip = s => s==null?'<span class="tag">Nothing yet</span>':s==="pass"?'<span class="tag v">Pass</span>':s==="fail"?'<span class="tag w">Fail</span>':'<span class="tag">Not done</span>';
const cmSrc = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;

window.dasCommission = (el, j0, save) => {
  let j=j0;
  const d=()=>j.data||{}, C=()=>JSON.parse(JSON.stringify(d().commission||{}));
  let cur=C();
  // rows to start with: the job's bands and uplinks, shown but not saved until typed into
  if(!(cur.iso||{}).rows?.length) cur.iso={...(cur.iso||{}), rows:cmBands(d()).map(b=>({band:b}))};
  if(!(cur.gain||{}).rows?.length) cur.gain={...(cur.gain||{}), rows:cmBands(d()).map(b=>({band:b}))};
  if(!(cur.noise||{}).rows?.length) cur.noise={...(cur.noise||{}), rows:cmUplinks(d()).map(c=>({ch:c}))};
  if(!(cur.donor||{}).rows?.length) cur.donor={...(cur.donor||{}), rows:cmBands(d()).map(b=>({ch:b}))};
  const by=()=>(S.me&&S.me.user)||((d().testing||{}).tester)||"";
  // saves go one after another (each carries the whole record), CM.busy counts them for the UI sweep
  let chain=Promise.resolve();
  const keep=force=>{ CM.busy++; chain=chain.then(async()=>{ const tests=cmTests({...d(), commission:cur}), M=cmMerge(d().acceptance, tests, by(), new Date().toISOString().slice(0,16), force);
    const patch={commission:cur}; if(M.changed) patch.acceptance=M.acceptance;
    j=await save(patch)||j; refresh(); }).finally(()=>{ CM.busy--; }); return chain; };
  const table=(step, cols)=>{ const rows=(cur[step]||{}).rows||[];
    return `<div class="tw"><table class="cm-t"><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}${step==="noise"?"<th>Import</th>":""}<th>Result</th><th></th></tr></thead><tbody>
      ${rows.map((r,i)=>`<tr data-step="${step}" data-i="${i}">${cols.map(([k,,t,w])=>`<td>${
        t==="kind"?`<select data-f="${k}"><option value="talk-back" ${r[k]!=="near-far"?"selected":""}>Talk-back</option><option value="near-far" ${r[k]==="near-far"?"selected":""}>Near-far</option></select>`
        :t==="result"?`<select data-f="${k}"><option value="">—</option>${[["clear","Clear"],["not clear","Not clear"]].map(([v,l])=>`<option value="${v}" ${r[k]===v?"selected":""}>${l}</option>`).join("")}</select>`
        :t==="datetime"?`<input data-f="${k}" type="datetime-local" value="${esc(r[k]||"")}" style="width:${w}px">`
        :`<input data-f="${k}" ${t==="num"?'type="number" step="any" inputmode="decimal"':""} value="${esc(r[k]??"")}" style="width:${w}px">`}</td>`).join("")}
        ${step==="noise"?`<td style="white-space:nowrap"><label class="cm-up" title="A trace or log from the analyzer, booster off: averaged as power">⇪ off<input type="file" data-imp="off" accept=".csv,.txt,.tsv,.xlsx" hidden></label> <label class="cm-up" title="The same, booster on">⇪ on<input type="file" data-imp="on" accept=".csv,.txt,.tsv,.xlsx" hidden></label></td>`:""}
        <td data-res class="hint" style="white-space:normal;min-width:160px"></td><td><button data-rm aria-label="Remove this row">✕</button></td></tr>`).join("")}
      </tbody></table></div><button data-add="${step}" style="margin-top:6px">+ Add a row</button>`; };
  const draw=()=>{ const N=cmNumbers({...d(), commission:cur}), T=cur, ahj=cmAhjKey({...d(), commission:cur});
    const one=(n, id, title, body, how)=>`<div class="panel cm-step" data-id="${id}"><h3><span class="cm-n">${n}</span> ${esc(title)} <span data-chip="${id}"></span></h3>
      <p class="hint" style="margin:0 0 8px">${how}</p>${body}<p class="hint cm-note" data-note="${id}" style="margin:8px 0 0"></p></div>`;
    el.innerHTML=`<div class="panel" style="margin-top:0"><h3>Commissioning <span class="hint">· any analyzer, any maker's BDA; each step's result goes into the acceptance tests on the Report</span></h3>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end"><label>AHJ numbers <select id="cmAhj">${Object.entries(CM_AHJ).map(([k,a])=>`<option value="${k}" ${k===ahj?"selected":""}>${esc(a.name)}</option>`).join("")}</select></label>
        <button id="cmPrint">⎙ Print the commissioning record</button></div>
      <p class="hint" style="margin:6px 0 0">${esc(N.name)}: ${esc(CM_AHJ[ahj].says)} ${cmSrc(CM_AHJ[ahj].src, "Source")}${CM_AHJ[ahj].checked==="excerpt"?" (read from an excerpt of the document)":""}.${ahj!=="nfpa"?` Everything else: ${cmSrc(CM_NFPA, "NFPA 1225 (2022)")} and ${cmSrc(CM_IFC, "IFC 2021 510")}.`:""}
        ${(cur.ahj?"":"Picked from the job's AHJ. ")}Noise rise under ${N.rise_db} dB, then ${N.extra_cut_db} dB more · RBW ${N.rbw_khz} kHz · ${N.avg_min}-minute average · isolation ${N.iso_margin_db} dB over gain (${esc(N.iso_from)})${N.noise_max_dbm!=null?` · noise at the site ≤ ${N.noise_max_dbm} dBm`:""}${N.donor_min_dbm!=null?` · donor ${N.donor_min_dbm} to ${N.donor_max_dbm} dBm`:""}${N.ul_over_noise_db!=null?` · uplink ≤ ${N.ul_over_noise_db} dB over the site floor`:""}${N.near_far?" · near-far test":""}.</p>
      <div class="cm-sum" id="cmSum"></div><div id="cmKept"></div></div>
    ${one(1, "noise_floor", "Donor-site noise test", `<div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px;align-items:flex-end">
        <label>Site<input data-k="noise.site" value="${esc(T.noise?.site||"")}" placeholder="the agency's nearest site" style="width:170px"></label>
        <label>Radio shop contact<input data-k="noise.contact" value="${esc(T.noise?.contact||"")}" style="width:160px"></label>
        <label>Analyzer<input data-k="noise.analyzer" value="${esc(T.noise?.analyzer||"")}" placeholder="make, model, serial" style="width:170px"></label>
        <label>RBW kHz<input data-k="noise.rbw_khz" type="number" step="any" value="${esc(T.noise?.rbw_khz??"")}" placeholder="${N.rbw_khz}" style="width:70px"></label>
        <label>Average, minutes<input data-k="noise.avg_min" type="number" step="any" value="${esc(T.noise?.avg_min??"")}" placeholder="${N.avg_min}" style="width:70px"></label></div>
      ${table("noise", CM_ROWS.noise)}`,
      `At the agency's site nearest the building, on its receiver multicoupler (the licensee's radio shop allows and usually runs this): RBW ${N.rbw_khz} kHz, idle uplink channel, ${N.avg_min}-minute average. Read with the booster off, then on. A rise of ${N.rise_db} dB or more: cut the uplink gain until the rise is gone, then ${N.extra_cut_db} dB more, and record the gain (${cmSrc(CM_NFPA, "NFPA 1225 A.18.9.3")}). A trace or log imported per reading is averaged as power and kept in Files.`)}
    ${one(2, "isolation", "Isolation, donor to server antennas", table("iso", CM_ROWS.iso),
      `Per band, at least the system gain + ${N.iso_margin_db} dB (${cmSrc(CM_NFPA, "NFPA 1225 18.10")}${N.iso_from!==N.base.name?`; ${esc(N.iso_from)}`:""}). Leave the gain empty to use step 3's higher of UL and DL.${(()=>{ const b=((d().design||{}).bands)||{}, est=Object.entries(b).filter(([,v])=>v&&v.isolation_db!=null); return est.length?` Design estimate: ${est.map(([k,v])=>`${esc(k)} ${v.isolation_db} dB`).join(", ")}.`:""; })()}`)}
    ${one(3, "gain", "Gain, AGC and filter settings", `<div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px;align-items:flex-end">
        ${[["maker","Maker",120],["model","Model",130],["serial","Serial",110],["fcc_id","FCC ID",120],["fw","Firmware",90]].map(([k,l,w])=>`<label>${l}<input data-k="gain.${k}" value="${esc(T.gain?.[k]||"")}" style="width:${w}px"></label>`).join("")}
        <label class="cm-up">⇪ Screenshot or photo of the settings<input type="file" id="cmShot" accept="image/*,.pdf" hidden></label></div>
      ${(T.gain?.shots||[]).length?`<p class="hint" style="margin:0 0 6px">In Files: ${T.gain.shots.map(esc).join(", ")}</p>`:""}
      ${table("gain", CM_ROWS.gain)}<label class="cm-up" style="margin-top:6px">⇪ Import a settings table (CSV)<input type="file" id="cmGainCsv" accept=".csv,.txt,.tsv,.xlsx" hidden></label>`,
      `Every band or channel as set on the BDA: uplink and downlink gain, AGC / ALC, filter or passband, output (${cmSrc(CM_NFPA, "NFPA 1225 20.3.10.1.3(11)")}; ${cmSrc(CM_IFC, "IFC 2021 510.5.4(6)")}: the gain of every amplifier). A table exported from the BDA's own software imports by its column names.`)}
    ${one(4, "oscillation", "Oscillation check", `<div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        ${[["dl","Downlink passband"],["ul","Uplink passband"]].map(([k,l])=>`<label>${l}<select data-k="osc.${k}"><option value="">—</option><option value="none" ${T.osc?.[k]==="none"?"selected":""}>No oscillation</option><option value="seen" ${T.osc?.[k]==="seen"?"selected":""}>Oscillation seen</option></select></label>`).join("")}
        <label>Alarm and shutdown<select data-k="osc.alarm"><option value="">not tested</option><option value="yes" ${T.osc?.alarm==="yes"?"selected":""}>Worked</option><option value="no" ${T.osc?.alarm==="no"?"selected":""}>Did not work</option></select></label>
        <label>Analyzer<input data-k="osc.analyzer" value="${esc(T.osc?.analyzer||"")}" style="width:170px"></label><label class="grow">Note<input data-k="osc.note" value="${esc(T.osc?.note||"")}"></label></div>`,
      `With the BDA on, sweep the downlink and uplink passbands on a spectrum analyzer for spurious oscillation (${cmSrc(CM_IFC, "IFC 2021 510.5.4(7)")}), at installation and each annual test.`)}
    ${one(5, "donor_level", "Donor level and source type", `<label style="display:block;margin-bottom:6px">Signal source <select data-k="donor.source"><option value="">—</option>${CM_SOURCES.map(s=>`<option ${T.donor?.source===s?"selected":""}>${esc(s)}</option>`).join("")}</select></label>${table("donor", CM_ROWS.donor)}`,
      `The level each channel arrives with at the BDA's donor port, and the source type (${cmSrc(CM_NFPA, "NFPA 1225 20.3.10.1.3(9), (10)")})${N.donor_min_dbm!=null?`; ${esc(N.name)} asks ${N.donor_min_dbm} to ${N.donor_max_dbm} dBm`:""}.`)}
    ${one(6, "two_radio", "Talk-back and near-far log", table("talk", CM_ROWS.talk),
      `Talk-back: a radio inside, one outside or at dispatch, both ways, with the radio shop or dispatcher on the line (${cmSrc(CM_IFC, "IFC 2021 510.5.4(8)")}: the two-radio test). Near-far: a radio keyed close to a server antenna while another works the far edge${N.near_far?` (${esc(N.name)} asks for it)`:""}. Log each call with the time and who answered.`)}`;
    wire(); refresh(); };
  // results in place, so typing doesn't redraw the inputs
  const refresh=()=>{ if(!el.isConnected) return; const dd={...d(), commission:cur}, N=cmNumbers(dd), tests=cmTests(dd), acc=((d().acceptance||{}).tests)||{};
    const G={noise:cmNoise(cur,N), iso:cmIso(cur,N)};
    el.querySelectorAll('tr[data-step]').forEach(tr=>{ const s=tr.dataset.step, i=+tr.dataset.i, cell=tr.querySelector("[data-res]"); if(!cell||!(cur[s]?.rows||[])[i]) return; let t="";
      if(s==="noise"||s==="iso"){ const x=(G[s]?.rows||[]).find(z=>z.r===cur[s].rows[i]); t=x?`<span style="color:${x.done?(x.ok?"var(--good)":"var(--bad)"):"inherit"}">${esc(x.why)}</span>`:""; }
      else if(s==="gain"){ const r=cur.gain.rows[i]; t=r.band||r.ul||r.dl?(cmN(r.ul)!=null&&cmN(r.dl)!=null?"recorded":"needs UL and DL gain"):""; }
      else if(s==="donor"){ const r=cur.donor.rows[i], v=cmN(r.level); t=v==null?"":N.donor_min_dbm==null?"recorded":`<span style="color:${v>=N.donor_min_dbm&&v<=N.donor_max_dbm?"var(--good)":"var(--bad)"}">${v>=N.donor_min_dbm&&v<=N.donor_max_dbm?"inside":"outside"} ${N.donor_min_dbm} to ${N.donor_max_dbm} dBm</span>`; }
      else if(s==="talk"){ const r=cur.talk.rows[i]; t=r.result==="clear"?'<span style="color:var(--good)">clear</span>':r.result?'<span style="color:var(--bad)">not clear</span>':""; }
      cell.innerHTML=t; });
    for(const [id,l] of CM_IDS){ const t=tests[id], ch=el.querySelector(`[data-chip="${id}"]`), nt=el.querySelector(`[data-note="${id}"]`);
      if(ch) ch.innerHTML=cmChip(t?.status); if(nt) nt.textContent=t?[t.value!=null&&t.value!==""?`${t.value} ${t.unit||""}`.trim():"", t.note||""].filter(Boolean).join(" · "):""; }
    $("#cmSum").innerHTML=CM_IDS.map(([id,l])=>`<span class="cm-s">${cmChip(tests[id]?.status)} ${esc(l)}</span>`).join("");
    const kept=CM_IDS.filter(([id])=>tests[id]&&acc[id]&&acc[id].src!=="commissioning");
    $("#cmKept").innerHTML=kept.length?`<p class="status" style="margin:6px 0 0">Typed elsewhere and kept on the Report: ${kept.map(([id,l])=>`${esc(l)} (${esc(acc[id].status)}) <button class="sm" data-force="${id}">Use the commissioning result</button>`).join(" ")}</p>`:"";
    $("#cmKept").querySelectorAll("[data-force]").forEach(b=>b.onclick=()=>keep([b.dataset.force])); };
  const set=(path, v)=>{ const [a,b]=path.split("."); cur[a]={...(cur[a]||{}), [b]:v}; };
  const wire=()=>{
    $("#cmAhj").onchange=e=>{ cur.ahj=e.target.value; keep().then(draw); };
    el.querySelectorAll("[data-k]").forEach(i=>i.onchange=()=>{ set(i.dataset.k, i.type==="number"?(i.value===""?null:+i.value):i.value); keep(); });
    el.querySelectorAll("tr[data-step] [data-f]").forEach(i=>i.onchange=()=>{ const tr=i.closest("tr"), s=tr.dataset.step, r=cur[s].rows[+tr.dataset.i];
      r[i.dataset.f]=i.type==="number"?(i.value===""?null:+i.value):i.value; keep(); });
    el.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{ const s=b.dataset.add; cur[s]={...(cur[s]||{}), rows:[...((cur[s]||{}).rows||[]), s==="talk"?{t:cmNow()}:{}]}; draw(); });
    el.querySelectorAll("tr[data-step] [data-rm]").forEach(b=>b.onclick=()=>{ const tr=b.closest("tr"), s=tr.dataset.step; cur[s].rows.splice(+tr.dataset.i,1); draw(); keep(); });
    el.querySelectorAll("[data-imp]").forEach(inp=>inp.onchange=async()=>{ const f=inp.files[0]; inp.value=""; if(!f) return; const tr=inp.closest("tr"), r=cur.noise.rows[+tr.dataset.i];
      CM.busy++; try{ const t=await cmParse(f), lv=cmLevels(t); if(!lv.vals.length) throw new Error("no column of dBm readings found");
        r[inp.dataset.imp]=cmR1(cmAvgDbm(lv.vals)); r[`${inp.dataset.imp}_src`]=`${f.name}: ${lv.vals.length} readings of “${lv.col}”${lv.min!=null?`, ${cmR1(lv.min)} min`:""}`;
        await cmFile(j, f); await keep(); draw(); say(`${f.name}: ${lv.vals.length} readings averaged as power, ${r[inp.dataset.imp]} dBm${lv.min!=null&&lv.min<cmNumbers(d()).avg_min?` (only ${cmR1(lv.min)} minutes of readings)`:""}. Kept in Files.`); }
      catch(e){ say(`${f.name}: ${e.message}`); } finally{ CM.busy--; } });
    $("#cmShot").onchange=async e=>{ const f=e.target.files[0]; e.target.value=""; if(!f) return; try{ await cmFile(j, f); cur.gain={...(cur.gain||{}), shots:[...new Set([...(cur.gain?.shots||[]), f.name])]}; await keep(); draw(); say(`${f.name} saved to the job's Files.`); }catch(x){ say("Not saved: "+x.message); } };
    $("#cmGainCsv").onchange=async e=>{ const f=e.target.files[0]; e.target.value=""; if(!f) return;
      try{ const t=await cmParse(f), rows=cmGainRows(t); if(!rows.length) throw new Error("no band and gain columns found");
        cur.gain={...(cur.gain||{}), rows:[...((cur.gain||{}).rows||[]).filter(r=>r.band||r.ul||r.dl), ...rows]}; await cmFile(j, f); await keep(); draw(); say(`${rows.length} rows from ${f.name}. Kept in Files.`); }
      catch(x){ say(`${f.name}: ${x.message}`); } };
    $("#cmPrint").onclick=()=>{ const box=document.createElement("div"); box.className="panel"; box.innerHTML=cmRecord({...d(), commission:cur}, j.name); dasPrintCopy(box); }; };
  const say=t=>{ let s=el.querySelector("#cmSay"); if(!s){ s=document.createElement("p"); s.id="cmSay"; s.className="status"; s.setAttribute("role","status"); el.querySelector(".panel")?.appendChild(s); } s.textContent=t; };
  draw();
};
const cmNow = () => { const t=new Date(), p=x=>String(x).padStart(2,"0"); return `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`; };
const cmParse = async f => api(`/api/das/parse?name=${encodeURIComponent(f.name)}`, {method:"POST", body:await f.arrayBuffer()});
const cmFile = async (j, f) => api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(f.name)}`, {method:"POST", body:await f.arrayBuffer()});
// the dBm readings in an imported table: the column named like a level (else the one whose values look like dBm), and how
// many minutes its time column spans
function cmLevels(t){ const H=t.headers||[], R=t.rows||[], numCol=h=>R.map(r=>parseFloat(String(r[h]??"").replace(/[^\d.eE+\-]/g,""))).filter(isFinite);
  const named=H.find(h=>/dbm|level|power|ampl|noise|marker|trace|value/i.test(h)&&!/freq|time|date|hz/i.test(h)&&numCol(h).length);
  const looks=H.find(h=>{ const v=numCol(h); return v.length>=R.length*.8&&v.length&&v.every(x=>x<=0&&x>=-200); });
  const col=named||looks; if(!col) return {vals:[], col:null, min:null};
  const tc=H.find(h=>/time|date|stamp|elapsed|sec/i.test(h)); let min=null;
  if(tc){ const ts=R.map(r=>{ const s=String(r[tc]??"").trim(); return /^-?\d+(\.\d+)?$/.test(s)?+s*1000:Date.parse(s.replace(/^(\d{4})\.(\d\d)\.(\d\d)_(\d\d)\.(\d\d)\.(\d\d)$/,"$1-$2-$3T$4:$5:$6")); }).filter(isFinite);
    if(ts.length>1) min=(Math.max(...ts)-Math.min(...ts))/60000; }
  return {vals:numCol(col), col, min}; }
// a BDA's settings table -> gain rows, by column names
function cmGainRows(t){ const H=t.headers||[], f=re=>H.find(h=>re.test(h));
  const band=f(/band|channel|ch\b|passband|freq/i), ul=f(/u(p)?l(ink)?.*gain|gain.*u(p)?l/i), dl=f(/d(own)?l(ink)?.*gain|gain.*d(own)?l/i), agc=f(/agc|alc/i), flt=f(/filter|bandwidth|bw/i), out=f(/out|power|max/i);
  if(!band||(!ul&&!dl)) return [];
  const n=v=>{ const x=parseFloat(String(v??"").replace(/[^\d.eE+\-]/g,"")); return isFinite(x)?x:null; };
  return (t.rows||[]).filter(r=>r[band]).map(r=>({band:r[band], ul:ul?n(r[ul]):null, dl:dl?n(r[dl]):null, agc:agc?r[agc]:"", filter:flt&&flt!==band?r[flt]:"", out:out?n(r[out]):null})); }
// the printable record: every step's readings and its result
function cmRecord(d, name){ const C=d.commission||{}, N=cmNumbers(d), T=cmTests(d), A=CM_AHJ[N.key];
  const tbl=(step, cols)=>{ const rows=((C[step]||{}).rows||[]).filter(r=>cols.some(([k])=>r[k]!=null&&r[k]!=="")); if(!rows.length) return "";
    return `<table><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${cols.map(([k])=>`<td>${esc(r[k]??"")}</td>`).join("")}</tr>`).join("")}</tbody></table>`; };
  return `<h2 style="margin:0 0 4px">BDA commissioning record: ${esc(name)}</h2><p style="margin:0 0 8px">${esc(d.address||"")} · ${esc(d.ahj||"AHJ not set")} · prepared ${esc(typeof today==="function"?today():"")}</p>
    <p class="hint">Numbers: ${esc(N.name)} (${esc(A.src)}${A.checked==="excerpt"?", read from an excerpt":""}); NFPA 1225 (2022) A.18.9.3, 18.10, 20.3.10.1.3 (${CM_NFPA}); IFC 2021 510.5.4(6)-(8) (${CM_IFC}).</p>
    <table><thead><tr><th>Test</th><th>Result</th><th>Value</th><th>Detail</th></tr></thead><tbody>${CM_IDS.map(([id,l])=>{ const t=T[id]; return `<tr><td>${esc(l)}</td><td>${esc(t?t.status:"not done")}</td><td>${esc(t&&t.value!=null?`${t.value} ${t.unit||""}`:"")}</td><td>${esc(t?t.note:"")}</td></tr>`; }).join("")}</tbody></table>
    <h3>1 Donor-site noise test</h3><p>${esc([C.noise?.site&&`Site: ${C.noise.site}`, C.noise?.contact&&`Radio shop: ${C.noise.contact}`, C.noise?.analyzer&&`Analyzer: ${C.noise.analyzer}`, C.noise?.rbw_khz!=null&&`RBW ${C.noise.rbw_khz} kHz`, C.noise?.avg_min!=null&&`${C.noise.avg_min}-minute average`].filter(Boolean).join(" · "))}</p>${tbl("noise", CM_ROWS.noise)}
    <h3>2 Isolation</h3>${tbl("iso", CM_ROWS.iso)}
    <h3>3 Gain, AGC and filter settings</h3><p>${esc([C.gain?.maker, C.gain?.model, C.gain?.serial&&`serial ${C.gain.serial}`, C.gain?.fcc_id&&`FCC ID ${C.gain.fcc_id}`, C.gain?.fw&&`firmware ${C.gain.fw}`].filter(Boolean).join(" · "))}</p>${tbl("gain", CM_ROWS.gain)}
    <h3>4 Oscillation check</h3><p>${esc(T.oscillation?`${T.oscillation.value} · ${T.oscillation.note}`:"not done")}</p>
    <h3>5 Donor level and source</h3><p>${esc(C.donor?.source||"")}</p>${tbl("donor", CM_ROWS.donor)}
    <h3>6 Talk-back and near-far</h3>${tbl("talk", CM_ROWS.talk)}`; }

document.head.insertAdjacentHTML("beforeend", `<style>.cm-n{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:12px;background:var(--accent,#1f6feb);color:#fff;font-size:13px;margin-right:4px}
  .cm-sum{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px}.cm-s{white-space:nowrap}
  .cm-up{display:inline-flex;align-items:center;min-height:32px;padding:0 10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
  .cm-t td{vertical-align:top}.cm-t input,.cm-t select{min-height:32px}</style>`);
