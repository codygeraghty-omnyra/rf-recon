"""
The FCC's ULS daily change files (Data desk, Cody 11/8): a new or changed licence shows the day after, instead of up to a
week later when Sunday's full file lands, and the applications filed but not yet granted are kept apart.

Files: https://data.fcc.gov/download/pub/uls/daily/l_<code>_<day>.zip (licences) and a_<code>_<day>.zip (applications),
<day> mon to sat, each replaced a week later. A daily file holds every record of each licence (or application) that
changed that day, not only the changed fields (read 11/8: in l_lp_fri each of its 78 licences came with its HD, EN, LO,
AN and FR records and its whole history). So a licence in a daily file replaces what the weekly import loaded for it,
keyed by its unique system identifier (HD field 1), the way ULS keys it.

- Licences: l_lp (private land mobile) over the weekly l_LMpriv.zip, l_cl (800 MHz cellular) over l_cell.zip, each only
  when that weekly file is loaded here. They go through the weekly import's own reader (uls_import.load_zip, tx_rows) with
  the same states, into the same tables: tx, tx_history, uls_contact, and Search's name index. The status is the FCC's
  (HD field 5: A active, C cancelled, E expired, T terminated...): a cancelled or expired licence keeps its rows with that
  status, out of the active layers and in history, as Sunday's file will show it; a licence that leaves the states loaded
  here goes.
- The Sunday load wins: a daily file the FCC made before the weekly file loaded here is already in it, and is skipped
  (both dates from the files' own counts). After a weekly rebuild the newer daily files go on again, in the FCC's order.
- Applications (a_lp): uls_pending only, never tx. Status 2 (AD field 5) is pending, the same reading as mw_pending.py;
  any other status (granted, dismissed, withdrawn, returned...) takes it off the list, as does a licence file whose
  licence now carries the application's file number (granted). The list holds what the daily files have shown since this
  copy started reading them: an application filed earlier and untouched since isn't on it.
- Idempotent: each file goes on once per weekly load (uls_daily_log), oldest first; applying one again gives the same rows.
- Bounded: each zip (a few hundred KB) is read record by record from disk; one licence file at a time goes into temporary
  tables, and its changes to the database are one transaction.
- Fetched through datadesk.fetchkit with conditional requests, so an unchanged file isn't downloaded again. A refusal
  stops the run and is raised for the Data desk to file; nothing is retried by another route.
"""
import calendar
import hashlib
import json
import os
import sqlite3
import time
import zipfile

import dlstop
import geo
import uls_import
from datadesk import clean, fetchkit
from mw_pending import PURPOSE
from uls_import import dms, find_member, g, iter_records, to_float

BASE = "https://data.fcc.gov/download/pub/uls/daily/"
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat")
LICENCES = {"lp": "LMpriv", "cl": "cell"}  # daily code: the weekly file it changes (l_<service>.zip)
APPLICATIONS = {"lp": "LMpriv"}  # a_<code>: read while that weekly licence file is loaded here
PENDING = "2"
UA = "DAStastic/2.0 (RF site-survey tool; FCC ULS daily change files)"
MAX_BYTES = 30 * 1024 * 1024  # the biggest seen is under 1 MB
FOLDER = "uls-daily"
SOURCE = {"id": "fcc-uls-daily-change-files", "name": "FCC ULS daily change files", "terms": "US government public data", "url": BASE}
# pending applications through the Data desk's cleaner: the applicant's contact (phone, email, street...) is never stored
PROFILE = {"required": ["usi", "file_number"], "point": False, "us": False, "freq": None, "id": "key", "near_m": 0,
           "personal": ["phone", "fax", "email", "street", "po_box", "zip", "attention", "first", "last", "frn"]}
