"""
Connection detection + background auto-update of every data source.

Sources and their per-source settings live in the `setting` table:
  update.auto            master switch (all enabled sources)
  update.wifi_only       skip updates on cellular / metered links
  update.sources         {source_id: {"enabled": bool, "interval_h": n}}
FCC sources update nationwide (or for the configured states); crowd sources
update for the active mission's area (and any mission marked auto_refresh).
Enabled sources that are due run in parallel.
"""
import json
import os
import platform
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import build
import uls_import

SOURCES = {
    # id: (label, kind, default interval hours, description)
    "uls:LMpriv": ("FCC ULS: Private land mobile", "fcc", 168, "Public safety, business/industrial"),
    "uls:LMcomm": ("FCC ULS: Commercial land mobile", "fcc", 168, "Commercial IB, SMR"),
    "uls:LMbcast": ("FCC ULS: Broadcast auxiliary", "fcc", 168, "Remote pickup, STL"),
    "uls:paging": ("FCC ULS: Paging", "fcc", 168, "Paging and radiotelephone"),
    "uls:coast": ("FCC ULS: Marine & aviation ground", "fcc", 168, "Coast and ground stations"),
    "uls:micro": ("FCC ULS: Microwave", "fcc", 168, "Point-to-point links (large file)"),
    "mw_pending": ("FCC microwave applications (pending)", "fcc", 168, "Links filed but not yet granted (about 445 MB download)"),
    "asr": ("FCC Antenna Structures (towers)", "fcc", 168, "Registered towers and heights"),
    "bcast": ("FCC broadcast stations (AM / FM / TV)", "fcc", 168, "AM, FM, TV, low-power and translators"),
    "nwr": ("NOAA Weather Radio transmitters", "reference", 168, "~1,000 transmitters and the counties each one warns"),
    "faa": ("FAA aviation frequencies (NASR)", "reference", 168, "Towers, ATIS, approach, CTAF, navaids, ILS; new cycle every 28 days"),
    "wigle": ("WiGLE (Wi-Fi/BT/cell)", "crowd", 168, "Needs your WiGLE API name + token"),
    "opencellid": ("OpenCelliD (cell towers)", "crowd", 336, "Needs your OpenCelliD key"),
    "repeaterbook": ("RepeaterBook (repeaters)", "crowd", 336, "Needs a RepeaterBook token, which Your API keys doesn't take (RepeaterBook's policy discourages tools that mix sources)"),
    "sigwiki": ("Signal ID Wiki catalog", "reference", 720, "What a signal could be: ~600 signals, modes, bandwidths"),
    "fss": ("FCC satellite earth stations (C-band)", "fcc", 168, "About 470 protected receive sites, 3.6 to 4.2 GHz, with where each dish points"),
    "psap": ("FCC 911 PSAP registry (911 call centres)", "reference", 720, "About 8,600 call centres at town level; the FCC last updated its rows in 2017"),
    "grantee": ("FCC equipment grantee codes", "reference", 2160, "Every company code that starts an FCC ID, with its name and address: the FCC's own current list from the RF Recon site (FCC open data of March 2021 if the site can't be reached)"),
    "artemis": ("Artemis signal database (waterfalls and audio)", "reference", 720, "A waterfall picture and an audio clip for each Signal ID Wiki signal, shown beside its matches (Ares Valley; about 300 MB; checked monthly, downloaded only when there's a new release)"),
    "bdc": ("FCC carrier coverage (Broadband Map)", "fcc", 720, "Each carrier's modelled 3G / 4G / 5G coverage and signal, for the carrier-coverage states; new release twice a year"),
    "bdc_extra": ("FCC broadband extras (coverage checks, fixed wireless, link budgets)", "fcc", 720, "The FCC's resolved coverage challenges, verifications and audits, who offers fixed wireless where, and each carrier's filed link budgets and propagation tools (about 2.5 GB of download a release, about 1 GB kept)"),
    "ttn": ("The Things Network LoRaWAN gateways", "crowd", 168, "Gateways near the area (no key)"),
    "satnogs": ("SatNOGS satellite ground stations", "crowd", 720, "Ground stations and their antennas (no key)"),
    "wspr": ("WSPR stations (wspr.live)", "crowd", 24, "Stations heard or transmitting in the last 24 h (no key)"),
    "pskreporter": ("PSKReporter monitors", "crowd", 24, "Digital-mode monitors and stations heard in the last hour (no key)"),
    "meshtastic": ("Meshtastic mesh radios (meshmap.net)", "crowd", 24, "Mesh radios that share their position (no key; a 4 MB list)"),
    "tiles": ("Map tiles + terrain for mission areas", "reference", 720, "The four USGS base maps (to zoom 16; shaded relief to zoom 13) and terrain for each mission area, kept for use with no signal (about 1.3 GB an area; tiles already kept aren't fetched again)"),
    "das_prospects": ("DAS prospect lists (schools, colleges, hospitals, malls, arenas, hotels, high-rises and more)", "reference", 720, "Buildings that often need emergency responder radio coverage, with phones, websites and emails where published: NCES schools, IPEDS colleges, CMS hospitals (US government, public domain); malls, stadiums and arenas, hotels, venues, casinos, airports, transit, government buildings, warehouses and parking garages from Overture Maps places (CDLA-Permissive-2.0 / Apache-2.0 / CC0); high-rises around each mission area from Overture buildings (ODbL)"),
    "part_prices": ("DAS part prices (price list links, Mouser, Digi-Key)", "reference", 168, "Each supplier's price list re-read from its link, and the online prices of the parts on open requests for quote (Mouser and Digi-Key, with your keys)"),
    "helium": ("Helium IoT hotspots", "crowd", 168, "Active LoRaWAN hotspots (no key; reads the whole network, about 190 MB a pass)"),
    "usfa_fd": ("USFA fire department registry (DAS AHJ guess)", "reference", 720, "27,117 fire departments and 8,092 stations with addresses, phones and websites, for a DAS job's AHJ guess (US government; about 12 MB; frozen since June 2026)"),
}
DEFAULT_ENABLED = {"usfa_fd", "part_prices", "das_prospects","uls:LMpriv", "uls:LMcomm", "uls:LMbcast", "uls:paging", "uls:coast", "asr", "bcast", "nwr", "faa", "sigwiki",
                   "ttn", "satnogs", "wspr", "pskreporter", "psap", "grantee", "fss", "meshtastic"}
