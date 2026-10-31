"""
Carrier coverage from the FCC National Broadband Map (BDC): each mobile carrier's modelled 3G / 4G / 5G coverage as
H3 hexagons (resolution 9, about 0.1 km2), each with the minimum signal the carrier modelled there (dBm) and whether
that holds outdoors standing still or in a moving vehicle.

The FCC publishes one file per carrier, technology and speed tier, per state: a zipped shapefile whose table carries
the hexagon and its values. RF Recon keeps each hexagon's centre with those values in its own database (bdc.db, beside
uls.db), loaded for the states set in Data & updates. A new release comes twice a year; files already loaded for the
current release aren't fetched again. Needs a free API token (broadbandmap.fcc.gov, Manage API Access), sent with the
FCC sign-in email; the FCC's API terms apply.
"""
import io
import json
import os
import sqlite3
import struct
import time
import urllib.request
import zipfile

BASE = "https://broadbandmap.fcc.gov/api/public/map"
UA = "RF-Recon/2.0 (personal site-survey tool)"
TECH = {300: "3G", 400: "4G LTE", 500: "5G-NR"}
ENV = {0: "outdoor, standing still", 1: "in a moving vehicle"}
STATES = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
          "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
          "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
          "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
          "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
          "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
          "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
          "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
          "PR": "Puerto Rico", "GU": "Guam", "VI": "United States Virgin Islands", "AS": "American Samoa", "MP": "Northern Mariana Islands"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS bdc_hex(file_id INTEGER, state TEXT, provider INTEGER, tech INTEGER, mindown INTEGER, minup INTEGER,
    minsignal INTEGER, env INTEGER, h3 INTEGER, lat REAL, lon REAL);
CREATE INDEX IF NOT EXISTS bdc_ll ON bdc_hex(lat, lon);
CREATE TABLE IF NOT EXISTS bdc_provider(provider INTEGER PRIMARY KEY, brand TEXT, frn TEXT);
CREATE TABLE IF NOT EXISTS bdc_file(file_id INTEGER PRIMARY KEY, as_of TEXT, state TEXT, provider INTEGER, tech INTEGER, speed TEXT,
    records INTEGER, loaded_at TEXT);