PENDING_COLS = ("usi", "file_number", "purpose", "received", "call_sign", "service", "service_name", "applicant", "category",
                "loc_num", "address", "city", "county", "state", "lat", "lon", "freqs", "classes", "src", "asof")
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS uls_daily_log(file TEXT, asof TEXT, kind TEXT, sha TEXT, weekly TEXT, applied_at TEXT, items INTEGER,
    rows_out INTEGER, rows_in INTEGER, note TEXT, PRIMARY KEY(file, asof, weekly));
CREATE TABLE IF NOT EXISTS uls_pending({", ".join(PENDING_COLS)});
CREATE INDEX IF NOT EXISTS uls_pending_usi ON uls_pending(usi);
CREATE INDEX IF NOT EXISTS uls_pending_file ON uls_pending(file_number);
CREATE INDEX IF NOT EXISTS uls_pending_latlon ON uls_pending(lat, lon);
CREATE INDEX IF NOT EXISTS uls_pending_state ON uls_pending(state, county);
"""
HISTORY = """INSERT INTO main.tx_history(hkey,call_sign,freq_mhz,lat,lon,licensee,service,mode,county,state,first_seen,last_seen)
    SELECT call_sign||'|'||printf('%.5f',freq_mhz)||'|'||CASE WHEN lat IS NULL THEN '' ELSE printf('%.4f',lat) END||'|'||CASE WHEN lon IS NULL THEN '' ELSE printf('%.4f',lon) END,
           call_sign,freq_mhz,lat,lon,licensee,service,mode,county,state,?,? FROM temp.tx_daily WHERE status='A'
    ON CONFLICT(hkey) DO UPDATE SET last_seen=excluded.last_seen, licensee=excluded.licensee, mode=excluded.mode"""


def ensure(con):
    con.executescript(SCHEMA)


def _meta(con):
    return dict(con.execute("SELECT k, v FROM main.meta").fetchall())


def _has(con, name):
    return con.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _utc_of_local(s):
    """'YYYY-MM-DD HH:MM' on this machine's clock (meta built_at) as UTC 'YYYY-MM-DD HH:MM:SS'."""
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.mktime(time.strptime(str(s)[:16], "%Y-%m-%d %H:%M"))))
    except (TypeError, ValueError, OverflowError):
        return None


def _local_of_utc(s):
    """UTC 'YYYY-MM-DD HH:MM:SS' as 'YYYY-MM-DD HH:MM' on this machine's clock, the way built_at and history read."""
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M:%S"))))
    except (TypeError, ValueError, OverflowError):
        return None


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def states_of(m):
    s = (m.get("states") or "").upper()
    return set() if s in ("", "ALL") else {x for x in s.split(",") if x}


def weekly_asof(con, service, data_dir, m=None):
    """The FCC's own date (UTC) of the weekly l_<service>.zip loaded here: the import notes it; for data loaded before it
    did, the saved copy's counts when that copy is no newer than the load; else the time of the load, which is never
    earlier than the FCC's date, so nothing older than the load is ever put back over it."""
    m = m if m is not None else _meta(con)
    name = f"l_{service}.zip"
    if m.get("uls_asof:" + name):
        return m["uls_asof:" + name]
    built = m.get("built_at")
    p = os.path.join(data_dir, name)
    if built and os.path.exists(p) and time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p))) <= built:
        got = uls_import.file_created(p)
        if got:
            return got
    return _utc_of_local(built) if built else None


# ---------------------------------------------------------------- fetching

