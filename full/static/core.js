"use strict";
/* DAStastic — core: state, search, layers, filters, map, detail. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtF = f => f == null || f === "" ? "" : Number(f).toFixed(5).replace(/0{1,2}$/, "");
// a booster's power from the FCC's grant search (fccid.py POWER_RANGES): the range its strongest band falls in
const wattsTxt = x => !x?.watts ? "" : x.watts[1] >= 10000 ? `over ${x.watts[0]} W` : `${x.watts[0]}–${x.watts[1]} W`;
const num = (v, d=0) => v == null || v === "" || isNaN(v) ? "" : Number(v).toFixed(d).replace(/^-(0(\.0+)?)$/, "$1");  // never "-0"
const api = async (path, opts) => { if(window.dasJobApi && !opts?.dasRaw && /^\/api\/das\/jobs(\/\d+)?$/.test(path)) return window.dasJobApi(path, opts);  /* job saves carry their revision (dasrev.js) */ const r = await fetch(path, opts);
  // a session that ended: to the sign-in page, for every login (11/3: only non-admin logins went there; admins were left
  // with an error line wherever they were). The PC's own copy never answers 401.
  if(r.status===401){ location.href="/remote/login"; throw new Error("Signed out."); }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch(e){ throw new Error(t.slice(0,200) || r.statusText); }
  if(!r.ok || j.error) throw new Error(j.error || r.statusText); rfSort.soon(); return j; };  // a table drawn from the answer keeps its sort (rfSort)
const post = (path, body) => api(path, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{})});

// rfSort, the sort every table and list shares (static/rfsort.js, loaded before this file)

const LAYERS = {
  uls:{label:"FCC licensed", color:"#0b6e4f"}, uls_hist:{label:"FCC history (expired / removed)", color:"#9a6700"},
  broadcast:{label:"Broadcast (AM / FM / TV)", color:"#953800"}, noaa:{label:"NOAA Weather Radio", color:"#1b7c83"},
  faa:{label:"Aviation (FAA)", color:"#0550ae"},
  towers:{label:"Towers (FCC ASR)", color:"#57606a"}, captures:{label:"My captures", color:"#cf222e"},
  wigle:{label:"WiGLE", color:"#8250df"}, opencellid:{label:"OpenCelliD", color:"#bf3989"},
  repeaterbook:{label:"RepeaterBook", color:"#1f6feb"}, custom:{label:"Imported layers", color:"#bf8700"},
  ttn:{label:"LoRaWAN gateways (TTN)", color:"#0a7c66"}, satnogs:{label:"SatNOGS ground stations", color:"#6639ba"},
  wspr:{label:"WSPR stations", color:"#b35900"}, pskreporter:{label:"PSKReporter", color:"#a40e26"},
  psap:{label:"911 call centres (FCC registry)", color:"#d1242f"}, proposed:{label:"Proposed towers (FCC, FAA)", color:"#8250df"}, fss:{label:"Satellite earth stations (FCC)", color:"#0b6e99"},
  boosters:{label:"Signal boosters (FCC registered)", color:"#4d7c0f"},  // off until ticked (boosters.py): Class B registrations, business fields only
  meshtastic:{label:"Meshtastic mesh radios", color:"#67ea94"}, helium:{label:"Helium IoT hotspots", color:"#474dff"}};

// the filter rail's three source groups (rail.js), in their fixed order; the ATAK frames follow the same split (mapstyle.js)
const SOURCE_GROUPS = [
  ["licensed", "Licensed & registered", ["uls","uls_hist","broadcast","noaa","faa","towers","proposed","psap","fss","boosters"]],
  ["crowd", "Crowd & networks", ["wigle","opencellid","repeaterbook","ttn","helium","meshtastic","satnogs","wspr","pskreporter"]],
  ["mine", "Mine", ["captures","custom"]]];
const LICENSED = new Set(SOURCE_GROUPS[0][2]);  // FCC and other government records, not crowd reports

const S = { mode:"point", rows:[], center:null, radius:5, tab:"map",
  layerOn: new Set(["uls","broadcast","noaa","faa","towers","captures","wigle","opencellid","repeaterbook","custom","ttn","satnogs","wspr","pskreporter","psap","fss","meshtastic","helium"]),
  // each filter group is "all on, untick to hide" (hide) or "only these" (chips, the include sets links and other tabs
  // have always used); one of the two is set at a time
  chips:{type:new Set(), cat:new Set(), band:new Set(), cls:new Set(), carrier:new Set(), agency:new Set()},
  hide:{type:new Set(), cat:new Set(), band:new Set(), cls:new Set(), carrier:new Set(), agency:new Set()},
  side:"all",
  sort:{k:"dist_mi", dir:1}, shown:600, lib:{}, mission:null, missionId:null, heat:{kind:"off", opacity:.75},
  sel:null, filterExpr:"", views:{} };
S.layerDef = new Set(S.layerOn);  // the default sources (a mission sets its own): what Clear goes back to
// the defaults among the sources this copy has (the web version drops RepeaterBook from LAYERS after this line runs)
const layerDefaults = () => new Set([...S.layerDef].filter(l => LAYERS[l]));

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
// the same groups by a key the server can read: it doesn't know the source labels, so anything but a licence goes by its layer
const classKey = r => r.layer==="uls"||r.layer==="uls_hist"||r.layer==="towers" ? classGroup(r) : r.layer;
const typeOf = r => r.layer==="towers" ? "Tower / structure" : r.layer==="proposed" ? "Proposed tower / structure" : r.layer==="psap" ? "911 call centre" : r.layer==="boosters" ? "Signal booster (FCC registered)" : (r.sig_type || "Unknown");
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
  if(S.franges) p.set("franges",S.franges);
  if(S.keepNoFreq) p.set("keep_nofreq","1");
  if($("#hideMobile").checked) p.set("hide_mobile","1");
  if(S.missionId) p.set("mission",S.missionId);
  p.set("layers", Object.keys(LAYERS).join(","));
  for(const [k,v] of Object.entries(extra||{})) if(v!==undefined && v!==null && v!=="") p.set(k,v);
  return p;
}
async function runSearch(){
  const st=$("#status"); st.className="status";
  pinArm(false);  // a search sets the spot: Move pin, if it was armed, is done (review 11/11: it stayed armed, and a stray click moved the pin)
  if(window.RFMarkup) RFMarkup.disarm();  // and an armed ＋ Marker or a marker's Move (markup.js)
  // with no spot the Map tab is where one can be dropped; the Towers tab keeps its own page (its address box is the whole search)
  if(S.mode==="point" && !parseLoc($("#loc").value)){ st.textContent="Type an address, place or county (pick a suggestion), enter coordinates, or use 📍 Move pin on the map."; if(S.tab!=="map" && S.tab!=="towers") setTab("map"); return; }
  if(S.mode==="county" && !$("#state").value){ st.textContent="Pick a state."; st.className="status err"; return; }
  st.textContent="Searching…"; $("#go").disabled=true;
  S.lastQuery=params().toString(); searchDirty();
  // what the Pin box said for this search: ＋ Mark (search.js) puts it back after marking a place typed there
  S.locSearched={v:$("#loc").value, label:$("#locLabel")?.textContent||"", place:S.placeLabel||null}; $("#locWrap")?.classList.remove("typed");
  const link=S.pendingLink=window.searchLink?.();  // this search's part of the link, written once it's the one on the map (search.js); the web version's pack reload carries it
  if(S.tab==="towers" && window.RFTowers) RFTowers.prefetch();  // the tower report starts beside the area search, not after it (towers.js)
  const gen=S.searchGen=(S.searchGen||0)+1;  // a slow earlier search must not overwrite a newer one (pin drags, radius slider)
  // what this search looks at, read from what it asks: the mode buttons can be pressed before it's back (review 11/11)
  const key=searchKeyOf(params());
  // a link's own view (mv=) is for the link's own search; any other search fits as usual (review 11/11: a stale mv took over)
  if(S.mvWant){ if(S.mvWant.gen==null && (!S.mvWant.key || S.mvWant.key===key)) S.mvWant.gen=gen; else S.mvWant=null; }
  try{
    const res = await api("/api/area?"+params());
    if(gen!==S.searchGen) return;
    S.rows=res.rows; S.center=res.center; S.radius=res.radius||parseFloat($("#radius").value)||5; S.shown=600;
    S.searchKey=key; S.linkSearch=link; S.setAside=res.set_aside||{}; S.searched=true;
    st.textContent = res.truncated ? "Large area — showing the first 25,000 licensed entries. Narrow the radius or add filters." : (window.railWhy?.()||"");
    render();
    if(S.heat.kind!=="off") loadHeat();
  }catch(e){ if(gen===S.searchGen){ st.textContent="Error: "+e.message; st.className="status err"; if(S.mvWant && S.mvWant.gen===gen) S.mvWant=null; } }
  finally{ if(gen===S.searchGen) $("#go").disabled=false; }
}

