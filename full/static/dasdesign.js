"use strict";
/* RF Recon — a DAS job's design: the link budget per band (downlink and uplink, with the code and FCC checks), server
   antennas and walls on the floor plans with predicted coverage, and battery sizing. The submittal packet (das.js
   Report) prints them with the plans, the bill of materials and the consent letters. Defaults come from the cited
   research (static/research/link_budget.json and the DAS research); every default shows where it came from and can be
   changed per job. */

/* ---------- the engine (pure: no page needed) ---------- */
const LB = {
  log10: x => Math.log10(x),
  fspl: (dM, fMHz) => 20*Math.log10(Math.max(dM, 1)) + 20*Math.log10(fMHz) - 27.55,          // ITU-R P.525, d in m
  p1238: (dM, fMHz, N, lf = 0) => 20*Math.log10(fMHz) + N*Math.log10(Math.max(dM, 1)) + lf - 28, // ITU-R P.1238 site-general
  kTB: bHz => -174 + 10*Math.log10(bHz),
  ft2m: ft => ft*0.3048,
};
// built-in defaults that come straight from rules already in RF Recon's research (the DAS research and 47 CFR 90.219);
// the link-budget research adds the rest (portable power, body loss, sensitivity, component losses, P.1238 N)
const LB_BASE = {
  dl_min_dbm: {v: -95, src: "IFC 2021 510.4.1.1 (−95 dBm; IFC 2024 and NFPA 1225 use DAQ 3.0)"},
  ul_min_dbm: {v: -95, src: "IFC 2015 510 (−95 dBm in and out)"},
  isolation_margin_db: {v: 20, src: "DAS research: donor to server isolation at least the system gain + 20 dB"},
  bda_nf_db: {v: 9, src: "47 CFR 90.219: noise figure 9 dB or less (worst case allowed)"},
  per_channel_erp_max_dbm: {v: 37, src: "47 CFR 90.219: 5 W ERP per channel"},
  noise_erp_max_dbm: {v: -43, src: "47 CFR 90.219: in-band noise −43 dBm ERP per 10 kHz"},
  bandwidth_khz: {v: 12.5, src: "narrowband channel (12.5 kHz)"},
  fade_margin_db: {v: 0, src: "no margin set: add your design margin"},
  site_net_gain_db: {v: 0, src: "site antenna gain less its feedline: set it if the agency gives it"},
};
// a default: the job's own value, else the link-budget research's, else the base above
function lbParam(id){
  const r=FR.budget, p=r&&!r.empty?(r.parameters||[]).find(x=>x.id===id):null;
  if(p&&typeof p.default==="number") return {v:p.default, src:p.name||id, cite:p.sources};
  return LB_BASE[id]||{v:null, src:"not in the research: set it"};
}
// the research keys some values by band: VHF, UHF (T-band included), 700, 800; VHF low (30-50 MHz) has none
const lbBandKey = band => /700/.test(band)?"700":/800/.test(band)?"800":/vhf low/i.test(band)?null:/vhf/i.test(band)?"vhf":/uhf|t-band/i.test(band)?"uhf":null;
// every default for one band: {field: {v, src, cite}}
function lbDefaults(band){
  const k=lbBandKey(band), k78=k==="700"||k==="800"?"700_800":k, none={v:null, src:"no researched default for this band: set it"};
  const corr=k78?lbParam(`portable_antenna_corr_${k78}_dbd`):none;
  return {
    portable_dbm: k?lbParam(`portable_power_${k}_dbm`):none,
    body_db: corr.v!=null?{v:+(-(corr.v)-2.15).toFixed(2), src:`portable antenna and body: ${corr.v} dBd (TSB-88.1-C draft) = ${(-(corr.v)-2.15).toFixed(2)} dB below isotropic`, cite:corr.cite}:none,
    server_gain_dbi: k78?lbParam(`server_antenna_gain_${k78}_dbi`):none,
    site_sens_dbm: k==="vhf"?lbParam("site_sensitivity_vhf_dbm"):k?lbParam("site_sensitivity_dbm"):none,
    N: (()=>{ const row=(FR.budget?.p1238||[]).find(x=>x.environment==="office"&&String(x.freq_band).startsWith("0.9")); return row?{v:row.n, src:`ITU-R P.1238 office, 0.9 GHz${/vhf/i.test(band)?" (P.1238 has no VHF values: used as an estimate)":k==="uhf"?" (nearest listed band)":""}`, cite:row.sources}:{v:30, src:"no P.1238 table: 30"}; })(),
    margin_db: lbParam("fade_margin_db"),
    dl_min_dbm: typeof DASJ!=="undefined"&&typeof DASJ?.threshold==="number"?{v:DASJ.threshold, src:"this job's requirement (Requirements)"}:lbParam("dl_min_dbm"), ul_min_dbm: lbParam("ul_min_dbm"), ul_max_dbm: lbParam("ul_max_dbm"),
    connector_db: lbParam("connector_loss_db"), bda_nf_db: lbParam("bda_nf_db"), bw_khz: lbParam("bandwidth_khz"), isolation_margin_db: lbParam("isolation_margin_db"),
    ul_gain_max_db: lbParam("ul_gain_max_db"), donor_port_max_dbm: lbParam("ul_donor_port_max_dbm"), noise_site_max_dbm: lbParam("noise_at_site_max_dbm"),
    erp_limit_dbm: lbParam("per_channel_erp_max_dbm"), noise_limit_dbm: lbParam("noise_erp_max_dbm"), site_net_gain_db: lbParam("site_net_gain_db"),
  };
}
// loss of the passive elements at f: cable runs (datasheet loss), parts with a fixed loss, connectors
function lbPassive(els, fMHz, connDb){
  let db=0; const rows=[];
  for(const e of els||[]){
    if(e.kind==="cable"){ const c=(FR.parts?.cables||[]).find(x=>x.name===e.cable), L=c&&cableLoss(c,fMHz), v=L?L.db*(+e.ft||0)/100:0; db+=v; rows.push({name:`${e.cable||"cable"} · ${e.ft||0} ft`, db:v}); }
    else { const v=+e.db||0; db+=v; rows.push({name:e.name||"part", db:v}); }
  }
  return {db, rows};
}
// the whole budget for one band; inputs I (see dasBudget for the fields), returns stages, checks and key numbers
function lbCompute(I){
  const n=v=>(v===""||v==null||isNaN(+v))?null:+v, num0=v=>n(v)??0;
  const conn=num0(I.connector_db), pass_dl=lbPassive(I.passive, I.f_dl, conn), pass_ul=lbPassive(I.passive, I.f_ul||I.f_dl, conn);
  const donorDl=lbPassive(I.donor_cable?[I.donor_cable]:[], I.f_dl, 0).db+num0(I.donor_connectors)*conn;
  const donorUl=lbPassive(I.donor_cable?[I.donor_cable]:[], I.f_ul||I.f_dl, 0).db+num0(I.donor_connectors)*conn;
  const passDl=pass_dl.db+num0(I.connectors)*conn, passUl=pass_ul.db+num0(I.connectors)*conn;
  const dM=LB.ft2m(num0(I.edge_ft)), walls=num0(I.walls_db);
  const pl=f=>I.model==="fspl"?LB.fspl(dM,f):LB.p1238(dM,f,num0(I.N)||30,num0(I.floor_loss));
  const nch=Math.max(1,num0(I.n_ch)||1);
  // downlink
  const dl=[], push=(arr,stage,db,level,note="")=>arr.push({stage,db,level,note});
  let L=n(I.roof_dbm);
  push(dl,"Signal at the roof (isotropic)",null,L,I.roof_src||"");
  L=L+num0(I.donor_gain_dbi); push(dl,"Donor antenna gain",num0(I.donor_gain_dbi),L);
  L=L-donorDl; push(dl,"Donor cable and connectors",-donorDl,L);
  const bdaIn=L, perCh=n(I.bda_max_dbm)!=null?n(I.bda_max_dbm)-10*Math.log10(nch)-num0(I.backoff_db):null, want=bdaIn+num0(I.bda_dl_gain_db);
  const bdaOut=perCh!=null?Math.min(want,perCh):want;
  push(dl,`BDA downlink gain${perCh!=null&&want>perCh?" (output limited)":""}`,num0(I.bda_dl_gain_db),bdaOut,perCh!=null?`${nch} channel${nch===1?"":"s"}: at most ${perCh.toFixed(1)} dBm each`:"");
  L=bdaOut-passDl; push(dl,"Passive network to the farthest antenna",-passDl,L,pass_dl.rows.map(r=>`${r.name} ${r.db.toFixed(1)}`).join(" · "));
  const eirp=L+num0(I.server_gain_dbi); push(dl,"Server antenna gain (EIRP)",num0(I.server_gain_dbi),eirp);
  const plDl=pl(I.f_dl); L=eirp-plDl; push(dl,`In-building path, ${num0(I.edge_ft)} ft (${I.model==="fspl"?"free space":"ITU-R P.1238"})`,-plDl,L);
  L=L-walls; push(dl,"Walls and floors in the way",-walls,L);
  const edge=L;
  // uplink
  const ul=[]; const fu=I.f_ul||I.f_dl;
  let U=num0(I.portable_dbm); push(ul,"Portable radio power",null,U,I.portable_src||"");
  U-=num0(I.body_db); push(ul,"Body and hand loss",-num0(I.body_db),U);
  const plUl=pl(fu); U-=plUl; push(ul,`In-building path, ${num0(I.edge_ft)} ft`,-plUl,U);
  U-=walls; push(ul,"Walls and floors",-walls,U);
  U+=num0(I.server_gain_dbi); push(ul,"Server antenna gain",num0(I.server_gain_dbi),U);
  U-=passUl; push(ul,"Passive network",-passUl,U);
  const ulIn=U, ulMax=n(I.bda_ul_max_dbm), ulWant=ulIn+num0(I.bda_ul_gain_db), ulOut=ulMax!=null?Math.min(ulWant,ulMax):ulWant;
  push(ul,`BDA uplink gain${ulMax!=null&&ulWant>ulMax?" (output limited)":""}`,num0(I.bda_ul_gain_db),ulOut);
  U=ulOut-donorUl; push(ul,"Donor cable and connectors",-donorUl,U);
  const erpUl=U+num0(I.donor_gain_dbi)-2.15; push(ul,"Donor antenna (ERP toward the site)",num0(I.donor_gain_dbi)-2.15,erpUl,"ERP = EIRP − 2.15 dB");
  // the path to the site: from its ERP and the roof level when both are known, else free space over the distance
  const siteErp=n(I.site_erp_dbm), roof=n(I.roof_dbm);
  const plSiteDl=siteErp!=null&&roof!=null?siteErp+2.15-roof:n(I.site_dist_mi)!=null?LB.fspl(n(I.site_dist_mi)*1609.34,I.f_dl):null;
  const plSiteUl=plSiteDl!=null?plSiteDl+20*Math.log10(fu/I.f_dl):null;
  const atSite=plSiteUl!=null?erpUl+2.15-plSiteUl+num0(I.site_net_gain_db):null;
  if(plSiteUl!=null){ push(ul,"Path to the agency site",-plSiteUl,atSite-num0(I.site_net_gain_db),
      siteErp!=null&&roof!=null?"from the site's ERP and the signal at the roof":`free space over ${n(I.site_dist_mi)} mi (best case: hills and buildings add loss)`);
    push(ul,"Site antenna less feedline",num0(I.site_net_gain_db),atSite); }
  // noise the booster sends toward the site: per 10 kHz for 90.219, per channel at the site receiver
  const nf=n(I.bda_nf_db)??9, g=num0(I.bda_ul_gain_db);
  const noiseErp10k=LB.kTB(10e3)+nf+g-donorUl+num0(I.donor_gain_dbi)-2.15;
  const bw=(n(I.bw_khz)??12.5)*1e3, noiseSite=plSiteUl!=null?LB.kTB(bw)+nf+g-donorUl+num0(I.donor_gain_dbi)-plSiteUl+num0(I.site_net_gain_db):null;
  const siteFloor=LB.kTB(bw)+(n(I.site_nf_db)??5), rise=noiseSite!=null?10*Math.log10(1+Math.pow(10,(noiseSite-siteFloor)/10)):null;
  const noiseSite10k=plSiteUl!=null?noiseSite-10*Math.log10(bw/10e3):null;  // the AHJ limits are per 10 kHz
  // checks: ok is true, false, "warn", or null when an input is missing. A limit left blank skips its check.
  const C=[], chk=(id,name,ok,detail)=>C.push({id,name,ok,detail});
  const dlNeed=num0(I.dl_min_dbm)+num0(I.margin_db);
  chk("dl_edge","Downlink at the far edge",edge>=dlNeed,`${edge.toFixed(1)} dBm vs ${dlNeed.toFixed(1)} dBm needed (${num0(I.dl_min_dbm)} + ${num0(I.margin_db)} dB margin)`);
  const ulMin=n(I.ul_min_dbm)??-95, ulTop=n(I.ul_max_dbm);
  if(atSite!=null) chk("ul_site","Uplink level at the agency's receiver",atSite>=ulMin&&(ulTop==null||atSite<=ulTop),
    `${atSite.toFixed(1)} dBm vs ${ulTop!=null?`${ulMin} to ${ulTop}`:`at least ${ulMin}`} dBm${ulTop!=null&&atSite>ulTop?": too hot; lower the uplink gain":""}`);
  else chk("ul_site","Uplink level at the agency's receiver",null,"needs the site's distance or ERP");
  const ulNeed=n(I.site_sens_dbm)!=null?n(I.site_sens_dbm)+num0(I.margin_db):null;
  if(atSite!=null&&ulNeed!=null) chk("ul_sens","Uplink over the receiver's sensitivity",atSite>=ulNeed,`${atSite.toFixed(1)} dBm vs ${ulNeed.toFixed(1)} dBm (sensitivity ${n(I.site_sens_dbm)} + ${num0(I.margin_db)} dB margin)`);
  else chk("ul_sens","Uplink over the receiver's sensitivity",null,"needs the site's distance or ERP and its receiver sensitivity");
  const erpLim=n(I.erp_limit_dbm)??37, dlErpServer=eirp-2.15;
  chk("erp","Uplink ERP within 5 W (47 CFR 90.219)",erpUl<=erpLim,`${erpUl.toFixed(1)} dBm ERP vs ${erpLim} dBm`);
  chk("dl_erp","Server antenna ERP within 5 W (47 CFR 90.219)",dlErpServer<=erpLim,`${dlErpServer.toFixed(1)} dBm ERP per channel vs ${erpLim} dBm`);
  const portMax=n(I.donor_port_max_dbm);
  if(portMax!=null) chk("donor_port","Uplink at the BDA donor port",ulOut<=portMax,`${ulOut.toFixed(1)} dBm per channel vs ${portMax} dBm`);
  const gMax=n(I.ul_gain_max_db);
  if(gMax!=null) chk("ul_gain","Uplink gain within the AHJ cap",n(I.bda_ul_gain_db)!=null?g<=gMax:null,n(I.bda_ul_gain_db)!=null?`${g} dB vs ${gMax} dB (more needs the AHJ's approval)`:"needs the BDA uplink gain");
  const dlErp=bdaOut-donorDl;  // what the BDA could send back up through the donor if it oscillated is the isolation check's job
  const nLim=n(I.noise_limit_dbm)??-43;
  chk("noise","Uplink noise within 90.219",noiseErp10k<=nLim,`${noiseErp10k.toFixed(1)} dBm ERP per 10 kHz vs ${nLim} dBm (noise figure ${nf} dB, gain ${g} dB)`);
  const nSiteMax=n(I.noise_site_max_dbm);
  if(nSiteMax!=null&&noiseSite10k!=null) chk("noise_site","BDA noise at the agency's receiver",noiseSite10k<=nSiteMax,`${noiseSite10k.toFixed(1)} dBm per 10 kHz vs ${nSiteMax} dBm`);
  if(rise!=null) chk("rise","Noise rise at the agency's receiver",rise<=1,`${rise.toFixed(2)} dB over its own noise floor (${siteFloor.toFixed(1)} dBm in ${bw/1e3} kHz)`);
  const isoGain=Math.max(num0(I.bda_dl_gain_db),g), isoMargin=n(I.isolation_margin_db)??20, isoNeed=isoGain+isoMargin, iso=n(I.isolation_db);
  chk("isolation","Donor to server isolation",iso==null?null:iso>=isoNeed?true:iso>=isoGain+Math.min(15,isoMargin)?"warn":false,
    iso!=null?`${iso} dB vs ${isoNeed} dB needed (gain + ${isoMargin})${iso<isoNeed&&iso>=isoGain+Math.min(15,isoMargin)?": under the margin, still 15 dB over the gain":""}`:`needs a measured or estimated isolation: at least ${isoNeed} dB`);
  if(perCh!=null) chk("headroom","BDA output headroom",want<=perCh,`${(perCh-want).toFixed(1)} dB under the per-channel maximum${want>perCh?": the BDA is limiting; lower its gain":""}`);
  return {dl, ul, checks:C, edge, eirp, bdaOut, perCh, atSite, erpUl, noiseErp10k, noiseSite10k, rise, passDl, passUl, plSiteDl, dlErp};
}

