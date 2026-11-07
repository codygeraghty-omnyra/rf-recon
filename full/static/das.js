"use strict";
/* RF Recon — DAS jobs: in-building public safety radio (ERCES / ERRCS / BDA / public safety DAS) from lead to annual
   retest. A board of jobs by stage, each job with its building, contacts and compliance dates, a pre-survey from the
   FCC data (agency systems, downlink and uplink channels, donor sites, levels inside), the code requirements, a grid
   test per floor (over the floor plan when there is one), files, a log and a report for the AHJ. Any tool's results
   come in as CSV, TSV, Excel, JSON, KML/KMZ or GPX; everything goes out as CSV, JSON, KML, vCard, ATAK or print. */

/* ---------- the numbers (set in one place; see DAS_SOURCES for where each comes from) ---------- */
const DAS = {
  threshold: -95,            // dBm, minimum signal at each test location (IFC 510 / NFPA 1225 default; AHJs may change it)
  daq: 3.0,                  // delivered audio quality, minimum, downlink and uplink (NFPA 1225 ch. 18)
  sinr: 18, ber: 2.5,        // measured equivalent of DAQ 3.0 for P25: SINR >= 18 dB with BER <= 2.5% (NFPA 1225 A.20.3.10)
  general_pct: 95,           // % of general building areas that must pass (NFPA 1225 ch. 18; older NFPA 72 used 90)
  critical_pct: 99,          // % of critical areas that must pass
  grids: 20,                 // grid squares per floor (NFPA 1225 ch. 18)
  cell_ft: [20, 80],         // each grid square 20-80 ft across; floors over 128,000 sq ft are split into sectors
  sector_sqft: 128000,
  battery_h: 12,             // standby hours at 100% capacity (NFPA 1225 / IFC; some AHJs 24)
  cal_months: 12,            // a test instrument's calibration counts for 12 months from its date (the usual annual cycle; check the AHJ)
  // how a floor's grid is judged: "ifc" = IFC 510.5.4's failed-area rule (2021 and 2024 word it the same: 20 areas, more
  // than 1 failed fails; with exactly 2 failed, 40 areas and no more than 2 non-adjacent failures); "pct" = the
  // percentages alone (NFPA-only AHJs). The job's AHJ profile sets it (DAS_PROFILES)
  grid_rule: "ifc",
  // NFPA 1225-2022 18.8.3 lists elevators apart from elevator lobbies; New York's 2025 code adds fire protection equipment
  // rooms (R2 C-1). A job's saved ticks are names from this list: append, never rename
  critical_areas: ["Fire command center", "Fire pump room", "Exit stairs", "Exit passageways", "Elevators (cars)", "Elevator lobbies",
    "Standpipe cabinets", "Sprinkler sectional valve locations", "Fire protection equipment rooms (NY)", "Other areas the AHJ designates"],
  // building entry loss, ITU-R P.2109-2 at 770-850 MHz, outer wall only (VHF is close: 14/26 and 37/55 dB); the 70 and 90 dB
  // rows are whole-building excess losses measured at 750 MHz in large buildings (NIST TN 1552, 2009: medians 25-98 dB;
  // the 70 / 90 picks are the research's judgement, R2 C-5). A job keeps its construction by this name: never rename one
  loss: {"Traditional build, typical (14 dB)": 14, "Traditional build, worst 5% (28 dB)": 28,
    "Thermally efficient (low-E glass, foil insulation), typical (31 dB)": 31, "Thermally efficient, worst 5% (51 dB)": 51,
    "Deep interior or below grade (50 dB)": 50,
    "Large building, deep interior (NIST TN 1552 medians, 750 MHz: 25-98 dB; use 70 dB)": 70,
    "Subterranean / garage below grade (NIST TN 1552 upper medians: 90 dB)": 90},
  // what a preset rests on, where its name says more than its source (FINDINGS 12): shown with the choice
  lossNote: {"Subterranean / garage below grade (NIST TN 1552 upper medians: 90 dB)": "90 dB is a judgement, not a measurement: NIST TN 1552 measured buildings above ground, not tunnels or garages. Measure it, or ask the AHJ.",
    "Large building, deep interior (NIST TN 1552 medians, 750 MHz: 25-98 dB; use 70 dB)": "70 dB is the research's pick inside NIST's 25 to 98 dB medians, measured at 750 MHz."},
};
// the app's bands (uls_import.BANDS), so uplinks count in their own band; 700 MHz holds 799-805 up, 800 MHz 806-824 up
const DAS_BANDS = [[0,30,"HF"],[30,50,"VHF Low"],[50,54,"6m"],[54,72,"VHF TV low"],[72,76,"72-76 MHz"],[76,108,"FM broadcast"],[108,137,"Aviation VHF"],
  [137,174,"VHF High"],[174,216,"VHF TV/Aux"],[216,225,"220 MHz"],[225,400,"Gov UHF/Other"],[400,470,"UHF"],[470,512,"UHF T-Band"],[512,698,"UHF TV/Aux"],
  [698,806,"700 MHz"],[806,896,"800 MHz"],[896,960,"900 MHz"],[960,1e9,"Above 960 MHz"]];
const dasBand = f => (DAS_BANDS.find(([lo,hi])=>f>=lo&&f<hi)||[0,0,"Other"])[2];
// where the numbers come from (the full research, with every source, is the DAS research database in Drive)
const DAS_SOURCES = `Sources: <a href="https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download" target="_blank" rel="noopener">NFPA 1225-2022 ch. 18</a>,
  <a href="https://www.oswegofire.com/wp-content/uploads/2025/11/2021_ifc_510-Comm-Coverage.pdf" target="_blank" rel="noopener">IFC 2021 §510</a>,
  <a href="https://www.law.cornell.edu/cfr/text/47/90.219" target="_blank" rel="noopener">47 CFR 90.219</a>,
  <a href="https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features" target="_blank" rel="noopener">IFC 2024 §510</a> (UpCodes GSA copy),
  <a href="https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2109-2-202308-I!!PDF-E.pdf" target="_blank" rel="noopener">ITU-R P.2109-2</a> (entry loss),
  <a href="https://www.nist.gov/system/files/documents/itl/antd/TN1552.pdf" target="_blank" rel="noopener">NIST TN 1552</a> (large-building loss, 750 MHz),
  <a href="https://sbc.memberclicks.net/assets/Useful_Links/2025/ocsd-errcs-deployment-guidelines-deployment-rev4-5.pdf" target="_blank" rel="noopener">OCSD ERRCS guidelines</a>,
  <a href="https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf" target="_blank" rel="noopener">San Diego FD C-1</a>.
  All of it, with every source: the <a href="https://drive.google.com/drive/folders/1QRpqPV35gINsrQVGQAxbT4ik-ibcsfxu" target="_blank" rel="noopener">DAS research database</a>
  (<span class="mono">RF Recon\\docs\\research\\DAS-ERCES\\das_research.db</span> in Drive, with a CSV per table).`;
// a job's AHJ profile: the defaults above, with what this AHJ changes (presets below, editable under Requirements)
let DASJ = DAS;
// The presets (R2, 2026-11-04 DAS deep research, section 1.3 and C-2/C-3). A job stores the numbers it uses (and, since
// 11/4, the preset's name and grid rule), never only a preset name, so renaming one leaves saved jobs as they were;
// DAS_PROFILE_ALIASES maps an old name to its new one. "checked" says how the research read the source: "read" = the
// primary text; "search excerpt" = a search-result summary, not opened, so confirm with the AHJ before relying on it.
// Numbers a source doesn't state are left out and come from the IFC defaults above (the note says which).
const DAS_PROFILES = {
  "IFC 2021 (refs NFPA 1221): −95 dBm + DAQ 3.0": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc",
    note: "IFC 2021 references NFPA 1221; the 2024 edition is the first to reference NFPA 1225.",
    source: "https://engineeredfiresystems.com/resources/international-fire-code-2021-vs-2024/", checked: "read"},
  "IFC 2024 / NFPA 1225 (DAQ only)": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc",
    note: "IFC 2024 510.4.1.1/.2: DAQ 3.0 (or the BER/SINR equivalent) both ways, no dBm figure.",
    source: "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features", checked: "read"},
  "Strict (DAQ 3.4, 24 h, as OCSD)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 99, battery_h: 24, grid_rule: "ifc",
    source: "https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf", checked: "read"},
  "Older NFPA 72 (90% general)": {threshold: -95, daq: 3.0, general_pct: 90, critical_pct: 99, battery_h: 12, grid_rule: "pct", checked: "search excerpt",
    note: "NFPA 72-2010/2013 24.5.2: −95 dBm both ways, 99% critical, 90% general. Judged by percentage: the IFC failed-area rule isn't part of these texts. A draft of the chapter with proposal marks was read on 11/5, not the published text."},
  "Florida FFPC 9th ed. (from 12/31/2026)": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "pct",
    note: "NFPA 1-2024 FL 11.10.2: signal per NFPA 1225 (judged by percentage). 11.10.2.1: no ERCES required where exterior coverage is below DAQ 3.4. Locals may not be stricter (F.S. 633.202(18)(i)). Coverage assessments at most every 3 years (high-rise or over 12,000 sq ft) or 5 years (others).",
    source: "https://myfloridacfo.com/docs-sf/state-fire-marshal-libraries/sfm-documents/bfp/florida-fire-prevention-code/florida-fire-prevention-code-9th-edition-nfpa1-fl-specific-edits-6-15-2026.pdf", checked: "read"},
  "Sacramento Metro Fire (Ord. 2025-02)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc", third_party: true,
    note: "2025 CFC (IFC 2024 base) amended: −95 dBm and DAQ 3.4 inbound, DAQ 3.4 uplink. Coverage % and battery: the IFC defaults. FPS 32: a third-party report for final approval.",
    source: "https://metrofire.ca.gov/files/fca1dc973/CERTIFIED+ORD+2025-02+2025+CALIFORNIA+FIRE+CODE,+TITLE+24,+CODE+OF+REGULATIONS,+PART+9.pdf", checked: "read"},
  "McKinney TX": {threshold: -95, daq: 3.4, general_pct: 90, critical_pct: 99, battery_h: 24, isolation_margin_db: 15, grid_rule: "pct",
    note: "−95 dBm, 99% critical, 90% general, DAQ 3.4 on the same model of radio McKinney Fire uses, 24 h battery in NEMA 4/4X, isolation 15 dB over gain. Judged by percentage. An annual test, with a report to the Fire Marshal.",
    source: "https://www.mckinneytexas.org/DocumentCenter/View/17102/Radio-BDA-Coverage-Systems", checked: "read"},
  "Prosper TX (rev 05-24)": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 100, battery_h: 12, class_a_only: true, p25_phase2: true, isolation_margin_db: 20, grid_rule: "ifc", no_40_area: true,
    note: "−95 dBm both ways, 95% general, 100% critical, 12 h, Class A only, P25 Phase 1 and 2. 20 or more areas of at most 2,500 sq ft; at most 1 general point may fail per floor, no 40-area retest. The spec prints no DAQ figure: 3.0 is the default.",
    source: "https://prospertx.gov/DocumentCenter/View/3296/AHJ-Specification-for-ERRC-Systems-PDF", checked: "read"},
  "Chandler AZ": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, class_a_only: true, p25_phase2: true, grid_rule: "ifc",
    note: "IFC 2024 with City Code 28-17: no dBm pass level in the code or the packet. Downlink DAQ 3.0 (IFC 510.4.1.1); uplink per RWC, whose policy wasn't found. Class A for new installs, 700 MHz Phase I and II. Applies over 3 stories, 45,000 sq ft on a floor, or 250 sq ft below ground; wood-frame only and under 35 ft with no metal are exempt.",
    source: "https://www.chandleraz.gov/sites/default/files/UDMDevServ/UDM_Chandler_ERCC_Information_Packet.pdf", checked: "read"},
  "NYC FDNY ARCS (3 RCNY 510-01)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 100, battery_h: 24, grid_rule: "pct", packet: "fdny",
    note: "New York City's own system (FDNY Auxiliary Radio Communication System), required in high-rises, underground and buildings over 250,000 sq ft. BC App. Q 24.9: −95 dBm and DAQ 3.4 both ways (outbound at the donor site), 100% critical, 95% general, battery 24 h supervisory then 6 h full load. Grid at most 5% of the testable floor and 1,600 sq ft; no failed grid on consecutive floors. Daily console check, annual certification, 5-year recertification; an FDNY-approved company, a tester with a B-03 certificate and an FCC GROL. Codified rule read 11/5: last amended City Record 9/20/2023, eff. 10/20/2023.",
    source: "https://rules.cityofnewyork.us/wp-content/uploads/2023/04/Notice-of-Adoption-FDNY-Miscellaneous-Rule-Amendments-City-Record.pdf", checked: "read"},
  // 11/4 (lane A): sixteen AHJ policies, each opened and read in full on 2026-11-04. `cite` gives the section for every
  // number, and says "not stated in …" where the policy gives none (the RF Recon default then applies and says so).
  // sinr_db / ber_pct: the AHJ's own measured equivalent of DAQ; ul_required: an uplink reading in every square;
  // either: a square passes on its level OR its BER (Denver); adjacent_fail: 2 adjacent failed squares fail the floor
  "San Diego Fire-Rescue C-1 (rev 01/22/2026)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc", sinr_db: 20, ber_pct: 2, ul_required: true,
    class_a_only: true, isolation_margin_db: 20, third_party: true, packet: "san_diego",
    cite: {threshold: "C-1 §IV.A, p.2: −95 dBm throughout the coverage area", daq: "C-1 §IV.A–B, pp.2-3: DAQ 3.4 inbound and outbound", sinr_db: "C-1 §IV.A.1, p.2: SNR or SINR 20 dB or greater", ber_pct: "C-1 §IV.A.1, p.2: BER no greater than 2%",
      ul_required: "C-1 §V.B, p.3: DAQ, both UL and DL, measured for each grid", general_pct: "C-1 §IV, p.2", critical_pct: "C-1 §IV, p.2", battery_h: "C-1 §VI.C.2, p.5: 12 h, or 2 h battery plus generator", grid_rule: "C-1 §V.B, p.3: 20-grid format per CFC 510.5.4", third_party: "C-1 §VIII.C-D, p.12"},
    note: "Third-party acceptance test; testers hold an FCC GROL and NICET IB-PSC Level II; Class A boosters only; leakage at least 15 dB below the donor; uplink gain 65 dB at most; the stamped report goes to The Compliance Engine.",
    source: "https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf", checked: "read"},
  "LA County Fire V7-C3-S21 (02/02/2023)": {threshold: -95, daq: 3.4, general_pct: 95, critical_pct: 100, battery_h: 24, grid_rule: "ifc", sinr_db: 20, ber_pct: 2, class_a_only: true, isolation_margin_db: 20, packet: "la_county",
    cite: {threshold: "V7-C3-S21 §IV.B.2, p.4: −95 dBm uplink and downlink", daq: "§IV.B.2, p.4: DAQ 3.4", sinr_db: "§IV.D.1.e, p.17: SNR or SINR 20 dB or greater", ber_pct: "§IV.D.1.e, p.17: BER no greater than 2%",
      ul_required: "not stated in V7-C3-S21: a hip-worn radio confirms DAQ 3.4 in each grid area (§IV.D.1.d, p.17) without saying uplink or downlink", general_pct: "§IV.A.2, p.3", critical_pct: "§IV.B.2.a, p.4: 100% of critical areas", battery_h: "§IV.B.19.c, p.9: 24 h, or generator with 24 h of fuel plus 2 h battery",
      grid_rule: "§IV.C.14.b, p.15: 20 grid areas per floor; no failure count stated, so the IFC 510.5.4 rule applies"},
    note: "The fire code official runs the acceptance test (§IV.D.1.a). Exterior downlink at least 20 dB below the donor; uplink gain 65 dB at most; noise −150 dBm at the donor site.",
    source: "https://sbc.memberclicks.net/assets/Useful_Links/2023/v7-c3-s21.pdf", checked: "read"},
  "Clark County / Las Vegas FPAN (12/18/2025)": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc", ul_required: true, class_a_only: true, packet: "clark",
    cite: {threshold: "FPAN §7.0 Initial Acceptance item 7, p.10: −95 dBm sending and receiving", daq: "§7.0 item 7, p.10: DAQ 3.0 or greater", sinr_db: "not stated in the FPAN guide", ber_pct: "not stated in the FPAN guide",
      ul_required: "§7.0 Zone Testing item 8, p.11: two-way communications from the centre of each test area", general_pct: "§7.0 item 7, p.10", critical_pct: "§7.0 item 8, p.10", battery_h: "§6.0 5.b.i.14, p.9: 12 h, or 4 h with an emergency generator",
      grid_rule: "§7.0 Zone Testing items 6-7, p.11: more than 1 failed area fails; 2 failed allow a 40-area retest"},
    note: "Class B boosters prohibited; signed rebroadcasting and maintenance agreements; letter of completion with every channel's gain, filter bandwidth and AGC setting; five-year retest within 5% of the initial coverage.",
    source: "https://files.lasvegasnevada.gov/fire-rescue/2025/FPAN-Guide_for_ERCES_Permitting_Testing_Recertification-Dec-2025.pdf", checked: "read"},
  "Seattle SFC 510 (2021) + CAM 5123": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc", fail40: 4, ul_required: true, packet: "seattle",
    cite: {threshold: "2021 SFC 510.4.1.1: −95 dBm, DAQ 3.0; 510.4.1.2: outbound DAQ 3.0, no dBm", daq: "2021 SFC 510.4.1.1, 510.4.1.2: DAQ 3.0 both ways; design to NFPA 1225-2022", sinr_db: "not stated in SFC 510 or CAM 5123", ber_pct: "not stated in SFC 510 or CAM 5123",
      ul_required: "2021 SFC 510.5.4(4): talk-back recorded for each grid square on each floor", general_pct: "2021 SFC 510.4.1: 95%; 510.5.4(5): more than 5% of areas failed fails the floor", critical_pct: "2021 SFC 510.4.1: 99%",
      battery_h: "2021 SFC 510.4.2.3: 12 h, or 2 h battery plus generator", grid_rule: "2021 SFC 510.5.4(2), (5), (6): 20 areas of at most 6,400 sq ft; where 10% fail, 40 areas with no more than 10% (4 of 40) non-adjacent failures"},
    note: "Test areas at most 6,400 sq ft each. Results go into The Compliance Engine 24 h before the SFD inspection; annual reports within 7 days. PSERN validates the uplink before activation.",
    source: "https://www.seattle.gov/documents/Departments/SDCI/Codes/SeattleFireCode/2021SFCChapter5.pdf", checked: "read"},
  "Colorado Springs FD (6/30/2023)": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "pct", packet: "colorado_springs",
    cite: {threshold: "II.C.1, p.4: −95 dBm inbound throughout the coverage area", daq: "II.C.2, p.4: outbound DAQ 3.0 (no inbound DAQ stated)", sinr_db: "not stated in the CSFD requirements", ber_pct: "not stated in the CSFD requirements",
      ul_required: "not stated in the CSFD requirements", general_pct: "II.C.3, p.4", critical_pct: "II.C.4, p.4", battery_h: "II.D.3, p.5: 12 h, two independent power sources", grid_rule: "IV, p.7: tested to NFPA 1225; no grid count or failure rule stated, so percentages judge"},
    note: "Battery table per device (standby and alarm current, times, totals, battery size, series / parallel); designer's signature, date and certification number on plans and cut sheets; PPRCN caps BDA output at −75 dBm at the donor site.",
    source: "https://coloradosprings.gov/system/files/2023-07/2021_ifc_erces_2023_final.pdf", checked: "read"},
  "Miami-Dade Fire Rescue (rev 05-2024)": {threshold: -95, daq: 3.0, general_pct: 90, critical_pct: 99, battery_h: 12, grid_rule: "pct", ul_required: false, class_a_only: true, packet: "miami_dade",
    cite: {threshold: "General Guidelines p.5: −95 dBm downlink throughout", daq: "p.5 and guide sheet items 45-46: DAQ 3.0 in and out", sinr_db: "not stated in the MDFR guidelines", ber_pct: "not stated in the MDFR guidelines",
      ul_required: "General Guidelines p.11: 'DO NOT TEST OR CONNECT UPLINK OF SYSTEM': contractors submit downlink grid maps only", general_pct: "p.5: 90% of floor area", critical_pct: "pp.5-6: 99%", battery_h: "guide sheet item 36, p.2: 12 h",
      grid_rule: "p.10: grid size from the size of the structure; no failure count, so percentages judge"},
    note: "Each test point is the average of max-hold and min-hold RSSI over at least 30 s; separate grids for 450 and 800 MHz; MDFR inspectors check DAQ by voice; Florida PE seal over $5,000.",
    source: "https://www.miamidade.gov/fire/library/general-guidelines.pdf", checked: "read"},
  "Osceola County FL (06/2024)": {daq: 3.0, general_pct: 90, critical_pct: 99, battery_h: 12, grid_rule: "pct", packet: "osceola",
    cite: {threshold: "p.16 says −105 dBm inbound and outbound 'at the donor site', not throughout the building: the −95 dBm default shows; confirm with the Fire Marshal", daq: "p.16: DAQ 3.0 inbound and outbound", sinr_db: "not stated in the Osceola ERCES document (SINR and BER named as formats, no values, p.7)",
      ber_pct: "not stated in the Osceola ERCES document", ul_required: "not stated in the Osceola ERCES document", general_pct: "p.15: 90% floor area", critical_pct: "p.15: 99% floor area", battery_h: "p.17: 12 h, or generator plus 2 h battery",
      grid_rule: "p.8: 20 areas per floor; no failure count, so percentages judge"},
    note: "The integrator demonstrates DAQ without the county network (no loaner radios); authorization before any walk test (radioservices@osceola.org).",
    source: "https://www.osceola.org/files/assets/county/v/1/services/fire-rescue-and-ems/documents/fire-permits-and-guidelines/2024-06-13_erces-current.pdf", checked: "read"},
  "Santa Clara County FD C-2 (rev 09/01/2020)": {threshold: null, daq: 3.4, general_pct: 90, critical_pct: 99, battery_h: 24, grid_rule: "pct", ul_required: true, class_a_only: true, third_party: true, packet: "santa_clara",
    cite: {threshold: "C-2 V.A, p.7: no downlink dBm (DAQ decides); uplink at the donor site receive antenna is a maximum of −95 dBm (V.A.2)", daq: "V.A.1, p.7: DAQ 3.4 digital (3.0 analog)", sinr_db: "not stated in C-2", ber_pct: "not stated in C-2",
      ul_required: "VIII.A.6, p.12: two-way talk-back from the centre of each test area", general_pct: "V.A, VIII.A.7, p.12: 90% of test locations", critical_pct: "V.A Exception, p.7", battery_h: "V.F.3, p.9: 24 h UPS",
      grid_rule: "VIII.A.3, p.12: 3 failed areas of 20 allow a 40-area retest; 90% passes, so percentages judge", third_party: "VIII.A.11, p.13: results validated by an independent third party"},
    note: "Testers hold an FCC GROL and in-building training; loaner radios from the County Radio Shop; UPS with an EPO switch.",
    source: "https://www.sccfd.org/wp-content/uploads/2024/10/C-2-Emergency-Respodner-Radio-Coverage-Systems.pdf", checked: "read"},
  "Murray City UT": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, grid_rule: "pct", sinr_db: 18, ber_pct: 2.5, class_a_only: true, packet: "murray",
    cite: {threshold: "1. Initial Testing, p.1: RSSI −95 dBm or greater over 95%", daq: "p.1-2: DAQ 3.0", sinr_db: "1. Initial Testing, p.1: SINR 18.0 dB or greater", ber_pct: "1. Initial Testing, p.1: BER 2.5% or less", ul_required: "not stated in the Murray ERCS sheet",
      general_pct: "5. Acceptance Testing, p.2", critical_pct: "5. Acceptance Testing, p.2", battery_h: "not stated in the Murray ERCS sheet ('longer battery back up', no hours)", grid_rule: "5., p.2: at least 20 areas plus every critical area; no failure rule, so percentages judge"},
    note: "Annual 1-hour battery load test, replace under 70%; the Fire Marshal's Office checks every critical area by radio; register in the Liv compliance engine.",
    source: "https://murray.utah.gov/DocumentCenter/View/16609", checked: "read"},
  "Charlotte / Mecklenburg ERCCS (rev 09/04/2025)": {threshold: -95, daq: 3.0, critical_pct: 99, grid_rule: "ifc", ul_required: true, packet: "charlotte",
    cite: {threshold: "Signal Strength Survey, p.3: downlink −95 dBm and DAQ 3.0", daq: "p.3: uplink and downlink DAQ 3.0, by Harvard sentences", sinr_db: "not stated in the ERCCS guide", ber_pct: "not stated in the ERCCS guide",
      ul_required: "Signal Strength Survey, p.3: 'Uplink signals must pass 3.0 DAQ' in the 20-grid survey (the guide doesn't word it per square)", general_pct: "not stated in the ERCCS guide", critical_pct: "p.3 and p.8: 99% floor area",
      battery_h: "not stated in the ERCCS guide", grid_rule: "p.3: the 20-grid method of the 2018 NC Fire Prevention Code 510.5.4"},
    note: "DAQ by Harvard sentences; readings averaged over several seconds, never instantaneous; the analyzer calibrated within 12 months with its certificate in the packet; surveyor holds an FCC GROL.",
    source: "https://www.charlottenc.gov/files/sharedassets/city/v/1/public-safety/documents/public-safety-erccs-document.pdf", checked: "read"},
  "Denver Fire Code 2025 + Policy 510-1 (02/01/2018)": {threshold: -100, daq: 3.4, general_pct: 95, critical_pct: 99, grid_rule: "pct", ber_pct: 2.4, either: true, packet: "denver",
    cite: {threshold: "Acceptance Test Procedure A, p.3: control channel above −100 dBm, or BER 2.4% or less (either passes)", daq: "Audio Quality, p.7: DAQ 3.4, judged by the DFD Fire Code Official", sinr_db: "not stated in Policy 510-1",
      ber_pct: "Acceptance Test Procedure A, p.3: control channel BER 2.4% or less", ul_required: "not stated in Policy 510-1", general_pct: "RF Maintenance Plan, p.5: 95% service area reliability", critical_pct: "2025 Denver Fire Code 510.4.1.3: 99% floor area at −100 dBm or stronger (Policy 510-1 p.5 still says 100%)",
      battery_h: "not stated in Policy 510-1 (the annual test runs the UPS 4 h)", grid_rule: "Acceptance Test Procedure A, p.3: a uniform grid of 20 x 20 ft squares, so percentages judge"},
    note: "The 2025 code samples one per 40 x 40 ft; Policy 510-1 says 20 x 20 ft: confirm with DFD. Measured at each centre. Denver Fire Department licence for anyone installing, testing or designing.",
    source: "https://www.denvergov.org/content/dam/denvergov/Portals/678/documents/FPB/policydocuments/DFD%20(RES-BDA)%20Radio%20Sys%20Policy%20510-1.pdf", checked: "read"},
  "Riverside County Fire OFM-13 (11/2023)": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, battery_h: 12, grid_rule: "ifc", ul_required: true, isolation_margin_db: 20, packet: "riverside",
    cite: {threshold: "Technical Requirements, p.3: −95 dBm inbound", daq: "p.3: DAQ 3.0 inbound and outbound", sinr_db: "not stated in OFM-13 ('an equivalent SINR applicable to the technology', no figure)", ber_pct: "not stated in OFM-13",
      ul_required: "Acceptance Test Procedure item 5, p.5: two-way communications at the centre of each test area", general_pct: "p.3", critical_pct: "p.3", battery_h: "p.3: 12 h, or 2 h battery plus generator",
      grid_rule: "Acceptance Test Procedure items 1-5, pp.4-5: more than 1 failed area fails; 2 failed allow 40 areas"},
    note: "Test by an FCC-licensed technician witnessed by RVC-OFM; calibrated portable radios on the hip; two-radio test; all 8 supervisory signals verified.",
    source: "https://www.rvcfire.org/pdf/fire-marshal/guideline-ofm/ERCCS%20Guideline%20OFM-13%20RVC%20FINAL%2012-26-2023.pdf", checked: "read"},
  "Durham NC BDA permit (Doc. 47330)": {threshold: -95, daq: 3.0, general_pct: 100, grid_rule: "pct", sinr_db: 17.7, ber_pct: 2, ul_required: false, class_a_only: true, packet: "durham",
    cite: {threshold: "Appendix #4 item 3.g.i, p.9: −95 dBm downlink at every grid location", daq: "item 3.g.i.2, p.9: DAQ 3.0", sinr_db: "item 3, p.1 and 3.g.i.4, p.9: SINR 17.7 dB or greater", ber_pct: "item 3.g.i.3, p.9: BER 2.0% or less",
      ul_required: "item 3.g.i.5, p.9: uplink is a calculated power at the donor tower (−80 to −95 dBm), not a reading in each square", general_pct: "item 3.g.i, p.9: all 20 grid locations must comply", critical_pct: "not stated in the Durham requirements",
      battery_h: "not stated in the Durham requirements", grid_rule: "item 3.g, p.9: every location must comply, so percentages judge at 100%"},
    note: "Commissioning by a GROL holder with NICET Level III and BDA maker certification, with a calibrated PCTEL SeeHawk or equivalent; a current calibration certificate and operator certificate in the packet; plan review by errcsplancheck.com. The initial survey passes at −100 dBm (item 3, p.1); the acceptance grid is −95 dBm (item 3.g.i, p.9).",
    source: "https://durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-?bidId=", checked: "read"},
  "College Station TX": {threshold: -95, daq: 3.0, general_pct: 95, critical_pct: 99, grid_rule: "pct", adjacent_fail: true, ul_required: true, packet: "college_station",
    cite: {threshold: "Survey Requirements, p.1: −95 dBm at each test location, with a calibrated spectrum analyzer", daq: "DAQ, p.2: 3.0 in general and critical grids", sinr_db: "not stated in the College Station handout", ber_pct: "not stated in the College Station handout",
      ul_required: "When ERCES Is Required, p.1: −95 dBm into and out of the building", general_pct: "p.1", critical_pct: "p.1", battery_h: "not stated in the College Station handout ('the duration required by applicable codes')",
      grid_rule: "p.1: at least 20 grids; a test fails when 2 or more adjacent grids fail"},
    note: "DAQ with the same make and model radio the Fire Department uses; BVCOG (the licensee) coordinates turn-on and issues the retransmission letter. All new buildings 12,000 sq ft or larger are tested.",
    source: "https://www.cstx.gov/media/24ieu1tq/erces.pdf", checked: "read"},
  "Salt Lake City FD (02/2025)": {grid_rule: "ifc", class_a_only: true, packet: "slc",
    cite: {threshold: "not stated in the SLC policy", daq: "not stated in the SLC policy (an SLC radio technician inspects DAQ)", sinr_db: "not stated in the SLC policy", ber_pct: "not stated in the SLC policy", ul_required: "not stated in the SLC policy",
      general_pct: "not stated in the SLC policy", critical_pct: "not stated in the SLC policy", battery_h: "not stated in the SLC policy", grid_rule: "IFC 2021 510 adopted (Technical Requirements, p.5); the policy states no grid rule"},
    note: "Designs in iBwave 'or comparable'; a report with the floor plan overlaid with spectrum analyzer data (RSSI, SNR, BER) for every permit; cable sweeps; Class A only; UCA retransmit letter first. The policy gives both 'every two years' and 'annual' for recertification.",
    source: "https://fire.slc.gov/wp-content/uploads/2025/03/Salt-Lake-City-ERCES-Policy-March-2025.pdf", checked: "read"},
  "Douglas County CO (DCSORS Rev 2.0)": {threshold: null, daq: 3.0, general_pct: 95, critical_pct: 99, grid_rule: "ifc", sinr_db: 20, ber_pct: 2, class_a_only: true, packet: "douglas",
    tool_lock: "Acceptance and annual tests only by DCSORS or a PCTel-certified vendor with a calibrated IBflex, uploaded to SeeHawk Central (App. F p.21, App. G p.24): RF Recon's results alone won't be accepted.",
    cite: {threshold: "Step 1, p.5: no dBm pass level (SINR and FER decide; −50 to −95 dBm is design guidance only)", daq: "Step 1, p.5: the SINR / FER rule secures DAQ 3.0", sinr_db: "Step 1, p.5: SINR greater than 20 dB (strictly above; RF Recon passes 20.0)",
      ber_pct: "Step 1, p.5: FER less than 2.0% ((frame) bit error rate; enter it as BER)", ul_required: "not stated per square: uplink is a near / far test per floor at the donor site (App. F, p.22)", general_pct: "Step 1, p.5", critical_pct: "Step 1, p.5",
      battery_h: "not stated in the DCSORS guidelines", grid_rule: "Step 1, p.5: grid size per the fire code, 12 samples per grid; no failure rule stated, so the IFC rule applies"},
    note: "Class A only; FirstNet filtered out; uplink gain +65 dB at most; noise at the donor site −145 dBm / 10 kHz; the five-year grid runs with the BDA on and off.",
    source: "https://dcsheriff.net/documents/derces-implementation-guidelines.pdf/", checked: "read"},
};
// where a number comes from when the profile gives none: RF Recon's defaults, each with its basis
const DAS_DEFAULT_SRC = {threshold: "RF Recon default: IFC 2021 510.4.1.1, −95 dBm", daq: "RF Recon default: NFPA 1225 18.8 / IFC 510.4.1, DAQ 3.0",
  general_pct: "RF Recon default: NFPA 1225 18.8.4, 95%", critical_pct: "RF Recon default: NFPA 1225 18.8, 99%", battery_h: "RF Recon default: NFPA 1225 18.13.2 / IFC 510.4.2.3, 12 h",
  grid_rule: "RF Recon default: IFC 510.5.4", ul_required: "RF Recon default: off (uplink scored where it was read)"};
