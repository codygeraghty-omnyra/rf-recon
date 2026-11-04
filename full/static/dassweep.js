"use strict";
/* RF Recon — sweeps (job › PIM / sweeps, and the Report): return loss, VSWR, distance to fault and insertion loss from any
   cable and antenna analyzer's export (das.py read_sweep: Anritsu Site Master and Line Sweep Tools CSV / text, Keysight
   FieldFox CSV, Touchstone .s1p / .s2p, a plain two-column table). Each trace is plotted, graded against a limit that
   carries its source (a common practice is said to be one, not a code rule), filed with the job (the export in Files, the
   trace in data.sweeps) and listed on the Report beside the PIM runs. NFPA 1225 (2022) chapter 18 asks for no PIM test and
   no sweep: AHJs and owners ask for sweeps (Salt Lake City's ERCES policy: cable sweeps).
   data.sweeps = {runs: [{id, where, kind: "rl"|"vswr"|"dtf"|"il", file, instrument, date, x_unit, x, y, f_lo, f_hi,
     limit: {preset, rl}, il: {cable, length_ft, connectors, tol_db, max_db}, ignore_past_ft, at, by}]} */

const SW_NFPA = "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download";
const SW_SLC = "https://fire.slc.gov/wp-content/uploads/2025/03/Salt-Lake-City-ERCES-Policy-March-2025.pdf";
const SW_CU = "https://www.cuanschutz.edu/docs/librariesprovider260/design-and-construction/guidelines-and-standards/division-27/275319---distributed-antenna-system.pdf?sfvrsn=284fb9b9_2";
// return-loss limits; kind says whether a code, an owner or common practice sets it
const SW_LIMITS = {
  common: {rl: 14, name: "VSWR 1.5:1 (14 dB return loss)", kind: "common practice",
    src: "The VSWR 1.5:1 rating on public-safety coax (e.g. the 2-hour rated coax in the parts research): common practice, not a code rule."},
  owner_cu: {rl: 20, name: "Return loss over 20 dB at any connector (CU Denver 27 53 19)", kind: "owner spec", url: SW_CU,
    src: "CU Denver Division 27 53 19 (an owner's DAS standard): return loss over 20 dB at any connector."},
  antenna: {rl: 9.5, name: "VSWR 2:1 (9.5 dB) looking into an antenna", kind: "common practice",
    src: "An antenna's own VSWR 2:1 datasheet rating (the parts research's public-safety panels): common practice, not a code rule."},
  custom: {rl: null, name: "My own number", kind: "yours", src: "Typed by the tester."},
};
const SW_KINDS = {rl: "Return loss", vswr: "VSWR", dtf: "Distance to fault", il: "Insertion loss"};
const SW_CONNECTOR_DB = 0.1;  // per mated interface (link budget research: Campbell Scientific)
const SW_MAX = 1200;          // points kept per trace in the job

/* ---------- the numbers ---------- */
const swRl = v => v>1 ? -20*Math.log10((v-1)/(v+1)) : 99;           // VSWR -> return loss dB
const swVswr = rl => { const g=10**(-rl/20); return g<1 ? (1+g)/(1-g) : 99; };  // return loss dB -> VSWR
const sw1 = x => Math.round(x*10)/10, sw2 = x => Math.round(x*100)/100;
// a cable's datasheet loss at f MHz, dB per 100 ft: between two datasheet points in a straight line; past the last one
// scaled by √f (conductor loss), and the note says so
function swCableLoss(cable, f){ const L=Object.entries((cable||{}).loss_db_100ft||{}).map(([k,v])=>[+k, v]).filter(([k,v])=>isFinite(k)&&v!=null&&isFinite(+v)).sort((a,b)=>a[0]-b[0]);
  if(!L.length||!isFinite(f)) return null;
  if(f<=L[0][0]) return {db:L[0][1]*Math.sqrt(f/L[0][0]), scaled:f<L[0][0]};
  for(let i=1;i<L.length;i++) if(f<=L[i][0]){ const [f0,a]=L[i-1], [f1,b]=L[i]; return {db:a+(b-a)*(f-f0)/(f1-f0), scaled:false}; }
  const [fl,l]=L[L.length-1]; return {db:l*Math.sqrt(f/fl), scaled:true}; }
