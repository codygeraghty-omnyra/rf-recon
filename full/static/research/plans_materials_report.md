# RF Recon research: building plans and building-material RF loss

Prepared 2026-10-29 for RF Recon (US public-safety DAS / ERCES / BDA site surveys). Companion data file: `plans_materials.json` in this folder. Every number below comes from a document opened during this research. Values computed from published coefficients are marked "computed". Where a document could not be opened, it is listed under Gaps and no numbers from it are used.

JSON conventions: `loss_db` and `frequency_mhz` are numbers when the source gives a single value, a `"low-high"` string when it gives only a range, and `null` when it gives neither. `measured` rows from NISTIR 6055 are the published regression curves evaluated at 500, 750 and 1000 MHz and checked against the plotted curves.

---

## Part 1. Getting a building's plans and facts

### 1.1 Who has the drawings

| Holder | What you get | How to ask | Limits |
|---|---|---|---|
| Owner / property manager | Permit or record (as-built) set, usually PDF; for an existing ERCES, its approved plans and test report | Written request naming sheets (template in 1.4) | Often PDF or paper only. The architect keeps copyright in the design: an "architectural work" is the building design embodied in "a building, architectural plans, or drawings" ([Copyright Office Circular 41](https://www.copyright.gov/circs/circ41.pdf)). |
| General contractor (during construction) | Current construction set plus revisions, BIM coordination models | RFI through the GC. AIA G716 is "a standard form for an owner, architect, contractor or other party" to request information from each other during construction; RFIs should be numbered, logged and tracked ([AIA G716 summary](https://help.aiacontracts.com/hc/en-us/articles/1500009444782-Summary-G716-2004-Request-for-Information-RFI)). | The GC may need the architect's or owner's permission to release CAD. |
| Architect of record | DWG backgrounds or the Revit model (IFC export), wall-type and glazing schedules, life-safety plans | Through the owner or GC, with the owner's written authorization | Drawings are "instruments of professional service" ([Covina IB-40, summarizing CA HSC 19851](https://covinaca.gov/wp-content/uploads/2024/01/IB-40-DUPLICATION-OF-PLANSopt.pdf)). |
| MEP / fire alarm engineer, low-voltage contractor | Electrical and FA risers, electrical/IDF rooms, pathways, firestop details | With the architectural request | Fairfax County requires the ERCES-to-fire-alarm connection on the FA permit and the riser and firestop systems on the building permit plans ([Fairfax ERCES guide v2](https://www.fairfaxcounty.gov/fire-ems/sites/fire-ems/files/Assets/Documents/PDF/fire%20marshal/ERCES%20Submittal%20and%20Permit%20Requirements%20Guidelines.pdf)). |
| Fire department | Pre-incident plans | Ask fire prevention. Pre-incident planning (formerly NFPA 1620, 2020) was consolidated with NFPA 1600 and 1616 into NFPA 1660 (2024) ([GovTech](https://www.govtech.com/em/emergency-blogs/disaster-zone/nfpa-1600-now-known-as-nfpa-1660)). | Internal documents. Florida exempts security and firesafety system plans of private property held by an agency ([Fla. Stat. 119.071](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0119/Sections/0119.071.html)). |

How to find the right sheets: US drawing sets follow the National CAD Standard sheet ID format, discipline + sheet type + sequence ([NCS v6 UDS Module 1](https://www.nationalcadstandard.org/ncs6/pdfs/ncs6_uds1.pdf)).

- **Disciplines:** A Architectural, S Structural, F Fire Protection, E Electrical, T Telecommunications.
- **Sheet types:** 1 plans, 2 elevations, 3 sections, 4 large-scale views, 5 details, 6 schedules and diagrams.
- **Example:** A-1xx are architectural floor plans, and E-6xx usually holds schedules and riser diagrams.

### 1.2 Public sources: permit portals and records requests

**Permit portals.** What the public sees depends on how each agency configures its portal:

- **Accela Citizen Access.** General Search by record number, type or project name "still see[s] the detailed processing status". Downloading "secure documents" requires the case manager to grant your account access ([Arapahoe County ACA guide](https://cms3.revize.com/revize/arapahoe/Public%20Works_Development/Accela%20Citizen%20Access%20DO%20NOT%20DELETE/View%20And%20Manage%20Plans%20And%20Documents.pdf)).
- **Tyler EnerGov Citizen Self Service.** "On the CSS home page, users have access to public information without being logged in." Search covers permits and plans by number, project or address ([Goose Creek CSS guide 2020.1](https://www.goosecreeksc.gov/sites/default/files/PIO/CSS%20User%20Guide%202020.1.pdf)).
- **CentralSquare eTRAKiT.** Attachments sit on the Permit Info tab, but "to view attachment information, users must be logged into an account." Attachments for permits before September 2024 need a records request ([Johnstown CO help](https://johnstownco.gov/588/eTRAKiT-Help-Guide)).
- **OpenGov.** Public search works without login, by Location (address). It shows only "Records whose Record Types are enabled for Public Search" ([Lake County CA guide](https://www.lakecountyca.gov/1806/New-Online-Permitting-Software-Guide-for)).

Practical read: portals reliably give permit history (whether a BDA/ERCES permit exists, the contractor, dates). Plan sheets are the exception, not the rule.

**Public-records requests.** FOIA covers records of "any federal agency" ([FOIA.gov FAQ](https://www.foia.gov/faq.html)). City and county permit files go through state law, which often restricts plans:

- **Florida (s. 119.071, 2026).**
  - (3)(b) exempts building plans, blueprints, schematic drawings and diagrams of structures owned or operated by an agency. They may still be released to another governmental entity, to a licensed architect, engineer or contractor working on the structure, or on a court showing of good cause.
  - (3)(c) exempts the same records held by an agency for privately owned attractions, industrial complexes, retail and service developments, office developments, health care facilities and hotels or motels. Site and comprehensive plans are excluded from that exemption.
  - (3)(a) exempts security or firesafety system plans of private property ([source](http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0100-0199/0119/Sections/0119.071.html)).
- **California (Health & Safety Code 19850-19853).** Official plan copies are for inspection only. Duplication needs written permission from both the design professional who signed them and the owner, or a court order. The requester signs an affidavit that copies are used only for maintenance, use and operation of the building. The architect's refusal counts as unreasonable if they don't respond within 30 days ([Covina IB-40](https://covinaca.gov/wp-content/uploads/2024/01/IB-40-DUPLICATION-OF-PLANSopt.pdf)).

### 1.3 What AHJs require in ERCES/BDA submittals (drives what you need from the owner)

- **San Diego Fire-Rescue Standard C-1** (eff. 06/01/2023, rev. 01/22/2026) ([PDF](https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf)).
  - Format: a fire permit is required for every ERCES. Submittals are PDF on Architectural D (24x36) sheets.
  - Every floor plan and elevation carries a legend, a graduated-ruler scale, compass orientation and unique IDs.
  - The cover sheet lists construction type per floor, floors above and below grade, square footage, occupancy and sprinkler standard.
  - Floor plans are required for every level, roof to lowest, including levels without system components, with fire-rated callouts.
  - Also required: a system elevation schematic, donor path plan and elevation views, and 700/800 MHz link budgets.
  - Test reports use 20 roughly equal grids per floor. As-built plans and the acceptance report are due before TCO.
- **Orange County Sheriff's Department, Rev 4.5** (8/4/2025) ([PDF](https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf)).
  - Base: Architectural D building prints in PDF.
  - Content: building description including type of construction; a riser with uplink/downlink power at every junction; floor plans for all floors; exterior elevations for all exposures; 20-grid heat maps for every floor.
  - Scale must be a graduated ruler. A relational scale such as 1"=20' is "not acceptable".
- **Santa Clara County FD, C-2** (rev 09/01/20) ([PDF](https://www.sccfd.org/wp-content/uploads/2024/10/C-2-Emergency-Respodner-Radio-Coverage-Systems.pdf)).
  - Floor plans: minimum scale 1/8"=1'-0" with a graphic scale (metric not accepted). They show room names and "the locations of partitions, non-rated walls, and rated walls."
  - Title sheet: building height, total area and construction type.
- **Fairfax County, VA, v2** (Sept 2025) ([PDF](https://www.fairfaxcounty.gov/fire-ems/sites/fire-ems/files/Assets/Documents/PDF/fire%20marshal/ERCES%20Submittal%20and%20Permit%20Requirements%20Guidelines.pdf)).
  - DIT reviews the design first.
  - Building permit plans show the extent of the system, the DIT-approved riser and every through-penetration firestop system.
  - The FCOMM permit needs the approved building-plan pages that show communications items.
- **Durham County, NC Fire Marshal** ([page](https://dconc.gov/Emergency-Services/Services-and-Special-Operations/Permits-and-Inspections)).
  - ERRC requests go to the City-County Inspections site.
  - County fire protection submittals need shop drawings, life safety plans and an Appendix B, sealed by an NC PE or licensed fire sprinkler contractor.
  - The City of Durham ERRCS PDFs returned HTTP 403 and were not read.

**Implication for RF Recon:** every one of these AHJs expects floor plans for all levels at a stated scale, and they ask for construction type. Santa Clara also asks for wall ratings and locations. The plan request should therefore ask for floor plans for every level, the wall-type schedule, life-safety plans and elevations, not just "the floor plans".

### 1.4 Plan-request template (plain text; in `plan_request` in the JSON)

Subject: Request for building drawings - in-building public safety radio (ERCES/BDA) design at [Building, address]

Body (see JSON for exact text). It asks for:

1. Architectural floor plans for every level (basements, parking, penthouse, roof).
2. Reflected ceiling plans.
3. Sections and exterior elevations.
4. Wall-type/partition schedule and the glazing schedule, including low-E or coated glass.
5. Life-safety plans.
6. Electrical and FA risers and electrical/telecom room locations.
7. Roof and site plans.
8. The structural floor type.
9. Any existing BDA/DAS as-builts and test reports.

It asks for full-size vector PDFs plus DWG or Revit/IFC if the architect can release them. It offers to limit use to design, permitting and maintenance, and asks the owner to authorize the architect to release CAD.

Why each item matters:

- **Wall types and glazing** drive attenuation, which is the second half of this report.
- **Reflected ceiling plans** show mounting surfaces.
- **Life-safety plans** show rated shafts and rooms, which matter for survivable pathways and for the "rated walls" Santa Clara wants on the floor plan.
- **Risers** show power and fire-alarm monitoring.
- **Roof and site plans** set the donor antenna location and path, which SDFD and OCSD require.

### 1.5 File formats and how design tools take them

- **iBwave Design** imports floor plans from .dwg, .dxf, .jpeg, .bmp, .tiff, .gif or .pdf. It exports to .dxf, has a ruler for dimensions and areas, and its mobile planner can "create, scale and geolocalize floor plans" ([iBwave Design Suite datasheet](https://www.ibwave.com/storage/app/media/pdf/datasheets/iBwave-Design-Suite-datasheet.pdf)). IFC/Revit import is not listed in the iBwave material opened.
- **Ranplan Professional** ([2025 datasheet](https://www.ranplanwireless.com/hubfs/Datasheets/Ranplan-Professional-Datasheet-2025.pdf?hsLang=en); [IFC page](https://www.ranplanwireless.com/resources/import-3d-building-model-from-ifc-files)):
  - imports BIM files from any BIM authoring software;
  - "Smart CAD Extract" converts 2D/3D CAD into 3D models;
  - "Intelligent Floor Plan Recognition" converts background images into vector models;
  - 6.9+ imports IFC "including geometry, material properties, and spatial relationships" from Revit, ArchiCAD, SketchUp, Tekla and others, plus LiDAR scans via the Metaroom app.
- **Scaling scanned PDFs:** calibrate on the sheet's graduated bar scale or a long dimension string. Do not trust a printed ratio after the sheet has been resized; OCSD rejects relational scales for that reason.

### 1.6 Open data for building facts

| Dataset | Building facts | Coverage | Access | Cost |
|---|---|---|---|---|
| [OpenStreetMap](https://wiki.openstreetmap.org/wiki/Key:building:material) | `building:levels` (above-ground, excludes roof and underground levels) ([wiki](https://wiki.openstreetmap.org/wiki/Key:building:levels)); `height` (m, ground to top of roof) ([wiki](https://wiki.openstreetmap.org/wiki/Key:height)); `building:material` = outer facade surface, not structure; `roof:material`; indoor via [Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging) (`indoor=room/area/wall/corridor/door`, `level=*`, walls mapped on centerlines) | Global, crowd-sourced, uneven | [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) `https://overpass-api.de/api/interpreter` (under 10,000 queries and 1 GB per day for one-off use; divide by 100 for regular use; commercial users self-host) | Free, [ODbL](https://www.openstreetmap.org/copyright) |
| [Microsoft GlobalMLBuildingFootprints](https://github.com/microsoft/GlobalMLBuildingFootprints) | Footprint, height estimate (m, -1 if none), confidence | Global including the US | `dataset-links.csv`, quadkey-partitioned GeoJSON lines | Free, CDLA Permissive 2.0 |
| [Google Open Buildings](https://sites.research.google/gr/open-buildings/) | Footprint, area, confidence | Africa, South/SE Asia, LatAm/Caribbean; no mainland US (PR and USVI only) | `gs://open-buildings-data/v3/...` | Free, CC BY 4.0 or ODbL |
| [Overture buildings](https://docs.overturemaps.org/guides/buildings/) | `height`, `num_floors`, `num_floors_underground`, `facade_material`, `roof_material`, `roof_shape`, `class` ([schema](https://docs.overturemaps.org/schema/reference/buildings/building/)) | Global, monthly; OSM gets top priority, then Esri Community Maps, Microsoft, Google | `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/...` | Free, ODbL |
| [FEMA/ORNL USA Structures](https://pmc.ncbi.nlm.nih.gov/articles/PMC11099081/) | Structures over 450 sq ft: OCC_CLS, PRIM_OCC, HEIGHT (only where NGA LiDAR existed, 133 cities), SQMETERS, address. No material, no stories | US and territories, about 127M structures | Figshare, FEMA GRC, Esri Living Atlas | Free |
| [USACE NSI 2026](https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/2026/technical-documentation) | `bldgtype` M/W/H/S (masonry/wood/manufactured/steel), `num_story`, `sqft`, `found_type`, `bldheight`, `med_yr_blt` (tract median only). Many values modeled | Nationwide | [API](https://www.hec.usace.army.mil/confluence/nsi/technicalreferences/latest/api-reference-guide) `https://nsi.sec.usace.army.mil/nsiapi/structures?bbox=...` or `?fips=...` | Free (public fields) |
| County assessor (example: [Cook County IL](https://datacatalog.cookcountyil.gov/api/views/x54s-btds.json)) | `char_yrblt`, `char_ext_wall` (exterior wall material), `char_roof_cnst`, `char_type_resd`, `char_bldg_sf` | County by county; this one is residential under 7 units only | Socrata API | Free here |
| [Regrid](https://support.regrid.com/docs/buildings-structures) | County-sourced `yearbuilt`, `numstories`, `structstyle`, `area_building`; Premium `ll_bldg_count`, `ll_bldg_footprint_sqft` | 160M+ US parcels; attribute coverage varies by county ([schema](https://support.regrid.com/parcel-data/schema)) | App, API, data store | Commercial; [pricing page](https://regrid.com/pricing) shows plans and enterprise sales, no prices |
| [ATTOM](https://cloud-help.attomdata.com/article/497-property-characteristics) | Construction (main-structure material), exterior wall, roof cover and framing, fire-resistance class; API `wallType`, `levels` | About 150M US records ([API](https://api.developer.attomdata.com/home)) | REST API, ATTOM Cloud | Commercial; free trial key |

Bottom line: no free nationwide source gives wall construction. NSI's `bldgtype` and assessor exterior-wall fields are the closest. Footprints and heights are well covered, by Microsoft, Overture and USA Structures.

---

## Part 2. RF properties of building materials

### 2.1 ITU-R P.2040 material parameters (exact coefficients)

**Edition.** [P.2040-4 (09/2025)](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2040-4-202509-I!!PDF-E.pdf) is the edition in force ([edition list](https://www.itu.int/rec/R-REC-P.2040/en)). Its scope is now 1 MHz to 450 GHz.

**Model.** Table 3 gives ε′ = a·f^b and σ = c·f^d (S/m), with f in GHz (eqs 57 and 58). ε″ = 17.98σ/f (eq 59). The ranges are "not hard limits", except for ground types, which must stay within 1–10 GHz.

**Rows below 1 GHz.** Only vacuum, wood (0.001–100 GHz) and glass (0.1–100 GHz) are characterized below 1 GHz. Using concrete, brick or plasterboard at VHF/UHF is extrapolation.

P.2040-4 Table 3 rows used for building work (all have b = 0 except grounds):

| Material | a | b | c | d | GHz |
|---|---|---|---|---|---|
| Vacuum (≈air) | 1 | 0 | 0 | 0 | 0.001–100 |
| Concrete | 5.24 | 0 | 0.0462 | 0.7822 | 1–100 |
| Brick | 3.91 | 0 | 0.0238 | 0.16 | 1–40 |
| Plasterboard | 2.73 | 0 | 0.0085 | 0.9395 | 1–100 |
| Wood | 1.99 | 0 | 0.0047 | 1.0718 | 0.001–100 |
| Glass | 6.31 | 0 | 0.0036 | 1.3394 | 0.1–100 |
| Ceiling board | 1.48 | 0 | 0.0011 | 1.0750 | 1–100 |
| Chipboard | 2.58 | 0 | 0.0217 | 0.7800 | 1–100 |
| Plywood | 2.71 | 0 | 0.33 | 0 | 1–40 |
| Marble | 7.074 | 0 | 0.0055 | 0.9262 | 1–60 |
| Floorboard | 3.66 | 0 | 0.0044 | 1.3515 | 50–100 |
| Metal | 1 | 0 | 10^7 | 0 | 1–100 |
| Very dry ground | 3 | 0 | 0.00015 | 2.52 | 1–10 only |
| Medium dry ground | 15 | −0.1 | 0.035 | 1.63 | 1–10 only |
| Wet ground | 30 | −0.4 | 0.15 | 1.30 | 1–10 only |

**Additional P.2040-4 rows** (sub-THz unless noted). All are in the JSON.

| Material | a | c | d | GHz |
|---|---|---|---|---|
| Concrete | 5.17 | 0.0145 | 1.0900 | 110–330 |
| Brick | 4.15 | 0.0006 | 1.5712 | 110–330 |
| Plasterboard | 2.56 | 0.0001 | 1.7799 | 110–330 |
| Plasterboard | 2.65 | 0.0002 | 1.598 | 100–400 |
| Wood | 1.82 | 0.0040 | 1.0761 | 110–330 |
| Wood | 2.1183 | 0.0055 | 1.1113 | 100–400 |
| Glass | 5.79 | 0.0004 | 1.658 | 220–450 |
| Glass | 6.5767 | 0.0012 | 1.4697 | 100–400 |
| Clear acrylic | 2.58 | 0.0001 | 1.6524 | 110–330 |
| Ceiling board | 1.52 | 0.0029 | 1.029 | 220–450 |
| Ceiling board | 1.2567 | 0.00013 | 1.454 | 100–400 |
| Chipboard | 2.16 | 0.0023 | 1.359 | 100–200 |
| Plywood | 1.94 | 0.0067 | 0.9982 | 110–330 |
| Plywood | 2.17 | 0.0063 | 1.045 | 100–400 |
| Marble | 7.94 | 0.0001 | 1.7330 | 110–330 |
| Marble | 8.62 | 0.0027 | 1.15 | 100–400 |
| Floorboard | 5.27 | 2.22×10^-17 | 7.3413 | 220–300 |
| Floorboard | 5.27 | 0.0003 | 2.0298 | 300–400 |
| Floorboard | 5.27 | 49.8726 | 0 | 400–450 |
| Floorboard | 3.1575 | 0.001675 | 1.32775 | 100–400 |
| Vinyl tile | 3.62 | 0.0051 | 0.8422 | 1–40 |
| Carpet tile | 2.08 | 0.0009 | 0.8200 | 1–40 |
| Asphalt concrete | 4.83 | 0.0108 | 1.3969 | 1–40 |

**Other editions.**

- [P.2040-3 (08/2023)](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2040-3-202308-S!!PDF-E.pdf), Table 3 "Material properties", has the same values as -4 for every row it shares.
- [P.2040-1 (07/2015)](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2040-1-201507-S!!PDF-E.pdf) had different fits: concrete 5.31/0.0326/0.8095; brick 3.75/0.038/0 (1–10 GHz); plasterboard 2.94/0.0116/0.7076; glass 6.27/0.0043/1.1925; ceiling board 1.50/0.0005/1.1634. Chipboard, floorboard, metal and grounds are unchanged.
- 3GPP TR 38.901 Table 7.6.8-1 still lists the P.2040-1 set.

**Caution on plywood.** The P.2040-4 plywood row has constant σ = 0.33 S/m. It predicts about 6.7 dB for a 19 mm sheet at 0.15–1.9 GHz (computed). NIST measured only 0.6–0.8 dB for 19 mm plywood at 0.75–1 GHz. Its loss tangent at 1 GHz (≈2.2) also exceeds the 0.5 that P.2040 says all Table 3 dielectrics satisfy. Prefer the wood row or measured data for plywood.

### 2.2 3GPP TR 38.901 O2I penetration (f in GHz)

Sources: [ETSI TR 138 901 V19.2.0 (2026-02)](https://www.etsi.org/deliver/etsi_tr/138900_138999/138901/19.02.00_60/tr_138901v190200p.pdf) Tables 7.4.3-1/-2/-3, compared against [V16.1.0 (2020-11)](https://www.etsi.org/deliver/etsi_tr/138900_138999/138901/16.01.00_60/tr_138901v160100p.pdf).

**Material losses (Table 7.4.3-1):**

| Material | Formula | Notes |
|---|---|---|
| Standard multi-pane glass | L = 2 + 0.2f | 3 cm reference |
| IRR glass, Rel-19 | L = 25.4 + 0.11f | Single coating; updated in the Rel-19 7–24 GHz study |
| IRR glass, Rel-14–18 | L = 23 + 0.3f | As in V16.1.0 |
| Concrete | L = 5 + 4f | 23 cm reference |
| Wood | L = 4.85 + 0.12f | 3.3 cm reference |
| Plywood (new in Rel-19) | L = 1.03 + 0.17f | 1.75 cm reference |

**External wall (eq 7.4-3):** PL_tw = PL_npi − 10·log10(Σ p_i·10^(−L_i/10)). Total O2I path loss is PL = PL_b + PL_tw + PL_in + N(0, σ_P²) (eq 7.4-2).

**Building models (Table 7.4.3-2):**

| Model | PL_tw | PL_in | σ_P |
|---|---|---|---|
| Low-loss | 5 − 10·log10(0.3·10^(−L_glass/10) + 0.7·10^(−L_concrete/10)) | 0.5·d_2D-in | 4.4 dB |
| High-loss | 5 − 10·log10(0.7·10^(−L_IRRglass/10) + 0.3·10^(−L_concrete/10)) | 0.5·d_2D-in | 6.5 dB |
| Low-loss A (Rel-19, SMa) | same form as low-loss with 0.7·plywood in place of concrete | 0.5·d_2D-in | 4.4 dB |

**Legacy single-frequency model below 6 GHz (Table 7.4.3-3):** PL_tw = 20 dB, σ_P = 0, σ_SF = 7 dB.

**Scope:** 0.5–100 GHz. It does not cover 150 or 450 MHz.

**Computed examples:**

| | 700 MHz | 1.9 GHz |
|---|---|---|
| Low-loss PL_tw | 10.2 dB | 11.7 dB |
| High-loss PL_tw (Rel-19 IRR) | 17.9 dB | 22.4 dB |

### 2.3 ITU-R P.2109-2 building entry loss (statistical, 80 MHz–100 GHz)

[P.2109-2 (08/2023)](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2109-2-202308-I!!PDF-E.pdf) splits buildings into "traditional" and "thermally-efficient". Thermally-efficient means metallised glass, foil-backed panels and similar, and the split is about thermal efficiency, not age. The equations and Table 1 coefficients are in the JSON `formulas`.

Computed median loss at horizontal incidence:

| Frequency | Traditional | Thermally-efficient |
|---|---|---|
| 150 MHz | 14.0 dB | 37.3 dB |
| 450 MHz | 14.0 dB | 32.6 dB |
| 700 MHz | 14.1 dB | 31.6 dB |
| 850 MHz | 14.2 dB | 31.2 dB |
| 1.9 GHz | 14.9 dB | 30.5 dB |

At P = 0.9 (only 10% of locations lose more), traditional buildings reach about 23–27 dB and thermally-efficient about 47–51 dB.

### 2.4 Measured data

**NISTIR 6055** (Stone, 1997) ([PDF](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir6055.pdf)) measured lab specimens with time-gated free-space transmission at 0.5–2 GHz and 3–8 GHz. The values below are the published dB regression polynomials evaluated by us and checked against the plots.

| Specimen | 500 MHz | 750 MHz | 1000 MHz |
|---|---|---|---|
| Brick 89 / 178 / 267 mm | 0.5 / 3.4 / 3.8 | 2.6 / 4.5 / 5.5 | 3.7 / 5.5 / 6.9 |
| Concrete 102 / 203 / 305 mm (mix 1) | 9.7 / 19.8 / 32.3 | 11.0 / 21.5 / 34.6 | 12.2 / 23.1 / 34.8 |
| Concrete 203 mm (mix 8 ref.) | 22.5 | 25.3 | 27.8 |
| Reinforced 203 mm, 1% / 2% steel | 22.3 / 26.4 | 25.0 / 28.5 | 27.3 / 30.1 |
| CMU 203 / 406 / 610 mm | 8.3 / 13.2 / 26.3 | 10.7 / 16.0 / 27.2 | 11.5 / 17.3 / 27.9 |
| Brick 90 + concrete 102 / 203 mm | 11.1 / 20.7 | 12.4 / 22.5 | 13.9 / 25.0 |
| Brick 90 + CMU 194 mm | 8.2 | 9.9 | 10.9 |
| Clear glass 6 / 13 / 19 mm | 0.2 / 1.3 / 2.3 | 0.5 / 1.8 / 2.7 | 0.8 / 2.2 / 3.1 |
| Plywood 6 / 13 / 19 / 32 mm | 0.1 / 0.1 / 0.4 / 0.7 | 0.3 / 0.3 / 0.6 / 1.1 | 0.5 / 0.5 / 0.8 / 1.4 |
| SPF lumber 38 / 76 / 114 / 152 mm | 2.0 / 1.4 / 2.1 / 4.4 | 2.5 / 2.1 / 2.9 / 5.3 | 2.9 / 2.8 / 3.9 / 6.1 |

Further NIST notes:

- **Drywall:** 6–16 mm panels lose less than 1 dB over 0.5–2 GHz (Fig 4.13b). The coefficient table mislabels all three panels "D25L", so it was not used.
- **Concrete at 3.5 GHz** (read from Fig 4.4d, ±1 dB): about 24 dB for 102 mm, 46–47 dB for 203 mm and about 74 dB for 305 mm.
- **Concrete mixes:** NIST found aggregate size and water/cement ratio had no observable effect, and slump only a small one.

**NIST TN 1545** (Holloway et al.) ([PDF](https://www.npstc.org/download.jsp?tableId=37&column=217&id=1915&file=TN+1545+Attenuation+of+Radio+Wave+Signals+Coupled+Into+Twelve+Large+Building+Structures.pdf)) measured whole buildings at public-safety bands. A transmitter was carried inside and the receiver sat outside; values are normalized to a line-of-sight reference. Mean loss from Table 27:

| Building | 150 MHz | 450 MHz | 900 MHz |
|---|---|---|---|
| New Orleans apartment | 27.9 | 39.7 | 34.2 |
| Philadelphia stadium | 39.2 | 28.7 | 27.2 |
| Colorado Springs hotel | 37.6 | 30.0 | 34.1 |
| Boulder grocery store | 36.0 | 29.2 | 33.8 |
| NIST office, Gaithersburg | 41.6 | 46.9 | 57.7 |
| Discovery office, Silver Spring | 55.7 | 52.4 | 70.4 |
| DC convention center | 66.0 | 57.3 | 66.4 |
| Horizon West apartment | 24.9 | 25.4 | 27.0 |
| NIST lab, Boulder | 54.8 | 37.9 | 28.9 |

Within-building standard deviation averaged about 12–13 dB in every band (Table 25). Median received power was typically 2–3 dB below the mean, so median loss runs 2–3 dB above the mean values shown. Loss does not rise monotonically with frequency at building scale.

**Modern and energy-efficient construction:**

- **Aalborg** ([Rodriguez et al. 2014](https://vbn.aau.dk/ws/files/204386691/modern_attenuation_IEEE.pdf)), Table I, average facade loss over 0.8–18 GHz:
  - modern concrete/brick office: 24.86 dB;
  - all-glass building: 31.98 dB;
  - high-insulation test facility: 28.43 dB;
  - old building: 5.16 dB.
  - Energy-efficient window paths measured about 15 dB at 800 MHz.
- **Ofcom 2014** ([mirror](http://www.qostic.org/Qostic/wp-content/uploads/Qostic6/AHQ-78-05-Building_Materials_and_Propagation.pdf)): foil-backed plasterboard plus metallised double glazing added 5–10 dB to a small house's entry loss across 88–5760 MHz. Foiling all apertures added about 5 dB more. The same report notes that concrete permittivity data scatter by a factor of 4, which means a factor-of-2 uncertainty in attenuation rate.
- **Low-E glass:**
  - FOI/KTH ([Ängskog et al. 2015](http://www.diva-portal.org/smash/get/diva2:860029/FULLTEXT01.pdf)): coated panes 10–30 dB and low-e window structures 15–45 dB at 1–18 GHz, versus about 0 dB for clear float glass.
  - PPG TD-151 ([Graham note](https://www.grahamwindows.com/wp-content/uploads/electromagnetic.pdf)): one triple-silver laminate about 40 dB and two about 54 dB at 0.8–3 GHz.
  - Cardinal E272/E366 coated samples transmitted 4.6–9.6% of the field at 0.5–0.9 GHz, which is about 23–27 dB (computed as 20·log10(1/T)).
- **Floors:** [P.1238-13](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.1238-13-202509-I!!PDF-E.pdf) Table 5 gives office floor loss at 0.9 GHz of 9, 19 and 24 dB for 1, 2 and 3 floors. At 1.8–2 GHz it gives 15+4(n−1) for offices, 4n for residential and 6+3(n−1) for commercial. A reinforced concrete floor with a false ceiling measured 20 dB at 5.2 GHz (30 dB with light fixtures, 36 dB with ducts).

### 2.5 One-wall loss from P.2040 (how RF Recon should compute it)

1. **Material.** Pick the Table 3 row for the band and form εrc = ε′ − j·17.98σ/f.
2. **Interface reflection** at normal incidence: R′ = (1 − √εrc)/(1 + √εrc), from eq 37a with θ = 0.
3. **Phase thickness:** q = 2π·d·√εrc / λ (eq 44).
4. **Transmission:** T = (1 − R′²)·e^(−jq) / (1 − R′²·e^(−j2q)) (eq 43b). Loss_dB = −20·log10|T|.
5. **Multi-layer walls:** use the ABCD chain in Attachment 1 (eqs 60–63), with air layers at η = 1.
6. **Check.** This implementation reproduces P.2040-4 Fig 6: about 7.5 dB for a 0.2 m concrete slab at 1 GHz.

Computed single-slab losses at normal incidence (dB):

| Slab | 150 MHz | 450 MHz | 700 MHz | 850 MHz | 1.9 GHz | 3.5 GHz |
|---|---|---|---|---|---|---|
| Concrete 102 mm | 2.5 | 3.4 | 3.4 | 4.8 | 6.6 | 10.6 |
| Concrete 203 mm | 3.9 | 5.6 | 6.4 | 7.5 | 12.4 | 19.3 |
| Concrete 305 mm | 3.8 | 6.6 | 9.1 | 10.1 | 18.0 | 28.2 |
| Brick 92 mm | 2.6 | 3.2 | 2.2 | 2.2 | 3.3 | 3.3 |
| Gypsum 12.7 mm | 0.03 | 0.13 | 0.23 | 0.30 | 0.85 | 1.36 |
| Glass 6 mm | 0.01 | 0.11 | 0.25 | 0.35 | 1.38 | 2.84 |
| Wood door 44.5 mm | 0.06 | 0.30 | 0.52 | 0.63 | 0.65 | 1.39 |
| Gyp–89 mm air–gyp | 0.08 | 0.19 | 0.26 | 0.44 | 0.66 | 1.13 |

**Model versus measurement.** For poured concrete the P.2040 fit (and 3GPP's 5+4f) gives roughly a third of what NIST measured on 28-day lab specimens; 203 mm at 750 MHz is about 6–7 dB modelled versus 21.5 dB measured. Treat concrete as the dominant uncertainty. Calibrate against a field measurement through a known wall whenever possible, and keep both "model" and "measured-high" presets in the app.

### 2.6 Typical assemblies (summary; details in JSON `assemblies`)

| Assembly | Typical loss | Basis |
|---|---|---|
| Gypsum on studs | 0.1–0.7 dB at 150–1900 MHz | Model + NIST <1 dB |
| Rated 2×5/8″ each side | 0.2–3 dB | Model, resonant |
| CMU 8″ | 8–12 dB at 0.5–1 GHz | NIST |
| Poured concrete 8″ | 20–28 dB measured at 0.5–1 GHz; 6–8 dB modelled at 700–850 MHz | Large spread |
| Reinforced concrete 8″ | 22–30 dB at 0.5–1 GHz | NIST |
| Brick veneer on CMU | 8–11 dB | NIST |
| Brick veneer on concrete | 11–25 dB | NIST |
| Clear glass | <3 dB below 1 GHz | NIST |
| Low-E / IRR glass | ~23–27 dB (single coating, 0.5–0.9 GHz) up to 40–54 dB (multi-silver laminates); 3GPP 25.4+0.11f | Measured + 3GPP |
| Floors | 9 dB for one office floor at 900 MHz, about 20 dB at 5.2 GHz | ITU-R P.1238 |
| Elevator cars and metal | Opaque metal: about 1500 dB/mm at 800 MHz from eq 27b; signal arrives through gaps | No measured value found |
| Whole building | P.2109 median 14 dB (traditional) / 31–37 dB (thermally-efficient); NIST large buildings 25–70 dB mean | |

---

## Gaps and cautions

1. **Durham NC and Burbank CA AHJ documents** returned HTTP 403 (City of Durham DocumentCenter PDFs; Burbank ERRCS regulations PDF and web page). Their contents are not used. The Durham County Fire Marshal page was used instead.
2. **Elevator shaft and car loss:** no measured value was found in an openable source. A University of South Carolina 5 GHz elevator-shaft paper returned 403.
3. **Metal-deck floors specifically:** no metal-deck measurement was found. P.1238 floor factors are generic office and commercial values.
4. **iBwave IFC/Revit import** is not confirmed by any iBwave document opened. Ranplan IFC import is confirmed.
5. **Accela Citizen Access document-permission documentation** (Accela admin guide mirrors) could not be opened (expired certificates or DNS failure). The ACA behaviour cited comes from the Arapahoe County user guide only.
6. **NFPA pages** render without content for automated fetch. The NFPA 1660 consolidation is cited from GovTech.
7. **The Ofcom report** was read from a third-party mirror because the Ofcom URL returned 403.
8. **Below 1 GHz,** P.2040 concrete, brick and plasterboard parameters are extrapolated, and 3GPP O2I is undefined below 0.5 GHz. For 150 and 450 MHz, rely on measured data (NIST TN 1545) and P.2109 (valid from about 80 MHz).
9. **Cardinal %T to dB** conversion assumes %T is a field ratio, as the report's appendix defines it. If it were a power ratio, the dB values would halve.
10. **NIST 3–8 GHz brick curves** behave erratically (high-order fits with deep notches) and were not tabulated.
