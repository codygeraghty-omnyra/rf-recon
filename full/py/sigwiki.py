"""
Signal Identification Wiki (sigidwiki.com) catalog: what a signal on a frequency could be.

The wiki runs Semantic MediaWiki, so its signal pages can be read as data (frequencies, bandwidth, mode,
modulation, location, description, audio sample) through the 'ask' API. The catalog is cached locally (it's
a few hundred signals) for offline lookups. The wiki states no content licence, so the catalog stays on this
PC: the app shows names, short notes and a link back to each page, and never exports the catalog itself.
"""
import json
import math
import re
import time
import urllib.parse
import urllib.request

API = "https://www.sigidwiki.com/api.php"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"}
PROPS = ["Title", "Frequencies", "Frequency_min", "Frequency_max", "Bandwidth", "Bandwidth_min", "Bandwidth_max",
         "Mode", "Modulation", "Location", "Signal_description", "Additional_categories", "Picture", "Signal_file"]
SCHEMA = """
CREATE TABLE IF NOT EXISTS sigwiki(name TEXT PRIMARY KEY, title TEXT, url TEXT, ranges TEXT, fmin REAL, fmax REAL,
    bw_min REAL, bw_max REAL, mode TEXT, modulation TEXT, location TEXT, description TEXT, categories TEXT,
    picture TEXT, audio TEXT, fetched_at TEXT);
CREATE INDEX IF NOT EXISTS sigwiki_f ON sigwiki(fmin, fmax);
"""
LOCAL = re.compile(r"worldwide|united states|usa|\bus\b|north america|americas|global|international", re.I)
# Distinctive catalog words for RF Recon's signal types. Generic words ("radio", "weather", "data") would
# boost every "... Radio" entry, so only these count. The catalog has no NOAA Weather Radio or FRS/GMRS pages:
# it covers digital and unusual signals, and the band plan in sigid.py covers the everyday ones.
TYPE_WORDS = {"P25 Phase 1": ["p25", "project 25"], "P25 Phase 2": ["p25", "project 25"], "DMR": ["dmr", "mototrbo"],
              "NXDN": ["nxdn"], "dPMR": ["dpmr"], "TETRA": ["tetra"], "ADS-B / Mode S": ["ads-b", "mode s"],
              "UAT": ["uat"], "AIS": ["ais"], "LTE": ["lte"], "5G NR": ["5g", "new radio"], "GSM": ["gsm"],
              "WCDMA/UMTS": ["umts", "wcdma"], "CDMA": ["cdma"], "Wi-Fi": ["wi-fi", "wifi", "802.11"],
              "Bluetooth": ["bluetooth"], "Bluetooth LE": ["bluetooth"], "Paging (POCSAG/FLEX)": ["pocsag", "flex", "pager"],
              "ISM 902-928 (LoRa/FHSS/meters)": ["lora", "ism"], "Amateur": ["amateur", "ham"]}


def _ask(offset, limit=200):
    query = "[[Category:Signal]]" + "".join(f"|?{p}" for p in PROPS) + f"|limit={limit}|offset={offset}"
    url = API + "?" + urllib.parse.urlencode({"action": "ask", "query": query, "format": "json"})
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.loads(r.read())


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def ranges_from(freqs_hz, fmin_hz, fmax_hz):
    """Frequencies come as a flat list: an even, rising list is pairs (ranges); otherwise single frequencies."""
    f = [x / 1e6 for x in (_num(v) for v in freqs_hz) if x]
    if len(f) >= 2 and len(f) % 2 == 0 and all(f[i] <= f[i + 1] for i in range(0, len(f), 2)):
        return [[f[i], f[i + 1]] for i in range(0, len(f), 2)]
    if f:
        return [[x, x] for x in f]
    lo, hi = _num(fmin_hz), _num(fmax_hz)
    return [[lo / 1e6, (hi or lo) / 1e6]] if lo else []


