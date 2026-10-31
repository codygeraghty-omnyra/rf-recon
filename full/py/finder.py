"""
Search: one box over everything RF Recon holds (the Search tab, Ctrl+K), and a DAS-only search over the DAS tab's data.

Everything: places, licences (by call sign, licensee or frequency), towers, 911 call centres, broadcast, aviation,
NOAA, microwave links, your labels and talk groups, crowd and survey points, missions, DAS jobs and the DAS research.
Licensee names are found through a full-text index (lic_fts: one row per call sign), built once in the background
after each FCC update because the licence table has no name index; until it's ready, names fall back to call signs,
frequencies and the smaller tables. A place plus kind words ("Charlotte fire") also lists the licences around that
place by category, since a city's fire radios are often licensed to the city. Results come back grouped, each item
with what to show and where it is.
"""
import json
import math
import os
import re
import sqlite3
import threading
import time

import das
import geo

RESEARCH_DB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "research", "DAS-ERCES", "das_research.db")
INDEX = {"state": "idle", "error": None}
_LOCK = threading.Lock()
RESEARCH_TABLES = {  # table: (label, the columns searched / shown)
    "requirements": ("Code requirement", ("topic", "item", "value", "code", "section", "note")),
    "jurisdictions": ("Where an AHJ differs", ("ahj", "state", "item", "value")),
    "fcc_rules": ("FCC booster rule", ("item", "value", "rule")),
    "bands": ("Public safety band", ("name", "downlink_mhz", "uplink_mhz", "offset", "note")),
    "entry_loss": ("Building entry loss", ("frequency", "building_class", "median_db", "p95_db")),
    "workflow": ("Job step", ("step", "who", "data")),
    "tools": ("Industry tool", ("vendor", "product", "purpose", "screens", "workflow", "measures", "outputs", "price")),
    "bda_vendors": ("Booster vendor", ("vendor", "product", "gui")),
    "ui_patterns": ("Tool pattern", ("pattern", "seen_in")),
    "gaps": ("Gap RF Recon fills", ("gap", "rf_recon", "status")),
    "sources": ("Source", ("title", "kind", "url")),
}


def words(q):
    return [w for w in re.findall(r"[A-Za-z0-9.'-]+", q or "") if w.strip(".'-")][:8]


def like(q):
    return "%" + (q or "").replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _meta(con, k):
    try:
        r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r[0] if r else None
    except sqlite3.Error:
        return None


def index_ready(con):
    built = _meta(con, "built_at")
    return built is not None and _meta(con, "lic_fts_built") == built and \
        con.execute("SELECT 1 FROM sqlite_master WHERE name='lic_fts'").fetchone() is not None


def build_index(db_path):
    """The licensee name index: one row per active call sign. About a minute on the whole US; runs in the background."""
    with _LOCK:
        if INDEX["state"] == "building":
            return
        INDEX.update(state="building", error=None, started=time.time())

    def work():
        con = sqlite3.connect(db_path, timeout=120)
        try:
            built = _meta(con, "built_at")
            con.executescript("""DROP TABLE IF EXISTS lic_fts;
                CREATE VIRTUAL TABLE lic_fts USING fts5(licensee, call_sign UNINDEXED, service UNINDEXED, state UNINDEXED,
                    city UNINDEXED, n UNINDEXED, lat UNINDEXED, lon UNINDEXED, tokenize="unicode61 remove_diacritics 2");""")
            con.execute("""INSERT INTO lic_fts SELECT MAX(licensee), call_sign, MAX(service_name), MAX(state), MAX(city), COUNT(*),
                           MAX(lat), MAX(lon) FROM tx WHERE status='A' AND licensee IS NOT NULL GROUP BY call_sign""")
            con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('lic_fts_built', ?)", (built,))
            con.commit()
            INDEX.update(state="ready", took_s=round(time.time() - INDEX["started"]))
        except sqlite3.Error as e:
            INDEX.update(state="error", error=str(e))
        finally:
            con.close()
    threading.Thread(target=work, daemon=True).start()


def _dist(lat, lon, r):
    if lat is None or r.get("lat") is None:
        return None
    return round(geo.haversine_km(lat, lon, r["lat"], r["lon"]) / geo.MI_KM, 1)


