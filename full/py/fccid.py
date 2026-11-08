"""
FCC ID look-ups: the FCC's Equipment Authorization service (OET Lab Services getFCCIDList, public, no key). Give a
grantee code (the first 3 or 5 characters, e.g. BCG) or a full FCC ID (BCG-E2430); back come the matching grants:
grantee, address, grant date and purpose. Frequencies, power and test reports are on the FCC's grant pages, which
take a search form rather than a link, so each result links to that form and to fccid.io (a third-party viewer of
the same public records).

The FCC publishes its grants one device at a time only, but it publishes every grantee code in bulk (FCC open data,
last updated March 2021): DAStastic keeps that list (fcc_grantee), so the maker behind any FCC ID is known offline and
makers turn up in Search. No key: opendata.fcc.gov serves it without one. The FCC's own current list is a download on
its Grantee Search page, which answers a person's browser only: import_grantee_file reads that file (one person does it,
on the PC the site's packs are made from), the site's grantee pack carries it, and every other copy's update job takes it
from there (import_site_grantees) instead of open data. fcc_grantee_src says which list is kept.
"""
import csv
import datetime
import gzip
import html.parser
import io
import json
import os
import re
import sqlite3
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

URL = "https://apps.fcc.gov/OETLabServices/getFCCIDList?fccId={}"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)", "Accept": "application/xml"}
SEARCH_FORM = "https://apps.fcc.gov/oetcf/eas/reports/GenericSearch.cfm"
GRANTEE_API = ("https://opendata.fcc.gov/resource/3b3k-34jp.json?$select=grantee_code,grantee_name,mailing_address,city,state,country,"
               "zip_code,date_received&$order=grantee_code&$limit={}&$offset={}")
GRANTEE_SCHEMA = """CREATE TABLE IF NOT EXISTS fcc_grantee(code TEXT PRIMARY KEY, name TEXT, address TEXT, city TEXT, state TEXT,
    country TEXT, zip TEXT, received TEXT);
CREATE TABLE IF NOT EXISTS fcc_grantee_src(id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT, file TEXT, at TEXT, codes INTEGER);"""
GRANTEE_PAGE = "https://apps.fcc.gov/oetcf/eas/reports/GranteeSearch.cfm"  # "Download all grantees on file with the OET"
GRANTEE_MIN = 1000  # a file with fewer codes isn't the FCC's full list (about 50,000 in 2021)


def grantee_source(con):
    """Which grantee list is kept: {source: 'fcc-download' | 'open-data' | None, file, at, codes, newest}. Reads only: in
    the web version an empty table made here would hide the list in the site's grantee pack (attached as gr)."""
    try:
        r = con.execute("SELECT source, file, at, codes FROM fcc_grantee_src WHERE id = 1").fetchone()
    except sqlite3.Error:
        r = None
    try:
        codes, newest = con.execute("SELECT COUNT(*), MAX(received) FROM fcc_grantee").fetchone()
    except sqlite3.Error:
        codes, newest = 0, None
    return {"source": r[0] if r else ("open-data" if codes else None), "file": r[1] if r else None, "at": r[2] if r else None,
            "codes": codes, "newest": newest, "page": GRANTEE_PAGE, "grants": grants_source(con)}


# ---------------------------------------------------------------- grants of the DAS and signal-booster makers
# Each grant line with its frequency range, from the FCC's Authorization Search in a browser (Formatting Options: XML),
# one search per maker code (Cody 10/31: "yes build it"). Power and rule parts are only on each grant's own FCC page.
DAS_MAKERS = {"S2O": "ADRF", "N52": "ADRF", "P3T": "Fiplex", "SQX": "JDTECK", "PX8": "Comba", "2A8OW": "Comba", "W6U": "SOLiD",
              "TOU": "CommScope", "BCR": "Andrew (CommScope)", "2AVDJ": "Corning", "EZZ": "Bird", "NEO": "Axell Wireless",
              "NVR": "Westell", "CH8": "Westell", "WBK": "BTI Wireless", "UPO": "Zinwave", "HCO": "Dali Wireless", "YET": "Nextivity",
              "RSN": "SureCall", "PWO": "weBoost (Wilson)"}
