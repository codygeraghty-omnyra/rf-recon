"""
A first guess at who signs off an ERCES at a job's address: the fire department(s) covering it, from the USFA
National Fire Department Registry, matched by the Census place and county the building is in (R3 #5 and idea C).

The registry (apps.usfa.fema.gov/registry): 27,117 departments with HQ and mailing address, phone, website, county,
type and station count, plus 8,092 station addresses; no coordinates, so a department is placed at its ZIP's centre
(Census ZCTA centroids, the ones the DAS prospect lists already keep). Terms, read 2026-11-04 on the provider's pages:
the registry page says "the general public can use the data for similar purposes" (studies and direct communication
with fire departments); FEMA's Website Information page: "Most material on FEMA.gov is free of copyright and may be
copied and distributed without permission" (US government work). The registry stopped taking updates in June 2026:
its records are as of then. The current list is NERIS (neris.fsri.org/departments): public to browse, but its terms forbid
automated retrieval and commercial reproduction without UL's written consent (read 2026-11-04), so DAStastic only links to it.

Which place and county the building is in: the Census Bureau's TIGERweb (public domain), one small point query per
job, kept. In most places the fire marshal is the ERCES AHJ (IFC 510's fire code official): the registry names fire
departments, not fire marshal offices, so a suggestion is a lead to confirm, never an answer.
"""
import csv
import io
import json
import math
import os
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import uuid

UA = "RF-Recon/2.0 (DAS AHJ lookup)"
SOURCE = {
    "name": "USFA National Fire Department Registry",
    "national": "https://apps.usfa.fema.gov/registry/api/download/national",
    "station": "https://apps.usfa.fema.gov/registry/api/download/station",
    "page": "https://apps.usfa.fema.gov/registry/download",
    "license": "US government work (FEMA / USFA): the registry says the general public can use the data; FEMA: free "
               "of copyright, may be copied and distributed (read 2026-11-04). Self-reported by departments; no "
               "updates after June 2026.",
    "attribution": "U.S. Fire Administration, National Fire Department Registry (records added or changed before June 2026)",
}
TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/{}/query"
TIGER_LAYERS = {"county": 82, "place": 28, "cdp": 30}
TRIBAL_LAYERS = (36, 38)  # Federal American Indian Reservations, Off-Reservation Trust Lands
TIGER_SOURCE = "U.S. Census Bureau TIGERweb (current boundaries)"
LOCAL = ("Local", "Contract")  # the organisation types that serve the public at large
COUNTIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference", "census_counties_2020.txt")

