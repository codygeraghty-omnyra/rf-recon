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
from datetime import datetime
import zipfile

import geo
import overture
import paths
import sigid
import uls_import

now = lambda: time.strftime("%Y-%m-%d %H:%M:%S")

SCHEMA = """
CREATE TABLE IF NOT EXISTS das_job(id INTEGER PRIMARY KEY, name TEXT, stage TEXT, data TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_log(id INTEGER PRIMARY KEY, job_id INTEGER, ts TEXT, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS das_contact(id INTEGER PRIMARY KEY, name TEXT, org TEXT, role TEXT, phone TEXT, email TEXT,
    notes TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_part(id INTEGER PRIMARY KEY, supplier TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, part TEXT,
    item TEXT, maker TEXT, cat TEXT, unit TEXT, price REAL, spec_url TEXT, spec_file TEXT, standard INTEGER DEFAULT 0,
    std_qty REAL, updated_at TEXT, weight_lb REAL, UNIQUE(supplier, key));
"""
TABLES = ("das_job", "das_log", "das_contact", "das_part", "das_supplier", "das_rfq", "das_quote", "das_rfq_supplier", "das_prospect",
          "das_mail", "das_mail_state")
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
                flags.append("FirstNet Band 14: needs the FirstNet Authority's written retransmission authorization (AT&T runs the network)")
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
# public Overpass servers, all asked at once; the first good answer wins (11/3: from the AWS server the main one
# answered 502 or took 23-32 s, and asking them one after another left the DAS Plans panel on "Looking…")
OVERPASS_MIRRORS = (OVERPASS, "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter")
OSM_WAIT_S = 45
OSM_KEEP_DAYS = 30  # a building found is kept this long; a busy spell after that still answers with the kept one


def _osm_cache_path():
    return os.path.join(uls_import.DATA_DIR, "osm_buildings.json")


