"""
Crowdsourced / open RF layers, fetched per area with YOUR OWN credentials and
cached locally in crowd.db (kept separate from the public-domain FCC data so
third-party terms - e.g. OpenCelliD's CC BY-SA share-alike - don't mix in).

  WiGLE        Wi-Fi / Bluetooth / cell observations, with first/last seen dates
               (API name + token from wigle.net/account; non-commercial EULA)
  OpenCelliD   Crowdsourced cell towers with estimated positions (API key; CC BY-SA 4.0)
  RepeaterBook Amateur / GMRS repeaters with tones and digital modes
               (per-user rbuapp_ token; attribution required; no redistribution)
  Custom       Any CSV / KML / KMZ / GeoJSON you import as a named layer

Response field names for WiGLE and RepeaterBook are read defensively (several
known spellings), because their schemas aren't fully published.
"""
import base64
import csv
import io
import json
import math
import sqlite3
import time
import urllib.parse
import urllib.request

import captures
import geo
import sigid

UA = "RF-Recon/2.0 (local site-survey tool)"
SCHEMA = """
CREATE TABLE IF NOT EXISTS ext_point(id INTEGER PRIMARY KEY, source TEXT, layer TEXT, ext_id TEXT,
    lat REAL, lon REAL, kind TEXT, label TEXT, freq_mhz REAL, freq_in_mhz REAL, dbm REAL, mode TEXT,
    sig_type TEXT, first_seen TEXT, last_seen TEXT, details TEXT, fetched_at TEXT, attribution TEXT,
    UNIQUE(source, ext_id));
CREATE INDEX IF NOT EXISTS ext_latlon ON ext_point(lat, lon);
CREATE TABLE IF NOT EXISTS ext_fetch(id INTEGER PRIMARY KEY, source TEXT, lat REAL, lon REAL, radius_mi REAL,
    fetched_at TEXT, rows INTEGER, message TEXT);
"""
ATTRIBUTION = {
    "wigle": "Data © WiGLE.net contributors (wigle.net)",
    "opencellid": "OpenCelliD Project, CC BY-SA 4.0 (opencellid.org)",
    "repeaterbook": "Data courtesy of RepeaterBook.com",
}
FIPS = dict(AL="01", AK="02", AZ="04", AR="05", CA="06", CO="08", CT="09", DE="10", DC="11", FL="12", GA="13",
            HI="15", ID="16", IL="17", IN="18", IA="19", KS="20", KY="21", LA="22", ME="23", MD="24", MA="25",
            MI="26", MN="27", MS="28", MO="29", MT="30", NE="31", NV="32", NH="33", NJ="34", NM="35", NY="36",
            NC="37", ND="38", OH="39", OK="40", OR="41", PA="42", RI="44", SC="45", SD="46", TN="47", TX="48",
            UT="49", VT="50", VA="51", WA="53", WV="54", WI="55", WY="56", PR="72")


def open_db(path):
    con = sqlite3.connect(path, timeout=60)
    con.executescript(SCHEMA)
    return con


def http_json(url, headers=None, timeout=40):
    req = urllib.request.Request(url, headers=dict({"User-Agent": UA, "Accept": "application/json"}, **(headers or {})))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def pick(d, *keys, default=None):
    for k in keys:
        if k in d and d[k] not in (None, ""):
            return d[k]
    return default


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def upsert(con, rows):
    con.executemany(
        """INSERT INTO ext_point(source,layer,ext_id,lat,lon,kind,label,freq_mhz,freq_in_mhz,dbm,mode,sig_type,
           first_seen,last_seen,details,fetched_at,attribution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(source,ext_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, label=excluded.label,
           freq_mhz=excluded.freq_mhz, dbm=excluded.dbm, mode=excluded.mode, sig_type=excluded.sig_type,
           last_seen=excluded.last_seen, details=excluded.details, fetched_at=excluded.fetched_at""", rows)
    con.commit()


def log_fetch(con, source, lat, lon, radius, n, msg):
    con.execute("INSERT INTO ext_fetch(source,lat,lon,radius_mi,fetched_at,rows,message) VALUES(?,?,?,?,?,?,?)",
                (source, lat, lon, radius, time.strftime("%Y-%m-%d %H:%M"), n, msg))
    con.commit()


# ---------------------------------------------------------------- WiGLE

