"""
DAS / ERCES jobs: in-building public safety radio work (emergency responder communication enhancement systems,
bi-directional amplifiers, public safety DAS) from lead to annual retest. Jobs and contacts live in the app's
database next to missions and are backed up with them.

The pre-survey answers the first question of every job from the FCC data: which public safety systems serve this
building, on which channels (tower transmit = downlink, radio transmit = uplink), from which sites, and how strong
they are likely to be outside and inside.
"""
import csv
import io
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

import geo
import sigid
import uls_import

now = lambda: time.strftime("%Y-%m-%d %H:%M:%S")

SCHEMA = """
CREATE TABLE IF NOT EXISTS das_job(id INTEGER PRIMARY KEY, name TEXT, stage TEXT, data TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_log(id INTEGER PRIMARY KEY, job_id INTEGER, ts TEXT, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS das_contact(id INTEGER PRIMARY KEY, name TEXT, org TEXT, role TEXT, phone TEXT, email TEXT,
    notes TEXT, updated_at TEXT);
"""
TABLES = ("das_job", "das_log", "das_contact")
STAGES = ["Lead", "Pre-survey", "Design", "Install", "Commission", "Acceptance", "In service", "Closed"]

# Public safety: the FCC's public safety radio services, and licensees the importer classed as public safety
PS_CATEGORIES = {"Public Safety (Gov)", "Public Safety (Other)", "Law Enforcement", "Fire / EMS", "Emergency Mgmt / 911"}
TRUNKED = {"YW", "SY", "YE", "YF", "YP"}
DOWNLINK_CLASSES = ("FB", "FX")  # base and fixed stations: what a building's donor antenna hears
# Fixed duplex plans: tower transmit (downlink) to radio transmit (uplink)
PAIRS = [
    (851.0, 869.0, -45.0, "800 MHz"),   # 806-824 up / 851-869 down (NPSPAC 821-824 / 866-869 included)
    (769.0, 775.0, 30.0, "700 MHz"),    # 799-805 up / 769-775 down, public safety narrowband
]
FIRSTNET = {"band": "FirstNet Band 14", "down": (758.0, 768.0), "up": (788.0, 798.0)}


def band_of(f):
    for lo, hi, off, label in PAIRS:
        if lo <= f <= hi:
            return label
    return uls_import.band_for(f) or "Other"