/* ---------- filters ---------- */
// what each filter group reads from a row (the server's heatmap reads sig_type, band and category the same way)
const agencyKey = s => String(s||"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim();  // agency_key in app.py: case and punctuation only
const agencyOf = r => r._ag ??= agencyKey(r.licensee)||"No agency";
const FACETS = {type:typeOf, cat:r=>r.category||"Other", band:r=>r.band||"Other", cls:classGroup, carrier:r=>r.carrier||"No carrier", agency:agencyOf};
// a row passes when its source is on and, in every group but `skip`, its value is in "only" (when set) or not hidden.
// With nothing hidden this is the include-set test the chips always used, so the same choices give the same rows.
function passes(r, skip){
  if(!S.layerOn.has(r.layer)) return false;
  for(const k in FACETS){ if(k===skip) continue;
    const only=S.chips[k], hide=S.hide[k];
    if(only.size){ if(!only.has(FACETS[k](r))) return false; }
    else if(hide.size && hide.has(FACETS[k](r))) return false; }
  return true;
}
const filtered = () => S.rows.filter(r => passes(r));
const facetChanged = k => !!(S.chips[k].size || S.hide[k].size);
const filtersChanged = () => Object.keys(FACETS).some(facetChanged);  // any signal type, band, category or station filter on
// "only these" for a group, from another tab or a link (a mission's targets): what was hidden there no longer applies
function setOnly(k, vals){ S.chips[k]=new Set(vals); S.hide[k].clear(); if(S.railSolo) delete S.railSolo[k]; }
// a Dashboard bar: only that value, and the same bar again brings the rest back (the include toggle it always was)
function toggleChip(key, v){ const set=S.chips[key]; if(set.has(v)) set.delete(v); else { set.add(v); S.hide[key].clear(); }
  if(S.railSolo) delete S.railSolo[key]; S.shown=600; render(); }
// Clear: back to the defaults (the mission's sources, every value on, no Analyzer display filter)
function filtersReset(){ for(const k in FACETS){ S.chips[k].clear(); S.hide[k].clear(); } S.filterExpr=""; S.side="all";
  S.layerOn=layerDefaults(); S.layerSolo=S.layerPrev=null; S.railSolo={}; S.shown=600; }
// the include list the server's heatmap takes for a group: "only" as it is; hidden values as every other value in the
// results (as the server reads them), or one no row has when everything is hidden
function heatList(k){
  const only=S.chips[k], hide=S.hide[k]; if(!only.size && !hide.size) return [];
  const srv = k==="cls" ? classKey : FACETS[k], keep=new Set();
  for(const r of S.rows) if(only.size ? only.has(FACETS[k](r)) : !hide.has(FACETS[k](r))) keep.add(srv(r));
  return keep.size ? [...keep] : ["(none)"];
}
// the groups as the server reads them (facet_keep in app.py): the heatmap and the CSV and KML follow what's on screen
const facetParams = () => ({types:heatList("type").join("|"), bands:heatList("band").join("|"), cats:heatList("cat").join("|"), cls:heatList("cls").join("|"), carriers:heatList("carrier").join("|"),
  agencies:[...S.chips.agency].join("|"), xagencies:S.chips.agency.size?"":[...S.hide.agency].join("|")});
// the filter rail draws the groups (rail.js); the count line is drawn here so it's right on every tab
function renderFacets(rows){ if(window.railRender) window.railRender(rows); }

/* ---------- render dispatch ---------- */
// the tabs that never read the pin (Start, PIM, Parts, Data & updates) lose the pin bar and its status line, and the tabs that
// list what a search found say what to do before one has run (UX review 11/8 #1 and #11: on a phone the pin search filled
// their first screen, and an empty tab blamed the filters before anyone had searched)
const NO_PIN_TABS=new Set(["start","pim","parts","data"]), PIN_TABS=new Set(["report","analyzer","dashboard","topology","profile","agencies","spectrum","cells","towers"]);
const pinFirst=pad=>`<p class="status pin-first"${pad?' style="padding:10px"':""}>Type an address or drop a pin, then press <b>Show what's here</b>.</p>`;
function setTab(t){ S.tab=t; render(); }
function getFile(url){ location.href=url; }  // a file the server makes (the web version fetches it through the page instead)
function render(){
  const rows=filtered();
  const fq=new Set(rows.filter(r=>r.freq_mhz).map(r=>fmtF(r.freq_mhz)));
  $("#resultCount").textContent=`${rows.length.toLocaleString()} item${rows.length===1?"":"s"} · ${fq.size.toLocaleString()} freq${fq.size===1?"":"s"}${S.center?` · within ${S.radius} mi`:""}`;
  renderFacets(rows);  // before the view: the rail shows or goes for this tab, so the view draws at its own width
  $$("#tabs button").forEach(b=>b.classList.toggle("on", b.dataset.t===S.tab));
  document.body.classList.toggle("tab-start", S.tab==="start");
  document.body.classList.toggle("no-pin", NO_PIN_TABS.has(S.tab));
  document.body.classList.toggle("tab-towers", S.tab==="towers");  // the Towers tab shows the address box only (index.html)
  const tb=$("#tabs"), on=$("#tabs button.on");  // on a phone the tab bar scrolls sideways: keep the open tab on screen
  if(on && tb.scrollWidth>tb.clientWidth){ const l=on.offsetLeft-tb.offsetLeft, r=l+on.offsetWidth;
    if(l<tb.scrollLeft || r>tb.scrollLeft+tb.clientWidth) tb.scrollLeft=l-(tb.clientWidth-on.offsetWidth)/2; }
  const v=$("#view");
  if(S.tab!=="report") v.style.minHeight="";  // the Area report's height kept while it drew itself again (report.js) goes with it
  if(window.RFMaps) RFMaps.sweep(S.tab);  // the maps of other tabs go, keeping their view for when they come back (results.js)
  if(window.RFResults) RFResults.sweep(S.tab);  // and a results viewer on another tab's page (Cell sites, Topology)
  if(S.tab!=="map") $("#mapTop").innerHTML="";  // the map's slot under the search bar
  const fn = S.views[S.tab];
  S.viewGen=(S.viewGen||0)+1;  // a tab that waits for data checks this after the wait: a newer draw since means stop
  if(fn && !S.searched && PIN_TABS.has(S.tab) && S.tab!=="towers") v.innerHTML=pinFirst();  // Towers says its own: it has no Show what's here
  else if(fn) fn(v, rows); else v.innerHTML="";
  rfSort.soon();  // a table drawn again keeps the sort it had
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
  const top=$("#mapTop");  // under the one-line search bar (Cody 11/5, which replaces his 11/4 order), its list and table below it
  const m0=$("#map"), t0=m0&&m0.isConnected&&S.map?m0.getBoundingClientRect().top:null;
  top.innerHTML = `
    <div class="maptools no-print">
      <label class="inl" title="Standard, ATAK style (symbols, imagery, MGRS) or a map you imported">Map <select id="mapStyle"></select></label>
      <label class="inl">Heatmap <select id="heatKind">
        <option value="off">Off</option><option value="terrain">Predicted with terrain (Hata + hills, strongest 60)</option><option value="predicted">Predicted from licenses (free-space)</option>
        <option value="measured">Measured (my captures / WiGLE)</option><option value="carrier">Carrier coverage (FCC Broadband Map)</option><option value="density">Density of everything shown</option></select></label>
      <span class="inl" id="heatCarrierBox" style="${S.heat.kind==="carrier"?"":"display:none"}"><select id="heatCarrier" title="Which carrier and technology"><option value="">Loading carriers…</option></select>
        <select id="heatEnv" title="Where the carrier says the signal holds"><option value="">Outdoor or in a vehicle</option><option value="0">Outdoor, standing still</option><option value="1">In a moving vehicle</option></select></span>
      <details class="inl" id="heatFiles" style="position:relative;${S.heat.kind==="measured"?"":"display:none"}"><summary title="Which survey files the measured heatmap uses">${heatFilesLabel()}</summary>
        <div class="panel" style="position:absolute;z-index:1000;min-width:260px;max-height:300px;overflow:auto;margin-top:4px;padding:8px">${heatFileList().map(([k,l,n])=>`<label style="display:block;white-space:nowrap"><input type="checkbox" data-hf="${esc(k)}" ${S.heat.files?.has(k)?"checked":""}> ${esc(l)} <span class="hint">${n}</span></label>`).join("")||'<span class="hint">No survey points with levels in this area yet.</span>'}
          ${S.heat.files?.size?'<button id="heatFilesAll" style="margin-top:6px">Use every file</button>':""}</div></details>
      ${S.heat.kind==="measured"&&(S.heat.ident||S.heat.freq)?`<span class="tag">Signal: ${esc(S.heat.signal||S.heat.ident||S.heat.freq)} <a href="#" id="heatSigClear" title="Back to every signal">✕</a></span>`:""}
      <label class="inl">Opacity <input type="range" id="heatOp" min="0.1" max="1" step="0.05" value="${S.heat.opacity}" style="width:90px"></label>
      <button id="heatExport" title="KMZ for Google Earth / ATAK, GeoTIFF for QGIS / ArcGIS / Global Mapper">⇩ Heatmap (KMZ + GeoTIFF)</button>
      <div class="seg" style="margin-left:auto"><button data-lv="list" class="${S.listMode!=="table"?"on":""}">List</button><button data-lv="table" class="${S.listMode==="table"?"on":""}">Table</button></div>
      ${S.listMode!=="table"?`<label class="inl" title="The list's order. The Table's headers sort it by any column.">Sort <select id="sideSort">${Object.entries(SIDE_SORT).map(([k,[l]])=>`<option value="${k}" ${(S.sideSort||"")===k?"selected":""}>${l}</option>`).join("")}</select></label>`:""}
    </div>
    <div class="mapwrap" id="mapwrap">
      <div id="map"></div>
    </div>
    <span class="hint" id="mapHint">${S.center?"Click a dot or a row to see it beside the map; the map stays where it is. To move the pin: 📍 Move pin (top left), or right-click where it goes (a long press on a touch screen). To mark a spot and leave the pin: ＋ Marker, or right-click and ＋ Marker here.":""}</span>`;
  v.innerHTML = `<div class="side" id="side" style="${S.listMode==="table"?"display:none":""}"></div>
    <div id="mapTable"></div>`;
  $("#heatKind").value=S.heat.kind;
  $("#heatKind").onchange=async e=>{ S.heat.kind=e.target.value; $("#heatFiles").style.display=S.heat.kind==="measured"?"":"none";
    $("#heatCarrierBox").style.display=S.heat.kind==="carrier"?"":"none"; if(S.heat.kind==="carrier") await heatCarrierFill(); loadHeat(); };
  $("#heatEnv").value=S.heat.env??"";
  $("#heatCarrier").onchange=e=>{ S.heat.carrier=e.target.value; loadHeat(); };
  $("#heatEnv").onchange=e=>{ S.heat.env=e.target.value; loadHeat(); };
  if(S.heat.kind==="carrier") heatCarrierFill();
  top.querySelectorAll("[data-hf]").forEach(c=>c.onchange=()=>{ S.heat.files=S.heat.files||new Set(); c.checked?S.heat.files.add(c.dataset.hf):S.heat.files.delete(c.dataset.hf);
    $("#heatFiles summary").textContent=heatFilesLabel(); loadHeat(); });
  if($("#heatFilesAll")) $("#heatFilesAll").onclick=()=>{ S.heat.files=new Set(); render(); loadHeat(); };
  if($("#heatSigClear")) $("#heatSigClear").onclick=e=>{ e.preventDefault(); S.heat.ident=S.heat.freq=S.heat.signal=""; render(); loadHeat(); };
  $("#heatOp").oninput=e=>{ S.heat.opacity=+e.target.value; if(S.heatLayer) S.heatLayer.setOpacity(S.heat.opacity); };
  $("#heatExport").onclick=()=>{ if(!heatArea()){ $("#status").textContent="Heatmaps need a pin or a county: drop a pin, or pick a county, then press Show what's here."; return; } const k=S.heat.kind==="off"?"predicted":S.heat.kind;
    getFile("/api/heatmap.zip?"+params(heatParams(k))); };
  top.querySelectorAll("[data-lv]").forEach(b=>b.onclick=()=>{ S.listMode=b.dataset.lv; render(); });
  if($("#sideSort")) $("#sideSort").onchange=e=>{ S.sideSort=e.target.value; S.shown=600; render(); };
  if(ensureMap()) drawLayers(rows);
  const items=groupItems(rows);
  if(S.listMode==="table") $("#mapTable").innerHTML = S.views.freqTable(items);
  else drawSideList(items);
  if(t0!=null && t0<innerHeight){ const t1=$("#map")?.getBoundingClientRect().top; if(t1!=null && Math.abs(t1-t0)>=1) window.scrollTo({top:scrollY+t1-t0, behavior:"instant"}); }
};

// the Map list's orders (its Sort picker): nearest first is the list as it always was, in rings out from the pin; the others drop the
// rings and sort every entry before the first ones show (rfSort.by: numbers as numbers, blanks last)
const SIDE_SORT={"":["Nearest first"], freq:["Frequency, low to high",r=>r.freq_mhz,1], name:["Name, A to Z",titleOf,1], type:["Type, A to Z",typeOf,1],
  lvl:["Strongest first",levelOf,-1], erp:["Most power first",erpOf,-1]};
function drawSideList(items){
  const side=$("#side"); if(!side) return;
  if(!items.length){ side.innerHTML=S.searched?'<p class="status" style="padding:10px">Nothing here with the current layers and filters.</p>':pinFirst(true); return; }
  const ss=SIDE_SORT[S.sideSort||""]; if(ss?.[1]) items=rfSort.by(items, ss[1], ss[2]);
  const step = S.center && !ss?.[1] ? niceStep(S.radius) : null;
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
  // a row: lit up and shown in the results viewer on the map (its details); the map doesn't pan to it (Cody 11/10)
  side.onclick=e=>{ if(e.target.id==="moreSide"){ S.shown+=1000; drawSideList(items); return; }
    const it=e.target.closest(".item"); if(!it) return; const r=S.rows.find(x=>x.fid===it.dataset.fid); if(!r) return;
    selectFeature(r); if(r.lat==null){ if(window.emitNoSpot) emitNoSpot(r); } else if(window.emitSpot) emitSpot(S.rows.filter(x=>x.lat===r.lat&&x.lon===r.lon), r); };
}

// the list's pick, lit up; it never moves the map (Zoom to in the viewer does, when asked)
function selectFeature(r){
  S.sel=r.fid;
  $$("#side .item").forEach(x=>x.classList.toggle("sel", x.dataset.fid===r.fid));
}

function pinIcon(){ return L.divIcon({className:"rf-pin", html:'<div class="pinicon" style="width:22px;height:22px"></div>', iconSize:[22,22], iconAnchor:[11,22]}); }

/* ---------- map layers: backgrounds + overlays, kept across searches and visits ---------- */
const USGS="USGS The National Map";
// served through /tiles/<src>/: USGS tiles you view are kept for no signal. online:true maps are for use with signal only
// (OpenStreetMap's tile policy and Esri's licence forbid keeping tiles for offline use): with no signal the map shows
// NO_SIGNAL_BASE until signal returns, without changing the map you picked.
const NO_SIGNAL_BASE="Topo (USGS)";
const ESRI="Esri, Vantor, Earthstar Geographics";
// Sharper maps (Cody 11/10). Measured 11/10: Esri's imagery has zoom 19 everywhere and 20 in some places (Wilmington and
// Jacksonville NC, not Minneapolis or rural Minnesota); USGS imagery, topo and relief stop at 16 (17 answers "not found").
//   maxNativeZoom: the deepest zoom asked for. fallback: the deepest zoom every place has; a deeper tile that isn't there
//     (the proxy asks Esri with blankTile=false, so it's a 404, not Esri's grey "not yet available" tile) is cut from
//     its parent at that zoom and scaled, instead of a gap.
//   hidpi: on a sharp screen (2x and up) the next zoom's tiles at half size, so 256-pixel tiles aren't stretched.
//     Imagery and relief only: on a map with printed labels (Topo, Satellite + labels) it also halves the labels (seen
//     11/10: Topo at 14 gained street names but every label at half size), so those keep normal tiles.
//     Not OpenStreetMap: its volunteer servers ask for no heavy use.
//   above: on the USGS satellite map, Esri's imagery from zoom 17, where USGS has nothing; with no signal USGS's
//     stretched tiles still show underneath.
const ESRI_ABOVE={src:"esri-imagery", name:"Satellite hi-res (Esri)", from:17, maxNativeZoom:20, fallback:19, attribution:ESRI};
// needs: the build.py source a map's tiles are; a sold copy leaves it out (baseOk).
// "Satellite + labels (USGS)" is gone: USGS retires its Imagery Topo map on 2026-11-16 (usgs.gov, read 11/10); a saved
// choice of it opens Satellite (USGS).
const BASEMAPS={
  "Street (OpenStreetMap)":{src:"osm", needs:"osm_tiles", maxNativeZoom:19, maxZoom:21, attribution:"© OpenStreetMap contributors", online:true},
  "Satellite (USGS)":{src:"usgs-imagery", maxNativeZoom:16, maxZoom:21, hidpi:true, above:[ESRI_ABOVE], attribution:USGS},
  "Satellite hi-res (Esri)":{src:"esri-imagery", needs:"esri_imagery", maxNativeZoom:20, fallback:19, maxZoom:21, hidpi:true, attribution:ESRI, online:true},
  "Topo (USGS)":{src:"usgs-topo", maxNativeZoom:16, maxZoom:21, attribution:USGS},
  "Terrain relief (USGS)":{src:"usgs-relief", maxNativeZoom:16, maxZoom:21, hidpi:true, attribution:USGS},
};
const BASE_RENAMED={"Satellite + labels (USGS)":"Satellite (USGS)"};
// Which maps this copy shows (Cody 11/10). A sold copy (team logins, licensed copies, the install kit, the web version)
// leaves out OpenStreetMap's own tiles and Esri's imagery (build.py osm_tiles, esri_imagery: their terms don't cover a
// product sold to others; the server refuses their tiles too) and opens on Topo (USGS). Until this copy says it's the
// personal build, it's treated as sold.
function baseOk(name){ const b=BASEMAPS[name]; if(!b) return false; if(!b.needs) return true;
  return S.build?.build==="personal" && !S.build?.left_out?.[b.needs]; }
function baseDefault(){ return baseOk("Street (OpenStreetMap)") ? "Street (OpenStreetMap)" : "Topo (USGS)"; }
// a saved choice this copy can't show opens the closest map it can (imagery for Esri's imagery: ATAK style saved Esri on
// every copy before 11/10), else the default; the choice stays saved
const BASE_STANDIN={"Satellite hi-res (Esri)":"Satellite (USGS)"};
function baseShown(name){ name=BASE_RENAMED[name]||name; if(baseOk(name)) return name; const s=BASE_STANDIN[name]; return s&&baseOk(s) ? s : baseDefault(); }
function baseSatellite(){ return baseOk("Satellite hi-res (Esri)") ? "Satellite hi-res (Esri)" : "Satellite (USGS)"; }  // ATAK style's imagery
const HIDPI=(window.devicePixelRatio||1)>=1.5;
const RfTiles=L.TileLayer.extend({
  initialize(url, o){ o={...o};
    if(window.RFTileSrc) url=RFTileSrc(url);  // the web version: straight from the source (web/shim.js)
    if(/^https?:/.test(url)) o.crossOrigin="anonymous";  // so a fallback tile can be drawn on a canvas
    if(o.hidpi&&HIDPI){ o.tileSize=128; o.zoomOffset=1; if(o.maxNativeZoom!=null) o.maxNativeZoom-=1; }
    delete o.hidpi; L.TileLayer.prototype.initialize.call(this, url, o); },
  createTile(coords, done){ const t=L.TileLayer.prototype.createTile.call(this, coords, done);
    t._rf={x:coords.x, y:coords.y, z:this._getZoomForUrl()}; return t; },  // with hidpi, x and y are already the asked zoom's
  _tileOnError(done, tile, e){ const c=tile._rf, fb=this.options.fallback, fail=()=>L.TileLayer.prototype._tileOnError.call(this, done, tile, e);
    if(fb==null || !c || c.z<=fb || tile._rfTried) return fail();
    tile._rfTried=true; const k=2**(c.z-fb), px=Math.floor(c.x/k), py=Math.floor(c.y/k), img=new Image();
    const src=L.Util.template(this._url, {s:"a", r:"", x:px, y:py, z:fb});
    if(/^https?:/.test(src)) img.crossOrigin="anonymous";
    img.onload=()=>{ try{ const n=256, sub=n/k, cv=document.createElement("canvas"); cv.width=cv.height=n;
        const g=cv.getContext("2d"); g.imageSmoothingQuality="high";
        // one source pixel of the neighbours around the cut, so the scaled edges blend with the next tile (without it a
        // faint seam showed between two fallback tiles, 11/10)
        const sx=(c.x-px*k)*sub, sy=(c.y-py*k)*sub, x0=Math.max(0,sx-1), y0=Math.max(0,sy-1), x1=Math.min(n,sx+sub+1), y1=Math.min(n,sy+sub+1), f=n/sub;
        g.drawImage(img, x0, y0, x1-x0, y1-y0, (x0-sx)*f, (y0-sy)*f, (x1-x0)*f, (y1-y0)*f);
        tile.src=cv.toDataURL("image/jpeg", .92); }  // its load ends the tile as loaded, so it never counts as no signal
      catch(err){ fail(); } };
    img.onerror=fail; img.src=src; },
});
function baseLayer({src, url, online, above, needs, ...opt}){  // url: a map you imported
  const main=new RfTiles(url||`/tiles/${src}/{z}/{x}/{y}.png`, opt);
  above=(above||[]).filter(a=>baseOk(a.name));  // Esri above USGS's zoom 16: the personal build only
  if(!above.length) return main;
  return L.layerGroup([main, ...above.map(a=>new RfTiles(`/tiles/${a.src}/{z}/{x}/{y}.png`,
    {minZoom:a.from, maxNativeZoom:a.maxNativeZoom, fallback:a.fallback, maxZoom:opt.maxZoom, hidpi:opt.hidpi, attribution:a.attribution, zIndex:2}))]);
}
// microwave backhaul (FCC licensed links), loaded for the area in view and again as the map moves
const MwLinks=L.LayerGroup.extend({
  onAdd(map){ L.LayerGroup.prototype.onAdd.call(this, map); this._map=map; this._r=this._r||L.canvas({padding:.3}); this._load=()=>{ clearTimeout(this._t); this._t=setTimeout(()=>this.load(), 350); };
    map.on("moveend", this._load); this.load(); },
  onRemove(map){ map.off("moveend", this._load); L.LayerGroup.prototype.onRemove.call(this, map); },
  async load(){ const m=this._map; if(!m) return; const b=m.getBounds();
    if(m.getZoom()<8){ this.clearLayers(); $("#status").textContent="Microwave backhaul: zoom in closer to load the links."; return; }
    try{ const r=await api(`/api/mwlinks?s=${b.getSouth()}&n=${b.getNorth()}&w=${b.getWest()}&e=${b.getEast()}`); this.clearLayers();
      if(r.loaded && /^Microwave backhaul/.test($("#status").textContent)) $("#status").textContent="";  // an earlier view's note no longer holds
      if(!r.loaded){ $("#status").textContent="Microwave backhaul isn't loaded: switch on FCC ULS: Microwave in Data & updates and update it."; return; }
      for(const k of r.links) L.polyline([[k.tx_lat,k.tx_lon],[k.rx_lat,k.rx_lon]],{renderer:this._r, color:"#8250df", weight:1.8, opacity:.75, bubblingMouseEvents:false})
        .bindTooltip(`${esc(k.licensee||"")} ${esc(k.call_sign)}<br>${esc(k.tx_city||"")} → ${esc(k.rx_city||"")} · ${(k.dist_km/1.609344).toFixed(1)} mi${k.freqs?`<br>${esc(k.freqs.split(",").slice(0,4).join(", "))} MHz`:""}`, {sticky:true}).addTo(this);
      for(const k of r.pending||[]) L.polyline([[k.tx_lat,k.tx_lon],[k.rx_lat,k.rx_lon]],{renderer:this._r, color:"#d4a017", weight:1.8, opacity:.85, dashArray:"6 5", bubblingMouseEvents:false})
        .bindTooltip(`<b>Pending application</b> ${esc(k.file_number)} (${esc(k.purpose)}, filed ${esc(k.received)})<br>${esc(k.licensee||"")} ${esc(k.call_sign||"")}<br>${esc(k.tx_city||"")} → ${esc(k.rx_city||"")} · ${(k.dist_km/1.609344).toFixed(1)} mi${k.freqs?`<br>${esc(k.freqs.split(",").slice(0,4).join(", "))} MHz`:""}`, {sticky:true}).addTo(this);
      if(r.truncated) $("#status").textContent="Microwave backhaul: showing the first links here; zoom in for all of them."; }catch(e){ /* the overlay just draws nothing this time; the next pan asks again */ }
  }});
// live ships (AIS via aisstream on the PC): asks every 10 s while the layer is on; the PC stops streaming when nobody asks
const AisShips=L.LayerGroup.extend({
  onAdd(map){ L.LayerGroup.prototype.onAdd.call(this, map); this._map=map; this.tick(); this._iv=setInterval(()=>this.tick(), 10000); },
  onRemove(map){ clearInterval(this._iv); L.LayerGroup.prototype.onRemove.call(this, map); },
  async tick(){ const m=this._map; if(!m) return; const b=m.getBounds();
    try{ const r=await api(`/api/ais?s=${b.getSouth()}&n=${b.getNorth()}&w=${b.getWest()}&e=${b.getEast()}`); this.clearLayers();
      for(const sh of r.ships){ const dir=sh.heading!=null&&sh.heading<360?sh.heading:sh.cog??0, moving=(sh.sog||0)>0.5;
        const icon=L.divIcon({className:"", iconSize:[18,18], iconAnchor:[9,9], html:`<svg width="18" height="18" viewBox="0 0 18 18" style="transform:rotate(${dir}deg)"><path d="${moving?"M9 1 L14 16 L9 12 L4 16 Z":"M9 4 L13 9 L9 14 L5 9 Z"}" fill="${sh.age_s>600?"#8c959f":"#0a7cff"}" stroke="#fff" stroke-width="1.2"/></svg>`});
        L.marker([sh.lat,sh.lon],{icon, bubblingMouseEvents:false}).bindTooltip(`<b>${esc(sh.name||"MMSI "+sh.mmsi)}</b>${sh.callsign?" · "+esc(sh.callsign):""}<br>MMSI ${sh.mmsi}${sh.type!=null?` · type ${sh.type}`:""}${sh.length_m?` · ${sh.length_m} m`:""}<br>${sh.sog!=null?`${sh.sog} kn, course ${Math.round(sh.cog||0)}°`:""}${sh.destination?` · to ${esc(sh.destination)}`:""}<br><span class="hint">${Math.round(sh.age_s/60)} min ago · AIS via aisstream.io</span>`).addTo(this); }
      $("#status").textContent=r.error&&r.status!=="streaming"?`Ships (AIS): ${r.error}`:`Ships (AIS): ${r.ships.length} in view · ${r.status}${r.since?` since ${r.since}`:""}`; }
    catch(e){ $("#status").textContent="Ships (AIS): "+e.message; } }});
const OVERLAYS={
  "County + state lines":()=>L.tileLayer("/tiles/counties/{z}/{x}/{y}.png",{maxZoom:19, zIndex:5, attribution:"US Census Bureau TIGERweb"}),
  "Microwave backhaul (FCC)":()=>new MwLinks(),
  "Ships (AIS, live)":()=>new AisShips(),
  // live, so loaded straight from the source and never cached; the 5-minute stamp refreshes it
  "Weather radar (NEXRAD, live)":()=>L.tileLayer("https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png?t="+Math.floor(Date.now()/3e5),
    {maxZoom:19, opacity:.6, zIndex:6, attribution:"NEXRAD via Iowa Environmental Mesonet"}),
};
function mapPrefs(){
  if(!S.mapLayers){ let saved={}; try{ saved=JSON.parse(localStorage.getItem("rfr.mapLayers"))||{}; }catch(e){ /* storage blocked (a private window): the default stands */ }
    // nothing saved: null, so the default is worked out each time (baseShown) and never saved; one worked out before this copy
    // said which build it is would be the sold copy's (11/11 review)
    S.mapLayers={base:BASEMAPS[BASE_RENAMED[saved.base]||saved.base]?(BASE_RENAMED[saved.base]||saved.base):null, overlays:(saved.overlays||[]).filter(n=>OVERLAYS[n])}; }
  return S.mapLayers;
}
function addMapLayers(map){
  if(window.rfZoomBar) rfZoomBar(map);  // − / + and the wheel-zoom lock on every map (zoombar.js, Cody 11/4)
  const pref=mapPrefs(), bases={}, overs={};
  for(const [name,cfg] of Object.entries(BASEMAPS)) if(baseOk(name)) bases[name]=baseLayer(cfg);
  for(const [name,make] of Object.entries(OVERLAYS)) overs[name]=make();
  if(window.RFBounds) RFBounds.link(map, overs);  // All boundaries switches the other three (boundaries.js)
  bases[baseShown(pref.base)].addTo(map);  // the saved choice stays saved: a map this copy can't show isn't overwritten
  for(const n of pref.overlays) overs[n].addTo(map);
  const ctl=L.control.layers(bases, overs, {position:"topleft"}).addTo(map);  // layers on the left, the zoom bar on the right (Cody 11/4)
  if(window.RFMeasure) RFMeasure.add(map);  // the ruler, under the layers (measure.js, Cody 11/10)
  if(window.RFMarkup) RFMarkup.add(map);  // Draw: points, lines and areas kept with the mission or job (markup.js)
  if(window.RFMapExport) RFMapExport.add(map);  // save the view as a sharp PNG (mapexport.js)
  if(window.RFMarkup) RFMarkup.button(map);  // ＋ Marker, armed for one click (markup.js): on the Search map, just above Move pin
  let unloading=false;  // map.remove() (leaving the tab) removes every layer; that isn't a choice to save
  map.on("unload",()=>{ unloading=true; });
  const save=()=>{ if(unloading) return; try{ localStorage.setItem("rfr.mapLayers", JSON.stringify(pref)); }catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } };
  // no signal on a map that's for use with signal only: show NO_SIGNAL_BASE, check every 30 s, go back when it answers
  let standIn=false, swapping=false, misses=0, timer=null;
  // one base map on at a time; a map of your own imported after this map was made joins its layers list when picked
  const swap=name=>{ swapping=true;
    if(!bases[name] && baseOk(name)){ bases[name]=baseLayer(BASEMAPS[name]); ctl.addBaseLayer(bases[name], name); }
    for(const [n,b] of Object.entries(bases)) if(n!==name && map.hasLayer(b)) map.removeLayer(b);
    if(bases[name] && !map.hasLayer(bases[name])) bases[name].addTo(map); swapping=false; };
  // the base map changed somewhere else (Map style, Your own maps): swapped on this map in place, as the layers button
  // does, instead of the whole map being made again (mapstyle.js, 11/10)
  map._rfBases=bases;
  // Any known map: the copy shows what it can of it (11/11 review: Standard after ATAK style set back a saved Street on a sold
  // copy, which returned here before any swap, so ATAK's satellite map, or your own, stayed on screen under "Standard")
  map._rfSetBase=name=>{ name=BASE_RENAMED[name]||name; if(!BASEMAPS[name]) return; if(standIn){ standIn=false; misses=0; clearInterval(timer); }
    const shown=baseShown(name); pref.base=name; swap(shown); save(); if(navigator.onLine===false && BASEMAPS[shown]?.online) noSignal(); };
  const noSignal=()=>{ const shown=baseShown(pref.base); if(standIn || !BASEMAPS[shown]?.online || unloading) return; standIn=true; swap(NO_SIGNAL_BASE);
    // its tiles are kept by the copy serving the page: this PC's own, or the server's (out of reach with no signal)
    $("#status").textContent=`No signal: showing ${NO_SIGNAL_BASE}, ${S.me||S.remote?"where this browser already has it (the server keeps the rest, out of reach with no signal)":"kept on this device"}. ${shown} isn't kept for use with no signal (its terms), so it comes back when signal does.`;
    timer=setInterval(check, 30000); };
  const back=()=>{ if(!standIn) return; standIn=false; misses=0; clearInterval(timer); if(!unloading) swap(baseShown(pref.base)); };
  const check=async()=>{ if(navigator.onLine===false) return; const z=Math.min(map.getZoom(),18), c=map.project(map.getCenter(),z).divideBy(256).floor();
    const u=L.Util.template(bases[baseShown(pref.base)]._url, {x:c.x, y:c.y, z, s:"a", r:""});
    try{ if((await fetch(u, {cache:"no-store", mode:u.startsWith("/")?"same-origin":"cors"})).ok) back(); }catch(e){ /* still no signal: the next check, 30 s on, tries again */ } };
  for(const [n,b] of Object.entries(bases)) if(BASEMAPS[n]?.online){
    b.on("tileload", ()=>{ misses=0; });
    b.on("tileerror", ()=>{ if(++misses>=4) noSignal(); }); }
  const onOff=()=>{ if(navigator.onLine===false) noSignal(); else if(standIn) check(); };
  addEventListener("offline", onOff); addEventListener("online", onOff);
  map.on("unload", ()=>{ clearInterval(timer); removeEventListener("offline", onOff); removeEventListener("online", onOff); });
  if(navigator.onLine===false) noSignal();
  // Leaflet also says "baselayerchange" when the map first gets its view and the shown base joins it: not a pick, so a saved
  // choice this copy can't show (a sold copy, a saved Street) isn't overwritten by the default shown in its place. Opened
  // with no signal, the base joining is the stand-in (11/11 review: that saved Topo over the personal build's Street or Esri,
  // which then never came back); it's already on screen, so a pick of it can't come this way.
  map.on("baselayerchange", e=>{ if(swapping || e.name===(standIn?NO_SIGNAL_BASE:baseShown(pref.base))) return;
    if(standIn){ standIn=false; misses=0; clearInterval(timer); }  // a map picked by hand ends the stand-in
    pref.base=e.name; save(); if(navigator.onLine===false && BASEMAPS[e.name]?.online) noSignal(); });
  map.on("overlayadd", e=>{ if(!pref.overlays.includes(e.name)) pref.overlays.push(e.name); save(); });
  map.on("overlayremove", e=>{ if(unloading) return; pref.overlays=pref.overlays.filter(n=>n!==e.name); save(); });
}

