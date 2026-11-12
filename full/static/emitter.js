"use strict";
/* DAStastic — one emitter. Click one on the map (its popup) or in its details to see:
   - Coverage: where it reaches, as a heatmap, the edge of its coverage, its antenna pattern and the path to the pin
     (estimates: free space or Hata, the antenna pattern when known, hills from the terrain data);
   - Network: its licence's base stations and mobiles, the same system under other call signs, simulcast sites,
     others sharing its channels, the tower, the channel's other users, microwave sites, your labels and talk groups;
   - Cell site: for a cell, its global cell ID, the site's sectors with their estimated directions, and the tower.
   The overlays stay on the map until the panel is closed. Since 11/10 (Cody, after Andy's demo on 11/9) it all shows in the
   results viewer inside the map's frame (results.js), with the entry's details as a tab; nothing fits or pans the map by
   itself, and "Zoom to" in the viewer shows the whole of what a tab draws. */

const EM_MODELS = [["suburban", "Hata, suburban"], ["urban", "Hata, urban"], ["open", "Hata, open land"], ["free", "Free space (best case)"]];
const EM_RX = [[1.5, "1.5 m: handheld / vehicle"], [3, "3 m"], [10, "10 m: rooftop / donor antenna"], [30, "30 m"]];
const CELL_BANDS = [[617, "600 MHz (B71 / n71)"], [739, "700 MHz (B12 / B13 / B14 / B17)"], [869, "850 MHz (B5 / B26)"], [1960, "1900 MHz PCS (B2 / B25)"],
  [2125, "AWS 1700/2100 (B4 / B66)"], [2350, "WCS 2300 (B30)"], [2600, "2.5 GHz (B41 / n41)"], [3700, "C-band 3.7 GHz (n77)"]];
const CELL_RE = /(\d{3})[-_]?(\d{2,3})[-_](\d+)[-_](\d+)/;
const emIsCell = r => !!r._cell || (["LTE", "NR", "GSM", "UMTS", "WCDMA"].includes(String(r.kind || "").toUpperCase()) && CELL_RE.test(String(r.ext_id || r.ident || "")));
const emIsUls = r => (r.layer === "uls" || r.layer === "uls_hist") && !!r.call_sign;
const emSurvey = r => ["captures", "wigle", "opencellid", "custom"].includes(r.layer) && (r.dbm != null || r.ident || r.freq_mhz);
const emName = r => r._cell ? `${r._cell.operator} ${r._cell.radio} ${r._cell.site_kind.split(" ")[0]} ${r._cell.site_id}` : titleOf(r);

function emDefaults(r){
  if(r._cell){ const c=r._cell, t=r._site?.tower;
    return {model:"suburban", terrain:true, threshold:-110, rx:1.5, radius:"", only:false, opacity:.7, eirp:30, freq:739,
      h: t?.overall_agl_m ? Math.max(10, Math.round(t.overall_agl_m-3)) : 30, haat:"", az:c.az_est??"", bw:c.az_est!=null?65:"", cell:true}; }
  return {model:"suburban", terrain:true, threshold:-95, rx:1.5, radius:"", only:false, opacity:.7, eirp:"", freq:r.freq_mhz,
    h:r.height_tip_m ?? 30, haat:r.haat_m ?? "", az:r.azimuth ?? "", bw:r.beamwidth ?? "", cell:false};
}

// a dot clicked on the map (or a list or table row): everything at that spot in the results viewer on the map, lit up in the
// list and the table. The map and the page stay where they are (11/10: the panel under the map scrolled the page to it)
document.head.insertAdjacentHTML("beforeend", `<style>#mapTable tr.sel td{background:color-mix(in srgb,var(--accent) 22%,transparent)}</style>`);
// a pick inside a list or table that scrolls by itself is brought into view there: that box scrolls, never the page
function emInView(box, el){
  if(!box || !el || box.scrollHeight<=box.clientHeight+1) return;
  const b=box.getBoundingClientRect(), r=el.getBoundingClientRect(), top=b.top+(box.querySelector("thead")?.offsetHeight||0);  // a sticky header covers its top (review 11/11)
  if(r.top<top) box.scrollTop-=top-r.top+4; else if(r.bottom>b.bottom) box.scrollTop+=r.bottom-b.bottom+4;
}
window.emInView = emInView;
function emitSpot(rs, pick){
  const items=groupItems(rs), fids=new Set(items.map(r=>r.fid));
  $$("#mapTable tr[data-fid]").forEach(tr=>tr.classList.toggle("sel", fids.has(tr.dataset.fid)));
  const first=$$("#mapTable tr.sel")[0]; if(first) emInView(first.closest(".tw"), first);
  if(!items.length) return;
  const key=`${items[0].lat},${items[0].lon}`, r=(pick&&(items.find(x=>x.fid===pick.fid)||pick))||items[0];
  const e=S.emit;
  if(e && e.key===key && e.site){ if(pick && e.r!==r){ Object.assign(e, {r, tab:"detail", opt:emDefaults(r), cov:null, net:null, cell:null, err:{}, mark:null}); emitPanel(); emitDraw(); } return; }
  S.emit={key, r, site:items, tab:pick||items.length===1?"detail":"info", opt:emDefaults(r), cov:null, net:null, cell:null, err:{}};
  emitPanel(); emitDraw();
}
window.emitSpot = emitSpot;
function emitNoSpot(r){
  if(!S.map || !window.RFResults){ openDetail(r.fid); return; }
  if(S.emit) emitClose();  // the spot shown before, and what it drew, go: this one has no place on the map
  $$("#mapTable tr[data-fid]").forEach(tr=>tr.classList.toggle("sel", tr.dataset.fid===r.fid));  // lit in the table, the last spot's rows not
  const draw=()=>RFResults.show(S.map, {key:`fid:${r.fid}`, label:titleOf(r), title:detailTitle(r), sub:"No location on file (a mobile or area entry)",
    fill:body=>fillDetail(body, r, {saved:()=>{ render(); draw(); }})});
  draw();
}
window.emitNoSpot = emitNoSpot;
// a row picked in the map's table shows in the viewer, as a dot does; the map stays where it is
document.addEventListener("click", ev=>{ const tr=ev.target.closest("#mapTable tr[data-fid]"); if(!tr||ev.target.closest("a,button")) return;
  const r=S.rows.find(x=>x.fid===tr.dataset.fid); if(!r) return;
  selectFeature(r); if(r.lat==null) emitNoSpot(r); else emitSpot(S.rows.filter(x=>x.lat===r.lat&&x.lon===r.lon), r); });

// one emitter's coverage, network or cell site (tab = coverage | network | cell) in the Map tab's viewer; from another tab
// it's the explicit way to the Map tab (an Analyzer row's details, Search's Network and Coverage, Show on map)
function emitOpen(r, tab){
  if(!r || r.lat==null){ $("#status").textContent="That entry has no location to work from."; return; }
  S.emit = {key:`${r.lat},${r.lon}`, r, tab: tab || (emIsCell(r) ? "cell" : "coverage"), opt: emDefaults(r), cov:null, net:null, cell:null, err:{}};
  try{ $("#dlg").close(); }catch(e){ /* the dialog was already closed */ }
  if(S.tab!=="map") setTab("map"); else { emitPanel(); emitDraw(); }
  emitLoad();
}
window.emitOpen = emitOpen;
function emitClose(){ S.emit=null; if(S.emitLayer&&S.map) S.map.removeLayer(S.emitLayer); S.emitLayer=null; if(S.map&&window.RFResults) RFResults.close(S.map, false); }

