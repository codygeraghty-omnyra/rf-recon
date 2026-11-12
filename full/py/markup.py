"""
Drawings on the maps (Cody 11/10, "draw and mark up"): points, lines and areas kept with a mission or a DAS job, or with
this copy alone ("scratch", id 0) when neither is open. Each is GeoJSON geometry (lon, lat), a label, a colour and a
note, with who drew it and when. Exported as KML (Google Earth, ATAK) or GeoJSON. static/markup.js draws them.

Writes go through the server's usual rules: a view-only login can't save (remote.refused), and a job's drawings follow
the job's access list (app.py job_gate: view to see, edit to change).

Markers (Cody 11/11) are the points. From the review of them (11/11):
  - an id is never given twice (AUTOINCREMENT): a deleted marker's id went to the next one, so a tab or a login still
    showing the deleted one deleted or overwrote the new one;
  - a change with an id changes only the fields it carries, read against the row as it is now: a colour sent after a
    rename (or from a tab that loaded before a Move) put back the old name or the old place;
  - a delete is kept for a day (deleted_at) so Undo puts the same drawing back, its id, who drew it and when included
    (restore); a mission's or a job's go for good with it (drop_scope).
"""
import html
import json
import re
import sqlite3
import time

TABLE = """CREATE TABLE IF NOT EXISTS map_markup(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, scope_id INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL, geometry TEXT NOT NULL, label TEXT, color TEXT, note TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)"""
INDEX = "CREATE INDEX IF NOT EXISTS map_markup_scope ON map_markup(scope, scope_id)"
SCHEMA = TABLE + ";" + INDEX + ";"
KEEP_DELETED = 86400  # seconds a deleted drawing can be put back: Undo shows for seconds, a day covers a slow tab
TABLES = ("map_markup",)  # the nightly my-work backup takes them (app.USER_TABLES)
SCOPES = ("mission", "job", "scratch")
KINDS = {"point": "Point", "line": "LineString", "area": "Polygon"}
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#ff7a1a"
MAX_POINTS = 5000  # a drawing, not a survey track
MAX_LABEL, MAX_NOTE = 120, 2000
# the nightly my-work backup leaves out what's deleted (app.backup_user_data): a deleted marker's note went to every backup
BACKUP_WHERE = {"map_markup": "deleted_at IS NULL"}
ID_MARGIN = 1000  # past the highest id when an old table is rebuilt: it kept no record of the ids it had deleted at the top
PURGE_EVERY = 3600  # seconds between ensure()'s clear-outs of old deletes, for each database
_purged = {}  # database file -> time.monotonic() of ensure()'s last clear-out


def _cutoff():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - KEEP_DELETED))


def purge(con, wait=True):
    """Drawings deleted over KEEP_DELETED ago go for good (review 11/11: they stayed until the next delete, and came back
    weeks later). Run by delete(), the nightly backup and, now and then, ensure(). wait=False: only if no one else is
    writing to the database right now. Answers how many went, or None when it didn't run (no table yet, or busy)."""
    was, busy = con.in_transaction, None
    if not wait:
        busy = con.execute("PRAGMA busy_timeout").fetchone()[0]
        con.execute("PRAGMA busy_timeout=0")
    try:
        n = con.execute("DELETE FROM map_markup WHERE deleted_at IS NOT NULL AND deleted_at < ?", (_cutoff(),)).rowcount
        con.commit()
        return n
    except sqlite3.OperationalError:  # no table yet, or (not waiting) another writer has the database
        if con.in_transaction and not was:
            con.rollback()
        return None
    finally:
        if busy is not None:
            con.execute(f"PRAGMA busy_timeout={int(busy)}")


def _now_and_then(con):
    """ensure()'s clear-out: at most once every PURGE_EVERY for each database, and only when no one else is writing. It ran on
    every drawings request, and a DELETE takes the write lock even when nothing matches, so a list of drawings waited out
    another writer's busy timeout (seeded sweep 11/11: a marker just made wasn't listed for over 8 s). In between, a drawing
    deleted over a day ago is still never listed, put back (restore) or backed up (BACKUP_WHERE)."""
    db = (con.execute("PRAGMA database_list").fetchone() or (0, "main", ""))[2] or ""
    if time.monotonic() - _purged.get(db, float("-inf")) < PURGE_EVERY:
        return
    if purge(con, wait=False) is not None:
        _purged[db] = time.monotonic()


