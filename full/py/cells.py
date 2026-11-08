"""
Cell sites: the crowd-shared and surveyed cells around a place (OpenCelliD, WiGLE, your own captures), decoded and
grouped into sites, with the public FCC record of the tower each site most likely sits on.

Each cell gets its global cell identity: MCC-MNC (the operator) plus the cell ID, split into the site and the sector
(LTE: eNB = ECI / 256, sector = ECI % 256; 5G NR: gNB with the common 24-bit split, which varies by operator;
UMTS: RNC = CI / 65536). A site's cells are matched to the nearest registered antenna structure (FCC ASR) within
1 km of their average position, and that tower's owner, height and the FCC licensees on it come along. A sector's
direction is estimated as the bearing from the tower to the cell's crowd position (its samples lean toward the area
the sector serves): an estimate, not a record.

OpenCelliD also publishes whole-country downloads (opencellid.org/downloads.php, free with an account); import_ocid
loads one (CSV or .csv.gz) for the states set in Data & updates.
"""
import csv
import gzip
import io
import itertools
import json
import math
import os
import re
import time
import urllib.request

import build
import cellspec
import dlstop  # Stop all downloads
import connectors
import geo
import sigid

OPERATORS = {}
for _name, _codes in {
    "AT&T": "310-030 310-070 310-150 310-170 310-280 310-380 310-410 310-560 310-680 310-950 311-180",
    "FirstNet (AT&T)": "313-100",
    "T-Mobile": "310-160 310-200 310-210 310-220 310-230 310-240 310-250 310-260 310-270 310-310 310-490 310-660 310-800",
    "T-Mobile (ex-Sprint)": "310-120 311-490 311-870 311-880 312-530",
    "Verizon": "310-004 310-010 310-012 310-013 311-110 311-390 " + " ".join(f"311-{n}" for n in list(range(270, 290)) + list(range(480, 490))),
    # 311-220, 311-229 and 310-730 are U.S. Cellular's in the US IMSI administrator's register (imsiadmin.com, HNI pages;
    # 311-220 and 310-730 returned 3/23/2023), and crowd readings still carry 311-220: Wilmington showed "MCC 311 MNC 220" (11/7)
    "UScellular": "310-730 311-220 311-229 311-580",
    "Dish / Boost": "313-340",
}.items():
    for _c in _codes.split():
        OPERATORS[_c] = _name
CELL_KINDS = {"LTE", "NR", "GSM", "UMTS", "WCDMA", "CDMA"}
_ID = re.compile(r"(\d{3})[-_]?(\d{2,3})[-_](\d+)[-_](\d+)")


# every other US code, from the US IMSI administrator's list (static/research/hni.json, tools/build_hni.py; Cody 11/7: 310-350 showed
# as "MCC 310 MNC 350", it's Verizon's). The big holders read as the brands above, so their licensed bands attach; a regional
# carrier reads by its own name; a US code on no one's list says so (crowd readings carry a few, likely misread)
def _load_register():
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "hni.json"), encoding="utf-8") as f:
            return json.load(f).get("names") or {}
    except (OSError, ValueError):
        return {}  # a copy without the list (the web version's engine) names as before


REGISTER = _load_register()
_BRANDS = [(r"^Verizon Wireless", "Verizon"), (r"^AT&T Mobility", "AT&T"), (r"^T-Mobile", "T-Mobile"), (r"sprint|clearwire", "T-Mobile (ex-Sprint)"),
           (r"^U\.?\s?S\.? Cellular", "UScellular"), (r"^Dish Network", "Dish / Boost"), (r"First Responder Network", "FirstNet (AT&T)"),
           (r"^Reserved for Public Safety", "Reserved for public safety"), (r"^TEST IMSI", "Test network code")]


def register_name(entity):
    """The register's holder as DAStastic names it: the brand for the big carriers, else the trading name, tidied."""
    for pat, brand in _BRANDS:
        if re.search(pat, entity or "", re.I):
            return brand
    name = re.split(r"\s+d/?b/?a\s+", entity or "", flags=re.I)[-1]
    return re.sub(r"[,.]?\s+(LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.|Limited Partnership|LP|L\.P\.)\.?$", "", name.strip(), flags=re.I) or entity


