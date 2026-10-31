"""
911 call centres: the FCC's 911 Master PSAP Registry (opendata.fcc.gov, dataset dpq5-ta9j, public domain). Its rows
were last updated 2017-10-10, so centres opened, merged or closed since then aren't reflected. It gives each PSAP's
name, city, county and state but no coordinates, so each is placed at its town's centre (else its county's) from
RF Recon's own place list: a town-level position, not the building.
"""
import json
import time
import urllib.request

URL = "https://opendata.fcc.gov/resource/dpq5-ta9j.json?$limit=20000"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)", "Accept": "application/json"}
SOURCE_DATE = "2017-10-10"
SCHEMA = """
CREATE TABLE IF NOT EXISTS psap(psap_id TEXT PRIMARY KEY, name TEXT, city TEXT, county TEXT, state TEXT, change TEXT,
    modified TEXT, lat REAL, lon REAL, located TEXT);
CREATE INDEX IF NOT EXISTS psap_latlon ON psap(lat, lon);
"""


def locate(con, city, county, state):
    """The town's centre, else the county's, from the place list (built from the FCC data and Census counties)."""
    for name, kind_sql, what in ((city, "kind <> 'county'", "town centre"), (county, "kind = 'county'", "county centre"),
                                 (city, "kind = 'county'", "county centre")):
        if not name:
            continue
        r = con.execute(f"SELECT lat, lon FROM place WHERE name = ? AND state = ? AND {kind_sql} ORDER BY n DESC LIMIT 1",
                        (name.strip(), state)).fetchone()
        if r and r[0] is not None:
            return r[0], r[1], what
    return None, None, "not placed"


def run(con, fetch=True, log=None):
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='place'").fetchone():
        raise RuntimeError("Needs the FCC licences first: 911 centres are placed at the towns that import lists.")
    con.executescript(SCHEMA)
    with urllib.request.urlopen(urllib.request.Request(URL, headers=UA), timeout=180) as r:
        data = r.read(30_000_000)
    rows = json.loads(data)
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("The FCC's PSAP registry came back empty.")
    out, placed = [], 0
    for p in rows:
        pid, state = str(p.get("psap_id") or "").strip(), (p.get("state") or "").strip().upper()[:2]
        if not pid:
            continue
        la, lo, how = locate(con, p.get("city"), p.get("county"), state)
        placed += la is not None
        out.append((pid, (p.get("psap_name") or "")[:200], p.get("city"), p.get("county"), state,
                    (p.get("type_of_change_full_text") or "")[:200], (p.get("date_last_modified") or "")[:10], la, lo, how))
    con.execute("DELETE FROM psap")
    con.executemany("INSERT OR REPLACE INTO psap VALUES(?,?,?,?,?,?,?,?,?,?)", out)
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('psap_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    if log:
        log(f"{len(out):,} PSAPs, {placed:,} placed at a town or county centre")
    return len(out)
