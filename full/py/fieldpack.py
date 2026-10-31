"""
Field packs: one area's public data for the RF Recon phone app.

A pack is a gzip-compressed SQLite file (.rfpack) holding only what the phone needs, worked out in advance:
active FCC licences (with band and signal type), towers, broadcast, NOAA Weather Radio, FAA, place names, 911 call
centres and the microwave links with an end in the area. A history file (build_history) holds the area's expired,
cancelled and removed licences for the web version's history layer, and one grantee file (build_grantee) the FCC's
equipment-maker codes for its FCC ID look-ups; the phone app reads neither.
It never carries missions, captures, labels, settings or keys, and none of the crowd layers or the Signal ID
Wiki catalog (their terms don't allow passing them on). Packs go in the Drive folder's "field packs"; anyone
the folder is shared with can load them on their phone.

    python fieldpack.py --states VA,MD,DC
    python fieldpack.py --center 38.88,-77.10 --radius 25 --name "Arlington 25 mi"
"""
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import faa  # noqa: E402
import geo  # noqa: E402
import psap  # noqa: E402
import sigid  # noqa: E402
import uls_import  # noqa: E402

PACK_VERSION = 1
PACK_DIR = os.environ.get("RF_RECON_PACKS") or os.path.join(os.path.dirname(HERE), "field packs")
BIG_MB = 300  # unpacked size a phone can hold in memory comfortably; bigger packs get a warning

SCHEMA = """
CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE tx(id INTEGER PRIMARY KEY, usi INTEGER, call_sign TEXT, service TEXT, service_name TEXT, licensee TEXT,
    category TEXT, grant_date TEXT, expired_date TEXT, loc_num INTEGER, address TEXT, city TEXT, county TEXT, state TEXT,
    lat REAL, lon REAL, ground_elev_m REAL, radius_km REAL, is_mobile INTEGER, ant_num INTEGER, height_tip_m REAL, haat_m REAL,
    gain_dbi REAL, azimuth REAL, station_class TEXT, freq_mhz REAL, freq_upper_mhz REAL, band TEXT, power_out_w REAL,
    erp_w REAL, units INTEGER, emissions TEXT, bandwidth_khz REAL, mode TEXT, tolerance TEXT, tx_make TEXT, tx_model TEXT,
    digital_mod TEXT, ant_make TEXT, ant_model TEXT, polarization TEXT, beamwidth REAL, height_raat_m REAL, status TEXT,
    tower_reg TEXT, sig_type TEXT);
CREATE TABLE tower(reg TEXT PRIMARY KEY, usi INTEGER, lat REAL, lon REAL, struct_type TEXT, height_m REAL, overall_agl_m REAL,
    overall_amsl_m REAL, ground_elev_m REAL, street TEXT, city TEXT, state TEXT, county TEXT, owner TEXT, status TEXT,
    constructed TEXT, faa_study TEXT);
CREATE TABLE bcast(id INTEGER PRIMARY KEY, call_sign TEXT, kind TEXT, service TEXT, freq_mhz REAL, channel TEXT, class TEXT,
    status TEXT, city TEXT, state TEXT, facility_id TEXT, lat REAL, lon REAL, erp_kw REAL, haat_m REAL, licensee TEXT,
    hours TEXT, directional TEXT, band TEXT, sig_type TEXT);
CREATE TABLE nwr(id INTEGER PRIMARY KEY, call_sign TEXT, freq_mhz REAL, power_w REAL, status TEXT, site TEXT, city TEXT,
    state TEXT, wfo TEXT, lat REAL, lon REAL, counties TEXT, band TEXT);
CREATE TABLE faa(id INTEGER PRIMARY KEY, ident TEXT, name TEXT, kind TEXT, use TEXT, freq_mhz REAL, call TEXT, sector TEXT,
    city TEXT, state TEXT, lat REAL, lon REAL, status TEXT, remark TEXT, source TEXT, band TEXT, sig_type TEXT);
CREATE TABLE place(name TEXT COLLATE NOCASE, kind TEXT, state TEXT, lat REAL, lon REAL, n INTEGER);
CREATE UNIQUE INDEX place_key ON place(name, kind, state);
CREATE TABLE psap(psap_id TEXT PRIMARY KEY, name TEXT, city TEXT, county TEXT, state TEXT, change TEXT,
    modified TEXT, lat REAL, lon REAL, located TEXT);
CREATE TABLE mw_link(usi INTEGER, call_sign TEXT, licensee TEXT, service TEXT, path_num INTEGER,
    tx_lat REAL, tx_lon REAL, tx_city TEXT, tx_state TEXT, tx_reg TEXT, rx_lat REAL, rx_lon REAL, rx_city TEXT,
    rx_state TEXT, rx_reg TEXT, rx_call TEXT, dist_km REAL, freqs TEXT, path_type TEXT, passive TEXT,
    UNIQUE(usi, path_num, tx_lat, tx_lon, rx_lat, rx_lon));
"""
INDEXES = """
CREATE INDEX tx_latlon ON tx(lat, lon); CREATE INDEX tx_freq ON tx(freq_mhz); CREATE INDEX tx_call ON tx(call_sign);
CREATE INDEX tower_latlon ON tower(lat, lon); CREATE INDEX bcast_latlon ON bcast(lat, lon);
CREATE INDEX nwr_latlon ON nwr(lat, lon); CREATE INDEX faa_latlon ON faa(lat, lon); CREATE INDEX place_name ON place(name);
CREATE INDEX psap_latlon ON psap(lat, lon); CREATE INDEX mw_tx ON mw_link(tx_lat, tx_lon); CREATE INDEX mw_rx ON mw_link(rx_lat, rx_lon);
"""
TX_COLS = ("id usi call_sign service service_name licensee category grant_date expired_date loc_num address city county state "
           "lat lon ground_elev_m radius_km is_mobile ant_num height_tip_m haat_m gain_dbi azimuth station_class freq_mhz "
           "freq_upper_mhz power_out_w erp_w units emissions bandwidth_khz mode tolerance tx_make tx_model digital_mod "
           "ant_make ant_model polarization beamwidth height_raat_m status tower_reg").split()
