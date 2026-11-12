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
import http.client
import io
import json
import math
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import captures
import geo
import provenance
import sigid

UA = "RF-Recon/2.0 (local site-survey tool)"
SCHEMA = """
CREATE TABLE IF NOT EXISTS ext_point(id INTEGER PRIMARY KEY, source TEXT, layer TEXT, ext_id TEXT,
    lat REAL, lon REAL, kind TEXT, label TEXT, freq_mhz REAL, freq_in_mhz REAL, dbm REAL, mode TEXT,
    sig_type TEXT, first_seen TEXT, last_seen TEXT, details TEXT, fetched_at TEXT, attribution TEXT,
    UNIQUE(source, ext_id));
CREATE INDEX IF NOT EXISTS ext_latlon ON ext_point(lat, lon);
CREATE TABLE IF NOT EXISTS ext_fetch(id INTEGER PRIMARY KEY, source TEXT, lat REAL, lon REAL, radius_mi REAL,
    fetched_at TEXT, rows INTEGER, message TEXT, requests INTEGER, reached_km REAL);
CREATE TABLE IF NOT EXISTS ext_point_hist(id INTEGER PRIMARY KEY, point_id INTEGER, source TEXT, ext_id TEXT, lat REAL,
    lon REAL, label TEXT, freq_mhz REAL, dbm REAL, mode TEXT, sig_type TEXT, last_seen TEXT, details TEXT,
    fetched_at TEXT, replaced_at TEXT);
CREATE INDEX IF NOT EXISTS ext_hist_point ON ext_point_hist(source, ext_id);
"""
# provenance (provenance.py), added 2026-11-02; older copies gain them when the database opens
PROV_COLS = (("origin_group", "TEXT"), ("method", "TEXT"), ("licence", "TEXT"), ("precision_m", "REAL"),
             ("as_of", "TEXT"), ("derived_from", "TEXT"))
HIST_FIELDS = ("lat", "lon", "label", "freq_mhz", "dbm", "mode", "sig_type", "last_seen", "details")
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
    migrate(con)
    return con


def migrate_fetch(con):
    """ext_fetch.requests (11/10): how many requests each fetch made, so a day's OpenCelliD budget counts requests, not
    fetches (requests_today); and reached_km (review 11/10): how far from its centre every tile of a fetch came in whole,
    what it covers (cells.covered). A crowd database made before them gains the columns, empty for the old rows."""
    have = {r[1] for r in con.execute("PRAGMA table_info(ext_fetch)")}
    for col in ("requests INTEGER", "reached_km REAL"):
        if have and col.split()[0] not in have:
            con.execute(f"ALTER TABLE ext_fetch ADD COLUMN {col}")
            con.commit()


def migrate(con):
    """Add the provenance columns to a crowd database made before 11/2 and fill them from each row's source."""
    migrate_fetch(con)
    have = {r[1] for r in con.execute("PRAGMA table_info(ext_point)")}
    missing = [(c, t) for c, t in PROV_COLS if c not in have]
    if not missing:
        return 0
    for c, t in missing:
        con.execute(f"ALTER TABLE ext_point ADD COLUMN {c} {t}")
    for (src,) in con.execute("SELECT DISTINCT source FROM ext_point").fetchall():
        p = provenance.tag(src)
        con.execute("UPDATE ext_point SET origin_group=?, method=?, licence=?, precision_m=?, as_of=COALESCE(as_of, last_seen) "
                    "WHERE source=?", (p["origin_group"], p["method"], p["licence"], p["precision_m"], src))
    con.commit()
    return len(missing)


def timed_out(e):
    """A request that ran out of time (worth trying again), as opposed to one the server refused."""
    return isinstance(e, TimeoutError) or (isinstance(e, urllib.error.URLError) and isinstance(getattr(e, "reason", None), TimeoutError))


