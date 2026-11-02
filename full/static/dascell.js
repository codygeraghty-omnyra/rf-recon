"use strict";
/* RF Recon — the commercial cellular side of a DAS job (the "mobile survey"), from the cited research in
   docs/research/DAS-Cellular (checked 2026-11-02): a cellular profile for the grid test (RSRP / SINR targets per carrier),
   the carriers at the building (FCC Broadband Map, cell sites, a rooftop donor table), an approvals tracker with consent
   letters under 47 CFR 20.21(c), a report section, and the LTE / 5G bands for the link budget (dasdesign.js).
   Cellular readings never count toward the public-safety score (das.js). */

// Targets from owner specs, RFPs and vendor guidance. No US carrier publishes one: the carrier's own numbers win.
const CELL_PRESETS = {
  common: {name:"Common", rsrp:-95, rsrp_hi:-100, sinr:5, pct:95,
    src:"Owner specs and RFPs cluster at RSRP −95 dBm over 95% for LTE and −100 to −105 dBm for C-band; SINR runs 5–10 dB in US documents. Guidance, not a carrier spec."},
  cooper: {name:"Cooper University Health (2026)", rsrp:-95, rsrp_hi:-100, hi_by:{"AT&T":-100, "Verizon":-105, "T-Mobile":-100}, sinr:null, pct:95, carriers:["AT&T","Verizon","T-Mobile"],
    src:"Cooper spec 27 53 19 (4 Feb 2026), Table 2: LTE 1900 and 2100 at −95 dBm RSRP for AT&T, Verizon and T-Mobile; C-band −100 dBm for AT&T (80 MHz), −105 dBm for Verizon (100 MHz) and −100 dBm for T-Mobile (40 MHz); 95% of the area each; no SINR target. Each band must meet it on its own, while the grid judges a carrier's best cell below 3.3 GHz, so check 1900 and 2100 apart in a square's readings."},
  pvd_normal: {name:"Providence RFP, normal mode (2026)", rsrp:-85, rsrp_hi:-85, sinr:10, pct:95, carriers:["Verizon"],
    src:"Providence Water RFP PVD26-53 §3.6, normal mode: Verizon RSRP ≥ −85 dBm on ≥ 95% of each area, SINR ≥ 10 dB where signal is present."},
  pvd_failover: {name:"Providence RFP, failover (2026)", rsrp:-95, rsrp_hi:-95, sinr:5, pct:90,
    src:"Providence Water RFP PVD26-53 §3.6, failover (off-air booster, all carriers): RSRP ≥ −95 dBm on ≥ 90%, SINR ≥ 5 dB."},
  solid: {name:"SOLiD rule of thumb", rsrp:-95, rsrp_hi:-95, sinr:8, pct:95,
    src:"SOLiD: “a widely accepted minimum is −95 dBm RSRP over 95% of the area”, SNIR 8 dB over 95%. Vendor guidance."},
  mcf: {name:"MCF (Australia, not US)", rsrp:-95, rsrp_hi:-100, sinr:15, pct:95,
    src:"Australian carriers' MCF DAS spec (2023 draft): RSRP ≥ −95 dBm at 700–2600 MHz and ≥ −100 dBm at 3300–3800 MHz, SINR 15 dB, 95%. Not binding in the US."},
};
const CELL_CARRIERS = ["AT&T", "Verizon", "T-Mobile", "FirstNet", "UScellular", "Dish / Boost"];
// one name per carrier, whatever a tool calls it (the same rule as das.py carrier_name)
function carrierName(s){ const t=String(s??"").trim();
  for(const [re,n] of [[/first\s*net/i,"FirstNet"],[/t-?\s?mobile|sprint/i,"T-Mobile"],[/verizon/i,"Verizon"],[/at&t|\batt\b|cingular/i,"AT&T"],[/us\s?cellular/i,"UScellular"],[/dish|boost|echostar/i,"Dish / Boost"]]) if(re.test(t)) return n;
  return t||"Unknown carrier"; }
// a reading's frequency layer: from 3.3 GHz (C-band, 3.45 GHz, CBRS) or below. From its downlink MHz or band; an LTE EARFCN
// alone isn't read as MHz (B14's 5330 would look like 5.3 GHz), except CBRS (B48: 55240-56739); a 5G NR-ARFCN is converted
const nrMhz = n => n<600000 ? n*0.005 : 3000+0.015*(n-600000);
function cellMhz(x){ if(has(x.mhz)&&isFinite(+x.mhz)) return +x.mhz; const ch=+x.freq;
  if(!isFinite(ch)) return null; if(ch>=100000&&/NR|5G/i.test(String(x.tech||""))) return nrMhz(ch); if(ch>=55240&&ch<=56739) return 3550+(ch-55240)/10; return null; }
