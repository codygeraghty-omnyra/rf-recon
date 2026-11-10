#!/usr/bin/env python3
"""
DAStastic - local server. Run:  python app.py   then open http://localhost:8765
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
mimetypes.add_type("application/vnd.android.package-archive", ".apk")  # DAStastic for Android (Help › Android app)
mimetypes.add_type("application/manifest+json", ".webmanifest")  # the app manifest (installable on the server)
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as _ThreadingHTTPServer


class ThreadingHTTPServer(_ThreadingHTTPServer):
    """A browser that leaves (a map scrolled on, a tab closed) mid-answer isn't an error: no traceback for it.
    The nightly QA counted 256 a day, all map tiles (11/4)."""
    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse


def disposition(kind, name):
    """A download header safe for any file name: HTTP headers are Latin-1, so a name like "Floor 2 – plan ✓.pdf" sent
    raw broke the answer mid-way (a 200 header, then a 400 written into the same reply; 11/3). An ASCII stand-in for
    old clients, and the real name encoded (RFC 6266)."""
    plain = name.encode("ascii", "replace").decode().replace('"', "'")
    return f"{kind}; filename=\"{plain}\"; filename*=UTF-8''{quote(name)}"
from xml.sax.saxutils import escape

# A stored file sent to open in the browser sits at the app's own address, as whoever opened it. These can't run anything. Anything else a file
# holds (a web page, an SVG, XML, plain text) still opens, walled off from the app: no scripts, no sign-in, nothing fetched from outside.
# PDFs stay out of the wall because Chrome's viewer won't draw inside one.
SAFE_TO_OPEN = ("application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "video/", "audio/")
WALLED_OFF = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"


def opened_safely(ctype, extra):
    """The headers for a reply. Every route's stored file comes through here, so a new route can't forget."""
    x = dict(extra or {})
    if str(x.get("Content-Disposition") or "").lower().startswith("inline"):
        x["X-Content-Type-Options"] = "nosniff"
        if not (ctype or "").lower().startswith(SAFE_TO_OPEN):
            x["Content-Security-Policy"] = WALLED_OFF
    return x


HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ais  # noqa: E402
import artemis  # noqa: E402
import bdc  # noqa: E402
import boosters  # noqa: E402
import fccid  # noqa: E402
import finder  # noqa: E402
import keystore  # noqa: E402
import licence  # noqa: E402
import kitupdate  # noqa: E402
import basemaps  # noqa: E402
import takpush  # noqa: E402
import captures  # noqa: E402
import carriers  # noqa: E402
import cells  # noqa: E402
import coverage  # noqa: E402
import das  # noqa: E402
import dashist  # noqa: E402
import build  # noqa: E402
import connectors  # noqa: E402
import provenance  # noqa: E402
import faa  # noqa: E402
import fieldpack  # noqa: E402
import geo  # noqa: E402
import course  # noqa: E402
import markup  # noqa: E402
import network  # noqa: E402
import serverfiles  # noqa: E402
import notes  # noqa: E402
import opensources  # noqa: E402
import fss  # noqa: E402
import psap  # noqa: E402
import remote  # noqa: E402
import sigid  # noqa: E402
import sigwiki  # noqa: E402
import terrain  # noqa: E402
import uls_import  # noqa: E402
import ulsdaily  # noqa: E402
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
    "auto_refresh_crowd": False, "fixed_sites_only": True,  # "units" left 11/4: no control set it and nothing read it
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


MAIL_EVERY_S = int(os.environ.get("RF_RECON_MAIL_EVERY_S") or 300)


def mail_loop():
    """Each login's tagged replies, read every 5 minutes (dasmail.check); quiet when nobody has connected a mailbox."""
    import dasmail
    while True:
        time.sleep(MAIL_EVERY_S)
        try:
            people = dasmail.logins(uls_import.DATA_DIR)
        except Exception:
            people = []
        for login in people:
            con = db()
            try:
                dasmail.check(con, uls_import.DATA_DIR, login)
            except Exception as e:  # one mailbox failing never stops the rest
                print(f"mail check for {login}: {type(e).__name__}: {str(e)[:200]}", flush=True)
            finally:
                con.close()
        try:  # the replies to what DAStastic sent for people (sesmail.py): quiet until the server's SES settings are in
            import sesmail
            if sesmail.config(uls_import.DATA_DIR) and sesmail.people(uls_import.DATA_DIR):
                con = db()
                try:
                    r = sesmail.check(con, uls_import.DATA_DIR)
                    if r["error"]:
                        print(f"reply bucket: {r['error']}", flush=True)
                finally:
                    con.close()
        except Exception as e:
            print(f"reply bucket: {type(e).__name__}: {str(e)[:200]}", flush=True)


def init():
    remote.setup(uls_import.DATA_DIR)
    if not os.path.exists(DB_PATH):
        print(f"Note: no FCC database yet at {DB_PATH}. The app will start; use Data & updates > Update now,\n"
              f"or run  python uls_import.py  first.")
    con = sqlite3.connect(DB_PATH)
    con.executescript(uls_import.SCHEMA + APP_SCHEMA + captures.SCHEMA + das.SCHEMA + network.SCHEMA + notes.SCHEMA + course.SCHEMA)
    das.migrate(con)  # columns added to the DAS tables after they were first made
    notes.migrate(con)
    captures.migrate(con)
    import towers
    towers.ensure_schema(con)
    try:
        if n := keystore.migrate(con, uls_import.DATA_DIR):
            print(f"Moved {n} saved keys out of the database into {keystore.path(uls_import.DATA_DIR)}", flush=True)
    except (OSError, RuntimeError, sqlite3.Error) as e:  # keys stay where they were; the next start tries again
        print(f"Note: keys not moved out of the database yet ({e})", flush=True)
    con.close()
    cdb().close()
    threading.Thread(target=ensure_places, daemon=True).start()
    threading.Thread(target=ensure_sigwiki, daemon=True).start()
    threading.Thread(target=mail_loop, daemon=True).start()
    import ulscontacts  # licences' own contacts for a database built before they were kept (once, from the saved files)
    threading.Thread(target=ulscontacts.ensure_quiet, args=(DB_PATH, uls_import.DATA_DIR), daemon=True).start()
    if BACKUP_DIR:
        threading.Thread(target=backup_loop, daemon=True).start()
    import snmpwatch  # BDA monitoring: listens only when an admin has switched it on (setting snmp.monitor)
    snmpwatch.boot(DB_PATH, get_setting, set_setting, uls_import.DATA_DIR)


def get_setting(k, default=None):
    if k == "creds":  # keys never touch a database file (keystore.py)
        return keystore.load(uls_import.DATA_DIR) or default
    con = db()
    r = con.execute("SELECT v FROM setting WHERE k=?", (k,)).fetchone()
    con.close()
    return json.loads(r[0]) if r else default


def set_setting(k, v):
    if k == "creds":
        return keystore.save(uls_import.DATA_DIR, v)
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


PROSPECT_SPOTS = 4  # the last places DAS Prospects listed, warmed at the next start
WARM = {"state": "idle"}  # warm_prospects: what it did, for a check


def remember_prospect_spot(lat, lon, radius):
    """Keep the last few places DAS Prospects listed (rounded to about 1 km), newest first."""
    spot = [round(lat, 4), round(lon, 4), min(50.0, max(1.0, float(radius or 10)))]
    try:
        old = get_setting("prospects.recent", []) or []
        new = [spot] + [x for x in old if (round(x[0], 2), round(x[1], 2)) != (round(lat, 2), round(lon, 2))][:PROSPECT_SPOTS - 1]
        if new != old:
            set_setting("prospects.recent", new)
    except (sqlite3.Error, TypeError, ValueError) as e:  # remembering is a nicety: the list itself already went out
        print(f"Note: prospect spot not kept ({e})", flush=True)


def prospect_spots():
    """Where a person's first DAS Prospects list after a start is likely: the last places listed, the most recently
    changed DAS jobs and the active mission areas; six at most, one per ~1 km."""
    spots = [tuple(x) for x in (get_setting("prospects.recent", []) or []) if isinstance(x, list) and len(x) == 3]
    con = db()
    try:
        for r in con.execute("SELECT data FROM das_job ORDER BY updated_at DESC LIMIT 4"):
            try:
                d = json.loads(r["data"] or "{}")
            except ValueError:
                continue
            if d.get("lat") is not None and d.get("lon") is not None:
                spots.append((float(d["lat"]), float(d["lon"]), 10.0))
    except sqlite3.Error:  # no DAS tables yet (a new copy): the other places still count
        pass
    finally:
        con.close()
    spots += [(la, lo, float(r)) for la, lo, r, _st in active_areas()]
    out, seen = [], set()
    for la, lo, r in spots:
        k = (round(la, 2), round(lo, 2))
        if k not in seen:
            seen.add(k)
            out.append((la, lo, r))
    return out[:6]


def warm_prospects(delay_s=1.0):
    """After a start, in the background: the first DAS Prospects list was slow on the server (11/4: 92 s, and RF need
    sat at "0 of 1,000"), because the prospect query and need.py's area load (the agency sites within 15 mi, one SQL
    scan of a whole-US licence table) ran cold. Run both once for the likely places, so a person's first list finds the
    pages read and the area in need.py's cache (need.area_for: a person asking mid-load waits for this load)."""
    import need
    import prospects
    time.sleep(delay_s)
    t0 = time.time()
    WARM.update(state="running", started=now())
    done = 0
    con = db()
    try:
        prospects.counts(uls_import.DATA_DIR)
        for lat, lon, r in prospect_spots():
            prospects.near(uls_import.DATA_DIR, lat, lon, r, None, "", 1000)
            need.area_for(con, lat, lon, max(r, 10.0) + 1.0)  # a mile spare: a pin dropped near the place still falls inside
            done += 1
        WARM.update(state="done", places=done, took_s=round(time.time() - t0, 1))
        print(f"DAS Prospects warmed for {done} place{'s' * (done != 1)} in {time.time() - t0:.1f} s", flush=True)
    except Exception as e:  # noqa: BLE001  a warm-up that fails leaves the first list as slow as before, no worse
        WARM.update(state="error", error=str(e))
        print(f"DAS Prospects warm-up stopped: {e}", flush=True)
    finally:
        con.close()


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


def phone_ready(role):
    """Whether the Phone button shows: the copy's phone is set up and the login is full or admin (None: Cody's PC)."""
    if role not in (None, "full", "admin"):
        return False
    import phone
    return bool(phone.config(uls_import.DATA_DIR))


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


def carrier_of(f):
    """(carrier, the field it was read from) for a row, or None. A filter's convenience: see carriers.py."""
    layer = f.get("layer")
    if layer == "towers":
        name, read = carriers.name_of(f.get("owner")), "tower owner"
    elif layer in ("uls", "uls_hist"):
        name, read = carriers.name_of(f.get("licensee")), "licensee"
    elif layer in ("opencellid", "wigle"):
        ids = cells.parse_id(f.get("ext_id") or "")
        name, read = carriers.name_of(cells.operator(ids[0], ids[1])) if ids else None, "cell ID"
    else:
        return None
    return (name, read) if name else None


def agency_key(r):
    """agencyOf in core.js: one name per licensee, by case and punctuation only. "FAIRFAX, COUNTY OF" and "Fairfax, County
    of" are one agency; merging further would be a guess, and a wrong guess sends a consent letter to the wrong agency."""
    return re.sub(r"[^A-Z0-9]+", " ", (r.get("licensee") or "").upper()).strip() or "No agency"


def row_type(r):
    """typeOf in core.js."""
    return {"towers": "Tower / structure", "psap": "911 call centre", "boosters": "Signal booster (FCC registered)"}.get(r.get("layer")) or r.get("sig_type") or "Unknown"


def class_key(r):
    """classKey in core.js: classGroup for a licence and a tower, the layer for anything else (the page labels those)."""
    layer = r.get("layer")
    if layer == "towers":
        return "Towers"
    if layer not in ("uls", "uls_hist"):
        return layer
    c = r.get("station_class") or ""
    if c in ("FB2", "FB4"):
        return "Repeaters"
    return "Base stations" if c.startswith("FB") else "Fixed / control" if c.startswith("FX") else "Mobiles" if c.startswith("MO") else "Other"


FACET_PARAMS = (("types", row_type), ("bands", lambda r: r.get("band") or "Other"),
                ("cats", lambda r: r.get("category") or "Other"), ("cls", class_key),
                ("carriers", lambda r: r.get("carrier") or "No carrier"), ("agencies", agency_key))


def facet_keep(qs):
    """The Map's filter groups as a test of one row (passes() in core.js). A group with no list doesn't filter."""
    groups = [(read, set(filter(None, fstr(qs, k).split("|")))) for k, read in FACET_PARAMS]
    groups = [(read, vals) for read, vals in groups if vals]
    drop = set(filter(None, fstr(qs, "xagencies").split("|")))  # a licensee list can run to hundreds: the hidden names are sent instead
    return lambda r: all(read(r) in vals for read, vals in groups) and not (drop and agency_key(r) in drop)


def freq_ranges(text):
    """'851-869,146.52-146.53' -> [(851.0, 869.0), (146.52, 146.53)]. What doesn't read as a range is left out."""
    out = []
    for part in (text or "").split(","):
        m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*", part)
        if m:
            out.append(tuple(sorted((float(m.group(1)), float(m.group(2))))))
    return out


def query_area(qs):
    area = area_filter(qs)
    if not area:
        return {"error": "Drop a pin or pick a state/county."}
    layers = set((fstr(qs, "layers") or "uls,broadcast,noaa,faa,towers,captures,wigle,opencellid,repeaterbook,custom").split(","))
    mission = fnum(qs, "mission")
    text = fstr(qs, "q")
    fmin, fmax = fnum(qs, "fmin"), fnum(qs, "fmax")
    franges = freq_ranges(fstr(qs, "franges"))
    if franges and fmin is None and fmax is None:
        fmin, fmax = min(r[0] for r in franges), max(r[1] for r in franges)  # the outer bounds: every source already reads these

    def keep(f):
        """In the area, and on one of the listed ranges when there's a list. An earth station counts by the band it receives."""
        if franges and f.get("freq_mhz") is not None:
            lo, hi = f.get("freq_lo_mhz") or f["freq_mhz"], f.get("freq_hi_mhz") or f["freq_mhz"]
            if not any(a <= hi and b >= lo for a, b in franges):
                return False
        return decorate(f, area)
    hide_mobile = fstr(qs, "hide_mobile") == "1"
    freq_on = fmin is not None or fmax is not None
    keep_nofreq = fstr(qs, "keep_nofreq") == "1"  # a frequency filter can't say a row with no frequency matches: left off, counted
    set_aside = {}
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
            f["tower_reg"] = uls_import.asr_number(f.get("tower_reg"))  # data imported before 11/5 still holds "N/A"
            f["layer"] = "uls" if f.get("status") == "A" else "uls_hist"
            f["fid"] = f"uls:{f['id']}"
            f["label"] = f["licensee"]
            f["sig_type"] = sigid.from_uls_mode(f.get("mode")) or "Unknown"
            if f["layer"] == "uls_hist":
                f["category"] = "History: " + {"E": "Expired", "C": "Cancelled", "T": "Terminated"}.get(f.get("status"), f.get("status") or "Inactive")
            if not keep(f):
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
                    if keep(f):
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
            owner = f.get("owner") or ""
            if filtered and f["reg"] not in regs and not (text and text.lower() in f"{owner} {carriers.name_of(owner) or ''}".lower()):
                continue
            f.update(layer="towers", fid="tower:" + f["reg"], label=f"{f.get('struct_type') or 'Structure'} "
                     f"{f.get('overall_agl_m') or '?'} m · {f.get('owner') or ''}".strip(), category="Tower / structure",
                     sig_type=None, freq_mhz=None)
            if keep(f):
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
            if keep(f):
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
            if keep(f):
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
            if keep(f):
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
        for r in con.execute(f"SELECT p.*, c.name AS capture_name, c.receiver, c.calibrated FROM capture_point p JOIN capture c ON c.id=p.capture_id "
                             f"WHERE {' AND '.join(where)} LIMIT {MAX_ROWS}", args):
            f = dict(r)
            f.update(layer="captures", fid=f"cap:{f['id']}", category="Survey: " + (f.get("sig_type") or "Unknown"),
                     band=uls_import.band_for(f.get("freq_mhz")))
            if not f.get("label"):
                f["label"] = f.get("ident") or ""
            if keep(f):
                out.append(f)
    if "fss" in layers and area["point"] and has_table(con, "fss_earth"):  # protected C-band earth stations (receive only)
        where, args = ["status = 'Active'", area["sql"]], list(area["args"])  # inactive ones lost their protection
        if fmin is not None:
            where.append("freq_hi_mhz >= ?"); args.append(fmin)
        if fmax is not None:
            where.append("freq_lo_mhz <= ?"); args.append(fmax)
        if text:
            where.append("(licensee LIKE ? OR call_sign LIKE ? OR number LIKE ?)"); args += [f"%{text}%"] * 3
        for r in con.execute(f"SELECT * FROM fss_earth WHERE {' AND '.join(where)} LIMIT 2000", args):
            f = fss.feature(r)
            if keep(f):
                out.append(f)
    if "proposed" in layers and area["point"] and has_table(con, "tower_app"):  # proposed towers: FCC applications and FAA studies (towerapps.py)
        import towerapps
        for d in towerapps.proposed(con, area["sql"], area["args"]):
            if d["kind"] == "application":
                label = f"Proposed tower: {d['purpose_text']}, {d['status_text']}"
                det = {"FCC file": d["file_number"], "Registration": d["reg"] or "new", "Applicant": d["applicant"] or "",
                       "Height above ground": f"{d['agl_m']} m" if d["agl_m"] is not None else "", "Structure": d["struct_type"],
                       "Received": d["received"], "FAA study": d["faa_study"], "Where": ", ".join(x for x in (d["city"], d["state"]) if x),
                       "Source": "FCC antenna structure applications (daily file)"}
                f = {"fid": f"proposed:{d['file_number']}", "label": label, "lat": d["lat"], "lon": d["lon"], "city": d["city"], "state": d["state"]}
            else:
                label = f"Proposed structure under FAA study {d['study']}"
                det = {"FAA study": d["study"], "Sponsor": d["sponsor"] or "", "Height above ground": f"{d['agl_m']} m" if d["agl_m"] is not None else "",
                       "Issued": d["issued"], "Determination expires": d["expires"], "Where": ", ".join(x for x in (d["city"], d["state"]) if x),
                       "Source": "FAA determinations in the FCC's daily tower files"}
                f = {"fid": f"faa:{d['study']}", "label": label, "lat": d["lat"], "lon": d["lon"], "city": d["city"], "state": d["state"]}
            f.update(layer="proposed", category="Proposed tower or structure", sig_type=None, freq_mhz=None,
                     details=json.dumps({k: v for k, v in det.items() if v}))
            if keep(f):
                if freq_on and not keep_nofreq:
                    set_aside["proposed"] = set_aside.get("proposed", 0) + 1
                else:
                    out.append(f)
    if "psap" in layers and area["point"] and has_table(con, "psap"):  # 911 call centres, placed at their town's centre
        where, args = [area["sql"]], list(area["args"])
        if text:  # "sheriff" still finds a sheriff's 911 centre
            where.append("(name LIKE ? OR city LIKE ? OR county LIKE ? OR psap_id LIKE ?)"); args += [f"%{text}%"] * 4
        for r in con.execute(f"SELECT * FROM psap WHERE {' AND '.join(where)} LIMIT 2000", args):
            f = dict(r)
            f.update(layer="psap", fid=f"psap:{f['psap_id']}", label=f["name"], category="911 call centre (PSAP)", sig_type=None, freq_mhz=None,
                     details=json.dumps({"PSAP ID": f["psap_id"], "City": f["city"], "County": f["county"], "State": f["state"],
                                         "Position": f"approximate: {f['located']} (the registry has no addresses)",
                                         **({"FCC note": f["change"]} if "Orphaned" in (f.get("change") or "") or "Secondary" in (f.get("change") or "") else {}),
                                         "Registry": f"FCC 911 Master PSAP Registry as of {psap.SOURCE_DATE}"}))
            if keep(f):
                if freq_on and not keep_nofreq:
                    set_aside["psap"] = set_aside.get("psap", 0) + 1
                else:
                    out.append(f)
    if "boosters" in layers and area["point"] and has_table(con, "booster"):  # Class B boosters registered with the FCC: business fields only (boosters.py)
        where, args = [area["sql"]], list(area["args"])
        if fmin is not None:
            where.append("(freq_hi >= ? OR freq_hi IS NULL)"); args.append(fmin)
        if fmax is not None:
            where.append("(freq_lo <= ? OR freq_lo IS NULL)"); args.append(fmax)
        if text:
            where.append("(company LIKE ? OR callsigns LIKE ? OR booster_id LIKE ? OR address LIKE ? OR city LIKE ? OR location LIKE ?)"); args += [f"%{text}%"] * 6
        for r in con.execute(f"SELECT {', '.join(boosters.COLS)} FROM booster WHERE {' AND '.join(where)} LIMIT 3000", args):
            f = boosters.feature(r)
            if keep(f):
                if freq_on and f["freq_lo_mhz"] is None and not keep_nofreq:  # no frequency the FCC's text gives: left off, counted
                    set_aside["boosters"] = set_aside.get("boosters", 0) + 1
                else:
                    out.append(f)
    con.close()

    crowd = [l for l in ("wigle", "opencellid", "repeaterbook", "custom") + tuple(opensources.SOURCES) if l in layers and build.allowed(l)]
    if crowd and area["point"]:
        cc = cdb()

        def crowd_load(clause, clause_args):
            where, args = [area["sql"], f"source IN ({','.join('?' * len(crowd))})"], list(area["args"]) + crowd
            if clause:
                where.append(clause); args += clause_args
            found = []
            for r in cc.execute(f"SELECT * FROM ext_point WHERE {' AND '.join(where)} LIMIT {MAX_ROWS}", args):
                f = dict(r)
                f.update(layer=f["source"], fid=f"ext:{f['id']}", category=f["layer"],
                         band=uls_import.band_for(f.get("freq_mhz")))
                if text:  # in Python: a cell's carrier is only in its ID
                    c = carrier_of(f)
                    if text.lower() not in " ".join(str(f.get(k) or "") for k in ("label", "ext_id", "mode", "details")).lower() + " " + (c[0].lower() if c else ""):
                        continue
                if keep(f):
                    found.append(f)
            return found
        ranges = [("freq_mhz >= ?", fmin), ("freq_mhz <= ?", fmax)]
        ranges = [(c, v) for c, v in ranges if v is not None]
        crowd_rows = crowd_load(" AND ".join(c for c, _ in ranges), [v for _, v in ranges])
        if freq_on:
            blank = crowd_load("freq_mhz IS NULL", [])
            if keep_nofreq:
                crowd_rows += blank
            else:
                for f in opensources.merge(blank):
                    set_aside[f["layer"]] = set_aside.get(f["layer"], 0) + 1
        cc.close()
        out.extend(opensources.merge(crowd_rows))  # the same emitter from several sources shows once, with every source's data

    if area["point"]:
        out.sort(key=lambda f: (f.get("dist_mi", 1e9), f.get("freq_mhz") or 0))
    for f in out:
        if f.get("layer") in ("uls", "uls_hist") and (f.get("sig_type") or "Unknown") == "Unknown":
            f["sig_type"] = sigid.service_kind(f.get("service")) or "Unknown"
        c = carrier_of(f)
        if c:
            f["carrier"], f["carrier_from"] = c
            if f["layer"] == "towers":  # the owner on the record: other carriers may rent space on it
                f["label"] = f"{c[0]}-registered structure · {f.get('label') or ''}"
    return {"rows": out, "truncated": truncated, "center": list(area["point"]) if area["point"] else None,
            "radius": area["radius"], "set_aside": set_aside}


