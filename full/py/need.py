"""
RF need: how likely a DAS prospect building is to fail emergency radio (and carrier) coverage inside, so the call list
starts with the buildings that probably need a system (Cody approved 11/4; app review R1 #4, data scout combination A).

An estimate from public data, never a measurement:

  public safety  the realistic outdoor downlink at the building from the agency systems licensed within 15 mi (FCC
                 ULS: licensed ERP, HAAT and antenna pattern through Okumura-Hata, the model coverage.py's pre-survey
                 uses, plus the knife-edge loss over the highest ridge on the donor path where terrain is cached on
                 this computer), minus a building entry loss chosen from what's known about the building (NSI year
                 built, stories, floor area and basement when looked up; Overture height; the prospect's type),
                 compared with the AHJ threshold (-95 dBm by default).
  carriers       the FCC Broadband Map's modelled signal per carrier at the building (bdc.py's hexagons) minus the
                 same building loss, against a cellular target (-95 dBm RSRP by default). Where bdc.db isn't on this
                 computer the carrier part says so and the public safety part stands alone.

Which agency system decides: the strongest agency trunked or 700/800 MHz system at the building (the county or city
P25 system in the DC/MD/VA test data: Arlington KNIQ704, DC WPXT459, Fairfax KNIH412), preferring one licensed to an
agency named like the building's town; with none in range, the strongest agency system. Picking the strongest is
the cautious side: "likely short" means even the best-placed agency system is likely short inside.

Only federal and first-party data (ULS, terrain tiles, NSI, BDC): licence-clean for the sold build, and nothing here
goes into a field pack. Results are cached in memory: the area's agency sites per search (the slow part, one SQL
scan), each point's levels, and each point's carrier signals; an NSI record looked up for a prospect is kept in
need.db beside the other data. Standard library only.
"""
import json
import math
import os
import re
import sqlite3
import threading
import time
from collections import OrderedDict

import coverage
import geo
import terrain
import uls_import

VERSION = 1
RADIUS_MI = 15.0           # agency sites counted around each building (the pre-survey's default radius)
THRESHOLD_DBM = -95.0      # IFC 510 / NFPA 1225 default downlink at each test location (das.js DAS.threshold)
CELL_TARGET_DBM = -95.0    # the carrier target this estimate uses (LTE RSRP inside; carriers' own specs vary)
CLOSE_DB = 6.0             # within this of the line: too close to call (Hata's location spread is about 8 dB)
H_RX = 1.5                 # Hata's street-level receiver (pessimistic for upper floors)
ENVS = coverage.REAL_ENVS
AGENCY_CATS = {"Public Safety (Gov)", "Public Safety (Other)", "Law Enforcement", "Fire / EMS", "Emergency Mgmt / 911"}
TRUNKED = {"YW", "SY", "YE", "YF", "YP"}  # das.TRUNKED (not imported: das pulls in the whole job module)
PS_BANDS = ((769.0, 775.0, "700 MHz"), (851.0, 869.0, "800 MHz"))
SOURCES = ("FCC ULS (licensed sites, power, height, antenna pattern)", "AWS Terrain Tiles (USGS 3DEP, SRTM), where cached",
           "USACE National Structure Inventory (when looked up)", "Overture building height (high-rises)",
           "FCC Broadband Map carrier coverage (where loaded)")

# --- building entry loss ------------------------------------------------------------------------------------------
# ITU-R P.2109-2 medians at 770-850 MHz (das.js DAS.loss): traditional build 14 dB, thermally efficient (low-E glass,
# foil insulation) 31 dB. P.2109 counts the outer wall only; NIST TN 1552 measured 25-98 dB medians deep inside large
# buildings at 750 MHz, so a large floor plate adds 10 dB (14 + 10 sits at the low end of those medians). Below grade
# takes das.js's own presets (50 dB below grade, 90 dB subterranean).
TRADITIONAL_DB, EFFICIENT_DB = 14.0, 31.0
EFFICIENT_FROM = 2000      # low-E glass became the norm in US commercial building around 2000 (energy codes): a judgement
DEEP_DB, CORE_DB = 10.0, 5.0
BELOW_GRADE_DB, SUBTERRANEAN_DB = 50.0, 90.0
BIG_PLATE_SQFT = 40000     # a floor this large has interior far from any outside wall
TALL_FLOORS = 7            # the high-rise line prospects.highrises uses (75 ft or 7 floors)
LARGE_KINDS = {"mall": "mall", "stadium": "stadium or arena", "venue": "convention centre or venue", "casino": "casino",
               "airport": "airport", "warehouse": "warehouse", "hospital": "hospital"}
