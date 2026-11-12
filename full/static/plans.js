"use strict";
/* DAStastic — a DAS job's plans: a builder's PDF plan sheets turned into floor plan images for the grid test (pdf.js,
   kept in static/vendor so it works offline), where plans come from and an email asking for them, what OpenStreetMap
   knows of the building, and the wall loss calculator (fieldref.js) from the building-materials research. */

let PDFJS = null;
async function pdfjs(){
  if(PDFJS) return PDFJS;
  await new Promise((ok, bad) => { const s=document.createElement("script"); s.src="static/vendor/pdfjs/pdf.min.js"; s.onload=ok; s.onerror=()=>bad(new Error("pdf.js didn't load")); document.head.appendChild(s); });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc="static/vendor/pdfjs/pdf.worker.min.js";
  return PDFJS=window.pdfjsLib;
}
// one page as a PNG about `px` wide (plan sheets are big: 2400 px keeps room numbers readable under the grid)
async function pdfPagePng(pdf, n, px=2400){
  const page=await pdf.getPage(n), v1=page.getViewport({scale:1}), vp=page.getViewport({scale:px/v1.width});
  const cv=document.createElement("canvas"); cv.width=Math.round(vp.width); cv.height=Math.round(vp.height);
  const cx=cv.getContext("2d"); cx.fillStyle="#fff"; cx.fillRect(0,0,cv.width,cv.height);
  await page.render({canvasContext:cx, viewport:vp}).promise;
  return new Promise(ok=>cv.toBlob(ok, "image/png"));
}
// the words on a PDF's pages, each page in its own shown frame, for readers.js
async function pdfWords(doc, max, step){ const out=[];
  for(let n=1;n<=Math.min(doc.numPages,max);n++){ const page=await doc.getPage(n), v=page.getViewport({scale:1}), t=await page.getTextContent();
    out.push({n, W:v.width, H:v.height, words:PlanLines.textWords(t.items, {transform:v.transform, width:v.width, height:v.height})}); step?.(n); }
  return out; }
// a PDF's bytes to its pages' words: {pages}, {locked} or {broken}. As intake.js readPdf: a PDF from outside never gets to run code through a crafted font
async function pdfRead(data, max=12){ const lib=await pdfjs(); let doc;
  try{ doc=await lib.getDocument({data, isEvalSupported:false, disableFontFace:true}).promise; }
  catch(e){ return e&&e.name==="PasswordException"?{locked:true}:{broken:true}; }
  try{ return {pages:await pdfWords(doc, max)}; }catch(e){ return {broken:true}; }finally{ doc.destroy(); } }
// the open plan set: {job, name, pdf, read, urls, rows}. Kept here because render() rebuilds this tab whenever a search lands, and the proposals mustn't go with it
const PLR={cur:null}, PL_READ_PAGES=300, PL_THUMBS=60;
const plWho=r=>`${r.sheet?`${r.sheet}, `:""}page ${r.page}`;

