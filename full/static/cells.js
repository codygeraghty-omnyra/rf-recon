"use strict";
/* RF Recon — Cell sites: the cells around the pin from the crowd (OpenCelliD, WiGLE) and your own captures, grouped
   into sites (one eNB / gNB each) with their global cell IDs and sectors, and the FCC-registered tower each most
   likely sits on: its owner, height and the licensees on it. Click a site for its sectors, coverage and tower. */

S.views.cells = async v => {
  if(!S.center){ v.innerHTML='<p class="status">Drop a pin (or search an address) first: cell sites are found around it.</p>'; return; }
  const C=S.cellsView=S.cellsView||{op:"", radio:"", q:""};
  v.innerHTML='<p class="status">Finding cell sites…</p>';
  let r, cov={carriers:[], loaded:false};
  try{ [r, cov]=await Promise.all([api(`/api/cells?lat=${S.center[0]}&lon=${S.center[1]}&radius=${S.radius}${S.missionId?`&mission=${S.missionId}`:""}`),
    api(`/api/bdc/at?lat=${S.center[0]}&lon=${S.center[1]}`).catch(()=>cov)]); }
  catch(e){ v.innerHTML=`<p class="status err">Cell sites: ${esc(e.message)}</p>`; return; }
  const all=r.sites, ops=[...new Set(all.map(s=>s.operator))].sort(), radios=[...new Set(all.map(s=>s.radio))].sort();
  const q=C.q.trim().toLowerCase();
  const list=all.filter(s=>(!C.op||s.operator===C.op)&&(!C.radio||s.radio===C.radio)&&(!q||`${s.operator} ${s.plmn} ${s.site_id} ${s.tower?.owner||""} ${s.tower?.reg||""} ${s.cells.map(c=>c.gci).join(" ")}`.toLowerCase().includes(q)));
  const onTower=list.filter(s=>s.tower).length;
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Operator <select id="csOp"><option value="">All</option>${ops.map(o=>`<option ${o===C.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
      <label class="inl">Technology <select id="csRadio"><option value="">All</option>${radios.map(o=>`<option ${o===C.radio?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
      <label class="inl">Find <input id="csQ" value="${esc(C.q)}" placeholder="cell ID, eNB, tower owner…" style="width:200px"></label>
      <button id="csCsv">⇩ CSV</button><button id="csKml">⇩ KML</button><button id="csTak">⇩ ATAK</button></div>
    <p style="margin:2px 2px 10px"><b>${list.length}</b> cell site${list.length===1?"":"s"} (${r.cells.toLocaleString()} cells) within ${S.radius} mi · ${onTower} matched to an FCC-registered tower · ${r.towers_nearby.toLocaleString()} registered towers nearby</p>
    <div class="panel"><h3>Carrier coverage at the pin <span class="hint">· FCC Broadband Map${cov.as_of?`, data as of ${esc(cov.as_of)}`:""}</span></h3>
      ${!cov.loaded?'<p class="hint" style="margin:0">Not loaded: set the carrier-coverage states in Data &amp; updates, then run FCC carrier coverage.</p>'
      :!cov.carriers.length?'<p class="hint" style="margin:0">No loaded carrier reports coverage here (or the pin is outside your carrier-coverage states).</p>'
      :`<div class="tw"><table><thead><tr><th>Carrier</th><th>Technology</th><th>Speeds (down/up Mbps)</th><th class="n">Strongest modelled signal</th><th>Holds</th></tr></thead><tbody>
        ${cov.carriers.map(c=>`<tr><td><b>${esc(c.brand)}</b></td><td>${esc(c.tech)}</td><td class="mono">${c.speeds.map(esc).join(", ")}</td>
          <td class="n">${c.signal!=null?`${c.signal} dBm`:""}</td><td class="hint">${c.envs.map(esc).join("; ")}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint" style="margin:6px 0 0">What each carrier tells the FCC it covers, modelled, not measured. Map tab, Heatmap: Carrier coverage draws it.</p>`}</div>
    ${all.length?"":`<div class="panel"><h3>No cells here yet</h3><p class="hint" style="margin-top:0">Cell data comes from the crowd and from your own surveys:</p>
      <ul class="hint"><li><b>OpenCelliD</b>: add your free key in Data &amp; updates and fetch for the pin, or import a whole-country download below (free account at <a href="https://opencellid.org/downloads.php" target="_blank" rel="noopener">opencellid.org/downloads.php</a>; the US files are 310 to 316).</li>
        <li><b>WiGLE</b>: add your API name and token in Data &amp; updates, then fetch for the pin (cells come with Wi-Fi and Bluetooth).</li>
        <li><b>Your captures</b>: WiGLE WiFi app exports and cell scanner CSVs imported in a mission (cells need their MCC-MNC-area-cell ID).</li></ul></div>`}
    <div class="panel"><h3>Import an OpenCelliD download</h3>
      <div class="row"><input type="file" id="csImp" accept=".csv,.gz"><span class="hint" id="csMsg">Kept to the states set in Data &amp; updates (${esc((await api("/api/settings").catch(()=>({}))).states||"all states: large")}).</span></div></div>
    ${list.length?`<div class="tw"><table><thead><tr><th>Operator</th><th>Tech</th><th>Site</th><th>Sectors (cell IDs)</th><th>Tower (FCC)</th><th>Owner</th><th class="n">Height</th><th class="n">Licensees on it</th><th class="n">Samples</th><th>Last seen</th><th class="n">Distance</th></tr></thead><tbody>
      ${list.slice(0,1500).map((s,i)=>`<tr data-i="${all.indexOf(s)}" style="cursor:pointer"><td><b>${esc(s.operator)}</b><div class="hint mono">${esc(s.plmn)}</div></td><td>${esc(s.radio)}</td>
        <td class="mono">${esc(s.site_kind.split(" ")[0])} ${esc(String(s.site_id))}</td>
        <td class="mono" style="font-size:11px">${s.cells.slice(0,6).map(c=>`${esc(c.gci)}${c.az_est!=null?` <span class="hint">${c.az_est}°</span>`:""}`).join("<br>")}${s.cells.length>6?`<br><span class="hint">+${s.cells.length-6}</span>`:""}</td>
        <td class="mono">${s.tower?esc(s.tower.reg):'<span class="hint">none within 1 km</span>'}</td><td>${esc(s.tower?.owner||"")}</td>
        <td class="n">${s.tower?.overall_agl_m!=null?`${Math.round(s.tower.overall_agl_m*3.281)} ft`:""}</td><td class="n">${s.tower?s.tower.licensees.length:""}</td>
        <td class="n">${s.samples?s.samples.toLocaleString():""}</td><td>${esc(s.last||"")}</td><td class="n">${num(s.dist_mi,2)} mi</td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Click a site for its sectors, its estimated coverage and its tower. Sector directions are estimates from the crowd positions. ${esc(Object.values(r.sources).join(" · "))}.</p>`:""}`;
  $("#csOp").onchange=e=>{ C.op=e.target.value; render(); };
  $("#csRadio").onchange=e=>{ C.radio=e.target.value; render(); };
  let t; $("#csQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ C.q=e.target.value; render(); const i=$("#csQ"); i.focus(); i.setSelectionRange(i.value.length,i.value.length); },350); };
  v.querySelectorAll("tr[data-i]").forEach(tr=>tr.onclick=()=>{ const s=all[+tr.dataset.i]; emitOpen(emCellRow(s, s.cells[0]), "cell"); });
  $("#csImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#csMsg").textContent=`Importing ${f.name} (${(f.size/1e6).toFixed(0)} MB)… large country files take a few minutes.`;
    try{ const x=await api(`/api/cells/import?name=${encodeURIComponent(f.name)}`,{method:"POST", body:f}); $("#csMsg").textContent=`${x.kept.toLocaleString()} cells kept of ${x.read.toLocaleString()} in the file${x.states.length?` (${x.states.join(", ")})`:""}.`; setTimeout(render,1200); }
    catch(err){ $("#csMsg").textContent="Import: "+err.message; } };
  const flat=()=>list.flatMap(s=>s.cells.map(c=>({operator:s.operator, plmn:s.plmn, radio:s.radio, site_kind:s.site_kind, site_id:s.site_id, gci:c.gci, sector:c.sector, area:c.area,
    cell_lat:c.lat, cell_lon:c.lon, azimuth_est:c.az_est??"", range_m:c.range_m??"", samples:c.samples, last_seen:c.last||"", sources:c.sources.join("; "),
    site_lat:s.lat, site_lon:s.lon, tower_reg:s.tower?.reg||"", tower_owner:s.tower?.owner||"", tower_agl_m:s.tower?.overall_agl_m??"", tower_match_m:s.tower?.match_m??""})));
  $("#csCsv").onclick=()=>dasDl("RF Recon cell sites.csv", csvOf(flat()), "text/csv");
  $("#csKml").onclick=()=>{ const x=s=>String(s??"").replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
    dasDl("RF Recon cell sites.kml", `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cell sites</name>${list.map(s=>
      `<Placemark><name>${x(`${s.operator} ${s.radio} ${s.site_id}`)}</name><description>${x(`${s.cells.map(c=>c.gci).join(", ")}${s.tower?` · tower ${s.tower.reg} ${s.tower.owner||""}`:""}`)}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join("")}</Document></kml>`,
      "application/vnd.google-earth.kml+xml"); };
  $("#csTak").onclick=()=>RFTak.save({rows:list.map(s=>({layer:"opencellid", lat:s.lat, lon:s.lon, label:`${s.operator} ${s.radio} ${s.site_id}`, licensee:s.operator, call_sign:s.plmn,
    sig_type:s.radio==="NR"?"5G NR":s.radio, freq_mhz:null, dist_mi:s.dist_mi})), center:S.center, radius:S.radius, name:"RF Recon - cell sites", colorOf, typeOf, fccDate:null});
};