SCHEMA = """
CREATE TABLE IF NOT EXISTS dept(id TEXT PRIMARY KEY, fdid TEXT, name TEXT, hq_addr TEXT, hq_city TEXT, state TEXT, hq_zip TEXT,
    mail_addr TEXT, mail_city TEXT, mail_state TEXT, mail_zip TEXT, phone TEXT, fax TEXT, county TEXT, dept_type TEXT,
    org_type TEXT, website TEXT, stations INTEGER, career INTEGER, volunteer INTEGER, em_primary TEXT);
CREATE INDEX IF NOT EXISTS dept_state ON dept(state);
CREATE TABLE IF NOT EXISTS station(dept_id TEXT, name TEXT, addr TEXT, city TEXT, state TEXT, zip TEXT);
CREATE INDEX IF NOT EXISTS station_dept ON station(dept_id);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""


def db_path(data_dir):
    return os.path.join(data_dir, "fire_depts.db")


def _key(state, fdid, name):
    return f"{(state or '').upper()}|{(fdid or '').strip()}|{_norm(name)}"


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _int(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return 0


def _fetch(url, ua=UA, timeout=120):
    if not url.lower().startswith("https://"):
        raise ValueError(f"https only: {url}")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=timeout) as r:
        return r.read()


def _rows(data):
    """A registry CSV as dicts keyed by lower-case header names (its headers vary in case between the two files)."""
    text = data.decode("utf-8-sig", errors="replace") if isinstance(data, bytes) else data
    rd = csv.reader(io.StringIO(text))
    head = [h.strip().lower() for h in next(rd, [])]
    for r in rd:
        if r and any(x.strip() for x in r):
            yield {h: (r[i].strip() if i < len(r) else "") for i, h in enumerate(head)}


def refresh(data_dir, fetch=None, log=print):
    """Download both registry files (about 12 MB) and replace the kept copy. A file that reads no departments raises
    and leaves the last copy as it was."""
    fetch = fetch or _fetch
    depts, stations = [], []
    for r in _rows(fetch(SOURCE["national"])):
        name = r.get("fire dept name")
        if not name:
            continue
        st = r.get("hq state", "").upper()
        depts.append((_key(st, r.get("fdid"), name), r.get("fdid", ""), name,
                      ", ".join(x for x in (r.get("hq addr1"), r.get("hq addr2")) if x), r.get("hq city", ""), st, r.get("hq zip", ""),
                      ", ".join(x for x in (r.get("mail addr1"), r.get("mail addr2"), ("PO Box " + r["mail po box"]) if r.get("mail po box") else "") if x),
                      r.get("mail city", ""), r.get("mail state", "").upper(), r.get("mail zip", ""), r.get("hq phone", ""), r.get("hq fax", ""),
                      r.get("county", ""), r.get("dept type", ""), r.get("organization type", ""), r.get("website", ""),
                      _int(r.get("number of stations")), _int(r.get("active firefighters - career")), _int(r.get("active firefighters - volunteer")),
                      r.get("primary agency for emergency mgmt", "")))
    if len(depts) < 1000:
        raise ValueError(f"The registry file had {len(depts)} departments; kept the last copy.")
    try:
        for r in _rows(fetch(SOURCE["station"])):
            st = r.get("hq state", "").upper()
            if r.get("fire dept name"):
                stations.append((_key(st, r.get("fdid"), r["fire dept name"]), r.get("station name", ""),
                                 ", ".join(x for x in (r.get("station addr1"), r.get("station addr2")) if x), r.get("station city", ""),
                                 (r.get("station state") or st).upper(), r.get("station zip", "")))
    except (OSError, ValueError) as e:
        log(f"USFA stations not read ({e}); departments kept")
    os.makedirs(data_dir, exist_ok=True)
    tmp = db_path(data_dir) + ".new"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    try:
        con.executescript(SCHEMA)
        con.executemany("INSERT OR REPLACE INTO dept VALUES(" + ",".join("?" * 21) + ")", depts)
        con.executemany("INSERT INTO station VALUES(?,?,?,?,?,?)", stations)
        con.execute("INSERT OR REPLACE INTO meta VALUES('fetched', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
        con.commit()
    finally:
        con.close()
    os.replace(tmp, db_path(data_dir))
    log(f"USFA registry: {len(depts):,} departments, {len(stations):,} stations")
    return {"departments": len(depts), "stations": len(stations)}


def status(data_dir):
    p = db_path(data_dir)
    if not os.path.exists(p):
        return {"have": False}
    con = sqlite3.connect(p)
    try:
        return {"have": True, "fetched": (con.execute("SELECT v FROM meta WHERE k='fetched'").fetchone() or [None])[0],
                "departments": con.execute("SELECT COUNT(*) FROM dept").fetchone()[0]}
    except sqlite3.Error:
        return {"have": False}
    finally:
        con.close()


# ---------------------------------------------------------------- where the building is (Census)

_FIPS = None


def fips_state(fp):
    global _FIPS
    if _FIPS is None:
        _FIPS = {}
        try:
            with open(COUNTIES_FILE, encoding="utf-8") as fh:
                for line in fh:
                    p = line.split("|")
                    if len(p) > 2 and p[1].isdigit():
                        _FIPS[p[1]] = p[0]
        except OSError:
            pass
    return _FIPS.get(str(fp or "").zfill(2))


def _place_cache(data_dir):
    return os.path.join(data_dir, "ahj_places.json")


def place_of(lat, lon, data_dir, fetch=None):
    """{"state", "county", "county_base", "place", "place_base", "cdp", "source"} for a point, from TIGERweb, kept on
    disk (boundaries rarely move). None when TIGERweb can't be reached and nothing is kept."""
    key = f"{lat:.4f},{lon:.4f}"
    try:
        with open(_place_cache(data_dir), encoding="utf-8") as fh:
            kept = json.load(fh)
    except (OSError, ValueError):
        kept = {}
    if key in kept:
        return kept[key]
    fetch = fetch or (lambda url: json.loads(_fetch(url, timeout=20)))
    out = {"source": TIGER_SOURCE}
    try:
        for what, layer in TIGER_LAYERS.items():
            q = urllib.parse.urlencode({"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
                                        "spatialRel": "esriSpatialRelIntersects", "outFields": "NAME,BASENAME,STATE,LSADC",
                                        "returnGeometry": "false", "f": "json"})
            feats = (fetch(TIGER.format(layer) + "?" + q) or {}).get("features") or []
            if feats:
                a = feats[0].get("attributes") or {}
                out[what], out[what + "_base"] = a.get("NAME"), a.get("BASENAME")
                out["state"] = out.get("state") or fips_state(a.get("STATE"))
                if what == "county":
                    out["county_lsad"] = a.get("LSADC")
        for layer in TRIBAL_LAYERS:  # local code may not apply on tribal land: a person finds the right office
            q = urllib.parse.urlencode({"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
                                        "spatialRel": "esriSpatialRelIntersects", "outFields": "NAME", "returnGeometry": "false", "f": "json"})
            feats = (fetch(TIGER.format(layer) + "?" + q) or {}).get("features") or []
            if feats:
                out["tribal"] = (feats[0].get("attributes") or {}).get("NAME") or "tribal land"
                break
    except (OSError, ValueError):
        return None  # offline: the typed address is the fallback
    if not out.get("state"):
        return None
    kept[key] = out
    try:
        tmp = _place_cache(data_dir) + ".part"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(kept, fh)
        os.replace(tmp, _place_cache(data_dir))
    except OSError:
        pass  # a read-only copy still answers, it just asks again next time
    return out


CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
CENSUS_BATCH = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"


def _titled(s):
    return re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m.group(1) + m.group(2).lower(), (s or "").title())


def census_address(q, fetch=None):
    """A street address from the Census Bureau's geocoder (public domain, no key): the fallback when Photon, a free public
    service, is slow (11/5: 5-8 s where it had taken under one, past its 4 s limit, and every address box went empty).
    A list of results, [] when it knows no such address, None when it can't be reached."""
    url = CENSUS_GEOCODER + "?" + urllib.parse.urlencode({"address": q, "benchmark": "Public_AR_Current", "format": "json"})
    try:
        d = (fetch or (lambda u: json.loads(_fetch(u, timeout=6))))(url)
    except (OSError, ValueError):
        return None
    out = []
    for m in ((d or {}).get("result") or {}).get("addressMatches") or []:
        c, parts = m.get("coordinates") or {}, [x.strip() for x in (m.get("matchedAddress") or "").split(",")]
        if c.get("x") is None or c.get("y") is None or len(parts) != 4:
            continue
        full = f"{_titled(parts[0])}, {_titled(parts[1])}, {parts[2]} {parts[3]}"
        out.append({"label": full, "sub": "U.S. Census address", "full": full, "lat": round(c["y"], 6), "lon": round(c["x"], 6), "kind": "address", "source": "census"})
    return out


