"use strict";
/* RF Recon — a DAS job's plans: a builder's PDF plan sheets turned into floor plan images for the grid test (pdf.js,
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

window.dasPlans = async (el, j, save) => {
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[];
  let cur=floors;  // kept up to date across saves, so a second page doesn't undo the first
  const [files, rm]=await Promise.all([api(`/api/das/jobs/${j.id}/files`).then(x=>x.files).catch(()=>[]), frLoad("plans")]);
  const pdfs=files.filter(x=>/\.pdf$/i.test(x.name)), imgs=files.filter(x=>/\.(png|jpe?g|gif|webp)$/i.test(x.name));
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
      <p class="hint" style="margin-top:0">A builder's PDF set: open it, then give each floor its page. The page is saved as an image with the job's files and goes under that floor's grid test. CAD files (DWG, DXF, Revit): ask for a PDF export.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
        <label class="grow">A PDF in this job's files<select id="plPdf"><option value="">Pick a PDF…</option>${pdfs.map(x=>`<option>${esc(x.name)}</option>`).join("")}</select></label>
        <label>or add one <input type="file" id="plNew" accept=".pdf,application/pdf"></label></div>
      <p class="hint" id="plMsg" style="margin:6px 0 0"></p>
      <div id="plPages" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-top:8px"></div>
      <h3 style="margin-top:14px">Plan images in this job</h3>
      ${imgs.length?`<div class="tw"><table><thead><tr><th>Image</th><th>Used under floor</th></tr></thead><tbody>${imgs.map(x=>`<tr><td><a href="/api/das/jobs/${j.id}/file?name=${encodeURIComponent(x.name)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${usedBy(x.name).map(esc).join(", ")||'<span class="hint">none</span>'}</td></tr>`).join("")}</tbody></table></div>`
        :'<p class="hint">None yet.</p>'}
      ${floors.length?"":'<p class="status err">Set the number of floors on the Overview first, so pages have floors to go to.</p>'}</div>
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
  if(d.lat!=null&&d.lon!=null) api(`/api/das/building?lat=${d.lat}&lon=${d.lon}`).then(b=>{
    const row=(k,v)=>v!=null&&v!==""?`<div>${k}</div><div>${esc(String(v))}</div>`:"";
    $("#plOsm").innerHTML=`<div class="kvg">${row("Name",b.name)}${row("Kind",b.kind)}${row("Levels",b.levels)}${row("Levels below ground",b.levels_below)}${row("Height",b.height_m!=null?`${b.height_m} m`:"")}
      ${row("Footprint",b.footprint_sqft?`${b.footprint_sqft.toLocaleString()} sq ft`:"")}${row("Wall material",b.material)}${row("Facade",b.facade)}${row("Roof",b.roof)}${row("Built",b.built)}</div>
      <p class="hint" style="margin:6px 0 0">${b.material||b.facade?"":"OpenStreetMap has no material for this building. "}${esc(b.source)}, <a href="https://www.openstreetmap.org/${esc(b.osm)}" target="_blank" rel="noopener">${esc(b.osm)} ↗</a></p>`;
  }).catch(e=>{ $("#plOsm").innerHTML=`<p class="hint">${esc(e.message)}</p>`; });
  // a PDF: pages as thumbnails, each with a floor to save it under
  const open=async name=>{
    $("#plMsg").textContent=`Opening ${name}…`; $("#plPages").innerHTML="";
    try{
      const lib=await pdfjs(), buf=await (await fetch(`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(name)}`)).arrayBuffer(), pdf=await lib.getDocument({data:buf}).promise;
      $("#plMsg").textContent=`${pdf.numPages} page${pdf.numPages===1?"":"s"}. Pick a floor under a page and save it as that floor's plan.`;
      for(let n=1;n<=pdf.numPages&&n<=60;n++){
        const blob=await pdfPagePng(pdf, n, 360), url=URL.createObjectURL(blob);
        const card=document.createElement("div"); card.className="panel"; card.style.margin="0"; card.style.padding="8px";
        card.innerHTML=`<img src="${url}" alt="Page ${n}" style="width:100%;border-radius:6px;background:#fff"><div class="row" style="gap:6px;margin-top:6px;align-items:center">
          <b>p${n}</b><select data-pg="${n}" style="flex:1"><option value="">Floor…</option>${floors.map(f=>`<option>${esc(f.name)}</option>`).join("")}</select><button data-save="${n}" ${floors.length?"":"disabled"}>Save</button></div>`;
        $("#plPages").appendChild(card);
      }
      $("#plPages").querySelectorAll("[data-save]").forEach(b=>b.onclick=async()=>{
        const n=+b.dataset.save, fl=$(`[data-pg="${n}"]`).value; if(!fl){ $("#plMsg").textContent=`Pick a floor for page ${n} first.`; return; }
        b.disabled=true; $("#plMsg").textContent=`Saving page ${n} as floor ${fl}'s plan…`;
        const png=await pdfPagePng(pdf, n), out=`${name.replace(/\.pdf$/i,"")} p${n} (floor ${fl}).png`.replace(/[\\/:*?"<>|]+/g,"-");
        await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(out)}`, {method:"POST", body:await png.arrayBuffer()});
        cur=cur.map(x=>x.name===fl?{...x, plan:out}:x); await save({floors:cur});
        $("#plMsg").textContent=`Saved: page ${n} is floor ${fl}'s plan (Grid test). ${Math.round(png.size/1024)} KB.`; b.textContent="Saved";
      });
    }catch(e){ $("#plMsg").textContent=`Couldn't open it: ${e.message}`; }
  };
  $("#plPdf").onchange=e=>{ if(e.target.value) open(e.target.value); };
  $("#plNew").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#plMsg").textContent=`Adding ${f.name} to the job's files…`;
    await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(f.name)}`, {method:"POST", body:await f.arrayBuffer()}); await open(f.name); };
};
