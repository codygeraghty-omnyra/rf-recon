"use strict";
/* RF Recon — core: state, search, layers, filters, map, detail. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtF = f => f == null || f === "" ? "" : Number(f).toFixed(5).replace(/0{1,2}$/, "");
const num = (v, d=0) => v == null || v === "" || isNaN(v) ? "" : Number(v).toFixed(d);
const api = async (path, opts) => { const r = await fetch(path, opts); const t = await r.text(); let j; try { j = JSON.parse(t); } catch(e){ throw new Error(t.slice(0,200) || r.statusText); }
  if(!r.ok || j.error) throw new Error(j.error || r.statusText); return j; };
const post = (path, body) => api(path, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{})});

const LAYERS = {
  uls:{label:"FCC licensed", color:"#0b6e4f"}, uls_hist:{label:"FCC history (expired / removed)", color:"#9a6700"},
  broadcast:{label:"Broadcast (AM / FM / TV)", color:"#953800"}, noaa:{label:"NOAA Weather Radio", color:"#1b7c83"},
  faa:{label:"Aviation (FAA)", color:"#0550ae"},
  towers:{label:"Towers (FCC ASR)", color:"#57606a"}, captures:{label:"My captures", color:"#cf222e"},
  wigle:{label:"WiGLE", color:"#8250df"}, opencellid:{label:"OpenCelliD", color:"#bf3989"},
  repeaterbook:{label:"RepeaterBook", color:"#1f6feb"}, custom:{label:"Imported layers", color:"#bf8700"}};

const S = { mode:"point", rows:[], center:null, radius:5, tab:"map",
  layerOn: new Set(["uls","broadcast","noaa","faa","towers","captures","wigle","opencellid","repeaterbook","custom"]),
  chips:{type:new Set(), cat:new Set(), band:new Set(), cls:new Set()},
  sort:{k:"dist_mi", dir:1}, shown:600, lib:{}, mission:null, missionId:null, heat:{kind:"off", opacity:.75},
  sel:null, filterExpr:"", views:{} };

/* ---------- decoders ---------- */
const EM1={N:"Unmodulated carrier",A:"AM, double sideband",H:"SSB, full carrier",R:"SSB, reduced carrier",J:"SSB, suppressed carrier",B:"Independent sidebands",C:"Vestigial sideband",F:"Frequency modulation (FM)",G:"Phase modulation (PM)",D:"AM + angle modulation",P:"Unmodulated pulses",K:"Pulse, amplitude-mod.",L:"Pulse, width-mod.",M:"Pulse, position-mod.",Q:"Pulse, angle-mod.",V:"Pulse, combination",W:"Combination",X:"Other"};
const EM2={"0":"No modulating signal","1":"Single channel digital, no subcarrier","2":"Single channel digital, with subcarrier","3":"Single channel analog","7":"Two+ channels digital","8":"Two+ channels analog","9":"Composite analog + digital","X":"Other"};
const EM3={N:"No information",A:"Telegraphy (aural)",B:"Telegraphy (automatic)",C:"Facsimile",D:"Data / telemetry / telecommand",E:"Telephony (voice)",F:"Video",W:"Combination",X:"Other"};
const SIGS=[["9K80D7","P25 Phase 2 (H-DQPSK, 2-slot TDMA)"],["8K10F1","P25 Phase 1 (C4FM, 12.5 kHz)"],["7K60FX","DMR (4FSK, 2-slot TDMA)"],["7K60F7","DMR (4FSK, 2-slot TDMA)"],["4K00F1","NXDN / dPMR (4FSK, 6.25 kHz)"],["4K00F7","NXDN / dPMR (6.25 kHz)"],["8K30F1","NXDN (4FSK, 12.5 kHz)"],["8K30F7","NXDN (12.5 kHz)"],["11K2F3E","Analog FM, 12.5 kHz narrowband"],["11K0F3E","Analog FM, 12.5 kHz narrowband"],["16K0F3E","Analog FM, 25 kHz wideband"],["20K0F3E","Analog FM, 25 kHz wideband"]];
function decodeEmission(code){ code=(code||"").trim().toUpperCase(); if(code.length<5) return null;
  const m=/^(\d*)([HKMG])(\d*)/.exec(code.slice(0,4)); const bw=m?parseFloat(`${m[1]||0}.${m[3]||0}`)*({H:1e-3,K:1,M:1e3,G:1e6}[m[2]]):null;
  const c=code.slice(4), sig=SIGS.find(([p])=>code.startsWith(p));
  return {code,bw,tech:sig?sig[1]:null,mod:EM1[c[0]]||c[0],nature:EM2[c[1]]||c[1],info:EM3[c[2]]||c[2]}; }
const CLASS={FB:"Base station",FB2:"Repeater (mobile relay)",FB4:"Community repeater",FB6:"Private carrier base",FB8:"Trunked base",FX:"Fixed station",FX1:"Control station",MO:"Mobile units",MO3:"Mobile / control",FBT:"Temporary base"};
const classLabel=c=>!c?"":CLASS[c]||(c.startsWith("FB")?`Base / repeater (${c})`:c.startsWith("FX")?`Fixed (${c})`:c.startsWith("MO")?`Mobile (${c})`:c);
function classGroup(r){ if(r.layer==="towers") return "Towers"; if(r.layer!=="uls"&&r.layer!=="uls_hist") return LAYERS[r.layer]?.label||r.layer;
  const c=r.station_class||""; if(c==="FB2"||c==="FB4") return "Repeaters"; if(c.startsWith("FB")) return "Base stations"; if(c.startsWith("FX")) return "Fixed / control"; if(c.startsWith("MO")) return "Mobiles"; return "Other"; }
const typeOf = r => r.layer==="towers" ? "Tower / structure" : (r.sig_type || "Unknown");
const colorOf = r => r.layer==="towers" ? "#57606a" : (S.lib[r.sig_type]?.color || LAYERS[r.layer]?.color || "#8c959f");
const erpOf = r => r.erp_w ?? r.power_out_w;
const levelOf = r => r.dbm ?? r.est_rx_dbm;
// RadioReference state pages are numbered by the census state FIPS code (stid/51 = Virginia)
const STATE_FIPS={AL:1,AK:2,AZ:4,AR:5,CA:6,CO:8,CT:9,DE:10,DC:11,FL:12,GA:13,HI:15,ID:16,IL:17,IN:18,IA:19,KS:20,KY:21,LA:22,ME:23,MD:24,MA:25,MI:26,MN:27,MS:28,MO:29,MT:30,NE:31,NV:32,NH:33,NJ:34,NM:35,NY:36,NC:37,ND:38,OH:39,OK:40,OR:41,PA:42,RI:44,SC:45,SD:46,TN:47,TX:48,UT:49,VT:50,VA:51,WA:53,WV:54,WI:55,WY:56};
const rrStateUrl = st => STATE_FIPS[st] ? `https://www.radioreference.com/db/browse/stid/${STATE_FIPS[st]}` : null;
const titleOf = r => r.ov_alpha_tag || r.label || r.licensee || r.call_sign || r.ident || (r.freq_mhz ? `${fmtF(r.freq_mhz)} MHz ${r.sig_type||""}`.trim() : "");

