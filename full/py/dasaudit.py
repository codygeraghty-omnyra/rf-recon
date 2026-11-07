"""
Existing-system (legacy booster) audit for a DAS job whose building already has a BDA / ERCES (R1 and R2: the rules
changed since many were installed; old Class A boosters from defunct makers turn up in FCC interference notices).

A checklist, each item with its source, and findings worked out from what the job already holds: the booster's
class, passbands, registration and listing as entered, the channel plan, the consent statuses (passband licensees),
the licence change watch and the test dates. A finding is "problem", "check" (not known yet) or "ok". The findings go
on the AHJ report and the board's "Needs you". Nothing here is a ruling: the AHJ and the licensees decide.
"""
import re
import time

import daswatch

ECFR_90_219 = "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-I/section-90.219"
ECFR_90_7 = "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-A/section-90.7"
SRC = {
    "90.219": ("47 CFR 90.219 (eCFR)", ECFR_90_219),
    "90.7": ("47 CFR 90.7, Class A and B definitions (eCFR)", ECFR_90_7),
    "registry": ("FCC signal booster registrations", "https://signalboosters.fcc.gov/"),
    "fccid": ("FCC equipment authorization search (FCC ID)", "https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm"),
    "firstnet": ("FirstNet Authority", "https://www.firstnet.gov/"),
    "ul2524": ("Intertek: UL 2524 3rd edition, listings not updated by 2026-03-22 withdrawn",
               "https://www.intertek.com/siteassets/resources/sun/2025/ul-2524-sun-rev-3-22-2024-ed-3-22-2026.pdf"),
    "nfpa1225": ("NFPA 1225 (free access)", "https://www.nfpa.org/codes-and-standards/nfpa-1225-standard-development/1225"),
    "notice": ("FCC Notification of Harmful Interference, Hallandale FL, 13 May 2025 (Class A Axell booster, 799-805 MHz)",
               "https://docs.fcc.gov/public/attachments/DOC-411377A1.pdf"),
}

# the checklist: key, what to do, why, sources. Keys are kept with the job: append, never rename
CHECKLIST = [
    ("label", "Read the booster's label: maker, model, FCC ID, Class A or Class B",
     "Labels are required on signal boosters sold since 1 March 2014; the FCC ID says what it's certified for.", ["90.219"]),
    ("grant", "Look up the FCC ID's grant: bands and booster class it is certified for",
     "A grant that doesn't cover a channel the AHJ needs means the unit can't legally pass it.", ["fccid"]),
    ("registration", "Class B: find its FCC registration; none on file means it must be registered",
     "Class B boosters are fixed only and registered with the FCC (90.219(d)(5)).", ["90.219", "registry"]),
    ("consent", "Licensee consent on file for every licensee whose channels it passes",
     "Consent comes first (90.219(b)(1)); a Class B booster passes every licensee inside its passband.", ["90.219"]),
    ("channels", "Its filters against today's licences: every channel the AHJ needs passed, none that's gone",
     "Agencies move channels; a booster tuned years ago can pass dead channels and miss new ones.", ["90.219"]),
    ("esmr", "Nothing commercial in a public safety passband (800 MHz ESMR 862-869 MHz kept out)",
     "A Class B passband may not span commercial and Part 90 public safety channels except in-building DAS (90.219).", ["90.219"]),
    ("band14", "Band 14 (FirstNet 758-768 / 788-798 MHz): authorized, or filtered out",
     "Passing it needs the FirstNet Authority's written authorization; some AHJs require it filtered out (Broward, Douglas County).", ["firstnet"]),
    ("oscillation", "Oscillation detection and shutdown work, and the alarm reaches the fire alarm panel",
     "An oscillating booster jams the agency's site; the annual test checks it and NFPA 1225 supervises it.", ["nfpa1225"]),
    ("noise", "Uplink noise at the agency site: under 1 dB rise with the booster on (10 kHz RBW, 5-minute average, booster on and off)",
     "In-band noise is capped at -43 dBm ERP per 10 kHz (90.219); the FCC finds noisy old boosters by direction finding and sends notices.", ["90.219", "notice"]),
    ("ul2524", "UL 2524 listing, 3rd edition; amplifiers in NEMA 4 / 4X enclosures",
     "Intertek withdraws UL 2524 listings not updated to the 3rd edition by 2026-03-22.", ["ul2524"]),
    ("power", "Standby battery: the hours the AHJ asks today (12 or 24), battery age, a 1-hour load test", "", ["nfpa1225"]),
    ("code", "Code of record: which code it was accepted under, and which the AHJ applies to the retest",
     "Older systems were accepted to NFPA 72 and earlier IFC editions at 90% coverage; NFPA 1225 and IFC 2021 / 2024 ask 95% of general and 99% of critical areas. A modification usually brings in today's code.", ["nfpa1225"]),
    ("records", "Acceptance report and gain settings on file; the last annual test", "The annual test compares gains with acceptance (IFC 510.6).", ["nfpa1225"]),
    ("monitoring", "Supervision to the fire alarm panel and an annunciator in the fire command center", "", ["nfpa1225"]),
]
CLASS_A_MAX_KHZ = 75.0


