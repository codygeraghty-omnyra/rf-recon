"""
Artemis (Ares Valley, github.com/AresValley/Artemis-DB): the Signal Identification Wiki's signals with a waterfall
picture and an audio clip for each. RF Recon shows them beside its Signal ID Wiki "could be" matches, matched by the
wiki page address both carry. The database is Signal ID Wiki content: read on this PC only, never exported, never
in a pack, never through the remote door (remote.py blocks /api/artemis/).

A release is a tar of data.sqlite plus media/<doc id>.png|ogg (about 300 MB), kept unpacked in
DATA_DIR/artemis/v<N>/. Standard library only.
"""
import json
import os
import re
import shutil
import sqlite3
import tarfile
import urllib.request

import uls_import

ART_DIR = os.path.join(uls_import.DATA_DIR, "artemis")
RELEASES = "https://api.github.com/repos/AresValley/Artemis-DB/releases/latest"
MIME = {"png": "image/png", "ogg": "audio/ogg"}
MEMBER = re.compile(r"^(\./)?(data\.sqlite|media/\d+\.(png|ogg))$")  # all a release may hold


def installed():
    """The newest unpacked release: (version, folder) or None."""
    if not os.path.isdir(ART_DIR):
        return None
    vs = [(int(d[1:]), os.path.join(ART_DIR, d)) for d in os.listdir(ART_DIR)
          if re.fullmatch(r"v\d+", d) and os.path.exists(os.path.join(ART_DIR, d, "data.sqlite"))]
    return max(vs) if vs else None


def _con():
    got = installed()
    if not got:
        return None, None
    return sqlite3.connect(f"file:{os.path.join(got[1], 'data.sqlite')}?mode=ro", uri=True), got[1]


def attach(cands):
    """Add {"media": {"image": url, "audio": url}} to Signal ID Wiki candidates Artemis has pictures or sound for."""
    if not cands:
        return cands
    con, _ = _con()
    if not con:
        return cands
    try:
        for c in cands:
            rows = con.execute("SELECT d.DOC_ID, d.EXTENSION FROM signals s JOIN documents d ON d.SIG_ID = s.SIG_ID "
                               "WHERE s.URL = ? AND d.PREVIEW = 1", (c.get("url"),)).fetchall()
            media = {}
            for doc, ext in rows:
                kind = {"png": "image", "ogg": "audio"}.get(ext)
                if kind and kind not in media:
                    media[kind] = f"/api/artemis/media/{doc}"
            if media:
                c["media"] = media
    finally:
        con.close()
    return cands


def media_file(doc_id):
    """(path, mime) of one picture or clip, or None. Only files the database lists, inside the release folder."""
    con, folder = _con()
    if not con:
        return None
    try:
        r = con.execute("SELECT EXTENSION FROM documents WHERE DOC_ID = ?", (int(doc_id),)).fetchone()
    finally:
        con.close()
    if not r or r[0] not in MIME:
        return None
    path = os.path.join(folder, "media", f"{int(doc_id)}.{r[0]}")
    return (path, MIME[r[0]]) if os.path.exists(path) else None


def status():
    got = installed()
    if not got:
        return {"installed": False}
    con, _ = _con()
    try:
        n = con.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
        date = con.execute("SELECT DATE FROM info").fetchone()[0]
    finally:
        con.close()
    return {"installed": True, "version": got[0], "signals": n, "date": date}


def unpack(tar_path, dest):
    """Write a release's data.sqlite and media/<number>.png|ogg into dest, and nothing else: no other names, no
    links, no paths that climb out. Returns how many files it wrote."""
    n = 0
    with tarfile.open(tar_path) as t:
        for m in t.getmembers():
            if m.isfile() and MEMBER.match(m.name):
                out = os.path.join(dest, m.name[2:] if m.name.startswith("./") else m.name)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with t.extractfile(m) as fi, open(out, "wb") as fo:
                    shutil.copyfileobj(fi, fo, 1 << 20)
                n += 1
    return n


def fetch(log=print):
    """Download and unpack the latest release if it's newer than the one here; returns the status. Unpacks only
    data.sqlite and media/<number>.png|ogg, so a release can't write anywhere else."""
    req = urllib.request.Request(RELEASES, headers={"Accept": "application/vnd.github+json", "User-Agent": "RF-Recon"})
    with urllib.request.urlopen(req, timeout=30) as r:
        rel = json.load(r)
    tag = int(re.sub(r"\D", "", rel["tag_name"]) or 0)
    have = installed()
    if have and have[0] >= tag:
        return status()
    asset = next(a for a in rel["assets"] if a["name"].endswith(".tar"))
    os.makedirs(ART_DIR, exist_ok=True)
    tar_path = os.path.join(ART_DIR, asset["name"])
    log(f"Downloading Artemis v{tag} ({asset['size'] / 1e6:.0f} MB)…")
    with urllib.request.urlopen(urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "RF-Recon"}), timeout=120) as r, \
            open(tar_path + ".part", "wb") as fo:
        shutil.copyfileobj(r, fo, 1 << 20)
    if os.path.getsize(tar_path + ".part") != asset["size"]:
        os.remove(tar_path + ".part")
        raise IOError("The Artemis download stopped early: run it again.")
    os.replace(tar_path + ".part", tar_path)
    log("Unpacking…")
    unpack(tar_path, os.path.join(ART_DIR, f"v{tag}"))
    os.remove(tar_path)
    for d in os.listdir(ART_DIR):  # older releases
        if re.fullmatch(r"v\d+", d) and d != f"v{tag}":
            shutil.rmtree(os.path.join(ART_DIR, d), ignore_errors=True)
    return status()
