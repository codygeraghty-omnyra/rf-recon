"use strict";
/* RF Recon — field reference: the PIM tab (passive intermodulation: limits, checklists, SOPs, torque, testers, a PIM
   product calculator) and the Parts tab (cables with a loss calculator, connectors, components, suppliers), both read
   from the cited research in app/reference (pim.json, rf_parts.json). In a DAS job, the PIM and Materials sections
   keep their ticks, PIM runs and bill of materials with the job. Every row shows its sources. */

const FR = {};  // loaded research: FR.pim, FR.parts
async function frLoad(name){
  if(FR[name]) return FR[name];
  try{ FR[name]=await api(`/api/research/${name}`); }catch(e){ FR[name]={empty:true, error:e.message}; }
  return FR[name];
}
const frSrcIndex = r => Object.fromEntries((r.sources||[]).map(s=>[s.key,s]));
function frCite(r, keys){
  const ix=r._ix||(r._ix=frSrcIndex(r));
  return (keys||[]).filter(k=>ix[k]).map(k=>`<a href="${esc(ix[k].url)}" target="_blank" rel="noopener" title="${esc(ix[k].title)}" class="hint" style="text-decoration:none">[${esc(k)}]</a>`).join(" ");
}
// a value as text: a list item by item, an object's filled fields, nested ones too (11/3: a list of part examples read
// "0: [object Object]", and empty fields read "single: null")
const frVal = v => v==null||v===""?"":Array.isArray(v)?v.map(frVal).filter(Boolean).join(" ; ")
  :typeof v==="object"?Object.entries(v).filter(([,x])=>x!=null&&x!=="").map(([k,x])=>`${k.replace(/_/g," ")}: ${frVal(x)}`).join(" · "):String(v);
// a table from rows and [key, label] columns; the last column is the sources
function frTable(r, rows, cols, opt={}){
  if(!rows?.length) return '<p class="hint">Nothing in the research for this yet.</p>';
  return `<div class="tw" style="${opt.max?`max-height:${opt.max}px`:""}"><table><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}<th>Sources</th></tr></thead><tbody>
    ${rows.map(x=>`<tr>${cols.map(([k],i)=>`<td${i?"":' style="font-weight:600"'}>${esc(frVal(x[k]))}</td>`).join("")}<td style="white-space:nowrap">${frCite(r,x.sources)}</td></tr>`).join("")}</tbody></table></div>`;
}
// every checklist panel in el: All / None, "x of y done", folded until opened (checklists.js); commit saves once
function frChecksWire(el, commit){
  if(!window.rfChecks) return;
  el.querySelectorAll("[data-cl]").forEach(p=>rfChecks(p, {key:"cl."+p.dataset.cl, sel:"[data-ck]", commit}));
}
// a checklist; done(key) / toggle(key, on) keep the ticks (a DAS job keeps them; the tabs keep them in this browser)
function frChecklist(r, cl, done, prefix){
  return `<div class="panel" style="margin:0 0 10px" data-cl="${esc(prefix+cl.name)}"><h3 style="margin:0 0 2px">${esc(cl.name)}</h3>${cl.when?`<p class="hint" style="margin:0 0 6px">${esc(cl.when)}</p>`:""}
    ${(cl.items||[]).map(it=>{ const k=`${prefix}${cl.name}|${it.step}`; return `<label style="display:flex;flex-direction:row;gap:10px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line)">
      <input type="checkbox" data-ck="${esc(k)}" ${done(k)?"checked":""} style="margin-top:4px;width:auto;flex:none"><span><b>${esc(it.step)}</b>${it.detail?` <span class="hint">· ${esc(it.detail)}</span>`:""} ${frCite(r,it.sources)}</span></label>`; }).join("")}</div>`;
}
function frSop(r, s){
  return `<details class="panel" style="margin:0 0 10px"><summary style="cursor:pointer"><b>${esc(s.name)}</b>${s.purpose?` <span class="hint">· ${esc(s.purpose)}</span>`:""} ${frCite(r,s.sources)}</summary>
    <ol style="margin:8px 0 0;padding-left:22px">${(s.steps||[]).map(st=>`<li style="margin:6px 0"><b>${esc(st.action||"")}</b>${st.detail?` <span class="hint">· ${esc(st.detail)}</span>`:""}${st.acceptance?`<div class="tag v" style="margin-top:3px">Pass: ${esc(st.acceptance)}</div>`:""}</li>`).join("")}</ol></details>`;
}
const frLocal = { get(k){ try{ return JSON.parse(localStorage.getItem("rfr.fr."+k)||"null"); }catch(e){ return null; } },
                  set(k,v){ try{ localStorage.setItem("rfr.fr."+k, JSON.stringify(v)); }catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } } };
function frSources(r){
  return `<details class="panel"><summary style="cursor:pointer"><b>Sources</b> <span class="hint">· ${(r.sources||[]).length}</span></summary>
    ${(r.sources||[]).map(s=>`<div style="padding:2px 0"><span class="mono hint">[${esc(s.key)}]</span> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)} ↗</a> <span class="hint">· ${esc(s.kind||"")}</span></div>`).join("")}</details>`;
}
const frEmpty = name => `<p class="status">The ${name} research isn't in this copy yet (app/reference).</p>`;

/* ---------- PIM product calculator ---------- */
// uplink (receive) bands a PIM product can land in: 3GPP TS 36.101 / 38.101 band definitions and the US public safety plans
const RX_BANDS = [["B71 600 UL",663,698],["B12/17 700 UL",699,716],["B13 700 UL",777,787],["B14 FirstNet UL",788,798],["700 public safety UL",799,805],
  ["800 public safety / SMR UL",806,824],["B5 850 UL",824,849],["B26 UL",814,849],["B66/4 AWS UL",1710,1780],["B2/25 PCS UL",1850,1915],["B30 WCS UL",2305,2315],["n41 2.5 GHz (TDD)",2496,2690]];
function pimProducts(f1, f2, maxOrder=9){
  const out=[];
  for(let n=3;n<=maxOrder;n+=2){ const a=(n+1)/2, b=(n-1)/2;
    out.push({order:n, expr:`${a}F1 − ${b}F2`, f:a*f1-b*f2}, {order:n, expr:`${a}F2 − ${b}F1`, f:a*f2-b*f1}); }
  return out.map(p=>({...p, hits:RX_BANDS.filter(([,lo,hi])=>p.f>=lo&&p.f<=hi).map(([l])=>l)}));
}
function frPimCalc(){
  const P=frLocal.get("pimcalc")||{f1:869,f2:894,tone:43,res:-110};
  return `<div class="panel"><h3>PIM calculator</h3>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
      <label>F1 (MHz)<input id="pcF1" type="number" step="any" value="${P.f1}" style="width:110px"></label>
      <label>F2 (MHz)<input id="pcF2" type="number" step="any" value="${P.f2}" style="width:110px"></label>
      <label>Tone power (dBm each)<input id="pcTone" type="number" step="any" value="${P.tone}" style="width:110px"></label>
      <label>Measured PIM (dBm)<input id="pcRes" type="number" step="any" value="${P.res}" style="width:110px"></label>
      <span id="pcDbc" class="tag"></span></div>
    <div id="pcOut" style="margin-top:8px"></div>
    <p class="hint" style="margin:6px 0 0">Odd-order products near the carriers. A product inside an uplink band raises that band's noise floor. dBc = measured PIM (dBm) − one tone's power (dBm).</p></div>`;
}
function frPimCalcWire(){
  const run=()=>{ const val=id=>{ const s=$(id).value.trim(); return s===""?NaN:+s; };  // empty is "not given", never 0
    const f1=val("#pcF1"), f2=val("#pcF2"), tone=val("#pcTone"), res=val("#pcRes");
    frLocal.set("pimcalc",{f1,f2,tone,res});
    $("#pcDbc").textContent=isFinite(res)&&isFinite(tone)?`${res} dBm = ${(res-tone).toFixed(1)} dBc at ${tone} dBm a tone`:"";
    if(!(f1>0&&f2>0)){ $("#pcOut").innerHTML=""; return; }
    $("#pcOut").innerHTML=`<div class="tw"><table><thead><tr><th>Order</th><th>Product</th><th class="n">MHz</th><th>Lands in</th></tr></thead><tbody>${pimProducts(f1,f2).map(p=>`<tr>
      <td>IM${p.order}</td><td class="mono">${p.expr}</td><td class="n mono">${p.f.toFixed(3)}</td><td>${p.hits.length?`<span class="tag w">${esc(p.hits.join(", "))}</span>`:'<span class="hint">no listed uplink</span>'}</td></tr>`).join("")}</tbody></table></div>`; };
  ["#pcF1","#pcF2","#pcTone","#pcRes"].forEach(s=>$(s).oninput=run); run();
}

