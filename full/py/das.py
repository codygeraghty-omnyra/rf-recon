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
import shutil
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
import zipfile

import carriers
import dashist
import geo
import overture
import paths
import sigid
import uls_import
import xlsread

now = lambda: time.strftime("%Y-%m-%d %H:%M:%S")

SCHEMA = """
CREATE TABLE IF NOT EXISTS das_job(id INTEGER PRIMARY KEY, name TEXT, stage TEXT, data TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_log(id INTEGER PRIMARY KEY, job_id INTEGER, ts TEXT, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS das_contact(id INTEGER PRIMARY KEY, name TEXT, org TEXT, role TEXT, phone TEXT, email TEXT,
    notes TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_part(id INTEGER PRIMARY KEY, supplier TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, part TEXT,
    item TEXT, maker TEXT, cat TEXT, unit TEXT, price REAL, spec_url TEXT, spec_file TEXT, standard INTEGER DEFAULT 0,
    std_qty REAL, updated_at TEXT, weight_lb REAL, fcc_id TEXT, grant_info TEXT, codes TEXT, pattern TEXT, UNIQUE(supplier, key));
"""
TABLES = ("das_job", "das_log", "das_contact", "das_part", "das_supplier", "das_rfq", "das_quote", "das_rfq_supplier", "das_prospect",
          "das_mail", "das_mail_state")
SCHEMA, TABLES = SCHEMA + dashist.SCHEMA, TABLES + dashist.TABLES  # revisions, history, access lists, share links (dashist.py)
# what a file is, recorded once, so a later check reads this and not the file's name; and the Intake ledger (intake.py)
SCHEMA += """
CREATE TABLE IF NOT EXISTS das_file(job_id INTEGER NOT NULL, name TEXT NOT NULL, sha256 TEXT, kind TEXT, source TEXT, intake_id INTEGER,
    at TEXT, PRIMARY KEY(job_id, name));
CREATE TABLE IF NOT EXISTS intake_batch(id INTEGER PRIMARY KEY, who TEXT, source TEXT, job_id INTEGER, label TEXT, created_at TEXT, done_at TEXT);
CREATE TABLE IF NOT EXISTS intake_item(id INTEGER PRIMARY KEY, batch_id INTEGER, parent_id INTEGER, who TEXT, name TEXT, path TEXT, grp TEXT,
    sha256 TEXT, size INTEGER, type TEXT, kind TEXT, conf REAL, why TEXT, job_id INTEGER, job_why TEXT, status TEXT, dest TEXT, mark TEXT,
    scan TEXT, checks TEXT, problems TEXT, facts TEXT, undo TEXT, body TEXT, at TEXT, done_at TEXT);
CREATE INDEX IF NOT EXISTS intake_item_batch ON intake_item(batch_id);
CREATE INDEX IF NOT EXISTS intake_item_status ON intake_item(status);
"""
TABLES += ("das_file", "intake_batch", "intake_item")
# the firm register and the AHJ book (dasfirm.py, ahjbook.py). AUTOINCREMENT: a row's files sit in a folder named by its id, so an id is never handed out twice
SCHEMA += """
CREATE TABLE IF NOT EXISTS das_firm_item(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, serial TEXT NOT NULL DEFAULT '',
    data TEXT, by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_ahj_book(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL UNIQUE, job_name TEXT, state TEXT, place TEXT, county TEXT,
    ahj TEXT, keys TEXT, answers TEXT, confirmed_by TEXT, confirmed_on TEXT, how TEXT, rule_seen TEXT, by TEXT, updated_at TEXT);
"""
TABLES += ("das_firm_item", "das_ahj_book")
STAGES =["Lead", "Pre-survey", "Design", "Install", "Commission", "Acceptance", "In service", "Closed"]

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


def building_entry_loss(data=None):
    """The building entry loss for a job's building, dB, with its parts and basis: need.entry_loss (ITU-R P.2109-2 medians
    at 770-850 MHz by construction year, plus deep-interior, core and below-grade terms), fed from the job's NSI record
    (year built, stories, sq ft, basement), its OSM / Overture building (height, levels, footprint) and its floors."""
    import need as need_mod  # imported here: presurvey() has a local named need
    data = data or {}
    b = data.get("building") or {}
    floors = b.get("levels") or (len(data["floors"]) if isinstance(data.get("floors"), list) and data["floors"] else None)
    label = " · ".join(x for x in ((f"{round(b['height_m'] * 3.281):,} ft" if b.get("height_m") else ""),
                                   (f"{int(floors)} floors" if floors else "")) if x)
    nsi = dict(data["nsi"]) if isinstance(data.get("nsi"), dict) and data["nsi"] else None
    if nsi is not None and b.get("footprint_sqft") and not nsi.get("footprint_sqft"):
        nsi["footprint_sqft"] = b["footprint_sqft"]
    el = need_mod.entry_loss({"kind": data.get("kind") or "", "size_label": label}, nsi)
    el["model"] = "ITU-R P.2109-2 building entry loss, medians at 770-850 MHz (need.entry_loss)"
    el["source"] = "https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2109-2-202308-I!!PDF-E.pdf"
    return el


def presurvey(con, lat, lon, radius_mi=15.0, loss_db=None, threshold_dbm=-95.0, cats=None, building=None):
    """The public safety systems around a building, with downlink and uplink channels and the strongest sites.
    Levels are free-space estimates from licensed ERP (best case, no terrain); inside = outside - loss_db. With no
    loss_db, the building's own ITU-R P.2109 entry loss (building_entry_loss, from the job's data in building) is used,
    and the result says how it was reached (entry_loss)."""
    entry = None
    if loss_db is None:
        entry = building_entry_loss(building)
        loss_db = entry["db"]
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
                                             "compass": geo.compass(b), "tower_reg": uls_import.asr_number(r["tower_reg"]), "height_m": r["height_tip_m"],
                                             "best_out": None, "freqs": set(), "address": ", ".join(x for x in (r["address"], r["city"]) if x)})
        site["freqs"].add(f)
        if out is not None and (site["best_out"] is None or out > site["best_out"]):
            site["best_out"] = round(out, 1)
    import ulsdaily  # filed, not granted: public safety applications within the radius, from the FCC's daily files
    pend = ulsdaily.pending(con, "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e), (lat, lon), radius_mi, ps_only=True)
    pend = {"pending": pend["apps"], "pending_since": pend.get("since"), "pending_asof": pend.get("asof")} if pend["loaded"] else {}
    if not systems:
        return {"systems": [], "bands": [], "firstnet": FIRSTNET, "threshold_dbm": threshold_dbm, "loss_db": loss_db, "entry_loss": entry, **pend}

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
    # The system a building has to carry isn't the loudest on free space: strongest-first put a county's 800 MHz trunked
    # system 101st of 158, behind school and Red Cross channels (11/4 demo). The same tiers as the RF need estimate.
    import need as need_mod  # imported here: need is a local in this function
    for x in out_systems:
        x["tier"] = need_mod.system_tier(x["licensee"], x["category"], x["trunked"], {c["band"] for c in x["down"]})
    out_systems.sort(key=lambda x: (x["tier"], not x["trunked"], -(x["best_out"] if x["best_out"] is not None else -1e9)))
    bands = [{"band": b, "lo": min(fs), "hi": max(fs), "channels": len(set(fs))} for b, fs in need.items()]
    bands.sort(key=lambda x: x["lo"])
    return {"systems": out_systems, "bands": bands, "firstnet": FIRSTNET, "threshold_dbm": threshold_dbm, "loss_db": loss_db,
            "radius_mi": radius_mi, "entry_loss": entry, **pend}


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
    dashist.ensure(con)
    r = con.execute("SELECT * FROM das_job WHERE id=?", (jid,)).fetchone()
    if not r:
        return None
    j = dict(r)
    j["rev"] = j.get("rev") or 0  # the revision a page sends back with its next save (dashist.py)
    j["data"] = json.loads(j["data"] or "{}")
    j["log"] = [dict(x) for x in con.execute("SELECT ts, kind, detail FROM das_log WHERE job_id=? ORDER BY id DESC LIMIT 200", (jid,))]
    j["lifecycle"] = lifecycle(j["data"], j["stage"])  # computed each time, never saved (das lifecycle helpers)
    j["standing"] = _standing(con, j)
    return j


def _standing(con, j, brief=False):
    """What's done and what's next, read from the job's file: computed each time, never saved (nextstep.py)."""
    import nextstep  # here, not at the top: it imports codecheck, which imports das
    s = nextstep.safe(con, j)
    return nextstep.brief(s) if brief else s


def list_jobs(con):
    import dasx  # licence changes and the existing-system audit, as "Needs you" lines
    dashist.ensure(con)
    out = []
    for r in con.execute("SELECT * FROM das_job ORDER BY updated_at DESC").fetchall():  # read whole: the licence watch writes as it goes
        d = json.loads(r["data"] or "{}")
        life = lifecycle(d, r["stage"])
        out.append({"id": r["id"], "name": r["name"], "stage": r["stage"], "updated_at": r["updated_at"], "rev": r["rev"] or 0,
                    **{k: d.get(k) for k in ("address", "lat", "lon", "ahj", "due", "next_step", "floors", "accepted_on",
                                             "retest_due", "checks", "value", "client")},
                    "code_ok": bool(d.get("example") or (d.get("code_check") or {}).get("confirmed_on")),
                    "lifecycle": life, "scope": job_scope(d), "cell_only": cell_only(d), "watch": dasx.board(con, r["id"], d, r["stage"]),
                    "standing": _standing(con, {"id": r["id"], "stage": r["stage"], "data": d, "lifecycle": life}, brief=True)})
    return out


def _flat(d, prefix=""):
    out = {}
    for k, v in (d or {}).items():
        if isinstance(v, dict):
            out.update(_flat(v, f"{prefix}{k}."))
        elif not isinstance(v, list):
            out[prefix + k] = v
    return out


def save_job(con, d, jid=None, who=None, page=False, need_rev=False, note_=None):
    """Make a job, or save sections of one. d: {name?, stage?, data: {section: value}, rev?, client?, resolve?}.
    A save that says which revision it started from is merged with what others saved since, or refused with what
    clashed (dashist.check); page=True keeps the sections only their own routes write (the AHJ's review); need_rev=True
    (a team login) refuses a save that doesn't say. Every change is kept in the job's history (dashist.record)."""
    dashist.ensure(con)
    who = who or dashist.who_now()
    client = str(d.get("client") or "")[:40]
    name, stage, data = d.get("name"), d.get("stage"), d.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError("A job's data is a set of named sections.")
    if page:
        data = {k: v for k, v in data.items() if k not in dashist.RESERVED}
    dashist.begin(con)
    try:
        if jid is None:
            jid = next_job_id(con)
            nm, st = name or "New job", stage if stage in STAGES else "Lead"
            con.execute("INSERT INTO das_job(id, name, stage, data, created_at, updated_at, rev) VALUES(?,?,?,?,?,?,1)",
                        (jid, nm, st, json.dumps(data), now(), now()))
            con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "created", name or ""))
            dashist.record(con, jid, 1, who, client, {":name": (dashist.ABSENT, nm), ":stage": (dashist.ABSENT, st),
                                                      **{k: (dashist.ABSENT, v) for k, v in data.items()}}, note="new job", fold=False)
            dashist.on_create(con, jid, dashist.team_user())
        else:
            r = con.execute("SELECT * FROM das_job WHERE id=?", (jid,)).fetchone()
            if r is None:
                raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
            old_data, cur_rev = json.loads(r["data"] or "{}"), r["rev"] or 0
            if stage is not None and stage != r["stage"] and stage not in STAGES:
                raise ValueError(f"Unknown stage {stage}.")
            cur = dict(old_data, **{":name": r["name"], ":stage": r["stage"]})
            patch = dict(data)
            if name is not None:
                patch[":name"] = name
            if stage is not None:
                patch[":stage"] = stage
            patch = dashist.check(con, jid, cur, cur_rev, patch, d.get("rev", dashist.NO_REV), who, client, need_rev, d.get("resolve"))
            changed = {s: (cur.get(s, dashist.ABSENT), v) for s, v in patch.items() if cur.get(s, dashist.ABSENT) != v}
            if changed:
                new_data = {k: v for k, v in dict(old_data, **{s: v for s, v in patch.items() if not s.startswith(":")}).items()
                            if v is not dashist.ABSENT}
                nm, st = patch.get(":name", r["name"]), patch.get(":stage", r["stage"])
                changes = [f"name: {r['name']} → {nm}"] if nm != r["name"] else []
                if st != r["stage"]:
                    changes.append(f"stage: {r['stage']} → {st}")
                a, b = _flat(old_data), _flat(new_data)
                changes += [f"{k}: {json.dumps(a.get(k))} → {json.dumps(b.get(k))}" for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
                con.execute("UPDATE das_job SET name=?, stage=?, data=?, updated_at=?, rev=? WHERE id=?",
                            (nm, st, json.dumps(new_data), now(), cur_rev + 1, jid))
                for c in changes[:40]:
                    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "change", c[:500]))
                if note_:
                    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "restore", f"{note_} ({who})"))
                dashist.record(con, jid, cur_rev + 1, who, client, changed, note=note_)
                dashist.prune(con, jid)
        con.commit()
    except BaseException:
        con.rollback()
        raise
    return job_row(con, jid)


def restore_job(con, jid, rev, mode, who=None):
    """Undo one revision, or put the job back as it was right after one: written as a new revision, history kept."""
    r = job_row(con, jid)
    if r is None:
        raise LookupError(f"Job {jid} was deleted.")
    cur = dict(r["data"], **{":name": r["name"], ":stage": r["stage"]})
    patch = dashist.restore_patch(con, jid, cur, int(rev), mode)
    d = {"data": {s: v for s, v in patch.items() if not s.startswith(":")}}
    if ":name" in patch:
        d["name"] = patch[":name"]
    if ":stage" in patch:
        d["stage"] = patch[":stage"]
    what = f"undid revision {rev}" if mode == "undo" else f"restored the job as it was at revision {rev}"
    return save_job(con, d, jid, who=who, note_=what)


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
    con.execute("DELETE FROM das_file WHERE job_id=?", (jid,))
    dashist.ensure(con)
    dashist.forget(con, jid)  # its history, access list and share links
    import markup
    markup.drop_scope(con, "job", jid)  # its drawings on the maps
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
    return _xlsx_tables(data)[0][1]


