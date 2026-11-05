"use strict";
/* RF Recon — DAS Prospects (Cody 11/3: "a tool for DAS to help locate / research data / reach out to potential
   customers (common customer lists: schools, malls, stadiums, public, any high-traffic areas) automatically").
   Buildings that often must have emergency responder radio coverage, near a spot, from public US government lists
   (prospects.py: NCES schools, IPEDS colleges, CMS hospitals; refreshed monthly by the "DAS prospect lists" update),
   ranked by the market research's priority (das_market.json prospect_types), with who to approach and why.
   Each one has a status in the firm's pipeline. Outreach is a first email the person sends from their own mail:
   RF Recon never sends it. The email follows CAN-SPAM (who it's from, the firm's mailing address, an opt-out), and
   "Do not contact" is honoured: no email button. "Make a DAS job" puts the building on the board as a Lead.
   Needs core.js (api, post, esc, $, S, parseLoc, num), das.js (dasSay). */

// two groups: the government lists (NCES, IPEDS, CMS) and Overture Maps (places; high-rises from its buildings, per area)
const PR_GROUPS = [["Schools and hospitals", [["school_k12", "Public schools"], ["school_private", "Private schools"], ["college", "Colleges"], ["hospital", "Hospitals"], ["nursing_home", "Nursing homes"]]],
  ["Large and high-traffic", [["high_rise", "High-rises"], ["mall", "Malls"], ["stadium", "Stadiums and arenas"], ["hotel", "Hotels"], ["venue", "Convention centres and venues"],
    ["casino", "Casinos"], ["airport", "Airports"], ["transit", "Transit stations"], ["government", "Government buildings"], ["warehouse", "Warehouses"], ["parking", "Parking garages"], ["tunnel", "Tunnels"]]],
  ["From building permits", [["under_construction", "Under construction"]]]];
