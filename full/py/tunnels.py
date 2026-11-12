"""
Road and rail tunnels from OpenStreetMap (R1/R3: road tunnels fall under NFPA 502 and rail transit tunnels under
NFPA 130, both of which call for emergency responder radio inside; the owner is a public agency or a railroad).

Two uses: a DAS prospect kind ("tunnel", found per area on demand, the way high-rises are) and a pre-survey flag
(tunnels at or near the job's building). Asked of the public Overpass servers all at once, the first good answer
used, like the building outlines (das.osm_outline), and kept 30 days; when no server answers, a kept answer of any
age is used.

OpenStreetMap data is ODbL (share-alike): tunnel prospects stay off the public field packs
(fieldpack.PROSPECT_SKIP_SOURCES) and carry "© OpenStreetMap contributors".
"""
import json
import math
import os
import time
import urllib.parse

import das
import geo
import uls_import

SOURCE_ID = "osm_tunnels"
ATTRIBUTION = "© OpenStreetMap contributors (ODbL, openstreetmap.org/copyright)"
LICENSE = "ODbL 1.0 (OpenStreetMap): share-alike; kept off the public field packs"
ROADS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
RAILS = "rail|subway|light_rail|tram|narrow_gauge|monorail|funicular"
MIN_M = 60  # shorter is an underpass, not a tunnel anyone fits a radio system to
KEEP_DAYS = 30
WHY = ("Road tunnels: NFPA 502. Rail and transit tunnels: NFPA 130. Both call for emergency responder radio coverage "
       "inside; which tunnels must have it depends on their length and the edition the state adopted. The owner is a "
       "public agency (state DOT, toll or transit authority) or a railroad.")


def _cache_path():
    return os.path.join(uls_import.DATA_DIR, "osm_tunnels.json")


def _cache():
    try:
        with open(_cache_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _keep(key, v):
    c = _cache()
    c[key] = {"at": time.time(), "v": v}
    if len(c) > 400:  # the oldest answers go first
        for k in sorted(c, key=lambda k: c[k]["at"])[:len(c) - 400]:
            c.pop(k)
    tmp = _cache_path() + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(c, fh)
    os.replace(tmp, _cache_path())


def query(lat, lon, radius_m):
    return (f'[out:json][timeout:60];('
            f'way(around:{int(radius_m)},{lat},{lon})["tunnel"="yes"]["highway"~"^({ROADS})$"];'
            f'way(around:{int(radius_m)},{lat},{lon})["tunnel"="yes"]["railway"~"^({RAILS})$"];'
            f');out tags geom;')


def _ask(q, ask=None):
    """The first good Overpass answer from the servers this copy may ask (das.overpass_servers: its own, else the public ones
    on the personal build only), asked at once."""
    if ask:
        return ask(q)
    servers = das.overpass_servers()
    if not servers:
        raise das.no_overpass()
    from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as Late
    errors = []
    ex = ThreadPoolExecutor(len(servers))
    jobs = {ex.submit(das._overpass, url, q): urllib.parse.urlparse(url).hostname for url in servers}  # never a login in the text
    try:
        for f in as_completed(jobs, timeout=das.OSM_WAIT_S + 5):
            try:
                d = f.result()
                if isinstance(d, dict) and "elements" in d:
                    return d
                errors.append(f"{jobs[f]}: no data in its answer")
            except (OSError, ValueError) as e:
                errors.append(f"{jobs[f]}: {e}")
    except Late:
        errors.append(f"no answer in {das.OSM_WAIT_S} s")
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    raise ValueError("OpenStreetMap's servers didn't answer (" + "; ".join(errors) + "). They're busy at times: try again in a minute.")


def _len_m(pts):
    return sum(geo.haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:])) * 1000


