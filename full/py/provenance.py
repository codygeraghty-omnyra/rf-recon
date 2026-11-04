"""
Where every row came from, and how far to trust what it says (research "RF Recon data sources and aggregation",
section 3, 2026-11-02).

  origin group   who first observed or declared it. Copies (a field pack, the server, a kit) never make a new
                 one: the row keeps its source and fetched_at.
  method         measured, declared, modelled or derived
  source grade   A-F per source and per kind of claim (proposed from cited facts, not published ratings)
  claim grade    how many independent origin groups agree, in words. "Confirmed" needs two groups that agree on
                 something diagnostic, and for "on the air" one of them must be our own measurement.

Grades are worked out when a page asks, from the raw rows (RULES names the version a printed report carries).
"""
import re
import time

import geo

RULES = "provenance rules v1 (2026-11-02)"

# source -> (origin group, method, licence)
ORIGIN = {
    "uls": ("FCC filings", "declared", "US government public data"),
    "uls_hist": ("FCC filings", "declared", "US government public data"),
    "towers": ("FCC filings", "declared", "US government public data"),
    "broadcast": ("FCC filings", "declared", "US government public data"),
    "bdc": ("FCC model", "modelled", "US government public data"),
    "captures": ("first-party measured", "measured", "yours"),
    "opencellid": ("crowd phone", "derived", "CC BY-SA 4.0"),
    "wigle": ("crowd phone", "derived", "WiGLE: non-commercial, no redistribution"),
    "repeaterbook": ("crowd hobby radio", "declared", "RepeaterBook: personal use"),
    "wspr": ("crowd hobby radio", "measured", "wspr.live: non-commercial"),
    "pskreporter": ("crowd hobby radio", "measured", "not stated"),
    "ttn": ("crowd registry", "declared", "not stated"),
    "satnogs": ("crowd registry", "declared", "CC BY-SA 4.0"),
    "meshtastic": ("crowd registry", "declared", "not stated"),
    "helium": ("crowd registry", "declared", "not stated"),
    "noaa": ("reference", "declared", "US government public data"),
    "faa": ("reference", "declared", "US government public data"),
    "psap": ("reference", "declared", "US government public data"),
    "fss": ("FCC filings", "declared", "US government public data"),
    "custom": ("imported", "unknown", "whatever the file's owner allows"),
}
PRECISION_M = {"opencellid": 1000, "wigle": 150, "repeaterbook": 1500, "wspr": 2500, "pskreporter": 2500, "ttn": 100,
               "satnogs": 100, "uls": 30, "towers": 10, "broadcast": 30,
               "meshtastic": 400, "helium": 1000}  # how far a stated position can be off (mesh nodes and Helium blur theirs)

# A-F per source and claim (research table, section 3 rule 2). New users or instruments start at F: no track record
GRADES = {
    ("uls", "authorized"): "A", ("uls", "on_air"): "C", ("uls", "position"): "B",
    ("bdc", "coverage_claim"): "A", ("bdc", "indoor"): "D",
    ("opencellid", "position"): "D", ("wigle", "position"): "D", ("opencellid", "on_air"): "C", ("wigle", "on_air"): "C",
    ("repeaterbook", "on_air"): "C", ("wspr", "on_air"): "B", ("pskreporter", "on_air"): "B",
    ("ttn", "on_air"): "C", ("satnogs", "on_air"): "C", ("custom", "on_air"): "F",
    ("meshtastic", "on_air"): "C", ("helium", "on_air"): "C",
}
CLAIM_WORDS = {1: "Confirmed", 2: "Probably true", 3: "Possibly true", 4: "Doubtful", 5: "Improbable", 6: "Can't judge"}
STALE_DAYS = {"captures": 365, "uls": 30, "opencellid": 60, "wigle": 60, "repeaterbook": 60, "ttn": 30, "satnogs": 60,
              "wspr": 3, "pskreporter": 3, "custom": 365, "meshtastic": 7, "helium": 30}