async function emitLoad(){
  const e=S.emit; if(!e) return;
  const t=e.tab;
  try{
    if(t==="coverage" && !e.cov){ e.busy=true; emitPanel(); e.cov=await api("/api/coverage?"+emCovQuery()); }
    if(t==="network" && !e.net && emIsUls(e.r)){ e.busy=true; emitPanel();
      e.net=await api(`/api/network?${new URLSearchParams({call_sign:e.r.call_sign, freq:e.r.freq_mhz??"", lat:e.r.lat, lon:e.r.lon, tower:e.r.tower_reg||""})}`); }
    if(t==="cell" && !e.cell){ e.busy=true; emitPanel(); e.cell=await emCellSite(e.r); }
    e.err[t]=null;
  }catch(err){ e.err[t]=err.message; }
  if(S.emit!==e) return;
  e.busy=false; emitPanel(); emitDraw();  // nothing fits the map by itself (11/10): the viewer's Zoom to shows the whole of it
}

function emCovQuery(){
  const e=S.emit, r=e.r, o=e.opt, p=new URLSearchParams();
  const set=(k,v)=>{ if(v!==""&&v!=null&&!Number.isNaN(v)) p.set(k,v); };
  set("lat",r.lat); set("lon",r.lon); set("freq",o.freq); set("model",o.model); p.set("terrain",o.terrain?1:0); set("threshold",o.threshold);
  set("rx",o.rx); set("h",o.h); set("haat",o.haat); set("az",o.az); set("bw",o.bw); set("radius",o.radius); if(o.only) p.set("only",1);
  if(o.eirp!==""&&o.eirp!=null) set("eirp",o.eirp); else { set("erp",r.erp_w); set("power",r.power_out_w); set("gain",r.gain_dbi); }
  if(S.center && !(Math.abs(S.center[0]-r.lat)<1e-6 && Math.abs(S.center[1]-r.lon)<1e-6)){ set("plat",S.center[0]); set("plon",S.center[1]); }
  set("name", emName(r));
  return p.toString();
}

async function emCellSite(r){
  if(r._site) return r._site;
  const m=CELL_RE.exec(String(r.ext_id||r.ident||"")); if(!m) throw new Error("This cell's ID isn't in a form DAStastic can read (MCC-MNC-area-cell).");
  const res=await api(`/api/cells?lat=${r.lat}&lon=${r.lon}&radius=2`);
  // the operator too (MCC and MNC): two operators' cells can share a cell ID within 2 mi
  for(const s of res.sites) for(const c of s.cells) if(c.mcc===m[1] && +c.mnc===+m[2] && +c.cid===+m[4]){ r._cell=c; r._site=s; S.emit.opt=Object.assign(emDefaults(r), {}); return s; }
  throw new Error("No site found for this cell.");
}

/* ---------- the results viewer on the Map tab (results.js) ---------- */
// the tabs an entry has: everything at its spot, its details, and its coverage, network or cell site
function emTabs(e){ const r=e.r;
  return [...(e.site&&e.site.length>1?[{id:"info", label:`On this spot (${e.site.length})`}]:[]), ...(r.fid?[{id:"detail", label:"Details"}]:[]),
    ...((erpOf(r)||emIsCell(r))&&r.layer!=="towers"?[{id:"coverage", label:"Coverage"}]:[]), ...(emIsUls(r)?[{id:"network", label:"Network"}]:[]),
    ...(emIsCell(r)?[{id:"cell", label:"Cell site"}]:[])]; }
