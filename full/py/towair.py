"""Does a DAS job's donor mast need FAA notice, and so FCC antenna structure registration? (Cody 11/8: TOWAIR). The
FCC's TOWAIR applies 47 CFR 17.7, which follows the FAA's notice criteria, 14 CFR 77.9:
  (a) more than 200 ft above ground level; or
  (b) above a slope from the nearest point of the nearest runway of a public-use or military airport:
      100:1 within 20,000 ft of an airport with a runway over 3,200 ft,
      50:1 within 10,000 ft of an airport whose runways are all 3,200 ft or less,
      25:1 within 5,000 ft of a heliport's landing area.
The airports and runways are the FAA's own (NASR APT file: APT_BASE, APT_RWY, APT_RWY_END), from the 28-day subscription
faa.py already downloads; the ground elevation is terrain.elevation. Not accounted for, as TOWAIR doesn't either: the
FAA's shielding exception and the traffic-object allowances. The answer says so, and links the FCC's TOWAIR and the
FAA's Notice Criteria Tool for the official word.
"""
import csv
import io
import math
import os
import zipfile

FT = 3.28084
TOWAIR = "https://wireless2.fcc.gov/UlsApp/AsrSearch/towairSearch.jsp"
FAA_TOOL = "https://oeaaa.faa.gov/oeaaa/external/gisTools/gisAction.do?action=showNoNoticeRequiredToolForm"
MILITARY = {"MA", "MN", "MR", "CG"}  # ownership codes: Air Force, Navy, Army, Coast Guard
AIRPORT_TYPES = {"A", "C", "G"}  # airport, seaplane base, gliderport (a heliport, H, has its own slope)
SCHEMA = """
CREATE TABLE IF NOT EXISTS faa_airport(site TEXT PRIMARY KEY, ident TEXT, name TEXT, type TEXT, use TEXT, own TEXT, lat REAL,
    lon REAL, elev_ft REAL, status TEXT, city TEXT, state TEXT, longest_ft REAL);
CREATE INDEX IF NOT EXISTS faa_airport_latlon ON faa_airport(lat, lon);
CREATE TABLE IF NOT EXISTS faa_runway(site TEXT, rwy TEXT, len_ft REAL, lat1 REAL, lon1 REAL, elev1_ft REAL, lat2 REAL, lon2 REAL,
    elev2_ft REAL);
CREATE INDEX IF NOT EXISTS faa_runway_site ON faa_runway(site);
"""


def _num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _rows(z, member):
    with z.open(member) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="latin-1"))


