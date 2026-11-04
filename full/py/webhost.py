"""RF Recon (beta), full web version: the PC app's own server (app.py) answering the page's /api/ requests inside the
browser (Pyodide, started by pyworker.js), so missions, captures, the field log, labels, DAS jobs, talk groups and your
own layers work as they do on the PC.

Your work is /rfr/uls.db, kept in this browser (IndexedDB) and never sent anywhere; it holds only the PC's own-work
tables (app.USER_TABLES). The FCC data is the pack in use (/pack.db), attached to every connection, with a few temporary
views so the PC's queries find it under the PC's names: broadcast's AM / FM / TV column, the meta keys, and the history
files' expired licences and removed entries (fieldpack.build_history) beside the current ones."""
import email.message
import io
import json
import os
import sqlite3
import sys

os.environ.setdefault("RF_RECON_DATA", "/rfr")
os.environ.setdefault("RF_RECON_DAS", "/rfr/DAS jobs")
os.environ.setdefault("CROWD_DB", "/rfr/crowd.db")
os.environ.setdefault("RF_RECON_PACKS", "/rfr/field packs")
sys.path.insert(0, "/app")

try:
    import pyodide_http  # urllib through the browser: terrain tiles, building outlines, the FCC ID search
    pyodide_http.patch_all()
except ImportError:  # desktop Python, for tests (tests/test_webhost.py)
    pass

import concurrent.futures  # noqa: E402
import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
import urllib.request  # noqa: E402
from xml.sax.saxutils import quoteattr  # noqa: E402


class _InOrder(concurrent.futures.Executor):
    """A thread pool's place in the browser, which has no threads: each task runs as it's submitted (terrain tiles)."""
    def __init__(self, *a, **k):
        pass

    def submit(self, fn, *a, **k):
        f = concurrent.futures.Future()
        try:
            f.set_result(fn(*a, **k))
        except Exception as e:
            f.set_exception(e)
        return f


concurrent.futures.ThreadPoolExecutor = _InOrder
_urlopen = urllib.request.urlopen


class _Answer(io.BytesIO):
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


def _site(path):  # a file on the RF Recon site, beside the web version (this runs in full/pyworker.js)
    import js
    return urllib.parse.urljoin(str(js.location.href), path)


def _pskreporter(url):
    """PSKReporter's answer as the XML the PC reads: browsers may only have it as a script (its callback= reply)."""
    import js
    js.eval("self.rfrPskReply = d => { self.rfrPskData = JSON.stringify(d); }")  # letters only: it strips _ from the name
    try:
        js.importScripts(url + ("&" if "?" in url else "?") + "callback=rfrPskReply")
    except Exception:  # it refuses a query that comes too soon after the last one
        raise ValueError("PSKReporter didn't answer: it takes one query every five minutes. Try again in a few minutes.") from None
    d = json.loads(str(js.rfrPskData))
    el = lambda tag, a: f"<{tag} " + " ".join(f"{k}={quoteattr(str(v))}" for k, v in a.items() if not isinstance(v, (dict, list))) + "/>"
    body = "".join(el("activeReceiver", a) for a in d.get("activeReceiver") or []) + "".join(el("receptionReport", a) for a in d.get("receptionReport") or [])
    return f"<receptionReports>{body}</receptionReports>".encode("utf-8")


def _urlopen_web(req, *a, **k):
    """urllib in the browser: PSKReporter through its script reply, SatNOGS from the copy on the RF Recon site (neither lets
    a web page read it directly), the rest through the browser; a site that refuses the browser reads as being offline."""
    url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    host = urllib.parse.urlsplit(url).hostname or ""
    try:
        if host == "retrieve.pskreporter.info":
            return _Answer(_pskreporter(url))
        if host == "network.satnogs.org":
            return _urlopen(_site("../packs/satnogs.json"), timeout=k.get("timeout", 90))
        r = _urlopen(req, *a, **k)
    except OSError:
        raise
    except Exception as e:
        raise OSError(f"the browser couldn't reach it: {e}") from None
    if (getattr(r, "status", None) or 200) >= 400:  # as desktop urllib does (pyodide-http hands an error page back as an answer)
        raise urllib.error.HTTPError(url, r.status, getattr(r, "reason", "") or "", r.headers, r)
    return r