const layerOf = x => { const b=String(x.band??"").trim(), f=cellMhz(x); return /^(n|b)?(77|78|48)$/i.test(b)||(f!=null&&f>=3300)?"hi":"lo"; };
const LAYER_NAME = {lo:"below 3.3 GHz", hi:"3.3 GHz and up (C-band, CBRS)"};

/* ---------- the profile ---------- */
function cellProfile(d){ const p=(d.cellular||{}).profile||{}, base=CELL_PRESETS[p.preset]||CELL_PRESETS.common;
  return {...base, ...p, preset:p.preset||"common", name:p.preset==="custom"?"Custom":base.name}; }
const cellThr = (P, carrier, layer) => layer==="hi" ? (P.hi_by?.[carrier] ?? P.rsrp_hi ?? P.rsrp) : P.rsrp;
const cellRequired = (P, carrier) => !P.carriers || !P.carriers.length || P.carriers.includes(carrier);
// every carrier and layer the job's grid has readings for: [{key, carrier, layer, label, required}]
function cellLayers(d){ const P=cellProfile(d), seen=new Map();
  for(const r of Object.values((d.grid||{}).results||{})) for(const x of readingsOf(r)) if(isCell(x)&&has(x.rsrp)){
    const c=carrierName(x.carrier), l=layerOf(x), k=`${c}|${l}`; if(!seen.has(k)) seen.set(k, {key:k, carrier:c, layer:l, label:`${c}, ${LAYER_NAME[l]}`, required:cellRequired(P, c)}); }
  return [...seen.values()].sort((a,b)=>a.carrier.localeCompare(b.carrier)||a.layer.localeCompare(b.layer)); }
// one square for one carrier and layer: null when the square has no cellular reading at all; the carrier's best cell decides
// (a phone uses the strongest one). SINR counts when the target is set and the reading has it.
function cellSquare(d, raw, key){ const rs=readingsOf(raw).filter(x=>isCell(x)); if(!rs.length) return null;
  const P=cellProfile(d), [carrier, layer]=key.split("|"), thr=cellThr(P, carrier, layer);
  const mine=rs.filter(x=>carrierName(x.carrier)===carrier&&layerOf(x)===layer&&has(x.rsrp));
  if(!mine.length) return {pass:false, best:null, thr, why:`no ${carrier} signal ${LAYER_NAME[layer]} here`};
  const best=mine.reduce((a,b)=>+b.rsrp>+a.rsrp?b:a), sinrOk=P.sinr==null||!has(best.sinr)||+best.sinr>=P.sinr;
  return {pass:+best.rsrp>=thr&&sinrOk, best, thr, noSinr:P.sinr!=null&&!has(best.sinr),
    why:`best ${best.rsrp} dBm RSRP${has(best.sinr)?`, SINR ${best.sinr} dB`:""}${has(best.pci)?` (PCI ${best.pci}${has(best.band)?`, band ${best.band}`:""})`:""} vs ≥ ${thr} dBm${P.sinr!=null?`, SINR ≥ ${P.sinr} dB`:""}`}; }
function cellFloor(d, f, key){ const res=(d.grid||{}).results||{}, skip=new Set(f.skip||[]), n=f.grids||DAS.grids, o={tested:0, pass:0, untested:0, noSinr:0};
  for(let g=1; g<=n; g++){ if(skip.has(g)) continue; const s=cellSquare(d, res[`${f.name}|${g}`], key);
    if(!s){ o.untested++; continue; } o.tested++; if(s.pass) o.pass++; if(s.noSinr) o.noSinr++; }
  o.pct=o.tested?Math.round(100*o.pass/o.tested):0; o.ok=o.tested>0&&o.pct>=cellProfile(d).pct; return o; }

