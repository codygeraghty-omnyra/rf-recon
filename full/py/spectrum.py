"""
Which carrier holds which spectrum at an address: the FCC's market licences (l_market.zip about 90 MB, l_cell.zip about 24 MB,
public domain, rebuilt weekly), joined to the county's markets (reference/county_markets.csv) and turned into MHz by the band
plans in the rules (PLAN below, each with its section).

It answers the question a scanner leaves open: PCTEL shows a sub-band, not whose it is, and each one used to be researched by
hand (a customer's words, 9/18 and the 11/4 demo). What it can't say, and says so: a licence is the right to use a block, not
proof the block is on the air at that tower. Leases aren't in these files, and 2.5 GHz, T-Mobile's main 5G band, is mostly
leased from schools. A block can be split inside a market (partitioned), so a holder may not cover this county: those are marked.
No public file gives a tower's frequencies: that takes CellMapper or a scan on site.
"""
import csv
import os
import re
import sqlite3
import time
import zipfile

import carriers
import uls_import
from uls_import import find_member, g, iter_records

APP = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(APP, "reference", "county_markets.csv")
SERVICES_FILES = ("market", "cell")
SOURCE = "FCC Universal Licensing System, market-based licences (l_market, l_cell)"
SCHEMA = """
CREATE TABLE lic(call_sign TEXT, service TEXT, market TEXT, block TEXT, submarket TEXT, licensee TEXT, brand TEXT);
CREATE INDEX lic_market ON lic(market);
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
"""


def _letters(start, step, letters):
    return {x: {"dl": [[start + i * step, start + (i + 1) * step]], "ul": []} for i, x in enumerate(letters)}


def _pairs(dl, ul, step, letters):
    return {x: {"dl": [[dl + i * step, dl + (i + 1) * step]], "ul": [[ul + i * step, ul + (i + 1) * step]]} for i, x in enumerate(letters)}


def _pair(*rows):
    return {b: {"dl": [list(d)], "ul": [list(u)]} for b, d, u in rows}


_CBAND = {f"{x}{n}": {"dl": [[s + 20 * (n - 1), s + 20 * n]], "ul": []}
          for x, s, top in (("A", 3700, 5), ("B", 3800, 5), ("C", 3900, 5), ("D", 4000, 5), ("E", 4100, 2)) for n in range(1, top + 1)}
_LOWER700 = _pair(("A", (728, 734), (698, 704)), ("B", (734, 740), (704, 710)), ("C", (740, 746), (710, 716)))
_LOWER700.update({"D": {"dl": [[716, 722]], "ul": []}, "E": {"dl": [[722, 728]], "ul": []}})
# service code -> band, 3GPP bands, whether it's time-division, the rule, and each block's MHz. Downlink is what the tower sends
PLAN = {
    "WT": {"band": "600 MHz", "rf": "n71", "cite": "47 CFR 27.5(l)", "order": 600, "blocks": _pairs(617, 663, 5, "ABCDEFG")},
    "WY": {"band": "Lower 700 MHz", "rf": "B12 / B17 / B29", "cite": "47 CFR 27.5(c)", "order": 700, "blocks": _LOWER700},
    "WZ": {"band": "Lower 700 MHz", "rf": "B12 / B17 / B29", "cite": "47 CFR 27.5(c)", "order": 700, "blocks": _LOWER700},
    "WU": {"band": "Upper 700 MHz", "rf": "B13", "cite": "47 CFR 27.5(b)", "order": 746, "blocks": _pair(("C", (746, 757), (776, 787)))},
    "CL": {"band": "Cellular 850 MHz", "rf": "B5 / n5", "cite": "47 CFR 22.905", "order": 850, "blocks": {
        "A": {"dl": [[869, 880], [890, 891.5]], "ul": [[824, 835], [845, 846.5]]},
        "B": {"dl": [[880, 890], [891.5, 894]], "ul": [[835, 845], [846.5, 849]]}}},
    "AW": {"band": "AWS-1", "rf": "B4 / B66", "cite": "47 CFR 27.5(h)", "order": 1710, "blocks": _pair(
        ("A", (2110, 2120), (1710, 1720)), ("B", (2120, 2130), (1720, 1730)), ("C", (2130, 2135), (1730, 1735)),
        ("D", (2135, 2140), (1735, 1740)), ("E", (2140, 2145), (1740, 1745)), ("F", (2145, 2155), (1745, 1755)))},
    "AT": {"band": "AWS-3", "rf": "B66", "cite": "47 CFR 27.5(h)", "order": 1755, "blocks": {**_pair(
        ("G", (2155, 2160), (1755, 1760)), ("H", (2160, 2165), (1760, 1765)), ("I", (2165, 2170), (1765, 1770)), ("J", (2170, 2180), (1770, 1780))),
        "A1": {"dl": [], "ul": [[1695, 1700]]}, "B1": {"dl": [], "ul": [[1700, 1710]]}}},
    "CW": {"band": "PCS 1900 MHz", "rf": "B2 / B25 / n2", "cite": "47 CFR 24.229", "order": 1900, "blocks": _pair(
        ("A", (1930, 1945), (1850, 1865)), ("B", (1950, 1965), (1870, 1885)), ("C", (1975, 1990), (1895, 1910)),
        ("D", (1945, 1950), (1865, 1870)), ("E", (1965, 1970), (1885, 1890)), ("F", (1970, 1975), (1890, 1895)))},
    "CY": {"band": "PCS G block", "rf": "B25", "cite": "47 CFR 24.229(c)", "order": 1910, "blocks": {"*": {"dl": [[1990, 1995]], "ul": [[1910, 1915]]}}},
    "AH": {"band": "H block", "rf": "B25-adjacent", "cite": "47 CFR 27.5(k)", "order": 1915, "blocks": {"*": {"dl": [[1995, 2000]], "ul": [[1915, 1920]]}}},
    "AD": {"band": "AWS-4", "rf": "n70 / B66 family", "cite": "47 CFR 27.5(j)", "order": 2000, "blocks": _pair(("A", (2180, 2190), (2000, 2010)), ("B", (2190, 2200), (2010, 2020)))},
    "WS": {"band": "WCS 2.3 GHz", "rf": "B30 / n30", "cite": "47 CFR 27.5(a)", "order": 2305, "blocks": {
        "A": {"dl": [[2350, 2355]], "ul": [[2305, 2310]]}, "B": {"dl": [[2355, 2360]], "ul": [[2310, 2315]]},
        "C": {"dl": [[2315, 2320]], "ul": []}, "D": {"dl": [[2345, 2350]], "ul": []}}},
    "PK": {"band": "3.45 GHz", "rf": "n77", "tdd": True, "cite": "47 CFR 27.5(o)", "order": 3450, "blocks": _letters(3450, 10, "ABCDEFGHIJ")},
    "PL": {"band": "CBRS PAL 3.55 GHz", "rf": "B48 / n48", "tdd": True, "cite": "47 CFR 96.25", "order": 3550, "dynamic": True,
           "blocks": {"*": {"dl": [[3550, 3650]], "ul": []}}},
    "PM": {"band": "C-band 3.7 GHz", "rf": "n77", "tdd": True, "cite": "47 CFR 27.5(m)", "order": 3700, "blocks": _CBAND},
}
TOP = ("AT&T", "T-Mobile", "Verizon")


