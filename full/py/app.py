#!/usr/bin/env python3
"""
RF Recon - local server. Run:  python app.py   then open http://localhost:8765
Options:  --port 8765   --lan (serve to other devices on your network)
Standard library only.
"""
import argparse
import base64
import csv
import io
import json
import math
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ais  # noqa: E402
import artemis  # noqa: E402
import bdc  # noqa: E402
import fccid  # noqa: E402
import finder  # noqa: E402
import kitupdate  # noqa: E402
import basemaps  # noqa: E402
import takpush  # noqa: E402
import captures  # noqa: E402
import cells  # noqa: E402
import coverage  # noqa: E402
import das  # noqa: E402
import connectors  # noqa: E402
import faa  # noqa: E402
import fieldpack  # noqa: E402
import geo  # noqa: E402
import network  # noqa: E402
import opensources  # noqa: E402
import psap  # noqa: E402
import remote  # noqa: E402
import sigid  # noqa: E402
import sigwiki  # noqa: E402
import terrain  # noqa: E402
import uls_import  # noqa: E402
import updater as updmod  # noqa: E402

DB_PATH = uls_import.DB_PATH
CROWD_PATH = os.environ.get("CROWD_DB", os.path.join(os.path.dirname(DB_PATH), "crowd.db"))
STATIC = os.path.join(HERE, "static")
TILE_DIR = os.path.join(uls_import.DATA_DIR, "tiles")
MAX_ROWS = 25000

APP_SCHEMA = """
CREATE TABLE IF NOT EXISTS setting(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS mission(id INTEGER PRIMARY KEY, name TEXT, objective TEXT, status TEXT,
    lat REAL, lon REAL, radius_mi REAL, state TEXT, start_date TEXT, end_date TEXT, operator TEXT,
    settings TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS mission_log(id INTEGER PRIMARY KEY, mission_id INTEGER, ts TEXT, kind TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS observation(mission_id INTEGER, freq_mhz REAL, call_sign TEXT,
    status TEXT, level_dbm REAL, notes TEXT, updated_at TEXT, PRIMARY KEY(mission_id, freq_mhz, call_sign));
"""

DEFAULT_MISSION_SETTINGS = {
    "target_bands": [], "target_types": [], "watch": [],
    "layers": {"uls": True, "uls_hist": False, "towers": True, "captures": True, "wigle": True,
               "opencellid": True, "repeaterbook": True, "custom": True},
    "min_dbm": None, "gps_max_accuracy_m": 50, "sweep_threshold_db": 10, "track_match_s": 30,
    "heat_size": 200, "heat_metric": "mean", "heat_combine": "max", "heat_alpha": 190,
    "units": "imperial", "auto_refresh_crowd": False, "fixed_sites_only": True,
}

now = lambda: time.strftime("%Y-%m-%d %H:%M:%S")


def db():
    con = sqlite3.connect(DB_PATH, timeout=60)
    con.row_factory = sqlite3.Row
    return con


def cdb():
    con = connectors.open_db(CROWD_PATH)
    con.row_factory = sqlite3.Row
    return con


def init():
    remote.setup(uls_import.DATA_DIR)
    if not os.path.exists(DB_PATH):
        print(f"Note: no FCC database yet at {DB_PATH}. The app will start; use Data & updates > Update now,\n"
              f"or run  python uls_import.py  first.")
    con = sqlite3.connect(DB_PATH)
    con.executescript(uls_import.SCHEMA + APP_SCHEMA + captures.SCHEMA + das.SCHEMA + network.SCHEMA)
    import towers
    towers.ensure_schema(con)
    con.close()
    cdb().close()
    threading.Thread(target=ensure_places, daemon=True).start()
    threading.Thread(target=ensure_sigwiki, daemon=True).start()
    if BACKUP_DIR:
        threading.Thread(target=backup_loop, daemon=True).start()


def get_setting(k, default=None):
    con = db()
    r = con.execute("SELECT v FROM setting WHERE k=?", (k,)).fetchone()
    con.close()
    return json.loads(r[0]) if r else default


def set_setting(k, v):
    con = db()
    con.execute("INSERT OR REPLACE INTO setting VALUES(?,?)", (k, json.dumps(v)))
    con.commit()
    con.close()


def active_areas():
    con = db()
    rows = con.execute("SELECT * FROM mission WHERE status IN ('Planning','Active')").fetchall()
    con.close()
    act = get_setting("active_mission")
    out = []
    for m in rows:
        s = json.loads(m["settings"] or "{}")
        if (m["id"] == act or s.get("auto_refresh_crowd")) and m["lat"] is not None:
            out.append((m["lat"], m["lon"], m["radius_mi"] or 10, m["state"]))
    return out


UPD = None


# ---------------------------------------------------------------- unified area query

def fnum(qs, k, default=None):
    try:
        v = qs.get(k, [""])[0]
        return float(v) if v not in ("", None) else default
    except ValueError:
        return default


def fstr(qs, k):
    return (qs.get(k, [""])[0] or "").strip()