// the per-AHJ fields a preset carries into the job (DAS_PROFILE_NUMS stays as it was: it matches pre-11/4 jobs to presets)
const DAS_PROFILE_AHJ = ["sinr_db", "ber_pct", "ul_required", "either", "adjacent_fail", "third_party", "packet", "tool_lock", "cite"];
const DAS_PROFILE_ALIASES = {"IFC 2021 + NFPA 1225": "IFC 2021 (refs NFPA 1221): −95 dBm + DAQ 3.0", "Seattle SFC 510 (2018) + CAM 5123": "Seattle SFC 510 (2021) + CAM 5123", "Denver Policy 510-1 (02/01/2018)": "Denver Fire Code 2025 + Policy 510-1 (02/01/2018)"};  // the name until 11/4 (R2 C-2)
const DAS_PROFILE_NUMS = ["threshold", "daq", "general_pct", "critical_pct", "battery_h"];
// the preset a job's saved profile came from: by its name (or an old name), else the first whose numbers it has
// (a job saved before 11/4 has numbers only); null for a custom set
function dasPreset(p){
  if(!p) return null;
  const nm=DAS_PROFILE_ALIASES[p.name]||p.name;
  if(nm&&DAS_PROFILES[nm]) return [nm, DAS_PROFILES[nm]];
  return Object.entries(DAS_PROFILES).find(([,x])=>DAS_PROFILE_NUMS.every(k=>(x[k]===undefined?DAS[k]:x[k])===(p[k]===undefined?DAS[k]:p[k])))||null;
}
// a job's working numbers: the defaults, the preset's rule and notes (when the saved profile has none), then the saved profile
const dasProfile = p => { const pr=dasPreset(p); return {...DAS, ...(pr?{grid_rule:pr[1].grid_rule||DAS.grid_rule, profile_name:pr[0]}:{}), ...(p||{})}; };
// the licensees' own consent processes (R2 section 1.3, "Statutory licensee consent processes"): who, what they ask,
// how long it lasts, the source and how it was read. Shown under Requirements; terms feed the authorization dates
const DAS_LICENSEES = [
  {who: "Michigan MPSCS", what: "Policy 4.1.11: an e-form, then a letter of express consent; a Class B booster is then registered with the FCC and its Booster ID sent to MPSCS. Contact MPSCS-BDA@michigan.gov.", source: "https://www.michigan.gov/mpscs/inside/laws-policies-and-procedures/bi-directional-amplifiers", checked: "page read 11/5; policy 4.1.11 read 11/6, issued or revised April 29, 2014"},
  {who: "Ohio MARCS", what: "A BDA policy and a Retransmission Authorization form (DAS-MARCS.Admin@das.ohio.gov); P25 required; MARCS recommends Class B.", source: "https://dam.assets.ohio.gov/image/upload/siec.ohio.gov/State%20of%20Ohio%20MARCS%20BDA%20Policy%20rev%20073021_1.pdf", checked: "read"},
  {who: "California CRIS", what: "A letter to the CRIS engineer, then a Letter of Consent.", source: "https://www.caloes.ca.gov/wp-content/uploads/PSC/Documents/Policy-SignalBoostersBDAFeb2021.pdf", checked: "read"},
  {who: "Maryland MD FiRST", what: "A provisional letter valid 1 year; final approval after activation and a de-sense test.", term_months: 12, term: "provisional, 1 year", source: "https://doit.maryland.gov/About-DoIT/Offices/Office-of-Infrastructure/Pages/signal-booster-registration-requirements.aspx", checked: "read"},
  {who: "Broward County ORCAT (FL)", what: "ERCES Guidelines 2025-05-06: a physical internal or external FirstNet (Band 14) filter (external on both ports if the BDA can't do a 6 MHz passband, from 8/28/2026); 700 MHz boosters Class A; annual provisional retransmission authorization through The Compliance Engine from 11/1/2026; a notarized owner acknowledgement; an installation completion form.", term_months: 12, term: "annual", source: "https://bcresc.org/bda-info", checked: "read"},
  {who: "Douglas County (CO)", what: "Provisional authorization for 6 months, final for 5 years; Band 14 filtered out; the grid is run with the BDA on and again off.", term_months: 6, term: "provisional 6 months, final 5 years", final_months: 60, source: "https://dcsheriff.net/documents/derces-implementation-guidelines.pdf/", checked: "read"},
  {who: "Fairfax County (VA)", what: "The retransmission authorization is re-submitted every year.", term_months: 12, term: "annual", source: "https://www.fairfaxcounty.gov/fire-ems/sites/fire-ems/files/Assets/Documents/PDF/fire%20marshal/ERCES%20Submittal%20and%20Permit%20Requirements%20Guidelines.pdf", checked: "das_market.json fairfax_erces (read 2026-11-03)"},
  {who: "PSERN (King County, WA)", what: "PSERN is the licensee: owners or their designees sign its rebroadcast agreement, PSERN validates the uplink before activation (one week's notice) and tells Seattle FD.", source: "https://psern.org/das-requirements/", checked: "read"},
  {who: "FirstNet Band 14", what: "Licensed to the FirstNet Authority (FCC renewal May 2023; the Authority's statutory term ends 22 Feb 2027 unless Congress extends it); AT&T runs the network. Makers route the 'FirstNet Band 14 Retransmit Request Form' to FirstNetSpectrum.Manager@firstnet.gov; some resellers say AT&T. Get it in writing and keep it.", source: "https://www.everycrsreport.com/reports/R48923.html", checked: "read (the request address: search excerpt)"},
];
const DAS_CHECKS = [  // the dates a job is tracked by; a date means done
  ["consent", "Licensee / agency consent to retransmit (47 CFR 90.219(b)(1))"], ["fcc_reg", "FCC signal booster registration (Class B: 47 CFR 90.219(d)(5))"],
  ["permit", "AHJ permit"], ["design_ok", "Design approved"], ["monitoring", "Monitoring connected to the fire alarm panel"],
  ["accepted_on", "Acceptance test passed"], ["battery", "Battery test"]];
// A cellular job (lane H found it, 11/4): no public-safety channel plan, no public-safety reading, and a cellular target,
// carriers, donor readings or carrier approvals. It is judged per carrier, and the public-safety-only asks (Part 90
// consent and booster registration, the fire alarm panel link, UL 2524, IFC 510 wording) stay off it. A job with both
// technologies keeps both. Mirrored in das.py cell_only (the board's Needs you, the lifecycle)
const DAS_PS_ONLY_CHECKS = ["consent", "fcc_reg", "monitoring"];
function dasCellOnly(d){ const sc=dasScope(d||{}); return sc.cell&&!sc.ps; }  // one rule: dasScope
const dasChecksFor = cellOnly => cellOnly ? DAS_CHECKS.filter(([k])=>!DAS_PS_ONLY_CHECKS.includes(k)) : DAS_CHECKS;
// the cellular result: every required carrier and layer on every floor (dascell.js cellFloorVerdicts); null = not complete
function dasCellVerdict(d){ const floors=Array.isArray(d.floors)?d.floors:[];
  if(!window.cellLayers||!floors.length) return {ok:null, lines:[]};
  const L=cellLayers(d).filter(x=>x.required), lines=L.map(x=>{ const per=floors.map(f=>cellFloor(d, f, x.key)), tested=per.some(s=>s.tested);
    return {L:x, tested, ok:tested?per.filter(s=>s.tested).every(s=>s.ok):null}; });
  const ok=!lines.length||lines.some(x=>!x.tested)?(lines.some(x=>x.ok===false)?false:null):lines.every(x=>x.ok);
  return {ok, lines}; }
const DAS_ROLES = [["ahj", "AHJ / fire marshal"], ["owner", "Building owner"], ["agency", "Radio system owner"], ["gc", "General contractor"], ["sub", "Subcontractor"], ["tech", "Our technician"]];
// The acceptance tests beyond the grid (IFC 2021 510.5.4 items 6-8; NFPA 1225-2022 20.3.10.1.3 items 8-11; San Diego C-1
// App. D). One list for every file that reads or writes them (static/dasahj.js enters them; commissioning writes them).
// A job keeps them as data.acceptance = {tests: {<id>: {status: "pass"|"fail"|"not done", value, unit, note, at, by, src}}}.
// The ids are kept with jobs: append, never rename
const DAS_ACCEPT = [
  {id: "gain", label: "Amplifier gain, each channel or band", unit: "dB", cite: "IFC 2021 510.5.4(6); NFPA 1225 20.3.10.1.3"},
  {id: "filters_agc", label: "Filter bandwidths and AGC settings", unit: "", cite: "NFPA 1225 20.3.10.1.3; Clark County FPAN §7.0 item 10"},
  {id: "isolation", label: "Donor-to-server antenna isolation, measured", unit: "dB", cite: "NFPA 1225 18.10, 20.3.10.1.3; San Diego C-1 App. D §VI.G"},
  {id: "noise_floor", label: "Noise floor: ambient, active and quiescent", unit: "dBm", cite: "NFPA 1225 A.18.9.3; San Diego C-1 App. D §VI.D-F"},
  {id: "oscillation", label: "Spurious oscillation check (spectrum analyzer)", unit: "", cite: "IFC 2021 510.5.4(7)"},
  {id: "two_radio", label: "Two-radio test: one within 10 ft of an indoor antenna, one at the farthest point", unit: "", cite: "IFC 2021 510.5.4(8)"},
  {id: "battery_load", label: "Battery load test, 1 hour", unit: "h", cite: "IFC 2021 510.6.1(3); San Diego C-1 App. D §VI.B"},
  {id: "supervisory", label: "Supervisory signals to the fire alarm panel and annunciator", unit: "", cite: "NFPA 1225 18.14; IFC 2021 510.4.2.5"},
  {id: "epo", label: "Emergency power off (EPO)", unit: "", cite: "San Diego C-1 App. D §V"},
  {id: "leakage", label: "Exterior RF leakage below the donor signal", unit: "dB", cite: "San Diego C-1 §VI.H.4 (15 dB); LA County V7-C3-S21 §IV.B.7.c (20 dB)"},
  {id: "donor_level", label: "Donor signal level and source type", unit: "dBm", cite: "NFPA 1225 20.3.10.1.3"},
  {id: "bda_identity", label: "BDA / headend / BBU: model, serial, FCC ID, class", unit: "", cite: "San Diego C-1 App. D §IV; NFPA 1225 20.3.10.1.3"}];
const DAS_ACCEPT_STATUS = ["pass", "fail", "not done"];
window.DAS_ACCEPT = DAS_ACCEPT;

// the AHJ report prints on its own (the rest of the page is hidden while it prints)
document.head.insertAdjacentHTML("beforeend", `<style>@media print{body.print-das *{visibility:hidden}body.print-das #dasPrint,body.print-das #dasPrint *{visibility:visible}
  body.print-das #dasPrint{position:absolute;left:0;top:0;width:100%;background:#fff;color:#000;border:0;box-shadow:none}body.print-das #dasPrint .hint{color:#444}
  body.print-das #dasPrint td,body.print-das #dasPrint th{white-space:normal;overflow-wrap:anywhere}}</style>`);  /* tables wrap on paper: the app's td nowrap cut letters' uplink channels off the page (11/3) */
document.head.insertAdjacentHTML("beforeend", `<style>details.ps-more summary{cursor:pointer;width:max-content}.ps-hit{background:var(--warn);color:#000;border-radius:3px;padding:0 3px}
  tr.ps-tier td{padding-top:12px;white-space:normal}.das-pinwarn{margin:6px 0;padding:6px 10px;border-left:3px solid var(--warn);display:flex;gap:10px;align-items:center;flex-wrap:wrap}</style>`);
// a short line at the foot of the window for a DAS save that failed; it stays 8 s (no toast existed before 11/3)
function dasSay(t, ok){ let b=document.getElementById("dasSay");  // ok: good news, so it doesn't read as a fault
  if(!b){ b=Object.assign(document.createElement("div"), {id:"dasSay", role:"alert"}); b.style.cssText="position:fixed;left:16px;bottom:16px;z-index:3000;max-width:min(520px,calc(100vw - 32px));margin:0;padding:6px 12px;border-radius:12px;background:var(--surface);box-shadow:var(--g-shadow-up)"; document.body.appendChild(b); }
  b.className=ok?"status":"status err"; b.textContent=t; b.style.display="block"; clearTimeout(dasSay.t); dasSay.t=setTimeout(()=>{ b.style.display="none"; }, 8000); }  // display, not hidden: .status sets its own
// Print one page of a job (the AHJ report, the design submittal) the way the consent letters print: a copy attached
// to <body>. Printed in place it sat inside #view, which the Search print sheet's rule hides, and came out blank (11/3).
function dasPrintCopy(el){
  const box=el.cloneNode(true); el.removeAttribute("id"); box.id="dasPrint";
  document.body.appendChild(box); document.body.classList.add("print-das"); window.print();
  setTimeout(()=>{ document.body.classList.remove("print-das"); box.remove(); el.id="dasPrint"; },500);
}
const dasDl = (name, text, type) => { const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),10000); };
const csvOf = rows => { const keys=[]; for(const r of rows) for(const k of Object.keys(r)) if(!keys.includes(k)) keys.push(k);
  const c=v=>{ const s=v==null?"":String(v); return /[",\r\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  return [keys.join(","), ...rows.map(r=>keys.map(k=>c(r[k])).join(","))].join("\r\n")+"\r\n"; };
const fileSafe = s => (s||"job").replace(/[\\/:*?"<>|]+/g,"-").slice(0,80);
// the calendar date where the user is: toISOString() is the UTC date, which after 7 PM Eastern is tomorrow (11/3:
// consent letters, reports and grid baselines were dated a day ahead in the evening)
const ymd = t => `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
const today = () => ymd(new Date());
const addYear = d => { if(!d) return ""; const t=new Date(d+"T12:00:00"); t.setFullYear(t.getFullYear()+1); return ymd(t); };
const daysTo = d => d ? Math.round((Date.parse(d+"T12:00:00")-Date.now())/864e5) : null;

// a lifecycle item (das.py lifecycle) as a "needs you" line, or null when it needs nothing yet
function dasLifeNeed(x){
  if(!x||x.state==="ok"||x.state==="done"||x.state==="n/a") return null;
  const what=/^.[a-z]/.test(x.label)?x.label.charAt(0).toLowerCase()+x.label.slice(1):x.label;  // "OCSD: …" keeps its capitals
  if(x.key==="report") return x.state==="overdue"?`${what}: overdue by ${-x.days} days (was due ${x.due})`:`${what} by ${x.due}, in ${x.days} days`;
  if(x.state==="overdue") return `${what} overdue by ${-x.days} days`;
  if(x.state==="due") return `${what} due in ${x.days} days`;
  return `${what}: ${x.note||"open"}`;
}
window.dasOpenView = view => { S.das = S.das || {view:"board", q:"", job:null, sub:"overview"}; S.das.view = view; S.das.job = null; render(); };
S.views.das = async v => {
  const D=S.das=S.das||{view:"board", q:"", job:null, sub:"overview"};
  const gen=D.gen=(D.gen||0)+1;  // a draw overtaken by a newer one while it waited stops, instead of binding to the newer one's screen
  try{ const r=await api("/api/das/jobs"); D.jobs=r.jobs; D.stages=r.stages; D.folder=r.folder; D.firmNeeds=r.firm_needs; D.contacts=(await api("/api/das/contacts")).contacts; }
  catch(e){ if(gen===D.gen) v.innerHTML=`<p class="status err">DAS jobs: ${esc(e.message)}</p>`; return; }
  if(gen!==D.gen) return;
  if(!D.job) D.mon=await api("/api/das/monitor/board").then(r=>r.jobs||{}).catch(()=>({}));  // BDA alarms and quiet BDAs (snmpwatch.py), only while monitoring is on
  if(!D.job) D.leads=await api("/api/das/leads").then(r=>r.leads||[]).catch(()=>[]);  // new permits in the areas this login watches (leads.py)
  if(gen!==D.gen) return;
  if(D.job){ const j=D.jobs.find(x=>x.id===D.job); if(j) return dasJob(v, D.job); D.job=null; }
  const q=D.q.trim().toLowerCase(), jobs=D.jobs.filter(j=>!q||`${j.name} ${j.address||""} ${j.ahj||""} ${j.client||""}`.toLowerCase().includes(q));
  // what needs you: retests coming due, overdue next steps, open checks on jobs past design
  // the lifecycle items (das.py lifecycle: annual and five-year retests, licensee renewals, the operational permit, the
  // UL 2524 3rd-edition check, a retest after a remodel) come computed with each job, each with its source
  const need=[];
  for(const j of D.jobs){ const rd=daysTo(j.retest_due), dd=daysTo(j.due), ck=j.checks||{};
    if(Array.isArray(j.lifecycle)){ if(j.stage!=="Closed") for(const x of j.lifecycle) { if(D.firmNeeds&&window.dasFirmNeed&&["cal","cert"].includes(x.key)) continue; const t=dasLifeNeed(x); if(t) need.push([j, t, x.days??0, x]); } }
    else if(rd!=null&&rd<=60) need.push([j, rd<0?`annual retest overdue by ${-rd} days`:`annual retest due in ${rd} days`, rd]);
    if(dd!=null&&dd<0&&!["In service","Closed"].includes(j.stage)) need.push([j, `${window.dasNextText?.(j)||j.next_step||"next step"} overdue by ${-dd} days`, dd]);
    const ps=(j.scope||{ps:true}).ps;  // a carrier-only DAS has no Part 90 licensee consent or booster registration (das.py job_scope)
    if(j.code_ok===false&&["Pre-survey","Design","Install","Commission"].includes(j.stage)) need.push([j, "no one at the AHJ has confirmed the code (Code check)", 0]);
    if(ps&&["Install","Commission","Acceptance"].includes(j.stage)&&!ck.consent) need.push([j, "no licensee consent on file", 0]);
    if(ps&&["Commission","Acceptance","In service"].includes(j.stage)&&!ck.fcc_reg) need.push([j, "no FCC booster registration on file", 0]);
    for(const [t,sort,x] of window.dasNextNeeds?.(j)||[]) need.push([j, t, sort, x]);  // a stage move the file supports, and a retest's dates to press (dasnext.js)
    for(const x of j.watch||[]) need.push([j, x.text, x.reply?-1e5:0, x]);  // FCC licence changes, existing-system problems, replies waiting on a press, which come near the top (dasx.py)
    if(j.stage!=="Closed") for(const t of (D.mon||{})[j.id]||[]) need.push([j, t, -1e6, {url:"https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download", source:"NFPA 1225 (2022) 18.14 System Monitoring"}]); }  // a BDA in alarm or gone quiet comes first
  if(window.dasFirmNeed) for(const n of D.firmNeeds||[]){ const l=window.dasFirmNeed(n); if(l) need.push(l); }  // calibration and credentials: one line per instrument or person (dasfirm.py), not one per job
  need.sort((a,b)=>a[2]-b[2]);
  const leads=D.leads||[], nNeed=need.length+leads.length;
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <button class="primary" id="dsNew">+ New job</button>${S.me?.course?'<a class="hbtn" id="dsCourse" href="/course" target="_blank" rel="noopener" style="text-decoration:none">DAS course ↗</a>':""}
      <div class="seg" id="dsView">${[["board","Board"],["list","List"],["contacts","Contacts"],["register","Equipment & people"],["prospects","Prospects"],["pitch","Pitch"],["mail",window.rfMail?.ready_n?`Mail · ${rfMail.ready_n}`:"Mail"],["fault","Fault chart"],["data","Data & links"]].map(([k,l])=>`<button data-v="${k}" class="${D.view===k?"on":""}">${l}</button>`).join("")}</div>
      <label class="inl" title="Filters the board, and searches everything in DAS: every field in every job (readings, channels, notes), contacts, the log, job files and the DAS research">Find <input id="dsQ" value="${esc(D.q)}" placeholder="search all DAS data: jobs, readings, channels, contacts, files, code rules" style="width:330px"></label>
      <label class="inl" title="A job exported from RF Recon (JSON)">Import job <input type="file" id="dsImpJob" accept=".json"></label>
      <button id="dsExpCsv">⇩ Jobs CSV</button><button id="dsExpJson">⇩ All jobs JSON</button>${window.dasVerifyBox?'<button id="dsVerifyBtn" title="Paste a sealed report\'s verify code: what was sealed, and whether the job changed since">Verify a report</button>':""}
      <span class="hint">${(D.folder||"").startsWith("/rfr/") ? "Files for each job are kept in this browser."  /* the web version (web/webhost.py) */
        : S.me ? "Files for each job are kept on the RF Recon server: open them from the job's Files."  /* a signed-in login never sees the server's folders (11/3) */
        : `Files for each job are kept in <span class="mono">${esc(D.folder||"")}</span>.`}</span></div>
    <p style="margin:2px 2px 10px"><b>${D.jobs.length} job${D.jobs.length===1?"":"s"}</b>${nNeed?` · <b style="color:var(--warn)">${nNeed} need${nNeed===1?"s":""} you</b>`:" · nothing waiting on you"}</p>
    ${nNeed?`<div class="panel" id="dsNeed"><h3>Needs you</h3>${need.map(([j,t,,x],i)=>`<div class="row${i>=8?" need-more":""}" style="${i>=8&&!S.das.needAll?"display:none;":""}justify-content:space-between;align-items:center;padding:4px 0;border-top:1px solid var(--line)"><span><b>${esc(j.name)}</b> <span class="hint">${esc(j.stage)}</span> · ${esc(t)}${x?.url?` <a class="hint" href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.source)}">source</a>`:""}</span>${x?.reply?`<span data-rprow="${x.reply.id}" style="display:inline-flex;flex-wrap:wrap;gap:6px;margin-left:auto">${window.dasReplyBtns?.(x.reply)||""}<button data-open="${j.id}">Open</button></span><div data-rpbox="${x.reply.id}" style="flex:1 1 100%;min-width:0"></div>`:x?.firm&&x?.fold?`<button data-firm-open>Open the list</button>`:`<span class="row" style="gap:6px;margin-left:auto">${x?.move?`<button class="primary" data-move="${j.id}" data-to="${esc(x.move)}" title="Nothing moves until you press this. The gate checks it again">Move to ${esc(x.move)}</button>`:""}<button data-open="${j.id}">Open</button></span>`}</div>`).join("")}
      ${need.length>8?`<button id="dsNeedAll" style="margin-top:6px">${S.das.needAll?"Show the first 8":`Show all ${need.length}`}</button>`:""}
      ${leads.length&&window.dasLeadLine?`<div id="dsLeads"><h4>New leads <span class="hint">· new permits in the areas you watch, strongest need first. Nothing is sent.</span></h4>${leads.slice(0,5).map(window.dasLeadLine).join("")}${leads.length>5?`<button id="dsLeadAll">See all ${leads.length} in Prospects</button>`:""}</div>`:""}</div>`:""}
    <div id="dsVerify"></div>
    <div id="dsFind"></div>
    <div id="dsGuide"></div>
    <div id="dsBody"></div>`;
  window.dasBoardGuide?.($("#dsGuide"), D);  // how a job moves, and the example jobs (dasexample.js)
  $("#dsVerifyBtn")&&($("#dsVerifyBtn").onclick=()=>window.dasVerifyBox($("#dsVerify")));  // sealed reports (dasahj.js)
  const body=$("#dsBody");
  if(q.length>=2&&window.findRender){  // everything in DAS that matches, above the board (the board below is filtered by name / address / AHJ / client)
    const box=$("#dsFind"); box.innerHTML='<p class="hint">Searching all DAS data…</p>';
    api(`/api/das/search?q=${encodeURIComponent(D.q.trim())}`).then(res=>{ if(S.das!==D||D.q.trim().toLowerCase()!==q) return;
      box.innerHTML='<div class="panel"><h3 style="margin:0">Everything in DAS matching “'+esc(D.q.trim())+'”</h3><div id="dsFindOut"></div></div>'; findRender($("#dsFindOut"), res, D.q.trim()); })
      .catch(e=>{ box.innerHTML=`<p class="status err">${esc(e.message)}</p>`; }); }
  if(D.view==="mail"&&window.rfMail) rfMail.view(body);  // dasmail.js: your mailbox and every tagged conversation
  else if(D.view==="fault"&&window.dasFaultChart) window.dasFaultChart(body);  // dasfi.js
  else if(D.view==="pitch"&&window.dasPitch) window.dasPitch(body);  // daspitch.js
  else if(D.view==="prospects") window.dasProspects?window.dasProspects(body):(body.innerHTML='<p class="hint">Prospects is loading.</p>');  // dasprospects.js
  else if(D.view==="contacts") dasContacts(body);
  else if(D.view==="register") window.dasRegister?.(body);  // instruments, people and the AHJ book (dasfirm.js)
  else if(D.view==="data") dasData(body);
  else if(D.view==="list") body.innerHTML=jobs.length?`<div class="tw"><table><thead><tr><th>Job</th><th>Stage</th><th>Address</th><th>AHJ</th><th>Next step</th><th>Due</th><th>Retest due</th><th>Updated</th></tr></thead><tbody>${
      jobs.map(j=>`<tr data-open="${j.id}" style="cursor:pointer"><td><b>${esc(j.name)}</b></td><td>${esc(j.stage)}</td><td>${esc(j.address||"")}</td><td>${esc(j.ahj||"")}</td><td>${esc(window.dasNextText?.(j)||j.next_step||"")}</td><td class="mono">${esc(j.due||j.standing?.next?.due||"")}</td><td class="mono">${esc(j.retest_due||"")}</td><td class="mono">${esc((j.updated_at||"").slice(0,16))}</td></tr>`).join("")}</tbody></table></div>`
      :'<p class="status">No jobs yet. Start one with + New job.</p>';
  else {  // board: a column per stage; drag a card to move the job
    body.innerHTML=`<div style="display:grid;grid-auto-flow:column;grid-auto-columns:minmax(210px,1fr);gap:10px;overflow-x:auto;padding-bottom:6px">${D.stages.map(st=>{ const js=jobs.filter(j=>j.stage===st);
      return `<div class="panel ds-col" data-stage="${esc(st)}" style="margin:0;min-height:160px"><h3 style="display:flex;justify-content:space-between">${esc(st)} <span class="hint">${js.length}</span></h3>${js.map(j=>{ const ck=j.checks||{}, CK=dasChecksFor(j.cell_only), done=CK.filter(([k])=>ck[k]).length, rd=daysTo(j.retest_due);
        return `<div class="ds-card" draggable="true" data-open="${j.id}" data-id="${j.id}" style="border:1px solid var(--line);border-radius:12px;padding:9px 10px;margin-top:8px;cursor:grab;background:var(--wash,transparent)">
          <b>${esc(j.name)}</b><div class="hint">${esc(j.address||"No address yet")}</div>
          ${window.dasCardNext?window.dasCardNext(j):j.next_step?`<div style="font-size:12px;margin-top:4px">Next: ${esc(j.next_step)}${j.due?` · <span class="mono">${esc(j.due)}</span>`:""}</div>`:""}
          <div class="row" style="gap:4px;margin-top:6px"><span class="tag" title="Compliance dates on file">${done}/${CK.length} checks</span>${j.ahj?`<span class="tag">${esc(j.ahj)}</span>`:""}${rd!=null?`<span class="tag ${rd<0?"w":""}">retest ${rd<0?"overdue":`in ${rd} d`}</span>`:""}</div></div>`; }).join("")||'<p class="hint" style="margin-top:8px">Drop a job here.</p>'}</div>`; }).join("")}</div>`;
    let dragId=null;
    body.querySelectorAll(".ds-card").forEach(c=>{ c.addEventListener("dragstart",e=>{ dragId=+c.dataset.id; e.dataTransfer.effectAllowed="move"; c.style.opacity=".5"; }); c.addEventListener("dragend",()=>{ c.style.opacity=""; }); });
    body.querySelectorAll(".ds-col").forEach(col=>{
      col.addEventListener("dragover",e=>{ e.preventDefault(); col.style.outline="2px dashed var(--accent)"; });
      col.addEventListener("dragleave",()=>{ col.style.outline=""; });
      col.addEventListener("drop",async e=>{ e.preventDefault(); col.style.outline=""; if(dragId==null) return; const j=D.jobs.find(x=>x.id===dragId);
        if(j&&j.stage!==col.dataset.stage) window.dasMoveStage(dragId,col.dataset.stage,()=>render()); dragId=null; }); });
  }
  v.querySelectorAll("[data-open]").forEach(el=>el.addEventListener("click",()=>{ D.job=+el.dataset.open; D.sub="overview"; D.rview=null; render(); }));
  window.dasMoveWire?.(v);  // a stage move the file supports: a press, and the gate still checks it (dasnext.js)
  v.querySelectorAll("[data-firm-open]").forEach(el=>el.addEventListener("click",()=>window.dasOpenView("register")));
  window.dasReplyWire?.($("#dsNeed"), need.filter(n=>n[3]?.reply).map(([j,,,x])=>({jid:j.id, r:x.reply})), ()=>render());  // Mark given, Read it (dasx.js)
  window.dasLeadWire?.($("#dsLeads"), leads, j=>{ D.job=j.id; D.sub="overview"; D.rview=null; render(); }, ()=>render());  // Make a job, Not for us (dasprospects.js)
  $("#dsLeadAll")&&($("#dsLeadAll").onclick=()=>{ D.view="prospects"; render(); });
  // Needs you shows the first 8; the rest open in place (11/4: items past 8 were hidden with no way to see them)
  $("#dsNeedAll")?.addEventListener("click", e=>{ S.das.needAll=!S.das.needAll; v.querySelectorAll("#dsNeed .need-more").forEach(r=>{ r.style.display=S.das.needAll?"":"none"; });
    e.target.textContent=S.das.needAll?"Show the first 8":`Show all ${v.querySelectorAll("#dsNeed .row").length}`; });
  $("#dsView").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.view=b.dataset.v; render(); } };
  let t; $("#dsQ").oninput=e=>{ clearTimeout(t); t=setTimeout(()=>{ D.q=e.target.value; render(); const i=$("#dsQ"); i.focus(); i.setSelectionRange(i.value.length,i.value.length); },300); };
  $("#dsNew").onclick=async e=>{ const b=e.currentTarget; if(b.disabled) return; b.disabled=true;  // one press, one job (a double click made two, 11/3)
    try{ const p=parseLoc($("#loc").value); const j=await post("/api/das/jobs",{name:"New job",stage:"Lead",data:p?{lat:p[0],lon:p[1]}:{}}); D.job=j.id; D.sub="overview"; render(); }
    catch(err){ b.disabled=false; dasSay("The job wasn't made: "+err.message); } };
  $("#dsExpCsv").onclick=()=>dasDl("RF Recon DAS jobs.csv", csvOf(D.jobs.map(j=>({id:j.id,name:j.name,stage:j.stage,address:j.address,lat:j.lat,lon:j.lon,ahj:j.ahj,client:j.client,
    next_step:j.next_step,due:j.due,floors:Array.isArray(j.floors)?j.floors.length:"",accepted_on:j.accepted_on,retest_due:j.retest_due,...Object.fromEntries(DAS_CHECKS.map(([k])=>[k,(j.checks||{})[k]||""])),updated_at:j.updated_at}))), "text/csv");
  $("#dsExpJson").onclick=async()=>{ const full=[]; for(const j of D.jobs) full.push(await api(`/api/das/jobs/${j.id}`));
    dasDl("RF Recon DAS jobs.json", JSON.stringify({rfrecon_das_jobs:1, exported:new Date().toISOString(), jobs:full.map(({id,log,...x})=>x)},null,1), "application/json"); };
  $("#dsImpJob").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const j=JSON.parse(await f.text()); const list=j.jobs||[j];
      for(const x of list) await post("/api/das/jobs",{name:x.name||"Imported job",stage:x.stage||"Lead",data:x.data||{}}); render(); }catch(err){ alert("That file isn't an RF Recon job: "+err.message); } };
};