// ⤢ under the zoom bar: the one press, past a map's first fit, that brings what it shows back into view (nothing else fits a
// map: Cody 11/10). The Area report, Dashboard and DAS pre-survey had none, so a wider radius or more systems ticked stayed
// partly off screen, and the report printed the old crop (review 11/11). It calls map._rfFit, which each draw sets.
function fitControl(map, title){
  const C=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","leaflet-bar rf-zoombar"), a=L.DomUtil.create("a","rf-fit",d);
    a.href="#"; a.textContent="⤢"; a.title=title; a.setAttribute("role","button"); a.setAttribute("aria-label",title);
    L.DomEvent.disableClickPropagation(d); L.DomEvent.on(a,"click",e=>{ L.DomEvent.stop(e); if(map._rfFit) map._rfFit(); }); return d; }});
  new C({position:"topright"}).addTo(map);
}
// The Search map is made once per visit to the Map tab and kept while the tab draws itself again (Cody 11/10, after Andy's
// demo on 11/9: every filter, sort and label used to make a new map, fitted again, so the view jumped and "lost the site").
// ensureMap: the map, its layers, controls and handlers, once (RFMaps, results.js). drawLayers: the results on it, each time.
function ensureMap(){
  if(typeof L==="undefined" || !window.RFMaps){ $("#map").innerHTML='<p class="status" style="padding:12px">Map library missing.</p>'; return null; }
  return RFMaps.keep("search", $("#map"), el=>{
    if(S.wheelZoom==null) S.wheelZoom=window.rfWheelZoom?rfWheelZoom.on:false;  // locked whenever DAStastic opens (zoombar.js)
    const map=L.map(el,{preferCanvas:true, zoomControl:false, scrollWheelZoom:S.wheelZoom}); S.map=map;
    // − / + and the wheel-zoom lock: the shared zoom bar (zoombar.js), added by addMapLayers like every other map
    addMapLayers(map);
    // two drawing layers: the dots (clickable) and the decoration (rings, tracks, overlays) that clicks pass through;
    // a decoration canvas on top used to swallow every click, so locked-pin clicks on dots did nothing
    S.dotsR=L.canvas({padding:.3});
    S.quietR=L.canvas({padding:.3}).addTo(map);
    map.whenReady(()=>{ if(S.quietR._container) S.quietR._container.style.pointerEvents="none"; });  // its canvas exists once the map has a view
    S.dotLayer=L.layerGroup().addTo(map); S.decoLayer=L.layerGroup().addTo(map);  // cleared and drawn again by drawLayers
    // the scale bar, the readout and the heatmap's legend keep their clicks: a click on one used to reach the map under it and
    // move the pin (Andy's demo 11/9, "we may have lost the site"; 11/10)
    L.DomEvent.disableClickPropagation(L.control.scale({imperial:true, metric:true}).addTo(map).getContainer());
    // The pin moves only when asked (Cody 11/10, after Andy's demo: a stray click moved it and lost the site, and a lock can
    // be left off in a demo). Move pin arms one placement, a crosshair: the next click puts the pin there and it's done; Esc
    // or the button again cancels. Right-click (a long press on a touch screen) gives "Move pin here". Otherwise a click on
    // the map does nothing to the pin, and the pin can't be dragged; it lets clicks through to the dots under it.
    const MovePin=L.Control.extend({onAdd(){ const b=L.DomUtil.create("button","leaflet-bar rf-movepin"); b.id="pinMove"; b.type="button";
      L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b,"click",e=>{ L.DomEvent.stop(e); pinArm(!map._rfPinArmed); }); return b; }});
    const mp=new MovePin({position:"topleft"}).addTo(map); mp.getContainer().parentNode.prepend(mp.getContainer()); pinArm(false);  // first in the stack: a sheet from below doesn't cover it
    map._rfPinMenu=true;  // this map's right-click menu has Move pin here and ＋ Marker here (markup.js leaves it to pinMenu)
    map.on("contextmenu", e=>{ if(!map._rfMeasuring) pinMenu(e); });
    map.on("rftool", ()=>pinArm(false));  // Measure or Draw started (measure.js, markup.js): one thing at a time
    pinKeys();
    // live readout: where the cursor is, and how far / which way from the pin (shown while there's a pin)
    const Readout=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","legend"); d.id="mapReadout"; d.style.cssText="font:11px ui-monospace,monospace;padding:4px 8px"; d.textContent="Move over the map for position, distance and bearing from the pin"; L.DomEvent.disableClickPropagation(d); return d; }});
    new Readout({position:"bottomleft"}).addTo(map);
    map.on("mousemove", e=>{ const el=$("#mapReadout"); if(!el || !S.center) return; const [la,lo]=S.center, p=e.latlng, R=3958.8, rad=Math.PI/180;
      const dLa=(p.lat-la)*rad, dLo=(p.lng-lo)*rad, h=Math.sin(dLa/2)**2+Math.cos(la*rad)*Math.cos(p.lat*rad)*Math.sin(dLo/2)**2, mi=2*R*Math.asin(Math.sqrt(h));
      const brg=(Math.atan2(Math.sin(dLo)*Math.cos(p.lat*rad), Math.cos(la*rad)*Math.sin(p.lat*rad)-Math.sin(la*rad)*Math.cos(p.lat*rad)*Math.cos(dLo))/rad+360)%360;
      const pts=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"][Math.round(brg/22.5)%16];
      el.textContent=`${S.mapStyle==="atak"&&window.toMGRS?toMGRS(p.lat,p.lng)+" · ":""}${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} · ${mi.toFixed(2)} mi ${pts} (${Math.round(brg)}°) from the pin`; });
    // Fit search area: the one press that brings the whole search back into view (past a new search, nothing else fits)
    const Fit=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","leaflet-bar rf-zoombar"), a=L.DomUtil.create("a","",d);
      a.href="#"; a.id="fitSearch"; a.textContent="⤢"; a.title="Fit search area"; a.setAttribute("role","button"); a.setAttribute("aria-label","Fit search area");
      L.DomEvent.disableClickPropagation(d); L.DomEvent.on(a,"click",e=>{ L.DomEvent.stop(e); fitSearch(); }); return d; }});
    new Fit({position:"topright"}).addTo(map);
    // the view goes in the link as it moves (mv=, search.js), replacing the history entry, never adding one. Only once the
    // address bar is on the Map tab: a map made as the tab opens is fitted inside render(), and replacing there wrote over the
    // tab Back should go back to (review 11/11); render() writes the new tab itself, as a step
    map.on("moveend", ()=>{ if(S.tab==="map" && S.map===map && window.writeUrlState && new URLSearchParams(location.hash.slice(1)).get("tab")==="map") window.writeUrlState(true); });
    // armed by Move pin: this click is where the pin goes, on a dot, a link or a drawing too. It's taken on its way down,
    // before those (they opened the viewer and the pin stayed armed: review 11/11). Not a click that ends a drag, nor one on
    // the map's controls or the viewer (outside the map pane); measuring and drawing take their clicks (measure.js, markup.js).
    // The bare map is the container itself: Leaflet's tiles take no pointer events, so where no dot is drawn (an area with no
    // results) the click landed on the container, and Move pin ignored it (found 11/11 with markers on an empty copy)
    map.getContainer().addEventListener("click", e=>{
      // a plain click only: not the one that ends a shift-drag box zoom (the pin went to its corner), nor one on a popup in
      // the map pane (its ✕ moved the pin: review 11/11)
      if(!map._rfPinArmed || map._rfMeasuring || map._rfDraw?._tool || !(e.target===map.getContainer() || e.target.closest?.(".leaflet-map-pane")) || e.target.closest?.(".leaflet-popup")
        || map.dragging?.moved() || map.boxZoom?.moved?.() || e.shiftKey) return;
      e.stopPropagation(); e.preventDefault(); movePin(map.mouseEventToLatLng(e)); }, true);
    return map;
  }, {gone: m=>{ if(S.map===m){ S.map=null; S.pinMarker=null; S.heatLayer=null; S.heatLegend=null; S.emitLayer=null; } }});
}
// the pin, moved only when asked: a search at the spot, as typing it would
function movePin(ll){ pinArm(false); setMode("point"); $("#loc").value=`${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`; $("#locLabel").textContent=""; S.placeLabel=null; runSearch(); }
function pinArm(on){
  const map=S.map; if(!map) return;
  if(on){ if(map._rfMeasure?._on) map._rfMeasure.stop(); if(map._rfDraw?._tool) map._rfDraw._cancel(); }  // one tool at a time, this way too (review 11/11)
  if(on && window.RFMarkup) RFMarkup.disarm(map);  // and an armed ＋ Marker or a marker's Move ends
  map._rfPinArmed=!!on; map.getContainer().classList.toggle("rf-pin-arming", !!on);
  const b=$("#pinMove"); if(b){ b.classList.toggle("on", !!on); b.setAttribute("aria-pressed", String(!!on));
    b.textContent=on?"📍 Click where it goes":"📍 Move pin"; b.title=on?"Click the map where the pin goes. Esc or this button cancels.":"Move the pin: then click where it goes (once). Or right-click the map (a long press on a touch screen)."; }
}
// right-click or long-press: "Move pin here" where it was pressed, and beside it "＋ Marker here" (a marker there, the pin left
// where it is: markup.js, Cody 11/11); any other press, a move of the map or Esc closes it
function pinMenu(e){
  const map=S.map; if(!map) return; const box=map.getContainer();
  pinArm(false);  // the menu is the other way to move it: Move pin, if armed, is done
  if(window.RFMarkup) RFMarkup.disarm(map);  // and an armed ＋ Marker
  let m=box.querySelector(":scope > .rf-pinmenu");
  if(!m){ m=L.DomUtil.create("div","rf-pinmenu",box); L.DomEvent.disableClickPropagation(m); L.DomEvent.disableScrollPropagation(m); }
  const mark=!!(map._rfDraw && window.RFMarkup && RFMarkup.canEdit(map));  // not for a view-only login
  m.innerHTML='<button type="button" data-pm>📍 Move pin here</button>'+(mark?'<button type="button" data-pmk>＋ Marker here</button>':""); m.hidden=false;
  const p=e.containerPoint; m.style.left=`${Math.max(4, Math.min(p.x, box.clientWidth-(m.offsetWidth||190)-4))}px`; m.style.top=`${Math.max(4, Math.min(p.y, box.clientHeight-(m.offsetHeight||52)-4))}px`;
  const off=()=>{ m.hidden=true; map.off("movestart click zoomstart", off); };
  m.querySelector("[data-pm]").onclick=ev=>{ L.DomEvent.stop(ev); off(); movePin(e.latlng); };
  const k=m.querySelector("[data-pmk]"); if(k) k.onclick=ev=>{ L.DomEvent.stop(ev); off(); map._rfDraw.drop(e.latlng); };
  map.on("movestart click zoomstart", off);
}
function pinKeys(){
  if(S.pinKeyed || !window.RFKeys) return; S.pinKeyed=true;
  const menu=()=>S.map?.getContainer().querySelector(":scope > .rf-pinmenu:not([hidden])");
  const esc=()=>{ pinArm(false); const m=menu(); if(m) m.hidden=true; };  // Shift still held from a click is "shift+escape" (review 11/11)
  RFKeys.scope("pin", {active:()=>!!(S.map && (S.map._rfPinArmed || menu())), keys:{escape:esc, "shift+escape":esc}});
}
document.head.insertAdjacentHTML("beforeend", `<style>.rf-movepin{padding:4px 9px;font:600 12px system-ui;cursor:pointer;background:var(--panel,#fff);color:var(--ink,#111)}
.rf-movepin.on{background:var(--accent,#2f6fed);color:#fff}
.leaflet-container.rf-pin-arming,.rf-pin-arming .leaflet-interactive{cursor:crosshair}
.rf-pinmenu{position:absolute;z-index:1002;padding:4px;border-radius:10px;background:var(--g-strong,var(--panel,#fff));box-shadow:var(--g-shadow,0 4px 14px rgba(0,0,0,.3));border:1px solid var(--line,#8886)}
.rf-pinmenu button{white-space:nowrap}
@media (pointer:coarse){.rf-movepin,.rf-pinmenu button{min-height:40px}}</style>`);
// what a search looked at: only a new one fits the view by itself (the radius, filters, sort, labels, clicks, theme and
// base map never do; Fit search area does when asked). Read from the search's own request (params()) and kept with its
// results: the live mode buttons said "county" or "nationwide" as soon as one was pressed, so the next filter fitted the map
// (review 11/11). A nationwide search is keyed on what it asked, so a new call sign or band fits once; every one used to be
// "n", so the second never fitted.
const NOT_WHAT=["scope","layers","hide_mobile","keep_nofreq","mission","radius"];  // sources and filters: not a new search
function searchKeyOf(p){
  if(p.get("lat")!=null && p.get("lon")!=null) return `p:${+p.get("lat")},${+p.get("lon")}`;
  if(p.get("state")) return `c:${p.get("state")}|${p.get("county")||""}`;
  const k=new URLSearchParams(p); for(const x of NOT_WHAT) k.delete(x); k.sort(); return `n:${k}`;
}
const searchKey = () => S.searched && S.searchKey || "none";
function fitSearch(){
  const map=S.map; if(!map) return;
  if(S.center) map.fitBounds(L.latLng(S.center).toBounds(S.radius*1609.344*2.1));
  else { const pts=filtered().filter(r=>r.lat!=null).map(r=>[r.lat,r.lon]); if(pts.length) map.fitBounds(pts); else map.setView([39.5,-98.35],4); }
}
function drawLayers(rows){
  const map=S.map; if(!map) return;
  S.dotLayer.clearLayers(); S.decoLayer.clearLayers(); S.pinMarker=null;
  const canvas=S.dotsR, deco=S.decoLayer;
  S.markerIndex=new Map();
  const sites=new Map();
  for(const r of rows){ if(r.lat==null) continue; const k=`${r.lat},${r.lon}`; if(!sites.has(k)) sites.set(k,[]); sites.get(k).push(r); }
  for(const [k,rs] of sites){
    const r0=rs[0], tower=rs.some(r=>r.layer==="towers");
    const big = rs.some(r=>r.layer==="uls"||r.layer==="towers"||r.layer==="repeaterbook");
    const mk = S.mapStyle==="atak"&&window.atakIcon ? L.marker([r0.lat,r0.lon],{icon:atakIcon(rs, big), bubblingMouseEvents:false})  // ATAK style: symbol frames
      : L.circleMarker([r0.lat,r0.lon],{renderer:canvas, radius: big ? 5+Math.min(7,Math.sqrt(rs.length)) : 4, bubblingMouseEvents:false,
      color: tower ? "#24292f" : colorOf(r0), weight: tower?3:1.5, fillColor: colorOf(rs.find(r=>r.layer!=="towers")||r0), fillOpacity: big?.75:.55});
    // a click: everything at the spot in the results viewer on the map, lit up in the list and table; no popup, and
    // neither the map nor the page moves (Cody 11/10, after Andy's demo: the popup panned the map, the page scrolled)
    mk.on("click",e=>{ if(window.RFMeasure?.toTool(map, e, mk.getLatLng())) return;  // the ruler or Draw takes it (measure.js)
      S.sel=r0.fid; let first=null;
      $$("#side .item").forEach(x=>{ const hit=rs.some(r=>r.fid===x.dataset.fid); x.classList.toggle("sel",hit); if(hit && !first) first=x; });
      if(first && window.emInView) emInView($("#side"), first);  // the list scrolls to it when it scrolls by itself; the page doesn't
      if(window.emitSpot) emitSpot(rs); });
    mk.addTo(S.dotLayer); S.markerIndex.set(k,mk);
  }
  // mission GPS tracks
  if(S.mission?.tracks) for(const t of S.mission.tracks) L.polyline(t,{renderer:S.quietR,color:"#fb8500",weight:3,opacity:.8,interactive:false}).addTo(deco);
  const ro=$("#mapReadout"); if(ro) ro.style.display=S.center?"":"none";
  if(S.center){
    S.pinMarker=L.marker(S.center,{icon:pinIcon(), interactive:false, keyboard:false, zIndexOffset:1000}).addTo(deco);  // not draggable: Move pin moves it
    const rm=S.radius*1609.344, stepMi=niceStep(S.radius), step=stepMi*1609.344;
    // distance rings, each labelled on its north side
    const ringLabel=(mi,d)=>L.marker([S.center[0]+d/111320, S.center[1]],{interactive:false, icon:L.divIcon({className:"", iconSize:[60,14], iconAnchor:[30,7],
      html:`<span style="font:600 10px system-ui;color:#fff;background:rgba(0,0,0,.55);padding:1px 5px;border-radius:7px;white-space:nowrap">${+mi.toFixed(2)} mi</span>`})}).addTo(deco);
    for(let d=step, i=1; d<rm-1; d+=step, i++){ L.circle(S.center,{renderer:S.quietR,radius:d,color:S.mapStyle==="atak"?"#3ff":"#888",weight:1,dashArray:"3 5",fill:false,interactive:false}).addTo(deco); ringLabel(stepMi*i,d); }
    L.circle(S.center,{renderer:S.quietR,radius:rm,color:"#555",weight:2,fill:false,interactive:false}).addTo(deco); ringLabel(S.radius,rm);
  }
  // the view: fitted for a new search only; back on the Map tab the map gets the view it had (RFMaps keeps it), and a link
  // with the view in it (mv=, search.js) gets that view instead of the fit: only for the link's own search (S.mvWant.gen),
  // and only with the pin in it (a view from somewhere else would hide the new pin: review 11/11)
  const key=searchKey(), want=S.mvWant;
  if(want && S.searched && want.gen===S.searchGen){ const [a,b,z]=want.v; S.mvWant=null; map._rfNew=false; map._rfSig=key; map.setView([a,b],z,{animate:false});
    // a county or nationwide search has no pin: a view outside all of its dots is the same miss; one in a gap between them isn't
    const vb=map.getBounds(), pts=rows.filter(r=>r.lat!=null).map(r=>[r.lat,r.lon]);
    if(S.center ? !vb.contains(S.center) : (pts.length && !L.latLngBounds(pts).intersects(vb))) fitSearch(); }
  else RFMaps.first(map, key, fitSearch);
  if(S.heatImg && !(S.heatLayer && map.hasLayer(S.heatLayer))) addHeatLayer();  // a map made again (back on the tab) gets the heatmap back
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
const heatArea = () => S.center || (S.mode==="county" && $("#state").value && $("#county").value);  // a county heatmap covers the county's entries
// carrier coverage (bdc.py): the carriers with coverage around the pin (or in the map's view), as "provider:tech"
async function heatCarrierFill(){
  const sel=$("#heatCarrier"); if(!sel) return;
  let s,n,w,e;
  if(S.center){ const r=(S.radius||5)*1.609/111, k=Math.cos(S.center[0]*Math.PI/180); [s,n,w,e]=[S.center[0]-r,S.center[0]+r,S.center[1]-r/k,S.center[1]+r/k]; }
  else if(S.map){ const b=S.map.getBounds(); [s,n,w,e]=[b.getSouth(),b.getNorth(),b.getWest(),b.getEast()]; }
  else return;
  let cs=[]; try{ cs=(await api(`/api/bdc/carriers?s=${s}&n=${n}&w=${w}&e=${e}`)).carriers; }catch(err){ /* no carrier list (offline, or no coverage loaded): the picker says none */ }
  sel.innerHTML=cs.length?cs.map(c=>`<option value="${c.provider}:${c.tech}">${esc(c.brand)} ${esc(c.tech_name)}</option>`).join("")
    :'<option value="">No carrier coverage loaded here (Data &amp; updates)</option>';
  if(!cs.some(c=>`${c.provider}:${c.tech}`===S.heat.carrier)) S.heat.carrier=cs.length?`${cs[0].provider}:${cs[0].tech}`:"";
  sel.value=S.heat.carrier||"";
}
function heatParams(kind){
  const s=S.mission?.settings||{};
  return {kind, size:s.heat_size||200, metric:s.heat_metric||"mean", combine:s.heat_combine||"max", alpha:s.heat_alpha||190,
    ...facetParams(), layers:[...S.layerOn].join(","), name:(S.mission?.name||"rf")+"_"+kind,
    ...(kind==="measured"?{files:[...(S.heat.files||[])].join("|"), ident:S.heat.ident||"", freq:S.heat.freq??""}:{}),
    ...(kind==="carrier"?{provider:(S.heat.carrier||":").split(":")[0], tech:(S.heat.carrier||":").split(":")[1], ...(S.heat.env!==undefined&&S.heat.env!==""?{env:S.heat.env}:{})}:{})};
}
// the measured heatmap's Files list floats over the map: Escape or a press outside closes it, like every other layer
// (11/3: only its own summary did)
document.addEventListener("keydown", e=>{ const d=$("#heatFiles"); if(e.key==="Escape" && d?.open) d.open=false; });
document.addEventListener("pointerdown", e=>{ const d=$("#heatFiles"); if(d?.open && !d.contains(e.target)) d.open=false; }, true);
async function loadHeat(){
  if(S.heatLayer && S.map){ S.map.removeLayer(S.heatLayer); } S.heatLayer=null; S.heatImg=null;
  if(S.heatLegend && S.map){ S.map.removeControl(S.heatLegend); S.heatLegend=null; }
  if(S.heat.kind==="off") return;
  if(!heatArea()){ $("#status").textContent="Heatmaps need a pin or a county: drop a pin, or pick a county, then press Show what's here."; return; }
  // no carrier to draw: say so instead of asking the server (11/3: it answered HTTP 500 and a raw "ValueError")
  if(S.heat.kind==="carrier" && !S.heat.carrier){ $("#status").textContent="No carrier coverage is loaded for this area yet (Data & updates, FCC carrier coverage)."; return; }
  $("#status").textContent="Building heatmap…";
  try{ const h=await api("/api/heatmap?"+params(heatParams(S.heat.kind))); S.heatImg=h; $("#status").textContent=""; addHeatLayer(); }
  catch(e){ $("#status").textContent="Heatmap: "+e.message; }
}
function addHeatLayer(){
  const h=S.heatImg; if(!h||!S.map) return;
  if(S.heatLayer) S.map.removeLayer(S.heatLayer); if(S.heatLegend) S.map.removeControl(S.heatLegend);  // one at a time, now that the map stays (11/10)
  S.heatLayer=L.imageOverlay("data:image/png;base64,"+h.png, h.bounds, {opacity:S.heat.opacity, interactive:false}).addTo(S.map);
  const Lg=L.Control.extend({onAdd(){ const d=L.DomUtil.create("div","legend"); d.innerHTML=`<div>${esc(h.desc)}</div><div class="bar"></div><div style="display:flex;justify-content:space-between"><span>${num(h.vmin,0)}</span><span>${esc(h.unit)}</span><span>${num(h.vmax,0)}</span></div>`; L.DomEvent.disableClickPropagation(d); return d; }});
  S.heatLegend=new Lg({position:"bottomleft"}); S.heatLegend.addTo(S.map);
}

/* ---------- detail ---------- */
function kvg(pairs){ return `<div class="kvg">${pairs.filter(p=>p[1]!==""&&p[1]!=null&&p[1]!==undefined).map(([k,v])=>`<div>${k}</div><div>${v}</div>`).join("")}</div>`; }
// a DMR or NXDN reading that decoded a radio ID: who it belongs to, from RadioID.net, one look-up when asked (radioid.py)
function radioIdLookup(r, host){
  const kind=/NXDN/i.test(`${r.sig_type||""} ${r.kind||""}`)?"nxdn":/DMR/i.test(`${r.sig_type||""} ${r.kind||""}`)?"dmr":null;
  if(!kind) return;
  let extra={}; try{ extra=JSON.parse(r.details||r.extra||"{}")||{}; }catch(e){ /* not JSON: the record shows without extra fields */ }
  const fromExtra=Object.entries(extra).find(([k,v])=>/^(radio_?id|src(_?id)?|source_?id|unit(_?id)?|rid|from)$/i.test(k)&&/^\d{3,8}$/.test(String(v).trim()));
  const rid=fromExtra?String(fromExtra[1]).trim():(/^\d{6,8}$/.test(String(r.ident||"").trim())?String(r.ident).trim():null);
  if(!rid) return;
  const box=document.createElement("div"); box.className="sec";
  box.innerHTML=`<h3>Radio ID ${esc(rid)}</h3><div data-rid-out><button data-rid-go>Who is it? (RadioID.net)</button></div>`;
  host.appendChild(box);
  const out=box.querySelector("[data-rid-out]");
  box.querySelector("[data-rid-go]").onclick=async()=>{ out.textContent="Asking RadioID.net…";
    try{ const a=await api(`/api/radioid?kind=${kind}&id=${encodeURIComponent(rid)}`);
      out.innerHTML=a.found?kvg([["Call sign",`<span class="mono">${esc(a.callsign||"")}</span>`],["Name",esc(a.name||"")],["Place",esc([a.city,a.state,a.country].filter(Boolean).join(", "))],["Source",`RadioID.net, looked up ${esc(a.looked_up||"")}`]])
        :`<p class="hint">RadioID.net has no ${kind.toUpperCase()} radio ID ${esc(rid)}.</p>`; }
    catch(e){ out.innerHTML=`<p class="hint">${esc(e.message)}</p>`; } };
}

// One entry's details. The Map tab shows them in the results viewer's Details tab (emitter.js, results.js); the Analyzer and the
// Site profile in the dialog (openDetail). opt.go(tab) shows its coverage, network or cell site where the details are (without
// it, on the Map tab); opt.saved() runs after a label or an observation is saved (Cody 11/10: saving keeps the viewer open).
const detailTitle = r => `${r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span> · `:""}${esc(titleOf(r))}`;
function openDetail(fid){
  const r=S.rows.find(x=>x.fid===fid); if(!r) return;
  $("#dlgTitle").innerHTML=detailTitle(r);
  fillDetail($("#dlgBody"), r, {saved:()=>{ $("#dlg").close(); render(); }});
  $("#dlg").showModal();
}
function fillDetail(body, r, opt={}){
  const q=s=>body.querySelector(s);
  const uls = r.layer==="uls"||r.layer==="uls_hist";
  const lib = S.lib[r.sig_type];
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
      ["Ground elevation",r.ground_elev_m!=null?`${r.ground_elev_m} m`:""],["Owner",esc(r.owner)],["Carrier",r.carrier?`${esc(r.carrier)}-registered structure. That's the owner on the FCC record: other carriers may rent space here.`:""],["Status",esc(r.status)],["Constructed",esc(r.constructed)],["FAA study",esc(r.faa_study)],
      ["Address",esc([r.street,r.city,r.state].filter(Boolean).join(", "))]])}
      <h3 style="margin-top:10px">Licensed transmitters on this structure</h3><p>${esc([...new Set(S.rows.filter(x=>x.tower_reg===r.reg).map(x=>`${x.licensee} (${fmtF(x.freq_mhz)})`))].slice(0,30).join("; ")||"None linked in the current results.")}</p></div>`;
  } else {
    let extra={}; try{ extra=JSON.parse(r.details||r.extra||"{}")||{}; }catch(e){ /* not JSON: the record shows without extra fields */ }
    html += `<div class="sec"><h3>Record</h3>${kvg([["Type / tech",esc(r.kind||"")],["Label / SSID",esc(r.label||"")],["Identifier",`<span class="mono">${esc(r.ident||r.ext_id||"")}</span>`],
      ["Frequency",r.freq_mhz?`<span class="mono">${fmtF(r.freq_mhz)} MHz</span>${r.freq_in_mhz?` (input ${fmtF(r.freq_in_mhz)})`:""} · ${esc(r.band||"")}`:""],["Channel",esc(r.channel||"")],
      ["Level",r.dbm!=null?`${r.dbm} dBm`:""],["Bandwidth",r.bw_khz?`${r.bw_khz} kHz`:""],["Mode / tones",esc(r.mode||"")],["Security",esc(r.auth||"")],
      ["Time",esc(r.ts||"")],["First / last seen",r.first_seen||r.last_seen?`${esc(r.first_seen||"?")} → ${esc(r.last_seen||"?")}`:""],
      ["GPS accuracy",r.acc!=null?`${r.acc} m`:""],["Capture",esc(r.capture_name||"")],["Fetched",esc(r.fetched_at||"")]])}</div>
      ${Object.keys(extra).length?`<div class="sec"><h3>All fields</h3>${kvg(Object.entries(extra).map(([k,v])=>[esc(k),`<span class="mono">${esc(typeof v==="object"?JSON.stringify(v):v)}</span>`]))}</div>`:""}`;
  }
  html += window.sigMeta ? window.sigMeta(r) : "";  // band, channel, pairing, what a scan adds, every field on file (sigmeta.js)
  body.innerHTML=html;
  radioIdLookup(r, body);
  if(r.also_in?.length){  // the same emitter from several sources: who reported it, and where they disagree
    const box=document.createElement("div"); box.className="sec"; const cf=Object.entries(r.conflicts||{});
    const ind=r.independent||1;  // independent origins, not rows (provenance.py): copies of one source count once
    box.innerHTML=`<h3>Sources (${r.merged_from} record${r.merged_from===1?"":"s"}, ${ind} independent origin${ind===1?"":"s"})</h3><p style="margin:0 0 6px">${esc([r.category||LAYERS[r.layer]?.label, ...r.also_in].join(" · "))}</p>
      ${ind===1?`<p style="margin:0 0 6px"><span class="tag" title="Every record here comes from one origin group">single source</span> <span class="hint">${esc((r.origins||[]).join(""))}: these records share an origin, so they don't confirm each other.</span></p>`
        :`<p class="hint" style="margin:0 0 6px">Origins: ${esc((r.origins||[]).join(", "))}</p>`}
      ${cf.length?`<p class="hint" style="margin:0 0 4px">Where they disagree, each source's value:</p>${kvg(cf.map(([f,vals])=>[esc(f.replace(/_/g," ")), vals.map(([s,v])=>`${esc(v)} <span class="hint">(${esc(s)})</span>`).join("<br>")]))}`
        :'<p class="hint" style="margin:0">They agree on everything they both report.</p>'}`;
    body.prepend(box); }
  if(r.lat!=null && r.layer!=="towers"){  // the same emitter on the map: where it reaches, what it's networked with, its cell site
    const acts=[(erpOf(r)||emIsCell(r))&&["coverage","Coverage on the map"], emIsUls(r)&&["network","Network"], emIsCell(r)&&["cell","Cell site"]].filter(Boolean);
    if(acts.length){ const bar=document.createElement("div"); bar.className="row no-print"; bar.style.cssText="gap:6px;margin-bottom:8px";
      bar.innerHTML=acts.map(([k,l])=>`<button data-emd="${k}">${l}</button>`).join("");
      bar.querySelectorAll("[data-emd]").forEach(b=>b.onclick=()=>(opt.go||(t=>emitOpen(r, t)))(b.dataset.emd)); body.prepend(bar); }
  }
  if(uls && r.call_sign){  // the same licence on the FCC's own site and on RadioReference (links only: RR's data can't be copied)
    const box=document.createElement("div"); box.className="sec";
    box.innerHTML=`<h3>RadioReference</h3><p><a href="https://www.radioreference.com/db/fcc/callsign/${encodeURIComponent(r.call_sign)}" target="_blank" rel="noopener">${esc(r.call_sign)} on RadioReference</a>
      ${rrStateUrl(r.state)?` · <a href="${rrStateUrl(r.state)}" target="_blank" rel="noopener">RadioReference: ${esc(r.state)} systems and counties</a>`:""}</p>`;
    body.appendChild(box);
  }
  if(r.freq_mhz){  // what it could be, from the Signal Identification Wiki catalog (cached locally)
    const box=document.createElement("div"); box.className="sec"; const head='<h3>Signal Identification Wiki: what this could be</h3>';
    box.innerHTML=head+'<p class="hint">Looking…</p>'; body.appendChild(box);
    api(`/api/sigwiki/match?freq=${r.freq_mhz}&bw=${r.bandwidth_khz||r.bw_khz||""}&type=${encodeURIComponent(r.sig_type||"")}`).then(m=>{
      box.innerHTML=head+(m.candidates.length?m.candidates.map(c=>`<div style="margin:6px 0"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>
        <span class="hint">${esc(c.why.join(" · "))}${c.mode?` · ${esc(c.mode)}`:""}${c.modulation?` · ${esc(c.modulation)}`:""}</span><br><span class="hint">${esc(c.description)}</span>
        ${c.media?`<div class="row" style="gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">${c.media.image?`<a href="${esc(c.media.image)}" target="_blank" rel="noopener" title="The waterfall, full size"><img src="${esc(c.media.image)}" alt="Waterfall of ${esc(c.title)}" loading="lazy" style="height:72px;max-width:260px;object-fit:cover;border-radius:6px;background:#000"></a>`:""}
          ${c.media.audio?`<audio controls preload="none" src="${esc(c.media.audio)}" style="height:32px;max-width:260px"></audio>`:""}</div>`:""}</div>`).join("")
        :'<p class="hint">Nothing in the catalog covers this frequency. It covers digital and unusual signals; everyday voice, broadcast and weather radio are in the band plan.</p>')
        +`<p class="hint">From sigidwiki.com${m.candidates.some(c=>c.media)?"; waterfalls and audio from the Artemis database on this PC":""}. Open a page for more samples and decoding notes.</p>`; })
      .catch(()=>{ box.innerHTML=head+'<p class="hint">Catalog not loaded yet: Data &amp; updates → Signal ID Wiki catalog → Run now.</p>'; });
  }
  const saved=opt.saved||(()=>render());
  if(q("#ovSave")) q("#ovSave").onclick=async()=>{ const d={call_sign:r.call_sign,freq_mhz:r.freq_mhz,county:r.county,state:r.state,alpha_tag:q("#ovTag").value,tone:q("#ovTone").value,tag:q("#ovT").value,description:q("#ovDesc").value,notes:q("#ovNotes").value,verified:q("#ovVer").checked};
    await post("/api/overlay",d); for(const x of S.rows) if(x.call_sign===r.call_sign&&fmtF(x.freq_mhz)===fmtF(r.freq_mhz)) Object.assign(x,{ov_alpha_tag:d.alpha_tag,ov_tone:d.tone,ov_tag:d.tag,ov_description:d.description,ov_notes:d.notes,ov_verified:d.verified?1:0}); saved(); };
  if(q("#obSave")) q("#obSave").onclick=async()=>{ const d={mission_id:S.missionId,freq_mhz:r.freq_mhz,call_sign:r.call_sign,status:q("#obStatus").value,level_dbm:q("#obLevel").value===""?null:+q("#obLevel").value,notes:q("#obNotes").value};
    await post("/api/observation",d); for(const x of S.rows) if(x.call_sign===r.call_sign&&fmtF(x.freq_mhz)===fmtF(r.freq_mhz)) Object.assign(x,{obs_status:d.status,obs_level:d.level_dbm,obs_notes:d.notes}); saved(); };
}
// A spot on a map other than the Map tab's (the Dashboard's): what's there and each entry's details, in the results viewer on
// that map (results.js), which stays where it is. Coverage, network and cell site, and "On the Map tab", go to the Map tab.
function spotView(map, rs, pick){
  const items=groupItems(rs), r0=items[0]; if(!r0 || !window.RFResults) return;
  const st={r:pick||r0, tab:pick||items.length===1?"detail":"info"};
  const draw=()=>RFResults.show(map, {key:`spot:${r0.lat},${r0.lon}`, label:titleOf(st.r),
    title:items.length>1&&st.tab==="info"?`${items.length} entries here`:detailTitle(st.r),
    sub:[r0.dist_mi!=null?`${num(r0.dist_mi,2)} mi ${esc(r0.compass||"")} from the pin`:"", `${(+r0.lat).toFixed(5)}, ${(+r0.lon).toFixed(5)}`].filter(Boolean).join(" · "),
    tabs:[...(items.length>1?[{id:"info", label:`On this spot (${items.length})`}]:[]), {id:"detail", label:"Details"}], tab:st.tab,
    onTab:id=>{ st.tab=id; draw(); },
    fill:body=>{
      if(st.tab==="detail"){ fillDetail(body, st.r, {saved:()=>{ render(); draw(); }}); return; }
      body.innerHTML=`<div class="tw"><table><thead><tr><th>MHz</th><th>What</th><th>Type</th><th>Source</th></tr></thead><tbody>${items.map((r,i)=>`<tr data-i="${i}" style="cursor:pointer${r===st.r?";font-weight:700":""}"><td class="mono">${r.freq_mhz?fmtF(r.freq_mhz):""}</td><td>${esc(titleOf(r))}</td><td>${esc(typeOf(r))}</td><td>${esc(LAYERS[r.layer]?.label||r.layer)}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint">Click one for its details.</p>`;
      body.querySelectorAll("tr[data-i]").forEach(tr=>tr.onclick=()=>{ st.r=items[+tr.dataset.i]; st.tab="detail"; draw(); }); },
    actions:[{label:"On the Map tab", title:"Open this spot on the Map tab, with its coverage, network and cell site", run:()=>{ setTab("map"); if(window.emitSpot) emitSpot(rs, st.r); }}],
    zoom:[+r0.lat, +r0.lon]}, [+r0.lat, +r0.lon]);
  draw();
}
// a table row's details: in the dialog, except the Map tab's table and anything in a results viewer, which show in the viewer
document.addEventListener("click", e => { const tr=e.target.closest("tr[data-fid]"); if(tr && !tr.closest("#pktTable, #mapTable, .rf-res")) openDetail(tr.dataset.fid); });

