"""
The bill of materials past a plain equipment list (11/5, from what a 30-year DAS man does by hand after iBwave):

  groups       the seven groups of an install BOM, a line's group set from what it is, changeable on the line
  review       each line's catalogue match, wrong-part warnings and whether its price has moved since it was quoted
  completeness what the list is missing, from a data table of rules (RULES), each with its reason and its source
  outputs      one BOM three ways: Customer (priced, cost hidden), Technician and AHJ (no prices)
  workbook     those outputs as a real .xlsx (xlsxout.py), plus an order sheet by supplier (cost shown, kept apart on purpose)
  import       an iBwave equipment list, columns found by name
  issue        a dated revision of the list, and what changed since

Sources: a rule cites a row of RF Recon's own research (static/research/rf_parts.json), its code section copied from
there and never typed here. A rule with no such row says so: "Rule of thumb". tests/test_dasbom.py checks every cited row exists.
"""
import csv
import html.parser
import io
import json
import math
import os
import re

import das
import xlsread
import xlsxout

GROUPS = (("donor", "Donor antennas and roof gear"), ("headend", "Head-end"), ("fiber", "Fiber"), ("remotes", "Remotes and distribution"),
          ("accessories", "Accessories"), ("tools", "Tools"), ("spares", "Spare connectors"))
GROUP_LABEL = dict(GROUPS)
GROUP_SHORT = {"donor": "Donor and roof", "headend": "Head-end", "fiber": "Fiber", "remotes": "Remotes", "accessories": "Accessories", "tools": "Tools", "spares": "Spares"}  # the line's drop-down
GROUP_ORDER = {k: i for i, (k, _) in enumerate(GROUPS)}

# what a line is, from its category, description and part number: first match wins
KINDS = (
    ("tool", r"\btools?\b|wrench|crimper|crimp tool|cable prep|strippers?\b|cleaver|inspection scope|fiber scope|cleaning kit|analy[sz]er"),
    ("fiber_term", r"fiber jumpers?|patch panel|fiber distribution|pigtails?|splice (tray|closure)|lc/upc jumper|sc/apc jumper"),
    ("fiber_cable", r"(single.?mode|multi.?mode|\bos2\b|\bom[345]\b)[^,;]*(fiber|fibre|cable)|fib(er|re) (optic )?cable|\bofn[rp]\b"),
    ("mount", r"antenna mount|roof sled|non.?penetrating|tripod|\bsled\b|\bmast\b"),
    ("donor_ant", r"donor antenna|\byagi\b|log.?periodic|\blpda\b"),
    ("surge", r"surge|lightning|arrest[eo]r|discharge unit|gas tube"),
    ("ground_kit", r"ground(ing)? kit|sureground|ground(ing)? (strap|wire|clamp)"),
    ("ground_bar", r"ground(ing)? bar|buss? bar"),
    ("weather", r"weather.?(proof|seal)|butyl|cold.?shrink"),
    ("battery", r"batter(y|ies)|\bbbu\b|charger"),
    ("annunciator", r"annunciator"),
    ("monitor", r"monitoring|monitor module|supervis|\bmodem\b|alarm.?interface"),
    ("enclosure", r"enclosure|cabinet"),
    ("power", r"power suppl|\bpsu\b|dedicated (branch )?circuit|branch circuit"),
    ("headend", r"head.?end|master unit|\bmaster\b|point of interface|\bpoi\b"),
    ("remote", r"remote unit|fiber remote|optical remote|\bremotes?\b"),
    ("booster", r"\bbda\b|booster|repeater|\bpsr\b|fiber das|optic(al)? unit"),
    ("pathway", r"pathway|circuit.?protective|survivab|\bul 2196\b|fire.?rated"),
    ("firestop", r"fire.?stop|penetration seal"),
    ("hanger", r"hangers?\b|\bclamps?\b|snap.?in|cable support|j.?hooks?\b"),
    ("label", r"\blabels?\b|\bsignage\b|\bsigns?\b|placard"),
    ("load", r"termination|terminator|\bloads?\b"),
    ("attenuator", r"attenuator"),
    ("passive", r"splitter|divider|coupler|tapper|hybrid|combiner|dc block"),
    ("connector", r"\bconnectors?\b|\b(n|4\.3-10|7/16|nex10)[- ](male|female)\b|\bez-400|\btc-400"),
    ("jumper", r"\bjumpers?\b"),
    ("server_ant", r"antenna|\bomni\b"),
    ("coax", r"\bcoax|heliax|radiating|\bcable\b|\bldf\d|\bava\d|\blcf\d|\blmr-?\d|\bhl\d|\bica\d|\bhca\d|\bscf\d|\bfsj\d|\brlku\d"),
)
KINDS = tuple((k, re.compile(p, re.I)) for k, p in KINDS)
KIND_GROUP = {"tool": "tools", "fiber_term": "fiber", "fiber_cable": "fiber", "mount": "donor", "donor_ant": "donor", "surge": "donor",
              "ground_kit": "donor", "ground_bar": "donor", "weather": "donor", "battery": "headend", "annunciator": "headend", "monitor": "headend",
              "enclosure": "headend", "headend": "headend", "booster": "headend", "power": "headend", "remote": "remotes", "server_ant": "remotes",
              "passive": "remotes", "load": "remotes", "attenuator": "remotes", "coax": "remotes"}  # anything else: accessories
FEET = {"ft": 1.0, "m": 3.281}


def _line_text(x):
    return f"{x.get('cat') or ''} {x.get('item') or ''} {x.get('part') or ''}"


def kind_of(x):
    t = _line_text(x)
    return next((k for k, rx in KINDS if rx.search(t)), "other")


def auto_group(x):
    """A line's group from what it is. A connector called a spare is a spare; coax noted as the donor run belongs on the roof."""
    t, k = _line_text(x), kind_of(x)
    if k in ("connector", "jumper") and re.search(r"\bspares?\b", f"{t} {x.get('note') or ''}", re.I):
        return "spares"
    if k == "coax" and re.search(r"\bdonor\b", f"{t} {x.get('note') or ''}", re.I):
        return "donor"
    return KIND_GROUP.get(k, "accessories")


def group_of(x):
    g = x.get("group")
    return g if g in GROUP_LABEL else auto_group(x)


def _num(v):
    return das._price(v)


def _qty(x):
    return _num(x.get("qty")) or 0


# ---------------------------------------------------------------- settings
DEFAULTS = {"price_mode": "markup", "price_pct": None, "labor_rate": None, "tax_pct": None, "spare_pct": 10, "skip": {}, "packet_no_prices": True}  # the zip goes to the AHJ, and what an AHJ holds can become a public record: prices stay out unless someone unticks it
SKIP_REASONS = ("Not required on this job", "Supplied by others", "Included in another line", "The AHJ waived it")
PRICE_OLD_DAYS = 90  # a rule of thumb: a price older than this is worth asking about again


def settings(d):
    s = dict(DEFAULTS, **{k: v for k, v in ((d or {}).get("bom_settings") or {}).items() if v is not None})
    s["skip"] = s.get("skip") if isinstance(s.get("skip"), dict) else {}
    return s


def sell_price(cost, s):
    """The customer's unit price from the cost: markup (cost + %) or margin (% of the selling price)."""
    pct = _num(s.get("price_pct")) or 0
    if s.get("price_mode") == "margin":
        return round(cost / (1 - pct / 100), 2) if pct < 100 else round(cost, 2)
    return round(cost * (1 + pct / 100), 2)


def api_priced(x):
    """A price that came from a distributor's API. Their terms don't let it pass to a third party, so it stays off the
    Customer output until a supplier's quote or a price list replaces it."""
    return x.get("price_by") == "online" or str(x.get("supplier") or "").endswith("(online)")


# ---------------------------------------------------------------- the job's bands
CELL_BANDS = {  # uplink, downlink MHz: static/dascell.js DAS_LTE_BANDS (tests/test_dasbom.py keeps the two the same)
    "71": ((663, 698), (617, 652)), "12": ((699, 716), (729, 746)), "17": ((704, 716), (734, 746)), "29": (None, (717, 728)),
    "13": ((777, 787), (746, 756)), "14": ((788, 798), (758, 768)), "5": ((824, 849), (869, 894)), "26": ((814, 849), (859, 894)),
    "2": ((1850, 1910), (1930, 1990)), "25": ((1850, 1915), (1930, 1995)), "66": ((1710, 1780), (2110, 2200)), "70": ((1695, 1710), (1995, 2020)),
    "30": ((2305, 2315), (2350, 2360)), "41": ((2496, 2690), (2496, 2690)), "48": ((3550, 3700), (3550, 3700)),
    "n77a": ((3450, 3550), (3450, 3550)), "n77c": ((3700, 3980), (3700, 3980))}


def job_bands(d):
    """[{band, freqs: every MHz the job carries in it (or its band's edges), lo, hi, cell}], as dasdesign.js dsBands reads a job."""
    out = {}
    for p in ((d.get("presurvey") or {}).get("plan") or []):
        dl = _num(p.get("downlink_mhz"))
        if dl is None:
            continue
        b = out.setdefault(p.get("band") or das.band_of(dl), {"freqs": set(), "cell": False})
        b["freqs"].add(dl)
        b["freqs"].update(float(u) for u in str(p.get("uplink_mhz") or "").split() if das._NUM.match(u))
    for bid in ((d.get("design") or {}).get("cell_bands") or []):
        ul, dl = CELL_BANDS.get(str(bid), (None, None))
        if dl:
            out[f"Cellular band {bid}"] = {"freqs": {float(f) for r in (ul, dl) if r for f in r}, "cell": True}
    return [{"band": k, "freqs": sorted(v["freqs"]), "lo": min(v["freqs"]), "hi": max(v["freqs"]), "cell": v["cell"]} for k, v in out.items()]


