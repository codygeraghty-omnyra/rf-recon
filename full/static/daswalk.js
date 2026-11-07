"use strict";
/* RF Recon — walk test on a floor plan (Grid test › Walk). Cody 11/4: "try to build the COMPASS app from a market competitor,
   try to rebuild the iBflex cell mapping/survey tool". Our own version of what the in-building survey tools do (Nextivity
   COMPASS XR with its phone app, PCTEL's IBflex scanner with SeeHawk Touch, iBwave Mobile Survey): walk the plan and tap
   where you are.
   - Point: a tap is one test spot. Type what the instrument reads, or leave the spot empty for a log: the logged reading
     nearest the tap's time fills it.
   - Continuous: Start walk, then tap your position as you go while an instrument or a phone survey app logs. Each logged
     reading goes on the line between the two taps around its time (time-interpolated).
   Readings come typed, from a COMPASS Full Signal Report, or from a log (G-NetTrack Pro, Network Cell Info, an instrument's
   CSV: any table with a time column), matched to the walk by time. A heat map per metric, channel, carrier and band,
   coloured against the job's requirements. Every change rolls the walk up into the grid squares (grid.results, readings
   marked walk:1), so the grid score (IFC 510.5.4 20 / 40 areas, critical squares) and the Report use them. Only readings
   from a calibrated instrument count; cellular readings never count toward public safety (das.js).
   A web page can't read the phone's own radio, so the signal comes from a log or is typed, except in RF Recon for Android
   (android/, outside this repo): its window.RFRadio gives the phone's own LTE / 5G serving cell (Read the phone; Start
   walk logs it). Phone readings are cellular only and not calibrated: indicative, never counted toward public safety.
   Saved with the job as data.walk = {v:1, floors:[{name, rev, seq, ar, arFor, rule, pts, wps}]}: lists, so the job's log
   doesn't get a line for every tap (das.py save_job logs scalar changes only).
     pts: {id, by:"tap"|"time"|"xy", x, y (tap / xy: fractions of the plan), t (ISO), inst, src, rs:[readings]}
     wps: {id, x, y, t, leg}: the taps of a continuous walk; a "time" point's place comes from them */

/* ---------- the core: no page needed (tests/daswalk_check.mjs runs it in node with das.js and dascell.js) ---------- */
const WK_TOL = 2000;          // a logged reading up to 2 s before a walk's first tap or after its last still goes on it
const WK_MAX = 20000;         // points per floor
const WK_RULES = [["centre","the point nearest its centre (IFC 510.5.4)"],["worst","its worst point"],["median","its middle point (median)"]];
const WK_RULE_SHORT = {centre:"nearest the centre", worst:"the worst", median:"the median"};
const wkNum = v => { if(v==null||v==="") return null; const s=String(v).replace(/[^\d.eE+\-]/g,""); if(!/\d/.test(s)) return null; const n=parseFloat(s); return isFinite(n)?n:null; };
const wkHasVal = r => !!r && (has(r.dl)||has(r.daq)||has(r.sinr)||has(r.rsrp)||has(r.rsrq));

// a log's time -> ms. ISO (with or without a zone), G-NetTrack's 2026.11.04_10.12.33, 11/04/2026 10:12:33 AM, epoch
// seconds or ms, or a time of day alone (on the day of baseMs). A time with no zone is the device's local time.
function wkYmd(y, mo, d, h, mi, s, frac, zone){ const ms=frac?Math.round(+("0."+frac)*1000):0;
  if(!zone) return new Date(y, mo-1, d, h, mi, s, ms).getTime();
  let off=0; if(/^[+-]/.test(zone)){ const z=zone.replace(":",""); off=(z[0]==="-"?-1:1)*(+z.slice(1,3)*60 + +z.slice(3,5)); }
  return Date.UTC(y, mo-1, d, h, mi, s, ms) - off*60000; }
const wk12 = (h, ap) => { if(!ap) return h; const pm=/p/i.test(ap); return h===12?(pm?12:0):pm?h+12:h; };
function wkTime(v, baseMs){
  if(v==null) return NaN; if(typeof v==="number") return v>1e12?v:v*1000;
  const t=String(v).trim(); if(!t) return NaN;
  if(/^\d{9,13}(\.\d+)?$/.test(t)){ const n=+t; return n>1e12?Math.round(n):Math.round(n*1000); }
  let m=t.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})[ _T]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2})(?:[.,](\d{1,6}))?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i);
  if(m) return wkYmd(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6]||0), m[7], m[8]&&/^[+-]/.test(m[8])?m[8]:m[8]?"Z":"");
  m=t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?\s*([AP]M)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i);
  if(m) return wkYmd(+m[3], +m[1], +m[2], wk12(+m[4], m[8]), +m[5], +(m[6]||0), m[7], m[9]&&/^[+-]/.test(m[9])?m[9]:m[9]?"Z":"");
  m=t.match(/^(\d{1,2})[:.](\d{2})[:.](\d{2})(?:[.,](\d{1,6}))?\s*([AP]M)?$/i);
  if(m){ if(baseMs==null||!isFinite(baseMs)) return NaN; const b=new Date(baseMs);
    b.setHours(wk12(+m[1], m[5]), +m[2], +m[3], m[4]?Math.round(+("0."+m[4])*1000):0); return b.getTime(); }
  const p=Date.parse(t); return isFinite(p)?p:NaN; }

// a continuous walk's taps, as legs (one per Start walk) in time order
function wkLegs(wps){ const by=new Map();
  for(const w of wps||[]){ const ms=Date.parse(w.t); if(!isFinite(ms)) continue; const k=w.leg??0; if(!by.has(k)) by.set(k, []); by.get(k).push({...w, ms}); }
  return [...by.values()].map(a=>a.sort((p,q)=>p.ms-q.ms)); }
// where the walker was at time ms: on the line between the taps before and after it, by time; null outside every leg
function wkPlaceIn(legs, ms, tol=WK_TOL){
  if(!isFinite(ms)) return null;
  for(const a of legs){ const t0=a[0].ms, t1=a[a.length-1].ms;
    if(ms<t0-tol||ms>t1+tol) continue;
    if(ms<=t0) return {x:a[0].x, y:a[0].y};
    if(ms>=t1) return {x:a[a.length-1].x, y:a[a.length-1].y};
    let lo=0, hi=a.length-1; while(hi-lo>1){ const mid=(lo+hi)>>1; if(a[mid].ms<=ms) lo=mid; else hi=mid; }
    const p=a[lo], q=a[hi], k=q.ms>p.ms?(ms-p.ms)/(q.ms-p.ms):0;
    return {x:p.x+(q.x-p.x)*k, y:p.y+(q.y-p.y)*k}; }
  return null; }
// every point with its place on the plan (x / y null: a logged reading outside the walk's times)
function wkPlaced(fw){ const legs=wkLegs(fw.wps);
  return (fw.pts||[]).map(p=>{ if(p.by!=="time") return p; const at=wkPlaceIn(legs, Date.parse(p.t)); return at?{...p, ...at}:{...p, x:null, y:null}; }); }

// the grid on the plan: the floor's grid box (das.js boxOf: centre, size in % of the plan, turned rot°) when it has a plan,
// the whole area when it hasn't. ar: the plan's height / width
const wkBox = (f, onPlan) => onPlan ? {cx:50, cy:50, w:100, h:100, rot:0, ...(f.gridbox||{})} : {cx:50, cy:50, w:100, h:100, rot:0};
const wkRows = f => Math.ceil((f.grids||DAS.grids)/dasCols(f));
// a plan point -> its grid square (numbered row by row, as das.js), or null outside the grid
function wkSquare(x, y, f, ar, onPlan){ const n=f.grids||DAS.grids, cols=dasCols(f), rows=wkRows(f), b=wkBox(f, onPlan);
  const a=-b.rot*Math.PI/180, dx=x-b.cx/100, dy=y*ar-b.cy/100*ar;
  const u=(dx*Math.cos(a)-dy*Math.sin(a))/(b.w/100)+.5, v=(dx*Math.sin(a)+dy*Math.cos(a))/(b.h/100*ar)+.5;
  if(!(u>=0&&u<1&&v>=0&&v<1)) return null;
  const g=Math.floor(v*rows)*cols+Math.floor(u*cols)+1; return g<=n?g:null; }
// (u, v) across and down the grid, 0-1 -> a plan point
function wkUV(u, v, f, ar, onPlan){ const b=wkBox(f, onPlan), a=b.rot*Math.PI/180, ux=(u-.5)*b.w/100, uy=(v-.5)*b.h/100*ar;
  return {x:b.cx/100+ux*Math.cos(a)-uy*Math.sin(a), y:(b.cy/100*ar+ux*Math.sin(a)+uy*Math.cos(a))/ar}; }
const wkCentre = (g, f, ar, onPlan) => { const cols=dasCols(f), rows=wkRows(f); return wkUV(((g-1)%cols+.5)/cols, (Math.floor((g-1)/cols)+.5)/rows, f, ar, onPlan); };
const wkAr = (f, fw, onPlan) => onPlan ? fw.ar : wkRows(f)/dasCols(f);

// one square's readings on one channel -> the one that goes in the square: nearest its centre (IFC 510.5.4 tests at
// about the centre of each area), its worst (das.js eff's order: a failing one first, then the lowest), or its middle one
function wkPick(list, rule, centre, ar){
  if(list.length===1) return list[0];
  if(rule==="centre"&&centre) return list.reduce((a,b)=>Math.hypot(b.p.x-centre.x,(b.p.y-centre.y)*ar)<Math.hypot(a.p.x-centre.x,(a.p.y-centre.y)*ar)?b:a);
  const cell=isCell(list[0].r);
  const lvl=x=>cell?[has(x.rsrp)?+x.rsrp:1e9, has(x.sinr)?+x.sinr:1e9]:[has(x.dl)?+x.dl:1e9, has(x.daq)?+x.daq:1e9, has(x.sinr)?+x.sinr:1e9];
  const key=x=>rule==="worst"&&!cell?[gridPass(x)===false?0:1, ...lvl(x)]:lvl(x);
  const s=[...list].sort((a,b)=>{ const ka=key(a.r), kb=key(b.r); for(let i=0;i<ka.length;i++) if(ka[i]!==kb[i]) return ka[i]-kb[i]; return 0; });
  return rule==="worst" ? s[0] : s[Math.floor((s.length-1)/2)]; }
// the floor's walk -> the grid's results: the walk's earlier readings on this floor come out, then each square gets one
// reading per channel (das.js chKey) from the points in it. Typed and imported square readings stay as they are.
// Only the pass the grid uses rolls up (wkGraded; a point with no pass is the acceptance pass), or the pass asked for.
function wkRollup(d, f, fw0, onPlan, passId){
  const fw=wkPassView(fw0, passId??wkGraded(d));
  const ar=wkAr(f, fw, onPlan), res={...((d.grid||{}).results||{})}, pre=`${f.name}|`, skip=new Set(f.skip||[]), rule=fw.rule||"centre";
  for(const k of Object.keys(res)) if(k.startsWith(pre)){ const rs=readingsOf(res[k]);
    if(rs.some(x=>x.walk)){ const keep=rs.filter(x=>!x.walk); if(keep.length) res[k]={...res[k], readings:keep}; else delete res[k]; } }
  if(!ar) return {results:res, n:0, squares:0};
  const by=new Map();
  for(const p of wkPlaced(fw)){ if(p.x==null||!(p.rs||[]).length) continue; const g=wkSquare(p.x, p.y, f, ar, onPlan); if(!g||skip.has(g)) continue;
    for(const r of p.rs){ if(!wkHasVal(r)) continue; const k=`${g}\n${chKey(r)}`; if(!by.has(k)) by.set(k, []); by.get(k).push({r, p, g}); } }
  let n=0; const sq=new Set();
  for(const list of by.values()){ const g=list[0].g, {r, p}=wkPick(list, rule, rule==="centre"?wkCentre(g, f, ar, onPlan):null, ar), key=pre+g;
    const out={...r, x:+p.x.toFixed(4), y:+p.y.toFixed(4), time:p.t||null, inst:p.inst||"", walk:1,
      source:`walk: ${list.length} point${list.length===1?"":"s"} in the square, ${WK_RULE_SHORT[rule]}${p.src?` (${p.src})`:""}`};
    const now=res[key]; res[key]={...(now&&Array.isArray(now.readings)?now:{}), readings:[...readingsOf(now), out]}; n++; sq.add(g); }
  return {results:res, n, squares:sq.size}; }
// the walk's readings in a floor's squares, to tell whether the grid still holds what the walk gives
const wkSig = (results, f) => JSON.stringify(Object.keys(results||{}).filter(k=>k.startsWith(`${f.name}|`)).sort()
  .map(k=>[k, readingsOf(results[k]).filter(x=>x.walk)]).filter(x=>x[1].length));

/* ---------- test passes (beat-par 11/4): the same floors walked as named passes, BDA off, BDA on, acceptance, each annual,
   five-year, kept side by side. Saved with the walk: data.walk.passes [{id, kind, year}], .cur (the pass being walked),
   .graded (the pass the grid and the Report use), .compare {a, b, sig, met} (the comparison the Report prints). A point or
   walk tap carries pass: <id>; one without (every walk saved before passes) belongs to the acceptance pass. */
const WK_PASS0 = "acceptance";
const WK_PASS_KINDS = [["bda_off","BDA off"],["bda_on","BDA on"],["acceptance","Acceptance"],["annual","Annual"],["five_year","Five-year"],
  ["macro","Cellular: macro only, before the DAS"],["cw","Cellular: CW walk"],["cell_opt","Cellular: after optimization"],["cell_accept","Cellular: carrier acceptance"]];  // cellular added 11/6 (lessons 7.9, 8.3)
const wkPassOf = p => (p&&p.pass) || WK_PASS0;
function wkPasses(d){ const L=((d.walk||{}).passes||[]).filter(p=>p&&p.id); return L.some(p=>p.id===WK_PASS0)?L:[{id:WK_PASS0, kind:"acceptance"}, ...L]; }
const wkPassId = (kind, year) => kind==="annual"||kind==="five_year" ? `${kind}-${year}` : kind;
const wkPassName = (d, id) => { const p=wkPasses(d).find(x=>x.id===id)||{id, kind:String(id).split("-")[0], year:String(id).split("-")[1]};
  const k=(WK_PASS_KINDS.find(x=>x[0]===p.kind)||[,p.kind||id])[1]; return p.year?`${k} ${p.year}`:k; };
const wkCur = d => (d.walk||{}).cur || WK_PASS0;
const wkGraded = d => (d.walk||{}).graded || WK_PASS0;
// one pass of a floor's walk: its points and taps
const wkPassView = (fw, id) => ({...fw, pts:(fw.pts||[]).filter(p=>wkPassOf(p)===id), wps:(fw.wps||[]).filter(w=>wkPassOf(w)===id)});
// a pass's squares on their own: the floor's grid results with only that pass's walk in them (typed and imported square
// readings left out, so two passes compare walk to walk)
function wkPassResults(d, f, fw, onPlan, id){ const pre=`${f.name}|`, res=Object.fromEntries(Object.entries((d.grid||{}).results||{}).filter(([k])=>!k.startsWith(pre)));
  return wkRollup({...d, grid:{...(d.grid||{}), results:res}}, f, fw, onPlan, id).results; }
// a square's value for one signal and metric in one pass: the points in it, taken by the floor's rule (as the roll-up does)
function wkSqVals(fw, f, ar, onPlan, sig, met){ const by=new Map(), rule=fw.rule||"centre";
  for(const p of wkPlaced(fw)){ if(p.x==null) continue; const v=wkVal(p, sig, met); if(v==null) continue; const g=wkSquare(p.x, p.y, f, ar, onPlan); if(!g) continue;
    if(!by.has(g)) by.set(g, []); by.get(g).push({p, v}); }
  const out=new Map();
  for(const [g, L] of by){ let v;
    if(rule==="centre"){ const c=wkCentre(g, f, ar, onPlan); v=L.reduce((a,b)=>Math.hypot(b.p.x-c.x,(b.p.y-c.y)*ar)<Math.hypot(a.p.x-c.x,(a.p.y-c.y)*ar)?b:a).v; }
    else { const s=L.map(x=>x.v).sort((a,b)=>a-b); v=rule==="worst"?s[0]:s[Math.floor((s.length-1)/2)]; }
    out.set(g, v); }
  return out; }
// Clark County FPAN (Dec 2025), five-year: "no deviation of coverage more than 5 percent from the initial installation
// documentation". Coverage here = the floor's tested squares that pass (public safety, the job's AHJ profile), each pass
const WK_CLARK = {pts:5, src:"https://files.lasvegasnevada.gov/fire-rescue/2025/FPAN-Guide_for_ERCES_Permitting_Testing_Recertification-Dec-2025.pdf",
  says:"Clark County FPAN, five-year: no deviation of coverage more than 5 percent from the initial installation documentation"};
