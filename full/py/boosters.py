"""
Class B signal boosters registered with the FCC. A Class B (wideband) booster is registered before it operates
(47 CFR 90.219(d)(5)), and the FCC publishes the registrations as a public ArcGIS layer from its own account, the one
behind its "Signal Booster Registration Information" app: about 18,400 on 11/8, each with where the booster is, its
call signs and frequencies, the company, and the dates. FCC public data: the item carries no licence text (read on the
item page 11/8, reference/data_desk.json).

Two tables (Cody 11/8, "Keep everything", with the guardrails he approved with it):
  booster          the business fields: the registration number, position, the building's address and description, call
                   signs, frequencies, the company's name, city and state, the dates. Shown anywhere the app shows data.
  booster_contact  the people: the company's attention line, street address, ZIP, email and phones, every contact_* field
                   and the signature, keyed by booster_id. Kept only on Cody's PC and the server (RF_RECON_BUILD=personal,
                   build.PERSONAL), read only by an admin (app.py, /api/remote/booster-contact). Never in a field pack
                   (fieldpack.py copies the tables it names), the web version, the install kit (kit/build_kit.py
                   PERSONAL), the repo's reference/ files or a log. A field the FCC adds later goes with the contacts
                   (its extra column) until a person decides otherwise.

Fetched weekly (updater source fcc_boosters) through datadesk.fetchkit: first the layer's own description, and a
dataLastEditDate unchanged since the last load means nothing is downloaded; then every row, pages of 2,000 by FID, a
second apart (about 10 requests). A refusal (401, 403, 429, 451, 503, a token demand in an ArcGIS error body, a
challenge page) raises fetchkit.Refused and files a Needs a person task: nothing is tried another way. Rows go through
datadesk.clean (on Earth and in the US, a registration number each; two boosters in one building are two) and load in
one transaction. Not in the web version: it has no updater, and run() refuses there.
"""
import bisect
import json
import math
import re
import sys
import time
import urllib.parse

from datadesk import clean, fetchkit, persons

LAYER = "https://services.arcgis.com/YnOQrIGdN9JGtBh4/arcgis/rest/services/Signal_Booster_Regiatrations/FeatureServer/0"  # the FCC's spelling
ITEM = "https://www.arcgis.com/home/item.html?id=636f8803adbb431aa9324efbee3489e2"
FCC_APP = "https://experience.arcgis.com/experience/558fa854f397424fa188dff89750d4c3"
UA = "DAStastic data desk (FCC signal booster registrations; contact via omnyra.ai)"
SOURCE = {"id": "fcc-signal-booster-registrations-class-b", "name": "FCC signal booster registrations (Class B)", "url": ITEM,
          "terms": "FCC public data (US government)", "owner": "Cody"}
PAGE = 2000  # the layer's maxRecordCount
MAX_ROWS = 200000  # an answer that keeps going past this stops
AT_BUILDING_M = 75  # "at the building": within this of the job's pin or the prospect's point
REFUSE_CODES = (401, 403, 429, 451, 498, 499, 503)  # in an ArcGIS error body (it answers 200): a token demand or a refusal
SHRINK = 0.9  # a load under 90% of the rows already here is kept out: the registry doesn't lose a tenth in a week
NONE_HERE = ("No Class B booster is registered with the FCC at this building (within 75 m of the pin). A Class B booster is "
             "registered before it operates (47 CFR 90.219(d)(5)): one found here unregistered needs registering, and so "
             "does a new one before it's switched on.")

# the layer's field -> the booster column (business data); CONTACT stays in booster_contact; anything else: its extra
BUSINESS = {"booster_id": "booster_id", "Latitude": "lat", "Longitude": "lon", "address": "address", "address2": "address2",
            "city": "city", "state": "state", "zipcode": "zipcode", "county": "county", "location_description": "location",
            "callsigns": "callsigns", "frequencies": "frequencies", "company_name": "company", "company_city": "company_city",
            "company_state": "company_state", "submitted": "submitted", "updated": "updated", "data_as_of": "data_as_of",
            "census_2020_county": "census_county", "census_2020_state": "census_state", "FID": "fid"}