def public_safety(d):
    """das.js dasScope: a job is public safety work unless it's only cellular."""
    C = d.get("cellular") or {}
    cell = any(isinstance(C.get(k), dict) and C[k] for k in ("profile", "donor", "approvals"))
    ps = d.get("presurvey") or {}
    sign = bool(ps.get("plan") or ps.get("include") or (d.get("life") or {}).get("auths") or d.get("consents"))
    return sign or not cell


# ---------------------------------------------------------------- research: what a rule cites
_RESEARCH = {}


def research():
    if not _RESEARCH:
        try:
            with open(das.RESEARCH_PARTS, encoding="utf-8") as fh:
                _RESEARCH.update(json.load(fh))
        except (OSError, ValueError):
            pass
    return _RESEARCH


def _src_url(keys):
    urls = {s.get("key"): s.get("url") for s in research().get("sources") or []}
    return next((urls[k] for k in keys or [] if urls.get(k)), "")


def cite(ref):
    """A rule's source as the screen shows it. ("das", topic): a row of the research's code rules; ("step", checklist, step): a
    research checklist; ("design",): this job's own design; None: a rule of thumb."""
    if not ref:
        return {"kind": "thumb", "label": "Rule of thumb", "url": "", "text": ""}
    if ref[0] == "design":
        return {"kind": "design", "label": "This job's design", "url": "", "text": ""}
    if ref[0] == "das":
        row = next((x for x in research().get("das") or [] if x.get("topic") == ref[1]), {})
        return {"kind": "code", "label": row.get("code") or ref[1], "url": _src_url(row.get("sources")), "text": row.get("requirement") or ""}
    lst = next((x for x in research().get("checklists") or [] if x.get("name") == ref[1]), {})
    row = next((x for x in lst.get("items") or [] if x.get("step") == ref[2]), {})
    return {"kind": "research", "label": f"RF parts research: {ref[1]}, {ref[2]}", "url": _src_url(row.get("sources")), "text": row.get("detail") or ""}


# ---------------------------------------------------------------- the completeness rules
# A data table: one row per thing an install needs. has: the kinds of line that satisfy it (or text: a pattern on the line);
# when: when it applies (WHEN); qty: how many (QTY); count: compare quantities, not just "there's a line"; cite: its source
# (see cite()). why: one plain sentence for someone with no RF background.
RULES = (
    {"id": "donor_antenna", "title": "Donor antenna", "has": ("donor_ant",), "when": "always", "qty": "donors", "count": True, "group": "donor", "cat": "Donor antenna",
     "item": "Donor antenna", "unit": "ea", "cite": None,
     "why": "It's the antenna on the roof that talks to the radio site. One for each donor path in the design."},
    {"id": "donor_mount", "title": "Donor antenna mount", "has": ("mount",), "when": "always", "qty": "donors", "count": True, "group": "donor", "cat": "Donor antenna mount",
     "item": "Donor antenna mount", "unit": "ea", "cite": ("das", "Donor antenna mounting and isolation"),
     "why": "The donor antenna has to be fixed in place, or on a signed sled, so its aim can't drift."},
    {"id": "surge", "title": "Surge protector on each donor line", "has": ("surge",), "when": "always", "qty": "donors", "count": True, "group": "donor", "cat": "Surge protector",
     "item": "Surge protector, donor line", "unit": "ea", "cite": ("das", "Lightning / surge protection on the donor line"),
     "why": "Lightning on the roof comes down the coax. Each donor line needs its own discharge unit, grounded."},
    {"id": "ground_kit", "title": "Grounding kit at the donor entry", "has": ("ground_kit",), "when": "always", "qty": "donors", "count": True, "group": "donor", "cat": "Grounding kit",
     "item": "Grounding kit, donor coax", "unit": "ea", "cite": ("das", "Grounding the coax shield at entry"),
     "why": "The coax shield is bonded to the building's ground where it comes inside. The kit is sized to the cable."},
    {"id": "ground_bar", "title": "Ground bar", "has": ("ground_bar",), "text": r"ground(ing)? bar", "when": "always", "qty": "one", "group": "donor", "cat": "Ground bar",
     "item": "Ground bar", "unit": "ea", "cite": ("step", "BOM review before ordering", "Grounding"),
     "why": "The grounding kits land on a ground bar."},
    {"id": "weatherproof", "title": "Weatherproofing for roof connections", "has": ("weather",), "when": "always", "qty": "roof_joints", "count": True, "group": "donor", "cat": "Weatherproofing kit",
     "item": "Weatherproofing kit, roof connection", "unit": "ea", "cite": ("step", "Pick connectors", "Weatherproofing for outdoor joints"),
     "why": "Water in an outdoor connector ruins the line. Each roof joint gets a kit."},
    {"id": "server_antennas", "title": "Server antennas from the design", "has": ("server_ant",), "when": "placed_antennas", "qty": "placed_antennas", "count": True, "group": "remotes", "cat": "Server antenna",
     "item": "Server antenna", "unit": "ea", "cite": ("design",),
     "why": "The design places these on the floor plans, and the list has to match."},
    {"id": "connectors", "title": "Connectors for each end of each cable run", "has": ("connector",), "when": "coax", "qty": "connectors", "count": True, "group": "accessories", "cat": "Connector",
     "item": "Coax connector, matched to the cable", "unit": "ea", "cite": ("step", "BOM review before ordering", "Connector count"),
     "why": "Two connectors for every run of cable. An equipment list usually leaves them out."},
    {"id": "jumpers", "title": "Jumpers at the equipment", "has": ("jumper",), "when": "active", "qty": "jumpers", "count": True, "group": "accessories", "cat": "Jumper",
     "item": "Coax jumper, equipment to line", "unit": "ea", "cite": None,
     "why": "Stiff cable doesn't go straight into a unit's port: a short flexible jumper does. Two for each active unit."},
    {"id": "hangers", "title": "Cable hangers", "has": ("hanger",), "when": "coax_ft", "qty": "hangers", "count": True, "group": "accessories", "cat": "Hanger",
     "item": "Cable hanger", "unit": "ea", "cite": ("step", "Pick a feeder cable", "Add support hardware"),
     "why": "The cable's sheet sets the spacing. The count here is one every 3 ft: check it against your cable's sheet."},
    {"id": "loads", "title": "Load on each unused port", "has": ("load",), "when": "hybrid", "qty": "hybrids", "count": True, "group": "remotes", "cat": "Termination / load",
     "item": "Termination / load, rated", "unit": "ea", "cite": ("step", "BOM review before ordering", "Loads and attenuators"),
     "why": "An unused port on a hybrid or combiner is terminated with a rated load."},
    {"id": "battery", "title": "Battery backup", "has": ("battery",), "when": "public_safety", "qty": "one", "group": "headend", "cat": "Battery backup",
     "item": "BDA / DAS battery backup unit (secondary power)", "unit": "ea", "cite": ("das", "Secondary (standby) power"),
     "why": "The system keeps running when the building loses power. Design, Battery sizes it."},
    {"id": "power_feed", "title": "Dedicated power circuit", "has": ("power",), "when": "public_safety", "qty": "one", "group": "headend", "cat": "Power",
     "item": "Dedicated branch circuit to the BDA", "unit": "ea", "cite": ("das", "Secondary (standby) power"),
     "why": "Primary power is a dedicated branch circuit. It's often the electrician's: if so, mark it Supplied by others."},
    {"id": "annunciator", "title": "Annunciator", "has": ("annunciator",), "when": "public_safety", "qty": "one", "group": "headend", "cat": "Annunciator",
     "item": "ERCES annunciator / system monitoring panel", "unit": "ea", "cite": ("das", "Dedicated annunciator"),
     "why": "A panel in the fire command center that shows the system's state."},
    {"id": "supervision", "title": "Monitoring by the fire alarm panel", "has": ("monitor",), "when": "public_safety", "qty": "one", "group": "headend", "cat": "Fire alarm monitoring",
     "item": "Fire alarm monitor modules for the supervisory signals", "unit": "ea", "cite": ("das", "Supervisory signals to the fire alarm system"),
     "why": "The fire alarm panel has to watch the system's trouble signals."},
    {"id": "monitoring", "title": "Remote monitoring", "has": ("monitor",), "when": "cellular", "qty": "one", "group": "headend", "cat": "Monitoring",
     "item": "Remote monitoring modem", "unit": "ea", "cite": None,
     "why": "A cellular system with no public safety code behind it still has to tell someone when it fails."},
    {"id": "enclosure", "title": "NEMA 4 or 4X enclosure for the active gear", "has": ("enclosure",), "when": "public_safety_active", "qty": "one", "group": "headend", "cat": "Enclosure",
     "item": "NEMA 4X enclosure", "unit": "ea", "ok_if": "booster_nema", "cite": ("das", "Enclosures for BDAs and batteries"),
     "why": "Met once a booster's NEMA rating is recorded, because most boosters come in their own NEMA 4 housing."},
    {"id": "backbone", "title": "2-hour pathway for the backbone", "has": ("pathway",), "when": "not_sprinklered", "qty": "one", "group": "accessories", "cat": "Fire-rated pathway",
     "item": "2-hour fire-rated pathway for backbone cable", "unit": "ea", "cite": ("das", "Backbone survivability (fire resistance)"),
     "why": "Design, Submittal says this building isn't fully sprinklered, so the backbone needs a rated cable or a rated enclosure."},
    {"id": "firestop", "title": "Firestop at floor penetrations", "has": ("firestop",), "when": "riser", "qty": "one", "group": "accessories", "cat": "Firestop",
     "item": "Firestop for cable penetrations", "unit": "ea", "cite": ("step", "ERCES material compliance check", "Backbone fire rating"),
     "why": "Cable going through a rated floor needs the hole sealed."},
    {"id": "labels", "title": "Labels and signs", "has": ("label",), "when": "public_safety", "qty": "one", "group": "accessories", "cat": "Labels",
     "item": "Labels and signs for the system", "unit": "ea", "cite": ("das", "Labelling and signage"),
     "why": "The annunciator's labels, the sled sign and the booster labels."},
    {"id": "fiber_cable", "title": "Fiber to the remotes", "has": ("fiber_cable",), "when": "remotes", "qty": "one", "group": "fiber", "cat": "Fiber cable",
     "item": "Singlemode fiber cable, riser or plenum to suit", "unit": "ft", "cite": ("step", "BOM review before ordering", "Fiber items"),
     "why": "Remote units need fiber back to the head-end."},
    {"id": "fiber_term", "title": "Fiber jumpers and patch panels", "has": ("fiber_term",), "when": "remotes", "qty": "one", "group": "fiber", "cat": "Fiber accessories",
     "item": "Fiber jumpers and patch panel, polish per the DAS vendor", "unit": "ea", "cite": ("step", "BOM review before ordering", "Fiber items"),
     "why": "The polish, SC/APC or LC/UPC, has to match the DAS vendor's rule."},
    {"id": "spares", "title": "Spare connectors", "group_has": "spares", "when": "spare_pct", "qty": "spares", "count": True, "group": "spares", "cat": "Connector",
     "item": "Spare connectors", "unit": "ea", "cite": None,
     "why": "A crew that ruins a connector shouldn't stop for the day. The allowance is the percentage set above."},
    {"id": "tool_torque", "title": "Torque wrench for the connectors", "text": r"torque|wrench", "when": "coax", "qty": "one", "group": "tools", "cat": "Tool",
     "item": "Torque wrench for the connector type", "unit": "ea", "cite": ("step", "Pick connectors", "List the torque tools"),
     "why": "Each connector type has its own torque. Under or over, and it causes PIM."},
    {"id": "tool_prep", "title": "Cable prep tools", "text": r"cable prep|stripper", "when": "coax", "qty": "one", "group": "tools", "cat": "Tool",
     "item": "Cable prep tool for each cable size", "unit": "ea", "cite": None,
     "why": "Each cable size has its own prep tool."},
    {"id": "tool_sweep", "title": "Cable analyzer", "text": r"analy[sz]er", "when": "coax", "qty": "one", "group": "tools", "cat": "Tool",
     "item": "Cable and antenna analyzer", "unit": "ea", "cite": None,
     "why": "Each line gets swept before the system is turned on."},
    {"id": "tool_fiber", "title": "Fiber scope and cleaning kit", "text": r"fiber scope|inspection scope|cleaning kit", "when": "remotes", "qty": "one", "group": "tools", "cat": "Tool",
     "item": "Fiber inspection scope and cleaning kit", "unit": "ea", "cite": None,
     "why": "A dirty fiber end is the commonest fiber fault."},
)