def _freq(q):
    m = re.fullmatch(r"\s*(\d{1,5}(?:\.\d{1,6})?)\s*(mhz)?\s*", q or "", re.I)
    return float(m.group(1)) if m and ("." in m.group(1) or m.group(2)) else None


# "Charlotte fire", "fire Charlotte NC", "Arlington schools": a place plus kind words. Shared city and county systems
# (Public Safety (Gov)) carry fire, police and EMS too, so they come second.
SHARED = ("Public Safety (Gov)",)
KIND_WORDS = {
    "fire": ("Fire / EMS",) + SHARED, "ems": ("Fire / EMS",) + SHARED, "rescue": ("Fire / EMS",) + SHARED, "ambulance": ("Fire / EMS", "Hospital / Medical"),
    "police": ("Law Enforcement",) + SHARED, "sheriff": ("Law Enforcement",) + SHARED, "law": ("Law Enforcement",),
    "911": ("Emergency Mgmt / 911",) + SHARED, "dispatch": ("Emergency Mgmt / 911",) + SHARED, "emergency": ("Emergency Mgmt / 911", "Fire / EMS"),
    "safety": ("Public Safety (Gov)", "Public Safety (Other)"), "hospital": ("Hospital / Medical",), "medical": ("Hospital / Medical",),
    "school": ("Schools",), "schools": ("Schools",), "utility": ("Utilities",), "utilities": ("Utilities",), "power": ("Utilities",),
    "electric": ("Utilities",), "water": ("Utilities",), "gas": ("Utilities",), "transit": ("Transportation",), "bus": ("Transportation",),
    "rail": ("Transportation",), "railroad": ("Transportation",), "transportation": ("Transportation",), "government": ("Local / State Gov",),
    "marine": ("Marine",), "paging": ("Paging",), "aviation": ("Aviation",), "airport": ("Aviation",), "business": ("Business / Industrial",),
}


STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD "
              "TN TX UT VT VA WA WV WI WY PR GU VI AS MP".split())


def _town_kind(con, ws, lat, lon):
    """Split the words into a place (a state code may follow it) and the rest. Longest place name first.
    Returns (place row, rest words) or None."""
    up = [w.upper() for w in ws]
    for k in range(len(up) - 1, 0, -1):
        for i in range(len(up) - k + 1):
            name, state, after = up[i:i + k], None, i + k
            if all(w.lower() in KIND_WORDS for w in name):
                continue
            if after < len(up) and up[after] in STATES and len(up) - k > 1:
                state, after = up[after], after + 1
            rest = up[:i] + up[after:]
            if not any(w.lower() in KIND_WORDS for w in rest):
                continue
            try:
                found = [dict(r) for r in con.execute("SELECT * FROM place WHERE name = ? COLLATE NOCASE" + (" AND state = ?" if state else "") +
                                                      " ORDER BY n DESC LIMIT 20", (" ".join(name),) + ((state,) if state else ()))]
            except sqlite3.Error:
                return None
            if found:
                if lat is not None:
                    found.sort(key=lambda r: geo.haversine_km(lat, lon, r["lat"], r["lon"]))
                return found[0], [w.lower() for w in rest]
    return None


def _lic(r, **kw):
    return {"kind": "licence", "title": r["licensee"] or r["call_sign"], "call_sign": r["call_sign"], "service": r["service"] or "",
            "category": r["category"] if "category" in r.keys() else "", "sites": r["sites"] if "sites" in r.keys() else None,
            "where": ", ".join(x for x in (r["city"], r["state"]) if x), "lat": r["lat"], "lon": r["lon"], **kw}


def _by_licensee(items):
    """One row per licensee (in the order given, so the best-ranked or nearest call sign leads), listing its call signs."""
    out, by = [], {}
    for it in items:
        k = re.sub(r"[^a-z0-9]", "", (it["title"] or "").lower())
        if k in by:
            m = by[k]
            m["call_signs"].append(it["call_sign"])
            m["sites"] = (m["sites"] or 0) + (it["sites"] or 0) if it["sites"] is not None else m["sites"]
            m["rank"] = min(m.get("rank", 1), it.get("rank", 1))
            continue
        by[k] = it
        it["call_signs"] = [it["call_sign"]]
        out.append(it)
    for it in out:
        cs, s = it["call_signs"], it.pop("sites")
        it["sub"] = f"{cs[0]} · {it['service']}" if len(cs) == 1 else f"{len(cs)} call signs · {it['service']}"
        it["facts"] = [it.pop("category"), f"{s} site{'s' * (s != 1)}" if s else "", it.pop("where"),
                       "" if len(cs) == 1 else ", ".join(cs[:6]) + (f" +{len(cs) - 6} more" if len(cs) > 6 else "")]
    return out


