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
        return _urlopen(req, *a, **k)
    except OSError:
        raise
    except Exception as e:
        raise OSError(f"the browser couldn't reach it: {e}") from None


if "pyodide" in sys.modules:
    urllib.request.urlopen = _urlopen_web

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
        if os.path.exists(GRANTEE):
            con.execute("ATTACH DATABASE ? AS gr", (GRANTEE,))
        _views(con)
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


def attach_history(paths):
    HISTORY[:] = paths


def call(method, path, query, body, ctype):
    """One request through the PC's handler, without a socket: returns (status, headers, body)."""
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
