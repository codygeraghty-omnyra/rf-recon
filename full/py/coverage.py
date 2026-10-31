"""
Coverage of one transmitter: where its signal reaches, as a heatmap, the edge of its coverage, its antenna pattern
and the path to the pin. These are estimates:
  - the area model: ITU-R P.525 free space (best case), or Okumura-Hata for urban, suburban or open land
    (COST-231 above 1500 MHz), never stronger than free space;
  - the antenna's horizontal pattern when an azimuth and beamwidth are known (licence data, or a cell sector's
    direction estimated from its crowd position), a 3GPP-style main lobe with a 25 dB front-to-back ratio;
  - with terrain, diffraction over the highest ridge between (single knife edge, ITU-R P.526; terrain.py).
"""
import math

import geo
import terrain

MODELS = {"free": "Free space (best case)", "suburban": "Hata, suburban", "urban": "Hata, urban", "open": "Hata, open land"}
FRONT_BACK_DB = 25.0
RADIALS, STEPS = 360, 240


def fspl_db(d_km, f_mhz):
    return 20 * math.log10(max(d_km, 0.001)) + 20 * math.log10(f_mhz) + 32.44


def hata_db(d_km, f_mhz, hb_m, hm_m, env):
    """Okumura-Hata median path loss (COST-231 above 1500 MHz), never below free space."""
    lf, hb = math.log10(f_mhz), max(10.0, min(hb_m, 300.0))
    a = (1.1 * lf - 0.7) * hm_m - (1.56 * lf - 0.8)
    slope = (44.9 - 6.55 * math.log10(hb)) * math.log10(max(d_km, 0.05))
    if f_mhz <= 1500:
        loss = 69.55 + 26.16 * lf - 13.82 * math.log10(hb) - a + slope
    else:
        loss = 46.3 + 33.9 * lf - 13.82 * math.log10(hb) - a + slope + (3 if env == "urban" else 0)
    if env == "suburban" and f_mhz <= 1500:
        loss -= 2 * math.log10(f_mhz / 28) ** 2 + 5.4
    elif env == "open":
        loss -= 4.78 * lf ** 2 - 18.33 * lf + 40.94
    return max(loss, fspl_db(d_km, f_mhz))


def pattern_db(brg, az, bw):
    """Horizontal pattern relative to the main beam, dB (0 for an omni)."""
    if az is None or not bw or bw >= 360:
        return 0.0
    t = abs((brg - az + 180) % 360 - 180)
    return -min(12 * (t / bw) ** 2, FRONT_BACK_DB)


def eirp_of(erp_w=None, power_w=None, gain_dbi=None, eirp_dbm=None):
    """EIRP in dBm and where it came from."""
    if eirp_dbm is not None:
        return eirp_dbm, f"{eirp_dbm:g} dBm EIRP, set by you"
    if erp_w:
        return 10 * math.log10(erp_w * 1000) + 2.15, f"licensed ERP {erp_w:g} W"
    if power_w:
        return (10 * math.log10(power_w * 1000) + (gain_dbi or 0),
                f"transmitter {power_w:g} W" + (f" + {gain_dbi:g} dBi antenna" if gain_dbi else " (no antenna gain on file)"))
    raise ValueError("No power on file for this transmitter, so its coverage can't be estimated. Set the EIRP by hand.")