TOWER_COLS = ("reg usi lat lon struct_type height_m overall_agl_m overall_amsl_m ground_elev_m street city state county owner "
              "status constructed faa_study").split()
BCAST_COLS = ("id call_sign band service freq_mhz channel class status city state facility_id lat lon erp_kw haat_m "
              "licensee hours directional").split()
NWR_COLS = "id call_sign freq_mhz power_w status site city state wfo lat lon counties".split()
FAA_COLS = "id ident name kind use freq_mhz call sector city state lat lon status remark source".split()
PSAP_COLS = "psap_id name city county state change modified lat lon located".split()
MW_COLS = ("usi call_sign licensee service path_num tx_lat tx_lon tx_city tx_state tx_reg rx_lat rx_lon rx_city rx_state "
           "rx_reg rx_call dist_km freqs path_type passive").split()
HIST_COLS = "hkey call_sign freq_mhz lat lon licensee service mode county state first_seen last_seen".split()
GRANTEE_COLS = "code name address city state country zip received".split()
BCAST_TYPE = {"FM": "FM broadcast", "TV": "ATSC TV", "AM": "AM broadcast"}


def area_where(states=None, center=None, radius_mi=None):
    """SQL for the pack's area plus a row check (radius packs keep rows inside the circle only)."""
    if states:
        return f"state IN ({','.join('?' * len(states))})", list(states), lambda r: True
    s, n, w, e = geo.bbox(center[0], center[1], radius_mi)
    lim = radius_mi * geo.MI_KM
    return ("lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?", [s, n, w, e],
            lambda r: r["lat"] is not None and geo.haversine_km(center[0], center[1], r["lat"], r["lon"]) <= lim)


def side_where(side, states=None, center=None, radius_mi=None):
    """area_where for one end of a microwave link (its tx_ or rx_ columns)."""
    if states:
        return f"{side}_state IN ({','.join('?' * len(states))})", list(states), lambda r: True
    s, n, w, e = geo.bbox(center[0], center[1], radius_mi)
    lim = radius_mi * geo.MI_KM
    return (f"{side}_lat BETWEEN ? AND ? AND {side}_lon BETWEEN ? AND ?", [s, n, w, e],
            lambda r: r[f"{side}_lat"] is not None and geo.haversine_km(center[0], center[1], r[f"{side}_lat"], r[f"{side}_lon"]) <= lim)


