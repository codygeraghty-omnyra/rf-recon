"""
Which build this is. RF_RECON_BUILD=personal is set on Cody's own PC (the launcher) and on the 24/7 server (its service,
11/2), and there it applies to the owner only: Cody, the copy's own background jobs, and the server's admin login. Team
logins, and everything else (the install kit, the web version, anything Josh sells or shows a customer), get the sold
build.

The sold build leaves out every source whose terms bar commercial use or sharing (terms read 2026-11-02, research
"RF Recon data sources and aggregation", section 9). The personal build keeps them all.
"""
import os

PERSONAL = os.environ.get("RF_RECON_BUILD", "").strip().lower() == "personal"

# source id -> why the sold build leaves it out
PERSONAL_ONLY = {
    "wigle": "WiGLE's terms allow personal, research or educational use only, and no redistribution.",
    "repeaterbook": "RepeaterBook is for personal use, and its policy discourages tools that mix it with other data.",
    "wspr": "wspr.live is non-commercial.",
    "sigwiki": "The Signal Identification Wiki grants no licence to reuse its content (its Copyrights page, read "
               "2026-11-02). Cody or Josh settles it with the wiki's owners first.",
    "artemis": "Artemis's database is Signal Identification Wiki content.",
    "aisstream": "aisstream.io publishes no terms.",
    "osm_towers": "OpenStreetMap's towers (ODbL) fused with the crowd's carrier cells (OpenCelliD, CC BY-SA 4.0) wait for counsel "
                  "to rule on mixing the two licences (Cody 11/10): Cody's own build only until then.",
}

# The tables in uls.db that hold public data only (the FCC's, FAA's, NOAA's, Census places, 911 centres), and so may go to
# another copy: the licensed-copy seed (ops/licensed_copy.py) and the install kit's full copy (kit/build_kit.py) copy these
# by name. An ALLOW list: a table nobody named stays behind (a gap to fill), never someone's own work, Omnyra's crawls or a
# source with no licence to pass on reaching another copy (11/10: the kit's old deny list had missed drawings, DAS mail,
# intake, the AHJ book, seals, leads, BDA alarms and the Signal ID Wiki catalog).
PUBLIC_TABLES = ("tx", "tx_history", "uls_contact", "tower", "tower_app", "faa", "faa_study", "fcc_grant", "fcc_grant_eq",
                 "fcc_grant_src", "fcc_grant_watts", "fcc_grantee", "fcc_grantee_src", "fss_earth", "nwr", "place", "psap", "bcast",
                 "mw_link", "mw_pending", "uls_pending", "meta",
                 # named from the server's dry run, 11/10: booster registrations (place and company; their people are in
                 # booster_contact), FAA airports and runways, the FCC rules watch's docket filings, and the record of which
                 # FCC daily files the licences already hold (ulsdaily.py: it belongs with the tables it describes)
                 "booster", "faa_airport", "faa_runway", "fcc_filing", "uls_daily_log")

# notices every build carries (FCC Data API terms; OpenCelliD CC BY-SA 4.0; ODbL for OpenStreetMap and Overture)
NOTICES = {
    "fcc": "This product uses the FCC Data API but is not endorsed or certified by the FCC.",
    "opencellid": "Cell tower data: OpenCelliD Project, licensed under CC BY-SA 4.0 (opencellid.org).",
    "osm": "Building outlines and street maps: © OpenStreetMap contributors (ODbL, openstreetmap.org/copyright).",
    "overture": "Building outlines: © OpenStreetMap contributors, Overture Maps Foundation (ODbL).",
}


def _remote_user():
    """Who is asking through the remote door (a team login), or None for the owner: this PC itself, the server's own
    jobs, or the admin login (remote.py treats the admin as the owner)."""
    import remote
    return getattr(remote.ON, "user", None)


def personal_now():
    """The personal build applies to the owner only (Cody 11/2: "Per-login personal build"): on Cody's PC and on the
    server alike, a team login gets the sold build, so a personal-use source is never shown to anyone else."""
    return PERSONAL and not _remote_user()


def name():
    return "personal" if personal_now() else "sold"


def allowed(source_id):
    return source_id not in PERSONAL_ONLY or personal_now()


def info():
    """What the page needs: the build's name, what it leaves out and why, and the notices."""
    return {"build": name(), "left_out": {} if personal_now() else PERSONAL_ONLY, "notices": NOTICES, "commit": commit()}


def commit():
    """The deployed commit (deploy_server.sh writes COMMIT beside the code), so a check can see what's running."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "COMMIT"), encoding="utf-8") as fh:
            return fh.read().strip()[:40] or None
    except OSError:
        return None


_VERSION = {"at": 0, "v": None}


def version():
    """This copy's build, for Ways in: {commit, date, how}. The server: the commit deploy_server.sh wrote to COMMIT and
    when (the file's time). An install-kit copy: its VERSION stamp. A git checkout (Cody's PC): HEAD and its date, and
    whether files changed since. None when none of those can be read. Read at most once a minute."""
    import json
    import subprocess
    import time
    if time.time() - _VERSION["at"] < 60:
        return _VERSION["v"]
    here = os.path.dirname(os.path.abspath(__file__))
    v = None
    c = commit()
    if c:
        v = {"commit": c[:10], "date": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(os.path.join(here, "COMMIT")))),
             "how": "deployed"}
    else:
        try:
            with open(os.path.join(here, "VERSION"), encoding="utf-8") as fh:
                k = json.load(fh)
            v = {"commit": str(k.get("version") or "")[:10], "date": k.get("built"), "how": "install kit"}
        except (OSError, ValueError):
            try:
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                out = subprocess.run(["git", "-C", here, "log", "-1", "--format=%h|%cd", "--date=format:%Y-%m-%d %H:%M"], capture_output=True,
                                     text=True, timeout=10, creationflags=flags)
                if out.returncode == 0 and "|" in out.stdout:
                    h, d = out.stdout.strip().split("|", 1)
                    dirty = subprocess.run(["git", "-C", here, "status", "--porcelain", "--untracked-files=no"], capture_output=True,
                                           text=True, timeout=10, creationflags=flags).stdout.strip()
                    v = {"commit": h, "date": d, "how": "git", "changed": bool(dirty)}
            except (OSError, subprocess.SubprocessError):
                v = None
    _VERSION.update(at=time.time(), v=v)
    return v