def fetch(names, folder, log=print, opener=None, resolve=None):
    """Each named daily file, one request each, conditional on the copy kept in folder. {"new", "same", "missing"}.
    fetchkit.Refused (other than a 404: a day the FCC didn't publish) and fetchkit.Failed are raised, unretried."""
    os.makedirs(folder, exist_ok=True)
    vpath = os.path.join(folder, "validators.json")
    try:
        with open(vpath, encoding="utf-8") as fh:
            validators = json.load(fh)
    except (OSError, ValueError):
        validators = {}
    f = fetchkit.Fetcher(UA, max_bytes=MAX_BYTES, validators=validators, opener=opener, resolve=resolve)
    out = {"new": [], "same": [], "missing": [], "requests": 0}

    def keep():
        tmp = vpath + ".part"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(validators, fh, indent=0)
        os.replace(tmp, vpath)
    try:
        for name in names:
            dlstop.check()
            url, path = BASE + name, os.path.join(folder, name)
            if not os.path.exists(path):
                validators.pop(url, None)  # no copy here: ask for the whole file
            try:
                r = f.get(url, accept="application/zip")
            except fetchkit.Refused as e:
                if e.status == 404:
                    out["missing"].append(name)
                    continue
                raise
            if r.not_modified:
                out["same"].append(name)
                continue
            if r.body[:4] != b"PK\x03\x04":
                validators.pop(url, None)
                raise ValueError(f"{name} from the FCC isn't a zip file ({len(r.body):,} bytes)")
            tmp = path + ".part"
            with open(tmp, "wb") as fh:
                fh.write(r.body)
            os.replace(tmp, path)
            out["new"].append(name)
            keep()
    finally:
        out["requests"] = len(f.requests)
        keep()
    return out


# ---------------------------------------------------------------- licences

def _empty(zf):
    """A day with nothing in it: the FCC still publishes the zip, holding only its counts file (l_cl_sat.zip on 11/7:
    50 bytes). Any other member with data in it isn't an empty day."""
    return all(os.path.basename(i.filename).lower() == "counts" or i.file_size == 0 for i in zf.infolist())


def _drop_temp(con):
    for t in list(uls_import.RAW_TABLES) + ["tx_daily"]:
        con.execute(f"DROP TABLE IF EXISTS temp.{t}")


def apply_licences(con, path, states, weekly, asof=None, sha=None, log=print):
    """One l_ daily file over the weekly data: every licence in it replaced by its records here, in one transaction.
    Returns {"file", "asof", "licences", "rows_in", "rows_out", "pending_granted"}."""
    import finder  # here: finder imports das, which imports this module for the pre-survey
    src = os.path.basename(path)
    asof = asof or uls_import.file_created(path) or ""
    pairs, files = {}, set()
    with zipfile.ZipFile(path) as zf:
        m = find_member(zf, "HD")
        if not m and _empty(zf):  # no licence changed that day: on the ledger as read, so the newer days still go on
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            con.execute("INSERT OR REPLACE INTO main.uls_daily_log VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (src, asof, "licences", sha or _sha(path), weekly or "", now, 0, 0, 0, "no changes that day"))
            con.commit()
            log(f"{src}: no changes that day")
            return {"file": src, "asof": asof, "licences": 0, "here": 0, "rows_in": 0, "rows_out": 0, "pending_granted": 0}
        if not m:
            raise ValueError(f"{src}: no licence headers (HD records): not a ULS licence file")
        for f in iter_records(zf, m, "HD"):
            usi = int(g(f, 1) or 0)
            if usi:
                pairs[usi] = g(f, 4)
                if g(f, 2) and g(f, 5) == "A":
                    files.add(g(f, 2))
    _drop_temp(con)
    uls_import.create_raw(con, "temp")
    uls_import.load_zip(con, path, states, True, lambda *a, **k: None)  # the weekly import's reader, with its states
    con.execute("CREATE TEMP TABLE tx_daily AS SELECT * FROM main.tx WHERE 0")
    ins, buf = uls_import.tx_insert("temp.tx_daily"), []
    for row in uls_import.tx_rows(con):
        buf.append(row)
        if len(buf) >= 5000:
            con.executemany(ins, buf)
            buf.clear()
    if buf:
        con.executemany(ins, buf)
    con.commit()  # the temporary tables only
    cols = ",".join(uls_import.TX_COLS)
    built = weekly or ""
    first = _local_of_utc(asof) or built
    names = finder.index_rows(con, pairs.values())  # Search's name index: read before the write lock (a pass over it)
    con.execute("BEGIN IMMEDIATE")
    try:
        out, here = 0, {r[0] for r in con.execute("SELECT DISTINCT usi FROM temp.tx_daily")}
        for usi, call in pairs.items():  # tx has no usi index; the call sign one finds the licence's rows
            gone = con.execute("DELETE FROM main.tx WHERE call_sign=? AND usi=?", (call, usi)).rowcount
            out += gone
            if gone:
                here.add(usi)
        rows_in = con.execute(f"INSERT INTO main.tx({cols}) SELECT {cols} FROM temp.tx_daily").rowcount
        con.execute(HISTORY, (first, built))  # last seen = the weekly load's date, so History never calls them removed
        if _has(con, "uls_contact"):
            con.executemany("DELETE FROM main.uls_contact WHERE usi=?", [(u,) for u in pairs])
            con.execute("INSERT OR REPLACE INTO main.uls_contact SELECT * FROM temp.raw_contact")
        finder.index_calls(con, pairs.values(), names)
        granted = 0
        if files and _has(con, "uls_pending"):
            fl = sorted(files)
            for i in range(0, len(fl), 500):
                ch = fl[i:i + 500]
                granted += con.execute(f"DELETE FROM main.uls_pending WHERE file_number IN ({','.join('?' * len(ch))})", ch).rowcount
        n = int((con.execute("SELECT v FROM main.meta WHERE k='tx_rows'").fetchone() or ["0"])[0] or 0) + rows_in - out
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        con.executemany("INSERT OR REPLACE INTO main.meta(k, v) VALUES(?, ?)", [("tx_rows", str(max(n, 0))), ("uls_daily_at", now)])
        con.execute("INSERT OR REPLACE INTO main.uls_daily_log VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (src, asof, "licences", sha or _sha(path), built, now, len(pairs), out, rows_in,
                     f"{granted} pending application(s) now granted" if granted else ""))
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        _drop_temp(con)
    log(f"{src}: {len(pairs):,} licences, {len(here):,} of them here: {rows_in:,} rows in, {out:,} out")
    return {"file": src, "asof": asof, "licences": len(pairs), "here": len(here), "rows_in": rows_in, "rows_out": out,
            "pending_granted": granted}