/* ---------- Requirements: the cellular targets ---------- */
window.dasCellRequire = (el, j, save) => {
  const d=j.data||{}, P=cellProfile(d), mine=(d.cellular||{}).profile||{}, found=[...new Set(cellLayers(d).map(x=>x.carrier))];
  const carriers=[...new Set([...CELL_CARRIERS, ...found])], req=new Set(P.carriers||[]);
  el.innerHTML=`<div class="panel"><h3>Cellular coverage (commercial DAS) <span class="hint">· scored on the Grid test per carrier; never part of the public-safety result</span></h3>
    <div class="row" style="margin-bottom:6px;flex-wrap:wrap">${Object.entries(CELL_PRESETS).map(([k,p])=>`<button data-cp="${k}" class="${P.preset===k?"on":""}">${esc(p.name)}</button>`).join("")}</div>
    <div class="row" style="flex-wrap:wrap"><label>RSRP ≥ dBm<input id="cp_rsrp" type="number" value="${P.rsrp}" style="width:72px"></label>
      <label title="5G at 3.3 GHz and up: C-band, 3.45 GHz, CBRS">From 3.3 GHz ≥ dBm<input id="cp_rsrp_hi" type="number" value="${P.rsrp_hi??""}" placeholder="same" style="width:72px"></label>
      <label>SINR ≥ dB<input id="cp_sinr" type="number" step="0.5" value="${P.sinr??""}" placeholder="not judged" style="width:84px"></label>
      <label>Coverage %<input id="cp_pct" type="number" value="${P.pct}" style="width:64px"></label></div>
    <div style="margin-top:6px"><span class="hint">Carriers that must pass (none ticked: every carrier found):</span> ${carriers.map(c=>`<label class="inl" style="margin-right:10px"><input type="checkbox" data-cc="${esc(c)}" ${req.has(c)?"checked":""}> ${esc(c)}</label>`).join("")}</div>
    <p class="hint" style="margin-bottom:0">${esc(P.preset==="custom"?"Your own numbers.":P.src)}${P.hi_by?` Per carrier from 3.3 GHz: ${esc(Object.entries(P.hi_by).map(([c,v])=>`${c} ${v} dBm`).join(", "))}.`:""}
      No US carrier publishes an in-building spec: when a carrier gives you its numbers, enter them here; they win. RSRP is one reference signal (a 15 or 30 kHz subcarrier); an older spec's “RSL” or “signal strength” is a different measure, so don't enter it as RSRP.
      A square passes for a carrier when its best cell meets the target; a square with cellular readings but none from that carrier fails for it. Research: docs › research › DAS-Cellular (checked 2026-11-02).</p></div>`;
  const keep=async p=>{ j=await save({cellular:{...(j.data.cellular||{}), profile:p}}); render(); };
  el.querySelectorAll("[data-cp]").forEach(b=>b.onclick=()=>{ const p=CELL_PRESETS[b.dataset.cp]; keep({preset:b.dataset.cp, rsrp:p.rsrp, rsrp_hi:p.rsrp_hi, sinr:p.sinr, pct:p.pct, hi_by:p.hi_by||null, carriers:p.carriers||null}); });
  const num2=id=>$(id).value===""?null:+$(id).value;
  for(const id of ["#cp_rsrp","#cp_rsrp_hi","#cp_sinr","#cp_pct"]) $(id).onchange=()=>keep({...mine, preset:"custom", rsrp:num2("#cp_rsrp")??-95, rsrp_hi:num2("#cp_rsrp_hi"), sinr:num2("#cp_sinr"), pct:num2("#cp_pct")??95,
    hi_by:id==="#cp_rsrp_hi"?null:(mine.hi_by??P.hi_by??null), carriers:P.carriers||null});
  el.querySelectorAll("[data-cc]").forEach(c=>c.onchange=()=>{ const s=new Set(P.carriers||[]); c.checked?s.add(c.dataset.cc):s.delete(c.dataset.cc); keep({...P, preset:P.preset, carriers:[...s]}); });
};

