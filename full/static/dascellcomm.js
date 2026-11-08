"use strict";
/* DAStastic — cellular commissioning (job › Commissioning › Cellular; Cody 11/6, the carrier-work mock-up he approved).
   No US carrier publishes its commissioning procedure. These are Viavi's public steps (DAS Deployment Overview, 2017) with
   Australia's MCF Design Guidelines 2025 and one owner's RFP (Providence Water), as the DAS course teaches them (lessons 7.9 and 7.10). A carrier's
   own number wins wherever it gives one: each threshold here can be changed on the page.
     A gate: sweeps, fiber and PIM passed, an alarm-free DAS health report
     B baseline noise per sector and band at the demark (a record: the carrier's number decides)
     C downlink CW at each antenna, within 5 dB of the link budget (Viavi)
     D uplink: a −50 to −60 dBm tone at a remote read at the demark for unity gain, then +10 dBm over the air within 30 ft,
       read at the head-end within 5 dB (Viavi)
     E the uplink kept quiet as remotes are added: the rise against the carrier's number
     F POI and balance: equal power per MHz per operator on a shared amplifier (MCF 2025 5.5.4)
     G alarms: none on the RAN or the DAS, and a forced alarm test
     H calls near every antenna: voice holds 2 minutes, phones at maximum power at 10% of points or fewer, calls in failover at
       90% of locations or more (Providence Water RFP PVD26-53, 3.10)
   Saved as data.commission_cell. The public-safety record (data.commission, data.acceptance) is untouched by it. */

const CC_VIAVI = "https://www.viavisolutions.com/en-us/literature/das-deployment-overview-streamlined-approaches-das-deployments-application-notes-en.pdf";
const CC_MCF = "https://amta.org.au/wp-content/uploads/2026/07/MCF-Design-Guidelines-for-Distributed-Antenna-Systems-060525-FINAL.pdf";  // Australia's Mobile Carriers Forum
const CC_PVD = "https://www.providenceri.gov/wp-content/uploads/2026/04/PVD26-53-Water-Supply-RFP-Cellular-Distributed-Antenna-System-DAS-MT-52843.pdf";
const CC_DEF = {dl_tol_db: 5, ota_tol_db: 5, unity_tol_db: 1, tone_lo: -60, tone_hi: -50, psd_tol_db: 1, hold_s: 120, max_share: 0.10, failover_share: 0.90, pmax_dbm: 23, pmax_near_db: 1};
const CC_IDS = [["gate","Gate: plant passed"], ["noise","Baseline noise"], ["dl","Downlink CW at each antenna"], ["ul","Uplink: unity gain and over the air"],
  ["quiet","Uplink kept quiet"], ["poi","POI and balance"], ["alarms","Alarms"], ["calls","Calls near every antenna"]];
const ccN = v => v===""||v==null ? null : isFinite(+v) ? +v : null;
const ccR1 = x => Math.round(x*10)/10;
const ccNum = C => ({...CC_DEF, ...Object.fromEntries(Object.entries(C.limits||{}).filter(([k,v])=>k in CC_DEF&&ccN(v)!=null).map(([k,v])=>[k,+v]))});
const ccDone = (ok, total) => ok===total;

/* ---------- each step's grade: {status: "pass"|"fail"|"not done", value, unit, note, rows?} (null: nothing entered) ---------- */
function ccGate(C){ const G=C.gate||{}, k=["sweep","fiber","pim","health"], set=k.filter(x=>G[x]); if(!set.length) return null;
  const bad=k.filter(x=>G[x]==="no"), miss=k.filter(x=>!G[x]), name={sweep:"sweeps", fiber:"fiber", pim:"PIM", health:"DAS health report"};
  return {status:bad.length?"fail":miss.length?"not done":"pass", value:`${k.length-bad.length-miss.length} of ${k.length}`, unit:"in hand",
    note:[bad.length?`not passed: ${bad.map(x=>name[x]).join(", ")}`:"", miss.length?`not checked: ${miss.map(x=>name[x]).join(", ")}`:""].filter(Boolean).join(" · ")||"sweeps, fiber and PIM passed; the DAS reports no alarms"}; }