WHEN = {"always": lambda c: True, "public_safety": lambda c: c["public_safety"], "cellular": lambda c: not c["public_safety"],
        "public_safety_active": lambda c: c["public_safety"] and c["active"] > 0, "placed_antennas": lambda c: c["placed"] > 0,
        "coax": lambda c: c["coax"], "coax_ft": lambda c: c["coax_ft"] > 0, "active": lambda c: c["active"] > 0, "hybrid": lambda c: c["hybrids"] > 0,
        "remotes": lambda c: c["remotes"] > 0, "riser": lambda c: c["floors"] > 1 and c["coax"], "spare_pct": lambda c: c["spare_pct"] > 0 and c["connector_need"] > 0,
        "not_sprinklered": lambda c: c["sprinkler"] not in ("", "NFPA 13")}
QTY = {"one": lambda c: 1, "donors": lambda c: c["donors"], "roof_joints": lambda c: 2 * c["donors"], "placed_antennas": lambda c: c["placed"],
       "connectors": lambda c: c["connector_need"], "jumpers": lambda c: 2 * max(c["active"], 1), "hangers": lambda c: math.ceil(c["coax_ft"] / 3),
       "hybrids": lambda c: c["hybrids"], "spares": lambda c: math.ceil(c["connector_need"] * c["spare_pct"] / 100)}


def context(d, lines):
    """What the rules read: counts from the job's design, then from the list."""
    des, s = d.get("design") or {}, settings(d)
    q = lambda *ks: sum(_qty(x) for x in lines if kind_of(x) in ks and group_of(x) != "spares")  # noqa: E731
    dbands = des.get("bands") or {}
    bands = job_bands(d)
    placed = sum(len((f or {}).get("antennas") or []) for f in (des.get("floors") or {}).values() if isinstance(f, dict))
    paths = sum(1 for b in dbands.values() if isinstance(b, dict) and b.get("donor_cable"))
    donors = max(paths or len(bands), 1)
    antennas = placed or q("server_ant")
    passives = q("passive")
    design_cables = {}
    for b in dbands.values():
        if not isinstance(b, dict):
            continue
        runs = [e for e in [b.get("donor_cable")] + list(b.get("passive") or []) if isinstance(e, dict) and e.get("cable")]
        here = {}
        for e in runs:
            here[e["cable"]] = here.get(e["cable"], 0) + (_num(e.get("ft")) or 0)
        for k, v in here.items():
            design_cables[k] = max(design_cables.get(k, 0), v)  # bands share cable: the longest band's total, and it's the farthest path only
    coax_lines = [x for x in lines if kind_of(x) == "coax"]
    coax_ft = sum(_qty(x) * FEET[x.get("unit")] for x in coax_lines if x.get("unit") in FEET)
    coax = bool(coax_lines or design_cables or antennas)
    runs = donors + antennas + passives
    floors = len(d.get("floors")) if isinstance(d.get("floors"), list) else 0
    return {"public_safety": public_safety(d), "bands": bands, "placed": placed, "donors": donors, "antennas": antennas, "passives": passives, "runs": runs,
            "connector_need": 2 * runs if coax else 0, "active": q("booster", "headend", "remote"), "remotes": q("remote"), "hybrids": sum(
                _qty(x) for x in lines if re.search(r"hybrid|combiner", _line_text(x), re.I)), "coax": coax, "coax_ft": coax_ft, "floors": floors,
            "design_cables": design_cables, "spare_pct": _num(s.get("spare_pct")) or 0, "sprinkler": str((des.get("sub") or {}).get("sprinkler") or "")}


def _satisfies(rule, x):
    if rule.get("group_has"):
        return group_of(x) == rule["group_has"]
    if group_of(x) == "spares":
        return False
    return kind_of(x) in rule.get("has", ()) or bool(rule.get("text") and re.search(rule["text"], _line_text(x), re.I))


def _row(rule, status, need, have, s, cited=None, title=None, add=None):
    short = max(math.ceil(need - have), 0) if status == "missing" else 0
    return {"id": rule["id"], "title": title or rule["title"], "status": status, "need": need, "have": have, "short": short, "unit": rule["unit"], "group": rule["group"],
            "group_label": GROUP_LABEL[rule["group"]], "why": rule["why"], "source": cited or cite(rule.get("cite")), "skip": (s["skip"].get(rule["id"]) or None),
            "add": add or {"cat": rule["cat"], "item": rule["item"], "qty": "" if rule["unit"] == "ft" and not rule.get("count") else short or 1, "unit": rule["unit"],
                           "group": rule["group"], "note": "", "rule": rule["id"]}}


