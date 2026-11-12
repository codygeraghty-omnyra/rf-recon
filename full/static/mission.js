"use strict";
/* DAStastic — missions (setup + live settings), captures, field log, data sources & auto-update. */

const BAND_LABELS=["VHF Low","6m","72-76 MHz","Aviation VHF","VHF High","VHF TV/Aux","220 MHz","Gov UHF/Other","UHF","UHF T-Band","UHF TV/Aux","700 MHz","800 MHz","900 MHz","L-band/1-2 GHz","2-6 GHz","Microwave >6 GHz"];
const STATUSES=["Planning","Active","Paused","Complete"];

async function loadMission(id, applyArea){
  if(!id){ S.mission=null; S.missionId=null; $("#missionName").textContent="No mission"; if(window.RFMarkup) RFMarkup.refresh(); return; }
  const m=await api("/api/missions/"+id); S.mission=m; S.missionId=m.id; if(window.RFMarkup) RFMarkup.refresh();  // the maps show this mission's drawings
  try{ const t=await api(`/api/missions/${id}/tracks`); S.mission.tracks=t.tracks; }catch(e){ /* no tracks for this mission yet: the map draws none */ }
  $("#missionName").textContent=`${m.name} · ${m.status}`;
  const lay=m.settings.layers||{}; S.layerSolo=S.layerPrev=null; S.layerOn=new Set(Object.keys(LAYERS).filter(k=>lay[k]!==false && !((k==="uls_hist"||k==="boosters")&&!lay[k])));  // history and boosters: only when ticked
  S.layerDef=new Set(S.layerOn);  // the mission's sources are its defaults: the filter rail's Clear comes back to them
  $("#hideMobile").checked=m.settings.fixed_sites_only!==false;
  if(applyArea && m.lat!=null){ setMode("point"); $("#loc").value=`${m.lat}, ${m.lon}`; $("#radius").value=m.radius_mi||5; $("#radiusSlider").value=m.radius_mi||5; }
}
window.missionBoot = async () => {
  // signed in through the remote door (remote.py): view and full logins are "remote" (no Data & updates, no keys);
  // an admin login (the server's owner) gets everything, plus a Sign out button
  try{ const me=await api("/api/me"); S.me=me.remote?me:null; S.remote=me.remote&&me.role!=="admin"?me:null; window.phoneBoot&&phoneBoot(me); }catch(e){ S.remote=null; S.me=null; }
  if(S.remote){
    document.body.classList.add("remote"); if(S.tab==="data") setTab("map");
    $("#netLed").className="led on"; $("#netText").textContent=`${S.remote.role==="full"?"Signed in":"View only"} · ${S.remote.user}`;
    $("#netChip").title=`Signed in to ${S.remote.server?"DAStastic":"Cody's DAStastic"}. Press for your account: change your password or sign out.`;
    $("#netChip").onclick=()=>openAccount(S.remote);
  } else if(S.me){
    const b=document.createElement("button"); b.className="hbtn"; b.id="meOut"; b.textContent=`Admin · ${S.me.user}`;
    b.title="Your account: change your password or sign out"; b.onclick=()=>openAccount(S.me); $("#netChip").after(b);
  }
  if((S.remote||S.me)?.server) watchBuild();
  try{ const r=await api("/api/missions"); if(r.active) { await loadMission(r.active, true); if(parseLoc($("#loc").value)) runSearch(); } }catch(e){ /* no active mission, or the server is starting: the app opens without one */ }
  if(!S.remote){ netHint(); pollStatus(); setInterval(pollStatus, 15000);
    api("/api/kit").then(k=>{ if(!k.update) return;  // a kit copy with a newer kit out: say so in the header
      const b=document.createElement("button"); b.className="hbtn"; b.id="kitChip"; b.title="A newer DAStastic is out: Data & updates installs it";
      b.innerHTML='<span class="led busy"></span>Update available'; b.onclick=()=>setTab("data"); $("#netChip").after(b); }).catch(()=>{}); }
};
$("#missionChip").onclick=()=>setTab("mission");
$("#netChip").onclick=()=>setTab("data");

// Updates on the server (Cody 11/7 item 7): a tab left open keeps the code it loaded. Every 10 minutes it asks which build the
// server runs; when that changed, a chip says so with Reload, and with Update by itself on (Your account; the default) it
// reloads on its own the next time you leave the tab, so never in the middle of something.
function watchBuild(){
  let first=null, shown=false;
  const autoOn=()=>{ try{ return localStorage.getItem("rfr.autoUpdate")!=="0"; }catch(e){ return true; } };
  const tick=async()=>{ let b; try{ b=await api("/api/build"); }catch(e){ return; }
    if(!b||!b.commit) return; if(first===null){ first=b.commit; return; }
    if(b.commit===first||shown) return; shown=true;
    const c=document.createElement("button"); c.className="hbtn"; c.id="updChip"; c.title=`DAStastic was updated on the server (build ${b.commit}). Reload to use it.`;
    c.innerHTML='<span class="led busy"></span>Updated · Reload'; c.onclick=()=>location.reload(); $("#netChip").after(c);
    document.addEventListener("visibilitychange",()=>{ if(document.hidden&&autoOn()) location.reload(); }); };  // the choice as it is when you leave
  tick(); setInterval(tick, 600000);
}

// a line under the mission form, once the (async) view has drawn it; gives up after 3 s (the user left the tab)
function missionSay(t, tries=30){ const m=$("#mMsg"); if(m) m.textContent=t; else if(tries>0) setTimeout(()=>missionSay(t, tries-1), 100); }

/* ---------- mission view ---------- */
// the mission log: settings logged as JSON before 11/4 read in words, and a setting that only went from not set to off
// (a default written down) is left out, as the server now does
function missionLogRows(log){
  const word = s => s === "null" ? "not set" : s === "true" ? "on" : s === "false" ? "off" : s;
  return (log||[]).flatMap(l => { if(l.kind !== "setting") return [l];
    const m = /^(.*?): (null|true|false|"[^"]*"|-?[\d.]+|\[\]|\{\}) → (null|true|false|"[^"]*"|-?[\d.]+|\[\]|\{\})$/.exec(l.detail||"");
    if(!m) return [l];
    if(m[2] === "null" && ["false", '""', "[]", "{}"].includes(m[3])) return [];
    return [{...l, detail: `${m[1]}: ${word(m[2])} → ${word(m[3])}`}]; });
}