# ---------------------------------------------------------------- applications

def parse_applications(path, states):
    """(every application id in the file, the pending ones' rows by place, as dicts for clean.run)."""
    apps, rows = {}, []
    with zipfile.ZipFile(path) as zf:
        m = find_member(zf, "AD")
        if not m and _empty(zf):  # no application filed or changed that day
            return {}, []
        if not m:
            raise ValueError(f"{os.path.basename(path)}: no application records (AD): not a ULS application file")
        for f in iter_records(zf, m, "AD"):
            usi = int(g(f, 1) or 0)
            if usi:
                apps[usi] = {"status": g(f, 5), "file_number": g(f, 2), "purpose": PURPOSE.get(g(f, 4), g(f, 4)), "received": g(f, 10)}
        pend = {u: a for u, a in apps.items() if a["status"] == PENDING}

        def each(rt):
            mm = find_member(zf, rt)
            return iter_records(zf, mm, rt) if mm else ()
        for f in each("HD"):
            a = pend.get(int(g(f, 1) or 0))
            if a is not None:
                a.update(call_sign=g(f, 4), service=g(f, 6))  # no call sign on a new application until it's granted
        for f in each("EN"):
            a = pend.get(int(g(f, 1) or 0))
            if a is not None and g(f, 5) in ("L", "") and not a.get("applicant"):
                a["applicant"] = g(f, 7) or " ".join(x for x in (g(f, 8), g(f, 10)) if x)
        locs, freqs, classes = {}, {}, {}
        for f in each("LO"):
            usi = int(g(f, 1) or 0)
            if usi in pend and g(f, 5) != "D":  # D: the application takes this place off
                locs[(usi, int(g(f, 8) or 0))] = {"address": g(f, 11) or None, "city": g(f, 12).upper() or None,
                                                  "county": uls_import.norm_county(g(f, 13)), "state": g(f, 14).upper() or None,
                                                  "lat": dms(g(f, 19), g(f, 20), g(f, 21), g(f, 22)),
                                                  "lon": dms(g(f, 23), g(f, 24), g(f, 25), g(f, 26))}
        for f in each("FR"):
            usi, fm = int(g(f, 1) or 0), to_float(g(f, 10))
            if usi in pend and g(f, 5) != "D" and fm:
                k = (usi, int(g(f, 6) or 0))
                freqs.setdefault(k, set()).add(round(fm, 5))
                if g(f, 8):
                    classes.setdefault(k, set()).add(g(f, 8))
    for usi, a in pend.items():
        places = sorted(k for k in locs if k[0] == usi)
        if states:
            in_state = any(locs[k]["state"] in states for k in places)
            places = [k for k in places if locs[k]["state"] in states or (locs[k]["state"] is None and in_state)]
            if not places:
                continue
        svc = a.get("service") or ""
        base = {"usi": usi, "file_number": a["file_number"], "purpose": a["purpose"], "received": a["received"],
                "call_sign": a.get("call_sign") or None, "service": svc or None,
                "service_name": uls_import.SERVICE_NAMES.get(svc, svc) or None, "applicant": a.get("applicant") or None,
                "category": uls_import.category_for(a.get("applicant"), svc)}
        if not places:  # nowhere to put it on a map, but still pending: kept, with every frequency it asks for
            fs = sorted({x for k, v in freqs.items() if k[0] == usi for x in v})
            cl = sorted({x for k, v in classes.items() if k[0] == usi for x in v})
            rows.append(dict(base, key=f"{usi}:", loc_num=None, address=None, city=None, county=None, state=None, lat=None, lon=None,
                             freqs=",".join(f"{x:.5f}".rstrip("0").rstrip(".") for x in fs[:24]) or None, classes=",".join(cl) or None))
        for k in places:
            fs, cl = sorted(freqs.get(k, ())), sorted(classes.get(k, ()))
            rows.append(dict(base, key=f"{usi}:{k[1]}", loc_num=k[1], **locs[k],
                             freqs=",".join(f"{x:.5f}".rstrip("0").rstrip(".") for x in fs[:24]) or None, classes=",".join(cl) or None))
    return sorted(apps), rows