def completeness(d, lines=None):
    """Every rule against the job and its list: {rows: [{id, title, status ("ok", "missing", "skipped", "na"), need, have, short, why,
    source, add}], open, met, skipped, na}. add is the line that one click puts on the list."""
    lines = (d.get("bom") or []) if lines is None else lines
    s, c = settings(d), context(d, lines)
    rows = []
    for rule in RULES:
        if not WHEN[rule["when"]](c):
            rows.append(_row(rule, "na", 0, 0, s))
            continue
        need = QTY[rule["qty"]](c)
        hits = [x for x in lines if _satisfies(rule, x)]
        have = sum(_qty(x) for x in hits) if rule.get("count") else len(hits)
        ok = have >= need if rule.get("count") else bool(hits)
        if rule.get("ok_if") == "booster_nema":
            ok = ok or any(((x.get("codes") or {}).get("nema") or {}).get("v") for x in lines if kind_of(x) in ("booster", "headend"))
        rows.append(_row(rule, "ok" if ok else "skipped" if rule["id"] in s["skip"] else "missing", need, have, s))
    # each cable the link budget names has to be on the list, at least as long as its longest path
    cables = [x for x in lines if kind_of(x) in ("coax", "pathway")]
    for name, ft in sorted(c["design_cables"].items()):
        base = name.split(" (")[0].lower()
        hits = [x for x in cables if base in _line_text(x).lower()]
        have = sum(_qty(x) * FEET.get(x.get("unit"), 1) for x in hits)
        rid = "design_cable:" + das._pn(name)
        rule = {"id": rid, "group": "remotes", "unit": "ft", "why": f"The link budget counts {name} on its longest path. The list needs at least that much, and more for the other runs.",
                "cite": ("design",), "cat": "Cable", "item": name, "title": ""}
        status = "ok" if have >= ft else "skipped" if rid in s["skip"] else "missing"
        rows.append(_row(rule, status, ft, have, s, title=f"{name} from the link budget",
                         add={"cat": "Cable", "item": name, "part": name.split(" (")[0], "qty": max(math.ceil(ft - have), 1), "unit": "ft", "group": "remotes", "note": "", "rule": rid}))
    return {"rows": rows, "open": sum(1 for r in rows if r["status"] == "missing"), "met": sum(1 for r in rows if r["status"] == "ok"),
            "skipped": sum(1 for r in rows if r["status"] == "skipped"), "na": sum(1 for r in rows if r["status"] == "na"), "context": {
                k: c[k] for k in ("donors", "antennas", "passives", "runs", "connector_need", "coax_ft", "spare_pct", "public_safety")}, "skip_reasons": list(SKIP_REASONS)}


# ---------------------------------------------------------------- the wrong-part guard
_CHAIN = re.compile(r"((?:\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*(?:/|,|&|and)?\s*)+)(MHz|GHz)", re.I)
_PAIR = re.compile(r"(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)", re.I)
CONNECTOR_RESEARCH = {"7/16 DIN": "7/16 DIN (7-16)", "F-type": "F"}  # our word -> the research's row
BAND_WORDS = ((r"\bvhf\b", 136, 174), (r"\buhf\b", 380, 512), (r"\b700\s*/\s*800\b", 698, 869), (r"\b700(\s*mhz)\b", 698, 806),
              (r"\b800(\s*mhz)\b", 806, 869), (r"\bband\s*14\b|\bfirstnet\b", 758, 798))
CONNECTOR_WORDS = (("4.3-10", r"4\.3[-/ ]?10"), ("NEX10", r"nex\s?10"), ("7/16 DIN", r"7[-/]16"), ("QMA", r"\bqma\b"), ("SMA", r"\bsma\b"), ("TNC", r"\btnc\b"),
                   ("BNC", r"\bbnc\b"), ("F-type", r"\bf[- ]type\b|\btype[- ]f\b|\bf connector\b"), ("N-type", r"\bn[- ]?(type|male|female)\b|\btype[- ]n\b"))
# a connector made for one cable (the research's "Match the connector to the exact cable")
CONNECTOR_CABLE = ((r"\bez-400\b", "LMR-400"), (r"\btc-400\b.*-pl\b", "LMR-400-LLPL"))
ALL_BANDS = ("server_ant", "passive", "coax", "load", "attenuator", "surge")  # in the path of every band; a donor or a booster may carry just one


def freq_ranges(x, codes=None, grant=None):
    """The MHz a line covers, as [(lo, hi)] and where that came from: the FCC grant, the part's Frequency field, then its words."""
    codes = codes or {}
    if grant and grant.get("bands"):
        return [(float(a), float(b)) for a, b in grant["bands"]], "its FCC grant"
    for text, src in ((((codes.get("freq") or {}).get("v") or ""), "its Frequency field"), (f"{x.get('item') or ''} {x.get('cat') or ''}", "its description")):
        out = []
        for chain, unit in _CHAIN.findall(text):
            k = 1000.0 if unit.lower() == "ghz" else 1.0
            out += [(float(a) * k, float(b) * k) for a, b in _PAIR.findall(chain)]
        out = [r for r in out if 1 <= r[0] < r[1] <= 100000]
        if not out:
            out = [(float(lo), float(hi)) for rx, lo, hi in BAND_WORDS if re.search(rx, text, re.I)]
            out = [r for r in out if not any(o != r and o[0] <= r[0] and r[1] <= o[1] for o in out)]  # "700/800 MHz" isn't also "800 MHz"
        if out:
            return out, src
    return [], ""


def _covers(ranges, f):
    return any(lo - 1 <= f <= hi + 1 for lo, hi in ranges)


def _show(ranges):
    r = sorted(set(ranges))
    return ", ".join(f"{a:g} to {b:g}" for a, b in r[:5]) + (f" and {len(r) - 5} more" if len(r) > 5 else "") + " MHz"


def connector_of(x, codes=None):
    t = f"{((codes or {}).get('connector') or {}).get('v') or ''} {x.get('item') or ''} {x.get('part') or ''}"
    return next((n for n, rx in CONNECTOR_WORDS if re.search(rx, t, re.I)), "")


def watts_of(x, codes=None):
    v = ((codes or {}).get("power") or {}).get("v") or ""
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:W\b|watt)", v or f"{x.get('item') or ''}", re.I)
    return float(m.group(1)) if m else None


def research_cable(x):
    t = _line_text(x).lower()
    return next((c for c in research().get("cables") or [] if c.get("name", "").split(" (")[0].lower() in t), None)


def _sentence(t):
    """The first sentence of a research note, whole."""
    return re.split(r"(?<=[.;])\s", str(t or "").strip())[0].rstrip(";.")


def _warn(field, text, source=None):
    return {"field": field, "text": text, "source": source}


COVERED_MAKERS = re.compile(r"\b(sinclair|norsat)\b", re.I)  # Hytera subsidiaries (FCC Covered List; FINDINGS 15)
COVERED_SOURCE = {"kind": "code", "label": "FCC Covered List; DA 26-635 (June 2026)", "url": "https://docs.fcc.gov/public/attachments/DA-26-635A1.pdf",
                  "text": "Hytera equipment for public-safety and security uses is on the Covered List (since 12 Mar 2021). DA 26-635 bars importing "
                          "or marketing previously authorized Hytera equipment for those uses; equipment already bought may stay in use."}


