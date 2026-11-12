"use strict";
/* DAStastic — Cell sites: the cells around the pin from the crowd (OpenCelliD, WiGLE) and your own captures, grouped
   into sites (one eNB / gNB each) with their global cell IDs and sectors, and the FCC-registered tower each most
   likely sits on: its owner, height and the licensees on it. Click a site for its sectors, coverage and tower. */

// every carrier's sites on each tower, together, with all their cells and the bands each carrier holds here (Cody 11/6). Filters apply.
// The towers are the tower engine's (towers.js RFTowers.area, GET /api/towers/area): a registered, licensed or mapped structure the
// crowd's cells match, or, where they match none, the estimated tower they are, with its bubble (plan 11/10 section 2 item 4). It
// read cells.by_tower, which keeps only sites within 1 km of an FCC tower, so a site that matched none vanished here and on Topology.
// One rule on one screen (review 11/12): in By tower and on Topology the rows, their sites, the Find box, the count line and the site
// a row opens all read the engine's towers; By site keeps each site's nearest FCC tower within 1 km (cells.sites)
// site key -> the engine's tower it's on, and a tower's own words for the Find box
const csTowerIndex = ar => { const m=new Map(); for(const t of (ar&&ar.towers)||[]) for(const x of t.sites||[]) for(const k of x.keys||[]) if(!m.has(k)) m.set(k, t); return m; };
const csTowerText = t => t?`${t.registration?`${t.registration} fcc ${t.registration}`:""} ${t.osm||""} ${t.owner||""} ${t.type||""}`.toLowerCase():"";
const csEngine = ar => !!(ar&&!ar._error&&window.RFTowers);
// a site opened from a tower row, where the engine puts it: its tower's position and distance, and the old 1 km FCC match only when
// the engine picked that same tower (the row said "○ estimated, 0.32 mi" and the site opened "on FCC tower 1201831, 0.18 mi")
function csOnTower(s, t){
  const same=t.registration&&s.tower&&String(s.tower.reg)===String(t.registration), u=t.kind==="estimated"&&t.uncertainty_m;
  // where the engine picked another place, nothing of the 1 km FCC tower stays in the viewer: not its "Everything on this tower", not
  // its 800 MHz licence, not the sector directions worked out from it (round 2: they read 40° NE from FCC 1201831, 781 m off)
  return {...s, key:`${s.key}@${t.id}`, lat:t.lat, lon:t.lon, dist_mi:t.dist_mi, tower:same?s.tower:null, engine:t,
    on_tower:same?s.on_tower:null, fcc_cellular:same?s.fcc_cellular:[], cells:same?s.cells:(s.cells||[]).map(c=>({...c, az_est:null, offset_m:null})),
    located:u?`estimated by the tower engine, give or take ${Math.round(u)} m`:t.registration?`on FCC-registered tower ${t.registration} (the tower engine's match)`
      :t.osm?"on a mast mapped in OpenStreetMap (the tower engine's match)":`at a ${t.type||"licensed site"} (the tower engine's match)`};
}
// the rows: each tower the area answer has (Operator and Technology already applied by the server). With Find, the towers whose own
// words or a listed site match. Each site from the engine's own list, named as Cell sites names it where it lists it: a tower just
// inside the radius can carry a site whose cells all lie past it, which Cell sites doesn't list, and it still shows here
function csTowerRows(ar, list, all, q){
  const by=new Map(all.map(s=>[s.key,s])), inList=new Set(list.map(s=>s.key)), rows=[];
  // the sites Find and Operator picked lead a row, and it opens the first of them (it opened the engine's first site whatever matched:
  // Find 888001 opened AT&T's eNB, Operator FirstNet its AT&T 310-410 site, round 2)
  const hits=y=>y.mine.filter(s=>inList.has(s.key)).length;
  for(const t of ar.towers||[]){ const sites=(t.sites||[]).map(x=>({x, mine:(x.keys||[]).map(k=>by.get(k)).filter(Boolean)}));
    if(q&&!csTowerText(t).includes(q)&&!sites.some(({x})=>(x.keys||[]).some(k=>inList.has(k)))) continue;
    sites.sort((a,b)=>hits(b)-hits(a));
    const mine=sites.flatMap(y=>y.mine), open=mine.find(s=>inList.has(s.key))||mine[0]||null;
    rows.push({t, sites, open}); }
  const placed=new Set(rows.flatMap(r=>r.sites.flatMap(({x})=>x.keys||[])));
  return {rows, placed, inList, left:list.filter(s=>!placed.has(s.key))};
}
// why a listed site is on no tower here, each reason apart: past where the towers stop (20 mi), 2G or 3G (off the air), only your
// own readings (where the phone was, not the tower), past the nearest 500 towers, or just past the edge (review 11/12: every one
// was blamed on 2G, 3G or the edge)
function csLeftTxt(R, ar){
  if(!R.left.length) return "";
  const cap=+ar.radius_mi||0, past=R.left.filter(s=>cap&&S.radius>cap&&s.dist_mi>cap), rest0=R.left.filter(s=>!past.includes(s));
  const old=rest0.filter(s=>!["LTE","NR"].includes(s.radio)), own=rest0.filter(s=>!old.includes(s)&&(s.sources||[]).length&&s.sources.every(x=>/^Survey/.test(x)));
  const rest=rest0.filter(s=>!old.includes(s)&&!own.includes(s)), n=(x, w)=>x.length?`${x.length} ${w}`:"";
  const why=[n(past, `past ${cap} mi, where the towers stop`), n(old, "2G or 3G (off the air, so on no tower)"), n(own, "only your own readings have (they say where the phone was, not the tower)"),
    n(rest, ar.more?`on towers past the nearest ${(ar.towers||[]).length}`:"placed just past the edge")].filter(Boolean);
  return `${R.left.length} listed site${R.left.length===1?" isn't":"s aren't"} on a tower here: ${why.join("; ")}.`;
}
// the count line in By tower: the engine's towers, not the 1 km FCC matches By site counts
function csTowerLine(R, ar, list){
  const reg=R.rows.filter(r=>r.t.registration).length, est=R.rows.filter(r=>r.t.kind==="estimated").length, on=list.length-R.left.length, cap=+ar.radius_mi||S.radius;
  return `<b>${R.rows.length}</b> tower${R.rows.length===1?"":"s"} with cell sites on them within ${Math.min(S.radius, cap)} mi · ${reg} on an FCC-registered tower, ${est} estimated · ${on} of ${list.length} listed cell site${list.length===1?"":"s"} on them`;
}
// o: {all: the sites before the filters, q: Find's words, R: the rows if worked out already}
function towersHtml(ar, list, old, o={}){
  if(!csEngine(ar)) return fccTowersHtml(old||[], list);
  const R=o.R||csTowerRows(ar, list, o.all||list, o.q||""), est=R.rows.filter(r=>r.t.kind==="estimated").length, leftTxt=csLeftTxt(R, ar);
  const cap=+ar.radius_mi, capTxt=cap&&S.radius>cap?`The towers are worked out within ${cap} mi of the pin, the most the tower engine does at once. `:"";
  const cred=`<p class="hint">${(ar.attribution_lines||[]).map(esc).join(" ")}</p>`;
  if(!R.rows.length) return `<p class="hint">No cell sites here are on a tower. ${esc(capTxt)}${esc(leftTxt)}</p>${cred}`;
  const named=({x, mine})=>mine.length?[...new Set(mine.map(s=>s.operator))].join(", "):x.carrier;
  return `<div class="tw"><table id="csTowers"><thead><tr><th>Tower</th><th>Owner</th><th class="n">Height</th><th>Carriers and sites</th><th class="n">Cells</th><th>Bands licensed here</th><th class="n">Distance</th></tr></thead><tbody>
    ${R.rows.map(({t, sites, open})=>{ const [sym, word]=RFTowers.kind(t), u=t.kind==="estimated"&&t.uncertainty_m;
      return `<tr data-tw="${esc(t.id)}"${open?` data-tws="${esc(open.key)}" style="cursor:pointer"`:""} data-kind="${esc(t.kind||"")}"><td><span class="mono">${sym} ${esc(t.registration?`FCC ${t.registration}`:t.osm?`OSM ${t.osm}`:word)}</span>
        <div class="hint">${u?`give or take ${num(u,0)} m`:`${esc(t.type||"")}${t.registration||t.osm?` · ${esc(word)}`:""}`}</div></td><td>${esc(t.owner||"")}</td>
      <td class="n">${t.height_ft!=null?`${num(t.height_ft,0)} ft`:""}</td>
      <td>${sites.map(y=>`<div><b>${esc(named(y))}</b> ${esc(y.x.radio)} <span class="mono">${esc(String(y.x.site_kind).split(" ")[0])} ${esc(String(y.x.site_id))}</span> <span class="hint">· ${y.x.cells} cell${y.x.cells===1?"":"s"}${y.mine.length?"":" · not in the list: its cells are past the radius"}</span></div>`).join("")}</td>
      <td class="n">${sites.reduce((n,y)=>n+y.x.cells,0)}</td><td>${sites.map(y=>`<div><span class="hint">${esc(String(named(y)).replace(/ \(ex-Sprint\)/g,""))} ${esc(y.x.radio)}:</span> ${esc([...new Set(y.mine.flatMap(s=>s.bands||[]))].join(", ")||"none on file")}</div>`).join("")}</td>
      <td class="n">${num(t.dist_mi,2)} mi ${esc(t.compass||"")}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="hint">${R.rows.length} tower${R.rows.length===1?"":"s"} with cells on them${est?`, ${est} estimated (○): the crowd's cells match no registered, licensed or mapped structure there, so it's where they average, give or take the distance shown`:""}${ar.more?` (the nearest ${(ar.towers||[]).length}; narrow the radius or pick an operator for the rest)`:""}. ${esc(capTxt)}${esc(leftTxt)}
      Click one for its sites, cells and channel numbers, where the engine places it. Bands are what each carrier is licensed for in the county; which band a cell is on only a scan says.</p>${cred}`;
}
// /api/cells' own list: the sites within 1 km of an FCC-registered tower (cells.by_tower)
function fccTowersHtml(towers, list){
  const keep=new Set(list.map(s=>s.key)), rows=towers.map(t=>({...t, sites:t.sites.filter(x=>keep.has(x.key))})).filter(t=>t.sites.length);
  if(!rows.length) return '<p class="hint">No cell sites matched to an FCC-registered tower here.</p>';
  return `<div class="tw"><table id="csTowers"><thead><tr><th>Tower (FCC)</th><th>Owner</th><th class="n">Height</th><th>Carriers and sites</th><th class="n">Cells</th><th>Bands licensed here</th><th class="n">Distance</th></tr></thead><tbody>
    ${rows.map(t=>`<tr data-tw="${esc(t.reg)}" data-tws="${esc(t.sites[0].key)}" style="cursor:pointer"><td class="mono">${esc(t.reg)}<div class="hint">${esc(t.structure||"")}</div></td><td>${esc(t.owner||"")}</td>
      <td class="n">${t.height_m!=null?`${Math.round(t.height_m*3.281)} ft`:""}</td>
      <td>${t.sites.map(x=>`<div><b>${esc(x.operator)}</b> ${esc(x.radio)} <span class="mono">${esc(String(x.site_kind).split(" ")[0])} ${esc(String(x.site_id))}</span> <span class="hint">· ${x.cells.length} cell${x.cells.length===1?"":"s"}</span></div>`).join("")}</td>
      <td class="n">${t.sites.reduce((n,x)=>n+x.cells.length,0)}</td><td>${t.sites.map(x=>`<div><span class="hint">${esc(x.operator.replace(" (ex-Sprint)",""))} ${esc(x.radio)}:</span> ${esc(x.bands.join(", ")||"none on file")}</div>`).join("")}</td>
      <td class="n">${num(t.dist_mi,2)} mi</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">${rows.length} tower${rows.length===1?"":"s"} with cells on them. Click one for its sites, cells and channel numbers. Bands are what each carrier is licensed for in the county; which band a cell is on only a scan says.</p>`;
}

// the site list shows the first 1,500: a header press sorts every site by that column first (rfsort.js)
rfSort.own("csList", ()=>render());
const csSorted = list => rfSort.data("csList", list, [s=>s.operator, s=>s.radio, s=>`${String(s.site_kind||"").split(" ")[0]} ${s.site_id}`, s=>s.cells[0]?.gci||"",
  s=>s.tower?.reg||"", s=>s.tower?.owner||"", s=>s.tower?.overall_agl_m??null, s=>s.tower?s.tower.licensees.length:null, s=>s.samples||null, s=>s.last||"", s=>s.dist_mi]);
S.views.cells = async v => {
  if(!S.center){ v.innerHTML='<p class="status">Drop a pin (or search an address) first: cell sites are found around it.</p>'; return; }
  const C=S.cellsView=S.cellsView||{op:"", radio:"", q:"", by:"site"};
  v.innerHTML='<p class="status">Finding cell sites…</p>';
  const gen=S.viewGen;
  let r, cov={carriers:[], loaded:false}, nb={cell:null, checks:[], fixed_wireless:[]}, ar=null;
  // By tower: the towers the engine places here (towers.js RFTowers.area), read beside the sites
  const area=C.by==="tower"&&window.RFTowers?RFTowers.area(S.center[0], S.center[1], S.radius, S.missionId, {op:C.op, radio:C.radio}).catch(e=>({_error:e.message})):null;
  // a top-up going here when these answers were asked: they may be from before it, so the tab is drawn once more when it ends, even if
  // it ended before they came back (it was queued only when still going then, round 2)
  const was=window.RFTowers&&RFTowers.runAt(S.center[0], S.center[1]), going=!!(was&&!was.done);
  try{ [r, cov, nb, ar]=await Promise.all([api(`/api/cells?lat=${S.center[0]}&lon=${S.center[1]}&radius=${S.radius}${S.missionId?`&mission=${S.missionId}`:""}`),
    api(`/api/bdc/at?lat=${S.center[0]}&lon=${S.center[1]}`).catch(()=>cov), api(`/api/bdc/near?lat=${S.center[0]}&lon=${S.center[1]}`).catch(()=>nb), area]); }
  catch(e){ if(gen!==S.viewGen) return;
    // the web version with no field pack (or one without cells) has no tables to read: say what to do, not the database's words (web_tabs_check 11/7)
    if(window.RFPack && /no such table/i.test(e.message||"")){ v.innerHTML='<p class="status">Cell sites come from a field pack here: load your state\'s pack on the Packs tab, then come back.</p>'; return; }
    v.innerHTML=`<p class="status err">Cell sites: ${esc(e.message)}</p>`; return; }
  if(gen!==S.viewGen) return;  // you moved on while it loaded
  // fresh crowd cells for this spot, by themselves, where the tower engine's rule says a top-up is due (r.topup: cells.topup_due),
  // the way a cellular job's pre-survey gets them (towers.js RFTowers.autoTopup: once a spot for the page, never for a view-only
  // login or a copy with no OpenCelliD key). It fetched only where no site was kept (Cody 11/6: "wheres the cell data"), which
  // never ran again once the country file was in, nor where a mission's area already had a few sites
  const run=window.RFTowers?RFTowers.autoTopup({lat:S.center[0], lon:S.center[1], topup:r.topup}, false):null, at=S.center.join(",");
  // once a run, however often the tab is drawn while it runs (each draw queued another full redraw for when it ended, review 11/12)
  if(run&&(!run.done||(going&&run===was))&&!run._cells){ run._cells=true; run.p.then(()=>{ window.cellAllRefresh?.(); if(S.tab==="cells"&&S.center&&S.center.join(",")===at) render(); }); }
  const topTxt=run?RFTowers.topupNote(null, run):"";
  const all=r.sites, ops=[...new Set(all.map(s=>s.operator))].sort(), radios=[...new Set(all.map(s=>s.radio))].sort();
  const q=C.q.trim().toLowerCase();
  // Find: in By tower the tower a site is on is the engine's (its FCC number, OSM id, owner, type); in By site, its nearest FCC tower within 1 km
  const TI=C.by==="tower"&&csEngine(ar)?csTowerIndex(ar):null, towerOf=s=>TI?csTowerText(TI.get(s.key)):`${s.tower?.owner||""} ${s.tower?.reg||""}`;
  const list=all.filter(s=>(!C.op||s.operator===C.op)&&(!C.radio||s.radio===C.radio)&&(!q||`${s.operator} ${s.plmn} ${s.site_id} ${towerOf(s)} ${s.cells.map(c=>c.gci).join(" ")}`.toLowerCase().includes(q)));
  const onTower=list.filter(s=>s.tower).length, TR=TI?csTowerRows(ar, list, all, q):null;
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Operator <select id="csOp"><option value="">All</option>${ops.map(o=>`<option ${o===C.op?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
      <label class="inl">Technology <select id="csRadio"><option value="">All</option>${radios.map(o=>`<option ${o===C.radio?"selected":""}>${esc(o)}</option>`).join("")}</select></label>
      <label class="inl">Find <input id="csQ" value="${esc(C.q)}" placeholder="cell ID, eNB, tower owner…" style="width:200px"></label>
      <div class="seg" id="csBy">${[["site","By site"],["tower","By tower"]].map(([k,l])=>`<button data-by="${k}" class="${(C.by||"site")===k?"on":""}">${l}</button>`).join("")}</div>
      <button id="csCsv">⇩ CSV</button><button id="csKml">⇩ KML</button><button id="csTak">⇩ ATAK</button></div>
    <p style="margin:2px 2px 10px" id="csCount">${TR?csTowerLine(TR, ar, list):`<b>${list.length}</b> cell site${list.length===1?"":"s"} (${r.cells.toLocaleString()} cells) within ${S.radius} mi · ${onTower} matched to an FCC-registered tower · ${r.towers_nearby.toLocaleString()} registered towers nearby`}</p>
    ${topTxt&&(!run.done||all.length)?`<p class="status${run.bad?" err":""}" id="csTop" role="status">${esc(topTxt)}</p>`:""}
    <div class="panel"><h3>Carrier coverage at the pin <span class="hint">· FCC Broadband Map${cov.as_of?`, data as of ${esc(cov.as_of)}`:""}</span></h3>
      ${cov.reloading?'<p class="hint" style="margin:0">Carrier coverage is reloading (a new FCC release or more states); Data &amp; updates shows its progress.</p>'
      :!cov.loaded?'<p class="hint" style="margin:0">Not loaded: set the carrier-coverage states in Data &amp; updates, then run FCC carrier coverage.</p>'
      :!cov.carriers.length?'<p class="hint" style="margin:0">No loaded carrier reports coverage here (or the pin is outside your carrier-coverage states).</p>'
      :`<div class="tw"><table><thead><tr><th>Carrier</th><th>Technology</th><th>Speeds (down/up Mbps)</th><th class="n">Strongest modelled signal</th><th>Holds</th><th></th></tr></thead><tbody>
        ${cov.carriers.map(c=>`<tr><td><b>${esc(c.brand)}</b></td><td>${esc(c.tech)}</td><td class="mono">${c.speeds.map(esc).join(", ")}</td>
          <td class="n">${c.signal!=null?`${c.signal} dBm`:""}</td><td class="hint">${c.envs.map(esc).join("; ")}</td>
          <td><button class="sm" data-model="${c.provider}" title="The frequencies in this carrier's filed link budgets and the tool it modelled coverage with">How modelled</button></td></tr>
          <tr hidden data-modelrow="${c.provider}"><td colspan="6" class="hint"></td></tr>`).join("")}</tbody></table></div>
        <p class="hint" style="margin:6px 0 0">What each carrier tells the FCC it covers, modelled, not measured. Map tab, Heatmap: Carrier coverage draws it.</p>`}
      ${nb.checks.length?`<h4 style="margin:12px 0 4px">FCC checks of that coverage here <span class="hint">· resolved challenges, verifications and audits in this 0.7 km² cell</span></h4>
        <div class="tw"><table><thead><tr><th>Check</th><th>Carrier</th><th>Technology</th><th>Speed</th><th>Where</th><th>Outcome</th><th>Date</th></tr></thead><tbody>
        ${nb.checks.map(c=>`<tr><td>${esc(c.kind)}</td><td><b>${esc(c.carrier)}</b></td><td>${esc(c.tech)}</td><td class="mono">${esc(c.speed||"")}</td><td class="hint">${esc(c.setting||"")}</td>
          <td>${esc(c.outcome||"")}${c.detail?`<div class="hint">${esc(c.detail)}</div>`:""}</td><td class="mono">${esc(c.date||"")}</td></tr>`).join("")}</tbody></table></div>`:""}
      ${nb.fixed_wireless.length?`<h4 style="margin:12px 0 4px">Fixed wireless offered here <span class="hint">· FCC Broadband Map, this 0.7 km² cell</span></h4>
        <div class="tw"><table><thead><tr><th>Provider</th><th>Kind</th><th class="n">Best speed (down/up Mbps)</th><th class="n">Locations</th></tr></thead><tbody>
        ${nb.fixed_wireless.map(f=>`<tr><td><b>${esc(f.provider)}</b>${f.holding&&f.holding!==f.provider?`<div class="hint">${esc(f.holding)}</div>`:""}</td><td>${esc(f.tech)}</td>
          <td class="n mono">${f.down}/${f.up}</td><td class="n">${f.locations.toLocaleString()}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint" style="margin:6px 0 0">Licensed (CBRS, 3.5 GHz and the like), unlicensed (5 GHz, 900 MHz) and LBR fixed wireless: emitters a survey may hear.</p>`:""}</div>
    ${all.length?"":`<div class="panel"><h3>No cells here yet</h3>${run&&run.done?`<p class="status${run.bad?" err":""}" id="csWhy">${esc(run.words)}</p>`:""}<p class="hint" style="margin-top:0">Cell data comes from the crowd and from your own surveys:</p>
      <ul class="hint"><li><b>OpenCelliD</b>: add your free key in Data &amp; updates and fetch for the pin, or import a whole-country download below (free account at <a href="https://opencellid.org/downloads.php" target="_blank" rel="noopener">opencellid.org/downloads.php</a>; the US files are 310 to 316).</li>
        ${r.sources.wigle?`<li><b>WiGLE</b>: add your API name and token in Data &amp; updates, then fetch for the pin (cells come with Wi-Fi and Bluetooth).</li>`:""}
        <li><b>Your captures</b>: WiGLE WiFi app exports and cell scanner CSVs imported in a mission (cells need their MCC-MNC-area-cell ID).</li></ul></div>`}
    <div class="panel"><h3>Import an OpenCelliD download</h3>
      <div class="row"><input type="file" id="csImp" accept=".csv,.gz"><span class="hint" id="csMsg">Kept to the states set in Data &amp; updates (${esc(r.states||"all states: large")}).</span></div></div>
    ${C.by==="tower"?towersHtml(ar, list, r.towers, {all, q, R:TR}):list.length?`<div class="tw"><table id="csList"><thead><tr><th>Operator</th><th>Tech</th><th>Site</th><th>Sectors (cell IDs)</th><th>Tower (FCC)</th><th>Owner</th><th class="n">Height</th><th class="n">Licensees on it</th><th class="n">Samples</th><th>Last seen</th><th class="n">Distance</th></tr></thead><tbody>
      ${csSorted(list).slice(0,1500).map((s,i)=>`<tr data-i="${all.indexOf(s)}" style="cursor:pointer"><td><b>${esc(s.operator)}</b><div class="hint mono">${esc(s.plmn)}</div></td><td>${esc(s.radio)}</td>
        <td class="mono">${esc(s.site_kind.split(" ")[0])} ${esc(String(s.site_id))}</td>
        <td class="mono" style="font-size:11px">${s.cells.slice(0,6).map(c=>`${esc(c.gci)}${c.az_est!=null?` <span class="hint">${c.az_est}°</span>`:""}`).join("<br>")}${s.cells.length>6?`<br><span class="hint">+${s.cells.length-6}</span>`:""}</td>
        <td class="mono">${s.tower?esc(s.tower.reg):'<span class="hint">none within 1 km</span>'}</td><td>${esc(s.tower?.owner||"")}</td>
        <td class="n">${s.tower?.overall_agl_m!=null?`${Math.round(s.tower.overall_agl_m*3.281)} ft`:""}</td><td class="n">${s.tower?s.tower.licensees.length:""}</td>
        <td class="n">${s.samples?s.samples.toLocaleString():""}</td><td>${esc(s.last||"")}</td><td class="n">${num(s.dist_mi,2)} mi</td></tr>`).join("")}</tbody></table></div>
      <p class="hint">Click a site for its sectors, its estimated coverage and its tower. Sector directions are estimates from the crowd positions. ${esc(Object.values(r.sources).join(" · "))}.</p>`:""}`;
  v.querySelectorAll("[data-model]").forEach(b=>b.onclick=async()=>{ const rows=v.querySelectorAll(`[data-modelrow="${b.dataset.model}"]`), td=rows[0].firstElementChild;
    if(!rows[0].hidden){ rows.forEach(x=>x.hidden=true); return; }
    td.textContent="Reading the carrier's filing…"; rows[0].hidden=false;
    try{ const m=await api(`/api/bdc/modelled?provider=${b.dataset.model}`);
      // a header with Close at the top and the detail in its own scroll box (both ways), frequencies grouped by
      // technology and repeated model lines shown once with a count: a big carrier's filing was hundreds of lines
      // with nothing to close it but scrolling back up (Cody 11/3)
      const brand=b.closest("tr")?.querySelector("td")?.textContent.trim()||"This carrier";
      // one row per band, top to bottom (Cody 11/6: "not left/right but make it up/down for each band"): its downlink and uplink centres, the
      // channel widths filed, and which technologies use it. The band's name is sigmeta.js's, without the direction
      const tname=t=>/^\d+$/.test(String(t))?`code ${t}`:String(t);
      const bandOf=mhz=>((window.sigMetaParts?.bandsAt(+mhz)||[])[0]||`${num(mhz,1)} MHz`).replace(/, (downlink|uplink|base|mobile)$/,"");
      const byBand=new Map(); for(const f of m.frequencies){ const k=bandOf(f.mhz), x=byBand.get(k)||byBand.set(k,{band:k, down:new Map(), up:new Map(), techs:new Set(), lo:+f.mhz}).get(k);
        const side=f.direction==="up"?x.up:x.down, w=side.get(+f.mhz)||side.set(+f.mhz,new Set()).get(+f.mhz); if(f.bw_mhz) w.add(+f.bw_mhz); x.techs.add(tname(f.tech)); x.lo=Math.min(x.lo,+f.mhz); }
      const sideTxt=m=>[...m].sort((a,b)=>a[0]-b[0]).map(([mhz,ws])=>`<div><span class="mono">${num(mhz,mhz%1?2:0)} MHz</span>${ws.size?` <span class="hint">· ${[...ws].sort((a,b)=>a-b).join(", ")} MHz wide</span>`:""}</div>`).join("")||'<span class="hint">none filed</span>';
      const lines=new Map(); for(const x of m.models){ const s=`${x.tool||""}${x.developer?` (${x.developer})`:""}, ${x.resolution_m??"?"} m grid, receiver at ${x.rx_height_m??"?"} m, terrain ${x.terrain||"?"}, clutter ${x.clutter||"?"}, ${x.calibrated?`calibrated${x.calibration_date?` ${x.calibration_date}`:""}`:"not calibrated"}`;
        const k=`${x.tech}|${s}`; lines.set(k,{tech:tname(x.tech), x, n:(lines.get(k)?.n||0)+1}); }
      td.style.whiteSpace="normal";
      td.innerHTML=`<div class="row" style="justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
          <b>How ${esc(brand)} modelled its coverage</b><button class="sm" data-modelclose title="Close (or press How modelled again)">✕ Close</button></div>
        <div style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px 10px">${!m.models.length&&!m.frequencies.length?"No link budget filed for this carrier is loaded (Data &amp; updates: FCC broadband extras).":
          `${byBand.size?`<p style="margin:0 0 6px"><b>Frequencies in its link budgets</b> <span class="hint">· one row per band</span></p>
            <div class="tw"><table id="bdcBands"><thead><tr><th>Band</th><th>Downlink (tower to phone)</th><th>Uplink (phone to tower)</th><th>Technologies</th></tr></thead><tbody>
            ${[...byBand.values()].sort((a,b)=>a.lo-b.lo).map(x=>`<tr><td><b>${esc(x.band)}</b></td><td>${sideTxt(x.down)}</td><td>${sideTxt(x.up)}</td><td>${esc([...x.techs].join(", "))}</td></tr>`).join("")}</tbody></table></div>`:""}
          ${lines.size?`<p style="margin:12px 0 6px"><b>Propagation models</b> <span class="hint">· ${m.models.length.toLocaleString()} filed, ${lines.size} different</span></p>
            <div class="tw"><table id="bdcModels"><thead><tr><th>Technology</th><th>Tool</th><th>Grid</th><th>Receiver height</th><th>Terrain</th><th>Clutter</th><th>Calibrated</th><th class="n">Filed</th></tr></thead><tbody>
            ${[...lines.values()].map(({tech,x,n})=>`<tr><td><b>${esc(tech)}</b></td><td>${esc([x.tool,x.developer&&`(${x.developer})`].filter(Boolean).join(" ")||"?")}</td><td>${x.resolution_m??"?"} m</td><td>${x.rx_height_m??"?"} m</td>
              <td>${esc(x.terrain||"?")}</td><td>${esc(x.clutter||"?")}</td><td>${x.calibrated?`yes${x.calibration_date?`, ${esc(x.calibration_date)}`:""}`:"no"}</td><td class="n">×${n}</td></tr>`).join("")}</tbody></table></div>`:""}
          ${[...byBand.values()].some(x=>[...x.techs].some(t=>/^code /.test(t)))?'<p class="hint" style="margin:6px 0 0">A code is the technology number as the carrier filed it, where the filing names no technology.</p>':""}`}</div>
        <p class="hint" style="margin:6px 0 0">What the carrier filed with the FCC (Broadband Data Collection, supporting data).</p>`;
      td.querySelector("[data-modelclose]").onclick=()=>rows.forEach(x=>x.hidden=true); }
    catch(e){ td.textContent=e.message; } });
  $("#csOp").onchange=e=>{ C.op=e.target.value; render(); };
  $("#csRadio").onchange=e=>{ C.radio=e.target.value; render(); };
  // the box gets the focus back once the tab is drawn again: render() draws after its answers come, so the box wasn't there yet when it
  // was focused straight after ("Cannot read properties of null (reading 'focus')", the first time the sweep typed in Find, review 11/12)
  // the flag is the draw it was set for (its viewGen): a draw that never finished (the tab left, a newer draw) left it set, and the
  // next Cell sites draw, minutes later, put the caret in Find and a phone's keyboard up (round 2); the tab left: what was typed is
  // kept for when it's back, with no draw and no focus
  let t; $("#csQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ C.q=e.target.value; if(S.tab!=="cells") return; C.qFocus=(S.viewGen||0)+1; render(); },350); };
  if(C.qFocus){ const mine=C.qFocus===gen; C.qFocus=0; const i=mine&&$("#csQ"); if(i){ i.focus(); i.setSelectionRange(i.value.length,i.value.length); } }
  // a row shows its site in the results viewer here, on this tab (Cody 11/10: it jumped to the Map tab); Show on map goes there
  v.querySelectorAll("tr[data-i]").forEach(tr=>tr.onclick=()=>emCellView(v, all[+tr.dataset.i]));
  v.querySelectorAll("#csBy [data-by]").forEach(b=>b.onclick=()=>{ C.by=b.dataset.by; render(); });
  // a tower opens its first site, where the engine places it in By tower (csOnTower)
  v.querySelectorAll("tr[data-tws]").forEach(tr=>tr.onclick=()=>{ const s=all.find(x=>x.key===tr.dataset.tws), t=TI&&(ar.towers||[]).find(x=>x.id===tr.dataset.tw);
    if(s) emCellView(v, t?csOnTower(s, t):s); });
  $("#csImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#csMsg").textContent=`Importing ${f.name} (${(f.size/1e6).toFixed(0)} MB)… large country files take a few minutes.`;
    try{ const x=await api(`/api/cells/import?name=${encodeURIComponent(f.name)}`,{method:"POST", body:f}); $("#csMsg").textContent=`${x.kept.toLocaleString()} cells kept of ${x.read.toLocaleString()} in the file${x.states.length?` (${x.states.join(", ")})`:""}.`;
      setTimeout(()=>{ window.RFTowers?.dropArea(); window.cellAllRefresh?.(); render(); },1200); }  /* the sites and the towers on them, asked fresh together (round 2) */
    catch(err){ $("#csMsg").textContent="Import: "+err.message; } };
  const flat=()=>list.flatMap(s=>s.cells.map(c=>({operator:s.operator, plmn:s.plmn, radio:s.radio, site_kind:s.site_kind, site_id:s.site_id, gci:c.gci, sector:c.sector, area:c.area,
    cell_lat:c.lat, cell_lon:c.lon, azimuth_est:c.az_est??"", range_m:c.range_m??"", samples:c.samples, last_seen:c.last||"", sources:c.sources.join("; "),
    site_lat:s.lat, site_lon:s.lon, tower_reg:s.tower?.reg||"", tower_owner:s.tower?.owner||"", tower_agl_m:s.tower?.overall_agl_m??"", tower_match_m:s.tower?.match_m??"",
    pci_psc:c.pci??"", bands_licensed_here:(s.bands||[]).join(" ")})));
  $("#csCsv").onclick=()=>dasDl("DAStastic cell sites.csv", csvOf(flat()), "text/csv");
  $("#csKml").onclick=()=>{ const x=s=>String(s??"").replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
    dasDl("DAStastic cell sites.kml", `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Cell sites</name>${list.map(s=>
      `<Placemark><name>${x(`${s.operator} ${s.radio} ${s.site_id}`)}</name><description>${x(`${s.cells.map(c=>c.gci).join(", ")}${s.tower?` · tower ${s.tower.reg} ${s.tower.owner||""}`:""}`)}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join("")}</Document></kml>`,
      "application/vnd.google-earth.kml+xml"); };
  $("#csTak").onclick=()=>RFTak.save({rows:list.map(s=>({layer:"opencellid", lat:s.lat, lon:s.lon, label:`${s.operator} ${s.radio} ${s.site_id}`, licensee:s.operator, call_sign:s.plmn,
    sig_type:s.radio==="NR"?"5G NR":s.radio, freq_mhz:null, dist_mi:s.dist_mi})), center:S.center, radius:S.radius, name:"DAStastic - cell sites", colorOf, typeOf, fccDate:null});
};