function emitPanel(){
  const e=S.emit; if(!S.map || !window.RFResults) return;
  if(!e){ RFResults.close(S.map, false); return; }
  const r=e.r, tabs=emTabs(e); if(!tabs.some(t=>t.id===e.tab)) e.tab=tabs[0]?.id;
  const go=t=>{ e.tab=t; e.mark=null; emitPanel(); emitDraw(); emitLoad(); };
  RFResults.show(S.map, {key:`em:${e.key}`, label:emName(r),
    title:`◎ ${r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span> · `:""}${esc(emName(r))}`,
    sub:[esc(r._cell?r._cell.radio:typeOf(r)), r.dist_mi!=null?`${num(r.dist_mi,2)} mi ${esc(r.compass||"")} from the pin`:""].filter(Boolean).join(" · "),
    tabs, tab:e.tab, onTab:go,
    fill:body=>{
      if(e.busy){ body.innerHTML='<p class="status">Working it out…</p>'; return; }
      if(e.err[e.tab]){ body.innerHTML=`<p class="status err">${esc(e.err[e.tab])}</p>`; return; }
      if(e.tab==="info") emSpotBody(body); else if(e.tab==="detail") fillDetail(body, r, {go});
      else if(e.tab==="coverage") emCoverageBody(body); else if(e.tab==="network") emNetworkBody(body); else emCellBody(body); },
    actions:emSurvey(r)&&(r.dbm!=null||r.ident||r.ext_id||r.freq_mhz)?[{label:"Measured heatmap", title:"Measured heatmap of this signal from your survey data",
      run:()=>{ S.heat.kind="measured"; S.heat.ident=r.ident||(r.ext_id||"").replace(/^\w+:/,"")||""; S.heat.freq=r.ident||r.ext_id?"":(r.freq_mhz??""); S.heat.signal=emName(r); render(); loadHeat(); }}]:[],
    zoom:()=>emZoomPts(e), onClose:emitClose}, [r.lat, r.lon]);
}

// everything at the clicked spot; pick one to see its coverage, network or details
function emSpotBody(el){
  const e=S.emit, rs=e.site;
  el.innerHTML=`<div class="tw" style="max-height:340px"><table><thead><tr><th>MHz</th><th>What</th><th>Type</th><th>Source</th><th>Station</th><th class="n">Power</th><th class="n">Level</th><th class="n">Height</th><th></th></tr></thead><tbody>
    ${rs.map((r,i)=>{ const lvl=levelOf(r); return `<tr data-i="${i}" style="cursor:pointer${r===e.r?";font-weight:700":""}"><td class="mono">${r.freq_mhz?fmtF(r.freq_mhz):""}</td>
      <td>${esc(titleOf(r))}${r.call_sign?` <span class="mono hint">${esc(r.call_sign)}</span>`:""}</td><td>${esc(typeOf(r))}</td><td>${esc(LAYERS[r.layer]?.label||r.layer)}${r.also_in?.length?` <span class="hint">+ ${esc(r.also_in.join(", "))}</span>`:""}</td>
      <td>${esc(r.station_class?classLabel(r.station_class):r.kind||"")}</td><td class="n">${erpOf(r)?num(erpOf(r))+" W":""}</td><td class="n">${lvl!=null?`${num(lvl,0)} dBm${r.dbm==null?" est":""}`:""}</td>
      <td class="n">${r.height_tip_m!=null?`${num(r.height_tip_m,0)} m`:r.overall_agl_m!=null?`${num(r.overall_agl_m,0)} m`:""}</td>
      <td style="white-space:nowrap">${(erpOf(r)||emIsCell(r))&&r.layer!=="towers"?`<button data-go="coverage" data-i="${i}">Coverage</button> `:""}${emIsUls(r)?`<button data-go="network" data-i="${i}">Network</button> `:""}${emIsCell(r)?`<button data-go="cell" data-i="${i}">Cell site</button> `:""}<button data-go="detail" data-i="${i}">Details</button></td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint">${rs[0].dist_mi!=null?`${num(rs[0].dist_mi,2)} mi ${esc(rs[0].compass||"")} from the pin · `:""}${rs[0].lat.toFixed(5)}, ${rs[0].lon.toFixed(5)}. Click an entry to pick it, or a button to see its coverage, network or full details.</p>`;
  el.querySelectorAll("tr[data-i]").forEach(tr=>tr.onclick=ev=>{ const r=rs[+tr.dataset.i], b=ev.target.closest("[data-go]");
    e.r=r; e.opt=emDefaults(r); e.cov=e.net=e.cell=null; e.err={}; e.mark=null;
    if(b){ e.tab=b.dataset.go; emitPanel(); emitDraw(); emitLoad(); } else { emitPanel(); emitDraw(); } });
}

function emCoverageBody(el){
  const e=S.emit, o=e.opt, c=e.cov;
  const inp=(k,lab,w,extra)=>`<label class="inl" ${extra||""}>${lab} <input data-o="${k}" type="number" step="any" value="${esc(o[k]??"")}" style="width:${w}px"></label>`;
  el.innerHTML=`<div class="maptools" style="flex-wrap:wrap;gap:8px;margin:0">
      <label class="inl">Model <select data-o="model">${EM_MODELS.map(([k,l])=>`<option value="${k}" ${o.model===k?"selected":""}>${l}</option>`).join("")}</select></label>
      <label class="inl" title="Hills between the transmitter and each place (AWS Terrain Tiles, cached on this PC)"><input type="checkbox" data-o="terrain" ${o.terrain?"checked":""}> Terrain</label>
      ${o.cell?`<label class="inl">Band <select data-o="freq">${CELL_BANDS.map(([f,l])=>`<option value="${f}" ${+o.freq===f?"selected":""}>${l}</option>`).join("")}</select></label>`:inp("freq","MHz",90)}
      ${inp("threshold", o.cell?"Edge at (RSRP dBm)":"Edge at (dBm)", 70)}
      <label class="inl">Receiver <select data-o="rx">${EM_RX.map(([v,l])=>`<option value="${v}" ${+o.rx===v?"selected":""}>${l}</option>`).join("")}</select></label>
      ${inp("radius","Radius (mi, blank = auto)",64)}
      <label class="inl"><input type="checkbox" data-o="only" ${o.only?"checked":""}> Only where it reaches the edge level</label>
      <label class="inl">Opacity <input type="range" min="0.1" max="1" step="0.05" value="${o.opacity}" id="emOp" style="width:80px"></label></div>
    <details style="margin:6px 0"><summary class="hint">Transmitter settings (from the ${o.cell?"tower record and typical macro sites":"licence"}; change any)</summary>
      <div class="maptools" style="flex-wrap:wrap;gap:8px;margin:6px 0 0">${inp("eirp", o.cell?"EIRP per reference signal (dBm)":"EIRP (dBm, blank = from the licence)", 70)}
        ${inp("h","Antenna height above ground (m)",64)}${inp("haat","HAAT (m)",64)}${inp("az","Azimuth (°)",60)}${inp("bw","Beamwidth (°)",60)}</div>
      ${o.cell?`<p class="hint">A cell's power isn't public. 30 dBm per reference signal is a typical macro site (40 W over a 20 MHz carrier, 17 dBi antenna); RSRP −110 dBm is the usual edge of usable LTE.</p>`:""}</details>
    ${c?emCovResults(c):""}
    <div class="row" style="margin-top:8px;gap:6px"><button id="emKmz">⇩ KMZ (Google Earth)</button><button id="emTak">⇩ ATAK</button></div>`;
  el.querySelectorAll("[data-o]").forEach(i=>i.onchange=()=>{ const k=i.dataset.o; o[k]=i.type==="checkbox"?i.checked:i.tagName==="SELECT"&&k==="model"?i.value:(i.value===""?"":+i.value);
    e.cov=null; emitLoad(); });
  $("#emOp").oninput=ev=>{ o.opacity=+ev.target.value; if(S.emitHeat) S.emitHeat.setOpacity(o.opacity); };
  $("#emKmz").onclick=()=>{ if(!c) return;  // built here, so it works in the web version too
    const x=s=>String(s??"").replace(/[<>&]/g,ch=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[ch])), nm=emName(e.r), [[s,w],[n,ea]]=c.bounds;
    const ring=[...c.contour, c.contour[0]].map(([la,lo])=>`${lo.toFixed(6)},${la.toFixed(6)},0`).join(" ");
    const kml=`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(nm)} coverage</name>`
      +`<GroundOverlay><name>${x(nm)} coverage</name><description>${x(c.desc)}</description><color>c8ffffff</color><Icon><href>coverage.png</href></Icon>`
      +`<LatLonBox><north>${n}</north><south>${s}</south><east>${ea}</east><west>${w}</west></LatLonBox></GroundOverlay>`
      +`<Placemark><name>${x(nm)}</name><Point><coordinates>${e.r.lon},${e.r.lat},0</coordinates></Point></Placemark>`
      +`<Placemark><name>Edge at ${c.threshold} dBm</name><Style><LineStyle><color>ff20a0f0</color><width>3</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${ring}</coordinates></LineString></Placemark></Document></kml>`;
    const bytes=RFTak.zip([{name:"doc.kml", data:kml}, {name:"coverage.png", data:Uint8Array.from(atob(c.png), ch=>ch.charCodeAt(0))}]);
    const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([bytes],{type:"application/vnd.google-earth.kmz"}));
    a.download=`${nm.replace(/[\\/:*?"<>|]+/g,"-").slice(0,80)} coverage.kmz`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000); };
  $("#emTak").onclick=()=>{ if(!c) return; RFTak.save({rows:[e.r], center:[e.r.lat,e.r.lon], radius:c.radius_mi, name:`DAStastic - ${emName(e.r)} coverage`, colorOf, typeOf, fccDate:null,
    heat:{png:c.png, bounds:c.bounds, desc:c.desc}}); };
}

function emCovResults(c){
  const p=c.pin, edge=c.threshold;
  return `<div class="grid2" style="margin-top:8px">
    <div><p style="margin:0 0 6px">Reaches <b>${edge} dBm</b> out to <b>${num(c.reach_mi.max,1)} mi</b> at best, ${num(c.reach_mi.median,1)} mi typically and ${num(c.reach_mi.min,1)} mi at worst${c.reach_mi.beyond?` (${c.reach_mi.beyond}% of directions reach past the ${num(c.radius_mi,1)} mi shown)`:""}.</p>
      <div class="kvg"><div>Model</div><div>${esc(c.model)}${c.terrain?" + terrain":" (no terrain)"}</div><div>Power</div><div>${num(c.eirp_dbm,1)} dBm EIRP: ${esc(c.eirp_src||"")}</div>
        <div>Antenna</div><div>${num(c.h_tx,0)} m above ground · effective ${num(c.hb_m,0)} m (${esc(c.hb_src)})${c.az!=null&&c.bw?` · pointing ${c.az}°, ${c.bw}° wide`:" · omni"}</div>
        <div>Receiver</div><div>${c.h_rx} m above ground</div></div>
      ${c.notes.length?`<p class="hint">${c.notes.map(esc).join(" ")}</p>`:""}
      ${p?`<h4 style="margin:10px 0 4px">To the pin: ${num(p.dist_mi,2)} mi ${esc(p.compass)} (${p.bearing}°)</h4>
        <p style="margin:0">Estimated <b style="color:${p.margin_db>=0?"var(--good)":"var(--bad)"}">${num(p.level_dbm,0)} dBm</b> (${p.margin_db>=0?"+":""}${num(p.margin_db,0)} dB against the edge)${p.path?` · path <b>${esc(p.path)}</b>`:""}${p.terrain_loss_db?` · hills cost ${num(p.terrain_loss_db,0)} dB`:""}</p>
        ${p.profile?emProfileSvg(p):""}`:'<p class="hint">Drop a pin to see the level and path at that spot.</p>'}
      <p class="hint">Estimates, not measurements: buildings, trees and the real antenna pattern change them. ${esc(c.attribution||"")}</p></div>
    <div>${emPolarSvg(c)}</div></div>`;
}

// how far it reaches in each direction (filled), with the antenna pattern (dashed) when known
function emPolarSvg(c){
  const r=S.emit.r, C=150, R=118, rad=Math.PI/180;
  const dist=c.contour.map(([la,lo])=>{ const dLa=(la-r.lat)*rad, dLo=(lo-r.lon)*rad, h=Math.sin(dLa/2)**2+Math.cos(r.lat*rad)*Math.cos(la*rad)*Math.sin(dLo/2)**2; return 2*3958.8*Math.asin(Math.sqrt(h)); });
  const max=Math.max(0.1,...dist), pt=(d,a)=>`${(C+d*Math.sin(a*rad)).toFixed(1)},${(C-d*Math.cos(a*rad)).toFixed(1)}`;
  let s=`<svg viewBox="0 0 300 300" style="width:100%;max-width:330px;display:block;margin:auto" role="img" aria-label="Reach by direction">`;
  for(let i=1;i<=4;i++){ s+=`<circle cx="${C}" cy="${C}" r="${R*i/4}" fill="none" stroke="var(--line)"/><text x="${C+3}" y="${C-R*i/4-2}" font-size="9" fill="var(--muted)">${num(max*i/4,1)} mi</text>`; }
  for(const [l,a] of [["N",0],["E",90],["S",180],["W",270]]) s+=`<text x="${(C+(R+14)*Math.sin(a*rad)).toFixed(1)}" y="${(C-(R+14)*Math.cos(a*rad)+4).toFixed(1)}" font-size="12" font-weight="700" text-anchor="middle" fill="var(--ink)">${l}</text>`;
  s+=`<polygon points="${dist.map((d,i)=>pt(R*d/max,i*2)).join(" ")}" fill="var(--accent)" fill-opacity=".28" stroke="var(--accent)" stroke-width="1.5"><title>Edge of coverage at ${c.threshold} dBm</title></polygon>`;
  if(c.pattern) s+=`<polygon points="${c.pattern.map((g,i)=>pt(R*Math.max(0,(g+25)/25),i*5)).join(" ")}" fill="none" stroke="var(--ink)" stroke-dasharray="4 3" stroke-width="1.2"><title>Antenna pattern (0 to −25 dB)</title></polygon>`;
  s+=`<circle cx="${C}" cy="${C}" r="3" fill="var(--ink)"/></svg>`;
  return s+`<p class="hint" style="text-align:center;margin:4px 0 0">Filled: how far it reaches each way. ${c.pattern?"Dashed: the antenna's pattern.":"Omni antenna (no direction on file)."}</p>`;
}

// the path to the pin: ground (with the earth's bulge), the line of sight and the first Fresnel zone
function emProfileSvg(p){
  const pts=p.profile; if(!pts||pts.length<2) return "";
  const W=520, H=150, x0=34, y0=8, w=W-x0-6, h=H-y0-22, dmax=pts[pts.length-1][0]||1;
  const lo=Math.min(...pts.map(q=>Math.min(q[1],q[2]-q[3]))), hi=Math.max(...pts.map(q=>Math.max(q[1],q[2]+q[3]*.2)));
  const X=d=>(x0+w*d/dmax).toFixed(1), Y=v=>(y0+h*(1-(v-lo)/((hi-lo)||1))).toFixed(1);
  const ground=`${X(0)},${Y(lo)} `+pts.map(q=>`${X(q[0])},${Y(q[1])}`).join(" ")+` ${X(dmax)},${Y(lo)}`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;margin-top:6px" role="img" aria-label="Path profile to the pin">
    <polygon points="${ground}" fill="#8b6b3d" fill-opacity=".55"/>
    <polyline points="${pts.map(q=>`${X(q[0])},${Y(q[2])}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
    <polyline points="${pts.map(q=>`${X(q[0])},${Y(q[2]-q[3]*.6)}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-dasharray="3 3" stroke-width="1"/>
    <text x="2" y="${Y(hi)}" font-size="9" fill="var(--muted)">${Math.round(hi)} m</text><text x="2" y="${Y(lo)}" font-size="9" fill="var(--muted)">${Math.round(lo)} m</text>
    <text x="${x0}" y="${H-6}" font-size="9" fill="var(--muted)">transmitter</text><text x="${W-6}" y="${H-6}" font-size="9" text-anchor="end" fill="var(--muted)">pin · ${num(dmax/1.609344,2)} mi</text></svg>
    <p class="hint" style="margin:2px 0 0">Brown: the ground (curved by the earth). Line: line of sight. Dashed: 60% of the first Fresnel zone, which a clear path keeps free.</p>`;
}

function emNetworkBody(el){
  const n=S.emit.net; if(!n){ el.innerHTML='<p class="hint">Loading…</p>'; return; }
  const L_=n.licence, tbl=(head,rows)=>rows.length?`<div class="tw" style="max-height:260px"><table><thead><tr>${head.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`:'<p class="hint">None.</p>';
  const fl=fs=>fs.slice(0,8).map(fmtF).join(" ")+(fs.length>8?` +${fs.length-8}`:"");
  const sec=(t,html,open)=>`<details ${open?"open":""} style="margin-top:8px"><summary><b>${t}</b></summary>${html}</details>`;
  el.innerHTML=`<p style="margin:0"><b>${esc(L_.licensee)}</b> · <span class="mono">${esc(L_.call_sign)}</span> · ${esc(L_.service_name||L_.service||"")}${L_.category?` · ${esc(L_.category)}`:""}
      ${n.links.fcc?` · <a href="${n.links.fcc}" target="_blank" rel="noopener">FCC licence ↗</a>`:""} · <a href="${n.links.radioreference}" target="_blank" rel="noopener">RadioReference ↗</a></p>
    <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">${[[n.sites.length,"base / fixed sites"],[n.mobiles.length,`mobile entries (about ${n.units.toLocaleString()} radios)`],[n.simulcast.length,"simulcast channels"],
      [n.system.length,"other call signs, same system"],[n.shared.length,"others sharing its channels"],[n.colocated.length,"others on the tower"],[n.cochannel.length,"same channel nearby"],[n.talkgroups.length,"talk groups"]]
      .map(([k,l])=>`<span class="tag">${k} ${l}</span>`).join("")}<button id="emFit">Zoom to the network</button></div>
    ${sec(`Base stations and fixed sites (${n.sites.length})`, tbl(["Site","Distance","Type","Frequencies (MHz)","ERP","Tower"], n.sites.map(s=>`<tr data-ll="${s.lat},${s.lon}" style="cursor:pointer"><td>${esc([s.address,s.city,s.state].filter(Boolean).join(", ")||`${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`)}</td>
      <td class="n">${s.dist_mi!=null?num(s.dist_mi,1)+" mi":""}</td><td>${esc(s.classes.join(" "))}</td><td class="mono">${fl(s.freqs)}</td><td class="n">${s.erp_w?num(s.erp_w)+" W":""}</td><td class="mono">${esc(s.tower_reg||"")}</td></tr>`)), true)}
    ${sec(`Mobiles, portables and control stations (${n.mobiles.length} entries, about ${n.units.toLocaleString()} radios)`, tbl(["MHz","Type","Radios","Area of operation"], n.mobiles.map(m=>`<tr><td class="mono">${fmtF(m.freq)}</td><td>${esc(classLabel(m.class))} <span class="mono hint">${esc(m.class||"")}</span></td><td class="n">${m.units||""}</td><td>${esc(m.area)}</td></tr>`)), true)}
    ${sec("Channel pairs (base transmits → radios transmit)", tbl(["Base MHz","Radio MHz","From"], n.pairs.map(p=>`<tr><td class="mono">${fmtF(p.base)}</td><td class="mono">${p.mobile.map(fmtF).join(" ")||"–"}</td><td>${esc(p.how)}</td></tr>`)))}
    ${n.simulcast.length?sec(`Simulcast (${n.simulcast.length})`, `<p class="mono" style="white-space:normal">${n.simulcast.map(x=>`${fmtF(x.freq)} × ${x.sites} sites`).join(" · ")}</p>`):""}
    ${sec(`Same system, the licensee's other call signs (${n.system.length})`, tbl(["Call sign","Service","Shared channels","Sites"], n.system.map(x=>`<tr><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.service_name||"")}</td><td class="n">${x.shared}</td><td class="n">${x.sites}</td></tr>`)))}
    ${sec(`Other licensees on 2+ of its channels within ${n.radius_mi} mi (${n.shared.length})`, tbl(["Licensee","Call sign","Shared","Where"], n.shared.map(x=>`<tr><td>${esc(x.licensee)}</td><td class="mono">${esc(x.call_sign)}</td><td class="n">${x.shared}</td><td>${esc([x.city,x.state].filter(Boolean).join(", "))}</td></tr>`)))}
    ${sec(`The tower${n.tower?` ${esc(n.tower.reg)}`:""} and who else is on it (${n.colocated.length})`, (n.tower?`<p style="margin:4px 0">${esc(n.tower.struct_type||"Structure")} ${n.tower.overall_agl_m??"?"} m · ${esc(n.tower.owner||"owner not on file")}${n.tower.city?` · ${esc(n.tower.city)}, ${esc(n.tower.state||"")}`:""}</p>`:'<p class="hint">No tower registration on the licence: showing what is within 50 m.</p>')
      + tbl(["Licensee","Call sign","Service","Frequencies (MHz)"], n.colocated.map(x=>`<tr><td>${esc(x.licensee)}</td><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.service_name||"")}</td><td class="mono">${fl(x.f)}</td></tr>`)))}
    ${sec(`Same channel within ${n.radius_mi} mi (${n.cochannel.length})`, tbl(["Licensee","Call sign","Class","Distance","Where"], n.cochannel.map(x=>`<tr data-ll="${x.lat},${x.lon}" style="cursor:pointer"><td>${esc(x.licensee)}</td><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.station_class||"")}</td><td class="n">${num(x.dist_mi,1)} mi</td><td>${esc([x.city,x.state].filter(Boolean).join(", "))}</td></tr>`)))}
    ${sec(`The licensee's other licences (${n.licences.length})`, tbl(["Call sign","Service","Frequencies","Sites","Where"], n.licences.map(x=>`<tr><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.service_name||"")}</td><td class="n">${x.freqs}</td><td class="n">${x.sites}</td><td>${esc([x.city,x.state].filter(Boolean).join(", "))}</td></tr>`)))}
    ${(n.mw_links||[]).length?sec(`Microwave backhaul links (${n.mw_links.length})`, tbl(["Call sign","From","To","Length","MHz"], n.mw_links.map(k=>`<tr data-ll="${k.tx_lat},${k.tx_lon}" style="cursor:pointer"><td class="mono">${esc(k.call_sign)}</td>
      <td>${esc([k.tx_city,k.tx_state].filter(Boolean).join(", "))}${k.tx_reg?` <span class="hint mono">${esc(k.tx_reg)}</span>`:""}</td><td>${esc([k.rx_city,k.rx_state].filter(Boolean).join(", "))}${k.rx_reg?` <span class="hint mono">${esc(k.rx_reg)}</span>`:""}</td>
      <td class="n">${(k.dist_km/1.609344).toFixed(1)} mi</td><td class="mono">${esc((k.freqs||"").split(",").slice(0,4).join(" "))}</td></tr>`)), true):""}
    ${sec(`Microwave sites (${n.microwave.length})`, n.microwave_loaded?tbl(["Where","Call signs","MHz"], n.microwave.map(m=>`<tr data-ll="${m.lat},${m.lon}" style="cursor:pointer"><td>${esc([m.city,m.state].filter(Boolean).join(", "))}</td><td class="mono">${esc(m.call_signs.join(" "))}</td><td class="mono">${m.freqs.join(" ")}</td></tr>`))
      :'<p class="hint">Microwave licences aren\'t loaded. Turn on “FCC ULS: Microwave” in Data &amp; updates to see the licensee\'s backhaul sites.</p>')}
    ${sec(`Your labels (${n.labels.length})`, tbl(["Call sign","MHz","Alpha tag","Tag","Description","Tone"], n.labels.map(x=>`<tr><td class="mono">${esc(x.call_sign||"")}</td><td class="mono">${fmtF(x.freq_mhz)}</td><td>${esc(x.alpha_tag||"")}</td><td>${esc(x.tag||"")}</td><td>${esc(x.description||"")}</td><td>${esc(x.tone||"")}</td></tr>`)))}
    ${sec(`Talk groups (${n.talkgroups.length})`, `<p class="hint" style="margin:4px 0">Talk groups aren't in FCC data. Bring in a list you have (CSV, Excel or JSON with Decimal / Hex / Alpha Tag / Mode / Description / Tag columns, as RadioReference and scanner software export it).</p>
      <div class="row" style="gap:8px"><label class="inl">For <select id="emTgSys"><option value="${esc(L_.call_sign)}">this call sign</option><option value="${esc(L_.licensee)}">every licence of ${esc(L_.licensee)}</option></select></label>
        <label class="inl">Import <input type="file" id="emTgFile" accept=".csv,.tsv,.txt,.xlsx,.json"></label>${n.talkgroups.length?'<button id="emTgDel">Remove these talk groups</button>':""}<span class="hint" id="emTgMsg"></span></div>`
      + tbl(["Decimal","Hex","Alpha tag","Mode","Description","Tag","Category"], n.talkgroups.map(t=>`<tr><td class="mono">${t.dec}</td><td class="mono">${esc(t.hex||"")}</td><td>${esc(t.alpha_tag||"")}</td><td>${esc(t.mode||"")}</td><td>${esc(t.description||"")}</td><td>${esc(t.tag||"")}</td><td>${esc(t.category||"")}</td></tr>`)), n.talkgroups.length>0)}`;
  // a row's site is ringed on the map, which stays where it is (11/10: it panned and zoomed to it)
  el.querySelectorAll("tr[data-ll]").forEach(tr=>tr.onclick=()=>{ S.emit.mark=tr.dataset.ll.split(",").map(Number);
    el.querySelectorAll("tr[data-ll].sel").forEach(x=>x.classList.remove("sel")); tr.classList.add("sel"); emitDraw(); });
  $("#emFit").onclick=emFit;
  $("#emTgFile").onchange=async ev=>{ const f=ev.target.files[0]; if(!f) return; $("#emTgMsg").textContent="Reading…";
    try{ const r=await api(`/api/talkgroups/import?system=${encodeURIComponent($("#emTgSys").value)}&name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()});
      $("#emTgMsg").textContent=`${r.imported} of ${r.found} rows imported.`; S.emit.net=null; emitLoad(); }catch(err){ $("#emTgMsg").textContent=err.message; } };
  if($("#emTgDel")) $("#emTgDel").onclick=async()=>{ for(const s of new Set(n.talkgroups.map(t=>t.system))) await post(`/api/talkgroups/delete?system=${encodeURIComponent(s)}`); S.emit.net=null; emitLoad(); };
}