/* ---------- data and links: what DAS work reads, what to download, where the codes and lookups are ---------- */
// every link checked 2026-10-28; the design, PIM, parts and plans ones 2026-10-29 from the cited research
// (static/research). FCC and ICC pages refuse scripted checks: opened in a browser instead
const DAS_LINKS = [
  ["Codes", [["NFPA 1225 (free read-only access, NFPA account)", "https://www.nfpa.org/codes-and-standards/nfpa-1225-standard-development/1225", "Chapter 18 ERCES, 20.3.10 testing"],
    ["NFPA free access list", "https://www.nfpa.org/for-professionals/codes-and-standards/list-of-codes-and-standards/free-access", "Every NFPA code you can read free"],
    ["IFC 2024 chapter 5 (ICC, free to read)", "https://codes.iccsafe.org/content/IFC2024V1.0/chapter-5-fire-service-features", "Section 510, emergency responder communication coverage"],
    ["47 CFR 90.219 (eCFR)", "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-I/section-90.219", "Signal booster classes, consent, power and noise limits"],
    ["47 CFR 90.613 (eCFR)", "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-S/section-90.613", "800 MHz channel table (the 45 MHz pairs)"],
    ["ITU-R P.2109 building entry loss", "https://www.itu.int/rec/R-REC-P.2109/en", "The construction loss presets"],
    ["ITU-R P.526 diffraction", "https://www.itu.int/rec/R-REC-P.526/en", "The knife-edge loss used for terrain"]]],
  ["Design: link budget, coverage, walls", [["ITU-R P.1238 indoor propagation", "https://www.itu.int/rec/R-REC-P.1238/en", "The in-building path loss the link budget and the coverage on the plans use (no VHF values)"],
    ["ITU-R P.2040 building materials", "https://www.itu.int/rec/R-REC-P.2040/en", "Loss through walls and floors by material: the wall loss calculator"],
    ["NIST NISTIR 6055 measured wall loss", "https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir6055.pdf", "Concrete, brick, block and glass measured: the wall presets use these (the ITU model gives about a third of the loss for concrete)"],
    ["TIA TSB-88 portable antenna loss (draft, free)", "http://www.simulcastsolutions.com/userfiles/file/appnotes/pTR8.18-06-10-0035-PN3-4744.1-RV3-Fb.pdf", "Portable antenna and body loss by band: the uplink default"],
    ["NPSTC in-building white paper", "https://www.npstc.org/documents/20071212_IBWG%20White%20Paper%20Appendix%20A-E.pdf", "Isolation, booster headroom and link budget practice"]]],
  ["AHJ guidelines with numbers", [["Orange County (CA) Sheriff ERRCS guidelines", "https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf", "Uplink −95 to −75 dBm at the site, 65 dB gain cap, 27 dBm at the donor port, −150 dBm noise"],
    ["Durham (NC) BDA permit requirements", "https://www.durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-", "Uplink under −80 dBm at the tower, −153 dBm noise, Class A only"],
    ["San Diego Fire-Rescue C-1", "https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf", "Gain cap, noise at the donor site, grid testing"],
    ["Fairfax County (VA) ERCES submittal guidelines", "https://www.fairfaxcounty.gov/fire-ems/sites/fire-ems/files/Assets/Documents/PDF/fire%20marshal/ERCES%20Submittal%20and%20Permit%20Requirements%20Guidelines.pdf", "What the submittal must include, plans included"]]],
  ["PIM and parts", [["IEC 62037 PIM measurement (abstract; the standard is paid)", "https://webstore.iec.ch/en/publication/6331", "How PIM is measured; part 7 covers field measurement"],
    ["Anritsu: PIM in in-building DAS", "https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf", "Where PIM comes from in a DAS and how to find it"],
    ["Anritsu: testing a DAS", "https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf", "Sweeps, distance-to-fault and PIM on a DAS"],
    ["RFS DragonSkin 2-hour fire-rated coax (UL 2196)", "https://www.rfstechnologies.com/pim/product/pdf/2HB12-50JPLR", "The kind of cable a 2-hour pathway rule asks for"]]],
  ["FCC lookups", [["ULS licence search", "https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp", "Any licence by call sign, name, frequency or area"],
    ["Antenna structure (ASR) search", "https://wireless2.fcc.gov/UlsApp/AsrSearch/asrRegistrationSearch.jsp", "Towers by registration, owner or location"],
    ["Equipment authorization (FCC ID) search", "https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm", "A device's grant: frequencies, power, test reports (Data & updates, Look up an FCC ID, links here)"],
    ["National Broadband Map", "https://broadbandmap.fcc.gov/", "Carriers' modelled coverage: RF Recon's Carrier coverage heatmap (your own free FCC key)"],
    ["Signal boosters (FCC)", "https://www.fcc.gov/wireless/bureau-divisions/mobility-division/signal-boosters", "Rules, classes, how to register"],
    ["Class B booster registration and list", "https://signalboosters.fcc.gov/", "Register a Class B booster; search registered ones (refuses scripted downloads; was down for maintenance 2026-10-28)"]]],
  ["Planning and agencies", [["CAPRAD", "https://caprad.org/", "700 / 800 MHz public safety regional planning and channel assignments"],
    ["NPSTC", "https://www.npstc.org/", "Channel naming, interoperability, in-building reports"],
    ["RadioReference database", "https://www.radioreference.com/db/", "Systems, sites and talk groups (look up there; RF Recon only links to it)"],
    ["FirstNet Authority", "https://www.firstnet.gov/", "Holds the Band 14 licence (AT&T runs the network); the Band 14 retransmit request goes to FirstNetSpectrum.Manager@firstnet.gov (makers' manuals)"],
    ["Safer Buildings Coalition", "https://www.saferbuildings.org/", "Industry guidance, AHJ resources"]]],
  ["Bulk downloads", [["USGS National Map downloader", "https://apps.nationalmap.gov/downloader/", "3DEP elevation and building data, by area"],
    ["AWS Terrain Tiles", "https://registry.opendata.aws/terrain-tiles/", "The terrain RF Recon uses (free, no account)"],
    ["Microsoft US building footprints", "https://github.com/microsoft/USBuildingFootprints", "Every US building outline, by state (large)"],
    ["OpenStreetMap", "https://www.openstreetmap.org/copyright", "Building outlines RF Recon fetches per job (ODbL)"]]],
];
// the research sets beside DAS-ERCES in Drive (docs/research, built by build_field_research.py): name, folder id, what it holds
const DAS_RESEARCH = [["PIM", "1baexagIqzgUM9fdpTeNfJ2UcB8dImiko", "limits, checklists, procedures, torque"],
  ["RF-Parts", "15NOO7YMst9rCSCB12s3HrwQz3h1rX7Vh", "cables, connectors, components, suppliers"],
  ["Building-Plans-Materials", "1MUQ1pM4NTvRYabItL5Ssj7mecDjyjuhB", "getting plans, wall losses by material"],
  ["Link-Budget", "1LUi4ERK8vyhKEZAuGBRFSVCKLqQZEBzr", "defaults, formulas, P.1238, 90.219 and AHJ limits"]];
async function dasData(el){
  el.innerHTML='<p class="status">Checking the data…</p>';
  let upd={sources:{}}, ter={tiles:0, mb:0, folder:""};
  try{ [upd, ter]=await Promise.all([api("/api/update/status"), api("/api/das/terrain/status")]); }catch(e){ /* offline or not ready: the panel shows what it has and says so */ }
  const jobs=[]; for(const j of S.das.jobs) if(j.lat!=null) jobs.push(j);
  const full=[]; for(const j of jobs) full.push((await api(`/api/das/jobs/${j.id}`)).data||{});
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const outlined=full.filter(d=>d.building).length;
  // the sources the DAS tab reads (DAS_USES, mission.js): one switch keeps them all updating by themselves
  const ids=Object.keys(DAS_USES).filter(id=>upd.sources[id]), auto=upd.auto&&ids.length&&ids.every(id=>upd.sources[id].enabled);
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Data the DAS tab reads</h3>${ids.length?`
      <div class="row" style="align-items:center"><label class="switch"><input type="checkbox" id="ddAuto" ${auto?"checked":""}><span></span></label><b>Auto-update DAS data when online</b></div>
      <div class="row" style="margin-top:8px;align-items:center;flex-wrap:wrap"><button class="primary" id="ddRunAll">⟳ Update all DAS data now</button><span class="hint" id="ddRunMsg"></span></div>`
      :'<p class="hint">Updates run in the PC version.</p>'}
      ${ids.map(id=>{ const s=upd.sources[id];
        return `<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:6px 0"><span><b>${esc(s.label)}</b><div class="hint">${esc(DAS_USES[id])}</div>
          <div class="hint">${s.enabled?"":'<b style="color:var(--bad)">not updating by itself</b> · '}${s.access?.needs_key&&!s.access.key_saved?'<b style="color:var(--bad)">no key saved</b> · ':""}${freshness(s, upd.auto)}${s.state==="error"?` · <span style="color:var(--bad)">${esc(s.message)}</span>`:""}</div></span>
          <button data-run="${esc(id)}" ${s.running?"disabled":""}>${s.running?"Updating…":"Update now"}</button></div>`; }).join("")}
      <p class="hint">On, the switch turns on automatic updates and selects all ${ids.length} of these; each then updates on its own schedule, over the connections Data &amp; updates allows. Off stops these ${ids.length} updating by themselves, on the map and in search too (they're the same data). Update all leaves out a source whose key isn't saved.
        Schedules, keys and Update over (Wi-Fi, Ethernet, cellular) are in Data &amp; updates.</p></div>
    <div class="panel"><h3>Terrain and building outlines</h3>
      <p style="margin:0 0 6px">Terrain on this PC: <b>${ter.tiles.toLocaleString()}</b> tiles, ${ter.mb} MB${ter.folder?` <span class="hint mono">${esc(ter.folder)}</span>`:""}</p>
      <div class="row"><button id="ddTer" ${jobs.length?"":"disabled"}>⇩ Download terrain around every job (${jobs.length})</button><span class="hint" id="ddTerMsg"></span></div>
      <p class="hint">For terrain paths and coverage with no signal in the field. ${esc(ter.attribution||"")}</p>
      <p style="margin:10px 0 6px">Building outlines: <b>${outlined}</b> of ${jobs.length} jobs have one.</p>
      <div class="row"><button id="ddOut" ${jobs.length>outlined?"":"disabled"}>⌂ Get the missing outlines</button><span class="hint" id="ddOutMsg"></span></div>
      <p class="hint">From OpenStreetMap (ODbL), with Overture Maps (ODbL) where OpenStreetMap has no outline or height: footprint, floors and height, for the floor area, sector split and donor height.</p></div></div>
    <div class="panel"><h3>Codes, rules, lookups and downloads</h3>
      ${DAS_LINKS.map(([g,ls])=>`<h4 style="margin:10px 0 4px">${esc(g)}</h4>${ls.map(([t,u,w])=>`<div style="padding:2px 0"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a> <span class="hint">· ${esc(w)}</span></div>`).join("")}`).join("")}
      <h4 style="margin:10px 0 4px">Research</h4><div>${DAS_SOURCES}</div>
      <p style="margin:8px 0 0">The rest of the research, each a database with a CSV per table and its report, in Drive under <span class="mono">RF Recon\\docs\\research</span>:
        ${DAS_RESEARCH.map(([n,id,w])=>`<a href="https://drive.google.com/drive/folders/${id}" target="_blank" rel="noopener">${esc(n)}</a> <span class="hint">(${esc(w)})</span>`).join(", ")}.</p></div>`;
  el.querySelectorAll("[data-run]").forEach(b=>b.onclick=async()=>{ b.disabled=true; b.textContent="Updating…"; await post("/api/update/run",{ids:[b.dataset.run],force:true}); });
  if($("#ddAuto")) $("#ddAuto").onchange=async e=>{ const on=e.target.checked;
    await post("/api/update/config",{...(on?{auto:true}:{}), sources:Object.fromEntries(ids.map(id=>[id,{enabled:on}]))}); if(el.isConnected) dasData(el); };
  if($("#ddRunAll")) $("#ddRunAll").onclick=async()=>{ const b=$("#ddRunAll"); b.disabled=true;
    try{ const r=await post("/api/update/run",{ids, skip_no_key:true}), nm=id=>r.sources[id]?.label||id;
      if(!el.isConnected) return;
      $("#ddRunMsg").textContent=`${r.started.length?`Updating ${r.started.length}.`:"All already updating."}${r.skipped.length?` Left out, no key saved: ${r.skipped.map(nm).join(", ")}.`:""}`;
      el.querySelectorAll("[data-run]").forEach(x=>{ if(r.started.includes(x.dataset.run)){ x.disabled=true; x.textContent="Updating…"; } }); }
    catch(e){ $("#ddRunMsg").textContent=e.message; } b.disabled=false; };
  $("#ddTer").onclick=async()=>{ const b=$("#ddTer"); b.disabled=true; $("#ddTerMsg").textContent="Downloading…";
    try{ const r=await post("/api/das/terrain/download",{areas:jobs.map((j,i)=>({lat:j.lat, lon:j.lon, radius:full[i].presurvey?.radius||15}))});
      const got=r.areas.reduce((a,x)=>a+x.fetched,0), bad=r.areas.reduce((a,x)=>a+x.failed,0);
      $("#ddTerMsg").textContent=`${got} new tiles${bad?`, ${bad} failed (offline?)`:""}. ${r.tiles.toLocaleString()} tiles, ${r.mb} MB on this PC.`; }catch(e){ $("#ddTerMsg").textContent=e.message; } b.disabled=false; };
  $("#ddOut").onclick=async()=>{ const b=$("#ddOut"); b.disabled=true; let n=0, bad=[];
    for(let i=0;i<jobs.length;i++){ if(full[i].building) continue; $("#ddOutMsg").textContent=`${jobs[i].name}…`;
      try{ const bd=await api(`/api/das/building?lat=${jobs[i].lat}&lon=${jobs[i].lon}`), patch={building:bd};
        if(full[i].area_sqft==null&&bd.footprint_sqft) patch.area_sqft=bd.footprint_sqft;
        await post(`/api/das/jobs/${jobs[i].id}`,{data:patch}); n++; }catch(e){ bad.push(`${jobs[i].name}: ${e.message}`); }
      await new Promise(r=>setTimeout(r,1100)); }  // OpenStreetMap's Overpass asks for gentle use
    $("#ddOutMsg").textContent=`${n} outlines added.${bad.length?` ${bad.join(" · ")}`:""}`; };
}

/* ---------- contacts: the CRM side ---------- */
function dasContacts(el){
  const D=S.das, cs=D.contacts;
  el.innerHTML=`<div class="panel"><div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">Contacts <span class="hint">· ${cs.length}</span></h3>
      <div class="row"><label class="inl">Import (CSV, Excel, vCard) <input type="file" id="dcImp" accept=".csv,.tsv,.txt,.xlsx,.vcf,.json"></label><button id="dcCsv">⇩ CSV</button><button id="dcVcf">⇩ vCard</button></div></div>
    <div class="tw" style="margin-top:8px"><table><thead><tr><th>Name</th><th>Organisation</th><th>Role</th><th>Phone</th><th>Email</th><th>Notes</th><th></th></tr></thead><tbody>
    ${cs.map(c=>`<tr data-cid="${c.id}">${["name","org","role","phone","email","notes"].map(f=>`<td><input data-f="${f}" value="${esc(c[f]||"")}" style="width:100%;min-width:90px"></td>`).join("")}<td><button data-del="${c.id}">Delete</button></td></tr>`).join("")}
    <tr id="dcNewRow">${["name","org","role","phone","email","notes"].map(f=>`<td><input data-f="${f}" placeholder="${f==="org"?"organisation":f}" style="width:100%;min-width:90px"></td>`).join("")}<td><button class="primary" id="dcAdd">Add</button></td></tr></tbody></table></div>
    <p class="hint" id="dcMsg">Changes save when you leave a field. Roles: AHJ / fire marshal, building owner, radio system owner (agency), general contractor, technician, or anything you like.</p></div>`;
  el.querySelectorAll("tr[data-cid] input").forEach(i=>i.onchange=async()=>{ const tr=i.closest("tr"), d={}; tr.querySelectorAll("input").forEach(x=>d[x.dataset.f]=x.value);
    await post(`/api/das/contacts/${tr.dataset.cid}`, d); $("#dcMsg").textContent="Saved."; });
  el.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{ await post(`/api/das/contacts/${b.dataset.del}/delete`); render(); });
  $("#dcAdd").onclick=async()=>{ const d={}; $$("#dcNewRow input").forEach(x=>d[x.dataset.f]=x.value); if(!d.name&&!d.org) return;
    try{ await post("/api/das/contacts", d); render(); }catch(e){ dasSay("The contact wasn't saved: "+e.message); } };  // a refusal shows (11/3)
  $("#dcImp").onchange=async e=>{ const f=e.target.files[0]; if(!f) return; try{ const r=await api(`/api/das/contacts/import?name=${encodeURIComponent(f.name)}`,{method:"POST",body:await f.arrayBuffer()});
      $("#dcMsg").textContent=`${r.found} found, ${r.added} added (the rest were already here).`; setTimeout(render,900); }catch(err){ $("#dcMsg").textContent="Import: "+err.message; } };
  $("#dcCsv").onclick=()=>dasDl("RF Recon contacts.csv", csvOf(cs.map(({id,updated_at,...c})=>c)), "text/csv");
  $("#dcVcf").onclick=()=>dasDl("RF Recon contacts.vcf", cs.map(c=>["BEGIN:VCARD","VERSION:3.0",`FN:${c.name||c.org}`,c.org?`ORG:${c.org}`:"",c.role?`TITLE:${c.role}`:"",c.phone?`TEL:${c.phone}`:"",c.email?`EMAIL:${c.email}`:"",c.notes?`NOTE:${c.notes.replace(/\n/g,"\\n")}`:"","END:VCARD"].filter(Boolean).join("\r\n")).join("\r\n")+"\r\n", "text/vcard");
}

/* ---------- one job ---------- */
async function dasJob(v, id){
  const D=S.das, gen=D.gen; let j;
  try{ j=await api(`/api/das/jobs/${id}`); }catch(e){ if(gen===D.gen){ D.job=null; render(); } return; }
  if(gen!==D.gen) return;  // the board or another job was drawn while this waited
  DASJ=dasProfile((j.data||{}).profile);
  // a refused save says so on screen and leaves the job as it was (11/3: it failed silently, only an unhandled rejection)
  // each save names the revision this page was drawn from (not a later answer's, which can carry someone else's change
  // the page never showed), so their change is merged or asked about (dasrev.js); this page's own saves never clash
  const drawn=j.rev, d=j.data||{}, save=async(patch,extra)=>{ try{ j=await post(`/api/das/jobs/${id}`,{...(extra||{}),data:patch,rev:drawn}); }catch(e){ dasSay("Not saved: "+e.message); } return j; };
  const subs=[["overview","Overview"],["presurvey","Pre-survey"],["plans","Plans"],["require","Requirements"],...(window.dasAudit?[["audit","Existing system"]]:[]),["design","Design"],["materials","Materials"],["grid","Grid test"],["screen","Screening"],["pim","PIM"],["files","Files"],["log","Log"],["report","Report"]];
  if(window.dasFaultChart) subs.splice(1, 0, ["fault","Fault chart"]);  // this job's stage and type, a step at a time (dasfi.js)
  if(window.dasCommission) subs.splice(subs.findIndex(s=>s[0]==="grid"), 0, ["commission","Commissioning"]); if(window.dasSweep) subs.find(s=>s[0]==="pim")[1]=window.dasFiber?"PIM / sweeps / fiber":"PIM / sweeps";  // dascommission.js, dassweep.js
  v.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px"><button id="djBack">← All jobs</button>
      <input id="djName" value="${esc(j.name)}" style="font-size:18px;font-weight:700;min-width:260px">
      <label class="inl">Stage <select id="djStage">${D.stages.map(s=>`<option ${s===j.stage?"selected":""}>${esc(s)}</option>`).join("")}</select></label>
      <div class="seg" id="djSub">${subs.map(([k,l])=>`<button data-s="${k}" class="${D.sub===k?"on":""}">${l}</button>`).join("")}</div>
      <span style="margin-left:auto" class="row"><button id="djWalk" title="Checks what's on file, picks up where the job stands, and moves you to each place">Walk me through</button><button id="djToStart" title="This job on the Start tab, step by step">Step by step</button><button id="djExp">⇩ Job JSON</button><button id="djDel">Delete job</button></span></div>
    <div id="djStart"></div><div id="djGuide"></div><div id="djX"></div><div id="djBody"></div>`;
  window.startBackBar?.($("#djStart"), j);  // opened from the Start tab: the way back (start.js)
  window.dasJobGuide?.($("#djGuide"), j, D.sub);  // an example job explains each step (dasexample.js)
  window.dasXBanner?.($("#djX"), j);  // open FCC licence changes and existing-system problems (dasx.js)
  $("#djBack").onclick=()=>{ D.job=null; render(); };
  $("#djToStart").onclick=()=>window.startOpenJob?.(id);
  $("#djWalk").onclick=()=>window.dasWalkOpen?.(id);  // dasguide.js
  $("#djName").onchange=async e=>{ await post(`/api/das/jobs/${id}`,{name:e.target.value}); };
  $("#djStage").onchange=e=>window.dasMoveStage(id,e.target.value,()=>render());  // a move forward needs what the stage needs, or a reason (codecheck.py)
  $("#djSub").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.sub=b.dataset.s; render(); } };
  $("#djExp").onclick=()=>{ const {id:_,log,...x}=j; dasDl(`${fileSafe(j.name)} (RF Recon job).json`, JSON.stringify({rfrecon_das_job:1,...x},null,1), "application/json"); };
  $("#djDel").onclick=async()=>{ if(!confirm(`Delete “${j.name}”? ${S.me||(S.das?.folder||"").startsWith("/rfr/")?"Its files are kept on this copy.":"Its files stay in the Drive folder."}`)) return; await post(`/api/das/jobs/${id}/delete`); D.job=null; render(); };
  const body=$("#djBody");
  if(D.sub==="fault"&&window.dasFaultChart) return window.dasFaultChart(body, {job:j});
  if(D.sub==="commission"&&window.dasCommission) return window.dasCommission(body, j, save);  // guided commissioning (dascommission.js)
  ({overview:dasOverview, presurvey:dasPresurvey, require:dasRequire, grid:dasGrid, files:dasFiles, log:dasLog, report:dasReport,
    pim:window.dasPim, screen:window.dasScreen, materials:window.dasMaterials, plans:window.dasPlans, design:window.dasDesign, audit:window.dasAudit}[D.sub]||dasOverview)(body, j, save);  // fieldref.js, plans.js, dasdesign.js, dasscreen.js, dasx.js
}

function dasOverview(el, j, save){
  const d=j.data||{}, ck=d.checks||{}, cs=S.das.contacts, roles=d.contacts||{};
  const floors=Array.isArray(d.floors)?d.floors:[], pn=S.das.pinNote?.id===j.id?S.das.pinNote:null;
  el.innerHTML=`<div id="doNext"></div><div id="doCode"></div>${window.dasLeadPanel?.(d, j.stage)||""}<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>Building</h3>
      <div class="row"><label class="grow">Client<input data-k="client" value="${esc(d.client||"")}"></label><label class="grow">Address<input data-k="address" value="${esc(d.address||"")}"></label></div>
      <div class="row" style="margin-top:6px"><label>Latitude<input data-k="lat" type="number" step="any" value="${d.lat??""}" style="width:130px"></label><label>Longitude<input data-k="lon" type="number" step="any" value="${d.lon??""}" style="width:130px"></label>
        <button id="doPin" title="Use the pin from the search panel">Use current pin</button><button id="doGo" title="Search the area around the building">Show on map</button></div>
      ${pn?`<p class="hint" id="doPinNote" style="margin:6px 0 0">Pin moved to this address, ${num(pn.mi,pn.mi<10?1:0)} mi from where it was.${pn.stale?` ${esc(pn.stale)} still describe${pn.stale.includes(",")||pn.stale.includes(" and ")?"":"s"} the old spot: run again.`:""} <a href="#" id="doPinUndo">Undo</a></p>`:""}<div id="doPinWarn"></div>
      <div class="row" style="margin-top:6px"><label>Floors <input id="doFloors" type="number" min="0" value="${floors.length||""}" style="width:80px"></label>
        <label>Area (sq ft)<input data-k="area_sqft" type="number" value="${d.area_sqft??""}" style="width:110px"></label>
        <label>Construction <select data-k="construction" style="max-width:270px">${Object.keys(DAS.loss).map(c=>`<option ${c===d.construction?"selected":""}>${esc(c)}</option>`).join("")}</select></label></div>
      <div class="row" style="margin-top:6px;align-items:center"><button id="doOutline" title="Footprint, floors and height from OpenStreetMap, for the floor area, sector split, roof height and map">⌂ Get the building's outline</button>
        <span class="hint" id="doOutMsg">${d.building?dasBuildingLine(d.building):"From OpenStreetMap (Overture Maps where it has none): footprint, floors and height."}</span></div>
      <div class="row" style="margin-top:6px;align-items:center"><button id="doNsi" title="The USACE National Structure Inventory for this building: occupancy, stories, square feet, basement, year built, people by day. Fills only the fields that are empty">⌂ Look up building (NSI)</button>
        <span class="hint" id="doNsiMsg">${d.nsi?dasNsiLine(d.nsi):"USACE National Structure Inventory: modelled occupancy, stories, sq ft, basement, year built and people inside, as estimates."}</span></div>
      <div class="row" style="margin-top:6px"><label class="grow">AHJ (jurisdiction)<input data-k="ahj" value="${esc(d.ahj||"")}" placeholder="e.g. Arlington County Fire Marshal"></label>
        <label class="grow">Code basis<input data-k="code" value="${esc(d.code||"IFC 510 + NFPA 1225")}" placeholder="IFC 2024 510, NFPA 1225 2022, local amendments"></label></div>
      <div id="doAhjX"></div>
      <div class="row" style="margin-top:6px"><label class="grow" title="What you type here shows on the board, in place of what RF Recon works out">Next step<input data-k="next_step" value="${esc(d.next_step||"")}" placeholder="${esc(j.standing?.worked?.text||"")}"></label><label>Due<input data-k="due" type="date" value="${esc(d.due||"")}"></label>
        <label>Value ($)<input data-k="value" type="number" value="${d.value??""}" style="width:110px"></label></div></div>
    <div class="panel"><h3>Compliance <span class="hint">· a date means done${dasCellOnly(d)?"; a cellular job: the carriers' approvals are under Pre-survey":""}</span></h3>
      ${dasChecksFor(dasCellOnly(d)).map(([k,l])=>`<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0"><span>${ck[k]?"✅":"⬜"} ${esc(l)}</span><input type="date" data-ck="${k}" value="${esc(ck[k]||"")}"></div>`).join("")}
      <p style="margin:8px 0 0">Annual retest due: <b class="mono">${esc(d.retest_due||"–")}</b>${d.retest_due?` <span class="hint">(${daysTo(d.retest_due)} days)</span>`:""} <span class="hint">· set from the acceptance date, one year on</span>${d.retest_due&&window.rfMail?` <button class="sm" id="doRetestMail" title="Email the owner to book the annual retest, from your own mailbox">✉ Remind the owner</button>`:""}</p></div>
    ${dasLifePanel(d, j.lifecycle)}
    <div class="panel" id="doMon" style="display:none"></div>
    <div class="panel"><h3>People</h3>
      ${DAS_ROLES.map(([k,l])=>`<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0"><span>${esc(l)}</span>
        <select data-role="${k}" style="max-width:60%"><option value="">—</option>${cs.map(c=>`<option value="${c.id}" ${String(roles[k])===String(c.id)?"selected":""}>${esc(c.name||c.org)}${c.org&&c.name?` · ${esc(c.org)}`:""}</option>`).join("")}</select></div>`).join("")}
      <p class="hint">Add people under All jobs, Contacts (or import a CSV / vCard there).</p></div>
    <div class="panel"><h3>Testing <span class="hint">· goes on the AHJ report</span></h3>
      <div id="doFirm"></div>
      <div class="row"><label class="grow">Tester<input data-t="tester" value="${esc((d.testing||{}).tester||"")}"></label><label>FCC GROL<input data-t="grol" value="${esc((d.testing||{}).grol||"")}" style="width:120px"></label>
        <label>NICET<input data-t="nicet" value="${esc((d.testing||{}).nicet||"")}" style="width:120px"></label></div>
      <div class="row" style="margin-top:6px"><label>Tested<input data-t="date" type="date" value="${esc((d.testing||{}).date||"")}"></label><label>to<input data-t="date2" type="date" value="${esc((d.testing||{}).date2||"")}"></label>
        <label>Booster <select data-k="booster_class">${["Class A (channelized)","Class B (wideband)","Not chosen yet"].map(c=>`<option ${c===(d.booster_class||"Class A (channelized)")?"selected":""}>${c}</option>`).join("")}</select></label></div>
      <label style="margin-top:6px">Instruments, one per line: model | serial | calibration date<textarea id="doInst" rows="3" style="width:100%" placeholder="PCTEL IBflex | 12345 | 2026-03-01">${esc(((d.testing||{}).instruments||[]).map(i=>[i.model,i.serial,i.cal].join(" | ")).join("\n"))}</textarea></label>
      <p class="hint" style="margin:4px 0 0">Grid readings count toward pass / fail only when they were taken with one of these, calibrated within ${DAS.cal_months} months (Grid test, <i>Taken with</i>). An SDR or a phone app has no calibration: its readings stay on the plan as pre-survey and aren't scored. A certificate's expiry, set below, wins over the ${DAS.cal_months}-month rule.</p>
      <div id="doCerts"></div><div id="doRead"></div></div>
    <div class="panel"><h3>Notes</h3><textarea data-k="notes" rows="7" style="width:100%">${esc(d.notes||"")}</textarea></div></div>`;
  el.querySelectorAll("[data-t]").forEach(i=>i.onchange=async()=>{ j=await save({testing:{...(j.data.testing||{}),[i.dataset.t]:i.value}}); });
  // an instrument keeps its certificate and expiry (the register below) while its line is edited here
  $("#doInst").onchange=async e=>{ const old=new Map(((j.data.testing||{}).instruments||[]).map(i=>[instKey(i), i]));
    const instruments=e.target.value.split("\n").map(l=>l.split("|").map(s=>s.trim())).filter(p=>p[0]).map(([model,serial,cal])=>{ const x={model,serial:serial||"",cal:cal||""}, o=old.get(instKey(x));
      return o?{...o, ...x}:x; });
    j=await save({testing:{...(j.data.testing||{}),instruments}}); };
  el.querySelectorAll("[data-k]").forEach(i=>i.onchange=async()=>{ const k=i.dataset.k, val=i.type==="number"?(i.value===""?null:+i.value):i.value; j=await save({[k]:val}); });
  // A suggestion taken in the Address box brings its coordinates, and the pin follows in the same save. Before 11/5 they were
  // dropped: every step runs off the pin, so in the demo the map sat 15 mi from an address edited seven times. A street
  // address moves it; a town or county only sets a job with no pin, since it's vaguer than a pin already placed.
  const addrIn=el.querySelector('input[data-k="address"]'); let took=null;
  addrIn.addEventListener("rf-addr", e=>{ took=e.detail; });
  addrIn.onchange=async()=>{ const t=took, dd=j.data||{}, had=dd.lat!=null&&dd.lon!=null, patch={address:addrIn.value}; took=null;
    const mi=t&&had?geoMi(dd.lat,dd.lon,t.lat,t.lon):null, move=t&&t.lat!=null&&(!had||(t.kind==="address"&&mi>0.03));
    if(move) Object.assign(patch,{lat:t.lat,lon:t.lon});
    j=await save(patch); if(!move) return;
    const old=[dd.building&&"The building outline",dd.nsi&&"the NSI record",dd.ahj_guess&&"the AHJ guess"].filter(Boolean);
    S.das.pinNote=had?{id:j.id, mi, was:[dd.lat,dd.lon], stale:mi>0.1&&old.length?old.join(", ").replace(/, ([^,]*)$/," and $1"):""}:null;
    render(); };
  $("#doPinUndo")&&($("#doPinUndo").onclick=async e=>{ e.preventDefault(); const [lat,lon]=S.das.pinNote.was; S.das.pinNote=null; j=await save({lat,lon}); render(); });
  el.querySelectorAll("[data-ck]").forEach(i=>i.onchange=async()=>{ const checks={...(j.data.checks||{}),[i.dataset.ck]:i.value}; const patch={checks};
    if(i.dataset.ck==="accepted_on"){ patch.accepted_on=i.value; patch.retest_due=addYear(i.value); }
    j=await save(patch); render(); });
  el.querySelectorAll("[data-role]").forEach(s=>s.onchange=async()=>{ j=await save({contacts:{...(j.data.contacts||{}),[s.dataset.role]:s.value?+s.value:null}}); });
  $("#doFloors").onchange=async e=>{ const n=Math.max(0,Math.min(200,+e.target.value||0)); const cur=Array.isArray(j.data.floors)?j.data.floors:[];
    const fl=Array.from({length:n},(_,i)=>cur[i]||{name:String(i+1),grids:DAS.grids}); j=await save({floors:fl}); };
  $("#doOutline").onclick=async()=>{ const dd=j.data; if(dd.lat==null){ alert("Set the building's location first."); return; } $("#doOutMsg").textContent="Asking OpenStreetMap (can take up to a minute when it is busy)…";
    try{ const b=await api(`/api/das/building?lat=${dd.lat}&lon=${dd.lon}`), patch={building:b};
      if(dd.area_sqft==null&&b.footprint_sqft) patch.area_sqft=b.footprint_sqft;  // only fills what's empty
      if(!(Array.isArray(dd.floors)&&dd.floors.length)&&b.levels) patch.floors=Array.from({length:Math.min(200,b.levels)},(_,i)=>({name:String(i+1),grids:DAS.grids}));
      j=await save(patch); render(); }catch(e){ $("#doOutMsg").textContent=e.message; } };
  // NSI (R3 #1): one small box around the point, asked by the server (nsi.py); it fills only what's empty, like the outline
  $("#doNsi").onclick=async()=>{ const dd=j.data; if(dd.lat==null){ alert("Set the building's location first."); return; } const b=$("#doNsi"); b.disabled=true; $("#doNsiMsg").textContent="Asking the National Structure Inventory…";
    try{ const n=await api(`/api/das/nsi?lat=${dd.lat}&lon=${dd.lon}&job=${j.id}`), patch={nsi:n};
      if(dd.area_sqft==null&&n.sqft) patch.area_sqft=n.sqft;  // the NSI's sq ft is the whole building's floor area (an estimate)
      if(!(Array.isArray(dd.floors)&&dd.floors.length)&&n.stories) patch.floors=Array.from({length:Math.min(200,n.stories)},(_,i)=>({name:String(i+1),grids:DAS.grids}));
      j=await save(patch); render(); }catch(e){ b.disabled=false; $("#doNsiMsg").textContent=e.message; } };
  $("#doPin").onclick=async()=>{ const p=parseLoc($("#loc").value); if(!p){ alert("Drop a pin or type the address in the search panel first."); return; } S.das.pinNote=null; j=await save({lat:p[0],lon:p[1]}); render(); };
  dasPinCheck($("#doPinWarn"), j, async hit=>{ j=await save({lat:hit.lat,lon:hit.lon}); render(); });
  dasLifeWire(el, () => j, async patch => { j = await save(patch); render(); });
  window.dasMonitor?.($("#doMon"), j, async patch => (j = await save(patch)));  // BDA monitoring by SNMP trap (dasmonitor.js, snmpwatch.py)
  window.dasCertRegister?.($("#doCerts"), j, async patch => { j = await save(patch); render(); });  // calibration certificates (dasahj.js)
  window.dasCertReader?.($("#doRead"), j, async patch => { const was = j; j = await save(patch); if (j !== was) render(); return j !== was; });  // a certificate's own words, proposed (dasread.js)
  window.dasFirmPick?.($("#doFirm"), j);  // instruments and testers kept once (dasfirm.js)
  window.dasAhjGuess?.($("#doAhjX"), j, save);  // fire departments covering the address (dasx.js, USFA registry)
  window.dasNextPanel?.($("#doNext"), j);  // what the file says is next, and the retest's dates to press (dasnext.js)
  window.dasCodeCard?.($("#doCode"), j, save);  // which code applies here, and who at the AHJ confirmed it (dascode.js)
  dasJobMail(el, j);
  $("#doRetestMail")&&($("#doRetestMail").onclick=()=>{ const cs2=S.das.contacts||[], ro=d.contacts||{}, own=cs2.find(c=>String(c.id)===String(ro.owner)), me=cs2.find(c=>String(c.id)===String(ro.tech));
    $("#doMailPanel")?.scrollIntoView({behavior:"smooth", block:"nearest"});
    rfMail.compose($("#doMailBox"), {kind:"job", refs:{job_id:j.id, topic:"MAIL"}, title:"Book the annual retest", to:own?.email||"",
      subject:`Annual emergency radio coverage retest due ${d.retest_due}: ${j.name}`,
      body:`Hello${own?.name?` ${own.name.split(" ")[0]}`:""},\n\nThe emergency responder radio coverage system at ${j.name}${d.address?`, ${d.address}`:""} is due its annual test on ${d.retest_due}, which ${d.ahj||"the fire code official"} requires (IFC 510.6 / NFPA 1225).\n\nCould you reply with a few dates that work for access to every floor, the roof and the equipment room? The test takes about a day for most buildings, and you'll receive the report for the fire marshal afterwards.\n\nThank you,\n${me?[me.name, me.org, me.phone].filter(Boolean).join("\n"):""}`,
      onSent:()=>rfMail.thread($("#doMailThread"), {job:j.id})}); });
  $("#doGo").onclick=()=>{ const dd=j.data; if(dd.lat==null){ alert("Set the building's location first."); return; } $("#loc").value=`${dd.lat}, ${dd.lon}`; setMode("point"); setTab("map"); runSearch(); };
}

