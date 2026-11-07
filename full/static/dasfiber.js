"use strict";
/* RF Recon — fiber links (job › PIM / sweeps / fiber; Cody 11/6, the mock-up he approved). Each link's loss budget and the
   loss measured with a light source and power meter (OLTS) at 1310 and 1550 nm, graded against the budget and, where given,
   the DAS maker's optical budget. The numbers are the DAS course's (lesson 7.8): a mated connector pair 0.75 dB and a splice
   0.3 dB at most (TIA-568.3-D, via Corning and FOA); the MCF 2023 draft's link loss at 1310 nm, 0.35L + 0.1N + 0.3 dB; a DAS
   maker's own budget (Corning MobileAccess HX: 3 dB; CommScope ION-B: 3 dB remote link); on an analog link 1 dB optical is
   2 dB RF. An OTDR trace (.sor, Telcordia SR-4731) is kept with its link and goes in the carrier closeout; RF Recon doesn't
   read the trace yet: the reader waits on a real file to be built against.
   Saved as data.fiber = {method: "tia"|"mcf", db_km, links: [{id, name, length_m, pairs, splices, l1310, l1550, maker_db, sor: [file]}]} */

const FB_TIA = "https://www.corning.com/catalog/coc/documents/misc/LAN-1561-AEN.pdf";
const FB_MCF23 = "https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf";
const FB_EXFO = "https://www.exfo.com/contentassets/d410281de6a94c788526567365c6c758/exfo_reference-guide_das-1_en.pdf";
const FB_DEF = {pair_db: 0.75, splice_db: 0.3, db_km: 0.35, mcf_splice_db: 0.1, mcf_fixed_db: 0.3};
const fbN = v => v===""||v==null ? null : isFinite(+v) ? +v : null;
const fbR2 = x => Math.round(x*100)/100;
// one link's budget: TIA's maximums (each mated pair 0.75 dB, each splice 0.3 dB, the fiber per km), or the MCF 2023 draft's
// 1310 nm formula (0.35 dB/km, 0.1 dB a splice, 0.3 dB)
function fbBudget(F, l){ const km=(fbN(l.length_m)||0)/1000, pairs=fbN(l.pairs)||0, spl=fbN(l.splices)||0, dk=fbN(F.db_km)??FB_DEF.db_km;
  if(F.method==="mcf") return {db:fbR2(dk*km+FB_DEF.mcf_splice_db*spl+FB_DEF.mcf_fixed_db), how:`MCF 2023 draft at 1310 nm: ${dk}×${fbR2(km)} km + 0.1×${spl} splice${spl===1?"":"s"} + 0.3 dB`};
  return {db:fbR2(dk*km+FB_DEF.pair_db*pairs+FB_DEF.splice_db*spl), how:`TIA maximums: ${dk} dB/km×${fbR2(km)} km + 0.75×${pairs} mated pair${pairs===1?"":"s"} + 0.3×${spl} splice${spl===1?"":"s"}`}; }
// a link's grade: each measured wavelength under the budget and under the DAS maker's budget where given
function fbGrade(F, l){ const B=fbBudget(F, l), m=[["1310",fbN(l.l1310)],["1550",fbN(l.l1550)]].filter(x=>x[1]!=null), mk=fbN(l.maker_db);
  if(!m.length) return {status:"not done", budget:B, why:"no loss measured yet"};
  if(!fbN(l.length_m)&&!fbN(l.pairs)) return {status:"not done", budget:B, why:"needs the length or the connector count for a budget"};
  const worst=Math.max(...m.map(x=>x[1])), over=m.filter(x=>x[1]>B.db), overMk=mk!=null?m.filter(x=>x[1]>mk):[];
  const why=[`${m.map(([w,v])=>`${v} dB at ${w} nm`).join(", ")} against ${B.db} dB`, mk!=null?`the DAS maker's ${mk} dB`:"", over.length||overMk.length?"":"passes",
    `on an analog link that's about ${fbR2(worst*2)} dB of RF`].filter(Boolean).join("; ");
  return {status:over.length||overMk.length?"fail":"pass", budget:B, worst, why}; }
function fbTests(d){ const F=d.fiber||{}, L=(F.links||[]).filter(l=>l&&(l.name||fbN(l.l1310)!=null||fbN(l.l1550)!=null));
  const G=L.map(l=>({l, ...fbGrade(F, l)})), bad=G.filter(g=>g.status==="fail"), open=G.filter(g=>g.status==="not done");
  return {links:G, status:!G.length?null:bad.length?"fail":open.length?"not done":"pass", pass:G.length-bad.length-open.length, fail:bad.length, open:open.length}; }

