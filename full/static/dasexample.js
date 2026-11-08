"use strict";
/* DAStastic — DAS example jobs and the step guide. Four worked jobs ship in static/das_examples (fictional buildings,
   people and companies; the ERCES ones carry real FCC licences near their pin): two mid-way, to learn each step (a public
   safety ERCES office at Acceptance, a carrier cellular warehouse at Design), and the same two finished, In service, to
   see the end result (Cody 11/4: "show me a completed job example for both cellular and ERCES"). "Add example jobs"
   makes them (the shared set, or a team login's own private copies) from those files (job JSON as Job JSON exports it, then each floor's plan image and the job's other files);
   a finished one then gets its history from the server (dasexample.py: its people, the supplier quotes compared, the
   licensees' consent, the dated log and the mail, every address a .example one, nothing sent). A job whose data.example
   is set shows, on every step, what the step is for, what you fill in and what to look at in that example. The board's
   "How a DAS job moves" panel walks the stages. Hooks in das.js: dasBoardGuide (board, list, data) and dasJobGuide.
   The finished jobs' numbers come from the app's own code: tools/das_examples_build.mjs. */

const DAS_EX_DIR = "static/das_examples/";  // relative, so the web version (full/static/...) finds them too

// the stages of a job, what happens in each, and the steps (sub-tabs) that do it
const DAS_FLOW = [
  ["Lead", "A building that may need coverage: the client, the address, the AHJ.", "Overview"],
  ["Pre-survey", "Which radio systems serve it and how strong they are inside; a walk test before design; consent requests go out.", "Pre-survey, Grid test (the walk), Requirements"],
  ["Design", "Link budget per band, antennas and walls on the plans, battery, bill of materials; the AHJ approves the design and issues the permit.", "Plans, Design, Materials"],
  ["Install", "Booster, cable, antennas and monitoring to the fire alarm panel; PIM tests on the cable network.", "Materials, PIM"],
  ["Commission", "Gains set and checked, the FCC registration (Class B), consent on file, monitoring connected.", "Overview (Compliance), Design"],
  ["Acceptance", "The grid test, with the AHJ's witness where asked; the report goes to the fire code official.", "Grid test, Report"],
  ["In service", "Monitored; the annual retest is tracked from the acceptance date and compared with the baseline.", "Overview, Grid test"],
  ["Closed", "Finished, handed over, or lost.", "Log"]];