// a trace kept small: in each of SW_MAX buckets the worst point (lowest return loss, highest VSWR or loss), so grading the
// kept trace gives what grading the whole one gives
function swThin(x, y, kind){ const n=x.length; if(n<=SW_MAX) return {x:[...x], y:[...y]};
  const worse=(a,b)=>kind==="rl"||kind==="dtf"?a<b:a>b, ox=[], oy=[];
  for(let b=0;b<SW_MAX;b++){ const i0=Math.floor(b*n/SW_MAX), i1=Math.floor((b+1)*n/SW_MAX); let k=i0;
    for(let i=i0;i<i1;i++) if(y[i]!=null&&(y[k]==null||worse(y[i],y[k]))) k=i; ox.push(x[k]); oy.push(y[k]); }
  return {x:ox, y:oy}; }
// one run graded: {status, value, unit, at (x of the worst point), limit, limitTxt, src, note}
function swGrade(run, cables){ const xs=run.x||[], ys=run.y||[], k=run.kind, fq=k!=="dtf";
  const inBand=i=>xs[i]!=null&&ys[i]!=null&&(!fq||((run.f_lo==null||xs[i]>=run.f_lo)&&(run.f_hi==null||xs[i]<=run.f_hi)))&&(fq||run.ignore_past_ft==null||xs[i]<=run.ignore_past_ft);
  const idx=xs.map((_,i)=>i).filter(inBand); if(!idx.length) return {status:"not done", note:"no points in the band set"};
  const unit=run.x_unit||(fq?"MHz":"ft"), at=i=>`${fq?num(xs[i],xs[i]>=1000?0:2):num(xs[i],1)} ${unit}`;
  if(k==="il"){ const I=run.il||{}, w=idx.reduce((a,i)=>ys[i]>ys[a]?i:a), meas=ys[w], fTop=Math.max(...idx.map(i=>xs[i]));
    let lim=null, txt, src;
    if(I.max_db!=null&&I.max_db!==""){ lim=+I.max_db; txt=`≤ ${lim} dB (your number)`; src="Typed by the tester."; }
    else { const c=(cables||[]).find(x=>x.name===I.cable), per=c?swCableLoss(c, fTop):null;
      if(!per||!(+I.length_ft>0)) return {status:"not done", value:sw2(meas), unit:"dB", at:at(w), note:"pick the cable and its length, or type a maximum loss"};
      const cab=per.db*(+I.length_ft)/100, con=(+I.connectors||0)*SW_CONNECTOR_DB, tol=+(I.tol_db??0.5)||0; lim=cab+con+tol;
      txt=`≤ ${sw2(lim)} dB: ${c.name} ${sw2(per.db)} dB/100 ft at ${num(fTop,0)} MHz${per.scaled?" (scaled by √f past the datasheet)":""} × ${I.length_ft} ft = ${sw2(cab)} dB, + ${I.connectors||0} connectors × ${SW_CONNECTOR_DB} dB, + ${tol} dB tolerance`;
      src=`The cable's datasheet loss (parts research); ${SW_CONNECTOR_DB} dB a connector (link budget research, Campbell Scientific); the tolerance is the tester's.`; }
    return {status:meas<=lim?"pass":"fail", value:sw2(meas), unit:"dB", at:at(w), limit:lim, limitTxt:txt, src, note:`highest loss ${sw2(meas)} dB at ${at(w)}`}; }
  const rl=i=>k==="vswr"?swRl(ys[i]):ys[i], w=idx.reduce((a,i)=>rl(i)<rl(a)?i:a), worst=rl(w);
  const L=SW_LIMITS[(run.limit||{}).preset]||SW_LIMITS.common, lim=(run.limit||{}).preset==="custom"?swNum((run.limit||{}).rl):L.rl;
  if(lim==null) return {status:"not done", value:sw1(worst), unit:"dB", at:at(w), note:"type the limit"};
  const vs=k==="vswr"?`VSWR ${sw2(ys[w])}`:`VSWR ${sw2(swVswr(worst))}`;
  return {status:worst>=lim?"pass":"fail", value:sw1(worst), unit:"dB return loss", at:at(w), limit:lim,
    limitTxt:`return loss ≥ ${lim} dB (VSWR ≤ ${sw2(swVswr(lim))}:1): ${L.name}`, src:L.src, kind:L.kind, url:L.url,
    note:`worst ${sw1(worst)} dB (${vs}) at ${at(w)}${k==="dtf"?": look at what's at that distance":""}`}; }
