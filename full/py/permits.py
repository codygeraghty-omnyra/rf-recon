"""
Building permits and certificates of occupancy (Cody 11/4: "It finds buildings likely to fail before anyone else knows. The
next step is permit and certificate-of-occupancy data"). A new building has to show radio coverage before it is occupied
(IFC 510.1 and 510.5.4; Virginia USBC 918; Montgomery County MD ER 13-24), and some AHJs pull an existing building in on an
addition, a big alteration or a change of occupancy (static/research/permit_sources.json, erces_triggers). Those permits
name the job before the walls close.

  registry   static/research/permit_sources.json: every open city / county dataset found, its API, its field names, its
             terms (read on the provider's own page) and whether it is on by default (only when the terms are clearly open).
  refresh    each enabled dataset pulled incrementally: only rows dated since the last pull (less a few days, so a status
             change shows), paged, one request a second; Socrata (SODA), ArcGIS FeatureServer / MapServer, OData
             (Arlington) and CSV files. Only the mapped columns are asked for, so the columns that name people (owners,
             applicants: personal_fields in the registry) are never fetched or stored.
  classify   plain word rules, the words that decided each kind kept with the row: new_building, addition,
             major_alteration, co_issued, other (houses, sheds, decks and small alterations).
  attach     the permits near a set of DAS prospects, each matched to one building by address or distance, the best one
             as that building's trigger; new buildings with no prospect row yet (no Overture footprint while it's built)
             come back as their own rows, kind under_construction.

Own sqlite file (permits.db in the data folder, WAL) so a pull never locks the other data. Standard library only.
"""
import csv
import io
import json
import math
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "static", "research", "permit_sources.json")
UA = "RF-Recon/2.0 (DAS prospects: building permits)"
KINDS = ("new_building", "addition", "major_alteration", "co_issued", "other")
KIND_LABEL = {"new_building": "New building", "addition": "Addition", "major_alteration": "Major alteration",
              "co_issued": "Certificate of occupancy", "other": "Other permit"}
LOOKBACK_DAYS = 730          # a first pull goes back two years: a building permitted then may still be going up
OVERLAP_DAYS = 3             # each later pull starts this far before the last date seen, so status changes are caught
KEEP_DAYS = 3 * 365          # rows with nothing newer than this are dropped
PAGE = 1000
MAX_PAGES = 100              # per dataset per run (100,000 rows); the next run carries on from the cursor
PAUSE_S = 1.0                # between requests to one provider
MAJOR_USD = 250000           # a working line for "major" (not a code threshold; see why_major)
MAJOR_SQFT = 10000
WHY_MAJOR = ("RF Recon counts an alteration as major at $250,000 or 10,000 sq ft of work, or a change of occupancy: a working "
             "line, not a code threshold. The codes read name none: IFC 510.6.1 retests after any addition or remodel that could "
             "change the original test; Florida's Level III alteration (work area over 50% of the building, FBC-EB 604.1) is "
             "the only percentage found (permit_sources.json).")

SCHEMA = """
CREATE TABLE IF NOT EXISTS permit(source TEXT, permit_id TEXT, kind TEXT, why TEXT, erces INTEGER, desc TEXT, status TEXT,
    filed TEXT, issued TEXT, final TEXT, co_date TEXT, address TEXT, city TEXT, lat REAL, lon REAL, value_usd REAL, sqft REAL,
    bldg_sqft REAL, floors REAL, units REAL, use_group TEXT, url TEXT, seen TEXT, PRIMARY KEY(source, permit_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS permit_ll ON permit(lat, lon);
CREATE INDEX IF NOT EXISTS permit_kind ON permit(kind);
CREATE TABLE IF NOT EXISTS pull(source TEXT PRIMARY KEY, cursor TEXT, last_run TEXT, rows INTEGER, error TEXT);
"""
COLS = ("source", "permit_id", "kind", "why", "erces", "desc", "status", "filed", "issued", "final", "co_date", "address",
        "city", "lat", "lon", "value_usd", "sqft", "bldg_sqft", "floors", "units", "use_group", "url", "seen")


def db_path(data_dir):
    """permits.db in the data folder, or in RF_RECON_PERMITS when set (a test copy that reads a shared data folder)."""
    return os.path.join(os.environ.get("RF_RECON_PERMITS") or data_dir, "permits.db")


def connect(data_dir):
    os.makedirs(os.path.dirname(db_path(data_dir)), exist_ok=True)
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    return con


_REG = {}


def registry(path=REGISTRY):
    """The registry (cached by file time)."""
    try:
        mt = os.path.getmtime(path)
    except OSError:
        return {"sources": [], "erces_triggers": []}
    if _REG.get("path") != path or _REG.get("mt") != mt:
        with open(path, encoding="utf-8") as fh:
            _REG.update(path=path, mt=mt, data=json.load(fh))
    return _REG["data"]


def sources(path=REGISTRY):
    return {s["id"]: s for s in registry(path).get("sources", [])}


def enabled(settings, states=None, path=REGISTRY):
    """The dataset ids to pull: each one's own switch (settings {id: bool}) or its registry default (on only when its terms
    are clearly open), limited to the states set in Data & updates (blank: all)."""
    settings = settings or {}
    st = {s.strip().upper() for s in (states or []) if s.strip()}
    out = []
    for sid, s in sources(path).items():
        on = settings.get(sid, s.get("enabled_default", bool(s.get("open"))))
        if on and (not st or (s.get("state") or "").upper() in st):
            out.append(sid)
    return out


# --- fetching -------------------------------------------------------------------------------------------------------

