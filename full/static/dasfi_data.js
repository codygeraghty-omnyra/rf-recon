"use strict";
/* The DAS fault isolation chart's content (dasfi.js draws it). Every number traces to RF Recon's code or research, tagged on the step. */
(() => {
/* DAS fault isolation chart: the stage runbooks. PREVIEW ONLY (Cody 2026-11-05: "Preview first").
   Every number here comes from das-fi-facts.md: the app's own constants, its research files, or a rule as cited there.
   Tags: A = RF Recon checks this. R = a code, FCC rule or AHJ document, read second-hand. E = research or vendor document.
   P = field practice with no source in our research: confirm it. Steps run quickest safe check first, never a claim about
   what is most likely. Ids: a tree is R1, F4; a step inside one is lower case. */
const FI = { trees: [] };
const A = t => ["a", t], R = t => ["r", t], E = t => ["e", t], P = t => ["p", t || "Field practice"];
const q = (id, t, o) => ({ id, k: "test", t, ...o }), d = (id, t, o) => ({ id, k: "do", t, ...o }),
      x = (id, t, o) => ({ id, k: "fix", t, ...o }), s = (id, t, o) => ({ id, k: "stop", t, ...o }),
      ok = (id, t, o) => ({ id, k: "done", t, ...o });
const tree = (id, o, nodes) => FI.trees.push({ id, ...o, nodes, start: nodes[0].id });

/* ---------------------------------------------------------------- 1 LEAD */
tree("R1", { kind: "run", stage: 1, scope: "both", title: "Lead", goal: "Know the building, the AHJ and what the job is.",
  who: "Owner or client, the AHJ (fire marshal), the licensee", tools: "Phone, RF Recon", call: "the fire marshal's office",
  gate: "The job has a pin on the building, a named AHJ, and a scope." }, [
  q("a", "Do you have the address, occupancy, floors, square footage and build schedule?", { how: "Ask the customer. Get the AHJ contact while you are there. Occupancy and schedule have no field of their own: put them in Notes.",
    good: "All five, in the job's Overview.", at: "DAS > New job, or + Job from Prospects", src: [E("Market research, lead qualification")], yes: "b", no: "a1" }),
  d("a1", "Get what is missing from the customer.", { how: "Occupancy, floors above and below grade, square footage, construction schedule, AHJ contact.", next: "a" }),
  q("b", "Is the job's pin on the building?", { how: "Type the address on Overview, then open Pre-survey. Every step runs from the pin, so a wrong pin quietly gives wrong systems. RF Recon warns only at 1 mile or more, and only for a numbered address it can find.",
    good: "Click Show on map: the pin sits on this building.", at: "Job > Overview", src: [A("Pin against address check")], yes: "c", no: "b1" }),
  x("b1", "Move the pin to the address.", { how: "Use the page's move button, or Use current pin to take the pin from the search panel.", at: "Job > Overview", next: "b" }),
  q("c", "Do you know the AHJ, the code edition and the local amendment?", { how: "RF Recon guesses the AHJ from the US fire department registry. That is a suggestion. The AHJ has the final say: what's in the adopted code they enforce, and what isn't they can still ask for.",
    good: "A named person, the edition enforced, and any local amendment.", at: "Job > Overview, AHJ", tool: "Phone", src: [A("AHJ guess"), E("Market research")], yes: "e", no: "F24" }),
  q("e", "Does this building need a public safety system?", { how: "Model IFC requires approved coverage in all new buildings, with exceptions. IFC 2024 adds an exception for one-story buildings up to 12,000 sq ft with no below-ground area. States differ a lot. Indiana: from July 1, 2026 no state agency or local government may require one in a Class 1 structure, new or being renovated (IC 22-13-2-3.7). An owner can still choose one. Minnesota deletes IFC 510, so it's required only where a city adopts the appendix. Texas, Missouri, Colorado, Illinois, Kansas and Arizona leave it to local code. Read your state's row in the Code check. Florida FFPC 9th edition, from 12/31/2026: no ERCES where exterior coverage is below DAQ 3.4. Existing buildings: when a wired system can't be repaired or is replaced, or within a time the adopting authority sets.",
    good: "A clear answer from the AHJ.", at: "Job > Overview, Code check", src: [R("IFC 510, as cited in the market research"), R("State rules, read 11/5"), R("Indiana HEA 1001: a person still confirms the wording")],
    opts: [{ l: "Yes, required", to: "e2" }, { l: "Not sure", to: "e1" }, { l: "Not required", to: "e4" }, { l: "Cellular only", to: "f" }] }),
  d("e1", "Run a benchmark survey on the AHJ's grid.", { how: "Need is set by a benchmark survey and the AHJ decides. Timing advice varies: once the envelope is sealed, at top-out, or at substantial completion.", tool: "Calibrated receiver", warn: "Osceola: get authorization before any walk test.", src: [R("Codes and workflow research")], next: "e" }),
  q("e2", "Will the AHJ accept proof of coverage instead of a system?", { how: "San Diego accepts a Proof of Acceptable Coverage grid test instead of a system. Ask yours.", src: [R("San Diego, as cited in the market research")], yes: "e3", no: "f" }),
  q("e3", "Did the proof of coverage pass?", { how: "Run the Grid test with a calibrated instrument. If it fails, the building needs a system.", at: "Job > Grid test", src: [R("San Diego, as cited in the market research")], yes: "e4", no: "f" }),
  ok("e4", "No system needed. Close it, and say why in the Log.", { stage: 8 }),
  q("f", "Is the scope settled?", { how: "Public safety ERCES, carrier cellular, or both. RF Recon works this out from what is in the job, so a job can be both.",
    good: "You and the customer agree which it is.", at: "Top of this page: job type", src: [A("Job scope")], yes: "z", no: "f1" }),
  d("f1", "Agree the scope with the customer.", { how: "Set the job type at the top of this page. The chart follows it.", next: "f" }),
  ok("z", "Lead is done. Go to Pre-survey.", { stage: 2 }),
]);

/* ---------------------------------------------------------------- 2 PRE-SURVEY */
tree("R2e", { kind: "run", stage: 2, scope: "e", title: "Pre-survey: public safety", goal: "Know which systems serve the building and how strong they are inside.",
  who: "Owner, AHJ, licensee (radio shop), GC, sub, our technician", tools: "RF Recon, calibrated receiver for the walk and the roof", call: "the licensee's radio shop",
  gate: "Channel plan saved, consent requests sent, AHJ profile picked, benchmark walk done, critical areas ticked." }, [
  d("a", "Look up the building so the loss estimate is right.", { how: "On Overview, click the NSI building lookup for stories and year built. Leave Construction unset to use the model: 14 dB traditional, 31 dB if built 2000 or later, +10 dB deep interior (floor plate 40,000 sq ft or more), +5 dB core at 7 floors or 23 m and taller. Picking Construction replaces the model.", at: "Job > Overview", src: [A("Building entry loss")], next: "b" }),
  d("b", "Run the Pre-survey.", { how: "Default radius is 15 mi. It lists base and fixed public safety stations from the FCC data. Level inside is outside minus building loss. Margin under 0 is red, under 10 is amber.", at: "Job > Pre-survey", src: [A("FCC systems around the pin")], next: "c" }),
  q("c", "Does the list hold the systems your AHJ requires?", { how: "Tick fire, police, EMS, 911 is a start. Then ask the radio shop which systems must be carried.", good: "Every required system is ticked.", at: "Job > Pre-survey", src: [A("Tick fire, police, EMS, 911")], yes: "e", no: "c1" }),
  d("c1", "Widen the radius, then ask the radio shop.", { how: "Radius goes from 1 to 60 mi. Below 25 MHz and above 1000 MHz are not listed. The licensee returns the frequencies, donor sites and a case number where it has an intake, as OCSD does.", at: "Job > Pre-survey", src: [A("Pre-survey range"), R("OCSD flow, as cited in the codes research")], next: "c" }),
  q("e", "Is any flag not dealt with yet?", { how: "Look for: uplink says 'ask licensee', ESMR 862 to 869 MHz, Band 14 758 to 768 MHz, or a simulcast mark.", at: "Job > Pre-survey", src: [A("Pre-survey flags")], yes: "F23", no: "f" }),
  d("f", "Tick the systems you need. That saves the channel plan.", { how: "Saved channels carry Design and the report, even on a copy without this area's FCC data.", at: "Job > Pre-survey", src: [A("Channel plan")], next: "g" }),
  d("g", "Pick the AHJ profile and tick the critical areas.", { how: "The profile sets threshold, DAQ, general and critical percent, battery hours, grid rule and whether uplink is needed in every square. Add any area the AHJ names.", at: "Job > Requirements", warn: "Confirm the numbers with the AHJ. Several profiles were read from search excerpts, not the full document.", src: [A("AHJ profiles")], next: "h" }),
  d("h", "Send consent requests to every licensee in the passbands.", { how: "Consent is needed before activation, not before design. Class A passband limit is 75 kHz. Class B passes everyone in the span except ESMR. Statuses: not asked, asked, given, refused, not needed.", at: "Job > Pre-survey, Passband licensees", who: "Each licensee", warn: "There is no published turnaround for consent. Send it early.", src: [A("Passband licensees"), R("47 CFR 90.219(b)(1), NFPA 1225 18.7.2, as cited in the codes research")], next: "i" }),
  d("i", "Run Terrain paths and print the donor aiming sheet.", { how: "The sheet gives true and magnetic bearing and elevation angle. Terrain has no pass or fail number: read the profile.", at: "Job > Pre-survey", src: [A("Terrain paths, donor aiming sheet")], next: "j" }),
  q("j", "Is the rooftop signal usable on every system?", { how: "Read each channel at the donor location with a calibrated instrument. Enter it as the roof level on Design.", good: "A steady reading on each system, and the link budget's downlink row passes.", tool: "Calibrated receiver on the roof", at: "Job > Design, roof level", src: [R("AHJ sets, as carried in Commissioning")], yes: "k", no: "F3" }),
  d("k", "Walk the building before design.", { how: "Use the AHJ's grid. Uncalibrated tools or SDRs may be used now: the readings stay on the plan as pre-survey and are not scored.", at: "Job > Grid test", tool: "Calibrated receiver, or SDR for a first look", warn: "Osceola: get authorization before any walk test.", src: [A("Walk before design")], next: "l" }),
  q("l", "Does the walk agree with the estimate?", { how: "Free space is the best case. Compare the walk with the Realistic estimate.", good: "The walk is at or above the estimate.", at: "Job > Pre-survey, Grid test", src: [A("Free space and realistic estimates")], yes: "z", no: "F16", then: "z" }),
  ok("z", "Pre-survey is done. Go to Design.", { stage: 3 }),
]);

tree("R2c", { kind: "run", stage: 2, scope: "c", title: "Pre-survey: cellular", goal: "Know each carrier's signal at the roof and how each will approve the job.",
  who: "Owner, integrator, each carrier's account team and RF engineering, neutral host if used", tools: "Calibrated scanner, RF Recon", call: "the carrier's account team",
  gate: "Rooftop reading per carrier, approval path per carrier, consent requests out, benchmark walk done, funding model agreed." }, [
  d("a", "Read the carrier panel at the bottom of Pre-survey.", { how: "It shows FCC Broadband Map coverage (modelled), the closest cell site within 5 mi, and the spectrum each carrier holds in the county.", at: "Job > Pre-survey, carriers", src: [A("Carriers at the building")], next: "b" }),
  q("b", "What does each carrier read on the roof?", { how: "Log RSRP, SINR, RSRQ, band, equipment, date and time, antenna height, azimuth and tilt.", good: "Target: RSRP −85 dBm or better and SINR 5 dB or better. Minimum: RSRP −95 dBm and SINR 0 dB.", tool: "Calibrated scanner", at: "Job > Pre-survey, rooftop donor", warn: "Nothing may be ordered until the donor is confirmed.", src: [A("Rooftop donor verdict"), R("Providence RFP 3.9, the only published figure")],
    opts: [{ l: "All at target", to: "c" }, { l: "Some at minimum only", to: "b1" }, { l: "Any below minimum", to: "F3" }] }),
  d("b1", "Note which carriers are minimum only, and carry on.", { how: "Tell the owner now. Booster gain can't fix a weak, noisy donor.", src: [E("Example job, fictional")], next: "c" }),
  q("c", "Is any band one a consumer booster may not carry?", { how: "600 MHz (B71), WCS (B30), 2.5 GHz (B41, n41), CBRS (B48, n48), C-band and 3.45 GHz (n77, n78), AWS-4 (B70). On B66 a consumer booster may carry only the AWS-1 part. RF Recon flags these only after the walk, so check your roof bands by hand.", at: "Job > Pre-survey, carrier table", src: [A("Consumer band check"), R("47 CFR 20.21(e)(3), FCC KDB 935210 D02")], yes: "c1", no: "e" }),
  d("c1", "Plan an industrial booster with each carrier's express consent.", { how: "Or a carrier-fed source, or the carrier's small cell.", src: [A("Consumer band check")], next: "e" }),
  d("e", "Pick an approval path for each carrier.", { how: "Industrial or off-air: the carrier's express consent. Consumer: register with the carrier. Carrier-fed: carrier agreement, design review, carrier acceptance test.", at: "Job > Pre-survey, approvals", src: [A("Approval paths"), R("47 CFR 20.21(c), (a)(2), (h)")], next: "f" }),
  q("f", "Have the consent requests gone out?", { how: "Print the consent letter from the job. It lists location, county and FIPS, bands, EARFCN, booster make, model and FCC ID, gain, EIRP, donor azimuth and height. T-Mobile has an In-Building Telecommunications Agreement. AT&T and Verizon have no public form. FirstNet: makers route a Band 14 request form, and the address is in a maker's manual.", at: "Job > Pre-survey, approvals", src: [A("Consent letter"), E("Cellular research")], yes: "g", no: "f1" }),
  d("f1", "Print and send the consent letter.", { at: "Job > Pre-survey, approvals", src: [A("Consent letter")], next: "f" }),
  d("g", "Set the cellular profile and walk the building.", { how: "Common: RSRP −95 dBm, −100 dBm at 3.3 GHz and up, SINR 5 dB, 95%. A scanner sees every carrier. A phone sees one and is a pre-survey tool. C-band needs 5G NR in the scanner.", tool: "Calibrated scanner", at: "Job > Grid test", warn: "No US carrier publishes an in-building spec. When a carrier gives you its numbers, enter them: they win. COMPASS XR's certificate covers LMR 700 and 800 only.", src: [A("Cellular grid profile"), E("Survey gear research")], next: "h" }),
  q("h", "Is the funding model agreed?", { how: "Self-funded, neutral host, or carrier funded.", good: "The owner has picked one.", src: [E("Cellular research")], yes: "z", no: "h1" }),
  d("h1", "Settle funding with the owner.", { how: "Carriers are much less likely to pay third-party connection fees, per the research.", next: "h" }),
  ok("z", "Pre-survey is done. Go to Design.", { stage: 3 }),
]);

/* ---------------------------------------------------------------- 3 DESIGN */
tree("R3e", { kind: "run", stage: 3, scope: "e", title: "Design: public safety", goal: "Prove on paper that it will work, then get it approved.",
  who: "Designer, AHJ, licensee, owner or architect for plans", tools: "RF Recon, floor plans", call: "the designer",
  gate: "Design approved and AHJ permit dates set." }, [
  q("a", "Do you have a plan for every floor?", { how: "Add the builder's PDF set and give each floor its page. CAD files: ask for a PDF export.", good: "Each floor has its image.", at: "Job > Plans", src: [A("Plans step")], yes: "b", no: "a1" }),
  d("a1", "Send the plan request letter.", { how: "Check the AHJ's plan format too. San Diego wants PDF Arch D (24x36) with graduated scale, compass and legend. Santa Clara wants at least 1/8 inch to 1 foot with a graphic scale.", at: "Job > Plans", src: [E("Plans research")], next: "a" }),
  d("b", "Draw walls and place antennas on each floor.", { how: "Rule of thumb from makers: 100 to 150 ft apart, the first within 50 ft of the perimeter. No US vendor radius table for 700 and 800 MHz was found.", at: "Job > Design", warn: "RF Recon's concrete model reads about a third of what NIST measured. Calibrate to a measured wall where you can.", src: [A("Design plan"), E("Link budget and plans research")], next: "c" }),
  q("c", "Does every link budget check show pass?", { how: "Fill in every band. A blank roof level leaves checks open, and open never counts as a pass.", good: "Every row says pass. Amber is not a pass.", at: "Job > Design, Link budget", src: [A("Link budget checks")], yes: "e", no: "F19" }),
  q("e", "Does the prediction agree with the walk?", { how: "Compare predicted and measured at each walk point.", good: "Within 3 dB is green, within 6 dB is amber, beyond that is red. Green or amber is Yes. Red is No.", at: "Job > Design, Prediction vs walk", src: [A("Prediction vs walk")], yes: "f", no: "e1" }),
  x("e1", "Tune the model to the walk.", { how: "Fit adjusts N, wall loss and floor loss to the walk. Draw the walls that are really there.", at: "Job > Design", src: [A("Fit to walk")], next: "e" }),
  d("f", "Size the battery.", { how: "Amp-hours = load x hours x 1.2, at 24 V by default. NFPA 1225, IFC 2021 and IFC 2024: 12 hours at 100%, or 2 hours of battery plus a generator. Low battery signal at 70% used. OCSD, LA County, McKinney, Santa Clara and FDNY want 24 hours.", at: "Job > Design, Battery", src: [A("Battery"), R("NFPA 1225 18.13.2, 18.14.1.2, as cited")], next: "g" }),
  d("g", "Build the bill of materials and tick the material rules.", { how: "UL 2524 listing, NEMA 4 or 4X electronics, NEMA 3R batteries, 2-hour pathway. Many AHJs allow Class A boosters only, including San Diego, Durham and Douglas County: read the profile's note before you pick a booster.", at: "Job > Materials", src: [A("Material rules")], next: "h" }),
  d("h", "Build the submittal.", { how: "Sheets ER-0 to ER-14. The packet index checks the AHJ's own list item by item.", at: "Job > Report, Design submittal", src: [A("Submittal sheets, AHJ packet index")], next: "i" }),
  q("i", "Have the licensee and the AHJ approved it, and is the permit issued?", { how: "One AHJ's order (Fairfax): radio shop approval, then building permit, low-voltage permit, fire alarm permit. Some AHJs want a PE seal or designer certification on the plans. Durham County design submittals: sealed by an NC PE or licensed fire sprinkler contractor. RF Recon's seal is a verify code, not a PE seal.", good: "Design approved and AHJ permit dates are set on Overview.", at: "Job > Overview, Compliance", warn: "One source says an ERCES design can't be finalised until the building is substantially complete. Ask.", src: [A("Compliance dates"), E("Market research")], yes: "z", no: "i1" }),
  s("i1", "Stop. Answer the review comments, then resubmit.", { how: "Do not order or install against an unapproved design.", who: "AHJ and licensee", src: [P()], next: "i" }),
  ok("z", "Design is done. Go to Install.", { stage: 4 }),
]);

tree("R3c", { kind: "run", stage: 3, scope: "c", title: "Design: cellular", goal: "Prove each band works on paper and get each carrier's approval.",
  who: "Designer, each carrier's RF engineering, owner", tools: "RF Recon, floor plans, usually an iBwave file for the carrier", call: "the carrier's RF engineering contact",
  gate: "Each carrier's design review passed, permit date set." }, [
  q("a", "Does each band reach the target at the far edge?", { how: "RSRP must meet the cellular target plus margin. RSRP is one subcarrier, so the booster's per-carrier cap is cut by 10 log10 of the subcarriers: 20 MHz LTE is 1200.", at: "Job > Design, Link budget", src: [A("Cellular link budget")], yes: "b", no: "F19" }),
  q("b", "Does the booster stay inside consumer limits?", { how: "Downlink composite 17 dBm (0.05 W) or less, uplink 30 dBm (1 W) or less. Over that, RF Recon warns: you need an industrial booster with each carrier's express consent.", at: "Job > Design, Link budget", src: [A("Consumer cap check"), R("47 CFR 20.21(c)")], yes: "c", no: "b1" }),
  d("b1", "Confirm this is an industrial booster with consent.", { next: "c" }),
  q("c", "Does isolation pass?", { how: "Needed = highest gain + 20 dB, same as ERCES. From +15 dB up to +20 dB is a warning.", at: "Job > Design, Link budget", src: [A("Isolation check")], yes: "e", no: "F19" }),
  q("e", "Does every band meet its own target?", { how: "Read each band's row. These are calculated: no booster is on yet.", at: "Job > Design, Link budget", src: [A("Cellular link budget")], yes: "f", no: "F19" }),
  q("f", "Has each carrier's RF engineering approved the design?", { how: "Usually an iBwave file. MCF model: preliminary, detailed, then implementation approval. 'Each Carrier may decide not to connect or accept handover.'", tool: "iBwave file", src: [E("Cellular research")], yes: "f2", no: "F18" }),
  q("f2", "Is the AHJ permit issued?", { at: "Job > Overview, Compliance", src: [A("Compliance dates")], yes: "z", no: "f3" }),
  s("f3", "Stop. No permit, no install.", { next: "f2" }),
  ok("z", "Design is done. Go to Install.", { stage: 4 }),
]);

/* ---------------------------------------------------------------- 4 INSTALL */
tree("R4e", { kind: "run", stage: 4, scope: "e", title: "Install: public safety", goal: "Build it, and test as you build.",
  who: "GC, electrical sub, fire alarm contractor, our technician, owner", tools: "Line analyzer, PIM analyzer if asked for, torque wrench, low-PIM load", call: "the GC",
  gate: "Every sweep and PIM run passes, checklists done, monitoring wired." }, [
  q("a", "Is the AHJ permit on file?", { how: "Firestop systems must be on the permit plans. Fairfax wants the ERCES to fire alarm connection on the fire alarm permit.", at: "Job > Overview, Compliance", src: [E("Plans research")], yes: "b", no: "a1" }),
  s("a1", "Stop. No permit, no install.", { how: "Go back to Design and get it issued.", src: [P()], next: "R3e" }),
  q("b", "Do the parts pass RF Recon's code check?", { how: "Booster: UL 2524 3rd edition, NEMA 4 or 4X, FCC ID, class. Batteries: NEMA 3R or better. Cable: 2-hour rating where the building isn't fully sprinklered and its frame is rated 2 hours.", at: "Parts, job Materials", warn: "UL 2524 listings not updated by 2026-03-22 are withdrawn.", src: [A("Parts code checks"), R("NFPA 1225 18.12, as cited")], yes: "b2", no: "F20" }),
  q("b2", "Will any test radiate?", { how: "A test into low-PIM loads doesn't. A temporary antenna or a connected antenna does.", src: [E("PIM research")], yes: "b3", no: "c" }),
  q("b3", "Do you have advance permission from affected licensees, in writing?", { how: "One integrator's rule: in writing before any rebroadcast, including for testing.", who: "Each affected licensee", warn: "Nothing radiates until you have it.", src: [E("PIM research"), E("Cellular research")], yes: "c", no: "b4" }),
  s("b4", "Stop. Get permission first, or test into low-PIM loads.", { who: "Each affected licensee", next: "b2" }),
  d("c", "Build in sections, and test each section as you go.", { how: "Test into low-PIM loads unless you have permission. With permission, pre-test each antenna location at low power with a temporary antenna; if PIM is high, move about 1 m. Test the cables, each floor, the riser with low-PIM loads on tapper outputs, then the full system from the DAS input.", warn: "Testing only at the head-end hides faults: each dB of loss between a PIM source and the head-end cuts what you see by about 3.5 dB.", src: [E("PIM research, Anritsu Testing DAS note")], next: "e" }),
  q("e", "Does every sweep pass?", { how: "Return loss 14 dB is common practice, not code. Use the owner's spec if there is one (CU Denver 20 dB). Looking into an antenna, 9.5 dB.", good: "Worst point in band meets the limit. Insertion loss meets datasheet x length + 0.1 dB per connector + 0.5 dB.", tool: "Line analyzer", at: "PIM > Sweeps", src: [A("Sweeps")], yes: "f", no: "F5" }),
  q("f", "Does anyone require a PIM test on this job?", { how: "NFPA 1225 (2022) chapter 18 asks for no PIM test and no sweep. Run PIM when the AHJ, owner or carrier asks.", src: [A("Report wording"), E("PIM research")], yes: "g", no: "i" }),
  q("g", "Do you have advance permission from affected licensees to radiate test tones?", { how: "Get it before you radiate.", warn: "Do not inject tones into BDA ports. No source describes PIM testing through an amplifier.", src: [E("PIM research")], yes: "h", no: "g1" }),
  s("g1", "Stop. Get permission first.", { who: "Each affected licensee", next: "g" }),
  q("h", "Does every PIM run pass?", { how: "Check antenna and divider power ratings first. PIM dBc = result dBm minus tone dBm. RF Recon's default limit is −140 dBc at 2 x 43 dBm tones. The job may change it.", good: "At or below the limit: −149 passes, −135 fails.", tool: "PIM analyzer, low-PIM load", at: "PIM", src: [A("PIM runs")], yes: "i", no: "F4" }),
  d("i", "Wire monitoring to the fire alarm panel.", { how: "All eight supervisory signals. The fire alarm contractor does the panel side.", who: "Fire alarm contractor", warn: "Where the AHJ says so, the system stays off except for testing until final approval. OCSD: business hours only.", src: [R("NFPA 1225 18.14, as cited"), R("OCSD, as cited in the codes research")], next: "j" }),
  q("j", "Are the install checklists done?", { how: "Pre-test, set-up, close-out and DAS PIM checklists. Skip the PIM lists if no PIM ran.", at: "PIM", src: [A("PIM checklists")], yes: "z", no: "j1" }),
  d("j1", "Finish the checklists.", { next: "j" }),
  ok("z", "Install is done. Go to Commission.", { stage: 5 }),
]);

tree("R4c", { kind: "run", stage: 4, scope: "c", title: "Install: cellular", goal: "Build it and prove the cable network before anything radiates.",
  who: "GC, electrical sub, our technician, the carrier for its own source", tools: "Line analyzer, PIM analyzer, fiber test set if there is fiber", call: "the GC",
  gate: "Sweeps, PIM and fiber results recorded. Nothing radiates on carrier spectrum until carrier acceptance and a retransmission agreement." }, [
  q("a", "Is the carrier's design approval in hand?", { how: "Consent received or in process.", src: [E("Cellular research")], yes: "b", no: "F18" }),
  q("b", "Do the parts pass?", { how: "Ignore RF Recon's UL 2524, NEMA and Class lines on a cell-only job: what matters is consumer or industrial, and the FCC ID. A CBRS booster or DAS above 23 dBm per 10 MHz counts as a CBSD and must register with a SAS.", at: "Parts, job Materials", src: [R("47 CFR Part 96, KDB 935210 D02"), A("Parts code checks")], yes: "b2", no: "F20" }),
  q("b2", "Will any test radiate?", { how: "A test into low-PIM loads doesn't. A temporary antenna or a connected antenna does.", src: [E("PIM research")], yes: "b3", no: "c" }),
  q("b3", "Do you have advance permission from each carrier, in writing?", { how: "One integrator's rule: in writing before any rebroadcast, including for testing.", who: "Each carrier", warn: "Nothing radiates until you have it.", src: [E("PIM research"), E("Cellular research")], yes: "c", no: "b4" }),
  s("b4", "Stop. Get permission first, or test into low-PIM loads.", { who: "Each carrier", next: "b2" }),
  d("c", "Build in sections, and test each section as you go.", { how: "Test into low-PIM loads unless you have permission. Test antenna locations, cables, each floor, riser, then the full system from the DAS input. The carrier installs its own RF source.", src: [E("PIM and cellular research")], next: "e" }),
  q("e", "Does every sweep pass?", { how: "Return loss 14 dB is common practice. Looking into an antenna, 9.5 dB.", tool: "Line analyzer", at: "PIM > Sweeps", src: [A("Sweeps")], yes: "f", no: "F5" }),
  q("f", "Does every PIM run pass?", { how: "RF Recon defaults to −140 dBc. The example cellular job uses −150 dBc. AT&T's method is not public; Verizon and T-Mobile have no public PIM spec. Use the number the carrier gives you.", tool: "PIM analyzer", at: "PIM", warn: "Do not inject tones into BDA ports.", src: [A("PIM runs"), E("PIM research")], yes: "g", no: "F4" }),
  q("g", "Is there fiber or a remote unit in this design?", { how: "Fiber and OTDR results are a close-out item.", src: [E("Cellular research")], yes: "F22", no: "z", then: "z" }),
  ok("z", "Install is done. Go to Commission.", { stage: 5 }),
]);

/* ---------------------------------------------------------------- 5 COMMISSION */
tree("R5e", { kind: "run", stage: 5, scope: "e", title: "Commission: public safety", goal: "Set the booster and prove it in six steps.",
  who: "Our technician (FCC GROL), the licensee's radio shop, the fire alarm technician", tools: "Spectrum analyzer, signal generator, BDA software, two radios", call: "the licensee's radio shop",
  gate: "All six steps pass. Consent, FCC registration (Class B) and monitoring dates set." }, [
  q("a", "Has every licensee this booster passes given consent?", { how: "It must read consent from all of them. Class B: every licensee in the span. Seattle: PSERN validates the uplink first. NFPA 1225 18.7.2: written authorization before activation. 47 CFR 90.219(b)(1): express consent in recordable form.", at: "Job > Pre-survey, Licensees in the booster's passbands", warn: "Do not switch the booster on without it.", src: [A("Needs you line"), R("90.219, NFPA 18.7.2, as cited")], yes: "b", no: "F18" }),
  q("b", "Is this a Class B booster?", { how: "Read the class off the label or FCC grant, not the Overview field: it defaults to Class A. Class A is each passband 75 kHz or less. Class B needs FCC registration before it is switched on. Douglas wants FCC registration even for Class A.", at: "Job > Overview", src: [A("Parts check"), R("47 CFR 90.219(d)(5)")], yes: "b0", no: "e" }),
  q("b0", "Does this AHJ allow Class B?", { how: "Many allow Class A only, including San Diego, Durham and Douglas County. Read the AHJ profile's note.", at: "Job > Requirements", src: [A("AHJ profiles")], yes: "b1", no: "b3" }),
  s("b3", "Stop. This AHJ doesn't allow this booster.", { how: "Go back to the designer before anything is switched on.", who: "Designer, AHJ", src: [A("AHJ profiles")], next: "b" }),
  q("b1", "Is the FCC registration filed?", { how: "Call sign and frequency retransmitted, operating range, address, responsible contact, filed with an FRN login.", at: "Job > Overview, Compliance", src: [A("Needs you line"), R("Codes research")], yes: "e", no: "b2" }),
  s("b2", "Stop. File the registration before switch-on.", { next: "b1" }),
  q("e", "Step 1. Does isolation pass?", { how: "Do it first. Donor to server antennas. Inject a tone into a server antenna and read it at the donor, or use the BDA's isolation test.", good: "Measured is at least the higher of UL and DL gain + 20 dB. McKinney uses 15 dB (search excerpt). The job's AHJ profile wins.", tool: "Signal generator and analyzer, or BDA software", warn: "Booster stays off until this passes.", at: "Job > Commissioning, step 1", src: [A("Isolation step"), R("NFPA 18.10, IFC 510.4.2.4(4), as cited")], yes: "f", no: "F1" }),
  d("f", "Step 2. Record gain, AGC and filters.", { how: "UL and DL gain per band, plus maker, model, serial, FCC ID and firmware. The step stays 'not done' until every band has UL and DL gain.", at: "Job > Commissioning, step 2", src: [A("Gain step"), R("NFPA 20.3.10.1.3(11), IFC 510.5.4(6), as cited")], next: "c" }),
  q("c", "Step 3. Is the noise rise at the agency's site under 1 dB?", { how: "This is the first switch-on: coordinate with the radio shop before you enable it. At the site nearest the building, on its receiver multicoupler. Booster off, then on. 10 kHz RBW, idle uplink channel, 5-minute average. Average as power, not dB. The radio shop allows and usually runs it.", good: "On minus off under 1 dB. San Francisco and Guilford Metro also set a window on the uplink at the site. −150 dBm limits are calculated in the link budget: no analyzer can read that low, so a reading is judged by its rise.", tool: "Spectrum analyzer", warn: "Miami-Dade says DO NOT TEST OR CONNECT UPLINK. Ask the AHJ first.", at: "Job > Commissioning, step 3", who: "Radio shop", src: [A("Noise step"), R("NFPA A.18.9.3, as cited")], yes: "g", no: "F2" }),
  q("g", "Step 4. Is it free of oscillation, and did the alarm work?", { how: "Sweep both passbands on a spectrum analyzer with the BDA on. Prove the alarm only by the maker's method, with the radio shop's OK on the day.", good: "None seen in both directions, and the alarm or shutdown worked.", tool: "Spectrum analyzer", who: "Radio shop", warn: "Never raise gain to force oscillation without the radio shop's OK: it jams their site.", at: "Job > Commissioning, step 4", src: [A("Oscillation step"), R("IFC 510.5.4(7), as cited"), P("Alarm proof")], yes: "h", no: "F1" }),
  q("h", "Step 5. Is the donor level recorded and usable?", { how: "Read at the BDA's donor port, after donor gain and cable. Record level and source type. NFPA and IFC set no window here.", tool: "Analyzer at the donor line", at: "Job > Commissioning, step 5", src: [A("Donor step")], yes: "i", no: "F3" }),
  q("i", "Step 6. Did every talk-back call come through clear?", { how: "Two radios keyed at once on different channels in the same band, one within 10 ft of an indoor antenna, one at the farthest point from any antenna, with the radio shop or dispatcher on the line. Greensboro also asks for a near-far call.", tool: "Two radios, the agency's current model", warn: "Miami-Dade says DO NOT TEST OR CONNECT UPLINK. Ask the AHJ first.", at: "Job > Commissioning, step 6", src: [A("Talk-back step"), R("IFC 510.5.4(8), as cited")], yes: "j", no: "F7" }),
  q("j", "Does every supervisory signal reach the panel?", { how: "Trip each signal and watch the panel. Eight signals: signal source, active RF device, low battery at 70%, active component, AC loss, charger, FACU link, oscillation.", tool: "Fire alarm technician at the panel", who: "Fire alarm technician", at: "Job > Grid test, acceptance tests", src: [A("records the result, doesn't grade it"), R("NFPA 18.14.1.2, IFC 510.4.2.5, as cited")], yes: "k", no: "F11" }),
  q("k", "Did the battery pass its load test?", { how: "1-hour load test. Murray UT: replace under 70%.", good: "No general figure: use the maker's end voltage and the AHJ's rule.", tool: "Load test kit", at: "Job > Grid test, acceptance tests", src: [A("records the result, doesn't grade it")], yes: "z", no: "F13" }),
  ok("z", "Commissioning is done. Go to Acceptance.", { stage: 6 }),
]);

tree("R5c", { kind: "run", stage: 5, scope: "c", title: "Commission: cellular", goal: "Set the booster to what each carrier agreed, and prove it.",
  who: "Our technician, each carrier's NOC", tools: "Spectrum analyzer, signal generator, booster software, a phone on each carrier", call: "the carrier's NOC",
  gate: "Settings match the consents, NOC noise read, isolation, donor levels and test calls on every carrier." }, [
  q("a", "Is each carrier's consent letter or agreement on file?", { how: "47 CFR 20.21(c): a letter, email or other record naming the bands. It can be withdrawn. You must shut the booster off at the carrier's request.", warn: "Do not switch on without it.", src: [R("47 CFR 20.21(c), (d), (h)")], yes: "c", no: "F18" }),
  q("c", "Does isolation pass on every band?", { how: "Measured is at least the higher of UL and DL gain + 20 dB.", tool: "Signal generator and analyzer", warn: "Booster stays off until this passes.", at: "Job > Commissioning, step 1", src: [A("Isolation step")], yes: "e", no: "F1" }),
  q("e", "Do the gains and filters match the consents?", { how: "AGC on. Settings as the letter says. RF Recon doesn't compare these for you.", at: "Job > Commissioning, step 2", src: [E("Example job, fictional")], yes: "b", no: "e1" }),
  x("e1", "Set them to match the consent.", { next: "e" }),
  q("b", "Did each carrier's NOC read under 1 dB of uplink noise rise?", { how: "First switch-on: coordinate with the NOC. Booster off, then on, read from the carrier's own counters. RF Recon borrows NFPA's method because no carrier uplink noise spec is public. Use the carrier's number if it gives one.", who: "Carrier NOC", at: "Job > Commissioning, step 3", src: [A("Noise step")], yes: "f", no: "F2" }),
  q("f", "Is it free of oscillation, with the alarm working?", { how: "Analyzer on both passbands.", tool: "Spectrum analyzer", at: "Job > Commissioning, step 4", src: [A("Oscillation step")], yes: "g", no: "F1" }),
  q("g", "Are the donor levels recorded and usable?", { at: "Job > Commissioning, step 5", how: "Compare with the rooftop reading.", good: "RSRP −95 dBm, SINR 0 dB or better.", src: [A("Donor step")], yes: "h", no: "F3" }),
  q("h", "Did test calls come through clear on every carrier?", { tool: "A phone on each carrier", at: "Job > Commissioning, step 6", src: [E("Example job, fictional")], yes: "z", no: "F6" }),
  ok("z", "Commissioning is done. Go to Acceptance.", { stage: 6 }),
]);

/* ---------------------------------------------------------------- 6 ACCEPTANCE */
tree("R6e", { kind: "run", stage: 6, scope: "e", title: "Acceptance: public safety", goal: "Pass the grid test and get it accepted.",
  who: "AHJ or fire marshal, tester (FCC GROL, training, NICET where asked), licensee, owner", tools: "Calibrated receiver, agency radios", call: "the AHJ",
  gate: "Report shows PASS, accepted date set, acceptance baseline saved." }, [
  q("a", "Is every instrument calibrated for the test dates?", { how: "Within 12 months of the reading, or the certificate's own expiry date.", at: "Job > Overview, Testing", src: [A("Calibration rule")], yes: "b", no: "F9" }),
  q("b", "Does the AHJ need an independent tester or a certain tool?", { how: "San Diego and Santa Clara want a third party and an independence statement. Douglas County accepts only DCSORS or a PCTel-certified vendor with a calibrated IBflex uploaded to SeeHawk Central: RF Recon's results alone won't be accepted.", at: "Job > Requirements", src: [A("AHJ profiles")], yes: "b1", no: "c" }),
  d("b1", "Line up that tester or tool before you book the walk.", { next: "c" }),
  d("c", "Book the witness and the radios.", { how: "OCSD loans radios. Santa Clara loaner radios come from the County Radio Shop. Osceola needs authorization before any walk test.", who: "AHJ, licensee", src: [R("AHJ profiles, codes research")], next: "e" }),
  d("e", "Walk the grid.", { how: "Pick Taken with, then a spot at each square's centre and a continuous walk by time. 20 areas per floor, each 20 to 80 ft. Over 128,000 sq ft, split into sectors. Follow the AHJ's method: Charlotte averages over several seconds; Miami-Dade averages max and min hold over at least 30 s and says do not test or connect uplink.", tool: "Calibrated receiver", at: "Job > Grid test", src: [A("Grid test"), R("IFC 510.5.4 and AHJ documents, as cited")], next: "f" }),
  q("f", "Is any reading grey, or marked untested for uplink?", { how: "Grey means not counted.", at: "Job > Grid test", src: [A("Calibration rule, uplink in every square")], yes: "F9", no: "g" }),
  q("g", "Does Screening say any square is too close to call?", { how: "Screening doesn't change the score. It tells you what could fail in front of the witness.", at: "Job > Screening", src: [A("Screening")], yes: "F10", no: "h" }),
  q("h", "How do the squares look?", { how: "Worst channel decides each square.", at: "Job > Grid test", src: [A("Worst channel decides")],
    opts: [{ l: "All pass", to: "i" }, { l: "Fails the level", to: "F6" }, { l: "Level good, DAQ fails", to: "F7" }, { l: "Some fail, floor might pass", to: "F8" }, { l: "Some fail, floor passed on count", to: "i" }] }),
  q("i", "Is every named critical area tested and passing?", { how: "Each one on its own. Default 99% critical, 95% general.", at: "Job > Grid test", src: [A("Named critical areas")], yes: "j", no: "F6" }),
  q("j", "Is every test that applies to this AHJ entered and passing?", { how: "Includes filters and AGC, battery load test, EPO for San Diego, supervisory signals, exterior leakage and BDA identity. Leakage: 15 dB below donor at OCSD, San Diego and Santa Clara, 20 dB at LA County. RF Recon records leakage and doesn't grade it.", at: "Job > Grid test, acceptance tests", src: [A("Acceptance tests"), R("AHJ documents, as cited")], yes: "k", no: "j1" }),
  d("j1", "Run what is missing, then come back.", { how: "A failed test sends you to its fault chart from Commission.", next: "j" }),
  q("k", "Does the report say PASS, and is the packet complete?", { how: "The packet index shows each item on the AHJ's list.", at: "Job > Report", src: [A("Report, packet index")], yes: "k2", no: "F21" }),
  q("k2", "Has the AHJ accepted it, witnessed where asked?", { how: "RF Recon's PASS isn't acceptance. The AHJ's word is.", who: "AHJ", src: [R("Codes research")], yes: "l", no: "F21" }),
  d("l", "Set the accepted date and save the baseline.", { how: "The accepted date sets the annual retest date. Save as acceptance baseline keeps these results for later retests.", at: "Job > Overview, Grid test", src: [A("Accepted date, baseline")], next: "l2" }),
  d("l2", "Sign the report, then Print as final.", { how: "This seals it. Do it after the date and baseline: any later change makes the report read 'job changed since'.", at: "Job > Report", src: [A("Sealed report")], next: "m" }),
  q("m", "Is the report filed inside the AHJ's window?", { how: "OCSD 30 calendar days after the test. Charleston 30 days. Seattle: into The Compliance Engine 24 hours before the inspection. Broward: reports go through The Compliance Engine from 11/1/2026.", at: "Job > Overview, Lifecycle", src: [A("AHJ deadlines")], yes: "z", no: "F21" }),
  ok("z", "Accepted. Go to In service.", { stage: 7 }),
]);

tree("R6c", { kind: "run", stage: 6, scope: "c", title: "Acceptance: cellular", goal: "Show each carrier and layer passing, and get sign-off.",
  who: "Owner, each carrier, our technician", tools: "Calibrated scanner, a phone per carrier for indicative readings", call: "the carrier's RF engineering contact",
  gate: "Report PASS for every required carrier and layer, and sign-off from every party." }, [
  q("a", "Is your scanner calibrated for these bands?", { how: "Same 12-month rule. COMPASS XR's certificate covers LMR 700 and 800 only. Phone readings are indicative and never scored.", at: "Job > Overview, Testing", src: [A("Calibration rule"), E("Survey gear research")], yes: "b", no: "F9" }),
  d("b", "Walk the building.", { how: "A carrier-only job is judged per carrier and layer: below 3.3 GHz, and 3.3 GHz and up. Best cell decides. 95% by default.", tool: "Calibrated scanner", at: "Job > Grid test, Show", src: [A("Cellular verdict")], next: "c" }),
  q("c", "Does every required carrier and layer pass on every floor?", { how: "A square with cellular readings but none from that carrier fails for it. The Cooper-style table needs each band to meet it on its own, while the grid judges a carrier's best cell below 3.3 GHz: check 1900 and 2100 apart.", at: "Job > Grid test, Report", src: [A("Cellular verdict")], yes: "e", no: "F6" }),
  q("e", "Does the carrier's own acceptance procedure pass?", { how: "AT&T, Verizon and T-Mobile publish no acceptance numbers. The carrier's own ATP governs.", who: "Each carrier", src: [E("Cellular research")], yes: "f", no: "F6" }),
  q("f", "Have all parties agreed the report?", { how: "'Acceptance is achieved after all parties agree with the delivered report' (Viavi, as cited).", src: [E("Cellular research")], yes: "z", no: "f1" }),
  d("f1", "Close out each party's comments.", { next: "f" }),
  ok("z", "Accepted. Go to In service.", { stage: 7 }),
]);

/* ---------------------------------------------------------------- 7 IN SERVICE */
tree("R7e", { kind: "run", stage: 7, scope: "e", title: "In service: public safety", goal: "Keep it passing, and keep the paperwork current.",
  who: "Owner, integrator, AHJ, licensee", tools: "Calibrated receiver, spectrum analyzer, load test kit", call: "the owner",
  gate: "No open alarms, annual test current, licensee authorisation current." }, [
  q("a", "What brought you here?", { how: "RF Recon's Needs you list shows most of these.", at: "DAS > Board, Needs you", src: [A("Needs you")],
    opts: [{ l: "Annual test due", to: "b" }, { l: "Five-year retest", to: "c" }, { l: "An alarm", to: "F11" }, { l: "BDA gone quiet", to: "F12" }, { l: "Licence finding", to: "F14" }, { l: "FCC notice", to: "F15" }, { l: "Remodel or addition", to: "e" }, { l: "Licensee authorisation renewal", to: "r" }, { l: "Nothing else", to: "z" }] }),
  d("b", "Run the annual test.", { how: "Due 12 months after the accepted date or the last annual test, and 'due soon' from 60 days out. Repeat the grid test, compare gain with acceptance, 1-hour battery load test, check active components, oscillation check, report to the fire code official. Filing windows: OCSD 30 calendar days, Seattle 7 days.", at: "Job > Overview, Lifecycle", src: [A("Lifecycle dates"), R("IFC 510.6.1, NFPA 20.3.10, as cited")], next: "b1" }),
  q("b1", "Did it pass against the baseline?", { good: "Grid passes the profile and gains match acceptance.", at: "Job > Grid test, Report", src: [A("Baseline")], yes: "z", no: "b2" }),
  q("b2", "What failed?", { then: "b1", opts: [{ l: "Grid", to: "F6" }, { l: "DAQ", to: "F7" }, { l: "Gain or oscillation", to: "F1" }, { l: "Battery", to: "F13" }] }),
  d("c", "Run the five-year retest where it applies.", { how: "A full quantitative retest at least every five years where NFPA 1225 applies. That figure is from a secondary summary: confirm it, the IFC has no five-year rule. Local rules: Clark County, Douglas County, Denver, FDNY.", warn: "Confirm with the AHJ.", at: "Job > Overview, Lifecycle", src: [A("Lifecycle dates"), R("SBC primer, as cited")], next: "b1" }),
  d("e", "Retest after the change.", { how: "IFC 510.6.1 says retest after additions or remodels, in the 2018, 2021 and 2024 editions. The code gives no deadline.", at: "Job > Grid test", src: [R("IFC 2018, 2021 and 2024 510.6.1, as cited")], next: "b1" }),
  d("r", "Renew it, and update the date.", { how: "Dated by the licensee's paper. Researched terms: Broward and Fairfax annual, Maryland provisional 1 year, Douglas 6 months then 5 years.", who: "Licensee", at: "Job > Overview, Lifecycle", src: [A("Lifecycle dates")], next: "a" }),
  ok("z", "Current. Check Lifecycle dates, then you're done for now.", {}),
]);

tree("R7c", { kind: "run", stage: 7, scope: "c", title: "In service: cellular", goal: "Keep the carriers' consent and the coverage current.",
  who: "Owner, integrator, each carrier", tools: "Calibrated scanner", call: "the carrier's account team",
  gate: "Consent current, carrier retest current, maintenance agreement current." }, [
  q("a", "Is any date due?", { how: "Carrier consent renewal (the date in the carrier's letter; 20.21 sets no term), carrier retest (the date in its agreement), and the owner's maintenance agreement. No FCC rule sets a retest interval for a carrier DAS.", at: "Job > Overview, Lifecycle", src: [A("Lifecycle dates")], yes: "b", no: "c" }),
  d("b", "Do what the letter or agreement says, and update the date.", { next: "c" }),
  q("c", "Has a carrier suspended, withdrawn or changed anything?", { how: "T-Mobile's agreement lets it suspend or terminate the rebroadcast at any time for any reason, and update the frequencies. Consent can be withdrawn.", src: [E("Cellular research"), R("47 CFR 20.21(h)")], yes: "c1", no: "e" }),
  s("c1", "Stop. If the carrier withdrew consent, suspended the rebroadcast or asked you to, shut the booster off now.", { how: "47 CFR 20.21(d). It stays off until new consent is on file.", who: "Owner, carrier", src: [R("47 CFR 20.21(d)")], next: "F18", then: "e" }),
  q("e", "Has coverage dropped?", { src: [P()], yes: "F6", no: "z", then: "z" }),
  ok("z", "Current. You're done for now.", {}),
]);

/* ---------------------------------------------------------------- 8 CLOSED */
tree("R8", { kind: "run", stage: 8, scope: "both", title: "Closed", goal: "Hand over, or record why it ended.",
  who: "Owner, AHJ", tools: "RF Recon's packet zip", call: "the owner",
  gate: "The owner has the package. The AHJ has the report." }, [
  q("a", "Did the job finish, or was it lost?", { src: [A("Stage text")], opts: [{ l: "Finished", to: "b" }, { l: "Lost", to: "e" }] }),
  q("b", "Public safety: is the full package ready?", { how: "Equipment list and datasheets, as-builts, measurements at all locations, secondary power calculations, assigned frequencies, isolation results, signal source levels and type, every channel, gain, filter bandwidth and AGC setting. Leave a document holder at the BDA.", at: "Job > Report, packet zip", src: [R("NFPA 20.3.10.1.3, as cited"), A("Packet zip")], opts: [{ l: "Yes", to: "c" }, { l: "No", to: "b1" }, { l: "Not this job", to: "c" }] }),
  d("b1", "Gather what is missing.", { next: "b" }),
  q("c", "Cellular: is the package ready?", { how: "As-builts, sweep and PIM results, fiber and OTDR results, walk plots, equipment settings, carrier contacts. Providence adds FCC registration numbers if any, carrier registration confirmations and final band settings.", src: [E("Cellular research")], opts: [{ l: "Yes", to: "z" }, { l: "No", to: "b1" }, { l: "Not this job", to: "z" }] }),
  d("e", "Write why it ended in the Log.", { how: "RF Recon has no field for this. Use a note.", at: "Job > Log", src: [P("No app field")], next: "z" }),
  ok("z", "Closed. Closed jobs drop out of Needs you, licence watch and the audit.", {}),
]);

/* DAS fault isolation chart: the fault trees and the reference tables. PREVIEW ONLY. See fi-runs.js for the tags.
   Each tree runs quickest safe check first. "Stop" boxes are where no source gives a number: they send you to a person. */

tree("F1", { kind: "fault", scope: "both", title: "Isolation fails, or the booster oscillates", group: "Booster",
  see: "Booster alarms or shuts down. A spurious signal on the analyzer. The agency reports interference. More gain makes coverage worse.",
  who: "Our technician, designer", tools: "Spectrum analyzer, signal generator, BDA software", call: "the designer, then the booster's maker" }, [
  q("a", "Is isolation at least the highest gain + 20 dB?", { how: "Inject a tone into a server antenna path and read it at the donor, or run the BDA's isolation test. Use the higher of UL and DL gain.", good: "Pass at gain + 20 dB. In Design, RF Recon also warns from +15 dB up to +20 dB. McKinney uses a 15 dB margin (search excerpt).", tool: "Signal generator and analyzer, or BDA software", warn: "Booster off for this test. Get permission before radiating any test tone.", at: "Job > Commissioning, step 1", src: [A("Isolation check"), R("IFC 510.4.2.4(4), NFPA 18.10, as cited"), E("NPSTC 2007: the most frequent problem is inadequate isolation")], yes: "b", no: "c" }),
  q("b", "With the BDA on, are both passbands clean on the analyzer?", { how: "Sweep DL and UL passbands.", good: "No oscillation in either direction.", tool: "Spectrum analyzer", at: "Job > Commissioning, step 4", src: [A("Oscillation step")], yes: "z", no: "b1" }),
  s("b1", "Stop. Isolation passes but it still oscillates. Call the maker.", { how: "Our sources don't cover this case. Note the frequency, gain and level you saw.", who: "Booster's maker", src: [P("No source")] }),
  q("c", "Can you lower gain and still pass the link budget?", { how: "Comba's method caps gain at isolation minus 20 dB. Try that number in the job's link budget. OCSD and Sacramento use maximum rated gain, and Douglas the BDA's maximum gain: lowering the set gain won't clear those, so answer No.", at: "Job > Design, Link budget", src: [E("Comba CriticalPoint, in the codes research")], yes: "c1", no: "e" }),
  x("c1", "Lower the gain to isolation minus 20 dB, and record it.", { at: "Job > Commissioning, step 2", next: "a" }),
  x("e", "Raise isolation physically.", { how: "Re-aim the donor away from the building's antennas, add separation, put structure between them, or fit a donor with more front-to-back. Then re-read the donor level. OCSD asks for a donor of 13 dBd or better with 30 dB front-to-back.", tool: "Antenna kit, roof access", who: "Radio shop or carrier", warn: "Public safety: only a site the radio shop names, and one site on simulcast. Update the consent if the azimuth changes.", src: [P("Physical fixes have no source"), R("OCSD donor rule, as cited")], next: "a" }),
  ok("z", "Isolation and oscillation pass.", {}),
]);

tree("F2", { kind: "fault", scope: "both", title: "Uplink noise rise at the site", group: "Booster",
  see: "The radio shop or carrier sees a raised noise floor with the booster on. A noisy booster can draw an FCC notice.",
  who: "Licensee's radio shop or carrier NOC, our technician", tools: "Spectrum analyzer, the licensee's own counters", call: "the licensee's radio shop or the carrier's NOC" }, [
  q("a", "Was the test done to the method?", { how: "RBW 10 kHz, idle uplink channel, 5-minute average, booster off then on, averaged as power. Otherwise RF Recon marks it 'not done: not to the method'.", tool: "Spectrum analyzer", at: "Job > Commissioning, step 3", src: [A("Noise step"), R("NFPA A.18.9.3, as cited")], yes: "b", no: "a1" }),
  d("a1", "Redo it to the method.", { next: "a" }),
  q("b", "Is the rise 1 dB or more?", { how: "A site noise limit such as −150 dBm (OCSD, San Diego, LA, Santa Clara), −153 dBm (Durham) or −145 dBm per 10 kHz (Douglas) is a calculated figure: it belongs on the link budget. Thermal noise in 10 kHz is −134 dBm, so no analyzer reading can meet it.", good: "Under 1 dB passes.", src: [A("Noise step")], yes: "c", no: "z" }),
  x("c", "Cut uplink gain until the rise is gone, then 3 dB more.", { how: "Enter only the cut that cleared it, and the new reading. RF Recon adds the 3 dB itself.", at: "Job > Commissioning, step 3", src: [A("Noise step"), R("NFPA A.18.9.3, as cited")], next: "e" }),
  q("e", "Is the cleared rise under 1 dB?", { at: "Job > Commissioning, step 3", src: [A("Noise step")], yes: "f", no: "e1" }),
  s("e1", "Stop. Gain is down and noise stayed. Check the booster.", { how: "Noise figure can get worse at reduced gain on some BDAs. Comba: UL under 5 dB at 90 dB gain, under 9 dB at 67 dB. Broadband boosters can also desense other services whose sites sit in the donor beam. Take the numbers to the maker and the radio shop.", who: "Booster's maker, radio shop", src: [E("Link budget research")] }),
  q("f", "After the cut, does the link budget still pass?", { how: "Check uplink level at the agency receiver and uplink over sensitivity.", at: "Job > Design, Link budget", src: [A("Link budget checks")], yes: "z", no: "F19" }),
  ok("z", "Noise rise passes.", {}),
]);

tree("F3", { kind: "fault", scope: "both", title: "Donor too weak or too hot", group: "Booster",
  see: "Far-edge downlink fails with gain maxed. Headroom fails. The donor reads below minimum, or uplink reads 'too hot' at the site.",
  who: "Our technician, radio shop or carrier", tools: "Calibrated receiver or scanner at the donor port, compass or aiming sheet", call: "the radio shop or the carrier" }, [
  q("a", "Which is it?", { src: [A("Link budget, Commissioning")], opts: [{ l: "Too weak", to: "b" }, { l: "Too hot", to: "h" }, { l: "No donor fitted yet", to: "e" }] }),
  q("b", "Is the reading good at the antenna but poor at the booster?", { how: "Read at the donor port after the cable, then compare with the roof reading and the cable's expected loss.", tool: "Calibrated receiver", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours.", src: [P("Half-split the donor line")], yes: "F5", no: "c" }),
  q("c", "Is the donor aimed as the aiming sheet says?", { how: "True and magnetic bearing and elevation angle from the sheet (NOAA WMM2025).", tool: "Compass, inclinometer", at: "Job > Pre-survey, donor aiming sheet", src: [A("Donor aiming sheet")], yes: "e", no: "c1" }),
  x("c1", "Re-aim the donor, then read again.", { next: "y" }),
  q("e", "Does another site or azimuth read better?", { how: "Scan each azimuth. Log the level, band, azimuth, tilt and height. Check Terrain paths: RF Recon gives no pass number for clearance. In the worked example, T-Mobile read −97 dBm with SINR 1 dB at 300°; a second donor at 20° read −84 dBm with SINR 7 dB.", tool: "Calibrated scanner", at: "Job > Pre-survey, Terrain paths", src: [A("Rooftop donor, Terrain paths"), E("Example job, fictional")], yes: "e1", no: "f" }),
  x("e1", "Re-aim, change site, or add a second donor.", { how: "Then update the link budget. Gain can't fix a weak, noisy donor.", who: "Radio shop or carrier", warn: "Public safety: only a site the radio shop names, and one site on simulcast. Update the consent if the azimuth changes.", at: "Job > Design, Link budget", src: [E("Example job, fictional")], next: "y" }),
  q("y", "Is the donor level usable now?", { how: "Read it again at the donor port.", good: "Cellular: RSRP −95 dBm, SINR 0 dB or better. Public safety: inside any AHJ window, and the link budget's downlink row passes.", tool: "Calibrated receiver or scanner", src: [A("Rooftop donor, Commissioning step 5")], yes: "z", no: "e" }),
  s("f", "Stop. Ask the radio shop or carrier for another source.", { how: "Public safety: a different donor site. Cellular: a carrier-fed source or the carrier's small cell.", who: "Radio shop or carrier", src: [P()] }),
  q("h", "Is uplink at the site above the window?", { how: "Research default top −75 dBm: OCSD −95 to −75 dBm, Douglas −100 to −80 dBm, Durham −80 dBm top.", at: "Job > Design, Link budget", src: [A("Uplink check"), R("AHJ documents, as cited")], yes: "h1", no: "i" }),
  x("h1", "Lower the uplink gain.", { how: "Then recheck uplink over sensitivity and noise rise.", at: "Job > Design, Link budget", src: [A("Too hot; lower the uplink gain")], next: "z" }),
  s("i", "Stop. Check the booster's maximum input on its datasheet.", { how: "No source gives an overdrive limit, and RF Recon has no check for it. Compare the donor level with the maker's number.", who: "Booster's maker", src: [P("No source: gap")] }),
  ok("z", "Donor level is usable.", {}),
]);

tree("F4", { kind: "fault", scope: "both", title: "PIM run fails", group: "Cable network",
  see: "PIM reads over the limit. In a live system: raised receive noise, shorter calls, more drops, often after handover as power and traffic rise.",
  who: "Our technician", tools: "PIM analyzer, low-PIM load, PIM standard, line analyzer, torque wrench", call: "the PIM analyzer's maker or a PIM specialist" }, [
  q("a", "Is your set-up valid?", { how: "Warm up 10 min. Residual with flexed lead at least 10 dB under the limit. PIM standard within 3 dB. VSWR under 1.92:1. External signal at the IM frequency at least 10 dB under the limit.", tool: "PIM analyzer, low-PIM load, PIM standard", at: "PIM, checklists", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours. Do not inject tones into BDA ports. Get advance permission from affected licensees before radiating.", src: [R("IEC 62037-7, as cited in the PIM research")], yes: "b", no: "a1" }),
  x("a1", "Fix the set-up, then test again.", { how: "Clean adapters, swap the test lead, use a low-PIM load.", src: [E("PIM research")], next: "a" }),
  q("b", "Are test power and limit right for this point?", { how: "A dBc number means nothing without test power. Compare at the same power. Default −140 dBc at 2 x 43 dBm. Stricter −150 dBc. Testing inside the DAS at power reduced by loss L: relax the dBm limit by L and the dBc limit by 2L (Valmont).", src: [A("PIM runs"), E("PIM research")], yes: "c", no: "b1" }),
  d("b1", "Correct the test power or limit, then test again.", { next: "b" }),
  q("c", "Tap and flex: does the reading jump at a connector?", { how: "PIM against time first, then five taps per connector with a plastic handle or rubber end, and flex the cables. No harder than knocking on a door, never on the cable.", tool: "PIM analyzer, plastic tapper", src: [E("PIM research: loose connectors are probably the most common site fault")], yes: "x", no: "e" }),
  q("e", "Locate it. Is the hit in the feed line?", { how: "Distance-to-PIM with the correct Vp, overlaid on distance-to-fault. To tell inside from beyond: tape a bagged steel-wool marker to the radome, store the trace, move it at least 3 m away, and re-measure. Relative distance under 0 is in the feed, 0 is at the antenna, over 0 is beyond it.", tool: "PIM analyzer with DTP, steel wool marker", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours. Nobody touches an antenna under test.", src: [E("PIM research")], yes: "x", no: "f" }),
  x("x", "Inspect, clean, and re-torque or re-terminate at the hit.", { how: "Clean with IPA, a lint-free wipe and low-pressure air. Torque per the Limits page. In the worked example, a loose N connector at the floor 2 splitter 84 ft out went from −135 dBc to −149 dBc after a retorque.", tool: "Torque wrench", src: [E("PIM research"), E("Example job, fictional")], next: "y" }),
  q("y", "Does the run pass now?", { how: "Re-test fully, not just the connector you touched.", tool: "PIM analyzer", at: "PIM", src: [A("PIM runs"), E("PIM research")], yes: "z", no: "c" }),
  q("f", "Is the source at or beyond the antenna?", { how: "Rusty bolts, ferrous metal, lightning arrestors and ferrite parts can all cause it. Walk a PIM probe along the DTP arc.", tool: "PIM probe", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours.", src: [E("PIM research")], yes: "f1", no: "f2" }),
  x("f1", "Move the antenna about 1 m, or remove the source.", { src: [E("PIM research")], next: "y" }),
  s("f2", "Stop. Still failing with no hit found.", { how: "Fixed-frequency tests can falsely pass when two sources cancel, so sweep it. For VHF, and UHF below 380 MHz, no published PIM test practice or field analyzer was found: compute IM3 and IM5 for each pair of downlink channels against every uplink channel on paper.", who: "PIM specialist", src: [E("PIM research: VHF is a gap")] }),
  ok("z", "PIM passes.", {}),
]);

tree("F5", { kind: "fault", scope: "both", title: "Sweep fails: return loss or insertion loss", group: "Cable network",
  see: "Far-end antennas are weak with the BDA output correct. A sweep fails at a connector or a kink. Insertion loss is high.",
  who: "Our technician", tools: "Line analyzer (Site Master, SiteHawk, FieldFox, NanoVNA)", call: "the installer" }, [
  q("a", "Are you using the right limit?", { how: "14 dB (VSWR 1.5:1) common practice, not code. CU Denver 20 dB at any connector, an owner spec. Looking into an antenna, 9.5 dB (VSWR 2:1).", at: "PIM > Sweeps", src: [A("Sweep limits")], yes: "b", no: "a1" }),
  d("a1", "Pick the limit that applies, and re-grade.", { at: "PIM > Sweeps", next: "a" }),
  q("b", "Which test failed?", { src: [A("Sweeps")], opts: [{ l: "Return loss", to: "c" }, { l: "Insertion loss", to: "g" }] }),
  d("c", "Find it with distance-to-fault.", { how: "Worst point: look at what's at that distance. Resolution in m = 150 x Vp / sweep width in MHz. You can ignore reflections past N ft, the antenna or load.", tool: "Line analyzer", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours.", at: "PIM > Sweeps", src: [A("DTF"), E("PIM research")], next: "e" }),
  q("e", "What's at that distance?", { how: "Dented cable can still pass PIM and fail a sweep: PIM and return loss measure different things.", src: [E("PIM research")], opts: [{ l: "Connector", to: "x" }, { l: "Splitter or coupler", to: "e1" }, { l: "Kink or dent", to: "e2" }, { l: "Antenna", to: "e3" }] }),
  x("x", "Re-terminate or replace the connector.", { how: "Look for gaps, over-tightening, debris, corrosion, cutting chips, wrong centre-pin depth.", tool: "Torque wrench, termination kit", src: [E("PIM research")], next: "f" }),
  x("e1", "Replace the part, and check its ports.", { src: [P()], next: "f" }),
  x("e2", "Replace that length of cable.", { how: "Solid-outer-conductor cable only: no braided cable, no joiners, no inter-series adapters (MCF).", src: [E("PIM research")], next: "f" }),
  x("e3", "Replace the antenna, or check its jumper.", { src: [P()], next: "f" }),
  q("f", "Does it pass the sweep now?", { tool: "Line analyzer", at: "PIM > Sweeps", src: [A("Sweeps")], yes: "z", no: "c" }),
  q("g", "Is the cable length and type in RF Recon right?", { how: "Limit = datasheet loss per 100 ft x length + 0.1 dB per connector + 0.5 dB tolerance, scaled by the square root of frequency past the datasheet. Radiating cable: sweep from both ends on runs over 400 ft.", at: "PIM > Sweeps", src: [A("Insertion loss limit"), E("PIM research")], yes: "c", no: "g1" }),
  x("g1", "Correct it, and re-grade.", { next: "f" }),
  ok("z", "Sweep passes.", {}),
]);

tree("F6", { kind: "fault", scope: "both", title: "Square fails: not enough signal", group: "Coverage",
  see: "A square fails the level, or a pocket fails: elevator lobbies, cores, stairs, behind low-E glass or concrete, deep interior, basements.",
  who: "Our technician, designer", tools: "Calibrated receiver or scanner, RF Recon", call: "the designer" }, [
  q("a", "Does it still fail at the square's centre with a calibrated instrument?", { how: "One test point near each area's centre. For cellular, each carrier and layer on its own.", tool: "Calibrated receiver or scanner", at: "Job > Grid test", src: [A("Grid test"), R("IFC 510.5.4, as cited")], yes: "b", no: "z" }),
  q("b", "How wide is the failure?", { how: "Half-split: if everything is down, look at the booster and donor. If one branch is down, look at the cable. If one pocket is down, look at the building.", src: [P("Half-split")], opts: [{ l: "Whole building", to: "c" }, { l: "One branch or floor", to: "e" }, { l: "One pocket", to: "f" }] }),
  q("c", "Do donor level and booster gain match the commissioning record?", { tool: "Analyzer, BDA software", at: "Job > Commissioning", src: [A("Commissioning record")], yes: "f", no: "c1" }),
  q("c1", "Which one moved?", { src: [P()], then: "a", opts: [{ l: "Donor level", to: "F3" }, { l: "Gain or alarm", to: "F1" }] }),
  q("e", "Does the antenna port have the power the design says?", { how: "Check against the per-antenna table.", tool: "Line analyzer, power meter", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours.", at: "Job > Design, per-antenna table", src: [A("Per-antenna table")], yes: "f", no: "F5" }),
  d("f", "Compare predicted and measured here.", { how: "Green within 3 dB, amber within 6 dB, red beyond. Concrete 203 mm at 750 MHz measured 21.5 dB against 6 to 7 dB modelled. Low-E glass about 15 dB at 800 MHz in energy-efficient windows. Elevator shaft and metal deck: no measured values found.", at: "Job > Design, Prediction vs walk", src: [A("Prediction vs walk"), E("Plans research")], next: "g" }),
  x("g", "Add or move an antenna, or raise gain within isolation.", { how: "Draw the real walls first. In the worked example, a seventh antenna in each elevator lobby covered the core's shadow.", at: "Job > Design", src: [E("Example job, fictional")], next: "h" }),
  q("h", "Does the link budget still pass, including isolation?", { how: "After a gain or antenna change, re-run Commissioning steps 1, 3 and 4, in that order.", at: "Job > Design, Link budget", src: [A("Link budget checks")], yes: "a", no: "F19" }),
  ok("z", "The square passes.", {}),
]);

tree("F7", { kind: "fault", scope: "e", title: "Good level, bad audio", group: "Coverage",
  see: "Garbled or dropped audio with full bars. The level passes and DAQ, SINR or BER fails. A talk-back call isn't clear.",
  who: "Our technician, radio shop", tools: "IBflex, S412E or similar, agency radios", call: "the radio shop" }, [
  q("a", "Have you measured SINR, BER or DAQ on that channel?", { how: "DAQ 3.0 equals SINR 18 dB and BER 2.5%. DAQ 3.4 equals SINR 18 dB and BER 2% in RF Recon. The AHJ's figure wins: San Diego and LA County 20 dB and 2%, Durham 17.7 dB and 2.0%.", tool: "IBflex or S412E (the S412E measures BER, not SINR)", at: "Job > Grid test", src: [A("Equivalent defaults"), R("NFPA A.20.3.10, as cited")], yes: "b", no: "a1" }),
  d("a1", "Measure it at the failing point.", { next: "a" }),
  q("b", "Is this a simulcast channel?", { how: "Look for the simulcast mark in Pre-survey.", at: "Job > Pre-survey", src: [A("Simulcast flag")], yes: "F17", no: "c", then: "r" }),
  q("c", "Does it improve with the booster off?", { how: "Only with the radio shop's say-so. This is a weak test: turning the booster off drops indoor signal too, so it separates little. A spur on the analyzer points at oscillation.", src: [P("Weak test")], then: "r", opts: [{ l: "Better, spur on the analyzer", to: "F1" }, { l: "Better, no spur", to: "F4" }, { l: "No better", to: "e" }] }),
  q("r", "Does the channel pass now?", { how: "Measure it again at the failing point.", tool: "IBflex or S412E", at: "Job > Grid test", src: [A("Grid test")], yes: "z", no: "e" }),
  d("e", "Look for an interferer.", { how: "Find a signal takes levels at 3 or more spots with compass bearings. It narrows the search; it doesn't replace a directional antenna.", at: "Mission > Find a signal", tool: "Directional antenna", src: [A("Find a signal")], next: "e1" }),
  s("e1", "Stop. Take your numbers to the radio shop.", { how: "Only the simulcast cause has a sourced mechanism. Other causes need the system's owner.", who: "Radio shop", src: [P("No source for the order")] }),
  ok("z", "Audio passes.", {}),
]);

tree("F8", { kind: "fault", scope: "e", title: "Floor fails on count", group: "Coverage",
  see: "Some squares failed and you need to know whether the floor passes.",
  who: "Our technician, AHJ", tools: "RF Recon", call: "the AHJ" }, [
  q("a", "Are any squares untested?", { how: "A floor can't pass with untested squares. The report says Not complete.", at: "Job > Grid test", src: [A("Floor result")], yes: "a1", no: "b" }),
  d("a1", "Test them.", { next: "a" }),
  q("b", "Which rule is this job on?", { how: "Any count but 20 or 40 squares: pick Percent.", at: "Job > Requirements", src: [A("Grid rule")], opts: [{ l: "IFC 20 areas", to: "c" }, { l: "Percent", to: "g" }] }),
  q("c", "How many of the 20 areas failed?", { how: "More than 1 fails the floor. Exactly 2 may be re-divided into 40.", src: [A("IFC 510.5.4 rule")], opts: [{ l: "None, or 1 general", to: "z" }, { l: "1 critical", to: "F6" }, { l: "Exactly 2", to: "e" }, { l: "3 or more", to: "F6" }] }),
  d("e", "Re-divide the floor into 40 areas and retest.", { how: "The 40 squares start empty: mark critical and do-not-test squares again.", at: "Job > Grid test", src: [A("IFC 510.5.4 rule")], next: "f" }),
  q("f", "At 40, are no more than 2 failed, with none sharing an edge?", { src: [A("IFC 510.5.4 rule")], yes: "z", no: "F6" }),
  q("g", "Does it meet the profile's percentages?", { how: "Default 95% general and 99% critical. Exact: 94.7% is not 95%. College Station: 2 or more adjacent failed grids fail.", at: "Job > Grid test", src: [A("Percent rule")], yes: "z", no: "F6" }),
  ok("z", "The floor passes.", {}),
]);

tree("F9", { kind: "fault", scope: "both", title: "Reading not counted, or untested", group: "Test results",
  see: "A reading shows grey. A square says untested for uplink. The report says Not complete.",
  who: "Our technician", tools: "Calibrated instrument", call: "the instrument's calibration lab" }, [
  q("a", "Which is it?", { at: "Job > Grid test", src: [A("Calibration rule")], opts: [{ l: "Grey, not counted", to: "b" }, { l: "Untested for uplink", to: "f" }] }),
  q("b", "Is the instrument on the job's list?", { at: "Job > Overview, Testing", src: [A("Calibration rule")], yes: "c", no: "b1" }),
  x("b1", "Add it with its calibration date, then name the readings.", { how: "The one-click fix names old readings.", at: "Job > Overview, Testing", src: [A("Calibration rule")], next: "b" }),
  q("c", "Is it an SDR, a phone or a quick check?", { how: "Those never count. A phone can be characterised against a calibrated instrument, and still stays 'not calibrated'.", src: [A("Calibration rule, phone correction")], yes: "c1", no: "e" }),
  x("c1", "Retest with a calibrated instrument.", { next: "z" }),
  q("e", "Is it inside 12 months, or inside the certificate's expiry?", { how: "A certificate's own expiry date overrides the 12-month rule and runs to the end of that day. Recalibration lead time isn't in our sources: plan for it.", at: "Job > Overview, Testing", src: [A("Calibration rule")], yes: "z", no: "e1" }),
  x("e1", "Recalibrate, or use a calibrated instrument, and retest.", { next: "z" }),
  q("f", "Does the profile really need uplink in every square?", { how: "San Diego, Clark County, Seattle, Santa Clara, Riverside and Charlotte do. Miami-Dade says DO NOT TEST OR CONNECT UPLINK.", at: "Job > Requirements", src: [A("AHJ profiles")], yes: "f1", no: "f2" }),
  x("f1", "Take a calibrated uplink reading in that square.", { next: "z" }),
  s("f2", "Stop. Only the AHJ can change this.", { how: "Get it in writing, then edit the profile.", who: "AHJ", src: [P()], next: "z" }),
  ok("z", "The reading counts.", {}),
]);

tree("F10", { kind: "fault", scope: "e", title: "Square is too close to call", group: "Test results",
  see: "The grid passes it, and Screening says too close to call.",
  who: "Our technician", tools: "Calibrated receiver", call: "the designer" }, [
  q("a", "What does Screening say about this square?", { how: "Margin minus accuracy 0 or more: likely pass. Margin plus accuracy under 0: likely fail. Otherwise too close. IBflex ±1 dB, S412E ±1.25 dB, PRiSM ±2 dB, COMPASS XR ±2 dB. In the worked example, square 3-5 read −94.5 dBm, 0.5 dB over the line with a ±1 dB instrument.", at: "Job > Screening", src: [A("Screening")], opts: [{ l: "Likely pass", to: "z" }, { l: "Too close to call", to: "b" }, { l: "Likely fail", to: "F6" }] }),
  q("b", "Does it pass clearly on a recheck?", { how: "Recheck before the AHJ walks it.", tool: "Calibrated receiver", src: [A("Screening")], yes: "z", no: "c" }),
  x("c", "Add margin: gain within isolation, or an antenna.", { src: [A("Screening")], next: "b" }),
  ok("z", "Safe to walk with the witness.", {}),
]);

tree("F11", { kind: "fault", scope: "e", title: "Supervisory alarm", group: "Power and monitoring",
  see: "An alarm is open on the BDA, on the panel, or in RF Recon's Monitoring list.",
  who: "Fire alarm technician, our technician", tools: "Panel access, multimeter, BDA software", call: "the fire alarm contractor" }, [
  q("a", "Which signal is it?", { how: "The eight signals in NFPA 1225 18.14.1.2 and IFC 510.4.2.5. RF Recon reads traps only and never sends SNMP to a BDA. OCSD: this panel is an extra, not the monitoring it approves.", at: "Job > Overview, Monitoring", src: [A("Supervisory signals")],
    opts: [{ l: "Signal source", to: "F3" }, { l: "Oscillation", to: "F1" }, { l: "Low battery", to: "F13" }, { l: "Charger", to: "F13" }, { l: "AC loss", to: "b" }, { l: "Active RF device or component", to: "c" }, { l: "FACU link", to: "e" }, { l: "It doesn't reach the panel", to: "e" }], then: "z" }),
  x("b", "Find the power fault.", { how: "Check the dedicated circuit and breaker. Battery time is running while you do.", tool: "Multimeter", src: [P()], next: "z" }),
  s("c", "Stop. Call the booster's maker.", { how: "No source gives a fault procedure. Read the alarm text and note it.", who: "Booster's maker", src: [P("No source")] }),
  s("e", "Stop. This is the fire alarm contractor's side.", { how: "No source covers panel wiring. What you need to give them: UL 2524 wants annunciation within 200 s, and NFPA 18.14 wants a dedicated annunciator in the fire command center with 7 labelled indications per device.", who: "Fire alarm contractor", src: [R("Honeywell and NFPA 18.14, as cited")] }),
  ok("z", "Alarm clear.", {}),
]);

tree("F12", { kind: "fault", scope: "e", title: "BDA has gone quiet", group: "Power and monitoring",
  see: "RF Recon says a BDA hasn't been heard from.",
  who: "Owner's site contact, our technician", tools: "Site access, BDA software", call: "the owner's site contact" }, [
  q("a", "Is the BDA powered up on site?", { how: "Default quiet limit 24 hours. A BDA that goes quiet may have lost power, its network or its monitor.", tool: "Site visit, or the owner's contact", at: "Job > Overview, Monitoring", src: [A("Quiet timer")], yes: "b", no: "F11" }),
  q("b", "Can you reach it on its network?", { how: "Traps come in on SNMP v1 or v2c, UDP port 1162 by default, matched to a job by source address or community.", src: [A("Monitoring")], yes: "c", no: "b1" }),
  s("b1", "Stop. It's a network fault.", { who: "Owner's IT", src: [P()] }),
  x("c", "Check the monitor's address and community match.", { at: "Job > Overview, Monitoring", src: [A("Monitoring")], next: "z" }),
  ok("z", "Heard from again.", {}),
]);

tree("F13", { kind: "fault", scope: "e", title: "Battery or charger", group: "Power and monitoring",
  see: "Low battery or charger alarm. The battery fails its load test.",
  who: "Our technician", tools: "Load test kit, multimeter", call: "the battery or booster maker" }, [
  q("a", "Is the charger alarm on?", { how: "No source gives a charger procedure.", at: "Job > Overview, Monitoring", src: [A("Supervisory signals")], yes: "a1", no: "b" }),
  s("a1", "Stop. Call the maker.", { who: "Booster's maker", src: [P("No source")] }),
  q("b", "Does it pass a 1-hour load test?", { how: "At acceptance and every year. Low battery signals at 70% of the 12-hour capacity used.", good: "No general figure: use the maker's end voltage and the AHJ's rule.", tool: "Load test kit", at: "Job > Grid test, acceptance tests", src: [A("Acceptance entries"), R("NFPA 18.14, as cited")], yes: "c", no: "e" }),
  q("c", "Is the battery sized for this AHJ?", { how: "Amp-hours = load x hours x 1.2. 12 hours by default, 24 hours at OCSD, LA County, McKinney, Santa Clara and FDNY.", at: "Job > Design, Battery", src: [A("Battery")], yes: "z", no: "e" }),
  x("e", "Replace the battery.", { how: "Murray UT: replace under 70%. OCSD: replace after 3 years. Batteries NEMA 3R or better.", warn: "Lock off the BDA before you disconnect anything. In service: book the outage with the radio shop and owner first. Seattle: tell the fire code official if it's out over 8 hours.", src: [R("AHJ profiles, codes research")], next: "b" }),
  ok("z", "Battery passes.", {}),
]);

tree("F14", { kind: "fault", scope: "e", title: "Licence changed under the job", group: "Paperwork",
  see: "RF Recon's licence watch raised a finding after an FCC data refresh.",
  who: "Licensee's radio shop", tools: "RF Recon", call: "the radio shop" }, [
  q("a", "What is the finding?", { how: "Findings: licence gone, status no longer Active, downlink channels dropped, donor site gone, new licensee on a job channel (all high), new licensee in the passband (medium). Expiry within 90 days also shows.", at: "DAS > Board, Needs you", src: [A("Licence watch")],
    opts: [{ l: "Channels or donor changed", to: "b" }, { l: "New licensee", to: "c" }, { l: "Licence ending", to: "e" }, { l: "Licence gone or not Active", to: "b" }] }),
  d("b", "Confirm with the radio shop, then retune and retest.", { how: "Don't change anything from the FCC data alone.", who: "Radio shop", src: [A("Retune and retest")], next: "z" }),
  d("c", "Add them to the passband list and ask for consent.", { at: "Job > Pre-survey, Passband licensees", src: [A("Passband licensees")], next: "y" }),
  d("e", "Ask the licensee what is happening.", { who: "Licensee", src: [A("Licence watch")], next: "y" }),
  q("y", "Is consent given?", { how: "A consent from a lapsed licence doesn't cover the new one.", at: "Job > Pre-survey, Passband licensees", src: [A("Licence watch")], yes: "z", no: "F18" }),
  ok("z", "Finding closed.", {}),
]);

tree("F15", { kind: "fault", scope: "both", title: "FCC interference notice", group: "Paperwork",
  see: "The owner or integrator receives a notice from the FCC.",
  who: "Owner, radio shop, Omnyra's lawyer", tools: "RF Recon, spectrum analyzer", call: "the owner and a lawyer" }, [
  s("a", "Stop. Do not answer it yourself.", { how: "No source gives a response procedure. Tell the owner today. The FCC finds noisy old boosters by direction finding. Example: Hallandale FL, 13 May 2025, a Class A booster at 799 to 805 MHz.", who: "Owner, lawyer", src: [A("Existing-system audit")], next: "b" }),
  d("b", "Run the existing-system audit.", { how: "14 items, including in-band noise cap −43 dBm ERP per 10 kHz, Class B registration, consent, channels outside passbands, age, and the last annual test.", at: "Job > Existing system", src: [A("Existing-system audit"), R("47 CFR 90.219, as cited")], next: "c" }),
  q("c", "Did the audit find a noise or oscillation problem?", { src: [A("Existing-system audit")], then: "z", opts: [{ l: "Noise", to: "F2" }, { l: "Oscillation", to: "F1" }, { l: "Neither", to: "z" }] }),
  ok("z", "Give the audit to the owner and the lawyer.", {}),
]);

tree("F16", { kind: "fault", scope: "e", title: "Estimate clears, the walk fails", group: "Coverage",
  see: "Pre-survey says the building clears. The walk finds it doesn't.",
  who: "Our technician, designer", tools: "Calibrated receiver", call: "the designer" }, [
  q("a", "Were you reading the free space estimate?", { how: "Free space is the best case. Use Realistic: Okumura-Hata plus terrain where cached. Hata is rougher below 150 MHz or under 1 km.", at: "Job > Pre-survey", src: [A("Free space and realistic estimates")], yes: "a1", no: "b" }),
  x("a1", "Switch to Realistic, and compare again.", { next: "b" }),
  q("b", "Is the construction row right for this building?", { how: "Rows: 14, 28, 31, 51, 50, 70, 90 dB. Low-E glass 23 to 27 dB at 0.5 to 0.9 GHz single coating, up to 40 to 54 dB multi-silver. In the example, the walk found −98 to −104 dBm behind low-E glass.", at: "Job > Pre-survey", src: [A("Building entry loss"), E("Plans research")], yes: "c", no: "b1" }),
  x("b1", "Pick the right row.", { next: "c" }),
  ok("c", "Trust the walk. Design to the measured loss.", { }),
]);

tree("F17", { kind: "fault", scope: "e", title: "Simulcast delay (TDI)", group: "Coverage",
  see: "Garbled or dropped audio with full bars on a simulcast channel. Digital P25 suffers most.",
  who: "Radio shop, designer", tools: "Directional donor antenna", call: "the radio shop" }, [
  q("a", "Has the radio shop confirmed it's simulcast?", { how: "A channel licensed at more than one site is marked. On a conventional licence, repeated listings may be separate repeaters or receive-only sites.", at: "Job > Pre-survey", src: [A("Simulcast flag")], yes: "b", no: "a1" }),
  q("a1", "What did the radio shop say?", { who: "Radio shop", src: [P()], opts: [{ l: "It's simulcast", to: "b" }, { l: "It isn't", to: "a2" }] }),
  ok("a2", "Not simulcast. Go back and keep looking.", {}),
  x("b", "Aim a directional donor at one site.", { how: "Ask the radio shop which. Keep the booster's delay low. Limits: Durham 32 µs, Sacramento 25 µs total, LA County 15 µs.", src: [A("Simulcast note"), R("AHJ documents, as cited")], next: "c" }),
  q("c", "Is the audio clear now?", { src: [P()], yes: "z", no: "c1" }),
  s("c1", "Stop. No source gives a way to measure delay.", { how: "Take it to the radio shop and the booster's maker.", who: "Radio shop, maker", src: [P("No source: gap")] }),
  ok("z", "Audio clear.", {}),
]);

tree("F18", { kind: "fault", scope: "both", title: "Consent or approval is stuck", group: "Paperwork",
  see: "A licensee or carrier hasn't answered, said no, or the radio shop won't allow the noise test.",
  who: "Owner, licensee or carrier", tools: "RF Recon's letters", call: "the licensee or carrier contact" }, [
  q("a", "Which is it?", { src: [A("Consent statuses")], opts: [{ l: "Public safety licensee", to: "b" }, { l: "Carrier", to: "e" }, { l: "Noise test blocked", to: "h" }] }),
  q("b", "Is there a known process for this licensee?", { how: "RF Recon lists Michigan MPSCS, Ohio MARCS, California CRIS, Maryland MD FiRST, Broward ORCAT, Douglas County, Fairfax, PSERN and the FirstNet Authority. Some are linked but not marked read. There is no published turnaround.", at: "Job > Overview, Compliance", src: [A("Licensee processes")], yes: "b1", no: "c" }),
  d("b1", "Use that process.", { at: "Job > Overview, Compliance", next: "c" }),
  s("c", "Stop. Do not activate. Keep asking, and tell the owner.", { how: "47 CFR 90.219(b)(1) and NFPA 1225 18.7.2 both need consent before activation. The AHJ has no authority to permit rebroadcast on someone else's licence.", who: "Licensee, owner", src: [R("90.219, NFPA 18.7.2, as cited"), E("Cellular research")] }),
  q("e", "Is there a public form?", { how: "T-Mobile: In-Building Telecommunications Agreement. AT&T, Verizon: no public form. FirstNet: makers route a Band 14 request form, and the address is in a maker's manual. A buyer expects a technical submission and written acknowledgment before activation.", src: [E("Cellular research")], yes: "e1", no: "f" }),
  d("e1", "Use that form.", { next: "f" }),
  q("f", "Can the owner wait?", { how: "Public record: AT&T said a signal source 'could take nine months or longer' (2022). Vendors claim 30 to 90 days for booster approvals, 6 to 12 months for active DAS design approval, 12 to 24 months carrier-direct. These are press and vendor claims, not carrier promises.", src: [E("Cellular research")], yes: "c2", no: "g" }),
  s("c2", "Stop. Do not switch on until the carrier consents, and tell the owner.", { how: "47 CFR 20.21(c): an industrial booster runs only with the licensee's express consent.", who: "Carrier, owner", src: [R("47 CFR 20.21(c)")] }),
  s("g", "Stop. Ask the carrier about another route.", { how: "A carrier-fed source or the carrier's small cell. Do not switch on without consent.", who: "Carrier", src: [P()] }),
  s("h", "Stop. The radio shop owns that site.", { how: "No source gives a fallback. Ask the AHJ how it wants this handled.", who: "Radio shop, AHJ", src: [P("No source")] }),
]);

tree("F19", { kind: "fault", scope: "both", title: "Link budget check is open or red", group: "Booster",
  see: "A row in the job's link budget isn't a pass.",
  who: "Designer", tools: "RF Recon", call: "the designer" }, [
  q("a", "Which row?", { how: "Open never counts as a pass.", at: "Job > Design, Link budget", src: [A("Link budget checks")],
    opts: [{ l: "Open: needs a number", to: "b" }, { l: "Downlink at far edge", to: "c" }, { l: "Uplink too hot", to: "e" }, { l: "Uplink too low", to: "f" }, { l: "ERP over 37 dBm", to: "g" }, { l: "Noise ERP or noise rise", to: "n" }, { l: "Isolation", to: "i" }, { l: "Headroom", to: "h" }], then: "z" }),
  x("b", "Enter what's missing.", { how: "Roof level, site distance and ERP, receiver sensitivity, or isolation.", at: "Job > Design, Link budget", src: [A("Open checks")], next: "z" }),
  q("c", "Is the donor itself healthy?", { how: "Edge must meet the AHJ minimum plus fade margin. Default minimum −95 dBm. Fade margin is 15 dB with the research loaded, and that 15 dB comes from a low-authority source: no code gives a margin.", at: "Job > Design, Link budget", src: [A("Downlink check"), E("Link budget research")], yes: "c1", no: "F3" }),
  x("c1", "Add or move an antenna, or raise gain within isolation.", { at: "Job > Design", src: [A("Link budget checks")], next: "z" }),
  x("e", "Lower the uplink gain.", { at: "Job > Design, Link budget", src: [A("Too hot; lower the uplink gain")], next: "z" }),
  x("f", "Cut passive loss or raise uplink gain, then recheck noise.", { how: "Default window starts at −95 dBm. Site sensitivity −118 dBm for P25 at 700, 800 and UHF, −119 dBm VHF, plus fade margin. More gain raises signal and noise together at the site.", at: "Job > Design, Link budget", src: [A("Uplink check"), E("Link budget research")], next: "z" }),
  x("g", "Lower output, or split across more antennas.", { how: "ERP per channel 37 dBm (5 W) or less, 47 CFR 90.219(d)(3)(i). EIRP = ERP + 2.15 dB.", at: "Job > Design, per-antenna table", src: [A("ERP check"), R("47 CFR 90.219(d)(3)(i), as cited")], next: "z" }),
  x("n", "Lower the planned uplink gain, or enter the datasheet noise figure.", { how: "These rows are calculated. Noise figure 9 dB is assumed until you enter one. On a built system, run the noise test instead (F2).", at: "Job > Design, Link budget", src: [A("Noise checks")], next: "z" }),
  x("i", "Plan more separation or less gain, and re-enter it.", { how: "A calculated row. On a built system, run the isolation test instead (F1).", at: "Job > Design, Link budget", src: [A("Isolation check")], next: "z" }),
  x("h", "Lower gain, or use a bigger booster.", { how: "Per-channel maximum = composite − 10 log10(channels) − backoff. NPSTC example: 27 dBm with 2 channels is 24 dBm with 4 and 21 dBm with 8. Dropping a channel needs the AHJ's and the licensee's OK.", at: "Job > Design, Link budget", src: [A("Headroom check"), E("NPSTC, in the link budget research")], next: "z" }),
  ok("z", "Recheck the row.", {}),
]);

tree("F20", { kind: "fault", scope: "both", title: "Wrong or unlisted part", group: "Paperwork",
  see: "RF Recon's parts check shows missing or problem.",
  who: "Our technician, supplier", tools: "Spec sheets", call: "the supplier" }, [
  q("a", "Is the problem only that the field is blank?", { how: "Booster, batteries and annunciators need a UL 2524 listing recorded. Boosters need NEMA 4 or 4X, an FCC ID and a class.", at: "Parts, job Materials", src: [A("Parts code checks")], yes: "a1", no: "b" }),
  x("a1", "Record it from the spec sheet.", { at: "Parts", next: "z" }),
  q("b", "Is it a consumer booster on a band it may not carry?", { how: "See the Pre-survey band list.", src: [A("Consumer band check")], yes: "b1", no: "c" }),
  x("b1", "Change to an industrial booster with express consent.", { next: "z" }),
  x("c", "Replace the part.", { how: "UL 2524 listings not updated by 2026-03-22 are withdrawn. Cable needs a 2-hour or 1-hour fire rating in non-sprinklered or high-rise buildings.", src: [A("Parts code checks"), R("NFPA 18.12.3.4, as cited")], next: "z" }),
  ok("z", "Part passes.", {}),
]);

tree("F21", { kind: "fault", scope: "both", title: "Report incomplete, late or rejected", group: "Paperwork",
  see: "The report says FAIL or Not complete, the packet has gaps, the AHJ sent it back, or a deadline is close.",
  who: "Tester, AHJ", tools: "RF Recon", call: "the AHJ" }, [
  q("a", "Does the report say PASS?", { how: "Not complete means untested squares or carriers.", at: "Job > Report", src: [A("Report")], opts: [{ l: "Yes", to: "b" }, { l: "No, public safety", to: "F8" }, { l: "No, cellular", to: "F6" }] }),
  q("b", "Does the packet index show every item?", { at: "Job > Report, packet index", src: [A("Packet index")], yes: "c", no: "b1" }),
  x("b1", "Fill each gap the index names.", { next: "b" }),
  q("c", "Does the AHJ need a third-party statement?", { how: "San Diego and Santa Clara want the independence statement. Sealed final reports carry a verify code on every page.", at: "Job > Report", src: [A("Tester statement, sealed report")], yes: "c1", no: "e" }),
  x("c1", "Add the statement.", { next: "e" }),
  q("e", "Is it filed the way the AHJ wants?", { how: "San Diego: stamped report to The Compliance Engine. Seattle: 24 hours before inspection. OCSD: 30 calendar days. Denver: 30 days after each five-year interval.", at: "Job > Overview, Lifecycle", src: [A("AHJ deadlines")], yes: "z", no: "e1" }),
  x("e1", "File it, and record the date.", { next: "z" }),
  ok("z", "Report in.", {}),
]);

tree("F22", { kind: "fault", scope: "both", title: "Fiber or remote unit", group: "Cable network",
  see: "A remote unit alarm, low optical power, or an OTDR result you can't judge.",
  who: "The system's maker", tools: "Fiber test set, the maker's manual", call: "the system's maker" }, [
  s("a", "Stop. Our sources give no fiber numbers.", { how: "No optical power limit, OTDR threshold or remote alarm procedure is in the research. Use the maker's manual and record the results: they are a close-out item. For PIM, treat each remote as the combiner point (MCF 3.18.2).", who: "System's maker", src: [P("No source: gap"), E("PIM and cellular research")] }),
]);

tree("F23", { kind: "fault", scope: "e", title: "A flag on the Pre-survey list", group: "Paperwork",
  see: "Uplink says ask licensee, or the list shows ESMR, Band 14 or simulcast.",
  who: "Licensee, FirstNet Authority", tools: "RF Recon", call: "the licensee" }, [
  q("a", "Which flag?", { at: "Job > Pre-survey", src: [A("Pre-survey flags")], opts: [{ l: "Ask licensee", to: "b" }, { l: "ESMR", to: "c" }, { l: "Band 14", to: "e" }, { l: "Simulcast", to: "F17" }], then: "z" }),
  d("b", "Get the uplink list from the licensee.", { who: "Licensee", src: [A("Uplink column"), R("OCSD intake, as cited")], next: "z" }),
  x("c", "Keep ESMR 862 to 869 MHz out of the booster.", { src: [A("ESMR flag")], next: "z" }),
  q("e", "Do you have the FirstNet Authority's written authorization?", { how: "Without it, filter Band 14 out. Broward and Douglas require it filtered.", src: [A("Band 14 flag"), R("AHJ documents, as cited")], yes: "e2", no: "e1" }),
  q("e2", "Does the AHJ require it filtered anyway?", { how: "Broward and Douglas County do.", src: [R("AHJ documents, as cited")], yes: "e1", no: "z" }),
  x("e1", "Filter Band 14 out.", { next: "z" }),
  ok("z", "Flag handled. Go back to the list.", {}),
]);

tree("F24", { kind: "fault", scope: "both", title: "AHJ, code edition or amendment unknown", group: "Paperwork",
  see: "You don't know who signs off, which code edition they enforce, or whether they've amended it.",
  who: "Fire marshal's office, state fire marshal", tools: "RF Recon, a browser, a phone", call: "the state fire marshal's office" }, [
  d("a", "Run the AHJ lookup.", { how: "It suggests fire departments from the Census place and county the pin is in. It's a lead, not an answer: the registry names departments, not fire marshal offices, and took no updates after June 2026. In the 11/5 trial it named the wrong office at 2 of 4 places.", at: "Job > Overview, AHJ", src: [A("AHJ guess")], next: "b" }),
  q("b", "Where does the building sit?", { how: "The lookup shows the Census place. Ask the owner if the land is state, federal or tribal.", src: [P()], opts: [{ l: "Inside a city", to: "c" }, { l: "Outside any city", to: "c1" }, { l: "State, federal or tribal", to: "c2" }] }),
  d("c", "Start with the city's fire marshal.", { src: [P()], next: "e" }),
  d("c1", "Start with the county fire marshal or fire district.", { src: [P()], next: "e" }),
  s("c2", "Stop. Local code may not apply. Ask the owner who their fire code official is.", { who: "Owner", src: [P()], next: "e" }),
  d("e", "Check state law first.", { how: "State law can remove the requirement. The Code check shows your state's row and how far it was read. Indiana bars requiring one in a Class 1 structure from July 1, 2026. Minnesota deletes IFC 510, so it's required only where a city adopts the appendix. NASFM's State Fire Marshals' Offices page links every state.", tool: "firemarshals.org/State-Fire-Marshals", at: "Job > Overview, Code check", src: [A("State rules"), R("Indiana HEA 1001: a person still confirms the wording")], next: "f" }),
  d("f", "Find the code edition.", { how: "ICC's adoption map gives state-level I-Code details. UpCodes lists adoptions by jurisdiction. These trackers disagree with each other, so each is a lead. NFPA's CodeFinder has been discontinued.", tool: "iccsafe.org code adoptions, up.codes", warn: "An edition from a tracker isn't confirmed until the AHJ says so.", src: [E("ICC, UpCodes, NFPA, read 11/5")], next: "g" }),
  d("g", "Search the local code for the amendment.", { how: "Look in the building or fire title of the municipal code: Municode, American Legal, or [city].municipal.codes. Search fire code 510, emergency responder radio coverage, emergency responder communication coverage, ERCES.", tool: "Municipal code site", src: [E("Bellevue, Corona, Los Angeles and Seattle examples, read 11/5")], next: "h" }),
  d("h", "Look for the fire department's own guideline.", { how: "Some rules live outside the code. Corona ties compliance to a Fire Department guideline. Cosumnes CSD publishes its own construction standard. Search the department's site for ERCES, BDA or radio coverage.", tool: "Fire department website", src: [E("Corona and Cosumnes examples, read 11/5")], next: "i" }),
  q("i", "Did the fire marshal's office confirm it?", { how: "Call and ask: which fire code and edition do you enforce, and what have you amended? Do you have a written ERCES policy? Who makes the final call, and how do we appeal? Who runs the radio system? Do you need a third-party tester? At which stages do you want to be involved?", good: "A named person, the edition, any amendment, in an email.", tool: "Phone, then email", who: "Fire marshal's office", src: [E("NFSA: the only way to know is to call. SBC, Working With Code Officials")], yes: "j", no: "k" }),
  d("j", "Save who confirmed it, and the date.", { how: "Fill in the Code check: name, date and how. That clears the Lead gate. Pick the matching AHJ profile, or type the numbers. A profile from a search excerpt doesn't outrank this.", at: "Job > Overview, Code check", src: [P()], next: "z" }),
  s("k", "Stop. Don't start design on a guess.", { how: "Try the state fire marshal's office next. It may be the AHJ where there's no local office.", who: "State fire marshal", src: [P()], next: "i" }),
  ok("z", "AHJ, edition and amendment confirmed.", {}),
]);

/* ---------------------------------------------------------------- the signal path */
FI.tps = [
  { id: "TP0", name: "Agency or carrier site", x: 70, t: "Receiver multicoupler or NOC", e: "Noise rise under 1 dB (10 kHz RBW, 5 min). Uplink window −95 to −75 dBm by default research; San Francisco −95 to −70 dBm, Greensboro −95 to −65 dBm (search excerpt). −150 dBm limits are calculated, on the link budget.", c: "NOC reads under 1 dB rise, borrowed from NFPA. No carrier spec is public.", f: ["F2", "F3"] },
  { id: "TP1", name: "Donor antenna", x: 220, t: "On the roof, at the antenna", e: "Bearing and elevation per the aiming sheet. Compare the roof level with the link budget.", c: "Target RSRP −85 dBm, SINR 5 dB. Minimum −95 dBm, SINR 0 dB.", f: ["F3"] },
  { id: "TP2", name: "Donor line", x: 350, t: "Donor cable and surge protector", e: "Return loss 14 dB common practice. Insertion loss = datasheet x length + 0.1 dB per connector + 0.5 dB.", c: "Same as public safety.", f: ["F5", "F4"] },
  { id: "TP3", name: "Booster (BDA)", x: 500, t: "BDA ports and software", e: "Isolation at least gain + 20 dB. ERP 37 dBm per channel or less. Noise −43 dBm ERP per 10 kHz or less. No oscillation. Donor port: no NFPA window.", c: "Isolation at least gain + 20 dB. Consumer caps 17 dBm downlink, 30 dBm uplink. Gains match the consent.", f: ["F1", "F2", "F19"] },
  { id: "TP4", name: "Head-end and riser", x: 650, t: "Splitters, couplers, riser", e: "Return loss 14 dB. PIM −140 dBc at 2 x 43 dBm if asked for. 2-way 3.6 dB, 3-way 5.2 dB, 4-way 6.5 dB.", c: "PIM −140 dBc default. Use the carrier's number. Fiber and remotes: the maker's manual.", f: ["F5", "F4", "F22"] },
  { id: "TP5", name: "Floor antennas", x: 800, t: "Each server antenna", e: "ERP 37 dBm or less per antenna. Return loss 9.5 dB looking into the antenna.", c: "Return loss 9.5 dB. Each carrier and band on its own.", f: ["F5", "F6"] },
  { id: "TP6", name: "Radio on the floor", x: 950, t: "The square's centre", e: "−95 dBm by default, DAQ 3.0, 95% general, 99% critical. The AHJ profile wins.", c: "RSRP −95 dBm, SINR 5 dB, 95% (Common). The carrier's number wins.", f: ["F6", "F7", "F9", "F10"] },
];
FI.tpsLow = [
  { id: "TP7", name: "Battery and charger", x: 410, t: "BDA power", e: "12 hours by default, 24 hours at some AHJs. Low battery signal at 70%. 1-hour load test.", c: "No code requirement found for a carrier-only DAS.", f: ["F13"] },
  { id: "TP8", name: "Annunciator and fire panel", x: 590, t: "Fire command center", e: "Eight supervisory signals. Annunciation within 200 s (UL 2524, as cited). 7 labelled indications per device.", c: "Not a carrier requirement.", f: ["F11", "F12"] },
];

/* ---------------------------------------------------------------- reference tables */
FI.limits = [
  { h: "Coverage and audio", rows: [
    ["Level inside", "−95 dBm", "IFC 2021 510.4.1.1. IFC 2024 and NFPA 1225: DAQ only, no dBm."],
    ["Audio", "DAQ 3.0", "Design to 3.4 (NFPA A.18.9.1). DAQ 3.0 = SINR 18 dB, BER 2.5%."],
    ["DAQ 3.4 equivalent", "SINR 18 dB, BER 2%", "San Diego and LA County 20 dB, 2%. Durham 17.7 dB, 2.0%."],
    ["Area", "95% general, 99% critical", "FDNY, LA County and Prosper 100% critical. Older NFPA 72 used 90% general."],
    ["Grid", "20 areas per floor", "Each 20 to 80 ft. Over 128,000 sq ft, split into sectors. Denver 20 x 20 ft. Seattle 6,400 sq ft or less."],
    ["Cellular", "RSRP −95 dBm, SINR 5 dB, 95%", "Common profile. −100 dBm at 3.3 GHz and up. No US carrier publishes a spec."],
  ] },
  { h: "Booster", rows: [
    ["Isolation", "Gain + 20 dB", "RF Recon warns from +15 to +20 dB. McKinney 15 dB."],
    ["ERP per channel", "37 dBm (5 W)", "47 CFR 90.219(d)(3)(i)."],
    ["Noise ERP", "−43 dBm per 10 kHz", "47 CFR 90.219(d)(6)(ii). Noise figure 9 dB assumed."],
    ["Noise rise at site", "Under 1 dB", "1 dB or more: cut until gone, then 3 dB more. −150 dBm OCSD, San Diego, LA, Santa Clara, −153 dBm Durham and −145 dBm Douglas are calculated limits, on the link budget: thermal noise in 10 kHz is −134 dBm."],
    ["Uplink at site", "−95 to −75 dBm", "Research default. Douglas −100 to −80 dBm. San Francisco −95 to −70 dBm. Greensboro −95 to −65 dBm (search excerpt)."],
    ["Uplink gain cap", "65 dB where set", "OCSD, San Diego, Durham, LA County, Douglas. Sacramento 75 dB total. 90.219 sets no gain limit."],
    ["Consumer booster", "17 dBm down, 30 dBm up", "47 CFR 20.21. Over this: industrial booster with express consent."],
    ["Fade margin", "15 dB with research loaded", "0 without it. From a low-authority source. No code gives a margin."],
  ] },
  { h: "Cable network", rows: [
    ["PIM", "−140 dBc at 2 x 43 dBm", "−150 dBc stricter. −153 dBc is a part rating. NFPA 1225 asks for none."],
    ["Return loss", "14 dB (VSWR 1.5:1)", "Common practice. CU Denver 20 dB. Into an antenna 9.5 dB."],
    ["Insertion loss", "Datasheet + 0.1 dB per connector + 0.5 dB", "Radiating cable: sweep from both ends on runs over 400 ft."],
    ["Splitters", "2-way 3.6, 3-way 5.2, 4-way 6.5 dB", "Couplers: through 0.4 to 1.8 dB. Tap 6, 10, 15, 20 dB."],
  ] },
  { h: "Connector torque (PIM research)", rows: [
    ["4.3-10", "5 N·m", "Hex 22 mm. 5 to 8 N·m in ANDREW's jumper bulletin 7617394 Rev H (2025)."],
    ["7-16 DIN", "25 to 30 N·m", "Over 25 N·m (Rosenberger). 20 ft-lb, about 27 N·m, elsewhere. 25 to 30 N·m ANDREW 7617394 Rev H."],
    ["N", "0.7 to 1.4 N·m", "0.7 to 1.1 N·m Rosenberger. 1.4 N·m or 12 in-lb common (Anritsu). 1.7 to 2.3 N·m ANDREW 7617394 Rev H."],
    ["NEX10", "1.5 N·m, or 4 to 5 N·m", "1.5 N·m from the connector makers (Rosenberger, SPINNER, CommScope's TW-N10 wrench). 4 to 5 N·m in ANDREW 7617394 Rev H (2025). They disagree: use the maker of the connector on your cable and write the value in the job book."],
    ["SMA", "0.57 N·m brass, 0.9 N·m stainless", ""],
  ] },
  { h: "Power and paperwork", rows: [
    ["Battery", "12 hours", "24 hours OCSD, LA County, McKinney, Santa Clara, FDNY. 2 hours plus generator allowed by NFPA and IFC 2024."],
    ["Low battery signal", "70% used", "NFPA 18.14."],
    ["Calibration", "12 months", "Or the certificate's own expiry."],
    ["Annual test", "12 months", "From the accepted date or last annual. Due soon from 60 days."],
    ["Report filing", "OCSD 30 days, Seattle 7 days", "Charleston 30 days. OCSD annual from a test in the last 13 months."],
    ["UL 2524", "3rd edition", "Older listings not updated by 2026-03-22 are withdrawn."],
  ] },
];
FI.instruments = [["PCTEL IBflex + SeeHawk", "±1 dB, P25 SINR ±1 dB", "Calibrated. Douglas County's named tool."], ["Anritsu S412E", "±1.25 dB (±0.5 typical)", "Measures BER, not SINR."], ["Epiq PRiSM", "±2 dB at 25 °C", "With iBwave Mobile Survey."], ["Nextivity COMPASS XR", "±2 dB", "Certificate covers LMR 700 and 800 only."], ["SDR or phone", "Not calibrated", "Pre-survey only. Never scored."]];
FI.people = [["Owner", "Pays, gives access and plans, signs."], ["AHJ or fire marshal", "Reviews, permits, witnesses or runs acceptance, owns the retest rules."], ["Licensee (radio shop)", "Assigns channels and donor sites, authorises retransmission, watches site noise, allows the noise test."], ["Carriers", "Express consent, design review, signal source, acceptance procedure."], ["FirstNet Authority", "Band 14 retransmission authorization."], ["GC, electrical sub, fire alarm contractor", "Pathways, power, firestop, panel tie-in."], ["Our technician or third-party tester", "FCC GROL, training, NICET where asked, independence where asked."]];
FI.gaps = [
  ["Fiber and remote units", "No optical power, OTDR or remote alarm numbers."],
  ["Simulcast delay", "A few AHJ limits, and no way to measure it."],
  ["Donor too hot", "No overdrive limit, and RF Recon has no check."],
  ["Carrier acceptance", "No US carrier publishes in-building numbers, PIM limits or uplink noise limits."],
  ["VHF PIM", "No published test practice or field analyzer. P.1238 has no VHF indoor values."],
  ["Elevators and metal deck", "No measured loss values."],
  ["Turnaround", "No published times from licensees or carriers. Only vendor and press claims."],
  ["Exterior leakage", "AHJ-specific, and RF Recon doesn't grade it."],
  ["Fire panel fault finding", "No source covers panel wiring or supervisory troubleshooting."],
  ["Local adoption", "No reliable national list of fire code editions or amendments exists. Trackers disagree. The AHJ's word is the only proof."],
  ["Primary standards", "NFPA 1225 and TSB-88 are paywalled. Every code number here is second-hand, from a named document."],
];
FI.glossary = {
  AHJ: "Authority Having Jurisdiction: usually the fire marshal. Their word is final.",
  ATP: "Acceptance test procedure: the carrier's own test.",
  BDA: "Bi-directional amplifier: the booster.",
  BER: "Bit error rate: how many digital bits arrive wrong.",
  DAS: "Distributed antenna system: antennas through a building fed from one source.",
  DAQ: "Delivered audio quality: a 1 to 5 score for how a radio call sounds.",
  DTF: "Distance-to-fault: a sweep that shows how far down the cable a problem is.",
  DTP: "Distance-to-PIM: shows how far down the line PIM comes from.",
  EIRP: "Effective isotropic radiated power.",
  ERCES: "Emergency responder communication enhancement system: coverage for fire and police radios inside a building.",
  ERP: "Effective radiated power: what actually leaves the antenna.",
  ESMR: "Enhanced specialized mobile radio: a cellular band next to public safety, kept out of the booster.",
  FACU: "Fire alarm control unit: the fire panel.",
  GROL: "FCC General Radiotelephone Operator License.",
  LMR: "Land mobile radio: two-way radio systems.",
  NICET: "A US technician certification.",
  NOC: "Network operations centre: the carrier's control room.",
  OTDR: "Optical time-domain reflectometer: finds faults in fiber.",
  P25: "The digital standard most public safety radios use.",
  PIM: "Passive intermodulation: unwanted signals made by bad connections when two strong signals meet.",
  RBW: "Resolution bandwidth: a spectrum analyzer setting.",
  RSRP: "Reference signal received power: LTE and 5G signal level.",
  SDR: "Software-defined radio: cheap, flexible, not calibrated.",
  SINR: "Signal to interference plus noise ratio: how clean the signal is.",
  TDI: "Time delay interference: two sites heard slightly out of step.",
  VSWR: "A way of stating return loss.",
};

window.DAS_FI = FI;
})();