def _osm_cache():
    try:
        with open(_osm_cache_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _osm_keep(key, b):
    c = _osm_cache()
    c[key] = {"at": time.time(), "b": b}
    tmp = _osm_cache_path() + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(c, fh)
    os.replace(tmp, _osm_cache_path())


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


def building_outline(lat, lon, fresh=False):
    """OpenStreetMap first; Overture (overture.py, from extracts made ahead of time) when OpenStreetMap has no outline
    within 80 m or its servers don't answer, and for a height OpenStreetMap lacks on the same building."""
    try:
        b = osm_outline(lat, lon, fresh)
    except (ValueError, LookupError) as e:
        ov = overture.find(lat, lon)
        if not ov:
            if isinstance(e, LookupError) and not overture.extracts():
                raise LookupError(str(e).rstrip(".") + ". (No Overture extract covers this area yet.)") from None
            raise
        ov["fetched"] = now()
        ov["note"] = ("OpenStreetMap's servers didn't answer" if isinstance(e, ValueError) else
                      "OpenStreetMap has no outline here") + ": this outline is from Overture Maps."
        return ov
    if b.get("height_m") is None and b.get("outline"):
        ov = overture.find(lat, lon)
        ring = b["outline"]
        mid = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
        if ov and ov["height_m"] is not None and overture._inside(mid[0], mid[1], ov["outline"]):  # the same building
            b.update(height_m=ov["height_m"], height_est=True, height_source=f"{ov['height_source'] or 'Overture'} (via Overture)",
                     gers_id=ov["gers_id"], overture_release=ov["release"])
    return b


def _overpass(url, q):
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                 headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"})
    with urllib.request.urlopen(req, timeout=OSM_WAIT_S) as r:
        return json.loads(r.read().decode("utf-8"))


def osm_outline(lat, lon, fresh=False):
    """The building at a spot from OpenStreetMap. A building found in the last 30 days comes from the kept copy; else
    every public Overpass server is asked at once and the first good answer is used. When none answers, a kept copy
    of any age is used before giving up."""
    key = f"{round(lat, 4)},{round(lon, 4)}"
    kept = _osm_cache().get(key)
    if kept and not fresh and time.time() - kept["at"] < OSM_KEEP_DAYS * 86400:
        return {**kept["b"], "kept": True}
    q = (f'[out:json][timeout:40];(way(around:80,{lat},{lon})["building"];relation(around:80,{lat},{lon})["building"];);out tags geom;')
    from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as Late
    errors, data = [], None
    ex = ThreadPoolExecutor(len(OVERPASS_MIRRORS))
    jobs = {ex.submit(_overpass, url, q): urllib.parse.urlparse(url).netloc for url in OVERPASS_MIRRORS}
    try:
        for f in as_completed(jobs, timeout=OSM_WAIT_S + 5):
            try:
                d = f.result()
                if isinstance(d, dict) and "elements" in d:
                    data = d
                    break
                errors.append(f"{jobs[f]}: no data in its answer")
            except (OSError, ValueError) as e:
                errors.append(f"{jobs[f]}: {e}")
    except Late:
        errors.append(f"no answer in {OSM_WAIT_S} s")
    finally:
        ex.shutdown(wait=False, cancel_futures=True)  # the slower servers' answers aren't waited for
    if data is not None:
        b = pick_building(data, lat, lon)  # LookupError when there's no building here: said as it is
        _osm_keep(key, b)
        return b
    if kept:
        return {**kept["b"], "kept": True, "note": "OpenStreetMap's servers didn't answer: this is the copy kept on " + kept["b"].get("fetched", "")[:10]}
    raise ValueError("OpenStreetMap's servers didn't answer (" + "; ".join(errors) + "). They're busy at times: try again in a minute.")


# ---------------------------------------------------------------- jobs and contacts

def job_row(con, jid):
    r = con.execute("SELECT * FROM das_job WHERE id=?", (jid,)).fetchone()
    if not r:
        return None
    j = dict(r)
    j["data"] = json.loads(j["data"] or "{}")
    j["log"] = [dict(x) for x in con.execute("SELECT ts, kind, detail FROM das_log WHERE job_id=? ORDER BY id DESC LIMIT 200", (jid,))]
    j["lifecycle"] = lifecycle(j["data"], j["stage"])  # computed each time, never saved (das lifecycle helpers)
    return j


def list_jobs(con):
    out = []
    for r in con.execute("SELECT * FROM das_job ORDER BY updated_at DESC"):
        d = json.loads(r["data"] or "{}")
        out.append({"id": r["id"], "name": r["name"], "stage": r["stage"], "updated_at": r["updated_at"],
                    **{k: d.get(k) for k in ("address", "lat", "lon", "ahj", "due", "next_step", "floors", "accepted_on",
                                             "retest_due", "checks", "value", "client")},
                    "lifecycle": lifecycle(d, r["stage"])})
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
        jid = next_job_id(con)
        con.execute("INSERT INTO das_job(id, name, stage, data, created_at, updated_at) VALUES(?,?,?,?,?,?)",
                    (jid, name or "New job", stage if stage in STAGES else "Lead", json.dumps(data), now(), now()))
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
    """The job goes; its folder stays (files are never thrown away) but is renamed "_deleted <date> 0007 Name", so a
    later job can't pick it up by number (11/4: a new job showed a deleted job's spec sheet)."""
    d = job_dir(jid, "", create=False)
    if os.path.isdir(d):
        base = os.path.basename(d)
        dest = os.path.join(DAS_DIR, f"_deleted {time.strftime('%Y-%m-%d')} {base}")
        i = 2
        while os.path.exists(dest):
            dest = os.path.join(DAS_DIR, f"_deleted {time.strftime('%Y-%m-%d')} {base} ({i})")
            i += 1
        try:
            os.rename(d, dest)
        except OSError:
            pass  # a file open elsewhere: the folder keeps its name; ids still aren't reused (next_job_id)
    con.execute("DELETE FROM das_log WHERE job_id=?", (jid,))
    con.execute("DELETE FROM das_job WHERE id=?", (jid,))
    con.commit()


def next_job_id(con):
    """A number no job has had: above every job, every job folder (deleted ones too) and anything filed under a job
    id (quotes, mail), so a new job never inherits an old one's files, requests or mail."""
    hi = con.execute("SELECT COALESCE(MAX(id), 0) FROM das_job").fetchone()[0]
    for t in ("das_rfq", "das_mail", "das_log"):
        try:
            hi = max(hi, con.execute(f"SELECT COALESCE(MAX(job_id), 0) FROM {t}").fetchone()[0] or 0)
        except Exception:
            pass  # a table this copy doesn't have yet
    if os.path.isdir(DAS_DIR):
        for n in os.listdir(DAS_DIR):
            m = re.match(r"^(?:_deleted \d{4}-\d\d-\d\d )?(\d{4}) ", n)
            if m:
                hi = max(hi, int(m.group(1)))
    return hi + 1


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

DAS_DIR = os.environ.get("RF_RECON_DAS") or os.path.join(paths.ROOT, "DAS jobs")
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


def carrier_name(s):
    """One name per carrier, whatever a tool calls it ("T-Mobile US", "Verizon Wireless", "FirstNet (AT&T)")."""
    t = str(s or "").strip()
    for pat, name in ((r"first\s*net", "FirstNet"), (r"t-?\s?mobile|sprint", "T-Mobile"), (r"verizon", "Verizon"),
                      (r"at&t|\batt\b|cingular", "AT&T"), (r"us\s?cellular", "UScellular"), (r"dish|boost|echostar", "Dish / Boost")):
        if re.search(pat, t, re.I):
            return name
    return t


def nr_arfcn_mhz(n):
    """5G NR-ARFCN -> MHz (3GPP TS 38.104 global raster: 5 kHz steps below 3 GHz, 15 kHz from 3 to 24.25 GHz)."""
    return 0.005 * n if n < 600000 else 3000 + 0.015 * (n - 600000) if n < 2016667 else None


def _compass(text):
    """A Cel-Fi COMPASS XR "Full Signal Report" (.csv): a few header lines (date, time, WAVE PRO version, COMPASS serial),
    then one block per carrier and technology ("AT&T (4G)") with one row per field and one column per cell, every value
    with a trailing tab. -> one row per cell. A cell listed under two names of one carrier (T-Mobile and T-Mobile US share
    their cells under two PLMNs) is kept once. The report is one spot, so it has no floor or grid: the import asks where."""
    rows = [[c.replace("\t", "").strip() for c in r] for r in csv.reader(io.StringIO(text))]
    when = [r[0] for r in rows[1:8] if r and r[0]]
    date = next((x for x in when if re.match(r"\d{1,2}/\d{1,2}/\d{4}$", x)), "")
    tm = next((x for x in when if re.match(r"\d{1,2}:\d\d(:\d\d)?\s*[AP]M$", x, re.I)), "")
    stamp = ""
    if date:
        try:
            stamp = datetime.strptime(f"{date} {tm or '12:00:00 AM'}", "%m/%d/%Y %I:%M:%S %p").strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            stamp = date
    head = ["Carrier", "Technology", "PLMN ID", "Band", "Bandwidth (MHz)", "Channel", "DL MHz", "PCI", "RSSI (dBm)",
            "RSRP (dBm)", "RSRQ (dB)", "Node", "Cell ID", "Time"]
    out, seen, block, fields = [], set(), None, {}

    def flush():
        if not block:
            return
        name, tech = block
        n = max((len([v for v in vals if v]) for vals in fields.values()), default=0)
        for i in range(n):
            g = lambda *ks: next((fields[k][i] for k in ks if k in fields and i < len(fields[k]) and fields[k][i]), "")  # noqa: E731
            ch, mhz = g("EARFCN", "ARFCN/UARFCN", "ARFCN", "NR-ARFCN"), g("DL Center Freq. (MHz)", "Center Freq. (MHz)")
            if (not mhz or not re.match(r"-?[\d.]+$", mhz)) and tech == "NR" and ch.isdigit():
                f = nr_arfcn_mhz(int(ch))
                mhz = f"{f:g}" if f else ""
            row = {"Carrier": carrier_name(name), "Technology": tech, "PLMN ID": g("PLMN ID"), "Band": g("Band"),
                   "Bandwidth (MHz)": g("Bandwidth (MHz)"), "Channel": ch, "DL MHz": mhz, "PCI": g("PCI"),
                   "RSSI (dBm)": g("RSSI (dBm)"), "RSRP (dBm)": g("RSRP (dBm)"), "RSRQ (dB)": g("RSRQ (dB)"),
                   "Node": g("eNodeB", "gNodeB"), "Cell ID": g("Cell ID"), "Time": stamp}
            key = (row["Carrier"], tech, ch, row["PCI"])
            if key not in seen:
                seen.add(key)
                out.append(row)

    for r in rows:
        if len(r) > 1 and not r[0] and re.search(r"\((\dG)\)\s*$", r[1]):
            flush()
            m = re.match(r"(.+?)\s*\((\d)G\)\s*$", r[1])
            block, fields = (m.group(1), {"4": "LTE", "5": "NR", "3": "UMTS", "2": "GSM"}.get(m.group(2), m.group(2) + "G")), {}
        elif block and r and r[0]:
            fields[r[0]] = r[1:]
    flush()
    return head, out


def _add_carrier(head, rows):
    """A table with a PLMN (MCC-MNC) column and no carrier column gets one, named from RF Recon's operator list (cells.py)."""
    norm = {re.sub(r"[^a-z0-9]", "", h.lower()): h for h in head}
    if any(k in norm for k in GRID_ALIASES["carrier"]):
        return head, rows
    col = next((norm[k] for k in ("plmn", "plmnid", "mccmnc", "mccmncid", "hni") if k in norm), None)
    if not col:
        return head, rows
    import cells
    for r in rows:
        m = re.match(r"\s*(\d{3})\s*[-_/ ]?\s*(\d{2,3})\s*$", str(r.get(col, "")))
        r["Carrier"] = carrier_name(cells.operator(m.group(1), m.group(2))) if m else ""
    return head + ["Carrier"], rows


def read_table(name, data):
    """Any tool's results as (format, headers, rows): CSV / TSV / TXT, Excel .xlsx, JSON, KML / KMZ, GPX, and the Cel-Fi
    COMPASS XR Full Signal Report."""
    fmt, head, rows = _read_table(name, data)
    head, rows = _add_carrier(head, rows)
    return fmt, head, rows


def _read_table(name, data):
    import captures
    n = (name or "").lower()
    if n.endswith(".kmz"):
        return ("kmz",) + _points(captures.parse_kmz(data)[0])
    if n.endswith(".xlsx") or (data[:2] == b"PK" and not n.endswith(".zip")):
        return ("xlsx",) + _records(_xlsx_table(data))
    text = data.decode("utf-8-sig", "replace")
    if text.lstrip().upper().startswith("CEL-FI COMPASS"):
        return ("compass",) + _compass(text)
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
    # RSRP is LTE / 5G, not a public-safety downlink level: it has its own field and is never scored against the dBm floor
    "dl": ["dldbm", "downlink", "downlinkdbm", "dl", "dlrssi", "dlpower", "dlpowerdbm", "downlinkpower", "dllevel", "rssi", "dbm",
           "signal", "level", "power", "rxdbm", "rxlevel", "channelpower"],
    "ul": ["uldbm", "uplink", "uplinkdbm", "ul", "ulrssi", "ulpower", "ulpowerdbm", "uplinkpower", "ullevel", "talkback"],
    "ul_daq": ["uldaq", "daqul", "uplinkdaq"],
    "daq": ["dldaq", "daqdl", "downlinkdaq", "daq", "daqscore", "audioquality", "quality", "deliveredaudioquality"],
    "sinr": ["sinr", "sinrdb", "dlsinr", "snr"],
    "ber": ["ber", "berpct", "berpercent", "dlber", "biterrorrate", "framebe"],
    "freq": ["freqmhz", "freq", "frequency", "frequencymhz", "channel", "channelmhz", "ch", "chan", "channelname", "dlfreq",
             "dlfrequency", "dlfreqmhz", "dlmhz", "centerfreq", "centerfrequency", "earfcn", "nrarfcn", "arfcn"],
    "critical": ["critical", "criticalarea", "iscritical", "areatype"],
    "pass": ["pass", "result", "passfail", "status", "outcome"],
    "lat": ["lat", "latitude"], "lon": ["lon", "lng", "long", "longitude"],
    "x": ["x", "planx", "px", "xpos", "posx"], "y": ["y", "plany", "py", "ypos", "posy"],
    "note": ["notes", "note", "comment", "comments", "remarks", "description"],
    "time": ["time", "timestamp", "datetime", "date", "ts"],
    # cellular readings (LTE / 5G): kept on the square, never scored against the public-safety rules
    "tech": ["technology", "tech", "rat", "networktype", "airinterface", "systemtype", "signaltype", "mode", "protocol"],
    "rsrp": ["rsrp", "rsrpdbm", "ssrsrp", "ssrsrpdbm", "ltersrp", "nrrsrp"],
    "rsrq": ["rsrq", "rsrqdb", "ssrsrq", "ssrsrqdb"],
    "pci": ["pci", "physicalcellid", "nrpci", "ltepci"],
    "carrier": ["carrier", "carriername", "operator", "operatorname", "provider", "networkoperator", "networkname", "mno", "wsp"],
    "band": ["band", "bandnumber", "lteband", "nrband", "bandclass"],
    "mhz": ["dlmhz", "dlcenterfreqmhz", "centerfreqmhz", "dlfrequencymhz", "downlinkmhz", "dlcentermhz"],
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


def guess_for(fmt, headers):
    """guess_mapping for a parsed results file: a cell's identity ("Cell ID") is never a grid square, and a COMPASS
    report's RSSI is an LTE channel's wideband level, not a public-safety downlink."""
    m = guess_mapping(headers)
    if m.get("grid") and re.sub(r"[^a-z0-9]", "", m["grid"].lower()) in ("cellid", "cid", "ci", "eci", "nci", "cellidentity"):
        del m["grid"]
    if fmt == "compass":
        m.pop("dl", None)
    return m


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


# ---------------------------------------------------------------- parts catalogue and spec sheets (Joe, 11/3)
# A supplier's price list imported once; the parts a firm uses on every job starred as its standard parts (its BOM
# template, with a default quantity); a spec sheet on each part (a link or an uploaded PDF). A job's bill of materials
# then takes its parts from here, and Build spec sheets gathers every part's sheet into the job's folder for the AHJ.

PART_ALIASES = {
    "part": ["partnumber", "partno", "part", "pn", "sku", "mpn", "itemnumber", "itemno", "catalognumber", "catalogno", "model", "modelnumber"],
    "item": ["description", "item", "itemdescription", "productname", "product", "name", "title", "desc"],
    "maker": ["manufacturer", "maker", "brand", "mfr", "mfg", "make"],
    "supplier": ["supplier", "distributor", "vendor", "vendorname", "seller"],
    "cat": ["category", "type", "class", "group", "productcategory"],
    "unit": ["unit", "uom", "units", "unitofmeasure", "sellunit"],
    "price": ["price", "unitprice", "yourprice", "netprice", "cost", "unitcost", "sellprice", "listprice", "msrp"],
    "spec_url": ["specsheet", "specsheeturl", "spec", "specurl", "datasheet", "datasheeturl", "pdf", "url", "link"],
    "weight_lb": ["weightlb", "weightlbs", "shipweight", "shippingweight", "shipweightlb", "grossweight", "weight", "lbs"],
}
SPEC_MAX = 30 * 1024 * 1024


def _price(v):
    if v is None or v == "":
        return None
    try:
        return round(float(re.sub(r"[^0-9.\-]", "", str(v))), 4)
    except ValueError:
        return None


def _part_key(part, item):
    return re.sub(r"\s+", " ", (part or item or "").strip().lower())


def import_parts(con, name, data, supplier=""):
    """A supplier's price list (CSV, TSV, Excel or JSON) into the catalogue: columns found by their names. A part
    already kept (same supplier and part number) gets the new description, price and link; its star, default
    quantity and uploaded spec sheet stay."""
    _, head, rows = read_table(name, data)
    m = guess_mapping(head, PART_ALIASES)
    if "part" not in m and "item" not in m:
        raise ValueError("No part number or description column found. Columns read: " + ", ".join(head[:12]))
    added = updated = 0
    for r in rows:
        x = {f: str(r.get(h) if r.get(h) is not None else "").strip() for f, h in m.items()}
        part, item = x.get("part", ""), x.get("item", "")
        if not part and not item:
            continue
        sup = (supplier or x.get("supplier") or "").strip()
        key = _part_key(part, item)
        old = con.execute("SELECT id FROM das_part WHERE supplier=? AND key=?", (sup, key)).fetchone()
        con.execute("""INSERT INTO das_part(supplier, key, part, item, maker, cat, unit, price, spec_url, weight_lb, updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(supplier, key) DO UPDATE SET part=excluded.part,
                       weight_lb=COALESCE(excluded.weight_lb, weight_lb),
                       item=COALESCE(NULLIF(excluded.item,''), item), maker=COALESCE(NULLIF(excluded.maker,''), maker),
                       cat=COALESCE(NULLIF(excluded.cat,''), cat), unit=COALESCE(NULLIF(excluded.unit,''), unit),
                       price=COALESCE(excluded.price, price), spec_url=COALESCE(NULLIF(excluded.spec_url,''), spec_url),
                       updated_at=excluded.updated_at""",
                    (sup, key, part, item, x.get("maker", ""), x.get("cat", ""), x.get("unit", ""), _price(x.get("price")),
                     x.get("spec_url", ""), _price(x.get("weight_lb")), now()))
        added, updated = (added, updated + 1) if old else (added + 1, updated)
    con.commit()
    return {"rows": len(rows), "added": added, "updated": updated, "columns": m,
            "total": con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0]}


