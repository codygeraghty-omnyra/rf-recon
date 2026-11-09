"""Strong broadcast at a DAS job's building, from the FCC's Contours API (Cody 11/8; he accepted the FCC's API terms for
DAStastic himself that day). An FM or TV station strong at the building can overload a BDA's input or mix into its
passband, so a job asks, when pressed, which nearby stations' strong contours cover the building:
- FM: the 115 dBu contour, the FCC's blanketing contour (47 CFR 73.318: inside it, receivers near the station are
  expected to suffer), and the 100 dBu contour;
- TV: the 100 dBu contour.
Stations are this copy's own broadcast list (broadcast.py: the FCC's AM/FM/TV query lists), FM and TV, licensed, with a
facility ID, within REACH_KM. Each contour comes from https://geo.fcc.gov/api/contours/entity.json by facility ID,
through datadesk.fetchkit (a refusal stops that station and files a Needs a person task), and is kept for KEEP_DAYS:
a station's contour changes only when its licence does. The FCC asks for this line wherever its API data shows:
ATTRIBUTION.
"""
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor

from datadesk import fetchkit, persons

API = "https://geo.fcc.gov/api/contours/entity.json"
UA = "DAStastic data desk (FCC Contours API for DAS jobs; contact via omnyra.ai)"
ATTRIBUTION = "This product uses the FCC Data API but is not endorsed or certified by the FCC."
SOURCE = {"id": "fcc-contours-api", "name": "FCC Contours API", "owner": "Cody",
          "url": "https://geo.fcc.gov/api/contours/", "terms": "https://www.fcc.gov/reports-research/developers/api-terms-service"}
FIELDS = {"FM": (115, 100), "TV": (100,)}  # dBu contours asked per service, strongest first
REACH_KM = {"FM": 15, "TV": 25}  # beyond these, a station's 100 dBu contour can't reach the building
KEEP_DAYS = 30
NRADIAL = 72
SCHEMA = """
CREATE TABLE IF NOT EXISTS bcast_contour(facility_id TEXT, service TEXT, field INTEGER, fetched REAL, call_sign TEXT,
    erp_kw REAL, haat_m REAL, ant_lat REAL, ant_lon REAL, rings TEXT, PRIMARY KEY(facility_id, service, field));
"""


def _km(a, b, c, d):
    p = math.pi / 180
    h = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(min(1, math.sqrt(h)))


def inside(rings, lat, lon):
    """Point in a contour: rings are [[lon, lat], ...] lists (GeoJSON order), even-odd across them."""
    hit = False
    for ring in rings:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-12) + x1:
                hit = not hit
    return hit


def _rings(geometry):
    g = geometry or {}
    if g.get("type") == "Polygon":
        return list(g.get("coordinates") or [])
    if g.get("type") == "MultiPolygon":
        return [ring for poly in g.get("coordinates") or [] for ring in poly]
    return []


def contour(f, facility_id, service, field):
    """One station's contour at one field strength, from the FCC: {"rings", "call_sign", "erp_kw", "haat_m", "ant_lat",
    "ant_lon"} for its licensed (or first) record, or None when the FCC has none."""
    r = f.get(API + "?" + "&".join(f"{k}={v}" for k, v in (("serviceType", service.lower()), ("facilityId", facility_id),
                                                              ("nradial", NRADIAL), ("field", field), ("curve", 0))),
              accept="application/json")
    try:
        doc = json.loads(r.body.decode("utf-8", "replace"))
    except ValueError:
        raise ValueError("the FCC's Contours API didn't answer with JSON") from None
    feats = [x for x in doc.get("features") or [] if (x.get("properties") or {}).get("status") == "success"]
    if not feats:
        return None
    rank = lambda x: ((x.get("properties") or {}).get("service") != service.upper(), (x.get("properties") or {}).get("dom_status") != "LIC")
    best = min(feats, key=rank)  # the station's own licensed facility before an auxiliary (FS) or an application
    p = best["properties"]
    return {"rings": _rings(best.get("geometry")), "call_sign": p.get("callsign"), "erp_kw": p.get("erp"),
            "haat_m": None, "ant_lat": p.get("antenna_lat"), "ant_lon": p.get("antenna_lon")}


