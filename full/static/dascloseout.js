"use strict";
/* RF Recon — carrier closeout packages (job › Report › Carrier closeout; Cody 11/6, the mock-up he approved).
   No US carrier publishes an in-building closeout spec (the DAS course, lesson 7.11). The items are the fullest public list,
   Australia's MCF Design Guidelines 2025, with owner specs (CU Denver) and Viavi. One card per carrier: each item ticked from
   the job's own records where they show it (sweeps, PIM, cellular commissioning, the 20.21(c) consent date, files in the job's
   folder), else by a person; the carrier's own items added by hand when it sends its spec; one zip per carrier (closeout.py).
   Saved as data.closeout = {<carrier>: {ticks: {<item>: {done, by, at, note}}, own: [{name, done, by, at}]}}. */

const CO_MCF = "https://amta.org.au/wp-content/uploads/2026/07/MCF-Design-Guidelines-for-Distributed-Antenna-Systems-060525-FINAL.pdf";
// [id, name, what public sources say goes in it] (lesson 7.11's table)
const CO_ITEMS = [
  ["asbuilt", "As-builts", "Antennas, couplers, cable routes, room layouts (CU Denver); the iBwave file if one was used (MCF)"],
  ["bom", "Bill of materials", "The bill of material used (MCF)"],
  ["sweep", "Sweeps", "Every cable, return loss and distance to fault, native files plus PDF, a certificate that all pass (MCF)"],
  ["pim", "PIM", "A table of results, dated screenshots, the original files (MCF)"],
  ["fiber", "Fiber", "OTDR on all fibers (CU Denver, CommScope, MCF)"],
  ["power", "Power levels", "Composite power per operator per band (MCF)"],
  ["walk", "Walk plots", "Colour-coded plots and the log files, per band and technology (MCF)"],
  ["commission", "Cellular commissioning", "Each step's numbers, in order (Viavi)"],
  ["calls", "Call test and KPIs", "Throughput, SINR, RSRP, phone transmit power (Viavi)"],
  ["alarm", "Alarm test", "Supervisory alarms shown working (MCF 2023 draft)"],
  ["photos", "Photos", "Date-stamped PIM shots; active parts on request (MCF)"],
  ["settings", "Equipment settings", "All configuration for the active system (MCF)"],
  ["consent", "Consent letter", "The carrier's written consent for the booster (47 CFR 20.21)"],
  ["contacts", "Contacts and access", "Wireless service provider contacts (CU Denver); site access (MCF)"],
];
// which of a job's files belong to an item, by name (the evidence store: design IDs and the test in the file name)
const CO_FILES = {asbuilt:/as.?built|redline|\.ibw$/i, sweep:/sweep|return.?loss|\bdtf\b|vswr|\.s[12]p$|\.dat$/i, pim:/\bpim\b/i, fiber:/\.sor$|otdr|olts|fib(er|re)/i,
  walk:/walk|drive|g-?nettrack|\.kml$|\.kmz$/i, photos:/\.(jpe?g|png|heic|webp)$/i, settings:/setting|config|\.cfg$|backup/i, consent:/consent|20\.21|rebroadcast/i};
const coSame = (a, b) => String(a||"").toLowerCase().replace(/[^a-z0-9]/g,"").includes(String(b||"").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0, 5));
function coCarriers(d){ const s=new Set(); const C=d.cellular||{};
  for(const c of C.carriers||[]) s.add(typeof c==="string"?c:c?.name);
  for(const k of Object.keys(C.approvals||{})) s.add(k);
  try{ for(const b of (typeof dsBands==="function"?dsBands(d):[]).filter(x=>x.cell)) for(const x of b.systems||[]) s.add(x); }catch(e){ /* a design that won't read still leaves the carriers from Pre-survey and Commissioning */ }
  for(const r of ((d.commission_cell||{}).poi||{}).rows||[]) if(r.carrier) s.add(r.carrier);
  return typeof carrierNames==="function"?carrierNames([...s]):[...s].filter(Boolean); }
