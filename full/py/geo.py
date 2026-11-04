"""
Geo utilities: distance/bearing, heatmap gridding, PNG / GeoTIFF / world-file /
KML / KMZ writers. Standard library only (uses numpy automatically if installed,
for speed).
"""
import io
import math
import struct
import zipfile
import zlib
from xml.sax.saxutils import escape

try:
    import numpy as np  # optional
except Exception:  # pragma: no cover
    np = None

EARTH_KM = 6371.0088
MI_KM = 1.609344
WGS84_PRJ = ('GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],'
             'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]')


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def compass(b):
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][int((b + 11.25) // 22.5) % 16]


def bearing_fix(readings):
    """Where lines of bearing cross: readings are (lat, lon, bearing_deg) from the places a signal was heard.
    Least squares on a flat local plane (fine over a few tens of km): the point whose summed squared distance
    to every line is smallest. Returns {lat, lon, n, rms_m, crossing_deg, behind, quality} or None when the
    lines are (near) parallel. rms_m is how far the lines miss the fix on average; crossing_deg is the widest
    angle at which two of the lines cross (0-90: under about 20 they cross shallowly and the fix stretches along
    them); behind counts readings whose bearing points away from the fix."""
    pts = [(float(a), float(o), float(b) % 360) for a, o, b in readings
           if a is not None and o is not None and b is not None]
    if len(pts) < 2:
        return None
    lat0 = sum(p[0] for p in pts) / len(pts)
    lon0 = sum(p[1] for p in pts) / len(pts)
    kx = 1000 * EARTH_KM * math.radians(1) * math.cos(math.radians(lat0))  # metres per degree of longitude here
    ky = 1000 * EARTH_KM * math.radians(1)
    lines = [((o - lon0) * kx, (a - lat0) * ky, math.sin(math.radians(b)), math.cos(math.radians(b))) for a, o, b in pts]
    s11 = s12 = s22 = t1 = t2 = 0.0
    for x, y, ux, uy in lines:  # sum of (I - u u^T) and (I - u u^T) p
        a11, a12, a22 = 1 - ux * ux, -ux * uy, 1 - uy * uy
        s11, s12, s22 = s11 + a11, s12 + a12, s22 + a22
        t1, t2 = t1 + a11 * x + a12 * y, t2 + a12 * x + a22 * y
    det = s11 * s22 - s12 * s12
    if abs(det) < 1e-6 * len(lines) ** 2:
        return None
    fx, fy = (s22 * t1 - s12 * t2) / det, (s11 * t2 - s12 * t1) / det
    miss = [abs((fx - x) * uy - (fy - y) * ux) for x, y, ux, uy in lines]  # distance from the fix to each line
    behind = sum(1 for x, y, ux, uy in lines if (fx - x) * ux + (fy - y) * uy < 0)
    bs = [p[2] for p in pts][:200]  # the widest crossing between any two lines (a line has no direction: mod 180)
    crossing = max(min((a - b) % 180, 180 - (a - b) % 180) for i, a in enumerate(bs) for b in bs[i + 1:])
    rms = math.sqrt(sum(m * m for m in miss) / len(miss))
    quality = "poor" if behind or crossing < 20 else "fair" if crossing < 45 or len(pts) < 3 else "good"
    out = {"lat": lat0 + fy / ky, "lon": lon0 + fx / kx, "n": len(pts), "rms_m": rms,
           "crossing_deg": crossing, "behind": behind, "quality": quality}
    out["ellipse"] = error_ellipse(lines, fx, fy, lat0, lon0, kx, ky)
    return out


BEARING_ERR_DEG = 5.0  # a handheld directional antenna's bearing, one sigma, when the readings can't say better


def error_ellipse(lines, fx, fy, lat0, lon0, kx, ky, conf=0.95):
    """Where the transmitter probably is: the 95% error ellipse of the bearing fix. Each line's sideways error grows
    with distance (sigma = distance x tan(bearing error)); the bearing error is BEARING_ERR_DEG, or what the lines'
    own misses show when three or more disagree by more. Weighted least squares gives the fix's covariance; its
    eigenvectors are the ellipse's axes. Returns {a_m, b_m, axis_deg, bearing_err_deg, conf, ring} or None."""
    dist = [max(30.0, math.hypot(fx - x, fy - y)) for x, y, _ux, _uy in lines]
    err = BEARING_ERR_DEG
    if len(lines) >= 3:  # the angles the lines actually miss the fix by
        ang = [math.degrees(math.atan2(abs((fx - x) * uy - (fy - y) * ux), d)) for (x, y, ux, uy), d in zip(lines, dist)]
        err = max(err, math.sqrt(sum(a * a for a in ang) / (len(ang) - 2)))
    s11 = s12 = s22 = 0.0
    for (x, y, ux, uy), d in zip(lines, dist):
        w = 1 / (d * math.tan(math.radians(err))) ** 2
        s11, s12, s22 = s11 + w * (1 - ux * ux), s12 - w * ux * uy, s22 + w * (1 - uy * uy)
    det = s11 * s22 - s12 * s12
    if det <= 0:
        return None
    c11, c12, c22 = s22 / det, -s12 / det, s11 / det  # covariance, m^2 (x east, y north)
    tr, dif = (c11 + c22) / 2, math.sqrt(((c11 - c22) / 2) ** 2 + c12 * c12)
    l1, l2 = tr + dif, max(tr - dif, 0.0)
    k = math.sqrt(-2 * math.log(1 - conf))  # 2.45 for 95% in two dimensions
    a, b = k * math.sqrt(l1), k * math.sqrt(l2)
    theta = 0.5 * math.atan2(2 * c12, c11 - c22)  # the major axis, radians from east
    ring = []
    for i in range(49):
        t = 2 * math.pi * i / 48
        ex = a * math.cos(t) * math.cos(theta) - b * math.sin(t) * math.sin(theta)
        ey = a * math.cos(t) * math.sin(theta) + b * math.sin(t) * math.cos(theta)
        ring.append([round(lat0 + (fy + ey) / ky, 6), round(lon0 + (fx + ex) / kx, 6)])
    return {"a_m": round(a), "b_m": round(b), "axis_deg": round((90 - math.degrees(theta)) % 180),
            "bearing_err_deg": round(err, 1), "conf": conf, "ring": ring}


SHADOW_DB = 6.0  # how much a level reading wanders from the path loss model (walls, cars, the body): one sigma, dB


def level_fix(readings, grid=70):
    """Where a transmitter probably is from signal levels alone (no direction finder): readings are
    (lat, lon, dbm). The level falls off with distance as P = A - 10 n log10(d); for every spot on a grid around
    the readings, and path loss exponents n from 2 (open ground) to 4 (built up), the best-fitting A is found
    and the spot scored by how well the readings fit. The best spot is the estimate; the spots that fit nearly as
    well (95%, with readings wandering SHADOW_DB or what they show) are the area it's probably in. Needs 3
    readings spread at least 6 dB apart. Returns {lat, lon, n, radius_m, n_exp, quality, ring, strongest} or None."""
    pts = [(float(a), float(o), float(p)) for a, o, p in readings if a is not None and o is not None and p is not None]
    if len(pts) < 3 or max(p[2] for p in pts) - min(p[2] for p in pts) < 6:
        return None
    lat0, lon0 = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
    kx = 1000 * EARTH_KM * math.radians(1) * math.cos(math.radians(lat0))
    ky = 1000 * EARTH_KM * math.radians(1)
    xy = [((o - lon0) * kx, (a - lat0) * ky, p) for a, o, p in pts]
    xs, ys = [q[0] for q in xy], [q[1] for q in xy]
    span = max(max(xs) - min(xs), max(ys) - min(ys), 100.0)
    pad = max(300.0, span)  # the source can be outside the walked area, more so when the readings only rise one way
    x0, x1, y0, y1 = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    step = max(x1 - x0, y1 - y0) / grid
    exps = (2.0, 2.5, 3.0, 3.5, 4.0)
    cells = []
    for i in range(grid + 1):
        for j in range(grid + 1):
            cx, cy = x0 + i * step, y0 + j * step
            best = None
            for n in exps:
                g = [-10 * n * math.log10(max(10.0, math.hypot(cx - x, cy - y))) for x, y, _p in xy]
                a = sum(p - gi for (_x, _y, p), gi in zip(xy, g)) / len(xy)
                sse = sum((p - a - gi) ** 2 for (_x, _y, p), gi in zip(xy, g))
                if best is None or sse < best[0]:
                    best = (sse, n)
            cells.append((best[0], cx, cy, best[1]))
    sse0, bx, by, bn = min(cells)
    sigma2 = max(SHADOW_DB ** 2, sse0 / max(1, len(xy) - 2))
    region = [c for c in cells if c[0] <= sse0 + 5.99 * sigma2]  # chi-square, 2 dof, 95%
    radius = math.sqrt(len(region) * step * step / math.pi)
    # the outline of the area it's probably in: the farthest region cell in each of 36 directions from the estimate
    ring = []
    for k in range(37):
        t = math.radians(k * 10)
        far = max((math.hypot(c[1] - bx, c[2] - by) for c in region
                   if abs(((math.degrees(math.atan2(c[1] - bx, c[2] - by)) - k * 10) + 180) % 360 - 180) <= 6), default=step)
        ring.append([round(lat0 + (by + far * math.cos(t)) / ky, 6), round(lon0 + (bx + far * math.sin(t)) / kx, 6)])
    top = max(pts, key=lambda p: p[2])
    quality = "good" if len(pts) >= 5 and radius < 250 else "fair" if radius < 700 else "poor"
    return {"lat": lat0 + by / ky, "lon": lon0 + bx / kx, "n": len(pts), "radius_m": round(radius), "n_exp": bn,
            "quality": quality, "ring": ring, "strongest": {"lat": top[0], "lon": top[1], "dbm": top[2]}}


def combine_fixes(level, bearing):
    """One best guess from a level estimate and a bearing fix: weighted by how small each one's area is."""
    if not level or not bearing:
        return level or bearing
    rb = max(30.0, (bearing.get("ellipse") or {}).get("a_m") or bearing.get("rms_m") or 300.0)
    rl = max(30.0, level["radius_m"])
    wb, wl = 1 / rb ** 2, 1 / rl ** 2
    return {"lat": (bearing["lat"] * wb + level["lat"] * wl) / (wb + wl), "lon": (bearing["lon"] * wb + level["lon"] * wl) / (wb + wl),
            "radius_m": round(1 / math.sqrt(wb + wl)), "from": "levels and bearings"}


def bbox(lat, lon, radius_mi):
    r = radius_mi * MI_KM
    dlat = r / 111.0
    dlon = r / (111.0 * max(0.05, math.cos(math.radians(lat))))
    return lat - dlat, lat + dlat, lon - dlon, lon + dlon


def fspl_rx_dbm(erp_w, d_km, f_mhz):
    """Free-space received level at a 0 dBi antenna (best case)."""
    if not erp_w or not f_mhz or d_km is None:
        return None
    d = max(d_km, 0.05)
    return 10 * math.log10(erp_w * 1000) + 2.15 - (20 * math.log10(d) + 20 * math.log10(f_mhz) + 32.44)


# ---------------------------------------------------------------- gridding

class Grid:
    """Regular lat/lon grid; values[row][col], row 0 = north edge."""

    def __init__(self, s, n, w, e, cols, rows):
        self.s, self.n, self.w, self.e, self.cols, self.rows = s, n, w, e, cols, rows
        self.dx = (e - w) / cols
        self.dy = (n - s) / rows
        self.values = [[None] * cols for _ in range(rows)]

    def cell_center(self, r, c):
        return self.n - (r + 0.5) * self.dy, self.w + (c + 0.5) * self.dx

    def to_cell(self, lat, lon):
        return int((self.n - lat) / self.dy), int((lon - self.w) / self.dx)

    def stats(self):
        vals = [v for row in self.values for v in row if v is not None]
        return (min(vals), max(vals), len(vals)) if vals else (None, None, 0)


def make_grid(lat, lon, radius_mi, size=200):
    s, n, w, e = bbox(lat, lon, radius_mi)
    return Grid(s, n, w, e, size, size)


def grid_measured(grid, points, cell_radius=4, metric="mean"):
    """points: (lat, lon, dbm). Gaussian-weighted mean (or max) of dBm near each cell.
    Cells far from any measurement stay empty (no extrapolation)."""
    rows, cols = grid.rows, grid.cols
    if metric == "max":
        acc = [[None] * cols for _ in range(rows)]
    else:
        sw = [[0.0] * cols for _ in range(rows)]
        swv = [[0.0] * cols for _ in range(rows)]
    sig2 = 2 * (cell_radius / 2.0) ** 2
    kern = [(dr, dc, math.exp(-(dr * dr + dc * dc) / sig2))
            for dr in range(-cell_radius, cell_radius + 1) for dc in range(-cell_radius, cell_radius + 1)
            if dr * dr + dc * dc <= cell_radius * cell_radius]
    for la, lo, v in points:
        if v is None or la is None:
            continue
        r0, c0 = grid.to_cell(la, lo)
        for dr, dc, w in kern:
            r, c = r0 + dr, c0 + dc
            if 0 <= r < rows and 0 <= c < cols:
                if metric == "max":
                    cur = acc[r][c]
                    if cur is None or v > cur:
                        acc[r][c] = v
                else:
                    sw[r][c] += w
                    swv[r][c] += w * v
    for r in range(rows):
        for c in range(cols):
            if metric == "max":
                grid.values[r][c] = acc[r][c]
            elif sw[r][c] > 0.05:
                grid.values[r][c] = swv[r][c] / sw[r][c]
    return grid


def grid_predicted(grid, transmitters, floor_dbm=-120, combine="max"):
    """transmitters: (lat, lon, erp_w, f_mhz). Free-space prediction, best case.
    combine='max' = strongest signal; 'sum' = aggregate RF energy."""
    tx = [t for t in transmitters if t[0] is not None and t[2] and t[3]]
    if not tx:
        return grid
    if np is not None:
        lats = np.array([grid.cell_center(r, 0)[0] for r in range(grid.rows)])[:, None]
        lons = np.array([grid.cell_center(0, c)[1] for c in range(grid.cols)])[None, :]
        best = np.full((grid.rows, grid.cols), -np.inf) if combine == "max" else np.zeros((grid.rows, grid.cols))
        for la, lo, erp, f in tx:
            p1 = math.radians(la)
            dp = np.radians(lats - la)
            dl = np.radians(lons - lo)
            a = np.sin(dp / 2) ** 2 + math.cos(p1) * np.cos(np.radians(lats)) * np.sin(dl / 2) ** 2
            d = np.maximum(2 * EARTH_KM * np.arcsin(np.minimum(1, np.sqrt(a))), 0.05)
            dbm = 10 * math.log10(erp * 1000) + 2.15 - (20 * np.log10(d) + 20 * math.log10(f) + 32.44)
            if combine == "max":
                best = np.maximum(best, dbm)
            else:
                best += 10 ** (dbm / 10)
        if combine == "sum":
            best = 10 * np.log10(np.maximum(best, 1e-30))
        for r in range(grid.rows):
            for c in range(grid.cols):
                v = float(best[r, c])
                grid.values[r][c] = v if v >= floor_dbm else None
        return grid
    for r in range(grid.rows):
        for c in range(grid.cols):
            la0, lo0 = grid.cell_center(r, c)
            vals = [fspl_rx_dbm(erp, haversine_km(la0, lo0, la, lo), f) for la, lo, erp, f in tx]
            if combine == "max":
                v = max(vals)
            else:
                v = 10 * math.log10(sum(10 ** (x / 10) for x in vals))
            grid.values[r][c] = v if v >= floor_dbm else None
    return grid


def grid_density(grid, points, cell_radius=6):
    """points: (lat, lon, weight). Kernel density, normalized 0-100."""
    acc = [[0.0] * grid.cols for _ in range(grid.rows)]
    sig2 = 2 * (cell_radius / 2.0) ** 2
    kern = [(dr, dc, math.exp(-(dr * dr + dc * dc) / sig2))
            for dr in range(-cell_radius, cell_radius + 1) for dc in range(-cell_radius, cell_radius + 1)]
    for la, lo, wgt in points:
        r0, c0 = grid.to_cell(la, lo)
        for dr, dc, w in kern:
            r, c = r0 + dr, c0 + dc
            if 0 <= r < grid.rows and 0 <= c < grid.cols:
                acc[r][c] += w * (wgt or 1)
    mx = max(max(row) for row in acc) or 1
    for r in range(grid.rows):
        for c in range(grid.cols):
            v = 100 * acc[r][c] / mx
            grid.values[r][c] = v if v > 1 else None
    return grid


# ---------------------------------------------------------------- color

_RAMP = [  # turbo-like: blue -> cyan -> green -> yellow -> red
    (0.00, (48, 18, 59)), (0.15, (70, 107, 227)), (0.30, (41, 187, 236)), (0.45, (49, 241, 152)),
    (0.60, (163, 253, 61)), (0.75, (237, 208, 58)), (0.88, (251, 128, 34)), (1.00, (180, 4, 38)),
]


def ramp(t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    for (t0, c0), (t1, c1) in zip(_RAMP, _RAMP[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0) if t1 > t0 else 0
            return tuple(int(c0[i] + (c1[i] - c0[i]) * k) for i in range(3))
    return _RAMP[-1][1]


def colorize(grid, vmin=None, vmax=None, alpha=190):
    vals = sorted(v for row in grid.values for v in row if v is not None)
    lo = vals[int(0.02 * (len(vals) - 1))] if vals else None   # clip 2% tails so one very close
    hi = vals[int(0.98 * (len(vals) - 1))] if vals else None   # transmitter doesn't wash out the scale
    vmin = lo if vmin is None else vmin
    vmax = hi if vmax is None else vmax
    if vmin is None:
        vmin, vmax = 0, 1
    span = (vmax - vmin) or 1
    out = bytearray()
    for row in grid.values:
        for v in row:
            if v is None:
                out += b"\x00\x00\x00\x00"
            else:
                r, g, b = ramp((v - vmin) / span)
                out += bytes((r, g, b, alpha))
    return bytes(out), vmin, vmax


# ---------------------------------------------------------------- writers

def png_rgba(width, height, rgba):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    stride = width * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def geotiff(grid, rgba=None, nodata=-9999.0):
    """Little-endian baseline TIFF + GeoTIFF tags, EPSG:4326, PixelIsArea.
    rgba given -> 4-band 8-bit image; else 1-band float32 of the grid values."""
    w, h = grid.cols, grid.rows
    if rgba is not None:
        data, spp, bps, sfmt, photo = rgba, 4, 8, 1, 2
    else:
        vals = [nodata if v is None else float(v) for row in grid.values for v in row]
        data, spp, bps, sfmt, photo = struct.pack("<%df" % len(vals), *vals), 1, 32, 3, 1
    entries = []  # (tag, type, count, value-bytes)

    def add(tag, typ, values):
        fmt = {3: "H", 4: "I", 12: "d", 2: None}[typ]
        if typ == 2:
            b = values.encode() + b"\x00"
            entries.append((tag, typ, len(b), b))
        else:
            entries.append((tag, typ, len(values), struct.pack("<%d%s" % (len(values), fmt), *values)))
    add(256, 4, [w]); add(257, 4, [h]); add(258, 3, [bps] * spp); add(259, 3, [1]); add(262, 3, [photo])
    add(273, 4, [0])  # strip offset, patched below
    add(277, 3, [spp]); add(278, 4, [h]); add(279, 4, [len(data)]); add(284, 3, [1])
    if spp == 4:
        add(338, 3, [2])
    add(339, 3, [sfmt] * spp)
    add(33550, 12, [grid.dx, grid.dy, 0.0])
    add(33922, 12, [0.0, 0.0, 0.0, grid.w, grid.n, 0.0])
    add(34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326])
    if spp == 1:
        add(42113, 2, str(int(nodata)))
    entries.sort(key=lambda e: e[0])
    n = len(entries)
    ifd_off = 8
    extra_off = ifd_off + 2 + n * 12 + 4
    extra = bytearray()
    ifd = bytearray(struct.pack("<H", n))
    patch = None
    for tag, typ, cnt, vb in entries:
        if len(vb) <= 4:
            ifd += struct.pack("<HHI", tag, typ, cnt) + vb.ljust(4, b"\x00")
            if tag == 273:
                patch = len(ifd) - 4
        else:
            if (extra_off + len(extra)) % 2:
                extra += b"\x00"
            ifd += struct.pack("<HHII", tag, typ, cnt, extra_off + len(extra))
            extra += vb
    ifd += struct.pack("<I", 0)
    data_off = extra_off + len(extra)
    if data_off % 2:
        extra += b"\x00"
        data_off += 1
    ifd[patch:patch + 4] = struct.pack("<I", data_off)
    return b"II" + struct.pack("<HI", 42, ifd_off) + bytes(ifd) + bytes(extra) + data


def world_file(grid):
    """ESRI world file (.pgw/.tfw) for the PNG/TIFF: pixel size and upper-left pixel center."""
    return "\n".join(f"{v:.12f}" for v in (grid.dx, 0.0, 0.0, -grid.dy, grid.w + grid.dx / 2, grid.n - grid.dy / 2)) + "\n"


KML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>'


def kml_color(hex_rgb, alpha="ff"):
    h = hex_rgb.lstrip("#")
    return alpha + h[4:6] + h[2:4] + h[0:2]  # KML is aabbggrr


def ground_overlay(name, href, grid, desc=""):
    return (f"<GroundOverlay><name>{escape(name)}</name><description>{escape(desc)}</description>"
            f"<Icon><href>{href}</href></Icon><LatLonBox><north>{grid.n}</north><south>{grid.s}</south>"
            f"<east>{grid.e}</east><west>{grid.w}</west></LatLonBox></GroundOverlay>")


def legend_png(vmin, vmax, unit="dBm", width=260, height=46):
    """Simple color bar (no text rendering; labels go in KML description)."""
    rgba = bytearray()
    for y in range(height):
        for x in range(width):
            if 6 <= y <= height - 6:
                r, g, b = ramp(x / (width - 1))
                rgba += bytes((r, g, b, 255))
            else:
                rgba += b"\x00\x00\x00\x00"
    return png_rgba(width, height, bytes(rgba))


def kmz(doc_kml, files):
    """files: {name: bytes}. Returns KMZ bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("doc.kml", doc_kml)
        for n, b in files.items():
            z.writestr(n, b)
    return buf.getvalue()
