"""
911 call centres: the FCC's 911 Master PSAP Registry (public domain). The current one comes from the FCC's own page
(https://www.fcc.gov/general/9-1-1-master-psap-registry), which answers automated clients 403: a person downloads its
CSV and tools/psap_registry.py turns it into reference/psap_registry.json (the 30 Oct 2026 registry, 8,933 PSAPs, Cody
11/8). Without that file, the copy on opendata.fcc.gov (dataset dpq5-ta9j), whose rows stop at 2017-10-10. It gives each
PSAP's name, city, county and state but no coordinates, so each is placed at its town's centre (else its county's) from
DAStastic's own place list: a town-level position, not the building.
"""
import json
import os
import re
import time
import urllib.request

URL = "https://opendata.fcc.gov/resource/dpq5-ta9j.json?$limit=20000"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)", "Accept": "application/json"}
REGISTRY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference", "psap_registry.json")


def _as_of():
    """The registry file's date, read from its first bytes (the file is 0.7 MB; this runs when the app starts)."""
    try:
        with open(REGISTRY, encoding="utf-8") as fh:
            m = re.search(r'"as_of":"(\d{4}-\d{2}-\d{2})"', fh.read(2000))
        return m.group(1) if m else None
    except OSError:
        return None


SOURCE_DATE = _as_of() or "2017-10-10"  # the opendata copy's rows stop there
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


def registry_rows(path=None):
    """The current registry's rows in the opendata copy's shape (psap_id, psap_name, city, county, state,
    type_of_change_full_text, date_last_modified), each change code as the FCC's legend words it; None without the file."""
    try:
        with open(path or REGISTRY, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return None
    legend, cols = doc.get("legend") or {}, doc.get("columns") or []
    if not doc.get("rows") or cols[:7] != ["psap_id", "name", "state", "county", "city", "change", "modified"]:
        return None
    return [{"psap_id": r[0], "psap_name": r[1], "state": r[2], "county": r[3], "city": r[4],
             "type_of_change_full_text": " ".join(legend.get(c.strip(), c.strip()) for c in (r[5] or "").split(",") if c.strip()),
             "date_last_modified": r[6]} for r in doc["rows"]]


def run(con, fetch=True, log=None):
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name='place'").fetchone():
        raise RuntimeError("Needs the FCC licences first: 911 centres are placed at the towns that import lists.")
    con.executescript(SCHEMA)
    rows = registry_rows()
    if rows is None:  # no current registry here: the opendata copy (2017)
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
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('psap_as_of', ?)", (SOURCE_DATE,))
    con.commit()
    if log:
        log(f"{len(out):,} PSAPs, {placed:,} placed at a town or county centre")
    return len(out)
