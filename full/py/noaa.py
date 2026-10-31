"""
NOAA Weather Radio transmitters: call sign, frequency (162.400-162.550 MHz), power, status, location, and the
counties each one warns (with their SAME codes), from the National Weather Service's own station data
(weather.gov/source/nwr/JS/ccl-data.js, the file behind weather.gov/nwr/station_listing). Public domain.
"""
import json
import os
import time
import urllib.request

URL = "https://www.weather.gov/source/nwr/JS/ccl-data.js"
FILE = "nwr_ccl.js"
SCHEMA = """
CREATE TABLE IF NOT EXISTS nwr(id INTEGER PRIMARY KEY, call_sign TEXT, freq_mhz REAL, power_w REAL, status TEXT,
    site TEXT, city TEXT, state TEXT, wfo TEXT, lat REAL, lon REAL, counties TEXT, n_counties INTEGER);
CREATE INDEX IF NOT EXISTS nwr_latlon ON nwr(lat, lon);
"""


def parse(text):
    """The file is 'var cclData = [...]': one object per transmitter."""
    data = json.loads(text[text.index("["): text.rindex("]") + 1])
    out = []
    for t in data:
        try:
            lat, lon, f = float(t["lat"]), float(t["lon"]), float(t["freq"])
        except (KeyError, TypeError, ValueError):
            continue
        cs = [{"county": c.get("county"), "st": c.get("st"), "same": c.get("same"), "part": c.get("remarks") or ""}
              for c in t.get("counties") or []]
        out.append((t.get("callsign"), f, float(t["power"]) if str(t.get("power", "")).replace(".", "").isdigit() else None,
                    (t.get("status") or "").title(), t.get("sitename"), t.get("siteloc"), t.get("sitestate"),
                    (t.get("wfo") or "").replace("|", ", "), lat, lon, json.dumps(cs), len(cs)))
    return out


def run(con, data_dir, fetch=True, log=print):
    path = os.path.join(data_dir, FILE)
    if fetch:
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"})
            with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as out:
                out.write(r.read())
            os.replace(path + ".part", path)
        except Exception as e:
            log(f"  NOAA Weather Radio list not downloaded ({e}); using the saved copy if there is one")
    if not os.path.exists(path):
        raise RuntimeError("no NOAA Weather Radio list yet (needs a connection once)")
    with open(path, encoding="utf-8") as fh:
        rows = parse(fh.read())
    con.executescript(SCHEMA)
    con.execute("DELETE FROM nwr")
    con.executemany("INSERT INTO nwr(call_sign,freq_mhz,power_w,status,site,city,state,wfo,lat,lon,counties,n_counties) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.execute("INSERT OR REPLACE INTO meta VALUES('nwr_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    log(f"  NOAA Weather Radio: {len(rows):,} transmitters")
    return len(rows)


if __name__ == "__main__":
    import sqlite3
    import uls_import
    con = sqlite3.connect(uls_import.DB_PATH, timeout=60)
    print(f"{run(con, uls_import.DATA_DIR):,} NOAA Weather Radio transmitters")
    con.close()
