# PIM (Passive Intermodulation) testing: field reference for RF Recon

Prepared 2026-10-29 for the RF Recon PIM tab and the PIM section of DAS / ERCES jobs. Every statement below comes from a document opened during this research and is linked inline. Standards are summarized in my own words. Single-vendor values are marked as such. Where sources disagree, both are given. The structured version of this report is `pim.json` in the same folder.

---

## 1. What PIM is and why it matters

### 1.1 Definition
PIM is intermodulation distortion made by parts we treat as linear: cables, connectors, antennas, and rusty metal near the antenna. When two or more strong signals hit a non-linear junction, such as a loose or corroded connector, new signals appear at predictable frequencies. It is also called the "diode effect" or "rusty bolt effect." ([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))

PIM is not a loss. It is new signal energy that leaves the non-linear point in every direction, like a point source. ([Anritsu, PIM in In-building DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf); [IEC 62037-1:2025 preview, Cl. 4 and 6.1](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf))

PIM and return loss measure different things. A line can pass a sweep and fail PIM, for example because of metal chips loose inside a connector. It can also fail a sweep and pass PIM, for example a dented cable that is still linear. Both tests are needed. ([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf); [MCF DAS spec 2023, 5.1](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf))

### 1.2 IM orders and where the products land
For two carriers F1 and F2, the products are at **nF1 − mF2** and **nF2 − mF1**, where n and m are positive integers. The order is n + m. ([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) The products that fall near the carriers, and so can land in a receive band, are:

| Order | Lower product | Upper product |
|---|---|---|
| IM3 | 2F1 − F2 | 2F2 − F1 |
| IM5 | 3F1 − 2F2 | 3F2 − 2F1 |
| IM7 | 4F1 − 3F2 | 4F2 − 3F1 |

(F1 < F2. IM5 and IM7 are written out from Anritsu's general formula. IEC 62037-1 names (2f1 − f2) and (2f2 − f1) as the measured products. [IEC 62037-1:2025 preview, Cl. 5](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf))

- IM3 is usually strongest and is the normal test product. IM5 and IM7 are weaker but help raise the noise floor. ([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))
- Products from modulated carriers are wider than the carriers. With 1 MHz carriers, IM3 is about 3 MHz wide and IM5 about 5 MHz. With 10 MHz LTE at 700 MHz, IM3 and IM5 can be 30-50 MHz wide. A product does not have to hit the uplink channel exactly. It only has to fall inside the receiver's band filter. ([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf); [Anritsu, FirstNet app note](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf))
- At a band 17 site (AT&T), the transmitter creates IM5 and IM7 products 20-35 dB below an IM3 product. When band 14 (FirstNet) and band 17 signals mix outside the antennas, true IM3 lands in the 700 MHz uplinks. ([Anritsu, FirstNet app note](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf))

**Worked examples.** The first two are from the source. The last two I computed with the formula, and the band edges are cited.
- PCS 1940 MHz + AWS 2130 MHz: 2 × 1940 − 2130 = **1750 MHz**, inside the AWS-1 receive band (1710-1755). ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))
- GSM 935 + 960 MHz: 2 × 935 − 960 = **910 MHz**, inside the 900 receive band. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))
- *Computed:* public-safety 800 MHz downlink at 853.0 MHz plus a cellular downlink at 869.5 MHz: 2 × 853.0 − 869.5 = **836.5 MHz**, inside the 824-849 MHz cellular uplink. Band edges: NPSPAC is now 806-809/851-854 MHz ([FCC DA 09-1783](https://docs.fcc.gov/public/attachments/DA-09-1783A1.pdf)); cellular 850 Rx is 824-849 MHz ([Anritsu MW82119B data sheet](https://www.atecorp.com/getmedia/9c6184b7-a4f5-4501-b614-1d63e2ec8200/mw82119b-datasheet_1.pdf)). This case matters on a neutral-host passive DAS that also carries ERCES.
- *Computed:* two NPSPAC base channels at 851.0125 and 853.9875 MHz: 2F1 − F2 = **848.04 MHz**, also inside the 824-849 MHz cellular uplink.
- **VHF/UHF ERCES:** the AHJ's technical criteria document lists the required frequencies ([IFC 2018 §510.4.2.2](https://callmc.com/wp-content/uploads/2021/10/IFC_510_Sheet-1.pdf)). Compute IM3/IM5 for every pair of downlink channels against every uplink channel in that list. I found no published VHF PIM test practice. That is a gap.

### 1.3 dBm vs dBc
- dBm is absolute power. 20 W = 43 dBm, 40 W = 46 dBm, 2 W = 33 dBm. ([Anritsu, PIM in DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf))
- dBc is the PIM level relative to one test tone: **dBc = PIM (dBm) − tone power (dBm)**. At 2 × 43 dBm, −150 dBc = −107 dBm and −166 dBc = −123 dBm. ([Anritsu, PIM Test Power Level](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-01008A.pdf)) Also at 2 × 43 dBm: −140 dBc = −97 dBm ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) and −153 dBc = −110 dBm ([Microlab](https://microlabtech.com/pim-requirements-for-low-power-wireless-components-and-subsystems.html)).
- A dBc number is meaningless without its test power.

**Power scaling.** In theory IM3 rises 3 dB for each 1 dB of tone power. Field values are typically 2.2-2.8 dB/dB. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) Microlab measured 1.5-2.5 ([Microlab](https://microlabtech.com/pim-requirements-for-low-power-wireless-components-and-subsystems.html)). IEC 62037-1 states that PIM does not follow a simple quadratic law, so you cannot accurately convert results between power levels. Compare at the same power. ([IEC 62037-1:2025, Cl. 4](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf)) Anritsu still shows an "equivalent spec" calculation at 3 dB/dB: −166 dBc at 20 W ≈ −160 dBc at 40 W ([Anritsu, Power Level](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-01008A.pdf)). At one cell site, a source beyond the antenna dominated only above 25 W. A 20 W test understated the real PIM there. ([same](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-01008A.pdf))

### 1.4 Why it matters
- PIM in the receive band desensitizes the receiver. That shrinks coverage, raises bit-error rate, drops calls, and lowers data rates. Signs include receive diversity noise-floor imbalance, high noise floors, shorter calls, and more drops.
- In drive tests, download speed fell about 18% when residual PIM went from −125 dBm to −105 dBm.
- Example: if Rx sensitivity is −107 dBm but the real noise floor is −97 dBm, handoffs happen 10 dB early.
([Anritsu, Understanding PIM](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))

The uplinks of every cellular network are vulnerable to PIM. The FirstNet band 14 overlay made IM3 between bands 14 and 17 a real-world uplink problem. ([Anritsu FirstNet](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf))

For DAS, PIM rises with power and traffic, so problems often show up after handover. Carriers stress-test to emulate full-power operation. ([MCF DAS spec](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf))

Public-safety DAS must carry VHF and UHF, including 380, 700 and 800 MHz. Low-PIM DAS antennas have been verified at 380, 700 and 1920 MHz against a −150 dBc requirement. ([Ng et al., Sensors 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7248867/))

### 1.5 Common PIM sources
- **Connectors.** First suspects in any PIM hunt. Problems include gaps, over-tightening, low contact pressure, debris, corrosion (coastal), cutting chips, and wrong centre-pin depth. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) Loose connectors at the cable interface are probably the most common fault on site. If one connector is bad, most of the same installer's work probably needs attention. ([Anritsu white paper](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf))
- **Ferromagnetic materials.** Iron, nickel and cobalt are strong PIM sources. Stainless steel can add 10-20 dB of PIM, and nickel or gold-over-nickel plating 20-40 dB. Cellular connectors use non-ferrous bodies plated with silver, white bronze or gold. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) IEC 62037-1 Table 1 advises against ferromagnetic materials, non-magnetic stainless steel (it contains iron), ferrite devices, and dissimilar metals (galvanic corrosion). ([IEC 62037-1:2025 preview](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf))
- **Cables.** Braided cables act like hundreds of loose connections ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)). MCF bans braided or foil cables such as LMR400 and RG214 ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)). Seams corrode, plating can flake, temperature changes move contacts, and water does damage.
- **Antennas.** Fatigue breaks, cold solder joints, corrosion, and connector mounts that loosen after a few torque cycles. Most antennas built before 2006 were not designed for PIM. ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf))
- **External "rusty bolt" PIM.** Rusty fences, roofs, mast bolts, and air-conditioning ducts. If a site works better after rain, look for rusty mounts. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) Rooftop guard rails, AC units, roofing, billboards, and fences also cause it. ([Anritsu FirstNet](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf))
- **Lightning arrestors** that micro-arc as they age, and **ferrite circulators and isolators**. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf))
- **CommScope/Andrew's list:** poor connector attachment, wrong torque, scratches, oxidation or contamination, poor plating, low-quality assemblies and adapters, and ferromagnetic material in or near the path. They name the two root mechanisms as current rectification at joints and varying magnetic permeability. ([CommScope PIM FAQ](https://wirelessestimator.com/publicdocs/PIM-FAQs.pdf))