def apply_applications(con, path, states, asof=None, sha=None, log=print):
    """One a_ daily file into uls_pending, in one transaction: each application in it leaves the list, and comes back
    only if it is still pending. Returns {"file", "asof", "applications", "pending", "quarantined"}."""
    src = os.path.basename(path)
    asof = asof or uls_import.file_created(path) or ""
    ids, rows = parse_applications(path, states)
    got = clean.run(rows, PROFILE, SOURCE, asof)
    kept = [tuple(r.get(c) for c in PENDING_COLS[:-2]) + (src, asof) for r in got["kept"]]
    con.execute("BEGIN IMMEDIATE")
    try:
        con.executemany("DELETE FROM main.uls_pending WHERE usi=?", [(u,) for u in ids])
        con.executemany(f"INSERT INTO main.uls_pending({','.join(PENDING_COLS)}) VALUES({','.join('?' * len(PENDING_COLS))})", kept)
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        con.execute("INSERT OR REPLACE INTO main.uls_daily_log VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (src, asof, "applications", sha or _sha(path), "", now, len(ids), 0, len(kept),
                     f"{len(got['quarantined'])} set aside: " + "; ".join(sorted({q['why'] for q in got['quarantined']}))[:200]
                     if got["quarantined"] else ""))
        con.execute("INSERT OR IGNORE INTO main.meta(k, v) VALUES('uls_pending_since', ?)", (asof,))
        con.commit()
    except BaseException:
        con.rollback()
        raise
    n = len({r[0] for r in kept})
    log(f"{src}: {len(ids):,} applications, {n:,} pending here")
    return {"file": src, "asof": asof, "applications": len(ids), "pending": n, "quarantined": len(got["quarantined"])}