BELOW_KINDS = {"parking": "parking garage, taken as below grade", "transit": "transit station, taken as below grade"}


def _num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _height(row):
    """(height m, floors) from an Overture row's label ("312 ft · 25 floors")."""
    lab = row.get("size_label") or ""
    ft = re.search(r"([\d,]+) ft", lab)
    fl = re.search(r"(\d+) floors", lab)
    return (round(float(ft.group(1).replace(",", "")) / 3.281, 1) if ft else None), (int(fl.group(1)) if fl else None)


def entry_loss(row, nsi=None):
    """The building loss this estimate uses, dB, with each part and why. row: a prospect (kind, size_label); nsi: the
    NSI record (nsi.pick) when one was looked up."""
    kind = row.get("kind") or ""
    nsi = nsi or {}
    h_m, floors = _height(row)
    floors = nsi.get("stories") or floors  # the NSI's stories are modelled, but they're the building's own record
    year = nsi.get("year_built") or (time.gmtime().tm_year if kind == "under_construction" else None)  # a permitted new building
    parts = []
    if kind == "tunnel":
        return {"db": SUBTERRANEAN_DB, "parts": [[SUBTERRANEAN_DB, "tunnel: 90 dB, a judgement (NIST TN 1552 measured buildings above ground, not tunnels): measure it"]],
                "basis": "type", "year": None, "floors": None}
    if year and year >= EFFICIENT_FROM:
        parts.append([EFFICIENT_DB, f"built {year}: thermally efficient (low-E glass), ITU-R P.2109 median"])
    elif year:
        parts.append([TRADITIONAL_DB, f"built {year}: traditional build, ITU-R P.2109 median"])
    else:
        parts.append([TRADITIONAL_DB, f"traditional build, ITU-R P.2109 median (year unknown: {EFFICIENT_DB - TRADITIONAL_DB:.0f} dB more if it has modern low-E glass)"])
    plate = None
    if nsi.get("sqft"):
        plate = nsi["sqft"] / max(1, nsi.get("stories") or 1)
    if nsi.get("footprint_sqft"):
        plate = max(plate or 0, nsi["footprint_sqft"])
    if plate and plate >= BIG_PLATE_SQFT:
        parts.append([DEEP_DB, f"deep interior: about {plate:,.0f} sq ft a floor (NSI)"])
    elif plate is None and kind in LARGE_KINDS:
        parts.append([DEEP_DB, f"deep interior: a {LARGE_KINDS[kind]} has a large floor plate"])
    if (floors and floors >= TALL_FLOORS) or (h_m and h_m >= 23):
        what = f"{int(floors)} floors" if floors else f"{round(h_m * 3.281):,} ft"
        parts.append([CORE_DB, f"{what}: concrete stair and lift cores (critical areas: 99% must pass)"])
    db = sum(p[0] for p in parts)
    if nsi.get("basement"):
        if db < BELOW_GRADE_DB:
            parts.append([BELOW_GRADE_DB - db, "basement (NSI): below-grade floors, 50 dB in all"])
            db = BELOW_GRADE_DB
    elif kind in BELOW_KINDS and db < BELOW_GRADE_DB:
        parts.append([BELOW_GRADE_DB - db, f"{BELOW_KINDS[kind]}: 50 dB in all"])
        db = BELOW_GRADE_DB
    return {"db": round(db, 1), "parts": parts, "basis": "NSI" if nsi else "type", "year": year, "floors": floors}


def verdict(margin_db, close=CLOSE_DB):
    """short / close / ok from the margin inside (level minus target), or unknown."""
    if margin_db is None:
        return "unknown"
    return "short" if margin_db < -close else "ok" if margin_db > close else "close"


# --- the agency sites around an area (cached) ---------------------------------------------------------------------

_lock = threading.Lock()
_areas = OrderedDict()     # (stamp, box) -> {"box", "sites", "systems"}
_points = OrderedDict()    # (stamp, env, lat, lon, town) -> point levels
_cells = OrderedDict()     # (bdc stamp, lat, lon) -> carrier signals
_inflight = {}             # (stamp, box) -> Event: one load of an area at a time; a second asker waits for it
MAX_AREAS, MAX_POINTS = 12, 20000  # about 1 KB a point: some 20 MB at most
stats = {"area_loads": 0, "point_hits": 0, "point_misses": 0, "cell_hits": 0, "cell_misses": 0}


def _lru_put(d, k, v, cap):
    d[k] = v
    d.move_to_end(k)
    while len(d) > cap:
        d.popitem(last=False)


def clear():
    with _lock:
        _areas.clear()
        _points.clear()
        _cells.clear()
        for k in stats:
            stats[k] = 0