def ensure(con):
    """The table, made or brought up to date: one from before 11/11 (ids given again, no deleted_at) is rebuilt with its
    rows and their ids as they were, and the next id put ID_MARGIN past the highest; old deletes are cleared out now and
    then (_now_and_then)."""
    con.executescript(SCHEMA)
    sql = (con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='map_markup'").fetchone() or [""])[0] or ""
    if "AUTOINCREMENT" in sql.upper():
        _now_and_then(con)
        return
    con.execute("BEGIN IMMEDIATE")
    try:
        sql = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='map_markup'").fetchone()[0] or ""
        if "AUTOINCREMENT" not in sql.upper():  # another request may have rebuilt it while this one waited
            cols = ", ".join(r[1] for r in con.execute("PRAGMA table_info(map_markup)"))
            con.execute("ALTER TABLE map_markup RENAME TO map_markup_old")
            con.execute(TABLE)
            con.execute(f"INSERT INTO map_markup({cols}) SELECT {cols} FROM map_markup_old")
            # the counter past anything the old table could have handed out and deleted: a stale tab's delete of an id the
            # old table gave out last, then deleted, then gave again here, would hit the new marker
            top = con.execute("SELECT COALESCE(MAX(id), 0) FROM map_markup").fetchone()[0] + ID_MARGIN
            if con.execute("UPDATE sqlite_sequence SET seq=? WHERE name='map_markup'", (top,)).rowcount == 0:
                con.execute("INSERT INTO sqlite_sequence(name, seq) VALUES('map_markup', ?)", (top,))
            con.execute("DROP TABLE map_markup_old")
            con.execute(INDEX)
        con.commit()
    except Exception:
        con.rollback()
        raise


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def scope_of(scope, scope_id):
    """(scope, id) checked: scratch is always id 0."""
    if scope not in SCOPES:
        raise ValueError("A drawing belongs to a mission, a DAS job or scratch.")
    if scope == "scratch":
        return scope, 0
    try:
        sid = int(scope_id)
    except (TypeError, ValueError):
        raise ValueError(f"Which {scope}? Its id is missing.") from None
    return scope, sid


def _pos(p):
    if not (isinstance(p, (list, tuple)) and len(p) >= 2 and all(isinstance(v, (int, float)) for v in p[:2])):
        raise ValueError("A drawing's points must be [longitude, latitude].")
    lon, lat = float(p[0]), float(p[1])
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError("A point is off the map (longitude -180 to 180, latitude -90 to 90).")
    return [round(lon, 7), round(lat, 7)]


def geometry(kind, g):
    """The drawing's GeoJSON geometry, checked and tidied: the right type for its kind, sane points, an area's ring closed."""
    if kind not in KINDS:
        raise ValueError("A drawing is a point, a line or an area.")
    if not isinstance(g, dict) or g.get("type") != KINDS[kind]:
        raise ValueError(f"A {kind} needs a GeoJSON {KINDS[kind]}.")
    c = g.get("coordinates")
    if kind == "point":
        return {"type": "Point", "coordinates": _pos(c)}
    if kind == "line":
        pts = [_pos(p) for p in (c or [])]
        if len(pts) < 2:
            raise ValueError("A line needs at least two points.")
    else:
        pts = [_pos(p) for p in ((c or [[]])[0] or [])]
        if pts and pts[0] != pts[-1]:
            pts.append(pts[0])
        if len(pts) < 4:
            raise ValueError("An area needs at least three corners.")
    if len(pts) > MAX_POINTS:
        raise ValueError(f"A drawing has at most {MAX_POINTS:,} points.")
    return {"type": KINDS[kind], "coordinates": pts if kind == "line" else [pts]}


def _row(r):
    d = dict(r)
    d["geometry"] = json.loads(d["geometry"])
    return d


def listing(con, scope, scope_id):
    scope, sid = scope_of(scope, scope_id)
    return [_row(r) for r in con.execute("SELECT * FROM map_markup WHERE scope=? AND scope_id=? AND deleted_at IS NULL ORDER BY id", (scope, sid))]


def _label(v):
    return str(v or "").strip()[:MAX_LABEL]


def _note(v):
    return str(v or "").strip()[:MAX_NOTE]


def _color(v):
    return v if COLOR.match(str(v or "")) else DEFAULT_COLOR


def save(con, d, who=""):
    """A new drawing, or a change to one in the same scope (its id): only the fields sent change (kind with geometry),
    the rest stay as the row has them now. Returns it as saved."""
    scope, sid = scope_of(d.get("scope"), d.get("scope_id"))
    if d.get("id"):
        mid = int(d["id"])
        # the read and the write in one transaction: two saves at once each read the row first, and the second wrote the
        # other's field back; a delete between them left the save writing to a deleted drawing (review 11/11)
        if not con.in_transaction:
            con.execute("BEGIN IMMEDIATE")
        try:
            cur = con.execute("SELECT * FROM map_markup WHERE id=? AND scope=? AND scope_id=? AND deleted_at IS NULL", (mid, scope, sid))
            row = cur.fetchone()
            if not row:
                raise LookupError("That drawing was deleted. Reload to see the current ones.")
            row = dict(zip([c[0] for c in cur.description], row))
            kind = d.get("kind") or row["kind"]
            geom = geometry(kind, d["geometry"] if d.get("geometry") is not None else json.loads(row["geometry"]))
            label = _label(d["label"]) if "label" in d else row["label"]
            note = _note(d["note"]) if "note" in d else row["note"]
            color = _color(d["color"]) if "color" in d else row["color"]
            if not con.execute("UPDATE map_markup SET kind=?, geometry=?, label=?, color=?, note=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                               (kind, json.dumps(geom), label, color, note, _now(), mid)).rowcount:
                raise LookupError("That drawing was deleted. Reload to see the current ones.")
        except Exception:
            con.rollback()
            raise
    else:
        kind = d.get("kind")
        geom = geometry(kind, d.get("geometry"))
        label, note, color = _label(d.get("label")), _note(d.get("note")), _color(d.get("color"))
        mid = con.execute("INSERT INTO map_markup(scope, scope_id, kind, geometry, label, color, note, created_by, created_at, updated_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?)", (scope, sid, kind, json.dumps(geom), label, color, note, who or "", _now(), _now())).lastrowid
    con.commit()
    return _row(con.execute("SELECT * FROM map_markup WHERE id=?", (mid,)).fetchone())


def delete(con, mid, scope, scope_id):
    """Off the map at once and kept KEEP_DELETED seconds for restore (Undo); older deletes go for good now."""
    scope, sid = scope_of(scope, scope_id)
    con.execute("UPDATE map_markup SET deleted_at=? WHERE id=? AND scope=? AND scope_id=? AND deleted_at IS NULL", (_now(), int(mid), scope, sid))
    con.commit()
    purge(con)


def restore(con, mid, scope, scope_id):
    """A deleted drawing back as it was (Undo): the same id, who drew it and when. Returns it."""
    scope, sid = scope_of(scope, scope_id)
    cur = con.execute("UPDATE map_markup SET deleted_at=NULL WHERE id=? AND scope=? AND scope_id=? AND deleted_at IS NOT NULL AND deleted_at >= ?",
                      (int(mid), scope, sid, _cutoff()))  # within the day only, purged yet or not
    con.commit()
    if not cur.rowcount:
        raise LookupError("That drawing can't be put back: it's there already, or it was deleted over a day ago.")
    return _row(con.execute("SELECT * FROM map_markup WHERE id=?", (int(mid),)).fetchone())


def drop_scope(con, scope, scope_id):
    """A mission's or a job's drawings, when it's deleted: part of the caller's delete, so it commits nothing (ensure()'s
    executescript commits first: review 11/10, round 3). No table yet: no drawings."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='map_markup'").fetchone():
        return
    con.execute("DELETE FROM map_markup WHERE scope=? AND scope_id=?", (scope, int(scope_id)))


def geojson(rows):
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": r["geometry"],
         "properties": {"label": r.get("label") or "", "kind": r["kind"], "color": r.get("color") or DEFAULT_COLOR, "note": r.get("note") or "",
                        "drawn_by": r.get("created_by") or "", "drawn_at": r.get("created_at") or ""}} for r in rows]}


def _kml_color(hexc, alpha="ff"):
    h = (hexc or DEFAULT_COLOR).lstrip("#")
    return f"{alpha}{h[4:6]}{h[2:4]}{h[0:2]}"  # KML is aabbggrr


def kml(rows, name="DAStastic drawings"):
    e = html.escape
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>', f"<name>{e(name)}</name>"]
    for r in rows:
        c, g = r.get("color") or DEFAULT_COLOR, r["geometry"]
        style = (f"<Style><IconStyle><color>{_kml_color(c)}</color></IconStyle><LineStyle><color>{_kml_color(c)}</color><width>3</width></LineStyle>"
                 f"<PolyStyle><color>{_kml_color(c, '40')}</color></PolyStyle></Style>")
        coords = lambda pts: " ".join(f"{p[0]},{p[1]},0" for p in pts)
        if g["type"] == "Point":
            shape = f"<Point><coordinates>{coords([g['coordinates']])}</coordinates></Point>"
        elif g["type"] == "LineString":
            shape = f"<LineString><tessellate>1</tessellate><coordinates>{coords(g['coordinates'])}</coordinates></LineString>"
        else:
            shape = f"<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>{coords(g['coordinates'][0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>"
        desc = e(r.get("note") or "") + (f" (drawn by {e(r['created_by'])}, {e(r.get('created_at') or '')})" if r.get("created_by") else "")
        out.append(f"<Placemark><name>{e(r.get('label') or r['kind'])}</name><description>{desc}</description>{style}{shape}</Placemark>")
    out.append("</Document></kml>")
    return "\n".join(out)