if "pyodide" in sys.modules:
    urllib.request.urlopen = _urlopen_web
    # build_opener(...).open (spec sheets, a building's website): pyodide-http sends it straight to the browser;
    # here it takes the same way as urlopen. The PC's redirect handlers don't apply: the browser follows redirects.
    if getattr(_urlopen, "__module__", "").startswith("pyodide_http"):  # (desktop urlopen calls an opener itself: never loop)
        urllib.request.OpenerDirector.open = lambda self, url, *a, **k: _urlopen_web(url, *a, **k)

import app  # noqa: E402
import captures  # noqa: E402
import das  # noqa: E402
import network  # noqa: E402
import uls_import  # noqa: E402

PACK = os.environ.get("RF_WEB_PACK", "/pack.db")
HISTORY = []  # history files attached as h0, h1, ... (the states in the pack)
GRANTEE = os.environ.get("RF_WEB_GRANTEE", "/grantee.db")
BCAST_PC = ("id, call_sign, kind AS band, service, freq_mhz, channel, class, status, city, state, facility_id, lat, lon, "
            "erp_kw, haat_m, licensee, hours, directional")


def _views(con):
    """The pack under the PC's names, for this connection only (temporary objects come before every database)."""
    pk = {r[0] for r in con.execute("SELECT name FROM pk.sqlite_master WHERE type='table'")}
    if "bcast" in pk:
        con.execute(f"CREATE TEMP VIEW bcast AS SELECT {BCAST_PC} FROM pk.bcast")
    meta = {k: json.loads(v) for k, v in con.execute("SELECT k, v FROM pk.meta")}
    con.execute("CREATE TEMP TABLE meta(k TEXT PRIMARY KEY, v TEXT)")
    pc = {"built_at": meta.get("fcc_built_at"), "towers_built_at": meta.get("towers_built_at"),
          "tx_rows": (meta.get("counts") or {}).get("licences"), "states": ",".join((meta.get("area") or {}).get("states") or [])}
    con.executemany("INSERT INTO temp.meta VALUES(?, ?)", [(k, str(v)) for k, v in pc.items() if v is not None])
    if HISTORY:  # current licences and the expired ones as one table, as on the PC
        cols = ", ".join(r[1] for r in con.execute("PRAGMA pk.table_info(tx)"))
        old = " UNION ALL ".join(f"SELECT {cols} FROM h{i}.tx_old" for i in range(len(HISTORY)))
        con.execute(f"CREATE TEMP VIEW tx AS SELECT {cols} FROM pk.tx UNION ALL {old}")
        con.execute("CREATE TEMP VIEW tx_history AS " + " UNION ALL ".join(f"SELECT * FROM h{i}.tx_history" for i in range(len(HISTORY))))


def db():
    con = sqlite3.connect(app.DB_PATH, timeout=60)
    con.row_factory = sqlite3.Row
    if os.path.exists(PACK):
        con.execute("ATTACH DATABASE ? AS pk", (PACK,))
        for i, h in enumerate(HISTORY):
            con.execute(f"ATTACH DATABASE ? AS h{i}", (h,))
        _views(con)
    if os.path.exists(GRANTEE):  # the maker codes with or without a state's pack (until 10/31 only with one: a look-up
        con.execute("ATTACH DATABASE ? AS gr", (GRANTEE,))  # made before the pack arrived named no maker)
    return con