def uls_stamp(con):
    """Changes when the FCC data is rebuilt (uls_import writes meta built_at and tx_rows)."""
    try:
        got = dict(con.execute("SELECT k, v FROM meta WHERE k IN ('built_at', 'tx_rows')").fetchall())
        if got:
            return f"{got.get('built_at')}|{got.get('tx_rows')}"
    except sqlite3.Error:
        pass
    try:
        return f"rowid:{con.execute('SELECT MAX(rowid) FROM tx').fetchone()[0]}"
    except sqlite3.Error:
        return "none"


def _band(f):
    for lo, hi, label in PS_BANDS:
        if lo <= f <= hi:
            return label
    return uls_import.band_for(f) or "Other"


def _box(lat, lon, radius_mi):
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    return (round(s, 4), round(n, 4), round(w, 4), round(e, 4))


def system_tier(licensee, category, trunked, bands):
    """How likely a system is to be the one a building has to carry. 1: a government's own trunked or 700/800 MHz system;
    2: any agency's (regional interop, authorities); 3: any agency system; 4: anything licensed for public safety."""
    big = category in AGENCY_CATS and (trunked or bool(set(bands) & {"700 MHz", "800 MHz"}))
    return (1 if big and GOV.search(licensee or "") and not REGIONAL.search(licensee or "") else 2 if big
            else 3 if category in AGENCY_CATS else 4)


def load_area(con, s, n, w, e):
    """The agency downlink sites (base and fixed stations, 25-1000 MHz) in a box: one entry per call sign, site,
    band and antenna, at its strongest licensed power. The same filter as das.presurvey."""
    ps = sorted(uls_import.PUBLIC_SAFETY_SERVICES)
    cats = sorted(AGENCY_CATS)
    rows = con.execute(
        "SELECT call_sign, licensee, service, category, lat, lon, freq_mhz, erp_w, power_out_w, haat_m, height_tip_m, "
        "azimuth, beamwidth FROM tx WHERE status='A' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? "
        "AND +freq_mhz BETWEEN 25 AND 1000 "  # + keeps SQLite off tx_freq: walking it took 53-161 s where the box takes under 4 s
        f"AND (service IN ({','.join('?' * len(ps))}) OR category IN ({','.join('?' * len(cats))})) "
        "AND (station_class LIKE 'FB%' OR station_class LIKE 'FX%')", [s, n, w, e] + ps + cats).fetchall()
    systems, sites = {}, {}
    for r in rows:
        call, lic, svc, cat, la, lo, f, erp, pw, haat, tip, az, bw = tuple(r)
        p = erp or pw
        if not p or p <= 0 or la is None or lo is None:
            continue
        band = _band(f)
        sy = systems.setdefault(call, {"call": call, "licensee": lic or "", "service": svc, "category": cat or "",
                                       "trunked": svc in TRUNKED, "bands": set()})
        sy["bands"].add(band)
        eirp = 10 * math.log10(p * 1000) + 2.15
        key = (call, round(la, 5), round(lo, 5), band, az, bw)
        cur = sites.get(key)
        if cur is None or eirp > cur["eirp"]:
            hb = haat if haat is not None else (tip if tip is not None else 30.0)
            sites[key] = {"call": call, "lat": la, "lon": lo, "f": f, "eirp": eirp, "hb": hb,
                          "hb_src": "licensed HAAT" if haat is not None else "antenna height" if tip is not None else "30 m assumed",
                          "tip": tip if tip is not None else 30.0, "az": az, "bw": bw, "band": band}
    for sy in systems.values():
        sy["tier"] = system_tier(sy["licensee"], sy["category"], sy["trunked"], sy["bands"])
        sy["bands"] = sorted(sy["bands"])
    buckets = {}
    for i, st in enumerate(sites.values()):
        buckets.setdefault((math.floor(st["lat"] / BUCKET), math.floor(st["lon"] / BUCKET)), []).append(st)
    return {"box": (s, n, w, e), "sites": list(sites.values()), "buckets": buckets, "systems": systems, "rows": len(rows), "consts": {}}


BUCKET = 0.05  # degrees: the sites are kept in squares this size, so a point only looks at those within reach
# a licensee that is a government (the county or city system an AHJ means); a regional council's interop licence is not
GOV = re.compile(r"\b(county|city|town|village|borough|township|parish|state|commonwealth|district of columbia|police|sheriff|fire|"
                 r"public safety|emergency)\b", re.I)
REGIONAL = re.compile(r"\b(council of governments|regional|authority|university|college|school|hospital|red cross|sanitary)\b", re.I)