def line_warnings(d, x, c, bom_names):
    """What's wrong with one line for this job: [{field, text, source}]. Warnings only: nothing here stops a save."""
    out, codes, part = [], x.get("codes") or {}, x.get("catalogue") or {}
    hy = COVERED_MAKERS.search(f"{_line_text(x)} {x.get('maker') or ''} {part.get('maker') or ''}")
    if hy:
        out.append(_warn("maker", f"{hy.group(1).title()} belongs to Hytera (through Norsat), whose public-safety equipment is on the FCC Covered List; "
                                  "DA 26-635 (June 2026) bars importing or marketing previously authorized Hytera gear for those uses. Whether a passive "
                                  "part is caught isn't settled: tell the owner before it's specified.", COVERED_SOURCE))
    k, grant = kind_of(x), part.get("grant")
    bands = c["bands"]
    ranges, how = freq_ranges(x, codes, grant)
    if ranges and bands and k not in ("tool", "other", "connector", "label", "hanger", "firestop", "battery", "annunciator", "monitor", "enclosure", "mount"):
        miss = [b for b in bands if not all(_covers(ranges, f) for f in b["freqs"])]
        names = ", ".join(f"{b['band']} ({b['lo']:g} to {b['hi']:g} MHz)" if b["lo"] != b["hi"] else f"{b['band']} ({b['lo']:g} MHz)" for b in miss[:3])
        if k in ALL_BANDS and miss:
            out.append(_warn("freq", f"Covers {_show(ranges)}, from {how}. This job also carries {names}.", cite(("das", "Frequencies and upgradeability"))))
        elif miss and len(miss) == len(bands):
            out.append(_warn("freq", f"Covers {_show(ranges)}, from {how}. None of this job's bands is in it: {names}.", cite(("das", "Frequencies and upgradeability"))))
    conn = connector_of(x, codes)
    if k in ("connector", "jumper") or conn in ("F-type",):
        if conn == "F-type" or re.search(r"75.?(ohm|Ω)", _line_text(x), re.I):
            out.append(_warn("connector", "A 75 ohm part. It doesn't belong in a 50 ohm DAS path.", cite(("step", "Pick connectors", "Keep 75-ohm parts out"))))
        row = next((r for r in research().get("connectors") or [] if r.get("name") == CONNECTOR_RESEARCH.get(conn, conn)), None)
        top = max((b["hi"] for b in bands), default=0)
        if row and row.get("max_freq_ghz") and top > row["max_freq_ghz"] * 1000:
            out.append(_warn("connector", f"{row['name']} is rated to {row['max_freq_ghz']} GHz. This job reaches {top:g} MHz.", cite(("step", "Pick connectors", "Check frequency ceiling"))))
        for rx, cable in CONNECTOR_CABLE:
            if re.search(rx, _line_text(x), re.I) and not any(cable.lower() in n for n in bom_names):
                out.append(_warn("connector", f"This connector is made for {cable}, and {cable} isn't on this list.", cite(("step", "Pick connectors", "Match the connector to the exact cable"))))
    if k == "coax":
        if c["design_cables"]:
            names = [n.split(" (")[0].lower() for n in c["design_cables"]]
            if not any(n in _line_text(x).lower() for n in names):
                out.append(_warn("design", f"The link budget uses {', '.join(sorted(c['design_cables']))}, not this cable. Change one so they match.", cite(("design",))))
        rc = research_cable(x)
        if rc:
            if "obsolete" in rc.get("name", "").lower():
                out.append(_warn("rating", f"The research lists {rc['name'].split(' (')[0]} as obsolete. Check for its current replacement.", cite(("step", "BOM review before ordering", "Current part numbers"))))
            space = f"{x.get('loc') or ''} {x.get('note') or ''}".lower()
            rating = (rc.get("rating") or "").lower()
            if "plenum" in space and "plenum" not in rating and "cmp" not in rating:
                out.append(_warn("rating", f"Going through a plenum, but {rc['name'].split(' (')[0]} has no plenum listing: {_sentence(rc.get('rating'))}.", cite(("step", "Pick a feeder cable", "Name the space the run passes through"))))
            elif "riser" in space and not re.search(r"riser|plenum|cmr|cmp", rating):
                out.append(_warn("rating", f"Going up a riser, but {rc['name'].split(' (')[0]} has no riser listing: {_sentence(rc.get('rating'))}.", cite(("step", "Pick a feeder cable", "Name the space the run passes through"))))
            if re.search(r"^rlku", rc.get("name", ""), re.I) and any(b["hi"] >= 650 and b["lo"] <= 750 for b in bands):
                out.append(_warn("freq", "Radiating cable with a stop band at 650 to 750 MHz. This job has a band in it.", cite(("das", "Radiating cable stop bands"))))
    if re.search(r"\b(obsolete|discontinued|end of life)\b", _line_text(x), re.I):
        out.append(_warn("rating", "Marked obsolete or discontinued. Check for its current replacement.", cite(("step", "BOM review before ordering", "Current part numbers"))))
    cls = ((codes.get("booster_class") or {}).get("v") or "").strip().upper()
    want = str(d.get("booster_class") or "").strip().upper()[:1]
    if cls and want in ("A", "B") and want not in cls:
        out.append(_warn("rating", f"A Class {cls} booster on a job set to Class {want}.", cite(("das", "FCC Part 90 signal booster class, consent and registration"))))
    w = watts_of(x, codes)
    if w is not None and k in ALL_BANDS and k != "coax":
        top = max([_num((b or {}).get("bda_max_dbm")) or -99 for b in ((d.get("design") or {}).get("bands") or {}).values() if isinstance(b, dict)] or [-99])
        if top > -99 and w < 10 ** ((top - 30) / 10):
            out.append(_warn("rating", f"Rated {w:g} W. The booster's output in the link budget is {top:g} dBm, {10 ** ((top - 30) / 10):.1f} W.", cite(("das", "Component power ratings"))))
    pat = part.get("pattern") or {}
    gain = pat.get("gain_dbi")
    if gain is not None and k in ("server_ant", "donor_ant"):
        key = "server_gain_dbi" if k == "server_ant" else "donor_gain_dbi"
        want_g = [_num(b.get(key)) for b in ((d.get("design") or {}).get("bands") or {}).values() if isinstance(b, dict) and _num(b.get(key)) is not None]
        if want_g and all(abs(gain - g) > 1.5 for g in want_g):
            out.append(_warn("design", f"Its pattern file says {gain:g} dBi. The link budget uses {', '.join(f'{g:g}' for g in sorted(set(want_g)))} dBi.", cite(("design",))))
    unit = (part.get("unit") or "").strip().lower()
    if unit and x.get("unit") and unit != str(x.get("unit")).strip().lower():
        out.append(_warn("unit", f"Sold by the {unit} in the catalogue, listed here by the {x.get('unit')}.", None))
    return out


def job_warnings(d, lines, c):
    """What's wrong with the list as a whole: a band no booster or donor antenna covers."""
    out = []
    for kinds, what in ((("booster", "headend", "remote"), "booster"), (("donor_ant",), "donor antenna")):
        have = [x for x in lines if kind_of(x) in kinds]
        known = [freq_ranges(x, x.get("codes"), (x.get("catalogue") or {}).get("grant"))[0] for x in have]
        known = [r for r in known if r]
        if not known or len(known) < len(have):  # one line we can't read might be the one that covers it
            continue
        for b in c["bands"]:
            if not any(all(_covers(r, f) for f in b["freqs"]) for r in known):
                out.append(_warn("freq", f"No {what} on the list covers {b['band']} ({b['lo']:g} to {b['hi']:g} MHz).", cite(("das", "Frequencies and upgradeability"))))
    return out


# ---------------------------------------------------------------- the list as the Materials tab shows it
def _moved(con, x, part):
    """The catalogue's price against the line's: None when they agree or there's nothing to compare."""
    if not part or part.get("price") is None:
        return None
    now_p, was = float(part["price"]), _num(x.get("price"))
    if was is None:
        return {"now": now_p, "was": None, "diff": None, "pct": None, "supplier": part.get("supplier") or "", "at": "", "unpriced": True}
    if abs(now_p - was) < 0.005:
        return None
    rows = das._price_rows(con, part.get("supplier") or "", das._part_key(part.get("part"), part.get("item")))
    return {"now": now_p, "was": was, "diff": round(now_p - was, 2), "pct": round((now_p - was) / was * 100, 1) if was else None,
            "supplier": part.get("supplier") or "", "at": (rows[0]["at"] or "")[:10] if rows else "", "unpriced": False}


def _age(day):
    d = das._list_date(day)
    if not d:
        return None
    return (das.datetime.now() - das.datetime.strptime(d, "%Y-%m-%d")).days


def _ordered(bom):
    """(no, index, line) in the BOM's order: by group, then as entered. The no is the line's item number on every output."""
    ix = sorted(range(len(bom)), key=lambda i: (GROUP_ORDER[group_of(bom[i])], i))
    return [(n, i, bom[i]) for n, i in enumerate(ix, 1)]


def review(con, job):
    """The Materials tab's list: each line's group, item number, match, warnings and price movement, the groups' subtotals, the
    completeness check, the three outputs and what changed since the last revision."""
    d = job.get("data") or {}
    lines = (das.with_part_codes(con, job).get("data") or {}).get("bom") or []
    s, c = settings(d), context(d, lines)
    names = [_line_text(x).lower() for x in lines if kind_of(x) == "coax"]
    out, groups = [], {k: {"key": k, "label": lab, "lines": 0, "total": 0.0, "unpriced": 0} for k, lab in GROUPS}
    for no, i, x in _ordered(lines):
        part, g = x.get("catalogue"), group_of(x)
        q, p = _num(x.get("qty")), _num(x.get("price"))
        total = round(q * p, 2) if q is not None and p is not None else None
        groups[g]["lines"] += 1
        groups[g]["total"] = round(groups[g]["total"] + (total or 0), 2)
        groups[g]["unpriced"] += 0 if total is not None else 1
        warn = line_warnings(d, x, c, names)
        age = _age(x.get("price_at"))
        out.append({"i": i, "no": no, "group": g, "group_auto": auto_group(x), "kind": kind_of(x), "maker": x.get("maker") or "", "total": total, "warn": warn,
                    "pid": (part or {}).get("id"), "moved": _moved(con, x, part), "price_age": age, "price_old": age is not None and age > PRICE_OLD_DAYS and p is not None,
                    "api_price": api_priced(x) and p is not None, "not_in_catalogue": not part and bool(x.get("part")), "no_part": not x.get("part"), "no_qty": q is None or q == 0})
    check = completeness(d, lines)
    revs = d.get("bom_revs") if isinstance(d.get("bom_revs"), list) else []
    return {"lines": out, "groups": [g for g in groups.values() if g["lines"]], "group_list": [{"key": k, "label": v, "short": GROUP_SHORT[k]} for k, v in GROUPS], "total": round(sum(g["total"] for g in groups.values()), 2),
            "settings": s, "check": check, "job_warn": job_warnings(d, lines, c), "outputs": outputs(job, lines), "bands": [{"band": b["band"], "lo": b["lo"], "hi": b["hi"]} for b in c["bands"]],
            "locations": locations(d, lines), "revs": [{k: r.get(k) for k in ("rev", "at", "by", "note", "override")} for r in revs], "changes": diff(revs[-1], lines) if revs else None,
            "price_old_days": PRICE_OLD_DAYS}


def locations(d, lines):
    """The places a line can go: the job's floors, the usual rooms, and anything already typed."""
    floors = [f"Floor {f.get('name')}" for f in d.get("floors") or [] if isinstance(f, dict) and f.get("name") not in (None, "")]
    base = ["Roof", "Head-end room", "Riser"] + floors + ["Plenum", "Stock / truck"]
    return base + sorted({str(x.get("loc")) for x in lines if x.get("loc") and str(x.get("loc")) not in base})


# ---------------------------------------------------------------- three outputs of one list
_MONEY_WORD = re.compile(r"(\$\s*[\d,]+(?:\.\d+)?|\b\d[\d,]*\.\d\d\b\s*(?:usd|each|ea)\b)", re.I)


def no_money(note):
    """A free-text note on a sheet that carries no prices: a dollar figure typed into it doesn't go through."""
    return _MONEY_WORD.sub("[price removed]", str(note or ""))


def _head(job):
    d = job.get("data") or {}
    revs = d.get("bom_revs") if isinstance(d.get("bom_revs"), list) else []
    sub = (d.get("design") or {}).get("sub") or {}
    return {"job": job.get("name") or "", "address": d.get("address") or "", "ahj": d.get("ahj") or "", "project": sub.get("project_no") or "",
            "rev": revs[-1]["rev"] if revs else "", "rev_at": (revs[-1].get("at") or "")[:10] if revs else "", "date": das.now()[:10]}


