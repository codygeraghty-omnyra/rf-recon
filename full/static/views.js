"use strict";
/* RF Recon — views: table, analyzer (Wireshark-style), dashboard (Kibana-style), topology, profile, agencies, spectrum. */

const countBy=(rows,fn)=>{ const m=new Map(); for(const r of rows) for(const k of [].concat(fn(r))) m.set(k,(m.get(k)||0)+1); return [...m].sort((a,b)=>b[1]-a[1]); };
function bars(entries, colorFn, click){ const max=Math.max(1,...entries.map(e=>e[1]));
  return `<div class="bars">${entries.map(([k,n])=>`<div ${click?`data-click="${esc(click)}" data-v="${esc(k)}"`:""}><span title="${esc(k)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><span class="bar" style="width:${Math.max(2,100*n/max)}%;${colorFn?`background:${colorFn(k)}`:""}"></span><span class="mono" style="text-align:right">${n.toLocaleString()}</span></div>`).join("")}</div>`; }
document.addEventListener("click", e=>{ const b=e.target.closest("[data-click]"); if(!b) return;
  const k=b.dataset.click, v=b.dataset.v; if(k==="layer"){ const id=Object.keys(LAYERS).find(x=>LAYERS[x].label===v)||v; S.layerOn.has(id)?S.layerOn.delete(id):S.layerOn.add(id); render(); } else toggleChip(k,v); });
const typeColor = t => S.lib[t]?.color || (t==="Tower / structure"?"#57606a":"#8c959f");

/* ---------- generic sortable table ---------- */
const COLS={
  dist:["Dist mi",r=>num(r.dist_mi,2),"n","dist_mi"], brg:["Bearing",r=>r.bearing!=null?`${r.bearing}° ${r.compass}`:"","","bearing"],
  freq:["Frequency",r=>fmtF(r.freq_mhz),"f","freq_mhz"], src:["Source",r=>`<span class="dot" style="background:${LAYERS[r.layer]?.color}"></span> ${esc(LAYERS[r.layer]?.label||r.layer)}`,"","layer"],
  type:["Type",r=>`<span class="dot" style="background:${colorOf(r)}"></span> ${esc(typeOf(r))}`,"","sig_type"], title:["Name / licensee",r=>esc(titleOf(r)),"","label"],
  tag:["Alpha tag",r=>esc(r.ov_alpha_tag||"")+(r.ov_verified?' <span class="tag v">✓</span>':""),"","ov_alpha_tag"],
  em:["Emission",r=>`<span class="mono">${esc(r.emissions||r.channel||"")}</span>`,"","emissions"], cls:["Station",r=>esc(classLabel(r.station_class)),"","station_class"],
  erp:["ERP W",r=>num(erpOf(r)),"n","erp_w"], lvl:["dBm",r=>levelOf(r)!=null?num(levelOf(r),1)+(r.dbm==null?" est":""):"","n","dbm"],
  h:["AGL m",r=>num(r.height_tip_m??r.overall_agl_m),"n","height_tip_m"], call:["Call / ID",r=>`<span class="mono">${esc(r.call_sign||r.ident||r.reg||"")}</span>`,"","call_sign"],
  obs:["On site",r=>r.obs_status?`<span class="tag ${r.obs_status==="heard"?"v":""}">${esc(r.obs_status)}${r.obs_level!=null?" "+r.obs_level+" dBm":""}</span>`:"","","obs_status"],
  site:["Site",r=>esc([r.city,r.county,r.state].filter(Boolean).join(", ")),"","city"],
};
S.views.freqTable = (rows, compact, cols) => {
  cols = cols || (S.center ? ["dist","brg","freq","src","type","title","tag","em","cls","erp","lvl","h","call","obs"] : ["freq","src","type","title","tag","em","cls","erp","h","site","call","obs"]);
  let list=rows;
  if(!compact){ const {k,dir}=S.sort, key=COLS[k]?COLS[k][3]:"dist_mi";
    list=rows.slice().sort((a,b)=>{ const x=a[key],y=b[key]; if(x==null) return 1; if(y==null) return -1; return (x>y?1:x<y?-1:0)*dir; }); }
  const shown=compact?list:list.slice(0,S.shown);
  return `<div class="tw" style="max-height:70vh"><table><thead><tr>${cols.map(c=>`<th ${compact?"":`data-sort="${c}"`}>${COLS[c][0]}${!compact&&S.sort.k===c?(S.sort.dir>0?" ▲":" ▼"):""}</th>`).join("")}</tr></thead><tbody>`+
    shown.map(r=>`<tr data-fid="${esc(r.fid)}">${cols.map(c=>`<td class="${COLS[c][2]}">${COLS[c][1](r)}</td>`).join("")}</tr>`).join("")+
    `</tbody></table></div>`+(!compact&&list.length>shown.length?`<button id="moreTbl" style="margin:8px">Show more (${(list.length-shown.length).toLocaleString()})</button>`:"");
};
document.addEventListener("click", e=>{ const th=e.target.closest("th[data-sort]"); if(th){ const k=th.dataset.sort; S.sort={k,dir:S.sort.k===k?-S.sort.dir:1}; render(); }
  if(e.target.id==="moreTbl"){ S.shown+=1000; render(); } });

/* ---------- display filter (Wireshark-like) ---------- */
const ALIAS={freq:"freq_mhz",frequency:"freq_mhz",type:"sig_type",sig:"sig_type",dist:"dist_mi",distance:"dist_mi",rssi:"dbm",level:"dbm",power:"erp_w",erp:"erp_w",
  src:"layer",source:"layer",call:"call_sign",callsign:"call_sign",ssid:"label",name:"label",mac:"ident",bssid:"ident",id:"ident",cat:"category",station:"station_class",
  emission:"emissions",height:"height_tip_m",time:"ts",service:"service",band:"band",mode:"mode",licensee:"licensee",tag:"ov_alpha_tag",status:"status"};
function tokenize(s){ const out=[]; let i=0;
  const re=/\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(==|!=|>=|<=|&&|\|\||[><!()~])|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w.]*))/y;
  while(i<s.length){ re.lastIndex=i; const m=re.exec(s); if(!m){ if(/^\s*$/.test(s.slice(i))) break; throw new Error("Unexpected text at “"+s.slice(i,i+12)+"”"); }
    i=re.lastIndex; if(m[1]) out.push({t:"str",v:m[1].slice(1,-1)}); else if(m[2]) out.push({t:"op",v:m[2]}); else if(m[3]) out.push({t:"num",v:parseFloat(m[3])});
    else { const w=m[4].toLowerCase(); if(w==="and") out.push({t:"op",v:"&&"}); else if(w==="or") out.push({t:"op",v:"||"}); else if(w==="not") out.push({t:"op",v:"!"});
      else if(w==="contains"||w==="matches") out.push({t:"op",v:w}); else if(w==="eq") out.push({t:"op",v:"=="}); else if(w==="ne") out.push({t:"op",v:"!="});
      else if(w==="gt") out.push({t:"op",v:">"}); else if(w==="lt") out.push({t:"op",v:"<"}); else if(w==="ge") out.push({t:"op",v:">="}); else if(w==="le") out.push({t:"op",v:"<="});
      else out.push({t:"id",v:m[4]}); } }
  return out; }
function compileFilter(src){
  const T=tokenize(src); let p=0; const peek=()=>T[p], take=()=>T[p++];
  const field=n=>{ const k=ALIAS[n.toLowerCase()]||n; return r=>{ if(k==="layer") return r.layer; const v=r[k]; return v; }; };
  function orE(){ let l=andE(); while(peek()&&peek().v==="||"){ take(); const r=andE(), a=l; l=x=>a(x)||r(x); } return l; }
  function andE(){ let l=notE(); while(peek()&&peek().v==="&&"){ take(); const r=notE(), a=l; l=x=>a(x)&&r(x); } return l; }
  function notE(){ if(peek()&&peek().v==="!"){ take(); const e=notE(); return x=>!e(x); } return prim(); }
  function prim(){ const t=take(); if(!t) throw new Error("Incomplete filter");
    if(t.v==="("){ const e=orE(); if(!peek()||peek().v!==")") throw new Error("Missing )"); take(); return e; }
    if(t.t!=="id") throw new Error("Expected a field name, got “"+t.v+"”");
    const get=field(t.v), op=peek();
    if(!op||op.t!=="op"||["&&","||",")"].includes(op.v)) return x=>{ const v=get(x); return v!=null&&v!==""&&v!==0; };
    take(); const val=take(); if(!val||val.t==="op") throw new Error("Expected a value after "+op.v);
    const V=val.v, sv=String(V).toLowerCase();
    if(op.v==="contains") return x=>String(get(x)??"").toLowerCase().includes(sv);
    if(op.v==="matches"||op.v==="~"){ const rx=new RegExp(String(V),"i"); return x=>rx.test(String(get(x)??"")); }
    return x=>{ let a=get(x); if(a==null) return op.v==="!="; const n=typeof V==="number"||(!isNaN(parseFloat(V))&&isFinite(V));
      if(n && !isNaN(parseFloat(a))){ a=parseFloat(a); const b=parseFloat(V); return {"==":a===b,"!=":a!==b,">":a>b,"<":a<b,">=":a>=b,"<=":a<=b}[op.v]; }
      a=String(a).toLowerCase(); return {"==":a===sv,"!=":a!==sv,">":a>sv,"<":a<sv,">=":a>=sv,"<=":a<=sv}[op.v]; }; }
  const e=orE(); if(p<T.length) throw new Error("Unexpected “"+T[p].v+"”"); return e;
}

