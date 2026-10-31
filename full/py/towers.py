"""
FCC Antenna Structure Registration (ASR) import: r_tower.zip -> tower table.
Towers link to ULS transmitter sites through the LO record's tower registration
number, so each site can show its physical structure and co-located licensees.

The ASR files have no header row. Positions follow the FCC ASR definitions, but
each record is validated and, if a field isn't where expected, located by
pattern (state code + numeric heights, N/S + E/W coordinate groups), so a
shifted column doesn't silently produce wrong towers.
"""
import io
import os
import re
import sqlite3
import time
import zipfile

URL = "https://data.fcc.gov/download/pub/uls/complete/r_tower.zip"
STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
             "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP".split())
# Census county list (public domain), to name the county FIPS code ASR gives each tower
COUNTY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference", "census_counties_2020.txt")
SCHEMA = """
CREATE TABLE IF NOT EXISTS tower(reg TEXT PRIMARY KEY, usi INTEGER, lat REAL, lon REAL, struct_type TEXT,
    height_m REAL, overall_agl_m REAL, overall_amsl_m REAL, ground_elev_m REAL, street TEXT, city TEXT,
    state TEXT, owner TEXT, status TEXT, constructed TEXT, faa_study TEXT, county TEXT);
"""
INDEXES = """
CREATE INDEX IF NOT EXISTS tower_latlon ON tower(lat, lon);
CREATE INDEX IF NOT EXISTS tower_county ON tower(state, county);
"""


def ensure_schema(con):
    con.executescript(SCHEMA)
    if "county" not in [r[1] for r in con.execute("PRAGMA table_info(tower)")]:  # databases built before county
        con.execute("ALTER TABLE tower ADD COLUMN county TEXT")
    con.executescript(INDEXES)


def county_names():
    """5-digit county FIPS -> county name in ULS form (FAIRFAX, FAIRFAX CITY, DONA ANA)."""
    import unicodedata
    import uls_import
    out = {}
    with open(COUNTY_FILE, encoding="utf-8") as fh:
        for line in fh.read().splitlines()[1:]:
            p = line.split("|")
            if len(p) > 4:
                name = unicodedata.normalize("NFKD", p[4].replace("�", "n")).encode("ascii", "ignore").decode()
                out[p[1] + p[2]] = uls_import.norm_county(name)
    return out
STATUS = {"C": "Constructed", "G": "Granted", "D": "Dismantled", "T": "Terminated", "A": "Cancelled",
          "I": "Dismissed", "W": "Withdrawn"}


def num(v):
    try:
        v = (v or "").strip()
        return float(v) if v else None
    except ValueError:
        return None


def norm_reg(s):
    s = (s or "").strip()
    return s.lstrip("0").zfill(7) if s.isdigit() else None


def records(z, name, rtype):
    member = next((n for n in z.namelist() if os.path.basename(n).upper() == name), None)
    if not member:
        return
    buf = None
    with z.open(member) as raw:
        for line in io.TextIOWrapper(raw, encoding="latin-1", newline=""):
            line = line.rstrip("\r\n")
            if line.startswith(rtype + "|"):
                if buf is not None:
                    yield buf.split("|")
                buf = line
            elif buf is not None:
                buf += " " + line
    if buf is not None:
        yield buf.split("|")


def find_reg(f):
    for i in (3, 2, 4, 1):
        if i < len(f) and norm_reg(f[i]) and len(f[i].strip()) <= 8:
            return norm_reg(f[i])
    return None


def find_coords(f):
    """Locate deg|min|sec|N/S ... deg|min|sec|E/W. Total-seconds columns may sit between."""
    for i in range(4, len(f) - 3):
        if f[i + 3].strip() in ("N", "S") and num(f[i]) is not None and 0 <= num(f[i]) <= 90:
            for j in range(i + 4, min(i + 8, len(f) - 3)):
                if f[j + 3].strip() in ("E", "W") and num(f[j]) is not None and 0 <= num(f[j]) <= 180:
                    lat = num(f[i]) + (num(f[i + 1]) or 0) / 60 + (num(f[i + 2]) or 0) / 3600
                    lon = num(f[j]) + (num(f[j + 1]) or 0) / 60 + (num(f[j + 2]) or 0) / 3600
                    return (round(-lat if f[i + 3].strip() == "S" else lat, 6),
                            round(-lon if f[j + 3].strip() == "W" else lon, 6))
    return None