def operator(mcc, mnc):
    key = f"{mcc}-{int(mnc):03d}" if str(mnc).isdigit() else f"{mcc}-{mnc}"
    if key in OPERATORS:
        return OPERATORS[key]
    if key in REGISTER:
        return register_name(REGISTER[key])
    if REGISTER and str(mcc) in ("310", "311", "312", "313", "314", "315", "316"):
        return f"MCC {mcc} MNC {mnc} (not in the US register)"
    return f"MCC {mcc} MNC {mnc}" if mcc else "Unknown operator"


def parse_id(ident):
    """'310-410-12345-6789012' (OpenCelliD), '310410_12345_6789012' (WiGLE) -> (mcc, mnc, area, cid) or None."""
    m = _ID.search(str(ident or ""))
    return (m.group(1), m.group(2), int(m.group(3)), int(m.group(4))) if m else None


def decode(radio, mcc, mnc, area, cid):
    """Global cell identity and the site / sector split for one cell."""
    radio = (radio or "").upper().replace("WCDMA", "UMTS")
    plmn = f"{mcc}-{int(mnc):03d}" if str(mnc).isdigit() else f"{mcc}-{mnc}"
    d = {"radio": radio or "?", "mcc": mcc, "mnc": mnc, "plmn": plmn, "operator": operator(mcc, mnc), "area": area, "cid": cid}
    if radio == "LTE":
        d.update(gci=f"{plmn}-{cid}", gci_name="ECGI", site_id=cid >> 8, sector=cid & 0xFF, site_kind="eNB", area_kind="TAC")
    elif radio == "NR":
        d.update(gci=f"{plmn}-{cid}", gci_name="NCGI", site_id=cid >> 12, sector=cid & 0xFFF, site_kind="gNB (24-bit split)", area_kind="TAC")
    elif radio == "UMTS":
        d.update(gci=f"{plmn}-{area}-{cid}", gci_name="CGI", site_id=cid >> 16, sector=cid & 0xFFFF, site_kind="RNC", area_kind="LAC")
    else:
        d.update(gci=f"{plmn}-{area}-{cid}", gci_name="CGI", site_id=f"{area}-{cid}", sector=None, site_kind="cell", area_kind="LAC")
    return d


def crowd_sources():
    """The crowd cell sources this person may see: OpenCelliD always, WiGLE in the personal build for the owner only."""
    return [s for s in ("opencellid", "wigle") if build.allowed(s)]


