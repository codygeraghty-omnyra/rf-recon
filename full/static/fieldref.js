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
const frVal = v => v==null?"":typeof v==="object"?Object.entries(v).map(([k,x])=>`${k}: ${x}`).join(" · "):String(v);
// a table from rows and [key, label] columns; the last column is the sources
function frTable(r, rows, cols, opt={}){
  if(!rows?.length) return '<p class="hint">Nothing in the research for this yet.</p>';
  return `<div class="tw" style="${opt.max?`max-height:${opt.max}px`:""}"><table><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}<th>Sources</th></tr></thead><tbody>
    ${rows.map(x=>`<tr>${cols.map(([k],i)=>`<td${i?"":' style="font-weight:600"'}>${esc(frVal(x[k]))}</td>`).join("")}<td style="white-space:nowrap">${frCite(r,x.sources)}</td></tr>`).join("")}</tbody></table></div>`;
}
// a checklist; done(key) / toggle(key, on) keep the ticks (a DAS job keeps them; the tabs keep them in this browser)
function frChecklist(r, cl, done, prefix){
  return `<div class="panel" style="margin:0 0 10px"><h3 style="margin:0 0 2px">${esc(cl.name)}</h3>${cl.when?`<p class="hint" style="margin:0 0 6px">${esc(cl.when)}</p>`:""}
    ${(cl.items||[]).map(it=>{ const k=`${prefix}${cl.name}|${it.step}`; return `<label style="display:flex;gap:10px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line)">
      <input type="checkbox" data-ck="${esc(k)}" ${done(k)?"checked":""} style="margin-top:4px"><span><b>${esc(it.step)}</b>${it.detail?` <span class="hint">· ${esc(it.detail)}</span>`:""} ${frCite(r,it.sources)}</span></label>`; }).join("")}</div>`;
}
function frSop(r, s){
  return `<details class="panel" style="margin:0 0 10px"><summary style="cursor:pointer"><b>${esc(s.name)}</b>${s.purpose?` <span class="hint">· ${esc(s.purpose)}</span>`:""} ${frCite(r,s.sources)}</summary>
    <ol style="margin:8px 0 0;padding-left:22px">${(s.steps||[]).map(st=>`<li style="margin:6px 0"><b>${esc(st.action||"")}</b>${st.detail?` <span class="hint">· ${esc(st.detail)}</span>`:""}${st.acceptance?`<div class="tag v" style="margin-top:3px">Pass: ${esc(st.acceptance)}</div>`:""}</li>`).join("")}</ol></details>`;
}
const frLocal = { get(k){ try{ return JSON.parse(localStorage.getItem("rfr.fr."+k)||"null"); }catch(e){ return null; } },
                  set(k,v){ try{ localStorage.setItem("rfr.fr."+k, JSON.stringify(v)); }catch(e){} } };
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
  const run=()=>{ const f1=+$("#pcF1").value, f2=+$("#pcF2").value, tone=+$("#pcTone").value, res=+$("#pcRes").value;
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
  const r=await frLoad("pim"); if(r.empty){ v.innerHTML=frEmpty("PIM"); return; }
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
};

/* ---------- Parts tab ---------- */
S.views.parts = async v => {
  v.innerHTML='<p class="status">Loading the parts research…</p>';
  const [r, rm]=await Promise.all([frLoad("parts"), frLoad("plans")]); if(r.empty){ v.innerHTML=frEmpty("RF parts"); return; }
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
};

/* ---------- in a DAS job: PIM ---------- */
window.dasPim = async (el, j, save) => {
  const r=await frLoad("pim"), d=j.data||{}, pim=d.pim||{}, checks=pim.checks||{}, runs=Array.isArray(pim.runs)?pim.runs:[];
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
      <p class="hint">Everything else (limits, SOPs, torque, analysers): the PIM tab.</p></div>`}</div>`;
  const keep=async patch=>{ await save({pim:{...pim, ...patch}}); render(); };
  $("#dpLimit").onchange=e=>keep({limit_dbc:+e.target.value});
  $("#dpAdd").onclick=()=>{ const g=s=>$(s).value.trim(); if(!g("#dpRes")&&!g("#dpWhere")) return;
    keep({runs:[...runs, {where:g("#dpWhere"), band:g("#dpBand"), f1:g("#dpF1"), f2:g("#dpF2"), tone_dbm:g("#dpTone"), order:+g("#dpOrd"), result_dbm:g("#dpRes"), dtp_ft:g("#dpDtp"), note:g("#dpNote"), at:new Date().toISOString().slice(0,16)}]}); };
  el.querySelectorAll("[data-rmrun]").forEach(b=>b.onclick=()=>keep({runs:runs.filter((_,i)=>i!==+b.dataset.rmrun)}));
  el.querySelectorAll("[data-ck]").forEach(c=>c.onchange=()=>{ checks[c.dataset.ck]=c.checked||undefined; save({pim:{...pim, checks}}); });
};

