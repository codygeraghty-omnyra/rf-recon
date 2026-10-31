"""
Open sources that need no key, fetched for an area into the crowd database beside WiGLE and OpenCelliD:
  ttn          The Things Network LoRaWAN gateways (Packet Broker mapper API, a radius search)
  satnogs      SatNOGS satellite ground stations (one list of every station, kept to the area)
  wspr         WSPR stations heard or transmitting in the area in the last 24 hours (wspr.live)
  pskreporter  PSKReporter monitors and the stations they heard in the area in the last hour

Every request is HTTPS only, has a timeout and a size cap, and is parsed as data (JSON, or XML with any DOCTYPE
refused); coordinates are checked; text stays text (the page escapes it). Before downloading, an area this source
already fetched recently is skipped (the fetch log says so), and each record is keyed by the source's own ID, so a
fetch updates what is there instead of adding copies. Terms and limits: reference/data_sources.json.
"""
import json
import math
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import connectors
import geo

UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)"}
MAX_BYTES = 12_000_000
SOURCES = {  # id: (layer label, how long a fetched area counts as fresh, attribution)
    "ttn": ("TTN LoRaWAN gateways", 24 * 7, "The Things Network gateways via Packet Broker"),
    "satnogs": ("SatNOGS ground stations", 24 * 7, "SatNOGS Network, CC BY-SA 4.0"),
    "wspr": ("WSPR stations", 6, "WSPR spots from wspr.live (non-commercial)"),
    "pskreporter": ("PSKReporter stations", 1, "PSKReporter (pskreporter.info)"),
}


def get(url, timeout=40):
    if not url.startswith("https://"):
        raise ValueError("Only HTTPS sources are allowed.")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("The source sent more than RF Recon accepts in one answer.")
    return data


def ok_ll(la, lo):
    try:
        la, lo = float(la), float(lo)
    except (TypeError, ValueError):
        return None
    return (la, lo) if -90 <= la <= 90 and -180 <= lo <= 180 and (la, lo) != (0.0, 0.0) else None


def maidenhead(loc):
    """A Maidenhead locator (4 or 6 characters) -> the centre of its square."""
    s = (loc or "").strip()
    if len(s) < 4 or not (s[:2].isalpha() and s[2:4].isdigit()):
        return None
    s = s[:6] if len(s) >= 6 and s[4:6].isalpha() else s[:4]
    lon = (ord(s[0].upper()) - 65) * 20 - 180 + int(s[2]) * 2
    lat = (ord(s[1].upper()) - 65) * 10 - 90 + int(s[3])
    if len(s) == 6:
        lon += (ord(s[4].lower()) - 97) * 5 / 60 + 2.5 / 60
        lat += (ord(s[5].lower()) - 97) * 2.5 / 60 + 1.25 / 60
    else:
        lon, lat = lon + 1, lat + 0.5
    return ok_ll(lat, lon)


def grid_of(lat, lon):
    lon, lat = lon + 180, lat + 90
    return f"{chr(65 + int(lon // 20))}{chr(65 + int(lat // 10))}{int(lon % 20 // 2)}{int(lat % 10)}"


def recent(con, source, lat, lon, radius_mi, hours):
    """True when this source fetched an area covering this one within `hours` (so it isn't downloaded again)."""
    since = time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - hours * 3600))
    for la, lo, rad in con.execute("SELECT lat, lon, radius_mi FROM ext_fetch WHERE source=? AND fetched_at>=? AND lat IS NOT NULL",
                                   (source, since)):
        if rad and geo.haversine_km(lat, lon, la, lo) / geo.MI_KM + radius_mi <= rad + 0.01:
            return True
    return False