function emCellBody(el, s=S.emit?.cell, r=S.emit?.r){  // the Map tab's cell site, or any site given (emCellView)
  if(!s){ el.innerHTML='<p class="hint">Loading…</p>'; return; }
  const me=r._cell, t=s.tower;
  el.innerHTML=`<div class="grid2" style="margin-top:0"><div>
      <div class="kvg"><div>Operator</div><div><b>${esc(s.operator)}</b> <span class="mono hint">${esc(s.plmn)}</span></div>
        <div>Technology</div><div>${esc(s.radio)}</div>
        ${me?`<div>${esc(me.gci_name)}</div><div class="mono">${esc(me.gci)}</div><div>${esc(s.site_kind)}</div><div class="mono">${esc(String(s.site_id))}${me.sector!=null?` · sector ${me.sector}`:""}</div>
        <div>${esc(me.area_kind)}</div><div class="mono">${me.area}</div>`:""}
        <div>Site</div><div>${esc(s.located)} · ${num(s.dist_mi,2)} mi from the pin</div>
        <div>Seen</div><div>${s.samples?`${s.samples.toLocaleString()} samples · `:""}last ${esc(s.last||"?")} · ${esc(s.sources.join(", "))}</div></div>
      <h4 style="margin:10px 0 4px">Sectors (${s.cells.length})</h4>
      <div class="tw"><table><thead><tr><th>Sector</th><th>Cell ID</th><th>${s.radio==="UMTS"?"PSC":"PCI"}</th><th>Points toward (est.)</th><th class="n">Range</th><th class="n">Samples</th><th>Last seen</th><th></th></tr></thead><tbody>
        ${s.cells.map((c,i)=>`<tr ${me&&c.gci===me.gci?'style="font-weight:700"':""}><td>${c.sector??""}</td><td class="mono">${esc(c.gci)}</td><td class="mono">${c.pci??'<span class="hint">not heard</span>'}</td><td>${c.az_est!=null?`${c.az_est}° ${COMPASS16[Math.round(c.az_est/22.5)%16]}`:"–"}</td>
          <td class="n">${c.range_m?num(c.range_m/1609.344,1)+" mi":""}</td><td class="n">${c.samples||""}</td><td>${esc(c.last||"")}${emStale(c.last)}</td><td><button data-sec="${i}">Coverage</button></td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Direction is estimated from where the crowd saw each sector relative to the tower; ranges are how far its samples spread (OpenCelliD).</p></div>
    <div>${t?`<h4 style="margin:0 0 4px">FCC tower ${esc(t.reg)} <span class="hint">· ${t.match_m} m from the cells' average position</span></h4>
        <div class="kvg"><div>Owner</div><div>${esc(t.owner||"not on file")}</div><div>Structure</div><div>${esc(t.struct_type||"")} ${t.overall_agl_m??"?"} m (${t.overall_agl_m?Math.round(t.overall_agl_m*3.281)+" ft":"?"}) above ground</div>
          <div>Address</div><div>${esc([t.street,t.city,t.state].filter(Boolean).join(", "))}</div><div>Built</div><div>${esc(t.constructed||"")}</div></div>
        <h4 style="margin:10px 0 4px">FCC licensees on this tower (${t.licensees.length})</h4>
        ${t.licensees.length?`<div class="tw" style="max-height:220px"><table><thead><tr><th>Licensee</th><th>Call sign</th><th>Service</th><th class="n">Freqs</th></tr></thead><tbody>${t.licensees.map(x=>`<tr><td>${esc(x.licensee)}</td><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.service_name||"")}</td><td class="n">${x.freqs}</td></tr>`).join("")}</tbody></table></div>`:'<p class="hint">No land mobile licences link to it (carriers\' own licences are by market, not by site).</p>'}`
      :'<p class="hint">No FCC-registered tower within 1 km of these cells (structures under 200 ft near no airport needn\'t register): the site is placed at the cells\' average position.</p>'}
      <p class="hint" style="margin-top:8px">Look it up: <a href="https://www.cellmapper.net/map?latitude=${s.lat}&longitude=${s.lon}&zoom=15" target="_blank" rel="noopener">CellMapper ↗</a> · <a href="https://opencellid.org/#zoom=16&lat=${s.lat}&lon=${s.lon}" target="_blank" rel="noopener">OpenCelliD ↗</a> · <a href="https://wigle.net/map?maplat=${s.lat}&maplon=${s.lon}&mapzoom=15" target="_blank" rel="noopener">WiGLE ↗</a></p></div></div>
    <div id="emCellRecord">${emCellLicensed(s)}</div>`;  // full width: the channel table needs its columns
  el.querySelectorAll("[data-sec]").forEach(b=>b.onclick=()=>{ const c=s.cells[+b.dataset.sec]; const row=emCellRow(s, c); emitOpen(row, "coverage"); });
}

// the site's public record beyond what the crowd heard: the FCC 800 MHz licence filed for this spot, every block the carrier holds in the
// county with the channel numbers a site of this kind could use each way, and what only a scan brings (Cody 11/6). Licensed is never
// shown as measured
// a cell the crowd last saw over two years ago may be a network its carrier has since shut down (3G, CDMA): said, not hidden
// a cell with no date came only from an older per-area pull: OpenCelliD's US file, whose cells were all last seen in 2025 or later (read 11/6),
// doesn't have it. Most 3G and every CDMA cell reads this way
const emStale = d => { if(!d) return ` <span class="tag" title="Only in an older per-area pull. OpenCelliD's current US file, whose cells were all last seen in 2025 or later, doesn't have it: AT&T, T-Mobile and Verizon shut their 3G and CDMA networks down in 2022">not in the current US file</span>`; const cut=(t=>`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`)(new Date(Date.now()-730*864e5)); return d<cut?` <span class="tag" title="The crowd hasn't reported it since. AT&T, T-Mobile and Verizon shut their 3G and CDMA networks down in 2022">not seen since ${esc(d.slice(0,4))}</span>`:""; };
function emCellLicensed(s){
  const rng=a=>a?(a[0]===a[1]?`${a[0]}`:`${a[0]}–${a[1]}`):"";
  const mhz=a=>a?`${num(a[0],1)}–${num(a[1],1)}`:"";
  const lic=s.licensed||[], f=s.fcc_cellular||[];
  const fcc=f.length?`<h4 style="margin:12px 0 4px">FCC cellular licence at this site <span class="hint">· 800 MHz, as filed</span></h4>
    <div class="tw"><table id="emCellFcc"><thead><tr><th>Call sign</th><th>Licensee on the licence</th><th>Block</th><th>Downlink MHz</th><th>Uplink MHz</th><th class="n">ERP</th><th class="n">Height</th></tr></thead><tbody>
      ${f.map(x=>`<tr><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.licensee||"")}</td><td>${esc(x.block||"")}</td><td class="mono">${x.dl.map(mhz).join(", ")}</td><td class="mono">${x.ul.map(mhz).join(", ")}</td>
        <td class="n">${x.erp_w!=null?`${num(x.erp_w,1)} W`:""}</td><td class="n">${x.haat_m!=null?`${num(x.haat_m,0)} m above average terrain`:x.height_m!=null?`${num(x.height_m,0)} m`:""}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">The licensee is the name on the licence, which can be a company the carrier has since bought.</p>`:"";
  const blocks=lic.length?`<h4 style="margin:12px 0 4px">Bands and channels the carrier is licensed for here <span class="hint">· ${esc(s.licensed_where||"")}, FCC</span></h4>
    <div class="tw"><table id="emCellBands"><thead><tr><th>Band</th><th>Block</th><th>Downlink MHz</th><th>Uplink MHz</th><th>3GPP band</th><th>Channel numbers down</th><th>Channel numbers up</th><th>Call sign</th></tr></thead><tbody>
      ${lic.flatMap(b=>b.channels.map((c,i)=>`<tr${i?" data-srt-with":""}>${i?`<td></td><td></td><td></td><td></td>`:`<td>${esc(b.band)}</td><td>${esc(b.block||"")}</td><td class="mono">${mhz(b.dl_mhz)}</td><td class="mono">${b.tdd?"same (TDD)":b.ul_mhz?mhz(b.ul_mhz):"none (downlink only)"}</td>`}
        <td>${esc(c.band)}</td><td class="mono">${esc(c.kind)} ${rng(c.dl)}</td><td class="mono">${c.tdd?"same (TDD)":c.same?"same numbers":c.ul?`${esc(c.kind)} ${rng(c.ul)}`:"none"}</td><td class="mono">${esc((b.calls||[]).join(", "))}</td></tr>`)).join("")}</tbody></table></div>`
    :`<p class="hint" style="margin-top:12px">${esc(s.licensed_where?`No ${s.radio} blocks on file for ${s.operator} in ${s.licensed_where}.`:"Carrier spectrum isn't loaded on this copy.")}</p>`;
  const ot=s.on_tower, tower=ot&&ot.sites.length?`<h4 style="margin:12px 0 4px">Everything on this tower <span class="hint">· FCC ${esc(ot.reg)} · ${ot.sites.length} site${ot.sites.length===1?"":"s"}, ${ot.cells} cell${ot.cells===1?"":"s"}, ${esc(ot.carriers.join(", "))}</span></h4>
    <div class="tw"><table id="emCellTower"><thead><tr><th>Carrier</th><th>Technology</th><th>Site</th><th>Cells (sector · cell ID · PCI/PSC)</th><th>Bands licensed here</th><th>Last seen</th></tr></thead><tbody>
      ${ot.sites.map(x=>`<tr ${x.key===s.key?'style="font-weight:700"':""}><td>${esc(x.operator)}</td><td>${esc(x.radio)}</td><td class="mono">${esc(String(x.site_kind).split(" ")[0])} ${esc(String(x.site_id))}</td>
        <td class="mono" style="font-size:11px">${x.cells.map(c=>`${c.sector??"?"} · ${esc(c.gci)}${c.pci!=null?` · ${c.pci}`:""}`).join("<br>")}</td><td>${esc(x.bands.join(", ")||"none on file")}</td><td>${esc(x.last||"")}${emStale(x.last)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">Every carrier's cells the crowd placed on this tower. Which band each cell is on only a scan says: the bands here are what each carrier holds in the county.</p>`:"";
  return `${tower}${fcc}${blocks}
    <p class="hint">Licensed, not measured: what ${esc(s.operator)} may use here, worked out to channel numbers (3GPP TS 36.101, 38.104, 25.101, 45.005). Which of these this site has on the air only a scan says.</p>
    <details class="hint" style="margin-top:6px"><summary>What a scan adds</summary>
      <p style="margin:6px 0">The channel each sector is on, its bandwidth, broadcast settings (tracking area, neighbours, paging and access settings), signal received (RSRP, RSRQ, SINR) and timing. Import a scanner or phone capture in a mission and these cells pick up its channel and level.</p>
      <p style="margin:0">Not collected: anything that identifies a person, such as subscriber IDs (TMSI, IMSI) or the contents of calls and pages.</p></details>`;
}

// A cell site in the results viewer on a page (Cell sites, Topology: Cody 11/10, their rows jumped to the Map tab): its
// sectors, tower and licensed bands, on the tab where it was clicked. "Show on map" is the explicit way to the Map tab.
function emCellView(host, s){
  if(!window.RFResults){ emitOpen(emCellRow(s, s.cells[0]), "cell"); return; }
  RFResults.show(host, {key:`cs:${s.key||`${s.plmn}|${s.radio}|${s.site_id}`}`, label:`${s.operator} ${s.radio} ${s.site_id}`,
    title:`${esc(s.operator)} ${esc(s.radio)} ${esc(String(s.site_kind||"").split(" ")[0])} <span class="mono">${esc(String(s.site_id))}</span>`,
    sub:[s.dist_mi!=null?`${num(s.dist_mi,2)} mi from the pin`:"", s.tower?`FCC tower ${esc(s.tower.reg)}`:"", `${s.cells.length} cell${s.cells.length===1?"":"s"}`].filter(Boolean).join(" · "),
    fill:body=>emCellBody(body, s, emCellRow(s, s.cells[0])), mark:s.lat!=null?[+s.lat, +s.lon]:false,  // Mark it: a marker on the site (results.js)
    actions:[{label:"Show on map", primary:true, title:"On the Map tab, with its sectors drawn", run:()=>emitOpen(emCellRow(s, s.cells[0]), "cell")}]});
}
window.emCellView = emCellView;
// a cell (from a site) as a row the panel can open
function emCellRow(site, c){
  return {layer:"cell", fid:null, lat:site.lat, lon:site.lon, kind:site.radio, ident:c.gci, _cell:c, _site:site, freq_mhz:null};
}
window.emCellRow = emCellRow;

/* ---------- map overlays ---------- */
function emitDraw(){
  if(!S.map) return;
  if(S.emitLayer) S.map.removeLayer(S.emitLayer);
  S.emitLayer=L.layerGroup().addTo(S.map); S.emitHeat=null;
  const e=S.emit; if(!e) return;
  const r=e.r, g=S.emitLayer, quiet={interactive:false, bubblingMouseEvents:false, renderer:S.quietR}, live={bubblingMouseEvents:false, renderer:S.dotsR};
  L.circleMarker([r.lat,r.lon],{radius:11, color:"#f0a020", weight:3, fill:false, ...quiet}).addTo(g);
  if(e.mark) L.circleMarker(e.mark,{radius:15, color:"#1f6feb", weight:3, dashArray:"5 4", fill:false, ...quiet}).addTo(g);  // a network row picked
  if(e.tab==="coverage" && e.cov){ const c=e.cov;
    S.emitHeat=L.imageOverlay("data:image/png;base64,"+c.png, c.bounds, {opacity:e.opt.opacity, interactive:false}).addTo(g);
    L.polygon(c.contour,{color:"#f0a020", weight:2, dashArray:"6 4", fill:false, ...quiet}).addTo(g);
    if(c.pin) L.polyline([[r.lat,r.lon], S.center],{color:c.pin.margin_db>=0?"#2da44e":"#cf222e", weight:2, ...quiet}).addTo(g); }
  if(e.tab==="network" && e.net){ const n=e.net;
    for(const m of n.mobiles) if(m.lat!=null && m.radius_km) L.circle([m.lat,m.lon],{radius:m.radius_km*1000, color:"#8250df", weight:1, dashArray:"5 5", fillOpacity:.04, ...quiet}).addTo(g);
    for(const c of n.cochannel) L.circleMarker([c.lat,c.lon],{radius:4, color:"#57606a", weight:1, fillColor:"#8c959f", fillOpacity:.8, ...live}).bindTooltip(`Same channel: ${esc(c.licensee)} ${esc(c.call_sign)} · ${c.dist_mi} mi`).addTo(g);
    for(const k of n.mw_links||[]) L.polyline([[k.tx_lat,k.tx_lon],[k.rx_lat,k.rx_lon]],{color:"#8250df", weight:2.5, opacity:.85, ...live})
      .bindTooltip(`Microwave ${esc(k.call_sign)}: ${esc(k.tx_city||"")} → ${esc(k.rx_city||"")} · ${(k.dist_km/1.609344).toFixed(1)} mi${k.freqs?` · ${esc(k.freqs.split(",").slice(0,3).join(", "))} MHz`:""}`, {sticky:true}).addTo(g);
    for(const m of n.microwave) L.marker([m.lat,m.lon],{icon:L.divIcon({className:"", html:'<div style="width:10px;height:10px;background:#8250df;transform:rotate(45deg);border:1px solid #fff"></div>', iconSize:[10,10]}), bubblingMouseEvents:false})
      .bindTooltip(`Microwave: ${esc(m.call_signs.join(" "))}`).addTo(g);
    for(const s of n.sites){ L.polyline([[r.lat,r.lon],[s.lat,s.lon]],{color:"#1f6feb", weight:1.5, dashArray:"4 4", opacity:.8, ...quiet}).addTo(g);
      L.marker([s.lat,s.lon],{icon:L.divIcon({className:"", html:'<div style="width:12px;height:12px;background:#1f6feb;border:2px solid #fff;border-radius:2px"></div>', iconSize:[12,12]}), bubblingMouseEvents:false})
        .bindTooltip(`${esc(n.licence.call_sign)} base: ${esc([s.city,s.state].filter(Boolean).join(", "))} · ${s.freqs.slice(0,6).map(fmtF).join(" ")}`).addTo(g); } }
  if(e.tab==="cell" && e.cell){ const s=e.cell;
    for(const c of s.cells){ if(c.az_est==null) continue; const pts=[[s.lat,s.lon]];
      for(let a=c.az_est-32; a<=c.az_est+32; a+=8){ const d=0.6/111, k=Math.cos(s.lat*Math.PI/180); pts.push([s.lat+d*Math.cos(a*Math.PI/180), s.lon+d*Math.sin(a*Math.PI/180)/k]); }
      L.polygon(pts,{color:"#f0a020", weight:1, fillOpacity:.25, ...live}).bindTooltip(`${esc(c.gci)} · sector ${c.sector??"?"} · ${c.az_est}° (est.)`).addTo(g);
      L.circleMarker([c.lat,c.lon],{radius:3, color:"#f0a020", fillOpacity:1, ...quiet}).addTo(g); }
    L.marker([s.lat,s.lon],{icon:pinIcon(), interactive:false}).addTo(g); }
}
// what Zoom to shows on each tab: the coverage's reach, the network's sites and links, the cell site's sectors, or the entry
function emZoomPts(e){
  if(!e) return null; const r=e.r, pts=[[r.lat,r.lon]];
  if(e.mark) return [pts[0], e.mark];  // a network row picked: it and the item (review 11/11: it was ringed off screen)
  if(e.tab==="coverage"&&e.cov) pts.push(...e.cov.bounds);
  if(e.tab==="network"&&e.net){ for(const s of e.net.sites) pts.push([s.lat,s.lon]); for(const m of e.net.microwave) pts.push([m.lat,m.lon]); for(const k of e.net.mw_links||[]) pts.push([k.tx_lat,k.tx_lon],[k.rx_lat,k.rx_lon]); }
  if(e.tab==="cell"&&e.cell){ pts.push([e.cell.lat,e.cell.lon]); for(const c of e.cell.cells) if(c.lat!=null) pts.push([c.lat,c.lon]); }
  return pts.length>1?pts:[r.lat,r.lon];
}
// Zoom to the network (its own button): the viewer's Zoom to, which leaves room for the viewer
function emFit(){ const v=S.map&&window.RFResults&&RFResults.get(S.map); if(v) v.zoomTo(); }

// called by drawLayers after it draws the results, so the viewer and the overlays come back on a map made again
window.emitAfterDraw = () => { if(S.emit){ emitPanel(); emitDraw(); } };
