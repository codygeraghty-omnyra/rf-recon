"""What's at a DAS job's address, from open data, through the Data desk (Cody 11/8; the data report's top pick):

- the building: FEMA/ORNL USA Structures (every building over 450 sq ft: occupancy, use, floor area, height where
  measured; CC BY 4.0, credit ORNL and FEMA). Heights are in metres and patchy (none in Wilmington NC); its rows say
  how they were checked (VAL_METHOD), and "Unverified" is shown as such.
- who responds at the point: the state 911 (NG911) response boundaries, fire, EMS, law and the 911 centre, where a
  state publishes them openly: Wisconsin ("free and open for use by the public") and Kentucky (CC0).
- the nearest fire/EMS and police stations at their real positions: USGS National Structures (US public domain,
  credit asked), in place of the USFA registry's ZIP-centre guesses.

Asked only when a person presses Find the AHJ on a job, never on a page load; the job keeps what came back. Every
request goes through datadesk.fetchkit: a refusal stops that source and files a Needs a person task; nothing is ever
retried another way. Terms read on each provider's own page 11/8 (reference/data_desk.json).
"""
import json
import math
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

from datadesk import fetchkit, persons

UA = "DAStastic data desk (open data lookups for DAS jobs; contact via omnyra.ai)"
STRUCT = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query"
USGS = "https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/{}/query"
USGS_LAYERS = {16: "Fire or EMS station", 18: "Police station"}
WI = "https://services3.arcgis.com/GoOAGCoqFEhZEh7f/arcgis/rest/services/WI_NG911_GIS_Service_Polygons_and_Road_Centerline_Data_v2/FeatureServer/{}/query"
KY = "https://services3.arcgis.com/ghsX9CKghMvyYjBU/arcgis/rest/services/{}/FeatureServer/{}/query"
RESPONDERS = {  # state: (registry id, [(what, url)]), and a box around the state: outside it, the state isn't asked
    "WI": ("wi-911-response-boundaries", (42.49, -92.89, 47.31, -86.25),
           [("Fire", WI.format(3)), ("EMS", WI.format(2)), ("Law", WI.format(4)), ("911 centre", WI.format(6))]),
    "KY": ("ky-911-response-boundaries", (36.49, -89.58, 39.15, -81.96),
           [("Fire", KY.format("Ky_911_RSB_Fire_gdb", 4)), ("EMS", KY.format("Ky_911_RSB_EMS_gdb", 5)),
            ("Law", KY.format("Ky_911_RSB_Law_gdb", 3)), ("911 centre", KY.format("Ky_911_PSAP_Boundaries_gdb", 6))]),
}
SOURCES = {
    "usa-structures": {"id": "usa-structures", "name": "FEMA/ORNL USA Structures", "url": "https://www.arcgis.com/home/item.html?id=0ec8512ad21e4bb987d7e848d14e7e24",
                       "credit": "USA Structures, Oak Ridge National Laboratory and FEMA (CC BY 4.0)"},
    "wi-911-response-boundaries": {"id": "wi-911-response-boundaries", "name": "Wisconsin NG911 response boundaries",
                                   "url": "https://www.arcgis.com/home/item.html?id=593d0da225b24601ad0c21598ef52fb0",
                                   "credit": "Wisconsin NG911 GIS response boundaries (free and open for use by the public)"},
    "ky-911-response-boundaries": {"id": "ky-911-response-boundaries", "name": "Kentucky 911 response boundaries",
                                   "url": "https://services3.arcgis.com/ghsX9CKghMvyYjBU/arcgis/rest/services",
                                   "credit": "Kentucky 911 response boundaries (CC0)"},
    "usgs-national-structures": {"id": "usgs-national-structures", "name": "USGS National Structures",
                                 "url": "https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer",
                                 "credit": "USGS National Structures Dataset (U.S. public domain)"},
}
TOKEN_CODES = (401, 403, 498, 499)  # ArcGIS answers 200 with an error body when it wants a sign-in or a token


def _mi(a, b, c, d):
    p = math.pi / 180
    h = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def _query(f, url, params):
    u = url + "?" + urllib.parse.urlencode({**params, "f": "json"})
    d = json.loads(f.get(u, accept="application/json", conditional=False).body or b"{}")
    err = d.get("error")
    if err:
        if int(err.get("code") or 0) in TOKEN_CODES:
            raise fetchkit.Refused(u, f"asks for a sign-in or a token ({err.get('code')})", int(err.get("code") or 0))
        raise RuntimeError(f"{urllib.parse.urlsplit(url).netloc}: {err.get('message') or err}")
    return d.get("features") or []


