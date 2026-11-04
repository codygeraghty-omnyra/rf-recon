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
}

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
    return {"build": name(), "left_out": {} if personal_now() else PERSONAL_ONLY, "notices": NOTICES}
