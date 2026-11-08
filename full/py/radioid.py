"""
RadioID.net look-ups: who a DMR or NXDN radio ID belongs to (call sign, name, city, state, country). Its terms allow
look-ups but no mirroring, bulk export or competing directory (checked 2026-10-28), so DAStastic asks one ID at a time,
only when someone asks, and keeps each answer 30 days so the same ID isn't asked twice.
"""
import json
import re
import time
import urllib.parse

import connectors

URL = {"dmr": "https://radioid.net/api/dmr/user/?", "nxdn": "https://radioid.net/api/nxdn/user/?"}
KEEP_DAYS = 30
SCHEMA = """
CREATE TABLE IF NOT EXISTS radioid_cache(kind TEXT, rid INTEGER, answer TEXT, fetched_at REAL, PRIMARY KEY(kind, rid));
"""
FIELDS = ("callsign", "fname", "surname", "city", "state", "country", "remarks")


def lookup(con, rid, kind="dmr"):
    """{found, id, callsign, name, city, state, country, source} for one radio ID."""
    kind = (kind or "dmr").lower()
    if kind not in URL:
        raise ValueError("kind is dmr or nxdn")
    if not re.fullmatch(r"\d{1,8}", str(rid)):
        raise ValueError("A radio ID is a number of up to 8 digits.")
    rid = int(rid)
    con.executescript(SCHEMA)
    r = con.execute("SELECT answer, fetched_at FROM radioid_cache WHERE kind=? AND rid=?", (kind, rid)).fetchone()
    if r and time.time() - r[1] < KEEP_DAYS * 86400:
        return json.loads(r[0])
    data = connectors.http_json(URL[kind] + urllib.parse.urlencode({"id": rid}), timeout=20)
    hit = next((x for x in (data or {}).get("results") or [] if int(x.get("id") or 0) == rid), None)
    out = {"found": bool(hit), "id": rid, "kind": kind, "source": "RadioID.net", "looked_up": time.strftime("%Y-%m-%d")}
    if hit:
        out.update({k: hit.get(k) for k in FIELDS})
        out["name"] = " ".join(x for x in (hit.get("fname"), hit.get("surname")) if x)
    con.execute("INSERT OR REPLACE INTO radioid_cache VALUES(?,?,?,?)", (kind, rid, json.dumps(out), time.time()))
    con.commit()
    return out