def _xlsx_sheet_names(z):
    """{worksheet's file in the zip: the name on its tab}, from the workbook's own list; {} when a file doesn't have one."""
    try:
        rels = {r.get("Id"): r.get("Target") or "" for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        rid = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        return {("xl/" + rels.get(s.get(rid), "")).replace("xl//xl/", "xl/"): s.get("name") or ""
                for s in ET.fromstring(z.read("xl/workbook.xml")).iter(XLSX_NS + "sheet")}
    except (KeyError, ET.ParseError):
        return {}


def _xlsx_tables(data, gaps=False):
    """Every worksheet of an .xlsx, in file order: [(name on its tab, rows of strings)]. gaps=True keeps a sheet's blank rows, so a
    row's place in the list is its row number."""
    z = zipfile.ZipFile(io.BytesIO(data))
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        shared = ["".join(t.text or "" for t in si.iter(XLSX_NS + "t"))
                  for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(XLSX_NS + "si")]
    sheets = sorted((n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n)),
                    key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    if not sheets:
        raise ValueError("That workbook has no worksheets.")
    names = _xlsx_sheet_names(z)
    return [(names.get(s) or s.rsplit("/", 1)[-1][:-4], _xlsx_rows(z.read(s), shared, gaps)) for s in sheets]


def _xlsx_rows(xml, shared, gaps=False):
    out = []
    for row in ET.fromstring(xml).iter(XLSX_NS + "row"):
        at = int(row.get("r") or len(out) + 1)
        if gaps and len(out) + 1 < at <= len(out) + 1000:  # a row left out of the file is a blank row (a far-off stray cell isn't padded to)
            out += [[] for _ in range(at - len(out) - 1)]
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
    return carriers.name_of(t) or t


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
    """A table with a PLMN (MCC-MNC) column and no carrier column gets one, named from DAStastic's operator list (cells.py)."""
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
    if data[:8] == xlsread.MAGIC:  # Excel 97-2003: a supplier's old price list. Its fullest sheet, not a cover page
        return ("xls",) + _records(max((rows for _, rows in xlsread.tables(data)), key=len))
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


# ---------- sweeps: a cable / antenna analyzer's trace (return loss, VSWR, distance to fault, insertion loss) ----------
# Read from the layouts the makers publish for their exports: Anritsu Site Master / Line Sweep Tools CSV and text (a block
# of "name, value" lines, then a header and the points), Keysight FieldFox CSV ("!" comment lines, BEGIN / END around the
# data), Touchstone .s1p / .s2p (NanoVNA, RigExpert and most VNAs), and any plain table of x and y. dassweep.js grades it.
SWEEP_MAX = 20001
_NUM = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


def _sweep_kind(text):
    t = (text or "").lower()
    if re.search(r"v\.?s\.?w\.?r|\bswr\b", t):
        return "vswr"
    if re.search(r"insertion|cable\s*loss|\bil\b|s21|s12|thru|transmission", t):
        return "il"
    if re.search(r"return\s*loss|\brl\b|s11|s22|log\s*mag|refl|dtf|distance.to.fault", t):
        return "rl"
    return ""


def _sweep_x(head, vals, meta_text):
    """The x column's kind, unit and the factor to MHz (frequency) or 1 (distance, in ft or m)."""
    h = (head or "").lower()
    if re.search(r"dist|length|range|\bft\b|feet|\(m\)|\bmeters?\b|\bmetres?\b", h) and not re.search(r"freq|hz", h):
        if re.search(r"ft|feet", h):
            return "dist", "ft", 1.0
        if re.search(r"\(m\)|\bm\b|meter|metre", h):
            return "dist", "m", 1.0
        return "dist", "m" if re.search(r"units?\W+m(eter|etre)?s?\b", meta_text) else "ft", 1.0
    for pat, f in ((r"ghz", 1000.0), (r"mhz", 1.0), (r"khz", 0.001), (r"\bhz\b|\(hz\)|hz\)", 1e-6)):
        if re.search(pat, h):
            return "freq", "MHz", f
    big = max((abs(v) for v in vals if v is not None), default=0)
    return "freq", "MHz", 1e-6 if big > 1e5 else 1.0  # no unit named: Hz when it looks like Hz, else MHz


def _touchstone(text, two_port):
    """Touchstone v1: '# <unit> S <RI|MA|DB> R <ohms>', then frequency and S-parameter pairs (S11; S11 S21 S12 S22)."""
    unit, fmt = 1000.0, "MA"  # Touchstone's defaults: GHz, magnitude-angle
    scale = {"hz": 1e-6, "khz": 1e-3, "mhz": 1.0, "ghz": 1000.0}
    x, s11, s21, meta = [], [], [], {}

    def db(a, b):
        if fmt == "DB":
            return a
        mag = math.hypot(a, b) if fmt == "RI" else a
        return 20 * math.log10(mag) if mag > 0 else -200.0
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("!"):
            m = re.match(r"!\s*([^:=]{2,40})[:=]\s*(.+)", line)
            if m and len(meta) < 40:
                meta[m.group(1).strip()] = m.group(2).strip()[:200]
            continue
        line = line.split("!")[0].strip()
        if not line:
            continue
        if line.startswith("#"):
            for w in line[1:].lower().split():
                if w in scale:
                    unit = scale[w]
                elif w in ("ri", "ma", "db"):
                    fmt = w.upper()
            continue
        nums = [float(v) for v in line.split() if _NUM.match(v)]
        if len(nums) < 3:
            continue
        x.append(nums[0] * unit)
        s11.append(-db(nums[1], nums[2]))
        if two_port and len(nums) >= 5:
            s21.append(-db(nums[3], nums[4]))
    series = [{"name": "Return loss (S11)", "kind": "rl", "y": s11}]
    if s21 and len(s21) == len(x):
        series.append({"name": "Insertion loss (S21)", "kind": "il", "y": s21})
    return x, series, meta


def _sweep_lines(text):
    sample = "\n".join(text.split("\n")[:200])
    delim = "\t" if sample.count("\t") > max(3, sample.count(",")) else ";" if sample.count(";") > sample.count(",") else ","
    out = []
    for raw in text.split("\n"):
        s = raw.strip()
        if s and delim in s:
            out.append([c.strip() for c in next(csv.reader([s], delimiter=delim))])
        else:  # no delimiter: numbers split on spaces, a text line kept whole ("Serial Number: 0987654")
            w = s.split()
            out.append(w if w and all(_NUM.match(c) for c in w) else [s] if s else [])
    return out


def read_sweep(name, data):
    """A sweep export -> {format, meta, instrument, date, measurement, x_kind ("freq", in MHz, or "dist"), x_unit ("MHz",
    "ft" or "m"), x, series: [{name, kind ("rl" and "il" as positive dB, "vswr", "" when the file doesn't say), y}],
    points}. Raises ValueError when there's no trace in it."""
    n = (name or "").lower()
    if data[:2] == b"PK" and not n.endswith(".zip"):
        text, lines = "", [[str(c).strip() for c in r] for r in _xlsx_table(data)]
    else:
        text = data.decode("utf-8-sig", "replace").replace("\r\n", "\n").replace("\r", "\n")
        lines = None
    meta = {}
    if n.endswith((".s1p", ".s2p")) or re.search(r"^\s*#\s*(hz|khz|mhz|ghz)?\s*s\s+(ri|ma|db)\b", text, re.I | re.M):
        two = n.endswith(".s2p") or bool(re.search(r"^\s*[-+\d.eE]+(\s+[-+\d.eE]+){8}\s*$", text, re.M))
        x, series, meta = _touchstone(text, two)
        fmt, xk, xu = "touchstone", "freq", "MHz"
    else:
        lines = lines if lines is not None else _sweep_lines(text)
        num = lambda c: float(c.strip('"')) if _NUM.match((c or "").strip().strip('"')) else None  # noqa: E731
        runs, run = [], None  # runs of rows that are all numbers, two or more, as wide as each other
        for i, r in enumerate(lines + [[]]):
            cells = [c for c in r if c != ""]
            k = sum(num(c) is not None for c in cells)
            if k >= 2 and k == len(cells):
                if run and run[2] == k:
                    run[1] = i
                    continue
                if run:
                    runs.append(run)
                run = [i, i, k]
            else:
                if run:
                    runs.append(run)
                run = None
        if not runs or max(r[1] - r[0] for r in runs) < 2:
            raise ValueError("No trace found: a sweep export has a column of frequencies or distances and one of readings.")
        start, end, width = max(runs, key=lambda r: r[1] - r[0])
        hi = next((i for i in range(start - 1, max(-1, start - 4), -1)  # the column names: the text line just above the data
                   if lines[i] and not any(num(c) is not None for c in lines[i]) and len([c for c in lines[i] if c]) >= 2), None)
        head = [c.lstrip("!#; ") for c in lines[hi]] if hi is not None else []
        for r in lines[:start] if hi is None else lines[:hi]:  # "name, value" and "name: value" lines above them
            cells = [c.lstrip("!#; ").strip() for c in r if c.strip()]
            joined = ", ".join(cells)
            if re.match(r"^[A-Za-z][^:,]{0,50}:\s*\S", joined):  # "Date: Tue, 04 Nov 2026" (a comma inside the value)
                k, _, v = joined.partition(":")
            elif len(cells) >= 3 and re.match(r"(keysight|agilent|anritsu)", cells[0], re.I):  # FieldFox: maker, model, serial, firmware
                meta.update({"Maker": cells[0], "Model": cells[1], "Serial": cells[2]})
                continue
            elif len(cells) >= 2:
                k, v = cells[0].rstrip(":"), " ".join(cells[1:])
            elif cells and "Title" not in meta and len(cells[0]) < 80:  # "Site Master S332E" on a line of its own
                k, v = "Title", cells[0]
            else:
                continue
            k, v = k.strip(), v.strip()
            if k and v and not _NUM.match(k) and k.upper() not in ("BEGIN", "END") and len(meta) < 40:
                meta[k[:60]] = v[:200]
        rows = [[c for c in lines[i] if c != ""] for i in range(start, end + 1)]
        cols = [[num(r[c]) for r in rows] for c in range(width)]
        names = [(head[c] if c < len(head) else "") for c in range(width)]
        first = 0
        if width > 2 and (re.match(r"^(pt|point|points|#|index|no\.?|n)$", names[0].strip(), re.I) or
                          all(v == j + cols[0][0] for j, v in enumerate(cols[0]))):
            first = 1  # a point-number column
        meta_text = " ".join(f"{k} {v}" for k, v in meta.items()).lower()
        xk, xu, xs = _sweep_x(names[first], cols[first], meta_text)
        if xk == "freq" and not re.search(r"hz|freq", names[first].lower()) and re.search(r"\bdtf\b|distance\s*to\s*fault", meta_text):
            xk, xu, xs = "dist", "m" if re.search(r"units?\W+m(eter|etre)?s?\b", meta_text) else "ft", 1.0
        x = [v * xs for v in cols[first]]
        said = " ".join(str(v) for k, v in meta.items() if re.search(r"^meas|^mode\b|trace|type|format", k, re.I))
        series = []
        for c in range(first + 1, width):
            kind = _sweep_kind(names[c]) or _sweep_kind(said)
            series.append({"name": names[c] or f"Trace {c - first}", "kind": kind, "y": [abs(v) if kind in ("rl", "il") else v for v in cols[c]]})
        blob = meta_text + " " + text[:800].lower() + " " + " ".join(names).lower()
        fmt = ("fieldfox" if re.search(r"fieldfox|keysight|agilent", blob) else
               "anritsu" if re.search(r"anritsu|site\s*master|line\s*sweep|\bs3\d\d[a-z]\b|\bs4\d\d[a-z]\b|\bs8\d\d[a-z]\b", blob) else
               "rigexpert" if "rigexpert" in blob else "nanovna" if "nanovna" in blob else "table")
    if not x:
        raise ValueError("No trace found in that file.")
    keep = list(range(len(x)))
    if len(keep) > SWEEP_MAX:
        keep = [int(i * len(x) / SWEEP_MAX) for i in range(SWEEP_MAX)]
    pick = lambda pat: next((v for k, v in meta.items() if re.search(pat, k, re.I)), "")  # noqa: E731
    return {"format": fmt, "meta": meta, "instrument": " ".join(v for v in (pick(r"^(model|instrument|device)") or pick(r"^title$"), pick(r"serial")) if v),
            "date": pick(r"date|time"), "measurement": pick(r"^meas") or pick(r"^mode\b"), "x_kind": xk, "x_unit": xu, "x": [round(x[i], 6) for i in keep],
            "series": [{**s, "y": [round(s["y"][i], 4) for i in keep]} for s in series], "points": len(keep)}


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
    "name": ["name", "fullname", "displayname", "contact", "contactname", "person"],
    # Google Contacts ("Organization Name", "Organization 1 - Name") and Outlook ("Company") exports too
    "org": ["org", "organization", "organisation", "organizationname", "organization1name", "company", "agency", "employer"],
    "role": ["role", "title", "jobtitle", "organizationtitle", "organization1title", "position", "type"],
    "phone": ["phone", "phonenumber", "phone1value", "mobilephone", "businessphone", "mobile", "cell", "tel", "telephone"],
    "email": ["email", "emailaddress", "email1value", "e-mailaddress", "mail"],
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


def read_contacts(name, data):
    """The contacts in a file, read and not saved: a vCard, or any table with a name, organisation or email column."""
    text = data.decode("utf-8-sig", "replace")
    if "BEGIN:VCARD" in text.upper():
        found = parse_vcards(text)
    else:
        _, head, rows = read_table(name, data)
        m = guess_mapping(head, CONTACT_ALIASES)
        norm = {re.sub(r"[^a-z0-9]", "", h.lower()): h for h in head}
        first = next((norm[k] for k in ("firstname", "givenname") if k in norm), None)
        last = next((norm[k] for k in ("lastname", "familyname", "surname") if k in norm), None)
        if "name" not in m and "org" not in m and "email" not in m and not first:
            raise ValueError("No name, organisation or email column found.")
        found = []
        for r in rows:
            c = {f: r.get(h, "") for f, h in m.items()}
            if not (c.get("name") or "").strip() and (first or last):  # Google's export: First Name + Last Name, no Name
                c["name"] = " ".join(x for x in ((r.get(first) or "").strip() if first else "", (r.get(last) or "").strip() if last else "") if x)
            for f in ("email", "phone"):  # Google puts several in one cell: "a@x.com ::: b@y.com"
                if c.get(f):
                    c[f] = str(c[f]).split(":::")[0].strip()
            found.append(c)
    return found


def import_contacts(con, name, data):
    found = read_contacts(name, data)
    cs = list_contacts(con)
    have = {((c["name"] or "").lower(), (c["org"] or "").lower()) for c in cs}
    emails = {(c["email"] or "").strip().lower() for c in cs if c["email"]}
    added = 0
    for c in found:
        em = (c.get("email") or "").strip().lower()
        key = ((c.get("name") or "").lower(), (c.get("org") or "").lower())
        if not any(key) and not em:
            continue
        if (any(key) and key in have) or (em and em in emails):
            continue
        if not any(key):  # an email-only contact: named from its address until you rename it
            c["name"] = em.split("@")[0].replace(".", " ").replace("_", " ").title()
        save_contact(con, c)
        have.add(((c.get("name") or "").lower(), (c.get("org") or "").lower()))
        if em:
            emails.add(em)
        added += 1
    return {"found": len(found), "added": added}


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", (s or "").strip()).strip(" .")[:120] or "file"


def job_dir(jid, name, create=True):
    """DAStastic/DAS jobs/0007 Some building: one folder per job, found by its number if the job is renamed."""
    if os.path.isdir(DAS_DIR):
        for d in os.listdir(DAS_DIR):
            if d.startswith(f"{jid:04d} ") and os.path.isdir(os.path.join(DAS_DIR, d)):
                return os.path.join(DAS_DIR, d)
    path = os.path.join(DAS_DIR, f"{jid:04d} {safe_name(name)}")
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def list_files(jid, name, con=None):
    """A job's files as the disk has them. With con, each one DAStastic has recorded (das_file) also says what it is."""
    d = job_dir(jid, name, create=False)
    files = []
    if os.path.isdir(d):
        for f in sorted(os.listdir(d)):
            p = os.path.join(d, f)
            if os.path.isfile(p) and f.lower() != "desktop.ini" and not f.endswith(".part"):
                files.append({"name": f, "size": os.path.getsize(p), "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p)))})
    if con is not None and files:
        kinds = dict(con.execute("SELECT name, kind FROM das_file WHERE job_id=?", (jid,)).fetchall())
        for x in files:
            if kinds.get(x["name"]):
                x["kind"] = kinds[x["name"]]
        if "sealed_report" in kinds.values():  # what its seal says now: the email box and the packet go by this, not the name
            seals = {s["name"]: s for s in sealed_files(con, jid)}
            for x in files:
                if x["name"] in seals:
                    x.update(seal=seals[x["name"]]["code"], seal_current=seals[x["name"]]["current"], packet=seals[x["name"]]["packet"])
    return {"folder": d, "files": files}


def file_path(jid, name, fname):
    d = job_dir(jid, name, create=False)
    p = os.path.realpath(os.path.join(d, safe_name(os.path.basename(fname or ""))))
    if not p.startswith(os.path.realpath(d) + os.sep):
        raise ValueError("Bad file name.")
    return p


def _free_path(jid, name, fname):
    job_dir(jid, name)
    p = file_path(jid, name, fname)
    base, ext = os.path.splitext(p)
    i = 2
    while os.path.exists(p):  # never overwrite: "plan.pdf" becomes "plan (2).pdf"
        p = f"{base} ({i}){ext}"
        i += 1
    return p


def save_file(jid, name, fname, data):
    p = _free_path(jid, name, fname)
    with open(p + ".part", "wb") as fh:
        fh.write(data)
    os.replace(p + ".part", p)
    return os.path.basename(p)


def save_path(jid, name, fname, src):
    """A file already on disk into the job's folder, copied so a plan set of hundreds of MB isn't read into memory."""
    p = _free_path(jid, name, fname)
    shutil.copyfile(src, p + ".part")
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
    "as_of": ["effectivedate", "effective", "pricedate", "priceeffective", "asof", "listdate", "dateeffective"],  # the price's own date
    "freq": ["frequencyrange", "frequency", "freqrange", "freq", "frequencymhz", "bands", "band", "mhz"],  # kept as code fields, for the wrong-part guard
    "connector": ["connector", "connectortype", "interface", "connectors"],
    "power": ["powerrating", "maxpower", "averagepower", "avgpower", "ratedpower", "power", "watts"],
}
SPEC_MAX = 30 * 1024 * 1024

# Price history: what each supplier charged for a part, dated. It only ever comes from the firm's own dated price files, a
# price typed by hand, or a quote's price the firm keeps: never from a distributor's online API, whose terms don't allow it
# (Digi-Key's bar building a database; Nexar's bar historical use). prices.py's answers stay on the request they priced.
PRICE_SCHEMA = """
CREATE TABLE IF NOT EXISTS das_part_price(id INTEGER PRIMARY KEY, supplier TEXT NOT NULL DEFAULT '', key TEXT NOT NULL, part TEXT, price REAL,
    at TEXT, seen_at TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS das_part_price_key ON das_part_price(supplier, key, at);
CREATE TABLE IF NOT EXISTS das_bom_kit(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, lines TEXT, updated_at TEXT);
"""
SCHEMA += PRICE_SCHEMA
TABLES = TABLES + ("das_part_price", "das_bom_kit")


def _list_date(v):
    """A date in a price list -> YYYY-MM-DD, or "" when it isn't one: 2026-03-01, 3/1/2026, 3-1-26, or an Excel date number."""
    t = str(v if v is not None else "").strip()
    if not t:
        return ""
    m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", t)
    y, mo, d = (m.groups() if m else (None, None, None))
    if not m:
        m = re.match(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b", t)
        if m:
            mo, d, y = m.groups()
            y = y if len(y) == 4 else "20" + y
    if m:
        try:
            return datetime(int(y), int(mo), int(d)).strftime("%Y-%m-%d")
        except ValueError:
            return ""
    if re.fullmatch(r"\d{5}(\.0+)?", t) and 30000 < float(t) < 70000:  # Excel counts days from 1899-12-30
        return datetime.fromordinal(693594 + int(float(t))).strftime("%Y-%m-%d")
    return ""


def _price(v):
    if v is None or v == "":
        return None
    try:
        return round(float(re.sub(r"[^0-9.\-]", "", str(v))), 4)
    except ValueError:
        return None


def _part_key(part, item):
    return re.sub(r"\s+", " ", (part or item or "").strip().lower())


def _keep_price(con, supplier, key, part, price, at=None, source=""):
    """One supplier's price for a part into its history, dated. The same price again only moves "last seen". Returns True
    when a new price was kept."""
    if price is None:
        return False
    at = at or now()
    rows = con.execute("SELECT id, price, at, seen_at FROM das_part_price WHERE supplier=? AND key=? ORDER BY at, id", (supplier, key)).fetchall()
    before = [r for r in rows if (r["at"] or "")[:10] <= at[:10]]
    if before and abs((before[-1]["price"] or 0) - price) < 0.00005:
        if (before[-1]["seen_at"] or "") < at:
            con.execute("UPDATE das_part_price SET seen_at=? WHERE id=?", (at, before[-1]["id"]))
        return False
    con.execute("INSERT INTO das_part_price(supplier, key, part, price, at, seen_at, source) VALUES(?,?,?,?,?,?,?)",
                (supplier, key, part, price, at, at, source))
    return True


def _price_rows(con, supplier, key):
    return con.execute("SELECT * FROM das_part_price WHERE supplier=? AND key=? ORDER BY at DESC, id DESC", (supplier, key)).fetchall()


def import_parts(con, name, data, supplier="", as_of="", source="price list"):
    """A supplier's price list (CSV, TSV, Excel or JSON) into the catalogue: columns found by their names. A part
    already kept (same supplier and part number) gets the new description, price and link; its star, default
    quantity and uploaded spec sheet stay. Every price goes into the part's dated history (das_part_price), the old price
    with it: as_of is the list's date (a column of its own wins, line by line; neither: today). A list older than a part's
    newest price adds to its history and leaves its current price alone."""
    _, head, rows = read_table(name, data)
    m = guess_mapping(head, PART_ALIASES)
    if "part" not in m and "item" not in m:
        raise ValueError("No part number or description column found. Columns read: " + ", ".join(head[:12]))
    list_at = _list_date(as_of)
    if str(as_of or "").strip() and not list_at:
        raise ValueError(f"The price list's date doesn't read as a date: {as_of}.")
    added = updated = changed = older = 0
    for r in rows:
        x = {f: str(r.get(h) if r.get(h) is not None else "").strip() for f, h in m.items()}
        part, item = x.get("part", ""), x.get("item", "")
        if not part and not item:
            continue
        sup = (supplier or x.get("supplier") or "").strip()
        key = _part_key(part, item)
        old = con.execute("SELECT id, price, part, updated_at FROM das_part WHERE supplier=? AND key=?", (sup, key)).fetchone()
        price, at = _price(x.get("price")), _list_date(x.get("as_of")) or list_at
        had = _price_rows(con, sup, key) if old else []
        if old and old["price"] is not None and not had:  # a part kept before price history began: its price keeps the date it has
            _keep_price(con, sup, key, old["part"], old["price"], old["updated_at"] or now(), "before price history")
            had = _price_rows(con, sup, key)
        is_older = bool(at and had and at < (had[0]["at"] or "")[:10])
        con.execute("""INSERT INTO das_part(supplier, key, part, item, maker, cat, unit, price, spec_url, weight_lb, updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(supplier, key) DO UPDATE SET part=excluded.part,
                       weight_lb=COALESCE(excluded.weight_lb, weight_lb),
                       item=COALESCE(NULLIF(excluded.item,''), item), maker=COALESCE(NULLIF(excluded.maker,''), maker),
                       cat=COALESCE(NULLIF(excluded.cat,''), cat), unit=COALESCE(NULLIF(excluded.unit,''), unit),
                       price=COALESCE(excluded.price, price), spec_url=COALESCE(NULLIF(excluded.spec_url,''), spec_url),
                       updated_at=excluded.updated_at""",
                    (sup, key, part, item, x.get("maker", ""), x.get("cat", ""), x.get("unit", ""), None if is_older else price,
                     x.get("spec_url", ""), _price(x.get("weight_lb")), now()))
        added, updated = (added, updated + 1) if old else (added + 1, updated)
        if price is not None:
            kept = _keep_price(con, sup, key, part, price, at or now(), source)
            changed += 1 if kept and old else 0
            older += 1 if is_older else 0
        if any(x.get(f) for f in _LIST_CODES):  # the guard's facts, where the list has them: never over a spec sheet's or a person's value
            row = con.execute("SELECT id, codes FROM das_part WHERE supplier=? AND key=?", (sup, key)).fetchone()
            codes = _codes(row)
            for f in _LIST_CODES:
                if x.get(f) and (f not in codes or codes[f].get("src") == "price list"):
                    codes[f] = {"v": re.sub(r"\s+", " ", x[f])[:120], "src": "price list"}
            con.execute("UPDATE das_part SET codes=? WHERE id=?", (json.dumps(codes), row["id"]))
    con.commit()
    return {"rows": len(rows), "added": added, "updated": updated, "columns": m, "prices_changed": changed, "older": older, "as_of": list_at,
            "total": con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0]}


# ERCES code fields on every part (11/4): what an AHJ checks on a submittal's parts, each with where its value came from
# ("grant": the FCC's equipment authorization, "spec sheet": read off the maker's sheet, "typed": entered by hand)
CODE_FIELDS = [("ul2524", "UL 2524", "edition and listing, e.g. 3rd ed., E123456"), ("booster_class", "Class", "A or B (47 CFR 90.219)"),
               ("fcc_id", "FCC ID", "from the label"), ("nema", "NEMA", "e.g. 4X"),
               ("rating_2h", "2-hour rating", "pathway or enclosure, e.g. UL 2196 2 h"), ("pim", "PIM", "e.g. -160 dBc @ 2x43 dBm"),
               ("freq", "Frequency", "what it covers, e.g. 698-2700 MHz"), ("connector", "Connector", "e.g. N female, 4.3-10"),
               ("power", "Power rating", "average watts, e.g. 300 W")]
_LIST_CODES = ("freq", "connector", "power")  # a price list's own columns for these land in the code fields, marked "price list"
CODE_SOURCES = ("grant", "spec sheet", "typed")
GRANT_SUPPLIER = ""  # boosters from FCC grants have no supplier: a supplier's price list adds its own line for the same unit
GRANT_CAT = "Signal booster (Part 90)"
_SRC = {  # the rule behind each check, as rf_parts.json's research cites it
    "nfpa1225": ("NFPA 1225 (2022) ch. 18", "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download"),
    "ifc2024": ("IFC 2024 510", "https://codes.iccsafe.org/content/IFC2024V2.0/chapter-5-fire-service-features"),
    "90.219": ("47 CFR 90.219", "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-D/part-90/subpart-I/section-90.219"),
    "intertek": ("Intertek: UL 2524 listings not updated to the 3rd edition by 2026-03-22 are withdrawn",
                 "https://www.intertek.com/siteassets/resources/sun/2025/ul-2524-sun-rev-3-22-2024-ed-3-22-2026.pdf"),
}


def part_kind(r):
    """What a part is, for which code fields its line must carry: booster (BDAs, repeaters, fiber DAS units), power
    (battery backup, power supplies, chargers), annunciator, enclosure, cable (backbone cable and pathways), or passive."""
    t = f"{r.get('cat') or ''} {r.get('item') or ''}".lower()
    if r.get("grant_info"):
        return "booster"
    if re.search(r"battery|\bbbu\b|power suppl|charger", t):  # before boosters: "BDA battery backup unit" is power
        return "power"
    if re.search(r"booster|\bbda\b|repeater|fiber das|optic(?:al)? unit|head.?end|remote unit|master unit", t):
        return "booster"
    if re.search(r"annunciator|monitoring panel", t):
        return "annunciator"
    if re.search(r"enclosure|cabinet", t):
        return "enclosure"
    if re.search(r"cable|coax|pathway|riser|backbone|heliax|radiating", t):
        return "cable"
    return "passive"


def part_checks(r, codes=None):
    """The code checks for one part: [{field, status ("missing": required and not recorded, "problem": recorded and
    short of the rule, "check": depends on the building or a later step), text, source: [{label, url}]}]. None for
    passives."""
    codes = codes if codes is not None else _codes(r)
    v = lambda f: str((codes.get(f) or {}).get("v") or "").strip()
    kind, out = part_kind(r), []

    def add(field, status, text, *keys):
        out.append({"field": field, "status": status, "text": text,
                    "source": [{"label": _SRC[k][0], "url": _SRC[k][1]} for k in keys]})
    if kind in ("booster", "power", "annunciator"):
        if not v("ul2524"):
            add("ul2524", "missing", "UL 2524 listing not recorded: NFPA 1225 (2022) 18.12.1.3, IFC 2024 510.4", "nfpa1225", "ifc2024")
        elif re.search(r"\b(1st|2nd|first|second)\b|\bed(ition)?\.?\s*[12]\b", v("ul2524"), re.I):
            add("ul2524", "problem", "Not the 3rd edition: listings not updated by 2026-03-22 are withdrawn", "intertek")
    if kind == "booster":
        n = re.sub(r"type", "", v("nema"), flags=re.I).strip().upper()
        if not n:
            add("nema", "missing", "NEMA 4 or 4X enclosure not recorded: NFPA 1225 (2022) 18.3.1.1, IFC 2024 510.4.2.4", "nfpa1225", "ifc2024")
        elif not re.fullmatch(r"4X?(\s*/\s*4X?)*", n):
            add("nema", "problem", f"NEMA {v('nema')}: boosters need NEMA 4 or 4X (NFPA 1225 (2022) 18.3.1.1)", "nfpa1225")
        if not v("fcc_id"):
            add("fcc_id", "missing", "FCC ID not recorded: a Part 90 booster carries one on its label (47 CFR 90.219)", "90.219")
        if not v("booster_class"):
            add("booster_class", "missing", "Class A or B not recorded (47 CFR 90.219)", "90.219")
        elif "B" in v("booster_class").upper():
            add("booster_class", "check", "Class B: registered with the FCC before it's switched on (47 CFR 90.219(d)(5))", "90.219")
    if kind == "power" and not v("nema"):
        add("nema", "check", "Batteries in NEMA 3R or better: NFPA 1225 (2022) 18.3.1.2", "nfpa1225")
    if kind == "enclosure" and not v("nema"):
        add("nema", "missing", "NEMA rating not recorded: NFPA 1225 (2022) 18.3.1", "nfpa1225")
    if kind == "cable" and not v("rating_2h"):
        add("rating_2h", "check", "2-hour rating not recorded: needed where the building isn't fully sprinklered and its frame is "
            "rated 2 h (NFPA 1225 (2022) 18.12.3.3-18.12.3.6)", "nfpa1225")
    return out


def _json(v, default):
    try:
        return json.loads(v) if v else default
    except (TypeError, ValueError):
        return default


def _codes(r):
    return _json(r.get("codes") if isinstance(r, dict) else r["codes"], {})


def _part_row(r):
    d = dict(r)
    d.pop("key", None)
    d["standard"] = bool(d.get("standard"))
    d["codes"] = _codes(d)
    d["grant"] = _json(d.pop("grant_info", None), None)
    d["pattern"] = _json(d.get("pattern"), None)  # a Planet antenna pattern (save_pattern)
    d["kind"] = part_kind(dict(d, grant_info=d["grant"]))
    d["checks"] = part_checks(dict(d, grant_info=d["grant"]), d["codes"])
    import prohibited  # the FCC's prohibited-entity lists: a Covered List maker, or a same-name match to check
    got = prohibited.check(maker=d.get("maker"), text=f"{d.get('maker') or ''} {d.get('item') or ''}")
    d["lists"] = {"listed": got["listed"], "same_name": got["same_name"]} if got["listed"] or got["same_name"] else None
    return d


# the catalogue's columns a header can sort by (Materials' parts list shows the first ones, so the sort is the server's)
PART_SORT = ("standard", "part", "item", "maker", "supplier", "price", "unit", "weight_lb", "std_qty")


def list_parts(con, q="", standard=False, ids=None, limit=200, grants=False, sort=None, desc=False):
    """Search the catalogue (part number, description, maker, supplier, FCC ID); or just the standard parts; or the
    boosters from FCC grants; or given ids. sort (one of PART_SORT) orders every match by that column before the limit,
    text without case, blanks last either way (as a spreadsheet does); without it, standard parts first, by supplier."""
    where, args = [], []
    if ids:
        where.append(f"id IN ({','.join('?' * len(ids))})")
        args += list(ids)
    if standard:
        where.append("standard=1")
    if grants:
        where.append("grant_info IS NOT NULL")
    for w in (q or "").split()[:6]:
        where.append("(part LIKE ? OR item LIKE ? OR maker LIKE ? OR supplier LIKE ? OR cat LIKE ? OR fcc_id LIKE ?)")
        args += [f"%{w}%"] * 6
    sql = "SELECT * FROM das_part" + (" WHERE " + " AND ".join(where) if where else "")
    total = con.execute(sql.replace("SELECT *", "SELECT COUNT(*)", 1), args).fetchone()[0]
    order = "standard DESC, supplier, part"
    if sort in PART_SORT:  # a known column only: nothing typed reaches the SQL
        order = f"({sort} IS NULL OR {sort} = ''), {sort} COLLATE NOCASE {'DESC' if desc else 'ASC'}, {order}"
    rows = con.execute(sql + f" ORDER BY {order} LIMIT ?", args + [int(limit)]).fetchall()
    return {"parts": [_part_row(r) for r in rows], "total": total,
            "all": con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0],
            "grants": con.execute("SELECT COUNT(*) FROM das_part WHERE grant_info IS NOT NULL").fetchone()[0],
            "suppliers": [r[0] for r in con.execute("SELECT DISTINCT supplier FROM das_part WHERE supplier<>'' ORDER BY supplier")],
            "code_fields": [{"key": k, "label": lab, "hint": h} for k, lab, h in CODE_FIELDS], "code_sources": list(CODE_SOURCES)}


def _merge_codes(old, new):
    """A part's code fields with the ones given: {field: {"v": value, "src": "spec sheet" | "typed"}}; an empty value
    removes the field. "grant" is only ever set by the FCC grant import."""
    out = dict(old or {})
    if not isinstance(new, dict):
        raise ValueError("Code fields come as {field: {v, src}}.")
    keys = {k for k, _, _ in CODE_FIELDS}
    for f, x in new.items():
        if f not in keys:
            raise ValueError(f"Unknown code field {f}: one of {', '.join(sorted(keys))}.")
        x = x if isinstance(x, dict) else {"v": x}
        v = re.sub(r"\s+", " ", str(x.get("v") if x.get("v") is not None else "")).strip()[:120]
        src = x.get("src") or "typed"
        if src not in CODE_SOURCES[1:]:
            raise ValueError(f"Where a value came from is one of: {', '.join(CODE_SOURCES[1:])}.")
        if v:
            out[f] = {"v": v, "src": src}
        else:
            out.pop(f, None)
    return out


def save_part(con, d, pid=None):
    """A part added by hand, or a kept part's star, default quantity, price, link, description or code fields changed."""
    f = {k: d[k] for k in ("supplier", "part", "item", "maker", "cat", "unit", "spec_url") if k in d}
    if "price" in d:
        f["price"] = _price(d["price"])
    if "standard" in d:
        f["standard"] = 1 if d["standard"] else 0
    if "std_qty" in d:
        f["std_qty"] = _price(d["std_qty"])
    if "weight_lb" in d:
        f["weight_lb"] = _price(d["weight_lb"])
    cur, old_codes = None, {}
    if pid is not None:
        cur = con.execute("SELECT part, item, codes, supplier, key, price, updated_at FROM das_part WHERE id=?", (pid,)).fetchone()
        if not cur:
            raise LookupError("That part was deleted.")
        old_codes = _codes(cur)
    if "codes" in d:
        given = d["codes"]
        if d.get("fill_only") and isinstance(given, dict):  # a press on a proposal (dasread.js): a field with a value keeps it, whoever filled it, however late
            given = {k: v for k, v in given.items() if not str((old_codes.get(k) or {}).get("v") or "").strip()}
        codes = _merge_codes(old_codes, given)
        f["codes"] = json.dumps(codes) if codes else None
        f["fcc_id"] = (codes.get("fcc_id") or {}).get("v") or None
    f["updated_at"] = now()
    was = cur
    if pid is None:
        if not (f.get("part") or f.get("item")):
            raise ValueError("A part needs a part number or a description.")
        f.setdefault("supplier", "")
        f["key"] = _part_key(f.get("part"), f.get("item"))
        cur = con.execute(f"INSERT INTO das_part({','.join(f)}) VALUES({','.join('?' * len(f))}) ON CONFLICT(supplier, key) DO NOTHING",
                          list(f.values()))
        pid = cur.lastrowid if cur.rowcount else con.execute("SELECT id FROM das_part WHERE supplier=? AND key=?", (f["supplier"], f["key"])).fetchone()[0]
    else:
        if "part" in f or "item" in f:
            f["key"] = _part_key(f.get("part", cur["part"]), f.get("item", cur["item"]))
        con.execute(f"UPDATE das_part SET {','.join(k + '=?' for k in f)} WHERE id=?", list(f.values()) + [pid])
        if f.get("key", cur["key"]) != cur["key"] or f.get("supplier", cur["supplier"]) != cur["supplier"]:  # its history stays with it
            con.execute("UPDATE das_part_price SET supplier=?, key=? WHERE supplier=? AND key=?",
                        (f.get("supplier", cur["supplier"]), f.get("key", cur["key"]), cur["supplier"], cur["key"]))
    r = con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone()
    if "price" in d and r["price"] is not None:
        if was is not None and was["price"] is not None and not _price_rows(con, r["supplier"], r["key"]):
            _keep_price(con, r["supplier"], r["key"], r["part"], was["price"], was["updated_at"] or now(), "before price history")
        _keep_price(con, r["supplier"], r["key"], r["part"], r["price"], now(), "typed")
    con.commit()
    return _part_row(r)


def _pn(s):
    """A part number with its punctuation and case gone: "LDF4 50A", "ldf4-50a" and "LDF4/50A" are one part."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def price_on(con, supplier, key, day):
    """What a supplier's part cost on a day: the newest price dated on or before it, or None when the history starts later."""
    return next((r for r in _price_rows(con, supplier, key) if (r["at"] or "")[:10] <= day[:10]), None)


def _lookup_row(con, r, day=""):
    d, rows = _part_row(r), _price_rows(con, r["supplier"], r["key"])
    d["price_at"] = (rows[0]["seen_at"] or rows[0]["at"] or "")[:10] if rows else (r["updated_at"] or "")[:10]
    if day:
        then = price_on(con, r["supplier"], r["key"], day)
        d["price_then"] = {"price": then["price"], "at": (then["at"] or "")[:10], "source": then["source"] or ""} if then else None
    return d


def lookup_part(con, text, as_of="", supplier="", limit=12):
    """A part number typed on a bill-of-materials line: {query, found, matches: its parts, the line's supplier first, then
    the cheapest; near: what looks like it when nothing matches}. With as_of, each match says what it cost that day."""
    t, day = (text or "").strip(), _list_date(as_of)
    if str(as_of or "").strip() and not day:
        raise ValueError(f"That doesn't read as a date: {as_of}.")
    if not t:
        return {"query": "", "found": False, "matches": [], "near": [], "as_of": day}
    order = " ORDER BY supplier=? DESC, price IS NULL, price, id LIMIT ?"
    rows = con.execute("SELECT * FROM das_part WHERE key=?" + order, (_part_key(t, ""), supplier or "", int(limit))).fetchall()
    if not rows and _pn(t):  # the same part with other punctuation
        strip = "LOWER(COALESCE(part,''))"
        for ch in "- /._":
            strip = f"REPLACE({strip},'{ch}','')"
        rows = con.execute(f"SELECT * FROM das_part WHERE {strip}=?" + order, (_pn(t), supplier or "", int(limit))).fetchall()
    near = [] if rows else list_parts(con, t, limit=limit)["parts"]
    return {"query": t, "found": bool(rows), "matches": [_lookup_row(con, r, day) for r in rows], "near": near, "as_of": day}


def price_history(con, pid):
    """A part's price now and every dated price for the same part number, this supplier's and the others', newest first."""
    r = con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone()
    if not r:
        raise LookupError("That part was deleted.")
    rows = con.execute("SELECT * FROM das_part_price WHERE key=? ORDER BY at DESC, id DESC", (r["key"],)).fetchall()
    out = [dict(x) for x in rows]
    for i, x in enumerate(out):  # each price against the same supplier's price before it
        prev = next((y for y in out[i + 1:] if y["supplier"] == x["supplier"]), None)
        x["was"] = prev["price"] if prev else None
        x["pct"] = round((x["price"] - prev["price"]) / prev["price"] * 100, 1) if prev and prev["price"] else None
    return {"id": r["id"], "part": r["part"], "item": r["item"], "maker": r["maker"], "supplier": r["supplier"], "price": r["price"],
            "unit": r["unit"], "history": out}


def _mhz(bands):
    if not bands:
        return ""
    t = ", ".join(f"{lo:g}-{hi:g}" if lo != hi else f"{lo:g}" for lo, hi in bands[:6])
    return t + (f" +{len(bands) - 6} more" if len(bands) > 6 else "") + " MHz"


def grant_power(g):
    """The FCC's power range for a booster: its weakest band's range low end to its strongest band's high end."""
    w = g.get("watts")
    if not w:
        return ""
    lo = g["watts_from"] if g.get("watts_from") is not None else w[0]
    return f"{min(lo, w[0]):g}-{w[1]:g} W"


def _grant_item(g):
    return "; ".join(x for x in (f"{g['maker']} {g['model']}", g.get("class_name") or "signal booster", _mhz(g.get("bands") or []),
                                 grant_power(g)) if x)


def parts_from_grants(con):
    """Every US public safety signal booster on the kept FCC grants (Part 90 Class A and B, fccid.booster_parts) as a
    part: FCC ID as its part number, maker, model, class, bands, power, grant date and its FCC record. A part already
    kept keeps its star, price, spec sheet and every code field typed or read off a spec sheet; the grant's own facts
    (FCC ID, class, bands, dates) are brought up to date. Returns {devices, added, updated, total}."""
    import fccid
    devs = fccid.booster_parts(con)
    added = updated = 0
    for g in devs:
        key = _part_key(g["fcc_id"], "")
        info = dict(g, item=_grant_item(g), power=grant_power(g))
        old = con.execute("SELECT id, item, codes, grant_info FROM das_part WHERE supplier=? AND key=?", (GRANT_SUPPLIER, key)).fetchone()
        codes = _codes(old) if old else {}
        for f, v in (("fcc_id", g["fcc_id"]), ("booster_class", g["booster_class"])):
            if v and (f not in codes or codes[f].get("src") == "grant"):
                codes[f] = {"v": v, "src": "grant"}
        if old:
            was = (_json(old["grant_info"], None) or {}).get("item")
            item = info["item"] if not old["item"] or old["item"] == was else old["item"]  # a description edited by hand stays
            con.execute("UPDATE das_part SET item=?, fcc_id=?, grant_info=?, codes=?, maker=COALESCE(NULLIF(maker,''), ?), "
                        "cat=COALESCE(NULLIF(cat,''), ?), updated_at=? WHERE id=?",
                        (item, g["fcc_id"], json.dumps(info), json.dumps(codes), g["maker"], GRANT_CAT, now(), old["id"]))
            updated += 1
        else:
            con.execute("INSERT INTO das_part(supplier, key, part, item, maker, cat, unit, fcc_id, grant_info, codes, updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?)", (GRANT_SUPPLIER, key, g["fcc_id"], info["item"], g["maker"], GRANT_CAT, "ea",
                                                          g["fcc_id"], json.dumps(info), json.dumps(codes), now()))
            added += 1
    con.commit()
    return {"devices": len(devs), "added": added, "updated": updated,
            "total": con.execute("SELECT COUNT(*) FROM das_part").fetchone()[0]}


def sync_grant_parts(con):
    """parts_from_grants when the kept grants changed since it last ran (a marker beside the spec sheets holds what it
    saw), so a grant import shows in the catalogue without a click. A part deleted by hand comes back only when the
    grants change again. Returns the parts_from_grants answer, or None when nothing changed."""
    import fccid
    src = fccid.grants_source(con)
    if not src["devices"]:
        return None
    sig = json.dumps([src["devices"], src["lines"], src["at"], sorted(src["classes"].items())])
    mark = os.path.join(spec_dir(), ".grants")
    try:
        with open(mark, encoding="utf-8") as fh:
            if fh.read() == sig:
                return None
    except OSError:
        pass
    res = parts_from_grants(con)
    with open(mark, "w", encoding="utf-8") as fh:
        fh.write(sig)
    return res


# ---------------------------------------------------------------- antenna patterns (Planet .msi / .pln, 11/4)
# The Planet format makers publish their antenna patterns in: keyword lines (NAME, MAKE, FREQUENCY, GAIN, H_WIDTH,
# V_WIDTH, FRONT_TO_BACK, TILT, POLARIZATION, COMMENT), then HORIZONTAL 360 and VERTICAL 360, each followed by lines of
# "angle loss": degrees, and dB below the peak. GAIN with no unit is dBd (the format's own default). Files come from
# the maker or a person's own folder: nothing here fetches or republishes them.
PATTERN_MAX = 2 * 1024 * 1024


def parse_msi(text):
    """A Planet .msi / .pln file -> {name, make, freq_mhz, gain_dbi, gain_given, h_width, v_width, front_to_back, tilt,
    polarization, comment, horizontal: [360 dB losses, one per degree], vertical: [...], h_width_measured,
    v_width_measured}. Refuses a file without both 360-point cuts."""
    head, cuts, cur = {}, {}, None
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        m = re.match(r"(HORIZONTAL|VERTICAL)\s+(\d+)\s*$", s, re.I)
        if m:
            cur = cuts.setdefault(m.group(1).lower(), {})
            continue
        if cur is not None and re.match(r"^-?\d+(\.\d+)?\s+-?\d+(\.\d+)?$", s):
            a, v = s.split()
            cur[int(round(float(a))) % 360] = abs(float(v))
            continue
        k, _, v = s.partition(" ")
        if re.fullmatch(r"[A-Z_]+", k.upper()) and cur is None:
            head[k.upper()] = v.strip()
    for c in ("horizontal", "vertical"):
        if len(cuts.get(c) or {}) < 360:
            raise ValueError(f"No {c} pattern of 360 points in the file ({len(cuts.get(c) or {})} read): not a Planet .msi / .pln file.")
    num = lambda k: (lambda m: float(m.group(0)) if m else None)(re.search(r"-?\d+(\.\d+)?", head.get(k, "")))
    g = num("GAIN")
    unit = "dBi" if re.search(r"dbi", head.get("GAIN", ""), re.I) else "dBd"
    h = [cuts["horizontal"][a] for a in range(360)]
    v = [cuts["vertical"][a] for a in range(360)]
    return {"name": head.get("NAME", ""), "make": head.get("MAKE", ""), "freq_mhz": num("FREQUENCY"),
            "gain_dbi": None if g is None else round(g + (2.15 if unit == "dBd" else 0), 2), "gain_given": head.get("GAIN", ""),
            "h_width": num("H_WIDTH"), "v_width": num("V_WIDTH"), "front_to_back": num("FRONT_TO_BACK"),
            "tilt": head.get("TILT", ""), "polarization": head.get("POLARIZATION", ""), "comment": head.get("COMMENT", "")[:300],
            "horizontal": h, "vertical": v, "h_width_measured": beamwidth(h), "v_width_measured": beamwidth(v)}


def beamwidth(cut, down=3.0):
    """The -3 dB width (degrees) around the cut's peak, from the 1-degree points; 360 for an omni cut."""
    peak = min(range(360), key=lambda a: cut[a])
    lim = cut[peak] + down
    if all(x <= lim for x in cut):
        return 360
    w = 1
    for step in (1, -1):
        a = peak
        while cut[(a + step) % 360] <= lim:
            a += step
            w += 1
    return w


def save_pattern(con, pid, name, data):
    """A Planet pattern file onto a part (pid), or a new antenna part named by the file's NAME and MAKE (pid None; the
    same name again updates it). Returns the part."""
    if len(data) > PATTERN_MAX:
        raise ValueError("That pattern file is over 2 MB: a Planet .msi is a few kB.")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("cp1252", "replace")
    pat = dict(parse_msi(text), file=os.path.basename(name or "")[:120])
    if pid is None:
        part = pat["name"] or os.path.splitext(pat["file"])[0]
        if not part:
            raise ValueError("The file names no antenna (NAME line), and has no file name.")
        p = save_part(con, {"part": part, "item": f"Antenna{', ' + str(round(pat['freq_mhz'])) + ' MHz' if pat['freq_mhz'] else ''}"
                                                   f"{', ' + str(pat['gain_dbi']) + ' dBi' if pat['gain_dbi'] is not None else ''}",
                            "maker": pat["make"], "cat": "Antenna", "unit": "ea"})
        pid = p["id"]
    elif not con.execute("SELECT 1 FROM das_part WHERE id=?", (pid,)).fetchone():
        raise LookupError("That part was deleted.")
    con.execute("UPDATE das_part SET pattern=?, updated_at=? WHERE id=?", (json.dumps(pat), now(), pid))
    con.commit()
    return _part_row(con.execute("SELECT * FROM das_part WHERE id=?", (pid,)).fetchone())


def spec_dir(create=True):
    d = os.path.join(DAS_DIR, "_spec sheets")
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def delete_part(con, pid):
    r = con.execute("SELECT spec_file, supplier, key FROM das_part WHERE id=?", (pid,)).fetchone()
    if r and r["spec_file"]:
        fp = os.path.join(spec_dir(False), r["spec_file"])
        if os.path.isfile(fp):
            os.remove(fp)
    if r:  # its dated prices go with it: a bill of materials line keeps the price it was quoted at either way
        con.execute("DELETE FROM das_part_price WHERE supplier=? AND key=?", (r["supplier"], r["key"]))
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


BOM_FIELDS = ["category", "item", "part", "supplier", "qty", "unit", "price", "line_total", "note",
              "ul_2524", "class", "fcc_id", "nema", "rating_2h", "pim", "code_checks"]
_BOM_CODE = {"ul2524": "ul_2524", "booster_class": "class", "fcc_id": "fcc_id", "nema": "nema", "rating_2h": "rating_2h", "pim": "pim"}


def with_part_codes(con, job):
    """The job with each bill-of-materials line's code fields and checks from its catalogue part (the AHJ packet's parts
    list carries them): line["codes"], line["checks"]. A line with no catalogue part is checked as typed."""
    bom = (job.get("data") or {}).get("bom") or []
    out = []
    for x in bom:
        r = _match_part(con, x)
        row = _part_row(r) if r else {"codes": {}, "checks": part_checks({"cat": x.get("cat"), "item": x.get("item")}, {})}
        out.append(dict(x, codes=row["codes"], checks=row["checks"], maker=x.get("maker") or row.get("maker") or "",
                        spec_url=row.get("spec_url") or "", catalogue=row if r else None))
    return dict(job, data=dict(job.get("data") or {}, bom=out))


def bom_rows(bom):
    """The bill of materials as rows for a CSV or the submittal: quantity times price per line, and the total; with
    with_part_codes, each line's code fields as "value [where it came from]" and its open checks."""
    rows, total = [], 0.0
    for x in bom:
        q, p = _price(x.get("qty")), _price(x.get("price"))
        line = round(q * p, 2) if q is not None and p is not None else None
        total += line or 0
        row = {"category": x.get("cat") or "", "item": x.get("item") or "", "part": x.get("part") or "",
               "supplier": x.get("supplier") or "", "qty": x.get("qty") or "", "unit": x.get("unit") or "",
               "price": "" if p is None else f"{p:.2f}", "line_total": "" if line is None else f"{line:.2f}", "note": x.get("note") or ""}
        for f, col in _BOM_CODE.items():
            c = (x.get("codes") or {}).get(f)
            row[col] = f"{c['v']} [{c.get('src') or 'typed'}]" if c and c.get("v") else ""
        row["code_checks"] = "; ".join(f"{c['status']}: {c['text']}" for c in x.get("checks") or [])
        rows.append(row)
    return rows, round(total, 2)


def packet_zip(jid, job, spec_names=(), reports=()):
    """One download for the AHJ packet's parts: the bill of materials (CSV, with prices and the total, unless the job's
    Materials settings leave them out), the AHJ's own workbook sheet (no prices), every spec sheet gathered into the job's
    folder, each test instrument's calibration certificate (the Overview's certificate register names the file;
    Charlotte and Durham ask for it in the packet), and the sealed report's PDF (reports: sealed_files, only one that still
    matches the job)."""
    import dasbom
    rows, total = bom_rows((job.get("data") or {}).get("bom") or [])
    if dasbom.settings(job.get("data") or {}).get("packet_no_prices"):
        for r in rows:
            r["price"] = r["line_total"] = ""
            r["note"] = dasbom.no_money(r["note"])
        total = None
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=BOM_FIELDS)  # with each part's code fields (with_part_codes, 11/4)
    w.writeheader()
    w.writerows(rows)
    if rows and total is not None:
        w.writerow({"item": "Total", "line_total": f"{total:.2f}"})
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Bill of materials.csv", "﻿" + buf.getvalue())
        if rows:  # the sheet that goes to the AHJ: no prices, no cost, whatever the CSV carries (dasbom.workbook)
            z.writestr("Bill of materials - AHJ.xlsx", dasbom.workbook(job, ("ahj",), jid=jid))
        d = job_dir(jid, job["name"], create=False)
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if (f.startswith("Spec sheet - ") or f in spec_names) and f.lower().endswith(".pdf"):
                    z.write(os.path.join(d, f), "Spec sheets/" + f)
            seen = set()
            for inst in ((job.get("data") or {}).get("testing") or {}).get("instruments") or []:
                if not isinstance(inst, dict):
                    continue
                for cert in [inst.get("cert"), *(p.get("cert") for p in inst.get("prior") or [])]:  # the calibration earlier readings were taken under too
                    if not cert or cert in seen:
                        continue
                    try:
                        fp = file_path(jid, job["name"], cert)
                    except ValueError:
                        continue
                    if os.path.isfile(fp):
                        seen.add(cert)
                        z.write(fp, "Calibration certificates/" + os.path.basename(fp))
            for f in reports:
                fp = file_path(jid, job["name"], f)
                if os.path.isfile(fp):
                    z.write(fp, "Sealed reports/" + os.path.basename(fp))
    return out.getvalue()


