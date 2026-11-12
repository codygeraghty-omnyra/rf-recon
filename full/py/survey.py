"""
Survey mapping (Cody 11/10: "survey war mapping... colour coded like the tiles of the heat map"): a drive or walk survey's
cellular readings, each with where and when it was taken, kept with a mission, a DAS job, or this copy alone ("scratch", id 0)
as the maps' drawings are (markup.py). static/survey.js turns them into coloured grid tiles and the Towers tab's "Seen on site".

Evidence (plan 11/10, section 8): a recording's Stop and an import write one survey_cell row per serving cell the run heard
(evidence()): the tower engine counts them as heard on site (carrier, technology, site ID, when, best RSRP) and never as a
place. They are the run's, kept with it: never in captures.py's tables, where every login's captures layer, the capture
routes, the Signals report and Cell sites read them as where a site is (review 11/12, round 2).

Where they live: the main database, never crowd.db. A person's track must not mix with share-alike crowd data, and it goes
with the job's access list (app.py job_gate: view to see, edit to change; a view-only login can't send anything).

  survey_run      one recording or one imported file: its scope, name, source (android, gnettrack, scanner, csv), device,
                  its "keep within N miles of the site" (keep_mi and that centre: every reading it stores is trimmed by it),
                  whether the instrument was calibrated (a phone never is), first and last reading, how many, the box they
                  cover, the file's hash (an import can't come in twice), who made it (capture_id: unused since 11/12)
  survey_reading  one cell heard at one moment: ts (ms, UTC), lat, lon, acc (m), speed (m/s), plmn ("310-410"), carrier,
                  tech (LTE or NR), band ("66", "n71"), chan (EARFCN or NR-ARFCN), pci, tac, cid (LTE ECI or the raw NR NCI),
                  site (the eNB, ECI >> 8; a gNB only when the source names it: its bit length varies by operator), serving
                  (1 the primary cell, 2 a carrier-aggregation or 5G NSA leg, 0 a neighbour), rsrp, rsrq, sinr (dB), ta

A reading is kept once (run, time, technology, network, band, channel, cell, role), so a retried upload adds nothing. One without a
position, with a GPS accuracy worse than 50 m, or with an RSRP outside -156 to -31 dBm (no LTE or NR modem reports one) is
dropped and counted. Privacy: "keep only within N miles of the site" is kept on the run: set when a recording starts or
stops, or on import, it trims what the run holds and every batch that comes after, so a reading beyond it is never stored.
Standard library only.
"""
import calendar
import contextlib
import functools
import hashlib
import io
import itertools
import json
import math
import os
import re
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS survey_run(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, scope_id INTEGER NOT NULL DEFAULT 0, name TEXT,
    source TEXT NOT NULL, device TEXT, calibrated INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER,
    readings INTEGER NOT NULL DEFAULT 0, bbox TEXT, src_hash TEXT, capture_id INTEGER, created_by TEXT, created_at TEXT,
    keep_mi REAL, keep_lat REAL, keep_lon REAL, client_key TEXT);
CREATE INDEX IF NOT EXISTS survey_run_scope ON survey_run(scope, scope_id);
CREATE UNIQUE INDEX IF NOT EXISTS survey_run_src ON survey_run(scope, scope_id, src_hash) WHERE src_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS survey_reading(run_id INTEGER NOT NULL, ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    acc REAL, speed REAL, plmn TEXT, carrier TEXT, tech TEXT NOT NULL, band TEXT, chan INTEGER, pci INTEGER, tac INTEGER,
    cid INTEGER, site INTEGER, serving INTEGER NOT NULL DEFAULT 1, rsrp REAL, rsrq REAL, sinr REAL, ta INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS survey_reading_key ON survey_reading(run_id, ts, tech, IFNULL(plmn, ''), IFNULL(carrier, ''), IFNULL(band, ''),
    IFNULL(chan, -1), IFNULL(pci, -1), IFNULL(cid, -1), serving);
CREATE TABLE IF NOT EXISTS survey_cell(run_id INTEGER NOT NULL, tech TEXT NOT NULL, plmn TEXT NOT NULL, cid INTEGER NOT NULL, tac INTEGER,
    carrier TEXT, pci INTEGER, chan INTEGER, best_rsrp REAL, best_ts INTEGER, lat REAL, lon REAL, first_ts INTEGER, last_ts INTEGER,
    moments INTEGER, readings INTEGER, PRIMARY KEY(run_id, tech, plmn, cid));
CREATE INDEX IF NOT EXISTS survey_cell_ll ON survey_cell(lat, lon);
"""
# the unique key is (run_id, ts, tech, plmn, carrier, band, chan, pci, cid, serving) with a missing value counted as one value:
# SQLite treats every NULL as different in a plain UNIQUE, so two readings with no PCI would both go in. Band, carrier and cell
# are in it since 11/10: PCI 101 on B12 and B66 with no channel was one reading and a "duplicate" (review). The tables are new
# on this branch and no copy has them yet, so the key changes in place.
# A run's id is never used again (AUTOINCREMENT): a deleted newest run's id went to the next run, and a phone still sending
# to the old one (a queued batch, a retry, a Stop) wrote into it past that recording's keep_mi, trimmed it or deleted it
# (review 11/10, round 2). Changed in place for the same reason.
TABLES = ("survey_run", "survey_reading", "survey_cell")  # the nightly my-work backup takes them (app.USER_TABLES)
SCOPES = ("mission", "job", "scratch")
SOURCES = ("android", "gnettrack", "phone", "scanner", "csv")  # phone: a phone app's log with each cell's role (Network Cell Info,
PHONES = ("android", "gnettrack", "phone")  # NetMonster...) a phone is never calibrated: its readings are indicative, never a
# public-safety score. survey.js judges a "scanner" run as measuring every carrier it reports, anything else as a phone's
COLS = ("ts", "lat", "lon", "acc", "speed", "plmn", "carrier", "tech", "band", "chan", "pci", "tac", "cid", "site", "serving", "rsrp", "rsrq", "sinr", "ta")
BATCH = 2000          # readings per create or append (the phone uploads its queue in batches this size), and per stored piece of an import
PAGE = 50000          # readings per answer of /api/survey/readings (a page; since= its last time asks for the next)
MAX_ACC_M = 50        # a position worse than this can't say which tile a reading is in
RSRP_RANGE = (-156, -31)
MAX_NAME = 120
MI_M = 1609.344


def ensure(con):
    con.executescript(SCHEMA)
    # client_key (11/12): a recording's own id, sent with every create, so a create whose answer was lost, or two at once
    # (a Stop and a retry, two pages), make one run. A copy whose table came before it gets the column added
    if not any(r[1] == "client_key" for r in con.execute("PRAGMA table_info(survey_run)")):
        con.executescript("ALTER TABLE survey_run ADD COLUMN client_key TEXT;")
    con.executescript("CREATE UNIQUE INDEX IF NOT EXISTS survey_run_client ON survey_run(scope, scope_id, client_key) WHERE client_key IS NOT NULL;")
    # round 1's evidence went into captures.py's tables (fmt "survey", its notes "survey run N: ..."): out of them, where every
    # login read it as a place (review 11/12, round 2); backfill() (app.py's start) writes their survey_cell rows
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture'").fetchone():
        old = [x[0] for x in con.execute("SELECT id FROM capture WHERE fmt='survey' AND notes LIKE 'survey run %: one point per serving cell%'")]
        for c in old:
            con.execute("DELETE FROM capture_point WHERE capture_id=?", (c,))
            con.execute("DELETE FROM capture WHERE id=?", (c,))
        if old:
            con.execute("UPDATE survey_run SET capture_id=NULL")
            con.commit()


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def scope_of(scope, scope_id):
    """(scope, id) checked: scratch is always id 0."""
    if scope not in SCOPES:
        raise ValueError("A survey belongs to a mission, a DAS job or scratch.")
    if scope == "scratch":
        return scope, 0
    try:
        sid = int(scope_id)
    except (TypeError, ValueError):
        raise ValueError(f"Which {scope}? Its id is missing.") from None
    return scope, sid


# ---------------------------------------------------------------- one reading

def _num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    m = re.search(r"-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(v))
    if not m:
        return None
    x = float(m.group(0))
    return x if math.isfinite(x) else None


def _dec(v):
    """A measured value (RSRP, SINR, accuracy, speed): _num, with a decimal comma read as a point. Excel in a comma-decimal
    locale writes "-95,5" in a semicolon file, and _num read it as -95 (review 11/10)."""
    if isinstance(v, str) and "." not in v:
        m = re.search(r"-?\d+,\d+", v)
        if m:
            v = v.replace(m.group(0), m.group(0).replace(",", "."), 1)
    return _num(v)


_HEMI = re.compile(r"^\s*([NSEW])?\s*(.*?)\s*([NSEW])?\s*$", re.I)
_DEG = re.compile(r"[-+]?\d+(?:[.,]\d+)?")


def _coord(v, axis):
    """A latitude (axis "NS") or longitude ("EW") -> decimal degrees, or None. Reads signed decimal degrees, a decimal comma
    ("41,33500"), a hemisphere letter before or after ("74.19400 W", "N41.335": S and W are negative) and degrees with minutes
    and seconds (41 20 06.1, or with the degree, minute and second marks). Anything else is no position rather than its first
    number: 11/10 the review found "41,33500" placed at 41.0 and "74.19400 W" in Central Asia, with nothing said."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    m = _HEMI.match(str(v))  # always matches: every part is optional
    h = ((m.group(1) or "") + (m.group(3) or "")).upper()
    if len(h) > 1 or (h and h not in axis):
        return None
    body = re.sub("[°º′″'\":]", " ", m.group(2))
    nums = _DEG.findall(body)
    if not nums or len(nums) > 3 or _DEG.sub("", body).strip():
        return None
    x = [float(n.replace(",", ".")) for n in nums]
    if not all(0 <= y < 60 for y in x[1:]):
        return None
    deg = abs(x[0]) + sum(y / 60 ** i for i, y in enumerate(x[1:], 1))
    return -deg if nums[0].startswith("-") or h in ("S", "W") else deg


def _int(v, lo, hi):
    """A whole number from lo to hi, else None. Text with letters in it (other than an exponent's) isn't one: "0C659A0F", a hex
    cell ID, read as its first digits, 0 (review 11/10, round 2)."""
    if isinstance(v, str) and re.search(r"[A-DF-Za-df-z]", v):
        return None
    x = _num(v)
    if x is None or x != int(x) or not lo <= x <= hi:
        return None
    return int(x)


def _hex(v, lo, hi):
    """A whole number written in hex ("0C659A0F", "0x3039"), from a column whose name says hex; else None."""
    m = re.fullmatch(r"\s*(?:0[xX])?([0-9A-Fa-f]{1,10})\s*", str(v or ""))
    x = int(m.group(1), 16) if m else None
    return x if x is not None and lo <= x <= hi else None


def _in(v, lo, hi, nd=1):
    x = _num(v)
    return round(x, nd) if x is not None and lo <= x <= hi else None


# a fraction of a second of any length, cut to ms: .NET, PowerShell and SQL Server write 7 digits, Go and Java up to 9 (11/10)
_YMD = re.compile(r"^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})[ _T]+(\d{1,2})[.:](\d{2})(?:[.:](\d{2})(?:[.,](\d+))?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$", re.I)
_MDY = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*([AP]M)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$", re.I)


def parse_time(v, utc_offset=None):
    """A log's time -> (ms since 1970 UTC, whether it carried its own zone), or (None, False). Reads the dated times daswalk.js
    wkTime reads: ISO 8601 with or without a zone and with any number of digits of a second (cut to ms, as Date.parse cuts
    them), G-NetTrack's 2026.11.04_10.12.33, 11/04/2026 10:12:33 PM, epoch seconds or ms; not a time of day alone.
    A time with no zone is the phone's local time: utc_offset (minutes east of UTC, -300 for New York in winter) makes it
    UTC; with none it's read as UTC and the import says so."""
    if v is None:
        return None, False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return (int(round(v if v > 1e12 else v * 1000)), True) if math.isfinite(v) and v > 0 else (None, False)
    t = str(v).strip()
    if re.fullmatch(r"\d{9,13}(\.\d+)?", t):
        n = float(t)
        return int(round(n if n > 1e12 else n * 1000)), True
    m, mdy = _YMD.match(t), None
    if not m:
        mdy = _MDY.match(t)
        if not mdy:
            return None, False
    if m:
        y, mo, d, h, mi, s, frac, zone = int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0), m[7], m[8]
    else:
        y, mo, d, h, mi, s, frac, ap, zone = int(mdy[3]), int(mdy[1]), int(mdy[2]), int(mdy[4]), int(mdy[5]), int(mdy[6] or 0), mdy[7], mdy[8], mdy[9]
        if ap:
            h = (0 if h == 12 else h) + (12 if ap.upper() == "PM" else 0)
    try:
        ms = calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)) * 1000 + (int((frac + "00")[:3]) if frac else 0)
    except (ValueError, OverflowError):
        return None, False
    if not (1 <= mo <= 12 and 1 <= d <= 31 and h <= 23 and mi <= 59 and s <= 60):
        return None, False
    if zone and zone[0] in "+-":
        z = zone.replace(":", "")
        return ms - (-1 if z[0] == "-" else 1) * (int(z[1:3]) * 60 + int(z[3:5])) * 60000, True
    if zone:
        return ms, True
    return ms - int(utc_offset or 0) * 60000, False


def tech_of(v):
    """LTE or NR from what a tool calls it (4G, LTE-A, E-UTRA, 5G, NR5G, 5G NR NSA), else None (2G, 3G, Wi-Fi)."""
    t = re.sub(r"[^a-z0-9]", "", str(v or "").lower())
    if not t:
        return None
    if t.startswith(("nr", "5g")) or t in ("newradio",):
        return "NR"
    if t.startswith(("lte", "4g", "eutra")):
        return "LTE"
    return None


def band_name(tech, v):
    """A band as DAStastic writes it: LTE's number ("66"), NR's with its n ("n71"). "B66", "Band 66", "n71", "71" all read."""
    m = re.search(r"(\d{1,3})", str(v or ""))
    if not m:
        return None
    n = int(m.group(1))
    return f"n{n}" if tech == "NR" else str(n)


def band_of(tech, chan):
    """The band a channel number sits in. clean takes it over the band a log names whenever it gives one (an LTE EARFCN is in
    one band only; an NR channel only where no two bands overlap): a "Bandwidth (MHz)" column read as the band made B13
    "band 10" (review 11/10).
    TODO 11/10: cellspec.band_of(tech, chan), the tower engine's one channel-to-band converter (wt/towerfuse), replaces this
    shim when it lands; the swap is this function's one line."""
    return _band_shim(tech, chan)


def _band_shim(tech, chan):
    """LTE: the EARFCN ranges in cellspec.LTE (each band's own numbers, so one answer). NR: the bands in cellspec.NR whose
    downlink holds the NR-ARFCN's MHz; where two overlap (n2 / n25, n5 / n26, n48 / n77) it says nothing rather than guess:
    the carrier's licensed blocks settle those (the tower engine's job)."""
    import cellspec
    if chan is None:
        return None
    if tech == "LTE":
        for band, (lo, hi), n_offs, _ul, _n_ul in cellspec.LTE:
            if n_offs <= chan < n_offs + round(10 * (hi - lo)):
                return band.lstrip("B")
        return None
    if tech == "NR":
        mhz = 0.005 * chan if chan < 600000 else 3000 + 0.015 * (chan - 600000) if chan < 2016667 else 24250.08 + 0.06 * (chan - 2016667)
        hits = [b for b, (lo, hi), _ul in cellspec.NR if lo <= mhz <= hi]
        return hits[0] if len(hits) == 1 else None
    return None