# ---------------------------------------------------------------- one run

def _from(files, done, force):
    """files: [(asof, path, sha)] oldest first. The first not yet applied, and every one after it (a file that arrives
    late goes on before the newer ones again, so the newest always has the last word)."""
    if force:
        return files
    i = next((i for i, (a, p, s) in enumerate(files) if (os.path.basename(p), a, s) not in done), len(files))
    return files[i:]


def run(db_path, data_dir, log=print, force=False, opener=None, resolve=None):
    """Fetch the daily files this copy's data takes, apply what's new, oldest first. Returns a summary with "message"
    and "rows", or {"skipped": why} when no weekly file they change is loaded here."""
    folder = os.path.join(data_dir, FOLDER)
    con = sqlite3.connect(db_path, timeout=60)
    try:
        ensure(con)
        m = _meta(con)
        have = set(filter(None, (m.get("sources") or "").split(",")))
        lic = [c for c, svc in LICENCES.items() if f"l_{svc}.zip" in have]
        app = [c for c, svc in APPLICATIONS.items() if f"l_{svc}.zip" in have]
        if not lic and not app:
            return {"skipped": "nothing to change yet: the daily files change the private land mobile and cellular licences, "
                               "and neither weekly file is loaded here"}
        names = [f"l_{c}_{d}.zip" for c in lic for d in DAYS] + [f"a_{c}_{d}.zip" for c in app for d in DAYS]
        log(f"checking {len(names)} FCC daily files")
        got = fetch(names, folder, log, opener, resolve)
        states, built = states_of(m), m.get("built_at") or ""

        def on_disk(prefix):
            out = []
            for d in DAYS:
                p = os.path.join(folder, f"{prefix}_{d}.zip")
                if os.path.exists(p):
                    out.append((uls_import.file_created(p) or "", p, _sha(p)))
            return sorted(out)
        lic_done, older, apps_done = [], [], []
        for c in lic:
            wk = weekly_asof(con, LICENCES[c], data_dir, m)
            files = on_disk(f"l_{c}")
            older += [os.path.basename(p) for a, p, s in files if not wk or not a or a <= wk]
            newer = [x for x in files if wk and x[0] and x[0] > wk]
            done = {tuple(r) for r in con.execute("SELECT file, asof, sha FROM uls_daily_log WHERE kind='licences' AND weekly=?", (built,))}
            for a, p, s in _from(newer, done, force):
                dlstop.check()
                log(f"applying {os.path.basename(p)}")
                lic_done.append(apply_licences(con, p, states, built, a, s, log))
        for c in app:
            files = [x for x in on_disk(f"a_{c}") if x[0]]
            done = {tuple(r) for r in con.execute("SELECT file, asof, sha FROM uls_daily_log WHERE kind='applications'")}
            for a, p, s in _from(files, done, force):
                dlstop.check()
                log(f"applying {os.path.basename(p)}")
                apps_done.append(apply_applications(con, p, states, a, s, log))
        newest = con.execute("SELECT MAX(asof) FROM uls_daily_log WHERE kind='licences' AND weekly=?", (built,)).fetchone()[0]
        if (newest or "") != (_meta(con).get("uls_daily_asof") or ""):  # what the top line shows: "+ daily changes to <date>"
            con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('uls_daily_asof', ?)", (newest or "",))
            con.commit()
        pending = con.execute("SELECT COUNT(DISTINCT usi) FROM uls_pending").fetchone()[0]
    finally:
        con.close()
    n_lic, n_here = sum(x["licences"] for x in lic_done), sum(x["here"] for x in lic_done)
    rows_in, rows_out = sum(x["rows_in"] for x in lic_done), sum(x["rows_out"] for x in lic_done)
    parts = [f"{len(got['new'])} downloaded, {len(got['same'])} unchanged" + (f", {len(got['missing'])} not on the FCC's server" if got["missing"] else "")]
    if lic_done:
        parts.append(f"{len(lic_done)} licence file{'s' if len(lic_done) != 1 else ''} applied: {n_lic:,} changed licences in "
                     f"{'them' if len(lic_done) != 1 else 'it'}, {n_here:,} of them in this copy's data ({rows_in:,} rows in, {rows_out:,} out), "
                     f"to the FCC's file of {lic_done[-1]['asof'][:10]}")
    elif lic:
        parts.append("licences: nothing newer than what's applied" + (f" (FCC daily files to {newest[:10]})" if newest else ""))
    if older:
        parts.append(f"{len(older)} older than the weekly load, skipped")
    if app:
        parts.append(f"{pending:,} pending application{'s' if pending != 1 else ''} kept" +
                     (f" ({len(apps_done)} file{'s' if len(apps_done) != 1 else ''} read)" if apps_done else ""))
    return {"message": "; ".join(parts), "rows": rows_in + sum(x["pending"] for x in apps_done), "weekly": built,
            "fetched": got, "licences": lic_done, "applications": apps_done, "skipped_older": older, "pending": pending,
            "asof": newest}