AFTER_ULS = {"psap"}  # placed at town centres from the place list the licence import builds
LINKS = ("wifi", "ethernet", "cellular")
LINK_NAMES = {"wifi": "Wi-Fi", "ethernet": "Ethernet", "cellular": "cellular / phone tether"}
# what each source needs, costs and allows, and the open / crowd sources RF Recon doesn't use (checked 2026-10-28)
CATALOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference", "data_sources.json")


def catalog():
    try:
        with open(CATALOG_FILE, encoding="utf-8") as fh:
            return json.load(fh)["sources"]
    except (OSError, ValueError, KeyError):
        return []


# ---------------------------------------------------------------- connectivity

NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # powershell/netsh probes run without flashing a console


def _run(cmd, timeout=4):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=NO_WINDOW).stdout
    except Exception:
        return ""


def interface_info():
    """Best-effort: which interface carries the default route and what kind it is."""
    sysname = platform.system()
    iface, kind = None, "unknown"
    try:
        if sysname == "Linux":
            with open("/proc/net/route") as fh:
                for line in fh.readlines()[1:]:
                    p = line.split()
                    if p[1] == "00000000":
                        iface = p[0]
                        break
            if iface:
                if os.path.exists(f"/sys/class/net/{iface}/wireless") or iface.startswith(("wl", "wlan")):
                    kind = "wifi"
                elif iface.startswith(("wwan", "rmnet", "ppp", "usb", "enx")) or "wwan" in iface:
                    kind = "cellular"
                elif iface.startswith(("eth", "en", "eno", "ens", "enp")):
                    kind = "ethernet"
                elif iface.startswith(("tun", "tap", "wg", "vpn")):
                    kind = "vpn"
        elif sysname == "Darwin":
            out = _run(["route", "-n", "get", "default"])
            m = re.search(r"interface:\s*(\S+)", out)
            iface = m.group(1) if m else None
            ports = _run(["networksetup", "-listallhardwareports"])
            for block in ports.split("\n\n"):
                if iface and f"Device: {iface}" in block:
                    if "Wi-Fi" in block or "AirPort" in block:
                        kind = "wifi"
                    elif "iPhone" in block or "Bluetooth PAN" in block or "USB" in block and "LAN" not in block:
                        kind = "cellular"
                    else:
                        kind = "ethernet"
        elif sysname == "Windows":
            # Adapter on the default route. A phone tethered over USB reports as wired (Remote NDIS),
            # so the description decides, not the media type.
            route = _run(["powershell", "-NoProfile", "-Command",
                          "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | "
                          "Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1; "
                          "if ($r) { $a = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex; "
                          "$a.Name + '|' + $a.InterfaceDescription + '|' + $a.NdisPhysicalMedium }"], timeout=10)
            name, desc, medium = (route.strip().split("|") + ["", "", ""])[:3]
            desc = desc.lower()
            out = _run(["netsh", "wlan", "show", "interfaces"])
            if name and (medium == "8" or re.search(r"remote ndis|rndis|mobile|iphone|android|tether|wwan|broadband|cellular", desc)):
                iface, kind = name, "cellular"
            elif name and medium != "9" and not re.search(r"wi-?fi|wireless|802\.11|wlan", desc):
                iface, kind = name, "ethernet"
            elif re.search(r"State\s*:\s*connected", out, re.I):
                kind = "wifi"
                m = re.search(r"SSID\s*:\s*(.+)", out)
                iface = (m.group(1).strip() if m else "Wi-Fi")
            else:
                mb = _run(["netsh", "mbn", "show", "interfaces"])
                kind = "cellular" if re.search(r"State\s*:\s*connected", mb, re.I) else "ethernet"
    except Exception:
        pass
    return {"interface": iface, "kind": kind, "os": sysname}