def presurvey(con, lat, lon, radius_mi=15.0, loss_db=15.0, threshold_dbm=-95.0, cats=None):
    """The public safety systems around a building, with downlink and uplink channels and the strongest sites.
    Levels are free-space estimates from licensed ERP (best case, no terrain); inside = outside - loss_db."""
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    ps = sorted(uls_import.PUBLIC_SAFETY_SERVICES)
    cat_list = sorted(cats or PS_CATEGORIES)
    rows = con.execute(
        f"SELECT * FROM tx WHERE status='A' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND freq_mhz IS NOT NULL "
        f"AND (service IN ({','.join('?' * len(ps))}) OR category IN ({','.join('?' * len(cat_list))})) "
        f"AND (station_class LIKE 'FB%' OR station_class LIKE 'FX%')",
        [s, n, w, e] + ps + cat_list).fetchall()
    systems = {}
    lim = radius_mi * geo.MI_KM
    for r in rows:
        d = geo.haversine_km(lat, lon, r["lat"], r["lon"])
        if d > lim or not 25 <= r["freq_mhz"] <= 1000:  # HF and microwave links (4.9 GHz...) are not what a booster carries
            continue
        b = geo.bearing_deg(lat, lon, r["lat"], r["lon"])
        erp = r["erp_w"] or r["power_out_w"]
        out = geo.fspl_rx_dbm(erp, d, r["freq_mhz"]) if erp else None
        key = r["call_sign"]
        sysd = systems.setdefault(key, {"call_sign": key, "licensee": r["licensee"], "service": r["service"],
                                        "service_name": r["service_name"], "category": r["category"],
                                        "trunked": r["service"] in TRUNKED, "usi": r["usi"],
                                        "tech": set(), "down": {}, "sites": {}})
        sysd["tech"].add(sigid.from_uls_mode(r["mode"]) or "Unknown")
        f = round(r["freq_mhz"], 5)
        ch = sysd["down"].setdefault(f, {"freq": f, "band": band_of(f), "emission": r["emissions"], "bw_khz": r["bandwidth_khz"],
                                         "best_out": None, "site": None})
        if out is not None and (ch["best_out"] is None or out > ch["best_out"]):
            ch["best_out"], ch["site"] = round(out, 1), f"{r['lat']:.5f},{r['lon']:.5f}"
        sk = f"{r['lat']:.5f},{r['lon']:.5f}"
        site = sysd["sites"].setdefault(sk, {"lat": r["lat"], "lon": r["lon"], "dist_mi": round(d / geo.MI_KM, 2), "bearing": round(b),
                                             "compass": geo.compass(b), "tower_reg": r["tower_reg"], "height_m": r["height_tip_m"],
                                             "best_out": None, "freqs": set(), "address": ", ".join(x for x in (r["address"], r["city"]) if x)})
        site["freqs"].add(f)
        if out is not None and (site["best_out"] is None or out > site["best_out"]):
            site["best_out"] = round(out, 1)
    if not systems:
        return {"systems": [], "bands": [], "firstnet": FIRSTNET, "threshold_dbm": threshold_dbm, "loss_db": loss_db}

    # uplink: the radios' transmit frequencies, from each licence's mobile rows (or the fixed 700/800 MHz offsets)
    calls = list(systems)
    mob = {}
    for i in range(0, len(calls), 900):
        ch = calls[i:i + 900]
        for r in con.execute(f"SELECT call_sign, freq_mhz FROM tx WHERE status='A' AND station_class LIKE 'MO%' "
                             f"AND call_sign IN ({','.join('?' * len(ch))})", ch):
            if r["freq_mhz"]:
                mob.setdefault(r["call_sign"], set()).add(round(r["freq_mhz"], 5))
    out_systems, need = [], {}
    for k, sysd in systems.items():
        down = sorted(sysd["down"].values(), key=lambda c: c["freq"])
        downs = {c["freq"] for c in down}
        sites_per = {}
        for x in sysd["sites"].values():
            for f in x["freqs"]:
                sites_per[f] = sites_per.get(f, 0) + 1
        for c in down:
            off = next((o for lo, hi, o, _ in PAIRS if lo <= c["freq"] <= hi), None)
            if off is not None:  # the band plan fixes the pair (90.613 for 800 MHz; +30 MHz at 700 MHz)
                c["up"], c["up_src"] = [round(c["freq"] + off, 5)], "rule"
            else:  # conventional VHF/UHF: the licence's mobile frequencies in the same band; the same one means simplex
                same = {u for u in mob.get(k, set()) - downs if band_of(u) == c["band"]}
                c["up"] = sorted(same) or ([c["freq"]] if c["freq"] in mob.get(k, set()) else [])
                c["up_src"] = "licence" if c["up"] else "ask licensee"
            flags = []
            if 862.0 <= c["freq"] <= 869.0:
                flags.append("ESMR (commercial): keep out of the booster")
            if 758.0 <= c["freq"] <= 768.0:
                flags.append("FirstNet Band 14: needs FirstNet / AT&T authorization")
            if sites_per.get(c["freq"], 0) > 1:
                flags.append(f"simulcast from {sites_per[c['freq']]} sites: delay / TDI risk")
            c["flags"], c["sites_n"] = flags, sites_per.get(c["freq"], 0)
        ups = sorted({u for c in down for u in c.get("up", [])})
        sites = sorted(sysd["sites"].values(), key=lambda x: -(x["best_out"] if x["best_out"] is not None else -1e9))
        for x in sites:
            x["freqs"] = sorted(x["freqs"])
            x["best_in"] = round(x["best_out"] - loss_db, 1) if x["best_out"] is not None else None
        best = sites[0]["best_out"] if sites else None
        inside = round(best - loss_db, 1) if best is not None else None
        for c in down:
            need.setdefault(c["band"], []).append(c["freq"])
            for u in c.get("up", []):
                need.setdefault(band_of(u) if band_of(u) != "Other" else c["band"], []).append(u)
        out_systems.append({
            "call_sign": k, "licensee": sysd["licensee"], "service": sysd["service"], "service_name": sysd["service_name"],
            "category": sysd["category"], "trunked": sysd["trunked"], "usi": sysd["usi"], "tech": sorted(sysd["tech"]),
            "down": down, "up": ups, "sites": sites[:8], "n_sites": len(sites), "best_out": best, "best_in": inside,
            "margin_db": round(inside - threshold_dbm, 1) if inside is not None else None,
            "nearest_mi": min(x["dist_mi"] for x in sites) if sites else None})
    out_systems.sort(key=lambda x: (-(x["best_out"] if x["best_out"] is not None else -1e9)))
    bands = [{"band": b, "lo": min(fs), "hi": max(fs), "channels": len(set(fs))} for b, fs in need.items()]
    bands.sort(key=lambda x: x["lo"])
    return {"systems": out_systems, "bands": bands, "firstnet": FIRSTNET, "threshold_dbm": threshold_dbm, "loss_db": loss_db,
            "radius_mi": radius_mi}