/* ---------- analyzer ---------- */
const AN_COLS=[["no","No."],["time","Time"],["dt","Δs"],["src","Source"],["type","Type"],["freq","Freq MHz"],["ident","Ident"],["name","Name"],["dbm","dBm"],["dist","Dist mi"],["band","Band"],["info","Info"]];
const PRESETS=[["Digital land mobile",'type == "P25 Phase 1" || type == "P25 Phase 2" || type == "DMR" || type == "NXDN" || type == "TETRA"'],
  ["Strong (> -70 dBm)","dbm > -70 || est_rx_dbm > -70"],["Within 1 mi","dist < 1"],["Repeaters",'station == "FB2" || src == "repeaterbook"'],
  ["My captures only",'src == "captures"'],["Open Wi-Fi",'type == "Wi-Fi" && !(auth contains "WPA") && !(mode contains "WPA")'],["Cellular",'type == "LTE" || type == "5G NR" || type == "GSM" || type == "WCDMA/UMTS"'],
  ["Public safety",'category contains "public safety" || category contains "law" || category contains "fire"'],["Expired / removed",'src == "uls_hist"']];
function infoOf(r){
  if(r.layer==="uls"||r.layer==="uls_hist") return `${classLabel(r.station_class)} · ${r.service||""} · ERP ${num(erpOf(r))} W · ${r.emissions||""}${r.freq_upper_mhz?` · in ${fmtF(r.freq_upper_mhz)}`:""}`;
  if(r.layer==="towers") return `${r.struct_type||""} ${r.overall_agl_m??"?"} m AGL · ${r.owner||""}`;
  return [r.kind, r.channel&&`ch ${r.channel}`, r.auth||r.mode, r.bw_khz&&`${r.bw_khz} kHz`, r.sig_basis].filter(Boolean).join(" · ");
}
function isoTime(s){ if(!s) return ""; s=String(s).trim(); let m;
  if((m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s))) return `${m[3]}-${m[1]}-${m[2]}`;            // FCC MM/DD/YYYY
  if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.replace(" ","T");
  return s; }