def has_table(con, name):
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def copy_rows(src, dst, table, cols, where, args, keep, extra=None, rename=None, out_table=None, batch=5000):
    """Copy the rows of `table` in the area into the pack; extra(row) adds worked-out columns."""
    cur = src.execute(f"SELECT {', '.join(cols)} FROM {table} WHERE {where}", args)
    names = [(rename or {}).get(c, c) for c in cols]
    n, buf, ins = 0, [], None
    for r in cur:
        if not keep(r):
            continue
        vals = [r[c] for c in cols]
        add = extra(r) if extra else {}
        if ins is None:
            allc = names + list(add)
            ins = f"INSERT OR IGNORE INTO {out_table or table}({', '.join(allc)}) VALUES({', '.join('?' * len(allc))})"
        buf.append(vals + list(add.values()))
        if len(buf) >= batch:
            dst.executemany(ins, buf)
            n += len(buf)
            buf = []
    if buf:
        dst.executemany(ins, buf)
        n += len(buf)
    return n


def trimmed_bbox(con, states=None, trim=0.002, pad=0.05):
    """[s, n, w, e] around the pack's licence sites and towers (in `states`, when given), without the outer `trim`
    share each way."""
    st, args = (f" AND state IN ({','.join('?' * len(states))})", list(states)) if states else ("", [])
    pts = con.execute(f"SELECT lat, lon FROM tx WHERE lat IS NOT NULL AND lon IS NOT NULL{st} "  # the FCC has a site with only a latitude (WI)
                      f"UNION ALL SELECT lat, lon FROM tower WHERE lat IS NOT NULL AND lon IS NOT NULL{st}",
                      args * 2 if states else []).fetchall()
    if not pts:
        return None
    lats, lons = sorted(p[0] for p in pts), sorted(p[1] for p in pts)
    k = int(len(pts) * trim)
    return [round(lats[k] - pad, 5), round(lats[-1 - k] + pad, 5), round(lons[k] - pad, 5), round(lons[-1 - k] + pad, 5)]