/* ---------- lifecycle (R2 K-3, C-4, C-9): after acceptance, what the system owes and when, each with its source. The
   dates are computed in das.py lifecycle from what's entered here; nothing is a deadline unless its source gives one ---------- */
const LIFE_STATE = {overdue:["overdue","var(--bad)"], due:["due soon","var(--warn)"], ok:["on track","var(--good)"], open:["to do","var(--warn)"], done:["done","var(--good)"], "n/a":["not yet","var(--muted)"]};
const dasAddMonths = (d, m) => { if(!d) return ""; const t=new Date(d+"T12:00:00"), day=t.getDate(); t.setDate(1); t.setMonth(t.getMonth()+m);
  t.setDate(Math.min(day, new Date(t.getFullYear(), t.getMonth()+1, 0).getDate())); return ymd(t); };
// what a job covers: public-safety ERCES and / or a commercial cellular DAS (das.py job_scope says the same): cellular
// when carriers are set; public safety when it has a channel plan, picked systems, licensee authorizations or
// consents, a public-safety reading, or no cellular part (an AHJ profile alone decides nothing) (lane H 11/4: a carrier-only job was given IFC 510 and UL 2524 dates)
// the channel plan of a list of systems: the Pre-survey's and Run it for me's (dasauto.js)
window.dasPlanOf=list=>{ const out=[]; for(const s of list) for(const c of s.down) out.push({system:s.licensee, call_sign:s.call_sign, service:s.service_name, trunked:s.trunked?"yes":"no",
    technology:s.tech.join(" / "), downlink_mhz:c.freq, uplink_mhz:(c.up||[]).join(" "), band:c.band, emission:c.emission||"", bandwidth_khz:c.bw_khz??"", best_outdoor_dbm:c.best_out??"", realistic_outdoor_dbm:s.real?.out_dbm??""}); return out; };