def fetch_wigle(con, lat, lon, radius_mi, api_name, api_token, kinds=("network",), max_pages=5):
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    auth = "Basic " + base64.b64encode(f"{api_name}:{api_token}".encode()).decode()
    now = time.strftime("%Y-%m-%d %H:%M")
    total = 0
    for kind in kinds:
        search_after = None
        for _ in range(max_pages):
            q = dict(latrange1=s, latrange2=n, longrange1=w, longrange2=e, resultsPerPage=100)
            if search_after:
                q["searchAfter"] = search_after
            url = f"https://api.wigle.net/api/v2/{kind}/search?" + urllib.parse.urlencode(q)
            data = http_json(url, {"Authorization": auth})
            if data.get("success") is False:
                raise RuntimeError(data.get("message") or "WiGLE refused the request")
            res = data.get("results") or []
            rows = []
            for r in res:
                la, lo = fnum(pick(r, "trilat", "lat", "latitude")), fnum(pick(r, "trilong", "lon", "longitude"))
                if la is None or lo is None:
                    continue
                typ = (pick(r, "type", "gentype", default="") or "").upper()
                if kind == "bluetooth":
                    typ = typ if typ in ("BT", "BLE") else "BT"
                elif kind == "cell":
                    typ = typ or "LTE"
                else:
                    typ = "WIFI" if typ in ("", "INFRA", "ADHOC", "WIFI", "PROBE") else typ
                ch = pick(r, "channel")
                f = sigid.wifi_channel_to_mhz(ch, pick(r, "frequency")) if typ == "WIFI" else \
                    (2441.0 if typ in ("BT", "BLE") else None)
                c = sigid.classify(typ, f)
                ident = str(pick(r, "netid", "id", "bssid", default=""))
                rows.append(("wigle", f"WiGLE {kind}", f"{kind}:{ident}", la, lo, typ,
                             pick(r, "ssid", "name", default=""), f, None, None, pick(r, "encryption", default=""),
                             c["sig_type"], pick(r, "firsttime", default=""), pick(r, "lasttime", "lastupdt", default=""),
                             json.dumps(r), now, ATTRIBUTION["wigle"]))
            upsert(con, rows)
            total += len(rows)
            search_after = data.get("searchAfter")
            if not search_after or not res:
                break
    log_fetch(con, "wigle", lat, lon, radius_mi, total, "ok")
    return total


# ---------------------------------------------------------------- OpenCelliD

def fetch_opencellid(con, lat, lon, radius_mi, key, tile_km=1.9, max_requests=40):  # OpenCelliD refuses a box over 4 km²; 2 km tiles came out just over it
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    dlat = tile_km / 111.0
    dlon = tile_km / (111.0 * max(0.05, math.cos(math.radians(lat))))
    tiles = []
    y = s
    while y < n:
        x = w
        while x < e:
            tiles.append((y, x, min(y + dlat, n), min(x + dlon, e)))
            x += dlon
        y += dlat
    # nearest tiles first, so a request cap still covers the middle of the area
    tiles.sort(key=lambda t: geo.haversine_km(lat, lon, (t[0] + t[2]) / 2, (t[1] + t[3]) / 2))
    now = time.strftime("%Y-%m-%d %H:%M")
    total, reqs = 0, 0
    for la0, lo0, la1, lo1 in tiles:
        offset = 0
        while reqs < max_requests:
            q = dict(key=key, BBOX=f"{la0},{lo0},{la1},{lo1}", format="json", limit=50, offset=offset)
            data = http_json("https://opencellid.org/cell/getInArea?" + urllib.parse.urlencode(q))
            reqs += 1
            if isinstance(data, dict) and data.get("error"):
                raise RuntimeError(str(data.get("error")))
            cells = (data or {}).get("cells") or []
            rows = []
            for c in cells:
                la, lo = fnum(c.get("lat")), fnum(c.get("lon"))
                if la is None:
                    continue
                radio = (c.get("radio") or "").upper()
                ident = f"{c.get('mcc')}-{c.get('mnc')}-{c.get('lac') or c.get('tac')}-{c.get('cellid')}"
                st = sigid.classify("NR" if radio == "NR" else ("WCDMA" if radio == "UMTS" else radio))["sig_type"]
                rows.append(("opencellid", "OpenCelliD cells", ident, la, lo, radio, f"{radio} {ident}", None, None,
                             fnum(c.get("averageSignalStrength")) or None, radio, st, "", "", json.dumps(c), now,
                             ATTRIBUTION["opencellid"]))
            upsert(con, rows)
            total += len(rows)
            if len(cells) < 50:
                break
            offset += 50
        if reqs >= max_requests:
            break
    log_fetch(con, "opencellid", lat, lon, radius_mi, total, f"{reqs} requests")
    return total


# ---------------------------------------------------------------- RepeaterBook