def _schema():
    """Create the PC's own-work tables (and only those: the FCC tables come from the pack) in /rfr/uls.db."""
    os.makedirs(os.environ["RF_RECON_DAS"], exist_ok=True)
    full = sqlite3.connect(":memory:")
    full.executescript(uls_import.SCHEMA + app.APP_SCHEMA + captures.SCHEMA + das.SCHEMA + network.SCHEMA)
    keep = set(app.USER_TABLES)
    want = full.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN "
                        f"({','.join('?' * len(keep))}) ORDER BY type DESC", sorted(keep)).fetchall()  # tables before indexes
    full.close()
    con = sqlite3.connect(app.DB_PATH)
    have = {r[0] for r in con.execute("SELECT name FROM sqlite_master")}
    for name, sql in want:
        if name not in have:
            con.execute(sql)
    con.commit()
    das.migrate(con)  # columns added to tables a browser already has (CREATE leaves an existing table as it was)
    captures.migrate(con)
    con.close()
    app.cdb().close()  # the crowd database: empty here (crowd data needs your keys, which stay on the PC)


def has_table(con, name):
    """app.has_table across every attached database (the PC's reads the main one only, and here the FCC tables are in the pack)."""
    for _, schema, _ in con.execute("PRAGMA database_list").fetchall():
        if con.execute(f"SELECT 1 FROM {schema}.sqlite_master WHERE type IN ('table', 'view') AND name=?", (name,)).fetchone():
            return True
    return False


app.db = db
app.has_table = has_table
_schema()


# DAS Prospects from the pack: fieldpack.build puts the area's buildings in its prospect table (the columns
# prospects.near and get read), and the whole country's counts in its meta, so the PC's code reads them as its list
def _prospects_path(_data_dir):
    return PACK


def _prospect_counts(_data_dir):
    """prospects.counts for the pack: the country's counts it was made with (DAS Prospects says "in the US"), or
    {"updated": None} for a pack made before the lists went in (11/4): the page then says the lists aren't here."""
    if not os.path.exists(PACK):
        return {"updated": None}
    con = sqlite3.connect(PACK)
    try:
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='prospect'").fetchone():
            return {"updated": None}
        r = con.execute("SELECT v FROM meta WHERE k='prospect_counts'").fetchone()
        if r:
            return json.loads(r[0])
        out = {k: n for k, n in con.execute("SELECT kind, COUNT(*) FROM prospect GROUP BY kind")}
        out["updated"] = con.execute("SELECT MAX(updated) FROM prospect").fetchone()[0]
        return out
    finally:
        con.close()


def _prospects_refresh(*a, **k):
    raise ValueError("The prospect lists download on the PC or server. In the web version they come in the field pack: "
                     "load a pack made since 11/4 for this area (Packs).")


import prospects  # noqa: E402

prospects.db_path = _prospects_path
prospects.counts = _prospect_counts
prospects.refresh = _prospects_refresh
prospects.connect = _prospects_refresh  # every writer to the lists (a refresh, an area's added buildings) opens with it: never the pack


def _highrises_web(*a, **k):
    raise ValueError("Find high-rises runs on the PC or server (it reads Overture's building heights with RF Recon's own tools). "
                     "Here the high-rises found there come in the next pack made of this area.")


prospects.highrises = _highrises_web


def _public_url_web(url):
    """das._public_url in the browser: an http(s) link, nothing more. The PC's check keeps its server from being sent
    to a private address; here the browser fetches it under its own rules, there's no server to protect, and Pyodide
    has no real DNS to look the name up with (it would refuse every link a supplier's price list gives)."""
    u = urllib.parse.urlsplit(url or "")
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ValueError("not an http(s) link")


