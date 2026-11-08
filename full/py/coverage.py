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


def _loss_consts(model, f_mhz, hb_m, hm_m):
    """hata_db (or fspl_db for "free") as loss(d) = max(c0 + c1 log10 d, 20 log10 d + c2) for d >= 0.05 km: the same model with its
    constants worked out once per transmitter. "free" has no Hata term (c0 = -inf)."""
    c2 = 20 * math.log10(f_mhz) + 32.44
    if model == "free":
        return -math.inf, 0.0, c2
    lf, hb = math.log10(f_mhz), max(10.0, min(hb_m, 300.0))
    a = (1.1 * lf - 0.7) * hm_m - (1.56 * lf - 0.8)
    if f_mhz <= 1500:
        c0 = 69.55 + 26.16 * lf - 13.82 * math.log10(hb) - a
    else:
        c0 = 46.3 + 33.9 * lf - 13.82 * math.log10(hb) - a + (3 if model == "urban" else 0)
    if model == "suburban" and f_mhz <= 1500:
        c0 -= 2 * math.log10(f_mhz / 28) ** 2 + 5.4
    elif model == "open":
        c0 -= 4.78 * lf ** 2 - 18.33 * lf + 40.94
    return c0, 44.9 - 6.55 * math.log10(hb), c2


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


def radial_table(lat, lon, R, z, have_terrain, g0, h_tx, h_rx, lam, eirp, loss, az, bw, threshold, radials=RADIALS, steps=STEPS,
                 limits=None):
    """The level along each bearing out to R km: the area model, the antenna pattern, and the loss over the highest
    ridge as seen from the site (terrain, or a smooth earth so the radio horizon still counts). Also the farthest
    distance each bearing still reaches `threshold`. limits: per bearing, the last step anyone will read (area() passes the
    farthest grid cell on it); a point depends only on the ground before it on its bearing, so the values are the same, and
    `edge` then covers only those steps."""
    step = R / steps
    base = [eirp - loss(step * i) for i in range(1, steps + 1)]  # the model depends on distance only
    drop = [(step * i * 1000) ** 2 / (2 * terrain.K * terrain.EARTH_M) for i in range(1, steps + 1)]  # the earth's curve
    gap = max(1, math.ceil(1.0 / step))  # ground within 1 km of the receiver is its own clutter, which the area model covers
    g_site = g0 if have_terrain else 0.0
    H_tx = g_site + h_tx
    levels, edge = [], []
    if have_terrain:  # dest() and terrain.elevation() inline, their sines and cosines once per step and per bearing: the same
        # arithmetic in the same order, so the same values (11/7: those two calls were 11 of the 15 s a terrain heatmap spent here)
        p1, l1 = math.radians(lat), math.radians(lon)
        sp1, cp1 = math.sin(p1), math.cos(p1)
        sds, cds = [], []
        for i in range(1, steps + 1):
            da = step * i / geo.EARTH_KM
            sds.append(math.sin(da))
            cds.append(math.cos(da))
        n_t, mem, get_tile = 2 ** z, terrain._mem, terrain.tile
        asin, atan2, sin, degrees, asinh, tan, radians, pi = (math.asin, math.atan2, math.sin, math.degrees, math.asinh, math.tan,
                                                               math.radians, math.pi)
    sqrt, log10 = math.sqrt, math.log10
    for j in range(radials):
        b = j * 360.0 / radials
        pat = pattern_db(b, az, bw)
        row, ground, edge_km, e_prev = [], [], 0.0, g_site
        put, put_g = row.append, ground.append
        best, obs_d, obs_h = -1e18, None, None
        if have_terrain:
            br = math.radians(b)
            sb, cb = math.sin(br), math.cos(br)
        for i in range(1, (steps if limits is None else limits[j]) + 1):
            d = step * i
            if have_terrain:
                sd, cd = sds[i - 1], cds[i - 1]
                p2 = asin(sp1 * cd + cp1 * sd * cb)
                la2 = degrees(p2)
                la2 = 85.0 if la2 > 85.0 else -85.0 if la2 < -85.0 else la2
                lo2 = degrees(l1 + atan2(sb * sd * cp1, cd - sp1 * sin(p2)))
                x, y = (lo2 + 180.0) / 360.0 * n_t, (1 - asinh(tan(radians(la2))) / pi) / 2 * n_t
                tx, ty = int(x), int(y)
                t = mem.get((z, tx, ty)) or get_tile(z, tx, ty, False)
                if t is not None:
                    py, px = int((y - ty) * 256), int((x - tx) * 256)
                    e_prev = t[(255 if py > 255 else py) * 256 + (255 if px > 255 else px)]
            g = e_prev - drop[i - 1]  # ground below the site's horizon plane
            put_g(g)
            k = i - 1 - gap  # the ridge that rises highest as seen from the site, at least 1 km short of here
            if k >= 0:
                s = (ground[k] - H_tx) / (step * (k + 1))
                if s > best:
                    best, obs_d, obs_h = s, step * (k + 1), ground[k]
            lvl = base[i - 1] + pat
            if obs_d is not None:  # terrain.knife_edge_db inline
                v = (obs_h - (H_tx + (g + h_rx - H_tx) * obs_d / d)) * sqrt(2 * d / (lam * obs_d * (d - obs_d) * 1000))
                if v > -0.78:
                    lvl -= 6.9 + 20 * log10(sqrt((v - 0.1) ** 2 + 1) + v - 0.1)
            put(lvl)
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
    row_lat = [grid.n - (r + 0.5) * grid.dy for r in range(grid.rows)]
    col_lon = [grid.w + (c + 0.5) * grid.dx for c in range(grid.cols)]
    best = [-1e18] * (grid.rows * grid.cols)
    hypot, degrees, atan2, log10 = math.hypot, math.degrees, math.atan2, math.log10
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
        step = R / steps
        cos0 = math.cos(math.radians(t["lat"]))
        dys = [(la - t["lat"]) * kx for la in row_lat]
        dxs = [(lo - t["lon"]) * kx * cos0 for lo in col_lon]
        if g0 is not None:
            # each cell's bearing and step first, so the table goes only as far along each bearing as its farthest cell (R reaches the
            # grid's far corner from anywhere, so most of every bearing was never read: 11/7, the same values)
            where, lim = [], [0] * 180
            for dy in dys:
                for dx in dxs:
                    d = hypot(dx, dy)
                    if d <= R:
                        j, s_i = int(round(degrees(atan2(dx, dy)) / 2)) % 180, min(steps, max(1, int(round(d / step))))
                        where.append((j, s_i - 1))
                        if s_i > lim[j]:
                            lim[j] = s_i
                    else:
                        where.append(None)
            z = terrain.zoom_for(R)
            terrain.ensure(terrain.tiles_for(t["lat"], t["lon"], R, z))
            levels, _ = radial_table(t["lat"], t["lon"], R, z, True, g0, t["h_tx"], h_rx, 299.792458 / f, t["eirp"], loss,
                                     t.get("az"), t.get("bw"), floor, radials=180, steps=steps, limits=lim)
            n_ter += 1
        else:
            levels = where = None
        # per cell: the model as loss(d) = max(c0 + c1 log d, 20 log d + c2), one log a cell (hata_db and fspl_db with their
        # constants worked out once), no angle for an omni, each row's and column's offset once (11/7: 9 of a terrain heatmap's 27 s)
        c0, c1, c2 = _loss_consts(m, f, hb, h_rx)
        eirp, az, bw = t["eirp"], t.get("az"), t.get("bw")
        omni = az is None or not bw or bw >= 360
        k = 0
        for dy in dys:
            for dx in dxs:
                if where is not None and where[k] is not None:
                    j, s_i = where[k]
                    v = levels[j][s_i]
                else:
                    d = hypot(dx, dy)
                    ld = log10(d if d > 0.05 else 0.05)
                    lm, lf = c0 + c1 * ld, 20 * ld + c2
                    v = eirp - (lm if lm > lf else lf)
                    if not omni:
                        v += pattern_db(degrees(atan2(dx, dy)) % 360, az, bw)
                if v > best[k]:
                    best[k] = v
                k += 1
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
        raise ValueError(f"{f_mhz:g} MHz travels by ground wave and skywave (AM broadcast, HF); DAStastic's coverage models start at 30 MHz.")
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