/* ---------- Pre-survey: the carriers at the building, the rooftop donor, approvals ---------- */
// the donor check from the Providence RFP §3.9 (the only published one): design target −85 dBm with SINR 5 dB; minimum −95 dBm with SINR 0 dB
const DONOR = {target:-85, target_sinr:5, min:-95, min_sinr:0};
const donorVerdict = r => !r||!has(r.rsrp) ? null : (+r.rsrp>=DONOR.target&&(!has(r.sinr)||+r.sinr>=DONOR.target_sinr)) ? "target" : (+r.rsrp>=DONOR.min&&(!has(r.sinr)||+r.sinr>=DONOR.min_sinr)) ? "minimum" : "below";
// bands a consumer booster may not carry (DAS-Cellular follow-up, 2026-11-02): not in 47 CFR 20.21(e)(3) (eCFR current to
// 29 Oct 2026, unchanged since 2018; the FCC never adopted its 2018 proposal for 600 MHz, WCS and 2.5 GHz) nor in the
// consumer table of FCC KDB 935210 D02 (Nov 2024). [pattern, name, what else applies]
const NOT_CONSUMER = [[/^(b|n)?71$/i,"600 MHz (B71)",""],[/^(b|n)?30$/i,"WCS (B30)","AT&T told the FCC it does not intend to consent to industrial boosters in WCS either (31 Jan 2019)"],
  [/^(b|n)?41$/i,"2.5 GHz (B41 / n41)","FCC 13-21 refused it for consumer boosters"],[/^(b|n)?48$/i,"CBRS (B48 / n48)","above 23 dBm EIRP per 10 MHz a CBRS booster counts as a CBSD and must register with a SAS"],
  [/^(b|n)?(77|78)$/i,"C-band / 3.45 GHz (n77)",""],[/^(b|n)?70$/i,"AWS-4 (B70)",""]];
// how each carrier takes a consent request, as far as the research found (public sources only)
const CARRIER_ASK = {
  "T-Mobile": "Industrial: T-Mobile's “In-Building Telecommunications Agreement” (Rebroadcast Agreement) with Exhibit A (site: county and FIPS code, address, coordinates; booster: FCC ID, bands, UARFCN, EIRP, gain, noise, antenna height, protections), emailed to rebroadcastagreements@t-mobile.com; review takes several weeks. Found only on reseller and Wilson pages (form saved 2020): confirm with T-Mobile before relying on it.",
  "AT&T": "No public industrial consent form: att.com/das or your AT&T representative, usually for a carrier-fed DAS (an AT&T signal source took 9+ months in 2022). AT&T has said it won't consent to industrial boosters in WCS.",
  "Verizon": "No public industrial consent form: your Verizon account manager.",
  "FirstNet": "No public consent form: your AT&T / FirstNet representative. Band 14 is Part 90 spectrum: FirstNet / AT&T written authorization (90.219); a Class B booster is registered with the FCC.",
};
const APPROVAL_PATHS = [["industrial","Industrial booster or off-air DAS: the carrier's express consent (47 CFR 20.21(c))"],["consumer","Consumer booster: register it with the carrier (20.21(a)(2), (h))"],
  ["carrier","Carrier-fed DAS (base station or small cell): carrier agreement, design review, carrier acceptance test"]];