/* ---------- search ---------- */
function parseLoc(s){ s=(s||"").trim(); let m;
  // Maps links anywhere in the text; bare coordinates only when they're the whole entry, so "7400 22nd St" is an address
  if(!((m=/@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s))||(m=/[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s))||(m=/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(s)))) return null;
  const lat=parseFloat(m[1]), lon=parseFloat(m[2]);
  return Math.abs(lat)<=90 && Math.abs(lon)<=180 ? [lat,lon] : null; }
function params(extra){
  const p = new URLSearchParams();
  if(S.mode==="point"){ const ll=parseLoc($("#loc").value); if(ll){ p.set("lat",ll[0]); p.set("lon",ll[1]); } p.set("radius",$("#radius").value||5); }
  else if(S.mode==="nationwide") p.set("scope","nationwide");
  else { p.set("state",$("#state").value); if($("#county").value) p.set("county",$("#county").value); }
  for(const [id,k] of [["#q","q"],["#fmin","fmin"],["#fmax","fmax"]]) if($(id).value) p.set(k,$(id).value);
  if(window.searchFields) window.searchFields(p);  // FCC licence search fields (search.js)
  if($("#hideMobile").checked) p.set("hide_mobile","1");
  if(S.missionId) p.set("mission",S.missionId);
  p.set("layers", Object.keys(LAYERS).join(","));
  for(const [k,v] of Object.entries(extra||{})) if(v!==undefined && v!==null && v!=="") p.set(k,v);
  return p;
}
async function runSearch(){
  const st=$("#status"); st.className="status";
  if(S.mode==="point" && !parseLoc($("#loc").value)){ st.textContent="Type an address, place or county (pick a suggestion), enter coordinates, or click the map."; if(S.tab!=="map") setTab("map"); return; }
  if(S.mode==="county" && !$("#state").value){ st.textContent="Pick a state."; st.className="status err"; return; }
  st.textContent="Searching…"; $("#go").disabled=true;
  const gen=S.searchGen=(S.searchGen||0)+1;  // a slow earlier search must not overwrite a newer one (pin drags, radius slider)
  try{
    const res = await api("/api/area?"+params());
    if(gen!==S.searchGen) return;
    S.rows=res.rows; S.center=res.center; S.radius=res.radius||parseFloat($("#radius").value)||5; S.shown=600;
    st.textContent = res.truncated ? "Large area — showing the first 25,000 licensed entries. Narrow the radius or add filters." : "";
    $("#filters").style.display="";
    render();
    if(S.heat.kind!=="off") loadHeat();
  }catch(e){ if(gen===S.searchGen){ st.textContent="Error: "+e.message; st.className="status err"; } }
  finally{ if(gen===S.searchGen) $("#go").disabled=false; }
}

/* ---------- filters ---------- */
function passes(r, skip){
  if(!S.layerOn.has(r.layer)) return false;
  const c=S.chips;
  if(skip!=="type" && c.type.size && !c.type.has(typeOf(r))) return false;
  if(skip!=="cat" && c.cat.size && !c.cat.has(r.category||"Other")) return false;
  if(skip!=="band" && c.band.size && !c.band.has(r.band||"Other")) return false;
  if(skip!=="cls" && c.cls.size && !c.cls.has(classGroup(r))) return false;
  return true;
}
const filtered = () => S.rows.filter(r => passes(r));
function facet(key, getter, el, colorFn){
  const counts=new Map();
  for(const r of S.rows) if(passes(r,key)) { const v=getter(r); counts.set(v,(counts.get(v)||0)+1); }
  for(const v of S.chips[key]) if(!counts.has(v)) counts.set(v,0);
  el.innerHTML=[...counts].sort((a,b)=>b[1]-a[1]).map(([v,n])=>`<span class="chip ${S.chips[key].has(v)?"on":""}" data-k="${key}" data-v="${esc(v)}">${colorFn?`<span class="dot" style="background:${colorFn(v)}"></span>`:""}${esc(v)} <b>${n.toLocaleString()}</b></span>`).join("")||'<span class="hint">—</span>';
}
function renderFacets(){
  const lc=new Map(); for(const r of S.rows) lc.set(r.layer,(lc.get(r.layer)||0)+1);
  $("#fLayer").innerHTML=Object.entries(LAYERS).map(([k,l])=>`<span class="chip ${S.layerOn.has(k)?"":"off"}" data-layer="${k}"><span class="dot" style="background:${l.color}"></span>${esc(l.label)} <b>${(lc.get(k)||0).toLocaleString()}</b></span>`).join("");
  facet("type", typeOf, $("#fType"), t => S.lib[t]?.color || (t==="Tower / structure"?"#57606a":"#8c959f"));
  facet("cat", r=>r.category||"Other", $("#fCat"));
  facet("band", r=>r.band||"Other", $("#fBand"));
  facet("cls", classGroup, $("#fClass"));
  const n=S.chips.cat.size+S.chips.band.size+S.chips.cls.size; $("#moreCount").textContent=n?`· ${n} active`:"";
}
document.addEventListener("click", e => {
  const lc=e.target.closest(".chip[data-layer]");
  if(lc){ const k=lc.dataset.layer; S.layerOn.has(k)?S.layerOn.delete(k):S.layerOn.add(k); S.shown=600; render(); return; }
  const ch=e.target.closest(".chip[data-k]"); if(!ch) return;
  const set=S.chips[ch.dataset.k], v=ch.dataset.v; set.has(v)?set.delete(v):set.add(v); S.shown=600; render();
});
function toggleChip(key, v){ const set=S.chips[key]; set.has(v)?set.delete(v):set.add(v); render(); }

/* ---------- render dispatch ---------- */
function setTab(t){ S.tab=t; render(); }
function render(){
  renderFacets();
  const rows=filtered();
  const fq=new Set(rows.filter(r=>r.freq_mhz).map(r=>fmtF(r.freq_mhz)));
  $("#resultCount").textContent=`${rows.length.toLocaleString()} items · ${fq.size.toLocaleString()} frequencies${S.center?` · within ${S.radius} mi`:""}`;
  $$("#tabs button").forEach(b=>b.classList.toggle("on", b.dataset.t===S.tab));
  const v=$("#view");
  if(S.tab!=="map" && S.map){ S.map.remove(); S.map=null; }
  if(S.tab!=="dashboard" && S.dashMap){ S.dashMap.remove(); S.dashMap=null; }
  const fn = S.views[S.tab];
  if(fn) fn(v, rows); else v.innerHTML="";
  if(window.writeUrlState) window.writeUrlState();
}
$("#tabs").addEventListener("click", e => { const b=e.target.closest("button"); if(b) setTab(b.dataset.t); });