# ---------------------------------------------------------------- the building's outline (OpenStreetMap)

OVERPASS = "https://overpass-api.de/api/interpreter"


def _ring_area_m2(ring):
    la0 = ring[0][0]
    kx, ky = 111320.0 * math.cos(math.radians(la0)), 110540.0
    pts = [((lo - ring[0][1]) * kx, (la - la0) * ky) for la, lo in ring]
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))) / 2


def _inside(lat, lon, ring):
    hit = False
    for (a_la, a_lo), (b_la, b_lo) in zip(ring, ring[1:] + ring[:1]):
        if (a_la > lat) != (b_la > lat) and lon < a_lo + (lat - a_la) * (b_lo - a_lo) / (b_la - a_la):
            hit = not hit
    return hit


def _num(v):
    m = re.match(r"\s*([\d.]+)\s*(ft|')?", str(v or ""))
    if not m:
        return None
    n = float(m.group(1))
    return n * 0.3048 if m.group(2) else n


def pick_building(data, lat, lon):
    """From an Overpass answer, the building the point is in (else the nearest): outline, footprint and levels."""
    best = None
    for el in data.get("elements", []):
        if el["type"] == "way":
            outer, inner = [el.get("geometry") or []], []
        else:
            outer = [m.get("geometry") or [] for m in el.get("members", []) if m.get("role") == "outer"]
            inner = [m.get("geometry") or [] for m in el.get("members", []) if m.get("role") == "inner"]
        outer = [[(p["lat"], p["lon"]) for p in g] for g in outer if len(g) >= 4]
        if not outer:
            continue
        ring = max(outer, key=_ring_area_m2)
        area = sum(_ring_area_m2(r) for r in outer) - sum(_ring_area_m2([(p["lat"], p["lon"]) for p in g]) for g in inner if len(g) >= 4)
        inside = any(_inside(lat, lon, r) for r in outer)
        dist = min(geo.haversine_km(lat, lon, la, lo) for la, lo in ring)
        score = (0 if inside else 1, 0 if inside else dist, -area)
        if best is None or score < best[0]:
            t = el.get("tags", {})
            lv = _num(t.get("building:levels"))
            best = (score, {"source": "OpenStreetMap (ODbL)", "osm": f"{el['type']}/{el['id']}", "name": t.get("name") or
                            " ".join(x for x in (t.get("addr:housenumber"), t.get("addr:street")) if x) or None,
                            "levels": int(lv) if lv else None, "levels_below": int(_num(t.get("building:levels:underground")) or 0) or None,
                            "height_m": _num(t.get("height")), "kind": t.get("building"),
                            # what OpenStreetMap knows of its make-up, when mappers recorded it (often missing)
                            "material": t.get("building:material"), "facade": t.get("building:facade:material"),
                            "roof": t.get("roof:material"), "built": t.get("start_date") or t.get("building:start_date"),
                            "footprint_sqft": round(area * 10.7639), "outline": [[round(a, 7), round(b, 7)] for a, b in ring],
                            "contains_pin": inside, "dist_m": round(dist * 1000), "fetched": now()})
    if not best:
        raise LookupError("OpenStreetMap has no building outline within 80 m of this location. Enter the area by hand.")
    return best[1]


