#!/usr/bin/env python3
"""
Download FCC ULS weekly license files and build a local SQLite database
for frequency lookups and RF site-survey planning.

Usage:
    python uls_import.py                      # default services, whole US
    python uls_import.py --states VA,MD,DC    # keep only these states
    python uls_import.py --services LMpriv,micro
    python uls_import.py --zip path/to/l_LMpriv.zip   # use files you downloaded

Only Python 3.9+ standard library is needed.

Field positions follow the FCC "Public Access Database Definitions"
(HD, EN, LO, AN, FR, EM records). Positions below are 0-based.
"""
import dlstop  # Stop all downloads
import argparse
import io
import math
import os
import re
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.request
import zipfile

import ulscontacts

BASE_URL = "https://data.fcc.gov/download/pub/uls/complete/l_{}.zip"
NO_ASR = ("", "N/A", "NA", "NONE")  # what filers type for "no registered tower". The build's SQL below lists the same values


def asr_number(v):
    """An FCC antenna structure number, or None for a placeholder. About 773,000 licence rows hold one, and code that took
    "N/A" for a number put them all on one tower."""
    v = (v or "").strip()
    return None if v.upper() in NO_ASR else v

DEFAULT_SERVICES = ["LMpriv", "LMcomm", "LMbcast", "paging", "coast"]
OPTIONAL_SERVICES = ["micro", "cell", "market"]
HERE = os.path.dirname(os.path.abspath(__file__))
# Downloads, databases and map tiles. RF_RECON_DATA keeps them off a synced folder (e.g. Google Drive).
DATA_DIR = os.environ.get("RF_RECON_DATA") or os.path.join(HERE, "data")
DB_PATH = os.environ.get("ULS_DB") or os.path.join(DATA_DIR, "uls.db")

# ---------------------------------------------------------------- reference

SERVICE_NAMES = {
    # Public safety
    "PW": "Public Safety Pool, Conventional", "YW": "Public Safety Pool, Trunked",
    "SG": "Public Safety 700 MHz, Conventional", "SY": "Public Safety 700 MHz, Trunked",
    "SL": "Public Safety 700 MHz, State License", "SP": "700 MHz PS Broadband (Nationwide)",
    "GE": "Public Safety 806-817/851-862 MHz, Conv.", "YE": "Public Safety 806-817/851-862 MHz, Trunked",
    "GF": "Public Safety NPSPAC 821-824/866-869, Conv.", "YF": "Public Safety NPSPAC 821-824/866-869, Trunked",
    "GP": "Public Safety/Spec Emerg 800 MHz, Conv.", "YP": "Public Safety/Spec Emerg 800 MHz, Trunked",
    "PA": "Public Safety 4.9 GHz", "QM": "Public Safety/Mutual Aid 220 MHz",
    "IQ": "Intelligent Transportation (Public Safety)", "MW": "Microwave Public Safety Pool",
    # Industrial / business
    "IG": "Industrial/Business Pool, Conventional", "YG": "Industrial/Business Pool, Trunked",
    "IK": "Industrial/Business Pool, Commercial, Conv.", "YK": "Industrial/Business Pool, Commercial, Trunked",
    "GB": "Business 800 MHz, Conv.", "YB": "Business 800 MHz, Trunked",
    "GJ": "Bus/Ind/Land Trans 809-824/854-869, Conv.", "YJ": "Bus/Ind/Land Trans 809-824/854-869, Trunked",
    "GO": "Other Ind/Land Trans 800 MHz, Conv.", "YO": "Other Ind/Land Trans 800 MHz, Trunked",
    "GU": "Business 900 MHz, Conv.", "YU": "Business 900 MHz, Trunked",
    "GI": "Other Ind/Land Trans 900 MHz, Conv.", "YI": "Other Ind/Land Trans 900 MHz, Trunked",
    "QQ": "Intelligent Transportation (Non-PS)", "RS": "Land Mobile Radiolocation", "ZV": "218-219 MHz",
    # Broadcast auxiliary
    "RP": "Broadcast Aux Remote Pickup", "LP": "Broadcast Aux Low Power", "LV": "Low Power Wireless Assist Video",
    "AS": "Aural Studio Transmitter Link", "AI": "Aural Intercity Relay", "AB": "Aural Microwave Booster",
    "TS": "TV Studio Transmitter Link", "TI": "TV Intercity Relay", "TP": "TV Pickup",
    "TB": "TV Microwave Booster", "TT": "TV Translator Relay",
    # Paging / radiotelephone
    "CD": "Paging and Radiotelephone", "CZ": "Paging and Radiotelephone, Auctioned",
    "CP": "Part 22 VHF/UHF Paging", "GC": "929-931 MHz Paging, Auctioned", "CO": "Offshore Radiotelephone",
    "CR": "Rural Radiotelephone", "CA": "Commercial Air-Ground", "CG": "General Aviation Air-Ground",
    "CJ": "Commercial Aviation Air-Ground",
    # Microwave
    "CF": "Common Carrier Fixed P-P Microwave", "MG": "Microwave Industrial/Business Pool",
    "CT": "Local Television Transmission", "MS": "Multiple Address Service", "NN": "3650-3700 MHz",
    "WA": "Microwave Aviation", "WM": "Microwave Marine", "WR": "Microwave Radiolocation",
    "TN": "39 GHz", "TZ": "24 GHz", "UU": "UMFUS", "DV": "MVDDS", "LD": "LMDS",
    # Marine / aviation ground
    "MA": "Marine Auxiliary Group", "MC": "Coastal Group", "MK": "Alaska Group",
    "MR": "Marine Radiolocation Land", "PC": "Public Coast, Auctioned",
    "AA": "Aviation Auxiliary Group", "AF": "Aeronautical and Fixed", "AR": "Aviation Radionavigation",
}
PUBLIC_SAFETY_SERVICES = {"PW", "YW", "SG", "SY", "SL", "SP", "GE", "YE", "GF", "YF",
                          "GP", "YP", "PA", "QM", "IQ", "MW"}