def fetch_repeaterbook(con, lat, lon, radius_mi, token, state):
    fips = FIPS.get((state or "").upper())
    if not fips:
        raise ValueError("RepeaterBook needs the state for this location (search the area first).")
    url = "https://www.repeaterbook.com/api/export.php?" + urllib.parse.urlencode({"state_id": fips})
    data = http_json(url, {"X-RB-App-Token": token}, timeout=90)
    res = data.get("results") or []
    now = time.strftime("%Y-%m-%d %H:%M")
    rows = []
    for r in res:
        la, lo = fnum(pick(r, "Lat", "lat", "Latitude")), fnum(pick(r, "Long", "lon", "Longitude", "Lng"))
        if la is None or geo.haversine_km(lat, lon, la, lo) > radius_mi * geo.MI_KM:
            continue
        modes = [m for m, keys in (("Analog FM", ("FM Analog", "Analog")), ("DMR", ("DMR",)),
                                   ("P25", ("APCO P-25", "P-25", "P25")), ("NXDN", ("NXDN",)),
                                   ("D-Star", ("D-Star", "DStar")), ("Fusion", ("System Fusion", "YSF")))
                 if str(pick(r, *keys, default="")).strip().lower() in ("yes", "1", "true")]
        tone = pick(r, "PL", "CTCSS", default="")
        cc = pick(r, "DMR Color Code", default="")
        nac = pick(r, "P-25 NAC", "P25 NAC", default="")
        det = dict(r)
        label = f"{pick(r, 'Callsign', default='')} {pick(r, 'Nearest City', default='')}".strip()
        mode_txt = " / ".join(modes) or "Analog FM"
        if tone:
            mode_txt += f" · PL {tone}"
        if cc:
            mode_txt += f" · CC {cc}"
        if nac:
            mode_txt += f" · NAC {nac}"
        primary = "DMR" if "DMR" in modes else "P25 Phase 1" if "P25" in modes else "NXDN" if "NXDN" in modes else "Analog FM"
        rows.append(("repeaterbook", "RepeaterBook repeaters",
                     str(pick(r, "Rptr ID", "State ID", default=f"{la},{lo},{pick(r, 'Frequency')}")) +
                     f":{pick(r, 'Frequency')}", la, lo, "REPEATER", label, fnum(pick(r, "Frequency")),
                     fnum(pick(r, "Input Freq", "Input")), None, mode_txt, primary, "",
                     str(pick(r, "Last Edited", "Last Update", default="")), json.dumps(det), now,
                     ATTRIBUTION["repeaterbook"]))
    upsert(con, rows)
    log_fetch(con, "repeaterbook", lat, lon, radius_mi, len(rows), f"state {state}")
    return len(rows)


# ---------------------------------------------------------------- custom layers

def import_custom(con, layer_name, filename, data):
    """CSV / KML / KMZ (via the capture parsers) or GeoJSON points -> named layer."""
    now = time.strftime("%Y-%m-%d %H:%M")
    pts = []
    if filename.lower().endswith((".geojson", ".json")):
        gj = json.loads(data.decode("utf-8", "replace"))
        for i, ft in enumerate(gj.get("features", [])):
            g = ft.get("geometry") or {}
            if g.get("type") != "Point":
                continue
            pr = ft.get("properties") or {}
            low = {k.lower(): v for k, v in pr.items()}
            pts.append(dict(lat=g["coordinates"][1], lon=g["coordinates"][0],
                            label=str(low.get("name") or low.get("label") or low.get("title") or ""),
                            freq_mhz=fnum(low.get("freq_mhz") or low.get("frequency") or low.get("freq")),
                            dbm=fnum(low.get("dbm") or low.get("rssi")), kind=str(low.get("type") or low.get("mode") or "RF"),
                            extra=pr))
    else:
        _, pts, _ = captures.parse_any(filename, data, {})
    rows = []
    for i, p in enumerate(pts):
        if p.get("lat") is None:
            continue
        c = sigid.classify(p.get("declared") or p.get("kind"), p.get("freq_mhz"), p.get("bw_khz"))
        rows.append(("custom", layer_name, f"{layer_name}:{i}:{p['lat']:.6f},{p['lon']:.6f}", p["lat"], p["lon"],
                     p.get("kind") or "RF", p.get("label") or "", p.get("freq_mhz"), None, p.get("dbm"),
                     p.get("kind") or "", c["sig_type"], p.get("ts") or "", p.get("ts") or "",
                     json.dumps(p.get("extra")) if p.get("extra") else None, now, f"Imported: {filename}"))
    con.execute("DELETE FROM ext_point WHERE source='custom' AND layer=?", (layer_name,))
    upsert(con, rows)
    return len(rows)