/* ---------- wiring ---------- */
function setMode(m){ S.mode=m; $$("#modeSeg button").forEach(x=>x.classList.toggle("on",x.dataset.m===m));
  $("#locWrap").style.display=m==="point"?"":"none"; $("#countyWrap").style.display=m==="county"?"":"none";
  for(const el of [$("#radius").closest("label"), $("#radiusSlider").closest("label"), $("#gpsBtn")]) el.style.display=m==="nationwide"?"none":""; }
$("#modeSeg").addEventListener("click", e=>{ const b=e.target.closest("button"); if(b) setMode(b.dataset.m); });
$("#go").onclick=runSearch;
// the filters the server reads. On a desktop they search by themselves after a pause; on a phone, or nationwide, they wait for
// the button and it says so (Cody 11/5: a search is 1.7 to 22 MB, and a phone on a roof shouldn't pay for a half-typed frequency)
const AUTO_MS=700;
const autoRuns=()=>matchMedia("(min-width:700px) and (pointer:fine)").matches && S.mode!=="nationwide" && (S.mode==="point"?!!parseLoc($("#loc").value):!!$("#state").value);
let dirtyT;
function searchDirty(){
  const stale=S.lastQuery!=null && params().toString()!==S.lastQuery, auto=autoRuns(), go=$("#go");
  clearTimeout(dirtyT);
  go.classList.toggle("stale",stale&&!auto); go.textContent=stale&&!auto?"Apply: show what's here":"Show what's here";  // not "Search": the Search tab is the search over everything (UX review 11/8 #16)
  if(stale&&auto&&$("#q").value.trim().length!==1) dirtyT=setTimeout(runSearch,AUTO_MS);
}
for(const id of ["#q","#fmin","#fmax"]) $(id).addEventListener("input",searchDirty);
$("#hideMobile").addEventListener("change",searchDirty);
for(const id of ["#loc","#q","#fmin","#fmax","#rf"]) $(id).addEventListener("keydown", e=>{ if(e.key==="Enter") runSearch(); });
let rT; const radiusChanged=v=>{ $("#radius").value=v; $("#radiusSlider").value=v; clearTimeout(rT); rT=setTimeout(()=>{ if(parseLoc($("#loc").value)) runSearch(); },450); };
$("#radius").oninput=e=>radiusChanged(e.target.value); $("#radiusSlider").oninput=e=>radiusChanged(e.target.value);
// ◎ GPS: the search where the device stands, named "Your location (lat, lon)" (the Towers tab's report, title, print and link
// say it; the last address's name stayed on the GPS spot before). On Towers it sits beside the address box: one tap on site.
// A search sets the spot, so Move pin, if armed, is done.
$("#gpsBtn").onclick=()=>navigator.geolocation?navigator.geolocation.getCurrentPosition(p=>{ const ll=`${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`;
    pinArm(false); $("#loc").value=ll; S.placeLabel=`Your location (${ll})`; $("#locLabel").textContent="📍 "+S.placeLabel; setMode("point"); runSearch(); },
  err=>{ $("#status").textContent="GPS unavailable: "+err.message+" (browsers only allow GPS on localhost or HTTPS)."; }, {enableHighAccuracy:true, timeout:20000, maximumAge:30000}):null;
