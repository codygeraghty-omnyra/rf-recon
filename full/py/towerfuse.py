"""
The tower engine (plan 11/10, section 1): for a building, each carrier's nearest towers and what's on them, fused from the
open sources DAStastic holds. Andy Masur (Mobili-Fi, 11/9): "Show us the three closest towers... per carrier. And then
what technologies are supported on each of those towers."

No one source has the answer. FCC registrations and OpenStreetMap say where structures are, never who's on them; crowd
cells (OpenCelliD, your own captures, WiGLE where this copy allows it) say which carrier and technology is there, but a
crowd position is where phones were, not the tower. So each carrier's cell site (one eNB or gNB) is matched to the
structure it most likely sits on:

1. Structures, with weights (PARAMS): an FCC registered tower that is Constructed (1.0) or Granted (0.6), never any
   other status; an OSM mast or tower tagged communication:mobile_phone (1.0), other communication tags (0.8), an untyped
   mast (0.5), a water tower (0.4); a microwave end licensed to a carrier (1.2, and the carrier is there); an 800 MHz
   cellular licence location (1.5, with its filed azimuths, and the carrier is there); two or more land-mobile licences
   at one spot (0.3). Points within 40 m are one structure that keeps every source.
2. Crowd sites (cells.group, the rule cells.sites uses; FirstNet folds into AT&T, ex-Sprint into T-Mobile), each with an
   uncertainty sigma = clamp(150 + 600 / sqrt(samples) + 0.5 x spread, 150, 1500) m, or 50 m where OpenCelliD says the
   position was given, not worked out. Only LTE and NR sites place towers: 2G, 3G and CDMA are off the air in the US, and
   a UMTS cell's "site" ID is its RNC, a whole region; their cells are evidence on a tower LTE or NR placed. A site's
   position and samples come from the crowd's rows: your own readings say where the phone was, so they add channels, PCIs
   and "heard on site", and a site only they have is named under its carrier, never placed.
3. Matching: candidates within min(2 sigma, 2 km); score = Gaussian(distance, sigma) x weight; x1.3 for a structure two or
   more carriers pick. A site snaps only when its best beats the runner-up by 1.5x, and a structure under weight 0.8 only
   when it also scores 0.485 (weight 0.8 at 1 sigma); a site that doesn't, beside a structure its carrier is already on,
   joins it; otherwise it's estimated, with the candidates named. Recency (1.0 under a year, 0.7 to 3 years, 0.4 older)
   sets confidence, and a carrier on a tower only by readings over 3 years old is stale (step 6).
4. A site that doesn't snap is an estimated tower with an uncertainty bubble (radius sigma), never a confident pin; a
   carrier's estimates within 250 m are one.
5. Each tower: distance and bearing from the building, type in words, height, owner, registration, OSM id, each carrier's
   technologies, site IDs and cells (sector, PCI, channel -> band by cellspec.band_of), the bands it's licensed for in the
   county (B14 and n41 marked nationwide or leased), sectors (filed, else from crowd bearings with 3+ samples; within 60
   degrees of the building one "faces the site"), confidence with its reason, and dated, linked sources.
6. Per carrier: the 3 nearest current towers carrying it, within 5 mi, widening to 10 and then 20 while fewer are found
   (one more run at 20 answers every carrier still short; OSM only to 8 km), and a verdict on the nearest: over
   towers.far_mi (10) far, off-air BDA not recommended; 5-10 mi marginal; under 5 in reach; none within 20 mi. A stale
   tower is listed apart and named in the verdict when nearer, never its distance. Every verdict adds that a roof reading
   decides.

Read only, worked out on each request, no network calls (a top-up is its own POST: cells.fetch_near, osmtowers). Every
threshold is a starting value in PARAMS, tuned by the bench; each answer carries params_version. Standard library only.
"""
import calendar
import heapq
import math
import re
import sqlite3
import time

import build
import cells
import cellspec
import geo
import osmtowers

PARAMS_VERSION = "towerfuse 2 (2026-11-11)"  # review rounds 2-3: site_margin_km, the stale and verdict rules
PARAMS = {
    # structures and their weights (cells.live_towers never returns a registration that isn't Constructed or Granted)
    "w_asr": {"Constructed": 1.0, "Granted": 0.6},
    "w_asr_unknown": 1.0,      # a tower table with no status column (a hand-made copy)
    "w_osm_mobile": 1.0,       # OSM communication:mobile_phone
    "w_osm_comm": 0.8,         # other communication tags; a communications tower
    "w_osm_mast": 0.5,         # an untyped mast or tower
    "w_osm_water": 0.4,        # a water tower
    "w_mw_carrier": 1.2,       # a microwave end licensed to a carrier
    "w_cl": 1.5,               # an 800 MHz cellular (CL) licence location
    "w_lm_cluster": 0.3,       # land-mobile licences at one spot
    "lm_min_calls": 2,
    "merge_m": 40, "chain_max_m": 80,
    # a crowd site's uncertainty, metres
    "sigma_base_m": 150, "sigma_samples_m": 600, "sigma_spread": 0.5, "sigma_min_m": 150, "sigma_max_m": 1500, "sigma_exact_m": 50,
    # the radios whose sites place towers. 2G, 3G and CDMA are off the air in the US (AT&T 3G 2/2022, T-Mobile's 7/2022,
    # Verizon CDMA 12/2022), and a UMTS cell's "site" ID is its RNC, a whole region: their cells are only evidence on a
    # tower LTE or NR placed (review 11/10)
    "placing_radios": ("LTE", "NR"),
    # matching
    "match_sigmas": 2.0, "match_max_m": 2000,
    "recency": ((365, 1.0), (1095, 0.7)), "recency_old": 0.4, "recency_unknown": 0.7,
    "stale_days": 1095,  # a carrier on a tower only by readings older than this is listed after the current ones and never in the verdict
    "shared_boost": 1.3, "snap_ratio": 1.5, "estimate_merge_m": 250, "match_grid_deg": 0.005,
    "weak_snap_min": round(0.8 * math.exp(-0.5), 3),  # a structure under high_weight wins only with this score (0.485)
    # confidence: High needs this many samples, this clear a match, this good a structure, and a year's recency
    "high_samples": 10, "high_ratio": 3.0, "high_weight": 0.8,
    # sectors
    "sector_min_samples": 3, "sector_min_offset_m": 50, "faces_deg": 60,
    # per carrier
    "n": 3, "radius_steps_mi": (5, 10, 20), "osm_max_km": 8.0, "struct_margin_km": 2.0, "site_margin_km": 1.0,
    "far_mi": 10.0, "reach_mi": 5.0, "roof_dbm": (-95, -85),
    "unknown_within_mi": 2.0, "unknown_max": 50, "towers_max": 200,
}
CARRIERS = ("AT&T", "Verizon", "T-Mobile")
ATTRIBUTION_LINES = [
    "Cell tower data from OpenCellID, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), from "
    "opencellid.org. Changes: DAStastic groups the cells into sites, estimates each site's position and matches it to the "
    "registered or mapped structure it most likely sits on.",
    "© OpenStreetMap contributors (ODbL): https://www.openstreetmap.org/copyright",
    "FCC antenna structure registrations and licences (US government public data).",
]
WIGLE_LINE = "Data © WiGLE.net contributors (wigle.net)"
# FCC ASR structure type codes, in words (the ASR's own list)
ASR_TYPES = {"B": "rooftop (building)", "BANT": "rooftop antenna", "BMAST": "rooftop mast", "BPIPE": "rooftop pipe", "BPOLE": "rooftop pole",
             "BRIDG": "bridge", "BTWR": "rooftop tower", "GTOWER": "guyed tower", "LTOWER": "lattice tower", "MAST": "mast",
             "MTOWER": "monopole", "NNGTANN": "guyed tower array", "NNLTANN": "lattice tower array", "NNMTANN": "monopole array",
             "PIPE": "pipe", "POLE": "pole", "RIG": "rig", "SIGN": "sign or billboard", "SILO": "silo", "STACK": "smokestack",
             "TANK": "water tank", "TOWER": "tower", "TREE": "stealth tree", "UPOLE": "utility pole"}
OSM_BUILT = {"freestanding": "monopole", "lattice": "lattice", "guyed_lattice": "guyed lattice", "guyed_tube": "guyed", "dish": "dish", "dome": "dome"}
NATIONWIDE = {"AT&T": [{"band": "B14", "how": "nationwide or leased",
                        "note": "FirstNet: the First Responder Network Authority's nationwide licence, built and run by AT&T"}],
              "T-Mobile": [{"band": "n41", "how": "nationwide or leased",
                            "note": "2.5 GHz: mostly leased educational (EBS) licences, so not in the county's market licences"}]}
SITE_WORD = {"LTE": "eNB", "NR": "gNB"}  # a UMTS, GSM or CDMA "site" here is one cell (cells.group, fold)


# ---------------------------------------------------------------- small helpers

def _m(a_lat, a_lon, b_lat, b_lon):
    return geo.haversine_km(a_lat, a_lon, b_lat, b_lon) * 1000


def _angle(a, b):
    d = abs((a - b) % 360)
    return min(d, 360 - d)


def licensee_carrier(name, remember=True):
    """The carrier a licensee is, by carriers.py's rules (FirstNet's is AT&T), or None when it isn't plainly one."""
    import carriers
    c = carriers.name_of(name or "", remember=remember)
    return "AT&T" if c == "FirstNet" else c


MAX_CARRIERS, MAX_NAME = 8, 60
_KNOWN = {}


