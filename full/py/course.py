"""
The DAS course on the server. The page is one file, course/index.html, built by the das-master-course project. It sits
here and never in static/: everything in static/ goes to the public web version (phone/publish.py) and into the install
kit (kit/build_kit.py). It is reached only through the sign-in door (remote.py), by logins the admin ticks in Data &
updates. An admin always has it; an AHJ login never does. This PC's own port has no logins, so the course isn't there.

Progress is one row per login. The page holds a copy in the browser and sends the whole of it after each change, with the
revision it last saw. A save on top of a newer revision comes back as a conflict with that newer copy, and the page merges
the two (the course's sync.js), so a phone and a PC never overwrite each other. Unticking a login keeps its progress.
"""
import html
import json
import os
import time

PAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "course", "index.html")
MAX_BODY = 4 * 1024 * 1024  # all 1,157 answers and 1,418 cards saved take a tenth of this
TABLES = ("course_progress",)
SCHEMA = """
CREATE TABLE IF NOT EXISTS course_progress(login TEXT PRIMARY KEY, rev INTEGER NOT NULL DEFAULT 0, data TEXT,
    summary TEXT NOT NULL DEFAULT '{}', saved_at TEXT, opened_at TEXT);
"""


def _now():
    return time.strftime("%Y-%m-%d %H:%M")


def page(login):
    """The page for this login, or None if it isn't on this copy. The tag is what turns on saving to the sign-in."""
    try:
        with open(PAGE, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    return raw.replace(b"</head>", f'<meta name="course-login" content="{html.escape(login, quote=True)}"></head>'.encode(), 1)


def off_page():
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>DAS course · RF Recon</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 20px">'
            "<h1 style=\"font-size:20px\">The DAS course isn't on for this login</h1><p>Ask Cody to tick your account.</p>"
            '<p><a href="/">Back to RF Recon</a></p></body></html>')


def opened(con, login):
    con.execute("""INSERT INTO course_progress(login, opened_at) VALUES(?, ?)
                   ON CONFLICT(login) DO UPDATE SET opened_at=excluded.opened_at""", (login, _now()))
    con.commit()


def load(con, login):
    r = con.execute("SELECT rev, data FROM course_progress WHERE login=?", (login,)).fetchone()
    return {"rev": r["rev"] if r else 0, "data": json.loads(r["data"]) if r and r["data"] else None}


def clean_summary(s):
    """What the admin's table shows, as sent by the page: numbers stay numbers, words stay short."""
    s = s if isinstance(s, dict) else {}
    out = {k: int(s[k]) for k in ("done", "total", "mastery", "exams", "passed", "best") if isinstance(s.get(k), (int, float)) and not isinstance(s.get(k), bool)}
    out.update({k: s[k][:n] for k, n in (("rank", 20), ("last", 12), ("last_title", 120)) if isinstance(s.get(k), str)})
    return out


def save(con, login, rev, data, summary):
    """{"rev": new} when rev is the copy on file, else {"conflict": True, "rev": newer, "data": that copy}."""
    if not isinstance(rev, int) or isinstance(rev, bool) or not isinstance(data, dict):
        raise ValueError("A save needs the revision it was made from and the progress.")
    con.execute("INSERT OR IGNORE INTO course_progress(login) VALUES(?)", (login,))
    done = con.execute("""UPDATE course_progress SET rev=rev+1, data=?, summary=?, saved_at=? WHERE login=? AND rev=?""",
                       (json.dumps(data, separators=(",", ":")), json.dumps(clean_summary(summary)), _now(), login, rev)).rowcount
    con.commit()
    now = load(con, login)
    return {"rev": now["rev"]} if done else {"conflict": True, **now}


def overview(con, people):
    """Every account, as remote.users() lists them, with how far each has got."""
    rows = {r["login"]: r for r in con.execute("SELECT login, summary, saved_at, opened_at FROM course_progress")}
    out = []
    for u in people:
        r = rows.get(u["name"].strip().lower())
        out.append({**(json.loads(r["summary"] or "{}") if r else {}), "name": u["name"], "role": u["role"], "has": u["course"],
                    "opened_at": r["opened_at"] if r else None, "saved_at": r["saved_at"] if r else None})
    return out