BANDS = [  # (low MHz, high MHz, label)
    (0, 30, "HF"), (30, 50, "VHF Low"), (50, 54, "6m"), (54, 72, "VHF TV low"), (72, 76, "72-76 MHz"),
    (76, 108, "FM broadcast"), (108, 137, "Aviation VHF"), (137, 174, "VHF High"), (174, 216, "VHF TV/Aux"),
    (216, 225, "220 MHz"), (225, 400, "Gov UHF/Other"), (400, 470, "UHF"), (470, 512, "UHF T-Band"),
    (512, 698, "UHF TV/Aux"), (698, 806, "700 MHz"), (806, 896, "800 MHz"), (896, 960, "900 MHz"),
    (960, 2000, "L-band/1-2 GHz"), (2000, 6000, "2-6 GHz"), (6000, 1e9, "Microwave >6 GHz"),
]

CATEGORY_RULES = [  # checked in order against the licensee name; whole words, so FIREBIRD isn't fire and MARSHALL isn't police
    ("Law Enforcement", r"\b(POLICE|SHERIFFS?|STATE PATROL|HIGHWAY PATROL|MARSHALS?|CONSTABLES?|CORRECTIONS?|CORRECTIONAL|JAILS?|DETENTION|STATE POLICE|TROOPERS?)\b"),
    ("Fire / EMS", r"\b(FIRE|EMS|AMBULANCES?|RESCUE|EMERGENCY MEDICAL|PARAMEDICS?|VOLUNTEER FIRE|FPD|FIRE PROTECTION)\b"),
    ("Emergency Mgmt / 911", r"\b(911|E911|EMERGENCY MANAGEMENT|EMERGENCY COMMUNICATIONS?|DISPATCH|DISPATCHING|PSAP|HOMELAND)\b"),
    ("Hospital / Medical", r"\b(HOSPITALS?|MEDICAL CENTERS?|HEALTH SYSTEMS?|HEALTHCARE|CLINICS?)\b"),
    ("Schools", r"\b(SCHOOLS?|UNIVERSITY|UNIVERSITIES|COLLEGES?|ISD|USD|ACADEMY|ACADEMIES|BOARD OF EDUCATION)\b"),
    ("Utilities", r"\b(ELECTRIC|ELECTRICITY|POWER|ENERGY|UTILITY|UTILITIES|COOPERATIVE|CO-OP|WATER|SEWER|SANITATION|GAS CO|PIPELINES?|NATURAL GAS)\b"),
    ("Transportation", r"\b(RAILROADS?|RAILWAYS?|RAIL ROAD|TRANSIT|AIRPORTS?|AIRLINES?|AVIATION|TRUCKING|BUS LINES|PORT AUTHORITY|TOLL|TURNPIKE|DEPARTMENT OF TRANSPORTATION|DOT)\b"),
    ("Local / State Gov", r"\b(COUNTY|CITY OF|TOWN OF|VILLAGE OF|TOWNSHIP|BOROUGH|STATE OF|COMMONWEALTH|PARISH|MUNICIPAL|PUBLIC WORKS|DEPARTMENT OF)\b"),
    ("Broadcast / Media", r"\b(BROADCAST|BROADCASTING|RADIO|TELEVISION|TV|MEDIA|COMMUNICATIONS INC|NEWS)\b"),
]
_cat_rx = [(c, re.compile(p)) for c, p in CATEGORY_RULES]


def band_for(mhz):
    if mhz is None:
        return None
    for lo, hi, label in BANDS:
        if lo <= mhz < hi:
            return label
    return None


def category_for(name, service):
    if service == "CL":  # 800 MHz cellular: a carrier's site, whatever its licensee is called ("... County Cellular" isn't a government)
        return "Cellular"
    n = (name or "").upper()
    for cat, rx in _cat_rx:
        if rx.search(n):
            if cat in ("Local / State Gov", "Broadcast / Media") and service in PUBLIC_SAFETY_SERVICES:
                return "Public Safety (Gov)"
            return cat
    if service in PUBLIC_SAFETY_SERVICES:
        return "Public Safety (Other)"
    if service in ("RP", "LP", "LV", "AS", "AI", "AB", "TS", "TI", "TP", "TB", "TT"):
        return "Broadcast / Media"
    if service in ("CD", "CZ", "CP", "GC"):
        return "Paging"
    if service in ("MA", "MC", "MK", "MR", "PC", "WM"):
        return "Marine"
    if service in ("AA", "AF", "AR", "WA", "CA", "CG", "CJ"):
        return "Aviation"
    return "Business / Industrial"


# Well-known emission designator signatures -> technology (checked first)
SIGNATURES = [
    ("9K80D7W", "P25 Phase 2 (TDMA)"), ("9K80D7E", "P25 Phase 2 (TDMA)"),
    ("8K10F1E", "P25 Phase 1"), ("8K10F1D", "P25 Phase 1"), ("8K10F1W", "P25 Phase 1"),
    ("7K60FXE", "DMR (TDMA)"), ("7K60FXD", "DMR (TDMA)"), ("7K60FXW", "DMR (TDMA)"),
    ("7K60F7W", "DMR (TDMA)"), ("7K60F7E", "DMR (TDMA)"), ("7K60F7D", "DMR (TDMA)"),
    ("4K00F1E", "NXDN/dPMR 6.25 kHz"), ("4K00F1D", "NXDN/dPMR 6.25 kHz"), ("4K00F1W", "NXDN/dPMR 6.25 kHz"),
    ("4K00F7W", "NXDN/dPMR 6.25 kHz"),
    ("8K30F1E", "NXDN 12.5 kHz"), ("8K30F1D", "NXDN 12.5 kHz"), ("8K30F1W", "NXDN 12.5 kHz"),
    ("8K30F7W", "NXDN 12.5 kHz"),
    ("11K2F3E", "Analog FM 12.5 kHz"), ("11K0F3E", "Analog FM 12.5 kHz"), ("12K5F3E", "Analog FM 12.5 kHz"),
    ("16K0F3E", "Analog FM 25 kHz"), ("20K0F3E", "Analog FM 25 kHz"), ("15K0F3E", "Analog FM 25 kHz"),
    ("14K0F3E", "Analog FM 25 kHz"),
]