def outputs(job, lines=None):
    """{customer, technician, ahj}: one list, grouped, each with only what that reader should see. No cost leaves in customer: the
    unit price is worked out here and written as a value. Pass lines from das.with_part_codes for the code fields."""
    d = job.get("data") or {}
    bom = (d.get("bom") or []) if lines is None else lines
    s, order = settings(d), _ordered(bom)
    cust, tech, ahj, hours, labor_cost = {}, {}, [], 0.0, 0.0
    held = 0
    for no, i, x in order:
        g, q, p = group_of(x), _num(x.get("qty")), _num(x.get("price"))
        hold = api_priced(x) and p is not None
        held += 1 if hold else 0
        unit = sell_price(p, s) if p is not None and not hold else None
        total = round(q * unit, 2) if q is not None and unit is not None else None
        hours += (q or 0) * (_num(x.get("labor_h")) or 0)
        labor_cost += _num(x.get("labor_cost")) or 0
        base = {"no": no, "item": x.get("item") or "", "part": x.get("part") or "", "maker": x.get("maker") or "", "qty": q if q is not None else x.get("qty") or "", "unit": x.get("unit") or ""}
        cust.setdefault(g, []).append(dict(base, price=unit, total=total))
        tech.setdefault(g, []).append(dict(base, i=i, loc=x.get("loc") or "", note=no_money(x.get("note")), picked=bool(x.get("picked"))))
        c = x.get("codes") or {}
        val = lambda f: (c.get(f) or {}).get("v") or ""  # noqa: E731
        ahj.append(dict(base, group=GROUP_LABEL[g], ul2524=val("ul2524"), fcc_id=val("fcc_id"), booster_class=val("booster_class"), nema=val("nema"),
                        rating_2h=val("rating_2h"), spec=spec_ref(None, job, x), spec_url=x.get("spec_url") or ""))
    groups = lambda m: [{"key": k, "label": lab, "lines": m[k]} for k, lab in GROUPS if m.get(k)]  # noqa: E731
    custg = groups(cust)
    for g in custg:
        g["subtotal"] = round(sum(x["total"] or 0 for x in g["lines"]), 2)
    equipment = round(sum(g["subtotal"] for g in custg), 2)
    rate = _num(s.get("labor_rate")) or 0
    labor = round(hours * rate + labor_cost, 2)
    tax_pct = _num(s.get("tax_pct")) or 0
    tax = round(equipment * tax_pct / 100, 2)
    unpriced = sum(1 for g in custg for x in g["lines"] if x["total"] is None)
    return {"head": _head(job),
            "customer": {"groups": custg, "equipment": equipment, "labor": labor, "labor_hours": round(hours, 2), "labor_rate": rate, "tax": tax, "tax_pct": tax_pct,
                         "labor_cost": round(labor_cost, 2), "total": round(equipment + labor + tax, 2), "unpriced": unpriced, "api_held": held,
                         "no_markup": not (_num(s.get("price_pct")) or 0)},
            "technician": {"groups": groups(tech), "lines": len(order), "picked": sum(1 for _, _, x in order if x.get("picked"))},
            "ahj": {"lines": ahj}}


def spec_ref(jid, job, x):
    """A line's spec sheet as the AHJ reads it: the file in this packet when it's been gathered, else the maker's link, else nothing."""
    label = str(x.get("part") or x.get("item") or "").strip()
    if not label:
        return ""
    name = f"Spec sheet - {das.safe_name(label)}.pdf"
    jid = jid if jid is not None else job.get("id")
    if jid is not None:
        d = das.job_dir(jid, job.get("name") or "", create=False)
        if os.path.isfile(os.path.join(d, name)):
            return "Spec sheets/" + name
    return x.get("spec_url") or ""


# ---------------------------------------------------------------- the workbook
def _titles(title, h, extra=""):
    bits = [h["job"], h["address"], f"Project {h['project']}" if h["project"] else ""]
    rev = f"Rev {h['rev']}, {h['rev_at']}" if h["rev"] else ""
    line = " · ".join(x for x in (extra, rev, f"Printed {h['date']}") if x)
    return [[{"v": title, "s": "title"}], [{"v": " · ".join(x for x in bits if x), "s": "sub"}], [{"v": line, "s": "sub"}], []]


def customer_sheet(o):
    C, h = o["customer"], o["head"]
    head = [{"v": v, "s": "head_n" if v in ("Qty", "Unit price", "Total") else "head"} for v in ("Item", "Description", "Part number", "Maker", "Qty", "Unit", "Unit price", "Total")]
    rows, merges, subs = _titles("Bill of materials", h) + [head], [], []
    for g in C["groups"]:
        rows.append([{"v": g["label"], "s": "group"}] + [{"v": None, "s": "group"}] * 7)
        merges.append(f"A{len(rows)}:H{len(rows)}")
        first = len(rows) + 1
        for x in g["lines"]:
            r = len(rows) + 1
            q = x["qty"] if isinstance(x["qty"], (int, float)) else None
            line = {"f": f"ROUND(E{r}*G{r},2)", "v": x["total"], "s": "money"} if x["total"] is not None else {"v": None, "s": "money"}
            rows.append([{"v": x["no"], "s": "num"}, {"v": x["item"], "s": "wrap"}, {"v": x["part"], "s": "text"}, {"v": x["maker"], "s": "text"},
                         {"v": q if q is not None else x["qty"], "s": "num"}, {"v": x["unit"], "s": "text"}, {"v": x["price"], "s": "money"}, line])
        rows.append([{"v": f"{g['label']} subtotal", "s": "sub_l"}] + [{"v": None, "s": "sub_l"}] * 6 + [{"f": f"SUM(H{first}:H{len(rows)})", "v": g["subtotal"], "s": "sub_m"}])
        subs.append(len(rows))
    rows.append([])
    row_eq = len(rows) + 1
    label = lambda t, s="sub_l": [{"v": t, "s": s}] + [{"v": None, "s": s}] * 6  # noqa: E731
    rows.append(label("Equipment") + [{"f": "+".join(f"H{r}" for r in subs) or "0", "v": C["equipment"], "s": "sub_m"}])
    add = [f"H{row_eq}"]
    if C["labor"]:
        rows.append(label(f"Installation labor, {C['labor_hours']:g} hours" if C["labor_hours"] else "Installation labor") + [{"v": C["labor"], "s": "sub_m"}])
        add.append(f"H{len(rows)}")
    if C["tax_pct"]:
        rows.append(label(f"Sales tax, {C['tax_pct']:g}% on equipment") + [{"f": f"ROUND(H{row_eq}*{C['tax_pct'] / 100:g},2)", "v": C["tax"], "s": "sub_m"}])
        add.append(f"H{len(rows)}")
    rows.append(label("Total", "total_l") + [{"f": "+".join(add), "v": C["total"], "s": "total_m"}])
    return {"name": "Customer", "rows": rows, "cols": [6, 46, 22, 18, 8, 6, 12, 13], "head_row": 5, "merges": merges, "footer": h["job"]}


def technician_sheet(o):
    T, h = o["technician"], o["head"]
    head = [{"v": v, "s": "head_n" if v == "Qty" else "head"} for v in ("Pick", "Item", "Part number", "Description", "Maker", "Qty", "Unit", "Location", "Note")]
    rows, merges = _titles("Pick list", h) + [head], []
    boxes = []
    for g in T["groups"]:
        rows.append([{"v": g["label"], "s": "group"}] + [{"v": None, "s": "group"}] * 8)
        merges.append(f"A{len(rows)}:I{len(rows)}")
        for x in g["lines"]:
            rows.append([{"v": "☑" if x["picked"] else "☐", "s": "center"}, {"v": x["no"], "s": "num"}, {"v": x["part"], "s": "text"}, {"v": x["item"], "s": "wrap"},
                         {"v": x["maker"], "s": "text"}, {"v": x["qty"], "s": "num"}, {"v": x["unit"], "s": "text"}, {"v": x["loc"], "s": "text"}, {"v": x["note"], "s": "wrap"}])
            boxes.append(len(rows))
    rng = f"A{boxes[0]}:A{boxes[-1]}" if boxes else "A6:A6"
    rows.append([])
    rows.append([{"v": "Lines to pick", "s": "sub_l"}, {"v": None, "s": "sub_l"}, {"f": f'COUNTIF({rng},"☐")+COUNTIF({rng},"☑")', "v": T["lines"], "s": "sub_n"}])
    rows.append([{"v": "Picked", "s": "sub_l"}, {"v": None, "s": "sub_l"}, {"f": f'COUNTIF({rng},"☑")', "v": T["picked"], "s": "sub_n"}])
    return {"name": "Technician", "rows": rows, "cols": [6, 6, 22, 44, 18, 8, 6, 18, 34], "head_row": 5, "merges": merges, "lists": [(rng, ["☐", "☑"])], "footer": h["job"]}


