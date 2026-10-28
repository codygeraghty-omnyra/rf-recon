"use strict";
/* RF Recon — one emitter. Click one on the map (its popup) or in its details to see:
   - Coverage: where it reaches, as a heatmap, the edge of its coverage, its antenna pattern and the path to the pin
     (estimates: free space or Hata, the antenna pattern when known, hills from the terrain data);
   - Network: its licence's base stations and mobiles, the same system under other call signs, simulcast sites,
     others sharing its channels, the tower, the channel's other users, microwave sites, your labels and talk groups;
   - Cell site: for a cell, its global cell ID, the site's sectors with their estimated directions, and the tower.
   The overlays stay on the map until the panel is closed. */

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

// a dot clicked on the map: everything at that spot, highlighted in the list or table, and listed in the panel
document.head.insertAdjacentHTML("beforeend", `<style>#mapTable tr.sel td{background:color-mix(in srgb,var(--accent) 22%,transparent)}</style>`);
function emitSpot(rs){
  const items=groupItems(rs), fids=new Set(items.map(r=>r.fid));
  $$("#mapTable tr[data-fid]").forEach(tr=>tr.classList.toggle("sel", fids.has(tr.dataset.fid)));
  const first=$$("#mapTable tr.sel")[0]; if(first) first.scrollIntoView({block:"nearest"});
  const keep=S.emit&&S.emit.site&&S.emit.site[0]?.lat===items[0]?.lat&&S.emit.site[0]?.lon===items[0]?.lon;
  if(keep) return;
  S.emit={r:items[0], site:items, tab:"info", opt:emDefaults(items[0]), cov:null, net:null, cell:null, err:{}};
  emitPanel(); emitDraw();
  const p=$("#emitPanel"); if(p) p.scrollIntoView({block:"nearest", behavior:"smooth"});
}
window.emitSpot = emitSpot;
// and the other way: a row picked in the map's table shows it on the map and in the panel
document.addEventListener("click", ev=>{ const tr=ev.target.closest("#mapTable tr[data-fid]"); if(!tr||ev.target.closest("a,button")) return;
  const r=S.rows.find(x=>x.fid===tr.dataset.fid); if(!r||r.lat==null) return;
  selectFeature(r, true); emitSpot(S.rows.filter(x=>x.lat===r.lat&&x.lon===r.lon)); });

// open the panel for one emitter on the Map tab; tab = coverage | network | cell
function emitOpen(r, tab){
  if(!r || r.lat==null){ $("#status").textContent="That entry has no location to work from."; return; }
  S.emit = {r, tab: tab || (emIsCell(r) ? "cell" : "coverage"), opt: emDefaults(r), cov:null, net:null, cell:null, err:{}};
  try{ $("#dlg").close(); }catch(e){}
  if(S.tab!=="map") setTab("map"); else { emitPanel(); emitDraw(); }
  emitLoad();
}
window.emitOpen = emitOpen;
function emitClose(){ S.emit=null; if(S.emitLayer&&S.map) S.map.removeLayer(S.emitLayer); S.emitLayer=null; const p=$("#emitPanel"); if(p) p.innerHTML=""; }

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
  e.busy=false; emitPanel(); emitDraw();
  if(!e.err[t] && !(e.fitted||(e.fitted={}))[t] && S.map){ e.fitted[t]=true;  // show the whole of it the first time
    const pts=t==="coverage"&&e.cov ? e.cov.contour : t==="network"&&e.net ? [[e.r.lat,e.r.lon],...e.net.sites.map(s=>[s.lat,s.lon])] : t==="cell"&&e.cell ? [[e.cell.lat,e.cell.lon],...e.cell.cells.map(c=>[c.lat,c.lon])] : null;
    if(pts&&pts.length>1) S.map.fitBounds(L.latLngBounds(pts).pad(.08)); }
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
  const m=CELL_RE.exec(String(r.ext_id||r.ident||"")); if(!m) throw new Error("This cell's ID isn't in a form RF Recon can read (MCC-MNC-area-cell).");
  const res=await api(`/api/cells?lat=${r.lat}&lon=${r.lon}&radius=2`);
  for(const s of res.sites) for(const c of s.cells) if(c.mcc===m[1] && +c.cid===+m[4]){ r._cell=c; r._site=s; S.emit.opt=Object.assign(emDefaults(r), {}); return s; }
  throw new Error("No site found for this cell.");
}