def retry(fn, waits=(3, 8)):
    """fn(), tried again after each wait when it times out (11/2: one slow OpenCelliD answer failed a whole run on the
    PC and the server). A refusal (an HTTP error such as WiGLE's 429) isn't retried: asking again makes it worse."""
    for w in waits:
        try:
            return fn()
        except OSError as e:  # URLError and TimeoutError are both OSErrors
            if not timed_out(e):
                raise
            time.sleep(w)
    return fn()


def http_json(url, headers=None, timeout=40, before=None):
    """A JSON answer, a timed-out request tried again (retry). before(): called before every attempt, the retried ones too,
    so a caller can count what the server was sent and stop at its budget (it raises to stop)."""
    req = urllib.request.Request(url, headers=dict({"User-Agent": UA, "Accept": "application/json"}, **(headers or {})))

    def once():
        if before:
            before()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    return retry(once)


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
    """Write fetched rows. A row already here whose content changed keeps its old version in ext_point_hist first:
    crowd history is kept, not overwritten (research rule 6); being seen again (only last_seen moves) isn't a change. Each row is tagged with its provenance."""
    migrate(con)  # a connection opened without open_db (the schema run by hand) still gets the columns
    now = time.strftime("%Y-%m-%d %H:%M")
    cmp = ("lat", "lon", "label", "freq_mhz", "dbm", "mode", "sig_type")  # last_seen and details alone aren't a change
    con.execute(f"CREATE TEMP TABLE IF NOT EXISTS _incoming(source, ext_id, {', '.join(cmp)})")
    con.execute("DELETE FROM _incoming")
    con.executemany(f"INSERT INTO _incoming VALUES({','.join('?' * (len(cmp) + 2))})",
                    [(r[0], r[2], r[3], r[4], r[6], r[7], r[9], r[10], r[11]) for r in rows])
    con.execute(f"INSERT INTO ext_point_hist(point_id, source, ext_id, {', '.join(HIST_FIELDS)}, fetched_at, replaced_at) "
                f"SELECT p.id, p.source, p.ext_id, {', '.join('p.' + f for f in HIST_FIELDS)}, p.fetched_at, ? "
                f"FROM _incoming i JOIN ext_point p ON p.source = i.source AND p.ext_id = i.ext_id "
                f"WHERE {' OR '.join(f'p.{f} IS NOT i.{f}' for f in cmp)}", (now,))
    con.executemany(
        """INSERT INTO ext_point(source,layer,ext_id,lat,lon,kind,label,freq_mhz,freq_in_mhz,dbm,mode,sig_type,
           first_seen,last_seen,details,fetched_at,attribution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(source,ext_id) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, label=excluded.label,
           freq_mhz=excluded.freq_mhz, dbm=excluded.dbm, mode=excluded.mode, sig_type=excluded.sig_type,
           last_seen=excluded.last_seen, details=excluded.details, fetched_at=excluded.fetched_at""", rows)
    for (src,) in {(r[0],) for r in rows}:
        p = provenance.tag(src)
        # only the rows just written, each by its (source, ext_id): filtered by source alone this walked every row of the
        # source on every page (a top-up's 24 pages each read the 727k OpenCelliD rows: 3-10 s a page, review 11/10)
        con.execute("UPDATE ext_point SET origin_group=?, method=?, licence=?, precision_m=?, as_of=last_seen "
                    "WHERE source=? AND ext_id IN (SELECT ext_id FROM _incoming WHERE source=?) AND (origin_group IS NULL OR as_of IS NOT last_seen)",
                    (p["origin_group"], p["method"], p["licence"], p["precision_m"], src, src))
    con.commit()