GRANT_SCHEMA = """CREATE TABLE IF NOT EXISTS fcc_grant(fcc_id TEXT, code TEXT, applicant TEXT, purpose TEXT, granted TEXT, lo REAL, hi REAL);
CREATE INDEX IF NOT EXISTS fcc_grant_id ON fcc_grant(fcc_id);
CREATE INDEX IF NOT EXISTS fcc_grant_code ON fcc_grant(code);
CREATE TABLE IF NOT EXISTS fcc_grant_src(code TEXT PRIMARY KEY, lines INTEGER, devices INTEGER, at TEXT);
CREATE TABLE IF NOT EXISTS fcc_grant_eq(fcc_id TEXT, eq_class TEXT, PRIMARY KEY (fcc_id, eq_class));  -- a device can hold several classes
CREATE TABLE IF NOT EXISTS fcc_grant_watts(fcc_id TEXT, eq_class TEXT, lo REAL, hi REAL, PRIMARY KEY (fcc_id, eq_class, lo, hi));"""
# the signal-booster equipment classes (the search form's Equipment Class codes): each export of one class names its devices'
# class, and Part 90 boosters searched by Power Output in Watts ranges get a power range (the filter keeps a device when any
# of its bands is in the range, so a device has the ranges of its weakest and strongest bands, not a figure per band)
BOOSTER_CLASSES = {"B9A": ("226", "Part 90 Class A booster"), "B9B": ("227", "Part 90 Class B booster"),
                   "B2I": ("225", "Part 20 industrial booster"), "B2P": ("224", "Part 20 provider-specific booster"),
                   "B2W": ("223", "Part 20 wideband consumer booster"), "BOS": ("229", "other signal booster")}
POWER_RANGES = [(0, 0.5), (0.5, 1), (1, 2), (2, 5), (5, 10), (10, 10000)]
GRANT_ALIASES = {"fcc_id": ["fccid"], "applicant": ["applicantname", "grantee", "granteename"], "purpose": ["applicationpurpose", "purpose"],
                 "granted": ["grantdate", "finalactiondate", "dategranted"], "lo": ["lowerfreqmhz", "lowerfrequencyinmhz", "lowerfrequency"],
                 "hi": ["upperfreqmhz", "upperfrequencyinmhz", "upperfrequency"]}


def code_of(fcc_id):
    """The grantee code an FCC ID starts with: 5 characters when it starts with 2-9, else 3 (KDB 204515)."""
    s = (fcc_id or "").strip().upper()
    return s[:5] if s[:1] in "23456789" else s[:3]


def grants_source(con):
    """The kept grants (read only): lines, devices, how many makers (and the DAS ones by name), the booster classes and
    power ranges known, and when they were imported."""
    try:
        lines, devices = con.execute("SELECT COUNT(*), COUNT(DISTINCT fcc_id) FROM fcc_grant").fetchone()
        src = con.execute("SELECT code, at FROM fcc_grant_src").fetchall()
    except sqlite3.Error:
        return {"lines": 0, "devices": 0, "makers": 0, "named": [], "classes": {}, "powered": 0, "at": None}
    try:
        classes = dict(con.execute("SELECT eq_class, COUNT(*) FROM fcc_grant_eq GROUP BY eq_class").fetchall())
        powered = con.execute("SELECT COUNT(DISTINCT fcc_id) FROM fcc_grant_watts").fetchone()[0]
    except sqlite3.Error:
        classes, powered = {}, 0
    return {"lines": lines, "devices": devices, "makers": len({c for c, _ in src}), "named": sorted({DAS_MAKERS[c] for c, _ in src if c in DAS_MAKERS}),
            "classes": classes, "powered": powered, "at": max((a for _, a in src if a), default=None)}