# ---------------------------------------------------------------- sealed reports (lane A, 11/4)
# A report printed as final is sealed: the server keeps the SHA-256 of its text, the job's data as it was (and that
# data's own SHA-256), and a short verify code that prints on every page. Verifying a code shows what was sealed and
# whether the job changed since. Signed in only; the public (signed-out) page is built but stays off until the
# setting das_verify_public is true, which waits on Cody's yes (no switch for it in the app).
SEAL_SCHEMA = """CREATE TABLE IF NOT EXISTS das_seal(code TEXT PRIMARY KEY, job_id INTEGER, at TEXT, by TEXT, title TEXT, result TEXT,
    sha256 TEXT, job_sha256 TEXT, job_updated TEXT, job_data TEXT, content TEXT)"""
TABLES = TABLES + ("das_seal",)  # backed up with the rest of the DAS work
SEAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base 32: no I, L, O or U to misread
PUBLIC_VERIFY_SETTING = "das_verify_public"
SEAL_MAX_TEXT = 2_000_000


def _seal_table(con):
    con.execute(SEAL_SCHEMA)


def _canon(d):
    return json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# what DAStastic writes into a job on its own, not part of what was tested: the FCC licence watch rewrites data.lic_watch
# after every FCC data update (daswatch.check), which made every sealed report read "job changed since" (11/4)
SEAL_SKIP = ("lic_watch",)


