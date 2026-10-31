"""
Import field captures (with GPS) into RF Recon.

Formats (auto-detected):
  * WiGLE CSV (WigleWifi-1.x) - also what Kismet exports with "wiglecsv"
  * GPX tracks / waypoints
  * rtl_power / hackrf_sweep CSV sweeps (positions from a GPX track by time,
    or from the mission point if no track)
  * Generic CSV from analyzers / survey tools: any columns named like
    lat, lon, freq (MHz/Hz), dbm/rssi/level, time, type/mode, label/ssid, bw
  * KML / KMZ placemarks and tracks (ExtendedData fields are read too)
"""
import bisect
import csv
import io
import json
import re
import statistics
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

import sigid

SCHEMA = """
CREATE TABLE IF NOT EXISTS capture(id INTEGER PRIMARY KEY, mission_id INTEGER, name TEXT, fmt TEXT,
    imported_at TEXT, points INTEGER, track_points INTEGER, notes TEXT);
CREATE TABLE IF NOT EXISTS capture_point(id INTEGER PRIMARY KEY, capture_id INTEGER, mission_id INTEGER,
    ts TEXT, lat REAL, lon REAL, alt REAL, acc REAL, kind TEXT, ident TEXT, label TEXT,
    freq_mhz REAL, channel TEXT, dbm REAL, bw_khz REAL, auth TEXT,
    sig_type TEXT, sig_conf TEXT, sig_basis TEXT, extra TEXT);
CREATE INDEX IF NOT EXISTS cp_latlon ON capture_point(lat, lon);
CREATE INDEX IF NOT EXISTS cp_mission ON capture_point(mission_id);
CREATE TABLE IF NOT EXISTS track_point(capture_id INTEGER, mission_id INTEGER, ts TEXT, lat REAL, lon REAL, alt REAL);
CREATE INDEX IF NOT EXISTS tp_capture ON track_point(capture_id);
"""

KML_NS = {"k": "http://www.opengis.net/kml/2.2", "gx": "http://www.google.com/kml/ext/2.2"}


def fnum(v):
    try:
        v = str(v).strip()
        return float(v) if v not in ("", "NaN", "nan", "None") else None
    except (TypeError, ValueError):
        return None


def parse_ts(s):
    if not s:
        return None
    s = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ",
                "%Y-%m-%d %H:%M:%S.%f", "%Y/%m/%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%Y-%m-%d, %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    v = fnum(s)
    if v and v > 1e9:  # epoch seconds / ms
        return datetime.fromtimestamp(v / 1000 if v > 1e12 else v, tz=timezone.utc)
    return None


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


# ---------------------------------------------------------------- detection

def detect(name, data):
    n = name.lower()
    head = data[:4096].decode("utf-8", "replace")
    if n.endswith(".kmz"):
        return "kmz"
    if n.endswith(".kml") or "<kml" in head[:500]:
        return "kml"
    if n.endswith(".gpx") or "<gpx" in head[:500]:
        return "gpx"
    first = head.splitlines()[0] if head else ""
    if first.startswith("WigleWifi"):
        return "wigle"
    parts = [p.strip() for p in first.split(",")]
    if len(parts) > 7 and re.match(r"\d{4}-\d{2}-\d{2}$", parts[0]) and re.match(r"\d{1,2}:\d{2}:\d{2}", parts[1]) \
            and fnum(parts[2]) and fnum(parts[3]) and fnum(parts[2]) > 1e5:
        return "sweep"
    return "csv"


# ---------------------------------------------------------------- parsers