def import_grant_file(con, name, data, eq_class=None, watts=None):
    """An FCC Authorization Search export (XML, or the Excel / web-page forms) in place of the kept lines of the devices it
    holds. A search by Equipment Class says so with eq_class ("B9A"), and one by Power Output with watts ("2-5") plus the
    eq_class it was run for (that class's range only is replaced): the file itself doesn't name either. Returns
    grants_source."""
    if eq_class and eq_class not in BOOSTER_CLASSES:
        raise ValueError(f"Unknown booster class {eq_class}: one of {', '.join(BOOSTER_CLASSES)}.")
    power = None
    if watts:
        try:
            power = tuple(float(x) for x in str(watts).split("-", 1))
        except ValueError:
            power = None
        if power not in POWER_RANGES:
            raise ValueError(f"Unknown power range {watts}: one of {', '.join(f'{lo:g}-{hi:g}' for lo, hi in POWER_RANGES)}.")
    if not data:
        raise ValueError("Pick the file the FCC's Authorization Search saved.")
    table = _grantee_table(name or "the file", data)
    hi = next((i for i, r in enumerate(table[:60]) if "fccid" in [_norm(c) for c in r]), None)
    if hi is None:
        raise ValueError(f"{name} has no FCC ID column, so it isn't an FCC grant search. Nothing was changed.")
    head = [_norm(c) for c in table[hi]]
    col = {f: next((head.index(n) for n in names if n in head), None) for f, names in GRANT_ALIASES.items()}
    cell = lambda r, f: r[col[f]] if col[f] is not None and col[f] < len(r) else None

    def mhz(v):
        try:
            return float(str(v).replace(",", "")) if _clean(v) else None
        except ValueError:
            return None
    rows = []
    for r in table[hi + 1:]:
        fid = re.sub(r"\s+", "", str(cell(r, "fcc_id") or "")).upper()
        if len(fid) < 4 or not _CODE.match(code_of(fid)):
            continue
        rows.append((fid, code_of(fid), _clean(cell(r, "applicant")), _clean(cell(r, "purpose")), _date(cell(r, "granted")),
                     mhz(cell(r, "lo")), mhz(cell(r, "hi"))))
    if not rows:
        raise ValueError(f"{name} has no grants in it. Nothing was changed.")
    codes = sorted({r[1] for r in rows})
    ids = sorted({r[0] for r in rows})
    # each line once: a search again adds no doubles, and searches add up, as one FCC ID can hold bands of several
    # classes (Part 90 public safety and Part 20 cellular) and a class search returns only its own (10/31: replacing a
    # device's lines with each file's lost the other class's bands)
    key = "fcc_id, IFNULL(granted, ''), IFNULL(purpose, ''), IFNULL(lo, -1), IFNULL(hi, -1)"
    con.executescript(GRANT_SCHEMA)
    con.execute(f"DELETE FROM fcc_grant WHERE rowid NOT IN (SELECT MIN(rowid) FROM fcc_grant GROUP BY {key})")
    con.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS fcc_grant_line ON fcc_grant({key})")
    con.executemany("INSERT OR IGNORE INTO fcc_grant VALUES(?,?,?,?,?,?,?)", rows)
    if power:  # this class's devices with a band in this power range: exactly the devices of this search
        con.execute("DELETE FROM fcc_grant_watts WHERE eq_class=? AND lo=? AND hi=?", (eq_class or "", *power))
        con.executemany("INSERT OR IGNORE INTO fcc_grant_watts VALUES(?,?,?,?)", [(i, eq_class or "", *power) for i in ids])
    elif eq_class:  # this class is exactly the devices of this search
        con.execute("DELETE FROM fcc_grant_eq WHERE eq_class=?", (eq_class,))
        con.executemany("INSERT OR IGNORE INTO fcc_grant_eq VALUES(?,?)", [(i, eq_class) for i in ids])
    today = datetime.date.today().isoformat()
    for c in codes:
        n, d = con.execute("SELECT COUNT(*), COUNT(DISTINCT fcc_id) FROM fcc_grant WHERE code=?", (c,)).fetchone()
        con.execute("INSERT OR REPLACE INTO fcc_grant_src VALUES(?,?,?,?)", (c, n, d, today))
    con.commit()
    return dict(grants_source(con), imported={"file": name, "codes": codes, "devices": len(ids), "lines": len(rows),
                                              "eq_class": eq_class, "watts": watts})