def seal_data(d):
    return {k: v for k, v in (d or {}).items() if k not in SEAL_SKIP}


def _sha(s):
    import hashlib
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def seal_code_norm(code):
    """What a person types back: any case, with or without the dash; O read as 0, I and L as 1."""
    s = re.sub(r"[^0-9A-Za-z]", "", code or "").upper().translate(str.maketrans("OIL", "011"))
    return f"{s[:4]}-{s[4:8]}" if len(s) == 8 else s


def seal_report(con, jid, text, title="", result="", by=""):
    """Seal a report's text for job jid: {code, at, sha256, job_sha256}. The text is what printed (static/dasahj.js)."""
    import secrets
    _seal_table(con)
    job = job_row(con, jid)
    if job is None:
        raise LookupError(f"Job {jid} was deleted.")
    text = str(text or "")
    if not text.strip():
        raise ValueError("Nothing to seal: the report is empty.")
    if len(text) > SEAL_MAX_TEXT:
        raise ValueError("The report is too long to seal.")
    for _ in range(20):
        raw = "".join(secrets.choice(SEAL_ALPHABET) for _ in range(8))
        code = f"{raw[:4]}-{raw[4:]}"
        if not con.execute("SELECT 1 FROM das_seal WHERE code=?", (code,)).fetchone():
            break
    else:
        raise RuntimeError("No free verify code: try again.")
    data = _canon(seal_data(job["data"]))
    row = {"code": code, "job_id": jid, "at": now(), "by": by or "", "title": str(title or "")[:300], "result": str(result or "")[:80],
           "sha256": _sha(text), "job_sha256": _sha(data), "job_updated": job.get("updated_at") or "", "job_data": data, "content": text}
    con.execute(f"INSERT INTO das_seal({', '.join(row)}) VALUES({', '.join('?' * len(row))})", tuple(row.values()))
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "sealed", f"{row['title']}: verify code {code}, SHA-256 {row['sha256'][:16]}"))
    con.commit()
    return {**{k: row[k] for k in ("code", "at", "sha256", "job_sha256")}, "file": seal_file_name(row["at"], row["title"], code)}