/* ---------- the Design sub-tab: link budget · antennas & coverage · battery ---------- */
const DS_VIEWS=[["budget","Link budget"],["floors","Antennas and coverage"],["battery","Battery"]];
function dsBands(d){
  const plan=(d.presurvey||{}).plan||[], m=new Map();
  for(const p of plan){ const b=p.band||dasBand(+p.downlink_mhz); const x=m.get(b)||{band:b, dl:[], ul:[], best:null, systems:new Set()};
    x.dl.push(+p.downlink_mhz); String(p.uplink_mhz||"").split(" ").filter(Boolean).forEach(u=>x.ul.push(+u));
    if(p.best_outdoor_dbm!==""&&p.best_outdoor_dbm!=null) x.best=Math.max(x.best??-999,+p.best_outdoor_dbm); x.systems.add(p.system); m.set(b,x); }
  return [...m.values()].map(x=>({...x, f_dl:Math.max(...x.dl), f_ul:x.ul.length?Math.max(...x.ul):Math.max(...x.dl), n_ch:new Set(x.dl).size, systems:[...x.systems]}));
}
// one band's inputs: what the job saved, else the defaults (with where each came from)
function dsInputs(d, b){
  const saved=((d.design||{}).bands||{})[b.band]||{}, D=lbDefaults(b.band), v=k=>D[k]?.v;
  const def={f_dl:b.f_dl, f_ul:b.f_ul, n_ch:b.n_ch, roof_dbm:b.best, roof_src:b.best!=null?"pre-survey free-space estimate (best case): replace with a measured reading":"",
    donor_gain_dbi:null, donor_cable:null, donor_connectors:2, bda_dl_gain_db:null, bda_ul_gain_db:null, bda_max_dbm:null, bda_ul_max_dbm:null, backoff_db:0,
    bda_nf_db:v("bda_nf_db")??9, passive:[], connectors:0, connector_db:v("connector_db")??0.1, server_gain_dbi:v("server_gain_dbi"), edge_ft:100, walls_db:0,
    model:"p1238", N:v("N")??30, floor_loss:0, margin_db:v("margin_db")??0, dl_min_dbm:v("dl_min_dbm")??-95,
    ul_min_dbm:v("ul_min_dbm")??-95, ul_max_dbm:v("ul_max_dbm"), portable_dbm:v("portable_dbm"), portable_src:D.portable_dbm?.src, body_db:v("body_db"),
    site_sens_dbm:v("site_sens_dbm"), site_net_gain_db:0, site_nf_db:null, site_dist_mi:null, site_erp_dbm:null, bw_khz:v("bw_khz")??12.5,
    isolation_db:null, isolation_margin_db:v("isolation_margin_db")??20, ul_gain_max_db:v("ul_gain_max_db"), donor_port_max_dbm:v("donor_port_max_dbm"),
    noise_site_max_dbm:v("noise_site_max_dbm"), erp_limit_dbm:v("erp_limit_dbm")??37, noise_limit_dbm:v("noise_limit_dbm")??-43};
  return {...def, ...saved};
}