def fetch(con, source, lat, lon, radius_mi, force=False):
    """Fetch one source for an area. Returns the number of records written, or -1 when skipped as already fresh."""
    if source not in SOURCES:
        raise ValueError(f"Unknown source {source}")
    label, fresh_h, attribution = SOURCES[source]
    if not force and recent(con, source, lat, lon, radius_mi, fresh_h):
        return -1
    now = time.strftime("%Y-%m-%d %H:%M")
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    rows = []

    def add(ext_id, ll, kind, name, freq, mode, sig, first, last, det, layer=label):
        if ll and s <= ll[0] <= n and w <= ll[1] <= e:
            rows.append((source, layer, ext_id, ll[0], ll[1], kind, str(name)[:200], freq, None, None, mode, sig,
                         first or "", last or "", json.dumps(det)[:20000], now, attribution))

    if source == "ttn":
        q = {"distanceWithin[latitude]": lat, "distanceWithin[longitude]": lon,
             "distanceWithin[distance]": int(radius_mi * geo.MI_KM * 1000), "netID": "000013", "tenantID": "ttn", "limit": 1000}
        for g in json.loads(get("https://mapper.packetbroker.net/api/v2/gateways?" + urllib.parse.urlencode(q))) or []:
            loc = g.get("location") or {}
            add(f"ttn:{g.get('eui') or g.get('id')}", ok_ll(loc.get("latitude"), loc.get("longitude")), "LoRaWAN",
                g.get("id") or g.get("eui"), 915.0, "LoRaWAN gateway" + (" (online)" if g.get("online") else ""), "LoRa", "",
                g.get("updatedAt", "")[:10], {k: g.get(k) for k in ("id", "eui", "clusterID", "antennaPlacement", "antennaCount", "online", "updatedAt")})
    elif source == "satnogs":
        for st in json.loads(get("https://network.satnogs.org/api/stations/?format=json", timeout=90)):
            ants = st.get("antenna") or []
            f = (ants[0].get("frequency") or 0) / 1e6 if ants else None
            add(f"satnogs:{st.get('id')}", ok_ll(st.get("lat"), st.get("lng")), "Ground station", st.get("name"), f or None,
                ", ".join(f"{a.get('band')} {a.get('antenna_type_name')}" for a in ants)[:200], "Satellite ground station",
                (st.get("created") or "")[:10], (st.get("last_seen") or "")[:10],
                {k: st.get(k) for k in ("id", "name", "status", "altitude", "qthlocator", "observations", "antenna", "description")})
    elif source == "wspr":
        box = f"BETWEEN {s:.4f} AND {n:.4f}", f"BETWEEN {w:.4f} AND {e:.4f}"  # numbers only: nothing from outside goes in
        for side in ("rx", "tx"):
            sql = (f"SELECT {side}_sign, any({side}_lat), any({side}_lon), count(), max(time), groupUniqArray(band)"
                   + (", max(power)" if side == "tx" else "")
                   + f" FROM wspr.rx WHERE time > now() - INTERVAL 24 HOUR AND {side}_lat {box[0]} AND {side}_lon {box[1]}"
                   + f" GROUP BY {side}_sign LIMIT 500 FORMAT JSONCompact")
            data = json.loads(get("https://db1.wspr.live/?" + urllib.parse.urlencode({"query": sql})))
            for row in data.get("data", []):
                sign, la, lo, spots, last, bands = row[:6]
                add(f"call:{sign}", ok_ll(la, lo), "WSPR", sign, None, f"WSPR {'receiver' if side == 'rx' else 'transmitter'}: {spots} spots, bands {bands}",
                    "WSPR", "", str(last)[:16], {"callsign": sign, "role": "receiver" if side == "rx" else "transmitter", "spots_24h": spots,
                                                "bands": bands, "power_dbm": row[6] if side == "tx" else None},
                    layer="WSPR receivers" if side == "rx" else "WSPR transmitters")
    elif source == "pskreporter":  # one query a fetch (its rule: at most every five minutes); the fetch log enforces an hour
        data = get("https://retrieve.pskreporter.info/query?" + urllib.parse.urlencode(
            {"callsign": grid_of(lat, lon), "modify": "grid", "flowStartSeconds": -3600, "appcontact": "rfrecon"}), timeout=60)
        if b"<!DOCTYPE" in data[:2000].upper():
            raise ValueError("PSKReporter's answer had a DOCTYPE; refused.")
        root = ET.fromstring(data)
        for el in root.iter("activeReceiver"):
            a = el.attrib
            f = float(a["frequency"]) / 1e6 if a.get("frequency", "").isdigit() else None
            add(f"call:{a.get('callsign')}", maidenhead(a.get("locator")), a.get("mode", ""), a.get("callsign"), f,
                f"PSKReporter monitor ({a.get('mode', '')})", a.get("mode") or "Unknown", "", "",
                {k: a.get(k) for k in ("callsign", "locator", "mode", "bands", "decoderSoftware", "antennaInformation", "rigInformation")},
                layer="PSKReporter monitors")
        for el in root.iter("receptionReport"):
            a = el.attrib
            f = float(a["frequency"]) / 1e6 if a.get("frequency", "").isdigit() else None
            add(f"call:{a.get('senderCallsign')}", maidenhead(a.get("senderLocator")), a.get("mode", ""), a.get("senderCallsign"), f,
                f"Heard on PSKReporter ({a.get('mode', '')})", a.get("mode") or "Unknown", "", time.strftime("%Y-%m-%d %H:%M", time.gmtime(int(a.get("flowStartSeconds", "0") or 0))),
                {"callsign": a.get("senderCallsign"), "locator": a.get("senderLocator"), "heard_by": a.get("receiverCallsign"), "snr": a.get("sNR"), "mode": a.get("mode")},
                layer="PSKReporter stations heard")
    seen = {}
    for r in rows:  # one record per ID per fetch (a station can appear many times in one answer)
        seen[(r[0], r[2])] = r
    connectors.upsert(con, list(seen.values()))
    connectors.log_fetch(con, source, lat, lon, radius_mi, len(seen), "ok")
    return len(seen)