/* ---------- map view ---------- */
function niceStep(r){ const raw=r/5; const p=Math.pow(10,Math.floor(Math.log10(raw))); for(const m of [1,2,2.5,5,10]) if(raw<=m*p) return m*p; return raw; }
function groupItems(rows){
  // one list entry per (site, licensee/label, frequency); captures and crowd points stay individual
  const m=new Map();
  for(const r of rows){
    const k = (r.layer==="uls"||r.layer==="uls_hist") ? `${r.layer}|${r.lat}|${r.lon}|${r.call_sign}|${fmtF(r.freq_mhz)}` : r.fid;
    if(!m.has(k)) m.set(k, r);
  }
  return [...m.values()];
}
S.views.map = (v, rows) => {
  v.innerHTML = `
    <div class="maptools no-print">
      <label class="inl">Heatmap <select id="heatKind">
        <option value="off">Off</option><option value="predicted">Predicted from licenses (free-space)</option>
        <option value="measured">Measured (my captures / WiGLE)</option><option value="density">Density of everything shown</option></select></label>
      <details class="inl" id="heatFiles" style="position:relative;${S.heat.kind==="measured"?"":"display:none"}"><summary title="Which survey files the measured heatmap uses">${heatFilesLabel()}</summary>
        <div class="panel" style="position:absolute;z-index:1000;min-width:260px;max-height:300px;overflow:auto;margin-top:4px;padding:8px">${heatFileList().map(([k,l,n])=>`<label style="display:block;white-space:nowrap"><input type="checkbox" data-hf="${esc(k)}" ${S.heat.files?.has(k)?"checked":""}> ${esc(l)} <span class="hint">${n}</span></label>`).join("")||'<span class="hint">No survey points with levels in this area yet.</span>'}
          ${S.heat.files?.size?'<button id="heatFilesAll" style="margin-top:6px">Use every file</button>':""}</div></details>
      ${S.heat.kind==="measured"&&(S.heat.ident||S.heat.freq)?`<span class="tag">Signal: ${esc(S.heat.signal||S.heat.ident||S.heat.freq)} <a href="#" id="heatSigClear" title="Back to every signal">✕</a></span>`:""}
      <label class="inl">Opacity <input type="range" id="heatOp" min="0.1" max="1" step="0.05" value="${S.heat.opacity}" style="width:90px"></label>
      <button id="heatExport" title="KMZ for Google Earth / ATAK, GeoTIFF for QGIS / ArcGIS / Global Mapper">⇩ Heatmap (KMZ + GeoTIFF)</button>
      <span class="hint" style="margin-left:auto">${S.center?(S.pinLocked?"Pin locked: click a dot for its coverage, network or cell site.":"Drag the pin or click the map to move it. Lock it (top left) to click emitters freely."):""}</span>
      <div class="seg"><button data-lv="list" class="${S.listMode!=="table"?"on":""}">List</button><button data-lv="table" class="${S.listMode==="table"?"on":""}">Table</button></div>
    </div>
    <div class="mapwrap" id="mapwrap" style="${S.listMode==="table"?"grid-template-columns:1fr":""}">
      <div id="map"></div>
      <div class="side" id="side" style="${S.listMode==="table"?"display:none":""}"></div>
    </div>
    <div id="emitPanel"></div>
    <div id="mapTable" style="margin-top:10px"></div>`;
  $("#heatKind").value=S.heat.kind;
  $("#heatKind").onchange=e=>{ S.heat.kind=e.target.value; $("#heatFiles").style.display=S.heat.kind==="measured"?"":"none"; loadHeat(); };
  v.querySelectorAll("[data-hf]").forEach(c=>c.onchange=()=>{ S.heat.files=S.heat.files||new Set(); c.checked?S.heat.files.add(c.dataset.hf):S.heat.files.delete(c.dataset.hf);
    $("#heatFiles summary").textContent=heatFilesLabel(); loadHeat(); });
  if($("#heatFilesAll")) $("#heatFilesAll").onclick=()=>{ S.heat.files=new Set(); render(); loadHeat(); };
  if($("#heatSigClear")) $("#heatSigClear").onclick=e=>{ e.preventDefault(); S.heat.ident=S.heat.freq=S.heat.signal=""; render(); loadHeat(); };
  $("#heatOp").oninput=e=>{ S.heat.opacity=+e.target.value; if(S.heatLayer) S.heatLayer.setOpacity(S.heat.opacity); };
  $("#heatExport").onclick=()=>{ if(!S.center){ alert("Heatmaps need a pin."); return; } const k=S.heat.kind==="off"?"predicted":S.heat.kind;
    location.href="/api/heatmap.zip?"+params(heatParams(k)); };
  v.querySelectorAll("[data-lv]").forEach(b=>b.onclick=()=>{ S.listMode=b.dataset.lv; render(); });
  drawMap(rows);
  const items=groupItems(rows);
  if(S.listMode==="table") $("#mapTable").innerHTML = S.views.freqTable(items);
  else drawSideList(items);
};

