"""
Microwave links filed but not yet granted: the FCC's ULS application file a_micro.zip (about 445 MB, public domain).
An application whose status is "2" is pending (checked 2026-11-02: 3,322 of 2.2 million, 3,175 filed in 2026; "Q" is an
accepted notification, "G" granted, "D" dismissed, "W" withdrawn). Each pending application's paths are placed at both
ends from its own locations, like the granted links (uls_import.build_links), into mw_pending: the backhaul that is
coming, before it shows in the licence file.
"""
import math
import os
import time
import zipfile

import uls_import
from uls_import import dms, find_member, g, iter_records, to_float

URL = "https://data.fcc.gov/download/pub/uls/complete/a_micro.zip"
PENDING = "2"
SCHEMA = """
CREATE TABLE IF NOT EXISTS mw_pending(usi INTEGER, file_number TEXT, purpose TEXT, received TEXT, call_sign TEXT,
    licensee TEXT, path_num INTEGER, tx_lat REAL, tx_lon REAL, tx_city TEXT, tx_state TEXT, rx_lat REAL, rx_lon REAL,
    rx_city TEXT, rx_state TEXT, dist_km REAL, freqs TEXT);
CREATE INDEX IF NOT EXISTS mwp_tx ON mw_pending(tx_lat, tx_lon);
CREATE INDEX IF NOT EXISTS mwp_rx ON mw_pending(rx_lat, rx_lon);
"""
PURPOSE = {"NE": "new", "MD": "modification", "AM": "amendment", "RO": "renewal and modification", "AU": "administrative update",
           "RL": "renewal", "NT": "notification", "RM": "renewal and modification", "EX": "extension"}


def km(a1, o1, a2, o2):
    p1, p2 = math.radians(a1), math.radians(a2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(o2 - o1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1, math.sqrt(h)))


def parse(path, log=print):
    """The pending applications' links in a_micro.zip: a list of mw_pending rows."""
    zf = zipfile.ZipFile(path)
    apps = {}
    for f in iter_records(zf, find_member(zf, "AD"), "AD"):
        if g(f, 5) == PENDING:
            apps[int(g(f, 1) or 0)] = {"file": g(f, 2), "purpose": PURPOSE.get(g(f, 4), g(f, 4)), "received": g(f, 10)}
    log(f"  {len(apps):,} pending applications")
    for f in iter_records(zf, find_member(zf, "HD"), "HD"):
        a = apps.get(int(g(f, 1) or 0))
        if a is not None:
            a["call_sign"] = g(f, 4)  # empty on a new application: no call sign until it's granted
    for f in iter_records(zf, find_member(zf, "EN"), "EN"):
        a = apps.get(int(g(f, 1) or 0))
        if a is not None and g(f, 5) in ("L", "") and not a.get("licensee"):
            a["licensee"] = g(f, 7) or " ".join(x for x in (g(f, 8), g(f, 10)) if x)
    locs, freqs, paths = {}, {}, []
    for f in iter_records(zf, find_member(zf, "LO"), "LO"):
        usi = int(g(f, 1) or 0)
        if usi in apps and g(f, 5) != "D":  # D: the application deletes this location
            la, lo = dms(g(f, 19), g(f, 20), g(f, 21), g(f, 22)), dms(g(f, 23), g(f, 24), g(f, 25), g(f, 26))
            if la is not None and lo is not None:
                locs[(usi, int(g(f, 8) or 0))] = (la, lo, g(f, 12), g(f, 14).upper())  # 11 is the street address
    for f in iter_records(zf, find_member(zf, "FR"), "FR"):
        usi = int(g(f, 1) or 0)
        fm = to_float(g(f, 10))
        if usi in apps and g(f, 5) != "D" and fm:
            freqs.setdefault((usi, int(g(f, 6) or 0), int(g(f, 7) or 0)), set()).add(fm)
    for f in iter_records(zf, find_member(zf, "PA"), "PA"):
        usi = int(g(f, 1) or 0)
        if usi in apps and g(f, 5) != "D":
            paths.append((usi, int(g(f, 6) or 0), int(g(f, 7) or 0), int(g(f, 8) or 0), int(g(f, 9) or 0)))
    out = []
    for usi, num, tx, tx_ant, rx in paths:
        a, b = locs.get((usi, tx)), locs.get((usi, rx))
        if not a or not b:
            continue
        d = km(a[0], a[1], b[0], b[1])
        if not 0.05 <= d <= 250:  # one spot (an area licence's mobiles) or a bad coordinate
            continue
        app = apps[usi]
        fs = ",".join(f"{x:.4f}" for x in sorted(freqs.get((usi, tx, tx_ant), ()))[:12])
        out.append((usi, app["file"], app["purpose"], app["received"], app.get("call_sign") or "", app.get("licensee") or "",
                    num, a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3], round(d, 2), fs))
    log(f"  {len(out):,} pending links placed at both ends")
    return out


def run(con, log=print):
    """Download a_micro.zip when the FCC's copy is newer than the one here (weekly), then rebuild mw_pending."""
    path = os.path.join(uls_import.DATA_DIR, "a_micro.zip")
    have = time.strftime("%Y-%m-%d %H:%M", time.gmtime(os.path.getmtime(path))) if os.path.exists(path) else None
    remote = uls_import.last_modified(URL)
    if not have or remote is None or remote > have:
        uls_import.http_get(URL, path, log=lambda m, end="\n": log(m))
    rows = parse(path, log)
    con.executescript(SCHEMA)
    con.execute("DELETE FROM mw_pending")
    con.executemany(f"INSERT INTO mw_pending VALUES({','.join('?' * 17)})", rows)
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('mw_pending_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    return len(rows)