// two passes on one floor: per square A, B and the change for the signal shown; each pass's coverage and the 5% check
function wkCompare(d, f, fw, onPlan, a, b, sig, met){ const ar=wkAr(f, fw, onPlan); if(!ar) return null;
  const n=f.grids||DAS.grids, skip=new Set(f.skip||[]), A=wkSqVals(wkPassView(fw, a), f, ar, onPlan, sig, met), B=wkSqVals(wkPassView(fw, b), f, ar, onPlan, sig, met);
  const st=id=>{ const res=wkPassResults(d, f, fw, onPlan, id), dd={...d, grid:{...(d.grid||{}), results:res}}, s=floorStats(dd, f);
    return {s, res, dd, n:wkPassView(fw, id).pts.length}; };
  const SA=st(a), SB=st(b), squares=[];
  for(let g=1; g<=n; g++){ if(skip.has(g)) continue; const va=A.has(g)?A.get(g):null, vb=B.has(g)?B.get(g):null;
    squares.push({g, a:va, b:vb, d:va!=null&&vb!=null?Math.round((vb-va)*10)/10:null,
      pa:wkSqState(SA.dd, SA.res[`${f.name}|${g}`], sig), pb:wkSqState(SB.dd, SB.res[`${f.name}|${g}`], sig)}); }
  const cov=x=>x.s.tested>0?dasPct(x.s.pass, x.s.tested):null, ca=cov(SA), cb=cov(SB), delta=ca!=null&&cb!=null?Math.round((cb-ca)*10)/10:null;
  const both=squares.filter(x=>x.d!=null), mean=both.length?Math.round(both.reduce((s,x)=>s+x.d,0)/both.length*10)/10:null;
  const clark=delta==null?{state:null, txt:"needs both passes walked on this floor"}:Math.abs(delta)<=WK_CLARK.pts?{state:"ok", txt:`coverage ${ca}% → ${cb}%: ${delta>=0?"+":""}${delta} points, within ${WK_CLARK.pts}`}
    :delta<0?{state:"fail", txt:`coverage ${ca}% → ${cb}%: ${delta} points, more than ${WK_CLARK.pts} down`}:{state:"warn", txt:`coverage ${ca}% → ${cb}%: +${delta} points, more than ${WK_CLARK.pts} up (better, still a deviation: tell the AHJ)`};
  return {squares, a:{id:a, cov:ca, pts:SA.n, stats:SA.s}, b:{id:b, cov:cb, pts:SB.n, stats:SB.s}, delta, mean, worse:both.filter(x=>x.d<0).length, better:both.filter(x=>x.d>0).length, clark}; }
// the difference heat map: each pass's heat on one grid, B minus A where both have colour
function wkDiffHeat(ptsA, ptsB, W, H, cols){ const ha=wkHeat(ptsA, W, H, cols), hb=wkHeat(ptsB, W, H, cols), v=new Float32Array(ha.v.length).fill(NaN), al=new Float32Array(ha.v.length);
  for(let k=0;k<v.length;k++) if(!isNaN(ha.v[k])&&!isNaN(hb.v[k])){ v[k]=hb.v[k]-ha.v[k]; al[k]=Math.min(ha.al[k], hb.al[k]); }
  return {cols:ha.cols, rows:ha.rows, v, al}; }
// red where B is worse, white where the same, blue where better; full colour at ±span (10 dB, 1 DAQ, 6 dB SINR)
const wkDiffSpan = met => met==="daq"?1:met==="sinr"||met==="rsrq"?6:10;
function wkDiffRgb(dv, span){ const t=Math.max(-1, Math.min(1, dv/span)), w=[245,245,245], r=[207,34,46], b=[31,111,235], c=t<0?r:b, k=Math.abs(t);
  return w.map((x,i)=>Math.round(x+(c[i]-x)*k)); }

// what to show: public safety (every channel, or one), or a carrier's cells below / from 3.3 GHz (dascell.js), or one band
function wkSignals(pts){ const ps=new Set(), cell=new Map(); let anyPs=false;
  for(const p of pts) for(const r of p.rs||[]){
    if(isCell(r)){ if(!has(r.rsrp)&&!has(r.rsrq)&&!has(r.sinr)) continue; const c=carrierName(r.carrier), l=layerOf(r), k=`cell|${c}|${l}`;
      if(!cell.has(k)) cell.set(k, {key:k, carrier:c, label:`${c}, ${LAYER_NAME[l]}`, bands:new Set()}); if(has(r.band)) cell.get(k).bands.add(String(r.band).trim()); }
    else if(has(r.dl)||has(r.daq)||has(r.sinr)||has(r.ul)){ anyPs=true; if(has(r.freq)) ps.add(String(r.freq).trim()); } }
  const out=[];
  if(anyPs){ out.push({key:"ps|*", kind:"ps", label:"Public safety, every channel (worst)"}); for(const x of [...ps].sort()) out.push({key:`ps|${x}`, kind:"ps", label:`Public safety, ${x}`}); }
  for(const c of [...cell.values()].sort((a,b)=>a.label.localeCompare(b.label))){ out.push({key:c.key, kind:"cell", label:`${c.label} (best cell)`});
    for(const b of [...c.bands].sort((a,b)=>a.localeCompare(b, undefined, {numeric:true}))) out.push({key:`${c.key}|${b}`, kind:"cell", label:`${c.carrier}, band ${b}`}); }
  return out; }
const WK_METRICS = {ps:[["dl","DL dBm"],["daq","DAQ"],["sinr","SINR dB"],["ul","UL dBm"]], cell:[["rsrp","RSRP dBm"],["rsrq","RSRQ dB"],["sinr","SINR dB"]]};
// a point's value for one signal and metric: public safety's worst channel; a carrier's best cell (a phone uses its strongest)
function wkVal(p, sig, met){ const [kind, a, b, c]=sig.split("|");
  const rs=(p.rs||[]).filter(r=>kind==="ps" ? !isCell(r)&&(a==="*"||String(r.freq??"").trim()===a)
    : isCell(r)&&carrierName(r.carrier)===a&&layerOf(r)===b&&(c==null||String(r.band??"").trim()===c));
  if(!rs.length) return null;
  if(kind==="ps"){ const v=rs.map(r=>r[met]).filter(has).map(Number).filter(isFinite); return v.length?Math.min(...v):null; }
  const wr=rs.filter(r=>has(r.rsrp)), best=wr.length?wr.reduce((x,y)=>+y.rsrp>+x.rsrp?y:x):rs[0];
  return has(best[met])&&isFinite(+best[met])?+best[met]:null; }
// the colour scale: the job's requirement for that metric when it has one (public safety: the AHJ profile; cellular: the
// cellular target, dascell.js), else the lowest to the highest reading
function wkScale(d, sig, met, vals){ const [kind, a, b]=sig.split("|"); let thr=null, span=15, unit=" dBm", what;
  if(kind==="ps"){ what=`the AHJ profile${DASJ.profile_name?` (${DASJ.profile_name})`:""}`;
    if(met==="dl"||met==="ul") thr=DASJ.threshold; else if(met==="daq"){ thr=DASJ.daq; span=1.5; unit=""; } else if(met==="sinr"){ thr=daqEq().sinr; span=8; unit=" dB"; } }
  else { const P=cellProfile(d); what=`the cellular target (${P.name})`;
    if(met==="rsrp") thr=cellThr(P, a, b); else if(met==="sinr"){ thr=P.sinr; span=8; unit=" dB"; } else { span=6; unit=" dB"; } }
  if(thr==null||!isFinite(+thr)){ const v=vals.filter(isFinite); return {thr:null, lo:v.length?Math.min(...v):0, hi:v.length?Math.max(...v):1, unit, what}; }
  return {thr:+thr, span, unit, what}; }
const WK_STOPS = [[-1,[142,27,27]],[-1e-6,[229,83,75]],[0,[250,178,25]],[1/3,[166,212,106]],[1,[47,163,95]]];
const WK_SMOOTH = [[-1,[229,83,75]],[0,[250,178,25]],[1,[47,163,95]]];
function wkRgb(v, sc){ let t, st=WK_STOPS;
  if(sc.thr!=null) t=(v-sc.thr)/sc.span; else { st=WK_SMOOTH; t=sc.hi>sc.lo?(v-sc.lo)/(sc.hi-sc.lo)*2-1:0; }
  t=Math.max(-1, Math.min(1, t));
  for(let i=1;i<st.length;i++) if(t<=st[i][0]){ const [t0,c0]=st[i-1], [t1,c1]=st[i], k=t1>t0?(t-t0)/(t1-t0):0; return c0.map((c,j)=>Math.round(c+(c1[j]-c)*k)); }
  return st[st.length-1][1]; }
// a square's outline: the public-safety score, or the carrier's coverage target (dascell.js cellSquare) when a carrier is shown
const wkSqState = (d, raw, sig) => { if(!sig||sig.startsWith("ps")) return scored(d, eff(d, raw)); const [,c,l]=sig.split("|"), x=cellSquare(d, raw, `${c}|${l}`); return x?x.pass:null; };
const wkPass = (v, sc) => sc.thr==null ? null : v>=sc.thr;
// the heat map: inverse-distance weighting of the points that have the metric, out to a radius from the nearest one
// (no colour far from any reading: a heat map isn't a prediction)
function wkHeat(pts, W, H, cols){ const rows=Math.max(1, Math.round(cols*H/W)), ar=H/W, v=new Float32Array(cols*rows).fill(NaN), al=new Float32Array(cols*rows);
  if(!pts.length) return {cols, rows, v, al};
  const rad=Math.max(.035, Math.min(.12, 1.2*Math.sqrt(ar/pts.length))), cell=rad, grid=new Map(), key=(i,k)=>i*100003+k;
  for(const p of pts){ const i=Math.floor(p.x/cell), k=Math.floor(p.y*ar/cell), q=key(i,k); if(!grid.has(q)) grid.set(q, []); grid.get(q).push(p); }
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const x=(c+.5)/cols, y=(r+.5)/rows*ar, i0=Math.floor(x/cell), k0=Math.floor(y/cell);
    let sw=0, sv=0, dmin=1e9;
    for(let i=i0-1;i<=i0+1;i++) for(let k=k0-1;k<=k0+1;k++){ const list=grid.get(key(i,k)); if(!list) continue;
      for(const p of list){ const dd=Math.hypot(p.x-x, p.y*ar-y); if(dd>=rad) continue; if(dd<dmin) dmin=dd; const w=(1-dd/rad)**2/(dd*dd+1e-5); sw+=w; sv+=w*p.v; } }
    if(sw>0){ v[r*cols+c]=sv/sw; al[r*cols+c]=1-(dmin/rad)**2; } }
  return {cols, rows, v, al}; }

// a log's columns: G-NetTrack Pro's own names; any other file by the names RF Recon's grid import knows (das.py
// GRID_ALIASES) and the person picks the rest. G-NetTrack's Level / Qual / SNR are RSRP / RSRQ / SINR on LTE.
const WK_FIELDS = [["time","Time"],["tech","Technology"],["carrier","Carrier"],["band","Band"],["pci","PCI"],["freq","Channel / EARFCN / MHz"],["mhz","DL MHz"],
  ["rsrp","RSRP dBm"],["rsrq","RSRQ dB"],["sinr","SINR dB"],["dl","DL dBm (public safety)"],["daq","DL DAQ"],["ber","BER %"],["ul","UL dBm"],["ul_daq","UL DAQ"],
  ["ue_tx","Phone Tx power dBm"],["call","Call result"],["x","Plan X"],["y","Plan Y"],["note","Note"]];
const WK_NUMS = ["rsrp","rsrq","sinr","dl","daq","ber","ul","ul_daq","ue_tx"];
// phone transmit power and call results in a walk, when the log carries them: phones at maximum power (23 dBm, power class 3,
// within 1 dB) at no more than 10% of points (Providence Water RFP PVD26-53, 3.10). High power with good RSRP: the uplink is short.
function wkPhoneStats(P){ const rs=P.flatMap(p=>p.rs||[]), tx=rs.filter(r=>has(r.ue_tx)), calls=rs.filter(r=>r.call);
  const bad=calls.filter(r=>/drop|fail|block|lost/i.test(r.call)), atMax=tx.filter(r=>+r.ue_tx>=22);
  return {tx:tx.length, atMax:atMax.length, share:tx.length?atMax.length/tx.length:null, calls:calls.length, bad:bad.length}; }
function wkPhoneLine(P){ const s=wkPhoneStats(P); if(!s.tx&&!s.calls) return "";
  return `${s.tx?` Phone transmit power at ${s.tx.toLocaleString()} reading${s.tx===1?"":"s"}: at maximum (22 dBm or more) at ${Math.round(s.share*100)}%${s.share>0.10?' <b style="color:var(--bad)">over the 10% an owner RFP allows: the uplink is short</b>':", inside the 10% an owner RFP allows"}.`:""}${s.calls?` Calls: ${s.calls-s.bad} of ${s.calls} ok${s.bad?`, <b>${s.bad} dropped or failed</b>`:""}.`:""}`; }
function wkSniff(headers, guess){ const hit=n=>headers.find(h=>h.toLowerCase()===n.toLowerCase());
  const m={}; for(const [k] of WK_FIELDS) if(guess&&guess[k]) m[k]=guess[k];
  if(hit("Timestamp")&&hit("NetworkTech")&&hit("Level")&&(hit("Operatorname")||hit("Operator"))){
    const g={time:hit("Timestamp"), tech:hit("NetworkTech"), carrier:hit("Operatorname")||hit("Operator"), rsrp:hit("Level"), rsrq:hit("Qual"), sinr:hit("SNR"),
      freq:hit("ARFCN"), pci:hit("PCI")||hit("PSC"), band:hit("Band")};
    for(const k of ["dl","daq","ber","ul","ul_daq","x","y"]) delete m[k];
    return {name:"G-NetTrack Pro log", phone:true, lteOnly:true, map:{...m, ...Object.fromEntries(Object.entries(g).filter(([,v])=>v))}}; }
  const phone=!!(m.rsrp&&!m.daq&&!m.dl), named=/network\s*cell\s*info|netmonster|cellular-?z/i.test(headers.join(" "));
  if(phone&&m.dl) delete m.dl;
  return {name:named?"Phone survey app log":phone?"Phone or scanner log (cellular)":"Instrument or survey log", phone, lteOnly:false, map:m}; }
// one row of a log -> a reading
function wkRow(row, m){ const r={};
  for(const k of WK_NUMS) if(m[k]){ const v=wkNum(row[m[k]]); if(v!=null) r[k]=v; }
  for(const k of ["tech","carrier","band","pci","freq","call"]) if(m[k]&&String(row[m[k]]??"").trim()!=="") r[k]=String(row[m[k]]).trim();
  if(m.mhz){ const v=wkNum(row[m.mhz]); if(v!=null) r.mhz=v; }
  if(r.tech&&/^(4g|lte.*)$/i.test(r.tech)) r.tech="LTE"; else if(r.tech&&/^(5g|nr.*)$/i.test(r.tech)) r.tech="NR";
  if(r.carrier) r.carrier=carrierName(r.carrier);
  return r; }
// a log's readings onto the floor's walk: empty tapped spots first (each takes, per channel, the reading nearest its time,
// within win ms), then every other reading by time along the walk. -> the new points and what happened to each row
function wkFromLog(fw, rows, m, o){ const legs=wkLegs(fw.wps), out={filled:0, placed:0, xy:0, outside:0, noTime:0, noValue:0, other:0, pts:[]};
  const empty=(fw.pts||[]).filter(p=>p.by==="tap"&&!(p.rs||[]).length);
  const base=[...(fw.wps||[]), ...(fw.pts||[])].map(x=>Date.parse(x.t)).find(isFinite) ?? Date.now();
  const S2=[];
  for(const row of rows){ const r=wkRow(row, m);
    if(o.lteOnly&&!/^(LTE|NR)$/i.test(r.tech||"")){ out.other++; continue; }
    if(!wkHasVal(r)){ out.noValue++; continue; }
    if(m.note&&String(row[m.note]??"").trim()) r.note=String(row[m.note]).trim();
    const ms=m.time?wkTime(row[m.time], base)+(o.offset||0):NaN;
    let xy=null; if(m.x&&m.y){ const x=wkNum(row[m.x]), y=wkNum(row[m.y]); if(x!=null&&y!=null){ const sc=Math.max(Math.abs(x),Math.abs(y))>1?100:1; xy={x:Math.max(0,Math.min(1,x/sc)), y:Math.max(0,Math.min(1,y/sc))}; } }
    S2.push({r, ms, xy}); }
  const used=new Set();
  for(const p of empty){ const pm=Date.parse(p.t), near=new Map();
    S2.forEach((s,i)=>{ if(s.xy||!isFinite(s.ms)) return; const dt=Math.abs(s.ms-pm); if(dt>o.win) return; const k=chKey(s.r), b=near.get(k); if(!b||dt<b.dt) near.set(k, {i, dt}); });
    if(!near.size) continue;
    for(const {i} of near.values()) used.add(i);
    out.pts.push({...p, rs:[...near.values()].map(({i})=>S2[i].r), inst:o.inst, src:o.src, fill:true}); out.filled++; }
  S2.forEach((s,i)=>{ if(used.has(i)) return;
    if(s.xy){ out.pts.push({by:"xy", ...s.xy, t:isFinite(s.ms)?new Date(s.ms).toISOString():null, rs:[s.r], inst:o.inst, src:o.src}); out.xy++; return; }
    if(!isFinite(s.ms)){ out.noTime++; return; }
    if(!wkPlaceIn(legs, s.ms)){ out.outside++; return; }
    out.pts.push({by:"time", t:new Date(s.ms).toISOString(), rs:[s.r], inst:o.inst, src:o.src}); out.placed++; });
  return out; }

// the phone's own signal (RF Recon for Android's window.RFRadio): a snapshot {ts, serving:[cell], neighbours:[cell]}, a cell
// {tech, carrier, mcc, mnc, band, pci, earfcn | nrarfcn, rsrp, rsrq, sinr}. Cellular only, not calibrated (inst "uncal").
const WK_PHONE_SRC = "Phone (not calibrated)";
const WK_PLMN = {"313100":"FirstNet", "310410":"AT&T", "310280":"AT&T", "310150":"AT&T", "311480":"Verizon", "310004":"Verizon", "310012":"Verizon",
  "310260":"T-Mobile", "310120":"T-Mobile", "312250":"T-Mobile", "311580":"UScellular", "313340":"Dish / Boost"};