def nr_bands(chan):
    """Every NR band (cellspec.NR) whose downlink holds an NR-ARFCN, overlaps and all."""
    mhz = 0.005 * chan if chan < 600000 else 3000 + 0.015 * (chan - 600000) if chan < 2016667 else 24250.08 + 0.06 * (chan - 2016667)
    return nr_bands_mhz(mhz)


def nr_bands_mhz(mhz):
    """Every NR band (cellspec.NR) whose downlink holds a frequency (MHz)."""
    import cellspec
    return [b for b, (lo, hi), _ul in cellspec.NR if lo <= mhz <= hi]


def lte_mhz(mhz):
    """Whether any LTE band's downlink (cellspec.LTE) holds a frequency (MHz): 3,750 MHz is C-band, which only NR uses."""
    import cellspec
    return any(lo < mhz < hi for _b, (lo, hi), *_x in cellspec.LTE)


def nr_band(v):
    """Whether a band as a log writes it is an NR band ("n77", "N 41", "NR78", "NR Band 77", "NR n41", "n71 (600 MHz)", "n77
    C-Band"): "N/A", "None", "NaN" and "null" are no band, and starting with an n made an LTE row NR (review 11/10, round 2).
    Matched from the start, not the whole value: round 2's whole match took "n71 (600 MHz)" and "NR Band 77" for LTE's B71 and
    band 77 (round 3)."""
    return bool(re.match(r"\s*(?:nr|n)(?:\s*band)?\s*[-_ ]?\s*n?\s*\d{1,3}(?!\d)", str(v or ""), re.I))


def chan_of_mhz(tech, mhz, band=None):
    """A downlink centre frequency (MHz) -> its channel number, for a log that gives MHz and no channel: NR's one global
    raster; LTE's EARFCN in the band given, or in the one band that holds the frequency (B2 / B25, B4 / B66, B5 / B26 and the
    700 MHz bands overlap: there a band column has to say which)."""
    import cellspec
    if mhz is None or not 400 <= mhz <= 52600:
        return None
    if tech == "NR":
        return cellspec.nr_arfcn(mhz)
    hits = [(b, lo, n) for b, (lo, hi), n, _u, _n in cellspec.LTE if lo < mhz < hi and (band is None or b[1:] == band_name("LTE", band))]
    return cellspec.earfcn(hits[0][2], hits[0][1], mhz) if len(hits) == 1 else None


NOT_A_CARRIER = ("gps", "network", "fused", "passive", "gnss")  # Android's location providers: a phone logger's "Provider" column


_SURROGATES = re.compile("[\ud800-\udfff]")


def _text(v):
    """A value's text as SQLite can store it: a lone surrogate (a JSON log's emoji cut in half, "\\ud83d") is U+FFFD. Kept,
    one failed the whole import: UTF-8 can't encode it (review 11/10, round 5)."""
    return _SURROGATES.sub("\ufffd", v) if isinstance(v, str) and not v.isascii() else v


@functools.lru_cache(maxsize=512)
def carrier_of(name, plmn):
    """One carrier name (das.carrier_name: "T-Mobile US" and "Sprint" are T-Mobile), from the name a tool gives or the network code.
    A number is never a name ("-61.37" from a "Carrier RSSI" column was a carrier of its own, review 11/10 round 2), nor is a
    location provider."""
    import das
    if name and str(name).strip() and not re.fullmatch(r"[\d\s.,+-]+", str(name)) and _key(name) not in NOT_A_CARRIER:
        return das.carrier_name(name)
    if plmn:
        import cells
        mcc, mnc = plmn.split("-")
        return das.carrier_name(cells.operator(mcc, mnc))
    return None


def plmn_of(r):
    """"310-410" from plmn ("310410", "310-410", "310 410") or mcc and mnc; None when it isn't a network code."""
    p = r.get("plmn")
    if p not in (None, ""):
        m = re.fullmatch(r"\s*(\d{3})\s*[-_/ ]?\s*(\d{2,3})\s*", str(p))
        return f"{m.group(1)}-{m.group(2)}" if m else None
    mcc, mnc = str(r.get("mcc") or "").strip(), str(r.get("mnc") or "").strip()
    return f"{mcc}-{mnc}" if re.fullmatch(r"\d{3}", mcc) and re.fullmatch(r"\d{2,3}", mnc) else None


def clean(r):
    """One reading as sent (the page, the phone, an import) -> (the row kept, None), or (None, why it isn't)."""
    if not isinstance(r, dict):
        return None, "not a reading"
    v = r.get("ts")
    if isinstance(v, str) and re.fullmatch(r"\s*\d+(\.\d+)?\s*", v):
        v = float(v)
    ts = parse_time(v)[0] if isinstance(v, str) else _num(v)
    if ts is None or ts <= 0:
        return None, "no time"
    ts = int(round(ts * 1000 if ts < 1e11 else ts))  # seconds or ms
    lat, lon = _coord(r.get("lat"), "NS"), _coord(r.get("lon"), "EW")
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None, "no position"
    acc = _dec(r.get("acc"))
    if acc is not None and acc > MAX_ACC_M:
        return None, f"GPS accuracy worse than {MAX_ACC_M} m"
    tech = tech_of(r.get("tech"))
    if not tech:
        return None, "not LTE or 5G NR"
    rsrp = _dec(r.get("rsrp"))
    if rsrp is None or not RSRP_RANGE[0] <= rsrp <= RSRP_RANGE[1]:
        return None, "RSRP missing or outside -156 to -31 dBm"
    lte = tech == "LTE"
    chan = _int(r.get("chan"), 0, 262143 if lte else 3279165)
    plmn = plmn_of(r)
    cid = _int(r.get("cid"), 0, (1 << 28) - 1 if lte else (1 << 36) - 1)
    site = _int(r.get("site"), 0, (1 << 32) - 1)
    if site is None and lte and cid is not None:
        site = cid >> 8  # the eNB: an LTE cell's ECI is its eNB and an 8-bit cell number
    sv = r.get("serving")
    # no role given is the primary; a role it doesn't know is never the primary (11/10: "Neighbor Cell" and "0.0" were)
    serving = 1 if sv is None or sv == "" else _serving(sv) or 0
    row = {"ts": ts, "lat": round(lat, 7), "lon": round(lon, 7), "acc": None if acc is None or acc < 0 else round(acc, 1),
           "speed": _in(_dec(r.get("speed")), 0, 150, 2), "plmn": plmn, "carrier": carrier_of(_text(str(r.get("carrier") or "")[:80]) or None, plmn), "tech": tech,
           "band": band_of(tech, chan) or band_name(tech, r.get("band")), "chan": chan, "pci": _int(r.get("pci"), 0, 503 if lte else 1007),
           "tac": _int(r.get("tac"), 0, (1 << 24) - 1), "cid": cid, "site": site, "serving": serving,
           "rsrp": round(rsrp, 1), "rsrq": _in(_dec(r.get("rsrq")), -43, 20), "sinr": _in(_dec(r.get("sinr")), -23, 40), "ta": _int(r.get("ta"), 0, 4000)}
    return row, None


# ---------------------------------------------------------------- runs

def _row(r):
    d = dict(r)
    d["bbox"] = json.loads(d["bbox"]) if d.get("bbox") else None
    d["calibrated"] = bool(d.get("calibrated"))
    return d


def _get(con, scope, sid, rid):
    try:
        rid = int(rid)
    except (TypeError, ValueError):
        raise ValueError("Which survey run? Its id is missing.") from None
    r = con.execute("SELECT * FROM survey_run WHERE id=? AND scope=? AND scope_id=?", (rid, scope, sid)).fetchone()
    if not r:
        raise LookupError("That survey run was deleted. Reload to see the current ones.")
    return r


def create(con, d, who=""):
    """A new run in its scope: {scope, scope_id, name, source, device, calibrated, readings (a first batch, optional), keep_mi
    (only readings within that many miles of the site are ever stored; lat and lon: the centre for scratch), client_key}.
    client_key: the recording's own id (static/surveyrec.js). A run with it in this scope already is that run, answered again
    (existing: true, the batch added to it): a phone whose create got through but whose answer was lost, or a Stop and a retry
    in flight together, made a second, empty run that never ended (review 11/12)."""
    scope, sid = scope_of(d.get("scope"), d.get("scope_id"))
    key = str(d.get("client_key") or "").strip()[:80] or None
    if key:
        old = con.execute("SELECT id FROM survey_run WHERE scope=? AND scope_id=? AND client_key=?", (scope, sid, key)).fetchone()
        if old:
            return _again(con, scope, sid, old[0], d.get("readings"))
    source = d.get("source") or "android"
    if source not in SOURCES:
        raise ValueError(f"A survey comes from {', '.join(SOURCES)}.")
    name = str(d.get("name") or "").strip()[:MAX_NAME] or f"Survey {time.strftime('%Y-%m-%d %H:%M')}"
    cal = 1 if d.get("calibrated") and source not in PHONES else 0
    keep = _keep(con, scope, sid, d.get("keep_mi"), (d.get("lat"), d.get("lon")))
    try:
        rid = con.execute("INSERT INTO survey_run(scope, scope_id, name, source, device, calibrated, src_hash, created_by, created_at, keep_mi, keep_lat, keep_lon,"
                          " client_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (scope, sid, name, source, str(d.get("device") or "")[:120], cal, d.get("src_hash"),
                                                                             who or "", _now(), *keep, key)).lastrowid
    except sqlite3.IntegrityError:
        con.rollback()
        old = con.execute("SELECT id FROM survey_run WHERE scope=? AND scope_id=? AND client_key=?", (scope, sid, key)).fetchone() if key else None
        if not old:
            raise
        return _again(con, scope, sid, old[0], d.get("readings"))  # the same recording's other create got in first
    got = add(con, scope, sid, rid, d.get("readings") or []) if d.get("readings") else {"added": 0, "duplicates": 0, "dropped": {}, "trimmed": 0}
    con.commit()
    return {**run_info(con, scope, sid, rid), **{k: got[k] for k in ("added", "duplicates", "dropped", "trimmed")}}


def _again(con, scope, sid, rid, readings):
    """A create for a recording already made: that run, with the create's batch added (kept once, as an append)."""
    got = add(con, scope, sid, rid, readings) if readings else {"added": 0, "duplicates": 0, "dropped": {}, "trimmed": 0}
    return {**run_info(con, scope, sid, rid), **{k: got[k] for k in ("added", "duplicates", "dropped", "trimmed")}, "existing": True}


def add(con, scope, sid, rid, readings):
    """A batch of readings into a run (up to BATCH). Each is kept once: one sent again (a retried upload) is a duplicate. A
    run with a keep_mi (set at its start or by stop) never stores a reading further from its centre: the trim used to run
    once, at stop, so a retried or late batch after it put the drive from home back, and a run never stopped (the battery
    died) was never trimmed, with its whole track in uls.db and the 6-hourly backup meanwhile (review 11/10)."""
    run = _get(con, scope, sid, rid)
    if not isinstance(readings, list):
        raise ValueError("Readings come as a list.")
    if len(readings) > BATCH:
        raise ValueError(f"Send readings in batches of up to {BATCH:,}.")
    lim = run["keep_mi"] * MI_M if run["keep_mi"] else None
    rows, dropped, trimmed = [], {}, 0
    for r in readings:
        row, why = clean(r)
        if why:
            dropped[why] = dropped.get(why, 0) + 1
        elif lim is not None and _metres(run["keep_lat"], run["keep_lon"], row["lat"], row["lon"]) > lim:
            trimmed += 1
        else:
            rows.append(row)
    added = _insert(con, rid, rows)
    _restat(con, rid)
    con.commit()
    return {"added": added, "duplicates": len(rows) - added, "dropped": dropped, "trimmed": trimmed}


def _insert(con, rid, rows):
    before = con.total_changes
    con.executemany(f"INSERT OR IGNORE INTO survey_reading(run_id, {', '.join(COLS)}) VALUES(?, {', '.join('?' * len(COLS))})",
                    [(rid, *[r[c] for c in COLS]) for r in rows])
    return con.total_changes - before


def _restat(con, rid):
    """The run's count, first reading and box, from what it holds now."""
    n, t0, t1, a, b, c, d = con.execute("SELECT COUNT(*), MIN(ts), MAX(ts), MIN(lat), MIN(lon), MAX(lat), MAX(lon) FROM survey_reading"
                                        " WHERE run_id=?", (rid,)).fetchone()
    r = con.execute("SELECT ended_at FROM survey_run WHERE id=?", (rid,)).fetchone()
    if r is None:  # deleted after the caller's _get (another window's Delete committed while this batch waited on the lock):
        # the stale-run answer, not a TypeError's 500; the caller's batch is never committed (review 11/10, round 3)
        raise LookupError("That survey run was deleted. Reload to see the current ones.")
    ended = r[0]
    con.execute("UPDATE survey_run SET readings=?, started_at=?, ended_at=?, bbox=? WHERE id=?",
                (n, t0, max(ended, t1 or 0) if ended else None, json.dumps([a, b, c, d]) if n else None, rid))


def run_info(con, scope, sid, rid):
    """A run and what it holds: readings per carrier and technology, serving sites seen."""
    r = _row(_get(con, scope, sid, rid))
    r["carriers"] = [dict(x) for x in con.execute(
        "SELECT carrier, tech, COUNT(*) AS readings, SUM(serving>0) AS serving, COUNT(DISTINCT CASE WHEN serving>0 THEN site END) AS sites,"
        " MAX(rsrp) AS best_rsrp FROM survey_reading WHERE run_id=? GROUP BY carrier, tech ORDER BY readings DESC", (r["id"],))]
    return r


def listing(con, scope, scope_id):
    scope, sid = scope_of(scope, scope_id)
    return [_row(r) for r in con.execute("SELECT * FROM survey_run WHERE scope=? AND scope_id=? ORDER BY id", (scope, sid))]


def readings(con, scope, sid, rid, since=None, limit=None):
    """A run's readings in time order, as columns and rows (a 50 000-reading run is a fifth the size of a list of objects), a
    page at a time: PAGE readings (limit: fewer), carried on to the end of the last one's moment so a page never cuts a moment
    in two. since= the last row's time asks for the next page; more says whether there is one. A long scanner drive has
    millions of readings: built in one answer they took about a gigabyte (review 11/10)."""
    _get(con, scope, sid, rid)
    n = max(1, min(int(limit), PAGE)) if limit else PAGE
    where, args = "run_id=?", [int(rid)]
    if since is not None:
        where += " AND ts>?"
        args.append(int(since))
    cut = con.execute(f"SELECT ts FROM survey_reading WHERE {where} ORDER BY ts LIMIT 1 OFFSET ?", (*args, n - 1)).fetchone()
    if cut:
        where += " AND ts<=?"
        args.append(cut[0])
    rows = [list(x) for x in con.execute(f"SELECT {', '.join(COLS)} FROM survey_reading WHERE {where} ORDER BY ts, serving DESC, tech, rowid", args)]
    more = bool(cut) and con.execute("SELECT 1 FROM survey_reading WHERE run_id=? AND ts>? LIMIT 1", (int(rid), cut[0])).fetchone() is not None
    return {"run": int(rid), "cols": list(COLS), "rows": rows, "more": more}


def delete_run(con, scope, sid, rid):
    _get(con, scope, sid, rid)
    con.execute("DELETE FROM survey_cell WHERE run_id=?", (int(rid),))
    con.execute("DELETE FROM survey_reading WHERE run_id=?", (int(rid),))
    con.execute("DELETE FROM survey_run WHERE id=?", (int(rid),))
    con.commit()


