"""
Your own base maps: an ATAK / WinTAK map source (customMapSource XML), a tile address ({z}/{x}/{y}), or an MBTiles
file (the offline map format ATAK and QGIS use), kept on this PC and offered beside the built-in maps. Any map with a
tile address also goes out as an ATAK map source, so ATAK can show the same map.

Safety: only http(s) tile addresses; XML with a DOCTYPE is refused; MBTiles must be a real SQLite file with a tiles
table, and its tiles are read with parameters only; file names are made safe and kept in the data folder.
"""
import json
import os
import re
import sqlite3
import time
import xml.etree.ElementTree as ET

import uls_import


def folder():
    return os.path.join(uls_import.DATA_DIR, "basemaps")


def safe_id(s):
    return re.sub(r"[^a-z0-9-]+", "-", (s or "map").lower()).strip("-")[:40] or "map"


def check_url(url):
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("A tile address must start with http:// or https://.")
    url = url.replace("{$z}", "{z}").replace("{$x}", "{x}").replace("{$y}", "{y}").replace("{$s}", "{s}")
    if "{$q}" in url or "{q}" in url:
        raise ValueError("Quadkey addresses (Bing style, {$q}) aren't supported yet; use a {z}/{x}/{y} address.")
    if not all(k in url for k in ("{z}", "{x}", "{y}")):
        raise ValueError("A tile address needs {z}, {x} and {y} (ATAK's {$z}, {$x}, {$y} work too).")
    return url


def parse_map_source(data):
    """An ATAK / WinTAK customMapSource XML -> name, tile address and zoom range."""
    if b"<!DOCTYPE" in data[:2000].upper():
        raise ValueError("That XML has a DOCTYPE; refused.")
    root = ET.fromstring(data)
    if root.tag != "customMapSource":
        raise ValueError(f"Expected an ATAK map source (<customMapSource>), found <{root.tag}>.")
    g = lambda k, d=None: (root.findtext(k) or d)
    url = check_url(g("url"))
    return {"name": (g("name") or "Imported map").strip()[:80], "url": url, "min": int(g("minZoom", "0")), "max": int(g("maxZoom", "19")),
            "format": (g("tileType") or "image/png").split("/")[-1]}


def map_source_xml(name, url, min_zoom=0, max_zoom=19, fmt="png"):
    """A map for ATAK / WinTAK: the same tiles RF Recon shows."""
    x = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    atak = url.replace("{z}", "{$z}").replace("{x}", "{$x}").replace("{y}", "{$y}").replace("{s}", "{$s}")
    return (f'<?xml version="1.0" encoding="UTF-8"?>\n<customMapSource>\n  <name>{x(name)}</name>\n  <minZoom>{int(min_zoom)}</minZoom>\n'
            f"  <maxZoom>{int(max_zoom)}</maxZoom>\n  <tileType>image/{x(fmt)}</tileType>\n  <tileUpdate>None</tileUpdate>\n"
            f"  <url>{x(atak)}</url>\n  <backgroundColor>#000000</backgroundColor>\n</customMapSource>\n")


def mbtiles_info(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        if not con.execute("SELECT 1 FROM sqlite_master WHERE name='tiles'").fetchone():
            raise ValueError("That file has no tiles table, so it isn't an MBTiles map.")
        meta = dict(con.execute("SELECT name, value FROM metadata").fetchall()) if con.execute(
            "SELECT 1 FROM sqlite_master WHERE name='metadata'").fetchone() else {}
        zmin, zmax = con.execute("SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles").fetchone()
    finally:
        con.close()
    fmt = meta.get("format", "png")
    if fmt == "pbf":
        raise ValueError("That MBTiles holds vector tiles (pbf); RF Recon shows image tiles (png, jpg, webp).")
    return {"name": meta.get("name"), "format": fmt, "min": zmin or 0, "max": zmax or 19, "bounds": meta.get("bounds"),
            "attribution": meta.get("attribution")}


def save_mbtiles(name, data):
    if not data.startswith(b"SQLite format 3\x00"):
        raise ValueError("That isn't an MBTiles file (not SQLite).")
    os.makedirs(folder(), exist_ok=True)
    mid = safe_id(name)
    path = os.path.join(folder(), mid + ".mbtiles")
    with open(path + ".part", "wb") as fh:
        fh.write(data)
    try:
        info = mbtiles_info(path + ".part")
    except (sqlite3.Error, ValueError):
        os.remove(path + ".part")
        raise
    os.replace(path + ".part", path)
    return mid, info


def tile(mid, z, x, y):
    path = os.path.join(folder(), safe_id(mid) + ".mbtiles")
    if not os.path.isfile(path):
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:  # MBTiles counts rows from the bottom (TMS)
        r = con.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?", (z, x, (1 << z) - 1 - y)).fetchone()
    finally:
        con.close()
    return r[0] if r else None


def add(maps, name, data=None, url=None, filename=""):
    """Add a map from a tile address, an ATAK map source XML or an MBTiles file. Returns the new list."""
    now = time.strftime("%Y-%m-%d %H:%M")
    if url:
        m = {"name": (name or "My map").strip()[:80], "url": check_url(url), "min": 0, "max": 19, "format": "png", "kind": "url"}
    elif data and (filename.lower().endswith(".xml") or data.lstrip()[:1] == b"<"):
        m = dict(parse_map_source(data), kind="url")
        if name:
            m["name"] = name.strip()[:80]
    elif data:
        mid, info = save_mbtiles(name or os.path.splitext(filename)[0], data)
        m = {"name": (name or info["name"] or os.path.splitext(filename)[0])[:80], "mbtiles": mid, "min": info["min"], "max": info["max"],
             "format": info["format"], "bounds": info["bounds"], "kind": "mbtiles", "attribution": info.get("attribution")}
    else:
        raise ValueError("Give a tile address, an ATAK map source (.xml) or an MBTiles file.")
    m["id"] = m.get("mbtiles") or safe_id(m["name"])
    m["added"] = now
    return [x for x in maps if x.get("id") != m["id"]] + [m]


def remove(maps, mid):
    for m in maps:
        if m.get("id") == mid and m.get("kind") == "mbtiles":
            p = os.path.join(folder(), safe_id(m["mbtiles"]) + ".mbtiles")
            if os.path.isfile(p):
                os.remove(p)
    return [m for m in maps if m.get("id") != mid]


def dumps(maps):
    return json.dumps(maps)