def building_outline(lat, lon):
    """The main Overpass server, then a public mirror: either can be slow or down at busy times."""
    q = (f'[out:json][timeout:50];(way(around:80,{lat},{lon})["building"];relation(around:80,{lat},{lon})["building"];);out tags geom;')
    errors = []
    for url, wait in ((OVERPASS, 60), ("https://overpass.private.coffee/api/interpreter", 30)):
        req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                     headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"})
        try:
            with urllib.request.urlopen(req, timeout=wait) as r:
                return pick_building(json.loads(r.read().decode("utf-8")), lat, lon)
        except (OSError, ValueError) as e:
            errors.append(f"{urllib.parse.urlparse(url).netloc}: {e}")
    raise ValueError("OpenStreetMap's servers didn't answer (" + "; ".join(errors) + "). They're busy at times: try again in a minute.")


# ---------------------------------------------------------------- jobs and contacts

def job_row(con, jid):
    r = con.execute("SELECT * FROM das_job WHERE id=?", (jid,)).fetchone()
    if not r:
        return None
    j = dict(r)
    j["data"] = json.loads(j["data"] or "{}")
    j["log"] = [dict(x) for x in con.execute("SELECT ts, kind, detail FROM das_log WHERE job_id=? ORDER BY id DESC LIMIT 200", (jid,))]
    return j


def list_jobs(con):
    out = []
    for r in con.execute("SELECT * FROM das_job ORDER BY updated_at DESC"):
        d = json.loads(r["data"] or "{}")
        out.append({"id": r["id"], "name": r["name"], "stage": r["stage"], "updated_at": r["updated_at"],
                    **{k: d.get(k) for k in ("address", "lat", "lon", "ahj", "due", "next_step", "floors", "accepted_on",
                                             "retest_due", "checks", "value", "client")}})
    return out


def _flat(d, prefix=""):
    out = {}
    for k, v in (d or {}).items():
        if isinstance(v, dict):
            out.update(_flat(v, f"{prefix}{k}."))
        elif not isinstance(v, list):
            out[prefix + k] = v
    return out


def save_job(con, d, jid=None):
    name, stage, data = d.get("name"), d.get("stage"), d.get("data") or {}
    if jid is None:
        cur = con.execute("INSERT INTO das_job(name, stage, data, created_at, updated_at) VALUES(?,?,?,?,?)",
                          (name or "New job", stage if stage in STAGES else "Lead", json.dumps(data), now(), now()))
        jid = cur.lastrowid
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "created", name or ""))
    else:
        old = job_row(con, jid)
        if old is None:
            raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
        new_data = dict(old["data"], **data)
        changes = []
        if name is not None and name != old["name"]:
            changes.append(f"name: {old['name']} → {name}")
        if stage is not None and stage != old["stage"]:
            if stage not in STAGES:
                raise ValueError(f"Unknown stage {stage}.")
            changes.append(f"stage: {old['stage']} → {stage}")
        a, b = _flat(old["data"]), _flat(new_data)
        changes += [f"{k}: {json.dumps(a.get(k))} → {json.dumps(b.get(k))}" for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
        con.execute("UPDATE das_job SET name=?, stage=?, data=?, updated_at=? WHERE id=?",
                    (name if name is not None else old["name"], stage if stage is not None else old["stage"],
                     json.dumps(new_data), now(), jid))
        for c in changes[:40]:
            con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "change", c[:500]))
    con.commit()
    return job_row(con, jid)