def log_fetch(con, source, lat, lon, radius, n, msg, requests=None, reached_km=None):
    """One fetch in the log: where, how many rows came, what happened, how many requests it took (None: not counted) and how
    far from its centre it came in whole (reached_km). Returns the row's id."""
    migrate_fetch(con)
    cur = con.execute("INSERT INTO ext_fetch(source,lat,lon,radius_mi,fetched_at,rows,message,requests,reached_km) VALUES(?,?,?,?,?,?,?,?,?)",
                      (source, lat, lon, radius, time.strftime("%Y-%m-%d %H:%M"), n, msg, requests, reached_km))
    con.commit()
    return cur.lastrowid


# ---------------------------------------------------------------- WiGLE

def fetch_wigle(con, lat, lon, radius_mi, api_name, api_token, kinds=("network",), max_pages=5):
    total = 0
    for rows in wigle_pages(lat, lon, radius_mi, api_name, api_token, kinds, max_pages):
        upsert(con, rows)
        total += len(rows)
    log_fetch(con, "wigle", lat, lon, radius_mi, total, "ok")
    return total


def wigle_pages(lat, lon, radius_mi, api_name, api_token, kinds=("network",), max_pages=5):
    """WiGLE's answers for an area, a page of ext_point rows at a time, with nothing stored: fetch_wigle stores them here; the PC
    fetcher (ops/crowd_pull.py, crowdpull.py) sends them to the server, which WiGLE refuses (11/7)."""
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    auth = "Basic " + base64.b64encode(f"{api_name}:{api_token}".encode()).decode()
    now = time.strftime("%Y-%m-%d %H:%M")
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
            yield rows
            search_after = data.get("searchAfter")
            if not search_after or not res:
                break


# ---------------------------------------------------------------- OpenCelliD

# OpenCelliD allows 1,000 requests a day per user (its docs, read 11/10), and every login on a copy shares its one key. Every
# path here (top-ups, the updater's areas, the Fetch button) stops at ALLOWANCE; top-ups stop sooner (cells.DAY_BUDGET), so
# the rest is the scheduled updates'. A request counts when it's sent: a timed-out one tried again counts each time
ALLOWANCE = 1000
OLD_ROW_REQUESTS = 24  # a fetch logged before 11/10 says nothing of its requests: a whole top-up's
_OCID = threading.RLock()  # one OpenCelliD fetch at a time on this copy, so the day's count and the coverage are checked and spent as one


class Busy(RuntimeError):
    """Another OpenCelliD fetch on this copy held the turn longer than the caller would wait."""


def ocid_turn(wait=None):
    """Take the copy's one OpenCelliD turn (release with ocid_done). wait: seconds, None for as long as it takes. False when
    another fetch held it that long."""
    return _OCID.acquire(timeout=-1 if wait is None else wait)


def ocid_done():
    _OCID.release()


def requests_today(con, source="opencellid"):
    """Requests made today on this copy's key: every one sent, top-ups, scheduled updates and the Fetch button alike, a fetch
    still running too. A row logged before 11/10 has no count: the one in its message, else a whole top-up's. A crowd
    database opened without migrate_fetch (read only, made before 11/10) has no requests column: every row is an old one."""
    n = 0
    # the tower bench opens a data folder read only, and this PC's crowd.db predates the column: "no such column" stopped
    # the tower report (cells.topup_due), as reached_km did before c3caefe
    has = "requests" in {r[1] for r in con.execute("PRAGMA table_info(ext_fetch)")}
    for req, msg, la in con.execute(f"SELECT {'requests' if has else 'NULL'}, message, lat FROM ext_fetch WHERE source=? AND fetched_at LIKE ?",
                                    (source, time.strftime("%Y-%m-%d") + "%")):
        if req is not None:
            n += req
        elif la is not None:  # an import (no place) asks nothing of the API
            m = re.search(r"(\d+) requests", msg or "")
            n += int(m.group(1)) if m else OLD_ROW_REQUESTS
    return n


def _ocid_boxes(lat, lon, radius_mi, tile_km):
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
    return tiles


