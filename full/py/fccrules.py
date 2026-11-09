"""The FCC rules watch (Cody 11/8): new filings in the FCC dockets that change DAS and ERCES work, from the FCC's ECFS
public API (https://publicapi.fcc.gov/ecfs/filings), daily. It needs an api.data.gov key (free, in Cody's name; saved
in DAStastic's keys as api_data_gov_key); Cody accepted the FCC's API terms for DAStastic on 11/8, and the page that
shows the filings carries the FCC's attribution line.

Each docket is asked for its newest filings (sorted by date disseminated, newest first); a filing not seen before is
kept with its type, filers, date and document links, and counts as new until it is 30 days old. Requests go through
datadesk.fetchkit: a refusal stops the run and the Data desk files it for a person; nothing is tried another way.
"""
import json
import sqlite3
import time
import urllib.parse

from datadesk import fetchkit

API = "https://publicapi.fcc.gov/ecfs/filings"
UA = "DAStastic data desk (FCC rules watch; contact via omnyra.ai)"
ATTRIBUTION = "This product uses the FCC Data API but is not endorsed or certified by the FCC."
DOCKETS = {  # docket -> what it is, in the words a DAS team uses
    "10-4": "Signal boosters (Part 20 and Part 90 booster rules)",
    "07-100": "The 4.9 GHz public safety band",
    "13-42": "The T-band (470-512 MHz) public safety channels",
    "18-89": "The Covered List (supply chain)",
    "24-136": "Equipment authorization integrity (prohibited entities)",
    "21-479": "Next Generation 911",
    "07-114": "Wireless 911 location accuracy",
}
PER_DOCKET = 25
NEW_DAYS = 30
SCHEMA = """
CREATE TABLE IF NOT EXISTS fcc_filing(id TEXT PRIMARY KEY, docket TEXT, received TEXT, disseminated TEXT, type TEXT,
    filers TEXT, title TEXT, link TEXT, seen REAL);
CREATE INDEX IF NOT EXISTS fcc_filing_docket ON fcc_filing(docket, disseminated);
"""


def _filing(f, docket):
    st = f.get("submissiontype") or {}
    docs = f.get("documents") or []
    fid = str(f.get("id_submission") or "")
    return {"id": fid, "docket": docket, "received": (f.get("date_received") or "")[:10],
            "disseminated": (f.get("date_disseminated") or "")[:10],
            "type": (st.get("description") or "").capitalize() if isinstance(st, dict) else str(st),
            "filers": ", ".join(x.get("name", "") for x in f.get("filers") or [] if isinstance(x, dict))[:300],
            "title": (docs[0].get("filename") if docs and isinstance(docs[0], dict) else "") or "",
            "link": f"https://www.fcc.gov/ecfs/search/search-filings/filing/{fid}" if fid else ""}


def fetch(f, key, docket):
    q = urllib.parse.urlencode({"api_key": key, "proceedings.name": docket, "sort": "date_disseminated,DESC", "limit": PER_DOCKET})
    r = f.get(f"{API}?{q}", accept="application/json")
    try:
        doc = json.loads(r.body.decode("utf-8", "replace"))
    except ValueError:
        raise ValueError("the FCC's ECFS API didn't answer with JSON") from None
    if isinstance(doc, dict) and doc.get("error"):
        raise fetchkit.Refused(API, f"answered: {str(doc['error'])[:120]}", 403)
    # express comments (a few lines anyone can type in) are left out: the watch is for filings a DAS team acts on
    return [_filing(x, docket) for x in (doc.get("filing") or doc.get("filings") or [])
            if isinstance(x, dict) and str(x.get("express_comment") or "0").lower() not in ("1", "true")]


def run(db_path, key, dockets=None, fetcher=None, now=None):
    """Ask each docket for its newest filings and keep the ones not seen. {"message", "rows", "new"}."""
    if not key:
        raise RuntimeError("needs an api.data.gov key (free): saved on Data & updates, Keys")
    now = now or time.time()
    f = fetcher or fetchkit.Fetcher(UA, max_bytes=4 * 1024 * 1024, timeout=30)
    con = sqlite3.connect(db_path, timeout=60)
    try:
        con.executescript(SCHEMA)
        new = 0
        for docket in dockets or DOCKETS:
            for x in fetch(f, key, docket):
                if not x["id"]:
                    continue
                cur = con.execute("INSERT OR IGNORE INTO fcc_filing VALUES(?,?,?,?,?,?,?,?,?)",
                                  (x["id"], docket, x["received"], x["disseminated"], x["type"], x["filers"], x["title"], x["link"], now))
                if cur.rowcount and x["disseminated"] >= time.strftime("%Y-%m-%d", time.gmtime(now - NEW_DAYS * 86400)):
                    new += 1  # new to DAStastic and out in the last NEW_DAYS (a first run doesn't call years-old filings new)
        con.commit()
        total = con.execute("SELECT COUNT(*) FROM fcc_filing").fetchone()[0]
    finally:
        con.close()
    return {"message": f"{len(dockets or DOCKETS)} dockets checked: {new} new filing{'s' if new != 1 else ''}", "rows": new, "new": new,
            "total": total}


def recent(con, now=None, days=NEW_DAYS, limit=60):
    """The filings the FCC put out in the last `days`, newest first, with what each docket is: for Data & updates."""
    now = now or time.time()
    since = time.strftime("%Y-%m-%d", time.gmtime(now - days * 86400))
    try:
        rows = con.execute("SELECT id, docket, received, disseminated, type, filers, title, link FROM fcc_filing WHERE disseminated >= ? "
                           "ORDER BY disseminated DESC LIMIT ?", (since, limit)).fetchall()
    except sqlite3.Error:
        rows = []
    cols = ("id", "docket", "received", "disseminated", "type", "filers", "title", "link")
    return {"filings": [dict(zip(cols, r), about=DOCKETS.get(r[1], "")) for r in rows], "dockets": DOCKETS,
            "attribution": ATTRIBUTION, "days": days}
