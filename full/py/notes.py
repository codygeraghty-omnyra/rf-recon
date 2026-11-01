"""
Notes from the Note button on every screen (static/notes.js): a voice note, the screen recorded while someone talks
and points, a photo with a voice or a written note, or just words.

On a PC each note is a folder of plain files in NOTES_DIR, so it opens without RF Recon: note.txt (when, where, who,
which screen, the words) and voice / screen / photo files. The launcher points NOTES_DIR at RF Recon\\notes in Drive.
The note table keeps the list. People on the remote link can leave notes too, their one write (remote.py), and see
only their own. The web version and RF Recon lite keep notes in the browser instead (notes.js).
"""
import json
import os
import re
import shutil
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS note(id INTEGER PRIMARY KEY, ts TEXT, who TEXT, kind TEXT, text TEXT, screen TEXT,
    lat REAL, lon REAL, mission_id INTEGER, mission TEXT, folder TEXT, files TEXT, transcript TEXT);
"""


def migrate(con):
    """Columns added after the first notes (10/31): what the browser heard during a voice note or screen recording."""
    if "transcript" not in [r[1] for r in con.execute("PRAGMA table_info(note)")]:
        con.execute("ALTER TABLE note ADD COLUMN transcript TEXT")
        con.commit()
KINDS = {"voice": "Voice note", "screen": "Screen recording", "photo-voice": "Photo + voice note",
         "photo-text": "Photo + written note", "text": "Written note"}
TYPES = {".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
         ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic"}
ROLES = ("voice", "screen", "photo", "file")
FILE_MAX = 500 * 1024 * 1024        # one file: a long screen recording is about 5 MB a minute
REMOTE_MAX = 3 * 1024 * 1024 * 1024  # everything remote people have sent, together
REMOTE_ADD_S = 3600                  # a remote person adds files to their new note within an hour


def notes_dir(data_dir):
    return os.environ.get("RF_RECON_NOTES") or os.path.join(data_dir, "notes")


def _clean(s, n):
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


def _write_txt(folder, r):
    files = json.loads(r["files"] or "[]")
    lines = [f"RF Recon (beta): {KINDS.get(r['kind'], 'Note').lower()}", f"When: {r['ts']}"]
    if r["who"]:
        lines.append(f"From: {r['who']} (remote link)")
    if r["screen"]:
        lines.append(f"Screen: {r['screen']}")
    if r["lat"] is not None and r["lon"] is not None:
        lines.append(f"Place: {r['lat']:.5f}, {r['lon']:.5f}  https://maps.google.com/?q={r['lat']:.5f},{r['lon']:.5f}")
    if r["mission"]:
        lines.append(f"Mission: {r['mission']}")
    if files:
        lines.append("Files: " + ", ".join(f["name"] + (f" ({f['secs'] // 60}:{f['secs'] % 60:02d})" if f.get("secs") else "") for f in files))
    lines += ["", r["text"] or "(no words)"]
    if r["transcript"]:
        lines += ["", "What was said (the browser's own transcript, may have mistakes):", r["transcript"]]
    with open(os.path.join(folder, "note.txt"), "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write("\n".join(lines) + "\n")


def _row(con, nid):
    r = con.execute("SELECT * FROM note WHERE id=?", (nid,)).fetchone()
    if not r:
        raise LookupError("That note isn't here any more.")
    return r


def create(con, base, d, who=None):
    """A new note from {kind, text, screen, lat, lon, mission_id, mission}: its folder and note.txt now, files after."""
    kind = d.get("kind") if d.get("kind") in KINDS else "text"
    ts = time.strftime("%Y-%m-%d %H:%M")
    lat, lon = d.get("lat"), d.get("lon")
    lat = float(lat) if isinstance(lat, (int, float)) and -90 <= lat <= 90 else None
    lon = float(lon) if isinstance(lon, (int, float)) and -180 <= lon <= 180 and lat is not None else None
    name = f"{ts.replace(':', '-')} {KINDS[kind].lower()}" + (f" - {re.sub(r'[^A-Za-z0-9 ._-]', '', who)}" if who else "")
    os.makedirs(base, exist_ok=True)
    folder, n = name, 2
    while os.path.exists(os.path.join(base, folder)):
        folder, n = f"{name} ({n})", n + 1
    os.makedirs(os.path.join(base, folder))
    mid = d.get("mission_id") if isinstance(d.get("mission_id"), int) and not who else None
    cur = con.execute("INSERT INTO note(ts,who,kind,text,screen,lat,lon,mission_id,mission,folder,files,transcript) VALUES(?,?,?,?,?,?,?,?,?,?,'[]',?)",
                      (ts, who or "", kind, str(d.get("text") or "").replace("\r\n", "\n").strip()[:20000], _clean(d.get("screen"), 80), lat,
                       lon if lat is not None else None, mid, _clean(d.get("mission"), 120) if mid else "", folder, _clean(d.get("transcript"), 20000)))
    nid = cur.lastrowid
    if mid:  # the mission's own log says a note was left, and what it says
        con.execute("INSERT INTO mission_log(mission_id,ts,kind,detail) VALUES(?,?,?,?)",
                    (mid, time.strftime("%Y-%m-%dT%H:%M:%S"), "note", f"{KINDS[kind]}: {_clean(d.get('text'), 200)}".rstrip(": ")))
    con.commit()
    _write_txt(os.path.join(base, folder), _row(con, nid))
    return nid


def add_file(con, base, nid, role, ext, src, size, secs=None, who=None):
    """Streams one recording or photo (size bytes from src) into the note's folder as voice.webm, photo.jpg, ..."""
    r = _row(con, nid)
    if who is not None:  # someone on the remote link: only their own new note, and within the remote allowance
        if r["who"] != who or time.time() - time.mktime(time.strptime(r["ts"], "%Y-%m-%d %H:%M")) > REMOTE_ADD_S:
            raise PermissionError("Add files to a new note of your own.")
        if size + remote_bytes(con, base) > REMOTE_MAX:
            raise PermissionError("Cody's PC has no more room for notes from the remote link. Tell Cody.")
    ext = "." + (ext or "").lower().lstrip(".")
    if role not in ROLES or ext not in TYPES:
        raise ValueError("Notes keep recordings and pictures (webm, mp4, m4a, ogg, mp3, wav, jpg, png, webp, heic).")
    if not 0 < size <= FILE_MAX:
        raise ValueError(f"A note's file has to be under {FILE_MAX // (1024 * 1024)} MB.")
    files = json.loads(r["files"] or "[]")
    name, n = role + ext, 2
    while any(f["name"] == name for f in files):
        name, n = f"{role} {n}{ext}", n + 1
    path = os.path.join(base, r["folder"], name)
    left = size
    with open(path, "wb") as fh:
        while left:
            chunk = src.read(min(left, 1 << 20))
            if not chunk:
                break
            fh.write(chunk)
            left -= len(chunk)
    if left:
        os.remove(path)
        raise ValueError("The file didn't arrive whole. Try again.")
    files.append({"name": name, "role": role, "type": TYPES[ext], "bytes": size, **({"secs": int(secs)} if secs else {})})
    con.execute("UPDATE note SET files=? WHERE id=?", (json.dumps(files), nid))
    con.commit()
    _write_txt(os.path.join(base, r["folder"]), _row(con, nid))
    return files


