"""
FCC ID look-ups: the FCC's Equipment Authorization service (OET Lab Services getFCCIDList, public, no key). Give a
grantee code (the first 3 or 5 characters, e.g. BCG) or a full FCC ID (BCG-E2430); back come the matching grants:
grantee, address, grant date and purpose. Frequencies, power and test reports are on the FCC's grant pages, which
take a search form rather than a link, so each result links to that form and to fccid.io (a third-party viewer of
the same public records).

The FCC publishes its grants one device at a time only, but it publishes every grantee code in bulk (FCC open data,
last updated March 2021): RF Recon keeps that list (fcc_grantee), so the maker behind any FCC ID is known offline and
makers turn up in Search. No key: opendata.fcc.gov serves it without one. The FCC's own current list is a download on
its Grantee Search page, which answers a person's browser only: import_grantee_file reads that file, and from then on
the open-data job leaves the newer list alone (fcc_grantee_src says which list is kept).
"""
import csv
import datetime
import html.parser
import io
import json
import re
import sqlite3
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
            "codes": codes, "newest": newest, "page": GRANTEE_PAGE}


def _keep_grantees(con, rows, source, file=None):
    """Replace the kept list with rows of (code, name, address, city, state, country, zip, received)."""
    con.executescript(GRANTEE_SCHEMA)
    con.execute("DELETE FROM fcc_grantee")
    con.executemany("INSERT OR REPLACE INTO fcc_grantee VALUES(?,?,?,?,?,?,?,?)", rows)
    n = con.execute("SELECT COUNT(*) FROM fcc_grantee").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO fcc_grantee_src VALUES(1, ?, ?, ?, ?)", (source, file, datetime.date.today().isoformat(), n))
    con.commit()
    return n


def import_grantees(con, log=None, page=10000):
    """Every FCC grantee code with its company, in pages (a slow link still finishes). Replaces the list. Returns codes.
    Leaves a list imported from the FCC's own download alone: that one is newer than open data's (March 2021)."""
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
    v = str(v).strip() if v is not None else ""
    return None if not v or v.upper() in ("N/A", "NA", "NIL", "NONE", "NULL", "-", ".") else v


# the column names the FCC's download and its open data use (compared lower-case, letters and digits only)
GRANTEE_ALIASES = {
    "code": ["granteecode", "code"],
    "name": ["granteename", "name", "companyname", "company", "applicantname", "applicant"],
    "address": ["mailingaddress", "address", "address1", "addressline1", "street", "streetaddress"],
    "address2": ["address2", "addressline2", "pobox"],
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
        root = ET.fromstring(s.encode("utf-8"))
        best = max(root.iter(), key=lambda e: len(e))  # the element holding the most records
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
    _keep_grantees(con, rows, "fcc-download", name)
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
