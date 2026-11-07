"""
The USACE National Structure Inventory (NSI) for one building (R3 #1, 2026-11-04 DAS data sources): occupancy class,
stories, square feet, foundation (B = a basement), year built, height where lidar has it, and the people inside by
day and by night. A small box around the job's point is asked for, never an area in bulk (a 15-mile radius is about
1.1 M rows). The NSI is a US government work (17 USC 105) whose public version is "releasable to the general public";
its FAQ says it is "not intended for legal or regulatory determinations", and stories and square feet are modelled, so
every figure is shown as an estimate with its source. Standard library only.
"""
import json
import math
import time
import urllib.request

import das
import geo

API = "https://nsi.sec.usace.army.mil/nsiapi/structures"
SOURCE = "USACE National Structure Inventory (NSI)"
LICENSE = "US government work (17 USC 105); the public NSI is releasable to the general public (NSI FAQ, 2022)"
CAVEAT = "Modelled estimates: not for legal or regulatory determinations (NSI FAQ)."
UA = "RF-Recon/2.0 (DAS job: one building's NSI record)"
BOX_M = 60          # half the side of the box asked for, metres
MAX_BYTES = 4 << 20
TIMEOUT_S = 20
# HAZUS occupancy classes (the NSI's occtype, before any "-" suffix)
OCC = {"RES1": "Single-family house", "RES2": "Manufactured housing", "RES3": "Multi-family housing",
       "RES4": "Hotel or motel (temporary lodging)", "RES5": "Dormitory or institutional housing", "RES6": "Nursing home",
       "COM1": "Retail", "COM2": "Wholesale trade", "COM3": "Personal and repair services", "COM4": "Offices (business services)",
       "COM5": "Bank", "COM6": "Hospital", "COM7": "Medical office or clinic", "COM8": "Entertainment and recreation",
       "COM9": "Theater", "COM10": "Parking garage", "IND1": "Heavy industry", "IND2": "Light industry",
       "IND3": "Food, drugs and chemicals", "IND4": "Metals and minerals processing", "IND5": "High technology",
       "IND6": "Construction", "AGR1": "Agriculture", "REL1": "Church or membership organisation",
       "GOV1": "Government, general services", "GOV2": "Government, emergency response", "EDU1": "School or library",
       "EDU2": "College or university"}
FOUND = {"B": "basement", "C": "crawlspace", "S": "slab", "P": "pier", "I": "pile", "F": "fill", "W": "solid wall"}


def _box(lat, lon, half_m=BOX_M):
    """The NSI API's bbox is a closed ring of lon,lat pairs (checked 2026-11-04: a 4-number box returns nothing)."""
    dlat = half_m / 111320.0
    dlon = half_m / (111320.0 * max(0.01, math.cos(math.radians(lat))))
    w, e, s, n = lon - dlon, lon + dlon, lat - dlat, lat + dlat
    return ",".join(f"{x:.6f}" for x in (w, s, e, s, e, n, w, n, w, s))


def query_url(lat, lon, half_m=BOX_M):
    return f"{API}?bbox={_box(lat, lon, half_m)}"


def fetch(url):
    """The NSI's answer: the address is checked like any the server fetches (das._public_url, redirects included)."""
    das._public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.build_opener(das._NoRedirect).open(req, timeout=TIMEOUT_S) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("The NSI answer was larger than one building's should be.")
    return data


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v > -9000 else None  # -9999 marks "none" in the NSI


def _occ(code):
    base = (code or "").split("-")[0].upper()
    base = "RES3" if base.startswith("RES3") else base
    return base, OCC.get(base, code or "unknown")


def pick(features, lat, lon, outline=None):
    """The NSI rows for the building: those inside the job's outline when it has one (the largest footprint there),
    else the footprint nearest the point. One NSI row per occupancy, so a footprint's rows are added up."""
    groups = {}
    for f in features or []:
        p = f.get("properties") or {}
        try:
            lo, la = (f.get("geometry") or {}).get("coordinates")[:2]
        except (TypeError, ValueError):
            lo, la = p.get("x"), p.get("y")
        if la is None or lo is None:
            continue
        key = p.get("ftprntid") or f"fd:{p.get('fd_id')}"
        g = groups.setdefault(key, {"rows": [], "dist": 1e9, "inside": False})
        g["rows"].append(p)
        g["dist"] = min(g["dist"], geo.haversine_km(lat, lon, la, lo) * 1000)
        if outline and das._inside(la, lo, [tuple(x) for x in outline]):
            g["inside"] = True
    if not groups:
        raise LookupError("The NSI lists no structure within about 60 m of this location.")
    inside = [g for g in groups.values() if g["inside"]]
    size = lambda g: sum(_num(r.get("sqft")) or 0 for r in g["rows"])
    key, g = (max(((k, x) for k, x in groups.items() if x["inside"]), key=lambda kx: size(kx[1])) if inside
              else min(groups.items(), key=lambda kx: kx[1]["dist"]))
    rows = g["rows"]
    occ = {}
    for r in rows:
        code, label = _occ(r.get("occtype"))
        o = occ.setdefault(code, {"code": code, "label": label, "sqft": 0.0, "detail": r.get("occtype")})
        o["sqft"] += _num(r.get("sqft")) or 0
    occ = sorted(occ.values(), key=lambda o: -o["sqft"])
    for o in occ:
        o["sqft"] = round(o["sqft"])
    years = [y for y in (_num(r.get("med_yr_blt")) for r in rows) if y and y > 1600]
    stories = [s for s in (_num(r.get("num_story")) for r in rows) if s]
    heights = [h for h in (_num(r.get("bldheight")) for r in rows) if h]
    found = {r.get("found_type") for r in rows if r.get("found_type")}
    total = lambda *ks: round(sum(_num(r.get(k)) or 0 for r in rows for k in ks))
    fp = next((_num(r.get("ftprntsqft")) for r in rows if _num(r.get("ftprntsqft"))), None)
    return {"source": SOURCE, "license": LICENSE, "caveat": CAVEAT, "api": API, "fetched": time.strftime("%Y-%m-%d %H:%M"),
            "footprint_id": key if not key.startswith("fd:") else None, "rows": len(rows),
            "occupancy": occ, "occupancy_label": occ[0]["label"] if occ else None,
            "stories": int(max(stories)) if stories else None, "sqft": round(sum(_num(r.get("sqft")) or 0 for r in rows)) or None,
            "footprint_sqft": round(fp) if fp else None, "basement": "B" in found,
            "foundation": ", ".join(FOUND.get(x, x) for x in sorted(found)) or None,
            "year_built": int(min(years)) if years else None, "height_m": round(max(heights), 1) if heights else None,
            "people_day": total("pop2pmu65", "pop2pmo65"), "people_night": total("pop2amu65", "pop2amo65"),
            "inside_outline": g["inside"], "dist_m": round(g["dist"]), "others_nearby": len(groups) - 1}


def lookup(lat, lon, outline=None, get=fetch):
    """One building's NSI estimate at (lat, lon). get(url) -> bytes (tests pass a fixture)."""
    lat, lon = float(lat), float(lon)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("That isn't a location.")
    try:
        raw = get(query_url(lat, lon))
    except OSError as e:  # offline, a timeout, or the NSI refusing (urllib's errors are OSErrors)
        raise ValueError(f"The NSI didn't answer ({getattr(e, 'reason', None) or e}). Try again later.") from None
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ValueError(f"The NSI answered with something that isn't GeoJSON: {e}") from None
    return pick(data.get("features") if isinstance(data, dict) else None, lat, lon, outline)
