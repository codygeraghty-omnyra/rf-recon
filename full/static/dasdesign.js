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
// With no signal at the roof the whole downlink is unknown: its levels show "–" and every check built on them is open,
// never a pass. (11/3: a blank roof level was read as 0 dBm and the far edge "passed" at -87 dBm.)
const LB_DL_CHECKS = new Set(["dl_edge", "consumer_dl", "headroom", "dl_erp"]);
function lbCompute(I){
  const R=lbCompute0(I), roof=I.roof_dbm;
  if(!(roof===""||roof==null||isNaN(+roof))) return R;
  for(const s of R.dl) s.level=null;
  for(const c of R.checks) if(LB_DL_CHECKS.has(c.id)){ c.ok=null; c.detail=`needs the ${I.cell?"RSRP":"signal"} at the roof (Inputs, Donor)`; }
  return {...R, edge:null, roofMissing:true};
}
function lbCompute0(I){
  const n=v=>(v===""||v==null||isNaN(+v))?null:+v, num0=v=>n(v)??0;
  const conn=num0(I.connector_db), pass_dl=lbPassive(I.passive, I.f_dl, conn), pass_ul=lbPassive(I.passive, I.f_ul||I.f_dl, conn);
  const donorDl=lbPassive(I.donor_cable?[I.donor_cable]:[], I.f_dl, 0).db+num0(I.donor_connectors)*conn;
  const donorUl=lbPassive(I.donor_cable?[I.donor_cable]:[], I.f_ul||I.f_dl, 0).db+num0(I.donor_connectors)*conn;
  const passDl=pass_dl.db+num0(I.connectors)*conn, passUl=pass_ul.db+num0(I.connectors)*conn;
  const dM=LB.ft2m(num0(I.edge_ft)), walls=num0(I.walls_db);
  const pl=f=>I.model==="fspl"?LB.fspl(dM,f):LB.p1238(dM,f,num0(I.N)||30,num0(I.floor_loss));
  const nch=Math.max(1,num0(I.n_ch)||1);
  // an LTE / 5G band runs the downlink in RSRP (one subcarrier): gains and losses are the same, and the BDA's composite
  // output cap comes down by 10·log10(subcarriers in the channel)
  const nsc=I.cell?cellSubcarriers((n(I.bw_khz)??20000)/1000, n(I.scs_khz)??15):1, re=I.cell?10*Math.log10(nsc):0;
  // downlink
  const dl=[], push=(arr,stage,db,level,note="")=>arr.push({stage,db,level,note});
  let L=n(I.roof_dbm);
  push(dl,I.cell?"RSRP at the roof (isotropic)":"Signal at the roof (isotropic)",null,L,I.roof_src||"");
  L=L+num0(I.donor_gain_dbi); push(dl,"Donor antenna gain",num0(I.donor_gain_dbi),L);
  L=L-donorDl; push(dl,"Donor cable and connectors",-donorDl,L);
  const bdaIn=L, perCh=n(I.bda_max_dbm)!=null?n(I.bda_max_dbm)-10*Math.log10(nch)-num0(I.backoff_db)-re:null, want=bdaIn+num0(I.bda_dl_gain_db);
  const bdaOut=perCh!=null?Math.min(want,perCh):want;
  push(dl,`BDA downlink gain${perCh!=null&&want>perCh?" (output limited)":""}`,num0(I.bda_dl_gain_db),bdaOut,perCh!=null?(I.cell
    ?`${nch} carrier${nch===1?"":"s"}: at most ${perCh.toFixed(1)} dBm per subcarrier (${(perCh+re).toFixed(1)} dBm per carrier less 10·log10(${nsc}) = ${re.toFixed(1)} dB)`
    :`${nch} channel${nch===1?"":"s"}: at most ${perCh.toFixed(1)} dBm each`):"");
  L=bdaOut-passDl; push(dl,"Passive network to the farthest antenna",-passDl,L,pass_dl.rows.map(r=>`${r.name} ${r.db.toFixed(1)}`).join(" · "));
  const eirp=L+num0(I.server_gain_dbi); push(dl,"Server antenna gain (EIRP)",num0(I.server_gain_dbi),eirp);
  const plDl=pl(I.f_dl); L=eirp-plDl; push(dl,`In-building path, ${num0(I.edge_ft)} ft (${I.model==="fspl"?"free space":"ITU-R P.1238"})`,-plDl,L);
  L=L-walls; push(dl,"Walls and floors in the way",-walls,L);
  const edge=L;
  // uplink
  const ul=[]; const fu=I.f_ul||I.f_dl;
  let U=num0(I.portable_dbm); push(ul,I.cell?"Phone power":"Portable radio power",null,U,I.portable_src||"");
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
  if(I.cell){  // LTE / 5G: the cellular target, the 20.21 consumer caps for scale, isolation and headroom; no agency-site or 90.219 checks
    chk("dl_edge","RSRP at the far edge",edge>=dlNeed,`${edge.toFixed(1)} dBm vs ${dlNeed.toFixed(1)} dBm needed (${num0(I.dl_min_dbm)} target + ${num0(I.margin_db)} dB margin; Requirements, Cellular)`);
    const dlComp=bdaOut+re+10*Math.log10(nch);
    chk("consumer_dl","Downlink under the consumer booster cap (47 CFR 20.21)",dlComp<=17?true:"warn",`${dlComp.toFixed(1)} dBm composite vs 17 dBm (0.05 W)${dlComp>17?": over it, so an industrial booster with each carrier's express consent (20.21(c))":""}`);
    chk("consumer_ul","Uplink under the consumer booster cap (47 CFR 20.21)",ulOut<=30?true:"warn",`${ulOut.toFixed(1)} dBm vs 30 dBm (1 W)${ulOut>30?": over it, so an industrial booster with each carrier's express consent":""}`);
    const isoGain=Math.max(num0(I.bda_dl_gain_db),g), isoMargin=n(I.isolation_margin_db)??20, isoNeed=isoGain+isoMargin, iso=n(I.isolation_db);
    chk("isolation","Donor to server isolation",iso==null?null:iso>=isoNeed?true:iso>=isoGain+Math.min(15,isoMargin)?"warn":false,iso!=null?`${iso} dB vs ${isoNeed} dB needed (gain + ${isoMargin})`:`needs a measured or estimated isolation: at least ${isoNeed} dB`);
    if(perCh!=null) chk("headroom","BDA output headroom",want<=perCh,want<=perCh?`${(perCh-want).toFixed(1)} dB under the maximum`:`${(want-perCh).toFixed(1)} dB over the maximum: the BDA is limiting; lower its gain`);
    return {dl, ul, checks:C, edge, eirp, bdaOut, perCh, atSite, erpUl, noiseErp10k, noiseSite10k, rise, passDl, passUl, plSiteDl, dlErp:bdaOut-donorDl, nsc};
  }
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
  if(perCh!=null) chk("headroom","BDA output headroom",want<=perCh,want<=perCh?`${(perCh-want).toFixed(1)} dB under the per-channel maximum`:`${(want-perCh).toFixed(1)} dB over the per-channel maximum (${perCh.toFixed(1)} dBm): the BDA is limiting; lower its gain`);
  return {dl, ul, checks:C, edge, eirp, bdaOut, perCh, atSite, erpUl, noiseErp10k, noiseSite10k, rise, passDl, passUl, plSiteDl, dlErp};
}

/* ---------- AHJ and licensee caps, as presets for the link budget's check fields (read 2026-11-04 in each document) ----------
   Each value fills its field with the document's own figure and section; a value the document doesn't state is left out.
   Sacramento's idle uplink gain depends on the distance to the donor site (FPS 32 9.b's table). */
const DS_CAPS = {
  douglas: {name:"Douglas County CO (DCSORS ERCES policy rev 2.0)", src:"https://dcsheriff.net/documents/derces-implementation-guidelines.pdf/",
    v:{ul_gain_max_db:[65, "BDA UL: operating gain ≤ +65 dB without DCSORS approval"], donor_port_max_dbm:[27, "BDA UL: ≤ +27 dBm at the BDA donor port"],
      erp_limit_dbm:[37, "BDA UL: ≤ +37 dBm ERP"], noise_site_max_dbm:[-145, "BDA UL: calculated noise in 10 kHz at the donor site ≤ −145 dBm"],
      ul_min_dbm:[-100, "BDA UL: per-channel level at the donor site −100 to −80 dBm"], ul_max_dbm:[-80, "BDA UL: per-channel level at the donor site −100 to −80 dBm"],
      noise_limit_dbm:[-43, "BDA UL: noise ERP ≤ −43 dBm in 10 kHz (90.219(d)(6))"], isolation_margin_db:[20, "Acceptance: isolation 20 dB or more over the BDA's maximum gain"]},
    notes:["Oscillation: auto-reset for the first three events in 24 h, disabled on the 4th."]},
  sacramento: {name:"Sacramento Metro Fire FPS 32 (effective 07/10/2025)", src:"https://metrofire.ca.gov/files/09cf2a87a/FPS+32+-+Installation+of+Emergency+Responder+Radio+Coverage+Systems.pdf",
    v:{noise_site_max_dbm:[-150, "21: calculated noise at the donor site no greater than −150 dBm"], noise_limit_dbm:[-43, "21: noise in 10 kHz at the donor antenna ≤ −43 dBm ERP"],
      isolation_margin_db:[20, "Design 3.a: isolation 20 dB greater than the amplifier's maximum rated gain (> 100 dB desired)"]},
    // 9.b: total uplink gain ≤ 75 dB without approval; idle uplink gain by distance to the donor site (donor antenna gain counts in it)
    table:[[8, Infinity, 81, -44], [4, 8, 75, -50], [2, 4, 69, -56], [1, 2, 63, -62], [0.5, 1, 57, -68], [0.25, 0.5, 51, -74]],
    notes:["9.b: total uplink gain ≤ 75 dB without prior approval; the idle uplink gain row comes from the distance to the donor site, and the donor antenna's gain counts in it.", "22: time delay ≤ 25 µs total."]},
  la: {name:"LA County Fire V7-C3-S21 (02/02/2023)", src:"https://sbc.memberclicks.net/assets/Useful_Links/2023/v7-c3-s21.pdf",
    v:{ul_gain_max_db:[65, "15: uplink gain ≤ 65 dB unless approved in writing"], noise_site_max_dbm:[-150, "13: ≤ −150 dBm uplink noise at the donor site"],
      noise_limit_dbm:[-43, "13: ≤ −43 dBm ERP uplink noise in the passband"], isolation_margin_db:[20, "14: isolation ≥ 20 dB over the maximum system gain"]},
    notes:["Propagation delay ≤ 15 µs.", "Exterior downlink at the perimeter ≥ 20 dB below the donor system's signal.", "−70 dBm ERP uplink noise 1 MHz outside the passband."]},
  sd: {name:"San Diego FD C-1 (2025)", src:"https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf",
    v:{ul_gain_max_db:[65, "Uplink gain ≤ 65 dB unless approved (the uplink budget shows gain set to 65 dB maximum)"], noise_site_max_dbm:[-150, "8: ≤ −150 dBm uplink noise at the donor site"],
      noise_limit_dbm:[-43, "8: ≤ −43 dBm ERP uplink noise"], isolation_margin_db:[20, "Isolation ≥ 20 dB above the system gain"]},
    notes:["RF leakage ≥ 15 dB below the measured donor signal at ground level, 3-25 ft from the building."]},
};
// the distance to the donor site, mi: typed in the budget, else the nearest Terrain-paths site from the Pre-survey
function dsDonorMi(d, I){
  if(I&&I.site_dist_mi!=null&&I.site_dist_mi!==""&&!isNaN(+I.site_dist_mi)) return +I.site_dist_mi;
  const t=Object.values((d.presurvey||{}).terrain||{}).filter(x=>x&&!x.error&&x.site&&d.lat!=null);
  const mi=t.map(x=>{ const [la,lo]=x.site.split(",").map(Number); return geoMi(d.lat, d.lon, la, lo); }).filter(isFinite);
  return mi.length?Math.min(...mi):null;
}
const geoMi = (a, b, c, e) => { const r=x=>x*Math.PI/180, h=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(e-b)/2)**2; return 3958.8*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); };
// a preset's values for this job and band: {field: [value, why]}, plus a note when Sacramento's table has no row
function dsCapValues(d, I){
  const id=(d.design||{}).caps, P=DS_CAPS[id]; if(!P||(I&&I.cell)) return {v:{}, P:null};
  const v={...P.v}; let note="";
  if(P.table){ const mi=dsDonorMi(d, I), row=mi==null?null:P.table.find(([lo,hi])=>mi>=lo&&mi<hi);
    if(row){ v.ul_gain_max_db=[Math.min(75,row[2]), `9.b table: ${mi.toFixed(2)} mi to the donor site → idle uplink gain ≤ ${row[2]} dB, NP ERP ${row[3]} dBm (total ≤ 75 dB)`]; }
    else note=mi==null?"9.b: the uplink gain cap needs the distance to the donor site (Uplink and site, or Terrain paths on the Pre-survey)."
      :`9.b: ${mi.toFixed(2)} mi is under the table's 0.25 mi row: the gain needs Metro Fire's engineering review.`; }
  return {v, P, note};
}
// where a cap field's value came from, when a preset filled it
function dsCapNote(d, k){ const c=dsCapValues(d, null); return c.v[k]?`${c.P.name}: ${c.v[k][1]}`:""; }

/* ---------- the Design sub-tab: link budget · antennas & coverage · battery ---------- */
const DS_VIEWS=[["budget","Link budget"],["floors","Antennas and coverage"],["battery","Battery"],["sub","Submittal details"]];
function dsBands(d){
  const plan=(d.presurvey||{}).plan||[], m=new Map();
  for(const p of plan){ const b=p.band||dasBand(+p.downlink_mhz); const x=m.get(b)||{band:b, dl:[], ul:[], best:null, systems:new Set()};
    x.dl.push(+p.downlink_mhz); String(p.uplink_mhz||"").split(" ").filter(Boolean).forEach(u=>x.ul.push(+u));
    if(p.best_outdoor_dbm!==""&&p.best_outdoor_dbm!=null) x.best=Math.max(x.best??-999,+p.best_outdoor_dbm); x.systems.add(p.system); m.set(b,x); }
  return [...m.values()].map(x=>({...x, f_dl:Math.max(...x.dl), f_ul:x.ul.length?Math.max(...x.ul):Math.max(...x.dl), n_ch:new Set(x.dl).size, systems:[...x.systems]}))
    .concat(((d.design||{}).cell_bands||[]).map(id=>window.cellBandEntry?cellBandEntry(d, id):null).filter(Boolean));  // LTE / 5G bands (dascell.js)
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
  // an LTE / 5G band: a phone, not a portable radio; the job's cellular RSRP target; no 90.219 or agency-site checks
  if(b.cell) Object.assign(def, {cell:true, portable_dbm:23, portable_src:"a phone at full power: LTE / NR power class 3, 23 dBm (3GPP, background)", body_db:3,
    dl_min_dbm:b.target, margin_db:0, bw_khz:b.bw_mhz*1000, scs_khz:b.scs, site_sens_dbm:null, ul_min_dbm:null, ul_max_dbm:null, erp_limit_dbm:null, noise_limit_dbm:null,
    noise_site_max_dbm:null, ul_gain_max_db:null, donor_port_max_dbm:null, roof_src:"the rooftop donor reading (Pre-survey) or a scan: enter it"});
  const cap=dsCapValues(d, {...def, ...saved, cell:!!b.cell}); for(const [k,[v]] of Object.entries(cap.v)) def[k]=v;  // the AHJ / licensee preset (DS_CAPS)
  return {...def, ...saved, cell:!!b.cell, band:b.band};
}

window.dasDesign = async (el, j, save) => {
  await Promise.all([frLoad("budget"), frLoad("parts"), frLoad("plans")]);
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const D=S.das; D.dview=D.dview||"budget";
  el.innerHTML=`<div class="seg no-print" id="dsSeg" style="margin-bottom:10px">${DS_VIEWS.map(([k,l])=>`<button data-v="${k}" class="${D.dview===k?"on":""}">${l}</button>`).join("")}</div><div id="dsBody"></div><div id="dsIm" style="margin-top:10px"></div>`;
  $("#dsSeg").onclick=e=>{ const b=e.target.closest("[data-v]"); if(b){ D.dview=b.dataset.v; render(); } };
  ({budget:dsBudget, floors:dsFloors, battery:dsBattery, sub:dsSubDetails}[D.dview]||dsBudget)($("#dsBody"), j, save);
  if(D.dview==="budget") window.dasIntermod?.($("#dsIm"), j, save, "design");  // intermod frequencies to watch (dasx.js)
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
  ["erp_limit_dbm","ERP per channel, at most","dBm","Checks"],["noise_limit_dbm","Uplink noise ERP, at most (per 10 kHz)","dBm","Checks"],
  ["scs_khz","Subcarrier spacing (LTE 15, 5G mid-band 30)","kHz","Uplink and site"]];