def build(src_path, out_path, states=None, center=None, radius_mi=None, name=None, log=print, areas=None):
    """Write one pack: states, or a centre and radius, or several of those (`areas`, a list of {"states": [...]} or
    {"center": (lat, lon), "radius_mi": r, "label": "..."}). Returns its summary (counts, sizes)."""
    if not areas:
        if states:
            areas = [{"states": states}]
        elif center and radius_mi:
            areas = [{"center": center, "radius_mi": radius_mi}]
        else:
            raise ValueError("Pick states, or a centre and radius.")
    for a in areas:
        if a.get("states"):
            a["states"] = [s.strip().upper() for s in a["states"] if s.strip()]
    t0 = time.time()
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp_db = os.path.join(uls_import.DATA_DIR, "fieldpack.building.db")  # built on this PC, not in the Drive folder
    for p in (tmp_db, out_path + ".part"):
        if os.path.exists(p):
            os.remove(p)
    dst = sqlite3.connect(tmp_db)
    try:  # closed whatever happens: an open temp file would fail every pack built after a failed one
        dst.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + SCHEMA)
        # band from today's band table (rows imported before a band was added still carry the old label)
        tx_extra = lambda r: {"band": uls_import.band_for(r["freq_mhz"]), "sig_type": sigid.from_uls_mode(r["mode"]) or "Unknown"}
        bboxes = []
        for a in areas:  # rows two areas share are copied once (the pack's tables have keys; INSERT OR IGNORE)
            states, center, radius_mi = a.get("states"), a.get("center"), a.get("radius_mi")
            where, args, keep = area_where(states, center, radius_mi)
            log(f"{', '.join(states) if states else a.get('label') or f'{radius_mi:g} mi around {center[0]:.3f}, {center[1]:.3f}'}: licences...")
            copy_rows(src, dst, "tx", TX_COLS, f"({where}) AND status='A'", args, keep, extra=tx_extra)
            copy_rows(src, dst, "tower", TOWER_COLS, where, args, keep)
            # the area's extent: the circle, or where nearly all the states' sites are. FCC rows carry the odd bad
            # coordinate or wrong state (a longitude missing its minus sign, a "VA" licence in Connecticut), which would
            # stretch a VA pack across the globe, so the outer 0.2% each way is left out
            bb = trimmed_bbox(dst, states) if states else [round(v, 5) for v in geo.bbox(center[0], center[1], radius_mi)]
            if states and bb:  # licences the FCC filed with no state, sited inside the area (broadcasters' links, mostly)
                copy_rows(src, dst, "tx", TX_COLS, "(state IS NULL OR state = '') AND status='A' AND lat BETWEEN ? AND ? "
                          "AND lon BETWEEN ? AND ?", bb, lambda r: True, extra=tx_extra)
            if bb:
                bboxes.append(bb)
            if has_table(src, "bcast"):
                copy_rows(src, dst, "bcast", BCAST_COLS, f"({where}) AND status IN ('Licensed', 'Special temporary authority')", args, keep,
                          rename={"band": "kind"},
                          extra=lambda r: {"band": uls_import.band_for(r["freq_mhz"]), "sig_type": BCAST_TYPE.get(r["band"])})
            if has_table(src, "nwr"):
                copy_rows(src, dst, "nwr", NWR_COLS, where, args, keep, extra=lambda r: {"band": uls_import.band_for(r["freq_mhz"])})
            if has_table(src, "faa"):
                copy_rows(src, dst, "faa", FAA_COLS, where, args, keep,
                          extra=lambda r: {"band": uls_import.band_for(r["freq_mhz"]), "sig_type": faa.sig_type(r["freq_mhz"], r["kind"])})
            if has_table(src, "place"):
                copy_rows(src, dst, "place", "name kind state lat lon n".split(), where, args, keep)
            if has_table(src, "psap"):
                copy_rows(src, dst, "psap", PSAP_COLS, where, args, keep)
            if has_table(src, "mw_link"):  # links with either end in the area
                for side in ("tx", "rx"):
                    w, a2, k = side_where(side, states, center, radius_mi)
                    copy_rows(src, dst, "mw_link", MW_COLS, w, a2, k)
        if bboxes:  # towns are averages of licence sites, so a misfiled licence makes a stray one ("Boston, MD")
            dst.execute("DELETE FROM place WHERE NOT (" + " OR ".join(["(lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?)"] * len(bboxes)) + ")",
                        [v for b in bboxes for v in b])
        log("Indexing...")
        dst.executescript(INDEXES)
        counts = {k: dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for k, t in (("licences", "tx"), ("towers", "tower"), ("broadcast", "bcast"), ("noaa", "nwr"), ("faa", "faa"), ("places", "place"),
                               ("psap", "psap"), ("mw_links", "mw_link"))}
        bb = [min(b[0] for b in bboxes), max(b[1] for b in bboxes), min(b[2] for b in bboxes), max(b[3] for b in bboxes)] if bboxes else None

        def area_meta(a):
            if a.get("states"):
                return {"states": a["states"]}
            return {"center": [round(a["center"][0], 6), round(a["center"][1], 6)], "radius_mi": a["radius_mi"], **({"label": a["label"]} if a.get("label") else {})}

        def area_name(a):
            return ", ".join(a["states"]) if a.get("states") else a.get("label") or f"{a['center'][0]:.4f}, {a['center'][1]:.4f} ({a['radius_mi']:g} mi)"
        smeta = dict(src.execute("SELECT k, v FROM meta").fetchall()) if has_table(src, "meta") else {}
        area = area_meta(areas[0]) if len(areas) == 1 else {"areas": [area_meta(a) for a in areas]}
        name = name or " + ".join(area_name(a) for a in areas)
        meta = {
            "pack_version": PACK_VERSION, "name": name, "made_at": time.strftime("%Y-%m-%d %H:%M"), "area": area,
            "bbox": bb, "bboxes": bboxes, "counts": counts,
            "fcc_built_at": smeta.get("built_at"), "towers_built_at": smeta.get("towers_built_at"),
            "sig_lib": {k: {"family": v[0], "bw": v[1], "url": sigid.sigid_url(k), "color": v[3]} for k, v in sigid.LIBRARY.items()},
            "bands": [[lo, hi, label] for lo, hi, label in uls_import.BANDS],
            # what allows a signal no site licence explains (Part 15, Part 95, amateur, cellular, federal...)
            "authority": [list(a) for a in sigid.AUTHORITY],
            "cell_types": sorted(sigid.CELL_TYPES), "part15_types": sorted(sigid.PART15_TYPES),
            # for the full web version: the spectrum's band plan and the licence search's radio service names
            "bandplan": [{"lo": b[0], "hi": b[1], "label": b[2], "types": b[3]} for b in sigid.BAND_PLAN],
            "services": uls_import.SERVICE_NAMES,
            "psap_source_date": psap.SOURCE_DATE,  # the 911 registry's date, shown in each call centre's details
        }
        dst.executemany("INSERT INTO meta VALUES(?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
        dst.commit()
        dst.execute("VACUUM")
    finally:
        dst.close()
        src.close()

    raw, size = compress(tmp_db, out_path, log)
    out = {"name": name, "file": out_path, "counts": counts, "raw_mb": round(raw / 1e6, 1), "mb": round(size / 1e6, 1),
           "seconds": round(time.time() - t0, 1), "big": raw / 1e6 > BIG_MB}
    log(f"Done: {out['mb']} MB ({out['raw_mb']} MB unpacked) in {out['seconds']} s")
    return out


def compress(tmp_db, out_path, log=print):
    """gzip a finished database into place and remove it; returns (unpacked, packed) bytes."""
    raw = os.path.getsize(tmp_db)
    log("Compressing...")
    with open(tmp_db, "rb") as fi, gzip.open(out_path + ".part", "wb", compresslevel=6) as fo:
        shutil.copyfileobj(fi, fo, 1 << 20)
    os.replace(out_path + ".part", out_path)  # Drive syncs the finished file, never a half-written one
    os.remove(tmp_db)
    return raw, os.path.getsize(out_path)


def build_history(src_path, out_path, states=None, center=None, radius_mi=None, name=None):
    """The area's history for the web version's "FCC history (expired / removed)" layer: licences that aren't active
    (tx_old, the same columns as a pack's tx) and entries gone from the FCC's files since an earlier import
    (tx_history), as the PC's history layer shows them. Kept apart from the pack, which stays small (history is more
    than half of all FCC rows) and which the phone app reads as current licences."""
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    tmp_db = os.path.join(uls_import.DATA_DIR, "fieldpack.history.db")
    if os.path.exists(tmp_db):
        os.remove(tmp_db)
    dst = sqlite3.connect(tmp_db)
    try:
        tx_cols = SCHEMA.split("CREATE TABLE tx(", 1)[1].split(");", 1)[0]
        dst.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);"
                          f"CREATE TABLE tx_old({tx_cols});"
                          "CREATE TABLE tx_history(hkey TEXT PRIMARY KEY, call_sign TEXT, freq_mhz REAL, lat REAL, lon REAL, licensee TEXT,"
                          " service TEXT, mode TEXT, county TEXT, state TEXT, first_seen TEXT, last_seen TEXT);")
        where, args, keep = area_where(states, center, radius_mi)
        tx_extra = lambda r: {"band": uls_import.band_for(r["freq_mhz"]), "sig_type": sigid.from_uls_mode(r["mode"]) or "Unknown"}
        copy_rows(src, dst, "tx", TX_COLS, f"({where}) AND IFNULL(status,'')<>'A'", args, keep, extra=tx_extra, out_table="tx_old")
        built = (src.execute("SELECT v FROM meta WHERE k='built_at'").fetchone() or [None])[0] if has_table(src, "meta") else None
        if built and has_table(src, "tx_history"):  # entries gone since an earlier import
            copy_rows(src, dst, "tx_history", HIST_COLS, f"({where}) AND last_seen < ?", args + [built], keep)
        dst.executescript("CREATE INDEX txo_latlon ON tx_old(lat, lon); CREATE INDEX txo_freq ON tx_old(freq_mhz);"
                          "CREATE INDEX txh_latlon ON tx_history(lat, lon);")
        counts = {"licences": dst.execute("SELECT COUNT(*) FROM tx_old").fetchone()[0],
                  "removed": dst.execute("SELECT COUNT(*) FROM tx_history").fetchone()[0]}
        meta = {"kind": "history", "pack_version": PACK_VERSION, "name": name or ", ".join(states or []),
                "made_at": time.strftime("%Y-%m-%d %H:%M"), "built_at": built, "counts": counts}
        dst.executemany("INSERT INTO meta VALUES(?, ?)", [(k, json.dumps(v)) for k, v in meta.items()])
        dst.commit()
        dst.execute("VACUUM")
    finally:
        dst.close()
        src.close()
    raw, size = compress(tmp_db, out_path, log=lambda *a: None)
    return {"file": out_path, "counts": counts, "raw_mb": round(raw / 1e6, 1), "mb": round(size / 1e6, 1)}