function ccNoise(C){ const rows=((C.noise||{}).rows||[]).filter(r=>ccN(r.dbm)!=null); if(!rows.length) return null;
  return {status:"pass", value:rows.length, unit:`reading${rows.length===1?"":"s"} kept`, note:`the baseline each later rise is read against: ${rows.map(r=>`${r.sector||"sector"} ${r.band||""} ${r.dbm} dBm`.replace(/\s+/g," ")).join("; ")}`}; }
function ccDl(C, N){ const rows=((C.dl||{}).rows||[]).filter(r=>ccN(r.meas)!=null); if(!rows.length) return null;
  const out=rows.map(r=>{ const calc=ccN(r.calc), m=+r.meas; if(calc==null) return {r, done:false, why:"needs the link budget's level"};
    const d=m-calc; return {r, done:true, ok:Math.abs(d)<=N.dl_tol_db, why:`${ccR1(d)>=0?"+":""}${ccR1(d)} dB against the budget${Math.abs(d)>N.dl_tol_db?(d<0?": low, look for a swap, a bad cable or a dead remote before touching gain":": high, check the attenuation and the coupler direction"):""}`}; });
  const done=out.filter(x=>x.done), bad=done.filter(x=>!x.ok);
  return {status:!done.length?"not done":bad.length?"fail":done.length<out.length?"not done":"pass", value:`${done.length-bad.length} of ${out.length}`, unit:`within ${N.dl_tol_db} dB`,
    note:bad.map(x=>`${x.r.antenna||"an antenna"} ${x.r.band||""}: ${x.why}`).join("; ")||`every antenna within ${N.dl_tol_db} dB of the link budget (Viavi)`, rows:out}; }
function ccUl(C, N){ const rows=((C.ul||{}).rows||[]).filter(r=>ccN(r.tone_out)!=null||ccN(r.ota_meas)!=null); if(!rows.length) return null;
  const out=rows.map(r=>{ const tin=ccN(r.tone_in), tout=ccN(r.tone_out), exp=ccN(r.ota_exp), got=ccN(r.ota_meas), why=[]; let ok=true, done=true;
    if(tin==null||tout==null){ done=false; why.push("unity: needs the tone in and out"); }
    else { if(tin<N.tone_lo||tin>N.tone_hi) why.push(`tone ${tin} dBm is outside ${N.tone_lo} to ${N.tone_hi} dBm`);
      const d=tout-tin; if(Math.abs(d)>N.unity_tol_db){ ok=false; why.push(`out ${ccR1(d)>=0?"+":""}${ccR1(d)} dB from in: set the attenuation until out equals in`); } else why.push(`unity within ${N.unity_tol_db} dB${r.atten!=null&&r.atten!==""?` at ${r.atten} dB attenuation`:""}`); }
    if(got==null||exp==null){ done=false; why.push("over the air: needs the expected and the read level"); }
    else { const d=got-exp; if(Math.abs(d)>N.ota_tol_db){ ok=false; why.push(`over the air ${ccR1(d)>=0?"+":""}${ccR1(d)} dB from expected`); } else why.push(`over the air within ${N.ota_tol_db} dB`); }
    return {r, done, ok, why:why.join("; ")}; });
  const done=out.filter(x=>x.done), bad=out.filter(x=>x.done&&!x.ok);
  return {status:!done.length?"not done":bad.length?"fail":done.length<out.length?"not done":"pass", value:`${done.length-bad.length} of ${out.length}`, unit:"sectors and bands",
    note:out.map(x=>`${x.r.sector||"sector"} ${x.r.band||""}: ${x.why}`.replace(/\s+/g," ")).join(" · "), rows:out}; }