window.dasCellPresurvey = async (el, j, save) => {
  const d=j.data||{}, C=d.cellular||{}, donor=C.donor||{}, appr=C.approvals||{};
  el.innerHTML='<div class="panel"><h3>Cellular carriers at the building</h3><p class="hint">Looking up carrier coverage and cell sites…</p></div>';
  const [cov, cs]=await Promise.all([api(`/api/bdc/at?lat=${d.lat}&lon=${d.lon}`).catch(()=>({carriers:[], loaded:false})),
    api(`/api/cells?lat=${d.lat}&lon=${d.lon}&radius=1`).catch(()=>({sites:[]}))]);
  if(!el.isConnected) return;
  const by=new Map(), row=c=>{ const k=carrierName(c); if(!by.has(k)) by.set(k, {carrier:k, cov:[], sites:[], bands:new Set()}); return by.get(k); };
  for(const c of CELL_CARRIERS.slice(0,4)) row(c);
  for(const c of cov.carriers||[]) row(c.brand).cov.push(c);
  for(const s of cs.sites||[]) row(s.operator).sites.push(s);
  for(const r of Object.values((d.grid||{}).results||{})) for(const x of readingsOf(r)) if(isCell(x)&&has(x.band)) row(x.carrier).bands.add(String(x.band));
  const list=[...by.values()], measured=list.flatMap(x=>[...x.bands]);
  const flagged=NOT_CONSUMER.filter(([re])=>measured.some(b=>re.test(b))), b66=measured.some(b=>/^(b|n)?66$/i.test(b));
  const vtxt={target:"meets the −85 dBm target", minimum:"meets the −95 dBm minimum only", below:"below the −95 dBm minimum"}, vcol={target:"var(--good)", minimum:"var(--warn)", below:"var(--bad)"};
  el.innerHTML=`<div class="panel"><h3>Cellular carriers at the building <span class="hint">· commercial DAS: what each carrier has here, its signal at the roof, and its approval</span></h3>
    <div class="tw wrap"><table><thead><tr><th>Carrier</th><th>FCC Broadband Map (modelled)</th><th>Cell sites within 1 mi</th><th>Rooftop donor (measured)</th><th>Approval</th><th></th></tr></thead><tbody>
    ${list.map(x=>{ const dn=donor[x.carrier]||{}, v=donorVerdict(dn), a=appr[x.carrier]||{}, near=x.sites[0];
      return `<tr data-car="${esc(x.carrier)}"><td><b>${esc(x.carrier)}</b>${x.bands.size?`<div class="hint">bands measured: ${esc([...x.bands].join(", "))}</div>`:""}</td>
        <td>${x.cov.length?x.cov.map(c=>`${esc(c.tech)}${c.signal!=null?` · ${c.signal} dBm`:""}`).join("<br>"):`<span class="hint">${cov.loaded?"none reported here":"not loaded"}</span>`}</td>
        <td>${x.sites.length?`${x.sites.length} · nearest ${num(near.dist_mi,2)} mi`:'<span class="hint">none known</span>'}</td>
        <td><div class="row" style="gap:4px;flex-wrap:wrap"><input data-dn="rsrp" type="number" placeholder="RSRP" value="${dn.rsrp??""}" style="width:70px"><input data-dn="sinr" type="number" step="0.5" placeholder="SINR" value="${dn.sinr??""}" style="width:62px">
          <input data-dn="band" placeholder="band" value="${esc(dn.band??"")}" style="width:56px"><input data-dn="az" type="number" placeholder="az °" value="${dn.az??""}" style="width:60px"><input data-dn="height_ft" type="number" placeholder="ft" value="${dn.height_ft??""}" style="width:54px"></div>
          ${v?`<span style="color:${vcol[v]}">${vtxt[v]}</span>`:'<span class="hint">RSRP dBm, SINR dB, band, azimuth, antenna height</span>'}</td>
        <td><select data-ap="path" style="max-width:190px"><option value="">— path —</option>${APPROVAL_PATHS.map(([k,l])=>`<option value="${k}" ${a.path===k?"selected":""} title="${esc(l)}">${esc(l.split(":")[0])}</option>`).join("")}</select>
          <div class="row" style="gap:4px;margin-top:3px;flex-wrap:wrap"><label class="inl hint">asked <input data-ap="asked" type="date" value="${esc(a.asked||"")}"></label><label class="inl hint">consent <input data-ap="consent" type="date" value="${esc(a.consent||"")}"></label></div>
          <input data-ap="contact" placeholder="contact, reference or bands consented" value="${esc(a.contact||"")}" style="width:100%;margin-top:3px">
          ${CARRIER_ASK[x.carrier]?`<div class="hint" style="margin-top:3px">${esc(CARRIER_ASK[x.carrier])}</div>`:""}</td>
        <td><button data-let="${esc(x.carrier)}" title="A letter asking this carrier's express consent to retransmit its bands (47 CFR 20.21(c)); print or save as PDF">⎙ Consent letter</button></td></tr>`; }).join("")}</tbody></table></div>
    ${flagged.length?`<p class="status err" style="margin:8px 0 0">Measured here: ${esc(flagged.map(([,n])=>n).join(", "))}. A consumer booster may not carry these: 47 CFR 20.21(e)(3) lists only Cellular, PCS, AWS-1, Lower 700 A–E, Upper 700 C and SMR (current as of 29 Oct 2026, unchanged since 2018; the FCC never adopted its 2018 proposal to add 600 MHz, WCS and 2.5 GHz), and FCC KDB 935210 D02 (Nov 2024) has none of them for consumer boosters.
      Plan an industrial booster with each carrier's express consent, a carrier-fed source, or the carrier's own small cell.${flagged.filter(f=>f[2]).map(([,n,w])=>` ${esc(n)}: ${esc(w)}.`).join("")}</p>`:""}
    ${b66?'<p class="hint" style="margin:6px 0 0">B66 measured: a consumer booster may carry only its AWS-1 part (1710–1755 / 2110–2155 MHz); its AWS-3 part needs an industrial booster (KDB 935210 D02).</p>':""}
    <p class="hint" style="margin-bottom:0">Donor check from the Providence RFP §3.9, the only published one: design target −85 dBm RSRP with SINR ≥ 5 dB on at least one band per carrier; minimum −95 dBm with SINR ≥ 0 dB, and nothing ordered until the donor is confirmed.
      The FCC keeps no registration for commercial boosters (its signal booster database is for Part 90 Class B). Of the carriers, only T-Mobile's consent form has turned up (on reseller pages); otherwise consent is “a letter, email or other record” from the carrier naming the bands it lets you retransmit (FCC 13-21 ¶112), and the letter here asks for exactly that.
      Carrier coverage is what each carrier tells the FCC (Data &amp; updates: FCC carrier coverage); cell sites are crowd and survey data (Cell sites tab).</p></div>`;
  const keep=async patch=>{ j=await save({cellular:{...(j.data.cellular||{}), ...patch}}); };
  el.querySelectorAll("[data-dn]").forEach(i=>i.onchange=async()=>{ const car=i.closest("tr").dataset.car, all={...((j.data.cellular||{}).donor||{})}, x={...(all[car]||{})};
    x[i.dataset.dn]=i.value===""?null:i.type==="number"?+i.value:i.value; x.at=today(); all[car]=x; await keep({donor:all}); window.dasCellPresurvey(el, j, save); });
  el.querySelectorAll("[data-ap]").forEach(i=>i.onchange=async()=>{ const car=i.closest("tr").dataset.car, all={...((j.data.cellular||{}).approvals||{})};
    all[car]={...(all[car]||{}), [i.dataset.ap]:i.value||null}; await keep({approvals:all}); });
  el.querySelectorAll("[data-let]").forEach(b=>b.onclick=()=>dasCellConsent(j, b.dataset.let));
};