# ---------------------------------------------------------------- the DAS pre-survey's realistic levels (R1 #1, 11/4)
# das.presurvey gives free-space levels (best case): on real data they never fall below -95 dBm inside, so "an ERCES is
# likely needed" could not fire (R1 measured 0 of 200 systems in Arlington VA on free space, 170 of 200 on Hata urban).
# This adds, beside them, the same licensed power through the area model the coverage map uses: Okumura-Hata (COST-231
# above 1500 MHz, never stronger than free space) with the licence's antenna pattern, and the knife-edge loss over the
# highest ridge where terrain is already cached on this PC (never fetched here). It is a street-level median (1.5 m
# receiver), so it is pessimistic for upper floors: an estimate to bracket the answer, not a measurement.
REAL_ENVS = ("urban", "suburban", "open")


def _real_rows(con, calls):
    rows = {}
    for i in range(0, len(calls), 900):
        part = calls[i:i + 900]
        for r in con.execute(
                "SELECT call_sign, lat, lon, freq_mhz, erp_w, power_out_w, haat_m, height_tip_m, azimuth, beamwidth, ground_elev_m "
                f"FROM tx WHERE status='A' AND freq_mhz IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL AND call_sign IN ({','.join('?' * len(part))}) "
                "AND (station_class LIKE 'FB%' OR station_class LIKE 'FX%')", part):
            rows.setdefault((r[0], f"{r[1]:.5f},{r[2]:.5f}"), []).append(r)
    return rows