def hata_consts(f, hb, hm, env):
    """coverage.hata_db split into its distance-free parts: loss(d) = max(a + b·log10 d, c + 20·log10 d), d in km
    (0.05 km and up). The same numbers, a few multiplications per point instead of a dozen logarithms."""
    lf, hb = math.log10(f), max(10.0, min(hb, 300.0))
    a_hm = (1.1 * lf - 0.7) * hm - (1.56 * lf - 0.8)
    b = 44.9 - 6.55 * math.log10(hb)
    if f <= 1500:
        a = 69.55 + 26.16 * lf - 13.82 * math.log10(hb) - a_hm
    else:
        a = 46.3 + 33.9 * lf - 13.82 * math.log10(hb) - a_hm + (3 if env == "urban" else 0)
    if env == "suburban" and f <= 1500:
        a -= 2 * math.log10(f / 28) ** 2 + 5.4
    elif env == "open":
        a -= 4.78 * lf ** 2 - 18.33 * lf + 40.94
    return a, b, 20 * lf + 32.44


def _holds(box, need):
    return box[0] <= need[0] and box[1] >= need[1] and box[2] <= need[2] and box[3] >= need[3]


def area_for(con, lat, lon, radius_mi, stamp=None):
    """The cached sites for a search area (its circle's box plus RADIUS_MI), loaded once. While one load runs (the
    start-up warm-up, or a first list), a second asker for an area inside it waits for that load instead of making
    its own: on a whole-US database a cold load is the slow part."""
    stamp = stamp or uls_stamp(con)
    need = _box(lat, lon, radius_mi + RADIUS_MI)
    while True:
        with _lock:
            for (st, box), a in reversed(_areas.items()):
                if st == stamp and _holds(box, need):
                    _areas.move_to_end((st, box))
                    return a
            ev = next((e for (st, box), e in _inflight.items() if st == stamp and _holds(box, need)), None)
            if ev is None:
                ev = _inflight[(stamp, need)] = threading.Event()
                break
        ev.wait(600)  # then look again: the load is cached, or it failed and this asker loads it
    try:
        a = load_area(con, *need)
        with _lock:
            stats["area_loads"] += 1
            _lru_put(_areas, (stamp, need), a, MAX_AREAS)
        return a
    finally:
        with _lock:
            _inflight.pop((stamp, need), None)
        ev.set()


def _flat(s):
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())


def _local(licensee, town):
    t = _flat(town).strip()
    return len(t) >= 4 and re.search(r"\b" + re.escape(t) + r"\b", _flat(licensee)) is not None


def point_levels(area, lat, lon, env="suburban", town="", use_terrain=True):
    """Each agency system's strongest realistic outdoor level at a point, and the system that decides."""
    env = env if env in ENVS else "suburban"
    lim = RADIUS_MI * geo.MI_KM
    kx = 111.0 * math.cos(math.radians(lat))
    dlat, dlon = lim / 111.0, lim / max(1.0, kx)
    consts = area["consts"]
    best = {}
    b0, b1 = math.floor((lat - dlat) / BUCKET), math.floor((lat + dlat) / BUCKET)
    c0, c1 = math.floor((lon - dlon) / BUCKET), math.floor((lon + dlon) / BUCKET)
    lim2 = lim * lim
    for bi in range(b0, b1 + 1):
        for ci in range(c0, c1 + 1):
            for st in area["buckets"].get((bi, ci), ()):
                dy, dx = (lat - st["lat"]) * 111.0, (lon - st["lon"]) * kx  # flat earth: within 15 mi it's metres out
                d2 = dx * dx + dy * dy
                if d2 > lim2:
                    continue
                k = consts.get((id(st), env))
                if k is None:
                    k = consts[(id(st), env)] = hata_consts(st["f"], st["hb"], H_RX, env)
                ld = 0.5 * math.log10(max(d2, 0.0025))
                lvl = st["eirp"] - max(k[0] + k[1] * ld, k[2] + 20 * ld)
                if st["az"] is not None and st["bw"] and st["bw"] < 360:
                    lvl += coverage.pattern_db(math.degrees(math.atan2(dx, dy)) % 360, st["az"], st["bw"])
                b = best.get(st["call"])
                if b is None or lvl > b[0]:
                    best[st["call"]] = (lvl, st, math.sqrt(d2))
    systems = area["systems"]
    if not best:
        return {"system": None, "agency_n": 0, "systems_n": 0, "env": env}
    tier = min(systems[c]["tier"] for c in best)
    pool = {c: v for c, v in best.items() if systems[c]["tier"] == tier}
    basis = {1: "trunked", 2: "regional", 3: "agency", 4: "any"}[tier]
    local = {c: v for c, v in pool.items() if _local(systems[c]["licensee"], town)}
    pick = max((local or pool).items(), key=lambda kv: kv[1][0])
    call, (lvl, st, d) = pick
    agency = {c: v for c, v in best.items() if systems[c]["tier"] <= 3}
    terr, tstate = 0.0, "not counted"
    if use_terrain and d > 0.05:
        try:
            prof = terrain.profile(st["lat"], st["lon"], st["tip"], lat, lon, H_RX, st["f"], z=12 if d <= 15 else 11,
                                   fetch=False, skip_end_m=1000 if d > 2 else 0)
            terr, tstate = prof["loss_db"], prof["status"]
        except LookupError:
            tstate = "not cached here"
    sy = systems[call]
    brg = geo.bearing_deg(lat, lon, st["lat"], st["lon"])
    notes = []
    if not 150 <= st["f"] <= 1500:
        notes.append(f"{st['f']:g} MHz is outside Hata's tested 150-1500 MHz")
    if d < 1:
        notes.append("under 1 km from the site: Hata is rough this close")
    return {"system": {"call": call, "licensee": sy["licensee"], "band": st["band"], "freq": round(st["f"], 4),
                       "basis": basis, "local": bool(local), "dist_mi": round(d / geo.MI_KM, 2),
                       "compass": geo.compass(brg), "hb_m": round(st["hb"], 1), "hb_src": st["hb_src"],
                       "hata_out_dbm": round(lvl, 1), "terrain_db": round(terr, 1), "terrain": tstate,
                       "out_dbm": round(lvl - terr, 1), "note": "; ".join(notes)},
            "agency_n": len(agency),
            "systems_n": len(best), "env": env}