CONTACT = ("company_attention", "company_address", "company_address2", "company_zipcode", "company_email", "company_phone",
           "company_phone_1", "contact_name", "contact_companyname", "contact_address", "contact_address2", "contact_city",
           "contact_state", "contact_zipcode", "contact_email", "contact_phone", "signature_title", "signature")
COLS = ("booster_id", "lat", "lon", "address", "address2", "city", "state", "zipcode", "county", "location", "callsigns",
        "frequencies", "freq_lo", "freq_hi", "ranges", "company", "company_city", "company_state", "submitted", "updated",
        "data_as_of", "census_county", "census_state", "fid")
REAL = {"lat", "lon", "freq_lo", "freq_hi"}
SCHEMA = ("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);\n"
          "CREATE TABLE IF NOT EXISTS booster(" + ", ".join(
              c + (" TEXT PRIMARY KEY" if c == "booster_id" else " REAL" if c in REAL else " INTEGER" if c == "fid" else " TEXT")
              for c in COLS) + ");\n"
          "CREATE INDEX IF NOT EXISTS booster_latlon ON booster(lat, lon);\n")
CONTACT_SCHEMA = ("CREATE TABLE IF NOT EXISTS booster_contact(booster_id TEXT PRIMARY KEY, "
                  + ", ".join(c + " TEXT" for c in CONTACT) + ", extra TEXT);\n")


def keeps_contacts():
    """The people fields are kept on Cody's PC and the server only (the personal build), never on an install-kit copy."""
    import build
    return build.PERSONAL


# ---------------------------------------------------------------- reading the FCC's fields

_FREQ = re.compile(r"(\d+(?:\.\d+)?)\s*(ghz|mhz|khz)?\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(ghz|mhz|khz)?)?", re.I)


def ranges(text):
    """'[758-775 MHz], [788-805 MHz]' -> [[758.0, 775.0], [788.0, 805.0]], in MHz. A lone frequency is a range of one.
    What doesn't read as a radio frequency a booster passes (25 MHz to 10 GHz: not "Band 14") is left out, never guessed."""
    out = []
    for a, ua, b, ub in _FREQ.findall(str(text or "")):
        unit = (ub or ua or "mhz").lower()
        lo, hi = clean.mhz(a, ua or unit), clean.mhz(b or a, ub or unit)
        if lo is None or hi is None:
            continue
        lo, hi = sorted((lo, hi))
        if 25 <= lo and hi <= 10000:
            out.append([round(lo, 6), round(hi, 6)])
    return out


def callsigns(text):
    """'[WQJU870], [KNNJ123]' -> 'WQJU870, KNNJ123'."""
    got = [clean.callsign(x) for x in re.split(r"[\[\],;/\s]+", str(text or ""))]
    return ", ".join(dict.fromkeys(c for c in got if c and len(c) >= 3)) or None


def _text(v):
    s = re.sub(r"\s+", " ", str(v)).strip() if v is not None else ""
    return s or None


def _day(v):
    """An ArcGIS date (milliseconds since 1970, UTC) or a date-only field ('2026-10-23') as YYYY-MM-DD."""
    if v in (None, ""):
        return None
    if isinstance(v, (int, float)):
        return time.strftime("%Y-%m-%d", time.gmtime(v / 1000))
    m = re.match(r"\d{4}-\d{2}-\d{2}", str(v))
    return m.group(0) if m else None


def split(attrs, geom=None):
    """One ArcGIS feature -> (business row, contact row). The contact row has every people field and, in extra, any
    field this module doesn't know (the FCC may add one: it's kept apart until a person decides)."""
    b, c, extra = {}, {}, {}
    for k, v in (attrs or {}).items():
        if k in BUSINESS:
            b[BUSINESS[k]] = v
        elif k in CONTACT:
            c[k] = _text(v)
        else:
            extra[k] = v
    if b.get("lat") is None and (geom or {}).get("y") is not None:  # the point's own geometry when the columns are empty
        b["lat"], b["lon"] = geom["y"], geom["x"]
    for k in ("booster_id", "address", "address2", "city", "state", "zipcode", "county", "location", "company", "company_city",
              "company_state", "census_county", "census_state"):
        b[k] = _text(b.get(k))
    b["booster_id"] = (b["booster_id"] or "").upper() or None
    rg = ranges(b.get("frequencies"))
    b.update(freq_lo=min((r[0] for r in rg), default=None), freq_hi=max((r[1] for r in rg), default=None), ranges=json.dumps(rg),
             frequencies=_text(re.sub(r"[\[\]]", "", str(b.get("frequencies") or ""))), callsigns=callsigns(b.get("callsigns")),
             submitted=_day(b.get("submitted")), updated=_day(b.get("updated")), data_as_of=_day(b.get("data_as_of")))
    c["extra"] = json.dumps(extra, default=str) if extra else None
    return b, c