_bw_rx = re.compile(r"^(\d*)([HKMG])(\d*)")
_mult = {"H": 1e-3, "K": 1.0, "M": 1e3, "G": 1e6}


def parse_emission(code):
    """'11K2F3E' -> (11.2 kHz, 'Analog FM'). Mode is a best-guess label."""
    code = (code or "").strip().upper()
    if len(code) < 5:
        return None, None
    bw = None
    m = _bw_rx.match(code[:4])
    if m:
        try:
            bw = float(f"{m.group(1) or '0'}.{m.group(3) or '0'}") * _mult[m.group(2)]
        except ValueError:
            bw = None
    cls = code[4:7]
    for sig, label in SIGNATURES:
        if code.startswith(sig):
            return bw, label
    if cls in ("F3E", "F3F", "G3E"):
        mode = "Analog FM"
    elif cls in ("F1E", "F1D", "F1W", "G1E", "G1D", "G1W", "F7E", "F7W", "F7D"):
        mode = "Digital (P25/NXDN?)"
    elif cls in ("FXE", "FXD", "FXW", "GXE", "GXW", "DXW", "DXE"):
        mode = "Digital (DMR/TDMA?)"
    elif cls in ("F2D", "F1B", "F2B", "F1C", "F9W", "G7W", "D7W", "W7D", "D7D", "G7D", "F7B"):
        mode = "Data/Digital"
    elif cls.startswith("A3"):
        mode = "AM"
    elif cls.startswith("J3") or cls.startswith("R3"):
        mode = "SSB"
    elif cls.startswith("P0") or cls.startswith("Q0") or cls.startswith("N0"):
        mode = "Radar/Unmodulated"
    else:
        mode = "Other (" + cls + ")"
    return bw, mode


def norm_county(c):
    c = (c or "").strip().upper()
    c = re.sub(r"\s+(COUNTY|PARISH|BOROUGH|CENSUS AREA|MUNICIPALITY|CITY AND BOROUGH)$", "", c)
    return c or None


def norm_reg(s):
    s = (s or "").strip()
    return s.lstrip("0").zfill(7) if s.isdigit() else (s or None)


def to_float(s):
    try:
        s = (s or "").strip()
        return float(s) if s else None
    except ValueError:
        return None


def dms(deg, mins, secs, hemi):
    d, m, s = to_float(deg), to_float(mins), to_float(secs)
    if d is None:
        return None
    v = d + (m or 0) / 60 + (s or 0) / 3600
    if (hemi or "").strip().upper() in ("S", "W"):
        v = -v
    return round(v, 6)


# ---------------------------------------------------------------- schema

# The import's scratch copy of the FCC files: its own file beside the database (uls.db.import-scratch), attached as
# "scratch" while an import runs and deleted after (11/3). Inside uls.db, emptying them meant reading every page:
# 1 h 22 min of the server's 3 h 54 min rebuild on 11/2, with the main database's write lock held throughout.
RAW_TABLES = {
    "raw_license": "usi INTEGER PRIMARY KEY, call_sign TEXT, status TEXT, service TEXT, grant_date TEXT, expired_date TEXT, "
                   "licensee TEXT, src TEXT",
    "raw_location": "usi INTEGER, loc_num INTEGER, loc_type TEXT, loc_class TEXT, address TEXT, city TEXT, county TEXT, "
                    "state TEXT, radius_km REAL, area_code TEXT, ground_elev_m REAL, lat REAL, lon REAL, tower_reg TEXT, "
                    "PRIMARY KEY(usi, loc_num)",
    "raw_antenna": "usi INTEGER, loc_num INTEGER, ant_num INTEGER, height_tip_m REAL, height_raat_m REAL, haat_m REAL, "
                   "gain_dbi REAL, azimuth REAL, beamwidth REAL, polarization TEXT, make TEXT, model TEXT, max_erp REAL, "
                   "PRIMARY KEY(usi, loc_num, ant_num)",
    "raw_freq": "usi INTEGER, loc_num INTEGER, ant_num INTEGER, station_class TEXT, freq_mhz REAL, freq_upper_mhz REAL, "
                "power_out_w REAL, erp_w REAL, units INTEGER, freq_number INTEGER, tolerance TEXT, tx_make TEXT, tx_model TEXT",
    "raw_emission": "usi INTEGER, loc_num INTEGER, ant_num INTEGER, freq_mhz REAL, code TEXT, mod_rate TEXT, mod_type TEXT",
    "raw_path": "usi INTEGER, path_num INTEGER, tx_loc INTEGER, tx_ant INTEGER, rx_loc INTEGER, rx_ant INTEGER, "
                "path_type TEXT, passive TEXT, rx_call TEXT",
    "raw_contact": ulscontacts.RAW_COLS,  # EN licensee + contact: name, address, phone, email (consent letters, R1 #3)
}


def create_raw(con, schema="main"):
    for t, cols in RAW_TABLES.items():
        con.execute(f"CREATE TABLE IF NOT EXISTS {schema}.{t}({cols})")