def everything(con, crowd, q, lat=None, lon=None, scope=None, per=25):
    """Search all of RF Recon. scope: a set of group keys to limit to."""
    t0 = time.time()
    q = (q or "").strip()
    if len(q) < 2:
        raise ValueError("Type at least two characters.")
    groups, notes = [], []
    want = (lambda k: not scope or k in scope)
    Q, lk, f = q.upper(), like(q), _freq(q)

    def add(key, label, items, more=False):
        if items:
            for it in items:
                if it.get("dist_mi") is None:
                    it["dist_mi"] = _dist(lat, lon, it)
            if lat is not None:
                items.sort(key=lambda it: (it.get("rank", 1), it["dist_mi"] if it.get("dist_mi") is not None else 1e9))
            if key in ("licences", "town"):
                items = _by_licensee(items)
            groups.append({"key": key, "label": label, "count": len(items), "more": more, "items": items[:per]})

    def rows(sql, args=()):
        try:
            return [dict(r) for r in con.execute(sql, args)]
        except sqlite3.Error:
            return []

    pname = lambda r: f"{r['name'].title()}{' County' if r['kind'] == 'county' and not r['name'].upper().endswith('CITY') else ''}, {r['state']}"
    tk = _town_kind(con, words(q), lat, lon) if f is None and len(words(q)) > 1 else None
    town = []
    if tk:
        place, rest = tk
        r_mi = 20 if place["kind"] == "county" else 12
        dlat, dlon = r_mi / 69.0, r_mi / (69.0 * max(0.05, math.cos(math.radians(place["lat"]))))
        conds, args, first = [], [], set()
        for w in rest:
            cats = KIND_WORDS.get(w, ())
            first.update(c for c in cats if c not in SHARED or all(x in SHARED for x in cats))
            conds.append("(" + (f"category IN ({','.join('?' * len(cats))}) OR " if cats else "") + "licensee LIKE ? ESCAPE '\\')")
            args += [*cats, like(w)]
        for r in rows(f"""SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(category) category, COUNT(DISTINCT lat || ',' || lon) sites,
                          MAX(lat) lat, MAX(lon) lon, MAX(city) city, MAX(state) state FROM tx WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND status='A'
                          AND {' AND '.join(conds)} GROUP BY call_sign LIMIT 400""",
                      (place["lat"] - dlat, place["lat"] + dlat, place["lon"] - dlon, place["lon"] + dlon, *args)) if want("licences") else []:
            named = any(w in (r["licensee"] or "").lower() for w in rest)
            town.append(_lic(r, rank=0 if named or r["category"] in first else 1,
                             _d=geo.haversine_km(place["lat"], place["lon"], r["lat"], r["lon"]) if r["lat"] is not None else 1e9))
        town.sort(key=lambda it: (it["rank"], it.pop("_d")))
    if want("places"):  # the town a "Charlotte fire" search read, when it found something there
        add("places", "Places", [{"kind": "place", "title": pname(r), "sub": "County" if r["kind"] == "county" else "Town", "lat": r["lat"], "lon": r["lon"],
                                  "rank": 0 if r["name"].upper() == Q else 1}
                                 for r in rows("SELECT * FROM place WHERE name LIKE ? ORDER BY n DESC LIMIT 12", (q + "%",)) or ([tk[0]] if town else [])])
    if town:
        add("town", f"{' '.join(rest).title()} near {pname(place)}", town, more=len(town) >= 400)
    if want("licences"):
        lic, seen = [], set()
        if re.fullmatch(r"[A-Za-z0-9]{3,10}", q):  # a call sign, or the start of one
            for r in rows("""SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(category) category, COUNT(*) n,
                             COUNT(DISTINCT lat || ',' || lon) sites, MAX(lat) lat, MAX(lon) lon, MAX(city) city, MAX(state) state FROM tx
                             WHERE call_sign >= ? AND call_sign < ? AND status='A' GROUP BY call_sign LIMIT 40""", (Q, Q + "~")):
                seen.add(r["call_sign"])
                lic.append(_lic(r, rank=0 if r["call_sign"] == Q else 1))
        ws = words(q)
        if ws and not f:
            if index_ready(con):
                match = " ".join('"' + w.replace('"', "") + '"*' for w in ws)
                for r in rows("SELECT licensee, call_sign, service, state, city, n, lat, lon FROM lic_fts WHERE lic_fts MATCH ? ORDER BY rank LIMIT 1000", (match,)):
                    if r["call_sign"] in seen:
                        continue
                    seen.add(r["call_sign"])
                    lic.append(_lic(r))
            else:
                if INDEX["state"] != "building":
                    build_index(_db_path(con))
                notes.append("Licensee names are being indexed (once after each FCC update, about a minute): call signs and frequencies work now.")
        add("licences", "Licences", lic, more=len(lic) > per)
    if f is not None and want("frequency"):
        fr = rows("""SELECT call_sign, MAX(licensee) licensee, MAX(service_name) service, MAX(station_class) cls, COUNT(DISTINCT lat || ',' || lon) sites,
                     MAX(lat) lat, MAX(lon) lon, MAX(city) city, MAX(state) state, MAX(mode) mode FROM tx WHERE freq_mhz BETWEEN ? AND ? AND status='A'
                     GROUP BY call_sign LIMIT 500""", (f - 0.00051, f + 0.00051))
        items = [{"kind": "licence", "title": r["licensee"] or r["call_sign"], "call_sign": r["call_sign"], "freq": f, "sub": f"{r['call_sign']} · {f:g} MHz · {r['service'] or ''}",
                  "facts": [r["mode"] or "", f"{r['sites']} site{'s' * (r['sites'] != 1)}", ", ".join(x for x in (r["city"], r["state"]) if x)], "lat": r["lat"], "lon": r["lon"]} for r in fr]
        for r in rows("SELECT * FROM bcast WHERE freq_mhz BETWEEN ? AND ? LIMIT 50", (f - 0.01, f + 0.01)):
            items.append({"kind": "broadcast", "title": f"{r['call_sign']} {r.get('service') or r.get('kind') or ''}", "sub": f"{r['freq_mhz']:g} MHz · {r['licensee'] or ''}", "lat": r["lat"], "lon": r["lon"],
                          "facts": [", ".join(x for x in (r["city"], r["state"]) if x)]})
        for r in rows("SELECT ident, name, kind, use, freq_mhz, city, state, lat, lon FROM faa WHERE freq_mhz BETWEEN ? AND ? LIMIT 50", (f - 0.005, f + 0.005)):
            items.append({"kind": "faa", "title": f"{r['ident']} {r['name'] or ''}", "sub": f"{r['freq_mhz']:g} MHz · {r['use'] or r['kind'] or ''}", "lat": r["lat"], "lon": r["lon"],
                          "facts": [", ".join(x for x in (r["city"], r["state"]) if x)]})
        add("frequency", f"On {f:g} MHz", items, more=len(fr) >= 500)
    if want("towers"):
        add("towers", "Towers (FCC ASR)", [{"kind": "tower", "title": f"{r['struct_type'] or 'Structure'} {r['overall_agl_m'] or '?'} m · {r['owner'] or 'owner not on file'}",
                                            "sub": f"ASR {r['reg']}", "reg": r["reg"], "lat": r["lat"], "lon": r["lon"], "rank": 0 if r["reg"] == q else 1,
                                            "facts": [", ".join(x for x in (r["street"], r["city"], r["state"]) if x)]}
                                           for r in rows("SELECT * FROM tower WHERE reg = ? OR owner LIKE ? ESCAPE '\\' LIMIT 60", (q, lk))])
    if want("psap"):
        add("psap", "911 call centres", [{"kind": "psap", "title": r["name"], "sub": f"PSAP {r['psap_id']} · {r['county'] or ''} {r['state'] or ''}", "lat": r["lat"], "lon": r["lon"],
                                          "facts": [f"placed at the {r['located']}", "FCC registry, 2017"]}
                                         for r in rows("SELECT * FROM psap WHERE name LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR county LIKE ? ESCAPE '\\' LIMIT 60", (lk, lk, lk))])
    if want("broadcast") and f is None:
        add("broadcast", "Broadcast stations", [{"kind": "broadcast", "title": f"{r['call_sign']} {r.get('service') or r.get('kind') or ''} {r['freq_mhz']:g} MHz".strip(), "sub": r["licensee"] or "",
                                                 "lat": r["lat"], "lon": r["lon"], "facts": [", ".join(x for x in (r["city"], r["state"]) if x), f"{r['erp_kw']:g} kW" if r["erp_kw"] else ""]}
                                                for r in rows("SELECT * FROM bcast WHERE call_sign LIKE ? OR licensee LIKE ? ESCAPE '\\' LIMIT 40", (Q + "%", lk))])
    if want("aviation") and f is None:
        add("aviation", "Aviation (FAA)", [{"kind": "faa", "title": f"{r['ident']} {r['name'] or ''}".strip(), "sub": f"{r['freq_mhz']:g} MHz · {r['use'] or r['kind'] or ''}" if r["freq_mhz"] else r["kind"] or "",
                                            "lat": r["lat"], "lon": r["lon"], "facts": [", ".join(x for x in (r["city"], r["state"]) if x)]}
                                           for r in rows("SELECT * FROM faa WHERE ident = ? OR name LIKE ? ESCAPE '\\' LIMIT 40", (Q, lk))])
    if want("makers"):  # FCC equipment grantee codes (fccid.py): who makes a device, by its FCC ID's first characters
        code = re.sub(r"\s+", "", Q)
        add("makers", "FCC equipment makers", [{"kind": "grantee", "title": r["name"] or r["code"], "code": r["code"], "sub": f"FCC grantee code {r['code']}",
                                                 "rank": 0 if r["code"] in (code[:3], code[:5]) else 1,
                                                 "facts": [", ".join(x for x in (r["city"], r["state"], r["country"]) if x), f"since {r['received'][:4]}" if r["received"] else ""]}
                                                for r in rows("SELECT * FROM fcc_grantee WHERE code IN (?, ?) OR name LIKE ? ESCAPE '\\' LIMIT 40",
                                                              (code[:3], code[:5], lk))])
    if want("noaa"):
        add("noaa", "NOAA Weather Radio", [{"kind": "noaa", "title": f"{r['call_sign']} {r['site'] or ''}", "sub": f"{r['freq_mhz']:.3f} MHz", "lat": r["lat"], "lon": r["lon"],
                                            "facts": [", ".join(x for x in (r["city"], r["state"]) if x)]}
                                           for r in rows("SELECT * FROM nwr WHERE call_sign LIKE ? OR site LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' LIMIT 20", (Q + "%", lk, lk))])
    if want("microwave"):
        add("microwave", "Microwave backhaul", [{"kind": "mwlink", "title": f"{r['licensee'] or ''} {r['call_sign']}", "sub": f"{r['tx_city'] or ''} → {r['rx_city'] or ''} · {r['dist_km'] / 1.609344:.1f} mi",
                                                 "lat": r["tx_lat"], "lon": r["tx_lon"], "lat2": r["rx_lat"], "lon2": r["rx_lon"], "facts": [(r["freqs"] or "").replace(",", " ")[:60]]}
                                                for r in rows("SELECT * FROM mw_link WHERE call_sign = ? OR licensee LIKE ? ESCAPE '\\' LIMIT 60", (Q, lk))])
    if want("labels"):
        add("labels", "Your labels", [{"kind": "licence", "title": r["alpha_tag"] or r["description"] or r["call_sign"], "call_sign": r["call_sign"],
                                       "sub": f"{r['call_sign']} · {r['freq_mhz']:g} MHz", "facts": [r["tag"] or "", r["description"] or ""]}
                                      for r in rows("SELECT * FROM overlay WHERE alpha_tag LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\' OR call_sign = ? LIMIT 40",
                                                    (lk, lk, lk, Q))])
        tg_dec = int(q) if q.isdigit() else -1
        add("talkgroups", "Talk groups", [{"kind": "talkgroup", "title": f"{r['dec']} {r['alpha_tag'] or ''}".strip(), "sub": f"{r['system']} · {r['description'] or ''}",
                                           "system": r["system"], "facts": [r["tag"] or "", r["category"] or "", r["mode"] or ""]}
                                          for r in rows("SELECT * FROM talkgroup WHERE dec = ? OR alpha_tag LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\' LIMIT 60",
                                                        (tg_dec, lk, lk, lk))])
    if want("survey"):
        items = []
        for r in rows("SELECT p.*, c.name capture_name FROM capture_point p JOIN capture c ON c.id = p.capture_id "
                      "WHERE p.ident LIKE ? ESCAPE '\\' OR p.label LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' LIMIT 80", (lk, lk, lk)):
            mhz = f" · {r['freq_mhz']:g} MHz" if r["freq_mhz"] else ""
            items.append({"kind": "capture", "title": r["label"] or r["ident"] or "", "sub": f"Survey: {r['capture_name']} · {r['kind'] or ''}{mhz}",
                          "lat": r["lat"], "lon": r["lon"], "facts": [f"{r['dbm']:.0f} dBm" if r["dbm"] is not None else "", (r["ts"] or "")[:16]]})
        if crowd is not None:
            try:
                for r in crowd.execute("SELECT * FROM ext_point WHERE label LIKE ? ESCAPE '\\' OR ext_id LIKE ? ESCAPE '\\' LIMIT 80", (lk, lk)):
                    r = dict(r)
                    items.append({"kind": "crowd", "title": r["label"] or r["ext_id"], "sub": f"{r['layer']} · {r['kind'] or ''}", "lat": r["lat"], "lon": r["lon"],
                                  "facts": [f"{r['dbm']:.0f} dBm" if r["dbm"] is not None else "", r["last_seen"] or ""]})
            except sqlite3.Error:
                pass
        add("survey", "Survey and crowd points", items)
    if want("missions"):
        add("missions", "Missions", [{"kind": "mission", "title": r["name"], "sub": f"{r['status'] or ''} · {r['operator'] or ''}", "mission_id": r["id"], "lat": r["lat"], "lon": r["lon"],
                                      "facts": [(r["objective"] or "")[:120], f"{r['start_date'] or ''} → {r['end_date'] or ''}"]}
                                     for r in rows("SELECT * FROM mission WHERE name LIKE ? ESCAPE '\\' OR objective LIKE ? ESCAPE '\\' OR operator LIKE ? ESCAPE '\\' LIMIT 40", (lk, lk, lk))])
    if want("das") or want("research"):
        d = das_search(con, q, research=want("research"), jobs=want("das"))
        for g in d["groups"]:
            groups.append(g)
    for g in groups:
        for it in g["items"]:
            it["facts"] = [x for x in it.get("facts", []) if x]
    return {"query": q, "groups": groups, "notes": notes, "took_ms": round((time.time() - t0) * 1000), "index": INDEX["state"] if not index_ready(con) else "ready"}