# ---------------------------------------------------------------- the FCC's layer

def _json(f, url):
    """An ArcGIS answer as JSON. Its errors come back as 200 with an error body: a token demand or a refusal raises
    fetchkit.Refused; any other error stops the run as it is (nothing loaded, nothing tried another way)."""
    r = f.get(url, accept="application/json", conditional=False)
    try:
        d = json.loads(r.body or b"{}")
    except ValueError:
        raise RuntimeError(f"{urllib.parse.urlsplit(url).netloc} answered with something that isn't JSON") from None
    err = d.get("error") if isinstance(d, dict) else None
    if err:
        code = int(err.get("code") or 0) if str(err.get("code") or "").isdigit() else 0
        if code in REFUSE_CODES:
            why = "asks for a sign-in or a token" if code in (401, 403, 498, 499) else fetchkit.REFUSALS.get(code, "refused")
            raise fetchkit.Refused(url, f"{why} (ArcGIS {code})", code)
        raise RuntimeError(f"the FCC's layer answered an error: {clean.scrub_text(err.get('message') or err)[:200]}")
    if not isinstance(d, dict):
        raise RuntimeError("the FCC's layer answered something that isn't an ArcGIS answer")
    return d


def page_url(offset):
    return LAYER + "/query?" + urllib.parse.urlencode({"where": "1=1", "outFields": "*", "orderByFields": "FID ASC",
                                                        "resultOffset": offset, "resultRecordCount": PAGE, "returnGeometry": "true",
                                                        "outSR": "4326", "f": "json"})


def fetch_rows(f, log=None, sleep=time.sleep):
    """Every feature, pages of PAGE ordered by FID, a second apart: [(attributes, geometry)]."""
    out, offset = [], 0
    while True:
        if offset:
            sleep(1.0)
        d = _json(f, page_url(offset))
        feats = d.get("features")
        if not isinstance(feats, list):
            raise RuntimeError("the FCC's layer answered a page with no features list")
        out += [(x.get("attributes") or {}, x.get("geometry")) for x in feats]
        if log:
            log(f"{len(out):,} registrations read…")
        if not feats or not (d.get("exceededTransferLimit") or len(feats) >= PAGE):
            return out
        offset += len(feats)
        if offset >= MAX_ROWS:
            raise RuntimeError(f"the FCC's layer kept going past {MAX_ROWS:,} rows: stopped, nothing loaded")