def raw_schema(con):
    """Where the scratch tables are: "scratch" during an import, "main" in tests that build them by hand."""
    return "scratch" if any(r[1] == "scratch" for r in con.execute("PRAGMA database_list")) else "main"


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
-- Microwave links (backhaul): each licensed path with both ends placed, from the microwave file's PA records
CREATE TABLE IF NOT EXISTS mw_link(usi INTEGER, call_sign TEXT, licensee TEXT, service TEXT, path_num INTEGER,
    tx_lat REAL, tx_lon REAL, tx_city TEXT, tx_state TEXT, tx_reg TEXT, rx_lat REAL, rx_lon REAL, rx_city TEXT,
    rx_state TEXT, rx_reg TEXT, rx_call TEXT, dist_km REAL, freqs TEXT, path_type TEXT, passive TEXT);

-- Denormalized table the app reads. Rebuilt on every import.
CREATE TABLE IF NOT EXISTS tx(
    id INTEGER PRIMARY KEY, usi INTEGER, call_sign TEXT, service TEXT, service_name TEXT,
    licensee TEXT, category TEXT, grant_date TEXT, expired_date TEXT,
    loc_num INTEGER, address TEXT, city TEXT, county TEXT, state TEXT,
    lat REAL, lon REAL, ground_elev_m REAL, radius_km REAL, is_mobile INTEGER,
    ant_num INTEGER, height_tip_m REAL, haat_m REAL, gain_dbi REAL, azimuth REAL,
    station_class TEXT, freq_mhz REAL, freq_upper_mhz REAL, band TEXT,
    power_out_w REAL, erp_w REAL, units INTEGER, emissions TEXT, bandwidth_khz REAL, mode TEXT,
    tolerance TEXT, tx_make TEXT, tx_model TEXT, digital_mod TEXT,
    ant_make TEXT, ant_model TEXT, polarization TEXT, beamwidth REAL, height_raat_m REAL,
    status TEXT, tower_reg TEXT);
CREATE TABLE IF NOT EXISTS tx_history(hkey TEXT PRIMARY KEY, call_sign TEXT, freq_mhz REAL, lat REAL, lon REAL,
    licensee TEXT, service TEXT, mode TEXT, county TEXT, state TEXT, first_seen TEXT, last_seen TEXT);

-- Your own labels / RadioReference-style enrichment. Survives re-imports.
CREATE TABLE IF NOT EXISTS overlay(
    call_sign TEXT, freq_mhz REAL, county TEXT, state TEXT,
    alpha_tag TEXT, description TEXT, tone TEXT, tag TEXT, mode TEXT,
    verified INTEGER DEFAULT 0, notes TEXT, source TEXT, updated_at TEXT,
    PRIMARY KEY(call_sign, freq_mhz));

"""

TX_INDEXES = """
CREATE INDEX IF NOT EXISTS tx_state_county ON tx(state, county);
CREATE INDEX IF NOT EXISTS tx_latlon ON tx(lat, lon);
CREATE INDEX IF NOT EXISTS tx_freq ON tx(freq_mhz);
CREATE INDEX IF NOT EXISTS tx_call ON tx(call_sign);
CREATE INDEX IF NOT EXISTS tx_tower ON tx(tower_reg);
CREATE INDEX IF NOT EXISTS txh_latlon ON tx_history(lat, lon);
"""

# ---------------------------------------------------------------- reading

def iter_records(zf, member, rtype):
    """Yield field lists. Joins records that FCC split across lines."""
    prefix = rtype + "|"
    buf = None
    with zf.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="latin-1", newline="")
        for line in text:
            line = line.rstrip("\r\n")
            if line.startswith(prefix):
                if buf is not None:
                    yield buf.split("|")
                buf = line
            elif buf is not None:
                buf += " " + line
        if buf is not None:
            yield buf.split("|")


def g(f, i):
    return f[i].strip() if i < len(f) else ""


def find_member(zf, rtype):
    for n in zf.namelist():
        if os.path.basename(n).upper() == rtype + ".DAT":
            return n
    return None


_CREATED = re.compile(r"File Creation Date:\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+([A-Z]{2,4})\s+(\d{4})")
_TZ_H = {"EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6, "PST": -8, "PDT": -7, "UTC": 0, "GMT": 0}
_MON = {m: i for i, m in enumerate(("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}


def file_created(path):
    """When the FCC made a ULS zip, as UTC 'YYYY-MM-DD HH:MM:SS': its counts file says ("File Creation Date: Sat Nov  7
    04:00:46 EST 2026"). With no counts file, the newest member's time, read as US Eastern standard time. None if neither."""
    import datetime
    try:
        with zipfile.ZipFile(path) as zf:
            names = {os.path.basename(n).lower(): n for n in zf.namelist()}
            if "counts" in names:
                m = _CREATED.search(zf.read(names["counts"])[:400].decode("latin-1"))
                if m and m.group(1) in _MON:
                    t = datetime.datetime(int(m.group(7)), _MON[m.group(1)], int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)))
                    return (t - datetime.timedelta(hours=_TZ_H.get(m.group(6), -5))).strftime("%Y-%m-%d %H:%M:%S")
            newest = max((i.date_time for i in zf.infolist()), default=None)
    except (OSError, zipfile.BadZipFile, ValueError):
        return None
    return (datetime.datetime(*newest) + datetime.timedelta(hours=5)).strftime("%Y-%m-%d %H:%M:%S") if newest else None


