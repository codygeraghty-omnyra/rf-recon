"""
DAS / ERCES prospect lists: buildings that need in-building public-safety radio coverage, from public US government
directories (static/research/das_market.json, prospect_sources, has the terms behind each choice).

  nces_ccd        public K-12 schools (NCES CCD directory), placed by the NCES EDGE geocodes (joined on NCESSCH)
  nces_pss        private schools (NCES Private School Survey), own coordinates and enrolment
  ipeds           colleges (IPEDS HD), own coordinates, chief administrator's name and title
  cms_hospitals   hospitals (CMS Hospital General Information); no coordinates, so placed at the ZIP's centroid
                  (Census Gazetteer ZCTA) and marked precision 'zip'
  cms_nursing_homes  nursing homes (CMS Nursing Home Provider Information, dataset 4pq5-n9py), own coordinates,
                  certified beds, ownership, chain and sprinkler status (R3 #6, 2026-11-04 data scout)

Every source is a US government work (public domain, 17 USC 105) with no bar on commercial or marketing use. Kept
in its own sqlite file (data/prospects.db, WAL) so a refresh never locks the FCC data and the map can call near()
while a refresh runs. Files are streamed row by row, never held as lists: list(csv.DictReader) on a big file took
the server's 4 GB on 11/3. A new school year means new file names in SOURCES (NCES puts the year in the name).
"""
import dlstop  # Stop all downloads
import codecs
import csv
import io
import itertools
import json
import math
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
import zipfile

UA = "RF-Recon/2.0 (DAS prospect lists)"
# data.cms.gov's Akamai answers 403 to any agent it doesn't know (ours included) and lets Python's own through
# (checked 2026-11-03), so CMS calls lead with it and still name DAStastic
UA_CMS = "Python-urllib/3 " + UA
BATCH = 5000
PROGRESS = 20000

_NCES_TERMS = "Public domain: US government work (17 USC 105); no commercial or marketing restriction (das_market.json)"
SOURCES = {
    "nces_ccd": {
        "name": "NCES Common Core of Data public school directory 2024-25 + EDGE school geocodes",
        "kind": "school_k12",
        "url": "https://nces.ed.gov/ccd/Data/zip/ccd_sch_029_2425_w_1a_073025.zip",
        "geo": "edge",
        "license": _NCES_TERMS,
        "attribution": "U.S. Department of Education, National Center for Education Statistics, Common Core of Data "
                       "(CCD) 2024-25 and EDGE Public School Geocodes 2024-25",
        "fields": "SCH_NAME, LEA_NAME, location address, PHONE, WEBSITE, LEVEL, SCH_TYPE_TEXT, CHARTER_TEXT; LAT/LON from EDGE",
    },
    "nces_pss": {
        "name": "NCES Private School Universe Survey 2023-24",
        "kind": "school_private",
        "url": "https://nces.ed.gov/surveys/pss/zip/pss2324_pu_csv.zip",
        "license": _NCES_TERMS,
        "attribution": "U.S. Department of Education, National Center for Education Statistics, Private School Universe "
                       "Survey (PSS) 2023-24",
        "fields": "PPIN, PINST, PADDRS/PL_ADD, PCITY, PSTABB, PZIP, PPHONE, LATITUDE24, LONGITUDE24, NUMSTUDS, TYPOLOGY",
    },
    "ipeds": {
        "name": "IPEDS institutional directory (HD) 2024",
        "kind": "college",
        "url": "https://nces.ed.gov/ipeds/datacenter/data/HD2024.zip",
        "license": _NCES_TERMS,
        "attribution": "U.S. Department of Education, National Center for Education Statistics, IPEDS Institutional "
                       "Characteristics (HD2024)",
        "fields": "UNITID, INSTNM, ADDR, CITY, STABBR, ZIP, CHFNM, CHFTITLE, GENTELE, WEBADDR, LATITUDE, LONGITUD, INSTSIZE, SECTOR",
    },
    "cms_hospitals": {
        "name": "CMS Hospital General Information (Care Compare)",
        "kind": "hospital",
        # the resource folder changes with each Care Compare release: the metastore names the current file
        "meta": "https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/xubh-q36u",
        "url": "https://data.cms.gov/provider-data/sites/default/files/resources/893c372430d9d71a1c52737d01239d47_1785189955/Hospital_General_Information.csv",
        "ua": UA_CMS,
        "geo": "zcta",
        "license": "Public: US government work (17 USC 105); CMS public data are freely available; no commercial or "
                   "marketing restriction (das_market.json)",
        "attribution": "Centers for Medicare & Medicaid Services, Provider Data Catalog: Hospital General Information; "
                       "ZIP centroids from the U.S. Census Bureau Gazetteer (ZCTA)",
        "fields": "Facility ID, Facility Name, Address, City/Town, State, ZIP Code, Telephone Number, Hospital Type, "
                  "Hospital Ownership, Emergency Services; lat/lon = ZIP centroid",
    },
    # I-2 healthcare occupancy (R3 #6): 14,686 facilities with their own coordinates (datastore count, 2026-11-04); the same
    # CMS host, agent and public-data terms as the hospitals. The metastore names each month's file (NH_ProviderInfo_<Mon><Year>.csv)
    "cms_nursing_homes": {
        "name": "CMS Nursing Home Provider Information (Care Compare)",
        "kind": "nursing_home",
        "meta": "https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/4pq5-n9py",
        "url": "https://data.cms.gov/provider-data/sites/default/files/resources/0970c657767e40f8521187d02ba8d0ed_1792181744/NH_ProviderInfo_Oct2026.csv",
        "ua": UA_CMS,
        "license": "Public: US government work (17 USC 105); CMS public data are freely available; no commercial or "
                   "marketing restriction (das_market.json; the same terms as the hospital list)",
        "attribution": "Centers for Medicare & Medicaid Services, Provider Data Catalog: Nursing Home Provider Information",
        "fields": "CMS Certification Number (CCN), Provider Name, Provider Address, City/Town, State, ZIP Code, Telephone Number, "
                  "Ownership Type, Number of Certified Beds, Chain Name, Provider Resides in Hospital, "
                  "Automatic Sprinkler Systems in All Required Areas, Latitude, Longitude",
    },
}
SOURCES["overture_places"] = {
    "name": "Overture Maps places: malls, arenas and stadiums, hotels, convention centres and venues, casinos, airports, "
            "transit stations, government buildings, warehouses, parking garages",
    "kind": "overture",  # each row carries its own kind (tools/overture_places.py KINDS)
    "url": "tool:places",
    "license": "CDLA-Permissive-2.0, Apache-2.0 or CC0-1.0 per row (Overture Maps places): commercial use allowed, "
               "attribution required (docs.overturemaps.org/attribution, checked 2026-11-04)",
    "attribution": "Overture Maps Foundation (places)",
    "fields": "id, names.primary, taxonomy.primary, addresses[1], phones[1], websites[1], emails[1], brand, confidence",
}
HIGHRISE_SOURCE = "overture_highrises"  # made per area on demand (highrises()), never by refresh
HIGHRISE_ATTRIBUTION = "© OpenStreetMap contributors, Overture Maps Foundation (buildings, ODbL); names from Overture places"
OV_KIND_LABEL = {"mall": "Mall or retail centre", "stadium": "Stadium or arena", "hotel": "Hotel or resort",
                 "venue": "Convention centre, theatre or venue", "casino": "Casino", "airport": "Airport",
                 "transit": "Transit station", "government": "Government building", "warehouse": "Warehouse or distribution",
                 "parking": "Parking garage", "high_rise": "High-rise"}