$("#state").onchange=async()=>{ const cs=await api("/api/counties?state="+$("#state").value);
  $("#county").innerHTML='<option value="">— whole state —</option>'+cs.map(c=>`<option value="${esc(c.county)}">${esc(c.county)} (${c.n.toLocaleString()})</option>`).join(""); };
$("#clearChips").onclick=()=>{ filtersReset(); render(); };
// what's on screen; "Everything the search found" leaves the filter groups out
const exportParams=()=>params({layers:[...S.layerOn].join(","), ...($("#exportAll")?.checked?{}:facetParams())});
$("#csvBtn").onclick=()=>getFile("/api/export.csv?"+exportParams());
$("#kmlBtn").onclick=()=>getFile("/api/export.kml?"+exportParams());
$("#printBtn").onclick=()=>{ setTab("profile"); setTimeout(()=>{ document.body.classList.add("print-prep"); window.print(); setTimeout(()=>document.body.classList.remove("print-prep"),500); },80); };
$("#themeBtn").onclick=()=>{ const d=document.documentElement, dark=matchMedia("(prefers-color-scheme: dark)").matches;
  const cur=d.dataset.theme||(dark?"dark":"light"); d.dataset.theme=cur==="dark"?"light":"dark"; try{localStorage.setItem("theme",d.dataset.theme);}catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } render(); };
