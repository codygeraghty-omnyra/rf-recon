"""
Map tiles and terrain kept ahead of time for each mission area, so the maps and coverage estimates work there with
no signal from the first visit.

The USGS National Map base maps are public domain and their services allow tile export (exportTilesAllowed, checked
2026-11-03); their stored tiles stop at zoom 16. Tiles go where the map's own cache keeps them (data/tiles/<source>/
z/x/y.png, app.py's tile()), so nothing here changes how the map reads them; a tile already kept is not fetched again.
OpenStreetMap and Esri tiles are never kept (their terms forbid it). Terrain tiles (AWS Terrain Tiles, open data)
use terrain.download_area. A 15-mile area is about 12,000 tiles a base map to zoom 16 (about 0.35 GB).
"""
import math
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import uls_import

_USGS = "https://basemap.nationalmap.gov/arcgis/rest/services/{}/MapServer/tile/{{z}}/{{y}}/{{x}}"
# source id (as app.py's TILE_SOURCES) -> (URL, deepest zoom kept)
MAPS = {"usgs-imagery": (_USGS.format("USGSImageryOnly"), 16), "usgs-imagery-topo": (_USGS.format("USGSImageryTopo"), 16),
        # relief to 16 like the others (Cody 11/10, sharper maps): USGS serves it to 16 (17 answers "not found", checked
        # 11/10) and the map shows it to 16, but until now only 13 was kept, so with no signal it went blank above 13.
        # Its tiles are small (3-4 KB at 14-16, read 11/10): about 30 MB more for a 15-mile area.
        "usgs-topo": (_USGS.format("USGSTopo"), 16), "usgs-relief": (_USGS.format("USGSShadedReliefOnly"), 16)}
UA = "RF-Recon/2.0 (site-survey tool; area tile cache for no-signal use)"
WORKERS = 4  # polite: USGS states no rate limit


def tile_dir():
    return os.path.join(uls_import.DATA_DIR, "tiles")


def xy(lat, lon, z):
    n = 2 ** z
    lat = max(-85.0511, min(85.0511, lat))
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(n - 1, max(0, x)), min(n - 1, max(0, y))


def tiles_for(lat, lon, radius_mi, zmax, zmin=0):
    """Every tile (z, x, y) covering the area's bounding square, zoom zmin..zmax."""
    km = radius_mi * 1.609344
    dlat = km / 111.0
    dlon = km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    out = []
    for z in range(zmin, zmax + 1):
        x0, y0 = xy(lat + dlat, lon - dlon, z)
        x1, y1 = xy(lat - dlat, lon + dlon, z)
        out += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    return out


def _path(src, z, x, y):
    return os.path.join(tile_dir(), src, str(z), str(x), f"{y}.png")


def _fetch(src, url, z, x, y):
    fp = _path(src, z, x, y)
    if os.path.exists(fp):
        return "kept"
    try:
        req = urllib.request.Request(url.format(z=z, x=x, y=y), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        # 404: USGS has no tile there (open sea, a map's gaps, zoom 0 of imagery + topo). Not a failure: on 11/3 these
        # 486 tiles marked the job failed every run
        return "none" if e.code == 404 else "missed"
    except Exception:
        return "missed"
    if not (data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff"):  # an error page, not an image
        return "missed"
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    tmp = fp + ".part"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, fp)
    return "new"


def prefetch(areas, maps=None, log=print):
    """Keep every base map tile and the terrain for each (lat, lon, radius_mi) area. Returns counts."""
    import terrain
    counts = {"new": 0, "kept": 0, "missed": 0, "none": 0}
    for i, (lat, lon, radius) in enumerate(areas, 1):
        for src in maps or MAPS:
            url, zmax = MAPS[src]
            todo = tiles_for(lat, lon, radius, zmax)
            with ThreadPoolExecutor(WORKERS) as ex:
                for k, r in enumerate(ex.map(lambda t: _fetch(src, url, *t), todo), 1):
                    counts[r] += 1
                    if k % 2000 == 0:
                        log(f"area {i}/{len(areas)} · {src} {k:,}/{len(todo):,} tiles")
        log(f"area {i}/{len(areas)} · terrain")
        terrain.download_area(lat, lon, radius)
    return counts