---

## 2. Standards and requirements

### 2.1 IEC 62037 series (Passive RF and microwave devices, intermodulation level measurement)
| Part | Covers | Notes (from the IEC webstore or official previews) |
|---|---|---|
| [62037-1](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf) | General requirements and measuring methods | Ed. 3.0 2025 replaces the 2021 edition, which replaced the 2012 edition ([2012 abstract](https://webstore.iec.ch/en/publication/6331)). |
| [62037-2](https://cdn.standards.iteh.ai/samples/103907/acf50ade5ad44b87bba30a67e2b3a97e/IEC-62037-2-2021.pdf) | Coaxial cable assemblies (jumpers, assemblies in motion) | 2021: mechanical stress tied to the advertised bend radius |
| [62037-3](https://webstore.iec.ch/en/publication/6333) | Coaxial connectors: impact test for weak contacts and loose particles | 2012; a 2025 RLV exists |
| [62037-4](https://webstore.iec.ch/en/publication/6334) | Coaxial cables: two dynamic methods and one static method | 2012 + AMD1:2025 |
| [62037-5](https://webstore.iec.ch/en/publication/72272) | Filters: qualification and acceptance | 2021 defines impact energy and locations |
| [62037-6](https://assets.vde-verlag.de/iec-normen/preview-pdf/info_iec62037-6%7Bed2.1%7Den.pdf) | Antennas: qualification and acceptance | 2021 defines impact energy and locations; AMD1:2025 requires the reported values to be the *maximum* PIM |
| [62037-7](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf) | **Field measurements of PIM** (reverse PIM on deployed systems, into loads or through antennas) | 2022; the field procedure this report's SOPs follow |
| [62037-8](https://cdn.standards.iteh.ai/samples/101679/5c225f603524457a9b81fcae86898009/IEC-62037-8-2022.pdf) | Radiated PIM of any object exposed to RF (near or far field, outdoor or anechoic) | 2022 |

**IEC 62037-1 test method** (summarized from the [2025 preview](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf)):
- **Stimulus.** Two CW tones of equal power. Their own harmonics and self-IM must sit at least 10 dB below the IM level expected from the device (Cl. 5).
- **Power.** 2 × 20 W (43 dBm) at the device port is the general recommendation for mobile systems unless the spec says otherwise. Never exceed the device's rating (Cl. 8, Table 2).
- **Set-up.** Self-IM, including the load, should be at least 10 dB below the level being measured (6.2.1). Unused ports go to a linear termination (6.2.2). Reverse and forward set-ups are both described, and multi-port analyzers are allowed (6.1).
- **Frequency.** PIM is typically frequency dependent. Swept or multiple fixed frequencies give more accurate results (Cl. 4, Annex B; new emphasis in 2025).
- **Preparation.** Check cleanliness and interface dimensions, and torque each interface to the IEC interface spec or the manufacturer's value (7.1).
- **Test spec contents.** Power, IM order, forward or reverse, frequencies, dynamic stimulus, and maximum allowable PIM (Cl. 9).
- **Report.** Tone power, f1, f2, PIM level and frequency. The 2025 edition adds the maximum PIM over the test duration (10.1).
- IEC defines the method only. It sets no pass/fail level and does not cover long-term reliability (Cl. 1).

**Measurement error vs residual margin** (Anritsu's reading of the IEC curve): a 10 dB margin gives +2/−3 dB of error, 5 dB gives +4/−7 dB, and 20 dB gives under 1 dB. ([Anritsu, Power Level](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-01008A.pdf))

**IEC 62037-7 field requirements** ([2022 preview](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)):
- **Radiating tests.** Stay within authorized RF limits. Keep keys, phones, ladders and tools away from the antenna (4.1).
- **Test frequencies.** F1, F2 and the IM product must pass through the whole system. Bypass blocking devices with short low-PIM jumpers. Use guard bands, and survey local spectrum first (4.2).
- **Safety.** Lock off every radio feeding the line, and stay a safe distance from radiating antennas (4.3).
- **Test points.** Inject at the radio's connector (6.1).
- **Set-up checks.** Clean with IPA and lint-free wipes, and remove metal flakes (6.2.2). Residual test while flexing the lead, at least 10 dB under the limit (6.2.3). PIM standard within 3 dB (6.2.4).
- **Validity checks.** VSWR below 1.92:1 (6.3). External signal at the IM frequency at least 10 dB under the limit (6.4).
- **Static (6.5) then dynamic (6.6).** Fixed-frequency tests can falsely pass when two sources cancel, so swept tests are recommended.
- **Dynamic stimuli.** Flex cables at 4× the bend radius for 3 rotations. Five impacts per connector (energy per IEC 62037-3 Table 1). Two impacts by each connector on passive devices plus three per bare side, at no more than 0.14 J. Antennas on the rear surface, every 30 cm, at no more than 1 J.
- **Report** residual PIM and the peak PIM per line during dynamic loading (Cl. 8).

### 2.2 Typical acceptance limits (all IM3 at 2 × 43 dBm unless noted)
| Limit | dBm equivalent | Who / where |
|---|---|---|
| −140 dBc | −97 dBm | "Standard figure used around the world" for system-level site tests ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)). "Most operators" per Anritsu's DAS note ([Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)). Valmont uses −97 dBm at the DAS input ([Valmont](https://www.valmonttelecom.com/resources/article/pim-testing-in-das-networks)). |
| −150 dBc | −107 dBm | Receiver-sensitivity target; Anritsu says −140 dBc "may not be enough" with LTE ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)). "Good" for components ([Power Level](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-01008A.pdf)). DAS antennas ([Sensors 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7248867/)). |
| −150 to −160 dBc vs −150 to −170 dBc | | Anritsu's guideline range for antenna systems. Its app note and its white paper give different upper ends ([app note](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf), [white paper](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf)). |
| −153 dBc | −110 dBm | "Accepted PIM performance for standard 2 × 20 W test" ([Microlab](https://microlabtech.com/pim-requirements-for-low-power-wireless-components-and-subsystems.html)). Ratings on Rosenberger DAS splitters, couplers, hybrids and duplexers ([RSS catalog](https://rosenbergeronline.us/usercontent/documents/RSS-DAS-Components.pdf)), the Norsat 138-960 MHz coupler ([Norsat](https://www.norsat.com/products/das-directional-coupler-low-pim-138-960-mhz)), and the CommScope in-building antenna incl. 350-470 MHz ([CMAX](https://www.andrew.com/products/in-building/antennas/itemcmax-d-tcpusei53/)). |
| −155 dBc | −112 dBm | Microlab hybrid (single vendor) ([Microlab](https://microlabtech.com/product/ca-ep-2x2-738fn/)) |
| −160 dBc | −117 dBm | Rosenberger jumpers; 7-16 and N interface ratings (single vendor) ([Rosenberger](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf)) |
| −161 dBc | −118 dBm | Rosenberger 4.3-10 splitters and couplers (single vendor) ([Rosenberger](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf)) |
| −166 dBc | −123 dBm | Rosenberger 4.3-10 interface (single vendor) ([Rosenberger](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf)) |

The trend for DAS components: −140 → −150 dBc, moving to −153 and −160 dBc ([CommScope blog, 2014](https://www.commscope.com/Blog/PIM-Requirements-Must-Increase-to-Support-Evolving-DAS-Systems/)). For antennas about 10 years old, Anritsu says demanding better than −80 dBm / −123 dBc is unrealistic. At sites running above test power, tighten the limit. Anritsu's example: at 50 W with a 2.2 dB/dB slope, the limit becomes about −105.8 dBm. ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf))

### 2.3 Carrier specifications
- **AT&T / FirstNet.** AT&T's Method of Procedure (MOP) sets the pass/fail values, and they are **not public**. Anritsu's public app note describes the flow. First run 1-port PIM vs time and swept PIM. Run DTP if it fails. Then run a 2-port test, with F1 into the band 14 antenna and F2 into the band 17 antenna on the same polarization, to find external IM3. AT&T's LTE-M Pilot tool is the network-side check. Anritsu says the MW82119B-0703 was built to comply with the AT&T MOP. (Secondary source: [Anritsu FirstNet](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf))
- **Verizon, T-Mobile.** I found **no public PIM acceptance spec**. Anritsu: the limit is set by the site or equipment owner and must be stated at procurement, with test parameters and power. ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) Get the MOP from the carrier or general contractor.
- **Secondary statement:** "most operators" require −140 dBc at 2 × 20 W ([Anritsu Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)).

### 2.4 DAS / neutral-host specs
- **No public US neutral-host or carrier DAS PIM spec was found.** A US hospital's 2026 neutral-host DAS spec exists but returned HTTP 403. CU Denver's Division 27 DAS standard has no PIM limit. It requires sweeps around 160, 460, 700, 840, 930 and 1925 MHz with return loss over 20 dB at any connector, cleaning before mating, and factory-made assemblies to reduce PIM. ([CU Denver 27 53 19](https://www.cuanschutz.edu/docs/librariesprovider260/design-and-construction/guidelines-and-standards/division-27/275319---distributed-antenna-system.pdf?sfvrsn=284fb9b9_2))
- **Public carrier DAS spec (Australia, model only):** [MCF Design Specification for DAS 2023](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf).
  - **Segment limit.** Each passive segment at the multi-network combiner ≤ −140 dBc at design power. Segments of 5 W or less: ≤ −140 dBc at 2 × 33 dBm.
  - **Component limits.** Splitters and couplers ≤ −150 dBc at 2 × 43 dBm. Terminations under 5 W ≤ −140 dBc at 2 × 33 dBm. Terminations of 5 W or more ≤ −150 dBc at 2 × 43 dBm. Patch cables ≤ −150 dBc static and dynamic.
  - **Bands.** Low, mid and high.
  - **Test and hand-over.** PIM vs time of at least 10 s on a calibrated analyzer. Hand over the original result files and date-stamped screenshots.
  - It points to the IWPC "PIM Testing Best Practices" (2014). That document requires a request form and was not opened.

### 2.5 Component low-PIM ratings
| Component | Rating | Source |
|---|---|---|
| 4.3-10 connector interface | −166 dBc @ 2 × 43 dBm | [Rosenberger](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf) |
| 4.3-10 splitters / couplers | −161 dBc | same |
| Coax jumpers | −160 dBc (typ −163) @ 2 × 20 W | same |
| DAS cavity splitters, couplers, hybrids, combiners, duplexers | −153 dBc | [Rosenberger RSS](https://rosenbergeronline.us/usercontent/documents/RSS-DAS-Components.pdf) |
| 2×2 hybrid 694-3800 MHz | < −155 dBc @ 2 × 43 dBm | [Microlab](https://microlabtech.com/product/ca-ep-2x2-738fn/) |
| Public-safety coupler 138-960 MHz | ≤ −153 dBc (test power not stated) | [Norsat DDC240](https://www.norsat.com/products/das-directional-coupler-low-pim-138-960-mhz) |
| In-building antenna 350-470 / 617-960 / 1710-2700 MHz | −153 dBc @ 2 × 20 W | [CommScope CMAX-D-TCPUSEi53](https://www.andrew.com/products/in-building/antennas/itemcmax-d-tcpusei53/) |

### 2.6 Public safety (ERCES): IFC 510 and NFPA 1225
- **The 2018 IFC Section 510 text has no PIM, sweep, return-loss or VSWR requirement** (checked in full, [reproduction](https://callmc.com/wp-content/uploads/2021/10/IFC_510_Sheet-1.pdf)). What it does require:
  - DAQ 3.0 in 95% of each floor (510.4.1).
  - Donor isolation at least 20 dB above system gain (510.4.2.4).
  - An acceptance test over 20 grid areas per floor, with amplifier gains recorded (510.5.3).
  - An AHJ technical-criteria document that lists the frequencies (510.4.2.2).
  - Section numbers change in IFC 2021/2024.
- **NFPA 1225 Chapter 18** (2022, replaced NFPA 1221) covers acceptance, annual and five-year testing. I did not open the NFPA text itself. The Safer Buildings Coalition summary does not mention PIM ([ERCES primer](https://saferbuildings.org/erces-primer/)). **No source found makes PIM testing a code requirement.**
- Some AHJs still ask for it. Washington DC's OUC lists "PIM Testing results (if applicable)" next to sweep results as a prerequisite ([DC OUC v3.2](https://ouc.dc.gov/sites/default/files/dc/sites/OUC/page_content/attachments/40_DC_In_Building_Radio_System_Acceptance_Test_Requirements.pdf)). ETA's DAST certification expects technicians to know PIM testers ([ETA DAST](https://www.etai.org/comps/DAST_comps.pdf)).

---

## 3. Test equipment

| Vendor / product | Bands | Power | Key features |
|---|---|---|---|
| [Anritsu PIM Master MW82119B](https://www.atecorp.com/getmedia/9c6184b7-a4f5-4501-b614-1d63e2ec8200/mw82119b-datasheet_1.pdf) | One band per unit: LTE 600 w/1900, LTE 700, APT 700, LTE 800, Cellular 850, E-GSM 900 (± IM2), DCS 1800, PCS/AWS, UMTS 2100, LTE 2600 | 20-46 dBm per tone (up to 2 × 40 W) | Reverse PIM per IEC 62037-1; IM3/5/7; residual < −117 dBm (−125 typ) @ 2 × 43 dBm; PIM vs time, swept PIM, noise floor; DTP < 3 m typ; Option 331 Site Master 2 MHz-3 GHz; specs after 10 min warm-up |
| [MW82119B-0703 (2-port 700)](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf) | 700 MHz (B14/B17) | to 40 W/tone | F1 and F2 on separate ports for external cross-band PIM |
| [Kaelus iPA series](https://www.testworld.com/wp-content/uploads/Kaelus-iPA-Portable-PIM-Tester-Datasheet.pdf) (2014 data sheet) | 700 L/H, APT700, LTE 800, 850, GSM900, EGSM900, DCS1800, PCS/AWS, UMTS 2100, LTE 2600 | 0.1-20 W/tone | Residual < −117 dBm / −160 dBc max @ 2 × 20 W; optional Range-to-Fault; return-loss shut-down; vendor lists DAS use |
| [Kaelus iXA-0707A](https://tessco-product-images-commerce-cloud-prod.s3.amazonaws.com/Resources/278269_iXA+Series_Datasheet.pdf) | 700 L/H | 1-port 0.5-20 W; 2-port 1-40 W/tone | Residual < −123 dBm / −166 dBc; RTF on both ports; 1/2-port switching; DAS and external PIM |
| [Rosenberger PIM Site Analyzer alpha](https://www.rosenberger.com/product/pim-site-analyzer-alpha/) | 700-2700 MHz (+600 opt.) via swappable filter units | n/s | Residual < −125 dBm; 1-/2-port; fault location better than 0.3 m; VSWR, isolation, spectrum |
| [AWT Global PIM S1L TETRA/UHF MK2](https://awt-global.com/wp3/pim-test-systems/pim-analyzers-for-tetra-and-uhf/pim-analyzers-for-tetra-and-uhf-mk2/) | 380-470 MHz models incl. LTE 450 (B31); custom on request | 15-44 dBm/carrier | −163 dBc typ; DTP/DTF option. The only UHF field analyzer found. No VHF field PIM analyzer found. |
| [CommScope Optical PIM Tester](https://www.commscope.com/blog/2016/smart-testing-for-real-pim/) | Site bands via the site's RRHs | Site power | Active PIM over CPRI from the BBU, no climb (2015-16; current status unknown). CommScope/Andrew historically used Summitek coax analyzers ([FAQ](https://wirelessestimator.com/publicdocs/PIM-FAQs.pdf)). |
| [Anritsu BTS Master MT8220T](https://interferencetechnology.com/wp-content/uploads/2019/10/Overview-of-Passive-Intermodulation-PIM-Best-Practices-on-Preventing-PIM.pdf) | Site bands | Live traffic | PIM over CPRI without site down time (vendor advert) |
| [Summitek (now Kaelus) / Boonton PIM 31](https://www.mwrf.com/technologies/components/article/21845220/evaluating-effects-of-passive-intermodulation) | AMPS, GSM, PCS | 2 × 25 W (Summitek) | Legacy; Summitek rebranded Kaelus in 2011; no Boonton specs found |

**Accessories that matter.**
- Anritsu low-PIM terminations: 700-2600 MHz 10 W, and 663-2800 MHz 40 W.
- PIM standards: −80 dBm ±3 dB at 1730 MHz with 2 × 20 W.
- Low-PIM adapters, armored PIM test cables, the PIM Hunter probe, and torque wrenches.
- Anritsu states its line-sweep precision adapters and OSL kits are **not** low-PIM ([MW82119B data sheet](https://www.atecorp.com/getmedia/9c6184b7-a4f5-4501-b614-1d63e2ec8200/mw82119b-datasheet_1.pdf)).
- Kaelus: low-PIM load PIL-0005A and PIM source CIS-0001A ([iXA](https://tessco-product-images-commerce-cloud-prod.s3.amazonaws.com/Resources/278269_iXA+Series_Datasheet.pdf)).
- Rosenberger PIM load, 4.3-10/7-16, 700 MHz-3.6 GHz ([catalog](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf)).
- The low-PIM load is the most important PIM accessory ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf)).

**Sweep tools alongside PIM.**
- [Anritsu Site Master S331P](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Brochures-Datasheets-Catalogs/datasheet/11410-00964W.pdf): 150 kHz-4/6 GHz; RL 0-60 dB, VSWR, cable loss, DTF to 1500 m.
- [Bird SiteHawk SK-4500/6000/9000-TC](https://birdrf.com/hubfs/datasheets/Bird-Analyzer-SiteHawk-SK4500-TC-SK6000-TC-SK9000-TC.pdf): 1 MHz-4.5/6/9 GHz; RL 0 to −60 dB, VSWR 1-65, DTF 0-1500 m.
- DTF resolution (m) = 150 × Vp / sweep width (MHz). So a 30 MHz in-band DTF gives about 3.6 m resolution at Vp 0.72, while a 460 MHz sweep gives about 0.23 m. ([Anritsu DTP/DTF](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00869A.pdf))

---

## 4. Procedures

### 4.1 Pre-test checklist
1. **Get the written test spec:** limit, power, IM order, frequencies, dynamic stimulus and duration ([IEC 62037-1 Cl. 9](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf)). Confirm whose limit it is.
2. **Pick analyzer bands** whose tones and IM product pass every filter combiner, or plan bypass jumpers ([Anritsu Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf); [IEC 62037-7 §4.2](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
3. **Plan the frequencies.** F1/F2 in guard bands, and survey local signals.
4. **Get permission and a window.** Get advance permission from affected licensees before radiating ([Kaelus warning](https://tessco-product-images-commerce-cloud-prod.s3.amazonaws.com/Resources/278269_iXA+Series_Datasheet.pdf)). Book the outage; CommScope prefers evening maintenance windows and testing into loads ([FAQ](https://wirelessestimator.com/publicdocs/PIM-FAQs.pdf)).
5. **Check power ratings** of DAS antennas, dividers and loads against up to 2 × 40 W.
6. **Paperwork and kit.** Current calibration. Pack low-PIM load, PIM standard, low-PIM cable and adapters, torque wrenches, wipes and swabs, and a bagged steel-wool PIM marker.

### 4.2 On-site safety
- Lock off every radio or BDA feeding the line before disconnecting ([IEC 62037-7 §4.3](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
- Keep clear of radiating antennas. Nobody stands under or touches antennas under test ([Anritsu Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)).
- Tower crews climb away, because tools and belts create PIM ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf)).
- Do not bypass return-loss shut-down or warnings.

### 4.3 Set-up verification (residual PIM check)
1. Warm up 10 min ([MW82119B](https://www.atecorp.com/getmedia/9c6184b7-a4f5-4501-b614-1d63e2ec8200/mw82119b-datasheet_1.pdf)).
2. Clean and inspect every set-up connector. Use no seals on test cables ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf)).
3. Put the test lead and adapters into a low-PIM load and flex the lead. The residual must be at least 10 dB below the limit.
4. PIM standard within 3 dB. VSWR below 1.92:1. External signal at the IM frequency at least 10 dB below the limit with the tones off. ([IEC 62037-7 §6.2-6.4](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf))

### 4.4 PIM test SOP
1. **Inject at the radio connector.** Set power (2 × 43 dBm unless the spec says otherwise), F1/F2, and IM3 or the order the spec requires.
2. **Static PIM vs time.**
   - Duration: MCF ≥ 10 s ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)); AWT ≥ 30 s, with 2-4 dB swings acceptable ([AWT](https://awt-global.com/wp3/resources/pim/testing-low-pim-installations-and-components/)).
   - Then **swept PIM** across the receive band ([IEC 62037-7 §6.5](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
3. **Dynamic test.** Fixed frequencies, run long enough to reach every point (Anritsu: 30-60 s).
   - **Tapping.** Use a plastic screwdriver handle or the rubber end of a wrench, five taps per connector, never on the cable, and no harder than knocking on a door ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf); [IEC 62037-7 §6.6](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
   - **Conflict:** Anritsu's FirstNet note describes tapping "with a heavy item such as a wrench" ([FirstNet](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf)). Follow the IEC energy caps.
   - **Flexing cables, three methods.** IEC: 4× bend radius, three rotations. Anritsu: hold 12 in from the connector, at most 1 in off axis. AWT: about 10 cm circles, 10 turns each way.
4. **Record** the peak in dBm and dBc with all parameters. A failure goes to DTP before anything is opened.

### 4.5 Fault-finding SOP
1. **Locate.** Run DTP with the correct Vp. Overlay DTF (manual high-res, or auto in-band) to map the hit to a connector ([Anritsu DTP/DTF](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00869A.pdf)).
2. **Inside or beyond the antenna?** Tape a bagged steel-wool marker to the radome, store that trace, move the marker at least 3 m away, and re-measure.
   - Relative distance > 0: source is beyond the antenna.
   - = 0: at the antenna.
   - < 0: in the feed.
   - Use Vp = 1.0 for distances in air.
3. **Isolate.** Step a low-PIM load along the line. Then inspect, clean, re-torque or re-terminate at the hit ([Anritsu WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf); [CommScope FAQ](https://wirelessestimator.com/publicdocs/PIM-FAQs.pdf)).
4. **External sources.** Use a PIM probe along the DTP distance arc, and a 2-port test for cross-band IM3 ([Anritsu](https://www.anritsu.com/en-us/test-measurement/technologies/pim); [FirstNet](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-02865A.pdf)).
5. **Read the symptoms.** Diversity imbalance points to the noisy path. Noise on both paths points to something external. A site that is better after rain points to rusty mounts ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)).
6. **Re-test fully** and document any sources beyond the antenna.

### 4.6 Connector inspection, cleaning and torque
**Inspection and cleaning.**
1. Keep caps on until mating ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)).
2. Inspect with a magnifier for damage, flakes and pin condition ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)).
3. Blow out with low-pressure air. Use a toothpick for stuck particles.
4. Wipe with isopropyl alcohol on a swab or lint-free wipe, sparingly ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf); [IEC 62037-7 §6.2.2](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
5. Dry with air.
6. Mate straight, without twisting.
7. When terminating cable: cut with the cable facing down, deburr, and keep foam and adhesive off contacts ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)).

**Torque values from manufacturer documents. Where sources disagree, both are shown.**

| Connector | Torque | Tool | Source |
|---|---|---|---|
| 4.3-10 screw (hex) | 5 N·m (wrench 5 ± 0.3 N·m) | 22 mm | [Rosenberger](https://www.rosenberger.com/fileadmin/content/headquarter/Downloads/RF_Coaxial_Connectors/COM_43_10_Catalog_2020.pdf) |
| 4.3-10 hand-screw / push-pull | hand tight / no tools | none | same |
| 7-16 DIN | > 25 N·m (Rosenberger); 25-30 N·m = 221-265 in-lb ([Microwaves101](https://www.microwaves101.com/encyclopedias/connector-torque)); 20 ft-lb ≈ 27 N·m "accepted" ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)) | Anritsu's PIM kit lists a 1-1/4 in torque wrench (that it is the 7/16 wrench is my inference) | as listed |
| N | 0.7-1.1 N·m (Rosenberger); 12 in-lb ≈ 1.4 N·m "common" (Anritsu); stainless 12-15 in-lb / brass 6.2-9.7 in-lb (Microwaves101) | N wrench | as listed |
| NEX10 | 1.5 N·m (CommScope TW-N10 1.505 N·m / 13.32 in-lb; SPINNER 1.5 N·m) | 11 mm | [CommScope](https://www.andrew.com/products/fiber-power-rf-connectivity-accessories/accessories/installation-tools/itemtw-n10/), [SPINNER](https://products.spinner-group.com/torque-wrench-11-mm-1-5-nm-for-nex10-with-calibration-certificate-bn238743C0001) |
| SMA | brass 0.57 N·m (5 in-lb), stainless 0.9 N·m (8 in-lb) ([Taoglas](https://www.taoglas.com/assets/application-notes/SMA_Connector_Torque_Guide_(APN-25-8-001).pdf)); stainless 7-10 in-lb, brass 3-5 in-lb ([Microwaves101](https://www.microwaves101.com/encyclopedias/connector-torque)) | 5/16 in break-over wrench + backup wrench | as listed |
| QMA | none (snap-on) | none | [HUBER+SUHNER QMA](https://www.fclane.com/sites/default/files/pdf/qmaconnectorsen.pdf) |

Notes:
- 4.3-10 PIM is designed to be independent of torque.
- During DIN troubleshooting, Anritsu suggests removing the seals and testing at hand-tight, then refitting the seals and torquing for the final test ([WP](https://www.microwavejournal.com/ext/resources/BGDownload/4/8/Anritsu_Troubleshooting%20Passive%20Intermodulation%20Problems%20in%20the%20Field_WP.pdf)).
- One owner spec applies 16-18 ft-lb to all connections ([CU Denver](https://www.cuanschutz.edu/docs/librariesprovider260/design-and-construction/guidelines-and-standards/division-27/275319---distributed-antenna-system.pdf?sfvrsn=284fb9b9_2)). That fits 7/16 DIN only and would destroy N or SMA connectors.

### 4.7 Close-out and report contents
**Report fields.** IEC 62037-7 requires the residual PIM and the peak PIM per line under dynamic loading ([§8](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)). IEC 62037-1 adds tone power, F1, F2, the IM level and frequency, and the maximum over the test duration. CommScope's reports carry site information, sector and line description, TX frequencies and power, IM3 readings, the pass/fail threshold, date and time, and the operator ([FAQ](https://wirelessestimator.com/publicdocs/PIM-FAQs.pdf)).

**Also record:**
- Units in dBm and dBc.
- A tabular pass/fail summary, kept separate per frequency, IM order and instrument ([Anritsu PIM Test Reports](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00774C.pdf)).
- DTP traces with DTF-RL-Load and DTF-RL-Short overlays.
- Date-stamped screenshots and the original files ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)).
- Photos.
- Analyzer serial number and calibration date.
- Whether any high-reflection warning was bypassed.

**Before leaving:** refit the seals, cap the connectors, reconnect the radios and remove the lock-off.

---

## 5. PIM in DAS

**Loss changes the picture.**
- Each dB of loss between a PIM source and the head-end cuts the PIM seen at the BTS by about 3.5 dB. The formula is NPV = PV − 3.5 × IL, using a 2.5 dB/dB slope plus 1 dB on the return path.
- Anritsu's example: a −50 dBm source reads −71.7 dBm behind 6.2 dB of loss (fail against −97 dBm) but −112.3 dBm behind 17.8 dB (pass).
- Field DTP still found harmful sources as far as 226 m from the input, and Anritsu warns that bad workmanship near antennas can create harmful PIM deep in the network.
([Anritsu, PIM in DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf))

**Lower power, adjusted limits.**
- Indoor DAS runs from 20 W down to 0.1 W, so test near the power each point really sees ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00629F.pdf)).
- Valmont: when testing inside the DAS at power reduced by the loss L, relax the dBm limit by L and the dBc limit by 2L. Example: −87 dBm at +33 dBm through 10 dB of loss equals −97 dBm at the input. Using the head-end number everywhere over-tests ([Valmont](https://www.valmonttelecom.com/resources/article/pim-testing-in-das-networks)).
- MCF: test ≤ 5 W segments at 2 × 33 dBm.

**Where to test, building as you go** ([Anritsu Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)):
1. Pre-test each antenna location at low power with a temporary antenna. If PIM is high, move about 1 m.
2. Test individual cables.
3. Test each floor (antennas + cables + splitters).
4. Test the riser with low-PIM loads on the tapper outputs.
5. Test the full system from the DAS input.
6. Run continuity and walk tests.

MCF adds each multi-network-combiner input, with outputs on a precision load, and each segment individually ([MCF 7.5](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)). To isolate a failing floor, terminate the divider outputs and re-add branches one at a time ([Anritsu DTP/DTF](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00869A.pdf)).

**Bands.** One low and one high band is generally enough to find DAS PIM. For example, sweep 400-2700 MHz and run PIM at 700 and 1900 MHz for a public-safety-to-LTE-2600 DAS ([Anritsu Testing DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)). MCF requires low, mid and high.

**BDA, remotes and filters.**
- Tones and the IM product must pass every device in the path. Bypass filter combiners that block them ([Anritsu PIM in DAS](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf); [IEC 62037-7 §4.2](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
- In a hybrid DAS, treat each remote as the combiner point and PIM-test the passive network from there ([MCF 3.18.2](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)).
- Check antenna and divider power ratings ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)).
- Lock off radios and BDAs before disconnecting ([IEC 62037-7 §4.3](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf)).
- The sources describe testing the passive network from the remote point. None describes PIM testing *through* an amplifier, so do not inject tones into BDA ports.

**Multiple operators.**
- Multiband, multicarrier signals mix at each passive stage, so components near the sources need the best ratings ([CommScope](https://www.commscope.com/Blog/PIM-Requirements-Must-Increase-to-Support-Evolving-DAS-Systems/)).
- High-power loads on hybrid combiners often have poor IM3. That is acceptable where only one operator's IM7/IM9 lands in-band. Use low-PIM cable loads where operators or bands share the hybrid ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00871B.pdf)).

**Cable and connectors.**
- Solid-outer-conductor cable only. No braided cable, no joiners, no inter-series adapters. 7-16, 4.3-10 or N per the lead carrier ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf)).
- Plenum example: [RFS ICA12-50JPL](https://www.rfstechnologies.com/pim/product/html/ICA12-50JPL) (NFPA 262/CMP/CATVP; solid inner and outer conductors; no dBc number published).
- **Radiating cable:** sweep from both ends on runs over 400 ft, or measure insertion loss with a source and a spectrum analyzer ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)). No published PIM rating for radiating cable or its connectors was found ([RFS connector data sheet](https://www.rfsworld.com/pim/product/pdf/NF-RA78-016)).

**Pitfalls** ([MCF](https://amta.org.au/wp-content/uploads/2023/11/MCF-Design-Specification-for-Distributed-Antenna-Systems-Draft-1.0.pdf) unless noted):
- Ceiling clutter: cable trays, vents, AC units, flashing, and loose metal within 500 mm.
- Concealed or low-profile antennas without a backplane. The lead carrier will not commission a DAS whose concealed antennas fail PIM.
- Components hung on weak plasterboard anchors.
- Untrained installers.
- Foam and glue in connectors ([Anritsu DTP/DTF](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00869A.pdf)).
- Applying the head-end limit everywhere ([Valmont](https://www.valmonttelecom.com/resources/article/pim-testing-in-das-networks)).
- Testing only at the head-end, where DAS loss masks faults ([Anritsu](https://dl.cdn-anritsu.com/en-us/test-measurement/files/Application-Notes/Application-Note/11410-00887A.pdf)).

**Public safety on the DAS.**
- PIM testing is not a code requirement under IFC 510 or NFPA 1225 as far as the sources show.
- AHJs may request results, as DC OUC does.
- Low-PIM parts exist for VHF/UHF: a 138-960 MHz coupler and an antenna covering 350-470 MHz, both rated −153 dBc.
- Field analyzers found only for UHF 380-470 MHz (AWT) and the cellular bands. **VHF field PIM test practice and equipment remain a gap.**

---

## Sources opened
IEC: [62037-1:2012](https://webstore.iec.ch/en/publication/6331), [62037-1:2025](https://cdn.standards.iteh.ai/samples/116552/76c2985fd6a341198848a002b3719723/IEC-62037-1-2025.pdf), [62037-2](https://cdn.standards.iteh.ai/samples/103907/acf50ade5ad44b87bba30a67e2b3a97e/IEC-62037-2-2021.pdf), [62037-3](https://webstore.iec.ch/en/publication/6333), [62037-4](https://webstore.iec.ch/en/publication/6334), [62037-5](https://webstore.iec.ch/en/publication/72272), [62037-6](https://assets.vde-verlag.de/iec-normen/preview-pdf/info_iec62037-6%7Bed2.1%7Den.pdf), [62037-7](https://cdn.standards.iteh.ai/samples/102527/7a671318b83d4b848af48547951a775f/IEC-62037-7-2022.pdf), [62037-8](https://cdn.standards.iteh.ai/samples/101679/5c225f603524457a9b81fcae86898009/IEC-62037-8-2022.pdf). Anritsu app notes: 00629F, 01008A, 02865A, 00871B, 00887A, 00869A, 00774C; troubleshooting white paper; PIM page; MW82119B and S331P data sheets. Kaelus iPA/iXA data sheets; Rosenberger catalogs and alpha page; AWT pages; Bird SiteHawk; CommScope FAQ, blogs, TW-N10, CMAX; SPINNER; HUBER+SUHNER QMA; Taoglas; Microwaves101; Microlab; Norsat; RFS; MCF DAS spec; Valmont; IFC 2018 §510 text; Safer Buildings primer; DC OUC; ETA DAST; CU Denver; FCC DA 09-1783; Sensors 2020; Microwaves & RF; Interference Technology. Full list with URLs: `pim.json` → `sources`.
