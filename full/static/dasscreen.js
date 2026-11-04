"use strict";
/* RF Recon — DAS Screening: each public safety reading in the Grid test judged with its instrument's published accuracy,
   as likely pass, too close to call or likely fail. It changes nothing in the Grid test's score or the Report. It answers
   two questions: which squares a pre-test walk says to fix, and which passing squares sit inside the instrument's accuracy
   and could flip on the AHJ's witnessed walk. Only market instruments approved for DAS work are listed (Cody, 11/2); the
   SDR version is a preview outside RF Recon (its own folder on the PC, screening-SDR-version-2026-11-02).
   Needs das.js (has, gridPass, calOf, readingsOf, isCell, instKey, instName, boxCss, jobFileSrc, daqEq, csvOf, dasDl). */

// published accuracy in dB. lvl: level (RSSI, received power), both directions. sinr: null when the instrument doesn't
// measure SINR or its maker doesn't publish an accuracy for it; BER and DAQ are then judged as measured.
const SCREEN_RX = [
  {id:"ibflex", re:/ibflex|seehawk|seegull/i, name:"PCTEL IBflex + SeeHawk", lvl:1, sinr:1,
   src:"PCTEL: RSSI ±1 dB (−118 to −10 dBm); P25 SINR ±1 dB (8 to 25 dB)."},
  {id:"s412e", re:/s412e|lmr master/i, name:"Anritsu S412E LMR Master", lvl:1.25, sinr:null,
   src:"Anritsu data sheet: P25 received power ±1.25 dB (±0.5 dB typical), 15 to 35 °C. Measures BER, not SINR."},
  {id:"prism", re:/prism|ibwave/i, name:"Epiq PRiSM + iBwave Mobile Survey", lvl:2, sinr:null,
   src:"Epiq: ±2 dB at 25 °C. No SINR accuracy published, so its SINR and BER are judged as measured."},
  {id:"compass", re:/compass/i, name:"Nextivity COMPASS XR", lvl:2, sinr:null,
   src:"Nextivity: ±2 dB; its calibration certificate covers LMR 700/800 only. Level only."}];
const SCREEN_WORD = {pass:"Likely pass", close:"Too close to call", fail:"Likely fail"};
const SCREEN_RANK = {pass:0, close:1, fail:2};

// TSB-88.1 C4FM, faded: SINR (dB) against BER (%), to carry a SINR accuracy over to a BER reading
const TSB88 = [[7.6,5],[16.5,2.6],[17.7,2.0],[21.2,1.0],[26,0.3],[32,0.05]];
const sinrToBer = s => { const P=TSB88; if(s<=P[0][0]) return P[0][1]; for(let i=1;i<P.length;i++) if(s<=P[i][0]){ const [a,x]=P[i-1],[b,y]=P[i]; return x+(y-x)*(s-a)/(b-a); } return P[P.length-1][1]; };
const berToSinr = e => { const P=TSB88; if(e>=P[0][1]) return P[0][0]; for(let i=1;i<P.length;i++) if(e>=P[i][1]){ const [a,x]=P[i-1],[b,y]=P[i]; return a+(b-a)*(e-x)/(y-x); } return P[P.length-1][0]; };

// which market instrument a job's instrument is: the job's own pick (Screening), else by its model name
function screenRx(d, key){ if(!key||key==="uncal") return null;
  const pick=((d.screen||{}).rx||{})[key]; if(pick==="none") return null;
  if(pick) return SCREEN_RX.find(x=>x.id===pick)||null;
  const i=((d.testing||{}).instruments||[]).find(x=>instKey(x)===key), model=i?i.model:key.split("|")[0];
  return SCREEN_RX.find(x=>x.re.test(model))||null; }