def _changes(old, new):
    """The top-level parts of a job's data that differ, and inside them the fields (as das_log names them)."""
    out = []
    for k in sorted(set(old) | set(new)):
        if _canon(old.get(k)) == _canon(new.get(k)):
            continue
        a, b = old.get(k), new.get(k)
        if isinstance(a, dict) and isinstance(b, dict):
            fa, fb = _flat(a, f"{k}."), _flat(b, f"{k}.")
            sub = [x for x in sorted(set(fa) | set(fb)) if fa.get(x) != fb.get(x)]
            out += sub or [k]
        else:
            out.append(k)
    return out


def seal_verify(con, code):
    """What was sealed under a code, and whether the job changed since: {found: False} for an unknown code."""
    _seal_table(con)
    r = con.execute("SELECT * FROM das_seal WHERE code=?", (seal_code_norm(code),)).fetchone()
    if not r:
        return {"found": False}
    s = dict(r)
    job = job_row(con, s["job_id"])
    old = json.loads(s["job_data"] or "{}")
    out = {"found": True, **{k: s[k] for k in ("code", "job_id", "at", "by", "title", "result", "sha256", "job_sha256", "content")},
           "content_ok": _sha(s["content"] or "") == s["sha256"], "job_deleted": job is None}
    if job is not None:
        out["job_name"] = job["name"]
        out["job_updated"] = job.get("updated_at") or ""
        out["job_changed"] = _sha(_canon(seal_data(job["data"]))) != s["job_sha256"]
        out["changes"] = _changes(old, seal_data(job["data"])) if out["job_changed"] else []
    return out