const WK_PHONE_MAP = Object.fromEntries(["time","tech","carrier","band","pci","freq","rsrp","rsrq","sinr"].map(k=>[k, k]));
// a snapshot's serving cells -> cellular readings, one per serving cell and carrier (neighbours left out)
function wkPhoneReadings(snap){ const out=[], seen=new Set();
  for(const c of (snap&&snap.serving)||[]){ const r={tech:/NR|5G/i.test(String(c.tech||""))?"NR":"LTE"};
    r.carrier=carrierName(WK_PLMN[`${c.mcc??""}${c.mnc??""}`]||c.carrier||"");
    for(const [k,v] of [["band",c.band],["pci",c.pci],["freq",c.earfcn??c.nrarfcn]]) if(has(v)) r[k]=String(v);
    for(const k of ["rsrp","rsrq","sinr"]){ const v=wkNum(c[k]); if(v!=null) r[k]=v; }
    if(!has(r.rsrp)&&!has(r.rsrq)) continue;
    const k=chKey(r); if(seen.has(k)) continue; seen.add(k); out.push(r); }
  return out; }
// a walk's drained snapshots -> log rows for wkFromLog (with WK_PHONE_MAP), each at the time the phone measured it
const wkPhoneRows = snaps => (snaps||[]).flatMap(s=>wkPhoneReadings(s).map(r=>({...r, time:+s.ts})));

// Phone correction (Cody 11/4: "can we get the phone calibrated some how?"). A phone can't be calibrated, but it can be
// characterised against one that is: at a few spots the phone's RSRP and a calibrated instrument's reading of the same cell
// are kept as a pair (Point › Phone vs instrument). Each band's offset (the median of instrument − phone) corrects the
// phone's later readings; the spread says how far one corrected reading can still be off. Corrected readings stay "not
// calibrated": closer to the truth, mapped, never counted toward pass / fail. The pairs are kept with the walk (fw.cal) and
// on the phone itself (localStorage), per phone model, so a phone's table follows it to the next job.
//   pair: {t, model, tech, band, carrier, pci, phone (dBm), ref (dBm), inst}
const WK_CAL_MIN = 5, WK_CAL_KEY = "rfr.phonecal";
const wkCalKey = r => `${r.tech==="NR"?"NR":"LTE"}|${String(r.band??"").trim()||"?"}`;
const wkMedian = a => { const v=[...a].sort((x,y)=>x-y), n=v.length; return n?(n%2?v[(n-1)/2]:(v[n/2-1]+v[n/2])/2):null; };
function wkCalStats(ps){ const dd=ps.map(p=>p.ref-p.phone), n=dd.length, off=wkMedian(dd);
  const sd=n>1?Math.sqrt(dd.reduce((a,x)=>a+(x-off)**2, 0)/(n-1)):null, lv=ps.map(p=>p.phone), lo=Math.min(...lv), hi=Math.max(...lv);
  const q=n>=WK_CAL_MIN&&hi-lo>=10&&sd!=null&&sd<=4?"good":n>=3?"rough":"too few";
  return {off:Math.round(off*10)/10, sd:sd==null?null:Math.round(sd*10)/10, n, lo, hi, q}; }
const wkCalOk = p => p && isFinite(p.phone) && isFinite(p.ref) && p.phone!==null && p.ref!==null;
// pairs -> {bands:{"LTE|66": stats}, all: stats over every band | null}
function wkCalFit(pairs){ const ok=(pairs||[]).filter(wkCalOk), by={};
  for(const p of ok) (by[wkCalKey(p)] ||= []).push(p);
  return {bands:Object.fromEntries(Object.entries(by).map(([k, ps])=>[k, wkCalStats(ps)])), all:ok.length?wkCalStats(ok):null}; }
// one reading through the table: its band's offset when that band has 3+ pairs, else every band's once there are 5+.
// The phone's own value stays as rsrp_raw (a reading already corrected is left alone).
function wkCalApply(r, fit){ if(!fit||!r||!has(r.rsrp)||has(r.rsrp_raw)) return r; const k=wkCalKey(r), b=fit.bands[k];
  const use=b&&b.n>=3?{...b, key:k}:fit.all&&fit.all.n>=WK_CAL_MIN?{...fit.all, key:"all bands"}:null;
  if(!use) return r;
  return {...r, rsrp_raw:r.rsrp, rsrp:Math.round((r.rsrp+use.off)*10)/10, cor:{off:use.off, sd:use.sd, n:use.n, key:use.key, q:use.q}}; }
// pairs from several places (this phone, the job's floors), this phone model's only, each once
function wkCalMerge(ps, model){ const seen=new Set();
  return (ps||[]).filter(p=>{ if(!wkCalOk(p)||(p.model&&p.model!==model)) return false; const k=`${p.t}|${wkCalKey(p)}|${p.ref}|${p.phone}`;
    if(seen.has(k)) return false; seen.add(k); return true; }); }
// the pairs a job holds, one group per phone model (each pair once): [{model, pairs}], the given model first, then by name.
// A pair saved with no model is shown as "phone not named". This device's own pairs (its local table) are added by the page.
const WK_CAL_NONAME = "phone not named";
function wkCalModels(ps, first){ const by=new Map(), seen=new Set();
  for(const p of ps||[]){ if(!wkCalOk(p)) continue; const m=p.model||WK_CAL_NONAME, k=`${m}|${p.t}|${wkCalKey(p)}|${p.ref}|${p.phone}`; if(seen.has(k)) continue; seen.add(k);
    if(!by.has(m)) by.set(m, []); by.get(m).push(p); }
  return [...by.entries()].map(([model, pairs])=>({model, pairs})).sort((a,b)=>(b.model===first)-(a.model===first)||a.model.localeCompare(b.model)); }
const wkCalLabel = k => { const [t, b]=k.split("|"); return k==="all bands"?"every band":`${t==="NR"?"5G NR":"LTE"} band ${b}`; };
const wkCalSays = s => s.off>0?`reads ${s.off} dB low`:s.off<0?`reads ${-s.off} dB high`:"reads right";

/* ---------- the page ---------- */
const WK = {cache:{}, undo:{}, lastSync:{}, busy:false, next:null, compass:null};
// this phone's model, for its correction table: the browser's own report (Android WebView), else its user agent
const wkModel = () => WK.model || (WK.model = (()=>{ const ua=typeof navigator!=="undefined"?navigator.userAgent||"":"";
  const m=(ua.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build\/[^;)]*)?[;)]/i)||[])[1]; return m&&m.trim().length>1?m.trim():"this phone"; })());
try{ navigator.userAgentData?.getHighEntropyValues?.(["model"]).then(v=>{ if(v&&v.model) WK.model=v.model; }).catch(()=>{}); }catch(e){ /* no model from this browser: the phone stays unnamed */ }
const wkCalStore = model => { try{ const a=JSON.parse(localStorage.getItem(WK_CAL_KEY)||"[]"); return Array.isArray(a)?a.filter(p=>p.model===model):[]; }catch(e){ return []; } };
const wkCalKeep = ps => { try{ const a=JSON.parse(localStorage.getItem(WK_CAL_KEY)||"[]"); localStorage.setItem(WK_CAL_KEY, JSON.stringify([...(Array.isArray(a)?a:[]), ...ps].slice(-1000))); }catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } };
const wkUi = () => S.das.walk ||= {mode:"point", vals:"type", kind:"ps", walking:false, leg:0, t0:0, zoom:1, sig:"", met:"", last:{ps:{}, cell:{}}};
const wkClone = x => JSON.parse(JSON.stringify(x));
// the floor's walk: the saved one, or this visit's newer copy while a save is still on its way
function wkFloorOf(j, name){ const W=(j.data||{}).walk, saved=(W&&Array.isArray(W.floors)?W.floors:[]).find(x=>x.name===name), c=WK.cache[`${j.id}|${name}`];
  const base=c&&(!saved||(c.rev||0)>(saved.rev||0))?c:saved;
  return wkClone(base||{name, rev:0, seq:0, rule:"centre", pts:[], wps:[]}); }
const wkLocalTime = ms => { const t=new Date(ms), p=x=>String(x).padStart(2,"0"); return `${t.getFullYear()}-${p(t.getMonth()+1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`; };
const wkClock = ms => isFinite(ms) ? new Date(ms).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}) : "–";
// RF Recon for Android's radio: there, and a call to it (its answers are JSON text; a refusal is {error, message})
const wkPhone = () => { try{ return !!(window.RFRadio&&window.RFRadio.available()); }catch(e){ return false; } };
const wkPhoneCall = (fn, ...a) => { try{ const v=window.RFRadio[fn](...a); return typeof v==="string"?JSON.parse(v):v; }
  catch(e){ return {error:"bridge", message:`The phone's signal couldn't be read (${e.message}).`}; } };
const wkPhoneTxt = r => `${r.carrier} ${r.tech==="NR"?"5G NR":"LTE"}${has(r.band)?` band ${r.band}`:""}${has(r.rsrp)?` RSRP ${r.rsrp} dBm${has(r.rsrp_raw)?` (the phone read ${r.rsrp_raw})`:""}`:""}${has(r.sinr)?` SINR ${r.sinr} dB`:""}`;

// Saves go one at a time, the newest waiting one next (a fast walk's taps fold into one save); a refused save says so
async function wkPump(){ if(WK.busy) return; WK.busy=true;
  try{ while(WK.next){ const job=WK.next; WK.next=null; job.say("Saving…");
      const nj=await job.save(job.patch), got=(((nj||{}).data||{}).walk||{}).floors||[], fl=got.find(x=>x.name===job.floor);
      job.say(fl&&(fl.rev||0)>=job.rev?"Saved.":"Not saved: the change is still on this page; it saves with the next one, or press Undo and redo it."); } }
  finally{ WK.busy=false; } }

// the walk's roll-up kept true on every Grid test draw: the grid changed (squares, columns, the box on the plan, do-not-test
// squares), the AHJ profile changed, or another save put back older squares. Re-rolled and saved; true when it was.
async function wkSync(j, save){ const d=j.data||{}, W=d.walk; if(!W||!Array.isArray(W.floors)||!W.floors.length) return false;
  let results=(d.grid||{}).results||{}, changed=false;
  for(const fw of W.floors){ const f=(d.floors||[]).find(x=>x.name===fw.name); if(!f) continue; const onPlan=!!f.plan;
    if(onPlan&&(fw.arFor!==f.plan||!fw.ar)) continue;  // the plan's shape isn't known for this plan yet: the Walk view measures it
    const R=wkRollup({...d, grid:{...(d.grid||{}), results}}, f, fw, onPlan);
    if(wkSig(R.results, f)!==wkSig(results, f)){ results=R.results; changed=true; } }
  if(!changed) return false;
  // the same roll-up already tried for this job (its save was refused): not again, or every draw would save and draw again
  const tag=JSON.stringify(W.floors.map(fw=>wkSig(results, {name:fw.name})));
  if(WK.lastSync[j.id]===tag) return false; WK.lastSync[j.id]=tag;
  await save({grid:{...(d.grid||{}), results}}); return true; }

// das.js dasGrid calls this at the end of every draw (ctx: the floor, its plan, what takes the readings)
window.dasWalkHook = async (el, j, save, ctx) => {
  if(S.das.mark!=="walk"){
    if(await wkSync(j, save)&&el.isConnected) render();
    return; }
  const panel=el.querySelector(".grid2 > .panel"); if(!panel) return;
  panel.id="wkPanel";
  // the floor cards and the rule line show the grid as drawn; the walk's own line below stays current while you walk
  el.querySelectorAll(".cards, #dgRule").forEach(x=>{ x.style.display="none"; });
  wkMount(panel, j, save, ctx); };