class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise urllib.error.HTTPError(newurl, code, "redirect away from https refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnly)


def http_get(url, timeout=90):
    """Bytes at url (https only), three tries with a growing wait on 429 / 5xx / network errors."""
    if not url.lower().startswith("https://"):
        raise ValueError(f"https only: {url[:80]}")
    last = None
    for k in range(3):
        try:
            with _OPENER.open(urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/csv, */*"}),
                              timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504):
                body = ""
                try:
                    body = e.read()[:300].decode("utf-8", "replace")
                except Exception:
                    pass
                raise RuntimeError(f"HTTP {e.code} from {urllib.parse.urlsplit(url).netloc}: {body}") from None
            last = e
        except OSError as e:
            last = e
        time.sleep(5 * (k + 1))
    raise RuntimeError(f"{urllib.parse.urlsplit(url).netloc}: {last}")


def _json(fetch, url):
    got = fetch(url)
    return json.loads(got.decode("utf-8-sig") if isinstance(got, (bytes, bytearray)) else got)


# --- values -----------------------------------------------------------------------------------------------------------

def _num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = re.sub(r"[$,\s]", "", str(v))
    m = re.match(r"^-?\d+(\.\d+)?$", s)
    return float(s) if m else None


def _floors(v):
    n = _num(v)
    if n is not None:
        return n if 0 < n < 200 else None
    ords = [int(x) for x in re.findall(r"(\d+)\s*(?:st|nd|rd|th)\b", str(v or ""), re.I)]
    return float(max(ords)) if ords else None


_MON = {m: i + 1 for i, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}


def day(v, year_max=None):
    """A date as YYYY-MM-DD from epoch ms, ISO text, M/D/YYYY, M/D/YY or '04-Nov-2026'; '' when it isn't one (or is out of
    range: a typo like 3036 or 2105 is dropped)."""
    if v is None or v == "":
        return ""
    y = m = d = None
    if isinstance(v, (int, float)) or re.fullmatch(r"-?\d{10,14}(\.\d+)?", str(v).strip()):
        try:
            t = float(v) / 1000.0
            g = time.gmtime(t)
            y, m, d = g.tm_year, g.tm_mon, g.tm_mday
        except (ValueError, OverflowError, OSError):
            return ""
    else:
        s = str(v).strip()
        a = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s) or re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})", s)
        b = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})\b", s)
        c = re.match(r"^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\b", s)
        if a:
            y, m, d = int(a.group(1)), int(a.group(2)), int(a.group(3))
        elif b:
            m, d, y = int(b.group(1)), int(b.group(2)), int(b.group(3))
            y = y + (2000 if y < 70 else 1900) if y < 100 else y
        elif c and c.group(2).lower() in _MON:
            d, m, y = int(c.group(1)), _MON[c.group(2).lower()], int(c.group(3))
            y = y + (2000 if y < 70 else 1900) if y < 100 else y
        else:
            return ""
    year_max = year_max or time.gmtime().tm_year + 1
    if not (1900 <= y <= year_max and 1 <= m <= 12 and 1 <= d <= 31):
        return ""
    return f"{y:04d}-{m:02d}-{d:02d}"


def _ll(lat, lon):
    lat, lon = _num(lat), _num(lon)
    if lat is None or lon is None or not (17 <= lat <= 72 and -180 <= lon <= -60):
        return None, None
    return round(lat, 6), round(lon, 6)


def _geom_ll(g):
    """lat, lon of an ArcGIS geometry in WGS84: a point, or the middle of a polygon's extent."""
    if not isinstance(g, dict):
        return None, None
    if "x" in g and "y" in g:
        return _ll(g.get("y"), g.get("x"))
    pts = [p for ring in (g.get("rings") or g.get("paths") or []) for p in ring if isinstance(p, (list, tuple)) and len(p) >= 2]
    if not pts:
        return None, None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return _ll((min(ys) + max(ys)) / 2, (min(xs) + max(xs)) / 2)


def _point_ll(v):
    """A Socrata location / point column: {latitude, longitude} or GeoJSON {type: Point, coordinates: [lon, lat]}."""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            m = re.search(r"(-?\d+\.\d+)[ ,]+(-?\d+\.\d+)", v)
            if not m:
                return None, None
            a, b = float(m.group(1)), float(m.group(2))
            return _ll(a, b) if abs(a) < 90 else _ll(b, a)
    if isinstance(v, dict):
        if "coordinates" in v and isinstance(v["coordinates"], (list, tuple)) and len(v["coordinates"]) >= 2:
            return _ll(v["coordinates"][1], v["coordinates"][0])
        return _ll(v.get("latitude"), v.get("longitude"))
    return None, None


def _clean(s, n=600):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    s = s.replace("&amp;", "&")
    return s[:n]


# --- classification -----------------------------------------------------------------------------------------------

_SMALL = re.compile(r"\b(single[- ]?family|one[- ]family|two[- ]family|[12][- ]family|sfd|nsfd|sfr|sfh|duplex|town ?houses?|town ?homes?|"
                    r"accessory dwelling|adu|two-family flat|single dwelling|one dwelling|house)\b", re.I)
# accessory jobs: only when the permit's own type or work class says so (a big job's description can mention a deck)
_ACCESSORY = re.compile(r"\b(shed|decks?|porch(es)?|fences?|swimming pools?|pools?|carports?|detached garage|gazebo|pergola|patio|"
                        r"retaining wall|driveway)\b", re.I)
_RES = re.compile(r"\b(residential|res|dwelling|rnew|ralt|radd|r-3|r3)\b", re.I)
_MULTI = re.compile(r"\b(multi[- ]?family|multifamily|apartments?|condo(minium)?s?|mixed[- ]use|hotel|dormitor(y|ies)|senior|assisted|"
                    r"r-2|r2|high[- ]rise|mid[- ]rise|\d{2,} units?|podium)\b", re.I)
_ERCES = re.compile(r"\b(erces|errcs|errc|bda|bi-?directional amplifiers?|distributed antenna|das system|in-?building (radio|coverage|"
                    r"communications?)|public safety (radio|das|communications?|coverage)|emergency responder radio|radio (coverage|"
                    r"enhancement|amplification)|two-way radio (coverage|system)|auxiliary radio communication|arcs)\b", re.I)
_CO = re.compile(r"(certificates? of occupancy|\bc ?of ?o\b|\bcofo\b|\buse (and|&) occupancy\b|\bu ?& ?o\b|occupancy certificate|"
                 r"\btco\b|temporary certificate|\bco issued\b)", re.I)
_NEW = re.compile(r"(\bnew (building|construction|bldg|structure|commercial|multi[- ]?family|apartment|hotel|school|office|warehouse|"
                  r"retail|mixed[- ]use|[\w-]+[- ]stor(y|ey))\b|\berect(ion)?\b|\bnb\b|\bcommercial new\b|\bresidential new\b|\bcnew\b|"
                  r"\bconstruct(ion)? (a )?new\b|\bbuild(ing)? (a )?new\b|\bground[- ]up\b|\bcore (and|&) shell\b|^new$|^construct$|"
                  r"\bnew bldg\b|\bnew structure\b|\bnew\b(?= *[-:]))", re.I)
_NOT_NEW = re.compile(r"\bnew (roof|windows?|signs?|decks?|fences?|elevators?|hvac|solar|doors?|kitchen|bath|sprinkler|fire alarm|"
                      r"generator|antenna|cell|tower|storefront|canopy)\b", re.I)
_ADD = re.compile(r"(\baddition\b|^add$|\badd\b(?! ?(on|to) (existing )?(sprinkler|fire alarm|electric))|\bcadd\b|\bradd\b|\bexpan(d|sion)\b|"
                  r"\benlarge(ment)?\b|\bvertical expansion\b)", re.I)
_ALT = re.compile(r"(\balter(ation)?s?\b|\brenovat(e|ion|ions)\b|\bremodel(ing)?\b|\btenant (fit|finish|improvement|layout|build)|\bti\b|"
                  r"interior (build|demo|renov|fit)|build[- ]?outs?\b|\bctbo\b|change of (use|occupancy)|\bchgocc\b|change in use|"
                  r"\brepair\b|\bretrofit\b|\bconver(t|sion)\b|\brehab(ilitation)?\b|\bfit[- ]?out\b)", re.I)
_CHG = re.compile(r"(change of (use|occupancy)|\bchgocc\b|change in use|change of occupancy classification)", re.I)
# in a description an addition has to be one to the building, not 'add 1 sprinkler head'
_ADD_DESC = re.compile(r"(\baddition\b(?! of)|\badd(ing)? (a |an |one |two |three |\d+ )?(new )?(rear |side |front |vertical )?"
                       r"(stor(y|ey|ies)|floors?|levels?|wings?)\b|\bvertical expansion\b|\benlarge(ment of)? (the )?building\b)", re.I)
_EXISTING = re.compile(r"\b(existing|main) (building|structure)|\bbuilding permit\b", re.I)
_RENO_LEAD = re.compile(r"^\W*(renovation|alteration|interior|repair|remodel|revision|tenant)\b|\b(renovation|alteration)s? (of|to) (an |the )?existing\b", re.I)
_BIG_WORDS = re.compile(r"(\bgut\b|entire (building|structure)|whole building|all floors|core (and|&) shell|full (interior|renovation|"
                        r"rehab)|level (3|iii) alteration|substantial (alteration|renovation|improvement))", re.I)
_SQFT_TXT = re.compile(r"([\d,]{3,9})\s*(?:\+\s*)?(?:sq\.?\s*ft\.?|sf\b|s\.f\.|square feet|sqft|gsf\b)", re.I)
_USD_TXT = re.compile(r"\$\s*([\d,]{4,12})(\.\d\d)?")


def _hit(rx, labelled):
    """(the words, which field) of the first field rx matches, in order."""
    for name, text in labelled:
        m = rx.search(text or "")
        if m:
            return m.group(0).strip(), name
    return None, None


_NEG = re.compile(r"\b(no|not|without|w/o|non)\b[\s-]+(\w+[\s-]+){0,2}$", re.I)
_TEMP = re.compile(r"\b(temporary (construction )?(trailers?|structures?|tents?|stages?|offices?)|construction trailers?|trailers?|"
                   r"tents?|kiosks?|bleachers)\b", re.I)
_RES_ZONE = re.compile(r"^(r-\d|rf-\d)", re.I)  # DC's single-family and flat zones (RA zones allow apartments)
_OWNER_ONLY = re.compile(r"\b(owner(ship)? change|change of owner(ship)?)\b", re.I)
_CO_NEW = re.compile(r"\bnew (construction|building)\b", re.I)
_NOT_BUILDING = re.compile(r"\b(playground|picnic shelter|shelters?|slabs?|swimming pool|pools?|cross|monument|signs?|retaining walls?|"
                           r"bridges?|fences?|canopy|canopies|antennas?|towers?|kiosks?|bus stop|dumpster enclosure|pergola|"
                           r"generators?|ev charg\w*|solar|tanks?|stairs?|ramps?|parking lot|site work|grading|foundation only|"
                           r"excavation|sheeting|shoring|soldier beams?|fountains?|pump station|utility vault|screen wall)\b", re.I)
_BUILDING = re.compile(r"\b(building|apartments?|multi[- ]?family|office|school|hotel|stor(y|ey|ies)|mixed[- ]use|dwelling|units|"
                       r"warehouse|hospital|retail|garage|center|centre|residence hall|dormitory|church|library|station)\b", re.I)


def _hit_not_negated(rx, labelled):
    """_hit, skipping a match that follows 'no', 'not' or 'without' ('no change in use')."""
    for name, text in labelled:
        for m in rx.finditer(text or ""):
            if not _NEG.search((text or "")[max(0, m.start() - 30):m.start()]):
                return m.group(0).strip(), name
    return None, None


def classify(rec, co_dataset=False):
    """(kind, why, erces) for a normalised record (type, work_class, desc, use_group, value_usd, sqft, floors, units, co_date).
    why names the words and the field that decided."""
    fields = [("type", rec.get("type") or ""), ("work class", rec.get("work_class") or ""), ("description", rec.get("desc") or ""),
              ("use", rec.get("use_group") or "")]
    struct = fields[:2]
    text = " | ".join(t for _, t in fields)
    erces_w, erces_f = _hit(_ERCES, fields)
    erces = bool(erces_w)
    big = ((rec.get("floors") or 0) >= 4 or max(rec.get("sqft") or 0, rec.get("work_sqft") or 0) >= 20000
           or (rec.get("value_usd") or 0) >= 2000000 or (rec.get("units") or 0) >= 5)
    temp_w, temp_f = _hit(_TEMP, fields)
    if temp_w and not big:
        return "other", f"A temporary structure: '{temp_w}' in the {temp_f}", erces
    small_w, small_f = _hit(_SMALL, fields)
    house = bool(small_w)  # a house, townhouse or duplex is one whatever it costs
    if not small_w:
        small_w, small_f = _hit(_ACCESSORY, struct)
    if not small_w and 0 < (rec.get("value_usd") or 0) < 100000:  # a small job whose description names a deck or a fence
        small_w, small_f = _hit(_ACCESSORY, fields[2:3])
    res_w, _ = _hit(_RES, struct)
    if not res_w and _RES_ZONE.match(rec.get("zone") or ""):
        res_w = rec["zone"].split("/")[0] + " zone"
    multi = bool(_MULTI.search(text))
    small = bool(not multi and (house or ((small_w or res_w) and not big)))
    small_why = (f"'{small_w}' in the {small_f}" if small_w else f"'{res_w}' (residential) with nothing larger named") + \
        ": a house, townhouse or small residential job (IFC 2024 510.1 Exception 4; DC and NC exempt R-3; Virginia exempts dwelling units)"

    def out(kind, words, field, extra=""):
        return kind, f"{KIND_LABEL[kind]}: '{words}' in the {field}{extra}", erces

    co_w, co_f = _hit(_CO, struct)
    if co_dataset or co_w:
        if small:
            return "other", "Certificate of occupancy for " + small_why, erces
        own_w, own_f = _hit(_OWNER_ONLY, fields)
        if own_w:
            return "other", f"Certificate of occupancy for a change of owner only: '{own_w}' in the {own_f}", erces
        new_w, new_f = _hit(_CO_NEW, fields)
        if co_w:
            return out("co_issued", co_w, co_f, f", for a new building ('{new_w}' in the {new_f})" if new_w else "")
        return "co_issued", ("Certificate of occupancy (a CO dataset)" + (f": '{new_w}' in the {new_f}, a new building" if new_w else "")), erces
    new_w, new_f = _hit(_NEW, struct)
    if new_w and _RENO_LEAD.search(rec.get("desc") or "") and not _CO_NEW.search(rec.get("desc") or ""):
        new_w = None  # 'Commercial New / Amendment: RENOVATION OF AN EXISTING ... GARAGE' is work on a building that stands
    if not new_w and not (_hit(_ADD, struct)[0] or _hit(_ALT, struct)[0]):  # the description counts only when the type is silent
        new_w, new_f = _hit_not_negated(_NEW, fields[2:3])
        if new_w and _NOT_NEW.search(rec.get("desc") or ""):
            new_w = None
    if new_w:
        if small:
            return "other", "New " + small_why, erces
        nb_w = _NOT_BUILDING.search(rec.get("desc") or "")
        if nb_w and not _BUILDING.search(_EXISTING.sub(" ", rec.get("desc") or "")):
            return "other", f"New work that isn't a building: '{nb_w.group(0)}' in the description", erces
        return out("new_building", new_w, new_f)
    add_w, add_f = _hit(_ADD, struct) if _hit(_ADD, struct)[0] else _hit(_ADD_DESC, fields[2:3])
    alt_w, alt_f = _hit(_ALT, struct) if _hit(_ALT, struct)[0] else _hit(_ALT, fields[2:3])
    if (add_w or alt_w) and small:
        return "other", ("Addition: " if add_w else "Alteration: ") + small_why, erces
    if add_w:
        return out("addition", add_w, add_f)
    if alt_w:
        chg_w, chg_f = _hit_not_negated(_CHG, fields)
        big_w, big_f = _hit_not_negated(_BIG_WORDS, fields)
        v, sq = rec.get("value_usd") or 0, rec.get("work_sqft") or 0  # the work's own area, never the whole building's
        if chg_w:
            return out("major_alteration", chg_w, chg_f, " (a change of occupancy)")
        if big_w:
            return out("major_alteration", big_w, big_f)
        if v >= MAJOR_USD or sq >= MAJOR_SQFT:
            size = f"${v:,.0f}" if v >= MAJOR_USD else f"{sq:,.0f} sq ft"
            return out("major_alteration", alt_w, alt_f, f", {size} of work (RF Recon's line: $250,000 or 10,000 sq ft)")
        size = "no value or area published" if not v and not sq else f"${v:,.0f}" if v else f"{sq:,.0f} sq ft"
        return "other", f"Alteration under RF Recon's major line ($250,000 or 10,000 sq ft): '{alt_w}' in the {alt_f}, {size}", erces
    if erces:
        return "other", f"ERCES work: '{erces_w}' in the {erces_f}", True
    return "other", "No new-building, addition, alteration or occupancy words in the type, work class or description", erces


# --- normalising one row ---------------------------------------------------------------------------------------------

def _get(raw, spec):
    """A mapped column's value; 'a+b+c' joins several (a house number and a street)."""
    if not spec:
        return None
    if "+" in spec:
        parts = [raw.get(p) for p in spec.split("+")]
        s = " ".join(str(p).strip() for p in parts if p not in (None, ""))
        return s or None
    return raw.get(spec)


def normalise(src, raw, geom=None, now=None):
    """One raw row (a dict of the dataset's own columns) as a permits.db record, or None without an id."""
    f = src.get("fields") or {}
    g = lambda k: _get(raw, f.get(k))
    pid = g("permit_id")
    if pid in (None, ""):
        return None
    ymax = (now or time.gmtime()).tm_year + 1
    rec = {"source": src["id"], "permit_id": _clean(pid, 80), "type": _clean(g("type"), 120), "work_class": _clean(g("work_class"), 120),
           "desc": _clean(g("desc")), "status": _clean(g("status"), 60), "filed": day(g("filed"), ymax), "issued": day(g("issued"), ymax),
           "final": day(g("final"), ymax), "co_date": day(g("co_date"), ymax), "address": _clean(g("address"), 160),
           "city": _clean(g("city"), 60), "value_usd": _num(g("value")), "sqft": _num(g("sqft")), "floors": _floors(g("floors")),
           "units": _num(g("units")), "use_group": _clean(g("use_group"), 120), "url": _clean(g("url"), 400) or "",
           "ref": _clean(g("ref"), 40), "zone": _clean(g("zone"), 40)}
    if rec["value_usd"] is not None and rec["value_usd"] <= 0:
        rec["value_usd"] = None
    if rec["sqft"] is not None and rec["sqft"] <= 0:
        rec["sqft"] = None
    if rec["sqft"] is None:  # "renovation of 12,000 sf office" in the description
        m = _SQFT_TXT.search(rec["desc"])
        if m:
            rec["sqft"] = _num(m.group(1))
    rec["work_sqft"], rec["bldg_sqft"] = rec["sqft"], None  # the permit's own area; bldg_sqft is the whole building's (enrich)
    if rec["value_usd"] is None:
        m = _USD_TXT.search(rec["desc"])
        if m:
            rec["value_usd"] = _num(m.group(1))
    loc = src.get("location") or "fields"
    lat = lon = None
    if loc == "geometry":
        lat, lon = _geom_ll(geom)
    elif loc.startswith("point_field:"):
        lat, lon = _point_ll(raw.get(loc.split(":", 1)[1]))
    if lat is None and f.get("lat") and f.get("lon"):
        lat, lon = _ll(raw.get(f["lat"]), raw.get(f["lon"]))
    rec["lat"], rec["lon"] = lat, lon
    return rec


def finish(src, rec):
    """Kind, why and the CO date for a normalised record (after any enrichment)."""
    kind, why, erces = classify(rec, bool(src.get("co_dataset")))
    if kind == "co_issued" and not rec["co_date"]:
        rec["co_date"] = rec["issued"] or rec["final"]
    rec.update(kind=kind, why=why, erces=1 if erces else 0)
    if rec["type"] or rec["work_class"]:  # the permit's own words lead its description
        lead = " / ".join(x for x in (rec["type"], rec["work_class"]) if x)
        rec["desc"] = _clean(f"{lead}: {rec['desc']}" if rec["desc"] else lead)
    return rec


# --- the APIs ------------------------------------------------------------------------------------------------------

def _select(src):
    cols = []
    for k, v in (src.get("fields") or {}).items():
        for p in str(v).split("+"):
            if p and p not in cols:
                cols.append(p)
    loc = src.get("location") or ""
    if loc.startswith("point_field:") and loc.split(":", 1)[1] not in cols:
        cols.append(loc.split(":", 1)[1])
    bad = set(cols) & set(src.get("personal_fields") or [])
    if bad:
        raise ValueError(f"{src['id']}: a mapped column names people ({', '.join(sorted(bad))}); the registry must not map it")
    return cols


def _endpoints(src, now=None):
    eps = src.get("endpoints") or [src["endpoint"]]
    y = (now or time.gmtime()).tm_year
    out = []
    for e in eps:
        if "{year}" in e:
            out += [e.replace("{year}", str(y - 1)), e.replace("{year}", str(y))]
        else:
            out.append(e)
    return out


def _iso_fmt(src):
    return (src.get("date_format") or "iso") in ("iso", "epoch_ms")


def _soda_pages(src, fetch, since, log, pause):
    """Rows (raw dicts) from a SODA resource dated on or after since, oldest first, a page at a time."""
    df = src.get("date_field")
    cols = _select(src)
    by_update = not _iso_fmt(src) or not df  # a text date doesn't sort: the row's own last-update time does
    order_col = ":updated_at" if by_update else df
    sel = ",".join(cols + ([":updated_at"] if by_update else []))
    where = [f"({src['where']})"] if src.get("where") else []
    where.append(f"{order_col} >= '{since}T00:00:00'")
    if not by_update:
        where.append(f"{df} IS NOT NULL")
    for ep in _endpoints(src):
        for page in range(MAX_PAGES):
            q = {"$select": sel, "$where": " AND ".join(where), "$order": f"{order_col} ASC, :id ASC", "$limit": PAGE, "$offset": page * PAGE}
            rows = _json(fetch, ep + "?" + urllib.parse.urlencode(q))
            if isinstance(rows, dict) and rows.get("error"):
                raise RuntimeError(f"Socrata: {rows.get('message') or rows}")
            for r in rows:
                yield r, None, (r.get(":updated_at") if by_update else r.get(df))
            if len(rows) < PAGE:
                break
            time.sleep(pause)


_LAYER = {}


def _layer(fetch, ep):
    if ep not in _LAYER:
        info = _json(fetch, ep + "?f=json")
        if info.get("error"):
            raise RuntimeError(f"ArcGIS layer: {info['error'].get('message')}")
        _LAYER[ep] = info
    return _LAYER[ep]


def _arcgis_pages(src, fetch, since, log, pause):
    df = src.get("date_field")
    fmt = src.get("date_format") or "epoch_ms"
    cols = _select(src)
    geom = (src.get("location") or "") == "geometry"
    for ep in _endpoints(src):
        info = _layer(fetch, ep)
        oid = info.get("objectIdField") or next((f["name"] for f in info.get("fields") or [] if f.get("type") == "esriFieldTypeOID"), "OBJECTID")
        size = min(PAGE, int(info.get("maxRecordCount") or PAGE))
        paged = (info.get("advancedQueryCapabilities") or {}).get("supportsPagination", True)
        base = f"({src['where']})" if src.get("where") else "1=1"
        if df and fmt == "epoch_ms":
            clauses = [f"{base} AND {df} >= DATE '{since}'", f"{base} AND {df} >= TIMESTAMP '{since} 00:00:00'"]
        elif df and fmt.startswith("text:YYYY-MM-DD"):
            clauses = [f"{base} AND {df} >= '{since}'"]
        else:
            clauses = [base]
        where, first = None, None
        for w in clauses:  # the first date form the server takes (hosted layers take DATE, some older servers only TIMESTAMP)
            q = {"where": w, "outFields": ",".join(cols), "orderByFields": f"{df} ASC, {oid} ASC" if df else f"{oid} ASC",
                 "resultOffset": 0, "resultRecordCount": size, "returnGeometry": "true" if geom else "false", "outSR": 4326, "f": "json"}
            got = _json(fetch, ep + "/query?" + urllib.parse.urlencode(q))
            if not got.get("error"):
                where, first = q, got
                break
        if where is None:
            raise RuntimeError(f"ArcGIS query refused: {got['error'].get('message')} {got['error'].get('details') or ''}")
        got = first
        for page in range(MAX_PAGES):
            feats = got.get("features") or []
            for ft in feats:
                a = ft.get("attributes") or {}
                yield a, ft.get("geometry"), a.get(df) if df else None
            if not feats or not paged or not (got.get("exceededTransferLimit") or len(feats) >= size):
                break
            time.sleep(pause)
            where["resultOffset"] += len(feats)
            got = _json(fetch, ep + "/query?" + urllib.parse.urlencode(where))
            if got.get("error"):
                raise RuntimeError(f"ArcGIS page: {got['error'].get('message')}")


def _odata_pages(src, fetch, since, log, pause):
    df = src.get("date_field")
    pid = (src.get("fields") or {}).get("permit_id")
    flt = ([f"({src['where']})"] if src.get("where") else []) + [f"{df} ge {since}"]
    for ep in _endpoints(src):
        for page in range(MAX_PAGES):
            q = {"$select": ",".join(_select(src)), "$filter": " and ".join(flt), "$orderby": f"{df} asc,{pid} asc", "$top": PAGE,
                 "$skip": page * PAGE}
            rows = _json(fetch, ep + "?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote))
            if isinstance(rows, dict):
                raise RuntimeError(f"OData: {(rows.get('error') or {}).get('message') or rows}")
            for r in rows:
                yield r, None, r.get(df)
            if len(rows) < PAGE:
                break
            time.sleep(pause)


_WHERE_TERM = re.compile(r'^\s*("?)([^"=<>!]+?)\1\s+(in|=|like|<>|!=|>=|<=)\s+(.+?)\s*$', re.I | re.S)


def csv_where(expr):
    """A predicate for the simple SQL the registry gives CSV sources: terms joined by AND / OR (AND binds first), each
    col = 'x', col <> 'x', col IN ('a','b'), col LIKE 'a%', col >= n. Anything else: every row passes."""
    if not (expr or "").strip():
        return lambda r: True
    ors = []
    try:
        for part in re.split(r"\s+or\s+(?=(?:[^']*'[^']*')*[^']*$)", expr, flags=re.I):
            ands = []
            for t in re.split(r"\s+and\s+(?=(?:[^']*'[^']*')*[^']*$)", part.strip().strip("()"), flags=re.I):
                m = _WHERE_TERM.match(t.strip().strip("()"))
                if not m:
                    return lambda r: True
                col, op, val = m.group(2).strip(), m.group(3).lower(), m.group(4).strip()
                vals = re.findall(r"'((?:[^']|'')*)'", val) if val.startswith(("(", "'")) else [val]
                ands.append((col, op, [v.replace("''", "'") for v in vals]))
            ors.append(ands)
    except re.error:
        return lambda r: True

    def test(r, col, op, vals):
        v = str(r.get(col) or "")
        if op in ("in", "="):
            return v in vals
        if op in ("<>", "!="):
            return v not in vals
        if op == "like":
            return any(re.fullmatch(re.escape(p).replace("%", ".*").replace("_", "."), v, re.I | re.S) for p in vals)
        a, b = _num(v), _num(vals[0])
        if a is None or b is None:
            return False
        return a >= b if op == ">=" else a <= b
    return lambda r: any(all(test(r, *t) for t in ands) for ands in ors)


def _csv_pages(src, fetch, since, log, pause):
    df = src.get("date_field")
    keep = csv_where(src.get("where"))
    cols = _select(src)
    for ep in _endpoints(src):
        try:
            got = fetch(ep)
        except RuntimeError as e:
            if "HTTP 404" in str(e) and "{year}" in (src.get("endpoint") or ""):
                continue  # this year's file isn't out yet
            raise
        text = io.StringIO(got.decode("utf-8-sig", "replace") if isinstance(got, (bytes, bytearray)) else got, newline="")
        for r in csv.DictReader(text):
            if not keep(r):
                continue
            d = day(r.get(df)) if df else ""
            if df and d and d < since:
                continue
            yield {c: r.get(c) for c in cols}, None, d
        time.sleep(pause)


PAGERS = {"soda": _soda_pages, "arcgis": _arcgis_pages, "odata": _odata_pages, "csv": _csv_pages}


def _enrich(src, fetch, recs, cache, pause):
    """Fill floor area, stories and use from a joined dataset (Arlington's Real Estate Property by its property code),
    for the rows that aren't small jobs, 20 codes a request."""
    e = src.get("enrich")
    if not e:
        return
    want = sorted({r["ref"] for r in recs if r.get("ref") and r["ref"] not in cache})
    for i in range(0, len(want), 20):
        part = want[i:i + 20]
        q = {"$select": ",".join([e["key"]] + list(e["fields"].values())), "$top": 100,
             "$filter": " or ".join(f"{e['key']} eq '{k}'" for k in part)}
        try:
            rows = _json(fetch, e["url"] + "?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote))
        except (RuntimeError, ValueError):
            return
        for k in part:
            cache[k] = {}
        for r in rows if isinstance(rows, list) else []:
            cache[str(r.get(e["key"]))] = {k: r.get(v) for k, v in e["fields"].items()}
        time.sleep(pause)
    for r in recs:
        got = cache.get(r.get("ref")) or {}
        if _num(got.get("sqft")):
            r["bldg_sqft"] = _num(got["sqft"])
        if r["floors"] is None and _floors(got.get("floors")):
            r["floors"] = _floors(got["floors"])
        if not r["use_group"] and got.get("use_group"):
            r["use_group"] = _clean(got["use_group"], 120)


# --- refresh ---------------------------------------------------------------------------------------------------------

def _upsert(con, recs, seen):
    con.executemany(f"INSERT OR REPLACE INTO permit({','.join(COLS)}) VALUES({','.join('?' * len(COLS))})",
                    [tuple(seen if c == "seen" else r.get(c) for c in COLS) for r in recs])


def pull(con, src, fetch, log=print, since=None, pause=PAUSE_S, now=None):
    """One dataset into permit, from since (default: its saved cursor less OVERLAP_DAYS, or LOOKBACK_DAYS back). The cursor
    moves after each page, so a stopped pull carries on where it got to. Returns the rows stored."""
    sid = src["id"]
    pager = PAGERS.get(src.get("api"))
    if not pager:
        raise ValueError(f"{sid}: API '{src.get('api')}' isn't one permits.py reads")
    t = time.mktime(now) if now else time.time()
    row = con.execute("SELECT cursor FROM pull WHERE source=?", (sid,)).fetchone()
    if since is None:
        if row and row[0]:
            since = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(row[0], "%Y-%m-%d")) - OVERLAP_DAYS * 86400))
        else:
            since = time.strftime("%Y-%m-%d", time.gmtime(t - LOOKBACK_DAYS * 86400))
    seen = time.strftime("%Y-%m-%d %H:%M", time.localtime(t))
    cutoff = time.strftime("%Y-%m-%d", time.gmtime(t - LOOKBACK_DAYS * 86400))
    n, batch, cursor, cache = 0, [], row[0] if row else None, {}

    def flush():
        nonlocal batch, n
        if not batch:
            return
        _enrich(src, fetch, [r for r in batch if not _SMALL.search(" ".join((r["type"], r["work_class"], r["desc"])))], cache, pause)
        recs = [finish(src, r) for r in batch]
        _upsert(con, recs, seen)
        n += len(recs)
        con.execute("INSERT OR REPLACE INTO pull(source, cursor, last_run, rows, error) VALUES(?,?,?,?,NULL)",
                    (sid, cursor, seen, n))
        con.commit()
        batch = []
    for raw, geom, d in pager(src, fetch, since, log, pause):
        rec = normalise(src, raw, geom, now)
        if not rec:
            continue
        newest = max(rec["issued"], rec["filed"], rec["final"], rec["co_date"])
        if newest and newest < cutoff:  # a row whose last update time is recent but whose dates are all old
            continue
        dd = day(d)
        if dd and (not cursor or dd > cursor) and dd <= time.strftime("%Y-%m-%d", time.gmtime(t + 86400)):
            cursor = dd
        batch.append(rec)
        if len(batch) >= PAGE:
            flush()
    flush()
    con.execute("INSERT OR REPLACE INTO pull(source, cursor, last_run, rows, error) VALUES(?,?,?,?,NULL)", (sid, cursor, seen, n))
    con.commit()
    return n


def refresh(data_dir, ids, log=print, fetch=None, pause=PAUSE_S, now=None):
    """Pull each dataset in ids (one failing never stops the rest), then drop rows older than KEEP_DAYS. Returns
    {id: rows, "errors": {id: message}}."""
    fetch = fetch or http_get
    regs = sources()
    out, errors = {}, {}
    con = connect(data_dir)
    try:
        for sid in ids:
            src = regs.get(sid)
            if not src:
                continue
            try:
                out[sid] = pull(con, src, fetch, log, pause=pause, now=now)
                log(f"{src['name']}: {out[sid]:,} rows")
            except Exception as e:
                con.rollback()
                out[sid], errors[sid] = 0, f"{type(e).__name__}: {str(e)[:240]}"
                con.execute("INSERT INTO pull(source, last_run, rows, error) VALUES(?,?,0,?) ON CONFLICT(source) DO UPDATE SET "
                            "last_run=excluded.last_run, error=excluded.error", (sid, time.strftime("%Y-%m-%d %H:%M"), errors[sid]))
                con.commit()
                log(f"{src['name']} failed: {e}")
        t = time.mktime(now) if now else time.time()
        old = time.strftime("%Y-%m-%d", time.gmtime(t - KEEP_DAYS * 86400))
        con.execute("DELETE FROM permit WHERE max(coalesce(issued,''), coalesce(filed,''), coalesce(final,''), coalesce(co_date,'')) < ?", (old,))
        con.commit()
    finally:
        con.close()
    if errors:
        out["errors"] = errors
    return out


def status(data_dir):
    """{id: {rows, cursor, last_run, error}} for every dataset pulled at least once."""
    if not os.path.exists(db_path(data_dir)):
        return {}
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    try:
        have = dict(con.execute("SELECT source, COUNT(*) FROM permit GROUP BY source").fetchall())
        return {s: {"rows": have.get(s, 0), "cursor": c, "last_run": lr, "error": err}
                for s, c, lr, err in con.execute("SELECT source, cursor, last_run, error FROM pull")}
    except sqlite3.OperationalError:
        return {}
    finally:
        con.close()


# --- reading and matching -------------------------------------------------------------------------------------------

def _hav(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(a)))


def near(data_dir, lat, lon, radius_mi, only=None):
    """Permits within radius_mi of a spot (rows with a location), each with dist_mi; only: dataset ids to read."""
    if not os.path.exists(db_path(data_dir)):
        return []
    lat, lon, radius_mi = float(lat), float(lon), max(0.0, float(radius_mi))
    dlat = radius_mi / 69.0
    dlon = radius_mi / (69.0 * max(0.01, math.cos(math.radians(lat))))
    sql = f"SELECT {','.join(COLS)} FROM permit WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"
    args = [lat - dlat, lat + dlat, lon - dlon, lon + dlon]
    if only is not None:
        if not only:
            return []
        sql += f" AND source IN ({','.join('?' * len(only))})"
        args += list(only)
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        out = []
        for r in con.execute(sql, args):
            rec = dict(zip(COLS, r))
            d = _hav(lat, lon, rec["lat"], rec["lon"])
            if d <= radius_mi:
                rec["dist_mi"] = round(d, 3)
                out.append(rec)
        return out
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()


_SUFFIX = {"street": "st", "avenue": "ave", "av": "ave", "road": "rd", "boulevard": "blvd", "drive": "dr", "lane": "ln", "place": "pl",
           "court": "ct", "parkway": "pkwy", "highway": "hwy", "terrace": "ter", "circle": "cir", "square": "sq", "north": "n",
           "south": "s", "east": "e", "west": "w", "northwest": "nw", "northeast": "ne", "southwest": "sw", "southeast": "se"}


def addr_key(a):
    """'1201 wilson' from '1201 Wilson Boulevard, Arlington VA': the house number and the street's first name word."""
    s = re.sub(r"[^a-z0-9 ]", " ", (a or "").lower())
    words = [_SUFFIX.get(w, w) for w in s.split()]
    if not words or not re.match(r"^\d+[a-z]?$", words[0]):
        return ""
    rest = [w for w in words[1:] if w not in _DIRS]
    return f"{re.sub(r'[a-z]$', '', words[0])} {rest[0]}" if rest else ""


_DIRS = {"n", "s", "e", "w", "nw", "ne", "sw", "se"}


# how close a permit's point must be to a building's point to count as that building (no outlines are kept)
LARGE = {"mall", "stadium", "airport", "college", "hospital", "venue", "casino", "warehouse", "transit", "government"}
MATCH_MI = {"large": 0.15, "default": 0.05}
CO_LINK_MI = 0.03


def is_new(p):
    """A new building: its permit, or a CO whose record says new construction."""
    return p["kind"] == "new_building" or (p["kind"] == "co_issued" and "new building" in (p.get("why") or ""))


def _rank(p, today):
    """Lower is a stronger trigger: a new building not yet occupied, a new building's CO in the last 12 months, a major
    alteration, an addition, another CO in the last 12 months (a new occupant or a change), ERCES work already permitted,
    then the rest; newest first within each."""
    yr = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(today, "%Y-%m-%d")) - 365 * 86400))
    co = p.get("co_date") or ""
    if p["kind"] == "new_building" and not co:
        k = 0
    elif is_new(p) and co >= yr:
        k = 1
    elif p["kind"] == "major_alteration":
        k = 2
    elif p["kind"] == "addition":
        k = 3
    elif p["kind"] == "co_issued" and co >= yr:
        k = 4
    elif p.get("erces"):
        k = 5
    elif p["kind"] in ("co_issued", "new_building"):
        k = 6
    else:
        k = 9
    return k, -int((p.get("co_date") or p.get("issued") or p.get("filed") or "0000-00-00").replace("-", ""))


def has_co_data(src_id, regs=None):
    """Whether CO dates exist for this dataset's place (its own CO column, or a CO dataset for the same place)."""
    regs = regs or sources()
    s = regs.get(src_id) or {}
    if (s.get("fields") or {}).get("co_date") or s.get("co_dataset") or s.get("co_where"):
        return True
    return any(o.get("co_dataset") and o.get("place") == s.get("place") for o in regs.values())


def label(p, co_data=True):
    """The trigger in words, e.g. 'New building permit 2026-08 · CO not yet issued'."""
    ym = lambda d: (d or "")[:7]
    when = ym(p.get("issued") or p.get("filed"))
    if p["kind"] == "new_building":
        if p.get("co_date"):
            return f"CO issued {ym(p['co_date'])} (IFC 510 test due before occupancy)"
        return f"New building permit {when} · " + ("CO not yet issued" if co_data else "no CO data for this place")
    if p["kind"] == "co_issued":
        if is_new(p):
            return f"CO issued {ym(p.get('co_date') or when)} (IFC 510 test due before occupancy)"
        return f"CO issued {ym(p.get('co_date') or when)} (a new occupant or a change)"
    if p["kind"] == "major_alteration":
        return f"Major alteration {when}"
    if p["kind"] == "addition":
        return f"Addition {when}"
    if p.get("erces"):
        return f"ERCES work permitted {when}"
    return f"Permit {when}"


def trigger_of(p, regs, n=1):
    s = regs.get(p["source"]) or {}
    return {"kind": p["kind"], "new": is_new(p), "label": label(p, has_co_data(p["source"], regs)), "permit_id": p["permit_id"], "desc": (p.get("desc") or "")[:300],
            "status": p.get("status") or "", "issued": p.get("issued") or "", "filed": p.get("filed") or "", "final": p.get("final") or "",
            "co_date": p.get("co_date") or "", "address": p.get("address") or "", "value_usd": p.get("value_usd"), "sqft": p.get("sqft"),
            "bldg_sqft": p.get("bldg_sqft"),
            "floors": p.get("floors"), "use_group": p.get("use_group") or "", "why": p.get("why") or "", "erces": bool(p.get("erces")),
            "source": p["source"], "source_name": s.get("name") or p["source"], "place": s.get("place") or "", "state": s.get("state") or "",
            "publisher": s.get("publisher") or "", "dataset_url": s.get("portal_url") or "", "url": p.get("url") or s.get("portal_url") or "",
            "license": s.get("license") or "", "attribution": s.get("attribution") or "", "n": n,
            "date": p.get("co_date") if p["kind"] == "co_issued" or p.get("co_date") else (p.get("issued") or p.get("filed") or "")}


def _link_cos(perms):
    """A new-building permit takes the CO date of a CO record at the same address or within about 50 m, issued after it."""
    cos = [p for p in perms if p["kind"] == "co_issued"]
    if not cos:
        return
    for p in perms:
        if p["kind"] != "new_building" or p.get("co_date"):
            continue
        k = addr_key(p.get("address"))
        for c in cos:
            same = (k and k == addr_key(c.get("address"))) or _hav(p["lat"], p["lon"], c["lat"], c["lon"]) <= CO_LINK_MI
            if same and (c.get("co_date") or "") >= (p.get("issued") or p.get("filed") or ""):
                p["co_date"] = c["co_date"]
                p["why"] = (p.get("why") or "") + f"; CO {c['permit_id']} ({c['source']}) issued {c['co_date']}"
                break


def attach(data_dir, rows, lat, lon, radius_mi, only=None, extra=True, today=None):
    """Each prospect row gets 'trigger' (its best permit) and 'permits' (how many) when permits match it: by address
    (house number and street) within 1 mi, else the nearest building within 0.05 mi (0.15 mi for malls, campuses,
    hospitals and other large sites), each permit to one building only. Returns (rows, extra_rows): extra_rows are new
    buildings (a new-building permit or a new-construction CO) that matched no prospect, one per address, as
    prospect-shaped rows of kind under_construction. Rows placed at their ZIP's centre match by address only."""
    today = today or time.strftime("%Y-%m-%d")
    perms = near(data_dir, lat, lon, float(radius_mi) + 0.2, only)
    if not perms:
        return rows, []
    regs = sources()
    _link_cos(perms)
    by_addr = {}
    pts = []
    for r in rows:
        if r.get("lat") is None:
            continue
        k = addr_key(r.get("address"))
        if k:
            by_addr.setdefault(k, []).append(r)
        if r.get("precision") != "zip":
            pts.append(r)
    got = {}
    left = []
    for p in perms:
        best = None
        k = addr_key(p.get("address"))
        for r in by_addr.get(k, []) if k else []:
            d = _hav(p["lat"], p["lon"], r["lat"], r["lon"])
            if d <= 1.0 and (best is None or d < best[0]):
                best = (d, r)
        if best is None:
            for r in pts:
                lim = MATCH_MI["large"] if r.get("kind") in LARGE else MATCH_MI["default"]
                if abs(r["lat"] - p["lat"]) > lim / 69.0 * 1.5:
                    continue
                d = _hav(p["lat"], p["lon"], r["lat"], r["lon"])
                if d <= lim and (best is None or d < best[0]):
                    best = (d, r)
        if best:
            got.setdefault(best[1]["id"], []).append(p)
        else:
            left.append(p)
    for r in rows:
        ps = got.get(r.get("id"))
        if not ps:
            continue
        ps.sort(key=lambda p: _rank(p, today))
        r["permits"] = len(ps)
        top = ps[0]
        if _rank(top, today)[0] < 9:
            r["trigger"] = trigger_of(top, regs, len(ps))
        else:
            r["trigger"] = dict(trigger_of(top, regs, len(ps)), minor=True)
    if not extra:
        return rows, []
    groups = {}
    for p in left:
        if p["kind"] not in ("new_building", "co_issued") or (p["kind"] == "co_issued" and "new building" not in (p.get("why") or "")):
            continue
        if p.get("dist_mi", 0) > float(radius_mi):
            continue
        k = addr_key(p.get("address")) or f"{round(p['lat'], 4)},{round(p['lon'], 4)}"
        groups.setdefault(k, []).append(p)
    out = []
    for k, ps in groups.items():
        ps.sort(key=lambda p: _rank(p, today))
        top = ps[0]
        if _rank(top, today)[0] > 1:  # an old CO: built and occupied a while ago, not news
            continue
        out.append(as_row(top, regs, len(ps), lat, lon))
    return rows, out


def _title(s):
    """'2626 24TH RD S NW' as '2626 24th Rd S NW': shouting addresses in title case, ordinals lower, compass points upper."""
    s = (s or "").strip()
    if not s or s.upper() != s:
        return s

    def word(m):
        w = m.group(0)
        if w[0].isdigit():
            return w.lower()
        return w if w in _DIRS_UP or w in ("DC", "VA", "MD", "US") else w.capitalize()
    return re.sub(r"[A-Za-z0-9']+", word, s)


_DIRS_UP = {"N", "S", "E", "W", "NW", "NE", "SW", "SE"}


def short_desc(p, n=80):
    """The list line for a permit's building: its use when the record names one, else the work's first words (the whole
    description is in the reasons row)."""
    use = (p.get("use_group") or "").strip()
    d = re.sub(r"^[^:]{0,80}:\s*", "", p.get("desc") or "")  # without the 'TYPE / CLASS:' lead
    d = re.sub(r"(?i)^(customer wants to use eplans,?\s*|issued building code use:\s*)", "", d).strip()
    s = f"{use}: {d}" if use and use.lower() not in d.lower()[:60] else d or use
    return s if len(s) <= n else s[:n].rsplit(" ", 1)[0] + "…"


def as_row(p, regs=None, n=1, lat=None, lon=None):
    """A permit as a prospect-shaped row (kind under_construction) for a building not yet in the prospect lists."""
    regs = regs or sources()
    s = regs.get(p["source"]) or {}
    area = p.get("bldg_sqft") or p.get("sqft")
    size = " · ".join(x for x in (p.get("floors") and f"{int(p['floors'])} floors", area and f"{area:,.0f} sq ft",
                                   p.get("value_usd") and f"${p['value_usd']:,.0f}") if x)
    full = _title(p.get("address"))
    street, _, rest = full.partition(",")
    city = _title(p.get("city")) or rest.strip().split(",")[0].strip() or (s.get("place") or "").split(",")[0]
    # the address is the name (a first email reads "... at 2626 24th Rd S (new building)"); a CO's record says new
    # construction, which may be a fit-out, not a whole new building
    what = "new construction CO" if p["kind"] == "co_issued" else "new building"
    name = f"{street} ({what})" if street else f"{what[:1].upper() + what[1:]} (permit {p['permit_id']})"
    row = {"id": f"permit:{p['source']}:{p['permit_id']}", "kind": "under_construction", "name": name,
           "address": street, "city": city, "state": s.get("state") or "", "zip": "", "lat": p["lat"], "lon": p["lon"],
           "precision": "exact", "phone": "", "website": "", "email": "",
           "contact_name": "", "contact_title": "", "size": p.get("sqft") or p.get("value_usd"), "size_label": size,
           "detail": short_desc(p), "source": f"permits:{p['source']}", "updated": p.get("seen") or ""}
    if lat is not None:
        row["dist_mi"] = round(_hav(float(lat), float(lon), p["lat"], p["lon"]), 2)
    row["trigger"] = trigger_of(p, regs, n)
    row["permits"] = n
    return row


def as_prospect(data_dir, pid):
    """The prospect-shaped row for 'permit:<source>:<permit id>', or None."""
    m = re.match(r"^permit:([^:]+):(.+)$", pid or "")
    if not m or not os.path.exists(db_path(data_dir)):
        return None
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    try:
        r = con.execute(f"SELECT {','.join(COLS)} FROM permit WHERE source=? AND permit_id=?", (m.group(1), m.group(2))).fetchone()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    if not r or r[COLS.index("lat")] is None:
        return None
    return as_row(dict(zip(COLS, r)))


def counts(data_dir, only=None):
    """{kind: rows} of the permits kept (only: dataset ids)."""
    if not os.path.exists(db_path(data_dir)):
        return {}
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    try:
        sql, args = "SELECT kind, COUNT(*) FROM permit", []
        if only is not None:
            sql += f" WHERE source IN ({','.join('?' * len(only)) or 'NULL'})"
            args = list(only)
        return dict(con.execute(sql + " GROUP BY kind", args).fetchall())
    except sqlite3.OperationalError:
        return {}
    finally:
        con.close()


def datasets_view(settings, states, data_dir):
    """Each dataset for Data & updates: its switch, terms and last pull."""
    st = status(data_dir)
    want = {s.strip().upper() for s in (states or []) if s.strip()}
    on = set(enabled(settings, None))
    out = []
    for sid, s in sources().items():
        out.append({"id": sid, "name": s.get("name"), "place": s.get("place"), "state": s.get("state"), "open": bool(s.get("open")),
                    "enabled": sid in on, "default": bool(s.get("enabled_default", s.get("open"))), "license": s.get("license"),
                    "commercial_use": s.get("commercial_use"), "url": s.get("portal_url"), "api": s.get("api"),
                    "in_states": not want or (s.get("state") or "").upper() in want, **(st.get(sid) or {})})
    out.sort(key=lambda d: (d["state"] or "", d["place"] or "", d["name"] or ""))
    return out