def build_grantee(src_path, out_path):
    """The FCC's equipment-maker (grantee) codes, one file for every area: what an FCC ID look-up names offline."""
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    tmp_db = os.path.join(uls_import.DATA_DIR, "fieldpack.grantee.db")
    if os.path.exists(tmp_db):
        os.remove(tmp_db)
    dst = sqlite3.connect(tmp_db)
    try:
        dst.executescript("PRAGMA journal_mode=OFF; CREATE TABLE fcc_grantee(code TEXT PRIMARY KEY, name TEXT, address TEXT,"
                          " city TEXT, state TEXT, country TEXT, zip TEXT, received TEXT);")
        n = copy_rows(src, dst, "fcc_grantee", GRANTEE_COLS, "1", [], lambda r: True) if has_table(src, "fcc_grantee") else 0
        if has_table(src, "fcc_grantee_src"):  # which list it is (fccid.grantee_source): open data, or the FCC's own download
            dst.execute("CREATE TABLE fcc_grantee_src(id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT, file TEXT, at TEXT, codes INTEGER)")
            dst.executemany("INSERT INTO fcc_grantee_src VALUES(?,?,?,?,?)",
                            [tuple(r) for r in src.execute("SELECT id, source, file, at, codes FROM fcc_grantee_src")])
        dst.commit()
        dst.execute("VACUUM")
    finally:
        dst.close()
        src.close()
    raw, size = compress(tmp_db, out_path, log=lambda *a: None)
    return {"file": out_path, "codes": n, "mb": round(size / 1e6, 1)}


