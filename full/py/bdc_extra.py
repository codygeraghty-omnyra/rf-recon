"""
The rest of the FCC Broadband Data Collection that helps RF work, beside the carrier hexagons in bdc.py (same API,
same key, same bdc.db):

  provider list     every provider id with its holding company (names the carriers and fixed wireless operators)
  link budgets      what each mobile and fixed wireless provider filed about how it modelled coverage: frequency,
                    bandwidth, antenna configuration, target speed, and the propagation tool, terrain and clutter
                    data, receiver height and calibration (Supporting Data)
  coverage checks   the FCC's resolved mobile challenges, verifications and audits: where a carrier's claimed
                    coverage was tested on the ground and what was found (H3 resolution-8 cells, about 0.7 km2)
  fixed wireless    who offers licensed, unlicensed and LBR fixed wireless where, and the best advertised speeds,
                    counted per H3 resolution-8 cell from the FCC's location files

Places are H3 resolution-8 cells. RF Recon keeps no H3 library: the carrier hexagons (bdc.py) are resolution 9,
and a resolution-9 cell's parent is a bit operation (parent8), so a spot's cell is the parent of its nearest
carrier hexagon. Left out on purpose: wired fixed broadband (cable, fiber, copper, satellite), the summaries, the
raw coverage polygons (about 82 GB), the Funding Map, and Location Fabric points (licensed by CostQuest).
The API allows 10 calls a minute; every call here waits its turn.
"""
import csv
import io
import json
import os
import time
import zipfile

import bdc

SCHEMA = """
CREATE TABLE IF NOT EXISTS bdc_holding(provider INTEGER PRIMARY KEY, holding TEXT, frn TEXT);
CREATE TABLE IF NOT EXISTS bdc_link_budget(provider INTEGER, tech_code INTEGER, link_budget_id TEXT, direction TEXT,
    freq_mhz REAL, bw_mhz REAL, antenna TEXT, target_speed TEXT, morphology TEXT, model_id TEXT, raw TEXT);
CREATE INDEX IF NOT EXISTS bdc_lb_p ON bdc_link_budget(provider, tech_code);
CREATE TABLE IF NOT EXISTS bdc_prop_model(provider INTEGER, tech_code INTEGER, model_id TEXT, tool TEXT, developer TEXT,
    resolution_m REAL, rx_height_m REAL, terrain TEXT, clutter TEXT, calibrated INTEGER, calibration_date TEXT, calibration TEXT);
CREATE INDEX IF NOT EXISTS bdc_pm_p ON bdc_prop_model(provider, tech_code);
CREATE TABLE IF NOT EXISTS bdc_check(kind TEXT, h3_8 INTEGER, state TEXT, provider INTEGER, brand TEXT, tech INTEGER,
    down INTEGER, up INTEGER, setting TEXT, outcome TEXT, detail TEXT, date TEXT, vintage TEXT);
CREATE INDEX IF NOT EXISTS bdc_check_h ON bdc_check(h3_8);
CREATE TABLE IF NOT EXISTS bdc_fw(h3_8 INTEGER, provider INTEGER, brand TEXT, tech INTEGER, down INTEGER, up INTEGER,
    locations INTEGER, PRIMARY KEY(h3_8, provider, tech)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bdc_extra_file(file_id TEXT PRIMARY KEY, kind TEXT, as_of TEXT, rows INTEGER, loaded_at TEXT);
"""
MOBILE_TECH = {300, 400, 500}
FW_TECH = {70: "Unlicensed fixed wireless", 71: "Licensed fixed wireless", 72: "LBR fixed wireless"}
CHECKS = {"Mobile Challenge - Resolved": "challenge", "Mobile Verification - Resolved": "verification",
          "Mobile Audit - Resolved": "audit"}
GAP_S = 6.5  # 10 calls a minute


def parent8(h3_9):
    """The resolution-8 parent of a resolution-9 H3 cell (an int): resolution field 8, the ninth digit unused (7)."""
    return (h3_9 & ~(0xF << 52)) | (8 << 52) | (7 << 18)


