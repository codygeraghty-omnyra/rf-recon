"""
Where a tower really is, set on site (Cody 11/16: "towers can be on top of buildings, not just actual tower sites"). Andy
Masur (Mobili-Fi) verifies towers on site; at Monroe NY his AT&T site, eNB 812442, is on the Power Teach building's roof
896 m away. A structure under 200 ft, away from airports, needs no FCC antenna structure registration (47 CFR 17.7, the
FAA's notice criteria: towair.py), so the tower engine had nothing to snap it to and showed an estimate with its bubble.

A fix says where the real structure is: its spot, its type (rooftop, monopole, ...), the building or site's name, its height
(optional), a note, the engine's site keys it was set from ("AT&T|LTE|812442") and their carriers, who set it and when. The
tower engine (towerfuse.py) takes it as a structure above every other: the sites it was set from go to it whatever their
bubble, other sites can snap to it by the usual score, and it stands with its carriers when the crowd loses the site.

Saved on this copy and shared by everyone on it (uls.db, beside markup.py's map_markup), never copied to another copy: the
tables are the copy's own work (app.USER_TABLES: the nightly backup has them), never build.PUBLIC_TABLES (a licensed copy's
seed and the install kit carry public data only). Every change is kept in tower_fix_history with the fix as it was after it.
A removed fix is kept KEEP_DELETED for Undo (restore), out of the backup meanwhile (BACKUP_WHERE), then goes for good (purge:
now and then from ensure(), and the nightly backup); its history stays. A site key lives on one live fix at most (review 11/16,
S1/S7): a save, change or restore on the same spot as a live fix (JOIN_M) joins it, and one whose site is set on another live
fix elsewhere is refused ("eNB 812442 is already set on the rooftop, Power Teach: Change that one.").

Writes go through the server's usual rules (app.py towers_route): a view-only login can't POST (remote.refused), and on a
framed copy a POST from another site is refused at the door.
"""
import json
import math
import re
import sqlite3
import time

TABLE = """CREATE TABLE IF NOT EXISTS tower_fix(id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL NOT NULL, lon REAL NOT NULL,
    type TEXT NOT NULL, name TEXT, height_ft REAL, note TEXT, sites TEXT NOT NULL DEFAULT '[]', carriers TEXT NOT NULL DEFAULT '[]',
    set_from TEXT, created_by TEXT, created_at TEXT, updated_by TEXT, updated_at TEXT, deleted_by TEXT, deleted_at TEXT)"""
HISTORY = """CREATE TABLE IF NOT EXISTS tower_fix_history(id INTEGER PRIMARY KEY AUTOINCREMENT, fix_id INTEGER NOT NULL,
    action TEXT NOT NULL, who TEXT, at TEXT NOT NULL, row TEXT NOT NULL)"""
INDEX = "CREATE INDEX IF NOT EXISTS tower_fix_history_fix ON tower_fix_history(fix_id)"
SCHEMA = TABLE + ";" + HISTORY + ";" + INDEX + ";"
TABLES = ("tower_fix", "tower_fix_history")  # the nightly my-work backup takes them (app.USER_TABLES); never build.PUBLIC_TABLES
BACKUP_WHERE = {"tower_fix": "deleted_at IS NULL"}  # a removed fix stays out of the backup; its history is the record
TYPES = ("rooftop", "monopole", "lattice", "guyed", "water tank", "stealth", "utility pole", "other")
KEEP_DELETED = 86400  # seconds a removed fix can be put back (Undo shows for seconds; a day covers a slow tab)
PURGE_EVERY = 3600  # seconds between ensure()'s clear-outs of old removals, for each database
JOIN_M = 40  # a new fix this near a live one is that one, its sites added (towerfuse's merge_m: one structure)
MAX_NAME, MAX_NOTE, MAX_SITES, MAX_HEIGHT_FT = 120, 2000, 30, 2100
SITE_KEY = re.compile(r"^[^|]{1,60}\|[A-Z0-9]{2,6}\|\d{1,12}$")  # the engine's site key: network|radio|site id
_purged = {}  # database file -> time.monotonic() of ensure()'s last clear-out
COLS = ("lat", "lon", "type", "name", "height_ft", "note", "sites", "carriers")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _cutoff():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - KEEP_DELETED))