function ccQuiet(C){ const Q=C.quiet||{}, rows=(Q.rows||[]).filter(r=>ccN(r.before)!=null&&ccN(r.after)!=null); if(!rows.length) return null;
  const lim=ccN(Q.carrier_rise_db), worst=Math.max(...rows.map(r=>+r.after-+r.before));
  if(lim==null) return {status:"not done", value:ccR1(worst), unit:"dB worst rise", note:"recorded. Viavi says some rise should remain; the carrier's number decides, so ask their integration engineer and enter it"};
  const bad=rows.filter(r=>+r.after-+r.before>lim);
  return {status:bad.length?"fail":"pass", value:ccR1(worst), unit:"dB worst rise", note:`against the carrier's ${lim} dB${Q.carrier_src?` (${Q.carrier_src})`:""}${bad.length?`; over it: ${bad.map(r=>`${r.sector||"sector"} ${r.band||""} ${ccR1(+r.after-+r.before)} dB`).join(", ")}`:""}`}; }
// LTE reference signal: composite less 10·log10(subcarriers) (30.8 dB at 20 MHz, 27.8 dB at 10 MHz)
const ccRsOffset = mhz => { const sc=typeof cellSubcarriers==="function"?cellSubcarriers(+mhz, 15):Math.round(+mhz*5)*12; return 10*Math.log10(sc); };
function ccPoi(C, N){ const rows=((C.poi||{}).rows||[]).filter(r=>ccN(r.composite)!=null&&ccN(r.bw_mhz)); if(!rows.length) return null;
  const byBand={}; for(const r of rows){ const k=String(r.band||"").trim()||"band"; (byBand[k]=byBand[k]||[]).push(r); }
  const lines=[], bad=[];
  for(const [b, L] of Object.entries(byBand)){ const psd=L.map(r=>({r, v:+r.composite-10*Math.log10(+r.bw_mhz)})), sp=Math.max(...psd.map(x=>x.v))-Math.min(...psd.map(x=>x.v));
    if(L.length>1&&sp>N.psd_tol_db) bad.push(b);
    lines.push(`${b}: ${psd.map(x=>`${x.r.carrier||"carrier"} ${ccR1(x.v)} dBm/MHz${ccN(x.r.rs)!=null?`, RS ${x.r.rs} dBm (expected ${ccR1(+x.r.composite-ccRsOffset(x.r.bw_mhz))})`:""}`).join(", ")}${L.length>1?`; spread ${ccR1(sp)} dB`:""}`); }
  return {status:bad.length?"fail":"pass", value:Object.keys(byBand).length, unit:`band${Object.keys(byBand).length===1?"":"s"}`,
    note:`${lines.join(" · ")}${bad.length?` · not equal power per MHz (over ${N.psd_tol_db} dB) on ${bad.join(", ")}`:""} · MCF 2025 5.5.4: equal power per MHz per operator`}; }
function ccAlarms(C){ const A=C.alarms||{}; if(!A.clear&&!A.forced) return null;
  return {status:A.clear==="no"||A.forced==="no"?"fail":A.clear==="yes"&&A.forced==="yes"?"pass":"not done", value:"", unit:"",
    note:[A.clear==="yes"?"no RAN or DAS alarms":A.clear==="no"?"alarms open on the RAN or the DAS":"alarms not checked", A.forced==="yes"?"a forced alarm reached its monitor":A.forced==="no"?"the forced alarm didn't arrive":"no forced alarm test", A.note||""].filter(Boolean).join(" · ")}; }