// what the job's own records say about one item for one carrier: {status: "pass"|"fail"|"open"|null, why, files}
function coAuto(d, carrier, id, files){ const F=(files||[]).filter(f=>CO_FILES[id]&&CO_FILES[id].test(f)), CC=d.commission_cell||{};
  const T=typeof ccTests==="function"?ccTests(d):{}, mine=r=>!r.carrier||coSame(r.carrier, carrier)||coSame(carrier, r.carrier);
  if(id==="bom"){ const n=(d.bom||[]).length; return n?{status:"pass", why:`${n} line${n===1?"":"s"} on Materials`}:{status:null, why:"no bill of materials yet"}; }
  if(id==="sweep"){ const runs=(d.sweeps||{}).runs||[]; if(!runs.length) return {status:null, why:F.length?`${F.length} sweep file${F.length===1?"":"s"} in Files, not graded`:"no sweeps on PIM / sweeps", files:F};
    const G=typeof swGrade==="function"?runs.map(r=>swGrade(r, (typeof FR!=="undefined"&&FR.parts&&FR.parts.cables)||[])):[], bad=G.filter(g=>g.status==="fail").length, open=G.filter(g=>g.status!=="pass"&&g.status!=="fail").length;
    return {status:bad?"fail":open?"open":"pass", why:`${runs.length} run${runs.length===1?"":"s"}: ${runs.length-bad-open} pass${bad?`, ${bad} fail`:""}${open?`, ${open} not graded`:""}`, files:[...new Set([...F, ...runs.map(r=>r.file).filter(Boolean)])]}; }
  if(id==="pim"){ const P=d.pim||{}, runs=P.runs||[], lim=P.limit_dbc??-140; if(!runs.length) return {status:null, why:"no PIM runs on PIM / sweeps", files:F};
    const ok=r=>(+r.result_dbm)-(+r.tone_dbm)<=lim, left=runs.filter((r,i)=>!ok(r)&&!runs.slice(i+1).some(z=>String(z.where||"").startsWith(String(r.where||""))&&ok(z)));
    return {status:left.length?"fail":"pass", why:`${runs.length} run${runs.length===1?"":"s"} against ${lim} dBc${left.length?`; ${left.length} failed with no passing retest`:", each passing or retested to a pass"}`, files:[...new Set([...F, ...runs.map(r=>r.file).filter(Boolean)])]}; }
  if(id==="fiber"){ const G=typeof fbTests==="function"?fbTests(d):null, sor=((d.fiber||{}).links||[]).flatMap(l=>l.sor||[]), FF=[...new Set([...F, ...sor])];
    if(G&&G.status) return {status:G.status==="pass"?"pass":G.status==="fail"?"fail":"open", why:`${G.links.length} fiber link${G.links.length===1?"":"s"}: ${G.pass} pass${G.fail?`, ${G.fail} fail`:""}${G.open?`, ${G.open} not done`:""}${sor.length?`; ${sor.length} OTDR trace${sor.length===1?"":"s"}`:""}`, files:FF};
    return {status:null, why:FF.length?`${FF.length} fiber file${FF.length===1?"":"s"} in Files`:"no fiber results on PIM / sweeps / fiber", files:FF}; }
  if(id==="power"){ const R=((CC.poi||{}).rows||[]).filter(r=>mine(r)&&r.composite!=null&&r.composite!==""); return R.length?{status:T.poi?.status==="fail"?"fail":"pass", why:`${R.length} band${R.length===1?"":"s"} with composite power (Commissioning F)`}:{status:null, why:"no power levels for this carrier in Commissioning F"}; }
  if(id==="walk"){ let n=0; for(const fw of (d.walk||{}).floors||[]) for(const p of fw.pts||[]) for(const r of p.rs||[]) if(r.carrier&&(coSame(r.carrier, carrier)||coSame(carrier, r.carrier))) n++;
    return n?{status:"pass", why:`${n.toLocaleString()} walk reading${n===1?"":"s"} for ${carrier}`, files:F}:{status:null, why:"no walk readings for this carrier", files:F}; }
  if(id==="commission"){ const O=typeof ccOverall==="function"?ccOverall(d):null; return O&&O.status?{status:O.status==="pass"?"pass":O.status==="fail"?"fail":"open", why:`${O.done} of ${O.of} steps pass (Commissioning, Cellular)`}:{status:null, why:"nothing in Commissioning, Cellular"}; }
  if(id==="calls"){ const R=((CC.calls||{}).rows||[]).filter(r=>r.result&&mine(r)); if(!R.length) return {status:null, why:"no calls for this carrier in Commissioning H"};
    const bad=R.filter(r=>r.result!=="ok").length; return {status:bad?"fail":T.calls?.status==="fail"?"fail":"pass", why:`${R.length-bad} of ${R.length} calls ok${T.calls?.status==="fail"?`; ${T.calls.note.split(" · ")[0]}`:""}`}; }
  if(id==="alarm"){ const a=T.alarms; return a?{status:a.status==="pass"?"pass":a.status==="fail"?"fail":"open", why:a.note}:{status:null, why:"no alarm test in Commissioning G"}; }
  if(id==="consent"){ const A=(d.cellular||{}).approvals||{}, k=Object.keys(A).find(x=>coSame(x, carrier)||coSame(carrier, x)), a=k?A[k]:null;
    return a?.consent?{status:"pass", why:`consent dated ${a.consent}${a.contact?` (${a.contact})`:""}`, files:F}:{status:null, why:a?.asked?`asked ${a.asked}, no consent date yet`:"no consent recorded (Pre-survey, approvals)", files:F}; }
  if(F.length) return {status:null, why:`${F.length} file${F.length===1?"":"s"} in Files that look like it`, files:F};
  return {status:null, why:""}; }