// fields that mean nothing for one kind of band: the agency site and 90.219 limits for LTE / 5G, subcarriers for LMR
const LB_ONLY_LMR=new Set(["site_sens_dbm","site_nf_db","site_erp_dbm","ul_min_dbm","ul_max_dbm","ul_gain_max_db","donor_port_max_dbm","noise_site_max_dbm","erp_limit_dbm","noise_limit_dbm"]);
const lbFieldsFor = cell => LB_FIELDS.filter(([k])=>cell?!LB_ONLY_LMR.has(k):k!=="scs_khz");
// where a default came from, with its citations
const lbSrcNote = p => p.cite?`${esc(p.src)} ${frCite(FR.budget,p.cite)}`:esc(p.src||"");
async function dsBudget(el, j, save){
  const d=j.data||{}, bands=dsBands(d);
  // LTE / 5G bands for a commercial DAS, added by hand (dascell.js DAS_LTE_BANDS, from the DAS-Cellular research)
  const haveCell=new Set((d.design||{}).cell_bands||[]), cellAdd=window.cellBandEntry?`<label class="inl" title="A commercial cellular band: its link budget runs in RSRP against the job's cellular target (Requirements)">Add an LTE / 5G band
    <select id="lbAddCell"><option value="">—</option>${DAS_LTE_BANDS.filter(x=>!haveCell.has(x.id)).map(x=>`<option value="${esc(x.id)}">${esc(x.label)} · ${esc(x.carriers)}</option>`).join("")}</select></label>`:"";
  const setCell=async ids=>{ j=await save({design:{...(j.data.design||{}), cell_bands:ids}}); render(); };
  const wireAdd=()=>$("#lbAddCell")?.addEventListener("change", e=>{ if(e.target.value){ S.das.lbBand=null; setCell([...haveCell, e.target.value]); } });
  if(!bands.length){ el.innerHTML=`<p class="status">Pick the systems in the Pre-survey first: the link budget works per band from their channels. Or add an LTE / 5G band for a commercial DAS.</p><div class="maptools">${cellAdd}</div>`; wireAdd(); return; }
  const D=S.das; D.lbBand=bands.some(b=>b.band===D.lbBand)?D.lbBand:bands[0].band;
  const b=bands.find(x=>x.band===D.lbBand), I=dsInputs(d,b), R=lbCompute(I), cables=(FR.parts?.cables||[]).filter(c=>c.loss_db_100ft);
  const keep=async patch=>{ const all={...((d.design||{}).bands||{})}, x={...(all[b.band]||{}), ...patch};
    for(const k in patch) if(patch[k]===null) delete x[k];  // a cleared field goes back to its default
    all[b.band]=x; await save({design:{...(d.design||{}), bands:all}}); render(); };
  const Dflt=lbDefaults(b.band), mine=((d.design||{}).bands||{})[b.band]||{};
  // an LTE / 5G band names its inputs for a phone and RSRP, and says where its own defaults came from
  const CELL_LABEL={roof_dbm:"RSRP at the roof (isotropic)", portable_dbm:"Phone power", body_db:"Head and hand loss", dl_min_dbm:"RSRP needed", n_ch:"Carriers sharing the BDA in this band", bw_khz:"Channel bandwidth"};
  const CELL_NOTE={portable_dbm:"a phone at full power: power class 3, 23 dBm (3GPP, background)", body_db:"a 3 dB placeholder (background): set it",
    dl_min_dbm:"this job's cellular RSRP target (Requirements, Cellular)", margin_db:"no researched cellular margin: set yours", bw_khz:"the band's usual channel width",
    scs_khz:"LTE 15 kHz; 5G mid-band 30 kHz", roof_dbm:"the rooftop donor reading (Pre-survey) or a scan"};
  const capV=dsCapValues(d, I);
  const field=([k,l,u])=>{ const v=I[k], note=b.cell&&CELL_NOTE[k]?esc(CELL_NOTE[k]):capV.v[k]?`${esc(capV.P.name)}: ${esc(capV.v[k][1])} ${dsSrcLink(capV.P.src, "source")}`:Dflt[k]?lbSrcNote(Dflt[k]):"";
    return `<label style="display:block;margin:4px 0"><span class="hint">${esc(b.cell&&CELL_LABEL[k]||l)}${u?` (${u})`:""}</span>
    <input data-lb="${k}" type="number" step="any" value="${v??""}" style="width:100%">${note&&mine[k]==null?`<span class="hint" style="font-size:11px">default: ${note}</span>`:""}</label>`; };
  const FIELDS=lbFieldsFor(!!b.cell), groups=[...new Set(FIELDS.map(f=>f[3]))];
  const stageTable=rows=>`<div class="tw"><table><thead><tr><th>Stage</th><th class="n">dB</th><th class="n">Level dBm</th><th>Note</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.stage)}</td><td class="n">${r.db==null?"":(r.db>=0?"+":"")+r.db.toFixed(1)}</td><td class="n"><b>${r.level==null||isNaN(r.level)?"–":r.level.toFixed(1)}</b></td><td class="hint">${esc(r.note||"")}</td></tr>`).join("")}</tbody></table></div>`;  /* scrolls inside its panel on a phone (11/3: 835 px page) */
  el.innerHTML=`<div class="maptools no-print" style="gap:10px;flex-wrap:wrap"><div class="seg" id="lbBand">${bands.map(x=>`<button data-b="${esc(x.band)}" class="${x.band===b.band?"on":""}">${esc(x.band)}</button>`).join("")}</div>
      ${cellAdd}${b.cell?"":`<label class="inl" title="Fill the check fields with an AHJ's or licensee's own caps, each with its section">AHJ / licensee caps <select id="lbCaps"><option value="">None: code defaults</option>${Object.entries(DS_CAPS).map(([k,x])=>`<option value="${k}" ${(d.design||{}).caps===k?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>`}${b.cell?`<button id="lbRmCell" title="Take this LTE / 5G band out of the job's link budget">Remove this band</button>`:""}
      <span class="hint">${b.cell?`${esc(b.systems.join(", "))} · ${I.bw_khz/1000} MHz at ${I.scs_khz} kHz = ${cellSubcarriers(I.bw_khz/1000, +I.scs_khz)} subcarriers · worst case at ${b.f_dl} MHz down, ${b.f_ul} MHz up · RSRP target ${I.dl_min_dbm} dBm`
        :`${b.n_ch} downlink channel${b.n_ch===1?"":"s"} · worst case at ${b.f_dl} MHz down, ${b.f_ul} MHz up · ${esc(b.systems.join(", "))}`}</span></div>
    <div class="cards" style="margin:0 0 10px">${R.checks.map(c=>`<div class="card" title="${esc(c.detail)}"><div class="v" style="color:${c.ok==null?"var(--muted)":c.ok==="warn"?"var(--warn)":c.ok?"var(--good)":"var(--bad)"}">${c.ok==null?"–":c.ok==="warn"?"Warn":c.ok?"Pass":"Fail"}</div><div class="k">${esc(c.name)}<br><span class="hint">${esc(c.detail)}</span></div></div>`).join("")}</div>
    ${capV.P?`<p class="hint" id="lbCapNote" style="margin:-4px 2px 10px"><b>${esc(capV.P.name)}</b> fills ${Object.keys(capV.v).length} check field${Object.keys(capV.v).length===1?"":"s"} (a value you type wins). ${[capV.note, ...(capV.P.notes||[])].filter(Boolean).map(esc).join(" ")} ${dsSrcLink(capV.P.src, "Source")}</p>`:""}
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(300px,1fr) minmax(360px,1.4fr)">
      <div class="panel"><h3>Inputs <span class="hint">· saved with the job; clear a field for its default</span></h3>
        ${groups.map(g=>`<details ${["Donor","Booster","Building"].includes(g)?"open":""}><summary style="cursor:pointer"><b>${esc(g)}</b></summary>${FIELDS.filter(f=>f[3]===g).map(field).join("")}
          ${g==="Donor"?`<label style="display:block;margin:4px 0"><span class="hint">Donor cable</span><div class="row" style="gap:6px"><select id="lbDc" style="flex:1"><option value="">none</option>${cables.map(c=>`<option ${I.donor_cable?.cable===c.name?"selected":""}>${esc(c.name)}</option>`).join("")}</select><input id="lbDcFt" type="number" step="any" placeholder="ft" value="${I.donor_cable?.ft??""}" style="width:80px"></div></label>`:""}
          ${g==="Building"?`<label style="display:block;margin:4px 0"><span class="hint">In-building model</span><select id="lbModel"><option value="p1238" ${I.model!=="fspl"?"selected":""}>ITU-R P.1238 (distance coefficient)</option><option value="fspl" ${I.model==="fspl"?"selected":""}>Free space + walls</option></select></label>`:""}
          ${g==="Passive network"?`<div id="lbPass">${(I.passive||[]).map((e,i)=>`<div class="row" style="gap:6px;align-items:center;margin:3px 0"><span style="flex:1">${e.kind==="cable"?`${esc(e.cable)} · ${e.ft} ft`:`${esc(e.name)} · ${e.db} dB`}</span><button data-rmp="${i}">✕</button></div>`).join("")||'<p class="hint">No parts yet: add the cable runs and splitters or couplers to the farthest antenna.</p>'}</div>
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px"><select id="lbPc" style="flex:1"><option value="">Cable…</option>${cables.map(c=>`<option>${esc(c.name)}</option>`).join("")}</select><input id="lbPcFt" type="number" step="any" placeholder="ft" style="width:70px"><button id="lbAddC">Add run</button></div>
            <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:4px"><input id="lbPn" placeholder="Splitter, coupler tap…" style="flex:1"><input id="lbPd" type="number" step="any" placeholder="dB" style="width:70px"><button id="lbAddP">Add part</button></div>
            <button id="lbFromBom" style="margin-top:6px" title="Cable runs from this job's Materials list">Add the cable runs from Materials</button>`:""}</details>`).join("")}</div>
      <div><div class="panel"><h3>${b.cell?"Downlink: carrier site to the far edge, in RSRP":"Downlink: agency site to the far edge"}</h3>${stageTable(R.dl)}</div>
        <div class="panel"><h3>${b.cell?"Uplink: phone to the booster":"Uplink: portable radio to the agency site"}</h3>${stageTable(R.ul)}</div>
        <p class="hint">${b.cell?`RSRP is one subcarrier of the channel: a channel's total power less 10·log10(subcarriers); ${cellSubcarriers(I.bw_khz/1000, +I.scs_khz)} subcarriers here. Antenna EIRP ${R.eirp.toFixed(1)} dBm per subcarrier: the Antennas and coverage view shows RSRP. The 20.21 consumer caps are shown for scale: a commercial DAS is usually an industrial booster, run under each carrier's consent terms. Phone power and head-and-hand loss are placeholders (background): set them. `
          :`${R.perCh!=null?`Per-channel output: ${R.bdaOut.toFixed(1)} dBm (at most ${R.perCh.toFixed(1)}). `:""}Antenna EIRP ${R.eirp.toFixed(1)} dBm per channel: the Antennas and coverage view uses it. `}${LB_FORMULA_NOTE}</p></div></div>`;
  $("#lbBand").onclick=e=>{ const x=e.target.closest("[data-b]"); if(x){ D.lbBand=x.dataset.b; render(); } };
  $("#lbCaps")?.addEventListener("change", async e=>{ j=await save({design:{...(j.data.design||{}), caps:e.target.value||null}}); render(); });
  wireAdd(); $("#lbRmCell")?.addEventListener("click", ()=>setCell([...haveCell].filter(x=>x!==b.id)));
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
  ["Wood framing 1.5 in", "Lumber (spruce-pine-fir), dry", "38 mm", "wood", 3.8],
  ["Elevator shaft (concrete 8 in)", "Plain concrete (mix 1)", "203 mm (C18L)", "concrete", 20.3]];  // append only: walls keep their type by name
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
// --- floor to floor: antennas on the floors above and below count, through ITU-R P.1238 floor penetration loss ---
// Plans are taken as stacked: every floor's plan has the same top-left corner and its own width in feet. Floor height:
// typed, else the building's height over its floors, else 3.5 m (the figure dasRoof uses for the donor height).
const DS_FLOOR_H_FT = 11.5;
const DS_P1238_FLOORS_FALLBACK = {1:9, 2:19, 3:24};  // P.1238-10 Table 3, office, 0.9 GHz (when the research file isn't loaded)
// P.1238 floor penetration loss for n floors (office, 0.9 GHz: the band nearest 700 / 800 MHz in the table): null beyond 3
function dsP1238Floor(n){
  const rows=(FR.budget?.p1238||[]).filter(x=>x.floor_loss!=null&&String(x.freq_band).startsWith("0.9")&&/^office, \d floors? penetrated/.test(x.environment||""));
  const r=rows.find(x=>+String(x.environment).match(/(\d)/)[1]===n);
  if(r) return {db:+r.floor_loss, src:`ITU-R P.1238 office, 0.9 GHz, ${n} floor${n===1?"":"s"} (${r.edition}, ${r.table})`, cite:r.sources};
  return DS_P1238_FLOORS_FALLBACK[n]!=null?{db:DS_P1238_FLOORS_FALLBACK[n], src:`ITU-R P.1238-10 Table 3, office, 0.9 GHz, ${n} floor${n===1?"":"s"}`}:null;
}
// the job's walk-tuned values for a band, when they're switched on
const dsTuneOn = (d, band) => { const t=(((d.design||{}).tune)||{})[band]; return t&&t.on?t:null; };
// floor stacking settings: on, floor height, loss per n floors (with where it came from)
function dsStack(d, band){
  const s={on:true, h_ft:null, slab_db:null, ...((d.design||{}).stack||{})}, nf=(Array.isArray(d.floors)?d.floors.length:0)||1;
  const bh=d.building?.height_m&&(d.building.levels||nf)?d.building.height_m*3.28084/(d.building.levels||nf):null;
  const h_ft=+s.h_ft||bh||DS_FLOOR_H_FT, h_src=+s.h_ft?"typed":bh?"the building's height over its floors":"3.5 m a floor, assumed: set it";
  const t=band?dsTuneOn(d, band):null;
  const lf=n=>{ if(n===0) return {db:0, src:""};
    if(t&&t.floor_db!=null) return {db:n*t.floor_db, src:`${t.floor_db} dB a floor, tuned to the walk`};
    if(s.slab_db!=null&&s.slab_db!=="") return {db:n*+s.slab_db, src:`${s.slab_db} dB a floor, typed`};
    return dsP1238Floor(n); };
  return {on:s.on!==false, h_ft, h_src, slab_db:s.slab_db, lf};
}
// plan aspect ratios (height / width), by plan file: from the walk, from images already loaded, or loaded here
const DS_AR = new Map();
function dsArOf(d, f){ if(!f.plan) return null; if(DS_AR.has(f.plan)) return DS_AR.get(f.plan);
  const w=((d.walk||{}).floors||[]).find(x=>x.name===f.name&&x.arFor===f.plan&&x.ar); return w?w.ar:null; }
async function dsLoadAr(j, d){
  await Promise.all((Array.isArray(d.floors)?d.floors:[]).filter(f=>f.plan&&!DS_AR.has(f.plan)).map(async f=>{
    const u=typeof jobFileSrc==="function"?await jobFileSrc(j.id, f.plan):`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(f.plan)}`; if(!u) return;
    await new Promise(ok=>{ const i=new Image(); i.onload=()=>{ if(i.naturalWidth) DS_AR.set(f.plan, i.naturalHeight/i.naturalWidth); ok(); }; i.onerror=()=>{ DS_AR.set(f.plan, null); ok(); }; i.src=u; }); }));
}
// what reaches one floor: its own antennas and walls, and (stacking on) the antennas on floors within reach of P.1238's
// table, each with its vertical offset and floor loss. Positions in feet. Wall losses: typed, else tuned, else dsWallInfo.
function dsScene(d, f, I, R, opt={}){
  const floors=Array.isArray(d.floors)?d.floors:[], all=(d.design||{}).floors||{}, k=floors.findIndex(x=>x.name===f.name);
  const fl=all[f.name]||{}, wFt=+opt.wFt||+fl.width_ft||0, ar=opt.ar??dsArOf(d, f)??0.75, hFt=wFt*ar;
  const tune=opt.tune!==undefined?opt.tune:dsTuneOn(d, opt.band||I.band), st=dsStack(d, opt.band||I.band);
  const eirpOf=a=>R.bdaOut-(a.feed_db??R.passDl)+(a.gain??(+I.server_gain_dbi||0));
  const ants=(fl.antennas||[]).map((a,i)=>({x:a.x*wFt, y:a.y*hFt, z:0, n:0, lf:0, eirp:eirpOf(a), label:a.label||`A${i+1}`, floor:f.name, own:true, i}));
  let far=0, lfSrc="";
  if(st.on&&k>=0) floors.forEach((g,gi)=>{ if(gi===k) return; const o=all[g.name]; if(!o||!(o.antennas||[]).length) return;
    const n=Math.abs(gi-k), L=st.lf(n); if(!L){ far+=(o.antennas||[]).length; return; } lfSrc=lfSrc||L.src;
    const ow=+o.width_ft||wFt, oar=dsArOf(d, g)??ar;
    (o.antennas||[]).forEach((a,i)=>ants.push({x:a.x*ow, y:a.y*ow*oar, z:n*st.h_ft, n, lf:L.db, eirp:eirpOf(a), label:a.label||`A${i+1}`, floor:g.name, own:false, i})); });
  const walls=(fl.walls||[]).map(w=>{ const fixed=w.db!=null&&w.db!=="", tl=tune&&!fixed&&tune.walls&&tune.walls[w.label]!=null;
    return {x1:w.x1*wFt, y1:w.y1*hFt, x2:w.x2*wFt, y2:w.y2*hFt, label:w.label||w.mat||"Wall", fixed, db:tl?+tune.walls[w.label]:dsWallDb(w, I.f_dl)}; });
  return {f, fl, wFt, hFt, ar, ants, walls, far, st, lfSrc, tune, f_dl:I.f_dl, N:tune?.N??(+I.N||30), model:tune?"p1238":I.model};
}
// the level from one antenna at (x, y) ft, and what the path crossed (for the fit)
function dsPath(sc, a, x, y, fMHz){
  const dM=LB.ft2m(Math.hypot(x-a.x, y-a.y, a.z)), f=fMHz||sc.f_dl; let wl=0; const cross=[];
  for(const w of sc.walls) if(segX(a.x,a.y,x,y,w.x1,w.y1,w.x2,w.y2)){ wl+=w.db; cross.push(w); }
  const pl=sc.model==="fspl"?LB.fspl(dM,f):LB.p1238(dM,f,sc.N,0);
  return {L:a.eirp-pl-a.lf-wl, dM, cross};
}
function dsLevelAt(sc, x, y, fMHz){ let best=-Infinity, who=-1;
  for(let i=0;i<sc.ants.length;i++){ const L=dsPath(sc, sc.ants[i], x, y, fMHz).L; if(L>best){ best=L; who=i; } }
  return {L:best, who}; }
// predicted downlink over a floor: the best antenna at each cell (this floor's or, through the floor, another's)
function dsPredictScene(sc, cols){
  const rows=Math.max(1,Math.round(cols*sc.hFt/sc.wFt)), out=new Float32Array(cols*rows), who=new Int16Array(cols*rows);
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const v=dsLevelAt(sc, (c+.5)*sc.wFt/cols, (r+.5)*sc.hFt/rows); out[r*cols+c]=v.L; who[r*cols+c]=v.who; }
  return {cols, rows, out, who};
}
// the older call (one floor, its own antennas): kept for anything that still calls it
function dsPredict(fl, I, R, wFt, hFt, cols){
  const f={name:"_", plan:null}, d={floors:[f], design:{floors:{_:fl}, stack:{on:false}}};
  return dsPredictScene(dsScene(d, f, I, R, {wFt, ar:hFt/wFt, tune:null}), cols);
}