def _get_web(url):
    """das._get in the browser: a spec sheet or a supplier's price list fetched through the browser. Most makers' and
    suppliers' sites don't let a web page read their files (CORS), which is said plainly."""
    _public_url_web(url)
    u = urllib.parse.urlsplit(url)
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=40) as r:
            data = r.read(das.SPEC_MAX + 1)
    except urllib.error.HTTPError as e:  # it answered, with an error: the link is wrong or gone, not the browser's rules
        raise OSError(f"{u.hostname} answered {e.code}: check the link") from None
    except Exception:
        raise OSError(f"{u.hostname} doesn't let a web page fetch its files: RF Recon on the PC or server fetches it. "
                      "Here, open the link, save the file and upload it") from None
    if len(data) > das.SPEC_MAX:
        raise ValueError("the file is over 30 MB")
    return data


das._get = _get_web
das._public_url = _public_url_web

try:  # DAS Prospects' "Find email" (contactfind.py, 11/4): it reads the building's own website
    import contactfind
    _contact_find = contactfind.find

    def _contact_find_web(website, fetch=None, max_pages=5):
        """contactfind.find in the browser. It passes over a page it can't read, so a site that refuses web pages (most
        do: CORS) would come back as "no address found"; when every page it tried was refused, that's said instead."""
        refused = []

        def f(url):
            try:
                return (fetch or contactfind._default_fetch)(url)
            except Exception:
                refused.append(url)
                raise
        out = _contact_find(website, f, max_pages)
        if not out.get("emails") and out.get("pages") and set(out["pages"]) <= set(refused):
            host = urllib.parse.urlsplit(out["pages"][0]).hostname or "The building's website"
            raise ValueError(f"{host} doesn't let a web page read it, so Find email works from RF Recon on the PC or server. "
                             "Here, open their website and look for a contact address, or call the number shown.")
        return out
    contactfind.find = _contact_find_web
except ImportError:
    pass


def attach_history(paths):
    HISTORY[:] = paths


_SIGWIKI = []


def _sigwiki():
    """Once a start: the Signal ID Wiki catalog's copy beside the packs (state_packs.py: facts only) into the crowd database,
    where the PC's code matches signals against it (the unlisted check, the field log)."""
    if _SIGWIKI or "pyodide" not in sys.modules:
        return
    _SIGWIKI.append(True)
    try:
        import sigwiki
        with _urlopen(_site("../packs/sigwiki.json"), timeout=60) as r:
            rows = json.loads(r.read())
        con = app.cdb()
        try:
            con.executescript(sigwiki.SCHEMA)
            con.execute("DELETE FROM sigwiki")
            con.executemany("INSERT OR REPLACE INTO sigwiki(name, title, url, ranges, fmin, fmax, bw_min, bw_max, mode, modulation, "
                            "location, categories) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            [(e["name"], e["title"], e["url"], json.dumps(e["ranges"]), e["fmin"], e["fmax"], e["bw_min"], e["bw_max"],
                              e["mode"], e["modulation"], e["location"], e["categories"]) for e in rows])
            con.commit()
        finally:
            con.close()
    except Exception:  # offline, or no copy on the site yet: matches come back empty, as on a PC without the catalog
        pass


def call(method, path, query, body, ctype):
    """One request through the PC's handler, without a socket: returns (status, headers, body)."""
    _sigwiki()
    h = app.H.__new__(app.H)
    h.command, h.request_version = method, "HTTP/1.1"
    h.path = path + ("?" + query if query else "")
    h.requestline = f"{method} {h.path} HTTP/1.1"
    h.client_address, h.server, h.close_connection = ("127.0.0.1", 0), None, True
    body = bytes(body.to_py()) if body is not None and hasattr(body, "to_py") else (body or b"")
    msg = email.message.Message()
    msg["Host"] = "localhost"
    msg["Content-Length"] = str(len(body))
    if ctype:
        msg["Content-Type"] = ctype
    h.headers, h.rfile, h.wfile = msg, io.BytesIO(body), io.BytesIO()
    getattr(h, "do_" + method)()
    head, _, payload = h.wfile.getvalue().partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    headers = dict(ln.split(": ", 1) for ln in lines[1:] if ": " in ln)
    headers.pop("Content-Length", None)
    return int(lines[0].split()[1]), headers, payload
