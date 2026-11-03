"""
Overture Maps buildings, read from extracts made ahead of time (tools/overture_extract.py) in <data dir>/overture/.
The DAS building lookup uses them when OpenStreetMap's Overpass has no outline or doesn't answer, and to fill a
height OpenStreetMap lacks.

Measured 2026-11-02 (Jacksonville NC, Wilmington NC, Shakopee MN, DC): where OpenStreetMap has a building, Overture's
outline is OpenStreetMap's; what Overture adds is a height on most buildings (Microsoft's machine-learned heights, or
USGS lidar, so shown as estimates: Microsoft's read low on tall buildings) and outlines for large buildings
OpenStreetMap lacks (7 to 16 over 2,000 m2 in each NC and MN area). Its floor counts are OpenStreetMap's, so they add
nothing. ODbL: build.NOTICES["overture"] goes on any report that uses one.
"""
import glob
import json
import math
import os
import sqlite3

import uls_import

SCHEMA = """
CREATE TABLE IF NOT EXISTS bld(id TEXT PRIMARY KEY, name TEXT, height REAL, num_floors REAL, subtype TEXT, class TEXT,
    geom_src TEXT, height_src TEXT, xmin REAL, xmax REAL, ymin REAL, ymax REAL, ring TEXT);
CREATE INDEX IF NOT EXISTS bld_box ON bld(ymin, xmin);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""
NEAR_M = 80  # the same reach as the Overpass query


def extract_dir():
    return os.path.join(uls_import.DATA_DIR, "overture")


def outer_ring(gj):
    """The largest outer ring of a GeoJSON Polygon or MultiPolygon, as [[lat, lon], ...]."""
    polys = [gj["coordinates"]] if gj.get("type") == "Polygon" else gj.get("coordinates", []) if gj.get("type") == "MultiPolygon" else []
    rings = [p[0] for p in polys if p and len(p[0]) >= 4]
    if not rings:
        return None
    best = max(rings, key=lambda r: abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))))
    return [[round(y, 7), round(x, 7)] for x, y in best]


def extracts(folder=None):
    out = []
    for path in sorted(glob.glob(os.path.join(folder or extract_dir(), "*.db"))):
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            m = dict(con.execute("SELECT k, v FROM meta").fetchall())
            con.close()
        except sqlite3.Error:
            continue
        out.append({"path": path, "name": m.get("name"), "release": m.get("release"), "built_at": m.get("built_at"),
                    "bbox": json.loads(m.get("bbox") or "null")})
    return out


def _inside(lat, lon, ring):
    c = False
    for i in range(len(ring) - 1):
        (a1, o1), (a2, o2) = ring[i], ring[i + 1]
        if (a1 > lat) != (a2 > lat) and lon < (o2 - o1) * (lat - a1) / (a2 - a1) + o1:
            c = not c
    return c


def _area_m2(ring):
    lat0 = math.radians(sum(p[0] for p in ring) / len(ring))
    xy = [(math.radians(o) * 6371008.8 * math.cos(lat0), math.radians(a) * 6371008.8) for a, o in ring]
    return abs(sum(xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1] for i in range(len(xy) - 1))) / 2


def _dist_m(lat, lon, ring):
    """Metres from the point to the outline's nearest edge (not its nearest corner: a long wall is closer than either end)."""
    k = math.cos(math.radians(lat))
    pts = [((o - lon) * 111320 * k, (a - lat) * 111320) for a, o in ring]
    best = math.inf
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
        best = min(best, math.hypot(x1 + t * dx, y1 + t * dy))
    return best


def find(lat, lon, folder=None):
    """The building the point is in, else the nearest within 80 m, from whichever extract covers the point; or None.
    Returns the same shape as das.pick_building, with source, gers_id, release and the height marked an estimate."""
    best = None
    for e in extracts(folder):
        b = e["bbox"]
        if not b or not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            continue
        dlat = NEAR_M / 111320
        dlon = dlat / max(0.05, math.cos(math.radians(lat)))
        con = sqlite3.connect(f"file:{e['path']}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute("SELECT * FROM bld WHERE ymin <= ? AND ymax >= ? AND xmin <= ? AND xmax >= ?",
                               (lat + dlat, lat - dlat, lon + dlon, lon - dlon)).fetchall()
        finally:
            con.close()
        for r in rows:
            ring = json.loads(r["ring"])
            inside = _inside(lat, lon, ring)
            d = 0 if inside else _dist_m(lat, lon, ring)
            if d > NEAR_M:
                continue
            area = _area_m2(ring)
            score = (0 if inside else 1, d, -area)
            if best is None or score < best[0]:
                best = (score, r, ring, area, inside, d, e)
    if not best:
        return None
    _, r, ring, area, inside, d, e = best
    hsrc = r["height_src"] or ""
    h = r["height"] if r["height"] is not None and r["height"] >= 2 else None  # one Shakopee warehouse read 0.05 m
    return {"source": "Overture Maps (ODbL)", "gers_id": r["id"], "release": e["release"], "geometry_from": r["geom_src"],
            "name": r["name"], "levels": int(r["num_floors"]) if r["num_floors"] else None, "levels_below": None,
            "height_m": h, "height_est": h is not None,
            "height_source": (hsrc.replace("Microsoft ML Buildings", "Microsoft machine-learned").replace("USGS Lidar", "USGS lidar") or None) if h else None,
            "kind": r["subtype"] or r["class"], "material": None, "facade": None, "roof": None, "built": None,
            "footprint_sqft": round(area * 10.7639), "outline": ring, "contains_pin": inside, "dist_m": round(d)}