// --- per antenna: port power, EIRP and ERP against the cap, the weakest point it serves, and the uplink from there ---
// (LA County V7-C3-S21 asks a link budget for every service antenna; San Diego C-1 the downlink power at each antenna)
function dsPerAntenna(sc, P, I, R){
  const target=(+I.dl_min_dbm)+(+I.margin_db||0), cap=I.cell?null:(I.erp_limit_dbm??37), out=[];
  const ulIdx=R.ul.findIndex(s=>/^BDA uplink/.test(s.stage)), ulOutB=ulIdx>=0?R.ul[ulIdx].level:null;
  const fu=I.f_ul||I.f_dl, ulMax=I.bda_ul_max_dbm==null||I.bda_ul_max_dbm===""?null:+I.bda_ul_max_dbm;
  sc.ants.forEach((a,ai)=>{ if(!a.own) return;
    let n=0, worst=Infinity, wi=-1; for(let k=0;k<P.out.length;k++) if(P.who[k]===ai){ n++; if(P.out[k]<worst){ worst=P.out[k]; wi=k; } }
    const src=sc.fl.antennas[a.i], feed=src.feed_db??R.passDl, port=R.bdaOut-feed, erp=a.eirp-2.15;
    const row={label:a.label, port, eirp:a.eirp, erp, cap, erp_ok:cap==null||isNaN(erp)?null:erp<=cap, cells:n, share:P.out.length?n/P.out.length:0,
      weakest:n?worst:null, target, dl_ok:n&&!isNaN(worst)?worst>=target:null, at:wi>=0?{x:((wi%P.cols)+.5)/P.cols, y:(Math.floor(wi/P.cols)+.5)/P.rows}:null, ul_site:null, ul_ok:null};
    if(!I.cell&&n&&R.atSite!=null&&ulOutB!=null&&!isNaN(worst)){
      const loss=a.eirp-worst+20*Math.log10(fu/I.f_dl), ulIn=(+I.portable_dbm||0)-(+I.body_db||0)-loss+(src.gain??(+I.server_gain_dbi||0))-feed;
      const ulOut=ulMax!=null?Math.min(ulIn+(+I.bda_ul_gain_db||0), ulMax):ulIn+(+I.bda_ul_gain_db||0);
      row.ul_site=R.atSite+(ulOut-ulOutB);
      const lo=I.ul_min_dbm==null||I.ul_min_dbm===""?-95:+I.ul_min_dbm, hi=I.ul_max_dbm==null||I.ul_max_dbm===""?null:+I.ul_max_dbm;
      row.ul_ok=row.ul_site>=lo&&(hi==null||row.ul_site<=hi); row.ul_lim=hi!=null?`${lo} to ${hi}`:`≥ ${lo}`; }
    const oks=[row.erp_ok, row.dl_ok, row.ul_ok].filter(x=>x!=null); row.ok=!oks.length?null:oks.every(Boolean);
    out.push(row); });
  return out;
}
const dsOk = ok => ok==null?'<span class="hint">–</span>':ok?'<b style="color:var(--good)">pass</b>':'<b style="color:var(--bad)">fail</b>';
function dsAntTable(rows, I, print=false){
  if(!rows.length) return '<p class="hint">No antennas on this floor.</p>';
  const f1=v=>v==null||isNaN(v)?"–":(+v).toFixed(1), ok=print?(x=>x==null?"–":x?"pass":"FAIL"):dsOk;
  return `<div class="tw"><table><thead><tr><th>Antenna</th><th class="n">Port</th><th class="n">EIRP</th><th class="n">ERP${I.cell?"":` ≤ ${rows[0].cap}`}</th><th class="n">Weakest served</th><th class="n">Uplink at site</th><th>Result</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td><b>${esc(r.label)}</b>${r.cells?`<div class="hint">${Math.round(r.share*100)}% of the floor</div>`:""}</td><td class="n">${f1(r.port)}</td><td class="n">${f1(r.eirp)}</td><td class="n">${f1(r.erp)} ${I.cell?"":ok(r.erp_ok)}</td>
      <td class="n">${f1(r.weakest)} ${ok(r.dl_ok)}${r.weakest==null?'<div class="hint">serves no point (another antenna is stronger everywhere)</div>':""}</td><td class="n">${f1(r.ul_site)} ${r.ul_site!=null?ok(r.ul_ok):""}${r.ul_lim?`<div class="hint">${esc(r.ul_lim)}</div>`:""}</td><td>${ok(r.ok)}</td></tr>`).join("")}</tbody></table></div>`;
}

// --- tuning to the walk: predicted vs measured at every walk point, and N, wall losses and floor loss fitted to them ---
// The walk's points come from daswalk.js (window.wkPointsFor): placed points, public safety downlink in dBm. A reading's
// channel picks the band; a reading with no channel counts for the band shown.
function dsWalkObs(j, d, b, scenes){
  const out=[]; if(!window.wkPointsFor) return out;
  for(const sc of scenes){ if(!sc.wFt) continue;
    for(const p of window.wkPointsFor(j, sc.f.name)||[]) for(const r of p.rs||[]){
      if(r.dl==null||isNaN(+r.dl)) continue; const fq=parseFloat(r.freq);
      const fM=isFinite(fq)&&fq>25&&fq<6000?fq:null; if(fM!=null&&dasBand(fM)!==b.band) continue;
      out.push({sc, id:p.id, x:p.x, y:p.y, xf:p.x*sc.wFt, yf:p.y*sc.hFt, f:fM||b.f_dl, meas:+r.dl, inst:p.inst||"", floor:sc.f.name}); } }
  return out;
}
const dsStats = e => { const n=e.length; if(!n) return {n:0, mean:null, sd:null, rms:null}; const m=e.reduce((a,b)=>a+b,0)/n;
  return {n, mean:m, sd:n>1?Math.sqrt(e.reduce((a,b)=>a+(b-m)**2,0)/(n-1)):0, rms:Math.sqrt(e.reduce((a,b)=>a+b*b,0)/n)}; };
// measured − predicted at each point with the scene's current values
function dsCompare(obs){ return obs.map(o=>{ const v=dsLevelAt(o.sc, o.xf, o.yf, o.f); return {...o, pred:v.L, err:o.meas-v.L, who:v.who}; }); }
// a small linear solve (Gaussian elimination with pivoting)
function dsSolve(A, b){ const n=b.length, M=A.map((r,i)=>[...r, b[i]]);
  for(let c=0;c<n;c++){ let p=c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[p][c])) p=r; [M[c],M[p]]=[M[p],M[c]];
    if(Math.abs(M[c][c])<1e-12) return null; for(let r=0;r<n;r++) if(r!==c){ const k=M[r][c]/M[c][c]; for(let q=c;q<=n;q++) M[r][q]-=k*M[c][q]; } }
  return M.map((r,i)=>r[n]/r[i]); }
// Least squares (ridge toward the defaults, one pseudo-reading each) of P.1238's N, each wall type's loss and the loss per
// floor, to the walk. The best antenna at each point can change as the values move, so it re-picks and re-fits until
// the picks hold (at most 12 rounds). Typed wall losses stay fixed. Bounds: N 15-50, walls 0-60 dB, floor 0-40 dB.
function dsFit(obs, opt={}){
  const lam=opt.lambda??1, N0=obs[0]?.sc.N??30;
  const labels=[...new Set(obs.flatMap(o=>o.sc.walls.filter(w=>!w.fixed).map(w=>w.label)))];
  const w0={}; for(const o of obs) for(const w of o.sc.walls) if(!w.fixed&&w0[w.label]==null) w0[w.label]=w.db;
  const lf0=opt.floor0??9;
  // each point, each antenna: the parts of the path that don't depend on the values, and the counts that do
  const pre=obs.map(o=>o.sc.ants.map(a=>{ const p=dsPath({...o.sc, model:"p1238"}, a, o.xf, o.yf, o.f), cnt={}; let fixed=0;
    for(const w of p.cross){ if(w.fixed) fixed+=w.db; else cnt[w.label]=(cnt[w.label]||0)+1; }
    return {base:a.eirp-20*Math.log10(o.f)+28-fixed, lg:Math.log10(Math.max(p.dM,1)), cnt, n:a.n}; }));
  let th={N:N0, w:{...w0}, lf:lf0}, picks=null, rounds=0;
  const predOf=(q,t)=>q.base-t.N*q.lg-q.n*t.lf-Object.entries(q.cnt).reduce((s,[l,c])=>s+c*(t.w[l]??0),0);
  const pick=t=>pre.map(ps=>{ let bi=0, bv=-Infinity; ps.forEach((q,i)=>{ const v=predOf(q,t); if(v>bv){ bv=v; bi=i; } }); return bi; });
  const anyFloor=()=>picks.some((bi,i)=>pre[i][bi].n>0);
  picks=obs.map((o,i)=>{ const v=dsLevelAt(o.sc, o.xf, o.yf, o.f); return v.who>=0?v.who:0; });
  for(rounds=0;rounds<12;rounds++){
    const fitF=anyFloor(), cols=["N", ...labels.map(l=>"w:"+l), ...(fitF?["lf"]:[])], K=cols.length;
    const A=Array.from({length:K},()=>new Array(K).fill(0)), bb=new Array(K).fill(0);
    obs.forEach((o,i)=>{ const q=pre[i][picks[i]], x=cols.map(c=>c==="N"?-q.lg:c==="lf"?-q.n:-(q.cnt[c.slice(2)]||0)), y=o.meas-q.base;
      for(let r=0;r<K;r++){ bb[r]+=x[r]*y; for(let s=0;s<K;s++) A[r][s]+=x[r]*x[s]; } });
    cols.forEach((c,r)=>{ const p0=c==="N"?N0:c==="lf"?lf0:w0[c.slice(2)]; A[r][r]+=lam; bb[r]+=lam*p0; });
    const beta=dsSolve(A, bb); if(!beta) break;
    const nt={N:Math.min(50,Math.max(15,beta[0])), w:{...th.w}, lf:th.lf};
    cols.forEach((c,r)=>{ if(c.startsWith("w:")) nt.w[c.slice(2)]=Math.min(60,Math.max(0,beta[r])); if(c==="lf") nt.lf=Math.min(40,Math.max(0,beta[r])); });
    th=nt; const np=pick(th), same=np.every((v,i)=>v===picks[i]); picks=np; if(same) break; }
  const after=dsStats(obs.map((o,i)=>o.meas-predOf(pre[i][picks[i]], th)));
  const crossings={}; obs.forEach((o,i)=>{ for(const [l,c] of Object.entries(pre[i][picks[i]].cnt)) crossings[l]=(crossings[l]||0)+c; });
  const floorPts=obs.filter((o,i)=>pre[i][picks[i]].n>0).length;
  return {N:+th.N.toFixed(1), N0, walls:labels.map(l=>({label:l, def:w0[l], fit:+th.w[l].toFixed(1), crossings:crossings[l]||0})),
    floor:{def:lf0, fit:floorPts?+th.lf.toFixed(1):null, points:floorPts}, after, rounds:rounds+1,
    preds:obs.map((o,i)=>predOf(pre[i][picks[i]], th))};
}
// a DXF floor plan (dxf.js): saved as the floor's plan image at its true width, its wall-layer lines offered in the wall
// tools' review (dswalls.js), each with the material its layer name gives
const DS_MAT_LABEL = {drywall:/^Drywall/, conc4:/^Concrete 4 in/, conc8:/^Concrete wall or slab 8 in/, conc12:/^Concrete 12 in/, rc8:/^Reinforced concrete 8/, cmu:/^CMU/,
  brick:/^Brick, single/, brickcmu:/^Brick veneer/, glass:/^Clear glass/, lowe:/^Low-E/, wood:/^Wood/, shaft:/^Elevator shaft/};
const DS_MAT_WORD = {drywall:"drywall", conc4:"concrete 4 in", conc8:"concrete 8 in", conc12:"concrete 12 in", rc8:"reinforced concrete", cmu:"CMU", brick:"brick", brickcmu:"brick on CMU",
  glass:"glass", lowe:"low-E glass", wood:"wood", shaft:"shaft (concrete 8 in)"};
async function dsDxfImport(j, d, f, file, save){
  let r; try{ r=DXF.toFloor(await file.text(), {extKey:window.PlanLines?.materialFromText?.(d.construction)||"conc8"}); }
  catch(e){ (window.dasSay||alert)(`That DXF couldn't be read: ${e.message}`); return; }
  const name=`${file.name.replace(/\.dxf$/i,"")} (floor ${f.name}).png`, blob=await (await fetch(r.png)).blob();
  const up=await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(name)}`, {method:"POST", body:await blob.arrayBuffer()}), kept=up.saved||name;
  DS_AR.set(kept, r.H/r.W);
  const all=(d.design||{}).floors||{};
  await save({floors:d.floors.map(x=>x.name===f.name?{...x, plan:kept, plan_src:{dxf:file.name, png:kept}}:x), design:{...(d.design||{}), floors:{...all, [f.name]:{...(all[f.name]||{}), width_ft:r.width_ft}}}});
  const items=r.walls.map(w=>({...w, mi:Math.max(0, DS_WALLS.findIndex(x=>(DS_MAT_LABEL[w.mat]||/^$/).test(x[0]))), conf:0.9, lineConf:0.95, matConf:0.85, src:"vector",
    lineWhy:`DXF layer ${w.layer}${w.paired?": two faces taken as one wall":""}`, matWhy:`from the layer name ${w.layer}`}));
  S.das.dsReview=items.length?{floor:f.name, plan:kept, items, dup:0, smart:true, src:"vector", how:"DXF"}:null;
  S.das.dsDxf={floor:f.name, plan:kept, file:file.name, units:r.units, width_ft:r.width_ft, layers:r.layers.slice(0,12), walls:items.length, paired:r.paired, before:((all[f.name]||{}).walls||[]).length+((all[f.name]||{}).antennas||[]).length};
  render();
}
async function dsFloors(el, j, save){
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], bands=dsBands(d), D=S.das;
  if(!floors.length){ el.innerHTML='<p class="status">Set the number of floors on the Overview first.</p>'; return; }
  if(!bands.length){ el.innerHTML='<p class="status">Pick the systems in the Pre-survey and fill in the Link budget first: coverage uses its antenna power.</p>'; return; }
  D.dsFloor=floors.some(f=>f.name===D.dsFloor)?D.dsFloor:floors[0].name; D.dsBand=bands.some(b=>b.band===D.dsBand)?D.dsBand:bands.slice().sort((a,b)=>b.f_dl-a.f_dl)[0].band; D.dsTool=D.dsTool||"antenna";
  const f=floors.find(x=>x.name===D.dsFloor), b=bands.find(x=>x.band===D.dsBand), I=dsInputs(d,b), R=lbCompute(I);
  const all=(d.design||{}).floors||{}, fl={width_ft:null, antennas:[], walls:[], ...(all[f.name]||{})};
  const keep=async patch=>{ const nf={...all, [f.name]:{...fl, ...patch}}; await save({design:{...(d.design||{}), floors:nf}}); render(); };
  const keepD=async patch=>{ await save({design:{...(d.design||{}), ...patch}}); render(); };
  const target=(+I.dl_min_dbm)+(+I.margin_db||0), DWon=!!(window.DW&&window.PlanLines&&window.RFKeys);
  const st=dsStack(d, b.band), tune=dsTuneOn(d, b.band), tuneSaved=(((d.design||{}).tune)||{})[b.band];
  // the wall tools (dswalls.js): Add (antennas, walls, snip, lasso) and Remove, a key for each (the title says which)
  const TOOLS=DWon?[["antenna","Place antennas","A"],["wall","Draw walls","W"],["snip","Snip","S"],["lasso","Lasso","L"],["erase","Remove","E"]]:[["antenna","Place antennas"],["wall","Draw walls"],["erase","Remove"]];
  const toolTip={antenna:"Click to place a server antenna", wall:"Drag along a wall, or click its start and its end; snaps to walls and the plan's lines", snip:"Drag a box: the walls inside are found (Shift+S: Smart, each wall's own material)",
    lasso:"Draw a loop: the walls inside are found (Shift+L: Smart)", erase:"Click or drag a box to remove; or hold Shift in any other tool"};
  el.innerHTML=`<div class="maptools no-print" style="gap:10px;flex-wrap:wrap">
      <label class="inl">Floor <select id="dfF">${floors.map(x=>`<option ${x.name===f.name?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="inl">Band <select id="dfB">${bands.map(x=>`<option ${x.band===b.band?"selected":""}>${esc(x.band)}</option>`).join("")}</select></label>
      <label class="inl">Plan width <input id="dfW" type="number" step="any" value="${fl.width_ft??""}" placeholder="ft" style="width:80px"> ft</label>
      <div class="seg" id="dfTool">${TOOLS.map(([k,l,key])=>`<button data-t="${k}" class="${D.dsTool===k?"on":""}" title="${esc((toolTip[k]||l)+(key?` (${key})`:""))}">${l}</button>`).join("")}</div>
      <label class="inl" ${["wall","snip","lasso"].includes(D.dsTool)?"":'style="display:none"'} title="${DWon?"M / Shift+M: next / previous; 1-9 and 0: the first ten":""}">Wall <select id="dfWall">${DS_WALLS.map(([l],i)=>`<option value="${i}" ${(+D.dsWall||0)===i?"selected":""}>${DWon&&i<10?`${(i+1)%10} · `:""}${esc(l)}</option>`).join("")}</select></label>
      ${DWon?`<label class="inl" ${["snip","lasso"].includes(D.dsTool)?"":'style="display:none"'} title="Smart: each wall's material from the plan's words, fills and hatching, the job's other floors and its construction (Shift+S / Shift+L)"><input type="checkbox" id="dfSmart" ${D.dsSmart?"checked":""}> Smart materials</label>
      <button id="dfSnap" class="${D.dsSnap!==false?"on":""}" aria-pressed="${D.dsSnap!==false}" title="Snap to walls, the plan's line ends, crossings and lines, and square to the plan (X). Hold Ctrl for one wall without snap.">Snap</button>
      <button id="dfUndo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button><button id="dfRedo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
      <button id="dfBest" title="The best tool for this plan">Reading the plan's lines…</button>`:""}
      <span class="hint">Antenna EIRP ${R.eirp.toFixed(1)} dBm per channel (Link budget) · pass at ≥ ${target} dBm</span></div>
    <div class="maptools no-print" id="dfStackRow" style="gap:10px;flex-wrap:wrap;margin-top:-4px">
      <label class="inl" title="Antennas on the floors above and below reach this floor through the slab (ITU-R P.1238 floor penetration loss)"><input type="checkbox" id="dfStack" ${st.on?"checked":""}> Other floors' antennas</label>
      <label class="inl">Floor to floor <input id="dfFh" type="number" step="any" value="${(((d.design||{}).stack)||{}).h_ft??""}" placeholder="${st.h_ft.toFixed(1)}" style="width:70px"> ft</label>
      <label class="inl" title="Blank: ITU-R P.1238 office, 0.9 GHz (9 / 19 / 24 dB through 1 / 2 / 3 floors)">Loss a floor <input id="dfSlab" type="number" step="any" value="${st.slab_db??""}" placeholder="P.1238" style="width:84px"> dB</label>
      <label class="inl"><input type="checkbox" id="dfWkShow" ${D.dsWkShow!==false?"checked":""}> Walk points</label>
      ${window.DXF?`<button id="dfDxf" title="A CAD floor plan (DXF; save a DWG as DXF first): the drawing becomes this floor's plan at its true width, and the lines on wall layers become walls with a material from each layer's name, shown for review">Import DXF</button><input id="dfDxfIn" type="file" accept=".dxf" hidden>`:""}
      <span class="hint">${tune?`Tuned to the walk (${esc(tuneSaved.at||"")}): N ${tune.N}${tune.floor_db!=null?`, ${tune.floor_db} dB a floor`:""}`:`Floor height ${st.h_ft.toFixed(1)} ft (${esc(st.h_src)})`}</span></div>
    ${D.dsDxf&&D.dsDxf.floor===f.name&&D.dsDxf.plan===f.plan?`<p class="hint no-print" id="dfDxfNote" style="margin:-4px 2px 8px">From <b>${esc(D.dsDxf.file)}</b>: ${esc(D.dsDxf.units)}, ${D.dsDxf.width_ft} ft wide; ${D.dsDxf.walls} wall${D.dsDxf.walls===1?"":"s"} from wall layers (${D.dsDxf.paired} drawn as two faces, taken as one). Layers: ${D.dsDxf.layers.map(l=>`${esc(l.name)} ${l.n} (${l.mat==="skip"?"not a wall":l.mat?esc(DS_MAT_WORD[l.mat]||l.mat):"not read"})`).join(" · ")}.${D.dsDxf.before?` The ${D.dsDxf.before} walls and antennas placed on the old plan stay where they were on the page: check them.`:""}</p>`:""}
    ${DWon?`<div id="dfKeys" class="no-print"></div><div id="dfReview" class="no-print" hidden></div>`:""}
    ${!f.plan?'<p class="status">This floor has no plan yet: add one under Plans (a PDF page) or pick an image under Grid test.</p>'
      :!fl.width_ft?`<p class="status">Enter the plan's real width in feet (from the drawing's scale or dimensions) so distances are right.${DWon?' <button id="dfScaleW" hidden></button>':""}</p>`:""}
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(360px,2fr) minmax(240px,1fr)">
      <div class="panel" style="padding:8px"><div id="dfWrap" style="position:relative;width:100%;line-height:0">
        ${f.plan?`<img id="dfImg" style="width:100%;display:block;border-radius:8px;background:#fff" alt="Floor ${esc(f.name)} plan">`:'<div style="aspect-ratio:4/3;border-radius:8px;border:1px dashed var(--line)"></div>'}
        <canvas id="dfHeat" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:.5;border-radius:8px"></canvas>
        <svg id="dfSvg" style="position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;user-select:none;-webkit-user-select:none"></svg>${DWon?'<div id="dfToast" role="status" aria-live="polite" hidden></div>':""}</div>
        <p class="hint" id="dfHint" style="margin:6px 2px 0"></p></div>
      <div class="panel"><h3>Predicted</h3><div id="dfStats"><p class="hint">Place antennas to see the prediction.</p></div>
        <h3 style="margin-top:12px">Per antenna</h3><div id="dfAnt"><p class="hint">Place antennas and set the plan width.</p></div>
        <h3 style="margin-top:12px">Predicted vs the walk</h3><div id="dfWalk"><p class="hint">No walk on this floor yet (Grid test, Walk).</p></div>
        <h3 style="margin-top:12px">Antennas on this floor</h3>${(fl.antennas||[]).map((a,i)=>`<div class="row" style="gap:6px;align-items:center;margin:3px 0"><b>${esc(a.label||`A${i+1}`)}</b>
          <label class="inl">gain <input data-ag="${i}" type="number" step="any" value="${a.gain??""}" placeholder="${I.server_gain_dbi??""}" style="width:60px"></label>
          <label class="inl">feed loss <input data-af="${i}" type="number" step="any" value="${a.feed_db??""}" placeholder="${R.passDl.toFixed(1)}" style="width:66px"> dB</label></div>`).join("")||'<p class="hint">None yet.</p>'}
        <p class="hint">Feed loss defaults to the Link budget's passive network to the farthest antenna; nearer antennas lose less.</p>
        <h3 style="margin-top:12px">Walls on this floor</h3>${(fl.walls||[]).map(w=>{ const wi=dsWallInfo(w, I.f_dl), tw=tune&&(w.db==null||w.db==="")&&tune.walls?.[w.label]!=null; return `<div style="margin:3px 0">${esc(w.label||w.mat)}: <b>${(tw?+tune.walls[w.label]:wi.db).toFixed(1)} dB</b> at ${I.f_dl} MHz <span class="hint">· ${tw?`tuned to the walk (default ${wi.db.toFixed(1)}, ${esc(wi.how)})`:esc(wi.how)}</span></div>`; }).join("")||'<p class="hint">None drawn.</p>'}
        <p class="hint">Measured losses where the research has them (NIST NISTIR 6055 for concrete, block, brick, glass and wood; Cardinal for low-E glass). The P.2040 model alone gives about a third of NIST's measured loss for concrete, so it isn't used where a measurement exists.</p></div></div>`;
  $("#dfF").onchange=e=>{ D.dsFloor=e.target.value; render(); }; $("#dfB").onchange=e=>{ D.dsBand=e.target.value; render(); };
  $("#dfW").onchange=e=>keep({width_ft:+e.target.value||null});
  const stk=(d.design||{}).stack||{};
  $("#dfStack").onchange=e=>keepD({stack:{...stk, on:e.target.checked}});
  $("#dfFh").onchange=e=>keepD({stack:{...stk, h_ft:e.target.value===""?null:+e.target.value}});
  $("#dfSlab").onchange=e=>keepD({stack:{...stk, slab_db:e.target.value===""?null:+e.target.value}});
  $("#dfWkShow").onchange=e=>{ D.dsWkShow=e.target.checked; draw(); };
  $("#dfDxf")?.addEventListener("click", ()=>$("#dfDxfIn").click());
  $("#dfDxfIn")?.addEventListener("change", e=>{ const file=e.target.files[0]; if(file) dsDxfImport(j, d, f, file, save); });
  $("#dfTool").onclick=e=>{ const x=e.target.closest("[data-t]"); if(x){ D.dsTool=x.dataset.t; render(); } };
  if($("#dfWall")) $("#dfWall").onchange=e=>{ D.dsWall=+e.target.value; e.target.blur(); if(DWon) DW.paint(); };  // blurred: the editor's keys work again
  el.querySelectorAll("[data-ag]").forEach(i=>i.onchange=()=>keep({antennas:fl.antennas.map((a,k)=>k===+i.dataset.ag?{...a, gain:i.value===""?null:+i.value}:a)}));
  el.querySelectorAll("[data-af]").forEach(i=>i.onchange=()=>keep({antennas:fl.antennas.map((a,k)=>k===+i.dataset.af?{...a, feed_db:i.value===""?null:+i.value}:a)}));
  // tuning: fit to the walk (every floor with a design), use the fitted values, or go back to the defaults
  const scenesFor=t=>floors.filter(g=>(all[g.name]||{}).width_ft&&g.plan).map(g=>dsScene(d, g, I, R, {band:b.band, tune:t}));
  el.addEventListener("click", async e=>{ const x=e.target.closest("[data-dsfit]"); if(!x) return; const act=x.dataset.dsfit, T={...(((d.design||{}).tune)||{})};
    if(act==="fit"){ const obs=dsWalkObs(j, d, b, scenesFor(null)); if(obs.length<5){ D.dsFitRes={band:b.band, err:`${obs.length} walk point${obs.length===1?"":"s"} with a downlink reading on floors with a design: the fit needs 5 or more.`}; draw(); return; }
      const before=dsStats(dsCompare(obs).map(o=>o.err)), st0=dsStack(d, null), lf1=st0.slab_db!=null&&st0.slab_db!==""?+st0.slab_db:(dsP1238Floor(1)?.db??9);
      D.dsFitRes={band:b.band, before, ...dsFit(obs, {floor0:lf1}), at:today()}; draw(); }
    else if(act==="use"&&D.dsFitRes&&!D.dsFitRes.err){ const F=D.dsFitRes;
      T[b.band]={on:true, N:F.N, walls:Object.fromEntries(F.walls.map(w=>[w.label, w.fit])), floor_db:F.floor.fit, n:F.after.n,
        before:{mean:+F.before.mean.toFixed(1), sd:+F.before.sd.toFixed(1)}, after:{mean:+F.after.mean.toFixed(1), sd:+F.after.sd.toFixed(1)}, at:F.at, N0:F.N0,
        walls0:Object.fromEntries(F.walls.map(w=>[w.label, +(+w.def).toFixed(1)])), floor0:F.floor.def};
      D.dsFitRes=null; keepD({tune:T}); }
    else if(act==="off"&&T[b.band]){ T[b.band]={...T[b.band], on:false}; keepD({tune:T}); }
    else if(act==="on"&&T[b.band]){ T[b.band]={...T[b.band], on:true}; keepD({tune:T}); } });
  const img=$("#dfImg"), svg=$("#dfSvg"), cv=$("#dfHeat");
  const f1=v=>v==null||isNaN(v)?"–":(v>0?"+":"")+(+v).toFixed(1);
  const walkPanel=(cmp)=>{ const F=D.dsFitRes&&D.dsFitRes.band===b.band?D.dsFitRes:null, s=dsStats(cmp.map(o=>o.err));
    const allObs=tune||F?null:null;  // (the fit's own numbers cover every floor)
    let h=cmp.length?`<div class="kvg"><div>Walk points here</div><div><b>${s.n}</b> readings</div><div>Mean error</div><div><b>${f1(s.mean)} dB</b> <span class="hint">measured − predicted</span></div><div>Spread (SD)</div><div><b>${s.sd.toFixed(1)} dB</b></div></div>
      <div class="tw" style="max-height:220px;margin-top:6px"><table><thead><tr><th>Point</th><th class="n">Measured</th><th class="n">Predicted</th><th class="n">Error dB</th></tr></thead><tbody>
      ${cmp.slice(0,60).map(o=>`<tr><td>${esc(String(o.id))}</td><td class="n">${o.meas.toFixed(1)}</td><td class="n">${o.pred.toFixed(1)}</td><td class="n" style="color:${Math.abs(o.err)<=3?"var(--good)":Math.abs(o.err)<=6?"var(--warn)":"var(--bad)"}">${f1(o.err)}</td></tr>`).join("")}</tbody></table></div>${cmp.length>60?`<p class="hint">+${cmp.length-60} more on the map.</p>`:""}`
      :'<p class="hint">No walk readings on this floor yet (Grid test, Walk: a public safety downlink in dBm at each point).</p>';
    h+=`<div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px"><button data-dsfit="fit" title="Fit P.1238's N, each wall type's loss and the loss a floor to the walk readings on every floor">Fit to the walk</button>
      ${tune?'<button data-dsfit="off">Back to the defaults</button>':tuneSaved?`<button data-dsfit="on">Use the tuned values (${esc(tuneSaved.at||"")})</button>`:""}</div>`;
    if(F&&F.err) h+=`<p class="status err" style="margin-top:6px">${esc(F.err)}</p>`;
    else if(F) h+=`<div style="margin-top:8px"><p style="margin:0 0 4px"><b>Fit to ${F.after.n} readings</b>: mean error ${f1(F.before.mean)} → <b>${f1(F.after.mean)} dB</b>, spread ${F.before.sd.toFixed(1)} → <b>${F.after.sd.toFixed(1)} dB</b></p>
      <div class="tw"><table><thead><tr><th>Value</th><th class="n">Default</th><th class="n">Fitted</th><th class="n">Readings</th></tr></thead><tbody>
      <tr><td>P.1238 distance coefficient N</td><td class="n">${F.N0}</td><td class="n"><b>${F.N}</b></td><td class="n">${F.after.n}</td></tr>
      ${F.walls.map(w=>`<tr><td>${esc(w.label)} dB</td><td class="n">${(+w.def).toFixed(1)}</td><td class="n"><b>${w.fit}</b></td><td class="n">${w.crossings} crossing${w.crossings===1?"":"s"}</td></tr>`).join("")}
      <tr><td>Loss a floor dB</td><td class="n">${F.floor.def}</td><td class="n"><b>${F.floor.fit??"not fitted"}</b></td><td class="n">${F.floor.points} through a floor</td></tr></tbody></table></div>
      <button class="primary" data-dsfit="use" style="margin-top:6px">Use the fitted values</button>
      <p class="hint">Least squares on this job's own readings, held toward the defaults by one reading's weight each, so a wall type crossed by few paths moves little. The defaults stay saved: Back to the defaults returns to them.</p></div>`;
    return h; };
  const draw=()=>{
    const W=svg.clientWidth, H=svg.clientHeight; if(!W||!H) return;
    let marks="";
    svg.innerHTML=(fl.walls||[]).map(w=>`<line x1="${w.x1*W}" y1="${w.y1*H}" x2="${w.x2*W}" y2="${w.y2*H}" stroke="#e5534b" stroke-width="3" stroke-linecap="round"><title>${esc(w.label||w.mat||"Wall")}${w.src?` · found in the ${w.src==="vector"?"PDF":"plan image"}${w.conf!=null?`, ${Math.round(w.conf*100)}% sure`:""}`:""}</title></line>`).join("")
      +(fl.antennas||[]).map((a,i)=>`<g><circle cx="${a.x*W}" cy="${a.y*H}" r="9" fill="#f0a37a" stroke="#2a160c" stroke-width="2"/><text x="${a.x*W+12}" y="${a.y*H+4}" font-size="12" fill="#2a160c" style="paint-order:stroke;stroke:#fff;stroke-width:3px">${esc(a.label||`A${i+1}`)}</text></g>`).join("")
      +(D.dsWallStart?`<circle cx="${D.dsWallStart[0]*W}" cy="${D.dsWallStart[1]*H}" r="5" fill="#e5534b"/>`:"");
    if(DWon) DW.paint();  // the tools' marks: snap, preview, what a snip found
    if(!fl.width_ft||!img){ cv.width=1; cv.height=1; $("#dfHint").textContent=DWon?DW.hint():D.dsTool==="wall"?"Click a wall's start, then its end.":D.dsTool==="erase"?"Click an antenna or a wall to remove it.":"Click to place a server antenna."; return; }
    if(img.naturalWidth) DS_AR.set(f.plan, img.naturalHeight/img.naturalWidth);
    const sc=dsScene(d, f, I, R, {band:b.band, ar:img.naturalWidth?img.naturalHeight/img.naturalWidth:undefined});
    // walk points, measured against the prediction, on the map: green within 3 dB, amber within 6, red beyond
    const cmp=dsCompare(dsWalkObs(j, d, b, [sc]));
    if(D.dsWkShow!==false&&cmp.length){ const g=document.createElementNS("http://www.w3.org/2000/svg","g"); g.setAttribute("pointer-events","none"); g.setAttribute("class","dfWk");
      g.innerHTML=cmp.map(o=>{ const c=Math.abs(o.err)<=3?"#2f9e5f":Math.abs(o.err)<=6?"#d29014":"#c62828";
        return `<g><circle cx="${o.x*W}" cy="${o.y*H}" r="6" fill="${c}" stroke="#fff" stroke-width="1.5"><title>Point ${esc(String(o.id))}: measured ${o.meas.toFixed(1)}, predicted ${o.pred.toFixed(1)} dBm</title></circle><text x="${o.x*W}" y="${o.y*H-9}" text-anchor="middle" font-size="10" fill="${c}" style="paint-order:stroke;stroke:#fff;stroke-width:3px">${f1(o.err)}</text></g>`; }).join("");
      svg.appendChild(g); }
    $("#dfWalk").innerHTML=walkPanel(cmp);
    if(!sc.ants.length){ cv.width=1; cv.height=1; $("#dfStats").innerHTML='<p class="hint">Place antennas to see the prediction.</p>'; $("#dfAnt").innerHTML='<p class="hint">No antennas on this floor.</p>';
      $("#dfHint").textContent=DWon?DW.hint():"Click to place a server antenna."; return; }
    const P=dsPredictScene(sc, 140);
    cv.width=P.cols; cv.height=P.rows; const cx2=cv.getContext("2d"), id=cx2.createImageData(P.cols,P.rows);
    let ok=0, warn=0, viaFloor=0;
    for(let k=0;k<P.out.length;k++){ const v=P.out[k], o=k*4, good=v>=target+5, pass=v>=target; if(pass) ok++; if(pass&&!good) warn++; if(sc.ants[P.who[k]]&&!sc.ants[P.who[k]].own) viaFloor++;
      const [r,g,b2]=good?[60,207,122]:pass?[250,178,25]:[229,83,75]; id.data[o]=r; id.data[o+1]=g; id.data[o+2]=b2; id.data[o+3]=255; }
    cx2.putImageData(id,0,0); cv.style.imageRendering="pixelated";
    // the grid test's squares, at their centres
    const n=f.grids||DAS.grids, gc=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), gr=Math.ceil(n/gc); let sq=0, sqPass=0; const skip=new Set(f.skip||[]);
    for(let g=1;g<=n;g++){ if(skip.has(g)) continue; const c=(g-1)%gc, r=Math.floor((g-1)/gc), px=Math.min(P.cols-1,Math.floor((c+.5)/gc*P.cols)), py=Math.min(P.rows-1,Math.floor((r+.5)/gr*P.rows)); sq++; if(P.out[py*P.cols+px]>=target) sqPass++; }
    const other=sc.ants.filter(a=>!a.own).length;
    $("#dfStats").innerHTML=`<div class="kvg"><div>Floor area at or above ${target} dBm</div><div><b>${Math.round(ok/P.out.length*100)}%</b> <span class="hint">(${Math.round(warn/P.out.length*100)}% within 5 dB of it)</span></div>
      <div>Grid squares predicted to pass</div><div><b>${sqPass}/${sq}</b> <span class="hint">at their centres</span></div><div>Antennas</div><div>${fl.antennas.length} here${st.on?` + ${other} on other floors`:""}</div><div>Walls drawn</div><div>${(fl.walls||[]).length}</div>
      ${st.on&&other?`<div>Best served through a floor</div><div>${Math.round(viaFloor/P.out.length*100)}% of the floor</div>`:""}</div>
      <p class="hint" style="margin:6px 0 0">Green ≥ ${target+5} dBm, amber within 5 dB of the requirement, red below it. A prediction: the grid test decides.
        ${st.on?`Other floors count through ${esc(sc.lfSrc||"the floor loss")}${sc.far?`; ${sc.far} antenna${sc.far===1?"":"s"} more than 3 floors away don't (P.1238 lists no loss beyond 3)`:""}; plans taken as stacked, top-left corners aligned.`:"This floor's antennas only."}</p>`;
    $("#dfAnt").innerHTML=dsAntTable(dsPerAntenna(sc, P, I, R), I)+`<p class="hint">Levels in dBm. Port: the BDA's per-channel output less the antenna's feed loss. ERP = EIRP − 2.15 dB, against ${I.cell?"no cap (cellular)":`${I.erp_limit_dbm??37} dBm (${esc(dsCapNote(d, "erp_limit_dbm")||"47 CFR 90.219: 5 W")})`}. The weakest point is the lowest predicted level where this antenna is the strongest; the uplink is a portable there, through this antenna, to the agency's receiver.</p>`;
    $("#dfHint").textContent=DWon?DW.hint():D.dsTool==="wall"?"Click a wall's start, then its end.":D.dsTool==="erase"?"Click an antenna or a wall to remove it.":"Click to place another antenna.";
  };
  if(DWon) DW.mount({el, j, d, f, fl, D, I, R, save, keep, svg, img});  // pointer, keys, snap, snip / lasso, review, undo (dswalls.js)
  else svg.onclick=e=>{ const r=svg.getBoundingClientRect(), x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height;
    if(D.dsTool==="antenna") keep({antennas:[...(fl.antennas||[]), {x, y, label:`A${(fl.antennas||[]).length+1}`}]});
    else if(D.dsTool==="wall"){ if(!D.dsWallStart){ D.dsWallStart=[x,y]; draw(); return; }
      const P=DS_WALLS[+D.dsWall||0], s=D.dsWallStart; D.dsWallStart=null; keep({walls:[...(fl.walls||[]), {x1:s[0],y1:s[1],x2:x,y2:y,label:P[0],mat:P[3],cm:P[4]}]}); }
    else { const W=r.width, H=r.height, near=(fl.antennas||[]).findIndex(a=>Math.hypot((a.x-x)*W,(a.y-y)*H)<14);
      if(near>=0){ keep({antennas:fl.antennas.filter((_,i)=>i!==near)}); return; }
      const wi=(fl.walls||[]).findIndex(w=>{ const ax=w.x1*W, ay=w.y1*H, bx=w.x2*W, by=w.y2*H, px=x*W, py=y*H, L2=(bx-ax)**2+(by-ay)**2, t=L2?Math.max(0,Math.min(1,((px-ax)*(bx-ax)+(py-ay)*(by-ay))/L2)):0; return Math.hypot(px-(ax+t*(bx-ax)),py-(ay+t*(by-ay)))<8; });
      if(wi>=0) keep({walls:fl.walls.filter((_,i)=>i!==wi)}); } };
  // the plan comes through jobFileSrc (das.js), so the web version shows it too; the heatmap draws once it has loaded
  if(img){ img.onload=draw; jobFileSrc(j.id, f.plan).then(u=>{ if(u&&img.isConnected) img.src=u; }); } else draw();
  new ResizeObserver(draw).observe(svg);
  // the other floors' plan shapes, for their antennas (floor to floor): the view draws at once and again when they arrive
  if(floors.some(g=>g.plan&&!DS_AR.has(g.plan)&&dsArOf(d,g)==null)) dsLoadAr(j, d).then(()=>{ if(el.isConnected) draw(); });
}
// one floor's design as a picture (plan, predicted coverage, the test grid, walls, antennas), for the submittal packet
async function dsFloorPicture(j, d, f, b){
  const fl=((d.design||{}).floors||{})[f.name]; if(!f.plan||!fl||!fl.width_ft) return null;
  const img=await new Promise(ok=>{ const i=new Image(); i.onload=()=>ok(i); i.onerror=()=>ok(null); i.src=`/api/das/jobs/${j.id}/file?name=${encodeURIComponent(f.plan)}`; });
  if(!img) return null;
  DS_AR.set(f.plan, img.naturalHeight/img.naturalWidth);
  const scale=Math.min(1, 1400/img.naturalWidth), W=Math.round(img.naturalWidth*scale), H=Math.round(img.naturalHeight*scale);
  const cv=document.createElement("canvas"); cv.width=W; cv.height=H; const g=cv.getContext("2d");
  g.fillStyle="#fff"; g.fillRect(0,0,W,H); g.drawImage(img,0,0,W,H);
  const I=dsInputs(d,b), R=lbCompute(I), target=(+I.dl_min_dbm)+(+I.margin_db||0); let stats=null, ants=[];
  const sc=dsScene(d, f, I, R, {band:b.band, ar:H/W});
  if(sc.ants.length){ const P=dsPredictScene(sc, 140); let ok=0;
    g.globalAlpha=.45; for(let r=0;r<P.rows;r++) for(let c=0;c<P.cols;c++){ const v=P.out[r*P.cols+c]; if(v>=target) ok++;
      g.fillStyle=v>=target+5?"#3ccf7a":v>=target?"#fab219":"#e5534b"; g.fillRect(c*W/P.cols, r*H/P.rows, W/P.cols+1, H/P.rows+1); }
    g.globalAlpha=1; stats={pct:Math.round(ok/P.out.length*100), other:sc.ants.filter(a=>!a.own).length}; ants=dsPerAntenna(sc, P, I, R); }
  // the test grid, numbered, where the grid test has it on the plan (das.js grid box: centre, size in %, turned rot°)
  const n=f.grids||DAS.grids, cols=dasCols(f), rows=Math.ceil(n/cols), bx={cx:50, cy:50, w:100, h:100, rot:0, ...(f.gridbox||{})}, crit=new Set(f.critical||[]), skip=new Set(f.skip||[]);
  g.save(); g.translate(bx.cx/100*W, bx.cy/100*H); g.rotate(bx.rot*Math.PI/180); const gw=bx.w/100*W, gh=bx.h/100*H;
  g.strokeStyle="#1f3a93"; g.lineWidth=1.5; g.font=`bold ${Math.max(11,Math.round(Math.min(gw/cols,gh/rows)/6))}px sans-serif`; g.textAlign="left"; g.textBaseline="top";
  for(let k=1;k<=n;k++){ const c=(k-1)%cols, r=Math.floor((k-1)/cols), x=-gw/2+c*gw/cols, y=-gh/2+r*gh/rows;
    g.setLineDash(skip.has(k)?[4,4]:[]); g.strokeRect(x, y, gw/cols, gh/rows); g.setLineDash([]);
    const t=`${k}${crit.has(k)?" C":""}${skip.has(k)?" –":""}`; g.lineWidth=3; g.strokeStyle="#fff"; g.strokeText(t, x+4, y+3); g.fillStyle=crit.has(k)?"#b3261e":"#1f3a93"; g.fillText(t, x+4, y+3); g.lineWidth=1.5; g.strokeStyle="#1f3a93"; }
  g.restore();
  g.strokeStyle="#c62828"; g.lineWidth=3; for(const w of fl.walls||[]){ g.beginPath(); g.moveTo(w.x1*W,w.y1*H); g.lineTo(w.x2*W,w.y2*H); g.stroke(); }
  (fl.antennas||[]).forEach((a,i)=>{ g.fillStyle="#f0a37a"; g.strokeStyle="#2a160c"; g.lineWidth=2; g.beginPath(); g.arc(a.x*W,a.y*H,9,0,2*Math.PI); g.fill(); g.stroke();
    g.font="bold 13px sans-serif"; g.textBaseline="alphabetic"; g.lineWidth=3; g.strokeStyle="#fff"; g.strokeText(a.label||`A${i+1}`, a.x*W+12, a.y*H+4); g.fillStyle="#111"; g.fillText(a.label||`A${i+1}`, a.x*W+12, a.y*H+4); });
  return {src:cv.toDataURL("image/png"), stats, target, antennas:(fl.antennas||[]).length, walls:(fl.walls||[]).length, grids:n-skip.size, critical:crit.size, ants, I, sc};
}

/* ---------- the system as a one-line diagram, for the AHJ (Cody 11/3: "a physical schematic/topology or visual
   representation for the AHJ report showing paths (start/finish)") ----------
   Agency site → donor antenna → donor cable → BDA → passive network → server antennas → farthest point, with each
   stage's downlink level above (left to right) and uplink below (right to left), from the job's own link budget; then
   every band's levels and results, each donor path to an agency site, and the antennas on each floor. */
window.dasSchematic = d => {
  const bands=dsBands(d);
  if(!bands.length) return `<p class="hint">Choose the systems on the Pre-survey and fill the Design's link budget to draw the system diagram.</p>`;
  const all=bands.map(b=>{ const I=dsInputs(d,b); return {b, I, R:lbCompute(I)}; });
  const main=all.find(x=>!x.I.cell)||all[0], I=main.I, R=main.R;
  const f1=v=>v==null||isNaN(v)?"–":(+v).toFixed(1), n0=v=>v==null||v===""||isNaN(+v)?null:+v;
  // the donor's far ends: agency sites with a terrain path kept on the Pre-survey (nearest first)
  const rad=x=>x*Math.PI/180;
  const path=(la,lo)=>{ const p1=rad(d.lat), p2=rad(la), dl=rad(lo-d.lon), y=Math.sin(dl)*Math.cos(p2), x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    const a=Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
    return {deg:(Math.atan2(y,x)*180/Math.PI+360)%360, mi:3958.8*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))}; };
  const terWord=t=>t.status==="clear"?"clear line of sight":String(t.status||"").startsWith("Fresnel")?"partly blocked":"blocked by terrain";
  const sites=d.lat==null?[]:Object.entries((d.presurvey||{}).terrain||{}).filter(([,t])=>t&&!t.error&&t.site)
    .map(([cs,t])=>{ const [la,lo]=t.site.split(",").map(Number); return {cs, t, ...path(la,lo)}; }).sort((a,b)=>a.mi-b.mi);
  const s0=sites[0];
  // floors and the antennas placed on them (Design, Antennas and coverage)
  const dfl=(d.design||{}).floors||{}, floors=(Array.isArray(d.floors)?d.floors:[]).map(f=>({name:f.name, n:((dfl[f.name]||{}).antennas||[]).length}));
  const nAnt=floors.reduce((s,f)=>s+f.n,0), withAnt=floors.filter(f=>f.n).length;
  const parts=(I.passive||[]).map(e=>e.kind==="cable"?`${e.cable||"cable"} ${e.ft||0} ft`:`${e.name||"part"} ${e.db??""} dB`);
  const dc=I.donor_cable, need=(n0(I.dl_min_dbm)??0)+(n0(I.margin_db)??0);
  const dlAt=i=>R.dl[i]?.level, ulAt=i=>R.ul[i]?.level, ulLast=R.ul.length?R.ul[R.ul.length-1].level:null;
  // [title, lines, downlink level, uplink level]
  const N=[
    ["Agency site", s0?[s0.cs, `${s0.mi.toFixed(1)} mi at ${Math.round(s0.deg)}°`, terWord(s0.t)]:["from the Pre-survey", "(run Terrain paths)"], dlAt(0)!=null?`${f1(dlAt(0))} at roof`:null, R.atSite!=null?f1(ulLast):null],
    ["Donor antenna", [`${n0(I.donor_gain_dbi)??"–"} dBi`, `${Math.round(dasRoof(d))} m up (roof)`, s0?`aimed ${Math.round(s0.deg)}°`:""], f1(dlAt(1)), R.erpUl!=null?`${f1(R.erpUl)} ERP`:null],
    ["Donor cable", [dc?dc.cable:"not set", dc?`${dc.ft} ft`:"", `${I.donor_connectors??2} connectors`], f1(dlAt(2)), f1(ulAt(7))],
    ["BDA", [String(d.booster_class||"").replace(/ \(.*\)/,""), `DL +${n0(I.bda_dl_gain_db)??"–"} · UL +${n0(I.bda_ul_gain_db)??"–"} dB`, n0(I.bda_max_dbm)!=null?`max ${I.bda_max_dbm} dBm`:""], f1(dlAt(3)), f1(ulAt(6))],
    ["Passive network", parts.length?[`${parts.length} part${parts.length===1?"":"s"}`, ...parts.slice(0,2).map(p=>p.length>22?p.slice(0,21)+"…":p)].concat(parts.length>2?[`+${parts.length-2} more`]:[]):["not set"], f1(dlAt(4)), f1(ulAt(5))],
    ["Server antennas", [`${nAnt||"–"} on ${withAnt||"–"} floor${withAnt===1?"":"s"}`, `${n0(I.server_gain_dbi)??"–"} dBi each`], `${f1(dlAt(5))} EIRP`, f1(ulAt(4))],
    ["Farthest point", [`${n0(I.edge_ft)??"–"} ft from an antenna`, `${n0(I.walls_db)??0} dB of walls`, `needs ≥ ${need} dBm`], f1(R.edge), f1(ulAt(1))]];
  const W=1000, bw=118, bh=92, gap=(W-20-N.length*bw)/(N.length-1), top=46;
  const xs=N.map((_,i)=>10+i*(bw+gap));
  const box=(n,i)=>{ const x=xs[i], ln=n[1].filter(Boolean).slice(0,4);
    return `<rect x="${x}" y="${top}" width="${bw}" height="${bh}" rx="8" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <text x="${x+bw/2}" y="${top+17}" text-anchor="middle" font-weight="700" font-size="12" fill="currentColor">${esc(n[0])}</text>
      ${ln.map((l,k)=>`<text x="${x+bw/2}" y="${top+35+k*14}" text-anchor="middle" font-size="10.5" fill="currentColor" opacity=".8">${esc(l)}</text>`).join("")}
      ${n[2]!=null&&n[2]!=="–"?`<text x="${x+bw/2}" y="${top-8}" text-anchor="middle" font-size="11" fill="#1f6feb" font-weight="600">${esc(n[2])}${/[a-z]/.test(n[2])?"":" dBm"}</text>`:""}
      ${n[3]!=null&&n[3]!=="–"?`<text x="${x+bw/2}" y="${top+bh+18}" text-anchor="middle" font-size="11" fill="#bf5700" font-weight="600">${esc(n[3])}${/[a-z]/.test(n[3])?"":" dBm"}</text>`:""}`; };
  const links=N.slice(1).map((_,i)=>{ const a=xs[i]+bw, b=xs[i+1];
    return `<line x1="${a+2}" y1="${top+bh/2-7}" x2="${b-4}" y2="${top+bh/2-7}" stroke="#1f6feb" stroke-width="2" marker-end="url(#sdDl)"/>
      <line x1="${b-2}" y1="${top+bh/2+7}" x2="${a+4}" y2="${top+bh/2+7}" stroke="#bf5700" stroke-width="2" marker-end="url(#sdUl)"/>`; }).join("");
  const svg=`<svg viewBox="0 0 ${W} ${top+bh+40}" style="width:100%;height:auto;max-width:1000px;color:inherit" role="img" aria-label="System diagram: agency site to the farthest point">
    <defs><marker id="sdDl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#1f6feb"/></marker>
      <marker id="sdUl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#bf5700"/></marker></defs>
    <text x="10" y="14" font-size="11" fill="#1f6feb" font-weight="600">Downlink → (agency to radios), ${esc(main.b.band)}, dBm</text>
    <text x="${W-10}" y="14" text-anchor="end" font-size="11" fill="#bf5700" font-weight="600">← Uplink (radios to agency), dBm</text>
    ${links}${N.map(box).join("")}</svg>`;
  const res=x=>{ const c=x.R.checks, fail=c.filter(k=>k.ok===false).length, open=c.filter(k=>k.ok==null).length, warn=c.filter(k=>k.ok==="warn").length;
    return fail?`<b style="color:#cf222e">${fail} fail</b>`:open?`${open} open`:warn?`pass, ${warn} warn`:`<b style="color:#1a7f37">pass</b>`; };
  const bandTable=`<div class="tw"><table style="margin-top:8px"><thead><tr><th>Band</th><th>Systems</th><th class="n">At roof dBm</th><th class="n">BDA out dBm</th><th class="n">Antenna EIRP dBm</th><th class="n">Farthest point dBm</th><th class="n">Needs dBm</th><th class="n">Uplink at site dBm</th><th>Checks</th></tr></thead><tbody>
    ${all.map(x=>`<tr><td>${esc(x.b.band)}</td><td style="white-space:normal">${esc((x.b.systems||[]).join(", "))}</td><td class="n">${f1(x.R.dl[0]?.level)}</td><td class="n">${f1(x.R.roofMissing?null:x.R.bdaOut)}</td><td class="n">${f1(x.R.roofMissing?null:x.R.eirp)}</td>
      <td class="n">${f1(x.R.edge)}</td><td class="n">${f1((n0(x.I.dl_min_dbm)??0)+(n0(x.I.margin_db)??0))}</td><td class="n">${f1(x.R.atSite)}</td><td>${res(x)}</td></tr>`).join("")}</tbody></table></div>`;
  const siteTable=sites.length?`<div class="tw"><table style="margin-top:8px"><thead><tr><th>Donor path to</th><th class="n">Distance mi</th><th class="n">Bearing</th><th>Terrain</th><th class="n">Terrain loss dB</th></tr></thead><tbody>
    ${sites.map(s=>`<tr><td>${esc(s.cs)}</td><td class="n">${s.mi.toFixed(2)}</td><td class="n">${Math.round(s.deg)}°</td><td>${esc(terWord(s.t))}${s.t.clearance_f1!=null?`, ${esc(String(s.t.clearance_f1))} of the first Fresnel zone clear`:""}</td><td class="n">${s.t.loss_db?f1(s.t.loss_db):"0"}</td></tr>`).join("")}</tbody></table></div>`
    // a carrier-only job's donors are its rooftop readings per carrier (Pre-survey, cellular carriers), not agency sites
    :(typeof dasCellOnly==="function"&&dasCellOnly(d)&&Object.values((d.cellular||{}).donor||{}).some(v=>v&&v.rsrp!=null))
      ?`<div class="tw"><table style="margin-top:8px"><thead><tr><th>Rooftop donor</th><th class="n">RSRP dBm</th><th class="n">SINR dB</th><th>Band</th><th class="n">Azimuth</th><th class="n">Height ft</th><th>Measured</th></tr></thead><tbody>
        ${Object.entries(d.cellular.donor).filter(([,v])=>v&&v.rsrp!=null).map(([c,v])=>`<tr><td>${esc(c)}</td><td class="n">${f1(v.rsrp)}</td><td class="n">${v.sinr!=null?f1(v.sinr):"–"}</td><td>${esc(v.band||"")}</td><td class="n">${v.az!=null?`${Math.round(v.az)}°`:"–"}</td><td class="n">${v.height_ft??"–"}</td><td class="mono">${esc(v.at||"")}</td></tr>`).join("")}</tbody></table></div>`
    :`<p class="hint">No donor paths yet: run Terrain paths on the Pre-survey to add each agency site's distance, bearing and terrain.</p>`;
  const floorRow=floors.length?`<p style="margin:8px 0 0"><b>Antennas by floor:</b> ${floors.map(f=>`Floor ${esc(f.name)}: ${f.n}`).join(" · ")}${nAnt?"":" (none placed yet: Design, Antennas and coverage)"}</p>`:"";
  return `${svg}<p class="hint" style="margin:2px 0 0">Levels are the ${esc(main.b.band)} link budget's worst case (${main.I.f_dl} MHz down, ${main.I.f_ul} MHz up); every band is in the table below. Blue: what reaches the radios inside; orange: what reaches the agency's receiver.${R.roofMissing?" The signal at the roof isn't entered yet, so downlink levels are open.":""}</p>
    ${bandTable}${siteTable}${floorRow}`;
};