def area_filter(qs):
    lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
    radius = fnum(qs, "radius", 10)
    state, county = fstr(qs, "state").upper(), fstr(qs, "county").upper()
    if lat is not None and lon is not None:
        s, n, w, e = geo.bbox(lat, lon, radius)
        return {"point": (lat, lon), "radius": radius, "sql": "lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                "args": [s, n, w, e]}
    if state:
        sql, args = "state = ?", [state]
        if county:
            sql += " AND county = ?"
            args.append(county)
        return {"point": None, "radius": None, "sql": sql, "args": args, "state": state, "county": county}
    if fstr(qs, "scope") == "nationwide":  # ULS-style licence search across the US (needs a filter, checked below)
        return {"point": None, "radius": None, "sql": "1", "args": [], "nationwide": True}
    return None


def uls_filters(qs, hist=False):
    """The FCC ULS search fields as SQL: radio services, technology, emission, grant and expiry dates.
    hist=True limits it to what tx_history keeps (service, mode)."""
    where, args = [], []
    svc = [s.strip().upper() for s in fstr(qs, "svc").split(",") if s.strip()]
    if svc:
        where.append(f"service IN ({','.join('?' * len(svc))})")
        args += svc
    if fstr(qs, "tech"):
        where.append("mode LIKE ?")
        args.append(f"%{fstr(qs, 'tech')}%")
    if hist:
        return where, args
    if fstr(qs, "emission"):
        where.append("emissions LIKE ?")
        args.append(f"%{fstr(qs, 'emission').upper()}%")
    ymd = lambda col: f"(substr({col},7,4)||substr({col},1,2)||substr({col},4,2))"  # MM/DD/YYYY -> YYYYMMDD
    for key, col, op in (("granted_from", "grant_date", ">="), ("granted_to", "grant_date", "<="),
                         ("expires_from", "expired_date", ">="), ("expires_to", "expired_date", "<=")):
        v = fstr(qs, key).replace("-", "")
        if re.fullmatch(r"\d{8}", v):
            where.append(f"{ymd(col)} {op} ?")
            args.append(v)
    return where, args


BCAST_TYPE = {"FM": "FM broadcast", "TV": "ATSC TV", "AM": "AM broadcast"}


def has_table(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def decorate(f, area):
    """distance, bearing, est level"""
    if area["point"] and f.get("lat") is not None:
        d = geo.haversine_km(area["point"][0], area["point"][1], f["lat"], f["lon"])
        if d > area["radius"] * geo.MI_KM:
            return False
        b = geo.bearing_deg(area["point"][0], area["point"][1], f["lat"], f["lon"])
        f["dist_mi"], f["bearing"], f["compass"] = round(d / geo.MI_KM, 3), round(b), geo.compass(b)
        erp = f.get("erp_w") or f.get("power_out_w")
        if f["layer"] in ("uls", "broadcast", "noaa") and erp and f.get("freq_mhz"):
            f["est_rx_dbm"] = round(geo.fspl_rx_dbm(erp, d, f["freq_mhz"]), 1)
    elif area["point"]:
        return False
    return True


def query_area(qs):
    area = area_filter(qs)
    if not area:
        return {"error": "Drop a pin or pick a state/county."}
    layers = set((fstr(qs, "layers") or "uls,broadcast,noaa,faa,towers,captures,wigle,opencellid,repeaterbook,custom").split(","))
    mission = fnum(qs, "mission")
    text = fstr(qs, "q")
    fmin, fmax = fnum(qs, "fmin"), fnum(qs, "fmax")
    hide_mobile = fstr(qs, "hide_mobile") == "1"
    adv_where, adv_args = uls_filters(qs)
    if area.get("nationwide") and not (text or adv_where or fmin is not None or fmax is not None):
        return {"error": "A nationwide search needs a call sign, licensee, radio service, technology or frequency."}
    out, truncated = [], False
    con = db()

    if "uls" in layers or "uls_hist" in layers:
        where, args = [area["sql"]], list(area["args"])
        statuses = []
        if "uls" in layers:
            statuses.append("status='A'")
        if "uls_hist" in layers:
            statuses.append("IFNULL(status,'')<>'A'")
        where.append("(" + " OR ".join(statuses) + ")")
        if fmin is not None:
            where.append("freq_mhz >= ?"); args.append(fmin)
        if fmax is not None:
            where.append("freq_mhz <= ?"); args.append(fmax)
        if hide_mobile:
            where.append("is_mobile = 0")
        if text:
            where.append("(licensee LIKE ? OR call_sign LIKE ? OR city LIKE ? OR address LIKE ?)")
            args += [f"%{text}%"] * 4
        where += adv_where
        args += adv_args
        rows = con.execute(f"SELECT * FROM tx WHERE {' AND '.join(where)} LIMIT {MAX_ROWS + 1}", args).fetchall()
        truncated = len(rows) > MAX_ROWS
        ov = {}
        if rows:
            calls = list({r["call_sign"] for r in rows})
            for i in range(0, len(calls), 900):
                ch = calls[i:i + 900]
                for o in con.execute(f"SELECT * FROM overlay WHERE call_sign IN ({','.join('?'*len(ch))})", ch):
                    ov[(o["call_sign"], round(o["freq_mhz"], 5))] = dict(o)
        obs = {}
        if mission is not None:
            for o in con.execute("SELECT * FROM observation WHERE mission_id=?", (int(mission),)):
                obs[(round(o["freq_mhz"], 5), o["call_sign"])] = dict(o)
        for r in rows[:MAX_ROWS]:
            f = dict(r)
            f["layer"] = "uls" if f.get("status") == "A" else "uls_hist"
            f["fid"] = f"uls:{f['id']}"
            f["label"] = f["licensee"]
            f["sig_type"] = sigid.from_uls_mode(f.get("mode")) or "Unknown"
            if f["layer"] == "uls_hist":
                f["category"] = "History: " + {"E": "Expired", "C": "Cancelled", "T": "Terminated"}.get(f.get("status"), f.get("status") or "Inactive")
            if not decorate(f, area):
                continue
            k = (f["call_sign"], round(f["freq_mhz"], 5))
            if k in ov:
                for kk in ("alpha_tag", "description", "tone", "tag", "verified", "notes", "mode"):
                    f["ov_" + kk] = ov[k].get(kk)
            o = obs.get((round(f["freq_mhz"], 5), f["call_sign"]))
            if o:
                f["obs_status"], f["obs_level"], f["obs_notes"] = o["status"], o["level_dbm"], o["notes"]
            out.append(f)
        if "uls_hist" in layers:  # entries that were in a previous import but are gone now
            built = (con.execute("SELECT v FROM meta WHERE k='built_at'").fetchone() or [None])[0]
            if built:
                # the same filters as the live table, as far as history keeps the fields
                hw, ha = [area["sql"], "last_seen < ?"], list(area["args"]) + [built]
                if fmin is not None:
                    hw.append("freq_mhz >= ?"); ha.append(fmin)
                if fmax is not None:
                    hw.append("freq_mhz <= ?"); ha.append(fmax)
                if text:
                    hw.append("(licensee LIKE ? OR call_sign LIKE ?)"); ha += [f"%{text}%"] * 2
                w2, a2 = uls_filters(qs, hist=True)
                for r in con.execute(f"SELECT * FROM tx_history WHERE {' AND '.join(hw + w2)} LIMIT 5000", ha + a2):
                    f = dict(r)
                    f.update(layer="uls_hist", fid="hist:" + f["hkey"], label=f["licensee"],
                             category="History: Removed", status="REMOVED",
                             sig_type=sigid.from_uls_mode(f.get("mode")) or "Unknown",
                             band=uls_import.band_for(f["freq_mhz"]))
                    if decorate(f, area):
                        out.append(f)

    if "towers" in layers:
        # With a frequency or text filter on, show only towers carrying a matching license (or owner match)
        filtered = fmin is not None or fmax is not None or bool(text) or bool(adv_where)
        regs = {f["tower_reg"] for f in out if f.get("tower_reg")} if filtered else None
        if area.get("nationwide"):  # only the towers that carry a matching licence
            rl = sorted(regs or [])
            trows = [r for i in range(0, len(rl), 900)
                     for r in con.execute(f"SELECT * FROM tower WHERE reg IN ({','.join('?' * len(rl[i:i + 900]))})", rl[i:i + 900])]
        else:
            trows = con.execute(f"SELECT * FROM tower WHERE {area['sql']} LIMIT 5000", area["args"]).fetchall()
        for r in trows:
            f = dict(r)
            if filtered and f["reg"] not in regs and not (text and text.lower() in (f.get("owner") or "").lower()):
                continue
            f.update(layer="towers", fid="tower:" + f["reg"], label=f"{f.get('struct_type') or 'Structure'} "
                     f"{f.get('overall_agl_m') or '?'} m · {f.get('owner') or ''}".strip(), category="Tower / structure",
                     sig_type=None, freq_mhz=None)
            if decorate(f, area):
                out.append(f)

    if "broadcast" in layers and area["point"] and has_table(con, "bcast"):
        # broadcast lists carry no county, so this layer follows pin searches (and nationwide licence search, below)
        where, args = [area["sql"], "status IN ('Licensed', 'Special temporary authority')"], list(area["args"])
        if fmin is not None:
            where.append("freq_mhz >= ?"); args.append(fmin)
        if fmax is not None:
            where.append("freq_mhz <= ?"); args.append(fmax)
        if text:
            where.append("(call_sign LIKE ? OR licensee LIKE ? OR city LIKE ?)"); args += [f"%{text}%"] * 3
        for r in con.execute(f"SELECT * FROM bcast WHERE {' AND '.join(where)} LIMIT 3000", args):
            f = dict(r)
            f.update(layer="broadcast", fid=f"bc:{f['id']}", category="Broadcast / Media", band=uls_import.band_for(f["freq_mhz"]),
                     sig_type=BCAST_TYPE.get(f["band"]), erp_w=(f["erp_kw"] or 0) * 1000 or None, haat_m=f["haat_m"],
                     label=f"{f['call_sign']} {'%g kHz' % (f['freq_mhz'] * 1000) if f['band'] == 'AM' else '%g MHz' % f['freq_mhz']} {f['band']}"
                           + (f" (ch {f['channel']})" if f["band"] == "TV" else ""))
            if decorate(f, area):
                out.append(f)

    if "faa" in layers and area["point"] and has_table(con, "faa"):
        # FAA lists carry no county, so like broadcast this layer follows pin searches
        where, args = [area["sql"]], list(area["args"])
        if fmin is not None:
            where.append("freq_mhz >= ?"); args.append(fmin)
        if fmax is not None:
            where.append("freq_mhz <= ?"); args.append(fmax)
        if text:
            where.append("(ident LIKE ? OR name LIKE ? OR call LIKE ? OR use LIKE ?)"); args += [f"%{text}%"] * 4
        for r in con.execute(f"SELECT * FROM faa WHERE {' AND '.join(where)} LIMIT 5000", args):
            f = dict(r)
            f.update(layer="faa", fid=f"faa:{f['id']}", category="Aviation (FAA)", sig_type=faa.sig_type(f["freq_mhz"], f["kind"]),
                     band=uls_import.band_for(f["freq_mhz"]), licensee="FAA" if f["source"] != "FRQ" else (f["call"] or f["name"]),
                     label=f"{f['ident']} {f['name'] or ''} · {f['use'] or f['kind']}".strip(),
                     details=json.dumps({"Facility": f"{f['ident']} {f['name'] or ''} ({f['kind']})", "Use": f["use"], "Radio call": f["call"],
                                         "Sector": f["sector"], "Status": f["status"], "Remark": f["remark"], "Source": f"FAA NASR {f['source']}"}))
            if decorate(f, area):
                out.append(f)

    if "noaa" in layers and not area.get("nationwide") and has_table(con, "nwr"):
        # pin: transmitters in the area; county: the transmitters that warn that county (NOAA's own coverage list)
        if area["point"]:
            nrows = con.execute(f"SELECT * FROM nwr WHERE {area['sql']}", area["args"]).fetchall()
        else:
            nrows = [r for r in con.execute("SELECT * FROM nwr WHERE counties LIKE ?", (f'%"st": "{area["state"]}"%',))
                     if not area.get("county") or any(c["st"] == area["state"] and uls_import.norm_county(c["county"]) == area["county"]
                                                      for c in json.loads(r["counties"]))]
        for r in nrows:
            f = dict(r)
            if (fmin is not None and f["freq_mhz"] < fmin) or (fmax is not None and f["freq_mhz"] > fmax):
                continue
            cs = json.loads(f.pop("counties"))
            f.update(layer="noaa", fid=f"nwr:{f['id']}", category="NOAA Weather Radio", sig_type="NOAA Weather Radio",
                     band=uls_import.band_for(f["freq_mhz"]), erp_w=f["power_w"], licensee="NOAA National Weather Service",
                     label=f"{f['call_sign']} {f['site']} {f['freq_mhz']:.3f} MHz",
                     details=json.dumps({"Status": f["status"], "Forecast office": f["wfo"], "Transmitter power": f"{f['power_w']:g} W" if f["power_w"] else "",
                                         "Counties warned": "; ".join(f"{c['county']} {c['st']}{' (' + c['part'] + ')' if c['part'] else ''}" for c in cs),
                                         "SAME codes": " ".join(c["same"] for c in cs if c["same"])}))
            if decorate(f, area):
                out.append(f)

    if "captures" in layers and not area.get("nationwide"):
        where, args = [], []
        if area["point"]:
            where.append(area["sql"].replace("lat ", "p.lat ").replace("lon ", "p.lon "))
            args += list(area["args"])
        if mission is not None and fstr(qs, "all_captures") != "1":
            where.append("p.mission_id = ?")
            args.append(int(mission))
        if not where:
            where.append("0")  # county mode without a mission: captures have no county
        for r in con.execute(f"SELECT p.*, c.name AS capture_name FROM capture_point p JOIN capture c ON c.id=p.capture_id "
                             f"WHERE {' AND '.join(where)} LIMIT {MAX_ROWS}", args):
            f = dict(r)
            f.update(layer="captures", fid=f"cap:{f['id']}", category="Survey: " + (f.get("sig_type") or "Unknown"),
                     band=uls_import.band_for(f.get("freq_mhz")))
            if not f.get("label"):
                f["label"] = f.get("ident") or ""
            if decorate(f, area):
                out.append(f)
    if "psap" in layers and area["point"] and has_table(con, "psap"):  # 911 call centres, placed at their town's centre
        for r in con.execute(f"SELECT * FROM psap WHERE {area['sql']} LIMIT 2000", area["args"]):
            f = dict(r)
            f.update(layer="psap", fid=f"psap:{f['psap_id']}", label=f["name"], category="911 call centre (PSAP)", sig_type=None, freq_mhz=None,
                     details=json.dumps({"PSAP ID": f["psap_id"], "City": f["city"], "County": f["county"], "State": f["state"],
                                         "Position": f"approximate: {f['located']} (the registry has no addresses)",
                                         "Registry": f"FCC 911 Master PSAP Registry, rows last updated {psap.SOURCE_DATE}"}))
            if decorate(f, area):
                out.append(f)
    con.close()

    crowd = [l for l in ("wigle", "opencellid", "repeaterbook", "custom") + tuple(opensources.SOURCES) if l in layers]
    if crowd and area["point"]:
        cc = cdb()
        crowd_rows = []
        for r in cc.execute(f"SELECT * FROM ext_point WHERE {area['sql']} AND source IN ({','.join('?'*len(crowd))}) "
                            f"LIMIT {MAX_ROWS}", list(area["args"]) + crowd):
            f = dict(r)
            f.update(layer=f["source"], fid=f"ext:{f['id']}", category=f["layer"],
                     band=uls_import.band_for(f.get("freq_mhz")))
            if decorate(f, area):
                crowd_rows.append(f)
        cc.close()
        out.extend(opensources.merge(crowd_rows))  # the same emitter from several sources shows once, with every source's data

    if area["point"]:
        out.sort(key=lambda f: (f.get("dist_mi", 1e9), f.get("freq_mhz") or 0))
    return {"rows": out, "truncated": truncated, "center": list(area["point"]) if area["point"] else None,
            "radius": area["radius"]}


# ---------------------------------------------------------------- field packs for the phone app

PHONE_URL = "https://codygeraghty-omnyra.github.io/rf-recon/"
FP_JOB = {"running": False, "log": [], "result": None, "error": None}


def start_fieldpack(d):
    """Make a field pack in the background: states (e.g. "VA,MD") or a pin and radius."""
    if FP_JOB["running"]:
        return FP_JOB
    states = [s for s in re.split(r"[,\s]+", (d.get("states") or "").upper()) if s]
    lat, lon, radius = d.get("lat"), d.get("lon"), d.get("radius")
    if not states and (lat is None or lon is None or not radius):
        FP_JOB.update(error="Pick states, or drop a pin and set a radius.", log=[], result=None)
        return FP_JOB
    center = (float(lat), float(lon)) if not states else None
    name = (d.get("name") or "").strip() or (", ".join(states) if states else f"{center[0]:.3f}, {center[1]:.3f} {float(radius):g} mi")
    out = os.path.join(fieldpack.PACK_DIR, f"RF Recon pack - {fieldpack.safe_name(name)}.rfpack")
    FP_JOB.update(running=True, log=[], result=None, error=None)

    def work():
        try:
            FP_JOB["result"] = fieldpack.build(DB_PATH, out, states or None, center, float(radius) if center else None, name,
                                               log=FP_JOB["log"].append)
        except Exception as e:
            FP_JOB["error"] = f"{type(e).__name__}: {e}"
        finally:
            FP_JOB["running"] = False
    threading.Thread(target=work, daemon=True).start()
    return FP_JOB


# ---------------------------------------------------------------- one emitter: coverage, network; cell sites

EXTRA_ROUTES = {"/api/coverage", "/api/coverage.kmz", "/api/network", "/api/talkgroups/import", "/api/talkgroups/delete",
                "/api/cells", "/api/cells/import", "/api/basemaps", "/api/basemaps/import", "/api/basemaps/delete",
                "/api/tak/push", "/api/tak/settings", "/api/mwlinks", "/api/ais", "/api/fccid", "/api/find"}


def coverage_args(qs):
    """The query string of /api/coverage -> coverage.compute's arguments, and where the power figure came from."""
    lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
    if lat is None or lon is None:
        raise ValueError("Coverage needs the transmitter's location.")
    eirp, src = coverage.eirp_of(fnum(qs, "erp"), fnum(qs, "power"), fnum(qs, "gain"), fnum(qs, "eirp"))
    pin = (fnum(qs, "plat"), fnum(qs, "plon")) if fnum(qs, "plat") is not None and fnum(qs, "plon") is not None else None
    return dict(lat=lat, lon=lon, f_mhz=fnum(qs, "freq"), eirp=eirp, h_tx=fnum(qs, "h") or 30.0, haat=fnum(qs, "haat"),
                az=fnum(qs, "az"), bw=fnum(qs, "bw"), model=fstr(qs, "model") or "suburban", use_terrain=fstr(qs, "terrain") != "0",
                h_rx=fnum(qs, "rx", 1.5), threshold=fnum(qs, "threshold", -95.0), radius_mi=fnum(qs, "radius"),
                size=int(max(80, min(fnum(qs, "size", 200), 400))), pin=pin, covered_only=fstr(qs, "only") == "1"), src


# ---------------------------------------------------------------- backup of your own work

BACKUP_DIR = os.environ.get("RF_RECON_BACKUP")  # the launcher points this at the Drive folder's backups/
USER_TABLES = ("mission", "mission_log", "observation", "capture", "capture_point", "track_point", "overlay", "setting") + das.TABLES + network.TABLES


def backup_user_data():
    """Missions, captures, observations, labels and settings, but never API keys, into
    BACKUP_DIR/my-work-YYYY-MM-DD.db. FCC data isn't copied: it downloads again. Built in a local temp
    file and then copied, so SQLite never writes on a synced drive. Keeps the 14 newest."""
    import shutil
    import tempfile
    if not BACKUP_DIR:
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    tmp = os.path.join(tempfile.gettempdir(), "rf-recon-my-work.db")
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(DB_PATH, timeout=60)
    try:
        con.execute("ATTACH DATABASE ? AS b", (tmp,))
        for t in USER_TABLES:
            ddl = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
            if not ddl:
                continue
            con.execute(re.sub(r'^CREATE TABLE (IF NOT EXISTS )?"?' + t + r'"?', f"CREATE TABLE b.{t}", ddl[0], count=1))
            con.execute(f"INSERT INTO b.{t} SELECT * FROM main.{t}" + (" WHERE k <> 'creds'" if t == "setting" else ""))
        con.commit()
        con.execute("DETACH DATABASE b")
    finally:
        con.close()
    out = os.path.join(BACKUP_DIR, f"my-work-{time.strftime('%Y-%m-%d')}.db")
    shutil.copyfile(tmp, out)
    os.remove(tmp)
    for old in sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("my-work-") and f.endswith(".db"))[:-14]:
        os.remove(os.path.join(BACKUP_DIR, old))
    return out


def backup_loop(every_s=6 * 3600):
    while True:
        try:
            backup_user_data()
        except Exception as e:
            print(f"Backup of your work failed: {e}")
        time.sleep(every_s)


# ---------------------------------------------------------------- address search

GEO_CACHE = {}  # query -> Photon results, so retyping doesn't re-ask


def ensure_places():
    """Build the town/county index for databases imported before it existed (runs once, in the background)."""
    con = sqlite3.connect(DB_PATH, timeout=120)
    try:
        meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
        if meta.get("built_at") and meta.get("places_built_at") != meta.get("built_at"):
            uls_import.build_places(con)
    except sqlite3.Error as e:
        print(f"Town/county index not built: {e}")
    finally:
        con.close()


def ensure_sigwiki():
    """First start: fetch the Signal Identification Wiki catalog (a few seconds) if there's none yet.
    After that the Data & updates source keeps it current."""
    con = connectors.open_db(CROWD_PATH)
    try:
        con.executescript(sigwiki.SCHEMA)
        if not con.execute("SELECT 1 FROM sigwiki LIMIT 1").fetchone():
            sigwiki.fetch(con, log=lambda m, end="\n": None)
    except Exception as e:
        print(f"Signal ID Wiki catalog not fetched (offline?): {e}")
    finally:
        con.close()


def place_label(r):
    name = r["name"].title()
    if r["kind"] == "county":
        city = name.endswith(" City")
        suffix = "" if city else (" Parish" if r["state"] == "LA" else " County")
        return f"{name}{suffix}, {r['state']}"
    return f"{name}, {r['state']}"


def geocode(qs):
    """Address search: towns and counties from the FCC data (works offline), then street addresses and places
    from Photon (OpenStreetMap, free, US only) when online. Coordinates and Maps links are parsed in the page."""
    import towers
    q = fstr(qs, "q")
    if len(q) < 2:
        return {"results": [], "online": None}
    words = re.split(r"[\s,]+", q.strip())
    state = words[-1].upper() if len(words) > 1 and words[-1].upper() in towers.STATES else None
    name = " ".join(words[:-1] if state else words)
    name = re.sub(r"\s+(county|parish)$", "", name, flags=re.I)
    local = []
    here = (fnum(qs, "lat"), fnum(qs, "lon"))
    con = db()
    try:
        sql = "SELECT * FROM place WHERE name LIKE ?" + (" AND state = ?" if state else "")
        found = con.execute(sql + " ORDER BY n DESC LIMIT 60", [name + "%"] + ([state] if state else [])).fetchall()
        # exact name first, counties before towns, then nearest to where you're working (else the busiest)
        found.sort(key=lambda r: (r["name"].lower() != name.lower(), r["kind"] != "county",
                                  geo.haversine_km(here[0], here[1], r["lat"], r["lon"]) if None not in here else -r["n"]))
        for r in found[:6]:
            local.append({"label": place_label(r), "sub": "County" if r["kind"] == "county" else "Town",
                          "lat": round(r["lat"], 5), "lon": round(r["lon"], 5), "kind": r["kind"],
                          "state": r["state"], "county": r["name"] if r["kind"] == "county" else None, "source": "local"})
    except sqlite3.OperationalError:
        pass  # no town index yet (first start is building it)
    finally:
        con.close()
    key = (q.lower(), fstr(qs, "lat")[:5], fstr(qs, "lon")[:6])
    remote = GEO_CACHE.get(key)
    if remote is None:
        try:
            p = {"q": q, "limit": 7, "lang": "en"}
            if fnum(qs, "lat") is not None and fnum(qs, "lon") is not None:
                p.update(lat=fnum(qs, "lat"), lon=fnum(qs, "lon"))  # bias toward where you're working
            req = urllib.request.Request("https://photon.komoot.io/api/?" + urlencode(p),
                                         headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"})
            with urllib.request.urlopen(req, timeout=4) as r:
                feats = json.loads(r.read()).get("features", [])
            remote = []
            for f in feats:
                pr, (lon, lat) = f.get("properties", {}), f["geometry"]["coordinates"]
                if pr.get("countrycode") != "US":
                    continue
                street = " ".join(x for x in (pr.get("housenumber"), pr.get("street")) if x)
                head = pr.get("name") or street or pr.get("city") or ""
                tail = ", ".join(x for x in (street if street != head else None, pr.get("city"), pr.get("state")) if x)
                remote.append({"label": head + (f", {tail}" if tail else ""), "sub": (pr.get("osm_value") or pr.get("type") or "").replace("_", " ").title(),
                               "lat": round(lat, 6), "lon": round(lon, 6), "kind": "address", "source": "photon"})
            if len(GEO_CACHE) > 500:
                GEO_CACHE.clear()
            GEO_CACHE[key] = remote
        except Exception:
            remote = None  # offline or the service is down: the local half still answers
    first = (remote or []) if q[:1].isdigit() else []  # a house number means an address: put streets first
    rest = [x for x in (remote or []) if x not in first]
    return {"results": (first + local + rest)[:10], "online": remote is not None}


# ---------------------------------------------------------------- area report: signals not on the FCC list

NON_FCC_LAYERS = ("captures", "wigle", "opencellid", "repeaterbook", "custom")


def signal_review(qs):
    """Every survey and crowd point in the area, explained or flagged: an FCC licence on that frequency within
    40 mi, an allocation that allows it without a site licence (Part 15, Part 95, amateur, cellular...), or
    nothing at all: 'Unlisted', the ones worth a second look."""
    q = dict(qs)
    want = [l for l in (fstr(qs, "layers") or ",".join(NON_FCC_LAYERS)).split(",") if l in NON_FCC_LAYERS]
    q["layers"] = [",".join(want) or "none"]
    rows = query_area(q).get("rows", [])
    lookup, lcon = uls_lookup_factory()
    scon = cdb()
    out, counts = [], {}
    try:
        for r in rows:
            f, t = r.get("freq_mhz"), r.get("sig_type")
            cat, note = (sigid.authority(f, t) if t in sigid.PART15_TYPES | sigid.CELL_TYPES else (None, None))
            if cat is None and f and r.get("lat") is not None:
                m = lookup(f, r["lat"], r["lon"])
                if m:
                    cat, note = "FCC licensed", f"{m['call_sign']} {m.get('licensee') or ''} ({m['dist_mi']} mi)".strip()
            if cat is None:
                cat, note = sigid.authority(f, t)
            if cat is None:
                cat, note = (("Unlisted", "No FCC licence within 40 mi and no allocation that allows it") if f
                             else ("No frequency", "Recorded without a frequency"))
            counts[cat] = counts.get(cat, 0) + 1
            keep = {k: r.get(k) for k in ("fid", "layer", "lat", "lon", "dist_mi", "compass", "freq_mhz", "dbm",
                                          "sig_type", "label", "ident", "ts", "capture_name", "kind")}
            row = dict(keep, authority=cat, authority_note=note)
            if cat == "Unlisted" and not getattr(remote.ON, "user", None):  # what it could be, from the Signal Identification Wiki (the catalog stays on this PC)
                row["sigwiki"] = [{k: c[k] for k in ("title", "url", "score", "why")}
                                  for c in sigwiki.match(scon, f, r.get("bw_khz"), t, 3)]
            out.append(row)
    finally:
        lcon.close()
        scon.close()
    out.sort(key=lambda x: (x["authority"] != "Unlisted", x.get("dist_mi") or 0))
    return {"counts": counts, "rows": out, "layers": want}


# ---------------------------------------------------------------- a mission over time: replay, activity, bearings

BEARING_KEYS = ("bearing", "bearing_deg", "azimuth", "azimuth_deg", "az", "doa", "aoa", "direction_deg")


def point_bearing(extra):
    """The bearing a reading carries in its extra fields (the field log and the capture importer write
    "bearing"; captures imported before 10/29 kept the file's own column name)."""
    try:
        e = json.loads(extra) if extra else {}
    except ValueError:
        return None
    for k, v in (e.items() if isinstance(e, dict) else ()):
        if str(k).strip().lower().replace(" ", "_") in BEARING_KEYS:
            try:
                return float(v) % 360
            except (TypeError, ValueError):
                pass
    return None


def mission_timeline(mid, most=30000):
    """A mission's readings and GPS tracks in time order, for replay and the hour-by-weekday activity.
    Readings without a time are left out (and counted); past `most`, every nth reading is kept."""
    con = db()
    try:
        rows = con.execute("SELECT p.ts, p.lat, p.lon, p.freq_mhz, p.dbm, p.label, p.ident, p.kind, p.sig_type, p.extra, c.name AS capture "
                           "FROM capture_point p LEFT JOIN capture c ON c.id=p.capture_id WHERE p.mission_id=? ORDER BY p.ts", (mid,)).fetchall()
        track = con.execute("SELECT ts, lat, lon FROM track_point WHERE mission_id=? AND ts IS NOT NULL AND lat IS NOT NULL ORDER BY ts", (mid,)).fetchall()
    finally:
        con.close()
    timed = [r for r in rows if r["ts"]]
    step = max(1, len(timed) // most)
    pts = [{"ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "freq_mhz": r["freq_mhz"], "dbm": r["dbm"], "label": r["label"] or "",
            "ident": r["ident"] or "", "sig_type": r["sig_type"] or "", "capture": r["capture"] or "", "bearing": point_bearing(r["extra"])}
           for r in timed[::step]]
    tstep = max(1, len(track) // 20000)
    return {"points": pts, "track": [[r["ts"], r["lat"], r["lon"]] for r in track[::tstep]],
            "untimed": len(rows) - len(timed), "total": len(rows), "every": step}


def mission_bearings(mid):
    """Readings that carry a bearing, grouped by signal (the same MAC / cell id, else the 6.25 kHz channel: not the
    type as well, which the classifier can call differently reading to reading), with where each group's lines
    of bearing cross."""
    con = db()
    try:
        rows = con.execute("SELECT ts, lat, lon, freq_mhz, dbm, label, ident, kind, sig_type, extra FROM capture_point "
                           "WHERE mission_id=? AND extra IS NOT NULL AND lat IS NOT NULL", (mid,)).fetchall()
    finally:
        con.close()
    groups = {}
    for r in rows:
        b = point_bearing(r["extra"])
        if b is None:
            continue
        k = (signal_key(r) or f"label:{r['label']}").split("|")[0]
        g = groups.setdefault(k, {"key": k, "freq_mhz": r["freq_mhz"], "ident": r["ident"] or "", "label": r["label"] or "",
                                  "sig_type": r["sig_type"] or "", "readings": []})
        g["label"] = g["label"] or r["label"] or ""
        g["readings"].append({"ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "bearing": b, "dbm": r["dbm"]})
    out = []
    for g in groups.values():
        g["fix"] = geo.bearing_fix([(x["lat"], x["lon"], x["bearing"]) for x in g["readings"]])
        out.append(g)
    out.sort(key=lambda g: (-len(g["readings"]), g["freq_mhz"] or 0))
    return {"groups": out}


# ---------------------------------------------------------------- compare two surveys (baseline comparison)

def signal_key(r):
    """What makes two observations the same signal: a MAC / cell id when there is one, else the 6.25 kHz
    channel and the signal type."""
    if r["ident"] and (r["kind"] or "").upper() in ("WIFI", "BT", "BLE", "LTE", "NR", "GSM", "WCDMA", "CDMA"):
        return f"id:{r['ident'].lower()}"
    if r["freq_mhz"]:
        return f"f:{round(r['freq_mhz'] / 0.00625) * 0.00625:.5f}|{r['sig_type'] or ''}"
    return None


def compare_missions(a, b, delta_db=6.0):
    """Signals in mission b that are new, gone or changed against mission a (the baseline)."""
    con = db()
    try:
        names = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM mission WHERE id IN (?, ?)", (a, b))}
        if a not in names or b not in names:
            raise LookupError("Pick two missions that exist.")
        sides = {}
        for mid in (a, b):
            sig = {}
            for r in con.execute("SELECT p.*, c.fmt FROM capture_point p JOIN capture c ON c.id = p.capture_id WHERE p.mission_id = ?", (mid,)):
                k = signal_key(r)
                if not k:
                    continue
                dbm = None if r["fmt"] == "sweep" else r["dbm"]  # SDR sweep levels are relative dB, not dBm: not comparable
                s = sig.setdefault(k, {"key": k, "freq_mhz": r["freq_mhz"], "sig_type": r["sig_type"], "label": r["label"] or r["ident"] or "",
                                       "ident": r["ident"], "n": 0, "max_dbm": None, "lat": r["lat"], "lon": r["lon"], "first": r["ts"], "last": r["ts"]})
                s["n"] += 1
                if dbm is not None and (s["max_dbm"] is None or dbm > s["max_dbm"]):
                    s.update(max_dbm=dbm, lat=r["lat"], lon=r["lon"])  # where it was strongest
                s["first"] = min(filter(None, [s["first"], r["ts"]]), default=None)
                s["last"] = max(filter(None, [s["last"], r["ts"]]), default=None)
            sides[mid] = sig
    finally:
        con.close()
    A, B = sides[a], sides[b]
    new = [B[k] for k in B.keys() - A.keys()]
    gone = [A[k] for k in A.keys() - B.keys()]
    changed, same = [], 0
    for k in A.keys() & B.keys():
        x, y = A[k], B[k]
        if x["max_dbm"] is not None and y["max_dbm"] is not None and abs(y["max_dbm"] - x["max_dbm"]) >= delta_db:
            changed.append(dict(y, before_dbm=x["max_dbm"], delta_db=round(y["max_dbm"] - x["max_dbm"], 1)))
        else:
            same += 1
    by_level = lambda s: -(s.get("max_dbm") if s.get("max_dbm") is not None else -999)
    return {"a": {"id": a, "name": names[a], "signals": len(A)}, "b": {"id": b, "name": names[b], "signals": len(B)},
            "new": sorted(new, key=by_level), "gone": sorted(gone, key=by_level),
            "changed": sorted(changed, key=lambda s: -abs(s["delta_db"])), "same": same, "delta_db": delta_db}


# ---------------------------------------------------------------- heatmaps & exports

def heat_file_key(r):
    """Which file a survey point came from: a capture file, or an imported / crowd layer."""
    return f"cap:{r.get('capture_id')}" if r.get("layer") == "captures" else f"{r.get('layer')}:{r.get('category') or ''}"


NO_TX = "No licensed transmitters (30 MHz and up, with power on file) match the layers and filters on: predicted heatmaps need some."


def heat_extent(rows):
    """A county search has no pin: the heatmap covers where its entries are (the middle 98%, so one stray
    coordinate doesn't stretch it). Returns lat, lon, radius in miles."""
    la = sorted(r["lat"] for r in rows if r.get("lat") is not None)
    lo = sorted(r["lon"] for r in rows if r.get("lon") is not None)
    if not la:
        raise ValueError("Nothing in this county has a location to map. Drop a pin for a heatmap.")
    cut = len(la) // 100
    s, n, w, e = la[cut], la[-1 - cut], lo[cut], lo[-1 - cut]
    lat, lon = (s + n) / 2, (w + e) / 2
    half_mi = max(geo.haversine_km(s, lon, n, lon), geo.haversine_km(lat, w, lat, e)) / 2 / geo.MI_KM
    return lat, lon, min(60.0, max(2.0, half_mi * 1.05))


def heatmap(qs):
    lat, lon, radius = fnum(qs, "lat"), fnum(qs, "lon"), fnum(qs, "radius", 10)
    if lat is None and not (fstr(qs, "state") and fstr(qs, "county")):
        raise ValueError("Heatmaps need a pin or a county.")
    kind = fstr(qs, "kind") or "predicted"
    res = query_area(qs) if lat is None or kind != "carrier" else {"rows": []}  # carrier coverage doesn't use the area's rows
    if lat is None:
        lat, lon, radius = heat_extent(res["rows"])
    size = int(fnum(qs, "size", 200 if kind != "terrain" else 160))
    size = max(60, min(size, 600 if kind != "terrain" else 220))  # terrain is slower per cell
    grid = geo.make_grid(lat, lon, radius, size)
    rows = res["rows"]
    types = set(filter(None, fstr(qs, "types").split("|")))
    bands = set(filter(None, fstr(qs, "bands").split("|")))
    cats = set(filter(None, fstr(qs, "cats").split("|")))
    ident = fstr(qs, "ident")
    files = set(filter(None, fstr(qs, "files").split("|")))  # survey files: "cap:<capture id>" or "<layer>:<layer name>"
    fq, ftol = fnum(qs, "freq"), fnum(qs, "ftol", 0.0125)

    def keep(r):
        if files and heat_file_key(r) not in files:
            return False
        if fq is not None and (r.get("freq_mhz") is None or abs(r["freq_mhz"] - fq) > ftol):
            return False
        if types and (r.get("sig_type") or "Unknown") not in types:
            return False
        if bands and (r.get("band") or "Other") not in bands:
            return False
        if cats and (r.get("category") or "Other") not in cats:
            return False
        if ident and ident.lower() not in (f"{r.get('ident') or ''} {r.get('ext_id') or ''} {r.get('label') or ''}").lower():
            return False
        return True
    rows = [r for r in rows if keep(r)]
    if kind == "predicted":
        seen, tx = set(), []
        for r in rows:
            if r["layer"] not in ("uls", "broadcast", "noaa") or r.get("lat") is None or r.get("is_mobile") or (r.get("freq_mhz") or 0) < 30:
                continue  # below 30 MHz (AM broadcast, HF) reach is ground wave and skywave: free space says nothing about it
            erp = r.get("erp_w") or r.get("power_out_w")
            key = (r["lat"], r["lon"], r["freq_mhz"])
            if erp and key not in seen:
                seen.add(key)
                tx.append((r["lat"], r["lon"], erp, r["freq_mhz"]))
        if not tx:
            raise ValueError(NO_TX)
        tx.sort(key=lambda t: -t[2])
        geo.grid_predicted(grid, tx[:400], combine=fstr(qs, "combine") or "max")
        unit, desc = "dBm", f"Free-space predicted level (best case) from {min(len(tx), 400)} licensed transmitters (30 MHz and up)"
    elif kind == "terrain":  # the per-emitter coverage model over the area: hills for the strongest, smooth earth for the next
        seen, txs = set(), []
        for r in rows:
            if r["layer"] not in ("uls", "broadcast", "noaa") or r.get("lat") is None or r.get("is_mobile") or (r.get("freq_mhz") or 0) < 30:
                continue
            key = (r["lat"], r["lon"], r["freq_mhz"])
            erp, pw = r.get("erp_w"), r.get("power_out_w")
            if (erp or pw) and key not in seen:
                seen.add(key)
                eirp, _ = coverage.eirp_of(erp, pw, r.get("gain_dbi"))
                txs.append({"lat": r["lat"], "lon": r["lon"], "eirp": eirp, "f_mhz": r["freq_mhz"], "h_tx": r.get("height_tip_m") or 30.0,
                            "haat": r.get("haat_m"), "az": r.get("azimuth"), "bw": r.get("beamwidth")})
        if not txs:
            raise ValueError(NO_TX)
        txs.sort(key=lambda t: -t["eirp"])
        n_ter = coverage.area(grid, txs[:60], fstr(qs, "model") or "suburban", fstr(qs, "terrain") != "0", fnum(qs, "rx", 1.5),
                              with_terrain=int(fnum(qs, "with_terrain", 25)))
        unit, desc = "dBm", (f"Predicted level (Hata, suburban) from the {min(len(txs), 60)} strongest licensed transmitters: "
                             f"hills counted for the {n_ter} strongest, smooth earth for the rest. Handheld at 1.5 m; 30 MHz and up.")
    elif kind == "measured":
        pts = [(r["lat"], r["lon"], r.get("dbm")) for r in rows if r["layer"] in ("captures", "wigle", "opencellid", "custom")
               and r.get("dbm") is not None]
        geo.grid_measured(grid, pts, cell_radius=int(fnum(qs, "spread", 4)), metric=fstr(qs, "metric") or "mean")
        unit, desc = "dBm", (f"Measured level from {len(pts)} survey points" + (f" in {len(files)} file{'s' * (len(files) > 1)}" if files else "")
                             + (f", {ident or ''}{' ' if ident and fq else ''}{f'{fq:g} MHz' if fq else ''}" if ident or fq else ""))
    elif kind == "carrier":  # one carrier's coverage from the FCC Broadband Map (bdc.py): the strongest signal it modelled per hexagon
        provider, tech, env = int(fnum(qs, "provider", 0)), int(fnum(qs, "tech", 0)), fnum(qs, "env")
        if not provider or not tech:
            raise ValueError("Pick a carrier and technology for the carrier coverage heatmap.")
        n = bdc.paint(uls_import.DATA_DIR, grid, provider, tech, int(env) if env is not None else None)
        if not n:
            raise ValueError("No coverage of that kind from that carrier here, or this area isn't in your carrier-coverage states (Data & updates).")
        info = bdc.describe(uls_import.DATA_DIR, provider)
        unit, desc = "dBm", (f"{info['brand']} {bdc.TECH.get(tech, tech)}{', ' + bdc.ENV[int(env)] if env is not None else ''}: the strongest signal the "
                             f"carrier modelled in each of {n:,} hexagons (FCC Broadband Map, data as of {info['as_of']})")
    else:
        pts = [(r["lat"], r["lon"], 1) for r in rows if r.get("lat") is not None]
        geo.grid_density(grid, pts)
        unit, desc = "%", f"Density of {len(pts)} RF points"
    floor = fnum(qs, "floor")
    if floor is not None:  # coverage edge: cells weaker than this stay clear
        grid.values = [[v if v is None or v >= floor else None for v in row] for row in grid.values]
    vmin, vmax = fnum(qs, "vmin"), fnum(qs, "vmax")
    rgba, vmin, vmax = geo.colorize(grid, vmin, vmax, int(fnum(qs, "alpha", 190)))
    return grid, rgba, vmin, vmax, unit, desc


def heatmap_bundle(qs):
    grid, rgba, vmin, vmax, unit, desc = heatmap(qs)
    png = geo.png_rgba(grid.cols, grid.rows, rgba)
    name = re.sub(r"[^A-Za-z0-9_-]+", "_", fstr(qs, "name") or "rf_heatmap")
    legend = f"{desc}. Color scale {vmin:.1f} to {vmax:.1f} {unit} (blue = low, red = high)."
    kml = (geo.KML_HEAD + f"<name>{escape(name)}</name>" + geo.ground_overlay(name, "heatmap.png", grid, legend)
           + "<ScreenOverlay><name>Legend</name><Icon><href>legend.png</href></Icon>"
           '<overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/><screenXY x="0.02" y="0.04" xunits="fraction" yunits="fraction"/>'
           '<size x="0" y="0" xunits="pixels" yunits="pixels"/></ScreenOverlay></Document></kml>')
    kmzb = geo.kmz(kml, {"heatmap.png": png, "legend.png": geo.legend_png(vmin, vmax)})
    buf = io.BytesIO()
    import zipfile
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}.kmz", kmzb)
        z.writestr(f"{name}_rgba.tif", geo.geotiff(grid, rgba))
        z.writestr(f"{name}_{'dbm' if unit == 'dBm' else 'value'}.tif", geo.geotiff(grid))
        z.writestr(f"{name}.png", png)
        z.writestr(f"{name}.pgw", geo.world_file(grid))
        z.writestr(f"{name}.prj", geo.WGS84_PRJ)
        z.writestr(f"{name}.png.aux.xml", f"<PAMDataset><SRS>{escape(geo.WGS84_PRJ)}</SRS></PAMDataset>")
        z.writestr(f"{name}_rgba.tfw", geo.world_file(grid))
        z.writestr("README.txt",
                   f"{legend}\nBounds (WGS84): N {grid.n:.6f}  S {grid.s:.6f}  E {grid.e:.6f}  W {grid.w:.6f}\n"
                   f"Grid {grid.cols}x{grid.rows}, cell {grid.dx:.7f} x {grid.dy:.7f} deg.\n\n"
                   f"{name}.kmz          Google Earth / ATAK / WinTAK (ground overlay + legend)\n"
                   f"{name}_rgba.tif     GeoTIFF picture (EPSG:4326) for QGIS, ArcGIS, Global Mapper, ATAK\n"
                   f"{name}_dbm.tif      GeoTIFF of the values (float32, nodata -9999) for GIS analysis\n"
                   f"{name}.png + .pgw + .prj   PNG with world file, for tools that prefer it\n")
    return buf.getvalue(), name


def features_kml(rows, center, radius, mission_id=None, include_tracks=True):
    parts = [geo.KML_HEAD, "<name>RF Recon export</name>"]
    styles = {}
    for r in rows:
        t = r.get("sig_type") or r.get("layer")
        if t not in styles:
            col = sigid.color_for(t) if t in sigid.LIBRARY else "#6e7781"
            sid = "s" + str(len(styles))
            styles[t] = sid
            parts.append(f'<Style id="{sid}"><IconStyle><color>{geo.kml_color(col)}</color><scale>0.8</scale>'
                         '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>')
    if center:
        parts.append(f"<Placemark><name>Pin ({radius} mi)</name><Point><coordinates>{center[1]},{center[0]},0</coordinates></Point></Placemark>")
        ring = []
        for i in range(73):
            b = math.radians(i * 5)
            d = radius * geo.MI_KM / geo.EARTH_KM
            la1 = math.radians(center[0])
            la2 = math.asin(math.sin(la1) * math.cos(d) + math.cos(la1) * math.sin(d) * math.cos(b))
            lo2 = math.radians(center[1]) + math.atan2(math.sin(b) * math.sin(d) * math.cos(la1), math.cos(d) - math.sin(la1) * math.sin(la2))
            ring.append(f"{math.degrees(lo2):.6f},{math.degrees(la2):.6f},0")
        parts.append(f"<Placemark><name>Search radius</name><Style><LineStyle><color>ff888888</color><width>2</width></LineStyle>"
                     f"<PolyStyle><fill>0</fill></PolyStyle></Style><LineString><coordinates>{' '.join(ring)}</coordinates></LineString></Placemark>")
    by_layer = {}
    for r in rows:
        if r.get("lat") is None:
            continue
        by_layer.setdefault(r["layer"], []).append(r)
    for layer, rs in by_layer.items():
        parts.append(f"<Folder><name>{escape(layer)}</name>")
        for r in rs:
            fields = {k: v for k, v in r.items() if v not in (None, "") and k not in ("details", "extra")}
            ext = "".join(f'<Data name="{escape(str(k))}"><value>{escape(str(v))}</value></Data>' for k, v in fields.items())
            nm = f"{r['freq_mhz']:.5f} MHz " if r.get("freq_mhz") else ""
            nm += r.get("ov_alpha_tag") or r.get("label") or r.get("call_sign") or ""
            when = f"<TimeStamp><when>{escape(r['ts'])}</when></TimeStamp>" if r.get("ts") else ""
            parts.append(f'<Placemark><name>{escape(nm)}</name>{when}<styleUrl>#{styles.get(r.get("sig_type") or r.get("layer"))}</styleUrl>'
                         f"<ExtendedData>{ext}</ExtendedData><Point><coordinates>{r['lon']},{r['lat']},{r.get('alt') or 0}"
                         f"</coordinates></Point></Placemark>")
        parts.append("</Folder>")
    if include_tracks and mission_id is not None:
        con = db()
        caps = con.execute("SELECT id, name FROM capture WHERE mission_id=?", (mission_id,)).fetchall()
        parts.append("<Folder><name>GPS tracks</name>")
        for c in caps:
            tp = con.execute("SELECT ts, lat, lon, alt FROM track_point WHERE capture_id=? ORDER BY ts", (c["id"],)).fetchall()
            if len(tp) < 2:
                continue
            if all(t["ts"] for t in tp):
                body = "".join(f"<when>{t['ts']}</when>" for t in tp) + "".join(
                    f"<gx:coord>{t['lon']} {t['lat']} {t['alt'] or 0}</gx:coord>" for t in tp)
                parts.append(f"<Placemark><name>{escape(c['name'])}</name><Style><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>"
                             f"<gx:Track><altitudeMode>clampToGround</altitudeMode>{body}</gx:Track></Placemark>")
            else:
                coords = " ".join(f"{t['lon']},{t['lat']},0" for t in tp)
                parts.append(f"<Placemark><name>{escape(c['name'])}</name><Style><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>"
                             f"<LineString><tessellate>1</tessellate><coordinates>{coords}</coordinates></LineString></Placemark>")
        parts.append("</Folder>")
        con.close()
    parts.append("</Document></kml>")
    return "".join(parts)


CSV_SKIP = {"details", "extra"}


def to_csv(rows):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys and k not in CSV_SKIP:
                keys.append(k)
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=keys, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def import_overlay_csv(text, state, county):
    """RadioReference-style CSV (Frequency, License, Tone, Alpha Tag, Description, Mode, Tag) or this app's export."""
    rd = csv.DictReader(io.StringIO(text))
    low = {k.lower().strip(): k for k in (rd.fieldnames or [])}

    def col(row, *names):
        for n in names:
            k = low.get(n)
            if k and row.get(k):
                return row[k].strip()
        return ""
    con = db()
    n = 0
    for row in rd:
        try:
            f = float(col(row, "frequency", "freq_mhz", "output", "freq"))
        except ValueError:
            continue
        con.execute(
            """INSERT INTO overlay(call_sign,freq_mhz,county,state,alpha_tag,description,tone,tag,mode,verified,notes,source,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(call_sign,freq_mhz) DO UPDATE SET
               alpha_tag=COALESCE(NULLIF(excluded.alpha_tag,''),alpha_tag), description=COALESCE(NULLIF(excluded.description,''),description),
               tone=COALESCE(NULLIF(excluded.tone,''),tone), tag=COALESCE(NULLIF(excluded.tag,''),tag), mode=COALESCE(NULLIF(excluded.mode,''),mode),
               verified=MAX(verified, excluded.verified), source=excluded.source, updated_at=excluded.updated_at""",
            (col(row, "license", "call_sign", "callsign").upper(), round(f, 5), county.upper() or None, state.upper() or None,
             col(row, "alpha tag", "ov_alpha_tag"), col(row, "description", "ov_description"), col(row, "tone", "pl", "ov_tone"),
             col(row, "tag", "ov_tag"), col(row, "mode"), 1 if (col(row, "ov_verified", "verified") in ("1", "true", "yes") or col(row, "alpha tag")) else 0,
             col(row, "notes", "ov_notes"), "csv", now()))
        n += 1
    con.commit()
    con.close()
    return n


# ---------------------------------------------------------------- missions

def mission_row(con, mid):
    r = con.execute("SELECT * FROM mission WHERE id=?", (mid,)).fetchone()
    if not r:
        return None
    m = dict(r)
    m["settings"] = dict(DEFAULT_MISSION_SETTINGS, **json.loads(m["settings"] or "{}"))
    m["captures"] = [dict(c) for c in con.execute("SELECT * FROM capture WHERE mission_id=? ORDER BY id DESC", (mid,))]
    return m


def diff(old, new, prefix=""):
    out = []
    for k in sorted(set(old) | set(new)):
        a, b = old.get(k), new.get(k)
        if isinstance(a, dict) and isinstance(b, dict):
            out += diff(a, b, prefix + k + ".")
        elif a != b:
            out.append(f"{prefix}{k}: {json.dumps(a)} → {json.dumps(b)}")
    return out


def save_mission(d, mid=None):
    con = db()
    fields = ["name", "objective", "status", "lat", "lon", "radius_mi", "state", "start_date", "end_date", "operator"]
    if mid is None:
        settings = dict(DEFAULT_MISSION_SETTINGS, **(d.get("settings") or {}))
        cur = con.execute(f"INSERT INTO mission({','.join(fields)},settings,created_at,updated_at) VALUES({','.join('?'*(len(fields)+3))})",
                          [d.get(f) for f in fields[:2]] + [d.get("status") or "Planning"] +
                          [d.get(f) for f in fields[3:]] + [json.dumps(settings), now(), now()])
        mid = cur.lastrowid
        con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)", (mid, now(), "created", d.get("name") or ""))
    else:
        old = mission_row(con, mid)
        if old is None:  # deleted in another window (phone + laptop over --lan)
            con.close()
            raise LookupError(f"Mission {mid} was deleted. Reload to see the current missions.")
        old_core = {f: old[f] for f in fields}
        new_core = {f: d.get(f, old[f]) for f in fields}
        new_settings = dict(old["settings"], **(d.get("settings") or {}))
        changes = diff(old_core, new_core) + diff(old["settings"], new_settings, "settings.")
        con.execute(f"UPDATE mission SET {','.join(f+'=?' for f in fields)}, settings=?, updated_at=? WHERE id=?",
                    [new_core[f] for f in fields] + [json.dumps(new_settings), now(), mid])
        for c in changes:
            con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)", (mid, now(), "setting", c))
    con.commit()
    m = mission_row(con, mid)
    con.close()
    return m


def uls_lookup_factory():
    con = db()

    def lookup(freq, lat, lon):
        tol = 0.00626
        s, n, w, e = geo.bbox(lat, lon, 40)
        best = None
        for r in con.execute("SELECT call_sign, licensee, mode, lat, lon, freq_mhz FROM tx WHERE status='A' AND "
                             "freq_mhz BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                             (freq - tol, freq + tol, s, n, w, e)):
            d = geo.haversine_km(lat, lon, r["lat"], r["lon"]) / geo.MI_KM
            if best is None or d < best["dist_mi"]:
                best = dict(r, dist_mi=round(d, 1))
        return best
    return lookup, con


# ---------------------------------------------------------------- map tiles

_USGS = "https://basemap.nationalmap.gov/arcgis/rest/services/{}/MapServer/tile/{{z}}/{{y}}/{{x}}"
TILE_SOURCES = {  # id -> URL template; {bbox} sources are ArcGIS exports rendered per tile (EPSG:3857)
    "osm": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "usgs-imagery": _USGS.format("USGSImageryOnly"),
    "usgs-imagery-topo": _USGS.format("USGSImageryTopo"),
    "usgs-topo": _USGS.format("USGSTopo"),
    "usgs-relief": _USGS.format("USGSShadedReliefOnly"),
    "esri-imagery": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "counties": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/export"
                "?bbox={bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&dpi=96&f=image",
}
WEB_MERCATOR = 20037508.342789244


def tile_url(template, z, x, y):
    if "{bbox}" in template:
        size = 2 * WEB_MERCATOR / 2 ** z
        minx, maxy = -WEB_MERCATOR + x * size, WEB_MERCATOR - y * size
        return template.format(bbox=f"{minx:.2f},{maxy - size:.2f},{minx + size:.2f},{maxy:.2f}")
    return template.format(z=z, x=x, y=y)


def tile_type(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return "application/octet-stream"


# ---------------------------------------------------------------- http

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def raw_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def body_json(self):
        b = self.raw_body()
        return json.loads(b or b"{}")

    def attach(self, data, fname, ctype):
        return self.send(200, data, ctype, {"Content-Disposition": f'attachment; filename="{fname}"'})

    def extra_route(self, method, p, qs):
        """One emitter's coverage (coverage.py) and what it's networked with (network.py), talk group lists, and the
        cell sites around the pin (cells.py). LookupError -> 404 and anything else -> 500 reach the caller's handler."""
        try:
            if p in ("/api/coverage", "/api/coverage.kmz"):
                args, src = coverage_args(qs)
                res, grid, rgba = coverage.compute(**args)
                res.update(eirp_src=src, attribution=terrain.ATTRIBUTION if res["terrain"] else "")
                png = geo.png_rgba(grid.cols, grid.rows, rgba)
                if p.endswith(".kmz"):
                    name = fstr(qs, "name") or "coverage"
                    data = geo.kmz(coverage.kml(res, grid, name, args["lat"], args["lon"]),
                                   {"coverage.png": png, "legend.png": geo.legend_png(res["vmin"], res["vmax"])})
                    return self.attach(data, re.sub(r'[\\/:*?"<>|]+', "-", name)[:80] + " coverage.kmz", "application/vnd.google-earth.kmz")
                res["png"] = base64.b64encode(png).decode()
                return self.send(200, res)
            if p == "/api/find":  # one search over everything (finder.py)
                con, cc = db(), cdb()
                try:
                    scope = set(filter(None, fstr(qs, "scope").split(","))) or None
                    return self.send(200, finder.everything(con, cc, fstr(qs, "q"), fnum(qs, "lat"), fnum(qs, "lon"), scope))
                finally:
                    con.close()
                    cc.close()
            if p == "/api/fccid":  # an FCC ID or grantee code -> its equipment grants (fccid.py)
                con = db()
                try:
                    return self.send(200, fccid.lookup(fstr(qs, "q"), con=con))
                finally:
                    con.close()
            if p == "/api/ais":  # live ships in the box (ais.py); the stream runs only while a map keeps asking
                s_, n_, w_, e_ = (fnum(qs, k) for k in ("s", "n", "w", "e"))
                if None in (s_, n_, w_, e_) or n_ - s_ > 6 or e_ - w_ > 8:
                    raise ValueError("Zoom in: ships stream for an area up to about 6 x 8 degrees.")
                if getattr(remote.ON, "user", None):  # remote viewers never start the stream on Cody's key
                    return self.send(200, ais.known(s_, n_, w_, e_))
                return self.send(200, ais.ships(s_, n_, w_, e_, (get_setting("creds", {}) or {}).get("aisstream_key")))
            if p == "/api/mwlinks":  # microwave backhaul links with an end in the box (uls_import.build_links)
                s_, n_, w_, e_ = (fnum(qs, k) for k in ("s", "n", "w", "e"))
                if None in (s_, n_, w_, e_):
                    raise ValueError("Give the map's box: s, n, w, e.")
                con = db()
                try:
                    if not has_table(con, "mw_link"):
                        return self.send(200, {"links": [], "loaded": False})
                    lim = int(min(fnum(qs, "limit", 3000), 6000))
                    seen, links = set(), []
                    for side in ("tx", "rx"):
                        for r in con.execute(f"SELECT rowid, * FROM mw_link WHERE {side}_lat BETWEEN ? AND ? AND {side}_lon BETWEEN ? AND ? LIMIT ?",
                                             (s_, n_, w_, e_, lim)):
                            if r["rowid"] not in seen:
                                seen.add(r["rowid"])
                                links.append(dict(r))
                    loaded = bool(links) or con.execute("SELECT 1 FROM mw_link LIMIT 1").fetchone() is not None
                    return self.send(200, {"links": links[:lim], "loaded": loaded, "truncated": len(links) > lim})
                finally:
                    con.close()
            if p == "/api/tak/settings":  # where Push to ATAK sends: the network's TAK multicast, and a TAK Server if set
                if method == "POST":
                    d = self.body_json()
                    cfg = {"multicast": bool(d.get("multicast", True)), "group": (d.get("group") or "").strip(), "server": (d.get("server") or "").strip()}
                    for k in ("group", "server"):
                        if cfg[k]:
                            takpush.addr(cfg[k], 6969)  # refuses anything that isn't a host[:port]
                    set_setting("tak", cfg)
                return self.send(200, dict({"multicast": True, "group": "", "server": ""}, **(get_setting("tak", {}) or {}),
                                           default_group=takpush.MULTICAST))
            if p == "/api/tak/push" and method == "POST":  # RF Recon's markers straight into ATAK / WinTAK (takpush.py)
                d = self.body_json()
                return self.send(200, takpush.push(d.get("events"), get_setting("tak", {}) or {}, bool(d.get("open", True))))
            if p.startswith("/api/basemaps"):  # your own base maps (basemaps.py)
                maps = get_setting("basemaps", []) or []
                if p == "/api/basemaps/import" and method == "POST":
                    if "json" in (self.headers.get("Content-Type") or "").lower():
                        d = self.body_json()
                        maps = basemaps.add(maps, d.get("name"), url=d.get("url"))
                    else:
                        maps = basemaps.add(maps, fstr(qs, "name"), data=self.raw_body(), filename=fstr(qs, "filename"))
                    set_setting("basemaps", maps)
                elif p == "/api/basemaps/delete" and method == "POST":
                    maps = basemaps.remove(maps, fstr(qs, "id"))
                    set_setting("basemaps", maps)
                return self.send(200, {"maps": maps})
            con = db()
            try:
                if p == "/api/network":
                    if not fstr(qs, "call_sign"):
                        raise ValueError("Networks come from licences: pick a transmitter with a call sign.")
                    return self.send(200, network.network(con, fstr(qs, "call_sign"), fnum(qs, "freq"), fnum(qs, "lat"), fnum(qs, "lon"),
                                                          fstr(qs, "tower") or None, fnum(qs, "radius", 60)))
                if p == "/api/talkgroups/import" and method == "POST":
                    return self.send(200, network.import_talkgroups(con, fstr(qs, "system"), fstr(qs, "name"), self.raw_body()))
                if p == "/api/talkgroups/delete" and method == "POST":
                    con.execute("DELETE FROM talkgroup WHERE system=?", (fstr(qs, "system"),))
                    con.commit()
                    return self.send(200, {"ok": True})
                if p == "/api/cells":
                    lat, lon, mid = fnum(qs, "lat"), fnum(qs, "lon"), fnum(qs, "mission")
                    if lat is None or lon is None:
                        raise ValueError("Cell sites need a pin.")
                    cc = cdb()
                    try:
                        return self.send(200, cells.sites(con, cc, lat, lon, fnum(qs, "radius", 5), int(mid) if mid is not None else None))
                    finally:
                        cc.close()
                if p == "/api/cells/import" and method == "POST":  # an OpenCelliD download, kept to the states in Data & updates
                    states = [s for s in re.split(r"[,\s]+", get_setting("update.states", "") or "") if s]
                    boxes = [b for b in (fieldpack.trimmed_bbox(con, [st]) for st in states) if b]
                    cc = cdb()
                    try:
                        r = cells.import_ocid(cc, fstr(qs, "name"), self.raw_body(), boxes or None)
                    finally:
                        cc.close()
                    return self.send(200, dict(r, states=states))
            finally:
                con.close()
            return self.send(404, {"error": "not found"})
        except ValueError as e:
            return self.send(400, {"error": str(e)})

    def das_route(self, method, p, qs):
        """DAS / ERCES jobs, contacts, pre-survey, file import and the job folders (das.py). Errors reach the
        caller's handler: LookupError -> 404, anything else -> 500 (ValueError messages are shown as they are)."""
        con = db()
        try:
            m = re.match(r"^/api/das/jobs(?:/(\d+))?(?:/(\w+))?(?:/(\w+))?$", p)
            if m:
                jid, action, sub = (int(m.group(1)) if m.group(1) else None), m.group(2), m.group(3)
                job = das.job_row(con, jid) if jid else None
                if jid and job is None:
                    raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
                if method == "GET":
                    if jid is None:
                        return self.send(200, {"jobs": das.list_jobs(con), "stages": das.STAGES, "folder": das.DAS_DIR})
                    if action is None:
                        return self.send(200, job)
                    if action == "files":
                        return self.send(200, das.list_files(jid, job["name"]))
                    if action == "file":
                        fp = das.file_path(jid, job["name"], fstr(qs, "name"))
                        if not os.path.isfile(fp):
                            raise LookupError("No such file.")
                        with open(fp, "rb") as fh:
                            data = fh.read()
                        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
                        inline = ctype.startswith(("image/", "text/")) or ctype == "application/pdf"
                        return self.send(200, data, ctype, {"Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{os.path.basename(fp)}"'})
                else:
                    if jid is None:
                        return self.send(200, das.save_job(con, self.body_json()))
                    if action is None:
                        return self.send(200, das.save_job(con, self.body_json(), jid))
                    if action == "note":
                        return self.send(200, das.note(con, jid, self.body_json().get("text", "")))
                    if action == "delete":
                        das.delete_job(con, jid)
                        return self.send(200, {"ok": True})
                    if action == "files" and sub == "delete":
                        fp = das.file_path(jid, job["name"], fstr(qs, "name"))
                        if os.path.isfile(fp):
                            os.remove(fp)
                        return self.send(200, das.list_files(jid, job["name"]))
                    if action == "files":
                        saved = das.save_file(jid, job["name"], fstr(qs, "name"), self.raw_body())
                        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, now(), "file", saved))
                        con.commit()
                        return self.send(200, {"saved": saved, **das.list_files(jid, job["name"])})
            m = re.match(r"^/api/das/contacts(?:/(\d+))?(?:/(\w+))?$", p)
            if m:
                cid, action = (int(m.group(1)) if m.group(1) else None), m.group(2)
                if method == "GET":
                    return self.send(200, {"contacts": das.list_contacts(con)})
                if cid is None and action is None:
                    return self.send(200, das.save_contact(con, self.body_json()))
                if p == "/api/das/contacts/import":
                    return self.send(200, das.import_contacts(con, fstr(qs, "name"), self.raw_body()))
                if action == "delete":
                    das.delete_contact(con, cid)
                    return self.send(200, {"ok": True})
                return self.send(200, das.save_contact(con, self.body_json(), cid))
            if p == "/api/das/presurvey":
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("The pre-survey needs the building's location.")
                return self.send(200, das.presurvey(con, lat, lon, fnum(qs, "radius", 15), fnum(qs, "loss", 15), fnum(qs, "threshold", -95)))
            if p == "/api/das/parse" and method == "POST":  # any tool's results file -> rows + a guess at its columns
                fmt, head, rows = das.read_table(fstr(qs, "name"), self.raw_body())
                return self.send(200, {"format": fmt, "headers": head, "rows": rows[:20000], "total": len(rows), "guess": das.guess_mapping(head)})
            if p == "/api/das/search":  # everything in the DAS tab: jobs (every field), contacts, log, files, research
                return self.send(200, finder.das_search(con, fstr(qs, "q")))
            if p == "/api/das/building":  # the building's outline, footprint and levels from OpenStreetMap
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("Set the building's location first.")
                return self.send(200, das.building_outline(lat, lon))
            if p == "/api/das/terrain" and method == "POST":  # donor paths: agency sites -> the roof
                d = self.body_json()
                out = {}
                for s in d.get("sites", [])[:60]:
                    try:
                        out[s["key"]] = terrain.profile(float(s["lat"]), float(s["lon"]), float(s.get("height_m") or 30), float(d["lat"]),
                                                        float(d["lon"]), float(d.get("roof_m") or 15), float(s.get("freq") or 800))
                        out[s["key"]].pop("points", None)
                    except LookupError as e:
                        out[s["key"]] = {"error": str(e)}
                return self.send(200, {"paths": out, "attribution": terrain.ATTRIBUTION})
            if p == "/api/das/terrain/status":
                return self.send(200, terrain.cache_status())
            if p == "/api/das/terrain/download" and method == "POST":
                got = [terrain.download_area(float(a["lat"]), float(a["lon"]), float(a.get("radius") or 15)) for a in self.body_json().get("areas", [])]
                return self.send(200, {"areas": got, **terrain.cache_status()})
            return self.send(404, {"error": "not found"})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        finally:
            con.close()

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        p = u.path
        try:
            if p.startswith("/api/das/"):
                return self.das_route("GET", p, qs)
            if p in EXTRA_ROUTES:
                return self.extra_route("GET", p, qs)
            if p in ("/", "/index.html"):
                with open(os.path.join(STATIC, "index.html"), "rb") as fh:
                    return self.send(200, fh.read(), "text/html; charset=utf-8")
            if p.startswith("/static/"):
                fp = os.path.normpath(os.path.join(STATIC, p[len("/static/"):]))
                if not fp.startswith(STATIC) or not os.path.isfile(fp):
                    return self.send(404, {"error": "not found"})
                # the app's own files change with every update, so the browser must re-check them (a day-long
                # cache ran stale JavaScript against a newer server); pinned libraries in vendor/ can stay cached
                vendor = p.startswith("/static/vendor/")
                with open(fp, "rb") as fh:
                    return self.send(200, fh.read(), mimetypes.guess_type(fp)[0] or "application/octet-stream",
                                     {"Cache-Control": "max-age=86400" if vendor else "no-cache"})
            m = re.match(r"^/tiles/mb/([a-z0-9-]+)/(\d+)/(\d+)/(\d+)\.(?:png|jpg|jpeg|webp)$", p)  # your MBTiles maps
            if m:
                data = basemaps.tile(m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)))
                return self.send(200, data, tile_type(data), {"Cache-Control": "max-age=86400"}) if data else self.send(404, b"", "image/png")
            m = re.match(r"^/tiles/(?:([a-z-]+)/)?(\d+)/(\d+)/(\d+)\.png$", p)
            if m:
                return self.tile(m.group(1) or "osm", *m.groups()[1:])
            if p == "/api/kit":  # this copy's install-kit version and the newest one (kitupdate.py)
                return self.send(200, kitupdate.status())
            m = re.match(r"^/api/research/(pim|parts|plans|budget)$", p)  # cited field research (static/research): PIM, Parts, DAS Plans, link budget
            if m:
                fp = os.path.join(STATIC, "research", {"pim": "pim.json", "parts": "rf_parts.json", "plans": "plans_materials.json",
                                                       "budget": "link_budget.json"}[m.group(1)])
                if not os.path.isfile(fp):
                    return self.send(200, {"empty": True})
                with open(fp, encoding="utf-8") as fh:
                    return self.send(200, json.load(fh))
            if p == "/api/bdc/at":  # the carriers the FCC Broadband Map shows covering this spot (bdc.py)
                return self.send(200, bdc.at(uls_import.DATA_DIR, fnum(qs, "lat"), fnum(qs, "lon")))
            if p == "/api/bdc/carriers":  # the carriers with coverage in a box, for the carrier heatmap's picker
                return self.send(200, {"carriers": bdc.carriers(uls_import.DATA_DIR, *(fnum(qs, k) for k in ("s", "n", "w", "e")))})
            if p == "/api/me":  # the remote door answers this itself (RemoteH); the data folder lets a launcher know its own copy
                return self.send(200, {"remote": False, "data": uls_import.DATA_DIR})
            if p == "/api/remote":  # who can use RF Recon remotely, and the public link (remote.py); door 0 = this copy has none
                return self.send(200, {"people": remote.users(), "link": remote.link() if REMOTE_PORT else {}, "door": REMOTE_PORT})
            if p == "/api/meta":
                con = db()
                meta = {r["k"]: r["v"] for r in con.execute("SELECT k, v FROM meta")}
                con.close()
                return self.send(200, meta)
            if p == "/api/states":
                con = db()
                rows = [dict(r) for r in con.execute("SELECT state, COUNT(*) n FROM tx WHERE state<>'' GROUP BY state ORDER BY state")]
                con.close()
                return self.send(200, rows)
            if p == "/api/counties":
                con = db()
                rows = [dict(r) for r in con.execute(
                    "SELECT county, COUNT(*) n, AVG(lat) lat, AVG(lon) lon FROM tx WHERE state=? AND county IS NOT NULL "
                    "GROUP BY county ORDER BY county", (fstr(qs, "state").upper(),))]
                con.close()
                return self.send(200, rows)
            if p == "/api/area":
                return self.send(200, query_area(qs))
            if p == "/api/report/signals":
                return self.send(200, signal_review(qs))
            if p == "/api/compare":
                return self.send(200, compare_missions(int(fnum(qs, "a", 0)), int(fnum(qs, "b", 0)), fnum(qs, "delta", 6.0)))
            if p == "/api/geocode":
                return self.send(200, geocode(qs))
            if p == "/api/services":
                return self.send(200, uls_import.SERVICE_NAMES)
            if p == "/api/sigwiki/match":
                cc = cdb()
                try:
                    return self.send(200, {"candidates": artemis.attach(sigwiki.match(cc, fnum(qs, "freq"), fnum(qs, "bw"), fstr(qs, "type") or None,
                                                                                      int(fnum(qs, "limit", 5))))})
                finally:
                    cc.close()
            m = re.match(r"^/api/artemis/media/(\d+)$", p)  # a waterfall picture or audio clip (artemis.py): on this PC only
            if m:
                got = artemis.media_file(m.group(1))
                if not got:
                    return self.send(404, {"error": "Not in the Artemis database on this PC."})
                with open(got[0], "rb") as fh:
                    return self.send(200, fh.read(), got[1], {"Cache-Control": "max-age=86400"})
            if p == "/api/sigwiki/range":
                cc = cdb()
                try:
                    return self.send(200, {"signals": sigwiki.in_range(cc, fnum(qs, "lo", 0), fnum(qs, "hi", 1e6))})
                finally:
                    cc.close()
            if p == "/api/export.csv":
                return self.attach(to_csv(query_area(qs).get("rows", [])), "rf_recon.csv", "text/csv")
            if p == "/api/export.kml":
                res = query_area(qs)
                mid = fnum(qs, "mission")
                return self.attach(features_kml(res.get("rows", []), res.get("center"), res.get("radius"),
                                                int(mid) if mid is not None else None),
                                   "rf_recon.kml", "application/vnd.google-earth.kml+xml")
            if p == "/api/heatmap":
                grid, rgba, vmin, vmax, unit, desc = heatmap(qs)
                png = geo.png_rgba(grid.cols, grid.rows, rgba)
                return self.send(200, {"png": base64.b64encode(png).decode(), "bounds": [[grid.s, grid.w], [grid.n, grid.e]],
                                       "vmin": vmin, "vmax": vmax, "unit": unit, "desc": desc})
            if p == "/api/heatmap.zip":
                data, name = heatmap_bundle(qs)
                return self.attach(data, f"{name}.zip", "application/zip")
            if p == "/api/missions":
                con = db()
                rows = [dict(r) for r in con.execute("SELECT id,name,status,lat,lon,radius_mi,start_date,end_date,operator,updated_at FROM mission ORDER BY id DESC")]
                con.close()
                return self.send(200, {"missions": rows, "active": get_setting("active_mission")})
            m = re.match(r"^/api/missions/(\d+)/(timeline|bearings)$", p)
            if m:
                return self.send(200, (mission_timeline if m.group(2) == "timeline" else mission_bearings)(int(m.group(1))))
            m = re.match(r"^/api/missions/(\d+)/tracks$", p)
            if m:
                con = db()
                tracks = []
                for c in con.execute("SELECT id FROM capture WHERE mission_id=?", (int(m.group(1)),)).fetchall():
                    pts = [[r["lat"], r["lon"]] for r in con.execute(
                        "SELECT lat, lon FROM track_point WHERE capture_id=? ORDER BY ts, rowid", (c["id"],))]
                    if len(pts) > 1:
                        step = max(1, len(pts) // 2000)
                        tracks.append(pts[::step])
                con.close()
                return self.send(200, {"tracks": tracks})
            m = re.match(r"^/api/missions/(\d+)$", p)
            if m:
                con = db()
                mm = mission_row(con, int(m.group(1)))
                if mm:
                    mm["log"] = [dict(r) for r in con.execute("SELECT * FROM mission_log WHERE mission_id=? ORDER BY id DESC LIMIT 300", (mm["id"],))]
                con.close()
                return self.send(200 if mm else 404, mm or {"error": "no such mission"})
            if p == "/api/layers":
                cc = cdb()
                rows = [dict(r) for r in cc.execute("SELECT source, layer, COUNT(*) n, MAX(fetched_at) fetched FROM ext_point GROUP BY source, layer")]
                fetches = [dict(r) for r in cc.execute("SELECT * FROM ext_fetch ORDER BY id DESC LIMIT 20")]
                cc.close()
                return self.send(200, {"layers": rows, "fetches": fetches})
            if p == "/api/settings":
                creds = get_setting("creds", {}) or {}
                return self.send(200, {"creds": {k: ("•••• set" if v else "") for k, v in creds.items()},
                                       "states": get_setting("update.states", ""), "bdc_states": get_setting("bdc.states", "")})
            if p == "/api/update/status":
                UPD.refresh_net_if_stale()  # the page polls this every 15 s
                return self.send(200, UPD.snapshot())
            if p == "/api/fieldpacks":
                return self.send(200, {"folder": fieldpack.PACK_DIR, "phone_url": PHONE_URL,
                                       "packs": fieldpack.list_packs(), "job": FP_JOB})
            if p == "/api/sigid":
                return self.send(200, {"library": {k: {"family": v[0], "bw": v[1], "url": sigid.sigid_url(k), "color": v[3]}
                                                   for k, v in sigid.LIBRARY.items()},
                                       "bandplan": [{"lo": b[0], "hi": b[1], "label": b[2], "types": b[3]} for b in sigid.BAND_PLAN]})
            return self.send(404, {"error": "not found"})
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def tile(self, src, z, x, y):
        """Map tiles, cached locally as you view them (no bulk prefetch, per OSM policy),
        so areas you've looked at keep working offline."""
        url = TILE_SOURCES.get(src)
        if not url:
            return self.send(404, {"error": "unknown tile source"})
        # OSM keeps the original cache layout (data/tiles/z/x/y.png); other sources get their own folder
        fp = os.path.join(TILE_DIR, *([] if src == "osm" else [src]), z, x, f"{y}.png")
        if os.path.exists(fp):
            with open(fp, "rb") as fh:
                data = fh.read()
            return self.send(200, data, tile_type(data), {"Cache-Control": "max-age=604800"})
        try:
            req = urllib.request.Request(tile_url(url, int(z), int(x), int(y)),
                                         headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool; local cache)"})
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
            if tile_type(data) == "application/octet-stream":  # an error page, not an image: don't cache it
                return self.send(404, b"", "image/png")
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "wb") as fh:
                fh.write(data)
            return self.send(200, data, tile_type(data), {"Cache-Control": "max-age=604800"})
        except Exception:
            return self.send(404, b"", "image/png")

    def do_POST(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        p = u.path
        try:
            if p.startswith("/api/das/"):
                return self.das_route("POST", p, qs)
            if p in EXTRA_ROUTES:
                return self.extra_route("POST", p, qs)
            if p == "/api/kit/update":  # a newer install-kit zip: its files over this copy's, then the launcher restarts us
                done = kitupdate.apply(self.raw_body())
                self.send(200, done)
                kitupdate.restart()
                return
            if p == "/api/remote/add":  # a new person (or a new password): shown once, for Cody to pass on
                d = self.body_json()
                return self.send(200, {"name": (d.get("name") or "").strip(), "password": remote.add(d.get("name")), "people": remote.users()})
            if p == "/api/remote/remove":
                remote.remove(self.body_json().get("name"))
                return self.send(200, {"people": remote.users()})
            if p == "/api/remote/link":
                return self.send(200, {"link": remote.set_link(bool(self.body_json().get("on")))})
            if p == "/api/overlay":
                d = self.body_json()
                con = db()
                con.execute(
                    """INSERT INTO overlay(call_sign,freq_mhz,county,state,alpha_tag,description,tone,tag,verified,notes,source,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,'local',?) ON CONFLICT(call_sign,freq_mhz) DO UPDATE SET alpha_tag=excluded.alpha_tag,
                       description=excluded.description, tone=excluded.tone, tag=excluded.tag, verified=excluded.verified,
                       notes=excluded.notes, source='local', updated_at=excluded.updated_at""",
                    (d.get("call_sign", ""), round(float(d["freq_mhz"]), 5), d.get("county"), d.get("state"), d.get("alpha_tag", ""),
                     d.get("description", ""), d.get("tone", ""), d.get("tag", ""), 1 if d.get("verified") else 0, d.get("notes", ""), now()))
                con.commit(); con.close()
                return self.send(200, {"ok": True})
            if p == "/api/overlay/import":
                n = import_overlay_csv(self.raw_body().decode("utf-8", "replace"), fstr(qs, "state"), fstr(qs, "county"))
                return self.send(200, {"ok": True, "imported": n})
            if p == "/api/observation":
                d = self.body_json()
                con = db()
                con.execute("""INSERT INTO observation(mission_id,freq_mhz,call_sign,status,level_dbm,notes,updated_at) VALUES(?,?,?,?,?,?,?)
                               ON CONFLICT(mission_id,freq_mhz,call_sign) DO UPDATE SET status=excluded.status,
                               level_dbm=excluded.level_dbm, notes=excluded.notes, updated_at=excluded.updated_at""",
                            (int(d["mission_id"]), round(float(d["freq_mhz"]), 5), d.get("call_sign", ""), d.get("status", ""),
                             d.get("level_dbm"), d.get("notes", ""), now()))
                con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)",
                            (int(d["mission_id"]), now(), "observation", f"{d['freq_mhz']} MHz {d.get('call_sign','')}: {d.get('status','')} {d.get('level_dbm') or ''}"))
                con.commit(); con.close()
                return self.send(200, {"ok": True})
            if p == "/api/missions":
                return self.send(200, save_mission(self.body_json()))
            m = re.match(r"^/api/missions/(\d+)(/(\w+))?$", p)
            if m:
                mid, action = int(m.group(1)), m.group(3)
                d = self.body_json()
                if action is None:
                    return self.send(200, save_mission(d, mid))
                if action == "note":
                    con = db()
                    con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)", (mid, now(), "note", d.get("text", "")))
                    con.commit(); con.close()
                    return self.send(200, {"ok": True})
                if action == "activate":
                    set_setting("active_mission", mid)
                    return self.send(200, {"ok": True})
                if action == "delete":
                    con = db()
                    for t in ("mission", "mission_log", "observation", "capture_point", "track_point", "capture"):
                        col = "id" if t == "mission" else "mission_id"
                        con.execute(f"DELETE FROM {t} WHERE {col}=?", (mid,))
                    con.commit(); con.close()
                    if get_setting("active_mission") == mid:
                        set_setting("active_mission", None)
                    return self.send(200, {"ok": True})
            if p == "/api/captures/import":
                mid = fnum(qs, "mission")
                fname = fstr(qs, "filename") or "capture.csv"
                data = self.raw_body()
                con = db()
                mm = mission_row(con, int(mid)) if mid is not None else None
                settings = mm["settings"] if mm else dict(DEFAULT_MISSION_SETTINGS)
                track = []
                if fstr(qs, "track_capture"):
                    track = [dict(r) for r in con.execute("SELECT ts, lat, lon, alt FROM track_point WHERE capture_id=?",
                                                          (int(fstr(qs, "track_capture")),))]
                elif mm:  # use every GPS track already in the mission
                    track = [dict(r) for r in con.execute("SELECT ts, lat, lon, alt FROM track_point WHERE mission_id=?", (mm["id"],))]
                fixed = (mm["lat"], mm["lon"]) if (mm and fstr(qs, "fixed") == "1") else None
                fmt, pts, trk = captures.parse_any(fname, data, settings)
                lookup, lcon = uls_lookup_factory()
                summary = captures.store(con, int(mid) if mid is not None else None, fstr(qs, "name") or fname, fmt, pts, trk,
                                         settings, lookup, extra_track=track, fixed_point=fixed)
                lcon.close()
                if mm:
                    con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)",
                                (mm["id"], now(), "capture", f"Imported {fname} ({fmt}): {summary['points']} points, "
                                 f"{summary['track_points']} track points"))
                    con.commit()
                con.close()
                return self.send(200, summary)
            if p == "/api/fieldlog":
                d = self.body_json()
                mid = d.get("mission_id")
                con = db()
                name = "Field log " + time.strftime("%Y-%m-%d")
                r = con.execute("SELECT id FROM capture WHERE mission_id IS ? AND name=?", (mid, name)).fetchone()
                cid = r["id"] if r else con.execute(
                    "INSERT INTO capture(mission_id,name,fmt,imported_at,points,track_points,notes) VALUES(?,?,?,?,0,0,'')",
                    (mid, name, "fieldlog", now())).lastrowid
                lookup, lcon = uls_lookup_factory()
                f = float(d["freq_mhz"]) if d.get("freq_mhz") not in (None, "") else None
                match = lookup(f, d["lat"], d["lon"]) if f and not d.get("type") else None
                c = sigid.classify(d.get("type"), f, d.get("bw_khz"), match)
                lcon.close()
                con.execute("INSERT INTO capture_point(capture_id,mission_id,ts,lat,lon,acc,kind,label,freq_mhz,dbm,bw_khz,sig_type,sig_conf,sig_basis,extra) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (cid, mid, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), d["lat"], d["lon"], d.get("acc"),
                             (d.get("type") or "RF").upper(), d.get("label", ""), f, d.get("dbm"), d.get("bw_khz"),
                             c["sig_type"], c["confidence"], c["basis"],
                             json.dumps({"notes": d.get("notes", ""), **({"bearing": float(d["bearing"]) % 360} if d.get("bearing") not in (None, "") else {})})))
                con.execute("UPDATE capture SET points=points+1 WHERE id=?", (cid,))
                if d.get("lat") is not None:
                    con.execute("INSERT INTO track_point(capture_id,mission_id,ts,lat,lon,alt) VALUES(?,?,?,?,?,?)",
                                (cid, mid, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), d["lat"], d["lon"], None))
                con.commit(); con.close()
                cc = cdb()
                try:
                    cands = sigwiki.match(cc, f, d.get("bw_khz"), c["sig_type"], 3) if f else []
                finally:
                    cc.close()
                return self.send(200, {"ok": True, "classification": c,
                                       "sigwiki": artemis.attach([{k: x[k] for k in ("title", "url", "score", "why")} for x in cands])})
            m = re.match(r"^/api/captures/(\d+)/delete$", p)
            if m:
                cid = int(m.group(1))
                con = db()
                for t, col in (("capture_point", "capture_id"), ("track_point", "capture_id"), ("capture", "id")):
                    con.execute(f"DELETE FROM {t} WHERE {col}=?", (cid,))
                con.commit(); con.close()
                return self.send(200, {"ok": True})
            if p == "/api/crowd/fetch":
                d = self.body_json()
                creds = get_setting("creds", {}) or {}
                cc = connectors.open_db(CROWD_PATH)
                src, la, lo, rad = d["source"], float(d["lat"]), float(d["lon"]), float(d.get("radius", 5))
                if src == "wigle":
                    n = connectors.fetch_wigle(cc, la, lo, rad, creds.get("wigle_name", ""), creds.get("wigle_token", ""),
                                               kinds=tuple(d.get("kinds") or ("network", "bluetooth", "cell")))
                elif src == "opencellid":
                    n = connectors.fetch_opencellid(cc, la, lo, rad, creds.get("opencellid_key", ""))
                elif src == "repeaterbook":
                    n = connectors.fetch_repeaterbook(cc, la, lo, rad, creds.get("repeaterbook_token", ""), d.get("state"))
                elif src in opensources.SOURCES:  # skipped (-1) when this area was fetched recently, unless forced
                    n = opensources.fetch(cc, src, la, lo, rad, force=bool(d.get("force")))
                    if n < 0:
                        cc.close()
                        return self.send(200, {"ok": True, "rows": 0, "skipped": "fetched for this area recently: nothing new to download"})
                else:
                    raise ValueError("unknown source")
                cc.close()
                return self.send(200, {"ok": True, "rows": n})
            if p == "/api/layers/import":
                cc = connectors.open_db(CROWD_PATH)
                n = connectors.import_custom(cc, fstr(qs, "layer") or "My layer", fstr(qs, "filename") or "layer.csv", self.raw_body())
                cc.close()
                return self.send(200, {"ok": True, "rows": n})
            if p == "/api/settings":
                d = self.body_json()
                creds = get_setting("creds", {}) or {}
                for k, v in (d.get("creds") or {}).items():
                    if v == "__clear__":
                        creds.pop(k, None)
                    elif v:
                        creds[k] = v.strip()
                set_setting("creds", creds)
                if "states" in d:
                    set_setting("update.states", d["states"])
                if "bdc_states" in d:  # carrier coverage (bdc.py) loads per state: its own list
                    set_setting("bdc.states", ",".join(s for s in re.split(r"[,\s]+", (d["bdc_states"] or "").upper()) if s in bdc.STATES))
                return self.send(200, {"ok": True})
            if p == "/api/update/config":
                d = self.body_json()
                if "auto" in d:
                    set_setting("update.auto", bool(d["auto"]))
                if "links" in d:  # the connections updates may use: wifi, ethernet, cellular
                    set_setting("update.links", [k for k in updmod.LINKS if k in (d["links"] or [])] or ["wifi", "ethernet"])
                if "wifi_only" in d:
                    set_setting("update.links", ["wifi", "ethernet"] if d["wifi_only"] else list(updmod.LINKS))
                if "sources" in d:
                    cfg = get_setting("update.sources", {}) or {}
                    for sid, c in d["sources"].items():
                        cfg.setdefault(sid, {}).update(c)
                    set_setting("update.sources", cfg)
                if d.get("all") is not None:
                    cfg = get_setting("update.sources", {}) or {}
                    for sid in updmod.SOURCES:
                        cfg.setdefault(sid, {})["enabled"] = bool(d["all"])
                    set_setting("update.sources", cfg)
                return self.send(200, UPD.snapshot())
            if p == "/api/update/run":
                d = self.body_json()
                ids = d.get("ids")
                if d.get("ids") == "enabled":
                    ids = [sid for sid, c in UPD.config().items() if c["enabled"]]
                started = UPD.run_sources(ids or [], force=bool(d.get("force")))
                return self.send(200, {"started": started, **UPD.snapshot()})
            if p == "/api/fieldpack":
                return self.send(200, {"job": start_fieldpack(self.body_json())})
            if p == "/api/net/hint":
                UPD.client_hint = self.body_json()
                if fstr(qs, "check") == "1":
                    UPD.refresh_net()
                elif not UPD.net.get("checked"):
                    threading.Thread(target=UPD.refresh_net, daemon=True).start()
                return self.send(200, UPD.snapshot())
            return self.send(404, {"error": "not found"})
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})