window.dasDesign = async (el, j, save) => {
  await Promise.all([frLoad("budget"), frLoad("parts"), frLoad("plans")]);
  const D=S.das; D.dview=D.dview||"budget";
  el.innerHTML=`<div class="seg no-print" id="dsSeg" style="margin-bottom:10px">${DS_VIEWS.map(([k,l])=>`<button data-v="${k}" class="${D.dview===k?"on":""}">${l}</button>`).join("")}</div><div id="dsBody"></div>`;
  $("#dsSeg").onclick=e=>{ const b=e.target.closest("[data-v]"); if(b){ D.dview=b.dataset.v; render(); } };
  ({budget:dsBudget, floors:dsFloors, battery:dsBattery}[D.dview]||dsBudget)($("#dsBody"), j, save);
};

/* ---------- link budget ---------- */
const LB_FIELDS=[  // [key, label, unit, group]
  ["roof_dbm","Signal at the roof (isotropic)","dBm","Donor"],["donor_gain_dbi","Donor antenna gain","dBi","Donor"],["donor_connectors","Donor connectors","count","Donor"],
  ["bda_dl_gain_db","BDA downlink gain","dB","Booster"],["bda_ul_gain_db","BDA uplink gain","dB","Booster"],["bda_max_dbm","BDA max output (composite)","dBm","Booster"],
  ["bda_ul_max_dbm","BDA uplink max output","dBm","Booster"],["backoff_db","Output backoff","dB","Booster"],["bda_nf_db","BDA noise figure","dB","Booster"],["n_ch","Channels in this band","count","Booster"],
  ["connector_db","Loss per connector","dB","Passive network"],["connectors","Connectors to the farthest antenna","count","Passive network"],
  ["server_gain_dbi","Server antenna gain","dBi","Building"],["edge_ft","Farthest point from an antenna","ft","Building"],["walls_db","Walls and floors in the way","dB","Building"],
  ["N","P.1238 distance coefficient N","","Building"],["floor_loss","P.1238 floor loss","dB","Building"],["margin_db","Design margin","dB","Building"],["dl_min_dbm","Downlink needed","dBm","Building"],
  ["portable_dbm","Portable radio power","dBm","Uplink and site"],["body_db","Portable antenna and body loss","dB","Uplink and site"],["site_sens_dbm","Site receiver sensitivity","dBm","Uplink and site"],
  ["site_net_gain_db","Site antenna less feedline","dB","Uplink and site"],["site_nf_db","Site receiver noise figure","dB","Uplink and site"],["site_dist_mi","Distance to the site","mi","Uplink and site"],
  ["site_erp_dbm","Site ERP","dBm","Uplink and site"],["bw_khz","Channel bandwidth","kHz","Uplink and site"],["isolation_db","Donor to server isolation (measured or estimated)","dB","Checks"],
  ["isolation_margin_db","Isolation margin over gain","dB","Checks"],["ul_min_dbm","Uplink at the site, at least","dBm","Checks"],["ul_max_dbm","Uplink at the site, at most","dBm","Checks"],
  ["ul_gain_max_db","Uplink gain cap","dB","Checks"],["donor_port_max_dbm","Uplink at the donor port, at most","dBm","Checks"],["noise_site_max_dbm","BDA noise at the site, at most (per 10 kHz)","dBm","Checks"],
  ["erp_limit_dbm","ERP per channel, at most","dBm","Checks"],["noise_limit_dbm","Uplink noise ERP, at most (per 10 kHz)","dBm","Checks"]];