/* ---------- cable loss ---------- */
// loss at f from datasheet points: straight between neighbours on log-log axes, scaled by √f past the ends (flagged)
function cableLoss(c, f){
  // the table at the usual frequencies, plus the datasheet's other rows (824, 894, 1800 MHz…) where the research kept them
  const pts=Object.entries({...(c.loss_nearest_listed||{}), ...(c.loss_db_100ft||{})}).map(([k,v])=>[+k,v]).filter(([k,v])=>k>0&&typeof v==="number"&&v>0).sort((a,b)=>a[0]-b[0]);
  if(!pts.length||!(f>0)) return null;
  const exact=pts.find(p=>p[0]===f); if(exact) return {db:exact[1], how:"datasheet"};
  if(f<pts[0][0]) return {db:pts[0][1]*Math.sqrt(f/pts[0][0]), how:"scaled below the datasheet's lowest frequency"};
  const last=pts[pts.length-1]; if(f>last[0]) return {db:last[1]*Math.sqrt(f/last[0]), how:"scaled above the datasheet's highest frequency"};
  const i=pts.findIndex(p=>p[0]>f), [f0,l0]=pts[i-1], [f1,l1]=pts[i];
  return {db:Math.exp(Math.log(l0)+(Math.log(l1)-Math.log(l0))*(Math.log(f)-Math.log(f0))/(Math.log(f1)-Math.log(f0))), how:`between the datasheet's ${f0} and ${f1} MHz`};
}
function frCableCalc(r, prefix="cc"){
  const cs=(r.cables||[]).filter(c=>c.loss_db_100ft&&Object.values(c.loss_db_100ft).some(v=>typeof v==="number"));
  const P=frLocal.get(prefix)||{i:0,f:800,len:200};
  return `<div class="panel"><h3>Cable loss</h3><div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
      <label class="grow">Cable<select id="${prefix}C">${cs.map((c,i)=>`<option value="${i}" ${i===P.i?"selected":""}>${esc(c.name)}${c.rating?` · ${esc(c.rating)}`:""}</option>`).join("")}</select></label>
      <label>MHz<input id="${prefix}F" type="number" step="any" value="${P.f}" style="width:100px"></label>
      <label>Run (ft)<input id="${prefix}L" type="number" step="any" value="${P.len}" style="width:100px"></label></div>
    <p id="${prefix}Out" style="margin:8px 0 0"></p></div>`;
}
function frCableCalcWire(r, prefix="cc"){
  const cs=(r.cables||[]).filter(c=>c.loss_db_100ft&&Object.values(c.loss_db_100ft).some(v=>typeof v==="number"));
  const run=()=>{ const i=+$(`#${prefix}C`).value, f=+$(`#${prefix}F`).value, len=+$(`#${prefix}L`).value, c=cs[i];
    frLocal.set(prefix,{i,f,len}); const L=c&&cableLoss(c,f);
    $(`#${prefix}Out`).innerHTML=L?`<b>${(L.db*len/100).toFixed(2)} dB</b> over ${len} ft <span class="hint">· ${L.db.toFixed(2)} dB per 100 ft at ${f} MHz, ${esc(L.how)} ${frCite(r,c.sources)}</span>`:'<span class="hint">Pick a cable and a frequency.</span>'; };
  if(!cs.length){ $(`#${prefix}Out`).textContent="No cable loss figures in the research yet."; return; }
  [`#${prefix}C`,`#${prefix}F`,`#${prefix}L`].forEach(s=>$(s).oninput=run); run();
}

/* ---------- wall loss: one slab of a material (ITU-R P.2040), the 3GPP TR 38.901 formulas, and measured values ---------- */
const cx = {add:(a,b)=>[a[0]+b[0],a[1]+b[1]], sub:(a,b)=>[a[0]-b[0],a[1]-b[1]], mul:(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]],
  div:(a,b)=>{ const m=b[0]*b[0]+b[1]*b[1]; return [(a[0]*b[0]+a[1]*b[1])/m,(a[1]*b[0]-a[0]*b[1])/m]; }, abs:a=>Math.hypot(a[0],a[1]),
  exp:a=>{ const e=Math.exp(a[0]); return [e*Math.cos(a[1]), e*Math.sin(a[1])]; },
  sqrt:a=>{ const r=Math.sqrt(cx.abs(a)), t=Math.atan2(a[1],a[0])/2; return [r*Math.cos(t), r*Math.sin(t)]; }};