def known_carriers():
    """Every carrier a report can be asked for, lowercased -> as the report names it: the brands cells.OPERATORS names and
    each regional carrier in the US network-code register (cells.register_name), the names crowd sites carry."""
    if not _KNOWN:
        names = {cells.brand(v) for v in cells.OPERATORS.values()} | {cells.brand(cells.register_name(v)) for v in cells.REGISTER.values()}
        _KNOWN.update({n.lower(): n for n in names if n})
    return _KNOWN


def wanted(names):
    """A request's carriers ("AT&T,Verizon" or a list) as the report names them; the three by default. A name that is no
    carrier is a ValueError (a 400): an unknown or misspelled one ran the whole engine at 5, 10 and 20 mi to say "none",
    and every name went into carriers.py's memo for good (review 11/10). At most MAX_CARRIERS names of MAX_NAME characters."""
    if not names:
        return list(CARRIERS)
    if isinstance(names, str):
        names = names.split(",")
    names = [str(x).strip() for x in names if str(x).strip()]
    if len(names) > MAX_CARRIERS:
        raise ValueError(f"Ask for at most {MAX_CARRIERS} carriers at once.")
    known, out = known_carriers(), []
    for x in names:
        if len(x) > MAX_NAME:
            raise ValueError("That isn't a carrier's name.")
        c = known.get(x.lower()) or licensee_carrier(x, remember=False) or cells.brand(x)
        c = known.get(str(c or "").lower())
        if not c:
            raise ValueError(f"No carrier called {x[:40]!r} here: ask for AT&T, Verizon, T-Mobile, UScellular or Dish / Boost.")
        if c not in out:
            out.append(c)
    return out or list(CARRIERS)


def age_days(last, now_s):
    """Days from a date ("2021-11-11...") to now_s, or None when it isn't one. calendar.timegm, not time.mktime: Windows'
    mktime raises OverflowError before 1970, and a phone whose clock reset wrote 1969-12-31 into a walk, so every tower
    report there was a 500 (review 11/10). A date before 2009 is no date: no LTE or NR cell was on the air in the US then,
    so it's a clock that reset, and it would make a live site read stale."""
    try:
        t = time.strptime(str(last)[:10], "%Y-%m-%d")
        return None if t.tm_year < 2009 else (now_s - calendar.timegm(t)) / 86400
    except (ValueError, OverflowError, OSError):
        return None


def recency(last, now_s, P=PARAMS):
    age = age_days(last, now_s) if last else None
    if age is None:
        return P["recency_unknown"]
    for days, f in P["recency"]:
        if age < days:
            return f
    return P["recency_old"]


def _height_m(v):
    m = re.match(r"\s*([\d.]+)\s*(m|ft|')?\s*$", str(v or ""))
    if not m:
        return None
    try:
        n = float(m.group(1))
    except ValueError:
        return None
    return n * 0.3048 if m.group(2) in ("ft", "'") else n


def asr_url(usi):
    return (f"https://wireless2.fcc.gov/UlsApp/AsrSearch/asrRegistration.jsp?regKey={int(usi)}" if usi
            else "https://wireless2.fcc.gov/UlsApp/AsrSearch/asrRegistrationSearch.jsp")


def links(lat, lon):
    """One click to check a tower by eye (Andy checks every one in Google Maps and Street View) and to look it up."""
    return {"google_maps": f"https://www.google.com/maps/search/?api=1&query={lat:.6f},{lon:.6f}",
            "street_view": f"https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat:.6f},{lon:.6f}",
            "cellmapper": f"https://www.cellmapper.net/map?latitude={lat:.6f}&longitude={lon:.6f}&zoom=15",
            "opencellid": f"https://opencellid.org/#zoom=16&lat={lat:.6f}&lon={lon:.6f}"}


# ---------------------------------------------------------------- crowd sites

def _placed(c):
    """A cell the crowd's rows place (cells.Collector): your own readings alone say where the phone was, not the tower."""
    return bool(c.get("crowd_points", 1))


def _crowd_samples(c):
    return int(c["crowd_samples"] if "crowd_samples" in c else (c.get("samples") or 0))


def make_site(key, cs, P=PARAMS):
    """One crowd site from its cells: where (the average; the cells OpenCelliD calls exact, when any), sigma, samples, last.
    Position, samples and spread come from the cells the crowd's rows place; a cell only your readings have rides along
    (its channel, PCI and heard on site), never moving the site or shrinking its sigma (review 11/10)."""
    net, radio, sid = key
    placed = [c for c in cs if _placed(c)] or cs
    exact = [c for c in placed if c.get("changeable") == 0]
    use = exact or placed
    la, lo = sum(c["lat"] for c in use) / len(use), sum(c["lon"] for c in use) / len(use)
    samples = sum(max(1, _crowd_samples(c)) for c in placed)
    spread = math.sqrt(sum(_m(la, lo, c["lat"], c["lon"]) ** 2 for c in placed) / len(placed))
    sigma = P["sigma_exact_m"] if exact else min(P["sigma_max_m"], max(P["sigma_min_m"], P["sigma_base_m"] + P["sigma_samples_m"] / math.sqrt(samples)
                                                                     + P["sigma_spread"] * spread))
    carrier = "T-Mobile" if net == "T-Mobile (ex-Sprint)" else net if net in cells.BIG3 else cells.brand(cs[0]["operator"])
    return {"key": f"{net}|{radio}|{sid}", "carrier": carrier, "radio": radio, "site_id": sid, "site_kind": SITE_WORD.get(radio, "cell"),
            "lat": la, "lon": lo, "sigma": round(sigma), "samples": samples, "spread_m": round(spread),
            "last": max((c["last"] for c in cs if c.get("last")), default=None), "cells": cs, "exact": bool(exact),
            "plmns": sorted({c["plmn"] for c in cs}), "operators": sorted({c["operator"] for c in cs}),
            "firstnet": any(c["plmn"] == "313-100" for c in cs), "ex_sprint": net == "T-Mobile (ex-Sprint)",
            "crowd_undated": any(_placed(c) and not c.get("crowd_last") for c in cs),
            "sources": sorted({x for c in cs for x in c["sources"]}), "heard_on_site": sum(int(c.get("survey") or 0) for c in cs)}


def heard_only(key, cs):
    """A site only your own readings have: they say the carrier reaches the building, not where its tower is, so it's named
    under its carrier and never placed (review 11/10: 80 readings indoors made AT&T's #1 "tower" at 0.00 mi)."""
    net, radio, sid = key
    carrier = "T-Mobile" if net == "T-Mobile (ex-Sprint)" else net if net in cells.BIG3 else cells.brand(cs[0]["operator"])
    return {"carrier": carrier, "radio": radio, "site_kind": SITE_WORD.get(radio, "cell"), "site_id": sid, "cells": len(cs),
            "readings": sum(int(c.get("survey") or 0) for c in cs), "last": max((c["last"] for c in cs if c.get("last")), default=None),
            "sources": sorted({x for c in cs for x in c["sources"]})}


# ---------------------------------------------------------------- structures

def asr_type(code):
    code = str(code or "").strip().upper()
    return ASR_TYPES.get(code, code.lower() or None)


def osm_type(tags, kind):
    if tags.get("mimics"):
        return f"stealth {str(tags['mimics']).replace('_', ' ')}"
    built = OSM_BUILT.get(tags.get("tower:construction") or "")
    if kind == "water tower":
        return "water tank"
    if kind == "rooftop":
        return "rooftop"
    if built:
        return built if built in ("monopole", "dish", "dome") else f"{built} {'mast' if kind == 'mast' else 'tower'}"
    return kind


def osm_weight(tags, kind, P=PARAMS):
    if kind == "water tower":
        return P["w_osm_water"]
    if str(tags.get("communication:mobile_phone") or "").lower() not in ("", "no"):
        return P["w_osm_mobile"]
    if tags.get("tower:type") == "communication" or kind == "communications tower" or any(
            k.startswith("communication:") and str(v).lower() not in ("", "no") for k, v in tags.items()):
        return P["w_osm_comm"]
    return P["w_osm_mast"]


def _rows(con, q, args):
    try:
        return [dict(r) for r in con.execute(q, args)]
    except sqlite3.Error:  # a copy without that table: nothing from it
        return []