def presurvey_realistic(con, res, lat, lon, env="suburban", h_rx=1.5, use_terrain=True):
    """Adds `real` to each system of a das.presurvey result: the strongest of its listed sites on Hata (+ terrain where
    cached), {site (index into sites), out_dbm, in_dbm, margin_db, freq, hata_db, terrain_db, terrain, hb_m, hb_src,
    note}, and `real_model` describing the model. Free-space numbers are left as they were."""
    env = env if env in REAL_ENVS else "suburban"
    loss_db, thr = res.get("loss_db") or 0.0, res.get("threshold_dbm") or -95.0
    systems = res.get("systems") or []
    rows = _real_rows(con, [s["call_sign"] for s in systems])
    counts = {"systems": 0, "terrain": 0, "below": 0}
    for s in systems:
        best = None
        for i, st in enumerate(s.get("sites") or []):
            key = (s["call_sign"], f"{st['lat']:.5f},{st['lon']:.5f}")
            d = geo.haversine_km(st["lat"], st["lon"], lat, lon)
            brg = geo.bearing_deg(st["lat"], st["lon"], lat, lon)
            for r in rows.get(key, []):
                f, erp = r[3], r[4] or r[5]
                if not erp or not 25 <= f <= 1000:
                    continue
                eirp = 10 * math.log10(erp * 1000) + 2.15
                hb = r[6] if r[6] is not None else (r[7] if r[7] is not None else 30.0)
                hb_src = "licensed HAAT" if r[6] is not None else "antenna height above ground" if r[7] is not None else "30 m assumed"
                pl = fspl_db(max(d, 0.05), f) if f < 30 else hata_db(max(d, 0.05), f, hb, h_rx, env)
                lvl = eirp - pl + pattern_db(brg, r[8], r[9])
                if best is None or lvl > best["lvl"]:
                    best = {"lvl": lvl, "site": i, "freq": round(f, 5), "hata_db": round(pl, 1), "hb_m": round(max(10.0, min(hb, 300.0)), 1),
                            "hb_src": hb_src, "d_km": d, "h_tip": r[7] if r[7] is not None else 30.0, "site_ground_m": r[10],
                            "pattern_db": round(pattern_db(brg, r[8], r[9]), 1)}
        if best is None:
            s["real"] = None
            continue
        counts["systems"] += 1
        st = s["sites"][best["site"]]
        terr, tstate = 0.0, "not cached"
        if use_terrain and best["d_km"] > 0.05:
            try:
                prof = terrain.profile(st["lat"], st["lon"], best["h_tip"], lat, lon, h_rx, best["freq"],
                                       z=12 if best["d_km"] <= 15 else 11, fetch=False, skip_end_m=1000 if best["d_km"] > 2 else 0)
                terr, tstate = prof["loss_db"], prof["status"]
                counts["terrain"] += 1
            except LookupError:
                pass
        out = best["lvl"] - terr
        notes = []
        if not 150 <= best["freq"] <= 1500:
            notes.append(f"{best['freq']:g} MHz is outside Hata's tested 150-1500 MHz: rough")
        if best["d_km"] < 1:
            notes.append("under 1 km from the site: Hata is rough this close")
        s["real"] = {"site": best["site"], "out_dbm": round(out, 1), "in_dbm": round(out - loss_db, 1),
                     "margin_db": round(out - loss_db - thr, 1), "freq": best["freq"], "hata_db": best["hata_db"],
                     "pattern_db": best["pattern_db"], "terrain_db": round(terr, 1), "terrain": tstate, "hb_m": best["hb_m"],
                     "hb_src": best["hb_src"], "site_ground_m": best["site_ground_m"], "note": "; ".join(notes)}
        if s["real"]["margin_db"] < 0:
            counts["below"] += 1
    ground = terrain.elevation(lat, lon, 12, fetch=False) if use_terrain else None
    res["real_model"] = {"name": f"Okumura-Hata, {env}", "env": env, "h_rx_m": h_rx, "ground_m": ground, **counts,
                         "desc": (f"Okumura-Hata {env} (COST-231 above 1500 MHz, never stronger than free space) from the "
                                  f"licensed ERP, with the licence's antenna pattern where on file, and the loss over the highest "
                                  f"ridge where terrain is cached on this PC ({counts['terrain']} of {counts['systems']} paths). "
                                  f"A {h_rx:g} m street-level median: pessimistic for upper floors. An estimate, not a measurement.")}
    return res


def kml(res, grid, name, lat, lon):
    """The coverage as a KMZ document: the heatmap, its edge and the transmitter."""
    x = lambda s: str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    ring = " ".join(f"{lo:.6f},{la:.6f},0" for la, lo in res["contour"] + res["contour"][:1])
    return (geo.KML_HEAD + f"<name>{x(name)}</name>" + geo.ground_overlay(name, "coverage.png", grid, res["desc"])
            + f'<Placemark><name>{x(name)}</name><Point><coordinates>{lon},{lat},0</coordinates></Point></Placemark>'
            + f'<Placemark><name>Edge at {res["threshold"]:g} dBm</name><Style><LineStyle><color>ff2a7bf0</color><width>3</width></LineStyle></Style>'
            + f"<LineString><tessellate>1</tessellate><coordinates>{ring}</coordinates></LineString></Placemark></Document></kml>")