// a call row: kind voice | volte | data | failover; result ok | dropped | failed; hold_s seconds held; ue_tx dBm
function ccCalls(C, N){ const rows=((C.calls||{}).rows||[]).filter(r=>r.result); if(!rows.length) return null;
  const voice=rows.filter(r=>r.kind==="voice"||r.kind==="volte"), fo=rows.filter(r=>r.kind==="failover");
  const shortV=voice.filter(r=>r.result!=="ok"||(ccN(r.hold_s)!=null&&+r.hold_s<N.hold_s)), noHold=voice.filter(r=>r.result==="ok"&&ccN(r.hold_s)==null);
  const tx=rows.filter(r=>ccN(r.ue_tx)!=null), atMax=tx.filter(r=>+r.ue_tx>=N.pmax_dbm-N.pmax_near_db), share=tx.length?atMax.length/tx.length:null;
  const foOk=fo.length?fo.filter(r=>r.result==="ok").length/fo.length:null, other=rows.filter(r=>!["voice","volte","failover"].includes(r.kind)&&r.result!=="ok");
  const fails=[shortV.length?`${shortV.length} voice call${shortV.length===1?"":"s"} dropped, failed or held under ${N.hold_s} s`:"",
    share!=null&&share>N.max_share?`phones at maximum power at ${Math.round(share*100)}% of points (${N.max_share*100}% at most): the uplink is short`:"",
    foOk!=null&&foOk<N.failover_share?`calls in failover at ${Math.round(foOk*100)}% of locations (${N.failover_share*100}% at least)`:"",
    other.length?`${other.length} data session${other.length===1?"":"s"} failed`:""].filter(Boolean);
  const open=[noHold.length?`${noHold.length} voice call${noHold.length===1?"":"s"} with no hold time`:"", !tx.length?"no phone transmit power logged":""].filter(Boolean);
  return {status:fails.length?"fail":open.length?"not done":"pass", value:`${rows.filter(r=>r.result==="ok").length} of ${rows.length}`, unit:"calls ok",
    note:[...fails, ...open, share!=null?`phone transmit power logged at ${tx.length} point${tx.length===1?"":"s"}, at maximum (${N.pmax_dbm} dBm, within ${N.pmax_near_db} dB) at ${atMax.length}`:""].filter(Boolean).join(" · ")+` · Providence Water RFP PVD26-53 3.10: voice holds ${N.hold_s/60} minutes; phones at maximum power at ${N.max_share*100}% of points or fewer; failover calls at ${N.failover_share*100}% of locations`}; }
function ccTests(d){ const C=d.commission_cell||{}, N=ccNum(C);
  const g={gate:ccGate(C), noise:ccNoise(C), dl:ccDl(C,N), ul:ccUl(C,N), quiet:ccQuiet(C), poi:ccPoi(C,N), alarms:ccAlarms(C), calls:ccCalls(C,N)};
  const out={}; for(const [k,v] of Object.entries(g)) if(v){ const {status,value,unit,note}=v; out[k]={status,value,unit,note}; } return out; }
// the whole of it, for the Report and the carrier closeout: pass when every step passes
function ccOverall(d){ const T=ccTests(d), st=CC_IDS.map(([k])=>T[k]?.status||null);
  return {tests:T, status:st.every(s=>s==="pass")?"pass":st.some(s=>s==="fail")?"fail":st.some(Boolean)?"not done":null,
    done:st.filter(s=>s==="pass").length, of:CC_IDS.length}; }