def load_zip(con, path, states, include_inactive, log):
    src = os.path.basename(path)
    zf = zipfile.ZipFile(path)
    batch = 50000

    def bulk(sql, rows_iter):
        # a commit per batch: the raw_* tables are scratch (emptied when an import starts), and one write lock held
        # for a whole file left everyone else's saves (DAS jobs, notes) failing "database is locked" for minutes.
        # The pause after each commit lets a waiting save in: without it the next batch takes the lock straight back
        # and the other writers' retries rarely land (seen 11/2 on the server: broadcast, FAA, catalog all failed)
        n, buf = 0, []
        for row in rows_iter:
            buf.append(row)
            if len(buf) >= batch:
                con.executemany(sql, buf)
                con.commit()
                time.sleep(0.25)
                n += len(buf)
                buf.clear()
        if buf:
            con.executemany(sql, buf)
            con.commit()
            n += len(buf)
        return n

    # HD -> which licenses we keep
    keep = set()
    m = find_member(zf, "HD")
    if not m:
        log(f"  {src}: no HD.dat, skipping")
        return

    def hd_rows():
        for f in iter_records(zf, m, "HD"):
            usi = int(g(f, 1) or 0)
            status = g(f, 5)
            if not include_inactive and status != "A":
                continue
            keep.add(usi)
            yield (usi, g(f, 4), status, g(f, 6), g(f, 7), g(f, 8), src)
    n = bulk("INSERT OR REPLACE INTO raw_license(usi,call_sign,status,service,grant_date,expired_date,src)"
             " VALUES(?,?,?,?,?,?,?)", hd_rows())
    log(f"  {src}: {n:,} licenses")

    # LO first so we can drop locations outside chosen states
    loc_keep = None if not states else set()
    m = find_member(zf, "LO")
    if m:
        # A location filed with no state (most microwave receive ends: coordinates only) stays when its licence has a
        # site in a chosen state; dropping them left a state-limited import with almost no backhaul links.
        in_state = {int(g(f, 1) or 0) for f in iter_records(zf, m, "LO") if g(f, 14).upper() in states} if states else set()

        def lo_rows():
            for f in iter_records(zf, m, "LO"):
                usi = int(g(f, 1) or 0)
                if usi not in keep:
                    continue
                st = g(f, 14).upper() or None
                if states and st not in states and not (st is None and usi in in_state):
                    continue
                if loc_keep is not None:
                    loc_keep.add(usi)
                yield (usi, int(g(f, 8) or 0), g(f, 6), g(f, 7), g(f, 11), g(f, 12).upper(),
                       norm_county(g(f, 13)), st, to_float(g(f, 15)), g(f, 16), to_float(g(f, 18)),
                       dms(g(f, 19), g(f, 20), g(f, 21), g(f, 22)),
                       dms(g(f, 23), g(f, 24), g(f, 25), g(f, 26)), norm_reg(g(f, 37)))
        n = bulk("INSERT OR REPLACE INTO raw_location VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", lo_rows())
        log(f"  {src}: {n:,} locations")
    if loc_keep is not None:
        keep &= loc_keep

    m = find_member(zf, "EN")
    if m:
        names, contacts = {}, []
        for f in iter_records(zf, m, "EN"):
            usi = int(g(f, 1) or 0)
            if usi in keep and g(f, 5) in ("L", "") and usi not in names:
                nm = g(f, 7) or " ".join(x for x in (g(f, 8), g(f, 10)) if x)
                names[usi] = nm
            if usi in keep and (c := ulscontacts.row(f, usi)):  # licensee and contact, kept whole (ulscontacts.py)
                contacts.append(c)
                if len(contacts) >= batch:
                    con.executemany(ulscontacts.INSERT_RAW, contacts)
                    contacts.clear()
        con.executemany(ulscontacts.INSERT_RAW, contacts)
        con.executemany("UPDATE raw_license SET licensee=? WHERE usi=?", [(v, k) for k, v in names.items()])
        log(f"  {src}: {len(names):,} licensee names")

    m = find_member(zf, "AN")
    if m:
        def an_rows():
            for f in iter_records(zf, m, "AN"):
                usi = int(g(f, 1) or 0)
                if usi not in keep:
                    continue
                yield (usi, int(g(f, 7) or 0), int(g(f, 6) or 0), to_float(g(f, 10)), to_float(g(f, 11)),
                       to_float(g(f, 19)), to_float(g(f, 17)), to_float(g(f, 18)), to_float(g(f, 16)),
                       g(f, 15), g(f, 12), g(f, 13), to_float(g(f, 37)))
        n = bulk("INSERT OR REPLACE INTO raw_antenna VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", an_rows())
        log(f"  {src}: {n:,} antennas")

    m = find_member(zf, "FR")
    if m:
        def fr_rows():
            for f in iter_records(zf, m, "FR"):
                usi = int(g(f, 1) or 0)
                if usi not in keep:
                    continue
                fm = to_float(g(f, 10))
                if fm is None:
                    continue
                yield (usi, int(g(f, 6) or 0), int(g(f, 7) or 0), g(f, 8), fm, to_float(g(f, 11)),
                       to_float(g(f, 15)), to_float(g(f, 16)), int(to_float(g(f, 24)) or 0),
                       int(to_float(g(f, 26)) or 0), g(f, 17), g(f, 21), g(f, 22))
        n = bulk("INSERT INTO raw_freq VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", fr_rows())
        log(f"  {src}: {n:,} frequencies")

    m = find_member(zf, "EM")
    if m:
        def em_rows():
            for f in iter_records(zf, m, "EM"):
                usi = int(g(f, 1) or 0)
                if usi not in keep:
                    continue
                yield (usi, int(g(f, 5) or 0), int(g(f, 6) or 0), to_float(g(f, 7)), g(f, 9),
                       g(f, 10), g(f, 11))
        n = bulk("INSERT INTO raw_emission VALUES(?,?,?,?,?,?,?)", em_rows())
        log(f"  {src}: {n:,} emission designators")

    m = find_member(zf, "PA")  # microwave paths: which location transmits to which (only the microwave file has them)
    if m:
        def pa_rows():
            for f in iter_records(zf, m, "PA"):
                usi = int(g(f, 1) or 0)
                if usi not in keep:
                    continue
                yield (usi, int(g(f, 6) or 0), int(g(f, 7) or 0), int(g(f, 8) or 0), int(g(f, 9) or 0), int(g(f, 10) or 0),
                       g(f, 12), g(f, 13), g(f, 16))
        n = bulk("INSERT INTO raw_path VALUES(?,?,?,?,?,?,?,?,?)", pa_rows())
        log(f"  {src}: {n:,} microwave paths")
    con.commit()


