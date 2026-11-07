# ERCES / BDA link budgets for RF Recon: method, code numbers, defaults

Research date 2026-10-29. Every number below comes from a document opened during this research. Each one carries an inline link. The machine-readable version is `link_budget.json` in the same folder. Its keys are `sources`, `parameters`, `formulas`, `p1238`, `fcc_90_219`, `code`, `checks`, `portables` and `worked_example`.

The standards are summarized in my own words. Numeric table values are copied exactly. When sources disagree, all of them are shown. Paywalled documents are labelled, and so are the public summaries used in their place.

---

## 1. Method

### 1.1 Downlink chain (agency site → portable at the far edge)

Work in dBm/dB, per channel:

1. **Site radiated power.** Get the site ERP from the AHJ. IFC 2024 510.4.2.2 requires the fire code official to keep a technical document that lists the frequencies, site locations, **site ERP**, maximum propagation delay and applications ([IFC 2024 §510](https://codes.iccsafe.org/content/IFC2024V2.0/chapter-5-fire-service-features)). EIRP = ERP + 2.15 dB, because a half-wave dipole is 2.15 dBi ([TSB-88.1-C draft, Table D-2](http://www.simulcastsolutions.com/userfiles/file/appnotes/pTR8.18-06-10-0035-PN3-4744.1-RV3-Fb.pdf)).
2. **Outdoor path loss to the donor antenna.** Free space is the minimum: L = 32.4 + 20 log f(MHz) + 20 log d(km) ([ITU-R P.525-5 eq. 6](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf)). Durham requires FSPL estimates plus an elevation profile to the donor tower ([Durham BDA/ERCES requirements](https://www.durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-)). A measured donor RSSI beats any model.
3. **Donor antenna gain**, then **donor line loss**: cable, jumpers, connectors, surge protector and any attenuator.
4. **BDA.** The input is P_in. The output per channel is min(P_in + G_DL, P_comp,max − 10·log10(N) − backoff). NPSTC shows the composite-power effect: a booster good for 27 dBm/channel with 2 channels gives 24 dBm with 4 and 21 dBm with 8. With 1 W composite and 40 equal channels, each channel gets +14 dBm (25 mW) ([NPSTC IBWG Appendix E](https://www.npstc.org/documents/20071212_IBWG%20White%20Paper%20Appendix%20A-E.pdf)). Durham writes the same rule as "Max output power = BDA output power in dBm − 10·log(24)" for its 24-channel system ([Durham](https://www.durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-)). No opened source gives an extra backoff figure, so the default backoff is 0.
5. **Passive network**: splitters, couplers (through loss on the main line, coupling value on the tap), hybrids, cable, jumpers and connectors (defaults in §7).
6. **Server antenna gain** (dBi).
7. **In-building path loss** to the far edge (§4).
8. **Portable antenna and body.** Use the TSB-88 portable antenna correction (§5.2).
9. **Compare** P_edge with the requirement plus margin (§1.3).

Comba's simplex-BDA note walks this exact chain with numbers (§8) ([Comba 4-port BDA design note](https://combausa.com/wp-content/uploads/Comba-4-Port-BDA-Simplex-BDA-Design-considerations-and-requirments-4-Port-BDA-4-7-2026.pdf)).

### 1.2 Uplink chain (portable → site receiver)

1. **Portable power** (§5.1), plus the antenna correction or body loss, gives the portable EIRP.
2. **In-building path loss** to the nearest uplink/server antenna, then **server antenna gain** and **passive losses** back to the BDA. Run this twice: the farthest portable sets the minimum input, the nearest sets the maximum. OCSD wants the min-to-max spread at the BDA uplink input to stay at or under 20 dB and inside the AGC range ([OCSD ERRCS Guidelines Rev 4.5](https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf)). NFPA 1225 18.3.4.1 and IFC 510.4.2.8 require near-far to be minimized but give no number.
3. **BDA uplink gain** (AHJ cap 65 dB: OCSD, [San Diego C-1](https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf), Durham), limited by the uplink output rating. **BDA noise figure** sets the noise the BDA sends upstream (§6).
4. **Donor line**, then **donor antenna gain**. Check ERP against 5 W per channel ([47 CFR 90.219(d)(3)(i)](https://www.law.cornell.edu/cfr/text/47/90.219)) and against the OCSD caps of 27 dBm at the donor port and 37 dBm ERP.
5. **Outdoor path loss**, plus site receive antenna gain, gives the **level at the site**. Compare it with the AHJ window (−95 to −75 dBm OCSD; −95 to −80 dBm Durham) and with the site's faded threshold for DAQ 3.4 (§5.3).

There is a quick consistency check that needs no donor-site measurement. Radio Solutions points out that, on a reciprocal path, the outbound level equals the inbound reading minus (site ERP − portable ERP). Their example: −85 dBm inbound with a 47 dBm site and a 34 dBm portable gives −98 dBm outbound, which fails −95 dBm even though the downlink passes ([Radio Solutions, Minimum Inbound/Outbound Signal Strength](https://www.pennboc.org/wp-content/uploads/2023/09/2023-09-22-ERCES-RSI-Min-Outbound-Signal-Strength-Derek-Case.pdf)).

### 1.3 Margins: DAQ against a signal level

- **The code target is a DAQ, not a dBm figure** in IFC 2024 and NFPA 1225-2022. Both require DAQ 3.0 in each direction. NFPA Annex A.18.9.1 recommends designing for **DAQ 3.4** as a safety factor ([NFPA 1225 Ch. 18, Georgia OCI copy](https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download)).
- **Turning a DAQ into dBm.** TSB-88's faded threshold is C_f = C_s + (C_f/N − C_s/N) ([NTIA Report 07-447, eq. 4-4](https://its.ntia.gov/publications/download/07-447.pdf)). For P25 C4FM with a narrow IF, the TSB-88.1-C draft gives C_s/N = 7.6 dB at 5% BER, C_f/(I+N) = 16.5 dB for DAQ 3.0 (2.6% BER) and 17.7 dB for DAQ 3.4 (2.0% BER). With a GTR 8000 at −118 dBm: DAQ 3.0 = −109.1 dBm, DAQ 3.4 = −107.9 dBm. Pericle gives −106 dBm as the common P25 DAQ 3.4 fading threshold, and −101 dBm for analog NPSPAC ([Pericle drive-test guide](https://www.pericle.com/wp-content/uploads/Drive_Test-Guidelines031210.pdf)). Its ATP slides say −105 dBm ([Pericle ATP slides](https://www.pericle.com/wp-content/uploads/W07_ATP_for_LMR-Slides_V2.pdf)). The −95 dBm level rule sits about 11–13 dB above these thresholds.
- **Design margin.** No code gives a dB fade margin. Suneast, a low-authority integrator blog, designs 15 dB over −95 dBm for life safety and 10 dB for commercial ([Suneast](https://www.suneast.com.sg/post/das-antenna-spacing-per-floor)). NPSTC notes that in-building designers commonly target −85 dBm (10 dB over −95). It also warns that public safety differs from cellular because portables have no power control ([NPSTC Appendix](https://www.npstc.org/documents/20071212_IBWG%20White%20Paper%20Appendix%20A-E.pdf)). A statistical alternative is margin = z·σ: z = 1.28 / 1.65 / 2.32 for 90/95/99% ([Pericle Table A.2](https://www.pericle.com/wp-content/uploads/Drive_Test-Guidelines031210.pdf)), with σ from P.1238. Office NLoS σ = 5.01 dB gives 8.3 dB at 95%. TSB-88-B, as summarized by NTIA, adds a 1 dB location/algorithm margin, uses 5.6 dB clutter σ, and recommends 97% reliability for public safety ([NTIA 07-447](https://its.ntia.gov/publications/download/07-447.pdf)). The TSB-88.1-C draft Table D-4 also lists 97% for public safety.
- **Measured equivalents.** NFPA A.20.3.10 accepts SINR ≥ 18 dB and BER ≤ 2.5% as a DAQ method. Durham requires BER ≤ 2.0% and SINR ≥ 17.7 dB. San Diego requires SINR ≥ 20 dB and BER ≤ 2%.

---

## 2. Code numbers

### 2.1 IFC (by edition)

| Edition | Downlink | Uplink | Coverage | Isolation | Source |
|---|---|---|---|---|---|
| IFC 2024 | DAQ ≥ 3.0 (or equivalent BER/SINR); **no dBm** (510.4.1.1) | DAQ ≥ 3.0 (510.4.1.2) | 95% all areas, 99% critical (510.4.1) | ≥ 20 dB greater than system gain under all conditions (510.4.2.4 item 4) | [ICC IFC 2024](https://codes.iccsafe.org/content/IFC2024V2.0/chapter-5-fire-service-features) |
| IFC 2021 | **minimum −95 dBm** throughout and DAQ ≥ 3.0 (510.4.1.1) | DAQ ≥ 3.0, no dBm (510.4.1.2) | 95% / 99% critical | ≥ 20 dB greater than system gain | [ICC IFC 2021](https://codes.iccsafe.org/content/IFC2021P2/chapter-5-fire-service-features) |
| IFC 2018 | DAQ ≥ 3.0 or SINR, no dBm | DAQ ≥ 3.0 | 95% | ≥ 20 dB greater than system gain | [IFC 2018 §510 reproduction](https://callmc.com/wp-content/uploads/2021/10/IFC_510_Sheet-1.pdf) |
| IFC 2015/2012 | −95 dBm receivable in building | −95 dBm received by agency system | 95% | not addressed | [Radio Solutions](https://www.pennboc.org/wp-content/uploads/2023/09/2023-09-22-ERCES-RSI-Min-Outbound-Signal-Strength-Derek-Case.pdf); [SBC quick reference](https://www.saferbuildings.us/sbc-quick-code-reference-nfpa-2013-2022-and-ifc-2015-2024) (summaries) |

Other IFC 2024 items:
- **Oscillation (510.4.2.4 item 5):** built-in detection that reduces gain and keeps the system running, with a supervisory signal. The system may shut down if the oscillation can't be corrected.
- **Near-far (510.4.2.8):** design the dynamic range so strong-signal AGC doesn't suppress weak uplinks.
- **Noise (510.4.2.9):** the booster type and the uplink signal and noise levels must be coordinated with and approved by every license holder that could be affected.
- **Acceptance test (510.5.4):**
  - Each floor is split into 20 grid areas. More than one failed area fails the floor.
  - The AHJ may allow 40 areas instead, passing with up to 2 non-adjacent failures.
  - Two radios are keyed on different channels at the same time: one within 10 ft of an indoor antenna and one at the farthest point.

### 2.2 NFPA

The NFPA 1225 text is **paywalled**. Chapter 18 was read from a public copy posted by the Georgia Office of Commissioner of Insurance ([link](https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download)). I did not confirm whether a newer edition of NFPA 1225 has been issued; check nfpa.org before relying on 2022.

- **18.8.3 / 18.8.4 coverage:** 99% of floor area in critical areas (fire command centers, fire pump rooms, exit stairs and passageways, elevators and lobbies, standpipe cabinets, sprinkler sectional valves) and 95% in general areas.
- **18.8.6:** support two portables transmitting at once on different channels when the AHJ requires it.
- **18.9.1 / 18.9.2:** DAQ 3.0 downlink and uplink. **A.18.9.1** recommends designing for DAQ 3.4.
- **18.9.3 noise floor:** booster uplink noise must not raise the noise floor at the closest site or any receiving site. **A.18.9.3** procedure:
  - Measure idle noise at the site multicoupler with an RBW at or below the receiver noise bandwidth. Use 10 kHz for 12.5 kHz systems, and 10 kHz for 25 kHz systems at 800 MHz.
  - Turn the booster on. If the noise rises by 1 dB or more, attenuate or cut gain until it returns to idle, then add **3 dB more**.
  - Average over 5 minutes.
- **18.3.3.2 and 18.10:** isolation of at least **20 dB above system gain**.
- **18.3.2:** oscillation detection and control.
- **A.18.2.1:** the design submittal must include donor link budgets, path profiles, isolation calculations and predicted DAQ or signal maps.
- **A.20.3.10:**
  - DAQ can be shown by POLQA, by SINR ≥ 18 dB with BER ≤ 2.5%, or by manual radio tests.
  - Grid cells are 20–80 ft; floors larger than 128,000 ft² are split into sectors.
  - The DAQ scale comes from TIA TSB-88.1-E.

Older editions, taken from public comparison tables ([SBC NFPA comparison 2022](https://sbc.memberclicks.net/assets/docs/NFPA-Codes-2022.pdf), [SBC quick reference](https://www.saferbuildings.us/sbc-quick-code-reference-nfpa-2013-2022-and-ifc-2015-2024)):
- **NFPA 72-2013:** −95 dBm (24.5.2.3), **15 dB** isolation (24.5.2.3.3), 90% general and 99% critical coverage. Radio Solutions quotes the 72-2013 text: −95 dBm inbound throughout (24.5.2.3.1) and −95 dBm outbound at the donor site (24.5.2.3.2).
- **NFPA 1221-2016:** DAQ 3.0 and 20 dB isolation.
- **NFPA 1221-2019:** DAQ 3.0 and 20 dB above system gain.

### 2.3 Isolation requirement, by source

| Source | Rule |
|---|---|
| NFPA 1225-2022 18.3.3.2 / 18.10 | ≥ system gain + 20 dB |
| IFC 2018 / 2021 / 2024 510.4.2.4(4) | ≥ system gain + 20 dB, under all operating conditions |
| NFPA 72-2013 24.5.2.3.3 (SBC summary) | 15 dB above booster gain |
| NPSTC IBWG 2007 | "industry standard" BDA gain + 15 dB (e.g., 80 + 15 = 95 dB); the most frequent problem is inadequate isolation |
| [Fiplex HONBDA-7S datasheet](https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/hbt-fire-fiplex-BD441-BDA-BBU-HONBDA-7S-datasheet.pdf?download=false) | Max Gain + 20 dB |
| OCSD Rev 4.5 | ≥ 20 dB greater than the amplifier's **maximum rated** gain; > 100 dB desired |
| San Diego C-1 | ≥ 20 dB above system gain; acceptance: "isolation less maximum BDA gain > 20 dB" |
| Durham | maximum gain = isolation − 20 dB; measure by injecting a tone into a server antenna and reading it at the donor |
| [Comba 4-port note](https://combausa.com/wp-content/uploads/Comba-4-Port-BDA-Simplex-BDA-Design-considerations-and-requirments-4-Port-BDA-4-7-2026.pdf) (simplex) | donor DL–UL port > 65 dB; DAS DL–UL > 90 dB; DL path = DL gain + 20 dB; UL path = UL gain + 20 dB; overall ≥ G_DL + G_UL + M |

### 2.4 AHJ examples (opened)

- **Orange County Sheriff (CA), [Rev 4.5, 8-4-2025](https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf)** (800 MHz P25 simulcast):
  - Downlink must not exceed −75 dBm near the interior perimeter. Leakage at 3–25 ft outside must be ≥ 15 dB below the donor signal.
  - Uplink: gain ≤ 65 dB; ≤ 27 dBm at the donor port; ≤ 37 dBm ERP; −95 to −75 dBm per channel at the donor site; design portable 34 dBm.
  - Noise: ≤ −43 dBm in 10 kHz at the donor antenna, and never more than −150 dBm calculated at the donor site.
  - Donor antenna ≥ 13 dBd (15 dBi) with 30 dB front-to-back. No reactive tee splitters with less than 20 dB port isolation.
  - Acceptance: 95% coverage, 99% critical; −95 dBm in 95% of grids; DAQ 3.4.
- **San Diego Fire-Rescue C-1 ([rev. 01/22/2026](https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf)):**
  - Inbound −95 dBm and DAQ 3.4; outbound DAQ 3.4; SINR ≥ 20 dB, BER ≤ 2%.
  - Uplink gain ≤ 65 dB.
  - Noise ≤ −150 dBm at the donor site, −43 dBm ERP in band, −70 dBm ERP 1 MHz out of band.
  - Isolation ≥ gain + 20 dB.
  - Appendix A publishes site TX ERP (800/700 P25): 47.8, 47.8, 50, 45.13, 49, 45.8 and 42.14 dBm.
- **Santa Clara County FD C-2 ([rev. 09/01/20](https://www.sccfd.org/wp-content/uploads/2024/10/C-2-Emergency-Respodner-Radio-Coverage-Systems.pdf)):**
  - DAQ 3.4 for digital and 3.0 for analog, in 90% of each floor.
  - −95 dBm at the donor site receiver antenna.
  - Booster signal inside the exterior walls ≥ 15 dB below the exterior macro signal.
  - In-band noise ≤ −150 dBm at macro receive antennas.
- **Durham NC ([Doc. 47330 rev. 10/12/2026](https://www.durhamnc.gov/DocumentCenter/View/47330/BDA-Application-Requirements-City-of-Durham-NC-)):**
  - Grid test: −95 dBm, DAQ 3.0, BER ≤ 2.0%, SINR ≥ 17.7 dB. The initial survey passes at −100 dBm.
  - Uplink at the tower between −95 and −80 dBm; noise at the tower < −153 dBm; uplink gain ≤ 65 dB.
  - Full "near" and "far" link budgets required.
  - Leakage ≤ −89 dBm at 50 ft and ≤ −95 dBm at 100 ft.
  - Class A boosters only; 32 µs maximum delay.

---

## 3. FCC 47 CFR 90.219 (PLMRS signal boosters)

Text read from the eCFR via Cornell LII ([90.219](https://www.law.cornell.edu/cfr/text/47/90.219); amended 83 FR 61097, Nov. 27, 2018).

| Item | Rule | Paragraph |
|---|---|---|
| Class A | Retransmits specific channels; **no passband over 75 kHz** | (a) |
| Class B | Wideband; **a passband over 75 kHz** | (a) |
| Who may operate | Licensees on channels **above 150 MHz**, within their band and service contour; non-licensees need the licensee's express, recordable consent | (b), (b)(1)(i)-(ii) |
| Use | Weak-signal areas only; must not extend the normal range | (d)(1)-(2) |
| **Max radiated power** | **5 W ERP per retransmitted channel**, forward and reverse links (37.0 dBm ERP) | (d)(3)(i) |
| Railroad exception | Class A, single channel, 30 W ERP on 452/457.9000–.96875 MHz | (d)(3)(ii) |
| Class B | Fixed only (mobile Class B banned after Nov. 1, 2014); must be registered | (d)(4), (d)(5) |
| **Intermod** | ERP of IM products generally ≤ **−30 dBm in 10 kHz** | (d)(6)(i) |
| **Noise in passband** | ERP of noise generally ≤ **−43 dBm in 10 kHz** | (d)(6)(ii) |
| **Noise > 1 MHz outside passband** | ERP generally ≤ **−70 dBm in 10 kHz** | (d)(6)(iii) |
| Passband | Authorized band(s) only and as narrow as practical. Outside in-building DAS, a Class B passband should not span both commercial and Part 90 land mobile/public safety services | (d)(7) |
| Output capability | Designed for ≤ 5 W ERP per channel | (e)(1) |
| **Noise figure** | **≤ 9 dB in either direction** | (e)(2) |
| Spurious | ≤ **−13 dBm in any 100 kHz** | (e)(3) |
| Retransmission | Same channels; same occupied bandwidth; still meets §90.210 | (e)(4) |
| Labeling | Class A/B label and the FCC warning (from March 1, 2014) | (e)(5) |
| **Gain limit** | **None in 90.219.** The 65 dB caps come from AHJs | — |
| **Minimum coupling loss** | **Not in 90.219.** MSCL and BSCL exist only in the consumer-booster rules of [47 CFR 20.21](https://www.law.cornell.edu/cfr/text/47/20.21) | — |

For contrast only, since none of this applies to Part 90 public safety boosters, 20.21 sets these consumer-booster limits:
- **Wideband uplink gain** ≤ −34 dB − RSSI + MSCL (20.21(e)(8)(i)(C)(1)).
- **Fixed maximum gain** ≤ 6.5 dB + 20 log10(f) (20.21(e)(8)(i)(C)(2)(i)).
- **Uplink noise** ≤ −103 dBm/MHz − RSSI (20.21(e)(8)(i)(A)(1)).
- **Provider-specific gain** ≤ BSCL − 28 − (40 − MSCL) (20.21(e)(9)(i)(C)(1)).

---

## 4. Indoor propagation (server antenna → portable)

### 4.1 ITU-R P.1238: which edition holds what

- **P.1238-13 (09/2025) is the edition in force** ([ITU edition list](https://www.itu.int/rec/R-REC-P.1238-13-202509-I/en)). Its §3.1 "site-general" model is now **L_b = 10α·log10(d) + β + 10γ·log10(f_GHz) + N(0,σ)** (eq. 1), for transmitter and receiver on the same floor. Table 2 values:

| Environment | LoS/NLoS | f range (GHz) | d range (m) | α | β | γ | σ (dB) |
|---|---|---|---|---|---|---|---|
| Office | LoS | 0.3–294.0 | 2–27 | 1.47 | 34.17 | 2.08 | 3.68 |
| Office | NLoS | 0.3–255.0 | 4–30 | 2.39 | 30.13 | 2.40 | 5.01 |
| Corridor | LoS | 0.3–300.0 | 2–160 | 1.57 | 29.46 | 2.24 | 3.77 |
| Corridor | NLoS | 0.625–159.0 | 3–94 | 2.78 | 28.62 | 2.54 | 7.58 |
| Industrial | LoS | 0.625–294.0 | 2–102 | 2.27 | 24.79 | 2.10 | 2.62 |
| Industrial | NLoS | 0.625–255.0 | 3–110 | 2.80 | 23.55 | 2.16 | 5.70 |
| Conference/lecture | LoS | 0.45–300.0 | 2–21 | 1.56 | 30.47 | 2.23 | 2.92 |
| Conference/lecture | NLoS | 0.45–159.0 | 4–25 | 1.40 | 39.53 | 2.37 | 3.33 |

  10α is the equivalent of N in the older model; office NLoS gives 23.9. Table 3 of -13 gives directional (40°) to omni coefficients for 0.6–73 GHz inside a single room; these are in the JSON.

- **The model the brief asked for, L = 20·log10(f) + N·log10(d) + Lf(n) − 28**, is still in P.1238-13 as eq. (2). However, **from P.1238-11 (09/2021) on, its N table (Table 4 in -13) only lists 28 GHz and above** ([P.1238-11](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.1238-11-202109-S!!PDF-E.pdf), [P.1238-13](https://www.itu.int/rec/R-REC-P.1238-13-202509-I/en)). The last edition with sub-GHz N values is **P.1238-10 (08/2019), Table 2** ([P.1238-10](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.1238-10-201908-S!!PDF-E.pdf)):

| f (GHz) | Residential | Office | Commercial | Factory | Corridor |
|---|---|---|---|---|---|
| 0.8 | – | 22.5 (open office 50×16×2.7 m, LoS) | – | – | – |
| **0.9** | – | **33** | **20** | – | – |
| 1.25 | – | 32 | 22 | – | – |
| 1.9 | 28 | 30 | 22 | – | – |
| 2.1 | – | 25.5 (computer room) | 20 | 21.1 | 17 (LoS corridor) |
| 2.2 | – | 20.7 (open office LoS) | – | – | – |

  **For 800 MHz public safety, use the 0.9 GHz row: office N = 33, commercial N = 20.** The 0.8 GHz value of 22.5 is a line-of-sight open-office measurement.

- **Floor penetration Lf(n)** (P.1238-10 Table 3, unchanged as P.1238-13 Table 5):
  - 0.9 GHz office: **9 dB (1 floor), 19 (2 floors), 24 (3 floors)**.
  - 1.8–2 GHz: residential 4n, office 15 + 4(n − 1), commercial 6 + 3(n − 1).
  - Other rows: 2.4 GHz office 14; 3.5 GHz office 18/26; 5.2 GHz office 16; 5.8 GHz office 22/28.
  - P.1238 notes that multiple floors may isolate less than this, because signals find external paths.
- **Shadow fading σ** (P.1238-10 Table 4): 0.8 GHz open office 3.4 dB; 1.8–2 GHz residential 8, office 10, commercial 10.
- **Scope limit:** P.1238 covers **300 MHz to 450 GHz**. It does not cover VHF (150–174 MHz).

### 4.2 COST 231 multi-wall model

From the COST 231 Final Report, Chapter 4, §4.7.2 ([IST Lisbon copy](http://www.lx.it.pt/cost231/final_report.htm)):

**L = L_FS + L_c + Σ k_wi·L_wi + k_f^[(k_f+2)/(k_f+1) − b]·L_f**

- L_c is a regression constant, normally close to zero.
- Light walls are non-load-bearing: plasterboard, particle board, or light concrete under 10 cm.
- Heavy walls are load-bearing or over 10 cm thick: concrete or brick.
- The loss factors are fitted model coefficients, not physical wall losses.

Tab. 4.7.2 coefficients at **1800 MHz**:

| Model | Coefficients |
|---|---|
| Multi-wall | **L_w1 = 3.4 dB, L_w2 = 6.9 dB, L_f = 18.3 dB, b = 0.46** |
| One-slope, dense | one floor L0 = 33.3 dB, n = 4.0; two floors 21.9 / 5.2; multi-floor 44.9 / 5.4 |
| One-slope, other | open 42.7 / 1.9; large 37.5 / 2.0; corridor 39.2 / 1.4 |
| Linear (a, dB/m) | dense one floor 0.62; multi-floor 2.8; open 0.22 |

At **900 MHz**, the measured light-wall loss was 1.5 dB lower and the floor loss 3.5 dB lower. Ericsson measured 2.1 dB for a plasterboard wall at 900 MHz.

### 4.3 Free space

L_bf = 32.4 + 20 log f(MHz) + 20 log d(km) ([P.525-5 eq. 6](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.525-5-202411-I!!PDF-E.pdf)). With d in metres this is 20 log f − 27.6 + 20 log d, which matches P.1238's 1 m reference of 20 log f − 28.

### 4.4 Server antenna spacing rules of thumb

| Source | Rule |
|---|---|
| [Comba](https://combausa.com/wp-content/uploads/Comba-4-Port-BDA-Simplex-BDA-Design-considerations-and-requirments-4-Port-BDA-4-7-2026.pdf) (simplex/split DAS) | Downlink antennas about **100–150 ft** apart, the first within about 50 ft of the perimeter. With +15 dBm out, 35 dB DAS loss and −20 dBm at the antenna, expect about −40 dBm at 5 ft and about −80 dBm at 60 ft. |
| [Suneast](https://www.suneast.com.sg/post/das-antenna-spacing-per-floor) (UHF, low authority) | One antenna per 1,000–1,500 m² open (20–35 m apart), or per 400–700 m² partitioned (15–20 m). Assumes N ≈ 3.0–3.5, 3 dB body loss, ports within ±3 dB. |

**Gap:** I found no US vendor coverage-radius table for 700/800 MHz.

---

## 5. Portables and site parameters

### 5.1 Portable transmit power (rated maximum, conducted)

| Radio | VHF | UHF | 700 | 800 | Source |
|---|---|---|---|---|---|
| Motorola APX 8000 (P25) | 6 W (37.8 dBm) | 5 W (37.0) R1 and R2 | 2.5 W (34.0) | 3 W (34.8) | [APX 8000 data sheet](https://www.motorolasolutions.com/content/dam/msi/docs/products/apx/apx_8000_na_data_sheet.pdf) |
| L3Harris XL Converge 200P (P25) | 1–6 W | 1–5 W | 0.5–3 W | 0.5–3 W | [XL Converge 200P datasheet](https://www.l3harris.com/sites/default/files/2026-03/l3harris-xl-converge-200p-multiband-portable-radio-datasheet-r-csd-pspc.pdf) |
| Motorola MOTOTRBO R7 (DMR) | 5 W (37.0) | 4 W (36.0) | – | 2.5 W (34.0), 800/900 | [R7 data sheet](https://www.motorolasolutions.com/content/dam/msi/docs/mototrbo/r7/r7-datasheet-na.pdf) |

AHJ and vendor design values:
- OCSD: design assumes a **34 dBm** portable.
- Radio Solutions example: a 3 W / 34 dBm ERP portable.
- Comba: about +35 dBm radiated.

### 5.2 Body loss and portable antenna

- **TSB-88.1-C public draft, Table D-3.** These portable antenna correction factors are relative to a half-wave dipole. They include antenna efficiency, polarization and **body absorption at head level** ([TSB-88.1-C draft, Oct 2006](http://www.simulcastsolutions.com/userfiles/file/appnotes/pTR8.18-06-10-0035-PN3-4744.1-RV3-Fb.pdf)):
  - 136–174 MHz: **−10 dBd**
  - 406–512 MHz: **−6 dBd**
  - 700 / 800 / 900 MHz: **−5 dBd**
  - Hip-worn radios lose more, depending on how the radio is carried. The published TSB-88 series is **paywalled**; this public 2006 draft is the source. Its Table D-5 is "Assumed CPC", not body loss.
- **Measured values** from Hill & Kneisel (1991), as reported by Pericle's Jacobsmeyer: VHF helical at head height **−11.3 dBd** median effective gain; 800 MHz coaxial dipole **−4.5 dBd** ([Urgent Communications, "Close race", 2009](https://urgentcomm.com/land-mobile-radio/close-race)).
- **Hip-level gap:** a county RFP points to "TSB-88 Table D-5, Median Portable Antenna Loss" for belt-worn radios. Those values were not found in any public document.
- **Generic body loss:** Suneast uses 3 dB. Use that only when the portable antenna is entered as a free-space gain; set it to 0 when the TSB correction is used, since the correction already includes the body.

### 5.3 Receiver sensitivity

**Site (Motorola GTR 8000), from the [G-Series data sheet, 2022](https://www.motorolasolutions.com/content/dam/msi/docs/business/product_lines/astro_25_network/_documents/static_files/astro_25_g-series_site_equipment_data_sheet.pdf):**

| Mode | 700/800 MHz | UHF | VHF |
|---|---|---|---|
| Digital 5% BER, C4FM | **−118 dBm** | −118 dBm | **−119 dBm** |
| Digital 5% BER, H-CPM (Phase 2) | −116 dBm | −116 dBm | −117 dBm |
| Analog 12 dB SINAD, 12.5 kHz | −118 dBm | −118 dBm | −119 dBm |

The same data sheet gives transmitter output of 2–100 W at 700/800 and VHF, and 2–110 W at UHF.

**Portables:**
- APX 8000 at 700/800: 0.211 µV at 5% BER (−120.5 dBm), 0.316 µV at 1% BER (−117.0 dBm), 0.562 µV at 5% BER faded (−112.0 dBm).
- XL Converge 200P, P25 5% BER: −122 dBm (VHF), −121 dBm (UHF), −120.5 dBm (700/800).
- MOTOTRBO R7 (DMR) at 5% BER: 0.14 µV (−124.1 dBm), or 0.18 µV (−121.9 dBm) for the 800/900 model.

**DAQ thresholds** (TSB-88.1-C draft, Table A-1, C_s/N at static reference, then BER/C_f/(I+N) for each DAQ; the "values were obtained from the manufacturers"):

| Modulation | Static ref / C_s/N | DAQ 3.0 | DAQ 3.4 | DAQ 4.0 |
|---|---|---|---|---|
| Analog FM ±2.5 kHz (12.5 kHz) | 12 dBS / 7 dB | 23 dB | 26 dB | 33 dB |
| C4FM IMBE 12.5 kHz, narrow IF | 5% / 7.6 dB | 2.6% / 16.5 dB | 2.0% / 17.7 dB | 1.0% / 21.2 dB |

Analog ±5 kHz (25 kHz) is 4 dB / 17 / 20 / 27, and NPSPAC ±4 kHz is 5 dB / 19 / 22 / 29. **DMR and P25 Phase 2 (H-CPM) rows are not in this 2006 draft.** That is a gap; use manufacturer values.

NTIA 07-447 reproduces the same excerpt from TSB-88-B (26 dB for analog 12.5 kHz at DAQ 3.4). The TSB-88.1-C draft also applies an environmental-noise derating: 6 dB at 132–174 MHz, 3 dB at 406–512 MHz, 3 dB at 700 MHz (D.3.12).

### 5.4 Site ERP

There is no national typical value; the AHJ publishes it. Examples:
- San Diego: 42.14–50 dBm ERP across seven 700/800 P25 sites.
- Comba's VHF example: +53 dBm per channel.
- Radio Solutions example: 47 dBm (50 W).

---

## 6. Noise

- **Thermal floor:** kTB = **−174 dBm/Hz** at 290 K ([Keysight noise figure note](https://helpfiles.keysight.com/csg/NA520xA/Applications/Noise_Figure.htm)). In-band this is −133.0 dBm for 12.5 kHz, −134.0 dBm for 10 kHz and −136.0 dBm for 6.25 kHz. Jacobsmeyer uses −133 dBm for a 12.6 kHz receiver with NF 9 dB.
- **BDA uplink output noise:** N_out = −174 + 10log10(B) + NF + G_UL. Comba estimates BDA output channel noise from kTB and NF the same way.
- **Noise ERP:** N_ERP = N_out − donor line loss + donor gain (dBd). It must be **≤ −43 dBm in 10 kHz** (90.219(d)(6)(ii)). Example: NF 5 dB, G_UL 65 dB, 2 dB line, 8 dBd donor gives −134 + 5 + 65 − 2 + 8 = −58 dBm ERP, which passes.
- **Noise at the site:** N_site = N_ERP + 2.15 − PL + site antenna gain − site feed loss.
  - AHJ limits: **−150 dBm** (OCSD, San Diego, Santa Clara) or **−153 dBm** (Durham). None of them states the bandwidth; compute in 10 kHz, which matches the FCC and NFPA measurement bandwidth.
  - Raising uplink gain raises signal and noise at the site together.
- **Noise rise:** ΔN = 10log10(1 + 10^((N_site − N_floor)/10)).
  - Take the site floor from the TSB relation N_floor = S_static − C_s/N. For a GTR 8000 that is −118 − 7.6 = −125.6 dBm.
  - NFPA A.18.9.3 acts at a 1 dB rise, which happens when BDA noise reaches about 5.9 dB below the floor; it then requires 3 dB more attenuation.
  - −150 dBm is about 24 dB under a −125.6 dBm floor, a rise of roughly 0.02 dB.
- **Other guidance:**
  - NPSTC warns that too much uplink gain desenses the base station for every user. Broadband boosters can also desense other services whose sites sit in the donor beam ([NPSTC §4.3](https://www.npstc.org/documents/20071212_IBWG%20White%20Paper%20Appendix%20A-E.pdf)).
  - IFC 2024 510.4.2.9 requires the uplink noise to be coordinated with license holders.
- **BDA noise figure** (cap 9 dB per 90.219(e)(2)):

| BDA | NF |
|---|---|
| [Fiplex HONBDA-7S](https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/hbt-fire-fiplex-BD441-BDA-BBU-HONBDA-7S-datasheet.pdf?download=false) | 9.0 dB max |
| [Fiplex FLEX 2.0 VHF/UHF](https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/fiplex-02022026/hon-ba-fire-bd426-7-flex2-0-high-power-psc-das-vhf-uhf-ota.pdf?download=false) | < 9 dB |
| [ADRF PSR-78-9537-U](https://cdn.windycitywire.com/partners/das/adrf/PSR-78-9537-U_v8_SS.PDF) | 5 dB at max gain |
| [Nextivity SHIELD SOLO](https://nextivityinc.com/wp-content/uploads/2023/03/SHIELD-SOLO_datasheet.pdf) | 5 dB |
| [Comba V3/NG](https://www.alliancecorporation.ca/wp-content/uploads/2025/12/RXxxV3-RHxxV3-NG-700-800MHz-Public-Safety-BDA-DAS-27-33dBm-and-Battery-Backup-Unit-DS-0-2-6.pdf) | UL < 5 dB at 90 dB gain, < 9 dB at 67 dB gain |
| [NOTIFIER DN-61014](https://prod-edam.honeywell.com/content/dam/honeywell-edam/hbt/en-us/documents/literature-and-specs/datasheets/notifier-us/hon-ba-fire-dn-61014.pdf?download=false) | 6.5 dB typ, 8 dB max |

  Comba's NF figures show that NF gets worse at reduced gain, so the JSON default is 9 dB when no datasheet is at hand.

---

## 7. Component defaults (when the datasheet isn't at hand)

| Component | Default | Range / notes | Source |
|---|---|---|---|
| Connector, feed-through or adapter | **0.1 dB each** | — | [Campbell Scientific 3RF-F](https://s.campbellsci.com/documents/us/technical-papers/link-budget.pdf) |
| Jumper, 1/2" superflex, DC–1 GHz | **0.10 dB/m + 0.01 dB** | 1/2" flexible: 0.07 dB/m + 0.01 | [Rosenberger 4.3-10 catalog p.10](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf) |
| Surge protector | **0.1 dB** | 125 MHz–1 GHz part; Campbell's example uses 0.5 dB for a surge kit | [PolyPhaser IS-50NX-C2-ME](https://www.polyphaser.com/Images/Downloadables/Datasheets/IS-50NX-C2-ME_datasheets_US.pdf) |
| 2-way splitter | **3.6 dB** | D2-61 (70–2700 MHz, VHF-capable): 3 dB + < 0.6 dB at 150–1000 MHz; RFS PDS2 3.3 dB; Microlab D2-08 3 + < 0.1 dB | [Microlab D2-61](https://microlabtech.com/pub/media/asset/Datasheets/dx-61.pdf), [RFS PDS](https://www.rfsworld.com/product/PDS2-43-350/2700-01/pdf), [Microlab Dx-08](https://microlabtech.com/pub/media/asset/Datasheets/dx-08.pdf) |
| 3-way splitter | **5.2 dB** | RFS PDS3; D3-08 4.8 + < 0.1; no VHF sheet opened | same |
| 4-way splitter | **6.5 dB** | RFS PDS4; D4-08 6 + < 0.1; no VHF sheet opened | same |
| Coupler 6 dB (through / tap) | **1.8 / 6** (±1.5) | CK-761: 1.8 dB | [DDC240 138–960 MHz](https://www.talleycom.com/images/PDF/SINDDC240.pdf), [Microlab CK-7x1](https://microlabtech.com/pub/media/asset/Datasheets/ck-7x1.pdf) |
| Coupler 10 dB | **1.2 / 10** (±1.7) | CK-771: 1.1 dB | same |
| Coupler 15 dB | **0.5 / 15** (±1.7) | CK-751: 0.5 dB | same |
| Coupler 20 dB | **0.4 / 20** (±1.7) | 25 dB: 0.4 / 25; 30 dB: 0.3 / 30 | DDC240 |
| 2×2 hybrid | **3.1 ± 1.2 dB** | 128–1000 MHz; 23 dB isolation; terminate unused port | [Microlab CA-PS-2x2-196FN](https://microlabtech.com/pub/media/asset/Datasheets/ca-ps-2x2-196fn.pdf) |
| 1/2" coax (LDF4-50A), dB/100 ft | per datasheet | 0.815 @150 MHz, 0.88 @174, 1.447 @450, 1.831 @700, 1.968 @800, 2.089 @894 | [CommScope LDF4-50A](https://www.talleycom.com/images/pdf/LDF4-50A.pdf) |
| Indoor omni gain | VHF **−3 dBi**, UHF **0 dBi**, 700/800 **1 dBi** | low end of the typical ranges −3…−1, 0…2, 1…4 | [Sinclair SI240F-O](https://www.talleycom.com/images/PDF/SINSI240F-OWBL4F.pdf) |
| Mismatch at VSWR 2:1 | **0.511 dB** | optional | Campbell |

**BDA ratings, all product-specific (no defaults):**

| BDA | Max gain | DL composite | UL composite | Max input (no overdrive) |
|---|---|---|---|---|
| Fiplex HONBDA-7S | 85 dB | +27 or +33 dBm | +24 dBm | −5 dBm (normal operation) |
| Comba V3/NG | 90 dB | 27/33 dBm | 27 dBm | −10 dBm |
| Nextivity SHIELD SOLO | 90 dB | 27 dBm | 26 dBm | −20 dBm DL, −27 dBm UL (min −100 / −90) |
| NOTIFIER | 92 dB | 28–32 dBm | — | −20 dBm (for FCC spurious) |
| ADRF PSR-78-9537-U | 95 dB | 37 dBm per band | 30 dBm | −20 dBm |
| Fiplex FLEX 2.0 | 85 dB | VHF 30 / UHF 37 dBm | +24 dBm | — |

Comba advises setting the donor level so the BDA is not in AGC under normal conditions.

**Donor antennas:**
- OCSD: ≥ 13 dBd (15 dBi), 30 dB front-to-back.
- [Sinclair SY307R](https://cdn.shopify.com/s/files/1/0531/8970/5898/files/SY307R-HF2SNF-2I.pdf?v=1787149592) UHF Yagi: 10 dBd (12.1 dBi), front-to-back 15 dB.
- NPSTC: about 10 dB is typical at 800 MHz.

---

## 8. Worked example: Comba VHF simplex BDA (public, complete)

From [Comba, *Design Considerations for Simplex/Split DAS Using 4-Port BDAs*, rev. 4-7-2026](https://combausa.com/wp-content/uploads/Comba-4-Port-BDA-Simplex-BDA-Design-considerations-and-requirments-4-Port-BDA-4-7-2026.pdf), §3.3–3.5. The values below were checked against the rendered PDF pages.

**Downlink**

| Step | Value | Running level |
|---|---|---|
| Tower ERP per channel | +53 dBm | +53 dBm |
| VHF FSPL, about 15 miles | −104 dB | −51 |
| Donor antenna | +8 dBd | −43 |
| Donor coax | −2 dB | −45 |
| DL attenuator (for simplex port isolation) | −15 dB | **−60 dBm at BDA input** |
| BDA DL gain | +75 dB | **+15 dBm output** |
| DAS loss to antenna | −35 dB | **−20 dBm at the antenna** |
| Portable at 5 ft (free space) | — | about −40 dBm |
| Portable at 60 ft (medium-dense) | — | about −80 dBm |

**Uplink**

| Step | Value | Running level |
|---|---|---|
| Portable radiated power | +35 dBm | +35 dBm |
| Portable → UL antenna | −20 (near) to −60 (far) dB | — |
| DAS loss to BDA | −40 dB | **−25 dBm near / −65 dBm far at BDA UL input** |
| BDA UL gain | +73 dB | **+8 dBm UL target** |
| UL attenuator | −5 dB | +3 |
| Donor coax | −2 dB | +1 |
| Donor antenna | +8 dBd | +9 dBm ERP |
| FSPL | −104 dB | **−95 dBm received at tower** |

**Noise and isolation (Comba §3.5):**
- With 78 dB DL-to-UL port isolation, the +8 dBm uplink leaks into the downlink at −70 dBm, which equals the −70 dBm downlink squelch.
- PA noise of −60 dBm/10 kHz becomes less than −134 dBm/10 kHz after that isolation.
- With BDA NF 5 dB, channel noise at the BDA output is −51 dBm/10 kHz; its leakage is −128 dBm/10 kHz.

**Things this example shows the app should flag:**
- The uplink lands **exactly** at −95 dBm, so there is no margin against a −95 dBm rule.
- The 73 dB uplink gain is above the 65 dB cap in OCSD, San Diego and Durham.
- The 40 dB near/far spread at the BDA input is double OCSD's 20 dB limit.
- My derived checks (not Comba's):
  - 104 dB matches P.525 free-space loss at about 155 MHz over 24 km (103.9 dB).
  - The 60 dB loss at 60 ft implies P.1238 N ≈ 35 at about 155 MHz, close to the office N = 33 at 0.9 GHz.

**Second, simpler public example ([Radio Solutions](https://www.pennboc.org/wp-content/uploads/2023/09/2023-09-22-ERCES-RSI-Min-Outbound-Signal-Strength-Derek-Case.pdf)):** a 47 dBm site, a 34 dBm portable and a 132 dB path give a downlink of −85 dBm (pass) and an uplink of −98 dBm (fail at −95).

---

## 9. Gaps and caveats

1. **NFPA 1225 and the published TSB-88 / TIA-102 series are paywalled.**
   - NFPA numbers come from the Georgia OCI copy of Chapter 18.
   - TSB-88 numbers come from a public 2006 TR-8.18 draft (TSB-88.1-C, Version Fb) plus NTIA 07-447's excerpt of TSB-88-B. Current TSB-88.1-E values may differ.
   - I did not confirm whether a newer NFPA 1225 edition has been issued.
2. **Hip-worn body loss.** TSB-88's "median portable antenna loss" values are not public. Only head-level corrections and the Hill & Kneisel head-height figures were found.
3. **DMR and P25 Phase 2 (H-CPM) DAQ CPC values** (C_s/N and C_f/(I+N)) were not found in a public source. Static sensitivities exist (GTR 8000 H-CPM −116/−117 dBm; R7 DMR 0.14/0.18 µV).
4. **P.1238 covers 300 MHz–450 GHz only. No ITU indoor coefficients exist for VHF**, and COST 231 coefficients are from 900/1800 MHz. For VHF, use free space plus wall losses, or measured data.
5. **Sub-GHz N values come from the superseded P.1238-10.** The in-force P.1238-13 dropped them from the N table and offers the α/β/γ site-general model instead (office NLoS 10α = 23.9).
6. **Fade margin:** no code or standards-body default. The 15 dB default comes from a low-authority integrator blog; prefer z·σ.
7. **AHJ noise-at-site limits (−150 / −153 dBm) don't state a bandwidth.** RF Recon should compute in 10 kHz and label it.
8. **Antenna coverage radius:** no US vendor table at 700/800 MHz was found. The rules of thumb come from Comba (simplex) and Suneast (UHF, Singapore).
9. **Output backoff:** no source gives a value. The default is null/0.
10. **Site ERP** has no national typical value; it must come from the AHJ's 510.4.2.2 document.