function drawSideList(items){
  const side=$("#side"); if(!side) return;
  if(!items.length){ side.innerHTML='<p class="status" style="padding:10px">Nothing here with the current layers and filters.</p>'; return; }
  const step = S.center ? niceStep(S.radius) : null;
  let html="", ring=-1, n=0;
  for(const r of items.slice(0, S.shown)){
    if(step!=null && r.dist_mi!=null){ const rg=Math.floor(r.dist_mi/step); if(rg!==ring){ ring=rg; const cnt=items.filter(x=>x.dist_mi!=null&&Math.floor(x.dist_mi/step)===rg).length;
      html+=`<div class="ring">${num(rg*step,step<1?2:1)}–${num((rg+1)*step,step<1?2:1)} mi · ${cnt}</div>`; } }
    const lvl = levelOf(r);
    html+=`<div class="item" data-fid="${esc(r.fid)}"><span class="d">${r.dist_mi!=null?num(r.dist_mi,2)+" mi":""}<br>${r.compass||""}</span>
      <span class="t"><span class="dot" style="background:${colorOf(r)}"></span> ${r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)}</span> `:""}${esc(titleOf(r))}</span>
      <span class="s">${esc(typeOf(r))} · ${esc(LAYERS[r.layer]?.label||r.layer)}${lvl!=null?` · ${num(lvl,0)} dBm${r.dbm==null?" est":""}`:""}${erpOf(r)?` · ${num(erpOf(r))} W`:""}</span></div>`;
    n++;
  }
  if(items.length>S.shown) html+=`<button class="more" id="moreSide" style="margin:8px">Show more (${(items.length-S.shown).toLocaleString()})</button>`;
  side.innerHTML=html;
  side.onclick=e=>{ if(e.target.id==="moreSide"){ S.shown+=1000; drawSideList(items); return; }
    const it=e.target.closest(".item"); if(!it) return; const r=S.rows.find(x=>x.fid===it.dataset.fid); if(!r) return;
    selectFeature(r, true); };
  side.ondblclick=e=>{ const it=e.target.closest(".item"); if(it) openDetail(it.dataset.fid); };
}

function selectFeature(r, pan){
  S.sel=r.fid;
  $$("#side .item").forEach(x=>x.classList.toggle("sel", x.dataset.fid===r.fid));
  if(S.map && r.lat!=null){ if(pan) S.map.panTo([r.lat,r.lon]); const mk=S.markerIndex?.get(`${r.lat},${r.lon}`); if(mk) mk.openPopup(); }
}

function pinIcon(){ return L.divIcon({className:"", html:'<div class="pinicon" style="width:22px;height:22px"></div>', iconSize:[22,22], iconAnchor:[11,22]}); }

/* ---------- map layers: backgrounds + overlays, kept across searches and visits ---------- */
const USGS="USGS The National Map";
const BASEMAPS={  // served through /tiles/<src>/ so viewed tiles are cached for offline use
  "Street (OpenStreetMap)":{src:"osm", maxZoom:19, attribution:"© OpenStreetMap contributors"},
  "Satellite (USGS)":{src:"usgs-imagery", maxNativeZoom:16, maxZoom:19, attribution:USGS},
  "Satellite + labels (USGS)":{src:"usgs-imagery-topo", maxNativeZoom:16, maxZoom:19, attribution:USGS},
  "Satellite hi-res (Esri)":{src:"esri-imagery", maxNativeZoom:19, maxZoom:19, attribution:"Esri, Maxar, Earthstar Geographics"},
  "Topo (USGS)":{src:"usgs-topo", maxNativeZoom:16, maxZoom:19, attribution:USGS},
  "Terrain relief (USGS)":{src:"usgs-relief", maxNativeZoom:16, maxZoom:19, attribution:USGS},
};
const OVERLAYS={
  "County + state lines":()=>L.tileLayer("/tiles/counties/{z}/{x}/{y}.png",{maxZoom:19, zIndex:5, attribution:"US Census Bureau TIGERweb"}),
  // live, so loaded straight from the source and never cached; the 5-minute stamp refreshes it
  "Weather radar (NEXRAD, live)":()=>L.tileLayer("https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?t="+Math.floor(Date.now()/3e5),
    {maxZoom:19, opacity:.6, zIndex:6, attribution:"NEXRAD via Iowa Environmental Mesonet"}),
};
function mapPrefs(){
  if(!S.mapLayers){ let saved={}; try{ saved=JSON.parse(localStorage.getItem("rfr.mapLayers"))||{}; }catch(e){}
    S.mapLayers={base:BASEMAPS[saved.base]?saved.base:"Street (OpenStreetMap)", overlays:(saved.overlays||[]).filter(n=>OVERLAYS[n])}; }
  return S.mapLayers;
}
function addMapLayers(map){
  const pref=mapPrefs(), bases={}, overs={};
  for(const [name,{src,...opt}] of Object.entries(BASEMAPS)) bases[name]=L.tileLayer(`/tiles/${src}/{z}/{x}/{y}.png`,opt);
  for(const [name,make] of Object.entries(OVERLAYS)) overs[name]=make();
  bases[pref.base].addTo(map);
  for(const n of pref.overlays) overs[n].addTo(map);
  L.control.layers(bases, overs, {position:"topright"}).addTo(map);
  let unloading=false;  // map.remove() (leaving the tab) removes every layer; that isn't a choice to save
  map.on("unload",()=>{ unloading=true; });
  const save=()=>{ if(unloading) return; try{ localStorage.setItem("rfr.mapLayers", JSON.stringify(pref)); }catch(e){} };
  map.on("baselayerchange", e=>{ pref.base=e.name; save(); });
  map.on("overlayadd", e=>{ if(!pref.overlays.includes(e.name)) pref.overlays.push(e.name); save(); });
  map.on("overlayremove", e=>{ if(unloading) return; pref.overlays=pref.overlays.filter(n=>n!==e.name); save(); });
}

function drawMap(rows){
  if(typeof L==="undefined"){ $("#map").innerHTML='<p class="status" style="padding:12px">Map library missing.</p>'; return; }
  const map=L.map("map",{preferCanvas:true, zoomControl:true}); S.map=map;
  addMapLayers(map);
  const canvas=L.canvas({padding:.3});
  S.markerIndex=new Map();
  const sites=new Map();
  for(const r of rows){ if(r.lat==null) continue; const k=`${r.lat},${r.lon}`; if(!sites.has(k)) sites.set(k,[]); sites.get(k).push(r); }
  for(const [k,rs] of sites){
    const r0=rs[0], tower=rs.some(r=>r.layer==="towers");
    const big = rs.some(r=>r.layer==="uls"||r.layer==="towers"||r.layer==="repeaterbook");
    const mk = L.circleMarker([r0.lat,r0.lon],{renderer:canvas, radius: big ? 5+Math.min(7,Math.sqrt(rs.length)) : 4, bubblingMouseEvents:false,
      color: tower ? "#24292f" : colorOf(r0), weight: tower?3:1.5, fillColor: colorOf(rs.find(r=>r.layer!=="towers")||r0), fillOpacity: big?.75:.55});
    // each entry: what it is, then where it reaches, what it's networked with and (for a cell) its site
    const acts=r=>{ const a=[]; if(r.layer!=="towers"&&(erpOf(r)||emIsCell(r))) a.push(`<a href="#" data-em="coverage" data-fid="${esc(r.fid)}">coverage</a>`);
      if(emIsUls(r)) a.push(`<a href="#" data-em="network" data-fid="${esc(r.fid)}">network</a>`);
      if(emIsCell(r)) a.push(`<a href="#" data-em="cell" data-fid="${esc(r.fid)}">cell site</a>`);
      if(emSurvey(r)&&r.dbm!=null) a.push(`<a href="#" data-em="measured" data-fid="${esc(r.fid)}">measured</a>`);
      return a.length?` <span class="hint" style="white-space:nowrap">· ${a.join(" · ")}</span>`:""; };
    const lines=groupItems(rs).slice(0,14).map(r=>`<div><span class="dot" style="background:${colorOf(r)}"></span> ${r.freq_mhz?`<b class="mono">${fmtF(r.freq_mhz)}</b> `:""}${esc(titleOf(r))} <span class="hint">${esc(typeOf(r))}</span>${acts(r)}</div>`).join("");
    mk.bindPopup(`<div style="max-width:300px">${r0.dist_mi!=null?`<div class="hint">${num(r0.dist_mi,2)} mi ${r0.compass||""} from pin</div>`:""}${lines}${rs.length>14?`<div class="hint">+${rs.length-14} more</div>`:""}<a href="#" data-open="${esc(r0.fid)}">Details</a></div>`);
    mk.on("click",()=>{ S.sel=r0.fid; $$("#side .item").forEach(x=>{ const hit=rs.some(r=>r.fid===x.dataset.fid); x.classList.toggle("sel",hit); if(hit && x===$$("#side .item").find(y=>rs.some(r=>r.fid===y.dataset.fid))) x.scrollIntoView({block:"nearest"}); }); });
    mk.addTo(map); S.markerIndex.set(k,mk);
  }
  map.on("popupopen", ev=>{ const el=ev.popup.getElement(), a=el.querySelector("[data-open]"); if(a) a.onclick=e=>{ e.preventDefault(); openDetail(a.dataset.open); };
    el.querySelectorAll("[data-em]").forEach(b=>b.onclick=e=>{ e.preventDefault(); const r=S.rows.find(x=>x.fid===b.dataset.fid); if(!r) return; map.closePopup();
      if(b.dataset.em==="measured"){ S.heat.kind="measured"; S.heat.ident=r.ident||String(r.ext_id||"").replace(/^\w+:/,""); S.heat.freq=r.ident||r.ext_id?"":(r.freq_mhz??""); S.heat.signal=titleOf(r); render(); loadHeat(); }
      else emitOpen(r, b.dataset.em); }); });
  // mission GPS tracks
  if(S.mission?.tracks) for(const t of S.mission.tracks) L.polyline(t,{color:"#fb8500",weight:3,opacity:.8}).addTo(map);
  L.control.scale({imperial:true, metric:true}).addTo(map);
  // pin lock: when locked, clicks select things on the map and never move the pin (remembered in this browser)
  if(S.pinLocked==null){ try{ S.pinLocked=localStorage.getItem("rfr.pinLocked")==="1"; }catch(e){ S.pinLocked=false; } }
  const Lock=L.Control.extend({onAdd(){ const b=L.DomUtil.create("button","leaflet-bar"); b.id="pinLock";
    b.style.cssText="padding:4px 8px;font:600 12px system-ui;cursor:pointer;background:var(--panel,#fff);color:var(--ink,#111)";
    const paint=()=>{ b.textContent=S.pinLocked?"🔒 Pin locked":"🔓 Pin moves on click"; b.title=S.pinLocked?"Clicks select emitters; the pin stays put. Click to unlock.":"Clicking the map moves the pin. Click to lock it."; };
    paint(); L.DomEvent.disableClickPropagation(b);
    b.onclick=()=>{ S.pinLocked=!S.pinLocked; try{ localStorage.setItem("rfr.pinLocked", S.pinLocked?"1":"0"); }catch(e){} paint();
      if(S.pinMarker){ S.pinLocked?S.pinMarker.dragging?.disable():S.pinMarker.dragging?.enable(); } };
    return b; }});
  new Lock({position:"topleft"}).addTo(map);
  if(S.center){
    const pin=L.marker(S.center,{draggable:!S.pinLocked, icon:pinIcon(), zIndexOffset:1000}).addTo(map); S.pinMarker=pin;
    pin.on("dragend",()=>{ const p=pin.getLatLng(); $("#loc").value=`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`; runSearch(); });
    const rm=S.radius*1609.344, stepMi=niceStep(S.radius), step=stepMi*1609.344;
    // distance rings, each labelled on its north side
    const ringLabel=(mi,d)=>L.marker([S.center[0]+d/111320, S.center[1]],{interactive:false, icon:L.divIcon({className:"", iconSize:[60,14], iconAnchor:[30,7],
      html:`<span style="font:600 10px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:1px 5px;border-radius:7px;white-space:nowrap">${+mi.toFixed(2)} mi</span>`})}).addTo(map);
    for(let d=step, i=1; d<rm-1; d+=step, i++){ L.circle(S.center,{radius:d,color:"#888",weight:1,dashArray:"3 5",fill:false,interactive:false}).addTo(map); ringLabel(stepMi*i,d); }
    L.circle(S.center,{radius:rm,color:"#555",weight:2,fill:false,interactive:false}).addTo(map); ringLabel(S.radius,rm);
    // live readout: where the cursor is, and how far / which way from the pin
    const Readout=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","legend"); d.id="mapReadout"; d.style.cssText="font:11px ui-monospace,monospace;padding:4px 8px"; d.textContent="Move over the map for position, distance and bearing from the pin"; return d; }});
    new Readout({position:"bottomleft"}).addTo(map);
    map.on("mousemove", e=>{ const el=$("#mapReadout"); if(!el) return; const [la,lo]=S.center, p=e.latlng, R=3958.8, rad=Math.PI/180;
      const dLa=(p.lat-la)*rad, dLo=(p.lng-lo)*rad, h=Math.sin(dLa/2)**2+Math.cos(la*rad)*Math.cos(p.lat*rad)*Math.sin(dLo/2)**2, mi=2*R*Math.asin(Math.sqrt(h));
      const brg=(Math.atan2(Math.sin(dLo)*Math.cos(p.lat*rad), Math.cos(la*rad)*Math.sin(p.lat*rad)-Math.sin(la*rad)*Math.cos(p.lat*rad)*Math.cos(dLo))/rad+360)%360;
      const pts=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(brg/22.5)%16];
      el.textContent=`${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ${mi.toFixed(2)} mi ${pts} (${Math.round(brg)}°) from the pin`; });
    map.fitBounds(L.latLng(S.center).toBounds(rm*2.1));
  } else if(sites.size) map.fitBounds([...sites.values()].map(rs=>[rs[0].lat,rs[0].lon]));
  else map.setView([39.5,-98.35],4);
  map.on("click", e=>{ if(S.mode!=="point" || S.pinLocked) return; $("#loc").value=`${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; runSearch(); });
  if(S.heatImg) addHeatLayer();
  if(window.emitAfterDraw) window.emitAfterDraw();
}