// one check: a margin (dB, or the measured value) against its limit, with the instrument's accuracy u (0: as measured)
const callOf = (margin, u) => margin-u>=0 ? "pass" : margin+u<0 ? "fail" : "close";
function screenReading(d, r){
  const rx=screenRx(d, r.inst); if(!rx) return {r, rx:null, v:null};
  const out=[], lv=v=>has(v)&&DASJ.threshold!=null;
  if(lv(r.dl)) out.push({k:"DL", m:+r.dl-DASJ.threshold, u:rx.lvl, unit:"dB"});
  if(lv(r.ul)) out.push({k:"UL", m:+r.ul-DASJ.threshold, u:rx.lvl, unit:"dB"});
  if(has(r.daq)) out.push({k:"DAQ", m:+r.daq-DASJ.daq, u:0});
  else {
    if(has(r.sinr)) out.push({k:"SINR", m:+r.sinr-daqEq().sinr, u:rx.sinr||0, unit:"dB"});
    if(has(r.ber)){ const lim=daqEq().ber;
      if(rx.sinr){ const s=berToSinr(+r.ber); out.push({k:"BER", m:s-berToSinr(lim), u:rx.sinr, unit:"dB", ber:true}); }
      else out.push({k:"BER", m:lim-+r.ber, u:0}); } }
  if(has(r.ul_daq)) out.push({k:"UL DAQ", m:+r.ul_daq-DASJ.daq, u:0});
  if(!out.length) return {r, rx, v:null};
  out.forEach(c=>c.v=callOf(c.m, c.u));
  const v=out.reduce((w,c)=>SCREEN_RANK[c.v]>SCREEN_RANK[w]?c.v:w, "pass");
  const db=out.filter(c=>c.unit==="dB"), tight=db.length?db.reduce((a,c)=>c.m-c.u<a.m-a.u?c:a):null;
  return {r, rx, v, checks:out, tight}; }
// a square: the worst call over its public safety readings (cellular ones are the Grid test's carrier view)
function screenSquare(d, res){
  const rs=readingsOf(res).filter(x=>!isCell(x)&&(has(x.dl)||has(x.daq)||has(x.sinr)||has(x.ber)));
  const all=rs.map(x=>screenReading(d,x)), called=all.filter(x=>x.v);
  const v=called.length?called.reduce((w,x)=>SCREEN_RANK[x.v]>SCREEN_RANK[w]?x.v:w, "pass"):null;
  return {v, all, called, uncalled:all.length-called.length}; }