function wkMount(panel, j0, save, ctx){
  let j=wkRetestOpen(j0), fw=wkFloorOf(j0, ctx.f.name), sel=null, spot=null, spotPid=null, drag=null;
  const U=wkUi(), f=ctx.f, onPlan=!!ctx.hasPlan, uk=`${j.id}|${f.name}`, n=f.grids||DAS.grids, cols=dasCols(f), rows=wkRows(f);
  const d=()=>j.data||{}, ar=()=>wkAr(f, fw, onPlan), undo=()=>WK.undo[uk]||[];
  const cur=()=>wkCur(d()), pv=()=>wkPassView(fw, cur());  // the pass being walked: what the plan shows and what a tap adds to
  const wft=()=>((((d().design||{}).floors||{})[f.name])||{}).width_ft||null;
  if(!["point","cont","edit"].includes(U.mode)) U.mode="point";
  if(U.walking&&U.floor&&U.floor!==f.name) U.walking=false;  // a walk belongs to its floor
  const phone=wkPhone(); if((U.vals==="phone"||U.vals==="calib")&&!phone) U.vals="type";
  const calModel=wkModel(), calOn=()=>U.cor!==false;
  const calPairs=()=>wkCalMerge([...wkCalStore(calModel), ...(((d().walk||{}).floors)||[]).filter(x=>x.name!==f.name).flatMap(x=>x.cal||[]), ...(fw.cal||[])], calModel);
  const calFix=rs=>{ const ft=calOn()?wkCalFit(calPairs()):null; return ft?rs.map(r=>wkCalApply(r, ft)):rs; };
  const modeHint={point:U.vals==="log"?"tap where you stand each time the instrument or app logs a reading; then import the log: each spot takes the reading nearest its time"
      :U.vals==="phone"?"tap where you stand: the spot takes this phone's own serving cell (cellular only, not calibrated)"
      :U.vals==="calib"?"hold a calibrated instrument beside the phone and tap where you stand: the phone reads its cell, then enter what the instrument reads for the same cell"
      :"tap where you stand, then enter what the instrument reads",
    cont:U.walking?`tap your position at each turn and every few steps; readings logged between two taps go on the line between them, by time${phone?" (this phone is logging its own signal)":""}`
      :phone?"Start walk (this phone logs its own LTE / 5G signal while you walk), then tap your position as you go"
      :"Start walk, then tap your position as you go while the instrument or phone app logs",
    edit:"tap a point or a walk tap to see, change or delete it; drag it to move it"}[U.mode];
  const insts=ctx.insts||[], instName2=k=>k==="uncal"?"no calibrated instrument (not counted)":k?instName(insts.find(i=>instKey(i)===k)||{model:k.replace("|"," ")}):"";
  panel.innerHTML=`<h3>Walk · floor ${esc(f.name)} <span class="hint">· ${esc(modeHint)}</span></h3>
    <div class="maptools no-print" style="gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <div class="seg" id="wkMode">${[["point","Point"],["cont","Continuous"],["edit","Edit"]].map(([k,l])=>`<button data-wm="${k}" class="${U.mode===k?"on":""}">${l}</button>`).join("")}</div>
      ${U.mode==="point"?`<div class="seg" id="wkVals">${[["type","Type values"],["log","Values from a log"],...(phone?[["phone","Read the phone"],["calib","Phone vs instrument"]]:[])].map(([k,l])=>`<button data-wv="${k}" class="${U.vals===k?"on":""}">${l}</button>`).join("")}</div>`:""}
      ${U.mode==="cont"?`<button id="wkGo" class="primary">${U.walking?"Stop walk":"Start walk"}</button><span id="wkClock" class="mono"></span>`:""}
      <button id="wkUndo" ${undo().length?"":"disabled"}>↶ Undo</button>
      <span class="seg" id="wkZoom"><button data-z="-1" aria-label="Zoom out">−</button><button data-z="1" aria-label="Zoom in">+</button></span>
    </div>
    ${wkPassBar(d(), fw)}${wkRetestNote(d())}
    <p class="status" id="wkScore" style="margin:0 0 6px"></p>
    <div id="wkScroll" style="${U.zoom>1?"overflow:auto;max-height:75vh;":"overflow:hidden;"}border-radius:10px">
      <div id="wkWrap" style="position:relative;width:${U.zoom*100}%;line-height:0">
        ${onPlan?`<img id="wkImg" src="${ctx.planSrc}" alt="Floor ${esc(f.name)} plan" draggable="false" style="display:block;width:100%;height:auto;user-select:none;pointer-events:none;background:#fff">`
          :`<div style="aspect-ratio:${cols}/${rows};background:color-mix(in srgb,var(--panel) 50%,transparent);border:1px dashed var(--line)"></div>`}
        <canvas id="wkHeat" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.62"></canvas>
        <svg id="wkSvg" role="img" aria-label="Walk on floor ${esc(f.name)}" style="position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:${U.mode==="edit"?"none":"manipulation"}"></svg>
      </div></div>
    <div id="wkLegend" style="margin-top:6px"></div>
    <p class="hint" style="margin:4px 0 0"><span id="wkSaid" role="status" aria-live="polite"></span> <span id="wkSave" class="mono"></span></p>
    <div id="wkForm"></div>
    <div class="maptools no-print" style="gap:8px;flex-wrap:wrap;margin:8px 0 0">
      <label class="inl">Show <select id="wkSig"></select></label><label class="inl">Metric <select id="wkMet"></select></label>
      <label class="inl">Each square takes <select id="wkRule">${WK_RULES.map(([k,l])=>`<option value="${k}" ${(fw.rule||"centre")===k?"selected":""}>${esc(l)}</option>`).join("")}</select></label></div>
    <div class="maptools no-print" style="gap:8px;flex-wrap:wrap;margin:8px 0 0">
      <label class="inl">Import a log <input type="file" id="wkImp" accept=".csv,.tsv,.txt,.json,.xlsx"></label>
      <button id="wkCsv">⇩ Points CSV</button><button id="wkPng">⇩ Heat map PNG</button><button id="wkFile">Save heat map to Files</button><button id="wkClear">Clear this floor's walk</button></div>
    <div id="wkImpBox"></div>
    <div id="wkCal"></div>
    <div id="wkCmp"></div>
    <p class="hint" style="margin:8px 0 0">${phone?`<b>This app reads the phone's own signal</b>: Read the phone (Point) takes its serving cell at a tap; Start walk (Continuous) logs it and Stop places the readings by time. Phone readings are cellular only (LTE / 5G, no public-safety channels) and not calibrated: indicative, never counted toward a public-safety pass, saved as taken with "${esc(WK_PHONE_SRC)}". An instrument's log still imports here (Import a log); readings`
      :`A web page can't read this phone's own signal. On Android, the <a href="#" data-help="android">RF Recon Android app</a> can (Read the phone); otherwise log it with a survey app (G-NetTrack Pro, Network Cell Info) or an instrument, then import the log here; readings`} are matched to your taps by time (set the clock offset if the logger's clock differs). The heat map shows every reading; the grid squares take ${esc(WK_RULE_SHORT[fw.rule||"centre"])} reading of the points in each, and only readings from a calibrated instrument count toward pass / fail. Cellular readings never count toward public safety. Taken with: <b>${esc(instName2(ctx.inst)||"not picked")}</b>.</p>`;
  const $p=s=>panel.querySelector(s), svg=$p("#wkSvg"), cv=$p("#wkHeat"), img=$p("#wkImg");
  const say=t=>{ const x=$p("#wkSaid"); if(x) x.textContent=t; };

  // the floor changed: saved with its roll-up into the squares, the page drawn again at once
  const persist=()=>{ const dd=d(), R=wkRollup(dd, f, fw, onPlan);
    const W=dd.walk&&Array.isArray(dd.walk.floors)?dd.walk:{v:1, floors:[]}, floors=[...W.floors.filter(x=>x.name!==f.name), wkClone(fw)];
    const patch={walk:{...W, v:1, floors}, grid:{...(dd.grid||{}), results:R.results}, ...(dd.baseline&&!(j0.data||{}).baseline?{baseline:dd.baseline}:{})};
    j={...j, data:{...dd, ...patch}}; WK.cache[uk]=wkClone(fw);
    WK.next={patch, rev:fw.rev, floor:f.name, save:async p=>{ const nj=await save(p); return nj; }, say:t=>{ const x=$p("#wkSave"); if(x){ x.textContent=t; x.style.color=/^Not/.test(t)?"var(--bad)":""; } }}; wkPump();
    draw(); const u=$p("#wkUndo"); if(u) u.disabled=!undo().length; };
  // a point or tap added goes in the pass being walked (the acceptance pass leaves it unmarked, as before passes)
  const commit=mut=>{ (WK.undo[uk]||=[]).push(JSON.stringify(fw)); if(WK.undo[uk].length>80) WK.undo[uk].shift(); const seq0=fw.seq||0, c=cur(); mut(fw);
    if(c!==WK_PASS0) for(const x of [...(fw.pts||[]), ...(fw.wps||[])]) if(x.id>seq0&&!x.pass) x.pass=c;
    retestLands(c); fw.rev=(fw.rev||0)+1; persist(); };
  // the first reading in a pass that opened by itself: from here the retest is the test of record. The grid and the Report use it on every
  // floor, so a floor not walked yet reads untested and not last year's pass; the comparison with acceptance goes on; and if nobody saved
  // the acceptance results as the baseline, they're kept as it first. Acceptance's own points stay in the walk, unmarked, as they were
  function retestLands(c){ const dd=d(), p=wkPasses(dd).find(x=>x.id===c); if(!p||!p.auto||!(fw.pts||[]).some(x=>wkPassOf(x)===c&&(x.rs||[]).length)) return;
    const W=dd.walk, G=dd.grid||{}, named=wkPassName(dd, c), walked=(W.floors||[]).some(x=>wkPassView(x, WK_PASS0).pts.length);
    const W2={...W, passes:wkPasses(dd).map(x=>{ if(x.id!==c) return x; const {auto, ...y}=x; return y; }), graded:c, ...(walked?{compare:{a:WK_PASS0, b:c, sig:"ps|*", met:"dl"}}:{})};
    const base=!dd.baseline&&Object.keys(G.results||{}).length?{baseline:{date:dd.accepted_on||(dd.checks||{}).accepted_on||today(), results:{...G.results}, critical:{...(G.critical||{})}}}:{};
    let results=G.results||{};
    for(const fl of Array.isArray(dd.floors)?dd.floors:[]){ if(fl.name===f.name) continue; const w2=(W.floors||[]).find(x=>x.name===fl.name); if(w2) results=wkRollup({...dd, walk:W2, grid:{...G, results}}, fl, w2, !!fl.plan).results; }
    j={...j, data:{...dd, ...base, walk:W2, grid:{...G, results}}};
    $p("#wkRetestNote")?.remove(); const gs=$p("#wkGraded"); if(gs) gs.value=c;
    note(`Walk: ${named} opened itself when it came due. First reading in: the grid and the Report use it, compared with acceptance`);
    say(`${named}: the grid and the Report now use this pass, compared with acceptance.`); }
  const note=t=>post(`/api/das/jobs/${j.id}/note`, {text:t}).catch(e=>say("Not noted in the log: "+e.message));
  const remount=()=>wkMount(panel, j, save, ctx);

  // the plan's shape (height / width), measured once per plan; then the squares are checked against the walk
  const ready=()=>{ if(onPlan){ const a=img.naturalWidth?img.naturalHeight/img.naturalWidth:0; if(!a) return;
      if(fw.arFor!==f.plan||Math.abs((fw.ar||0)-a)>1e-6){ fw.ar=+a.toFixed(6); fw.arFor=f.plan; fw.rev=(fw.rev||0)+1; return persist(); } }
    const R=wkRollup(d(), f, fw, onPlan); if(wkSig(R.results, f)!==wkSig((d().grid||{}).results, f)){ fw.rev=(fw.rev||0)+1; return persist(); }
    draw(); };

  // what to show
  const placed=()=>wkPlaced(pv());
  const sigs=()=>wkSignals(placed());
  const pickSig=()=>{ const L=sigs(); if(!L.some(s=>s.key===U.sig)) U.sig=L[0]?.key||"";
    const kind=U.sig.startsWith("cell")?"cell":"ps"; if(!WK_METRICS[kind].some(([k])=>k===U.met)) U.met=WK_METRICS[kind][0][0];
    $p("#wkSig").innerHTML=L.length?L.map(s=>`<option value="${esc(s.key)}" ${s.key===U.sig?"selected":""}>${esc(s.label)}</option>`).join(""):'<option value="">nothing measured yet</option>';
    $p("#wkMet").innerHTML=WK_METRICS[kind].map(([k,l])=>`<option value="${k}" ${k===U.met?"selected":""}>${l}</option>`).join(""); };

  // the drawing: heat map, the grid's squares, the walk's line and taps, the points
  function draw(){ if(!svg.isConnected) return; const R=svg.getBoundingClientRect(), W=R.width, H=R.height; if(!W||!H) return;
    pickSig(); const P=placed(), on=P.filter(p=>p.x!=null), sig=U.sig, met=U.met, A=ar()||H/W;
    const vals=sig?on.map(p=>({p, v:wkVal(p, sig, met)})).filter(x=>x.v!=null):[], sc=sig?wkScale(d(), sig, met, vals.map(x=>x.v)):null;
    // heat
    const hm=wkHeat(vals.map(x=>({x:x.p.x, y:x.p.y, v:x.v})), W, H, U.zoom>1?220:160); cv.width=hm.cols; cv.height=hm.rows;
    const g=cv.getContext("2d"), im=g.createImageData(hm.cols, hm.rows);
    for(let k=0;k<hm.v.length;k++){ if(isNaN(hm.v[k])) continue; const c=wkRgb(hm.v[k], sc), o=k*4; im.data[o]=c[0]; im.data[o+1]=c[1]; im.data[o+2]=c[2]; im.data[o+3]=Math.round(235*Math.max(.25, hm.al[k])); }
    g.putImageData(im, 0, 0);
    // squares
    // the squares as the pass on screen leaves them: the grid itself for the pass it uses, else that pass's walk alone
    const gp=cur()===wkGraded(d()), dv=gp?d():{...d(), grid:{...(d().grid||{}), results:wkPassResults(d(), f, fw, onPlan, cur())}};
    const skip=new Set(f.skip||[]), crit=new Set(f.critical||[]), st=floorStats(dv, f), res=(dv.grid||{}).results||{};
    let s="";
    for(let q=1;q<=n;q++){ const c=(q-1)%cols, r=Math.floor((q-1)/cols), pts=[[c/cols,r/rows],[(c+1)/cols,r/rows],[(c+1)/cols,(r+1)/rows],[c/cols,(r+1)/rows]].map(([u,v])=>wkUV(u, v, f, A, onPlan));
      const p=wkSqState(dv, res[`${f.name}|${q}`], sig), mid=wkUV((c+.07)/cols, (r+.1)/rows, f, A, onPlan);  // the label in the square's corner: the centre is where you test
      s+=`<polygon points="${pts.map(t=>`${(t.x*W).toFixed(1)},${(t.y*H).toFixed(1)}`).join(" ")}" fill="none" stroke="${crit.has(q)?"#fab219":p===false?"#e5534b":p?"#2fa35f":"#111"}" stroke-opacity="${p==null&&!crit.has(q)?.35:.9}" stroke-width="${crit.has(q)||p!=null?2:1}" ${skip.has(q)?'stroke-dasharray="4 4"':""}/>`
        +`<text x="${(mid.x*W).toFixed(1)}" y="${(mid.y*H).toFixed(1)}" text-anchor="start" dominant-baseline="hanging" font-size="11" fill="#111" fill-opacity=".6" style="paint-order:stroke;stroke:#fff;stroke-width:3px;stroke-opacity:.6">${esc(f.name)}-${q}${crit.has(q)?" ★":""}</text>`; }
    // the walk's line and its taps
    for(const leg of wkLegs(pv().wps)){ if(leg.length>1) s+=`<polyline points="${leg.map(w=>`${(w.x*W).toFixed(1)},${(w.y*H).toFixed(1)}`).join(" ")}" fill="none" stroke="#1f6feb" stroke-width="2.5" stroke-dasharray="7 5" stroke-linecap="round"/>`;
      leg.forEach((w,i)=>{ const on2=sel&&sel.t==="wp"&&sel.id===w.id; s+=`<circle cx="${(w.x*W).toFixed(1)}" cy="${(w.y*H).toFixed(1)}" r="${on2?10:7}" fill="#fff" stroke="#1f6feb" stroke-width="${on2?4:2.5}"/><text x="${(w.x*W).toFixed(1)}" y="${(w.y*H+.5).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="700" fill="#1f6feb">${i+1}</text>`; }); }
    // points: dots by value against the requirement; an empty spot (waiting for its log) a ring
    for(const p of on){ const v=sig?wkVal(p, sig, met):null, rr=p.by==="time"?3.5:6.5, on2=sel&&sel.t==="pt"&&sel.id===p.id;
      const c=v==null?null:wkRgb(v, sc), ok=v==null?null:wkPass(v, sc);
      if(!(p.rs||[]).length) s+=`<circle cx="${(p.x*W).toFixed(1)}" cy="${(p.y*H).toFixed(1)}" r="7" fill="none" stroke="#8250df" stroke-width="2.5" stroke-dasharray="3 2"/>`;
      else s+=`<circle cx="${(p.x*W).toFixed(1)}" cy="${(p.y*H).toFixed(1)}" r="${on2?rr+3:rr}" fill="${c?`rgb(${c})`:"#8c959f"}" fill-opacity="${c?1:.5}" stroke="${on2?"#1f6feb":ok===false?"#5a0d0d":"#fff"}" stroke-width="${on2?3:p.by==="time"?1:2}"/>`; }
    if(spot) s+=`<circle cx="${(spot.x*W).toFixed(1)}" cy="${(spot.y*H).toFixed(1)}" r="11" fill="none" stroke="#1f6feb" stroke-width="3"/><circle cx="${(spot.x*W).toFixed(1)}" cy="${(spot.y*H).toFixed(1)}" r="2.5" fill="#1f6feb"/>`;
    if(drag&&drag.live) s+=`<circle cx="${(drag.live.x*W).toFixed(1)}" cy="${(drag.live.y*H).toFixed(1)}" r="9" fill="none" stroke="#1f6feb" stroke-width="3"/>`;
    svg.innerHTML=s;
    // legend
    const lg=$p("#wkLegend");
    if(!sig||!vals.length) lg.innerHTML=`<p class="hint" style="margin:0">${on.length?"Nothing measured for this choice yet.":"No readings on this floor yet."}</p>`;
    else { const lo=sc.thr!=null?sc.thr-sc.span:sc.lo, hi=sc.thr!=null?sc.thr+sc.span:sc.hi, steps=[0,.25,.5,.75,1].map(t=>wkRgb(lo+(hi-lo)*t, sc));
      const nPass=sc.thr!=null?vals.filter(x=>x.v>=sc.thr).length:null, label=WK_METRICS[sig.startsWith("cell")?"cell":"ps"].find(([k])=>k===met)?.[1]||met;
      lg.innerHTML=`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="mono">${num(lo,met==="daq"?1:0)}</span>
        <span style="flex:0 1 220px;min-width:120px;height:12px;border-radius:6px;background:linear-gradient(90deg,${steps.map(c=>`rgb(${c})`).join(",")})"></span><span class="mono">${num(hi,met==="daq"?1:0)}${esc(sc.unit)}</span>
        <span class="hint">${sc.thr!=null?`${esc(label)}: pass at ≥ ${num(sc.thr,met==="daq"?1:0)}${esc(sc.unit)}, from ${esc(sc.what)} · ${nPass} of ${vals.length} points pass (${dasPct(nPass, vals.length)}%)`
          :`${esc(label)}: no requirement set for it, so colours run from the lowest to the highest reading`}</span></div>`; }
    // the score: the walk, and the grid as the walk leaves it
    const tapped=on.filter(p=>p.by!=="time").length, timed=on.filter(p=>p.by==="time").length, out=P.filter(p=>p.x==null).length, wait=on.filter(p=>!(p.rs||[]).length).length;
    const sqW=new Set(Object.keys(res).filter(k=>k.startsWith(`${f.name}|`)&&readingsOf(res[k]).some(x=>x.walk))).size;
    const nw=pv().wps.length;
    $p("#wkScore").innerHTML=`<b>${P.length.toLocaleString()}</b> point${P.length===1?"":"s"} on this floor${wkPasses(d()).length>1||cur()!==WK_PASS0?` in ${esc(wkPassName(d(), cur()))}`:""} (${tapped} tapped, ${timed.toLocaleString()} placed by time${out?`, <b>${out.toLocaleString()}</b> outside the walk's times: not placed`:""}${wait?`, ${wait} spot${wait===1?"":"s"} waiting for a log`:""}) · ${nw} walk tap${nw===1?"":"s"} · ${sqW} of ${n-skip.size} squares get walk readings.
      ${gp?"":`<b>The grid and the Report use ${esc(wkPassName(d(), wkGraded(d())))}</b>; the squares here are this pass's own. `}Grid${gp?"":` (${esc(wkPassName(d(), cur()))})`}, judged by ${esc(st.rule)}: ${st.genPass}/${st.gen} general${st.crit?`, ${st.critPass}/${st.crit} critical`:""} pass${st.untested?`, ${st.untested} untested`:""}${st.notCounted?`, ${st.notCounted} not counted (no calibrated instrument)`:""} · <b>${st.untested?"not complete":st.ok?"pass":"fail"}</b>.`+(sig.startsWith("cell")?(()=>{ const [,c,l]=sig.split("|"), cf=cellFloor(d(), f, `${c}|${l}`), P2=cellProfile(d());
        return ` ${esc(c)}, ${esc(LAYER_NAME[l])}: ${cf.pass}/${cf.tested} squares at target (${cf.pct}%, ${esc(P2.name)} asks ${P2.pct}%)${cf.untested?`, ${cf.untested} with no cellular reading`:""}.`; })():"")+wkPhoneLine(P);
  }

  // a tap on the plan
  const at=e=>{ const R=svg.getBoundingClientRect(); return {x:Math.max(0,Math.min(1,(e.clientX-R.left)/R.width)), y:Math.max(0,Math.min(1,(e.clientY-R.top)/R.height)), W:R.width, H:R.height}; };
  const hit=(x, y, W, H)=>{ let best=null;
    for(const p of placed()) if(p.x!=null){ const dd=Math.hypot((p.x-x)*W, (p.y-y)*H); if(dd<18&&(!best||dd<best.dd)) best={t:"pt", id:p.id, dd}; }
    for(const w of pv().wps){ const dd=Math.hypot((w.x-x)*W, (w.y-y)*H); if(dd<18&&(!best||dd<=best.dd)) best={t:"wp", id:w.id, dd}; }
    return best; };
  const tap=(x, y, W, H)=>{
    if(U.mode==="edit"){ const h=hit(x, y, W, H); sel=h?{t:h.t, id:h.id}:null; spot=null; draw(); return editForm(); }
    if(U.mode==="cont"){ if(!U.walking){ say("Press Start walk first, then tap where you are."); return; }
      const t=new Date().toISOString(); commit(w=>{ (w.wps||=[]).push({id:++w.seq, x:+x.toFixed(4), y:+y.toFixed(4), t, leg:U.leg}); });
      const g=wkSquare(x, y, f, ar(), onPlan); say(`Tap ${(fw.wps||[]).filter(w=>w.leg===U.leg).length} at ${wkClock(Date.parse(t))}${g?`, square ${f.name}-${g}`:", outside the grid"}.`); return; }
    if(WK.compass) return compassAt(x, y);
    if(U.vals==="calib"&&phone) return calAt(x, y);
    if(U.vals==="phone"&&phone){ const s=wkPhoneCall("read"); if(s.error){ say(s.message||"The phone's signal couldn't be read."); return; }
      const rs=calFix(wkPhoneReadings(s)); if(!rs.length){ say("The phone reports no LTE or 5G serving cell with a signal right now: no reading taken."); return; }
      const t=new Date().toISOString(), g=wkSquare(x, y, f, ar(), onPlan), age=+s.age_ms>15000?` (Android's newest reading is ${Math.round(s.age_ms/1000)} s old)`:"";
      commit(w=>{ w.pts.push({id:++w.seq, by:"tap", x:+x.toFixed(4), y:+y.toFixed(4), t, rs, inst:"uncal", src:WK_PHONE_SRC}); });
      say(`${WK_PHONE_SRC} at ${wkClock(Date.parse(t))}${g?`, square ${f.name}-${g}`:", outside the grid"}: ${rs.map(wkPhoneTxt).join("; ")}${age}. Cellular, indicative only${rs.some(r=>r.cor)?", corrected by this phone's table":""}.`); return; }
    if(!ctx.inst){ say("Pick what's taking the readings first: Taken with, above the plan."); return; }
    if(U.vals==="log"){ const t=new Date().toISOString(); commit(w=>{ w.pts.push({id:++w.seq, by:"tap", x:+x.toFixed(4), y:+y.toFixed(4), t, rs:[], inst:ctx.inst}); });
      say(`Spot ${pv().pts.length} marked at ${wkClock(Date.parse(t))}: it takes the logged reading nearest that time when you import the log.`); return; }
    spot={x:+x.toFixed(4), y:+y.toFixed(4)}; spotPid=null; sel=null; draw(); entryForm(); };
  svg.onpointerdown=e=>{ const p=at(e); drag={x0:e.clientX, y0:e.clientY, id:e.pointerId, moved:false};
    if(U.mode==="edit"){ const h=hit(p.x, p.y, p.W, p.H), it=h&&(h.t==="wp"?(fw.wps||[]).find(w=>w.id===h.id):fw.pts.find(q=>q.id===h.id));
      if(it&&(h.t==="wp"||it.by!=="time")){ drag.item=h; svg.setPointerCapture(e.pointerId); e.preventDefault(); } } };
  svg.onpointermove=e=>{ if(!drag||drag.id!==e.pointerId) return; if(Math.hypot(e.clientX-drag.x0, e.clientY-drag.y0)>8) drag.moved=true;
    if(drag.item&&drag.moved){ const p=at(e); drag.live={x:p.x, y:p.y}; draw(); } };
  svg.onpointerup=e=>{ if(!drag||drag.id!==e.pointerId) return; const dr=drag; drag=null; const p=at(e);
    if(dr.item&&dr.moved){ const {t, id}=dr.item; commit(w=>{ const it=t==="wp"?(w.wps||[]).find(x=>x.id===id):w.pts.find(x=>x.id===id); if(it){ it.x=+p.x.toFixed(4); it.y=+p.y.toFixed(4); } });
      sel={t, id}; editForm(); return; }
    if(!dr.moved) tap(p.x, p.y, p.W, p.H); };
  svg.onpointercancel=()=>{ drag=null; draw(); };

  // typing a reading at a spot (or adding one to a point)
  const KS={ps:[["freq","Channel / MHz","text"],["dl","DL dBm",1],["daq","DL DAQ",.1],["sinr","SINR dB",.1],["ber","BER %",.01],["ul","UL dBm",1],["ul_daq","UL DAQ",.1]],
    cell:[["carrier","Carrier","carrier"],["tech","Technology","tech"],["band","Band","text"],["pci","PCI","text"],["freq","EARFCN","text"],["rsrp","RSRP dBm",1],["rsrq","RSRQ dB",.5],["sinr","SINR dB",.5]]};
  const fieldsHtml=kind=>KS[kind].map(([k,l,s])=>{ const last=U.last[kind]||{};
    if(s==="carrier") return `<label>${l}<select id="wf_${k}">${CELL_CARRIERS.map(c=>`<option ${last.carrier===c?"selected":""}>${esc(c)}</option>`).join("")}</select></label>`;
    if(s==="tech") return `<label>${l}<select id="wf_${k}">${["LTE","NR"].map(c=>`<option value="${c}" ${last.tech===c?"selected":""}>${c==="NR"?"5G NR":c}</option>`).join("")}</select></label>`;
    if(s==="text") return `<label>${l}<input id="wf_${k}" value="${esc(last[k]??"")}" style="width:96px"></label>`;
    return `<label>${l}<input id="wf_${k}" type="number" step="${s}" inputmode="decimal" style="width:76px"></label>`; }).join("");
  const readForm=kind=>{ const r={}; for(const [k,,s] of KS[kind]){ const el=$p(`#wf_${k}`); if(!el) continue; const v=el.value.trim(); if(v==="") continue; r[k]=typeof s==="number"?+v:v; }
    const ok=kind==="ps"?(has(r.dl)||has(r.daq)||has(r.sinr)):has(r.rsrp);
    if(ok) U.last[kind]=kind==="ps"?{freq:r.freq}:{carrier:r.carrier, tech:r.tech, band:r.band, freq:r.freq, pci:r.pci};
    return ok?r:null; };
  const kindSeg=()=>`<div class="seg" id="wfKind">${[["ps","Public safety"],["cell","Cellular"]].map(([k,l])=>`<button data-k="${k}" class="${U.kind===k?"on":""}">${l}</button>`).join("")}</div>`;
  function entryForm(){ const box=$p("#wkForm"), g=wkSquare(spot.x, spot.y, f, ar(), onPlan);
    box.innerHTML=`<div class="panel" style="margin-top:8px"><div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:8px"><b>New spot${g?` in square ${esc(f.name)}-${g}`:" outside the grid"}</b>${kindSeg()}</div>
      <div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:8px;margin-top:6px">${fieldsHtml(U.kind)}<label class="grow">Note<input id="wf_note"></label></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px"><button class="primary" id="wfSave">Save</button><button id="wfMore" title="Save this reading and add another channel at the same spot">Save, add another channel here</button><button id="wfNo">Cancel</button>
        <label class="inl">Or a COMPASS report taken here <input type="file" id="wfCompass" accept=".csv,.txt"></label></div>
      <p class="hint" style="margin:4px 0 0">Saved as taken with ${esc(instName2(ctx.inst))}. ${U.kind==="cell"?"Cellular readings are kept and mapped, never scored against the public-safety rules.":"A square passes only when every channel passes."}</p></div>`;
    box.querySelector("#wfKind").onclick=e=>{ const b=e.target.closest("[data-k]"); if(b){ U.kind=b.dataset.k; entryForm(); } };
    const put=more=>{ const r=readForm(U.kind); if(!r){ say(U.kind==="ps"?"Enter a DL dBm, a DAQ or a SINR.":"Enter the RSRP."); return; }
      const nt=$p("#wf_note").value.trim(); if(nt) r.note=nt; if(U.kind==="cell") r.carrier=carrierName(r.carrier);
      commit(w=>{ let p=spotPid!=null&&w.pts.find(x=>x.id===spotPid);
        if(!p){ p={id:++w.seq, by:"tap", x:spot.x, y:spot.y, t:new Date().toISOString(), rs:[], inst:ctx.inst, src:"typed"}; w.pts.push(p); spotPid=p.id; }
        p.rs=[...p.rs.filter(x=>chKey(x)!==chKey(r)), r]; });
      if(more){ entryForm(); say("Reading kept. Enter the next channel at this spot."); return; }
      spot=null; box.innerHTML=""; draw(); say(`Reading kept${g?` in square ${f.name}-${g}`:" (outside the grid)"}.`); $p("#wkScroll").scrollIntoView({block:"nearest", behavior:"smooth"}); };
    box.querySelector("#wfSave").onclick=()=>put(false);
    box.querySelector("#wfMore").onclick=()=>{ put(true); };
    box.querySelector("#wfNo").onclick=()=>{ spot=null; box.innerHTML=""; draw(); };
    box.querySelector("#wfCompass").onchange=async e=>{ const file=e.target.files[0]; if(!file) return; const t=await parse(file); if(!t) return;
      if(t.format!=="compass"){ say("That isn't a COMPASS Full Signal Report: use Import a log for other files."); return; }
      WK.compass={t, fname:file.name}; compassAt(spot.x, spot.y); };
    const first=box.querySelector(U.kind==="ps"?"#wf_dl":"#wf_rsrp"); first?.focus({preventScroll:true});
    box.querySelectorAll("input").forEach(i=>i.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); put(false); } })); box.scrollIntoView({block:"nearest", behavior:"smooth"}); }
  // a COMPASS Full Signal Report is one spot: every cell it heard becomes a cellular reading there
  function compassAt(x, y){ const {t, fname}=WK.compass; WK.compass=null; const m=t.guess||{};
    if(!ctx.inst){ say("Pick what's taking the readings first: Taken with, above the plan."); return; }
    const rs=t.rows.map(row=>wkRow(row, {carrier:m.carrier, tech:m.tech, band:m.band, pci:m.pci, freq:m.freq, mhz:m.mhz, rsrp:m.rsrp, rsrq:m.rsrq, sinr:m.sinr})).filter(r=>has(r.rsrp)||has(r.rsrq));
    if(!rs.length){ say(`${fname} has no cells with RSRP.`); return; }
    for(const r of rs) if(!r.tech) r.tech="LTE";
    const tm=m.time?wkTime(t.rows[0][m.time]):NaN;
    commit(w=>{ w.pts.push({id:++w.seq, by:"tap", x:+x.toFixed(4), y:+y.toFixed(4), t:new Date(isFinite(tm)?tm:Date.now()).toISOString(), rs, inst:ctx.inst, src:fname}); });
    spot=null; $p("#wkForm").innerHTML=""; draw(); say(`${rs.length} cells from ${fname} saved at this spot.`); note(`Walk, floor ${f.name}: a COMPASS report (${fname}, ${rs.length} cells) placed on the plan`); }

  // Edit: a point's readings, time and place; a walk tap's time
  function editForm(){ const box=$p("#wkForm"); if(!sel){ box.innerHTML=""; return; }
    if(sel.t==="wp"){ const w=(fw.wps||[]).find(x=>x.id===sel.id); if(!w){ sel=null; box.innerHTML=""; return; }
      const leg=wkLegs(fw.wps).find(a=>a.some(x=>x.id===w.id))||[], i=leg.findIndex(x=>x.id===w.id);
      box.innerHTML=`<div class="panel" style="margin-top:8px"><div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:8px"><b>Walk ${w.leg+1}, tap ${i+1} of ${leg.length}</b>
        <label>Time<input id="weT" type="datetime-local" step="1" value="${wkLocalTime(Date.parse(w.t))}"></label>
        <button id="weDel">Delete this tap</button><button id="weNo">Close</button></div>
        <p class="hint" style="margin:4px 0 0">Drag it to where you really were; the readings logged around its time move with it.</p></div>`;
      box.querySelector("#weT").onchange=e=>{ const ms=new Date(e.target.value).getTime(); if(!isFinite(ms)) return; commit(x=>{ const it=(x.wps||[]).find(y=>y.id===w.id); if(it) it.t=new Date(ms).toISOString(); }); editForm(); };
      box.querySelector("#weDel").onclick=()=>{ commit(x=>{ x.wps=(x.wps||[]).filter(y=>y.id!==w.id); }); sel=null; editForm(); draw(); };
      box.querySelector("#weNo").onclick=()=>{ sel=null; editForm(); draw(); };
      return; }
    const p=fw.pts.find(x=>x.id===sel.id); if(!p){ sel=null; box.innerHTML=""; return; }
    const pl=placed().find(x=>x.id===p.id)||p, g=pl.x!=null?wkSquare(pl.x, pl.y, f, ar(), onPlan):null;
    const cellTxt=x=>[x.carrier, x.tech, has(x.band)?`band ${x.band}`:"", has(x.pci)?`PCI ${x.pci}`:"", has(x.freq)?`ch ${x.freq}`:"", has(x.rsrp)?`RSRP ${x.rsrp}`:"", has(x.rsrq)?`RSRQ ${x.rsrq}`:"", has(x.sinr)?`SINR ${x.sinr}`:""].filter(Boolean).join(" · ");
    const psTxt=x=>[has(x.freq)?x.freq:"", has(x.dl)?`${x.dl} dBm`:"", has(x.daq)?`DAQ ${x.daq}`:"", has(x.sinr)?`SINR ${x.sinr}`:"", has(x.ber)?`BER ${x.ber}%`:"", has(x.ul)?`UL ${x.ul} dBm`:"", has(x.ul_daq)?`UL DAQ ${x.ul_daq}`:""].filter(Boolean).join(" · ");
    box.innerHTML=`<div class="panel" style="margin-top:8px"><div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:8px"><b>Point ${p.id}${g?` · square ${esc(f.name)}-${g}`:" · outside the grid"}</b>
        <span class="hint">${p.by==="time"?"placed by its time on the walk":p.by==="xy"?"placed by the log's plan position":"tapped"} · ${esc(wkClock(Date.parse(p.t)))} · ${esc(p.src||"")} · taken with ${esc(instName2(p.inst)||"not recorded")}</span></div>
      ${(p.rs||[]).length?`<div class="tw" style="margin-top:6px"><table><tbody>${p.rs.map((x,i)=>`<tr><td>${isCell(x)?"Cellular":"Public safety"}</td><td>${esc(isCell(x)?cellTxt(x):psTxt(x))}</td><td>${isCell(x)?'<span class="hint">not scored</span>':""}</td><td><button data-rx="${i}">Delete</button></td></tr>`).join("")}</tbody></table></div>`:'<p class="hint" style="margin:6px 0 0">No reading yet: import the log to fill it, or type one below.</p>'}
      ${p.by!=="time"?`<div class="row" style="align-items:flex-end;flex-wrap:wrap;gap:8px;margin-top:6px">${kindSeg()}${fieldsHtml(U.kind)}<button id="peAdd">Add reading</button></div>`:""}
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">${p.by!=="time"?`<label>Time<input id="peT" type="datetime-local" step="1" value="${wkLocalTime(Date.parse(p.t))}"></label>`:""}<button id="peDel">Delete this point</button><button id="peNo">Close</button></div>
      ${p.by==="time"?'<p class="hint" style="margin:4px 0 0">Its place comes from its time between two walk taps: drag those to move it.</p>':""}</div>`;
    box.querySelectorAll("[data-rx]").forEach(b=>b.onclick=()=>{ commit(w=>{ const it=w.pts.find(x=>x.id===p.id); if(it) it.rs=it.rs.filter((_,i)=>i!==+b.dataset.rx); }); editForm(); });
    box.querySelector("#wfKind")?.addEventListener("click", e=>{ const b=e.target.closest("[data-k]"); if(b){ U.kind=b.dataset.k; editForm(); } });
    box.querySelector("#peAdd")?.addEventListener("click", ()=>{ const r=readForm(U.kind); if(!r){ say(U.kind==="ps"?"Enter a DL dBm, a DAQ or a SINR.":"Enter the RSRP."); return; }
      if(U.kind==="cell") r.carrier=carrierName(r.carrier);
      commit(w=>{ const it=w.pts.find(x=>x.id===p.id); if(it){ it.rs=[...(it.rs||[]).filter(x=>chKey(x)!==chKey(r)), r]; if(!it.inst) it.inst=ctx.inst; } }); editForm(); });
    box.querySelector("#peT")?.addEventListener("change", e=>{ const ms=new Date(e.target.value).getTime(); if(isFinite(ms)) commit(w=>{ const it=w.pts.find(x=>x.id===p.id); if(it) it.t=new Date(ms).toISOString(); }); });
    box.querySelector("#peDel").onclick=()=>{ commit(w=>{ w.pts=w.pts.filter(x=>x.id!==p.id); }); sel=null; editForm(); draw(); };
    box.querySelector("#peNo").onclick=()=>{ sel=null; editForm(); draw(); }; }

  // a log: read by the server (das.py read_table: CSV, TSV / G-NetTrack .txt, Excel, JSON), columns checked here
  const parse=async file=>{ try{ return await api(`/api/das/parse?name=${encodeURIComponent(file.name)}`, {method:"POST", body:await file.arrayBuffer()}); }
    catch(e){ say("Couldn't read that file: "+e.message); return null; } };
  $p("#wkImp").onchange=async e=>{ const file=e.target.files[0]; e.target.value=""; if(!file) return; const t=await parse(file); if(!t) return;
    if(t.format==="compass"){ WK.compass={t, fname:file.name}; if(U.mode!=="point"){ U.mode="point"; remount(); }
      $p("#wkImpBox").innerHTML=""; say(`A COMPASS report is one spot: tap where ${file.name} was taken.`); return; }
    importBox(t, file.name); };
  function importBox(t, fname){ const box=$p("#wkImpBox"), sn=wkSniff(t.headers, t.guess), m=sn.map;
    const opts=h=>`<option value="">—</option>${t.headers.map(x=>`<option ${x===h?"selected":""}>${esc(x)}</option>`).join("")}`;
    const walkMs=pv().wps.map(w=>Date.parse(w.t)).filter(isFinite).concat(pv().pts.filter(p=>p.by==="tap").map(p=>Date.parse(p.t)).filter(isFinite));
    box.innerHTML=`<div class="panel" style="margin-top:8px"><h3>Import ${esc(fname)} <span class="hint">· ${esc(sn.name)}, ${t.total.toLocaleString()} rows${t.total>t.rows.length?` (the first ${t.rows.length.toLocaleString()} are read)`:""} · check the columns, then import</span></h3>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">${WK_FIELDS.map(([k,l])=>`<label>${l}<select data-wf="${k}">${opts(m[k])}</select></label>`).join("")}</div>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:6px">
        <label title="Seconds to add to the log's times when its clock and this device's differ">Clock offset<input id="wiOff" type="number" step="1" value="0" style="width:80px"> s</label>
        <label>A tapped spot takes a reading within<input id="wiWin" type="number" min="1" step="1" value="5" style="width:64px"> s</label>
        <label>Taken with<select id="wiInst">${ctx.instOpts?ctx.instOpts(sn.phone?"uncal":ctx.inst||"uncal", false):'<option value="uncal">Not calibrated</option>'}</select></label>
        <button class="primary" id="wiGo">Import</button><button id="wiNo">Cancel</button></div>
      <p class="hint" id="wiPrev" style="margin:6px 0"></p>
      <div class="tw" style="max-height:200px"><table><thead><tr>${t.headers.slice(0,24).map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.slice(0,8).map(r=>`<tr>${t.headers.slice(0,24).map(h=>`<td>${esc(r[h]??"")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="hint" style="margin:6px 0 0">${sn.lteOnly?"G-NetTrack's Level, Qual and SNR are read as RSRP, RSRQ and SINR on LTE and 5G rows; 2G / 3G rows are left out. ":""}A phone app has no calibration: its readings are mapped and kept as cellular survey data, never scored for public safety.</p></div>`;
    box.scrollIntoView({behavior:"smooth", block:"nearest"});
    const cur=()=>{ const mm={}; box.querySelectorAll("[data-wf]").forEach(s=>{ if(s.value) mm[s.dataset.wf]=s.value; }); return mm; };
    const prev=()=>{ const mm=cur(), off=(+$p("#wiOff").value||0)*1000, base=walkMs[0]??Date.now();
      const ts=mm.time?t.rows.map(r=>wkTime(r[mm.time], base)+off).filter(isFinite):[];
      const lo=ts.length?Math.min(...ts):NaN, hi=ts.length?Math.max(...ts):NaN, wl=walkMs.length?Math.min(...walkMs):NaN, wh=walkMs.length?Math.max(...walkMs):NaN;
      $p("#wiPrev").innerHTML=!mm.time&&!(mm.x&&mm.y)?'<span style="color:var(--bad)">Pick the time column: readings are placed by their time.</span>'
        :`${ts.length?`The log runs ${esc(new Date(lo).toLocaleDateString())} ${esc(wkClock(lo))} to ${esc(wkClock(hi))}`:mm.time?'<span style="color:var(--bad)">No time in that column could be read.</span>':"No time column: placed by the plan position."}${walkMs.length?` · this floor's walk runs ${esc(new Date(wl).toLocaleDateString())} ${esc(wkClock(wl))} to ${esc(wkClock(wh))}${ts.length&&(hi<wl-6e4||lo>wh+6e4)?' · <b style="color:var(--bad)">they don\'t overlap: check the clock offset (or the floor)</b>':""}`:" · this floor has no walk yet: walk it first (Continuous, Start walk) or tap the spots (Point, Values from a log)"}.`; };
    box.querySelectorAll("select[data-wf], #wiOff").forEach(x=>x.addEventListener("change", prev)); prev();
    box.querySelector("#wiNo").onclick=()=>{ box.innerHTML=""; };
    box.querySelector("#wiGo").onclick=()=>{ const mm=cur(); if(!mm.time&&!(mm.x&&mm.y)){ prev(); return; }
      const inst=$p("#wiInst").value||"uncal";
      const o=wkFromLog(pv(), t.rows, mm, {offset:(+$p("#wiOff").value||0)*1000, win:Math.max(1,+$p("#wiWin").value||5)*1000, inst, src:fname, lteOnly:sn.lteOnly});
      const pl=placeLog(o, fname); if(!pl.ok){ say(pl.msg); return; }
      box.innerHTML=""; say(pl.msg); note(`Walk, floor ${f.name}: ${pl.msg} Taken with ${inst==="uncal"?"no calibrated instrument":inst.replace("|"," ")}.`); }; }
  // a log's readings (wkFromLog) onto this floor: an imported file, or the phone's own readings when a walk stops
  function placeLog(o, fname){
      const room=WK_MAX-fw.pts.length, add=o.pts.filter(p=>!p.fill), fills=o.pts.filter(p=>p.fill), keep=add.slice(0, Math.max(0, room));
      if(!keep.length&&!fills.length) return {ok:false, msg:`Nothing placed from ${fname}: ${[o.outside?`${o.outside.toLocaleString()} rows outside this floor's walk times`:"", o.noTime?`${o.noTime.toLocaleString()} with no readable time`:"", o.noValue?`${o.noValue.toLocaleString()} with no reading`:"", o.other?`${o.other.toLocaleString()} 2G / 3G rows`:""].filter(Boolean).join(", ")||"no rows"}.`};
      commit(w=>{ for(const p of fills){ const it=w.pts.find(x=>x.id===p.id); if(it){ it.rs=p.rs; it.inst=p.inst; it.src=p.src; } }
        for(const p of keep) w.pts.push({id:++w.seq, ...p}); });
      const walked=pv().wps.length>0, head=[o.placed+o.xy?`${(o.placed+o.xy).toLocaleString()} readings from ${fname} placed`:"", o.filled?`${o.filled} tapped spot${o.filled===1?"":"s"} filled from ${fname}`:""].filter(Boolean).join(", ");
      return {ok:true, msg:`${head}${o.outside?`; ${o.outside.toLocaleString()} rows ${!walked?"not used (no walk on this floor to place them on)":fname===WK_PHONE_SRC?"logged before your first tap or after your last: not placed":"outside this floor's walk times (another floor? import it there too)"}`:""}${o.noTime?`; ${o.noTime.toLocaleString()} with no readable time`:""}${o.other?`; ${o.other.toLocaleString()} 2G / 3G rows left out`:""}${add.length>keep.length?`; ${(add.length-keep.length).toLocaleString()} over the ${WK_MAX.toLocaleString()} points a floor holds, left out`:""}.`}; }
  // the phone's logged readings (Start walk to Stop) onto this floor, exactly as an imported log: placed by time between taps
  const phoneDrain=()=>{ wkPhoneCall("stop"); const snaps=wkPhoneCall("drain"), rows=wkPhoneRows(Array.isArray(snaps)?snaps:[]);
    if(!rows.length) return {ok:false, msg:`${WK_PHONE_SRC}: no readings were logged (Android gave none: check Location is on and allowed for RF Recon).`};
    const o=wkFromLog(pv(), rows, WK_PHONE_MAP, {offset:0, win:5000, inst:"uncal", src:WK_PHONE_SRC, lteOnly:false});
    for(const p of o.pts) p.rs=calFix(p.rs||[]);
    const pl=placeLog(o, WK_PHONE_SRC);
    if(pl.ok) note(`Walk, floor ${f.name}: ${pl.msg} Cellular, not calibrated (indicative).`); return pl; };


  // Phone vs instrument: the phone reads its serving cells; the instrument's reading of each is typed beside it. Each pair
  // goes into the phone's table; the instrument's reading is also kept here as a spot of its own (it's a calibrated reading).
  function calAt(x, y){ const s=wkPhoneCall("read"); if(s.error){ say(s.message||"The phone's signal couldn't be read."); return; }
    const rs=wkPhoneReadings(s).filter(r=>has(r.rsrp)), box=$p("#wkForm");
    if(!rs.length){ say("The phone reports no LTE or 5G serving cell with an RSRP right now: nothing to compare."); return; }
    const good=insts.filter(i=>instState(i).ok);
    if(!good.length){ say("Comparing needs a calibrated instrument: add it on the Overview (model | serial | calibration date), with a calibration that's current."); return; }
    const t=new Date().toISOString(), g=wkSquare(x, y, f, ar(), onPlan), pick=good.find(i=>instKey(i)===U.calInst)||good[0];
    spot={x:+x.toFixed(4), y:+y.toFixed(4)}; draw();
    box.innerHTML=`<div class="panel" style="margin-top:8px"><b>Phone vs instrument${g?` in square ${esc(f.name)}-${g}`:""}</b>
      <p class="hint" style="margin:2px 0 6px">Read the same cell on the instrument (same carrier and band, the PCI if it shows one), held beside the phone.
        Each pair teaches RF Recon how far this phone (${esc(calModel)}) reads off on that band.</p>
      <label class="inl">Instrument <select id="wcInst">${good.map(i=>`<option value="${esc(instKey(i))}" ${i===pick?"selected":""}>${esc(instName(i))}</option>`).join("")}</select></label>
      ${rs.map((r, i)=>`<div class="row" style="align-items:flex-end;gap:8px;margin-top:6px;flex-wrap:wrap"><span style="flex:1 1 220px">${esc(wkPhoneTxt(r))}</span>
        <label>Instrument RSRP dBm<input id="wc_${i}" type="number" step="0.5" inputmode="decimal" style="width:90px"></label></div>`).join("")}
      <div class="row" style="gap:8px;margin-top:8px"><button class="primary" id="wcSave">Save the pair${rs.length>1?"s":""}</button><button id="wcNo">Cancel</button></div></div>`;
    const done=()=>{ spot=null; box.innerHTML=""; draw(); };
    box.querySelector("#wcNo").onclick=done;
    box.querySelector("#wcSave").onclick=()=>{ const inst=box.querySelector("#wcInst").value; U.calInst=inst;
      const got=rs.map((r, i)=>({r, ref:wkNum(box.querySelector(`#wc_${i}`).value)})).filter(z=>z.ref!=null);
      if(!got.length){ say("Enter what the instrument reads for at least one cell."); return; }
      const bad=got.find(z=>z.ref>-20||z.ref<-150); if(bad){ say(`${bad.ref} dBm isn't an RSRP an instrument reads (−150 to −20 dBm).`); return; }
      const ps=got.map(({r, ref})=>({t, model:calModel, tech:r.tech, band:r.band??"", carrier:r.carrier, pci:r.pci??"", phone:r.rsrp, ref, inst}));
      wkCalKeep(ps);
      commit(w=>{ (w.cal||=[]).push(...ps);
        w.pts.push({id:++w.seq, by:"tap", x:spot.x, y:spot.y, t, inst, src:"typed (beside the phone)",
          rs:got.map(({r, ref})=>{ const o={carrier:r.carrier, tech:r.tech, rsrp:ref, note:"read beside the phone"}; for(const k of ["band","pci","freq"]) if(has(r[k])) o[k]=r[k]; return o; })}); });
      done(); const ft=wkCalFit(calPairs());
      say(`Kept: ${ps.map(p=>{ const b=ft.bands[wkCalKey(p)]; return `${wkCalLabel(wkCalKey(p))}: phone ${p.phone}, instrument ${p.ref} dBm (this phone ${wkCalSays(b)} over ${b.n} pair${b.n===1?"":"s"})`; }).join("; ")}.`);
      note(`Walk, floor ${f.name}: phone ${calModel} compared with ${instName(insts.find(i=>instKey(i)===inst)||{model:inst})} at ${ps.length} cell${ps.length===1?"":"s"}`);
      calPanel(); };
    box.querySelector("#wc_0")?.focus({preventScroll:true}); box.scrollIntoView({block:"nearest", behavior:"smooth"}); }
  // the phone's correction table: what it reads off by on each band, how sure, and whether it's applied
  // On the phone: its own model's table first (its local pairs and the job's), then the job's other phone models, read-only.
  // On a device that can't read a phone (a desktop): every phone model the job holds pairs for, one labelled table each,
  // read-only (correcting readings happens on the phone of that model).
  function calPanel(){ const el=$p("#wkCal"); if(!el) return; const hasPhone=fw.pts.some(p=>p.src===WK_PHONE_SRC);
    const jobPairs=[...(((d().walk||{}).floors)||[]).filter(x=>x.name!==f.name).flatMap(x=>x.cal||[]), ...(fw.cal||[])];
    const own=phone?calPairs():[], groups=wkCalModels(jobPairs, phone?calModel:null).filter(g=>!phone||(g.model!==calModel&&g.model!==WK_CAL_NONAME));
    if(!phone&&!groups.length&&!hasPhone){ el.innerHTML=""; return; }
    const left=fw.pts.filter(p=>p.src===WK_PHONE_SRC&&(p.rs||[]).some(r=>has(r.rsrp)&&!has(r.rsrp_raw))).length;
    const Q={good:"good", rough:"rough: more pairs, or strong and weak spots", "too few":"too few: needs 3 pairs"};
    const row=(k, x)=>`<tr><td><b>${esc(wkCalLabel(k))}</b></td><td>${esc(wkCalSays(x))}<div class="hint">${x.sd==null?"one pair: no spread yet":`±${x.sd} dB a reading`}</div></td>
      <td>${x.n} pair${x.n===1?"":"s"}<div class="hint">${x.lo} to ${x.hi} dBm</div><div class="hint" style="color:${x.q==="good"?"#1a7f37":"#9a6700"}">${esc(Q[x.q])}</div></td></tr>`;
    const table=(ps, who)=>{ const ft=wkCalFit(ps), rows=Object.entries(ft.bands).sort(([a],[b])=>a.localeCompare(b, undefined, {numeric:true}));
      return rows.length?`<div class="tw"><table data-calmodel="${esc(who)}"><thead><tr><th>Band</th><th>${esc(who)}</th><th>Pairs and levels</th></tr></thead><tbody>
        ${rows.map(([k, x])=>row(k, x)).join("")}${rows.length>1&&ft.all?row("all bands", ft.all):""}</tbody></table></div>`:""; };
    const ownT=phone?table(own, "This phone"):"";
    el.innerHTML=`<div class="panel" style="margin-top:8px"><h3 style="margin:0 0 4px">Phone correction <span class="hint">· ${phone?`${esc(calModel)}, `:""}against a calibrated instrument</span></h3>
      ${phone?(ownT||`<p class="hint" style="margin:0">No pairs yet for this phone. Point › <b>Phone vs instrument</b>: at 5 or more spots, strong and weak signal, read this phone and a calibrated instrument side by side.</p>`):""}
      ${groups.map(g=>`<h4 style="margin:8px 0 4px">${esc(g.model)} <span class="hint">· ${g.pairs.length} pair${g.pairs.length===1?"":"s"} in this job${phone?"; shown only: its readings are corrected on that phone":""}</span></h4>${table(g.pairs, g.model)}`).join("")}
      ${!phone&&!groups.length?'<p class="hint" style="margin:0">No pairs in this job yet. Pairs are taken in the RF Recon Android app (Help › Android app).</p>':""}
      ${phone?`<div class="row" style="gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px"><label class="inl"><input type="checkbox" id="wcOn" ${calOn()?"checked":""}> Correct this phone's readings as they're taken</label>
        ${left&&ownT?`<button id="wcFix">Correct this floor's ${left} earlier phone reading${left===1?"":"s"}</button>`:""}</div>`
        :'<p class="hint" style="margin:6px 0 0">Read-only here: a phone\'s readings are corrected in the RF Recon Android app on that model of phone.</p>'}
      <p class="hint" style="margin:6px 0 0">A band with 3 or more pairs uses its own offset; any other band uses every band's once there are 5 pairs. A corrected reading keeps what the phone read and the offset used.
        It's still not calibrated: closer to the truth and shown in the cellular view, never counted toward pass / fail. The table stays on the phone for the next job, and the pairs are kept with this walk.</p></div>`;
    el.querySelector("#wcOn")?.addEventListener("change", e=>{ U.cor=e.target.checked; calPanel(); });
    el.querySelector("#wcFix")?.addEventListener("click", ()=>{ const ft2=wkCalFit(calPairs()); let k=0;
      commit(w=>{ for(const p of w.pts) if(p.src===WK_PHONE_SRC) p.rs=(p.rs||[]).map(r=>{ const c=wkCalApply(r, ft2); if(c!==r) k++; return c; }); });
      draw(); say(`${k} phone reading${k===1?"":"s"} corrected by this phone's table.`); note(`Walk, floor ${f.name}: ${k} phone readings corrected (${calModel})`); calPanel(); }); }

  // the toolbar
  $p("#wkMode").onclick=e=>{ const b=e.target.closest("[data-wm]"); if(!b) return; if(U.walking&&b.dataset.wm!=="cont"){ say("Stop the walk first."); return; } U.mode=b.dataset.wm; sel=null; remount(); };
  $p("#wkVals")?.addEventListener("click", e=>{ const b=e.target.closest("[data-wv]"); if(b){ U.vals=b.dataset.wv; remount(); } });
  $p("#wkGo")?.addEventListener("click", ()=>{
    if(U.walking){ U.walking=false; const k=(fw.wps||[]).filter(w=>w.leg===U.leg).length; note(`Walk, floor ${f.name}: walked with ${k} taps, ${wkClock(U.t0)} to ${wkClock(Date.now())}`);
      const pd=phone?phoneDrain():null; remount(); say(`Walk stopped: ${k} tap${k===1?"":"s"}. ${pd?pd.msg:"Import the log to place its readings."}`); return; }
    let ph=null; if(phone){ wkPhoneCall("stop"); wkPhoneCall("drain"); ph=wkPhoneCall("start", 2000); }  // a fresh log for this walk
    U.walking=true; U.leg=Math.max(-1, ...(fw.wps||[]).map(w=>w.leg??0))+1; U.t0=Date.now(); U.floor=f.name; remount();
    say(`Walking: tap where you are now, then at each turn and every few steps.${ph?ph.error?` The phone isn't logging: ${ph.message}`:" The phone is logging its own signal (cellular, indicative).":""}`); });
  // the phone still logging with no walk on this page (the page was reloaded mid-walk): its readings go on this floor's taps by time
  if(phone&&!U.walking&&U.mode==="cont"&&wkPhoneCall("logging")===true){ const pd=phoneDrain(); say(`The phone was still logging from a walk this page lost track of. ${pd.msg}`); }
  if(U.mode==="cont"&&U.walking){ const tick=()=>{ const c=$p("#wkClock"); if(!c||!c.isConnected||!U.walking) return clearInterval(iv); const s=Math.floor((Date.now()-U.t0)/1000);
      c.textContent=`${Math.floor(s/60)}:${String(s%60).padStart(2,"0")} · ${(fw.wps||[]).filter(w=>w.leg===U.leg).length} taps`; }; const iv=setInterval(tick, 1000); tick(); }
  const doUndo=()=>{ const st=undo(); if(!st.length) return; const rev=fw.rev||0; fw=JSON.parse(st.pop()); fw.rev=rev+1; sel=null; spot=null; $p("#wkForm").innerHTML=""; persist(); say("Undone."); };
  $p("#wkUndo").onclick=doUndo;
  calPanel();
  const onKey=e=>{ if(!panel.isConnected||!svg.isConnected) return document.removeEventListener("keydown", onKey);
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==="z"&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName||"")){ e.preventDefault(); doUndo(); } };
  document.removeEventListener("keydown", WK.onKey||(()=>{})); WK.onKey=onKey; document.addEventListener("keydown", onKey);
  $p("#wkZoom").onclick=e=>{ const b=e.target.closest("[data-z]"); if(!b) return; const Z=[1,1.5,2,3,4], i=Z.indexOf(U.zoom);
    U.zoom=Z[Math.max(0, Math.min(Z.length-1, (i<0?0:i)+ +b.dataset.z))]; const sc=$p("#wkScroll"), w=$p("#wkWrap");
    sc.style.overflow=U.zoom>1?"auto":"hidden"; sc.style.maxHeight=U.zoom>1?"75vh":""; w.style.width=`${U.zoom*100}%`; };
  $p("#wkSig").onchange=e=>{ U.sig=e.target.value; U.met=""; draw(); if(U.cmp) cmpPanel(); };
  $p("#wkMet").onchange=e=>{ U.met=e.target.value; draw(); if(U.cmp) cmpPanel(); };
  // test passes: walk one, pick the one the grid uses, compare any two
  const setWalk=(patch, msg)=>{ const W=d().walk&&Array.isArray(d().walk.floors)?d().walk:{v:1, floors:[]}; j={...j, data:{...d(), walk:{...W, v:1, ...patch}}};
    fw.rev=(fw.rev||0)+1; persist(); remount(); if(msg) say(msg); };
  $p("#wkPass").onchange=e=>{ if(U.walking){ e.target.value=cur(); say("Stop the walk first."); return; } setWalk({cur:e.target.value}, `Walking ${wkPassName(d(), e.target.value)}: taps and imports go in it.`); };
  $p("#wkNewPass").onclick=()=>{ if(U.walking){ say("Stop the walk first."); return; } const kind=$p("#wkNewKind").value, yr=+$p("#wkNewYear").value||new Date().getFullYear(), id=wkPassId(kind, yr);
    const L=wkPasses(d()), had=L.some(p=>p.id===id), passes=had?L:[...L, {id, kind, ...(id!==kind?{year:yr}:{}), made:today()}];
    const rec=["acceptance","annual","five_year"].includes(kind), nm=wkPassName({walk:{passes}}, id);
    setWalk({passes, cur:id, ...(rec?{graded:id}:{})}, `${had?"Back on":"New pass:"} ${nm}. Taps and imports go in it${rec?`; the grid and the Report use it (a test of record)`:`; the grid and the Report stay on ${wkPassName(d(), wkGraded(d()))}`}.`);
    note(`Walk: ${had?"switched to":"new test pass"} ${nm}`); };
  $p("#wkGraded").onchange=e=>setWalk({graded:e.target.value}, `The grid and the Report now use ${wkPassName(d(), e.target.value)}.`);
  $p("#wkCmpGo")?.addEventListener("click", ()=>{ if(U.cmp){ U.cmp=null; $p("#wkCmp").innerHTML=""; return; }
    const ids=wkPasses(d()).map(p=>p.id).filter(id=>wkPassView(fw, id).pts.length), b=cur(), a=ids.find(x=>x===WK_PASS0&&x!==b)||ids.find(x=>x!==b)||WK_PASS0;
    U.cmp={a, b}; cmpPanel(); $p("#wkCmp").scrollIntoView({block:"nearest", behavior:"smooth"}); });
  async function cmpPanel(){ const box=$p("#wkCmp"); if(!box||!U.cmp) return; const L=wkPasses(d()), {a, b}=U.cmp, sig=U.sig||"ps|*", met=U.met||"dl", W=d().walk||{};
    const on=W.compare&&W.compare.a===a&&W.compare.b===b&&W.compare.sig===sig&&W.compare.met===met;
    const opt=v=>L.map(p=>`<option value="${esc(p.id)}" ${p.id===v?"selected":""}>${esc(wkPassName(d(), p.id))} · ${wkPassView(fw, p.id).pts.length} pts</option>`).join("");
    box.innerHTML=`<div class="panel" style="margin-top:8px"><h3 style="margin:0 0 4px">Compare two passes <span class="hint">· floor ${esc(f.name)}, ${esc((sigs().find(s=>s.key===sig)||{}).label||sig)}, the metric shown above</span></h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end"><label class="inl">Then <select id="wcA">${opt(a)}</select></label><label class="inl">Now <select id="wcB">${opt(b)}</select></label>
        <label class="inl"><input type="checkbox" id="wcRep" ${on?"checked":""}> Put this comparison on the Report</label><button id="wcNo2">Close</button></div>
      <div id="wcOut" style="margin-top:8px"><p class="hint">Drawing the difference…</p></div></div>`;
    box.querySelector("#wcA").onchange=e=>{ U.cmp.a=e.target.value; cmpPanel(); };
    box.querySelector("#wcB").onchange=e=>{ U.cmp.b=e.target.value; cmpPanel(); };
    box.querySelector("#wcNo2").onclick=()=>{ U.cmp=null; box.innerHTML=""; };
    box.querySelector("#wcRep").onchange=e=>setWalk({compare:e.target.checked?{a, b, sig, met}:null}, e.target.checked?"The Report shows this comparison.":"The Report no longer shows a comparison.");
    if(a===b){ box.querySelector("#wcOut").innerHTML='<p class="hint">Pick two different passes.</p>'; return; }
    const p=await wkDeltaPicture(j, d(), f, fw, a, b, sig, met, onPlan?img:null); if(!box.isConnected||!p) return;
    box.querySelector("#wcOut").innerHTML=`<img src="${p.url}" alt="${esc(p.caption)}" style="width:100%;border:1px solid var(--line);border-radius:8px;display:block">${wkClarkLine(p.C)}<div class="tw">${wkCmpTable(d(), f, p.C, met)}</div>`; }
  if(U.cmp) cmpPanel();
  $p("#wkRule").onchange=e=>{ const v=e.target.value; commit(w=>{ w.rule=v; }); say(`Each square now takes ${WK_RULE_SHORT[v]} reading of its points.`); };
  $p("#wkClear").onclick=()=>{ const V=pv(), c=cur(), nm=wkPasses(d()).length>1||c!==WK_PASS0?` ${wkPassName(d(), c)}`:""; if(!V.pts.length&&!V.wps.length) return;
    if(!confirm(`Clear floor ${f.name}'s${nm} walk (${V.pts.length} points, ${V.wps.length} taps)? Undo brings it back.`)) return;
    commit(w=>{ w.pts=w.pts.filter(p=>wkPassOf(p)!==c); w.wps=(w.wps||[]).filter(x=>wkPassOf(x)!==c); }); note(`Walk, floor ${f.name}:${nm} cleared`); };
  $p("#wkCsv").onclick=()=>dasDl(`${fileSafe(j.name)} walk floor ${fileSafe(f.name)}.csv`, csvOf(wkCsvRows(d(), f, fw, onPlan)), "text/csv");
  const pic=async()=>{ if(!U.sig){ say("Nothing measured to map yet."); return null; } return wkPicture(j, d(), f, pv(), U.sig, U.met, onPlan?img:null, wkPasses(d()).length>1?wkPassName(d(), cur()):""); };
  $p("#wkPng").onclick=async()=>{ const p=await pic(); if(!p) return; const a=document.createElement("a"); a.href=p.url; a.download=`${fileSafe(j.name)} walk floor ${fileSafe(f.name)} ${fileSafe(p.short)}.png`; document.body.appendChild(a); a.click(); a.remove(); };
  $p("#wkFile").onclick=async()=>{ const p=await pic(); if(!p) return; const name=`${fileSafe(j.name)} walk floor ${fileSafe(f.name)} ${fileSafe(p.short)}.png`;
    try{ const blob=await (await fetch(p.url)).blob(); await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(name)}`, {method:"POST", body:await blob.arrayBuffer()}); say(`Saved to the job's Files as ${name}.`); }
    catch(e){ say("Not saved to Files: "+e.message); } };
  new ResizeObserver(()=>draw()).observe(svg);
  if(img){ if(img.complete&&img.naturalWidth) ready(); else img.addEventListener("load", ready, {once:true}); } else ready();
  window.__wk={get fw(){ return fw; }, get j(){ return j; }, pv, draw, f, onPlan};  // for the UI sweep
}

// the points as a table: one row per reading (an empty spot and each walk tap get a row too)
function wkCsvRows(d, f, fw, onPlan){ const ar=wkAr(f, fw, onPlan), wft=((((d.design||{}).floors||{})[f.name])||{}).width_ft||null, out=[];
  const base=p=>{ const g=p.x!=null&&ar?wkSquare(p.x, p.y, f, ar, onPlan):null;
    return {floor:f.name, point:p.id, placed:p.by==="time"?(p.x==null?"not placed (outside the walk's times)":"by time"):p.by==="xy"?"by the log's plan position":"tapped",
      square:g?`${f.name}-${g}`:"", x:p.x==null?"":(+p.x).toFixed(4), y:p.y==null?"":(+p.y).toFixed(4), x_ft:wft&&p.x!=null?Math.round(p.x*wft):"", y_ft:wft&&p.x!=null&&ar?Math.round(p.y*ar*wft):"", time:p.t||"", pass:wkPassName(d, wkPassOf(p))}; };  // pass last: the columns before it stay where they were
  for(const p of wkPlaced(fw)){ const b=base(p), insT=k=>k==="uncal"?"not calibrated":k?k.replace("|"," "):"";
    if(!(p.rs||[]).length){ out.push({...b, kind:"spot, no reading yet", instrument:insT(p.inst)}); continue; }
    for(const r of p.rs){ const cal=calOf(d, {...r, inst:p.inst, time:p.t}), ps=!isCell(r), pass=ps?gridPass(r):null;
      out.push({...b, kind:ps?"public safety":"cellular", instrument:cal?cal.name:insT(p.inst), counted:ps?(cal?(cal.ok?"yes":`no: ${cal.why}`):""):"cellular, not scored",
        result:ps?(pass==null?"":pass?"pass":"fail"):"", channel:r.freq??"", technology:r.tech??"", carrier:r.carrier??"", band:r.band??"", pci:r.pci??"",
        dl_dbm:r.dl??"", dl_daq:r.daq??"", sinr_db:r.sinr??"", ber_pct:r.ber??"", ul_dbm:r.ul??"", ul_daq:r.ul_daq??"", rsrp_dbm:r.rsrp??"", rsrq_db:r.rsrq??"", source:p.src||"", note:r.note||""}); } }
  for(const leg of wkLegs(fw.wps)) leg.forEach((w,i)=>{ const g=ar?wkSquare(w.x, w.y, f, ar, onPlan):null;
    out.push({floor:f.name, point:`walk ${(w.leg??0)+1} tap ${i+1}`, placed:"walk tap", square:g?`${f.name}-${g}`:"", x:(+w.x).toFixed(4), y:(+w.y).toFixed(4), x_ft:wft?Math.round(w.x*wft):"", y_ft:wft&&ar?Math.round(w.y*ar*wft):"", time:w.t, pass:wkPassName(d, wkPassOf(w)), kind:"walk tap"}); });
  return out; }

// the heat map as a picture: plan, heat, squares, the walk, points, a title and the scale (for the Report and Files)
async function wkPicture(j, d, f, fw, sig, met, planImg, passLabel){
  const onPlan=!!f.plan, ar=wkAr(f, fw, onPlan)||.75;
  let im=planImg&&planImg.naturalWidth?planImg:null;
  if(!im&&onPlan){ const src=await jobFileSrc(j.id, f.plan); if(src) im=await new Promise(ok=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>ok(null); i.src=src; }); }
  const W=im?Math.min(1600, im.naturalWidth):1200, H=Math.round(W*(im?im.naturalHeight/im.naturalWidth:ar)), top=76, foot=46;
  const c=document.createElement("canvas"); c.width=W; c.height=H+top+foot; const g=c.getContext("2d");
  g.fillStyle="#fff"; g.fillRect(0, 0, c.width, c.height); if(im) g.drawImage(im, 0, top, W, H);
  const on=wkPlaced(fw).filter(p=>p.x!=null), vals=on.map(p=>({p, v:wkVal(p, sig, met)})).filter(x=>x.v!=null), sc=wkScale(d, sig, met, vals.map(x=>x.v));
  const hm=wkHeat(vals.map(x=>({x:x.p.x, y:x.p.y, v:x.v})), W, H, 220), hc=document.createElement("canvas"); hc.width=hm.cols; hc.height=hm.rows;
  const hg=hc.getContext("2d"), id=hg.createImageData(hm.cols, hm.rows);
  for(let k=0;k<hm.v.length;k++){ if(isNaN(hm.v[k])) continue; const col=wkRgb(hm.v[k], sc), o=k*4; id.data[o]=col[0]; id.data[o+1]=col[1]; id.data[o+2]=col[2]; id.data[o+3]=Math.round(150*Math.max(.25, hm.al[k])); }
  hg.putImageData(id, 0, 0); g.imageSmoothingEnabled=true; g.drawImage(hc, 0, top, W, H);
  const n=f.grids||DAS.grids, cols=dasCols(f), rows=wkRows(f), crit=new Set(f.critical||[]), res=(d.grid||{}).results||{}, s=W/900;
  const P=(u,v)=>{ const q=wkUV(u, v, f, ar, onPlan); return [q.x*W, top+q.y*H]; };
  for(let q=1;q<=n;q++){ const cc=(q-1)%cols, r=Math.floor((q-1)/cols), p=wkSqState(d, res[`${f.name}|${q}`], sig);
    g.beginPath(); [[cc,r],[cc+1,r],[cc+1,r+1],[cc,r+1]].forEach(([u,v],i)=>{ const [x,y]=P(u/cols, v/rows); i?g.lineTo(x,y):g.moveTo(x,y); }); g.closePath();
    g.strokeStyle=crit.has(q)?"#b8860b":p===false?"#c62828":p?"#1a7f37":"rgba(0,0,0,.35)"; g.lineWidth=(crit.has(q)||p!=null?2.5:1)*s; g.stroke();
    const [mx,my]=P((cc+.07)/cols, (r+.1)/rows); g.font=`${Math.round(12*s)}px sans-serif`; g.textAlign="left"; g.textBaseline="top"; g.lineWidth=3*s; g.strokeStyle="rgba(255,255,255,.8)";
    const lab=`${f.name}-${q}${crit.has(q)?" ★":""}`; g.strokeText(lab, mx, my); g.fillStyle="rgba(0,0,0,.6)"; g.fillText(lab, mx, my); }
  g.setLineDash([7*s, 5*s]); g.strokeStyle="#1f6feb"; g.lineWidth=2.5*s;
  for(const leg of wkLegs(fw.wps)) if(leg.length>1){ g.beginPath(); leg.forEach((w,i)=>i?g.lineTo(w.x*W, top+w.y*H):g.moveTo(w.x*W, top+w.y*H)); g.stroke(); }
  g.setLineDash([]);
  for(const {p, v} of vals){ const col=wkRgb(v, sc); g.beginPath(); g.arc(p.x*W, top+p.y*H, (p.by==="time"?3.5:6.5)*s, 0, 2*Math.PI); g.fillStyle=`rgb(${col})`; g.fill(); g.lineWidth=(p.by==="time"?1:2)*s; g.strokeStyle=wkPass(v, sc)===false?"#5a0d0d":"#fff"; g.stroke(); }
  const kind=sig.startsWith("cell")?"cell":"ps", label=WK_METRICS[kind].find(([k])=>k===met)?.[1]||met, what=(wkSignals(on).find(x=>x.key===sig)||{}).label||sig;
  const nPass=sc.thr!=null?vals.filter(x=>x.v>=sc.thr).length:null, dig=met==="daq"?1:0;
  g.fillStyle="#111"; g.textAlign="left"; g.textBaseline="alphabetic"; g.font=`bold ${Math.round(17*Math.max(1,s))}px sans-serif`;
  g.fillText(`${j.name} · floor ${f.name}${passLabel?` · ${passLabel}`:""} · ${what} · ${label}`, 12, 24);
  g.font=`${Math.round(13*Math.max(1,s))}px sans-serif`; g.fillStyle="#444";
  const cap=`${vals.length} points${sc.thr!=null?`, ${nPass} at or above ${num(sc.thr,dig)}${sc.unit} (${dasPct(nPass, vals.length)}%), from ${sc.what}`:", no requirement set for this metric"} · drawn ${today()} · the grid squares decide pass / fail`;
  { const words=cap.split(" "); let line="", y=46; for(const w of words){ const t=line?line+" "+w:w; if(g.measureText(t).width>W-24&&line){ g.fillText(line, 12, y); line=w; y+=17*Math.max(1,s); } else line=t; } g.fillText(line, 12, y); }
  const lo=sc.thr!=null?sc.thr-sc.span:sc.lo, hi=sc.thr!=null?sc.thr+sc.span:sc.hi, bx=12, by=top+H+14, bw=Math.min(360, W/2.5);
  for(let k=0;k<bw;k++){ g.fillStyle=`rgb(${wkRgb(lo+(hi-lo)*k/bw, sc)})`; g.fillRect(bx+k, by, 1, 14); }
  g.fillStyle="#111"; g.font=`${Math.round(12*Math.max(1,s))}px sans-serif`; g.fillText(`${num(lo,dig)}`, bx, by+30); g.textAlign="right"; g.fillText(`${num(hi,dig)}${sc.unit}`, bx+bw, by+30);
  g.textAlign="left"; g.fillText(sc.thr!=null?`pass at ≥ ${num(sc.thr,dig)}${sc.unit}`:"lowest to highest reading", bx+bw+14, by+12);
  return {url:c.toDataURL("image/png"), short:`${what.replace(/\s*\(.*\)$/,"")} ${label}`.replace(/[,]/g,""), caption:`Floor ${f.name}${passLabel?` · ${passLabel}`:""} · ${what} · ${label} · ${cap}`}; }

/* ---------- test passes on the page: the bar above the plan, and the comparison below it ---------- */
// the retest opens itself (retest.py): while the server says it's open and nothing saved holds it, it's the pass being walked. It's only
// this page's copy until the first reading lands: a job nobody walks hasn't changed, and the acceptance report's seal still reads unchanged
function wkRetestOpen(j){ const o=(j.standing||{}).retest, d=j.data||{}; if(!o||!o.open||wkPasses(d).some(p=>p.id===o.id)) return j;
  const W=d.walk&&Array.isArray(d.walk.floors)?d.walk:{v:1, floors:[]};
  return {...j, data:{...d, walk:{...W, v:1, passes:[...wkPasses(d), {id:o.id, kind:o.kind, year:o.year, made:today(), auto:1}], cur:o.id}}}; }
function wkRetestNote(d){ const c=wkCur(d), p=wkPasses(d).find(x=>x.id===c); if(!p||!p.auto) return "";
  return `<p class="hint" id="wkRetestNote" style="margin:0 0 6px">${esc(wkPassName(d, c))} opened by itself: it's due. The grid and the Report stay on ${esc(wkPassName(d, wkGraded(d)))} until the first reading lands here, then they use this pass and compare it with acceptance. Acceptance stays as it is.</p>`; }
function wkPassBar(d, fw){ const L=wkPasses(d), c=wkCur(d), gr=wkGraded(d), n=id=>wkPassView(fw, id).pts.length, y=new Date().getFullYear();
  return `<div class="maptools no-print wk-pass" id="wkPassBar" style="gap:8px;flex-wrap:wrap;margin-bottom:6px;align-items:flex-end">
    <label class="inl">Test pass <select id="wkPass">${L.map(p=>`<option value="${esc(p.id)}" ${p.id===c?"selected":""}>${esc(wkPassName(d, p.id))} · ${n(p.id)} pt${n(p.id)===1?"":"s"} here</option>`).join("")}</select></label>
    <span class="row" style="gap:4px;align-items:flex-end"><label class="inl">New pass <select id="wkNewKind">${WK_PASS_KINDS.map(([k,l])=>`<option value="${k}">${l}</option>`).join("")}</select></label>
      <input id="wkNewYear" type="number" value="${y}" min="2000" max="2100" aria-label="Year (annual and five-year)" style="width:78px"><button id="wkNewPass">+ Add</button></span>
    <label class="inl">The grid and Report use <select id="wkGraded">${L.map(p=>`<option value="${esc(p.id)}" ${p.id===gr?"selected":""}>${esc(wkPassName(d, p.id))}</option>`).join("")}</select></label>
    ${L.length>1?`<button id="wkCmpGo">Compare two passes</button>`:""}</div>`; }
// the difference picture (for the page and the Report): plan, B − A heat, each square's change, the scale
async function wkDeltaPicture(j, d, f, fw, a, b, sig, met, planImg){
  const onPlan=!!f.plan, ar=wkAr(f, fw, onPlan)||.75, C=wkCompare(d, f, fw, onPlan, a, b, sig, met); if(!C) return null;
  let im=planImg&&planImg.naturalWidth?planImg:null;
  if(!im&&onPlan){ const src=await jobFileSrc(j.id, f.plan); if(src) im=await new Promise(ok=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>ok(null); i.src=src; }); }
  const W=im?Math.min(1400, im.naturalWidth):1100, H=Math.round(W*(im?im.naturalHeight/im.naturalWidth:ar)), top=60, foot=46, s=W/900;
  const c=document.createElement("canvas"); c.width=W; c.height=H+top+foot; const g=c.getContext("2d");
  g.fillStyle="#fff"; g.fillRect(0, 0, c.width, c.height); if(im){ g.globalAlpha=.55; g.drawImage(im, 0, top, W, H); g.globalAlpha=1; }
  const pts=id=>wkPlaced(wkPassView(fw, id)).filter(p=>p.x!=null).map(p=>({x:p.x, y:p.y, v:wkVal(p, sig, met)})).filter(p=>p.v!=null);
  const hm=wkDiffHeat(pts(a), pts(b), W, H, 200), span=wkDiffSpan(met), hc=document.createElement("canvas"); hc.width=hm.cols; hc.height=hm.rows;
  const hg=hc.getContext("2d"), id=hg.createImageData(hm.cols, hm.rows);
  for(let k=0;k<hm.v.length;k++){ if(isNaN(hm.v[k])) continue; const col=wkDiffRgb(hm.v[k], span), o=k*4; id.data[o]=col[0]; id.data[o+1]=col[1]; id.data[o+2]=col[2]; id.data[o+3]=Math.round(200*Math.max(.3, hm.al[k])); }
  hg.putImageData(id, 0, 0); g.imageSmoothingEnabled=true; g.drawImage(hc, 0, top, W, H);
  const cols=dasCols(f), rows=wkRows(f), P=(u,v)=>{ const q=wkUV(u, v, f, ar, onPlan); return [q.x*W, top+q.y*H]; }, unit=met==="daq"?"":" dB";
  for(const q of C.squares){ const cc=(q.g-1)%cols, r=Math.floor((q.g-1)/cols);
    g.beginPath(); [[cc,r],[cc+1,r],[cc+1,r+1],[cc,r+1]].forEach(([u,v],i)=>{ const [x,y]=P(u/cols, v/rows); i?g.lineTo(x,y):g.moveTo(x,y); }); g.closePath();
    g.strokeStyle=q.pa===true&&q.pb===false?"#cf222e":"rgba(0,0,0,.35)"; g.lineWidth=(q.pa===true&&q.pb===false?3:1)*s; g.stroke();
    const [mx,my]=P((cc+.5)/cols, (r+.5)/rows), lab=q.d==null?`${f.name}-${q.g}`:`${q.d>0?"+":""}${num(q.d, met==="daq"?1:0)}${unit}`;
    g.font=`${Math.round((q.d==null?11:15)*s)}px sans-serif`; g.textAlign="center"; g.textBaseline="middle"; g.lineWidth=3*s; g.strokeStyle="rgba(255,255,255,.85)"; g.strokeText(lab, mx, my); g.fillStyle=q.d==null?"rgba(0,0,0,.45)":"#111"; g.fillText(lab, mx, my); }
  const kind=sig.startsWith("cell")?"cell":"ps", ml=WK_METRICS[kind].find(([k])=>k===met)?.[1]||met;
  g.textAlign="left"; g.textBaseline="alphabetic"; g.fillStyle="#111"; g.font=`bold ${Math.round(17*Math.max(1,s))}px sans-serif`;
  g.fillText(`${j.name} · floor ${f.name} · ${wkPassName(d, b)} minus ${wkPassName(d, a)} · ${ml}`, 12, 24);
  g.font=`${Math.round(13*Math.max(1,s))}px sans-serif`; g.fillStyle="#444";
  g.fillText(`${C.mean!=null?`mean change ${C.mean>0?"+":""}${C.mean}${unit} over ${C.squares.filter(x=>x.d!=null).length} squares · ${C.worse} worse, ${C.better} better · `:""}${C.clark.txt} · drawn ${today()}`, 12, 46);
  const bx=12, by=top+H+14, bw=Math.min(360, W/2.5);
  for(let k=0;k<bw;k++){ g.fillStyle=`rgb(${wkDiffRgb(-span+2*span*k/bw, span)})`; g.fillRect(bx+k, by, 1, 14); }
  g.fillStyle="#111"; g.font=`${Math.round(12*Math.max(1,s))}px sans-serif`; g.fillText(`−${span}${unit} worse`, bx, by+30); g.textAlign="right"; g.fillText(`+${span}${unit} better`, bx+bw, by+30);
  g.textAlign="left"; g.fillText("a red outline: passed before, fails now", bx+bw+14, by+12);
  return {url:c.toDataURL("image/png"), C, caption:`Floor ${f.name} · ${wkPassName(d, b)} minus ${wkPassName(d, a)} · ${ml} · ${C.clark.txt}`}; }
