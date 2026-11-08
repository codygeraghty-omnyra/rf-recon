"""
Server files (Data & updates, admin only): what the DAStastic server keeps, with sizes and dates, and a copy of any file to
download. Read only: nothing here writes, moves or deletes.

It shows named folders, never the whole disk, and never a folder's place on the server. Logins, keys and the sign-in secret
can't be reached. The sealed keys and mailboxes live outside every folder here (keystore.py). The other secrets sit in the
app data folder, which lists sizes and never downloads, and their names don't show. If a folder ever turns out to hold a
secret file, it loses its downloads too. A download is always an attachment, so a web page in a job folder can't run in
the admin's session.
"""
import os
import re
import shutil
import time
from urllib.parse import quote

import das
import fieldpack
import keystore
import notes
import uls_import

MAX_ROWS = 1000  # a folder of map tiles holds far more than anyone reads
COUNT_TO = 1000
SECRET_NAME = re.compile(r"^(remote_users\.json(\.tmp)?|remote_secret)$|\.(pem|key|env)$", re.I)


def _secrets():
    d = uls_import.DATA_DIR
    files = [os.path.join(d, "remote_users.json"), os.path.join(d, "remote_secret"), keystore.path(d), keystore.path(d, "mail")]
    return {os.path.normcase(os.path.realpath(p)) for p in files}


def _folders():
    data, secrets, out = uls_import.DATA_DIR, _secrets(), []
    for fid, label, path, dl in (("jobs", "DAS job files", das.DAS_DIR, True), ("notes", "Notes", notes.notes_dir(data), True),
                                 ("packs", "Field packs", fieldpack.PACK_DIR, True), ("backups", "Backups", os.environ.get("RF_RECON_BACKUP"), True),
                                 ("data", "App data", data, False)):
        if not path or not os.path.isdir(path):
            continue
        base = os.path.normcase(os.path.realpath(path)) + os.sep
        out.append({"id": fid, "label": label, "path": path, "download": dl and not any(s.startswith(base) for s in secrets)})
    return out


def _folder(root):
    f = next((x for x in _folders() if x["id"] == root), None)
    if f is None:
        raise LookupError("No such folder.")
    return f


def _hidden(name, full, secrets):
    return bool(SECRET_NAME.search(name)) or name.lower() == "desktop.ini" or name.endswith(".part") or os.path.normcase(os.path.realpath(full)) in secrets


def _inside(folder, rel):
    """The real path of rel in this folder. Anything that leaves the folder or names a secret is refused."""
    parts = [p for p in (rel or "").replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." or "\0" in p or ":" in p for p in parts):
        raise ValueError("Bad path.")
    base = os.path.realpath(folder["path"])
    full, secrets = os.path.realpath(os.path.join(base, *parts)), _secrets()
    if full != base and not full.startswith(base + os.sep):
        raise ValueError("Bad path.")
    here = base
    for p in parts:
        here = os.path.join(here, p)
        if os.path.islink(here) or _hidden(p, here, secrets):
            raise LookupError("No such file.")
    return full, "/".join(parts)


def _when(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def _items(path):
    n = 0
    try:
        with os.scandir(path) as it:
            for _ in it:
                n += 1
                if n >= COUNT_TO:
                    break
    except OSError:
        return None
    return n


def overview():
    disk = shutil.disk_usage(uls_import.DATA_DIR)
    return {"folders": [{"id": f["id"], "label": f["label"], "download": f["download"]} for f in _folders()], "disk": {"free": disk.free, "total": disk.total}}


def listing(root, rel=""):
    f = _folder(root)
    full, rel = _inside(f, rel)
    if not os.path.isdir(full):
        raise LookupError("No such folder.")
    secrets, dirs, files = _secrets(), [], []
    with os.scandir(full) as it:
        for e in it:
            if e.is_symlink() or _hidden(e.name, e.path, secrets):
                continue
            try:
                st = e.stat()
            except OSError:
                continue
            (dirs if e.is_dir() else files).append((e.name, e.path, st))
    dirs.sort(key=lambda x: x[0].lower())
    files.sort(key=lambda x: x[0].lower())
    shown_d, shown_f = dirs[:MAX_ROWS], files[:max(0, MAX_ROWS - len(dirs))]
    return {"root": f["id"], "label": f["label"], "path": rel, "download": f["download"], "more": len(dirs) + len(files) - len(shown_d) - len(shown_f), "count_to": COUNT_TO,
            "folders": [{"name": n, "items": _items(p), "changed": _when(s.st_mtime)} for n, p, s in shown_d],
            "files": [{"name": n, "size": s.st_size, "changed": _when(s.st_mtime)} for n, _, s in shown_f]}


def locate(root, rel):
    """(real path, size, name) of a file to download."""
    f = _folder(root)
    if not f["download"]:
        raise ValueError("This folder lists sizes only.")
    full, _ = _inside(f, rel)
    if not os.path.isfile(full):
        raise LookupError("No such file.")
    return full, os.path.getsize(full), os.path.basename(full)


def disposition(name):
    return "attachment; filename*=UTF-8''" + quote(name, safe="")


def copy(path, out):
    with open(path, "rb") as fh:
        shutil.copyfileobj(fh, out, 1 << 20)