window.dasFiber = (el, j0, save) => {
  let j=j0;
  const d=()=>j.data||{};
  let F=JSON.parse(JSON.stringify(d().fiber||{}));
  if(!(F.links||[]).length) F.links=[{id:Math.random().toString(36).slice(2,9)}];
  const keep=async()=>{ FBX.busy++; try{ j=await save({fiber:F})||j; }finally{ FBX.busy--; } refresh(); };
  const cols=[["name","Link (design ID)","text",150],["length_m","Length m","num",80],["pairs","Mated pairs","num",80],["splices","Splices","num",70],["l1310","Loss at 1310 nm, dB","num",90],["l1550","Loss at 1550 nm, dB","num",90],["maker_db","DAS maker's budget dB","num",90]];
  const draw=()=>{ el.innerHTML=`<div class="panel"><h3>Fiber links <span class="hint">· loss budget and the light source and power meter reading, per link</span></h3>
      <p class="hint" style="margin:0 0 6px">Inspect, clean, inspect, then test (${`<a href="${FB_EXFO}" target="_blank" rel="noopener">EXFO's DAS guide</a>`}). The budget is ${F.method==="mcf"?`the <a href="${FB_MCF23}" target="_blank" rel="noopener">MCF 2023 draft</a>'s 1310 nm formula`:`TIA's maximums, 0.75 dB a mated pair and 0.3 dB a splice (<a href="${FB_TIA}" target="_blank" rel="noopener">TIA-568.3-D via Corning</a>)`}, plus the fiber per km; a DAS maker's own budget, where given, applies too (3 dB on Corning's MobileAccess HX and CommScope's ION-B remote link). On an analog link 1 dB optical is about 2 dB RF.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px"><label>Budget <select id="fbMethod"><option value="tia" ${F.method!=="mcf"?"selected":""}>TIA maximums</option><option value="mcf" ${F.method==="mcf"?"selected":""}>MCF 2023 draft, 1310 nm</option></select></label>
        <label>Fiber dB/km<input id="fbDk" type="number" step="any" value="${esc(F.db_km??"")}" placeholder="${FB_DEF.db_km}" style="width:80px" title="0.35 dB/km at 1310 nm, as the MCF 2023 draft's formula uses: set the cable's datasheet value"></label><span class="hint" id="fbSum"></span></div>
      <div class="tw"><table class="cm-t" id="fbTable"><thead><tr>${cols.map(([,l])=>`<th>${esc(l)}</th>`).join("")}<th>OTDR trace</th><th>Budget and result</th><th></th></tr></thead><tbody>
      ${F.links.map((l,i)=>`<tr data-link="${i}">${cols.map(([k,,t,w])=>`<td><input data-f="${k}" ${t==="num"?'type="number" step="any" inputmode="decimal"':""} value="${esc(l[k]??"")}" style="width:${w}px"></td>`).join("")}
        <td style="white-space:normal;min-width:130px">${(l.sor||[]).map(f=>`<div class="hint" style="font-size:11px">${esc(f)}</div>`).join("")}<label class="cm-up" title="An OTDR trace (.sor): kept with this link and in the carrier closeout. RF Recon doesn't read the trace yet.">⇪ .sor<input type="file" data-sor accept=".sor,.SOR" hidden></label></td>
        <td data-res class="hint" style="white-space:normal;min-width:200px"></td><td><button data-rm aria-label="Remove this link">✕</button></td></tr>`).join("")}</tbody></table></div>
      <button id="fbAdd" style="margin-top:6px">+ Add a link</button><p class="status" id="fbMsg" style="margin:6px 0 0"></p></div>`;
    wire(); refresh(); };
  const refresh=()=>{ if(!el.isConnected) return; const T=fbTests({fiber:F});
    el.querySelectorAll("tr[data-link]").forEach(tr=>{ const l=F.links[+tr.dataset.link], g=l?fbGrade(F, l):null, c=tr.querySelector("[data-res]"); if(!c||!g) return;
      c.innerHTML=`<div>${esc(g.budget.db)} dB budget <span style="font-size:11px">(${esc(g.budget.how)})</span></div><div style="color:${g.status==="pass"?"var(--good)":g.status==="fail"?"var(--bad)":"inherit"}">${esc(g.why)}</div>`; });
    const s=el.querySelector("#fbSum"); if(s) s.textContent=T.status?`${T.pass} pass, ${T.fail} fail, ${T.open} not done`:""; };
  const wire=()=>{
    el.querySelector("#fbMethod").onchange=e=>{ F.method=e.target.value; keep().then(draw); };
    el.querySelector("#fbDk").onchange=e=>{ F.db_km=e.target.value===""?null:+e.target.value; keep(); };
    el.querySelectorAll("tr[data-link] [data-f]").forEach(i=>i.onchange=()=>{ const l=F.links[+i.closest("tr").dataset.link]; l[i.dataset.f]=i.type==="number"?(i.value===""?null:+i.value):i.value; keep(); });
    el.querySelector("#fbAdd").onclick=()=>{ F.links.push({id:Math.random().toString(36).slice(2,9)}); draw(); };
    el.querySelectorAll("tr[data-link] [data-rm]").forEach(b=>b.onclick=()=>{ F.links.splice(+b.closest("tr").dataset.link, 1); draw(); keep(); });
    el.querySelectorAll("tr[data-link] [data-sor]").forEach(inp=>inp.onchange=async()=>{ const f=inp.files[0]; inp.value=""; if(!f) return; const l=F.links[+inp.closest("tr").dataset.link], say=t=>{ const m=el.querySelector("#fbMsg"); if(m) m.textContent=t; };  // after a redraw: the panel's own line
      try{ const r=await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(f.name)}`, {method:"POST", body:await f.arrayBuffer()}), name=(r&&r.name)||f.name;
        l.sor=[...new Set([...(l.sor||[]), name])]; await keep(); draw(); say(`${name}: kept with ${l.name||"this link"} and in Files. RF Recon doesn't read the trace yet.`); }
      catch(e){ say(`${f.name}: not saved: ${e.message}`); } }); };
  draw();
};
const FBX = {busy: 0};  // saves on their way, for the UI sweep
window.fbTests = fbTests;