// each step: what it's for, what you fill in, and what to look at in each example: erces / cellular mid-way, and
// erces_done / cellular_done finished
const DAS_STEP = {
  overview: ["The building, the people, the compliance dates and the test kit. The AHJ report pulls from here.",
    "Address and pin (Use current pin), floors, area and construction, the AHJ and code basis, each compliance date as it happens, and the test instruments with their calibration dates.",
    {erces: "Every compliance date is in, so the board card shows 7/7 checks, and the annual retest date came from the acceptance date. One calibrated instrument, the IBflex, took every scored reading.",
     cellular: "Only the permit date is set: the public safety checks don't apply to a carrier-only DAS. The COMPASS XR that walked the building is the instrument.",
     erces_done: "In service since the fire marshal accepted it on 2026-10-27. All seven compliance dates are in. Lifecycle: the annual test is due 2027-10-27 and the five-year retest 2031-10-27, both from the acceptance date; the UL 2524 3rd-edition check is done; the licensee's consent renews 2027-09-02. People: the fire marshal, the owner, the agency's radio shop, the GC, the electrical sub and our technician. Testing: the IBflex and the S412E, each with its calibration certificate in Files. Monitoring: the BDA, its alarm traps from the supervisory test at commissioning, each one cleared. With a mailbox connected, Mail shows the job's emails: the plans, the consent, the design approval and the report.",
     cellular_done: "In service since the owner accepted it on 2026-09-30. Permit, carrier consent, design, battery and acceptance dates are in; the FCC registration and fire alarm monitoring are public safety checks a carrier-only DAS doesn't have. Monitoring: the booster's alarm traps from the alarm test at install, each one cleared. The COMPASS XR's calibration certificate is in Files. With a mailbox connected, Mail shows the three carriers' consent replies."}],
  presurvey: ["Which radio systems serve the building and how strong they are, outside and inside, from the FCC data. The systems the AHJ requires become the channel plan.",
    "Set the radius, the building loss and the level needed inside. Tick the systems the AHJ requires (Tick fire, police, EMS, 911 is a start), run Terrain paths, and print the consent letters.",
    {erces: "Two Arlington County systems are ticked: the 800 MHz trunked system KNIQ704 and VHF KIC338. Their 21 channels are saved as the channel plan, so Design and the report work even on a copy without this area's FCC data. Free space says every system clears −95 dBm inside; the walk test said otherwise (Overview notes).",
     cellular: "For a carrier DAS, look at the panel at the bottom: the rooftop donor per carrier (AT&T meets the −85 dBm target, Verizon the minimum only, T-Mobile is below it), each carrier's approval path, and the dates the consent requests went out.",
     erces_done: "The same two Arlington County systems, each donor path over the terrain clear (Terrain paths). Licensees in the booster's passbands: the systems' licensee consented, and its letter (a fictional sample) is in Files. The other licensees the booster passes are marked not needed for the example only: a real job gets each one's consent or records why it isn't needed.",
     cellular_done: "The rooftop donors as built: T-Mobile's first donor was below the minimum, so a second one aims at another T-Mobile site (20°, −84 dBm, SINR 7 dB). AT&T, Verizon and T-Mobile each consented under 47 CFR 20.21(c): the dates and references are in the approval column."}],
  plans: ["Floor plans: a PDF page per floor, saved as an image under that floor's grid test and design.",
    "Add the builder's PDF set and give each floor its page, or send the plan request letter. CAD files: ask for a PDF export.",
    {erces: "Each floor already has its plan image (Files). The building data panel is OpenStreetMap's for the pin: this building is fictional.",
     cellular: "The warehouse plan is in Files and under the floor's grid test. The building data panel is OpenStreetMap's for the pin: this building is fictional.",
     erces_done: "The architect's PDF set came back by email and is in Files; each floor's page is saved as an image under its grid test and design. The building data panel is OpenStreetMap's for the pin: this building is fictional.",
     cellular_done: "The owner's plan is in Files and under the floor's grid test. The building data panel is OpenStreetMap's for the pin: this building is fictional."}],
  require: ["The pass rules: this AHJ's numbers and the building's critical areas; for a carrier DAS, the cellular target.",
    "Pick the AHJ's profile or type its numbers, tick the critical areas and add any the AHJ names. For a carrier DAS, pick a cellular target and the carriers that must pass.",
    {erces: "IFC 2021 + NFPA 1225: −95 dBm, DAQ 3.0, 95% of general areas, 99% of critical areas, 12-hour battery. Five critical areas, each tested on its own on the Grid test.",
     cellular: "The cellular target is Common: RSRP −95 dBm and SINR 5 dB on 95% of the area, for AT&T, Verizon and T-Mobile.",
     erces_done: "The IFC 2021 preset with its source: −95 dBm, DAQ 3.0, 95% of general and 99% of critical areas, a 12-hour battery, and the IFC 510.5.4 failed-area rule. Five named critical areas.",
     cellular_done: "Common: RSRP −95 dBm and SINR 5 dB on 95% of the area, for AT&T, Verizon and T-Mobile."}],
  audit: ["An existing system's audit: a booster already in the building, checked against today's rules, with the findings on the AHJ report.",
    "Turn it on for a takeover, an annual retest of another firm's system, or an FCC interference notice; fill in the booster, its passbands and its papers.",
    {erces: "Not used: the system is new.", cellular: "Not used: the system is new.", erces_done: "Not used: the system is new.", cellular_done: "Not used: the system is new."}],
  design: ["Whether the system will work before it's built: a link budget per band, antennas and walls on the plans with predicted coverage, and the battery.",
    "Per band: the signal at the roof, donor gain and cable, booster gains and power, and the passive network to the farthest antenna. Then place antennas and draw walls on each floor, and list the battery loads.",
    {erces: "Both bands pass every check. Uplink gain is low (35 and 30 dB) because the agency sites are close: more gain puts too much signal and noise into their receivers. Six antennas a floor predict 100% coverage. Battery: 12 hours plus 20%.",
     cellular: "B2 (AT&T) and B13 (Verizon) pass. B71 (T-Mobile) fails on purpose: its rooftop donor is below the minimum, and booster gain can't fix a weak, noisy donor. Twelve panels predict about 91% of the floor at −95 dBm RSRP on B2.",
     erces_done: "Both bands pass every check of the link budget, and every antenna passes its own budget: a seventh antenna in each elevator lobby covers the core's shadow, and the uplink gain is set 3 dB (800 MHz) and 6 dB (VHF) under the mid-way design so no radio near an antenna reaches the agency over −75 dBm. The core's concrete walls are drawn; every grid square is predicted to pass. Battery by NFPA 1225 18.13.2: 12 hours plus 20%, two strings of 12 V 100 Ah. The submittal's cover sheet has the project, occupancy, construction type, designer and installer.",
     cellular_done: "B2 (AT&T), B13 (Verizon) and B71 (T-Mobile) all pass: the second T-Mobile donor fixed B71. Thirteen 9 dBi panels: twelve down the aisles and one in the office block behind the CMU wall. Every panel passes its own budget; a 10 W booster on B2 carries the higher gain."}],
  commission: ["Commissioning the booster step by step: isolation, gain and filter settings, the donor-site noise test, oscillation, the donor level, and the talk-back test. Each step's result goes into the acceptance tests on the Report.",
    "Type what the analyzer and the BDA show, or import a trace; pick the AHJ's numbers. Each step grades itself.",
    {erces: "Not done in the mid-way example.", cellular: "Not done in the mid-way example.",
     erces_done: "All six steps pass by NFPA 1225 (2022): the noise at the KNIQ704 site rose under 1 dB with the booster on, isolation is 44 dB over the gain, the gains and filters are recorded, no oscillation and the shutdown worked, the donor reads −47 dBm, and every talk-back call was clear, one within 10 ft of an antenna and one at the farthest point.",
     cellular_done: "What applies to an industrial booster: each carrier's NOC read under 1 dB of uplink noise rise, isolation is 23 dB or more over the gain, the gains and filters match the consents, no oscillation, the donor levels are recorded, and test calls on all three carriers were clear."}],
  materials: ["The bill of materials.",
    "Pick parts from the research list or type lines, and tick the material rules (UL 2524, NEMA 4, the 2-hour pathway).",
    {erces: "A typical bill for this design: donor antennas, the donor run, a fiber head end and remotes, ceiling antennas, splitters, the battery and the annunciator.",
     cellular: "Donor antennas per carrier, the horizontal cable, the panel antennas and the splitters and couplers. The Link budget can take its cable runs from here.",
     erces_done: "Every line has a part number, quantity and price. Two suppliers quoted the whole list (Quotes from suppliers, with their emails); the best split, each line from its cheapest supplier, is the one on the bill. Every material rule is ticked.",
     cellular_done: "Every line has a part number, quantity and price. Two suppliers quoted; the best split is on the bill. Every material rule is ticked."}],
  grid: ["The test: readings in each square of each floor, scored against the AHJ's rules. Only readings from a calibrated instrument count.",
    "Pick Taken with, then click squares to enter readings or Import results from your tool. Mark Do not test and Critical squares, test the named critical areas on the right, and save the acceptance baseline.",
    {erces: "All three floors pass. Each square has two channels, and the worse one decides. Square 3-5 passes by 0.5 dB (its note says to recheck; Screening shows why). Square 2-12 also holds an SDR reading: kept, not counted. Square 1-16, the fire pump room, carries the AHJ witness note.",
     cellular: "This is the walk before design, from a COMPASS XR report. Use Show to pick a carrier: most squares miss the target today, and T-Mobile drops out deep in the racking (squares 13 and 18). The public safety cards read 0% because no public safety readings were taken; a carrier DAS is scored per carrier.",
     erces_done: "Every floor passes IFC 510.5.4 with no failed area, from the calibrated IBflex, and the five named critical areas pass. Open Walk: each floor has an IBflex spot at the centre of every square and a continuous walk logged along the corridors, as heat maps; each square takes the spot nearest its centre. The walk also holds a BDA off pass (the walk before design) and a BDA on pass (commissioning); the grid uses Acceptance, and the Report compares BDA off with it. All 12 acceptance tests are recorded and pass. These results are the acceptance baseline the annual retests compare with.",
     cellular_done: "Show opens on the first carrier: AT&T, Verizon and T-Mobile each pass in all 20 squares, from the COMPASS XR. A carrier-only job has no public safety channels, so it is judged per carrier. Open Walk: a Pixel 8 on AT&T walked the aisles; Phone correction shows its table against the COMPASS XR (six pairs on band 2), and its readings are corrected by it. Phone readings are indicative and never scored."}],
  screen: ["Each Grid test reading judged with its instrument's published accuracy: likely pass, too close to call, likely fail. The Grid test's score doesn't change.",
    "Nothing new: it reads the Grid test. Check each instrument under Instruments is judged as the right model; an SDR or phone reading isn't judged.",
    {erces: "Taken with the IBflex (±1 dB). Every square passes the Grid test, but square 3-5 (floor 3) is too close to call: its VHF channel is 0.5 dB over the line, inside the IBflex's accuracy, so the witnessed walk could fail it. Square 2-12's SDR reading is listed but not judged.",
     cellular: "Nothing to judge: this job's readings are cellular (LTE and 5G), which the Grid test's carrier view scores. Screening covers public safety channels.",
     erces_done: "Every square likely passes: each passes by more than the IBflex's ±1 dB.",
     cellular_done: "Nothing to judge: this job's readings are cellular, which the Grid test's carrier view scores. Screening covers public safety channels."}],
  pim: ["Passive intermodulation: the test of the cable network's connectors and parts, done at install.",
    "Add each run: where, the two tones, the result. Fix and retest any failure, and tick the checklists.",
    {erces: "The floor 2 branch failed at −135 dBc: a loose connector, found 84 ft out with distance-to-PIM. It was retorqued and passed at −149 dBc.",
     cellular: "Empty: PIM is tested after install. The ERCES example shows a failed run and its retest.",
     erces_done: "Three sweeps pass (return loss over 14 dB on both donor lines and the riser). The install's PIM runs, with the floor 2 branch that failed at −135 dBc and passed at −149 dBc after a retorque. Every checklist is done.",
     cellular_done: "Three sweeps of the aisle trunks pass (return loss over 14 dB). Four PIM runs at 2 × 43 dBm on the booster output and the trunks, all better than the −150 dBc limit. Every checklist is done."}],
  files: ["Everything kept with the job: plans, exports, photos and reports.",
    "Add files here. Plan pages saved under Plans land here too.",
    {erces: "The three floor plan images the example uses.", cellular: "The warehouse plan image the example uses.",
     erces_done: "The architect's plan set and each floor's page, the as-built drawings, the licensee's consent letter, the spec sheets, both calibration certificates, and the acceptance report the fire marshal accepted (the app's own report, printed and sealed). All fictional samples.",
     cellular_done: "The warehouse plan, the booster's spec sheet, the COMPASS XR's calibration certificate and the acceptance report (the app's own report, printed and sealed). All fictional samples."}],
  log: ["Every change, note and import, with its time: the job's history.",
    "Nothing to fill in: changes log themselves. Add notes for calls, visits and decisions.",
    {erces: "How this example was made.", cellular: "How this example was made.",
     erces_done: "The job's history, dated, from the first site walk in July to In service on 2026-10-30.",
     cellular_done: "The job's history, dated, from the first call in June to In service on 2026-09-30."}],
  report: ["The report for the AHJ: building, code, instruments, the grid results per floor, critical areas, and a cellular section when there is one.",
    "Print it or save it as a PDF once the grid test passes. It pulls everything from the other steps.",
    {erces: "A passing acceptance report, ready to print.",
     cellular: "A design-stage report: the cellular section shows the walk per carrier, the rooftop donors and the consent requests.",
     erces_done: "Result PASS: every floor and every named critical area, the 12 acceptance tests, the instruments and their certificates, the compliance dates, the people, the licensees' consent, the sweeps and the walk's heat maps. The packet index finds every item the AHJ's list asks for. Signed by the tester and sealed: the verify code and date print on every page, and the seal still matches the job.",
     cellular_done: "A commercial cellular coverage test, judged per carrier: PASS, each carrier and layer listed under the result, then the floor page, the rooftop donors and the carrier approvals. No public safety system is in this job, so no emergency responder parts appear. Signed by the tester and sealed with its verify code."}]};