def build_links(con, log):
    """Each microwave path with both ends placed (from the licence's own locations), its length and frequencies."""
    import math
    con.execute("DELETE FROM mw_link")
    if not con.execute("SELECT 1 FROM raw_path LIMIT 1").fetchone():
        con.commit()
        return 0
    con.execute(f"CREATE INDEX IF NOT EXISTS {raw_schema(con)}.fr_key ON raw_freq(usi, loc_num, ant_num)")
    q = """SELECT p.usi, l.call_sign, l.licensee, l.service, p.path_num, p.tx_loc, p.tx_ant,
                  a.lat, a.lon, a.city, a.state, a.tower_reg, b.lat, b.lon, b.city, b.state, b.tower_reg, p.rx_call, p.path_type, p.passive,
                  (SELECT GROUP_CONCAT(DISTINCT printf('%.4f', f.freq_mhz)) FROM raw_freq f WHERE f.usi = p.usi AND f.loc_num = p.tx_loc AND f.ant_num = p.tx_ant)
           FROM raw_path p JOIN raw_license l ON l.usi = p.usi AND l.status = 'A'
           JOIN raw_location a ON a.usi = p.usi AND a.loc_num = p.tx_loc
           JOIN raw_location b ON b.usi = p.usi AND b.loc_num = p.rx_loc
           WHERE a.lat IS NOT NULL AND b.lat IS NOT NULL"""
    out, n = [], 0
    for r in con.execute(q):
        p1, p2 = math.radians(r[7]), math.radians(r[12])
        h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(r[13] - r[8]) / 2) ** 2
        d = 2 * 6371.0088 * math.asin(min(1, math.sqrt(h)))
        if not 0.05 <= d <= 250:  # both ends at one spot, or a bad coordinate (terrestrial hops stay well under 250 km)
            continue
        freqs = ",".join(sorted(set((r[20] or "").split(",")) - {""}, key=float)[:12])
        out.append((r[0], r[1], r[2], r[3], r[4], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15], r[16], r[17],
                    round(d, 2), freqs, r[18], r[19]))
        if len(out) >= 50000:
            con.executemany("INSERT INTO mw_link VALUES(" + ",".join("?" * 20) + ")", out)
            n += len(out)
            out.clear()
    if out:
        con.executemany("INSERT INTO mw_link VALUES(" + ",".join("?" * 20) + ")", out)
        n += len(out)
    con.executescript("CREATE INDEX IF NOT EXISTS mw_tx ON mw_link(tx_lat, tx_lon); CREATE INDEX IF NOT EXISTS mw_rx ON mw_link(rx_lat, rx_lon);")
    con.commit()
    log(f"  {n:,} microwave links placed at both ends")
    return n


TX_COLS = ("usi", "call_sign", "service", "service_name", "licensee", "category", "grant_date", "expired_date",
           "loc_num", "address", "city", "county", "state", "lat", "lon", "ground_elev_m", "radius_km", "is_mobile", "ant_num",
           "height_tip_m", "haat_m", "gain_dbi", "azimuth", "station_class", "freq_mhz", "freq_upper_mhz", "band",
           "power_out_w", "erp_w", "units", "emissions", "bandwidth_khz", "mode", "tolerance", "tx_make", "tx_model", "digital_mod",
           "ant_make", "ant_model", "polarization", "beamwidth", "height_raat_m", "status", "tower_reg")


def tx_insert(table):
    return f"INSERT INTO {table}({','.join(TX_COLS)}) VALUES(" + ",".join("?" * len(TX_COLS)) + ")"


def build_tx(con, log):
    log("Building search table...")
    con.execute("DROP TABLE IF EXISTS tx_new")
    ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='tx'").fetchone()[0]
    # After the first swap SQLite stores this as CREATE TABLE "tx"(...), quoted, so match any form
    con.execute(re.sub(r'^CREATE TABLE (IF NOT EXISTS )?["`\[]?tx["`\]]?\s*\(', "CREATE TABLE tx_new(", ddl, count=1))
    con.execute(f"CREATE INDEX IF NOT EXISTS {raw_schema(con)}.em_key ON raw_emission(usi, loc_num, ant_num)")
    out, n = [], 0
    ins = tx_insert("tx_new")
    for row in tx_rows(con):
        out.append(row)
        if len(out) >= 50000:
            con.executemany(ins, out)
            n += len(out)
            out.clear()
            log(f"  {n:,} rows...", end="\r")
    if out:
        con.executemany(ins, out)
        n += len(out)
    built = time.strftime("%Y-%m-%d %H:%M")
    # history: remember every (call, freq, site) ever seen, so removed entries stay searchable
    con.execute("""INSERT INTO tx_history(hkey,call_sign,freq_mhz,lat,lon,licensee,service,mode,county,state,first_seen,last_seen)
        SELECT call_sign||'|'||printf('%.5f',freq_mhz)||'|'||CASE WHEN lat IS NULL THEN '' ELSE printf('%.4f',lat) END||'|'||CASE WHEN lon IS NULL THEN '' ELSE printf('%.4f',lon) END,
               call_sign,freq_mhz,lat,lon,licensee,service,mode,county,state,?,? FROM tx_new WHERE status='A'
        ON CONFLICT(hkey) DO UPDATE SET last_seen=excluded.last_seen, licensee=excluded.licensee, mode=excluded.mode""",
                (built, built))
    con.execute("DROP TABLE IF EXISTS tx")
    con.execute("ALTER TABLE tx_new RENAME TO tx")
    con.executescript(TX_INDEXES)
    con.execute("INSERT OR REPLACE INTO meta VALUES('built_at', ?)", (built,))
    con.execute("INSERT OR REPLACE INTO meta VALUES('tx_rows', ?)", (str(n),))
    con.commit()
    log(f"  {n:,} searchable transmitter/frequency rows")
    build_places(con)
    log("  town and county names indexed for search")


