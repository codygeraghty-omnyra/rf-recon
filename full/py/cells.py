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
import re
import time

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
    "UScellular": "311-580",
    "Dish / Boost": "313-340",
}.items():
    for _c in _codes.split():
        OPERATORS[_c] = _name
CELL_KINDS = {"LTE", "NR", "GSM", "UMTS", "WCDMA", "CDMA"}
_ID = re.compile(r"(\d{3})[-_]?(\d{2,3})[-_](\d+)[-_](\d+)")


def operator(mcc, mnc):
    key = f"{mcc}-{int(mnc):03d}" if str(mnc).isdigit() else f"{mcc}-{mnc}"
    return OPERATORS.get(key) or (f"MCC {mcc} MNC {mnc}" if mcc else "Unknown operator")


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
                                            channel=None, points=0, _lat=0.0, _lon=0.0))
        if src not in c["sources"]:
            c["sources"].append(src)
        c["points"] += 1
        c["_lat"] += la
        c["_lon"] += lo
        c["lat"], c["lon"] = c["_lat"] / c["points"], c["_lon"] / c["points"]
        for k in ("samples",):
            if extra.get(k):
                c[k] += int(extra[k])
        for k in ("range_m", "dbm", "channel"):
            if extra.get(k) not in (None, ""):
                c[k] = extra[k]
        for k, better in (("first", min), ("last", max)):
            if extra.get(k):
                c[k] = better(c[k], extra[k]) if c[k] else extra[k]

    for r in crowd.execute("SELECT * FROM ext_point WHERE source IN ('opencellid', 'wigle') AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                           (s, n, w, e)):
        try:
            det = json.loads(r["details"] or "{}")
        except ValueError:
            det = {}
        radio = (r["kind"] or r["mode"] or det.get("radio") or det.get("gentype") or "").upper()
        if radio not in CELL_KINDS:
            continue
        ts = lambda v: time.strftime("%Y-%m-%d", time.gmtime(int(v))) if str(v or "").isdigit() else (str(v)[:10] if v else None)
        add("OpenCelliD" if r["source"] == "opencellid" else "WiGLE", radio, r["ext_id"], r["lat"], r["lon"],
            {"samples": det.get("samples"), "range_m": det.get("range"), "dbm": r["dbm"], "channel": det.get("channel"),
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
            "sources": {"opencellid": "OpenCelliD Project, CC BY-SA 4.0", "wigle": "WiGLE.net contributors", "fcc": "FCC Antenna Structure Registration"}}


def import_ocid(crowd, name, data, boxes=None, log=None):
    """An OpenCelliD download (cell_towers.csv, or a country file like 310.csv.gz) -> the crowd layer.
    boxes: [(s, n, w, e)] to keep (the states in Data & updates); None keeps everything."""
    raw = io.BytesIO(data)  # read as a stream: a country file is hundreds of MB once unzipped
    text = io.TextIOWrapper(gzip.GzipFile(fileobj=raw) if data[:2] == b"\x1f\x8b" else raw, encoding="utf-8", errors="replace")
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
               "range": r.get("range"), "samples": r.get("samples"), "created": r.get("created"), "updated": r.get("updated")}
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