def _src(keys):
    return [{"label": SRC[k][0], "url": SRC[k][1]} for k in keys if k in SRC]


def parse_passbands(text):
    """"851-861, 806.0125-816" (MHz) -> [(851.0, 861.0), ...]; a single number is a one-channel passband."""
    out = []
    for part in re.split(r"[,;\n]+", text or ""):
        nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", part)]
        if len(nums) >= 2:
            out.append((min(nums[0], nums[1]), max(nums[0], nums[1])))
        elif len(nums) == 1:
            out.append((nums[0], nums[0]))
    return out


def _year(s):
    m = re.search(r"\b(19|20)\d\d\b", str(s or ""))
    return int(m.group(0)) if m else None


def audit(d, stage="", today=None):
    """{flag, findings: [{key, state, what, do, sources}], checklist: [...with done dates], counts}."""
    L = d.get("legacy") or {}
    today = today or time.strftime("%Y-%m-%d")
    out = []

    def add(key, state, what, do="", src=()):
        out.append({"key": key, "state": state, "what": what, "do": do, "sources": _src(src)})

    cls = (L.get("cls") or "").strip()
    yr = _year(L.get("installed"))
    if not cls or cls == "unknown":
        add("class", "check", "Booster class not known yet.", "Read it off the label or the FCC ID's grant: Class A (channelized, each passband 75 kHz or less) or Class B (wideband).", ["90.7", "fccid"])
    if yr and yr < 2014:
        add("age", "check", f"Installed {yr}: before the FCC's current booster rules (labels, Class A / B, Class B registration) took effect in 2014.",
            "Check it against 90.219 as it stands today: the FCC sends interference notices to old boosters regardless of age.", ["90.219", "notice"])
    if yr and yr < 2022:
        add("code", "check", f"Installed {yr}: accepted under an older code (NFPA 72 or IFC before 2021).",
            "Ask the AHJ which code the retest uses; a change to the system usually brings in today's (95% general, 99% critical).", ["nfpa1225"])
    reg = (L.get("registered") or "").strip()
    if cls == "Class B" and reg != "yes" and not (d.get("checks") or {}).get("fcc_reg"):
        add("registration", "problem", "Class B with no FCC registration on file.",
            "Search the FCC's registrations by address; if it isn't there, register it (90.219(d)(5)).", ["90.219", "registry"])
    elif cls == "Class B" and (reg == "yes" or (d.get("checks") or {}).get("fcc_reg")):
        add("registration", "ok", "Class B registration on file.", "", ["registry"])
    # consent: the chosen systems' licensees always; a Class B also every licensee in its passband (Pre-survey)
    cons = d.get("consents") or {}
    given = {k for k, v in cons.items() if (v or {}).get("status") == "given"}
    chosen = {daswatch.licensee_key(p.get("system")) for p in daswatch.plan_of(d) if p.get("system")}
    nb = {x["key"]: x for x in ((d.get("lic_watch") or {}).get("snapshot") or {}).get("neighbours") or []}
    need = set(chosen) | (set(nb) if cls == "Class B" else set())
    missing = sorted(need - given)
    if need and missing:
        names = [next((p.get("system") for p in daswatch.plan_of(d) if daswatch.licensee_key(p.get("system")) == k), None) or (nb.get(k) or {}).get("licensee") or k for k in missing]
        add("consent", "problem", f"No consent on file from {len(missing)} of {len(need)} licensee{'s' if len(need) != 1 else ''} it passes: {', '.join(names[:5])}{'…' if len(names) > 5 else ''}.",
            "Pre-survey, Licensees in the passband: send the letters and mark each one given." + (" As a Class B it passes every licensee in its passband." if cls == "Class B" else ""), ["90.219"])
    elif need:
        add("consent", "ok", f"Consent on file from all {len(need)} licensee{'s' if len(need) != 1 else ''} it passes.", "", ["90.219"])
    elif not chosen:
        add("consent", "check", "No channel plan yet, so it isn't known whose channels it passes.", "Pre-survey: tick the systems the AHJ requires.", ["90.219"])
    # its passbands against the plan
    pbs = parse_passbands(L.get("passbands"))
    plan = daswatch.plan_channels(d)
    if pbs and plan:
        allf = sorted({f for dn, up in plan.values() for f in dn | up})
        miss = [f for f in allf if not any(lo - 0.00625 <= f <= hi + 0.00625 for lo, hi in pbs)]
        if miss:
            add("channels", "problem", f"{len(miss)} planned channel{'s' if len(miss) != 1 else ''} outside its passbands: {', '.join(f'{f:g}' for f in miss[:8])}{'…' if len(miss) > 8 else ''} MHz.",
                "Radios on them won't work inside through this booster: retune it or add a module.", ["90.219"])
        else:
            add("channels", "ok", "Every planned channel is inside its passbands.", "", [])
        wide = [(lo, hi) for lo, hi in pbs if (hi - lo) * 1000 > CLASS_A_MAX_KHZ]
        if cls == "Class A" and wide:
            add("class_a_wide", "problem", f"Entered as Class A but {len(wide)} passband{'s are' if len(wide) != 1 else ' is'} wider than 75 kHz ({', '.join(f'{lo:g}-{hi:g}' for lo, hi in wide[:4])} MHz).",
                "Wider than 75 kHz is Class B by definition (90.7): check the class, and register it if it is B.", ["90.7", "90.219"])
    elif not pbs:
        add("channels", "check", "Its passbands aren't entered yet.", "Enter them from the booster's settings or its last test report (MHz, e.g. 851-861, 806-816).", [])
    if any(lo <= 869.0 and hi >= 862.0 for lo, hi in pbs):
        add("esmr", "problem", "A passband reaches into 862-869 MHz (commercial ESMR).", "Keep it out of a public safety booster.", ["90.219"])
    b14 = any(lo <= 768.0 and hi >= 758.0 or lo <= 798.0 and hi >= 788.0 for lo, hi in pbs)
    if b14 or L.get("band14") == "passes":
        if L.get("band14_auth"):
            add("band14", "ok", "Passes Band 14 (FirstNet), with the authorization on file.", "", ["firstnet"])
        else:
            add("band14", "problem", "Passes Band 14 (FirstNet 758-768 / 788-798 MHz) with no authorization on file.",
                "Get the FirstNet Authority's written authorization, or filter Band 14 out (some AHJs require that).", ["firstnet"])
    osc = L.get("oscillation") or ""
    if osc == "no":
        add("oscillation", "problem", "Oscillation shutdown doesn't work or isn't fitted.", "Fix or replace before it goes back in service.", ["nfpa1225"])
    elif osc != "yes":
        add("oscillation", "check", "Oscillation detection and shutdown not checked yet.", "Test it, and check the alarm reaches the fire alarm panel.", ["nfpa1225"])
    ul = L.get("ul2524") or ""
    if ul in ("1st", "2nd", "none"):
        add("ul2524", "problem", f"UL 2524 listing: {'none' if ul == 'none' else ul + ' edition'}.",
            "Intertek withdraws listings not updated to the 3rd edition by 2026-03-22: check the listing, or plan a replacement.", ["ul2524"])
    elif ul != "3rd":
        add("ul2524", "check", "UL 2524 listing edition not known yet.", "Check the listing mark and the maker's certificate.", ["ul2524"])
    last = L.get("last_test") or ""
    if re.match(r"^\d{4}-\d\d-\d\d$", last):
        days = (time.mktime(time.strptime(today, "%Y-%m-%d")) - time.mktime(time.strptime(last, "%Y-%m-%d"))) / 86400
        if days > 365:
            add("records", "problem", f"Last annual test {last}: {int(days - 365)} days overdue.", "Book the annual test (IFC 510.6).", ["nfpa1225"])
        else:
            add("records", "ok", f"Last annual test {last}.", "", ["nfpa1225"])
    else:
        add("records", "check", "No date for the last annual test.", "Ask the owner for the last report and the acceptance report with its gain settings.", ["nfpa1225"])
    w = d.get("lic_watch") or {}
    hi = [f for f in daswatch.open_items(w) if f["severity"] == "high"]
    if hi:
        add("licences", "problem", f"{len(hi)} FCC licence change{'s' if len(hi) != 1 else ''} since the snapshot (Pre-survey, Licence watch): {hi[0]['what']}",
            "Retune and retest for what changed.", ["90.219"])
    done = L.get("checks") or {}
    checklist = [{"key": k, "step": s, "why": why, "sources": _src(src), "done": done.get(k) or ""} for k, s, why, src in CHECKLIST]
    counts = {s: sum(1 for f in out if f["state"] == s) for s in ("problem", "check", "ok")}
    return {"flag": bool(L.get("flag")), "findings": out, "checklist": checklist, "counts": counts,
            "ticked": sum(1 for c in checklist if c["done"]), "note": "The AHJ and the licensees decide; these are what to check."}


def board(d, stage):
    """Needs-you lines for a job flagged as an existing system with problems open."""
    if stage == "Closed" or not (d.get("legacy") or {}).get("flag"):
        return []
    a = audit(d, stage)
    n = a["counts"]["problem"]
    if not n:
        return []
    first = next(f for f in a["findings"] if f["state"] == "problem")
    return [{"text": f"existing system audit: {n} problem{'s' if n != 1 else ''} ({first['what'].rstrip('.')})",
             "url": (first["sources"] or [{}])[0].get("url", ""), "source": (first["sources"] or [{}])[0].get("label", "")}]