"""


def db_path(data_dir):
    return os.path.join(data_dir, "bdc.db")


def connect(data_dir):
    con = sqlite3.connect(db_path(data_dir), timeout=60)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def _get(path, creds, raw=False):
    if not (creds.get("fcc_bdc_username") and creds.get("fcc_bdc_token")):
        raise ValueError("Needs the FCC Broadband Map sign-in email and API token (Data & updates, Your API keys).")
    req = urllib.request.Request(BASE + path, headers={"username": creds["fcc_bdc_username"], "hash_value": creds["fcc_bdc_token"], "User-Agent": UA})
    r = urllib.request.urlopen(req, timeout=300)
    return r if raw else json.load(r)


def latest_release(creds):
    dates = [d["as_of_date"] for d in _get("/listAsOfDates", creds)["data"] if d.get("data_type") == "availability"]
    return max(dates)


def files_for(creds, as_of, states):
    """The carrier hexagon files (mobile broadband) for these states in that release."""
    names = {STATES[s]: s for s in states if s in STATES}
    out = []
    for r in _get(f"/downloads/listAvailabilityData/{as_of}", creds)["data"]:
        if (r.get("category"), r.get("subcategory"), r.get("technology_type")) == ("Provider", "Hexagon Coverage", "Mobile Broadband") \
                and r.get("state_name") in names:
            out.append(dict(r, state=names[r["state_name"]]))
    return out


def read_hexes(zf):
    """Rows of a BDC hexagon shapefile: the table's values with each hexagon's centre from the shapes (same order)."""
    dbf = next(n for n in zf.namelist() if n.lower().endswith(".dbf"))
    shp = next(n for n in zf.namelist() if n.lower().endswith(".shp"))
    with zf.open(dbf) as d, zf.open(shp) as s:
        head = d.read(32)
        n_rec, hlen, rlen = struct.unpack("<IHH", head[4:12])
        desc, fields, pos, off = d.read(hlen - 32), {}, 1, 0  # field descriptors, 32 bytes each, up to the 0x0D marker
        while off + 32 <= len(desc) and desc[off] != 0x0D:
            fields[desc[off:off + 11].split(b"\0")[0].decode().lower()] = (pos, pos + desc[off + 16])
            pos += desc[off + 16]
            off += 32
        s.read(100)
        want = [k for k in ("providerid", "brandname", "frn", "technology", "mindown", "minup", "minsignal", "environmnt", "h3_res9_id") if k in fields]
        for _ in range(n_rec):
            rec = d.read(rlen)
            num, clen = struct.unpack(">ii", s.read(8))
            body = s.read(clen * 2)
            if len(rec) < rlen or rec[:1] == b"*":  # deleted
                continue
            v = {k: rec[fields[k][0]:fields[k][1]].decode("latin-1").strip() for k in want}
            lat = lon = None
            if len(body) >= 44 and struct.unpack("<i", body[:4])[0] in (5, 15, 25):
                nparts, npts = struct.unpack("<ii", body[36:44])
                start = 44 + 4 * nparts
                pts = struct.unpack(f"<{npts * 2}d", body[start:start + 16 * npts])
                k = npts - 1 if npts > 1 and pts[0] == pts[-2] and pts[1] == pts[-1] else npts  # the ring repeats its first point
                lon, lat = sum(pts[0:2 * k:2]) / k, sum(pts[1:2 * k:2]) / k
            v["lat"], v["lon"] = lat, lon
            yield v


def _int(x, d=None):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return d


def load_file(con, path, state, meta, log=None):
    """Load one downloaded file's hexagons in one transaction with its bdc_file row, so a file is in whole or not at
    all. Returns rows loaded."""
    fid, tech = int(meta["file_id"]), _int(meta.get("technology_code"))
    sql = "INSERT INTO bdc_hex VALUES(?,?,?,?,?,?,?,?,?,?,?)"
    try:
        with zipfile.ZipFile(path) as zf:
            rows, brand, n = [], None, 0
            for v in read_hexes(zf):
                if v["lat"] is None:
                    continue
                if brand is None:
                    brand = v.get("brandname")
                    con.execute("INSERT OR REPLACE INTO bdc_provider VALUES(?,?,?)", (_int(v.get("providerid")), brand, v.get("frn")))
                h3 = v.get("h3_res9_id") or ""
                rows.append((fid, state, _int(v.get("providerid")), _int(v.get("technology"), tech), _int(v.get("mindown")), _int(v.get("minup")),
                             _int(v.get("minsignal")), _int(v.get("environmnt")), int(h3, 16) if h3 else None, round(v["lat"], 6), round(v["lon"], 6)))
                if len(rows) >= 100000:
                    con.executemany(sql, rows)
                    n += len(rows)
                    rows.clear()
            if rows:
                con.executemany(sql, rows)
                n += len(rows)
        con.execute("INSERT OR REPLACE INTO bdc_file VALUES(?,?,?,?,?,?,?,?)", (fid, meta.get("as_of"), state, _int(meta.get("provider_id")),
                                                                              tech, meta.get("speed_tier"), n, time.strftime("%Y-%m-%d %H:%M")))
        con.commit()
    except BaseException:
        con.rollback()
        raise
    return n


def _download(creds, file_id, path, tries=3):
    """Fetch one file whole: as long as the server said and a complete zip. A dropped connection (a phone tether) can
    end a download early without an error, so check, and try again after a pause."""
    for k in range(tries):
        try:
            with _get(f"/downloads/downloadFile/availability/{file_id}", creds, raw=True) as r, open(path, "wb") as fh:
                want, got = int(r.headers.get("Content-Length") or 0), 0
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk)
                    got += len(chunk)
            if (not want or got == want) and zipfile.is_zipfile(path):
                return True
        except OSError:  # URLError and dropped sockets are OSErrors
            pass
        time.sleep(15 * (k + 1))
    return False


def run(data_dir, creds, states, log=print):
    """Bring the chosen states up to the newest release: download and load each carrier file not yet loaded for it."""
    states = sorted({s.strip().upper() for s in states if s.strip()} & set(STATES))
    if not states:
        raise ValueError("Pick the states for carrier coverage first (Data & updates).")
    as_of = latest_release(creds)
    files = files_for(creds, as_of, states)
    con = connect(data_dir)
    try:
        done = {r[0] for r in con.execute("SELECT file_id FROM bdc_file WHERE as_of=?", (as_of,))}
        todo = [f for f in files if int(f["file_id"]) not in done]
        log(f"{len(files)} carrier files for {', '.join(states)} (release {as_of}); {len(todo)} to load")
        tmp = os.path.join(data_dir, "bdc_download.zip")
        total, missed = 0, []
        for i, f in enumerate(todo, 1):
            if _download(creds, f["file_id"], tmp):
                total += load_file(con, tmp, f["state"], dict(f, as_of=as_of))
            else:
                missed.append(f)
            log(f"{i}/{len(todo)} files · {total:,} hexagons" + (f" · {len(missed)} to retry" if missed else ""))
        if os.path.exists(tmp):
            os.remove(tmp)
        if missed:  # what loaded stays; the next run fetches only these
            raise RuntimeError(f"{len(missed)} of {len(todo)} files didn't download whole (the connection dropped). "
                               f"The other {len(todo) - len(missed)} are loaded: run it again to fetch the rest.")
        # an older release of these states goes once the new one is in
        old = [r[0] for r in con.execute("SELECT file_id FROM bdc_file WHERE as_of<>? AND state IN (%s)" % ",".join("?" * len(states)), (as_of, *states))]
        if old:
            con.execute("DELETE FROM bdc_hex WHERE file_id IN (%s)" % ",".join("?" * len(old)), old)
            con.execute("DELETE FROM bdc_file WHERE file_id IN (%s)" % ",".join("?" * len(old)), old)
            con.commit()
        n = con.execute("SELECT COUNT(*) FROM bdc_hex").fetchone()[0]
        return {"as_of": as_of, "loaded": total, "hexagons": n, "states": states}
    finally:
        con.close()


def _box(lat, lon, km):
    import math
    return lat - km / 111.0, lat + km / 111.0, lon - km / (111.0 * max(0.05, math.cos(math.radians(lat)))), lon + km / (111.0 * max(0.05, math.cos(math.radians(lat))))


def at(data_dir, lat, lon):
    """Which carriers cover this spot: per carrier and technology, the best tier, the strongest modelled signal and where."""
    if not os.path.exists(db_path(data_dir)):
        return {"carriers": [], "loaded": False}
    con = connect(data_dir)
    try:
        s, n, w, e = _box(lat, lon, 0.2)  # a hexagon is about 0.35 km across: its centre is within 0.2 km
        names = {r["provider"]: r["brand"] for r in con.execute("SELECT provider, brand FROM bdc_provider")}
        best = {}
        for r in con.execute("SELECT * FROM bdc_hex WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", (s, n, w, e)):
            key = (r["provider"], r["tech"])
            b = best.setdefault(key, {"provider": r["provider"], "brand": names.get(r["provider"]) or str(r["provider"]), "tech": TECH.get(r["tech"], str(r["tech"])),
                                      "speeds": set(), "signal": None, "envs": set()})
            b["speeds"].add(f"{r['mindown']}/{r['minup']}")
            b["envs"].add(ENV.get(r["env"], str(r["env"])))
            if r["minsignal"] is not None and (b["signal"] is None or r["minsignal"] > b["signal"]):
                b["signal"] = r["minsignal"]
        out = sorted(best.values(), key=lambda b: (b["brand"], b["tech"]))
        for b in out:
            b["speeds"] = sorted(b["speeds"], key=lambda x: -int(x.split("/")[0]))
            b["envs"] = sorted(b["envs"])
        as_of = con.execute("SELECT MAX(as_of) FROM bdc_file").fetchone()[0]
        return {"carriers": out, "loaded": True, "as_of": as_of}
    finally:
        con.close()


def describe(data_dir, provider):
    con = connect(data_dir)
    try:
        r = con.execute("SELECT brand FROM bdc_provider WHERE provider=?", (provider,)).fetchone()
        return {"brand": r["brand"] if r else str(provider), "as_of": con.execute("SELECT MAX(as_of) FROM bdc_file").fetchone()[0]}
    finally:
        con.close()


def carriers(data_dir, s, n, w, e):
    """The carriers and technologies with coverage in a box (for the heatmap's pickers)."""
    if not os.path.exists(db_path(data_dir)):
        return []
    con = connect(data_dir)
    try:
        names = {r["provider"]: r["brand"] for r in con.execute("SELECT provider, brand FROM bdc_provider")}
        rows = con.execute("SELECT provider, tech, COUNT(*) n FROM bdc_hex WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? GROUP BY provider, tech",
                           (s, n, w, e)).fetchall()
        return sorted(({"provider": r["provider"], "brand": names.get(r["provider"]) or str(r["provider"]), "tech": r["tech"],
                        "tech_name": TECH.get(r["tech"], str(r["tech"])), "hexagons": r["n"]} for r in rows), key=lambda x: (x["brand"], -x["tech"]))
    finally:
        con.close()


def paint(data_dir, grid, provider, tech, env=None, mindown=None):
    """Fill a heatmap grid with the strongest modelled signal (dBm) of one carrier's technology. Returns hexagons used."""
    import math
    if not os.path.exists(db_path(data_dir)):
        raise ValueError("No carrier coverage loaded yet: pick states in Data & updates (FCC carrier coverage) and run it.")
    con = connect(data_dir)
    try:
        q = "SELECT lat, lon, minsignal FROM bdc_hex WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND provider=? AND tech=?"
        args = [grid.s, grid.n, grid.w, grid.e, provider, tech]
        if env is not None:
            q += " AND env=?"
            args.append(env)
        if mindown is not None:
            q += " AND mindown>=?"
            args.append(mindown)
        dlat, dlon = (grid.n - grid.s) / grid.rows, (grid.e - grid.w) / grid.cols
        cell_km = dlat * 111.0
        reach = max(0, math.ceil(0.18 / cell_km) - 1) if cell_km < 0.36 else 0  # a hexagon spans several small cells
        n = 0
        for lat, lon, sig in con.execute(q, args):
            if sig is None:
                continue
            r0, c0 = int((grid.n - lat) / dlat), int((lon - grid.w) / dlon)
            n += 1
            for r in range(r0 - reach, r0 + reach + 1):
                if 0 <= r < grid.rows:
                    row = grid.values[r]
                    for c in range(c0 - reach, c0 + reach + 1):
                        if 0 <= c < grid.cols and (row[c] is None or sig > row[c]):
                            row[c] = sig
        return n
    finally:
        con.close()