window.dasPlans = async (el, j, save) => {
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[];
  // kept up to date across saves, so a second page doesn't undo the first; and across redraws, as a redraw can answer from before a press that was still saving
  let J=PLR.j?.id===j.id&&(PLR.j.rev||0)>(j.rev||0)?PLR.j:j;
  const floorsNow=()=>Array.isArray(J.data.floors)?J.data.floors:[], keep=async(fn, did=()=>true)=>{
    // worked out on the job as it is, after this page's saves in flight (dasrev.js dasJobPatch), the floors as floor operations the server
    // applies to the job as it is (dasfloors.py): review round 6, the patch was built on a copy read outside the save queue, so a floor
    // change this page saved in between (the Overview's count) counted as Plans' own and was written over. fn(job data) gives the patch
    // ({floorOps, ...sections}) or false. It says it saved only when the job holds what the press did
    J=PLR.j=await window.dasJobPatch(j.id, cur=>fn(cur.data||{})); return !!did(J); };
  // a press works from the job as it is now, never from what this page was drawn with; a read, not a redraw, so the page's revision
  // stays the one its views were drawn from (review 11/11: it moved, and a header rename after a press overwrote another's unasked)
  const fresh=async()=>{ J=PLR.j=await api(`/api/das/jobs/${j.id}`, {dasRaw:true}); };
  const [files, rm]=await Promise.all([api(`/api/das/jobs/${j.id}/files`).then(x=>x.files).catch(()=>[]), frLoad("plans")]);
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const pdfs=files.filter(x=>/\.pdf$/i.test(x.name)).sort((a,b)=>(b.kind==="plan_set")-(a.kind==="plan_set")), imgs=files.filter(x=>/\.(png|jpe?g|gif|webp)$/i.test(x.name));
  const usedBy=name=>floors.filter(f=>f.plan===name).map(f=>f.name);
  const req=rm.empty?null:rm.plan_request;
  // the researched template's placeholders, filled from the job where it knows the answer
  const tech=S.das.contacts.find(c=>String(c.id)===String((d.contacts||{}).tech)), place=[j.name, d.address].filter(Boolean).join(", ");
  const fill=s=>(s||"").replaceAll("[Building name, address]", place).replaceAll("[Company]", tech?.org||"[Company]")
    .replaceAll("[Your name]", tech?.name||"[Your name]").replaceAll("[Email]", tech?.email||"[Email]").replaceAll("[Phone]", tech?.phone||"[Phone]")
    .replaceAll("[Title, company]", [tech?.role, tech?.org].filter(Boolean).join(", ")||"[Title, company]")
    .replaceAll("{building}", place).replaceAll("{client}", d.client||"").replaceAll("{job}", j.name);  // [Name] is both the recipient and the sender: left to fill
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Plan sheets</h3>
      <p class="hint" style="margin-top:0">A builder's PDF set: open it, then give each floor its page. The page is saved as an image with the job's files and goes under that floor's grid test. DAStastic reads the set's own words and proposes the floors, the scale and the critical areas: you press to accept. CAD files (DWG, DXF, Revit): ask for a PDF export.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label class="grow">A PDF in this job's files<select id="plPdf"><option value="">Pick a PDF…</option>${pdfs.map(x=>`<option>${esc(x.name)}</option>`).join("")}</select></label>
        <label>or add one <input type="file" id="plNew" accept=".pdf,application/pdf"></label></div>
      <p class="hint" id="plMsg" style="margin:6px 0 0"></p>
      <div id="plRead"></div>
      <div id="plPages" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:8px"></div>
      <h3 style="margin-top:14px">Plan images in this job</h3>
      ${imgs.length?`<div class="tw"><table><thead><tr><th>Image</th><th>Used under floor</th></tr></thead><tbody>${imgs.map(x=>`<tr><td><a href="/api/das/jobs/${j.id}/file?name=${encodeURIComponent(x.name)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${usedBy(x.name).map(esc).join(", ")||'<span class="hint">none</span>'}</td></tr>`).join("")}</tbody></table></div>`
        :'<p class="hint">None yet.</p>'}
      ${floors.length?"":'<p class="status err" id="plNoFloors">Set the number of floors on the Overview first, so pages have floors to go to.</p>'}</div>
    <div>
      <div class="panel"><h3>The building, from OpenStreetMap</h3><div id="plOsm"><p class="hint">${d.lat!=null?"Looking…":"Set the building's location on the Overview first."}</p></div></div>
      ${req?`<div class="panel"><h3>Ask for the plans</h3>
        <p class="hint" style="margin-top:0">To the owner, general contractor or architect. ${frCite(rm, req.sources)}</p>
        <label>Subject<input id="plSubj" value="${esc(fill(req.subject))}"></label>
        <label style="margin-top:6px">Message<textarea id="plBody" rows="10" style="width:100%">${esc(fill(req.body))}</textarea></label>
        <div class="row" style="margin-top:6px"><button id="plCopy">Copy the email</button><span class="hint" id="plCopied"></span></div></div>`:""}
    </div></div>
    ${rm.empty?frEmpty("building plans and materials"):`
    <div class="grid2">${frMaterialCalc(rm, "plmat")}<div class="panel"><h3>Where plans come from</h3>${frTable(rm, rm.plan_sources, [["source","Source"],["what_you_get","What you get"],["how","How"],["limits","Limits"]], {max:380})}</div></div>
    <div class="grid2"><div class="panel"><h3>What AHJs ask for</h3>${frTable(rm, rm.ahj_plan_rules, [["ahj","AHJ"],["requirement","Requirement"]], {max:320})}</div>
      <div class="panel"><h3>Open building data</h3>${frTable(rm, rm.open_data, [["name","Source"],["what","What"],["coverage","Coverage"],["access","Access"],["cost","Cost"]], {max:320})}</div></div>`}`;
  if(!rm.empty) frMaterialCalcWire(rm, "plmat");
  if($("#plCopy")) $("#plCopy").onclick=async()=>{ try{ await navigator.clipboard.writeText(`${$("#plSubj").value}\n\n${$("#plBody").value}`); $("#plCopied").textContent="Copied."; }catch(e){ $("#plCopied").textContent="Select the text and copy it."; } };
  // OpenStreetMap: footprint, levels, height and any material tags
  // The building the job already has (Overview's outline) shows at once; OpenStreetMap is asked only when there's none,
  // or on Refresh. Its public servers can take most of a minute from the server, so the panel says so and offers Try
  // again on a failure (11/3: it sat on "Looking…" and asked again on every visit).
  const osmShow=b=>{ const row=(k,v)=>v!=null&&v!==""?`<div>${k}</div><div>${esc(String(v))}</div>`:"";
    $("#plOsm").innerHTML=`<div class="kvg">${row("Name",b.name)}${row("Kind",b.kind)}${row("Levels",b.levels)}${row("Levels below ground",b.levels_below)}${row("Height",b.height_m!=null?`${b.height_m} m${b.height_est?" (estimate)":""}`:"")}
      ${row("Footprint",b.footprint_sqft?`${b.footprint_sqft.toLocaleString()} sq ft`:"")}${row("Wall material",b.material)}${row("Facade",b.facade)}${row("Roof",b.roof)}${row("Built",b.built)}</div>
      <p class="hint" style="margin:6px 0 0">${b.note?`${esc(b.note)}. `:""}${b.material||b.facade?"":"No material is recorded for this building. "}${esc(b.source||"")}${b.osm?`, <a href="https://www.openstreetmap.org/${esc(b.osm)}" target="_blank" rel="noopener">${esc(b.osm)} ↗</a>`:""}${b.fetched?` · as of ${esc(String(b.fetched).slice(0,10))}`:""}
        <button id="plOsmGo" style="margin-left:6px">Refresh from OpenStreetMap</button></p>`;
    $("#plOsmGo").onclick=()=>osmLook(true); };
  const osmLook=fresh=>{ if(!$("#plOsm")) return;
    $("#plOsm").innerHTML=`<p class="hint">Asking OpenStreetMap… Its public servers can take up to a minute when they're busy.</p>`;
    api(`/api/das/building?lat=${d.lat}&lon=${d.lon}${fresh?"&fresh=1":""}`).then(b=>{ if($("#plOsm")) osmShow(b); })  // the view may have been left meanwhile
      .catch(e=>{ if(!$("#plOsm")) return; $("#plOsm").innerHTML=`<p class="hint">${esc(e.message)}</p><button id="plOsmGo">Try again</button>`; $("#plOsmGo").onclick=()=>osmLook(true); }); };
  if(d.lat!=null&&d.lon!=null){ if(d.building&&(d.building.footprint_sqft||d.building.levels)) osmShow(d.building); else osmLook(false); }
  const say=t=>{ const m=$("#plMsg"); if(m) m.textContent=t; };
  // one page saved as an image with the job's files. The name the server kept (it never overwrites: a page saved again comes back as
  // "... (2).png"), and where the image came from, so the Design's wall tools can read the PDF's own lines (dswalls.js)
  const pagePng=async(P, n, fl)=>{ const png=await pdfPagePng(P.pdf, n), out=`${P.name.replace(/\.pdf$/i,"")} p${n} (floor ${fl}).png`.replace(/[\\/:*?"<>|]+/g,"-");
    const r=await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(out)}`, {method:"POST", body:await png.arrayBuffer()}), kept=r.saved||out;
    return {kept, src:{pdf:P.name, page:n, png:kept}, kb:Math.round(png.size/1024)}; };

  /* ---------- what the set's own words propose (readers.js): each line shows the words it came from, and only a press saves ---------- */
  // what a press on this line would do now. It never replaces a plan or a width that's there
  const rowNow=(P, r)=>{ const f=floorsNow().find(x=>x.name===r.floor), w=((J.data.design||{}).floors||{})[r.floor]?.width_ft, mine=!!f?.plan&&f.plan_src?.pdf===P.name&&f.plan_src?.page===r.page;
    return {f, w, mine, kept:!!f?.plan&&!mine, page:!f?.plan, fill:!!r.width_ft&&!w&&(!f?.plan||mine)}; };
  const rowFree=(P, r)=>{ const s=rowNow(P, r); return s.page||s.fill; };
  const useRow=async(P, r)=>{ const s=rowNow(P, r); if(!s.page&&!s.fill) return false;
    const pic=s.page?await pagePng(P, r.page, r.floor):null;
    // judged again on the job as it is: a plan or a width put on since stays (it never replaces either)
    return keep(d=>{ const f=(Array.isArray(d.floors)?d.floors:[]).find(x=>x.name===r.floor), all=(d.design||{}).floors||{}, out={}, ops=[];
      if(!f) ops.push({op:"add", name:r.floor});
      if(pic&&!(f&&f.plan)) ops.push({op:"set", name:r.floor, set:{plan:pic.kept, plan_src:pic.src}});
      if(ops.length) out.floorOps=ops;
      if(s.fill&&!(all[r.floor]||{}).width_ft) out.design={...(d.design||{}), floors:{...all, [r.floor]:{...(all[r.floor]||{}), width_ft:r.width_ft}}};
      return Object.keys(out).length?out:false; }, ()=>floorsNow().some(x=>x.name===r.floor&&(!pic||x.plan===pic.kept))); };
  // the critical squares under the labels, on a floor whose plan is this very page: the grid as it sits now (daswalk.js wkSquare)
  const squaresOf=(P, r)=>{ const f=floorsNow().find(x=>x.name===r.floor); if(!f?.plan||f.plan_src?.pdf!==P.name||f.plan_src?.page!==r.page||typeof wkSquare!=="function") return null;
    const skip=new Set(f.skip||[]), have=new Set(f.critical||[]), out=new Map();
    for(const l of r.labels||[]){ const g=wkSquare(l.x, l.y, f, r.H/r.W, true); if(g&&!skip.has(g)&&!have.has(g)&&!out.has(g)) out.set(g, l.s); }
    return out.size?{f, list:[...out]}:null; };
  const quote=s=>`<q class="rd-src">${esc(s)}</q>`;
  const drawRead=()=>{ const P=PLR.cur, box=$("#plRead"); if(!box||!P) return; const R=P.read, jobFl=floorsNow();
    P.rows=Readers.matchFloors(R, jobFl.map(f=>f.name));
    if(R.scan){ box.innerHTML=`<div class="rd" id="plReadScan"><p class="rd-say"><b>scan: needs a person</b></p><p class="hint" style="margin:2px 0 0">These pages have no words DAStastic can read: a scan, or a drawing with its text turned into shapes. It proposes nothing. Give each floor its page below.</p></div>`; return; }
    if(!P.rows.length&&!R.critical.length){ box.innerHTML=`<div class="rd" id="plReadNone"><p class="rd-say"><b>Nothing to propose</b></p><p class="hint" style="margin:2px 0 0">DAStastic read the words on ${R.read} page${R.read===1?"":"s"} and found no floor names, scale or critical areas in them. Give each floor its page below.</p></div>`; return; }
    const missing=P.rows.filter(r=>r.isNew), noSheet=jobFl.filter(f=>!P.rows.some(r=>r.floor===f.name)).map(f=>f.name);
    const line=(r,i)=>{ const s=rowNow(P, r), free=s.page||s.fill;
      return `<div class="rd-row" data-row="${i}"><div class="rd-what"><b>Floor ${esc(r.floor)}</b>${r.isNew?' <span class="tag w">not on the job yet</span>':""}<span class="hint">${esc(plWho(r))}${r.also.length?` · also on page ${r.also.join(", ")}`:""}</span></div>
        <div class="rd-why">${r.unnamed?`<span class="hint">The sheet doesn't say which floor. It's the only floor plan in the set:</span> `:""}${quote(r.title)}${r.scale?`<br>The sheet spans ${r.width_ft} ft, at ${esc(r.scale.label)}: ${quote(r.scale.words)}`:'<br><span class="hint">No scale in its words. Set the width on the Grid test.</span>'}</div>
        <div class="rd-do">${free?`<button class="sm" data-use="${i}">${s.page?"Use this page":"Use this width"}</button>`:`<span class="hint">${s.mine?`Done: this page is its plan${s.w?`, ${s.w} ft across`:""}.`:"It has a plan already: kept."}</span>`}${r.width_ft&&s.w&&s.w!==r.width_ft?`<span class="hint">Width ${s.w} ft stays.</span>`:""}</div></div>`; };
    const crit=R.critical, ticked=(J.data.require||{}).critical||[], open=crit.filter(c=>!ticked.includes(c.area));
    const cline=c=>`<div class="rd-row" data-crit="${esc(c.area)}"><div class="rd-what"><b>${esc(c.area)}</b></div><div class="rd-why">${c.where.slice(0,3).map(w=>`${quote(w.s)} <span class="hint">floor ${esc(P.rows.find(r=>r.key===w.floor)?.floor??w.floor)}</span>`).join(" · ")}${c.where.length>3?` <span class="hint">and ${c.where.length-3} more</span>`:""}</div>
      <div class="rd-do">${ticked.includes(c.area)?'<span class="hint">Ticked already.</span>':`<button class="sm" data-tick="${crit.indexOf(c)}">Tick it</button>`}</div></div>`;
    const sq=P.rows.map((r,i)=>({r, i, q:squaresOf(P, r)})).filter(x=>x.q);
    const useAll=P.rows.filter(r=>rowFree(P, r)).length;
    box.innerHTML=`<div class="rd" id="plReadBox"><h4>What this plan set says <span class="hint">· read from the words on ${R.read} page${R.read===1?"":"s"}. Check each line against the sheet: nothing is saved until you press.</span></h4>
      ${P.rows.length?`<div class="rd-head"><h5>Floors and pages</h5>${useAll?`<button class="primary sm" id="plUseAll">${useAll===1?"Use it":`Use all ${useAll}`}</button>`:""}${missing.length?`<button class="sm" id="plAddFl">Add ${missing.length===1?"the floor":"the floors"} only: ${esc(missing.map(r=>r.floor).join(", "))}</button>`:""}</div>
        <p class="hint rd-note">Each use saves the page as that floor's plan and fills its width. A floor that has a plan keeps it, and a width that's there stays. The width is the whole sheet's, not the building's: it sets the size of each grid square.${noSheet.length?` No sheet found for floor ${esc(noSheet.join(", "))}.`:""}</p>${P.rows.map(line).join("")}`:""}
      ${crit.length?`<div class="rd-head"><h5>Critical areas</h5>${open.length?`<button class="primary sm" id="plTickAll">${open.length===1?"Tick it":`Tick all ${open.length}`}</button>`:""}</div><p class="hint rd-note">Ticks the area on the Requirements tab. They're read from room labels: the AHJ's own list decides, and a room with no label won't show here.</p>${crit.map(cline).join("")}`:""}
      ${sq.length?`<div class="rd-head"><h5>Critical squares</h5></div><p class="hint rd-note">Where those labels fall on the grid as it sits now. A critical square has to meet the higher pass mark, so place the grid first (Grid test, Place grid).</p>
        ${sq.map(x=>`<div class="rd-row" data-sq="${x.i}"><div class="rd-what"><b>Floor ${esc(x.r.floor)}</b></div><div class="rd-why">${x.q.list.map(([g,s])=>`square ${g} ${quote(s)}`).join(" · ")}</div><div class="rd-do"><button class="sm" data-sq="${x.i}">Mark ${x.q.list.length===1?"it":"them"} critical</button></div></div>`).join("")}`:""}
      ${R.notes.length?`<ul class="rd-warn">${R.notes.map(n=>`<li>${esc(n.sheet||`Page ${n.page}`)}: ${esc(n.text)}</li>`).join("")}</ul>`:""}
      ${R.wordless.length?`<p class="hint rd-note">No words on page ${R.wordless.slice(0,12).join(", ")}${R.wordless.length>12?` and ${R.wordless.length-12} more`:""}: scans, or text turned into shapes. Those pages need a person.</p>`:""}</div>`; };
  const after=()=>{ drawRead(); const fl=floorsNow(); $("#plNoFloors")?.remove();  // floors a press added go on the pages' lists; what's picked stays picked
    document.querySelectorAll("#plPages select[data-pg]").forEach(s=>{ const v=s.value; s.innerHTML=`<option value="">Floor…</option>${fl.map(f=>`<option>${esc(f.name)}</option>`).join("")}`; s.value=v; });
    document.querySelectorAll("#plPages [data-save]").forEach(b=>{ if(b.textContent!=="Saved") b.disabled=!fl.length; }); cards(); };
  // a proposal on its page too: the thumbnails are where this used to be picked by hand
  const cards=()=>{ const P=PLR.cur; if(!P) return; document.querySelectorAll("#plPages [data-card]").forEach(c=>{ const n=+c.dataset.card, on=(P.rows||[]).map((r,i)=>({r,i})).filter(x=>x.r.page===n), b=c.querySelector(".rd-on");
    b.innerHTML=on.map(({r,i})=>`<span>Proposed: floor ${esc(r.floor)}</span>${rowFree(P, r)?` <button class="sm" data-use="${i}">Use</button>`:""}`).join("<br>"); b.hidden=!on.length; }); };
  const onRead=async e=>{ const b=e.target.closest("button"), P=PLR.cur; if(!b||!P||P.busy) return; const a=b.dataset;
    if(a.save==null&&a.use==null&&a.tick==null&&a.sq==null&&!["plUseAll","plAddFl","plTickAll"].includes(b.id)) return;
    if(a.save!=null&&!$(`[data-pg="${a.save}"]`).value){ say(`Pick a floor for page ${a.save} first.`); return; }
    P.busy=true; b.disabled=true;
    try{ await fresh();
      if(a.save!=null){ const n=+a.save, fl=$(`[data-pg="${n}"]`).value;
        // the floor picked under the page was drawn earlier: one taken off since gets no page image uploaded for it (review round 7)
        if(!floorsNow().some(x=>x.name===fl)){ say(`Floor ${fl} isn't on the job any more: it was taken off since this tab was drawn. Nothing was saved.`); P.busy=false; after(); return; }
        say(`Saving page ${n} as floor ${fl}'s plan…`);
        const pic=await pagePng(P, n, fl), ok=await keep(()=>({floorOps:[{op:"set", name:fl, set:{plan:pic.kept, plan_src:pic.src}}]}), ()=>floorsNow().some(x=>x.name===fl&&x.plan===pic.kept));
        say(ok?`Saved: page ${n} is floor ${fl}'s plan (Grid test). ${pic.kb} KB.`:"Not saved."); if(ok) b.textContent="Saved"; }
      else if(a.use!=null){ const r=P.rows[+a.use]; say(`Saving ${plWho(r)} as floor ${r.floor}'s plan…`); say(await useRow(P, r)?`Saved: ${plWho(r)} is floor ${r.floor}'s plan (Grid test).`:"Not saved."); }
      else if(b.id==="plUseAll"){ const list=P.rows.filter(r=>rowFree(P, r)); let n=0; for(const r of list){ say(`Saving floor ${r.floor}, ${n+1} of ${list.length}…`); if(await useRow(P, r)) n++; else break; } say(`Saved ${n} of ${list.length}. Floors that had a plan kept it.`); }
      else if(b.id==="plAddFl"){ const add=P.rows.filter(r=>r.isNew).map(r=>r.floor); say(await keep(()=>({floorOps:add.map(name=>({op:"add", name}))}), ()=>add.every(n=>floorsNow().some(x=>x.name===n)))?`Added floor ${add.join(", ")}.`:"Not saved."); }
      else if(a.tick!=null||b.id==="plTickAll"){ const crit=P.read.critical, pick=a.tick!=null?[crit[+a.tick].area]:crit.map(c=>c.area), set=new Set((J.data.require||{}).critical||[]); pick.forEach(x=>set.add(x));
        say(await keep(d=>({require:{...(d.require||{}), critical:[...new Set([...((d.require||{}).critical||[]), ...set])]}}), ()=>pick.every(x=>((J.data.require||{}).critical||[]).includes(x)))?`Ticked on the Requirements tab: ${pick.join(", ")}.`:"Not saved."); }
      else if(a.sq!=null){ const r=P.rows[+a.sq], q=squaresOf(P, r); if(q) say(await keep(()=>({floorOps:[{op:"union", name:r.floor, key:"critical", values:q.list.map(y=>y[0])}]}), ()=>q.list.every(y=>(floorsNow().find(x=>x.name===r.floor)?.critical||[]).includes(y[0])))?`Floor ${r.floor}: square ${q.list.map(y=>y[0]).join(", ")} marked critical.`:"Not saved."); }
    }catch(err){ say(`Not saved: ${err.message}`); }
    P.busy=false; after(); };
  // the open set on the page: its proposals at once, then its pages. Floor plans past the thumbnails' limit still get a card, so a proposal never points at nothing
  const show=async()=>{ const P=PLR.cur, pg=$("#plPages"); if(!P||!pg) return;
    drawRead(); pg.innerHTML=""; $("#plRead").onclick=onRead; pg.onclick=onRead;
    const n1=P.pdf.numPages, list=Array.from({length:Math.min(n1, PL_THUMBS)}, (_,i)=>i+1); for(const r of P.rows||[]) if(!list.includes(r.page)) list.push(r.page);
    say(`${n1} page${n1===1?"":"s"}${n1>P.read.read?`, words read on the first ${P.read.read}`:""}. Pick a floor under a page and save it as that floor's plan.`);
    for(const n of list){ let url=P.urls.get(n);
      if(!url){ const blob=await pdfPagePng(P.pdf, n, 360); if(PLR.cur!==P||!pg.isConnected) return; url=URL.createObjectURL(blob); P.urls.set(n, url); }
      if(!pg.isConnected) return;
      const card=document.createElement("div"); card.className="panel"; card.style.margin="0"; card.style.padding="8px"; card.dataset.card=n;
      card.innerHTML=`<img src="${url}" alt="Page ${n}" style="width:100%;border-radius:6px;background:#fff"><p class="rd-on" hidden></p><div class="row" style="gap:6px;margin-top:6px;align-items:center">
        <b>p${n}</b><select data-pg="${n}" style="flex:1" aria-label="Floor for page ${n}"><option value="">Floor…</option>${floorsNow().map(f=>`<option>${esc(f.name)}</option>`).join("")}</select><button data-save="${n}" ${floorsNow().length?"":"disabled"}>Save</button></div>`;
      pg.appendChild(card); }
    cards(); };
  // a PDF: its words read for proposals, its pages as thumbnails, each with a floor to save it under
  const open=async name=>{
    PLR.asked=name; say(`Opening ${name}…`); $("#plPages").innerHTML=""; $("#plRead").innerHTML="";
    try{
      const lib=await pdfjs(), buf=await (await fetch(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(name)}`)).arrayBuffer(), pdf=await lib.getDocument({data:buf,isEvalSupported:false}).promise;
      const pages=await pdfWords(pdf, PL_READ_PAGES, n=>say(`Reading the words on page ${n} of ${pdf.numPages}…`));
      if(!el.isConnected||PLR.asked!==name){ pdf.destroy(); return; }  // the view moved on, or another PDF was picked meanwhile
      const NY=/\bNY\b|New York/i.test(d.address||""), read=Readers.planSet(pages, {areas:DAS.critical_areas.filter(a=>NY||!/\(NY\)/.test(a))});
      if(PLR.cur){ PLR.cur.urls.forEach(u=>URL.revokeObjectURL(u)); PLR.cur.pdf.destroy(); }
      PLR.cur={job:j.id, name, pdf, read, urls:new Map()};
      await show();
    }catch(e){ say(`Couldn't open it: ${e.message}`); }
  };
  $("#plPdf").onchange=e=>{ if(e.target.value) open(e.target.value); };
  // came here from a dropped plan set; or a redraw: the set that was open stays open
  const asked=S.das.readDoc?.job===j.id?S.das.readDoc.name:null; if(asked) delete S.das.readDoc;
  const again=asked&&pdfs.some(x=>x.name===asked)?asked:null;
  if(again){ $("#plPdf").value=again; open(again); }
  else if(PLR.cur?.job===j.id&&pdfs.some(x=>x.name===PLR.cur.name)){ $("#plPdf").value=PLR.cur.name; show(); }
  $("#plNew").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#plMsg").textContent=`Adding ${f.name} to the job's files…`;
    await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(f.name)}`, {method:"POST", body:await f.arrayBuffer()}); await open(f.name); };
};