/* ---------- consent letter: 47 CFR 20.21(c), what carriers ask for (Providence RFP §3.12) ---------- */
function dasCellConsent(j, carrier){
  const d=j.data||{}, cs=S.das.contacts, me=cs.find(c=>String(c.id)===String((d.contacts||{}).tech)), dn=((d.cellular||{}).donor||{})[carrier]||{};
  const bands=new Set(); for(const r of Object.values((d.grid||{}).results||{})) for(const x of readingsOf(r)) if(isCell(x)&&carrierName(x.carrier)===carrier&&has(x.band)) bands.add(String(x.band));
  for(const id of (d.design||{}).cell_bands||[]){ const b=DAS_LTE_BANDS.find(x=>x.id===id); if(b&&b.carriers.toLowerCase().includes(carrier.toLowerCase())) bands.add(b.label); }  // the link budget's bands
  const blank="______________";
  const box=document.createElement("div"); box.id="dasPrint"; box.className="panel";
  box.innerHTML=`<div style="padding:24px 8px;font-size:14px;line-height:1.5">
    <p>${esc(today())}</p><p><b>${esc(carrier)}</b><br>In-building / signal booster consent</p>
    <p><b>Re: Request for express consent to retransmit under 47 CFR 20.21(c): ${esc(j.name)}, ${esc(d.address||"")}</b></p>
    <p>We plan to install an industrial signal booster (distributed antenna system) at the building above to improve ${esc(carrier)} coverage inside it. Under 47 CFR 20.21(c), an industrial booster may operate only with the express consent of the licensee whose frequencies it retransmits. We ask for that consent.</p>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4"><tbody>
      <tr><td>Location</td><td>${esc(d.address||"")}${d.lat!=null?` (${(+d.lat).toFixed(5)}, ${(+d.lon).toFixed(5)})`:""}</td></tr>
      <tr><td>County and county FIPS code</td><td>${blank}</td></tr>
      <tr><td>Bands to retransmit</td><td>${bands.size?esc([...bands].join(", ")):blank}</td></tr>
      <tr><td>Channels (EARFCN / UARFCN), uplink and downlink</td><td>${blank}</td></tr>
      <tr><td>Booster make, model, FCC ID and date of certification</td><td>${blank}</td></tr>
      <tr><td>Peak and average gain, uplink / downlink</td><td>${blank} dB / ${blank} dB</td></tr>
      <tr><td>Maximum output power (EIRP), uplink / downlink</td><td>${blank} dBm / ${blank} dBm</td></tr>
      <tr><td>Maximum transmitted noise</td><td>${blank} dBm</td></tr>
      <tr><td>Self-monitoring, anti-oscillation, gain control</td><td>yes / no: ${blank}</td></tr>
      <tr><td>Donor antenna: azimuth, height</td><td>${dn.az!=null?`${dn.az}°`:blank}, ${dn.height_ft!=null?`${dn.height_ft} ft`:blank}${has(dn.rsrp)?` · measured ${dn.rsrp} dBm RSRP${has(dn.sinr)?`, SINR ${dn.sinr} dB`:""}${dn.band?` on band ${esc(dn.band)}`:""}`:""}</td></tr>
      <tr><td>Installer contact</td><td>${esc(me?[me.name, me.org, me.phone, me.email].filter(Boolean).join(" · "):blank)}</td></tr></tbody></table>
    <p>Gain, AGC, oscillation shutdown and band settings will be set to the FCC limits and your requirements, and the booster will be shut off at your request (47 CFR 20.21(d)). Please confirm by letter or email naming the bands you consent to, with any conditions (FCC 13-21 ¶112), or tell us your own process.${carrier==="T-Mobile"?" Our In-Building Telecommunications Agreement (Rebroadcast Agreement) with its Exhibit A is attached.":""}</p>
    <p>Consent given by: ______________________________ Title: ____________________ Date: ____________</p>
    <p>Thank you,<br>${esc(me?[me.name, me.org, me.phone, me.email].filter(Boolean).join("<br>"):"")}</p></div>`;
  document.body.appendChild(box); document.body.classList.add("print-das"); window.print();
  setTimeout(()=>{ document.body.classList.remove("print-das"); box.remove(); },500);
}

