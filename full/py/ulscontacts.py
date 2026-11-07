#!/usr/bin/env python3
"""
Licensee and contact records from the FCC's ULS licence files (the EN "entity" records), kept so a DAS job's consent
letters go to the licence's own contact by name and address (R1 #3, 2026-11-04).

The EN record holds, for every licence, the licensee (entity type L) and usually the licensee's contact (CL): name,
attention line, phone, fax, email, street, PO box, city, state, ZIP and FRN (FCC "Public Access Database
Definitions", EN record; positions 0-based below). The contact is often a consulting engineer or a radio shop
rather than the agency, so both are kept and shown.

The licence import fills them (uls_import.load_zip -> scratch.raw_contact -> build()). A database built before
contacts were kept gets them from the licence files already downloaded (backfill(), run once at start by ensure()),
or from the command line:

    python ulscontacts.py                         # the app's database, the l_*.zip files beside it
    python ulscontacts.py --db path/uls.db --zip path/l_LMpriv.zip --zip path/l_LMcomm.zip
"""
import argparse
import io
import os
import sqlite3
import sys
import time
import zipfile

KINDS = {"L": "Licensee", "CL": "Licensee's contact"}
COLS = ("usi", "kind", "call_sign", "name", "first", "last", "attention", "phone", "fax", "email", "street", "po_box",
        "city", "state", "zip", "frn")
RAW_COLS = ("usi INTEGER, kind TEXT, call_sign TEXT, name TEXT, first TEXT, last TEXT, attention TEXT, phone TEXT, fax TEXT, "
            "email TEXT, street TEXT, po_box TEXT, city TEXT, state TEXT, zip TEXT, frn TEXT, PRIMARY KEY(usi, kind)")
INSERT_RAW = "INSERT OR REPLACE INTO raw_contact VALUES(" + ",".join("?" * len(COLS)) + ")"
SOURCE = "FCC ULS licence records (EN: licensee and contact)"


def _g(f, i):
    return f[i].strip() if i < len(f) else ""


def row(f, usi):
    """One EN record (a field list) as a raw_contact row, or None for an entity type we don't keep (owners, lessees...)."""
    kind = _g(f, 5)
    if kind not in KINDS:
        return None
    return (usi, kind, _g(f, 4), _g(f, 7), _g(f, 8), _g(f, 10), _g(f, 20), _g(f, 12), _g(f, 13), _g(f, 14), _g(f, 15),
            _g(f, 19), _g(f, 16), _g(f, 17).upper(), _g(f, 18), _g(f, 22))


def build(con, log=print):
    """uls_contact from the import's scratch.raw_contact, swapped in whole so a reader never sees half a table."""
    schema = "scratch" if any(r[1] == "scratch" for r in con.execute("PRAGMA database_list")) else "main"
    if not con.execute(f"SELECT 1 FROM {schema}.sqlite_master WHERE name='raw_contact'").fetchone():
        return 0
    con.execute("DROP TABLE IF EXISTS uls_contact_new")
    con.execute(f"CREATE TABLE uls_contact_new({RAW_COLS})")
    con.execute(f"INSERT INTO uls_contact_new SELECT * FROM {schema}.raw_contact")
    return _swap(con, log)


def _swap(con, log):
    con.execute("DROP TABLE IF EXISTS uls_contact")
    con.execute("ALTER TABLE uls_contact_new RENAME TO uls_contact")
    con.execute("CREATE INDEX IF NOT EXISTS uls_contact_call ON uls_contact(call_sign)")
    n = con.execute("SELECT COUNT(*) FROM uls_contact").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO meta SELECT 'contacts_built_at', v FROM meta WHERE k='built_at'")
    con.commit()
    log(f"  {n:,} licensee and contact records kept")
    return n


def backfill(db_path, zips, log=print):
    """Fill uls_contact from licence files already downloaded, for the licences in this database (a database
    imported before contacts were kept). Returns the rows kept."""
    import uls_import  # the importer's reader joins records the FCC split across lines
    con = sqlite3.connect(db_path, timeout=120)
    try:
        con.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
        keep = {r[0] for r in con.execute("SELECT DISTINCT usi FROM tx")}
        con.execute("DROP TABLE IF EXISTS uls_contact_new")
        con.execute(f"CREATE TABLE uls_contact_new({RAW_COLS})")
        ins = "INSERT OR REPLACE INTO uls_contact_new VALUES(" + ",".join("?" * len(COLS)) + ")"
        for p in zips:
            zf = zipfile.ZipFile(p)
            m = uls_import.find_member(zf, "EN")
            if not m:
                continue
            buf, n = [], 0
            for f in uls_import.iter_records(zf, m, "EN"):
                try:
                    usi = int(_g(f, 1) or 0)
                except ValueError:
                    continue
                if usi in keep:
                    r = row(f, usi)
                    if r:
                        buf.append(r)
                if len(buf) >= 50000:
                    con.executemany(ins, buf)
                    con.commit()
                    n += len(buf)
                    buf.clear()
                    time.sleep(0.1)  # lets a waiting save in (the import does the same)
            con.executemany(ins, buf)
            con.commit()
            n += len(buf)
            log(f"  {os.path.basename(p)}: {n:,} licensee and contact records")
        return _swap(con, log)
    finally:
        con.close()