def parse_wigle(text):
    lines = text.splitlines()
    if lines and lines[0].startswith("WigleWifi"):
        lines = lines[1:]
    pts = []
    for r in csv.DictReader(lines):
        g = lambda *ks: next((r[k] for k in ks if k in r and r[k] not in (None, "")), "")
        typ = g("Type").upper() or "WIFI"
        freq_raw, ch = g("Frequency"), g("Channel")
        if typ == "WIFI":
            f = sigid.wifi_channel_to_mhz(ch, freq_raw)
        elif typ == "LTE":
            f = sigid.earfcn_to_dl_mhz(freq_raw)
        elif typ == "NR":
            f = sigid.nrarfcn_to_mhz(freq_raw)
        elif typ in ("BT", "BLE"):
            f = 2441.0
        else:
            f = None
        pts.append(dict(ts=iso(parse_ts(g("FirstSeen", "First timestamp seen"))),
                        lat=fnum(g("CurrentLatitude", "Latitude")), lon=fnum(g("CurrentLongitude", "Longitude")),
                        alt=fnum(g("AltitudeMeters", "Altitude")), acc=fnum(g("AccuracyMeters", "Accuracy")),
                        kind=typ, ident=g("MAC", "BSSID"), label=g("SSID"), freq_mhz=f, channel=ch or freq_raw,
                        dbm=fnum(g("RSSI")), auth=g("AuthMode", "Capabilities"), declared=typ))
    return pts, []