# lookups that place another source's rows; not prospects themselves
GEO = {
    "edge": {
        "name": "NCES EDGE Public School Geocodes 2024-25",
        "url": "https://nces.ed.gov/programs/edge/data/EDGE_GEOCODE_PUBLICSCH_2425.zip",
        "member": r"\.txt$",
        # the .TXT has no header row (names from the zip's .xlsx, 2024-25)
        "header": ["NCESSCH", "LEAID", "NAME", "OPSTFIPS", "STREET", "CITY", "STATE", "ZIP", "STFIP", "CNTY", "NMCNTY",
                   "LOCALE", "LAT", "LON", "CBSA", "NMCBSA", "CBSATYPE", "CSA", "NMCSA", "CD", "SLDL", "SLDU", "SCHOOLYEAR"],
        "cols": {"key": ["ncessch"], "lat": ["lat", "latitude"], "lon": ["lon", "longitude"]},
        "license": _NCES_TERMS,
    },
    "zcta": {
        "name": "Census Gazetteer ZCTA centroids 2025",
        "url": "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip",
        "member": r"\.txt$",
        "cols": {"key": ["geoid"], "lat": ["intptlat"], "lon": ["intptlong", "intptlon"]},
        "license": "Public domain: U.S. Census Bureau, US government work",
    },
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS prospect(id TEXT PRIMARY KEY, kind TEXT, name TEXT, address TEXT, city TEXT, state TEXT,
    zip TEXT, lat REAL, lon REAL, precision TEXT, phone TEXT, website TEXT, email TEXT, contact_name TEXT,
    contact_title TEXT, size REAL, size_label TEXT, detail TEXT, source TEXT, updated TEXT, run INTEGER);
CREATE INDEX IF NOT EXISTS prospect_ll ON prospect(lat, lon);
CREATE INDEX IF NOT EXISTS prospect_kind ON prospect(kind);
CREATE INDEX IF NOT EXISTS prospect_src ON prospect(source, run);
CREATE TABLE IF NOT EXISTS prospect_geo(kind TEXT, key TEXT, lat REAL, lon REAL, PRIMARY KEY(kind, key)) WITHOUT ROWID;
"""
COLS = ("id", "kind", "name", "address", "city", "state", "zip", "lat", "lon", "precision", "phone", "website", "email",
        "contact_name", "contact_title", "size", "size_label", "detail", "source", "updated")
_INSERT = "INSERT OR REPLACE INTO prospect VALUES(" + ",".join("?" * (len(COLS) + 1)) + ")"


def db_path(data_dir):
    return os.path.join(data_dir, "prospects.db")


def connect(data_dir):
    """WAL so near() reads while refresh() writes; the writer commits every batch, so a reader never waits long."""
    os.makedirs(data_dir, exist_ok=True)
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.executescript(SCHEMA)
    return con


# --- reading the files -------------------------------------------------------------------------------------------

def _latin1(err):
    """A byte that isn't UTF-8 is read as Latin-1, so one stray accent doesn't stop or garble a whole file."""
    bad = err.object[err.start:err.end]
    return bad.decode("latin-1"), err.end


codecs.register_error("rfrecon_latin1", _latin1)


def _norm(h):
    return re.sub(r"[^a-z0-9]", "", (h or "").lower())


class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.lower().startswith("https://"):
            raise urllib.error.HTTPError(newurl, code, "redirect away from https refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_HttpsOnly)


def _download(url, ua=UA, dest=None, timeout=120):
    """The file at url, saved to dest (streamed, so a 30 MB zip is never held in memory); returns dest."""
    if not url.lower().startswith("https://"):
        raise ValueError(f"https only: {url}")
    last = None
    for k in range(3):
        try:
            with _OPENER.open(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=timeout) as r, \
                    open(dest + ".part", "wb") as fh:
                while True:
                    dlstop.check()  # Stop all downloads
                    b = r.read(1 << 20)
                    if not b:
                        break
                    fh.write(b)
            os.replace(dest + ".part", dest)
            return dest
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404, 410):
                raise
            last = e
        except OSError as e:
            last = e
        time.sleep(5 * (k + 1))
    raise last


def _open(got):
    """fetch may return bytes, a file path or a binary file: a binary file comes back."""
    if isinstance(got, (bytes, bytearray)):
        return io.BytesIO(got)
    if isinstance(got, str):
        return open(got, "rb")
    return got


def _rows(fh, member=r"\.(csv|txt)$", header=None):
    """(header, row iterator) for a CSV, pipe- or tab-delimited file, inside a zip or not. With a default header
    (a file shipped without one), the first line is used as the header only if it names the first column."""
    head = fh.read(4)
    fh.seek(0)
    if head[:2] == b"PK":
        z = zipfile.ZipFile(fh)
        names = [n for n in z.namelist() if re.search(member, n, re.I) and not n.endswith("/")]
        if not names:
            raise ValueError(f"no file matching {member} in the zip ({', '.join(z.namelist()[:6])})")
        # IPEDS ships a revised file beside the first (hd2024_rv.csv) when one exists: the revision wins
        names.sort(key=lambda n: (0 if "_rv" in n.lower() else 1, n))
        raw = z.open(names[0])
    else:
        raw = fh
    text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="rfrecon_latin1", newline="")
    first = text.readline()
    delim = max(("|", "\t", ","), key=first.count)
    lines = itertools.chain([first], text)
    reader = csv.reader(lines, delimiter=delim)
    top = next(reader, [])
    if header and _norm(top[0] if top else "") != _norm(header[0]):
        return [_norm(h) for h in header], itertools.chain([top], reader)
    return [_norm(h) for h in top], reader


def _index(header, cols, need=()):
    """Column positions by name, case, spaces and punctuation ignored; each candidate may be a pattern
    (LATITUDE24 becomes LATITUDE26 in the next survey)."""
    out = {}
    for field, cands in cols.items():
        for c in cands:
            hit = next((i for i, h in enumerate(header) if h == c), None)
            if hit is None:
                hit = next((i for i, h in enumerate(header) if re.fullmatch(c, h)), None)
            if hit is not None:
                out[field] = hit
                break
    missing = [f for f in need if f not in out]
    if missing:
        raise ValueError(f"columns not found: {', '.join(missing)} (header starts {', '.join(header[:8])})")
    return out


def _getter(idx):
    def get(row, field):
        i = idx.get(field)
        if i is None or i >= len(row):
            return ""
        v = row[i].strip()
        return "" if v in ("-1", "-2", "M", "N/A", "Not Available") else v
    return get


def _float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _ll(lat, lon):
    lat, lon = _float(lat), _float(lon)
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == 0 and lon == 0):
        return None, None
    return lat, lon


def _phone(p):
    d = re.sub(r"\D", "", p or "")
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    return f"({d[:3]}) {d[3:6]}-{d[6:]}" if len(d) == 10 else (p or "").strip()


def _web(w):
    w = (w or "").strip()
    if not w or " " in w:
        return ""
    return w if re.match(r"https?://", w, re.I) else "http://" + w


def _zip5(z):
    d = re.sub(r"\D", "", (z or "").split("-")[0])
    return d.zfill(5)[:5] if d else ""


def _title(s):
    """CMS and PSS shout their names; title case reads better and searches the same."""
    s = (s or "").strip()
    if s and s.upper() == s:
        s = re.sub(r"[A-Za-z]+('[A-Za-z]+)?", lambda m: m.group(0).capitalize(), s.lower())
        s = re.sub(r"\b(Of|And|The|At|For|In|On)\b", lambda m: m.group(0).lower(), s)
        s = s[:1].upper() + s[1:]
        s = re.sub(r"\b[A-Za-z]{2,4}\b", lambda m: m.group(0).upper() if m.group(0).upper() in _KEEP_UPPER else m.group(0), s)
    return s


_KEEP_UPPER = {"VA", "NY", "NYC", "US", "USA", "UAB", "UCLA", "UNC", "LLC", "YMCA", "ER", "II", "III", "IV", "NE", "NW",
               "SE", "SW", "DC", "UPMC", "MUSC", "HCA", "SSM", "CHI", "OSF", "UT", "MD", "PC"}


# --- each source's columns and row ------------------------------------------------------------------------------

_CCD_OPEN = {"1", "3", "4", "5", "8"}  # open, new, added, changed agency, reopened (2 closed, 6 inactive, 7 future)
_PSS_TYPE = {"1": "Catholic, parochial", "2": "Catholic, diocesan", "3": "Catholic, private",
             "4": "Conservative Christian", "5": "Religious, affiliated", "6": "Religious, unaffiliated",
             "7": "Nonsectarian", "8": "Nonsectarian, special emphasis", "9": "Nonsectarian, special education"}
_PSS_LEVEL = {"1": "Elementary", "2": "Secondary", "3": "Combined"}
_IPEDS_SIZE = {"1": (0, "Under 1,000 students"), "2": (1000, "1,000-4,999 students"), "3": (5000, "5,000-9,999 students"),
               "4": (10000, "10,000-19,999 students"), "5": (20000, "20,000+ students")}
_IPEDS_SECTOR = {"0": "Administrative unit", "1": "Public, 4-year+", "2": "Private nonprofit, 4-year+",
                 "3": "Private for-profit, 4-year+", "4": "Public, 2-year", "5": "Private nonprofit, 2-year",
                 "6": "Private for-profit, 2-year", "7": "Public, under 2-year", "8": "Private nonprofit, under 2-year",
                 "9": "Private for-profit, under 2-year"}

COLMAP = {
    "nces_ccd": ({"id": ["ncessch"], "name": ["schname"], "lea": ["leaname"], "status": ["updatedstatus", "systatus"],
                  "street": ["lstreet1"], "city": ["lcity"], "state": ["lstate"], "zip": ["lzip"],
                  "mstreet": ["mstreet1"], "mcity": ["mcity"], "mstate": ["mstate", "st"], "mzip": ["mzip"],
                  "phone": ["phone"], "website": ["website"], "level": ["level"], "type": ["schtypetext"],
                  "charter": ["chartertext"]}, ("id", "name")),
    "nces_pss": ({"id": ["ppin"], "name": ["pinst"], "street": ["pladd"], "city": ["plcit"], "state": ["plstabb"],
                  "zip": ["plzip"], "mstreet": ["paddrs"], "mcity": ["pcity"], "mstate": ["pstabb"], "mzip": ["pzip"],
                  "phone": ["pphone"], "lat": [r"latitude\d*"], "lon": [r"longitude\d*"], "students": ["numstuds"],
                  "type": ["typology"], "level": ["level"]}, ("id", "name", "lat", "lon")),
    "ipeds": ({"id": ["unitid"], "name": ["instnm"], "street": ["addr"], "city": ["city"], "state": ["stabbr"],
               "zip": ["zip"], "phone": ["gentele"], "website": ["webaddr"], "contact": ["chfnm"], "title": ["chftitle"],
               "lat": ["latitude"], "lon": ["longitud", "longitude"], "size": ["instsize"], "sector": ["sector"],
               "active": ["cyactive"], "closed": ["closedat"]}, ("id", "name", "lat", "lon")),
    "cms_hospitals": ({"id": ["facilityid", "providerid", "ccn"], "name": ["facilityname", "hospitalname"],
                       "street": ["address"], "city": ["citytown", "city"], "state": ["state"], "zip": ["zipcode", "zip"],
                       "phone": ["telephonenumber", "phonenumber"], "type": ["hospitaltype"],
                       "owner": ["hospitalownership"], "er": ["emergencyservices"]}, ("id", "name", "zip")),
    "cms_nursing_homes": ({"id": ["cmscertificationnumberccn", "federalprovidernumber", "ccn"], "name": ["providername"],
                           "street": ["provideraddress"], "city": ["citytown", "providercity"], "state": ["state", "providerstate"],
                           "zip": ["zipcode", "providerzipcode"], "phone": ["telephonenumber", "providerphonenumber"],
                           "beds": ["numberofcertifiedbeds"], "owner": ["ownershiptype"], "chain": ["chainname"],
                           "inhosp": ["providerresidesinhospital"], "sprinkler": ["automaticsprinklersystemsinallrequiredareas"],
                           "lat": ["latitude"], "lon": ["longitude"]}, ("id", "name", "lat", "lon")),
}


def _row_ccd(get, r):
    if get(r, "status") and get(r, "status") not in _CCD_OPEN:
        return None
    street = get(r, "street") or get(r, "mstreet")
    detail = "; ".join(x for x in (get(r, "lea") and f"District: {get(r, 'lea')}",
                                   get(r, "level") and f"{get(r, 'level')} school", get(r, "type"),
                                   get(r, "charter") == "Yes" and "Charter") if x)
    return dict(name=get(r, "name"), address=street, city=get(r, "city") or get(r, "mcity"),
                state=get(r, "state") or get(r, "mstate"), zip=_zip5(get(r, "zip") or get(r, "mzip")),
                phone=_phone(get(r, "phone")), website=_web(get(r, "website")), detail=detail)


def _row_pss(get, r):
    lat, lon = _ll(get(r, "lat"), get(r, "lon"))
    n = _float(get(r, "students"))
    phys = bool(get(r, "street"))
    return dict(name=_title(get(r, "name")), address=get(r, "street") or get(r, "mstreet"),
                city=_title(get(r, "city") if phys else get(r, "mcity")), state=(get(r, "state") if phys else get(r, "mstate")),
                zip=_zip5(get(r, "zip") if phys else get(r, "mzip")), lat=lat, lon=lon, precision="exact" if lat is not None else "",
                phone=_phone(get(r, "phone")), size=n, size_label=f"{int(n):,} students" if n else "",
                detail="; ".join(x for x in (_PSS_TYPE.get(get(r, "type"), ""), _PSS_LEVEL.get(get(r, "level"), "")) if x))


def _row_ipeds(get, r):
    if get(r, "active") not in ("", "1") or get(r, "closed"):
        return None
    lat, lon = _ll(get(r, "lat"), get(r, "lon"))
    size, label = _IPEDS_SIZE.get(get(r, "size"), (None, ""))
    return dict(name=get(r, "name"), address=get(r, "street"), city=get(r, "city"), state=get(r, "state"),
                zip=_zip5(get(r, "zip")), lat=lat, lon=lon, precision="exact" if lat is not None else "",
                phone=_phone(get(r, "phone")), website=_web(get(r, "website")), contact_name=get(r, "contact"),
                contact_title=get(r, "title"), size=size, size_label=label, detail=_IPEDS_SECTOR.get(get(r, "sector"), ""))


def _row_cms(get, r):
    er = get(r, "er")
    return dict(name=_title(get(r, "name")), address=get(r, "street"), city=_title(get(r, "city")),
                state=get(r, "state"), zip=_zip5(get(r, "zip")), phone=_phone(get(r, "phone")),
                detail="; ".join(x for x in (get(r, "type"), get(r, "owner"), er and f"Emergency services: {er}") if x))


def _row_nh(get, r):
    lat, lon = _ll(get(r, "lat"), get(r, "lon"))
    beds = _float(get(r, "beds"))
    sp = get(r, "sprinkler")
    detail = "; ".join(x for x in (get(r, "owner"), get(r, "chain") and f"Chain: {_title(get(r, 'chain'))}",
                                   get(r, "inhosp") == "Y" and "Inside a hospital",
                                   sp and f"Automatic sprinklers in all required areas: {sp}") if x)
    return dict(name=_title(get(r, "name")), address=get(r, "street"), city=_title(get(r, "city")), state=get(r, "state"),
                zip=_zip5(get(r, "zip")), lat=lat, lon=lon, precision="exact" if lat is not None else "",
                phone=_phone(get(r, "phone")), size=beds, size_label=f"{int(beds):,} certified beds" if beds else "", detail=detail)


def _row_overture(get, r):
    kind = get(r, "kind")
    if kind not in OV_KIND_LABEL:
        return None
    lat, lon = _ll(get(r, "lat"), get(r, "lon"))
    h, fl = _float(get(r, "h")), _float(get(r, "fl"))
    size = " · ".join(x for x in (h and f"{round(h * 3.281):,} ft", fl and f"{int(fl)} floors") if x)
    cat = (get(r, "cat") or "").replace("_", " ")
    tenant, name, email = (get(r, "tenant") or "").strip(), get(r, "name"), (get(r, "email") or "").strip()
    other = kind == "high_rise" and tenant and (not get(r, "bname") or _flat(tenant) != _flat(name))
    if other:  # the contact is a business inside the building, not its owner or manager: no email to it
        email = ""
    detail = "; ".join(x for x in (cat and cat[:1].upper() + cat[1:], get(r, "brand") and f"Brand: {get(r, 'brand')}",
                                   kind == "high_rise" and not get(r, "bname") and not other and "named by a business inside it",
                                   other and (f"named by {tenant}, a business inside: the phone and website are theirs" if not get(r, "bname")
                                              else f"phone and website are {tenant}'s, a business inside")) if x)
    return dict(kind=kind, name=name, address=get(r, "street"), city=get(r, "city"), state=(get(r, "state") or "")[:2].upper(),
                zip=_zip5(get(r, "zip")), lat=lat, lon=lon, precision="exact" if lat is not None else "",
                phone=_phone(get(r, "phone")), website=_web(get(r, "website")), email=email,
                size=h or fl, size_label=size, detail=detail)


def _flat(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


COLMAP["overture_places"] = ({"id": ["id"], "kind": ["kind"], "cat": ["category"], "name": ["name"], "street": ["address"],
                              "city": ["city"], "state": ["state"], "zip": ["zip"], "lat": ["lat"], "lon": ["lon"],
                              "phone": ["phone"], "website": ["website"], "email": ["email"], "brand": ["brand"],
                                   "h": ["heightm"], "fl": ["floors"], "bname": ["buildingname"], "tenant": ["tenant"]}, ("id", "kind", "name", "lat", "lon"))
COLMAP[HIGHRISE_SOURCE] = COLMAP["overture_places"]
ROWS = {"nces_ccd": _row_ccd, "nces_pss": _row_pss, "ipeds": _row_ipeds, "cms_hospitals": _row_cms,
        "cms_nursing_homes": _row_nh, "overture_places": _row_overture, HIGHRISE_SOURCE: _row_overture}


# --- refresh ----------------------------------------------------------------------------------------------------

def tools_python():
    """The Python that has DuckDB (Overture's GeoParquet needs it; the app itself is standard library only):
    RF_RECON_TOOLS_PY, else venv-tools beside the app folder."""
    if os.environ.get("RF_RECON_TOOLS_PY"):
        return os.environ["RF_RECON_TOOLS_PY"]
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for p in (os.path.join(base, "venv-tools", "Scripts", "python.exe"), os.path.join(base, "venv-tools", "bin", "python")):
        if os.path.exists(p):
            return p
    return None


def run_tool(args, out_csv, timeout=3600, log=print):
    """tools/overture_places.py in the tools Python, writing out_csv. Raises with the tool's last words on failure."""
    import subprocess
    py = tools_python()
    if not py:
        raise RuntimeError("Overture needs DuckDB in the tools Python (venv-tools): python -m venv venv-tools, then "
                           "venv-tools pip install duckdb")
    tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools", "overture_places.py")
    p = subprocess.run([py, "-I", tool, *args[:1], out_csv, *args[1:]], capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    tail = (p.stdout or "").strip().splitlines()[-1:] + (p.stderr or "").strip().splitlines()[-2:]
    if p.returncode or not os.path.exists(out_csv):
        raise RuntimeError("Overture extract failed: " + " | ".join(tail)[-300:])
    log(" ".join(tail[:1]))
    return out_csv


def _default_fetch(data_dir):
    folder = os.path.join(data_dir, "prospects_dl")
    os.makedirs(folder, exist_ok=True)

    def fetch(url, ua=UA):
        if url.startswith("tool:"):  # Overture: the tools Python writes the CSV (removed once read, like a download)
            return run_tool([url[5:]], os.path.join(folder, f"overture_{url[5:]}.csv"))
        name = re.sub(r"[^A-Za-z0-9._-]", "_", url.rsplit("/", 1)[-1])[-80:] or "file"
        return _download(url, ua, os.path.join(folder, name))
    return fetch


def _close(fh, got):
    try:
        fh.close()
    finally:
        if isinstance(got, str) and os.path.dirname(os.path.abspath(got)).endswith("prospects_dl"):
            try:
                os.remove(got)
            except OSError:
                pass


def _cms_url(fetch, src, log):
    """The current CSV from CMS's metastore; the last known one if the metastore can't be read."""
    got = None
    try:
        got = fetch(src["meta"], src.get("ua", UA))
        fh = _open(got)
        try:
            url = json.load(io.TextIOWrapper(fh, encoding="utf-8-sig"))["distribution"][0]["downloadURL"]
        finally:
            _close(fh, got)
        if url.lower().startswith("https://"):
            return url
    except Exception as e:
        log(f"{src.get('kind', 'cms')}: metastore not read ({e}); using the last known file")
    return src["url"]


def load_geo(con, kind, fetch, log=print):
    """A coordinate lookup (EDGE school geocodes or ZIP centroids) into prospect_geo, replacing that kind."""
    g = GEO[kind]
    got = fetch(g["url"], g.get("ua", UA))
    fh = _open(got)
    n = 0
    try:
        header, rows = _rows(fh, g.get("member", r"\.(csv|txt)$"), g.get("header"))
        idx = _index(header, g["cols"], ("key", "lat", "lon"))
        con.execute("DELETE FROM prospect_geo WHERE kind=?", (kind,))
        batch = []
        for r in rows:
            try:
                key, lat, lon = r[idx["key"]].strip(), *_ll(r[idx["lat"]], r[idx["lon"]])
            except IndexError:
                continue
            if key and lat is not None:
                batch.append((kind, key, lat, lon))
            if len(batch) >= BATCH:
                con.executemany("INSERT OR REPLACE INTO prospect_geo VALUES(?,?,?,?)", batch)
                n += len(batch)
                batch = []
        con.executemany("INSERT OR REPLACE INTO prospect_geo VALUES(?,?,?,?)", batch)
        n += len(batch)
        con.commit()
    finally:
        _close(fh, got)
    if not n:
        raise ValueError(f"{kind}: no coordinates read")
    log(f"{kind}: {n:,} coordinates")
    return n


def _place(con, sid, src, rec, key):
    """lat/lon for a row without its own: the EDGE geocode (exact) or the ZIP centroid (zip)."""
    if rec.get("lat") is not None:
        return
    if src.get("geo") == "edge":
        hit = con.execute("SELECT lat, lon FROM prospect_geo WHERE kind='edge' AND key=?", (key,)).fetchone()
        if hit:
            rec["lat"], rec["lon"], rec["precision"] = hit[0], hit[1], "exact"
            return
    if rec.get("zip"):
        hit = con.execute("SELECT lat, lon FROM prospect_geo WHERE kind='zcta' AND key=?", (rec["zip"],)).fetchone()
        if hit:
            rec["lat"], rec["lon"], rec["precision"] = hit[0], hit[1], "zip"


def load_source(con, sid, fetch, log=print, run=None):
    return _load_rows(con, sid, fetch, log, run)


def _load_rows(con, sid, fetch, log=print, run=None, prune=True):
    """One source's rows upserted in batches of 5,000 (each its own short transaction), then the source's rows not
    seen this run deleted. Returns the rows kept. A file that yields no rows raises instead of emptying the list."""
    src = SOURCES[sid]
    run = run or time.time_ns()
    updated = time.strftime("%Y-%m-%d %H:%M")
    url = _cms_url(fetch, src, log) if src.get("meta") else src["url"]
    got = fetch(url, src.get("ua", UA))
    fh = _open(got)
    cols, need = COLMAP[sid]
    make = ROWS[sid]
    n = unplaced = 0
    try:
        header, rows = _rows(fh)
        get = _getter(_index(header, cols, need))
        batch = []
        for r in rows:
            if not r or not any(r):
                continue
            key = get(r, "id")
            rec = make(get, r) if key else None
            if not rec or not rec.get("name"):
                continue
            rec.update(id=f"{sid}:{key}", kind=rec.get("kind") or src["kind"], source=sid, updated=updated)
            _place(con, sid, src, rec, key)
            if rec.get("lat") is None:
                unplaced += 1
            batch.append(tuple(rec.get(c, "" if c not in ("lat", "lon", "size") else None) for c in COLS) + (run,))
            n += 1
            if len(batch) >= BATCH:
                con.executemany(_INSERT, batch)
                con.commit()
                batch = []
            if n % PROGRESS == 0:
                log(f"{sid}: {n:,} rows")
        con.executemany(_INSERT, batch)
        con.commit()
    finally:
        _close(fh, got)
    if not n:
        raise ValueError(f"{sid}: no rows read; kept the last list")
    gone = con.execute("DELETE FROM prospect WHERE source=? AND run<>?", (sid, run)).rowcount if prune else 0
    con.commit()
    log(f"{sid}: {n:,} rows ({unplaced:,} with no location; {gone:,} gone since the last run)")
    return n


def refresh(data_dir, sources=None, log=print, fetch=None):
    """fetch(url, user_agent) returns bytes, a file path or a binary file (default: urllib, https only, saved to
    data/prospects_dl and removed once read). Download and load each source (all of SOURCES by default). Returns {source: rows loaded}; a source that failed
    keeps its last rows, counts 0 and is named with its error under "errors". One failing never stops the rest."""
    fetch = fetch or _default_fetch(data_dir)
    todo = [s for s in (sources or list(SOURCES)) if s in SOURCES and not SOURCES[s].get("area")]
    out, errors = {}, {}
    con = connect(data_dir)
    try:
        geo_err = {}
        for g in sorted({SOURCES[s]["geo"] for s in todo if SOURCES[s].get("geo")}):
            try:
                load_geo(con, g, fetch, log)
            except Exception as e:
                con.rollback()
                geo_err[g] = f"{GEO[g]['name']}: {e}"
                log(f"{g}: {e}")
        for sid in todo:
            g = SOURCES[sid].get("geo")
            have = g and con.execute("SELECT 1 FROM prospect_geo WHERE kind=? LIMIT 1", (g,)).fetchone()
            if g in geo_err and not have:  # no coordinates at all: the rows would be unplaceable
                out[sid], errors[sid] = 0, geo_err[g]
                continue
            try:
                out[sid] = load_source(con, sid, fetch, log)
            except Exception as e:
                con.rollback()
                out[sid], errors[sid] = 0, f"{type(e).__name__}: {e}"
                log(f"{sid} failed: {e}")
    finally:
        con.close()
    if errors:
        out["errors"] = errors
    return out


# --- reading ----------------------------------------------------------------------------------------------------

def _hav(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(a)))


def near(data_dir, lat, lon, radius_mi=10, kinds=None, q="", limit=500):
    """Prospects within radius_mi of a spot, nearest first, each with dist_mi. kinds: a list or comma string of
    school_k12, school_private, college, hospital, nursing_home and the Overture kinds; q: text in the name or city. Hospitals sit at their ZIP's centre
    (precision 'zip'), so their distance is approximate."""
    if not os.path.exists(db_path(data_dir)):
        return []
    lat, lon, radius_mi = float(lat), float(lon), max(0.0, float(radius_mi))
    dlat = radius_mi / 69.0
    dlon = radius_mi / (69.0 * max(0.01, math.cos(math.radians(lat))))
    sql = "SELECT " + ",".join(COLS) + " FROM prospect WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?"
    args = [lat - dlat, lat + dlat, lon - dlon, lon + dlon]
    if isinstance(kinds, str):
        kinds = [k for k in kinds.split(",") if k.strip()]
    if kinds:
        sql += " AND kind IN (" + ",".join("?" * len(kinds)) + ")"
        args += [k.strip() for k in kinds]
    q = (q or "").strip()
    if q:
        sql += " AND (name LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\')"
        like = "%" + re.sub(r"([%_\\])", r"\\\1", q) + "%"
        args += [like, like]
    con = sqlite3.connect(db_path(data_dir), timeout=30)  # reads only (mode=ro fails on WAL once -shm is gone)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        out = []
        for r in con.execute(sql, args):
            d = _hav(lat, lon, r[7], r[8])
            if d <= radius_mi:
                rec = dict(zip(COLS, r))
                rec["dist_mi"] = round(d, 2)
                out.append(rec)
    except sqlite3.OperationalError:  # the table isn't made yet (first refresh still starting)
        return []
    finally:
        con.close()
    out.sort(key=lambda x: x["dist_mi"])
    return _merge_highrises(out)[:max(0, int(limit))]


def _merge_highrises(rows):
    """A place (hotel, mall, venue...) inside a high-rise, same name within about 100 m, is one building: the
    high-rise row keeps its height and priority and takes the place's own phone, website, email and kind."""
    tall = [r for r in rows if r["kind"] == "high_rise"]
    if not tall:
        return rows
    drop = set()
    for t in tall:
        ft = _flat(t["name"])
        for r in rows:
            if r is t or r["kind"] == "high_rise" or r["id"] in drop or r["lat"] is None:
                continue
            fr = _flat(r["name"])
            if fr and (fr == ft or (len(fr) > 6 and (fr in ft or ft in fr))) and _hav(t["lat"], t["lon"], r["lat"], r["lon"]) < 0.065:
                drop.add(r["id"])
                for k in ("phone", "website", "email", "address", "city", "zip"):
                    if r.get(k):
                        t[k] = r[k]
                label = OV_KIND_LABEL.get(r["kind"]) or {"school_k12": "School", "school_private": "School", "college": "College",
                                                         "hospital": "Hospital", "nursing_home": "Nursing home"}.get(r["kind"], r["kind"])
                t["detail"] = "; ".join(x for x in (f"Also a {label.lower()}: {r['name']}", re.sub(r"; ?phone and website are .*$", "", t.get("detail") or "")) if x)
                t["also"] = r["id"]
    return [r for r in rows if r["id"] not in drop]


def get(data_dir, pid):
    """One prospect by id, or None. 'permit:<dataset>:<permit id>' is a new building from the permit data (permits.py)."""
    if (pid or "").startswith("permit:"):
        import permits
        return permits.as_prospect(data_dir, pid)
    if not os.path.exists(db_path(data_dir)):
        return None
    con = sqlite3.connect(db_path(data_dir), timeout=30)
    try:
        r = con.execute("SELECT " + ",".join(COLS) + " FROM prospect WHERE id=?", (pid,)).fetchone()
        return dict(zip(COLS, r)) if r else None
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()


def highrises(data_dir, lat, lon, radius_mi=3, log=print, fetch_csv=None):
    """Buildings 75 ft or 7 floors and up within radius_mi (at most 10) from Overture buildings, each named by its own
    name or the most confident business inside it, into the prospect list (replacing this source's rows in that box).
    fetch_csv(box) -> a CSV path (tests); default: the tools Python. Returns the rows kept."""
    radius_mi = min(10.0, max(0.25, float(radius_mi)))
    dlat = radius_mi / 69.0
    dlon = radius_mi / (69.0 * max(0.01, math.cos(math.radians(lat))))
    box = (lon - dlon, lat - dlat, lon + dlon, lat + dlat)
    if fetch_csv:
        path = fetch_csv(box)
    else:
        folder = os.path.join(data_dir, "prospects_dl")
        os.makedirs(folder, exist_ok=True)
        path = run_tool(["highrises", "--bbox=" + ",".join(f"{v:.5f}" for v in box)],
                        os.path.join(folder, f"overture_highrises_{time.time_ns()}.csv"), timeout=900, log=log)
    con = connect(data_dir)
    try:
        con.execute("DELETE FROM prospect WHERE source=? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                    (HIGHRISE_SOURCE, box[1], box[3], box[0], box[2]))
        con.commit()
        run = time.time_ns()
        got = path

        def fetch(url, ua=UA):
            return got
        SOURCES.setdefault(HIGHRISE_SOURCE, {"name": "Overture Maps buildings 75 ft or 7 floors and up (per area)",
                                             "kind": "high_rise", "url": "tool:highrises", "license": "ODbL",
                                             "attribution": HIGHRISE_ATTRIBUTION, "area": True})
        try:
            n = _load_rows(con, HIGHRISE_SOURCE, fetch, log, run, prune=False)
        except ValueError:  # none that tall here
            n = 0
    finally:
        con.close()
    return n


def db_stamp(path):
    """What changes when a WAL database is written: the file's and its -wal's time and size."""
    out = []
    for p in (path, path + "-wal"):
        try:
            s = os.stat(p)
            out.append((s.st_mtime_ns, s.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


_COUNTS = {}  # path -> (stamp, counts): counting the whole list cost ~0.4 s a Prospects request, and it changes only on an update (11/7)


def counts(data_dir):
    """{kind: rows, "updated": the newest refresh time}; empty kinds are left out."""
    path = db_path(data_dir)
    if not os.path.exists(path):
        return {"updated": None}
    stamp = db_stamp(path)
    hit = _COUNTS.get(path)
    if hit and hit[0] == stamp:
        return dict(hit[1])
    con = sqlite3.connect(path, timeout=30)
    try:
        out = {k: n for k, n in con.execute("SELECT kind, COUNT(*) FROM prospect GROUP BY kind")}
        out["updated"] = con.execute("SELECT MAX(updated) FROM prospect").fetchone()[0]
        _COUNTS[path] = (stamp, dict(out))
        return out
    except sqlite3.OperationalError:
        return {"updated": None}
    finally:
        con.close()


# --- permits (permits.py): the trigger per building, and new buildings not in the lists yet ----------------------------

UNDER_CONSTRUCTION = "under_construction"
UC_WHY = ("A new building under construction or just finished: radio coverage has to be shown before it is occupied (IFC 510.1 and "
          "510.5.4; local rules in permit_sources.json), and an ERCES is cheapest to put in before the walls close.")
UC_APPROACH = "GC, developer or electrician on the permit"


def with_permits(data_dir, rows, lat, lon, radius_mi, kinds=None, settings=None, states=None):
    """rows (near()) with each one's permit trigger, plus the new buildings no list has yet (kind under_construction) when
    that kind is asked for (or no kinds were named). Only the permit datasets switched on are read."""
    import permits
    only = permits.enabled(settings, states)
    if isinstance(kinds, str):
        kinds = [k for k in kinds.split(",") if k.strip()]
    want_new = not kinds or UNDER_CONSTRUCTION in kinds
    try:
        rows, extra = permits.attach(data_dir, rows, lat, lon, radius_mi, only, extra=want_new)
    except sqlite3.Error:
        return rows
    return rows + extra


def permit_finish(rows):
    """After das.with_pipeline: a building under construction is a high-priority prospect with its own reason and contact;
    the list keeps the pipeline's order (do not contact last, then priority, then distance)."""
    for r in rows:
        if r.get("kind") == UNDER_CONSTRUCTION:
            r.update(priority="high", why=UC_WHY, approach=UC_APPROACH)
    rank = {"high": 0, "medium": 1, "low": 2, "": 3}
    return sorted(rows, key=lambda x: (x.get("status") == "do not contact", rank.get(x.get("priority") or "", 3), x.get("dist_mi") or 0))


def permit_counts(data_dir, settings=None, states=None):
    """{under_construction: new-building permits kept, permits: all kept} for the datasets switched on."""
    import permits
    c = permits.counts(data_dir, permits.enabled(settings, states))
    return {UNDER_CONSTRUCTION: c.get("new_building", 0), "permits": sum(c.values())}