def gather(con, crowd, lat, lon, radius_mi, mission=None):
    """Every cell around a point from the crowd sources and your captures, decoded."""
    s, n, w, e = geo.bbox(lat, lon, radius_mi)
    cells = {}

    def add(src, radio, ident, la, lo, extra):
        p = parse_id(ident)
        if not p or la is None:
            return
        d = decode(radio, *p)
        c = cells.setdefault(d["gci"], dict(d, lat=la, lon=lo, sources=[], samples=0, range_m=None, dbm=None, first=None, last=None,
                                            channel=None, pci=None, points=0, _lat=0.0, _lon=0.0))
        if src not in c["sources"]:
            c["sources"].append(src)
        c["points"] += 1
        c["_lat"] += la
        c["_lon"] += lo
        c["lat"], c["lon"] = c["_lat"] / c["points"], c["_lon"] / c["points"]
        for k in ("samples",):
            if extra.get(k):
                c[k] += int(extra[k])
        for k in ("range_m", "dbm", "channel", "pci"):
            if extra.get(k) not in (None, ""):
                c[k] = extra[k]
        for k, better in (("first", min), ("last", max)):
            if extra.get(k):
                c[k] = better(c[k], extra[k]) if c[k] else extra[k]

    srcs = crowd_sources()  # WiGLE is personal-only (build.py): team logins and the sold build never see its cells
    for r in crowd.execute(f"SELECT * FROM ext_point WHERE source IN ({','.join('?' * len(srcs))}) AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                           (*srcs, s, n, w, e)):
        try:
            det = json.loads(r["details"] or "{}")
        except ValueError:
            det = {}
        radio = (r["kind"] or r["mode"] or det.get("radio") or det.get("gentype") or "").upper()
        if radio not in CELL_KINDS:
            continue
        ts = lambda v: time.strftime("%Y-%m-%d", time.gmtime(int(v))) if str(v or "").isdigit() else (str(v)[:10] if v else None)
        add("OpenCelliD" if r["source"] == "opencellid" else "WiGLE", radio, r["ext_id"], r["lat"], r["lon"],
            {"samples": det.get("samples"), "range_m": det.get("range"), "dbm": r["dbm"], "channel": det.get("channel"), "pci": heard_code(det),
             "first": ts(det.get("created") or det.get("firsttime") or r["first_seen"]), "last": ts(det.get("updated") or det.get("lasttime") or r["last_seen"])})
    q = ("SELECT p.*, c.name AS capture_name FROM capture_point p JOIN capture c ON c.id=p.capture_id WHERE p.lat BETWEEN ? AND ? "
         "AND p.lon BETWEEN ? AND ? AND UPPER(p.kind) IN ('LTE','NR','GSM','UMTS','WCDMA','CDMA')")
    args = [s, n, w, e]
    if mission is not None:
        q += " AND p.mission_id=?"
        args.append(mission)
    for r in con.execute(q, args):
        add(f"Survey: {r['capture_name']}", r["kind"], r["ident"], r["lat"], r["lon"],
            {"dbm": r["dbm"], "channel": r["channel"], "samples": 1, "first": (r["ts"] or "")[:10] or None, "last": (r["ts"] or "")[:10] or None})
    lim = radius_mi * geo.MI_KM
    out = []
    for c in cells.values():
        for k in ("_lat", "_lon"):
            c.pop(k)
        c["dist_mi"] = round(geo.haversine_km(lat, lon, c["lat"], c["lon"]) / geo.MI_KM, 2)
        if c["dist_mi"] * geo.MI_KM <= lim:
            out.append(c)
    return out


def heard_code(det):
    """The physical cell code the crowd heard: an LTE / NR PCI, a UMTS scrambling code (PSC), as OpenCelliD sends it. -1 or blank: not heard."""
    for k in ("pci", "psc", "unit"):
        v = det.get(k)
        try:
            v = int(v)
        except (TypeError, ValueError):
            continue
        if 0 <= v <= 1007:
            return v
    return None


def fcc_cellular(con, lat, lon, reg=None):
    """The FCC's 800 MHz cellular licence at this site (uls:cell): who holds it, the frequencies each way, the power and the antenna, as filed.
    On the matched tower, or within 150 m of the site when it has none. [] when nothing's filed there or the source isn't loaded."""
    try:
        if reg:
            rows = con.execute("SELECT * FROM tx WHERE service='CL' AND status='A' AND tower_reg=?", (reg,)).fetchall()
        else:
            d = 0.0015  # about 150 m
            dl = d / max(.2, math.cos(math.radians(lat)))
            rows = con.execute("SELECT * FROM tx WHERE service='CL' AND status='A' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                               (lat - d, lat + d, lon - dl, lon + dl)).fetchall()
    except Exception:  # no licence table on this copy
        return []
    out = {}
    for r in rows:
        r = dict(r)
        x = out.setdefault((r["call_sign"], r["loc_num"]), {"call_sign": r["call_sign"], "licensee": r["licensee"], "location": r["loc_num"],
                                                             "dl": [], "ul": [], "erp_w": None, "haat_m": None, "height_m": None, "azimuth": [],
                                                             "address": ", ".join(x for x in (r["address"], r["city"], r["state"]) if x)})
        lo, hi = r["freq_mhz"], r["freq_upper_mhz"] or r["freq_mhz"]
        way = x["dl"] if lo >= 869 else x["ul"]  # the tower sends on 869-894 MHz and hears on 824-849
        if [lo, hi] not in way:
            way.append([lo, hi])
        for k, v in (("erp_w", r["erp_w"]), ("haat_m", r["haat_m"]), ("height_m", r["height_tip_m"])):
            if v is not None and (x[k] is None or v > x[k]):
                x[k] = v
        if r["azimuth"] is not None and r["azimuth"] not in x["azimuth"]:
            x["azimuth"].append(r["azimuth"])
    for x in out.values():
        x["dl"].sort()
        x["ul"].sort()
        x["block"] = "A" if any(s[0] < 880 for s in x["dl"]) else "B" if x["dl"] else ""
    return sorted(out.values(), key=lambda x: (x["call_sign"], x["location"]))


def _band_order(b):
    m = re.match(r"([A-Za-z ]*?)\s*(\d+)", str(b))
    return (m.group(1), int(m.group(2))) if m else (str(b), 0)


def bands_of(site):
    """The 3GPP bands a site's carrier is licensed for here, for the site's kind: B12, B66, n71..."""
    return sorted({c["band"] for b in site.get("licensed") or [] for c in b["channels"]}, key=_band_order)


def by_tower(sites):
    """Every carrier's sites on each FCC tower, together: a tower carrying three carriers reads as one tower with all its cells and bands."""
    towers = {}
    for s in sites:
        t = s.get("tower") or {}
        if not t.get("reg"):
            continue
        x = towers.setdefault(t["reg"], {"reg": t["reg"], "owner": t.get("owner"), "lat": t.get("lat"), "lon": t.get("lon"), "height_m": t.get("overall_agl_m"),
                                         "structure": t.get("struct_type"), "address": ", ".join(v for v in (t.get("street"), t.get("city"), t.get("state")) if v),
                                         "dist_mi": s.get("dist_mi"), "licensees": t.get("licensees") or [], "fcc_cellular": s.get("fcc_cellular") or [], "sites": []})
        x["sites"].append({"key": s.get("key"), "operator": s.get("operator") or "", "radio": s.get("radio"), "site_kind": s.get("site_kind") or "", "site_id": s.get("site_id"),
                           "bands": bands_of(s), "samples": s.get("samples"), "last": s.get("last"),
                           "cells": [{"gci": c.get("gci"), "sector": c.get("sector"), "pci": c.get("pci"), "az_est": c.get("az_est")} for c in s.get("cells") or []]})
    for x in towers.values():
        x["sites"].sort(key=lambda v: (v["operator"], v["radio"], str(v["site_id"])))
        x["carriers"] = sorted({v["operator"].replace(" (ex-Sprint)", "") for v in x["sites"]})
        x["cells"] = sum(len(v["cells"]) for v in x["sites"])
        x["bands"] = sorted({b for v in x["sites"] for b in v["bands"]}, key=_band_order)
    return sorted(towers.values(), key=lambda x: x["dist_mi"] if x["dist_mi"] is not None else 9e9)


def enrich(res, con, spec):
    """Each site's full public record, added to what sites() found. Licensed is never measured: the channel numbers are what the carrier
    may use in this county, from its blocks; which it has on the air here only a scan says (captures, or a scanner file on a job)."""
    county = (spec or {}).get("county")
    for s in res.get("sites") or []:
        s["licensed"] = cellspec.licensed_for(spec, s["operator"], s["radio"])
        s["licensed_where"] = county
        s["fcc_cellular"] = fcc_cellular(con, s["lat"], s["lon"], (s.get("tower") or {}).get("reg"))
        s["heard"] = sorted({c["pci"] for c in s["cells"] if c.get("pci") is not None})
        s["bands"] = bands_of(s)
    res["towers"] = by_tower(res.get("sites") or [])
    on = {t["reg"]: t for t in res["towers"]}
    for s in res.get("sites") or []:  # the site's panel shows the rest of its tower
        t = on.get((s.get("tower") or {}).get("reg"))
        if t:
            s["on_tower"] = {"reg": t["reg"], "carriers": t["carriers"], "cells": t["cells"], "bands": t["bands"], "sites": t["sites"]}
    res["licensed_note"] = ("Licensed, not measured: the channel numbers are each block's, from the FCC's records of what the carrier holds in "
                            f"{county or 'this county'} and the 3GPP channel plans. Which of them this site has on the air, and its broadcast settings, "
                            "power and timing as received, come from a scan.") if spec and not spec.get("empty") else (spec or {}).get("why", "")
    return res


def sites(con, crowd, lat, lon, radius_mi, mission=None):
    """Cells grouped into sites (one eNB / gNB / RNC each), with the FCC tower each most likely sits on."""
    cells = gather(con, crowd, lat, lon, radius_mi, mission)
    groups = {}
    for c in cells:
        groups.setdefault((c["plmn"], c["radio"], c["site_id"]), []).append(c)
    s, n, w, e = geo.bbox(lat, lon, radius_mi + 1)
    towers = [dict(r) for r in con.execute("SELECT * FROM tower WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e))]
    out = []
    for (plmn, radio, sid), cs in groups.items():
        la = sum(c["lat"] for c in cs) / len(cs)
        lo = sum(c["lon"] for c in cs) / len(cs)
        best, bd = None, 1.0
        for t in towers:
            d = geo.haversine_km(la, lo, t["lat"], t["lon"])
            if d < bd:
                best, bd = t, d
        tw = None
        if best:
            lic = [dict(r) for r in con.execute(
                "SELECT licensee, call_sign, service_name, COUNT(DISTINCT freq_mhz) freqs FROM tx WHERE tower_reg=? AND status='A' "
                "GROUP BY call_sign ORDER BY licensee LIMIT 60", (best["reg"],))]
            tw = dict(best, match_m=round(bd * 1000), licensees=lic)
        ax, ay = (tw["lat"], tw["lon"]) if tw else (la, lo)
        for c in cs:  # sector direction: from the tower toward the cell's crowd position
            dd = geo.haversine_km(ax, ay, c["lat"], c["lon"])
            c["az_est"] = round(geo.bearing_deg(ax, ay, c["lat"], c["lon"])) if tw and dd > 0.05 else None
            c["offset_m"] = round(dd * 1000)
        cs.sort(key=lambda c: (c["sector"] is None, c["sector"] or 0))
        out.append({"key": f"{plmn}|{radio}|{sid}", "operator": cs[0]["operator"], "plmn": plmn, "radio": radio,
                    "site_kind": cs[0]["site_kind"], "site_id": sid, "lat": tw["lat"] if tw else la, "lon": tw["lon"] if tw else lo,
                    "located": "on FCC-registered tower" if tw else "average of its cells' crowd positions",
                    "dist_mi": round(geo.haversine_km(lat, lon, tw["lat"] if tw else la, tw["lon"] if tw else lo) / geo.MI_KM, 2),
                    "cells": cs, "tower": tw, "sources": sorted({x for c in cs for x in c["sources"]}),
                    "samples": sum(c["samples"] for c in cs), "last": max((c["last"] for c in cs if c["last"]), default=None)})
    out.sort(key=lambda x: x["dist_mi"])
    return {"sites": out, "cells": len(cells), "towers_nearby": len(towers),
            "sources": {k: v for k, v in (("opencellid", "OpenCelliD Project, CC BY-SA 4.0"), ("wigle", "WiGLE.net contributors"),
                                          ("fcc", "FCC Antenna Structure Registration")) if k == "fcc" or k in crowd_sources()}}


US_MCCS = ("310", "311", "312", "313", "314", "315", "316")
OCID_COUNTRY = "https://opencellid.org/ocid/downloads?token={key}&type=mcc&file={mcc}.csv.gz"


def _download(url, path, timeout=600):
    """A file to disk in 1 MB pieces, so a country file never sits in memory."""
    req = urllib.request.Request(url, headers={"User-Agent": "RF-Recon/2.0 (site-survey tool)"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(path, "wb") as out:
        while True:
            dlstop.check()  # Stop all downloads: at the next megabyte
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)


def load_country(crowd, key, folder, mccs=US_MCCS, log=None, get=None):
    """Every cell OpenCelliD has for the US, from its country files (MCC 310 to 316), as the crowd layer: so a cell site shows anywhere with
    no per-area fetch. One file at a time, downloaded beside the data, read as a stream and deleted. A file that doesn't come (none for that
    MCC, or the day's download limit) is named and the rest still load. The key never appears in what this returns."""
    if not key:
        raise ValueError("This copy has no OpenCelliD key (Data & updates).")
    get = get or _download
    hide = lambda m: str(m).replace(key, "(key)")
    out = {"kept": 0, "read": 0, "files": [], "missing": []}
    for mcc in mccs:
        dlstop.check()  # Stop all downloads: no next file
        path = os.path.join(folder, f"opencellid-{mcc}.csv.gz.part")
        try:
            if log:
                log(f"downloading MCC {mcc}…")
            get(OCID_COUNTRY.format(key=key, mcc=mcc), path)
            with open(path, "rb") as fh:
                if fh.read(2) != b"\x1f\x8b":  # an answer that isn't the file: OpenCelliD says why in words
                    fh.seek(0)
                    out["missing"].append(f"{mcc}: {hide(fh.read(200).decode('utf-8', 'replace')).strip()[:120]}")
                    continue
                fh.seek(0)
                r = import_ocid(crowd, f"{mcc}.csv.gz", fh, None, (lambda m: log(f"MCC {mcc}: {m}")) if log else None)
            out["kept"] += r["kept"]
            out["read"] += r["read"]
            out["files"].append(mcc)
        except dlstop.Stopped:
            raise  # a stop isn't a missing file: the updater marks the source stopped, and the files already read stay
        except Exception as e:
            out["missing"].append(f"{mcc}: {hide(e)[:120]}")
        finally:
            if os.path.exists(path):
                os.remove(path)
    return out


FETCH_RADIUS_MI, FETCH_REQUESTS = 3.0, 24  # the nearest tiles first; OpenCelliD's free key allows 1,000 requests a day
FETCH_PER_DAY, FETCH_KEEP_DAYS = 25, 30


def fetch_near(crowd, lat, lon, key):
    """OpenCelliD's cells around an address, on request. The crowd data otherwise covers only the mission areas, so a new
    address had no cell sites at all (the 11/4 demo, at both addresses the customer gave). An area fetched in the last month
    isn't asked again, and a day's fetches are capped, because every login shares the one key."""
    if not key:
        raise ValueError("This copy has no OpenCelliD key (Data & updates).")
    since = time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - FETCH_KEEP_DAYS * 86400))
    if crowd.execute("SELECT 1 FROM ext_fetch WHERE source='opencellid' AND fetched_at>=? AND rows>0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 1",
                     (since, lat - 0.02, lat + 0.02, lon - 0.03, lon + 0.03)).fetchone():
        return {"rows": 0, "skipped": "fetched for this area in the last month"}
    day = crowd.execute("SELECT COUNT(*) FROM ext_fetch WHERE source='opencellid' AND fetched_at LIKE ?", (time.strftime("%Y-%m-%d") + "%",)).fetchone()[0]
    if day >= FETCH_PER_DAY:
        raise RuntimeError(f"OpenCelliD's share for today is used ({day} areas): try again tomorrow.")
    return {"rows": connectors.fetch_opencellid(crowd, lat, lon, FETCH_RADIUS_MI, key, max_requests=FETCH_REQUESTS)}


def import_ocid(crowd, name, data, boxes=None, log=None):
    """An OpenCelliD download (cell_towers.csv, or a country file like 310.csv.gz) -> the crowd layer.
    boxes: [(s, n, w, e)] to keep (the states in Data & updates); None keeps everything."""
    if hasattr(data, "read"):  # an open file: a whole country is never held in memory
        raw, pos = data, data.tell()
        magic = raw.read(2)
        raw.seek(pos)
    else:
        raw, magic = io.BytesIO(data), data[:2]  # read as a stream: a country file is hundreds of MB once unzipped
    text = io.TextIOWrapper(gzip.GzipFile(fileobj=raw) if magic == b"\x1f\x8b" else raw, encoding="utf-8", errors="replace")
    first = text.readline()
    head = first.strip().lower().split(",")
    has_head = "mcc" in head
    cols = head if has_head else ["radio", "mcc", "net", "area", "cell", "unit", "lon", "lat", "range", "samples",
                                  "changeable", "created", "updated", "averagesignal"]
    now, batch, n, seen = time.strftime("%Y-%m-%d %H:%M"), [], 0, 0
    for row in (csv.reader(text) if has_head else csv.reader(itertools.chain([first], text))):
        seen += 1
        r = dict(zip(cols, row))
        try:
            la, lo = float(r["lat"]), float(r["lon"])
        except (KeyError, ValueError):
            continue
        if boxes and not any(s <= la <= n_ and w <= lo <= e for s, n_, w, e in boxes):
            continue
        radio = (r.get("radio") or "").upper()
        ident = f"{r.get('mcc')}-{r.get('net')}-{r.get('area')}-{r.get('cell')}"
        det = {"radio": radio, "mcc": r.get("mcc"), "mnc": r.get("net"), "lac": r.get("area"), "cellid": r.get("cell"),
               "range": r.get("range"), "samples": r.get("samples"), "created": r.get("created"), "updated": r.get("updated"),
               "unit": r.get("unit")}  # the PCI (LTE, 5G) or PSC (3G) the crowd heard: -1 when it didn't
        sig = sigid.classify("NR" if radio == "NR" else ("WCDMA" if radio == "UMTS" else radio))["sig_type"]
        avg = connectors.fnum(r.get("averagesignal"))
        batch.append(("opencellid", "OpenCelliD cells", ident, la, lo, radio, f"{radio} {ident}", None, None, avg or None, radio, sig,
                      "", "", json.dumps(det), now, connectors.ATTRIBUTION["opencellid"]))
        if len(batch) >= 5000:
            connectors.upsert(crowd, batch)
            n += len(batch)
            batch = []
            if log:
                log(f"{n:,} cells kept of {seen:,} read")
    if batch:
        connectors.upsert(crowd, batch)
        n += len(batch)
    connectors.log_fetch(crowd, "opencellid", None, None, None, n, f"imported {name}")
    return {"kept": n, "read": seen}