const swNum = v => v===""||v==null||!isFinite(+v) ? null : +v;

/* ---------- the plot: an SVG, return loss and loss with 0 at the top as the analyzers draw them ---------- */
function swPlot(run, g, small){ const xs=run.x||[], ys=run.y||[], W=640, H=small?150:220, L=44, R=10, T=10, B=28;
  const pts=xs.map((x,i)=>[x, ys[i]]).filter(([x,y])=>x!=null&&y!=null); if(pts.length<2) return "";
  const vsw=run.kind==="vswr", x0=Math.min(...pts.map(p=>p[0])), x1=Math.max(...pts.map(p=>p[0]));
  let y0=vsw?1:0, y1=Math.max(...pts.map(p=>p[1]), g&&g.limit!=null?(vsw?swVswr(g.limit):g.limit):0);
  y1=vsw?Math.max(1.5, Math.ceil(y1*10)/10):Math.max(5, Math.ceil(y1/5)*5);
  const sx=x=>L+(x-x0)/((x1-x0)||1)*(W-L-R), sy=y=>vsw?H-B-(y-y0)/((y1-y0)||1)*(H-T-B):T+(y-y0)/((y1-y0)||1)*(H-T-B);
  const ticks=n=>Array.from({length:n+1},(_,i)=>y0+(y1-y0)*i/n);
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(SW_KINDS[run.kind]||"Sweep")} trace" style="display:block;max-width:760px;background:#fff;border:1px solid #ccc;border-radius:6px">`;
  if(run.kind!=="dtf"&&(run.f_lo!=null||run.f_hi!=null)){ const a=sx(Math.max(x0,run.f_lo??x0)), b=sx(Math.min(x1,run.f_hi??x1)); s+=`<rect x="${a}" y="${T}" width="${Math.max(0,b-a)}" height="${H-T-B}" fill="#1f6feb" fill-opacity=".07"/>`; }
  for(const t of ticks(4)) s+=`<line x1="${L}" x2="${W-R}" y1="${sy(t)}" y2="${sy(t)}" stroke="#000" stroke-opacity=".08"/><text x="${L-4}" y="${sy(t)+4}" font-size="11" text-anchor="end" fill="#555">${num(t, vsw?2:0)}</text>`;
  for(let i=0;i<=4;i++){ const x=x0+(x1-x0)*i/4; s+=`<text x="${sx(x)}" y="${H-B+16}" font-size="11" text-anchor="${i===0?"start":i===4?"end":"middle"}" fill="#555">${num(x, run.kind==="dtf"||x1-x0<20?1:0)}</text>`; }
  s+=`<text x="${W-R}" y="${H-3}" font-size="11" text-anchor="end" fill="#555">${esc(run.x_unit||"")}</text><text x="4" y="${T+8}" font-size="11" fill="#555">${vsw?"VSWR":"dB"}</text>`;
  if(g&&g.limit!=null){ const ly=sy(vsw?swVswr(g.limit):g.limit); s+=`<line x1="${L}" x2="${W-R}" y1="${ly}" y2="${ly}" stroke="#cf222e" stroke-width="1.5" stroke-dasharray="6 4"/>`; }
  s+=`<polyline fill="none" stroke="#1f6feb" stroke-width="1.6" points="${pts.map(([x,y])=>`${sx(x).toFixed(1)},${sy(Math.min(y,y1)).toFixed(1)}`).join(" ")}"/>`;
  if(g&&g.value!=null&&g.at){ const xv=parseFloat(g.at), yv=vsw?swVswr(g.value):g.value; if(isFinite(xv)) s+=`<circle cx="${sx(xv)}" cy="${sy(Math.min(yv,y1))}" r="4.5" fill="${g.status==="pass"?"#1a7f37":"#cf222e"}" stroke="#fff" stroke-width="1.5"/>`; }
  return s+"</svg>"; }