function dasScope(d){ d=d||{};
  const C=d.cellular||{}, ps=d.presurvey||{}, any=o=>!!o&&typeof o==="object"&&Object.keys(o).length>0;
  const said=d.guided?.answers?.scope, cell=["Cellular","Both"].includes(said)||any(C.profile)||any(C.donor)||any(C.approvals);  // das.py job_scope: Start's answer says it outright
  const psRead=Object.values((d.grid||{}).results||{}).some(r=>readingsOf(r).some(x=>!isCell(x)&&(has(x.dl)||has(x.daq)||has(x.sinr))))
    ||Object.values((d.grid||{}).critical||{}).some(r=>r&&(has(r.dl)||has(r.daq)));
  const sign=["Public safety radio","Both"].includes(said)||!!((ps.plan||[]).length||(ps.include||[]).length||((d.life||{}).auths||[]).length||Object.keys(d.consents||{}).length||psRead);
  return {ps:sign||!cell, cell};
}
function dasLifePanel(d, items){
  const L=d.life||{}, auths=L.auths||[], lic=DAS_LICENSEES.filter(x=>x.term_months), T=d.testing||{}, sc=dasScope(d);
  const rule=(items||[]).find(x=>x.ahj), rep=(items||[]).some(x=>x.key==="report");  // the AHJ's own rules (static/research/ahj_deadlines.json)
  const appr=(d.cellular||{}).approvals||{}, cars=Object.keys(appr).filter(c=>(appr[c]||{}).consent);
  return `<div class="panel" id="doLife"><h3>Lifecycle <span class="hint">· what the system owes after acceptance; each date from its source</span></h3>
    <p class="hint" style="margin:0 0 6px" id="doLifeAhj">${!sc.ps?"A carrier (commercial cellular) DAS: the IFC 510 / NFPA 1225 retests, UL 2524 and Part 90 registration don't apply. What it owes is each carrier's consent (47 CFR 20.21(c)) and terms, and the owner's maintenance."
      :rule?`AHJ rules: <b>${esc(rule.ahj)}</b>, from ${esc(rule.matched)}. Its report deadline and local rules are below, each with its source.`
      :"No AHJ filing window on file for this job's AHJ (Building › AHJ, or the profile under Requirements). OCSD, Seattle, Charleston, Clark County / Las Vegas, Douglas County CO, Denver and FDNY have one."}</p>
    ${(items||[]).map(x=>{ const [w,c]=LIFE_STATE[x.state]||[x.state,""]; return `<div class="row" style="justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:4px 0;gap:8px">
      <span>${esc(x.label)}${x.note?` <span class="hint">· ${esc(x.note)}</span>`:""}<div class="hint">${esc(x.source)}${x.url?` <a href="${esc(x.url)}" target="_blank" rel="noopener">source</a>`:""}</div></span>
      <span style="white-space:nowrap;text-align:right"><b style="color:${c}">${esc(w)}</b>${x.due?`<div class="mono">${esc(x.due)}${x.days!=null?` <span class="hint">(${x.days<0?`${-x.days} days ago`:`${x.days} days`})</span>`:""}</div>`:x.done?`<div class="mono hint">${esc(x.done)}</div>`:""}</span></div>`; }).join("")}
    ${sc.ps?`<div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px">
      <label title="The date of the most recent annual test: the next one is due a year on">Last annual test<input type="date" data-life="annual_last" value="${esc(L.annual_last||"")}"></label>
      <label title="NFPA 1225 20.3.10.2.3.3: a full quantitative retest at least every five years">Last five-year retest<input type="date" data-life="quant5_last" value="${esc(L.quant5_last||"")}"></label>
      <label title="The date you confirmed every active component is listed to UL 2524 3rd edition (UL 2524:2024)">UL 2524 3rd ed. confirmed<input type="date" data-life="ul2524_checked" value="${esc(L.ul2524_checked||"")}"></label>
      <label title="IFC 510.6.1 (2018, 2021 and 2024 editions): a structural change (an addition, a remodel) needs a retest">Addition / remodel on<input type="date" data-life="remodel" value="${esc(L.remodel||"")}"></label>
      <label title="Where the fire code official requires an operational permit (IFC 2024 510.3.2): the expiry date on it">Operational permit expires<input type="date" data-life="op_permit_expires" value="${esc(L.op_permit_expires||"")}"></label>
      ${rep||L.report_filed?`<label title="The date the latest test report was filed with the AHJ: it closes that report's deadline">Report filed with the AHJ<input type="date" data-life="report_filed" value="${esc(L.report_filed||"")}"></label>`:""}</div>`:""}
    ${sc.cell?`<h4 style="margin:10px 0 4px">Carriers <span class="hint">· from Pre-survey › Cellular carriers (consent given)</span></h4>
    ${cars.length?`<div class="tw"><table id="doCarLife"><thead><tr><th>Carrier</th><th>Consent</th><th>Consent renews</th><th>Carrier retest due</th></tr></thead><tbody>${cars.map(c=>`<tr data-car="${esc(c)}"><td>${esc(c)}</td><td class="mono">${esc(appr[c].consent)}</td>
      <td><input type="date" data-cl="renews" value="${esc(appr[c].renews||"")}" style="width:140px" title="Only if the carrier's letter gives one: 47 CFR 20.21(c) sets no term"></td>
      <td><input type="date" data-cl="retest_due" value="${esc(appr[c].retest_due||"")}" style="width:140px" title="Only if the carrier's agreement or consent asks for a retest"></td></tr>`).join("")}</tbody></table></div>`
      :'<p class="hint" style="margin:0">No carrier consent on file yet (Pre-survey › Cellular carriers).</p>'}
    <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:8px"><label title="The owner's maintenance or service agreement: its renewal date">Maintenance agreement renews<input type="date" data-life="maintenance_renews" value="${esc(L.maintenance_renews||"")}"></label></div>`:""}
    <h4 style="margin:10px 0 4px">Tester's certificates <span class="hint">· ${esc(T.tester||"the tester on Testing")}</span></h4>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <label title="NICET Policy 30: three years; Active Status ends on the first day of the expiration month printed on the certificate">NICET expires<input type="date" data-tc="nicet_expires" value="${esc(T.nicet_expires||"")}"></label>
      <label title="A certificate of in-building system training from the manufacturer or a recognized school (IFC 2021 510.5.3; Seattle CAM 5123)">Manufacturer certificate expires<input type="date" data-tc="mfr_expires" value="${esc(T.mfr_expires||"")}"></label>
      ${sc.ps?`<label title="FDNY ARCS testing: the B-03 Certificate of Fitness">FDNY B-03 expires<input type="date" data-tc="b03_expires" value="${esc(T.b03_expires||"")}"></label>`:""}</div>
    <p class="hint" style="margin:4px 0 0">An FCC GROL is issued for life (<a href="https://www.ecfr.gov/current/title-47/chapter-I/subchapter-A/part-13" target="_blank" rel="noopener">47 CFR 13.15</a>): it has no expiry to track. Each instrument's calibration (Testing) is tracked here too, ${DAS.cal_months} months from its date.</p>
    ${sc.ps?`<h4 style="margin:10px 0 4px">Licensee authorizations</h4>
    ${auths.length?`<div class="tw"><table><thead><tr><th>Licensee</th><th>Granted</th><th>Renews</th><th>Term</th><th></th></tr></thead><tbody>${auths.map((a,i)=>`<tr data-auth="${i}"><td>${esc(a.who||"")}</td><td><input type="date" data-af="granted" value="${esc(a.granted||"")}" style="width:140px"></td><td><input type="date" data-af="renews" value="${esc(a.renews||"")}" style="width:140px"></td><td class="hint" style="white-space:normal">${esc(a.term||"from the paper")}</td><td><button class="sm" data-adel="${i}" title="Remove this authorization">✕</button></td></tr>`).join("")}</tbody></table></div>`:'<p class="hint" style="margin:0">None on file.</p>'}
    <div class="row" style="margin-top:6px;gap:8px;flex-wrap:wrap;align-items:end"><label class="grow">Add <select id="doAuthWho"><option value="">Licensee…</option>${lic.map(x=>`<option value="${esc(x.who)}">${esc(x.who)} (${esc(x.term)})</option>`).join("")}<option value="other">Another licensee (enter the renewal date from its letter)</option></select></label>
      <input id="doAuthOther" placeholder="licensee name" style="display:none"><label>Granted<input type="date" id="doAuthDate"></label><button id="doAuthAdd">Add</button></div>
    <p class="hint" style="margin:4px 0 0">A term picked here comes from the research (Requirements, Licensee consent); with another licensee, type the renewal date from its letter. The code itself sets no renewal term.</p>`:""}</div>`;
}
function dasLifeWire(el, getJ, keep){
  const life=()=>({...((getJ().data||{}).life||{})});
  el.querySelectorAll("[data-life]").forEach(i=>i.onchange=()=>{ const d=getJ().data||{}, L={...life(), [i.dataset.life]:i.value}, patch={life:L};
    // the annual retest rolls from the latest annual test, not from acceptance (R2 K-3); retest_due feeds the board and the owner's reminder
    if(i.dataset.life==="annual_last"){ const base=[d.accepted_on, i.value].filter(Boolean).sort().pop(); if(base) patch.retest_due=addYear(base); }
    keep(patch); });
  // the tester's certificate expiries live with the tester's name and numbers (data.testing)
  el.querySelectorAll("[data-tc]").forEach(i=>i.onchange=()=>keep({testing:{...((getJ().data||{}).testing||{}), [i.dataset.tc]:i.value}}));
  el.querySelectorAll("#doCarLife [data-cl]").forEach(i=>i.onchange=()=>{ const C=(getJ().data||{}).cellular||{}, car=i.closest("tr").dataset.car, A={...(C.approvals||{})};
    A[car]={...(A[car]||{}), [i.dataset.cl]:i.value||null}; keep({cellular:{...C, approvals:A}}); });
  const auths=()=>[...(life().auths||[])];
  el.querySelectorAll("[data-auth] [data-af]").forEach(i=>i.onchange=()=>{ const k=+i.closest("[data-auth]").dataset.auth, A=auths(), a={...A[k], [i.dataset.af]:i.value};
    const t=DAS_LICENSEES.find(x=>x.who===a.who);
    if(i.dataset.af==="granted"&&t?.term_months) a.renews=dasAddMonths(i.value, t.term_months);
    A[k]=a; keep({life:{...life(), auths:A}}); });
  el.querySelectorAll("[data-adel]").forEach(b=>b.onclick=()=>{ const A=auths(); A.splice(+b.dataset.adel,1); keep({life:{...life(), auths:A}}); });
  const who=$("#doAuthWho"); if(!who) return;
  who.onchange=()=>{ $("#doAuthOther").style.display=who.value==="other"?"":"none"; };
  $("#doAuthAdd").onclick=()=>{ const g=$("#doAuthDate").value, w=who.value==="other"?$("#doAuthOther").value.trim():who.value;
    if(!w){ dasSay("Pick or name the licensee first."); return; }
    const t=DAS_LICENSEES.find(x=>x.who===w);
    keep({life:{...life(), auths:[...auths(), {who:w, granted:g, renews:t?.term_months&&g?dasAddMonths(g, t.term_months):"", term:t?`${t.term}, per the research`:"", source:t?.source||""}]}}); };
}

// a system's donor site: its strongest on the realistic estimate (coverage.presurvey_realistic), else its strongest on
// free space (a pre-survey saved before 11/4, or a system with no power on file)
const dasDonorSite = s => s.sites[s.real?.site ?? 0] || s.sites[0];
// a system's terrain path (from Terrain paths), when it was checked against today's donor site
function dasTerrainCell(s, t){
  const st=dasDonorSite(s); if(!t||!st||t.site!==`${st.lat},${st.lon}`) return "";
  if(t.error) return `<span class="hint">${esc(t.error)}</span>`;
  const word=t.status==="clear"?["clear","var(--good)"]:t.status.startsWith("Fresnel")?["partly blocked","var(--warn)"]:["blocked by terrain","var(--bad)"];
  // the detail shows under the word, not only on hover: a touch screen can't reach a hover tip (11/3)
  const why=`clearance ${t.clearance_f1} of the first Fresnel zone${t.worst_at_km!=null?`; worst point ${num(t.worst_at_km/1.609344,1)} mi from the site, ${t.worst_above_los_m} m above the line`:""}`;
  return `<span style="color:${word[1]}">${word[0]}</span>`
    + `${t.loss_db?` −${num(t.loss_db,0)} dB`:""}${t.status!=="clear"?`<div class="hint" style="white-space:normal;max-width:240px">${esc(why)}</div>`:""}`;
}
// Donor aiming (R1 #10): from the roof to the donor site, true and magnetic bearing (NOAA WMM2025, wmm.js), the elevation
// angle over the earth's curve (k = 4/3), distance, and the terrain clearance when Terrain paths has checked that path.
// Ground heights: the Terrain paths result first, else the licence's site elevation and the cached terrain at the building.
function dasAim(d, s, r, ps){
  const st=dasDonorSite(s); if(!st) return null;
  const t=(ps.terrain||{})[s.call_sign], tp=t&&!t.error&&t.site===`${st.lat},${st.lon}`?t:null;
  const roof=dasRoof(d), h=st.height_m??30, D=st.dist_mi*1609.344;
  const gSite=tp?tp.ground1_m:s.real?.site_ground_m, gB=tp?tp.ground2_m:r.real_model?.ground_m;
  const flat=gSite==null||gB==null, dh=flat ? h-roof : (gSite+h)-(gB+roof);  // site antenna above the roof antenna, metres
  const elev=D>0?(Math.atan2(dh, D)-D/(2*(4/3)*6371008.8))*180/Math.PI:null;
  const decl=window.WMM?WMM.declination(d.lat, d.lon, new Date()):null;
  return {st, true_deg:st.bearing, mag_deg:decl==null?null:((st.bearing-decl)%360+360)%360, decl, elev, flat, roof, h,
    ground:flat?"no ground heights: flat ground assumed (run ⛰ Terrain paths)":tp?"ground from Terrain paths (cached terrain)":"site ground from the licence, the building's from cached terrain",
    terrain:tp, real:s.real, sim:(s.down||[]).some(c=>(c.flags||[]).some(f=>f.startsWith("simulcast"))), lobe:s.real?.pattern_db};
}
const dasDeg = v => v==null?"–":`${num(v,0)}°`;
function dasDonorSheet(j, list, r, ps){
  const d=j.data||{};
  const rows=list.map(s=>[s, dasAim(d, s, r, ps)]).filter(([,a])=>a);
  const box=document.createElement("div"); box.className="panel";
  box.innerHTML=`<div style="padding:16px 8px;font-size:13px;line-height:1.45">
    <h2 style="margin:0 0 4px">Donor antenna aiming: ${esc(j.name)}</h2>
    <p style="margin:0 0 8px">${esc(d.address||"")} · building ${num(d.lat,5)}, ${num(d.lon,5)} · roof antenna about ${num(dasRoof(d),0)} m above ground (the building's height + a 3 m mast) · prepared ${esc(today())}</p>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4"><thead><tr><th>System</th><th>Donor site</th><th>Distance</th><th>True bearing</th><th>Magnetic bearing</th><th>Elevation angle</th><th>Terrain to the roof</th><th>Expected at the roof</th><th>Watch</th></tr></thead><tbody>
    ${rows.map(([s,a])=>`<tr><td><b>${esc(s.licensee)}</b><br><span class="mono">${esc(s.call_sign)}</span></td>
      <td>${esc(a.st.address||"")}<br><span class="mono">${num(a.st.lat,5)}, ${num(a.st.lon,5)}</span><br>antenna ${num(a.h,0)} m up${a.st.tower_reg?` · ASR ${esc(a.st.tower_reg)}`:""}</td>
      <td>${num(a.st.dist_mi,2)} mi<br>${num(a.st.dist_mi*1.609344,2)} km</td>
      <td><b>${dasDeg(a.true_deg)}</b> ${esc(a.st.compass||"")}</td>
      <td><b>${dasDeg(a.mag_deg)}</b>${a.decl!=null?`<br><span class="hint">declination ${num(Math.abs(a.decl),1)}° ${a.decl>=0?"E":"W"}</span>`:""}</td>
      <td><b>${a.elev==null?"–":`${a.elev>=0?"+":""}${num(a.elev,1)}°`}</b><br><span class="hint">${esc(a.ground)}</span></td>
      <td>${a.terrain?`${esc(a.terrain.status)}; clearance ${a.terrain.clearance_f1} of the first Fresnel zone${a.terrain.loss_db?`; −${num(a.terrain.loss_db,0)} dB`:""}`:"not checked: run ⛰ Terrain paths"}</td>
      <td>${a.real?`${num(a.real.out_dbm,0)} dBm street level (${esc(r.real_model?.name||"Hata")}); free space ${num(a.st.best_out,0)} dBm`:`${num(a.st.best_out,0)} dBm free space (best case)`}</td>
      <td>${[a.sim?"simulcast from several sites: aim at one, keep the delay low (TDI)":"", a.lobe!=null&&a.lobe<-3?`the building is ${num(-a.lobe,0)} dB off the site antenna's main beam (licensed azimuth)`:""].filter(Boolean).map(esc).join("<br>")||"–"}</td></tr>`).join("")}</tbody></table>
    <p class="hint" style="margin-top:8px">Bearings are from the building to the site. Magnetic = true − declination (NOAA World Magnetic Model 2025, for today's date): set a compass to the magnetic figure. The elevation angle is from the roof antenna to the site antenna, over the earth's curve (k = 4/3); within a degree, aim level and peak on the signal. Levels are estimates from licensed power, not measurements: confirm on the roof with a meter before fixing the mount.</p>
    ${dasCredits(d)}</div>`;
  dasPrintCopy(box);  // a copy goes on <body> to print, the way the AHJ report prints (box itself is never shown)
  return rows.length;
}
const dasBuildingLine = b => `${esc(b.name||"Building")} · ${(b.footprint_sqft||0).toLocaleString()} sq ft footprint${b.levels?` · ${b.levels} floors`:""}${b.height_m?` · ${Math.round(b.height_m)} m tall${b.height_est?` <span class="hint" title="${esc(b.height_source||"")}: machine-learned heights read low on tall buildings">(estimate)</span>`:""}`:""}`
  + `${b.contains_pin?"":` · nearest outline, ${b.dist_m} m from the pin`} · ${esc(b.source)} ${esc(b.osm||"")}${b.gers_id?` <span class="hint mono" title="Overture GERS id, release ${esc(b.release||b.overture_release||"")}">${esc(b.gers_id.slice(0,8))}</span>`:""}`
  + `${b.note?` · <i>${esc(b.note)}</i>`:""}`
  + `${b.footprint_sqft>DAS.sector_sqft?` · <b style="color:var(--warn)">over ${DAS.sector_sqft.toLocaleString()} sq ft a floor: NFPA 1225 splits each floor into sectors of ${DAS.grids} grids</b>`:""}`;
// the NSI's record of the building, as estimates with its source and caveat (nsi.py)
const dasNsiLine = n => `<b>NSI estimate</b>: ${esc([n.occupancy_label, n.stories?`${n.stories} stor${n.stories===1?"y":"ies"}`:"", n.sqft?`${Number(n.sqft).toLocaleString()} sq ft`:"",
    n.basement?"basement":n.foundation?`no basement (${n.foundation})`:"", n.year_built?`built about ${n.year_built}`:"", n.height_m?`${Math.round(n.height_m)} m tall`:"",
    n.people_day!=null?`about ${Number(n.people_day).toLocaleString()} people by day, ${Number(n.people_night||0).toLocaleString()} at night`:""].filter(Boolean).join(" · "))}`
  + `${(n.occupancy||[]).length>1?` <span title="${esc(n.occupancy.map(o=>`${o.label} (${o.code}): ${Number(o.sqft).toLocaleString()} sq ft`).join("; "))}">· ${n.occupancy.length} uses</span>`:""}`
  + `${n.inside_outline?"":` · nearest NSI structure, ${n.dist_m} m from the pin`} · ${esc(n.source)}, ${esc(n.fetched||"")}. <i>${esc(n.caveat)}</i>`;
// the donor antenna's height: the building's height (or floors x 3.5 m) plus a 3 m mast
const dasRoof = d => (d.building?.height_m || ((d.building?.levels || (Array.isArray(d.floors)?d.floors.length:0) || 3) * 3.5)) + 3;

// A channel's ⚠: a click opens what the warning means and what to do (Cody 11/3: the hover tip alone "doesn't show or
// do anything" on click). One pop-up at a time; Escape, a press outside or a scroll closes it.
const DAS_FLAGS = [
  { key: "simulcast", test: f => f.startsWith("simulcast"), title: f => `Simulcast from ${(f.match(/from (\d+) sites/)||[])[1]||"several"} sites`,
    means: "The agency sends this channel from several towers at the same moment. A booster that hears two or more passes them all, slightly out of step, and radios inside get garbled or dropped audio even with full bars: time delay interference (TDI). Digital (P25) suffers most.",
    todo: "Aim a directional donor antenna at one site, keep the booster's delay low, and ask the agency's radio shop which site to use: many simulcast systems set this.",
    note: "Counted from the licence: the channel is listed at more than one site. On a conventional licence these can be separate repeaters or receive-only sites rather than simulcast, so confirm with the agency." },
  { key: "esmr", test: f => f.startsWith("ESMR"), title: () => "Commercial ESMR band (862–869 MHz)",
    means: "This channel sits in the commercial ESMR band next to public safety 800 MHz. A public safety booster must keep that band out.",
    todo: "Leave it out of the booster's passband. If the agency still needs it covered inside, raise it with them." },
  { key: "band14", test: f => f.startsWith("FirstNet"), title: () => "FirstNet Band 14 (758–768 MHz)",
    means: "Band 14 is licensed to the FirstNet Authority, not to the agency (FCC renewal May 2023; the Authority's statutory term ends 22 Feb 2027 unless Congress extends it); AT&T runs the network. Its sites aren't in the FCC data.",
    todo: "Ask for written retransmission authorization before the booster passes Band 14: makers route the 'FirstNet Band 14 Retransmit Request Form' to FirstNetSpectrum.Manager@firstnet.gov, and some resellers say AT&T. Get it in writing from whichever answers, and keep it. Some AHJs (Broward, Douglas County) require Band 14 filtered out.",
    note: "Sources: CRS R48923 (29 Apr 2026) for the licence and its term; the request address is from a maker's manual (Nextivity), not a firstnet.gov page (R2 C-12)." },
];
function dasFlagPop(btn, sys){
  const old = document.getElementById("dasFlagPop");
  if(old){ old._close(); if(old._btn === btn) return; }  // a second click on the same ⚠ just closes it
  const c = sys.down[+btn.dataset.i], same = k => sys.down.filter(x => (x.flags||[]).some(k.test)).map(x => fmtF(x.freq));
  const pop = document.createElement("div");
  pop.id = "dasFlagPop"; pop.className = "das-flagpop"; pop.setAttribute("role", "dialog"); pop._btn = btn;
  pop.innerHTML = `<button type="button" class="x" aria-label="Close">×</button><div class="hint mono">${fmtF(c.freq)} MHz · ${esc(sys.call_sign)}</div>`
    + (c.flags||[]).map(f => { const k = DAS_FLAGS.find(k => k.test(f)); if(!k) return `<h4>⚠ ${esc(f)}</h4>`;
        const on = same(k);
        return `<h4>⚠ ${esc(k.title(f))}</h4><p>${esc(k.means)}</p><p><b>Do:</b> ${esc(k.todo)}</p>${k.note?`<p class="hint">${esc(k.note)}</p>`:""}`
          + (on.length > 1 ? `<p class="hint">${on.length} of this system's channels have it: <span class="mono">${on.map(esc).join(", ")}</span></p>` : ""); }).join("");
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  requestAnimationFrame(() => pop.classList.add("on"));
  btn.setAttribute("aria-expanded", "true");
  const down = e => { if(!pop.contains(e.target) && e.target !== btn) close(); };
  const key = e => { if(e.key === "Escape"){ close(); btn.focus(); } };
  const scroll = e => { if(!pop.contains(e.target)) close(); };
  function close(){ pop.remove(); btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key); removeEventListener("scroll", scroll, true); removeEventListener("resize", close); }
  pop._close = close;
  pop.querySelector(".x").onclick = close;
  document.addEventListener("pointerdown", down, true); document.addEventListener("keydown", key); addEventListener("scroll", scroll, true); addEventListener("resize", close);
}

/* The pin drives every location step, and an address is only text until something ties the two. A taken suggestion moves
   the pin (dasOverview); this catches the rest: an address typed and left, or a job from before 11/5. Only a street number
   the lookup finds again is judged, so a vaguer address or no signal says nothing rather than guessing. */
async function dasPinCheck(box, j, move){
  const d=j.data||{}, a=(d.address||"").trim(), no=(a.match(/^\d+[a-z]?\b/i)||[])[0];
  if(!box||d.lat==null||d.lon==null||!no) return;
  let r; try{ r=await api(`/api/geocode?q=${encodeURIComponent(a)}&lat=${d.lat}&lon=${d.lon}`); }catch(e){ return; }
  if(!box.isConnected) return;
  const zip=(a.match(/\b\d{5}\b/)||[])[0], hit=(r.results||[]).find(x=>x.kind==="address"&&x.lat!=null&&(x.full||"").startsWith(no+" ")&&(!zip||x.full.includes(zip)));
  if(!hit) return;
  const mi=geoMi(d.lat,d.lon,hit.lat,hit.lon); if(mi<1) return;
  box.innerHTML=`<div class="das-pinwarn" role="status"><span>The pin is <b>${num(mi,mi<10?1:0)} mi</b> from this address, and every step here runs from the pin.</span> <button class="sm" type="button">Move the pin to ${esc(hit.full)}</button></div>`;
  box.querySelector("button").onclick=()=>move(hit);
}

/* ---------- pre-survey: the agency systems serving the building ---------- */
async function dasPresurvey(el, j, save){
  const d=j.data||{}, ps=d.presurvey||{};
  if(d.lat==null){ el.innerHTML='<p class="status">Set the building\'s location on the Overview first (Use current pin).</p>'; return; }
  // the estimate needs a level to compare with even when the AHJ judges by DAQ alone: -95 dBm is the usual design floor
  // building loss: picked or typed, else the building's own ITU-R P.2109 entry loss (das.building_entry_loss, from its NSI year and size)
  const lossAuto=ps.loss_auto===true||(ps.loss==null&&DAS.loss[d.construction]==null);
  const P={radius:ps.radius||15, loss:lossAuto?null:(ps.loss??DAS.loss[d.construction]??14), loss_auto:lossAuto, threshold:ps.threshold||DASJ.threshold||-95, env:ps.env||"suburban"};
  el.innerHTML='<p class="status">Finding the public safety systems around the building…</p>';
  let r; try{ r=await api(`/api/das/presurvey?lat=${d.lat}&lon=${d.lon}&radius=${P.radius}&${P.loss==null?`job=${j.id}`:`loss=${P.loss}`}&threshold=${P.threshold}&env=${P.env}`); if(P.loss==null) P.loss=r.loss_db; }
  catch(e){ if(!el.isConnected) return; el.innerHTML=`<p class="status err">${esc(e.message)}</p><div id="psCell" style="margin-top:10px"></div>`; window.dasCellPresurvey?.($("#psCell"), j, save); return; }  // the carriers need no FCC data
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const inc=new Set(ps.include||[]), any=inc.size>0;
  const chosen=r.systems.filter(s=>inc.has(s.call_sign));
  // The verdict uses the realistic estimate (R1 #1: on free space it never fired): Hata + terrain where cached, from
  // coverage.presurvey_realistic. Free space stays beside it as the best case. A system with no power on file has neither.
  const RM=r.real_model, realOf=s=>s.real||null, declHere=window.WMM?WMM.declination(d.lat, d.lon, new Date()):null;  // NOAA WMM2025, once for the building
  const scoredS=chosen.filter(s=>realOf(s)), need=scoredS.filter(s=>realOf(s).margin_db<0).length, needFs=chosen.filter(s=>s.margin_db!=null&&s.margin_db<0).length;
  const verdict=!any?"Tick the systems the AHJ requires (usually fire, police and EMS) to build the channel plan."
    : !RM?(needFs?`${needFs} of ${chosen.length} chosen systems likely below ${P.threshold} dBm inside (free space, best case): an ERCES is likely needed.`:`All ${chosen.length} chosen systems clear ${P.threshold} dBm inside on the free-space estimate (best case): a walk test decides.`)
    : need?`${need} of ${scoredS.length} chosen system${scoredS.length===1?"":"s"} likely below ${P.threshold} dBm inside on the realistic estimate (${RM.name}, ${P.loss} dB building loss): an ERCES is likely needed. It is an estimate: a walk test decides. On free space (best case) ${needFs||"none"} would be.`
    : `All ${scoredS.length} chosen systems clear ${P.threshold} dBm inside on the realistic estimate (${RM.name}, ${P.loss} dB building loss). An estimate, pessimistic for upper floors: a walk test decides.`;
  const planOf=window.dasPlanOf;
  const plan=planOf(chosen);
  // every channel is in the page: past six they fold, and Ctrl+F and the Find box both reach them. Cut to six with a "+13",
  // a customer's own control channel couldn't be found on screen (11/4 demo: 852.3625, 9th of 19)
  const psCh=f=>`<span data-ch="${fmtF(f)}">${fmtF(f)}</span>`;
  const psFold=(list,cell)=>list.slice(0,6).map((c,i)=>cell(c,i)).join("<br>")+(list.length>6?`<details class="ps-more"><summary class="hint">+${list.length-6} more</summary>${list.slice(6).map((c,i)=>cell(c,i+6)).join("<br>")}</details>`:"");
  const psTier={1:"Government trunked and 700/800 MHz systems",2:"Other agency trunked and 700/800 MHz systems",3:"Other agency systems",4:"Other public safety licences"};
  const psHead=(s,i)=>s.tier&&s.tier!==r.systems[i-1]?.tier?`<tr class="ps-tier"><td colspan="14"><b>${psTier[s.tier]}</b> <span class="hint">· ${r.systems.filter(x=>x.tier===s.tier).length}</span></td></tr>`:"";
  const bands=new Map(); for(const p of plan){ for(const f of [p.downlink_mhz, ...String(p.uplink_mhz).split(" ").filter(Boolean).map(Number)]){ const b=dasBand(f); const x=bands.get(b)||{lo:1e9,hi:0,set:new Set()}; x.lo=Math.min(x.lo,f); x.hi=Math.max(x.hi,f); x.set.add(f); x.n=x.set.size; bands.set(b,x); } }
  el.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Within <input id="psR" type="number" value="${P.radius}" min="1" max="60" style="width:70px"> mi</label>
      <label class="inl" title="Building entry loss: ITU-R P.2109-2 (outer wall only), or a whole large building measured at 750 MHz (NIST TN 1552)">Building loss <select id="psLp" style="max-width:270px"><option value="">custom</option><option value="auto" ${P.loss_auto?"selected":""}>ITU-R P.2109 for this building (year, size)</option>${Object.entries(DAS.loss).map(([k,v2])=>`<option value="${v2}" ${!P.loss_auto&&+P.loss===v2?"selected":""} title="${esc(DAS.lossNote[k]||"")}">${esc(k)}</option>`).join("")}</select>${!P.loss_auto&&+P.loss===90?`<span class="hint">${esc(DAS.lossNote["Subterranean / garage below grade (NIST TN 1552 upper medians: 90 dB)"])}</span>`:""}
        <input id="psL" type="number" value="${P.loss}" min="0" max="120" style="width:64px"> dB</label>
      <label class="inl" title="The realistic estimate's land type (Okumura-Hata): urban is the most loss, open land the least">Realistic as <select id="psEnv">${[["urban","Hata urban"],["suburban","Hata suburban"],["open","Hata open land"]].map(([k,l])=>`<option value="${k}" ${P.env===k?"selected":""}>${l}</option>`).join("")}</select></label>
      <label class="inl">Needs at least <input id="psT" type="number" value="${P.threshold}" style="width:80px"> dBm inside</label>
      <button id="psPick">Tick fire, police, EMS, 911</button><button id="psNone">Untick all</button><button id="psToCell" title="AT&T, T-Mobile and Verizon here: coverage, closest site and the spectrum each holds, below the public safety list">Cellular carriers ↓</button>
      <button id="psTer" title="Line of sight from each system's donor site to the roof, with the loss over hills (terrain data, cached on this PC once fetched). Ticked systems, or the 20 strongest.">⛰ Terrain paths</button>
      <button id="psAim" ${(any?chosen:r.systems).length?"":"disabled"} title="For each chosen system's donor site: true and magnetic bearing, elevation angle, distance and terrain clearance; print or save as PDF">⎙ Donor aiming sheet</button>
      <button id="psPlan" ${plan.length?"":"disabled"}>⇩ Channel plan CSV</button><button id="psCsv">⇩ Systems CSV</button><button id="psKml">⇩ KML</button><button id="psTak">⇩ ATAK</button>
      <button id="psLet" ${chosen.length?"":"disabled"} title="One letter per licensee asking consent to retransmit (47 CFR 90.219(b)(1)); print or save as PDF">⎙ Consent letters</button>${window.rfMail?`<button id="psLetMail" ${chosen.length?"":"disabled"} title="Email each licensee the consent request from your own mailbox; the reply files itself">✉ Email them</button>`:""}</div><div id="psLetMailBox"></div>
    <p style="margin:2px 2px 10px"><b>${r.systems.length}</b> public safety systems within ${P.radius} mi of the job's pin <span class="mono hint">${num(d.lat,5)}, ${num(d.lon,5)}</span>. ${esc(verdict)}</p><div id="psPinChk"></div>
    ${r.entry_loss?`<p class="hint" id="psEntry" style="margin:-6px 2px 10px">Building loss <b>${num(r.entry_loss.db,0)} dB</b>, ${esc(r.entry_loss.model)}: ${esc(r.entry_loss.parts.map(p=>`${num(p[0],0)} dB ${p[1]}`).join(" + "))}. Basis: ${r.entry_loss.basis==="NSI"?"the NSI record (Overview, Look up building)":"the building's type and size; Look up building (Overview) adds its year"}. <a href="${esc(r.entry_loss.source)}" target="_blank" rel="noopener">ITU-R P.2109-2</a></p>`:""}
    <div class="grid2" style="margin-top:0;align-items:stretch">
      <div class="panel"><h3>Bands a booster must pass <span class="hint">· chosen systems, downlink and uplink</span></h3>${bands.size?`<table><thead><tr><th>Band</th><th>From MHz</th><th>To MHz</th><th class="n">Channels</th></tr></thead><tbody>${[...bands].sort((a,b)=>a[1].lo-b[1].lo).map(([b,x])=>`<tr><td>${esc(b)}</td><td class="mono">${fmtF(x.lo)}</td><td class="mono">${fmtF(x.hi)}</td><td class="n">${x.n}</td></tr>`).join("")}</tbody></table>
        <p class="hint">Class A (channelized): every passband 75 kHz or less, one filter per channel. Class B (wideband): passes each band's whole span and must be registered with the FCC; keep commercial ESMR (862–869 MHz) out of it. FirstNet (${esc(r.firstnet.band)}: ${r.firstnet.down.join("–")} MHz down, ${r.firstnet.up.join("–")} MHz up) is licensed to the FirstNet Authority (AT&amp;T runs it): its written retransmission authorization is needed, and it isn't in FCC site data. ⚠ marks channels to check: ESMR, Band 14, or simulcast from several sites (delay / TDI). Click one for what it means.</p>
        <div id="psBoost"></div>`:'<p class="hint">Tick systems below.</p>'}</div>
      <div class="panel" style="padding:0;overflow:hidden;display:flex;min-height:300px"><div id="psMap" style="flex:1;min-height:300px"></div></div></div>
    <div class="panel" style="margin-top:10px"><h3>Systems <span class="hint">· government trunked and 700/800 MHz systems first, then other agencies; trunked first, then strongest on free space · each level is an estimate from licensed power, not a measurement</span></h3>
      ${(()=>{ const fd=ps.federal||{}; return `<div class="status" id="psFed" style="margin:0 0 8px"><b>Federal systems are not on this list.</b> It comes from FCC licences. Federal radio (military, VA police, federal courts and agencies) is assigned through NTIA, so an empty list proves nothing on federal land or with a federal tenant or responder.
        <div class="row no-print" style="margin-top:6px;align-items:center;gap:10px;flex-wrap:wrap"><label class="inl">Federal systems here? <select id="psFedState"><option value="">Not asked yet</option><option value="none" ${fd.state==="none"?"selected":""}>Asked: none serve this building</option><option value="yes" ${fd.state==="yes"?"selected":""}>Yes: they serve this building</option></select></label>
          <label class="inl">Who said so <input id="psFedNote" value="${esc(fd.note||"")}" placeholder="Name, office, date" style="width:260px;max-width:100%"></label></div>
        ${fd.state==="yes"?`<p class="hint" style="margin:6px 0 0">On a base, ask the installation spectrum manager; at a civil site, the agency's security or telecom office. Get the retransmission answer in writing, and sweep federal bands only with written permission.</p>`:""}</div>`; })()}
      <div class="row no-print" style="margin:0 0 6px;align-items:center"><label class="inl">Find <input id="psFind" type="search" value="${esc(S.das.psFind||"")}" placeholder="Channel, call sign or agency, e.g. 852.3625" style="width:300px"></label><span class="hint" id="psFindN"></span></div>
      ${RM?`<p class="hint" style="margin:0 0 6px"><b>Realistic</b>: ${esc(RM.desc)} <b>Free space</b>: the best case, no terrain, no clutter.</p>`:""}
      <div class="tw" style="max-height:60vh"><table><thead><tr><th></th><th>Agency</th><th>Call sign</th><th>Type</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Donor site</th><th class="n" title="${esc(RM?.desc||"")}">Outside dBm<div class="hint">realistic</div></th><th class="n">Inside dBm<div class="hint">realistic</div></th><th class="n">Margin dB<div class="hint">realistic</div></th><th class="n" title="Free space, best case">Outside dBm<div class="hint">free space</div></th><th class="n">Inside dBm<div class="hint">free space</div></th><th class="n">Margin dB<div class="hint">free space</div></th><th>Terrain to the roof</th></tr></thead><tbody>
      ${r.systems.map((s,si)=>{ const st=dasDonorSite(s), rl=realOf(s), mc=m=>m==null?"":m<0?"var(--bad)":m<10?"var(--warn)":"var(--good)", decl=st?declHere:null; return `${psHead(s,si)}<tr data-find="${esc([s.licensee,s.call_sign,s.service_name,...s.down.map(c=>fmtF(c.freq)),...s.up.map(fmtF)].join(" ").toLowerCase())}"><td><input type="checkbox" data-cs="${esc(s.call_sign)}" ${inc.has(s.call_sign)?"checked":""}></td><td style="white-space:normal;min-width:170px;max-width:260px"><b>${esc(s.licensee)}</b><div class="hint">${esc(s.category||"")}</div></td>
        <td class="mono">${s.usi?`<a href="https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${s.usi}" target="_blank" rel="noopener">${esc(s.call_sign)}</a>`:esc(s.call_sign)}</td>
        <td>${esc(s.trunked?"Trunked":"Conventional")} · ${esc(s.tech.join(", "))}<div class="hint">${esc(s.service_name||"")}</div></td>
        <td class="mono">${psFold(s.down,(c,i)=>`${psCh(c.freq)}${(c.flags||[]).length?` <button type="button" class="das-flag" data-flag-cs="${esc(s.call_sign)}" data-i="${i}" title="${esc(c.flags.join("; "))} (click for what it means)" aria-haspopup="dialog" aria-expanded="false">⚠</button>`:""}`)}</td>
        <td class="mono">${psFold(s.up,psCh)||'<span class="hint">ask licensee</span>'}
          <div class="hint" style="font-family:var(--font)">${esc([...new Set(s.down.map(c=>c.up_src).filter(Boolean))].join(", "))}</div></td>
        <td>${st?`${num(st.dist_mi,2)} mi ${esc(st.compass)} (${st.bearing}° true${decl!=null?`, ${num(((st.bearing-decl)%360+360)%360,0)}° magnetic`:""})<div class="hint">${s.n_sites} site${s.n_sites===1?"":"s"}${rl&&rl.site?" · strongest realistic, not on free space":""} · <a href="#" data-aim="${esc(s.call_sign)}" title="Print this system's donor aiming sheet: true and magnetic bearing, elevation angle, terrain">⎙ aim</a></div>`:""}</td>
        <td class="n" title="${rl?esc(`${rl.freq} MHz · Hata ${rl.hata_db} dB path loss, effective height ${rl.hb_m} m (${rl.hb_src})${rl.pattern_db?`, ${rl.pattern_db} dB off the antenna's beam`:""}; terrain ${rl.terrain}${rl.terrain_db?` −${rl.terrain_db} dB`:""}${rl.note?`; ${rl.note}`:""}`):"no power on file"}">${rl?num(rl.out_dbm,0):"–"}${rl?.note?' <span class="hint">~</span>':""}</td>
        <td class="n">${rl?num(rl.in_dbm,0):"–"}</td><td class="n" style="color:${mc(rl?.margin_db)}"><b>${rl?num(rl.margin_db,0):"–"}</b></td>
        <td class="n hint">${num(s.best_out,0)}</td><td class="n hint">${num(s.best_in,0)}</td><td class="n" style="color:${mc(s.margin_db)}">${num(s.margin_db,0)}</td>
        <td>${dasTerrainCell(s, (ps.terrain||{})[s.call_sign])}</td></tr>`; }).join("")}</tbody></table></div>
      <p class="hint">Downlink: what the agency's sites transmit (the building's donor antenna hears it). Uplink: what the radios transmit, from each licence's mobile entries, or the fixed 800 MHz (−45 MHz) and 700 MHz (+30 MHz) offsets. Bearing is from the building to the site (magnetic from NOAA's WMM2025): point the donor antenna there. The donor site is the strongest on the realistic estimate; ~ marks a level outside Hata's tested range (below 150 MHz, or under 1 km), so rougher.</p></div>
    <div id="psX" style="margin-top:10px"></div>
    <div id="psCell" style="margin-top:10px"></div>`;
  window.dasCellPresurvey?.($("#psCell"), j, save);  // the commercial carriers here (dascell.js)
  $("#psToCell").onclick=()=>$("#psCell").scrollIntoView({behavior:"smooth", block:"start"});
  dasPinCheck($("#psPinChk"), j, async hit=>{ j=await save({lat:hit.lat,lon:hit.lon}); dasPresurvey(el, j, save); });
  { const box=$("#psFind"), rows=[...el.querySelectorAll("tr[data-find]")], heads=[...el.querySelectorAll("tr.ps-tier")];
    const go=()=>{ const q=box.value.trim().toLowerCase(); S.das.psFind=box.value; let n=0;
      rows.forEach(tr=>{ const on=!q||tr.dataset.find.includes(q); tr.style.display=on?"":"none"; n+=on?1:0;
        tr.querySelectorAll("[data-ch]").forEach(c=>c.classList.toggle("ps-hit", !!q&&c.dataset.ch.includes(q)));
        tr.querySelectorAll("details.ps-more").forEach(x=>{ x.open=!!x.querySelector(".ps-hit"); }); });
      heads.forEach(t=>{ t.style.display=q?"none":""; }); $("#psFindN").textContent=q?`${n} of ${rows.length} systems`:""; };
    box.oninput=go; if(box.value) go(); }
  window.dasPresurveyX?.($("#psX"), j, save, r, chosen);  // passband licensees and consent, licence watch, tunnels (dasx.js)
  // the chosen systems' channel plan is saved with the job, so the AHJ report and exports have it without the FCC data
  const store=async patch=>{ const incl=new Set(patch.include??[...inc]);
    j=await save({presurvey:{...(j.data.presurvey||{}),...P,...patch, plan:planOf(r.systems.filter(s=>incl.has(s.call_sign)))}}); dasPresurvey(el, j, save); };
  $("#psFedState").onchange=e=>store({federal:{...(ps.federal||{}), state:e.target.value}});
  $("#psFedNote").onchange=e=>store({federal:{...(ps.federal||{}), note:e.target.value}});
  $("#psLet").onclick=async()=>{ await window.dasConsentPrefetch?.(chosen); dasConsent(j, chosen); };  // addressed from each licence's FCC contact
  $("#psAim").onclick=()=>dasDonorSheet(j, (any?chosen:r.systems.slice(0,10)).filter(s=>s.sites[0]), r, ps);
  el.querySelectorAll("[data-aim]").forEach(b=>b.onclick=e=>{ e.preventDefault(); dasDonorSheet(j, r.systems.filter(s=>s.call_sign===b.dataset.aim), r, ps); });
  $("#psEnv").onchange=e=>{ P.env=e.target.value; store({}); };
  $("#psLetMail")&&($("#psLetMail").onclick=async()=>{ await window.dasConsentPrefetch?.(chosen); dasConsentMail($("#psLetMailBox"), j, chosen); });
  el.querySelectorAll("[data-flag-cs]").forEach(b=>b.onclick=()=>dasFlagPop(b, r.systems.find(s=>s.call_sign===b.dataset.flagCs)));
  el.querySelectorAll("[data-cs]").forEach(c=>c.onchange=()=>{ c.checked?inc.add(c.dataset.cs):inc.delete(c.dataset.cs); store({include:[...inc]}); });
  { const t=el.querySelector("[data-cs]")?.closest("table");  // All / None in the table's first column: one save
    if(t) window.rfChecks?.(t, {sel:"[data-cs]", fold:false, word:"chosen", head:t.querySelector("thead th"),
      commit:boxes=>{ boxes.forEach(c=>c.checked?inc.add(c.dataset.cs):inc.delete(c.dataset.cs)); store({include:[...inc]}); }}); }
  // the agencies an ERCES is for: fire, EMS, police, 911 and emergency management (not every government radio user)
  // whole words in the licensee's name (the importer's categories also match "Firebird" and "Marshall Academy"), plus
  // the county / city / state trunked systems most fire departments actually talk on
  $("#psPick").onclick=()=>{ for(const s of r.systems){ const n=s.licensee||"";
      if(/\b(FIRE|POLICE|SHERIFF|SHERIFF'S|RESCUE|EMS|911|E911|EMERGENCY COMMUNICATIONS|EMERGENCY MANAGEMENT|PUBLIC SAFETY)\b/i.test(n)
        ||(s.trunked&&/\b(COUNTY|CITY|STATE|COMMONWEALTH|TOWN|DISTRICT OF COLUMBIA|PARISH|BOROUGH)\b/i.test(n))) inc.add(s.call_sign); }
    store({include:[...inc]}); };
  $("#psNone").onclick=()=>store({include:[]});
  $("#psTer").onclick=async()=>{ const list=(inc.size?chosen:r.systems.slice(0,20)).filter(s=>dasDonorSite(s));
    const b=$("#psTer"); b.disabled=true; b.textContent="⛰ Checking paths…";
    try{ const res=await post("/api/das/terrain",{lat:d.lat, lon:d.lon, roof_m:dasRoof(d), sites:list.map(s=>({key:s.call_sign, lat:dasDonorSite(s).lat, lon:dasDonorSite(s).lon,
        height_m:dasDonorSite(s).height_m, freq:s.real?.freq||s.down[0]?.freq}))});
      const terrain={...(ps.terrain||{})};
      for(const s of list){ const x=res.paths[s.call_sign], st=dasDonorSite(s); if(x) terrain[s.call_sign]={...x, site:`${st.lat},${st.lon}`, roof_m:dasRoof(d)}; }
      store({terrain}); }catch(e){ b.disabled=false; b.textContent="⛰ Terrain paths"; alert(e.message); } };
  for(const [id,k] of [["#psR","radius"],["#psL","loss"],["#psT","threshold"]]) $(id).onchange=e=>{ P[k]=+e.target.value; if(k==="loss") P.loss_auto=false; store({}); };
  $("#psLp").onchange=e=>{ if(e.target.value==="auto"){ P.loss_auto=true; store({}); } else if(e.target.value!==""){ P.loss=+e.target.value; P.loss_auto=false; store({}); } };
  $("#psPlan").onclick=()=>dasDl(`${fileSafe(j.name)} channel plan.csv`, csvOf(plan), "text/csv");
  // boosters whose FCC grants take in every chosen channel, down and up (fccid.boosters_for), by booster class and power
  const byBand=[...bands].sort((a,b)=>a[1].lo-b[1].lo).map(([name,x])=>`band=${encodeURIComponent(name+"|"+[...x.set].join(","))}`);
  const pref=(k,d)=>{ try{ return localStorage.getItem(k)??d; }catch(e){ return d; } }, keepPref=(k,v)=>{ try{ localStorage.setItem(k,v); }catch(e){ /* storage blocked (a private window): not remembered, nothing else lost */ } };
  const CLS={"B9A,B9B":"Part 90 boosters (Class A or B)", "B9A":"Part 90 Class A (channelized)", "B9B":"Part 90 Class B (wideband)", "B2I,B2P,B2W":"Part 20 (cellular) boosters", "":"any device kept"};
  const short=cs=>[...new Set((cs||[]).map(c=>({B9A:"Class A", B9B:"Class B", B2I:"Part 20", B2P:"Part 20", B2W:"Part 20", BOS:"other booster"})[c]).filter(Boolean))].join(" / ");
  const boost=()=>{ const cls=pref("rfr.boostCls","B9A,B9B"), w=pref("rfr.boostW","");
    api(`/api/fccid/boosters?${byBand.join("&")}&cls=${encodeURIComponent(cls)}&watts=${encodeURIComponent(w)}`).then(b=>{ const box=$("#psBoost"), kept=b.kept||{}; if(!box?.isConnected) return;
      if(!kept.devices){ box.innerHTML=`<p class="hint" style="margin:8px 0 0">No FCC booster grants are kept on this copy, so boosters can't be matched to these channels.</p>`; return; }  // it vanished with no word (11/3)
      const bandTxt=bs=>bs.slice(0,8).map(([lo,hi])=>lo===hi?`${+lo}`:`${+lo}–${+hi}`).join(", ")+(bs.length>8?` +${bs.length-8}`:"");
      const dev=x=>`<a href="${esc(x.view)}" target="_blank" rel="noopener" class="mono" title="${esc(bandTxt(x.bands))} MHz · granted ${esc(x.granted)}">${esc(x.fcc_id)}</a> <span class="hint">${esc([x.maker, short(x.classes), wattsTxt(x)].filter(Boolean).join(" · "))}</span>`;
      box.innerHTML=`<h3 style="margin:12px 0 4px">Boosters granted for these channels <span class="hint">· newest grant first</span></h3>
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap;margin:2px 0 6px"><select id="pbCls">${Object.entries(CLS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("")}</select>
          <label class="inl">strongest band at least <select id="pbW"><option value="">any power</option>${[0.5,1,2,5,10].map(v=>`<option value="${v}">${v} W</option>`).join("")}</select></label></div>
        ${b.count?`<p style="margin:4px 0">${b.count} granted for every band here, the newest: ${b.devices.slice(0,6).map(dev).join(", ")}</p>`
          :`<p class="hint" style="margin:4px 0">None is granted for all ${b.by_band.length} bands: a multi-band system takes one unit (or module) per band, or per band group.</p>`}
        <div class="tw"><table><thead><tr><th>Band</th><th class="n">Granted for all its channels</th><th>Newest</th></tr></thead><tbody>${b.by_band.map(x=>`<tr><td>${esc(x.band)}</td><td class="n">${x.count}</td><td>${x.devices.slice(0,3).map(dev).join("<br>")||'<span class="hint">none</span>'}</td></tr>`).join("")}</tbody></table></div>
        <p class="hint">From the FCC's grant search (${esc(kept.at||"")}): ${kept.devices.toLocaleString()} devices of ${(kept.makers||0).toLocaleString()} makers, every signal booster by class, and power ranges for Part 90 boosters (the range of each one's strongest band). A grant shows what a device is certified for, not that it suits this building: exact watts per band are on each device's FCC grant (its FCC ID opens it; point at it for its bands).</p>`;
      $("#pbCls").value=cls; $("#pbW").value=w;
      $("#pbCls").onchange=e=>{ keepPref("rfr.boostCls", e.target.value); boost(); };
      $("#pbW").onchange=e=>{ keepPref("rfr.boostW", e.target.value); boost(); }; }).catch(e=>{ const box=$("#psBoost"); if(box?.isConnected) box.innerHTML=`<p class="hint" style="margin:8px 0 0">Booster grants couldn't be read: ${esc(e.message)}</p>`; }); };
  if(byBand.length) boost();
  const sysRows=()=>r.systems.map(s=>({included:inc.has(s.call_sign)?"yes":"", agency:s.licensee, call_sign:s.call_sign, service:s.service_name, category:s.category, trunked:s.trunked?"yes":"no",
    technology:s.tech.join(" / "), downlink_mhz:s.down.map(c=>c.freq).join(" "), uplink_mhz:s.up.join(" "), best_site_mi:s.sites[0]?.dist_mi, bearing_deg:s.sites[0]?.bearing,
    outdoor_dbm:s.best_out, indoor_dbm:s.best_in, margin_db:s.margin_db,
    realistic_site_mi:s.real?dasDonorSite(s)?.dist_mi:"", realistic_outdoor_dbm:s.real?.out_dbm??"", realistic_indoor_dbm:s.real?.in_dbm??"", realistic_margin_db:s.real?.margin_db??"",
    realistic_model:s.real?`${RM?.name||""}; terrain ${s.real.terrain}`:""}));
  $("#psCsv").onclick=()=>dasDl(`${fileSafe(j.name)} pre-survey.csv`, csvOf(sysRows()), "text/csv");
  const siteRows=()=>{ const out=[]; for(const s of (inc.size?chosen:r.systems)) for(const st of s.sites) out.push({layer:"uls", lat:st.lat, lon:st.lon, dist_mi:st.dist_mi, compass:st.compass, freq_mhz:st.freqs[0],
    licensee:s.licensee, call_sign:s.call_sign, label:s.licensee, sig_type:s.tech[0]||"Unknown", est_rx_dbm:st.best_out}); return out; };
  $("#psKml").onclick=()=>{ const x=s=>String(s??"").replace(/[<>&'"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;",'"':"&quot;"}[c]));
    const pm=siteRows().map(s=>`<Placemark><name>${x(s.licensee)} ${x(s.call_sign)}</name><description>${x(`${s.dist_mi} mi ${s.compass}, est ${num(s.est_rx_dbm,0)} dBm outside`)}</description><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`
      +`<Placemark><name>Donor bearing to ${x(s.call_sign)}</name><LineString><coordinates>${d.lon},${d.lat},0 ${s.lon},${s.lat},0</coordinates></LineString></Placemark>`).join("");
    const ol=d.building?.outline?`<Placemark><name>${x(j.name)} outline</name><Polygon><outerBoundaryIs><LinearRing><coordinates>${d.building.outline.map(([a,b])=>`${b},${a},0`).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`:"";
    dasDl(`${fileSafe(j.name)} pre-survey.kml`, `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(j.name)} pre-survey</name><Placemark><name>${x(j.name)}</name><Point><coordinates>${d.lon},${d.lat},0</coordinates></Point></Placemark>${ol}${pm}</Document></kml>`, "application/vnd.google-earth.kml+xml"); };
  // ATAK: each donor site's marker says where to aim (true / magnetic bearing and elevation from the roof)
  const takRows=()=>{ const aims=new Map(); for(const s of (inc.size?chosen:r.systems)){ const a=dasAim(d, s, r, ps); if(a) aims.set(`${s.call_sign}|${a.st.lat},${a.st.lon}`, a); }
    return siteRows().map(x=>{ const a=aims.get(`${x.call_sign}|${x.lat},${x.lon}`);
      return a?{...x, licensee:`${x.licensee} · donor: aim ${dasDeg(a.true_deg)} true${a.mag_deg!=null?` / ${dasDeg(a.mag_deg)} magnetic`:""}${a.elev!=null?`, ${a.elev>=0?"+":""}${num(a.elev,1)}° up`:""} from the roof`}:x; }); };
  $("#psTak").onclick=()=>RFTak.save({rows:takRows(), center:[d.lat,d.lon], radius:P.radius, name:`RF Recon - ${j.name} pre-survey`, colorOf, typeOf, fccDate:null,
    outline:d.building?.outline?{name:`${j.name} outline`, points:d.building.outline}:null});
  if(typeof L!=="undefined"){ const map=L.map("psMap",{preferCanvas:true}); addMapLayers(map); L.marker([d.lat,d.lon],{icon:pinIcon(),title:j.name}).addTo(map);
    if(d.building?.outline) L.polygon(d.building.outline,{color:"#f0a020", weight:2, fillOpacity:.15}).bindTooltip(dasBuildingLine(d.building)).addTo(map);
    const pts=[[d.lat,d.lon]];
    for(const s of (inc.size?chosen:r.systems.slice(0,25))) for(const st of s.sites.slice(0,3)){ pts.push([st.lat,st.lon]);
      L.polyline([[d.lat,d.lon],[st.lat,st.lon]],{color:inc.has(s.call_sign)?"var(--accent)":"#888",weight:inc.has(s.call_sign)?2:1,opacity:.7,dashArray:"4 4"}).addTo(map);
      L.circleMarker([st.lat,st.lon],{radius:5,color:"#0008",weight:1,fillColor:inc.has(s.call_sign)?"#e5534b":"#57606a",fillOpacity:.9}).bindTooltip(`${s.licensee} ${s.call_sign}<br>${st.dist_mi} mi ${st.compass}, est ${num(st.best_out,0)} dBm`).addTo(map); }
    // the panel stretches to the bands panel beside it (11/3: a fixed 300 px map left the rest of it empty), so the map
    // fills it and fits the sites again whenever its size changes, until someone drags it
    const fit=L.latLngBounds(pts).pad(0.15); let moved=false; map.on("dragstart",()=>{ moved=true; });
    map.fitBounds(fit);
    new ResizeObserver(()=>{ map.invalidateSize(); if(!moved) map.fitBounds(fit); }).observe(map.getContainer()); }
}

/* ---------- requirements ---------- */
// what a grid rule says, for the Requirements panel and the report's pass criteria
const dasRuleText = rule => rule==="pct"
  ? `judged by percentage: ${DASJ.general_pct}% of general and ${DASJ.critical_pct}% of critical squares pass on each floor, exact (94.7% is not 95%)`
  : `IFC 510.5.4: ${DAS.grids} areas per floor; more than 1 failed area fails the floor. With exactly 2 failed, the floor may be re-divided into 40 areas and then passes with no more than 2 failed areas, none sharing an edge with another; failing that, the system is altered to reach 95%. Critical squares and named critical areas also meet ${DASJ.critical_pct}%`;
// each number the job is judged by, with where it comes from: the AHJ's section, "typed for this job", or RF Recon's
// default and its basis (a preset that doesn't state a number says "not stated in …" beside the default)
function dasProfileSources(){
  const c=DASJ.cite||{}, E=daqEq(), src=k=>{ const own=c[k]&&!/^not stated|^cleared/.test(c[k]); return own?c[k]:[DAS_DEFAULT_SRC[k], c[k]].filter(Boolean).join(" · "); };
  return [["Downlink level", DASJ.threshold==null?"no dBm floor (DAQ decides)":`≥ ${DASJ.threshold} dBm`, src("threshold")],
    ["DAQ", `≥ ${DASJ.daq}`, src("daq")],
    ["SINR", `≥ ${E.sinr} dB`, E.sinr_src], ["BER", `≤ ${E.ber}%`, E.ber_src],
    ["Uplink in every square", DASJ.ul_required?"required":"not required", DASJ.ul_required||c.ul_required?(c.ul_required||"this job's requirement"):DAS_DEFAULT_SRC.ul_required],
    ["General areas", `${DASJ.general_pct}%`, src("general_pct")], ["Critical areas", `${DASJ.critical_pct}%`, src("critical_pct")],
    ["Grid rule", DASJ.grid_rule==="pct"?"percentages":"IFC 510.5.4 failed areas", src("grid_rule")], ["Standby", `${DASJ.battery_h} h`, src("battery_h")]]; }
function dasRequire(el, j, save){
  const d=j.data||{}, req=d.require||{}, prof=d.profile||{}, pre=dasPreset(prof), P=pre?pre[1]:null;
  const rows=[["Signal at each test location", DASJ.threshold==null?"No dBm floor (DAQ decides)":`≥ ${DASJ.threshold} dBm downlink (uplink too where the AHJ asks)`],
    ["Audio quality", `DAQ ≥ ${DASJ.daq} downlink and uplink; design to 3.4. Measured equivalent: SINR ≥ ${daqEq().sinr} dB with BER ≤ ${daqEq().ber}% (${daqEq().sinr_ahj?"the AHJ's figure":"RF Recon's default: no AHJ figure"})`],
    ["Uplink", DASJ.ul_required?"An uplink reading in every square: a square with only a downlink reading is untested":"Scored where it was read; a square without one isn't held back"],
    ["Coverage", `${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas, each floor`],
    ["Grid test", `${dasRuleText(DASJ.grid_rule)}. One test point near each area's centre; areas 20–80 ft across; floors over 128,000 sq ft split into sectors`],
    ["Test radio", "A calibrated portable of the agency's current model, through the agency's system (or a method the fire code official approves, IFC 2024); two radios keyed at once on different channels (one within 10 ft of an indoor antenna, one at the farthest point)"],
    ["Isolation", `Donor to server antennas at least the system gain + ${DASJ.isolation_margin_db??20} dB`],
    ["Standby power", `${DASJ.battery_h} h at 100% load (or 2 h battery plus a generator); low-battery signal at 70% depletion`],
    ["Equipment", `UL 2524 listed (prefer 3rd-edition listings: Intertek withdraws listings not updated by 2026-03-22); amplifiers in NEMA 4 / 4X enclosures, batteries in NEMA 3R${DASJ.class_a_only?"; Class A (channelized) boosters only":""}${DASJ.p25_phase2?"; P25 Phase 1 and Phase 2":""}`],
    ["Supervision", "To a listed fire alarm panel: AC loss, charger failure, donor antenna / signal source, active RF device, battery at 70%, critical component, the panel link, oscillation; an annunciator in the fire command center"],
    ["Noise at the agency site", "Rise under 1 dB with the booster on (10 kHz RBW, 5 min average), then 3 dB more margin"],
    ["Annual", "Grid retest, gain checked against acceptance, 1 h battery load test, oscillation check, report to the fire code official; also a retest after additions or remodels (IFC 510.6.1, in the 2018, 2021 and 2024 editions)"],
    ["Five-year", "A full quantitative retest at least every five years where NFPA 1225 applies (20.3.10.2.3.3, per the SBC ERCES Primer); the IFC itself has no five-year rule"],
    ["FCC", "Licensee's written consent before activation (47 CFR 90.219(b)(1)); Class B registered with the FCC; 5 W ERP per channel; in-band noise −43 dBm ERP / 10 kHz"],
    ["People", "Tester holds an FCC GROL plus in-building or manufacturer training; many AHJs also ask NICET"]];
  const src=x=>x?.source?` <a href="${esc(x.source)}" target="_blank" rel="noopener">source</a> <span class="hint">(${esc(x.checked||"")})</span>`:"";
  el.innerHTML=`<div class="grid2" style="margin-top:0">
    <div class="panel"><h3>This AHJ's numbers <span class="hint">· pass / fail on the grid test and report use these</span></h3>
      ${dasCellOnly(d)?'<p class="status" style="margin:0 0 8px">A cellular job: no public-safety channels are chosen in the Pre-survey, so these emergency responder numbers don\'t judge it. Its carriers\' targets are below. Choose public-safety channels and it is judged both ways.</p>':""}
      <div class="row" style="margin-bottom:6px;align-items:end"><label class="grow">Preset <select id="pfPick"><option value="">${Object.keys(prof).length?(pre?"":"custom"):"— defaults —"}</option>${Object.keys(DAS_PROFILES).map(k=>`<option ${pre&&pre[0]===k&&Object.keys(prof).length?"selected":""}>${esc(k)}</option>`).join("")}</select></label></div>
      <div class="row"><label>Downlink ≥ dBm<input id="pf_threshold" type="number" value="${DASJ.threshold??""}" placeholder="none" style="width:80px"></label><label>DAQ ≥<input id="pf_daq" type="number" step="0.1" value="${DASJ.daq}" style="width:64px"></label>
        <label>General %<input id="pf_general_pct" type="number" value="${DASJ.general_pct}" style="width:64px"></label><label>Critical %<input id="pf_critical_pct" type="number" value="${DASJ.critical_pct}" style="width:64px"></label>
        <label>Battery h<input id="pf_battery_h" type="number" value="${DASJ.battery_h}" style="width:64px"></label>
        <label title="How each floor's grid is judged">Grid rule <select id="pf_grid_rule"><option value="ifc" ${DASJ.grid_rule!=="pct"?"selected":""}>IFC 510.5.4 failed areas</option><option value="pct" ${DASJ.grid_rule==="pct"?"selected":""}>Percentages only (NFPA)</option></select></label></div>
      <div class="row" style="margin-top:6px;align-items:end"><label title="The AHJ's measured equivalent of DAQ. Empty: RF Recon's default for the DAQ above">SINR ≥ dB<input id="pf_sinr_db" type="number" step="0.1" value="${DASJ.sinr_db??""}" placeholder="${daqEq().sinr}" style="width:72px"></label>
        <label title="Empty: RF Recon's default for the DAQ above">BER ≤ %<input id="pf_ber_pct" type="number" step="0.1" value="${DASJ.ber_pct??""}" placeholder="${daqEq().ber}" style="width:72px"></label>
        <label class="inl" style="padding-bottom:6px" title="A square with a downlink reading and no uplink reading counts as untested, never as a pass"><input type="checkbox" id="pf_ul_required" ${DASJ.ul_required?"checked":""}> Uplink reading in every square</label></div>
      <p class="hint" id="pfNote">${!Object.keys(prof).length?"Defaults: IFC 2021 numbers with the IFC 510.5.4 grid rule.":pre?`<b>${esc(pre[0])}${prof.edited?", edited":""}</b>. ${esc(P.note||"")}${src(P)}`:"Custom numbers for this job."}
        ${pre&&Object.keys(prof).length&&P.checked==="search excerpt"?'<br><b style="color:var(--warn)">From a search excerpt: the research did not open this document. Confirm the numbers with the AHJ.</b>':""}
        ${DASJ.tool_lock?`<br><b style="color:var(--bad)">${esc(DASJ.tool_lock)}</b>`:""}</p>
      <details id="pfSrc" style="margin-top:4px"><summary class="hint" style="cursor:pointer">Where each number comes from</summary><div class="kvg" style="margin-top:6px">${dasProfileSources().map(([k,v,s])=>`<div>${esc(k)}</div><div><b>${esc(v)}</b> <span class="hint">· ${esc(s)}</span></div>`).join("")}</div></details>
      <p class="hint">Local amendments differ: some AHJs ask DAQ 3.4 (Orange County Sheriff, Burbank, Pierce County), −95 dBm both ways, 24 h batteries, or Class A boosters only.</p></div>
    <div class="panel"><h3>What the code asks <span class="hint">· ${esc(d.code||"IFC 510 + NFPA 1225")}</span></h3>
      <p class="st-auth" style="margin:0 0 8px">The AHJ has final authority here. What's in the code they have to enforce, they can require more, and what they tell you in writing wins over anything on this page.</p>
      <div class="kvg">${rows.map(([k,v2])=>`<div>${esc(k)}</div><div>${esc(v2)}</div>`).join("")}</div>
      <p class="hint" id="drSrc" style="margin-top:8px"></p></div>
    <div class="panel" id="drCrit"><h3>Critical areas in this building</h3>${DAS.critical_areas.map(a=>`<label class="inl" style="display:flex;padding:3px 0"><input type="checkbox" data-ca="${esc(a)}" ${(req.critical||[]).includes(a)?"checked":""}> ${esc(a)}</label>`).join("")}
      <label style="margin-top:8px">Other critical areas (one per line)<textarea id="drOther" rows="3" style="width:100%">${esc((req.other||[]).join("\n"))}</textarea></label>
      <p class="hint">These become rows in the Grid test, each tested on its own.</p></div>
    <div class="panel" id="drLic"><h3>Licensee consent: known processes <span class="hint">· from the research; the licensee's current form wins</span></h3>
      ${DAS_LICENSEES.map(x=>`<div style="border-top:1px solid var(--line);padding:5px 0"><b>${esc(x.who)}</b>${x.term?` <span class="tag">${esc(x.term)}</span>`:""}<div>${esc(x.what)}${src(x)}</div></div>`).join("")}
      <p class="hint">A term here is offered when you add an authorization under Overview, Lifecycle, so its renewal date comes from the source.</p></div></div>
    <div id="drCell" style="margin-top:10px"></div>`;
  $("#drSrc").innerHTML=DAS_SOURCES;
  window.dasCellRequire?.($("#drCell"), j, save);  // commercial cellular targets (dascell.js)
  const setProf=async p=>{ j=await save({profile:p}); DASJ=dasProfile(p); render(); };
  // a preset is kept by its numbers, name and rule (the notes are looked up by name); editing a number keeps the name, marked edited
  const KEEP=[...DAS_PROFILE_NUMS, "grid_rule", "isolation_margin_db", "class_a_only", "p25_phase2", ...DAS_PROFILE_AHJ];
  $("#pfPick").onchange=e=>{ const k=e.target.value, x=DAS_PROFILES[k]; if(!x) return;
    setProf({name:k, ...Object.fromEntries(KEEP.filter(f=>x[f]!==undefined).map(f=>[f,x[f]]))}); };
  // a number typed here says so in its source line (cite), so the report never credits the AHJ with it
  const edit=patch=>setProf({...prof, ...Object.fromEntries(DAS_PROFILE_NUMS.map(x=>[x,DASJ[x]])), grid_rule:DASJ.grid_rule, ...(pre?{name:pre[0], edited:true}:{}), ...patch,
    cite:{...(prof.cite||{}), ...Object.fromEntries(Object.keys(patch).map(k=>[k, patch[k]==null?`cleared for this job ${today()}: RF Recon's default applies`:`typed for this job ${today()}`]))}});
  for(const k of DAS_PROFILE_NUMS) $(`#pf_${k}`).onchange=e=>edit({[k]:e.target.value===""?null:+e.target.value});
  for(const k of ["sinr_db","ber_pct"]) $(`#pf_${k}`).onchange=e=>edit({[k]:e.target.value===""?null:+e.target.value});
  $("#pf_ul_required").onchange=e=>edit({ul_required:e.target.checked});
  $("#pf_grid_rule").onchange=e=>edit({grid_rule:e.target.value});
  el.querySelectorAll("[data-ca]").forEach(c=>c.onchange=async()=>{ const set=new Set((j.data.require||{}).critical||[]); c.checked?set.add(c.dataset.ca):set.delete(c.dataset.ca); j=await save({require:{...(j.data.require||{}),critical:[...set]}}); });
  window.rfChecks?.($("#drCrit"), {key:"das.critical", sel:"[data-ca]", word:"in this building", commit:async boxes=>{  // All / None: one save
    const set=new Set((j.data.require||{}).critical||[]); boxes.forEach(c=>c.checked?set.add(c.dataset.ca):set.delete(c.dataset.ca)); j=await save({require:{...(j.data.require||{}),critical:[...set]}}); }});
  $("#drOther").onchange=async e=>{ j=await save({require:{...(j.data.require||{}),other:e.target.value.split("\n").map(s=>s.trim()).filter(Boolean)}}); };
}

/* ---------- grid test: a grid per floor (over the floor plan when there is one), critical areas, any tool's results ---------- */
// A reading passes with the downlink at or above the threshold and audio quality met: DAQ when it was scored, or the
// measured equivalent (SINR and BER) when that's what the tool reported. Uplink level and DAQ count when present.
// measured equivalent of the profile's DAQ for P25 Phase 1: DAQ 3.0 = SINR 18 dB / BER 2.5% (NFPA 1225 A.20.3.10),
// DAQ 3.4 = 17.7 dB / 2% (TSB-88.1-D/E, C4FM narrow IF, faded). The 19 dB often quoted for 3.4 is the VSELP/LSM row.
// 17.7 sits under NFPA's 18 dB for 3.0, and a stricter DAQ never accepts a lower SINR, so 3.4 keeps the higher of the two.
// 11/4: the AHJ's own figure wins where its profile states one (sinr_db / ber_pct, San Diego C-1 and LA County V7-C3-S21:
// 20 dB / 2%); RF Recon's default above applies only where none does, and says where it comes from.
const daqEq = () => { const d34=DASJ.daq>=3.4, cite=DASJ.cite||{};
  const def = d34 ? {sinr:Math.max(17.7, DAS.sinr), ber:2, src:"RF Recon default for DAQ 3.4: 18 dB / 2% (TSB-88.1-D/E gives 17.7 dB for C4FM, kept at NFPA's 18 dB for 3.0; PCTEL quotes 19 dB)"}
    : {sinr:DAS.sinr, ber:DAS.ber, src:"RF Recon default: NFPA 1225 A.20.3.10, DAQ 3.0 = SINR 18 dB / BER 2.5%"};
  const ahj = k => typeof DASJ[k]==="number" && isFinite(DASJ[k]);
  const why = (k, own) => own ? (cite[k]||"this job's requirement (Requirements)") : `${def.src}${cite[k]?` · ${cite[k]}`:""}`;
  return {sinr: ahj("sinr_db")?DASJ.sinr_db:def.sinr, ber: ahj("ber_pct")?DASJ.ber_pct:def.ber, sinr_ahj: ahj("sinr_db"), ber_ahj: ahj("ber_pct"),
    sinr_src: why("sinr_db", ahj("sinr_db")), ber_src: why("ber_pct", ahj("ber_pct"))}; };
const has = x => x!=null && x!=="";
const hasDl = x => has(x.dl)||has(x.daq)||has(x.sinr);
const hasUl = x => has(x.ul)||has(x.ul_daq);
const ulOk = x => (DASJ.threshold==null||!has(x.ul)||+x.ul>=DASJ.threshold) && (!has(x.ul_daq)||+x.ul_daq>=DASJ.daq);
const gridPass = r => { if(!r||!hasDl(r)) return null;
  const E=daqEq(), lvl = v => DASJ.threshold==null || !has(v) || +v>=DASJ.threshold;
  if(DASJ.either){  // Denver 510-1: the level OR the BER passes the square; DAQ, when it was scored, still counts
    const okL=has(r.dl)&&DASJ.threshold!=null&&+r.dl>=DASJ.threshold, okB=has(r.ber)&&+r.ber<=E.ber;
    return (okL||okB||(!has(r.dl)&&!has(r.ber))) && (!has(r.daq)||+r.daq>=DASJ.daq) && ulOk(r); }
  const dq = has(r.daq) ? +r.daq>=DASJ.daq : (has(r.sinr)||has(r.ber)) ? (!has(r.sinr)||+r.sinr>=E.sinr)&&(!has(r.ber)||+r.ber<=E.ber) : true;
  return lvl(r.dl) && dq && ulOk(r); };
// "Uplink in every square" (the profile's ul_required; San Diego C-1 §V.B, Charlotte, Clark County, Seattle, Santa Clara,
// Riverside): a square needs an uplink reading taken with a calibrated instrument. Without one it is untested for uplink,
// never a pass (11/4: a missing uplink read as met). An uplink-only reading there that fails, fails the square.
// null when the profile doesn't ask it
function ulSquare(d, r){ if(!DASJ.ul_required||!r) return null;
  const rs=(Array.isArray(r.readings)?r.readings:[r]).filter(x=>x&&!isCell(x)&&hasUl(x)&&calOf(d,x)?.ok);
  return {tested: rs.length>0, fail: rs.some(x=>!ulOk(x))}; }
// Only a reading taken with a calibrated instrument counts toward pass / fail: the code asks for calibrated test equipment
// and the AHJ report lists each instrument's calibration date. Each reading names what took it (r.inst: an instrument's
// "model|serial" from the Overview, or "uncal" for an SDR, a phone app or a quick check); the rest stay on the plan as
// pre-survey and are left out of the score. The instrument's calibration must be within DAS.cal_months of the reading.
const instKey = i => `${i.model}|${i.serial||""}`;
const instName = i => [i.model, i.serial].filter(Boolean).join(" ");
// a calibration certificate's own expiry (the Overview's certificate register) wins over the 12-month rule; it runs to
// the end of that day
function instState(i, at=Date.now()){ const cal=Date.parse(i.cal||""), exp=Date.parse((i.expires||"")+"T23:59:59");
  if(!isFinite(cal)) return {ok:false, why:"no calibration date"};
  if(isFinite(exp)) return at>exp ? {ok:false, why:`certificate expired ${i.expires}`} : {ok:true, why:`calibrated ${i.cal}, certificate to ${i.expires}`};
  return at-cal > DAS.cal_months*30.44*864e5 ? {ok:false, why:`calibration over ${DAS.cal_months} months old`} : {ok:true, why:`calibrated ${i.cal}`}; }
// a job that took a newer calibration keeps the one before it (i.prior, dasfirm.py): a reading stands on the calibration in force when it was taken, so its result doesn't move
function instAt(i, at){ const p=i.prior||[], when=x=>Date.parse(x.cal||""); if(!p.length||!(at<when(i))) return i;
  return p.filter(x=>when(x)<=at).sort((a,b)=>when(b)-when(a))[0]||p[p.length-1]; }
function calOf(d, r){ if(!r||!(has(r.dl)||has(r.daq)||has(r.sinr)||has(r.ul)||has(r.ul_daq))) return null;
  if(r.inst==="uncal") return {ok:false, why:"not calibrated (pre-survey)", name:"not calibrated"};
  const i=((d.testing||{}).instruments||[]).find(x=>instKey(x)===r.inst);
  if(!i) return {ok:false, why:r.inst?"instrument no longer on the job's list":"no instrument recorded", name:r.inst?r.inst.replace("|"," "):"not recorded"};
  const at=Date.parse(r.time||"")||Date.now();
  return {...instState(instAt(i, at), at), name:instName(i)}; }
// A square can hold several readings (r.readings): one per channel or system, and cellular ones (LTE / 5G: kept and shown,
// never scored against these public-safety rules; an RSRP isn't a -95 dBm downlink). eff() gives the reading that decides
// the square: the worst one taken with a calibrated instrument (a failing one first, then the lowest level), so a square
// passes only when every channel does. A square saved before readings were kept per channel is one plain reading.
const CELL_TECH=/\b(LTE|NR|5G|4G|3G|UMTS|WCDMA|HSPA|GSM|CDMA|EV-?DO)\b/i;
const isCell = x => (has(x.tech)&&CELL_TECH.test(String(x.tech))) || has(x.rsrp) || has(x.rsrq);
const chKey = x => [x.tech, x.carrier, x.freq, x.pci].map(v=>String(v??"").trim().toLowerCase()).join("|");  // FirstNet and AT&T share Band 14 cells
const readingsOf = r => !r ? [] : Array.isArray(r.readings) ? r.readings : (has(r.dl)||has(r.daq)||has(r.sinr)) ? [r] : [];
function eff(d, r){ const rs=r&&Array.isArray(r.readings)?r.readings:null; if(!rs) return r;
  const lmr=rs.filter(x=>!isCell(x)&&(has(x.dl)||has(x.daq)||has(x.sinr))), ok=lmr.filter(x=>calOf(d,x)?.ok), pool=ok.length?ok:lmr;
  const lvl=x=>[has(x.dl)?+x.dl:1e9, has(x.daq)?+x.daq:1e9, has(x.sinr)?+x.sinr:1e9];
  const worst=[...pool].sort((a,b)=>{ const fa=gridPass(a)===false, fb=gridPass(b)===false; if(fa!==fb) return fa?-1:1;
    const ka=lvl(a), kb=lvl(b); return ka[0]-kb[0]||ka[1]-kb[1]||ka[2]-kb[2]; })[0];
  return {...(worst||{}), readings:rs, at:worst?rs.indexOf(worst):-1, channels:lmr.length, cellular:rs.length-lmr.length}; }
// pass / fail for the score: null when untested or not counted
const scored = (d, r) => { const c=calOf(d, r); if(!(c&&c.ok)) return null; const p=gridPass(r); if(p==null) return null;
  const u=ulSquare(d, r); if(u){ if(u.fail) return false; if(p&&!u.tested) return null; } return p; };
const notCounted = (d, r) => { const c=calOf(d, r); return !!c && !c.ok; };
// a square whose downlink passes and that has no counted uplink reading, where the AHJ asks uplink in every square
const ulMissing = (d, r) => { const c=calOf(d, r); if(!(c&&c.ok)||gridPass(r)!==true) return false; const u=ulSquare(d, r); return !!u && !u.tested && !u.fail; };
/// per floor: do-not-test squares leave the count; squares marked critical are judged against the critical percentage.
// Percentages are compared exactly, never rounded to a pass: 18 of 19 is 94.7%, not 95% (R2 K-1). Shown to one decimal,
// cut rather than rounded, so a fail never reads as 95.0%.
const dasPct = (a, b) => b ? Math.floor(1000*a/b+1e-9)/10 : 100;
const dasCols = f => { const n=f.grids||DAS.grids; return f.cols||(n===20?5:Math.ceil(Math.sqrt(n))); };
// two squares share an edge on the floor's grid (numbered row by row, `cols` across); a corner touch isn't adjacent
const gridAdjacent = (a, b, cols) => { const ra=Math.floor((a-1)/cols), ca=(a-1)%cols, rb=Math.floor((b-1)/cols), cb=(b-1)%cols;
  return Math.abs(ra-rb)+Math.abs(ca-cb)===1; };
// The grid rule (DASJ.grid_rule, from the AHJ profile). "ifc", IFC 510.5.4 as the 2024 text (and 2021's) words it: each
// floor is 20 areas and more than 1 failed area fails the test; with exactly 2 failed, the floor may be re-divided into
// 40 areas, and then passes with no more than 2 failed areas that are not adjacent; failing that, the system is altered
// to reach 95%. A floor with another count of squares (sectors, or a count the AHJ set) is judged by the percentages,
// and says so. "pct": the percentages alone (NFPA-only AHJs). Critical squares meet the critical percentage either way.
function floorStats(d, f){ const res=(d.grid||{}).results||{}, n=(f.grids||DAS.grids), skip=new Set(f.skip||[]), crit=new Set(f.critical||[]);
  const o={n, tested:0, pass:0, gen:0, genPass:0, crit:0, critPass:0, untested:0, notCounted:0, ulMissing:0, ulList:[], fails:[], adjacent:[]};
  for(let g=1; g<=n; g++){ if(skip.has(g)) continue; const r=eff(d, res[`${f.name}|${g}`]), p=scored(d, r), c=crit.has(g);
    if(notCounted(d, r)) o.notCounted++;
    c?o.crit++:o.gen++; if(p==null){ o.untested++; if(ulMissing(d, r)){ o.ulMissing++; o.ulList.push(g); } continue; } o.tested++; if(p){ o.pass++; c?o.critPass++:o.genPass++; } else o.fails.push(g); }
  o.counted=o.gen+o.crit; o.pct=dasPct(o.pass, o.counted);
  o.genPct=dasPct(o.genPass, o.gen); o.critPct=dasPct(o.critPass, o.crit);
  const genOk = !o.gen || o.genPass/o.gen >= DASJ.general_pct/100, critOk = !o.crit || o.critPass/o.crit >= DASJ.critical_pct/100;
  const cols=dasCols(f), nf=o.fails.length, sq=o.fails.join(", ");
  for(let i=0;i<nf;i++) for(let k=i+1;k<nf;k++) if(gridAdjacent(o.fails[i], o.fails[k], cols)) o.adjacent.push([o.fails[i], o.fails[k]]);
  const critWhy = critOk ? "" : ` Critical squares: ${o.critPass} of ${o.crit} pass (${o.critPct}%), under the ${DASJ.critical_pct}% required.`;
  let areaOk;
  if(DASJ.grid_rule!=="pct" && (n===20||n===40)){
    o.rule=`IFC 510.5.4, ${n} areas`;
    if(n===20){ areaOk = nf<=1; o.redivide = nf===2;
      o.why = nf===0 ? "No area failed." : nf===1 ? `1 of 20 areas failed (square ${sq}): one is allowed.`
        : nf===2 ? `2 of 20 areas failed (squares ${sq}): more than 1 fails the floor.${DASJ.no_40_area?" This AHJ allows no 40-area retest.":` The floor may be re-divided into 40 areas and tested again; it then passes with no more than ${DASJ.fail40||2} non-adjacent failures.`}`
        : `${nf} of 20 areas failed (squares ${sq}): more than 1 fails the floor.`; }
    else { const m40=DASJ.fail40||2; areaOk = nf<=m40 && !o.adjacent.length;
      o.why = nf===0 ? "No area failed." : areaOk ? `${nf} of 40 areas failed (square${nf===1?"":"s"} ${sq}), not adjacent: up to ${m40} non-adjacent are allowed.`
        : nf>m40 ? `${nf} of 40 areas failed (squares ${sq}): more than ${m40} fails the floor, and the system must be altered to reach 95%.`
        : `${nf} of 40 areas failed and some share an edge (squares ${sq}): the ones allowed must be non-adjacent, so the system must be altered to reach 95%.`; }
  } else {
    o.rule = DASJ.grid_rule==="pct" ? "percentages" : `percentages (${n} squares: the IFC area rule is worded for 20 or 40)`;
    areaOk = genOk;
    o.why = `${o.genPass} of ${o.gen} general squares pass (${o.genPct}%)${genOk?`, at least the ${DASJ.general_pct}% required`:`: under the ${DASJ.general_pct}% required`}.`;
    // College Station: 2 or more adjacent failed grids fail the test, whatever the percentage
    if(DASJ.adjacent_fail&&o.adjacent.length){ areaOk=false; o.why+=` Squares ${o.adjacent.map(p=>p.join(" and ")).join("; ")} failed side by side: 2 adjacent failures fail the floor.`; }
  }
  o.why += critWhy;
  const other=o.untested-o.ulMissing;
  if(o.ulMissing) o.why = `${o.ulMissing} square${o.ulMissing===1?" has":"s have"} a downlink and no uplink reading (${o.ulList.slice(0,8).map(g=>`${f.name}-${g}`).join(", ")}${o.ulMissing>8?` and ${o.ulMissing-8} more`:""}): this AHJ requires uplink in every square, so ${o.ulMissing===1?"it counts":"they count"} as untested for uplink. `+o.why;
  if(other) o.why = `${other} square${other===1?"":"s"} not tested yet. `+o.why;
  o.ok = o.untested===0 && areaOk && critOk; return o; }
async function dasGrid(el, j, save){
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], G=d.grid||{}, res=G.results||{}, base=d.baseline||null;
  if(!floors.length){ el.innerHTML='<p class="status">Set the number of floors on the Overview first.</p>'; return; }
  const D=S.das; D.floor=floors.some(f=>f.name===D.floor)?D.floor:floors[0].name; D.mark=D.mark||"read";
  const f=floors.find(x=>x.name===D.floor), n=f.grids||DAS.grids, cols=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), rows=Math.ceil(n/cols);
  const skip=new Set(f.skip||[]), critSet=new Set(f.critical||[]);
  // the grid sits on the plan where you put it (Place grid: drag, resize, rotate); the plan keeps its own shape. Its real
  // width in feet (shared with the Design tab) gives each square's size
  const planSrc=f.plan?await jobFileSrc(j.id, f.plan):null, hasPlan=!!planSrc;
  if(D.mark==="place"&&!hasPlan) D.mark="read";
  const box=boxOf(f), place=D.mark==="place", wft=(((d.design||{}).floors||{})[f.name]||{}).width_ft||null;
  // Show: the public-safety score, or one carrier's cellular coverage against the job's cellular target (dascell.js)
  const cl=window.cellLayers?cellLayers(d):[];
  if(D.gviewJob!==j.id){ D.gviewJob=j.id; D.gview=dasCellOnly(d)?((cl.find(x=>x.required)||cl[0])||{}).key||"":""; }  // a cellular job opens on its first required carrier
  if(!cl.some(x=>x.key===D.gview)) D.gview="";
  const cv=D.gview||null, cvL=cl.find(x=>x.key===cv), cvP=cv?cellProfile(d):null;
  const cellCards=()=>floors.map(fl=>{ const s=cellFloor(d,fl,cv); return `<div class="card" data-fl="${esc(fl.name)}" style="cursor:pointer;${fl.name===D.floor?"outline:2px solid var(--accent)":""}">
    <div class="v" style="color:${!s.tested?"var(--muted)":s.ok?"var(--good)":"var(--bad)"}">${s.tested?s.pct+"%":"–"}</div><div class="k">Floor ${esc(fl.name)} · ${esc(cvL.carrier)} ${s.pass}/${s.tested} at target${s.untested?` · ${s.untested} untested`:""}${s.noSinr?` · ${s.noSinr} without SINR`:""}</div></div>`; }).join("");
  const files=(await api(`/api/das/jobs/${j.id}/files`).catch(()=>({files:[]}))).files.filter(x=>/\.(png|jpe?g|gif|webp|svg)$/i.test(x.name));
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])];
  const cr=G.critical||{}, critTested=crit.filter(a=>scored(d,cr[a])!=null), critPass=crit.filter(a=>scored(d,cr[a]));
  const st=floors.map(x=>({f:x, ...floorStats(d,x)}));
  // what takes the readings entered or imported here (kept with the job); readings saved before readings named their
  // instrument don't count until someone says what took them
  const insts=(d.testing||{}).instruments||[], inst=G.inst||"";
  const instOpts=(sel,adds=true)=>`${insts.map(i=>{ const s=instState(i); return `<option value="${esc(instKey(i))}" ${instKey(i)===sel?"selected":""}>${esc(instName(i))} · ${esc(s.why)}${s.ok?"":" (won't count)"}</option>`; }).join("")}
    <option value="uncal" ${sel==="uncal"?"selected":""}>Not calibrated: an SDR, a phone app, a quick check (pre-survey)</option>
    ${adds?`<optgroup label="Add an instrument">${(typeof SCREEN_RX!=="undefined"?SCREEN_RX:[]).map(x=>`<option value="add:${esc(x.id)}">${esc(x.name)}…</option>`).join("")}<option value="add:other">Another instrument…</option></optgroup>`:""}`;
  // the market DAS test instruments RF Recon knows (dasscreen.js), plus any other, can be added here with their serial and
  // calibration date (11/3: the list held only the instruments typed on the Overview, so the example job offered one)
  const unnamedRes=Object.keys(res).filter(k=>readingsOf(res[k]).some(x=>calOf(d,x)&&!x.inst)), unnamedCr=Object.keys(cr).filter(k=>calOf(d,cr[k])&&!cr[k].inst), unnamed=unnamedRes.length+unnamedCr.length;
  // NFPA 1225: 20 squares per floor, each 20-80 ft across; floors over 128,000 sq ft split into sectors
  const per=d.area_sqft&&floors.length?d.area_sqft/floors.length:null, side=per?Math.sqrt(per/(n-skip.size||n)):null;
  const warn=[]; if(n<DAS.grids) warn.push(`${n} squares is fewer than the ${DAS.grids} the code asks for.`);
  if(per&&per>DAS.sector_sqft) warn.push(`About ${Math.round(per).toLocaleString()} sq ft per floor: floors over ${DAS.sector_sqft.toLocaleString()} sq ft are split into sectors of ${DAS.grids} squares each.`);
  else if(hasPlan&&wft) {}  // measured on the plan instead (#dgSize)
  else if(side&&side>DAS.cell_ft[1]) warn.push(`Each square is about ${Math.round(side)} ft across, over the ${DAS.cell_ft[1]} ft limit: add squares.`);
  else if(side&&side<DAS.cell_ft[0]) warn.push(`Each square is about ${Math.round(side)} ft across, under ${DAS.cell_ft[0]} ft: fewer squares will do.`);
  const delta=g=>{ const b=eff(d, base?.results?.[`${f.name}|${g}`]), r=eff(d, res[`${f.name}|${g}`]); return b&&r&&has(b.dl)&&has(r.dl)?Math.round(+r.dl-+b.dl):null; };
  el.innerHTML=`<div class="maptools no-print" style="flex-wrap:wrap;gap:10px">
      <label class="inl">Floor <select id="dgF">${floors.map(x=>`<option ${x.name===D.floor?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label class="inl">Squares <input id="dgN" type="number" min="1" max="100" value="${n}" style="width:64px"></label>
      <label class="inl">Columns <input id="dgC" type="number" min="1" max="20" value="${cols}" style="width:56px"></label>
      <label class="inl">Floor plan <select id="dgPlan"><option value="">— none —</option>${files.map(x=>`<option ${x.name===f.plan?"selected":""}>${esc(x.name)}</option>`).join("")}</select></label>
      ${hasPlan?`<label class="inl" title="The plan's real width in feet, from the drawing's scale or dimensions. The Design tab uses the same number">Plan width <input id="dgW" type="number" step="any" min="1" value="${wft??""}" placeholder="ft" style="width:72px"> ft</label>`:""}
      <div class="seg" id="dgMark" title="What a click on a square does">${[["read","Enter readings"],["skip","Do not test"],["crit","Critical"],...(hasPlan?[["place","Place grid"]]:[]),...(window.dasWalkHook?[["walk","Walk"]]:[])].map(([k,l])=>`<button data-m="${k}" class="${D.mark===k?"on":""}">${l}</button>`).join("")}</div>
      ${place?`<label class="inl" title="Turn the grid to line up with the building on the plan">Rotate <input id="dgRot" type="number" step="0.5" min="-180" max="180" value="${box.rot}" style="width:64px">°</label><button id="dgFit" title="The grid covers the whole plan again, square to it">Fit to plan</button>`:""}
      ${cl.length?`<label class="inl" title="The public-safety score, or one carrier's coverage against the cellular target (Requirements)">Show <select id="dgView"><option value="">Public safety</option>${cl.map(x=>`<option value="${esc(x.key)}" ${x.key===cv?"selected":""}>${esc(x.label)}${x.required?"":" (not required)"}</option>`).join("")}</select></label>`:""}
      <label class="inl" title="What takes the readings you enter or import here. Only an instrument calibrated within ${DAS.cal_months} months counts toward pass / fail; add instruments on the Overview (model | serial | calibration date)">Taken with
        <select id="dgInst"><option value="">— pick —</option>${instOpts(inst)}</select></label>
      <label class="inl" title="Results from any tool: CSV, TSV, Excel, JSON, KML/KMZ or GPX">Import results <input type="file" id="dgImp" accept=".csv,.tsv,.txt,.xlsx,.json,.kml,.kmz,.gpx"></label>
      <button id="dgCsv" title="One row per square: the reading that decides it">⇩ Results CSV</button><button id="dgAll" title="Every reading, one row per channel, cellular ones too: imports back into RF Recon or into another tool">⇩ All readings CSV</button><button id="dgJson">⇩ Results JSON</button>
      <button id="dgBase" title="Keep these results as the acceptance test, to compare each annual retest with">${base?`Baseline: ${esc(base.date)} · replace`:"Save as acceptance baseline"}</button></div>
    <div id="dgAddInst" class="row no-print" style="display:none;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:0 2px 8px"></div>
    ${warn.length?`<p class="status err" style="margin:0 2px 8px">${warn.map(esc).join(" ")}</p>`:""}
    ${f.plan&&!hasPlan?`<p class="status err" style="margin:0 2px 8px">Couldn't open the floor plan ${esc(f.plan)}: is it still in the job's Files?</p>`:""}
    ${!inst?`<p class="status" style="margin:0 2px 8px">Pick what's taking the readings (<b>Taken with</b>) before you enter or import any.${insts.length?"":" Add your instruments on the Overview first: model | serial | calibration date."}</p>`:""}
    ${unnamed?`<p class="status err" style="margin:0 2px 8px">${unnamed} reading${unnamed===1?" doesn't":"s don't"} say what took ${unnamed===1?"it":"them"}, so ${unnamed===1?"it doesn't":"they don't"} count.
      Taken with <select id="dgFix"><option value="">— pick —</option>${instOpts("",false)}</select> <button id="dgFixGo">Apply to ${unnamed===1?"it":`these ${unnamed}`}</button></p>`:""}
    <div class="cards" style="margin-bottom:10px">${cv?cellCards():""}${(cv?[]:st).map(x=>`<div class="card" data-fl="${esc(x.f.name)}" style="cursor:pointer;${x.f.name===D.floor?"outline:2px solid var(--accent)":""}" title="General ${x.genPass}/${x.gen}, critical ${x.critPass}/${x.crit}, ${x.untested} untested${x.notCounted?`, ${x.notCounted} not counted (no calibrated instrument)`:""}. Judged by ${esc(x.rule)}: ${esc(x.why)}">
        <div class="v" style="color:${x.untested?"var(--muted)":x.ok?"var(--good)":"var(--bad)"}">${x.genPct}%</div><div class="k">Floor ${esc(x.f.name)} · ${x.genPass}/${x.gen} general${x.crit?` · ${x.critPass}/${x.crit} critical`:""}${x.untested?` · ${x.untested} untested`:""}${x.ulMissing?` (${x.ulMissing} no uplink)`:""}${x.notCounted?` · ${x.notCounted} not counted`:""}${!x.untested?` · <b>${x.ok?"pass":"fail"}</b>`:""}${x.fails.length?` · ${x.fails.length} failed`:""}</div></div>`).join("")}
      ${crit.length&&!cv?`<div class="card"><div class="v" style="color:${critTested.length<crit.length?"var(--muted)":critPass.length===crit.length?"var(--good)":"var(--bad)"}">${critPass.length}/${crit.length}</div><div class="k">Named critical areas pass</div></div>`:""}</div>
    ${!cv?(()=>{ const x=st.find(y=>y.f.name===f.name); return x&&x.tested?`<p class="status${x.untested||x.ok?"":" err"}" id="dgRule" style="margin:0 2px 8px">Floor ${esc(f.name)}, judged by ${esc(x.rule)}: ${esc(x.why)}
      ${x.redivide?` <button id="dgRedivide" title="IFC 510.5.4: with exactly 2 of 20 areas failed, the floor may be divided into 40 equal areas and tested again. This floor's 20-area readings are kept with the job, dated; the 40 squares start empty, so mark the critical and do-not-test squares again">Re-divide into 40 areas</button>`:""}</p>`:""; })():""}
    <div class="grid2" style="margin-top:0;grid-template-columns:minmax(320px,2fr) minmax(260px,1fr)">
      <div class="panel"><h3>Floor ${esc(f.name)} <span class="hint">· ${place?"drag the grid to move it, the corner dot to size it, the top dot to turn it":D.mark==="read"?"click a square to enter its readings":D.mark==="skip"?"click squares that aren't tested (shafts, closets the AHJ excludes)":"click squares that are critical areas"} · ${cv?`${esc(cvL.carrier)}, ${esc(LAYER_NAME[cvL.layer])}: pass = its best cell ≥ ${cellThr(cvP, cvL.carrier, cvL.layer)} dBm RSRP${cvP.sinr!=null?` and SINR ≥ ${cvP.sinr} dB`:""}; ${cvP.pct}% of tested squares (${esc(cvP.name)})`:`pass = ≥ ${DASJ.threshold} dBm and DAQ ≥ ${DASJ.daq} (or SINR ≥ ${daqEq().sinr} dB, BER ≤ ${daqEq().ber}%) on every channel, from a calibrated instrument${DASJ.ul_required?"; an uplink reading in every square":""}; grey = not counted`}</span></h3>
        <div id="dgWrap" style="position:relative;width:100%;${hasPlan?"":`aspect-ratio:${cols}/${rows};`}border-radius:10px;overflow:${place?"visible":"hidden"}">
          ${hasPlan?`<img id="dgImg" src="${planSrc}" alt="Floor ${esc(f.name)} plan" draggable="false" style="display:block;width:100%;height:auto;user-select:none;pointer-events:none">`:""}
          <div id="dgCells" style="position:absolute;${boxCss(f, hasPlan)};display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)${place?";outline:2px dashed var(--accent);cursor:move;touch-action:none":""}">
          ${Array.from({length:n},(_,i)=>{ const g=i+1, r=eff(d, res[`${f.name}|${g}`]), p=scored(d,r), cal=calOf(d,r), nc=cal&&!cal.ok, sk=skip.has(g), c=critSet.has(g), dl=delta(g), um=ulMissing(d,r);
            if(cv&&!sk){ const s=cellSquare(d, res[`${f.name}|${g}`], cv);
              return `<button data-g="${g}" title="Square ${g}${c?" (critical)":""} · ${esc(s?s.why:"no cellular readings here")}" style="border:${c?"2px solid #fab219":"1px solid var(--line)"};border-radius:0;margin:0;padding:2px;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:12px;background:${s==null?"color-mix(in srgb,var(--panel) 35%,transparent)":s.pass?"color-mix(in srgb,#3ccf7a 45%,transparent)":"color-mix(in srgb,#e5534b 55%,transparent)"}${place?";pointer-events:none":""}">
                <b>${f.name}-${g}${c?" ★":""}</b><span class="mono">${s?.best?`${s.best.rsrp} RSRP`:s?"no signal":""}</span>${s?.best&&has(s.best.sinr)?`<span class="mono hint">SINR ${s.best.sinr}</span>`:""}${s?.best&&has(s.best.band)?`<span class="hint">band ${esc(s.best.band)}</span>`:""}</button>`; }
            const bg=sk?"repeating-linear-gradient(45deg,color-mix(in srgb,var(--panel) 60%,transparent) 0 6px,transparent 6px 12px)":nc?"color-mix(in srgb,#8c959f 40%,transparent)":p==null?"color-mix(in srgb,var(--panel) 35%,transparent)":p?"color-mix(in srgb,#3ccf7a 45%,transparent)":"color-mix(in srgb,#e5534b 55%,transparent)";
            return `<button data-g="${g}" title="Square ${g}${c?" (critical)":""}${sk?" (not tested)":""}${r?.channels>1?` · ${r.channels} channels; ${has(r.freq)?`${r.freq} decides`:"the worst decides"}`:""}${r?.cellular?` · ${r.cellular} cellular reading${r.cellular===1?"":"s"}, not scored`:""}${cal?(cal.ok?` · taken with ${cal.name}`:` · not counted: ${cal.why}${r.inst&&r.inst!=="uncal"?` (${cal.name})`:""}`):""}${um?" · no uplink reading: untested for uplink":""}" style="border:${c?"2px solid #fab219":nc?"1px dashed var(--muted)":"1px solid var(--line)"};border-radius:0;margin:0;padding:2px;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:12px;background:${bg}${place?";pointer-events:none":""}">
              <b>${f.name}-${g}${c?" ★":""}</b>${sk?'<span class="hint">not tested</span>':`<span class="mono">${r&&has(r.dl)?`${r.dl} dBm`:""}</span><span class="mono hint">${r&&has(r.daq)?`DAQ ${r.daq}`:r&&has(r.sinr)?`${r.sinr} dB SINR`:""}</span>${r?.channels>1?`<span class="hint">worst of ${r.channels}</span>`:""}${r?.cellular?`<span class="hint">+${r.cellular} cellular</span>`:""}${nc?'<span class="hint">not counted</span>':""}${um?'<span class="hint">no uplink</span>':""}${dl!=null?`<span class="mono hint">${dl>=0?"+":""}${dl} dB vs baseline</span>`:""}`}</button>`; }).join("")}
          ${place?`<span data-h="rot" title="Turn" style="position:absolute;left:50%;top:6px;width:16px;height:16px;margin-left:-8px;border-radius:50%;background:var(--accent);border:2px solid #fff;cursor:grab"></span>
            <span data-h="size" title="Size" style="position:absolute;right:4px;bottom:4px;width:16px;height:16px;border-radius:50%;background:var(--accent);border:2px solid #fff;cursor:nwse-resize"></span>`:""}</div></div>
        ${hasPlan?`<p class="hint" id="dgSize" style="margin:6px 2px 0">${wft?"":"Enter the plan's width in feet to check each square's size."}</p>`:""}
        <div id="dgEdit" style="margin-top:8px"></div></div>
      <div class="panel"><h3>Named critical areas</h3>${crit.length?`<div class="tw"><table><thead><tr><th>Area</th><th>DL dBm</th><th>DAQ</th><th>UL dBm</th><th>UL DAQ</th><th></th></tr></thead><tbody>${crit.map(a=>{ const r=cr[a]||{}, p=scored(d,r), cal=calOf(d,r);
          return `<tr data-ca="${esc(a)}"><td>${esc(a)}</td>${["dl","daq","ul","ul_daq"].map(k=>`<td><input data-x="${k}" type="number" step="${/daq/.test(k)?"0.1":"1"}" value="${r[k]??""}" style="width:64px"></td>`).join("")}<td title="${cal?esc(cal.ok?`taken with ${cal.name}`:`not counted: ${cal.why}`):""}">${cal&&!cal.ok?'<span class="hint">not counted</span>':ulMissing(d,r)?'<span class="hint">no uplink</span>':p==null?"":p?"✅":"❌"}</td></tr>`; }).join("")}</tbody></table></div>`
          :'<p class="hint">Pick the building\'s critical areas under Requirements, or mark critical squares on the plan.</p>'}</div></div>
    <div id="dgMap"></div>
    <div id="dgAccept"></div>`;
  $("#dgF").onchange=e=>{ D.floor=e.target.value; render(); };
  el.querySelectorAll("[data-fl]").forEach(c=>c.onclick=()=>{ D.floor=c.dataset.fl; render(); });
  $("#dgMark").onclick=e=>{ const b=e.target.closest("button"); if(b){ D.mark=b.dataset.m; render(); } };
  const setFloor=async patch=>{ const fl=(j.data.floors||[]).map(x=>x.name===f.name?{...x,...patch}:x); j=await save({floors:fl}); render(); };
  $("#dgN").onchange=e=>setFloor({grids:Math.max(1,Math.min(100,+e.target.value||DAS.grids))});
  // the 40-area retest (IFC 510.5.4): the 20-area readings move to grid.redivided[floor], dated, so the new squares 1-20
  // don't inherit readings taken at other places on the floor; 8 across x 5 down (Columns can change it)
  $("#dgRedivide")&&($("#dgRedivide").onclick=async()=>{ const G2=j.data.grid||{}, R2={...(G2.results||{})}, old={};
    for(const k of Object.keys(R2)) if(k.startsWith(`${f.name}|`)){ old[k]=R2[k]; delete R2[k]; }
    const keep={...(G2.redivided||{}), [f.name]:{date:today(), grids:n, cols, results:old}};
    j=await save({grid:{...G2, results:R2, redivided:keep}, floors:(j.data.floors||[]).map(x=>x.name===f.name?{...x, grids:40, cols:8, skip:[], critical:[]}:x)});
    render(); });
  $("#dgC").onchange=e=>setFloor({cols:Math.max(1,Math.min(20,+e.target.value||5))});
  $("#dgPlan").onchange=e=>setFloor({plan:e.target.value||null, plan_src:null});  // another image: the PDF it came from no longer applies (dswalls.js)
  window.dasFirmGrid?.($("#dgInst"), insts);  // the instruments on the firm's list (dasfirm.js)
  $("#dgInst").onchange=async e=>{ const v=e.target.value;
    if(v.startsWith("reg:")){ e.target.value=inst;  // from the list: copied onto this job, then it's the one taking readings
      try{ const got=await window.dasFirmUse(j.id, +v.slice(4));
        j=await save({grid:{...(got.job.data.grid||{}), inst:got.inst}}); render(); }catch(err){ dasSay("Not saved: "+err.message); }
      return; }
    if(v.startsWith("add:")){  // a new instrument: its serial and calibration date, then it's the one taking readings
      const rx=(typeof SCREEN_RX!=="undefined"?SCREEN_RX:[]).find(x=>"add:"+x.id===v), box=$("#dgAddInst");
      e.target.value=inst;
      box.innerHTML=`<label>Model <input id="aiM" value="${esc(rx?rx.name:"")}" placeholder="maker and model" style="width:240px"></label>
        <label>Serial <input id="aiS" style="width:120px"></label><label>Calibrated <input id="aiC" type="date"></label>
        <button class="primary" id="aiGo">Add and use it</button><button id="aiX">Cancel</button>
        <span class="hint">Counts toward pass / fail only when calibrated within ${DAS.cal_months} months.</span>`;
      box.style.display="flex"; $("#aiS").focus();
      $("#aiX").onclick=()=>{ box.style.display="none"; box.innerHTML=""; };
      $("#aiGo").onclick=async()=>{ const it={model:$("#aiM").value.trim(), serial:$("#aiS").value.trim(), cal:$("#aiC").value};
        if(!it.model){ $("#aiM").focus(); return; }
        const list=[...insts.filter(i=>instKey(i)!==instKey(it)), it];
        j=await save({testing:{...(j.data.testing||{}), instruments:list}, grid:{...(j.data.grid||{}), inst:instKey(it)}}); render(); };
      return; }
    j=await save({grid:{...(j.data.grid||{}), inst:v||null}}); render(); };
  $("#dgView")?.addEventListener("change", e=>{ D.gview=e.target.value; render(); });
  $("#dgFixGo")?.addEventListener("click", async()=>{ const v=$("#dgFix").value; if(!v){ $("#dgFix").focus(); return; }
    const G2=j.data.grid||{}, results={...(G2.results||{})}, critical={...(G2.critical||{})};
    for(const k of unnamedRes) results[k]=Array.isArray(results[k].readings)?{...results[k], readings:results[k].readings.map(x=>calOf(d,x)&&!x.inst?{...x, inst:v}:x)}:{...results[k], inst:v};
    for(const k of unnamedCr) critical[k]={...critical[k], inst:v};
    j=await save({grid:{...G2, results, critical}});
    await post(`/api/das/jobs/${j.id}/note`,{text:`Said what took ${unnamed} earlier reading${unnamed===1?"":"s"}: ${v==="uncal"?"not calibrated":v.replace("|"," ")}`}); render(); });
  const needInst=()=>{ if(inst) return false; $("#dgEdit").innerHTML='<p class="status err">Pick what\'s taking the readings first: <b>Taken with</b>, above.</p>'; $("#dgInst").focus(); return true; };
  $("#dgBase").onclick=async()=>{ if(base&&!confirm(`Replace the ${base.date} baseline with today's results?`)) return;
    j=await save({baseline:{date:today(), results:{...((j.data.grid||{}).results||{})}, critical:{...((j.data.grid||{}).critical||{})}}}); render(); };
  el.querySelectorAll("[data-g]").forEach(b=>b.onclick=()=>{ const g=+b.dataset.g;
    if(D.mark==="place") return;
    if(D.mark!=="read"){ const key=D.mark==="skip"?"skip":"critical", set=new Set(f[key]||[]); set.has(g)?set.delete(g):set.add(g); return setFloor({[key]:[...set].sort((a,c)=>a-c)}); }
    if(needInst()) return;
    // the square's readings, one per channel (and cellular ones): Save adds one, or replaces the one on the same channel
    const key=`${f.name}|${g}`, rs=readingsOf(res[key]), top=eff(d, res[key]);
    let editing=null;
    const KS=[["dl","DL dBm",1],["daq","DL DAQ",.1],["sinr","SINR dB",.1],["ber","BER %",.01],["ul","UL dBm",1],["ul_daq","UL DAQ",.1]];
    const cellTxt=x=>[x.carrier, x.tech, has(x.band)?`band ${x.band}`:"", has(x.rsrp)?`RSRP ${x.rsrp}`:"", has(x.rsrq)?`RSRQ ${x.rsrq}`:"", has(x.sinr)?`SINR ${x.sinr}`:"", has(x.pci)?`PCI ${x.pci}`:""].filter(Boolean).join(" · ");
    $("#dgEdit").innerHTML=`${rs.length?`<div class="tw" style="margin-bottom:8px"><table><thead><tr><th>Channel / MHz</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">SINR / BER</th><th class="n">UL dBm</th><th class="n">UL DAQ</th><th>Taken with</th><th>Result</th><th></th></tr></thead><tbody>${rs.map((x,i)=>{ const cal=calOf(d,x), p=gridPass(x), dec=top?.at===i;
        return `<tr><td>${esc(has(x.freq)?x.freq:"—")}${rs.length>1&&dec?' <span class="tag">decides</span>':""}</td>${isCell(x)?`<td colspan="5" class="hint">Cellular: ${esc(cellTxt(x))}</td>`:`<td class="n">${x.dl??""}</td><td class="n">${x.daq??""}</td><td class="n">${[x.sinr,has(x.ber)?x.ber+"%":""].filter(v=>has(v)).join(" / ")}</td><td class="n">${x.ul??""}</td><td class="n">${x.ul_daq??""}</td>`}
          <td>${esc(cal?cal.name:x.inst==="uncal"?"not calibrated":"")}</td><td>${isCell(x)?'<span class="hint">not scored</span>':cal&&!cal.ok?'<span class="hint">not counted</span>':p==null?"":p?"pass":"fail"}</td>
          <td style="white-space:nowrap">${isCell(x)?"":`<button data-ge="${i}">Edit</button> `}<button data-gx="${i}">Delete</button></td></tr>`; }).join("")}</tbody></table></div>`:""}
      <div class="row" style="align-items:flex-end"><b>Square ${f.name}-${g}</b><label>Channel / MHz<input id="ge_freq" placeholder="optional" style="width:110px"></label>${KS.map(([k,l,s])=>`<label>${l}<input id="ge_${k}" type="number" step="${s}" style="width:72px"></label>`).join("")}
      <label class="grow">Note<input id="ge_note"></label><button class="primary" id="geSave">${rs.length?"Save reading":"Save"}</button><button id="geClear" title="Remove every reading in this square">Clear square</button></div>
      <p class="hint" style="margin:4px 0 0">Saved as taken with ${esc(inst==="uncal"?"no calibrated instrument (pre-survey, not counted)":instName(insts.find(i=>instKey(i)===inst)||{model:inst}))}. ${rs.length?"A reading on a channel already here replaces it; a new channel adds a row. The square passes only when every channel passes.":"Add a channel to keep one reading per channel."}</p>`;
    const put=async list=>{ const results={...((j.data.grid||{}).results||{})}; if(list.length) results[key]={readings:list}; else delete results[key];
      j=await save({grid:{...(j.data.grid||{}),results}}); render(); };
    const fill=x=>{ $("#ge_freq").value=x?.freq??""; for(const [k] of KS) $(`#ge_${k}`).value=x?.[k]??""; $("#ge_note").value=x?.note||""; };
    // a square with one reading and no channel opens with it filled in, as before; otherwise the form adds a reading
    // (Edit on a row fills it in to change that one)
    if(rs.length===1&&!isCell(rs[0])&&!has(rs[0].freq)){ editing=0; fill(rs[0]); }
    $("#dgEdit").querySelectorAll("[data-ge]").forEach(b2=>b2.onclick=()=>{ editing=+b2.dataset.ge; fill(rs[editing]); $("#ge_dl").focus(); });
    $("#dgEdit").querySelectorAll("[data-gx]").forEach(b2=>b2.onclick=()=>put(rs.filter((_,i)=>i!==+b2.dataset.gx)));
    const v2=k=>$(`#ge_${k}`).value===""?null:+$(`#ge_${k}`).value;
    $("#geSave").onclick=()=>{ const x={freq:$("#ge_freq").value.trim()||null, dl:v2("dl"), daq:v2("daq"), sinr:v2("sinr"), ber:v2("ber"), ul:v2("ul"), ul_daq:v2("ul_daq"),
        note:$("#ge_note").value, time:new Date().toISOString(), source:"typed", inst};
      const rest=rs.filter((y,i)=>i!==editing&&chKey(y)!==chKey(x)); put([...rest, x]); };
    $("#geClear").onclick=()=>put([]); $("#ge_dl").focus(); });
  el.querySelectorAll("tr[data-ca] input").forEach(i=>i.onchange=async()=>{ if(needInst()){ render(); return; }
    const tr=i.closest("tr"), a=tr.dataset.ca, val={...((j.data.grid||{}).critical||{})[a]};
    val[i.dataset.x]=i.value===""?null:+i.value; val.inst=inst; val.time=new Date().toISOString();
    j=await save({grid:{...(j.data.grid||{}),critical:{...((j.data.grid||{}).critical||{}),[a]:val}}}); render(); });
  const flat=()=>dasFlat(j.data);
  $("#dgCsv").onclick=()=>dasDl(`${fileSafe(j.name)} grid test.csv`, csvOf(flat()), "text/csv");
  $("#dgJson").onclick=()=>dasDl(`${fileSafe(j.name)} grid test.json`, JSON.stringify({job:j.name, threshold_dbm:DASJ.threshold, daq:DASJ.daq, results:dasFlat(j.data, true)},null,1), "application/json");
  $("#dgImp").onchange=async e=>{ const file=e.target.files[0]; if(!file) return; let t;
    if(needInst()){ e.target.value=""; return; }
    try{ t=await api(`/api/das/parse?name=${encodeURIComponent(file.name)}`,{method:"POST",body:await file.arrayBuffer()}); }catch(err){ alert("Couldn't read that file: "+err.message); return; }
    dasMapImport($("#dgMap"), t, file.name, {floors, floor:D.floor}, async mapped=>{ const results={...((j.data.grid||{}).results||{})}; let n2=0, nCell=0;
      // every row is kept: several rows for one square (one per channel or system) all stay and the worst decides; a row
      // replaces what that square already had on the same channel, and the square's other channels stay
      const by={}, at=new Date().toISOString();
      for(const r of mapped){ const fl=r.floor||D.floor, g=r.grid; if(!g) continue; const {floor,grid,critical,...vals}=r;
        (by[`${fl}|${g}`]||=[]).push({...vals, time:vals.time||at, source:file.name, inst}); n2++; if(isCell(vals)) nCell++; }
      for(const [k,rows] of Object.entries(by)){ const keys=new Set(rows.map(chKey)); results[k]={readings:[...readingsOf(results[k]).filter(x=>!keys.has(chKey(x))), ...rows]}; }
      // floors named in the file that the job doesn't have yet are added; squares the file marks critical (the phone's
      // grid test does) join that floor's critical list
      const have=new Set((j.data.floors||[]).map(x=>x.name)), extra=[...new Set(mapped.map(r=>r.floor).filter(x=>x&&!have.has(x)))].map(x=>({name:x,grids:DAS.grids}));
      const isCrit=v=>/^(1|y|yes|true|critical)$/i.test(String(v??"").trim());
      const floors=[...(j.data.floors||[]),...extra].map(f=>{ const add=mapped.filter(r=>(r.floor||D.floor)===f.name&&isCrit(r.critical)).map(r=>+r.grid||r.grid);
        return add.length?{...f, critical:[...new Set([...(f.critical||[]),...add])]}:f; });
      j=await save({grid:{...(j.data.grid||{}),results}, floors});
      await post(`/api/das/jobs/${j.id}/note`,{text:`Imported ${n2} grid readings from ${file.name}${nCell?` (${nCell} cellular, kept but not scored)`:""}, taken with ${inst==="uncal"?"no calibrated instrument":inst.replace("|"," ")}`}); render(); }); };
  $("#dgAll").onclick=()=>dasDl(`${fileSafe(j.name)} all readings.csv`, csvOf(dasReadings(j.data)), "text/csv");
  // Place grid: drag the grid to move it, the corner dot to size it (about its centre, along its own sides), the top dot to turn it
  $("#dgW")?.addEventListener("change", async e=>{ const all=(j.data.design||{}).floors||{};
    j=await save({design:{...(j.data.design||{}), floors:{...all, [f.name]:{...(all[f.name]||{}), width_ft:+e.target.value||null}}}}); render(); });
  $("#dgRot")?.addEventListener("change", e=>setFloor({gridbox:{...box, rot:Math.max(-180,Math.min(180,+e.target.value||0))}}));
  $("#dgFit")?.addEventListener("click", ()=>setFloor({gridbox:null}));
  const img=$("#dgImg"), sizeNote=b=>{ const out=$("#dgSize"); if(!out||!wft||!img?.naturalWidth) return;
    const hft=wft*img.naturalHeight/img.naturalWidth, sw=b.w/100*wft/cols, sh=b.h/100*hft/rows, [lo,hi]=DAS.cell_ft, bad=Math.max(sw,sh)>hi||Math.min(sw,sh)<lo;
    out.innerHTML=`Each square is about <b>${Math.round(sw)} × ${Math.round(sh)} ft</b>${bad?` <span style="color:var(--bad)">· NFPA 1225 asks ${lo}–${hi} ft: ${Math.max(sw,sh)>hi?"add squares or shrink the grid":"fewer squares will do"}</span>`:` · within the ${lo}–${hi} ft NFPA 1225 asks`}.`; };
  if(img){ if(img.complete) sizeNote(box); else img.onload=()=>sizeNote(box); }
  if(place){ const wrap=$("#dgWrap"), gd=$("#dgCells"), b={...box}; let drag=null;
    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const paint=()=>{ Object.assign(gd.style,{left:`${b.cx-b.w/2}%`, top:`${b.cy-b.h/2}%`, width:`${b.w}%`, height:`${b.h}%`, transform:`rotate(${b.rot}deg)`}); $("#dgRot").value=b.rot; sizeNote(b); };
    gd.onpointerdown=e=>{ drag={h:e.target.dataset?.h||"move", x0:e.clientX, y0:e.clientY, b0:{...b}, R:wrap.getBoundingClientRect()}; gd.setPointerCapture(e.pointerId); e.preventDefault(); };
    gd.onpointermove=e=>{ if(!drag) return; const {R,b0}=drag, cx=R.left+b0.cx/100*R.width, cy=R.top+b0.cy/100*R.height;
      if(drag.h==="move"){ b.cx=clamp(b0.cx+(e.clientX-drag.x0)/R.width*100,0,100); b.cy=clamp(b0.cy+(e.clientY-drag.y0)/R.height*100,0,100); }
      else if(drag.h==="size"){ const a=b0.rot*Math.PI/180, vx=e.clientX-cx, vy=e.clientY-cy;
        b.w=clamp(2*Math.abs(vx*Math.cos(a)+vy*Math.sin(a))/R.width*100,3,300); b.h=clamp(2*Math.abs(-vx*Math.sin(a)+vy*Math.cos(a))/R.height*100,3,300); }
      else { let r2=Math.round((Math.atan2(e.clientY-cy, e.clientX-cx)*180/Math.PI+90)*2)/2; if(r2>180) r2-=360; b.rot=r2; }
      paint(); };
    gd.onpointerup=gd.onpointercancel=()=>{ if(!drag) return; drag=null;
      setFloor({gridbox:{cx:+b.cx.toFixed(2), cy:+b.cy.toFixed(2), w:+b.w.toFixed(2), h:+b.h.toFixed(2), rot:b.rot}}); }; }
  window.dasAcceptPanel?.($("#dgAccept"), j, save);  // the acceptance tests beyond the grid (dasahj.js)
  // Walk (daswalk.js): the walk view in Walk mode; in every mode, the walk's points rolled up into these squares
  window.dasWalkHook?.(el, j, save, {f, hasPlan, planSrc, insts, inst, instOpts});
}
// where a floor's grid sits on its plan, in percent of the plan (centre, size) and degrees; the whole plan by default
const boxOf = f => ({cx:50, cy:50, w:100, h:100, rot:0, ...(f.gridbox||{})});
const boxCss = (f, onPlan=!!f.plan) => { if(!onPlan) return "inset:0"; const b=boxOf(f); return `left:${b.cx-b.w/2}%;top:${b.cy-b.h/2}%;width:${b.w}%;height:${b.h}%;transform:rotate(${b.rot}deg)`; };
// a job file (a floor plan) as an address the page can show. Fetched through the page, because the web version answers
// /api/ itself and a plain <img src="/api/..."> would leave the site; kept for the visit (job files are never overwritten)
const JOB_SRC=new Map();
function jobFileSrc(jid, name){ const k=`${jid}|${name}`;
  if(!JOB_SRC.has(k)) JOB_SRC.set(k, fetch(`/api/das/jobs/${jid}/file?name=${encodeURIComponent(name)}`)
    .then(r=>{ if(!r.ok) throw new Error(String(r.status)); return r.blob(); }).then(b=>URL.createObjectURL(b))
    .catch(()=>{ JOB_SRC.delete(k); return null; }));
  return JOB_SRC.get(k); }