def tx_rows(con):
    """Each searchable row (TX_COLS, in order) from the raw_* tables: the weekly import's (build_tx) and the daily change
    files' (ulsdaily.py), so a licence reads the same whichever file brought it."""
    # emissions per (usi, loc, ant, freq)
    em, dmod = {}, {}
    for usi, loc, ant, fm, code, rate, mtype in con.execute(
            "SELECT usi, loc_num, ant_num, freq_mhz, code, mod_rate, mod_type FROM raw_emission"):
        if not code:
            continue
        key = (usi, loc, ant, round(fm or 0, 5))
        lst = em.setdefault(key, [])
        if code not in lst:
            lst.append(code)
        d = " ".join(x for x in ((rate and rate + " kbps") or "", mtype or "") if x)
        if d:
            dl = dmod.setdefault(key, [])
            if d not in dl:
                dl.append(d)
    q = """
    SELECT l.usi, l.call_sign, l.service, l.licensee, l.grant_date, l.expired_date, l.status,
           CASE WHEN UPPER(TRIM(lo.tower_reg)) IN ('', 'N/A', 'NA', 'NONE') THEN NULL ELSE lo.tower_reg END,
           f.loc_num, lo.address, lo.city, lo.county, lo.state, lo.lat, lo.lon, lo.ground_elev_m,
           lo.radius_km, f.ant_num, a.height_tip_m, a.haat_m, a.gain_dbi, a.azimuth,
           f.station_class, f.freq_mhz, f.freq_upper_mhz, f.power_out_w, f.erp_w, f.units,
           f.tolerance, f.tx_make, f.tx_model, a.make, a.model, a.polarization, a.beamwidth, a.height_raat_m
    FROM raw_freq f
    JOIN raw_license l ON l.usi = f.usi
    LEFT JOIN raw_location lo ON lo.usi = f.usi AND lo.loc_num = f.loc_num
    LEFT JOIN raw_antenna a ON a.usi = f.usi AND a.loc_num = f.loc_num AND a.ant_num = f.ant_num
    """
    for r in con.execute(q):
        (usi, call, svc, lic, gd, ed, lstatus, treg, loc, addr, city, county, st, lat, lon, elev, rad, ant,
         htip, haat, gain, az, scls, fm, fup, pout, erp, units,
         tol, txmk, txmd, amk, amd, pol, bwd, hraat) = r
        key = (usi, loc, ant, round(fm or 0, 5))
        codes = em.get(key, [])
        bw, modes = None, []
        for c in codes:  # several designators = mixed-mode; keep them all
            b, md = parse_emission(c)
            if b and (bw is None or b > bw):
                bw = b
            if md and md not in modes:
                modes.append(md)
        mode = " / ".join(sorted(modes)) or None
        is_mobile = 1 if (scls or "").startswith(("MO", "MOB")) or lat is None else 0
        yield (usi, call, svc, SERVICE_NAMES.get(svc, svc), lic, category_for(lic, svc), gd, ed,
               loc, addr, city, county, st, lat, lon, elev, rad, is_mobile, ant, htip, haat, gain,
               az, scls, fm, fup, band_for(fm), pout, erp, units, " ".join(codes), bw, mode,
               tol, txmk, txmd, "; ".join(dmod.get(key, [])) or None, amk, amd, pol, bwd, hraat,
               lstatus, treg)


def build_places(con):
    """Towns and counties with a centre point (the average of their licensed sites): the offline half of
    address search, so a county or town still resolves in the field with no signal."""
    con.executescript("""
        DROP TABLE IF EXISTS place;
        CREATE TABLE place(name TEXT COLLATE NOCASE, kind TEXT, state TEXT, lat REAL, lon REAL, n INTEGER);
        INSERT INTO place SELECT city, 'town', state, AVG(lat), AVG(lon), COUNT(*) FROM tx
            WHERE city IS NOT NULL AND city <> '' AND lat IS NOT NULL AND state IS NOT NULL GROUP BY city, state;
        INSERT INTO place SELECT county, 'county', state, AVG(lat), AVG(lon), COUNT(*) FROM tx
            WHERE county IS NOT NULL AND lat IS NOT NULL AND state IS NOT NULL GROUP BY county, state;
        CREATE INDEX place_name ON place(name COLLATE NOCASE);
    """)
    con.execute("INSERT OR REPLACE INTO meta SELECT 'places_built_at', v FROM meta WHERE k = 'built_at'")
    con.commit()


UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"}


def http_get(url, path, log=print, timeout=1800):
    """Download url to path with DAStastic's own downloader. A refusal (HTTP 403 and the like) stops here: no second try
    by another client or route (Cody 11/5, no bot-check bypass; until 11/8 a 403 fell back to curl). The source's run
    fails with the FCC's answer, and the Data desk files it for a person, who can download the file in a browser."""
    tmp = path + ".part"
    try:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(tmp, "wb") as out:
                total, got = int(r.headers.get("Content-Length") or 0), 0
                while True:
                    dlstop.check()  # Stop all downloads
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    got += len(chunk)
                    if total:
                        log(f"  {got/1e6:,.0f} / {total/1e6:,.0f} MB", end="\r")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 429, 451, 503):
                raise RuntimeError(f"the FCC refused DAStastic's download of {url} (HTTP {e.code}): stopped, not tried "
                                   "another way; a person can download it in a browser into the data folder") from e
            raise
        os.replace(tmp, path)
        return path
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def last_modified(url):
    """The server's Last-Modified date as 'YYYY-MM-DD HH:MM', or None if it can't be read. Read from a one-byte GET by
    DAStastic's own downloader: the FCC's servers refuse HEAD (403) and answer GET with the file's date (206). A refusal
    is None, never a second try another way (until 11/8 a 403 fell back to curl)."""
    from email.utils import parsedate_to_datetime
    try:
        req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            lm = r.headers.get("Last-Modified")
    except Exception:
        return None
    try:
        return parsedate_to_datetime(lm).strftime("%Y-%m-%d %H:%M") if lm else None
    except (TypeError, ValueError):
        return None


