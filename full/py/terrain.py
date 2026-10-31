"""
Terrain: ground elevation from the public AWS Terrain Tiles (Terrarium PNGs: USGS 3DEP in the US, SRTM and others
elsewhere; https://registry.opendata.aws/terrain-tiles/), cached on this PC so paths and coverage keep working
offline once an area has been looked at or downloaded. Standard library only.

Used by the DAS pre-survey (is the path from an agency's site to the roof clear?) and by coverage (where a
transmitter reaches, with hills counted). Diffraction is ITU-R P.526's single knife edge.
"""
import array
import math
import os
import struct
import threading
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor

import geo
import uls_import

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool; local cache)"}
ATTRIBUTION = "Terrain: AWS Terrain Tiles (USGS 3DEP, SRTM and others)"
EARTH_M = geo.EARTH_KM * 1000
K = 4 / 3  # effective earth radius factor (standard atmospheric refraction)
_mem, _lock = {}, threading.Lock()


def cache_dir():
    return os.path.join(uls_import.DATA_DIR, "terrain")


def decode_png(data):
    """A Terrarium tile (8-bit RGB or RGBA PNG, not interlaced) -> 256 x 256 elevations in whole metres, row by row."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, w, h, bpp = 8, [], 0, 0, 3
    while pos + 8 <= len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        pos += 12 + n
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, inter = struct.unpack(">IIBBBBB", body)
            if depth != 8 or ctype not in (2, 6) or inter:
                raise ValueError("unsupported PNG")
            bpp = 3 if ctype == 2 else 4
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    raw = zlib.decompress(b"".join(idat))
    stride = w * bpp
    prev = bytearray(stride)
    out = array.array("h")
    i = 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if f == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif f == 2:
            line = bytearray((a + b) & 255 for a, b in zip(line, prev))
        elif f == 3:
            for x in range(stride):
                line[x] = (line[x] + ((line[x - bpp] if x >= bpp else 0) + prev[x]) // 2) & 255
        elif f == 4:
            for x in range(stride):
                a, b = (line[x - bpp] if x >= bpp else 0), prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out.extend(max(-32768, min(32767, round(line[p] * 256 + line[p + 1] + line[p + 2] / 256 - 32768)))
                   for p in range(0, stride, bpp))
        prev = line
    return out


def _path(z, x, y):
    return os.path.join(cache_dir(), str(z), str(x), f"{y}.h16")


def tile(z, x, y, fetch=True):
    """One tile's elevations: from memory, the PC's cache, or (fetch=True) the internet. None when not available."""
    key = (z, x, y)
    t = _mem.get(key)
    if t is not None:
        return t
    p = _path(z, x, y)
    if os.path.exists(p):
        t = array.array("h")
        with open(p, "rb") as fh:
            t.frombytes(fh.read())
    elif not fetch:
        return None
    else:
        with urllib.request.urlopen(urllib.request.Request(URL.format(z=z, x=x, y=y), headers=UA), timeout=20) as r:
            t = decode_png(r.read())
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p + ".part", "wb") as fh:
            fh.write(t.tobytes())
        os.replace(p + ".part", p)
    with _lock:
        if len(_mem) > 200:
            _mem.clear()
        _mem[key] = t
    return t


def _xy(lat, lon, z):
    n = 2 ** z
    lat = max(-85.0, min(85.0, lat))
    return (lon + 180.0) / 360.0 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def zoom_for(radius_km):
    """About 30 m per pixel for short paths, 60 m and 120 m for wider coverage (fewer tiles to fetch)."""
    return 12 if radius_km <= 15 else 11 if radius_km <= 40 else 10


def tiles_for(lat, lon, radius_km, z):
    s, n, w, e = geo.bbox(lat, lon, radius_km / geo.MI_KM)
    x0, y0 = _xy(n, w, z)
    x1, y1 = _xy(s, e, z)
    return [(z, x, y) for x in range(int(x0), int(x1) + 1) for y in range(int(y0), int(y1) + 1)]


def ensure(tiles, workers=8):
    """Fetch the tiles not cached yet, in parallel. Returns counts; failures mean offline or no data there."""
    missing = [t for t in tiles if t not in _mem and not os.path.exists(_path(*t))]
    failed = []

    def get(t):
        try:
            tile(*t)
        except Exception:
            failed.append(t)
    if missing:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(get, missing))
    return {"tiles": len(tiles), "fetched": len(missing) - len(failed), "failed": len(failed)}


def elevation(lat, lon, z=12, fetch=True):
    x, y = _xy(lat, lon, z)
    tx, ty = int(x), int(y)
    t = _mem.get((z, tx, ty)) or tile(z, tx, ty, fetch)
    if t is None:
        return None
    return t[min(255, int((y - ty) * 256)) * 256 + min(255, int((x - tx) * 256))]


def cache_status():
    n, size = 0, 0
    for root, _, files in os.walk(cache_dir()):
        for f in files:
            if f.endswith(".h16"):
                n += 1
                size += os.path.getsize(os.path.join(root, f))
    return {"tiles": n, "mb": round(size / 1e6, 1), "folder": cache_dir(), "attribution": ATTRIBUTION}


def download_area(lat, lon, radius_mi):
    """Everything coverage and path checks use around a place: 30 m tiles near it, coarser ones further out."""
    r = radius_mi * geo.MI_KM
    tiles = tiles_for(lat, lon, min(r, 15), 12) + tiles_for(lat, lon, min(r * 2, 40), 11) + tiles_for(lat, lon, max(r * 2, 40), 10)
    return ensure(sorted(set(tiles)))


def knife_edge_db(v):
    """ITU-R P.526 single knife-edge diffraction loss J(v), dB; 0 once the path clears by enough."""
    return 0.0 if v <= -0.78 else 6.9 + 20 * math.log10(math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)


def profile(lat1, lon1, h1_m, lat2, lon2, h2_m, f_mhz, z=12, fetch=True, skip_end_m=0):
    """Path from an antenna h1_m above the ground at point 1 to one h2_m above point 2: line of sight, first
    Fresnel zone clearance and the knife-edge loss of the worst obstacle (earth curvature with k = 4/3).
    skip_end_m: ground this close to point 2 doesn't count toward the loss (a handheld's own surroundings, which
    an area model already covers); it still counts toward clearance."""
    D = geo.haversine_km(lat1, lon1, lat2, lon2) * 1000
    n = max(20, min(600, int(D / 30)))
    ground = []
    for i in range(n + 1):
        e = elevation(lat1 + (lat2 - lat1) * i / n, lon1 + (lon2 - lon1) * i / n, z, fetch)
        if e is None:
            raise LookupError("Terrain for this path isn't on this PC yet and it can't be downloaded now (offline?).")
        ground.append(e)
    lam = 299.792458 / f_mhz
    tx, rx = ground[0] + h1_m, ground[-1] + h2_m
    worst_v, worst, min_ratio, pts = -1e9, None, 1e9, []
    for i in range(1, n):
        d1 = D * i / n
        d2 = D - d1
        g = ground[i] + d1 * d2 / (2 * K * EARTH_M)  # the earth's bulge raises the ground under the path
        los = tx + (rx - tx) * i / n
        f1 = math.sqrt(lam * d1 * d2 / D)
        min_ratio = min(min_ratio, (los - g) / f1)
        v = (g - los) * math.sqrt(2 * D / (lam * d1 * d2))
        if v > worst_v and d2 >= skip_end_m:
            worst_v, worst = v, (d1, g, los)
        if i % max(1, n // 120) == 0:
            pts.append([round(d1 / 1000, 3), round(g, 1), round(los, 1), round(f1, 1)])
    status = "clear" if min_ratio >= 0.6 else "Fresnel zone partly blocked" if min_ratio >= 0 else "blocked by terrain"
    return {"dist_km": round(D / 1000, 2), "status": status, "loss_db": round(knife_edge_db(worst_v), 1),
            "clearance_f1": round(min_ratio, 2), "worst_at_km": round(worst[0] / 1000, 2) if worst else None,
            "worst_above_los_m": round(worst[1] - worst[2], 1) if worst else None,
            "ground1_m": ground[0], "ground2_m": ground[-1], "h1_m": h1_m, "h2_m": h2_m, "points": pts}