def _device_info(con, ids):
    """Each device's booster classes and power ranges: {fcc_id: {"classes": ["B9B", ...], "eq_class": the first (Part 90
    first), "class_name": all of them in words, "watts": [lo, hi] of its strongest band's range, "watts_from": the weakest
    band's range's low end}}."""
    out = {}
    order = list(BOOSTER_CLASSES)
    try:
        for fid, c in con.execute("SELECT fcc_id, eq_class FROM fcc_grant_eq"):
            if fid in ids:
                d = out.setdefault(fid, {"classes": []})
                d["classes"] = sorted(set(d["classes"]) | {c}, key=lambda k: order.index(k) if k in order else 99)
                d["eq_class"] = d["classes"][0]
                d["class_name"] = ", ".join(BOOSTER_CLASSES.get(k, ("", k))[1] for k in d["classes"])
        for fid, lo, hi in con.execute("SELECT fcc_id, lo, hi FROM fcc_grant_watts ORDER BY lo"):
            if fid in ids:
                d = out.setdefault(fid, {})
                d.setdefault("watts_from", lo)
                d["watts"] = [lo, hi]
    except sqlite3.Error:
        pass
    return out


def _bands(pairs):
    return [list(p) for p in sorted({(lo, hi) for lo, hi in pairs if lo is not None and hi is not None})]


def kept_grants(con, q):
    """The kept grants for an FCC ID, or every one of a grantee code: [{fcc_id, grantee, grant_date, purpose, bands}]."""
    if con is None:
        return []
    try:
        if re.fullmatch(r"[A-Z0-9]{3}|[2-9][A-Z0-9]{4}", q):
            rows = con.execute("SELECT fcc_id, applicant, purpose, granted, lo, hi FROM fcc_grant WHERE code=?", (q,)).fetchall()
        else:
            rows = con.execute("SELECT fcc_id, applicant, purpose, granted, lo, hi FROM fcc_grant WHERE replace(fcc_id, '-', '') = ?",
                               (q.replace("-", ""),)).fetchall()
    except sqlite3.Error:
        return []
    by = {}
    for fid, app, purpose, granted, lo, hi in rows:
        g = by.setdefault((fid, granted, purpose), {"fcc_id": fid, "grantee": app or "", "grant_date": granted or "", "purpose": purpose or "",
                                                    "address": "", "view": f"https://fccid.io/{urllib.parse.quote(fid)}", "lines": []})
        g["lines"].append((lo, hi))
    out = [dict(g, bands=_bands(g.pop("lines"))) for g in by.values()]
    info = _device_info(con, {g["fcc_id"] for g in out})
    for g in out:
        g.update(info.get(g["fcc_id"], {}))
    out.sort(key=lambda x: x["grant_date"], reverse=True)
    return out


def boosters_for(con, freqs, limit=40, bands=None, classes=None, min_watts=None):
    """Devices on the kept grants whose frequency lines take in every one of these frequencies (MHz), newest grant first;
    with bands ({name: [MHz, ...]}), also each band's devices on their own (a building often needs several bands that
    no single device is granted for). classes (["B9A", "B9B"]) keeps those booster classes only; min_watts keeps devices
    with a band whose power range reaches it (the FCC's ranges: a device in 2-5 W counts for 2)."""
    bands = {k: sorted({round(float(f), 5) for f in v if f not in (None, "")}) for k, v in (bands or {}).items()}
    fs = sorted({round(float(f), 5) for f in freqs if f not in (None, "")} | {f for v in bands.values() for f in v})
    try:
        rows = con.execute("SELECT fcc_id, code, applicant, granted, lo, hi FROM fcc_grant WHERE lo IS NOT NULL AND hi IS NOT NULL").fetchall()
    except sqlite3.Error:
        rows = []
    by = {}
    for fid, code, app, granted, lo, hi in rows:
        d = by.setdefault(fid, {"fcc_id": fid, "code": code, "maker": DAS_MAKERS.get(code) or app or code, "granted": "", "lines": set()})
        d["granted"] = max(d["granted"], granted or "")
        d["lines"].add((lo, hi))
    info = _device_info(con, set(by))
    for fid, d in by.items():
        d.update(info.get(fid, {}))
    if classes:
        by = {k: d for k, d in by.items() if set(d.get("classes") or []) & set(classes)}
    if min_watts:
        by = {k: d for k, d in by.items() if d.get("watts") and d["watts"][0] >= float(min_watts)}
    covers = lambda d, want: bool(want) and all(any(lo - 1e-6 <= f <= hi + 1e-6 for lo, hi in d["lines"]) for f in want)
    newest = lambda want: sorted((d for d in by.values() if covers(d, want)), key=lambda d: d["granted"], reverse=True)
    shown = lambda d: {"fcc_id": d["fcc_id"], "maker": d["maker"], "lists": lists_for(d["maker"]), "granted": d["granted"], "bands": _bands(d["lines"]),
                       "view": f"https://fccid.io/{urllib.parse.quote(d['fcc_id'])}", "eq_class": d.get("eq_class"),
                       "classes": d.get("classes") or [], "class_name": d.get("class_name"), "watts": d.get("watts"),
                       "watts_from": d.get("watts_from")}
    hits = newest(fs)
    per = []
    for name, want in bands.items():
        h = newest(want)
        per.append({"band": name, "count": len(h), "devices": [shown(d) for d in h[:8]]})
    return {"devices": [shown(d) for d in hits[:limit]], "count": len(hits), "freqs": len(fs), "by_band": per,
            "kept": grants_source(con)}