def _part_row(r):
    d = dict(r)
    d.pop("key", None)
    d["standard"] = bool(d.get("standard"))
    return d


def list_parts(con, q="", standard=False, ids=None, limit=200):
    """Search the catalogue (part number, description, maker, supplier); or just the standard parts; or given ids."""
    where, args = [], []
    if ids:
        where.append(f"id IN ({','.join('?' * len(ids))})")
        args += list(ids)
    if standard:
        where.append("standard=1")
    for w in (q or "").split()[:6]:
        where.append("(part LIKE ? OR item LIKE ? OR maker LIKE ? OR supplier LIKE ? OR cat LIKE ?)")
        args += [f"%{w}%"] * 5
    sql = "SELECT * FROM das_part" + (" WHERE " + " AND ".join(where) if where else "")
    total = con.execute(sql.replace("SELECT *", "SELECT COUNT(*)", 1), args).fetchone()[0]
    rows = con.execute(sql + " ORDER BY standard DESC, supplier, part LIMIT ?", args + [int(limit)]).fetchall()
    return {"parts": [_part_row(r) for r in rows], "total": total,
            "all": con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0],
            "suppliers": [r[0] for r in con.execute("SELECT DISTINCT supplier FROM das_part WHERE supplier<>'' ORDER BY supplier")]}


def save_part(con, d, pid=None):
    """A part added by hand, or a kept part's star, default quantity, price, link or description changed."""
    f = {k: d[k] for k in ("supplier", "part", "item", "maker", "cat", "unit", "spec_url") if k in d}
    if "price" in d:
        f["price"] = _price(d["price"])
    if "standard" in d:
        f["standard"] = 1 if d["standard"] else 0
    if "std_qty" in d:
        f["std_qty"] = _price(d["std_qty"])
    if "weight_lb" in d:
        f["weight_lb"] = _price(d["weight_lb"])
    f["updated_at"] = now()
    if pid is None:
        if not (f.get("part") or f.get("item")):
            raise ValueError("A part needs a part number or a description.")
        f.setdefault("supplier", "")
        f["key"] = _part_key(f.get("part"), f.get("item"))
        cur = con.execute(f"INSERT INTO das_part({','.join(f)}) VALUES({','.join('?' * len(f))}) ON CONFLICT(supplier, key) DO NOTHING",
                          list(f.values()))
        pid = cur.lastrowid if cur.rowcount else con.execute("SELECT id FROM das_part WHERE supplier=? AND key=?", (f["supplier"], f["key"])).fetchone()[0]
    else:
        cur = con.execute("SELECT part, item FROM das_part WHERE id=?", (pid,)).fetchone()
        if not cur:
            raise LookupError("That part was deleted.")
        if "part" in f or "item" in f:
            f["key"] = _part_key(f.get("part", cur["part"]), f.get("item", cur["item"]))
        con.execute(f"UPDATE das_part SET {','.join(k + '=?' for k in f)} WHERE id=?", list(f.values()) + [pid])
    con.commit()
    return _part_row(con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone())


def spec_dir(create=True):
    d = os.path.join(DAS_DIR, "_spec sheets")
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def delete_part(con, pid):
    r = con.execute("SELECT spec_file FROM das_part WHERE id=?", (pid,)).fetchone()
    if r and r["spec_file"]:
        fp = os.path.join(spec_dir(False), r["spec_file"])
        if os.path.isfile(fp):
            os.remove(fp)
    con.execute("DELETE FROM das_part WHERE id=?", (pid,))
    con.commit()


def _is_pdf(data):
    return data[:5] == b"%PDF-"


