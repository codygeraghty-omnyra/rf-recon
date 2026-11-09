"""Proposed towers (Cody 11/8): structures on their way, before they're in the tower registrations, from two of the
FCC's daily tower files (read beside the registrations by ulsdaily.py):
- a_tow_<day>.zip: antenna structure applications. A proposed tower is an application to register a new or replacement
  structure (purpose NE, RE) that is pending or granted but not yet built, or a modification (MD) still pending. Any
  other status (constructed, dismissed, withdrawn, returned, canceled, terminated, dismantled...) takes it off.
- d_tow_<day>.zip: the FAA's determinations on proposed structures (the FAA study), the earliest sign of a new tower;
  kept until their expiry date.
Field positions and codes are the FCC's own (Tower Public Access file definitions: asr_sql_table_definitions and
pubacc_asr_codes_data_elem, which Cody downloaded 11/8). Only what a DAS team uses is kept: where, how high, what kind
of structure, who applied (the owner's name as the FCC publishes it), the dates and the FAA study; no phone or email.
"""
import os
import re
import sqlite3
import time
import zipfile

import towers

PURPOSE = {"NE": "new structure", "RE": "replacement structure", "MD": "modification", "AM": "amendment",
           "CA": "cancellation", "DI": "dismantlement", "NT": "built (notice)", "OC": "ownership change", "AU": "administrative update",
           "DU": "duplicate", "WD": "withdrawal"}
STATUS = {"P": "pending", "G": "granted, not built", "C": "constructed", "D": "dismissed", "W": "withdrawn", "R": "returned",
          "A": "canceled", "T": "terminated", "I": "dismantled", "N": "inactive", "O": "owner removed"}
PROPOSED = {("NE", "P"), ("NE", "G"), ("RE", "P"), ("RE", "G"), ("MD", "P")}
APP_COLS = ("file_number", "reg", "purpose", "status", "received", "action", "lat", "lon", "state", "city", "county_fips",
            "struct_type", "height_m", "agl_m", "amsl_m", "faa_study", "applicant", "src", "asof")