def has_table(con, name="booster"):
    return bool(con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def _meta(con, k):
    try:
        r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    except Exception:  # noqa: BLE001  no meta table: nothing loaded yet
        return None
    return r[0] if r else None


PROFILE = "registrations"  # datadesk.clean: required id, lat and lon; in the US; deduped by id only


def run(con, fetcher=None, force=False, log=None, keep_contacts=None, sleep=time.sleep):
    """Check the layer, and load it when it changed (or force). {"unchanged": True, "rows", "as_of"} when it hadn't;
    else {"rows", "contacts", "quarantined", "dupes", "as_of", "edit", "requests", "took_s"}."""
    if sys.platform == "emscripten":
        raise RuntimeError("The FCC's booster registrations load on the PC and the server, not in the web version.")
    t0 = time.time()
    keep_contacts = keeps_contacts() if keep_contacts is None else keep_contacts
    f = fetcher or fetchkit.Fetcher(UA, max_bytes=40 * 1024 * 1024, timeout=90)
    persons.ensure(con)
    try:
        info = _json(f, LAYER + "?f=json")
        edit = (info.get("editingInfo") or {}).get("dataLastEditDate")
        have = has_table(con) and con.execute("SELECT COUNT(*) FROM booster").fetchone()[0]
        if not force and edit and have and str(edit) == _meta(con, "boosters_edit"):
            return {"unchanged": True, "rows": have, "as_of": _meta(con, "boosters_as_of"), "requests": len(f.requests)}
        raw = fetch_rows(f, log, sleep)
    except fetchkit.Refused as e:
        persons.from_refusal(con, SOURCE, e, "The FCC's signal booster registrations say which buildings already have a "
                                             "registered Class B booster (DAS jobs, Prospects, the map).")
        raise
    if not raw:
        raise RuntimeError("the FCC's layer came back with no registrations: nothing loaded, what was here is kept")
    rows, people = [], {}
    for attrs, geom in sorted(raw, key=lambda x: (str(x[0].get("updated") or x[0].get("submitted") or ""), x[0].get("FID") or 0), reverse=True):
        b, c = split(attrs, geom)
        rows.append(dict(b, id=b["booster_id"]))
        if b["booster_id"]:
            people.setdefault(b["booster_id"], c)  # the newest row of a registration listed twice, as clean keeps it
    got = clean.run(rows, PROFILE, dict(SOURCE, personal_fields=list(CONTACT)), time.strftime("%Y-%m-%dT%H:%M:%S"))
    kept = got["kept"]
    if have and len(kept) < have * SHRINK:
        raise RuntimeError(f"the FCC's layer came back with {len(kept):,} usable registrations, under 90% of the {have:,} "
                           "loaded here: not loaded, what was here is kept (a person should look)")
    as_of = max((r.get("data_as_of") or "" for r in kept), default="") or None
    quar = {"n": len(got["quarantined"]), "examples": [{"booster_id": q["row"].get("booster_id"), "why": q["why"]} for q in got["quarantined"][:20]]}
    con.executescript(SCHEMA + (CONTACT_SCHEMA if keep_contacts else ""))
    try:  # one transaction: a reader sees the old registrations or the new ones, never half
        con.execute("DELETE FROM booster")
        con.executemany(f"INSERT INTO booster({', '.join(COLS)}) VALUES({', '.join('?' * len(COLS))})",
                        [[r.get(c) for c in COLS] for r in kept])
        if keep_contacts:
            con.execute("DELETE FROM booster_contact")
            con.executemany(f"INSERT INTO booster_contact(booster_id, {', '.join(CONTACT)}, extra) VALUES({', '.join('?' * (len(CONTACT) + 2))})",
                            [[r["booster_id"]] + [people[r["booster_id"]].get(c) for c in CONTACT] + [people[r["booster_id"]].get("extra")]
                             for r in kept])
        for k, v in (("boosters_built_at", time.strftime("%Y-%m-%d %H:%M")), ("boosters_as_of", as_of), ("boosters_edit", str(edit or "")),
                     ("boosters_rows", str(len(kept))), ("boosters_quarantined", json.dumps(quar)),
                     ("boosters_contacts", "kept" if keep_contacts else "not kept on this copy")):
            con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)", (k, v))
        con.commit()
    except BaseException:
        con.rollback()
        raise
    if log:
        log(f"{len(kept):,} registrations loaded" + (f", {quar['n']} set aside" if quar["n"] else ""))
    return {"rows": len(kept), "contacts": len(kept) if keep_contacts else 0, "quarantined": quar["n"], "dupes": got["dupes"],
            "as_of": as_of, "edit": edit, "requests": len(f.requests), "took_s": round(time.time() - t0, 1)}


# ---------------------------------------------------------------- what the app shows (business fields only)

def _box(lat, lon, m):
    dlat = m / 111320.0
    dlon = m / (111320.0 * max(0.01, math.cos(math.radians(lat))))
    return lat - dlat, lat + dlat, lon - dlon, lon + dlon