def _int(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return None


def _float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class Api:
    """bdc's API with the 10-calls-a-minute pace kept."""

    def __init__(self, creds):
        self.creds, self.last = creds, 0.0

    def _wait(self):
        d = time.time() - self.last
        if d < GAP_S:
            time.sleep(GAP_S - d)
        self.last = time.time()

    def json(self, path):
        self._wait()
        return bdc._get(path, self.creds)

    def file(self, kind, file_id):
        """One downloaded file's bytes (kind: availability or challenge); small enough to hold (largest about 300 MB)."""
        for k in range(3):
            self._wait()
            try:
                with bdc._get(f"/downloads/downloadFile/{kind}/{file_id}", self.creds, raw=True) as r:
                    data = r.read()
                if zipfile.is_zipfile(io.BytesIO(data)):
                    return data
            except OSError:
                pass
            time.sleep(15 * (k + 1))
        raise RuntimeError(f"file {file_id} didn't download whole")


def _csvs(data):
    """Each CSV inside a zip (by name) with its dict rows, read as they're used: read them before taking the next CSV.
    Streamed because a big state's fixed wireless file is millions of rows; held as a list it took the server's
    4 GB and the out-of-memory killer stopped it (11/3)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for n in z.namelist():
            if n.lower().endswith(".csv"):
                with z.open(n) as fh:
                    yield n.lower(), csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace"))


def _done(con, fid):
    return con.execute("SELECT 1 FROM bdc_extra_file WHERE file_id=?", (str(fid),)).fetchone() is not None


def _mark(con, fid, kind, as_of, n):
    con.execute("INSERT OR REPLACE INTO bdc_extra_file VALUES(?,?,?,?,?)", (str(fid), kind, as_of, n, time.strftime("%Y-%m-%d %H:%M")))
    con.commit()


def load_support(con, data):
    """A provider's Supporting Data zip: link budgets and propagation model details."""
    n = 0
    assoc = {}
    for name, rows in _csvs(data):
        if "link_budget_association" in name:
            assoc.update({r.get("link_budget_id"): r.get("model_id") for r in rows})
    for name, rows in _csvs(data):
        if "link_budget_parameters" in name:
            for r in rows:
                con.execute("INSERT INTO bdc_link_budget VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            (_int(r.get("provider_id")), _int(r.get("technology_code")), r.get("link_budget_id"), r.get("link_direction"),
                             _float(r.get("operational_frequency")), _float(r.get("channel_bandwidth")), r.get("antenna_configuration"),
                             r.get("target_speed"), r.get("morphology"), assoc.get(r.get("link_budget_id")), json.dumps(r)))
                n += 1
        elif "propagation_model_details" in name:
            for r in rows:
                con.execute("INSERT INTO bdc_prop_model VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            (_int(r.get("provider_id")), _int(r.get("technology_code")), r.get("model_id"), r.get("tool_name"),
                             r.get("tool_developer"), _float(r.get("model_resolution")), _float(r.get("receiver_height")),
                             " ".join(x for x in (r.get("terrain_source"), r.get("terrain_vintage")) if x),
                             " ".join(x for x in (r.get("clutter_source"), r.get("clutter_vintage")) if x),
                             _int(r.get("calibration_flag")), r.get("calibration_date"), (r.get("calibration_process") or "").strip()[:600]))
                n += 1
    return n


def load_checks(con, kind, data):
    n = 0
    for _, rows in _csvs(data):
        for r in rows:
            cell = r.get("h3_cell_id") or ""
            if not cell or str(r.get("h3_resolution")) != "8":
                continue
            con.execute("INSERT INTO bdc_check VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (kind, int(cell, 16), r.get("h3_cell_state"), _int(r.get("provider_id")),
                         r.get("provider_brand_name") or r.get("holding_company_name"), _int(r.get("technology")),
                         _int(r.get("minimum_download_speed")), _int(r.get("minimum_upload_speed")),
                         r.get("environment") or r.get("challenge_type"), r.get("outcome"), r.get("outcome_detail"),
                         r.get("adjudication_date") or r.get("verification_date") or r.get("challenge_date"), r.get("data_vintage")))
            n += 1
    return n