def seal_list(con, jid):
    _seal_table(con)
    job = job_row(con, jid)
    now_sha = _sha(_canon(seal_data(job["data"]))) if job else ""
    return [{"code": r["code"], "at": r["at"], "by": r["by"], "title": r["title"], "result": r["result"], "sha256": r["sha256"],
             "changed": r["job_sha256"] != now_sha}
            for r in con.execute("SELECT code, at, by, title, result, sha256, job_sha256 FROM das_seal WHERE job_id=? ORDER BY at DESC", (jid,))]


def seal_route(con, method, p, qs, body_json, by=""):
    """/api/das/seal (POST: seal; GET ?job=: a job's seals) and /api/das/seal/verify?code= (signed in). (status, body)"""
    q = lambda k: (qs.get(k) or [""])[0]
    if p == "/api/das/seal" and method == "POST":
        b = body_json()
        return 200, seal_report(con, int(b.get("job_id") or 0), b.get("text"), b.get("title"), b.get("result"), by)
    if p == "/api/das/seal" and method == "GET":
        jid = int(q("job") or 0)
        pdfs = {}
        for f in sealed_files(con, jid):  # newest first: a seal filed twice shows the newest
            pdfs.setdefault(f["code"], f)
        return 200, {"seals": [dict(s, file=(pdfs.get(s["code"]) or {}).get("name") or "", packet=bool((pdfs.get(s["code"]) or {}).get("packet"))) for s in seal_list(con, jid)]}
    if p == "/api/das/seal/verify":
        return 200, seal_verify(con, q("code"))
    raise LookupError("No such page.")


def seal_file_name(at, title, code):
    """The name a sealed report's PDF goes by: dated, saying what it is, its verify code keeping two printings apart."""
    t = re.sub(r"\s+", " ", str(title or "Report").replace(":", " -"))
    return safe_name(f"{str(at)[:10]} Sealed report - {safe_name(t)[:70].strip(' .-')} - {code}") + ".pdf"


# a printed PDF read back. pdf.js breaks words where the print engine kerned them ("v erif y code"), so the two are compared with every space out.
# A printed report holds what was sealed letter for letter, but not in order: a print sets a floor's grid after its table, reads a two-column row line
# by line (a short value lands inside its label's words), and adds the code's footer, a table's heading on each new page, and the browser's own headers
# and footers (the date, the page's title and address, 3/15), which Chrome prints beside the code's when that box is ticked. So it's counted, not walked:
# every run of SEAL_RUN letters in the seal against the same on the page. What no run accounts for is short pieces where stretches meet, and those
# have to be the same pieces on both sides. A changed letter leaves one piece on the page and another in the seal.
SEAL_RUN = 12
SEAL_TEXT_CAP = 189000  # intake.js sends at most 190,000 characters of a PDF
SEAL_ON_PAGE = re.compile(r"verifycode\W{0,2}([0-9A-Za-z]{4}-?[0-9A-Za-z]{4})", re.I)
SEAL_SHA_ON_PAGE = re.compile(r"SHA-256\W{0,2}([0-9a-f]{16})")
SEAL_PRINT_ADDS = re.compile(r"Page\d+of\d+|Sealed\d{4}-\d\d-\d\d\W{0,3}verifycode\W{0,2}[0-9A-Za-z-]{8,9}\W{0,3}SHA-256\W{0,2}[0-9a-f]{16}\.?"
                             r"|Sealedcopyofthisreportkeptwiththejob;achangedjobnolongermatchesit\.?")
SEAL_MARGIN = re.compile(r"https?://[\w.:-]+/?(?:#tab=\w+)?|\d{1,2}/\d{1,2}/\d{2,4},\d{1,2}:\d\d(?::\d\d)?(?:[AP]M)?", re.I)  # read on the letters, off both sides: a report can print an address too


def _no_spaces(s):
    import unicodedata
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(s or "")))


def _no_title(f, t):
    """A page's letters without the name it printed under. A browser's header cuts a long name short, so it's found by its start."""
    head, i = t[:SEAL_RUN], -1
    while len(head) == SEAL_RUN:
        i = f.find(head, max(i, 0))
        if i < 0:
            break
        n = SEAL_RUN
        while n < len(t) and i + n < len(f) and f[i + n] == t[n]:
            n += 1
        f = f[:i] + f[i + n:].lstrip(".…")
    return f


def _page_letters(text, title=""):
    """A PDF's words with no spaces, each page without what printing added to it. title: the name it printed under."""
    pages, t = str(text or "").split("\n"), _no_spaces(title)
    out = []
    for n, pg in enumerate(pages, 1):
        count = re.compile(rf"^{n}(?:/|of){len(pages)}|{n}(?:/|of){len(pages)}$")  # 3/15 at the page's edge: before the address it runs into, and after what it follows
        f = count.sub("", _no_title(SEAL_PRINT_ADDS.sub("", _no_spaces(pg)), t))
        out.append(count.sub("", SEAL_MARGIN.sub("", f)))
    return "".join(out)


def _runs(s):
    return [s[i:i + SEAL_RUN] for i in range(len(s) - SEAL_RUN + 1)]


def _left_over(s, sound):
    """The pieces of s that no sound run covers."""
    runs, pieces, cur, last = _runs(s), [], [], -SEAL_RUN
    for i, ch in enumerate(s):
        if i < len(runs) and sound(runs[i]):
            last = i
        if last > i - SEAL_RUN:
            if cur:
                pieces.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    return pieces + (["".join(cur)] if cur else [])


def seal_text_differs(page, sealed, share=1.0, title=""):
    """Whether what a PDF prints is what was sealed. None when it is; else why not, in words. share: how much of the report was read (1 is all of it).
    title: the name the page printed under, which a browser may put in the margin."""
    from collections import Counter
    a, b = _page_letters(page, title), SEAL_MARGIN.sub("", _no_spaces(sealed))
    if len(a) < SEAL_RUN or len(b) < SEAL_RUN:
        return None if a == b else "Its words don't match what was sealed."
    on_page = Counter(_runs(a))
    if share < 1:  # part of it read: what's there has to be the seal's, and enough of it. A seal can be 2 MB, so only its runs the page has are kept
        hit = [w for w in _runs(b) if w in on_page]
        have = set(hit)
        extra = [x for x in _left_over(a, lambda w: w in have) if len(x) >= SEAL_RUN]
        if extra:
            return f'Its words don\'t match what was sealed, near "{extra[0][:24]}".'
        return "It holds only part of what was sealed." if len(hit) < .8 * share * (len(b) - SEAL_RUN + 1) else None
    in_seal = Counter(_runs(b))
    page_only = Counter(_left_over(a, lambda w: w in in_seal))  # on the page, and nowhere in the seal
    seal_only = Counter(_left_over(b, lambda w: in_seal[w] <= on_page[w]))  # sealed, and fewer times on the page. A heading printed twice costs nothing
    lost, extra = seal_only - page_only, page_only - seal_only
    if sum(len(x) * n for x, n in lost.items()) > .05 * len(b):
        return "It holds only part of what was sealed."
    diff = list(lost + extra)
    return None if not diff else f'Its words don\'t match what was sealed, near "{max(diff, key=len)[:24]}".'


def seal_of_pdf(con, text, pages=0, read=0, vis=None):
    """What a verify code printed on a PDF is worth. None when the PDF shows no code. Else {ok, code, why}, and for a code this login may know of
    {job_id, title, at, file}. A code alone proves nothing: anyone can type one, or copy a real one onto another page. It's believed only when
    the job still stands, the page's words are what was sealed under that code, and the job hasn't changed since. vis: the jobs this login may open."""
    flat = _no_spaces(text)
    codes = list(dict.fromkeys(seal_code_norm(m.group(1)) for m in SEAL_ON_PAGE.finditer(flat)))
    if not codes:
        return None
    no = None
    for code in codes:
        v = seal_verify(con, code)
        if not v.get("found") or (vis is not None and v["job_id"] not in vis):
            no = no or {"ok": False, "code": code, "why": f"This PDF shows verify code {code}, but no report here was sealed under that code. It isn't treated as sealed: check where it came from."}
            continue
        out = {"ok": False, "code": code, "job_id": v["job_id"], "job_name": v.get("job_name"), "title": v["title"], "at": v["at"], "file": seal_file_name(v["at"], v["title"], code)}
        shas = {m.group(1) for m in SEAL_SHA_ON_PAGE.finditer(flat)}
        share = min(1.0, read / pages) if pages and read else 1.0
        if len(text) >= SEAL_TEXT_CAP:  # the page's words were cut off
            share = min(share, .99 * len(flat) / max(1, len(_no_spaces(v["content"]))))
        diff = seal_text_differs(text, v["content"], share, out["file"][:-4]) if not (shas and v["sha256"][:16] not in shas) else "Its SHA-256 isn't the one that was sealed."
        if diff:
            no = no or {**out, "why": f"Verify code {code} is real, but this isn't the report sealed under it. {diff} It may have been edited, so it isn't treated as sealed."}
        elif v.get("job_deleted"):
            no = no or {**out, "why": f"Verify code {code} was sealed on {v['at'][:10]} for a job that has been deleted, so it isn't treated as sealed."}
        elif v.get("job_changed"):
            what = ", ".join(v.get("changes") or [])[:160]
            no = no or {**out, "why": f"This is the report sealed on {v['at'][:10]} for {v['job_name']}, but the job has changed since ({what}). It no longer matches, so it isn't treated as sealed. Print as final again and drop the new PDF."}
        else:
            return {**out, "ok": True, "why": ""}
    return no


def sealed_files(con, jid):
    """The sealed PDFs in a job's Files, newest first: {name, code, title, at, current, packet}. Only a file Intake checked against its seal counts: a
    file someone called a sealed report has no code here. current: the job still matches. packet: the one that goes to the AHJ, the newest of each report."""
    seals = {s["code"]: s for s in seal_list(con, jid)}
    out = []
    for r in con.execute("SELECT f.name, i.facts FROM das_file f JOIN intake_item i ON i.id=f.intake_id WHERE f.job_id=? AND f.kind='sealed_report' ORDER BY f.at DESC", (jid,)).fetchall():
        try:
            s = seals.get((json.loads(r[1] or "{}") or {}).get("seal"))
        except ValueError:
            s = None
        if s:
            out.append({"name": r[0], "code": s["code"], "title": s["title"], "at": s["at"], "current": not s["changed"]})
    out.sort(key=lambda x: x["at"], reverse=True)
    seen = set()
    for x in out:
        x["packet"] = x["current"] and x["title"] not in seen
        seen.add(x["title"])
    return out


CELL_TECH = re.compile(r"\b(LTE|NR|5G|4G|3G|UMTS|WCDMA|HSPA|GSM|CDMA|EV-?DO)\b", re.I)
PS_ONLY_LIFE = ("ul2524", "quant5")  # UL 2524 (public safety boosters) and the NFPA 1225 five-year retest


def cell_only(d):
    """A carrier-only (commercial cellular) job: cellular and not public safety, by job_scope. Public-safety-only asks
    (Part 90 consent and registration, UL 2524, IFC 510 dates and wording) stay off it; a job with both keeps both."""
    sc = job_scope(d)
    return sc["cell"] and not sc["ps"]


def public_verify_on(get_setting):
    """The signed-out verify page answers only when Cody has switched it on (setting das_verify_public)."""
    try:
        return get_setting(PUBLIC_VERIFY_SETTING, False) is True
    except Exception:
        return False