# the US public safety signal boosters: Part 90 Class A and Class B (47 CFR 90.219), the equipment classes the FCC's
# search calls B9A and B9B. Each one kept becomes a part in the DAS parts catalogue (das.parts_from_grants).
PS_BOOSTER_CLASSES = ("B9A", "B9B")


def record_url(fcc_id):
    """The device's FCC record: fccid.io shows the FCC's own public filings (grant, manual, test reports) at one link;
    the FCC's search (SEARCH_FORM) takes a form, not a link."""
    return f"https://fccid.io/{urllib.parse.quote(fcc_id)}"


def booster_parts(con, classes=PS_BOOSTER_CLASSES):
    """Every device kept whose grant puts it in one of these booster classes, as a parts-catalogue entry: {fcc_id,
    code, maker, model (the FCC ID's product code: the maker's own model name can differ), classes, booster_class
    ("A", "B" or "A, B"), class_name, bands [[lo, hi] MHz], watts [lo, hi] of its strongest band's range, watts_from,
    granted (the original grant), changed (the newest permissive change or new identification, if later), record,
    search}. Public FCC records only, in FCC ID order."""
    classes = tuple(classes)
    try:
        rows = con.execute(f"""SELECT fcc_id, code, applicant, purpose, granted, lo, hi FROM fcc_grant WHERE fcc_id IN
                               (SELECT fcc_id FROM fcc_grant_eq WHERE eq_class IN ({','.join('?' * len(classes))}))""", classes).fetchall()
    except sqlite3.Error:
        return []
    by = {}
    for fid, code, app, purpose, granted, lo, hi in rows:
        d = by.setdefault(fid, {"code": code, "applicant": "", "newest": "", "orig": [], "dates": [], "lines": []})
        if app and (granted or "") >= d["newest"]:
            d["applicant"], d["newest"] = app, granted or ""  # the newest filing's grantee name
        if granted:
            d["dates"].append(granted)
            if (purpose or "").lower().startswith("original"):
                d["orig"].append(granted)
        d["lines"].append((lo, hi))
    info = _device_info(con, set(by))
    out = []
    for fid, d in sorted(by.items()):
        i = info.get(fid, {})
        ps = [c for c in i.get("classes") or [] if c in classes]
        granted = min(d["orig"] or d["dates"] or [""]) or None
        changed = max(d["dates"] or [""]) or None
        out.append({"fcc_id": fid, "code": d["code"], "maker": DAS_MAKERS.get(d["code"]) or d["applicant"] or d["code"],
                    "grantee": d["applicant"], "model": fid[len(d["code"]):].lstrip("-") or fid, "classes": i.get("classes") or [],
                    "booster_class": ", ".join(c[-1] for c in ps), "class_name": i.get("class_name") or "",
                    "bands": _bands(d["lines"]), "watts": i.get("watts"), "watts_from": i.get("watts_from"), "granted": granted,
                    "changed": changed if changed and changed != granted else None, "record": record_url(fid), "search": SEARCH_FORM})
    return out


def _keep_grantees(con, rows, source, file=None, at=None, keep_old=False):
    """Replace the kept list with rows of (code, name, address, city, state, country, zip, received). keep_old keeps the
    codes the new list lacks (the FCC's own list leaves out some old ones, which older devices still carry)."""
    con.executescript(GRANTEE_SCHEMA)
    if keep_old:
        have = {r[0] for r in rows}
        rows = list(rows) + [r for r in con.execute("SELECT * FROM fcc_grantee") if r[0] not in have]
    con.execute("DELETE FROM fcc_grantee")
    con.executemany("INSERT OR REPLACE INTO fcc_grantee VALUES(?,?,?,?,?,?,?,?)", rows)
    n = con.execute("SELECT COUNT(*) FROM fcc_grantee").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO fcc_grantee_src VALUES(1, ?, ?, ?, ?)", (source, file, at or datetime.date.today().isoformat(), n))
    con.commit()
    return n