def safe_name(s):
    return "".join(c if c.isalnum() or c in " ,.-()" else "_" for c in s).strip() or "pack"


def list_packs(folder=PACK_DIR):
    if not os.path.isdir(folder):
        return []
    return [{"file": f, "mb": round(os.path.getsize(os.path.join(folder, f)) / 1e6, 1),
             "made": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(os.path.join(folder, f))))}
            for f in sorted(os.listdir(folder)) if f.endswith(".rfpack")]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=uls_import.DB_PATH)
    ap.add_argument("--states", help="comma-separated, e.g. VA,MD,DC")
    ap.add_argument("--center", help="lat,lon")
    ap.add_argument("--radius", type=float, help="miles around --center")
    ap.add_argument("--circle", action="append", default=[], metavar="LAT,LON,MILES[,LABEL]",
                    help="an area around a point; repeat it, and add --states, for one pack of several areas")
    ap.add_argument("--name")
    ap.add_argument("--out", help=f"file to write (default: {PACK_DIR}\\<name>.rfpack)")
    a = ap.parse_args()
    areas = [{"states": a.states.split(",")}] if a.states else []
    if a.center and a.radius:
        areas.append({"center": tuple(float(x) for x in a.center.split(",")), "radius_mi": a.radius})
    for c in a.circle:
        p = [x.strip() for x in c.split(",", 3)]
        areas.append({"center": (float(p[0]), float(p[1])), "radius_mi": float(p[2]), **({"label": p[3]} if len(p) > 3 else {})})
    if not areas:
        ap.error("give --states, --center and --radius, or --circle")
    name = a.name or " + ".join(", ".join(x["states"]).upper() if x.get("states") else x.get("label") or
                                f"{x['center'][0]:.3f}, {x['center'][1]:.3f} {x['radius_mi']:g} mi" for x in areas)
    out = a.out or os.path.join(PACK_DIR, f"RF Recon pack - {safe_name(name)}.rfpack")
    r = build(a.db, out, name=name, areas=areas)
    print(json.dumps(r, indent=1))
    if r["big"]:
        print(f"Note: {r['raw_mb']} MB unpacked is large for a phone; a radius pack keeps it smaller.")


if __name__ == "__main__":
    main()