S.views.mission = async (v) => {
  // drawn again on itself (a filter, the theme, a stop saved elsewhere), the page stays as it was until the list is in: the
  // one-line "Loading missions…" emptied it, so the page jumped and its maps went off it for the wait (review 11/11)
  if(!v.querySelector("#mNew")) v.innerHTML='<p class="status">Loading missions…</p>';
  const gen=S.viewGen;
  const list=await api("/api/missions");
  if(gen!==S.viewGen) return;  // you moved on while it loaded
  const m=S.mission, s=m?.settings||{};
  if(!m){ window.RFMaps?.drop("hunt"); window.RFMaps?.drop("mtools"); }  // no mission open: its maps go (they stayed, detached)
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
      <p class="hint">WiGLE / Kismet (wiglecsv) · GPX tracks · rtl_power / hackrf_sweep CSV · analyzer CSV (lat, lon, freq, dBm…, or time, freq, dBm with no coordinates) · KML / KMZ. Import timed GPS tracks first (GPX, KML gx:Track, a WiGLE file); later files without coordinates are placed from them by time, within ${esc(String(m.settings?.track_match_s??30))} s. A KML line (LineString) has no times, so it can't place them.</p>
      <div class="row"><input type="file" id="capFiles" multiple accept=".csv,.txt,.gpx,.kml,.kmz">
        <label class="inl"><input type="checkbox" id="capFixed"> Place un-positioned points at the mission pin</label></div>
      <div class="row" style="margin-top:6px" title="What took these captures. A calibrated instrument's levels grade A; uncalibrated levels are relative only and grade C.">
        <input id="capRx" placeholder="Receiver (e.g. Anritsu S412E, RTL-SDR)" class="grow">
        <label class="inl"><input type="checkbox" id="capCal"> Calibrated</label><input id="capCalDate" type="date" title="Calibration date"></div>
      <div id="capResult" class="hint" style="margin-top:6px">${S.capNote?.mid===m?.id?S.capNote.html:""}</div>
      <div class="tw" style="margin-top:8px;max-height:260px"><table><thead><tr><th>Capture</th><th>Format</th><th>Points</th><th>Track</th><th>Imported</th><th>Receiver</th><th></th></tr></thead><tbody>
        ${m.captures.map(c=>`<tr><td>${esc(c.name)}</td><td>${esc(c.fmt)}</td><td class="n">${c.points}</td><td class="n">${c.track_points}</td><td class="mono">${esc((c.imported_at||"").slice(0,16))}</td><td>${c.receiver?esc(c.receiver):'<span class="hint">not recorded</span>'}${c.calibrated===1?` <span class="tag" title="Calibrated${c.cal_date?" "+esc(c.cal_date):""}">cal</span>`:""} <button data-rxcap="${c.id}" title="Set the receiver and calibration">✎</button></td><td><button class="danger" data-delcap="${c.id}">✕</button></td></tr>`).join("")||'<tr><td colspan="7" class="hint">No captures yet.</td></tr>'}</tbody></table></div></div>
    <div class="panel"><h3>Field log — quick entry</h3>
      <div class="row"><label>Lat<input id="fl_lat" type="number" step="any" style="width:110px"></label><label>Lon<input id="fl_lon" type="number" step="any" style="width:110px"></label>
        <button id="fl_gps">◎ GPS</button><button id="fl_pin">Use pin</button></div>
      <div class="row" style="margin-top:6px"><label>Freq MHz<input id="fl_freq" type="number" step="any" style="width:110px"></label><label>dBm<input id="fl_dbm" type="number" step="any" style="width:80px"></label>
        <label title="The direction the signal came from, in degrees from true north (a DF antenna or a hand bearing): lines of bearing cross where it is">Bearing °<input id="fl_brg" type="number" min="0" max="360" step="any" placeholder="optional" style="width:90px"></label>
        <label>Type<select id="fl_type"><option value="">Auto-identify</option>${Object.keys(S.lib).map(t=>`<option>${esc(t)}</option>`).join("")}</select></label></div>
      <div class="row" style="margin-top:6px"><label class="grow">Label / notes<input id="fl_notes" placeholder="e.g. dispatch, NAC 293, heard from parking lot"></label><button class="primary" id="fl_log">Log</button></div>
      <div id="fl_res" class="hint" style="margin-top:6px"></div>
      <h3 style="margin-top:14px">Mission log</h3>
      <div class="row"><input id="ml_note" class="grow" placeholder="Add a note…"><button id="ml_add">Add</button></div>
      <div class="log" style="margin-top:6px">${missionLogRows(m.log).map(l=>`<div><span class="mono hint">${esc(l.ts)}</span> <span class="tag">${esc(l.kind)}</span> ${esc(l.detail)}</div>`).join("")}</div>
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
        // a header press sorts every signal in that list by its column (rfsort.js), then the first 150 show; cols[2]: a column's value
        const sorted=(id,rows,cols)=>rfSort.data(id, rows, [s=>s.freq_mhz??s.ident??"", s=>s.sig_type||"", s=>s.label||"", ...cols.map(c=>c[2]), s=>s.first||""]);
        const table=(rows,cols,id)=>rows.length?`<div class="tw" style="max-height:320px"><table id="${id}"><thead><tr><th>Signal</th><th>Type</th><th>Label / ID</th>${cols.map(c=>`<th>${c[0]}</th>`).join("")}<th>Seen</th></tr></thead><tbody>${sorted(id,rows,cols).slice(0,150).map(s=>`<tr><td>${sig(s)}</td><td>${esc(s.sig_type||"")}</td><td>${esc(s.label||"")}</td>${cols.map(c=>`<td class="n">${c[1](s)}</td>`).join("")}<td class="mono hint">${esc((s.first||"").slice(0,16))}${s.last&&s.last!==s.first?` → ${esc(s.last.slice(11,16))}`:""}</td></tr>`).join("")}</tbody></table></div>${rows.length>150?`<p class="hint">First 150 of ${rows.length}.</p>`:""}`:'<p class="hint">None.</p>';
        const draw=()=>{ out.innerHTML=`<p><b>${esc(c.b.name)}</b> (${c.b.signals.toLocaleString()} signals) against <b>${esc(c.a.name)}</b> (${c.a.signals.toLocaleString()}):
          <b style="color:var(--bad)">${c.new.length} new</b>, <b>${c.gone.length} gone</b>, <b style="color:var(--warn)">${c.changed.length} changed by ${c.delta_db} dB or more</b>, ${c.same} the same.
          <span class="hint">Signals match by MAC or cell ID where there is one, else by 6.25 kHz channel and type.</span></p>
          <h3>New since the baseline</h3>${table(c.new,[["Strongest dBm",s=>num(s.max_dbm,0),s=>s.max_dbm],["Readings",s=>s.n,s=>s.n]],"cmpNew")}
          <h3>Gone (in the baseline, not now)</h3>${table(c.gone,[["Strongest dBm then",s=>num(s.max_dbm,0),s=>s.max_dbm],["Readings",s=>s.n,s=>s.n]],"cmpGone")}
          <h3>Changed level</h3>${table(c.changed,[["Before",s=>num(s.before_dbm,0),s=>s.before_dbm],["Now",s=>num(s.max_dbm,0),s=>s.max_dbm],["Change dB",s=>`<b style="color:${s.delta_db>0?"var(--bad)":"var(--good)"}">${s.delta_db>0?"+":""}${s.delta_db}</b>`,s=>s.delta_db]],"cmpChanged")}`; };
        draw(); for(const id of ["cmpNew","cmpGone","cmpChanged"]) rfSort.own(id, ()=>{ if(out.isConnected) draw(); });
      }catch(e){ out.innerHTML=`<p class="status err">${esc(e.message)}</p>`; }
    };
    if(window.missionHunt) window.missionHunt(v, m);  // Find a signal, at the top (hunt.js)
    if(window.missionTools) window.missionTools(v, m);  // replay, when heard, lines of bearing (missiontools.js)
  }
  // list
  v.querySelectorAll("[data-mid]").forEach(el=>el.onclick=async()=>{ S.missionEdit=null; await post(`/api/missions/${el.dataset.mid}/activate`); await loadMission(+el.dataset.mid,true); render(); if(parseLoc($("#loc").value)) runSearch(); });
  $("#mNew").onclick=()=>{ S.missionEdit="new"; render(); };
  if($("#mCancel")) $("#mCancel").onclick=()=>{ S.missionEdit=null; render(); };
  if($("#mGo")) $("#mGo").onclick=()=>{ loadMission(S.missionId,true).then(()=>{ setTab("map"); runSearch(); }); };
  if($("#mDel")) $("#mDel").onclick=async()=>{ if(!confirm(`Delete mission “${m.name}” with its captures, observations and log?`)) return; await post(`/api/missions/${m.id}/delete`);
    // its maps and their kept views go with it: the next new mission can get the same id (review 11/11: it opened on the
    // deleted one's place and never fitted), and its Replay and bearing settings
    for(const k of ["hunt", "mtools:replay", "mtools:bearing"]) window.RFMaps?.forget(`${k}:${m.id}`);
    if(S.mt?.mid === m.id) S.mt = null;
    await loadMission(null); render(); };
  $("#m_usePin").onclick=()=>{ const p=parseLoc($("#loc").value); if(p){ $("#m_lat").value=p[0]; $("#m_lon").value=p[1]; $("#m_radius").value=$("#radius").value; } };
  v.querySelectorAll("[data-mt],[data-mb]").forEach(c=>c.onclick=()=>c.classList.toggle("on"));
  $("#m_addWatch").onclick=()=>$("#m_watch").insertAdjacentHTML("beforeend",watchRow({}));
  $("#m_watch").onclick=e=>{ if(e.target.matches("[data-rmw]")) e.target.closest(".row").remove(); };
  if($("#m_applyTargets")) $("#m_applyTargets").onclick=()=>{ setOnly("type", s.target_types||[]); setOnly("band", s.target_bands||[]); setTab("map"); };
  $("#mSave").onclick=async()=>{
    const watch=[...$$("#m_watch .row")].map(r=>({freq:parseFloat(r.querySelector("[data-w=freq]").value),tol_khz:parseFloat(r.querySelector("[data-w=tol]").value)||12.5,label:r.querySelector("[data-w=label]").value})).filter(w=>w.freq);
    const layers={}; v.querySelectorAll("[data-ml]").forEach(x=>layers[x.dataset.ml]=x.checked);
    const nn=id=>$(id).value===""?null:+$(id).value;
    const d={name:$("#m_name").value||"Untitled mission", status:$("#m_status").value, operator:$("#m_operator").value, start_date:$("#m_start").value, end_date:$("#m_end").value,
      objective:$("#m_obj").value, lat:nn("#m_lat"), lon:nn("#m_lon"), radius_mi:nn("#m_radius")||5, state:$("#m_state").value.toUpperCase(),
      settings:{target_types:[...v.querySelectorAll("[data-mt].on")].map(x=>x.dataset.mt), target_bands:[...v.querySelectorAll("[data-mb].on")].map(x=>x.dataset.mb), watch, layers,
        fixed_sites_only:$("#m_fixed").checked, auto_refresh_crowd:$("#m_autocrowd").checked, gps_max_accuracy_m:nn("#m_gps"), min_dbm:nn("#m_mindbm"),
        sweep_threshold_db:nn("#m_sweep")??10, track_match_s:nn("#m_track")??30, heat_size:+$("#m_hsize").value, heat_metric:$("#m_hmetric").value, heat_combine:$("#m_hcomb").value, heat_alpha:+$("#m_halpha").value}};
    // one press, one mission: a double click made two (11/3); the button comes back if the save fails
    if($("#mSave").disabled) return; $("#mSave").disabled=true;
    try{
      const res = editing==="new" ? await post("/api/missions", d) : await post(`/api/missions/${m.id}`, d);
      if(editing==="new") await post(`/api/missions/${res.id}/activate`);
      S.missionEdit=null; await loadMission(res.id, editing==="new"); render();
      // search first: the view redraws on its own time, so #mMsg isn't there yet; writing to it threw and the search
      // never ran, leaving every tab on the old area under the new mission's name (11/3)
      const said=editing==="new"?"Mission created and set active.":"Saved — changes logged.";
      const search=(editing==="new" && parseLoc($("#loc").value)) || S.rows.length ? runSearch() : null;
      Promise.resolve(search).catch(()=>{}).then(()=>missionSay(said));  // after the search's redraw, which would wipe it
    }catch(e){ missionSay("Error: "+e.message); if($("#mSave")) $("#mSave").disabled=false; }
  };
  if(!m||editing==="new") return;
  // the import's progress and summary live in S.capNote, so a re-render (the search that follows, a tab change) keeps them
  const capNote=html=>{ S.capNote={mid:m.id, html}; const el=$("#capResult"); if(el) el.innerHTML=html; };
  $("#capFiles").onchange=async e=>{ const files=[...e.target.files].sort((a,b)=>(/\.gpx$/i.test(b.name)?1:0)-(/\.gpx$/i.test(a.name)?1:0)); const out=[];
    const fixed=$("#capFixed").checked;  // read once: the tab may be gone before the last file is in
    const rx=new URLSearchParams({receiver:$("#capRx").value.trim(), calibrated:$("#capCal").checked?"1":($("#capRx").value.trim()?"0":""), cal_date:$("#capCalDate").value});
    for(const [k,v] of [...rx]) if(!v) rx.delete(k);
    for(const f of files){ capNote([...out, `Importing ${esc(f.name)}…`].join("<br>"));
      try{ const r=await api(`/api/captures/import?mission=${m.id}&filename=${encodeURIComponent(f.name)}${fixed?"&fixed=1":""}${rx.size?"&"+rx:""}`,{method:"POST",body:await f.arrayBuffer()});
        out.push(`<b>${esc(f.name)}</b> (${esc(r.format)}): ${r.points} points, ${r.track_points} track points${r.positioned_from_track?`, ${r.positioned_from_track} positioned from GPS track`:""}${r.dropped_accuracy?`, ${r.dropped_accuracy} dropped for GPS error`:""}${r.dropped_below_min_dbm?`, ${r.dropped_below_min_dbm} below min dBm`:""}${r.dropped_no_position?`, ${r.dropped_no_position} without position`:""} — ${Object.entries(r.types).map(([k,n])=>`${esc(k)} ${n}`).join(", ")}`); }
      catch(err){ out.push(`<b>${esc(f.name)}</b>: <span style="color:var(--bad)">${esc(err.message)}</span>`); } }
    capNote(out.join("<br>")); await loadMission(m.id); render(); if(S.rows.length||parseLoc($("#loc").value)) runSearch(); };
  v.querySelectorAll("[data-rxcap]").forEach(b=>b.onclick=async()=>{ const c=m.captures.find(x=>String(x.id)===b.dataset.rxcap)||{};
    const model=prompt("Receiver that took this capture (model):", c.receiver||""); if(model===null) return;
    const cal=confirm("Was it calibrated? OK = calibrated, Cancel = not calibrated");
    const date=cal?prompt("Calibration date (YYYY-MM-DD), or leave empty:", c.cal_date||""):"";
    await post(`/api/captures/${c.id}/receiver`, {receiver:model, calibrated:cal?1:0, cal_date:date||""}); await loadMission(m.id); render(); });
  v.querySelectorAll("[data-delcap]").forEach(b=>b.onclick=async()=>{ if(!confirm("Delete this capture?")) return; await post(`/api/captures/${b.dataset.delcap}/delete`); await loadMission(m.id); render(); });
  $("#fl_gps").onclick=()=>navigator.geolocation&&navigator.geolocation.getCurrentPosition(p=>{ $("#fl_lat").value=p.coords.latitude.toFixed(6); $("#fl_lon").value=p.coords.longitude.toFixed(6); $("#fl_lat").dataset.acc=p.coords.accuracy; },
    err=>{ $("#fl_res").textContent="GPS unavailable: "+err.message; },{enableHighAccuracy:true});
  // the pin has no GPS accuracy: an earlier ◎ GPS press's must not ride along with it
  $("#fl_pin").onclick=()=>{ const p=parseLoc($("#loc").value)||[m.lat,m.lon]; $("#fl_lat").value=p[0]; $("#fl_lon").value=p[1]; delete $("#fl_lat").dataset.acc; };
  $("#fl_lat").oninput=$("#fl_lon").oninput=()=>{ delete $("#fl_lat").dataset.acc; };  // typed by hand: no GPS accuracy either
  $("#fl_log").onclick=async()=>{ const d={mission_id:m.id, lat:+$("#fl_lat").value, lon:+$("#fl_lon").value, acc:+($("#fl_lat").dataset.acc||0)||null, freq_mhz:$("#fl_freq").value, dbm:$("#fl_dbm").value===""?null:+$("#fl_dbm").value,
      type:$("#fl_type").value||null, label:$("#fl_notes").value, notes:$("#fl_notes").value, bearing:$("#fl_brg").value===""?null:+$("#fl_brg").value};
    if(!$("#fl_lat").value){ $("#fl_res").textContent="Set a position (GPS or pin) first."; return; }
    try{ const r=await post("/api/fieldlog", d); $("#fl_res").innerHTML=`Logged — identified as <b>${esc(r.classification.sig_type)}</b> (${esc(r.classification.basis)})`
        +(r.sigwiki?.length?`<br>Could also be: ${r.sigwiki.map(c=>`<a href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.why.join(" · "))}">${esc(c.title)}</a>`
            +(c.media?.audio?` <a href="${esc(c.media.audio)}" target="_blank" rel="noopener" title="Hear it (Artemis)">🔊</a>`:"")+(c.media?.image?` <a href="${esc(c.media.image)}" target="_blank" rel="noopener" title="Its waterfall (Artemis)">▦</a>`:"")).join(", ")} <span class="hint">(Signal ID Wiki)</span>`:"");
      $("#fl_freq").value=""; $("#fl_dbm").value=""; $("#fl_notes").value=""; }
    catch(e){ $("#fl_res").textContent="Error: "+e.message; } };
  $("#ml_add").onclick=async()=>{ if(!$("#ml_note").value) return; await post(`/api/missions/${m.id}/note`,{text:$("#ml_note").value}); await loadMission(m.id); render(); };
  const mp=()=>{ const p=new URLSearchParams({lat:m.lat,lon:m.lon,radius:m.radius_mi||5,mission:m.id,layers:"captures,uls,towers"}); return p; };
  $("#mx_kml").onclick=()=>getFile("/api/export.kml?"+mp()); $("#mx_csv").onclick=()=>getFile("/api/export.csv?"+mp());
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
// the keys DAStastic can use (sealed outside the database, keystore.py); a field's third value is its hint, or "text" for a name
const API_KEYS=[
  {id:"wigle", name:"WiGLE", what:"Wi-Fi, Bluetooth and cell points near the pin", src:"wigle", get:"https://wigle.net/account",
   fields:[["wigle_name","API name","text"],["wigle_token","API token","32 characters"]], how:"Account → API token: the name and the token. Non-commercial use only."},
  {id:"opencellid", name:"OpenCelliD", what:"cell towers for the map and Cell sites", src:"opencellid", get:"https://my.opencellid.org/dashboard",
   fields:[["opencellid_key","Access token","pk.…"]], how:"The access token on your account page. 1,000 requests a day; CC BY-SA 4.0."},
  {id:"apidatagov", name:"api.data.gov", what:"the FCC rules watch: new filings in the dockets that change DAS work", src:"fcc_rules", get:"https://api.data.gov/signup/",
   fields:[["api_data_gov_key","API key","40 characters"]], how:"Sign up with your name and email; the key comes by email at once. Free."},
  {id:"aisstream", name:"aisstream", what:"live ships (the Ships map overlay)", get:"https://aisstream.io/apikeys",
   fields:[["aisstream_key","API key","40 characters"]], how:"Sign in, then API Keys. Ships stream only while the overlay is on."},
  {id:"mouser", name:"Mouser", what:"online prices, stock and lead times for DAS parts (Materials, Quotes)", src:"part_prices", get:"https://www.mouser.com/api-hub/",
   fields:[["mouser_key","Search API key","36 characters"]], how:"Sign in at mouser.com, API Hub, Search API: the key it gives. Free."},
  {id:"digikey", name:"Digi-Key", what:"online prices, stock and lead times for DAS parts (Materials, Quotes)", src:"part_prices", get:"https://developer.digikey.com/",
   fields:[["digikey_id","Client ID","text"],["digikey_secret","Client secret","from your app"]], how:"developer.digikey.com: make an organization and a production app with Product Information v4; its Client ID and secret. Free."},
  {id:"element14", name:"Newark (element14)", what:"online prices, stock and lead times for DAS parts (Materials, Quotes), shown live only", src:"part_prices", get:"https://partner.element14.com/",
   fields:[["element14_key","API key","24 characters"]], how:"Register at partner.element14.com and apply for a Product Search API key. Free. Their terms: no database and nothing kept past 48 hours, so DAStastic shows its prices live and drops them after a day."},
  {id:"arrow", name:"Arrow", what:"online prices, stock and lead times for DAS parts (Materials, Quotes), shown live only", src:"part_prices", get:"https://developers.arrow.com/api/index.php/site/page?view=requestAPIKey",
   fields:[["arrow_login","Login","your Arrow login name"],["arrow_key","API key","from Arrow's email"]], how:"Request a Pricing & Availability key on developers.arrow.com (name, company, website, intended use: buying parts). Free. Their terms: nothing kept past 48 hours and no data service, so DAStastic shows its prices live and drops them after a day."},
  {id:"shippo", name:"Shippo", what:"shipping estimates on DAS supplier quotes (UPS, FedEx, USPS rates from each supplier to the job)", get:"https://portal.goshippo.com/api-config/api",
   fields:[["shippo_token","API token","shippo_live_… or shippo_test_…"]], how:"Make a free Shippo account, then Settings, API (or the API portal, Developer keys). A test token works at once, for trying it; a live token, for real prices, is approved by Shippo first. Rate quotes create no label and cost nothing."},
  {id:"fccbdc", name:"FCC Broadband Map", what:"carrier coverage (the Carrier coverage layer and the DAS cellular pre-survey)", src:"bdc", get:"https://broadbandmap.fcc.gov/manage-api-access",
   fields:[["fcc_bdc_username","FCC sign-in email","text"],["fcc_bdc_token","API token","from Manage API Access"]],
   how:"Sign in at broadbandmap.fcc.gov, then Manage API Access → Generate. The FCC's API terms apply."},
];
const keySaved=(settings,k)=>k.fields.every(([f])=>settings.creds[f]);
// What the DAS tab takes from each update source (Data & updates marks them; the DAS tab's Data & links updates them),
// and from the services it uses live. Checked against the code 11/2: the pre-survey (das.presurvey), cell sites
// (cells.py), carrier coverage (bdc.at), donor terrain and building outlines.
const DAS_USES={"uls:LMpriv":"the pre-survey's public safety, business and government systems",
  "uls:LMcomm":"the pre-survey's commercial and SMR trunked systems",
  "uls_daily":"the pre-survey's licences and donor towers the day after they change, and its pending public safety applications",
  "asr":"donor site heights and owners, and the tower each cell site sits on",
  "bdc":"the cellular pre-survey's carriers at the building",
  "opencellid":"the cell sites near the building (cellular pre-survey)",
  "wigle":"the cell sites near the building (cellular pre-survey)"};
const DAS_LIVE={"Terrain Tiles on AWS (Tilezen)":"donor paths and terrain around a job, kept for no signal",
  "Overpass API (OpenStreetMap)":"a job's building outline, floors and height"};
const dasNote=why=>`<div class="hint dasnote"><span class="tag das">DAS</span> ${esc(why)}</div>`;
const CROWD_FETCH=[["wigle","WiGLE","wigle"],["opencellid","OpenCelliD","opencellid"],["ttn","LoRaWAN gateways"],["satnogs","SatNOGS stations"],["wspr","WSPR"],["pskreporter","PSKReporter"]];
const INTERVALS=[[1,"hourly"],[6,"6 h"],[12,"12 h"],[24,"daily"],[72,"3 days"],[168,"weekly"],[336,"2 weeks"],[720,"monthly"],[2160,"90 days"]];
// a source's own interval when the list hasn't it: a select with none marked shows its first, so osm_towers' 90 days read "6 h" (review 11/10)
const intervalsFor=h=>INTERVALS.some(([x])=>x===+h)?INTERVALS:[...INTERVALS,[+h,+h<48?`${+h} h`:`${Math.round(+h/24)} days`]].sort((a,b)=>a[0]-b[0]);
// Ways in: every way people get this version or its data, which build each runs, and whether it needs Cody's PC on.
// The remote link's row (#wayRemote), the two site links (#wayWeb, #wayLite) and the Version column ([data-ver]) are
// filled in live (/api/versions: this copy's build, the published site's, the newest kit; Android's is the one written
// down). The panel shows on a copy with the remote door, and on the server for the admin; team logins never see it.
const WAYS=[
  ["24/7 server","The main DAStastic, always on. The admin login sees every source; team logins see the sold build (no WiGLE, RepeaterBook, WSPR, Signal ID Wiki, Artemis or ships). The whole-US FCC data, carrier coverage, crowd data for the mission areas, and the team's DAS jobs and notes live here","Yes, 24/7 on AWS ($24 a month)",'<a href="https://44-207-142-90.sslip.io/" target="_blank" rel="noopener">44-207-142-90.sslip.io ↗</a>; installs as an app',"","server"],
  ["Cody's PC","A second full copy for working with no signal: its own data and DAS jobs, separate from the server's","No","localhost:8765; starts with Windows","","pc"],
  ["DAStastic for Android","The server in a full-screen app on an Android phone (Android 10 or newer). The DAS walk test reads the phone's own LTE / 5G signal, and corrects it against a calibrated instrument","Yes: it opens the server",'<a href="#help-android" data-help="android">Help › Android app</a> (the download opens signed out), or Drive › RF Recon › install kit',"","android"],
  ["Remote link","Cody's PC copy, live, for people signed in: a backup way in now the server is up","No: it runs on Cody's PC and its connection",'<span id="wayRemote">Checking…</span>',"wayRemoteRow","pc"],
  ["Full web version","Nearly every tab in any browser. Each state's FCC data loads from the DAStastic site; each person's work stays in their browser","Yes, 24/7 on GitHub's servers",'<a id="wayWeb" target="_blank" rel="noopener">The web version ↗</a>',"","site"],
  ["DAStastic lite","The phone app: one area's data kept on the phone, for no signal","Yes",'<a id="wayLite" target="_blank" rel="noopener">The phone app ↗</a>',"","site"],
  ["Field packs","One area's public data in a file, for the web version or DAStastic lite","Yes. On the server only the admin login makes and downloads them","Phone app: field packs, below","",""],
  ["Install kit","Their own copy on their own Windows PC; it downloads its own FCC data","Yes","This copy of DAStastic, below; install kit in the Drive folder","","kit"],
  ["Drive folder","The docs and the install kit, and Cody's PC copy's field packs, backups and notes (its code left Drive on 11/3)","Yes","Google Drive › DAStastic, for the people it's shared with","",""],
  ["Exports","CSV, KML and ATAK data packages of what's on the map","Yes, once made","The export buttons beside the results","",""],
  ["Push to ATAK","Live markers in ATAK, iTAK and WinTAK: from Cody's PC to TAK apps on its networks; from either copy to your TAK Server. On the server only the admin login pushes","Yes, from the server to a TAK Server (admin login)","Push to ATAK, below","",""],
];
// the Version column: what each way runs, read live (never written down, but Android's)
function waysVersions(){
  api("/api/versions").then(x=>{
    const put=(k,html)=>$$(`#waysPanel [data-ver="${k}"]`).forEach(td=>{ td.innerHTML=html; });
    const v=b=>b?`<span class="mono">${esc(b.commit)}</span>${b.changed?' <span class="hint">and changes not committed</span>':""}${b.date?`<div class="hint">${esc(b.date)}${b.how==="deployed"?" deployed":""}</div>`:""}`:'<span class="hint">not readable</span>';
    put(x.server?"server":"pc", v(x.this));
    put(x.server?"pc":"server", `<span class="hint">${x.server?"Read on Cody's PC (its Data &amp; updates)":"Read on the server, signed in as admin"}</span>`);
    put("site", x.site?`<span class="mono">${esc(x.site.build)}</span>${x.site.date?`<div class="hint">published ${esc(x.site.date)}</div>`:""}`:'<span class="hint">offline: not checked</span>');
    put("kit", x.kit?`<span class="mono">${esc(x.kit.version)}</span>${x.kit.built?`<div class="hint">built ${esc(x.kit.built)}</div>`:""}`:'<span class="hint">offline: not checked</span>');
    put("android", `<span class="mono">${esc(x.android)}</span>`);
  }).catch(()=>$$("#waysPanel [data-ver]").forEach(td=>{ if(td.dataset.ver) td.innerHTML='<span class="hint">not readable</span>'; }));
}
// Item 16 (Cody 11/7: "Data & Updates tab"): what needs the admin here, each key's standing, and how WiGLE gets here.
const REFUSED=/\b40[13]\b|unauthori[sz]ed|forbidden|refused|invalid (api )?key/i;
const pullAge=p=>p&&p.last_pc?(Date.now()-Date.parse(p.last_pc.replace(" ","T")))/3600000:Infinity;  // hours since the PC brought points
function pullLine(p){
  return `WiGLE refuses this server's address, so Cody's PC fetches it with its own key, every 15 minutes while it's on, and the points stay here: `
    +`${p.waiting?`${p.waiting} area${p.waiting===1?"":"s"} waiting`:"nothing waiting"}, last brought ${esc(p.last_pc||"never")}.`;
}
const NY={pull:null, people:null};  // what Needs you was drawn with, so paintSources can redraw it after a switch
// The Data desk (desk.py, Cody 11/8): each step a person must do for a source, with the link and the steps; Done makes the
// desk try the source again, and the task closes only when the source answers. Below it, every source as it stands.
const DESK={v:null};
const DESK_STATE={fresh:"var(--good)", stale:"var(--warn)", failed:"var(--bad)", "needs a key":"var(--warn)", "never fetched":"var(--warn)", off:"inherit"};
// the FCC rules watch (fccrules.py): filings the FCC put out in the last 30 days in the dockets that change DAS work
function rulesPanel(rv){
  if(!rv) return '<div id="rulesPanel"></div>';
  const f=rv.filings||[];
  return `<div class="panel" id="rulesPanel"><h3>FCC rules watch <span class="hint">· new filings in the last ${rv.days} days, in ${Object.keys(rv.dockets||{}).length} dockets</span></h3>
    ${f.length?`<div class="tw" style="max-height:320px"><table><thead><tr><th>Date</th><th>Docket</th><th>Type</th><th>Filed by</th><th>Document</th></tr></thead><tbody>${f.map(x=>`<tr><td>${esc(x.disseminated)}</td><td title="${esc(x.about)}">${esc(x.docket)}<div class="hint">${esc(x.about)}</div></td><td>${esc(x.type)}</td><td>${esc(x.filers)}</td><td>${x.link?`<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title||"the filing")} ↗</a>`:esc(x.title)}</td></tr>`).join("")}</tbody></table></div>`
      :'<p class="hint" style="margin:0">Nothing new in the last 30 days, or the watch hasn\'t run yet (it needs your api.data.gov key).</p>'}
    <p class="hint" style="margin:6px 0 0">${esc(rv.attribution||"")}</p></div>`;
}
function deskPanel(dv){
  DESK.v=dv; if(!dv) return '<div id="deskPanel"></div>';  // a place to fill when the desk answers
  const tasks=dv.tasks||[], rows=dv.sources||[], c=dv.counts||{};
  const kind={key:"a key", "sign-up":"a sign-up", form:"a form", permission:"a permission", paid:"paid access", refused:"a refusal"};
  const task=t=>`<li class="desk-t" data-task="${t.id}" style="margin:0 0 10px;overflow-wrap:anywhere"><b>${esc(t.source_name)}</b> · needs ${esc(kind[t.kind]||t.kind)} · for ${esc(t.who)}
      ${t.status==="done"?`<span class="tag">done ${esc((t.done_at||"").slice(5,16).replace("T"," "))}: trying the source again</span>`:""}${t.seen>1?` <span class="hint">· seen ${t.seen} times</span>`:""}
    <div>${esc(t.why||"")}${t.detail?` <span class="hint">(${esc(t.detail)})</span>`:""}</div>
    ${t.link?`<div><a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.link)}</a></div>`:""}
    ${(t.steps||[]).length?`<ol style="margin:4px 0 4px 18px;padding:0">${t.steps.map(s=>`<li>${esc(s)}</li>`).join("")}</ol>`:""}
    ${t.enter||t.key_goes?`<div class="hint">${t.enter?`Enter: ${esc(t.enter)}. `:""}${t.key_goes?`It goes in: ${esc(t.key_goes)}.`:""}</div>`:""}
    ${t.last_test_result&&t.status==="open"?`<div class="status err">Tried again ${esc((t.last_test||"").slice(5,16).replace("T"," "))}: ${esc(t.last_test_result)}</div>`:""}
    <div class="row" style="gap:6px;margin-top:4px">${t.status==="open"?`<button class="sm primary" data-desk="done">Done</button>`:""}<button class="sm" data-desk="wontdo">Won't do</button></div></li>`;
  const row=w=>`<tr><td>${esc(w.name)}</td><td><b style="color:${DESK_STATE[w.state]||"inherit"}">${esc(w.state)}</b></td><td>${w.last_good?esc(w.last_good.replace("T"," ")):"never"}</td>
    <td>${w.cadence_h?`every ${w.cadence_h>=48?Math.round(w.cadence_h/24)+" days":w.cadence_h+" h"}`:""}</td><td>${esc(w.route)} · ${esc(w.access)}</td><td>${esc(w.owner)}</td>
    <td class="hint">${esc(w.message||w.why||"")}</td></tr>`;
  return `<div class="panel" id="deskPanel"><h3>Needs a person <span class="hint">· the Data desk: what a person has to do for a source to download</span></h3>
    ${tasks.length?`<ul style="margin:6px 0 0 18px;padding:0">${tasks.map(task).join("")}</ul>`
      :'<p class="hint" style="margin:0">Nothing: no source is waiting on a key, a sign-up, a form or a permission, and none was refused.</p>'}
    ${(dv.problems||[]).length?`<p class="status err" style="margin:6px 0 0">Registry: ${dv.problems.map(esc).join("; ")}</p>`:""}
    <details style="margin-top:8px"><summary class="hint" style="cursor:pointer">Every source, watched: ${["fresh","stale","failed","needs a key","never fetched","off"].filter(k=>c[k]).map(k=>`${c[k]} ${k}`).join(", ")||"none"}</summary>
      <div class="tw" style="margin-top:6px"><table><thead><tr><th>Source</th><th>State</th><th>Last good</th><th>Fetched</th><th>Route · access</th><th>Owner</th><th>Why</th></tr></thead>
      <tbody>${rows.map(row).join("")}</tbody></table></div></details></div>`;
}
function wireDesk(){
  const p=$("#deskPanel"); if(!p) return;
  p.onclick=async e=>{ const b=e.target.closest("[data-desk]"); if(!b) return;
    const li=b.closest("[data-task]"), act=b.dataset.desk;
    let why=""; if(act==="wontdo"){ why=prompt("Why won't it be done? (it stays on record)", ""); if(why===null) return; }
    b.disabled=true;
    try{ const dv=await post(`/api/update/desk/task/${li.dataset.task}`, {action:act, why});
      $("#deskPanel").outerHTML=deskPanel(dv); wireDesk(); const ny=$("#needsYou"); if(ny) ny.outerHTML=needsYou(NY.pull, NY.people); }
    catch(err){ b.disabled=false; alert(err.message); } };
}
function needsYou(pull, people){
  NY.pull=pull; NY.people=people;
  const u=UPD; if(!u) return "";
  const out=[];
  // item 8 (Cody 11/7: "let me know when Andy, Josh or Josh sign in"): a first Google sign-in in the last week
  const news=((people&&people.people)||[]).filter(p=>p.google_first&&(Date.now()-Date.parse(p.google_first.replace(" ","T")))<7*864e5)
    .map(p=>`<b>${esc(p.name)}</b> signed in with Google for the first time, ${esc(p.google_first)}.`);
  for(const [id,s] of Object.entries(u.sources||{})){
    if(!s.enabled || (id==="wigle" && pull)) continue;  // WiGLE through the PC: its own line below
    if(s.access?.needs_key && !s.access.key_saved) out.push(`<b>${esc(s.label)}</b> is on but has no key: add it under Your API keys, or turn it off.`);
    // a failed run sits in "failed" with the state idle again (11/8: a failure there never showed)
    else if(s.state==="error"||s.failed) out.push(`<b>${esc(s.label)}</b>: the last run failed${s.message?`: ${esc(s.message)}`:""}.`);
  }
  if(pull && pull.waiting && pullAge(pull)>24)
    out.push(`<b>WiGLE</b>: ${pull.waiting} area${pull.waiting===1?"":"s"} waiting for Cody's PC, which ${pull.last_pc?`last brought points ${esc(pull.last_pc)}`:"hasn't brought any yet"}. It fetches every 15 minutes while it's on.`);
  const dt=(DESK.v?.tasks||[]).filter(t=>t.status==="open").length;
  if(dt) out.push(`<b>${dt} data source${dt===1?"":"s"}</b> need${dt===1?"s":""} a person: see Needs a person, below.`);
  return `<div class="panel" id="needsYou"><h3>Needs you here</h3>${out.length?`<ul style="margin:4px 0 0 18px;padding:0">${out.map(x=>`<li>${x}</li>`).join("")}</ul>`
    :'<p class="hint" style="margin:0">Nothing: every source that\'s on has its key and its last run went through.</p>'}${news.length?`<p class="hint" style="margin:8px 0 0">New: ${news.join(" ")}</p>`:""}</div>`;
}
S.views.data = async (v) => {
  if(S.remote){ v.innerHTML=`<p class="status">${S.remote.server?"Data &amp; updates is for the admin login.":"Data &amp; updates stays on Cody's PC."}</p>`; return; }
  let settings={creds:{},states:""}, layers={layers:[],fetches:[]};
  const gen=S.viewGen;
  try{ [settings, layers]=await Promise.all([api("/api/settings"), api("/api/layers")]); UPD=await api("/api/update/status"); }catch(e){ /* a view login or offline: the panels below say what they couldn't read */ }
  let pull=null; try{ pull=await api("/api/crowd/pull/status"); }catch(e){ /* a copy without the PC fetcher's queue: no line for it */ }
  let people=null; try{ people=await api("/api/remote"); }catch(e){ /* not the admin, or no remote door: no sign-in news */ }
  // where each DAS job's files are kept: here since 11/8, not across the top of the DAS board (UX review 11/8 #15)
  let dasDir=S.das?.folder??null; if(dasDir==null) try{ dasDir=(await api("/api/das/jobs")).folder??null; }catch(e){ /* no DAS jobs on this copy: the panel says it couldn't read the folder */ }
  // the desk is drawn as it was last time and filled in when it answers: the tab doesn't wait for it (11/8, a slower tab fails)
  if(gen!==S.viewGen) return;  // you moved on while it loaded
  const c=navigator.connection||{};
  v.innerHTML=`${needsYou(pull, people)}${deskPanel(DESK.v)}${rulesPanel(null)}
  <div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Connection</h3><div id="netCard"></div>
      <p class="hint">Browser reports: ${navigator.onLine?"online":"offline"}${c.type?` · ${esc(c.type)}`:""}${c.effectiveType?` · ${esc(c.effectiveType)}`:""}${c.downlink?` · ~${c.downlink} Mb/s`:""}${c.saveData?" · data saver on":""}</p>
      <button id="netCheck">Check now</button></div>
    <div class="panel"><h3>Automatic updates</h3>
      <div class="row" style="align-items:center"><label class="switch"><input type="checkbox" id="uAuto" ${UPD?.auto?"checked":""}><span></span></label><b>Auto-update enabled sources when online</b></div>
      <div class="row" style="align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap"><b>Update over</b>
        <div class="seg" id="uLinks">${[["all","All"],["wifi","Wi-Fi"],["ethernet","Ethernet"],["cellular","Cellular / phone tether"]].map(([k,l])=>`<button data-link="${k}">${l}</button>`).join("")}</div></div>
      <p class="hint" id="uLinkNow" style="margin:4px 0 0"></p>
      <div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="primary" id="uUpdAll" title="${S.me?.server?"The server downloads every source now, whether or not it's selected. Each one takes only what's newer, and a source with no key saved is left out.":"Every source now, selected or not. Each one takes only what's newer."}">⟳ ${S.me?.server?"Pull everything to the server":"Update all"}</button><button id="uStop" title="Stop every download now: the files being fetched stop, nothing new starts, automatic updates included, until you resume">■ Stop all downloads</button><button id="uRunAll">Update all selected now</button><button id="uAllOn">Select all sources</button><button id="uAllOff">Select none</button></div>
      <p class="status" id="uStopMsg" style="margin:6px 0 0;display:none"></p>
      <p class="hint" id="uUpdMsg" style="margin:4px 0 0">Update all checks every source below now, selected or not, and downloads only what's newer. Sources whose key isn't saved are left out.</p>
      <label style="margin-top:10px">Limit FCC data to states (blank = whole US)<input id="uStates" value="${esc(settings.states||"")}" placeholder="VA,MD,DC"></label>
      ${dasNote("the pre-survey reads the FCC licences and towers kept for these states")}
      <label style="margin-top:8px">Carrier coverage states (FCC Broadband Map: about 100 MB to 2 GB of download a state)<input id="uBdcStates" value="${esc(settings.bdc_states||"")}" placeholder="SC,NC,MN"></label>
      ${dasNote("the cellular pre-survey shows carriers only for buildings in these states")}
      <p class="hint">Checks every 10 minutes; each source runs when its interval has passed and the FCC file has actually changed. Selected sources run in parallel. Crowd sources refresh for the active mission's area${S.mission?` (${esc(S.mission.name)})`:""} and any mission set to keep them refreshed.</p></div>
  </div>
  <div class="panel" id="waysPanel" hidden><h3>Ways in: who can use this version and its data</h3>
    <style>@media (max-width:700px){ /* a phone: each way is a card, its facts labelled, instead of a five-column table */
      #waysPanel thead{display:none} #waysPanel tr{display:block;padding:9px 10px;border-bottom:1px solid var(--line)}
      #waysPanel td{display:block;border:0;padding:2px 0;white-space:normal} #waysPanel td[data-ver=""]{display:none}
      #waysPanel td[data-lbl]::before{content:attr(data-lbl) ": ";color:var(--dim)} }</style>
    <div class="tw wrap"><table><thead><tr><th>Way</th><th>What they get</th><th>Version</th><th>With Cody's PC off</th><th>Where</th></tr></thead><tbody>${
      WAYS.map(([w,what,off,where,id,ver])=>`<tr${id?` id="${id}"`:""}><td><b>${w}</b></td><td>${what}</td><td data-ver="${ver}" data-lbl="Version">${ver?'<span class="hint">Checking…</span>':""}</td><td data-lbl="With Cody's PC off">${off}</td><td data-lbl="Where">${where}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">DAStastic lives on the 24/7 server (AWS Lightsail, since 11/2): the FCC database and its downloads, the crowd data, the keys it uses and the team's DAS jobs are there. Team logins get the sold build (no WiGLE, Signal ID Wiki, Artemis, ships, RepeaterBook or WSPR).
      Cody's PC keeps its own copy for work with no signal. The two don't sync: a DAS job made on one isn't on the other.</p></div>
  <div class="panel"><h3>This copy of DAStastic</h3><div id="kitBody"><p class="hint">Checking…</p></div></div>
  <div class="panel" id="dasDirPanel"><h3>DAS job files</h3><p class="hint" style="margin:0">${(dasDir||"").startsWith("/rfr/") ? "Each DAS job's files are kept in this browser."  /* the web version (web/webhost.py) */
    : S.me ? "Each DAS job's files are kept on the DAStastic server: open them from the job's Files."  /* a signed-in login never sees the server's folders (11/3) */
    : dasDir ? `Each DAS job's files are kept in <span class="mono">${esc(dasDir)}</span>, a folder per job, found by its number if the job is renamed.` : "The DAS jobs folder couldn't be read on this copy."}</p></div>
  <div class="panel"><h3>Phone app: field packs</h3>
    <p class="hint" style="margin-top:0">A field pack is one area's FCC licences, towers, broadcast, NOAA and FAA for DAStastic lite (beta), the phone app, which works with no signal.
      ${S.me?`Packs made here are saved on the DAStastic server, not in Google Drive<span id="fpDir" hidden></span>: download one (⇩ below) to load it on a phone or share it.`  /* a signed-in copy (the 24/7 server): no Drive folder, and no server paths shown (11/3) */
        :`Packs are saved in <span class="mono" id="fpDir"></span>, so anyone the Drive folder is shared with can load them.`} Phone app: <a id="fpUrl" target="_blank" rel="noopener"></a></p>
    <div class="row"><label class="grow">States<input id="fpStates" placeholder="VA,MD,DC" value="${esc(settings.states||"")}"></label>
      <label class="grow">Name (optional)<input id="fpName" placeholder="e.g. Northern Virginia"></label></div>
    <div class="row" style="margin-top:8px"><button class="primary" id="fpMake">Make a pack for these states</button><button id="fpPin">Make a pack around the pin</button><span class="hint" id="fpMsg"></span></div>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Pack</th><th>Size</th><th>Made</th></tr></thead><tbody id="fpList"></tbody></table></div>
    <p class="hint">Packs carry public data only: never your missions, captures, labels or keys, and none of the crowd layers or the Signal ID Wiki catalog. VA, MD and DC together come to about 5 MB.</p></div>
  <div class="panel"><h3>Remote access: this full version from anywhere</h3>
    <p class="hint" id="raHow" style="margin-top:0">People you add open the link in any browser, sign in, and do what their login allows: View only looks and searches; Full also works DAS jobs, missions and notes; Admin also has the keys, updates and people. Your keys, update settings, TAK settings and the Signal ID Wiki catalog stay with the admin. The link works while this PC is on and DAStastic is running, and what they look at runs over this PC's connection.</p>
    <div id="raLink"><p class="hint">Checking Tailscale…</p></div>
    <div class="row" style="margin-top:8px;align-items:end"><label class="grow">Add a person<input id="raName" placeholder="Their name, e.g. Josh" autocomplete="off"></label>
      <label>Can<select id="raRole"><option value="view">View only</option><option value="full">Full: DAS jobs, missions, notes</option><option value="admin">Admin: everything, keys and people too</option><option value="ahj">AHJ reviewer: only the jobs shared with it</option></select></label><label title="For a temporary login (an inspector, someone watching a test): it works through this day, then can't sign in">Last day <span class="hint">(optional)</span><input type="date" id="raEnds"></label><button class="primary" id="raAdd">Add and make a password</button></div>
    <p class="hint" id="raMsg" style="margin:6px 0 0"></p>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Person</th><th>Can</th><th>Added</th><th>Last here</th><th></th></tr></thead><tbody id="raList"></tbody></table></div></div>
  <div class="panel" id="dcPanel" hidden><h3>DAS course: who has it</h3>
    <p class="hint" style="margin-top:0">Tick an account to give it the course. They open it from the DAS tab, and their progress saves to their sign-in. Unticking keeps their progress. Admins start ticked; AHJ reviewer logins can't have it. <span id="dcSum"></span></p>
    <p class="hint" id="dcMsg" style="margin:6px 0 0"></p>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Account</th><th>Has it</th><th>Lessons</th><th>Mastery</th><th>Exams passed</th><th>On lesson</th><th>Last used</th></tr></thead><tbody id="dcList"></tbody></table></div></div>
  <div class="panel" id="sfPanel" hidden><h3>Server files</h3>
    <p class="hint" style="margin-top:0">What the server keeps. Read only: a download is a copy, and nothing here changes a file. Logins, keys and the sign-in secret never show. <span id="sfDisk"></span></p>
    <div class="sf-wrap"><div class="sf-roots" id="sfRoots"></div><div><p class="hint sf-crumb" id="sfCrumb"></p>
      <div class="tw"><table><thead><tr><th>Name</th><th>Size</th><th>Changed</th><th></th></tr></thead><tbody id="sfList"></tbody></table></div><p class="hint" id="sfMsg" style="margin:6px 0 0"></p></div></div></div>
  <div class="panel"><h3>Push to ATAK</h3>
    <p class="hint" style="margin-top:0">📡 Push to ATAK (beside the exports) sends what's on the map as live markers. They go to every ATAK, iTAK and WinTAK on this PC's networks over the TAK multicast those apps listen on out of the box, and to your TAK Server if you set one. Pushing again updates the same markers; they fade a day after the last push. Anyone on the same network with a TAK app sees them.</p>
    <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><label class="inl"><input type="checkbox" id="tkMc"> Network multicast</label>
      <label class="inl">Group <input id="tkGroup" placeholder="239.2.3.1:6969" style="width:150px"></label>
      <label class="inl">TAK Server (plain TCP) <input id="tkServer" placeholder="host:8087 (optional)" style="width:180px"></label>
      <button class="primary" id="tkSave">Save</button><span class="hint" id="tkMsg"></span></div></div>
  <div class="panel"><h3>Look up an FCC ID</h3>
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><input id="fiQ" placeholder="BCG-E2430, or a grantee code like BCG" style="width:280px"><button class="primary" id="fiGo">Look up</button><span class="hint" id="fiMsg">The FCC's equipment authorization records: who holds the grant, when, and for what. On the PC.</span></div>
    <div id="fiOut" style="margin-top:8px"></div>
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><span class="hint" id="fiSrc">Maker names: …</span>
      <label class="inl">Import the FCC's list <input type="file" id="fiImp" accept=".csv,.txt,.tsv,.xlsx,.xls,.xml,.json,.zip,.htm,.html"></label></div>
    <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px"><span class="hint" id="fiGr"></span>
      <label class="inl" title="The file doesn't say what the search was by: a search by Equipment Class fills the booster class">Searched by class
        <select id="fiGrCls"><option value="">no (a maker's code)</option>${[["B9A","Part 90 Class A"],["B9B","Part 90 Class B"],["B2I","Part 20 industrial"],["B2P","Part 20 provider-specific"],["B2W","Part 20 wideband consumer"],["BOS","other booster"]].map(([k,l])=>`<option value="${k}">${k}: ${l}</option>`).join("")}</select></label>
      <label class="inl" title="A search by Power Output (with the class above) fills that class's power range">and power
        <select id="fiGrW"><option value="">no</option>${["0-0.5","0.5-1","1-2","2-5","5-10","10-10000"].map(w=>`<option value="${w}">${w==="10-10000"?"over 10":w} W</option>`).join("")}</select></label>
      <label class="inl">Import FCC grant searches <input type="file" id="fiGrImp" multiple accept=".xml,.xls,.xlsx,.htm,.html,.csv"></label></div>
    ${dasNote("the grant searches imported here are the booster list in the pre-survey (devices granted for the building's bands)")}</div>
  <div class="panel"><h3>Data sources <span class="hint">· <span class="tag das">DAS</span> marks what the DAS tab uses; it also updates them (DAS › Data &amp; links)</span></h3><div id="srcList"></div></div>
  <div class="panel"><h3>Used live as you work <span class="hint">· not on the list above: nothing to download or schedule</span></h3><div id="srcLive"><p class="hint">Loading…</p></div></div>
  <div class="panel"><h3>Other open and crowd sources <span class="hint">· researched</span></h3><div id="srcCatalog"><p class="hint">Loading…</p></div></div>
  <div class="grid2">
    <div class="panel"><h3>Your API keys</h3>
      <p class="hint" style="margin-top:0">Free accounts of your own, sealed for your Windows account on this PC, outside every database file, so no copy, kit or backup carries them. Each sign-up has its own terms, so DAStastic can't make them for you.</p>
      ${API_KEYS.map(k=>{ const saved=keySaved(settings,k), s=k.src&&UPD?.sources?.[k.src];
        const last=s?.state==="error"?` · Last try failed: ${esc(s.message||"")}`:s?.last_updated?` · Last fetch ${esc(s.last_updated)}${s.message?`: ${esc(s.message)}`:""}`:"";
        const viaPc=k.id==="wigle"&&saved&&pull, refused=saved&&!viaPc&&s?.state==="error"&&REFUSED.test(s.message||"");
        // part of a two-box key saved (Cody 11/10: autofill saved a Digi-Key Client ID with no secret, and with no Remove
        // the card couldn't clear it): say so, and offer Remove
        const part=!saved&&k.fields.some(([f])=>settings.creds[f]);
        const stand=!saved?(part?"Part saved":"Not set"):viaPc?"✓ Saved · via Cody's PC":refused?"Saved, refused":"✓ Saved";
        return `<div style="border-top:1px solid var(--line);padding:10px 0 4px">
        <div class="row" style="justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
          <div><b>${esc(k.name)}</b> <span class="tag ${saved&&!refused?"v":""}"${refused?' style="color:var(--bad)"':""}>${stand}</span> <span class="hint">· ${esc(k.what)}</span></div>
          <div class="row" style="gap:12px"><a href="${esc(k.get)}" target="_blank" rel="noopener">${saved?"Your account ↗":"Get a key ↗"}</a>${saved||part?`<a href="#" data-kclear="${k.id}">Remove</a>`:""}</div></div>
        <div class="row" style="margin-top:6px">${k.fields.map(([f,label,ph])=>`<label class="grow">${esc(label)}<input data-cred="${f}" type="${ph==="text"?"text":"password"}" autocomplete="${ph==="text"?"off":"new-password"}" data-lpignore="true" data-1p-ignore
          placeholder="${saved?"saved: type to replace":esc(ph==="text"?"":ph)}"></label>`).join("")}</div>
        <p class="hint" style="margin:4px 0 0">${esc(k.how)}${last}</p>${viaPc?`<p class="hint" style="margin:4px 0 0">${pullLine(pull)}</p>`:""}${DAS_USES[k.src]?dasNote(DAS_USES[k.src]):""}</div>`; }).join("")}
      <div class="row" style="margin-top:10px;align-items:center"><button class="primary" id="k_save">Save keys</button><span class="hint" id="k_msg"></span></div>
      <p class="hint">Not here: RepeaterBook (its policy discourages tools that mix sources) and RadioReference (its API needs Premium, $30 a year, plus a paid licence for dashboards).</p></div>
    <div class="panel"><h3>Fetch crowd data for the current pin now</h3>
      <div class="row" style="flex-wrap:wrap">${CROWD_FETCH.map(([id,label,key])=>{ const k=key&&API_KEYS.find(x=>x.id===key), off=k&&!keySaved(settings,k);
        return `<button data-fetch="${id}" ${off?`disabled title="Add your ${esc(k.name)} key first (Your API keys)"`:""}>${esc(label)}${off?' <span class="hint">· needs key</span>':""}</button>`; }).join("")}</div>
      <p class="hint" style="margin:4px 0 0">Uses the pin and radius above. An area already fetched recently isn't downloaded again; the same emitter from several sources shows once on the map, with each source's data.</p>
      ${dasNote("WiGLE and OpenCelliD fetched around a building are the cell sites its cellular pre-survey shows")}
      <div id="fetchMsg" class="hint" style="margin-top:6px"></div>${pull?`<p class="hint" style="margin:6px 0 0">${pullLine(pull)}</p>`:""}
      <h3 style="margin-top:14px">Import your own layer</h3>
      <div class="row"><label class="grow">Layer name<input id="cl_name" value="My layer"></label><input type="file" id="cl_file" accept=".csv,.kml,.kmz,.geojson,.json,.gpx"></div>
      <h3 style="margin-top:14px">Import labels (RadioReference-style CSV)</h3>
      <div class="row"><input type="file" id="lb_file" accept=".csv"><span class="hint">Frequency, License, Tone, Alpha Tag, Description, Mode, Tag</span></div>
      <div id="impMsg" class="hint" style="margin-top:6px"></div></div>
  </div>
  <div class="panel"><h3>Crowd / imported layers on this computer</h3>
    <div class="tw"><table><thead><tr><th>Source</th><th>Layer</th><th>Points</th><th>Last fetched</th></tr></thead><tbody>${layers.layers.map(l=>`<tr><td>${esc(l.source)}</td><td>${esc(l.layer)}</td><td class="n">${l.n.toLocaleString()}</td><td class="mono">${esc(l.fetched||"")}</td></tr>`).join("")||'<tr><td colspan="4" class="hint">None yet.</td></tr>'}</tbody></table></div>
    <p class="hint">The USGS maps and county lines you view are kept on this PC, so areas you looked at before a trip keep working with no signal. Street (OpenStreetMap) and Esri's hi-res satellite are for use with signal only (their terms don't allow keeping them for offline use): with no signal the map shows USGS Topo instead.</p></div>`;
  paintSources();
  // a grantee on the FCC's prohibited-entity lists (prohibited.py): a Covered List maker plainly, a same-name match to check
  const listsNote=L=>!L?"":(L.listed||[]).map(c=>`<span class="tag w" style="background:var(--bad);border-color:var(--bad)">FCC Covered List</span> ${esc(c.name)} since ${esc(c.since)}: ${esc(c.scope)}. `).join("")
    +(L.same_name||[]).slice(0,2).map(e=>`<span class="tag w">Same name</span> as ${esc(e.name)} on the ${esc((e.lists||[]).join(" and "))}${e.country?` (${esc(e.country)})`:""}${e.added?`, added ${esc(e.added)}`:""}${e.cite?`, ${esc(e.cite)}`:""}: check it's the same company. `).join("");
  const fiRun=async()=>{ const q=$("#fiQ").value.trim(); if(!q) return; $("#fiMsg").textContent="Asking the FCC…"; $("#fiOut").innerHTML="";
    try{ const r=await api(`/api/fccid?q=${encodeURIComponent(q)}`), m=r.maker;
      const maker=m?`<b>${esc(m.name||m.code)}</b>${[m.city,m.state,m.country].filter(Boolean).length?`, ${esc([m.city,m.state,m.country].filter(Boolean).join(", "))}`:""} (grantee code ${esc(m.code)}). ${listsNote(m.lists)}`:"";
      // the FCC's grant list refuses anything but a person's own browser (10/31: the PC's request and the web version's both
      // get 403), so when it won't answer, the grants open there: the FCC's own list, or fccid.io's readable copy of it
      const id=encodeURIComponent(r.query||q);
      const fccList=`<a href="https://apps.fcc.gov/OETLabServices/getFCCIDList?fccId=${id}" target="_blank" rel="noopener">the FCC's list ↗</a>`;
      $("#fiMsg").innerHTML=r.offline&&r.kept?`${maker}The FCC won't send its grant list to DAStastic, so these are the grants kept here (the FCC's grant search, for DAS and booster makers), with the bands each is granted for. Power and class: each grant's view, or ${fccList}.`
        :r.offline?`${maker}The FCC won't send its grant list to DAStastic, so this is from the grantee list kept here. The grants open in your browser: ${fccList} or <a href="https://fccid.io/${id}" target="_blank" rel="noopener">fccid.io ↗</a> (a third-party viewer of the FCC's records).`
        :`${maker}${r.count.toLocaleString()} grant${r.count===1?"":"s"} for ${esc(r.query)}. Power and test reports: the FCC's <a href="${esc(r.search_form)}" target="_blank" rel="noopener">search form ↗</a> or each grant's view.`;
      const bands=b=>(b||[]).length?b.slice(0,8).map(([lo,hi])=>lo===hi?`${+lo}`:`${+lo}–${+hi}`).join(", ")+(b.length>8?` +${b.length-8}`:""):"";
      const anyBands=r.results.some(x=>(x.bands||[]).length), anyCls=r.results.some(x=>x.eq_class||x.watts);
      $("#fiOut").innerHTML=r.results.length?`<div class="tw" style="max-height:320px"><table><thead><tr><th>FCC ID</th><th>Grantee</th><th>Granted</th><th>Purpose</th>${anyBands?"<th>Bands (MHz)</th>":""}${anyCls?"<th>Booster class</th><th title=\"The FCC's power range for the device's strongest band; exact watts per band on its page\">Power (strongest band)</th>":""}<th>Address</th><th></th></tr></thead><tbody>${r.results.map(x=>`<tr><td class="mono">${esc(x.fcc_id)}</td><td>${esc(x.grantee)}</td><td class="mono">${esc(x.grant_date)}</td><td>${esc(x.purpose)}</td>${anyBands?`<td class="mono">${esc(bands(x.bands))}</td>`:""}${anyCls?`<td>${esc(x.class_name||"")}</td><td class="mono">${esc(wattsTxt(x))}</td>`:""}<td class="hint">${esc(x.address)}</td><td>${x.view?`<a href="${esc(x.view)}" target="_blank" rel="noopener">view ↗</a>`:""}</td></tr>`).join("")}</tbody></table></div><p class="hint">“view” opens fccid.io, a third-party viewer of the FCC's public records, with each band's exact power${anyBands?"; bands, booster class and power ranges come from the FCC's grant search, kept here":""}.</p>`:'<p class="hint">No grants match.</p>'; }
    catch(e){ $("#fiMsg").textContent=e.message; } };
  $("#fiGo").onclick=fiRun; $("#fiQ").onkeydown=e=>{ if(e.key==="Enter") fiRun(); };
  // the maker list: the FCC's own (one person imports its download; the DAStastic site hands it to every other copy), or open data (2021)
  const fiSrc=g=>{ if(!$("#fiSrc")?.isConnected) return; const page=`<a href="${esc(g.page)}" target="_blank" rel="noopener">Grantee Search ↗</a>`;
    const own=`Only the person who keeps the DAStastic site imports the FCC's download (its ${page}, Download all grantees).`;
    $("#fiSrc").innerHTML=g.source==="site"?`Maker names: the FCC's own grantee list, from the DAStastic site. Nothing to do here.`
      :g.source==="fcc-download"&&g.file==="the RF Recon site"?`Maker names: ${g.codes.toLocaleString()} grantee codes, the FCC's own list of ${esc(g.at)}, from the DAStastic site. It stays current through FCC equipment grantee codes in Data sources.`
      :g.source==="fcc-download"?`Maker names: ${g.codes.toLocaleString()} grantee codes, the FCC's own list, imported ${esc(g.at)}${g.newest?` (newest ${esc(g.newest)})`:""}. Refresh the DAStastic site's packs to pass it on. ${own}`
      :`Maker names: ${(g.codes||0).toLocaleString()} grantee codes${g.codes?" from FCC open data, which the FCC last updated in March 2021":""}. For its current list, run FCC equipment grantee codes in Data sources: it comes from the DAStastic site. ${own}`;
    // the DAS and booster makers' grants with their bands (fccid.import_grant_file): one FCC grant search per maker code
    const gr=g.grants||{}, form=`<a href="https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm" target="_blank" rel="noopener">Authorization Search ↗</a>`;
    const cls=gr.classes||{}, n=k=>(cls[k]||0).toLocaleString();
    $("#fiGr").innerHTML=gr.devices?`Grants with their bands: ${gr.devices.toLocaleString()} devices from ${(gr.makers||0).toLocaleString()} makers, the FCC's grant search of ${esc(gr.at||"")}: every signal booster (Part 90 Class A ${n("B9A")}, Class B ${n("B9B")}; Part 20 ${((cls.B2I||0)+(cls.B2P||0)+(cls.B2W||0)).toLocaleString()}), power ranges for ${(gr.powered||0).toLocaleString()} Part 90 boosters, and all the grants of ${esc((gr.named||[]).join(", "))}. The DAS pre-survey lists the boosters that cover a building's channels.`
      :g.source==="site"?"":`No DAS or booster grants kept yet: the FCC's ${form}, one maker's grantee code at a time, Formatting Options XML, then import the files here.`; };
  api("/api/fccid/grantees").then(fiSrc).catch(()=>{ if($("#fiSrc")) $("#fiSrc").textContent=""; });
  $("#fiGrImp").onchange=async e=>{ const files=[...e.target.files]; if(!files.length) return; let done=0;
    try{ for(const f of files){ $("#fiGr").textContent=`Reading ${f.name} (${done+1} of ${files.length})…`;
        const by=new URLSearchParams({name:f.name, ...($("#fiGrCls").value?{eq_class:$("#fiGrCls").value}:{}), ...($("#fiGrW").value?{watts:$("#fiGrW").value}:{})});
        await api(`/api/fccid/grants?${by}`,{method:"POST",body:await f.arrayBuffer()}); done++; }
      fiSrc(await api("/api/fccid/grantees")); }
    catch(err){ $("#fiGr").textContent=`${done} of ${files.length} imported. ${err.message}`; } finally{ e.target.value=""; } };
  $("#fiImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#fiSrc").textContent=`Reading ${f.name}…`;
    try{ const g=await api(`/api/fccid/grantees?name=${encodeURIComponent(f.name)}`,{method:"POST",body:await f.arrayBuffer()}); fiSrc(g);
      $("#fiSrc").insertAdjacentText("beforeend", ` ${g.new.toLocaleString()} codes weren't in the old list.`); }
    catch(err){ $("#fiSrc").textContent=err.message; } finally{ e.target.value=""; } };
  if(S.pendingFccid){ $("#fiQ").value=S.pendingFccid; S.pendingFccid=null; $("#fiQ").scrollIntoView({block:"center"}); fiRun(); }  // from Search: a maker's FCC IDs
  api("/api/tak/settings").then(t=>{ $("#tkMc").checked=t.multicast!==false; $("#tkGroup").value=t.group||""; $("#tkGroup").placeholder=t.default_group; $("#tkServer").value=t.server||""; }).catch(()=>{});
  $("#tkSave").onclick=async()=>{ try{ await post("/api/tak/settings",{multicast:$("#tkMc").checked, group:$("#tkGroup").value, server:$("#tkServer").value}); $("#tkMsg").textContent="Saved."; }
    catch(e){ $("#tkMsg").textContent=e.message; } };
  const fpPaint=async()=>{ if(!$("#fpList")) return; const f=await api("/api/fieldpacks"), j=f.job;
    if(!$("#fpList")) return;  // left the tab while it loaded (11/3: threw on fast tab switching)
    $("#fpDir").textContent=f.folder; $("#fpUrl").href=f.phone_url; $("#fpUrl").textContent=f.phone_url;
    if($("#wayLite")){ const lite=new URL(f.phone_url, location.href); $("#wayLite").href=lite.href; $("#wayWeb").href=new URL("full/", lite).href; }  // the web version's is "../"
    $("#fpList").innerHTML=f.packs.map(p=>`<tr><td><a href="/api/fieldpacks/file?name=${encodeURIComponent(p.file)}" download title="Download this pack to load on a phone or share">⇩ ${esc(p.file)}</a></td><td class="n">${p.mb} MB</td><td class="mono">${esc(p.made)}</td></tr>`).join("")||'<tr><td colspan="3" class="hint">None yet.</td></tr>';
    $("#fpMsg").textContent=j.running?(j.log[j.log.length-1]||"Starting…"):j.error?`Error: ${j.error}`:j.result?`Done: ${j.result.name}, ${j.result.mb} MB, ${j.result.counts.licences.toLocaleString()} licences.${j.result.big?" That's large for a phone: a pack around the pin keeps it smaller.":""}`:"";
    $("#fpMake").disabled=$("#fpPin").disabled=j.running;
    if(j.running) setTimeout(fpPaint,1000); };
  $("#fpMake").onclick=async()=>{ await post("/api/fieldpack",{states:$("#fpStates").value,name:$("#fpName").value}); fpPaint(); };
  $("#fpPin").onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ $("#fpMsg").textContent="Drop a pin first."; return; }
    await post("/api/fieldpack",{lat:p[0],lon:p[1],radius:+$("#radius").value||5,name:$("#fpName").value}); fpPaint(); };
  fpPaint();
  // this copy's version and updates (kitupdate.py): a kit copy installs a newer kit zip and restarts
  api("/api/kit").catch(()=>new Promise(ok=>setTimeout(ok,2000)).then(()=>api("/api/kit"))).then(k=>{  // one retry: just after a restart
    if(!$("#kitBody")) return;  // left the tab while it loaded
    if(!k.kit){ $("#kitBody").innerHTML=`<p class="hint" style="margin:0">${S.me?"This is the server's copy: it updates when a new version is deployed to it.":"This copy runs from its own app folder on this PC (outside Drive since 11/3) and updates from git."}</p>`; return; }
    const c=k.current, L=k.latest;
    $("#kitBody").innerHTML=`<p style="margin:0 0 8px">Version <span class="mono">${esc(c.version)}</span>, built ${esc(c.built)}. ${k.update?`<b>A newer kit is out: <span class="mono">${esc(L.version)}</span>, built ${esc(L.built)}.</b>`:L?"This is the newest kit.":'<span class="hint">Couldn\'t check for a newer kit (offline?).</span>'}</p>
      ${k.update&&L.notes?.length?`<ul class="hint" style="margin:0 0 8px">${L.notes.slice(0,6).map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}
      <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap"><a class="btn" href="${esc(k.get)}" target="_blank" rel="noopener">Get the update ↗</a>
        <label class="inl">Install an update <input type="file" id="kitZip" accept=".zip"></label><span class="hint" id="kitMsg"></span></div>
      <p class="hint" style="margin:6px 0 0">Download the new “DAStastic (beta).zip”, then pick it here. Your data, DAS jobs and settings stay; DAStastic restarts with the new version.</p>`;
    $("#kitZip").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; $("#kitMsg").textContent=`Installing ${f.name}…`;
      try{ const r=await api("/api/kit/update",{method:"POST", body:await f.arrayBuffer()});
        $("#kitMsg").textContent=`Updated ${r.from} → ${r.to} (${r.files} files). DAStastic is restarting…`;
        await new Promise(ok=>setTimeout(ok,3000));
        for(let i=0;i<60;i++){ try{ if((await api("/api/kit")).current?.version===r.to){ location.reload(); return; } }catch(err){ /* the server is restarting: ask again in a second */ } await new Promise(ok=>setTimeout(ok,1000)); }  // the old server can still answer while it shuts down
        $("#kitMsg").textContent="It didn't come back by itself: double-click Start DAStastic."; }
      catch(err){ $("#kitMsg").textContent=err.message; } };
  }).catch(()=>{ if($("#kitBody")) $("#kitBody").innerHTML='<p class="hint" style="margin:0">Couldn\'t read this copy\'s version.</p>'; });
  // remote access (remote.py): the Tailscale Funnel link, and the people who can sign in at it
  const raPaint=async()=>{ if(!$("#raList")) return; let r; try{ r=await api("/api/remote"); }catch(e){ if($("#raLink")) $("#raLink").innerHTML=`<p class="hint">${esc(e.message)}</p>`; return; }
    if(!$("#raList")) return;  // left the tab while it loaded
    $("#raList").closest(".panel").hidden=!r.door;  // a copy without the remote door (the install kit) has nothing to show here
    $("#dcPanel").hidden=!r.door; if(r.door) dcPaint();
    $("#sfPanel").hidden=S.me?.role!=="admin"; if(S.me?.role==="admin"&&!SF.started) sfStart();
    $("#waysPanel").hidden=!(r.door||S.me);  // and Ways in is about sharing that copy: the PC's door, or the server's admin
    if(!$("#waysPanel").hidden) waysVersions();
    const L=r.link||{}, n=r.people.length, ts={NeedsLogin:"signed out",NeedsMachineAuth:"waiting for approval",Stopped:"stopped",Starting:"starting"}[L.state]||"not running";
    if(L.server && $("#wayRemoteRow")) $("#wayRemoteRow").hidden=true;  // the PC's Tailscale link means nothing on the server
    $("#wayRemote").textContent=`${!L.installed?"Tailscale isn't installed":L.state!=="Running"?`Off: Tailscale is ${ts}`:L.on?"On":"Off"} · ${n?`${n} ${n===1?"person":"people"} can sign in`:"no one can sign in yet"}. Remote access, below`;
    if(L.server){ $("#raHow").textContent="The server is always on. People you add open the link in any browser (or install it as an app from there), sign in, and do what their login allows: View only looks and searches; Full also works DAS jobs, missions and notes; Admin also has the keys, updates and people."; }
    $("#raLink").innerHTML=L.server?`<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><b>Link</b><span class="mono">${esc(L.url||"")}</span><span class="tag">Always on</span><button id="raCopy">Copy link</button></div>`
      :!L.installed?'<p class="hint">Tailscale isn\'t installed on this PC: it carries the link.</p>'
      :L.state!=="Running"?`<p class="hint">Tailscale is ${esc(ts)} on this PC. Sign in to Tailscale (system tray) to get the link.</p>`
      :`<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><b>Link</b><span class="mono">${esc(L.url||"")}</span><span class="tag">${L.on?"On":"Off"}</span>
         ${L.on?'<button id="raCopy">Copy link</button>':""}<button id="raToggle">${L.on?"Turn the link off":"Turn the link on"}</button></div>`;
    $("#raList").innerHTML=r.people.map(u=>u.role==="fetcher"  // the PC that brings crowd data (ops/crowd_pull.py): a machine, so no role to pick and no password to hand out
      ?`<tr><td>${esc(u.name)}</td><td title="Brings WiGLE data the server can't fetch; reaches nothing else">PC fetcher (a machine)</td><td class="mono">${esc(u.added||"")}</td><td class="mono">${esc(u.last||"not yet")}</td>
      <td style="text-align:right;white-space:nowrap"><button data-rarm="${esc(u.name)}">Remove</button></td></tr>`
      :`<tr><td>${esc(u.name)}${u.ends?`<div class="hint" style="${u.ended?"color:var(--bad)":""}">${u.ended?`ended ${esc(u.ends)}`:`until ${esc(u.ends)}`}</div>`:""}${r.google_on&&u.google?`<div class="hint">Google: ${esc(u.google)}${u.google_first?` · first used ${esc(u.google_first)}`:" · not used yet"}</div>`:""}</td><td><select data-rarole="${esc(u.name)}">${[["view","View only"],["full","Full"],["admin","Admin"],["ahj","AHJ reviewer"]].map(([k,l])=>`<option value="${k}" ${(u.role||"view")===k?"selected":""}>${l}</option>`).join("")}</select></td><td class="mono">${esc(u.added||"")}</td><td class="mono">${esc(u.last||"not yet")}</td>
      <td style="text-align:right;white-space:nowrap">${u.ends&&!u.ended?`<button data-raend="${esc(u.name)}" title="Its last day becomes yesterday: it can't sign in, and its open sessions stop">End now</button> `:""}${r.google_on?`<button data-ragoogle="${esc(u.name)}" data-email="${esc(u.google||"")}" title="The Google account that signs in as ${esc(u.name)} (Sign in with Google)">Google…</button> `:""}<button data-ranew="${esc(u.name)}">New password</button> <button data-rarm="${esc(u.name)}">Remove</button></td></tr>`).join("")
      ||'<tr><td colspan="5" class="hint">No one yet. Add a person to give them a sign-in.</td></tr>';
    if($("#raCopy")) $("#raCopy").onclick=async()=>{ try{ await navigator.clipboard.writeText(L.url); $("#raMsg").textContent="Link copied."; }catch(e){ $("#raMsg").textContent=L.url; } };
    if($("#raToggle")) $("#raToggle").onclick=async()=>{ $("#raMsg").textContent=L.on?"Turning the link off…":"Turning the link on…";
      try{ await post("/api/remote/link",{on:!L.on}); $("#raMsg").textContent=""; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); };
    $("#raList").querySelectorAll("[data-ranew]").forEach(b=>b.onclick=()=>raAdd(b.dataset.ranew, true));
    $("#raList").querySelectorAll("[data-ragoogle]").forEach(b=>b.onclick=async()=>{  // item 8: which Google account signs in as this login
      const e=prompt(`The Google account that signs in as ${b.dataset.ragoogle} (blank to unlink). It must also be a test user in Google Cloud while the app is in Testing.`, b.dataset.email);
      if(e===null) return;
      try{ await post("/api/remote/google",{name:b.dataset.ragoogle, email:e.trim()}); $("#raMsg").textContent=e.trim()?`${b.dataset.ragoogle} can sign in with Google as ${e.trim()}.`:`${b.dataset.ragoogle}'s Google sign-in is unlinked.`; }
      catch(err){ $("#raMsg").textContent=err.message; } raPaint(); });
    $("#raList").querySelectorAll("[data-raend]").forEach(b=>b.onclick=async()=>{  // a temporary login, ended early (item 9)
      try{ await post("/api/remote/ends",{name:b.dataset.raend, ends:"now"}); $("#raMsg").textContent=`${b.dataset.raend}'s login has ended: it can't sign in, and its open sessions have stopped.`; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); });
    $("#raList").querySelectorAll("[data-rarole]").forEach(s=>s.onchange=async()=>{
      try{ await post("/api/remote/role",{name:s.dataset.rarole, role:s.value}); $("#raMsg").textContent=`${s.dataset.rarole} is now ${s.options[s.selectedIndex].text}.`; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); });
    $("#raList").querySelectorAll("[data-rarm]").forEach(b=>b.onclick=async()=>{  // two presses, so a stray click doesn't lock someone out
      if(b.dataset.sure!=="1"){ b.dataset.sure="1"; b.textContent="Press again to remove"; setTimeout(()=>{ if(b.isConnected){ b.dataset.sure=""; b.textContent="Remove"; } },4000); return; }
      try{ await post("/api/remote/remove",{name:b.dataset.rarm}); $("#raMsg").textContent=`${b.dataset.rarm} can't sign in any more.`; }catch(e){ $("#raMsg").textContent=e.message; } raPaint(); }); };
  // the DAS course (course.py): who has it, by account, and how far each has got
  const dcPaint=async()=>{ if(!$("#dcList")) return; let r; try{ r=await api("/api/remote/course"); }catch(e){ if($("#dcMsg")) $("#dcMsg").textContent=e.message; return; }
    if(!$("#dcList")) return;  // left the tab while it loaded
    const has=r.people.filter(u=>u.has), began=r.people.filter(u=>u.done!=null);
    $("#dcSum").textContent=`${has.length} of ${r.people.length} ${r.people.length===1?"account has":"accounts have"} it; ${began.length} started.`;
    $("#dcList").innerHTML=r.people.map(u=>{ const fixed=u.role==="ahj";
      return `<tr><td>${esc(u.name)}</td><td><label class="inl"><input type="checkbox" data-dcname="${esc(u.name)}" ${u.has?"checked":""} ${fixed?"disabled":""}> ${fixed?"Not for AHJ":u.has?"Yes":"No"}</label></td>
        <td>${u.done!=null?`${u.done} of ${u.total}`:"-"}</td><td>${u.mastery!=null?`${u.mastery}% · ${esc(u.rank||"")}`:"-"}</td><td>${u.exams?`${u.passed} of ${u.exams}`:"-"}</td>
        <td>${u.last?`${esc(u.last)} ${esc(u.last_title||"")}`:"-"}</td><td>${esc(u.saved_at||u.opened_at||"Not opened")}</td></tr>`; }).join("")
      ||'<tr><td colspan="7" class="hint">No accounts yet. Add a person under Remote access.</td></tr>';
    $("#dcList").querySelectorAll("[data-dcname]").forEach(c=>c.onchange=async()=>{ const who=c.dataset.dcname;
      try{ await post("/api/remote/course",{name:who, on:c.checked}); $("#dcMsg").textContent=c.checked?`${who} has the DAS course now.`:`${who} no longer has the DAS course. Their progress is kept.`; }catch(e){ $("#dcMsg").textContent=e.message; } dcPaint(); }); };
  // server files (serverfiles.py): what the server keeps. Read only; a download is a copy
  const SF={root:"", path:"", started:false, labels:{}};
  const sfSize=b=>b>=1e9?`${(b/1e9).toFixed(1)} GB`:b>=1e6?`${(b/1e6).toFixed(1)} MB`:`${Math.max(1,Math.round(b/1e3))} KB`;
  const sfOpen=async(root, path="")=>{ SF.root=root; SF.path=path; if(!$("#sfList")) return; let r;
    $("#sfRoots").querySelectorAll("[data-sfroot]").forEach(b=>b.classList.toggle("on",b.dataset.sfroot===root));
    try{ r=await api(`/api/remote/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`); }catch(e){ $("#sfMsg").textContent=e.message; return; }
    if(!$("#sfList")||SF.root!==root||SF.path!==path) return;  // left the tab, or picked another folder while it loaded
    const parts=r.path?r.path.split("/"):[], join=n=>parts.slice(0,n).join("/"), kids=n=>r.path?`${r.path}/${n}`:n;
    $("#sfCrumb").innerHTML=[`<button class="sf-go" data-sfgo="">${esc(r.label)}</button>`,...parts.map((p,i)=>`<button class="sf-go" data-sfgo="${esc(join(i+1))}">${esc(p)}</button>`)].join(" › ");
    const items=n=>n==null?"":`${n>=r.count_to?`${n.toLocaleString()}+`:n.toLocaleString()} item${n===1?"":"s"}`;
    $("#sfList").innerHTML=[...r.folders.map(f=>`<tr data-srt-group="folder"><td><button class="sf-go" data-sfgo="${esc(kids(f.name))}">${esc(f.name)}/</button></td><td>${items(f.items)}</td><td>${esc(f.changed)}</td><td></td></tr>`),
      ...r.files.map(f=>`<tr data-srt-group="file"><td>${esc(f.name)}</td><td>${sfSize(f.size)}</td><td>${esc(f.changed)}</td><td style="text-align:right">${r.download?`<a class="hbtn" title="Download a copy" aria-label="Download ${esc(f.name)}" download href="/api/remote/files/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(kids(f.name))}">⇩ Download</a>`:""}</td></tr>`)].join("")
      ||'<tr><td colspan="4" class="hint">Nothing here yet.</td></tr>';
    $("#sfMsg").textContent=[r.download?"":"This folder lists sizes only.", r.more?`Showing the first ${(r.folders.length+r.files.length).toLocaleString()}; ${r.more.toLocaleString()} more aren't listed.`:""].filter(Boolean).join(" ");
    document.querySelectorAll("#sfCrumb [data-sfgo], #sfList [data-sfgo]").forEach(b=>b.onclick=()=>sfOpen(root,b.dataset.sfgo)); };
  const sfStart=async()=>{ SF.started=true; let r; try{ r=await api("/api/remote/files"); }catch(e){ $("#sfMsg").textContent=e.message; return; }
    if(!$("#sfRoots")) return;
    $("#sfDisk").textContent=`${sfSize(r.disk.free)} free of ${sfSize(r.disk.total)}.`;
    $("#sfRoots").innerHTML=r.folders.map(f=>`<button data-sfroot="${esc(f.id)}">${esc(f.label)}</button>`).join("");
    $("#sfRoots").querySelectorAll("[data-sfroot]").forEach(b=>b.onclick=()=>sfOpen(b.dataset.sfroot));
    if(r.folders[0]) sfOpen(r.folders[0].id); };
  const raAdd=async (name, renew)=>{ name=(name||"").trim(); if(!name){ $("#raMsg").textContent="Type their name first."; return; }
    try{ const ends=renew?undefined:($("#raEnds")?.value||"");
      const r=await post("/api/remote/add",renew?{name}:{name, role:$("#raRole").value, ends}); $("#raName").value=""; if($("#raEnds")) $("#raEnds").value="";
      $("#raMsg").innerHTML=`Password for <b>${esc(r.name)}</b>: <span class="mono" style="user-select:all;font-size:15px">${esc(r.password)}</span> · Shown only now: send it to them with the link. Their old password, if any, no longer works.${ends?` It works through ${esc(ends)}.`:""}`; raPaint(); }
    catch(e){ $("#raMsg").textContent=e.message; } };
  $("#raAdd").onclick=()=>raAdd($("#raName").value); $("#raName").onkeydown=e=>{ if(e.key==="Enter") raAdd($("#raName").value); };
  raPaint();
  wireDesk();
  // the Data desk is asked once the tab is drawn: asked beside the tab's own calls it built the same snapshot at the same
  // time and slowed the tab (11/8, measured: median 640 ms against 460); drawn last time's way meanwhile
  api("/api/update/desk").catch(()=>null).then(dv=>{ if(gen!==S.viewGen||!dv) return; const p=$("#deskPanel"); if(!p) return;
    p.outerHTML=deskPanel(dv); wireDesk(); const ny=$("#needsYou"); if(ny) ny.outerHTML=needsYou(NY.pull, NY.people); });
  api("/api/update/rules").catch(()=>null).then(rv=>{ if(gen!==S.viewGen||!rv) return; const p=$("#rulesPanel"); if(p) p.outerHTML=rulesPanel(rv); });
  $("#netCheck").onclick=async()=>{ $("#netCard").innerHTML='<p class="hint">Checking…</p>'; UPD=await post("/api/net/hint?check=1",{type:c.type||null,effectiveType:c.effectiveType||null}); paintNet(); paintSources(); };
  const cfg=async body=>{ UPD=await post("/api/update/config",body); paintNet(); paintSources(); };
  $("#uAuto").onchange=e=>cfg({auto:e.target.checked});
  // which connections updates may use: pick any mix; All is all three; one always stays on
  $("#uLinks").onclick=e=>{ const b=e.target.closest("[data-link]"); if(!b) return; const k=b.dataset.link, ALL=["wifi","ethernet","cellular"];
    let cur=new Set(UPD?.links||["wifi","ethernet"]);
    if(k==="all") cur=new Set(ALL); else { cur.has(k)?cur.delete(k):cur.add(k); if(!cur.size) cur.add(k); }
    cfg({links:ALL.filter(x=>cur.has(x))}); };
  $("#uAllOn").onclick=()=>cfg({all:true}); $("#uAllOff").onclick=()=>cfg({all:false});
  $("#uStop").onclick=async()=>{ const b=$("#uStop"); b.disabled=true;
    try{ UPD=await post(UPD&&UPD.stopped?"/api/update/resume":"/api/update/stop", {}); }catch(e){ $("#uUpdMsg").textContent=e.message; }
    b.disabled=false; paintNet(); paintSources(); };
  $("#uRunAll").onclick=async()=>{ UPD=await post("/api/update/run",{ids:"enabled",force:true}); paintNet(); paintSources(); };
  // Update all: every source now, selected or not; each downloads only what's newer, and a source needing a key you haven't saved is left out
  $("#uUpdAll").onclick=async()=>{ const b=$("#uUpdAll"), m=$("#uUpdMsg"); b.disabled=true;
    try{ const r=await post("/api/update/run",{ids:"all"}); UPD=r; paintNet(); paintSources();
      const nm=id=>UPD.sources[id]?.label||id;
      m.innerHTML=`${r.started.length?`Updating ${r.started.length} sources: each one's progress is in its row below.`:"Nothing started: every source is already running."}${
        r.skipped.length?` Left out, no key saved: ${r.skipped.map(id=>esc(nm(id))).join(", ")} (Your API keys).`:""}`; }
    catch(e){ m.textContent=e.message; } b.disabled=false; };
  $("#uStates").onchange=e=>post("/api/settings",{states:e.target.value.toUpperCase().replace(/\s/g,"")});
  $("#uBdcStates").onchange=e=>post("/api/settings",{bdc_states:e.target.value});
  // Only a box a person typed, pasted or dropped into is saved (Cody 11/10): the browser's autofill put the sign-in email into
  // every plain-text box (WiGLE's API name, Digi-Key's Client ID) and Save sent them all. Autofill fires input events but
  // never a trusted keydown, paste or drop, so those mark a box as the person's own.
  v.querySelectorAll("[data-cred]").forEach(i=>{ const mark=()=>{ i.dataset.typed="1"; };
    i.addEventListener("keydown",e=>{ if(e.isTrusted&&(e.key.length===1||e.key==="Backspace"||e.key==="Delete")) mark(); });
    i.addEventListener("paste",mark); i.addEventListener("drop",mark); });
  // and a box the browser filled by itself is emptied, so it doesn't look like a saved key (11/10: the sign-in email sat in
  // WiGLE's API name box); autofill lands a moment after the page draws, so it's checked twice
  const unfill=()=>v.querySelectorAll("[data-cred]").forEach(i=>{ let auto=false; try{ auto=i.matches(":autofill"); }catch(e){ try{ auto=i.matches(":-webkit-autofill"); }catch(e2){} }
    if(auto&&!i.dataset.typed) i.value=""; });
  setTimeout(unfill, 400); setTimeout(unfill, 1500);
  $("#k_save").onclick=async()=>{ const creds={}; v.querySelectorAll("[data-cred]").forEach(i=>{ if(i.dataset.typed&&i.value.trim()) creds[i.dataset.cred]=i.value.trim(); });
    if(!Object.keys(creds).length){ $("#k_msg").textContent="Type or paste a key first (a box your browser filled in by itself isn't saved)."; return; }
    try{ await post("/api/settings",{creds}); S.views.data(v); }catch(e){ $("#k_msg").textContent=e.message; } };
  v.querySelectorAll("[data-kclear]").forEach(a=>a.onclick=async e=>{ e.preventDefault(); const k=API_KEYS.find(x=>x.id===a.dataset.kclear);  // two presses, like Remove elsewhere
    if(a.dataset.sure!=="1"){ a.dataset.sure="1"; a.textContent="Press again to remove"; setTimeout(()=>{ if(a.isConnected){ a.dataset.sure=""; a.textContent="Remove"; } },4000); return; }
    await post("/api/settings",{creds:Object.fromEntries(k.fields.map(([f])=>[f,"__clear__"]))}); S.views.data(v); });
  v.querySelectorAll("[data-fetch]").forEach(b=>b.onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ $("#fetchMsg").textContent="Drop a pin first."; return; }
    $("#fetchMsg").textContent=`Fetching ${b.dataset.fetch}…`;
    try{ const r=await post("/api/crowd/fetch",{source:b.dataset.fetch,lat:p[0],lon:p[1],radius:+$("#radius").value||5,state:S.mission?.state||S.rows.find(x=>x.state)?.state});
      $("#fetchMsg").textContent=r.queued?`${b.dataset.fetch}: ${r.message}`:r.skipped?`${b.dataset.fetch}: ${r.skipped}.`:`${b.dataset.fetch}: ${r.rows} points saved. Re-running search…`; if(!r.skipped&&!r.queued) runSearch(); }catch(e){ $("#fetchMsg").textContent=`${b.dataset.fetch}: ${e.message}`; } });
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
// Stop all downloads (Cody 11/4): one button stops every download and keeps them stopped until Resume downloads
function paintStop(u){ const b=$("#uStop"), m=$("#uStopMsg"); if(!b) return;
  const run=Object.values(u.sources||{}).filter(s=>s.running).length;
  b.textContent=u.stopped?"▶ Resume downloads":"■ Stop all downloads"; b.classList.toggle("primary", !!u.stopped);
  ["#uUpdAll","#uRunAll"].forEach(id=>{ const x=$(id); if(x) x.disabled=!!u.stopped; });
  m.style.display=u.stopped?"":"none";
  m.textContent=u.stopped?`Downloads stopped at ${u.stopped}${run?`: ${run} finishing their current megabyte`:""}. Nothing downloads, automatic updates included, until you press Resume downloads. The data you had is kept.`:""; }
function paintSources(){
  const u=UPD; if(!u||!$("#srcList")) return;
  const ny=$("#needsYou"); if(ny) ny.outerHTML=needsYou(NY.pull, NY.people);  // a source switched off leaves the list at once (11/8)
  paintStop(u);
  const n=u.net, link={wifi:"Wi-Fi",cellular:"Cellular",ethernet:"Ethernet",vpn:"VPN",unknown:"unknown link"}[u.link]||u.link;
  if($("#netCard")) $("#netCard").innerHTML=`<div class="row" style="align-items:center"><span class="led ${n.online?"on":n.online===false?"off":""}" style="width:14px;height:14px"></span><b>${n.online?"Online":n.online===false?"Offline":"Not checked yet"}</b> · ${esc(link)}${n.interface?` (${esc(n.interface)})`:""}${n.latency_ms!=null?` · ${n.latency_ms} ms to FCC`:""}</div><p class="hint">Last checked ${esc(n.checked||"–")} · ${esc(n.os||"")}</p>`;
  const acc=a=>!a||!a.key?"":a.needs_key?`${a.key_saved?'<span style="color:var(--good)">✓ key saved</span>':'<span style="color:var(--bad)">✗ no key saved</span>'} · ${esc(a.key)} · ${esc(a.cost||"")}${a.signup?` · <a href="${esc(a.signup)}" target="_blank" rel="noopener">get a key ↗</a>`:""}`
    :`${esc(a.cost||"")}${a.key==="none"?" · no key needed":""}`;
  $("#srcList").innerHTML=Object.entries(u.sources).map(([id,s])=>`<div class="srcrow">
    <label class="switch"><input type="checkbox" data-src="${esc(id)}" ${s.enabled?"checked":""}><span></span></label>
    <div><b>${esc(s.label)}</b><div class="hint">${esc(s.description)}</div>
      ${s.access?.key?`<div class="hint">${acc(s.access)}${s.access.terms?`<br>Terms: ${esc(s.access.terms)}`:""}</div>`:""}
      ${s.why?`<div class="hint" style="color:${/^Downloading/.test(s.why)?"var(--good)":"var(--warn)"}">${esc(s.why)}</div>`:""}${DAS_USES[id]?dasNote(DAS_USES[id]):""}${s.datasets&&window.prDatasets?prDatasets(s):""}</div>
    <select data-int="${esc(id)}" class="hide-m">${intervalsFor(s.interval_h).map(([h,l])=>`<option value="${h}" ${+s.interval_h===h?"selected":""}>${l}</option>`).join("")}</select>
    <div class="hide-m" style="font-size:12px">${s.running?'<span class="tag w">running</span> ':""}${s.state==="error"?'<span class="tag" style="color:var(--bad)">error</span> ':s.state==="ok"?'<span class="tag v">ok</span> ':""}${esc(s.message||"")}
      <div class="hint">${freshness(s, u.auto)} · updated ${esc(s.last_updated||"never")}${s.remote?` · source file ${esc(s.remote)}`:""}${s.rows!=null?` · ${Number(s.rows).toLocaleString()} rows`:""}</div></div>
    <button data-run="${esc(id)}" ${s.running?"disabled":""}>Run now</button></div>`).join("");
  $$("[data-src]").forEach(x=>x.onchange=async()=>{ UPD=await post("/api/update/config",{sources:{[x.dataset.src]:{enabled:x.checked}}}); paintSources(); });
  if($("#uLinks")){ const on=new Set(u.links||[]), nm={wifi:"Wi-Fi",ethernet:"Ethernet",cellular:"cellular / phone tether"};
    $$("#uLinks [data-link]").forEach(b=>b.classList.toggle("on", b.dataset.link==="all"?on.size===3:on.has(b.dataset.link)));
    const now=u.link==="vpn"||u.link==="unknown"?"ethernet":u.link;
    $("#uLinkNow").innerHTML=`This PC is on <b>${esc(nm[now]||u.link||"?")}</b> now: updates ${on.has(now)?'<span style="color:var(--good)">can run</span>':'<span style="color:var(--warn)">wait for '+[...on].map(k=>nm[k]).join(" or ")+"</span>"}.`; }
  // the catalog's sources with no Data & updates entry: the ones DAStastic uses live, then the researched rest
  const catRows=(rows,live)=>`<div class="tw wrap"><table><thead><tr><th>Source</th><th>What it gives</th><th>Key</th><th>Cost</th>${live?"":"<th>Area search</th>"}<th>Terms</th><th>${live?"Where in DAStastic":"In DAStastic"}</th></tr></thead><tbody>${
    rows.map(c=>`<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener"><b>${esc(c.name)}</b> ↗</a></td><td>${esc(c.what)}</td><td>${esc(c.key)}${c.signup?` · <a href="${esc(c.signup)}" target="_blank" rel="noopener">sign up ↗</a>`:""}</td>
      <td>${esc(c.cost)}</td>${live?"":`<td>${esc(c.area)}</td>`}<td class="hint">${esc(c.terms)}</td><td>${esc(live?c.status.replace(/^In DAStastic:\s*(.)/,(m,ch)=>ch.toUpperCase()):c.status)}${live&&DAS_LIVE[c.name]?dasNote(DAS_LIVE[c.name]):""}</td></tr>`).join("")}</tbody></table></div>`;
  const inApp=c=>/^In DAStastic/.test(c.status);
  if($("#srcLive") && u.catalog) $("#srcLive").innerHTML=catRows(u.catalog.filter(inApp),true)+`
    <p class="hint">Terms checked on each provider's own page: the maps, terrain, address search, building outlines and radar on 2026-11-02, live ships on 2026-10-28.
      Plus what you bring in yourself: your own layers (CSV, KML, KMZ, GeoJSON, GPX), RadioReference-style labels, talk groups (CSV, Excel or JSON), field captures, and your own maps (ATAK map sources, a tile address or MBTiles).</p>`;
  if($("#srcCatalog") && u.catalog) $("#srcCatalog").innerHTML=catRows(u.catalog.filter(c=>!inApp(c)),false)+`
    <p class="hint">Checked on each provider's own pages on 2026-10-28. “Could add” means its terms and API allow it; say which to wire in. Sign-ups need your own account: DAStastic never makes one for you.
      The research behind DAStastic is in the Drive folder's docs › research: DAS and ERCES, link budget, PIM, RF parts, building plans and materials, receivers and SDRs, the data roadmap and the capability and UX review.</p>`;
  $$("[data-int]").forEach(x=>x.onchange=async()=>{ UPD=await post("/api/update/config",{sources:{[x.dataset.int]:{interval_h:+x.value}}}); paintSources(); });
  $$("[data-run]").forEach(x=>x.onclick=async()=>{ UPD=await post("/api/update/run",{ids:[x.dataset.run],force:true}); paintNet(); paintSources(); });
}