# ---------------------------------------------------------------- one entry per real emitter when the map draws

PRIORITY = ["captures", "opencellid", "wigle", "repeaterbook", "ttn", "satnogs", "wspr", "pskreporter", "custom"]
COMPARE = ("freq_mhz", "label", "mode", "channel", "dbm", "kind", "first_seen", "last_seen")


def identity(r):
    """What makes two crowd records the same emitter: the cell's ID, the radio's MAC, a station's callsign or an EUI."""
    import cells
    ext = str(r.get("ext_id") or "")
    p = cells.parse_id(ext) if (r.get("kind") or "").upper() in cells.CELL_KINDS else None
    if p:
        return f"cell:{p[0]}-{int(p[1])}-{p[3]}"
    if ext.startswith(("network:", "bluetooth:")):
        return "mac:" + ext.split(":", 1)[1].lower()
    if ext.startswith(("call:", "ttn:")):
        return ext.lower()
    return None


def merge(rows):
    """Crowd records that are the same emitter become one row: the most trusted source leads, every source is named
    (also_in), fields the others add are filled in, and where sources disagree both values are kept (conflicts)."""
    groups, out = {}, []
    for r in rows:
        k = identity(r)
        if k is None:
            out.append(r)
        else:
            groups.setdefault(k, []).append(r)
    for k, rs in groups.items():
        if len(rs) == 1 and len({x["layer"] for x in rs}) == 1:
            out.append(rs[0])
            continue
        rs.sort(key=lambda x: PRIORITY.index(x["layer"]) if x["layer"] in PRIORITY else 99)
        lead = dict(rs[0])
        names = []
        conflicts = {}
        for x in rs:
            nm = x.get("category") or x["layer"]
            if nm not in names:
                names.append(nm)
            for f in COMPARE:
                v = x.get(f)
                if v in (None, ""):
                    continue
                if lead.get(f) in (None, ""):
                    lead[f] = v
                vals = conflicts.setdefault(f, [])
                if all(str(v) != str(o[1]) for o in vals):
                    vals.append([nm, v])
        d = geo.haversine_km(rs[0]["lat"], rs[0]["lon"], rs[-1]["lat"], rs[-1]["lon"]) if len(rs) > 1 else 0
        lead["also_in"] = names[1:]
        lead["merged_from"] = len(rs)
        lead["conflicts"] = {f: v for f, v in conflicts.items() if len(v) > 1}
        if d > 0.05:
            lead["conflicts"]["position"] = [[x.get("category") or x["layer"], f"{x['lat']:.5f}, {x['lon']:.5f}"] for x in rs]
        out.append(lead)
    return out
