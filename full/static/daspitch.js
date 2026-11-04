"use strict";
/* RF Recon — DAS Pitch (Cody 11/3: "marketing / pitch deck / showcasing products and capabilities (outside normal AHJ
   requirements), timelines, processes, needs from the customers, final product, and a compare section to other
   companies"). A deck a DAS firm shows a building owner: from the cited market research (static/research/
   das_market.json), the firm's own details (kept for every login), and, when a job is picked, that building's own
   pre-survey and design. Prints to PDF one slide per page. Every market fact keeps its source (the last slide).
   Needs core.js (api, post, esc, $), das.js (dasPrintCopy, dsBands, dsInputs, lbCompute via dasdesign.js). */

window.dasPitch = async el => {
  el.innerHTML = '<p class="hint">Reading the market research…</p>';
  const [M, firm, jl] = await Promise.all([fetch("static/research/das_market.json").then(r => r.json()), api("/api/das/firm").catch(() => ({})), api("/api/das/jobs").catch(() => ({ jobs: [] }))]);
  if (!el.isConnected) return;
  const P = S.dasPitch = S.dasPitch || { job: "" };
  const job = P.job ? await api(`/api/das/jobs/${P.job}`).catch(() => null) : null;
  if (!el.isConnected) return;
  const src = Object.fromEntries((M.sources || []).map(s => [s.key, s]));
  const cite = keys => (keys || []).length ? `<sup class="hint">${(keys || []).map(k => src[k] ? `<a href="${esc(src[k].url)}" target="_blank" rel="noopener" title="${esc(src[k].title)}">[${esc(k)}]</a>` : "").join("")}</sup>` : "";
  const F = { name: firm.name || "Your firm", tagline: firm.tagline || "In-building public safety and cellular coverage, designed, installed, tested and kept passing.",
    phone: firm.phone || "", email: firm.email || "", website: firm.website || "", license: firm.license || "", area: firm.area || "", years: firm.years || "", certs: firm.certs || "" };
  const d = job?.data || {};
  const C = M.competitors || {};
  const slide = (title, body, cls = "") => `<section class="pitch-slide ${cls}"><h2>${title}</h2>${body}<footer>${esc(F.name)}${F.phone ? ` · ${esc(F.phone)}` : ""}${F.website ? ` · ${esc(F.website)}` : ""}</footer></section>`;
  // this building, when a job is picked: its own numbers, never made-up ones
  let building = "";
  if (job) {
    const plan = (d.presurvey || {}).plan || [], bands = window.dsBands ? dsBands(d) : [];
    const sys = [...new Set(plan.map(p => p.system))];
    const res = bands.map(b => { try { const R = lbCompute(dsInputs(d, b)); const fail = R.checks.filter(c => c.ok === false).length, open = R.checks.filter(c => c.ok == null).length;
      return `<li><b>${esc(b.band)}</b>: ${fail ? `${fail} check${fail === 1 ? "" : "s"} to fix in design` : open ? `${open} input${open === 1 ? "" : "s"} still to measure` : "the design passes on paper"}</li>`; } catch (e) { return ""; } }).join("");
    building = slide(`For ${esc(job.name)}`, `<p class="lead">${esc(d.address || "")}${d.ahj ? ` · AHJ: ${esc(d.ahj)}` : ""}</p>
      <div class="pitch-grid"><div><h3>What the FCC records show around the building</h3>${sys.length ? `<p>${plan.length} public safety channel${plan.length === 1 ? "" : "s"} from ${sys.length} system${sys.length === 1 ? "" : "s"} the booster must carry:</p><ul>${sys.slice(0, 8).map(s => `<li>${esc(s)}</li>`).join("")}${sys.length > 8 ? `<li>and ${sys.length - 8} more</li>` : ""}</ul>` : "<p>The pre-survey isn't run yet: it lists the agencies whose radios must work inside.</p>"}</div>
        <div><h3>Where the design stands</h3>${res ? `<ul>${res}</ul>` : "<p>The link budget isn't filled in yet.</p>"}
          <p>${esc(d.booster_class || "Class A (channelized)")} booster${d.building?.footprint_sqft ? ` · about ${Math.round(d.building.footprint_sqft).toLocaleString()} sq ft a floor` : ""}${Array.isArray(d.floors) && d.floors.length ? ` · ${d.floors.length} floors to test` : ""}.</p></div></div>`);
  }
  const caps = [["FCC pre-survey before the first site visit", "Every licensed public safety system around the building, with its channels, sites and expected levels, and the consent letters the licensees must sign."],
    ["A link budget and a system diagram", "Donor to the farthest corner, downlink and uplink, checked against the AHJ's numbers before anything is bought."],
    ["Grid testing to NFPA 1225", "Readings by square and floor, critical areas, calibrated instruments only, and an AHJ report and design submittal ready to print."],
    ["Spec sheets and the closeout packet", "Every part's spec sheet gathered for the AHJ with the bill of materials, in one download."],
    ["Parts bought at the best price", "The same list sent to several suppliers, compared on price, shipping and lead time."],
    ["Interference found fast", "A guided signal hunt from a phone: where a rogue booster or interferer probably is, from levels and directions."]];
  const deck = [
    `<section class="pitch-slide pitch-cover"><div><p class="hint">${esc(F.area || "")}</p><h1>${esc(F.name)}</h1><p class="lead">${esc(F.tagline)}</p>
      ${job ? `<p>Prepared for <b>${esc(job.name)}</b>${d.address ? `, ${esc(d.address)}` : ""}</p>` : ""}
      <p class="hint">${[F.phone, F.email, F.website].filter(Boolean).map(esc).join(" · ")}${F.license ? `<br>${esc(F.license)}` : ""}${F.certs ? `<br>${esc(F.certs)}` : ""}</p></div></section>`,
    slide("Why the building needs it", `<p class="lead">${esc(M.code_triggers_common?.text || "")}${cite(M.code_triggers_common?.sources)}</p>`),
    slide("More than passing the fire marshal", `<div class="pitch-cards">${(M.value_beyond_code || []).map(v => `<div><b>${esc(v.item)}</b><p>${esc(v.claim)}${cite(v.sources)}</p><span class="hint">${(v.who_cares || []).map(esc).join(" · ")}</span></div>`).join("")}</div>`),
    slide("How a job runs", `<ol class="pitch-steps">${(M.process || []).map(s => `<li><b>${esc(s.phase)}</b> <span class="hint">${esc(s.duration || "")}</span><br>${esc(s.what)}${cite(s.sources)}</li>`).join("")}</ol>`),
    slide("What we need from you", `<div class="pitch-grid"><div><h3>To get started</h3><ul>${((M.customer_needs || {}).supply_or_decide || []).map(x => `<li>${esc(x.item || x.need || x)}${x.detail ? `: <span class="hint">${esc(x.detail)}</span>` : ""}${cite(x.sources)}</li>`).join("")}</ul></div>
      <div><h3>Questions owners ask</h3><dl>${((M.customer_needs || {}).objections || []).map(x => `<dt>${esc(x.objection || x.q || "")}</dt><dd>${esc(x.answer || x.a || "")}${cite(x.sources)}</dd>`).join("")}</dl></div></div>`),
    slide("What you get at the end", `<div class="pitch-cards">${(M.deliverables || []).map(x => `<div><b>${esc(x.item)}</b><p>${esc(x.line)}${cite(x.sources)}</p></div>`).join("")}</div>`),
    slide("How we work: the tools behind it", `<div class="pitch-cards">${caps.map(([t, l]) => `<div><b>${esc(t)}</b><p>${esc(l)}</p></div>`).join("")}</div>`),
    slide("Choosing who does it", `<p class="lead">What to compare any integrator on, and how we show it.</p><div class="tw wrap"><table><thead><tr><th>Ask about</th><th>Why it matters</th><th>How we show it</th></tr></thead><tbody>
      ${(C.compare_dimensions || []).map(x => `<tr><td><b>${esc(x.dimension)}</b></td><td>${esc(x.why || x.buyer_asks || "")}${cite(x.sources)}</td><td>${esc(x.rf_recon_firm_shows || x.how_we_show || "")}</td></tr>`).join("")}</tbody></table></div>`),
    slide("Who else does this work", `<div class="pitch-grid">${[["National integrators", C.national_integrators], ["Regional integrators", C.regional_integrators], ["Equipment makers that install", C.oems_with_services]].map(([h, list]) =>
      `<div><h3>${h}</h3><ul>${(list || []).map(x => `<li><b>${esc(x.name)}</b>: ${esc(x.offers || "")}${cite(x.sources)}</li>`).join("")}</ul></div>`).join("")}</div>
      ${C.market_context ? `<p class="hint">${esc(C.market_context.text || C.market_context.note || "")}${cite(C.market_context.sources)}</p>` : ""}`),
    building,
    `<section class="pitch-slide pitch-sources"><h2>Sources</h2><ol>${(M.sources || []).map(s => `<li id="ps-${esc(s.key)}">[${esc(s.key)}] ${esc(s.title)}: <a href="${esc(s.url)}">${esc(s.url)}</a> (checked ${esc(s.checked || "")})</li>`).join("")}</ol></section>`].filter(Boolean);
  el.innerHTML = `<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">For a building <select id="ppJob"><option value="">— none (a general deck) —</option>${(jl.jobs || []).map(x => `<option value="${x.id}" ${String(x.id) === String(P.job) ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      <button id="ppEdit">Your firm's details</button><button class="primary" id="ppPrint">⎙ Print / save as PDF</button>
      <span class="hint">${deck.length} slides · market facts from ${(M.sources || []).length} cited sources (${esc(M.updated || "")})</span></div>
    <div id="ppForm" style="display:none"></div>
    <div id="dasPrint" class="pitch-deck">${deck.join("")}</div>`;
  $("#ppJob").onchange = e => { P.job = e.target.value; window.dasPitch(el); };
  $("#ppPrint").onclick = () => dasPrintCopy($("#dasPrint"));
  $("#ppEdit").onclick = () => { const f = $("#ppForm"); if (f.style.display === "block") { f.style.display = "none"; return; }
    const field = (k, l, w = 260) => `<label>${l}<input data-pf="${k}" value="${esc(firm[k] || "")}" style="width:${w}px"></label>`;
    f.innerHTML = `<div class="panel" style="margin:0 0 10px"><h3>Your firm <span class="hint">· on the cover and every slide; kept for every login</span></h3><div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
      ${field("name", "Name")}${field("tagline", "One line", 420)}${field("phone", "Phone", 150)}${field("email", "Email")}${field("website", "Website")}
      ${field("area", "Where you work", 220)}${field("license", "Licences (e.g. state low-voltage, FCC)", 300)}${field("certs", "Certifications (e.g. NICET, iBwave)", 300)}
      ${field("contact", "Your name (signs outreach emails)", 240)}${field("address", "Mailing address (required in outreach emails)", 420)}
      <button class="primary" id="ppSave">Save</button></div></div>`;
    f.style.display = "block";
    $("#ppSave").onclick = async () => { const v = {}; f.querySelectorAll("[data-pf]").forEach(i => v[i.dataset.pf] = i.value.trim());
      try { await post("/api/das/firm", v); window.dasPitch(el); } catch (e) { alert(e.message); } }; };
};