# ---------------------------------------------------------------- what the pages show

def pending(con, area_sql="1", args=(), point=None, radius_mi=None, ps_only=False, limit=300):
    """Pending applications with a place in the area, one entry per application (its places and frequencies there), nearest
    first with a point. {"apps", "loaded", "since", "asof", "truncated"}. Filed, not granted: never licences."""
    if not _has(con, "uls_pending"):
        return {"apps": [], "loaded": False}
    from das import PS_CATEGORIES  # here: das imports this module for the pre-survey
    lim_km = radius_mi * geo.MI_KM if point and radius_mi else None
    by = {}
    for r in con.execute(f"SELECT {','.join(PENDING_COLS)} FROM uls_pending WHERE {area_sql} LIMIT 20000", list(args)):
        r = dict(zip(PENDING_COLS, r))
        if ps_only and not (r["service"] in uls_import.PUBLIC_SAFETY_SERVICES or r["category"] in PS_CATEGORIES):
            continue
        d = None
        if point and r["lat"] is not None:
            d = geo.haversine_km(point[0], point[1], r["lat"], r["lon"])
            if lim_km and d > lim_km:
                continue
        a = by.setdefault(r["usi"], {k: r[k] for k in ("usi", "file_number", "purpose", "received", "call_sign", "service",
                                                       "service_name", "applicant", "category")} | {"places": [], "freqs": set()})
        a["public_safety"] = r["service"] in uls_import.PUBLIC_SAFETY_SERVICES or r["category"] in PS_CATEGORIES
        a["places"].append({"city": r["city"], "county": r["county"], "state": r["state"], "address": r["address"], "lat": r["lat"],
                            "lon": r["lon"], "dist_mi": round(d / geo.MI_KM, 2) if d is not None else None, "freqs": r["freqs"]})
        a["freqs"].update(x for x in (r["freqs"] or "").split(",") if x)
    apps = []
    for a in by.values():
        a["places"].sort(key=lambda p: (p["dist_mi"] is None, p["dist_mi"] or 0))
        a["nearest_mi"] = a["places"][0]["dist_mi"] if a["places"] else None
        a["freqs"] = sorted(a["freqs"], key=float)
        a["url"] = f"https://wireless2.fcc.gov/UlsApp/ApplicationSearch/applMain.jsp?applID={a['usi']}"
        apps.append(a)
    apps.sort(key=lambda a: (a["nearest_mi"] is None, a["nearest_mi"] or 0, a["applicant"] or ""))
    m = dict(con.execute("SELECT k, v FROM main.meta WHERE k IN ('uls_pending_since')").fetchall())
    last = con.execute("SELECT MAX(asof) FROM uls_daily_log WHERE kind='applications'").fetchone()[0] if _has(con, "uls_daily_log") else None
    return {"apps": apps[:limit], "loaded": True, "truncated": len(apps) > limit, "since": m.get("uls_pending_since"), "asof": last}
