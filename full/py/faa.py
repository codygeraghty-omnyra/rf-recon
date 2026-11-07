"""
FAA aviation frequencies as a layer, from the FAA's 28-day NASR subscription (public domain):
  FRQ  - every assigned frequency at every facility: towers, ground, ATIS, approach / departure, CTAF, UNICOM,
         centre sectors and remote outlets, with the facility's position and radio call
  NAV  - navaids: VOR, VORTAC, TACAN, DME, NDB, with frequency and channel
  ILS  - localizers and glide slopes, per runway
Downloads the per-topic CSV zips of the current cycle (about 3 MB in all) into data/faa/.
"""
import csv
import io
import os
import re
import time
import urllib.request
import zipfile

CYCLE_PAGE = "https://www.faa.gov/air_traffic/flight_info/aeronav/aero_data/NASR_Subscription/"
CSV_URL = "https://nfdc.faa.gov/webContent/28DaySub/extra/{cycle}_{topic}_CSV.zip"
TOPICS = ("FRQ", "NAV", "ILS")
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS faa(id INTEGER PRIMARY KEY, ident TEXT, name TEXT, kind TEXT, use TEXT, freq_mhz REAL,
    call TEXT, sector TEXT, city TEXT, state TEXT, lat REAL, lon REAL, status TEXT, remark TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS faa_latlon ON faa(lat, lon);
"""


def current_cycle():
    """'01_Oct_2026' for the cycle in effect today (the subscription page lists the dates)."""
    with urllib.request.urlopen(urllib.request.Request(CYCLE_PAGE, headers=UA), timeout=60) as r:
        page = r.read().decode("utf-8", "replace")
    dates = sorted(set(re.findall(r"NASR_Subscription/(\d{4}-\d{2}-\d{2})", page)))
    today = time.strftime("%Y-%m-%d")
    eff = max((d for d in dates if d <= today), default=dates[0] if dates else None)
    if not eff:
        raise RuntimeError("no NASR cycle found on the FAA subscription page")
    return time.strftime("%d_%b_%Y", time.strptime(eff, "%Y-%m-%d"))


def download(data_dir, log=print):
    out = os.path.join(data_dir, "faa")
    os.makedirs(out, exist_ok=True)
    cycle = current_cycle()
    for t in TOPICS:
        path = os.path.join(out, f"{t}.zip")
        with urllib.request.urlopen(urllib.request.Request(CSV_URL.format(cycle=cycle, topic=t), headers=UA), timeout=180) as r, \
                open(path + ".part", "wb") as fh:
            fh.write(r.read())
        os.replace(path + ".part", path)
    log(f"  FAA NASR cycle {cycle.replace('_', ' ')} downloaded")
    return cycle


def _rows(zip_path, member):
    with zipfile.ZipFile(zip_path) as z, z.open(member) as fh:
        yield from csv.DictReader(io.TextIOWrapper(fh, encoding="latin-1"))


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(data_dir):
    d = os.path.join(data_dir, "faa")
    rows = []
    for r in _rows(os.path.join(d, "FRQ.zip"), "FRQ.csv"):
        f, lat, lon = _f(r["FREQ"]), _f(r["LAT_DECIMAL"]), _f(r["LONG_DECIMAL"])
        if not f or lat is None or lon is None:
            continue
        rows.append((r["SERVICED_FACILITY"] or r["FACILITY"], r["SERVICED_FAC_NAME"] or r["FAC_NAME"],
                     r["SERVICED_SITE_TYPE"] or r["FACILITY_TYPE"], r["FREQ_USE"], f, r["TOWER_OR_COMM_CALL"] or r["PRIMARY_APPROACH_RADIO_CALL"],
                     r["SECTORIZATION"], r["SERVICED_CITY"], r["SERVICED_STATE"], lat, lon, None, r["REMARK"], "FRQ"))
    for r in _rows(os.path.join(d, "NAV.zip"), "NAV_BASE.csv"):
        f, lat, lon = _f(r["FREQ"]), _f(r["LAT_DECIMAL"]), _f(r["LONG_DECIMAL"])
        if not f or lat is None or lon is None:
            continue
        if "NDB" in r["NAV_TYPE"] or f > 190:  # NDBs are listed in kHz
            f = f / 1000
        rows.append((r["NAV_ID"], r["NAME"], r["NAV_TYPE"], f"navaid, channel {r['CHAN']}" if r.get("CHAN") else "navaid", f, None, None,
                     r["CITY"], r["STATE_CODE"], lat, lon, r["NAV_STATUS"].title(), None, "NAV"))
    for member, fcol, use in (("ILS_BASE.csv", "LOC_FREQ", "ILS localizer"), ("ILS_GS.csv", "G_S_FREQ", "ILS glide slope")):
        for r in _rows(os.path.join(d, "ILS.zip"), member):
            f, lat, lon = _f(r.get(fcol)), _f(r["LAT_DECIMAL"]), _f(r["LONG_DECIMAL"])
            if not f or lat is None or lon is None:
                continue
            rows.append((r["ILS_LOC_ID"], f"{r['ARPT_ID']} runway {r['RWY_END_ID']}", "ILS", use, f, None, None, r["CITY"],
                         r["STATE_CODE"], lat, lon, r["COMPONENT_STATUS"].title(), None, "ILS"))
    return rows


def merge(rows):
    """One row per facility, frequency and site: the FAA lists a frequency once per procedure or use
    (Reagan's 118.95 appears for six departure procedures), which would bury the map."""
    out = {}
    for r in rows:
        k = (r[0], r[4], round(r[9], 5), round(r[10], 5))
        if k not in out:
            out[k] = list(r)
        elif r[3] and r[3] not in out[k][3].split("; "):
            out[k][3] = f"{out[k][3]}; {r[3]}" if out[k][3] else r[3]
    return [tuple(v) for v in out.values()]


def run(con, data_dir, fetch=True, log=print):
    if fetch:
        try:
            download(data_dir, log)
        except Exception as e:
            log(f"  FAA data not downloaded ({e}); using the saved copy if there is one")
    if not os.path.exists(os.path.join(data_dir, "faa", "FRQ.zip")):
        raise RuntimeError("no FAA data yet (needs a connection once)")
    rows = merge(parse(data_dir))
    con.executescript(SCHEMA)
    con.execute("DELETE FROM faa")
    con.executemany("INSERT INTO faa(ident,name,kind,use,freq_mhz,call,sector,city,state,lat,lon,status,remark,source) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("INSERT OR REPLACE INTO meta VALUES('faa_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    log(f"  FAA: {len(rows):,} aviation frequencies")
    return len(rows)


def sig_type(f, kind):
    if f < 1.8:
        return "NDB"
    if 108 <= f < 118 or 328 <= f < 336:
        return "VOR / ILS"
    if 118 <= f < 137:
        return "Aviation voice (AM)"
    if 225 <= f < 400:
        return "Military air (UHF AM)"
    return "Aviation"


if __name__ == "__main__":
    import sqlite3
    import uls_import
    con = sqlite3.connect(uls_import.DB_PATH, timeout=60)
    print(f"{run(con, uls_import.DATA_DIR):,} FAA aviation frequencies")
    con.close()