def purge(con, wait=True):
    """Fixes removed over KEEP_DELETED ago go for good; their history stays. wait=False: only if no one else is writing.
    Answers how many went, or None when it didn't run (no table yet, or busy)."""
    was, busy = con.in_transaction, None
    if not wait:
        busy = con.execute("PRAGMA busy_timeout").fetchone()[0]
        con.execute("PRAGMA busy_timeout=0")
    try:
        n = con.execute("DELETE FROM tower_fix WHERE deleted_at IS NOT NULL AND deleted_at < ?", (_cutoff(),)).rowcount
        con.commit()
        return n
    except sqlite3.OperationalError:  # no table yet, or (not waiting) another writer has the database
        if con.in_transaction and not was:
            con.rollback()
        return None
    finally:
        if busy is not None:
            con.execute(f"PRAGMA busy_timeout={int(busy)}")


def ensure(con):
    """The tables, made if they aren't there; old removals cleared out at most once every PURGE_EVERY for each database,
    and only when no one else is writing (markup.py's rule: a DELETE takes the write lock even when nothing matches)."""
    con.executescript(SCHEMA)
    db = (con.execute("PRAGMA database_list").fetchone() or (0, "main", ""))[2] or ""
    if time.monotonic() - _purged.get(db, float("-inf")) >= PURGE_EVERY and purge(con, wait=False) is not None:
        _purged[db] = time.monotonic()


def carrier_of(key):
    """The carrier a site key is ("AT&T|LTE|812442" -> "AT&T"; an ex-Sprint key is T-Mobile's; a regional carrier's network-code
    key "310-730|LTE|4242" -> "UScellular", as the engine names it), or None when it isn't one the report knows."""
    import towerfuse
    # exactly as _key_carrier names it, never the known map's spelling: three regional carriers are registered under two spellings
    # that differ by case, and the map's pick split a fix into two entries and lost its site key (review 11/16, round 2, S6)
    c = str(towerfuse._key_carrier(key))
    return c if c.lower() in towerfuse.known_carriers() else None


def _m(a_lat, a_lon, b_lat, b_lon):
    p1, p2, dl = math.radians(a_lat), math.radians(b_lat), math.radians(b_lon - a_lon)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))


# ---------------------------------------------------------------- what a fix may say

def _num(v, what):
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number.") from None
    if not math.isfinite(x):
        raise ValueError(f"{what} must be a number.")
    return x


def _where(d):
    lat, lon = _num(d.get("lat"), "Its latitude"), _num(d.get("lon"), "Its longitude")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("That spot is off the map.")
    return round(lat, 7), round(lon, 7)


def _type(v):
    t = str(v or "").strip().lower()
    if t not in TYPES:
        raise ValueError(f"A structure is one of: {', '.join(TYPES)}.")
    return t


def _height(v):
    if v is None or str(v).strip() == "":
        return None
    h = _num(v, "Its height")
    if not 1 <= h <= MAX_HEIGHT_FT:
        raise ValueError(f"Its height is in feet, from 1 to {MAX_HEIGHT_FT:,}.")
    return round(h, 1)


def _text(v, n):
    return str(v or "").strip()[:n]