/* ---------- the panel under the map ---------- */
function emitPanel(){
  const el=$("#emitPanel"), e=S.emit; if(!el) return;
  if(!e){ el.innerHTML=""; return; }
  const r=e.r, tabs=[...(e.site?[["info",`On this spot (${e.site.length})`]]:[]), ...((erpOf(r)||emIsCell(r))&&r.layer!=="towers"?[["coverage","Coverage"]]:[]),
    ...(emIsUls(r)?[["network","Network"]]:[]), ...(emIsCell(r)?[["cell","Cell site"]]:[])];
  el.innerHTML=`<div class="panel" style="margin-top:10px"><div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h3 style="margin:0">◎ ${r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span> · `:""}${esc(emName(r))}</h3>
      <div class="seg" id="emTabs">${tabs.map(([k,l])=>`<button data-et="${k}" class="${e.tab===k?"on":""}">${l}</button>`).join("")}</div>
      <span class="row" style="gap:6px">${emSurvey(r)&&(r.ident||r.freq_mhz)?`<button id="emMeas" title="Measured heatmap of this signal from your survey data">Measured heatmap</button>`:""}
        <button id="emDetail">Details</button><button id="emClose">✕ Close</button></span></div>
    <div id="emBody" style="margin-top:8px">${e.busy?'<p class="status">Working it out…</p>':e.err[e.tab]?`<p class="status err">${esc(e.err[e.tab])}</p>`:""}</div></div>`;
  $("#emTabs").onclick=ev=>{ const b=ev.target.closest("button"); if(!b) return; e.tab=b.dataset.et; emitPanel(); emitDraw(); emitLoad(); };
  $("#emClose").onclick=emitClose;
  $("#emDetail").onclick=()=>{ if(r.fid) openDetail(r.fid); };
  if($("#emMeas")) $("#emMeas").onclick=()=>{ S.heat.kind="measured"; S.heat.ident=r.ident||(r.ext_id||"").replace(/^\w+:/,"")||""; S.heat.freq=r.ident?"":(r.freq_mhz??""); S.heat.signal=emName(r); render(); loadHeat(); };
  if(e.busy||e.err[e.tab]) return;
  const body=$("#emBody");
  if(e.tab==="info") emSpotBody(body); else if(e.tab==="coverage") emCoverageBody(body); else if(e.tab==="network") emNetworkBody(body); else emCellBody(body);
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
    if(b&&b.dataset.go==="detail"){ openDetail(r.fid); return; }
    e.r=r; e.opt=emDefaults(r); e.cov=e.net=e.cell=null; e.err={}; if(e.fitted) e.fitted={};
    if(b){ e.tab=b.dataset.go; emitPanel(); emitDraw(); emitLoad(); } else emitPanel(); });
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
  $("#emTak").onclick=()=>{ if(!c) return; RFTak.save({rows:[e.r], center:[e.r.lat,e.r.lon], radius:c.radius_mi, name:`RF Recon - ${emName(e.r)} coverage`, colorOf, typeOf, fccDate:null,
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
      .map(([k,l])=>`<span class="tag">${k} ${l}</span>`).join("")}<button id="emFit">Fit the network on the map</button></div>
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
    ${sec(`Microwave sites (${n.microwave.length})`, n.microwave_loaded?tbl(["Where","Call signs","MHz"], n.microwave.map(m=>`<tr data-ll="${m.lat},${m.lon}" style="cursor:pointer"><td>${esc([m.city,m.state].filter(Boolean).join(", "))}</td><td class="mono">${esc(m.call_signs.join(" "))}</td><td class="mono">${m.freqs.join(" ")}</td></tr>`))
      :'<p class="hint">Microwave licences aren\'t loaded. Turn on “FCC ULS: Microwave” in Data &amp; updates to see the licensee\'s backhaul sites.</p>')}
    ${sec(`Your labels (${n.labels.length})`, tbl(["Call sign","MHz","Alpha tag","Tag","Description","Tone"], n.labels.map(x=>`<tr><td class="mono">${esc(x.call_sign||"")}</td><td class="mono">${fmtF(x.freq_mhz)}</td><td>${esc(x.alpha_tag||"")}</td><td>${esc(x.tag||"")}</td><td>${esc(x.description||"")}</td><td>${esc(x.tone||"")}</td></tr>`)))}
    ${sec(`Talk groups (${n.talkgroups.length})`, `<p class="hint" style="margin:4px 0">Talk groups aren't in FCC data. Bring in a list you have (CSV, Excel or JSON with Decimal / Hex / Alpha Tag / Mode / Description / Tag columns, as RadioReference and scanner software export it).</p>
      <div class="row" style="gap:8px"><label class="inl">For <select id="emTgSys"><option value="${esc(L_.call_sign)}">this call sign</option><option value="${esc(L_.licensee)}">every licence of ${esc(L_.licensee)}</option></select></label>
        <label class="inl">Import <input type="file" id="emTgFile" accept=".csv,.tsv,.txt,.xlsx,.json"></label>${n.talkgroups.length?'<button id="emTgDel">Remove these talk groups</button>':""}<span class="hint" id="emTgMsg"></span></div>`
      + tbl(["Decimal","Hex","Alpha tag","Mode","Description","Tag","Category"], n.talkgroups.map(t=>`<tr><td class="mono">${t.dec}</td><td class="mono">${esc(t.hex||"")}</td><td>${esc(t.alpha_tag||"")}</td><td>${esc(t.mode||"")}</td><td>${esc(t.description||"")}</td><td>${esc(t.tag||"")}</td><td>${esc(t.category||"")}</td></tr>`)), n.talkgroups.length>0)}`;
  el.querySelectorAll("tr[data-ll]").forEach(tr=>tr.onclick=()=>{ const [a,b]=tr.dataset.ll.split(",").map(Number); if(S.map) S.map.setView([a,b], Math.max(S.map.getZoom(),13)); });
  $("#emFit").onclick=emFit;
  $("#emTgFile").onchange=async ev=>{ const f=ev.target.files[0]; if(!f) return; $("#emTgMsg").textContent="Reading…";
    try{ const r=await api(`/api/talkgroups/import?system=${encodeURIComponent($("#emTgSys").value)}&name=${encodeURIComponent(f.name)}`,{method:"POST", body:await f.arrayBuffer()});
      $("#emTgMsg").textContent=`${r.imported} of ${r.found} rows imported.`; S.emit.net=null; emitLoad(); }catch(err){ $("#emTgMsg").textContent=err.message; } };
  if($("#emTgDel")) $("#emTgDel").onclick=async()=>{ for(const s of new Set(n.talkgroups.map(t=>t.system))) await post(`/api/talkgroups/delete?system=${encodeURIComponent(s)}`); S.emit.net=null; emitLoad(); };
}

