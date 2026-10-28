"use strict";
/* RF Recon — the map's look. Standard (the usual map), ATAK style (MIL-STD-2525 style frames for emitters, satellite
   imagery, cyan rings and an MGRS position readout, so it reads like ATAK), or a map you imported: an ATAK / WinTAK
   map source (.xml), a tile address, or an MBTiles offline map. Any map with a tile address goes out to ATAK as a map
   source, so both show the same ground. ATAK itself can't run inside a web page; Send to ATAK takes the data there. */

const MS_BUILTIN = {  // the tile addresses behind the built-in maps, for exporting them to ATAK
  "Street (OpenStreetMap)": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  "Satellite (USGS)": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  "Satellite + labels (USGS)": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
  "Satellite hi-res (Esri)": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  "Topo (USGS)": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  "Terrain relief (USGS)": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}",
};
try{ S.mapStyle = localStorage.getItem("rfr.mapStyle") || "standard"; }catch(e){ S.mapStyle = "standard"; }
S.ownMaps = [];
const msName = m => `Mine: ${m.name}`;
function msRegister(maps){  // your maps join the built-in ones (and the layers menu on the map)
  for(const k of Object.keys(BASEMAPS)) if(BASEMAPS[k].own) delete BASEMAPS[k];
  for(const m of maps) BASEMAPS[msName(m)] = {own:true, url: m.kind==="mbtiles" ? `/tiles/mb/${m.mbtiles}/{z}/{x}/{y}.${m.format||"png"}` : m.url,
    maxNativeZoom: m.max ?? 19, minZoom: 0, maxZoom: 19, attribution: m.attribution || `Your map: ${m.name}`};
  S.ownMaps = maps;
}
async function msLoad(){
  try{ msRegister((await api("/api/basemaps")).maps || []); }catch(e){ msRegister([]); }
  let saved = null; try{ saved = JSON.parse(localStorage.getItem("rfr.mapLayers"))?.base; }catch(e){}
  if(saved && BASEMAPS[saved]?.own && mapPrefs().base !== saved){ mapPrefs().base = saved; if(S.tab === "map" && S.map) render(); }  // your map, picked last time
}
const msReady = msLoad();

const msSave = () => { try{ localStorage.setItem("rfr.mapStyle", S.mapStyle); localStorage.setItem("rfr.mapLayers", JSON.stringify(mapPrefs())); }catch(e){} };
function msPaintPicker(){
  const sel = $("#mapStyle"); if(!sel) return;
  const pref = mapPrefs(), cur = S.mapStyle==="atak" ? "atak" : BASEMAPS[pref.base]?.own ? "own:"+pref.base : "standard";
  sel.innerHTML = `<option value="standard">Standard</option><option value="atak">ATAK style</option>`
    + (S.ownMaps.length ? `<optgroup label="Your maps">${S.ownMaps.map(m=>`<option value="own:${esc(msName(m))}">${esc(m.name)}</option>`).join("")}</optgroup>` : "")
    + `<option value="import">Import your own…</option>`;
  sel.value = cur;
  sel.onchange = () => { const v = sel.value, pref = mapPrefs();
    if(v === "import"){ sel.value = cur; msDialog(); return; }
    if(v === "atak"){ S.mapStyle = "atak"; if(!S.atakBaseSet){ pref.before = pref.base; pref.base = "Satellite hi-res (Esri)"; S.atakBaseSet = true; } }
    else if(v === "standard"){ S.mapStyle = "standard"; S.atakBaseSet = false; if(BASEMAPS[pref.base]?.own || pref.base === "Satellite hi-res (Esri)") pref.base = pref.before && BASEMAPS[pref.before] && !BASEMAPS[pref.before].own ? pref.before : "Street (OpenStreetMap)"; }
    else { S.mapStyle = "standard"; pref.base = v.slice(4); }
    msSave(); render(); };
}
const msMapView = S.views.map;
S.views.map = (v, rows) => { msMapView(v, rows); msPaintPicker(); };
msReady.then(() => { if(S.tab === "map") msPaintPicker(); });