SITE_GRANTEE = (os.environ.get("RF_RECON_SITE") or "https://codygeraghty-omnyra.github.io/rf-recon/") + "packs/fcc_grantee.rfpack"


def import_site_grantees(con, log=None):
    """The FCC's own list as the DAStastic site carries it (its grantee pack, made from the PC that imported the FCC's
    download), so every other copy gets it without the download. Returns the codes kept, or None when the site's list
    isn't the FCC's own or isn't newer than this copy's."""
    req = urllib.request.Request(SITE_GRANTEE, headers={"User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = gzip.decompress(r.read(80_000_000))
    fd, tmp = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        with open(tmp, "wb") as fh:
            fh.write(raw)
        site = sqlite3.connect(tmp)
        try:
            _take_site_grants(con, site, log)
            theirs, here = grantee_source(site), grantee_source(con)
            if theirs["source"] != "fcc-download" or not theirs["at"]:
                return None
            if here["source"] == "fcc-download" and (here["at"] or "") >= theirs["at"]:
                return None
            rows = site.execute("SELECT code, name, address, city, state, country, zip, received FROM fcc_grantee").fetchall()
        finally:
            site.close()
    finally:
        os.remove(tmp)
    if len(rows) < GRANTEE_MIN:
        return None
    if log:
        log(f"{len(rows):,} grantee codes from the DAStastic site")
    # "the RF Recon site" is the stored marker updater.py and mission.js match on (kept through the rename to DAStastic)
    return _keep_grantees(con, rows, "fcc-download", "the RF Recon site", theirs["at"], keep_old=True)


def _take_site_grants(con, site, log=None):
    """The DAS and booster makers' grants from the site's grantee pack, when they're newer than this copy's."""
    theirs, here = grants_source(site), grants_source(con)
    if not theirs["lines"] or (here["at"] and here["at"] >= (theirs["at"] or "")):
        return
    con.executescript(GRANT_SCHEMA)
    for t in ("fcc_grant", "fcc_grant_src", "fcc_grant_eq", "fcc_grant_watts"):
        con.execute(f"DELETE FROM {t}")
        try:
            cols = ", ".join(r[1] for r in con.execute(f"PRAGMA table_info({t})"))
            con.executemany(f"INSERT INTO {t} VALUES({','.join('?' * len(cols.split(', ')))})", site.execute(f"SELECT {cols} FROM {t}"))
        except sqlite3.Error:  # a site pack from before the booster classes
            pass
    con.commit()
    if log:
        log(f"{theirs['devices']:,} DAS and booster grants from the DAStastic site")


def import_grantees(con, log=None, page=10000):
    """Every FCC grantee code with its company. First the FCC's own list from the DAStastic site when it's newer than this
    copy's; otherwise FCC open data (last updated March 2021), in pages (a slow link still finishes), which replaces the
    list unless the FCC's own list is already here. Returns codes."""
    try:
        n = import_site_grantees(con, log)
        if n is not None:
            return n
    except Exception as e:  # offline, or the site has no grantee pack: the list kept here or open data
        if log:
            log(f"DAStastic site: {e}")
    src = grantee_source(con)
    if src["source"] == "fcc-download":
        if log:
            log(f"kept the FCC's own list, imported {src['at']}")
        return src["codes"]
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
    return _keep_grantees(con, [(r["grantee_code"].strip().upper(), _clean(r.get("grantee_name")), _clean(r.get("mailing_address")),
                                 _clean(r.get("city")), _clean(r.get("state")), _clean(r.get("country")), _clean(r.get("zip_code")),
                                 (r.get("date_received") or "")[:10] or None)
                                for r in rows if (r.get("grantee_code") or "").strip()], "open-data")


def _clean(v):
    v = " ".join(str(v).split()) if v is not None else ""  # tabs and runs of spaces as one space
    return None if not v or v.upper() in ("N/A", "NA", "NIL", "NONE", "NULL", "-", ".") else v


# the column names the FCC's download and its open data use (compared lower-case, letters and digits only)
GRANTEE_ALIASES = {
    "code": ["granteecode", "code"],
    "name": ["granteename", "name", "companyname", "company", "applicantname", "applicant"],
    "address": ["mailingaddress", "address", "address1", "addressline1", "street", "streetaddress"],
    "address2": ["address2", "addressline2"],  # not the FCC's po_box: it often repeats the zip
    "city": ["city"],
    "state": ["state", "stateprovince", "province"],
    "country": ["country"],
    "zip": ["zipcode", "zip", "postalcode", "zippostalcode"],
    "received": ["datereceived", "received", "dategranted", "registrationdate", "datecreated", "date"],
}
_norm = lambda s: re.sub(r"[^a-z0-9]", "", str(s or "").lower())
_CODE = re.compile(r"^(?:[A-Z0-9]{3}|[2-9][A-Z0-9]{4})$")


class _Cells(html.parser.HTMLParser):
    """The rows of every table in a page (an Excel export that is really a web page)."""
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def _grantee_table(name, data):
    """The FCC's download as rows of cells, whatever shape it came in: a zip, Excel, a web-page table, XML, JSON, or
    comma / tab / pipe separated text."""
    if data[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(data))
        if any(n.startswith("xl/worksheets/") for n in z.namelist()):  # an Excel workbook
            import das
            return das._xlsx_table(data)
        big = max((i for i in z.infolist() if not i.is_dir()), key=lambda i: i.file_size, default=None)
        if big is None:
            raise ValueError(f"{name} is an empty zip.")
        return _grantee_table(big.filename, z.read(big))
    if data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise ValueError(f"{name} is an old-style Excel file (.xls): open it in Excel and save it as .xlsx or CSV, then import that.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", "replace")
    s = text.lstrip()
    if s[:1] in "[{":
        j = json.loads(s)
        if isinstance(j, dict):
            j = next((v for v in j.values() if isinstance(v, list) and v and isinstance(v[0], dict)), [j])
        head = []
        for r in j:
            head += [k for k in r if k not in head] if isinstance(r, dict) else []
        return [head] + [[r.get(k) for k in head] for r in j if isinstance(r, dict)]
    if s[:1] == "<":
        if re.search(r"<t[dh][\s>]", s[:500000], re.I):
            p = _Cells()
            p.feed(s)
            return p.rows
        try:
            root = ET.fromstring(data)  # the bytes, so the file's own encoding line is honoured (the FCC's says ISO-8859-1)
        except ET.ParseError:  # the FCC's exports leave some "&" bare ("Design & Development"): escape those and read again
            fixed = re.sub(r"&(?!(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);)", "&amp;", s)
            root = ET.fromstring(re.sub(r'^(<\?xml[^>]*?)encoding="[^"]*"', r'\1encoding="UTF-8"', fixed).encode("utf-8"))
        # the element holding the most records: children that have fields of their own (not the most children, which a
        # short file's one record would win with its fields)
        best = max(root.iter(), key=lambda e: sum(1 for c in e if len(c)))
        recs = [{c.tag.split("}")[-1]: (c.text or "").strip() for c in r} or dict(r.attrib) for r in best]
        head = []
        for r in recs:
            head += [k for k in r if k not in head]
        return [head] + [[r.get(k) for k in head] for r in recs]
    try:
        dialect = csv.Sniffer().sniff(s[:20000], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return list(csv.reader(io.StringIO(s), dialect))


def _date(v):
    """A received date as YYYY-MM-DD, from the forms the FCC and Excel write; None when it can't be read."""
    v = _clean(v)
    if not v:
        return None
    if re.fullmatch(r"\d{5}(\.\d+)?", v):  # an Excel day number
        return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(float(v)))).isoformat()
    m = re.match(r"\d{4}-\d{2}-\d{2}|\d{4}/\d{1,2}/\d{1,2}|\d{1,2}/\d{1,2}/\d{2,4}", v)
    for f in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y", "%d-%b-%y", "%b %d, %Y"):
        try:
            return datetime.datetime.strptime(m.group(0) if m else v, f).date().isoformat()
        except ValueError:
            continue
    return None


def import_grantee_file(con, name, data):
    """The FCC's own grantee list, downloaded in a browser from its Grantee Search ("Download all grantees on file with
    the OET"), in place of the kept one. Refuses a file that isn't the full list, so nothing is lost by a wrong pick."""
    if not data:
        raise ValueError("Pick the file the FCC's Grantee Search downloaded.")
    table = _grantee_table(name or "the file", data)
    is_head = lambda r: "granteecode" in [_norm(c) for c in r] or ("code" in [_norm(c) for c in r] and
                                                                 any(_norm(c) in GRANTEE_ALIASES["name"] for c in r))
    hi = next((i for i, r in enumerate(table[:60]) if is_head(r)), None)
    if hi is None:
        raise ValueError(f"{name} has no Grantee Code column, so it isn't the FCC's grantee list. Nothing was changed.")
    head = [_norm(c) for c in table[hi]]
    col = {}
    for field, names in GRANTEE_ALIASES.items():
        col[field] = next((head.index(n) for n in names if n in head), None)
    cell = lambda r, f: r[col[f]] if col[f] is not None and col[f] < len(r) else None
    rows, seen = [], set()
    for r in table[hi + 1:]:
        code = re.sub(r"\s+", "", str(cell(r, "code") or "")).upper()
        if not _CODE.match(code) or code in seen:
            continue
        seen.add(code)
        addr = ", ".join(x for x in (_clean(cell(r, "address")), _clean(cell(r, "address2"))) if x) or None
        rows.append((code, _clean(cell(r, "name")), addr, _clean(cell(r, "city")), _clean(cell(r, "state")),
                     _clean(cell(r, "country")), _clean(cell(r, "zip")), _date(cell(r, "received"))))
    if len(rows) < GRANTEE_MIN:
        raise ValueError(f"{name} has {len(rows):,} grantee codes; the FCC's full list has over 50,000. Nothing was changed.")
    con.executescript(GRANTEE_SCHEMA)
    old = {r[0] for r in con.execute("SELECT code FROM fcc_grantee")}
    _keep_grantees(con, rows, "fcc-download", name, keep_old=True)
    return dict(grantee_source(con), before=len(old), new=len(seen - old))


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
    out = dict(zip(keys, r))
    out["lists"] = lists_for(out.get("name"))
    return out


def lists_for(name):
    """What the FCC's prohibited-entity lists say about a grantee (prohibited.py), or None when nothing."""
    import prohibited
    got = prohibited.check(maker=name)
    return got if got["listed"] or got["same_name"] else None


def lookup(q, limit=300, con=None):
    q = re.sub(r"\s+", "", (q or "")).upper()
    if not re.match(r"^[A-Z0-9]{3,5}(-?[A-Z0-9-]{0,40})?$", q):
        raise ValueError("Enter a grantee code (3 or 5 characters, e.g. BCG) or an FCC ID (e.g. BCG-E2430).")
    maker = grantee(con, q) if con is not None else None
    kept = kept_grants(con, q)  # a DAS or booster maker's grants, with each one's frequency ranges
    try:
        with urllib.request.urlopen(urllib.request.Request(URL.format(urllib.parse.quote(q)), headers=UA), timeout=40) as r:
            data = r.read(20_000_000)
    except OSError as e:
        if maker or kept:  # offline: the kept lists still say who makes it, and for those makers what it's granted for
            return {"query": q, "count": len(kept), "results": kept[:limit], "search_form": SEARCH_FORM, "maker": maker, "offline": True,
                    "kept": bool(kept)}
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
    bands, info = {}, {}  # the FCC's list has no frequencies, class or power: the kept grants add them
    for k in kept:
        bands.setdefault(k["fcc_id"].replace("-", ""), []).extend(map(tuple, k["bands"]))
        info[k["fcc_id"].replace("-", "")] = {f: k[f] for f in ("classes", "eq_class", "class_name", "watts", "watts_from") if f in k}
    for o in out:
        o["bands"] = _bands(bands.get(o["fcc_id"].replace("-", ""), []))
        o.update(info.get(o["fcc_id"].replace("-", ""), {}))
    out.sort(key=lambda x: x["grant_date"], reverse=True)
    return {"query": q, "count": len(out), "results": out[:limit], "search_form": SEARCH_FORM, "maker": maker}
