"""
FCC broadcast stations (AM, FM, TV, low-power and translators) as a layer: call sign, frequency or channel,
power, antenna height, location, licensee.

Source: the FCC Media Bureau's AM / FM / TV query lists (pipe-delimited, list=4), nationwide. They aren't in the
ULS files, which cover land mobile, paging, microwave and the like. Read from saved files when the FCC refuses
the app's own downloader (it answers curl): fcc_fmq.txt, fcc_amq.txt and fcc_tvq.txt in the data folder.
"""
import os
import re
import time

URL = "https://transition.fcc.gov/fcc-bin/{svc}?list=4&size=9"
FILES = {"fm": "fcc_fmq.txt", "am": "fcc_amq.txt", "tv": "fcc_tvq.txt"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS bcast(id INTEGER PRIMARY KEY, call_sign TEXT, band TEXT, service TEXT, freq_mhz REAL,
    channel TEXT, class TEXT, status TEXT, city TEXT, state TEXT, facility_id TEXT, lat REAL, lon REAL,
    erp_kw REAL, haat_m REAL, licensee TEXT, hours TEXT, directional TEXT);
CREATE INDEX IF NOT EXISTS bcast_latlon ON bcast(lat, lon);
CREATE INDEX IF NOT EXISTS bcast_state ON bcast(state);
"""
STATUS = {"LIC": "Licensed", "CP": "Construction permit", "STA": "Special temporary authority", "APP": "Application"}


def tv_mhz(ch):
    """RF channel -> centre frequency (US 6 MHz channels)."""
    try:
        c = int(ch)
    except (TypeError, ValueError):
        return None
    if 2 <= c <= 4:
        return 57 + 6 * (c - 2)
    if 5 <= c <= 6:
        return 79 + 6 * (c - 5)
    if 7 <= c <= 13:
        return 177 + 6 * (c - 7)
    if 14 <= c <= 36:
        return 473 + 6 * (c - 14)
    return None


def num(s):
    m = re.search(r"-?\d+(?:\.\d*)?", s or "")
    return float(m.group()) if m else None


def coord(ns, d, m, s):
    deg = num(d)
    if deg is None:
        return None
    v = deg + (num(m) or 0) / 60 + (num(s) or 0) / 3600
    return round(-v if ns.strip() in ("S", "W") else v, 6)


def parse(text, kind):
    """Records from one list. Positions as the FCC prints them (checked against live DC records, 2026-10-27)."""
    out = []
    for line in text.splitlines():
        f = [x.strip() for x in line.split("|")]
        if len(f) < 28 or not f[1]:
            continue
        lat, lon = coord(f[19], f[20], f[21], f[22]), coord(f[23], f[24], f[25], f[26])
        if lat is None or lon is None:
            continue
        if kind == "am":
            freq, chan, erp, haat, hours = (num(f[2]) or 0) / 1000, f[2], num(f[14]), None, f[5]
        elif kind == "fm":
            freq, chan, erp, haat, hours = num(f[2]), f[4], max(num(f[14]) or 0, num(f[15]) or 0) or None, num(f[16]), None
        else:
            freq, chan, erp, haat, hours = tv_mhz(f[4]), f[4], num(f[14]), num(f[16]), None
        if not freq:
            continue
        out.append(dict(call_sign=f[1], band=kind.upper(), service=f[3], freq_mhz=round(freq, 4), channel=chan,
                        class_=f[7], status=STATUS.get(f[9], f[9]), city=f[10], state=f[11], facility_id=f[18],
                        lat=lat, lon=lon, erp_kw=erp, haat_m=haat, licensee=f[27], hours=hours,
                        directional=f[15] if kind == "am" else f[5]))
    return out


def download(data_dir, log=print):
    """Fetch the three lists. Returns the paths it could get (the FCC may refuse; see the module note)."""
    import uls_import
    got = []
    for kind, fname in FILES.items():
        path = os.path.join(data_dir, fname)
        try:
            uls_import.http_get(URL.format(svc=fname[4:7]), path, log=lambda m, end="\n": None)  # curl fallback on a 403
            got.append(path)
        except Exception as e:
            log(f"  {kind.upper()} list not downloaded ({e}); using the saved copy if there is one")
            if os.path.exists(path):
                got.append(path)
    return got


def run(con, data_dir, fetch=False, log=print):
    """Rebuild the bcast table from the saved lists (downloading first when fetch=True)."""
    if fetch:
        download(data_dir, log)
    rows = []
    for kind, fname in FILES.items():
        path = os.path.join(data_dir, fname)
        if not os.path.exists(path):
            log(f"  no {fname}: {kind.upper()} stations skipped")
            continue
        with open(path, encoding="latin-1") as fh:
            recs = parse(fh.read(), kind)
        # one row per transmitter: AM's day / night / critical-hours entries share a site and frequency
        seen = {}
        for r in recs:
            k = (r["call_sign"], r["freq_mhz"], round(r["lat"], 4), round(r["lon"], 4))
            if k not in seen or (r["status"] == "Licensed" and seen[k]["status"] != "Licensed"):
                seen[k] = r
        rows += seen.values()
        log(f"  {kind.upper()}: {len(seen):,} stations")
    con.executescript(SCHEMA)
    con.execute("DELETE FROM bcast")
    con.executemany("INSERT INTO bcast(call_sign,band,service,freq_mhz,channel,class,status,city,state,facility_id,lat,lon,"
                    "erp_kw,haat_m,licensee,hours,directional) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(r["call_sign"], r["band"], r["service"], r["freq_mhz"], r["channel"], r["class_"], r["status"], r["city"],
                      r["state"], r["facility_id"], r["lat"], r["lon"], r["erp_kw"], r["haat_m"], r["licensee"], r["hours"],
                      r["directional"]) for r in rows])
    con.execute("INSERT OR REPLACE INTO meta VALUES('bcast_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.execute("INSERT OR REPLACE INTO meta VALUES('bcast_rows', ?)", (str(len(rows)),))
    con.commit()
    return len(rows)


if __name__ == "__main__":  # python broadcast.py: fetch the lists if the FCC allows it, else use the saved ones, then import
    import sqlite3
    import uls_import
    con = sqlite3.connect(uls_import.DB_PATH, timeout=60)
    print(f"{run(con, uls_import.DATA_DIR, fetch=True):,} broadcast stations")
    con.close()