/* ---------- the design submittal for the AHJ (Report → Design submittal) ----------
   Laid out as San Diego FD C-1 Appendix C and NFPA 1225 (2022) A.18.2.1 ask: a cover sheet (building description per
   floor, owner / designer / installer, scope, statement of compliance with the code editions, sheet index), then one
   sheet per item, each with its sheet ID; every printed page carries the project, revision and page number. */
const DS_IBC_TYPES = ["IA","IB","IIA","IIB","IIIA","IIIB","IV-A","IV-B","IV-C","IV-HT","VA","VB"];  // IBC 2021 602
const DS_IBC_GROUPS = ["A-1","A-2","A-3","A-4","A-5","B","E","F-1","F-2","H-1","H-2","H-3","H-4","H-5","I-1","I-2","I-3","I-4","M","R-1","R-2","R-3","R-4","S-1","S-2","U"];  // IBC 2021 ch. 3
const DS_SPRINKLER = ["NFPA 13", "NFPA 13R", "NFPA 13D", "Partial (NFPA 13)", "None"];
// the submittal's own fields (Design › Submittal details), with what the job already knows filled in
function dsSub(d){
  const s=(d.design||{}).sub||{}, n=d.nsi||{}, nf=(Array.isArray(d.floors)?d.floors.length:0);
  const below=(Array.isArray(d.floors)?d.floors:[]).filter(f=>/^(b|p|ll|sb|basement|garage)\s*\d*$/i.test(String(f.name).trim())||/below|basement|sub/i.test(String(f.name))).length;
  return {project_no:"", revision:"A", rev_date:"", rev_note:"Issued for review", occupancy:"", sprinkler:"", sqft:d.area_sqft||n.sqft||"", above:nf?nf-below:"", below:nf?below:"",
    scope:"Design of an in-building emergency responder communication enhancement system (ERCES): bi-directional amplifier, donor antenna, distributed antenna system, battery backup and monitoring.",
    fire_code:String(d.code||"").split("+")[0].trim()||"2021 International Fire Code 510", nfpa:"NFPA 1225 (2022) chapter 18", fcc:"47 CFR 90.219", local:d.ahj?`${d.ahj} ERCES requirements`:"", floors:{},
    designer:{}, installer:{}, iso:{}, ...s, floors:{...(s.floors||{})}, designer:{...(s.designer||{})}, installer:{...(s.installer||{})}, iso:{...(s.iso||{})}};
}
async function dsSubDetails(el, j, save){
  const d=j.data||{}, s=dsSub(d), floors=Array.isArray(d.floors)?d.floors:[];
  const keep=async patch=>{ const cur=(d.design||{}).sub||{}; await save({design:{...(d.design||{}), sub:{...cur, ...patch}}}); render(); };
  const inp=(k, label, v, w=200, ph="")=>`<label>${esc(label)}<input data-sd="${k}" value="${esc(v??"")}" placeholder="${esc(ph)}" style="width:${w}px;max-width:100%"></label>`;
  const grp=(g, label, fields)=>`<div data-grp="${g}" class="row" style="gap:10px;flex-wrap:wrap;align-items:end">${fields.map(([k,l,w,ph])=>`<label>${esc(l)}<input data-sg="${g}" data-k="${k}" value="${esc((s[g]||{})[k]??"")}" placeholder="${esc(ph||"")}" style="width:${w||170}px;max-width:100%"></label>`).join("")}</div>`;
  el.innerHTML=`<div class="grid2" style="margin-top:0"><div class="panel"><h3>Project and revision</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">${inp("project_no","Project number",s.project_no,140)}${inp("revision","Revision",s.revision,70)}${inp("rev_date","Revision date",s.rev_date,120,today())}${inp("rev_note","What changed",s.rev_note,240)}</div>
      <h3 style="margin-top:12px">Building</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end"><label>Occupancy (IBC group)<input data-sd="occupancy" list="dsGroups" value="${esc(s.occupancy)}" placeholder="B, M, R-2…" style="width:140px"></label><datalist id="dsGroups">${DS_IBC_GROUPS.map(g=>`<option value="${g}">`).join("")}</datalist>
        <label>Sprinklers<select data-sd="sprinkler"><option value="">–</option>${DS_SPRINKLER.map(x=>`<option ${s.sprinkler===x?"selected":""}>${x}</option>`).join("")}</select></label>
        ${inp("sqft","Total sq ft",s.sqft,110)}${inp("above","Floors above grade",s.above,80)}${inp("below","Floors below grade",s.below,80)}</div>
      ${d.nsi?`<p class="hint" style="margin:4px 0">NSI (estimate): ${esc([d.nsi.occupancy_label, d.nsi.sqft?`${Number(d.nsi.sqft).toLocaleString()} sq ft`:"", d.nsi.year_built?`built about ${d.nsi.year_built}`:""].filter(Boolean).join(" · "))}</p>`:""}
      <div class="tw" style="margin-top:6px"><table><thead><tr><th>Floor</th><th>Construction type (IBC 602)</th></tr></thead><tbody>${floors.map(f=>`<tr><td>${esc(f.name)}</td><td><select data-ct="${esc(f.name)}" aria-label="Construction type, floor ${esc(f.name)}"><option value="">–</option>${DS_IBC_TYPES.map(t=>`<option value="${t}" ${s.floors[f.name]===t?"selected":""}>Type ${t}</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>
      ${floors.length>1?'<button id="sdCtAll" style="margin-top:6px">Same type on every floor as the first</button>':""}
      <label style="display:block;margin-top:8px">Scope of work<textarea data-sd="scope" rows="3" style="width:100%">${esc(s.scope)}</textarea></label></div>
    <div class="panel"><h3>Statement of compliance</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">${inp("fire_code","Fire code and edition",s.fire_code,260)}${inp("nfpa","NFPA 1225 edition",s.nfpa,220)}${inp("fcc","FCC rule",s.fcc,140)}${inp("local","Local standard",s.local,260,"e.g. SDFD C-1 (2025)")}</div>
      <h3 style="margin-top:12px">Designer</h3>${grp("designer","Designer",[["name","Name"],["company","Company"],["grol","FCC GROL"],["nicet","NICET IB-PSC level and number",200],["cert","Certification number"]])}
      <h3 style="margin-top:12px">Installer qualifications</h3>${grp("installer","Installer",[["company","Company"],["license","Contractor licence"],["grol","FCC GROL"],["nicet","NICET IB-PSC level and number",200],["mfr","Manufacturer certificate (maker, number)",220],["expires","Certificates expire",120]])}
      <h3 style="margin-top:12px">Isolation calculation</h3>${grp("iso","Isolation",[["fb_db","Donor antenna front-to-back dB",120,"datasheet"],["disc_db","Server antenna discrimination toward the roof dB",120,"0"],["dist_ft","Roof antenna to the nearest server antenna ft",120,"from floor height"],["roof_db","Roof slab loss dB",120,"P.1238 1 floor"]])}
      <p class="hint">Isolation ≈ free-space loss over that distance (ITU-R P.525) + roof slab loss + front-to-back − donor gain − server antenna gain toward the roof. A measured isolation (Link budget, Checks) is printed beside it and decides.</p></div></div>`;
  el.querySelectorAll("[data-sd]").forEach(i=>i.onchange=()=>keep({[i.dataset.sd]:i.value}));
  el.querySelectorAll("[data-sg]").forEach(i=>i.onchange=()=>{ const g=i.dataset.sg; keep({[g]:{...(s[g]||{}), [i.dataset.k]:i.value}}); });
  el.querySelectorAll("[data-ct]").forEach(i=>i.onchange=()=>keep({floors:{...s.floors, [i.dataset.ct]:i.value}}));
  $("#sdCtAll")?.addEventListener("click", ()=>{ const t=s.floors[floors[0].name]; if(t) keep({floors:Object.fromEntries(floors.map(f=>[f.name,t]))}); });
}
// donor to server isolation, estimated per band: free space over the distance + roof slab + the donor's front-to-back,
// less the donor's and the server antenna's gains (the server's discrimination toward the roof taken off its gain)
function dsIsolation(d, b, I, s){
  const iso=s.iso||{}, st=dsStack(d, b.band), n=v=>v===""||v==null||isNaN(+v)?null:+v;
  const dist=n(iso.dist_ft)??(st.h_ft+3/0.3048), roof=n(iso.roof_db)??(dsP1238Floor(1)?.db??9), fb=n(iso.fb_db), disc=n(iso.disc_db)??0;
  const f=Math.min(I.f_dl, I.f_ul||I.f_dl), fspl=LB.fspl(LB.ft2m(dist), f), gd=n(I.donor_gain_dbi)??0, gs=n(I.server_gain_dbi)??0;
  const est=fspl+roof+(fb??0)-gd-(gs-disc), gain=Math.max(n(I.bda_dl_gain_db)??0, n(I.bda_ul_gain_db)??0), margin=n(I.isolation_margin_db)??20, need=gain+margin;
  return {dist, roof, fb, disc, f, fspl, gd, gs, est, gain, margin, need, ok:est>=need, measured:n(I.isolation_db), roofSrc:n(iso.roof_db)!=null?"typed":"ITU-R P.1238 office 0.9 GHz, 1 floor", distSrc:n(iso.dist_ft)!=null?"typed":"floor height + a 3 m mast"};
}
// the donor path for each chosen system, from the Pre-survey's own aiming function (das.js dasAim): azimuth, distance,
// elevation angle, terrain; and an elevation view drawn from the heights it gives
function dsDonorProfileSvg(d, a, label){
  const D=a.st.dist_mi, gB=a.terrain?.ground2_m??a.real?.ground_m??0, gS=a.terrain?.ground1_m??a.real?.site_ground_m??gB;
  const yB=(a.flat?0:gB)+a.roof, yS=(a.flat?0:gS)+a.h, lo=Math.min(a.flat?0:gB, a.flat?0:gS, 0), hi=Math.max(yB, yS)*1.1+5, W=640, H=170, px=x=>40+x/D*(W-80), py=y=>H-24-(y-lo)/(hi-lo)*(H-44);
  const worst=a.terrain&&a.terrain.worst_at_km!=null?{x:D-a.terrain.worst_at_km/1.609344, up:a.terrain.worst_above_los_m}:null;
  const losAt=x=>yB+(yS-yB)*(x/D);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:640px;height:auto;color:inherit" role="img" aria-label="Donor path elevation view, ${esc(label)}">
    <line x1="${px(0)}" y1="${py(a.flat?0:gB)}" x2="${px(D)}" y2="${py(a.flat?0:gS)}" stroke="#8a6d3b" stroke-width="2"/>
    <line x1="${px(0)}" y1="${py(a.flat?0:gB)}" x2="${px(0)}" y2="${py(yB)}" stroke="currentColor" stroke-width="3"/><line x1="${px(D)}" y1="${py(a.flat?0:gS)}" x2="${px(D)}" y2="${py(yS)}" stroke="currentColor" stroke-width="3"/>
    <line x1="${px(0)}" y1="${py(yB)}" x2="${px(D)}" y2="${py(yS)}" stroke="#1f6feb" stroke-width="1.6" stroke-dasharray="6 4"/>
    ${worst&&worst.x>0&&worst.x<D?`<circle cx="${px(worst.x)}" cy="${py(losAt(worst.x)+(+worst.up||0))}" r="4" fill="#c62828"/><text x="${px(worst.x)}" y="${py(losAt(worst.x)+(+worst.up||0))-8}" text-anchor="middle" font-size="10" fill="#c62828">worst point, ${num(worst.up,0)} m ${+worst.up>=0?"above":"below"} the line</text>`:""}
    <text x="${px(0)}" y="${H-6}" font-size="10.5" fill="currentColor">Building: roof antenna ${num(a.roof,0)} m${a.flat?"":`, ground ${num(gB,0)} m`}</text>
    <text x="${px(D)}" y="${H-6}" text-anchor="end" font-size="10.5" fill="currentColor">${esc(label)}: antenna ${num(a.h,0)} m${a.flat?"":`, ground ${num(gS,0)} m`}</text>
    <text x="${W/2}" y="14" text-anchor="middle" font-size="11" fill="currentColor">${num(D,2)} mi at ${dasDeg(a.true_deg)} true${a.mag_deg!=null?` (${dasDeg(a.mag_deg)} magnetic)`:""} · elevation ${a.elev==null?"–":`${a.elev>=0?"+":""}${num(a.elev,1)}°`} · ${a.flat?"flat ground assumed":"terrain heights"}</text></svg>`;
}
async function dsDonorPaths(j, d){
  const ps=d.presurvey||{}, inc=new Set(ps.include||[]);
  if(d.lat==null||!inc.size||typeof dasAim!=="function") return null;
  const P={radius:ps.radius||15, loss:ps.loss??14, threshold:ps.threshold||DASJ.threshold||-95, env:ps.env||"suburban"};
  try{ const r=await api(`/api/das/presurvey?lat=${d.lat}&lon=${d.lon}&radius=${P.radius}&loss=${P.loss}&threshold=${P.threshold}&env=${P.env}`);
    return r.systems.filter(s=>inc.has(s.call_sign)).map(s=>[s, dasAim(d, s, r, ps)]).filter(([,a])=>a); }
  catch(e){ return null; }
}
const DS_SHEETS = [["ER-0","Cover sheet and statement of compliance"],["ER-1","Systems retransmitted and system diagram"],["ER-2","Link budget per band"],["ER-3","Link budget per antenna"],
  ["ER-4","Donor path: azimuth, distance and profile"],["ER-5","Isolation calculation"],["ER-6","Floor designs with test grids"],["ER-7","Materials attenuation, 700 / 800 MHz"],
  ["ER-8","Prediction checked against the walk"],["ER-9","Bill of materials"],["ER-10","Standby power (battery calculation)"],["ER-11","Material rules"],["ER-12","Acceptance test plan"],
  ["ER-13","Licensee consent"],["ER-14","Qualifications and sign-off"]];
window.dasSubmittal = async (el, j) => {
  await Promise.all([frLoad("budget"), frLoad("parts"), frLoad("plans")]);
  const jobFiles=new Set((await api(`/api/das/jobs/${j.id}/files`).catch(()=>({files:[]}))).files.map(f=>f.name));  // spec sheets gathered (Materials)
  const gathered=x=>jobFiles.has(`Spec sheet - ${String(x.part||x.item||"").trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g,"-").replace(/^[ .]+|[ .]+$/g,"").slice(0,120)}.pdf`);
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], bands=dsBands(d), plan=(d.presurvey||{}).plan||[], cs=S.das.contacts;
  const who=k=>cs.find(c=>String(c.id)===String((d.contacts||{})[k])), tech=who("tech"), owner=who("owner"), gc=who("gc")||who("sub");
  const worst=bands.filter(b=>!b.cell).sort((a,b)=>b.f_dl-a.f_dl)[0]||bands.slice().sort((a,b)=>b.f_dl-a.f_dl)[0];
  await dsLoadAr(j, d);
  const [pics, donor]=await Promise.all([worst?Promise.all(floors.map(f=>dsFloorPicture(j,d,f,worst))):[], dsDonorPaths(j, d)]);
  if(!el.isConnected) return;
  const s=dsSub(d), rev=s.revision||"A", revDate=s.rev_date||today();
  const P=FR.parts&&!FR.parts.empty?FR.parts:null, sheet=name=>{ if(!P) return null; const row=[...(P.cables||[]),...(P.connectors||[]),...(P.components||[])].find(x=>(x.name||x.type)===name);
    const src=row&&(P._ix||(P._ix=frSrcIndex(P)))[(row.sources||[])[0]]; return src?src.url:null; };
  const bc=dsBatteryCalc(d), T=d.testing||{}, crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])];
  const stageRows=rows=>rows.map(r=>`<tr><td>${esc(r.stage)}</td><td class="n">${r.db==null?"":(r.db>=0?"+":"")+r.db.toFixed(1)}</td><td class="n">${r.level==null||isNaN(r.level)?"–":r.level.toFixed(1)}</td></tr>`).join("");
  const f1=v=>v==null||isNaN(v)?"–":(+v).toFixed(1), sg=v=>v==null||isNaN(v)?"–":(v>0?"+":"")+(+v).toFixed(1);
  const sh=(i, extra="")=>`<div class="ds-sheet" style="break-before:${i?"page":"auto"}"><div style="display:flex;justify-content:space-between;gap:10px;border-bottom:2px solid currentColor;margin:0 0 8px;padding-bottom:2px">
    <h3 style="margin:0">${DS_SHEETS[i][0]} · ${esc(DS_SHEETS[i][1])}${extra}</h3><span class="hint" style="white-space:nowrap">${esc(j.name)} · Rev ${esc(rev)} · ${esc(revDate)}</span></div>`;
  const person=c=>c?esc([c.name, c.org, c.phone, c.email].filter(Boolean).join(", ")):"–";
  // ER-2 / ER-3 / ER-5 / ER-7 / ER-8 parts
  const lmr=bands.filter(b=>!b.cell);
  const isoRows=lmr.map(b=>{ const I=dsInputs(d,b); return {b, I, x:dsIsolation(d, b, I, s)}; });
  const matF=[["700 MHz", 770], ["800 MHz", 851]], tuneOf=band=>dsTuneOn(d, band);
  const used={}; for(const f of floors) for(const w of (((d.design||{}).floors||{})[f.name]||{}).walls||[]) used[w.label]=(used[w.label]||0)+1;
  const walkRows=lmr.map(b=>{ const I=dsInputs(d,b), R=lbCompute(I), scenes=floors.filter(f=>(((d.design||{}).floors||{})[f.name]||{}).width_ft&&f.plan).map(f=>dsScene(d, f, I, R, {band:b.band}));
    const obs=dsWalkObs(j, d, b, scenes), st=dsStats(dsCompare(obs).map(o=>o.err)); return {b, st, t:(((d.design||{}).tune)||{})[b.band], floors:[...new Set(obs.map(o=>o.floor))]}; });
  const sheets=[];
  // ER-0 cover
  sheets.push(`${sh(0)}<h2 style="margin:0 0 4px">Emergency responder communication enhancement system: design submittal</h2>
    <p style="margin:0 0 10px">${esc(j.name)} · ${esc(d.address||"")} · AHJ: ${esc(d.ahj||"not set")}${s.project_no?` · project ${esc(s.project_no)}`:""} · Rev ${esc(rev)} (${esc(revDate)}${s.rev_note?`: ${esc(s.rev_note)}`:""}) · ${esc(d.booster_class||"Class A (channelized)")}</p>
    <h4 style="margin:8px 0 4px">Building</h4><table><tbody><tr><th>Occupancy</th><td>${esc(s.occupancy||"–")}</td><th>Sprinklers</th><td>${esc(s.sprinkler||"–")}</td></tr>
      <tr><th>Area</th><td>${s.sqft?`${Number(s.sqft).toLocaleString()} sq ft`:"–"}</td><th>Floors</th><td>${esc(String(s.above??"–"))} above grade, ${esc(String(s.below??"–"))} below</td></tr>
      <tr><th>Location</th><td colspan="3">${d.lat!=null?`${num(d.lat,5)}, ${num(d.lon,5)}`:"–"}${d.nsi?.year_built?` · built about ${esc(d.nsi.year_built)} (NSI estimate)`:""}</td></tr></tbody></table>
    <table style="margin-top:6px"><thead><tr><th>Floor</th><th>Construction type (IBC 602)</th><th class="n">Server antennas</th><th class="n">Test grid squares</th></tr></thead><tbody>${floors.map((f,i)=>`<tr><td>${esc(f.name)}</td><td>${s.floors[f.name]?`Type ${esc(s.floors[f.name])}`:"–"}</td><td class="n">${((((d.design||{}).floors||{})[f.name]||{}).antennas||[]).length}</td><td class="n">${(f.grids||DAS.grids)-(f.skip||[]).length}</td></tr>`).join("")}</tbody></table>
    <h4 style="margin:10px 0 4px">Parties</h4><table><tbody><tr><th>Owner</th><td>${person(owner)}</td></tr><tr><th>Designer</th><td>${esc([s.designer.name||tech?.name, s.designer.company||tech?.org].filter(Boolean).join(", ")||"–")}</td></tr>
      <tr><th>Installer</th><td>${esc(s.installer.company||"")||person(gc)}</td></tr><tr><th>AHJ</th><td>${person(who("ahj"))||esc(d.ahj||"–")}</td></tr></tbody></table>
    <h4 style="margin:10px 0 4px">Scope of work</h4><p style="margin:0">${esc(s.scope)}</p>
    <h4 style="margin:10px 0 4px">Statement of compliance</h4><p style="margin:0">This system is designed to comply with ${esc([s.fire_code, s.nfpa, s.fcc, s.local].filter(Boolean).join("; "))}. Coverage, signal levels and DAQ follow the AHJ profile on sheet ER-12; standby power follows ${esc(bc.rule.name)} (ER-10).</p>
    <h4 style="margin:10px 0 4px">Sheet index</h4><table><thead><tr><th>Sheet</th><th>Title</th></tr></thead><tbody>${DS_SHEETS.map(([k,t])=>`<tr><td class="mono">${k}</td><td>${esc(t)}</td></tr>`).join("")}</tbody></table>`);
  // ER-1 systems and diagram
  sheets.push(`${sh(1)}${plan.length?`<table><thead><tr><th>Agency</th><th>Call sign</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Type</th></tr></thead><tbody>${plan.map(p=>`<tr><td>${esc(p.system)}</td><td class="mono">${esc(p.call_sign)}</td><td class="mono">${esc(p.downlink_mhz)}</td><td class="mono">${esc(p.uplink_mhz)}</td><td>${esc(p.technology)}</td></tr>`).join("")}</tbody></table>`:'<p>None chosen in the pre-survey.</p>'}
    <h3>System diagram: signal path, start to finish</h3>${window.dasSchematic(d)}`);
  // ER-2 link budget per band
  sheets.push(`${sh(2)}${bands.map(b=>{ const I=dsInputs(d,b), R=lbCompute(I), cap=dsCapValues(d, I); return `<div style="break-inside:avoid;margin-bottom:10px"><h4 style="margin:6px 0">${esc(b.band)} · ${b.n_ch} channel${b.n_ch===1?"":"s"}, worst case ${b.f_dl} MHz down / ${b.f_ul} MHz up</h4>
      ${cap.P?`<p class="hint" style="margin:0 0 4px">Caps: ${esc(cap.P.name)} (${esc(cap.P.src)})${cap.note?`. ${esc(cap.note)}`:""}</p>`:""}
      <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${R.checks.map(c=>`<tr><td>${esc(c.name)}</td><td><b>${c.ok==null?"open":c.ok==="warn"?"warn":c.ok?"pass":"FAIL"}</b></td><td>${esc(c.detail)}</td></tr>`).join("")}</tbody></table>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px"><table><thead><tr><th>Downlink</th><th class="n">dB</th><th class="n">dBm</th></tr></thead><tbody>${stageRows(R.dl)}</tbody></table>
        <table><thead><tr><th>Uplink</th><th class="n">dB</th><th class="n">dBm</th></tr></thead><tbody>${stageRows(R.ul)}</tbody></table></div></div>`; }).join("")||"<p>No link budget yet.</p>"}
    <p class="hint">${LB_FORMULA_NOTE}</p>`);
  // ER-3 per antenna
  sheets.push(`${sh(3, worst?` (${esc(worst.band)})`:"")}${pics.some(p=>p&&p.ants.length)?floors.map((f,i)=>{ const p=pics[i]; return p&&p.ants.length?`<h4 style="margin:6px 0">Floor ${esc(f.name)}</h4>${dsAntTable(p.ants, p.I, true)}`:""; }).join("")
      +`<p class="hint">Levels in dBm. Port: the BDA's per-channel output less each antenna's feed loss; ERP = EIRP − 2.15 dB against the cap; the weakest point is the lowest predicted level where the antenna is the strongest; the uplink is a portable there, through that antenna, to the agency's receiver.</p>`
      :'<p>No antennas placed on plans with a width yet (Design, Antennas and coverage).</p>'}`);
  // ER-4 donor path
  sheets.push(`${sh(4)}${donor&&donor.length?`<table><thead><tr><th>System</th><th>Donor site</th><th class="n">Distance</th><th class="n">Azimuth (true / magnetic)</th><th class="n">Elevation angle</th><th>Terrain</th><th>Expected at the roof</th></tr></thead><tbody>
      ${donor.map(([sy,a])=>`<tr><td><b>${esc(sy.licensee)}</b><br><span class="mono">${esc(sy.call_sign)}</span></td><td>${esc(a.st.address||"")}<br><span class="mono">${num(a.st.lat,5)}, ${num(a.st.lon,5)}</span></td>
        <td class="n">${num(a.st.dist_mi,2)} mi<br>${num(a.st.dist_mi*1.609344,2)} km</td><td class="n"><b>${dasDeg(a.true_deg)}</b> / ${dasDeg(a.mag_deg)}</td><td class="n">${a.elev==null?"–":`${a.elev>=0?"+":""}${num(a.elev,1)}°`}</td>
        <td>${a.terrain?`${esc(a.terrain.status)}; ${esc(String(a.terrain.clearance_f1))} of the first Fresnel zone clear${a.terrain.loss_db?`; −${num(a.terrain.loss_db,0)} dB`:""}`:"not checked (Terrain paths)"}</td>
        <td>${a.real?`${num(a.real.out_dbm,0)} dBm (${esc("Hata")}); free space ${num(a.st.best_out,0)}`:`${num(a.st.best_out,0)} dBm free space`}</td></tr>`).join("")}</tbody></table>
      ${donor.slice(0,4).map(([sy,a])=>`<div style="break-inside:avoid;margin-top:8px"><h4 style="margin:4px 0">${esc(sy.call_sign)}: elevation view</h4>${dsDonorProfileSvg(d, a, sy.call_sign)}</div>`).join("")}
      <p class="hint">From the Pre-survey's donor aiming: bearings from the building to the site; magnetic = true − declination (NOAA WMM2025); elevation over the earth's curve (k = 4/3). Levels are estimates from licensed power: confirm on the roof with a meter.</p>`
      :`<p>No donor paths: tick the systems on the Pre-survey (and run Terrain paths for the profile).</p>`}`);
  // ER-5 isolation
  sheets.push(`${sh(5)}${isoRows.length?`<table><thead><tr><th>Band</th><th class="n">Distance ft</th><th class="n">Free space dB</th><th class="n">Roof slab dB</th><th class="n">Front-to-back dB</th><th class="n">Donor gain dBi</th><th class="n">Server gain dBi</th><th class="n">Estimated dB</th><th class="n">Needed dB</th><th class="n">Measured dB</th><th>Result</th></tr></thead><tbody>
      ${isoRows.map(({b,x})=>`<tr><td>${esc(b.band)} (${x.f} MHz)</td><td class="n">${f1(x.dist)}</td><td class="n">${f1(x.fspl)}</td><td class="n">${f1(x.roof)}</td><td class="n">${x.fb==null?"0 (not entered)":f1(x.fb)}</td><td class="n">−${f1(x.gd)}</td><td class="n">−${f1(x.gs-x.disc)}</td>
        <td class="n"><b>${f1(x.est)}</b></td><td class="n">${f1(x.need)}<div class="hint">gain ${f1(x.gain)} + ${f1(x.margin)}</div></td><td class="n">${x.measured==null?"–":f1(x.measured)}</td><td><b>${x.measured!=null?(x.measured>=x.need?"pass (measured)":"FAIL (measured)"):x.ok?"pass (estimate)":"FAIL (estimate)"}</b></td></tr>`).join("")}</tbody></table>
      <p class="hint">Estimate = free-space loss over the distance (ITU-R P.525, at the band's lowest frequency) + roof slab (${esc(isoRows[0].x.roofSrc)}) + the donor's front-to-back − donor gain − server antenna gain toward the roof. Distance: ${esc(isoRows[0].x.distSrc)}. Needed = the larger BDA gain + the margin (Link budget, Checks). The isolation test at installation decides.</p>`:'<p>No public safety band in the link budget.</p>'}`);
  // ER-6 floors with grids
  sheets.push(`${sh(6, worst?` (${esc(worst.band)})`:"")}${floors.map((f,i)=>{ const p=pics[i]; return `<div style="break-inside:avoid;margin-bottom:12px"><h4 style="margin:6px 0">Sheet ER-6.${i+1} · Floor ${esc(f.name)}${p?.stats?`: ${p.stats.pct}% of the floor predicted at or above ${p.target} dBm`:""}</h4>
      ${p?`<img src="${p.src}" style="width:100%;max-width:720px;border:1px solid #999"><p class="hint" style="margin:2px 0">${p.antennas} server antenna${p.antennas===1?"":"s"}${p.stats?.other?` (+${p.stats.other} on other floors counted through the floor)`:""}, ${p.walls} wall${p.walls===1?"":"s"} drawn; test grid: ${p.grids} squares numbered as tested, C marks a critical area. Green ≥ ${p.target+5} dBm, amber within 5 dB of the requirement, red below it. Predicted, not measured.</p>`:'<p class="hint">No design for this floor yet.</p>'}</div>`; }).join("")}`);
  // ER-7 materials
  sheets.push(`${sh(7)}<table><thead><tr><th>Material</th>${matF.map(([l,fm])=>`<th class="n">${l} (${fm} MHz) dB</th>`).join("")}<th>Basis</th><th class="n">Walls drawn</th></tr></thead><tbody>
      ${DS_WALLS.map(([l])=>{ const w={label:l}, a=dsWallInfo(w, 770), b2=dsWallInfo(w, 851), t7=tuneOf("700 MHz")?.walls?.[l], t8=tuneOf("800 MHz")?.walls?.[l];
        return `<tr><td>${esc(l)}</td><td class="n">${f1(a.db)}${t7!=null?` <span class="hint">(tuned ${f1(t7)})</span>`:""}</td><td class="n">${f1(b2.db)}${t8!=null?` <span class="hint">(tuned ${f1(t8)})</span>`:""}</td><td>${esc(b2.how)}</td><td class="n">${used[l]||""}</td></tr>`; }).join("")}</tbody></table>
      <p class="hint">Measured losses where the research has them (NIST NISTIR 6055 for concrete, block, brick, glass and wood; Cardinal for low-E glass), else the ITU-R P.2040 model; carried across frequency by the P.2040 trend. Floors: ${esc(dsP1238Floor(1)?.src||"")} ${dsP1238Floor(1)?.db??""} dB, 2 floors ${dsP1238Floor(2)?.db??""} dB, 3 floors ${dsP1238Floor(3)?.db??""} dB.</p>`);
  // ER-8 prediction vs walk
  sheets.push(`${sh(8)}${walkRows.some(w=>w.st.n||w.t)?`<table><thead><tr><th>Band</th><th class="n">Walk readings</th><th>Floors</th><th class="n">Mean error dB</th><th class="n">Spread (SD) dB</th><th>Model</th></tr></thead><tbody>
      ${walkRows.map(w=>`<tr><td>${esc(w.b.band)}</td><td class="n">${w.st.n}</td><td>${esc(w.floors.join(", ")||"–")}</td><td class="n">${sg(w.st.mean)}</td><td class="n">${f1(w.st.sd)}</td>
        <td>${w.t&&w.t.on?`tuned to the walk (${esc(w.t.at||"")}): N ${w.t.N} (default ${w.t.N0??"–"}), ${Object.entries(w.t.walls||{}).map(([l,v])=>`${esc(l)} ${v} dB`).join(", ")||"no wall types"}${w.t.floor_db!=null?`, ${w.t.floor_db} dB a floor`:""}; before tuning mean ${sg(w.t.before?.mean)}, SD ${f1(w.t.before?.sd)} dB`:"defaults (P.1238, measured wall losses)"}</td></tr>`).join("")}</tbody></table>
      <p class="hint">Error = measured − predicted at each walk point (public safety downlink, dBm). Fit: least squares of P.1238's N, each wall type's loss and the loss a floor to this job's own readings, held toward the defaults.</p>`
      :'<p>No walk readings on floors with a design yet: the prediction has not been checked against measurements.</p>'}`);
  // ER-9 BOM
  sheets.push(`${sh(9)}${(d.bom||[]).length?`<table><thead><tr><th>Item</th><th>Part number</th><th>Supplier</th><th class="n">Qty</th><th>Spec sheet</th></tr></thead><tbody>${d.bom.map(x=>{ const u=sheet(x.item); return `<tr><td>${esc(x.item)}</td><td class="mono">${esc(x.part||"")}</td><td>${esc(x.supplier||"")}</td><td class="n">${esc(x.qty??"")} ${esc(x.unit||"")}</td><td>${gathered(x)?"attached":u?`<a href="${esc(u)}">${esc(u.replace(/^https?:\/\//,"").slice(0,50))}</a>`:""}</td></tr>`; }).join("")}</tbody></table>
      <p class="hint">${d.bom.filter(gathered).length} of ${d.bom.length} parts' spec sheets are attached (Materials, Build spec sheets; the BOM + spec sheets download).</p>`:"<p>No materials listed yet.</p>"}`);
  // ER-10 battery
  sheets.push(`${sh(10)}${bc.B.items.length?`${dsBatteryTable(bc)}<p>${dsBatterySays(bc)}</p>`:"<p>No battery calculation yet.</p>"}`);
  // ER-11 material rules
  sheets.push(`${sh(11)}${P?`<table><thead><tr><th>Rule</th><th>Code</th><th>Met</th></tr></thead><tbody>${(P.das||[]).map(x=>`<tr><td>${esc(x.topic)}: ${esc(x.requirement||"")}</td><td>${esc(x.code||"")}</td><td>${(d.material_checks||{})[`${x.topic}|${x.requirement}`]?"yes":"–"}</td></tr>`).join("")}</tbody></table>`:""}`);
  // ER-12 acceptance test plan
  sheets.push(`${sh(12)}<p>Each floor in ${DAS.grids} grid squares (floors over ${DAS.sector_sqft.toLocaleString()} sq ft in sectors), tested at the centre of each square: ≥ ${DASJ.threshold} dBm downlink and uplink with DAQ ≥ ${DASJ.daq} both ways (or SINR ≥ ${daqEq().sinr} dB with BER ≤ ${daqEq().ber}%); ${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas on each floor.
      ${crit.length?`Critical areas: ${crit.map(esc).join(", ")}.`:""} Donor-to-server isolation and oscillation checked at installation and each annual retest; all gains recorded. The test grids are drawn on each floor plan (ER-6).</p>
    <table><thead><tr><th>Floor</th><th class="n">Squares to test</th><th class="n">Critical squares</th></tr></thead><tbody>${floors.map(f=>`<tr><td>${esc(f.name)}</td><td class="n">${(f.grids||DAS.grids)-(f.skip||[]).length}</td><td class="n">${(f.critical||[]).length}</td></tr>`).join("")}</tbody></table>`);
  // ER-13 consent
  sheets.push(`${sh(13)}<p>${[...new Set(plan.map(p=>p.system))].map(esc).join("; ")||"–"}: written consent requested from each licensee before activation (47 CFR 90.219(b)(1); NFPA 1225 18.7.2).</p>`);
  // ER-14 qualifications and sign-off
  const q=(o,k)=>esc(o[k]||"")||"__________";
  sheets.push(`${sh(14)}<table><thead><tr><th></th><th>Designer</th><th>Installer</th></tr></thead><tbody>
      <tr><th>Name / company</th><td>${esc([s.designer.name||tech?.name, s.designer.company||tech?.org].filter(Boolean).join(", "))||"__________"}</td><td>${q(s.installer,"company")}</td></tr>
      <tr><th>FCC GROL</th><td>${esc(s.designer.grol||T.grol||"")||"__________"}</td><td>${q(s.installer,"grol")}</td></tr>
      <tr><th>NICET IB-PSC</th><td>${esc(s.designer.nicet||T.nicet||"")||"__________"}</td><td>${q(s.installer,"nicet")}</td></tr>
      <tr><th>Certification / licence</th><td>${q(s.designer,"cert")}</td><td>${q(s.installer,"license")}</td></tr>
      <tr><th>Manufacturer certificate</th><td>–</td><td>${q(s.installer,"mfr")}${s.installer.expires?` (expires ${esc(s.installer.expires)})`:""}</td></tr></tbody></table>
    <p style="margin-top:18px">Designer signature: ______________________ Date: ________</p><p>AHJ review: ______________________ Date: ________</p>
    ${window.dasCredits?dasCredits(d):""}</div>`);
  el.innerHTML=`<div class="maptools no-print"><div class="seg" id="drView"><button data-rv="test">Test report</button><button data-rv="submittal" class="on">Design submittal</button></div>
      <button class="primary" id="dsPrint">⎙ Print / save as PDF</button><span class="hint">Prints the submittal only, a sheet a page, with the project, revision and page number on every page. Licensee consent letters print from the Pre-survey.</span></div>
    <div class="panel" id="dasPrint" style="line-height:1.45"><style>#dasPrint td,#dasPrint th{white-space:normal;vertical-align:top}#dasPrint table{width:100%}#dasPrint tbody th{text-align:left;width:22%}</style>
      ${sheets.join("</div>")}</div>`;
  $("#drView").onclick=e=>{ const b=e.target.closest("[data-rv]"); if(b){ S.das.rview=b.dataset.rv; render(); } };
  $("#dsPrint").onclick=()=>dsPrintSubmittal(j, rev, revDate, s.project_no);
};
// print the submittal: a copy on <body> (as das.js dasPrintCopy), and while it prints, a page footer on every page with the
// project, revision and page number (CSS page-margin boxes)
function dsPrintSubmittal(j, rev, revDate, pno){
  const q=t=>`"${String(t).replace(/["\\]/g," ").replace(/[\r\n]+/g," ")}"`;
  const st=document.createElement("style"); st.id="dsPageCss";
  st.textContent=`@page{margin:14mm 12mm 16mm 12mm;@bottom-left{content:${q(`${j.name}${pno?` · project ${pno}`:""} · ERCES design submittal · Rev ${rev} (${revDate})`)};font:8pt sans-serif;color:#333}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:8pt sans-serif;color:#333}}`;
  document.head.appendChild(st);
  const el=$("#dasPrint"), box=el.cloneNode(true); el.removeAttribute("id"); box.id="dasPrint";  // as das.js dasPrintCopy
  document.body.appendChild(box); document.body.classList.add("print-das");
  const done=()=>{ document.body.classList.remove("print-das"); box.remove(); el.id="dasPrint"; st.remove(); };
  window.print();
  if(window.__dsKeepPrint) window.__dsPrintDone=done; else setTimeout(done, 600);  // __dsKeepPrint: the UI sweep saves the PDF first
}