class RemoteH(H):
    """The remote door (remote.py): Tailscale Funnel forwards the public link to this port. Everyone here is signed
    in and can view and search only; the same routes answer, minus anything that writes or stays on Cody's PC."""

    def send(self, code, body, ctype="application/json", extra=None):
        return super().send(code, body, ctype, dict({"X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
                                                     "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"}
                                                    if ctype.startswith(("application/json", "text/html")) else
                                                    {"X-Content-Type-Options": "nosniff"}, **(extra or {})))

    def secure(self):  # the public link is https; a test on this PC is plain http
        return not (self.headers.get("Host") or "").startswith(("127.0.0.1", "localhost"))

    def answer(self, method, handler):
        p = urlparse(self.path).path
        remote.ON.user = None
        if method != "GET" and p != "/remote/login":
            self.raw_body()  # read what was sent even when refusing it: left on a kept-alive connection, it garbles the next request
            if self.headers.get("Content-Length"):
                self.headers.replace_header("Content-Length", "0")
        if p == "/remote/login":
            if method == "POST":
                f = parse_qs(self.raw_body().decode("utf-8", "replace"))
                name, pw = (f.get("name") or [""])[0], (f.get("password") or [""])[0]
                try:
                    tok = remote.check(name, pw)
                except ValueError as e:
                    return self.send(401, remote.login_page(str(e), name), "text/html; charset=utf-8")
                return self.send(303, b"", "text/plain", {"Location": "/", "Set-Cookie": remote.cookie(tok, self.secure())})
            return self.send(200, remote.login_page(), "text/html; charset=utf-8")
        if p == "/remote/logout":
            return self.send(303, b"", "text/plain", {"Location": "/remote/login", "Set-Cookie": remote.cookie("", self.secure(), clear=True)})
        if p.startswith("/static/theme/") or p == "/favicon.ico":
            return handler()
        user = remote.user_of(self.headers.get("Cookie"))
        if not user:
            if method == "GET" and p in ("/", "/index.html"):
                return self.send(303, b"", "text/plain", {"Location": "/remote/login"})
            return self.send(401, {"error": "Signed out: reload the page to sign in again."})
        if p == "/api/me":
            return self.send(200, {"remote": True, "user": user})
        if p in remote.EMPTY:
            return self.send(200, remote.EMPTY[p])
        why = remote.refused(method, p)
        if why:
            return self.send(403, {"error": why})
        remote.ON.user = user
        try:
            return handler()
        finally:
            remote.ON.user = None

    def do_GET(self):
        return self.answer("GET", super().do_GET)

    def do_POST(self):
        return self.answer("POST", super().do_POST)


REMOTE_PORT = 0  # the remote door's port while it is open


def serve_remote(port):
    """The remote door on 127.0.0.1 only: nothing outside this PC reaches it unless Tailscale Funnel forwards to it."""
    global REMOTE_PORT
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", port), RemoteH)
    except OSError as e:
        print(f"Remote access port {port} is busy ({e}); remote access is off this run.")
        return
    REMOTE_PORT = port
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main():
    global UPD
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (other devices on your network)")
    ap.add_argument("--no-auto", action="store_true", help="don't start the background updater")
    ap.add_argument("--remote-port", type=int, default=None, help="the remote door's port (default 8790 for the live copy, off otherwise)")
    a = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):  # Windows consoles and redirects may not be UTF-8
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    init()
    UPD = updmod.Updater(DB_PATH, CROWD_PATH, get_setting, set_setting, active_areas)
    if not a.no_auto:
        UPD.start()
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    rport = a.remote_port if a.remote_port is not None else (remote.PORT if a.port == 8765 else 0)
    if rport:  # the live copy opens the remote door; a test server only when asked (--remote-port)
        serve_remote(rport)
    print(f"RF Recon running at http://localhost:{a.port}  (Ctrl+C to stop)")
    ThreadingHTTPServer((host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