def dest(lat, lon, brg_deg, d_km):
    p1, l1, b, d = math.radians(lat), math.radians(lon), math.radians(brg_deg), d_km / geo.EARTH_KM
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def radial_table(lat, lon, R, z, have_terrain, g0, h_tx, h_rx, lam, eirp, loss, az, bw, threshold, radials=RADIALS, steps=STEPS):
    """The level along each bearing out to R km: the area model, the antenna pattern, and the loss over the highest
    ridge as seen from the site (terrain, or a smooth earth so the radio horizon still counts). Also the farthest
    distance each bearing still reaches `threshold`."""
    step = R / steps
    base = [eirp - loss(step * i) for i in range(1, steps + 1)]  # the model depends on distance only
    drop = [(step * i * 1000) ** 2 / (2 * terrain.K * terrain.EARTH_M) for i in range(1, steps + 1)]  # the earth's curve
    gap = max(1, math.ceil(1.0 / step))  # ground within 1 km of the receiver is its own clutter, which the area model covers
    g_site = g0 if have_terrain else 0.0
    H_tx = g_site + h_tx
    levels, edge = [], []
    for j in range(radials):
        b = j * 360.0 / radials
        pat = pattern_db(b, az, bw)
        row, ground, edge_km, e_prev = [], [], 0.0, g_site
        best, obs_d, obs_h = -1e18, None, None
        for i in range(1, steps + 1):
            d = step * i
            if have_terrain:
                e = terrain.elevation(*dest(lat, lon, b, d), z, fetch=False)
                e_prev = e if e is not None else e_prev
            g = e_prev - drop[i - 1]  # ground below the site's horizon plane
            ground.append(g)
            k = i - 1 - gap  # the ridge that rises highest as seen from the site, at least 1 km short of here
            if k >= 0:
                s = (ground[k] - H_tx) / (step * (k + 1))
                if s > best:
                    best, obs_d, obs_h = s, step * (k + 1), ground[k]
            lvl = base[i - 1] + pat
            if obs_d is not None:
                los = H_tx + (g + h_rx - H_tx) * obs_d / d
                lvl -= terrain.knife_edge_db((obs_h - los) * math.sqrt(2 * d / (lam * obs_d * (d - obs_d) * 1000)))
            row.append(lvl)
            if lvl >= threshold:
                edge_km = d  # the farthest it still reaches (behind a hill it can drop out and come back)
        levels.append(row)
        edge.append(edge_km)
    return levels, edge


def site_height(lat, lon, h_tx, haat):
    """Ground at the site and Hata's effective antenna height (licensed HAAT, else above the ground 3-15 km out)."""
    terrain.ensure(terrain.tiles_for(lat, lon, 16, 11))
    g0 = terrain.elevation(lat, lon, 11, fetch=False)
    hb = h_tx
    if g0 is not None:
        ring = [terrain.elevation(*dest(lat, lon, b, d), 11, fetch=False) for b in range(0, 360, 20) for d in range(3, 16, 2)]
        ring = [e for e in ring if e is not None]
        if ring:
            hb = h_tx + g0 - sum(ring) / len(ring)
    return g0, (haat if haat is not None else hb)