function timeOf(r){ return isoTime(r.ts || r.last_seen || r.grant_date || r.constructed || ""); }
const tval = r => { const t=Date.parse(timeOf(r)); return isNaN(t) ? Infinity : t; };
S.views.analyzer = (v, rowsIn) => {
  let rows=rowsIn, err="";
  if(S.filterExpr.trim()){ try{ const f=compileFilter(S.filterExpr); rows=rowsIn.filter(r=>{ try{ return f(r); }catch(e){ return false; } }); }catch(e){ err=e.message; } }
  const order=S.anOrder||"time", dir=S.anDir||1;
  const key={time:tval, dist:r=>r.dist_mi??1e9, freq:r=>r.freq_mhz??1e9, level:r=>-(levelOf(r)??-999)}[order];
  rows=rows.slice().sort((a,b)=>{ const x=key(a),y=key(b); return (x>y?1:x<y?-1:0)*dir; });
  const hide=S.anHide||(S.anHide=new Set());  // columns the user turned off
  S.anRows=rows;
  const t0=rows.length&&order==="time"?tval(rows[0]):NaN;
  v.innerHTML=`
    <div class="panel"><div class="filterbar">
      <input id="dfilter" class="${S.filterExpr?(err?"bad":"ok"):""}" placeholder='Display filter, e.g.  type == "DMR" && dbm > -80   ·   freq >= 450 && freq < 470   ·   licensee contains "county"' value="${esc(S.filterExpr)}">
      <button class="primary" id="dApply">Apply</button><button id="dClear">Clear</button>
      <select id="dPreset"><option value="">Presets…</option>${PRESETS.map(([n,x])=>`<option value="${esc(x)}">${esc(n)}</option>`).join("")}</select>
      <label class="inl">Order <select id="anOrder">${[["time","Time"],["dist","Distance"],["freq","Frequency"],["level","Level"]].map(([k,l])=>`<option value="${k}" ${order===k?"selected":""}>${l}</option>`).join("")}</select></label>
      <button id="anDir" title="Reverse the order">${dir>0?"↑ Ascending":"↓ Descending"}</button>
      <label class="inl">Rows <select id="anLim">${[500,3000,10000,25000].map(n=>`<option ${(S.anLimit||3000)===n?"selected":""}>${n}</option>`).join("")}</select></label>
      <div class="seg"><button data-an="packets" class="${S.anView!=="stats"?"on":""}">Records</button><button data-an="stats" class="${S.anView==="stats"?"on":""}">Statistics</button></div>
    </div>
    <div class="row" style="margin-top:6px;gap:6px;align-items:center"><span class="hint">Columns</span>${AN_COLS.map(([k,l])=>`<span class="chip ${hide.has(k)?"":"on"}" data-ancol="${k}">${l}</span>`).join("")}
      <span class="hint" style="margin-left:auto">Row colour = signal type: ${[...new Set(rows.slice(0,3000).map(typeOf))].slice(0,10).map(t=>`<span class="dot" style="background:${typeColor(t)}"></span>${esc(t)}`).join(" ")}</span></div>
    <div class="hint" style="margin-top:4px">${err?`<span style="color:var(--bad)">${esc(err)}</span>`:`${rows.length.toLocaleString()} displayed of ${rowsIn.length.toLocaleString()} · fields: freq, type, dbm, est_rx_dbm, dist, src, call, licensee, ssid, mac, band, category, station, emission, mode, erp, height, time, status, auth, channel, kind · ops: == != > < >= <= contains matches && || ! ( )`}</div></div>
    <div id="anBody"></div>`;
  const apply=()=>{ S.filterExpr=$("#dfilter").value; render(); };
  $("#dApply").onclick=apply; $("#dfilter").onkeydown=e=>{ if(e.key==="Enter") apply(); };
  $("#dClear").onclick=()=>{ S.filterExpr=""; render(); };
  $("#dPreset").onchange=e=>{ if(e.target.value){ S.filterExpr=e.target.value; render(); } };
  $("#anOrder").onchange=e=>{ S.anOrder=e.target.value; render(); };
  $("#anDir").onclick=()=>{ S.anDir=-dir; render(); };
  $("#anLim").onchange=e=>{ S.anLimit=+e.target.value; render(); };
  v.querySelectorAll("[data-ancol]").forEach(c=>c.onclick=()=>{ const k=c.dataset.ancol; hide.has(k)?hide.delete(k):hide.add(k); render(); });
  v.querySelectorAll("[data-an]").forEach(b=>b.onclick=()=>{ S.anView=b.dataset.an; render(); });
  if(S.anView==="stats"){ $("#anBody").innerHTML=anStats(rows); return; }
  const lim=Math.min(rows.length, S.anLimit||3000), shown=rows.slice(0,lim);
  const lv=shown.map(levelOf).filter(x=>x!=null), lmin=Math.min(...lv,-120), lmax=Math.max(...lv,-20), dmax=Math.max(0.01,...shown.map(r=>r.dist_mi||0));
  const bar=(f,c)=>`background:linear-gradient(90deg,color-mix(in srgb,${c} 28%,transparent) ${Math.round(100*Math.max(0,Math.min(1,f)))}%,transparent 0)`;
  const cols=AN_COLS.filter(([k])=>!hide.has(k));
  const cell={no:(r,i)=>`<td class="n">${i+1}</td>`, time:r=>`<td class="mono">${esc(timeOf(r).replace("T"," ").replace("Z",""))}</td>`,
    dt:r=>{ const t=timeOf(r), d=t0&&t?((Date.parse(t)-t0)/1000):null; return `<td class="n">${d!=null&&isFinite(d)?d.toFixed(0):""}</td>`; },
    src:r=>`<td data-fk="src" data-fv="${esc(r.layer)}">${esc(LAYERS[r.layer]?.label||r.layer)}</td>`, type:r=>`<td data-fk="type" data-fv="${esc(typeOf(r))}"><b>${esc(typeOf(r))}</b></td>`,
    freq:r=>`<td class="f" data-fk="freq" data-fv="${fmtF(r.freq_mhz)}">${fmtF(r.freq_mhz)}</td>`, ident:r=>`<td class="mono" ${r.call_sign?`data-fk="call" data-fv="${esc(r.call_sign)}"`:r.ident?`data-fk="mac" data-fv="${esc(r.ident)}"`:""}>${esc(r.call_sign||r.ident||r.reg||"")}</td>`,
    name:r=>`<td>${esc(titleOf(r))}</td>`, dbm:r=>{ const l=levelOf(r); return `<td class="n" style="${l!=null?bar((l-lmin)/((lmax-lmin)||1),"#1f6feb"):""}">${l!=null?num(l,1):""}</td>`; },
    dist:r=>`<td class="n" style="${r.dist_mi!=null?bar(r.dist_mi/dmax,"#8250df"):""}">${num(r.dist_mi,2)}</td>`, band:r=>`<td data-fk="band" data-fv="${esc(r.band||"")}">${esc(r.band||"")}</td>`, info:r=>`<td>${esc(infoOf(r))}</td>`};
  const body=shown.map((r,i)=>`<tr data-i="${i}" style="background:color-mix(in srgb, ${colorOf(r)} 13%, transparent)">${cols.map(([k])=>cell[k](r,i)).join("")}</tr>`).join("");
  $("#anBody").innerHTML=`<div class="tw pkts"><table id="pktTable"><thead><tr>${cols.map(([,l])=>`<th>${l}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="hint">Alt + click a source, type, frequency, ident or band cell to keep only that value; Alt + Shift + click to drop it.</p>
    ${rows.length>lim?`<button id="anMore" style="margin:6px 0">Show ${Math.min(3000,rows.length-lim).toLocaleString()} more</button>`:""}
    <div class="pane2"><div class="tw tree" id="anTree"><span class="hint">Select a record to see its fields.</span></div><div class="tw"><pre class="raw" id="anRaw"></pre></div></div>`;
  if($("#anMore")) $("#anMore").onclick=()=>{ S.anLimit=(S.anLimit||3000)+3000; render(); };
  $("#pktTable").onclick=e=>{
    const td=e.target.closest("td[data-fk]");
    if(e.altKey && td){  // filter in / out from the cell (Wireshark's "apply as filter")
      const k=td.dataset.fk, raw=td.dataset.fv, val=k==="freq"&&raw?raw:`"${raw.replace(/"/g,'\\"')}"`, term=`${k} ${e.shiftKey?"!=":"=="} ${val}`;
      S.filterExpr=S.filterExpr.trim()?`(${S.filterExpr}) && ${term}`:term; render(); return; }
    const tr=e.target.closest("tr[data-i]"); if(!tr) return; $$("#pktTable tr.sel").forEach(x=>x.classList.remove("sel")); tr.classList.add("sel"); showTree(S.anRows[+tr.dataset.i]); };
  $("#pktTable").ondblclick=e=>{ const tr=e.target.closest("tr[data-i]"); if(tr) openDetail(S.anRows[+tr.dataset.i].fid); };
  $("#pktTable").tabIndex=0;
  $("#pktTable").onkeydown=e=>{ const cur=$("#pktTable tr.sel"); if(!cur) return; const nx=e.key==="ArrowDown"?cur.nextElementSibling:e.key==="ArrowUp"?cur.previousElementSibling:null;
    if(nx){ e.preventDefault(); nx.click(); nx.scrollIntoView({block:"nearest"}); } };
};
function showTree(r){
  const kv=(k,v)=>v===""||v==null?"":`<span class="kv"><span class="k">${esc(k)}:</span> ${esc(v)}</span>`;
  const sec=(t,inner,open)=>inner.replace(/<[^>]+>/g,"").trim()?`<details ${open?"open":""}><summary>${esc(t)}</summary>${inner}</details>`:"";
  const ems=(r.emissions||"").split(/\s+/).filter(Boolean).map(decodeEmission).filter(Boolean);
  let extra={}; try{ extra=JSON.parse(r.details||r.extra||"{}")||{}; }catch(e){}
  $("#anTree").innerHTML=
    sec(`Record ${r.fid}, ${LAYERS[r.layer]?.label||r.layer}`, kv("Source",LAYERS[r.layer]?.label)+kv("Time",timeOf(r))+kv("Capture",r.capture_name)+kv("Attribution",r.attribution)+kv("Status",r.status),true)+
    sec("Position", kv("Latitude",r.lat)+kv("Longitude",r.lon)+kv("Altitude m",r.alt)+kv("GPS accuracy m",r.acc)+kv("Distance mi",r.dist_mi)+kv("Bearing",r.bearing!=null?`${r.bearing}° ${r.compass}`:"")+kv("Site",[r.address||r.street,r.city,r.county,r.state].filter(Boolean).join(", ")),true)+
    sec("Radio", kv("Frequency MHz",fmtF(r.freq_mhz))+kv("Paired / input MHz",fmtF(r.freq_upper_mhz||r.freq_in_mhz))+kv("Band",r.band)+kv("Channel",r.channel)+kv("Bandwidth kHz",r.bw_khz||r.bandwidth_khz)+
      kv("Level dBm",r.dbm)+kv("Est. level dBm",r.est_rx_dbm)+kv("ERP W",r.erp_w)+kv("Output W",r.power_out_w)+kv("Tolerance",r.tolerance)+kv("Mode",r.ov_mode||r.mode)+kv("Digital mod",r.digital_mod)+kv("Security",r.auth)+
      ems.map(d=>`<details open><summary>Emission ${esc(d.code)}</summary>${kv("Technology",d.tech)}${kv("Bandwidth kHz",d.bw)}${kv("Modulation",d.mod)}${kv("Signal",d.nature)}${kv("Information",d.info)}</details>`).join(""),true)+
    sec("Identification", kv("Signal type",r.sig_type)+kv("Confidence",r.sig_conf)+kv("Basis",r.sig_basis)+kv("Family",S.lib[r.sig_type]?.family)+kv("Typical bandwidth",S.lib[r.sig_type]?.bw)+(S.lib[r.sig_type]?`<span class="kv"><a href="${S.lib[r.sig_type].url}" target="_blank" rel="noopener">Signal ID wiki ↗</a></span>`:""),true)+
    sec("Entity", kv("Licensee",r.licensee)+kv("Call sign",r.call_sign)+kv("Label / SSID",r.label)+kv("Identifier",r.ident||r.ext_id)+kv("Category",r.category)+kv("Service",[r.service,r.service_name].filter(Boolean).join(" — "))+kv("Station class",[r.station_class,classLabel(r.station_class)].filter(Boolean).join(" — ")),true)+
    sec("Antenna / structure", kv("Antenna",[r.ant_make,r.ant_model].filter(Boolean).join(" "))+kv("Gain dBi",r.gain_dbi)+kv("Polarization",r.polarization)+kv("Azimuth",r.azimuth)+kv("Beamwidth",r.beamwidth)+kv("Height AGL m",r.height_tip_m??r.overall_agl_m)+kv("HAAT m",r.haat_m)+kv("Tower reg",r.tower_reg||r.reg)+kv("Owner",r.owner)+kv("Structure",r.struct_type))+
    sec("Labels & observations", kv("Alpha tag",r.ov_alpha_tag)+kv("Tone/NAC/CC",r.ov_tone)+kv("Tag",r.ov_tag)+kv("Description",r.ov_description)+kv("Verified",r.ov_verified?"yes":"")+kv("Observed",r.obs_status)+kv("Observed dBm",r.obs_level)+kv("Notes",r.obs_notes||r.ov_notes))+
    (Object.keys(extra).length?sec("Source fields", Object.entries(extra).map(([k,v])=>kv(k,typeof v==="object"?JSON.stringify(v):v)).join("")):"");
  const clean={...r}; delete clean.details; delete clean.extra;
  $("#anRaw").textContent=JSON.stringify({...clean, source_fields: extra}, null, 2);
}
function anStats(rows){
  const total=rows.length||1;
  // hierarchy: source -> type
  const h=new Map(); for(const r of rows){ const a=LAYERS[r.layer]?.label||r.layer; if(!h.has(a)) h.set(a,new Map()); const m=h.get(a); const t=typeOf(r); m.set(t,(m.get(t)||0)+1); }
  const hier=[...h].sort((a,b)=>[...b[1].values()].reduce((x,y)=>x+y,0)-[...a[1].values()].reduce((x,y)=>x+y,0)).map(([src,m])=>{ const n=[...m.values()].reduce((x,y)=>x+y,0);
    return `<tr><td><b>${esc(src)}</b></td><td class="n">${n.toLocaleString()}</td><td class="n">${(100*n/total).toFixed(1)}%</td><td></td></tr>`+
      [...m].sort((a,b)=>b[1]-a[1]).map(([t,c])=>`<tr><td style="padding-left:24px"><span class="dot" style="background:${typeColor(t)}"></span> ${esc(t)}</td><td class="n">${c.toLocaleString()}</td><td class="n">${(100*c/total).toFixed(1)}%</td><td><div style="height:8px;width:${Math.max(2,200*c/total)}px;background:${typeColor(t)};border-radius:3px"></div></td></tr>`).join(""); }).join("");
  // endpoints
  const ep=new Map(); for(const r of rows){ const k=r.call_sign||r.ident||r.reg||r.label||"?"; const e=ep.get(k)||{k,name:titleOf(r),type:typeOf(r),n:0,freqs:new Set(),lv:[],first:null,last:null,dist:Infinity};
    e.n++; if(r.freq_mhz) e.freqs.add(fmtF(r.freq_mhz)); const l=levelOf(r); if(l!=null) e.lv.push(l); const t=timeOf(r); if(t){ if(!e.first||t<e.first) e.first=t; if(!e.last||t>e.last) e.last=t; }
    if(r.dist_mi!=null) e.dist=Math.min(e.dist,r.dist_mi); ep.set(k,e); }
  const eps=[...ep.values()].sort((a,b)=>b.n-a.n).slice(0,300).map(e=>`<tr><td class="mono">${esc(e.k)}</td><td>${esc(e.name)}</td><td>${esc(e.type)}</td><td class="n">${e.n}</td><td class="mono">${[...e.freqs].slice(0,4).join(", ")}${e.freqs.size>4?" …":""}</td>
    <td class="n">${e.lv.length?num(Math.min(...e.lv),0):""}</td><td class="n">${e.lv.length?num(e.lv.reduce((a,b)=>a+b,0)/e.lv.length,1):""}</td><td class="n">${e.lv.length?num(Math.max(...e.lv),0):""}</td><td class="mono">${esc(e.first||"")}</td><td class="mono">${esc(e.last||"")}</td><td class="n">${isFinite(e.dist)?num(e.dist,2):""}</td></tr>`).join("");
  return `<div class="grid2" style="margin-top:0"><div class="panel"><h3>Hierarchy (source → signal type)</h3><div class="tw" style="max-height:380px"><table><thead><tr><th>Source / type</th><th>Count</th><th>%</th><th></th></tr></thead><tbody>${hier}</tbody></table></div></div>
    <div class="panel"><h3>IO graph — records and average level over time</h3>${ioGraph(rows)}</div></div>
    <div class="panel"><h3>Endpoints (by call sign / MAC / cell / ID)</h3><div class="tw" style="max-height:420px"><table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Records</th><th>Frequencies</th><th>Min dBm</th><th>Avg</th><th>Max</th><th>First</th><th>Last</th><th>Nearest mi</th></tr></thead><tbody>${eps}</tbody></table></div></div>`;
}
function ioGraph(rows){
  const pts=rows.map(r=>({t:Date.parse(r.ts||""),l:r.dbm})).filter(p=>!isNaN(p.t));
  if(pts.length<2) return '<p class="hint">No capture timestamps in these records (field captures have them; licenses only have grant dates).</p>';
  const t0=Math.min(...pts.map(p=>p.t)), t1=Math.max(...pts.map(p=>p.t)), span=Math.max(t1-t0,1);
  const nb=Math.min(60,Math.max(10,Math.round(Math.sqrt(pts.length)))), bw=span/nb;
  const b=Array.from({length:nb},()=>({n:0,s:0,c:0})); for(const p of pts){ const i=Math.min(nb-1,Math.floor((p.t-t0)/bw)); b[i].n++; if(p.l!=null){ b[i].s+=p.l; b[i].c++; } }
  const maxN=Math.max(...b.map(x=>x.n)), lv=b.filter(x=>x.c).map(x=>x.s/x.c), lmin=Math.min(...lv,-120), lmax=Math.max(...lv,-20);
  const W=600,H=200,P=30, x=i=>P+(W-2*P)*i/(nb-1||1);
  const barsSvg=b.map((x0,i)=>`<rect x="${x(i)-((W-2*P)/nb)/2+1}" y="${H-P-(H-2*P)*x0.n/maxN}" width="${Math.max(1,(W-2*P)/nb-2)}" height="${(H-2*P)*x0.n/maxN}" fill="var(--accent)" opacity=".55"><title>${x0.n} records</title></rect>`).join("");
  const line=b.map((x0,i)=>x0.c?`${x(i)},${H-P-(H-2*P)*((x0.s/x0.c)-lmin)/((lmax-lmin)||1)}`:null).filter(Boolean).join(" ");
  const fmt=t=>new Date(t).toISOString().replace("T"," ").slice(5,16);
  const ticks=[0,.25,.5,.75,1].map(f=>t0+span*f);  // dated ticks across the range, counts left, average dBm right
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-size:10px"><line x1="${P}" x2="${W-P}" y1="${H-P}" y2="${H-P}" stroke="var(--muted)"/>
    ${[0,.5,1].map(f=>`<line x1="${P}" x2="${W-P}" y1="${H-P-(H-2*P)*f}" y2="${H-P-(H-2*P)*f}" stroke="var(--line)" opacity=".5"/><text x="${P-4}" y="${H-P-(H-2*P)*f+3}" text-anchor="end" fill="var(--muted)">${Math.round(maxN*f)}</text>`).join("")}
    ${barsSvg}${line?`<polyline points="${line}" fill="none" stroke="#cf222e" stroke-width="2"/>`:""}
    ${ticks.map(t=>`<line x1="${P+(W-2*P)*(t-t0)/span}" x2="${P+(W-2*P)*(t-t0)/span}" y1="${H-P}" y2="${H-P+4}" stroke="var(--muted)"/><text x="${P+(W-2*P)*(t-t0)/span}" y="${H-P+14}" text-anchor="middle" fill="var(--muted)">${fmt(t)}</text>`).join("")}
    <text x="${P}" y="10" fill="var(--muted)">records per ${bw>=36e5?num(bw/36e5,1)+" h":num(bw/6e4,0)+" min"}</text>
    ${line?`<text x="${W-P}" y="10" text-anchor="end" style="fill:#cf222e">avg dBm ${num(lmin,0)} … ${num(lmax,0)}</text>`:""}<text x="${W/2}" y="${H-2}" text-anchor="middle" fill="var(--muted)">UTC</text></svg>`;
}

/* ---------- dashboard (Kibana-style) ---------- */
function niceTicks(lo, hi, n=6){ const span=(hi-lo)||1, raw=span/n, p=10**Math.floor(Math.log10(raw)), step=[1,2,2.5,5,10].map(m=>m*p).find(s=>s>=raw);
  const out=[]; for(let v=Math.ceil(lo/step)*step; v<=hi+step*1e-6; v+=step) out.push(+v.toFixed(8)); return out; }
// Histogram with a count axis, gridlines, unit ticks and median / mean markers
function histogram(vals, bins, color, unit, label){
  if(!vals.length) return '<p class="hint">No values.</p>';
  const lo=Math.min(...vals), hi=Math.max(...vals), w=(hi-lo)/bins||1; const b=new Array(bins).fill(0); for(const v of vals) b[Math.min(bins-1,Math.floor((v-lo)/w))]++;
  const max=Math.max(1,...b), W=560,H=210,Lm=44,Rm=12,Tm=16,Bm=40, pw=W-Lm-Rm, ph=H-Tm-Bm;
  const X=v=>Lm+pw*(v-lo)/((hi-lo)||1), Y=n=>Tm+ph-ph*n/max;
  const sorted=vals.slice().sort((a,c)=>a-c), med=sorted[Math.floor(sorted.length/2)], mean=vals.reduce((a,v)=>a+v,0)/vals.length;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-size:11px">
    ${niceTicks(0,max,4).map(t=>`<line x1="${Lm}" x2="${W-Rm}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--line)" opacity=".6"/><text x="${Lm-6}" y="${Y(t)+4}" text-anchor="end" fill="var(--muted)">${t}</text>`).join("")}
    ${b.map((n,i)=>`<rect x="${Lm+i*pw/bins+1}" y="${Y(n)}" width="${Math.max(1,pw/bins-2)}" height="${Tm+ph-Y(n)}" fill="${color}" opacity=".85"><title>${num(lo+i*w,1)}–${num(lo+(i+1)*w,1)} ${unit}: ${n}</title></rect>`).join("")}
    <line x1="${Lm}" x2="${W-Rm}" y1="${Tm+ph}" y2="${Tm+ph}" stroke="var(--muted)"/>
    ${niceTicks(lo,hi,6).map(t=>`<line x1="${X(t)}" x2="${X(t)}" y1="${Tm+ph}" y2="${Tm+ph+5}" stroke="var(--muted)"/><text x="${X(t)}" y="${Tm+ph+17}" text-anchor="middle" fill="var(--muted)">${t}</text>`).join("")}
    ${[["median",med,"#bf8700"],["mean",mean,"#cf222e"]].map(([k,v,c],j)=>`<line x1="${X(v)}" x2="${X(v)}" y1="${Tm}" y2="${Tm+ph}" stroke="${c}" stroke-dasharray="4 3"/><text x="${Math.min(X(v)+4,W-Rm-70)}" y="${Tm+10+j*12}" fill="${c}">${k} ${num(v,1)}</text>`).join("")}
    <text x="${Lm+pw/2}" y="${H-4}" text-anchor="middle" fill="var(--muted)">${esc(label||unit)} · ${vals.length.toLocaleString()} values</text>
    <text x="12" y="${Tm+ph/2}" transform="rotate(-90 12 ${Tm+ph/2})" text-anchor="middle" fill="var(--muted)">count</text></svg>`;
}
function donut(entries, colorFn){
  const tot=entries.reduce((a,e)=>a+e[1],0)||1; let a0=-Math.PI/2; const R=70,r=42,c=80;
  const arcs=entries.map(([k,n])=>{ const a1=a0+2*Math.PI*n/tot, large=a1-a0>Math.PI?1:0, p=(a,rr)=>`${c+rr*Math.cos(a)},${c+rr*Math.sin(a)}`;
    const d=`M${p(a0,R)} A${R},${R} 0 ${large} 1 ${p(a1,R)} L${p(a1,r)} A${r},${r} 0 ${large} 0 ${p(a0,r)} Z`; a0=a1; return `<path d="${d}" fill="${colorFn(k)}" data-click="band" data-v="${esc(k)}" style="cursor:pointer"><title>${esc(k)}: ${n}</title></path>`; }).join("");
  return `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 160 160" width="160" height="160">${arcs}<text x="80" y="84" text-anchor="middle" style="font-size:14px;fill:var(--ink)">${tot.toLocaleString()}</text></svg>
    <div style="font-size:12px">${entries.slice(0,10).map(([k,n])=>`<div><span class="dot" style="background:${colorFn(k)}"></span> ${esc(k)} <span class="hint">${n}</span></div>`).join("")}</div></div>`;
}
const PALETTE=["#1f6feb","#cf222e","#0b6e4f","#8250df","#bf8700","#1b7c83","#bf3989","#953800","#57606a","#6e7781","#0969da","#fa4549"];
const palette=(()=>{ const m=new Map(); return k=>{ if(!m.has(k)) m.set(k,PALETTE[m.size%PALETTE.length]); return m.get(k); }; })();
S.views.dashboard = (v, rows) => {
  const D=S.dash=S.dash||{bins:24, top:12, lv:"both"};
  const lvOf=D.lv==="meas"?(r=>r.dbm):D.lv==="est"?(r=>r.est_rx_dbm):levelOf;
  const lv=rows.map(lvOf).filter(x=>x!=null);
  const sites=new Set(rows.filter(r=>r.lat!=null).map(r=>r.lat+","+r.lon));
  const yrs=rows.filter(r=>r.layer==="uls"&&r.grant_date).map(r=>{ const m=/(\d{4})/.exec(r.grant_date); return m?+m[1]:null; }).filter(Boolean);
  const times=rows.map(r=>Date.parse(r.ts||"")).filter(t=>!isNaN(t));
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px;margin-bottom:6px">
      <label class="inl">Histogram bins <select id="dbBins">${[10,16,24,40,80].map(n=>`<option ${D.bins===n?"selected":""}>${n}</option>`).join("")}</select></label>
      <label class="inl">Show top <select id="dbTop">${[8,12,20,50].map(n=>`<option ${D.top===n?"selected":""}>${n}</option>`).join("")}</select> in lists</label>
      <label class="inl">Signal levels <select id="dbLv"><option value="both">Measured + predicted</option><option value="meas">Measured only</option><option value="est">Predicted only (free-space)</option></select></label>
      <span class="hint">Click any bar or slice to filter every tab by it.</span></div>
    <div class="dash">
    <div class="w12"><div class="cards">
      <div class="card"><div class="v">${rows.length.toLocaleString()}</div><div class="k">Items shown</div></div>
      <div class="card"><div class="v">${new Set(rows.filter(r=>r.freq_mhz).map(r=>fmtF(r.freq_mhz))).size.toLocaleString()}</div><div class="k">Frequencies</div></div>
      <div class="card"><div class="v">${sites.size.toLocaleString()}</div><div class="k">Locations</div></div>
      <div class="card"><div class="v">${new Set(rows.map(typeOf)).size}</div><div class="k">Signal types</div></div>
      <div class="card"><div class="v">${lv.length?num(Math.max(...lv),0):"–"}</div><div class="k">Strongest dBm (meas./est.)</div></div>
      <div class="card"><div class="v">${rows.filter(r=>r.layer==="captures").length.toLocaleString()}</div><div class="k">Captured points</div></div>
    </div></div>
    <div class="panel w8"><h3>Map</h3><div id="dashmap"></div></div>
    <div class="panel w4"><h3>Signal types <span class="hint">· entries</span></h3>${bars(countBy(rows,typeOf).slice(0,D.top),typeColor,"type")}</div>
    <div class="panel w4"><h3>Sources <span class="hint">· entries</span></h3>${bars(countBy(rows,r=>LAYERS[r.layer]?.label||r.layer),k=>LAYERS[Object.keys(LAYERS).find(x=>LAYERS[x].label===k)]?.color,"layer")}</div>
    <div class="panel w4"><h3>Bands <span class="hint">· share of entries</span></h3>${donut(countBy(rows,r=>r.band||"Other").slice(0,D.top),palette)}</div>
    <div class="panel w4"><h3>Categories <span class="hint">· entries</span></h3>${bars(countBy(rows,r=>r.category||"Other").slice(0,D.top),null,"cat")}</div>
    <div class="panel w6"><h3>Signal level distribution</h3>${histogram(lv,D.bins,"#1f6feb","dBm",{both:"dBm, measured or predicted",meas:"dBm, measured",est:"dBm, predicted (free-space)"}[D.lv])}</div>
    <div class="panel w6"><h3>${times.length?"Capture activity over time":"License grants by year"}</h3>${times.length?ioGraph(rows):histogram(yrs,Math.min(D.bins,Math.max(5,new Set(yrs).size)),"#0b6e4f","yr","grant year")}</div>
    <div class="panel w6"><h3>Distance from pin</h3>${histogram(rows.map(r=>r.dist_mi).filter(x=>x!=null),D.bins,"#8250df","mi","miles from the pin")}</div>
    <div class="panel w6"><h3>Top names / licensees / SSIDs <span class="hint">· entries</span></h3>${bars(countBy(rows,r=>titleOf(r)||"?").slice(0,D.top))}</div>
  </div>`;
  $("#dbBins").onchange=e=>{ D.bins=+e.target.value; render(); };
  $("#dbTop").onchange=e=>{ D.top=+e.target.value; render(); };
  $("#dbLv").value=D.lv; $("#dbLv").onchange=e=>{ D.lv=e.target.value; render(); };
  if(typeof L!=="undefined"){ const m=L.map("dashmap",{preferCanvas:true}); S.dashMap=m; addMapLayers(m); L.control.scale({imperial:true,metric:true}).addTo(m);
    const pts=[]; for(const r of rows){ if(r.lat==null) continue; pts.push([r.lat,r.lon]); L.circleMarker([r.lat,r.lon],{radius:3,color:colorOf(r),fillOpacity:.7,weight:1}).addTo(m); }
    if(S.center){ const rm=S.radius*1609.344, step=niceStep(S.radius)*1609.344;
      for(let d=step; d<rm-1; d+=step) L.circle(S.center,{radius:d,color:"#888",weight:1,dashArray:"3 5",fill:false,interactive:false}).addTo(m);
      L.circle(S.center,{radius:rm,color:"#555",fill:false,weight:1.5}).addTo(m); m.fitBounds(L.latLng(S.center).toBounds(rm*2)); }
    else if(pts.length) m.fitBounds(pts); else m.setView([39.5,-98.35],4); }
};

/* ---------- topology ---------- */
S.views.topology = (v, rows) => {
  const mode=S.topoMode||"logical", lay=S.topoLayout||"cose";
  v.innerHTML=`<div class="maptools" style="flex-wrap:wrap;gap:8px"><div class="seg" id="topoSeg">${[["logical","Logical"],["physical","Physical (geographic)"],["cochannel","Co-channel / interference"]].map(([k,l])=>`<button data-tm="${k}" class="${mode===k?"on":""}">${l}</button>`).join("")}</div>
    ${mode!=="physical"?`<label class="inl">Layout <select id="topoLay">${[["cose","Force"],["concentric","Rings by links"],["breadthfirst","Hierarchy"],["grid","Grid"]].map(([k,l])=>`<option value="${k}" ${lay===k?"selected":""}>${l}</option>`).join("")}</select></label>`:""}
    <label class="inl">Up to <select id="topoLim">${[300,900,2000,5000].map(n=>`<option ${(S.topoLimit||900)===n?"selected":""}>${n}</option>`).join("")}</select> nodes</label>
    <label class="inl">Find <input id="topoFind" list="topoNames" placeholder="licensee, call sign, MHz…" style="width:180px"></label><datalist id="topoNames"></datalist>
    <span style="flex:1"></span><span class="hint" id="topoInfo"></span>
    <button id="topoOut" title="Zoom out">−</button><span class="mono hint" id="topoZoom" style="min-width:44px;text-align:center"></span><button id="topoIn" title="Zoom in">+</button>
    <button id="topoFit" title="Fit everything">Fit</button><button id="topoOne" title="Actual size">1:1</button><button id="topoFull" title="Full screen">⛶</button><button id="topoPng">⇩ PNG</button></div>
    <div id="cyWrap" style="position:relative"><div id="cy"></div>
      <div class="panel" style="position:absolute;left:8px;bottom:8px;padding:6px 8px;font-size:11px;line-height:1.6;opacity:.92">
        <b>Legend</b><br>▬ licensee / group &nbsp;◆ licence (call sign) &nbsp;● frequency (colour = signal type)<br>▲ tower &nbsp;★ pin &nbsp;<span style="color:#bf8700">┅</span> repeater output → input &nbsp;<span style="color:#cf222e">━</span> shared frequency</div></div>
    <p class="hint">Drag to pan. <b>Ctrl + wheel</b> (or pinch) zooms at the cursor; the plain wheel scrolls the page. Click a node to light up its links; click the background to clear.</p>
    <p class="hint">${{logical:"Licensee → license (call sign) → frequencies, with repeater output → input pairs. Wi-Fi SSID → access points. Cell operator → cells. Repeater groups from RepeaterBook.",
      physical:"Nodes placed at their real coordinates: towers, transmitter sites and the pin. Edges link each site to its tower and to the licensees operating there.",
      cochannel:"Frequencies used at more than one site or by more than one licensee near the pin. Thick edges = shared frequency (possible co-channel interference)."}[mode]}</p>`;
  v.querySelectorAll("[data-tm]").forEach(b=>b.onclick=()=>{ S.topoMode=b.dataset.tm; render(); });
  if($("#topoLay")) $("#topoLay").onchange=e=>{ S.topoLayout=e.target.value; render(); };
  $("#topoLim").onchange=e=>{ S.topoLimit=+e.target.value; render(); };
  if(typeof cytoscape==="undefined"){ $("#cy").innerHTML='<p class="status" style="padding:10px">Graph library missing.</p>'; return; }
  const N=new Map(), E=[]; const add=(id,label,kind,extra)=>{ if(!N.has(id)) N.set(id,{data:{id,label,kind,...extra}}); return id; };
  const edge=(a,b,kind,w)=>E.push({data:{id:`${a}>${b}>${E.length}`,source:a,target:b,kind,w:w||1}});
  const LIMIT=S.topoLimit||900;
  if(mode==="logical"){
    for(const r of rows){ if(N.size>LIMIT) break;
      if(r.layer==="uls"||r.layer==="uls_hist"){ const lic=add("L:"+r.licensee, r.licensee, "licensee",{color:catColor2(r.category)}); const cs=add("C:"+r.call_sign, r.call_sign, "license"); edge(lic,cs,"holds");
        const f=add("F:"+fmtF(r.freq_mhz), fmtF(r.freq_mhz), "freq",{color:colorOf(r)}); if(!E.some(e=>e.data.source===cs&&e.data.target===f)) edge(cs,f,"uses");
        if(r.freq_upper_mhz && r.station_class==="FB2"){ const fi=add("F:"+fmtF(r.freq_upper_mhz), fmtF(r.freq_upper_mhz)+" in","freq",{color:"#8c959f"}); if(!E.some(e=>e.data.source===f&&e.data.target===fi)) edge(f,fi,"pair"); } }
      else if(r.sig_type==="Wi-Fi" && r.label){ const s=add("S:"+r.label, r.label, "ssid",{color:typeColor("Wi-Fi")}); const ap=add("A:"+(r.ident||r.fid), r.ident||"AP","ap"); if(!E.some(e=>e.data.target===ap)) edge(s,ap,"bssid"); }
      else if(["LTE","5G NR","GSM","WCDMA/UMTS","CDMA"].includes(r.sig_type)){ const op=String(r.ident||r.ext_id||"").split(/[_-]/).slice(0,2).join("-")||"operator"; const o=add("O:"+op, "Operator "+op, "operator",{color:typeColor(r.sig_type)}); const c=add("X:"+(r.ident||r.fid), (r.ident||"").split(/[_-]/).pop()||"cell","cell"); if(!E.some(e=>e.data.target===c)) edge(o,c,"cell"); }
      else if(r.layer==="repeaterbook"){ const g=add("R:repeaters","Ham/GMRS repeaters","group"); const x=add("RB:"+r.fid, `${fmtF(r.freq_mhz)} ${r.label}`,"freq",{color:colorOf(r)}); edge(g,x,"lists"); }
    }
  } else if(mode==="physical"){
    if(S.center) add("PIN","Pin","pin",{x:0,y:0});
    const proj=(la,lo)=>S.center?{x:(lo-S.center[1])*Math.cos(S.center[0]*Math.PI/180)*9000,y:-(la-S.center[0])*9000}:{x:lo*900,y:-la*900};
    for(const r of rows){ if(N.size>LIMIT) break; if(r.lat==null||r.layer==="captures"||r.layer==="wigle") continue;
      if(r.layer==="towers"){ add("T:"+r.reg,`${r.struct_type||"Tower"} ${r.overall_agl_m??""}m`,"tower",proj(r.lat,r.lon)); continue; }
      const sid="SITE:"+r.lat+","+r.lon; add(sid, r.layer==="uls"?(r.city||"site"):titleOf(r), "site", {...proj(r.lat,r.lon), color:colorOf(r)});
      if(r.tower_reg && rows.some(x=>x.layer==="towers"&&x.reg===r.tower_reg)){ const t="T:"+r.tower_reg; if(!E.some(e=>e.data.source===sid&&e.data.target===t)) edge(sid,t,"on tower"); }
      if(r.licensee){ const l=add("L:"+r.licensee,r.licensee,"licensee",{color:catColor2(r.category)}); if(!E.some(e=>e.data.source===l&&e.data.target===sid)) edge(l,sid,"operates"); } }
    // licensee nodes: place at centroid of their sites
    for(const [id,n] of N) if(n.data.kind==="licensee"){ const ss=E.filter(e=>e.data.source===id).map(e=>N.get(e.data.target).data); if(ss.length){ n.data.x=ss.reduce((a,s)=>a+s.x,0)/ss.length+18; n.data.y=ss.reduce((a,s)=>a+s.y,0)/ss.length-18; } }
  } else {
    const byF=new Map(); for(const r of rows){ if(!r.freq_mhz||r.layer==="towers") continue; const k=fmtF(r.freq_mhz); if(!byF.has(k)) byF.set(k,[]); byF.get(k).push(r); }
    for(const [f,rs] of byF){ const who=new Set(rs.map(r=>r.licensee||r.label||r.ident)); const sites=new Set(rs.filter(r=>r.lat!=null).map(r=>r.lat+","+r.lon)); if(who.size<2&&sites.size<2) continue; if(N.size>LIMIT) break;
      const fn=add("F:"+f, f+" MHz","freq",{color:colorOf(rs[0])}); for(const w of who){ const o=rs.find(r=>(r.licensee||r.label||r.ident)===w); const n=add("W:"+w, w, "licensee",{color:colorOf(o)});
        const near=Math.min(...rs.filter(r=>(r.licensee||r.label||r.ident)===w).map(r=>r.dist_mi??99)); edge(fn,n,"co-channel",Math.max(1,6-near)); } }
  }
  $("#topoInfo").textContent=`${N.size} nodes · ${E.length} edges${N.size>LIMIT?" (trimmed — narrow the filters)":""}`;
  const cs=getComputedStyle(document.documentElement), ink=cs.getPropertyValue("--ink").trim(), line=cs.getPropertyValue("--line").trim();
  const cy=cytoscape({container:$("#cy"), elements:[...N.values(),...E],
    minZoom:.05, maxZoom:5, boxSelectionEnabled:false,
    // the plain wheel scrolls the page; zoom is Ctrl + wheel (below), pinch on touch screens, or the buttons
    userZoomingEnabled:matchMedia("(pointer:coarse)").matches,
    style:[{selector:"node",style:{label:"data(label)","font-size":9,"min-zoomed-font-size":7,color:ink,"text-valign":"bottom","text-margin-y":3,"background-color":"data(color)",width:12,height:12,"text-wrap":"ellipsis","text-max-width":120}},
      {selector:"node[!color]",style:{"background-color":"#8c959f"}},
      {selector:'node[kind="licensee"],node[kind="ssid"],node[kind="operator"],node[kind="group"]',style:{shape:"round-rectangle",width:22,height:16,"font-weight":"bold","font-size":10}},
      {selector:'node[kind="tower"]',style:{shape:"triangle","background-color":"#57606a",width:18,height:18}},
      {selector:'node[kind="pin"]',style:{shape:"star","background-color":"#cf222e",width:22,height:22}},
      {selector:'node[kind="license"]',style:{shape:"diamond","background-color":"#6e7781"}},
      {selector:"edge",style:{width:"data(w)","line-color":line,"curve-style":"bezier","target-arrow-shape":"triangle","target-arrow-color":line,"arrow-scale":.6}},
      {selector:'edge[kind="pair"]',style:{"line-style":"dashed","line-color":"#bf8700","target-arrow-color":"#bf8700"}},
      {selector:'edge[kind="co-channel"]',style:{"line-color":"#cf222e","target-arrow-shape":"none",opacity:.7}},
      {selector:".dim",style:{opacity:.12}},{selector:".hl",style:{"border-width":3,"border-color":"#bf8700"}}],
    layout: mode==="physical"?{name:"preset",positions:n=>({x:n.data("x")||0,y:n.data("y")||0}),fit:true,padding:30}
      : lay==="cose"?{name:"cose",animate:false,nodeRepulsion:9000,idealEdgeLength:60,numIter:N.size>1500?400:1000,fit:true,padding:20}
      : lay==="concentric"?{name:"concentric",concentric:n=>n.degree(),levelWidth:()=>2,minNodeSpacing:8,fit:true,padding:20}
      : lay==="breadthfirst"?{name:"breadthfirst",directed:true,spacingFactor:.9,fit:true,padding:20}
      : {name:"grid",fit:true,padding:20,avoidOverlap:true}});
  const showZoom=()=>{ $("#topoZoom").textContent=Math.round(cy.zoom()*100)+"%"; };
  const zoomBy=(k,at)=>{ const z=Math.min(cy.maxZoom(),Math.max(cy.minZoom(),cy.zoom()*k)); cy.zoom({level:z,renderedPosition:at||{x:cy.width()/2,y:cy.height()/2}}); };
  cy.on("zoom",showZoom); showZoom();
  $("#cy").addEventListener("wheel",e=>{ if(!e.ctrlKey) return; e.preventDefault(); const r=$("#cy").getBoundingClientRect(); zoomBy(e.deltaY>0?.85:1.18,{x:e.clientX-r.left,y:e.clientY-r.top}); },{passive:false});
  const focusNode=n=>{ cy.elements().addClass("dim"); n.closedNeighborhood().removeClass("dim"); cy.elements().removeClass("hl"); n.addClass("hl"); $("#topoInfo").textContent=`${n.data("label")} — ${n.degree()} links`; };
  cy.on("tap","node",ev=>focusNode(ev.target));
  cy.on("tap",ev=>{ if(ev.target===cy){ cy.elements().removeClass("dim hl"); $("#topoInfo").textContent=`${N.size} nodes · ${E.length} edges`; } });
  $("#topoNames").innerHTML=[...new Set(cy.nodes().map(n=>n.data("label")).filter(Boolean))].slice(0,3000).map(l=>`<option value="${esc(l)}">`).join("");
  $("#topoFind").onchange=e=>{ const q=e.target.value.trim().toLowerCase(); if(!q) return;
    const hit=cy.nodes().filter(n=>String(n.data("label")||"").toLowerCase()===q).first().length?cy.nodes().filter(n=>String(n.data("label")||"").toLowerCase()===q).first():cy.nodes().filter(n=>String(n.data("label")||"").toLowerCase().includes(q)).first();
    if(hit.length){ cy.animate({center:{eles:hit},zoom:Math.max(cy.zoom(),1.4)},{duration:300}); focusNode(hit); } else $("#topoInfo").textContent=`No node matches “${e.target.value}”`; };
  $("#topoIn").onclick=()=>zoomBy(1.4); $("#topoOut").onclick=()=>zoomBy(1/1.4);
  $("#topoOne").onclick=()=>cy.zoom({level:1,renderedPosition:{x:cy.width()/2,y:cy.height()/2}});
  $("#topoFull").onclick=()=>{ const w=$("#cyWrap"); if(document.fullscreenElement) document.exitFullscreen(); else w.requestFullscreen?.(); };
  document.onfullscreenchange=()=>{ const c=$("#cy"); if(!c||!S.cy) return; c.style.height=document.fullscreenElement?"100vh":""; S.cy.resize(); S.cy.fit(undefined,20); };
  $("#topoFit").onclick=()=>cy.fit(undefined,20);
  $("#topoPng").onclick=()=>{ const a=document.createElement("a"); a.href=cy.png({full:true,scale:2,bg:cs.getPropertyValue("--panel").trim()}); a.download=`topology_${mode}.png`; a.click(); };
  S.cy=cy;
};
const catColor2=c=>({"Law Enforcement":"#1f6feb","Fire / EMS":"#cf222e","Emergency Mgmt / 911":"#bf8700","Public Safety (Gov)":"#1b7c83","Public Safety (Other)":"#8250df","Local / State Gov":"#0b6e4f","Utilities":"#cf6a00","Transportation":"#57606a","Schools":"#e85aad","Hospital / Medical":"#d1242f"}[c]||"#6e7781");

/* ---------- site profile ---------- */
// Counts for the profile's breakdowns: every entry, or distinct frequencies or licensees per group
function countMode(rows, keyFn, mode){
  if(mode==="rows") return countBy(rows, keyFn);
  const id = mode==="lic" ? (r=>r.licensee||r.label||r.call_sign) : (r=>r.freq_mhz!=null?fmtF(r.freq_mhz):null);
  const m=new Map(); for(const r of rows){ const i=id(r); if(i==null) continue; for(const k of [].concat(keyFn(r))){ if(!m.has(k)) m.set(k,new Set()); m.get(k).add(i); } }
  return [...m].map(([k,s])=>[k,s.size]).sort((a,b)=>b[1]-a[1]);
}
// Bars with the share of the total beside each count
function barsPct(entries, total, colorFn, click){ const max=Math.max(1,...entries.map(e=>e[1]));
  return `<div class="bars">${entries.map(([k,n])=>`<div ${click?`data-click="${esc(click)}" data-v="${esc(k)}" title="${esc(k)}: ${n.toLocaleString()} (${total?Math.round(100*n/total):0}%). Click to filter every tab."`:`title="${esc(k)}"`}><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><span class="bar" style="width:${Math.max(2,100*n/max)}%;${colorFn?`background:${colorFn(k)}`:""}"></span><span class="mono" style="text-align:right">${n.toLocaleString()} <span class="hint">${total?Math.round(100*n/total):0}%</span></span></div>`).join("")}</div>`; }
// Where the sites are around the pin: 16 compass sectors by 4 distance rings, shaded by how many sites fall in each
function polarSites(rows, radius){
  const sites=new Map();
  for(const r of rows) if(r.lat!=null && r.dist_mi!=null && r.bearing!=null && r.layer!=="captures") sites.set(`${r.lat},${r.lon}`, r);
  const RINGS=4, grid=Array.from({length:RINGS},()=>new Array(16).fill(0));
  for(const r of sites.values()) grid[Math.min(RINGS-1,Math.floor(r.dist_mi/radius*RINGS))][Math.round(r.bearing/22.5)%16]++;
  const max=Math.max(1,...grid.flat()), C=170, R0=16, RM=132, pt=(rr,a)=>[C+rr*Math.sin(a*Math.PI/180), C-rr*Math.cos(a*Math.PI/180)].map(n=>n.toFixed(1));
  const ring=i=>R0+(RM-R0)*i/RINGS, step=radius/RINGS, fmtR=d=>d>=10?d.toFixed(0):d>=1?(+d.toFixed(1)).toString():(+d.toFixed(2)).toString();
  let svg=`<svg viewBox="0 0 340 340" style="width:100%;max-width:400px;display:block;margin:auto" role="img" aria-label="Sites by direction and distance from the pin">`;
  grid.forEach((row,i)=>row.forEach((n,j)=>{ const a0=j*22.5-11.25, a1=j*22.5+11.25, ri=ring(i), ro=ring(i+1);
    const [x1,y1]=pt(ro,a0),[x2,y2]=pt(ro,a1),[x3,y3]=pt(ri,a1),[x4,y4]=pt(ri,a0);
    svg+=`<path d="M${x1} ${y1}A${ro} ${ro} 0 0 1 ${x2} ${y2}L${x3} ${y3}A${ri} ${ri} 0 0 0 ${x4} ${y4}Z" fill="var(--accent)" fill-opacity="${n?(0.12+0.78*n/max).toFixed(2):0}" stroke="var(--line)" stroke-width="1"><title>${COMPASS16[j]}, ${fmtR(step*i)}–${fmtR(step*(i+1))} mi: ${n} site${n===1?"":"s"}</title></path>`; }));
  for(let i=1;i<=RINGS;i++){ const [x,y]=pt(ring(i),45); svg+=`<text x="${x}" y="${y}" font-size="10" fill="var(--muted)" dx="3" dy="-3">${fmtR(step*i)} mi</text>`; }
  for(const [lab,a] of [["N",0],["E",90],["S",180],["W",270]]){ const [x,y]=pt(RM+16,a); svg+=`<text x="${x}" y="${y}" font-size="13" font-weight="700" fill="var(--ink)" text-anchor="middle" dominant-baseline="middle">${lab}</text>`; }
  svg+=`<circle cx="${C}" cy="${C}" r="4" fill="var(--ink)"><title>The pin</title></circle></svg>`;
  const top=grid.map((row,i)=>row.map((n,j)=>({n,i,j}))).flat().sort((a,b)=>b.n-a.n)[0];
  const bySec=new Array(16).fill(0); grid.forEach(row=>row.forEach((n,j)=>bySec[j]+=n));
  const sec=bySec.indexOf(Math.max(...bySec));
  return svg+`<p class="hint" style="text-align:center;margin:6px 0 0">${sites.size.toLocaleString()} sites. Darker = more sites in that cell (most: ${max}).
    ${top.n?`Busiest cell: ${COMPASS16[top.j]}, ${fmtR(step*top.i)}–${fmtR(step*(top.i+1))} mi. Busiest direction: ${COMPASS16[sec]} (${bySec[sec]}).`:""}</p>`;
}
const COMPASS16=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
S.views.profile = (v, rows) => {
  const uls=rows.filter(r=>r.layer==="uls");
  if(!rows.length){ v.innerHTML='<p class="status">Nothing with the current layers and filters.</p>'; return; }
  const P=S.prof=S.prof||{count:"freq", top:12, list:15, lv:"both"};
  const lvOf=P.lv==="meas"?(r=>r.dbm):P.lv==="est"?(r=>r.est_rx_dbm):levelOf;
  const digital=uls.filter(r=>/P25|DMR|NXDN|Digital|Data|TETRA/.test(r.mode||"")).length;
  const rpt=uls.filter(r=>r.station_class==="FB2"||r.station_class==="FB4").length;
  const where=S.center?`${S.center[0].toFixed(5)}, ${S.center[1].toFixed(5)} · ${S.radius} mi`:`${$("#county").value?$("#county").value+" County, ":""}${$("#state").value}`;
  const filtersOn=Object.values(S.chips).some(s=>s.size)||$("#q").value||$("#fmin").value||$("#fmax").value;
  const fcc=(/FCC data ([\d-]+ [\d:]+)/.exec($("#meta")?.textContent||"")||[])[1];
  const nearest=S.center?Math.min(...rows.filter(r=>r.layer==="uls"&&r.dist_mi!=null).map(r=>r.dist_mi)):Infinity;
  const strongestLv=Math.max(...rows.map(lvOf).filter(x=>x!=null));
  const card=(val,k,def)=>`<div class="card" title="${esc(def)}"><div class="v">${val}</div><div class="k">${k}</div><div class="hint" style="font-size:11px;margin-top:2px">${def}</div></div>`;
  const unit={rows:"entries",freq:"frequencies",lic:"licensees"}[P.count];
  let html=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px;margin-bottom:6px">
      <label class="inl">Breakdowns count <select id="pfCount"><option value="freq">Frequencies</option><option value="lic">Licensees</option><option value="rows">Entries</option></select></label>
      <label class="inl">Show top <select id="pfTop">${[8,12,20,50].map(n=>`<option ${P.top===n?"selected":""}>${n}</option>`).join("")}</select></label>
      <label class="inl">Lists <select id="pfList">${[10,15,25,50].map(n=>`<option ${P.list===n?"selected":""}>${n}</option>`).join("")}</select> rows</label>
      <label class="inl">Rank levels by <select id="pfLv"><option value="both">Measured + predicted</option><option value="meas">Measured only</option><option value="est">Predicted only (free-space)</option></select></label>
      <span class="hint">Click any bar to filter every tab by it.</span></div>
    <p style="margin:2px 2px 10px"><b>${esc(where)}</b>${S.mission?` · Mission: ${esc(S.mission.name)}`:""}${fcc?` · FCC data ${esc(fcc)}`:""}
      ${filtersOn?' <span class="tag">filters on: everything below follows them</span>':""}</p>
    <div class="cards">
    ${card(new Set(uls.map(r=>fmtF(r.freq_mhz))).size.toLocaleString(),"Licensed frequencies","Distinct MHz on active FCC licences")}
    ${card(new Set(uls.map(r=>r.licensee)).size.toLocaleString(),"Licensees","Distinct licence holders")}
    ${card(rows.filter(r=>r.layer==="towers").length.toLocaleString(),"Registered towers","FCC antenna structure registrations")}
    ${card(rpt.toLocaleString(),"Repeater entries","Station class FB2 / FB4")}
    ${card(`${uls.length?Math.round(100*digital/uls.length):0}%`,"Digital-capable licenses","P25, DMR, NXDN, TETRA or data emissions")}
    ${isFinite(nearest)?card(`${num(nearest,2)} mi`,"Nearest licensed site","Straight-line from the pin"):""}
    ${isFinite(strongestLv)?card(`${num(strongestLv,0)} dBm`,"Strongest level",P.lv==="meas"?"Measured":P.lv==="est"?"Free-space estimate, best case":"Measured, or free-space estimate"):""}
    ${card(rows.filter(r=>r.layer==="captures").length.toLocaleString(),"Captured points","Your imported survey points")}
    ${card(rows.filter(r=>["wigle","opencellid","repeaterbook","custom"].includes(r.layer)).length.toLocaleString(),"Crowdsourced points","WiGLE, OpenCelliD, RepeaterBook, imported layers")}
  </div>`;
  const watch=(S.mission?.settings?.watch)||[];
  for(const w of watch){ const tol=(+w.tol_khz||12.5)/1000, f=+w.freq; if(!f) continue;
    const off=r=>Math.min(Math.abs((r.freq_mhz??1e9)-f), r.freq_upper_mhz?Math.abs(r.freq_upper_mhz-f):1e9, r.freq_in_mhz?Math.abs(r.freq_in_mhz-f):1e9);
    const near=S.rows.filter(r=>off(r)<=tol+1e-9).sort((a,b)=>off(a)-off(b)||(a.dist_mi??0)-(b.dist_mi??0));
    html+=`<div class="panel" style="margin-top:10px"><h3>Watch: ${fmtF(f)} MHz ±${w.tol_khz||12.5} kHz${w.label?` — ${esc(w.label)}`:""}</h3>${near.length?`<p>${near.length} entr${near.length===1?"y":"ies"} on or near this frequency (licenses, repeater inputs, captures, crowd data):</p>`+S.views.freqTable(near.slice(0,25),true):'<p style="color:var(--good)">Nothing licensed, captured or reported on this frequency in the area.</p>'}</div>`; }
  const total=fn=>countMode(rows.filter(r=>fn(r)!=null), ()=>"all", P.count)[0]?.[1]||0;  // the whole, counted the same way
  const allT=total(()=>1), licT=countMode(uls,()=>"all",P.count)[0]?.[1]||0;
  html+=`<div class="grid2">
    <div class="panel"><h3>By signal type <span class="hint">· ${unit}</span></h3>${barsPct(countMode(rows,typeOf,P.count).slice(0,P.top),allT,typeColor,"type")}</div>
    <div class="panel"><h3>By band <span class="hint">· ${unit}</span></h3>${barsPct(countMode(rows,r=>r.band||"Other",P.count).slice(0,P.top),allT,null,"band")}</div>
    <div class="panel"><h3>By category <span class="hint">· ${unit}</span></h3>${barsPct(countMode(rows,r=>r.category||"Other",P.count).slice(0,P.top),allT,null,"cat")}</div>
    <div class="panel"><h3>Top licensees <span class="hint">· ${P.count==="lic"?"frequencies":unit}</span></h3>${barsPct(countMode(uls,r=>r.licensee||"?",P.count==="lic"?"freq":P.count).slice(0,P.top),P.count==="lic"?countMode(uls,()=>"all","freq")[0]?.[1]||0:licT)}</div></div>`;
  if(S.center){ const strong=rows.filter(r=>lvOf(r)!=null).sort((a,b)=>lvOf(b)-lvOf(a)).slice(0,P.list);
    html+=`<div class="grid2">
      <div class="panel"><h3>Where the sites are <span class="hint">· by direction and distance from the pin</span></h3>${polarSites(rows,S.radius)}</div>
      <div class="panel"><h3>Strongest signals <span class="hint">· ${P.lv==="meas"?"measured":P.lv==="est"?"free-space estimate, best case, no terrain":"measured, or free-space estimate"} · dBm</span></h3>${S.views.freqTable(strong,true,["freq","title","type","lvl","dist","src"])}</div></div>
      <div class="panel" style="margin-top:10px"><h3>Nearest sites <span class="hint">· miles and bearing from the pin</span></h3>${S.views.freqTable(groupItems(rows.filter(r=>r.layer==="uls"||r.layer==="towers")).slice(0,P.list),true,["dist","brg","title","freq","cls","h"])}</div>`; }
  html+=printSheet(rows);
  v.innerHTML=html;
  $("#pfCount").value=P.count; $("#pfLv").value=P.lv;
  $("#pfCount").onchange=e=>{ P.count=e.target.value; render(); };
  $("#pfTop").onchange=e=>{ P.top=+e.target.value; render(); };
  $("#pfList").onchange=e=>{ P.list=+e.target.value; render(); };
  $("#pfLv").onchange=e=>{ P.lv=e.target.value; render(); };
};
function printSheet(rows){
  const uniq=new Map(); for(const r of rows){ if(!r.freq_mhz) continue; const k=fmtF(r.freq_mhz)+"|"+titleOf(r); const c=uniq.get(k); if(!c||(r.dist_mi??1e9)<(c.dist_mi??1e9)) uniq.set(k,r); }
  const list=[...uniq.values()].sort((a,b)=>a.freq_mhz-b.freq_mhz);
  const where=S.center?`${S.center[0].toFixed(5)}, ${S.center[1].toFixed(5)} — ${S.radius} mi`:`${$("#county").value} ${$("#state").value}`;
  return `<div id="printSheet" class="print-only"><h2>RF site survey prep — ${esc(S.mission?.name||"")} ${esc(where)}</h2>
    <p>Generated ${new Date().toLocaleString()}. Sources: ${esc([...S.layerOn].map(l=>LAYERS[l]?.label).join(", "))}. Federal users are not in FCC ULS.</p>
    <table><thead><tr><th>Freq MHz</th><th>Input</th><th>Name</th><th>Source</th><th>Type</th><th>Emission</th><th>ERP W</th><th>Dist</th><th>Brg</th><th>dBm</th><th>Heard?</th></tr></thead>
    <tbody>${list.map(r=>`<tr><td>${fmtF(r.freq_mhz)}</td><td>${fmtF(r.freq_upper_mhz||r.freq_in_mhz)}</td><td>${esc(titleOf(r))}</td><td>${esc(LAYERS[r.layer]?.label||"")}</td><td>${esc(typeOf(r))}</td><td>${esc(r.emissions||"")}</td><td>${num(erpOf(r))}</td><td>${num(r.dist_mi,1)}</td><td>${r.compass||""}</td><td>${num(levelOf(r),0)}</td><td>☐</td></tr>`).join("")}</tbody></table></div>`;
}