def parse_gpx(text):
    root = ET.fromstring(text)
    ns = {"g": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {"g": ""}
    q = (lambda t: f"g:{t}") if ns["g"] else (lambda t: t)
    track, pts = [], []
    for tp in root.iter(("{%s}" % ns["g"] if ns["g"] else "") + "trkpt"):
        t = tp.find(q("time"), ns) if ns["g"] else tp.find("time")
        e = tp.find(q("ele"), ns) if ns["g"] else tp.find("ele")
        track.append(dict(ts=iso(parse_ts(t.text)) if t is not None else None, lat=fnum(tp.get("lat")),
                          lon=fnum(tp.get("lon")), alt=fnum(e.text) if e is not None else None))
    for wp in root.iter(("{%s}" % ns["g"] if ns["g"] else "") + "wpt"):
        nm = wp.find(q("name"), ns) if ns["g"] else wp.find("name")
        ds = wp.find(q("desc"), ns) if ns["g"] else wp.find("desc")
        t = wp.find(q("time"), ns) if ns["g"] else wp.find("time")
        txt = " ".join(x.text or "" for x in (nm, ds) if x is not None)
        f = re.search(r"(\d{2,5}\.\d+)\s*MHz", txt, re.I)
        d = re.search(r"(-\d{2,3}(?:\.\d+)?)\s*dBm", txt, re.I)
        pts.append(dict(ts=iso(parse_ts(t.text)) if t is not None else None, lat=fnum(wp.get("lat")),
                        lon=fnum(wp.get("lon")), label=(nm.text if nm is not None else ""), kind="RF",
                        freq_mhz=float(f.group(1)) if f else None, dbm=float(d.group(1)) if d else None))
    return pts, track


ALIASES = {
    "lat": ["lat", "latitude", "currentlatitude", "gps_lat", "y"],
    "lon": ["lon", "lng", "long", "longitude", "currentlongitude", "gps_lon", "x"],
    "alt": ["alt", "altitude", "altitudemeters", "elevation", "ele"],
    "acc": ["acc", "accuracy", "accuracymeters", "hdop"],
    "ts": ["time", "timestamp", "datetime", "date_time", "utc", "firstseen", "ts"],
    "freq": ["freq_mhz", "frequency_mhz", "freq", "frequency", "center_frequency", "cf", "fc", "frequency_hz", "freq_hz"],
    "dbm": ["dbm", "rssi", "level", "power", "power_dbm", "signal", "signal_dbm", "amplitude", "rx_dbm", "rsrp"],
    "kind": ["type", "tech", "technology", "mode", "modulation", "signal_type", "protocol"],
    "label": ["label", "name", "ssid", "description", "desc", "id", "talkgroup", "callsign"],
    "ident": ["mac", "bssid", "cell_id", "cellid", "pci", "nac", "color_code", "ident"],
    "bw": ["bw_khz", "bandwidth_khz", "bw", "bandwidth", "rbw"],
    # the direction a signal came from (a direction-finding antenna or a hand bearing); not the vehicle's heading
    "bearing": ["bearing", "bearing_deg", "azimuth", "azimuth_deg", "az", "doa", "aoa", "direction_deg"],
}


def parse_csv(text, delimiter=None):
    sample = text[:5000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|") if not delimiter else None
    except csv.Error:
        dialect = None
    rd = csv.DictReader(io.StringIO(text), dialect=dialect) if dialect else csv.DictReader(io.StringIO(text))
    cols = {re.sub(r"[^a-z0-9_]", "", (c or "").strip().lower().replace(" ", "_")): c for c in (rd.fieldnames or [])}

    def pick(key):
        for a in ALIASES[key]:
            if a in cols:
                return cols[a]
        return None
    m = {k: pick(k) for k in ALIASES}
    if not (m["lat"] and m["lon"]):
        raise ValueError("CSV needs latitude and longitude columns (e.g. lat, lon).")
    fcol = m["freq"] or ""
    hz = "hz" in fcol.lower() and "mhz" not in fcol.lower()
    pts = []
    for r in rd:
        f = fnum(r.get(m["freq"])) if m["freq"] else None
        if f is not None and (hz or f > 1e6):
            f = f / 1e6
        bw = fnum(r.get(m["bw"])) if m["bw"] else None
        if bw and bw > 1e4:  # given in Hz
            bw = bw / 1000
        kind = (r.get(m["kind"]) or "").strip() if m["kind"] else ""
        extra = {k: v for k, v in r.items() if k not in m.values() and v not in ("", None)}
        brg = fnum(r.get(m["bearing"])) if m["bearing"] else None
        if brg is not None:
            extra["bearing"] = brg % 360
        pts.append(dict(ts=iso(parse_ts(r.get(m["ts"]))) if m["ts"] else None, lat=fnum(r.get(m["lat"])),
                        lon=fnum(r.get(m["lon"])), alt=fnum(r.get(m["alt"])) if m["alt"] else None,
                        acc=fnum(r.get(m["acc"])) if m["acc"] else None, kind=kind.upper() or "RF",
                        declared=kind, label=(r.get(m["label"]) or "") if m["label"] else "",
                        ident=(r.get(m["ident"]) or "") if m["ident"] else "", freq_mhz=f,
                        dbm=fnum(r.get(m["dbm"])) if m["dbm"] else None, bw_khz=bw, extra=extra))
    return pts, []


def parse_sweep(text, threshold_db=10.0, min_db=None):
    """rtl_power / hackrf_sweep rows: date, time, hz_low, hz_high, hz_step, samples, dB, dB...
    Emits a peak point for each bin at least threshold_db above that row's median floor.
    Note: these levels are relative dB (dBFS), not calibrated dBm."""
    pts = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7:
            continue
        ts = parse_ts(f"{row[0].strip()} {row[1].strip()}")
        lo, hi, step = fnum(row[2]), fnum(row[3]), fnum(row[4])
        vals = [fnum(x) for x in row[6:]]
        vals = [v for v in vals if v is not None]
        if not vals or lo is None or not step:
            continue
        floor = statistics.median(vals)
        for i, v in enumerate(vals):
            if v - floor >= threshold_db and (min_db is None or v >= min_db):
                left = vals[i - 1] if i else -1e9
                right = vals[i + 1] if i + 1 < len(vals) else -1e9
                if v >= left and v >= right:  # local peak
                    f = (lo + step * (i + 0.5)) / 1e6
                    pts.append(dict(ts=iso(ts), lat=None, lon=None, kind="RF", freq_mhz=round(f, 5), dbm=v,
                                    bw_khz=round(step / 1000, 3), extra={"floor_db": round(floor, 1),
                                    "snr_db": round(v - floor, 1), "units": "dB relative (uncalibrated)"}))
    return pts, []


def parse_kml_text(text):
    root = ET.fromstring(text)
    pts, track = [], []
    for pm in root.iter("{%s}Placemark" % KML_NS["k"]):
        name = pm.findtext("k:name", default="", namespaces=KML_NS)
        desc = pm.findtext("k:description", default="", namespaces=KML_NS)
        data = {d.get("name"): d.findtext("k:value", default="", namespaces=KML_NS)
                for d in pm.iter("{%s}Data" % KML_NS["k"])}
        for sd in pm.iter("{%s}SimpleData" % KML_NS["k"]):
            data[sd.get("name")] = sd.text or ""
        ts = pm.findtext(".//k:TimeStamp/k:when", default=None, namespaces=KML_NS)
        low = {k.lower(): v for k, v in data.items()}

        def dv(*keys):
            for k in keys:
                if k in low and low[k] != "":
                    return low[k]
            return None
        blob = f"{name} {desc} " + " ".join(f"{k}={v}" for k, v in data.items())
        f = fnum(dv("freq_mhz", "frequency", "freq"))
        if f is None:
            mm = re.search(r"(\d{2,5}\.\d+)\s*MHz", blob, re.I)
            f = float(mm.group(1)) if mm else None
        d = fnum(dv("dbm", "rssi", "level", "power"))
        if d is None:
            mm = re.search(r"(-\d{2,3}(?:\.\d+)?)\s*dBm", blob, re.I)
            d = float(mm.group(1)) if mm else None
        kind = dv("type", "mode", "tech") or ""
        for pt in pm.iter("{%s}Point" % KML_NS["k"]):
            c = (pt.findtext("k:coordinates", default="", namespaces=KML_NS) or "").strip().split(",")
            if len(c) >= 2:
                pts.append(dict(ts=iso(parse_ts(ts)), lat=fnum(c[1]), lon=fnum(c[0]),
                                alt=fnum(c[2]) if len(c) > 2 else None, kind=(kind or "RF").upper(),
                                declared=kind, label=name, freq_mhz=f, dbm=d, extra=data or None))
        for ls in pm.iter("{%s}LineString" % KML_NS["k"]):
            for c in (ls.findtext("k:coordinates", default="", namespaces=KML_NS) or "").split():
                p = c.split(",")
                if len(p) >= 2:
                    track.append(dict(ts=None, lat=fnum(p[1]), lon=fnum(p[0]), alt=fnum(p[2]) if len(p) > 2 else None))
        for tr in pm.iter("{%s}Track" % KML_NS["gx"]):
            whens = [w.text for w in tr.iter("{%s}when" % KML_NS["k"])]
            coords = [c.text for c in tr.iter("{%s}coord" % KML_NS["gx"])]
            for w, c in zip(whens, coords):
                p = (c or "").split()
                if len(p) >= 2:
                    track.append(dict(ts=iso(parse_ts(w)), lat=fnum(p[1]), lon=fnum(p[0]),
                                      alt=fnum(p[2]) if len(p) > 2 else None))
    return pts, track


def parse_kmz(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
        if not name:
            raise ValueError("KMZ has no KML inside.")
        return parse_kml_text(z.read(name).decode("utf-8", "replace"))


# ---------------------------------------------------------------- positioning

def position_by_track(points, track, max_gap_s=30):
    """Give un-located points a position from the GPS track, by nearest time."""
    tr = sorted((parse_ts(t["ts"]), t) for t in track if t.get("ts") and t.get("lat") is not None)
    tr = [(d.timestamp(), t) for d, t in tr if d]
    if not tr:
        return 0
    times = [t for t, _ in tr]
    n = 0
    for p in points:
        if p.get("lat") is not None or not p.get("ts"):
            continue
        d = parse_ts(p["ts"])
        if not d:
            continue
        x = d.timestamp()
        i = bisect.bisect_left(times, x)
        best = min((j for j in (i - 1, i) if 0 <= j < len(times)), key=lambda j: abs(times[j] - x))
        if abs(times[best] - x) <= max_gap_s:
            p["lat"], p["lon"] = tr[best][1]["lat"], tr[best][1]["lon"]
            p["alt"] = tr[best][1].get("alt")
            n += 1
    return n


# ---------------------------------------------------------------- import

def parse_any(name, data, settings):
    fmt = detect(name, data)
    text = None if fmt == "kmz" else data.decode("utf-8", "replace")
    if fmt == "wigle":
        pts, track = parse_wigle(text)
    elif fmt == "gpx":
        pts, track = parse_gpx(text)
    elif fmt == "sweep":
        pts, track = parse_sweep(text, float(settings.get("sweep_threshold_db", 10)), settings.get("min_dbm"))
    elif fmt == "kml":
        pts, track = parse_kml_text(text)
    elif fmt == "kmz":
        pts, track = parse_kmz(data)
    else:
        pts, track = parse_csv(text)
    return fmt, pts, track


def store(con, mission_id, name, fmt, pts, track, settings, uls_lookup, extra_track=None, fixed_point=None):
    """Classify, filter by mission settings and save. Returns summary dict."""
    con.executescript(SCHEMA)
    track = list(track)  # this file's own GPS track (stored)
    located = position_by_track(pts, track + list(extra_track or []), int(settings.get("track_match_s", 30)))
    if fixed_point:
        for p in pts:
            if p.get("lat") is None:
                p["lat"], p["lon"] = fixed_point
    max_acc = settings.get("gps_max_accuracy_m")
    min_dbm = settings.get("min_dbm")
    kept, dropped_acc, dropped_lvl, no_pos = [], 0, 0, 0
    for p in pts:
        if p.get("lat") is None or p.get("lon") is None:
            no_pos += 1
            continue
        if max_acc and p.get("acc") and p["acc"] > float(max_acc):
            dropped_acc += 1
            continue
        if min_dbm is not None and min_dbm != "" and p.get("dbm") is not None and fmt != "sweep" \
                and p["dbm"] < float(min_dbm):
            dropped_lvl += 1
            continue
        match = None
        if p.get("freq_mhz") and not p.get("declared") and uls_lookup:
            match = uls_lookup(p["freq_mhz"], p["lat"], p["lon"])
        c = sigid.classify(p.get("declared"), p.get("freq_mhz"), p.get("bw_khz"), match)
        p.update(sig_type=c["sig_type"], sig_conf=c["confidence"], sig_basis=c["basis"])
        if match:
            p.setdefault("extra", {})
            p["extra"] = dict(p["extra"] or {}, uls_call=match.get("call_sign"), uls_licensee=match.get("licensee"))
        kept.append(p)
    cur = con.execute("INSERT INTO capture(mission_id,name,fmt,imported_at,points,track_points,notes) VALUES(?,?,?,?,?,?,?)",
                      (mission_id, name, fmt, iso(datetime.now(timezone.utc)), len(kept), len(track), ""))
    cid = cur.lastrowid
    con.executemany(
        "INSERT INTO capture_point(capture_id,mission_id,ts,lat,lon,alt,acc,kind,ident,label,freq_mhz,channel,dbm,"
        "bw_khz,auth,sig_type,sig_conf,sig_basis,extra) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(cid, mission_id, p.get("ts"), p["lat"], p["lon"], p.get("alt"), p.get("acc"), p.get("kind"), p.get("ident"),
          p.get("label"), p.get("freq_mhz"), p.get("channel"), p.get("dbm"), p.get("bw_khz"), p.get("auth"),
          p.get("sig_type"), p.get("sig_conf"), p.get("sig_basis"),
          json.dumps(p["extra"]) if p.get("extra") else None) for p in kept])
    con.executemany("INSERT INTO track_point(capture_id,mission_id,ts,lat,lon,alt) VALUES(?,?,?,?,?,?)",
                    [(cid, mission_id, t.get("ts"), t["lat"], t["lon"], t.get("alt")) for t in track
                     if t.get("lat") is not None])
    con.commit()
    types = {}
    for p in kept:
        types[p["sig_type"]] = types.get(p["sig_type"], 0) + 1
    return {"capture_id": cid, "format": fmt, "points": len(kept), "track_points": len(track),
            "positioned_from_track": located, "dropped_no_position": no_pos,
            "dropped_accuracy": dropped_acc, "dropped_below_min_dbm": dropped_lvl, "types": types}