def public_verify_page(con, code):
    """The signed-out verify page (off by default): the code's report, date and result, and whether the job changed.
    Nothing else of the job: no readings, no contacts, and no product name (customer-facing outputs never name it)."""
    import html as H
    v = seal_verify(con, code) if code else {"found": None}
    e = H.escape
    if v.get("found"):
        state = ("The job has been deleted since." if v.get("job_deleted") else
                 "The job has changed since it was sealed: ask the tester for the current report." if v.get("job_changed") else
                 "The job is unchanged since it was sealed.")
        body = (f"<h1>Sealed report {e(v['code'])}</h1><dl><dt>Report</dt><dd>{e(v['title'])}</dd><dt>Building</dt><dd>{e(v.get('job_name') or '')}</dd>"
                f"<dt>Result</dt><dd>{e(v['result'])}</dd><dt>Sealed</dt><dd>{e(v['at'])}</dd><dt>SHA-256</dt><dd class=m>{e(v['sha256'])}</dd></dl><p><b>{e(state)}</b></p>")
    elif v.get("found") is False:
        body = f"<h1>No sealed report has the code {e(seal_code_norm(code))}</h1><p>Check the code in the report's footer.</p>"
    else:
        body = "<h1>Verify a sealed report</h1>"
    return ("<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1'><title>Report verification</title>"
            "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}dt{color:#555;font-size:13px}dd{margin:0 0 8px}"
            ".m{font-family:monospace;overflow-wrap:anywhere}input,button{font:inherit;padding:8px 12px}</style></head><body>"
            f"{body}<form method=get action=/verify><input name=code placeholder='verify code' value='{e(seal_code_norm(code) if code else '')}'> <button>Verify</button></form></body></html>")


RESEARCH_PARTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "rf_parts.json")
SEED_SUPPLIER = "DAStastic research"
SEED_SUPPLIERS = (SEED_SUPPLIER, "RF Recon research")  # parts seeded before the rename (11/7) keep the old name in the database


def seed_parts(con, path=RESEARCH_PARTS):
    """A starter catalogue from DAStastic's own research (cables and components with their makers' part numbers and
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
# each used supplier's shipping added). DAStastic writes the request; the person sends it: nothing goes to a supplier
# on its own.

RFQ_SCHEMA = """
CREATE TABLE IF NOT EXISTS das_supplier(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, email TEXT, phone TEXT, website TEXT,
    contact TEXT, notes TEXT, updated_at TEXT, price_url TEXT, price_checked TEXT, price_result TEXT, ship_from TEXT);
CREATE TABLE IF NOT EXISTS das_rfq(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, title TEXT, lines TEXT, suppliers TEXT,
    need_by TEXT, ship_to TEXT, notes TEXT, status TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS das_quote(id INTEGER PRIMARY KEY, rfq_id INTEGER, supplier TEXT, key TEXT, unit_price REAL, qty REAL,
    lead_days REAL, note TEXT, updated_at TEXT, UNIQUE(rfq_id, supplier, key));
CREATE TABLE IF NOT EXISTS das_rfq_supplier(id INTEGER PRIMARY KEY, rfq_id INTEGER, supplier TEXT, ship_cost REAL, ship_days REAL,
    valid_until TEXT, terms TEXT, quote_ref TEXT, sent_at TEXT, received_at TEXT, ship_est TEXT, UNIQUE(rfq_id, supplier));
"""
SCHEMA += RFQ_SCHEMA  # created with the other DAS tables at start-up
# mail threads: DAStastic emails sent from a person's own mailbox and the tagged replies (dasmail.py, mailbox.py)
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
CREATE TABLE IF NOT EXISTS das_watch(id INTEGER PRIMARY KEY, login TEXT, label TEXT, lat REAL, lon REAL, radius REAL, at TEXT, checked TEXT,
    permits INTEGER, held_back INTEGER);
CREATE TABLE IF NOT EXISTS das_lead(login TEXT, pid TEXT, watch_id INTEGER, state TEXT, at TEXT, done_at TEXT, queued INTEGER, row TEXT, PRIMARY KEY(login, pid));
"""
TABLES += ("das_watch", "das_lead")  # a saved area and what it turned up (leads.py)
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
    for (n,) in con.execute("SELECT DISTINCT supplier FROM das_part WHERE supplier<>'' AND supplier NOT IN (?,?)", SEED_SUPPLIERS):
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


ONLINE_KEEP_S = 24 * 3600  # online prices last a day: the distributors' API terms bar a database (Digi-Key, Mouser, element14)
                            # and caching past 48 hours (Arrow, element14); TTI's past 30 days (Cody 11/8: "do whatever is legal")


def drop_old_online(con, rid=None):
    """The "<source> (online)" quotes older than a day, gone; a fresh look (Price online) brings them back."""
    cut = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - ONLINE_KEEP_S))
    n = con.execute("DELETE FROM das_quote WHERE supplier LIKE '% (online)' AND COALESCE(updated_at,'') < ?" + (" AND rfq_id=?" if rid else ""),
                    (cut, rid) if rid else (cut,)).rowcount
    if n:
        con.commit()
    return n


def get_rfq(con, rid):
    r = con.execute("SELECT * FROM das_rfq WHERE id=?", (rid,)).fetchone()
    if not r:
        raise LookupError("That request for quote was deleted.")
    drop_old_online(con, rid)
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


def import_quote(con, rid, supplier, name, data, only_new=False):
    """A supplier's filled-in quote sheet (the request's CSV, or their own sheet with part, price and lead time).
    only_new: lines this supplier has already quoted stay as they are (Intake)."""
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
    kept = []
    if only_new:
        have = {x["key"] for x in q["quotes"] if x["supplier"] == supplier and x["unit_price"] is not None}
        kept = sorted(k for k in lines if k in have)
        lines = {k: v for k, v in lines.items() if k not in have}
    out = save_quote(con, rid, supplier, {"lines": lines}) if lines else q
    out["imported"] = {"lines": len(lines), "unmatched": missed, "columns": m, "keys": sorted(lines), "kept": kept}
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
           "das_part": (("weight_lb", "REAL"), ("fcc_id", "TEXT"), ("grant_info", "TEXT"), ("codes", "TEXT"), ("pattern", "TEXT")), "das_rfq_supplier": (("ship_est", "TEXT"),),
           "das_prospect": (("email", "TEXT"), ("email_source", "TEXT")), "das_mail": (("counterpart_name", "TEXT"),)}
    for table, cols in add.items():
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for c, typ in cols:
            if have and c not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {c} {typ}")
    con.commit()
    price_history_begins(con)
    seed_supplier_renamed(con)
    rfq_ids_never_reused(con)
    dashist.ensure(con)  # the job's revision column; existing jobs shared with the whole team, as before
    import ahjbook
    ahjbook.seed(con)  # what jobs confirmed before the AHJ book began


def seed_supplier_renamed(con):
    """RF Recon became DAStastic (11/7, Cody and Josh): the starter parts' supplier "RF Recon research" takes the new name in the
    catalogue, its price history, saved kits and the bill-of-materials lines copied into jobs (Cody: "fix them all"). Only rows
    that still carry the old name are touched, so it runs at every start for nothing once done. A part whose key the new name
    already has stays as it was (UNIQUE(supplier, key)), and SEED_SUPPLIERS still keeps it off the supplier list."""
    import sqlite3
    old, new = "RF Recon research", SEED_SUPPLIER
    try:
        con.execute("UPDATE OR IGNORE das_part SET supplier=? WHERE supplier=?", (new, old))
        con.execute("UPDATE das_part_price SET supplier=? WHERE supplier=?", (new, old))
        for kid, lines in con.execute("SELECT id, lines FROM das_bom_kit WHERE lines LIKE ?", (f"%{old}%",)).fetchall():
            v = json.loads(lines or "[]")
            if _bom_renamed(v, old, new):
                con.execute("UPDATE das_bom_kit SET lines=? WHERE id=?", (json.dumps(v), kid))
        for jid, data in con.execute("SELECT id, data FROM das_job WHERE data LIKE ?", (f"%{old}%",)).fetchall():
            d = json.loads(data or "{}")
            if _bom_renamed(d.get("bom"), old, new):
                con.execute("UPDATE das_job SET data=? WHERE id=?", (json.dumps(d), jid))
        con.commit()
    except (sqlite3.OperationalError, ValueError):  # a copy without these tables yet, or a line that isn't JSON: left for next start
        pass


def _bom_renamed(lines, old, new):
    n = 0
    for x in lines if isinstance(lines, list) else []:
        if isinstance(x, dict) and x.get("supplier") == old:
            x["supplier"] = new
            n += 1
    return n


def price_history_begins(con):
    """Each priced part kept before price history began gets its price as the first row, dated when it was last read, so the
    next import keeps the old price with a date. Once: a part with any history is left alone."""
    import sqlite3
    try:
        con.execute("""INSERT INTO das_part_price(supplier, key, part, price, at, seen_at, source)
                       SELECT p.supplier, p.key, p.part, p.price, p.updated_at, p.updated_at, 'before price history' FROM das_part p
                       WHERE p.price IS NOT NULL AND NOT EXISTS (SELECT 1 FROM das_part_price h WHERE h.supplier=p.supplier AND h.key=p.key)""")
        con.commit()
    except sqlite3.OperationalError:  # a copy with neither table yet (a test's bare database)
        pass


def rfq_ids_never_reused(con):
    """Quote request ids are never handed out twice (11/4: a new request took a deleted one's id and with it the old
    request's quotes and its mail, whose subjects still carry [RFR Q<id>.<n>]). An older das_rfq (plain INTEGER PRIMARY
    KEY, which reuses the highest id once it's deleted) is rebuilt with AUTOINCREMENT, every row keeping its id; then the
    counter is raised past every id anything has used: requests, quotes, suppliers' terms and mail, by column and by tag."""
    import sqlite3
    row = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='das_rfq'").fetchone()
    if not row:
        return
    if "AUTOINCREMENT" not in (row[0] or "").upper():
        new = re.search(r"CREATE TABLE IF NOT EXISTS das_rfq\(.*?\);", RFQ_SCHEMA, re.S).group(0)
        old_cols = [r[1] for r in con.execute("PRAGMA table_info(das_rfq)")]
        con.execute("ALTER TABLE das_rfq RENAME TO das_rfq_pre_autoinc")
        con.execute(new)
        new_cols = {r[1] for r in con.execute("PRAGMA table_info(das_rfq)")}
        cols = ", ".join(c for c in old_cols if c in new_cols)
        con.execute(f"INSERT INTO das_rfq({cols}) SELECT {cols} FROM das_rfq_pre_autoinc")
        con.execute("DROP TABLE das_rfq_pre_autoinc")
    hi = con.execute("SELECT COALESCE(MAX(id), 0) FROM das_rfq").fetchone()[0]
    for t in ("das_quote", "das_rfq_supplier", "das_mail"):
        try:
            hi = max(hi, con.execute(f"SELECT COALESCE(MAX(rfq_id), 0) FROM {t}").fetchone()[0] or 0)
        except sqlite3.Error:
            pass  # a table this copy doesn't have yet
    try:
        for (tag,) in con.execute("SELECT DISTINCT tag FROM das_mail WHERE tag LIKE 'Q%'"):
            m = re.fullmatch(r"Q(\d+)\.\d+", tag or "")
            if m:
                hi = max(hi, int(m.group(1)))
    except sqlite3.Error:
        pass
    seq = con.execute("SELECT seq FROM sqlite_sequence WHERE name='das_rfq'").fetchone()
    if seq is None:
        con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES('das_rfq', ?)", (hi,))
    elif (seq[0] or 0) < hi:
        con.execute("UPDATE sqlite_sequence SET seq=? WHERE name='das_rfq'", (hi,))
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
            res = import_parts(con, name, data, r["name"], source="price list link")
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
    # the five-year rule is cited through the SBC primer: NFPA 1225's chapter 18 / 20.3.10 text read on 11/4 doesn't show it
    # (beat-par). A job whose AHJ has its own five-year rule (static/research/ahj_deadlines.json) shows that one instead
    "quant5": ("NFPA 1225 20.3.10.2.3.3: a full quantitative retest at least every five years (per the SBC ERCES Primer; not "
               "in the NFPA 1225 text read, so confirm it; the IFC has no five-year rule). Local five-year rules read: Clark "
               "County FPAN, Douglas County App. H, Denver 510-1, FDNY ARCS, Seattle SFC 510.6.1.1",
               "https://saferbuildings.org/erces-primer/"),
    "auth": ("Licensee authorization: IFC 2024 510.5.2.1 / NFPA 1225 18.7.2; the term is the licensee's (Requirements, "
             "Licensee consent)", "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    "op_permit": ("Operational permit where the fire code official requires one, renewable: IFC 2024 510.3.2 / NFPA 1225 "
                  "18.7.3 (the code sets no term)", "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    "ul2524": ("UL 2524 3rd edition (22 Mar 2024): listings not updated by 22 Mar 2026 are withdrawn (Intertek SUN, 10 Feb 2025)",
               "https://www.intertek.com/siteassets/resources/sun/2025/ul-2524-sun-rev-3-22-2024-ed-3-22-2026.pdf"),
    "remodel": ("IFC 510.6.1 (2018, 2021 and 2024 editions): retest after structural changes (additions, remodels); the code gives no deadline",
                "https://up.codes/viewer/general-services-administration/ifc-2024/chapter/5/fire-service-features"),
    # the firm's own dates (lane D 11/4, beat-par lifecycle "firm certificates"): the instruments and the tester
    "cal": ("Instrument calibration: Grid test scores a reading only when its instrument was calibrated within the 12 months "
            "before it (DAStastic's rule, the usual annual cycle; check the AHJ). AHJs ask for each instrument's model, serial "
            "and calibration date (San Diego FD C-1 Appendix D; FDNY ARCS procedures)",
            "https://www.sandiego.gov/sites/default/files/2025-01/c-1-emergency-responder-communication-enhancement-systems.pdf"),
    "nicet": ("NICET Policy 30: a certification runs three years and loses Active Status on the first day of the expiration "
              "month printed on it (San Diego FD C-1 asks for NICET Level II)", "https://www.nicet.org/about-us/policies/policy30/"),
    "mfr": ("A certificate of in-building system training from a recognized organization or the equipment's manufacturer is "
            "a minimum tester qualification (IFC 2021 510.5.3; Seattle FD CAM 5123, Section 2); the term is the issuer's",
            "https://seattle.gov/documents/Departments/Fire/Business/CAM5123_EmerRespondRadioSys.pdf"),
    "b03": ("FDNY: the ARCS tester holds a B-03 Certificate of Fitness (FDNY ARCS submission procedures, rev 7/11/2024); "
            "the date is the one on the certificate",
            "https://www.nyc.gov/assets/fdny/downloads/pdf/business/arcs-submission-and-approval-procedures.pdf"),
    # a carrier (commercial cellular) DAS: none of IFC 510 / NFPA 1225 / UL 2524 / Part 90 applies (lane H 11/4)
    "carrier_consent": ("47 CFR 20.21(c): an industrial signal booster runs only with each carrier's express consent. The rule "
                        "sets no term: a renewal date is the one in the carrier's letter",
                        "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-20/section-20.21"),
    "carrier_retest": ("The carrier's own acceptance and retest terms (its consent letter or DAS agreement), as entered on the "
                       "job: no FCC rule sets a retest interval for a carrier DAS",
                       "https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-20/section-20.21"),
    "maintenance": ("The owner's maintenance or service agreement, as entered on the job: no code sets a term for a carrier DAS",
                    None),
}
LIFE_SOON_DAYS = 60
CAL_MONTHS = 12  # static/das.js DAS.cal_months: change both together
LIFE_CERTS = (("nicet", "NICET certification"), ("mfr", "Manufacturer training certificate"), ("b03", "FDNY B-03 certificate of fitness"))
TEST_KIND = {"acceptance": "acceptance test", "annual": "annual test", "five_year": "five-year test"}
_AHJ_RULES = None