def note(con, jid, text):
    if not con.execute("SELECT 1 FROM das_job WHERE id=?", (jid,)).fetchone():
        raise LookupError(f"Job {jid} was deleted.")
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "note", (text or "")[:2000]))
    con.commit()
    return job_row(con, jid)


def delete_job(con, jid):
    con.execute("DELETE FROM das_log WHERE job_id=?", (jid,))
    con.execute("DELETE FROM das_job WHERE id=?", (jid,))
    con.commit()


CONTACT_FIELDS = ("name", "org", "role", "phone", "email", "notes")


def list_contacts(con):
    return [dict(r) for r in con.execute("SELECT * FROM das_contact ORDER BY org, name")]


def save_contact(con, d, cid=None):
    vals = [(d.get(f) or "").strip() for f in CONTACT_FIELDS]
    if cid is None:
        cid = con.execute(f"INSERT INTO das_contact({','.join(CONTACT_FIELDS)}, updated_at) VALUES({','.join('?' * (len(CONTACT_FIELDS) + 1))})",
                          vals + [now()]).lastrowid
    else:
        con.execute(f"UPDATE das_contact SET {','.join(f + '=?' for f in CONTACT_FIELDS)}, updated_at=? WHERE id=?", vals + [now(), cid])
    con.commit()
    return dict(con.execute("SELECT * FROM das_contact WHERE id=?", (cid,)).fetchone())


def delete_contact(con, cid):
    con.execute("DELETE FROM das_contact WHERE id=?", (cid,))
    con.commit()


# ---------------------------------------------------------------- files: any tool's tables in, job folders in Drive