try{ const t=localStorage.getItem("theme"); if(t) document.documentElement.dataset.theme=t; }catch(e){ /* storage blocked (a private window): the default stands */ }

async function boot(){
  try{
    const asks=[api("/api/meta"), api("/api/states"), api("/api/sigid")];
    asks.forEach(a=>a.catch(()=>{}));  // a failure is read below (Promise.all), not reported as unhandled while the build is awaited
    // personal or sold, what the sold build leaves out, the data notices (build.py): on its own, so another request failing
    // doesn't leave the personal build on the sold copy's maps all session, saving Topo (11/11 review: /api/sigid answering 500)
    S.build=await api("/api/build").catch(()=>null);
    const [meta, states, lib] = await Promise.all(asks);
    S.lib=lib.library; S.bandplan=lib.bandplan; S.meta=meta;
    $("#meta").textContent = meta.built_at ? `FCC data ${meta.built_at}${meta.uls_daily_asof?` + daily changes to ${meta.uls_daily_asof.slice(0,10)}`:""} · ${Number(meta.tx_rows||0).toLocaleString()} entries${meta.towers_rows?` · ${Number(meta.towers_rows).toLocaleString()} towers`:""}` : "No FCC data yet — see Data & updates";
    $("#state").innerHTML='<option value="">—</option>'+states.map(s=>`<option>${esc(s.state)}</option>`).join("");
    $("#meta").title=$("#meta").textContent;
  }catch(e){ $("#meta").textContent="Server error: "+e.message; }
  if(window.missionBoot) await window.missionBoot();
  if(S.meta && !S.meta.built_at && !S.remote && window.welcome) window.welcome();  // a new copy with no data yet (welcome.js)
  try{ if(!location.hash && localStorage.getItem("rfr.landing")==="start") S.tab="start"; }catch(e){ /* storage blocked: the Map, as always */ }
  if(window.applyUrlState && window.applyUrlState(true)) runSearch();  // a link to a view wins over the mission's area
  render();
}
window.addEventListener("load", boot);