/* ---------- heatmap ---------- */
// survey files in the current results: capture files, and imported or crowd layers, with how many points carry a level
const heatFileKey = r => r.layer==="captures" ? `cap:${r.capture_id}` : `${r.layer}:${r.category||""}`;
function heatFileList(){
  const m=new Map();
  for(const r of S.rows) if(["captures","wigle","opencellid","custom"].includes(r.layer) && r.dbm!=null){ const k=heatFileKey(r);
    const x=m.get(k)||[k, r.layer==="captures"?(r.capture_name||`Capture ${r.capture_id}`):(r.category||r.layer), 0]; x[2]++; m.set(k,x); }
  return [...m.values()].sort((a,b)=>b[2]-a[2]);
}
const heatFilesLabel = () => S.heat.files?.size ? `Files: ${S.heat.files.size} chosen` : "Files: all";
function heatParams(kind){
  const s=S.mission?.settings||{};
  return {kind, size:s.heat_size||200, metric:s.heat_metric||"mean", combine:s.heat_combine||"max", alpha:s.heat_alpha||190,
    types:[...S.chips.type].join("|"), bands:[...S.chips.band].join("|"), cats:[...S.chips.cat].join("|"),
    layers:[...S.layerOn].join(","), name:(S.mission?.name||"rf")+"_"+kind,
    ...(kind==="measured"?{files:[...(S.heat.files||[])].join("|"), ident:S.heat.ident||"", freq:S.heat.freq??""}:{})};
}
async function loadHeat(){
  if(S.heatLayer && S.map){ S.map.removeLayer(S.heatLayer); } S.heatLayer=null; S.heatImg=null;
  if(S.heatLegend && S.map){ S.map.removeControl(S.heatLegend); S.heatLegend=null; }
  if(S.heat.kind==="off" || !S.center) return;
  $("#status").textContent="Building heatmap…";
  try{ const h=await api("/api/heatmap?"+params(heatParams(S.heat.kind))); S.heatImg=h; $("#status").textContent=""; addHeatLayer(); }
  catch(e){ $("#status").textContent="Heatmap: "+e.message; }
}
function addHeatLayer(){
  const h=S.heatImg; if(!h||!S.map) return;
  S.heatLayer=L.imageOverlay("data:image/png;base64,"+h.png, h.bounds, {opacity:S.heat.opacity, interactive:false}).addTo(S.map);
  const Lg=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","legend"); d.innerHTML=`<div>${esc(h.desc)}</div><div class="bar"></div><div style="display:flex;justify-content:space-between"><span>${num(h.vmin,0)}</span><span>${esc(h.unit)}</span><span>${num(h.vmax,0)}</span></div>`; return d; }});
  S.heatLegend=new Lg({position:"bottomleft"}); S.heatLegend.addTo(S.map);
}

