"use strict";
/* RF Recon — missions (setup + live settings), captures, field log, data sources & auto-update. */

const BAND_LABELS=["VHF Low","6m","72-76 MHz","Aviation VHF","VHF High","VHF TV/Aux","220 MHz","Gov UHF/Other","UHF","UHF T-Band","UHF TV/Aux","700 MHz","800 MHz","900 MHz","L-band/1-2 GHz","2-6 GHz","Microwave >6 GHz"];
const STATUSES=["Planning","Active","Paused","Complete"];

async function loadMission(id, applyArea){
  if(!id){ S.mission=null; S.missionId=null; $("#missionName").textContent="No mission"; return; }
  const m=await api("/api/missions/"+id); S.mission=m; S.missionId=m.id;
  try{ const t=await api(`/api/missions/${id}/tracks`); S.mission.tracks=t.tracks; }catch(e){}
  $("#missionName").textContent=`${m.name} · ${m.status}`;
  const lay=m.settings.layers||{}; S.layerOn=new Set(Object.keys(LAYERS).filter(k=>lay[k]!==false && !(k==="uls_hist"&&!lay[k])));
  $("#hideMobile").checked=m.settings.fixed_sites_only!==false;
  if(applyArea && m.lat!=null){ setMode("point"); $("#loc").value=`${m.lat}, ${m.lon}`; $("#radius").value=m.radius_mi||5; $("#radiusSlider").value=m.radius_mi||5; }
}
window.missionBoot = async () => {
  try{ const me=await api("/api/me"); S.remote=me.remote?me:null; }catch(e){ S.remote=null; }
  if(S.remote){  // signed in through the remote link (remote.py): view and search only
    document.body.classList.add("remote"); if(S.tab==="data") setTab("map");
    $("#netLed").className="led on"; $("#netText").textContent=`View only · ${S.remote.user} · Sign out`;
    $("#netChip").title="Signed in to Cody's RF Recon. Press to sign out."; $("#netChip").onclick=()=>{ location.href="/remote/logout"; };
  }
  try{ const r=await api("/api/missions"); if(r.active) { await loadMission(r.active, true); if(parseLoc($("#loc").value)) runSearch(); } }catch(e){}
  if(!S.remote){ netHint(); pollStatus(); setInterval(pollStatus, 15000); }
};
$("#missionChip").onclick=()=>setTab("mission");
$("#netChip").onclick=()=>setTab("data");

