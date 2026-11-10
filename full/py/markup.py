"""
Drawings on the maps (Cody 11/10, "draw and mark up"): points, lines and areas kept with a mission or a DAS job, or with
this copy alone ("scratch", id 0) when neither is open. Each is GeoJSON geometry (lon, lat), a label, a colour and a
note, with who drew it and when. Exported as KML (Google Earth, ATAK) or GeoJSON. static/markup.js draws them.

Writes go through the server's usual rules: a view-only login can't save (remote.refused), and a job's drawings follow
the job's access list (app.py job_gate: view to see, edit to change).
"""
import html
import json
import re
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS map_markup(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, scope_id INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL, geometry TEXT NOT NULL, label TEXT, color TEXT, note TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS map_markup_scope ON map_markup(scope, scope_id);
"""
SCOPES = ("mission", "job", "scratch")
KINDS = {"point": "Point", "line": "LineString", "area": "Polygon"}
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#ff7a1a"
MAX_POINTS = 5000  # a drawing, not a survey track
MAX_LABEL, MAX_NOTE = 120, 2000


def ensure(con):
    con.executescript(SCHEMA)


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
    return [_row(r) for r in con.execute("SELECT * FROM map_markup WHERE scope=? AND scope_id=? ORDER BY id", (scope, sid))]


def save(con, d, who=""):
    """A new drawing, or a change to one in the same scope (its id). Returns it as saved."""
    scope, sid = scope_of(d.get("scope"), d.get("scope_id"))
    kind = d.get("kind")
    geom = geometry(kind, d.get("geometry"))
    label = str(d.get("label") or "").strip()[:MAX_LABEL]
    note = str(d.get("note") or "").strip()[:MAX_NOTE]
    color = d.get("color") if COLOR.match(str(d.get("color") or "")) else DEFAULT_COLOR
    if d.get("id"):
        cur = con.execute("UPDATE map_markup SET kind=?, geometry=?, label=?, color=?, note=?, updated_at=? WHERE id=? AND scope=? AND scope_id=?",
                          (kind, json.dumps(geom), label, color, note, _now(), int(d["id"]), scope, sid))
        if not cur.rowcount:
            raise LookupError("That drawing was deleted. Reload to see the current ones.")
        mid = int(d["id"])
    else:
        mid = con.execute("INSERT INTO map_markup(scope, scope_id, kind, geometry, label, color, note, created_by, created_at, updated_at)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?)", (scope, sid, kind, json.dumps(geom), label, color, note, who or "", _now(), _now())).lastrowid
    con.commit()
    return _row(con.execute("SELECT * FROM map_markup WHERE id=?", (mid,)).fetchone())


def delete(con, mid, scope, scope_id):
    scope, sid = scope_of(scope, scope_id)
    con.execute("DELETE FROM map_markup WHERE id=? AND scope=? AND scope_id=?", (int(mid), scope, sid))
    con.commit()


def drop_scope(con, scope, scope_id):
    """A mission's or a job's drawings, when it's deleted."""
    ensure(con)
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
