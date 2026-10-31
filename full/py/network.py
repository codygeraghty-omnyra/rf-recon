"""
What one emitter is networked with, from the FCC licence data (nationwide, not just the search area): its licence's
base stations and mobiles (with the radio frequency each base pairs with), simulcast sites, the same system under
the licensee's other call signs, other licensees sharing its channels nearby (shared or regional systems), the
licensee's other licences, what else is on its tower, who else uses the channel nearby, the licensee's microwave
sites, and your own labels and talk groups.

Talk groups aren't in FCC data. They come in from a file you have (CSV, Excel or JSON: Decimal, Hex, Alpha Tag,
Mode, Description, Tag, Category, the columns RadioReference and scanner software export).
"""
import sqlite3
import time

import das
import geo

SCHEMA = """
CREATE TABLE IF NOT EXISTS talkgroup(system TEXT, dec INTEGER, hex TEXT, alpha_tag TEXT, mode TEXT, description TEXT,
    tag TEXT, category TEXT, source TEXT, updated_at TEXT, PRIMARY KEY(system, dec));
"""
TABLES = ("talkgroup",)
MICROWAVE = ("MW", "MG", "CF")  # microwave: public safety pool, industrial / business pool, common carrier
TG_ALIASES = {
    "dec": ["decimal", "dec", "tgid", "talkgroupid", "talkgroup", "tg", "id"],
    "hex": ["hex", "hexid"],
    "alpha_tag": ["alphatag", "alpha", "tagname", "name", "label"],
    "mode": ["mode", "type"],
    "description": ["description", "desc", "comment"],
    "tag": ["tag", "servicetag", "service"],
    "category": ["category", "group", "department", "agency"],
}


def kind_of(cls):
    c = (cls or "").upper()
    return "base" if c.startswith("FB") else "fixed" if c.startswith("FX") else "mobile" if c.startswith("MO") else "other"


def _in(con, sql, values, args=()):
    """Run sql with an IN (...) over values in chunks (SQLite caps the number of parameters)."""
    values, out = list(values), []
    for i in range(0, len(values), 800):
        ch = values[i:i + 800]
        out += [dict(r) for r in con.execute(sql.replace("(?)", "(" + ",".join("?" * len(ch)) + ")"), list(args) + ch)]
    return out