CALLSIGN = re.compile(r"^[A-Z]{1,3}[0-9][A-Z0-9]{1,4}$")


TRACK_MIN = 20  # outcomes a source needs before its grade is earned rather than proposed


def earned_grade(confirmed, contradicted):
    """A grade from track record (Admiralty: "based on previous reporting"): the share of a source's claims our own
    captures confirmed. None until it has TRACK_MIN outcomes: no track record isn't the same as untrustworthy."""
    n = confirmed + contradicted
    if n < TRACK_MIN:
        return None
    r = confirmed / n
    return "A" if r >= 0.9 else "B" if r >= 0.75 else "C" if r >= 0.5 else "D" if r >= 0.25 else "E"


def carrier_key(name):
    """One name per carrier, whether it came from the FCC's coverage map (brand) or a cell ID's operator."""
    n = re.sub(r"[^a-z]", "", (name or "").lower())
    for key, words in (("att", ("att", "firstnet", "cingular")), ("verizon", ("verizon", "cellco")),
                       ("tmobile", ("tmobile", "sprint", "metropcs")), ("uscellular", ("uscellular",)),
                       ("dish", ("dish", "boost", "echostar"))):
        if any(n.startswith(w) or w in n for w in words):
            return key
    return n or None


def origin(source):
    return ORIGIN.get(source, ("other", "unknown", "unknown"))


def tag(source):
    """The provenance fields stored on a crowd row (ext_point) when it is written."""
    g, m, lic = origin(source)
    return {"origin_group": g, "method": m, "licence": lic, "precision_m": PRECISION_M.get(source)}


def capture_grade(calibrated):
    """A capture's level: A with a calibrated instrument, C without (relative dB only)."""
    return "A" if calibrated == 1 else "C"


def grade(source, claim, calibrated=None):
    if source == "captures":
        return capture_grade(calibrated) if claim == "level" else ("A" if calibrated == 1 else "B")
    return GRADES.get((source, claim), "F")