def near(con, lat, lon):
    """FM and TV stations near the building that a contour could cover from: [(facility_id, service, call_sign, km)]."""
    reach = max(REACH_KM.values())
    dlat, dlon = reach / 111.0, reach / (111.0 * max(0.2, math.cos(math.radians(lat))))
    try:
        rows = con.execute("SELECT facility_id, band, call_sign, lat, lon, status FROM bcast WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                           (lat - dlat, lat + dlat, lon - dlon, lon + dlon)).fetchall()
    except Exception:
        return []
    out, seen = [], set()
    for fid, band, call, la, lo, status in rows:
        band = (band or "").upper()
        if band not in FIELDS or not fid or la is None or (status or "").lower().startswith(("app", "construction")):
            continue
        km = _km(lat, lon, la, lo)
        if km <= REACH_KM[band] and (fid, band) not in seen:
            seen.add((fid, band))
            out.append((str(fid), band, call, round(km, 1)))
    return sorted(out, key=lambda x: x[3])


def lookup(con, lat, lon, fetcher=None, now=None):
    """{"strong": [{call_sign, service, km, field, blanketing}], "near": n, "asked": n, "kept": n, "refused", "failed",
    "attribution", "at"}: the stations whose strongest contour asked covers the building, strongest field first."""
    con.executescript(SCHEMA)
    persons.ensure(con)
    now = now or time.time()
    f = fetcher or fetchkit.Fetcher(UA, max_bytes=8 * 1024 * 1024, timeout=30)
    stations = near(con, lat, lon)
    res = {"strong": [], "near": len(stations), "asked": 0, "kept": 0, "refused": [], "failed": [], "attribution": ATTRIBUTION,
           "at": time.strftime("%Y-%m-%d %H:%M")}
    want, have = [], {}
    for fid, band, call, km in stations:
        for field in FIELDS[band]:
            r = con.execute("SELECT rings, call_sign, erp_kw, fetched FROM bcast_contour WHERE facility_id=? AND service=? AND field=?",
                            (fid, band, field)).fetchone()
            if r and now - r[3] < KEEP_DAYS * 86400:
                have[(fid, band, field)] = {"rings": json.loads(r[0]) if r[0] else [], "call_sign": r[1], "erp_kw": r[2]}
            else:
                want.append((fid, band, field))
    res["kept"] = len(have)
    if want:
        with ThreadPoolExecutor(max_workers=6) as ex:  # sqlite stays on this thread; only the requests run alongside
            futs = [(k, ex.submit(contour, f, k[0], k[1], k[2])) for k in want]
        refused = None
        for k, fut in futs:
            try:
                c = fut.result()
            except fetchkit.Refused as e:
                refused = refused or e
                continue
            except Exception as e:
                res["failed"].append(f"{k[1]} {k[0]}: {type(e).__name__}: {str(e)[:100]}")
                continue
            res["asked"] += 1
            c = c or {"rings": [], "call_sign": None, "erp_kw": None, "ant_lat": None, "ant_lon": None}
            con.execute("INSERT OR REPLACE INTO bcast_contour VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (k[0], k[1], k[2], now, c["call_sign"], c["erp_kw"], c.get("haat_m"), c.get("ant_lat"), c.get("ant_lon"),
                         json.dumps(c["rings"], separators=(",", ":"))))
            have[k] = c
        con.commit()
        if refused:
            persons.from_refusal(con, SOURCE, refused, "The FCC's Contours API answers a DAS job's strong broadcast check.")
            res["refused"].append(f"{SOURCE['name']} {refused.why}")
    for fid, band, call, km in stations:
        for field in FIELDS[band]:  # strongest first: the first contour that covers the building is its field
            c = have.get((fid, band, field))
            if c and c["rings"] and inside(c["rings"], lat, lon):
                res["strong"].append({"call_sign": c.get("call_sign") or call, "service": band, "km": km, "field_dbu": field,
                                      "erp_kw": c.get("erp_kw"), "blanketing": band == "FM" and field == 115})
                break
    res["strong"].sort(key=lambda x: (-x["field_dbu"], x["km"]))
    return res