def save_spec(con, pid, data):
    """A spec sheet PDF uploaded for a part, kept in DAS jobs/_spec sheets/ (one per part; a new one replaces it)."""
    r = con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone()
    if not r:
        raise LookupError("That part was deleted.")
    if not _is_pdf(data):
        raise ValueError("A spec sheet has to be a PDF.")
    if len(data) > SPEC_MAX:
        raise ValueError("That PDF is over 30 MB.")
    name, old = f"{pid:05d} {safe_name(r['part'] or r['item'])}.pdf", r["spec_file"]
    p = os.path.join(spec_dir(), name)
    with open(p + ".part", "wb") as fh:
        fh.write(data)
    os.replace(p + ".part", p)
    if old and old != name and os.path.isfile(os.path.join(spec_dir(), old)):
        os.remove(os.path.join(spec_dir(), old))
    con.execute("UPDATE das_part SET spec_file=?, updated_at=? WHERE id=?", (name, now(), pid))
    con.commit()
    return _part_row(con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone())


def spec_path(con, pid):
    r = con.execute("SELECT spec_file FROM das_part WHERE id=?", (pid,)).fetchone()
    if not r or not r["spec_file"]:
        raise LookupError("No spec sheet is kept for that part.")
    return os.path.join(spec_dir(False), r["spec_file"])


def _public_url(url):
    """Only an http(s) address on the public internet: the server fetches it, so never one of its own or a private
    network's (a link in an imported price list could otherwise reach them)."""
    import ipaddress
    import socket
    u = urllib.parse.urlparse(url or "")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("not an http(s) link")
    for info in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80)):
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise ValueError("the link points at a private address")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Each redirect is checked like the first link: a public page can't send the server on to a private address."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _get(url):
    _public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": "RF-Recon/2.0 (spec sheet for an AHJ submittal)"})
    with urllib.request.build_opener(_NoRedirect).open(req, timeout=40) as r:
        data = r.read(SPEC_MAX + 1)
    if len(data) > SPEC_MAX:
        raise ValueError("the PDF is over 30 MB")
    return data


def pdf_links(html, base, hint=""):
    """The links on a product page most likely to be its spec sheet: PDFs first, then links that say spec sheet or
    datasheet, the ones carrying the part number ahead (11/3: a link to a product page used to stop at "not a PDF")."""
    want = re.sub(r"[^a-z0-9]", "", (hint or "").lower())
    out = {}
    for m in re.finditer(r"""href\s*=\s*["']([^"'#]+)["']""", html, re.I):
        u = urllib.parse.urljoin(base, m.group(1).strip())
        low, flat = u.lower(), re.sub(r"[^a-z0-9]", "", u.lower())
        if not low.startswith(("http://", "https://")):
            continue
        score = (4 if ".pdf" in low else 0) + (3 if re.search(r"spec|datasheet|data-sheet|data_sheet", low) else 0) + (5 if want and want[:12] in flat else 0)
        if score >= 3:
            out[u] = max(score, out.get(u, 0))
    return [u for u, _ in sorted(out.items(), key=lambda kv: -kv[1])][:4]


def fetch_spec(url, hint=""):
    """A spec sheet from its link: the PDF itself, at most 30 MB. A link to a web page (a maker's product page) is
    searched for its spec sheet PDF, the part number's first; each link it follows passes the same public-address
    check."""
    data = _get(url)
    if _is_pdf(data):
        return data
    for u in pdf_links(data[:2_000_000].decode("utf-8", "replace"), url, hint):
        try:
            d = _get(u)
        except (OSError, ValueError):
            continue
        if _is_pdf(d):
            return d
    raise ValueError("the link opens a web page with no spec sheet PDF found on it: open it, save the PDF and upload it to the part")


def _match_part(con, line):
    """The catalogue part for a bill-of-materials line: the one it was added from, else the same part number (the
    line's supplier first), else the same description."""
    if line.get("pid"):
        r = con.execute("SELECT * FROM das_part WHERE id=?", (int(line["pid"]),)).fetchone()
        if r:
            return r
    key = _part_key(line.get("part"), line.get("item"))
    if not key:
        return None
    return con.execute("SELECT * FROM das_part WHERE key=? ORDER BY supplier=? DESC, spec_file IS NULL, id LIMIT 1",
                       (key, line.get("supplier") or "")).fetchone()


def _write_job_file(jid, name, fname, data):
    """A file in the job's folder under this exact name, replacing an older one (a rebuilt spec sheet)."""
    job_dir(jid, name)
    p = file_path(jid, name, fname)
    with open(p + ".part", "wb") as fh:
        fh.write(data)
    os.replace(p + ".part", p)
    return os.path.basename(p)


def build_specsheets(con, jid, job, fetch=None):
    """Every bill-of-materials part's spec sheet into the job's folder as "Spec sheet - <part>.pdf": the PDF kept
    on the part, else fetched from its link. Says which parts have none, so they can be found and added."""
    fetch = fetch or fetch_spec
    bom = (job.get("data") or {}).get("bom") or []
    out, seen = [], set()
    for line in bom:
        key = _part_key(line.get("part"), line.get("item"))
        if not key or key in seen:
            continue
        seen.add(key)
        r = _match_part(con, line)
        label = (line.get("part") or line.get("item") or "").strip()
        res = {"part": line.get("part") or "", "item": line.get("item") or "", "supplier": line.get("supplier") or "",
               "maker": (r["maker"] if r else "") or "", "pid": r["id"] if r else None}
        try:
            if r and r["spec_file"] and os.path.isfile(os.path.join(spec_dir(False), r["spec_file"])):
                with open(os.path.join(spec_dir(False), r["spec_file"]), "rb") as fh:
                    data = fh.read()
                res.update(status="ok", source="the PDF kept on the part")
            elif r and r["spec_url"]:
                data = fetch(r["spec_url"], r["part"] or r["item"] or "")
                res.update(status="ok", source=r["spec_url"])
            else:
                res.update(status="missing", why="no spec sheet kept or linked on this part" if r else "not in the parts catalogue")
                out.append(res)
                continue
            res["file"] = _write_job_file(jid, job["name"], f"Spec sheet - {safe_name(label)}.pdf", data)
        except Exception as e:  # one part's sheet failing never stops the rest
            res.update(status="failed", why=str(e)[:200])
        out.append(res)
    ok = sum(1 for x in out if x["status"] == "ok")
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "spec sheets", f"{ok} of {len(out)} parts' spec sheets gathered"))
    con.commit()
    return {"parts": out, "ok": ok, "of": len(out)}


def bom_rows(bom):
    """The bill of materials as rows for a CSV or the submittal: quantity times price per line, and the total."""
    rows, total = [], 0.0
    for x in bom:
        q, p = _price(x.get("qty")), _price(x.get("price"))
        line = round(q * p, 2) if q is not None and p is not None else None
        total += line or 0
        rows.append({"category": x.get("cat") or "", "item": x.get("item") or "", "part": x.get("part") or "",
                     "supplier": x.get("supplier") or "", "qty": x.get("qty") or "", "unit": x.get("unit") or "",
                     "price": "" if p is None else f"{p:.2f}", "line_total": "" if line is None else f"{line:.2f}", "note": x.get("note") or ""})
    return rows, round(total, 2)


def packet_zip(jid, job):
    """One download for the AHJ packet's parts: the bill of materials (CSV, with prices and the total) and every
    spec sheet gathered into the job's folder."""
    rows, total = bom_rows((job.get("data") or {}).get("bom") or [])
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=["category", "item", "part", "supplier", "qty", "unit", "price", "line_total", "note"])
    w.writeheader()
    w.writerows(rows)
    if rows:
        w.writerow({"item": "Total", "line_total": f"{total:.2f}"})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Bill of materials.csv", "﻿" + buf.getvalue())
        d = job_dir(jid, job["name"], create=False)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.startswith("Spec sheet - ") and f.lower().endswith(".pdf"):
                    z.write(os.path.join(d, f), "Spec sheets/" + f)
    return out.getvalue()


RESEARCH_PARTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "rf_parts.json")
SEED_SUPPLIER = "RF Recon research"