# ---------------------------------------------------------------- field packs for the phone app

PHONE_URL = "https://codygeraghty-omnyra.github.io/rf-recon/"
ANDROID_VERSION = "1.2"  # DAStastic for Android (android/, built outside this repo): the one version not readable from a file here
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
    out = os.path.join(fieldpack.PACK_DIR, f"DAStastic pack - {fieldpack.safe_name(name)}.rfpack")
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
                "/api/cells", "/api/cells/import", "/api/cells/fetch", "/api/spectrum", "/api/basemaps", "/api/basemaps/import", "/api/basemaps/delete",
                "/api/tak/push", "/api/tak/settings", "/api/mwlinks", "/api/ais", "/api/fccid", "/api/fccid/grantees", "/api/fccid/grants",
                "/api/fccid/boosters", "/api/fccid/parts", "/api/find", "/api/radioid", "/api/uls/pending"}


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

BACKUP_DIR = os.environ.get("RF_RECON_BACKUP")  # the launcher points this at DAStastic\backups in Drive (shared)
USER_TABLES = ("mission", "mission_log", "observation", "capture", "capture_point", "track_point", "overlay", "setting", "note") + das.TABLES + network.TABLES + course.TABLES + markup.TABLES
NOTES_DIR = notes.notes_dir(uls_import.DATA_DIR)  # the notes' own files (the launcher: DAStastic\notes in Drive)


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
    After that the Data & updates source keeps it current. The sold build leaves the wiki out (build.py), so it never
    fetches there."""
    con = connectors.open_db(CROWD_PATH)
    try:
        con.executescript(sigwiki.SCHEMA)
        if build.allowed("sigwiki") and not con.execute("SELECT 1 FROM sigwiki LIMIT 1").fetchone():
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


US_STATE_ABBR = {n.lower(): a for a, n in (
    ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"), ("CA", "California"), ("CO", "Colorado"),
    ("CT", "Connecticut"), ("DE", "Delaware"), ("DC", "District of Columbia"), ("FL", "Florida"), ("GA", "Georgia"),
    ("HI", "Hawaii"), ("ID", "Idaho"), ("IL", "Illinois"), ("IN", "Indiana"), ("IA", "Iowa"), ("KS", "Kansas"),
    ("KY", "Kentucky"), ("LA", "Louisiana"), ("ME", "Maine"), ("MD", "Maryland"), ("MA", "Massachusetts"),
    ("MI", "Michigan"), ("MN", "Minnesota"), ("MS", "Mississippi"), ("MO", "Missouri"), ("MT", "Montana"),
    ("NE", "Nebraska"), ("NV", "Nevada"), ("NH", "New Hampshire"), ("NJ", "New Jersey"), ("NM", "New Mexico"),
    ("NY", "New York"), ("NC", "North Carolina"), ("ND", "North Dakota"), ("OH", "Ohio"), ("OK", "Oklahoma"),
    ("OR", "Oregon"), ("PA", "Pennsylvania"), ("RI", "Rhode Island"), ("SC", "South Carolina"), ("SD", "South Dakota"),
    ("TN", "Tennessee"), ("TX", "Texas"), ("UT", "Utah"), ("VT", "Vermont"), ("VA", "Virginia"), ("WA", "Washington"),
    ("WV", "West Virginia"), ("WI", "Wisconsin"), ("WY", "Wyoming"), ("PR", "Puerto Rico"), ("GU", "Guam"),
    ("VI", "United States Virgin Islands"), ("AS", "American Samoa"), ("MP", "Northern Mariana Islands"))}


PHOTON_GRACE_S = 0.1  # a Census match is the address itself: Photon gets this much longer, not its full wait


def photon_list(q, qs):
    """Photon's answers for a search (OpenStreetMap, free), US only. Raises when it can't be reached."""
    p = {"q": q, "limit": 7, "lang": "en"}
    if fnum(qs, "lat") is not None and fnum(qs, "lon") is not None:
        p.update(lat=fnum(qs, "lat"), lon=fnum(qs, "lon"))  # bias toward where you're working
    req = urllib.request.Request("https://photon.komoot.io/api/?" + urlencode(p), headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"})
    with urllib.request.urlopen(req, timeout=4) as r:
        feats = json.loads(r.read()).get("features", [])
    out = []
    for f in feats:
        pr, (lon, lat) = f.get("properties", {}), f["geometry"]["coordinates"]
        if pr.get("countrycode") != "US":
            continue
        street = " ".join(x for x in (pr.get("housenumber"), pr.get("street")) if x)
        head = pr.get("name") or street or pr.get("city") or ""
        tail = ", ".join(x for x in (street if street != head else None, pr.get("city"), pr.get("state")) if x)
        # the whole address as it's written on mail: "1200 N Main St, Arlington, VA 22201" (address boxes take this)
        st = US_STATE_ABBR.get((pr.get("state") or "").lower(), pr.get("state") or "")
        full = ", ".join(x for x in (street or pr.get("name"), pr.get("city") or pr.get("district") or pr.get("county"),
                                     " ".join(y for y in (st, pr.get("postcode")) if y)) if x)
        out.append({"label": head + (f", {tail}" if tail else ""), "sub": (pr.get("osm_value") or pr.get("type") or "").replace("_", " ").title(),
                    "full": full, "lat": round(lat, 6), "lon": round(lon, 6), "kind": "address", "source": "photon",
                    "number": pr.get("housenumber") or ""})
    return out


NEAR_STATES = 6  # a house number and street with no state: these are asked at once, and every state on a pause (wide=1, ahj.census_batch)
# the middle of each state, for "which are nearest": a fixed list, because a copy's town index only holds the states it has loaded
STATE_MIDS = {"AL": (32.8, -86.8), "AK": (64.0, -152.0), "AZ": (34.3, -111.7), "AR": (34.8, -92.4), "CA": (37.2, -119.5), "CO": (39.0, -105.5), "CT": (41.6, -72.7), "DE": (39.0, -75.5),
              "DC": (38.9, -77.0), "FL": (28.6, -82.4), "GA": (32.7, -83.4), "HI": (20.8, -156.3), "ID": (44.4, -114.6), "IL": (40.0, -89.2), "IN": (39.9, -86.3), "IA": (42.0, -93.5),
              "KS": (38.5, -98.4), "KY": (37.5, -85.3), "LA": (31.0, -92.0), "ME": (45.3, -69.2), "MD": (39.0, -76.8), "MA": (42.3, -71.8), "MI": (44.3, -85.4), "MN": (46.3, -94.3),
              "MS": (32.7, -89.7), "MO": (38.4, -92.5), "MT": (47.0, -109.6), "NE": (41.5, -99.8), "NV": (39.3, -116.6), "NH": (43.7, -71.6), "NJ": (40.2, -74.7), "NM": (34.4, -106.1),
              "NY": (42.9, -75.5), "NC": (35.5, -79.4), "ND": (47.4, -100.5), "OH": (40.3, -82.8), "OK": (35.6, -97.5), "OR": (43.9, -120.6), "PA": (40.9, -77.8), "RI": (41.7, -71.6),
              "SC": (33.9, -80.9), "SD": (44.4, -100.2), "TN": (35.9, -86.4), "TX": (31.5, -99.3), "UT": (39.3, -111.7), "VT": (44.1, -72.7), "VA": (37.5, -78.9), "WA": (47.4, -120.5),
              "WV": (38.6, -80.6), "WI": (44.6, -90.0), "WY": (43.0, -107.6)}


def _here(qs):
    la, lo = fnum(qs, "lat"), fnum(qs, "lon")
    return None if la is None or lo is None else (la, lo)


def states_near(qs):
    """The states closest to where this person is working, nearest first."""
    at = _here(qs)
    return sorted(STATE_MIDS, key=lambda s: geo.haversine_km(at[0], at[1], *STATE_MIDS[s]))[:NEAR_STATES] if at else []


def nearest_first(rows, qs):
    at = _here(qs)
    return sorted(rows, key=lambda x: geo.haversine_km(at[0], at[1], x["lat"], x["lon"])) if at else rows


def census_near(q, qs):
    """What the Census makes of a house number and street, with or without the rest. It takes "90 Main, VA", shrugs off a misspelled street, and
    answers in 0.3 s, so the line as typed goes with one copy for each state nearby. What fits the words as typed comes first. None: not reached."""
    import ahj
    from concurrent.futures import ThreadPoolExecutor, wait
    near = [] if re.search(r"\b\d{5}\b", q) else states_near(qs)  # a ZIP already says where
    ex = ThreadPoolExecutor(1 + len(near))
    typed, others = ex.submit(ahj.census_address, q), [ex.submit(ahj.census_address, f"{q}, {s}") for s in near]
    try:
        now = lambda: [f.result() if f.done() and not f.exception() else None for f in [typed, *others]]
        wait([typed, *others], timeout=.6)
        if not any(now()):  # nothing yet: the slower ones get a little longer. Something in hand shows now
            wait([typed, *others], timeout=.8)
        got = now()
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    if all(x is None for x in got):
        return None
    out, seen = [], set()
    for x in (got[0] or []) + nearest_first([x for rows in got[1:] for x in rows or []], qs):
        if x["full"] not in seen:
            seen.add(x["full"])
            out.append(x)
    return out


def census_wide(q, qs):
    """Every state, on one request: the pause after nothing nearby fits. None when it couldn't ask."""
    import ahj
    import towers
    if not re.match(r"(\d+)[a-z]?\s+[a-z0-9]", q, re.I) or re.search(r"\b\d{5}\b", q) or sys.platform == "emscripten":
        return []
    rows = ahj.census_batch(q, sorted(towers.STATES))
    if rows is None:
        return None
    seen, out = set(), []
    for x in nearest_first(rows, qs):
        if x["full"] not in seen:
            seen.add(x["full"])
            out.append(x)
    return out


def address_lookup(q, qs):
    """Addresses for a search, or None when nothing could be reached. A street address asks the Census Bureau's geocoder (ahj.py) and
    Photon together: Photon took 1.4 to 3 s from the server and the Census 0.3 s, and asking one after the other left the box blank for
    3 s while typing stopped (11/6). A Census match comes back at once. The typed house number wins: for "3440 Beltline Blvd" Photon
    gave bus stops on 36th Street first (11/5)."""
    m = re.match(r"(\d+)[a-z]?\s+[a-z0-9]", q, re.I)
    if not m or len(q) < 6 or sys.platform == "emscripten":  # the web version has no threads, and its address search is web/shim.js
        try:
            return photon_list(q, qs)
        except Exception:
            return None  # offline or the service is down: the local half still answers
    from concurrent.futures import ThreadPoolExecutor
    ex = ThreadPoolExecutor(2)
    ph, ce = ex.submit(photon_list, q, qs), ex.submit(census_near, q, qs)
    try:
        census = photon = None
        try:
            census = ce.result(timeout=1.5)
        except Exception:
            pass
        try:
            photon = ph.result(timeout=PHOTON_GRACE_S if census else 4.5)
        except Exception:
            pass  # slow, offline or down
        if census is None and ce.done() and not ce.exception():
            census = ce.result()
        if census is None and not photon:  # neither has answered yet: the Census has the rest of its own wait
            try:
                census = ce.result(timeout=2.5)
            except Exception:
                pass
        if census is None:
            remote = photon
        else:  # both: a house in Irvine that Photon has with the typed number mustn't hide the one the Census found next door (11/6)
            door = lambda x: any(abs(x["lat"] - c["lat"]) < .002 and abs(x["lon"] - c["lon"]) < .002 for c in census)  # the same house, spelled two ways, is one row
            remote = census + [x for x in photon or [] if not (x.get("number") and door(x))]
        if remote:
            remote = sorted(remote, key=lambda x: x.get("source") != "census" and x.get("number") != m.group(1))
        return remote
    finally:
        ex.shutdown(wait=False, cancel_futures=True)  # the slower one's answer isn't waited for


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
    wide = fstr(qs, "wide") == "1"
    key = (q.lower(), fstr(qs, "lat")[:5], fstr(qs, "lon")[:6], wide)
    remote = GEO_CACHE.get(key)
    if remote is None:
        remote = census_wide(q, qs) if wide else address_lookup(q, qs)
        if remote is not None:
            if len(GEO_CACHE) > 500:
                GEO_CACHE.clear()
            GEO_CACHE[key] = remote
    first = (remote or []) if q[:1].isdigit() else []  # a house number means an address: put streets first
    rest = [x for x in (remote or []) if x not in first]
    return {"results": (first + local + rest)[:10], "online": remote is not None}


# ---------------------------------------------------------------- area report: signals not on the FCC list

NON_FCC_LAYERS = ("captures", "wigle", "opencellid", "repeaterbook", "custom")


def signal_review(qs):
    """Every survey and crowd point in the area, explained or flagged: an FCC licence on that frequency within
    40 mi, an allocation that allows it without a site licence (Part 15, Part 95, amateur, cellular...), or
    nothing at all: 'Unlisted', the ones worth a second look. Each row carries its claim grade, source letter,
    single-source badge and one-line why (provenance.py). With captures in the area, licences our captures should
    have heard and didn't come back as not_heard."""
    q = dict(qs)
    want = [l for l in (fstr(qs, "layers") or ",".join(NON_FCC_LAYERS)).split(",") if l in NON_FCC_LAYERS]
    q["layers"] = [",".join(want) or "none"]
    rows = query_area(q).get("rows", [])
    track = track_record()
    lookup, lcon = uls_lookup_factory()
    fcc_as_of = (lcon.execute("SELECT v FROM meta WHERE k='built_at'").fetchone() or [None])[0]
    scon = cdb()
    out, counts = [], {}
    try:
        for r in rows:
            f, t = r.get("freq_mhz"), r.get("sig_type")
            m = None
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
                                          "sig_type", "label", "ident", "ts", "capture_name", "kind", "receiver", "calibrated",
                                          "also_in", "last_seen")}
            row = dict(keep, authority=cat, authority_note=note)
            row.update(provenance.judge(dict(r, bearing=point_bearing(r.get("extra"))) if r.get("layer") == "captures" else r,
                                        lic=m, fcc_as_of=fcc_as_of, track=track))
            if cat == "Unlisted" and not getattr(remote.ON, "user", None):  # what it could be, from the Signal Identification Wiki (the catalog stays on this PC)
                row["sigwiki"] = [{k: c[k] for k in ("title", "url", "score", "why")}
                                  for c in sigwiki.match(scon, f, r.get("bw_khz"), t, 3)]
            out.append(row)
    finally:
        lcon.close()
        scon.close()
    out.sort(key=lambda x: (x["authority"] != "Unlisted", x.get("dist_mi") or 0))
    caps = [r for r in rows if r.get("layer") == "captures"]
    return {"counts": counts, "rows": out, "layers": want, "rules": provenance.RULES, "fcc_as_of": fcc_as_of,
            "not_heard": licensed_not_heard(qs, caps), "coverage": coverage_conflicts(caps), "track": track}