DAS_DIR = os.environ.get("RF_RECON_DAS") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "DAS jobs")
XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _xlsx_table(data):
    """The first worksheet of an .xlsx as rows of strings (standard library only)."""
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        shared = ["".join(t.text or "" for t in si.iter(XLSX_NS + "t"))
                  for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(XLSX_NS + "si")]
    sheets = sorted((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                    key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    if not sheets:
        raise ValueError("That workbook has no worksheets.")
    out = []
    for row in ET.fromstring(z.read(sheets[0])).iter(XLSX_NS + "row"):
        vals = {}
        for c in row.iter(XLSX_NS + "c"):
            idx = 0
            for ch in re.match(r"[A-Z]+", c.get("r") or "A").group(0):
                idx = idx * 26 + ord(ch) - 64
            v, t = c.find(XLSX_NS + "v"), c.get("t")
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(XLSX_NS + "t"))
            else:
                val = v.text if v is not None else ""
            vals[idx - 1] = val
        out.append([vals.get(i, "") for i in range(max(vals) + 1)] if vals else [])
    return out


def _records(table):
    """Header row + data rows -> (headers, list of dicts)."""
    rows = [r for r in table if any(str(x).strip() for x in r)]
    if not rows:
        return [], []
    head = [str(h).strip() or f"col{i + 1}" for i, h in enumerate(rows[0])]
    return head, [{head[i]: (str(v).strip() if v is not None else "") for i, v in enumerate(r) if i < len(head)} for r in rows[1:]]


def _points(pts):
    rows = []
    for p in pts:
        r = {"label": p.get("label") or "", "lat": p.get("lat"), "lon": p.get("lon"), "freq_mhz": p.get("freq_mhz"),
             "dbm": p.get("dbm"), "time": p.get("ts") or ""}
        r.update({k: v for k, v in (p.get("extra") or {}).items() if k not in r})
        rows.append({k: "" if v is None else str(v) for k, v in r.items()})
    head = []
    for r in rows:
        head += [k for k in r if k not in head]
    return head, rows


def read_table(name, data):
    """Any tool's results as (format, headers, rows): CSV / TSV / TXT, Excel .xlsx, JSON, KML / KMZ, GPX."""
    import captures
    n = (name or "").lower()
    if n.endswith(".kmz"):
        return ("kmz",) + _points(captures.parse_kmz(data)[0])
    if n.endswith(".xlsx") or (data[:2] == b"PK" and not n.endswith(".zip")):
        return ("xlsx",) + _records(_xlsx_table(data))
    text = data.decode("utf-8-sig", "replace")
    if n.endswith(".kml") or "<kml" in text[:500]:
        return ("kml",) + _points(captures.parse_kml_text(text)[0])
    if n.endswith(".gpx") or "<gpx" in text[:500]:
        return ("gpx",) + _points(captures.parse_gpx(text)[0])
    if n.endswith(".json") or text.lstrip()[:1] in "[{":
        j = json.loads(text)
        if isinstance(j, dict):  # {"rows": [...]} or any key holding a list of records
            j = next((v for v in j.values() if isinstance(v, list) and v and isinstance(v[0], dict)), [j])
        head = []
        for r in j:
            if isinstance(r, dict):
                head += [k for k in r if k not in head and not isinstance(r[k], (dict, list))]
        return "json", head, [{k: "" if r.get(k) is None else str(r.get(k)) for k in head} for r in j if isinstance(r, dict)]
    try:
        dialect = csv.Sniffer().sniff(text[:5000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return ("tsv" if dialect.delimiter == "\t" else "csv",) + _records(list(csv.reader(io.StringIO(text), dialect)))


# column names other tools use for grid test fields (compared lower-case, letters and digits only)
GRID_ALIASES = {
    "floor": ["floor", "level", "flr", "story", "storey", "buildingfloor", "floorname", "floorlevel"],
    "grid": ["grid", "gridid", "gridno", "gridnumber", "area", "zone", "cell", "point", "testpoint", "location", "square", "label", "name"],
    "dl": ["dldbm", "downlink", "downlinkdbm", "dl", "dlrssi", "dlpower", "dlpowerdbm", "downlinkpower", "dllevel", "rssi", "dbm",
           "signal", "level", "power", "rsrp", "rxdbm", "rxlevel", "channelpower"],
    "ul": ["uldbm", "uplink", "uplinkdbm", "ul", "ulrssi", "ulpower", "ulpowerdbm", "uplinkpower", "ullevel", "talkback"],
    "ul_daq": ["uldaq", "daqul", "uplinkdaq"],
    "daq": ["dldaq", "daqdl", "downlinkdaq", "daq", "daqscore", "audioquality", "quality", "deliveredaudioquality"],
    "sinr": ["sinr", "sinrdb", "dlsinr", "snr"],
    "ber": ["ber", "berpct", "berpercent", "dlber", "biterrorrate", "framebe"],
    "freq": ["freqmhz", "freq", "frequency", "frequencymhz", "channel", "channelmhz"],
    "critical": ["critical", "criticalarea", "iscritical", "areatype"],
    "pass": ["pass", "result", "passfail", "status", "outcome"],
    "lat": ["lat", "latitude"], "lon": ["lon", "lng", "long", "longitude"],
    "x": ["x", "planx", "px"], "y": ["y", "plany", "py"],
    "note": ["notes", "note", "comment", "comments", "remarks", "description"],
    "time": ["time", "timestamp", "datetime", "date", "ts"],
}
CONTACT_ALIASES = {
    "name": ["name", "fullname", "contact", "contactname", "person"],
    "org": ["org", "organization", "organisation", "company", "agency", "employer"],
    "role": ["role", "title", "jobtitle", "position", "type"],
    "phone": ["phone", "phonenumber", "mobile", "cell", "tel", "telephone"],
    "email": ["email", "emailaddress", "mail"],
    "notes": ["notes", "note", "comments"],
}


def guess_mapping(headers, aliases=GRID_ALIASES):
    """Which column holds which field: exact names first, then names that start with a known one ("RSSI (dBm)")."""
    norm = {re.sub(r"[^a-z0-9]", "", h.lower()): h for h in headers}
    out, used = {}, set()
    for loose in (False, True):
        for field, names in aliases.items():
            if field in out:
                continue
            for a in names:
                hit = norm.get(a) if not loose else next((h for n, h in norm.items() if len(a) >= 3 and n.startswith(a)), None)
                if hit and hit not in used:
                    out[field] = hit
                    used.add(hit)
                    break
    return out


def parse_vcards(text):
    out = []
    for card in re.findall(r"BEGIN:VCARD(.*?)END:VCARD", text, re.S | re.I):
        c = {}
        for ln in re.sub(r"\r?\n[ \t]", "", card).splitlines():  # unfold continuation lines
            if ":" not in ln:
                continue
            k, v = ln.split(":", 1)
            k, v = k.split(";")[0].upper(), v.replace("\\,", ",").replace("\\n", " ").strip()
            if k == "FN":
                c["name"] = v
            elif k == "ORG":
                c["org"] = v.replace(";", " ").strip()
            elif k in ("TITLE", "ROLE"):
                c.setdefault("role", v)
            elif k == "TEL":
                c.setdefault("phone", v)
            elif k == "EMAIL":
                c.setdefault("email", v)
            elif k == "NOTE":
                c["notes"] = v
        if c.get("name") or c.get("org"):
            out.append(c)
    return out


def import_contacts(con, name, data):
    text = data.decode("utf-8-sig", "replace")
    if "BEGIN:VCARD" in text.upper():
        found = parse_vcards(text)
    else:
        _, head, rows = read_table(name, data)
        m = guess_mapping(head, CONTACT_ALIASES)
        if "name" not in m and "org" not in m:
            raise ValueError("No name or organisation column found.")
        found = [{f: r.get(h, "") for f, h in m.items()} for r in rows]
    have = {((c["name"] or "").lower(), (c["org"] or "").lower()) for c in list_contacts(con)}
    added = 0
    for c in found:
        key = ((c.get("name") or "").lower(), (c.get("org") or "").lower())
        if key in have or not any(key):
            continue
        save_contact(con, c)
        have.add(key)
        added += 1
    return {"found": len(found), "added": added}


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", (s or "").strip()).strip(" .")[:120] or "file"


def job_dir(jid, name, create=True):
    """RF Recon/DAS jobs/0007 Some building: one folder per job, found by its number if the job is renamed."""
    if os.path.isdir(DAS_DIR):
        for d in os.listdir(DAS_DIR):
            if d.startswith(f"{jid:04d} ") and os.path.isdir(os.path.join(DAS_DIR, d)):
                return os.path.join(DAS_DIR, d)
    path = os.path.join(DAS_DIR, f"{jid:04d} {safe_name(name)}")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def list_files(jid, name):
    d = job_dir(jid, name, create=False)
    files = []
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if os.path.isfile(p) and f.lower() != "desktop.ini" and not f.endswith(".part"):
                files.append({"name": f, "size": os.path.getsize(p), "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p)))})
    return {"folder": d, "files": files}


def file_path(jid, name, fname):
    d = job_dir(jid, name, create=False)
    p = os.path.realpath(os.path.join(d, safe_name(os.path.basename(fname or ""))))
    if not p.startswith(os.path.realpath(d) + os.sep):
        raise ValueError("Bad file name.")
    return p


def save_file(jid, name, fname, data):
    job_dir(jid, name)
    p = file_path(jid, name, fname)
    base, ext = os.path.splitext(p)
    i = 2
    while os.path.exists(p):  # never overwrite: "plan.pdf" becomes "plan (2).pdf"
        p = f"{base} ({i}){ext}"
        i += 1
    with open(p + ".part", "wb") as fh:
        fh.write(data)
    os.replace(p + ".part", p)
    return os.path.basename(p)