def reached_km(lat, lon, radius_mi, tiles, whole):
    """How far from the centre every tile came in whole: the nearest point of the nearest tile that didn't (not asked, or
    its pages cut off), at most the area's own radius. A capped fetch in a dense city can reach 0: its first tile alone has
    more cells than its requests can bring."""
    out = radius_mi * geo.MI_KM
    for i, (la0, lo0, la1, lo1) in enumerate(tiles):
        if i not in whole:
            out = min(out, geo.haversine_km(lat, lon, min(max(lat, la0), la1), min(max(lon, lo0), lo1)))
    return round(out, 3)


def fetch_opencellid(con, lat, lon, radius_mi, key, tile_km=1.9, max_requests=40, wait=None, out=None):  # OpenCelliD refuses a box over 4 km²; 2 km tiles came out just over it
    """OpenCelliD's cells around a point, nearest tiles first, at most max_requests requests and never past the day's
    ALLOWANCE on this copy. Logged as it goes: a row "in progress" with the requests sent so far (a crash still counts
    them), then what happened, how many came and reached_km. One fetch at a time on the copy (wait: seconds before Busy).
    Returns the rows kept; out (a dict) gets requests, reached_km and stopped (why it ended early, or None)."""
    if not ocid_turn(wait):
        raise Busy("Another OpenCelliD fetch is running on this copy: try again in a minute.")
    try:
        cap = min(max_requests, ALLOWANCE - requests_today(con))
        if cap <= 0:
            raise RuntimeError(f"OpenCelliD's {ALLOWANCE} requests for today on this copy are used: try again tomorrow.")
        tiles = _ocid_boxes(lat, lon, radius_mi, tile_km)
        now = time.strftime("%Y-%m-%d %H:%M")
        rid = log_fetch(con, "opencellid", lat, lon, radius_mi, 0, "in progress", requests=0)
        sent = [0]  # what progress() last wrote: a failure of any kind settles with it (review 11/10 round 2)

        def progress(n):
            sent[0] = n
            con.execute("UPDATE ext_fetch SET requests=? WHERE id=?", (n, rid))
            con.commit()

        def settle(rows, msg, reqs, reached):
            con.execute("UPDATE ext_fetch SET rows=?, message=?, requests=?, reached_km=? WHERE id=?", (rows, msg, reqs, reached, rid))
            con.commit()
        try:
            total, reqs, stopped, whole = _ocid_tiles(con, tiles, key, cap, now, progress)
        except Exception as e:  # nothing came in: the requests it spent still count (requests_today), and it covers nothing
            from datadesk import clean
            said = clean.scrub_text(str(e).replace(key, "(key)") if key else str(e))[:160]
            # every request sent counts, whatever stopped it: an error without .requests (a sqlite error mid-page) settled
            # NULL, which requests_today reads as a whole top-up's 24 (35 sent counted 24; 1 sent counted 24)
            n = max(getattr(e, "requests", None) or 0, sent[0])
            settle(0, f"failed after {n} requests: {said}", n, None)
            raise
        reach = reached_km(lat, lon, radius_mi, tiles, whole)
        settle(total, stopped or f"{reqs} requests", reqs, reach)
        if out is not None:
            out.update(requests=reqs, reached_km=reach, stopped=stopped)
        return total
    finally:
        ocid_done()


class _Cap(Exception):
    """The request budget is spent (not an OSError, so retry() never swallows it)."""