def ahj_sheet(o):
    A, h = o["ahj"], o["head"]
    names = ("Item", "Group", "Description", "Part number", "Maker", "Qty", "Unit", "UL 2524 listing", "FCC ID", "Class", "NEMA", "2-hour rating", "Spec sheet")
    head = [{"v": v, "s": "head_n" if v == "Qty" else "head"} for v in names]
    rows = _titles("Bill of materials for AHJ review", h, f"AHJ: {h['ahj']}" if h["ahj"] else "") + [head]
    first = len(rows) + 1
    for x in A["lines"]:
        url = x["spec"] if x["spec"].startswith("http") else ""
        spec = {"v": x["spec"], "s": "link" if url else "wrap", "url": url}
        rows.append([{"v": x["no"], "s": "num"}, {"v": x["group"], "s": "text"}, {"v": x["item"], "s": "wrap"}, {"v": x["part"], "s": "text"}, {"v": x["maker"], "s": "text"},
                     {"v": x["qty"], "s": "num"}, {"v": x["unit"], "s": "text"}, {"v": x["ul2524"], "s": "text"}, {"v": x["fcc_id"], "s": "text"}, {"v": x["booster_class"], "s": "text"},
                     {"v": x["nema"], "s": "text"}, {"v": x["rating_2h"], "s": "text"}, spec])
    last = len(rows)
    rows.append([])
    rows.append([{"v": "Lines", "s": "sub_l"}, {"v": None, "s": "sub_l"}, {"f": f"COUNT(A{first}:A{last})" if A["lines"] else "0", "v": len(A["lines"]), "s": "sub_n"}])
    return {"name": "AHJ", "rows": rows, "cols": [6, 22, 44, 22, 18, 8, 6, 22, 16, 7, 8, 16, 40], "head_row": 5,
            "filter": f"A5:M{last}" if A["lines"] else None, "footer": h["job"]}


def order_sheet(job, lines):
    """What to buy from whom, at cost: for the firm only, so it's a file of its own and never a sheet in the workbook a customer gets."""
    h, by = _head(job), {}
    for no, _, x in _ordered(lines):
        by.setdefault(x.get("supplier") or "No supplier yet", []).append((no, x))
    head = [{"v": v, "s": "head_n" if v in ("Qty", "Unit cost", "Total") else "head"} for v in ("Item", "Part number", "Description", "Maker", "Qty", "Unit", "Unit cost", "Total")]
    rows, merges, subs, grand = _titles("Order by supplier", h, "Internal: shows your cost") + [head], [], [], 0.0
    for sup in sorted(by, key=lambda k: (k == "No supplier yet", k.lower())):
        rows.append([{"v": sup, "s": "group"}] + [{"v": None, "s": "group"}] * 7)
        merges.append(f"A{len(rows)}:H{len(rows)}")
        first, tot = len(rows) + 1, 0.0
        for no, x in by[sup]:
            r = len(rows) + 1
            q, p = _num(x.get("qty")), _num(x.get("price"))
            t = round(q * p, 2) if q is not None and p is not None else None
            tot += t or 0
            rows.append([{"v": no, "s": "num"}, {"v": x.get("part") or "", "s": "text"}, {"v": x.get("item") or "", "s": "wrap"}, {"v": x.get("maker") or "", "s": "text"},
                         {"v": q if q is not None else x.get("qty") or "", "s": "num"}, {"v": x.get("unit") or "", "s": "text"}, {"v": p, "s": "money"},
                         {"f": f"ROUND(E{r}*G{r},2)", "v": t, "s": "money"} if t is not None else {"v": None, "s": "money"}])
        rows.append([{"v": f"{sup} total", "s": "sub_l"}] + [{"v": None, "s": "sub_l"}] * 6 + [{"f": f"SUM(H{first}:H{len(rows)})", "v": round(tot, 2), "s": "sub_m"}])
        subs.append(len(rows))
        grand += tot
    rows.append([])
    rows.append([{"v": "All suppliers", "s": "total_l"}] + [{"v": None, "s": "total_l"}] * 6 + [{"f": "+".join(f"H{r}" for r in subs) or "0", "v": round(grand, 2), "s": "total_m"}])
    return {"name": "Order by supplier", "rows": rows, "cols": [6, 22, 44, 18, 8, 6, 12, 13], "head_row": 5, "merges": merges, "footer": h["job"]}


OUTPUTS = {"customer": customer_sheet, "technician": technician_sheet, "ahj": ahj_sheet}


def workbook(job, sheets=("customer", "technician", "ahj"), jid=None, con=None):
    """The .xlsx: a sheet per output, with live totals. "orders" is its own sheet at cost: ask for it on its own."""
    job = dict(job, id=jid if jid is not None else job.get("id"))
    if con is not None:
        job = das.with_part_codes(con, job)
    lines = (job.get("data") or {}).get("bom") or []
    o = outputs(job, lines)
    out = []
    for k in sheets:
        if k == "orders":
            out.append(order_sheet(job, lines))
        elif k in OUTPUTS:
            out.append(OUTPUTS[k](o))
        else:
            raise ValueError(f"No such sheet: {k}.")
    if not out:
        raise ValueError("Which sheets? customer, technician, ahj or orders.")
    return xlsxout.workbook(out, title=f"{job.get('name') or ''}: bill of materials")


# ---------------------------------------------------------------- an iBwave equipment list
# iBwave Design's Equipment List shows Type, Manufacturer, Model, Description, Inventory # and Quantity; its Cost Details
# adds Unit Cost, Equipment Cost and Construction Cost (iBwave's Level 1 student manual, as an OCR scan; a component's
# properties also carry a Part ID, per blog.ibwave.com/components-database). No real export was available to test against,
# reports can be customised, and a list can open with title rows, so the import looks for its header row, reads
# columns by name, and reports what it couldn't place. The Part ID, else Model, else Inventory # is the part number.
EQUIP_ALIASES = {
    "part": ["partnumber", "partno", "partid", "pn", "sku", "mpn", "catalognumber", "catalogno", "ordercode"],
    "model": ["model", "modelnumber", "modelno", "componentmodel"],
    "inventory": ["inventory", "inventorynumber", "inventoryno", "inventoryid", "inv"],
    "item": ["description", "itemdescription", "componentname", "component", "name", "item", "equipment", "productname", "product"],
    "maker": ["manufacturer", "maker", "brand", "mfr", "mfg", "make", "vendor"],
    "cat": ["type", "componenttype", "equipmenttype", "category", "class", "group"],
    "qty": ["quantity", "qty", "count", "length", "totalquantity"],
    "unit": ["unit", "units", "uom", "unitofmeasure"],
    "price": ["unitcost", "unitprice", "cost", "price"],
    "ext": ["equipmentcost", "extendedcost", "totalcost", "extended", "total"],
    "construction": ["constructioncost", "installationcost", "installcost", "laborcost", "labour"],
    "loc": ["location", "floor", "zone", "room"],
    "note": ["note", "notes", "comment", "comments", "remarks"],
}
_CORE_FIELDS = ("part", "model", "inventory", "item", "maker", "cat", "qty", "price")


def _tables(name, data):
    """A file as [(sheet name, rows of cells)], every sheet, with any title rows still there."""
    if data[:8] == xlsread.MAGIC:
        try:
            return xlsread.tables(data)
        except ValueError as e:
            raise ValueError(f"That .xls couldn't be read ({e}) Open it in Excel, save it as .xlsx or CSV, and import that.")
    n = (name or "").lower()
    if n.endswith(".xlsx") or data[:2] == b"PK":
        return das._xlsx_tables(data, gaps=True)
    text = data.decode("utf-8-sig", "replace")
    if n.endswith(".json") or text.lstrip()[:1] in "[{":
        _, head, rows = das.read_table(name, data)
        return [(name, [head] + [[r.get(h, "") for h in head] for r in rows])]
    if re.search(r"<table\b", text[:200000], re.I):  # some report tools write a web page and call it .xls
        return [(name, rows) for rows in _html_tables(text)] or [(name, [])]
    if "\x00" in text:
        text = data.decode("utf-16", "replace").lstrip("\ufeff")
    try:
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [(name, list(csv.reader(io.StringIO(text), dialect)))]


class _HtmlTables(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self.row = []
            self.tables[-1].append(self.row)
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip())
            self.cell = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def _html_tables(text):
    p = _HtmlTables()
    p.feed(text)
    return p.tables


def _find_header(rows):
    """The row that looks most like a header, among the first 40: (row index, column map, score)."""
    best = (None, {}, 0)
    for i, r in enumerate(rows[:40]):
        head = [str(c).strip() for c in r]
        if len([h for h in head if h]) < 2:
            continue
        m = das.guess_mapping([h for h in head if h], EQUIP_ALIASES)
        score = sum(1 for f in _CORE_FIELDS if f in m)
        if score > best[2] and ("qty" in m or "part" in m or "model" in m):
            best = (i, m, score)
    return best


def _qty_unit(v):
    """ "120 ft", "36.5 m", "4", "4.0" -> (number, unit or "")."""
    t = str(v if v is not None else "").strip()
    m = re.match(r"^([\d,]*\.?\d+)\s*([a-zA-Z'\"]*)", t)
    if not m:
        return None, ""
    n = float(m.group(1).replace(",", ""))
    u = m.group(2).lower().replace("'", "ft").replace("feet", "ft").replace("foot", "ft").replace("meters", "m").replace("metres", "m").replace("meter", "m").replace("metre", "m")
    return (int(n) if n == int(n) else n), ("ea" if u in ("pc", "pcs", "each") else u)