def download(service, refresh, log, url=None, fname=None):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, fname or f"l_{service}.zip")
    if os.path.exists(path) and not refresh:
        log(f"Using cached {path} (use --refresh to re-download)")
        return path
    url = url or BASE_URL.format(service)
    log(f"Downloading {url}")
    try:
        http_get(url, path, log)
        log(f"  saved {path} ({os.path.getsize(path)/1e6:,.0f} MB)")
        return path
    except Exception as e:
        log(f"  could not download {service}: {e}")
        return None


def scratch_path(db_path):
    return db_path + ".import-scratch"


def drop_scratch(path):
    for p in (path, path + "-journal", path + "-wal", path + "-shm"):
        if os.path.exists(p):
            os.remove(p)


ARCHIVE_DIR = os.path.join(DATA_DIR, "fcc-archive")
ARCHIVE_MIN_FREE_GB = 15


def archive(path, log=print):
    """Keep this week's copy of an FCC file in fcc-archive/<day it was downloaded>/ (Cody 11/2: "Weekly FCC file archive").
    A hard link: no copying now, and the next download writes a new file, so the archived week stays as it was. Stops
    when the disk has less than ARCHIVE_MIN_FREE_GB free, and says so. Returns the archived path or None."""
    if not path or not os.path.exists(path):
        return None
    free = shutil.disk_usage(os.path.dirname(path)).free / 1e9
    if free < ARCHIVE_MIN_FREE_GB:
        log(f"FCC archive paused: {free:.0f} GB free, under {ARCHIVE_MIN_FREE_GB} GB")
        return None
    day = time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(path)))
    dest = os.path.join(ARCHIVE_DIR, day, os.path.basename(path))
    if os.path.exists(dest):
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    try:
        os.link(path, dest)
    except OSError:  # a disk without hard links: a real copy
        shutil.copy2(path, dest)
    return dest


def run_import(db_path, paths, states=(), active_only=False, log=print):
    t0 = time.time()
    con = sqlite3.connect(db_path, timeout=60)
    try:
        con.executescript(SCHEMA)
        con.execute("PRAGMA synchronous=OFF")
        old = [t for t in RAW_TABLES if con.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()]
        if old:  # a database from before 11/3 kept them inside: dropped once (their pages are read once more, then never)
            log("Removing the old scratch tables from the database (once)...")
            for t in old:
                con.execute(f"DROP TABLE main.{t}")
            con.commit()
        scratch = scratch_path(db_path)
        drop_scratch(scratch)  # a run that crashed leaves one: it's only ever a copy of the FCC files
        con.execute("ATTACH DATABASE ? AS scratch", (scratch,))
        try:
            con.execute("PRAGMA scratch.journal_mode=OFF")  # scratch: a crash just means the next run starts it again
            con.execute("PRAGMA scratch.synchronous=OFF")
            create_raw(con, "scratch")
            states = {s.upper() for s in states}
            for p in paths:
                log(f"Importing {p}")
                load_zip(con, p, states, not active_only, log)
                # the FCC's own date for this file: a daily change file made before it is already in it (ulsdaily.py)
                con.execute("INSERT OR REPLACE INTO meta VALUES(?, ?)", ("uls_asof:" + os.path.basename(p), file_created(p) or ""))
            build_tx(con, log)
            ulscontacts.build(con, log)  # the licences' own contacts, for consent letters
            build_links(con, log)
            con.execute("INSERT OR REPLACE INTO meta VALUES('sources', ?)", (",".join(os.path.basename(p) for p in paths),))
            con.execute("INSERT OR REPLACE INTO meta VALUES('states', ?)", (",".join(sorted(states)) or "ALL",))
            con.commit()
        except BaseException:
            con.rollback()  # a failed run leaves the last good search table as it was
            raise
        finally:
            con.execute("DETACH DATABASE scratch")
            drop_scratch(scratch)
        n = con.execute("SELECT COUNT(*) FROM tx").fetchone()[0]
        try:  # a page being read can hold some back; the next import's checkpoint takes the rest
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
    finally:
        con.close()
    log(f"ULS import done in {time.time()-t0:,.0f}s ({n:,} rows)")
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--services", default=",".join(DEFAULT_SERVICES),
                    help=f"comma list of l_*.zip names. Default {','.join(DEFAULT_SERVICES)}; "
                         f"also available: {','.join(OPTIONAL_SERVICES)}")
    ap.add_argument("--zip", action="append", default=[], help="use a local l_*.zip instead of downloading")
    ap.add_argument("--states", default="", help="comma list of 2-letter states to keep (default: all)")
    ap.add_argument("--active-only", action="store_true",
                    help="skip expired/cancelled licenses (smaller DB, but no license history)")
    ap.add_argument("--refresh", action="store_true", help="re-download even if cached")
    ap.add_argument("--with-towers", action="store_true", help="also import FCC antenna structures (ASR)")
    ap.add_argument("--db", default=DB_PATH)
    a = ap.parse_args()

    def log(msg, end="\n"):
        print(msg, end=end, flush=True)

    states = [s.strip().upper() for s in a.states.split(",") if s.strip()]
    paths = list(a.zip)
    if not paths:
        for svc in [s.strip() for s in a.services.split(",") if s.strip()]:
            p = download(svc, a.refresh, log)
            if p:
                paths.append(p)
    if not paths:
        sys.exit("No ULS files available. Check your internet connection or pass --zip.")
    run_import(a.db, paths, states, a.active_only, log)
    if a.with_towers:
        import towers
        towers.run(a.db, refresh=a.refresh, states=states, log=log)
    log("Start the app with:  python app.py")


if __name__ == "__main__":
    main()