def view(r, m=None):
    """A booster row as the pages show it: business fields only, never a contact."""
    r = dict(zip(COLS, r)) if not isinstance(r, dict) else r  # a stored row (a tuple, or sqlite3.Row) in COLS order
    tail = " ".join(x for x in (r.get("state"), r.get("zipcode")) if x)
    return {"booster_id": r["booster_id"], "lat": r["lat"], "lon": r["lon"], "m": round(m) if m is not None else None,
            "address": ", ".join(x for x in (r.get("address"), r.get("address2"), r.get("city"), tail) if x),
            "location": r.get("location") or "", "callsigns": [c for c in (r.get("callsigns") or "").split(", ") if c],
            "frequencies": r.get("frequencies") or "", "ranges": json.loads(r.get("ranges") or "[]"), "company": r.get("company") or "",
            "company_place": ", ".join(x for x in (r.get("company_city"), r.get("company_state")) if x),
            "registered": r.get("submitted"), "updated": r.get("updated"), "data_as_of": r.get("data_as_of")}


def _near(con, lat, lon, radius_m):
    """[(metres, row)] within radius_m of the point, nearest first: one query on the lat/lon index, the rows as stored."""
    if not has_table(con):
        return []
    s, n, w, e = _box(lat, lon, radius_m)
    out = []
    for r in con.execute(f"SELECT {', '.join(COLS)} FROM booster WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e)):
        m = clean.metres((lat, lon), (r[1], r[2]))
        if m <= radius_m:
            out.append((m, r))
    out.sort(key=lambda x: x[0])
    return out


def near(con, lat, lon, radius_m):
    """Registrations within radius_m of the point, nearest first, each with its distance in metres (m)."""
    return [view(r, m) for m, r in _near(con, lat, lon, radius_m)]


def source(con):
    return {"name": "FCC signal booster registrations", "url": FCC_APP, "as_of": _meta(con, "boosters_as_of"),
            "loaded": _meta(con, "boosters_built_at")}


def at_job(con, lat, lon, radius_mi=15.0, most=50):
    """A DAS job's registered boosters: at the building (within AT_BUILDING_M of the pin), and within the pre-survey's
    radius (the nearest `most`, with the count)."""
    if not has_table(con):
        return {"loaded": False, "at_building": [], "within": [], "within_n": 0, "radius_mi": radius_mi, "at_m": AT_BUILDING_M}
    within = _near(con, lat, lon, radius_mi * 1609.344)  # a view is made only for the ones listed
    here = [view(r, m) for m, r in within if m <= AT_BUILDING_M]
    return {"loaded": True, "at_building": here, "within": [view(r, m) for m, r in within[len(here):len(here) + most]],
            "within_n": len(within) - len(here), "radius_mi": radius_mi, "at_m": AT_BUILDING_M, "note": "" if here else NONE_HERE,
            "source": source(con)}


def for_presurvey(con, lat, lon, radius_mi, systems, chosen=None, most=40, names=8):
    """Registered boosters within the pre-survey's radius whose frequencies take in a channel (down or up) of the systems
    the job chose (all it found, when none are chosen yet), nearest first: n of them, the nearest `most` listed, each
    naming up to `names` of those systems (call signs) and how many there are."""
    if not has_table(con):
        return {"loaded": False, "list": [], "n": 0}
    chosen = {c for c in chosen or () if c}
    pick = [s for s in systems if s["call_sign"] in chosen] if chosen else systems
    chans = sorted({(round(float(f), 6), s["call_sign"]) for s in pick
                    for f in [c["freq"] for c in s.get("down") or []] + list(s.get("up") or []) if f is not None})
    freqs, seen, ri = [f for f, _ in chans], {}, COLS.index("ranges")
    out = []
    if chans:
        for m, r in _near(con, lat, lon, radius_mi * 1609.344):
            if r[ri] not in seen:  # registrations repeat the same few ranges (851-862, 806-817...): each worked out once
                seen[r[ri]] = {cs for lo, hi in json.loads(r[ri] or "[]")
                               for _, cs in chans[bisect.bisect_left(freqs, lo):bisect.bisect_right(freqs, hi)]}
            if seen[r[ri]]:
                out.append((m, r, seen[r[ri]]))
    return {"loaded": True, "n": len(out), "chosen": bool(chosen), "radius_mi": radius_mi, "at_m": AT_BUILDING_M, "source": source(con),
            "list": [dict(view(r, m), systems=sorted(hit)[:names], systems_n=len(hit), at_building=m <= AT_BUILDING_M) for m, r, hit in out[:most]]}


def attach(con, rows, m=AT_BUILDING_M):
    """DAS Prospects: each row with a registration within m of its point gets booster = {booster_id, registered, company,
    m, n} (the nearest; n: how many are that close). One query on the lat/lon index over the rows' whole extent."""
    pts = [r for r in rows if r.get("lat") is not None and r.get("lon") is not None]
    if not pts or not has_table(con):
        return rows
    lats, lons = [r["lat"] for r in pts], [r["lon"] for r in pts]
    dlat, dlon = m / 111320.0, m / (111320.0 * max(0.01, math.cos(math.radians(max(abs(min(lats)), abs(max(lats)))))))
    cell, grid = 0.003, {}  # ~330 m of latitude: a point's own cell and the eight around it hold everything within 75 m
    for b in con.execute("SELECT booster_id, lat, lon, submitted, company FROM booster WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                         (min(lats) - dlat, max(lats) + dlat, min(lons) - dlon, max(lons) + dlon)):
        grid.setdefault((int(b[1] // cell), int(b[2] // cell)), []).append(b)
    if not grid:
        return rows
    for r in pts:
        ky, kx = int(r["lat"] // cell), int(r["lon"] // cell)
        hits = sorted(((clean.metres((r["lat"], r["lon"]), (b[1], b[2])), b) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                       for b in grid.get((ky + dy, kx + dx), ())), key=lambda x: x[0])  # by distance only: two at one spot tie
        hits = [(d, b) for d, b in hits if d <= m]
        if hits:
            d, b = hits[0]
            r["booster"] = {"booster_id": b[0], "registered": b[3], "company": b[4] or "", "m": round(d), "n": len(hits)}
    return rows


def contact(con, booster_id):
    """The registrant's people fields for one registration, for an admin only (the caller checks: app.py). None when
    this copy keeps none or has no such registration."""
    if not booster_id or not has_table(con, "booster_contact"):
        return None
    r = con.execute(f"SELECT {', '.join(CONTACT)}, extra FROM booster_contact WHERE booster_id=?", (str(booster_id).upper(),)).fetchone()
    if not r:
        return None
    c = dict(zip(CONTACT + ("extra",), r))
    line = lambda *ks: ", ".join(x for x in (c.get(k) for k in ks) if x)
    return {"booster_id": str(booster_id).upper(),
            "company": {"attention": c["company_attention"] or "", "address": line("company_address", "company_address2", "company_zipcode"),
                        "email": c["company_email"] or "", "phones": [p for p in (c["company_phone"], c["company_phone_1"]) if p]},
            "contact": {"name": c["contact_name"] or "", "company": c["contact_companyname"] or "",
                        "address": line("contact_address", "contact_address2", "contact_city", "contact_state", "contact_zipcode"),
                        "email": c["contact_email"] or "", "phone": c["contact_phone"] or ""},
            "signed": " · ".join(x for x in (c["signature"], c["signature_title"]) if x),
            "extra": json.loads(c["extra"]) if c["extra"] else {},
            "note": "From the registration filed with the FCC. Admins only: kept on the server and Cody's PC, never shared."}


def feature(r):
    """A map row (the Map's layer "Signal boosters (FCC registered)"): business fields only."""
    r = dict(zip(COLS, r)) if not isinstance(r, dict) else r
    v = view(r)
    return {"layer": "boosters", "fid": f"booster:{v['booster_id']}", "lat": v["lat"], "lon": v["lon"],
            "label": f"{v['company'] or 'Signal booster'} · {v['booster_id']}", "category": "Signal booster (FCC registered)",
            "sig_type": None, "freq_mhz": r["freq_lo"], "freq_lo_mhz": r["freq_lo"], "freq_hi_mhz": r["freq_hi"],
            "booster_id": v["booster_id"],
            "details": json.dumps({"Registration": v["booster_id"], "Registered": v["registered"] or "", "Updated": v["updated"] or "",
                                   "Company": " · ".join(x for x in (v["company"], v["company_place"]) if x),
                                   "Call signs": ", ".join(v["callsigns"]), "Frequencies": v["frequencies"], "Building": v["address"],
                                   "Location": v["location"], "Rule": "Class B: registered before it operates (47 CFR 90.219(d)(5))",
                                   "Registry": f"FCC signal booster registrations, data as of {v['data_as_of'] or '?'}"})}