def import_equipment(con, name, data):
    """An equipment list -> the lines it would add, and everything it couldn't place. Nothing is saved: the tab shows this first."""
    tables = _tables(name, data)
    sheet, rows, idx, m, score = None, [], None, {}, 0
    for nm, r in tables:
        i, mp, sc = _find_header(r)
        if sc > score:
            sheet, rows, idx, m, score = nm, r, i, mp, sc
    if idx is None:
        seen = [str(c).strip() for r in (tables[0][1] if tables else [])[:3] for c in r if str(c).strip()]
        raise ValueError("No equipment columns found. It needs a quantity, and a part number or model. Read: " + (", ".join(seen[:12]) or "nothing"))
    head = [str(c).strip() for c in rows[idx]]
    col = {f: head.index(h) for f, h in m.items()}
    lines, unmatched, skipped, unit_guess, joined, section = {}, [], [], 0, 0, ""

    def cell(r, f):
        i = col.get(f)
        return str(r[i]).strip() if i is not None and i < len(r) and r[i] is not None else ""
    for n, r in enumerate(rows[idx + 1:], idx + 2):
        filled = [str(c).strip() for c in r if str(c).strip()]
        if not filled:
            continue
        part = cell(r, "part") or cell(r, "model") or cell(r, "inventory")
        item = cell(r, "item") or cell(r, "model") or cell(r, "cat")
        qty, unit = _qty_unit(cell(r, "qty"))
        if len(filled) == 1 and qty is None and not cell(r, "qty"):  # a heading row inside the list ("Antennas")
            section = filled[0]
            continue
        if re.match(r"^(grand\s*)?(sub)?total\b", filled[0], re.I):
            continue
        if not part and not item:
            skipped.append({"row": n, "why": "no part number or description", "text": " ".join(filled)[:80]})
            continue
        if qty is None:
            skipped.append({"row": n, "why": "no quantity", "text": (part or item)[:80]})
            continue
        cat = cell(r, "cat") or section
        line = {"cat": cat, "item": item or part, "part": part, "maker": cell(r, "maker"), "supplier": "", "qty": qty, "unit": cell(r, "unit").lower() or unit, "note": cell(r, "note"),
                "loc": cell(r, "loc")}
        probe = {"cat": cat, "item": item, "part": part}
        if not line["unit"]:
            cable = kind_of(probe) in ("coax", "fiber_cable")
            line["unit"] = "ft" if cable else "ea"
            unit_guess += 1 if cable else 0
        price = _num(cell(r, "price"))
        if price is None and _num(cell(r, "ext")) is not None and qty:
            price = round(_num(cell(r, "ext")) / qty, 4)
        if price is not None:
            line.update(price=price, price_at=das.now()[:10], price_by="equipment list")
        labor = _num(cell(r, "construction"))
        if labor:
            line["labor_cost"] = labor  # iBwave's Construction Cost: the installation cost of the line
        hit = das._match_part(con, line) or next(iter(das.lookup_part(con, part, limit=1)["matches"]), None) if part else das._match_part(con, line)
        if hit:
            hit = dict(hit) if not isinstance(hit, dict) else hit
            line.update(pid=hit["id"], maker=line["maker"] or hit.get("maker") or "", supplier=hit.get("supplier") or "", unit=line["unit"] or hit.get("unit") or "ea")
            if price is None and hit.get("price") is not None:
                line.update(price=hit["price"], price_at=das.now()[:10], price_by="catalogue")
        else:
            unmatched.append({"part": part, "item": item})
        k = (das._part_key(part, item), line["loc"])
        if k in lines:  # the same part on two rows, a floor at a time
            lines[k]["qty"] += qty
            lines[k]["labor_cost"] = (lines[k].get("labor_cost") or 0) + (line.get("labor_cost") or 0) or None
            joined += 1
        else:
            lines[k] = line
    out = list(lines.values())
    for x in out:
        x["group_label"] = GROUP_LABEL[group_of(x)]
    guessed = sum(1 for x in out if group_of(x) == "accessories" and kind_of(x) == "other")
    by_group = {}
    for x in out:
        by_group[x["group_label"]] = by_group.get(x["group_label"], 0) + 1
    read = {f: h for f, h in m.items()}
    used = set(read.values())
    return {"format": "excel" if (name or "").lower().endswith(".xlsx") or data[:2] == b"PK" else "text", "sheet": sheet, "header_row": idx + 1, "columns": read,
            "not_read": [h for h in head if h and h not in used], "lines": out, "matched": len(out) - len(unmatched), "unmatched": unmatched[:200], "skipped": skipped[:200],
            "no_group": guessed, "unit_guessed": unit_guess, "joined": joined, "groups": [{"label": lab, "lines": by_group[lab]} for _, lab in GROUPS if lab in by_group],
            "labor_cost": round(sum(x.get("labor_cost") or 0 for x in out), 2)}


# ---------------------------------------------------------------- revisions of the list, and what changed
SNAP_FIELDS = ("pid", "group", "cat", "item", "part", "maker", "supplier", "qty", "unit", "price", "loc")
_DIFF_FIELDS = (("qty", "Quantity"), ("price", "Price"), ("supplier", "Supplier"), ("loc", "Location"))


def _snap(x):
    return {k: x.get(k) for k in SNAP_FIELDS if x.get(k) not in (None, "")}


def _dkey(x):
    return (das._part_key(x.get("part"), x.get("item")), str(x.get("loc") or ""))


def _same(a, b):
    na, nb = _num(a), _num(b)
    return abs(na - nb) < 0.00005 if na is not None and nb is not None else str(a or "") == str(b or "")


def diff(rev, lines):
    """What changed since a revision: {rev, at, added, removed, changed: [{part, item, field, was, now}], cost_change}."""
    old = {_dkey(x): x for x in rev.get("lines") or []}
    new = {_dkey(x): x for x in lines}
    cost = lambda x: (_num(x.get("qty")) or 0) * (_num(x.get("price")) or 0)  # noqa: E731
    label = lambda x: {"part": x.get("part") or "", "item": x.get("item") or "", "qty": x.get("qty") or "", "unit": x.get("unit") or ""}  # noqa: E731
    changed = []
    for k in old.keys() & new.keys():
        for f, name in _DIFF_FIELDS:
            if not _same(old[k].get(f), new[k].get(f)):
                changed.append(dict(label(new[k]), field=name, was=old[k].get(f) or "", now=new[k].get(f) or ""))
    return {"rev": rev.get("rev"), "at": (rev.get("at") or "")[:10], "added": [label(new[k]) for k in new.keys() - old.keys()], "removed": [label(old[k]) for k in old.keys() - new.keys()],
            "changed": changed, "cost_change": round(sum(cost(x) for x in new.values()) - sum(cost(x) for x in old.values()), 2)}


def _next_rev(revs):
    n = len(revs)
    return chr(65 + n) if n < 26 else f"A{n - 25}"


def issue(con, jid, job, note="", override="", who=""):
    """A dated revision of the list. Everything the check finds open must be added or marked not needed first; override, in words,
    issues it anyway and stays on the record."""
    d = job.get("data") or {}
    lines = (das.with_part_codes(con, job).get("data") or {}).get("bom") or []
    if not lines:
        raise ValueError("The bill of materials is empty.")
    check = completeness(d, lines)
    still = [r["title"] for r in check["rows"] if r["status"] == "missing"]
    if still and not str(override or "").strip():
        raise ValueError(f"{len(still)} still open: {', '.join(still[:6])}{' and more' if len(still) > 6 else ''}. Add each one, mark it not needed, or say why you're issuing anyway.")
    revs = d.get("bom_revs") if isinstance(d.get("bom_revs"), list) else []
    rev = {"rev": _next_rev(revs), "at": das.now(), "by": who, "note": str(note or "")[:300], "override": str(override or "")[:300], "open": still, "lines": [_snap(x) for x in d.get("bom") or []]}
    das.save_job(con, {"data": {"bom_revs": revs + [rev]}}, jid, page=True)
    return {k: rev[k] for k in ("rev", "at", "by", "note", "override", "open")}


# ---------------------------------------------------------------- kits: a set of lines saved once, added to any job
KIT_FIELDS = ("pid", "group", "cat", "item", "part", "maker", "supplier", "qty", "unit", "note", "labor_h")


def _kit_row(con, r):
    lines = []
    for x in das._json(r["lines"], []):
        part = das._match_part(con, x)  # today's price, not the price when the kit was saved
        lines.append(dict(x, price=part["price"], price_at=das.now()[:10], price_by="catalogue") if part and part["price"] is not None else dict(x))
    return {"id": r["id"], "name": r["name"], "lines": lines, "updated_at": r["updated_at"]}


def list_kits(con):
    return {"kits": [_kit_row(con, r) for r in con.execute("SELECT * FROM das_bom_kit ORDER BY name")]}


def save_kit(con, d):
    name = re.sub(r"\s+", " ", str(d.get("name") or "")).strip()[:80]
    lines = [{k: x.get(k) for k in KIT_FIELDS if x.get(k) not in (None, "")} for x in d.get("lines") or [] if isinstance(x, dict)]
    if not name:
        raise ValueError("A kit needs a name.")
    if not lines:
        raise ValueError("A kit needs at least one line.")
    con.execute("""INSERT INTO das_bom_kit(name, lines, updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET lines=excluded.lines,
                   updated_at=excluded.updated_at""", (name, json.dumps(lines), das.now()))
    con.commit()
    return list_kits(con)


def delete_kit(con, kid):
    con.execute("DELETE FROM das_bom_kit WHERE id=?", (kid,))
    con.commit()
    return list_kits(con)