def cell_of(ident):
    """(carrier key, operator, cell key) from a decoded cell ID, or None."""
    import cells
    p = cells.parse_id(ident)
    if not p:
        return None
    op = cells.operator(p[0], p[1])
    return provenance.carrier_key(op), op, f"cell:{p[0]}-{int(p[1])}-{p[3]}"


def coverage_conflicts(caps, most_spots=40):
    """Carrier coverage claimed (the FCC Broadband Map, bdc.py) against what captures heard, at each place where a
    capture decoded cell IDs (pooled to about 300 m). Claimed, not heard: the map says a carrier covers it, the capture
    decoded other carriers' cells there (so it was listening) and none of that carrier's. Weaker than claimed: heard,
    but more than 10 dB under the map's modelled signal. The map is modelled outdoors; indoors both are often expected."""
    spots = {}
    for c in caps:
        got = cell_of(c.get("ident")) if c.get("lat") is not None else None
        if not got:
            continue
        sp = spots.setdefault((round(c["lat"] / 0.003) * 0.003, round(c["lon"] / 0.003) * 0.003), {"heard": {}, "n": 0})
        sp["n"] += 1
        key, op, _cell = got
        # the strongest level heard; a carrier first heard with no level (None) takes the first one it gets
        if c.get("dbm") is not None and (key not in sp["heard"] or sp["heard"][key][1] is None or c["dbm"] > sp["heard"][key][1]):
            sp["heard"][key] = (op, c["dbm"])
        else:
            sp["heard"].setdefault(key, (op, None))
    out = []
    for (la, lo), sp in sorted(spots.items(), key=lambda kv: -kv[1]["n"])[:most_spots]:
        claimed = bdc.at(uls_import.DATA_DIR, la, lo)
        if not claimed.get("loaded"):
            return []  # no carrier coverage on this copy: nothing to compare against
        for c in claimed["carriers"]:
            key = provenance.carrier_key(c["brand"])
            if c["tech"] not in ("4G LTE", "5G-NR") or not key:
                continue
            base = {"lat": round(la, 5), "lon": round(lo, 5), "carrier": c["brand"], "tech": c["tech"], "claimed_dbm": c["signal"],
                    "readings": sp["n"], "as_of": claimed.get("as_of")}
            if key not in sp["heard"]:
                if sp["heard"]:  # it was listening: other carriers' cells were decoded here
                    out.append(dict(base, flag="Claimed, not heard",
                                    why=f"The FCC map (release {claimed.get('as_of')}) says {c['brand']} {c['tech']} covers this spot; "
                                        f"{sp['n']} capture reading{'s' if sp['n'] != 1 else ''} here decoded "
                                        f"{', '.join(v[0] for v in sp['heard'].values())} but no {c['brand']} cell. "
                                        "The map is modelled outdoors: indoors this is often expected."))
            else:
                got = sp["heard"][key][1]
                if got is not None and c["signal"] is not None and got < c["signal"] - 10:
                    out.append(dict(base, flag="Weaker than claimed", heard_dbm=got,
                                    why=f"Heard at {got:.0f} dBm, more than 10 dB under the map's {c['signal']} dBm for "
                                        f"{c['brand']} {c['tech']}. The map is modelled outdoors: indoors this is often expected."))
    return out


TRACK = {}  # personal_now() -> {"key", "value"}: one cache for the owner, one for team logins


