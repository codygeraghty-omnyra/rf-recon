"use strict";
/* RF Recon — Start: one job, step by step, for someone with no RF background (Cody 11/5, picked from a preview). Four steps, each
   a set of plain questions with drop-downs, each ending in something to hand over: Discovery, Survey, Design, AHJ package.
   Nothing here is a second copy of the tool. A Start job is an ordinary DAS job: the answers go in its record (data.guided), the
   fields the full tool also shows go in that tool's own keys (client, address, lat, lon, area_sqft, construction, presurvey), and
   every number comes from the routes the DAS tab uses, so the two can't disagree. Every tab stays where it is.
   The checklist is enforced: Next waits until each question is answered and a No has a note. Skip takes a reason, is kept on the
   job and prints on the deliverable, so a skipped step can't pass for a finished one. */
(() => {
const STEPS = [
  {id: "discovery", label: "Discovery", goal: "What does this building need?", out: "Discovery report"},
  {id: "survey", label: "Survey", goal: "Walk the building and test the signal.", out: "Survey summary"},
  {id: "design", label: "Design", goal: "Plan the system and list the parts.", out: "Design package"},
  {id: "ahj", label: "AHJ package", goal: "Hand the AHJ what it asks for.", out: "AHJ package"}];
const stepOf = id => STEPS.findIndex(s => s.id === id);
const YES_NO = ["Yes", "No", "Not applicable"];
// to: the full tool's own field for the same answer
const BUILDING = [
  {k: "client", to: "client", q: "What's the building or client called?", type: "text"},
  {k: "address", to: "address", q: "What's the address?", type: "address", why: "Pick it from the list so the job lands on the right building."},
  {k: "building_type", q: "What kind of building is it?", opts: ["Office", "Apartments or condos", "School", "College", "Hospital or medical", "Hotel", "Retail or mall", "Warehouse or industrial", "Parking garage", "Government", "Stadium or arena", "Something else"]},
  {k: "floors_up", q: "How many floors above ground?", opts: ["1", "2", "3", "4 to 6", "7 to 12", "13 to 25", "26 or more"]},
  {k: "floors_down", q: "How many floors below ground?", opts: ["None", "1", "2", "3 or more"], why: "Basements and garages are where radios fail first."},
  {k: "area", to: "area_sqft", q: "About how many square feet?", type: "number", why: "A rough number is fine."},
  {k: "construction", to: "construction", q: "What's it built from?", opts: () => Object.keys(DAS.loss), why: "This sets how much signal the walls take out."},
  {k: "why", q: "Why is this coming up now?", opts: ["The fire marshal asked for it", "New construction", "A renovation", "It failed a radio test", "The owner wants better coverage", "Not sure yet"]},
  {k: "scope", q: "What does the job cover?", opts: ["Public safety radio", "Cellular", "Both"]}];
const WALK = [
  ["Getting in", [["access_all", "Can someone let you into every floor, the roof and the electrical rooms?"], ["plans", "Do you have the floor plans?"], ["contact", "Do you know who runs the building day to day?"]]],
  ["Head-end room", [["he_room", "Did you find a room for the head-end equipment?"], ["he_power", "Does that room have a dedicated power circuit, or space to add one?"], ["he_ground", "Is there a ground bar in or near that room?"], ["he_panel", "Do you know where the fire alarm panel is?"]]],
  ["Getting between floors", [["riser", "Is there a riser or path from floor to floor?"], ["rated", "Do you know if that path has to be fire-rated? Ask the AHJ if not."]]],
  ["Roof", [["roof_access", "Can you get onto the roof?"], ["donor_mount", "Is there a spot to mount a donor antenna with a clear view out?"], ["roof_path", "Is there a cable path from the roof to the head-end room?"]]],
  ["Photos", [["photos", "Are photos of the head-end room, riser, roof spot, power and panel in the job's Files?"]]]];
const WALK_KEYS = WALK.flatMap(s => s[1].map(q => q[0]));
const GRID_HOW = ["Load the floor plans first: each floor is split into squares on its plan.",
  "Set up your receiver on the channels from the Discovery report, the ones the AHJ says the building must carry.",
  "Walk each floor and take a reading in every square, standing near its centre.",
  "Test the critical areas too: fire pump room, stairwells, standpipe cabinets and any others the AHJ names.",
  "Bring the file from your receiver into the Grid test, or type the readings in."];
// what to look at when a grid test fails, in the order a technician would. Shown only when one has
const FAILED_CHECK = ["Is the head-end powered on, with no alarms showing?", "Are the donor antenna and its cable connected, and is it aimed at the right site?",
  "Is the booster's gain set correctly, and has it shut itself down?", "Do the failed squares share a branch? Check that branch's splitter, cable and connectors.",
  "Are the failed squares in one place, like a stairwell or a far corner? It may need another antenna.", "Did a door, a fire shutter or new construction change since the plan?",
  "Was the receiver set to the right channels, and is its calibration in date?", "Run a PIM and sweep test on the failed branch.",
  "Check that the system isn't interfering with itself or the donor: isolation between antennas.", "Retest the failed squares, and keep the first result on file."];
const STILL_TO_CALL = ["Confirm with the AHJ who signs off, and what it wants in writing. The AHJ has the final say on this building: what it tells you in writing wins over anything printed here.",
  "Ask the radio shop which system the building has to carry, and which channels.",
  "Whether a building falls under a subsystem of a shared system isn't in any public record: only the radio shop knows.",
  "A level on this page is a model. Only a walk test measures the building."];
const G = S.start = S.start || {job: null, step: null, draft: {}, disc: {}, took: null};
// the app redraws the open tab whenever a search lands: a mission's own search can finish while someone's typing here, and a
// redraw would wipe the form. Start draws for its own changes only (G.sig), and when it's come back to from another tab.
const redraw = () => { G.sig = null; render(); };
const fmt = n => Number(n || 0).toLocaleString();
const say = t => { if (window.dasSay) dasSay(t); else alert(t); };
const gOf = d => (d && d.guided) || {};
const skipped = (d, id) => (gOf(d).skips || {})[id];

/* ---------- where a job stands ---------- */
function designChecks(d) {
  const bom = Array.isArray(d.bom) ? d.bom : [], sc = dasScope(d), floors = Array.isArray(d.floors) ? d.floors : [];
  const named = bom.filter(x => x.part).length, priced = bom.filter(x => x.price != null && x.price !== "").length;
  const out = [["plans", "Floor plans are in the job", floors.length > 0, floors.length ? `${floors.length} floor${floors.length === 1 ? "" : "s"}` : "None yet", "plans"],
    ["budget", "The design has its bands and antennas", !!(d.design && (Object.keys(d.design.bands || {}).length || (d.design.cell_bands || []).length)), "", "design"],
    ["bom", "The parts list is started", bom.length > 0, bom.length ? `${bom.length} lines` : "No lines yet", "materials"],
    ["parts", "Every line has a part number", bom.length > 0 && named === bom.length, bom.length ? `${named} of ${bom.length}` : "", "materials"],
    ["prices", "Every line has a price", bom.length > 0 && priced === bom.length, bom.length ? `${priced} of ${bom.length}` : "", "materials"]];
  if (sc.ps) out.push(["consent", "Consent is asked for from each licensee", Object.keys(d.consents || {}).length > 0, `${Object.keys(d.consents || {}).length} on file`, "presurvey"]);
  return out;
}
const designDone = d => designChecks(d).every(c => c[2]);
function gridRead(d) {
  const keys = Object.keys((d.grid || {}).results || {});  // one per square: "floor|square"
  return {floors: new Set(keys.map(k => k.split("|")[0])).size, squares: keys.length};
}
function gridFails(d) {
  const out = {fails: [], uncounted: 0}; DASJ = dasProfile(d.profile);
  for (const f of Array.isArray(d.floors) ? d.floors : []) { try { const s = floorStats(d, f); out.uncounted += s.notCounted; if (s.fails.length) out.fails.push(`${f.name}: ${s.fails.length} square${s.fails.length === 1 ? "" : "s"}`); } catch (e) { /* a floor with no grid yet: nothing to say */ } }
  return out;
}
function walkLeft(d) {
  const a = gOf(d).answers || {};
  return WALK_KEYS.filter(k => !a[k] || (a[k] === "No" && !String(a[`${k}_note`] || "").trim()));
}
const stepDone = (d, id) => id === "discovery" ? !!gOf(d).discovery : id === "survey" ? !walkLeft(d).length && gridRead(d).squares > 0 && !gridFails(d).uncounted : id === "design" ? designDone(d) : !!(gOf(d).done || {}).ahj;
const stepClear = (d, id) => stepDone(d, id) || !!skipped(d, id);
function currentStep(d) { const s = STEPS.find(x => !stepClear(d, x.id)); return s ? s.id : "ahj"; }

/* ---------- saving ---------- */
async function saveJob(j, patch) {
  try { return await post(`/api/das/jobs/${j.id}`, {data: patch, rev: j.rev}); }
  catch (e) { say("Not saved: " + e.message); return null; }
}
function guidedPatch(d, more) { return {...gOf(d), ...more}; }

/* ---------- the questions ---------- */
function field(q, val) {
  const id = `st_${q.k}`, opts = typeof q.opts === "function" ? q.opts() : q.opts;
  let ctl;
  if (opts) ctl = `<select id="${id}" data-q="${q.k}"><option value="">Choose…</option>${opts.map(o => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  else ctl = `<input id="${id}" data-q="${q.k}" ${q.type === "address" ? 'data-k="address" autocomplete="off"' : ""} type="${q.type === "number" ? "number" : "text"}" value="${esc(val ?? "")}">`;
  return `<div class="st-q" data-for="${q.k}"><label for="${id}">${esc(q.q)}</label>${ctl}${q.why ? `<span class="hint">${esc(q.why)}</span>` : ""}</div>`;
}
const buildingAnswers = el => Object.fromEntries([...el.querySelectorAll("[data-q]")].map(x => [x.dataset.q, x.value.trim()]));
const missingOf = a => BUILDING.filter(q => !a[q.k]);

/* ---------- the first page: new job, or carry on with one ---------- */
async function landing(v) {
  let jobs = [];
  try { jobs = (await api("/api/das/jobs")).jobs || []; } catch (e) { /* no jobs to list: the form still works */ }
  const rows = await Promise.all(jobs.slice(0, 40).map(x => api(`/api/das/jobs/${x.id}`).catch(() => null)));
  const mine = rows.filter(j => j && j.data && j.data.guided);
  const landOn = (() => { try { return localStorage.getItem("rfr.landing") === "start"; } catch (e) { return false; } })();
  v.innerHTML = `<div class="st"><div class="st-hero"><h2>Start a job</h2><p>Answer a few questions about the building. RF Recon works out what it needs, then takes you through it one step at a time, to the package the AHJ signs off.</p></div>
    <div class="panel"><h3>The building</h3><div class="st-form" id="stForm">${BUILDING.map(q => field(q, G.draft[q.k])).join("")}</div>
      <p class="status err" id="stLeft" hidden></p>
      <div class="st-next"><button class="primary" id="stGo">Build the Discovery report</button></div></div>
    ${mine.length ? `<div class="panel"><h3>Carry on with a job</h3><div class="st-jobs">${mine.map(j => { const c = currentStep(j.data), n = stepOf(c) + 1;
      return `<button data-open="${j.id}"><b>${esc(j.name)}</b><span class="hint">${esc(j.data.address || "")}</span><span class="st-pill">Step ${n} of 4: ${esc(STEPS[n - 1].label)}</span></button>`; }).join("")}</div></div>` : ""}
    <p class="hint st-foot">This is the guided way through. Everything RF Recon does is still on the tabs above. <label class="inl"><input type="checkbox" id="stLand" ${landOn ? "checked" : ""}> Open RF Recon here</label></p></div>`;
  wireForm(v, null);
  v.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { G.job = +b.dataset.open; G.step = null; redraw(); });
  document.getElementById("stLand").onchange = e => { try { if (e.target.checked) localStorage.setItem("rfr.landing", "start"); else localStorage.removeItem("rfr.landing"); } catch (err) { /* storage blocked: stays as it was */ } };
}
function wireForm(v, j) {
  const form = v.querySelector("#stForm"), addr = form.querySelector('[data-q="address"]');
  addr.addEventListener("rf-addr", e => { G.took = e.detail; });
  addr.addEventListener("input", () => { G.took = null; });
  v.querySelector("#stGo").onclick = async () => {
    const a = buildingAnswers(form), left = missingOf(a), msg = v.querySelector("#stLeft");
    G.draft = {...G.draft, ...a};
    form.querySelectorAll(".st-q").forEach(x => x.classList.toggle("left", left.some(q => q.k === x.dataset.for)));
    if (left.length) { msg.hidden = false; msg.textContent = left.length === 1 ? `One left: ${left[0].q}` : `${left.length} questions left. They're marked.`; return; }
    msg.hidden = true;
    const b = v.querySelector("#stGo"); b.disabled = true; b.textContent = "Finding the building…";
    try {
      const place = await locate(a.address, j);
      if (!place) { msg.hidden = false; msg.textContent = "That address didn't place on the map. Pick it from the list, or type its latitude and longitude."; return; }
      const data = {client: a.client, address: a.address, lat: place.lat, lon: place.lon, area_sqft: +a.area, construction: a.construction};
      if (j) data.guided = guidedPatch(j.data, {answers: {...(gOf(j.data).answers || {}), ...a}, discovery: null});
      else data.guided = {answers: a};
      const saved = j ? await post(`/api/das/jobs/${j.id}`, {name: a.client, data, rev: j.rev}) : await post("/api/das/jobs", {name: a.client, stage: "Lead", data});
      G.job = saved.id; G.draft = {}; G.took = null; G.step = "discovery"; G.disc[saved.id] = null;
      redraw();
    } catch (e) { msg.hidden = false; msg.textContent = "Not saved: " + e.message; }
    finally { b.disabled = false; b.textContent = "Build the Discovery report"; }
  };
}
async function locate(address, j) {
  const ll = parseLoc(address); if (ll) return {lat: ll[0], lon: ll[1]};
  if (G.took && G.took.lat != null) return {lat: G.took.lat, lon: G.took.lon};
  if (j && j.data.address === address && j.data.lat != null) return {lat: j.data.lat, lon: j.data.lon};
  const r = await api(`/api/geocode?q=${encodeURIComponent(address)}`).catch(() => null), hit = (r && (r.results || r.places || r)) || [];
  const first = Array.isArray(hit) ? hit.find(x => x.lat != null) : null;
  return first ? {lat: first.lat, lon: first.lon} : null;
}

/* ---------- step 1: the Discovery report. The pre-survey's numbers, the same routes as the DAS tab, on one page ---------- */
const THRESHOLD = -95;
async function discoveryData(j) {
  const d = j.data, ok = async p => { try { return await p; } catch (e) { return {_error: e.message}; } };
  let [ps, ahj, bdc, cells, spec, bld] = await Promise.all([
    ok(api(`/api/das/presurvey?lat=${d.lat}&lon=${d.lon}&radius=15&job=${j.id}&threshold=${THRESHOLD}&env=suburban`)),
    ok(api(`/api/das/x/ahj/${j.id}`)), ok(api(`/api/bdc/at?lat=${d.lat}&lon=${d.lon}`)), ok(api(`/api/cells?lat=${d.lat}&lon=${d.lon}&radius=5`)),
    ok(api(`/api/spectrum?lat=${d.lat}&lon=${d.lon}`)), ok(api(`/api/das/building?lat=${d.lat}&lon=${d.lon}`))]);
  // a cellular job needs the sites: fetched once for an area and kept, as the Cellular panel's button does
  if (gOf(d).answers?.scope !== "Public safety radio" && !(cells.sites || []).length) {
    const got = await ok(post("/api/cells/fetch", {lat: d.lat, lon: d.lon}));
    if (got.rows) cells = await ok(api(`/api/cells?lat=${d.lat}&lon=${d.lon}&radius=5`));
  }
  const systems = ps.systems || [], top = systems.filter(s => s.tier === 1), deciding = decidingSystem(systems, ahj, spec);
  const lead = [...(deciding ? [deciding] : []), ...(top.length ? top : systems).filter(s => s !== deciding)].slice(0, 8);
  let contacts = {};
  if (lead.length) { const r = await ok(api(`/api/das/x/contacts?calls=${encodeURIComponent(lead.map(s => s.call_sign).join(","))}`)); contacts = r.contacts || {}; }
  return {ps, ahj, bdc, cells, spec, bld, systems, top, lead, contacts, deciding};
}
// the system that decides, by the rule RF need uses (need.py point_levels): the strongest in the best tier here, preferring one
// licensed to an agency named like the building's town. Counting every agency within 15 miles overclaims: most don't serve it.
function decidingSystem(systems, ahj, spec) {
  const have = systems.filter(s => s.real); if (!have.length) return null;
  const tier = Math.min(...have.map(s => s.tier ?? 9)), pool = have.filter(s => (s.tier ?? 9) === tier);
  const w = ahj.where || {}, names = [w.place, w.county, String((spec && spec.county) || "").split(",")[0]].filter(Boolean).map(x => x.replace(/ (county|city|town)$/i, "").toLowerCase());
  const local = pool.filter(s => names.some(n => n && (s.licensee || "").toLowerCase().includes(n)));
  return (local.length ? local : pool).slice().sort((a, b) => b.real.in_dbm - a.real.in_dbm)[0];
}
function verdictOf(R, cellOnly) {
  if (cellOnly) return ["Cellular job", "Coverage inside comes from each carrier's approval: start with the carriers below."];
  if (R.ps._error) return ["No estimate", `The estimate didn't run: ${R.ps._error}`];
  if (!R.systems.length) return ["No systems found", "No licensed radio systems came back within 15 miles. Ask the fire marshal what the building has to carry."];
  const s = R.deciding, below = !["None", undefined, ""].includes((R.answers || {}).floors_down);
  if (!s) return ["Ask for a walk test", `${R.lead.length} systems here have no power on file, so there's no estimate. A walk test decides.`];
  const caution = below ? " The estimate is for floors above ground: below ground it's weaker." : "";
  return s.real.margin_db < 0 ? ["A system is likely needed", `The main radio system here is ${s.licensee}. Even it looks too weak inside this building on the estimate, so an in-building system is likely needed.${caution} A walk test decides.`]
    : ["It may pass without one", `The main radio system here is ${s.licensee}. It looks strong enough inside on the estimate, which runs pessimistic on upper floors.${caution} A walk test decides.`];
}
function bandsLine(R) {
  const m = new Map();
  for (const s of (R.top.length ? R.top : R.lead)) for (const c of s.down || []) if (c.band) m.set(c.band, (m.get(c.band) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
const printHead = (j, title) => `<div class="st-print-head"><div><b>${esc(title)}</b><div>${esc(j.name)}${j.data.address ? ` · ${esc(j.data.address)}` : ""}</div></div><div>RF Recon · ${esc(today())}</div></div>`;
const skipNote = (d, id) => { const s = skipped(d, id); return s ? `<p class="st-skip">Skipped by ${esc(s.by || "the user")} on ${esc(s.at)}: ${esc(s.why)}</p>` : ""; };
function contactLine(c) {
  const e = c && ((c.contact && c.contact.has_address) ? c.contact : c.licensee); if (!e) return "";
  return [e.attention || e.name, (c.contact && c.contact.phone) || e.phone, (c.contact && c.contact.email) || e.email].filter(Boolean).join(" · ");
}
function discoveryHtml(j, R) {
  const d = j.data, a = gOf(d).answers || {}, sc = a.scope, ps = sc !== "Cellular", cell = sc !== "Public safety radio";
  R.answers = a;
  const [head, line] = verdictOf(R, !ps), bands = bandsLine(R);
  const suggest = (R.ahj.suggestions || []).slice(0, 3), near = {};
  for (const s of R.cells.sites || []) { const k = carrierName(s.operator); if (!near[k] || s.dist_mi < near[k].dist_mi) near[k] = s; }
  const held = (R.spec && R.spec.carriers) || [], cov = (R.bdc && R.bdc.carriers) || [], names = [...new Set([...cov.map(c => carrierName(c.brand)), ...held.map(c => carrierName(c.brand)), ...Object.keys(near)])].filter(n => CELL_CARRIERS.map(carrierName).includes(n));
  const rows = [["Building", [a.building_type, a.floors_up && `${a.floors_up} floors up`, a.floors_down && a.floors_down !== "None" && `${a.floors_down} below ground`, a.area && `${fmt(a.area)} sq ft`, a.construction].filter(Boolean).join(" · ")], ["Why now", a.why], ["Covers", sc]];
  return `${printHead(j, "Discovery report")}
    <div class="st-verdict"><h2>${esc(head)}</h2><p>${esc(line)}</p></div>
    <div class="kvg">${rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v || "")}</div>`).join("")}</div>
    <h4>Who decides</h4><p class="st-auth">The AHJ, usually the fire marshal, has final authority over this building. What's in the code they have to enforce, and they can require more.</p>
    ${suggest.length ? `<table><thead><tr><th>Most likely AHJ</th><th>Phone</th><th>Why</th></tr></thead><tbody>${suggest.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.phone || "")}</td><td>${esc(x.why || "")}</td></tr>`).join("")}</tbody></table>`
      : `<p class="hint">${esc(R.ahj.error || "No department list on this copy. Ask the city or county for the fire marshal's office.")}</p>`}
    ${ps ? `<h4>Public safety radio</h4>${bands.length ? `<p>In play here: <b>${esc(bands.join(", "))}</b>.</p>` : ""}
      ${R.lead.length ? `<table><thead><tr><th>System</th><th>Call sign</th><th>Band</th><th>Technology</th><th>Inside (estimate)</th></tr></thead><tbody>${R.lead.map(s => {
        const b = [...new Set((s.down || []).map(c => c.band).filter(Boolean))].join(", "), shop = contactLine(R.contacts[s.call_sign]);
        return `<tr><td>${esc(s.licensee)}${s === R.deciding ? ' <b class="st-main">main system</b>' : ""}${s.trunked ? ' <span class="hint">trunked</span>' : ""}${shop ? `<div class="hint">Radio shop: ${esc(shop)}</div>` : ""}</td><td class="mono">${esc(s.call_sign)}</td><td>${esc(b)}</td><td>${esc((s.tech || []).join(" / "))}</td>
          <td>${s.real ? `${s.real.margin_db < 0 ? "Too weak" : "Looks OK"}` : '<span class="hint">no power on file</span>'}</td></tr>`; }).join("")}</tbody></table>
        <p class="hint">${fmt(R.systems.length)} systems within 15 miles. The first ones are the agencies a building usually has to carry. The radio shop is the FCC's contact on the licence: it can be a consulting engineer.</p>` : ""}` : ""}
    ${cell ? `<h4>Cellular</h4>${names.length ? `<table><thead><tr><th>Carrier</th><th>Coverage here (FCC map)</th><th>Closest known site</th><th>Bands it holds here</th></tr></thead><tbody>${names.map(n => {
      const s = near[n], c = cov.filter(x => carrierName(x.brand) === n).map(x => x.tech), h = held.filter(x => carrierName(x.brand) === n).flatMap(x => (x.bands || []).map(b => b.band));
      return `<tr><td>${esc(n)}</td><td>${esc([...new Set(c)].join(", ") || "None reported")}</td><td>${s ? `${num(s.dist_mi, 2)} mi${s.compass ? ` ${esc(s.compass)}` : ""}` : '<span class="hint">None known yet</span>'}</td><td>${esc([...new Set(h)].join(", "))}</td></tr>`; }).join("")}</tbody></table>
      <p class="hint">Sites are crowd-mapped, and a licence doesn't prove a block is on the air. Each carrier has to approve its own signal in the building.</p>` : '<p class="hint">No carrier data here yet.</p>'}` : ""}
    <h4>What still takes a phone call</h4><ul>${STILL_TO_CALL.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    <p class="hint">Estimates only: free public records, read ${esc(today())}. The details behind every line are on the job's Pre-survey tab.</p>`;
}
async function stepDiscovery(el, j) {
  const d = j.data;
  el.innerHTML = `<div class="panel" id="stDisc"><p class="status">Working out what this building needs. This reads FCC licences, towers, carriers and fire departments, and can take a few seconds.</p></div>`;
  const R = G.disc[j.id] || (G.disc[j.id] = await discoveryData(j));
  if (!el.isConnected) return;
  const [head] = verdictOf(R, gOf(d).answers?.scope === "Cellular");
  if (!gOf(d).discovery) {
    const inc = (d.presurvey || {}).include || [], tick = inc.length ? inc : R.top.map(s => s.call_sign);
    const patch = {guided: guidedPatch(d, {discovery: {at: today(), verdict: head, systems: R.systems.length, top: R.top.length}})};
    if (tick.length && !inc.length) patch.presurvey = {...(d.presurvey || {}), include: tick};  // the agencies it found are ticked on the job's Pre-survey
    const got = await saveJob(j, patch); if (got) j = got;
  }
  el.innerHTML = `<div class="panel st-report" id="stReport">${discoveryHtml(j, R)}</div>
    <div class="st-next"><button id="stEdit">Change the answers</button><button id="stPrint">⎙ Print or save the report</button><button class="primary" id="stNext">Next: Survey</button></div>`;
  el.querySelector("#stPrint").onclick = () => dasPrintCopy(el.querySelector("#stReport"));
  el.querySelector("#stEdit").onclick = () => editBuilding(el, j);
  el.querySelector("#stNext").onclick = () => { G.step = "survey"; redraw(); };
}
function editBuilding(el, j) {
  const a = {...(gOf(j.data).answers || {}), address: j.data.address || ""};
  el.innerHTML = `<div class="panel"><h3>The building</h3><div class="st-form" id="stForm">${BUILDING.map(q => field(q, a[q.k])).join("")}</div>
    <p class="status err" id="stLeft" hidden></p><div class="st-next"><button class="primary" id="stGo">Build the Discovery report</button></div></div>`;
  wireForm(el, j);
}

/* ---------- step 2: the walk, enforced, and the grid test ---------- */
function stepSurvey(el, j) {
  const d = j.data, a = gOf(d).answers || {}, grid = gridRead(d), left = walkLeft(d), {fails, uncounted} = gridFails(d);
  const box = ([k, q]) => { const v = a[k] || ""; return `<div class="st-q${v ? "" : " open"}" data-for="${k}"><label for="st_${k}">${esc(q)}</label>
    <select id="st_${k}" data-walk="${k}"><option value="">Choose…</option>${YES_NO.map(o => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>
    ${v === "No" ? `<input data-note="${k}" placeholder="What's the plan? This goes on the summary." value="${esc(a[`${k}_note`] || "")}">` : ""}</div>`; };
  el.innerHTML = `<div class="panel"><h3>Walk the building <span class="hint">· ${WALK_KEYS.length - left.length} of ${WALK_KEYS.length} done</span></h3>
      ${WALK.map(([t, qs]) => `<h4>${esc(t)}</h4><div class="st-form">${qs.map(box).join("")}</div>`).join("")}</div>
    <div class="panel"><h3>Test the signal</h3>
      <p>The grid test measures each floor in squares. You'll need a survey receiver or a tester the AHJ accepts, and it goes on the Grid test tab, or import the file your receiver makes.</p>
      <details class="st-how"><summary>How to run the test</summary><ol>${GRID_HOW.map(x => `<li>${esc(x)}</li>`).join("")}</ol><p class="hint">The AHJ's own rules set the pass mark and the number of squares. They're on the job's Requirements tab.</p></details>
      <p>${grid.squares ? `<b>${fmt(grid.squares)} squares</b> measured on ${grid.floors} floor${grid.floors === 1 ? "" : "s"}.` : "No squares measured yet."}</p>
      ${uncounted ? `<p class="st-skip">${fmt(uncounted)} reading${uncounted === 1 ? " doesn't" : "s don't"} count yet: a grid test needs a calibrated instrument on the job. Add it on the Overview tab, with its calibration date. <button data-tab="overview">Open the Overview</button></p>` : ""}
      ${fails.length ? `<div class="st-failed"><b>Failed: ${esc(fails.join(", "))}.</b><p>Work through these before you retest.</p><ol>${FAILED_CHECK.map(x => `<li>${esc(x)}</li>`).join("")}</ol></div>` : ""}
      <div class="st-next" style="justify-content:flex-start"><button data-tab="grid">Open the Grid test</button><button data-tab="files">Open the job's Files</button></div></div>
    ${skipBox("survey", d)}
    <div class="st-next"><button id="stBack">Back</button><button id="stPrint">⎙ Print or save the summary</button><button class="primary" id="stNext" ${stepClear(d, "survey") ? "" : "disabled"}>Next: Design</button></div>
    <p class="hint st-why" id="stWhy">${stepClear(d, "survey") ? "" : left.length ? `${left.length} question${left.length === 1 ? "" : "s"} left. A No needs a note.` : uncounted ? "The grid test's readings don't count yet." : "The grid test isn't in yet."}</p>
    <div id="stPrintBox" hidden>${surveySummary(j)}</div>`;
  let cur = j;
  const keep = async patchA => { const got = await saveJob(cur, {guided: guidedPatch(cur.data, {answers: {...(gOf(cur.data).answers || {}), ...patchA}})}); if (got) { cur = got; stepSurvey(el, cur); } };
  el.querySelectorAll("[data-walk]").forEach(s => s.onchange = () => keep({[s.dataset.walk]: s.value}));
  el.querySelectorAll("[data-note]").forEach(s => s.onchange = () => keep({[`${s.dataset.note}_note`]: s.value.trim()}));
  wireCommon(el, cur, "survey");
}
function surveySummary(j) {
  const d = j.data, a = gOf(d).answers || {}, grid = gridRead(d);
  return `${printHead(j, "Survey summary")}${skipNote(d, "survey")}
    ${WALK.map(([t, qs]) => `<h4>${esc(t)}</h4><table><tbody>${qs.map(([k, q]) => `<tr><td>${esc(q)}</td><td style="white-space:nowrap">${esc(a[k] || "Not answered")}</td><td>${esc(a[`${k}_note`] || "")}</td></tr>`).join("")}</tbody></table>`).join("")}
    <h4>Grid test</h4><p>${grid.squares ? `${fmt(grid.squares)} squares measured on ${grid.floors} floor${grid.floors === 1 ? "" : "s"}. The job's report holds the results.` : "Not measured yet."}</p>`;
}

/* ---------- step 3: design, checked against the job ---------- */
function stepDesign(el, j) {
  const d = j.data, cs = designChecks(d);
  el.innerHTML = `<div class="panel"><h3>What the design needs <span class="hint">· ${cs.filter(c => c[2]).length} of ${cs.length} done</span></h3>
      <p>Design happens on the job's own tabs. Each line here opens the right one, and ticks itself when the job has it.</p>
      <div class="st-checks">${cs.map(([k, t, ok, note, tab]) => `<div class="st-check ${ok ? "ok" : ""}"><span class="st-mark" aria-hidden="true">${ok ? "✓" : ""}</span><span><b>${esc(t)}</b>${note ? ` <span class="hint">${esc(note)}</span>` : ""}</span><button data-tab="${tab}">${ok ? "Open" : "Do this"}</button></div>`).join("")}</div></div>
    <div class="panel"><h3>The design package</h3><p>The parts list and each part's spec sheet, in one file for the integrator and the AHJ.</p>
      <div class="st-next" style="justify-content:flex-start"><a class="btn" href="/api/das/jobs/${j.id}/packet" download>⇩ Parts list and spec sheets</a><button data-tab="materials">Open Materials</button></div></div>
    ${skipBox("design", d)}
    <div class="st-next"><button id="stBack">Back</button><button class="primary" id="stNext" ${stepClear(d, "design") ? "" : "disabled"}>Next: AHJ package</button></div>
    <p class="hint st-why" id="stWhy">${stepClear(d, "design") ? "" : `${cs.filter(c => !c[2]).length} left.`}</p>`;
  wireCommon(el, j, "design");
}

/* ---------- step 4: the AHJ's own list, checked against the job ---------- */
async function stepAhj(el, j) {
  const d = j.data;
  el.innerHTML = `<div class="panel"><p class="status">Reading the AHJ's list…</p></div>`;
  DASJ = dasProfile(d.profile);
  let R = null, files = [];
  try { files = (await api(`/api/das/jobs/${j.id}/files`)).files || []; } catch (e) { /* the list still reads, with no files found */ }
  try { R = ahjPacketRows(d, await ahjPackets(), files); } catch (e) { /* no list: the buttons below still work */ }
  if (!el.isConnected) return;
  const rows = R ? R.rows.filter(x => x.state !== "outside") : [], missing = rows.filter(x => x.state === "missing");
  const blocked = Object.keys(gOf(d).skips || {});
  el.innerHTML = `<div class="panel"><h3>${R ? esc(R.pk.doc || "What the AHJ asks for") : "What the AHJ asks for"} <span class="hint">· ${rows.length - missing.length} of ${rows.length} in the job</span></h3>
      <p class="st-auth">The AHJ has final authority. This list is what the published code asks for, and what the AHJ tells you in writing wins.</p>
      ${missing.length ? `<ul>${missing.slice(0, 14).map(x => `<li>${esc(x.t)}${x.app ? ` <span class="hint">· ${esc(x.app)}</span>` : ""}</li>`).join("")}</ul>${missing.length > 14 ? `<p class="hint">${missing.length - 14} more on the job's Report tab.</p>` : ""}` : rows.length ? "<p>Everything on the list is in the job.</p>" : ""}
      ${blocked.length ? `<p class="st-skip">Skipped steps print on the package: ${esc(blocked.map(b => STEPS[stepOf(b)].label).join(", "))}.</p>` : ""}
      <div class="st-next" style="justify-content:flex-start"><button class="primary" data-tab="report">Open the report to print or seal</button><a class="btn" href="/api/das/jobs/${j.id}/packet" download>⇩ Parts list and spec sheets</a></div></div>
    <div class="st-next"><button id="stBack">Back</button><button class="primary" id="stFinish">${gOf(d).done?.ahj ? "Delivered" : "Mark as delivered to the AHJ"}</button></div>`;
  wireCommon(el, j, "ahj");
  el.querySelector("#stFinish").onclick = async () => { const got = await saveJob(j, {guided: guidedPatch(d, {done: {...(gOf(d).done || {}), ahj: today()}})}); if (got) { G.step = "ahj"; redraw(); } };
}

/* ---------- what every step shares ---------- */
function skipBox(id, d) {
  const s = skipped(d, id);
  return s ? `<div class="panel st-skip-panel"><p class="st-skip">Skipped on ${esc(s.at)}: ${esc(s.why)}</p><button id="stUnskip">Take the skip back</button></div>`
    : stepDone(d, id) ? "" : `<details class="st-skipper"><summary>Skip this step</summary><p class="hint">Skipping takes a reason. It stays on the job and prints on the deliverable.</p>
      <div class="st-next" style="justify-content:flex-start"><input id="stSkipWhy" placeholder="Why it's being skipped" style="flex:1;min-width:200px"><button id="stSkip">Skip</button></div></details>`;
}
function wireCommon(el, j, id) {
  const d = j.data;
  el.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => openTool(j.id, b.dataset.tab));
  const back = el.querySelector("#stBack"); if (back) back.onclick = () => { G.step = STEPS[Math.max(0, stepOf(id) - 1)].id; redraw(); };
  const next = el.querySelector("#stNext"); if (next && id !== "discovery") next.onclick = () => { G.step = STEPS[stepOf(id) + 1].id; redraw(); };
  const print = el.querySelector("#stPrint"); if (print && id === "survey") print.onclick = () => { const box = el.querySelector("#stPrintBox"); box.hidden = false; dasPrintCopy(box); box.hidden = true; };
  const sk = el.querySelector("#stSkip");
  if (sk) sk.onclick = async () => { const why = el.querySelector("#stSkipWhy").value.trim(); if (!why) { el.querySelector("#stSkipWhy").focus(); return; }
    const got = await saveJob(j, {guided: guidedPatch(d, {skips: {...(gOf(d).skips || {}), [id]: {why, at: today(), by: (S.me && S.me.user) || ""}}})}); if (got) redraw(); };
  const un = el.querySelector("#stUnskip");
  if (un) un.onclick = async () => { const s = {...(gOf(d).skips || {})}; delete s[id]; const got = await saveJob(j, {guided: guidedPatch(d, {skips: s})}); if (got) redraw(); };
}
// the job in the full tool, with a way back here
function openTool(id, sub) {
  S.das = S.das || {view: "board", q: "", job: null, sub: "overview"};
  S.das.view = "board"; S.das.job = id; S.das.sub = sub; S.das.fromStart = id; setTab("das");
}
window.startOpenJob = id => { G.job = id; G.step = null; if (S.das) S.das.fromStart = null; setTab("start"); };
window.startBackBar = (el, j) => {
  if (!el) return;
  if (!S.das || S.das.fromStart !== j.id) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="st-back no-print"><button id="stBackBar">← Back to Start</button><span class="hint">Everything you do here is saved on the job.</span></div>`;
  document.getElementById("stBackBar").onclick = () => { S.das.fromStart = null; G.job = j.id; G.step = null; S.das.job = null; setTab("start"); };
};

/* ---------- the page ---------- */
S.views.start = async v => {
  if (G.sig && G.sig === `${G.job}|${G.step}` && v.querySelector(".st")) return;
  if (!G.job) { G.sig = `${G.job}|${G.step}`; return landing(v); }
  let j; try { j = await api(`/api/das/jobs/${G.job}`); } catch (e) { G.job = null; return landing(v); }
  const d = j.data || {}, step = G.step || currentStep(d), n = stepOf(step);
  G.step = step; G.sig = `${G.job}|${G.step}`;
  v.innerHTML = `<div class="st"><div class="st-top"><button id="stAll">← All jobs</button><div><h2>${esc(j.name)}</h2><p class="hint">${esc(d.address || "")}</p></div>
      <button id="stFull" title="This job on the DAS tab, with every tool">Open in the full tool</button></div>
    <ol class="st-steps">${STEPS.map((s, i) => { const done = stepDone(d, s.id), skip = !!skipped(d, s.id), can = i === 0 || STEPS.slice(0, i).every(x => stepClear(d, x.id));
      return `<li><button data-step="${s.id}" class="${s.id === step ? "on" : ""} ${done ? "done" : ""}" ${can ? "" : "disabled"} aria-current="${s.id === step ? "step" : "false"}"><span class="st-n">${done ? "✓" : i + 1}</span><span>${esc(s.label)}${skip ? " (skipped)" : ""}</span></button></li>`; }).join("")}</ol>
    <p class="st-goal">${esc(STEPS[n].goal)}</p><div id="stBody"></div></div>`;
  v.querySelector("#stAll").onclick = () => { G.job = null; G.step = null; redraw(); };
  v.querySelector("#stFull").onclick = () => openTool(j.id, "overview");
  v.querySelectorAll("[data-step]").forEach(b => b.onclick = () => { G.step = b.dataset.step; redraw(); });
  const body = v.querySelector("#stBody");
  ({discovery: stepDiscovery, survey: stepSurvey, design: stepDesign, ahj: stepAhj}[step])(body, j);
};
})();