/* ---------- report section ---------- */
window.dasCellReport = d => {
  const layers=cellLayers(d), C=d.cellular||{}, P=cellProfile(d), floors=Array.isArray(d.floors)?d.floors:[];
  const donors=Object.entries(C.donor||{}).filter(([,v])=>has(v.rsrp)), appr=Object.entries(C.approvals||{}).filter(([,v])=>v.path||v.asked||v.consent);
  if(!layers.length&&!donors.length&&!appr.length) return "";
  return `<div style="break-before:page;margin-top:16px"><h3>Commercial cellular coverage</h3>
    <p class="hint">Reported apart from the emergency responder result above and never counted in it. Target: ${esc(P.name)}: RSRP ≥ ${P.rsrp} dBm${P.rsrp_hi!=null&&P.rsrp_hi!==P.rsrp?` (≥ ${P.rsrp_hi} dBm from 3.3 GHz)`:""}${P.hi_by?` (${esc(Object.entries(P.hi_by).map(([c,v])=>`${c} ${v} dBm`).join(", "))} from 3.3 GHz)`:""}${P.sinr!=null?`, SINR ≥ ${P.sinr} dB`:""} on ${P.pct}% of the tested squares${P.carriers?.length?`, carriers: ${esc(P.carriers.join(", "))}`:""}. ${esc(P.preset==="custom"?"":P.src)} Each square counts the carrier's best cell.</p>
    ${layers.length?`<table><thead><tr><th>Floor</th><th>Carrier</th><th>Layer</th><th class="n">Tested</th><th class="n">Pass</th><th class="n">%</th><th>Result</th></tr></thead><tbody>
      ${floors.flatMap(f=>layers.map(L=>{ const s=cellFloor(d,f,L.key); if(!s.tested&&!s.untested) return "";
        return `<tr><td>${esc(f.name)}</td><td>${esc(L.carrier)}${L.required?"":' <span class="hint">(not required)</span>'}</td><td>${esc(LAYER_NAME[L.layer])}</td><td class="n">${s.tested}</td><td class="n">${s.pass}</td><td class="n">${s.tested?s.pct+"%":"–"}</td>
          <td>${!s.tested?"untested":L.required?(s.ok?"pass":"fail"):(s.ok?"meets the target":"below the target")}${s.untested?` · ${s.untested} untested`:""}${s.noSinr?` · ${s.noSinr} without SINR`:""}</td></tr>`; })).join("")}</tbody></table>`:""}
    ${donors.length?`<h3>Rooftop donor</h3><table><thead><tr><th>Carrier</th><th class="n">RSRP dBm</th><th class="n">SINR dB</th><th>Band</th><th class="n">Azimuth</th><th class="n">Height ft</th><th>Measured</th><th>Against Providence §3.9</th></tr></thead><tbody>
      ${donors.map(([c,v])=>`<tr><td>${esc(c)}</td><td class="n">${v.rsrp}</td><td class="n">${v.sinr??""}</td><td>${esc(v.band||"")}</td><td class="n">${v.az!=null?v.az+"°":""}</td><td class="n">${v.height_ft??""}</td><td class="mono">${esc(v.at||"")}</td><td>${{target:"meets −85 dBm target", minimum:"minimum only (−95 dBm)", below:"below minimum"}[donorVerdict(v)]||""}</td></tr>`).join("")}</tbody></table>`:""}
    ${appr.length?`<h3>Carrier approvals</h3><table><thead><tr><th>Carrier</th><th>Path</th><th>Asked</th><th>Consent</th><th>Contact / reference</th></tr></thead><tbody>
      ${appr.map(([c,v])=>`<tr><td>${esc(c)}</td><td>${esc((APPROVAL_PATHS.find(([k])=>k===v.path)||[,""])[1].split(":")[0])}</td><td class="mono">${esc(v.asked||"")}</td><td class="mono">${esc(v.consent||"not yet")}</td><td>${esc(v.contact||"")}</td></tr>`).join("")}</tbody></table>`:""}</div>`;
};