def db_path(data_dir):
    return os.path.join(data_dir, "spectrum.db")


def brand_of(licensee):
    """Only names that are plainly the carrier's: anything else stays under the licensee's own name ("ALLTEL Corporation"
    holds a Minneapolis cellular block on file, and calling that Verizon would be a guess)."""
    return carriers.name_of(licensee, shells=True)


def block_mhz(service, block):
    """{"dl": [[lo, hi]], "ul": [[lo, hi]]} for a licence's block, or None when the rules' table doesn't name it."""
    p = PLAN.get(service)
    if not p:
        return None
    return p["blocks"].get(block) or p["blocks"].get("*") or p["blocks"].get((block or "")[:1])


def _licences(path):
    """(call sign, service, market, block, submarket, licensee) for each active licence's market in one FCC file."""
    zf = zipfile.ZipFile(path)
    head = {}
    for f in iter_records(zf, find_member(zf, "HD"), "HD"):
        if g(f, 5) == "A" and g(f, 6) in PLAN:
            head[g(f, 1)] = g(f, 6)
    who = {}
    for f in iter_records(zf, find_member(zf, "EN"), "EN"):
        if g(f, 5) == "L" and g(f, 1) in head:
            who[g(f, 1)] = g(f, 7)
    for f in iter_records(zf, find_member(zf, "MK"), "MK"):
        if g(f, 1) in head:
            yield (g(f, 4), head[g(f, 1)], g(f, 5).upper(), g(f, 6).upper(), g(f, 7), who.get(g(f, 1), ""))


def build(paths, data_dir, log=print):
    """The licences into spectrum.db, written beside it and moved in whole, so a reader never sees half a load."""
    tmp = db_path(data_dir) + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    try:
        con.executescript(SCHEMA)
        n = 0
        for path in paths:
            log(f"Reading {os.path.basename(path)}...")
            rows = [(*r, brand_of(r[5])) for r in _licences(path)]
            con.executemany("INSERT INTO lic VALUES(?,?,?,?,?,?,?)", rows)
            n += len(rows)
        markets = con.execute("SELECT COUNT(DISTINCT market) FROM lic").fetchone()[0]
        con.executemany("INSERT INTO meta VALUES(?,?)", (("built_at", time.strftime("%Y-%m-%d %H:%M")), ("licences", str(n)), ("markets", str(markets))))
        con.commit()
    finally:
        con.close()
    os.replace(tmp, db_path(data_dir))
    return {"licences": n, "markets": markets}


def refresh(data_dir, log=print):
    """Downloads the two FCC files and rebuilds."""
    paths = []
    for svc in SERVICES_FILES:
        path = uls_import.download(svc, True, log)
        if not path:
            raise RuntimeError(f"couldn't download the FCC's l_{svc}.zip")
        paths.append(path)
    return build(paths, data_dir, log)