FAA_COLS = ("study", "lat", "lon", "ground_m", "agl_m", "amsl_m", "issued", "expires", "final", "city", "state", "sponsor", "src", "asof")
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS tower_app({", ".join(APP_COLS)}, PRIMARY KEY(file_number));
CREATE INDEX IF NOT EXISTS tower_app_latlon ON tower_app(lat, lon);
CREATE TABLE IF NOT EXISTS faa_study({", ".join(FAA_COLS)}, PRIMARY KEY(study));
CREATE INDEX IF NOT EXISTS faa_study_latlon ON faa_study(lat, lon);
"""


def ensure(con):
    con.executescript(SCHEMA)


def _f(f, i):
    return f[i].strip() if i < len(f) else ""


def _date(s):
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", s or "")
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else ""


def _empty(z):
    return all(os.path.basename(i.filename).lower() == "counts" or i.file_size == 0 for i in z.infolist())


def parse_apps(path, states):
    """(every application's file number in the file, the proposed ones' rows (APP_COLS minus src, asof) within states)."""
    states = {s.upper() for s in states}
    seen, rows = set(), []
    with zipfile.ZipFile(path) as z:
        if _empty(z):
            return seen, rows
        coords, owners = {}, {}
        for f in towers.records(z, "CO.DAT", "CO"):
            fn = _f(f, 2)
            if fn and fn not in coords:
                c = towers.find_coords(f)
                if c:
                    coords[fn] = c
        for f in towers.records(z, "EN.DAT", "EN"):  # EN 5: contact type (O owner), 9: entity name, 10/12: an individual's names
            fn = _f(f, 2)
            if fn and fn not in owners and _f(f, 5) in ("O", ""):
                owners[fn] = _f(f, 9) or " ".join(x for x in (_f(f, 10), _f(f, 12)) if x)
        for f in towers.records(z, "RA.DAT", "RA"):  # TOWER_PUBACC_RA, the FCC's field order
            fn = _f(f, 2)
            if not fn:
                continue
            seen.add(fn)
            purpose, status, state = _f(f, 5), _f(f, 8), _f(f, 25).upper()
            if (purpose, status) not in PROPOSED or (states and state not in states) or fn not in coords:
                continue
            lat, lon = coords[fn]
            rows.append((fn, _f(f, 3), purpose, status, _date(_f(f, 10)), _date(_f(f, 14)), lat, lon, state, _f(f, 24),
                         _f(f, 26), _f(f, 32), towers.num(_f(f, 28)), towers.num(_f(f, 30)), towers.num(_f(f, 31)), _f(f, 34),
                         owners.get(fn)))
    return seen, rows


def _dms(f):
    lat_d, lat_m, lat_s, lon_d, lon_m, lon_s = (towers.num(_f(f, i)) for i in (3, 4, 5, 8, 9, 10))
    if lat_d is None or lon_d is None:
        return None
    lat = lat_d + (lat_m or 0) / 60 + (lat_s or 0) / 3600
    lon = lon_d + (lon_m or 0) / 60 + (lon_s or 0) / 3600
    return (round(-lat if _f(f, 6) == "S" else lat, 6), round(-lon if _f(f, 11) == "W" else lon, 6))


def parse_faa(path, states):
    """The FAA determinations in a d_tow file within states: rows (FAA_COLS minus src, asof)."""
    states = {s.upper() for s in states}
    rows = []
    with zipfile.ZipFile(path) as z:
        if _empty(z):
            return rows
        for f in towers.records(z, "DE.DAT", "DE"):  # TOWER_PUBACC_DE, the FCC's field order
            study, state = _f(f, 1), _f(f, 22).upper()
            if not study or (states and state not in states):
                continue
            c = _dms(f)  # DE 3-6 latitude degrees, minutes, seconds, N/S; 8-11 longitude, E/W
            if not c:
                continue
            sponsor = _f(f, 23) or " ".join(x for x in (_f(f, 24), _f(f, 26)) if x)
            rows.append((study, c[0], c[1], towers.num(_f(f, 13)), towers.num(_f(f, 14)), towers.num(_f(f, 15)),
                         _date(_f(f, 16)), _date(_f(f, 18)), _date(_f(f, 20)), _f(f, 21), state, sponsor))
    return rows


def apply(con, kind, path, states, asof, log=print):
    """One a_tow (kind "apps") or d_tow (kind "faa") file into its table, in the caller's transaction. Returns counts."""
    ensure(con)
    src = os.path.basename(path)
    if kind == "apps":
        seen, rows = parse_apps(path, states)
        fl = sorted(seen)
        out = 0
        for i in range(0, len(fl), 500):  # every application in the file leaves; the proposed ones come back
            ch = fl[i:i + 500]
            out += con.execute(f"DELETE FROM main.tower_app WHERE file_number IN ({','.join('?' * len(ch))})", ch).rowcount
        con.executemany(f"INSERT OR REPLACE INTO main.tower_app VALUES({','.join('?' * len(APP_COLS))})", [r + (src, asof) for r in rows])
        log(f"{src}: {len(seen):,} tower applications, {len(rows):,} proposed here")
        return {"file": src, "items": len(seen), "kept": len(rows), "gone": out}
    rows = parse_faa(path, states)
    con.executemany(f"INSERT OR REPLACE INTO main.faa_study VALUES({','.join('?' * len(FAA_COLS))})", [r + (src, asof) for r in rows])
    log(f"{src}: {len(rows):,} FAA determinations here")
    return {"file": src, "items": len(rows), "kept": len(rows), "gone": 0}


def proposed(con, area_sql="1", args=(), today=None, limit=2000):
    """Proposed towers and FAA studies in an area: [{"kind", "label", "lat", "lon", ...}], nearest checks left to the caller."""
    today = today or time.strftime("%Y-%m-%d")
    out = []
    try:
        for r in con.execute(f"SELECT {','.join(APP_COLS)} FROM tower_app WHERE {area_sql} LIMIT ?", list(args) + [limit]):
            d = dict(zip(APP_COLS, r))
            d.update(kind="application", purpose_text=PURPOSE.get(d["purpose"], d["purpose"]), status_text=STATUS.get(d["status"], d["status"]))
            out.append(d)
        for r in con.execute(f"SELECT {','.join(FAA_COLS)} FROM faa_study WHERE ({area_sql}) AND (expires = '' OR expires >= ?) LIMIT ?",
                             list(args) + [today, limit]):
            d = dict(zip(FAA_COLS, r))
            d.update(kind="faa")
            out.append(d)
    except sqlite3.Error:
        return []
    return out