def _keep_known(con, rows):
    """OpenCelliD's API answer for cells this copy already has keeps what the API doesn't send: when each cell was first and
    last measured and the PCI it was heard on (the country file's created, updated and unit), and the file's own position
    when the API's is only that position rounded to 3 decimals. A top-up replaced them: Newburgh's AT&T on 1294461 went
    from High to Medium, "last seen at an unknown date", and its PCIs were gone (review 11/10)."""
    ids = [r[2] for r in rows]
    old = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for ext, la, lo, det in con.execute(f"SELECT ext_id, lat, lon, details FROM ext_point WHERE source='opencellid' AND ext_id IN ({','.join('?' * len(chunk))})",
                                            chunk):
            old[ext] = (la, lo, det)
    out = []
    for r in rows:
        if r[2] not in old:
            out.append(r)
            continue
        la, lo, det = old[r[2]]
        try:
            had = json.loads(det or "{}")
        except ValueError:
            had = {}
        new = json.loads(r[14] or "{}")
        r = list(r)
        r[14] = json.dumps({**had, **{k: v for k, v in new.items() if v not in (None, "")}})
        if la is not None and lo is not None and round(la, 3) == round(r[3], 3) and round(lo, 3) == round(r[4], 3):
            r[3], r[4] = la, lo
        out.append(tuple(r))
    return out


def _ocid_tiles(con, tiles, key, cap, now, progress=None):
    """fetch_opencellid's requests, nearest tiles first: (rows, requests sent, why it stopped early or None, the tiles that
    came in whole). Every attempt counts against cap, a timed-out one tried again too (it counted as one: a top-up whose
    requests each timed out twice sent 72 and logged 24, review 11/10). An error with nothing in carries .requests, the
    number sent, so the day's count still has them."""
    total, reqs, whole = 0, 0, set()

    def spend():
        nonlocal reqs
        if reqs >= cap:
            raise _Cap()
        reqs += 1  # asked is spent, answered or not (OpenCelliD counts a day's requests per user)
        if progress:
            progress(reqs)
    for i, (la0, lo0, la1, lo1) in enumerate(tiles):
        offset = 0
        while True:
            q = dict(key=key, BBOX=f"{la0},{lo0},{la1},{lo1}", format="json", limit=50, offset=offset)
            try:
                data = http_json("https://opencellid.org/cell/getInArea?" + urllib.parse.urlencode(q), before=spend)
            except _Cap:  # the request cap: a fetch that ended where it was meant to
                return total, reqs, None, whole
            # still no answer after the retries, or one that isn't JSON (a 200 maintenance page) or was cut off mid-body
            # (http.client.IncompleteRead, not an OSError): keep what came in, nearest tiles first (review 11/10 round 2)
            except (OSError, ValueError, http.client.HTTPException) as e:
                if not total:
                    e.requests = reqs
                    raise
                return total, reqs, f"stopped after {reqs} requests ({e}); the cells already in are kept", whole
            if isinstance(data, dict) and data.get("error"):  # OpenCelliD's own no (a bad key, the day's limit): kept as above
                if not total:
                    err = RuntimeError(str(data.get("error")))
                    err.requests = reqs
                    raise err
                return total, reqs, f"stopped after {reqs} requests (OpenCelliD: {str(data.get('error'))[:80]}); the cells already in are kept", whole
            cells = (data or {}).get("cells") or []
            rows = []
            for c in cells:
                la, lo = fnum(c.get("lat")), fnum(c.get("lon"))
                if la is None:
                    continue
                radio = (c.get("radio") or "").upper()
                ident = f"{c.get('mcc')}-{c.get('mnc')}-{c.get('lac') or c.get('tac')}-{c.get('cellid')}"
                st = sigid.classify("NR" if radio == "NR" else ("WCDMA" if radio == "UMTS" else radio))["sig_type"]
                # the API's whole row is kept as details, its changeable flag with it (cells.changeable, the tower engine's sigma, 11/10)
                rows.append(("opencellid", "OpenCelliD cells", ident, la, lo, radio, f"{radio} {ident}", None, None,
                             fnum(c.get("averageSignalStrength")) or None, radio, st, "", "", json.dumps(c), now,
                             ATTRIBUTION["opencellid"]))
            if rows:
                upsert(con, _keep_known(con, rows))
            total += len(rows)
            if len(cells) < 50:
                whole.add(i)
                break
            offset += 50
    return total, reqs, None, whole


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