_counties = {}


def _norm(name):
    s = re.sub(r"\b(county|parish|borough|census area|municipality|city and borough|planning region)\b", " ", (name or "").lower())
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\bsaint\b", "st", s))


def counties():
    if not _counties:
        with open(TABLE, encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                _counties[r["fips"]] = r
                _counties[(r["st"], _norm(r["county"]))] = r
    return _counties


def county_at(lat, lon, data_dir, con=None, place=None):
    """The county row for a point, and how it was found: the Census Bureau's boundaries, or with no signal the nearest
    county in the FCC data, which can be the neighbour near a line."""
    import ahj
    import geo
    p = place if place is not None else ahj.place_of(lat, lon, data_dir)
    if p and p.get("state") and p.get("county"):
        r = counties().get((p["state"], _norm(p.get("county_base") or p["county"])))
        if r:
            return r, p.get("source") or "Census boundaries"
    if con is not None:
        try:
            near = con.execute("SELECT name, state, lat, lon FROM place WHERE kind='county' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                               (lat - 1, lat + 1, lon - 1.4, lon + 1.4)).fetchall()
        except sqlite3.Error:
            near = []
        for x in sorted(near, key=lambda x: geo.haversine_km(lat, lon, x[2], x[3])):
            r = counties().get((x[1], _norm(x[0])))
            if r:
                return r, "nearest county centre (no boundary lookup)"
    return None, None


def markets_of(r):
    """Every market code a county falls in, as the FCC writes them. PL licences are by county (D + FIPS)."""
    out = {f"D{r['fips']}", f"C{r['fips']}"}
    for col, code in (("cma", "CMA"), ("bta", "BTA"), ("mta", "MTA"), ("bea", "BEA"), ("rea", "REA"), ("mea", "MEA"), ("eag", "EAG"), ("pea", "PEA")):
        if r.get(col):
            out.add(f"{code}{int(r[col]):03d}")
    return sorted(out)


def _merge(spans):
    out = []
    for lo, hi in sorted(spans):
        if out and lo <= out[-1][1]:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _bands(rows):
    """Licence rows -> one line per band, low to high: its blocks and their merged MHz."""
    by = {}
    for service, block, sub, market, call in rows:
        p, mhz = PLAN[service], block_mhz(service, block)
        x = by.setdefault(p["band"], {"band": p["band"], "rf": p["rf"], "tdd": bool(p.get("tdd")), "dynamic": bool(p.get("dynamic")), "cite": p["cite"],
                                      "order": p["order"], "blocks": {}})
        label = block if block in p["blocks"] else ("" if "*" in p["blocks"] else block)
        b = x["blocks"].setdefault(label, {"block": label, "dl": (mhz or {}).get("dl", []), "ul": (mhz or {}).get("ul", []), "whole": False, "calls": set()})
        b["whole"] = b["whole"] or sub in ("", "0")
        b["calls"].add(call)
    out = []
    for x in sorted(by.values(), key=lambda v: v["order"]):
        blocks = sorted(x.pop("blocks").values(), key=lambda b: (len(b["block"]), b["block"]))
        for b in blocks:
            b["part"], b["calls"] = not b.pop("whole"), sorted(b["calls"])[:6]
        out.append({**{k: v for k, v in x.items() if k != "order"}, "blocks": blocks, "dl": _merge([s for b in blocks for s in b["dl"]]),
                    "ul": _merge([s for b in blocks for s in b["ul"]])})
    return out


def at(lat, lon, data_dir, con=None, place=None):
    """Each carrier's spectrum at a point."""
    path = db_path(data_dir)
    if not os.path.exists(path):
        return {"empty": True, "why": "Carrier spectrum isn't loaded on this copy (Data & updates: FCC carrier spectrum)."}
    county, how = county_at(lat, lon, data_dir, con, place)
    if not county:
        return {"empty": True, "why": "Couldn't tell which county this is in."}
    codes = markets_of(county)
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
    try:
        rows = db.execute(f"SELECT service, block, submarket, market, call_sign, licensee, brand FROM lic WHERE market IN ({','.join('?' * len(codes))})", codes).fetchall()
        meta = dict(db.execute("SELECT k, v FROM meta").fetchall())
    finally:
        db.close()
    held, others = {}, {}
    for r in rows:
        (held.setdefault(r[6], []) if r[6] else others.setdefault(r[5], [])).append(r[:5])
    order = sorted(held, key=lambda b: (TOP.index(b) if b in TOP else 9, b))
    return {"county": f"{county['county']}, {county['st']}", "fips": county["fips"], "county_source": how, "markets": codes, "built_at": meta.get("built_at"),
            "source": SOURCE, "carriers": [{"brand": b, "bands": _bands(held[b])} for b in order],
            "others": [{"licensee": k, "bands": _bands(v)} for k, v in sorted(others.items(), key=lambda kv: -len(kv[1]))[:12]]}
