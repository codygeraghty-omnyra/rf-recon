"""
Which build this is. "personal" is Cody's own PC (the launcher sets RF_RECON_BUILD=personal). Anything else is the sold
build: the install kit, the 24/7 server, and anything Josh sells or shows a customer.

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


def name():
    return "personal" if PERSONAL else "sold"


def allowed(source_id):
    return PERSONAL or source_id not in PERSONAL_ONLY


def info():
    """What the page needs: the build's name, what it leaves out and why, and the notices."""
    return {"build": name(), "left_out": {} if PERSONAL else PERSONAL_ONLY, "notices": NOTICES}