window.dasScreen = async function(el, j, save){
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], res=(d.grid||{}).results||{}, D=S.das;
  if(!floors.length){ el.innerHTML='<p class="status">Set the number of floors on the Overview first.</p>'; return; }
  D.floor=floors.some(f=>f.name===D.floor)?D.floor:floors[0].name;
  const f=floors.find(x=>x.name===D.floor), n=f.grids||DAS.grids, cols=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), rows=Math.ceil(n/cols);
  const skip=new Set(f.skip||[]), crit=new Set(f.critical||[]);
  const planSrc=f.plan?await jobFileSrc(j.id, f.plan):null;
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const sq={}, per=floors.map(fl=>{ const o={f:fl, pass:0, close:0, fail:0, none:0}; for(let g=1; g<=(fl.grids||DAS.grids); g++){ if((fl.skip||[]).includes(g)) continue;
    const s=screenSquare(d, res[`${fl.name}|${g}`]); if(fl.name===f.name) sq[g]=s; s.v?o[s.v]++:o.none++; } return o; });
  const cur=per.find(x=>x.f.name===f.name);
  const insts=(d.testing||{}).instruments||[], seen=new Set(); for(const k of Object.keys(res)) for(const x of readingsOf(res[k])) if(x.inst) seen.add(x.inst);
  const uncal=[...seen].includes("uncal");
  const instRows=insts.map(i=>{ const k=instKey(i), rx=screenRx(d,k), pick=((d.screen||{}).rx||{})[k]||"";
    return `<tr><td>${esc(instName(i))}</td><td><select data-rx="${esc(k)}"><option value="" ${!pick?"selected":""}>By model name${!pick&&rx?`: ${esc(rx.name)}`:!pick?": not a listed instrument":""}</option>
      ${SCREEN_RX.map(x=>`<option value="${x.id}" ${pick===x.id?"selected":""}>${esc(x.name)}</option>`).join("")}<option value="none" ${pick==="none"?"selected":""}>Not one of these: don't screen</option></select></td>
      <td class="hint" style="white-space:normal">${rx?esc(rx.src):"Not judged: no published accuracy on file."}</td></tr>`; }).join("");
  const sel=D.ssq&&sq[D.ssq]?D.ssq:null;
  const fmt=(c)=>{ const v=`${c.m>=0?"+":""}${+c.m.toFixed(c.unit?1:2)}`; return c.ber?`${v} dB eq.`:c.unit?`${v} dB`:v; };  // +14 dB, +0.5 dB, DAQ +0.4
  const detail=()=>{ if(!sel) return `<p class="hint">Click a square to see each channel's call, its margin and the instrument's accuracy.</p>`;
    const s=sq[sel];
    return `<h3>Floor ${esc(f.name)} · square ${sel}${crit.has(sel)?" · critical":""}</h3>
      ${s.v?`<div style="display:flex;gap:10px;align-items:baseline;margin:0 0 8px"><b class="scr-word ${s.v}">${SCREEN_WORD[s.v]}</b><span class="hint">${s.v==="pass"?"Every channel passes even at the bad end of its instrument's accuracy.":s.v==="fail"?"At least one channel fails even at the good end of its instrument's accuracy.":"A channel is inside its instrument's accuracy: the witnessed walk could go either way."}</span></div>`:`<p class="hint">${s.all.length?"No reading here comes from a listed instrument.":"No public safety readings here yet: enter or import them on the Grid test."}</p>`}
      ${s.all.length?`<div class="tw wrap"><table><thead><tr><th>Channel</th><th>Margin over the line (± accuracy)</th><th>Call</th></tr></thead><tbody>
      ${s.all.map(x=>`<tr><td><span class="mono">${esc(x.r.freq??"")}</span><div class="hint">${esc(x.rx?x.rx.name:x.r.inst==="uncal"?"not calibrated":(x.r.inst||"not recorded").replace("|"," "))}</div></td>
        <td class="mono">${x.checks?x.checks.map(c=>`<div><span class="scr-tag ${c.v}" style="min-width:52px;text-align:center">${esc(c.k)}</span> ${fmt(c)}${c.u?` <span class="hint">±${c.u}</span>`:""}</div>`).join(""):'<span class="hint">not judged: no published accuracy for this receiver</span>'}</td>
        <td>${x.v?`<span class="scr-tag ${x.v}">${x.v}</span>`:'<span class="hint">–</span>'}</td></tr>`).join("")}</tbody></table></div>`:""}
      <p class="hint" style="margin:6px 0 0">Margins: level against ${DASJ.threshold} dBm; ${DASJ.daq>=3.4?"DAQ 3.4":"DAQ 3.0"} as DAQ ≥ ${DASJ.daq}, or SINR ≥ ${daqEq().sinr} dB and BER ≤ ${daqEq().ber}%. A BER read by an instrument with a SINR accuracy is turned into SINR on the TSB-88 curve ("dB eq.").</p>
      <button id="scGrid" style="margin-top:8px">Open the Grid test</button>`; };
  const next=[], fails=Object.keys(sq).filter(g=>sq[g].v==="fail"), close=Object.keys(sq).filter(g=>sq[g].v==="close"), uncalled=Object.keys(sq).filter(g=>sq[g].uncalled);
  const critFail=fails.filter(g=>crit.has(+g));
  if(fails.length) next.push(`Fix before the witnessed walk: square${fails.length>1?"s":""} ${fails.map(g=>`${f.name}-${g}`).join(", ")}${critFail.length?` (${critFail.length} critical; critical areas need ${DASJ.critical_pct}%)`:""}.`);
  if(close.length) next.push(`Inside the instrument's accuracy: square${close.length>1?"s":""} ${close.map(g=>`${f.name}-${g}`).join(", ")}. Recheck before the AHJ walks it, or add margin (gain, an antenna).`);
  if(uncalled.length) next.push(`Readings not judged in square${uncalled.length>1?"s":""} ${uncalled.map(g=>`${f.name}-${g}`).join(", ")}: taken with an uncalibrated receiver or an instrument not listed here.`);
  if(!cur.none&&!fails.length&&!close.length) next.push("Every square passes by more than its instrument's accuracy.");
  if(cur.none) next.push(`${cur.none} square${cur.none>1?"s":""} with no judged readings yet.`);
  el.innerHTML=`<div class="panel" style="margin-bottom:10px"><h3>Screening <span class="hint">· each reading judged with its instrument's published accuracy. The Grid test's score and the Report don't change.</span></h3>
      <div class="cards">${per.map(o=>{ const t=o.pass+o.close+o.fail; return `<div class="card" data-fl="${esc(o.f.name)}" style="cursor:pointer;${o.f.name===f.name?"outline:2px solid var(--accent)":""}">
        <div class="v">${t?`${o.pass}<span class="hint" style="font-size:13px"> / ${t}</span>`:"–"}</div><div class="k">Floor ${esc(o.f.name)} · likely pass${o.close?` · ${o.close} too close`:""}${o.fail?` · ${o.fail} likely fail`:""}${o.none?` · ${o.none} not judged`:""}</div></div>`; }).join("")}</div></div>
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(320px,2fr) minmax(300px,1fr)">
      <div class="panel"><h3>Floor ${esc(f.name)} <span class="hint">· click a square</span> <select id="scF" style="margin-left:8px">${floors.map(x=>`<option ${x.name===f.name?"selected":""}>${esc(x.name)}</option>`).join("")}</select></h3>
        <div style="position:relative;width:100%;${planSrc?"":`aspect-ratio:${cols}/${rows};`}border-radius:10px;overflow:hidden;background:#fff">
          ${planSrc?`<img id="scImg" src="${planSrc}" alt="Floor ${esc(f.name)} plan" draggable="false" style="display:block;width:100%;height:auto;opacity:.92">`:""}
          <div id="scCells" style="position:absolute;${boxCss(f, !!planSrc)};display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">
          ${Array.from({length:n},(_,i)=>{ const g=i+1, s=sq[g], sk=skip.has(g), c=crit.has(g), t=s&&s.called.length?s.called.filter(x=>x.tight).reduce((a,x)=>!a||x.tight.m-x.tight.u<a.m-a.u?x.tight:a,null):null;
            return `<button data-g="${g}" class="scr-sq ${sk?"skip":s&&s.v?s.v:""} ${sel===g?"sel":""}" title="Square ${g}${c?" (critical)":""}${sk?" (not tested)":s&&s.v?`: ${SCREEN_WORD[s.v]}`:""}">
              <b>${esc(f.name)}-${g}${c?" ★":""}</b>${sk?'<span class="hint">not tested</span>':t?`<span class="mono">${t.k} ${fmt(t)}</span><span class="hint">±${t.u}</span>`:s&&s.uncalled?'<span class="hint">not judged</span>':""}</button>`; }).join("")}</div></div>
        <div class="scr-legend"><span><i class="pass"></i>Likely pass</span><span><i class="close"></i>Too close to call</span><span><i class="fail"></i>Likely fail</span><span><i></i>No judged readings</span><span>★ critical</span>
          <span class="hint">Striped, so a screening call never reads as a Grid test result.</span></div>
        <ul style="margin:10px 0 0;padding-left:18px">${next.map(t=>`<li>${esc(t)}</li>`).join("")}</ul>
        <div class="row" style="margin-top:10px"><button id="scCsv">⇩ Screening CSV</button></div></div>
      <div><div class="panel" id="scRead">${detail()}</div>
        <div class="panel"><h3>Instruments</h3>
          ${insts.length?`<div class="tw wrap"><table><thead><tr><th>On this job</th><th>Judged as</th><th>Published accuracy</th></tr></thead><tbody>${instRows}</tbody></table></div>`:'<p class="hint">No instruments on this job yet: add them on the Overview (model | serial | calibration date).</p>'}
          <p class="hint" style="margin:6px 0 0">Listed: ${SCREEN_RX.map(x=>esc(x.name)).join(", ")}: the market instruments approved for DAS work.${uncal?" Readings marked not calibrated (an SDR, a phone app) aren't judged here.":""}</p></div></div></div>`;
  el.querySelectorAll("[data-fl]").forEach(c=>c.onclick=()=>{ D.floor=c.dataset.fl; D.ssq=null; render(); });
  $("#scF").onchange=e=>{ D.floor=e.target.value; D.ssq=null; render(); };
  $("#scCells").onclick=e=>{ const b=e.target.closest("[data-g]"); if(!b||skip.has(+b.dataset.g)) return; D.ssq=+b.dataset.g; render(); };
  const og=$("#scGrid"); if(og) og.onclick=()=>{ D.sub="grid"; render(); };
  el.querySelectorAll("[data-rx]").forEach(s=>s.onchange=async()=>{ const rx={...((j.data.screen||{}).rx||{})}; if(s.value) rx[s.dataset.rx]=s.value; else delete rx[s.dataset.rx];
    j=await save({screen:{...(j.data.screen||{}), rx}}); render(); });
  $("#scCsv").onclick=()=>{ const out=[]; for(const fl of floors) for(let g=1; g<=(fl.grids||DAS.grids); g++){ if((fl.skip||[]).includes(g)) continue;
      const s=screenSquare(d, res[`${fl.name}|${g}`]);
      for(const x of s.all) out.push({floor:fl.name, square:g, critical:(fl.critical||[]).includes(g)?"yes":"no", square_call:s.v?SCREEN_WORD[s.v]:"not judged",
        channel:x.r.freq??"", instrument:x.rx?x.rx.name:x.r.inst==="uncal"?"not calibrated":(x.r.inst||""), reading_call:x.v?SCREEN_WORD[x.v]:"not judged",
        checks:x.checks?x.checks.map(c=>`${c.k} ${fmt(c)}${c.u?` ±${c.u}`:""}`).join("; "):"", note:"screening only; the Grid test scores acceptance"}); }
    dasDl(`${fileSafe(j.name)} screening.csv`, csvOf(out), "text/csv"); };
};