// an item's state: a person's tick wins over the records; a failing record stays visible beside it
function coItem(d, carrier, id, files){ const t=((((d.closeout||{})[carrier])||{}).ticks||{})[id], a=coAuto(d, carrier, id, files);
  const done=t?.done===true||(t?.done!==false&&a.status==="pass");
  return {done, auto:a, tick:t||null}; }
function coCard(d, carrier, files){ const items=CO_ITEMS.map(([id,name,what])=>({id, name, what, ...coItem(d, carrier, id, files)})), own=(((d.closeout||{})[carrier])||{}).own||[];
  return {items, own, done:items.filter(x=>x.done).length+own.filter(o=>o.done).length, of:items.length+own.length}; }
// the index that goes in the zip: every item, its state, why, and the files beside it
function coIndex(d, carrier, card, name){ const row=x=>`<tr><td>${x.done?"&#10003;":"&#9744;"}</td><td><b>${esc(x.name)}</b><br><small>${esc(x.what)}</small></td><td>${esc(x.auto.why||"")}${x.tick?`<br><small>${x.tick.done?"Ticked":"Unticked"} by ${esc(x.tick.by||"")} ${esc(x.tick.at||"")}${x.tick.note?`: ${esc(x.tick.note)}`:""}</small>`:""}</td><td>${(x.auto.files||[]).map(esc).join("<br>")}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>${esc(carrier)} closeout: ${esc(name)}</title><style>body{font:14px Arial,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px;vertical-align:top;text-align:left}small{color:#555}</style>
    <h1>${esc(carrier)} closeout</h1><p>${esc(name)}${d.address?`, ${esc(d.address)}`:""}. ${card.done} of ${card.of} items in hand. No US carrier publishes an in-building closeout spec; the items follow the MCF Design Guidelines 2025 (Australia), owner specs and Viavi, and the carrier's own items are listed after them.</p>
    <table><tr><th></th><th>Item</th><th>What the records show</th><th>Files in this package</th></tr>${card.items.map(row).join("")}
    ${card.own.map(o=>`<tr><td>${o.done?"&#10003;":"&#9744;"}</td><td><b>${esc(o.name)}</b><br><small>the carrier's own item</small></td><td>${o.done?`ticked by ${esc(o.by||"")} ${esc(o.at||"")}`:""}</td><td></td></tr>`).join("")}</table>
    ${typeof ccRecord==="function"&&d.commission_cell?`<div style="margin-top:24px">${ccRecord(d, name)}</div>`:""}`; }

window.dasCloseout = async (el, j) => {
  if(!el) return;
  let d=j.data||{}, files=[];
  try{ files=((await api(`/api/das/jobs/${j.id}/files`)).files||[]).map(f=>f.name); }catch(e){ /* no file list: the items still tick from the records; only the file matches are missing */ }
  const who=()=>(S.me&&S.me.user)||((d.testing||{}).tester)||"";
  const now=()=>{ const t=new Date(), z=x=>String(x).padStart(2,"0"); return `${t.getFullYear()}-${z(t.getMonth()+1)}-${z(t.getDate())} ${z(t.getHours())}:${z(t.getMinutes())}`; };
  const keep=async co=>{ await post(`/api/das/jobs/${j.id}`, {data:{closeout:co}}); d={...d, closeout:co}; j={...j, data:d}; draw(); };
  const draw=()=>{ const cars=coCarriers(d);
    if(!cars.length){ el.innerHTML=`<div class="panel"><h3>Carrier closeout</h3><p class="hint" style="margin:0">No carrier on this job yet: add the LTE / 5G bands in Design, or the carriers in Pre-survey, and a closeout card shows for each.</p></div>`; return; }
    const open=el.dataset.open||cars[0];
    el.innerHTML=`<div class="panel"><h3>Carrier closeout <span class="hint">· one package per carrier</span></h3>
      <p class="hint" style="margin:0 0 8px">No US carrier publishes an in-building closeout spec. These items follow the ${`<a href="${CO_MCF}" target="_blank" rel="noopener">MCF Design Guidelines 2025</a>`} (Australia), owner specs and Viavi; what the job's records show ticks itself, and a person ticks the rest. When the carrier sends its own list, add its items to its card.</p>
      <div class="seg" id="coCars" style="margin-bottom:8px">${cars.map(c=>{ const k=coCard(d, c, files); return `<button data-car="${esc(c)}" class="${c===open?"on":""}">${esc(c)} · ${k.done} of ${k.of}</button>`; }).join("")}</div>
      <div id="coCard"></div></div>`;
    const card=coCard(d, open, files), box=el.querySelector("#coCard"), stc=x=>x.auto.status==="fail"?"var(--bad)":x.done?"var(--good)":"inherit";
    box.innerHTML=`<div class="tw"><table class="cm-t" id="coItems"><thead><tr><th></th><th>Item, and what the job's records show</th><th class="co-files">Files</th></tr></thead><tbody>
      ${card.items.map(x=>`<tr data-item="${x.id}"><td><input type="checkbox" data-tick="${x.id}" ${x.done?"checked":""} aria-label="${esc(x.name)} in hand" style="width:22px;height:22px"></td>
        <td style="white-space:normal"><b>${esc(x.name)}</b><div class="hint" style="font-size:11px">${esc(x.what)}</div>
          <div style="color:${stc(x)}">${esc(x.auto.why||"")}</div>${x.tick?`<div class="hint" style="font-size:11px">${x.tick.done?"ticked":"unticked"} by ${esc(x.tick.by||"")} ${esc(x.tick.at||"")}</div>`:""}</td>
        <td class="hint co-files" style="white-space:normal;font-size:11px">${(x.auto.files||[]).slice(0, 6).map(esc).join("<br>")}${(x.auto.files||[]).length>6?`<br>+${x.auto.files.length-6} more`:""}</td></tr>`).join("")}
      ${card.own.map((o,i)=>`<tr data-own="${i}"><td><input type="checkbox" data-owntick="${i}" ${o.done?"checked":""} aria-label="${esc(o.name)} in hand" style="width:22px;height:22px"></td><td><b>${esc(o.name)}</b><div class="hint" style="font-size:11px">${esc(open)}'s own item</div>${o.done?`<div class="hint" style="font-size:11px">ticked by ${esc(o.by||"")} ${esc(o.at||"")}</div>`:""}</td><td class="co-files"><button class="sm" data-ownrm="${i}" aria-label="Remove ${esc(o.name)}">✕</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px"><label class="grow">${esc(open)}'s own item<input id="coOwn" placeholder="from the carrier's closeout list, e.g. Shot list per their spec"></label><button id="coAdd">+ Add</button>
        <button class="primary" id="coZip">⇩ Build ${esc(open)} package (.zip)</button></div><p class="status" id="coMsg" style="margin:6px 0 0"></p>`;
    el.querySelectorAll("[data-car]").forEach(b=>b.onclick=()=>{ el.dataset.open=b.dataset.car; draw(); });
    const co=()=>JSON.parse(JSON.stringify(d.closeout||{})), mine=c=>{ c[open]=c[open]||{ticks:{}, own:[]}; c[open].ticks=c[open].ticks||{}; c[open].own=c[open].own||[]; return c[open]; };
    box.querySelectorAll("[data-tick]").forEach(i=>i.onchange=()=>{ const c=co(); mine(c).ticks[i.dataset.tick]={done:i.checked, by:who(), at:now()}; keep(c); });
    box.querySelectorAll("[data-owntick]").forEach(i=>i.onchange=()=>{ const c=co(), o=mine(c).own[+i.dataset.owntick]; Object.assign(o, {done:i.checked, by:who(), at:now()}); keep(c); });
    box.querySelectorAll("[data-ownrm]").forEach(b=>b.onclick=()=>{ const c=co(); mine(c).own.splice(+b.dataset.ownrm, 1); keep(c); });
    box.querySelector("#coAdd").onclick=()=>{ const v=box.querySelector("#coOwn").value.trim(); if(!v) return; const c=co(); mine(c).own.push({name:v.slice(0, 120), done:false}); keep(c); };
    box.querySelector("#coZip").onclick=async()=>{ const msg=box.querySelector("#coMsg"), K=coCard(d, open, files);
      const named={}; for(const x of K.items) if((x.auto.files||[]).length) named[x.id]=x.auto.files;
      msg.textContent="Building…";
      try{ const r=await fetch(`/api/das/jobs/${j.id}/closeout`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({carrier:open, index_html:coIndex(d, open, K, j.name), files:named})});
        if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||`HTTP ${r.status}`);
        const blob=await r.blob(), a=document.createElement("a"), cd=r.headers.get("content-disposition")||"", fn=decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/)||[])[1]||`${j.name} - ${open} closeout.zip`);
        a.href=URL.createObjectURL(blob); a.download=fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
        msg.textContent=`${fn}: ${K.done} of ${K.of} items in hand, ${Object.values(named).flat().length} files.`; }
      catch(e){ msg.textContent="Not built: "+e.message; } }; };
  draw();
};
window.coCard = coCard; window.coCarriers = coCarriers;
document.head.insertAdjacentHTML("beforeend", `<style>@media (max-width:600px){ #coItems .co-files{display:none} #coItems td{vertical-align:top} }</style>`);