def seed_parts(con, path=RESEARCH_PARTS):
    """A starter catalogue from RF Recon's own research (cables and components with their makers' part numbers and
    datasheet links), so the catalogue isn't empty before a supplier's price list is imported (11/3). Once only: a
    marker in the spec sheet folder keeps it from coming back after the parts are deleted."""
    mark = os.path.join(spec_dir(), ".seeded")
    if os.path.exists(mark) or con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0]:
        return 0
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return 0
    url = {x.get("key"): x.get("url") for x in d.get("sources") or [] if x.get("url") and (x.get("kind") == "datasheet" or ".pdf" in (x.get("url") or "").lower())}
    rows = []
    for c in d.get("cables") or []:
        for pn in ([c.get("part_examples")] if isinstance(c.get("part_examples"), str) else c.get("part_examples") or [])[:1]:
            rows.append((pn, c.get("name"), c.get("vendor"), "Cable", "ft", next((url[k] for k in c.get("sources") or [] if k in url), "")))
    for c in d.get("components") or []:
        for x in c.get("part_examples") or []:
            if isinstance(x, dict) and x.get("part"):
                pn = re.split(r"\s*[(;]", x["part"])[0].strip()
                rows.append((pn, f"{c.get('type')}: {(x.get('spec_summary') or '')[:90]}", x.get("vendor"), c.get("type"), "ea", url.get(x.get("source"), "")))
    n = 0
    for pn, item, maker, cat, unit, spec in rows:
        if not pn:
            continue
        con.execute("INSERT OR IGNORE INTO das_part(supplier, key, part, item, maker, cat, unit, spec_url, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (SEED_SUPPLIER, _part_key(pn, item), pn, item, (maker or "").split(" (")[0], cat, unit, spec, now()))
        n += 1
    con.commit()
    with open(mark, "w", encoding="utf-8") as fh:
        fh.write(now())
    return n


# ---------------------------------------------------------------- supplier quotes (Cody 11/3)
# A request for quote from a job's bill of materials to several suppliers; their quotes kept line by line, with each
# supplier's shipping, shipping time and how long the quote holds; then the comparison: each supplier's landed total
# and when the order is ready, the cheapest, the fastest, and the best split (each line from its cheapest supplier,
# each used supplier's shipping added). RF Recon writes the request; the person sends it: nothing goes to a supplier
# on its own.

RFQ_SCHEMA = """
CREATE TABLE IF NOT EXISTS das_supplier(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, email TEXT, phone TEXT, website TEXT,
    contact TEXT, notes TEXT, updated_at TEXT, price_url TEXT, price_checked TEXT, price_result TEXT, ship_from TEXT);
CREATE TABLE IF NOT EXISTS das_rfq(id INTEGER PRIMARY KEY, job_id INTEGER, title TEXT, lines TEXT, suppliers TEXT, need_by TEXT,
    ship_to TEXT, notes TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_quote(id INTEGER PRIMARY KEY, rfq_id INTEGER, supplier TEXT, key TEXT, unit_price REAL, qty REAL,
    lead_days REAL, note TEXT, updated_at TEXT, UNIQUE(rfq_id, supplier, key));
CREATE TABLE IF NOT EXISTS das_rfq_supplier(id INTEGER PRIMARY KEY, rfq_id INTEGER, supplier TEXT, ship_cost REAL, ship_days REAL,
    valid_until TEXT, terms TEXT, quote_ref TEXT, sent_at TEXT, received_at TEXT, ship_est TEXT, UNIQUE(rfq_id, supplier));
"""
SCHEMA += RFQ_SCHEMA  # created with the other DAS tables at start-up
# mail threads: RF Recon emails sent from a person's own mailbox and the tagged replies (dasmail.py, mailbox.py)
MAIL_SCHEMA = """
CREATE TABLE IF NOT EXISTS das_mail(id INTEGER PRIMARY KEY, login TEXT, direction TEXT, tag TEXT, kind TEXT, job_id INTEGER,
    rfq_id INTEGER, supplier TEXT, prospect_id TEXT, counterpart TEXT, subject TEXT, body TEXT, attachments TEXT,
    message_id TEXT, in_reply_to TEXT, status TEXT, result TEXT, proposal TEXT, ts TEXT, UNIQUE(login, message_id));
CREATE INDEX IF NOT EXISTS das_mail_tag ON das_mail(tag);
CREATE TABLE IF NOT EXISTS das_mail_state(login TEXT, folder TEXT, uidvalidity TEXT, last_uid INTEGER, last_check TEXT,
    last_error TEXT, PRIMARY KEY(login, folder));
"""
SCHEMA += MAIL_SCHEMA
SCHEMA += """
CREATE TABLE IF NOT EXISTS das_prospect(id TEXT PRIMARY KEY, status TEXT, notes TEXT, contacted_at TEXT, job_id INTEGER, updated_at TEXT,
    email TEXT, email_source TEXT);
"""
QUOTE_ALIASES = {
    "part": PART_ALIASES["part"], "item": PART_ALIASES["item"],
    "unit_price": ["unitprice", "yourprice", "price", "quotedprice", "netprice", "cost", "unitcost"],
    "qty": ["qty", "quantity", "qtyavailable", "available", "qtyquoted"],
    "lead_days": ["leaddays", "leadtime", "leadtimedays", "lead", "daystoship", "availability", "shipsin"],
    "note": ["note", "notes", "comment", "comments", "remarks"],
}


def list_suppliers(con):
    """Every supplier: the ones kept with an email and the ones the parts catalogue names."""
    kept = {r["name"]: dict(r) for r in con.execute("SELECT * FROM das_supplier ORDER BY name")}
    for (n,) in con.execute("SELECT DISTINCT supplier FROM das_part WHERE supplier<>'' AND supplier<>?", (SEED_SUPPLIER,)):
        kept.setdefault(n, {"id": None, "name": n, "email": "", "phone": "", "website": "", "contact": "", "notes": "", "price_url": ""})
    return sorted(kept.values(), key=lambda s: s["name"].lower())


def save_supplier(con, d):
    name = (d.get("name") or "").strip()
    if not name:
        raise ValueError("A supplier needs a name.")
    old = con.execute("SELECT * FROM das_supplier WHERE name=?", (name,)).fetchone()
    old = dict(old) if old else {}
    f = {k: (d[k] if k in d else old.get(k)) or "" for k in ("email", "phone", "website", "contact", "notes", "price_url", "ship_from")}  # a field not sent stays
    f = {k: str(v).strip() for k, v in f.items()}
    if f["price_url"]:
        _public_url(f["price_url"])
    con.execute("""INSERT INTO das_supplier(name, email, phone, website, contact, notes, price_url, ship_from, updated_at) VALUES(?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(name) DO UPDATE SET email=excluded.email, phone=excluded.phone, website=excluded.website,
                   contact=excluded.contact, notes=excluded.notes, price_url=excluded.price_url, ship_from=excluded.ship_from,
                   updated_at=excluded.updated_at""",
                (name, f["email"], f["phone"], f["website"], f["contact"], f["notes"], f["price_url"], f["ship_from"], now()))
    con.commit()
    return dict(con.execute("SELECT * FROM das_supplier WHERE name=?", (name,)).fetchone())


def _rfq_lines(bom):
    """The lines a request asks about: one per part (same part twice is summed), with what's needed."""
    out = {}
    for x in bom:
        k = _part_key(x.get("part"), x.get("item"))
        if not k:
            continue
        q = _price(x.get("qty")) or 0
        if k in out:
            out[k]["qty"] += q
        else:
            out[k] = {"key": k, "part": x.get("part") or "", "item": x.get("item") or "", "unit": x.get("unit") or "ea", "qty": q,
                      "maker": "", "pid": x.get("pid")}
    return list(out.values())


def create_rfq(con, jid, job, suppliers, need_by="", ship_to="", notes=""):
    """A request for quote from the job's bill of materials to the given suppliers (its lines are fixed when made, so
    a later change to the BOM doesn't move the quotes under it)."""
    lines = _rfq_lines((job.get("data") or {}).get("bom") or [])
    if not lines:
        raise ValueError("The bill of materials is empty: add the parts first.")
    sups = [s.strip() for s in suppliers if s and s.strip()]
    if not sups:
        raise ValueError("Pick at least one supplier to ask.")
    for ln in lines:  # the maker, from the catalogue, so a supplier can match the part
        r = _match_part(con, ln)
        ln["maker"] = (r["maker"] if r else "") or ""
    cur = con.execute("INSERT INTO das_rfq(job_id, title, lines, suppliers, need_by, ship_to, notes, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (jid, f"{job['name']}: {len(lines)} part{'s' if len(lines) != 1 else ''}", json.dumps(lines), json.dumps(sups),
                       need_by or "", ship_to or "", notes or "", "open", now(), now()))
    for s in sups:
        con.execute("INSERT OR IGNORE INTO das_rfq_supplier(rfq_id, supplier) VALUES(?,?)", (cur.lastrowid, s))
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "quotes", f"request for quote to {', '.join(sups)}"))
    con.commit()
    return get_rfq(con, cur.lastrowid)