function emCellBody(el){
  const s=S.emit.cell, r=S.emit.r; if(!s){ el.innerHTML='<p class="hint">Loading…</p>'; return; }
  const me=r._cell, t=s.tower;
  el.innerHTML=`<div class="grid2" style="margin-top:0"><div>
      <div class="kvg"><div>Operator</div><div><b>${esc(s.operator)}</b> <span class="mono hint">${esc(s.plmn)}</span></div>
        <div>Technology</div><div>${esc(s.radio)}</div>
        ${me?`<div>${esc(me.gci_name)}</div><div class="mono">${esc(me.gci)}</div><div>${esc(s.site_kind)}</div><div class="mono">${esc(String(s.site_id))}${me.sector!=null?` · sector ${me.sector}`:""}</div>
        <div>${esc(me.area_kind)}</div><div class="mono">${me.area}</div>`:""}
        <div>Site</div><div>${esc(s.located)} · ${num(s.dist_mi,2)} mi from the pin</div>
        <div>Seen</div><div>${s.samples?`${s.samples.toLocaleString()} samples · `:""}last ${esc(s.last||"?")} · ${esc(s.sources.join(", "))}</div></div>
      <h4 style="margin:10px 0 4px">Sectors (${s.cells.length})</h4>
      <div class="tw"><table><thead><tr><th>Sector</th><th>Cell ID</th><th>Points toward (est.)</th><th class="n">Range</th><th class="n">Samples</th><th>Last seen</th><th></th></tr></thead><tbody>
        ${s.cells.map((c,i)=>`<tr ${me&&c.gci===me.gci?'style="font-weight:700"':""}><td>${c.sector??""}</td><td class="mono">${esc(c.gci)}</td><td>${c.az_est!=null?`${c.az_est}° ${COMPASS16[Math.round(c.az_est/22.5)%16]}`:"–"}</td>
          <td class="n">${c.range_m?num(c.range_m/1609.344,1)+" mi":""}</td><td class="n">${c.samples||""}</td><td>${esc(c.last||"")}</td><td><button data-sec="${i}">Coverage</button></td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Direction is estimated from where the crowd saw each sector relative to the tower; ranges are how far its samples spread (OpenCelliD).</p></div>
    <div>${t?`<h4 style="margin:0 0 4px">FCC tower ${esc(t.reg)} <span class="hint">· ${t.match_m} m from the cells' average position</span></h4>
        <div class="kvg"><div>Owner</div><div>${esc(t.owner||"not on file")}</div><div>Structure</div><div>${esc(t.struct_type||"")} ${t.overall_agl_m??"?"} m (${t.overall_agl_m?Math.round(t.overall_agl_m*3.281)+" ft":"?"}) above ground</div>
          <div>Address</div><div>${esc([t.street,t.city,t.state].filter(Boolean).join(", "))}</div><div>Built</div><div>${esc(t.constructed||"")}</div></div>
        <h4 style="margin:10px 0 4px">FCC licensees on this tower (${t.licensees.length})</h4>
        ${t.licensees.length?`<div class="tw" style="max-height:220px"><table><thead><tr><th>Licensee</th><th>Call sign</th><th>Service</th><th class="n">Freqs</th></tr></thead><tbody>${t.licensees.map(x=>`<tr><td>${esc(x.licensee)}</td><td class="mono">${esc(x.call_sign)}</td><td>${esc(x.service_name||"")}</td><td class="n">${x.freqs}</td></tr>`).join("")}</tbody></table></div>`:'<p class="hint">No land mobile licences link to it (carriers\' own licences are by market, not by site).</p>'}`
      :'<p class="hint">No FCC-registered tower within 1 km of these cells (structures under 200 ft near no airport needn\'t register): the site is placed at the cells\' average position.</p>'}
      <p class="hint" style="margin-top:8px">Look it up: <a href="https://www.cellmapper.net/map?latitude=${s.lat}&longitude=${s.lon}&zoom=15" target="_blank" rel="noopener">CellMapper ↗</a> · <a href="https://opencellid.org/#zoom=16&lat=${s.lat}&lon=${s.lon}" target="_blank" rel="noopener">OpenCelliD ↗</a> · <a href="https://wigle.net/map?maplat=${s.lat}&maplon=${s.lon}&mapzoom=15" target="_blank" rel="noopener">WiGLE ↗</a></p></div></div>`;
  el.querySelectorAll("[data-sec]").forEach(b=>b.onclick=()=>{ const c=s.cells[+b.dataset.sec]; const row=emCellRow(s, c); emitOpen(row, "coverage"); });
}

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
  if(e.tab==="coverage" && e.cov){ const c=e.cov;
    S.emitHeat=L.imageOverlay("data:image/png;base64,"+c.png, c.bounds, {opacity:e.opt.opacity, interactive:false}).addTo(g);
    L.polygon(c.contour,{color:"#f0a020", weight:2, dashArray:"6 4", fill:false, ...quiet}).addTo(g);
    if(c.pin) L.polyline([[r.lat,r.lon], S.center],{color:c.pin.margin_db>=0?"#2da44e":"#cf222e", weight:2, ...quiet}).addTo(g); }
  if(e.tab==="network" && e.net){ const n=e.net;
    for(const m of n.mobiles) if(m.lat!=null && m.radius_km) L.circle([m.lat,m.lon],{radius:m.radius_km*1000, color:"#8250df", weight:1, dashArray:"5 5", fillOpacity:.04, ...quiet}).addTo(g);
    for(const c of n.cochannel) L.circleMarker([c.lat,c.lon],{radius:4, color:"#57606a", weight:1, fillColor:"#8c959f", fillOpacity:.8, ...live}).bindTooltip(`Same channel: ${esc(c.licensee)} ${esc(c.call_sign)} · ${c.dist_mi} mi`).addTo(g);
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
function emFit(){ const e=S.emit; if(!e||!S.map) return; const pts=[[e.r.lat,e.r.lon]];
  if(e.net){ for(const s of e.net.sites) pts.push([s.lat,s.lon]); for(const m of e.net.microwave) pts.push([m.lat,m.lon]); }
  if(e.cov) pts.push(...e.cov.bounds);
  S.map.fitBounds(L.latLngBounds(pts).pad(.1)); }

// called by drawMap after it builds the map, so the panel and overlays survive re-renders
window.emitAfterDraw = () => { if(S.emit){ emitPanel(); emitDraw(); } };