/* ---------- mission view ---------- */
S.views.mission = async (v) => {
  v.innerHTML='<p class="status">Loading missions…</p>';
  const list=await api("/api/missions");
  const m=S.mission, s=m?.settings||{};
  const editing = S.missionEdit || (m?"edit":"new");
  const cur = editing==="new" ? {settings:{}} : m;
  const cs = editing==="new" ? {gps_max_accuracy_m:50,sweep_threshold_db:10,track_match_s:30,heat_size:200,heat_metric:"mean",heat_combine:"max",heat_alpha:190,fixed_sites_only:true,layers:{uls:true,towers:true,captures:true,wigle:true,opencellid:true,repeaterbook:true,custom:true},watch:[],target_types:[],target_bands:[]} : s;
  const ll=parseLoc($("#loc").value);
  v.innerHTML=`
  <div class="grid2" style="margin-top:0;grid-template-columns:minmax(260px,1fr) minmax(320px,2fr)">
    <div class="panel"><h3>Missions</h3>
      <button class="primary" id="mNew" style="width:100%;margin-bottom:8px">+ New mission</button>
      ${list.missions.map(x=>`<div class="item" data-mid="${x.id}" style="grid-template-columns:1fr auto;${x.id===S.missionId?"background:var(--sel)":""}">
        <span class="t">${esc(x.name)}</span><span class="tag ${x.status==="Active"?"v":""}">${esc(x.status)}</span>
        <span class="s" style="grid-column:1/3">${x.lat!=null?`${(+x.lat).toFixed(4)}, ${(+x.lon).toFixed(4)} · ${x.radius_mi} mi`:"no area"}${x.start_date?` · ${esc(x.start_date)}`:""}${x.operator?` · ${esc(x.operator)}`:""}</span></div>`).join("")||'<p class="hint">No missions yet.</p>'}
    </div>
    <div class="panel">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">${editing==="new"?"New mission":"Mission settings — edit any time; changes are logged"}</h3>
        ${m&&editing!=="new"?`<span class="row"><button id="mGo">Go to area</button><button class="danger" id="mDel">Delete</button></span>`:""}</div>
      <div class="sec"><h3>Basics</h3><div class="row">
        <label class="grow">Name<input id="m_name" value="${esc(cur.name||"")}" placeholder="e.g. Fairfax Station 12 LMR survey"></label>
        <label>Status<select id="m_status">${STATUSES.map(x=>`<option ${(cur.status||"Planning")===x?"selected":""}>${x}</option>`).join("")}</select></label>
        <label>Operator<input id="m_operator" value="${esc(cur.operator||"")}" style="width:140px"></label>
        <label>Start<input id="m_start" type="date" value="${esc(cur.start_date||"")}"></label>
        <label>End<input id="m_end" type="date" value="${esc(cur.end_date||"")}"></label></div>
        <label style="margin-top:6px">Objective / notes<textarea id="m_obj" rows="2">${esc(cur.objective||"")}</textarea></label></div>
      <div class="sec"><h3>Area</h3><div class="row">
        <label>Latitude<input id="m_lat" type="number" step="any" value="${cur.lat??(ll?ll[0]:"")}" style="width:130px"></label>
        <label>Longitude<input id="m_lon" type="number" step="any" value="${cur.lon??(ll?ll[1]:"")}" style="width:130px"></label>
        <label>Radius mi<input id="m_radius" type="number" step="0.25" value="${cur.radius_mi??($("#radius").value||5)}" style="width:90px"></label>
        <label>State<input id="m_state" value="${esc(cur.state||(S.rows.find(r=>r.state)?.state||""))}" maxlength="2" style="width:60px"></label>
        <button id="m_usePin">Use current pin</button></div></div>
      <div class="sec"><h3>Targets</h3>
        <div class="hint">Signal types of interest</div><div class="chips" id="m_types">${Object.keys(S.lib).filter(k=>k!=="Unknown").map(t=>`<span class="chip ${(cs.target_types||[]).includes(t)?"on":""}" data-mt="${esc(t)}"><span class="dot" style="background:${S.lib[t].color}"></span>${esc(t)}</span>`).join("")}</div>
        <div class="hint" style="margin-top:6px">Bands of interest</div><div class="chips" id="m_bands">${BAND_LABELS.map(b=>`<span class="chip ${(cs.target_bands||[]).includes(b)?"on":""}" data-mb="${esc(b)}">${esc(b)}</span>`).join("")}</div>
        <div class="hint" style="margin-top:6px">Watch list — planned or suspect frequencies (checked against licenses, repeater inputs, captures and crowd data)</div>
        <div id="m_watch">${(cs.watch||[]).map(w=>watchRow(w)).join("")}</div><button id="m_addWatch" style="margin-top:4px">+ Add frequency</button>
        ${m&&editing!=="new"?`<div style="margin-top:8px"><button id="m_applyTargets">Apply targets as filters now</button></div>`:""}</div>
      <div class="sec"><h3>Default layers</h3><div class="chips">${Object.entries(LAYERS).map(([k,l])=>`<label class="inl" style="margin-right:10px"><input type="checkbox" data-ml="${k}" ${(cs.layers||{})[k]?"checked":""}> ${esc(l.label)}</label>`).join("")}</div>
        <label class="inl" style="margin-top:6px"><input type="checkbox" id="m_fixed" ${cs.fixed_sites_only!==false?"checked":""}> Fixed transmitter sites only (hide mobile/area licenses)</label>
        <label class="inl"><input type="checkbox" id="m_autocrowd" ${cs.auto_refresh_crowd?"checked":""}> Keep crowd layers (WiGLE / OpenCelliD / RepeaterBook) refreshed for this area when auto-update runs</label></div>
      <div class="sec"><h3>Collection settings</h3><div class="row">
        <label>Max GPS error (m)<input id="m_gps" type="number" value="${cs.gps_max_accuracy_m??50}" style="width:100px"></label>
        <label>Ignore below (dBm)<input id="m_mindbm" type="number" value="${cs.min_dbm??""}" placeholder="none" style="width:100px"></label>
        <label>SDR peak threshold (dB over floor)<input id="m_sweep" type="number" value="${cs.sweep_threshold_db??10}" style="width:100px"></label>
        <label>Match points to GPS track within (s)<input id="m_track" type="number" value="${cs.track_match_s??30}" style="width:100px"></label></div>
        <p class="hint">Applied to every capture imported from now on. Changing them mid-mission is logged with a timestamp.</p></div>
      <div class="sec"><h3>Heatmap settings</h3><div class="row">
        <label>Resolution (cells)<select id="m_hsize">${[100,150,200,300,400,600].map(x=>`<option ${+cs.heat_size===x?"selected":""}>${x}</option>`).join("")}</select></label>
        <label>Measured: combine<select id="m_hmetric"><option value="mean" ${cs.heat_metric!=="max"?"selected":""}>Average</option><option value="max" ${cs.heat_metric==="max"?"selected":""}>Strongest</option></select></label>
        <label>Predicted: combine<select id="m_hcomb"><option value="max" ${cs.heat_combine!=="sum"?"selected":""}>Strongest signal</option><option value="sum" ${cs.heat_combine==="sum"?"selected":""}>Total RF energy</option></select></label>
        <label>Opacity<input id="m_halpha" type="range" min="60" max="255" value="${cs.heat_alpha??190}"></label></div></div>
      <div class="row" style="margin-top:12px"><button class="primary" id="mSave">${editing==="new"?"Create mission":"Save changes"}</button>
        ${editing==="new"&&m?`<button id="mCancel">Cancel</button>`:""}<span class="hint" id="mMsg"></span></div>
    </div>
  </div>
  ${m&&editing!=="new"?`
  <div class="grid2">
    <div class="panel"><h3>Import field captures</h3>
      <p class="hint">WiGLE / Kismet (wiglecsv) · GPX tracks · rtl_power / hackrf_sweep CSV · analyzer CSV (lat, lon, freq, dBm…) · KML / KMZ. Import GPS tracks first; later files without coordinates are positioned from them by time.</p>
      <div class="row"><input type="file" id="capFiles" multiple accept=".csv,.txt,.gpx,.kml,.kmz">
        <label class="inl"><input type="checkbox" id="capFixed"> Place un-positioned points at the mission pin</label></div>
      <div id="capResult" class="hint" style="margin-top:6px">${S.capNote?.mid===m?.id?S.capNote.html:""}</div>
      <div class="tw" style="margin-top:8px;max-height:260px"><table><thead><tr><th>Capture</th><th>Format</th><th>Points</th><th>Track</th><th>Imported</th><th></th></tr></thead><tbody>
        ${m.captures.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.fmt)}</td><td class="n">${c.points}</td><td class="n">${c.track_points}</td><td class="mono">${esc((c.imported_at||"").slice(0,16))}</td><td><button class="danger" data-delcap="${c.id}">✕</button></td></tr>`).join("")||'<tr><td colspan="6" class="hint">No captures yet.</td></tr>'}</tbody></table></div></div>
    <div class="panel"><h3>Field log — quick entry</h3>
      <div class="row"><label>Lat<input id="fl_lat" type="number" step="any" style="width:110px"></label><label>Lon<input id="fl_lon" type="number" step="any" style="width:110px"></label>
        <button id="fl_gps">◎ GPS</button><button id="fl_pin">Use pin</button></div>
      <div class="row" style="margin-top:6px"><label>Freq MHz<input id="fl_freq" type="number" step="any" style="width:110px"></label><label>dBm<input id="fl_dbm" type="number" step="any" style="width:80px"></label>
        <label>Type<select id="fl_type"><option value="">Auto-identify</option>${Object.keys(S.lib).map(t=>`<option>${esc(t)}</option>`).join("")}</select></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">Label / notes<input id="fl_notes" placeholder="e.g. dispatch, NAC 293, heard from parking lot"></label><button class="primary" id="fl_log">Log</button></div>
      <div id="fl_res" class="hint" style="margin-top:6px"></div>
      <h3 style="margin-top:14px">Mission log</h3>
      <div class="row"><input id="ml_note" class="grow" placeholder="Add a note…"><button id="ml_add">Add</button></div>
      <div class="log" style="margin-top:6px">${(m.log||[]).map(l=>`<div><span class="mono hint">${esc(l.ts)}</span> <span class="tag">${esc(l.kind)}</span> ${esc(l.detail)}</div>`).join("")}</div>
      <div class="row" style="margin-top:10px"><button id="mx_kml">⇩ Mission KML (points + GPS tracks)</button><button id="mx_csv">⇩ Mission CSV</button></div></div>
  </div>`:""}`;
  // compare with another survey: what's new, gone or changed since a baseline (research: baseline comparison)
  if(m && editing!=="new"){
    const others=list.missions.filter(x=>x.id!==m.id);
    v.insertAdjacentHTML("beforeend", `<div class="panel" style="margin-top:10px"><h3>Compare with another survey <span class="hint">· what's new, gone or changed since a baseline</span></h3>
      ${others.length?`<div class="row" style="align-items:flex-end"><label>Baseline <select id="cmpA">${others.map(x=>`<option value="${x.id}">${esc(x.name)}${x.start_date?` · ${esc(x.start_date)}`:""}</option>`).join("")}</select></label>
        <label>Changed when the level moves at least <select id="cmpD">${[3,6,10,15].map(d=>`<option ${d===6?"selected":""}>${d}</option>`).join("")}</select> dB</label>
        <button class="primary" id="cmpGo">Compare</button></div><div id="cmpOut" style="margin-top:8px"></div>`
      :'<p class="hint">Make a second mission for the same place (another day or visit), import its captures, then compare the two here.</p>'}</div>`);
    if($("#cmpGo")) $("#cmpGo").onclick=async()=>{
      const out=$("#cmpOut"); out.innerHTML='<p class="status">Comparing…</p>';
      try{
        const c=await api(`/api/compare?a=${$("#cmpA").value}&b=${m.id}&delta=${$("#cmpD").value}`);
        const sig=s=>s.freq_mhz?`<span class="mono">${fmtF(s.freq_mhz)}</span> MHz`:`<span class="mono">${esc(s.ident||"")}</span>`;
        const table=(rows,cols)=>rows.length?`<div class="tw" style="max-height:320px"><table><thead><tr><th>Signal</th><th>Type</th><th>Label / ID</th>${cols.map(c=>`<th>${c[0]}</th>`).join("")}<th>Seen</th></tr></thead><tbody>${rows.slice(0,150).map(s=>`<tr><td>${sig(s)}</td><td>${esc(s.sig_type||"")}</td><td>${esc(s.label||"")}</td>${cols.map(c=>`<td class="n">${c[1](s)}</td>`).join("")}<td class="mono hint">${esc((s.first||"").slice(0,16))}${s.last&&s.last!==s.first?` → ${esc(s.last.slice(11,16))}`:""}</td></tr>`).join("")}</tbody></table></div>${rows.length>150?`<p class="hint">First 150 of ${rows.length}.</p>`:""}`:'<p class="hint">None.</p>';
        out.innerHTML=`<p><b>${esc(c.b.name)}</b> (${c.b.signals.toLocaleString()} signals) against <b>${esc(c.a.name)}</b> (${c.a.signals.toLocaleString()}):
          <b style="color:var(--bad)">${c.new.length} new</b>, <b>${c.gone.length} gone</b>, <b style="color:var(--warn)">${c.changed.length} changed by ${c.delta_db} dB or more</b>, ${c.same} the same.
          <span class="hint">Signals match by MAC or cell ID where there is one, else by 6.25 kHz channel and type.</span></p>
          <h3>New since the baseline</h3>${table(c.new,[["Strongest dBm",s=>num(s.max_dbm,0)],["Readings",s=>s.n]])}
          <h3>Gone (in the baseline, not now)</h3>${table(c.gone,[["Strongest dBm then",s=>num(s.max_dbm,0)],["Readings",s=>s.n]])}
          <h3>Changed level</h3>${table(c.changed,[["Before",s=>num(s.before_dbm,0)],["Now",s=>num(s.max_dbm,0)],["Change dB",s=>`<b style="color:${s.delta_db>0?"var(--bad)":"var(--good)"}">${s.delta_db>0?"+":""}${s.delta_db}</b>`]])}`;
      }catch(e){ out.innerHTML=`<p class="status err">${esc(e.message)}</p>`; }
    };
  }
  // list
  v.querySelectorAll("[data-mid]").forEach(el=>el.onclick=async()=>{ S.missionEdit=null; await post(`/api/missions/${el.dataset.mid}/activate`); await loadMission(+el.dataset.mid,true); render(); if(parseLoc($("#loc").value)) runSearch(); });
  $("#mNew").onclick=()=>{ S.missionEdit="new"; render(); };
  if($("#mCancel")) $("#mCancel").onclick=()=>{ S.missionEdit=null; render(); };
  if($("#mGo")) $("#mGo").onclick=()=>{ loadMission(S.missionId,true).then(()=>{ setTab("map"); runSearch(); }); };
  if($("#mDel")) $("#mDel").onclick=async()=>{ if(!confirm(`Delete mission “${m.name}” with its captures, observations and log?`)) return; await post(`/api/missions/${m.id}/delete`); await loadMission(null); render(); };
  $("#m_usePin").onclick=()=>{ const p=parseLoc($("#loc").value); if(p){ $("#m_lat").value=p[0]; $("#m_lon").value=p[1]; $("#m_radius").value=$("#radius").value; } };
  v.querySelectorAll("[data-mt],[data-mb]").forEach(c=>c.onclick=()=>c.classList.toggle("on"));
  $("#m_addWatch").onclick=()=>$("#m_watch").insertAdjacentHTML("beforeend",watchRow({}));
  $("#m_watch").onclick=e=>{ if(e.target.matches("[data-rmw]")) e.target.closest(".row").remove(); };
  if($("#m_applyTargets")) $("#m_applyTargets").onclick=()=>{ S.chips.type=new Set(s.target_types||[]); S.chips.band=new Set(s.target_bands||[]); setTab("map"); };
  $("#mSave").onclick=async()=>{
    const watch=[...$$("#m_watch .row")].map(r=>({freq:parseFloat(r.querySelector("[data-w=freq]").value),tol_khz:parseFloat(r.querySelector("[data-w=tol]").value)||12.5,label:r.querySelector("[data-w=label]").value})).filter(w=>w.freq);
    const layers={}; v.querySelectorAll("[data-ml]").forEach(x=>layers[x.dataset.ml]=x.checked);
    const nn=id=>$(id).value===""?null:+$(id).value;
    const d={name:$("#m_name").value||"Untitled mission", status:$("#m_status").value, operator:$("#m_operator").value, start_date:$("#m_start").value, end_date:$("#m_end").value,
      objective:$("#m_obj").value, lat:nn("#m_lat"), lon:nn("#m_lon"), radius_mi:nn("#m_radius")||5, state:$("#m_state").value.toUpperCase(),
      settings:{target_types:[...v.querySelectorAll("[data-mt].on")].map(x=>x.dataset.mt), target_bands:[...v.querySelectorAll("[data-mb].on")].map(x=>x.dataset.mb), watch, layers,
        fixed_sites_only:$("#m_fixed").checked, auto_refresh_crowd:$("#m_autocrowd").checked, gps_max_accuracy_m:nn("#m_gps"), min_dbm:nn("#m_mindbm"),
        sweep_threshold_db:nn("#m_sweep")??10, track_match_s:nn("#m_track")??30, heat_size:+$("#m_hsize").value, heat_metric:$("#m_hmetric").value, heat_combine:$("#m_hcomb").value, heat_alpha:+$("#m_halpha").value}};
    try{
      const res = editing==="new" ? await post("/api/missions", d) : await post(`/api/missions/${m.id}`, d);
      if(editing==="new") await post(`/api/missions/${res.id}/activate`);
      S.missionEdit=null; await loadMission(res.id, editing==="new"); render();
      $("#mMsg").textContent = editing==="new"?"Mission created and set active.":"Saved — changes logged.";
      if(editing==="new" && parseLoc($("#loc").value)) runSearch(); else if(S.rows.length) runSearch();
    }catch(e){ $("#mMsg").textContent="Error: "+e.message; }
  };
  if(!m||editing==="new") return;
  // the import's progress and summary live in S.capNote, so a re-render (the search that follows, a tab change) keeps them
  const capNote=html=>{ S.capNote={mid:m.id, html}; const el=$("#capResult"); if(el) el.innerHTML=html; };
  $("#capFiles").onchange=async e=>{ const files=[...e.target.files].sort((a,b)=>(/\.gpx$/i.test(b.name)?1:0)-(/\.gpx$/i.test(a.name)?1:0)); const out=[];
    const fixed=$("#capFixed").checked;  // read once: the tab may be gone before the last file is in
    for(const f of files){ capNote([...out, `Importing ${esc(f.name)}…`].join("<br>"));
      try{ const r=await api(`/api/captures/import?mission=${m.id}&filename=${encodeURIComponent(f.name)}${fixed?"&fixed=1":""}`,{method:"POST",body:await f.arrayBuffer()});
        out.push(`<b>${esc(f.name)}</b> (${esc(r.format)}): ${r.points} points, ${r.track_points} track points${r.positioned_from_track?`, ${r.positioned_from_track} positioned from GPS track`:""}${r.dropped_accuracy?`, ${r.dropped_accuracy} dropped for GPS error`:""}${r.dropped_below_min_dbm?`, ${r.dropped_below_min_dbm} below min dBm`:""}${r.dropped_no_position?`, ${r.dropped_no_position} without position`:""} — ${Object.entries(r.types).map(([k,n])=>`${esc(k)} ${n}`).join(", ")}`); }
      catch(err){ out.push(`<b>${esc(f.name)}</b>: <span style="color:var(--bad)">${esc(err.message)}</span>`); } }
    capNote(out.join("<br>")); await loadMission(m.id); render(); if(S.rows.length||parseLoc($("#loc").value)) runSearch(); };
  v.querySelectorAll("[data-delcap]").forEach(b=>b.onclick=async()=>{ if(!confirm("Delete this capture?")) return; await post(`/api/captures/${b.dataset.delcap}/delete`); await loadMission(m.id); render(); });
  $("#fl_gps").onclick=()=>navigator.geolocation&&navigator.geolocation.getCurrentPosition(p=>{ $("#fl_lat").value=p.coords.latitude.toFixed(6); $("#fl_lon").value=p.coords.longitude.toFixed(6); $("#fl_lat").dataset.acc=p.coords.accuracy; },
    err=>{ $("#fl_res").textContent="GPS unavailable: "+err.message; },{enableHighAccuracy:true});
  $("#fl_pin").onclick=()=>{ const p=parseLoc($("#loc").value)||[m.lat,m.lon]; $("#fl_lat").value=p[0]; $("#fl_lon").value=p[1]; };
  $("#fl_log").onclick=async()=>{ const d={mission_id:m.id, lat:+$("#fl_lat").value, lon:+$("#fl_lon").value, acc:+($("#fl_lat").dataset.acc||0)||null, freq_mhz:$("#fl_freq").value, dbm:$("#fl_dbm").value===""?null:+$("#fl_dbm").value,
      type:$("#fl_type").value||null, label:$("#fl_notes").value, notes:$("#fl_notes").value};
    if(!$("#fl_lat").value){ $("#fl_res").textContent="Set a position (GPS or pin) first."; return; }
    try{ const r=await post("/api/fieldlog", d); $("#fl_res").innerHTML=`Logged — identified as <b>${esc(r.classification.sig_type)}</b> (${esc(r.classification.basis)})`
        +(r.sigwiki?.length?`<br>Could also be: ${r.sigwiki.map(c=>`<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.why.join(" · "))}">${esc(c.title)}</a>`).join(", ")} <span class="hint">(Signal ID Wiki)</span>`:"");
      $("#fl_freq").value=""; $("#fl_dbm").value=""; $("#fl_notes").value=""; }
    catch(e){ $("#fl_res").textContent="Error: "+e.message; } };
  $("#ml_add").onclick=async()=>{ if(!$("#ml_note").value) return; await post(`/api/missions/${m.id}/note`,{text:$("#ml_note").value}); await loadMission(m.id); render(); };
  const mp=()=>{ const p=new URLSearchParams({lat:m.lat,lon:m.lon,radius:m.radius_mi||5,mission:m.id,layers:"captures,uls,towers"}); return p; };
  $("#mx_kml").onclick=()=>location.href="/api/export.kml?"+mp(); $("#mx_csv").onclick=()=>location.href="/api/export.csv?"+mp();
};
function watchRow(w){ return `<div class="row" style="margin-top:4px"><input data-w="freq" type="number" step="any" placeholder="MHz" value="${w.freq??""}" style="width:120px">
  <input data-w="tol" type="number" step="any" placeholder="± kHz" value="${w.tol_khz??12.5}" style="width:80px"><input data-w="label" placeholder="label" value="${esc(w.label||"")}" class="grow"><button data-rmw="1">✕</button></div>`; }

/* ---------- connection & updates ---------- */
let UPD=null;
function netHint(){ const c=navigator.connection||{}; return post("/api/net/hint",{type:c.type||null, effectiveType:c.effectiveType||null, downlink:c.downlink||null, saveData:!!c.saveData, online:navigator.onLine}).then(u=>{ UPD=u; paintNet(); }).catch(()=>{}); }
if(navigator.connection) navigator.connection.addEventListener("change", netHint);
window.addEventListener("online", netHint); window.addEventListener("offline", ()=>{ paintNet(true); });
async function pollStatus(){ try{ UPD=await api("/api/update/status"); paintNet(); if(S.tab==="data") paintSources(); }catch(e){ $("#netLed").className="led off"; $("#netText").textContent="server offline"; } }
function paintNet(browserOffline){
  const u=UPD; if(!u) return; const busy=Object.values(u.sources).some(s=>s.running);
  const online=!browserOffline && u.net.online!==false;
  $("#netLed").className="led "+(busy?"busy":online?(u.net.online?"on":""):"off");
  const link={wifi:"Wi-Fi",cellular:"Cellular",ethernet:"Ethernet",vpn:"VPN"}[u.link]||"";
  $("#netText").textContent=(busy?"Updating… ":"")+(online?(u.net.online==null?"checking":`Online${link?" · "+link:""}`):"Offline")+(u.auto?" · auto":"");
}
const INTERVALS=[[6,"6 h"],[12,"12 h"],[24,"daily"],[72,"3 days"],[168,"weekly"],[336,"2 weeks"],[720,"monthly"]];
S.views.data = async (v) => {
  if(S.remote){ v.innerHTML='<p class="status">Data &amp; updates stays on Cody\'s PC.</p>'; return; }
  let settings={creds:{},states:""}, layers={layers:[],fetches:[]};
  try{ [settings, layers]=await Promise.all([api("/api/settings"), api("/api/layers")]); UPD=await api("/api/update/status"); }catch(e){}
  const c=navigator.connection||{};
  v.innerHTML=`
  <div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Connection</h3><div id="netCard"></div>
      <p class="hint">Browser reports: ${navigator.onLine?"online":"offline"}${c.type?` · ${esc(c.type)}`:""}${c.effectiveType?` · ${esc(c.effectiveType)}`:""}${c.downlink?` · ~${c.downlink} Mb/s`:""}${c.saveData?" · data saver on":""}</p>
      <button id="netCheck">Check now</button></div>
    <div class="panel"><h3>Automatic updates</h3>
      <div class="row" style="align-items:center"><label class="switch"><input type="checkbox" id="uAuto" ${UPD?.auto?"checked":""}><span></span></label><b>Auto-update enabled sources when online</b></div>
      <div class="row" style="align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap"><b>Update over</b>
        <div class="seg" id="uLinks">${[["all","All"],["wifi","Wi-Fi"],["ethernet","Ethernet"],["cellular","Cellular / phone tether"]].map(([k,l])=>`<button data-link="${k}">${l}</button>`).join("")}</div></div>
      <p class="hint" id="uLinkNow" style="margin:4px 0 0"></p>
      <div class="row" style="margin-top:10px"><button id="uAllOn">Select all sources</button><button id="uAllOff">Select none</button><button class="primary" id="uRunAll">Update all selected now</button></div>
      <label style="margin-top:10px">Limit FCC data to states (blank = whole US)<input id="uStates" value="${esc(settings.states||"")}" placeholder="VA,MD,DC"></label>
      <p class="hint">Checks every 10 minutes; each source runs when its interval has passed and the FCC file has actually changed. Selected sources run in parallel. Crowd sources refresh for the active mission's area${S.mission?` (${esc(S.mission.name)})`:""} and any mission set to keep them refreshed.</p></div>
  </div>
  <div class="panel"><h3>Phone app: field packs</h3>
    <p class="hint" style="margin-top:0">A field pack is one area's FCC licences, towers, broadcast, NOAA and FAA for the RF Recon phone app, which works with no signal.
      Packs are saved in <span class="mono" id="fpDir"></span>, so anyone the Drive folder is shared with can load them. Phone app: <a id="fpUrl" target="_blank" rel="noopener"></a></p>
    <div class="row"><label class="grow">States<input id="fpStates" placeholder="VA,MD,DC" value="${esc(settings.states||"")}"></label>
      <label class="grow">Name (optional)<input id="fpName" placeholder="e.g. Northern Virginia"></label></div>
    <div class="row" style="margin-top:8px"><button class="primary" id="fpMake">Make a pack for these states</button><button id="fpPin">Make a pack around the pin</button><span class="hint" id="fpMsg"></span></div>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Pack</th><th>Size</th><th>Made</th></tr></thead><tbody id="fpList"></tbody></table></div>
    <p class="hint">Packs carry public data only: never your missions, captures, labels or keys, and none of the crowd layers or the Signal ID Wiki catalog. VA, MD and DC together come to about 5 MB.</p></div>
  <div class="panel"><h3>Remote access: this full version from anywhere</h3>
    <p class="hint" style="margin-top:0">People you add open the link in any browser, sign in, and can view and search everything here, but change nothing. Your keys, update settings, TAK settings and the Signal ID Wiki catalog stay on this PC. The link works while this PC is on and RF Recon is running, and what they look at runs over this PC's connection.</p>
    <div id="raLink"><p class="hint">Checking Tailscale…</p></div>
    <div class="row" style="margin-top:8px;align-items:end"><label class="grow">Add a person<input id="raName" placeholder="Their name, e.g. Josh" autocomplete="off"></label><button class="primary" id="raAdd">Add and make a password</button></div>
    <p class="hint" id="raMsg" style="margin:6px 0 0"></p>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Person</th><th>Added</th><th>Last here</th><th></th></tr></thead><tbody id="raList"></tbody></table></div></div>
  <div class="panel"><h3>Push to ATAK</h3>
    <p class="hint" style="margin-top:0">📡 Push to ATAK (beside the exports) sends what's on the map as live markers. They go to every ATAK, iTAK and WinTAK on this PC's networks over the TAK multicast those apps listen on out of the box, and to your TAK Server if you set one. Pushing again updates the same markers; they fade a day after the last push. Anyone on the same network with a TAK app sees them.</p>
    <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><label class="inl"><input type="checkbox" id="tkMc"> Network multicast</label>
      <label class="inl">Group <input id="tkGroup" placeholder="239.2.3.1:6969" style="width:150px"></label>
      <label class="inl">TAK Server (plain TCP) <input id="tkServer" placeholder="host:8087 (optional)" style="width:180px"></label>
      <button class="primary" id="tkSave">Save</button><span class="hint" id="tkMsg"></span></div></div>
  <div class="panel"><h3>Look up an FCC ID</h3>
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><input id="fiQ" placeholder="BCG-E2430, or a grantee code like BCG" style="width:280px"><button class="primary" id="fiGo">Look up</button><span class="hint" id="fiMsg">The FCC's equipment authorization records: who holds the grant, when, and for what. On the PC.</span></div>
    <div id="fiOut" style="margin-top:8px"></div></div>
  <div class="panel"><h3>Data sources</h3><div id="srcList"></div></div>
  <div class="panel"><h3>Other open and crowd sources</h3><div id="srcCatalog"><p class="hint">Loading…</p></div></div>
  <div class="grid2">
    <div class="panel"><h3>Your API keys (stored only in your local database)</h3>
      <div class="row"><label class="grow">WiGLE API name<input id="k_wn" placeholder="${esc(settings.creds.wigle_name||"AID…")}"></label><label class="grow">WiGLE API token<input id="k_wt" type="password" placeholder="${esc(settings.creds.wigle_token||"")}"></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">OpenCelliD key<input id="k_oc" type="password" placeholder="${esc(settings.creds.opencellid_key||"")}"></label><label class="grow">aisstream key (ships)<input id="k_ais" type="password" placeholder="${esc(settings.creds.aisstream_key||"")}"></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">RepeaterBook token<input id="k_rb" type="password" placeholder="${esc(settings.creds.repeaterbook_token||"rbuapp_…")}"></label></div>
      <div class="row" style="margin-top:8px"><button class="primary" id="k_save">Save keys</button><span class="hint" id="k_msg"></span></div>
      <p class="hint">All four are free and need your own account (each sign-up has its own terms, so RF Recon can't make them for you):
        <a href="https://wigle.net/register" target="_blank" rel="noopener">WiGLE</a> (then Account → API token: the name and the token; non-commercial use only),
        <a href="https://my.opencellid.org/register" target="_blank" rel="noopener">OpenCelliD</a> (the access token on your account page; 1,000 requests a day; CC BY-SA 4.0),
        <a href="https://aisstream.io/authenticate" target="_blank" rel="noopener">aisstream</a> (sign in, then API Keys: live ships for the Ships layer),
        <a href="https://www.repeaterbook.com/api/token_request.php" target="_blank" rel="noopener">RepeaterBook</a> (a token on request and approval; personal use, and its policy discourages tools that mix it with other sources).
        RadioReference's API isn't here: it needs Premium ($30 a year) and a paid licence for dashboards.</p></div>
    <div class="panel"><h3>Fetch crowd data for the current pin now</h3>
      <div class="row" style="flex-wrap:wrap"><button data-fetch="wigle">WiGLE</button><button data-fetch="opencellid">OpenCelliD</button><button data-fetch="repeaterbook">RepeaterBook</button>
        <button data-fetch="ttn">LoRaWAN gateways</button><button data-fetch="satnogs">SatNOGS stations</button><button data-fetch="wspr">WSPR</button><button data-fetch="pskreporter">PSKReporter</button></div>
      <p class="hint" style="margin:4px 0 0">An area already fetched recently isn't downloaded again; the same emitter from several sources shows once on the map, with each source's data.</p>
      <div id="fetchMsg" class="hint" style="margin-top:6px"></div>
      <h3 style="margin-top:14px">Import your own layer</h3>
      <div class="row"><label class="grow">Layer name<input id="cl_name" value="My layer"></label><input type="file" id="cl_file" accept=".csv,.kml,.kmz,.geojson,.json,.gpx"></div>
      <h3 style="margin-top:14px">Import labels (RadioReference-style CSV)</h3>
      <div class="row"><input type="file" id="lb_file" accept=".csv"><span class="hint">Frequency, License, Tone, Alpha Tag, Description, Mode, Tag</span></div>
      <div id="impMsg" class="hint" style="margin-top:6px"></div></div>
  </div>
  <div class="panel"><h3>Crowd / imported layers on this computer</h3>
    <div class="tw"><table><thead><tr><th>Source</th><th>Layer</th><th>Points</th><th>Last fetched</th></tr></thead><tbody>${layers.layers.map(l=>`<tr><td>${esc(l.source)}</td><td>${esc(l.layer)}</td><td class="n">${l.n.toLocaleString()}</td><td class="mono">${esc(l.fetched||"")}</td></tr>`).join("")||'<tr><td colspan="4" class="hint">None yet.</td></tr>'}</tbody></table></div>
    <p class="hint">Map tiles are cached as you view them, so areas you looked at before a trip keep working offline.</p></div>`;
  paintSources();
  const fiRun=async()=>{ const q=$("#fiQ").value.trim(); if(!q) return; $("#fiMsg").textContent="Asking the FCC…"; $("#fiOut").innerHTML="";
    try{ const r=await api(`/api/fccid?q=${encodeURIComponent(q)}`); $("#fiMsg").innerHTML=`${r.count.toLocaleString()} grant${r.count===1?"":"s"} for ${esc(r.query)}. Frequencies, power and test reports: the FCC's <a href="${esc(r.search_form)}" target="_blank" rel="noopener">search form ↗</a> or each grant's view.`;
      $("#fiOut").innerHTML=r.results.length?`<div class="tw" style="max-height:320px"><table><thead><tr><th>FCC ID</th><th>Grantee</th><th>Granted</th><th>Purpose</th><th>Address</th><th></th></tr></thead><tbody>${r.results.map(x=>`<tr><td class="mono">${esc(x.fcc_id)}</td><td>${esc(x.grantee)}</td><td class="mono">${esc(x.grant_date)}</td><td>${esc(x.purpose)}</td><td class="hint">${esc(x.address)}</td><td>${x.view?`<a href="${esc(x.view)}" target="_blank" rel="noopener">view ↗</a>`:""}</td></tr>`).join("")}</tbody></table></div><p class="hint">“view” opens fccid.io, a third-party viewer of the FCC's public records.</p>`:'<p class="hint">No grants match.</p>'; }
    catch(e){ $("#fiMsg").textContent=e.message; } };
  $("#fiGo").onclick=fiRun; $("#fiQ").onkeydown=e=>{ if(e.key==="Enter") fiRun(); };
  api("/api/tak/settings").then(t=>{ $("#tkMc").checked=t.multicast!==false; $("#tkGroup").value=t.group||""; $("#tkGroup").placeholder=t.default_group; $("#tkServer").value=t.server||""; }).catch(()=>{});
  $("#tkSave").onclick=async()=>{ try{ await post("/api/tak/settings",{multicast:$("#tkMc").checked, group:$("#tkGroup").value, server:$("#tkServer").value}); $("#tkMsg").textContent="Saved."; }
    catch(e){ $("#tkMsg").textContent=e.message; } };
  const fpPaint=async()=>{ if(!$("#fpList")) return; const f=await api("/api/fieldpacks"), j=f.job;
    $("#fpDir").textContent=f.folder; $("#fpUrl").href=f.phone_url; $("#fpUrl").textContent=f.phone_url;
    $("#fpList").innerHTML=f.packs.map(p=>`<tr><td>${esc(p.file)}</td><td class="n">${p.mb} MB</td><td class="mono">${esc(p.made)}</td></tr>`).join("")||'<tr><td colspan="3" class="hint">None yet.</td></tr>';
    $("#fpMsg").textContent=j.running?(j.log[j.log.length-1]||"Starting…"):j.error?`Error: ${j.error}`:j.result?`Done: ${j.result.name}, ${j.result.mb} MB, ${j.result.counts.licences.toLocaleString()} licences.${j.result.big?" That's large for a phone: a pack around the pin keeps it smaller.":""}`:"";
    $("#fpMake").disabled=$("#fpPin").disabled=j.running;
    if(j.running) setTimeout(fpPaint,1000); };
  $("#fpMake").onclick=async()=>{ await post("/api/fieldpack",{states:$("#fpStates").value,name:$("#fpName").value}); fpPaint(); };
  $("#fpPin").onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ $("#fpMsg").textContent="Drop a pin first."; return; }
    await post("/api/fieldpack",{lat:p[0],lon:p[1],radius:+$("#radius").value||5,name:$("#fpName").value}); fpPaint(); };
  fpPaint();
  // remote access (remote.py): the Tailscale Funnel link, and the people who can sign in at it
  const raPaint=async()=>{ if(!$("#raList")) return; let r; try{ r=await api("/api/remote"); }catch(e){ $("#raLink").innerHTML=`<p class="hint">${esc(e.message)}</p>`; return; }
    const L=r.link||{};
    $("#raLink").innerHTML=!L.installed?'<p class="hint">Tailscale isn\'t installed on this PC: it carries the link.</p>'
      :L.state!=="Running"?`<p class="hint">Tailscale is ${esc({NeedsLogin:"signed out",NeedsMachineAuth:"waiting for approval",Stopped:"stopped",Starting:"starting"}[L.state]||"not running")} on this PC. Sign in to Tailscale (system tray) to get the link.</p>`
      :`<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><b>Link</b><span class="mono">${esc(L.url||"")}</span><span class="tag">${L.on?"On":"Off"}</span>
         ${L.on?'<button id="raCopy">Copy link</button>':""}<button id="raToggle">${L.on?"Turn the link off":"Turn the link on"}</button></div>`;
    $("#raList").innerHTML=r.people.map(u=>`<tr><td>${esc(u.name)}</td><td class="mono">${esc(u.added||"")}</td><td class="mono">${esc(u.last||"not yet")}</td>
      <td style="text-align:right;white-space:nowrap"><button data-ranew="${esc(u.name)}">New password</button> <button data-rarm="${esc(u.name)}">Remove</button></td></tr>`).join("")
      ||'<tr><td colspan="4" class="hint">No one yet. Add a person to give them a sign-in.</td></tr>';
    if($("#raCopy")) $("#raCopy").onclick=async()=>{ try{ await navigator.clipboard.writeText(L.url); $("#raMsg").textContent="Link copied."; }catch(e){ $("#raMsg").textContent=L.url; } };
    if($("#raToggle")) $("#raToggle").onclick=async()=>{ $("#raMsg").textContent=L.on?"Turning the link off…":"Turning the link on…";
      try{ await post("/api/remote/link",{on:!L.on}); $("#raMsg").textContent=""; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); };
    $("#raList").querySelectorAll("[data-ranew]").forEach(b=>b.onclick=()=>raAdd(b.dataset.ranew));
    $("#raList").querySelectorAll("[data-rarm]").forEach(b=>b.onclick=async()=>{  // two presses, so a stray click doesn't lock someone out
      if(b.dataset.sure!=="1"){ b.dataset.sure="1"; b.textContent="Press again to remove"; setTimeout(()=>{ if(b.isConnected){ b.dataset.sure=""; b.textContent="Remove"; } },4000); return; }
      try{ await post("/api/remote/remove",{name:b.dataset.rarm}); $("#raMsg").textContent=`${b.dataset.rarm} can't sign in any more.`; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); }); };
  const raAdd=async name=>{ name=(name||"").trim(); if(!name){ $("#raMsg").textContent="Type their name first."; return; }
    try{ const r=await post("/api/remote/add",{name}); $("#raName").value="";
      $("#raMsg").innerHTML=`Password for <b>${esc(r.name)}</b>: <span class="mono" style="user-select:all;font-size:15px">${esc(r.password)}</span> · Shown only now: send it to them with the link. Their old password, if any, no longer works.`; raPaint(); }
    catch(e){ $("#raMsg").textContent=e.message; } };
  $("#raAdd").onclick=()=>raAdd($("#raName").value); $("#raName").onkeydown=e=>{ if(e.key==="Enter") raAdd($("#raName").value); };
  raPaint();
  $("#netCheck").onclick=async()=>{ $("#netCard").innerHTML='<p class="hint">Checking…</p>'; UPD=await post("/api/net/hint?check=1",{type:c.type||null,effectiveType:c.effectiveType||null}); paintNet(); paintSources(); };
  const cfg=async body=>{ UPD=await post("/api/update/config",body); paintNet(); paintSources(); };
  $("#uAuto").onchange=e=>cfg({auto:e.target.checked});
  // which connections updates may use: pick any mix; All is all three; one always stays on
  $("#uLinks").onclick=e=>{ const b=e.target.closest("[data-link]"); if(!b) return; const k=b.dataset.link, ALL=["wifi","ethernet","cellular"];
    let cur=new Set(UPD?.links||["wifi","ethernet"]);
    if(k==="all") cur=new Set(ALL); else { cur.has(k)?cur.delete(k):cur.add(k); if(!cur.size) cur.add(k); }
    cfg({links:ALL.filter(x=>cur.has(x))}); };
  $("#uAllOn").onclick=()=>cfg({all:true}); $("#uAllOff").onclick=()=>cfg({all:false});
  $("#uRunAll").onclick=async()=>{ UPD=await post("/api/update/run",{ids:"enabled",force:true}); paintNet(); paintSources(); };
  $("#uStates").onchange=e=>post("/api/settings",{states:e.target.value.toUpperCase().replace(/\s/g,"")});
  $("#k_save").onclick=async()=>{ await post("/api/settings",{creds:{wigle_name:$("#k_wn").value,wigle_token:$("#k_wt").value,opencellid_key:$("#k_oc").value,aisstream_key:$("#k_ais").value,repeaterbook_token:$("#k_rb").value}}); $("#k_msg").textContent="Saved."; };
  v.querySelectorAll("[data-fetch]").forEach(b=>b.onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ $("#fetchMsg").textContent="Drop a pin first."; return; }
    $("#fetchMsg").textContent=`Fetching ${b.dataset.fetch}…`;
    try{ const r=await post("/api/crowd/fetch",{source:b.dataset.fetch,lat:p[0],lon:p[1],radius:+$("#radius").value||5,state:S.mission?.state||S.rows.find(x=>x.state)?.state});
      $("#fetchMsg").textContent=r.skipped?`${b.dataset.fetch}: ${r.skipped}.`:`${b.dataset.fetch}: ${r.rows} points saved. Re-running search…`; if(!r.skipped) runSearch(); }catch(e){ $("#fetchMsg").textContent=`${b.dataset.fetch}: ${e.message}`; } });
  $("#cl_file").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const r=await api(`/api/layers/import?layer=${encodeURIComponent($("#cl_name").value)}&filename=${encodeURIComponent(f.name)}`,{method:"POST",body:await f.arrayBuffer()});
    $("#impMsg").textContent=`Layer “${$("#cl_name").value}”: ${r.rows} points.`; if(parseLoc($("#loc").value)) runSearch(); }catch(err){ $("#impMsg").textContent="Error: "+err.message; } };
  $("#lb_file").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const r=await api(`/api/overlay/import?state=${encodeURIComponent($("#state").value||"")}&county=${encodeURIComponent($("#county").value||"")}`,{method:"POST",body:await f.text()});
    $("#impMsg").textContent=`Imported ${r.imported} labels.`; if(S.rows.length) runSearch(); }catch(err){ $("#impMsg").textContent="Error: "+err.message; } };
};
// How old a source's data is (green fresh, amber due, red never) and when the next automatic check comes
const ago=h=>h<1?`${Math.round(h*60)} min`:h<48?`${Math.round(h)} h`:`${Math.round(h/24)} days`;
function freshness(s, auto){
  const t=s.last_updated?Date.parse(s.last_updated.replace(" ","T")):NaN;
  if(isNaN(t)) return '<b style="color:var(--bad)">no data yet</b>';
  const age=(Date.now()-t)/36e5, due=age>=+s.interval_h, chk=s.last_checked?Date.parse(s.last_checked.replace(" ","T")):t;
  const next=(chk+(+s.interval_h)*36e5-Date.now())/36e5;
  return `<b style="color:${due?"var(--warn)":"var(--good)"}">${ago(age)} old</b>${s.enabled&&auto?(next>0?` · next check in ${ago(next)}`:" · check due now"):" · manual"}`;
}
function paintSources(){
  const u=UPD; if(!u||!$("#srcList")) return;
  const n=u.net, link={wifi:"Wi-Fi",cellular:"Cellular",ethernet:"Ethernet",vpn:"VPN",unknown:"unknown link"}[u.link]||u.link;
  if($("#netCard")) $("#netCard").innerHTML=`<div class="row" style="align-items:center"><span class="led ${n.online?"on":n.online===false?"off":""}" style="width:14px;height:14px"></span><b>${n.online?"Online":n.online===false?"Offline":"Not checked yet"}</b> · ${esc(link)}${n.interface?` (${esc(n.interface)})`:""}${n.latency_ms!=null?` · ${n.latency_ms} ms to FCC`:""}</div><p class="hint">Last checked ${esc(n.checked||"–")} · ${esc(n.os||"")}</p>`;
  const acc=a=>!a||!a.key?"":a.needs_key?`${a.key_saved?'<span style="color:var(--good)">✓ key saved</span>':'<span style="color:var(--bad)">✗ no key saved</span>'} · ${esc(a.key)} · ${esc(a.cost||"")}${a.signup?` · <a href="${esc(a.signup)}" target="_blank" rel="noopener">get a key ↗</a>`:""}`
    :`${esc(a.cost||"")}${a.key==="none"?" · no key needed":""}`;
  $("#srcList").innerHTML=Object.entries(u.sources).map(([id,s])=>`<div class="srcrow">
    <label class="switch"><input type="checkbox" data-src="${esc(id)}" ${s.enabled?"checked":""}><span></span></label>
    <div><b>${esc(s.label)}</b><div class="hint">${esc(s.description)}</div>
      ${s.access?.key?`<div class="hint" title="${esc(s.access.terms||"")}">${acc(s.access)}</div>`:""}
      ${s.why?`<div class="hint" style="color:${/^Downloading/.test(s.why)?"var(--good)":"var(--warn)"}">${esc(s.why)}</div>`:""}</div>
    <select data-int="${esc(id)}" class="hide-m">${INTERVALS.map(([h,l])=>`<option value="${h}" ${+s.interval_h===h?"selected":""}>${l}</option>`).join("")}</select>
    <div class="hide-m" style="font-size:12px">${s.running?'<span class="tag w">running</span> ':""}${s.state==="error"?'<span class="tag" style="color:var(--bad)">error</span> ':s.state==="ok"?'<span class="tag v">ok</span> ':""}${esc(s.message||"")}
      <div class="hint">${freshness(s, u.auto)} · updated ${esc(s.last_updated||"never")}${s.remote?` · source file ${esc(s.remote)}`:""}${s.rows!=null?` · ${Number(s.rows).toLocaleString()} rows`:""}</div></div>
    <button data-run="${esc(id)}" ${s.running?"disabled":""}>Run now</button></div>`).join("");
  $$("[data-src]").forEach(x=>x.onchange=async()=>{ UPD=await post("/api/update/config",{sources:{[x.dataset.src]:{enabled:x.checked}}}); paintSources(); });
  if($("#uLinks")){ const on=new Set(u.links||[]), nm={wifi:"Wi-Fi",ethernet:"Ethernet",cellular:"cellular / phone tether"};
    $$("#uLinks [data-link]").forEach(b=>b.classList.toggle("on", b.dataset.link==="all"?on.size===3:on.has(b.dataset.link)));
    const now=u.link==="vpn"||u.link==="unknown"?"ethernet":u.link;
    $("#uLinkNow").innerHTML=`This PC is on <b>${esc(nm[now]||u.link||"?")}</b> now: updates ${on.has(now)?'<span style="color:var(--good)">can run</span>':'<span style="color:var(--warn)">wait for '+[...on].map(k=>nm[k]).join(" or ")+"</span>"}.`; }
  const cat=$("#srcCatalog");
  if(cat && u.catalog) cat.innerHTML=`<div class="tw"><table><thead><tr><th>Source</th><th>What it gives</th><th>Key</th><th>Cost</th><th>Area search</th><th>Terms</th><th>In RF Recon</th></tr></thead><tbody>${
    u.catalog.map(c=>`<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b> ↗</a></td><td>${esc(c.what)}</td><td>${esc(c.key)}${c.signup?` · <a href="${esc(c.signup)}" target="_blank" rel="noopener">sign up ↗</a>`:""}</td>
      <td>${esc(c.cost)}</td><td>${esc(c.area)}</td><td class="hint">${esc(c.terms)}</td><td>${esc(c.status)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">Checked on each provider's own pages on 2026-10-28. “Could add” means its terms and API allow it; say which to wire in. Sign-ups need your own account: RF Recon never makes one for you.</p>`;
  $$("[data-int]").forEach(x=>x.onchange=async()=>{ UPD=await post("/api/update/config",{sources:{[x.dataset.int]:{interval_h:+x.value}}}); paintSources(); });
  $$("[data-run]").forEach(x=>x.onclick=async()=>{ UPD=await post("/api/update/run",{ids:[x.dataset.run],force:true}); paintNet(); paintSources(); });
}
