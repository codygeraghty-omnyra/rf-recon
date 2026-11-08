"""The "Needs a person" list (Data desk step 3): each step a person must do for a source, with the link and the steps.

A task says: the source and why it's needed; the link (the sign-up page, the form, the key page, or the page that refused,
to open yourself); the steps and what to enter; who does it (Cody, or Josh for anything paid or contractual); where the
key goes (Your API keys, or the sealed PC script). One open task per source and kind: the same refusal again only counts
up and moves its last-seen time.

Marking a task done doesn't close it. The desk then tests the source again (retest) and closes the task only when the
source answers; a test that still fails puts the task back on the list with what it said.

Works on any sqlite3 connection the caller passes (rows as sqlite3.Row). Standard library only; nothing here imports
DAStastic.
"""
import json
import time

KINDS = ("sign-up", "key", "form", "permission", "paid", "refused")
SCHEMA = """
CREATE TABLE IF NOT EXISTS desk_task(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, source_name TEXT, kind TEXT NOT NULL,
  why TEXT, link TEXT, steps TEXT, enter TEXT, who TEXT, key_goes TEXT, detail TEXT, status TEXT NOT NULL DEFAULT 'open',
  seen INTEGER NOT NULL DEFAULT 1, opened_at TEXT, last_seen TEXT, done_at TEXT, done_by TEXT, closed_at TEXT,
  last_test TEXT, last_test_result TEXT);
CREATE INDEX IF NOT EXISTS desk_task_open ON desk_task(status, source_id, kind);
"""
STEPS_REFUSED = ["Open the link yourself, in your own browser, and read what it asks for.",
                 "If it wants a sign-up, a key, a form or a permission, do that, then press Done here.",
                 "If it refuses outright, it stays refused: press Won't do, and look for a permitted source instead."]


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def ensure(con):
    con.executescript(SCHEMA)


def _row(r):
    d = dict(r)
    d["steps"] = json.loads(d["steps"] or "[]")
    return d


def file(con, source, kind, why, link="", steps=(), enter="", who=None, key_goes="", detail="", count=True):
    """Open a task, or count the same open one again (count=False: a re-check that saw it still there, not a new
    occurrence). A task a person marked "won't do" stands: the same source and kind isn't filed again. source: a registry
    entry ({"id", "name", "owner"}). Returns the task's id."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {', '.join(KINDS)}")
    who = who or ("Josh" if kind == "paid" else source.get("owner") or "Cody")
    t = now()
    r = con.execute("SELECT id, status, detail, link FROM desk_task WHERE source_id=? AND kind=? AND status IN ('open','done','won''t do') ORDER BY id DESC LIMIT 1",
                    (source["id"], kind)).fetchone()
    if r and r["status"] == "won't do":
        return r["id"]
    if r and not count and (not detail or detail == r["detail"]) and (not link or link == r["link"]):
        return r["id"]  # a re-check that saw nothing new writes nothing (each view of Data & updates re-checks)
    if r:
        con.execute("UPDATE desk_task SET seen=seen+?, last_seen=?, detail=COALESCE(NULLIF(?, ''), detail), link=COALESCE(NULLIF(?, ''), link) WHERE id=?",
                    (1 if count else 0, t, detail, link, r["id"]))
        con.commit()
        return r["id"]
    cur = con.execute("INSERT INTO desk_task(source_id, source_name, kind, why, link, steps, enter, who, key_goes, detail, opened_at, last_seen)"
                      " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                      (source["id"], source.get("name") or source["id"], kind, why, link, json.dumps(list(steps)), enter, who, key_goes, detail, t, t))
    con.commit()
    return cur.lastrowid


def from_refusal(con, source, refused, why_needed=""):
    """A source said no (fetchkit.Refused): the page to open yourself, and the steps."""
    detail = f"{refused.why}" + (f" (HTTP {refused.status})" if refused.status else "") + (f"; it asked to wait {refused.retry_after}" if refused.retry_after else "")
    return file(con, source, "refused", why_needed or f"{source.get('name') or source['id']} refused DAStastic's request.", link=refused.url,
                steps=STEPS_REFUSED, detail=detail)


def open_tasks(con, who=None):
    q = "SELECT * FROM desk_task WHERE status IN ('open','done')" + (" AND who=?" if who else "") + " ORDER BY status, opened_at"
    return [_row(r) for r in con.execute(q, (who,) if who else ())]


def mark_done(con, task_id, by):
    """A person says it's done: the task waits for the source's re-test (retest) before it closes."""
    con.execute("UPDATE desk_task SET status='done', done_at=?, done_by=? WHERE id=? AND status='open'", (now(), by, task_id))
    con.commit()


def wont_do(con, task_id, by, why):
    con.execute("UPDATE desk_task SET status='won''t do', done_at=?, done_by=?, last_test_result=? WHERE id=? AND status IN ('open','done')",
                (now(), by, why, task_id))
    con.commit()


def retest(con, task_id, test):
    """test(): (ok, what it said). ok closes the task; not ok puts it back on the list with what the source said."""
    try:
        ok, said = test()
    except Exception as e:  # a test that blows up is a failed test, never a closed task
        ok, said = False, f"{type(e).__name__}: {str(e)[:200]}"
    t = now()
    if ok:
        con.execute("UPDATE desk_task SET status='closed', closed_at=?, last_test=?, last_test_result=? WHERE id=?", (t, t, said, task_id))
    else:
        con.execute("UPDATE desk_task SET status='open', last_test=?, last_test_result=? WHERE id=?", (t, said, task_id))
    con.commit()
    return ok


def summary(con):
    """For Needs you and Josh's morning update: open counts by who, and the oldest few."""
    rows = open_tasks(con)
    by = {}
    for r in rows:
        by[r["who"]] = by.get(r["who"], 0) + 1
    return {"open": len(rows), "by_who": by, "oldest": [{"source": r["source_name"], "kind": r["kind"], "who": r["who"], "since": r["opened_at"][:10]}
                                                         for r in rows[:5]]}