def ps_at(con, area, lat, lon, env="suburban", town="", stamp=None, use_terrain=True):
    key = (stamp or "", env, round(lat, 4), round(lon, 4), _flat(town).strip(), use_terrain)
    with _lock:
        hit = _points.get(key)
        if hit is not None:
            stats["point_hits"] += 1
            _points.move_to_end(key)
            return hit
    got = point_levels(area, lat, lon, env, town, use_terrain)
    with _lock:
        stats["point_misses"] += 1
        _lru_put(_points, key, got, MAX_POINTS)
    return got


# --- carriers (FCC Broadband Map hexagons, bdc.py) -----------------------------------------------------------------

def bdc_open(data_dir):
    """(connection or None, why not). Read only; never builds the index or the tables."""
    import bdc
    if not os.path.exists(bdc.db_path(data_dir)):
        return None, "Carrier coverage not loaded here."
    if bdc.reloading(data_dir):
        return None, "Carrier coverage is reloading: back when the load finishes."
    try:
        con = sqlite3.connect(f"file:{bdc.db_path(data_dir)}?mode=ro", uri=True, timeout=10)
        names = {r[0]: r[1] for r in con.execute("SELECT provider, brand FROM bdc_provider")}
        states = {r[0] for r in con.execute("SELECT DISTINCT state FROM bdc_file")}
        stamp = con.execute("SELECT MAX(loaded_at) FROM bdc_file").fetchone()[0]
        as_of = con.execute("SELECT MAX(as_of) FROM bdc_file").fetchone()[0]
    except sqlite3.Error as e:
        return None, f"Carrier coverage can't be read here ({e})."
    return {"con": con, "names": names, "states": states, "stamp": stamp, "as_of": as_of}, None


def carriers_at(b, lat, lon):
    """Per carrier: its strongest modelled signal in the hexagon at this spot, 4G LTE first (5G-NR where it has no
    LTE), as [{brand, tech, signal_dbm, env}]."""
    key = (b["stamp"], round(lat, 4), round(lon, 4))
    with _lock:
        hit = _cells.get(key)
        if hit is not None:
            stats["cell_hits"] += 1
            return hit
    km = 0.2  # a hexagon is about 0.35 km across: its centre is within 0.2 km (bdc.at)
    dlat, dlon = km / 111.0, km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    best = {}
    for prov, tech, sig, env in b["con"].execute(
            "SELECT provider, tech, minsignal, env FROM bdc_hex WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
            (lat - dlat, lat + dlat, lon - dlon, lon + dlon)):
        if sig is None or tech not in (400, 500):
            continue
        k = (prov, tech)
        if k not in best or sig > best[k][0]:
            best[k] = (sig, env)
    out = []
    for prov in sorted({p for p, _ in best}):
        tech = 400 if (prov, 400) in best else 500
        sig, env = best[(prov, tech)]
        out.append({"brand": b["names"].get(prov) or str(prov), "tech": "4G LTE" if tech == 400 else "5G-NR",
                    "signal_dbm": sig, "env": "in a moving vehicle" if env == 1 else "outdoor"})
    with _lock:
        stats["cell_misses"] += 1
        _lru_put(_cells, key, out, MAX_POINTS)
    return out