/* ---------- in a DAS job: Materials (bill of materials) ---------- */
window.dasMaterials = async (el, j, save) => {
  const r=await frLoad("parts"), d=j.data||{}, bom=Array.isArray(d.bom)?d.bom:[], mchecks=d.material_checks||{};
  const cat=r.empty?[]:[...(r.cables||[]).map(c=>({cat:"Cable", item:c.name, part:(c.part_examples||"").toString().split(/[,;]/)[0].trim(), supplier:c.vendor||""})),
    ...(r.connectors||[]).map(c=>({cat:"Connector", item:c.name, part:"", supplier:""})),
    ...(r.components||[]).map(c=>({cat:"Component", item:c.type, part:(c.part_examples||"").toString().split(/[,;]/)[0].trim(), supplier:(c.vendors||"").toString().split(/[,;]/)[0].trim()}))];
  const sum=bom.reduce((a,x)=>(a[x.cat||"Other"]=(a[x.cat||"Other"]||0)+(+x.qty||0),a),{});
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Bill of materials</h3>
      <div class="tw"><table><thead><tr><th>Category</th><th>Item</th><th>Part number</th><th>Supplier</th><th class="n">Qty</th><th>Unit</th><th>Note</th><th></th></tr></thead><tbody>
      ${bom.map((x,i)=>`<tr><td>${esc(x.cat||"")}</td><td><b>${esc(x.item||"")}</b></td><td class="mono">${esc(x.part||"")}</td><td>${esc(x.supplier||"")}</td><td class="n">${esc(x.qty??"")}</td><td>${esc(x.unit||"")}</td><td class="hint">${esc(x.note||"")}</td><td><button data-rmb="${i}">✕</button></td></tr>`).join("")
        ||'<tr><td colspan="8" class="hint">Nothing yet: pick from the research list or type a line below.</td></tr>'}</tbody></table></div>
      <p class="hint" style="margin:6px 0">${Object.entries(sum).map(([k,n])=>`${esc(k)}: ${n}`).join(" · ")}</p>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end">
        <label class="grow">From the research<select id="dmPick"><option value="">Pick a cable, connector or component…</option>${cat.map((c,i)=>`<option value="${i}">${esc(c.cat)}: ${esc(c.item)}${c.part?` (${esc(c.part)})`:""}</option>`).join("")}</select></label></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end;margin-top:6px">
        <label>Category<input id="dmCat" style="width:110px"></label><label class="grow">Item<input id="dmItem"></label><label>Part number<input id="dmPart" style="width:150px"></label>
        <label>Supplier<input id="dmSup" style="width:140px"></label><label>Qty<input id="dmQty" type="number" step="any" style="width:80px"></label>
        <label>Unit<select id="dmUnit"><option>ea</option><option>ft</option><option>m</option><option>box</option><option>reel</option></select></label>
        <label class="grow">Note<input id="dmNote"></label><button class="primary" id="dmAdd">Add line</button><button id="dmCsv">⇩ CSV</button></div></div>
    <div>${r.empty?frEmpty("RF parts"):frCableCalc(r, "dmcc")}
      ${r.empty?"":`<div class="panel"><h3>Material rules for ERCES / DAS</h3>${(r.das||[]).map(x=>{ const k=`${x.topic}|${x.requirement}`; return `<label style="display:flex;gap:10px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line)">
        <input type="checkbox" data-mck="${esc(k)}" ${mchecks[k]?"checked":""} style="margin-top:4px"><span><b>${esc(x.topic)}</b>: ${esc(x.requirement||"")}${x.code?` <span class="tag">${esc(x.code)}</span>`:""}${x.detail?` <span class="hint">· ${esc(x.detail)}</span>`:""} ${frCite(r,x.sources)}</span></label>`; }).join("")}</div>`}</div></div>`;
  if(!r.empty) frCableCalcWire(r, "dmcc");
  $("#dmPick").onchange=e=>{ const c=cat[+e.target.value]; if(!c) return; $("#dmCat").value=c.cat; $("#dmItem").value=c.item; $("#dmPart").value=c.part; $("#dmSup").value=c.supplier; $("#dmUnit").value=c.cat==="Cable"?"ft":"ea"; $("#dmQty").focus(); };
  const keep=async b=>{ await save({bom:b}); render(); };
  $("#dmAdd").onclick=()=>{ const g=s=>$(s).value.trim(); if(!g("#dmItem")) return;
    keep([...bom, {cat:g("#dmCat"), item:g("#dmItem"), part:g("#dmPart"), supplier:g("#dmSup"), qty:g("#dmQty"), unit:$("#dmUnit").value, note:g("#dmNote")}]); };
  el.querySelectorAll("[data-rmb]").forEach(b=>b.onclick=()=>keep(bom.filter((_,i)=>i!==+b.dataset.rmb)));
  $("#dmCsv").onclick=()=>dasDl(`${fileSafe(j.name)} materials.csv`, csvOf(bom.map(({cat,item,part,supplier,qty,unit,note})=>({category:cat,item,part,supplier,qty,unit,note}))), "text/csv");
  el.querySelectorAll("[data-mck]").forEach(c=>c.onchange=()=>{ mchecks[c.dataset.mck]=c.checked||undefined; save({material_checks:mchecks}); });
};