def _canon(k):
    """A site key as the engine spells it (cells.group, fold): the big three and ex-Sprint by name, any other carrier by its network
    code (mcc-mnc, the mnc in three digits), the radio upper case, the site id without leading zeros; None when it can't be one.
    The one-fix-per-key rule compared raw strings, so 'AT&T|LTE|0812442' or 'at&t|LTE|812442' gave eNB 812442 a second High
    tower (review 11/16, round 2, S5)."""
    import cells
    import towerfuse
    parts = [x.strip() for x in str(k).split("|")]
    if len(parts) != 3 or not (parts[2].isascii() and parts[2].isdigit()) or not (parts[1].isascii() and parts[1].isalnum()):
        return None
    net, radio, sid = parts
    code = re.fullmatch(r"([0-9]{3})-([0-9]{1,3})", net)
    if code:  # folded as cells.group(fold=True) folds it: '310-410|LTE|812442' is AT&T's eNB 812442 (review 11/16, round 3, S2)
        op = cells.operator(code.group(1), code.group(2))
        net = ("T-Mobile (ex-Sprint)" if op == "T-Mobile (ex-Sprint)" else cells.brand(op) if cells.brand(op) in cells.BIG3
               else f"{code.group(1)}-{int(code.group(2)):03d}")
    elif net.lower() == "t-mobile (ex-sprint)":
        net = "T-Mobile (ex-Sprint)"
    else:
        net = towerfuse.known_carriers().get(net.lower())
        if not net or net not in cells.BIG3:
            return None  # the engine keys every other carrier by its network code
    k = f"{net}|{radio.upper()}|{int(sid)}"
    return k if SITE_KEY.match(k) else None


def _sites(v):
    if v is None:
        return []
    if not isinstance(v, (list, tuple)) or len(v) > MAX_SITES:
        raise ValueError(f"A fix is set from at most {MAX_SITES} sites.")
    out = []
    for raw in v:
        k = _canon(raw)
        if not k:
            raise ValueError(f"{str(raw).strip()[:40]!r} isn't a site (network|radio|site id).")
        if k not in out:
            out.append(k)
    return out


def _carriers(v, sites):
    """The carriers named (as the report names them) and the ones the sites are; at least one."""
    import towerfuse
    names = [x for x in (v or []) if str(x).strip()] if isinstance(v, (list, tuple)) else [x for x in str(v or "").split(",") if x.strip()]
    out = towerfuse.wanted(names) if names else []
    for k in sites:
        c = carrier_of(k)
        if c:  # a name ticked in another case is the site's carrier, as its key names it (S6)
            out = [c if x.lower() == c.lower() else x for x in out]
            if c not in out:
                out.append(c)
    out = list(dict.fromkeys(out))
    if not out:
        raise ValueError("Which carriers are on it? Give at least one.")
    return out


# ---------------------------------------------------------------- reading