const dasExPref = (k, d) => { try{ return localStorage.getItem(k) ?? d; }catch(e){ return d; } };
const dasExKeep = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } };
const DAS_EX_NAME = /\((completed )?example\)$/;  // every example job's name ends so

// a team login makes its own copies (Cody 11/5: "let them make their own too"): the shared set stays as it is, each copy
// is named for the login and opens for it and the admin only. The admin and the PC add the shared set, as before
const dasExWho = () => String(S.remote?.user || "").split("@")[0];
// what Add example jobs last said: the board redraws once the jobs are in, and that would wipe it, a failed history included
let dasExSaid = null;
const dasExRecent = () => dasExSaid && Date.now() - dasExSaid.at < 60000 ? dasExSaid.text : "";
const dasExName = (name, who) => who ? name.replace(/ (\((completed )?example\))$/, `, ${who}'s copy $1`) : name;

// make the example jobs from the shipped files; one already on the board (same name) is left as it is. A finished one
// gets its history (people, quotes, consent, log, mail) from the server; if that part fails the job stays, and says so
async function dasAddExamples(msg){
  const idx = await (await fetch(DAS_EX_DIR + "index.json", {cache: "no-cache"})).json();
  const have = new Set(((await api("/api/das/jobs")).jobs || []).map(j => j.name));
  let added = 0, skipped = 0; const short = [], who = dasExWho();
  for(const ex of idx.examples){
    const jobName = dasExName(ex.name, who);
    if(have.has(jobName)){ skipped++; continue; }
    msg(`Adding ${jobName}…`);
    const x = await (await fetch(DAS_EX_DIR + ex.file, {cache: "no-cache"})).json();
    const j = await post("/api/das/jobs", {name: jobName, stage: x.stage, data: x.data});
    if(who) await post(`/api/das/jobs/${j.id}/access`, {who: "*", level: "none"});  // a new job opens for the whole team: this one is theirs
    // plans keep their own names; other files ship under plain names and are kept under the name the job knows them by
    for(const [name, src] of [...(ex.plans || []).map(p => [p, p]), ...Object.entries(ex.files || {})]){
      const f = await fetch(DAS_EX_DIR + src, {cache: "no-cache"}); if(!f.ok) throw new Error(`${src}: ${f.status}`);
      await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(name)}`, {method: "POST", body: await f.arrayBuffer()}); }
    if(x.seed){ try{ await post(`/api/das/jobs/${j.id}/example`, x.seed); }catch(e){ short.push(`${x.name}: its history wasn't added (${e.message})`); } }
    added++; }
  return {added, skipped, short};
}