def age_days(when, now=None):
    """Days since a 'YYYY-MM-DD...' time, or None."""
    if not when:
        return None
    try:
        t = time.mktime(time.strptime(str(when)[:10], "%Y-%m-%d"))
    except ValueError:
        return None
    return max(0, int(((now or time.time()) - t) // 86400))


def stale(source, days):
    return days is not None and days > STALE_DAYS.get(source, 90)


def short_date(when):
    s = str(when or "")[:10]
    return f"{int(s[5:7])}/{int(s[8:10])}" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else ""


def describe(source, label, when):
    """'ULS KXX123 (filing, as of 10/28)' style: what a source said, and when."""
    g, m, _ = origin(source)
    word = {"declared": "filing" if g == "FCC filings" else "listing", "measured": "measured", "derived": "crowd estimate",
            "modelled": "model"}.get(m, m)
    d = short_date(when)
    return f"{label} ({word}{', as of ' + d if d else ''})"


def judge(row, lic=None, fcc_as_of=None, track=None):
    """The claim grade, the source letter, the single-source badge and the one-line why for one review row.
    row: a capture or crowd point (layer, freq_mhz, dbm, ident, ts or last_seen, calibrated, origins).
    lic: the FCC licence it was matched to ({call_sign, est_rx_dbm, ...}) or None."""
    src = row.get("layer")
    origins = set(row.get("origins") or [origin(src)[0]])
    when = row.get("ts") or row.get("last_seen") or row.get("fetched_at")
    parts = [describe(src, "capture" if src == "captures" else (row.get("category") or src), when)]
    diag, support, flags = [], [], []
    if lic:
        origins.add("FCC filings")
        parts.insert(0, describe("uls", f"ULS {lic['call_sign']}", fcc_as_of))
        ident = str(row.get("ident") or "").upper().strip()
        if CALLSIGN.match(ident):
            if ident == lic["call_sign"].upper():
                diag.append("call sign decoded")
            else:
                flags.append(f"decoded ID {ident} isn't the licence's {lic['call_sign']}")
        pred, got = lic.get("est_rx_dbm"), row.get("dbm")
        if pred is not None and got is not None:
            if got > pred + 10:
                flags.append(f"{got:.0f} dBm is louder than the licence allows here (free space {pred:.0f} dBm): "
                             "a closer site, a different transmitter or an unlicensed one")
            elif got >= pred - 40:  # free space is the best case; up to 40 dB of real loss still fits
                support.append(f"level fits the licensed site ({got:.0f} vs {pred:.0f} dBm free space)")
        brg = row.get("bearing")
        if brg is not None and None not in (row.get("lat"), lic.get("lat")):
            want = geo.bearing_deg(row["lat"], row["lon"], lic["lat"], lic["lon"])
            off = abs((brg - want + 180) % 360 - 180)
            if off <= 20:
                support.append(f"bearing {brg:.0f}° points at the licensed site ({want:.0f}°)")
            else:
                flags.append(f"bearing {brg:.0f}° is {off:.0f}° off the licensed site ({want:.0f}°)")
        if len(support) == 2:  # level and bearing together fit the predicted path (research rule 3)
            diag.append(" and ".join(support))
            support = []
    measured = "first-party measured" in origins
    n = len(origins)
    if flags:
        claim = 4
    elif n >= 2 and measured and diag:
        claim = 1
    elif n >= 2:
        claim = 2
    elif measured:
        claim = 3  # heard by us, nothing else agrees yet
    else:
        claim = 3 if grade(src, "on_air") in "ABC" else 6
    words = CLAIM_WORDS[claim]
    if flags:
        reason = "a check disagrees"
    elif diag:
        reason = "; ".join(diag + support)
    elif n >= 2:
        reason = "; ".join(["frequency and place agree, nothing decoded"] + support)
    else:
        reason = "one source only"
    days = age_days(when)
    earned = ((track or {}).get(src) or {}).get("grade")  # a grade its own track record earned wins over the proposal
    return {"claim": claim, "claim_words": words, "source_grade": earned or grade(src, "on_air", row.get("calibrated")),
            "grade_earned": bool(earned),
            "origins": sorted(origins), "single_source": n == 1, "flags": flags,
            "why": " + ".join(parts) + f". {words}: {reason}" + (". " + "; ".join(flags) if flags else "") + ".",
            "age_days": days, "stale": stale(src, days)}


def not_heard(licences, readings, floor_dbm=-110, covered_khz=500, sweep_min=20):
    """Licensed, not heard: licences predicted above the receiver floor at a place we listened, in a band our
    captures swept (at least sweep_min distinct frequencies within covered_khz: a few spot readings don't show we
    listened across a band) on both sides of their frequency, with no reading on it.
    licences: [{call_sign, licensee, freq_mhz, est_rx_dbm, dist_mi}]; readings: [{freq_mhz}] from captures."""
    fs = sorted({round(r["freq_mhz"], 6) for r in readings if r.get("freq_mhz")})
    if not fs:
        return []
    import bisect
    out = []
    for lic in licences:
        f, pred = lic.get("freq_mhz"), lic.get("est_rx_dbm")
        if not f or pred is None or pred < floor_dbm:
            continue
        i = bisect.bisect_left(fs, f - covered_khz / 1000)
        near = fs[i:bisect.bisect_right(fs, f + covered_khz / 1000)]
        if len(near) < sweep_min or not (near[0] < f < near[-1]):
            continue  # nothing shows we swept this band, or the licence sits past the sweep's edge
        if any(abs(x - f) <= 0.00626 for x in near):
            continue  # heard
        out.append(dict(lic, flag="Licensed, not heard",
                        why=f"Predicted {pred:.0f} dBm (free space, best case) and our captures swept "
                            f"{len(near)} frequencies within {covered_khz} kHz, none on "
                            f"{f:.4f} MHz: possibly silent or discontinued, blocked by terrain or buildings, or not keyed "
                            f"while we listened."))
    return out