def list_rfqs(con, jid):
    return [{**dict(r), "lines": json.loads(r["lines"] or "[]"), "suppliers": json.loads(r["suppliers"] or "[]")}
            for r in con.execute("SELECT * FROM das_rfq WHERE job_id=? ORDER BY id DESC", (jid,))]


def get_rfq(con, rid):
    r = con.execute("SELECT * FROM das_rfq WHERE id=?", (rid,)).fetchone()
    if not r:
        raise LookupError("That request for quote was deleted.")
    q = {**dict(r), "lines": json.loads(r["lines"] or "[]"), "suppliers": json.loads(r["suppliers"] or "[]")}
    q["quotes"] = [dict(x) for x in con.execute("SELECT supplier, key, unit_price, qty, lead_days, note FROM das_quote WHERE rfq_id=?", (rid,))]
    q["terms"] = {x["supplier"]: dict(x) for x in con.execute("SELECT * FROM das_rfq_supplier WHERE rfq_id=?", (rid,))}
    q["compare"] = compare_quotes(q)
    return q


def save_quote(con, rid, supplier, d):
    """One supplier's quote: its lines ({key: {unit_price, qty, lead_days, note}}) and its order terms."""
    get_rfq(con, rid)
    for key, x in (d.get("lines") or {}).items():
        con.execute("""INSERT INTO das_quote(rfq_id, supplier, key, unit_price, qty, lead_days, note, updated_at) VALUES(?,?,?,?,?,?,?,?)
                       ON CONFLICT(rfq_id, supplier, key) DO UPDATE SET unit_price=excluded.unit_price, qty=excluded.qty,
                       lead_days=excluded.lead_days, note=excluded.note, updated_at=excluded.updated_at""",
                    (rid, supplier, key, _price(x.get("unit_price")), _price(x.get("qty")), _price(x.get("lead_days")), (x.get("note") or "")[:300], now()))
    t = d.get("terms") or {}
    con.execute("""INSERT INTO das_rfq_supplier(rfq_id, supplier, ship_cost, ship_days, valid_until, terms, quote_ref, sent_at, received_at)
                   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(rfq_id, supplier) DO UPDATE SET
                   ship_cost=COALESCE(excluded.ship_cost, ship_cost), ship_days=COALESCE(excluded.ship_days, ship_days),
                   valid_until=COALESCE(NULLIF(excluded.valid_until,''), valid_until), terms=COALESCE(NULLIF(excluded.terms,''), terms),
                   quote_ref=COALESCE(NULLIF(excluded.quote_ref,''), quote_ref), sent_at=COALESCE(excluded.sent_at, sent_at),
                   received_at=COALESCE(excluded.received_at, received_at)""",
                (rid, supplier, _price(t.get("ship_cost")), _price(t.get("ship_days")), t.get("valid_until") or "", t.get("terms") or "",
                 t.get("quote_ref") or "", t.get("sent_at"), now() if d.get("lines") else None))
    if _price(t.get("ship_cost")) is not None:  # the supplier's own shipping price: no longer an estimate
        con.execute("UPDATE das_rfq_supplier SET ship_est=NULL WHERE rfq_id=? AND supplier=?", (rid, supplier))
    con.execute("UPDATE das_rfq SET updated_at=? WHERE id=?", (now(), rid))
    con.commit()
    return get_rfq(con, rid)


def import_quote(con, rid, supplier, name, data):
    """A supplier's filled-in quote sheet (the request's CSV, or their own sheet with part, price and lead time)."""
    q = get_rfq(con, rid)
    _, head, rows = read_table(name, data)
    m = guess_mapping(head, QUOTE_ALIASES)
    if "unit_price" not in m:
        raise ValueError("No price column found. Columns read: " + ", ".join(head[:12]))
    by = {ln["key"]: ln for ln in q["lines"]}
    lines, missed = {}, 0
    for r in rows:
        k = _part_key(str(r.get(m.get("part"), "") or ""), str(r.get(m.get("item"), "") or ""))
        if k not in by:
            k = _part_key("", str(r.get(m.get("item"), "") or ""))
        if k not in by:
            missed += 1 if any(str(v).strip() for v in r.values()) else 0
            continue
        lt = str(r.get(m.get("lead_days"), "") or "")
        weeks = re.search(r"(\d+(?:\.\d+)?)\s*(?:wk|week)", lt, re.I)
        lines[k] = {"unit_price": r.get(m["unit_price"]), "qty": r.get(m.get("qty"), ""),
                    "lead_days": float(weeks.group(1)) * 7 if weeks else ("0" if re.search(r"stock", lt, re.I) else lt), "note": r.get(m.get("note"), "")}
    if not lines:
        raise ValueError("None of the sheet's rows match this request's parts.")
    out = save_quote(con, rid, supplier, {"lines": lines})
    out["imported"] = {"lines": len(lines), "unmatched": missed, "columns": m}
    return out


def compare_quotes(q):
    """Each supplier's landed total (lines x quantity + shipping) and when the whole order is ready (the longest lead
    time + shipping days), which lines it didn't quote; the cheapest and fastest supplier that quoted every line; and
    the best split: each line from its cheapest supplier, each supplier used adding its shipping once."""
    lines = q["lines"]
    by = {}
    for x in q["quotes"]:
        if x["unit_price"] is not None:
            by.setdefault(x["supplier"], {})[x["key"]] = x
    sups = []
    for s in q["suppliers"]:
        got, t = by.get(s, {}), q["terms"].get(s, {})
        missing = [ln["key"] for ln in lines if ln["key"] not in got]
        sub = round(sum(got[ln["key"]]["unit_price"] * ln["qty"] for ln in lines if ln["key"] in got), 2)
        ship = t.get("ship_cost") or 0
        lead = max([got[k]["lead_days"] or 0 for k in got] or [0])
        sups.append({"supplier": s, "quoted": len(got), "of": len(lines), "missing": missing, "subtotal": sub,
                     "shipping": ship, "total": round(sub + ship, 2), "ready_days": (lead + (t.get("ship_days") or 0)) if got else None,
                     "valid_until": t.get("valid_until") or "", "received": bool(got), "ship_est": t.get("ship_est") or ""})
    full = [s for s in sups if s["received"] and not s["missing"]]
    cheapest = min(full, key=lambda s: s["total"])["supplier"] if full else None
    fastest = min(full, key=lambda s: (s["ready_days"], s["total"]))["supplier"] if full else None
    split, used = [], set()
    for ln in lines:
        offers = [(by[s][ln["key"]]["unit_price"], s) for s in by if ln["key"] in by[s]]
        if offers:
            p, s = min(offers)
            split.append({"key": ln["key"], "part": ln["part"], "item": ln["item"], "supplier": s, "unit_price": p, "line": round(p * ln["qty"], 2)})
            used.add(s)
    split_total = round(sum(x["line"] for x in split) + sum((q["terms"].get(s, {}).get("ship_cost") or 0) for s in used), 2)
    return {"suppliers": sups, "cheapest": cheapest, "fastest": fastest,
            "split": {"lines": split, "suppliers": sorted(used), "total": split_total, "complete": len(split) == len(lines)}}