def track_record():
    """How often each source's "on the air" claims held up against our own captures, pooled across every mission
    (research rule 6). FCC licences: heard (a capture on the licensed frequency near the site) vs licensed, not heard
    inside a swept band. Crowd sources: a crowd cell or radio our captures also decoded vs one of a kind our captures
    decode, sitting near where we listened (300 m for cells, 100 m for Wi-Fi and Bluetooth), that they didn't.
    Worked out from the raw rows when they change, and cached."""
    con = db()
    try:
        key = con.execute("SELECT COUNT(*), MAX(id) FROM capture_point").fetchone()
        key = (tuple(key), tuple(tuple(r) for r in con.execute(  # the weekly rebuild, and each day's changes (ulsdaily.py)
            "SELECT k, v FROM meta WHERE k IN ('built_at', 'uls_daily_at') ORDER BY k")))
        missions = [dict(r) for r in con.execute("SELECT id, lat, lon, radius_mi FROM mission WHERE lat IS NOT NULL")]
        caps_by = {m["id"]: [dict(r, layer="captures") for r in con.execute("SELECT * FROM capture_point WHERE mission_id=?", (m["id"],))]
                   for m in missions}
    finally:
        con.close()
    cc = cdb()
    try:
        key = key + (cc.execute("SELECT COUNT(*), MAX(id) FROM ext_point").fetchone(),)
        slot = TRACK.setdefault(build.personal_now(), {"key": None, "value": {}})  # the owner and team logins count different sources
        if slot["key"] == key:
            return slot["value"]
        tally = {}

        def add(src, ok):
            t = tally.setdefault(src, [0, 0])
            t[0 if ok else 1] += 1
        lookup, lcon = uls_lookup_factory()
        try:
            for m in missions:
                caps = caps_by[m["id"]]
                if not caps:
                    continue
                heard = {(x["call_sign"], round(x["freq_mhz"], 5)) for x in
                         (lookup(c["freq_mhz"], c["lat"], c["lon"]) for c in caps if c.get("freq_mhz") and c.get("lat") is not None) if x}
                for _ in heard:
                    add("uls", True)
                qs = {"lat": [str(m["lat"])], "lon": [str(m["lon"])], "radius": [str(m["radius_mi"] or 5)]}
                for _ in licensed_not_heard(qs, caps, most=100000):
                    add("uls", False)
                ids, spots = set(), {"cell": [], "mac": []}
                for c in caps:
                    got = cell_of(c.get("ident"))
                    mac = re.fullmatch(r"(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}", str(c.get("ident") or "").lower())
                    if got:
                        ids.add(got[2])
                        spots["cell"].append((c["lat"], c["lon"]))
                    elif mac:
                        ids.add("mac:" + mac.group(0).replace("-", ":"))
                        spots["mac"].append((c["lat"], c["lon"]))
                s_, n_, w_, e_ = geo.bbox(m["lat"], m["lon"], m["radius_mi"] or 5)
                for r in cc.execute("SELECT * FROM ext_point WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s_, n_, w_, e_)):
                    r = dict(r)
                    ident = opensources.identity(r)
                    fam = "cell" if ident and ident.startswith("cell:") else "mac" if ident and ident.startswith("mac:") else None
                    if not fam or not build.allowed(r["source"]):
                        continue
                    if ident in ids:
                        add(r["source"], True)
                        continue
                    reach = 0.3 if fam == "cell" else 0.1
                    if any(a is not None and geo.haversine_km(a, o, r["lat"], r["lon"]) <= reach for a, o in spots[fam][:2000]):
                        add(r["source"], False)
        finally:
            lcon.close()
        value = {src: {"confirmed": ok, "contradicted": bad, "grade": provenance.earned_grade(ok, bad),
                       "proposed": provenance.grade(src, "on_air")} for src, (ok, bad) in tally.items()}
        slot.update(key=key, value=value)
        return value
    finally:
        cc.close()


def licensed_not_heard(qs, caps, most=200):
    """FCC licences in the area that our captures should have heard and didn't (provenance.not_heard): fixed sites,
    predicted at the nearest place we listened (capture positions pooled to about 1 km), loud enough (free space
    -80 dBm or more) that 30 dB of real-world loss still leaves them above a field receiver's floor."""
    if not caps:
        return []
    q = dict(qs)
    q["layers"] = ["uls"]
    lic = [r for r in query_area(q).get("rows", []) if not r.get("is_mobile") and r.get("lat") is not None and r.get("freq_mhz")]
    spots = {(round(c["lat"], 2), round(c["lon"], 2)) for c in caps if c.get("lat") is not None}
    seen, cand = set(), []
    for r in lic:
        k = (r["call_sign"], round(r["freq_mhz"], 5))
        if k in seen:
            continue
        seen.add(k)
        d = min(geo.haversine_km(a, o, r["lat"], r["lon"]) for a, o in spots) if spots else None
        p = geo.fspl_rx_dbm(r.get("erp_w") or r.get("power_out_w"), d, r["freq_mhz"])
        if p is not None:
            cand.append({"call_sign": r["call_sign"], "licensee": r.get("licensee"), "freq_mhz": r["freq_mhz"],
                         "est_rx_dbm": round(p, 1), "dist_mi": round(d / geo.MI_KM, 1), "sig_type": r.get("sig_type")})
    got = provenance.not_heard(cand, caps, floor_dbm=-80)
    got.sort(key=lambda x: -x["est_rx_dbm"])
    return got[:most]


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

def mission_hunt(mid, freq, tol_khz=12.5, here_lat=None, here_lon=None):
    """Find a signal: a mission's readings on one frequency (within tol_khz; any frequency when none is given), where
    the signal probably is from their levels (geo.level_fix) and their bearings (geo.bearing_fix), one best guess
    from both, and, when the person's position is given, which way and how far it is from them."""
    con = db()
    try:
        rows = con.execute("SELECT p.ts, p.lat, p.lon, p.freq_mhz, p.dbm, p.extra, c.fmt FROM capture_point p LEFT JOIN capture c ON c.id = p.capture_id "
                           "WHERE p.mission_id=? AND p.lat IS NOT NULL"
                           + (" AND p.freq_mhz BETWEEN ? AND ?" if freq else "") + " ORDER BY p.ts DESC LIMIT 400",
                           (mid,) + ((freq - tol_khz / 1000, freq + tol_khz / 1000) if freq else ())).fetchall()
    finally:
        con.close()
    # stops (field log readings) and imported readings alike; a sweep's levels are relative dB, not dBm, so they place
    # a reading but never weigh in the level estimate
    pts = [{"ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "freq_mhz": r["freq_mhz"], "dbm": None if r["fmt"] == "sweep" else r["dbm"],
            "bearing": point_bearing(r["extra"]), "stop": r["fmt"] == "fieldlog"} for r in rows]
    lv = [p for p in pts if p["dbm"] is not None][:120]  # the latest 120 levels keep the estimate quick
    level = geo.level_fix([(p["lat"], p["lon"], p["dbm"]) for p in lv])
    bearing = geo.bearing_fix([(p["lat"], p["lon"], p["bearing"]) for p in pts if p["bearing"] is not None])
    best = geo.combine_fixes(level, bearing)
    out = {"readings": pts, "level": level, "bearing": bearing, "best": best, "imported": sum(1 for p in pts if not p["stop"])}
    if best and here_lat is not None and here_lon is not None:
        out["from_you"] = {"m": round(1000 * geo.haversine_km(here_lat, here_lon, best["lat"], best["lon"])),
                            "deg": round(geo.bearing_deg(here_lat, here_lon, best["lat"], best["lon"])),
                            "compass": geo.compass(geo.bearing_deg(here_lat, here_lon, best["lat"], best["lon"]))}
    out["count"] = geo.stop_counter(len(pts), any(p["bearing"] is not None for p in pts))
    if geo.want_next_stop(len(pts), best, bearing is not None):  # where to stand next, from you (or the latest stop)
        frm = (here_lat, here_lon) if here_lat is not None and here_lon is not None else (pts[0]["lat"], pts[0]["lon"])
        out["next"] = geo.next_stop([(p["lat"], p["lon"], p["dbm"], p["bearing"]) for p in pts[:120]], (best["lat"], best["lon"]), frm)
    return out


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
    t0 = time.perf_counter()
    timing = {}  # ms per step, sent with the map: the server took 6.2 s for Wilmington 5 mi terrain UHF (QA 11/6); measure before changing
    res = query_area(qs) if lat is None or kind != "carrier" else {"rows": []}  # carrier coverage doesn't use the area's rows
    timing["query"] = round((time.perf_counter() - t0) * 1000)
    if lat is None:
        lat, lon, radius = heat_extent(res["rows"])
    size = int(fnum(qs, "size", 200 if kind != "terrain" else 160))
    size = max(60, min(size, 600 if kind != "terrain" else 220))  # terrain is slower per cell
    grid = geo.make_grid(lat, lon, radius, size)
    rows = res["rows"]
    chosen = facet_keep(qs)
    ident = fstr(qs, "ident")
    files = set(filter(None, fstr(qs, "files").split("|")))  # survey files: "cap:<capture id>" or "<layer>:<layer name>"
    fq, ftol = fnum(qs, "freq"), fnum(qs, "ftol", 0.0125)

    def keep(r):
        if files and heat_file_key(r) not in files:
            return False
        if fq is not None and (r.get("freq_mhz") is None or abs(r["freq_mhz"] - fq) > ftol):
            return False
        if not chosen(r):
            return False
        if ident and ident.lower() not in (f"{r.get('ident') or ''} {r.get('ext_id') or ''} {r.get('label') or ''}").lower():
            return False
        return True
    rows = [r for r in rows if keep(r)]
    t1 = time.perf_counter()
    timing["filter"] = round((t1 - t0) * 1000) - timing["query"]
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
    t2 = time.perf_counter()
    timing["model"] = round((t2 - t1) * 1000)
    floor = fnum(qs, "floor")
    if floor is not None:  # coverage edge: cells weaker than this stay clear
        grid.values = [[v if v is None or v >= floor else None for v in row] for row in grid.values]
    vmin, vmax = fnum(qs, "vmin"), fnum(qs, "vmax")
    rgba, vmin, vmax = geo.colorize(grid, vmin, vmax, int(fnum(qs, "alpha", 190)))
    timing["colour"] = round((time.perf_counter() - t2) * 1000)
    timing.update(rows=len(rows), cells=grid.cols * grid.rows, kind=kind)
    grid.timing = timing
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
    parts = [geo.KML_HEAD, "<name>DAStastic export</name>"]
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


def _shown(v):
    """A setting's value in the mission log, in words."""
    return "not set" if v is None else "on" if v is True else "off" if v is False else json.dumps(v, ensure_ascii=False)


def diff(old, new, prefix=""):
    """What a save changed, one line each. A setting that went from not set to off or empty changed nothing anyone
    sees (a default written down), so it isn't logged."""
    out = []
    for k in sorted(set(old) | set(new)):
        a, b = old.get(k), new.get(k)
        if isinstance(a, dict) and isinstance(b, dict):
            out += diff(a, b, prefix + k + ".")
        elif a != b and not (a is None and (b is False or b in ("", [], {}))):
            out.append(f"{prefix}{k}: {_shown(a)} → {_shown(b)}")
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
        for r in con.execute("SELECT call_sign, licensee, mode, lat, lon, freq_mhz, erp_w, power_out_w FROM tx WHERE status='A' AND "
                             "freq_mhz BETWEEN ? AND ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                             (freq - tol, freq + tol, s, n, w, e)):
            d = geo.haversine_km(lat, lon, r["lat"], r["lon"]) / geo.MI_KM
            if best is None or d < best["dist_mi"]:
                best = dict(r, dist_mi=round(d, 1))
        if best:  # the free-space level this licence predicts where the reading was taken (best case)
            p = geo.fspl_rx_dbm(best.get("erp_w") or best.get("power_out_w"), best["dist_mi"] * geo.MI_KM, best["freq_mhz"])
            best["est_rx_dbm"] = round(p, 1) if p is not None else None
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
    # blankTile=false: a tile Esri doesn't have is a 404, not its grey "Map data not yet available" image, so the map
    # draws the zoom above instead (core.js RfTiles; zoom 20 is there in some places only, measured 11/10)
    "esri-imagery": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false",
    "counties": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/export"
                "?bbox={bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&dpi=96&f=image",
}
ONLINE_ONLY = {"osm", "esri-imagery"}  # their terms forbid keeping tiles for offline use: fetched each time, never on disk
TILE_UA = "RF-Recon/2.0 (personal site-survey tool; local cache)"
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
        for k, v in opened_safely(ctype, extra).items():
            for one in (v if isinstance(v, list) else [v]):  # a list: the header more than once (two login cookies, remote.cookie)
                self.send_header(k, one)
        self.end_headers()
        self.wfile.write(body)

    def mail_route(self, p, method, qs, con):
        if sys.platform == "emscripten":  # the web version: a browser can't reach a mail server (checked before the mail modules load)
            return self.send(200, {"available": False, "why": "Mail from your own mailbox works in DAStastic on the server or the PC; here, Open in my mail."}) \
                if p == "/api/mail/account" else self.send(400, {"error": "Mail works in DAStastic on the server or the PC."})
        import dasmail
        import mailbox
        login = getattr(remote.ON, "login", None) or getattr(remote.ON, "user", None) or "local"  # the PC's own window: "local"
        if fnum(qs, "job") is not None:  # a job's mail, people or email text: only for a login the job is shared with
            self.job_gate(con, int(fnum(qs, "job")), "view")
        import sesmail
        if p == "/api/mail/account":
            if method == "GET":
                a = dasmail.account(uls_import.DATA_DIR, login)
                return self.send(200, {"available": True, "login": login, "account": a, "dastastic": sesmail.public(uls_import.DATA_DIR),
                                       "state": sesmail.state(con, uls_import.DATA_DIR) if a and a.get("via") == "dastastic" else dasmail.state(con, login)})
            d = self.body_json()
            if d.get("via") == "dastastic":  # DAStastic sends for them (sesmail.py, Cody 11/8): no mailbox to test
                if not sesmail.config(uls_import.DATA_DIR):
                    raise ValueError("DAStastic's own sending isn't set up on this server yet: connect your own mailbox, or use Open in my mail.")
                dasmail.save_account(uls_import.DATA_DIR, login, dasmail.account_from(d))
                return self.send(200, {"ok": True, "account": dasmail.account(uls_import.DATA_DIR, login)})
            old = dasmail.account(uls_import.DATA_DIR, login, with_password=True)
            acct = dasmail.account_from(d, old)
            t = mailbox.test(acct)
            if t["imap"] or t["smtp"]:
                return self.send(400, {"error": " · ".join(x for x in (t["imap"] and f"Reading: {t['imap']}", t["smtp"] and f"Sending: {t['smtp']}") if x),
                                       "test": t, "guess": mailbox.guess(acct["address"])})
            if acct["folder"] not in [f["name"] for f in t["folders"]] and acct["folder"] != "INBOX":
                return self.send(400, {"error": f"No folder called {acct['folder']!r}: pick one of the mailbox's folders.", "test": t})
            dasmail.save_account(uls_import.DATA_DIR, login, acct)
            return self.send(200, {"ok": True, "account": dasmail.account(uls_import.DATA_DIR, login), "folders": t["folders"]})
        if p == "/api/mail/guess":
            return self.send(200, mailbox.guess(fstr(qs, "address")))
        if p.startswith(("/api/mail/queue", "/api/mail/job/")) or p in ("/api/mail/template", "/api/mail/templates"):
            # Ready to send (mailqueue.py): written for you, lined up, sent only on a click; and the job emails' texts
            import mailqueue
            firm = get_setting("das.firm", {}) or {}
            acct = dasmail.account(uls_import.DATA_DIR, login) or {}
            mj = re.match(r"^/api/mail/job/(\d+)$", p)
            if mj:  # every email this job needs now, for one list and one press
                self.job_gate(con, int(mj.group(1)), "edit")
                return self.send(200, mailqueue.job_items(con, login, int(mj.group(1)), firm, acct.get("name") or "", vis=dashist.visible(con, *self.team())))
            if p == "/api/mail/templates":
                return self.send(200, {"templates": [{"id": t[0], "label": t[1]} for t in mailqueue.TEMPLATES]})
            if p == "/api/mail/template":
                return self.send(200, mailqueue.template(con, int(fnum(qs, "job")), fstr(qs, "t") or "blank", firm, acct.get("name") or ""))
            if p == "/api/mail/queue":
                vis = dashist.visible(con, *self.team())
                its = mailqueue.items(con, login, firm, acct.get("name") or "", vis=vis)
                its = [x for x in its if vis is None or not x.get("job_id") or x["job_id"] in vis]
                if acct.get("via") == "dastastic" and not sesmail.public(uls_import.DATA_DIR)["prospects"]:  # cold email stays off it
                    for x in its:
                        if x.get("kind") == "prospect" and not x["blocked"]:
                            x["blocked"] = "Prospect emails go from your own mailbox, not through DAStastic: Open in my mail."
                return self.send(200, {"items": its, "ready": sum(1 for x in its if not x["blocked"]), "per_hour": mailqueue.SEND_PER_HOUR,
                                       "sent_last_hour": mailqueue.sent_last_hour(con, login)})
            if method != "POST":
                raise ValueError("Use POST.")
            d = self.body_json()
            if p == "/api/mail/queue/prospects":
                return self.send(200, mailqueue.queue_prospects(con, login, d.get("rows") or []))
            if p == "/api/mail/queue/later":
                return self.send(200, mailqueue.put_off(con, login, str(d.get("key") or ""), d.get("days")))
            raise LookupError("No such mail queue action.")
        if p == "/api/mail/people":  # the To picker: the job's people, contacts, suppliers, anyone who replied
            return self.send(200, {"people": dasmail.people(con, login, int(fnum(qs, "job")) if fnum(qs, "job") is not None else None)})
        if p == "/api/mail/account/delete" and method == "POST":
            dasmail.delete_account(uls_import.DATA_DIR, login)
            return self.send(200, {"ok": True})
        if p == "/api/mail/check" and method == "POST":
            if (dasmail.account(uls_import.DATA_DIR, login) or {}).get("via") == "dastastic":
                r = sesmail.check(con, uls_import.DATA_DIR)  # the reply bucket holds every login's replies: only this login's are shown
                return self.send(200, {**r, "filed": [x for x in r["filed"] if x.get("login") == login], "new": sum(1 for x in r["filed"] if x.get("login") == login),
                                       "dropped": len(r["dropped"])})
            return self.send(200, dasmail.check(con, uls_import.DATA_DIR, login))
        if p == "/api/mail/threads":
            fi = lambda k: int(qs[k][0]) if qs.get(k) and qs[k][0].isdigit() else None  # noqa: E731
            return self.send(200, {"mail": dasmail.threads(con, login, tag=fstr(qs, "tag") or None, job_id=fi("job"), rfq_id=fi("rfq"),
                                                           prospect_id=fstr(qs, "prospect") or None),
                                   "state": dasmail.state(con, login)})
        if p == "/api/mail/send" and method == "POST":
            return self.send(200, self.mail_send(con, login, self.body_json()))
        m = re.match(r"^/api/mail/(\d+)/apply$", p)
        if m and method == "POST":
            rj = con.execute("SELECT r.job_id FROM das_mail m JOIN das_rfq r ON r.id = m.rfq_id WHERE m.id=?", (int(m.group(1)),)).fetchone()
            if rj and rj[0]:
                self.job_gate(con, rj[0], "edit")
            return self.send(200, dasmail.apply_proposal(con, int(m.group(1))))
        m = re.match(r"^/api/mail/(\d+)/attachment$", p)
        if m:
            r = con.execute("SELECT job_id, attachments FROM das_mail WHERE id=? AND login=?", (int(m.group(1)), login)).fetchone()
            name = fstr(qs, "name")
            if not r or not r["job_id"] or name not in [x.get("saved") for x in json.loads(r["attachments"] or "[]")]:
                raise LookupError("That attachment isn't kept.")
            self.job_gate(con, r["job_id"], "view")
            j = das.job_row(con, r["job_id"])
            with open(das.file_path(r["job_id"], j["name"], name), "rb") as fh:
                return self.send(200, fh.read(), mimetypes.guess_type(name)[0] or "application/octet-stream",
                                 {"Content-Disposition": disposition("attachment", name)})
        raise LookupError("No such mail route.")

    def mail_send(self, con, login, d):
        """Send one email from the login's own mailbox, tagged from what it's about (the page never sets the tag)."""
        import dasmail
        import mailbox
        acct = dasmail.account(uls_import.DATA_DIR, login, with_password=True)
        if not acct:
            raise ValueError("Connect your mailbox first (Mail › Your mailbox).")
        import mailqueue
        if mailqueue.sent_last_hour(con, login) >= mailqueue.SEND_PER_HOUR:  # Gmail / Workspace cap a mailbox's sending per day
            raise ValueError(f"{mailqueue.SEND_PER_HOUR} emails sent in the last hour: DAStastic waits before sending more, so your "
                             "mailbox stays under its provider's limits. Try again later.")
        to = (d.get("to") or "").strip()
        if not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,24}(\s*[,;]\s*[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,24})*", to):
            raise ValueError("Enter who it goes to (an email address).")
        refs, kind = d.get("refs") or {}, d.get("kind")
        atts = []
        if kind == "rfq":
            q = das.get_rfq(con, int(refs["rfq_id"]))
            idx = q["suppliers"].index(refs["supplier"]) + 1
            tag = dasmail.rfq_tag(q["id"], idx)
            refs["job_id"] = q.get("job_id")
            if d.get("rfq_sheet", True):
                atts.append((f"Quote sheet - {q['title']}.csv".replace("/", "-")[:120], das.rfq_sheet(q).encode("utf-8"), "text/csv"))
        elif kind == "prospect":
            tag = dasmail.prospect_tag(refs["prospect_id"])
            st = con.execute("SELECT status FROM das_prospect WHERE id=?", (refs["prospect_id"],)).fetchone()
            if st and st["status"] == "do not contact":
                raise ValueError("They asked not to be contacted.")
        elif kind == "job":
            tag = dasmail.job_tag(int(refs["job_id"]), refs.get("topic") or "MAIL", refs.get("extra") or "")
        else:
            raise ValueError("What is this email about?")
        jid = refs.get("job_id")
        if jid:  # mail filed into a job, with its files: only a login that can change the job
            self.job_gate(con, int(jid), "edit")
        if d.get("files") and jid:
            j = das.job_row(con, int(jid))
            for name in d["files"][:10]:
                with open(das.file_path(int(jid), j["name"], name), "rb") as fh:
                    atts.append((name, fh.read(), mimetypes.guess_type(name)[0] or "application/octet-stream"))
        subject = dasmail.subject_with(tag, d.get("subject") or "")
        if acct.get("via") == "dastastic":  # DAStastic sends for them through SES (sesmail.py)
            import sesmail
            c = sesmail.config(uls_import.DATA_DIR)
            if not c:
                raise ValueError("DAStastic's own sending isn't set up on this server: connect your own mailbox, or use Open in my mail.")
            if kind == "prospect" and not c.get("prospects"):
                raise ValueError("Prospect first emails go from your own mailbox, not through DAStastic: a run of bounces or complaints on "
                                 "cold email would stop DAStastic's sending for everyone. Connect your own mailbox, or use Open in my mail.")
            msg = sesmail.build(c, login, acct, to, subject, d.get("body") or "", cc=(d.get("cc") or "").strip() or None, attachments=atts,
                                in_reply_to=d.get("in_reply_to"))
            r = sesmail.send(c, msg)
        else:
            msg = mailbox.build(acct, to, subject, d.get("body") or "", cc=(d.get("cc") or "").strip() or None, attachments=atts,
                                in_reply_to=d.get("in_reply_to"))
            r = mailbox.send(acct, msg)
        refs["to"] = to
        dasmail.record_out(con, login, tag, to, subject, d.get("body") or "", r["message_id"], refs, [x[0] for x in atts])
        dasmail.after_send(con, tag, refs)
        return {"ok": True, "tag": tag, "subject": subject, "attached": [x[0] for x in atts], "sent_copy": r["sent_copy"]}

    def raw_body(self):
        """What was sent, read once: the header then says 0, so do_POST's drain finds nothing left."""
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return b""
        self.headers.replace_header("Content-Length", "0")
        return self.rfile.read(n)

    def body_json(self):
        b = self.raw_body()
        return json.loads(b or b"{}")

    def booster_admin(self, con):
        """Whether this person may read the booster registrants' contacts: an admin login, or this PC's own window, on a
        copy that keeps them (boosters.py); never a team login, never the web version."""
        return self.team()[0] is None and sys.platform != "emscripten" and boosters.has_table(con, "booster_contact")

    def booster_contact_route(self, qs):
        """The people on one booster registration (boosters.contact), for an admin only. The first lock is the door's:
        /api/remote is blocked for every login but an admin (remote.BLOCKED). This is the second: a team login and the
        web version get 404, as if it weren't there. The answer is never logged."""
        con = db()
        try:
            if not self.booster_admin(con):
                return self.send(404, {"error": "not found"})
            c = boosters.contact(con, fstr(qs, "id"))
            return self.send(200, c) if c else self.send(404, {"error": "No contact is kept for that registration on this copy."})
        finally:
            con.close()

    def files_route(self, p, qs):
        """Server files (serverfiles.py). /api/remote is already blocked for everyone but an admin; this is the second
        lock, and it shuts this PC's own port, which has no sign-in."""
        login = getattr(remote.ON, "login", None)
        if not login or remote.role_of(login) != "admin":
            return self.send(404, {"error": "not found"})
        root, rel = fstr(qs, "root"), fstr(qs, "path")
        try:
            if p == "/api/remote/files":
                return self.send(200, serverfiles.listing(root, rel) if root else serverfiles.overview())
            fp, size, name = serverfiles.locate(root, rel)
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        print(f"server file: {login} downloaded {root}/{rel} ({size} bytes)", flush=True)
        self.send_response(200)
        for k, v in (("Content-Type", "application/octet-stream"), ("Content-Length", str(size)), ("Content-Disposition", serverfiles.disposition(name)),
                     ("X-Content-Type-Options", "nosniff"), ("Cache-Control", "no-store")):
            self.send_header(k, v)
        self.end_headers()
        try:
            serverfiles.copy(fp, self.wfile)
        except ConnectionError:  # they cancelled it
            self.close_connection = True

    def course_people(self):
        con = db()
        try:
            return self.send(200, {"people": course.overview(con, remote.users())})
        finally:
            con.close()

    def course_route(self, method, p):
        """The DAS course (course.py). Only through the sign-in door, and only for a login that has it."""
        login = getattr(remote.ON, "login", None)
        if not login:  # this PC's own port: no logins, so no one to save for. The PC has the course as a file
            return self.send(404, {"error": "not found"})
        if not remote.has_course(login):
            if p == "/course":
                return self.send(403, course.off_page(), "text/html; charset=utf-8")
            return self.send(403, {"error": "The DAS course isn't on for this login."})
        key = login.strip().lower()
        if p == "/course":
            page = course.page(login)
            if page is None:
                return self.send(404, b"The DAS course isn't on this copy.", "text/plain; charset=utf-8")
            con = sqlite3.connect(DB_PATH, timeout=2)  # "last used" is never worth holding the page while the FCC refresh writes
            try:
                course.opened(con, key)
            except sqlite3.OperationalError:
                pass
            finally:
                con.close()
            return self.send(200, page, "text/html; charset=utf-8")
        if int(self.headers.get("Content-Length") or 0) > course.MAX_BODY:
            self.headers.replace_header("Content-Length", "0")
            self.close_connection = True
            return self.send(413, {"error": "That's too much to save."})
        con = db()
        try:
            if method == "GET":
                return self.send(200, course.load(con, key))
            try:
                d = self.body_json()
                r = course.save(con, key, d.get("rev"), d.get("data"), d.get("summary"))
            except (ValueError, AttributeError) as e:
                return self.send(400, {"error": str(e)})
            return self.send(409 if r.get("conflict") else 200, r)
        finally:
            con.close()

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
                    return self.send(200, self.hide_jobs(con, finder.everything(con, cc, fstr(qs, "q"), fnum(qs, "lat"), fnum(qs, "lon"), scope)))
                finally:
                    con.close()
                    cc.close()
            if p == "/api/fccid":  # an FCC ID or grantee code -> its equipment grants (fccid.py)
                con = db()
                try:
                    return self.send(200, fccid.lookup(fstr(qs, "q"), con=con))
                finally:
                    con.close()
            if p == "/api/fccid/grantees":  # the kept maker list; POST: the FCC's own download in its place (fccid.py)
                con = db()
                try:
                    if method == "POST":
                        return self.send(200, fccid.import_grantee_file(con, fstr(qs, "name"), self.raw_body()))
                    return self.send(200, fccid.grantee_source(con))
                finally:
                    con.close()
            if p == "/api/fccid/grants" and method == "POST":  # an FCC grant search export (XML): its makers' grants and bands
                con = db()
                try:
                    return self.send(200, fccid.import_grant_file(con, fstr(qs, "name"), self.raw_body(), fstr(qs, "eq_class") or None,
                                                                  fstr(qs, "watts") or None))
                finally:
                    con.close()
            if p == "/api/fccid/parts" and method == "POST":  # the kept Part 90 booster grants into the DAS parts catalogue
                con = db()                                    # (under /fccid so the web version attaches the grants first)
                try:
                    return self.send(200, das.parts_from_grants(con))
                finally:
                    con.close()
            if p == "/api/fccid/boosters":  # devices whose grants take in all these frequencies (f=851.0125,806.0125,...);
                con = db()                    # band=800 MHz|806.0125,851.0125 (repeated) for each band on its own too
                try:
                    bands = {}
                    for b in qs.get("band", []):
                        name, _, fl = b.partition("|")
                        bands[name.strip() or f"band {len(bands) + 1}"] = [x for x in fl.split(",") if x.strip()]
                    return self.send(200, fccid.boosters_for(con, [x for x in (fstr(qs, "f") or "").split(",") if x.strip()], bands=bands,
                                                             classes=[c for c in fstr(qs, "cls").split(",") if c] or None,
                                                             min_watts=fnum(qs, "watts")))
                finally:
                    con.close()
            if p == "/api/radioid":  # who a DMR or NXDN radio ID belongs to (radioid.py: one look-up at a time, kept 30 days)
                import radioid
                cc = cdb()
                try:
                    return self.send(200, radioid.lookup(cc, fstr(qs, "id"), fstr(qs, "kind") or "dmr"))
                finally:
                    cc.close()
            if p == "/api/ais":  # live ships in the box (ais.py); the stream runs only while a map keeps asking
                s_, n_, w_, e_ = (fnum(qs, k) for k in ("s", "n", "w", "e"))
                if None in (s_, n_, w_, e_) or n_ - s_ > 6 or e_ - w_ > 8:
                    raise ValueError("Zoom in: ships stream for an area up to about 6 x 8 degrees.")
                if getattr(remote.ON, "user", None):  # remote viewers never start the stream on Cody's key
                    return self.send(200, ais.known(s_, n_, w_, e_))
                return self.send(200, ais.ships(s_, n_, w_, e_, (get_setting("creds", {}) or {}).get("aisstream_key")))
            if p == "/api/uls/pending":  # applications filed, not yet granted, in the search's area (ulsdaily.py): Agencies
                area = area_filter(qs)
                if not area:
                    raise ValueError("Drop a pin or pick a state/county.")
                con = db()
                try:
                    return self.send(200, ulsdaily.pending(con, area["sql"], area["args"], area["point"], area["radius"]))
                finally:
                    con.close()
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
                    pending = []  # filed, not yet granted (mw_pending.py), when that source has been loaded
                    if has_table(con, "mw_pending"):
                        for side in ("tx", "rx"):
                            for r in con.execute(f"SELECT rowid, * FROM mw_pending WHERE {side}_lat BETWEEN ? AND ? AND {side}_lon BETWEEN ? AND ? LIMIT ?",
                                                 (s_, n_, w_, e_, lim)):
                                if ("p", r["rowid"]) not in seen:
                                    seen.add(("p", r["rowid"]))
                                    pending.append(dict(r, pending=True))
                    loaded = loaded or bool(pending) or (has_table(con, "mw_pending") and con.execute("SELECT 1 FROM mw_pending LIMIT 1").fetchone() is not None)
                    return self.send(200, {"links": links[:lim], "pending": pending[:lim], "loaded": loaded,
                                           "truncated": len(links) > lim})
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
            if p == "/api/tak/feed":  # the TAK team on our map: ATAK users heard on this PC's networks, while the layer is on (takwatch.py)
                if getattr(remote.ON, "login", None):  # through the door: the server isn't on anyone's local network
                    return self.send(404, {"error": "The TAK team layer runs on the PC only: the server isn't on your local network."})
                import takwatch
                if method == "POST" and (self.body_json() or {}).get("on") is False:
                    takwatch.stop()
                    return self.send(200, {"listening": False, "items": []})
                return self.send(200, {**takwatch.ask(), "items": takwatch.feed()})
            if p == "/api/tak/push" and method == "POST":  # DAStastic's markers straight into ATAK / WinTAK (takpush.py)
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
                        # the import keeps to the states set in Data & updates: sent here, since /api/settings is the admin's
                        import spectrum
                        res = cells.sites(con, cc, lat, lon, fnum(qs, "radius", 5), int(mid) if mid is not None else None)
                        try:
                            spec = spectrum.at(lat, lon, uls_import.DATA_DIR, con)
                        except Exception as e:  # the record still opens without the carriers' blocks
                            spec = {"empty": True, "why": f"Carrier spectrum couldn't be read here: {e}"}
                        return self.send(200, dict(cells.enrich(res, con, spec), states=get_setting("update.states", "") or ""))
                    finally:
                        cc.close()
                if p == "/api/cells/fetch" and method == "POST":  # the crowd's cells around an address (its own route: /api/crowd/ is the admin's)
                    a = self.body_json()
                    cc = connectors.open_db(CROWD_PATH)
                    try:
                        return self.send(200, cells.fetch_near(cc, float(a["lat"]), float(a["lon"]), (get_setting("creds", {}) or {}).get("opencellid_key", "")))
                    finally:
                        cc.close()
                if p == "/api/spectrum":  # which carrier holds which spectrum in this county (spectrum.py)
                    import spectrum
                    if fnum(qs, "lat") is None or fnum(qs, "lon") is None:
                        raise ValueError("Carrier spectrum needs a location.")
                    return self.send(200, spectrum.at(fnum(qs, "lat"), fnum(qs, "lon"), uls_import.DATA_DIR, con))
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

    def phone_route(self, method, p, qs):
        """The Phone window (phone.py): its settings as the page may see them, the texts and calls with the demo list's
        numbers, a text, a call via your cell, and your cell. A full or admin login, or Cody's PC: a view login reads
        nothing here, the texts included."""
        import phone
        login = getattr(remote.ON, "login", None)
        if login and remote.role_of(login) not in ("full", "admin"):
            return self.send(403, {"error": "The phone is for full and admin logins."})
        c = phone.config(uls_import.DATA_DIR)
        if p == "/api/phone" and method == "GET":
            return self.send(200, dict(phone.public_of(c, login), licence=licence.public(uls_import.DATA_DIR)))
        if not c:
            return self.send(409, {"error": "The phone isn't set up on this copy."})
        try:
            if method == "GET" and p == "/api/phone/threads":
                return self.send(200, {"threads": phone.threads(c)})
            if method == "GET" and p == "/api/phone/thread":
                return self.send(200, {"messages": phone.thread(c, fstr(qs, "n"))})
            if method == "GET" and p == "/api/phone/calls":
                return self.send(200, {"calls": phone.calls(c)})
            if method == "GET" and p == "/api/phone/contacts":  # the DAS contacts with a phone number
                con = db()
                try:
                    rows = das.list_contacts(con)
                finally:
                    con.close()
                out = [{"id": r["id"], "name": r.get("name") or "", "org": r.get("org") or "", "phone": phone.e164(r.get("phone")),
                        "listed": phone.e164(r.get("phone")) in c["allow"]} for r in rows if phone.e164(r.get("phone"))]
                return self.send(200, {"contacts": out})
            if method == "POST" and p == "/api/phone/text":
                d = self.body_json()
                return self.send(200, phone.send_text(c, d.get("to"), d.get("body")))
            if method == "POST" and p == "/api/phone/call":
                return self.send(200, phone.call_via_cell(c, login or "", self.body_json().get("to")))
            if method == "POST" and p == "/api/phone/cell":
                return self.send(200, {"cell": phone.set_cell(uls_import.DATA_DIR, login or "", self.body_json().get("cell"))})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        except RuntimeError as e:
            return self.send(502, {"error": str(e)})
        return self.send(404, {"error": "No such page."})

    def notes_route(self, method, p, qs):
        """Notes (notes.py): the list, a new note, its recordings and photos (sent one by one as the request body), a
        file to play or show, and delete. Someone on the remote link sees and adds only their own and can't delete."""
        who = getattr(remote.ON, "user", None)
        con = db()
        try:
            m = re.match(r"^/api/notes(?:/(\d+))?(?:/([^/]+))?$", p)
            if not m:
                raise LookupError("No such page.")
            nid, sub = (int(m.group(1)) if m.group(1) else None), m.group(2)
            if method == "GET" and nid is None:
                return self.send(200, dict(notes.listing(con, NOTES_DIR, who), remote=bool(who)))
            if method == "GET":
                fp, ctype = notes.file_path(con, NOTES_DIR, nid, unquote(sub or ""), who)
                size = os.path.getsize(fp)
                rng = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
                a, b = 0, size - 1
                if rng and (rng.group(1) or rng.group(2)):  # a video or voice note seeks by asking for part of the file
                    a, b = (int(rng.group(1)), min(int(rng.group(2) or size - 1), size - 1)) if rng.group(1) else (max(0, size - int(rng.group(2))), size - 1)
                    if a > b:
                        return self.send(416, b"", ctype, {"Content-Range": f"bytes */{size}"})
                with open(fp, "rb") as fh:
                    fh.seek(a)
                    data = fh.read(b - a + 1)
                return self.send(206 if rng and (rng.group(1) or rng.group(2)) else 200, data, ctype,
                                 {"Accept-Ranges": "bytes", "Content-Range": f"bytes {a}-{b}/{size}",
                                  "Content-Disposition": disposition("inline", os.path.basename(fp))})
            if nid is None:
                return self.send(200, {"id": notes.create(con, NOTES_DIR, self.body_json(), who)})
            if sub == "file":
                n = int(self.headers.get("Content-Length") or 0)
                if n:  # streamed here, so do_POST's drain mustn't wait for it again
                    self.headers.replace_header("Content-Length", "0")
                try:
                    files = notes.add_file(con, NOTES_DIR, nid, fstr(qs, "role"), fstr(qs, "ext"), self.rfile, n, fnum(qs, "secs"), who)
                except Exception:
                    self.close_connection = True  # a refused file may be left unread: never reuse this connection
                    raise
                return self.send(200, {"files": files})
            if sub == "sent":  # emailed to Cody as report #N (notes.mark_sent)
                return self.send(200, notes.mark_sent(con, nid, self.body_json(), who))
            if sub == "delete" and not who:
                notes.delete(con, NOTES_DIR, nid)
                return self.send(200, {"ok": True})
            raise LookupError("No such page.")
        except (PermissionError, ValueError, LookupError) as e:
            if method == "POST":
                self.close_connection = True  # a refused upload's body may still be on the way
            return self.send(403 if isinstance(e, PermissionError) else 404 if isinstance(e, LookupError) else 400, {"error": str(e)})
        finally:
            con.close()

    def intake_capture(self, con, fname, data):
        """A capture from Intake's press, into the active mission: what /api/captures/import does with no choices made."""
        mid = get_setting("active_mission")
        mm = mission_row(con, int(mid)) if mid is not None else None
        settings = mm["settings"] if mm else dict(DEFAULT_MISSION_SETTINGS)
        track = [dict(r) for r in con.execute("SELECT ts, lat, lon, alt FROM track_point WHERE mission_id=?", (mm["id"],))] if mm else []
        fmt, pts, trk = captures.parse_any(fname, data, settings)
        lookup, lcon = uls_lookup_factory()
        try:
            summary = captures.store(con, int(mid) if mid is not None else None, fname, fmt, pts, trk, settings, lookup, extra_track=track)
        finally:
            lcon.close()
        if mm:
            con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)", (mm["id"], now(), "capture", f"Intake: {fname} ({fmt}), {summary['points']} points"))
            con.commit()
        return summary

    def intake_route(self, method, p, qs):
        """The one drop spot (intake.py): each file streamed to disk, scanned, recognised, matched to a job this login can open,
        then filed, held for a press, or left on the pile. Who may write is remote.refused's, as for any POST; each job is job_gate's."""
        import intake
        con = db()
        cc = lambda: cdb()  # noqa: E731

        def layer(name, fname, data):
            c = cc()
            try:
                return connectors.import_custom(c, name, fname, data)
            finally:
                c.close()

        def unlayer(name):
            c = cc()
            try:
                c.execute("DELETE FROM ext_point WHERE source='custom' AND layer=?", (name,))
                c.commit()
            finally:
                c.close()

        def uncapture(cid):
            for t, col in (("capture_point", "capture_id"), ("track_point", "capture_id"), ("capture", "id")):
                con.execute(f"DELETE FROM {t} WHERE {col}=?", (cid,))
            con.commit()
        try:
            who, role = self.team()
            ctx = intake.Ctx(con, who, role, lambda jid, need="view": self.job_gate(con, jid, need), lambda fname, data: self.intake_capture(con, fname, data), layer, unlayer, uncapture)
            if p == "/api/intake/file" and method == "POST":
                if not ctx.writes():
                    raise dashist.NotAllowed("Your login is view only.")
                n = int(self.headers.get("Content-Length") or 0)
                if n:  # streamed here, so do_POST's drain mustn't wait for it again
                    self.headers.replace_header("Content-Length", "0")
                try:
                    made = intake.add_stream(con, int(fnum(qs, "batch") or 0), fstr(qs, "name"), fstr(qs, "path"), self.rfile, n, ctx)
                except Exception:
                    self.close_connection = True  # a refused file may be left unread: never reuse this connection
                    raise
                return self.send(200, {"made": intake.brief(con, made)})
            m = re.match(r"^/api/intake/item/(\d+)/bytes$", p)
            if m and method == "GET":
                fp, name = intake.held_file(con, int(m.group(1)), ctx)
                self.send_response(200)  # streamed: a plan set can run to hundreds of MB
                for k, v in (("Content-Type", "application/octet-stream"), ("Content-Length", str(os.path.getsize(fp))), ("Content-Disposition", disposition("attachment", name)), ("X-Content-Type-Options", "nosniff")):
                    self.send_header(k, v)
                self.end_headers()
                with open(fp, "rb") as fh:
                    shutil.copyfileobj(fh, self.wfile, 1 << 20)
                return None
            return self.send(*intake.route(con, method, p, qs, self.body_json, ctx))
        except dashist.Refused as e:
            return self.send(e.status, e.body)
        except (dashist.NotAllowed, PermissionError) as e:
            return self.send(403, {"error": str(e)})
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        finally:
            con.close()

    def das_route(self, method, p, qs):
        """DAS / ERCES jobs, contacts, pre-survey, file import and the job folders (das.py). Errors reach the
        caller's handler: LookupError -> 404, anything else -> 500 (ValueError messages are shown as they are)."""
        con = db()
        try:
            if p.startswith("/api/das/x/"):  # licence watch, consent contacts, passband licensees, audit, AHJ, tunnels (dasx.py)
                import dasx
                mx = re.match(r"^/api/das/x/\w+/(\d+)", p)
                if mx:
                    self.job_gate(con, int(mx.group(1)), "view" if method == "GET" else "edit")
                return self.send(*dasx.handle(con, method, p, qs, self.body_json))
            if p.startswith("/api/das/shop"):  # where to shop: the ranked suppliers, this copy's picks, a line's sites (partshop.py)
                import partshop
                if p == "/api/das/shop" and method == "GET":
                    picked = get_setting(partshop.PICKED, []) or []
                    doc = partshop.load()
                    return self.send(200, {"suppliers": partshop.ranked(picked, fstr(qs, "kind"), fstr(qs, "q")), "picked": picked,
                                           "kinds": doc.get("kinds", []), "checked": doc.get("checked", ""), "total": len(doc.get("suppliers", []))})
                if p == "/api/das/shop/where" and method == "GET":
                    line = {k: fstr(qs, k) for k in ("cat", "item", "part", "maker", "note")}
                    import partcrawl
                    seen = partcrawl.seen_for(con, line["part"]) if line["part"] else {}  # what this copy read on suppliers' own sites
                    return self.send(200, partshop.where_to_look(line, get_setting(partshop.PICKED, []) or [], int(fnum(qs, "n", 8)), seen))
                if p == "/api/das/shop/pick" and method == "POST":
                    d = self.body_json()
                    return self.send(200, {"picked": partshop.pick(get_setting, set_setting, str(d.get("id") or ""), bool(d.get("on")), con)})
                return self.send(404, {"error": "No such page."})
            if p.startswith("/api/das/monitor"):  # BDA monitoring: SNMP traps per job, off until an admin turns it on (snmpwatch.py)
                import snmpwatch
                return self.send(*snmpwatch.handle(con, method, p, qs, self.body_json))
            if p.startswith("/api/das/seal"):  # sealed reports and their verify codes (das.py seal_*)
                body = {}
                if p == "/api/das/seal":  # a job's seals and where their PDFs are: that job's, like its Files
                    body = self.body_json() if method == "POST" else {}
                    self.job_gate(con, int(body.get("job_id") or fnum(qs, "job") or 0), "edit" if method == "POST" else "view")
                return self.send(*das.seal_route(con, method, p, qs, lambda: body or self.body_json(), getattr(remote.ON, "login", None) or ""))
            m = re.match(r"^/api/das/jobs(?:/(\d+))?(?:/(\w+))?(?:/(\w+))?$", p)
            if m:
                jid, action, sub = (int(m.group(1)) if m.group(1) else None), m.group(2), m.group(3)
                who, role = self.team()
                job = das.job_row(con, jid) if jid else None
                lv = dashist.level(con, jid, who, role) if job else None
                if jid and (job is None or lv is None):  # a job not shared with this login answers as if it weren't there
                    raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
                if role == "ahj" and (method, action) not in (("GET", None), ("GET", "review"), ("GET", "file"), ("POST", "review")) or \
                        role == "ahj" and jid and action is None:
                    raise dashist.NotAllowed("An AHJ login sees only the reports shared with it.")
                if method == "GET":
                    if jid is None:
                        vis = dashist.visible(con, who, role)
                        if role == "ahj":  # the review list: what was shared with it and where each review stands
                            return self.send(200, {"jobs": self.review_list(con, vis), "stages": das.STAGES})
                        import dasfirm
                        rows = [x for x in das.list_jobs(con) if vis is None or x["id"] in vis]
                        return self.send(200, {"jobs": rows, "stages": das.STAGES, "folder": das.DAS_DIR, "firm_needs": dasfirm.board(con, rows)})
                    if action is None:
                        return self.send(200, job)
                    if action == "history":  # every change, who and when, newest first (dashist.history)
                        return self.send(200, dashist.history(con, jid, fnum(qs, "before"), fnum(qs, "limit", 40)))
                    if action == "access":  # who can open the job, its share links and its review
                        return self.send(200, self.access_info(con, job, lv))
                    if action == "review":  # what a reviewer sees (dashist.review_view)
                        return self.send(200, dict(dashist.review_view(job, das.list_files(jid, job["name"], con)["files"]), level=lv,
                                                   who=dashist.who_now()))
                    if action == "file" and role == "ahj" and fstr(qs, "name") not in dashist.review_files(job["data"], das.list_files(jid, job["name"], con)["files"]):
                        raise LookupError("No such file.")
                    if action == "files":
                        import intake
                        return self.send(200, intake.labelled(das.list_files(jid, job["name"], con)))
                    if action == "boosters":  # registered Class B boosters at the building and within the pre-survey radius (boosters.py)
                        jd = job["data"] or {}
                        if jd.get("lat") is None or jd.get("lon") is None:
                            raise ValueError("Set the building's location first.")
                        radius = float((jd.get("presurvey") or {}).get("radius") or 15)
                        return self.send(200, dict(boosters.at_job(con, float(jd["lat"]), float(jd["lon"]), radius), contacts=self.booster_admin(con)))
                    if action == "bomreview":  # the Materials tab's list: groups, wrong-part warnings, price moves, what's missing, the outputs
                        import dasbom
                        return self.send(200, dasbom.review(con, job))
                    if action == "bomxlsx":  # the outputs as a workbook; ?sheets=customer,technician,ahj,orders
                        import dasbom
                        sheets = tuple(x for x in fstr(qs, "sheets").split(",") if x) or ("customer", "technician", "ahj")
                        label = "bill of materials" if len(sheets) > 1 else {"customer": "customer BOM", "technician": "pick list", "ahj": "AHJ BOM", "orders": "order by supplier"}.get(sheets[0], "bill of materials")
                        return self.send(200, dasbom.workbook(job, sheets, jid=jid, con=con), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                         {"Content-Disposition": disposition("attachment", f"{job['name']} - {label}.xlsx")})
                    if action == "packet":  # the AHJ packet's parts: the bill of materials and every gathered spec sheet (Joe 11/3)
                        import intake
                        reports = [f["name"] for f in das.sealed_files(con, jid) if f["packet"]]  # only a sealed report that still matches the job
                        return self.send(200, das.packet_zip(jid, das.with_part_codes(con, job), intake.names_of_kind(con, jid, "spec_sheet"), reports), "application/zip",
                                         {"Content-Disposition": disposition("attachment", f"{job['name']} - bill of materials and spec sheets.zip")})
                    if action == "file":
                        fp = das.file_path(jid, job["name"], fstr(qs, "name"))
                        if not os.path.isfile(fp):
                            raise LookupError("No such file.")
                        with open(fp, "rb") as fh:
                            data = fh.read()
                        ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
                        inline = ctype.startswith(("image/", "text/")) or ctype == "application/pdf"
                        return self.send(200, data, ctype, {"Content-Disposition": disposition("inline" if inline else "attachment", os.path.basename(fp))})
                else:
                    if jid is None:
                        return self.send(200, das.save_job(con, self.body_json(), page=True))
                    if action == "review":  # an AHJ's Accept / Return, or a comment from either side, kept in the job and its log
                        return self.send(200, self.review_post(con, job, lv, self.body_json()))
                    if lv not in ("edit", "owner"):
                        raise dashist.NotAllowed("This job is shared with you to look at only." if lv == "view" else
                                                 "This job is shared with you for review only.")
                    if action is None:  # a team login must say which revision its copy came from (dashist.check)
                        import codecheck
                        b = self.body_json()
                        codecheck.gate_save(con, job, b)  # a stage move forward needs what the stage needs, or a reason
                        b.pop("gate_reason", None)
                        return self.send(200, das.save_job(con, b, jid, page=True, need_rev=bool(who)))
                    if action == "restore":  # undo one change, or the job as it was then: a new revision, history kept
                        d = self.body_json()
                        try:
                            rev = int(d.get("rev"))
                        except (TypeError, ValueError):
                            raise ValueError("Which revision?")
                        return self.send(200, das.restore_job(con, jid, rev, d.get("mode") or "undo"))
                    if action == "access":
                        return self.send(200, self.access_post(con, job, lv, self.body_json()))
                    if action == "share":
                        return self.send(200, self.share_post(con, job, sub, self.body_json()))
                    if action == "note":
                        return self.send(200, das.note(con, jid, self.body_json().get("text", "")))
                    if action == "example":  # a completed example job's people, quotes, consent, log and mail (dasexample.py)
                        import dasexample; return self.send(200, dasexample.seed(con, jid, self.body_json(), getattr(remote.ON, "login", None) or getattr(remote.ON, "user", None) or "local"))  # noqa: E702
                    if action == "closeout":  # a carrier closeout package: the page's index, the files it names, the BOM (closeout.py); reads only
                        import closeout
                        data, name = closeout.zip_for(jid, job, self.body_json())
                        return self.send(200, data, "application/zip", {"Content-Disposition": disposition("attachment", name)})
                    if action == "specsheets":  # every BOM part's spec sheet into the job's folder (Joe 11/3: "build spec sheets")
                        return self.send(200, das.build_specsheets(con, jid, job))
                    if action == "register":  # a row of the firm register, copied onto this job's own fields (dasfirm.py)
                        import dasfirm
                        return self.send(200, dasfirm.pick(con, job, self.body_json(), who or dashist.who_now()))
                    if action == "bomimport":  # an iBwave equipment list read, not saved: the tab shows it first
                        import dasbom
                        return self.send(200, dasbom.import_equipment(con, fstr(qs, "name"), self.raw_body()))
                    if action == "bomissue":  # a dated revision of the list
                        import dasbom
                        b = self.body_json()
                        return self.send(200, dasbom.issue(con, jid, job, b.get("note"), b.get("override"), who or dashist.who_now()))
                    if action == "delete":
                        das.delete_job(con, jid)
                        return self.send(200, {"ok": True})
                    if action == "files" and sub == "delete":
                        fp = das.file_path(jid, job["name"], fstr(qs, "name"))
                        if os.path.isfile(fp):
                            os.remove(fp)
                        con.execute("DELETE FROM das_file WHERE job_id=? AND name=?", (jid, os.path.basename(fp)))
                        con.commit()
                        return self.send(200, das.list_files(jid, job["name"], con))
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
            # supplier quotes for a job's bill of materials: DAStastic writes the request, the person sends it (11/3)
            # prospects: buildings likely to need ERCES near a spot, from public lists (prospects.py), and the pipeline (11/3)
            if p == "/api/das/prospects":
                import prospects
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("Pick where to look: the pin, a mission or a job.")
                kinds = [k for k in fstr(qs, "kinds").split(",") if k] or None
                rows = prospects.near(uls_import.DATA_DIR, lat, lon, fnum(qs, "radius", 10), kinds, fstr(qs, "q"), int(fnum(qs, "limit", 500)))
                remember_prospect_spot(lat, lon, fnum(qs, "radius", 10))  # the next start warms it (warm_prospects)
                pset = (UPD.config()["permits"].get("datasets"), UPD._states()) if UPD else (None, None)  # building permits: a trigger per building (permits.py)
                rows = prospects.with_permits(uls_import.DATA_DIR, rows, lat, lon, fnum(qs, "radius", 10), kinds, *pset)
                vis = dashist.visible(con, *self.team())
                pl = [x if vis is None or x.get("job_id") in vis else dict(x, job_id=None) for x in prospects.permit_finish(das.with_pipeline(con, rows))]
                pl = boosters.attach(con, pl)  # a registered booster at the building: an existing system (boosters.py)
                return self.send(200, {"prospects": pl, "counts": {**prospects.counts(uls_import.DATA_DIR), **prospects.permit_counts(uls_import.DATA_DIR, *pset)},
                                       "sources": {k: {"name": v.get("name"), "license": v.get("license")} for k, v in prospects.SOURCES.items()}})
            if p == "/api/das/prospects/need":  # RF need per prospect, an estimate (need.py, 11/4); a GET, so view logins see it
                import need
                return self.send(200, need.api(con, uls_import.DATA_DIR, {k: fstr(qs, k) for k in need.QUERY}))
            m = re.match(r"^/api/das/prospects/([\w:.%\-]+)/nsi$", p)
            if m and method == "POST":  # the NSI record for one prospect's building, kept, and its need again (need.py)
                import need
                try:
                    return self.send(200, need.api_nsi(con, uls_import.DATA_DIR, unquote(m.group(1)), self.body_json()))
                except LookupError as e:
                    return self.send(404, {"error": str(e)})
            if p == "/api/das/prospects/highrises" and method == "POST":  # Overture buildings 75 ft / 7 floors and up near a spot
                import prospects
                d = self.body_json()
                lat, lon = float(d.get("lat")), float(d.get("lon"))
                n = prospects.highrises(uls_import.DATA_DIR, lat, lon, float(d.get("radius") or 3))
                return self.send(200, {"highrises": n})
            if p.startswith("/api/das/leads"):  # the prospect watch: saved areas and what they turned up (leads.py). Fetches nothing, sends nothing
                import leads
                pset = (UPD.config()["permits"].get("datasets"), UPD._states()) if UPD else (None, None)
                auto = bool(UPD and UPD.get("update.auto", False) and UPD.config()["permits"].get("enabled"))
                login = getattr(remote.ON, "login", None) or getattr(remote.ON, "user", None) or "local"  # as the mail queue keeps it
                return self.send(200, leads.route(con, method, p, uls_import.DATA_DIR, login, *pset, self.body_json, auto))
            m = re.match(r"^/api/das/prospects/([\w:.%\-]+)/(status|email|job|find-email)$", p)
            if m:
                import prospects
                pid, action = unquote(m.group(1)), m.group(2)  # the page sends the id URL-encoded (":" as %3A)
                if action in ("status", "job", "find-email") and method != "POST":
                    raise ValueError("Use POST.")
                if action == "status":
                    return self.send(200, das.set_prospect(con, pid, self.body_json()))
                import leads
                row = prospects.get(uls_import.DATA_DIR, pid) or leads.kept(con, pid)  # a lead keeps its facts after its permit has aged out
                if not row:
                    raise LookupError("That prospect isn't in the lists any more.")
                kept = con.execute("SELECT email, email_source FROM das_prospect WHERE id=?", (pid,)).fetchone()
                if kept and kept["email"]:
                    row.update(email=kept["email"], email_source=kept["email_source"] or "")
                if action == "email":
                    return self.send(200, das.prospect_email(row, get_setting("das.firm", {}) or {}))
                if action == "find-email":  # the building's own website: its published contact address (contactfind.py)
                    import contactfind
                    got = contactfind.find(row.get("website") or "")
                    if got["emails"] and not (kept and kept["email"]):
                        das.set_prospect(con, pid, {"email": got["emails"][0]["email"], "email_source": got["emails"][0]["page"]})
                    return self.send(200, got)
                have = con.execute("SELECT job_id FROM das_prospect WHERE id=?", (pid,)).fetchone()
                if have and have[0] and das.job_row(con, have[0]):
                    self.job_gate(con, have[0], "view")  # one job per prospect: someone else's, not shared, stays theirs
                    return self.send(200, das.job_row(con, have[0]))
                pset = (UPD.config()["permits"].get("datasets"), UPD._states()) if UPD else (None, None)
                job = das.save_job(con, {"name": row["name"], "stage": "Lead", "data": leads.job_data(con, uls_import.DATA_DIR, pid, row, *pset, self.body_json())})  # every fact the lead has
                das.set_prospect(con, pid, {"job_id": job["id"]})
                leads.made_job(con, pid)
                return self.send(200, job)
            if p == "/api/das/suppliers/refresh" and method == "POST":  # every supplier's price list link, now
                return self.send(200, {"refreshed": das.refresh_price_lists(con), "suppliers": das.list_suppliers(con)})
            # mail from the person's own mailbox (Cody 11/4: send and receive without leaving DAStastic): dasmail.py, mailbox.py
            if p.startswith("/api/mail/"):
                return self.mail_route(p, method, qs, con)
            if p == "/api/das/share-links":  # read-only share links for outside people: off until the admin turns them on
                if method == "POST":
                    if self.team()[0]:
                        raise dashist.NotAllowed("Only the admin turns share links on or off.")
                    set_setting("das.share_links", bool(self.body_json().get("on")))
                return self.send(200, {"on": self.share_on()})
            if p == "/api/das/register" or p.startswith("/api/das/register/"):  # instruments and people, kept once (dasfirm.py)
                import dasfirm
                m = re.match(r"^/api/das/register/(\d+)/file$", p)
                if m and method == "GET":  # always a download: only a PDF or a picture gets in, and it isn't opened as the app either way
                    fp = dasfirm.file_path(int(m.group(1)), fstr(qs, "name"))
                    if not os.path.isfile(fp):
                        raise LookupError("No such file.")
                    with open(fp, "rb") as fh:
                        return self.send(200, fh.read(), mimetypes.guess_type(fp)[0] or "application/octet-stream", {"Content-Disposition": disposition("attachment", os.path.basename(fp))})
                return self.send(*dasfirm.route(con, method, p, qs, self.body_json, self.raw_body, dashist.visible(con, *self.team()), dashist.who_now()))
            if p == "/api/das/book" or p.startswith("/api/das/book/"):  # what jobs learned about each AHJ (ahjbook.py)
                import ahjbook
                vis = dashist.visible(con, *self.team())
                if p == "/api/das/book" and method == "GET":
                    return self.send(200, {"entries": ahjbook.listing(con, vis)})
                m = re.match(r"^/api/das/book/(\d+)/delete$", p)
                if m and method == "POST":
                    return self.send(200, ahjbook.remove(con, int(m.group(1)), vis))
                raise LookupError("No such page.")
            if p == "/api/das/firm":  # the firm's own details for the DAS Pitch deck, kept for every login (11/3)
                if method == "GET":
                    return self.send(200, get_setting("das.firm", {}) or {})
                d = self.body_json()
                firm = {k: str(d.get(k) or "").strip()[:300] for k in ("name", "tagline", "phone", "email", "website", "area", "license", "certs", "address", "contact")}
                set_setting("das.firm", firm)
                return self.send(200, firm)
            if p == "/api/das/suppliers":
                return self.send(200, {"suppliers": das.list_suppliers(con)} if method == "GET" else das.save_supplier(con, self.body_json()))
            m = re.match(r"^/api/das/rfq(?:/(\d+))?(?:/(\w+))?$", p)
            if m:
                rid, action = (int(m.group(1)) if m.group(1) else None), m.group(2)
                if rid is None:
                    if method == "GET":
                        if fnum(qs, "job"):
                            self.job_gate(con, int(fnum(qs, "job")), "view")
                        return self.send(200, {"rfqs": das.list_rfqs(con, int(fnum(qs, "job", 0)))})
                    d = self.body_json()
                    job = das.job_row(con, int(d.get("job_id") or 0))
                    if not job:
                        raise LookupError("That job was deleted.")
                    self.job_gate(con, job["id"], "edit")
                    return self.send(200, das.create_rfq(con, job["id"], job, d.get("suppliers") or [], d.get("need_by", ""), d.get("ship_to", ""), d.get("notes", "")))
                rj = con.execute("SELECT job_id FROM das_rfq WHERE id=?", (rid,)).fetchone()
                if rj and rj[0]:  # a request for quote is its job's: the job's access list says who sees and changes it
                    self.job_gate(con, rj[0], "view" if method == "GET" else "edit")
                if method == "GET":
                    q = das.get_rfq(con, rid)
                    if action == "sheet":
                        return self.send(200, das.rfq_sheet(q).encode("utf-8"), "text/csv; charset=utf-8",
                                         {"Content-Disposition": disposition("attachment", f"Request for quote - {q['title'][:80]}.csv")})
                    if action == "email":
                        return self.send(200, das.rfq_email(q, fstr(qs, "supplier"), fstr(qs, "sender")))
                    return self.send(200, q)
                if action == "quote":
                    d = self.body_json()
                    return self.send(200, das.save_quote(con, rid, d.get("supplier", ""), d))
                if action == "import":
                    return self.send(200, das.import_quote(con, rid, fstr(qs, "supplier"), fstr(qs, "name"), self.raw_body()))
                if action == "freight":  # shipping estimates from each supplier to the ship-to (freight.py, a Shippo token)
                    return self.send(200, das.freight_estimate(con, rid, (get_setting("creds", {}) or {}).get("shippo_token")))
                if action == "online":  # the distributors' online prices for the request's lines (Mouser, Digi-Key: their keys)
                    return self.send(200, das.online_quotes(con, rid, get_setting("creds", {}) or {}))
                if action == "delete":
                    for t in ("das_quote", "das_rfq_supplier"):
                        con.execute(f"DELETE FROM {t} WHERE rfq_id=?", (rid,))
                    # its mail stays as history but leaves the request: a new request can get this id back, and showed
                    # the old replies (and their Apply) as its own (11/4)
                    con.execute("UPDATE das_mail SET rfq_id=NULL WHERE rfq_id=?", (rid,))
                    con.execute("DELETE FROM das_rfq WHERE id=?", (rid,))
                    con.commit()
                    return self.send(200, {"ok": True})
            m = re.match(r"^/api/das/kits(?:/(\d+))?(?:/(\w+))?$", p)
            if m:  # kits: a set of bill-of-materials lines saved once (dasbom.py)
                import dasbom
                if method == "GET":
                    return self.send(200, dasbom.list_kits(con))
                if m.group(2) == "delete":
                    return self.send(200, dasbom.delete_kit(con, int(m.group(1))))
                return self.send(200, dasbom.save_kit(con, self.body_json()))
            # the parts catalogue: a supplier's price list, the standard parts, a spec sheet on each part (Joe 11/3)
            m = re.match(r"^/api/das/parts(?:/(\d+))?(?:/(\w+))?$", p)
            if m:
                pid, action = (int(m.group(1)) if m.group(1) else None), m.group(2)
                if method == "GET":
                    if action == "lookup":  # a part number on a BOM line: the catalogue's parts, with the price on a date if asked
                        return self.send(200, das.lookup_part(con, fstr(qs, "part"), fstr(qs, "as_of"), fstr(qs, "supplier")))
                    if action == "prices":  # a part's price now and its dated history
                        return self.send(200, das.price_history(con, pid))
                    if action == "spec":
                        fp = das.spec_path(con, pid)
                        if not os.path.isfile(fp):
                            raise LookupError("The spec sheet file is missing.")
                        with open(fp, "rb") as fh:
                            return self.send(200, fh.read(), "application/pdf", {"Content-Disposition": disposition("inline", os.path.basename(fp))})
                    das.seed_parts(con)  # once: a starter catalogue from the research parts, before any price list (11/3)
                    das.sync_grant_parts(con)  # every Part 90 booster on the kept FCC grants, when they changed (11/4)
                    ids = [int(x) for x in fstr(qs, "ids").split(",") if x.strip().isdigit()] if fstr(qs, "ids") else None
                    return self.send(200, das.list_parts(con, fstr(qs, "q"), fstr(qs, "standard") == "1", ids, int(fnum(qs, "limit", 200)),
                                                             grants=fstr(qs, "grants") == "1", sort=fstr(qs, "sort") or None,
                                                             desc=fstr(qs, "dir") == "desc"))
                if p == "/api/das/parts/import":
                    return self.send(200, das.import_parts(con, fstr(qs, "name"), self.raw_body(), fstr(qs, "supplier"), fstr(qs, "as_of")))
                if action == "delete":
                    das.delete_part(con, pid)
                    return self.send(200, {"ok": True})
                if action == "pattern":  # a Planet .msi / .pln antenna pattern onto the part, or a new antenna part (11/4)
                    return self.send(200, das.save_pattern(con, pid, fstr(qs, "name"), self.raw_body()))
                if action == "spec":
                    return self.send(200, das.save_spec(con, pid, self.raw_body()))
                return self.send(200, das.save_part(con, self.body_json(), pid))
            if p == "/api/das/presurvey":
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("The pre-survey needs the building's location.")
                # no loss given: the job's building's own ITU-R P.2109 entry loss (das.building_entry_loss)
                jid = fnum(qs, "job")
                bld = ((das.job_row(con, int(jid)) or {}).get("data") or {}) if jid is not None and fnum(qs, "loss") is None else None
                res = das.presurvey(con, lat, lon, fnum(qs, "radius", 15), fnum(qs, "loss"), fnum(qs, "threshold", -95), building=bld)
                # registered Class B boosters within the radius on these systems' channels, shown apart from them (boosters.py)
                res["boosters"] = boosters.for_presurvey(con, lat, lon, fnum(qs, "radius", 15), res["systems"], fstr(qs, "chosen").split(","))
                # beside the free-space levels, the realistic ones: Hata + terrain where cached (coverage.py, 11/4)
                return self.send(200, coverage.presurvey_realistic(con, res, lat, lon, fstr(qs, "env") or "suburban"))
            if p == "/api/das/nsi":  # the USACE National Structure Inventory for the job's building (nsi.py; a small box, never bulk)
                import nsi
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("Set the building's location first.")
                jid = fnum(qs, "job")
                if jid is not None:
                    self.job_gate(con, int(jid), "view")
                job = das.job_row(con, int(jid)) if jid is not None else None
                try:
                    return self.send(200, nsi.lookup(lat, lon, outline=(((job or {}).get("data") or {}).get("building") or {}).get("outline")))
                except LookupError as e:
                    return self.send(404, {"error": str(e)})
            if p == "/api/das/parse" and method == "POST":  # any tool's results file -> rows + a guess at its columns
                fmt, head, rows = das.read_table(fstr(qs, "name"), self.raw_body())
                return self.send(200, {"format": fmt, "headers": head, "rows": rows[:20000], "total": len(rows), "guess": das.guess_for(fmt, head)})
            if p == "/api/das/sweep" and method == "POST":  # a cable / antenna analyzer's sweep export -> its trace (dassweep.js)
                return self.send(200, das.read_sweep(fstr(qs, "name"), self.raw_body()))
            if p == "/api/das/search":  # everything in the DAS tab: jobs (every field), contacts, log, files, research
                return self.send(200, self.hide_jobs(con, finder.das_search(con, fstr(qs, "q"))))
            if p == "/api/das/building":  # the building's outline, footprint and levels from OpenStreetMap
                lat, lon = fnum(qs, "lat"), fnum(qs, "lon")
                if lat is None or lon is None:
                    raise ValueError("Set the building's location first.")
                return self.send(200, das.building_outline(lat, lon, fresh=qs.get("fresh", [""])[0] == "1"))
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
        except dashist.Refused as e:  # a stale or unknown revision: what clashed, for the page to ask about (409), or reload (428)
            return self.send(e.status, e.body)
        except dashist.NotAllowed as e:
            return self.send(403, {"error": str(e)})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        finally:
            con.close()

    def markup_route(self, method, p, qs):
        """Drawings on the maps (markup.py, Cody 11/10): a mission's, a DAS job's (its access list: view to see, edit to
        change), or this copy's scratch ones. GET /api/markup lists, /api/markup/export gives KML or GeoJSON; POST
        /api/markup saves one, /api/markup/delete removes one. A view-only login can't POST (remote.refused)."""
        import markup
        con = db()
        try:
            markup.ensure(con)
            d = self.body_json() if method == "POST" else {}
            scope, sid = markup.scope_of(d.get("scope") or fstr(qs, "scope") or "scratch", d.get("scope_id", fstr(qs, "id")))
            if scope == "job":
                self.job_gate(con, sid, "edit" if method == "POST" else "view")
            elif scope == "mission" and not con.execute("SELECT 1 FROM mission WHERE id=?", (sid,)).fetchone():
                raise LookupError(f"Mission {sid} was deleted. Reload to see the current ones.")
            if method == "GET" and p == "/api/markup":
                return self.send(200, {"scope": scope, "scope_id": sid, "items": markup.listing(con, scope, sid)})
            if method == "GET" and p == "/api/markup/export":
                rows = markup.listing(con, scope, sid)
                name = re.sub(r"[^\w .-]+", "", fstr(qs, "name") or "")[:80].strip() or f"DAStastic drawings - {scope} {sid}"
                if (fstr(qs, "format") or "kml") == "geojson":
                    return self.attach(json.dumps(markup.geojson(rows), indent=1).encode(), f"{name}.geojson", "application/geo+json")
                return self.attach(markup.kml(rows, name).encode("utf-8"), f"{name}.kml", "application/vnd.google-earth.kml+xml")
            if method == "POST" and p == "/api/markup":
                who = getattr(remote.ON, "login", None) or getattr(remote.ON, "user", None) or "local"
                return self.send(200, markup.save(con, {**d, "scope": scope, "scope_id": sid}, who))
            if method == "POST" and p == "/api/markup/delete":
                markup.delete(con, d.get("id"), scope, sid)
                return self.send(200, {"ok": True})
            return self.send(404, {"error": "not found"})
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except dashist.NotAllowed as e:
            return self.send(403, {"error": str(e)})
        except ValueError as e:
            return self.send(400, {"error": str(e)})
        finally:
            con.close()

    # ------------------------------------------------ per-job access (dashist.py): team logins see the jobs shared with them
    def team(self):
        """The signed-in team login answering now and its role, or (None, None) for the admin and the PC's own window."""
        who = getattr(remote.ON, "user", None)
        return (who, remote.role_of(who) or "view") if who else (None, None)

    def job_gate(self, con, jid, need="view"):
        """The login's level on the job; a job not shared with it answers as if it weren't there (404), a change it
        can't make is refused (403)."""
        lv = dashist.level(con, jid, *self.team())
        if lv is None or not con.execute("SELECT 1 FROM das_job WHERE id=?", (jid,)).fetchone():
            raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
        if need == "edit" and lv not in ("edit", "owner"):
            raise dashist.NotAllowed("This job is shared with you to look at only." if lv == "view" else "This job is shared with you for review only.")
        return lv

    def hide_jobs(self, con, res):
        """A search answer without the jobs (and their log lines and files) this login can't open."""
        vis = dashist.visible(con, *self.team())
        if vis is None:
            return res

        def walk(x):
            if isinstance(x, dict):
                out = {k: walk(v) for k, v in x.items()}
                if isinstance(out.get("items"), list) and any(isinstance(i, dict) and "job_id" in i for i in x.get("items") or []):
                    out["items"] = [i for i in out["items"] if not (isinstance(i, dict) and i.get("job_id") is not None and i["job_id"] not in vis)]
                    if "count" in out:
                        out["count"] = len(out["items"])
                return out
            if isinstance(x, list):
                return [walk(v) for v in x if not (isinstance(v, dict) and v.get("kind") in ("dasjob", "dasfile") and v.get("job_id") not in vis)]
            return x
        return walk(res)

    def review_list(self, con, vis):
        """An AHJ login's list: the jobs shared with it, where each is and where its review stands."""
        out = []
        for r in con.execute("SELECT id, name, stage, data, updated_at FROM das_job ORDER BY updated_at DESC").fetchall():
            if vis is not None and r["id"] not in vis:
                continue
            d = json.loads(r["data"] or "{}")
            rv = d.get("review") if isinstance(d.get("review"), dict) else {}
            out.append({"id": r["id"], "name": r["name"], "stage": r["stage"], "updated_at": r["updated_at"], "address": d.get("address"),
                        "ahj": d.get("ahj"), "review": rv.get("status") or "waiting"})
        return out

    def share_on(self):
        return bool(get_setting("das.share_links", False))

    def access_info(self, con, job, lv):
        """Who can open the job and how, the people who could be added, its share links and its review."""
        jid, manage = job["id"], lv in ("edit", "owner")
        people = {u["name"].lower(): u for u in remote.users()}
        rows = [dict(a, name="Whole team" if a["who"] == "*" else (people.get(a["who"]) or {}).get("name") or a["who"],
                     role="" if a["who"] == "*" else (people.get(a["who"]) or {}).get("role") or "gone") for a in dashist.access_list(con, jid)]
        files = das.list_files(jid, job["name"], con)["files"]
        rv = job["data"].get("review") if isinstance(job["data"].get("review"), dict) else {}
        return {"list": rows, "level": lv, "can_manage": manage, "admin": self.team()[0] is None,
                "people": [{"name": u["name"], "role": u["role"]} for u in people.values()] if manage else [],
                "share": {"on": self.share_on(), "links": dashist.share_list(con, jid) if manage else [], "days": list(dashist.SHARE_DAYS)},
                "review": {"status": rv.get("status") or "waiting", "thread": rv.get("thread") or []},
                "files": [f["name"] for f in files], "review_files": dashist.review_files(job["data"], files),
                "picked": isinstance(job["data"].get("review_files"), list)}

    def access_post(self, con, job, lv, d):
        """{who, level}: a login (or "*", the whole team) on the job at view / review / edit, or off it ("none");
        {review_files: [...]}: the files a reviewer sees."""
        jid, by = job["id"], dashist.who_now()
        if "review_files" in d:
            names = {f["name"] for f in das.list_files(jid, job["name"])["files"]}
            pick = d["review_files"]
            das.save_job(con, {"data": {"review_files": None if pick is None else [n for n in pick if n in names]}}, jid)
            return self.access_info(con, das.job_row(con, jid), lv)
        who, level_ = (d.get("who") or "").strip(), d.get("level") or ""
        if who != "*" and not remote.role_of(who):
            raise ValueError("No login by that name. The admin adds people in Data & updates, Remote access.")
        if who != "*" and remote.role_of(who) == "admin":
            raise ValueError("An admin login sees every job already.")
        dashist.grant(con, jid, who, level_, by)
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                    (jid, now(), "access", f"{'Whole team' if who == '*' else who}: {'removed' if level_ == 'none' else level_} ({by})"))
        con.commit()
        return self.access_info(con, job, lv)

    def share_post(self, con, job, sub, d):
        """A read-only link that expires ({days, label}), or one revoked (sub "revoke", {id}). Off until the admin
        turns share links on (POST /api/das/share-links)."""
        jid = job["id"]
        if sub == "revoke":
            return {"links": dashist.share_revoke(con, jid, int(d.get("id") or 0))}
        if sub:
            raise LookupError("No such share action.")
        if not self.share_on():
            raise dashist.NotAllowed("Share links are off. The admin turns them on in a job's Log tab, Access.")
        made = dashist.share_make(con, jid, dashist.who_now(), d.get("days"), d.get("label") or "")
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                    (jid, now(), "share", f"read-only link{' for ' + d['label'].strip()[:80] if (d.get('label') or '').strip() else ''}, "
                                          f"until {made['expires'][:16]} ({dashist.who_now()})"))
        con.commit()
        return {"path": f"/share/{made['token']}", "expires": made["expires"], "links": dashist.share_list(con, jid)}

    def review_post(self, con, job, lv, d):
        """{decision: accept | return | comment, comment}: Accept and Return are the reviewer's (a review grant); a comment
        is anyone's who can open the job beyond looking. Kept in the job (data.review) and its log."""
        decision = d.get("decision")
        if decision in ("accept", "return") and lv != "review":
            raise dashist.NotAllowed("Accept and Return are the reviewer's: share the job with their login for review.")
        if decision == "comment" and lv not in ("review", "edit", "owner"):
            raise dashist.NotAllowed("This job is shared with you to look at only.")
        who, role = dashist.who_now(), self.team()[1] or "owner"
        rv = dashist.review_add(job["data"].get("review"), who, role, decision, d.get("comment"))
        j = das.save_job(con, {"data": {"review": rv}}, job["id"], who=who)
        word = {"accept": "Accepted", "return": "Returned", "comment": "Comment"}[decision]
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                    (job["id"], now(), "review", f"{word} by {who}{': ' + rv['thread'][-1]['comment'] if rv['thread'][-1]['comment'] else ''}"[:2000]))
        con.commit()
        return dict(dashist.review_view(j, das.list_files(job["id"], j["name"], con)["files"]), level=lv, who=who)

    def share_route(self, p, qs):
        """A read-only share link (dashist.py): the review page, its data and its files, for as long as the link lives and
        share links are on. Anything else here answers 404, signed out or not."""
        m = re.match(r"^/share/([A-Za-z0-9_-]{32,64})(?:/(data|file|review\.js|das\.js))?$", p)
        # no-referrer here on purpose: the link's token is in the URL. Every answer below must pass hdr, because the door's
        # default is same-origin since 11/10 (security review: a new share path that forgets it would send its token as Referer)
        hdr = {"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
        if not m or not self.share_on():
            return self.send(404, {"error": "not found"}, extra=hdr)
        con = db()
        try:
            jid = dashist.share_find(con, m.group(1))
            job = das.job_row(con, jid) if jid else None
            if not job:
                return self.send(404, {"error": "This link has expired or was turned off."}, extra=hdr)
            what = m.group(2)
            if what in ("review.js", "das.js"):
                with open(os.path.join(STATIC, "dasreview.js" if what == "review.js" else "das.js"), "rb") as fh:
                    return self.send(200, fh.read(), "text/javascript; charset=utf-8", hdr)
            if what is None:
                with open(os.path.join(STATIC, "review.html"), "rb") as fh:
                    page = fh.read().replace(b"/static/das.js", f"/share/{m.group(1)}/das.js".encode()) \
                        .replace(b"/static/dasreview.js", f"/share/{m.group(1)}/review.js".encode()) \
                        .replace(b'<script src="/static/account.js"></script>', b"")  # a link has no account (and no sign-in to fetch it)
                return self.send(200, page, "text/html; charset=utf-8", dict(hdr, **{"X-Frame-Options": "DENY"}))
            files = das.list_files(jid, job["name"], con)["files"]
            view = dashist.review_view(job, files)
            if what == "data":  # an owner or radio shop sees where the review stands, not the thread
                view["review"] = {"status": view["review"]["status"], "thread": []}
                return self.send(200, dict(view, share=True, level="view"), extra=hdr)
            name = fstr(qs, "name")
            if name not in view["files"]:
                return self.send(404, {"error": "No such file."}, extra=hdr)
            fp = das.file_path(jid, job["name"], name)
            with open(fp, "rb") as fh:
                data = fh.read()
            ctype = mimetypes.guess_type(fp)[0] or "application/octet-stream"
            return self.send(200, data, ctype, dict(hdr, **{"Content-Disposition": disposition("inline", os.path.basename(fp))}))
        finally:
            con.close()

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        p = u.path
        try:
            if p.startswith("/share/"):  # a read-only share link (off unless the admin turned them on; dashist.py)
                return self.share_route(p, qs)
            if p in ("/course", remote.COURSE_SAVE):  # the DAS course: a ticked login's, through the door only (course.py)
                return self.course_route("GET", p)
            if p == "/review":  # the review page: an AHJ login's whole DAStastic (dasreview.js)
                with open(os.path.join(STATIC, "review.html"), "rb") as fh:
                    return self.send(200, fh.read(), "text/html; charset=utf-8")
            if p.startswith(("/api/das/", "/api/mail/")):  # mail lives beside the DAS jobs it files into
                return self.das_route("GET", p, qs)
            if p == "/api/markup" or p.startswith("/api/markup/"):  # drawings on the maps (markup.py)
                return self.markup_route("GET", p, qs)
            if p == "/api/intake" or p.startswith("/api/intake/"):  # the one drop spot (intake.py)
                return self.intake_route("GET", p, qs)
            if p == "/api/notes" or p.startswith("/api/notes/"):
                return self.notes_route("GET", p, qs)
            if p == "/api/phone" or p.startswith("/api/phone/"):  # the Phone window (phone.py)
                return self.phone_route("GET", p, qs)
            if p in EXTRA_ROUTES:
                return self.extra_route("GET", p, qs)
            if p in ("/", "/index.html"):
                with open(os.path.join(STATIC, "index.html"), "rb") as fh:
                    return self.send(200, fh.read(), "text/html; charset=utf-8")
            if p == "/verify":  # a sealed report's public verify page: off until Cody switches das_verify_public on (das.py)
                if not das.public_verify_on(get_setting):
                    return self.send(404, b"Report verification isn't switched on here.", "text/plain; charset=utf-8")
                con = db()
                try:
                    return self.send(200, das.public_verify_page(con, fstr(qs, "code")), "text/html; charset=utf-8")
                finally:
                    con.close()
            if p == "/favicon.ico":  # browsers ask for it on every page; it was a 404 each time (11/3)
                with open(os.path.join(STATIC, "app", "icons", "icon-192.png"), "rb") as fh:
                    return self.send(200, fh.read(), "image/png", {"Cache-Control": "max-age=86400"})
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
            if p == "/api/versions":  # Ways in's Version column: this copy's build, the published site's, the newest kit, Android
                return self.send(200, {"this": build.version(), "server": bool(remote.SERVER_URL), "site": kitupdate.site_build(),
                                       "kit": kitupdate.latest(), "android": ANDROID_VERSION})
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
            if p == "/api/bdc/near":  # the FCC's coverage checks and the fixed wireless offered at this spot (bdc_extra.py)
                import bdc_extra
                return self.send(200, bdc_extra.near(uls_import.DATA_DIR, fnum(qs, "lat"), fnum(qs, "lon")))
            if p == "/api/bdc/modelled":  # how a carrier says it modelled its coverage: tools and link budget frequencies
                import bdc_extra
                return self.send(200, bdc_extra.modelled(uls_import.DATA_DIR, int(fnum(qs, "provider"))))
            if p == "/api/bdc/carriers":  # the carriers with coverage in a box, for the carrier heatmap's picker
                return self.send(200, {"carriers": bdc.carriers(uls_import.DATA_DIR, *(fnum(qs, k) for k in ("s", "n", "w", "e")))})
            if p == "/api/me":  # the remote door answers this itself (RemoteH); the data folder lets a launcher know its own copy
                return self.send(200, {"remote": False, "data": uls_import.DATA_DIR, "licence": licence.public(uls_import.DATA_DIR),
                                       "phone": phone_ready(None)})
            if p == "/api/remote":  # who can use DAStastic remotely, and the public link (remote.py); door 0 = this copy has none
                return self.send(200, {"people": remote.users(), "link": remote.link() if REMOTE_PORT else {}, "door": REMOTE_PORT,
                                       "google_on": remote.google_on()})
            if p == "/api/remote/course":  # who has the DAS course and how far each has got (admin only: /api/remote is blocked)
                return self.course_people()
            if p in ("/api/remote/files", "/api/remote/files/download"):  # what the server keeps: read only (serverfiles.py)
                return self.files_route(p, qs)
            if p == "/api/remote/booster-contact":  # a booster registrant's contact: an admin's only (booster_contact_route)
                return self.booster_contact_route(qs)
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
                return self.attach(to_csv([r for r in query_area(qs).get("rows", []) if facet_keep(qs)(r)]), "DAStastic.csv", "text/csv")
            if p == "/api/export.kml":
                res = query_area(qs)
                mid = fnum(qs, "mission")
                return self.attach(features_kml([r for r in res.get("rows", []) if facet_keep(qs)(r)], res.get("center"), res.get("radius"),
                                                int(mid) if mid is not None else None),
                                   "DAStastic.kml", "application/vnd.google-earth.kml+xml")
            if p == "/api/heatmap":
                grid, rgba, vmin, vmax, unit, desc = heatmap(qs)
                tp = time.perf_counter()
                png = geo.png_rgba(grid.cols, grid.rows, rgba)
                timing = dict(getattr(grid, "timing", {}), png=round((time.perf_counter() - tp) * 1000))
                return self.send(200, {"png": base64.b64encode(png).decode(), "bounds": [[grid.s, grid.w], [grid.n, grid.e]],
                                       "vmin": vmin, "vmax": vmax, "unit": unit, "desc": desc, "timing": timing})
            if p == "/api/heatmap.zip":
                data, name = heatmap_bundle(qs)
                return self.attach(data, f"{name}.zip", "application/zip")
            if p == "/api/missions":
                con = db()
                rows = [dict(r) for r in con.execute("SELECT id,name,status,lat,lon,radius_mi,start_date,end_date,operator,updated_at FROM mission ORDER BY id DESC")]
                con.close()
                return self.send(200, {"missions": rows, "active": get_setting("active_mission")})
            m = re.match(r"^/api/missions/(\d+)/hunt$", p)
            if m:  # Find a signal: where it probably is, from this mission's readings on one frequency (11/3)
                return self.send(200, mission_hunt(int(m.group(1)), fnum(qs, "freq"), fnum(qs, "tol_khz", 12.5), fnum(qs, "lat"), fnum(qs, "lon")))
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
                rows = [dict(r) for r in cc.execute("SELECT source, layer, COUNT(*) n, MAX(fetched_at) fetched FROM ext_point GROUP BY source, layer")
                        if build.allowed(r["source"])]  # personal-only sources stay out of a team login's list
                fetches = [dict(r) for r in cc.execute("SELECT * FROM ext_fetch ORDER BY id DESC LIMIT 20") if build.allowed(r["source"])]
                cc.close()
                return self.send(200, {"layers": rows, "fetches": fetches})
            if p == "/api/settings":
                creds = get_setting("creds", {}) or {}
                return self.send(200, {"creds": {k: ("•••• set" if v else "") for k, v in creds.items()},
                                       "states": get_setting("update.states", ""), "bdc_states": get_setting("bdc.states", "")})
            if p == "/api/build":  # personal or sold, what the sold build leaves out and why, and the data notices
                return self.send(200, build.info())
            if p in ("/api/crowd/pull/queue", "/api/crowd/pull/status"):  # the PC fetcher's work list, and how it stands (crowdpull.py)
                import crowdpull
                cc = connectors.open_db(CROWD_PATH)
                try:
                    return self.send(200, {"queue": crowdpull.pending(cc)} if p.endswith("/queue") else crowdpull.status(cc))
                finally:
                    cc.close()
            if p == "/api/update/status":
                UPD.refresh_net_if_stale()  # the page polls this every 15 s
                return self.send(200, UPD.snapshot())
            if p == "/api/update/rules":  # the FCC rules watch (fccrules.py, Cody 11/8): the DAS dockets' filings of the last 30 days
                import fccrules
                dc = db()
                try:
                    return self.send(200, fccrules.recent(dc))
                finally:
                    dc.close()
            if p == "/api/update/desk":  # the Data desk (desk.py, Cody 11/8): each source watched, and what needs a person
                import desk
                dc = db()
                try:
                    return self.send(200, desk.view(dc, UPD.snapshot()))
                finally:
                    dc.close()
            if p == "/api/fieldpacks":
                return self.send(200, {"folder": fieldpack.PACK_DIR, "phone_url": PHONE_URL,
                                       "packs": fieldpack.list_packs(), "job": FP_JOB})
            if p == "/api/fieldpacks/file":  # one pack to download: on the server there's no Drive folder to load it from (11/3)
                name = qs.get("name", [""])[0]
                if name not in {x["file"] for x in fieldpack.list_packs()}:  # only a listed pack: never a path
                    raise LookupError("No field pack by that name.")
                with open(os.path.join(fieldpack.PACK_DIR, name), "rb") as fh:
                    data = fh.read()
                return self.send(200, data, "application/octet-stream",
                                 {"Content-Disposition": f"attachment; filename=\"{name.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(name)}"})
            if p == "/api/sigid":
                return self.send(200, {"library": {k: {"family": v[0], "bw": v[1], "url": sigid.sigid_url(k), "color": v[3]}
                                                   for k, v in sigid.LIBRARY.items()},
                                       "bandplan": [{"lo": b[0], "hi": b[1], "label": b[2], "types": b[3]} for b in sigid.BAND_PLAN]})
            return self.send(404, {"error": "not found"})
        except LookupError as e:
            return self.send(404, {"error": str(e)})
        except sqlite3.OperationalError as e:
            if "locked" in str(e):  # the FCC refresh is writing: say so, and that nothing was saved
                return self.send(503, {"error": "DAStastic is refreshing its FCC data and couldn't do this just now. Nothing was changed: try again in a few minutes."})
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})

    def tile(self, src, z, x, y):
        """Map tiles. USGS and Census tiles (public domain) are kept on disk as you view them (no bulk prefetch),
        so areas you've looked at keep working with no signal. OpenStreetMap's tile policy ("Offline use is not
        permitted") and Esri's World Imagery licence don't allow that, so theirs pass through with the source's own
        caching headers and are never kept here; with no signal the map shows USGS Topo (core.js)."""
        url = TILE_SOURCES.get(src)
        if not url:
            return self.send(404, {"error": "unknown tile source"})
        if src in ONLINE_ONLY:
            try:
                req = urllib.request.Request(tile_url(url, int(z), int(x), int(y)), headers={"User-Agent": TILE_UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    data, cc = r.read(), r.headers.get("Cache-Control") or "max-age=86400"
                if tile_type(data) == "application/octet-stream":
                    return self.send(404, b"", "image/png")
                return self.send(200, data, tile_type(data), {"Cache-Control": cc})
            except Exception:
                return self.send(404, b"", "image/png")
        fp = os.path.join(TILE_DIR, src, z, x, f"{y}.png")
        if os.path.exists(fp):
            with open(fp, "rb") as fh:
                data = fh.read()
            return self.send(200, data, tile_type(data), {"Cache-Control": "max-age=604800"})
        try:
            req = urllib.request.Request(tile_url(url, int(z), int(x), int(y)), headers={"User-Agent": TILE_UA})
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
        try:
            return self.post_route()
        finally:  # a handler that ignores what was sent (delete, run) must still read it: left on a kept-alive connection,
            self.raw_body()  # it garbles the next request (11/2: a second DAS delete in a row came back 501)

    def post_route(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        p = u.path
        try:
            if p.startswith(("/api/das/", "/api/mail/")):  # mail lives beside the DAS jobs it files into
                return self.das_route("POST", p, qs)
            if p == "/api/markup" or p.startswith("/api/markup/"):  # drawings on the maps (markup.py)
                return self.markup_route("POST", p, qs)
            if p == "/api/intake" or p.startswith("/api/intake/"):  # the one drop spot (intake.py)
                return self.intake_route("POST", p, qs)
            if p == "/api/notes" or p.startswith("/api/notes/"):
                return self.notes_route("POST", p, qs)
            if p == "/api/phone" or p.startswith("/api/phone/"):  # the Phone window (phone.py)
                return self.phone_route("POST", p, qs)
            if p in EXTRA_ROUTES:
                return self.extra_route("POST", p, qs)
            if p == "/api/kit/update":  # a newer install-kit zip: its files over this copy's, then the launcher restarts us
                done = kitupdate.apply(self.raw_body())
                self.send(200, done)
                kitupdate.restart()
                return
            if p == remote.COURSE_SAVE:
                return self.course_route("POST", p)
            if p == "/api/remote/course":  # tick or untick an account for the DAS course
                d = self.body_json()
                try:
                    remote.set_course(d.get("name"), d.get("on"))
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
                return self.course_people()
            if p == "/api/remote/add":  # a new person (or a new password): shown once, for Cody to pass on
                d = self.body_json()
                try:  # "ends": a last day for a temporary login (item 9); absent keeps what they had
                    pw = remote.add(d.get("name"), d.get("role") or None, d.get("ends") if "ends" in d else None)
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
                return self.send(200, {"name": (d.get("name") or "").strip(), "password": pw, "people": remote.users()})
            if p == "/api/remote/google":  # link a login to a Google address for Sign in with Google ("" unlinks; remote.set_google)
                d = self.body_json()
                try:
                    remote.set_google(d.get("name"), d.get("email") or "")
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
                return self.send(200, {"people": remote.users(), "google_on": remote.google_on()})
            if p == "/api/remote/ends":  # a login's last day: a date, "" for none, or "now" to end it today (remote.set_ends)
                d = self.body_json()
                try:
                    remote.set_ends(d.get("name"), d.get("ends") or "")
                except ValueError as e:
                    return self.send(400, {"error": str(e)})
                return self.send(200, {"people": remote.users()})
            if p == "/api/remote/role":  # view, full or admin (the server's logins)
                d = self.body_json()
                remote.set_role(d.get("name"), d.get("role"))
                return self.send(200, {"people": remote.users()})
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
                    import markup
                    markup.drop_scope(con, "mission", mid)  # its drawings on the maps
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
                rx = {k: fstr(qs, k) for k in ("receiver", "calibrated", "cal_date") if fstr(qs, k)}
                summary = captures.store(con, int(mid) if mid is not None else None, fstr(qs, "name") or fname, fmt, pts, trk,
                                         settings, lookup, extra_track=track, fixed_point=fixed, receiver=rx or None)
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
            m = re.match(r"^/api/captures/(\d+)/receiver$", p)  # what took it: model, calibrated, calibration date
            if m:
                d = self.body_json()
                con = db()
                captures.set_receiver(con, int(m.group(1)), d.get("receiver"), d.get("calibrated"), d.get("cal_date"))
                con.close()
                return self.send(200, {"ok": True})
            m = re.match(r"^/api/captures/(\d+)/delete$", p)
            if m:
                cid = int(m.group(1))
                con = db()
                for t, col in (("capture_point", "capture_id"), ("track_point", "capture_id"), ("capture", "id")):
                    con.execute(f"DELETE FROM {t} WHERE {col}=?", (cid,))
                con.commit(); con.close()
                return self.send(200, {"ok": True})
            if p == "/api/crowd/pull/result":  # what the PC fetcher brings back (crowdpull.py): stored here, kept nowhere else
                import crowdpull
                d = self.body_json()
                cc = connectors.open_db(CROWD_PATH)
                try:
                    if d.get("error") and d.get("id") is not None:
                        crowdpull.failed(cc, d["id"], d["error"])
                        return self.send(200, {"ok": True, "rows": 0})
                    n = crowdpull.accept(cc, d.get("id"), d.get("source", ""), d.get("rows") or [], d.get("lat"), d.get("lon"),
                                         d.get("radius_mi"), d.get("message") or "ok")
                    return self.send(200, {"ok": True, "rows": n})
                except ValueError as e:  # rows that aren't crowd points, or no area: the PC's mistake, said back to it
                    return self.send(400, {"error": str(e)})
                finally:
                    cc.close()
            if p == "/api/crowd/fetch":
                d = self.body_json()
                creds = get_setting("creds", {}) or {}
                cc = connectors.open_db(CROWD_PATH)
                src, la, lo, rad = d["source"], float(d["lat"]), float(d["lon"]), float(d.get("radius", 5))
                if not build.allowed(src):
                    cc.close()
                    return self.send(403, {"error": "Not in this build: " + build.PERSONAL_ONLY[src]})
                if src == "wigle":
                    kinds = tuple(d.get("kinds") or ("network", "bluetooth", "cell"))
                    try:
                        n = connectors.fetch_wigle(cc, la, lo, rad, creds.get("wigle_name", ""), creds.get("wigle_token", ""), kinds=kinds)
                    except Exception as e:  # WiGLE refuses the server's address (11/7): the PC fetcher brings it (crowdpull.py)
                        import crowdpull
                        if not crowdpull.refused(e):
                            raise
                        crowdpull.enqueue(cc, "wigle", la, lo, rad, kinds, getattr(remote.ON, "login", None) or "")
                        waiting = crowdpull.status(cc)["waiting"]
                        cc.close()
                        return self.send(200, {"ok": True, "rows": 0, "queued": True, "message": crowdpull.queued_message(waiting)})
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
                if "archive" in d:  # keep each week's FCC files in fcc-archive/ (uls_import.archive)
                    set_setting("update.archive", bool(d["archive"]))
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
            if p == "/api/update/stop":  # Stop all downloads (Data & updates)
                return self.send(200, {"stopping": UPD.stop_all(), **UPD.snapshot()})
            if p == "/api/update/resume":
                UPD.resume_all()
                return self.send(200, UPD.snapshot())
            mt = re.match(r"^/api/update/desk/task/(\d+)$", p)
            if mt:  # Done (the desk re-tests the source, and closes it only when the source answers) or Won't do (it stands)
                import desk
                from datadesk import persons
                d, dc = self.body_json(), db()
                try:
                    persons.ensure(dc)
                    who = getattr(remote.ON, "login", None) or "Cody"
                    if d.get("action") == "done":
                        persons.mark_done(dc, int(mt.group(1)), who)
                        t = dc.execute("SELECT * FROM desk_task WHERE id=?", (int(mt.group(1)),)).fetchone()
                        ups = [u for s in desk.sources() if s["id"] == (t["source_id"] if t else None) for u in s["updater"]]
                        if ups:  # try the source again now, so the re-test doesn't wait for its next turn
                            UPD.run_sources(ups, force=True)
                    elif d.get("action") == "wontdo":
                        persons.wont_do(dc, int(mt.group(1)), who, (d.get("why") or "")[:300] or "marked won't do")
                    else:
                        raise ValueError("Say done or wontdo.")
                    return self.send(200, desk.view(dc, UPD.snapshot()))
                finally:
                    dc.close()
            if p == "/api/update/run":
                d = self.body_json()
                ids = d.get("ids")
                if ids == "enabled":
                    ids = [sid for sid, c in UPD.config().items() if c["enabled"]]
                elif ids == "all":  # Update all: every source, whether it's selected or not
                    ids = list(UPD.config())
                skipped = []
                if d.get("ids") == "all" or d.get("skip_no_key"):  # a run of many leaves out the ones whose key isn't saved
                    acc = {sid: s.get("access") or {} for sid, s in UPD.snapshot()["sources"].items()}
                    skipped = [i for i in ids or [] if acc.get(i, {}).get("needs_key") and not acc[i].get("key_saved")]
                    ids = [i for i in ids if i not in skipped]
                started = UPD.run_sources(ids or [], force=bool(d.get("force")))
                return self.send(200, {"started": started, "skipped": skipped, **UPD.snapshot()})
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
        except sqlite3.OperationalError as e:
            if "locked" in str(e):  # the FCC refresh is writing: say so, and that nothing was saved
                return self.send(503, {"error": "DAStastic is refreshing its FCC data and couldn't do this just now. Nothing was changed: try again in a few minutes."})
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})


PASSWORD_PATH = "/remote/password"  # a signed-in person's own new password (RemoteH.answer)


class RemoteH(H):
    """The remote door (remote.py): Tailscale Funnel forwards the public link to this port. Everyone here is signed
    in and can view and search only; the same routes answer, minus anything that writes or stays on Cody's PC."""

    def send(self, code, body, ctype="application/json", extra=None):
        if ctype.startswith("text/html") and urlparse(self.path).path in ("/", "/index.html") and isinstance(body, (bytes, str)):
            raw = body.encode() if isinstance(body, str) else body  # the app's page installs as an app (remote.APP_HEAD)
            if b"</head>" in raw and b"manifest.webmanifest" not in raw:
                body = raw.replace(b"</head>", remote.APP_HEAD.encode() + b"</head>", 1)
        # same-origin, not no-referrer (11/10): nothing goes to other sites either way, but under no-referrer a browser sends
        # a plain form's post with Origin "null", so the sign-in form failed from_here on a framed copy (Andy, 11/9)
        hdrs = dict({"X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
                     "Referrer-Policy": "same-origin", "Cache-Control": "no-store"}
                    if ctype.startswith(("application/json", "text/html")) else
                    {"X-Content-Type-Options": "nosniff"}, **(extra or {}))
        anc = remote.frame_ancestors() if ctype.startswith("text/html") else []
        if anc:  # shown inside DaDougieDash (remote.FRAME_FILE): those pages may frame it, and no other
            fa = "frame-ancestors 'self' " + " ".join(anc)
            csp = hdrs.get("Content-Security-Policy")
            hdrs["Content-Security-Policy"] = csp if csp and "frame-ancestors" in csp else (f"{csp}; {fa}" if csp else fa)
        return super().send(code, body, ctype, hdrs)

    def secure(self):  # the public link is https; a test on this PC is plain http
        return not (self.headers.get("Host") or "").startswith(("127.0.0.1", "localhost"))

    def from_here(self, method):
        """On a copy shown in a frame (remote.frame_ancestors), whether a request may go on. Its second login cookie is
        SameSite=None, so this is what stops another site's request from riding it (security review 11/9):
          - from another site (Sec-Fetch-Site cross-site or same-site): only a page load, a GET or HEAD with Sec-Fetch-Mode
            navigate (the dash opening it in its frame, a link, Google's return). Never a fetch, an image, a script or a
            form post: on 127.0.0.1 every port shares the dash's cookie partition, so a page on any of them could otherwise
            send this copy signed-in reads;
          - a change (not a GET or HEAD) must carry this copy's own Origin. With no Origin it goes on only with no
            Sec-Fetch-Site either: not a browser (the PC fetcher, a script). Every browser on https sends one, so an Origin
            taken off on the way can't let another site's form through;
          - Origin "null" goes on only from this copy's own page by the browser's word (Sec-Fetch-Site same-origin). That's
            a plain form's post from a page under Referrer-Policy no-referrer, as every page here was until 11/10: the sign-in
            form, refused here on Andy's copy on 11/9. A page can't set Sec-Fetch-Site, and a walled-off page (a stored file,
            an opaque origin) is cross-site to the browser, so "null" from anywhere else is still refused.
        On every other copy it's always true: nothing changes."""
        if not remote.frame_ancestors():
            return True
        site = self.headers.get("Sec-Fetch-Site")
        if site in ("cross-site", "same-site"):
            return method in ("GET", "HEAD") and self.headers.get("Sec-Fetch-Mode") == "navigate"
        if method in ("GET", "HEAD"):
            return True
        origin = self.headers.get("Origin")
        if origin == "null":
            return site == "same-origin"
        if origin is not None:
            return origin == ("https://" if self.secure() else "http://") + (self.headers.get("Host") or "")
        return site is None

    def google_button(self):
        """Sign in with Google shows when it's set up here, and not in DAStastic for Android: Google refuses sign-in inside an
        app's own web view (its user agent carries RFReconAndroid)."""
        return remote.google_on() and "RFReconAndroid" not in (self.headers.get("User-Agent") or "")

    def state_cookie(self, value, clear=False):
        # Lax, so it comes back on Google's top-level redirect to the callback; 10 minutes, only for the sign-in paths
        return (f"{remote.STATE_COOKIE}={'' if clear else value}; Path=/remote/google; HttpOnly; SameSite=Lax; "
                f"Max-Age={0 if clear else remote.STATE_S}" + ("; Secure" if self.secure() else ""))

    def answer(self, method, handler):
        p = urlparse(self.path).path
        remote.ON.user = None
        remote.ON.login = None
        if not self.from_here(method):  # another site's request, on a copy shown in a frame: refused before anything is read
            self.raw_body()
            return self.send(403, {"error": "Changes come only from DAStastic's own pages."})
        user = remote.user_of(self.headers.get("Cookie"))
        role = remote.role_of(user) if user else None
        # what the handler itself reads: a note's words and files (anyone signed in), and every change by a full or admin login
        keep = bool(user) and remote.reads_body(method, p, role) or remote.note_write(method, p) and role != "ahj" \
            or bool(user) and method == "POST" and p == PASSWORD_PATH  # your own new password: read below, signed in only
        if method != "GET" and p != "/remote/login" and not keep:
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
                    return self.send(401, remote.login_page(str(e), name, self.google_button()), "text/html; charset=utf-8")
                return self.send(303, b"", "text/plain", {"Location": "/", "Set-Cookie": remote.cookie(tok, self.secure())})
            return self.send(200, remote.login_page("", "", self.google_button()), "text/html; charset=utf-8")
        if p == "/remote/google" and method == "GET":  # Sign in with Google (item 8): off to Google, with a state cookie to come back to
            try:
                url, state = remote.google_start()
            except ValueError as e:
                return self.send(404, remote.login_page(str(e)), "text/html; charset=utf-8")
            return self.send(302, b"", "text/plain", {"Location": url, "Set-Cookie": self.state_cookie(state)})
        if p == "/remote/google/callback" and method == "GET":  # Google's answer: the linked login's session, or why not
            q = parse_qs(urlparse(self.path).query)
            if q.get("error"):
                return self.send(401, remote.login_page("Google sign-in was cancelled.", "", self.google_button()), "text/html; charset=utf-8")
            m = re.search(rf"(?:^|;\s*){remote.STATE_COOKIE}=([^;]+)", self.headers.get("Cookie") or "")
            try:
                tok = remote.google_finish((q.get("code") or [""])[0], (q.get("state") or [""])[0], m.group(1) if m else "")
            except ValueError as e:
                return self.send(401, remote.login_page(str(e), "", self.google_button()), "text/html; charset=utf-8",
                                 {"Set-Cookie": self.state_cookie("", clear=True)})
            return self.send(303, b"", "text/plain", {"Location": "/", "Set-Cookie": remote.cookie(tok, self.secure())})
        if p == "/login" and method == "GET":  # the business's website links its Employee login here (licence.py)
            return self.send(303, b"", "text/plain", {"Location": "/" if user else "/remote/login"})
        if p == "/remote/logout":
            return self.send(303, b"", "text/plain", {"Location": "/remote/login", "Set-Cookie": remote.cookie("", self.secure(), clear=True)})
        if p == "/sw.js":
            return self.send(200, remote.SW_JS, "text/javascript", {"Service-Worker-Allowed": "/"})
        # the sign-in page's look, and DAStastic for Android (Help › Android app): a phone fetches it before it signs in
        if p.startswith(("/static/theme/", "/static/app/", "/static/android/")) or p == "/favicon.ico":
            return handler()
        if p.startswith("/share/") and method == "GET":  # a read-only share link: 404 unless share links are on (dashist.py)
            return handler()
        if p == "/verify" and method == "GET" and das.public_verify_on(get_setting):  # signed out, only when switched on (das.py)
            return handler()
        if not user:
            self.close_connection = keep  # a refused note's body is never read
            if method == "GET" and p in ("/", "/index.html", "/course"):
                return self.send(303, b"", "text/plain", {"Location": "/remote/login"})
            return self.send(401, {"error": "Signed out: reload the page to sign in again."})
        if p == "/api/me":
            return self.send(200, {"remote": True, "user": user, "role": role, "server": bool(remote.SERVER_URL), "course": remote.has_course(user),
                                   "licence": licence.public(uls_import.DATA_DIR), "phone": phone_ready(role)})
        if p == PASSWORD_PATH:  # change your own password (remote.change_password): your other sessions end, this one carries on
            if method != "POST" or role == "fetcher":  # the PC fetcher's password is sealed on the PC: a new one is made with --setup
                return self.send(405 if method != "POST" else 403, {"error": "Not here."})
            try:
                d = json.loads(self.raw_body() or b"{}")
                tok = remote.change_password(user, d.get("current"), d.get("new"))
            except (ValueError, LookupError) as e:
                return self.send(400, {"error": str(e)})
            return self.send(200, {"ok": True}, "application/json", {"Set-Cookie": remote.cookie(tok, self.secure())})
        if role == "ahj" and p in ("/", "/index.html"):  # an AHJ reviewer's DAStastic is the review page
            return self.send(303, b"", "text/plain", {"Location": "/review"})
        if p in remote.EMPTY and role != "admin":
            return self.send(200, remote.EMPTY[p])
        why = remote.refused(method, p, role)
        if why:
            return self.send(403, {"error": why})
        remote.ON.user = None if role == "admin" else user  # an admin is the owner: the parts held back from remote people work
        remote.ON.login = user  # who is signed in, admin included: each login's own mailbox (dasmail)
        try:
            return handler()
        finally:
            remote.ON.user = None
            remote.ON.login = None

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
    if os.environ.get("RF_RECON_NO_WARM") != "1":  # the first DAS Prospects list after a start is fast (warm_prospects)
        threading.Thread(target=warm_prospects, daemon=True).start()
    host ="0.0.0.0" if a.lan else "127.0.0.1"
    rport = a.remote_port if a.remote_port is not None else (remote.PORT if a.port == 8765 else 0)
    if rport:  # the live copy opens the remote door; a test server only when asked (--remote-port)
        serve_remote(rport)
    print(f"DAStastic running at http://localhost:{a.port}  (Ctrl+C to stop)")
    ThreadingHTTPServer((host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