/* ---------- import / export ---------- */
function msXml(name, url, min=0, max=19){
  const x = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const atak = url.replace("{z}","{$z}").replace("{x}","{$x}").replace("{y}","{$y}").replace("{s}","{$s}");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<customMapSource>\n  <name>${x(name)}</name>\n  <minZoom>${min}</minZoom>\n  <maxZoom>${max}</maxZoom>\n  <tileType>image/png</tileType>\n  <tileUpdate>None</tileUpdate>\n  <url>${x(atak)}</url>\n  <backgroundColor>#000000</backgroundColor>\n</customMapSource>\n`;
}
const msDl = (name, text) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], {type:"application/xml"}));
  a.download = name.replace(/[\\/:*?"<>|]+/g,"-") + ".xml"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 10000); };
function msDialog(){
  $("#dlgTitle").textContent = "Your own maps";
  const own = S.ownMaps;
  $("#dlgBody").innerHTML = `<div class="sec"><h3>Import a map</h3>
      <p class="hint" style="margin-top:0">An ATAK or WinTAK map source (.xml), an MBTiles offline map (.mbtiles, image tiles; on this PC), or a tile address with {z}, {x} and {y}.</p>
      <div class="row"><label class="grow">Name<input id="msName" placeholder="e.g. County imagery 2025"></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">File<input type="file" id="msFile" accept=".xml,.mbtiles"></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">or a tile address<input id="msUrl" placeholder="https://example.com/tiles/{z}/{x}/{y}.png"></label><button class="primary" id="msAdd">Add</button></div>
      <p class="hint" id="msMsg"></p></div>
    <div class="sec"><h3>Your maps (${own.length})</h3>${own.length ? own.map(m=>`<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0">
        <span><b>${esc(m.name)}</b> <span class="hint">${m.kind==="mbtiles"?"MBTiles on this PC":"tile address"} · zoom ${m.min}–${m.max}</span></span>
        <span><button data-use="${esc(msName(m))}">Use</button> ${m.url?`<button data-xml="${esc(m.id)}">⇩ ATAK map source</button> `:""}<button data-rm="${esc(m.id)}">Remove</button></span></div>`).join("")
      : '<p class="hint">None yet.</p>'}</div>
    <div class="sec"><h3>Send RF Recon's maps to ATAK</h3><p class="hint" style="margin-top:0">A map source file for ATAK / WinTAK / iTAK (Import, then the file), so ATAK shows the same ground as RF Recon.
      OpenStreetMap's tile servers are for light use: in ATAK, prefer the USGS or Esri maps.</p>
      ${Object.entries(MS_BUILTIN).map(([n])=>`<button data-bxml="${esc(n)}" style="margin:2px">⇩ ${esc(n)}</button>`).join("")}</div>`;
  $("#dlg").showModal();
  const done = async r => { msRegister(r.maps); $("#msMsg").textContent = "Added."; msDialog(); };
  $("#msAdd").onclick = async () => { const f = $("#msFile").files[0], url = $("#msUrl").value.trim(), name = $("#msName").value.trim();
    $("#msMsg").textContent = f ? `Reading ${f.name}…` : "Adding…";
    try{ done(f ? await api(`/api/basemaps/import?name=${encodeURIComponent(name)}&filename=${encodeURIComponent(f.name)}`, {method:"POST", body:f})
                : await post("/api/basemaps/import", {name, url})); }catch(e){ $("#msMsg").textContent = e.message; } };
  $("#msFile").onchange = () => { if($("#msFile").files[0]) $("#msAdd").click(); };
  $$("#dlgBody [data-use]").forEach(b => b.onclick = () => { S.mapStyle = "standard"; mapPrefs().base = b.dataset.use; msSave(); $("#dlg").close(); render(); });
  $$("#dlgBody [data-rm]").forEach(b => b.onclick = async () => { const r = await post(`/api/basemaps/delete?id=${encodeURIComponent(b.dataset.rm)}`);
    if(BASEMAPS[mapPrefs().base]?.own) mapPrefs().base = "Street (OpenStreetMap)"; msRegister(r.maps); msSave(); msDialog(); });
  $$("#dlgBody [data-xml]").forEach(b => b.onclick = () => { const m = own.find(x=>x.id===b.dataset.xml); msDl(m.name, msXml(m.name, m.url, m.min, m.max)); });
  $$("#dlgBody [data-bxml]").forEach(b => b.onclick = () => msDl(`RF Recon - ${b.dataset.bxml}`, msXml(`RF Recon - ${b.dataset.bxml}`, MS_BUILTIN[b.dataset.bxml])));
}

/* ---------- ATAK style: symbol frames (MIL-STD-2525 affiliation shapes) ---------- */
// friendly (blue rectangle): your own captures; neutral (green square): licensed and registered (FCC, broadcast,
// NOAA, FAA, towers); unknown (yellow quatrefoil): crowd-reported. The dot inside is the signal type's colour.
window.atakIcon = (rs, big) => {
  const r0 = rs.find(r=>r.layer!=="towers") || rs[0], tower = rs.some(r=>r.layer==="towers");
  const aff = rs.some(r=>r.layer==="captures") ? "f" : ["uls","uls_hist","broadcast","noaa","faa","towers"].includes(r0.layer) ? "n" : "u";
  const s = big ? 26 : 20, c = s / 2, dot = `<circle cx="${c}" cy="${c}" r="${s*.16}" fill="${colorOf(r0)}" stroke="#000" stroke-width=".8"/>`;
  const frame = aff === "f" ? `<rect x="1" y="${s*.2}" width="${s-2}" height="${s*.6}" fill="#80e0ff" stroke="#000" stroke-width="1.2"/>`
    : aff === "n" ? `<rect x="${s*.1}" y="${s*.1}" width="${s*.8}" height="${s*.8}" fill="#aaffaa" stroke="#000" stroke-width="1.2"/>`
    : `<path d="M${c} ${s*.08} a${s*.22} ${s*.22} 0 0 1 ${s*.42} ${s*.42} a${s*.22} ${s*.22} 0 0 1 -${s*.42} ${s*.42} a${s*.22} ${s*.22} 0 0 1 -${s*.42} -${s*.42} a${s*.22} ${s*.22} 0 0 1 ${s*.42} -${s*.42}z" fill="#ffff80" stroke="#000" stroke-width="1.2"/>`;
  const mast = tower ? `<path d="M${c} ${s*.25} L${c} ${s*.75} M${c-s*.15} ${s*.75} L${c} ${s*.25} L${c+s*.15} ${s*.75}" stroke="#000" stroke-width="1.3" fill="none"/>` : dot;
  const n = rs.length > 1 ? `<text x="${s-1}" y="${s-1}" font-size="${s*.36}" font-weight="700" text-anchor="end" fill="#fff" stroke="#000" stroke-width=".6">${Math.min(rs.length,99)}</text>` : "";
  return L.divIcon({className:"", html:`<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${frame}${mast}${n}</svg>`, iconSize:[s,s], iconAnchor:[c,c], popupAnchor:[0,-c]});
};

/* ---------- MGRS (WGS84 / UTM), for the position readout ---------- */
window.toMGRS = (lat, lon) => {
  if(lat < -80 || lat > 84) return "";
  const a = 6378137, f = 1/298.257223563, e2 = f*(2-f), ep2 = e2/(1-e2), k0 = 0.9996, d = Math.PI/180;
  const zone = Math.floor((lon + 180) / 6) + 1, lon0 = (zone - 1) * 6 - 180 + 3;
  const p = lat*d, N = a / Math.sqrt(1 - e2*Math.sin(p)**2), T = Math.tan(p)**2, C = ep2*Math.cos(p)**2, A = Math.cos(p)*(lon - lon0)*d;
  const M = a*((1 - e2/4 - 3*e2**2/64 - 5*e2**3/256)*p - (3*e2/8 + 3*e2**2/32 + 45*e2**3/1024)*Math.sin(2*p) + (15*e2**2/256 + 45*e2**3/1024)*Math.sin(4*p) - (35*e2**3/3072)*Math.sin(6*p));
  const E = k0*N*(A + (1-T+C)*A**3/6 + (5-18*T+T*T+72*C-58*ep2)*A**5/120) + 500000;
  let Nn = k0*(M + N*Math.tan(p)*(A*A/2 + (5-T+9*C+4*C*C)*A**4/24 + (61-58*T+T*T+600*C-330*ep2)*A**6/720));
  if(lat < 0) Nn += 10000000;
  const band = "CDEFGHJKLMNPQRSTUVWXX"[Math.floor((lat + 80) / 8)];
  const col = ["ABCDEFGH","JKLMNPQR","STUVWXYZ"][(zone - 1) % 3][Math.floor(E / 100000) - 1];
  const row = "ABCDEFGHJKLMNPQRSTUV"[(Math.floor(Nn / 100000) % 20 + (zone % 2 === 0 ? 5 : 0)) % 20];
  const pad = v => String(Math.floor(v % 100000)).padStart(5, "0");
  return `${zone}${band} ${col}${row} ${pad(E)} ${pad(Nn)}`;
};