def rfq_sheet(q):
    """The sheet a supplier fills in and sends back (imports straight back with import_quote)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Part number", "Description", "Manufacturer", "Qty", "Unit", "Unit price", "Lead time (days)", "Notes"])
    for ln in q["lines"]:
        w.writerow([ln["part"], ln["item"], ln.get("maker", ""), f"{ln['qty']:g}", ln["unit"], "", "", ""])
    return "﻿" + buf.getvalue()


def rfq_email(q, supplier, sender=""):
    """The request as an email the person sends from their own mail (subject, body)."""
    rows = "\n".join(f"- {ln['qty']:g} {ln['unit']}  {ln['part'] or ''}  {ln['item']}{' (' + ln['maker'] + ')' if ln.get('maker') else ''}" for ln in q["lines"])
    need = f"\nWe need them by {q['need_by']}." if q.get("need_by") else ""
    ship = f"\nShip to: {q['ship_to']}" if q.get("ship_to") else ""
    body = (f"Hello {supplier},\n\nPlease quote the parts below.{need}{ship}\n\n{rows}\n\n"
            "For each line: your unit price, the quantity you can supply, and the lead time.\n"
            "For the order: the shipping cost and method, how long it takes to arrive, and how long the quote holds.\n"
            "The attached sheet has a column for each; filled in and sent back, it reads straight into our comparison.\n\n"
            f"{q.get('notes') or ''}\n\nThank you,\n{sender}").replace("\n\n\n", "\n\n")
    return {"subject": f"Request for quote: {q['title']}", "body": body}


def migrate(con):
    """Columns added after a table was first made (CREATE TABLE IF NOT EXISTS leaves an old table as it was)."""
    add = {"das_supplier": (("price_url", "TEXT"), ("price_checked", "TEXT"), ("price_result", "TEXT"), ("ship_from", "TEXT")),
           "das_part": (("weight_lb", "REAL"),), "das_rfq_supplier": (("ship_est", "TEXT"),),
           "das_prospect": (("email", "TEXT"), ("email_source", "TEXT"))}
    for table, cols in add.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for c, typ in cols:
            if have and c not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {c} {typ}")
    con.commit()


# where the online distributors ship from (their own published warehouses), for shipping estimates on their quotes
ONLINE_SHIP_FROM = {"Mouser (online)": "1000 N Main St, Mansfield, TX 76063", "Digi-Key (online)": "701 Brooks Ave S, Thief River Falls, MN 56701"}


def freight_estimate(con, rid, token, fetch=None):
    """Shipping estimates (Shippo) for each supplier on a request that hasn't given its own shipping price: from its
    ship-from address to the request's ship-to, for the parts' weights. Kept on the quote as an estimate."""
    import freight
    if not token:
        raise ValueError("Save a Shippo API token first (Data & updates, Your API keys: Shippo). Rate quotes are free.")
    q = get_rfq(con, rid)
    if not q.get("ship_to"):
        raise ValueError("Add the ship-to address to the request first (it needs a ZIP code).")
    to = freight.parse_address(q["ship_to"])
    wt = {}
    for r in con.execute("SELECT key, MAX(weight_lb) w FROM das_part WHERE weight_lb IS NOT NULL GROUP BY key"):
        wt[r["key"]] = r["w"]
    boxes, total, missing = freight.parcels(q["lines"], wt.get)
    info = {"total_lb": total, "boxes": len(boxes), "missing_weight": missing, "results": []}
    if not boxes:
        raise ValueError("None of the request's parts has a weight yet: add each part's shipping weight in the catalogue (lb).")
    if total > freight.PARCEL_MAX_LB:
        raise ValueError(f"{total:g} lb in all is freight (LTL), which parcel rates don't cover: ask the suppliers for a freight quote.")
    sup = {r["name"]: r["ship_from"] for r in con.execute("SELECT name, ship_from FROM das_supplier")}
    for s in q["suppliers"]:
        t = q["terms"].get(s, {})
        if t.get("ship_cost") is not None and not t.get("ship_est"):
            info["results"].append({"supplier": s, "result": "kept the supplier's own shipping price"})
            continue
        frm_text = sup.get(s) or ONLINE_SHIP_FROM.get(s)
        if not frm_text:
            info["results"].append({"supplier": s, "result": "no ship-from address saved for this supplier"})
            continue
        try:
            rates = freight.shippo_rates(token, freight._addr(freight.parse_address(frm_text), s),
                                         freight._addr(to, q.get("title") or "Job site"), boxes, fetch=fetch)
        except Exception as e:
            info["results"].append({"supplier": s, "result": f"failed: {str(e)[:200]}"})
            continue
        cheap, fast = freight.pick(rates)
        note = (f"Estimate (Shippo): {cheap['provider']} {cheap['service']} ${cheap['amount']:,.2f}"
                + (f", {cheap['days']} days" if cheap["days"] is not None else "")
                + (f"; fastest {fast['provider']} {fast['service']} ${fast['amount']:,.2f}, {fast['days']} days" if fast and fast is not cheap else "")
                + (f"; {len(missing)} part{'s' if len(missing) != 1 else ''} with no weight left out" if missing else ""))
        con.execute("""INSERT INTO das_rfq_supplier(rfq_id, supplier, ship_cost, ship_days, ship_est) VALUES(?,?,?,?,?)
                       ON CONFLICT(rfq_id, supplier) DO UPDATE SET ship_cost=excluded.ship_cost, ship_days=excluded.ship_days,
                       ship_est=excluded.ship_est""", (rid, s, cheap["amount"], cheap["days"], note))
        info["results"].append({"supplier": s, "result": note, "rates": rates[:6]})
    con.commit()
    out = get_rfq(con, rid)
    out["freight"] = info
    return out


def online_quotes(con, rid, creds, lookups=None):
    """The distributors' online prices for a request's lines, kept as quotes from "<source> (online)": price at the
    quantity, stock (ships now) or lead time, the product page. Shipping isn't in their APIs: it's left blank."""
    import prices
    q = get_rfq(con, rid)
    got, errors = prices.offers(creds, q["lines"], lookups)
    names = list(q["suppliers"])
    for src, by in got.items():
        name = f"{src} (online)"
        if name not in names:
            names.append(name)
        save_quote(con, rid, name, {"lines": {k: {"unit_price": o["unit_price"], "qty": o["stock"], "lead_days": o["lead_days"],
                                                  "note": o["url"]} for k, o in by.items()}})
    con.execute("UPDATE das_rfq SET suppliers=?, updated_at=? WHERE id=?", (json.dumps(names), now(), rid))
    con.commit()
    out = get_rfq(con, rid)
    out["online"] = {"sources": sorted(got), "errors": errors, "keys": [n for n, _ in (lookups if lookups is not None else prices.sources(creds))]}
    return out


def refresh_price_lists(con, fetch=None):
    """Each supplier's price list re-read from its link (a CSV or Excel the supplier publishes), so the catalogue's
    prices follow theirs. One supplier's link failing never stops the rest."""
    fetch = fetch or _get
    done = []
    for r in con.execute("SELECT name, price_url FROM das_supplier WHERE price_url IS NOT NULL AND price_url<>''").fetchall():
        try:
            data = fetch(r["price_url"])
            name = urllib.parse.urlparse(r["price_url"]).path.rsplit("/", 1)[-1] or "price list.csv"
            res = import_parts(con, name, data, r["name"])
            msg = f"{res['added']} new, {res['updated']} updated"
        except Exception as e:
            msg = f"failed: {str(e)[:150]}"
        con.execute("UPDATE das_supplier SET price_checked=?, price_result=? WHERE name=?", (now(), msg, r["name"]))
        done.append({"supplier": r["name"], "result": msg})
    con.commit()
    return done