def network(con, call_sign, freq=None, lat=None, lon=None, tower_reg=None, radius_mi=60.0):
    rows = [dict(r) for r in con.execute("SELECT * FROM tx WHERE call_sign=? AND status='A'", (call_sign,))]
    if not rows:
        raise LookupError(f"No active licence {call_sign} in the FCC data on this PC.")
    r0 = rows[0]
    lic = {k: r0.get(k) for k in ("call_sign", "licensee", "service", "service_name", "category", "usi", "grant_date", "expired_date")}
    if lat is None:
        site = next((r for r in rows if r["lat"] is not None and kind_of(r["station_class"]) != "mobile"), None)
        lat, lon = (site["lat"], site["lon"]) if site else (None, None)

    # base stations (and fixed / control stations) by site; mobiles by frequency and area of operation
    sites, mobiles = {}, {}
    for r in rows:
        k = kind_of(r["station_class"])
        if k in ("base", "fixed", "other") and r["lat"] is not None and not r["is_mobile"]:
            s = sites.setdefault((r["lat"], r["lon"]), {"lat": r["lat"], "lon": r["lon"], "city": r["city"], "county": r["county"],
                                                        "state": r["state"], "address": r["address"], "tower_reg": r["tower_reg"],
                                                        "height_m": r["height_tip_m"], "kinds": set(), "classes": set(), "freqs": set(),
                                                        "erp_w": None})
            s["kinds"].add(k)
            s["classes"].add(r["station_class"] or "")
            if r["freq_mhz"]:
                s["freqs"].add(round(r["freq_mhz"], 5))
            if r["erp_w"] and (s["erp_w"] or 0) < r["erp_w"]:
                s["erp_w"] = r["erp_w"]
        else:
            area = ("within %g km of %.4f, %.4f" % (r["radius_km"], r["lat"], r["lon"]) if r["radius_km"] and r["lat"] is not None
                    else ", ".join(x for x in (r["county"] and r["county"] + " Co.", r["state"]) if x) or "area on the licence")
            m = mobiles.setdefault((round(r["freq_mhz"] or 0, 5), r["station_class"], area),
                                   {"freq": round(r["freq_mhz"] or 0, 5), "class": r["station_class"], "area": area, "units": 0,
                                    "lat": r["lat"], "lon": r["lon"], "radius_km": r["radius_km"], "erp_w": r["erp_w"] or r["power_out_w"]})
            m["units"] += r["units"] or 0
    base_f = sorted({f for s in sites.values() for f in s["freqs"]})
    mob_f = sorted({m["freq"] for m in mobiles.values() if m["freq"]})
    for s in sites.values():
        s["dist_mi"] = round(geo.haversine_km(lat, lon, s["lat"], s["lon"]) / geo.MI_KM, 2) if lat is not None else None
        s["kinds"], s["classes"], s["freqs"] = sorted(s["kinds"]), sorted(s["classes"]), sorted(s["freqs"])
    site_list = sorted(sites.values(), key=lambda s: (s["dist_mi"] is None, s["dist_mi"] or 0))

    # what each base frequency pairs with: the fixed 700 / 800 MHz offsets, else the licence's mobile frequencies in the band
    pairs = []
    for f in base_f:
        off = next((o for lo, hi, o, _ in das.PAIRS if lo <= f <= hi), None)
        if off is not None:
            pairs.append({"base": f, "mobile": [round(f + off, 5)], "how": "band plan"})
        else:
            same = [m for m in mob_f if das.band_of(m) == das.band_of(f) and m != f]
            pairs.append({"base": f, "mobile": same or ([f] if f in mob_f else []), "how": "licence" if same else "simplex" if f in mob_f else "not on licence"})
    simulcast = [{"freq": f, "sites": n} for f in base_f for n in [sum(1 for s in site_list if f in s["freqs"])] if n > 1]

    # the same system under the licensee's other call signs (found through the frequency index: licensee has none)
    sysd = {}
    for r in (_in(con, "SELECT call_sign, licensee, service_name, freq_mhz, lat, lon FROM tx WHERE status='A' AND freq_mhz IN (?)", base_f + mob_f)
              if base_f or mob_f else []):
        if r["licensee"] == r0["licensee"] and r["call_sign"] != call_sign:
            x = sysd.setdefault(r["call_sign"], {"call_sign": r["call_sign"], "service_name": r["service_name"], "f": set(), "s": set()})
            x["f"].add(r["freq_mhz"])
            x["s"].add((r["lat"], r["lon"]))
    system = sorted(({"call_sign": x["call_sign"], "service_name": x["service_name"], "shared": len(x["f"]), "sites": len(x["s"])}
                     for x in sysd.values()), key=lambda x: -x["shared"])[:100]
    # other licensees on two or more of its channels nearby
    shared = []
    if lat is not None and base_f:
        s_, n_, w_, e_ = geo.bbox(lat, lon, radius_mi)
        shared = _in(con, "SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) shared, MIN(city) city, MIN(state) state "
                          "FROM tx WHERE status='A' AND licensee<>? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND freq_mhz IN (?) "
                          "GROUP BY call_sign HAVING shared >= 2 ORDER BY shared DESC LIMIT 60",
                     base_f, (r0["licensee"], s_, n_, w_, e_))
    # the licensee's other licences and microwave sites within radius_mi (through the location index: licensee has none)
    lic_rows = []
    if lat is not None:
        s_, n_, w_, e_ = geo.bbox(lat, lon, radius_mi)
        lic_rows = [dict(r) for r in con.execute("SELECT call_sign, service, service_name, freq_mhz, lat, lon, city, state FROM tx "
                                                 "WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND licensee=? AND status='A'",
                                                 (s_, n_, w_, e_, r0["licensee"]))]
    od = {}
    for r in lic_rows:
        if r["call_sign"] != call_sign and r["service"] not in MICROWAVE:
            x = od.setdefault(r["call_sign"], {"call_sign": r["call_sign"], "service_name": r["service_name"], "city": r["city"], "state": r["state"], "f": set(), "s": set()})
            x["f"].add(r["freq_mhz"])
            x["s"].add((r["lat"], r["lon"]))
    others = sorted(({"call_sign": x["call_sign"], "service_name": x["service_name"], "freqs": len(x["f"]), "sites": len(x["s"]),
                      "city": x["city"], "state": x["state"]} for x in od.values()), key=lambda x: -x["sites"])[:200]

    # the tower: its registration, and everyone else on it (or within 50 m when it has no registration)
    tower, colo = None, []
    treg = tower_reg or next((s["tower_reg"] for s in site_list if s["tower_reg"]), None)
    if treg:
        t = con.execute("SELECT * FROM tower WHERE reg=?", (treg,)).fetchone()
        tower = dict(t) if t else {"reg": treg}
        colo = [dict(r) for r in con.execute(
            "SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) freqs, GROUP_CONCAT(DISTINCT freq_mhz) f "
            "FROM tx WHERE tower_reg=? AND call_sign<>? AND status='A' GROUP BY call_sign ORDER BY licensee LIMIT 150", (treg, call_sign))]
    elif lat is not None:
        d = 0.05 / 111.0
        colo = [dict(r) for r in con.execute(
            "SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) freqs, GROUP_CONCAT(DISTINCT freq_mhz) f "
            "FROM tx WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND call_sign<>? AND status='A' GROUP BY call_sign LIMIT 150",
            (lat - d, lat + d, lon - d * 1.4, lon + d * 1.4, call_sign))]
    for c in colo:
        c["f"] = sorted({round(float(x), 5) for x in str(c.pop("f") or "").split(",") if x})[:12]

    # the channel's other users near the site
    cochan = []
    if freq and lat is not None:
        s_, n_, w_, e_ = geo.bbox(lat, lon, radius_mi)
        for r in con.execute("SELECT licensee, call_sign, station_class, lat, lon, city, state, erp_w FROM tx WHERE status='A' "
                             "AND freq_mhz BETWEEN ? AND ? AND call_sign<>? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 400",
                             (freq - 0.0006, freq + 0.0006, call_sign, s_, n_, w_, e_)):
            d = geo.haversine_km(lat, lon, r["lat"], r["lon"]) / geo.MI_KM
            if d <= radius_mi:
                cochan.append(dict(r, dist_mi=round(d, 1)))
        cochan.sort(key=lambda x: x["dist_mi"])
        cochan = cochan[:80]

    try:  # the microwave file is loaded when the import's source list names it
        mw_loaded = "l_micro.zip" in (con.execute("SELECT v FROM meta WHERE k='sources'").fetchone() or [""])[0]
    except Exception:
        mw_loaded = False
    mw = {}
    for r in lic_rows:
        if r["service"] not in MICROWAVE or r["lat"] is None:
            continue
        m = mw.setdefault((r["lat"], r["lon"]), {"lat": r["lat"], "lon": r["lon"], "city": r["city"], "state": r["state"], "call_signs": set(), "freqs": set()})
        m["call_signs"].add(r["call_sign"])
        m["freqs"].add(round(r["freq_mhz"] or 0, 4))
    mw_sites = [dict(m, call_signs=sorted(m["call_signs"]), freqs=sorted(m["freqs"])[:8]) for m in mw.values()]
    # its backhaul: the licensee's microwave links with an end within radius_mi (uls_import.build_links)
    mw_links = []
    if lat is not None:
        s_, n_, w_, e_ = geo.bbox(lat, lon, radius_mi)
        seen = set()
        try:
            for side in ("tx", "rx"):
                for r in con.execute(f"SELECT rowid, * FROM mw_link WHERE {side}_lat BETWEEN ? AND ? AND {side}_lon BETWEEN ? AND ? "
                                     "AND licensee = ? LIMIT 500", (s_, n_, w_, e_, r0["licensee"])):
                    if r["rowid"] not in seen:
                        seen.add(r["rowid"])
                        mw_links.append(dict(r))
        except sqlite3.OperationalError:  # no links table until the microwave file has been imported
            pass
    mw_loaded = mw_loaded or bool(mw_links)

    # your labels: this licence's, then any on its frequencies
    labels = [dict(r) for r in con.execute("SELECT call_sign, freq_mhz, alpha_tag, description, tone, tag, mode FROM overlay WHERE call_sign=?", (call_sign,))]
    if base_f or mob_f:
        seen = {(l["call_sign"], l["freq_mhz"]) for l in labels}
        labels += [l for l in _in(con, "SELECT call_sign, freq_mhz, alpha_tag, description, tone, tag, mode FROM overlay WHERE freq_mhz IN (?) LIMIT 400",
                                  base_f + mob_f) if (l["call_sign"], l["freq_mhz"]) not in seen]
    tgs = [dict(r) for r in con.execute("SELECT * FROM talkgroup WHERE system IN (?, ?) ORDER BY dec", (call_sign, r0["licensee"]))]

    # the same radios are licensed on every channel, so a group's count is its largest, not the sum over channels
    fleet = {}
    for m in mobiles.values():
        fleet[(m["class"], m["area"])] = max(fleet.get((m["class"], m["area"]), 0), m["units"])
    n_units = sum(fleet.values())
    return {"licence": lic, "sites": site_list, "mobiles": sorted(mobiles.values(), key=lambda m: m["freq"]), "units": n_units,
            "pairs": pairs, "simulcast": simulcast, "system": system, "shared": shared, "licences": others,
            "tower": tower, "colocated": colo, "cochannel": cochan, "microwave": mw_sites, "microwave_loaded": mw_loaded, "mw_links": mw_links,
            "labels": labels, "talkgroups": tgs, "center": [lat, lon] if lat is not None else None, "radius_mi": radius_mi,
            "links": {"fcc": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={r0['usi']}" if r0.get("usi") else None,
                      "radioreference": f"https://www.radioreference.com/db/fcc/callsign/{call_sign}"}}


def import_talkgroups(con, system, name, data):
    """A talk group list from any file -> the talkgroup table, keyed to a system (a call sign or a licensee)."""
    if not system:
        raise ValueError("Say which system (call sign or licensee) the talk groups belong to.")
    fmt, head, rows = das.read_table(name, data)
    m = das.guess_mapping(head, TG_ALIASES)
    if "dec" not in m and "hex" not in m:
        raise ValueError(f"No talk group number column found (looked for Decimal, DEC, TGID, Hex) in: {', '.join(head[:12])}")
    now = time.strftime("%Y-%m-%d %H:%M")
    n = 0
    for r in rows:
        dec = str(r.get(m.get("dec"), "") or "").strip()
        hx = str(r.get(m.get("hex"), "") or "").strip()
        try:
            dec = int(float(dec)) if dec else int(hx, 16)
        except ValueError:
            continue
        g = lambda k: str(r.get(m[k], "") or "").strip() if k in m else ""
        con.execute("INSERT OR REPLACE INTO talkgroup VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (system, dec, hx or format(dec, "x"), g("alpha_tag"), g("mode"), g("description"), g("tag"), g("category"), name, now))
        n += 1
    con.commit()
    return {"system": system, "imported": n, "found": len(rows), "columns": m}