def _row(r, hist=None):
    d = dict(r)
    for k in ("sites", "carriers"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except ValueError:
            d[k] = []
    if d.get("height_ft") is not None and float(d["height_ft"]).is_integer():
        d["height_ft"] = int(d["height_ft"])
    if hist is not None:
        d["history"] = hist
    return d


def _cursor_rows(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def history(con, fix_id=None):
    """Every change to a fix (or to all of them), oldest first: {action: set | change | remove | restore, who, at, row: the
    fix as it was after it}."""
    q = "SELECT * FROM tower_fix_history" + (" WHERE fix_id=?" if fix_id is not None else "") + " ORDER BY id"
    out = []
    for r in _cursor_rows(con.execute(q, (int(fix_id),) if fix_id is not None else ())):
        try:
            r["row"] = json.loads(r["row"])
        except ValueError:
            r["row"] = {}
        out.append(r)
    return out


def _histories(con, ids):
    by = {}
    if not ids:
        return by
    for r in _cursor_rows(con.execute(f"SELECT fix_id, action, who, at FROM tower_fix_history WHERE fix_id IN ({','.join('?' * len(ids))}) ORDER BY id", list(ids))):
        by.setdefault(r["fix_id"], []).append({"action": r["action"], "who": r["who"] or "", "at": r["at"]})
    return by


def listing(con, history=False):
    """The live fixes (not removed), oldest first; history: each with its changes (action, who, at)."""
    rows = _cursor_rows(con.execute("SELECT * FROM tower_fix WHERE deleted_at IS NULL ORDER BY id"))
    hist = _histories(con, [r["id"] for r in rows]) if history else {}
    return [_row(r, hist.get(r["id"], []) if history else None) for r in rows]


def live(con):
    """What the tower engine reads: the live fixes with their history, or [] on a copy that has none (no table: nothing is
    written here, so a read-only database answers too)."""
    try:
        return listing(con, history=True)
    except sqlite3.Error:
        return []


def _one(con, fix_id, deleted=False):
    cur = con.execute(f"SELECT * FROM tower_fix WHERE id=? AND deleted_at IS {'NOT ' if deleted else ''}NULL", (int(fix_id),))
    rows = _cursor_rows(cur)
    return rows[0] if rows else None


def _log(con, fix_id, action, who):
    row = _cursor_rows(con.execute("SELECT * FROM tower_fix WHERE id=?", (fix_id,)))[0]
    con.execute("INSERT INTO tower_fix_history(fix_id, action, who, at, row) VALUES(?,?,?,?,?)",
                (fix_id, action, who or "", _now(), json.dumps(_row(row), ensure_ascii=False)))


def _answer(con, fix_id, **extra):
    row = _cursor_rows(con.execute("SELECT * FROM tower_fix WHERE id=?", (fix_id,)))[0]
    return dict(_row(row, _histories(con, [fix_id]).get(fix_id, [])), **extra)


def _id(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ValueError("Which fix? Its id is missing.") from None


# ---------------------------------------------------------------- writing

def _live(con, but=()):
    return [_row(r) for r in _cursor_rows(con.execute("SELECT * FROM tower_fix WHERE deleted_at IS NULL ORDER BY id")) if r["id"] not in but]


def _near(con, lat, lon, but=()):
    """The live fix within JOIN_M of a spot (the nearest), or None: one structure, so a fix put there is that one."""
    near = [r for r in _live(con, but) if _m(lat, lon, r["lat"], r["lon"]) <= JOIN_M]
    return min(near, key=lambda r: _m(lat, lon, r["lat"], r["lon"])) if near else None


def _site_word(key):
    net, radio, sid = (str(key).split("|") + ["", "", ""])[:3]
    word = {"LTE": "eNB", "NR": "gNB"}.get(radio, "cell")
    return f"{word} {sid}".strip()


def _what(f):
    return f"the {f['type']}{', ' + f['name'] if f.get('name') else ''}"


class Taken(ValueError):
    """A site already set on another live fix (a 400 like any ValueError), with that fix's id (fix_id): the route answers it, so the page
    opens the fix the refusal names. It guessed from shared keys and distance, and opened the fix being changed, or a nearer one that
    shared another key (review 11/16, round 3, S3)."""

    def __init__(self, msg, fix_id):
        super().__init__(msg)
        self.fix_id = fix_id


def _taken(con, sites, but=()):
    """A site key lives on one live fix at most (review 11/16, S1/S7): two set from one eNB made two High towers for it. Refused
    with the fix that has it (Taken)."""
    for r in _live(con, but):
        k = next((k for k in sites if k in r["sites"]), None)
        if k:
            raise Taken(f"{_site_word(k)} is already set on {_what(r)}: Change that one.", r["id"])


TYPED = ("type", "name", "height_ft", "note", "carriers")


def _typed(v):
    """The fields the person typed or picked, as the page sends them (typed: [...]), or None when it doesn't say (an older page)."""
    if v is None:
        return None
    if not isinstance(v, (list, tuple)) or any(x not in TYPED for x in v):
        raise ValueError(f"typed lists the fields typed: {', '.join(TYPED)}.")
    return set(v)


def _join(con, into, sites, carriers, who, d=None, typed=None):
    """sites and carriers added to the live fix `into` (one structure: within JOIN_M), and its words as d says; logged as its change.
    Returns its id. typed (the fields the person typed, as the page says): exactly those of d go on it, an empty one clearing it, and
    the rest keep its words. The page shows each untyped field as the joined fix's words, so the form is what's written (round 3's final
    check: one per-field model). typed None (an older page): what d says that isn't empty takes the place of what it said."""
    d = d or {}
    s2 = into["sites"] + [k for k in sites if k not in into["sites"]]
    c2 = into["carriers"] + [c for c in carriers if c not in into["carriers"]]
    if typed is None:
        typ, name, note, height = (_type(d["type"]) if d.get("type") else into["type"]), _text(d.get("name"), MAX_NAME), _text(d.get("note"), MAX_NOTE), _height(d.get("height_ft"))
        name, note, height = name or into["name"], note or into["note"], height if height is not None else into["height_ft"]
    else:
        typ = _type(d.get("type")) if "type" in typed else into["type"]
        name = _text(d.get("name"), MAX_NAME) if "name" in typed else into["name"]
        note = _text(d.get("note"), MAX_NOTE) if "note" in typed else into["note"]
        height = _height(d.get("height_ft")) if "height_ft" in typed else into["height_ft"]
    con.execute("UPDATE tower_fix SET type=?, name=?, height_ft=?, note=?, sites=?, carriers=?, updated_by=?, updated_at=? WHERE id=?",
                (typ, name, height, note, json.dumps(s2), json.dumps(c2), who or "", _now(), into["id"]))
    _log(con, into["id"], "change", who)
    return into["id"]


def save(con, d, who=""):
    """A new fix: {lat, lon, type, name, height_ft, note, sites, carriers, from}. One within JOIN_M of a live fix is that fix:
    its sites and carriers are added, and what this one says that isn't empty takes the place of what it said (joined: True).
    A site already set on another live fix is refused (_taken). Returns the fix as saved, with its history."""
    lat, lon = _where(d)
    typ, name, note, height = _type(d.get("type") or "rooftop"), _text(d.get("name"), MAX_NAME), _text(d.get("note"), MAX_NOTE), _height(d.get("height_ft"))
    sites = _sites(d.get("sites"))
    carriers = _carriers(d.get("carriers"), sites)
    typed = _typed(d.get("typed"))
    # the read and the write in one transaction: two saves at once on one roof would each make a fix
    if not con.in_transaction:
        con.execute("BEGIN IMMEDIATE")
    try:
        near = _near(con, lat, lon)
        _taken(con, sites, but={near["id"]} if near else ())
        if near:
            fid, joined = _join(con, near, sites, carriers, who, d, typed), True
        else:
            fid = con.execute("INSERT INTO tower_fix(lat, lon, type, name, height_ft, note, sites, carriers, set_from, created_by, created_at, updated_by, updated_at)"
                              " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (lat, lon, typ, name, height, note, json.dumps(sites), json.dumps(carriers),
                                                                    _text(d.get("from"), 200), who or "", _now(), who or "", _now())).lastrowid
            _log(con, fid, "set", who)
            joined = False
        con.commit()
    except Exception:
        con.rollback()
        raise
    return _answer(con, fid, joined=joined)


def change(con, fix_id, d, who=""):
    """A change to a live fix: only the fields sent change (lat and lon together), read against the row as it is now. Moved within
    JOIN_M of another live fix, it joins that one (its sites and carriers go there, and this one is removed: "join"); a site set on
    another live fix is refused."""
    fid = _id(fix_id)
    if not con.in_transaction:
        con.execute("BEGIN IMMEDIATE")
    try:
        row = _one(con, fid)
        if not row:
            raise LookupError("That fix was removed. Reload to see the current ones.")
        cur = _row(row)
        typed = _typed(d.get("typed"))
        lat, lon = _where(d) if ("lat" in d or "lon" in d) else (cur["lat"], cur["lon"])
        sites = _sites(d["sites"]) if "sites" in d else cur["sites"]
        carriers = _carriers(d["carriers"], sites) if "carriers" in d else _carriers(cur["carriers"], sites)
        near = _near(con, lat, lon, but={fid})
        _taken(con, sites, but={fid} | ({near["id"]} if near else set()))
        if near:  # moved onto another confirmed structure: one structure, one fix
            # exactly the fields the person typed go on it (typed, as a save's: round 3's final check). The words typed with the move were
            # dropped (review 11/16, round 2, S3), then every posted field went over it, the moved fix's own words carried over untouched
            # among them (round 3, R3C1). An older page that doesn't say: what differs from this fix's own words
            if typed is None:
                d = {k: d[k] for k, norm in (("type", _type), ("name", lambda v: _text(v, MAX_NAME)), ("note", lambda v: _text(v, MAX_NOTE)),
                                             ("height_ft", _height)) if k in d and norm(d[k]) != (cur.get(k) or ("" if k in ("name", "note") else None))}
            out = _join(con, near, sites, carriers, who, d, typed)
            con.execute("UPDATE tower_fix SET deleted_at=?, deleted_by=? WHERE id=?", (_now(), who or "", fid))
            _log(con, fid, "join", who)
            con.commit()
            return _answer(con, out, joined=True)
        vals = {"lat": lat, "lon": lon, "type": _type(d["type"]) if "type" in d else cur["type"], "name": _text(d["name"], MAX_NAME) if "name" in d else cur["name"],
                "height_ft": _height(d["height_ft"]) if "height_ft" in d else cur["height_ft"], "note": _text(d["note"], MAX_NOTE) if "note" in d else cur["note"],
                "sites": json.dumps(sites), "carriers": json.dumps(carriers)}
        con.execute(f"UPDATE tower_fix SET {', '.join(f'{k}=?' for k in COLS)}, updated_by=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                    (*[vals[k] for k in COLS], who or "", _now(), fid))
        _log(con, fid, "change", who)
        con.commit()
    except Exception:
        con.rollback()
        raise
    return _answer(con, fid, joined=False)


def remove(con, fix_id, who=""):
    """Off the report at once, kept KEEP_DELETED for restore (Undo); older removals go for good now."""
    fid = _id(fix_id)
    if not con.in_transaction:
        con.execute("BEGIN IMMEDIATE")
    try:
        if not con.execute("UPDATE tower_fix SET deleted_at=?, deleted_by=? WHERE id=? AND deleted_at IS NULL", (_now(), who or "", fid)).rowcount:
            raise LookupError("That fix was removed already. Reload to see the current ones.")
        _log(con, fid, "remove", who)
        con.commit()
    except Exception:
        con.rollback()
        raise
    purge(con)
    return {"ok": True, "id": fid}


def restore(con, fix_id, who=""):
    """A removed fix back as it was (Undo): the same id, who set it and when. Within KEEP_DELETED only. Where another live fix is
    on the same spot now (someone set it again meanwhile), this one's sites join that one ("join"; joined: True); one whose site is
    set on another live fix elsewhere is refused."""
    fid = _id(fix_id)
    if not con.in_transaction:
        con.execute("BEGIN IMMEDIATE")
    try:
        rows = _cursor_rows(con.execute("SELECT * FROM tower_fix WHERE id=? AND deleted_at IS NOT NULL AND deleted_at >= ?", (fid, _cutoff())))
        if not rows:
            raise LookupError("That fix can't be put back: it's there already, or it was removed over a day ago.")
        # one that joined another fix (an Undo or a Change onto its spot) is part of that one now: a second Undo from another tab, or
        # a retry, put back for a day site keys taken off it since (review 11/16, round 2, S4)
        last = con.execute("SELECT action FROM tower_fix_history WHERE fix_id=? ORDER BY id DESC LIMIT 1", (fid,)).fetchone()
        if last and last[0] == "join":
            raise LookupError("That fix can't be put back: it was joined to the one on its spot. Reload to see it.")
        cur = _row(rows[0])
        near = _near(con, cur["lat"], cur["lon"], but={fid})
        _taken(con, cur["sites"], but={fid} | ({near["id"]} if near else set()))
        if near:
            out = _join(con, near, cur["sites"], cur["carriers"], who)
            _log(con, fid, "join", who)
            con.commit()
            return _answer(con, out, joined=True)
        con.execute("UPDATE tower_fix SET deleted_at=NULL, deleted_by=NULL WHERE id=?", (fid,))
        _log(con, fid, "restore", who)
        con.commit()
    except Exception:
        con.rollback()
        raise
    return _answer(con, fid, joined=False)