def ahj_rules():
    """The AHJ filing windows and local retest rules, by AHJ (static/research/ahj_deadlines.json, each with its source)."""
    global _AHJ_RULES
    if _AHJ_RULES is None:
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "ahj_deadlines.json"),
                      encoding="utf-8") as fh:
                _AHJ_RULES = json.load(fh).get("ahjs") or {}
        except (OSError, ValueError):  # the web version may not carry the file: the generic rules still apply
            _AHJ_RULES = {}
    return _AHJ_RULES


def ahj_rule(d):
    """A job's AHJ rules: (key, rule, how it matched), or (None, None, ""). The DAS profile's name first (DAS_PROFILES
    names in static/das.js), then the job's AHJ field."""
    d = d or {}
    prof = str((d.get("profile") or {}).get("name") or "")
    ahj = str(d.get("ahj") or "")
    rules = ahj_rules()
    for key, r in rules.items():
        if prof and (prof == key or (r.get("profiles") and re.search(r["profiles"], prof, re.I))):
            return key, r, f"the job's AHJ profile ({prof})"
    for key, r in rules.items():
        if ahj and r.get("ahj") and re.search(r["ahj"], ahj, re.I):
            return key, r, f"the job's AHJ ({ahj})"
    return None, None, ""


def job_scope(d):
    """What a job covers: {"ps": public-safety ERCES (IFC 510 / NFPA 1225), "cell": commercial cellular}. One rule for the
    whole app (static/das.js dasScope says the same; cell_only below is built on it). Cellular when carriers are set
    (data.cellular: a target, donor readings or carrier approvals). Public safety when it has a public-safety channel plan,
    systems picked, licensee authorizations or consents, or a public-safety reading in the grid or a named critical area;
    and every job with no cellular part (every job before cellular existed). An AHJ profile alone decides nothing: a
    carrier job can carry one too (lanes A and D, 11/4). Start's scope answer says it outright, before any of that is on file:
    without it a Cellular job started there met the public safety gate (11/5)."""
    d = d or {}
    C, ps = d.get("cellular") or {}, d.get("presurvey") or {}
    said = ((d.get("guided") or {}).get("answers") or {}).get("scope")
    cell = said in ("Cellular", "Both") or any(isinstance(C.get(k), dict) and C.get(k) for k in ("profile", "donor", "approvals"))
    sign = said in ("Public safety radio", "Both") or bool(ps.get("plan") or ps.get("include") or (d.get("life") or {}).get("auths") or d.get("consents") or _ps_reading(d))
    return {"ps": sign or not cell, "cell": bool(cell)}


def _ps_reading(d):
    """A public-safety reading anywhere in the grid (a downlink, DAQ or SINR that isn't a cellular reading), or in a
    named critical area."""
    has = lambda v: v is not None and v != ""
    for r in ((d.get("grid") or {}).get("results") or {}).values():
        rs = r.get("readings") if isinstance(r, dict) and isinstance(r.get("readings"), list) else [r]
        for x in rs:
            if not isinstance(x, dict):
                continue
            cell = (has(x.get("tech")) and CELL_TECH.search(str(x.get("tech")))) or has(x.get("rsrp")) or has(x.get("rsrq"))
            if not cell and (has(x.get("dl")) or has(x.get("daq")) or has(x.get("sinr"))):
                return True
    for r in ((d.get("grid") or {}).get("critical") or {}).values():
        if isinstance(r, dict) and (has(r.get("dl")) or has(r.get("daq"))):
            return True
    return False


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
    auths [{who, granted, renews, term}], report_filed (the last test report filed with the AHJ). Where the job's AHJ has
    rules in static/research/ahj_deadlines.json (ahj_rule), items "report" (due to the AHJ N days after a test) and
    "annual_ahj" (OCSD's 13 months) are added and the five-year item takes the AHJ's own rule; those carry ahj and
    matched. Items "cal" (d["testing"]["instruments"] cal + CAL_MONTHS) and "cert" (testing nicet_expires, mfr_expires,
    b03_expires) are the firm's own dates. Each item has an id, unique within the job (reminders key on it).
    A carrier-only job (job_scope) has none of the public-safety items: it gets "carrier_consent" (each carrier with
    consent in data.cellular.approvals; renews when entered), "carrier_retest" (approvals retest_due) and "maintenance"
    (life.maintenance_renews), plus the firm's dates. A job with both has both."""
    d = d or {}
    life = d.get("life") or {}
    today = today or datetime.now().date()
    accepted = _day(d.get("accepted_on") or (d.get("checks") or {}).get("accepted_on"))
    out = []

    def item(key, label, due=None, done=None, state=None, src_key=None, note="", source=None, url=None, iid=None, **extra):
        days = (due - today).days if due else None
        if state is None:
            state = "n/a" if due is None else "overdue" if days < 0 else "due" if days <= LIFE_SOON_DAYS else "ok"
        text, link = (source, url) if source else LIFE_SOURCES[src_key or key]
        out.append({"key": key, "id": iid or key, "label": label, "due": due.isoformat() if due else None,
                    "done": done.isoformat() if done else None, "state": state, "days": days, "source": text, "url": link,
                    "note": note, **extra})

    scope = job_scope(d)
    if scope["ps"]:
        _life_erces(d, life, stage, accepted, item, out)
    if scope["cell"]:  # a carrier DAS: the carriers' consent and terms, the owner's maintenance
        C = d.get("cellular") or {}
        for car, a in sorted((C.get("approvals") or {}).items()):
            a = a or {}
            if a.get("consent"):
                renews = _day(a.get("renews"))
                item("carrier_consent", f"Carrier consent renewal: {car}", due=renews, done=_day(a.get("consent")),
                     state=None if renews else "ok", iid=f"carrier_consent:{car}", carrier=car, contact=a.get("contact") or "",
                     note=f"consent {a['consent']}" if renews else f"consent {a['consent']}; no renewal date on file (enter one if the carrier's letter has one)")
            rt = _day(a.get("retest_due"))
            if rt:
                item("carrier_retest", f"Carrier retest: {car}", due=rt, iid=f"carrier_retest:{car}", carrier=car)
        mt = _day(life.get("maintenance_renews"))
        if mt:
            item("maintenance", "Owner's maintenance agreement renewal", due=mt)

    # the firm's own dates: each instrument's calibration, the tester's certificates (an FCC GROL is for life: 47 CFR 13.15)
    t = d.get("testing") or {}
    cal_m = int((d.get("profile") or {}).get("cal_months") or CAL_MONTHS)
    for n, ins in enumerate(t.get("instruments") or []):
        c = _day((ins or {}).get("cal"))
        if not c:
            continue
        nm = " ".join(x for x in (ins.get("model"), f"(serial {ins['serial']})" if ins.get("serial") else "") if x) or f"instrument {n + 1}"
        # the certificate's own expiry first (lane A's instrument register), else the calibration date + cal_m months
        item("cal", f"Calibration runs out: {nm}", due=_day(ins.get("expires")) or _add_months(c, cal_m), done=c,
             note=f"calibrated {c.isoformat()}", iid=f"cal:{n}:{ins.get('serial') or ins.get('model') or ''}", instrument=nm,
             model=ins.get("model") or "", serial=ins.get("serial") or "", cal_months=cal_m)
    for k, lbl in LIFE_CERTS:
        e = _day(t.get(f"{k}_expires"))
        if e:
            item("cert", f"{lbl} expires: {t.get('tester') or 'the tester'}", due=e, src_key=k, iid=f"cert:{k}", cert=lbl,
                 tester=t.get("tester") or "", cert_key=k)
    return out


def _life_erces(d, life, stage, accepted, item, out):
    """The public-safety items: IFC 510 / NFPA 1225 retests, Part 90 licensee renewals, the permit, UL 2524, remodels,
    and the AHJ's own windows."""
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
    for n, a in enumerate(life.get("auths") or []):
        renews = _day(a.get("renews"))
        item("auth", f"Licensee authorization renewal: {a.get('who') or 'licensee'}", due=renews, done=_day(a.get("granted")),
             state=None if renews else "open", note=a.get("term") or ("" if renews else "no renewal date entered"),
             iid=f"auth:{n}:{a.get('who') or ''}", who=a.get("who") or "")
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

    # the AHJ's own windows (lane D 11/4): when the test report is due to it, its annual limit, its five-year rule
    rkey, rule, how = ahj_rule(d)
    if rule:
        short = rule.get("short") or rkey
        tag = {"ahj": short, "ahj_key": rkey, "matched": how}
        filed = _day(life.get("report_filed"))
        tests = {"acceptance": accepted, "annual": annual_last, "five_year": q_last}
        for n, rp in enumerate(rule.get("report") or []):
            days, src = rp.get("days"), f"{short}: {rp.get('text')} ({rp.get('section')})"
            if not days:
                continue
            if rp.get("after") == "five_year_interval":  # Denver: within N days of each five-year anniversary of installation
                if not accepted:
                    continue
                k = 1
                while filed and _add_months(accepted, 60 * k - 12) <= filed:  # a report filed in that interval's last year covers it
                    k += 1
                anniv = _add_months(accepted, 60 * k)
                item("report", f"Five-year documents to {short}", due=_add_days(anniv, days), source=src, url=rp.get("source"),
                     note=f"{days} days after the five-year interval of {anniv.isoformat()} (counted from acceptance)",
                     iid=f"report:{n}", rule_days=days, **tag)
                continue
            kinds = [(tests[t], t) for t in rp.get("tests") or [] if tests.get(t)]
            if not kinds:
                continue
            base, kind = max(kinds)
            is_done = bool(filed and filed >= base)
            item("report", f"Test report due to {short}", due=_add_days(base, days), done=filed if is_done else None,
                 state="done" if is_done else None, source=src, url=rp.get("source"),
                 note=f"{days} days after the {TEST_KIND[kind]} of {base.isoformat()}" + (f"; filed {filed.isoformat()}" if is_done else ""),
                 iid=f"report:{n}", test_date=base.isoformat(), test_kind=kind, rule_days=days, **tag)
        months = rule.get("annual_months")
        last = max([x for x in (accepted, annual_last, q_last) if x], default=None)
        if months and last:
            item("annual_ahj", f"{short}: annual report from a test in the last {months} calendar months", due=_add_months(last, months),
                 note=f"from the test of {last.isoformat()}", source=f"{short}: {rule.get('annual_text')} ({rule.get('annual_section')})",
                 url=rule.get("annual_source"), **tag)
        fy = rule.get("five_year")
        for x in out:
            if fy and x["key"] == "quant5":
                x.update({"label": fy.get("label") or x["label"], "source": f"{short}: {fy.get('text')} ({fy.get('section')})",
                          "url": fy.get("source"), "note": f"{short} rule" if x["due"] else x["note"], **tag})


def _add_days(d, n):
    return d.fromordinal(d.toordinal() + int(n))


# ---------------------------------------------------------------- prospects (Cody 11/3): who to approach, and where each stands
PROSPECT_STATUS = ("new", "contacted", "replied", "meeting", "won", "not interested", "do not contact")
KIND_TYPE = {"school_k12": "K-12 schools", "school_private": "K-12 schools", "college": "Colleges and universities", "hospital": "Hospitals",
             "nursing_home": "Nursing homes",
             "high_rise": "High-rise office and residential", "warehouse": "Warehouses and distribution centers",
             "parking": "Parking garages (below grade)", "mall": "Malls and retail centers", "stadium": "Stadiums and arenas",
             "venue": "Convention centers", "airport": "Airports", "hotel": "Hotels", "casino": "Casinos and resorts",
             "government": "Government buildings", "transit": "Transit stations (below grade)", "tunnel": "Tunnels"}


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
    sends it from their own mail. What it says about the law follows the state's reading (codecheck): a building isn't
    told it's required where nothing statewide says so, and a list row with a bad or blank state makes no claim. The
    reason is owner_why, written for the owner: why is the team's research, with other cities' rules in it."""
    import codecheck  # here, not at the top: codecheck imports das
    t = prospect_types().get(KIND_TYPE.get(prospect.get("kind"), ""), {})
    who = prospect.get("contact_name") or "Facilities team"
    name = firm.get("name") or "our firm"
    level, place, why = codecheck.level(prospect.get("state")), prospect["name"], t.get("owner_why")
    law = {"required": f"Buildings like {place} are often required to have it." if why else "",
           "discretion": f"Buildings like {place} can be required to have it, depending on the fire official." if why else "",
           "no_mandate": "Owners choose it so firefighters' and police radios work inside the building."}.get(
               level, f"Whether a building like {place} needs it depends on the state and local fire code.")
    reach = "how well they reach inside" if level == "no_mandate" else "what coverage the fire marshal will expect"
    body = (f"Hello {who},\n\n"
            f"{name} designs, installs and tests in-building emergency responder radio coverage (ERCES / public safety DAS) "
            f"and cellular coverage. {' '.join(x for x in (law, why) if x)}\n\n"
            f"We can check, before anyone visits, which public safety radio systems serve your building and {reach}, "
            "and walk you through what a test and a system would involve.\n\n"
            "Would a short call next week be useful?\n\n"
            f"{firm.get('contact') or ''}\n{name}\n{firm.get('phone') or ''}\n{firm.get('website') or ''}\n"
            f"{firm.get('address') or '[your mailing address: required in commercial email]'}\n\n"
            "If you'd rather not hear from us, reply \"no thanks\" and we won't write again.")
    return {"to": prospect.get("email") or "", "subject": f"Emergency radio coverage at {prospect['name']}", "body": body}