const swChip = s => s==="pass"?'<span class="tag v">Pass</span>':s==="fail"?'<span class="tag w">Fail</span>':'<span class="tag">Not done</span>';
const swTitle = r => `${r.where||"Sweep"} · ${SW_KINDS[r.kind]||r.kind}`;

/* ---------- the job's PIM / sweeps tab ---------- */
window.dasSweep = async (el, j0, save) => {
  let j=j0, pending=null;
  const parts=window.frLoad?await frLoad("parts").catch(()=>({cables:[]})):{cables:[]}, cables=(parts.cables||[]).filter(c=>c.loss_db_100ft);
  if(!el.isConnected) return;
  const runs=()=>(((j.data||{}).sweeps||{}).runs)||[];
  const keep=async list=>{ j=await save({sweeps:{...((j.data||{}).sweeps||{}), runs:list}})||j; draw(); };
  const limitSel=(r, id)=>r.kind==="il"?`<label>Cable <select data-sw="cable" ${id}><option value="">— your maximum —</option>${cables.map(c=>`<option ${(r.il||{}).cable===c.name?"selected":""}>${esc(c.name)}</option>`).join("")}</select></label>
      <label>Length ft<input data-sw="length_ft" ${id} type="number" step="any" value="${esc((r.il||{}).length_ft??"")}" style="width:80px"></label>
      <label>Connectors<input data-sw="connectors" ${id} type="number" min="0" value="${esc((r.il||{}).connectors??2)}" style="width:64px"></label>
      <label>Tolerance dB<input data-sw="tol_db" ${id} type="number" step="any" value="${esc((r.il||{}).tol_db??0.5)}" style="width:64px"></label>
      <label>or max loss dB<input data-sw="max_db" ${id} type="number" step="any" value="${esc((r.il||{}).max_db??"")}" style="width:72px"></label>`
    :`<label>Limit <select data-sw="preset" ${id}>${Object.entries(SW_LIMITS).map(([k,L])=>`<option value="${k}" ${((r.limit||{}).preset||"common")===k?"selected":""}>${esc(L.name)}</option>`).join("")}</select></label>
      ${(r.limit||{}).preset==="custom"?`<label>Return loss ≥ dB<input data-sw="rl" ${id} type="number" step="any" value="${esc((r.limit||{}).rl??"")}" style="width:70px"></label>`:""}
      ${r.kind==="dtf"?`<label title="The antenna or load at the far end shows as a reflection: leave it out">Ignore past ft<input data-sw="ignore_past_ft" ${id} type="number" step="any" value="${esc(r.ignore_past_ft??"")}" style="width:72px"></label>`
        :`<label>Band MHz<input data-sw="f_lo" ${id} type="number" step="any" value="${esc(r.f_lo??"")}" placeholder="from" style="width:72px"></label><label>to<input data-sw="f_hi" ${id} type="number" step="any" value="${esc(r.f_hi??"")}" placeholder="to" style="width:72px"></label>`}`;
  const setField=(r, k, v)=>{ const n=v===""?null:+v;
    if(["cable","length_ft","connectors","tol_db","max_db"].includes(k)) r.il={...(r.il||{}), [k]:k==="cable"?v:n};
    else if(k==="preset") r.limit={...(r.limit||{}), preset:v}; else if(k==="rl") r.limit={...(r.limit||{}), rl:n};
    else r[k]=k==="where"?v:k==="kind"?v:n; };
  function draw(){ if(!el.isConnected) return; const L=runs();
    el.innerHTML=`<div class="panel"><h3>Sweeps <span class="hint">· return loss, VSWR, distance to fault, insertion loss, from any cable and antenna analyzer</span></h3>
      <p class="hint" style="margin:0 0 8px"><a href="${SW_NFPA}" target="_blank" rel="noopener">NFPA 1225 (2022) chapter 18</a> asks for no PIM test and no sweep. AHJs and owners ask for sweeps (<a href="${SW_SLC}" target="_blank" rel="noopener">Salt Lake City's ERCES policy</a>: cable sweeps); PIM is a carrier or owner requirement. Reads Anritsu Site Master and Line Sweep Tools CSV or text, Keysight FieldFox CSV, Touchstone .s1p / .s2p (NanoVNA, RigExpert) and any two-column table. The export goes in the job's Files.</p>
      <label class="cm-up">⇪ Import a sweep<input type="file" id="swImp" accept=".csv,.txt,.dat,.s1p,.s2p,.xlsx,.tsv" hidden></label> <span id="swSay" class="hint" role="status"></span>
      <div id="swNew"></div>
      ${L.length?L.map((r,i)=>{ const g=swGrade(r, cables); return `<div class="sw-run" data-run="${i}" style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px">
        <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px"><b>${esc(swTitle(r))}</b><span>${swChip(g.status)} <button class="sm" data-swrm="${i}" aria-label="Remove this sweep">✕</button></span></div>
        <p class="hint" style="margin:2px 0 6px">${esc([r.instrument, r.date, r.file].filter(Boolean).join(" · "))}</p>
        ${swPlot(r, g)}
        <p style="margin:6px 0 2px">${esc(g.note||"")}${g.limitTxt?` · ${esc(g.limitTxt)}`:""}</p>${g.src?`<p class="hint" style="margin:0 0 4px">${g.url?`<a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.src)}</a>`:esc(g.src)}</p>`:""}
        <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">${limitSel(r, `data-i="${i}"`)}</div></div>`; }).join("")
        :'<p class="hint" style="margin:8px 0 0">No sweeps yet.</p>'}</div>`;
    $("#swImp").onchange=async e=>{ const f=e.target.files[0]; e.target.value=""; if(!f) return; say(`Reading ${f.name}…`);
      try{ const buf=await f.arrayBuffer(), t=await api(`/api/das/sweep?name=${encodeURIComponent(f.name)}`, {method:"POST", body:buf}); pending={t, f, buf, si:0}; say(""); newForm(); }
      catch(x){ say(`${f.name}: ${x.message}`); } };
    el.querySelectorAll("[data-swrm]").forEach(b=>b.onclick=()=>{ const r=runs()[+b.dataset.swrm]; if(!confirm(`Remove “${swTitle(r)}”? Its export stays in Files.`)) return; keep(runs().filter((_,i)=>i!==+b.dataset.swrm)); });
    el.querySelectorAll(".sw-run [data-sw]").forEach(inp=>inp.onchange=()=>{ const L2=runs().map(r=>({...r})), r=L2[+inp.dataset.i]; setField(r, inp.dataset.sw, inp.value); keep(L2); });
    if(pending) newForm(); }
  // a file just read: what it is, where, against what; preview; then add
  function newForm(){ const box=el.querySelector("#swNew"); if(!box||!pending) return; const {t, f}=pending, s=t.series[pending.si]||t.series[0];
    const kind=pending.kind||(t.x_kind==="dist"?"dtf":s.kind||"rl");
    const draft={kind, where:pending.where||"", x_unit:t.x_unit, x:t.x, y:s.y, limit:pending.limit||{preset:kind==="il"?undefined:"common"}, il:pending.il||{connectors:2, tol_db:0.5}, f_lo:pending.f_lo??null, f_hi:pending.f_hi??null, ignore_past_ft:pending.ignore_past_ft??null};
    const g=swGrade(draft, cables);
    box.innerHTML=`<div class="panel" style="margin-top:8px"><b>${esc(f.name)}</b> <span class="hint">· ${esc({anritsu:"Anritsu export", fieldfox:"Keysight FieldFox export", touchstone:"Touchstone file", rigexpert:"RigExpert export", nanovna:"NanoVNA export", table:"a table"}[t.format]||t.format)}, ${t.points} points${t.instrument?`, ${esc(t.instrument)}`:""}${t.measurement?`, ${esc(t.measurement)}`:""}</span>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:6px">
        <label class="grow">Where<input data-sw="where" value="${esc(draft.where)}" placeholder="riser 2 to floor 5 branch, donor line…" style="min-width:200px"></label>
        ${t.series.length>1?`<label>Trace<select id="swSer">${t.series.map((x,i)=>`<option value="${i}" ${i===pending.si?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>`:""}
        <label>Measurement<select data-sw="kind">${Object.entries(SW_KINDS).filter(([k])=>t.x_kind==="dist"?k==="dtf":k!=="dtf").map(([k,l])=>`<option value="${k}" ${k===kind?"selected":""}>${l}</option>`).join("")}</select></label></div>
      ${!s.kind&&t.x_kind!=="dist"?'<p class="hint" style="margin:6px 0 0">The file doesn\'t say what it measured: pick it.</p>':""}
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:6px">${limitSel(draft, "")}</div>
      <div style="margin-top:8px">${swPlot(draft, g)}</div><p style="margin:6px 0">${swChip(g.status)} ${esc(g.note||"")}${g.limitTxt?` · ${esc(g.limitTxt)}`:""}</p>
      <div class="row" style="gap:8px"><button class="primary" id="swAdd">Add the sweep</button><button id="swNo">Cancel</button></div></div>`;
    box.querySelectorAll("[data-sw]").forEach(inp=>inp.onchange=()=>{ const k=inp.dataset.sw;
      if(k==="where"){ pending.where=inp.value; return; } if(k==="kind") pending.kind=inp.value;
      else { const r={limit:pending.limit||{preset:"common"}, il:pending.il||{connectors:2, tol_db:0.5}}; setField(r, k, inp.value); pending.limit=r.limit; pending.il=r.il; if(k in r&&!["limit","il"].includes(k)) pending[k]=r[k]; }
      setTimeout(newForm, 0); });  // drawn after the event: redrawn inside it, the field being left was pulled out from under the browser
    box.querySelector("#swSer")?.addEventListener("change", e=>{ pending.si=+e.target.value; pending.kind=null; newForm(); });
    box.querySelector("#swNo").onclick=()=>{ pending=null; box.innerHTML=""; };
    box.querySelector("#swAdd").onclick=async()=>{ const P=pending; if(!P) return; const bt=box.querySelector("#swAdd"); bt.disabled=true;
      try{ await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(P.f.name)}`, {method:"POST", body:P.buf}); }
      catch(x){ say(`The export wasn't saved to Files: ${x.message}`); bt.disabled=false; return; }
      const th=swThin(draft.x, draft.y, draft.kind==="dtf"?"rl":draft.kind);
      const run={...draft, ...th, id:Date.now(), where:P.where||P.f.name.replace(/\.[^.]+$/,""), file:P.f.name, instrument:t.instrument||"", date:t.date||"", series:s.name,
        at:new Date().toISOString().slice(0,16), by:(S.me&&S.me.user)||(((j.data||{}).testing||{}).tester)||""};
      if(run.kind==="il") delete run.limit; else delete run.il;
      pending=null; await keep([...runs(), run]); say(`Added ${swTitle(run)}. ${P.f.name} is in the job's Files.`); }; }
  const say=t=>{ const x=el.querySelector("#swSay"); if(x) x.textContent=t; };
  draw();
};