/* ---------- the page ---------- */
const CC_ROWS = {
  noise: [["sector","Sector","text",110],["band","Band","text",110],["dbm","Noise floor at the demark, dBm","num",120],["note","Note (screenshot name)","text",170]],
  dl: [["antenna","Antenna (design ID)","text",130],["band","Band","text",110],["calc","Link budget level dBm","num",110],["meas","Measured dBm","num",100]],
  ul: [["sector","Sector","text",100],["band","Band","text",100],["tone_in","Tone in at the remote dBm","num",110],["tone_out","Read at the demark dBm","num",110],["atten","Attenuation set dB","num",90],["ota_exp","Over the air: expected dBm","num",110],["ota_meas","Over the air: read dBm","num",100]],
  quiet: [["sector","Sector","text",110],["band","Band","text",110],["before","Floor, first remote dBm","num",110],["after","Floor, all remotes dBm","num",110]],
  poi: [["carrier","Carrier","text",110],["band","Band","text",110],["bw_mhz","Channel MHz","num",80],["composite","Composite at the demark dBm","num",120],["rs","RS power dBm","num",90],["poi_db","POI attenuation dB","num",90]],
  calls: [["t","Time","datetime",170],["where","Where (antenna, square)","text",140],["carrier","Carrier","text",100],["kind","Call","kind",110],["result","Result","result",100],["hold_s","Held, s","num",70],["ue_tx","Phone Tx dBm","num",80],["rsrp","RSRP dBm","num",80],["note","Note","text",130]],
};
const ccChip = s => s==null?'<span class="tag">Nothing yet</span>':s==="pass"?'<span class="tag v">Pass</span>':s==="fail"?'<span class="tag w">Fail</span>':'<span class="tag">Not done</span>';
const ccSrc = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`;
const ccNow = () => { const t=new Date(), p=x=>String(x).padStart(2,"0"); return `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}`; };
// the job's LTE / 5G bands and carriers, to start the tables with (not saved until something is typed)
function ccBands(d){ try{ return typeof dsBands==="function"?dsBands(d).filter(b=>b.cell).map(b=>b.band):[]; }catch(e){ return []; } }
// a band's holders as single carriers: "Verizon, AT&T, T-Mobile" is three; a note in brackets stays with its name
const carrierNames = list => { const out=[]; for(const x of list) for(const n of String(x||"").split(/,(?![^(]*\))/)) { const t=n.trim(); if(t&&!out.some(o=>o.toLowerCase()===t.toLowerCase())) out.push(t); } return out; };
function ccCarriers(d){ const C=(d.cellular||{}).carriers; if(Array.isArray(C)&&C.length) return carrierNames(C.map(c=>typeof c==="string"?c:c.name));
  try{ const s=new Set(); for(const b of (typeof dsBands==="function"?dsBands(d):[]).filter(x=>x.cell)) for(const x of b.systems||[]) s.add(x); return carrierNames([...s]); }catch(e){ return []; } }

window.dasCellCommission = (el, j0, save) => {
  let j=j0;
  const d=()=>j.data||{};
  let cur=JSON.parse(JSON.stringify(d().commission_cell||{}));
  const bands=ccBands(d()), carriers=ccCarriers(d());
  if(!(cur.dl||{}).rows?.length) cur.dl={...(cur.dl||{}), rows:bands.map(b=>({band:b}))};
  if(!(cur.noise||{}).rows?.length) cur.noise={...(cur.noise||{}), rows:bands.map(b=>({sector:"Sector 1", band:b}))};
  if(!(cur.ul||{}).rows?.length) cur.ul={...(cur.ul||{}), rows:bands.map(b=>({sector:"Sector 1", band:b}))};
  if(!(cur.poi||{}).rows?.length) cur.poi={...(cur.poi||{}), rows:carriers.flatMap(c=>bands.slice(0, 2).map(b=>({carrier:c, band:b})))};
  let chain=Promise.resolve();
  const keep=()=>{ CCX.busy++; chain=chain.then(async()=>{ j=await save({commission_cell:cur})||j; refresh(); }).finally(()=>{ CCX.busy--; }); return chain; };
  const table=(step, cols)=>{ const rows=(cur[step]||{}).rows||[];
    return `<div class="tw"><table class="cm-t"><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}<th>Result</th><th></th></tr></thead><tbody>
      ${rows.map((r,i)=>`<tr data-cstep="${step}" data-i="${i}">${cols.map(([k,,t,w])=>`<td>${
        t==="kind"?`<select data-f="${k}">${[["voice","Voice"],["volte","VoLTE"],["data","Data"],["failover","Failover"]].map(([v,l])=>`<option value="${v}" ${(r[k]||"voice")===v?"selected":""}>${l}</option>`).join("")}</select>`
        :t==="result"?`<select data-f="${k}"><option value="">—</option>${[["ok","OK"],["dropped","Dropped"],["failed","Failed"]].map(([v,l])=>`<option value="${v}" ${r[k]===v?"selected":""}>${l}</option>`).join("")}</select>`
        :t==="datetime"?`<input data-f="${k}" type="datetime-local" value="${esc(r[k]||"")}" style="width:${w}px">`
        :`<input data-f="${k}" ${t==="num"?'type="number" step="any" inputmode="decimal"':""} value="${esc(r[k]??"")}" style="width:${w}px">`}</td>`).join("")}
        <td data-res class="hint" style="white-space:normal;min-width:150px"></td><td><button data-rm aria-label="Remove this row">✕</button></td></tr>`).join("")}
      </tbody></table></div><button data-add="${step}" style="margin-top:6px">+ Add a row</button>`; };
  const yn=(k, l, opts=[["yes","Yes"],["no","No"]])=>`<label>${l}<select data-k="${k}"><option value="">—</option>${opts.map(([v,t])=>`<option value="${v}" ${(k.split(".").reduce((o,x)=>o?.[x], cur))===v?"selected":""}>${t}</option>`).join("")}</select></label>`;
  const draw=()=>{ const N=ccNum(cur);
    const one=(n, id, title, body, how)=>`<div class="panel cm-step" data-cid="${id}"><h3><span class="cm-n">${n}</span> ${esc(title)} <span data-cchip="${id}"></span></h3>
      <p class="hint" style="margin:0 0 8px">${how}</p>${body}<p class="hint cm-note" data-cnote="${id}" style="margin:8px 0 0"></p></div>`;
    el.innerHTML=`<div class="panel" style="margin-top:0"><h3>Cellular commissioning <span class="hint">· carrier signal on air, in order, every number written down</span></h3>
      <p class="hint" style="margin:0 0 6px">No US carrier publishes its procedure. These are ${ccSrc(CC_VIAVI, "Viavi's public steps")} with Australia's ${ccSrc(CC_MCF, "MCF Design Guidelines 2025")} and one owner's call numbers (${ccSrc(CC_PVD, "Providence Water RFP PVD26-53")}). The carrier's own number wins where it gives one: change any limit here.
        ${bands.length?`Bands from the design: ${bands.map(esc).join(", ")}.`:"Add the job's LTE / 5G bands in Design › Link budget to start the tables with them."}${carriers.length?` Carriers: ${carriers.map(esc).join(", ")}.`:""}</p>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">${[["dl_tol_db","Downlink CW, within dB"],["ota_tol_db","Uplink over the air, within dB"],["unity_tol_db","Unity gain, within dB"],["psd_tol_db","Equal power per MHz, within dB"],["hold_s","Voice holds, s"],["pmax_dbm","Phone maximum dBm"]].map(([k,l])=>`<label>${l}<input data-lim="${k}" type="number" step="any" value="${esc((cur.limits||{})[k]??"")}" placeholder="${CC_DEF[k]}" style="width:80px"></label>`).join("")}
        <button id="ccPrint">⎙ Print the cellular record</button></div>
      <div class="cm-sum" id="ccSum"></div></div>
    ${one("A", "gate", "Gate: the plant passed", `<div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">${yn("gate.sweep","Sweeps passed")}${yn("gate.fiber","Fiber passed")}${yn("gate.pim","PIM passed")}${yn("gate.health","DAS health report: no alarms")}<label class="grow">Note<input data-k="gate.note" value="${esc(cur.gate?.note||"")}"></label></div>`,
      `Before anything transmits: the DAS connected demark to antenna, passing sweep, fiber and PIM reports (PIM / sweeps), and an alarm-free health report from the DAS. Get written approval and a clear frequency for each CW test: a tone in a licensed band is a transmission.`)}
    ${one("B", "noise", "Baseline noise", table("noise", CC_ROWS.noise), `Uplink attenuation at minimum or default, the DAS fully powered: read a clear in-band channel at the demark for each sector and band. Save the number and a screenshot named by sector, technology and band.`)}
    ${one("C", "dl", "Downlink CW at each antenna", table("dl", CC_ROWS.dl), `Null the test jumpers, inject CW at the demark at the maker's maximum input, and read each antenna from a safe distance. Within ${N.dl_tol_db} dB of the link budget passes. A low antenna is a fault with a cause: a swapped fiber, a backwards coupler, a dead remote. Turning up gain hides it and adds uplink noise.`)}
    ${one("D", "ul", "Uplink: unity gain, then over the air", table("ul", CC_ROWS.ul), `A ${N.tone_lo} to ${N.tone_hi} dBm tone into one remote per sector per band, read at the demark: set the attenuation until out equals in (unity gain) and log it. Then +10 dBm CW within 30 ft of an antenna on a clear uplink frequency, the other remotes on that sector off, read at the head-end: within ${N.ota_tol_db} dB passes. Repeat for each MIMO path.`)}
    ${one("E", "quiet", "Uplink kept quiet", `<div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:6px;align-items:flex-end"><label>Carrier's allowed rise dB<input data-k="quiet.carrier_rise_db" type="number" step="any" value="${esc(cur.quiet?.carrier_rise_db??"")}" style="width:90px"></label><label class="grow">Whose number<input data-k="quiet.carrier_src" value="${esc(cur.quiet?.carrier_src||"")}" placeholder="e.g. the carrier's integration engineer, by email"></label></div>${table("quiet", CC_ROWS.quiet)}`,
      `Add simulcast remotes one at a time and read the noise floor at the demark. Adjust the attenuation until the floor starts to rise, then back off. Viavi says some rise should remain; the carrier's number decides, so ask for it.`)}
    ${one("F", "poi", "POI attenuation and balance", table("poi", CC_ROWS.poi), `Each source at the POI tray: composite and RS power at the demark, the POI attenuation set for the design level into the head-end. On a shared amplifier the ${ccSrc(CC_MCF, "MCF Design Guidelines 2025 (5.5.4)")} recommend equal power per MHz for each operator. LTE's RS power sits 30.8 dB under the composite at 20 MHz and 27.8 dB at 10 MHz.`)}
    ${one("G", "alarms", "Alarms", `<div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">${yn("alarms.clear","No RAN or DAS alarms")}${yn("alarms.forced","Forced alarm reached its monitor")}<label class="grow">Note<input data-k="alarms.note" value="${esc(cur.alarms?.note||"")}"></label></div>`,
      `Confirm no alarms on the RAN or the DAS, then force one and see it arrive where it's monitored.`)}
    ${one("H", "calls", "Calls near every antenna", table("calls", CC_ROWS.calls), `Voice and data calls near every antenna, with the phone's transmit power and RSRP where the phone shows them. One owner's RFP sets a bar where carriers publish none, so treat it as a guide: voice holds ${N.hold_s/60} minutes without a drop; phones at maximum power at no more than ${N.max_share*100}% of points; calls in failover at ${N.failover_share*100}% of locations or more (${ccSrc(CC_PVD, "Providence Water RFP PVD26-53, 3.10")}). Viavi: calls near every remote, on every band. High phone power with good RSRP means the uplink is short.`)}`;
    wire(); refresh(); };
  const refresh=()=>{ if(!el.isConnected) return; const N=ccNum(cur), T=ccTests({commission_cell:cur}), G={dl:ccDl(cur,N), ul:ccUl(cur,N)};
    el.querySelectorAll("tr[data-cstep]").forEach(tr=>{ const s=tr.dataset.cstep, i=+tr.dataset.i, r=(cur[s]?.rows||[])[i], cell=tr.querySelector("[data-res]"); if(!cell||!r) return; let t="";
      if(s==="dl"||s==="ul"){ const x=(G[s]?.rows||[]).find(z=>z.r===r); t=x?`<span style="color:${x.done?(x.ok?"var(--good)":"var(--bad)"):"inherit"}">${esc(x.why)}</span>`:""; }
      else if(s==="quiet"){ const b=ccN(r.before), a=ccN(r.after); t=b!=null&&a!=null?`rise ${ccR1(a-b)} dB`:""; }
      else if(s==="poi"){ const c=ccN(r.composite), bw=ccN(r.bw_mhz); t=c!=null&&bw?`${ccR1(c-10*Math.log10(bw))} dBm/MHz; RS expected ${ccR1(c-ccRsOffset(bw))} dBm`:""; }
      else if(s==="calls"){ const tx=ccN(r.ue_tx); t=[r.result==="ok"?'<span style="color:var(--good)">ok</span>':r.result?`<span style="color:var(--bad)">${esc(r.result)}</span>`:"",
        (r.kind==="voice"||r.kind==="volte"||!r.kind)&&ccN(r.hold_s)!=null&&+r.hold_s<N.hold_s?`<span style="color:var(--bad)">held under ${N.hold_s} s</span>`:"",
        tx!=null&&tx>=N.pmax_dbm-N.pmax_near_db?'<span style="color:var(--warn)">phone at maximum power</span>':""].filter(Boolean).join(" · "); }
      else if(s==="noise"){ t=ccN(r.dbm)!=null?"kept":""; }
      cell.innerHTML=t; });
    for(const [id] of CC_IDS){ const t=T[id], ch=el.querySelector(`[data-cchip="${id}"]`), nt=el.querySelector(`[data-cnote="${id}"]`);
      if(ch) ch.innerHTML=ccChip(t?.status); if(nt) nt.textContent=t?[t.value!=null&&t.value!==""?`${t.value} ${t.unit||""}`.trim():"", t.note||""].filter(Boolean).join(" · "):""; }
    const sum=el.querySelector("#ccSum"); if(sum) sum.innerHTML=CC_IDS.map(([id,l])=>`<span class="cm-s">${ccChip(T[id]?.status)} ${esc(l)}</span>`).join(""); };
  const set=(path, v)=>{ const [a,b]=path.split("."); cur[a]={...(cur[a]||{}), [b]:v}; };
  const wire=()=>{
    el.querySelectorAll("[data-k]").forEach(i=>i.onchange=()=>{ set(i.dataset.k, i.type==="number"?(i.value===""?null:+i.value):i.value); keep(); });
    el.querySelectorAll("[data-lim]").forEach(i=>i.onchange=()=>{ const L={...(cur.limits||{})}; if(i.value==="") delete L[i.dataset.lim]; else L[i.dataset.lim]=+i.value; cur.limits=L; keep().then(draw); });
    el.querySelectorAll("tr[data-cstep] [data-f]").forEach(i=>i.onchange=()=>{ const tr=i.closest("tr"), s=tr.dataset.cstep, r=cur[s].rows[+tr.dataset.i];
      r[i.dataset.f]=i.type==="number"?(i.value===""?null:+i.value):i.value; keep(); });
    el.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{ const s=b.dataset.add; cur[s]={...(cur[s]||{}), rows:[...((cur[s]||{}).rows||[]), s==="calls"?{t:ccNow(), kind:"voice"}:{}]}; draw(); });
    el.querySelectorAll("tr[data-cstep] [data-rm]").forEach(b=>b.onclick=()=>{ const tr=b.closest("tr"), s=tr.dataset.cstep; cur[s].rows.splice(+tr.dataset.i,1); draw(); keep(); });
    el.querySelector("#ccPrint").onclick=()=>{ const box=document.createElement("div"); box.className="panel"; box.innerHTML=ccRecord({...d(), commission_cell:cur}, j.name); dasPrintCopy(box); }; };
  draw();
};
const CCX = {busy: 0};  // saves on their way, for the UI sweep
// the printed record: each step's result and every row as typed
function ccRecord(d, name){ const C=d.commission_cell||{}, O=ccOverall(d), T=O.tests;
  const rows=(step, cols)=>{ const R=(C[step]||{}).rows||[]; return R.length?`<table><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${R.map(r=>`<tr>${cols.map(([k])=>`<td>${esc(r[k]??"")}</td>`).join("")}</tr>`).join("")}</tbody></table>`:""; };
  return `<h2>Cellular commissioning: ${esc(name||"")}</h2><p>${O.done} of ${O.of} steps pass. Procedure: Viavi's public steps with the MCF Design Guidelines 2025 (Australia) and Providence Water RFP PVD26-53 3.10; the carrier's own numbers win where given.</p>
    ${CC_IDS.map(([id,l])=>{ const t=T[id]; return `<h3>${esc(l)}: ${t?esc(t.status):"nothing entered"}</h3>${t?`<p>${esc([t.value!=null&&t.value!==""?`${t.value} ${t.unit||""}`.trim():"", t.note||""].filter(Boolean).join(" · "))}</p>`:""}${CC_ROWS[id]?rows(id, CC_ROWS[id]):""}`; }).join("")}`; }
window.ccTests = ccTests; window.ccOverall = ccOverall;
