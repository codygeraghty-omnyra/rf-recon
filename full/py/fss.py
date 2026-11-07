"""
Satellite earth stations: the FCC's Protected FSS Earth Station Registration (opendata.fcc.gov, dataset acbv-jbb4,
public domain, updated daily). About 470 C-band receive sites (3.6 to 4.2 GHz) with where each dish points, its gain
and height. They receive, they don't transmit: context for C-band and n77 work, where a booster or DAS near one can
interfere with it.
"""
import json
import time
import urllib.request

URL = "https://opendata.fcc.gov/resource/acbv-jbb4.json?$limit=5000"
UA = {"User-Agent": "RF-Recon/2.0 (personal site-survey tool)", "Accept": "application/json"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS fss_earth(number TEXT PRIMARY KEY, status TEXT, licensee TEXT, call_sign TEXT, lat REAL, lon REAL,
    freq_lo_mhz REAL, freq_hi_mhz REAL, azimuth REAL, elevation REAL, gain_dbi REAL, height_agl_m REAL, height_amsl_m REAL,
    satellite_lon REAL, certified TEXT, updated TEXT);
CREATE INDEX IF NOT EXISTS fss_latlon ON fss_earth(lat, lon);
"""


def num(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def rows_from(data):
    out = []
    for p in data:
        la, lo = num(p.get("latitude_decimal")), num(p.get("longitude_decimal"))
        if not p.get("number") or la is None or lo is None:
            continue
        out.append((p["number"], p.get("location_status"), p.get("call_sign_licensee_name"), p.get("call_sign"), la, lo,
                    num(p.get("lower_frequency")), num(p.get("upper_frequency")), num(p.get("pointing_azimuth")),
                    num(p.get("pointing_elevation_angle")), num(p.get("antenna_gain")), num(p.get("antenna_height_agl")),
                    num(p.get("antenna_height_amsl")), num(p.get("gso_satellite_logitude_decimal")),
                    (p.get("certification_date") or "")[:10], (p.get("sys_updated_on") or "")[:10]))
    return out


def run(con, log=None):
    con.executescript(SCHEMA)
    with urllib.request.urlopen(urllib.request.Request(URL, headers=UA), timeout=120) as r:
        data = json.loads(r.read(20_000_000))
    out = rows_from(data if isinstance(data, list) else [])
    if not out:
        raise RuntimeError("The FCC's earth station registry came back empty.")
    con.execute("DELETE FROM fss_earth")
    con.executemany(f"INSERT OR REPLACE INTO fss_earth VALUES({','.join('?' * 16)})", out)
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('fss_built_at', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
    con.commit()
    if log:
        log(f"{len(out):,} earth stations")
    return len(out)


def feature(r):
    """A map / list row for one earth station."""
    f = dict(r)
    f.update(layer="fss", fid=f"fss:{f['number']}", label=f"{f['licensee'] or ''} {f['call_sign'] or ''}".strip(),
             category="Satellite earth station (FCC, protected FSS)", sig_type="Satellite downlink (receive)",
             freq_mhz=f["freq_lo_mhz"], licensee=f["licensee"],
             details=json.dumps({"Registration": f["number"], "Status": f["status"], "Call sign": f["call_sign"],
                                 "Receives": f"{f['freq_lo_mhz']:g} to {f['freq_hi_mhz']:g} MHz" if f["freq_lo_mhz"] and f["freq_hi_mhz"] else "",
                                 "Points at": f"azimuth {f['azimuth']}°, elevation {f['elevation']}°",
                                 "Satellite": f"{f['satellite_lon']}° longitude" if f["satellite_lon"] is not None else "",
                                 "Gain": f"{f['gain_dbi']} dBi", "Height": f"{f['height_agl_m']} m above ground",
                                 "Certified": f["certified"], "Registry": "FCC Protected FSS Earth Station Registration"}))
    return f