# --- the score ------------------------------------------------------------------------------------------------------

def _f(x):
    return f"{x:.0f}".replace("-", "−")


def score(row, ps, loss, threshold=THRESHOLD_DBM, carriers=None, carrier_note=None, cell_target=CELL_TARGET_DBM):
    """One prospect's need from its point levels (point_levels), its building loss (entry_loss) and its carriers
    (carriers_at, or None with carrier_note). Pure: no data access."""
    L = loss["db"]
    sy = ps.get("system") if ps else None
    out = {"v": VERSION, "loss_db": L, "loss_parts": loss["parts"], "loss_basis": loss["basis"], "threshold_dbm": threshold}
    loss_txt = f"Building loss {L:.0f} dB: " + " + ".join(f"{p[0]:.0f} {p[1]}" for p in loss["parts"]) + "."
    if not sy:
        out.update(ps="unknown", margin_db=None, in_dbm=None, out_dbm=None, system=None,
                   ps_why=f"No agency radio system with power on file is licensed within {RADIUS_MI:.0f} mi, so the estimate can't be made.")
    else:
        inside = sy["out_dbm"] - L
        margin = round(inside - threshold, 1)
        v = verdict(margin)
        name = f"{sy['licensee'] or sy['call']} {sy['band']}{' trunked' if sy['basis'] == 'trunked' else ''} ({sy['call']})"
        terr = (f", hills −{sy['terrain_db']:.0f} dB" if sy["terrain_db"] else ", no hills in the way" if sy["terrain"] not in ("not cached here", "not counted")
                else ", hills not counted (terrain not on this computer)")
        say = {"short": f"likely short by {-margin:.0f} dB", "close": f"close to the line ({'+' if margin >= 0 else '−'}{abs(margin):.0f} dB): a walk test decides",
               "ok": f"likely OK by {margin:.0f} dB"}[v]
        why = {"trunked": "the strongest government trunked or 700/800 MHz system here",
               "regional": "the strongest agency trunked or 700/800 MHz system here (no government one in range)",
               "agency": "no agency trunked system in range: the strongest agency system", "any": "the strongest public safety licence here"}
        pick = "licensed to an agency named like the town" if sy.get("local") else why.get(sy["basis"], "")
        out.update(ps=v, margin_db=margin, in_dbm=round(inside, 1), out_dbm=sy["out_dbm"], system=sy,
                   ps_why=(f"Estimate, not a measurement. {name}, {pick}; donor site {sy['dist_mi']:.1f} mi {sy['compass']}: about "
                           f"{_f(sy['out_dbm'])} dBm outside (Okumura-Hata {ps.get('env', 'suburban')} from the licensed power and height{terr}). "
                           f"{loss_txt} About {_f(inside)} dBm inside against {_f(threshold)} dBm: {say}."
                           + (f" {sy['note'][:1].upper() + sy['note'][1:]}." if sy.get("note") else "")))
    if carriers is None:
        out.update(cell="unknown", cell_short=None, carriers=None, cell_why=carrier_note or "Carrier coverage not loaded here.")
    elif not carriers:
        out.update(cell="unknown", cell_short=None, carriers=[], cell_why=carrier_note or "No carrier claims coverage at this spot on the FCC map.")
    else:
        cs = []
        for c in carriers:
            m = round(c["signal_dbm"] - L - cell_target, 1)
            cs.append({**c, "in_dbm": round(c["signal_dbm"] - L, 1), "margin_db": m, "verdict": verdict(m)})
        worst = min(cs, key=lambda c: c["margin_db"])
        n_short = sum(1 for c in cs if c["verdict"] == "short")
        out.update(cell="short" if n_short else worst["verdict"], cell_short=n_short, carriers=cs, cell_margin_db=worst["margin_db"],
                   cell_why=("Estimate from the FCC Broadband Map (each carrier's own modelled signal outdoors) minus the building loss, "
                             f"against {_f(cell_target)} dBm inside: "
                             + "; ".join(f"{c['brand']} {c['tech']} {_f(c['signal_dbm'])} outside, about {_f(c['in_dbm'])} inside"
                                         f" ({'short' if c['verdict'] == 'short' else 'close' if c['verdict'] == 'close' else 'OK'})" for c in cs) + "."))
    return out


# --- NSI records kept per prospect ----------------------------------------------------------------------------------