const PR_KINDS = PR_GROUPS.flatMap(g => g[1]);
// Building permits and COs (permits.py, 11/4): each building's best permit is its trigger; the filter and the sort use it
// a year ago as a local calendar date (toISOString() is the UTC date: after 7 PM Eastern it reads as tomorrow)
const prYearAgo = () => { const t = new Date(Date.now() - 365 * 864e5); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const PR_TRIG = [["", "Every building"], ["new", "New construction"], ["co12", "CO in the last 12 months"], ["major", "Major alteration or addition"], ["any", "Any permit"]];
const prTrigRank = x => { const t = x.trigger; if (!t || t.minor) return 9; const yr = prYearAgo();
  // the server's order (permits._rank): new building with no CO, a new building's CO this year, major alteration, addition,
  // another CO this year (a new occupant or a change), ERCES work, the rest
  const co = (t.co_date || "") >= yr;
  return t.kind === "new_building" && !t.co_date ? 0 : t.new && co ? 1 : t.kind === "major_alteration" ? 2 : t.kind === "addition" ? 3 : t.kind === "co_issued" && co ? 4 : t.erces ? 5 : 6; };
const prTrigOk = (x, f) => { const t = x.trigger; if (!f) return true; if (!t) return false;
  const yr = prYearAgo();
  return f === "any" ? true : f === "new" ? !!t.new
    : f === "co12" ? (t.co_date || "") >= yr : f === "major" ? !t.minor && (t.kind === "major_alteration" || t.kind === "addition") : true; };
const PR_TRIG_COL = { 0: "#7c3aed", 1: "#0891b2", 2: "#b45309", 3: "#b45309", 4: "#0e7490", 5: "#16a34a", 6: "#8a8a8a", 9: "#8a8a8a" };
// the code rule behind a trigger: the AHJ's own (city or county, then state) from permit_sources.json, else the model IFC
const PR_STATE_NAME = { DC: "Washington, DC", VA: "Virginia", MD: "Maryland", MN: "Minnesota", NC: "North Carolina", SC: "South Carolina", FL: "Florida", NY: "New York City",
  CA: "California", IL: "Chicago", WA: "Seattle", CO: "Denver", AZ: "Phoenix", TX: "Texas" };
const prRules = (t, reg) => {
  const all = (reg && reg.erces_triggers) || [], want = t.kind === "co_issued" ? ["CO", "permit"] : t.kind === "new_building" ? ["permit", "CO"] : ["retest", "permit", "existing"];
  const pick = list => { for (const a of want) { const r = list.find(x => x.at === a); if (r) return r; } return null; };
  const place = (t.place || "").split(",")[0].replace(/^City of /, "").trim();
  const local = place && pick(all.filter(r => r.ahj.startsWith(place)));
  const state = pick(all.filter(r => r.ahj.startsWith(PR_STATE_NAME[t.state] || "~")));
  const model = pick(all.filter(r => /^Model code/.test(r.ahj) && /2024 International Fire Code/.test(r.code)));
  return [local, local ? null : state, local || state ? null : model].filter(Boolean);
};
let PR_REG = null;  // static/research/permit_sources.json, read once
const prReg = async () => PR_REG || (PR_REG = await fetch("static/research/permit_sources.json").then(r => r.json()).catch(() => ({})));
const PR_STATUS = ["new", "contacted", "replied", "meeting", "won", "not interested", "do not contact"];
const PR_KIND = Object.fromEntries(PR_KINDS);
// RF need (need.py, 11/4): an estimate per building of whether agency radio (and carriers) fall short inside, worked out
// after the list shows, a few dozen buildings a request (the ids ride in the URL, so a GET stays short and view logins see it)
const PR_NEED = { short: ["Likely short", "#dc2626"], close: ["Close", "#d97706"], ok: ["Likely OK", "#16a34a"], unknown: ["Unknown", "#8a8a8a"] };
const PR_NEED_RANK = { short: 0, close: 1, unknown: 2, ok: 3 };
const PR_PRI = { high: 0, medium: 1, low: 2 };
const PR_NEED_CHUNK = 120;  // about 2.5 KB of ids in the URL
const PR_STCOL = { new: "#3b82f6", contacted: "#f59e0b", replied: "#a855f7", meeting: "#a855f7", won: "#16a34a", "not interested": "#888", "do not contact": "#555" };
const prHt = x => { const m = /([\d,]+) ft/.exec(x.size_label || ""); return m ? +m[1].replace(/,/g, "") : 0; };
const prDb = n => n.margin_db == null ? "" : n.ps === "short" ? ` by ${Math.round(-n.margin_db)} dB` : ` ${n.margin_db >= 0 ? "+" : "−"}${Math.abs(Math.round(n.margin_db))} dB`;
const prNsiLine = n => [n.year_built && `built ${n.year_built}`, n.stories && `${n.stories} floor${n.stories === 1 ? "" : "s"}`, n.sqft && `${Math.round(n.sqft).toLocaleString()} sq ft`,
  n.basement ? "basement" : "", n.occupancy_label].filter(Boolean).join(" · ") || "no details";
const prCells = n => !n.carriers ? "" : !n.carriers.length ? "none claimed here" : n.cell_short ? `${n.cell_short} of ${n.carriers.length} short` : n.cell === "close" ? "close" : "OK";

window.dasProspects = async el => {
  const P = S.dasProspects = S.dasProspects || { radius: 10, kinds: PR_KINDS.map(k => k[0]), q: "", status: "", where: null, label: "", rows: null, gen: 0 };
  if (!P.where && S.center) { P.where = [S.center[0], S.center[1]]; P.label = "the search pin"; }
  P.need = P.need || {}; P.sort = P.sort || "need"; P.env = P.env || "suburban"; P.colour = P.colour || "need"; P.open = P.open || new Set(); P.trig = P.trig || "";
  if (!P.kinds.includes("under_construction") && !P.ucSeen) P.kinds.push("under_construction");  // a list kept from before permits (11/4)
  P.ucSeen = true;
  const [M, firm, jl, reg] = await Promise.all([fetch("static/research/das_market.json").then(r => r.json()).catch(() => ({})),
    api("/api/das/firm").catch(() => ({})), api("/api/das/jobs").catch(() => ({ jobs: [] })), prReg()]);
  if (!el.isConnected) return;
  const jobs = (jl.jobs || []).filter(j => j.lat != null || j.data?.lat != null);
  const types = M.prospect_types || [];
  el.innerHTML = `<div class="panel pr-head">
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:end">
        <label>Where<input id="prWhere" placeholder="A town, an address, or lat, lon" value="${esc(P.label && P.label !== "the search pin" ? P.label : "")}" style="min-width:240px"></label>
        <button id="prGo" class="primary">Find buildings</button>
        ${S.center ? `<button id="prPin" title="Use the pin on the Search map">Use the search pin</button>` : ""}
        ${jobs.length ? `<label>or near a job<select id="prJob"><option value="">Pick a job…</option>${jobs.map(j => `<option value="${j.id}">${esc(j.name)}</option>`).join("")}</select></label>` : ""}
        <label>Within<select id="prRadius">${[2, 5, 10, 25, 50].map(r => `<option value="${r}" ${+P.radius === r ? "selected" : ""}>${r} mi</option>`).join("")}</select></label>
      </div>
      <div id="prKinds">${PR_GROUPS.map(([g, ks]) => `<div class="row" style="flex-wrap:wrap;gap:4px 14px;margin-top:8px;align-items:center"><b style="min-width:160px">${g}</b>${ks.map(([k, l]) => `<label style="display:inline-flex;gap:6px;align-items:center;flex-direction:row"><input type="checkbox" style="width:auto;margin:0" data-k="${k}" ${P.kinds.includes(k) ? "checked" : ""}> ${l} <span class="hint" data-n="${k}"></span></label>`).join("")}</div>`).join("")}
        <div class="row" style="gap:8px;margin-top:6px;align-items:center"><button id="prHigh" title="Overture Maps buildings 75 ft or 7 floors and up, within the radius (at most 10 mi)">Find high-rises here</button><span class="hint" id="prHighMsg">High-rises come from building heights near a spot: kept for each mission area, or found here on a press.</span></div>
        ${window.dasFindTunnels ? `<div class="row" style="gap:8px;margin-top:6px;align-items:center"><button id="prTun" title="Road and rail tunnels from OpenStreetMap within the radius (at most 10 mi)">Find tunnels here</button><span class="hint" id="prTunMsg">Road tunnels (NFPA 502) and rail and transit tunnels (NFPA 130), from OpenStreetMap on a press.</span></div>` : ""}</div>
      <p class="hint" id="prSrc" style="margin:8px 0 0"></p>
    </div>
    ${firm.address ? "" : `<p class="status pr-warn" id="prNoAddr">Add your firm's mailing address before emailing anyone: US law (CAN-SPAM) requires it in every commercial email. <a href="#" id="prFirm">Firm details</a></p>`}
    <div id="prBody"></div>
    <details class="panel" style="margin-top:12px"><summary>Why these buildings, and who to approach</summary>
      <div class="pitch-cards" style="margin-top:8px">${types.map(t => `<div><b>${esc(t.type)}</b> <span class="tag">${esc(t.priority || "")}</span><p>${esc(t.why || "")}</p><p class="hint">Approach: ${esc(t.decision_maker || "")}</p></div>`).join("")}</div>
      <p class="hint" id="prNeedHow"><b>RF need</b> is an estimate, not a measurement: the strongest government trunked or 700/800 MHz radio system licensed within 15 mi, its licensed power and height through Okumura-Hata with the hills on the path where terrain is on this computer, minus a building loss (ITU-R P.2109 by year built, plus deep interior, cores and below grade from the USACE National Structure Inventory or the building's type), against −95 dBm inside. Within 6 dB either way it's close: a walk test decides. Carriers: the FCC Broadband Map's modelled signal minus the same loss, against −95 dBm. Sources: FCC ULS, terrain tiles (USGS 3DEP), USACE NSI, Overture heights, FCC Broadband Map.</p>
      <p class="hint" id="prTrigHow"><b>Trigger</b> is the building's strongest permit from city and county open data, matched by its address or within 250 ft of the building (800 ft for malls, campuses, hospitals and other large sites): a new building with no CO yet, a CO in the last 12 months, a major alteration, an addition, then ERCES work already permitted. A new building has to show radio coverage before it is occupied (IFC 2024 510.1 and 510.5.4; Virginia USBC 918; Montgomery County ER 13-24). "Major alteration" is RF Recon's working line ($250,000 or 10,000 sq ft of work, or a change of occupancy), not a code threshold: the codes read retest after any addition or remodel that could change the original test (IFC 510.6.1). Permitted new buildings no list has yet show as Under construction. Each city or county dataset has its own switch in Data &amp; updates; those whose terms aren't clearly open ship off.</p>
      <p class="hint">Malls, venues, hotels and the rest are Overture Maps places (CDLA-Permissive-2.0, Apache-2.0 or CC0; attribution: Overture Maps Foundation). High-rises are Overture buildings (© OpenStreetMap contributors, Overture Maps Foundation, ODbL). A building's own name is used when it has one; otherwise it's named by the business inside it.</p>
    </details>`;
  const body = $("#prBody");
  // RF need: a click on the verdict opens its reasons under the row; "Check the building" asks the NSI (need.py keeps it)
  body.addEventListener("click", async e => {
    const nd = e.target.closest("[data-nd],[data-tg]"), ns = e.target.closest("[data-nsi]");
    if (!nd && !ns) return;
    const tr = e.target.closest("tr"), pid = tr.dataset.pid || tr.dataset.why, x = (P.rows || []).find(r => r.id === pid);
    if (!x) return;
    if (nd) {
      const open = body.querySelector(`tr[data-why="${CSS.escape(pid)}"]`);
      if (open) { open.remove(); P.open.delete(pid); } else { tr.insertAdjacentHTML("afterend", prWhy(x)); P.open.add(pid); }
      return;
    }
    ns.disabled = true; ns.textContent = "Asking the NSI…";
    try {
      const r = await post(`/api/das/prospects/${encodeURIComponent(pid)}/nsi`, { env: P.env, job_id: x.job_id, area: { lat: P.where[0], lon: P.where[1], radius: P.radius } });
      if (r.need) P.need[pid] = r.need;
      const row = body.querySelector(`tr[data-pid="${CSS.escape(pid)}"]`);
      if (row) row.querySelector("[data-need]").innerHTML = prNeedCell(x);
      const w = body.querySelector(`tr[data-why="${CSS.escape(pid)}"]`); if (w) w.outerHTML = prWhy(x);
      P.marks?.get(pid)?.setStyle({ color: prDot(x) });
      dasSay(`${x.name}: ${prNsiLine(r.nsi)} (NSI, modelled). RF need now ${(PR_NEED[r.need?.ps] || PR_NEED.unknown)[0].toLowerCase()}${r.need ? prDb(r.need) : ""}.`);
    } catch (err) { ns.disabled = false; ns.textContent = "Check the building (NSI)"; dasSay(err.message); }
  });
  const where = async () => {
    const t = $("#prWhere").value.trim();
    if (!t) return P.where;
    const ll = parseLoc(t);
    if (ll) { P.label = t; return ll; }
    const g = await api(`/api/geocode?q=${encodeURIComponent(t)}`);
    const r = (g.results || [])[0];
    if (!r) throw new Error(`Couldn't find "${t}". Try a town and state, or lat, lon.`);
    P.label = t; $("#prWhere").value = r.label; return [r.lat, r.lon];
  };
  const load = async () => {
    const gen = ++P.gen;
    if (!P.where) { body.innerHTML = `<p class="hint">Type a town or address, use the search pin, or pick a job, then Find buildings.</p>`; return; }
    body.innerHTML = `<p class="hint">Looking within ${P.radius} mi…</p>`;
    let r;
    try { r = await api(`/api/das/prospects?lat=${P.where[0]}&lon=${P.where[1]}&radius=${P.radius}&kinds=${P.kinds.join(",")}&limit=1000`); }
    catch (e) { if (gen === P.gen) body.innerHTML = `<p class="status err">Prospects: ${esc(e.message)}</p>`; return; }
    if (gen !== P.gen || !el.isConnected) return;
    P.rows = r.prospects; P.counts = r.counts; P.sources = r.sources;
    for (const x of P.rows) x.dnc0 = x.status === "do not contact";  // sorted by the status as loaded: a row changed now stays put
    for (const [k] of PR_KINDS) { const n = el.querySelector(`[data-n="${k}"]`); if (n) n.textContent = r.counts[k] ? `(${r.counts[k].toLocaleString()} ${k === "high_rise" ? "found so far" : k === "under_construction" ? "new-building permits kept" : "in the US"})` : ""; }
    const up = r.counts.updated, np = r.counts.permits || 0;
    const ptxt = np ? ` Building permits: ${np.toLocaleString()} kept from the datasets switched on; the "Building permits and certificates of occupancy" update adds what's new weekly.`
      : ` No building permits on this computer yet: switch on "Building permits and certificates of occupancy" in Data &amp; updates (each city or county has its own switch).`;
    $("#prSrc").innerHTML = up ? `Public lists: ${Object.values(r.sources).map(s => esc(s.name)).join(", ")}. Updated ${esc(String(up).slice(0, 10))}; the "DAS prospect lists" update refreshes them monthly.${ptxt}`
      : `The prospect lists aren't downloaded on this computer yet. <button id="prFetch">Download them now</button> <span class="hint">(the US Department of Education, CMS and Overture Maps: a few minutes, once; then monthly)</span>`;
    $("#prFetch") && ($("#prFetch").onclick = async e => { e.target.disabled = true; e.target.textContent = "Downloading… (Updates tab shows progress)";
      try { await post("/api/update/run", { ids: ["das_prospects"] }); dasSay("Downloading the prospect lists. Press Find buildings again when the Updates tab says it's done."); } catch (x) { dasSay(x.message); e.target.disabled = false; } });
    paint();
    needRun();
  };
  // RF need for the rows that don't have it yet (need.py), in the list's order; the cells and dots fill in as each part
  // comes back, and the list re-sorts once at the end
  const needSay = t => { P.needMsg = t; const m = $("#prNeedMsg"); if (m) m.innerHTML = t; };
  const needRun = async () => {
    const gen = P.gen, key = P.env;
    if (P.needKey !== key) { P.need = {}; P.needKey = key; P.open.clear(); }
    const todo = (P.rows || []).filter(x => !P.need[x.id] && x.lat != null).map(x => x.id);
    if (!todo.length) return;
    const t0 = performance.now();
    let done = 0, note = "";
    for (let i = 0; i < todo.length; i += PR_NEED_CHUNK) {
      needSay(`Working out need… ${done.toLocaleString()} of ${todo.length.toLocaleString()}`);
      const ids = todo.slice(i, i + PR_NEED_CHUNK);
      let r;
      try { r = await api(`/api/das/prospects/need?ids=${ids.map(encodeURIComponent).join(",").replace(/%3A/gi, ":")}&lat=${P.where[0]}&lon=${P.where[1]}&radius=${P.radius}&env=${P.env}`); }
      catch (e) { if (gen === P.gen && P.needKey === key) needSay(`<span class="err">RF need: ${esc(e.message)}</span>`); return; }
      if (gen !== P.gen || P.needKey !== key || !el.isConnected) return;
      for (const id of ids) P.need[id] = r.need[id] || { ps: "unknown", ps_why: "No estimate: this building isn't in the lists RF Recon reads.", carriers: null };
      P.needMethod = r.method; note = r.carriers_note || "";
      done += ids.length;
      for (const id of ids) {  // in place: the cell, its open "why" row, the dot
        const x = P.rows.find(y => y.id === id), tr = body.querySelector(`tr[data-pid="${CSS.escape(id)}"]`);
        if (tr) { tr.querySelector("[data-need]").innerHTML = prNeedCell(x); const w = body.querySelector(`tr[data-why="${CSS.escape(id)}"]`); if (w) w.outerHTML = prWhy(x); }
        P.marks?.get(id)?.setStyle({ color: prDot(x) });
      }
    }
    const ms = Math.round(performance.now() - t0);
    needSay(`RF need: an estimate <span title="${esc(P.needMethod?.desc || "")}">(how)</span>${note ? ` · ${esc(note)} Public safety only.` : ""} <span class="hint">${todo.length.toLocaleString()} in ${(ms / 1000).toFixed(1)} s</span>`);
    if (P.sort === "need") paint();
  };
  const prNeedCell = x => {
    const n = P.need[x.id];
    if (!n) return x.lat == null ? `<span class="hint">no location</span>` : `<span class="hint">working out…</span>`;
    const [label, col] = PR_NEED[n.ps] || PR_NEED.unknown, c = prCells(n);
    return `<button data-nd style="padding:2px 8px;border:1px solid ${col};color:${col};background:transparent;white-space:nowrap" title="${esc(n.ps_why || "")} (click for the reasons)">${label}${prDb(n)}</button>`
      + (c ? `<div class="hint" title="${esc(n.cell_why || "")}">Carriers: ${esc(c)}</div>` : "");
  };
  // the trigger in the reasons row: the permit, the words that decided its kind, the dataset (link, publisher, licence) and the rule
  const prTrigWhy = x => {
    const t = x.trigger;
    if (!t) return "";
    const size = [t.value_usd && `$${Math.round(t.value_usd).toLocaleString()}`, t.sqft && `${Math.round(t.sqft).toLocaleString()} sq ft ${t.kind === "co_issued" ? "occupied" : "of work"}`,
      t.bldg_sqft && `${Math.round(t.bldg_sqft).toLocaleString()} sq ft building`, t.floors && `${t.floors} floors`, t.use_group].filter(Boolean).join(" · ");
    const dates = [t.filed && `filed ${t.filed}`, t.issued && `issued ${t.issued}`, t.final && `closed ${t.final}`, t.co_date && `CO ${t.co_date}`].filter(Boolean).join(", ");
    const rules = prRules(t, PR_REG);
    return `<div class="pr-trig" style="max-width:900px;margin-top:6px"><b>Trigger: ${esc(t.label)}</b>${t.n > 1 ? ` <span class="hint">(${t.n} permits here; the strongest shown)</span>` : ""}
      <div class="hint">Permit ${esc(t.permit_id)}${t.status ? ` (${esc(t.status)})` : ""}${dates ? `, ${esc(dates)}` : ""}${t.address ? ` at ${esc(t.address)}` : ""}: ${esc(t.desc)}${size ? `. ${esc(size)}` : ""}.</div>
      <div class="hint">Why this kind: ${esc(t.why)}.${t.kind === "major_alteration" && /RF Recon's line/.test(t.why) ? " That line is RF Recon's, not a code threshold." : ""}</div>
      ${rules.map(r => `<div class="hint">Rule: ${esc(r.ahj)}, ${esc(r.code)} ${esc(r.section)}: ${esc(r.threshold)}${r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">source</a>` : ""}</div>`).join("")}
      <div class="hint">Source: ${esc(t.source_name)}, ${esc(t.publisher)} (${esc(t.license.slice(0, 120))}). ${t.url && t.url !== t.dataset_url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">The permit</a> · ` : ""}<a href="${esc(t.dataset_url)}" target="_blank" rel="noopener">The dataset</a></div></div>`;
  };
  const prWhy = x => {
    const n = P.need[x.id];
    if (!n && !x.trigger) return "";
    // the reasons stay in view while a wide table scrolls sideways (a phone): pinned to the visible left edge
    return `<tr class="pr-why" data-why="${esc(x.id)}"><td colspan="8" style="white-space:normal"><div style="position:sticky;left:8px;width:min(900px,calc(100vw - 64px))">${prTrigWhy(x)}
      ${n ? `<div class="hint" style="max-width:900px;margin-top:6px">${esc(n.ps_why || "")}</div>${n.cell_why ? `<div class="hint" style="max-width:900px;margin-top:4px">${esc(n.cell_why)}</div>` : ""}
      <div style="margin-top:6px">${n.nsi ? `<span class="hint">From the USACE National Structure Inventory (modelled): ${esc(prNsiLine(n.nsi))}.</span>`
        : `<button data-nsi title="The USACE National Structure Inventory's record of this building (one small look-up): year built, stories, floor area and basement, so the building loss uses them">Check the building (NSI)</button>`}</div>` : ""}</div></td></tr>`;
  };
  const prTrigCell = x => {
    const t = x.trigger;
    if (!t) return "";
    const k = prTrigRank(x), col = PR_TRIG_COL[k];
    const m = /^(.*?)( · | \()(.*)$/.exec(t.label), main = m ? m[1] : t.label, sub = m ? (m[2] === " (" ? "(" : "") + m[3] : "";
    return `<button data-tg class="pr-tg" style="display:block;border-radius:8px;padding:4px 8px;min-height:32px;border:1px solid ${col};color:${col};background:transparent;text-align:left;white-space:normal;width:204px;line-height:1.3;font-size:12.5px" title="${esc(t.why)} (click for the permit, the source and the rule)"><b style="font-weight:600">${esc(main)}</b>${sub ? `<div style="opacity:.8;font-size:11.5px">${esc(sub)}</div>` : ""}</button>`;
  };
  const prDot = x => { const n = P.need[x.id]; return P.colour === "need" ? (n ? (PR_NEED[n.ps] || PR_NEED.unknown)[1] : "#bbb") : PR_STCOL[x.status] || "#3b82f6"; };
  const prSort = rows => {
    if (P.sort === "priority") return rows;  // the server's order: priority, then distance
    const key = P.sort === "dist" ? x => [x.dnc0 ? 1 : 0, x.dist_mi || 0]
      : x => { const n = P.need[x.id]; return [x.dnc0 ? 1 : 0, PR_NEED_RANK[n?.ps ?? "unknown"], prTrigRank(x), PR_PRI[x.priority] ?? 3, -(x.size || 0), -prHt(x), n?.margin_db ?? 0, x.dist_mi || 0]; };
    const k = new Map(rows.map(x => [x, key(x)]));
    return [...rows].sort((a, b) => { const A = k.get(a), B = k.get(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1; return 0; });
  };
  const paint = () => {
    const rows = prSort((P.rows || []).filter(x => (!P.status || x.status === P.status) && prTrigOk(x, P.trig) && (!P.q || `${x.name} ${x.city} ${x.detail || ""} ${x.trigger?.label || ""}`.toLowerCase().includes(P.q.toLowerCase()))));
    const ntrig = f => (P.rows || []).filter(x => prTrigOk(x, f)).length;
    const by = s => (P.rows || []).filter(x => x.status === s).length;
    if (!P.rows) return;
    if (!P.rows.length) { body.innerHTML = `<p class="hint">No ${P.kinds.map(k => PR_KIND[k].toLowerCase()).join(", ")} within ${P.radius} mi${P.counts?.updated ? "" : " (the lists aren't downloaded yet)"}. Try a wider radius.</p>`; return; }
    body.innerHTML = `<div class="row" style="flex-wrap:wrap;gap:8px;align-items:end;margin:10px 0">
        <b>${P.rows.length.toLocaleString()} building${P.rows.length === 1 ? "" : "s"} within ${P.radius} mi${P.label ? ` of ${esc(P.label)}` : ""}</b>
        <input id="prQ" placeholder="Filter by name or town" value="${esc(P.q)}" style="min-width:180px">
        <select id="prStatus"><option value="">Every status</option>${PR_STATUS.map(s => `<option value="${s}" ${P.status === s ? "selected" : ""}>${s} (${by(s)})</option>`).join("")}</select>
        <select id="prTrig" title="Building permits and certificates of occupancy matched to each building">${PR_TRIG.map(([k, l]) => `<option value="${k}" ${P.trig === k ? "selected" : ""}>${l}${k ? ` (${ntrig(k)})` : ""}</option>`).join("")}</select>
        <button id="prCsv" title="The rows shown, as a call list">⇩ Call list (CSV)</button>
        ${window.rfMail ? `<button id="prQueue" title="Write a first email to each building shown that has an email and hasn't been written to: they wait in DAS › Mail › Ready to send for your click">✉ Queue first emails</button>` : ""}
      </div>
      <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 8px">
        <label class="inl">Sort <select id="prSort">${[["need", "need first"], ["priority", "priority"], ["dist", "nearest"]].map(([k, l]) => `<option value="${k}" ${P.sort === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="inl" title="The estimate's land type (Okumura-Hata): urban loses the most, open land the least">Land <select id="prEnv">${[["urban", "urban"], ["suburban", "suburban"], ["open", "open land"]].map(([k, l]) => `<option value="${k}" ${P.env === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="inl">Map colour <select id="prCol"><option value="need" ${P.colour === "need" ? "selected" : ""}>need</option><option value="status" ${P.colour === "status" ? "selected" : ""}>status</option></select></label>
        <span class="hint" id="prNeedMsg">${P.needMsg || ""}</span>
      </div>
      <div id="prMap" style="height:340px;border-radius:12px;margin-bottom:4px"></div>
      <p class="hint" id="prLegend" style="margin:0 0 8px">${P.colour === "need" ? Object.values(PR_NEED).map(([l, c]) => `<span style="color:${c}">●</span> ${l}`).join(" &nbsp; ") + " &nbsp; (an estimate)"
        : Object.entries(PR_STCOL).filter(([s]) => s !== "meeting").map(([s, c]) => `<span style="color:${c}">●</span> ${s}`).join(" &nbsp; ")}</p>
      <div class="tw" style="max-height:560px;overflow:auto"><table class="pr-tab"><thead><tr><th>Building</th><th title="An estimate from public data, not a measurement: whether agency radio, and the carriers where loaded, likely fall short inside">RF need<div class="hint">estimate</div></th><th title="The building's strongest permit or certificate of occupancy from city and county open data (click one for the permit, its source and the rule)">Trigger<div class="hint">permits</div></th><th>Kind</th><th>mi</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 400).map(x => `<tr data-pid="${esc(x.id)}" class="${x.status === "do not contact" ? "pr-dnc" : ""}">
        <td style="white-space:normal;min-width:200px;max-width:320px"><b>${esc(x.name)}</b><div class="hint">${esc([x.address, x.city, x.state].filter(Boolean).join(", "))}${x.precision === "zip" ? " (placed at its ZIP)" : ""}</div>${x.detail ? `<div class="hint">${esc(x.detail)}</div>` : ""}</td>
        <td data-need>${prNeedCell(x)}</td>
        <td data-trig>${prTrigCell(x)}</td>
        <td>${esc(PR_KIND[x.kind] || x.kind)}${x.priority ? `<div><span class="tag" title="${esc(x.why)}">${esc(x.priority)}</span></div>` : ""}${x.size_label ? `<div class="hint">${esc(x.size_label)}</div>` : ""}</td>
        <td>${x.dist_mi < 10 ? x.dist_mi.toFixed(1) : Math.round(x.dist_mi)}</td>
        <td>${x.phone ? `<a href="tel:${esc(x.phone.replace(/[^\d+]/g, ""))}">${esc(x.phone)}</a>` : ""}${x.website ? `<div><a href="${esc(/^https?:/i.test(x.website) ? x.website : "https://" + x.website)}" target="_blank" rel="noopener">website</a></div>` : ""}
          ${x.email ? `<div><a href="mailto:${esc(x.email)}">${esc(x.email)}</a>${x.email_source ? ` <span class="hint" title="${esc(x.email_source)}">(from their site)</span>` : ""}</div>`
            : x.status !== "do not contact" && x.website ? `<div><button data-fe title="Reads their own website's home and contact pages for the address they publish">Find email</button></div>`
            : x.status !== "do not contact" ? `<div class="hint">No website or email listed: call first.</div>` : ""}
          <div class="hint" title="Who the research says to approach">${esc(x.approach || "")}</div></td>
        <td><select data-st>${PR_STATUS.map(s => `<option ${x.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>${x.contacted_at ? `<div class="hint">contacted ${esc(x.contacted_at.slice(0, 10))}</div>` : ""}</td>
        <td style="white-space:nowrap">${x.status === "do not contact" ? `<span class="hint">opted out</span>` : `<button data-em title="A first email, opened in your own mail. RF Recon never sends it.">Email</button>`}
          ${x.job_id ? `<button data-open="${x.job_id}">Job</button>` : `<button data-job title="Put it on the DAS board as a Lead">+ Job</button>`}</td></tr>${P.open.has(x.id) ? prWhy(x) : ""}`).join("")}
      </tbody></table>${rows.length > 400 ? `<p class="hint">Showing the first 400 of ${rows.length.toLocaleString()}: filter or narrow the radius.</p>` : ""}</div>
      <div id="prMail"></div>`;
    prMap(rows);
    $("#prQ").oninput = e => { P.q = e.target.value; clearTimeout(P.qt); P.qt = setTimeout(() => { const pos = e.target.selectionStart; paint(); const q = $("#prQ"); q.focus(); q.setSelectionRange(pos, pos); }, 250); };
    $("#prStatus").onchange = e => { P.status = e.target.value; paint(); };
    $("#prSort").onchange = e => { P.sort = e.target.value; paint(); };
    $("#prTrig").onchange = e => { P.trig = e.target.value; paint(); };
    $("#prEnv").onchange = e => { P.env = e.target.value; P.needMsg = ""; paint(); needRun(); };
    $("#prCol").onchange = e => { P.colour = e.target.value; paint(); };
    $("#prQueue") && ($("#prQueue").onclick = async e => {  // first emails, lined up in Mail › Ready to send (nothing sent here)
      const pick = rows.filter(x => x.email && (x.status || "new") === "new");
      if (!pick.length) { dasSay("None of the buildings shown has an email and status new. Find email first, or widen the list."); return; }
      const b = e.currentTarget; b.disabled = true;
      try { const r = await post("/api/mail/queue/prospects", { rows: pick.map(x => ({ ...x, kind_label: PR_KIND[x.kind] || x.kind })) });
        dasSay(`${r.queued} first email${r.queued === 1 ? "" : "s"} written and waiting in DAS › Mail › Ready to send${pick.length > r.max ? ` (the first ${r.max} of ${pick.length})` : ""}. Nothing is sent until you click.`);
        window.rfMail?.badge?.();
      } catch (err) { dasSay(err.message); } b.disabled = false; });
    $("#prCsv").onclick = () => {
      const cols = ["name", "kind", "priority", "address", "city", "state", "zip", "phone", "email", "website", "approach", "dist_mi", "status", "contacted_at"];
      // RF need, as estimates (need.py): the verdict, the numbers behind it and the reasons in words
      const nd = x => P.need[x.id] || {};
      const est = { rf_need_estimate: x => nd(x).ps ? PR_NEED[nd(x).ps][0] + prDb(nd(x)) : "", est_margin_db: x => nd(x).margin_db, est_outside_dbm: x => nd(x).out_dbm,
        est_building_loss_db: x => nd(x).loss_db, est_inside_dbm: x => nd(x).in_dbm, agency_system: x => nd(x).system ? `${nd(x).system.licensee} ${nd(x).system.band} (${nd(x).system.call})` : "",
        carrier_estimate: x => (nd(x).carriers || []).map(c => `${c.brand} ${c.tech} ${Math.round(c.in_dbm)} dBm inside (${c.verdict})`).join("; ") || (nd(x).ps ? nd(x).cell_why || "" : ""),
        rf_need_why: x => nd(x).ps_why,
        // the permit trigger (permits.py): what, when, why that kind, and where the record is
        trigger: x => x.trigger && !x.trigger.minor ? x.trigger.label : "", trigger_permit: x => x.trigger?.permit_id, trigger_date: x => x.trigger?.date,
        trigger_work: x => x.trigger?.desc, trigger_why: x => x.trigger?.why, trigger_source: x => x.trigger ? `${x.trigger.source_name} (${x.trigger.publisher})` : "",
        trigger_link: x => x.trigger?.url || x.trigger?.dataset_url };
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [[...cols, ...Object.keys(est)].join(","), ...rows.map(x => [...cols.map(c => q(c === "kind" ? PR_KIND[x.kind] || x.kind : x[c])), ...Object.values(est).map(f => q(f(x)))].join(","))].join("\r\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
      a.download = `DAS prospects ${(P.label || "here").replace(/[^\w ,.-]/g, "")} ${P.radius} mi.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };
    body.querySelectorAll("tr[data-pid]").forEach(tr => {
      const pid = tr.dataset.pid, x = P.rows.find(r => r.id === pid);
      tr.querySelector("[data-st]").onchange = async e => {
        const was = x.status;
        try { const r = await post(`/api/das/prospects/${encodeURIComponent(pid)}/status`, { status: e.target.value });
          Object.assign(x, { status: r.status, contacted_at: r.contacted_at, job_id: r.job_id ?? x.job_id }); paint(); }
        catch (err) { e.target.value = was; dasSay(err.message); }
      };
      const fe = tr.querySelector("[data-fe]");
      if (fe) fe.onclick = async () => {
        fe.disabled = true; fe.textContent = "Reading their site…";
        try {
          const r = await post(`/api/das/prospects/${encodeURIComponent(pid)}/find-email`, {});
          if (r.emails.length) { x.email = r.emails[0].email; x.email_source = r.emails[0].page;
            dasSay(`${x.email}${r.emails.length > 1 ? ` (and ${r.emails.length - 1} more on their site: ${r.emails.slice(1, 4).map(e => e.email).join(", ")})` : ""}`); paint(); }
          else { fe.textContent = "None published"; fe.title = `Read ${r.pages.length} page${r.pages.length === 1 ? "" : "s"}${r.skipped.length ? `; their robots.txt keeps ${r.skipped.length} out` : ""}: no address published. Call the number shown.`; }
        } catch (err) { fe.disabled = false; fe.textContent = "Find email"; dasSay(err.message); }
      };
      const em = tr.querySelector("[data-em]");
      if (em) em.onclick = async () => {
        em.disabled = true;
        try { prMailBox(await api(`/api/das/prospects/${encodeURIComponent(pid)}/email`), x); } catch (err) { dasSay(err.message); } finally { em.disabled = false; }
      };
      const jb = tr.querySelector("[data-job]");
      if (jb) jb.onclick = async () => {
        jb.disabled = true;
        try { const j = await post(`/api/das/prospects/${encodeURIComponent(pid)}/job`, {}); x.job_id = j.id; dasSay(`${x.name} is on the board as a Lead.`); paint(); }
        catch (err) { jb.disabled = false; dasSay(err.message); }
      };
      const op = tr.querySelector("[data-open]");
      if (op) op.onclick = () => { S.das.job = +op.dataset.open; S.das.sub = "overview"; S.das.rview = null; S.views.das($("#view")); };
    });
  };
  // the email: in the person's own mail (mailto), with the text to copy when the mail app doesn't open
  const prMailBox = (m, x) => {
    const box = $("#prMail"), href = `mailto:${encodeURIComponent(m.to || "")}?subject=${encodeURIComponent(m.subject)}&body=${encodeURIComponent(m.body)}`;
    box.innerHTML = `<div class="panel" style="margin-top:12px"><div class="row" style="justify-content:space-between"><b>First email to ${esc(x.name)}</b><button id="prMailX" title="Close">✕</button></div>
      <p class="hint">Opens in your own mail; RF Recon never sends it. ${m.to ? "" : "The public list has no email address for them: call the number above for the right person, then add their address. "}Set the status to contacted once it's sent. If they reply "no thanks", set Do not contact.</p>
      <label>Subject<input id="prMs" value="${esc(m.subject)}"></label><label>Message<textarea id="prMb" rows="12">${esc(m.body)}</textarea></label>
      <div class="row" style="gap:8px">${window.rfMail ? `<button class="primary" id="prMailSend" title="From your own mailbox; their reply sets the status (a no-thanks marks Do not contact)">✉ Send from my mail</button>` : ""}<a class="btn ${window.rfMail ? "" : "primary"}" id="prMailGo" href="${esc(href)}">Open in my mail</a><button id="prMailCopy">Copy the text</button></div>
      <div id="prMailSent"></div></div><div id="prMailThread"></div>`;
    const re = () => { $("#prMailGo").href = `mailto:${encodeURIComponent(m.to || "")}?subject=${encodeURIComponent($("#prMs").value)}&body=${encodeURIComponent($("#prMb").value)}`; };
    $("#prMs").oninput = re; $("#prMb").oninput = re;
    $("#prMailCopy").onclick = async () => { try { await navigator.clipboard.writeText(`Subject: ${$("#prMs").value}\n\n${$("#prMb").value}`); dasSay("Copied."); } catch (e) { $("#prMb").select(); dasSay("Press Ctrl+C to copy."); } };
    $("#prMailX").onclick = () => { box.innerHTML = ""; };
    if (window.rfMail) {
      rfMail.thread($("#prMailThread"), { prospect: x.id });
      $("#prMailSend").onclick = () => rfMail.compose($("#prMailSent"), { kind: "prospect", refs: { prospect_id: x.id }, title: `First email to ${x.name}`,
        to: $("#prMailTo")?.value || m.to || x.email || "", subject: $("#prMs").value, body: $("#prMb").value,
        onSent: () => { if (x.status === "new") x.status = "contacted"; rfMail.thread($("#prMailThread"), { prospect: x.id }); } });
    }
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const prMap = rows => {
    const m = $("#prMap"); if (!m || !window.L) return;
    P.ro?.disconnect();  // the old map's resize watcher, before that map goes
    if (P.map) { try { P.map.off(); P.map.remove(); } catch (e) { /* already torn down: nothing to show */ } }
    const map = P.map = L.map(m, { zoomControl: true, fadeAnimation: false, zoomAnimation: false }).setView(P.where, 11);
    addMapLayers(map);  // the person's own base map, offline tiles included (core.js)
    L.circle(P.where, { radius: P.radius * 1609.34, color: "#888", weight: 1, fill: false, interactive: false }).addTo(map);
    const pts = [];
    P.marks = new Map();
    for (const x of rows.slice(0, 1000)) {
      if (x.lat == null) continue;
      pts.push([x.lat, x.lon]);
      P.marks.set(x.id, L.circleMarker([x.lat, x.lon], { radius: x.priority === "high" ? 6 : 4, color: prDot(x), weight: 1, fillOpacity: .75 })
        .bindTooltip(() => { const n = P.need[x.id]; return `${esc(x.name)} · ${esc(PR_KIND[x.kind] || "")} · ${esc(x.status)}${n ? ` · RF need: ${(PR_NEED[n.ps] || PR_NEED.unknown)[0]}${prDb(n)} (estimate)` : ""}${x.trigger && !x.trigger.minor ? ` · ${esc(x.trigger.label)}` : ""}`; }).addTo(map)
        .on("click", () => { const tr = body.querySelector(`tr[data-pid="${CSS.escape(x.id)}"]`); if (tr) { tr.scrollIntoView({ block: "center" }); tr.classList.add("pr-hit"); setTimeout(() => tr.classList.remove("pr-hit"), 1500); } }));
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.1), { animate: false });
    (P.ro = new ResizeObserver(() => { if (P.map === map && m.isConnected) map.invalidateSize(); })).observe(m);
  };
  // the controls
  $("#prGo").onclick = async e => { e.target.disabled = true; try { P.where = await where(); P.q = ""; P.status = ""; await load(); } catch (x) { body.innerHTML = `<p class="status err">${esc(x.message)}</p>`; } finally { e.target.disabled = false; } };
  $("#prWhere").onkeydown = e => { if (e.key === "Enter") $("#prGo").click(); };
  $("#prPin") && ($("#prPin").onclick = () => { P.where = [S.center[0], S.center[1]]; P.label = "the search pin"; $("#prWhere").value = ""; load(); });
  $("#prJob") && ($("#prJob").onchange = e => { const j = jobs.find(x => x.id === +e.target.value); if (!j) return; P.where = [j.lat ?? j.data?.lat, j.lon ?? j.data?.lon]; P.label = j.name; $("#prWhere").value = ""; load(); });
  $("#prRadius").onchange = e => { P.radius = +e.target.value; load(); };
  $("#prTun") && ($("#prTun").onclick = e => window.dasFindTunnels(e, P, load, el));  // OpenStreetMap tunnels (dasx.js)
  $("#prHigh").onclick = async e => {
    if (!P.where) { dasSay("Pick where to look first."); return; }
    const r = Math.min(10, P.radius), msg = $("#prHighMsg");
    e.target.disabled = true; msg.textContent = `Reading Overture building heights within ${r} mi (about half a minute)…`;
    try { const got = await post("/api/das/prospects/highrises", { lat: P.where[0], lon: P.where[1], radius: r });
      msg.textContent = `${got.highrises.toLocaleString()} building${got.highrises === 1 ? "" : "s"} 75 ft or 7 floors and up within ${r} mi.`;
      if (!P.kinds.includes("high_rise")) { P.kinds.push("high_rise"); const c = el.querySelector('[data-k="high_rise"]'); if (c) c.checked = true; }
      load(); }
    catch (x) { msg.textContent = x.message; } finally { e.target.disabled = false; }
  };
  // All / None on each group of building types: one search (at least one type stays on)
  $("#prKinds").querySelectorAll(":scope > .row").forEach(row => window.rfChecks?.(row, { sel: "[data-k]", fold: false, word: "shown", head: row.querySelector("b"),
    commit: () => { P.kinds = [...$("#prKinds").querySelectorAll("[data-k]:checked")].map(c => c.dataset.k);
      if (!P.kinds.length) { const first = $("#prKinds").querySelector("[data-k]"); first.checked = true; P.kinds = [first.dataset.k]; }
      load(); } }));
  $("#prKinds").onchange = e => { const k = e.target.dataset.k; if (!k) return; P.kinds = e.target.checked ? [...new Set([...P.kinds, k])] : P.kinds.filter(x => x !== k); if (!P.kinds.length) { P.kinds = [k]; e.target.checked = true; } load(); };
  $("#prFirm") && ($("#prFirm").onclick = e => { e.preventDefault(); S.das.view = "pitch"; S.views.das($("#view")); });
  load();
};

// Data & updates › Building permits and certificates of occupancy: each city or county dataset's own switch (permits.py,
// static/research/permit_sources.json). On by default only where the provider's terms are clearly open; limited to the
// states set above. mission.js calls this for the source's row; the open/closed state survives the 15 s repaint.
window.PR_DS_OPEN = window.PR_DS_OPEN || false;
window.prDatasets = s => {
  const ds = s.datasets || [], on = ds.filter(d => d.enabled), here = ds.filter(d => d.in_states);
  const row = d => `<label class="pr-ds" style="display:flex;gap:8px;align-items:flex-start;flex-direction:row;margin:4px 0;min-height:32px">
      <input type="checkbox" data-pds="${esc(d.id)}" ${d.enabled ? "checked" : ""} style="width:auto;margin:3px 0 0;min-width:20px;min-height:20px">
      <span><b>${esc(d.place || "")}</b> · ${esc(d.name || d.id)} ${d.open ? "" : `<span class="tag" style="color:var(--warn)" title="${esc(d.license || "")}">terms not open: off unless you switch it on</span>`}
        ${d.in_states ? "" : `<span class="hint">(outside your states)</span>`}
        <div class="hint">${esc((d.license || "").slice(0, 160))}${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">dataset ↗</a>` : ""}${d.last_run ? ` · last pull ${esc(d.last_run)}, ${Number(d.rows || 0).toLocaleString()} kept` : ""}${d.error ? ` · <span style="color:var(--bad)">${esc(d.error.slice(0, 160))}</span>` : ""}</div></span></label>`;
  return `<details class="pr-dsbox" style="margin-top:6px" ${window.PR_DS_OPEN ? "open" : ""} ontoggle="window.PR_DS_OPEN=this.open">
    <summary class="hint">${on.length} of ${ds.length} datasets on${here.length < ds.length ? ` (${here.filter(d => d.enabled).length} in your states)` : ""}: choose which cities and counties</summary>
    <div style="max-height:360px;overflow:auto;margin-top:4px">${ds.map(row).join("")}</div>
    <p class="hint" style="margin:4px 0 0">Terms read on each provider's own page on 2026-11-04 (permit_sources.json). Columns naming people (owners, applicants) are never fetched.</p></details>`;
};
document.addEventListener("change", async e => {
  const c = e.target.closest?.("[data-pds]");
  if (!c) return;
  const box = c.closest(".pr-dsbox"), all = {};
  box.querySelectorAll("[data-pds]").forEach(x => { all[x.dataset.pds] = x.checked; });
  try { UPD = await post("/api/update/config", { sources: { permits: { datasets: all } } }); if (typeof paintSources === "function") paintSources(); }
  catch (err) { c.checked = !c.checked; (window.dasSay || alert)(err.message); }
});