def drop_scope(con, scope, scope_id):
    """A mission's or a job's surveys, when it's deleted, with any import into it still hidden (one a stopped copy left: round
    2, its track outlived the job and went into every backup until a later import swept it). Part of the caller's delete,
    so it commits nothing: ensure()'s executescript commits first, and saved the mission's removal before its surveys went
    (round 3). No table yet: no surveys."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='survey_run'").fetchone():
        return
    where = "scope IN (?, ?) AND scope_id=?"
    args = (scope, _hidden(scope), int(scope_id))
    if con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='survey_cell'").fetchone():
        con.execute(f"DELETE FROM survey_cell WHERE run_id IN (SELECT id FROM survey_run WHERE {where})", args)
    con.execute(f"DELETE FROM survey_reading WHERE run_id IN (SELECT id FROM survey_run WHERE {where})", args)
    con.execute(f"DELETE FROM survey_run WHERE {where}", args)


# ---------------------------------------------------------------- privacy: keep only near the site

def site_of(con, scope, sid):
    """Where the survey's site is: the DAS job's building or the mission's point; None when it has none (scratch)."""
    if scope == "job":
        r = con.execute("SELECT data FROM das_job WHERE id=?", (sid,)).fetchone()
        d = json.loads(r[0] or "{}") if r else {}
        lat, lon = _num(d.get("lat")), _num(d.get("lon"))
    elif scope == "mission":
        r = con.execute("SELECT lat, lon FROM mission WHERE id=?", (sid,)).fetchone()
        lat, lon = (r[0], r[1]) if r else (None, None)
    else:
        return None
    return (lat, lon) if lat is not None and lon is not None else None


def _metres(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1, math.sqrt(a)))