def group(data):
    """Overpass ways -> tunnels: the ways of one kind and name that touch or lie within 150 m of each other are one
    tunnel (twin bores, split segments). Each: name, road or rail, its class, about how long end to end, where."""
    ways = []
    for el in data.get("elements", []):
        if el.get("type") != "way" or len(el.get("geometry") or []) < 2:
            continue
        t = el.get("tags") or {}
        pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
        kind = "rail" if t.get("railway") else "road"
        ways.append({"id": el["id"], "kind": kind, "cls": t.get("railway") or t.get("highway"),
                     "name": t.get("tunnel:name") or t.get("name") or t.get("ref") or "", "operator": t.get("operator") or "",
                     "pts": pts, "len": _len_m(pts)})
    # one tunnel = the ways of one kind and name joined end to end (within 150 m: twin bores, split segments), however
    # the pieces arrive (union-find over every pair of ends)
    up = list(range(len(ways)))

    def root(i):
        while up[i] != i:
            up[i] = up[up[i]]
            i = up[i]
        return i
    same = {}
    for i, w in enumerate(ways):
        same.setdefault((w["kind"], _same(w["name"])), []).append(i)
    for idx in same.values():
        for n, i in enumerate(idx):
            for k in idx[n + 1:]:
                a, b = ways[i], ways[k]
                if min(geo.haversine_km(p[0], p[1], q[0], q[1]) for p in (a["pts"][0], a["pts"][-1]) for q in (b["pts"][0], b["pts"][-1])) <= 0.15:
                    up[root(k)] = root(i)
    by = {}
    for i, w in enumerate(ways):
        g = by.setdefault(root(i), {"kind": w["kind"], "name": w["name"], "classes": set(), "operator": "", "ways": [], "pts": [], "track_m": 0.0})
        g["ways"].append(w["id"])
        g["classes"].add(w["cls"])
        g["pts"] += w["pts"]
        g["track_m"] += w["len"]
        g["operator"] = g["operator"] or w["operator"]
    out = []
    for g in by.values():
        pts = g["pts"]
        step = max(1, len(pts) // 60)  # the end-to-end length from a sample of the points: plenty for a tunnel
        sample = pts[::step] + [pts[-1]]
        span = max(geo.haversine_km(a[0], a[1], b[0], b[1]) for a in sample for b in sample) * 1000
        if span < (MIN_M if g["name"] else 2.5 * MIN_M):  # unnamed short pieces are mostly crossovers and ramps
            continue
        lat = sum(p[0] for p in pts) / len(pts)
        lon = sum(p[1] for p in pts) / len(pts)
        cls = sorted(c for c in g["classes"] if c)
        out.append({"id": f"{SOURCE_ID}:way/{min(g['ways'])}", "name": g["name"] or f"Unnamed {g['kind']} tunnel",
                    "named": bool(g["name"]), "kind": g["kind"], "classes": cls, "operator": g["operator"],
                    "length_m": round(span), "track_m": round(g["track_m"]), "ways": len(g["ways"]), "lat": round(lat, 6), "lon": round(lon, 6),
                    "osm": f"https://www.openstreetmap.org/way/{min(g['ways'])}", "code": "NFPA 502" if g["kind"] == "road" else "NFPA 130",
                    "_pts": sample})
    return out


def _same(name):
    return " ".join((name or "").lower().replace("street", "st").replace(".", " ").split())


def near(lat, lon, radius_m=400, fresh=False, ask=None):
    """Tunnels within radius_m (at most 16 km) of a point, nearest first, each with how far its nearest part is.
    Kept 30 days per spot and radius."""
    radius_m = max(50, min(16000, int(radius_m)))
    key = f"{lat:.4f},{lon:.4f},{radius_m}"
    kept = _cache().get(key)
    if kept and not fresh and time.time() - kept["at"] < KEEP_DAYS * 86400:
        data, note = kept["v"], None
    else:
        try:
            data, note = _ask(query(lat, lon, radius_m), ask), None
            data = {"elements": [{k: e.get(k) for k in ("type", "id", "tags", "geometry")} for e in data.get("elements", [])]}
            _keep(key, data)
        except ValueError as e:
            if not kept:
                raise
            # none asked (a sold copy with no server of its own) isn't a busy server: a retry won't help (11/11 review)
            data, note = kept["v"], ("OpenStreetMap isn't asked on this copy" if isinstance(e, das.NoOverpass) else "OpenStreetMap's servers didn't answer") \
                + ": the copy kept on " + time.strftime("%Y-%m-%d", time.localtime(kept["at"]))
    out = []
    for t in group(data):
        d = min(geo.haversine_km(lat, lon, a, b) for a, b in t.pop("_pts")) * 1000
        out.append({**t, "dist_m": round(d)})
    out.sort(key=lambda t: t["dist_m"])
    return {"tunnels": out, "radius_m": radius_m, "note": note, "why": WHY, "attribution": ATTRIBUTION, "license": LICENSE}


def to_prospects(data_dir, lat, lon, radius_mi=5, ask=None):
    """Tunnels near a spot into the DAS prospect list (kind "tunnel"), replacing the ones kept for that box. Returns
    the rows kept."""
    import prospects
    radius_mi = min(10.0, max(0.25, float(radius_mi)))
    found = near(lat, lon, radius_mi * 1609.344, ask=ask)
    dlat = radius_mi / 69.0
    dlon = radius_mi / (69.0 * max(0.01, math.cos(math.radians(lat))))
    con = prospects.connect(data_dir)
    try:
        con.execute("DELETE FROM prospect WHERE source=? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                    (SOURCE_ID, lat - dlat, lat + dlat, lon - dlon, lon + dlon))
        run, updated = time.time_ns(), time.strftime("%Y-%m-%d %H:%M")
        rows = []
        for t in found["tunnels"]:
            what = f"{'Road' if t['kind'] == 'road' else 'Rail'} tunnel ({', '.join(t['classes'])})"
            rec = {"id": t["id"], "kind": "tunnel", "name": t["name"], "lat": t["lat"], "lon": t["lon"], "precision": "exact",
                   "size": t["length_m"], "size_label": f"about {t['length_m']:,} m end to end",
                   "detail": f"{what}, {t['code']}; " + (f"operator: {t['operator']}; " if t["operator"] else "")
                             + f"{t['ways']} OpenStreetMap way{'s' if t['ways'] != 1 else ''}, {t['track_m']:,} m of {'road' if t['kind'] == 'road' else 'track'} ({t['osm']}). {ATTRIBUTION}",
                   "source": SOURCE_ID, "updated": updated, "contact_name": t["operator"]}
            rows.append(tuple(rec.get(c, "" if c not in ("lat", "lon", "size") else None) for c in prospects.COLS) + (run,))
        con.executemany(prospects._INSERT, rows)
        con.commit()
    finally:
        con.close()
    prospects.SOURCES.setdefault(SOURCE_ID, {"name": "OpenStreetMap road and rail tunnels (per area)", "kind": "tunnel", "url": "overpass",
                                             "license": LICENSE, "attribution": ATTRIBUTION, "area": True})
    return len(rows)