def _db(data_dir):
    con = sqlite3.connect(os.path.join(data_dir, "need.db"), timeout=30)
    con.execute("CREATE TABLE IF NOT EXISTS prospect_nsi(id TEXT PRIMARY KEY, lat REAL, lon REAL, data TEXT, at TEXT)")
    return con


def kept_nsi(data_dir, ids):
    path = os.path.join(data_dir, "need.db")
    if not ids or not os.path.exists(path):
        return {}
    con = _db(data_dir)
    try:
        out = {}
        ids = list(ids)
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            for pid, data in con.execute(f"SELECT id, data FROM prospect_nsi WHERE id IN ({','.join('?' * len(part))})", part):
                try:
                    out[pid] = json.loads(data)
                except ValueError:
                    pass
        return out
    finally:
        con.close()


def keep_nsi(data_dir, pid, lat, lon, rec):
    con = _db(data_dir)
    try:
        con.execute("INSERT OR REPLACE INTO prospect_nsi VALUES(?,?,?,?,?)", (pid, lat, lon, json.dumps(rec), time.strftime("%Y-%m-%d %H:%M")))
        con.commit()
    finally:
        con.close()


def job_nsi(con, job_ids):
    """The NSI record saved with each job (das.js puts it in data.nsi), by job id."""
    ids = [int(j) for j in job_ids if j is not None]
    if not ids:
        return {}
    out = {}
    try:
        for jid, data in con.execute(f"SELECT id, data FROM das_job WHERE id IN ({','.join('?' * len(ids))})", ids):
            try:
                n = (json.loads(data or "{}") or {}).get("nsi")
            except ValueError:
                n = None
            if isinstance(n, dict):
                out[jid] = n
    except sqlite3.Error:
        pass
    return out


# --- the request ----------------------------------------------------------------------------------------------------

MAX_ROWS = 500


def method(env="suburban", threshold=THRESHOLD_DBM, cell_target=CELL_TARGET_DBM):
    return {"name": "RF need (estimate)", "version": VERSION, "env": env, "threshold_dbm": threshold, "cell_target_dbm": cell_target,
            "close_db": CLOSE_DB, "radius_mi": RADIUS_MI, "sources": list(SOURCES),
            "desc": (f"An estimate, not a measurement. Public safety: the strongest agency trunked or 700/800 MHz system licensed within "
                     f"{RADIUS_MI:.0f} mi (else the strongest agency system), its licensed power through Okumura-Hata {env} at street level with "
                     f"the licence's antenna pattern and the hills on the path where terrain is cached, minus the building loss (ITU-R P.2109 by "
                     f"year built, plus deep interior, cores and below grade from the NSI or the building's type), against {_f(threshold)} dBm. "
                     f"Within {CLOSE_DB:.0f} dB either way it's close: a walk test decides. Carriers: the FCC Broadband Map's modelled signal "
                     f"minus the same loss, against {_f(cell_target)} dBm.")}


def for_rows(con, data_dir, rows, area=None, env="suburban", threshold=THRESHOLD_DBM, cell_target=CELL_TARGET_DBM, use_terrain=True):
    """{id: need} for prospect rows (id, lat, lon, kind, size_label, city, state, job_id). area: {lat, lon, radius} of
    the search, so every chunk of one search shares one load; else the rows' own box."""
    rows = [r for r in rows[:MAX_ROWS] if r.get("id") and _num(r.get("lat")) is not None and _num(r.get("lon")) is not None]
    env = env if env in ENVS else "suburban"
    t0 = time.time()
    if not rows:
        return {"need": {}, "method": method(env, threshold, cell_target), "carriers": None, "ms": 0}
    stamp = uls_stamp(con)
    if area and _num(area.get("lat")) is not None:
        alat, alon, arad = float(area["lat"]), float(area["lon"]), max(0.5, min(60.0, float(area.get("radius") or 10)))
    else:
        las, los = [float(r["lat"]) for r in rows], [float(r["lon"]) for r in rows]
        alat, alon = (min(las) + max(las)) / 2, (min(los) + max(los)) / 2
        arad = max(geo.haversine_km(alat, alon, la, lo) for la, lo in zip(las, los)) / geo.MI_KM + 0.1
    A = area_for(con, alat, alon, arad, stamp)
    t_area = time.time()
    nsi_kept = kept_nsi(data_dir, [r["id"] for r in rows])
    nsi_job = job_nsi(con, {r.get("job_id") for r in rows if r.get("job_id")})
    b, why_not = bdc_open(data_dir)
    out = {}
    try:
        for r in rows:
            la, lo = float(r["lat"]), float(r["lon"])
            nsi = nsi_kept.get(r["id"]) or nsi_job.get(r.get("job_id"))
            # inside the search area's box? (a row outside it gets its own load, cached the same way)
            AA = A if (A["box"][0] <= la <= A["box"][1] and A["box"][2] <= lo <= A["box"][3]) else area_for(con, la, lo, 0.5, stamp)
            town = "district of columbia" if (r.get("state") or "").upper() == "DC" else r.get("city") or ""
            ps = ps_at(con, AA, la, lo, env, town, stamp, use_terrain)
            loss = entry_loss(r, nsi)
            carriers, note = None, why_not
            if b:
                carriers = carriers_at(b, la, lo)
                if not carriers:
                    st = (r.get("state") or "").upper()
                    note = (f"No carrier claims coverage at this spot on the FCC map." if not st or st in b["states"]
                            else f"Carrier coverage isn't loaded for {st} here.")
                    if st and st not in b["states"]:
                        carriers = None
            n = score(r, ps, loss, threshold, carriers, note, cell_target)
            if nsi:
                n["nsi"] = {k: nsi.get(k) for k in ("year_built", "stories", "sqft", "basement", "occupancy_label", "fetched")}
            out[r["id"]] = n
    finally:
        if b:
            b["con"].close()
    return {"need": out, "method": method(env, threshold, cell_target), "carriers": None if why_not else {"as_of": b and b["as_of"]},
            "carriers_note": why_not, "ms": round((time.time() - t0) * 1000), "area_ms": round((t_area - t0) * 1000)}


