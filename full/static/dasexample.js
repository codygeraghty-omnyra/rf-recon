"use strict";
/* RF Recon — DAS example jobs and the step guide. Two worked jobs ship in static/das_examples (fictional buildings,
   people and companies; the ERCES one carries real FCC licences near its pin): a public safety ERCES office at
   Acceptance and a carrier cellular warehouse at Design. "Add example jobs" makes them from those files (job JSON as
   Job JSON exports it, then each floor's plan image into the job's files); a job whose data.example is set shows, on
   every step, what the step is for, what you fill in and what to look at in that example. The board's "How a DAS job
   moves" panel walks the stages. Hooks in das.js: dasBoardGuide (board, list, data) and dasJobGuide (each step). */

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

// each step: what it's for, what you fill in, and what to look at in each example (erces / cellular)
const DAS_STEP = {
  overview: ["The building, the people, the compliance dates and the test kit. The AHJ report pulls from here.",
    "Address and pin (Use current pin), floors, area and construction, the AHJ and code basis, each compliance date as it happens, and the test instruments with their calibration dates.",
    {erces: "Every compliance date is in, so the board card shows 7/7 checks, and the annual retest date came from the acceptance date. One calibrated instrument, the IBflex, took every scored reading.",
     cellular: "Only the permit date is set: the public safety checks don't apply to a carrier-only DAS. The COMPASS XR that walked the building is the instrument."}],
  presurvey: ["Which radio systems serve the building and how strong they are, outside and inside, from the FCC data. The systems the AHJ requires become the channel plan.",
    "Set the radius, the building loss and the level needed inside. Tick the systems the AHJ requires (Tick fire, police, EMS, 911 is a start), run Terrain paths, and print the consent letters.",
    {erces: "Two Arlington County systems are ticked: the 800 MHz trunked system KNIQ704 and VHF KIC338. Their 21 channels are saved as the channel plan, so Design and the report work even on a copy without this area's FCC data. Free space says every system clears −95 dBm inside; the walk test said otherwise (Overview notes).",
     cellular: "For a carrier DAS, look at the panel at the bottom: the rooftop donor per carrier (AT&T meets the −85 dBm target, Verizon the minimum only, T-Mobile is below it), each carrier's approval path, and the dates the consent requests went out."}],
  plans: ["Floor plans: a PDF page per floor, saved as an image under that floor's grid test and design.",
    "Add the builder's PDF set and give each floor its page, or send the plan request letter. CAD files: ask for a PDF export.",
    {erces: "Each floor already has its plan image (Files). The building data panel is OpenStreetMap's for the pin: this building is fictional.",
     cellular: "The warehouse plan is in Files and under the floor's grid test. The building data panel is OpenStreetMap's for the pin: this building is fictional."}],
  require: ["The pass rules: this AHJ's numbers and the building's critical areas; for a carrier DAS, the cellular target.",
    "Pick the AHJ's profile or type its numbers, tick the critical areas and add any the AHJ names. For a carrier DAS, pick a cellular target and the carriers that must pass.",
    {erces: "IFC 2021 + NFPA 1225: −95 dBm, DAQ 3.0, 95% of general areas, 99% of critical areas, 12-hour battery. Five critical areas, each tested on its own on the Grid test.",
     cellular: "The cellular target is Common: RSRP −95 dBm and SINR 5 dB on 95% of the area, for AT&T, Verizon and T-Mobile."}],
  design: ["Whether the system will work before it's built: a link budget per band, antennas and walls on the plans with predicted coverage, and the battery.",
    "Per band: the signal at the roof, donor gain and cable, booster gains and power, and the passive network to the farthest antenna. Then place antennas and draw walls on each floor, and list the battery loads.",
    {erces: "Both bands pass every check. Uplink gain is low (35 and 30 dB) because the agency sites are close: more gain puts too much signal and noise into their receivers. Six antennas a floor predict 100% coverage. Battery: 12 hours plus 20%.",
     cellular: "B2 (AT&T) and B13 (Verizon) pass. B71 (T-Mobile) fails on purpose: its rooftop donor is below the minimum, and booster gain can't fix a weak, noisy donor. Twelve panels predict about 91% of the floor at −95 dBm RSRP on B2."}],
  materials: ["The bill of materials.",
    "Pick parts from the research list or type lines, and tick the material rules (UL 2524, NEMA 4, the 2-hour pathway).",
    {erces: "A typical bill for this design: donor antennas, the donor run, a fiber head end and remotes, ceiling antennas, splitters, the battery and the annunciator.",
     cellular: "Donor antennas per carrier, the horizontal cable, the panel antennas and the splitters and couplers. The Link budget can take its cable runs from here."}],
  grid: ["The test: readings in each square of each floor, scored against the AHJ's rules. Only readings from a calibrated instrument count.",
    "Pick Taken with, then click squares to enter readings or Import results from your tool. Mark Do not test and Critical squares, test the named critical areas on the right, and save the acceptance baseline.",
    {erces: "All three floors pass. Each square has two channels, and the worse one decides. Square 3-5 passes by 0.5 dB (its note says to recheck; Screening shows why). Square 2-12 also holds an SDR reading: kept, not counted. Square 1-16, the fire pump room, carries the AHJ witness note.",
     cellular: "This is the walk before design, from a COMPASS XR report. Use Show to pick a carrier: most squares miss the target today, and T-Mobile drops out deep in the racking (squares 13 and 18). The public safety cards read 0% because no public safety readings were taken; a carrier DAS is scored per carrier."}],
  screen: ["Each Grid test reading judged with its instrument's published accuracy: likely pass, too close to call, likely fail. The Grid test's score doesn't change.",
    "Nothing new: it reads the Grid test. Check each instrument under Instruments is judged as the right model; an SDR or phone reading isn't judged.",
    {erces: "Taken with the IBflex (±1 dB). Every square passes the Grid test, but square 3-5 (floor 3) is too close to call: its VHF channel is 0.5 dB over the line, inside the IBflex's accuracy, so the witnessed walk could fail it. Square 2-12's SDR reading is listed but not judged.",
     cellular: "Nothing to judge: this job's readings are cellular (LTE and 5G), which the Grid test's carrier view scores. Screening covers public safety channels."}],
  pim: ["Passive intermodulation: the test of the cable network's connectors and parts, done at install.",
    "Add each run: where, the two tones, the result. Fix and retest any failure, and tick the checklists.",
    {erces: "The floor 2 branch failed at −135 dBc: a loose connector, found 84 ft out with distance-to-PIM. It was retorqued and passed at −149 dBc.",
     cellular: "Empty: PIM is tested after install. The ERCES example shows a failed run and its retest."}],
  files: ["Everything kept with the job: plans, exports, photos and reports.",
    "Add files here. Plan pages saved under Plans land here too.",
    {erces: "The three floor plan images the example uses.", cellular: "The warehouse plan image the example uses."}],
  log: ["Every change, note and import, with its time: the job's history.",
    "Nothing to fill in: changes log themselves. Add notes for calls, visits and decisions.",
    {erces: "How this example was made.", cellular: "How this example was made."}],
  report: ["The report for the AHJ: building, code, instruments, the grid results per floor, critical areas, and a cellular section when there is one.",
    "Print it or save it as a PDF once the grid test passes. It pulls everything from the other steps.",
    {erces: "A passing acceptance report, ready to print.",
     cellular: "A design-stage report: the cellular section shows the walk per carrier, the rooftop donors and the consent requests."}]};