// P.2040: ε' = a·f^b, σ = c·f^d (f in GHz), ε'' = 17.98·σ/f; an air-slab-air transmission at normal incidence
function slabLossDb(row, fMHz, thickM){
  const f=fMHz/1000, er=row.a*Math.pow(f,row.b), sig=row.c*Math.pow(f,row.d), ei=17.98*sig/f;
  const n=cx.sqrt([er,-ei]), k0=2*Math.PI*fMHz*1e6/299792458;
  const r=cx.div(cx.sub([1,0],n), cx.add([1,0],n)), r2=cx.mul(r,r);
  const dl=cx.mul([k0*thickM,0], n), e1=cx.exp(cx.mul([0,-1],dl)), e2=cx.exp(cx.mul([0,-2],dl));
  const T=cx.div(cx.mul(cx.sub([1,0],r2), e1), cx.sub([1,0], cx.mul(r2,e2)));
  return {db:-20*Math.log10(cx.abs(T)), er, sig, inRange:f>=(row.f_min_ghz??0)&&f<=(row.f_max_ghz??1e9)};
}
// TR 38.901 material formulas, as the research gives them ("5 + 4*f" style, f in GHz)
function tr901(formula, fMHz){
  const f=fMHz/1000, ex=String(formula||"").replace(/[×·]/g,"*").replace(/\bf\b/g,`(${f})`);
  return /^[\d\s.+\-*/()]+$/.test(ex) ? Function(`"use strict";return (${ex})`)() : null;
}
// each material once (the newest P.2040 edition), only those usable below 6 GHz, air and vacuum left out
function frMaterials(rm){
  const ed=x=>+(String(x.edition||"").match(/2040-(\d+)/)||[0,0])[1], by=new Map();
  for(const x of (rm.itu_p2040||[]).filter(x=>typeof x.a==="number"&&(x.f_min_ghz??0)<=6&&!/vacuum|air/i.test(x.material)))
    if(!by.has(x.material)||ed(x)>ed(by.get(x.material))) by.set(x.material, x);
  return [...by.values()];
}
function frMaterialCalc(rm, prefix="mc"){
  const rows=frMaterials(rm);
  const P=frLocal.get(prefix)||{i:Math.max(0,rows.findIndex(x=>/^concrete/i.test(x.material))),f:800,t:20};
  return `<div class="panel"><h3>Wall loss</h3><div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
      <label class="grow">Material (ITU-R P.2040)<select id="${prefix}M">${rows.map((x,i)=>`<option value="${i}" ${i===P.i?"selected":""}>${esc(x.material)}</option>`).join("")}</select></label>
      <label>MHz<input id="${prefix}F" type="number" step="any" value="${P.f}" style="width:90px"></label>
      <label>Thickness (cm)<input id="${prefix}T" type="number" step="any" value="${P.t}" style="width:90px"></label></div>
    <div id="${prefix}Out" style="margin-top:8px"></div>
    <p class="hint" style="margin:6px 0 0">One slab, straight through: P.2040's permittivity and conductivity for the material, then the loss through a slab of that thickness. Real walls add studs, rebar, foil and gaps; the measured values beside it show how far apart they can be.</p></div>`;
}
function frMaterialCalcWire(rm, prefix="mc"){
  const rows=frMaterials(rm);
  const run=()=>{ const i=+$(`#${prefix}M`).value, f=+$(`#${prefix}F`).value, t=+$(`#${prefix}T`).value, m=rows[i];
    frLocal.set(prefix,{i,f,t}); if(!m||!(f>0)||!(t>0)){ $(`#${prefix}Out`).innerHTML=""; return; }
    const s=slabLossDb(m, f, t/100), key=m.material.toLowerCase().split(/[\s(]/)[0];
    const tr=(rm.tr38901||[]).filter(x=>String(x.material).toLowerCase().includes(key)).map(x=>({...x, db:tr901(x.formula_db, f)})).filter(x=>x.db!=null);
    const meas=(rm.measured||[]).filter(x=>String(x.material).toLowerCase().includes(key)).sort((a,b)=>Math.abs((a.frequency_mhz||0)-f)-Math.abs((b.frequency_mhz||0)-f)).slice(0,4);
    $(`#${prefix}Out`).innerHTML=`<div><b>${s.db.toFixed(1)} dB</b> through ${t} cm of ${esc(m.material)} at ${f} MHz <span class="hint">· ε′ ${s.er.toFixed(2)}, σ ${s.sig.toFixed(4)} S/m${s.inRange?"":` · outside P.2040's ${m.f_min_ghz}–${m.f_max_ghz} GHz range for this material: a stretch`} ${frCite(rm,m.sources)}</span></div>
      ${tr.map(x=>`<div class="hint">3GPP TR 38.901 ${esc(x.material)}: <b>${x.db.toFixed(1)} dB</b> (${esc(x.formula_db)}) ${frCite(rm,x.sources)}</div>`).join("")}
      ${meas.map(x=>`<div class="hint">Measured: ${esc(x.material)}${x.thickness?`, ${esc(x.thickness)}`:""} at ${esc(x.frequency_mhz)} MHz: <b>${esc(x.loss_db)} dB</b> (${esc(x.study||"")}) ${frCite(rm,x.sources)}</div>`).join("")}`; };
  if(!rows.length){ $(`#${prefix}Out`).textContent="No P.2040 materials in the research yet."; return; }
  [`#${prefix}M`,`#${prefix}F`,`#${prefix}T`].forEach(s=>$(s).oninput=run); run();
}

/* ---------- PIM tab ---------- */
S.views.pim = async v => {
  v.innerHTML='<p class="status">Loading the PIM research…</p>';
  const gen=S.viewGen;
  const r=await frLoad("pim"); if(gen!==S.viewGen) return; if(r.empty){ v.innerHTML=frEmpty("PIM"); return; }
  const ticks=frLocal.get("pimticks")||{};
  v.innerHTML=`<div class="panel" style="margin-top:0"><h3 style="margin:0 0 4px">PIM testing</h3>
      <p class="hint" style="margin:0">Passive intermodulation: two or more strong signals mixing in a non-linear junction (a loose or dirty connector, corroded metal) and making new frequencies that can land in a receive band. Limits, checklists and procedures below come from the sources shown on each row${r.updated?` (researched ${esc(r.updated)})`:""}.</p></div>
    <div class="grid2">${frPimCalc()}<div class="panel"><h3>Acceptance limits</h3>${frTable(r, r.limits, [["what","What"],["limit","Limit"],["condition","Condition"],["who_uses_it","Who uses it"]], {max:320})}</div></div>
    <div class="panel"><h3>Requirements and standards</h3>${frTable(r, r.requirements, [["topic","Topic"],["item","Item"],["value","Value"],["spec","Spec"],["section","Section"],["note","Note"]], {max:420})}</div>
    <h3 style="margin:14px 2px 6px">Checklists <span class="hint">· ticks are kept in this browser; a DAS job keeps its own</span></h3>
    <div id="pimLists">${(r.checklists||[]).map(cl=>frChecklist(r, cl, k=>!!ticks[k], "")).join("")}</div>
    <h3 style="margin:14px 2px 6px">Procedures</h3>${(r.sops||[]).map(s=>frSop(r,s)).join("")}
    <div class="grid2"><div class="panel"><h3>Connector torque</h3>${frTable(r, r.torque, [["connector","Connector"],["torque","Torque"],["tool","Tool"],["note","Note"]])}</div>
      <div class="panel"><h3>What causes PIM, and the fix</h3>${frTable(r, r.pim_sources, [["source","Source"],["why","Why"],["fix","Fix"]], {max:360})}</div></div>
    <div class="panel"><h3>PIM analysers</h3>${frTable(r, r.testers, [["vendor","Vendor"],["product","Product"],["bands","Bands"],["power","Power"],["features","Features"]])}</div>
    <div class="grid2"><div class="panel"><h3>PIM in a DAS</h3>${frTable(r, r.das, [["topic","Topic"],["detail","Detail"]], {max:360})}</div>
      <div class="panel"><h3>What a PIM report holds</h3>${frTable(r, r.report_fields, [["field","Field"],["why","Why"]], {max:360})}</div></div>
    <details class="panel"><summary style="cursor:pointer"><b>Glossary</b></summary>${(r.glossary||[]).map(g=>`<div style="padding:3px 0"><b>${esc(g.term)}</b> <span class="hint">· ${esc(g.meaning)}</span></div>`).join("")}</details>
    ${frSources(r)}`;
  frPimCalcWire();
  v.querySelectorAll("[data-ck]").forEach(c=>c.onchange=()=>{ ticks[c.dataset.ck]=c.checked||undefined; frLocal.set("pimticks",ticks); });
  frChecksWire(v, boxes=>{ boxes.forEach(c=>{ ticks[c.dataset.ck]=c.checked||undefined; }); frLocal.set("pimticks",ticks); });
};

/* ---------- Parts tab ---------- */
S.views.parts = async v => {
  v.innerHTML='<p class="status">Loading the parts research…</p>';
  const gen=S.viewGen;
  const [r, rm]=await Promise.all([frLoad("parts"), frLoad("plans")]); if(gen!==S.viewGen) return; if(r.empty){ v.innerHTML=frEmpty("RF parts"); return; }
  const P=S.parts=S.parts||{q:"",kind:""};
  const freqs=["150","450","700","850","1900","2600"];
  const lossCols=freqs.map(f=>[f,`${f} MHz`]);
  const cableRows=(r.cables||[]).map(c=>({...c, ...Object.fromEntries(freqs.map(f=>[f,c.loss_db_100ft?.[f]??""]))}));
  const ticks=frLocal.get("partsticks")||{};
  const sup=(r.suppliers||[]).filter(s=>(!P.kind||s.kind===P.kind)&&(!P.q||`${s.name} ${s.makes} ${s.note}`.toLowerCase().includes(P.q.toLowerCase())));
  v.innerHTML=`<div class="panel" style="margin-top:0"><h3 style="margin:0 0 4px">RF materials and parts</h3>
      <p class="hint" style="margin:0">Cables, connectors, components and who makes or sells them, with the figures from each maker's datasheet${r.updated?` (researched ${esc(r.updated)})`:""}. Loss is dB per 100 ft.</p></div>
    <div class="grid2">${frCableCalc(r)}<div class="panel"><h3>Find a supplier</h3>
      <div class="row" style="gap:8px;flex-wrap:wrap"><input id="psQ" value="${esc(P.q)}" placeholder="Name, product, note…" class="grow">
        <div class="seg" id="psKind">${[["","All"],["manufacturer","Makers"],["distributor","Distributors"]].map(([k,l])=>`<button data-k="${k}" class="${P.kind===k?"on":""}">${l}</button>`).join("")}</div></div>
      <div style="margin-top:8px">${frTable(r, sup.map(s=>({...s, name:s.name, link:s.url})), [["name","Supplier"],["kind","Kind"],["makes","Makes or sells"],["public_safety","Public safety"],["note","Note"]], {max:300})}</div></div></div>
    <div class="panel"><h3>Cables</h3>${frTable(r, cableRows, [["name","Cable"],["family","Family"],["od_in","OD (in)"],["bend_radius_in","Bend (in)"],...lossCols,["rating","Rating"],["use","Use"],["vendor","Maker"],["part_examples","Part examples"]], {max:460})}</div>
    <div class="panel"><h3>Connectors</h3>${frTable(r, r.connectors, [["name","Connector"],["impedance_ohm","Ω"],["max_freq_ghz","Max GHz"],["low_pim","Low PIM"],["torque","Torque"],["interface_std","Interface"],["use","Use"],["note","Note"]], {max:420})}</div>
    <div class="panel"><h3>Components</h3>${frTable(r, r.components, [["type","Type"],["what","What it is"],["pick_by","Pick by"],["ratings","Ratings"],["vendors","Makers"],["part_examples","Part examples"],["note","Note"]], {max:520})}</div>
    <div class="panel"><h3>DAS and ERCES material rules</h3>${frTable(r, r.das, [["topic","Topic"],["requirement","Requirement"],["code","Code"],["detail","Detail"]], {max:420})}</div>
    <h3 style="margin:14px 2px 6px">Selection checklists <span class="hint">· ticks are kept in this browser</span></h3>
    ${(r.checklists||[]).map(cl=>frChecklist(r, cl, k=>!!ticks[k], "")).join("")}
    ${rm.empty?"":`<h3 style="margin:14px 2px 6px">Building materials (RF)</h3>
      <div class="grid2">${frMaterialCalc(rm)}<div class="panel"><h3>Typical wall assemblies</h3>${frTable(rm, rm.assemblies, [["assembly","Assembly"],["typical_loss","Typical loss"],["bands","Bands"],["basis","Basis"]], {max:360})}</div></div>
      <div class="panel"><h3>Measured loss by material</h3>${frTable(rm, rm.measured, [["material","Material"],["thickness","Thickness"],["frequency_mhz","MHz"],["loss_db","Loss dB"],["study","Study"],["note","Note"]], {max:380})}</div>
      <div class="grid2"><div class="panel"><h3>ITU-R P.2040 material parameters</h3>${frTable(rm, rm.itu_p2040, [["material","Material"],["a","a"],["b","b"],["c","c"],["d","d"],["f_min_ghz","From GHz"],["f_max_ghz","To GHz"]], {max:380})}
          <p class="hint" style="margin:6px 0 0">ε′ = a·f^b and σ = c·f^d S/m, f in GHz.</p></div>
        <div class="panel"><h3>3GPP TR 38.901 material loss</h3>${frTable(rm, rm.tr38901, [["material","Material"],["formula_db","Loss (dB)"],["f_unit","f in"],["note","Note"]])}</div></div>`}
    ${frSources(r)}${rm.empty?"":frSources(rm).replace("<b>Sources</b>","<b>Sources: building materials</b>")}`;
  frCableCalcWire(r);
  if(!rm.empty) frMaterialCalcWire(rm);
  let t; $("#psQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ P.q=e.target.value; render(); const i=$("#psQ"); i.focus(); i.setSelectionRange(i.value.length,i.value.length); },300); };
  $("#psKind").onclick=e=>{ const b=e.target.closest("[data-k]"); if(b){ P.kind=b.dataset.k; render(); } };
  v.querySelectorAll("[data-ck]").forEach(c=>c.onchange=()=>{ ticks[c.dataset.ck]=c.checked||undefined; frLocal.set("partsticks",ticks); });
  frChecksWire(v, boxes=>{ boxes.forEach(c=>{ ticks[c.dataset.ck]=c.checked||undefined; }); frLocal.set("partsticks",ticks); });
};

/* ---------- in a DAS job: PIM ---------- */
window.dasPim = async (el, j, save) => {
  const r=await frLoad("pim"), d=j.data||{}, pim=d.pim||{}, checks=pim.checks||{}, runs=Array.isArray(pim.runs)?pim.runs:[];
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const lists=r.empty?[]:(r.checklists||[]).filter(cl=>/das|pre-test|pre test|close|report|setup|verif/i.test(cl.name));
  const limit=pim.limit_dbc??-140;  // the common system-level pass at 2 x 43 dBm (the research's limits); components are rated tighter
  const pass=x=>x.result_dbm!==""&&x.result_dbm!=null&&x.tone_dbm!==""?((+x.result_dbm)-(+x.tone_dbm))<=(+limit):null;
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>PIM runs</h3>
      <div class="row" style="gap:8px;align-items:end;flex-wrap:wrap"><label>Pass limit (dBc)<input id="dpLimit" type="number" step="any" value="${limit}" style="width:100px"></label>
        <span class="hint">${r.empty?"":"−140 dBc is the common system-level pass at 2 × 43 dBm; −150 dBc is stricter, and parts are rated −153 dBc or better. Low-power DAS segments are tested at lower power: PIM tab, Acceptance limits."}</span></div>
      <div class="tw" style="margin-top:8px"><table><thead><tr><th>Where</th><th>Band</th><th class="n">F1</th><th class="n">F2</th><th class="n">Tone dBm</th><th>Order</th><th class="n">PIM dBm</th><th class="n">dBc</th><th>Result</th><th class="n">DTP ft</th><th>Note</th><th></th></tr></thead><tbody>
      ${runs.map((x,i)=>{ const p=pass(x); return `<tr><td>${esc(x.where||"")}</td><td>${esc(x.band||"")}</td><td class="n mono">${esc(x.f1??"")}</td><td class="n mono">${esc(x.f2??"")}</td><td class="n">${esc(x.tone_dbm??"")}</td><td>IM${esc(x.order||3)}</td>
        <td class="n">${esc(x.result_dbm??"")}</td><td class="n">${x.result_dbm!==""&&x.result_dbm!=null?((+x.result_dbm)-(+x.tone_dbm)).toFixed(1):""}</td>
        <td>${p==null?"":p?'<span class="tag v">Pass</span>':'<span class="tag w">Fail</span>'}</td><td class="n">${esc(x.dtp_ft??"")}</td><td class="hint">${esc(x.note||"")}</td><td><button data-rmrun="${i}">✕</button></td></tr>`; }).join("")
        ||'<tr><td colspan="12" class="hint">No runs yet: add one below.</td></tr>'}</tbody></table></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px;align-items:end">
        <label>Where<input id="dpWhere" placeholder="Head-end, riser 2, floor 5 branch…" style="width:200px"></label><label>Band<input id="dpBand" placeholder="700 PS, B13…" style="width:110px"></label>
        <label>F1<input id="dpF1" type="number" step="any" style="width:90px"></label><label>F2<input id="dpF2" type="number" step="any" style="width:90px"></label>
        <label>Tone dBm<input id="dpTone" type="number" step="any" value="43" style="width:80px"></label>
        <label>Order<select id="dpOrd"><option>3</option><option>5</option><option>7</option></select></label>
        <label>PIM dBm<input id="dpRes" type="number" step="any" style="width:90px"></label><label>DTP ft<input id="dpDtp" type="number" step="any" style="width:80px"></label>
        <label class="grow">Note<input id="dpNote"></label><button class="primary" id="dpAdd">Add run</button></div></div>
    ${r.empty?frEmpty("PIM"):`<div><h3 style="margin:0 2px 6px">Checklists for this job</h3>${lists.map(cl=>frChecklist(r, cl, k=>!!checks[k], "")).join("")||'<p class="hint">No DAS checklists in the research.</p>'}
      <p class="hint">Everything else (limits, SOPs, torque, analysers): the PIM tab.</p></div>`}</div>
    <div id="dpIm" style="margin-top:10px"></div>`;
  window.dasIntermod?.($("#dpIm"), j, save, "pim");  // IM3 / IM5 of the job's channels into its uplinks, and a test plan (dasx.js)
  if(window.dasSweep){ const sw=document.createElement("div"); sw.id="dpSweep"; el.prepend(sw); window.dasSweep(sw, j, save); }  // sweeps (dassweep.js)
  const keep=async patch=>{ await save({pim:{...pim, ...patch}}); render(); };
  $("#dpLimit").onchange=e=>keep({limit_dbc:+e.target.value});
  $("#dpAdd").onclick=()=>{ const g=s=>$(s).value.trim(); if(!g("#dpRes")&&!g("#dpWhere")) return;
    keep({runs:[...runs, {where:g("#dpWhere"), band:g("#dpBand"), f1:g("#dpF1"), f2:g("#dpF2"), tone_dbm:g("#dpTone"), order:+g("#dpOrd"), result_dbm:g("#dpRes"), dtp_ft:g("#dpDtp"), note:g("#dpNote"), at:new Date().toISOString().slice(0,16)}]}); };
  el.querySelectorAll("[data-rmrun]").forEach(b=>b.onclick=()=>keep({runs:runs.filter((_,i)=>i!==+b.dataset.rmrun)}));
  el.querySelectorAll("[data-ck]").forEach(c=>c.onchange=()=>{ checks[c.dataset.ck]=c.checked||undefined; save({pim:{...pim, checks}}); });
  frChecksWire(el, boxes=>{ boxes.forEach(c=>{ checks[c.dataset.ck]=c.checked||undefined; }); save({pim:{...pim, checks}}); });  // All / None: one save
};

/* ---------- ERCES code fields on a part (11/4): UL 2524, class, FCC ID, NEMA, 2-hour, PIM, each with where it came from ---------- */
const PC_LAB={ul2524:"UL 2524", booster_class:"Class", fcc_id:"FCC ID", nema:"NEMA", rating_2h:"2-hour", pim:"PIM"};
const PC_SRC={grant:"FCC grant", "spec sheet":"spec sheet", typed:"typed"};
// one line of what a part carries and what's still open on it (words, not icons: nothing only on hover)
const pcSum=p=>{ if(!p) return ""; const c=p.codes||{}, open=(p.checks||[]).filter(x=>x.status!=="check");
  const have=Object.keys(PC_LAB).filter(k=>c[k]?.v&&!(k==="fcc_id"&&c[k].v===p.part)).map(k=>`${PC_LAB[k]} ${c[k].v}`);
  if(p.pattern) have.push(`pattern${p.pattern.gain_dbi!=null?` ${p.pattern.gain_dbi} dBi`:""}, ${p.pattern.h_width_measured}° wide`);
  return `${have.length?esc(have.join(" · ")):""}${open.length?` <span class="tag w">${open.length} missing: ${esc([...new Set(open.map(x=>PC_LAB[x.field]))].join(", "))}</span>`
    :p.kind&&p.kind!=="passive"&&!have.length?'<span class="hint">none recorded</span>':""}`; };
const pcBands=bs=>(bs||[]).slice(0,10).map(([lo,hi])=>lo===hi?`${+lo}`:`${+lo}–${+hi}`).join(", ")+((bs||[]).length>10?` +${bs.length-10} more`:"");
const pcChecks=p=>(p.checks||[]).length?`<ul style="margin:8px 0 0;padding-left:18px;line-height:1.7">${p.checks.map(c=>`<li><span class="tag ${c.status==="check"?"":"w"}">${c.status==="missing"?"missing":c.status==="problem"?"fix":"check"}</span> ${esc(c.text)}${c.source.map(s=>` · <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join("")}</li>`).join("")}</ul>`
  :`<p class="hint" style="margin:6px 0 0">${p.kind==="passive"?"No code field is required on a passive part; record what the AHJ asks for.":"Every required code field is recorded."}</p>`;
// an antenna's Planet pattern (.msi / .pln): two polar cuts drawn 0 dB at the rim, -30 dB at the centre, and its numbers
const pcPolar=(cut, label, rot)=>{ const R=70, c=80, pts=cut.map((loss,a)=>{ const r=R*(1-Math.min(loss,30)/30), t=(a+rot)*Math.PI/180;
    return `${(c+r*Math.sin(t)).toFixed(1)},${(c-r*Math.cos(t)).toFixed(1)}`; }).join(" ");
  return `<figure style="margin:0;text-align:center"><svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="${esc(label)} pattern">
    ${[R, R*2/3, R/3].map(r=>`<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)"/>`).join("")}
    <line x1="${c}" y1="${c-R}" x2="${c}" y2="${c+R}" stroke="var(--line)"/><line x1="${c-R}" y1="${c}" x2="${c+R}" y2="${c}" stroke="var(--line)"/>
    <polygon points="${pts}" fill="var(--accent)" fill-opacity=".18" stroke="var(--accent)" stroke-width="1.5"/></svg><figcaption class="hint">${esc(label)}</figcaption></figure>`; };
const pcPattern=p=>{ const t=p.pattern, ant=/antenna|yagi|panel|omni/i.test(`${p.cat||""} ${p.item||""}`);
  if(!t&&!ant) return "";
  const w=(s,m)=>s==null?`${m}°`:Math.abs(s-m)<=2?`${s}°`:`${s}° stated, ${m}° from its points`;
  return `<div style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px"><h3 style="margin:0 0 6px">Antenna pattern <span class="hint">· a Planet .msi or .pln file from the maker</span></h3>
    ${t?`<div class="row" style="gap:14px;flex-wrap:wrap;align-items:center">${pcPolar(t.horizontal,"Horizontal (0° up)",0)}${pcPolar(t.vertical,"Vertical (horizon right, down below)",90)}
      <p style="margin:0;max-width:34em">${esc(t.name||"")}${t.make?` · ${esc(t.make)}`:""} · ${t.freq_mhz!=null?`${t.freq_mhz} MHz · `:""}gain ${t.gain_dbi!=null?`${t.gain_dbi} dBi`:"not in the file"}${t.gain_given&&!/dbi/i.test(t.gain_given)?` <span class="hint">(file: ${esc(t.gain_given)} dBd)</span>`:""}
        <br>beamwidth ${esc(w(t.h_width,t.h_width_measured))} horizontal, ${esc(w(t.v_width,t.v_width_measured))} vertical${t.front_to_back!=null?` · front to back ${t.front_to_back} dB`:""}${t.tilt?` · tilt ${esc(t.tilt)}`:""}
        <br><span class="hint">From ${esc(t.file||"the file")}${t.comment?`: ${esc(t.comment)}`:""}</span></p></div>`:'<p class="hint" style="margin:0">No pattern kept yet.</p>'}
    <div class="row" style="gap:8px;align-items:center;margin-top:6px"><label class="inl">${t?"Replace the pattern":"Add its pattern"} <input type="file" id="pcPat" accept=".msi,.pln,.txt"></label><span class="hint" id="pcPatMsg"></span></div></div>`; };
// the editor for one part's code fields, below the catalogue: on.saved() after each save, on.closed(changed) when it closes
function pcEditor(box, p, fields, on={}){
  const g=p.grant, c=p.codes||{};
  box.innerHTML=`<div class="pcbox" style="border-top:1px solid var(--line);margin-top:10px;padding-top:10px"><h3 style="margin:0 0 6px">Code fields · <span class="mono">${esc(p.part||p.item||"")}</span> <span class="hint">${esc(p.maker||"")}</span></h3>
    ${g?`<p style="margin:0 0 8px">From the FCC grant: <b>${esc(g.maker)}</b> · model <b>${esc(g.model)}</b> <span class="hint">(the FCC ID's product code; the label's model name can differ)</span> · FCC ID <span class="mono">${esc(g.fcc_id)}</span> · ${esc(g.class_name||"signal booster")}<br>
      Bands ${esc(pcBands(g.bands))} MHz · power ${esc(g.power||"range not kept")}${g.power?' <span class="hint">(the FCC search\'s range, weakest to strongest band)</span>':""} · granted ${esc(g.granted||"")}${g.changed?` · last change ${esc(g.changed)}`:""}
      · <a href="${esc(g.record)}" target="_blank" rel="noopener">FCC record (fccid.io) ↗</a> · <a href="${esc(g.search)}" target="_blank" rel="noopener">FCC search ↗</a></p>`:""}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px">${fields.map(f=>{ const x=c[f.key]||{}; return `<label>${esc(f.label)}<input data-pcv="${f.key}" value="${esc(x.v||"")}" placeholder="${esc(f.hint)}">
      <select data-pcs="${f.key}" aria-label="Where the ${esc(f.label)} value came from">${x.src==="grant"?'<option value="grant" selected>from the FCC grant</option>':""}<option value="spec sheet" ${x.src==="spec sheet"?"selected":""}>from the spec sheet</option><option value="typed" ${x.src!=="grant"&&x.src!=="spec sheet"?"selected":""}>typed</option></select></label>`; }).join("")}</div>
    <div class="row" style="gap:8px;align-items:center;margin-top:8px"><button class="primary" id="pcSave">Save code fields</button><button id="pcClose">Close</button><span class="hint" id="pcMsg"></span></div>
    ${pcChecks(p)}${pcPattern(p)}</div>`;
  box.scrollIntoView({block:"nearest"});
  if($("#pcPat")) $("#pcPat").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#pcPatMsg").textContent=`Reading ${f.name}…`;
    try{ const np=await api(`/api/das/parts/${p.id}/pattern?name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()});
      pcEditor.changed=true; pcEditor(box, np, fields, on); $("#pcPatMsg").textContent=`${f.name} kept on the part.`; on.saved?.(); }
    catch(err){ $("#pcPatMsg").textContent=err.message; } };
  $("#pcClose").onclick=()=>{ box.innerHTML=""; on.closed?.(!!pcEditor.changed); pcEditor.changed=false; };
  $("#pcSave").onclick=async()=>{ const patch={};
    for(const f of fields){ const v=box.querySelector(`[data-pcv="${f.key}"]`).value.trim(); let s=box.querySelector(`[data-pcs="${f.key}"]`).value; const was=c[f.key]||{};
      if(v===(was.v||"")&&s===(was.src||"typed")) continue;  // unchanged: a grant's own value stays the grant's
      if(s==="grant") s="typed";  // a grant value changed by hand is typed
      patch[f.key]={v, src:s}; }
    if(!Object.keys(patch).length){ $("#pcMsg").textContent="Nothing changed."; return; }
    try{ const np=await post(`/api/das/parts/${p.id}`,{codes:patch}); pcEditor.changed=true; pcEditor(box, np, fields, on); $("#pcMsg").textContent="Saved."; on.saved?.(); }
    catch(e){ $("#pcMsg").textContent=e.message; } };
}

/* ---------- in a DAS job: Materials (bill of materials) ---------- */
window.dasMaterials = async (el, j, save) => {
  const r=await frLoad("parts"), d=j.data||{}, bom=Array.isArray(d.bom)?d.bom:[], mchecks=d.material_checks||{};
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  // part_examples: plain names for cables, {vendor, part, ...} for components (its text was "[object Object]", in the list and in a picked BOM line)
  const ex1=c=>{ const x=Array.isArray(c.part_examples)?c.part_examples[0]:c.part_examples; return x&&typeof x==="object"?x:{part:x??""}; };
  const part1=c=>String(ex1(c).part||"").split(/[,;]/)[0].trim();
  const cat=r.empty?[]:[...(r.cables||[]).map(c=>({cat:"Cable", item:c.name, part:part1(c), supplier:c.vendor||""})),
    ...(r.connectors||[]).map(c=>({cat:"Connector", item:c.name, part:"", supplier:""})),
    ...(r.components||[]).map(c=>({cat:"Component", item:c.type, part:part1(c), supplier:String(ex1(c).vendor||(c.vendors||"").toString().split(/[,;]/)[0]).trim()}))];
  const sum=bom.reduce((a,x)=>(a[x.cat||"Other"]=(a[x.cat||"Other"]||0)+(+x.qty||0),a),{});
  // the parts catalogue (Joe 11/3): the BOM lines' own parts (for their spec sheets) and the standard parts
  const pids=[...new Set(bom.map(x=>x.pid).filter(Boolean))];
  const [mine, std]=await Promise.all([pids.length?api(`/api/das/parts?ids=${pids.join(",")}`).catch(()=>({parts:[]})):{parts:[]}, api("/api/das/parts?standard=1&limit=500").catch(()=>({parts:[], all:0}))]);
  if(!el.isConnected) return;
  const byId=new Map(mine.parts.map(p=>[p.id,p]));
  const money=v=>v==null||v===""||isNaN(+v)?"":(+v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  const lineTotal=x=>x.qty!==""&&x.qty!=null&&x.price!==""&&x.price!=null&&!isNaN(+x.qty)&&!isNaN(+x.price)?(+x.qty)*(+x.price):null;
  const total=bom.reduce((t,x)=>t+(lineTotal(x)||0),0);
  const find=(part,maker)=>`https://www.google.com/search?q=${encodeURIComponent(`"${part}" ${maker||""} spec sheet pdf`)}`;
  const specCell=x=>{ const p=x.pid&&byId.get(+x.pid);
    return p&&p.spec_file?`<a href="/api/das/parts/${p.id}/spec" target="_blank" rel="noopener">PDF</a>`:p&&p.spec_url?`<a href="${esc(p.spec_url)}" target="_blank" rel="noopener">link ↗</a>`
      :x.part||x.item?`<a class="hint" href="${esc(find(x.part||x.item, p?.maker))}" target="_blank" rel="noopener" title="Search for its spec sheet; then keep it on the part in the catalogue below">find ↗</a>`:""; };
  el.innerHTML=`
    <div class="panel"><h3>Bill of materials</h3>
      <div class="tw"><table><thead><tr><th>Category</th><th>Item</th><th>Part number</th><th>Supplier</th><th class="n">Qty</th><th>Unit</th><th class="n">Price</th><th class="n">Total</th><th>Spec sheet</th><th>Code fields</th><th>Note</th><th></th></tr></thead><tbody>
      ${bom.map((x,i)=>`<tr><td>${esc(x.cat||"")}</td><td><b>${esc(x.item||"")}</b></td><td class="mono">${esc(x.part||"")}</td><td>${esc(x.supplier||"")}</td>
        <td class="n"><input data-bq="${i}" type="number" step="any" value="${esc(x.qty??"")}" style="width:70px"></td><td>${esc(x.unit||"")}</td>
        <td class="n"><input data-bp="${i}" type="number" step="0.01" value="${esc(x.price??"")}" style="width:84px"></td><td class="n">${money(lineTotal(x))}</td>
        <td>${specCell(x)}</td><td style="white-space:normal;min-width:11em">${x.pid&&byId.get(+x.pid)?`${pcSum(byId.get(+x.pid))} <button class="sm" data-bcode="${x.pid}">Code fields</button>`:'<span class="hint">not from the catalogue</span>'}</td><td class="hint">${esc(x.note||"")}</td><td><button data-rmb="${i}" aria-label="Remove this line">✕</button></td></tr>`).join("")
        ||'<tr><td colspan="12" class="hint">Nothing yet: add your standard parts, pick from the catalogue or the research list, or type a line below.</td></tr>'}</tbody></table></div>
      <p class="hint" style="margin:6px 0">${Object.entries(sum).map(([k,n])=>`${esc(k)}: ${n}`).join(" · ")}${total?` · <b>Total ${money(total)}</b>`:""}</p>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
        <button id="dmStd" ${std.parts.length?"":"disabled"} title="Every part starred as standard in the catalogue, with its default quantity; parts already on the list are left as they are">★ Add my standard parts (${std.parts.length})</button>
        <button id="dmSpec" ${bom.length?"":"disabled"} title="Each part's spec sheet into the job's Files, from the PDF kept on the part or its link">⎙ Build spec sheets</button>
        <a class="btn" href="/api/das/jobs/${j.id}/packet" download style="display:inline-block;white-space:nowrap">⇩ BOM + spec sheets (zip)</a></div>
      <div id="dmSpecRes"></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end">
        <label class="grow">From the research<select id="dmPick"><option value="">Pick a cable, connector or component…</option>${cat.map((c,i)=>`<option value="${i}">${esc(c.cat)}: ${esc(c.item)}${c.part?` (${esc(c.part)})`:""}</option>`).join("")}</select></label></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end;margin-top:6px">
        <label>Category<input id="dmCat" style="width:110px"></label><label class="grow">Item<input id="dmItem"></label><label>Part number<input id="dmPart" style="width:150px"></label>
        <label>Supplier<input id="dmSup" style="width:140px"></label><label>Qty<input id="dmQty" type="number" step="any" style="width:80px"></label>
        <label>Unit<select id="dmUnit"><option>ea</option><option>ft</option><option>m</option><option>box</option><option>reel</option></select></label>
        <label>Price<input id="dmPrice" type="number" step="0.01" style="width:90px"></label>
        <label class="grow">Note<input id="dmNote"></label><button class="primary" id="dmAdd">Add line</button><button id="dmCsv">⇩ CSV</button></div></div>
    <div class="panel" style="margin-top:10px" id="dmQuotes"></div>
    <div class="panel" style="margin-top:10px"><h3>Parts catalogue <span class="hint">· ${std.all||0} part${std.all===1?"":"s"} kept, ${std.parts.length} standard${std.grants?`, ${std.grants.toLocaleString()} boosters from FCC grants`:""} · your suppliers' price lists, and a spec sheet on each part</span></h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label>Supplier<input id="dmCatSup" placeholder="e.g. Wireless Supply" style="width:180px"></label>
        <label class="inl" title="A price list from any supplier: CSV, Excel or JSON. The columns are found by their names (part number, description, manufacturer, price, unit, spec sheet link)">Import a price list <input type="file" id="dmCatImp" accept=".csv,.tsv,.txt,.xlsx,.json"></label>
        <label class="grow">Find a part<input id="dmCatQ" placeholder="part number, description, maker, supplier or FCC ID"></label>
        <label class="inl" title="Only the Part 90 Class A and B boosters on the FCC's grants"><input type="checkbox" id="dmCatFcc"> FCC boosters only</label>
        <label class="inl" title="Planet .msi / .pln pattern files from an antenna maker: each becomes an antenna part with its pattern (the same name again replaces it)">Antenna patterns <input type="file" id="dmCatPat" accept=".msi,.pln" multiple></label>
        <button id="dmCatGr" title="Every Part 90 Class A and B signal booster on the FCC grants kept here becomes a part (FCC ID, class, bands, power, grant date). Code fields you typed stay.">⟳ Boosters from FCC grants</button></div>
      <p class="hint" id="dmCatMsg" style="margin:6px 0">Star the parts you use on every job: they're your standard parts, added in one go with their default quantity. Keep a spec sheet on each (a PDF, or a link to one) and Build spec sheets puts them in the job's Files for the AHJ.</p>
      <div id="dmCatList"></div><div id="dmCodeEd"></div></div>
    <div class="grid2"><div>${r.empty?frEmpty("RF parts"):frCableCalc(r, "dmcc")}</div><div>
      ${r.empty?"":`<div class="panel" id="dmRules"><h3>Material rules for ERCES / DAS</h3>${(r.das||[]).map(x=>{ const k=`${x.topic}|${x.requirement}`; return `<label style="display:flex;flex-direction:row;gap:10px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line)">
        <input type="checkbox" data-mck="${esc(k)}" ${mchecks[k]?"checked":""} style="margin-top:4px;width:auto;flex:none"><span><b>${esc(x.topic)}</b>: ${esc(x.requirement||"")}${x.code?` <span class="tag">${esc(x.code)}</span>`:""}${x.detail?` <span class="hint">· ${esc(x.detail)}</span>`:""} ${frCite(r,x.sources)}</span></label>`; }).join("")}</div>`}</div></div>`;
  // the catalogue: a search, and each part's star, default quantity, spec sheet and Add
  const catList=async()=>{ const box=$("#dmCatList"); if(!box) return; const q=($("#dmCatQ")?.value||"").trim();
    const fcc=!!$("#dmCatFcc")?.checked;
    const res=await api(`/api/das/parts?limit=60${q?`&q=${encodeURIComponent(q)}`:fcc?"":"&standard=1"}${fcc?"&grants=1":""}`).catch(e=>({parts:[], err:e.message}));
    if(!$("#dmCatList")) return;
    box.innerHTML=res.err?`<p class="hint">${esc(res.err)}</p>`:!res.parts.length?`<p class="hint">${fcc&&!res.grants?"No FCC booster grants are kept here: import them in Data & updates, FCC IDs, then press Boosters from FCC grants.":q?"No part matches.":res.all?"No standard parts yet: find a part and star it.":"No parts yet: import a supplier's price list above."}</p>`
      :`<div class="tw" style="max-height:420px"><table><thead><tr><th>★</th><th>Part number</th><th>Description</th><th>Maker</th><th>Supplier</th><th class="n">Price</th><th>Unit</th><th class="n" title="Shipping weight of one, for shipping estimates">lb</th><th class="n">Default qty</th><th>Spec sheet</th><th>Code fields</th><th></th></tr></thead><tbody>
        ${res.parts.map(p=>`<tr><td><button class="sm" data-pstar="${p.id}" aria-pressed="${p.standard}" title="${p.standard?"A standard part: press to unstar":"Star it as a standard part"}">${p.standard?"★":"☆"}</button></td>
          <td class="mono">${esc(p.part||"")}</td><td style="white-space:normal;min-width:14em">${esc(p.item||"")}</td><td>${esc(p.maker||"")}</td><td>${esc(p.supplier||"")}</td><td class="n">${money(p.price)}</td><td>${esc(p.unit||"")}</td>
          <td class="n"><input data-pwt="${p.id}" type="number" step="any" min="0" value="${esc(p.weight_lb??"")}" style="width:58px" title="Shipping weight of one (lb)"></td>
          <td class="n">${p.standard?`<input data-pqty="${p.id}" type="number" step="any" value="${esc(p.std_qty??"")}" style="width:64px">`:""}</td>
          <td style="white-space:nowrap">${p.spec_file?`<a href="/api/das/parts/${p.id}/spec" target="_blank" rel="noopener">PDF</a> · `:p.spec_url?`<a href="${esc(p.spec_url)}" target="_blank" rel="noopener">link ↗</a> · `:`<a class="hint" href="${esc(find(p.part||p.item,p.maker))}" target="_blank" rel="noopener">find ↗</a> · `}
            <label class="hint" style="cursor:pointer" title="Keep a spec sheet PDF on this part">upload<input type="file" data-pspec="${p.id}" accept=".pdf,application/pdf" hidden></label> · <a class="hint" href="#" data-plink="${p.id}" title="Keep a link to its spec sheet PDF">link</a></td>
          <td style="white-space:normal;min-width:11em">${pcSum(p)} <button class="sm" data-pcode="${p.id}">Code fields</button></td>
          <td><button class="sm" data-padd="${p.id}">+ BOM</button></td></tr>`).join("")}</tbody></table></div>
        ${res.total>res.parts.length?`<p class="hint">${res.parts.length} of ${res.total.toLocaleString()} shown: narrow the search.</p>`:""}`;
    const part=id=>res.parts.find(x=>x.id===+id);
    box.querySelectorAll("[data-pstar]").forEach(b=>b.onclick=async()=>{ const p=part(b.dataset.pstar); await post(`/api/das/parts/${p.id}`,{standard:!p.standard, ...(p.standard?{}:{std_qty:p.std_qty??1})}).catch(e=>alert(e.message)); render(); });
    box.querySelectorAll("[data-pqty]").forEach(i=>i.onchange=()=>post(`/api/das/parts/${i.dataset.pqty}`,{std_qty:i.value}).catch(e=>alert(e.message)));
    box.querySelectorAll("[data-pwt]").forEach(i=>i.onchange=()=>post(`/api/das/parts/${i.dataset.pwt}`,{weight_lb:i.value}).catch(e=>alert(e.message)));
    box.querySelectorAll("[data-pspec]").forEach(i=>i.onchange=async()=>{ const f=i.files[0]; if(!f) return; $("#dmCatMsg").textContent=`Keeping ${f.name}…`;
      try{ await api(`/api/das/parts/${i.dataset.pspec}/spec`,{method:"POST", body:await f.arrayBuffer()}); $("#dmCatMsg").textContent=`${f.name} kept on the part.`; catList(); }catch(e){ $("#dmCatMsg").textContent=e.message; } });
    box.querySelectorAll("[data-plink]").forEach(a=>a.onclick=async e=>{ e.preventDefault(); const p=part(a.dataset.plink), u=prompt("Link to this part's spec sheet PDF", p.spec_url||""); if(u==null) return;
      await post(`/api/das/parts/${p.id}`,{spec_url:u.trim()}).catch(err=>alert(err.message)); catList(); });
    box.querySelectorAll("[data-padd]").forEach(b=>b.onclick=()=>{ const p=part(b.dataset.padd); addParts([p]); });
    box.querySelectorAll("[data-pcode]").forEach(b=>b.onclick=()=>pcEditor($("#dmCodeEd"), part(b.dataset.pcode), res.code_fields||[], {saved:catList, closed:ch=>{ if(ch) render(); }})); };
  // parts into the BOM: once each (a part already on the list keeps its line and quantity)
  const addParts=ps=>{ const have=new Set(bom.map(x=>x.pid?`id${x.pid}`:`${(x.part||x.item||"").toLowerCase()}`));
    const add=ps.filter(p=>!have.has(`id${p.id}`)&&!have.has((p.part||p.item||"").toLowerCase()))
      .map(p=>({pid:p.id, cat:p.cat||"", item:p.item||"", part:p.part||"", supplier:p.supplier||"", qty:p.std_qty??"", unit:p.unit||"ea", price:p.price??"", note:""}));
    if(!add.length){ $("#dmCatMsg").textContent="Already on the bill of materials."; return; }
    keep([...bom, ...add]); };
  $("#dmCatQ").oninput=()=>{ clearTimeout(catList.t); catList.t=setTimeout(catList,300); };
  $("#dmCatFcc").onchange=()=>catList();
  $("#dmCatPat").onchange=async e=>{ const fs=[...e.target.files], done=[], bad=[]; if(!fs.length) return; $("#dmCatMsg").textContent=`Reading ${fs.length} pattern file${fs.length===1?"":"s"}…`;
    for(const f of fs){ try{ const p=await api(`/api/das/parts/pattern?name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()}); done.push(p.part); }
      catch(err){ bad.push(`${f.name}: ${err.message}`); } }
    $("#dmCatMsg").textContent=[done.length?`${done.length} antenna pattern${done.length===1?"":"s"} kept: ${done.join(", ")}.`:"", ...bad].filter(Boolean).join(" ");
    if(done.length){ $("#dmCatQ").value=done[done.length-1]; $("#dmCatFcc").checked=false; catList(); } e.target.value=""; };
  $("#dmCatGr").onclick=async e=>{ const b=e.currentTarget; b.disabled=true; $("#dmCatMsg").textContent="Reading the FCC grants kept here…";
    try{ const r=await post("/api/fccid/parts"); $("#dmCatMsg").textContent=r.devices?`${r.devices.toLocaleString()} Part 90 boosters from the FCC's grants: ${r.added.toLocaleString()} new, ${r.updated.toLocaleString()} brought up to date. Code fields you typed stay.`
      :"No Part 90 booster grants are kept here: import the FCC's grant search in Data & updates, FCC IDs."; $("#dmCatFcc").checked=!!r.devices; catList(); }
    catch(err){ $("#dmCatMsg").textContent=err.message; } b.disabled=false; };
  el.querySelectorAll("[data-bcode]").forEach(b=>b.onclick=()=>{ const p=byId.get(+b.dataset.bcode); if(p) pcEditor($("#dmCodeEd"), p, std.code_fields||[], {closed:ch=>{ if(ch) render(); }}); });
  $("#dmCatImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; const sup=$("#dmCatSup").value.trim(); $("#dmCatMsg").textContent=`Reading ${f.name}…`;
    try{ const r=await api(`/api/das/parts/import?name=${encodeURIComponent(f.name)}&supplier=${encodeURIComponent(sup)}`,{method:"POST", body:await f.arrayBuffer()});
      $("#dmCatMsg").textContent=`${f.name}: ${r.added.toLocaleString()} new part${r.added===1?"":"s"}, ${r.updated.toLocaleString()} updated, ${r.total.toLocaleString()} kept in all. Columns read: ${Object.entries(r.columns).map(([k,h])=>`${k} = ${h}`).join(", ")}.`; catList(); }
    catch(err){ $("#dmCatMsg").textContent=err.message; } e.target.value=""; };
  $("#dmStd").onclick=()=>addParts(std.parts);
  $("#dmSpec").onclick=async e=>{ const b=e.currentTarget, out=$("#dmSpecRes"); b.disabled=true; out.innerHTML='<p class="hint">Gathering spec sheets…</p>';
    try{ const r=await post(`/api/das/jobs/${j.id}/specsheets`);
      out.innerHTML=`<p style="margin:4px 0"><b>${r.ok} of ${r.of}</b> parts' spec sheets are in the job's Files${r.ok<r.of?"; the rest:":"."}</p>
        ${r.parts.filter(x=>x.status!=="ok").map(x=>`<div class="hint">✗ ${esc(x.part||x.item)}: ${esc(x.why||"")} · <a href="${esc(find(x.part||x.item,x.maker))}" target="_blank" rel="noopener">find ↗</a></div>`).join("")}`; }
    catch(err){ out.innerHTML=`<p class="status err">${esc(err.message)}</p>`; } b.disabled=false; };
  catList();
  // Quotes from suppliers (Cody 11/3): a request for quote from this BOM to several suppliers, their quotes entered or
  // imported, and the comparison. RF Recon writes the email; the person sends it from their own mail.
  const quotes=async()=>{ const box=$("#dmQuotes"); if(!box) return;
    const [sl, rl]=await Promise.all([api("/api/das/suppliers").catch(()=>({suppliers:[]})), api(`/api/das/rfq?job=${j.id}`).catch(()=>({rfqs:[]}))]);
    if(!$("#dmQuotes")) return;
    const sup=sl.suppliers, rfq=rl.rfqs[0]?await api(`/api/das/rfq/${rl.rfqs[0].id}`).catch(()=>null):null;
    const lineSups=[...new Set(bom.map(x=>x.supplier).filter(Boolean))];
    box.innerHTML=`<h3>Quotes from suppliers <span class="hint">· ask several suppliers for this bill of materials and compare price, shipping and when it arrives</span></h3>
      ${rfq?quoteView(rfq):""}
      <details ${rfq?"":"open"}><summary style="cursor:pointer"><b>${rfq?"Ask again (a new request)":"Ask for quotes"}</b></summary>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:6px 0">${sup.map(s=>`<label class="chip" style="gap:6px"><input type="checkbox" data-qs="${esc(s.name)}" ${lineSups.includes(s.name)||s.email?"checked":""}> ${esc(s.name)}
            <input data-qse="${esc(s.name)}" type="email" value="${esc(s.email||"")}" placeholder="their email" style="width:180px"><input data-qsu="${esc(s.name)}" value="${esc(s.price_url||"")}" placeholder="price list link (optional)" title="A CSV or Excel price list the supplier publishes: re-read weekly (Data & updates, DAS part prices)" style="width:190px"><input data-qsf="${esc(s.name)}" value="${esc(s.ship_from||"")}" placeholder="ships from: street, city, ST ZIP" title="Where this supplier ships from, for shipping estimates" style="width:210px">${s.price_result?`<span class="hint" title="${esc(s.price_checked||"")}">${esc(s.price_result)}</span>`:""}</label>`).join("")||'<span class="hint">No suppliers yet: add one.</span>'}</div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
          <button id="qsRefresh" title="Re-read every supplier's price list link now">⟳ Re-read price lists</button>
          <label>Add a supplier<input id="qsName" placeholder="name" style="width:160px"></label><label>Email<input id="qsEmail" type="email" style="width:200px"></label><button id="qsAdd">Add</button>
          <label>Needed by<input id="qNeed" type="date"></label><label class="grow">Ship to<input id="qShip" value="${esc(d.address||"")}"></label>
          <label class="grow">Note to suppliers<input id="qNote" placeholder="e.g. plenum-rated cable only; partial quotes welcome"></label>
          <button class="primary" id="qMake" ${bom.length?"":"disabled"}>Make the request</button></div>
        <p class="hint" id="qMsg" style="margin:4px 0 0">${bom.length?"Each supplier gets the same list. Each email goes from your mailbox when you press Send on it (or opens in your own mail).":"Add parts to the bill of materials first."}</p></details>`;
    { const row=box.querySelector("[data-qs]")?.closest(".row"); if(row) window.rfChecks?.(row, {sel:"[data-qs]", fold:false, word:"asked"}); }  // All / None suppliers
    box.querySelectorAll("[data-qse]").forEach(i=>i.onchange=()=>post("/api/das/suppliers",{name:i.dataset.qse, email:i.value}).catch(e=>alert(e.message)));
    box.querySelectorAll("[data-qsu]").forEach(i=>i.onchange=()=>post("/api/das/suppliers",{name:i.dataset.qsu, price_url:i.value}).catch(e=>alert(e.message)));
    box.querySelectorAll("[data-qsf]").forEach(i=>i.onchange=()=>post("/api/das/suppliers",{name:i.dataset.qsf, ship_from:i.value}).catch(e=>alert(e.message)));
    $("#qsRefresh").onclick=async e=>{ const b=e.currentTarget; b.disabled=true; $("#qMsg").textContent="Re-reading the price lists…";
      try{ const r=await post("/api/das/suppliers/refresh"); $("#qMsg").textContent=r.refreshed.length?r.refreshed.map(x=>`${x.supplier}: ${x.result}`).join(" · "):"No supplier has a price list link yet."; catList(); }
      catch(err){ $("#qMsg").textContent=err.message; } b.disabled=false; };
    $("#qsAdd").onclick=async()=>{ const n=$("#qsName").value.trim(); if(!n) return $("#qsName").focus(); await post("/api/das/suppliers",{name:n, email:$("#qsEmail").value}).catch(e=>alert(e.message)); quotes(); };
    $("#qMake").onclick=async e=>{ const b=e.currentTarget; if(b.disabled) return; b.disabled=true;
      const pick=[...box.querySelectorAll("[data-qs]:checked")].map(c=>c.dataset.qs);
      try{ await post("/api/das/rfq",{job_id:j.id, suppliers:pick, need_by:$("#qNeed").value, ship_to:$("#qShip").value, notes:$("#qNote").value}); quotes(); }
      catch(err){ $("#qMsg").textContent=err.message; b.disabled=false; } };
    if(rfq) wireQuote(rfq, sup); };
  const quoteView=q=>{ const C=q.compare, cur=v=>v==null?"–":money(v);
    return `<p class="hint" style="margin:0 0 6px">Request ${esc(q.title)} · made ${esc(q.created_at.slice(0,16))}${q.need_by?` · needed by ${esc(q.need_by)}`:""} · <a href="/api/das/rfq/${q.id}/sheet" download>⇩ quote sheet (CSV)</a> · <button class="sm" id="qOnline" title="Mouser and Digi-Key, with your keys (Data & updates, Your API keys): price at your quantity, stock and lead time">⟳ Check online prices</button> <button class="sm" id="qFreight" title="UPS, FedEx and USPS rates through Shippo (your key), from each supplier's ship-from address to the ship-to, for the parts' weights. Never replaces a shipping price a supplier gave.">⟳ Estimate shipping</button></p><p class="hint" id="qOnMsg" style="margin:0 0 6px"></p>
      <div class="tw"><table><thead><tr><th>Supplier</th><th></th><th class="n">Lines quoted</th><th class="n">Subtotal</th><th class="n">Shipping</th><th class="n">Total</th><th class="n">Ready in</th><th>Quote holds to</th><th></th></tr></thead><tbody>
      ${C.suppliers.map(s=>`<tr><td><b>${esc(s.supplier)}</b>${s.supplier===C.cheapest?' <span class="tag" style="background:var(--good);color:#fff">cheapest</span>':""}${s.supplier===C.fastest?' <span class="tag">fastest</span>':""}</td>
        <td style="white-space:nowrap"><button class="sm" data-qmail="${esc(s.supplier)}" title="Opens the request in your own mail to send">✉ Email</button> <button class="sm" data-qenter="${esc(s.supplier)}">Enter quote</button>
          <label class="hint" style="cursor:pointer">import<input type="file" data-qimp="${esc(s.supplier)}" accept=".csv,.tsv,.txt,.xlsx,.json" hidden></label></td>
        <td class="n">${s.received?`${s.quoted} of ${s.of}`:'<span class="hint">waiting</span>'}</td><td class="n">${s.received?cur(s.subtotal):""}</td><td class="n">${s.ship_est?`<span title="${esc(s.ship_est)}">${cur(s.shipping)} <span class="tag">est.</span></span>`:s.received?(/\(online\)$/.test(s.supplier)&&!s.shipping?'<span class="hint">not in their price</span>':cur(s.shipping)):""}</td>
        <td class="n"><b>${s.received?cur(s.total):""}</b></td><td class="n">${s.ready_days!=null?`${Math.round(s.ready_days)} day${Math.round(s.ready_days)===1?"":"s"}`:""}</td><td>${esc(s.valid_until||"")}</td>
        <td>${s.received&&!s.missing.length?`<button class="sm" data-quse="${esc(s.supplier)}" title="Its prices and name onto the bill of materials">Use</button>`:s.missing.length&&s.received?`<span class="hint">${s.missing.length} missing</span>`:""}</td></tr>`).join("")}
      ${C.split.lines.length?`<tr><td><b>Best split</b> <span class="hint">each line from its cheapest</span></td><td class="hint">${esc(C.split.suppliers.join(" + "))}</td><td class="n">${C.split.lines.length} of ${q.lines.length}</td><td></td><td></td><td class="n"><b>${cur(C.split.total)}</b></td><td></td><td></td>
        <td>${C.split.complete?`<button class="sm" data-quse="__split">Use</button>`:""}</td></tr>`:""}</tbody></table></div>
      <div id="qEnter"></div><div id="qMailThread"></div>`; };
  const wireQuote=(q, sup)=>{ const box=$("#dmQuotes");
    if(window.rfMail) rfMail.thread($("#qMailThread"), {rfq:q.id}, ()=>quotes());  // the suppliers' replies, filed; Apply for typed prices
    $("#qFreight").onclick=async e=>{ const b=e.currentTarget; b.disabled=true; $("#qOnMsg").textContent="Asking Shippo for rates…";
      try{ const r=await post(`/api/das/rfq/${q.id}/freight`); const f=r.freight;
        const say=`${f.total_lb} lb in ${f.boxes} box${f.boxes===1?"":"es"}${f.missing_weight.length?` (no weight yet: ${f.missing_weight.slice(0,4).join(", ")}${f.missing_weight.length>4?"…":""})`:""}. `+f.results.map(x=>`${x.supplier}: ${x.result}`).join(" · ");
        await quotes(); const m=$("#qOnMsg"); if(m) m.textContent=say; }
      catch(err){ $("#qOnMsg").textContent=err.message; b.disabled=false; } };
    $("#qOnline").onclick=async e=>{ const b=e.currentTarget; b.disabled=true; $("#qOnMsg").textContent="Asking the distributors…";
      try{ const r=await post(`/api/das/rfq/${q.id}/online`); const o=r.online;
        const say=!o.keys.length?"No Mouser or Digi-Key key is saved: add them in Data & updates, Your API keys (both free).":
          `${o.sources.length?`Priced online by ${o.sources.join(" and ")}.`:"No exact part number match online."}${o.errors.length?` ${o.errors.length} lookup${o.errors.length===1?"":"s"} failed: ${o.errors.slice(0,2).join("; ")}`:""}`;
        await quotes(); const m=$("#qOnMsg"); if(m) m.textContent=say; }
      catch(err){ $("#qOnMsg").textContent=err.message; b.disabled=false; } };
    box.querySelectorAll("[data-qmail]").forEach(b=>b.onclick=async()=>{ const s=b.dataset.qmail, to=(sup.find(x=>x.name===s)||{}).email||"";
      const e=await api(`/api/das/rfq/${q.id}/email?supplier=${encodeURIComponent(s)}&sender=${encodeURIComponent(S.me?.name||"")}`);
      if(window.rfMail&&await rfMail.ready()){  // from your own mailbox: the quote sheet attached, their reply read straight into the comparison
        return rfMail.compose($("#qEnter"), {kind:"rfq", refs:{rfq_id:q.id, supplier:s}, title:`Request for quote to ${s}`, to, subject:e.subject,
          body:e.body, rfqSheet:true, onSent:()=>quotes()}); }
      await post(`/api/das/rfq/${q.id}/quote`,{supplier:s, terms:{sent_at:new Date().toISOString().slice(0,16).replace("T"," ")}}).catch(()=>{});
      const href=`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(e.subject)}&body=${encodeURIComponent(e.body+"\n\n(Attach the quote sheet: Materials, Quotes, quote sheet CSV.)")}`;
      // where no mail app is set up the link does nothing: say so, with the link and a copy of the email (11/3)
      $("#qEnter").innerHTML=`<p class="hint" style="margin:8px 0 0">The request to ${esc(s)} opened in your mail${to?"":" (no email kept for them: add it above)"}. Nothing opened?
        <a id="qMailto" href="${esc(href)}">open it again</a> or <button class="sm" id="qCopy">Copy the email</button> and paste it into any mail.</p>`;
      $("#qCopy").onclick=async()=>{ try{ await navigator.clipboard.writeText(`To: ${to}\nSubject: ${e.subject}\n\n${e.body}`); $("#qCopy").textContent="Copied"; }catch(err){ alert("Couldn't copy: "+err.message); } };
      location.href=href; });
    box.querySelectorAll("[data-qimp]").forEach(i=>i.onchange=async()=>{ const f=i.files[0]; if(!f) return;
      try{ const r=await api(`/api/das/rfq/${q.id}/import?supplier=${encodeURIComponent(i.dataset.qimp)}&name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()});
        quotes(); setTimeout(()=>{ const m=$("#qMsg"); if(m) m.textContent=`${i.dataset.qimp}: ${r.imported.lines} lines read${r.imported.unmatched?`, ${r.imported.unmatched} didn't match a part`:""}.`; },400); }
      catch(err){ alert(err.message); } });
    box.querySelectorAll("[data-qenter]").forEach(b=>b.onclick=()=>{ const s=b.dataset.qenter, mine=Object.fromEntries(q.quotes.filter(x=>x.supplier===s).map(x=>[x.key,x])), t=q.terms[s]||{};
      $("#qEnter").innerHTML=`<div class="panel" style="margin-top:8px"><h3>${esc(s)}'s quote</h3><div class="tw"><table><thead><tr><th>Part</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Lead time (days)</th><th>Note</th></tr></thead><tbody>
        ${q.lines.map(ln=>`<tr><td><b>${esc(ln.part||"")}</b> ${esc(ln.item||"")}</td><td class="n">${ln.qty} ${esc(ln.unit)}</td>
          <td class="n"><input data-qp="${esc(ln.key)}" type="number" step="0.0001" value="${mine[ln.key]?.unit_price??""}" style="width:90px"></td>
          <td class="n"><input data-ql="${esc(ln.key)}" type="number" step="1" value="${mine[ln.key]?.lead_days??""}" style="width:70px"></td>
          <td><input data-qn="${esc(ln.key)}" value="${esc(mine[ln.key]?.note||"")}" style="width:160px"></td></tr>`).join("")}</tbody></table></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end;margin-top:6px"><label>Shipping cost<input id="qtShip" type="number" step="0.01" value="${t.ship_cost??""}" style="width:100px"></label>
          <label>Shipping days<input id="qtDays" type="number" step="1" value="${t.ship_days??""}" style="width:80px"></label><label>Quote holds to<input id="qtValid" type="date" value="${esc(t.valid_until||"")}"></label>
          <label>Their quote number<input id="qtRef" value="${esc(t.quote_ref||"")}" style="width:120px"></label><button class="primary" id="qtSave">Save ${esc(s)}'s quote</button></div></div>`;
      $("#qtSave").onclick=async()=>{ const lines={}; $$("#qEnter [data-qp]").forEach(i=>{ const k=i.dataset.qp; if(i.value!=="") lines[k]={unit_price:i.value, lead_days:$(`#qEnter [data-ql="${CSS.escape(k)}"]`).value, note:$(`#qEnter [data-qn="${CSS.escape(k)}"]`).value}; });
        try{ await post(`/api/das/rfq/${q.id}/quote`,{supplier:s, lines, terms:{ship_cost:$("#qtShip").value, ship_days:$("#qtDays").value, valid_until:$("#qtValid").value, quote_ref:$("#qtRef").value}}); quotes(); }
        catch(err){ alert(err.message); } };
      $("#qEnter").scrollIntoView({block:"nearest"}); });
    box.querySelectorAll("[data-quse]").forEach(b=>b.onclick=()=>{ const s=b.dataset.quse, pick={};
      if(s==="__split") for(const x of q.compare.split.lines) pick[x.key]={supplier:x.supplier, price:x.unit_price};
      else for(const x of q.quotes.filter(x=>x.supplier===s&&x.unit_price!=null)) pick[x.key]={supplier:s, price:x.unit_price};
      const key=x=>(x.part||x.item||"").trim().toLowerCase().replace(/\s+/g," ");
      keep(bom.map(x=>pick[key(x)]?{...x, supplier:pick[key(x)].supplier, price:pick[key(x)].price}:x)); }); };
  quotes();
  if(!r.empty) frCableCalcWire(r, "dmcc");
  $("#dmPick").onchange=e=>{ const c=cat[+e.target.value]; if(!c) return; $("#dmCat").value=c.cat; $("#dmItem").value=c.item; $("#dmPart").value=c.part; $("#dmSup").value=c.supplier; $("#dmUnit").value=c.cat==="Cable"?"ft":"ea"; $("#dmQty").focus(); };
  const keep=async b=>{ await save({bom:b}); render(); };
  $("#dmAdd").onclick=()=>{ const g=s=>$(s).value.trim(); if(!g("#dmItem")) return;
    keep([...bom, {cat:g("#dmCat"), item:g("#dmItem"), part:g("#dmPart"), supplier:g("#dmSup"), qty:g("#dmQty"), unit:$("#dmUnit").value, price:g("#dmPrice"), note:g("#dmNote")}]); };
  // quantity and price edited in the table (each line's total and the grand total follow)
  el.querySelectorAll("[data-bq],[data-bp]").forEach(i=>i.onchange=()=>{ const k=i.dataset.bq!=null?"qty":"price", n=+(i.dataset.bq??i.dataset.bp);
    keep(bom.map((x,ix)=>ix===n?{...x,[k]:i.value}:x)); });
  el.querySelectorAll("[data-rmb]").forEach(b=>b.onclick=()=>keep(bom.filter((_,i)=>i!==+b.dataset.rmb)));
  $("#dmCsv").onclick=()=>dasDl(`${fileSafe(j.name)} materials.csv`, csvOf(bom.map(x=>({category:x.cat,item:x.item,part:x.part,supplier:x.supplier,qty:x.qty,unit:x.unit,price:x.price??"",line_total:lineTotal(x)==null?"":lineTotal(x).toFixed(2),note:x.note,
    ...Object.fromEntries(Object.entries(PC_LAB).map(([k,lab])=>{ const c=(byId.get(+x.pid)?.codes||{})[k]; return [lab, c?.v?`${c.v} [${c.src||"typed"}]`:""]; })),
    "code checks":(byId.get(+x.pid)?.checks||[]).map(c=>`${c.status}: ${c.text}`).join("; ")}))), "text/csv");
  el.querySelectorAll("[data-mck]").forEach(c=>c.onchange=()=>{ mchecks[c.dataset.mck]=c.checked||undefined; save({material_checks:mchecks}); });
  window.rfChecks?.($("#dmRules"), {key:"das.materialrules", sel:"[data-mck]", word:"confirmed",  // All / None: one save
    commit:boxes=>{ boxes.forEach(c=>{ mchecks[c.dataset.mck]=c.checked||undefined; }); save({material_checks:mchecks}); }});
};
