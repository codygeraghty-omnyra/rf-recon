"""
FCC ID look-ups: the FCC's Equipment Authorization service (OET Lab Services getFCCIDList, public, no key). Give a
grantee code (the first 3 or 5 characters, e.g. BCG) or a full FCC ID (BCG-E2430); back come the matching grants:
grantee, address, grant date and purpose. Frequencies, power and test reports are on the FCC's grant pages, which
take a search form rather than a link, so each result links to that form and to fccid.io (a third-party viewer of
the same public records).

The FCC publishes its grants one device at a time only, but it publishes every grantee code in bulk (FCC open data,
last updated March 2021): RF Recon keeps that list (fcc_grantee), so the maker behind any FCC ID is known offline and
makers turn up in Search. No key: opendata.fcc.gov serves it without one.
"""
import json
import re
import sqlite3
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

URL = "https://apps.fcc.gov/OETLabServices/getFCCIDList?fccId={}"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)", "Accept": "application/xml"}
SEARCH_FORM = "https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm"
GRANTEE_API = ("https://opendata.fcc.gov/resource/3b3k-34jp.json?$select=grantee_code,grantee_name,mailing_address,city,state,country,"
               "zip_code,date_received&$order=grantee_code&$limit={}&$offset={}")
GRANTEE_SCHEMA = """CREATE TABLE IF NOT EXISTS fcc_grantee(code TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT, state TEXT,
    country TEXT, zip TEXT, received TEXT);"""


def import_grantees(con, log=None, page=10000):
    """Every FCC grantee code with its company, in pages (a slow link still finishes). Replaces the list. Returns codes."""
    rows = []
    while True:
        req = urllib.request.Request(GRANTEE_API.format(page, len(rows)), headers=dict(UA, Accept="application/json"))
        with urllib.request.urlopen(req, timeout=300) as r:
            batch = json.loads(r.read(40_000_000))
        if not isinstance(batch, list):
            raise ValueError("FCC open data answered with something other than a list of grantees.")
        rows += batch
        if log:
            log(f"{len(rows):,} grantee codes")
        if len(batch) < page:
            break
    if not rows:
        raise ValueError("FCC open data sent no grantees.")
    clean = lambda v: None if not v or v.strip().upper() in ("N/A", "NA", "NIL", "NONE", "-", ".") else v.strip()
    con.executescript(GRANTEE_SCHEMA)
    con.execute("DELETE FROM fcc_grantee")
    con.executemany("INSERT OR REPLACE INTO fcc_grantee VALUES(?,?,?,?,?,?,?,?)",
                    [(r["grantee_code"].strip().upper(), clean(r.get("grantee_name")), clean(r.get("mailing_address")), clean(r.get("city")),
                      clean(r.get("state")), clean(r.get("country")), clean(r.get("zip_code")), (r.get("date_received") or "")[:10] or None)
                     for r in rows if (r.get("grantee_code") or "").strip()])
    con.commit()
    return con.execute("SELECT COUNT(*) FROM fcc_grantee").fetchone()[0]


def grantee(con, q):
    """The maker behind an FCC ID or grantee code, from the kept list (5-character codes start with 2), or None."""
    q = re.sub(r"\s+", "", q or "").upper()
    code = q[:5] if q.startswith("2") else q[:3]
    try:
        r = con.execute("SELECT * FROM fcc_grantee WHERE code=?", (code,)).fetchone()
    except sqlite3.Error:
        return None
    if not r:
        return None
    keys = ("code", "name", "address", "city", "state", "country", "zip", "received")
    return dict(zip(keys, r))


def lookup(q, limit=300, con=None):
    q = re.sub(r"\s+", "", (q or "")).upper()
    if not re.match(r"^[A-Z0-9]{3,5}(-?[A-Z0-9-]{0,40})?$", q):
        raise ValueError("Enter a grantee code (3 or 5 characters, e.g. BCG) or an FCC ID (e.g. BCG-E2430).")
    maker = grantee(con, q) if con is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(URL.format(urllib.parse.quote(q)), headers=UA), timeout=40) as r:
            data = r.read(20_000_000)
    except OSError as e:
        if maker:  # offline: the kept grantee list still says who makes it
            return {"query": q, "count": 0, "results": [], "search_form": SEARCH_FORM, "maker": maker, "offline": True}
        raise ValueError(f"The FCC didn't answer the look-up ({e}); try again in a minute.")
    if b"<!DOCTYPE" in data[:2000].upper():
        raise ValueError("The FCC's answer had a DOCTYPE; refused.")
    out = []
    for it in ET.fromstring(data):
        g = lambda k: (it.findtext(k) or "").strip()
        fid = g("FCCId")
        mm, dd, yy = (g("grantDate").split("/") + ["", "", ""])[:3]
        out.append({"fcc_id": fid, "grantee": g("grantee"), "grant_date": f"{yy}-{mm}-{dd}" if yy else g("grantDate"),
                    "purpose": g("applicationPurpose"), "address": ", ".join(x for x in (g("address"), g("city"), g("state"), g("zipCode"), g("country")) if x),
                    "view": f"https://fccid.io/{urllib.parse.quote(fid)}" if fid else None})
    out.sort(key=lambda x: x["grant_date"], reverse=True)
    return {"query": q, "count": len(out), "results": out[:limit], "search_form": SEARCH_FORM, "maker": maker}