def _opts(d):
    env = d.get("env") if d.get("env") in ENVS else "suburban"
    thr = _num(d.get("threshold"))
    cell = _num(d.get("cell_target"))
    return env, (thr if thr is not None and -130 <= thr <= -40 else THRESHOLD_DBM), (cell if cell is not None and -130 <= cell <= -40 else CELL_TARGET_DBM)


QUERY = ("ids", "lat", "lon", "radius", "env", "threshold", "cell_target")


def rows_by_id(con, data_dir, ids):
    """The prospect rows for these ids (prospects.db), with the job each is on (das_prospect)."""
    import prospects
    path = prospects.db_path(data_dir)
    if not ids or not os.path.exists(path):
        return []
    pc = sqlite3.connect(path, timeout=30)
    out = []
    try:
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            out += [dict(zip(prospects.COLS, r)) for r in
                    pc.execute(f"SELECT {','.join(prospects.COLS)} FROM prospect WHERE id IN ({','.join('?' * len(part))})", part)]
    except sqlite3.OperationalError:
        return []
    finally:
        pc.close()
    out += [r for r in (prospects.get(data_dir, i) for i in ids if i.startswith("permit:")) if r]  # new buildings (permits.py)
    try:
        jobs = {}
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            jobs.update(dict(con.execute(f"SELECT id, job_id FROM das_prospect WHERE id IN ({','.join('?' * len(part))})", part).fetchall()))
        for r in out:
            r["job_id"] = jobs.get(r["id"])
    except sqlite3.Error:
        pass
    return out


def api(con, data_dir, q):
    """GET /api/das/prospects/need?ids=a,b,...&lat=&lon=&radius= (the search, so its chunks share one load)
    &env=&threshold=&cell_target=. A GET, so view-only logins see it too; the rows are read here, never sent."""
    ids = [x for x in (q.get("ids") or "").split(",") if x][:MAX_ROWS]
    env, thr, cell = _opts(q)
    area = {"lat": q.get("lat"), "lon": q.get("lon"), "radius": q.get("radius")} if _num(q.get("lat")) is not None else None
    return for_rows(con, data_dir, rows_by_id(con, data_dir, ids), area, env, thr, cell)


def api_nsi(con, data_dir, pid, d, lookup=None):
    """POST /api/das/prospects/<id>/nsi: the NSI record for the prospect's building (nsi.py, one small box), kept in
    need.db, and the prospect's need worked out again with it. Raises LookupError when the NSI has no structure there."""
    import prospects
    row = prospects.get(data_dir, pid)
    if not row:
        raise LookupError("That prospect isn't in the lists any more.")
    if row.get("lat") is None:
        raise ValueError("That building has no location.")
    if lookup is None:
        import nsi
        lookup = nsi.lookup
    rec = lookup(row["lat"], row["lon"])
    keep_nsi(data_dir, pid, row["lat"], row["lon"], rec)
    env, thr, cell = _opts(d)
    got = for_rows(con, data_dir, [{**row, "job_id": d.get("job_id")}], d.get("area") if isinstance(d.get("area"), dict) else None, env, thr, cell)
    return {"nsi": rec, "need": got["need"].get(pid)}