def load(con, zip_path):
    """The FAA's airports and runways from an APT_CSV zip into faa_airport and faa_runway (replaced). Returns counts."""
    with zipfile.ZipFile(zip_path) as z:
        airports = {}
        for r in _rows(z, "APT_BASE.csv"):
            site = (r.get("SITE_NO") or "").strip()
            lat, lon = _num(r.get("LAT_DECIMAL")), _num(r.get("LONG_DECIMAL"))
            if site and lat is not None and lon is not None:
                airports[site] = [site, r.get("ARPT_ID", "").strip(), r.get("ARPT_NAME", "").strip(), r.get("SITE_TYPE_CODE", "").strip(),
                                  r.get("FACILITY_USE_CODE", "").strip(), r.get("OWNERSHIP_TYPE_CODE", "").strip(), lat, lon,
                                  _num(r.get("ELEV")), r.get("ARPT_STATUS", "").strip(), r.get("CITY", "").strip(), r.get("STATE_CODE", "").strip(), 0.0]
        lengths = {}
        for r in _rows(z, "APT_RWY.csv"):
            lengths[(r.get("SITE_NO", "").strip(), r.get("RWY_ID", "").strip())] = _num(r.get("RWY_LEN")) or 0.0
        ends = {}
        for r in _rows(z, "APT_RWY_END.csv"):
            k = (r.get("SITE_NO", "").strip(), r.get("RWY_ID", "").strip())
            lat, lon = _num(r.get("LAT_DECIMAL")), _num(r.get("LONG_DECIMAL"))
            if lat is not None and lon is not None:
                ends.setdefault(k, []).append((lat, lon, _num(r.get("RWY_END_ELEV"))))
    runways = []
    for (site, rwy), length in lengths.items():
        if site in airports:
            airports[site][12] = max(airports[site][12], length)
        e = ends.get((site, rwy)) or []
        if len(e) >= 2 and site in airports:
            (a1, o1, h1), (a2, o2, h2) = e[0], e[1]
            runways.append((site, rwy, length, a1, o1, h1, a2, o2, h2))
    con.executescript(SCHEMA)
    con.execute("DELETE FROM faa_airport")
    con.execute("DELETE FROM faa_runway")
    con.executemany("INSERT INTO faa_airport VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [tuple(a) for a in airports.values()])
    con.executemany("INSERT INTO faa_runway VALUES(?,?,?,?,?,?,?,?,?)", runways)
    con.commit()
    return {"airports": len(airports), "runways": len(runways)}


def _xy(lat0, lat, lon):
    """Feet east and north of the point, on a flat local plane (good to a few feet within 4 miles)."""
    return (lon * 364000 * math.cos(math.radians(lat0)), lat * 364000)


def _to_segment_ft(lat, lon, a, b):
    px, py = _xy(lat, lat, lon)
    ax, ay = _xy(lat, a[0], a[1])
    bx, by = _xy(lat, b[0], b[1])
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t


def check(con, lat, lon, ground_m, agl_m):
    """{"notice": bool, "reasons": [...], "airports": [the public-use and military airports near enough to count, with the
    distance, the limit there and the top of the structure], "top_ft", "agl_ft", "ground_ft", "rule", "towair", "faa_tool",
    "caveat"}. agl_m: the top of the mast above the ground (building plus mast)."""
    agl_ft, ground_ft = agl_m * FT, ground_m * FT
    top_ft = ground_ft + agl_ft
    reasons, near = [], []
    if agl_ft > 200:
        reasons.append(f"It's {agl_ft:,.0f} ft above ground, over 200 ft (14 CFR 77.9(a)).")
    box = 20000 / 364000
    try:
        rows = con.execute("SELECT site, ident, name, type, use, own, lat, lon, elev_ft, longest_ft FROM faa_airport WHERE status = 'O' "
                           "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                           (lat - box, lat + box, lon - box / max(0.2, math.cos(math.radians(lat))), lon + box / max(0.2, math.cos(math.radians(lat))))).fetchall()
    except Exception:
        rows = []
    for site, ident, name, kind, use, own, alat, alon, aelev, longest in rows:
        if use != "PU" and own not in MILITARY:
            continue  # 77.9(b) counts public-use and military airports
        if kind == "H":
            d = _to_segment_ft(lat, lon, (alat, alon), (alat, alon))[0]
            radius, slope, base, what = 5000, 25, aelev, "heliport"
        elif kind in AIRPORT_TYPES:
            best = None
            for _, rwy, length, a1, o1, h1, a2, o2, h2 in con.execute("SELECT * FROM faa_runway WHERE site = ?", (site,)):
                dd, t = _to_segment_ft(lat, lon, (a1, o1), (a2, o2))
                elev = (h1 if t < 0.5 else h2) if (h1 is not None and h2 is not None) else (h1 if h1 is not None else h2)
                if best is None or dd < best[0]:
                    best = (dd, elev, rwy)
            d, base = (best[0], best[1] if best[1] is not None else aelev) if best else (_to_segment_ft(lat, lon, (alat, alon), (alat, alon))[0], aelev)
            radius, slope = (20000, 100) if (longest or 0) > 3200 else (10000, 50)
            what = f"runway {best[2]}" if best else "airport"
        else:
            continue
        if d > radius or base is None:
            continue
        limit = base + d / slope
        over = top_ft > limit
        near.append({"ident": ident, "name": name, "kind": "heliport" if kind == "H" else "airport", "what": what, "distance_ft": round(d),
                     "slope": f"{slope}:1", "limit_ft": round(limit), "top_ft": round(top_ft), "over": over})
        if over:
            reasons.append(f"Its top, {top_ft:,.0f} ft above sea level, is above the {slope}:1 slope from {ident} {name} ({what}, "
                           f"{d:,.0f} ft away): the limit there is {limit:,.0f} ft (14 CFR 77.9(b)).")
    near.sort(key=lambda x: x["distance_ft"])
    return {"notice": bool(reasons), "reasons": reasons, "airports": near, "top_ft": round(top_ft), "agl_ft": round(agl_ft),
            "ground_ft": round(ground_ft), "rule": "47 CFR 17.7; 14 CFR 77.9", "towair": TOWAIR, "faa_tool": FAA_TOOL,
            "caveat": "Doesn't apply the FAA's shielding exception; the FCC's TOWAIR and the FAA's Notice Criteria Tool give the official answer."}


def zip_path(data_dir):
    p = os.path.join(data_dir, "faa", "APT.zip")
    return p if os.path.exists(p) else None