def spread_m(points):
    """How far positions spread: the diagonal of the box they fill, in metres (0 for fewer than two). points: (lat, lon) or
    (lat, lon, accuracy in m). Left out: what isn't a position (blank, 0,0, off the map), a fix worse than MAX_ACC_M (the
    import drops those too), and with ten or more, the outermost 5% each way (one at least): one network fix 600 m off made
    an indoor walk log a survey (review 11/10)."""
    lats, lons = [], []
    for p in points:
        a, o, acc = _coord(p[0], "NS"), _coord(p[1], "EW"), _dec(p[2]) if len(p) > 2 else None
        if a is None or o is None or (a == 0 and o == 0) or not (-90 <= a <= 90 and -180 <= o <= 180) or (acc is not None and acc > MAX_ACC_M):
            continue
        lats.append(a)
        lons.append(o)
    n = len(lats)
    if n < 2:
        return 0.0
    k = max(1, n // 20) if n >= 10 else 0
    lats, lons = sorted(lats)[k:n - k], sorted(lons)[k:n - k]
    return _metres(lats[0], lons[0], lats[-1], lons[-1])


def keep_near(rows, centre, miles):
    """Only the readings within miles of centre (lat, lon); the rest are left out."""
    lim = float(miles) * MI_M
    return [r for r in rows if _metres(centre[0], centre[1], r["lat"], r["lon"]) <= lim]


def centre_for(con, scope, sid, at=None):
    """The trim's centre: the one given, else the site's; a trim with neither is refused rather than keeping everything."""
    if at and at[0] is not None and at[1] is not None:
        lat, lon = float(at[0]), float(at[1])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("The trim's centre is off the map.")
        return lat, lon
    c = site_of(con, scope, sid)
    if not c:
        raise ValueError("Keeping only the readings near the site needs the site's location: this survey's "
                         + ("job has none set." if scope == "job" else "mission has none set." if scope == "mission" else "scratch has no site; give a centre."))
    return c


def trim(con, rid, centre, miles):
    """A run's readings beyond miles of centre are deleted. -> how many went."""
    lim, gone = float(miles) * MI_M, []
    for rowid, lat, lon in con.execute("SELECT rowid, lat, lon FROM survey_reading WHERE run_id=?", (int(rid),)):
        if _metres(centre[0], centre[1], lat, lon) > lim:
            gone.append((rowid,))
    con.executemany("DELETE FROM survey_reading WHERE rowid=?", gone)
    _restat(con, int(rid))
    return len(gone)


def _keep(con, scope, sid, keep_mi, at=None):
    """A run's trim as stored: (miles, centre lat, centre lon), or three Nones for none."""
    if not keep_mi:
        return None, None, None
    if float(keep_mi) <= 0:
        raise ValueError("Keep readings within how many miles? A distance above 0.")
    c = centre_for(con, scope, sid, at)
    return float(keep_mi), c[0], c[1]


def stop(con, scope, sid, rid, keep_mi=None, at=None):
    """A recording ends: its last reading is its end, and with keep_mi (or the run's own, set when it started) only the
    readings that near the site stay. The trim is stored on the run, so every batch that comes after is trimmed too."""
    r = _get(con, scope, sid, rid)
    gone = 0
    if keep_mi:
        keep = _keep(con, scope, sid, keep_mi, at)
        con.execute("UPDATE survey_run SET keep_mi=?, keep_lat=?, keep_lon=? WHERE id=?", (*keep, r["id"]))
        gone = trim(con, r["id"], keep[1:], keep[0])
    elif r["keep_mi"]:
        gone = trim(con, r["id"], (r["keep_lat"], r["keep_lon"]), r["keep_mi"])
    last = con.execute("SELECT MAX(ts) FROM survey_reading WHERE run_id=?", (r["id"],)).fetchone()[0]
    con.execute("UPDATE survey_run SET ended_at=? WHERE id=?", (last or int(time.time() * 1000), r["id"]))
    evidence(con, r["id"])
    con.commit()
    return {**run_info(con, scope, sid, r["id"]), "trimmed": gone}


# ---------------------------------------------------------------- evidence: what the tower engine reads of a run

def evidence(con, rid):
    """A run's evidence for the tower engine (plan 11/10, section 8): one survey_cell row per serving cell it heard, the primary
    or a carrier-aggregation leg, LTE or NR, with its network and cell ID: how many moments and readings, the first and last
    time, the strongest RSRP and that reading's own time and place (a place and a time the phone had together: review 11/12,
    round 2). The place only says which report a cell was heard near (heard()); it never places a site or picks its tower.
    Written again by every Stop and import (the run's rows replaced, by the run's own id); part of the caller's transaction,
    so it commits nothing. A neighbour is never one; a run with no serving cell named has none. -> how many cells."""
    rid = int(rid)
    con.execute("DELETE FROM survey_cell WHERE run_id=?", (rid,))
    where = "run_id=? AND serving>0 AND cid IS NOT NULL AND plmn LIKE '___-%' AND tech IN ('LTE', 'NR')"
    # SQLite's MAX() alone in a query takes the other columns from the row it picked: the strongest reading's place and time
    best = {(x["tech"], x["plmn"], x["cid"]): x for x in con.execute(
        f"SELECT tech, plmn, cid, carrier, MAX(rsrp) AS rsrp, ts, lat, lon, chan, pci, tac FROM survey_reading WHERE {where} GROUP BY tech, plmn, cid", (rid,))}
    seen = {(x["tech"], x["plmn"], x["cid"]): x for x in con.execute(
        f"SELECT tech, plmn, cid, COUNT(DISTINCT ts) AS n, COUNT(*) AS k, MIN(ts) AS t0, MAX(ts) AS t1, MAX(tac) AS tac FROM survey_reading WHERE {where} GROUP BY tech, plmn, cid", (rid,))}
    rows = []
    for k, b in best.items():
        n = seen[k]
        rows.append((rid, b["tech"], b["plmn"], b["cid"], b["tac"] if b["tac"] is not None else n["tac"], b["carrier"], b["pci"], b["chan"],
                     b["rsrp"], b["ts"], b["lat"], b["lon"], n["t0"], n["t1"], n["n"], n["k"]))
    con.executemany("INSERT INTO survey_cell(run_id, tech, plmn, cid, tac, carrier, pci, chan, best_rsrp, best_ts, lat, lon, first_ts, last_ts, moments, readings) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def heard(con, south, north, west, east, jobs=None, mission=None):
    """The survey evidence heard in a box, for the tower engine: one dict per serving cell per run, from the runs the caller
    may see. jobs: the DAS job ids its login can open (dashist.visible; None for every job): another job's run, its name, its
    places and times, never reach a login its access list leaves out (review 11/12, round 2). mission: only that mission's
    runs (as cells.gather reads only its captures). Never a hidden import's. No survey table yet: none."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='survey_cell'").fetchone():
        return []
    where, args = ["c.lat BETWEEN ? AND ? AND c.lon BETWEEN ? AND ?", "r.scope NOT LIKE ?"], [south, north, west, east, f"{HIDDEN}%"]
    if mission is not None:
        where.append("r.scope='mission' AND r.scope_id=?")
        args.append(int(mission))
    elif jobs is not None:
        jl = sorted(int(j) for j in jobs)
        where.append(f"(r.scope<>'job' OR r.scope_id IN ({','.join('?' * len(jl)) or 'NULL'}))")
        args += jl
    q = (f"SELECT c.*, r.name AS run_name, r.source, r.scope, r.scope_id, r.src_hash FROM survey_cell c JOIN survey_run r ON r.id=c.run_id "
         f"WHERE {' AND '.join(where)} ORDER BY c.run_id")
    # the same readings counted once (review 11/12, round 3: one log imported into scratch and into a job doubled a tower's heard
    # on site): one run per file (its hash, the first run that has it), and one row per cell heard over the same span with the
    # same count and best (a run's CSV imported back as a run of its own). Readings that only partly overlap still count twice
    out, files, cells = [], {}, set()
    for x in con.execute(q, args):
        x = dict(x)
        if x["src_hash"] and files.setdefault(x["src_hash"], x["run_id"]) != x["run_id"]:
            continue
        k = (x["tech"], x["plmn"], x["cid"], x["first_ts"], x["last_ts"], x["readings"], x["best_rsrp"])
        if k in cells:
            continue
        cells.add(k)
        out.append(x)
    return out


def backfill(con):
    """Evidence for every run that ended before survey_cell was written (round 1's runs, whose captures ensure() took out, and
    every run made where survey.py wrote none): each ended, visible run with readings and no survey_cell rows gets them, once
    (review 11/12, round 3: they waited for a Stop a finished run never gets, and an import can't come in again). A run whose
    readings name no cell has none and is looked at again at the next start. -> how many runs got rows."""
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='survey_cell'").fetchone():
        return 0
    rids = [x[0] for x in con.execute("SELECT id FROM survey_run WHERE ended_at IS NOT NULL AND readings>0 AND scope NOT LIKE ? "
                                      "AND id NOT IN (SELECT DISTINCT run_id FROM survey_cell) ORDER BY id", (f"{HIDDEN}%",))]
    got = sum(1 for rid in rids if evidence(con, rid))
    con.commit()
    return got


# ---------------------------------------------------------------- files: G-NetTrack Pro, a scanner's CSV, the template

MB = 1 << 20
# the made-up sample's files (static/survey.js sample, csv and kml) say so in their first lines: never imported as real readings
SAMPLE_MARK = b"SAMPLE: made-up data"
MAX_IMPORT = 256 * MB  # a log read in pieces as it arrives: an 8-hour scanner drive at 50 rows a second is about 140 MB
MAX_WHOLE = 16 * MB    # a log read whole (old Excel, JSON, KML, GPX, a COMPASS report): its rows sit in memory, about 25 times the file;
                       # a KMZ's KML is held to it unpacked (zipped, its size said nothing: review 11/10, round 2)
MAX_SHARED = 64 * MB   # an Excel workbook's shared strings (its text cells), unpacked: held, packed tight, while its rows are read
HIDDEN = "import"      # an import's run until its last row is in ("import:job", _hidden): no route reaches it (scope_of refuses it),
                       # so nobody sees half a file; a backup leaves it out (BACKUP_WHERE)
STALE_S = 86400        # a hidden run this old is what a copy stopped mid-import left: the next import, start or backup deletes it
# what the nightly my-work backup copies of each survey table (app.backup_user_data): never an import still hidden
BACKUP_WHERE = {"survey_run": f"scope NOT LIKE '{HIDDEN}%'",
                "survey_reading": f"run_id IN (SELECT id FROM main.survey_run WHERE scope NOT LIKE '{HIDDEN}%')",
                "survey_cell": f"run_id IN (SELECT id FROM main.survey_run WHERE scope NOT LIKE '{HIDDEN}%')"}


def _hidden(scope):
    """An import's run's scope until its last row is in: the scope it goes into, hidden ("import:job"), so deleting that job
    takes it too (drop_scope)."""
    return f"{HIDDEN}:{scope}"


class Duplicate(ValueError):
    """The same file again: refused, naming the run that already has it."""

    def __init__(self, run):
        super().__init__(f"This file is already in survey run {run['id']} ({run['name']}): a file is imported once.")
        self.run = run


class TooBig(ValueError):
    """A file over what an import takes: refused (413) before it is read."""


def too_big(size, whole=False, what="This log is"):
    if whole:
        return TooBig(f"{what} {size / MB:,.0f} MB. Old Excel (.xls), JSON, KML, KMZ and GPX logs are read whole, so they can be up to "
                      f"{MAX_WHOLE // MB} MB: save it as CSV (up to {MAX_IMPORT // MB} MB) or .xlsx and import that.")
    return TooBig(f"{what} {size / MB:,.0f} MB; a survey log can be up to {MAX_IMPORT // MB} MB. Split it by time and import each part.")


# the CSV export's columns, and so the template's: a log written in this shape imports as it is, and an export imports back
CSV_COLUMNS = ("time_utc", "lat", "lon", "acc_m", "speed_mps", "plmn", "carrier", "tech", "band", "chan", "pci", "tac", "cid", "site",
               "serving", "rsrp", "rsrq", "sinr", "ta")
# A survey log's columns by the names tools give them (compared lower-case, letters and digits only; a name ending in * also
# takes a header that starts with it, "RSRP (dBm)"). The survey's own table, never the grid test's (das.GRID_ALIASES): there
# "rssi" is a downlink level and "cell" a grid square, and their loose matches took "RS-SINR (dB)" as DL dBm and "Cell ID
# (ECI)" as a square (review 11/10). Fields are tried in this order, exact names first; NOT keeps a look-alike out.
SURVEY_ALIASES = {
    "time": ["time*", "timestamp*", "datetime*", "date*", "ts", "utctime*", "gpstime*",
             # named zone- or source-first ("Local Time", "UTC Date/Time", "GPS Date/Time", "GMT Time", "UTC"): after the names
             # above, so an exact Time or Timestamp still wins; found by none, the whole file was refused (review 11/10, round 3)
             "utc", "utcdatetime*", "localtime*", "localdatetime*", "gpsdatetime*", "gmttime*", "zulutime*", "devicetime*"],
    "lat": ["lat*", "latitude*", "gpslat*", "gpslatitude*"],
    "lon": ["lon*", "lng*", "long*", "longitude*", "gpslon*", "gpslng*", "gpslong*", "gpslongitude*"],
    "acc": ["accuracy*", "gpsaccuracy*", "horizontalaccuracy*", "hacc*"],  # not "acc" alone: a loose match would take "Account"
    "speed": ["speed*", "gpsspeed*", "velocity*"],
    "tech": ["technology*", "tech", "rat", "networktype*", "networktech*", "airinterface*", "systemtype*", "signaltype*", "mode", "protocol*"],
    "carrier": ["carrier*", "carriername*", "operator*", "operatorname*", "provider", "providername*", "networkoperator*", "networkname*", "mno", "wsp"],
    "plmn": ["plmn*", "plmnid*", "mccmnc*", "hni", "networkcode*"],
    "mcc": ["mcc"], "mnc": ["mnc"],
    "band": ["band*", "bandnumber*", "lteband*", "nrband*", "bandclass*", "frequencyband*"],
    "chan": ["earfcn*", "nrarfcn*", "arfcn*", "dlearfcn*", "ssbarfcn*", "dlnrarfcn*", "dlarfcn*", "channel*", "chan", "ch", "channelnumber*",
             "channelno*", "dlchannel*"],
    "freq": ["freqmhz*", "frequencymhz*", "dlfreq*", "dlfrequency*", "dlmhz*", "centerfreq*", "centerfrequency*", "dlcenterfreq*",
             "dlcentermhz*", "downlinkmhz*", "channelmhz*", "frequency*", "freq*", "mhz"],
    "pci": ["pci*", "physicalcellid*", "nrpci*", "ltepci*"],
    "eci": ["eci*", "ecellid*", "eutrancellid*", "ltecellid*", "cellidentity*", "cellid*", "ci", "cid"],
    "nci": ["nci*", "nrci*", "nrcellid*", "nrcellidentity*"],
    "enb": ["enb*", "enbid*", "enodeb*", "enodebid*", "node", "nodeid*", "gnb*", "gnbid*", "gnodeb*", "gnodebid*"],
    "tac": ["tac*", "lac*", "trackingareacode*", "trackingarea*"],
    "serving": ["serving", "servingcell", "isserving", "cellrole", "role", "registered", "cellstatus", "connectionstatus"],
    "rsrp": ["rsrp*", "ssrsrp*", "ltersrp*", "nrrsrp*"],
    "rsrq": ["rsrq*", "ssrsrq*", "ltersrq*", "nrrsrq*"],
    "sinr": ["sinr*", "dlsinr*", "snr*", "cinr*", "rscinr*", "rssinr*", "sssinr*", "rssnr*", "nrsinr*", "ltesinr*"],
    "ta": ["ta", "timingadvance*"],
}
NOT = {"time": ("timezone", "timeoffset"), "lat": ("latency",), "band": ("bandwidth", "bw"), "chan": ("mhz", "freq", "width", "bw"),
       "freq": ("band", "width"), "eci": ("ecio",),
       # a scanner's "Carrier RSSI (dBm)" is a measurement, and its Carrier Frequency, BW, Aggregation and Index say which carrier
       # frequency, never whose: read as the carrier, each cell was a network and a best server of its own (round 2)
       "carrier": ("rssi", "freq", "mhz", "bw", "width", "agg", "index", "count", "num", "level", "power", "dbm", "rsrp", "rsrq",
                   "sinr", "snr", "arfcn", "channel", "band", "type")}


def _key(h):
    return re.sub(r"[^a-z0-9]", "", str(h).lower())


def columns(head):
    """Which column holds which field of a survey log (SURVEY_ALIASES): exact names first, then a header that starts with a
    starred name, each field in its order, a column taken once. -> {field: header}"""
    norm = [(_key(h), h) for h in head]
    out, used = {}, set()
    for loose in (False, True):
        for field, names in SURVEY_ALIASES.items():
            if field in out:
                continue
            bar = NOT.get(field, ())
            for a in names:
                star, a = a.endswith("*"), a.rstrip("*")
                hit = next((h for k, h in norm if h not in used and not any(x in k for x in bar)
                            and (k.startswith(a) and star and len(a) >= 3 if loose else k == a)), None)
                if hit:
                    out[field] = hit
                    used.add(hit)
                    break
    return out


def _iso(ms):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms // 1000)) + f".{ms % 1000:03d}Z"


def _plain(v):
    return "" if v is None else int(v) if isinstance(v, float) and v.is_integer() else v


def csv_text(rows, source=None):
    """Readings (dicts with COLS, or rows in COLS order) as the CSV export writes them; source, the run's (SOURCES), as a last
    column, so a run exported and imported again keeps its kind (a scanner's stays a scanner's: review 11/10, round 7)."""
    import csv
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(CSV_COLUMNS + (("source",) if source else ()))
    for r in rows:
        d = r if isinstance(r, dict) else dict(zip(COLS, r))
        w.writerow([_iso(d["ts"]) if c == "ts" else _plain(d.get(c)) for c in COLS] + ([source] if source else []))
    return out.getvalue()


def template_text():
    """The survey template: the export's columns and four example readings at one moment (an AT&T LTE primary cell, its
    carrier-aggregation leg, a neighbour, and T-Mobile's 5G NR leg), so a person's own log can be written to fit."""
    t = calendar.timegm((2026, 11, 10, 15, 0, 0, 0, 0, 0)) * 1000
    base = {"ts": t, "lat": 41.3381567, "lon": -74.1938204, "acc": 4.8, "speed": 12.5, "plmn": "310-410", "carrier": "AT&T", "tech": "LTE", "tac": 12345, "ta": 3}
    return csv_text([
        {**base, "band": "12", "chan": 5110, "pci": 101, "cid": 207985155, "site": 812442, "serving": 1, "rsrp": -95.5, "rsrq": -11, "sinr": 8},
        {**base, "band": "66", "chan": 66986, "pci": 101, "cid": 207985161, "site": 812442, "serving": 2, "rsrp": -99, "rsrq": -12.5, "sinr": 6, "ta": None},
        {**base, "band": "12", "chan": 5110, "pci": 377, "cid": None, "site": None, "serving": 0, "rsrp": -108, "rsrq": -15, "sinr": None, "ta": None},
        {**base, "plmn": "310-260", "carrier": "T-Mobile", "tech": "NR", "band": "n71", "chan": 126270, "pci": 501, "tac": None, "cid": None,
         "site": None, "serving": 2, "rsrp": -101, "rsrq": -12, "sinr": 4, "ta": None}])


# a cell's role as logs write it: 1 the primary serving cell, 2 a carrier-aggregation or 5G NSA leg, 0 a neighbour (compared
# lower-case, letters and digits only; Android's CONNECTION_PRIMARY_SERVING and its kin too)
ROLES = {1: ("true", "yes", "y", "t", "serving", "servingcell", "primary", "primarycell", "primaryserving", "pcell", "registered",
             "connectionprimaryserving", "pcc", "primarycomponentcarrier"),
         2: ("ca", "scell", "secondary", "secondarycell", "secondaryserving", "connectionsecondaryserving", "nsa", "leg",
             "carrieraggregation", "pscell", "scc", "secondarycomponentcarrier"),
         0: ("false", "no", "n", "f", "neighbour", "neighbor", "neighbours", "neighbors", "neighbourcell", "neighborcell", "nb", "ncell",
             "detected", "monitored", "none", "connectionnone", "notserving")}


def _serving(v):
    """A role -> 1, 2 or 0, or None when it isn't one DAStastic knows (never then taken for the primary). A number first: a
    float column writes "0.0" and "2.0", which were stored as primaries (review 11/10), and in a comma-decimal locale "1,0".
    A word may carry an index: a log numbers its legs ("SCell1", "SCC 2", "Secondary Cell 1"; round 2)."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)) or re.fullmatch(r"\s*[-+]?\d+(?:[.,]\d+)?\s*", str(v)):
        x = _dec(v)
        return int(x) if x in (0, 1, 2) else None
    t = _key(v)
    return next((k for k, words in ROLES.items() if t in words or re.sub(r"\d+$", "", t) in words), None)


def _speed_factor(head):
    """m/s per unit of a speed column, from its name: km/h (G-NetTrack and most loggers), mph, else m/s."""
    t = str(head or "").lower()
    return 1 / 3.6 if re.search(r"km\s*/?\s*h|kph|kmh", t) else 0.44704 if "mph" in t else 1.0


# ---------------------------------------------------------------- reading a file in pieces

class _Upload(io.RawIOBase):
    """The file as it arrives (the request body, or bytes): read in pieces, hashed on the way, never past its length."""

    def __init__(self, src, size):
        super().__init__()
        self.src, self.left, self.sha = src, size, hashlib.sha256()

    def readable(self):
        return True

    def readinto(self, b):
        if self.left <= 0:
            return 0
        data = self.src.read(min(len(b), self.left))
        if not data:
            raise ValueError("The file didn't arrive whole. Try again.")
        n = len(data)
        b[:n] = data
        self.left -= n
        self.sha.update(data)
        return n

    def rest(self):
        """Reads (and hashes) what's left of the file past what its table needed, through no reader of the table's: a text
        reader closes what it wraps when it's done."""
        b = bytearray(1 << 20)
        while self.left > 0:
            self.readinto(memoryview(b)[:min(len(b), self.left)])


def _kind(name, head):
    """How a log is read: "xlsx" (an Excel workbook: from a scratch copy, a row at a time, _xlsx_rows), "kmz" (its KML read
    whole, held to MAX_WHOLE unpacked), "whole" (old Excel, KML, GPX, JSON, a COMPASS report: das.read_table, up to
    MAX_WHOLE), else "text" (a table read row by row as it arrives). Zipped files are told apart as das.read_table tells them
    (.kmz by its name), and by the zip's first file: a KMZ starts with its KML."""
    import xlsread
    n = (name or "").lower()
    if head[:8] == xlsread.MAGIC:
        return "whole"
    first = head[30:30 + int.from_bytes(head[26:28], "little")].decode("utf-8", "replace").lower() if head[:4] == b"PK\x03\x04" else ""
    if n.endswith(".kmz") or first.endswith(".kml"):
        return "kmz"
    if head[:2] == b"PK" or n.endswith(".xlsx"):
        return "xlsx"
    if n.endswith((".xls", ".kml", ".gpx", ".json")):
        return "whole"
    t = head[:2000].decode("utf-8-sig", "replace").lstrip()
    return "whole" if t.upper().startswith("CEL-FI COMPASS") or "<kml" in t[:500] or "<gpx" in t[:500] or t[:1] in ("[", "{") else "text"


def _delimiter(line):
    """The separator a header line uses (comma, semicolon, tab or bar), by count. csv.Sniffer reads only the first 5,000
    characters, and G-NetTrack Pro's full header alone is 2,400."""
    n = {d: line.count(d) for d in (",", ";", "\t", "|")}
    d = max(n, key=lambda k: n[k])
    return d if n[d] else ","


def _text_rows(buf, head):
    """A text table as it arrives -> (format, headers, an iterator of {header: value}). UTF-8 (with a BOM or without), or
    UTF-16 with its BOM. Blank lines are skipped, as das.read_table skips them."""
    import csv
    enc = "utf-16" if head[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    line = next((x for x in head.decode(enc, "replace").splitlines() if x.strip()), "")
    d = _delimiter(line)
    reader = csv.reader(io.TextIOWrapper(buf, encoding=enc, errors="replace", newline=""), delimiter=d)
    try:
        cols = next(([x.strip() or f"col{i + 1}" for i, x in enumerate(r)] for r in reader if any(x.strip() for x in r)), [])
    except csv.Error as e:
        raise ValueError(f"This file isn't a table DAStastic can read ({e}).") from None

    def rows():
        try:
            for r in reader:
                if any(x.strip() for x in r):
                    yield {cols[i]: v.strip() for i, v in enumerate(r) if i < len(cols)}
        except csv.Error as e:
            raise ValueError(f"Line {reader.line_num} of this file can't be read as a table ({e}).") from None
    return ("tsv" if d == "\t" else "csv"), cols, rows()


# ---------------------------------------------------------------- an Excel workbook, a row at a time

MAX_SHEET = 8 * MAX_IMPORT  # a worksheet unpacked (it streams, so this bounds the time an import takes, not its memory)
_DATE_FMTS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))  # Excel's own date and time formats
EXCEL_DAYS = (25569, 32874, 73051)  # an Excel date number (1900 system) at 1970-01-01, 1990-01-01 and 2100-01-01


def _excel_iso(v, d1904=False):
    """An Excel date number (days since 1899-12-30; since 1904-01-01 in an old Mac workbook) -> "YYYY-MM-DD HH:MM:SS.mmm" with
    no zone, the time it shows (a log's own text times carry none either: parse_time reads them as the phone's local time,
    or UTC); None when it isn't one."""
    import datetime
    x = _num(v)
    if x is None or not 0 <= x < 2958466:
        return None
    d = datetime.datetime(*((1904, 1, 1) if d1904 else (1899, 12, 30))) + datetime.timedelta(milliseconds=round(x * 86400000))
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d} {d.hour:02d}:{d.minute:02d}:{d.second:02d}.{d.microsecond // 1000:03d}"


def _excel_time(v, excel):
    """A time column's value from a workbook that can't say which cells are dates (old .xls, or an .xlsx with no styles):
    a plain number between 1990 and 2100 as Excel counts days is that date and time; anything else as it is. excel: 1900,
    or 1904 for an old Mac workbook. Excel keeps a time it took from a CSV as such a number (review 11/10, round 2: every
    row "no time")."""
    if not excel or v is None or not re.fullmatch(r"\s*\d{5}(?:\.\d+)?\s*", str(v)):
        return v
    x = float(v) + (1462 if excel == 1904 else 0)  # the 1904 system counts 1,462 days fewer
    return _excel_iso(x) if EXCEL_DAYS[1] <= x < EXCEL_DAYS[2] else v


class _Strings:
    """A workbook's shared strings packed in one buffer: a str each held two to four times its text. Each kept to MAX_FIELD
    characters, and the last few thousand handed out kept as str, so cells pointing at one string share it: each cell decoded
    its own copy, whole, and one 60 MB string in 21 cells of a 62 KB workbook took 1,320 MB (review 11/10, round 5)."""
    CACHE = 4096

    def __init__(self):
        import array
        self.buf, self.ends, self.cache = bytearray(), array.array("q"), {}

    def add(self, s):
        self.buf += s[:MAX_FIELD].encode("utf-8")
        self.ends.append(len(self.buf))

    def get(self, i):
        if not 0 <= i < len(self.ends):
            return ""
        s = self.cache.get(i)
        if s is None:
            if len(self.cache) >= self.CACHE:
                self.cache.clear()
            s = self.cache[i] = self.buf[self.ends[i - 1] if i else 0:self.ends[i]].decode("utf-8")
        return s


def _local(tag):
    return tag[tag.rfind(" ") + 1:]  # expat with a namespace separator: "<namespace> <name>"


MAX_COLS = 16384     # Excel's own limits (column XFD, 32,767 characters a cell): a workbook past them was made by hand, and one
MAX_CELL = 32767     # cell at r="ZZZZZZ2" built a 321-million-entry row, a 600 MB one held it all (review 11/10, round 3)
MAX_FIELD = 1000     # characters of a cell's text a row carries on: a survey's fields are a few; every cell pointing at one 32,767-
                     # character shared string got its own copy, and a peek's 2,000 rows held 131 MB of them a column (round 4)


def _no_entities(p):
    """An expat parser that refuses a DOCTYPE or entity declaration: OOXML forbids them in a package's parts and nothing
    writes them, but expat expands a flat entity up to 100 times, so a 6 KB workbook's &e; references became 1.6 GB of
    text past MAX_SHARED's 64 MB (review 11/10, round 3)."""
    def refuse(*_a):
        raise ValueError("This workbook declares XML entities, which Excel never writes: DAStastic doesn't read it.")
    p.StartDoctypeDeclHandler = p.EntityDeclHandler = refuse
    return p


def _xlsx_shared(src):
    """xl/sharedStrings.xml -> _Strings: each <si>'s text (its runs joined, never the phonetic guide), read as it streams."""
    from xml.parsers import expat
    out, st = _Strings(), {"si": None, "t": None, "rph": 0}

    def start(tag, _a):
        k = _local(tag)
        if k == "si":
            st["si"] = []
        elif k == "rPh":
            st["rph"] += 1
        elif k == "t" and st["si"] is not None and not st["rph"]:
            st["t"] = st["si"]

    def end(tag):
        k = _local(tag)
        if k == "si" and st["si"] is not None:
            out.add("".join(st["si"]))
            st["si"] = None
        elif k == "rPh":
            st["rph"] -= 1
        elif k == "t":
            st["t"] = None

    def text(s):
        if st["t"] is not None:
            st["t"].append(s)
    p = _no_entities(expat.ParserCreate(namespace_separator=" "))
    p.StartElementHandler, p.EndElementHandler, p.CharacterDataHandler = start, end, text
    try:
        p.ParseFile(src)
    except expat.ExpatError as e:
        raise ValueError(f"This workbook's text can't be read ({e}).") from None
    return out


def _date_code(code):
    """Whether an Excel number format shows a date or a time: d, m, y, h or s outside quotes, brackets and escapes."""
    return bool(re.search(r"[dmyhs]", re.sub(r'"[^"]*"|\[[^\]]*\]|\\.|[_*].', "", str(code or "")), re.I))


def _xlsx_dates(xml):
    """xl/styles.xml -> the cell styles (a cell's s) whose number format shows a date or a time."""
    import xml.etree.ElementTree as ET
    import das
    ns = das.XLSX_NS
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:  # as _no_entities: ElementTree expands them too
        raise ValueError("This workbook declares XML entities, which Excel never writes: DAStastic doesn't read it.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return set()
    codes = {int(f.get("numFmtId")): f.get("formatCode") for f in root.iter(ns + "numFmt") if (f.get("numFmtId") or "").isdigit()}
    xfs, out = root.find(ns + "cellXfs"), set()
    for i, xf in enumerate(xfs if xfs is not None else ()):
        fid = int(xf.get("numFmtId")) if (xf.get("numFmtId") or "").isdigit() else 0
        if _date_code(codes[fid]) if fid in codes else fid in _DATE_FMTS:
            out.add(i)
    return out


def _xlsx_rows(f):
    """An Excel workbook (a seekable file) -> (headers, an iterator of {header: value}, excel): its first worksheet, as
    das.read_table picks it, a row at a time. The sheet streams through expat and its shared strings are packed (_Strings), so
    a workbook is held at about the size of its text, never its rows: das.read_table unpacked the sheet and built it whole,
    175 times the file, and a 6 MB scanner drive saved as .xlsx took a 1,200 MB licensed copy past its limit (review 11/10,
    round 2). A number in a date or time format comes as the time it shows (_excel_iso). excel: the date system (1900, or
    1904) when the workbook has no styles to say which cells are dates, so a time column's numbers are read as dates
    (_excel_time); None when it has them."""
    import zipfile
    from xml.parsers import expat
    try:
        z = zipfile.ZipFile(f)
        sizes = {i.filename: i.file_size for i in z.infolist()}
    except (zipfile.BadZipFile, OSError, ValueError):
        raise ValueError("This file isn't an Excel workbook DAStastic can read.") from None
    sheets = sorted((n for n in sizes if re.match(r"xl/worksheets/sheet\d+\.xml$", n)), key=lambda n: int(re.search(r"(\d+)\.xml$", n).group(1)))
    if not sheets:
        raise ValueError("That workbook has no worksheets.")
    if sizes.get("xl/sharedStrings.xml", 0) > MAX_SHARED:
        raise TooBig(f"This workbook's text is {sizes['xl/sharedStrings.xml'] / MB:,.0f} MB unpacked; an Excel log can carry up to "
                     f"{MAX_SHARED // MB} MB of it. Save it as CSV and import that.")
    if sizes[sheets[0]] > MAX_SHEET:
        raise too_big(sizes[sheets[0]], what="This workbook's sheet is, unpacked,")
    small = lambda n: z.read(n) if 0 < sizes.get(n, 0) <= 4 * MB else b""  # noqa: E731
    shared = _Strings()
    if "xl/sharedStrings.xml" in sizes:
        with z.open("xl/sharedStrings.xml") as src:
            shared = _xlsx_shared(src)
    styles = small("xl/styles.xml")
    dates = _xlsx_dates(styles) if styles else None
    d1904 = bool(re.search(rb"date1904\s*=\s*[\"'](?:1|true)[\"']", small("xl/workbook.xml")))
    ready, st = [], {"row": None, "col": 0, "cell": None, "v": None, "is": False, "rph": 0, "n": 0}

    def start(tag, a):
        k = _local(tag)
        if k == "row":
            st["row"], st["col"] = {}, 0
        elif k == "c" and st["row"] is not None:
            m = re.match(r"[A-Za-z]+", a.get("r") or "")
            i = st["col"]
            if m:
                i = 0
                for ch in m.group(0).upper():
                    i = i * 26 + ord(ch) - 64
                i -= 1
            if i >= MAX_COLS:
                raise ValueError(f"This workbook has a cell past column XFD, Excel's last ({(a.get('r') or '')[:20]}): DAStastic doesn't read it.")
            st["cell"], st["col"], st["n"] = [i, a.get("t"), a.get("s"), []], i + 1, 0
        elif k == "v" and st["cell"] is not None:
            st["v"] = st["cell"][3]
        elif k == "is":
            st["is"] = True
        elif k == "rPh":
            st["rph"] += 1
        elif k == "t" and st["is"] and not st["rph"] and st["cell"] is not None:
            st["v"] = st["cell"][3]

    def end(tag):
        k = _local(tag)
        if k in ("v", "t"):
            st["v"] = None
        elif k == "is":
            st["is"] = False
        elif k == "rPh":
            st["rph"] -= 1
        elif k == "c" and st["cell"] is not None:
            i, t, s, parts = st["cell"]
            raw = "".join(parts)
            if t == "s":
                v = shared.get(int(raw)) if raw.strip().isdigit() else ""
            elif t is None or t == "n":
                v = (_excel_iso(raw, d1904) if raw and dates and s and s.isdigit() and int(s) in dates else None) or raw
            else:  # inlineStr, str (a formula's text), b, e, d
                v = raw
            st["row"][i], st["cell"] = v, None
        elif k == "row" and st["row"] is not None:
            r = st["row"]
            ready.append([r.get(j, "") for j in range(max(r) + 1)] if r else [])
            st["row"] = None

    def text(s):
        if st["v"] is not None:
            st["n"] += len(s)
            if st["n"] > MAX_CELL:
                raise ValueError(f"This workbook has a cell of more than {MAX_CELL:,} characters, Excel's most: DAStastic doesn't read it.")
            st["v"].append(s)

    def table():
        p = _no_entities(expat.ParserCreate(namespace_separator=" "))
        p.StartElementHandler, p.EndElementHandler, p.CharacterDataHandler = start, end, text
        with z.open(sheets[0]) as src:
            while True:
                chunk = src.read(1 << 16)
                try:
                    p.Parse(chunk, not chunk)
                except expat.ExpatError as e:
                    raise ValueError(f"This workbook's sheet can't be read ({e}).") from None
                yield from ready
                ready.clear()
                if not chunk:
                    return
    it = table()
    head = next(([str(h).strip()[:MAX_FIELD] or f"col{i + 1}" for i, h in enumerate(r)] for r in it if any(str(x).strip() for x in r)), [])

    def rows():
        for r in it:
            if any(str(x).strip() for x in r):
                yield {head[i]: str(v).strip()[:MAX_FIELD] for i, v in enumerate(r) if i < len(head)}
    return head, rows(), (None if dates is not None else 1904 if d1904 else 1900)


def _kmz_check(data):
    """A KMZ's KML (the first in it, as captures.parse_kmz reads it) is read whole: held to MAX_WHOLE unpacked."""
    import zipfile
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            k = next((i for i in z.infolist() if i.filename.lower().endswith(".kml")), None)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise ValueError("This KMZ isn't a file DAStastic can read.") from None
    if k is not None and k.file_size > MAX_WHOLE:
        raise too_big(k.file_size, whole=True, what="This KMZ's KML is, unpacked,")


# ---------------------------------------------------------------- what a log's rows say

def _role(v, log):
    """A row's role in a log with a role column: blank is the primary (none given), unless the column has roles in it
    (log["blank"] 0: _roles_known), where a blank is a neighbour, counted for the notes: a "Serving" column marking only the
    serving cell (Y, and nothing on the neighbours) stored every neighbour as a primary (review 11/10, round 3). A word
    DAStastic doesn't know is counted for the import's notes and read as a neighbour, never as the primary (11/10: "Neighbor
    Cell" was a primary)."""
    if v is None or str(v).strip() == "":
        b = log.get("blank", 1)
        if not b:
            log["roles"]["(blank)"] = log["roles"].get("(blank)", 0) + 1
        return b
    k = _serving(v)
    if k is None:
        w = str(v).strip()[:40]
        log["roles"][w] = log["roles"].get(w, 0) + 1
        return 0
    return k


def _template_log(cols, utc_offset, excel=None):
    """The template, or an export: its own columns, every reading's role written down, and the run's kind when the export
    wrote it (a source column: csv_text), else "csv"."""
    log = {"source": "csv", "columns": dict(zip(COLS, CSV_COLUMNS)), "notes": [], "local": 0, "roles": {}, "excel": excel,
           "used": set(CSV_COLUMNS) | ({"source"} if "source" in cols else set()), "time_col": CSV_COLUMNS[COLS.index("ts")]}

    def row(r):
        d = {c: r.get(h) for h, c in zip(CSV_COLUMNS, COLS)}
        d["ts"] = parse_time(_log_time(log, d["ts"]))[0]
        d["xshort"] = log.pop("_xs", None)
        d["serving"] = _role(d["serving"], log)
        k = str(r.get("source") or "").strip().lower()
        if k in SOURCES and log["source"] == "csv":
            log["source"] = k
        return d
    log["row"] = row
    return log


def _sa(mode):
    """Whether G-NetTrack's NetworkMode says 5G standalone ("5G SA", "NR_SA"; never NSA)."""
    return bool(re.search(r"(?<![a-z])sa(?![a-z])", str(mode or "").lower()))


def _gnettrack_log(cols, utc_offset, excel=None):
    """G-NetTrack Pro's log: Level / Qual / SNR are RSRP / RSRQ / SINR on LTE, ARFCN the channel, PSC the PCI, LAC the TAC,
    Node the eNB and CellID the cell's number at it (ECI = Node x 256 + CellID; a CellID over 255 is the whole ECI), Speed
    in km/h, Timestamp the phone's local time. A 5G row not marked standalone is 5G NSA, where the manual says Node and CellID
    are the serving LTE anchor's (the vendor's own sample: they equal SecondCell_NODE and SecondCell_CELLID on 99 of 101 rows,
    and the PSC equals SecondCell_PSC): those stay off the NR reading, which has no site or cell of its own (review 11/10),
    and so do its PSC (kept only where a SecondCell_PSC says the anchor's is another) and LAC. A cell Android couldn't read
    yet is CellInfo.UNAVAILABLE (2^31 - 1), which G-NetTrack splits into Node 262143 and CellID 8191 (RAWCELLID 2147483647,
    LAC 65535): no eNB, cell or TAC (round 2: stored as eNB 262143, a server of its own)."""
    n = {_key(h): h for h in cols}
    log = {"source": "gnettrack", "local": 0, "nsa": 0, "roles": {}, "notes": ["G-NetTrack Pro log: every row is the phone's serving cell; speed read in km/h."],
           "columns": {k: n[k] for k in ("timestamp", "latitude", "longitude", "level", "qual", "snr", "arfcn", "node", "cellid") if k in n},
           "excel": excel, "time_col": n.get("timestamp"), "used": set(n.values())}

    def g(r, k):
        return r.get(n[k]) if k in n else None

    def row(r):
        ts, zoned = parse_time(_log_time(log, g(r, "timestamp")), utc_offset)
        xs = log.pop("_xs", None)
        log["local"] += ts is not None and not zoned
        tech = tech_of(g(r, "networktech")) or tech_of(g(r, "networkmode")) or g(r, "networktech")
        node, cell = _int(g(r, "node"), 0, (1 << 32) - 1), _int(g(r, "cellid"), 0, (1 << 36) - 1)
        pci = g(r, "pci") if "pci" in n else g(r, "psc")
        tac = g(r, "lac") if "lac" in n else g(r, "tac")
        if tech == "NR" and not _sa(g(r, "networkmode")):
            log["nsa"] += 1
            node = cell = tac = None
            anchor = str(g(r, "secondcellpsc") or "").strip()
            if not anchor or anchor == str(pci or "").strip():
                pci = None  # the anchor's, or nothing says it isn't
        elif (node, cell) == (262143, 8191) or _int(g(r, "rawcellid"), 0, 1 << 32) == 2147483647:
            log["unavailable"] = log.get("unavailable", 0) + 1
            node = cell = None
            if _int(tac, 0, 1 << 16) == 65535:
                tac = None
        cid = (node << 8) | cell if tech == "LTE" and cell is not None and cell <= 255 and node is not None else cell
        sp = _num(g(r, "speed"))
        return {"ts": ts, "lat": g(r, "latitude"), "lon": g(r, "longitude"), "acc": g(r, "accuracy"), "speed": None if sp is None else sp / 3.6,
                "plmn": g(r, "operator"), "carrier": g(r, "operatorname"), "tech": tech, "band": g(r, "band"), "chan": g(r, "arfcn"),
                "pci": pci, "tac": tac, "cid": cid, "site": node, "serving": 1, "rsrp": g(r, "level"), "rsrq": g(r, "qual"), "sinr": g(r, "snr"), "ta": g(r, "ta"), "xshort": xs}
    log["row"] = row
    return log


def _table_log(head, utc_offset, excel=None, roles=True):
    """Any other table: a scanner's export (PCTEL SeeHawk and the like) or a phone app's log, its columns found by the survey's
    own names (columns). Without a serving column it's read as a scanner (fold: _Fold), and so it is when the column holds no
    role DAStastic knows (roles=False: _roles_known). A channel comes from its own column,
    else from a MHz column (chan_of_mhz). With no technology given, a row is 5G NR when the file's columns are NR's own (SS-RSRP,
    NR-ARFCN), or the row's band is an n band (nr_band), its channel an NR channel and no LTE one, its frequency (with no
    channel) one no LTE band has and an NR band does (C-band's 3,750 MHz: round 2), or its PCI over 503; else LTE, and the
    import says how many it took for which (11/10: an NR scan with no Technology column was stored as LTE, its n41 channels
    and PCIs dropped)."""
    m = columns(head)
    if not roles:
        m.pop("serving", None)
    if not (m.get("lat") and m.get("lon")):
        raise ValueError("No latitude and longitude columns: a survey needs where each reading was taken.")
    if not m.get("rsrp"):
        raise ValueError("No RSRP column: the tiles are coloured by each cell's RSRP.")
    if not m.get("time"):
        raise ValueError("No time column: each reading needs when it was taken.")
    spf = _speed_factor(m.get("speed"))
    # a time column whose name says UTC holds UTC, whatever offset the import is given for a phone's local times (as the
    # template's time_utc; round 2: "Time (UTC)" moved by it). "GPS Time" says nothing: many apps write it local. One that
    # names an offset ("Time (UTC-05:00)", "Timestamp (UTC-5)", "Date/Time (GMT-05:00)") holds times at that offset: read as
    # UTC, they were 5 h early and said UTC (review 11/10, round 3)
    oz = re.search(r"(?:utc|gmt)\s*([+\u2212-])\s*(\d{1,2})(?:\s*:?\s*(\d{2}))?", str(m["time"]), re.I)
    named = None
    gps = "gps" in _key(m["time"])
    if oz and int(oz.group(2)) <= 14 and int(oz.group(3) or 0) < 60:
        named = (-1 if oz.group(1) != "+" else 1) * (int(oz.group(2)) * 60 + int(oz.group(3) or 0))
    utc = named is None and bool(re.search(r"utc|gmt|zulu", _key(m["time"])))
    if named is not None:
        notes = [f"The time column ({m['time']}) names its offset: its times were read at UTC{named / 60:+g} h"
                 + (", not moved by the UTC offset given." if utc_offset is not None else ".")]
    elif utc and utc_offset is not None:
        notes = [f"The time column ({m['time']}) says UTC: its times were read as UTC, not moved by the UTC offset given."]
    else:
        notes = []
    nr_cols = any(_key(m.get(k) or "").startswith(("ss", "nr")) for k in ("rsrp", "rsrq", "sinr")) or _key(m.get("chan") or "").startswith(("nr", "ssb", "dlnr"))
    log = {"source": "phone" if m.get("serving") else "scanner", "local": 0, "notes": notes, "fold": not m.get("serving"), "columns": dict(m), "roles": {}, "assumed": {},
           "role_col": m.get("serving"), "excel": excel, "time_col": m["time"], "used": set(columns(head).values()), "gps": gps}

    def col(r, k):
        return r.get(m[k]) if m.get(k) else None

    # a cell's identity in a column whose name says hex ("Cell ID (hex)", "TAC (hex)") is read as hex (round 2: its first digits)
    hexed = {k: "hex" in _key(m.get(k) or "") for k in ("eci", "nci", "enb", "tac")}

    def whole(r, k, hi):
        return (_hex if hexed[k] else _int)(col(r, k), 0, hi)

    def tech_for(r, band, chan, pci):
        t = col(r, "tech")
        if t not in (None, ""):
            return t
        c, p = _int(chan, 0, 3279165), _int(pci, 0, 1007)
        mhz = _dec(col(r, "freq")) if c is None and m.get("freq") else None
        nr = nr_cols or nr_band(band) or (c is not None and band_of("LTE", c) is None and bool(nr_bands(c))) \
            or (mhz is not None and not lte_mhz(mhz) and bool(nr_bands_mhz(mhz))) or (p is not None and p > 503)
        t = "NR" if nr else "LTE"
        log["assumed"][t] = log["assumed"].get(t, 0) + 1
        return t

    def row(r):
        ts, zoned = parse_time(_log_time(log, col(r, "time")), named if named is not None else None if utc else utc_offset)
        xs = log.pop("_xs", None)
        log["local"] += ts is not None and not zoned and not utc and named is None
        band, chan, pci = col(r, "band"), col(r, "chan"), col(r, "pci")
        tech = tech_for(r, band, chan, pci)
        if chan in (None, "") and m.get("freq"):
            chan = chan_of_mhz(tech_of(tech), _dec(col(r, "freq")), band if str(band or "").strip() else None)
        carrier, plmn = col(r, "carrier"), col(r, "plmn")
        if carrier is not None and re.fullmatch(r"\s*\d{3}\s*[-_/ ]?\s*\d{2,3}\s*", str(carrier)) and not plmn:
            # an "Operator" column holding the network code, as plmn_of reads one: "310-410" and "310 410" stayed the carrier,
            # which carrier_of refuses as a number, so every carrier was one network and one best server (round 3)
            carrier, plmn = None, carrier
        enb = whole(r, "enb", (1 << 32) - 1)
        cid = whole(r, "eci", (1 << 36) - 1)
        if cid is None:
            cid = whole(r, "nci", (1 << 36) - 1)
        if tech_of(tech) == "LTE" and cid is not None and cid <= 255 and enb is not None:
            cid = (enb << 8) | cid  # the cell's number at its eNB
        sp = _dec(col(r, "speed"))
        return {"ts": ts, "lat": col(r, "lat"), "lon": col(r, "lon"), "acc": col(r, "acc"), "speed": None if sp is None else sp * spf,
                "plmn": plmn, "mcc": col(r, "mcc"), "mnc": col(r, "mnc"), "carrier": carrier, "tech": tech, "band": band,
                "chan": chan, "mhz": col(r, "freq"), "pci": pci, "tac": whole(r, "tac", (1 << 24) - 1) if hexed["tac"] else col(r, "tac"), "cid": cid, "site": enb,
                "serving": (col(r, "serving") if log.get("role_pending") else _role(col(r, "serving"), log)) if m.get("serving") else None,
                "rsrp": col(r, "rsrp"), "rsrq": col(r, "rsrq"),
                "sinr": col(r, "sinr"), "ta": col(r, "ta"), "xshort": xs}
    log["row"] = row
    return log


def _end_notes(log, fold, utc_offset):
    """What the import tells the person: the log's own notes, then what it had to assume or couldn't read."""
    notes = list(log["notes"])
    a = log.get("assumed") or {}
    if a:
        notes.append(f"{sum(a.values()):,} rows named no technology: " + " and ".join(f"{n:,} read as {'5G NR' if t == 'NR' else 'LTE'}" for t, n in sorted(a.items()))
                     + " (5G NR by an NR column name, an n band, an NR channel or frequency, or a PCI over 503).")
    if log.get("nsa"):
        notes.append(f"{log['nsa']:,} 5G rows were logged in NSA mode, where G-NetTrack's Node, CellID, LAC and PSC are the LTE anchor's: "
                     "those 5G readings carry no site, cell or PCI of their own.")
    if log.get("unavailable"):
        notes.append(f"{log['unavailable']:,} rows had a cell Android couldn't read yet (Node 262143, CellID 8191): kept with no eNB or cell.")
    if log.get("off_dates"):
        notes.append(f"{log['off_dates']:,} times were Excel dates far from the rest of the log's (more than {DAY_WINDOW} days from its "
                     "main stretch, later than tomorrow, or before 1990): those have no time.")
    if log.get("off_epoch"):
        notes.append(f"{log['off_epoch']:,} times were numbers that as Unix time are before 2000 or after tomorrow (a GPS time of week, "
                     "or seconds since the device started?): those rows have no time.")
    if log.get("gps_read"):
        notes.append(f"{log['gps_read']:,} times in the {log.get('time_col')} column were read as seconds since the GPS epoch (1980-01-06): "
                     "as Unix time they were ten years back.")
    roles = log.get("roles") or {}
    if roles:
        notes.append(f"{sum(roles.values()):,} rows had a role DAStastic doesn't know ({', '.join(sorted(roles)[:5])}): read as neighbours, "
                     "never as the serving cell.")
    if fold:
        notes.append(fold.note())
    return notes + _local_note(log["local"], utc_offset)


def _log_of(cols, utc_offset, excel=None):
    """Which kind of log a table is, by its columns: the template (or an export) by its exact columns, G-NetTrack Pro by its
    own (as intake.py and daswalk.js know it), anything else as a scanner's table. excel: a workbook's date system when it
    can't say which cells are dates (_excel_time reads its time column's date numbers)."""
    n = {_key(h): h for h in cols}
    if all(c in cols for c in CSV_COLUMNS):
        return _template_log(cols, utc_offset, excel)
    if all(k in n for k in ("timestamp", "networktech", "level")) and ("operatorname" in n or "operator" in n):
        return _gnettrack_log(cols, utc_offset, excel)
    return _table_log(cols, utc_offset, excel)


UNKNOWN_ROLES = (2147483647, -1)  # a number a logger writes for a role not known (Android's CellInfo.CONNECTION_UNKNOWN)
ROLE_PEEK = 2000
PEEK_COST = 8 * MB  # and at most about this much held: a value's characters and 64 bytes an entry (_peek)


def _peek(rows):
    """The first ROLE_PEEK rows, or fewer when they hold more than PEEK_COST: a hand-made workbook's 2,000 rows of 150 cells
    of 1,000 characters each took 1,191 MB to look at (review 11/10, round 5). -> (the rows looked at, the rest)"""
    head, cost = [], 0
    for r in rows:
        head.append(r)
        cost += sum(64 + (len(v) if isinstance(v, str) else 8) for v in r.values())
        if len(head) >= ROLE_PEEK or cost > PEEK_COST:
            break
    return head


def _used(log, rows):
    """Only the columns the log reads, carried on: a row of a wide hand-made sheet held every one of its 16,384 cells."""
    used = log.get("used")
    if not used:
        return rows
    keep = tuple(used)
    return ({k: r[k] for k in keep if k in r} for r in rows)  # rows of a table's role column looked at before it's taken for one


def _placeholder(v):
    """A role cell that says nothing ("-", "N/A", "nan", "null", "Unknown", "?"): no answer, as a blank is (round 5: one in a
    column of 1s and 0s made it words that no role is, and the log was folded, its loudest neighbour the best server)."""
    return _key(v) in ("", "na", "nan", "null", "nil", "unknown", "unk", "undefined", "nd")


def _roles_known(log, rows, cols, utc_offset, excel=None):
    """A table's role column, checked on its first ROLE_PEEK rows, by the kind of values in it: words, when one of them is a
    role DAStastic knows, however many it doesn't (a serving cell marked PRIMARY_SERVING beside three neighbours marked
    CONNECTION_UNKNOWN or "Listed": round 2's half rule read that as a scanner's, a neighbour its best server: review 11/10,
    round 3); numbers only, when every one is a role's (0, 1 or 2: a "Serving Cell" of PCIs holds 101 and 377 among its 1s
    and 2s). Else it isn't one (a "Connection Status" of Connected or Idle), and the log is read as a scanner's, as if it had
    none (round 2: every row was a neighbour, and the run drew no tile). Either way, only when something in it marks a serving
    cell or a leg (1 or 2): a "Connection Status" of Connected with one "None" or "No" kept, every row a neighbour (round 4).
    In a column of numbers, Android's CONNECTION_UNKNOWN (2147483647, Integer.MAX_VALUE) and -1 are roles not known, read as
    neighbours, not a reason to drop it: one of them beside a 1 folded the log, a neighbour its best server (round 4). A role
    column with values in it reads a blank as a neighbour (_role). Placeholders are no answer (_placeholder). When the peek
    can't tell (nothing in it but blanks, or roles with no 1 or 2 yet: a walk starting in a dead zone, a sheet sorted by its
    Role column), the log is pending (role_pending): every row is staged with its role as it came, and the whole column
    decides (_pending_roles): decided on the peek, such a column was folded and its louder neighbour made the best server, or
    a column blank throughout kept every neighbour a primary (round 5). -> (log, rows)"""
    col = log.get("role_col")
    if not col:
        return log, rows
    head = _peek(rows)
    vals = [v for v in (str(x.get(col) or "").strip() for x in head) if v and not _placeholder(v)]
    words = [v for v in vals if not re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?", v)]
    serving = any(_serving(v) in (1, 2) for v in vals)
    kind = (any(_serving(v) is not None for v in vals) if words
            else all(_serving(v) is not None or _dec(v) in UNKNOWN_ROLES for v in vals))
    roles = serving and kind
    if not vals or (kind and not serving):
        log["role_pending"] = True
    elif not roles:
        log = _table_log(cols, utc_offset, excel, roles=False)
        unknown = sorted({v for v in vals if _serving(v) is None})
        log["notes"].append(f"The {col} column holds no role DAStastic knows ({', '.join(unknown[:5])}): read as a scanner's log, "
                            "each second's strongest cell of each carrier its best server.")
    else:
        log["blank"] = 0
    return log, itertools.chain(head, rows)


class _MemStage:
    """_Stage's two calls for rows already in memory (read_log): back in time order, the file's own within a moment."""

    def __init__(self):
        self.rs = []

    def put(self, ts, r):
        self.rs.append((ts, len(self.rs), r))

    def rows(self):
        return (r for _ts, _n, r in sorted(self.rs, key=lambda x: (x[0], x[1])))


def _pending_roles(log, each, stage):
    """A pending role column (_roles_known) decided on the whole file: each row staged with its role as it came (a row with no
    time goes straight on: clean drops it), then a role column when some value is a serving cell or leg (1 or 2) and the kind
    rule holds over every value, the rows read back with their roles; else no role column, the rows folded as a scanner's,
    with a note. The fold made is log["_fold"] (its note)."""
    seen12 = words = known = bad = False
    for r in each:
        t = str(r.get("serving") or "").strip()
        if t and not _placeholder(t):
            k = _serving(t)
            seen12 = seen12 or k in (1, 2)
            known = known or k is not None
            if not re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?", t):
                words = True
            elif k is None and _dec(t) not in UNKNOWN_ROLES:
                bad = True
        ts = _num(r.get("ts"))
        if ts is None:
            r["serving"] = 0
            yield r
        else:
            stage.put(int(ts), r)
    log["role_pending"] = False
    if seen12 and (known if words else not bad):  # a phone app's log
        log["blank"] = 0
        for r in stage.rows():
            r["serving"] = _role(r.get("serving"), log)
            yield r
        return
    col = log.get("role_col")
    log["columns"].pop("serving", None)
    log["fold"], log["source"] = True, "scanner"
    log["notes"].append(f"The {col} column marks no serving cell or leg anywhere in the file: read as a scanner's log, each second's "
                        "strongest cell of each carrier its best server.")
    f = log["_fold"] = _Fold()
    for r in stage.rows():
        r["serving"] = None
        yield from f.add(r)
    yield from f.end()


DAY_WINDOW = 92    # days between two of a log's dates that still keeps them one stretch of it (_date_keep)
GPS_EPOCH_S = 315964800 - 18  # Unix seconds at the GPS epoch (1980-01-06), less the 18 leap seconds GPS time runs ahead since 2017
GPS_LEAPS = ((1483228800, 18), (1435708800, 17), (1341100800, 16), (1230768000, 15), (1136073600, 14), (915148800, 13))  # from 2017, 2015-07,


def _gps_unix_s(g):  # 2012-07, 2009, 2006, 1999: GPS time's lead over UTC then (round 7: today's 18 put 2012's data 3 s early)
    u = g + 315964800
    return u - next((n for since, n in GPS_LEAPS if u - n >= since), 13)
Y2000_MS = 946684800000


def _short(v):
    """Whether a number is a count of seconds by its fraction, float noise allowed for: whole ms or µs (6 decimals), .NET's
    100 ns ticks (7), thirds (a 3 Hz logger's k/3) or 1/1024 s ticks, where an Excel day carries its time of day as k / 86400
    (a whole second has 6 decimals once in 54, 7 once in 27; round 6: 100 ns, thirds and 1/1024 s were stored as 1998-2000)."""
    x = float(v)
    return any(abs(x - round(x * d) / d) < 1e-9 for d in (1e6, 1e7, 3, 1024))  # within 86 µs: a scaled tolerance made a third's
    # 28.8 s wide, so a drive across 08:00, 16:00 or midnight was "seconds" and imported with no times (review 11/10, round 7)


def _dates_known(log, rows):
    """A time column's numbers taken for Excel dates (the fallback for a workbook that can't say which cells are dates: an old
    .xls, an .xlsx with no styles) unless, in its first rows (_peek), they are a counter: mostly numbers with 6 decimals or
    fewer once float noise is rounded away (seconds of the day, with ms or µs, or a 10 Hz walk's 39600.299999999996), where a
    real day number carries the time of day in a dozen. Seconds of the day from 09:07:54 to 20:17:30, hhmmss numbers and GPS
    seconds of the week fall in Excel's 1990-2100 range one value at a time, so a 2-minute log of seconds 54000-54119 was
    stored as 120 days, 2047-11-04 to 2048-03-02 (review 11/10, round 3), and seconds with µs or float noise as 1998-2008
    dates (rounds 4 and 5). A counter: the numbers stay as they are, so the rows are "no time" as before 202e07c, and the
    import says why. Dates: each value is a date when it is from 1990 to tomorrow (_log_time), and once the whole log is in,
    only its main stretch of dates is kept (_date_keep): judged on the first rows' extremes (round 4: one stray at 1980 made
    a 40-second log import nothing) or their spread and median (round 5: a pre-GPS-lock burst of more than 5% did the same,
    a burst of more than half kept the strays and dropped every real row, and a workbook running past 92 days lost the rest)."""
    col = log.get("time_col")
    if not log.get("excel") or not col:
        return log, rows
    head = _peek(rows)
    texts = [v for v in (str(x.get(col) or "").strip() for x in head) if re.fullmatch(r"\d{5}(?:\.\d+)?", v)]
    distinct = set(texts)
    if len(distinct) > 1 and 2 * sum(_short(v) for v in distinct) > len(distinct):
        log["excel"] = None
        log["notes"].append(f"The {col} column holds numbers that aren't Excel's dates ({texts[0]} to {max(texts, key=float)}): "
                            "kept as they are, so a row with no other time is \"no time\".")
    return log, itertools.chain(head, rows)


def _log_time(log, v):
    """A row's time value, judged before parse_time reads it:
    - a 9-13 digit number is Unix seconds or ms, kept only from 2000 to tomorrow: a GPS time of week in ms (226818000) was
      read as 1977 (round 5); in a column whose name says GPS, seconds since the GPS epoch (1478358018) read as GPS time when
      that is within the last 400 days and as Unix time they would be ten years back (they were stored in 2016);
    - with its workbook's date fallback, a 5-digit number is an Excel date when it is from 1990 to tomorrow, counted by day
      for _date_keep.
    Anything refused is None ("no time"), counted for the import's notes."""
    if v is None or isinstance(v, bool):
        return v
    t = v if isinstance(v, (int, float)) else str(v).strip()
    m = re.fullmatch(r"(\d{9,13})(\.\d+)?", t) if isinstance(t, str) else None
    if m or (isinstance(t, (int, float)) and 1e8 <= t < 1e13):
        n = float(t)
        now = time.time() * 1000
        if log.get("gps"):  # seconds or ms since the GPS epoch, when that lands from 2000 to tomorrow: Unix time in such a column
            g = (_gps_unix_s(n / 1000) if n >= 1e11 else _gps_unix_s(n)) * 1000  # lands ten years on, past tomorrow (round 6:
            if Y2000_MS <= g <= now + 86400000:  # GPS seconds older than 400 days, and GPS ms, were stored ten years early)
                log["gps_read"] = log.get("gps_read", 0) + 1
                return int(round(g))
        ms = n if n > 1e12 else n * 1000
        if Y2000_MS <= ms <= now + 86400000:
            return v
        log["off_epoch"] = log.get("off_epoch", 0) + 1
        return None
    ex = log.get("excel")
    if not ex or not isinstance(t, str) or not re.fullmatch(r"\d{5}(?:\.\d+)?", t):
        return v
    x = float(t) + (1462 if ex == 1904 else 0)
    if EXCEL_DAYS[1] <= x <= time.time() / 86400 + EXCEL_DAYS[0] + 1:
        days = log.setdefault("days", {})
        days[int(x)] = days.get(int(x), 0) + 1
        log["_xs"] = int(_short(t))  # the row's: counted for _date_keep once clean() and keep_mi have kept it (round 7)
        return _excel_time(t, ex)
    log["off_dates"] = log.get("off_dates", 0) + 1
    return None


LTE_START_MS = 1259539200000  # 2009-11-30: before the first LTE network (Telia, 2009-12-14) no survey reading was taken


def _date_keep(log, days, spans=None):
    """Which of a log's Excel-dated readings to keep, once every row is in: days, {Unix day: readings} of what clean() and the
    keep_mi trim kept (round 6: counted from raw rows, 3,000 pre-lock rows with no position outweighed the 1,000 real ones,
    and the real drive was deleted). -> ([from, to) Unix ms ranges to keep], or None for all, or [] for none.
    - None of them: most dates kept looked like a count of seconds (_short over the whole file's kept rows, log["kept_dates"]
      and ["kept_short"]: the first rows, judged by _dates_known, can hold one value, or no time at all; counted over raw rows,
      3,000 pre-lock rows frozen at 2000-01-01 made the real drive a counter: round 7).
    - Their days in chains, a chain broken by a gap of more than DAY_WINDOW days; the largest kept, and every other from
      2009-12 on that holds 500 readings or a tenth of them, or spans 5 minutes or more (a baseline drive 93 days before the
      acceptance one: round 6 kept only the largest; a 400-reading walk: round 7). A clock's burst before its GPS lock
      (2000-01-01) or a handful of stray readings are let go. spans: {Unix day: (first ms, last ms)}."""
    if not log.get("days"):
        return None
    if 2 * log.get("kept_short", 0) > log.get("kept_dates", 0):
        return []
    days = sorted(days.items())
    if not days:
        return None
    chains, cur = [], [days[0]]
    for d in days[1:]:
        if d[0] - cur[-1][0] > DAY_WINDOW:
            chains.append(cur)
            cur = []
        cur.append(d)
    chains.append(cur)
    total = sum(n for _d, n in days)
    size = lambda c: sum(n for _d, n in c)  # noqa: E731
    best = max(chains, key=lambda c: (size(c), c[0][0]))
    spans = spans or {}
    span = lambda c: max((spans.get(d, (0, 0))[1] for d, _n in c), default=0) - min((spans.get(d, (0, 0))[0] for d, _n in c), default=0)  # noqa: E731
    keep = [c for c in chains if c is best or ((c[-1][0] + 1) * 86400000 > LTE_START_MS and (size(c) >= 500 or 10 * size(c) >= total or span(c) >= 300000))]
    if len(keep) == len(chains):
        return None
    return [(c[0][0] * 86400000, (c[-1][0] + 1) * 86400000) for c in keep]


def _counter_note(log):
    return (f"The {log.get('time_col')} column holds numbers that aren't Excel's dates (counts of seconds, as most of them read): "
            "kept as they are, so a row with no other time is \"no time\".")

class _Fold:
    """A scanner's timed rows, given in time order (import_file sets them aside on disk and reads them back in order: _Stage;
    read_log sorts them) -> one reading per cell per second: each cell's rows in one second become one reading (the median of
    each value; the position of the middle row), a cell being its technology, network, band, channel (or MHz), PCI and cell ID
    (11/10: with no channel column, PCI 101 on B12, B66 and B2 was folded into one "band 66" reading at the middle value).
    Each second is judged once, with every row it has, whatever order the file held them in: each carrier and technology's
    strongest cell in it is its best server (serving 1), the strongest on each of its other channels a leg (2), as a phone's
    carrier-aggregation and NSA legs are, and every other cell a neighbour (0): one best server across all of a carrier's
    bands left its C-band and CBRS layers no serving reading at all, so the tiles never showed them (review 11/10). Folded
    as rows arrived, a file sorted newest first, by PCI, or with one row stamped a year ahead held every row in memory (18
    times the file), and a second's late rows were judged on their own, giving one carrier two best servers in it (review
    11/10, round 2). A row with no time never comes here: clean counts each one it drops."""

    def __init__(self):
        self.s, self.cells, self.folded = None, {}, 0

    @staticmethod
    def _net(r):
        return tech_of(r.get("tech")), plmn_of(r) or carrier_of(str(r.get("carrier") or "")[:80] or None, None) or ""

    @staticmethod
    def _chan(r):
        """The carrier frequency a cell is on: its channel, else its MHz, else its band (none of the three: one for the carrier)."""
        c, mhz, b = str(r.get("chan") or "").strip(), _dec(r.get("mhz")), band_name(tech_of(r.get("tech")), r.get("band"))
        return c or (f"{mhz:g} MHz" if mhz else "") or (f"band {b}" if b else "")

    def _cell(self, r):
        return (*self._net(r), self._chan(r), str(r.get("pci") or "").strip(), str(r.get("cid") or "").strip())

    def add(self, r):
        """A row (in time order): the second before it is judged once this one starts another."""
        s = int(_num(r["ts"]) // 1000)
        if s != self.s:
            yield from self.end()
            self.s = s
        self.cells.setdefault(self._cell(r), []).append(r)

    def end(self):
        if self.cells:
            yield from self._second(self.s, self.cells)
        self.cells = {}

    def _second(self, s, cells):
        import statistics
        out = []
        for g in cells.values():
            r = dict(g[(len(g) - 1) // 2])
            r["ts"] = s * 1000  # every reading of the second: one moment, as a phone's snapshot is (a cell measured once kept
            # its own ms, so a second's primary and three legs counted four moments and its tile was never faint: round 3)
            if len(g) > 1:
                self.folded += len(g) - 1
                for k in ("rsrp", "rsrq", "sinr"):
                    v = [x for x in (_dec(y.get(k)) for y in g) if x is not None]
                    r[k] = statistics.median(v) if v else None
            out.append(r)
        best, legs = {}, {}
        for i, r in enumerate(out):
            v = _dec(r.get("rsrp"))
            if v is None:
                continue
            net = self._net(r)
            ch = (*net, self._chan(r))
            if net not in best or v > best[net][0]:
                best[net] = (v, i)
            if ch not in legs or v > legs[ch][0]:
                legs[ch] = (v, i)
        tops = {i for _, i in best.values()}
        on = {i for _, i in legs.values()} - tops  # a carrier's best server is its own channel's strongest too
        for i, r in enumerate(out):
            r["serving"] = 1 if i in tops else 2 if i in on else 0
        return out

    def note(self):
        return ("Read as a scanner's log: in each second the strongest cell of each carrier and technology is its best server, the strongest on each of "
                "the carrier's other channels a leg (as a phone's carrier-aggregation legs), every other cell a neighbour."
                + (f" {self.folded:,} rows of a cell in a second it was already measured in were folded into that second's median." if self.folded else ""))


STAGE_PREFIX = ".survey-import-"  # an import's scratch file beside the database while a folded log is read; deleted when it ends


def _work_dir(con):
    """Where an import keeps its scratch files: beside the main database (the data folder, on disk: a licensed copy's /tmp
    may be memory, counted against its 1,200 MB), else the temp folder (a database in memory, as the tests have)."""
    try:
        for _n, name, path in con.execute("PRAGMA database_list").fetchall():
            if name == "main" and path:
                return os.path.dirname(os.path.abspath(path))
    except sqlite3.Error:
        pass
    import tempfile
    return tempfile.gettempdir()


class _Stage:
    """A folded log's timed rows set aside in a scratch database (STAGE_PREFIX, in _work_dir) as they arrive, then given back
    in time order (the file's own order within one moment), so _Fold sees each second whole and holds one second at a time
    whatever order the file is in. The scratch database keeps a few MB of pages in memory; the rest is on disk. It holds an
    exclusive lock from its first write to close (locking_mode EXCLUSIVE), which the OS lets go when the process dies, so
    sweep can tell a live import's file from one a stopped copy left at any age (review 11/10, round 3: a day-old rule kept a
    killed import's file through the restart that followed, up to a day, with every timed row's position in it).
    Rows are sorted in runs of RUN, each run appended in order, and the runs merged on the way out: inserted one by one into a
    table keyed on (ts, seq), a file out of time order (sorted by PCI in Excel, several channels' exports joined) put each row
    on a page anywhere in the tree, past the few MB cached, so 255 MB of PCI-sorted export wrote 9.4 GB and read 10.1 GB
    (round 3). Now each row is written once and read once, in order.
    A run is RUN rows or RUN_CHARS of staged text, whichever comes first, and a staged text value is cut at MAX_STAGED
    characters (a log's carrier, band or technology is a few): counted in rows only, a hand-made 47 KB workbook whose 7,999
    rows point at one 32,767-character shared string held 1.5 GB before its first run went to disk, every character of it
    also written as a 6-character \\u escape (review 11/10, round 4)."""
    RUN = 4 * BATCH        # rows sorted in memory at a time: a few MB of a real log's rows
    RUN_CHARS = 4 * MB     # and at most this much staged text
    MAX_STAGED = 200       # characters of one staged text value

    def __init__(self, folder):
        import tempfile
        fd, self.path = tempfile.mkstemp(prefix=STAGE_PREFIX, suffix=".db", dir=folder)
        os.close(fd)
        self.db = sqlite3.connect(self.path, isolation_level=None)
        self.db.executescript("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096;"
                              "CREATE TABLE r(ts INTEGER NOT NULL, seq INTEGER NOT NULL, d TEXT NOT NULL);"
                              "BEGIN;")
        self.keys, self.buf, self.n, self.runs, self.chars = None, [], 0, [], 0

    def put(self, ts, r):
        if self.keys is None:
            self.keys = list(r)  # a log's rows all have its row()'s keys
        cap = self.MAX_STAGED
        vals = [_text(v[:cap]) if isinstance(v, str) else v for v in (r.get(k) for k in self.keys)]
        d = json.dumps(vals, separators=(",", ":"), ensure_ascii=False)
        self.buf.append((ts, self.n, d))
        self.n += 1
        self.chars += len(d)
        if len(self.buf) >= self.RUN or self.chars >= self.RUN_CHARS:
            self._write()

    def _write(self):
        """a run: sorted by (ts, seq), appended (a fresh rowid table's rowids count up from 1, so a run is a rowid range)"""
        if not self.buf:
            return
        self.buf.sort(key=lambda x: (x[0], x[1]))
        first = self.runs[-1][1] + 1 if self.runs else 1
        self.db.executemany("INSERT INTO r VALUES(?,?,?)", self.buf)
        self.runs.append((first, first + len(self.buf) - 1))
        self.buf, self.chars = [], 0

    def rows(self):
        import heapq
        self._write()
        self.db.execute("COMMIT")
        runs = [self.db.execute("SELECT ts, seq, d FROM r WHERE rowid BETWEEN ? AND ? ORDER BY rowid", run) for run in self.runs]
        for _ts, _seq, d in heapq.merge(*runs, key=lambda x: (x[0], x[1])):
            yield dict(zip(self.keys, json.loads(d)))

    def close(self):
        """The scratch file goes. On Windows a delete fails while any other handle is open, and another import's sweep opens a
        live file for a moment (_stage_left: up to 100 ms of SQLite's lock retries), so the delete is tried again for a second
        before the next sweep is left to take it (review 11/10, round 4)."""
        try:
            self.db.close()
        finally:
            for wait in (0.02, 0.05, 0.1, 0.2, 0.3, 0.4, None):
                try:
                    os.remove(self.path)
                    break
                except FileNotFoundError:
                    break
                except PermissionError:
                    if wait is None:
                        break
                    time.sleep(wait)
                except OSError:
                    break


def _in_time_order(rows, fold, stage):
    """A folded log's rows -> its readings: a row with no time goes straight on (clean counts each one it drops), the rest
    through stage and back in time order, then fold."""
    for r in rows:
        ts = _num(r.get("ts"))
        if ts is None:
            yield r
        else:
            stage.put(int(ts), r)
    for r in stage.rows():
        yield from fold.add(r)
    yield from fold.end()


def read_log(name, raw, utc_offset=None):
    """A survey log read, not saved (whole, in memory: for a look at a small file): {source, rows (readings for clean), notes,
    columns, format}. import_file reads a file in pieces instead."""
    import das
    if not raw:
        raise ValueError("No file came.")
    fmt, head, rows = das.read_table(name or "survey.csv", raw)
    excel = _date_system(fmt, raw)  # das.read_table keeps no cell's format
    log = _log_of(head, utc_offset, excel)
    log, rows = _roles_known(log, _used(log, iter(rows)), head, utc_offset, excel)
    log, rows = _dates_known(log, rows)
    pending = log.get("role_pending")
    out = [log["row"](r) for r in rows]
    f = _Fold() if log.get("fold") and not pending else None
    if pending:
        out = list(_pending_roles(log, iter(out), _MemStage()))
        f = log.get("_fold")
    elif f:  # in time order, each second whole (the file's own order within one moment: sorted is stable)
        timed = sorted((x for x in out if _num(x.get("ts")) is not None), key=lambda x: _num(x["ts"]))
        out = [x for x in out if _num(x.get("ts")) is None] + [y for x in timed for y in f.add(x)] + list(f.end())
    if log.get("days"):  # the Excel dates kept (_date_keep), judged on the rows clean() takes
        days, spans = {}, {}
        for x in out:
            row, why = clean(x)
            if row is not None:
                d = row["ts"] // 86400000
                days[d] = days.get(d, 0) + 1
                lo, hi = spans.get(d, (row["ts"], row["ts"]))
                spans[d] = (min(lo, row["ts"]), max(hi, row["ts"]))
                if x.get("xshort") is not None:
                    log["kept_dates"] = log.get("kept_dates", 0) + 1
                    log["kept_short"] = log.get("kept_short", 0) + x["xshort"]
        keep = _date_keep(log, days, spans)
        if keep is not None:
            n = len(out)
            out = [x for x in out if _num(x.get("ts")) is None or any(lo <= _num(x["ts"]) < hi for lo, hi in keep)]
            if keep:
                log["off_dates"] = log.get("off_dates", 0) + n - len(out)
            else:
                log["notes"].append(_counter_note(log))
    return {"source": log["source"], "rows": out, "notes": _end_notes(log, f, utc_offset), "columns": log["columns"], "format": fmt}


def _date_system(fmt, raw):
    """Which day Excel counts a workbook's dates from, for one read whole (das.read_table keeps no cell's format, so its time
    column's numbers are read as dates: _excel_time): an old .xls's DATEMODE record, an .xlsx's date1904; None for a file
    that isn't a workbook. Every .xls was read as 1900, so an old Mac one's times came out 1,462 days early (round 3)."""
    if fmt == "xls":
        import xlsread
        return xlsread.datemode(raw)
    if fmt == "xlsx":
        import zipfile
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                wb = z.read("xl/workbook.xml")[:1 << 20]
        except (KeyError, zipfile.BadZipFile, OSError, ValueError):
            wb = b""
        return 1904 if re.search(rb"date1904\s*=\s*[\"'](?:1|true)[\"']", wb) else 1900
    return None


def _local_note(n, utc_offset):
    if not n:
        return []
    return [f"{n:,} times carried no time zone: read as the phone's local time at UTC{utc_offset / 60:+g} h." if utc_offset is not None
            else f"{n:,} times carried no time zone and no UTC offset was given: read as UTC."]


# ---------------------------------------------------------------- an import

def _scope_row(con, scope, sid):
    """What tells the mission or job an import goes into from one that later takes its id (a deleted newest mission's id is
    the next one's): its created_at, or None when it isn't there. Scratch is always there."""
    if scope == "scratch":
        return ("scratch",)
    t = "das_job" if scope == "job" else "mission"
    try:
        r = con.execute(f"SELECT created_at FROM {t} WHERE id=?", (sid,)).fetchone()
    except sqlite3.OperationalError:  # a table with no created_at: being there is all there is to check
        r = con.execute(f"SELECT 1 FROM {t} WHERE id=?", (sid,)).fetchone()
    return None if r is None else tuple(r)


def _scope_there(con, scope, sid, was):
    """The mission or job an import goes into is still the one it started in (one deleted while its file came in, or deleted
    and its id taken by a new one, takes nothing back)."""
    if _scope_row(con, scope, sid) != was:
        raise LookupError(f"{'Job' if scope == 'job' else 'Mission'} {sid} was deleted while the file came in: nothing was kept.")


def _discard(con, rid):
    """An import's hidden run and its readings, when the import doesn't finish."""
    try:
        con.rollback()
        con.execute("DELETE FROM survey_reading WHERE run_id=?", (rid,))
        con.execute("DELETE FROM survey_run WHERE id=?", (rid,))
        con.commit()
    except sqlite3.Error:
        pass  # the database is busy or gone: the next import, start or backup sweeps it (sweep)


def sweep(con):
    """Runs an import left hidden when the copy stopped mid-file, and its scratch file (STALE_S old: an import that's still
    coming in is younger), and readings whose run is gone. Each import, the app's start and each my-work backup ask (app.py)."""
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - STALE_S))
    try:
        stale = con.execute("SELECT id FROM survey_run WHERE (scope=? OR scope LIKE ?) AND created_at<?", (HIDDEN, HIDDEN + ":%", old)).fetchall()
    except sqlite3.OperationalError:  # no survey tables in this copy yet
        return
    for (rid,) in stale:
        _discard(con, rid)
    _orphans(con)
    folder = _work_dir(con)  # and a scratch file (_Stage) a stopped import left beside the database: hundreds of MB, kept for good
    try:
        names = [f for f in os.listdir(folder) if f.startswith(STAGE_PREFIX) and f.endswith(".db")]
    except OSError:
        return
    for f in names:
        p = os.path.join(folder, f)
        try:
            if _stage_left(p) or time.time() - os.path.getmtime(p) > STALE_S:
                os.remove(p)
        except OSError:
            pass  # held open (another process's import) or gone: the next sweep


def _stage_left(path):
    """Whether a scratch file is one no import holds: a live _Stage keeps its exclusive lock to the end, so the lock comes
    only when its process has gone (or between its creating the file and its first write, a moment in which Windows refuses
    the delete and Linux's leaves the open file working)."""
    try:
        c = sqlite3.connect(path, timeout=0, isolation_level=None)
    except sqlite3.Error:
        return False
    try:
        c.execute("BEGIN EXCLUSIVE")
        c.execute("ROLLBACK")
        return True
    except sqlite3.Error:
        return False
    finally:
        c.close()


def _orphans(con):
    """Readings whose run is gone: an import a job's delete overtook, cut short by a stopped copy before it noticed, or a
    _discard the busy database refused. Nothing deleted, showed or backed them up by run, so a deleted job's track stayed in
    uls.db for good (review 11/10, round 3). A run is always committed before its readings (create: together; an import:
    first) and an id is never used again, so readings with no run are leftovers. One index step per run, not a scan."""
    try:
        rid, gone = -1, 0
        while True:
            nxt = con.execute("SELECT MIN(run_id) FROM survey_reading WHERE run_id>?", (rid,)).fetchone()[0]
            if nxt is None:
                break
            rid = nxt
            if not con.execute("SELECT 1 FROM survey_run WHERE id=?", (rid,)).fetchone():
                gone += con.execute("DELETE FROM survey_reading WHERE run_id=?", (rid,)).rowcount
        con.commit()
        return gone
    except sqlite3.Error:
        return 0  # busy or gone: the next sweep


def import_file(con, scope, scope_id, name, raw, who="", utc_offset=None, keep_mi=None, at=None, calibrated=False, size=None, gate=None):
    """A log file -> a new run with every row of it (no row cap). raw: the file's bytes, or a stream of size bytes (the request
    body), read in pieces as it arrives and stored BATCH readings at a time: the whole file in memory took 25 times its size,
    and a 58 MB scanner export stopped a 1,200 MB licensed copy (review 11/10). A scanner's rows, folded a second at a time,
    are set aside on disk first and read back in time order (_Stage), so a file in any order is held a second at a time too
    (round 2). A file over MAX_IMPORT is refused before it's read (TooBig); so is an old Excel (.xls), JSON, KML or GPX log
    over MAX_WHOLE, which can only be read whole, and a KMZ whose KML is over it unpacked. An .xlsx is copied to a scratch
    file and read a row at a time (_xlsx_rows): read whole, it took 175 times the file (round 2).
    The run is hidden (_hidden) until its last row is in. Then, in one write transaction: the mission or job must still be
    there, gate() (the caller's access) is asked again, and a file already in this scope is refused (Duplicate), so two
    imports of one file racing each other, or a mission deleted while its file came in, leave nothing behind."""
    scope, sid = scope_of(scope, scope_id)
    was = _scope_row(con, scope, sid)
    if was is None:
        raise LookupError(f"{'Job' if scope == 'job' else 'Mission'} {sid} was deleted. Reload to see the current ones.")
    keep = _keep(con, scope, sid, keep_mi, at)
    if raw is None or isinstance(raw, (bytes, bytearray, memoryview)):
        size, raw = len(raw or b""), io.BytesIO(bytes(raw or b""))
    if not size:
        raise ValueError("No file came.")
    if size > MAX_IMPORT:
        raise too_big(size)
    body = _Upload(raw, size)
    buf = io.BufferedReader(body, 1 << 16)
    head = buf.peek(1 << 16)
    if SAMPLE_MARK in head[:8192]:  # the sample saved from the map and imported back was kept as a real scanner run (review 11/12)
        raise ValueError("This is DAStastic's made-up sample survey (its file says \u201cSAMPLE: made-up data\u201d): it isn't imported as real readings. "
                         "Load the sample from the \u25a6 Survey menu instead.")
    with contextlib.ExitStack() as hold:  # the scratch copy of a workbook goes when the import ends, kept or refused
        kind, excel = _kind(name, head), None
        if kind == "xlsx":  # from a scratch copy beside the database (a zip is read from its end), a row at a time
            import shutil
            import tempfile
            spool = hold.enter_context(tempfile.TemporaryFile(prefix=STAGE_PREFIX, dir=_work_dir(con)))
            shutil.copyfileobj(buf, spool, 1 << 20)
            fmt, (cols, rows, excel) = "xlsx", _xlsx_rows(spool)
        elif kind == "text":
            fmt, cols, rows = _text_rows(buf, head)
        else:
            if size > MAX_WHOLE:
                raise too_big(size, whole=True)
            import das
            data = buf.read()
            if kind == "kmz":
                _kmz_check(data)
            fmt, cols, rows = das.read_table("survey.kmz" if kind == "kmz" else name or "survey.csv", data)
            rows, excel, data = iter(rows), (_date_system(fmt, data) if fmt == "xls" else None), None  # das.read_table keeps no cell's format
        log = _log_of(cols, utc_offset, excel)
        log, rows = _roles_known(log, _used(log, rows), cols, utc_offset, excel)
        log, rows = _dates_known(log, rows)
        fold, stage = (_Fold() if log.get("fold") else None), None

        def readings():
            each = (log["row"](x) for x in rows)
            if log.get("role_pending"):
                return _pending_roles(log, each, stage)
            return _in_time_order(each, fold, stage) if fold else each

        sweep(con)
        base = os.path.basename(str(name or "")).strip() or "Imported survey"
        rid = con.execute("INSERT INTO survey_run(scope, scope_id, name, source, device, calibrated, created_by, created_at, keep_mi, keep_lat, keep_lon)"
                          " VALUES(?,?,?,?,?,?,?,?,?,?,?)", (_hidden(scope), sid, base[:MAX_NAME], log["source"], "", 1 if calibrated and log["source"] not in PHONES else 0,
                                                             who or "", _now(), *keep)).lastrowid
        con.commit()
        try:
            if fold or log.get("role_pending"):  # a scanner's rows, or a pending role column's, set aside and read back in time order (_Stage)
                stage = _Stage(_work_dir(con))
            lim, centre = (keep[0] * MI_M, keep[1:]) if keep[0] else (None, None)
            kept = added = trimmed = 0
            dropped, batch = {}, []
            for r in readings():
                row, why = clean(r)
                if why:
                    dropped[why] = dropped.get(why, 0) + 1
                    continue
                if lim is not None and _metres(centre[0], centre[1], row["lat"], row["lon"]) > lim:
                    trimmed += 1
                    continue
                if r.get("xshort") is not None:  # an Excel date kept: whether it looked like a count of seconds (_date_keep)
                    log["kept_dates"] = log.get("kept_dates", 0) + 1
                    log["kept_short"] = log.get("kept_short", 0) + r["xshort"]
                batch.append(row)
                if len(batch) >= BATCH:
                    added, kept, batch = added + _insert(con, rid, batch), kept + len(batch), []
                    con.commit()
                    if not con.execute("SELECT 1 FROM survey_run WHERE id=?", (rid,)).fetchone():  # its job or mission deleted
                        # (drop_scope takes the hidden run): stop now, not at the end, so a copy stopped meanwhile leaves no
                        # batch with no run behind (review 11/10, round 3)
                        raise LookupError(f"{'Job' if scope == 'job' else 'Mission' if scope == 'mission' else 'The survey'}"
                                          f"{f' {sid}' if scope != 'scratch' else ''} was deleted while the file came in: nothing was kept.")
            if batch:
                added, kept = added + _insert(con, rid, batch), kept + len(batch)
                con.commit()
            keep = None
            if log.get("days"):
                per = con.execute("SELECT ts / 86400000, COUNT(*), MIN(ts), MAX(ts) FROM survey_reading WHERE run_id=? GROUP BY 1", (rid,)).fetchall()
                keep = _date_keep(log, {d: n for d, n, _a, _b in per}, {d: (a, b) for d, _n, a, b in per})
            if keep is not None:  # the log's stretches of Excel dates (_date_keep): a stray chain's readings go, as their rows' "no time"
                inside = " OR ".join("(ts>=? AND ts<?)" for _k in keep) or "0"
                off = con.execute(f"DELETE FROM survey_reading WHERE run_id=? AND NOT ({inside})", (rid, *[x for k in keep for x in k])).rowcount
                con.commit()
                added, kept = added - off, kept - off
                if keep:
                    log["off_dates"] = log.get("off_dates", 0) + off
                else:
                    log["notes"].append(_counter_note(log))
                if off:
                    dropped["no time"] = dropped.get("no time", 0) + off
            body.rest()  # what follows the table (blank lines): the file's hash is the whole file's
            if not kept or not added:  # nothing stored: rows the unique key ignored as duplicates are none (round 7: an empty
                # run was committed with the file's hash, and the file could never be imported again)
                why = "; ".join(f"{n:,} {w}" for w, n in sorted(dropped.items(), key=lambda x: -x[1])) or "no rows"
                raise ValueError(f"Nothing in this file can go on the map ({why}{f'; {trimmed:,} beyond {keep_mi} mi of the site' if trimmed else ''}).")
            h = body.sha.hexdigest()
            con.execute("BEGIN IMMEDIATE")
            _scope_there(con, scope, sid, was)
            if gate:
                gate()
            old = con.execute("SELECT id, name FROM survey_run WHERE scope=? AND scope_id=? AND src_hash=?", (scope, sid, h)).fetchone()
            if old:
                raise Duplicate(dict(old))
            con.execute("UPDATE survey_run SET scope=?, src_hash=?, source=?, calibrated=?, ended_at=(SELECT MAX(ts) FROM survey_reading WHERE run_id=?) WHERE id=?",
                        (scope, h, log["source"], 1 if calibrated and log["source"] not in PHONES else 0, rid, rid))  # a pending role column decides late
            _restat(con, rid)
            evidence(con, rid)
            con.commit()
        except BaseException:
            _discard(con, rid)
            raise
        finally:
            if stage:
                stage.close()
        return {**run_info(con, scope, sid, rid), "added": added, "duplicates": kept - added, "dropped": dropped, "trimmed": trimmed,
                "notes": _end_notes(log, fold or log.get("_fold"), utc_offset), "columns": log["columns"], "format": fmt}