# ---------------------------------------------------------------- lifecycle dates (R2 K-3, C-4, C-9; 11/4)
# What an accepted system owes after acceptance, each with the source that sets it. A date is only computed where the
# source gives a term (annual, five-year); renewals and permits take the date the licensee or AHJ wrote on the paper,
# entered by the person (the Overview offers the researched terms). Kept in the job's data under "life".
LIFE_SOURCES = {
    "annual": ("IFC 510.6.1 / NFPA 1225 20.3.10: tested and signed at acceptance and every 12 months",
               "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    "quant5": ("NFPA 1225 20.3.10.2.3.3: a full quantitative retest at least every five years (per the SBC ERCES Primer; the "
               "IFC has no five-year rule; NYC ARCS: 5-year recertification)", "https://saferbuildings.org/erces-primer/"),
    "auth": ("Licensee authorization: IFC 2024 510.5.2.1 / NFPA 1225 18.7.2; the term is the licensee's (Requirements, "
             "Licensee consent)", "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    "op_permit": ("Operational permit where the fire code official requires one, renewable: IFC 2024 510.3.2 / NFPA 1225 "
                  "18.7.3 (the code sets no term)", "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    "ul2524": ("UL 2524 3rd edition (22 Mar 2024): listings not updated by 22 Mar 2026 are withdrawn (Intertek SUN, 10 Feb 2025)",
               "https://www.intertek.com/siteassets/resources/sun/2025/ul-2524-sun-rev-3-22-2024-ed-3-22-2026.pdf"),
    "remodel": ("IFC 2024 510.6.1: retest after structural changes (additions, remodels); the code gives no deadline",
                "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
}
LIFE_SOON_DAYS = 60
UL2524_WITHDRAWN = "2026-03-22"
_POST_DESIGN = ("Install", "Commission", "Acceptance", "In service")


def _day(s):
    try:
        return datetime.strptime(str(s or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _add_months(d, months):
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    for day in (d.day, 30, 29, 28):  # 29 Feb + 1 year is 28 Feb
        try:
            return d.replace(year=y, month=m, day=day)
        except ValueError:
            continue


def lifecycle(d, stage=None, today=None):
    """A job's lifecycle items: [{key, label, due, done, state, days, source, url}]. state: "overdue", "due" (within
    60 days), "ok", "open" (to do, no date in the code), "done", or "n/a" (not reached yet). d is the job's data;
    d["life"] holds what the person entered: annual_last, quant5_last, op_permit_expires, ul2524_checked, remodel,
    auths [{who, granted, renews, term}]."""
    d = d or {}
    life = d.get("life") or {}
    today = today or datetime.now().date()
    accepted = _day(d.get("accepted_on") or (d.get("checks") or {}).get("accepted_on"))
    out = []

    def item(key, label, due=None, done=None, state=None, src_key=None, note=""):
        days = (due - today).days if due else None
        if state is None:
            state = "n/a" if due is None else "overdue" if days < 0 else "due" if days <= LIFE_SOON_DAYS else "ok"
        text, url = LIFE_SOURCES[src_key or key]
        out.append({"key": key, "label": label, "due": due.isoformat() if due else None,
                    "done": done.isoformat() if done else None, "state": state, "days": days, "source": text, "url": url,
                    "note": note})

    annual_last = _day(life.get("annual_last"))
    base = max([x for x in (accepted, annual_last) if x], default=None)
    if base:
        item("annual", "Annual test", due=_add_months(base, 12), done=annual_last or accepted,
             note="from the last annual test" if annual_last and annual_last >= (accepted or annual_last) else "from acceptance")
    elif _day(d.get("retest_due")):  # a job imported with a retest date and no acceptance date
        item("annual", "Annual test", due=_day(d.get("retest_due")), note="the retest date on file")
    else:
        item("annual", "Annual test", note="starts at acceptance")
    q_last = _day(life.get("quant5_last"))
    q_base = max([x for x in (accepted, q_last) if x], default=None)
    item("quant5", "Five-year full quantitative retest", due=_add_months(q_base, 60) if q_base else None, done=q_last,
         note="where NFPA 1225 applies" if q_base else "starts at acceptance")
    for a in life.get("auths") or []:
        renews = _day(a.get("renews"))
        item("auth", f"Licensee authorization renewal: {a.get('who') or 'licensee'}", due=renews, done=_day(a.get("granted")),
             state=None if renews else "open", note=a.get("term") or ("" if renews else "no renewal date entered"))
    op = _day(life.get("op_permit_expires"))
    if op or life.get("op_permit"):
        item("op_permit", "Operational permit renewal", due=op, state=None if op else "open",
             note="" if op else "no expiry date entered")
    ul = _day(life.get("ul2524_checked"))
    if ul:
        item("ul2524", "Active equipment listed to UL 2524 3rd edition", done=ul, state="done")
    else:
        item("ul2524", "Active equipment listed to UL 2524 3rd edition",
             state="open" if stage in ("Design",) + _POST_DESIGN else "n/a",
             note=f"2nd-edition listings not updated by {UL2524_WITHDRAWN} are withdrawn: check each booster's listing")
    rem = _day(life.get("remodel"))
    if rem:
        tests = [x for x in (accepted, annual_last, q_last) if x and x >= rem]
        item("remodel", f"Retest after the addition or remodel of {rem.isoformat()}", done=min(tests) if tests else None,
             state="done" if tests else "open")
    return out


# ---------------------------------------------------------------- prospects (Cody 11/3): who to approach, and where each stands
PROSPECT_STATUS = ("new", "contacted", "replied", "meeting", "won", "not interested", "do not contact")
KIND_TYPE = {"school_k12": "K-12 schools", "school_private": "K-12 schools", "college": "Colleges and universities", "hospital": "Hospitals",
             "nursing_home": "Nursing homes",
             "high_rise": "High-rise office and residential", "warehouse": "Warehouses and distribution centers",
             "parking": "Parking garages (below grade)", "mall": "Malls and retail centers", "stadium": "Stadiums and arenas",
             "venue": "Convention centers", "airport": "Airports", "hotel": "Hotels", "casino": "Casinos and resorts",
             "government": "Government buildings", "transit": "Transit stations (below grade)"}


def prospect_types():
    """The research's prospect types (why, priority, who to approach), by name (static/research/das_market.json)."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "das_market.json"), encoding="utf-8") as fh:
            return {t["type"]: t for t in json.load(fh).get("prospect_types") or []}
    except (OSError, ValueError):
        return {}


def with_pipeline(con, rows):
    """Prospect rows (prospects.near) with where each stands in this firm's pipeline and why it's a prospect."""
    ids = [r["id"] for r in rows]
    st = {}
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        st.update({r["id"]: dict(r) for r in con.execute(f"SELECT * FROM das_prospect WHERE id IN ({','.join('?' * len(part))})", part)})
    types = prospect_types()
    live = {r[0] for r in con.execute("SELECT id FROM das_job")}  # a job deleted since: the prospect has no job again
    out = []
    for r in rows:
        t = types.get(KIND_TYPE.get(r.get("kind"), ""), {})
        p = st.get(r["id"], {})
        if p.get("email"):
            r = {**r, "email": p["email"], "email_source": p.get("email_source") or ""}
        out.append({**r, "status": p.get("status") or "new", "notes": p.get("notes") or "", "contacted_at": p.get("contacted_at") or "",
                    "job_id": p.get("job_id") if p.get("job_id") in live else None, "priority": t.get("priority") or "", "why": t.get("why") or "", "approach": t.get("decision_maker") or ""})
    rank = {"high": 0, "medium": 1, "low": 2, "": 3}
    return sorted(out, key=lambda x: (x["status"] == "do not contact", rank.get(x["priority"], 3), x.get("dist_mi") or 0))


def set_prospect(con, pid, d):
    cur = con.execute("SELECT * FROM das_prospect WHERE id=?", (pid,)).fetchone()
    cur = dict(cur) if cur else {}
    status = d.get("status", cur.get("status") or "new")
    if status not in PROSPECT_STATUS:
        raise ValueError("Unknown status.")
    contacted = "" if status == "new" else (d.get("contacted_at") or cur.get("contacted_at") or (now() if status == "contacted" else ""))
    email = (d.get("email", cur.get("email")) or "").strip()
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}", email):
        raise ValueError("That doesn't look like an email address.")
    con.execute("""INSERT INTO das_prospect(id, status, notes, contacted_at, job_id, updated_at, email, email_source) VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET status=excluded.status, notes=excluded.notes, contacted_at=excluded.contacted_at,
                   job_id=COALESCE(excluded.job_id, job_id), updated_at=excluded.updated_at, email=excluded.email,
                   email_source=excluded.email_source""",
                (pid, status, d.get("notes", cur.get("notes") or ""), contacted, d.get("job_id", cur.get("job_id")), now(),
                 email, d.get("email_source", cur.get("email_source") or "") if email else ""))
    con.commit()
    return dict(con.execute("SELECT * FROM das_prospect WHERE id=?", (pid,)).fetchone())


def prospect_email(prospect, firm):
    """A first email to a prospect, written to US CAN-SPAM's rules for commercial email: who it's from, an honest
    subject, the firm's physical mailing address, and a plain way to opt out (honoured: Do not contact). The person
    sends it from their own mail."""
    t = prospect_types().get(KIND_TYPE.get(prospect.get("kind"), ""), {})
    who = prospect.get("contact_name") or "Facilities team"
    name = firm.get("name") or "our firm"
    body = (f"Hello {who},\n\n"
            f"{name} designs, installs and tests in-building emergency responder radio coverage (ERCES / public safety DAS) "
            f"and cellular coverage. {('Buildings like ' + prospect['name'] + ' are often required to have it: ' + t['why']) if t.get('why') else ''}\n\n"
            "We can check, before anyone visits, which public safety radio systems serve your building and what coverage the "
            "fire marshal will expect, and walk you through what a test and a system would involve.\n\n"
            "Would a short call next week be useful?\n\n"
            f"{firm.get('contact') or ''}\n{name}\n{firm.get('phone') or ''}\n{firm.get('website') or ''}\n"
            f"{firm.get('address') or '[your mailing address: required in commercial email]'}\n\n"
            "If you'd rather not hear from us, reply \"no thanks\" and we won't write again.")
    return {"to": prospect.get("email") or "", "subject": f"Emergency radio coverage at {prospect['name']}", "body": body}