def building(f, lat, lon):
    """The structure at the point, else the nearest one within 40 m; None when there isn't one."""
    p = {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
         "outFields": "OCC_CLS,PRIM_OCC,SEC_OCC,PROP_ADDR,PROP_CITY,PROP_ST,HEIGHT,SQFEET,VAL_METHOD,LATITUDE,LONGITUDE", "returnGeometry": "false"}
    rows = _query(f, STRUCT, p)
    inside = bool(rows)
    if not rows:
        rows = _query(f, STRUCT, {**p, "distance": "40", "units": "esriSRUnit_Meter"})
    if not rows:
        return None
    a = min((r["attributes"] for r in rows), key=lambda a: _mi(lat, lon, a.get("LATITUDE") or lat, a.get("LONGITUDE") or lon))
    h = a.get("HEIGHT")
    return {"occupancy": " · ".join(x for x in (a.get("OCC_CLS"), a.get("PRIM_OCC"), a.get("SEC_OCC")) if x and x != "Unclassified"),
            "address": ", ".join(x for x in (a.get("PROP_ADDR"), a.get("PROP_CITY"), a.get("PROP_ST")) if x),
            "sq_ft": round(a["SQFEET"]) if a.get("SQFEET") else None,
            "height_m": round(h, 1) if h else None, "height_ft": round(h * 3.28084) if h else None,
            "checked": a.get("VAL_METHOD") or "", "inside": inside}


def responders(f, lat, lon):
    """Who responds at the point, by the state's own 911 boundaries; [] where the state doesn't publish them openly."""
    out = []
    for st, (sid, box, layers) in RESPONDERS.items():
        if not (box[0] <= lat <= box[2] and box[1] <= lon <= box[3]):
            continue
        q = {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
             "outFields": "DsplayName,Agency_ID,ServiceNum", "returnGeometry": "false"}
        with ThreadPoolExecutor(max_workers=len(layers)) as ex:  # the four layers at once: one slow layer doesn't hold the rest
            got = list(ex.map(lambda wu: (wu[0], _query(f, wu[1], q)), layers))
        for what, rows in got:
            for r in rows:
                a = {k.upper(): v for k, v in r["attributes"].items()}
                if a.get("DSPLAYNAME"):
                    out.append({"what": what, "name": a["DSPLAYNAME"], "phone": a.get("SERVICENUM") or "", "state": st, "source": sid})
    return out


def stations(f, lat, lon, radius_mi=10, per=4):
    """The nearest fire/EMS and police stations at their real positions, nearest first."""
    out = []
    for layer, what in USGS_LAYERS.items():
        rows = _query(f, USGS.format(layer), {"geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326",
                                               "spatialRel": "esriSpatialRelIntersects", "distance": str(radius_mi), "units": "esriSRUnit_StatuteMile",
                                               "outFields": "NAME,ADDRESS,CITY,STATE,LOADDATE", "returnGeometry": "true", "outSR": "4326"})
        got = []
        for r in rows:
            g, a = r.get("geometry") or {}, {k.upper(): v for k, v in r["attributes"].items()}  # MapServer answers in lower case
            if g.get("y") is None:
                continue
            got.append({"what": what, "name": a.get("NAME") or "(no name)", "address": ", ".join(x for x in (a.get("ADDRESS"), a.get("CITY")) if x)
                        + (f", {a['STATE']}" if a.get("STATE") else ""), "lat": round(g["y"], 6), "lon": round(g["x"], 6),
                        "miles": round(_mi(lat, lon, g["y"], g["x"]), 1)})
        out += sorted(got, key=lambda x: x["miles"])[:per]
    return out


def lookup(con, lat, lon, fetcher=None):
    """{"building", "responders", "stations", "credits", "refused", "failed", "at"}. A source that refuses files a
    Needs a person task (on con) and the rest still answer."""
    f = fetcher or fetchkit.Fetcher(UA, max_bytes=5 * 1024 * 1024, timeout=30)
    res = {"building": None, "responders": [], "stations": [], "credits": [], "refused": [], "failed": [], "at": time.strftime("%Y-%m-%d %H:%M")}
    persons.ensure(con)

    jobs = [("usa-structures", lambda: building(f, lat, lon), "building")]
    jobs += [(sid, lambda: responders(f, lat, lon), "responders")
             for sid in {RESPONDERS[st][0] for st, (_, box, _) in RESPONDERS.items() if box[0] <= lat <= box[2] and box[1] <= lon <= box[3]}]
    jobs.append(("usgs-national-structures", lambda: stations(f, lat, lon), "stations"))
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:  # every source at once; tasks are filed after, on this thread (sqlite)
        futs = [(sid, key, ex.submit(fn)) for sid, fn, key in jobs]
    for sid, key, fut in futs:
        src = SOURCES[sid]
        try:
            v = fut.result()
        except fetchkit.Refused as e:
            persons.from_refusal(con, {"id": sid, "name": src["name"], "owner": "Cody"}, e, f"{src['name']} answers Find the AHJ on a DAS job.")
            res["refused"].append(f"{src['name']} {e.why}")
            continue
        except Exception as e:  # unreachable or a bad answer: said, not filed as a person task
            res["failed"].append(f"{src['name']}: {type(e).__name__}: {str(e)[:120]}")
            continue
        res[key] = v
        if v:
            res["credits"].append(src["credit"])
    return res