def structure_points(con, crowd, lat, lon, km, P=PARAMS):
    """Every structure point within km of the building, before the 40 m merge: {"src", "lat", "lon", "weight", "rec", "carrier"}."""
    s, n, w, e = geo.bbox(lat, lon, km / geo.MI_KM)
    pts = []
    for t in cells.live_towers(con, s, n, w, e):
        st = t.get("status")
        pts.append({"src": "asr", "lat": t["lat"], "lon": t["lon"], "weight": P["w_asr"].get(st, 0.0) if st else P["w_asr_unknown"], "rec": t})
    # OSM's towers only where this build may use them: fused with the crowd's carrier cells they wait for counsel (ODbL and
    # CC BY-SA), so a sold copy and a team login read none (build.PERSONAL_ONLY, Cody 11/10)
    for r in (osmtowers.rows_near(crowd, lat, lon, min(P["osm_max_km"], km)) if build.allowed(osmtowers.SOURCE) else []):
        pts.append({"src": "osm", "lat": r["lat"], "lon": r["lon"], "weight": osm_weight(r["tags"], r["kind"], P), "rec": r})
    cl = {}
    for r in _rows(con, "SELECT * FROM tx WHERE service='CL' AND status='A' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e)):
        x = cl.setdefault((r.get("call_sign"), r.get("loc_num")), dict(r, azimuths=set()))
        if r.get("azimuth") is not None:
            x["azimuths"].add(round(float(r["azimuth"])) % 360)
    for x in cl.values():
        pts.append({"src": "cl", "lat": x["lat"], "lon": x["lon"], "weight": P["w_cl"], "rec": x, "carrier": licensee_carrier(x.get("licensee"))})
    for r in _rows(con, "SELECT * FROM mw_link WHERE (tx_lat BETWEEN ? AND ? AND tx_lon BETWEEN ? AND ?) OR (rx_lat BETWEEN ? AND ? AND rx_lon BETWEEN ? AND ?)",
                   (s, n, w, e, s, n, w, e)):
        c = licensee_carrier(r.get("licensee"))
        if c not in CARRIERS:
            continue
        for end in ("tx", "rx"):
            la, lo = r.get(f"{end}_lat"), r.get(f"{end}_lon")
            if la is not None and lo is not None and s <= la <= n and w <= lo <= e:
                pts.append({"src": "mw", "lat": la, "lon": lo, "weight": P["w_mw_carrier"], "carrier": c, "rec": dict(r, end=end)})
    lm, size = {}, P["merge_m"] / 111000.0
    # "+tower_reg": with no ANALYZE statistics SQLite read "tower_reg IS NULL OR tower_reg=''" as two index lookups and walked
    # tx_tower over every licence with no registration, three in four of them, wherever the pin was (5.8 s a call on the PC's
    # 8M rows, review 11/10); the unary plus keeps it on the location index, as need.py does with +freq_mhz (tx is a view in
    # the web version, where INDEXED BY is an error). tests/test_query_plans.py checks the plan
    for r in _rows(con, "SELECT DISTINCT call_sign, licensee, lat, lon FROM tx WHERE status='A' AND service<>'CL' AND (+tower_reg IS NULL OR +tower_reg='') "
                        "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e)):
        if r["lat"] is None or r["lon"] is None:
            continue
        lm.setdefault((round(r["lat"] / size), round(r["lon"] / size)), []).append(r)
    for rs in lm.values():
        calls = sorted({r["call_sign"] for r in rs})
        if len(calls) >= P["lm_min_calls"]:
            pts.append({"src": "lm", "lat": sum(r["lat"] for r in rs) / len(rs), "lon": sum(r["lon"] for r in rs) / len(rs), "weight": P["w_lm_cluster"],
                        "rec": {"calls": calls[:12], "licensees": sorted({r["licensee"] for r in rs if r["licensee"]})[:12]}})
    return pts


RANK = {"asr": 0, "cl": 1, "osm": 2, "mw": 3, "lm": 4}  # whose position a merged structure takes: the most precise


def merge(pts, P=PARAMS):
    """Points within merge_m are one structure that keeps every source; it stands where its most precise source puts it.
    A point joins the structure of its nearest member within merge_m, so a chain of sources metres apart stays one (an OSM
    mast 35 m from the second of two registrations 30 m apart was its own structure, and the near-tie made the site an
    estimate), but never more than chain_max_m from where the structure stands, so a row of separate towers isn't one.
    Review 11/10: the grid's column width came from each point's own latitude, so two points under 40 m apart could land two
    columns apart and stay two structures (a registration and an 800 MHz site 31 m apart; 81 live registration pairs
    nationwide); one width for the whole call now, at least merge_m everywhere in it."""
    out, grid = [], {}
    if not pts:
        return out
    cy = P["merge_m"] / 111000.0
    cx = cy / max(0.05, min(math.cos(math.radians(p["lat"])) for p in pts))
    pts = sorted(pts, key=lambda p: (RANK[p["src"]], -p["weight"], p["lat"], p["lon"]))
    for p in pts:
        k = (math.floor(p["lat"] / cy), math.floor(p["lon"] / cx))
        hit, hd = None, None
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for q, st in grid.get((k[0] + dy, k[1] + dx), []):
                    d = _m(q["lat"], q["lon"], p["lat"], p["lon"])
                    if d <= P["merge_m"] and (hd is None or d < hd) and _m(st["lat"], st["lon"], p["lat"], p["lon"]) <= P["chain_max_m"]:
                        hit, hd = st, d
        if hit:
            hit["members"].append(p)
            hit["weight"] = max(hit["weight"], p["weight"])
        else:
            hit = {"lat": p["lat"], "lon": p["lon"], "weight": p["weight"], "members": [p]}
            out.append(hit)
        grid.setdefault(k, []).append((p, hit))
    for st in out:
        first = st["members"][0]
        r = first["rec"]
        st["id"] = {"asr": lambda: f"asr:{r.get('reg')}", "osm": lambda: f"osm:{r['id']}", "cl": lambda: f"cl:{r.get('call_sign')}:{r.get('loc_num')}",
                    "mw": lambda: f"mw:{r.get('call_sign')}:{first['lat']:.5f},{first['lon']:.5f}",
                    "lm": lambda: f"lm:{first['lat']:.5f},{first['lon']:.5f}"}[first["src"]]()
        srcs = {m["src"] for m in st["members"]}
        st["kind"] = "registered" if "asr" in srcs else "mapped" if "osm" in srcs else "licensed" if srcs & {"cl", "mw"} else "cluster"
        st["licensed_carriers"] = sorted({m["carrier"] for m in st["members"] if m.get("carrier") in CARRIERS})
    return out


# ---------------------------------------------------------------- matching

def _grid(items, deg):
    g = {}
    for it in items:
        g.setdefault((math.floor(it["lat"] / deg), math.floor(it["lon"] / deg)), []).append(it)
    return g


def _reach_box(lat, reach):
    """Degrees of latitude and longitude that hold every point within reach metres: a little wide (111,000 m a degree, the
    longitude at the box's far edge), so a cheap box test before the distance never drops one."""
    dlat = reach / 111000.0
    return dlat, reach / (111000.0 * max(0.05, math.cos(math.radians(min(89.9, abs(lat) + dlat)))))


def match(sites, structs, now_s, P=PARAMS):
    """Each site's candidates and its match: site["match"] = {"struct", "dist_m", "score", "ratio"} when it snaps, else None,
    with site["candidates"] naming what it could be when no structure is a clear winner. A structure of little weight (under
    high_weight: Granted, a land-mobile spot, an untyped mast, a water tower) wins only when it also scores weak_snap_min,
    what a weight-0.8 structure scores 1 sigma out: a lone 0.3 land-mobile spot 1.1 km from the crowd's position
    snapped with score 0.055 and lost the bubble (review 11/10). Recency isn't in the score: one site's candidates all share
    it, so it never changed a match; it moves a stale tower down its carrier's list instead (report)."""
    deg = P["match_grid_deg"]  # a grid about the size of the reach, searched only as far as the reach's own box
    g = _grid(structs, deg)
    for s in sites:
        reach = min(P["match_sigmas"] * s["sigma"], P["match_max_m"])
        dlat, dlon = _reach_box(s["lat"], reach)
        cands = []
        for iy in range(math.floor((s["lat"] - dlat) / deg), math.floor((s["lat"] + dlat) / deg) + 1):
            for ix in range(math.floor((s["lon"] - dlon) / deg), math.floor((s["lon"] + dlon) / deg) + 1):
                for st in g.get((iy, ix), ()):
                    if abs(st["lat"] - s["lat"]) > dlat or abs(st["lon"] - s["lon"]) > dlon:
                        continue
                    d = _m(s["lat"], s["lon"], st["lat"], st["lon"])
                    if d <= reach:
                        cands.append({"struct": st, "dist_m": d, "base": math.exp(-d * d / (2 * s["sigma"] ** 2)) * st["weight"]})
        s["cands"] = cands
    picked = {}
    for s in sites:  # pass 1: what each site would pick on its own; a site that may be gone (site_stale) says no carrier is there now
        if s["cands"] and not site_stale(s, now_s, P):
            best = max(s["cands"], key=lambda c: c["base"])
            picked.setdefault(best["struct"]["id"], set()).add(s["carrier"])
    for s in sites:  # pass 2: a structure two or more carriers pick counts for more
        for c in s["cands"]:
            c["score"] = c["base"] * (P["shared_boost"] if len(picked.get(c["struct"]["id"], ())) >= 2 else 1.0)
        ranked = sorted(s["cands"], key=lambda c: -c["score"])
        s["match"], s["candidates"] = None, []
        if not ranked:
            continue
        ratio = ranked[0]["score"] / ranked[1]["score"] if len(ranked) > 1 and ranked[1]["score"] > 0 else None
        clear = ratio is None or ratio >= P["snap_ratio"]
        firm = ranked[0]["struct"]["weight"] >= P["high_weight"] or ranked[0]["score"] >= P["weak_snap_min"]
        if clear and firm:
            s["match"] = dict(ranked[0], ratio=ratio, runner_up=ranked[1]["struct"]["id"] if len(ranked) > 1 else None)
        else:
            s["candidates"] = [{"id": c["struct"]["id"], "kind": c["struct"]["kind"], "dist_m": round(c["dist_m"]), "score": round(c["score"], 3)}
                               for c in ranked[:4]]
    return sites


# ---------------------------------------------------------------- towers

def _where(lat, lon, b_lat, b_lon):
    w = cells.where_from(b_lat, b_lon, lat, lon)
    return {"lat": round(lat, 6), "lon": round(lon, 6), "dist_mi": w["dist_mi"], "dist_km": round(geo.haversine_km(b_lat, b_lon, lat, lon), 2),
            "bearing": w["bearing"], "compass": w["compass"]}


def _new_tower(tid, kind, lat, lon, b_lat, b_lon):
    return {"id": tid, "kind": kind, **_where(lat, lon, b_lat, b_lon), "uncertainty_m": None, "type": None, "height_ft": None, "height_m": None,
            "owner": None, "registration": None, "osm": None, "licences": [], "carriers": {}, "candidates": [], "sources": [], "links": links(lat, lon)}


def struct_tower(st, b_lat, b_lon, dates):
    """A tower on a structure: what each of its sources says about it."""
    t = _new_tower(st["id"], st["kind"], st["lat"], st["lon"], b_lat, b_lon)
    by = {}
    for m in st["members"]:
        by.setdefault(m["src"], []).append(m["rec"])
    a = (by.get("asr") or [None])[0]
    o = (by.get("osm") or [None])[0]
    if a:
        t["type"] = asr_type(a.get("struct_type"))
        h = a.get("overall_agl_m") if a.get("overall_agl_m") is not None else a.get("height_m")
        if h is not None:
            t["height_m"] = round(float(h), 1)
        t["owner"] = a.get("owner")
        t["registration"] = {"number": a.get("reg"), "status": a.get("status") or "on file", "date": a.get("constructed") or None,
                             "url": asr_url(a.get("usi")), "address": ", ".join(v for v in (a.get("street"), a.get("city"), a.get("state")) if v) or None}
        t["sources"].append({"name": f"FCC antenna structure registration {a.get('reg')}", "what": "where the structure is, its type, height and owner",
                             "date": dates.get("asr"), "url": asr_url(a.get("usi")), "licence": "US government public data"})
    if o:
        typ, otype = o["tags"], o["id"].split("/")[0]
        t["osm"] = {"id": o["id"], "url": f"https://www.openstreetmap.org/{o['id']}", "kind": o["kind"], "tags": typ, "fetched": (o.get("fetched") or "")[:10] or None}
        t["type"] = t["type"] or osm_type(typ, o["kind"])
        if t["height_m"] is None and _height_m(typ.get("height")) is not None:
            t["height_m"] = round(_height_m(typ.get("height")), 1)
        t["owner"] = t["owner"] or (f"{typ['operator']} (OpenStreetMap's operator tag)" if typ.get("operator") else None)
        t["sources"].append({"name": f"OpenStreetMap {otype} {o['id'].split('/')[-1]}", "what": "a mapped mast or tower",
                             "date": t["osm"]["fetched"], "url": t["osm"]["url"], "licence": "ODbL: © OpenStreetMap contributors"})
    for x in by.get("cl") or []:
        lic = {"kind": "800 MHz cellular", "call_sign": x.get("call_sign"), "licensee": x.get("licensee"), "carrier": licensee_carrier(x.get("licensee")),
               "location": x.get("loc_num"), "azimuths": sorted(x.get("azimuths") or []),
               "url": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={x['usi']}" if x.get("usi") else None}
        t["licences"].append(lic)
        if t["height_m"] is None and x.get("height_tip_m") is not None:
            t["height_m"] = round(float(x["height_tip_m"]), 1)
        t["sources"].append({"name": f"FCC cellular licence {x.get('call_sign')}, location {x.get('loc_num')}", "what": f"{x.get('licensee')}'s 800 MHz site, as filed",
                             "date": dates.get("uls"), "url": lic["url"], "licence": "US government public data"})
    for x in by.get("mw") or []:
        lic = {"kind": "microwave", "call_sign": x.get("call_sign"), "licensee": x.get("licensee"), "carrier": licensee_carrier(x.get("licensee")),
               "end": x.get("end"), "url": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={x['usi']}" if x.get("usi") else None}
        t["licences"].append(lic)
        t["sources"].append({"name": f"FCC microwave licence {x.get('call_sign')}", "what": f"{x.get('licensee')}'s link ends here",
                             "date": dates.get("uls"), "url": lic["url"], "licence": "US government public data"})
    for x in by.get("lm") or []:
        t["sources"].append({"name": f"FCC land-mobile licences at this spot ({len(x['calls'])})", "what": ", ".join(x["licensees"][:4]),
                             "date": dates.get("uls"), "url": None, "licence": "US government public data"})
    if not t["type"]:
        t["type"] = "licensed site (no registered structure)" if by.get("cl") or by.get("mw") else "land-mobile site"
    if t["height_m"] is not None:
        t["height_ft"] = round(t["height_m"] * 3.28084)
    for c in st["licensed_carriers"]:  # a filing says the carrier is here, crowd cells or not
        e = _entry(t, c)
        for lic in t["licences"]:
            if lic["carrier"] == c:
                e["evidence"].add("800 MHz licence" if lic["kind"] == "800 MHz cellular" else "microwave licence")
    return t


def _entry(t, carrier):
    return t["carriers"].setdefault(carrier, {"carrier": carrier, "techs": set(), "sites": [], "evidence": set(), "firstnet": False, "ex_sprint": False,
                                              "samples": 0, "last": None})


def add_site(t, s, P=PARAMS):
    """A crowd site on a tower: its carrier's entry gains the technology, site ID and cells, each cell's band and bearing."""
    e = _entry(t, s["carrier"])
    e["techs"].add(s["radio"])
    e["evidence"].add("crowd cells")
    e["firstnet"] = e["firstnet"] or s["firstnet"]
    e["ex_sprint"] = e["ex_sprint"] or s["ex_sprint"]
    e["samples"] += s["samples"]
    e["last"] = max(x for x in (e["last"], s["last"]) if x) if (e["last"] or s["last"]) else None
    to_site = (t["bearing"] + 180) % 360  # from the tower toward the building
    out = []
    for c in sorted(s["cells"], key=lambda c: (c.get("sector") is None, str(c.get("sector")))):
        off = _m(t["lat"], t["lon"], c["lat"], c["lon"])
        az = round(geo.bearing_deg(t["lat"], t["lon"], c["lat"], c["lon"])) % 360 if (  # a bearing from the crowd's own rows only
            t["kind"] != "estimated" and _placed(c) and _crowd_samples(c) >= P["sector_min_samples"] and off > P["sector_min_offset_m"]) else None
        band = cellspec.band_of(s["radio"], c.get("channel"), s["carrier"]) if c.get("channel") not in (None, "") else None
        out.append({"gci": c["gci"], "plmn": c["plmn"], "operator": c["operator"], "sector": c.get("sector"), "pci": c.get("pci"),
                    "channel": c.get("channel"), "band": band, "samples": c.get("samples"), "last": c.get("last"), "sources": c["sources"],
                    "az_est": az, "faces_site": None if az is None else _angle(az, to_site) <= P["faces_deg"],
                    "firstnet": c["plmn"] == "313-100", "heard_on_site": int(c.get("survey") or 0)})
    m = s.get("match") or {}
    e["sites"].append({"key": s["key"], "radio": s["radio"], "site_kind": s["site_kind"], "site_id": s["site_id"], "plmns": s["plmns"], "ex_sprint": s["ex_sprint"],
                       "crowd_undated": s.get("crowd_undated", False),
                       "operators": s["operators"], "samples": s["samples"], "last": s["last"], "sigma_m": s["sigma"],
                       "crowd_at": {"lat": round(s["lat"], 6), "lon": round(s["lon"], 6)}, "offset_m": round(_m(t["lat"], t["lon"], s["lat"], s["lon"])),
                       "match": {"score": round(m["score"], 3), "ratio": None if m.get("ratio") is None else round(m["ratio"], 2),
                                 "runner_up": m.get("runner_up"), "attached": bool(m.get("attached"))} if m else None,
                       "cells": out, "sources": s["sources"], "heard_on_site": s.get("heard_on_site", 0)})


def attach_to_own(sites, structs, now_s, P=PARAMS):
    """A site that didn't snap, beside a structure its own carrier is already on (another of its current sites snapped there,
    or its own 800 MHz or microwave filing is there), goes on that structure when it scores within snap_ratio of the site's
    best: a carrier's second eNB or its gNB on the tower its first eNB found. It was an estimate a few hundred metres off
    that took one of the carrier's three places and pushed out a real tower (review 11/10). A site that may be gone
    (site_stale: ex-Sprint, or heard over 3 years ago) is no anchor: a dead Sprint eNB on the old Sprint tower pulled
    T-Mobile's live eNB onto it, off T-Mobile's own tower 420 m away (round 2)."""
    on = {}
    for s in sites:
        if s.get("match") and not site_stale(s, now_s, P):
            on.setdefault(s["match"]["struct"]["id"], set()).add(s["carrier"])
    for st in structs:
        for c in st["licensed_carriers"]:
            on.setdefault(st["id"], set()).add(c)
    for s in sites:
        if s.get("match") or not s["cands"]:
            continue
        best = max(c["score"] for c in s["cands"])
        own = [c for c in s["cands"] if s["carrier"] in on.get(c["struct"]["id"], ()) and c["score"] * P["snap_ratio"] >= best]
        if own:
            pick = max(own, key=lambda c: (c["score"], -c["dist_m"]))
            rest = [c for c in s["cands"] if c is not pick]
            nxt = max(rest, key=lambda c: c["score"]) if rest else None
            s["match"] = dict(pick, ratio=pick["score"] / nxt["score"] if nxt and nxt["score"] > 0 else None,
                              runner_up=nxt["struct"]["id"] if nxt else None, attached=True)
            s["candidates"] = []


def estimate_groups(unmatched, P=PARAMS):
    """A carrier's unmatched sites in groups whose centres (sample-weighted) are at least estimate_merge_m apart: the closest
    two of a carrier merge first, again and again, so the answer doesn't depend on the order the sites came in (a site 60 m
    from another stayed apart or joined depending on which eNB number was lower, review 11/10). On a grid of that size: it
    was every site against every group, 2.8M distances for Midtown at 20 mi."""
    lim = P["estimate_merge_m"]
    if not unmatched:
        return []
    cy = lim / 111000.0
    cx = cy / max(0.05, min(math.cos(math.radians(s["lat"])) for s in unmatched))
    groups, cell, heap = {}, {}, []
    where = lambda g: (g["carrier"], math.floor(g["lat"] / cy), math.floor(g["lon"] / cx))  # noqa: E731

    def near(i):
        g = groups[i]
        c, y, x = where(g)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for j in cell.get((c, y + dy, x + dx), ()):
                    if j != i:
                        d = _m(g["lat"], g["lon"], groups[j]["lat"], groups[j]["lon"])
                        if d <= lim:
                            heapq.heappush(heap, (d, min(i, j), max(i, j)))

    for i, s in enumerate(sorted(unmatched, key=lambda s: (-s["samples"], s["key"]))):
        groups[i] = {"carrier": s["carrier"], "sites": [s], "w": max(1, s["samples"]), "lat": s["lat"], "lon": s["lon"]}
        cell.setdefault(where(groups[i]), set()).add(i)
    for i in list(groups):
        near(i)
    nxt = len(groups)
    while heap:
        _d, i, j = heapq.heappop(heap)
        if i not in groups or j not in groups:
            continue  # one of the two already merged into another
        a, b = groups.pop(i), groups.pop(j)
        cell[where(a)].discard(i)
        cell[where(b)].discard(j)
        w = a["w"] + b["w"]
        groups[nxt] = {"carrier": a["carrier"], "sites": sorted(a["sites"] + b["sites"], key=lambda s: (-s["samples"], s["key"])), "w": w,
                       "lat": (a["lat"] * a["w"] + b["lat"] * b["w"]) / w, "lon": (a["lon"] * a["w"] + b["lon"] * b["w"]) / w}
        cell.setdefault(where(groups[nxt]), set()).add(nxt)
        near(nxt)
        nxt += 1
    return sorted(groups.values(), key=lambda g: (g["carrier"], g["sites"][0]["key"]))


def estimate_towers(unmatched, b_lat, b_lon, P=PARAMS):
    """Sites that didn't snap: estimated towers, each with its uncertainty bubble. A carrier's estimates within 250 m are one
    (estimate_groups), its sigma worked out again over every cell the crowd placed in it."""
    groups = estimate_groups(unmatched, P)
    out = []
    for g in groups:
        allc = [c for s in g["sites"] for c in s["cells"] if _placed(c)] or [c for s in g["sites"] for c in s["cells"]]
        exact = all(s["exact"] for s in g["sites"])
        samples = sum(s["samples"] for s in g["sites"])
        spread = math.sqrt(sum(_m(g["lat"], g["lon"], c["lat"], c["lon"]) ** 2 for c in allc) / len(allc))
        sigma = P["sigma_exact_m"] if exact else min(P["sigma_max_m"], max(P["sigma_min_m"], P["sigma_base_m"] + P["sigma_samples_m"] / math.sqrt(samples)
                                                                         + P["sigma_spread"] * spread))
        t = _new_tower(f"est:{g['sites'][0]['key']}", "estimated", g["lat"], g["lon"], b_lat, b_lon)
        t.update(uncertainty_m=round(sigma), type="unknown: estimated from crowd cells")
        names = {}
        for s in g["sites"]:
            for c in s["candidates"]:
                names.setdefault(c["id"], c)
        t["candidates"] = sorted(names.values(), key=lambda c: -c["score"])[:4]
        for s in g["sites"]:
            add_site(t, s, P)
        out.append(t)
    return out


LEGACY_WHY = "2G/3G cells heard here before those networks shut down"


def add_legacy(placed, legacy, P=PARAMS):
    """2G, 3G and CDMA cells as evidence only: each joins the nearest tower its carrier's LTE or NR already placed, within its
    reach (min(2 sigma, 2 km)), as old cells there, never as a technology on the air or a tower of its own. Returns how many
    joined one."""
    g = _grid(placed, 0.02)
    n = 0
    for s in legacy:
        reach = min(P["match_sigmas"] * s["sigma"], P["match_max_m"])
        k = (math.floor(s["lat"] / 0.02), math.floor(s["lon"] / 0.02))
        nx = math.ceil(reach / (0.02 * 111000 * max(0.05, math.cos(math.radians(abs(s["lat"]) + reach / 111000))))) + 1
        best, bd = None, reach
        for dy in (-1, 0, 1):
            for dx in range(-nx, nx + 1):
                for t in g.get((k[0] + dy, k[1] + dx), []):
                    if s["carrier"] in t["carriers"]:
                        d = _m(s["lat"], s["lon"], t["lat"], t["lon"])
                        if d <= bd:
                            best, bd = t, d
        if best is None:
            continue
        e = best["carriers"][s["carrier"]]
        e["evidence"].add(LEGACY_WHY)
        x = e.setdefault("legacy", {}).setdefault(s["radio"], {"radio": s["radio"], "cells": 0, "last": None})
        x["cells"] += len(s["cells"])
        x["last"] = max(v for v in (x["last"], s["last"]) if v) if (x["last"] or s["last"]) else None
        n += 1
    return n


def confidence(t, e, now_s, P=PARAMS):
    """How sure the report is that this carrier is on this tower, there: High, Medium or Low, with the reason."""
    why, level = [], "Medium"
    sites = e["sites"]
    best = max(sites, key=lambda s: s["samples"]) if sites else None
    rc = recency(e["last"], now_s, P) if sites else None
    if t["kind"] == "estimated":
        level = "Low"
        why.append(f"estimated from {sum(len(s['cells']) for s in sites)} crowd cells, give or take {t['uncertainty_m']} m")
        if t["candidates"]:
            why.append("could be " + ", ".join(c["id"] for c in t["candidates"]))
    elif "800 MHz licence" in e["evidence"]:
        level = "High"
        why.append("an 800 MHz cellular licence is filed at this spot")
    elif best:
        m = best["match"] or {}
        ratio = m.get("ratio")
        clear = ratio is None or ratio >= P["high_ratio"]
        what = {"registered": "an FCC registered structure", "mapped": "a mast mapped in OpenStreetMap", "licensed": "a licensed site",
                "cluster": "a spot with land-mobile licences"}[t["kind"]]
        why.append(f"{e['carrier']} {best['site_kind']} {best['site_id']} ({best['samples']} sample{'s' if best['samples'] != 1 else ''}) matched to {what}"
                   + (" with nothing else in reach" if ratio is None else f", {ratio:.1f}x the next candidate")
                   + (", beside the carrier's own site there" if m.get("attached") else ""))
        strong = max((mm["weight"] for mm in t.get("_members", [])), default=1.0) >= P["high_weight"]
        if best["samples"] >= P["high_samples"] and clear and rc == 1.0 and strong and t["kind"] != "cluster":
            level = "High"
    else:
        why.append("a microwave licence of the carrier ends here")
    if sites and rc is not None and rc < 1.0:
        why.append(f"last seen {e['last'] or 'at an unknown date'}")
        if rc <= P["recency_old"] and level != "Low":
            level = "Low" if level == "Medium" else "Medium"
    return {"level": level, "why": "; ".join(why)}


def sectors(t, e, P=PARAMS):
    """The carrier's sectors on this tower: as filed (800 MHz azimuths), else from crowd bearings (3+ samples)."""
    to_site = (t["bearing"] + 180) % 360
    filed = sorted({a for lic in t["licences"] if lic["carrier"] == e["carrier"] for a in lic.get("azimuths") or []})
    if filed:
        return [{"az": a, "from": "filed (800 MHz licence)", "faces_site": _angle(a, to_site) <= P["faces_deg"]} for a in filed]
    by = {}  # each site numbers its own sectors: sector 1 of T-Mobile's eNB and of an ex-Sprint eNB on one tower are two (review 11/10)
    for s in e["sites"]:
        for c in s["cells"]:
            if c["az_est"] is not None:
                by.setdefault((s["radio"], f"{s['site_kind']} {s['site_id']}", c["sector"]), []).append(c["az_est"])
    out = []
    for (radio, site, sec), azs in sorted(by.items(), key=lambda kv: (kv[0][0], kv[0][1], str(kv[0][2]))):
        x = sum(math.sin(math.radians(a)) for a in azs)
        y = sum(math.cos(math.radians(a)) for a in azs)
        az = round(math.degrees(math.atan2(x, y))) % 360
        out.append({"az": az, "sector": sec, "site": site, "radio": radio, "from": "crowd bearing (an estimate)", "faces_site": _angle(az, to_site) <= P["faces_deg"]})
    return out


def bands(t, e, spec, memo=None):
    """The bands this carrier's cells were heard on here (channel -> band), and the ones it's licensed for in the county. The
    licensed list is the same on every tower (the carrier, its radios and the county's blocks), so a report works it out
    once (memo): it walked every block of the county again for each tower, about half a dense 20 mi report (review 11/10)."""
    heard = {}
    for s in e["sites"]:
        for c in s["cells"]:
            b = c.get("band")
            if b:
                x = heard.setdefault(b["band"], {"band": b["band"], "tech": b["tech"], "dl_mhz": [], "channels": [], "also": b["also"], "note": b["note"]})
                if b["chan"] not in x["channels"]:
                    x["channels"].append(b["chan"])
                    x["dl_mhz"].append(b["dl_mhz"])
    radios = sorted(e["techs"] & {"LTE", "NR"}) or ["LTE", "NR"]
    memo = {} if memo is None else memo
    key = (id(spec), e["carrier"], tuple(radios))
    if key not in memo:
        lic = []
        if spec and not spec.get("empty"):
            names = sorted({b for r in radios for b in cells.bands_of({"licensed": cellspec.licensed_for(spec, e["carrier"], r)})}, key=cells._band_order)
            lic = [{"band": b, "how": "county licence"} for b in names]
        memo[key] = lic + [dict(x) for x in NATIONWIDE.get(e["carrier"], []) if not any(y["band"] == x["band"] for y in lic)]
    lic = [dict(x) for x in memo[key]]
    return {"heard": sorted(heard.values(), key=lambda x: cells._band_order(x["band"])), "licensed": lic,
            "licensed_where": (spec or {}).get("county")}


def site_stale(s, now_s, P=PARAMS):
    """A crowd site that may be gone: ex-Sprint (Sprint's LTE and 5G were off by 6/30/2022, so any such reading is over 3
    years old whatever OpenCelliD's API dates it: its getInArea rows carry no date at all), or last heard over stale_days
    ago. A site with no date has an unknown age, not an old one (a top-up's rows): it isn't stale (review 11/10 round 2); nor
    is one with a cell the crowd has no date for, whatever its other cells' dates (round 3: a live eNB's two new sectors
    from a top-up beside one the country file dated 2021 read stale, and so did a top-up's eNB with one old walk of yours)."""
    if s.get("ex_sprint"):
        return True
    if s.get("crowd_undated"):
        return False
    age = age_days(s["last"], now_s) if s.get("last") else None
    return age is not None and age >= P["stale_days"]


def stale(e, now_s, P=PARAMS):
    """A carrier's entry rests only on sites that may be gone (site_stale), with no filing of its own here: like Sprint's
    LTE, off since 6/2022 and mostly taken down, which still gave T-Mobile "in reach" (review 11/10). Every site has to be
    stale: a live eNB from a top-up (no date) on a tower with an old dated one left the tower out of the verdict (round 2)."""
    filed = bool(set(e["evidence"]) & {"800 MHz licence", "microwave licence"})
    if filed or not e["sites"]:
        return False
    return all(site_stale(s, now_s, P) for s in e["sites"])


def finish(t, spec, now_s, P=PARAMS, memo=None):
    """A tower ready to answer with: each carrier's entry completed, sets as lists, sources and confidence."""
    out = []
    for c, e in sorted(t["carriers"].items()):
        e["sectors"] = sectors(t, e, P)
        e["bands"] = bands(t, e, spec, memo)
        e["confidence"] = confidence(t, e, now_s, P)
        e["stale"] = stale(e, now_s, P)
        e["techs"] = sorted(e["techs"]) or (["licensed"] if e["evidence"] else [])
        e["evidence"] = sorted(e["evidence"])
        e["legacy"] = sorted((e.get("legacy") or {}).values(), key=lambda x: x["radio"])  # old cells, not technologies on the air
        e["site_ids"] = [f"{s['site_kind']} {s['site_id']}" for s in e["sites"]]
        if e["firstnet"]:
            e["note"] = "FirstNet (313-100) cells on AT&T's site: Band 14"
        if e["ex_sprint"]:
            e["note"] = "ex-Sprint cells (310-120 and kin), now T-Mobile's: check they're still on the air"
        out.append(e)
    t["carriers"] = out
    t["carrier_names"] = [e["carrier"] for e in out]
    t["stale_for"] = [e["carrier"] for e in out if e["stale"]]  # carriers here only on readings over 3 years old
    crowd = sorted({x for e in out for s in e["sites"] for x in s["sources"]})
    if crowd:
        last = max((e["last"] for e in out if e["last"]), default=None)
        t["sources"].append({"name": "Crowd cells: " + ", ".join(crowd), "what": "which carriers and technologies are here",
                             "date": last, "url": t["links"]["opencellid"], "licence": "OpenCelliD: CC BY-SA 4.0" + ("; WiGLE: non-commercial" if "WiGLE" in crowd else "")})
    t["sources"].append({"name": "CellMapper (look only)", "what": "to compare by eye; DAStastic never reads it", "date": None, "url": t["links"]["cellmapper"], "licence": None})
    levels = [e["confidence"]["level"] for e in out]
    t["confidence"] = next((lv for lv in ("High", "Medium", "Low") if lv in levels), "Low") if levels else "Low"
    t.pop("_members", None)
    return t


# ---------------------------------------------------------------- the report

def _dates(con):
    out = {}
    try:
        meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
    except sqlite3.Error:
        meta = {}
    out["asr"] = (meta.get("uls_asof:r_tower.zip") or meta.get("towers_built_at") or "")[:10] or None
    out["uls"] = (meta.get("built_at") or "")[:10] or None
    return out


def gnb_split(cs, bits, plmns=None):
    """NR cells' site IDs and sectors at a gNB ID of `bits` (22 to 32, 38.413) where cells.decode splits at 24: at 26 bits
    gNBs 4000-4003 were all "gNB 1000", one site averaged over four towers (review 11/10 round 2). plmns: the network codes
    the length is one carrier's; every other carrier's cells keep the 24-bit split the report uses (round 3: Verizon's
    22-bit lookup merged T-Mobile's four 24-bit gNBs round it into one site that snapped onto Verizon's tower)."""
    if bits != 24:
        for c in cs:
            if c["radio"] == "NR" and (plmns is None or c["plmn"] in plmns):
                cid = int(c["cid"])
                c.update(site_id=cid >> (36 - bits), sector=cid & ((1 << (36 - bits)) - 1), site_kind=f"gNB ({bits}-bit split)")
    return cs


def fuse(con, crowd, lat, lon, radius_mi, spec=None, now_s=None, P=PARAMS, mission=None, memo=None, gnb_bits=24, gnb_plmns=None):
    """Every tower within radius_mi of the building, nearest first, and what went into them. memo: the licensed bands,
    shared across a report's runs (bands). gnb_bits: the gNB ID length gnb_plmns' NR cells are split at (gnb_split)."""
    memo = {} if memo is None else memo
    now_s = now_s or time.time()
    lim = radius_mi * geo.MI_KM
    # cells to struct_margin_km past the radius, so a site near the edge is built from all its cells: from only the ones
    # inside, a rooftop 5.2 mi out whose three sectors sit 500 m round it was an estimate at 4.89 mi with a 245 m bubble, and
    # counted as AT&T's third (review 11/10 round 2). A site whose centre is within site_margin_km of the radius is matched
    # (its tower may be inside); the towers are kept by their own distance below
    allc = gnb_split(cells.gather(con, crowd, lat, lon, radius_mi + P["struct_margin_km"] / geo.MI_KM, mission), gnb_bits, gnb_plmns)
    cs = [c for c in allc if c["dist_mi"] * geo.MI_KM <= lim]
    sites, legacy, heard = [], [], []
    for k, v in cells.group(allc, fold=True).items():
        if not any(_placed(c) for c in v):
            if any(c["dist_mi"] * geo.MI_KM <= lim for c in v):
                heard.append(heard_only(k, v))  # only your own readings: not placed
            continue
        s = make_site(k, v, P)
        if geo.haversine_km(lat, lon, s["lat"], s["lon"]) <= lim + P["site_margin_km"]:
            (sites if s["radio"] in P["placing_radios"] else legacy).append(s)
        else:  # placed past the edge: what you heard of it here is still named (round 3: a walk's 30 readings of it vanished)
            mine = [c for c in v if c.get("survey") and c["dist_mi"] * geo.MI_KM <= lim]
            if mine:
                heard.append(heard_only(k, mine))
    # every candidate of a site kept (match_max_m round it) is among the structures
    structs = merge(structure_points(con, crowd, lat, lon, lim + max(P["struct_margin_km"], P["site_margin_km"] + P["match_max_m"] / 1000.0), P), P)
    match(sites, structs, now_s, P)
    dates = _dates(con)
    attach_to_own(sites, structs, now_s, P)
    towers, unmatched = {}, []
    for s in sites:
        st = (s.get("match") or {}).get("struct")
        if st is None:
            unmatched.append(s)
            continue
        t = towers.get(st["id"])
        if t is None:
            t = towers[st["id"]] = struct_tower(st, lat, lon, dates)
            t["_members"] = st["members"]
        add_site(t, s, P)
    for st in structs:  # a carrier's own filing puts it on a structure no crowd site matched
        if st["licensed_carriers"] and st["id"] not in towers:
            t = towers[st["id"]] = struct_tower(st, lat, lon, dates)
            t["_members"] = st["members"]
    placed = list(towers.values()) + estimate_towers(unmatched, lat, lon, P)
    old = add_legacy(placed, legacy, P)
    out = [finish(t, spec, now_s, P, memo) for t in placed]
    out = sorted((t for t in out if t["dist_km"] <= lim + 1e-9 and t["carriers"]), key=lambda t: t["dist_km"])
    unknown = sorted((st for st in structs if st["id"] not in towers and st["kind"] in ("registered", "mapped")
                      and geo.haversine_km(lat, lon, st["lat"], st["lon"]) <= min(lim, P["unknown_within_mi"] * geo.MI_KM)),
                     key=lambda st: geo.haversine_km(lat, lon, st["lat"], st["lon"]))[:P["unknown_max"]]
    others = []
    for st in unknown:
        t = finish(struct_tower(st, lat, lon, dates), spec, now_s, P, memo)
        t["confidence"] = None
        others.append(t)
    return {"towers": out, "others": others, "sites": len(sites), "structures": len(structs), "cells": len(cs),
            "legacy": {"cells": len(legacy), "on_towers": old}, "heard_only": heard, "wigle": any("WiGLE" in c["sources"] for c in allc)}


def verdict(carrier, nearest_mi, far_mi, P=PARAMS, stale=None, reach_mi=None, crowd_here=False, topup_due=True, kept_states=False):
    """The verdict on a carrier's nearest current tower. stale: its nearest tower known only from sites that may be gone
    ({"dist_mi", "last", "ex_sprint"}), named when nearer, never the verdict's distance (review 11/10: a dead ex-Sprint site
    0.37 mi out read "in reach" where T-Mobile's live one was 7 mi). reach_mi: how far this copy's crowd cells reach from
    here (cells.crowd_reach_km; None: no limit known). Past it a nearer tower may be missing, so "none", "far" or "marginal"
    would be a guess: a copy whose cells came only from a 3 mi top-up read "No T-Mobile tower found within 20 mi" with one
    6 mi out (review 11/10). It's "unknown" only where a nearer tower could change the level: a tower under reach_mi is in
    reach whatever lies nearer (round 2: Verizon's own filing 0.37 mi out, and every Midtown carrier at 0.1 mi, read
    "unknown"). The level is decided on the distance as printed: 4.97 mi read "5.0 mi: in reach" beside "5.0 mi: marginal"
    (round 2). crowd_here: OpenCelliD has cells round here, so a reach of 0 says they didn't come in as a whole area, not
    that there are none; topup_due: cells.topup_due's answer, so a top-up is offered only where one would run, and only for
    what it can settle: it reaches 3 mi at most, so past that only the country file can (round 3: a copy whose files were
    kept to some states read "a top-up ... adds them" for a 7 mi tower, and the top-up settled nothing). kept_states: this
    copy's OpenCelliD files were kept to some states, said where it explains the reach."""
    roof = f"A roof reading decides (−{-P['roof_dbm'][0]}/−{-P['roof_dbm'][1]} dBm)."
    top = P["radius_steps_mi"][-1]
    fmt = lambda x: f"{x:.2f}" if x < 1 else f"{x:.1f}"  # noqa: E731
    old = ""
    if stale and (nearest_mi is None or stale["dist_mi"] < nearest_mi):
        last = str(stale.get("last") or "")[:10]
        old = (f" A nearer {carrier} site, {fmt(stale['dist_mi'])} mi, is ex-Sprint only" + (f", last heard {last}" if last else "")
               + " (Sprint's LTE has been off since 6/2022): check it's still on the air." if stale.get("ex_sprint") else
               f" A nearer {carrier} site, {fmt(stale['dist_mi'])} mi, was last heard {last or 'long ago'}: check it's still on the air.")
    x = None if nearest_mi is None else float(fmt(nearest_mi))  # the distance as the text prints it
    if reach_mi is None or reach_mi >= top:
        open_ = False
    elif x is None:
        open_ = True
    elif x < P["reach_mi"]:
        open_ = False  # in reach: a nearer tower would only be nearer
    elif x <= far_mi:
        open_ = reach_mi < P["reach_mi"]  # marginal: only a tower under reach_mi changes it
    else:
        open_ = reach_mi < far_mi  # far: a tower within far_mi changes it
    if open_:
        kept = " (its OpenCelliD files were kept to some states)" if kept_states else ""
        reach = (f"this copy's crowd cells reach only {fmt(reach_mi)} mi from here{kept}" if reach_mi >= 0.05 else
                 "this copy's OpenCelliD files were kept to some states, so its cells here aren't known as a whole area" if kept_states and crowd_here else
                 "this copy's crowd cells round here didn't come in as a whole area" if crowd_here else
                 "this copy has no crowd cells round here")
        whole = "OpenCelliD's country file, loaded with no state limit"
        top = cells.FETCH_RADIUS_MI
        more = (f" (a top-up looks for one to {top:g} mi; past that only {whole}, can say)." if topup_due and reach_mi < top else
                f" (only {whole}, can say).")
        text = (f"No {carrier} tower known: {reach}, so a nearer one isn't known{more}" if x is None else
                f"Closest {carrier} found {fmt(nearest_mi)} mi, but {reach}: a nearer one isn't known{more}")
        return {"level": "unknown", "nearest_mi": nearest_mi, "reach_mi": reach_mi, "text": f"{text}{old} {roof}"}
    if x is None:
        return {"level": "none", "nearest_mi": None, "text": f"No {'current ' if old else ''}{carrier} tower found within {top:g} mi.{old} {roof}"}
    d = fmt(nearest_mi)
    if x > far_mi:
        return {"level": "far", "nearest_mi": nearest_mi, "text": f"Closest {carrier} {d} mi: far, off-air BDA not recommended.{old} {roof}"}
    if x >= P["reach_mi"]:
        return {"level": "marginal", "nearest_mi": nearest_mi, "text": f"Closest {carrier} {d} mi: marginal.{old} {roof}"}
    return {"level": "in reach", "nearest_mi": nearest_mi, "text": f"Closest {carrier} {d} mi: in reach.{old} {roof}"}


def county_spec(con, lat, lon, data_dir):
    """The county's carrier blocks (spectrum.py), with no network call: the county from boundaries already kept, else the
    nearest county in the FCC data."""
    import ahj
    import spectrum

    def no_net(url):
        raise OSError("the tower report makes no network calls")
    try:
        place = ahj.place_of(lat, lon, data_dir, fetch=no_net) or {}
        return spectrum.at(lat, lon, data_dir, con, place=place)
    except Exception as e:  # the report still answers without the blocks
        return {"empty": True, "why": f"Carrier spectrum couldn't be read here: {e}"}


OSM_LINE = ATTRIBUTION_LINES[1]  # where a link can't be followed (paper, a CSV) the licence and the copyright page are named in full


def attribution(wigle=False):
    """The credit lines for a tower answer: OpenStreetMap's only where this build reads its towers (build.PERSONAL_ONLY), so
    a sold copy's answers never say they hold OSM data."""
    lines = [x for x in ATTRIBUTION_LINES if x != OSM_LINE or build.allowed(osmtowers.SOURCE)] + ([WIGLE_LINE] if wigle else [])
    return " ".join(lines), lines


def _theirs(t, c):
    return next(e for e in t["carriers"] if e["carrier"] == c)


def report(con, crowd, lat, lon, radius_mi=None, carriers=None, n=None, far_mi=None, spec=None, data_dir=None, now_s=None, P=PARAMS):
    """The tower report for a building: per carrier, the n nearest current towers carrying it and a verdict, the stale ones
    after them; every tower in the area for the map. No network calls. A carrier's tower known only from readings over
    stale_days old is listed apart (stale_towers) and never counts toward n or the verdict. The area asked for runs first;
    while a carrier has fewer than n current towers, one more run at the widest step answers for every carrier still short,
    each with the smallest step holding its n (it re-ran the engine at every step and kept every run, review 11/10)."""
    P = dict(P)
    now_s = now_s or time.time()
    n = int(n or P["n"])
    far_mi = float(far_mi if far_mi is not None else P["far_mi"])
    radius_mi = float(radius_mi or P["radius_steps_mi"][0])
    want = wanted(carriers)
    if spec is None and data_dir:
        spec = county_spec(con, lat, lon, data_dir)
    steps = sorted({radius_mi} | {float(r) for r in P["radius_steps_mi"] if r > radius_mi})
    memo, per = {}, {}

    def split(run, c):
        mine = [t for t in run["towers"] if c in t["carrier_names"]]
        return [t for t in mine if not _theirs(t, c)["stale"]], [t for t in mine if _theirs(t, c)["stale"]]

    first = fuse(con, crowd, lat, lon, steps[0], spec, now_s, P, memo=memo)
    runs, wigle = [steps[0]], first["wigle"]
    for c in want:
        cur, old = split(first, c)
        if len(cur) >= n or len(steps) == 1:
            per[c] = (steps[0], cur[:n], old[:n])
    if len(per) < len(want):
        wide = fuse(con, crowd, lat, lon, steps[-1], spec, now_s, P, memo=memo)
        runs.append(steps[-1])
        wigle = wigle or wide["wigle"]
        for c in want:
            if c in per:
                continue
            cur, old = split(wide, c)
            r = next((x for x in steps[1:] if sum(1 for t in cur if t["dist_km"] <= x * geo.MI_KM + 1e-9) >= n), steps[-1])
            within = lambda ts: [t for t in ts if t["dist_km"] <= r * geo.MI_KM + 1e-9]  # noqa: E731
            per[c] = (r, within(cur)[:n], within(old)[:n])
    text, lines = attribution(wigle)
    reach_km = cells.crowd_reach_km(crowd, lat, lon)
    reach_mi = None if reach_km is None else round(reach_km / geo.MI_KM, 2)
    due = cells.topup_due(crowd, lat, lon)
    here = reach_mi is not None and reach_mi < 0.05 and cells.has_cells_near(crowd, lat, lon)
    kept = reach_mi is not None and any(states for _at, _kind, states, _n in cells._imports(crowd))
    out_carriers = []
    for c in want:
        r, ts, old = per[c]
        st = {"dist_mi": old[0]["dist_mi"], "last": _theirs(old[0], c)["last"],
              "ex_sprint": all(x.get("ex_sprint") for x in _theirs(old[0], c)["sites"])} if old else None
        out_carriers.append({"carrier": c, "searched_mi": r, "towers": ts, "stale_towers": old,
                             "verdict": verdict(c, ts[0]["dist_mi"] if ts else None, far_mi, P, stale=st, reach_mi=reach_mi,
                                                        crowd_here=here, topup_due=due["due"], kept_states=kept),
                             "heard_only": [h for h in first["heard_only"] if h["carrier"] == c]})
    compact = lambda t: {k: t[k] for k in ("id", "kind", "lat", "lon", "dist_mi", "dist_km", "bearing", "compass", "uncertainty_m", "type",  # noqa: E731
                                           "height_ft", "owner", "carrier_names", "stale_for", "confidence")}
    area = first["towers"][:P["towers_max"]]
    return {"lat": lat, "lon": lon, "params_version": PARAMS_VERSION, "radius_mi": radius_mi, "searched_mi": [x for x in steps if x <= max(runs)],
            "n": n, "far_mi": far_mi,
            "carriers": out_carriers, "towers": [compact(t) for t in area], "other_structures": [compact(t) for t in first["others"]],
            "counts": {"cells": first["cells"], "sites": first["sites"], "structures": first["structures"], "towers": len(first["towers"]),
                       "estimated": sum(1 for t in first["towers"] if t["kind"] == "estimated"), "legacy_cells": first["legacy"]["cells"],
                       "legacy_on_towers": first["legacy"]["on_towers"], "heard_only": len(first["heard_only"]), "runs": len(runs)},
            "licensed_where": (spec or {}).get("county"), "licensed_note": (spec or {}).get("why") if (spec or {}).get("empty") else
            "Licensed, not measured: the bands each carrier holds in the county (FCC market licences); which are on the air at a tower only a scan says.",
            "crowd_reach_mi": reach_mi, "stale_days": P["stale_days"], "topup": due, "attribution": text, "attribution_lines": lines}


# ---------------------------------------------------------------- one site by its ID (eNB / gNB)

def _id_patterns(lo, hi):
    """LIKE patterns for every cell ID from lo to hi, split by number of digits: a common prefix and the rest as wildcards.
    A cheap first filter only: a range that crosses a digit gives wildcards, so the ID is compared as a number too (_cid_sql)."""
    out, a = [], lo
    while a <= hi:
        b = min(hi, 10 ** len(str(a)) - 1)
        sa, sb = str(a), str(b)
        k = 0
        while k < len(sa) and sa[k] == sb[k]:
            k += 1
        out.append(sa[:k] + "_" * (len(sa) - k))
        a = b + 1
    return out


def _cid_sql(col, pats):
    """SQL for "the cell ID at the end of col is from ? to ?": the LIKE patterns first (cheap), then the ID's trailing digits
    as a number ("310-410-12345-207994113", "cell:310410_7_207994113"). Args: the patterns' two forms each, then lo and hi."""
    likes = " OR ".join([f"{col} LIKE ? ESCAPE '\\'"] * (2 * len(pats)))
    return f"({likes}) AND CAST(substr({col}, length(rtrim({col}, '0123456789')) + 1) AS INTEGER) BETWEEN ? AND ?"


def _cid_args(pats, lo, hi):
    return [x for p in pats for x in (f"%-{p}", f"%\\_{p}")] + [lo, hi]


def _id_ok(ident, kind, radio, plmns, lo, hi):
    """A crowd or capture row is one of the site's cells: its radio (when it says one), network code and cell ID in range.
    Checked before a row's details are decoded (review 11/10: a small ID decoded 45% of the crowd database to find nothing)."""
    p = cells.parse_id(ident)
    if not p or not (lo <= p[3] <= hi) or (kind or "").upper() not in (radio, ""):
        return False
    mcc, mnc = p[0], p[1]
    return f"{mcc}-{int(mnc):03d}" in plmns


def site_by_id(con, crowd, q, carrier="AT&T", radio="LTE", gnb_bits=24, now_s=None, P=PARAMS):
    """A carrier's eNB (or gNB) by number, wherever the crowd has it: every cell ID in its range (eNB x 256 to +255; a gNB's
    NCI >> 12 by default, a 24-bit gNB ID) across the carrier's network codes, grouped into sites, each with the tower the
    report puts it on. Andy reads eNB numbers off CellMapper (Monroe: 812442)."""
    # one number, maybe after "eNB" or "gNB", maybe in groups of three ("812,442", "812 442"): it took the first run of
    # digits, so "812,442" answered for eNB 812, another site's tower 15 km off, with no error (review 11/10 round 2)
    m = re.fullmatch(r"\s*(?:[eg]nb\s*#?\s*)?(\d{1,3}(?:([,. ])\d{3})(?:\2\d{3})*|\d+)\s*", str(q or ""), re.I)
    if not m:
        raise ValueError("Give one eNB or gNB number, like 812442.")
    sid = int(re.sub(r"[,. ]", "", m.group(1)))
    carrier = wanted([carrier])[0] if carrier else "AT&T"
    radio = "NR" if str(radio or "").upper() in ("NR", "5G", "GNB") else "LTE"
    bits = 20 if radio == "LTE" else int(gnb_bits)  # an eNB ID is 20 bits (36.413); a gNB ID 22 to 32 (38.413)
    if not 1 <= sid < (1 << bits):
        raise ValueError(f"An {'eNB' if radio == 'LTE' else 'gNB'} number runs from 1 to {(1 << bits) - 1:,}" + (f" at {bits} bits" if radio == "NR" else "") + ".")
    shift = 8 if radio == "LTE" else 36 - bits
    lo, hi = sid << shift, (sid << shift) + (1 << shift) - 1
    plmns = sorted(k for k, v in cells.OPERATORS.items() if cells.brand(v) == carrier)
    if not plmns:
        raise ValueError(f"No network codes on file for {carrier}.")
    srcs = cells.crowd_sources()
    col = cells.Collector()
    # the cell ID compared as a number in SQL, so only the IDs in range come back (the LIKE patterns alone turned a range that
    # crossed a digit into all wildcards: eNB 117187 read every 8-digit cell of every carrier, 323k rows and 553 MB, review 11/10)
    pats = _id_patterns(lo, hi)
    # source IN on purpose: the (source, ext_id) index holds every ID, so the filter runs on the index and only matches are read
    for r in crowd.execute(f"SELECT * FROM ext_point WHERE source IN ({','.join('?' * len(srcs))}) AND {_cid_sql('ext_id', pats)}",
                           (*srcs, *_cid_args(pats, lo, hi))):
        if _id_ok(r["ext_id"], r["kind"], radio, plmns, lo, hi):
            got = cells.crowd_row(r)
            if got:
                col.add(*got)
    for r in _rows(con, "SELECT p.*, c.name AS capture_name FROM capture_point p JOIN capture c ON c.id=p.capture_id WHERE "
                        + _cid_sql("p.ident", pats), _cid_args(pats, lo, hi)):
        if _id_ok(r["ident"], r["kind"], radio, plmns, lo, hi):
            col.add(*cells.capture_row(r))
    found = gnb_split([c for c in col.done() if c["radio"] == radio and c["plmn"] in plmns and lo <= int(c["cid"]) <= hi], bits if radio == "NR" else 24, plmns)
    out = []
    for key, cs in cells.group(found, fold=True).items():
        s = make_site(key, cs, P)
        near = fuse(con, crowd, s["lat"], s["lon"], max(1.0, (2 * s["sigma"] + 500) / 1609.344), None, now_s, P, gnb_bits=bits if radio == "NR" else 24, gnb_plmns=plmns)
        t = next((t for t in near["towers"] if any(x["key"] == s["key"] for e in t["carriers"] for x in e["sites"])), None)
        out.append({"key": s["key"], "carrier": s["carrier"], "radio": s["radio"], "site_kind": s["site_kind"], "site_id": s["site_id"],
                    "plmns": s["plmns"], "cells": len(cs), "samples": s["samples"], "last": s["last"], "sigma_m": s["sigma"],
                    "crowd_at": {"lat": round(s["lat"], 6), "lon": round(s["lon"], 6)},
                    "tower": {k: t[k] for k in ("id", "kind", "lat", "lon", "type", "height_ft", "owner", "registration", "osm", "uncertainty_m",
                                                "candidates", "carrier_names", "confidence", "links")} if t else None})
    text, lines = attribution(any("WiGLE" in c["sources"] for c in found))
    return {"q": str(q), "carrier": carrier, "radio": radio, "site_id": sid, "range": [lo, hi], "plmns": plmns, "params_version": PARAMS_VERSION,
            "cells": [{k: c.get(k) for k in ("gci", "plmn", "operator", "area", "cid", "sector", "pci", "lat", "lon", "samples", "last", "sources")}
                      for c in sorted(found, key=lambda c: (c["plmn"], int(c["cid"])))],
            "sites": out, "attribution": text, "attribution_lines": lines}


# ---------------------------------------------------------------- a top-up (POST): the only part that reaches the network

def topup(con, crowd, lat, lon, key, osm_on=False, osm_server=None, osm_problem=None):
    """Fresh data around an address: OpenCelliD when cells.topup_due says so and the day's budget has room, and OSM's
    towers within 8 km when the osm_towers source is switched on and this build may use it. osm_problem: why the copy's
    osm_towers.server can't be used (osmtowers.server_of), said in the OSM part, never stopping the OpenCelliD one (a
    hand-set value broke every top-up, review 11/10). Each part says what it did; one failing doesn't stop the other."""
    out = {"opencellid": None, "osm": None}
    if not key:
        out["opencellid"] = {"skipped": "This copy has no OpenCelliD key (Data & updates)."}
    else:
        try:
            out["opencellid"] = cells.fetch_near(crowd, lat, lon, key)
        except Exception as e:  # the day's share is used, or OpenCelliD refused: said, not raised
            from datadesk import clean
            out["opencellid"] = {"error": clean.scrub_text(str(e).replace(key, "(key)"))[:200]}
    if not build.allowed(osmtowers.SOURCE):
        out["osm"] = {"skipped": "OpenStreetMap towers aren't in this build: " + build.PERSONAL_ONLY[osmtowers.SOURCE]}
    elif not osm_on:
        out["osm"] = {"skipped": "OpenStreetMap towers are off on this copy (Data & updates: osm_towers)."}
    elif osm_problem:
        out["osm"] = {"skipped": f"{osm_problem}: nothing was asked of OpenStreetMap."}
    else:
        try:
            out["osm"] = osmtowers.fetch_near(crowd, lat, lon, PARAMS["osm_max_km"], con=con, server=osm_server)
        except Exception as e:  # said, as the OpenCelliD part's: an escape here lost that part's answer in a 500 (round 2)
            from datadesk import clean
            out["osm"] = {"error": clean.scrub_text(f"{type(e).__name__}: {e}")[:200]}
    out["topup"] = cells.topup_due(crowd, lat, lon)
    out["attribution"], out["attribution_lines"] = attribution()  # every tower answer carries the credits (plan 11/10, section 6)
    return out