def check_online(timeout=5):
    t0 = time.time()
    try:
        req = urllib.request.Request("https://data.fcc.gov/", method="HEAD", headers={"User-Agent": "RF-Recon"})
        urllib.request.urlopen(req, timeout=timeout)
        return True, round((time.time() - t0) * 1000)
    except urllib.error.HTTPError:
        return True, round((time.time() - t0) * 1000)  # reachable, just not happy with HEAD
    except Exception:
        try:
            socket.create_connection(("1.1.1.1", 443), timeout=timeout).close()
            return True, round((time.time() - t0) * 1000)
        except Exception:
            return False, None


def remote_modified(url):
    return uls_import.last_modified(url)  # falls back to curl where the FCC refuses Python's requests


# ---------------------------------------------------------------- updater

class Updater:
    def __init__(self, db_path, crowd_path, get_setting, set_setting, active_area):
        self.db, self.crowd = db_path, crowd_path
        self.get, self.set = get_setting, set_setting
        self.active_area = active_area  # () -> list of (lat, lon, radius_mi, state)
        self.status = {sid: {"state": "idle", "message": "", "last_checked": None, "last_updated": None,
                             "rows": None, "remote": None} for sid in SOURCES}
        self.net = {"online": None, "latency_ms": None, "checked": None, **interface_info()}
        self.client_hint = {}  # what the browser reports (e.g. Network Information API)
        self.lock = threading.Lock()
        self.running = set()
        self._net_checking = False
        self._load()

    # persisted status
    def _load(self):
        saved = self.get("update.status", {}) or {}
        for sid, st in saved.items():
            if sid in self.status:
                self.status[sid].update({k: v for k, v in st.items() if k != "state"})

    def _save(self):
        """Keep the status across restarts. Best effort: while a rebuild holds the database's write lock this can fail,
        and on 11/2 that failure escaped a job's error handler and stopped the server's whole update queue."""
        try:
            self.set("update.status", {sid: {k: v for k, v in st.items() if k != "state"} for sid, st in self.status.items()})
        except sqlite3.Error:
            pass  # the in-memory status is current; the next save writes it

    def config(self):
        cfg = self.get("update.sources", {}) or {}
        out = {}
        for sid, (label, kind, hours, desc) in SOURCES.items():
            c = cfg.get(sid, {})
            out[sid] = {"label": label, "kind": kind, "description": desc,
                        "enabled": build.allowed(sid) and c.get("enabled", sid in DEFAULT_ENABLED),
                        "interval_h": c.get("interval_h", hours)}
            if not build.allowed(sid):
                out[sid]["personal_only"] = build.PERSONAL_ONLY[sid]
        return out

    def links(self):
        """The connections updates may use: any of wifi, ethernet, cellular (a phone tether counts as cellular).
        Before 10/28 this was one switch, "only on Wi-Fi / Ethernet"."""
        got = self.get("update.links")
        if isinstance(got, list):
            return [k for k in LINKS if k in got] or ["wifi", "ethernet"]
        return ["wifi", "ethernet"] if self.get("update.wifi_only", True) else list(LINKS)

    def link_allowed(self):
        kind = self.link_kind()
        return (kind if kind in LINKS else "ethernet") in self.links()  # a VPN or an unknown adapter counts as wired

    def refresh_net(self):
        online, ms = check_online()
        self.net.update(online=online, latency_ms=ms, checked=time.strftime("%Y-%m-%d %H:%M:%S"), **interface_info())
        return self.net

    def refresh_net_if_stale(self):
        """Re-check in the background once the last check is old: 15 s while offline, 2 min while online.
        Without this a brief dropout left the card on Offline until the next 10-minute tick (or for good
        with --no-auto)."""
        last = self.net.get("checked")
        age = time.time() - time.mktime(time.strptime(last, "%Y-%m-%d %H:%M:%S")) if last else 1e9
        if self._net_checking or age < (120 if self.net.get("online") else 15):
            return
        self._net_checking = True

        def run():
            try:
                self.refresh_net()
            finally:
                self._net_checking = False
        threading.Thread(target=run, daemon=True).start()

    def link_kind(self):
        hint = (self.client_hint.get("type") or "").lower()
        if hint in ("cellular", "wifi", "ethernet"):
            return hint
        return self.net.get("kind", "unknown")

    def data_dates(self):
        """When each source's data was built, from the databases themselves, so data loaded outside the updater
        (the first import, a hand run) doesn't show as 'never'."""
        out = {}
        try:
            con = sqlite3.connect(self.db, timeout=5)
            meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
            con.close()
            loaded = meta.get("sources") or ""
            out = {sid: meta.get("built_at") for sid in SOURCES if sid.startswith("uls:") and f"l_{sid[4:]}.zip" in loaded}
            out.update(asr=meta.get("towers_built_at"), bcast=meta.get("bcast_built_at"), nwr=meta.get("nwr_built_at"),
                       faa=meta.get("faa_built_at"), psap=meta.get("psap_built_at"),
                       fss=meta.get("fss_built_at"), mw_pending=meta.get("mw_pending_built_at"))
            con = sqlite3.connect(self.crowd, timeout=5)
            out["sigwiki"] = con.execute("SELECT MAX(fetched_at) FROM sigwiki").fetchone()[0]
            con.close()
        except sqlite3.Error:
            pass
        try:  # Artemis: the release unpacked on this PC, by hand or by the updater
            import artemis
            st = artemis.status()
            if st.get("installed"):
                out["artemis"] = f"release v{st['version']} ({st['date']})"
        except (sqlite3.Error, OSError):
            pass
        return {k: v for k, v in out.items() if v}

    def snapshot(self):
        built = self.data_dates()
        cat = catalog()
        by = {sid: c for c in cat for sid in c.get("updater", [])}
        creds = self.get("creds", {}) or {}
        auto, link = bool(self.get("update.auto", False)), self.link_kind()
        src = {}
        for sid, c in self.config().items():
            s = dict(c, **self.status[sid], running=sid in self.running)
            if not s.get("last_updated") and built.get(sid):
                s.update(last_updated=built[sid], message=s.get("message") or "loaded outside the updater")
            a = by.get(sid, {})
            need = a.get("keys") or []
            s["access"] = {k: a.get(k) for k in ("name", "key", "cost", "terms", "signup", "where_key", "url")}
            s["access"].update(needs_key=bool(need), key_saved=bool(need) and all(creds.get(k) for k in need))
            s["why"] = self._why(s, a, need, creds, auto, link)
            src[sid] = s
        return {"auto": auto, "links": self.links(), "wifi_only": "cellular" not in self.links(),
                "net": self.net, "client_hint": self.client_hint, "link": link, "sources": src,
                "catalog": [c for c in cat if not c.get("updater")], "archive": bool(self.get("update.archive", False))}

    def archive(self, path):
        """Each week's FCC files kept in fcc-archive/ when update.archive is on (the server, Cody 11/2)."""
        if self.get("update.archive", False):
            uls_import.archive(path, log=lambda m: self._mark([], message=m))

    def _why(self, s, a, need, creds, auto, link):
        """Why a source isn't downloading right now, in a sentence; empty when nothing is in its way."""
        if s["running"]:
            return "Downloading now."
        if s.get("personal_only"):
            return "Not in this build: " + s["personal_only"]
        if not s["enabled"]:
            return "Off: switch it on to download it."
        if need and not all(creds.get(k) for k in need):
            return f"Not downloading: no {a.get('name', 'API')} key saved. Get one (link above), then paste it under Your API keys."
        if s.get("state") == "error":
            return f"Last try failed: {s.get('message', '')}"
        if s["kind"] == "crowd" and not self.active_area():
            return "Waiting for an area: crowd data downloads for the active mission's area (or use Fetch for the pin)."
        if self.net.get("online") is False:
            return "Offline: it downloads when the connection is back."
        if not self.link_allowed():
            return (f"Waiting for {' or '.join(LINK_NAMES[k] for k in self.links())}: updates are set to skip "
                    f"{LINK_NAMES.get(link, 'this connection')}, which this PC is on now (Automatic updates, Update over).")
        if not auto:
            return "Automatic updates are off: press Run now, or switch them on."
        return ""

    RETRY_H = 2  # a source whose last run failed tries again after this, however long its interval

    def _due(self, sid, c):
        last = self.status[sid].get("last_checked")
        if not last:
            return True
        try:
            t = time.mktime(time.strptime(last, "%Y-%m-%d %H:%M"))
        except ValueError:
            return True
        hours = min(float(c["interval_h"]), self.RETRY_H) if self.status[sid].get("failed") else float(c["interval_h"])
        return time.time() - t >= hours * 3600

    def run_sources(self, ids, force=False):
        """Run several sources in parallel (background). Returns ids started."""
        ids = [i for i in ids if i in SOURCES and i not in self.running and build.allowed(i)]
        if not ids:
            return []
        with self.lock:
            self.running.update(ids)
        threading.Thread(target=self._run_batch, args=(ids, force), daemon=True).start()
        return ids

    def _run_batch(self, ids, force):
        uls_ids = [i for i in ids if i.startswith("uls:")]
        later = [i for i in ids if i in AFTER_ULS] if uls_ids else []
        others = [i for i in ids if not i.startswith("uls:") and i not in later]
        jobs = ([("uls", uls_ids)] if uls_ids else []) + [(i, [i]) for i in others]
        try:
            with ThreadPoolExecutor(max_workers=4) as ex:
                for f in [ex.submit(self._run_job, j[0], j[1], force) for j in jobs]:
                    try:
                        f.result()
                    except Exception:
                        pass  # one job's failure never stops the others (its own status says what went wrong)
            for i in later:  # these need the town list the licence import builds (a new copy has none until then)
                self._run_job(i, [i], force)
        finally:  # nothing stays "running" after the batch ends (11/2: 911 centres showed running for good)
            with self.lock:
                self.running.difference_update(ids)

    def _mark(self, ids, **kw):
        if kw.get("state") in ("error", "ok", "skipped"):
            kw["failed"] = kw["state"] == "error"  # kept across restarts (state isn't saved): _due retries sooner
        for i in ids:
            self.status[i].update(kw)
        self._save()

    def _run_job(self, job, ids, force):
        now = lambda: time.strftime("%Y-%m-%d %H:%M")
        self._mark(ids, state="running", message="starting…")
        try:
            if job == "uls":
                # ULS services are rebuilt together into one search table
                services = [i.split(":", 1)[1] for i, c in self.config().items() if i.startswith("uls:") and c["enabled"]]
                services = sorted(set(services) | {i.split(":", 1)[1] for i in ids})
                stale = set(services) if force else set()
                for svc in services:
                    rm = remote_modified(uls_import.BASE_URL.format(svc))
                    sid = "uls:" + svc
                    # an unreadable date means "check" (it used to read as "unchanged", which left the data at its
                    # first import for good); a saved copy downloaded after the FCC's file date is current, so a
                    # first auto-update doesn't pull ~530 MB it already has
                    local = os.path.join(uls_import.DATA_DIR, f"l_{svc}.zip")
                    have = time.strftime("%Y-%m-%d %H:%M", time.gmtime(os.path.getmtime(local))) if os.path.exists(local) else None
                    if rm is None or (rm != self.status.get(sid, {}).get("remote") and not (have and have >= rm)):
                        stale.add(svc)
                    if sid in self.status:
                        self.status[sid]["remote"] = rm
                if not stale and all(self.status[i].get("last_updated") or self.data_dates().get(i) for i in ids):
                    self._mark(ids, state="ok", message="already current", last_checked=now())
                    return
                paths = []
                for svc in services:  # download only what changed; reuse the saved copy of the rest
                    self._mark(["uls:" + svc] if "uls:" + svc in self.status else [], message="downloading…" if svc in stale else "using saved copy…")
                    p = uls_import.download(svc, svc in stale, lambda m, end="\n": None)
                    if p:
                        paths.append(p)
                        if svc in stale:
                            self.archive(p)
                    else:
                        raise RuntimeError(f"could not download l_{svc}.zip from the FCC")
                self._mark(ids, message="rebuilding database…")
                states = [s for s in (self.get("update.states", "") or "").split(",") if s]
                # each step's progress shows in its status line (it said only "rebuilding database…" for hours on the server)
                n = uls_import.run_import(self.db, paths, states, False,
                                          lambda m, end="\n": self._mark(ids, message=(m.strip() or "rebuilding database…")[:160]))
                self._mark(["uls:" + s for s in services if "uls:" + s in self.status], state="ok",
                           message=f"{n:,} rows", last_checked=now(), last_updated=now(), rows=n)
                import finder  # the licensee name index for Search is rebuilt for the new data
                finder.build_index(self.db)
                try:  # each DAS job's licences against the new data (daswatch.py): changes go to the job and the board
                    import daswatch
                    daswatch.run_all(self.db, log=lambda m: None)
                except Exception as e:
                    print(f"DAS licence watch after the FCC update: {type(e).__name__}: {str(e)[:200]}", flush=True)
            elif job == "asr":
                import towers
                rm = remote_modified(towers.URL)
                local = os.path.join(uls_import.DATA_DIR, "r_tower.zip")
                have = time.strftime("%Y-%m-%d %H:%M", time.gmtime(os.path.getmtime(local))) if os.path.exists(local) else None
                current = rm and (rm == self.status["asr"].get("remote") or (have and have >= rm))
                if not force and current and (self.status["asr"].get("last_updated") or self.data_dates().get("asr")):
                    self._mark(ids, state="ok", message="already current", last_checked=now(), remote=rm)
                    return
                states = [s for s in (self.get("update.states", "") or "").split(",") if s]
                n = towers.run(self.db, refresh=True, states=states, log=lambda m, end="\n": None)
                self.archive(os.path.join(uls_import.DATA_DIR, "r_tower.zip"))
                self._mark(ids, state="ok", message=f"{n:,} towers", last_checked=now(), last_updated=now(),
                           rows=n, remote=rm)
            elif job == "bcast":
                import broadcast
                notes = []
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = broadcast.run(con, uls_import.DATA_DIR, fetch=True, log=notes.append)
                finally:
                    con.close()
                refused = [x for x in notes if "not downloaded" in x]
                self._mark(ids, state="ok", last_checked=now(), last_updated=now(), rows=n,
                           message=f"{n:,} stations" + (" (FCC refused the download: used the saved lists)" if refused else ""))
            elif job == "faa":
                import faa
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = faa.run(con, uls_import.DATA_DIR, fetch=True, log=lambda m, end="\n": None)
                finally:
                    con.close()
                self._mark(ids, state="ok", message=f"{n:,} frequencies", last_checked=now(), last_updated=now(), rows=n)
            elif job == "nwr":
                import noaa
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = noaa.run(con, uls_import.DATA_DIR, fetch=True, log=lambda m, end="\n": None)
                finally:
                    con.close()
                self._mark(ids, state="ok", message=f"{n:,} transmitters", last_checked=now(), last_updated=now(), rows=n)
            elif job == "grantee":  # every FCC grantee code and its company (fccid.py)
                import fccid
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = fccid.import_grantees(con, log=lambda m: self._mark(ids, message=m))
                    src = fccid.grantee_source(con)
                finally:
                    con.close()
                msg = (f"{n:,} grantee codes: the FCC's own list of {src['at']}"
                       + (" (from the RF Recon site)" if src["file"] == "the RF Recon site" else ", imported here")
                       if src["source"] == "fcc-download" else f"{n:,} grantee codes (FCC open data, last updated March 2021)")
                self._mark(ids, state="ok", message=msg, last_checked=now(), last_updated=now(), rows=n)
            elif job == "bdc":  # carrier coverage hexagons for the carrier-coverage states (bdc.py)
                import bdc
                states = [s for s in re.split(r"[,\s]+", self.get("bdc.states", "") or "") if s]
                r = bdc.run(uls_import.DATA_DIR, self.get("creds", {}) or {}, states, log=lambda m: self._mark(ids, message=m))
                self._mark(ids, state="ok", message=f"{r['hexagons']:,} hexagons for {', '.join(r['states'])} (release {r['as_of']})",
                           last_checked=now(), last_updated=now(), rows=r["hexagons"])
            elif job == "psap":  # the FCC's 911 call centre registry, placed at town centres
                import psap
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = psap.run(con)
                finally:
                    con.close()
                self._mark(ids, state="ok", message=f"{n:,} call centres (FCC rows of {psap.SOURCE_DATE})", last_checked=now(), last_updated=now(), rows=n)
            elif job == "mw_pending":  # microwave links filed, not yet granted (mw_pending.py)
                import mw_pending
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = mw_pending.run(con, log=lambda m: self._mark(ids, message=m.strip()))
                finally:
                    con.close()
                self.archive(os.path.join(uls_import.DATA_DIR, "a_micro.zip"))  # a week already archived is skipped
                self._mark(ids, state="ok", message=f"{n:,} pending links", last_checked=now(), last_updated=now(), rows=n)
            elif job == "fss":  # the FCC's protected C-band earth stations (fss.py)
                import fss
                con = sqlite3.connect(self.db, timeout=60)
                try:
                    n = fss.run(con)
                finally:
                    con.close()
                self._mark(ids, state="ok", message=f"{n:,} earth stations", last_checked=now(), last_updated=now(), rows=n)
            elif job == "bdc_extra":  # the rest of the FCC Broadband Data Collection that helps RF work (bdc_extra.py)
                import bdc_extra
                r = bdc_extra.run(uls_import.DATA_DIR, self.get("creds", {}) or {}, log=lambda m: self._mark(ids, message=m))
                self._mark(ids, state="ok", last_checked=now(), last_updated=now(), rows=r["checks"] + r["fixed_wireless_cells"] + r["link_budgets"],
                           message=f"release {r['release']}: {r['checks']:,} coverage checks, {r['fixed_wireless_cells']:,} fixed wireless cells, "
                                   f"{r['link_budgets']:,} link budget lines, {r['providers']:,} providers")
            elif job == "artemis":  # waterfalls and audio for the Signal ID Wiki signals (artemis.py)
                import artemis
                st = artemis.fetch(log=lambda m: self._mark(ids, message=m))
                self._mark(ids, state="ok", message=f"{st['signals']:,} signals, release v{st['version']} ({st['date']})",
                           last_checked=now(), last_updated=now(), rows=st["signals"])
            elif job == "das_prospects":  # the public building lists the DAS Prospects view searches (prospects.py)
                import prospects
                r = prospects.refresh(uls_import.DATA_DIR, log=lambda m: self._mark(ids, message=str(m)[:200]))
                bad = sorted((r.pop("errors", None) or {}))
                n = sum(v for v in r.values() if isinstance(v, int))
                for a in self.active_area() or []:  # high-rises (75 ft / 7 floors and up) around each mission area
                    try:
                        n += prospects.highrises(uls_import.DATA_DIR, a[0], a[1], min(10, a[2] or 10),
                                                 log=lambda m: self._mark(ids, message=str(m)[:200]))
                    except Exception as e:
                        bad.append(f"high-rises ({str(e)[:80]})")
                self._mark(ids, state="error" if bad and not n else "ok", last_checked=now(), last_updated=now(), rows=n,
                           message=f"{n:,} buildings" + (f"; failed: {', '.join(bad)}" if bad else ""))
            elif job == "usfa_fd":  # fire departments for a DAS job's AHJ guess (ahj.py)
                import ahj
                r = ahj.refresh(uls_import.DATA_DIR, log=lambda m: self._mark(ids, message=str(m)[:200]))
                self._mark(ids, state="ok", last_checked=now(), last_updated=now(), rows=r["departments"],
                           message=f"{r['departments']:,} departments, {r['stations']:,} stations")
            elif job == "part_prices":  # DAS part prices: price list links and online prices on open requests (das.py, prices.py)
                import das as dasmod
                con = sqlite3.connect(self.db, timeout=60)
                con.row_factory = sqlite3.Row
                try:
                    dasmod.migrate(con)
                    lists = dasmod.refresh_price_lists(con)
                    creds = self.get("creds", {}) or {}
                    open_q = [r["id"] for r in con.execute("SELECT id FROM das_rfq WHERE status='open' AND created_at >= datetime('now','-60 days')")]
                    online = [dasmod.online_quotes(con, rid, creds)["online"] for rid in open_q] if open_q else []
                finally:
                    con.close()
                srcs = sorted({x for o in online for x in o["keys"]})
                self._mark(ids, state="ok", last_checked=now(), last_updated=now(), rows=len(lists) + len(open_q),
                           message=f"{len(lists)} price list link{'s' if len(lists) != 1 else ''} re-read; {len(open_q)} open request{'s' if len(open_q) != 1 else ''}"
                                   + (f" priced online ({', '.join(srcs)})" if srcs else " (no Mouser or Digi-Key key saved)"))
            elif job == "tiles":  # base maps and terrain kept for each mission area (tilecache.py)
                import tilecache
                areas = self.active_area()
                if not areas:
                    self._mark(ids, state="skipped", message="no active mission area", last_checked=now())
                    return
                c = tilecache.prefetch([(a[0], a[1], a[2]) for a in areas], log=lambda m: self._mark(ids, message=m))
                self._mark(ids, state="ok" if not c["missed"] else "error", last_checked=now(), last_updated=now(), rows=c["new"] + c["kept"],
                           message=f"{c['new'] + c['kept']:,} tiles kept for {len(areas)} area(s) ({c['new']:,} new)"
                                   + (f"; {c['none']:,} have no USGS tile (open sea or a map's gap)" if c.get("none") else "")
                                   + (f"; {c['missed']:,} didn't download (tried again next run)" if c["missed"] else ""))
            elif job == "sigwiki":  # reference catalog, not tied to an area
                import connectors
                import sigwiki
                con = connectors.open_db(self.crowd)
                try:
                    n = sigwiki.fetch(con, log=lambda m, end="\n": None)
                finally:
                    con.close()
                self._mark(ids, state="ok", message=f"{n:,} signals", last_checked=now(), last_updated=now(), rows=n)
            else:
                import connectors
                creds = self.get("creds", {}) or {}
                areas = self.active_area()
                if not areas:
                    self._mark(ids, state="skipped", message="no active mission area", last_checked=now())
                    return
                con = connectors.open_db(self.crowd)
                total = 0
                for lat, lon, radius, state in areas:
                    if job == "wigle":
                        if not (creds.get("wigle_name") and creds.get("wigle_token")):
                            raise RuntimeError("add your WiGLE API name and token in Settings")
                        total += connectors.fetch_wigle(con, lat, lon, radius, creds["wigle_name"], creds["wigle_token"],
                                                        kinds=("network", "bluetooth", "cell"))
                    elif job == "opencellid":
                        if not creds.get("opencellid_key"):
                            raise RuntimeError("add your OpenCelliD key in Settings")
                        total += connectors.fetch_opencellid(con, lat, lon, radius, creds["opencellid_key"])
                    elif job == "repeaterbook":
                        if not creds.get("repeaterbook_token"):
                            raise RuntimeError("no RepeaterBook token: Your API keys doesn't take one (RepeaterBook's policy discourages tools that mix sources)")
                        total += connectors.fetch_repeaterbook(con, lat, lon, radius, creds["repeaterbook_token"], state)
                    else:  # the no-key open sources; an area fetched recently is skipped (-1), not downloaded again
                        import opensources
                        total += max(0, opensources.fetch(con, job, lat, lon, radius, force=force))
                con.close()
                self._mark(ids, state="ok", message=f"{total:,} points for {len(areas)} area(s)", last_checked=now(),
                           last_updated=now(), rows=total)
        except Exception as e:
            self._mark(ids, state="error", message=str(e)[:300], last_checked=now())
        finally:
            with self.lock:
                self.running.difference_update(ids)

    def tick(self):
        """Called periodically: run every enabled, due source if allowed."""
        self.refresh_net()
        if not self.get("update.auto", False) or not self.net.get("online"):
            return
        if not self.link_allowed():
            for sid, c in self.config().items():
                if c["enabled"]:
                    self.status[sid]["message"] = "waiting for " + " or ".join(LINK_NAMES[k] for k in self.links())
            return
        due = [sid for sid, c in self.config().items() if c["enabled"] and self._due(sid, c)]
        # the 24/7 server (RF_RECON_HEAVY_HOURS="2-5", its local time): the heavy rebuilds (FCC licences, carrier
        # coverage) start only in that window, when no one is saving; the rest run whenever they're due
        win = os.environ.get("RF_RECON_HEAVY_HOURS", "")
        if re.fullmatch(r"\d{1,2}-\d{1,2}", win):
            a, b = (int(x) for x in win.split("-"))
            if not (a <= time.localtime().tm_hour < b):
                for sid in [s for s in due if s.startswith("uls:") or s in ("bdc", "bdc_extra", "mw_pending", "tiles")]:
                    due.remove(sid)
                    if self.status[sid].get("state") != "running":  # one already running (Run now) keeps its progress line
                        self.status[sid]["message"] = f"due: runs in the night window ({a}:00 to {b}:00)"
        self.run_sources(due)

    def start(self, every_s=600):
        def loop():
            time.sleep(5)
            while True:
                try:
                    self.tick()
                except Exception:
                    pass
                time.sleep(every_s)
        threading.Thread(target=loop, daemon=True).start()