def area(grid, txs, model="suburban", use_terrain=True, h_rx=1.5, with_terrain=25, floor=-120.0):
    """The strongest predicted level in each grid cell from many transmitters: the `with_terrain` strongest get the
    full terrain model, the rest Hata (or free space) over a smooth earth. txs: dicts with lat, lon, eirp, f_mhz,
    h_tx, haat, az, bw. Returns how many were modelled with terrain."""
    kx = 111.0
    cells = [(grid.n - (r + 0.5) * grid.dy, grid.w + (c + 0.5) * grid.dx) for r in range(grid.rows) for c in range(grid.cols)]
    best = [-1e18] * len(cells)
    corner = max(geo.haversine_km(grid.s, grid.w, grid.n, grid.e), 1.0)
    n_ter = 0
    for i, t in enumerate(txs):
        f = t["f_mhz"]
        m = model if model in MODELS and (model == "free" or 30 <= f <= 3800) else "free"
        g0, hb = (site_height(t["lat"], t["lon"], t["h_tx"], t.get("haat")) if use_terrain and i < with_terrain
                  else (None, t.get("haat") if t.get("haat") is not None else t["h_tx"]))
        loss = (lambda d, f=f: fspl_db(d, f)) if m == "free" else (lambda d, f=f, hb=hb, m=m: hata_db(d, f, hb, h_rx, m))
        R = min(corner + geo.haversine_km(t["lat"], t["lon"], (grid.s + grid.n) / 2, (grid.w + grid.e) / 2), 60 * geo.MI_KM)
        steps = 160
        if g0 is not None:
            z = terrain.zoom_for(R)
            terrain.ensure(terrain.tiles_for(t["lat"], t["lon"], R, z))
            levels, _ = radial_table(t["lat"], t["lon"], R, z, True, g0, t["h_tx"], h_rx, 299.792458 / f, t["eirp"], loss,
                                     t.get("az"), t.get("bw"), floor, radials=180, steps=steps)
            n_ter += 1
        else:
            levels = None
        step = R / steps
        cos0 = math.cos(math.radians(t["lat"]))
        for k, (la, lo) in enumerate(cells):
            dy, dx = (la - t["lat"]) * kx, (lo - t["lon"]) * kx * cos0
            d = math.hypot(dx, dy)
            if levels is not None and d <= R:
                v = levels[int(round(math.degrees(math.atan2(dx, dy)) / 2)) % 180][min(steps, max(1, int(round(d / step)))) - 1]
            else:
                v = t["eirp"] - loss(max(d, 0.05)) + pattern_db(math.degrees(math.atan2(dx, dy)) % 360, t.get("az"), t.get("bw"))
            if v > best[k]:
                best[k] = v
    for k, v in enumerate(best):
        grid.values[k // grid.cols][k % grid.cols] = v if v >= floor else None
    return n_ter


def compute(lat, lon, f_mhz, eirp, h_tx=30.0, haat=None, az=None, bw=None, model="suburban", use_terrain=True,
            h_rx=1.5, threshold=-95.0, radius_mi=None, size=200, pin=None, max_radius_mi=60.0, covered_only=False):
    """Returns (result dict, grid, rgba). pin: (lat, lon) for a path check to it."""
    notes = []
    if not f_mhz or f_mhz <= 0:
        raise ValueError("Coverage needs the transmitter's frequency.")
    if f_mhz < 30:
        raise ValueError(f"{f_mhz:g} MHz travels by ground wave and skywave (AM broadcast, HF); RF Recon's coverage models start at 30 MHz.")
    model = model if model in MODELS else "suburban"
    if model != "free" and not 30 <= f_mhz <= 3800:
        model = "free"
        notes.append(f"{f_mhz:g} MHz is far outside Hata's range, so free space is used (best case).")
    elif model != "free" and not 150 <= f_mhz <= 2000:
        notes.append(f"{f_mhz:g} MHz is outside Hata's tested 150-2000 MHz: treat the levels as rough.")
    lam = 299.792458 / f_mhz

    # terrain near the site: its ground height, and the average ground 3-15 km out (for Hata's effective height)
    g0, hb, have_terrain = None, h_tx, False
    if use_terrain:
        terrain.ensure(terrain.tiles_for(lat, lon, 16, 11))
        g0 = terrain.elevation(lat, lon, 11, fetch=False)
        if g0 is None:
            notes.append("No terrain here (offline and not downloaded yet), so hills aren't counted.")
        else:
            have_terrain = True
            ring = [terrain.elevation(*dest(lat, lon, b, d), 11, fetch=False) for b in range(0, 360, 10) for d in range(3, 16)]
            ring = [e for e in ring if e is not None]
            if ring:
                hb = h_tx + g0 - sum(ring) / len(ring)
    if haat is not None:
        hb = haat
    hb_src = "licensed HAAT" if haat is not None else "height above the average ground 3-15 km out" if have_terrain else "height above ground"
    if model != "free" and hb < 30:
        notes.append(f"Effective antenna height {hb:.0f} m is below Hata's 30 m: levels near the site are rough.")

    def loss(d):
        return fspl_db(d, f_mhz) if model == "free" else hata_db(d, f_mhz, hb, h_rx, model)

    if not radius_mi:  # far enough to see the edge on the main beam, flat ground
        d = 0.2
        while d < max_radius_mi * geo.MI_KM and eirp - loss(d) >= threshold - 10:
            d *= 1.05
        radius_mi = max(1.0, min(max_radius_mi, d / geo.MI_KM * 1.1))
    R = radius_mi * geo.MI_KM
    z = terrain.zoom_for(R)
    if have_terrain:
        st = terrain.ensure(terrain.tiles_for(lat, lon, R, z))
        if st["failed"]:
            notes.append(f"Terrain is missing for {st['failed']} of {st['tiles']} areas (offline?): hills there aren't counted.")
        g0 = terrain.elevation(lat, lon, z, fetch=False) or g0

    levels, edge = radial_table(lat, lon, R, z, have_terrain, g0, h_tx, h_rx, lam, eirp, loss, az, bw, threshold)
    step = R / STEPS

    floor = threshold if covered_only else threshold - 25
    grid = geo.make_grid(lat, lon, radius_mi, size)
    kx = 111.0 * math.cos(math.radians(lat))
    for r in range(grid.rows):
        dy = (grid.n - (r + 0.5) * grid.dy - lat) * 111.0
        out = grid.values[r]
        for c in range(grid.cols):
            dx = (grid.w + (c + 0.5) * grid.dx - lon) * kx
            d = math.hypot(dx, dy)
            if d > R:
                continue
            v = levels[int(round(math.degrees(math.atan2(dx, dy)))) % 360][min(STEPS, max(1, int(round(d / step)))) - 1]
            out[c] = v if v >= floor else None
    rgba, vmin, vmax = geo.colorize(grid, threshold - 25, threshold + 45, 190)

    mi = sorted(e / geo.MI_KM for e in edge)
    res = {"bounds": [[grid.s, grid.w], [grid.n, grid.e]], "vmin": vmin, "vmax": vmax, "unit": "dBm",
           "model": MODELS[model], "terrain": have_terrain, "radius_mi": round(radius_mi, 2), "threshold": threshold,
           "eirp_dbm": round(eirp, 1), "hb_m": round(hb, 1), "hb_src": hb_src, "h_tx": h_tx, "h_rx": h_rx,
           "ground_m": g0, "notes": notes,
           "contour": [list(dest(lat, lon, b, edge[b])) for b in range(0, 360, 2)],
           "reach_mi": {"max": round(mi[-1], 2), "median": round(mi[len(mi) // 2], 2), "min": round(mi[0], 2),
                        "beyond": sum(1 for e in edge if e >= R) * 100 // RADIALS},
           "pattern": [round(pattern_db(b, az, bw), 1) for b in range(0, 360, 5)] if az is not None and bw and bw < 360 else None,
           "az": az, "bw": bw}
    res["desc"] = (f"{MODELS[model]}{' + terrain' if have_terrain else ' + smooth earth'}: estimated level from this transmitter "
                   f"({eirp:.0f} dBm EIRP, {h_tx:g} m up). Edge drawn at {threshold:g} dBm, the farthest it reaches each way.")
    if pin:
        plat, plon = pin
        d = geo.haversine_km(lat, lon, plat, plon)
        brg = geo.bearing_deg(lat, lon, plat, plon)
        lvl = eirp - loss(max(d, 0.01)) + pattern_db(brg, az, bw)
        p = {"dist_mi": round(d / geo.MI_KM, 2), "bearing": round(brg), "compass": geo.compass(brg)}
        if use_terrain and d > 0.05:
            try:
                prof = terrain.profile(lat, lon, h_tx, plat, plon, h_rx, f_mhz, z=12 if d <= 15 else 11, skip_end_m=1000 if d > 2 else 0)
                lvl -= prof["loss_db"]
                p.update(path=prof["status"], terrain_loss_db=prof["loss_db"], clearance_f1=prof["clearance_f1"],
                         worst_at_mi=round((prof["worst_at_km"] or 0) / geo.MI_KM, 2), worst_above_los_m=prof["worst_above_los_m"],
                         profile=prof["points"], ground1_m=prof["ground1_m"], ground2_m=prof["ground2_m"])
            except LookupError as e:
                p["path"] = str(e)
        p["level_dbm"] = round(lvl, 1)
        p["margin_db"] = round(lvl - threshold, 1)
        res["pin"] = p
    return res, grid, rgba


def kml(res, grid, name, lat, lon):
    """The coverage as a KMZ document: the heatmap, its edge and the transmitter."""
    x = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    ring = " ".join(f"{lo:.6f},{la:.6f},0" for la, lo in res["contour"] + res["contour"][:1])
    return (geo.KML_HEAD + f"<name>{x(name)}</name>" + geo.ground_overlay(name, "coverage.png", grid, res["desc"])
            + f'<Placemark><name>{x(name)}</name><Point><coordinates>{lon},{lat},0</coordinates></Point></Placemark>'
            + f'<Placemark><name>Edge at {res["threshold"]:g} dBm</name><Style><LineStyle><color>ff2a7bf0</color><width>3</width></LineStyle></Style>'
            + f"<LineString><tessellate>1</tessellate><coordinates>{ring}</coordinates></LineString></Placemark></Document></kml>")