def census_batch(q, states, send=None):
    """One line asked of every state in a single request, for a house number and street with no state on them: the geocoder's own batch door,
    so a person pausing over "90 Main" isn't fifty requests. It took 6 s for 51 lines (11/6), which is why it waits for a pause. The same
    list as census_address, [] when no state has it, None when it can't be reached."""
    street, _, city = (x.strip() for x in str(q or "").partition(","))
    rows = io.StringIO()
    csv.writer(rows, lineterminator="\n").writerows([i, street, city, st, ""] for i, st in enumerate(states))
    edge = uuid.uuid4().hex
    body = (f'--{edge}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\nPublic_AR_Current\r\n--{edge}\r\n'
            f'Content-Disposition: form-data; name="addressFile"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n{rows.getvalue()}\r\n--{edge}--\r\n').encode("utf-8")
    try:
        if send:
            raw = send(body)
        else:
            req = urllib.request.Request(CENSUS_BATCH, data=body, headers={"Content-Type": f"multipart/form-data; boundary={edge}", "User-Agent": "RF-Recon/2.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        return None
    out = []
    for r in csv.reader(io.StringIO(raw)):  # id, input, Match, Exact or Non_Exact, address, "lon,lat", ...
        if len(r) < 6 or r[2] != "Match":
            continue
        parts, ll = [x.strip() for x in r[4].split(",")], r[5].split(",")
        if len(parts) != 4 or len(ll) != 2:
            continue
        try:
            lon, lat = float(ll[0]), float(ll[1])
        except ValueError:
            continue
        full = f"{_titled(parts[0])}, {_titled(parts[1])}, {parts[2]} {parts[3]}"
        out.append({"label": full, "sub": "U.S. Census address", "full": full, "lat": round(lat, 6), "lon": round(lon, 6), "kind": "address", "source": "census"})
    return out


def parse_address(addr):
    """City, state and ZIP from a typed address ("1 Main St, Arlington, VA 22201"), as a fallback."""
    m = re.search(r",\s*([^,]+?)\s*,?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$", addr or "")
    if m:
        return {"city": m.group(1), "state": m.group(2), "zip": m.group(3)}
    m = re.search(r",\s*([^,]+?)\s*,\s*([A-Z]{2})\s*$", addr or "")
    return {"city": m.group(1), "state": m.group(2), "zip": ""} if m else {}


# ---------------------------------------------------------------- the suggestion

def _zcta(data_dir):
    """ZIP -> (lat, lon), from the Census ZCTA centroids the prospect lists keep (prospects.db)."""
    p = os.path.join(data_dir, "prospects.db")
    if not os.path.exists(p):
        return {}
    con = sqlite3.connect(p, timeout=30)
    try:
        return {k: (a, b) for k, a, b in con.execute("SELECT key, lat, lon FROM prospect_geo WHERE kind='zcta'")}
    except sqlite3.Error:
        return {}
    finally:
        con.close()


def _hav_mi(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(h)))


def _strip(s):
    return re.sub(r"\b(county|city|town|township|village|borough|parish|of)\b", " ", _norm(s)).split()


def lookup(data_dir, lat, lon, address="", fetch=None, limit=6):
    """The departments most likely to cover a point, best first, each with why. Raises LookupError when the registry
    isn't kept on this copy yet."""
    if not status(data_dir).get("have"):
        raise LookupError("The USFA fire department list isn't on this copy yet.")
    where = place_of(lat, lon, data_dir, fetch)
    typed = parse_address(address)
    state = (where or {}).get("state") or typed.get("state")
    zc = _zcta(data_dir)
    con = sqlite3.connect(db_path(data_dir))
    con.row_factory = sqlite3.Row
    try:
        meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
        if state:
            rows = con.execute("SELECT * FROM dept WHERE state=?", (state,)).fetchall()
        else:
            rows = con.execute("SELECT * FROM dept").fetchall()
        st = {}
        ids = [r["id"] for r in rows]
        for i in range(0, len(ids), 900):
            part = ids[i:i + 900]
            for s in con.execute(f"SELECT * FROM station WHERE dept_id IN ({','.join('?' * len(part))})", part):
                st.setdefault(s["dept_id"], []).append(dict(s))
    finally:
        con.close()
    county = (where or {}).get("county_base") or ""
    indep = (where or {}).get("county_lsad") == "25"  # an independent city (Virginia, Baltimore, St. Louis, Carson City)
    place = ((where or {}).get("place_base") or (where or {}).get("county_base")) if indep else (where or {}).get("place_base")
    city = place or ("" if where else typed.get("city") or "")  # Census found no incorporated place: the county governs, not the postal town
    c_words, p_words = _strip(county), _strip(city)
    out = []
    for r in rows:
        why, score = [], 0.0
        local = (r["org_type"] or "").startswith(LOCAL)
        dname = _norm(r["name"])
        dc = _strip(r["county"])
        named = bool(p_words) and all(w in dname.split() for w in p_words)  # an HQ in the city isn't the city's own: a county's sits there too (11/5, Wilmington)
        if city and (_norm(r["hq_city"]) == _norm(city) or named):
            if place:
                score += 50 if named else 20
                why.append(f"{'named for' if named else 'HQ in'} {city}: the building is inside {where.get('place') or city} ({TIGER_SOURCE})")
            else:
                score += 20
                why.append(f"HQ in {city} (from the job's address; the building may be outside city limits)")
        if county and dc and dc == c_words:
            score += 25
            why.append(f"in {where.get('county') or county}")
            own = _norm(re.sub(r"\([^)]*\)", " ", r["name"] or ""))  # "Rockville Volunteer FD (Montgomery County Fire Department)" is a company, not the county's
            if c_words and all(w in own.split() for w in c_words) and re.search(r"\bcounty\b", own):
                score += 25 if not place else 10
                why.append("the county's own department" + ("; the building is outside any incorporated city" if not place and where else ""))
        part = re.search(r"\(([^)]*\b(fire|rescue|county)\b[^)]*)\)", r["name"] or "", re.I)
        if part:
            score -= 30
            why.append(f"listed as part of {part.group(1)}: the system's own office usually signs off")
        dist = None
        zips = [r["hq_zip"]] + [s["zip"] for s in st.get(r["id"], [])]
        for z in zips:
            ll = zc.get((z or "")[:5])
            if ll:
                m = _hav_mi(lat, lon, ll[0], ll[1])
                dist = m if dist is None else min(dist, m)
        if dist is not None:
            score += max(0.0, 20 - 2 * dist)
            if dist <= 10:
                why.append(f"{'a station or HQ' if st.get(r['id']) else 'HQ'} about {dist:.1f} mi away (ZIP centre)")
        if not why:
            continue
        if not local:
            score -= 40
            why.append(f"{r['org_type'] or 'not a local department'}: usually covers only its own property")
        if (r["dept_type"] or "").lower() in ("career", "mostly career"):
            score += 5
        score += min(5, (r["stations"] or 0) / 2)
        out.append({"id": r["id"], "fdid": r["fdid"], "name": r["name"], "hq": ", ".join(x for x in (r["hq_addr"], r["hq_city"], f"{r['state']} {r['hq_zip']}".strip()) if x),
                    "mail": ", ".join(x for x in (r["mail_addr"], r["mail_city"], f"{r['mail_state']} {r['mail_zip']}".strip()) if x),
                    "phone": "" if set(re.sub(r"\D", "", r["phone"] or "")) <= {"0"} else r["phone"], "website": r["website"],
                    "county": r["county"], "dept_type": r["dept_type"], "org_type": r["org_type"], "stations": r["stations"],
                    "local": local, "dist_mi": round(dist, 1) if dist is not None else None, "score": round(score, 1), "why": why})
    out.sort(key=lambda x: -x["score"])
    out = [x for x in out if x["score"] > 0][:limit]
    return {"where": where, "typed": typed, "suggestions": out,
            "registry": {"name": SOURCE["name"], "url": SOURCE["page"], "fetched": meta.get("fetched"), "as_of": "records added or changed before June 2026",
                         "license": SOURCE["license"]},
            "note": "The fire marshal (the fire code official) usually signs off an ERCES; the registry lists fire departments, "
                    "not fire marshal offices. Confirm with the department's fire prevention or fire marshal office. The registry "
                    "stopped taking updates in June 2026 (USFA's notice); a department's current listing is at "
                    "neris.fsri.org/departments (look it up there by hand: its terms forbid automated copying).",
            "current_list": "https://neris.fsri.org/departments"}