def _db_path(con):
    return con.execute("PRAGMA database_list").fetchone()[2]


def _walk(v, path=""):
    """Every text and number in a job, with where it sits (lists included: floors, readings, the channel plan)."""
    if isinstance(v, dict):
        for k, x in v.items():
            yield from _walk(x, f"{path}.{k}" if path else str(k))
    elif isinstance(v, list):
        for i, x in enumerate(v):
            yield from _walk(x, f"{path}[{i}]")
    elif v not in (None, ""):
        yield path, str(v)


def _sub_for(path):
    top = re.split(r"[.\[]", path, 1)[0]
    return {"presurvey": "presurvey", "floors": "grid", "baseline": "grid", "require": "require", "profile": "require"}.get(top, "overview")


FIELD_NAMES = {"presurvey": "Pre-survey", "floors": "Grid test", "require": "Requirements", "profile": "AHJ profile", "testing": "Testing",
               "checks": "Compliance", "building": "Building outline", "contacts": "People", "notes": "Notes", "address": "Address",
               "client": "Client", "ahj": "AHJ", "code": "Code basis", "next_step": "Next step"}


def das_search(con, q, research=True, jobs=True):
    """Search the DAS tab's data: jobs (every field inside them), contacts, the job log, job files and the research."""
    ws = [w.lower() for w in words(q)] or [q.lower()]
    hit = lambda text: all(w in (text or "").lower() for w in ws)
    groups = []
    if jobs:
        found = []
        for r in con.execute("SELECT * FROM das_job ORDER BY updated_at DESC"):
            data = json.loads(r["data"] or "{}")
            fields = []
            if hit(r["name"]):
                fields.append({"field": "Name", "text": r["name"], "sub": "overview"})
            for path, text in _walk(data):
                if hit(text) or hit(path.split(".")[-1] + " " + text):
                    top = re.split(r"[.\[]", path, 1)[0]
                    fields.append({"field": f"{FIELD_NAMES.get(top, top)}: {path.split('.')[-1]}", "text": text[:160], "sub": _sub_for(path)})
            if fields:
                found.append({"kind": "dasjob", "title": r["name"], "job_id": r["id"], "sub": f"{r['stage']} · {data.get('address') or 'no address'}",
                              "lat": data.get("lat"), "lon": data.get("lon"), "open_sub": fields[0]["sub"], "matches": fields[:6], "match_count": len(fields)})
        groups.append({"key": "das", "label": "DAS jobs", "count": len(found), "items": found[:40]})
        cs = [dict(r) for r in con.execute("SELECT * FROM das_contact") if hit(" ".join(str(r[k] or "") for k in ("name", "org", "role", "phone", "email", "notes")))]
        groups.append({"key": "das_contacts", "label": "DAS contacts", "count": len(cs),
                       "items": [{"kind": "dascontact", "title": c["name"] or c["org"], "sub": " · ".join(x for x in (c["org"], c["role"]) if x),
                                  "facts": [c["phone"] or "", c["email"] or "", (c["notes"] or "")[:100]]} for c in cs[:40]]})
        lg = [dict(r) for r in con.execute("SELECT l.*, j.name job FROM das_log l JOIN das_job j ON j.id = l.job_id ORDER BY l.id DESC LIMIT 5000") if hit(f"{r['kind']} {r['detail']}")]
        groups.append({"key": "das_log", "label": "DAS job log", "count": len(lg),
                       "items": [{"kind": "dasjob", "title": l["job"], "job_id": l["job_id"], "open_sub": "log", "sub": f"{l['ts']} · {l['kind']}", "facts": [(l["detail"] or "")[:160]]} for l in lg[:40]]})
        files = []
        for r in con.execute("SELECT id, name FROM das_job"):
            for f in das.list_files(r["id"], r["name"])["files"]:
                if hit(f["name"]):
                    files.append({"kind": "dasfile", "title": f["name"], "job_id": r["id"], "sub": f"{r['name']} · {f['size'] / 1e6:.1f} MB · {f['modified']}",
                                  "url": f"/api/das/jobs/{r['id']}/file?name={f['name']}"})
        groups.append({"key": "das_files", "label": "DAS job files", "count": len(files), "items": files[:40]})
    if research and os.path.isfile(RESEARCH_DB):
        rc = sqlite3.connect(f"file:{RESEARCH_DB}?mode=ro", uri=True)
        rc.row_factory = sqlite3.Row
        try:
            src = {r["key"]: dict(r) for r in rc.execute("SELECT key, title, url FROM sources")}
            items = []
            for t, (label, cols) in RESEARCH_TABLES.items():
                for r in rc.execute(f"SELECT * FROM {t}"):
                    r = dict(r)
                    if hit(" ".join(str(r.get(c) or "") for c in cols)):
                        keys = (r.get("sources") or (r.get("key") if t == "sources" else "") or "").split()
                        items.append({"kind": "research", "title": " · ".join(str(r[c]) for c in cols[:2] if r.get(c)), "sub": label,
                                      "fields": {c: r.get(c) for c in cols if r.get(c) not in (None, "")},
                                      "links": [{"title": src[k]["title"], "url": src[k]["url"]} for k in keys if k in src][:6]})
            groups.append({"key": "research", "label": "DAS research", "count": len(items), "items": items[:60]})
        finally:
            rc.close()
    return {"query": q, "groups": [g for g in groups if g["count"]]}