// where a default came from, with its citations
const lbSrcNote = p => p.cite?`${esc(p.src)} ${frCite(FR.budget,p.cite)}`:esc(p.src||"");
async function dsBudget(el, j, save){
  const d=j.data||{}, bands=dsBands(d);
  if(!bands.length){ el.innerHTML='<p class="status">Pick the systems in the Pre-survey first: the link budget works per band from their channels.</p>'; return; }
  const D=S.das; D.lbBand=bands.some(b=>b.band===D.lbBand)?D.lbBand:bands[0].band;
  const b=bands.find(x=>x.band===D.lbBand), I=dsInputs(d,b), R=lbCompute(I), cables=(FR.parts?.cables||[]).filter(c=>c.loss_db_100ft);
  const keep=async patch=>{ const all={...((d.design||{}).bands||{})}, x={...(all[b.band]||{}), ...patch};
    for(const k in patch) if(patch[k]===null) delete x[k];  // a cleared field goes back to its default
    all[b.band]=x; await save({design:{...(d.design||{}), bands:all}}); render(); };
  const Dflt=lbDefaults(b.band), mine=((d.design||{}).bands||{})[b.band]||{};
  const field=([k,l,u])=>{ const v=I[k]; return `<label style="display:block;margin:4px 0"><span class="hint">${esc(l)}${u?` (${u})`:""}</span>
    <input data-lb="${k}" type="number" step="any" value="${v??""}" style="width:100%">${Dflt[k]&&mine[k]==null?`<span class="hint" style="font-size:11px">default: ${lbSrcNote(Dflt[k])}</span>`:""}</label>`; };
  const groups=[...new Set(LB_FIELDS.map(f=>f[3]))];
  const stageTable=rows=>`<table><thead><tr><th>Stage</th><th class="n">dB</th><th class="n">Level dBm</th><th>Note</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.stage)}</td><td class="n">${r.db==null?"":(r.db>=0?"+":"")+r.db.toFixed(1)}</td><td class="n"><b>${r.level==null||isNaN(r.level)?"–":r.level.toFixed(1)}</b></td><td class="hint">${esc(r.note||"")}</td></tr>`).join("")}</tbody></table>`;
  el.innerHTML=`<div class="maptools no-print" style="gap:10px;flex-wrap:wrap"><div class="seg" id="lbBand">${bands.map(x=>`<button data-b="${esc(x.band)}" class="${x.band===b.band?"on":""}">${esc(x.band)}</button>`).join("")}</div>
      <span class="hint">${b.n_ch} downlink channel${b.n_ch===1?"":"s"} · worst case at ${b.f_dl} MHz down, ${b.f_ul} MHz up · ${esc(b.systems.join(", "))}</span></div>
    <div class="cards" style="margin:0 0 10px">${R.checks.map(c=>`<div class="card" title="${esc(c.detail)}"><div class="v" style="color:${c.ok==null?"var(--muted)":c.ok==="warn"?"var(--warn)":c.ok?"var(--good)":"var(--bad)"}">${c.ok==null?"–":c.ok==="warn"?"Warn":c.ok?"Pass":"Fail"}</div><div class="k">${esc(c.name)}<br><span class="hint">${esc(c.detail)}</span></div></div>`).join("")}</div>
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(300px,1fr) minmax(360px,1.4fr)">
      <div class="panel"><h3>Inputs <span class="hint">· saved with the job; clear a field for its default</span></h3>
        ${groups.map(g=>`<details ${["Donor","Booster","Building"].includes(g)?"open":""}><summary style="cursor:pointer"><b>${esc(g)}</b></summary>${LB_FIELDS.filter(f=>f[3]===g).map(field).join("")}
          ${g==="Donor"?`<label style="display:block;margin:4px 0"><span class="hint">Donor cable</span><div class="row" style="gap:6px"><select id="lbDc" style="flex:1"><option value="">none</option>${cables.map(c=>`<option ${I.donor_cable?.cable===c.name?"selected":""}>${esc(c.name)}</option>`).join("")}</select><input id="lbDcFt" type="number" step="any" placeholder="ft" value="${I.donor_cable?.ft??""}" style="width:80px"></div></label>`:""}
          ${g==="Building"?`<label style="display:block;margin:4px 0"><span class="hint">In-building model</span><select id="lbModel"><option value="p1238" ${I.model!=="fspl"?"selected":""}>ITU-R P.1238 (distance coefficient)</option><option value="fspl" ${I.model==="fspl"?"selected":""}>Free space + walls</option></select></label>`:""}
          ${g==="Passive network"?`<div id="lbPass">${(I.passive||[]).map((e,i)=>`<div class="row" style="gap:6px;align-items:center;margin:3px 0"><span style="flex:1">${e.kind==="cable"?`${esc(e.cable)} · ${e.ft} ft`:`${esc(e.name)} · ${e.db} dB`}</span><button data-rmp="${i}">✕</button></div>`).join("")||'<p class="hint">No parts yet: add the cable runs and splitters or couplers to the farthest antenna.</p>'}</div>
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px"><select id="lbPc" style="flex:1"><option value="">Cable…</option>${cables.map(c=>`<option>${esc(c.name)}</option>`).join("")}</select><input id="lbPcFt" type="number" step="any" placeholder="ft" style="width:70px"><button id="lbAddC">Add run</button></div>
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px"><input id="lbPn" placeholder="Splitter, coupler tap…" style="flex:1"><input id="lbPd" type="number" step="any" placeholder="dB" style="width:70px"><button id="lbAddP">Add part</button></div>
            <button id="lbFromBom" style="margin-top:6px" title="Cable runs from this job's Materials list">Add the cable runs from Materials</button>`:""}</details>`).join("")}</div>
      <div><div class="panel"><h3>Downlink: agency site to the far edge</h3>${stageTable(R.dl)}</div>
        <div class="panel"><h3>Uplink: portable radio to the agency site</h3>${stageTable(R.ul)}</div>
        <p class="hint">${R.perCh!=null?`Per-channel output: ${R.bdaOut.toFixed(1)} dBm (at most ${R.perCh.toFixed(1)}). `:""}Antenna EIRP ${R.eirp.toFixed(1)} dBm per channel: the Antennas and coverage view uses it. ${LB_FORMULA_NOTE}</p></div></div>`;
  $("#lbBand").onclick=e=>{ const x=e.target.closest("[data-b]"); if(x){ D.lbBand=x.dataset.b; render(); } };
  el.querySelectorAll("[data-lb]").forEach(i=>i.onchange=()=>keep({[i.dataset.lb]:i.value===""?null:+i.value}));
  $("#lbModel").onchange=e=>keep({model:e.target.value});
  const dc=()=>keep({donor_cable:$("#lbDc").value?{kind:"cable", cable:$("#lbDc").value, ft:+$("#lbDcFt").value||0}:null});
  $("#lbDc").onchange=dc; $("#lbDcFt").onchange=dc;
  if($("#lbAddC")) $("#lbAddC").onclick=()=>{ if(!$("#lbPc").value) return; keep({passive:[...(I.passive||[]), {kind:"cable", cable:$("#lbPc").value, ft:+$("#lbPcFt").value||0}]}); };
  if($("#lbAddP")) $("#lbAddP").onclick=()=>{ if(!$("#lbPn").value) return; keep({passive:[...(I.passive||[]), {kind:"part", name:$("#lbPn").value, db:+$("#lbPd").value||0}]}); };
  el.querySelectorAll("[data-rmp]").forEach(x=>x.onclick=()=>keep({passive:(I.passive||[]).filter((_,i)=>i!==+x.dataset.rmp)}));
  if($("#lbFromBom")) $("#lbFromBom").onclick=()=>{ const bom=d.bom||[], add=bom.filter(x=>/cable/i.test(x.cat||"")&&cables.some(c=>c.name===x.item)).map(x=>({kind:"cable", cable:x.item, ft:+x.qty||0}));
    if(!add.length){ alert("No cable lines in Materials match a cable in the research."); return; } keep({passive:[...(I.passive||[]), ...add]}); };
}
const LB_FORMULA_NOTE="Free space: 20·log10(d m) + 20·log10(f MHz) − 27.55 (ITU-R P.525). P.1238: 20·log10(f) + N·log10(d) + floor loss − 28. Noise: −174 dBm/Hz + 10·log10(bandwidth) + noise figure. ERP = EIRP − 2.15 dB.";

/* ---------- antennas and coverage on the floor plans ---------- */
// wall types: measured series where the research has them (NIST NISTIR 6055, Cardinal low-E), the ITU-R P.2040 model
// where it doesn't. The model alone underrates concrete badly (203 mm at 750 MHz: about 6 dB modelled, 21.5 dB measured).
const DS_WALLS=[  // [label, measured material, measured thickness, P.2040 material, P.2040 thickness cm]
  ["Drywall partition (one layer each side)", null, null, "plasterboard", 2.54], ["Concrete 4 in (102 mm)", "Plain concrete (mix 1)", "102 mm (C14L)", "concrete", 10.2],
  ["Concrete wall or slab 8 in (203 mm)", "Plain concrete (mix 1)", "203 mm (C18L)", "concrete", 20.3], ["Concrete 12 in (305 mm)", "Plain concrete (mix 1)", "305 mm (C112L)", "concrete", 30.5],
  ["Reinforced concrete 8 in (1% steel)", "Reinforced concrete, 1% steel", "203", "concrete", 20.3], ["CMU block wall 8 in", "Masonry block (CMU) wall, 1 block", "203", null, null],
  ["Brick, single wythe", "Brick wall, single wythe", "89", "brick", 8.9], ["Brick veneer on CMU", "Brick veneer on masonry block", "", null, null],
  ["Clear glass 6 mm", "Clear float glass", "6 mm", "glass", 0.6], ["Low-E coated glass", "Cardinal low-e coated glass sample E272", "", null, null],
  ["Wood framing 1.5 in", "Lumber (spruce-pine-fir), dry", "38 mm", "wood", 3.8]];
function dsWallInfo(w, fMHz){
  if(w.db!=null&&w.db!=="") return {db:+w.db, how:"entered"};
  const P=DS_WALLS.find(x=>x[0]===w.label)  // a wall from an older list: the same material at the nearest thickness
    ||DS_WALLS.filter(x=>x[3]&&x[3]===w.mat).sort((a,b)=>Math.abs(a[4]-(+w.cm||0))-Math.abs(b[4]-(+w.cm||0)))[0]||[w.label, null, null, w.mat, w.cm];
  const rs=FR.plans&&!FR.plans.empty?FR.plans:null;
  const model=f=>{ const row=frMaterials(rs||{}).find(x=>String(x.material).toLowerCase()===String(P[3]||"").toLowerCase());  // the current P.2040 edition
    return row?slabLossDb(row, f, (+P[4]||1)/100).db:null; };
  const pts=P[1]?(rs?.measured||[]).filter(m=>m.material===P[1]&&String(m.thickness||"").includes(P[2]||"")&&typeof m.loss_db==="number"&&typeof m.frequency_mhz==="number"&&m.frequency_mhz<=1000)
    .map(m=>[m.frequency_mhz,m.loss_db]).sort((a,b)=>a[0]-b[0]):[];
  if(pts.length){
    const lo=pts[0], hi=pts[pts.length-1];
    if(fMHz>=lo[0]&&fMHz<=hi[0]){ const i=Math.max(1,pts.findIndex(p=>p[0]>=fMHz)), [f0,l0]=pts[i-1], [f1,l1]=pts[i];
      return {db:f1===f0?l0:l0+(l1-l0)*Math.log(fMHz/f0)/Math.log(f1/f0), how:"measured (NIST / maker data)"}; }
    const end=fMHz<lo[0]?lo:hi, m0=model(end[0]), m1=model(fMHz);
    return m0&&m1?{db:end[1]*m1/m0, how:`measured at ${end[0]} MHz, carried to ${fMHz} MHz by the P.2040 trend`}:{db:end[1], how:`measured at ${end[0]} MHz (nearest)`};
  }
  const m=model(fMHz); return m!=null?{db:m, how:"ITU-R P.2040 model"}:{db:0, how:"no data: enter a loss"};
}
const dsWallDb=(w, fMHz)=>dsWallInfo(w, fMHz).db;
function segX(ax,ay,bx,by,cx_,cy,dx,dy){ const d=(bx-ax)*(dy-cy)-(by-ay)*(dx-cx_); if(!d) return false; const t=((cx_-ax)*(dy-cy)-(cy-ay)*(dx-cx_))/d, u=((cx_-ax)*(by-ay)-(cy-ay)*(bx-ax))/d; return t>0&&t<1&&u>0&&u<1; }
// predicted downlink over a floor: the best antenna at each cell, path loss by the chosen model, plus drawn walls crossed
function dsPredict(fl, I, R, wFt, hFt, cols){
  const rows=Math.max(1,Math.round(cols*hFt/wFt)), out=new Float32Array(cols*rows), f=I.f_dl;
  const ants=(fl.antennas||[]).map(a=>({x:a.x*wFt, y:a.y*hFt, eirp:R.bdaOut-(a.feed_db??R.passDl)+(a.gain??(+I.server_gain_dbi||0))}));
  const walls=(fl.walls||[]).map(w=>({x1:w.x1*wFt,y1:w.y1*hFt,x2:w.x2*wFt,y2:w.y2*hFt,db:dsWallDb(w,f)}));
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const x=(c+.5)*wFt/cols, y=(r+.5)*hFt/rows; let best=-Infinity;
    for(const a of ants){ const dM=LB.ft2m(Math.hypot(x-a.x,y-a.y)); let L=a.eirp-(I.model==="fspl"?LB.fspl(dM,f):LB.p1238(dM,f,+I.N||30,0));
      for(const w of walls) if(segX(a.x,a.y,x,y,w.x1,w.y1,w.x2,w.y2)) L-=w.db; if(L>best) best=L; }
    out[r*cols+c]=best; }
  return {cols, rows, out};
}
async function dsFloors(el, j, save){
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], bands=dsBands(d), D=S.das;
  if(!floors.length){ el.innerHTML='<p class="status">Set the number of floors on the Overview first.</p>'; return; }
  if(!bands.length){ el.innerHTML='<p class="status">Pick the systems in the Pre-survey and fill in the Link budget first: coverage uses its antenna power.</p>'; return; }
  D.dsFloor=floors.some(f=>f.name===D.dsFloor)?D.dsFloor:floors[0].name; D.dsBand=bands.some(b=>b.band===D.dsBand)?D.dsBand:bands.slice().sort((a,b)=>b.f_dl-a.f_dl)[0].band; D.dsTool=D.dsTool||"antenna";
  const f=floors.find(x=>x.name===D.dsFloor), b=bands.find(x=>x.band===D.dsBand), I=dsInputs(d,b), R=lbCompute(I);
  const all=(d.design||{}).floors||{}, fl={width_ft:null, antennas:[], walls:[], ...(all[f.name]||{})};
  const keep=async patch=>{ const nf={...all, [f.name]:{...fl, ...patch}}; await save({design:{...(d.design||{}), floors:nf}}); render(); };
  const target=(+I.dl_min_dbm)+(+I.margin_db||0);
  el.innerHTML=`<div class="maptools no-print" style="gap:10px;flex-wrap:wrap">
      <label class="inl">Floor <select id="dfF">${floors.map(x=>`<option ${x.name===f.name?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="inl">Band <select id="dfB">${bands.map(x=>`<option ${x.band===b.band?"selected":""}>${esc(x.band)}</option>`).join("")}</select></label>
      <label class="inl">Plan width <input id="dfW" type="number" step="any" value="${fl.width_ft??""}" placeholder="ft" style="width:80px"> ft</label>
      <div class="seg" id="dfTool">${[["antenna","Place antennas"],["wall","Draw walls"],["erase","Remove"]].map(([k,l])=>`<button data-t="${k}" class="${D.dsTool===k?"on":""}">${l}</button>`).join("")}</div>
      <label class="inl" ${D.dsTool==="wall"?"":'style="display:none"'}>Wall <select id="dfWall">${DS_WALLS.map(([l],i)=>`<option value="${i}" ${+D.dsWall===i?"selected":""}>${esc(l)}</option>`).join("")}</select></label>
      <span class="hint">Antenna EIRP ${R.eirp.toFixed(1)} dBm per channel (Link budget) · pass at ≥ ${target} dBm</span></div>
    ${!f.plan?'<p class="status">This floor has no plan yet: add one under Plans (a PDF page) or pick an image under Grid test.</p>'
      :!fl.width_ft?'<p class="status">Enter the plan\'s real width in feet (from the drawing\'s scale or dimensions) so distances are right.</p>':""}
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(360px,2fr) minmax(240px,1fr)">
      <div class="panel" style="padding:8px"><div id="dfWrap" style="position:relative;width:100%;line-height:0">
        ${f.plan?`<img id="dfImg" src="/api/das/jobs/${j.id}/file?name=${encodeURIComponent(f.plan)}" style="width:100%;display:block;border-radius:8px;background:#fff" alt="Floor ${esc(f.name)} plan">`:'<div style="aspect-ratio:4/3;border-radius:8px;border:1px dashed var(--line)"></div>'}
        <canvas id="dfHeat" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.5;border-radius:8px"></canvas>
        <svg id="dfSvg" style="position:absolute;inset:0;width:100%;height:100%;cursor:crosshair"></svg></div>
        <p class="hint" id="dfHint" style="margin:6px 2px 0"></p></div>
      <div class="panel"><h3>Predicted</h3><div id="dfStats"><p class="hint">Place antennas to see the prediction.</p></div>
        <h3 style="margin-top:12px">Antennas on this floor</h3>${(fl.antennas||[]).map((a,i)=>`<div class="row" style="gap:6px;align-items:center;margin:3px 0"><b>${esc(a.label||`A${i+1}`)}</b>
          <label class="inl">gain <input data-ag="${i}" type="number" step="any" value="${a.gain??""}" placeholder="${I.server_gain_dbi??""}" style="width:60px"></label>
          <label class="inl">feed loss <input data-af="${i}" type="number" step="any" value="${a.feed_db??""}" placeholder="${R.passDl.toFixed(1)}" style="width:66px"> dB</label></div>`).join("")||'<p class="hint">None yet.</p>'}
        <p class="hint">Feed loss defaults to the Link budget's passive network to the farthest antenna; nearer antennas lose less.</p>
        <h3 style="margin-top:12px">Walls on this floor</h3>${(fl.walls||[]).map(w=>{ const wi=dsWallInfo(w, I.f_dl); return `<div style="margin:3px 0">${esc(w.label||w.mat)}: <b>${wi.db.toFixed(1)} dB</b> at ${I.f_dl} MHz <span class="hint">· ${esc(wi.how)}</span></div>`; }).join("")||'<p class="hint">None drawn.</p>'}
        <p class="hint">Measured losses where the research has them (NIST NISTIR 6055 for concrete, block, brick, glass and wood; Cardinal for low-E glass). The P.2040 model alone gives about a third of NIST's measured loss for concrete, so it isn't used where a measurement exists.</p></div></div>`;
  $("#dfF").onchange=e=>{ D.dsFloor=e.target.value; render(); }; $("#dfB").onchange=e=>{ D.dsBand=e.target.value; render(); };
  $("#dfW").onchange=e=>keep({width_ft:+e.target.value||null});
  $("#dfTool").onclick=e=>{ const x=e.target.closest("[data-t]"); if(x){ D.dsTool=x.dataset.t; render(); } };
  if($("#dfWall")) $("#dfWall").onchange=e=>{ D.dsWall=+e.target.value; };
  el.querySelectorAll("[data-ag]").forEach(i=>i.onchange=()=>keep({antennas:fl.antennas.map((a,k)=>k===+i.dataset.ag?{...a, gain:i.value===""?null:+i.value}:a)}));
  el.querySelectorAll("[data-af]").forEach(i=>i.onchange=()=>keep({antennas:fl.antennas.map((a,k)=>k===+i.dataset.af?{...a, feed_db:i.value===""?null:+i.value}:a)}));
  const img=$("#dfImg"), svg=$("#dfSvg"), cv=$("#dfHeat");
  const draw=()=>{
    const W=svg.clientWidth, H=svg.clientHeight; if(!W||!H) return;
    svg.innerHTML=(fl.walls||[]).map(w=>`<line x1="${w.x1*W}" y1="${w.y1*H}" x2="${w.x2*W}" y2="${w.y2*H}" stroke="#e5534b" stroke-width="3" stroke-linecap="round"/>`).join("")
      +(fl.antennas||[]).map((a,i)=>`<g><circle cx="${a.x*W}" cy="${a.y*H}" r="9" fill="#f0a37a" stroke="#2a160c" stroke-width="2"/><text x="${a.x*W+12}" y="${a.y*H+4}" font-size="12" fill="#2a160c" style="paint-order:stroke;stroke:#fff;stroke-width:3px">${esc(a.label||`A${i+1}`)}</text></g>`).join("")
      +(D.dsWallStart?`<circle cx="${D.dsWallStart[0]*W}" cy="${D.dsWallStart[1]*H}" r="5" fill="#e5534b"/>`:"");
    if(!fl.width_ft||!(fl.antennas||[]).length||!img){ cv.width=1; cv.height=1; $("#dfHint").textContent=D.dsTool==="wall"?"Click a wall's start, then its end.":D.dsTool==="erase"?"Click an antenna or a wall to remove it.":"Click to place a server antenna."; return; }
    const wFt=+fl.width_ft, hFt=wFt*(img.naturalHeight/img.naturalWidth||0.75), P=dsPredict(fl, I, R, wFt, hFt, 140);
    cv.width=P.cols; cv.height=P.rows; const cx2=cv.getContext("2d"), id=cx2.createImageData(P.cols,P.rows);
    let ok=0, warn=0;
    for(let k=0;k<P.out.length;k++){ const v=P.out[k], o=k*4, good=v>=target+5, pass=v>=target; if(pass) ok++; if(pass&&!good) warn++;
      const [r,g,b2]=good?[60,207,122]:pass?[250,178,25]:[229,83,75]; id.data[o]=r; id.data[o+1]=g; id.data[o+2]=b2; id.data[o+3]=255; }
    cx2.putImageData(id,0,0); cv.style.imageRendering="pixelated";
    // the grid test's squares, at their centres
    const n=f.grids||DAS.grids, gc=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), gr=Math.ceil(n/gc); let sq=0, sqPass=0; const skip=new Set(f.skip||[]);
    for(let g=1;g<=n;g++){ if(skip.has(g)) continue; const c=(g-1)%gc, r=Math.floor((g-1)/gc), px=Math.min(P.cols-1,Math.floor((c+.5)/gc*P.cols)), py=Math.min(P.rows-1,Math.floor((r+.5)/gr*P.rows)); sq++; if(P.out[py*P.cols+px]>=target) sqPass++; }
    $("#dfStats").innerHTML=`<div class="kvg"><div>Floor area at or above ${target} dBm</div><div><b>${Math.round(ok/P.out.length*100)}%</b> <span class="hint">(${Math.round(warn/P.out.length*100)}% within 5 dB of it)</span></div>
      <div>Grid squares predicted to pass</div><div><b>${sqPass}/${sq}</b> <span class="hint">at their centres</span></div><div>Antennas</div><div>${fl.antennas.length}</div><div>Walls drawn</div><div>${(fl.walls||[]).length}</div></div>
      <p class="hint" style="margin:6px 0 0">Green ≥ ${target+5} dBm, amber within 5 dB of the requirement, red below it. A prediction: the grid test decides.</p>`;
    $("#dfHint").textContent=D.dsTool==="wall"?"Click a wall's start, then its end.":D.dsTool==="erase"?"Click an antenna or a wall to remove it.":"Click to place another antenna.";
  };
  svg.onclick=e=>{ const r=svg.getBoundingClientRect(), x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height;
    if(D.dsTool==="antenna") keep({antennas:[...(fl.antennas||[]), {x, y, label:`A${(fl.antennas||[]).length+1}`}]});
    else if(D.dsTool==="wall"){ if(!D.dsWallStart){ D.dsWallStart=[x,y]; draw(); return; }
      const P=DS_WALLS[+D.dsWall||0], s=D.dsWallStart; D.dsWallStart=null; keep({walls:[...(fl.walls||[]), {x1:s[0],y1:s[1],x2:x,y2:y,label:P[0],mat:P[3],cm:P[4]}]}); }
    else { const W=r.width, H=r.height, near=(fl.antennas||[]).findIndex(a=>Math.hypot((a.x-x)*W,(a.y-y)*H)<14);
      if(near>=0){ keep({antennas:fl.antennas.filter((_,i)=>i!==near)}); return; }
      const wi=(fl.walls||[]).findIndex(w=>{ const ax=w.x1*W, ay=w.y1*H, bx=w.x2*W, by=w.y2*H, px=x*W, py=y*H, L2=(bx-ax)**2+(by-ay)**2, t=L2?Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/L2)):0; return Math.hypot(px-(ax+t*(bx-ax)),py-(ay+t*(by-ay)))<8; });
      if(wi>=0) keep({walls:fl.walls.filter((_,i)=>i!==wi)}); } };
  if(img&&!img.complete) img.onload=draw; else draw();
  new ResizeObserver(draw).observe(svg);
}
// one floor's design as a picture (plan, predicted coverage, walls, antennas), for the submittal packet
async function dsFloorPicture(j, d, f, b){
  const fl=((d.design||{}).floors||{})[f.name]; if(!f.plan||!fl||!fl.width_ft) return null;
  const img=await new Promise(ok=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>ok(null); i.src=`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(f.plan)}`; });
  if(!img) return null;
  const scale=Math.min(1, 1400/img.naturalWidth), W=Math.round(img.naturalWidth*scale), H=Math.round(img.naturalHeight*scale);
  const cv=document.createElement("canvas"); cv.width=W; cv.height=H; const g=cv.getContext("2d");
  g.fillStyle="#fff"; g.fillRect(0,0,W,H); g.drawImage(img,0,0,W,H);
  const I=dsInputs(d,b), R=lbCompute(I), target=(+I.dl_min_dbm)+(+I.margin_db||0); let stats=null;
  if((fl.antennas||[]).length){ const wFt=+fl.width_ft, P=dsPredict(fl, I, R, wFt, wFt*H/W, 140); let ok=0;
    g.globalAlpha=.45; for(let r=0;r<P.rows;r++) for(let c=0;c<P.cols;c++){ const v=P.out[r*P.cols+c]; if(v>=target) ok++;
      g.fillStyle=v>=target+5?"#3ccf7a":v>=target?"#fab219":"#e5534b"; g.fillRect(c*W/P.cols, r*H/P.rows, W/P.cols+1, H/P.rows+1); }
    g.globalAlpha=1; stats={pct:Math.round(ok/P.out.length*100)}; }
  g.strokeStyle="#c62828"; g.lineWidth=3; for(const w of fl.walls||[]){ g.beginPath(); g.moveTo(w.x1*W,w.y1*H); g.lineTo(w.x2*W,w.y2*H); g.stroke(); }
  (fl.antennas||[]).forEach((a,i)=>{ g.fillStyle="#f0a37a"; g.strokeStyle="#2a160c"; g.lineWidth=2; g.beginPath(); g.arc(a.x*W,a.y*H,9,0,2*Math.PI); g.fill(); g.stroke();
    g.font="bold 13px sans-serif"; g.lineWidth=3; g.strokeStyle="#fff"; g.strokeText(a.label||`A${i+1}`, a.x*W+12, a.y*H+4); g.fillStyle="#111"; g.fillText(a.label||`A${i+1}`, a.x*W+12, a.y*H+4); });
  return {src:cv.toDataURL("image/png"), stats, target, antennas:(fl.antennas||[]).length, walls:(fl.walls||[]).length};
}