def fetch(con, log=print):
    """Download the whole catalog (a few requests) and replace the local copy. Returns the row count."""
    con.executescript(SCHEMA)
    rows, offset = [], 0
    while offset is not None:
        d = _ask(offset)
        for name, res in (d.get("query", {}).get("results") or {}).items():
            p = res.get("printouts", {})
            first = lambda k: (p.get(k) or [None])[0]
            rng = ranges_from(p.get("Frequencies") or [], first("Frequency_min"), first("Frequency_max"))
            bws = [x / 1000 for x in (_num(v) for v in (p.get("Bandwidth") or []) + [first("Bandwidth_min"), first("Bandwidth_max")]) if x]
            text = lambda k: ", ".join(str(x.get("fulltext") if isinstance(x, dict) else x) for x in (p.get(k) or []))
            rows.append((name, text("Title") or name, res.get("fullurl"), json.dumps(rng),
                         min((r[0] for r in rng), default=None), max((r[1] for r in rng), default=None),
                         min(bws, default=None), max(bws, default=None), text("Mode"), text("Modulation"),
                         text("Location"), (first("Signal_description") or "")[:600], text("Additional_categories"),
                         text("Picture"), text("Signal_file"), time.strftime("%Y-%m-%d %H:%M")))
        nxt = d.get("query-continue-offset")
        offset = nxt if nxt and nxt > offset else None
        time.sleep(0.5)  # be gentle with a volunteer-run wiki
    con.execute("DELETE FROM sigwiki")
    con.executemany("INSERT OR REPLACE INTO sigwiki VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    log(f"  Signal ID Wiki: {len(rows):,} signals")
    return len(rows)


def match(con, f, bw_khz=None, sig_type=None, limit=5):
    """Catalog entries whose frequencies cover f (MHz), best first, each with the reasons it scored."""
    if not f:
        return []
    try:
        cand = con.execute("SELECT * FROM sigwiki WHERE fmin <= ? AND fmax >= ?", (f + 0.05, f - 0.05)).fetchall()
    except Exception:
        return []  # no catalog yet
    cols = [c[0] for c in con.execute("SELECT * FROM sigwiki LIMIT 0").description]
    words = TYPE_WORDS.get(sig_type or "", [])
    out = []
    for row in cand:
        e = dict(zip(cols, row))
        best = None
        for lo, hi in json.loads(e["ranges"] or "[]"):
            tol = max((e["bw_max"] or 12.5) / 2000, 0.0005) if lo == hi else 0.0
            if lo - tol <= f <= hi + tol:
                w = hi - lo
                best = w if best is None else min(best, w)
        if best is None:
            continue
        score, why = 1.0 / (1 + math.log10(1 + best)), [f"covers {f:g} MHz" + (f" ({best:g} MHz-wide range)" if best else " (exact)")]
        if bw_khz and e["bw_min"]:
            if e["bw_min"] * 0.7 <= bw_khz <= (e["bw_max"] or e["bw_min"]) * 1.3:
                score += 1; why.append(f"bandwidth fits ({e['bw_min']:g}-{e['bw_max']:g} kHz)")
            else:
                score -= 0.5
        hay = f"{e['title']} {e['name']} {e['modulation']} {e['categories']}".lower()
        if words and any(w in hay for w in words):
            score += 2; why.append(f"matches {sig_type}")
        if e["location"] and LOCAL.search(e["location"]):
            score += 0.5
        elif e["location"]:
            score -= 0.5; why.append(f"usually heard in {e['location'][:60]}")
        out.append({"name": e["name"], "title": e["title"], "url": e["url"], "score": round(score, 2), "why": why,
                    "mode": e["mode"], "modulation": e["modulation"], "location": e["location"],
                    "bw": [e["bw_min"], e["bw_max"]], "description": (e["description"] or "")[:240]})
    out.sort(key=lambda x: -x["score"])
    return out[:limit]


def in_range(con, lo, hi, limit=400):
    """Catalog entries overlapping lo..hi MHz, for drawing on the spectrum."""
    try:
        rows = con.execute("SELECT name, title, url, ranges, mode, modulation FROM sigwiki WHERE fmin <= ? AND fmax >= ? "
                           "ORDER BY (fmax - fmin) LIMIT ?", (hi, lo, limit)).fetchall()
    except Exception:
        return []
    return [{"name": n, "title": t, "url": u, "ranges": [r for r in json.loads(rg) if r[1] >= lo and r[0] <= hi],
             "mode": m, "modulation": md} for n, t, u, rg, m, md in rows]