/* ---------- battery: battery only or battery plus generator, hours from the AHJ, the 70% low-battery point, and the
   table each AHJ asks for (Colorado Springs per device; FDNY TM-ARCS-2 standby hours and full-operating minutes) ----------
   Every rule here was read in the AHJ's own document, except where `read` says otherwise. A rule leaves a figure null
   when its document doesn't state one: the code default (NFPA 1225) fills it and the page says so. */
const DS_NFPA1225 = "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download";
const DS_BATT_RULES = [  // id, name, battery-only hours, battery hours with a generator, generator hours, low-battery %, table, source, what it says
  {id:"nfpa", name:"NFPA 1225 (2022) 18.13.2 / 18.14.1.2", batt_h:12, gen_batt_h:2, gen_h:12, low_pct:70, src:DS_NFPA1225,
    says:"12 h at 100% system operation, or a 2 h battery plus a generator for 12 h; low-battery signal when 70% of the 12-hour capacity is used."},
  {id:"ifc2024", name:"IFC 2024 510.4.2.3 / 510.4.2.5", batt_h:12, gen_batt_h:null, gen_h:null, low_pct:70, src:"https://up.codes/viewer/phoenix/ifc-2024/chapter/5/fire-service-features",
    says:"12 h at 100% operation; low battery at 70% of the 12-hour operating capacity. No generator route in this text."},
  {id:"la", name:"LA County Fire V7-C3-S21 (02/02/2023)", batt_h:24, gen_batt_h:2, gen_h:24, low_pct:70, src:"https://sbc.memberclicks.net/assets/Useful_Links/2023/v7-c3-s21.pdf",
    says:"A battery for 24 h at 100%, or a generator with 24 h of fuel plus a 2 h battery; low-battery indication at 70% of the 24-hour capacity."},
  {id:"sd", name:"San Diego FD C-1 (2025)", batt_h:12, gen_batt_h:2, gen_h:12, low_pct:70, src:"https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf",
    says:"A BBU for 12 h at 100%, or a 2 h battery with the facility generator carrying the load 12 h; low-battery capacity indication at 70% of the 12-hour capacity."},
  {id:"clark", name:"Clark County / Las Vegas FPAN (12/2025)", batt_h:12, gen_batt_h:4, gen_h:null, low_pct:null, src:"https://files.lasvegasnevada.gov/fire-rescue/2025/FPAN-Guide_for_ERCES_Permitting_Testing_Recertification-Dec-2025.pdf",
    says:"Battery capacity calculations: 12 h, or 4 h with an emergency generator.", read:"from the research summary"},
  {id:"scc", name:"Santa Clara County FD C-2", batt_h:24, gen_batt_h:null, gen_h:null, low_pct:null, src:"https://www.sccfd.org/wp-content/uploads/2024/10/C-2-Emergency-Respodner-Radio-Coverage-Systems.pdf",
    says:"24 h at 100% operation.", read:"from the research summary"},
  {id:"cos", name:"Colorado Springs FD (6/30/2023)", batt_h:null, gen_batt_h:null, gen_h:null, low_pct:null, table:"cos", src:"https://coloradosprings.gov/system/files/2023-07/2021_ifc_erces_2023_final.pdf",
    says:"Battery calculations with standby and alarm current per device, model, standby and alarm time, total current, battery size and series / parallel.", read:"from the research summary"},
  {id:"fdny", name:"FDNY TM-ARCS-2", batt_h:null, gen_batt_h:null, gen_h:null, low_pct:null, table:"fdny", src:"https://www.nyc.gov/assets/fdny/downloads/pdf/business/tm-arcs-2.pdf",
    says:"Battery type, voltage and Ah; calculated capacity in standby (hours) and full operating mode (minutes); date of manufacture.", read:"from the research summary"},
];
const DS_BATT_GUESS = [[/los angeles|\bla county/i,"la"],[/san diego/i,"sd"],[/clark county|las vegas|henderson/i,"clark"],[/santa clara/i,"scc"],[/colorado springs/i,"cos"],[/fdny|new york/i,"fdny"]];
const DS_BATT_TABLES = [["", "Standard (per item, full load)"], ["cos", "Colorado Springs (standby and full-load current per device)"], ["fdny", "FDNY TM-ARCS-2 (standby hours, full-operating minutes)"]];
// the rules a job can pick: its own AHJ profile first (Requirements), then the documents above
function dsBattRules(d){
  const pr=typeof dasProfile==="function"?dasProfile(d.profile):{battery_h:12};
  return [{id:"job", name:`This job's AHJ profile${pr.profile_name?` (${pr.profile_name})`:""}`, batt_h:+pr.battery_h||12, gen_batt_h:null, gen_h:null, low_pct:null,
    src:pr.source||DS_NFPA1225, says:`${+pr.battery_h||12} h standby, from Requirements.`}, ...DS_BATT_RULES];
}
// everything the Battery view and the submittal print, from the saved battery and the job
function dsBatteryCalc(d){
  const saved=(d.design||{}).battery||{}, rules=dsBattRules(d);
  const B={volts:24, margin_pct:20, items:[], mode:"battery", cell_v:12, cell_ah:null, cell_type:"VRLA (sealed lead-acid)", made:"", ...saved};
  const guess=(DS_BATT_GUESS.find(([re])=>re.test(String(d.ahj||"")))||[])[1];
  const rule=rules.find(r=>r.id===B.rule)||rules.find(r=>r.id===guess)||rules[0], nfpa=DS_BATT_RULES[0], gen=B.mode==="generator";
  // the hours: the rule's figure for the mode; a figure the rule doesn't state comes from NFPA 1225 or the job's profile (said so)
  const own=gen?rule.gen_batt_h:rule.batt_h, ruleH=own??(gen?nfpa.gen_batt_h:(rules[0].batt_h||nfpa.batt_h));
  const hoursFrom=own!=null?rule.name:gen?`${nfpa.name}; ${rule.name} states no battery hours with a generator`:`${rules[0].name}; ${rule.name} states no hours`;
  // a job saved before 11/4 has hours and no rule: hours that differ from the rule's were typed
  const typed=!!B.hours_set||(B.rule===undefined&&saved.hours!=null&&+saved.hours!==ruleH);
  const hours=typed?+saved.hours||0:ruleH;
  const amps=x=>(+x.amps||0)||((+x.watts||0)/(+B.volts||1)), sb=x=>x.standby_a!=null&&x.standby_a!==""?+x.standby_a:amps(x);
  const items=Array.isArray(B.items)?B.items:[];
  const load=items.reduce((a,x)=>a+(+x.qty||1)*amps(x),0), standby=items.reduce((a,x)=>a+(+x.qty||1)*sb(x),0);
  const ah=load*hours*(1+(+B.margin_pct||0)/100);
  // the low-battery point: a share of the required capacity (the battery-only hours; with a generator, the battery's own hours)
  const lowPct=rule.low_pct??nfpa.low_pct, lowFrom=rule.low_pct!=null?rule.name:rule.id==="job"?nfpa.name:`${nfpa.name}; ${rule.name} states no low-battery point`;
  const capH=hours, low={pct:lowPct, cap_h:capH, h:capH*lowPct/100, ah:load*capH*lowPct/100, of:load*capH, from:lowFrom};
  // the bank: series to the system voltage, strings in parallel to the need
  const cv=+B.cell_v||12, cah=+B.cell_ah||0, series=Math.max(1,Math.round((+B.volts||cv)/cv));
  const bank=cah>0?(()=>{ const par=Math.max(1,Math.ceil(ah/cah-1e-9)), inst=par*cah; return {series, par, n:series*par, ah:inst, full_h:load?inst/load:null, standby_h:standby?inst/standby:null}; })():null;
  return {B:{...B, items}, rules, rule, gen, hours, typed, ruleH, hoursFrom, load, standby, ah, low, bank, table:B.table??rule.table??"", amps, sb};
}
// kept for older callers: {B with the hours used, load, ah}
function dsBatteryTotals(d){ const c=dsBatteryCalc(d); return {B:{...c.B, hours:c.hours}, load:c.load, ah:c.ah, calc:c}; }
const dsSrcLink = (url, label) => url?`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label||url.replace(/^https?:\/\//,"").slice(0,60))}</a>`:"";
// the table in the AHJ's own format, for the view and the submittal
function dsBatteryTable(c){
  const B=c.B, f2=v=>(+v).toFixed(2), f1=v=>(+v).toFixed(1);
  if(!B.items.length) return '<p class="hint">No equipment on the battery yet.</p>';
  if(c.table==="cos") return `<table><thead><tr><th>Device / model</th><th class="n">Qty</th><th class="n">Standby A each</th><th class="n">Standby A total</th><th class="n">Full-load A each</th><th class="n">Full-load A total</th></tr></thead><tbody>
    ${B.items.map(x=>`<tr><td>${esc(x.name)}</td><td class="n">${esc(x.qty??1)}</td><td class="n">${f2(c.sb(x))}</td><td class="n">${f2((+x.qty||1)*c.sb(x))}</td><td class="n">${f2(c.amps(x))}</td><td class="n">${f2((+x.qty||1)*c.amps(x))}</td></tr>`).join("")}
    <tr><td><b>Total current</b></td><td></td><td></td><td class="n"><b>${f2(c.standby)}</b></td><td></td><td class="n"><b>${f2(c.load)}</b></td></tr>
    <tr><td>Time</td><td></td><td></td><td class="n">${c.hours} h standby</td><td></td><td class="n">${c.hours} h at 100%</td></tr>
    <tr><td>Ampere-hours</td><td></td><td></td><td class="n">${f1(c.standby*c.hours)}</td><td></td><td class="n">${f1(c.load*c.hours)}</td></tr>
    <tr><td>With ${B.margin_pct}% margin (sized on full load)</td><td></td><td></td><td></td><td></td><td class="n"><b>${f1(c.ah)} Ah</b></td></tr>
    <tr><td>Battery size, series / parallel</td><td colspan="5">${c.bank?`${c.bank.n} × ${B.cell_v} V ${B.cell_ah} Ah: ${c.bank.series} in series × ${c.bank.par} in parallel = ${c.bank.ah} Ah at ${B.volts} V`:"pick the battery (Ah each) to size the bank"}</td></tr></tbody></table>`;
  if(c.table==="fdny") return `<table><thead><tr><th>TM-ARCS-2 item</th><th>Value</th></tr></thead><tbody>
    <tr><td>Battery type</td><td>${esc(B.cell_type||"")}</td></tr><tr><td>Voltage</td><td>${B.volts} V (${c.bank?`${c.bank.series} × ${B.cell_v} V`:`${B.cell_v} V units`})</td></tr>
    <tr><td>Capacity</td><td>${c.bank?`${c.bank.ah} Ah (${c.bank.n} × ${B.cell_ah} Ah)`:`${f1(c.ah)} Ah needed (battery not picked)`}</td></tr>
    <tr><td>Calculated capacity, standby</td><td><b>${c.bank&&c.bank.standby_h!=null?`${f1(c.bank.standby_h)} hours`:c.standby?`${f1(c.ah/c.standby)} hours`:"–"}</b> at ${f2(c.standby)} A</td></tr>
    <tr><td>Calculated capacity, full operating mode</td><td><b>${c.bank&&c.bank.full_h!=null?`${Math.round(c.bank.full_h*60)} minutes`:c.load?`${Math.round(c.ah/c.load*60)} minutes`:"–"}</b> at ${f2(c.load)} A</td></tr>
    <tr><td>Date of manufacture</td><td>${esc(B.made||"__________")}</td></tr></tbody></table>
    <p class="hint">Capacity ÷ current, no derate${c.bank?"":", at the Ah needed (no battery picked)"}. Each battery marked with its date of manufacture.</p>`;
  return `<table><thead><tr><th>Equipment</th><th class="n">Qty</th><th class="n">Amps</th></tr></thead><tbody>${B.items.map(x=>`<tr><td>${esc(x.name)}</td><td class="n">${esc(x.qty??1)}</td><td class="n">${f2((+x.qty||1)*c.amps(x))}</td></tr>`).join("")}</tbody></table>`;
}
// the statement: mode, hours and where they came from, the need, the low-battery point, the rule's source
function dsBatterySays(c){
  const B=c.B;
  return `${c.gen?"Battery plus generator":"Battery only"}: full load ${c.load.toFixed(2)} A at ${B.volts} V for ${c.hours} h with ${B.margin_pct}% margin = <b>${c.ah.toFixed(1)} Ah</b>`
    + `${c.typed?` (hours typed for this job; the rule says ${c.ruleH} h)`:` (hours: ${esc(c.hoursFrom)})`}. `
    + `${c.gen&&c.rule.gen_h?`The generator carries the load ${c.rule.gen_h} h. `:""}`
    + `Low-battery signal when ${c.low.pct}% of the ${c.low.cap_h} h capacity is used: after ${c.low.h.toFixed(1)} h at full load, ${c.low.ah.toFixed(1)} of ${c.low.of.toFixed(1)} Ah (${esc(c.low.from)}). `
    + `Rule: ${dsSrcLink(c.rule.src, c.rule.name)}${c.rule.read?` (${esc(c.rule.read)})`:""}. Battery in a NEMA 3R or better cabinet (NFPA 1225 18.13.2).`;
}
async function dsBattery(el, j, save){
  const d=j.data||{}, c=dsBatteryCalc(d), B=c.B;
  const keep=async patch=>{ await save({design:{...(d.design||{}), battery:{...((d.design||{}).battery||{}), ...B, rule:c.rule.id, hours_set:c.typed, hours:c.typed?c.hours:null, ...patch}}}); render(); };
  el.innerHTML=`<div class="grid2" style="margin-top:0"><div class="panel"><h3>Battery sizing</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end">
        <label>Rule <select id="btRule" style="max-width:300px">${c.rules.map(r=>`<option value="${r.id}" ${r.id===c.rule.id?"selected":""}>${esc(r.name)}</option>`).join("")}</select></label>
        <div class="seg" id="btMode"><button data-m="battery" class="${c.gen?"":"on"}">Battery only</button><button data-m="generator" class="${c.gen?"on":""}">Battery plus generator</button></div></div>
      <p class="hint" style="margin:6px 0">${esc(c.rule.says)} ${dsSrcLink(c.rule.src, "Source")}${c.rule.read?` · ${esc(c.rule.read)}`:""}</p>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end"><label>System voltage<input id="btV" type="number" step="any" value="${B.volts}" style="width:90px"></label>
        <label title="From the rule until you type one">Hours at full load<input id="btH" type="number" step="any" value="${c.hours}" style="width:90px"></label>${c.typed?`<button id="btHr" title="Back to the rule's hours">Use the rule's ${c.ruleH} h</button>`:""}
        <label>Safety margin %<input id="btM" type="number" step="any" value="${B.margin_pct}" style="width:90px"></label></div>
      <div class="tw" style="margin-top:8px"><table><thead><tr><th>Equipment</th><th class="n">Qty</th><th class="n">Amps each</th><th class="n">or watts</th><th class="n" title="Idle current; blank = full load (NFPA 1225 sizes on 100% operation)">Standby A</th><th class="n">Amps</th><th></th></tr></thead><tbody>
        ${B.items.map((x,i)=>`<tr><td>${esc(x.name)}</td><td class="n">${esc(x.qty??1)}</td><td class="n">${esc(x.amps??"")}</td><td class="n">${esc(x.watts??"")}</td><td class="n"><input data-sba="${i}" type="number" step="any" value="${x.standby_a??""}" placeholder="${c.amps(x).toFixed(2)}" style="width:70px" aria-label="Standby amps, ${esc(x.name)}"></td><td class="n">${((+x.qty||1)*c.amps(x)).toFixed(2)}</td><td><button data-rmb="${i}" aria-label="Remove ${esc(x.name)}">✕</button></td></tr>`).join("")
          ||'<tr><td colspan="7" class="hint">Add the BDA, fiber remotes, the annunciator and anything else on the battery (from each datasheet\'s full-load current).</td></tr>'}</tbody></table></div>
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:end;margin-top:6px"><label class="grow">Equipment<input id="btN" placeholder="BDA (model)"></label><label>Qty<input id="btQ" type="number" value="1" style="width:60px"></label>
        <label>Amps<input id="btA" type="number" step="any" style="width:80px"></label><label>or watts<input id="btW" type="number" step="any" style="width:80px"></label><button class="primary" id="btAdd">Add</button></div>
      <h3 style="margin-top:12px">The battery</h3>
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:end"><label>Type<input id="btT" value="${esc(B.cell_type||"")}" style="width:180px"></label>
        <label>Volts each<input id="btCv" type="number" step="any" value="${B.cell_v}" style="width:80px"></label><label>Ah each<input id="btCa" type="number" step="any" value="${B.cell_ah??""}" placeholder="datasheet" style="width:100px"></label>
        <label>Made<input id="btMd" value="${esc(B.made||"")}" placeholder="date" style="width:110px"></label></div></div>
    <div class="panel"><h3>Needed</h3><div class="kvg"><div>Full load</div><div>${c.load.toFixed(2)} A at ${B.volts} V (${(c.load*B.volts).toFixed(0)} W)</div>
      <div>For ${c.hours} h</div><div>${(c.load*c.hours).toFixed(1)} Ah</div><div>With ${B.margin_pct}% margin</div><div><b style="font-size:20px" id="btAh">${c.ah.toFixed(1)} Ah</b> at ${B.volts} V</div>
      <div>Low-battery signal</div><div id="btLow">after <b>${c.low.h.toFixed(1)} h</b> at full load (${c.low.pct}% of ${c.low.of.toFixed(1)} Ah used)</div>
      ${c.bank?`<div>Bank</div><div id="btBank">${c.bank.n} × ${B.cell_v} V ${B.cell_ah} Ah: ${c.bank.series} in series × ${c.bank.par} in parallel = <b>${c.bank.ah} Ah</b>${c.bank.full_h!=null?`, ${c.bank.full_h.toFixed(1)} h at full load`:""}</div>`:""}</div>
      <p style="margin:8px 0 4px" id="btSays">${dsBatterySays(c)}</p>
      <label class="inl" style="margin-top:6px">Table for the submittal <select id="btTab">${DS_BATT_TABLES.map(([k,l])=>`<option value="${k}" ${c.table===k?"selected":""}>${esc(l)}</option>`).join("")}</select></label>
      <div class="tw" id="btTable" style="margin-top:6px">${dsBatteryTable(c)}</div>
      <p class="hint" style="margin-top:8px">The 20% margin is the fire alarm rule (NFPA 72, 10.6.7.2.1.1 in the 2019 edition) that ERCES work commonly follows; NFPA 1225 states none.
        ${dsSrcLink(DS_NFPA1225, "NFPA 1225 ch. 18")} · ${dsSrcLink("https://www.firealarmguy.net/resources/downloads/FA_Battery_Calculation_Guide.pdf", "battery calculation guide (NFPA 72-2019 sections)")}</p></div></div>`;
  $("#btRule").onchange=e=>keep({rule:e.target.value, hours_set:false, hours:null});
  $("#btMode").onclick=e=>{ const b=e.target.closest("[data-m]"); if(b) keep({mode:b.dataset.m, hours_set:false, hours:null}); };
  $("#btV").onchange=e=>keep({volts:+e.target.value});
  $("#btM").onchange=e=>keep({margin_pct:+e.target.value});
  $("#btH").onchange=e=>keep({hours:+e.target.value, hours_set:true});
  $("#btHr")?.addEventListener("click", ()=>keep({hours_set:false, hours:null}));
  $("#btTab").onchange=e=>keep({table:e.target.value});
  [["#btT","cell_type",0],["#btCv","cell_v",1],["#btCa","cell_ah",1],["#btMd","made",0]].forEach(([s,k,isNum])=>$(s).onchange=e=>keep({[k]:isNum?(e.target.value===""?null:+e.target.value):e.target.value}));
  $("#btAdd").onclick=()=>{ if(!$("#btN").value.trim()) return; keep({items:[...B.items, {name:$("#btN").value.trim(), qty:+$("#btQ").value||1, amps:$("#btA").value===""?null:+$("#btA").value, watts:$("#btW").value===""?null:+$("#btW").value}]}); };
  el.querySelectorAll("[data-sba]").forEach(x=>x.onchange=()=>keep({items:B.items.map((it,i)=>i===+x.dataset.sba?{...it, standby_a:x.value===""?null:+x.value}:it)}));
  el.querySelectorAll("[data-rmb]").forEach(x=>x.onclick=()=>keep({items:B.items.filter((_,i)=>i!==+x.dataset.rmb)}));
}