// the board, list and Data & links: how a job moves, and the button that adds the examples
window.dasBoardGuide = (el, D) => {
  if(!el || ["contacts","register","prospects","pitch","fault"].includes(D.view)) return;  // the board's guide, not the outreach views or the lists
  const open = dasExPref("rfr.dasFlow", "1") === "1", hasEx = (D.jobs || []).some(j => DAS_EX_NAME.test(j.name));
  const four = "two mid-way, to learn each step (a public safety ERCES office at Acceptance, a carrier cellular warehouse at Design), and two finished, to see the end result (the same office and warehouse, In service)";
  const who = dasExWho(), own = who ? `Add example jobs makes your own copy of all four, named “${who}'s copy”. Only you and the admin can open them, so change anything you like; the team's stay as they are. Delete yours when you're done; add them again any time.` : "";
  el.innerHTML = `<details class="panel" id="dxFlow" ${open ? "open" : ""} style="margin-bottom:10px">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none">
      <h3 style="margin:0">How a DAS job moves <span class="hint">· stage by stage, and the steps that do it</span></h3>
      <span style="margin-left:auto" class="row"><button id="dxAdd" title="Four worked jobs to open and learn from: ${esc(four)}. Fictional buildings, people and companies.">＋ Add example jobs</button></span></summary>
    <div class="tw wrap" style="margin-top:8px"><table><thead><tr><th>Stage</th><th>What happens</th><th>Where in the job</th></tr></thead><tbody>
      ${DAS_FLOW.map(([s, what, where]) => `<tr><td><b>${esc(s)}</b></td><td>${esc(what)}</td><td class="hint">${esc(where)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint" id="dxMsg" style="margin:6px 0 0">${dasExRecent() ? esc(dasExRecent()) : hasEx ? "The example jobs are on the board: the two named “(example)” stop mid-way, to learn each step; the two named “(completed example)” are finished, to see the end result. Open one, and each step says what it's for, what you fill in and what to look at." + (own ? " " + esc(own) : "")
      : own ? `${esc(own)} They are ${esc(four)}.` : `Add example jobs puts four jobs on the board: ${esc(four)}. Each step in them explains itself. Fictional buildings, people and companies. Delete them when you're done; add them again any time.`}</p></details>`;
  // found inside el, not the page: a board drawn after the view moved on (a slow redraw) is detached, and $ would miss it
  el.querySelector("#dxFlow").addEventListener("toggle", e => dasExKeep("rfr.dasFlow", e.target.open ? "1" : "0"));
  el.querySelector("#dxAdd").onclick = async e => { e.preventDefault(); const b = e.currentTarget, m = t => { const x = el.querySelector("#dxMsg"); if(x) x.textContent = t; };
    b.disabled = true;
    try{ const r = await dasAddExamples(m);
      const said = r.added ? `Added ${r.added} example job${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already here)` : ""}. Open one to start.${r.short.length ? ` ${r.short.join(" · ")}` : ""}` : `All four ${who ? "of your own copies" : "example jobs"} are already on the board.`;
      m(said);
      if(r.added){ dasExSaid = {text: said, at: Date.now()}; render(); } }
    catch(err){ m(`Couldn't add the examples: ${err.message}`); }
    b.disabled = false; };
};

// an example job: what this step is for, what you fill in, and what to look at in this example
window.dasJobGuide = (el, j, sub) => {
  const d = j.data || {}, kind = d.example; if(!el || !kind) return;
  const done = !!d.example_complete, s = DAS_STEP[sub] || DAS_STEP.overview, look = s[2][`${kind}${done ? "_done" : ""}`] || s[2][kind] || s[2].erces;
  const what = kind === "cellular" ? (done ? "carrier cellular DAS, finished and In service" : "carrier cellular DAS, at Design")
    : (done ? "public safety ERCES, finished and In service" : "public safety ERCES, at Acceptance");
  el.innerHTML = `<div class="panel no-print" style="margin:0 0 10px;border-left:4px solid var(--accent)">
    <h3 style="margin:0 0 4px">${done ? "Completed example job" : "Example job"} <span class="hint">· ${what}; fictional building, people and companies</span></h3>
    <div class="kvg"><div>This step</div><div>${esc(s[0])}</div><div>You fill in</div><div>${esc(s[1])}</div><div>In this example</div><div>${esc(look)}</div></div></div>`;
};