/* ---------- the Report: PIM and sweeps ---------- */
window.dasSweepReport = async (box, j) => { if(!box) return; const d=j.data||{}, L=((d.sweeps||{}).runs)||[], pim=d.pim||{}, P=Array.isArray(pim.runs)?pim.runs:[];
  if(!L.length&&!P.length){ box.innerHTML=""; return; }
  const parts=L.some(r=>r.kind==="il")&&window.frLoad?await frLoad("parts").catch(()=>({cables:[]})):{cables:[]};
  if(!box.isConnected) return;
  const lim=pim.limit_dbc??-140, pp=x=>x.result_dbm!==""&&x.result_dbm!=null&&x.tone_dbm!==""?((+x.result_dbm)-(+x.tone_dbm))<=(+lim):null;
  const G=L.map(r=>swGrade(r, parts.cables||[]));
  box.innerHTML=`<div style="break-before:page;margin-top:16px"><h3>PIM and sweeps</h3>
    <p class="hint">${typeof dasCellOnly==="function"&&dasCellOnly(d)?"Run because the owner or a carrier asked for them.":`NFPA 1225 (2022) chapter 18 asks for no PIM test and no sweep (${SW_NFPA}); these were run because the AHJ, the owner or a carrier asked for them.`}</p>
    ${L.length?`<table><thead><tr><th>Sweep</th><th>Measurement</th><th>Instrument</th><th class="n">Worst</th><th>Where on the trace</th><th>Limit and source</th><th>Result</th></tr></thead><tbody>
      ${L.map((r,i)=>{ const g=G[i]; return `<tr><td>${esc(r.where||"")}</td><td>${esc(SW_KINDS[r.kind]||r.kind)}</td><td>${esc([r.instrument, r.date].filter(Boolean).join(" · "))}</td><td class="n">${g.value!=null?`${g.value} ${esc(r.kind==="il"?"dB":"dB RL")}`:""}</td><td>${esc(g.at||"")}</td><td>${esc(g.limitTxt||g.note||"")}${g.src?` <span class="hint">(${esc(g.src)})</span>`:""}</td><td>${esc(g.status)}</td></tr>`; }).join("")}</tbody></table>
      <div class="sw-figs">${L.map((r,i)=>`<figure style="margin:8px 0;break-inside:avoid">${swPlot(r, G[i], true)}<figcaption class="hint">${esc(swTitle(r))} · ${esc(G[i].note||"")} · export: ${esc(r.file||"")}</figcaption></figure>`).join("")}</div>`:""}
    ${P.length?`<h3>PIM runs</h3><table><thead><tr><th>Where</th><th>Band</th><th class="n">F1</th><th class="n">F2</th><th class="n">Tone dBm</th><th>Order</th><th class="n">PIM dBm</th><th class="n">dBc</th><th>Result (≤ ${lim} dBc)</th></tr></thead><tbody>
      ${P.map(x=>{ const p=pp(x); return `<tr><td>${esc(x.where||"")}</td><td>${esc(x.band||"")}</td><td class="n">${esc(x.f1??"")}</td><td class="n">${esc(x.f2??"")}</td><td class="n">${esc(x.tone_dbm??"")}</td><td>IM${esc(x.order||3)}</td><td class="n">${esc(x.result_dbm??"")}</td><td class="n">${x.result_dbm!==""&&x.result_dbm!=null?((+x.result_dbm)-(+x.tone_dbm)).toFixed(1):""}</td><td>${p==null?"":p?"pass":"fail"}</td></tr>`; }).join("")}</tbody></table>
      <p class="hint">PIM limit ${lim} dBc: the job's own (PIM tab); −140 dBc at 2 × 43 dBm is the common system-level pass in the PIM research, not a code rule.</p>`:""}</div>`; };