def ensure(db_path, data_dir, log=print):
    """Once per FCC data build: when uls_contact is missing or older than the licences, fill it from the licence
    files named in meta 'sources' that are still in data_dir. Quiet when there's nothing to do."""
    if not os.path.exists(db_path):
        return 0
    con = sqlite3.connect(db_path, timeout=60)
    try:
        meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
    except sqlite3.Error:
        return 0
    finally:
        con.close()
    if not meta.get("built_at") or meta.get("contacts_built_at") == meta.get("built_at"):
        return 0
    zips = [os.path.join(data_dir, s) for s in (meta.get("sources") or "").split(",") if s]
    zips = [z for z in zips if os.path.exists(z)]
    if not zips:
        return 0
    return backfill(db_path, zips, log)


def ensure_quiet(db_path, data_dir):
    """ensure() for the app's start-up thread: a failure is printed, never raised."""
    try:
        n = ensure(db_path, data_dir, log=lambda m: None)
        if n:
            print(f"Kept {n:,} licensee and contact records from the saved FCC files", flush=True)
    except Exception as e:
        print(f"Licensee contacts not kept yet: {type(e).__name__}: {str(e)[:200]}", flush=True)


def _phone(p):
    d = "".join(c for c in p or "" if c.isdigit())
    if not d or set(d) == {"0"}:
        return ""
    return f"{d[:3]}-{d[3:6]}-{d[6:10]}" + (f" x{d[10:]}" if len(d) > 10 else "") if len(d) >= 10 else p


def _zip(z):
    z = (z or "").strip()
    return f"{z[:5]}-{z[5:9]}" if len(z) == 9 and z.isdigit() else z


def entity(r):
    """A uls_contact row as the page shows it: who, what lines to address it to, phone, email."""
    if r is None:
        return None
    r = dict(r)
    person = " ".join(x for x in (r.get("first"), r.get("last")) if x)
    name = r.get("name") or person
    lines = [name] if name else []
    att = r.get("attention") or (person if r.get("name") and person else "")
    if att and att.upper() != (name or "").upper():
        lines.append(f"Attn: {att}")
    if r.get("street"):
        lines.append(r["street"])
    if r.get("po_box"):
        lines.append(f"PO Box {r['po_box']}" if r["po_box"][:1].isdigit() else r["po_box"])
    tail = " ".join(x for x in (", ".join(x for x in (r.get("city"), r.get("state")) if x), _zip(r.get("zip"))) if x)
    if tail:
        lines.append(tail)
    return {"kind": r["kind"], "kind_label": KINDS.get(r["kind"], r["kind"]), "name": name, "attention": att, "lines": lines,
            "phone": _phone(r.get("phone")), "email": (r.get("email") or "").strip(), "frn": r.get("frn") or "",
            "has_address": bool(r.get("street") or r.get("po_box"))}


def has_table(con):
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE name='uls_contact'").fetchone())


def for_calls(con, calls):
    """{call sign: {"usi", "status", "licensee": entity, "contact": entity, "source"}} for licences in the database;
    the active licence when a call sign has several. A call sign with no record is left out (never guessed)."""
    calls = sorted({c.strip().upper() for c in calls or [] if c and c.strip()})
    if not calls or not has_table(con):
        return {}
    built = (con.execute("SELECT v FROM meta WHERE k='contacts_built_at'").fetchone() or [""])[0]
    usi = {}
    for i in range(0, len(calls), 500):
        part = calls[i:i + 500]
        for c, u, st in con.execute(f"SELECT DISTINCT call_sign, usi, status FROM tx WHERE call_sign IN ({','.join('?' * len(part))})", part):
            if c not in usi or (st == "A" and usi[c][1] != "A") or (st == usi[c][1] and u > usi[c][0]):
                usi[c] = (u, st)
    out = {}
    for c, (u, st) in usi.items():
        rows = {r[1]: dict(zip(COLS, r)) for r in con.execute("SELECT * FROM uls_contact WHERE usi=?", (u,))}
        if not rows:
            continue
        out[c] = {"usi": u, "status": st, "licensee": entity(rows.get("L")), "contact": entity(rows.get("CL")),
                  "source": f"{SOURCE}, licence {c}" + (f", FCC data of {built}" if built else ""),
                  "url": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={u}"}
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    data = os.environ.get("RF_RECON_DATA") or os.path.join(here, "data")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.environ.get("ULS_DB") or os.path.join(data, "uls.db"))
    ap.add_argument("--zip", action="append", default=[], help="a downloaded l_*.zip (default: the ones the database was built from)")
    a = ap.parse_args()
    if a.zip:
        n = backfill(a.db, a.zip)
    else:
        n = ensure(a.db, os.path.dirname(os.path.abspath(a.db)))
    print(f"{n:,} records" if n else "Nothing to do (already current, or the licence files aren't beside the database).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