const dasExPref = (k, d) => { try{ return localStorage.getItem(k) ?? d; }catch(e){ return d; } };
const dasExKeep = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };

// make the example jobs from the shipped files; one already on the board (same name) is left as it is
async function dasAddExamples(msg){
  const idx = await (await fetch(DAS_EX_DIR + "index.json", {cache: "no-cache"})).json();
  const have = new Set(((await api("/api/das/jobs")).jobs || []).map(j => j.name));
  let added = 0, skipped = 0;
  for(const ex of idx.examples){
    if(have.has(ex.name)){ skipped++; continue; }
    msg(`Adding ${ex.name}…`);
    const x = await (await fetch(DAS_EX_DIR + ex.file, {cache: "no-cache"})).json();
    const j = await post("/api/das/jobs", {name: x.name, stage: x.stage, data: x.data});
    for(const p of ex.plans){
      const img = await fetch(DAS_EX_DIR + p, {cache: "no-cache"}); if(!img.ok) throw new Error(`plan ${p}: ${img.status}`);
      await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(p)}`, {method: "POST", body: await img.arrayBuffer()}); }
    added++; }
  return {added, skipped};
}

// the board, list and Data & links: how a job moves, and the button that adds the examples
window.dasBoardGuide = (el, D) => {
  if(!el || ["contacts","prospects","pitch"].includes(D.view)) return;  // the board's guide, not the outreach views
  const open = dasExPref("rfr.dasFlow", "1") === "1", hasEx = (D.jobs || []).some(j => /\(example\)$/.test(j.name));
  el.innerHTML = `<details class="panel" id="dxFlow" ${open ? "open" : ""} style="margin-bottom:10px">
    <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none">
      <h3 style="margin:0">How a DAS job moves <span class="hint">· stage by stage, and the steps that do it</span></h3>
      <span style="margin-left:auto" class="row"><button id="dxAdd" title="Two worked jobs to open and learn from: a public safety ERCES office at Acceptance and a carrier cellular warehouse at Design. Fictional buildings, people and companies.">＋ Add example jobs</button></span></summary>
    <div class="tw wrap" style="margin-top:8px"><table><thead><tr><th>Stage</th><th>What happens</th><th>Where in the job</th></tr></thead><tbody>
      ${DAS_FLOW.map(([s, what, where]) => `<tr><td><b>${esc(s)}</b></td><td>${esc(what)}</td><td class="hint">${esc(where)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint" id="dxMsg" style="margin:6px 0 0">${hasEx ? "The example jobs are on the board: open one, and each step says what it's for, what you fill in and what to look at."
      : "Add example jobs puts two finished jobs on the board to open and learn from: a public safety ERCES office at Acceptance and a carrier cellular warehouse at Design. Each step in them explains itself. Delete them when you're done; add them again any time."}</p></details>`;
  // found inside el, not the page: a board drawn after the view moved on (a slow redraw) is detached, and $ would miss it
  el.querySelector("#dxFlow").addEventListener("toggle", e => dasExKeep("rfr.dasFlow", e.target.open ? "1" : "0"));
  el.querySelector("#dxAdd").onclick = async e => { e.preventDefault(); const b = e.currentTarget, m = t => { const x = el.querySelector("#dxMsg"); if(x) x.textContent = t; };
    b.disabled = true;
    try{ const r = await dasAddExamples(m); m(r.added ? `Added ${r.added} example job${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already here)` : ""}. Open one to start.` : "Both example jobs are already on the board.");
      if(r.added) render(); }
    catch(err){ m(`Couldn't add the examples: ${err.message}`); }
    b.disabled = false; };
};

// an example job: what this step is for, what you fill in, and what to look at in this example
window.dasJobGuide = (el, j, sub) => {
  const kind = (j.data || {}).example; if(!el || !kind) return;
  const s = DAS_STEP[sub] || DAS_STEP.overview, look = s[2][kind] || s[2].erces;
  el.innerHTML = `<div class="panel no-print" style="margin:0 0 10px;border-left:4px solid var(--accent)">
    <h3 style="margin:0 0 4px">Example job <span class="hint">· ${kind === "cellular" ? "carrier cellular DAS, at Design" : "public safety ERCES, at Acceptance"}; fictional building, people and companies</span></h3>
    <div class="kvg"><div>This step</div><div>${esc(s[0])}</div><div>You fill in</div><div>${esc(s[1])}</div><div>In this example</div><div>${esc(look)}</div></div></div>`;
};