def remote_bytes(con, base):
    return sum(f.get("bytes", 0) for (fs,) in con.execute("SELECT files FROM note WHERE who<>''") for f in json.loads(fs or "[]"))


def listing(con, base, who=None):
    rows = con.execute("SELECT * FROM note" + (" WHERE who=?" if who is not None else "") + " ORDER BY id DESC LIMIT 500",
                       (who,) if who is not None else ()).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["files"] = [dict(f, url=f"/api/notes/{r['id']}/{f['name']}") for f in json.loads(r["files"] or "[]")]
        d["label"] = KINDS.get(r["kind"], "Note")
        out.append(d)
    return {"notes": out, "where": base}


def file_path(con, base, nid, name, who=None):
    r = _row(con, nid)
    if who is not None and r["who"] != who:
        raise LookupError("That note isn't here any more.")
    if not any(f["name"] == name for f in json.loads(r["files"] or "[]")):
        raise LookupError("That file isn't in the note.")
    return os.path.join(base, r["folder"], name), TYPES[os.path.splitext(name)[1].lower()]


def delete(con, base, nid):
    """The note and its folder (in Drive the folder goes to Drive's trash, so it can still come back from there)."""
    r = _row(con, nid)
    shutil.rmtree(os.path.join(base, r["folder"]), ignore_errors=True)
    con.execute("DELETE FROM note WHERE id=?", (nid,))
    con.commit()