def load_fw(con, data):
    """A state's fixed wireless location file, counted per (cell, provider, technology) with the best speeds."""
    agg = {}
    for _, rows in _csvs(data):
        for r in rows:
            cell, tech = r.get("h3_res8_id") or "", _int(r.get("technology"))
            if not cell or tech not in FW_TECH:
                continue
            k = (int(cell, 16), _int(r.get("provider_id")), tech)
            a = agg.get(k)
            down, up = _int(r.get("max_advertised_download_speed")) or 0, _int(r.get("max_advertised_upload_speed")) or 0
            if a is None:
                agg[k] = [r.get("brand_name"), down, up, 1]
            else:
                a[1], a[2], a[3] = max(a[1], down), max(a[2], up), a[3] + 1
    for (cell, p, tech), (brand, down, up, cnt) in agg.items():
        con.execute("""INSERT INTO bdc_fw VALUES(?,?,?,?,?,?,?) ON CONFLICT(h3_8, provider, tech) DO UPDATE SET
                       down=max(down, excluded.down), up=max(up, excluded.up), locations=locations+excluded.locations""",
                    (cell, p, brand, tech, down, up, cnt))
    return len(agg)


def run(data_dir, creds, log=print):
    """Bring the extras up to the newest release. Files already loaded aren't fetched again; a new release
    replaces the availability-based tables (link budgets, fixed wireless, providers)."""
    api = Api(creds)
    con = bdc.connect(data_dir)
    con.executescript(SCHEMA)
    out = {}
    try:
        dates = api.json("/listAsOfDates")["data"]
        as_of = max(d["as_of_date"] for d in dates if d.get("data_type") == "availability")
        old = con.execute("SELECT DISTINCT as_of FROM bdc_extra_file WHERE kind IN ('support','fw','providers') AND as_of<>?", (as_of,)).fetchall()
        if old:  # a new release: these tables are rebuilt from it
            log(f"new release {as_of}: replacing link budgets, fixed wireless and providers")
            for t in ("bdc_link_budget", "bdc_prop_model", "bdc_fw", "bdc_holding"):
                con.execute(f"DELETE FROM {t}")
            con.execute("DELETE FROM bdc_extra_file WHERE kind IN ('support','fw','providers')")
            con.commit()
        files = api.json(f"/downloads/listAvailabilityData/{as_of}")["data"]
        plist = [f for f in files if f.get("subcategory") == "Provider List"]
        support = [f for f in files if f.get("subcategory") == "Supporting Data"
                   and (_int(f.get("technology_code")) in MOBILE_TECH | set(FW_TECH) or f.get("technology_type") in ("Mobile Broadband", "Mobile Voice"))]
        fw = [f for f in files if (f.get("category"), f.get("subcategory")) == ("State", "Location Coverage") and _int(f.get("technology_code")) in FW_TECH]
        for f in plist[:1]:
            if not _done(con, f["file_id"]):
                for _, rows in _csvs(api.file("availability", f["file_id"])):
                    con.executemany("INSERT OR REPLACE INTO bdc_holding VALUES(?,?,?)",
                                    [(_int(r.get("provider_id")), r.get("holding_company"), r.get("frn")) for r in rows])
                _mark(con, f["file_id"], "providers", as_of, con.execute("SELECT COUNT(*) FROM bdc_holding").fetchone()[0])
        todo = [f for f in support if not _done(con, f["file_id"])]
        for i, f in enumerate(todo, 1):
            try:
                n = load_support(con, api.file("availability", f["file_id"]))
                _mark(con, f["file_id"], "support", as_of, n)
            except Exception as e:  # one provider's file failing doesn't stop the rest
                log(f"link budget file {f['file_id']}: {e}")
            if i % 10 == 0:
                log(f"link budgets {i}/{len(todo)} files")
        todo = [f for f in fw if not _done(con, f["file_id"])]
        for i, f in enumerate(todo, 1):
            n = load_fw(con, api.file("availability", f["file_id"]))
            _mark(con, f["file_id"], "fw", as_of, n)
            log(f"fixed wireless {i}/{len(todo)} state files")
        out["release"] = as_of
        # coverage checks: every month's resolved files (each date holds what was resolved that month)
        cdates = sorted({d["as_of_date"] for d in dates if d.get("data_type") == "challenge"})
        for j, d in enumerate(cdates, 1):
            if con.execute("SELECT 1 FROM bdc_extra_file WHERE file_id=?", (f"list:{d}",)).fetchone():
                continue
            rows = api.json(f"/downloads/listChallengeData/{d}")["data"]
            for f in rows:
                kind = CHECKS.get(f.get("category"))
                if kind and not _done(con, f["file_id"]):
                    _mark(con, f["file_id"], kind, d, load_checks(con, kind, api.file("challenge", f["file_id"])))
            if d != cdates[-1]:  # the newest month can still gain files: listed again next run
                _mark(con, f"list:{d}", "list", d, len(rows))
            log(f"coverage checks {j}/{len(cdates)} months")
        for k, t in (("providers", "bdc_holding"), ("link_budgets", "bdc_link_budget"), ("checks", "bdc_check"), ("fixed_wireless_cells", "bdc_fw")):
            out[k] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        return out
    finally:
        con.close()