/* ---------- detail ---------- */
function kvg(pairs){ return `<div class="kvg">${pairs.filter(p=>p[1]!==""&&p[1]!=null&&p[1]!==undefined).map(([k,v])=>`<div>${k}</div><div>${v}</div>`).join("")}</div>`; }
function openDetail(fid){
  const r=S.rows.find(x=>x.fid===fid); if(!r) return;
  const uls = r.layer==="uls"||r.layer==="uls_hist";
  const lib = S.lib[r.sig_type];
  $("#dlgTitle").innerHTML=`${r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span> · `:""}${esc(titleOf(r))}`;
  let html = kvg([["Source", `<span class="dot" style="background:${LAYERS[r.layer]?.color}"></span> ${esc(LAYERS[r.layer]?.label||r.layer)}${r.attribution?` <span class="hint">· ${esc(r.attribution)}</span>`:""}`],
    ["Signal type", r.sig_type?`<b>${esc(r.sig_type)}</b>${lib?` · ${esc(lib.family)} · ${esc(lib.bw)} · <a href="${lib.url}" target="_blank" rel="noopener">Signal ID wiki ↗</a>`:""}`:""],
    ["How identified", esc(r.sig_basis||(uls?"FCC license emission designators":""))+(r.sig_conf?` <span class="tag">${esc(r.sig_conf)} confidence</span>`:"")],
    ["Distance", r.dist_mi!=null?`${num(r.dist_mi,2)} mi, bearing ${r.bearing}° (${r.compass})`:""],
    ["Coordinates", r.lat!=null?`<span class="mono">${r.lat}, ${r.lon}</span> · <a href="https://www.google.com/maps?q=${r.lat},${r.lon}" target="_blank" rel="noopener">map ↗</a>`:""]]);
  if(uls){
    const ems=(r.emissions||"").split(/\s+/).filter(Boolean).map(decodeEmission).filter(Boolean);
    const same=S.rows.filter(x=>x.call_sign===r.call_sign && x.layer===r.layer);
    const tower=r.tower_reg?S.rows.find(x=>x.layer==="towers"&&x.reg===r.tower_reg):null;
    const coloc=r.tower_reg?[...new Set(S.rows.filter(x=>x.tower_reg===r.tower_reg&&x.licensee!==r.licensee).map(x=>x.licensee))]:[];
    html += `<div class="sec"><h3>License</h3>${kvg([["Call sign",`<span class="mono">${esc(r.call_sign)}</span>${r.usi?` · <a href="https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${r.usi}" target="_blank" rel="noopener">FCC license ↗</a>`:""}`],
      ["Status", esc({A:"Active",E:"Expired",C:"Cancelled",T:"Terminated",REMOVED:"Removed since an earlier import"}[r.status]||r.status||"")],
      ["Licensee", esc(r.licensee)], ["Category", esc(r.category)], ["Radio service", `${esc(r.service||"")} — ${esc(r.service_name||"")}`],
      ["Station type", `${esc(classLabel(r.station_class))} <span class="mono hint">${esc(r.station_class||"")}</span>`],
      ["Frequency", `<span class="mono">${fmtF(r.freq_mhz)}${r.freq_upper_mhz?" – "+fmtF(r.freq_upper_mhz):""} MHz</span> · ${esc(r.band||"")}`],
      ["Tolerance", esc(r.tolerance||"")], ["Units", r.units||""], ["Dates", r.grant_date?`granted ${esc(r.grant_date)} · expires ${esc(r.expired_date||"?")}`:(r.first_seen?`seen ${esc(r.first_seen)} → ${esc(r.last_seen)}`:"")]])}</div>
      <div class="sec"><h3>Signal / waveform</h3>${ems.length?ems.map(d=>kvg([["Emission",`<span class="mono">${esc(d.code)}</span>${d.tech?` — <b>${esc(d.tech)}</b>`:""}`],["Necessary bandwidth",d.bw!=null?(d.bw>=1000?(d.bw/1000).toFixed(2)+" MHz":d.bw.toFixed(2)+" kHz"):""],["Modulation",esc(d.mod)],["Signal",esc(d.nature)],["Information",esc(d.info)]])).join('<hr style="border:0;border-top:1px solid var(--line)">'):'<p class="hint">No emission designator on file.</p>'}
        ${kvg([["Digital mod (ULS)",esc(r.digital_mod||"")],["Transmitter",esc([r.tx_make,r.tx_model].filter(Boolean).join(" "))]])}</div>
      <div class="sec"><h3>Power, antenna & structure</h3>${kvg([["Output power",r.power_out_w!=null?`${r.power_out_w} W`:""],["ERP",r.erp_w!=null?`${r.erp_w} W (${(10*Math.log10(r.erp_w*1000)).toFixed(1)} dBm)`:""],
        ["Antenna",esc([r.ant_make,r.ant_model].filter(Boolean).join(" "))],["Gain",r.gain_dbi!=null?`${r.gain_dbi} dBi`:""],["Polarization",esc(r.polarization||"")],["Azimuth / beamwidth",r.azimuth!=null||r.beamwidth!=null?`${r.azimuth??"–"}° / ${r.beamwidth??"–"}°`:""],
        ["Height AGL",r.height_tip_m!=null?`${r.height_tip_m} m (${Math.round(r.height_tip_m*3.281)} ft)`:""],["HAAT",r.haat_m!=null?`${r.haat_m} m`:""],["Ground elevation",r.ground_elev_m!=null?`${r.ground_elev_m} m`:""],
        ["Tower (ASR)", r.tower_reg?`<span class="mono">${esc(r.tower_reg)}</span>${tower?` · ${esc(tower.struct_type||"")} ${tower.overall_agl_m??"?"} m · ${esc(tower.owner||"")}`:""}`:""],
        ["Also on this tower", coloc.length?esc(coloc.slice(0,8).join("; ")):""],["Est. level at pin",r.est_rx_dbm!=null?`${r.est_rx_dbm} dBm (free-space, best case)`:""],
        ["Site",esc([r.address,r.city,r.county&&r.county+" Co.",r.state].filter(Boolean).join(", "))]])}</div>
      <div class="sec"><h3>Same license, other frequencies (${new Set(same.map(x=>fmtF(x.freq_mhz))).size})</h3><p class="mono" style="white-space:normal">${[...new Set(same.map(x=>fmtF(x.freq_mhz)))].join(" · ")}</p></div>
      <div class="sec no-print"><h3>Your labels</h3><div class="row">
        <label>Alpha tag <input id="ovTag" value="${esc(r.ov_alpha_tag||"")}" style="width:130px"></label>
        <label>Tone / NAC / CC <input id="ovTone" value="${esc(r.ov_tone||"")}" style="width:110px"></label>
        <label>Tag <input id="ovT" value="${esc(r.ov_tag||"")}" style="width:120px"></label>
        <label class="grow">Description <input id="ovDesc" value="${esc(r.ov_description||"")}"></label></div>
        <div class="row" style="margin-top:6px"><label class="grow">Notes <input id="ovNotes" value="${esc(r.ov_notes||"")}"></label>
        <label class="inl"><input type="checkbox" id="ovVer" ${r.ov_verified?"checked":""}> Verified in use</label><button class="primary" id="ovSave">Save label</button></div></div>
      ${S.missionId?`<div class="sec no-print"><h3>Observation — ${esc(S.mission?.name||"mission")}</h3><div class="row">
        <label>Status <select id="obStatus">${["","heard","not heard","intermittent","interference"].map(s=>`<option ${r.obs_status===s?"selected":""}>${s}</option>`).join("")}</select></label>
        <label>Level dBm <input id="obLevel" type="number" step="any" value="${r.obs_level??""}" style="width:90px"></label>
        <label class="grow">Notes <input id="obNotes" value="${esc(r.obs_notes||"")}"></label><button class="primary" id="obSave">Save</button></div></div>`:""}`;
  } else if(r.layer==="towers"){
    html += `<div class="sec"><h3>Structure</h3>${kvg([["Registration",`<span class="mono">${esc(r.reg)}</span>`],["Type",esc(r.struct_type)],["Structure height",r.height_m!=null?`${r.height_m} m`:""],
      ["Overall height AGL",r.overall_agl_m!=null?`${r.overall_agl_m} m (${Math.round(r.overall_agl_m*3.281)} ft)`:""],["Overall AMSL",r.overall_amsl_m!=null?`${r.overall_amsl_m} m`:""],
      ["Ground elevation",r.ground_elev_m!=null?`${r.ground_elev_m} m`:""],["Owner",esc(r.owner)],["Status",esc(r.status)],["Constructed",esc(r.constructed)],["FAA study",esc(r.faa_study)],
      ["Address",esc([r.street,r.city,r.state].filter(Boolean).join(", "))]])}
      <h3 style="margin-top:10px">Licensed transmitters on this structure</h3><p>${esc([...new Set(S.rows.filter(x=>x.tower_reg===r.reg).map(x=>`${x.licensee} (${fmtF(x.freq_mhz)})`))].slice(0,30).join("; ")||"None linked in the current results.")}</p></div>`;
  } else {
    let extra={}; try{ extra=JSON.parse(r.details||r.extra||"{}")||{}; }catch(e){}
    html += `<div class="sec"><h3>Record</h3>${kvg([["Type / tech",esc(r.kind||"")],["Label / SSID",esc(r.label||"")],["Identifier",`<span class="mono">${esc(r.ident||r.ext_id||"")}</span>`],
      ["Frequency",r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span>${r.freq_in_mhz?` (input ${fmtF(r.freq_in_mhz)})`:""} · ${esc(r.band||"")}`:""],["Channel",esc(r.channel||"")],
      ["Level",r.dbm!=null?`${r.dbm} dBm`:""],["Bandwidth",r.bw_khz?`${r.bw_khz} kHz`:""],["Mode / tones",esc(r.mode||"")],["Security",esc(r.auth||"")],
      ["Time",esc(r.ts||"")],["First / last seen",r.first_seen||r.last_seen?`${esc(r.first_seen||"?")} → ${esc(r.last_seen||"?")}`:""],
      ["GPS accuracy",r.acc!=null?`${r.acc} m`:""],["Capture",esc(r.capture_name||"")],["Fetched",esc(r.fetched_at||"")]])}</div>
      ${Object.keys(extra).length?`<div class="sec"><h3>All fields</h3>${kvg(Object.entries(extra).map(([k,v])=>[esc(k),`<span class="mono">${esc(typeof v==="object"?JSON.stringify(v):v)}</span>`]))}</div>`:""}`;
  }
  $("#dlgBody").innerHTML=html;
  if(r.lat!=null && r.layer!=="towers"){  // the same emitter on the map: where it reaches, what it's networked with, its cell site
    const acts=[(erpOf(r)||emIsCell(r))&&["coverage","Coverage on the map"], emIsUls(r)&&["network","Network"], emIsCell(r)&&["cell","Cell site"]].filter(Boolean);
    if(acts.length){ const bar=document.createElement("div"); bar.className="row no-print"; bar.style.cssText="gap:6px;margin-bottom:8px";
      bar.innerHTML=acts.map(([k,l])=>`<button data-emd="${k}">${l}</button>`).join("");
      bar.querySelectorAll("[data-emd]").forEach(b=>b.onclick=()=>emitOpen(r, b.dataset.emd)); $("#dlgBody").prepend(bar); }
  }
  if(uls && r.call_sign){  // the same licence on the FCC's own site and on RadioReference (links only: RR's data can't be copied)
    const box=document.createElement("div"); box.className="sec";
    box.innerHTML=`<h3>RadioReference</h3><p><a href="https://www.radioreference.com/db/fcc/callsign/${encodeURIComponent(r.call_sign)}" target="_blank" rel="noopener">${esc(r.call_sign)} on RadioReference</a>
      ${rrStateUrl(r.state)?` · <a href="${rrStateUrl(r.state)}" target="_blank" rel="noopener">RadioReference: ${esc(r.state)} systems and counties</a>`:""}</p>`;
    $("#dlgBody").appendChild(box);
  }
  if(r.freq_mhz){  // what it could be, from the Signal Identification Wiki catalog (cached locally)
    const box=document.createElement("div"); box.className="sec"; const head='<h3>Signal Identification Wiki: what this could be</h3>';
    box.innerHTML=head+'<p class="hint">Looking…</p>'; $("#dlgBody").appendChild(box);
    api(`/api/sigwiki/match?freq=${r.freq_mhz}&bw=${r.bandwidth_khz||r.bw_khz||""}&type=${encodeURIComponent(r.sig_type||"")}`).then(m=>{
      box.innerHTML=head+(m.candidates.length?m.candidates.map(c=>`<div style="margin:6px 0"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>
        <span class="hint">${esc(c.why.join(" · "))}${c.mode?` · ${esc(c.mode)}`:""}${c.modulation?` · ${esc(c.modulation)}`:""}</span><br><span class="hint">${esc(c.description)}</span></div>`).join("")
        :'<p class="hint">Nothing in the catalog covers this frequency. It covers digital and unusual signals; everyday voice, broadcast and weather radio are in the band plan.</p>')
        +'<p class="hint">From sigidwiki.com. Open a page for audio samples, waterfalls and decoding notes.</p>'; })
      .catch(()=>{ box.innerHTML=head+'<p class="hint">Catalog not loaded yet: Data &amp; updates → Signal ID Wiki catalog → Run now.</p>'; });
  }
  if($("#ovSave")) $("#ovSave").onclick=async()=>{ const d={call_sign:r.call_sign,freq_mhz:r.freq_mhz,county:r.county,state:r.state,alpha_tag:$("#ovTag").value,tone:$("#ovTone").value,tag:$("#ovT").value,description:$("#ovDesc").value,notes:$("#ovNotes").value,verified:$("#ovVer").checked};
    await post("/api/overlay",d); for(const x of S.rows) if(x.call_sign===r.call_sign&&fmtF(x.freq_mhz)===fmtF(r.freq_mhz)) Object.assign(x,{ov_alpha_tag:d.alpha_tag,ov_tone:d.tone,ov_tag:d.tag,ov_description:d.description,ov_notes:d.notes,ov_verified:d.verified?1:0}); $("#dlg").close(); render(); };
  if($("#obSave")) $("#obSave").onclick=async()=>{ const d={mission_id:S.missionId,freq_mhz:r.freq_mhz,call_sign:r.call_sign,status:$("#obStatus").value,level_dbm:$("#obLevel").value===""?null:+$("#obLevel").value,notes:$("#obNotes").value};
    await post("/api/observation",d); for(const x of S.rows) if(x.call_sign===r.call_sign&&fmtF(x.freq_mhz)===fmtF(r.freq_mhz)) Object.assign(x,{obs_status:d.status,obs_level:d.level_dbm,obs_notes:d.notes}); $("#dlg").close(); render(); };
  $("#dlg").showModal();
}
document.addEventListener("click", e => { const tr=e.target.closest("tr[data-fid]"); if(tr && !tr.closest("#pktTable")) openDetail(tr.dataset.fid); });

/* ---------- wiring ---------- */
function setMode(m){ S.mode=m; $$("#modeSeg button").forEach(x=>x.classList.toggle("on",x.dataset.m===m));
  $("#locWrap").style.display=m==="point"?"":"none"; $("#countyWrap").style.display=m==="county"?"":"none";
  for(const el of [$("#radius").closest("label"), $("#radiusSlider").closest("label"), $("#gpsBtn")]) el.style.display=m==="nationwide"?"none":""; }
$("#modeSeg").addEventListener("click", e=>{ const b=e.target.closest("button"); if(b) setMode(b.dataset.m); });
$("#go").onclick=runSearch;
for(const id of ["#loc","#q","#fmin","#fmax"]) $(id).addEventListener("keydown", e=>{ if(e.key==="Enter") runSearch(); });
let rT; const radiusChanged=v=>{ $("#radius").value=v; $("#radiusSlider").value=v; clearTimeout(rT); rT=setTimeout(()=>{ if(parseLoc($("#loc").value)) runSearch(); },450); };
$("#radius").oninput=e=>radiusChanged(e.target.value); $("#radiusSlider").oninput=e=>radiusChanged(e.target.value);
$("#gpsBtn").onclick=()=>navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>{ $("#loc").value=`${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`; setMode("point"); runSearch(); },
  err=>{ $("#status").textContent="GPS unavailable: "+err.message+" (browsers only allow GPS on localhost or HTTPS)."; }, {enableHighAccuracy:true}):null;
$("#state").onchange=async()=>{ const cs=await api("/api/counties?state="+$("#state").value);
  $("#county").innerHTML='<option value="">— whole state —</option>'+cs.map(c=>`<option value="${esc(c.county)}">${esc(c.county)} (${c.n.toLocaleString()})</option>`).join(""); };
$("#clearChips").onclick=()=>{ for(const k in S.chips) S.chips[k].clear(); S.filterExpr=""; render(); };
const exportParams=()=>params({layers:[...S.layerOn].join(",")});
$("#csvBtn").onclick=()=>location.href="/api/export.csv?"+exportParams();
$("#kmlBtn").onclick=()=>location.href="/api/export.kml?"+exportParams();
$("#printBtn").onclick=()=>{ setTab("profile"); setTimeout(()=>window.print(),80); };
$("#themeBtn").onclick=()=>{ const d=document.documentElement, dark=matchMedia("(prefers-color-scheme: dark)").matches;
  const cur=d.dataset.theme||(dark?"dark":"light"); d.dataset.theme=cur==="dark"?"light":"dark"; try{localStorage.setItem("theme",d.dataset.theme);}catch(e){} render(); };
try{ const t=localStorage.getItem("theme"); if(t) document.documentElement.dataset.theme=t; }catch(e){}

async function boot(){
  try{
    const [meta, states, lib] = await Promise.all([api("/api/meta"), api("/api/states"), api("/api/sigid")]);
    S.lib=lib.library; S.bandplan=lib.bandplan;
    $("#meta").textContent = meta.built_at ? `FCC data ${meta.built_at} · ${Number(meta.tx_rows||0).toLocaleString()} entries${meta.towers_rows?` · ${Number(meta.towers_rows).toLocaleString()} towers`:""}` : "No FCC data yet — see Data & updates";
    $("#state").innerHTML='<option value="">—</option>'+states.map(s=>`<option>${esc(s.state)}</option>`).join("");
  }catch(e){ $("#meta").textContent="Server error: "+e.message; }
  if(window.missionBoot) await window.missionBoot();
  if(window.applyUrlState && window.applyUrlState()) runSearch();  // a link to a view wins over the mission's area
  render();
}
window.addEventListener("load", boot);