/* ---------- agencies (RadioReference-style) ---------- */
S.views.agencies = (v, rows) => {
  const uls=rows.filter(r=>r.layer==="uls"||r.layer==="uls_hist");
  if(!uls.length){ v.innerHTML='<p class="status">No FCC-licensed entries with the current layers and filters.</p>'; return; }
  const A=S.ag=S.ag||{sort:"name", q:""};
  const q=A.q.trim().toLowerCase();
  const byCat=new Map(); for(const r of uls){ const k=r.licensee||r.call_sign; if(q && !`${k} ${r.call_sign} ${fmtF(r.freq_mhz)} ${r.ov_alpha_tag||""}`.toLowerCase().includes(q)) continue;
    const c=r.category||"Other"; if(!byCat.has(c)) byCat.set(c,new Map()); const m=byCat.get(c); if(!m.has(k)) m.set(k,[]); m.get(k).push(r); }
  const nearestOf=rs=>Math.min(...rs.map(r=>r.dist_mi??Infinity)), freqsOf=rs=>new Set(rs.map(r=>fmtF(r.freq_mhz))).size;
  const order={name:(a,b)=>a[0].localeCompare(b[0]), near:(a,b)=>nearestOf(a[1])-nearestOf(b[1]), most:(a,b)=>freqsOf(b[1])-freqsOf(a[1])}[A.sort];
  const nLic=[...byCat.values()].reduce((s,m)=>s+m.size,0);
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Sort licensees <select id="agSort"><option value="name">A to Z</option><option value="near">Nearest first</option><option value="most">Most frequencies</option></select></label>
      <label class="inl">Find <input id="agQ" value="${esc(A.q)}" placeholder="licensee, call sign, MHz, tag" style="width:220px"></label>
      <button id="agOpen">Expand all</button><button id="agClose">Collapse all</button>
      <span class="hint">${nLic.toLocaleString()} licensees in ${byCat.size} categories${q?` matching “${esc(A.q)}”`:""}. Click a row for details, labels and tones.</span></div>`+
    [...byCat].sort((a,b)=>[...b[1].values()].flat().length-[...a[1].values()].flat().length).map(([cat,ags])=>
    `<h3 style="margin-top:14px"><span class="dot" style="background:${catColor2(cat)}"></span> ${esc(cat)} <span class="hint">· ${ags.size} licensees</span></h3>`+
    [...ags].sort(order).map(([name,rs])=>{ const byF=new Map(); for(const r of rs){ const k=fmtF(r.freq_mhz)+"|"+r.call_sign; if(!byF.has(k)) byF.set(k,[]); byF.get(k).push(r); }
      const list=[...byF.values()].map(g=>Object.assign({},g.sort((a,b)=>(a.dist_mi??0)-(b.dist_mi??0))[0],{_sites:g.length})).sort((a,b)=>a.freq_mhz-b.freq_mhz);
      const nearest=nearestOf(rs);
      return `<details class="panel ag" style="padding:0;margin-bottom:8px" ${ags.size<=6||q?"open":""}><summary style="padding:9px 12px;cursor:pointer"><b>${esc(name)}</b> <span class="hint">${byF.size} freq · ${new Set(rs.map(r=>r.call_sign)).size} licenses${isFinite(nearest)?` · nearest ${nearest.toFixed(1)} mi`:""} · ${esc([...new Set(rs.map(r=>r.service_name))].slice(0,2).join(" · "))}</span></summary>
        <div class="tw" style="border:0;border-top:1px solid var(--line);border-radius:0"><table><thead><tr><th>MHz</th><th>Input / upper</th><th>Band</th><th>Type</th><th>Alpha tag</th><th>Mode</th><th>Tone</th><th>Description</th><th>Sites</th><th>Nearest</th><th>ERP W</th><th>Call sign</th></tr></thead><tbody>`+
        list.map(r=>`<tr data-fid="${esc(r.fid)}"><td class="f">${fmtF(r.freq_mhz)}</td><td class="mono">${fmtF(r.freq_upper_mhz)}</td><td>${esc(r.band||"")}</td><td>${esc(classLabel(r.station_class))}</td><td>${esc(r.ov_alpha_tag||"")} ${r.ov_verified?'<span class="tag v">✓</span>':""}</td><td>${esc(r.ov_mode||r.mode||"")}</td><td class="mono">${esc(r.ov_tone||"")}</td><td>${esc(r.ov_description||"")}</td><td class="n">${r._sites}</td><td class="n">${r.dist_mi!=null?`${num(r.dist_mi,2)} mi ${esc(r.compass||"")}`:""}</td><td class="n">${num(erpOf(r))}</td><td class="mono">${esc(r.call_sign)}</td></tr>`).join("")+
        `</tbody></table></div></details>`; }).join("")).join("");
  $("#agSort").value=A.sort; $("#agSort").onchange=e=>{ A.sort=e.target.value; render(); };
  let t; $("#agQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ A.q=e.target.value; render(); const i=$("#agQ"); i.focus(); i.setSelectionRange(i.value.length,i.value.length); },300); };
  $("#agOpen").onclick=()=>v.querySelectorAll("details.ag").forEach(d=>d.open=true);
  $("#agClose").onclick=()=>v.querySelectorAll("details.ag").forEach(d=>d.open=false);
};

/* ---------- spectrum ---------- */
// Spectrum lives in spectrum.js.