def near(data_dir, lat, lon):
    """What the extras say about one spot: the FCC's coverage checks in its cell and the fixed wireless offered there.
    The cell is the parent of the nearest carrier hexagon (no carrier coverage loaded nearby: no cell, nothing)."""
    if not os.path.exists(bdc.db_path(data_dir)) or bdc.reloading(data_dir):
        return {"cell": None, "checks": [], "fixed_wireless": []}
    con = bdc.connect(data_dir)
    try:
        con.executescript(SCHEMA)
        s, n, w, e = bdc._box(lat, lon, 0.3)
        best = None
        for r in con.execute("SELECT h3, lat, lon FROM bdc_hex WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND h3 IS NOT NULL", (s, n, w, e)):
            d = (r[1] - lat) ** 2 + ((r[2] - lon) * 0.8) ** 2
            if best is None or d < best[0]:
                best = (d, r[0])
        if best is None:
            return {"cell": None, "checks": [], "fixed_wireless": []}
        cell = parent8(best[1])
        names = {r[0]: r[1] for r in con.execute("SELECT provider, holding FROM bdc_holding")}
        checks = [{"kind": r[0], "carrier": r[1] or names.get(r[2]) or str(r[2]), "tech": bdc.TECH.get(r[3], str(r[3])),
                   "speed": f"{r[4]}/{r[5]}" if r[4] is not None else None, "setting": r[6], "outcome": r[7], "detail": r[8], "date": r[9]}
                  for r in con.execute("SELECT kind, brand, provider, tech, down, up, setting, outcome, detail, date FROM bdc_check WHERE h3_8=? ORDER BY date DESC", (cell,))]
        fw = [{"provider": r[0] or names.get(r[1]) or str(r[1]), "holding": names.get(r[1]), "tech": FW_TECH.get(r[2], str(r[2])),
               "down": r[3], "up": r[4], "locations": r[5]}
              for r in con.execute("SELECT brand, provider, tech, down, up, locations FROM bdc_fw WHERE h3_8=? ORDER BY locations DESC", (cell,))]
        return {"cell": format(cell, "x"), "checks": checks, "fixed_wireless": fw}
    finally:
        con.close()


def modelled(data_dir, provider):
    """How a provider says it modelled its coverage: its propagation tools and the frequencies in its link budgets."""
    if not os.path.exists(bdc.db_path(data_dir)):
        return {"models": [], "frequencies": []}
    con = bdc.connect(data_dir)
    try:
        con.executescript(SCHEMA)
        models = [{"tech": bdc.TECH.get(r[0], str(r[0])), "model": r[1], "tool": r[2], "developer": r[3], "resolution_m": r[4],
                   "rx_height_m": r[5], "terrain": r[6], "clutter": r[7], "calibrated": bool(r[8]), "calibration_date": r[9]}
                  for r in con.execute("""SELECT tech_code, model_id, tool, developer, resolution_m, rx_height_m, terrain, clutter, calibrated,
                                          calibration_date FROM bdc_prop_model WHERE provider=? ORDER BY tech_code""", (provider,))]
        freqs = [{"tech": bdc.TECH.get(r[0], str(r[0])), "direction": {"D": "down", "U": "up"}.get(r[1], r[1]), "mhz": r[2], "bw_mhz": r[3], "budgets": r[4]}
                 for r in con.execute("""SELECT tech_code, direction, freq_mhz, bw_mhz, COUNT(*) FROM bdc_link_budget WHERE provider=? AND freq_mhz IS NOT NULL
                                         GROUP BY tech_code, direction, freq_mhz, bw_mhz ORDER BY tech_code, freq_mhz""", (provider,))]
        return {"models": models, "frequencies": freqs}
    finally:
        con.close()