// every reading as rows: the grid test's CSV / JSON and the report's tables (one row per square: the reading that decides it)
function dasFlat(d, withReadings=false){
  const floors=Array.isArray(d.floors)?d.floors:[], res=(d.grid||{}).results||{}, cr=(d.grid||{}).critical||{}, base=d.baseline;
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])], out=[];
  const row=(floor,grid,critical,r0,b0)=>{ const r=eff(d,r0)||{}, b=eff(d,b0), cal=calOf(d,r), p0=gridPass(r), um=ulMissing(d,r), u=cal&&cal.ok?ulSquare(d,r):null, p=p0===true&&u&&u.fail?false:p0;
    return {floor, grid, critical:critical?"yes":"", channel:r.freq??"", channels:r.channels??(has(r.dl)||has(r.daq)||has(r.sinr)?1:""), dl_dbm:r.dl??"", dl_daq:r.daq??"", sinr_db:r.sinr??"", ber_pct:r.ber??"", ul_dbm:r.ul??"", ul_daq:r.ul_daq??"",
      pass:p==null?"":cal&&!cal.ok?"not counted":um?"no uplink":p?"pass":"fail", instrument:cal?cal.name:"", counted:cal?(cal.ok?"yes":`no: ${cal.why}`):"",
      baseline_dl_dbm:b?.dl??"", change_db:has(r.dl)&&b&&has(b.dl)?Math.round(+r.dl-+b.dl):"", cellular:r.cellular||"", note:r.note||"", time:r.time||"", source:r.source||"",
      ...(withReadings?{readings:readingsOf(r0)}:{})}; };
  for(const x of floors){ const skip=new Set(x.skip||[]), cs=new Set(x.critical||[]);
    for(let g=1; g<=(x.grids||DAS.grids); g++) if(!skip.has(g)) out.push(row(x.name, `${x.name}-${g}`, cs.has(g), res[`${x.name}|${g}`]||{}, base?.results?.[`${x.name}|${g}`])); }
  for(const a of crit) out.push(row("named critical area", a, true, cr[a]||{}, base?.critical?.[a]));
  return out;
}
// every reading, one row per channel (cellular too), in the columns the grid import reads, so it goes back in as it came out
function dasReadings(d){
  const out=[];
  for(const x of (Array.isArray(d.floors)?d.floors:[])) for(let g=1; g<=(x.grids||DAS.grids); g++)
    for(const r of readingsOf(((d.grid||{}).results||{})[`${x.name}|${g}`])){ const cal=calOf(d,r), p=isCell(r)?null:gridPass(r);
      out.push({floor:x.name, grid:`${x.name}-${g}`, critical:(x.critical||[]).includes(g)?"yes":"", channel:r.freq??"", technology:r.tech??"", carrier:r.carrier??"", band:r.band??"", dl_mhz:r.mhz??"", pci:r.pci??"",
        dl_dbm:r.dl??"", dl_daq:r.daq??"", sinr_db:r.sinr??"", ber_pct:r.ber??"", ul_dbm:r.ul??"", ul_daq:r.ul_daq??"", rsrp_dbm:r.rsrp??"", rsrq_db:r.rsrq??"",
        x:r.x??"", y:r.y??"", latitude:r.lat??"", longitude:r.lon??"", instrument:cal?cal.name:r.inst==="uncal"?"not calibrated":"",
        result:isCell(r)?"cellular, not scored":p==null?"":cal&&!cal.ok?"not counted":p?"pass":"fail", time:r.time||"", source:r.source||"", note:r.note||""}); }
  return out;
}
// column mapping preview for any imported table
function dasMapImport(el, t, fname, where, done){
  const fields=[["floor","Floor"],["grid","Grid / area"],["freq","Channel / MHz"],["dl","DL dBm"],["daq","DL DAQ"],["sinr","SINR dB"],["ber","BER %"],["ul","UL dBm"],["ul_daq","UL DAQ"],
    ["tech","Technology"],["carrier","Carrier (cellular)"],["rsrp","RSRP dBm (cellular)"],["rsrq","RSRQ dB (cellular)"],["pci","PCI (cellular)"],["band","Band"],["mhz","DL MHz"],
    ["x","Plan X"],["y","Plan Y"],["lat","Latitude"],["lon","Longitude"],["critical","Critical area"],["note","Note"],["time","Time"]];
  const opts=h=>`<option value="">—</option>${t.headers.map(x=>`<option ${x===h?"selected":""}>${esc(x)}</option>`).join("")}`;
  // a report taken at one spot (a COMPASS Full Signal Report) or any table with no grid column: every row goes in one square
  const squares=(where.floors||[]).flatMap(fl=>Array.from({length:fl.grids||DAS.grids},(_,i)=>i+1).filter(g=>!(fl.skip||[]).includes(g)).map(g=>[`${fl.name}|${g}`,`${fl.name}-${g}`]));
  el.innerHTML=`<div class="panel" style="margin-top:10px"><h3>Import ${esc(fname)} <span class="hint">· ${esc(t.format==="compass"?"Cel-Fi COMPASS Full Signal Report":t.format.toUpperCase())}, ${t.total.toLocaleString()} rows · check the columns, then import</span></h3>
    ${t.format==="compass"?'<p class="status" style="margin:0 0 6px">A COMPASS report is one spot: pick the square it was taken in. Each cell it heard becomes a cellular reading there (carrier, band, PCI, RSRP, RSRQ); a cell listed twice under one carrier is kept once.</p>':""}
    <div class="row">${fields.map(([k,l])=>`<label>${l}<select data-m="${k}">${opts(t.guess[k])}</select></label>`).join("")}
      <label title="Rows with no grid or area (all of them when there's no grid column) go in this square">Rows with no grid go in<select id="dmAll"><option value="">— skip them —</option>${squares.map(([k,l])=>`<option value="${esc(k)}">${esc(l)}</option>`).join("")}</select></label>
      <button class="primary" id="dmGo">Import</button><button id="dmNo">Cancel</button></div>
    <div class="tw" style="max-height:240px;margin-top:8px"><table><thead><tr>${t.headers.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${t.rows.slice(0,12).map(r=>`<tr>${t.headers.map(h=>`<td>${esc(r[h]??"")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="hint">Rows without a grid or area are skipped. Grid names like “Grid 7” or “2-7” are read as square 7. Floors the file names that this job doesn't have yet are added.
      Several rows for one square (one per channel or system) are all kept, and the worst decides it; a row replaces what that square already had on the same channel.
      Cellular rows (LTE or 5G, or any row with RSRP / RSRQ) are kept and shown but never scored against these public-safety rules.</p></div>`;
  el.scrollIntoView({behavior:"smooth",block:"start"});
  $("#dmNo").onclick=()=>{ el.innerHTML=""; };
  $("#dmGo").onclick=()=>{ const m={}; el.querySelectorAll("[data-m]").forEach(s=>{ if(s.value) m[s.dataset.m]=s.value; });
    const all=$("#dmAll").value, [allF, allG]=all?all.split("|"):["",""];
    if(!m.grid&&!all){ alert("Pick the column that names the grid square or area, or the square these readings were taken in (Rows with no grid go in)."); return; }
    const numv=x=>{ const v=parseFloat(String(x??"").replace(/[^\d.\-]/g,"")); return isFinite(v)?v:null; };
    done(t.rows.map(r=>{ const o={floor:m.floor?String(r[m.floor]||"").trim():"", grid:m.grid?String(r[m.grid]||"").trim().replace(/^(grid|area|square|cell)\s*#?\s*/i,"").replace(/^[^-]+-(\d+)$/,"$1"):""};
      if(!o.grid&&all){ o.floor=allF; o.grid=allG; }
      for(const k of ["dl","daq","sinr","ber","ul","ul_daq","rsrp","rsrq","x","y","lat","lon","mhz"]) if(m[k]) o[k]=numv(r[m[k]]);
      for(const k of ["freq","tech","pci","carrier","band"]) if(m[k]&&String(r[m[k]]??"").trim()!=="") o[k]=String(r[m[k]]).trim();
      if(m.note) o.note=r[m.note]; if(m.time) o.time=r[m.time]; if(m.critical) o.critical=r[m.critical]; return o; })); };
}

/* ---------- files: anything, kept in the job's Drive folder ---------- */
async function dasFiles(el, j){
  let f; try{ f=await api(`/api/das/jobs/${j.id}/files`); }catch(e){ el.innerHTML=`<p class="status err">${esc(e.message)}</p>`; return; }
  if(!el.isConnected) return;  // a newer draw took over while this one waited
  const size=b=>b>1e6?`${(b/1e6).toFixed(1)} MB`:`${Math.max(1,Math.round(b/1e3))} KB`;
  el.innerHTML=`<div class="panel"><h3>Files <span class="hint">· ${esc(f.folder)}</span></h3>
    <div id="dfDrop" style="border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;margin-bottom:10px">Drop any files here (floor plans, drawings, PDFs, photos, letters, test exports) or <label style="display:inline"><u>choose files</u><input type="file" id="dfIn" multiple hidden></label>.
      <div class="hint">${S.me||(S.das?.folder||"").startsWith("/rfr/")?"They're saved with the job on this copy, for the people who can open the job.":"They're saved in the job's folder in Drive, so anyone the folder is shared with sees them."} A file with the same name is kept as a second copy, never overwritten.</div></div>
    ${f.files.length?`<div class="tw"><table><thead><tr><th>File</th><th>What it is</th><th class="n">Size</th><th>Added</th><th></th></tr></thead><tbody>${f.files.map(x=>`<tr><td><a href="/api/das/jobs/${j.id}/file?name=${encodeURIComponent(x.name)}" target="_blank" rel="noopener">${esc(x.name)}</a></td><td>${esc(x.kind_label||"")}</td><td class="n">${size(x.size)}</td><td class="mono">${esc(x.modified)}</td><td><button data-rm="${esc(x.name)}">Delete</button></td></tr>`).join("")}</tbody></table></div>`:'<p class="hint">No files yet.</p>'}
    <p class="hint" id="dfMsg"></p></div>`;
  const up=async list=>{ for(const file of list){ $("#dfMsg").textContent=`Saving ${file.name}…`; await api(`/api/das/jobs/${j.id}/files?name=${encodeURIComponent(file.name)}`,{method:"POST",body:await file.arrayBuffer()}); } render(); };
  $("#dfIn").onchange=e=>up([...e.target.files]);
  const dz=$("#dfDrop"); dz.ondragover=e=>{ e.preventDefault(); dz.style.borderColor="var(--accent)"; }; dz.ondragleave=()=>{ dz.style.borderColor=""; };
  dz.ondrop=e=>{ e.preventDefault(); dz.style.borderColor=""; up([...e.dataTransfer.files]); };
  el.querySelectorAll("[data-rm]").forEach(b=>b.onclick=async()=>{ if(!confirm(`Delete ${b.dataset.rm}?${S.me||(S.das?.folder||"").startsWith("/rfr/")?" It can't be brought back.":" Drive keeps it in its bin for 30 days."}`)) return; await post(`/api/das/jobs/${j.id}/files/delete?name=${encodeURIComponent(b.dataset.rm)}`); render(); });
}

function dasLog(el, j){
  // Log (notes and what happened), History (every change, Undo / Restore) and Sharing (access, AHJ review, links): dasrev.js
  const D=S.das, views=[["log","Log"],...(window.dasHistory?[["history","History"]]:[]),...(window.dasAccess?[["access","Sharing"]]:[])], v=views.some(x=>x[0]===D.logView)?D.logView:"log";
  el.innerHTML=`${views.length>1?`<div class="seg" id="dlSeg" style="margin-bottom:10px">${views.map(([k,l])=>`<button data-v="${k}" class="${v===k?"on":""}">${l}</button>`).join("")}</div>`:""}<div id="dlView"></div>`;
  $("#dlSeg")?.addEventListener("click", e=>{ const b=e.target.closest("button"); if(b){ D.logView=b.dataset.v; dasLog(el, j); } });
  const body=$("#dlView");
  if(v==="history") return window.dasHistory(body, j);
  if(v==="access") return window.dasAccess(body, j);
  body.innerHTML=`<div class="panel"><h3>Log</h3><div class="row"><input id="dlNote" class="grow" placeholder="Add a note (site visit, call with the AHJ, punch item…)"><button class="primary" id="dlAdd">Add</button></div>
    <div class="tw" style="margin-top:8px;max-height:60vh"><table><tbody>${(j.log||[]).map(l=>`<tr><td class="mono" style="white-space:nowrap">${esc(l.ts)}</td><td>${esc(l.kind)}</td><td>${esc(l.detail)}</td></tr>`).join("")}</tbody></table></div></div>`;
  $("#dlAdd").onclick=async()=>{ const t=$("#dlNote").value.trim(); if(!t) return; await post(`/api/das/jobs/${j.id}/note`,{text:t}); render(); };
}

// the data notices a printed report must carry (build.py NOTICES): the FCC's always (the systems come from ULS);
// the ODbL one when the job has a building outline (OpenStreetMap, or Overture when OpenStreetMap had none)
function dasCredits(d){
  const n=(S.build||{}).notices||{}, b=d.building;
  const lines=[n.fcc, b&&(/Overture/.test(b.source||"")||b.gers_id?n.overture:n.osm)].filter(Boolean);
  return lines.length?`<p class="hint" style="margin-top:16px;font-size:11px">${lines.map(esc).join(" ")}</p>`:"";
}

/* ---------- report for the AHJ (print to PDF): summary, then each floor's plan and readings ---------- */
// a step skipped in Start, on what gets handed over, so a skipped step can't pass for a finished one (start.js)
window.dasSkipLines=d=>{ const s=(d.guided||{}).skips||{}, name={survey:"Survey",design:"Design"};
  return Object.keys(s).map(k=>`<p class="st-skip">${esc(name[k]||k)} step skipped by ${esc(s[k].by||"the user")} on ${esc(s[k].at)}: ${esc(s[k].why)}</p>`).join(""); };
function dasReport(el, j){
  if(S.das.rview==="submittal"&&window.dasSubmittal) return window.dasSubmittal(el, j);  // the design submittal (dasdesign.js)
  const d=j.data||{}, floors=Array.isArray(d.floors)?d.floors:[], cs=S.das.contacts, who=k=>cs.find(c=>String(c.id)===String((d.contacts||{})[k]));
  const crit=[...((d.require||{}).critical||[]), ...((d.require||{}).other||[])], cr=(d.grid||{}).critical||{}, res=(d.grid||{}).results||{}, T=d.testing||{};
  const st=floors.map(f=>({f,...floorStats(d,f)}));
  // no floors means nothing was tested: every() is true on an empty list, so a blank job read "PASS" (11/3)
  const allTested=st.length>0&&st.every(x=>x.untested===0)&&crit.every(a=>scored(d,cr[a])!=null);
  const ok=allTested&&st.every(x=>x.ok)&&crit.every(a=>scored(d,cr[a]));
  const nc=st.reduce((s,x)=>s+x.notCounted,0)+crit.filter(a=>notCounted(d,cr[a])).length;
  const plan=(d.presurvey||{}).plan||[];
  const ulm=st.reduce((s,x)=>s+x.ulMissing,0)+crit.filter(a=>ulMissing(d,cr[a])).length, E=daqEq();
  const CO=dasCellOnly(d), CV=CO?dasCellVerdict(d):null, CP=CO&&window.cellProfile?cellProfile(d):null, LN=k=>(typeof LAYER_NAME!=="undefined"&&LAYER_NAME[k])||k;
  // a cellular job's own report: titled and judged per carrier; the emergency responder parts stay off it
  const cellRep=()=>{ let h=window.dasCellReport?dasCellReport(d):""; if(!CO) return h;
    return h.replace('<div style="break-before:page;margin-top:16px">', '<div style="margin-top:12px">').replace("Reported apart from the emergency responder result above and never counted in it. ", ""); };
  const cell=(f,g)=>{ const r=eff(d, res[`${f.name}|${g}`]), p=scored(d,r), n2=notCounted(d,r), um=ulMissing(d,r), sk=(f.skip||[]).includes(g), c=(f.critical||[]).includes(g);
    return `<div style="border:${c?"2px solid #b8860b":n2?"1px dashed #777":"1px solid #999"};display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px;
      background:${sk?"repeating-linear-gradient(45deg,#ddd 0 5px,transparent 5px 10px)":n2?"rgba(140,149,159,.45)":p==null?"rgba(255,255,255,.55)":p?"rgba(60,207,122,.55)":"rgba(229,83,75,.6)"}">
      <b>${esc(f.name)}-${g}${c?" ★":""}</b>${sk?"not tested":r&&has(r.dl)?`${r.dl} dBm`:""}${n2?"<span>not counted</span>":""}${um?"<span>no uplink</span>":""}</div>`; };
  el.innerHTML=`<div class="maptools no-print"><div class="seg" id="drView"><button data-rv="test" class="on">Test report</button><button data-rv="submittal">Design submittal</button></div>
    <button class="primary" id="drPrint">⎙ Print / save as PDF</button>${window.dasSealPrint?`<button id="drFinal" title="Seals the report: RF Recon keeps a SHA-256 of what prints and a verify code, and prints the code and date on every page">⎙ Print as final (sealed)</button>`:""}${window.rfMail?`<button id="drMail" title="Email the AHJ from your own mailbox with the report PDF from the job's Files; their reply comes back into the job">✉ Email the AHJ</button>`:""}<span class="hint">Prints the report only. Choose “Save as PDF”, then add the PDF to the job's Files.</span></div>
  <div id="drMailBox" class="no-print"></div>
  <div id="drAhjTop" class="no-print"></div>
  <div class="panel" id="dasPrint">
    <h2 style="margin:0 0 4px">${CO?"Commercial cellular coverage test":"Emergency responder radio coverage test"}: ${esc(j.name)}</h2>
    <p style="margin:0 0 10px">${esc(d.address||"")} · ${esc(d.ahj||(CO?"":"AHJ not set"))}${d.ahj||!CO?" · ":""}${esc(d.code||(CO?"Owner's carrier requirements":"IFC 510 + NFPA 1225"))} · prepared ${esc(today())}</p>
    ${CO?`<p style="font-size:18px;margin:6px 0"><b>Result: ${CV.ok===true?'<span class="res-pass">PASS</span>':CV.ok===false?'<span class="res-fail">FAIL</span>':CV.lines.length?"Not complete (carriers untested below)":"Not complete (no carrier readings yet: Grid test)"}</b></p>
    <p style="margin:0 0 6px">${CV.lines.map(x=>`${esc(x.L.carrier)}, ${esc(LN(x.L.layer))}: <b>${x.ok===true?"pass":x.ok===false?"fail":"untested"}</b>`).join(" · ")}</p>
    <p class="hint">Pass criteria: ${CP?`${esc(CP.name)}: each required carrier's best cell RSRP ≥ ${CP.rsrp} dBm${CP.rsrp_hi!=null&&CP.rsrp_hi!==CP.rsrp?` (≥ ${CP.rsrp_hi} dBm from 3.3 GHz)`:""}${CP.sinr!=null?` with SINR ≥ ${CP.sinr} dB`:""} on ${CP.pct}% of the tested squares on each floor${CP.carriers?.length?`; carriers required: ${esc(CP.carriers.join(", "))}`:""}. ${esc(CP.preset==="custom"?"":CP.src||"")}`:"the cellular target under Requirements."} Only readings taken with an instrument calibrated within ${DAS.cal_months} months of the reading are scored.</p>`:`
    <p style="font-size:18px;margin:6px 0"><b>Result: ${allTested?(ok?'<span class="res-pass">PASS</span>':'<span class="res-fail">FAIL</span>'):st.length?"Not complete (untested areas below)":"Not complete (no floors tested yet: add them under Grid test)"}</b></p>`}
    ${dasSkipLines(d)}<div id="drPacket"></div>
    ${CO?"":`<p class="hint">Pass criteria: each test location ${DASJ.threshold==null?"with no dBm floor (DAQ decides)":`≥ ${DASJ.threshold} dBm downlink and uplink`}, DAQ ≥ ${DASJ.daq} both ways (or SINR ≥ ${E.sinr} dB with BER ≤ ${E.ber}%: ${esc(E.sinr_src)}${E.ber_src!==E.sinr_src?`; BER: ${esc(E.ber_src)}`:""})${DASJ.either?", the level or the BER passing the square":""}, on every channel tested there (the worst channel is shown)${DASJ.ul_required?`; an uplink reading in every square (${esc((DASJ.cite||{}).ul_required||"this job's requirement")}): a square without one is untested`:""}; ${DASJ.general_pct}% of general areas and ${DASJ.critical_pct}% of critical areas on each floor. Each floor's grid: ${esc(dasRuleText(DASJ.grid_rule))}${DASJ.profile_name?` (profile: ${esc(DASJ.profile_name)})`:""}. Only readings taken with an instrument calibrated within ${DAS.cal_months} months of the reading are scored.</p>`}
    ${!CO&&ulm?`<p style="margin:4px 0"><b>${ulm} square${ulm===1?" has":"s have"} no uplink reading</b>: this AHJ requires uplink in every square, so ${ulm===1?"it is":"they are"} untested for uplink, not passed.</p>`:""}
    ${!CO&&nc?`<p style="margin:4px 0"><b>${nc} reading${nc===1?" was":"s were"} not scored</b>: taken without a calibrated instrument, or with no instrument recorded. They are shown grey (“not counted”) as pre-survey information only.</p>`:""}
    <h3>Building and people</h3><div class="kvg"><div>Building</div><div>${esc([j.name, d.address, d.floors?.length?`${d.floors.length} floors`:"", d.area_sqft?`${Number(d.area_sqft).toLocaleString()} sq ft`:"", d.construction].filter(Boolean).join(" · "))}</div>
      ${DAS_ROLES.map(([k,l])=>{ const c=who(k); return c?`<div>${esc(l)}</div><div>${esc([c.name,c.org,c.phone,c.email].filter(Boolean).join(" · "))}</div>`:""; }).join("")}</div>
    <h3>Tester and instruments</h3><div class="kvg"><div>Tester</div><div>${esc(T.tester||"not set")}</div><div>FCC GROL</div><div>${esc(T.grol||"–")}</div><div>NICET</div><div>${esc(T.nicet||"–")}</div><div>Test date${T.date2?"s":""}</div><div>${esc([T.date,T.date2].filter(Boolean).join(" to ")||"–")}</div></div>
      ${(T.instruments||[]).length?`<table style="margin-top:6px"><thead><tr><th>Instrument</th><th>Serial</th><th>Calibrated</th><th>Certificate</th><th>Status</th></tr></thead><tbody>${T.instruments.map(i=>{ const s=instState(i), c=typeof ahjCertState==="function"?ahjCertState(i):null;
        return `<tr><td>${esc(i.model)}</td><td class="mono">${esc(i.serial)}</td><td class="mono">${esc(i.cal)}</td><td>${esc(i.cert?`${i.cert}${c?.exp?`, to ${c.exp}`:""}`:"none on file")}</td><td style="color:${!s.ok?"#cf222e":c&&c.k==="warn"&&c.left!=null&&c.left<=30?"#9a6700":"#1a7f37"}">${!s.ok?esc(s.why):c&&c.left!=null&&c.left<=30?esc(c.t):"current"}</td></tr>${(i.prior||[]).map(p=>`<tr><td>${esc(i.model)}</td><td class="mono">${esc(i.serial)}</td><td class="mono">${esc(p.cal||"–")}</td><td>${esc(p.cert?`${p.cert}${p.expires?`, to ${p.expires}`:""}`:"none on file")}</td><td>earlier calibration</td></tr>`).join("")}`; }).join("")}</tbody></table>`:'<p class="hint" style="color:#cf222e">No test instruments listed: no reading can be scored.</p>'}
    <h3>Compliance</h3><div class="kvg">${dasChecksFor(CO).map(([k,l])=>`<div>${esc(l)}</div><div>${esc((d.checks||{})[k]||"not on file")}</div>`).join("")}<div>Annual retest due</div><div>${esc(d.retest_due||"–")}</div>
      ${d.baseline?`<div>Compared with</div><div>the acceptance test of ${esc(d.baseline.date)}</div>`:""}
      ${CO?"":(()=>{ const mk=Object.keys(d.material_checks||{}).filter(k=>d.material_checks[k]); return `<div>Material rules confirmed</div><div>${mk.length?`${mk.length}: ${esc(mk.map(k=>k.split("|")[0]).join("; "))}`:"none ticked (Materials)"}</div>`; })()}</div>
    ${CO?"":`<h3>Systems covered</h3>`}${CO?"":plan.length?`<table><thead><tr><th>Agency</th><th>Call sign</th><th>Downlink MHz</th><th>Uplink MHz</th><th>Type</th></tr></thead><tbody>${plan.map(p=>`<tr><td>${esc(p.system)}</td><td class="mono">${esc(p.call_sign)}</td><td class="mono">${esc(p.downlink_mhz)}</td><td class="mono">${esc(p.uplink_mhz)}</td><td>${esc(p.technology)}</td></tr>`).join("")}</tbody></table>`:'<p class="hint">None chosen in the pre-survey.</p>'}
    <div id="drX"></div>
    <h3>System diagram: signal path, start to finish</h3><div id="drDiagram"><p class="hint">Drawing the diagram…</p></div>
    ${CO?cellRep():`<h3>Summary by floor</h3><table><thead><tr><th>Floor</th><th class="n">General pass</th><th class="n">Critical pass</th><th class="n">Untested</th><th class="n">Not counted</th><th>Result</th><th>Rule and reason</th></tr></thead><tbody>${st.map(x=>`<tr><td>${esc(x.f.name)}</td><td class="n">${x.genPass}/${x.gen} (${x.genPct}%)</td><td class="n">${x.crit?`${x.critPass}/${x.crit} (${x.critPct}%)`:"–"}</td><td class="n">${x.untested}${x.ulMissing?` (${x.ulMissing} no uplink)`:""}</td><td class="n">${x.notCounted||""}</td><td>${x.untested?"incomplete":x.ok?"pass":"<b>fail</b>"}</td><td>${esc(x.rule)}: ${esc(x.why)}</td></tr>`).join("")}
      ${crit.length?`<tr><td>Named critical areas</td><td></td><td class="n">${crit.filter(a=>scored(d,cr[a])).length}/${crit.length}</td><td class="n">${crit.filter(a=>scored(d,cr[a])==null).length}</td><td class="n">${crit.filter(a=>notCounted(d,cr[a])).length||""}</td><td></td><td>each must pass</td></tr>`:""}</tbody></table>
    ${st.map(x=>{ const f=x.f, n=f.grids||DAS.grids, cols=f.cols||(n===20?5:Math.ceil(Math.sqrt(n))), rows=Math.ceil(n/cols);
      return `<div style="break-before:page;margin-top:16px"><h3>Floor ${esc(f.name)}: ${x.genPass}/${x.gen} general${x.crit?`, ${x.critPass}/${x.crit} critical`:""} pass · ${x.untested?"incomplete":x.ok?"PASS":"FAIL"}</h3><p style="margin:0 0 6px">${esc(x.rule)}: ${esc(x.why)}</p>
        <div style="position:relative;width:100%;max-width:720px;${f.plan?"":`aspect-ratio:${cols}/${rows};`}border:1px solid #999;overflow:hidden">
          ${f.plan?`<img data-plan="${esc(f.plan)}" data-ar="${cols}/${rows}" alt="Floor ${esc(f.name)} plan" style="display:block;width:100%;height:auto;min-height:120px">`:""}
          <div style="position:absolute;${boxCss(f)};display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${Array.from({length:n},(_,i)=>cell(f,i+1)).join("")}</div></div>
        <table style="margin-top:8px"><thead><tr><th>Grid</th><th>Critical</th><th>Channel</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">SINR / BER</th><th class="n">UL dBm</th><th class="n">UL DAQ</th>${d.baseline?'<th class="n">vs baseline</th>':""}<th>Instrument</th><th>Result</th><th>Note</th></tr></thead><tbody>
        ${dasFlat(d).filter(r=>r.floor===f.name).map(r=>`<tr><td>${esc(r.grid)}</td><td>${r.critical?"★":""}</td><td>${esc(r.channel)}${r.channels>1?` <span class="hint">(worst of ${r.channels})</span>`:""}</td><td class="n">${r.dl_dbm}</td><td class="n">${r.dl_daq}</td><td class="n">${[r.sinr_db,r.ber_pct!==""?r.ber_pct+"%":""].filter(x=>x!=="").join(" / ")}</td><td class="n">${r.ul_dbm}</td><td class="n">${r.ul_daq}</td>${d.baseline?`<td class="n">${r.change_db!==""?(r.change_db>=0?"+":"")+r.change_db+" dB":""}</td>`:""}<td>${esc(r.instrument)}</td><td>${r.pass||"untested"}</td><td>${esc(r.note)}</td></tr>`).join("")}</tbody></table></div>`; }).join("")}
    ${crit.length?`<div style="margin-top:16px"><h3>Named critical areas</h3><table><thead><tr><th>Area</th><th class="n">DL dBm</th><th class="n">DL DAQ</th><th class="n">UL dBm</th><th class="n">UL DAQ</th><th>Instrument</th><th>Result</th></tr></thead><tbody>${crit.map(a=>{ const r=cr[a]||{}, p=scored(d,r), cal=calOf(d,r); return `<tr><td>${esc(a)}</td><td class="n">${r.dl??""}</td><td class="n">${r.daq??""}</td><td class="n">${r.ul??""}</td><td class="n">${r.ul_daq??""}</td><td>${esc(cal?cal.name:"")}</td><td>${cal&&!cal.ok?"not counted":ulMissing(d,r)?"untested: no uplink":p==null?"untested":p?"pass":"fail"}</td></tr>`; }).join("")}</tbody></table></div>`:""}
    ${cellRep()}`}
    <div id="drSweep"></div>
    <div id="drWalk"></div>
    <div id="drAccept"></div>
    <div id="drSign"></div>
    ${dasCredits(d)}
  </div>`;
  // each floor's plan under its grid; a plan that won't open leaves the grid at its own shape
  el.querySelectorAll("img[data-plan]").forEach(async im=>{ const s=await jobFileSrc(j.id, im.dataset.plan);
    if(s){ im.src=s; im.style.minHeight=""; } else { const box=im.parentElement, g=box.querySelector("div"); box.style.aspectRatio=im.dataset.ar; if(g) g.style.cssText=g.style.cssText.replace(/left:[^;]+;top:[^;]+;width:[^;]+;height:[^;]+;transform:[^;]+/,"inset:0"); im.remove(); } });
  window.dasWalkReport?.(el.querySelector("#drWalk"), j);  // the walk's heat maps (daswalk.js)
  window.dasSweepReport?.(el.querySelector("#drSweep"), j);  // PIM runs and sweeps (dassweep.js)
  if(window.dasCloseout&&window.coCarriers&&(dasCellOnly(d)||coCarriers(d).length)){ let box=el.querySelector("#drCloseout"); if(!box){ box=document.createElement("div"); box.id="drCloseout"; el.appendChild(box); } window.dasCloseout(box, j); }  // carrier closeout packages (dascloseout.js), outside the printed report
  $("#drPrint").onclick=()=>dasPrintCopy($("#dasPrint"));
  window.dasReportAhj?.(el, j);  // the AHJ packet index, acceptance tests, sign-off and the seal (dasahj.js)
  $("#drMail")&&($("#drMail").onclick=async()=>{ const word=S.das.rview==="submittal"?"design submittal":window.dasReportWord?.(d)||"acceptance test report", cs=S.das.contacts||[], ahj=cs.find(c=>String(c.id)===String((d.contacts||{}).ahj)), me=cs.find(c=>String(c.id)===String((d.contacts||{}).tech));
    const mf=await dasMailFiles(j), fl=mf.files;
    rfMail.compose($("#drMailBox"), {kind:"job", refs:{job_id:j.id, topic:"AHJ"}, title:"Email the AHJ", to:ahj?.email||"", ticked:mf.ticked,
      subject:`ERCES ${word}: ${j.name}${d.address?`, ${d.address}`:""}`,
      body:`Hello${ahj?.name?` ${ahj.name.split(" ")[0]}`:""},\n\nPlease find attached the ${word} for the emergency responder radio coverage system at ${j.name}${d.address?`, ${d.address}`:""}.\n\nPlease let us know if you need anything else or would like to schedule a witness test.\n\nThank you,\n${me?[me.name, me.org, me.phone].filter(Boolean).join("\n"):""}`,
      files:fl.filter(n=>/\.pdf$/i.test(n)).concat(fl.filter(n=>!/\.pdf$/i.test(n)))}); });
  // the diagram needs the link budget defaults and the cable tables loaded first: drawn before them, it showed a 0 dBm
  // radio and lossless cables (11/3)
  if(window.dasSchematic&&window.frLoad) Promise.all([frLoad("budget"), frLoad("parts")])
    .then(()=>{ const x=el.querySelector("#drDiagram"); if(x&&x.isConnected) x.innerHTML=window.dasSchematic(d); })
    .catch(e=>{ const x=el.querySelector("#drDiagram"); if(x) x.innerHTML=`<p class="hint">The diagram couldn't be drawn: ${esc(e.message)}</p>`; });
  window.dasXReport?.(el.querySelector("#drX"), j);  // licensee consent, FCC licence changes, the existing-system audit (dasx.js)
  $("#drView").onclick=e=>{ const b=e.target.closest("[data-rv]"); if(b){ S.das.rview=b.dataset.rv; render(); } };
}

// a job's files for an email box. The sealed report that still matches the job comes ticked (das.py sealed_files): one that doesn't is offered, not ticked
const dasMailFiles=async j=>{ const fs=(await api(`/api/das/jobs/${j.id}/files`).catch(()=>({files:[]}))).files||[], ticked=fs.filter(f=>f.packet).map(f=>f.name);
  return {files:[...ticked, ...fs.map(f=>f.name).filter(n=>!ticked.includes(n))], ticked}; };

/* ---------- a job's mail (Cody 11/4): email anyone on the job from your own mailbox, ask for the plans; replies and their
   attachments come back into the job (dasmail.js) ---------- */
function dasJobMail(el, j){
  if(!window.rfMail) return;
  const d=j.data||{}, cs=S.das.contacts||[], roles=d.contacts||{};
  const people=Object.entries(roles).map(([role,id])=>[role, cs.find(c=>String(c.id)===String(id))]).filter(([,c])=>c&&c.email);
  const me=cs.find(c=>String(c.id)===String(roles.tech));
  el.insertAdjacentHTML("beforeend", `<div class="panel" style="margin-top:12px" id="doMailPanel"><h3 style="margin-top:0">Mail <span class="hint">· from your own mailbox; replies and their attachments come back into this job</span></h3>
    <div id="doMailAll"></div><div class="row" style="gap:8px;flex-wrap:wrap"><button id="doMail">✉ Email about this job</button><button id="doPlansMail" title="Ask the owner, GC or architect for the floor plans; the PDFs they send back land in Files">✉ Ask for the plans</button></div>
    <div id="doMailBox"></div><div id="doMailThread"></div></div>`);
  const to=(...rs)=>{ for(const r of rs){ const p=people.find(([role])=>role===r); if(p) return p[1].email; } return ""; };
  const sig=me?["", me.name, me.org, me.phone].filter(Boolean).join("\n"):"";
  $("#doMail").onclick=async()=>{ const mf=await dasMailFiles(j); rfMail.compose($("#doMailBox"), {kind:"job", refs:{job_id:j.id, topic:"MAIL"}, title:`Email about ${j.name}`, to:to("owner","gc","ahj"),
    subject:`${j.name}${d.address?`, ${d.address}`:""}`, body:`Hello,\n\n\n${sig}`, write:true, templates:true, files:mf.files, ticked:mf.ticked, onSent:()=>rfMail.thread($("#doMailThread"), {job:j.id})}); };  // free-form: opens on the message
  $("#doPlansMail").onclick=async()=>rfMail.compose($("#doMailBox"), {kind:"job", refs:{job_id:j.id, topic:"PLANS"}, title:"Ask for the floor plans", to:to("owner","gc"),
    subject:`Floor plans for ${j.name}${d.address?`, ${d.address}`:""}`,
    body:`Hello,\n\nWe're designing the emergency responder radio coverage (ERCES) for ${j.name}${d.address?` at ${d.address}`:""}. Could you send the floor plans for every floor, as PDFs (architectural plans with walls, ideally the CAD-exported PDFs rather than scans), and the roof plan if there is one?\n\nA reply to this email with the files attached is all we need.\n\nThank you,${sig?"\n"+sig:""}`,
    onSent:()=>rfMail.thread($("#doMailThread"), {job:j.id})});
  rfMail.thread($("#doMailThread"), {job:j.id});
  rfMail.jobAll($("#doMailAll"), j, {onSent:()=>rfMail.thread($("#doMailThread"), {job:j.id})});
}

/* ---------- consent letters: 47 CFR 90.219(b)(1) asks for the licensee's consent before a booster retransmits its signal ---------- */
function dasConsentText(j, lic, ss){
  const d=j.data||{}, cs=S.das.contacts, me=cs.find(c=>String(c.id)===String((d.contacts||{}).tech)), cls=(d.booster_class||"Class A (channelized)");
  const A=window.dasConsentAddr?.(ss);  // the licence's own FCC contact record (dasx.js); never a made-up address
  return `${A&&A.lines.length?A.lines.join("\n"):`${lic}\nRadio system manager`}\n\nRe: Consent to retransmit under 47 CFR 90.219(b)(1): ${j.name}, ${d.address||""}\n\n`
    +`We are installing an emergency responder communication enhancement system (${cls} signal booster) at the building above so that responders' radios work inside it, as ${d.ahj||"the authority having jurisdiction"} requires under ${d.code||"IFC 510 and NFPA 1225"}.\n\n`
    +`The booster will retransmit only these channels licensed to you:\n`+ss.map(s=>`  ${s.call_sign}: downlink ${s.down.map(c=>fmtF(c.freq)).join(", ")} MHz; uplink ${s.up.map(fmtF).join(", ")||"to be confirmed"} MHz`).join("\n")
    +`\n\nWe ask for your written consent to retransmit these channels, and for any conditions you set (gain limits, donor site, filtering, monitoring, or contact for interference).${cls.startsWith("Class B")?" As a Class B booster it will also be registered with the FCC before it is switched on.":""}\n\n`
    +`A reply to this email with your consent is all we need.\n\nThank you,\n${me?[me.name, me.org, me.phone, me.email].filter(Boolean).join("\n"):""}`;
}
function dasConsentMail(box, j, systems){
  if(!window.rfMail) return;
  const by=new Map(); for(const s of systems){ if(!by.has(s.licensee)) by.set(s.licensee, []); by.get(s.licensee).push(s); }
  box.innerHTML=`<div class="panel" style="margin:8px 0"><div class="row" style="justify-content:space-between"><b>Email the consent requests</b><button class="sm" id="psLmX">✕</button></div>
    <p class="hint">One email per licensee from your own mailbox, to the email on the licence's own FCC record where it has one (often the radio shop or a consulting engineer: check it's the radio system manager). The signed reply lands in the job's Files and is noted here.</p>
    ${[...by].map(([lic,ss],i)=>{ const A=window.dasConsentAddr?.(ss); return `<div style="border-top:1px solid var(--line);padding:6px 0"><b>${esc(lic)}</b> <span class="hint">${ss.map(s=>esc(s.call_sign)).join(", ")}</span>
      <div class="hint">${A?`To: ${esc(A.email||"no email on the FCC record")} · ${esc(A.lines.join(", "))} · from the FCC licence record for ${esc(A.call)} (${esc(A.who)})`:"No FCC contact record kept for these licences"}</div>
      ${(j.data.consent_replies||{})[ss[0].call_sign]?`<span class="tag" style="background:var(--good);color:#fff">reply ${esc(j.data.consent_replies[ss[0].call_sign].at)}</span>`:""}
      <button class="sm" data-lmail="${i}">✉ Write</button><div data-lbox="${i}"></div></div>`; }).join("")}</div>`;
  $("#psLmX").onclick=()=>{ box.innerHTML=""; };
  const list=[...by];
  box.querySelectorAll("[data-lmail]").forEach(b=>b.onclick=()=>{ const [lic,ss]=list[+b.dataset.lmail];
    rfMail.compose(box.querySelector(`[data-lbox="${b.dataset.lmail}"]`), {kind:"job", refs:{job_id:j.id, topic:"CONSENT", extra:ss[0].call_sign}, title:`Consent request to ${lic}`,
      to:window.dasConsentAddr?.(ss)?.email||"", onSent:()=>window.dasConsentSent?.(j, lic, ss),
      subject:`Consent to retransmit ${ss.map(s=>s.call_sign).join(", ")}: ${j.name}`, body:dasConsentText(j, lic, ss)}); });
}

/* ---------- consent letters: 47 CFR 90.219(b)(1) asks for the licensee's consent before a booster retransmits its signal ---------- */
function dasConsent(j, systems){
  const d=j.data||{}, cs=S.das.contacts, me=cs.find(c=>String(c.id)===String((d.contacts||{}).tech)), cls=(d.booster_class||"Class A (channelized)");
  const by=new Map(); for(const s of systems){ if(!by.has(s.licensee)) by.set(s.licensee, []); by.get(s.licensee).push(s); }
  const box=document.createElement("div"); box.id="dasPrint"; box.className="panel";
  box.innerHTML=[...by].map(([lic,ss],i)=>{ const A=window.dasConsentAddr?.(ss); return `<div style="${i?"break-before:page;":""}padding:24px 8px;font-size:14px;line-height:1.5">
    <p>${esc(today())}</p><p>${A&&A.lines.length?`${A.lines.map((l,k)=>k?esc(l):`<b>${esc(l)}</b>`).join("<br>")}<br><span class="hint" style="font-size:11px">Address from the FCC licence record for ${esc(A.call)} (${esc(A.who)})</span>`:`<b>${esc(lic)}</b><br>Radio system manager`}</p>
    <p><b>Re: Consent to retransmit under 47 CFR 90.219(b)(1): ${esc(j.name)}, ${esc(d.address||"")}</b></p>
    <p>We are installing an emergency responder communication enhancement system (${esc(cls)} signal booster) at the building above so that responders' radios work inside it, as ${esc(d.ahj||"the authority having jurisdiction")} requires under ${esc(d.code||"IFC 510 and NFPA 1225")}.</p>
    <p>The booster will retransmit only the following channels licensed to you:</p>
    <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4"><thead><tr><th>Call sign</th><th>Downlink MHz (your sites)</th><th>Uplink MHz (radios)</th></tr></thead><tbody>
      ${ss.map(s=>`<tr><td>${esc(s.call_sign)}</td><td>${s.down.map(c=>fmtF(c.freq)).join(", ")}</td><td>${s.up.map(fmtF).join(", ")||"to be confirmed"}</td></tr>`).join("")}</tbody></table>
    <p>We ask for your written consent to retransmit these channels, and for any conditions you set (gain limits, donor site, filtering, monitoring, or contact for interference). ${cls.startsWith("Class B")?"As a Class B booster it will also be registered with the FCC under 47 CFR 90.219(d)(5).":""}</p>
    <p>Consent given by: ______________________________ Title: ____________________ Date: ____________</p>
    <p>Thank you,<br>${me?[me.name, me.org, me.phone, me.email].filter(Boolean).map(esc).join("<br>"):""}</p></div>`; }).join("");
  document.body.appendChild(box); document.body.classList.add("print-das"); window.print();
  setTimeout(()=>{ document.body.classList.remove("print-das"); box.remove(); },500);
}