// the comparison's table: each square in both passes
function wkCmpTable(d, f, C, met){ const u=met==="daq"?"":met==="dl"||met==="ul"||met==="rsrp"?" dBm":" dB", r=v=>v==null?"–":`${num(v, met==="daq"?1:0)}${u}`, ps=v=>v==null?"untested":v?"pass":"fail";
  return `<table><thead><tr><th>Square</th><th class="n">${esc(wkPassName(d, C.a.id))}</th><th class="n">${esc(wkPassName(d, C.b.id))}</th><th class="n">Change</th><th>Result then → now</th></tr></thead><tbody>
    ${C.squares.map(q=>`<tr><td>${esc(f.name)}-${q.g}</td><td class="n">${r(q.a)}</td><td class="n">${r(q.b)}</td><td class="n" style="color:${q.d==null?"inherit":q.d<0?"var(--bad,#cf222e)":"inherit"}">${q.d==null?"":`${q.d>0?"+":""}${num(q.d, met==="daq"?1:0)}`}</td><td>${ps(q.pa)} → ${ps(q.pb)}${q.pa===true&&q.pb===false?" <b>(now fails)</b>":""}</td></tr>`).join("")}</tbody></table>`; }
const wkClarkLine = C => `<p style="margin:6px 0"><b style="color:${C.clark.state==="fail"?"var(--bad,#cf222e)":C.clark.state==="warn"?"var(--warn,#9a6700)":"inherit"}">${C.clark.state==="fail"?"Outside":C.clark.state==="warn"?"Outside (better)":C.clark.state==="ok"?"Within":"Not yet"} Clark County's 5%:</b> ${esc(C.clark.txt)} (${C.a.pts} and ${C.b.pts} points). <span class="hint">${esc(WK_CLARK.says)} (<a href="${WK_CLARK.src}" target="_blank" rel="noopener">FPAN Guide, Dec 2025</a>). Coverage: the tested squares that pass, public safety, by the job's AHJ profile.</span></p>`;

// the Report: each walked floor's heat map, public safety first, then each required carrier (four a floor at most), from the
// pass the grid uses; then the test passes, and the comparison picked on the Walk page
window.dasWalkReport = async (box, j) => { const d=j.data||{}, W=d.walk; if(!box||!W||!Array.isArray(W.floors)) return;
  const P=cellProfile(d), items=[], gr=wkGraded(d), many=wkPasses(d).length>1, gl=many?wkPassName(d, gr):"";
  for(const f of (Array.isArray(d.floors)?d.floors:[])){ const fw0=W.floors.find(x=>x.name===f.name); if(!fw0) continue; const fw=wkPassView(fw0, gr);
    const on=wkPlaced(fw).filter(p=>p.x!=null&&(p.rs||[]).length); if(!on.length) continue; const L=wkSignals(on), pick=[];
    if(L.some(s=>s.key==="ps|*")) pick.push(["ps|*", DASJ.threshold!=null?"dl":"daq"]);
    for(const s of L.filter(s=>s.kind==="cell"&&s.key.split("|").length===3)) if(pick.length<4&&cellRequired(P, s.key.split("|")[1])) pick.push([s.key, "rsrp"]);
    for(const [sig, met] of pick) items.push({f, fw, sig, met}); }
  const cmp=W.compare&&W.compare.a&&W.compare.b?W.compare:null;
  if(!items.length&&!many) return;
  const passRows=wkPasses(d).map(p=>{ const fl=(d.floors||[]).map(f=>{ const fw0=W.floors.find(x=>x.name===f.name); if(!fw0) return null; const n=wkPassView(fw0, p.id).pts.length; if(!n) return null;
      const s=floorStats({...d, grid:{...(d.grid||{}), results:wkPassResults(d, f, fw0, !!f.plan, p.id)}}, f); return `${f.name}: ${s.tested?`${dasPct(s.pass, s.tested)}% of ${s.tested}`:"no scored squares"}`; }).filter(Boolean);
    const n=W.floors.reduce((a,fw)=>a+wkPassView(fw, p.id).pts.length, 0); return {p, n, fl}; }).filter(x=>x.n||x.p.id===gr);
  box.innerHTML=`<div style="break-before:page;margin-top:16px"><h3>Walk test heat maps${gl?`: ${esc(gl)}`:""}</h3><p class="hint">Readings walked on each floor's plan, coloured against the requirement. The heat map shows every reading, calibrated or not; the grid squares above decide pass / fail.</p><div data-wk="imgs"><p class="hint">Drawing the heat maps…</p></div>
    ${many?`<h3>Test passes</h3><table><thead><tr><th>Pass</th><th class="n">Points</th><th>Squares passing, by floor (public safety, scored)</th><th></th></tr></thead><tbody>${passRows.map(x=>`<tr><td>${esc(wkPassName(d, x.p.id))}</td><td class="n">${x.n}</td><td>${esc(x.fl.join(" · ")||"–")}</td><td>${x.p.id===gr?"the grid above":""}</td></tr>`).join("")}</tbody></table>`:""}
    ${cmp?`<h3>${esc(wkPassName(d, cmp.b))} compared with ${esc(wkPassName(d, cmp.a))}</h3><div data-wk="cmp"><p class="hint">Drawing the comparison…</p></div>`:""}</div>`;
  const out=[];
  for(const it of items){ let p=null; try{ p=await wkPicture(j, d, it.f, it.fw, it.sig, it.met, null, gl); }catch(e){ out.push(`<p class="hint">Floor ${esc(it.f.name)}: the heat map couldn't be drawn (${esc(e.message)}).</p>`); continue; }
    if(!box.isConnected) return;
    out.push(`<figure style="margin:10px 0;break-inside:avoid"><img src="${p.url}" alt="${esc(p.caption)}" style="width:100%;max-width:760px;border:1px solid #999;display:block"><figcaption class="hint" style="margin-top:4px">${esc(p.caption)}</figcaption></figure>`); }
  const at=box.querySelector('[data-wk="imgs"]'); if(at) at.innerHTML=out.join("")||'<p class="hint">No readings in this pass.</p>';
  if(!cmp) return; const co=[];
  for(const f of (d.floors||[])){ const fw0=W.floors.find(x=>x.name===f.name); if(!fw0||!wkPassView(fw0, cmp.a).pts.length||!wkPassView(fw0, cmp.b).pts.length) continue;
    try{ const p=await wkDeltaPicture(j, d, f, fw0, cmp.a, cmp.b, cmp.sig||"ps|*", cmp.met||"dl", null); if(!p) continue; if(!box.isConnected) return;
      co.push(`<figure style="margin:10px 0;break-inside:avoid"><img src="${p.url}" alt="${esc(p.caption)}" style="width:100%;max-width:760px;border:1px solid #999;display:block"><figcaption class="hint" style="margin-top:4px">${esc(p.caption)}</figcaption></figure>${wkClarkLine(p.C)}${wkCmpTable(d, f, p.C, cmp.met||"dl")}`); }
    catch(e){ co.push(`<p class="hint">Floor ${esc(f.name)}: the comparison couldn't be drawn (${esc(e.message)}).</p>`); } }
  const ac=box.querySelector('[data-wk="cmp"]'); if(ac) ac.innerHTML=co.join("")||'<p class="hint">No floor has both passes walked.</p>'; };
// the walk's placed points on a floor plan, for the Design's predicted-vs-measured check (dasdesign.js): plan fractions
// x / y and each reading's channel and public safety downlink (dBm), from the pass the grid and Report use (the
// graded pass: BDA-off or old annual passes would skew the fit). Floors with no plan have no plan positions: none.
window.wkPointsFor = (j, name) => { const f=((j.data||{}).floors||[]).find(x=>x.name===name); if(!f||!f.plan) return [];
  return wkPlaced(wkPassView(wkFloorOf(j, name), wkGraded(j.data||{}))).filter(p=>p.x!=null&&p.y!=null).map(p=>({id:p.id, x:+p.x, y:+p.y, t:p.t||null, inst:p.inst||"", src:p.src||"",
    rs:(p.rs||[]).filter(r=>!isCell(r)&&has(r.dl)&&isFinite(+r.dl)).map(r=>({freq:r.freq??null, dl:+r.dl}))})).filter(p=>p.rs.length); };