/* ---------- the design submittal for the AHJ (Report → Design submittal) ---------- */
window.dasSubmittal = async (el, j) => {
  await Promise.all([frLoad("budget"), frLoad("parts"), frLoad("plans")]);
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], bands=dsBands(d), plan=(d.presurvey||{}).plan||[], cs=S.das.contacts;
  const who=k=>cs.find(c=>String(c.id)===String((d.contacts||{})[k])), tech=who("tech");
  const worst=bands.slice().sort((a,b)=>b.f_dl-a.f_dl)[0];
  const pics=worst?await Promise.all(floors.map(f=>dsFloorPicture(j,d,f,worst))):[];
  const P=FR.parts&&!FR.parts.empty?FR.parts:null, sheet=name=>{ if(!P) return null; const row=[...(P.cables||[]),...(P.connectors||[]),...(P.components||[])].find(x=>(x.name||x.type)===name);
    const src=row&&(P._ix||(P._ix=frSrcIndex(P)))[(row.sources||[])[0]]; return src?src.url:null; };
  const bt=dsBatteryTotals(d), T=d.testing||{}, crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])];
  const stageRows=rows=>rows.map(r=>`<tr><td>${esc(r.stage)}</td><td class="n">${r.db==null?"":(r.db>=0?"+":"")+r.db.toFixed(1)}</td><td class="n">${r.level==null||isNaN(r.level)?"–":r.level.toFixed(1)}</td></tr>`).join("");
  el.innerHTML=`<div class="maptools no-print"><div class="seg" id="drView"><button data-rv="test">Test report</button><button data-rv="submittal" class="on">Design submittal</button></div>
      <button class="primary" id="dsPrint">⎙ Print / save as PDF</button><span class="hint">Prints the submittal only. Licensee consent letters print from the Pre-survey.</span></div>
    <div class="panel" id="dasPrint" style="line-height:1.45"><style>#dasPrint td,#dasPrint th{white-space:normal;vertical-align:top}#dasPrint table{width:100%}</style>
      <h2 style="margin:0 0 4px">Emergency responder communication enhancement system: design submittal</h2>
      <p style="margin:0 0 10px">${esc(j.name)} · ${esc(d.address||"")} · ${esc(d.ahj||"AHJ not set")} · ${esc(d.code||"IFC 510 + NFPA 1225")} · ${esc(d.booster_class||"Class A (channelized)")} · prepared ${esc(today())}${tech?` by ${esc([tech.name,tech.org].filter(Boolean).join(", "))}`:""}</p>
      <h3>1. Systems retransmitted</h3>${plan.length?`<table><thead><tr><th>Agency</th><th>Call sign</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Type</th></tr></thead><tbody>${plan.map(p=>`<tr><td>${esc(p.system)}</td><td class="mono">${esc(p.call_sign)}</td><td class="mono">${esc(p.downlink_mhz)}</td><td class="mono">${esc(p.uplink_mhz)}</td><td>${esc(p.technology)}</td></tr>`).join("")}</tbody></table>`:'<p>None chosen in the pre-survey.</p>'}
      <h3>2. Link budget</h3>${bands.map(b=>{ const I=dsInputs(d,b), R=lbCompute(I); return `<div style="break-inside:avoid;margin-bottom:10px"><h4 style="margin:6px 0">${esc(b.band)} · ${b.n_ch} channel${b.n_ch===1?"":"s"}, worst case ${b.f_dl} MHz down / ${b.f_ul} MHz up</h4>
        <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${R.checks.map(c=>`<tr><td>${esc(c.name)}</td><td><b>${c.ok==null?"open":c.ok==="warn"?"warn":c.ok?"pass":"FAIL"}</b></td><td>${esc(c.detail)}</td></tr>`).join("")}</tbody></table>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px"><table><thead><tr><th>Downlink</th><th class="n">dB</th><th class="n">dBm</th></tr></thead><tbody>${stageRows(R.dl)}</tbody></table>
          <table><thead><tr><th>Uplink</th><th class="n">dB</th><th class="n">dBm</th></tr></thead><tbody>${stageRows(R.ul)}</tbody></table></div></div>`; }).join("")||"<p>No link budget yet.</p>"}
      <p class="hint">${LB_FORMULA_NOTE}</p>
      <h3 style="break-before:page">3. Floor designs${worst?` (${esc(worst.band)}, the highest band)`:""}</h3>
      ${floors.map((f,i)=>{ const p=pics[i]; return `<div style="break-inside:avoid;margin-bottom:12px"><h4 style="margin:6px 0">Floor ${esc(f.name)}${p?.stats?`: ${p.stats.pct}% of the floor predicted at or above ${p.target} dBm`:""}</h4>
        ${p?`<img src="${p.src}" style="width:100%;max-width:720px;border:1px solid #999"><p class="hint" style="margin:2px 0">${p.antennas} server antenna${p.antennas===1?"":"s"}, ${p.walls} wall${p.walls===1?"":"s"} drawn. Green ≥ ${p.target+5} dBm, amber within 5 dB of the requirement, red below it. Predicted, not measured.</p>`:'<p class="hint">No design for this floor yet.</p>'}</div>`; }).join("")}
      <h3 style="break-before:page">4. Bill of materials</h3>${(d.bom||[]).length?`<table><thead><tr><th>Item</th><th>Part number</th><th>Supplier</th><th class="n">Qty</th><th>Datasheet</th></tr></thead><tbody>${d.bom.map(x=>{ const u=sheet(x.item); return `<tr><td>${esc(x.item)}</td><td class="mono">${esc(x.part||"")}</td><td>${esc(x.supplier||"")}</td><td class="n">${esc(x.qty??"")} ${esc(x.unit||"")}</td><td>${u?`<a href="${esc(u)}">${esc(u.replace(/^https?:\/\//,"").slice(0,50))}</a>`:""}</td></tr>`; }).join("")}</tbody></table>`:"<p>No materials listed yet.</p>"}
      <h3>5. Standby power</h3>${bt.B.items.length?`<table><thead><tr><th>Equipment</th><th class="n">Qty</th><th class="n">Amps</th></tr></thead><tbody>${bt.B.items.map(x=>`<tr><td>${esc(x.name)}</td><td class="n">${esc(x.qty??1)}</td><td class="n">${((+x.qty||1)*((+x.amps||0)||((+x.watts||0)/(+bt.B.volts||1)))).toFixed(2)}</td></tr>`).join("")}</tbody></table>
        <p>Full load ${bt.load.toFixed(2)} A at ${bt.B.volts} V for ${bt.B.hours} h with ${bt.B.margin_pct}% margin: <b>${bt.ah.toFixed(1)} Ah</b> (NFPA 1225 18.13.2: 12 h at 100% operation; battery in a NEMA 3R or better cabinet).</p>`:"<p>No battery calculation yet.</p>"}
      <h3>6. Material rules</h3>${P?`<table><thead><tr><th>Rule</th><th>Code</th><th>Met</th></tr></thead><tbody>${(P.das||[]).map(x=>`<tr><td>${esc(x.topic)}: ${esc(x.requirement||"")}</td><td>${esc(x.code||"")}</td><td>${(d.material_checks||{})[`${x.topic}|${x.requirement}`]?"yes":"–"}</td></tr>`).join("")}</tbody></table>`:""}
      <h3>7. Acceptance test plan</h3><p>Each floor in ${DAS.grids} grid squares (floors over ${DAS.sector_sqft.toLocaleString()} sq ft in sectors), tested at the centre of each square: ≥ ${DASJ.threshold} dBm downlink and uplink with DAQ ≥ ${DASJ.daq} both ways (or SINR ≥ ${daqEq().sinr} dB with BER ≤ ${daqEq().ber}%); ${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas on each floor.
        ${crit.length?`Critical areas: ${crit.map(esc).join(", ")}.`:""} Donor-to-server isolation and oscillation checked at installation and each annual retest; all gains recorded.</p>
      <table><thead><tr><th>Floor</th><th class="n">Squares to test</th></tr></thead><tbody>${floors.map(f=>`<tr><td>${esc(f.name)}</td><td class="n">${(f.grids||DAS.grids)-(f.skip||[]).length}</td></tr>`).join("")}</tbody></table>
      <h3>8. Licensee consent (47 CFR 90.219(b)(1))</h3><p>${[...new Set(plan.map(p=>p.system))].map(esc).join("; ")||"–"}: written consent requested from each licensee before activation (NFPA 1225 18.7.2).</p>
      <h3>9. Sign-off</h3><p>Designer: ______________________ FCC GROL / certification: ${esc(T.grol||"__________")} Date: ________</p><p>AHJ review: ______________________ Date: ________</p>
    </div>`;
  $("#drView").onclick=e=>{ const b=e.target.closest("[data-rv]"); if(b){ S.das.rview=b.dataset.rv; render(); } };
  $("#dsPrint").onclick=()=>{ document.body.classList.add("print-das"); window.print(); setTimeout(()=>document.body.classList.remove("print-das"),500); };
};

/* ---------- battery (NFPA 1225 18.13.2: 12 h at 100% operation; many AHJs ask 24 h) ---------- */
async function dsBattery(el, j, save){
  const d=j.data||{}, B={volts:24, hours:12, margin_pct:20, items:[], ...((d.design||{}).battery||{})};
  const keep=async patch=>{ await save({design:{...(d.design||{}), battery:{...B, ...patch}}}); render(); };
  const amps=x=>(+x.amps||0)||((+x.watts||0)/(+B.volts||1));
  const load=B.items.reduce((a,x)=>a+(+x.qty||1)*amps(x),0), ah=load*(+B.hours||0)*(1+(+B.margin_pct||0)/100);
  el.innerHTML=`<div class="grid2" style="margin-top:0"><div class="panel"><h3>Battery sizing</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end"><label>System voltage<input id="btV" type="number" step="any" value="${B.volts}" style="width:90px"></label>
        <label>Hours at full load<input id="btH" type="number" step="any" value="${B.hours}" style="width:90px"></label><label>Safety margin %<input id="btM" type="number" step="any" value="${B.margin_pct}" style="width:90px"></label></div>
      <div class="tw" style="margin-top:8px"><table><thead><tr><th>Equipment</th><th class="n">Qty</th><th class="n">Amps each</th><th class="n">or watts</th><th class="n">Amps</th><th></th></tr></thead><tbody>
        ${B.items.map((x,i)=>`<tr><td>${esc(x.name)}</td><td class="n">${esc(x.qty??1)}</td><td class="n">${esc(x.amps??"")}</td><td class="n">${esc(x.watts??"")}</td><td class="n">${((+x.qty||1)*amps(x)).toFixed(2)}</td><td><button data-rmb="${i}">✕</button></td></tr>`).join("")
          ||'<tr><td colspan="6" class="hint">Add the BDA, fiber remotes, the annunciator and anything else on the battery (from each datasheet\'s full-load current).</td></tr>'}</tbody></table></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end;margin-top:6px"><label class="grow">Equipment<input id="btN" placeholder="BDA (model)"></label><label>Qty<input id="btQ" type="number" value="1" style="width:60px"></label>
        <label>Amps<input id="btA" type="number" step="any" style="width:80px"></label><label>or watts<input id="btW" type="number" step="any" style="width:80px"></label><button class="primary" id="btAdd">Add</button></div></div>
    <div class="panel"><h3>Needed</h3><div class="kvg"><div>Full load</div><div>${load.toFixed(2)} A at ${B.volts} V (${(load*B.volts).toFixed(0)} W)</div>
      <div>For ${B.hours} h</div><div>${(load*B.hours).toFixed(1)} Ah</div><div>With ${B.margin_pct}% margin</div><div><b style="font-size:20px">${ah.toFixed(1)} Ah</b> at ${B.volts} V</div></div>
      <p class="hint" style="margin-top:8px">NFPA 1225 18.13.2: a dedicated battery for 12 hours at 100% system operation (or 2 hours plus a generator, IFC 2021 510.4.2.3), in a NEMA 3R or better cabinet; some jurisdictions ask 24 hours.
        The 20% margin is the fire alarm rule (NFPA 72, 10.6.7.2.1.1 in the 2019 edition) that ERCES work commonly follows; NFPA 1225 doesn't state one, so confirm with the AHJ.
        <a href="https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download" target="_blank" rel="noopener">NFPA 1225 ch. 18</a> ·
        <a href="https://www.firealarmguy.net/resources/downloads/FA_Battery_Calculation_Guide.pdf" target="_blank" rel="noopener">battery calculation guide (NFPA 72-2019 sections)</a> ·
        <a href="https://www.ecmag.com/magazine/articles/article-detail/integrated-systems-calculation-crunching-fire-alarm-math-you-should-know" target="_blank" rel="noopener">EC Magazine</a> ·
        <a href="https://www.resolutionwireless.com/bda-and-das-installation-code-changes/" target="_blank" rel="noopener">local 24 h amendments</a></p></div></div>`;
  ["#btV","#btH","#btM"].forEach((s,k)=>$(s).onchange=e=>keep({[["volts","hours","margin_pct"][k]]:+e.target.value}));
  $("#btAdd").onclick=()=>{ if(!$("#btN").value.trim()) return; keep({items:[...B.items, {name:$("#btN").value.trim(), qty:+$("#btQ").value||1, amps:$("#btA").value===""?null:+$("#btA").value, watts:$("#btW").value===""?null:+$("#btW").value}]}); };
  el.querySelectorAll("[data-rmb]").forEach(x=>x.onclick=()=>keep({items:B.items.filter((_,i)=>i!==+x.dataset.rmb)}));
}
function dsBatteryTotals(d){ const B={volts:24, hours:12, margin_pct:20, items:[], ...((d.design||{}).battery||{})}, amps=x=>(+x.amps||0)||((+x.watts||0)/(+B.volts||1));
  const load=B.items.reduce((a,x)=>a+(+x.qty||1)*amps(x),0); return {B, load, ah:load*(+B.hours||0)*(1+(+B.margin_pct||0)/100)}; }