def parse_ra(f):
    """Expected: 23 street, 24 city, 25 state, 26 county, 27 zip, 28 struct height, 29 ground elev,
    30 overall AGL, 31 overall AMSL, 32 structure type, 34 FAA study."""
    k = 25 if len(f) > 32 and f[25].strip() in STATES else None
    if k is None:  # locate the state code followed by numeric heights
        for i in range(10, len(f) - 6):
            if f[i].strip() in STATES and sum(num(f[i + d]) is not None for d in (3, 4, 5, 6)) >= 2:
                k = i
                break
    if k is None:
        return None
    g = lambda i: f[i].strip() if 0 <= i < len(f) else ""
    return dict(status=STATUS.get(g(8), g(8)), constructed=g(12), street=g(k - 2), city=g(k - 1), state=g(k),
                county_fips=g(k + 1), height_m=num(g(k + 3)), ground_elev_m=num(g(k + 4)),
                overall_agl_m=num(g(k + 5)), overall_amsl_m=num(g(k + 6)), struct_type=g(k + 7), faa_study=g(k + 9))


def run(db_path, refresh=False, states=(), log=print, path=None):
    import uls_import
    states = {s.upper() for s in states}
    if not path:
        path = uls_import.download("tower", refresh, log, url=URL, fname="r_tower.zip")
        if not path:
            raise RuntimeError("could not download r_tower.zip from the FCC")
    t0 = time.time()
    z = zipfile.ZipFile(path)
    coords = {}
    for f in records(z, "CO.DAT", "CO"):
        reg = find_reg(f)
        if reg and reg not in coords:
            c = find_coords(f)
            if c:
                coords[reg] = c
    log(f"  towers: {len(coords):,} coordinates")
    owners = {}
    for f in records(z, "EN.DAT", "EN"):
        reg = find_reg(f)
        if reg and (len(f) > 12) and reg not in owners and f[5].strip() in ("O", "", "Owner"):
            # 9 entity name; individuals: 10 first, 12 last (8 is the FCC licensee ID, not a name)
            owners[reg] = f[9].strip() or " ".join(x.strip() for x in (f[10], f[12]) if x.strip())
    counties = county_names()
    rows, bad = [], 0
    for f in records(z, "RA.DAT", "RA"):
        reg = find_reg(f)
        if not reg or reg not in coords:
            continue
        ra = parse_ra(f)
        if not ra:
            bad += 1
            continue
        if states and ra["state"] not in states:
            continue
        lat, lon = coords[reg]
        usi = int(num(f[4]) or 0) if len(f) > 4 else 0
        rows.append((reg, usi, lat, lon, ra["struct_type"], ra["height_m"], ra["overall_agl_m"], ra["overall_amsl_m"],
                     ra["ground_elev_m"], ra["street"], ra["city"], ra["state"], owners.get(reg), ra["status"],
                     ra["constructed"], ra["faa_study"], counties.get(ra["county_fips"].zfill(5))))
    con = sqlite3.connect(db_path, timeout=60)
    ensure_schema(con)
    con.execute("DELETE FROM tower")
    con.executemany("INSERT OR REPLACE INTO tower(reg,usi,lat,lon,struct_type,height_m,overall_agl_m,overall_amsl_m,"
                    "ground_elev_m,street,city,state,owner,status,constructed,faa_study,county) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("INSERT OR REPLACE INTO meta VALUES('towers_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES('towers_rows', ?)", (str(len(rows)),))
    con.commit()
    con.close()
    log(f"  towers: {len(rows):,} structures imported in {time.time()-t0:,.0f}s"
        + (f" ({bad:,} registration rows had an unrecognized layout and were skipped)" if bad else ""))
    return len(rows)
