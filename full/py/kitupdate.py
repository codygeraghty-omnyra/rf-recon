"""
Updates for copies installed from the install kit. Each kit build stamps app/VERSION and publishes the same facts as
kit.json on the RF Recon GitHub site (version and date only, no code), so a copy can say when a newer kit is out.
The person downloads the new zip from the Drive install-kit folder and picks it in Data & updates: the app's files
are written over the old ones (data, DAS jobs and field packs are never in the zip, so they stay), then the kit's
launcher restarts the server. A kit that brings a different Python needs unzipping by hand, with RF Recon stopped.
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAME = "RF Recon (beta)"
LATEST_URL = os.environ.get("RF_RECON_KIT_URL") or "https://codygeraghty-omnyra.github.io/rf-recon/kit.json"  # a test can point elsewhere
GET_URL = "https://drive.google.com/drive/folders/1GalaifA2obOjmBGzm9aD-t_Zr6JxNbLB"
_LATEST = {"at": 0, "data": None}


def current(app_dir=HERE):
    """This copy's kit version, or None when it isn't a kit copy (Cody's runs from the Drive folder)."""
    try:
        with open(os.path.join(app_dir, "VERSION"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def latest():
    """The newest kit's facts from the GitHub site, asked at most once an hour; None when offline."""
    if time.time() - _LATEST["at"] < 3600:
        return _LATEST["data"]
    try:
        with urllib.request.urlopen(urllib.request.Request(LATEST_URL, headers={"User-Agent": "RF-Recon/2.0"}), timeout=8) as r:
            data = json.loads(r.read(100_000))
        _LATEST.update(at=time.time(), data=data if isinstance(data, dict) and data.get("version") else None)
    except (OSError, ValueError):
        _LATEST.update(at=time.time() - 3000, data=None)  # offline: try again in ten minutes
    return _LATEST["data"]


def status():
    cur, new = current(), None
    if cur:
        new = latest()
    return {"kit": bool(cur), "current": cur, "latest": new, "get": GET_URL,
            "update": bool(cur and new and new.get("version") != cur.get("version") and (new.get("built") or "") >= (cur.get("built") or ""))}


def apply(data, app_dir=HERE, root=ROOT):
    """Write a kit zip's files over this copy. Returns what changed; raises ValueError for a zip that isn't one."""
    cur = current(app_dir)
    if not cur:
        raise ValueError("This copy isn't from the install kit: it updates with its Drive folder.")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError("That file isn't a zip.")
    prefix = NAME + "/"
    names = set(zf.namelist())
    if prefix + "app/app.py" not in names or prefix + "app/VERSION" not in names:
        raise ValueError("That zip isn't an RF Recon install kit.")
    new = json.loads(zf.read(prefix + "app/VERSION"))
    if new.get("python") != cur.get("python"):
        raise ValueError(f"This kit brings Python {new.get('python')} (this copy has {cur.get('python')}): stop RF Recon, "
                         f"then unzip the new kit over this folder by hand.")
    root = os.path.abspath(root)
    n = 0
    for info in zf.infolist():
        if info.is_dir() or not info.filename.startswith(prefix):
            continue
        rel = info.filename[len(prefix):]
        if rel.startswith(("python/", "data/")):
            continue
        target = os.path.abspath(os.path.join(root, rel))
        if not target.startswith(root + os.sep):  # nothing outside the folder
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".new"
        with open(tmp, "wb") as fh:
            fh.write(zf.read(info))
        os.replace(tmp, target)
        n += 1
    return {"from": cur.get("version"), "to": new.get("version"), "built": new.get("built"), "files": n}


def restart(root=ROOT):
    """Ask the kit's launcher to stop this server and start the updated one (a separate process, so it outlives us)."""
    py = os.path.join(root, "python", "pythonw.exe")
    if not os.path.exists(py):
        py = sys.executable
    subprocess.Popen([py, os.path.join(root, "app", "kit", "start.pyw"), "--restart"], cwd=root, close_fds=True,
                     creationflags=0x00000008 | 0x00000200 if os.name == "nt" else 0)  # detached, its own process group