/* ---------- LTE / 5G bands for the link budget (DAS-Cellular research, bands.csv) ---------- */
// [id, label, UL MHz, DL MHz, carriers, default channel MHz, NR at 30 kHz]
const DAS_LTE_BANDS = [
  ["71","B71 / n71 600 MHz",[663,698],[617,652],"T-Mobile",15,false], ["12","B12 / n12 Lower 700",[699,716],[729,746],"AT&T, T-Mobile",10,false],
  ["17","B17 Lower 700",[704,716],[734,746],"AT&T",10,false], ["29","B29 / n29 700 (downlink only)",null,[717,728],"AT&T",5,false],
  ["13","B13 / n13 Upper 700",[777,787],[746,756],"Verizon",10,false], ["14","B14 / n14 FirstNet",[788,798],[758,768],"FirstNet / AT&T",10,false],
  ["5","B5 / n5 850",[824,849],[869,894],"AT&T, Verizon",10,false], ["26","B26 / n26 850",[814,849],[859,894],"T-Mobile",10,false],
  ["2","B2 / n2 PCS 1900",[1850,1910],[1930,1990],"Verizon, AT&T, T-Mobile",20,false], ["25","B25 / n25 PCS 1900",[1850,1915],[1930,1995],"T-Mobile",20,false],
  ["66","B66 / n66 AWS",[1710,1780],[2110,2200],"Verizon, AT&T, T-Mobile",20,false], ["70","B70 / n70 AWS-4",[1695,1710],[1995,2020],"EchoStar / DISH",15,false],
  ["30","B30 / n30 WCS 2.3 GHz",[2305,2315],[2350,2360],"AT&T",10,false], ["41","B41 / n41 2.5 GHz (TDD)",[2496,2690],[2496,2690],"T-Mobile",100,true],
  ["48","B48 / n48 CBRS (TDD)",[3550,3700],[3550,3700],"neutral host, private",20,false], ["n77a","n77 3.45 GHz (TDD)",[3450,3550],[3450,3550],"AT&T, T-Mobile",40,true],
  ["n77c","n77 C-band (TDD)",[3700,3980],[3700,3980],"Verizon, AT&T, T-Mobile",100,true],
].map(([id,label,ul,dl,carriers,bw,nr])=>({id, label, ul, dl, carriers, bw, scs:nr?30:15}));
// subcarriers in a channel: LTE 15 kHz (5/10/15/20 MHz = 25/50/75/100 RB), NR 30 kHz (3GPP TS 38.101-1 max RB, background)
const NR30_RB = {10:24, 15:38, 20:51, 25:65, 30:78, 40:106, 50:133, 60:162, 70:189, 80:217, 90:245, 100:273};
const cellSubcarriers = (bwMhz, scs) => 12*(scs===30 ? (NR30_RB[bwMhz] ?? Math.floor(bwMhz*1000*0.98/360)) : Math.round(bwMhz*5));
// a cellular band as the link budget sees it (dasdesign.js dsBands)
function cellBandEntry(d, id){ const b=DAS_LTE_BANDS.find(x=>x.id===id); if(!b) return null; const P=cellProfile(d);
  return {band:`Cellular ${b.label}`, cell:true, id:b.id, f_dl:b.dl[1], f_ul:(b.ul||b.dl)[1], n_ch:1, systems:[b.carriers], dl:[], ul:[], best:null,
    bw_mhz:b.bw, scs:b.scs, target:b.dl[0]>=3300?(P.rsrp_hi??P.rsrp):P.rsrp}; }
