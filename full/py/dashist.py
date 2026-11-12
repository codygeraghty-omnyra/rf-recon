"""
DAS job revisions, version history, save conflicts, per-job access and share links (11/4).

Revisions. Every job has a revision number (das_job.rev). A page sends the revision its copy of the job came from with
every save. When someone else saved the same job since, the server merges: each section (a top-level key of the job's
data, plus its name and stage) that only one side changed is taken from that side, and inside sections that are
dicts (grid results keyed "floor|grid", design, testing...) or lists of named items (floors, walk floors), each key or
item merges the same way. Only when both sides changed the same value differently is the save refused (409) with what
changed, so the page can ask: keep theirs, keep yours, or see both. A page's own earlier saves (the same login and the
same page, its "client" id) never count against it, so a fast walk's folded saves don't trip a false conflict. A
revision the job never had (above the current one, or not a number) is refused.

History. Each save writes one row per changed section to das_job_rev: who, when, the section's value before and after
(JSON, zlib-compressed). Saves by one person from one page within 90 seconds fold into one revision (up to 15
minutes), so a walk is one entry, not hundreds. Restore writes a new revision: history is never rewritten. Storage is
bounded per job: the newest 200 revisions always stay; older ones go once a job has more than 1000 revisions or
20 MB of history.

Access. das_access holds who can open each job: a login (by its lowercase name) at view, review or edit, or "*" for
the whole team (every view or full login, at their login's own level). Jobs that existed before this was built, and
new jobs, start shared with the whole team, as before; the team login that makes a job is put on it by name. An admin
login and the PC's own window see every job. An "ahj" login sees only jobs shared with it by name, and only the
review view: the job summary, the readings, the files picked for review, and Accept / Return with a comment.

Share links. A read-only link per job that expires (1 to 90 days); only its SHA-256 is kept. They are off until the
admin turns them on (setting das.share_links), and a link made while on stops working when they are turned off.
"""
import hashlib
import json
import re
import secrets
import time
import zlib

now = lambda: time.strftime("%Y-%m-%d %H:%M:%S")

SCHEMA = """
CREATE TABLE IF NOT EXISTS das_job_rev(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, rev INTEGER NOT NULL, rev_lo INTEGER NOT NULL,
    saves INTEGER NOT NULL DEFAULT 1, ts TEXT, ts_lo TEXT, who TEXT, client TEXT, section TEXT NOT NULL, before BLOB, after BLOB,
    bytes INTEGER NOT NULL DEFAULT 0, note TEXT);
CREATE INDEX IF NOT EXISTS das_job_rev_job ON das_job_rev(job_id, rev);
CREATE TABLE IF NOT EXISTS das_access(job_id INTEGER NOT NULL, who TEXT NOT NULL, level TEXT NOT NULL, added_by TEXT, added_at TEXT,
    PRIMARY KEY(job_id, who));
CREATE TABLE IF NOT EXISTS das_share(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT,
    made_by TEXT, made_at TEXT, expires TEXT NOT NULL, revoked TEXT, last_used TEXT, uses INTEGER NOT NULL DEFAULT 0);
"""
TABLES = ("das_job_rev", "das_access", "das_share")

KEEP_MIN, MAX_REVS, MAX_BYTES = 200, 1000, 20_000_000  # per job: the newest 200 always stay
FOLD_S, FOLD_SPAN_S, FOLD_MAX = 90, 15 * 60, 400  # one person's saves from one page fold into one revision
RESERVED = ("review",)  # written only by the review route (an AHJ's decision), never by a page's save
LEVELS = ("view", "review", "edit")
SHARE_DAYS = (1, 90)

LABELS = {":name": "Job name", ":stage": "Stage", "presurvey": "Pre-survey", "floors": "Floors", "grid": "Grid test",
          "walk": "Walk test", "require": "Requirements", "profile": "AHJ profile", "testing": "Testing", "checks": "Compliance",
          "building": "Building outline", "contacts": "People", "notes": "Notes", "address": "Address", "client": "Client",
          "ahj": "AHJ", "code": "Code basis", "next_step": "Next step", "due": "Due", "value": "Value", "design": "Design",
          "bom": "Materials (BOM)", "bom_settings": "Materials settings", "bom_revs": "BOM revisions", "material_checks": "Materials checks", "pim": "PIM", "screen": "Screening",
          "cellular": "Cellular", "legacy": "Existing system", "consents": "Licensee consent", "review": "AHJ review",
          "lat": "Latitude", "lon": "Longitude", "area_sqft": "Area", "construction": "Construction", "nsi": "Building (NSI)",
          "booster_class": "Booster class", "accepted_on": "Accepted on", "retest_due": "Retest due", "lic_watch": "Licence watch",
          "tunnels_near": "Tunnels near", "ahj_guess": "AHJ lookup", "lifecycle": "Lifecycle dates", "review_files": "Files for review"}


class _Absent:
    def __repr__(self):
        return "ABSENT"


ABSENT = _Absent()  # a key that isn't there (different from a JSON null)
NO_REV = object()  # the save didn't say which revision it started from


class Refused(Exception):
    """A save the server won't make: .status (409 / 428) and .body (JSON for the page)."""

    def __init__(self, status, body):
        super().__init__(body.get("error"))
        self.status, self.body = status, body


class NotAllowed(Exception):
    """A job this login can see but may not change this way (403)."""


def label(section):
    return LABELS.get(section) or section.lstrip(":").replace("_", " ").capitalize()


# ---------------------------------------------------------------- tables

_READY = set()


def ensure(con):
    """The revision column and these tables, made once per database file. Jobs that were there before access lists
    existed are shared with the whole team, as they were."""
    try:
        key = con.execute("PRAGMA database_list").fetchone()[2] or ""
    except Exception:
        key = ""
    if key and key in _READY:
        return
    cols = {r[1] for r in con.execute("PRAGMA table_info(das_job)")}
    if not cols:
        return
    for stmt in SCHEMA.split(";"):
        if stmt.strip():
            con.execute(stmt)
    if "rev" not in cols:
        con.execute("ALTER TABLE das_job ADD COLUMN rev INTEGER NOT NULL DEFAULT 0")
        con.execute("INSERT OR IGNORE INTO das_access(job_id, who, level, added_by, added_at) SELECT id, '*', 'edit', 'DAStastic', ? FROM das_job",
                    (now(),))
    con.commit()
    if key:
        _READY.add(key)


def begin(con):
    """Read, check and write a job as one step: two saves at once can't both pass the revision check."""
    if con.in_transaction:
        con.commit()
    con.execute("BEGIN IMMEDIATE")


def who_now():
    """Who is saving: the signed-in login (admin too), the PC's own window, or DAStastic itself."""
    try:
        import remote
        return getattr(remote.ON, "login", None) or getattr(remote.ON, "user", None) or "local"
    except Exception:
        return "local"


def team_user():
    """The signed-in team login (view, full or ahj), or None for the admin and the PC's own window."""
    try:
        import remote
        return getattr(remote.ON, "user", None)
    except Exception:
        return None


def _pack(v):
    if v is ABSENT:
        return None, 0
    raw = json.dumps(v, separators=(",", ":"), ensure_ascii=False).encode()
    z = zlib.compress(raw, 6)
    return z, len(z)


def _unpack(b):
    return ABSENT if b is None else json.loads(zlib.decompress(b))


# ---------------------------------------------------------------- merge

def _key_field(*lists):
    """The field that names each item ("id", "name" or "key") when every item in these lists is a dict with a unique
    one, so lists like floors merge item by item; None otherwise."""
    for f in ("id", "name", "key"):
        ok = True
        for ls in lists:
            seen = set()
            for x in ls:
                v = x.get(f) if isinstance(x, dict) else None
                if not isinstance(v, (str, int)) or isinstance(v, bool) or v == "" or v in seen:
                    ok = False
                    break
                seen.add(v)
            if not ok:
                break
        if ok and any(lists):
            return f
    return None


def merge3(b, t, m, path, pick):
    """Three-way merge: b = the value both sides started from, t = theirs (the server's now), m = mine (this save).
    pick(path, t, m) settles a value both changed differently (or records the conflict)."""
    # empty both ways is no change (review 11/11: Undo wrote null where the key had been missing, and a view drawn before it then
    # clashed on "theirs: empty, yours: Fairfax")
    if m == b or (_blank(m) and _blank(b)):
        return t
    if t == b or t == m or (_blank(t) and _blank(b)):
        return m
    if isinstance(t, dict) and isinstance(m, dict) and (b is ABSENT or isinstance(b, dict)):
        bb = b if isinstance(b, dict) else {}
        out = {}
        for k in list(t) + [k for k in m if k not in t]:
            r = merge3(bb.get(k, ABSENT), t.get(k, ABSENT), m.get(k, ABSENT), path + [str(k)], pick)
            if r is not ABSENT:
                out[k] = r
        return out
    if isinstance(t, list) and isinstance(m, list) and (b is ABSENT or isinstance(b, list)):
        bl = b if isinstance(b, list) else []
        f = _key_field(bl, t, m)
        if f:
            bm, tm, mm = ({x[f]: x for x in ls} for ls in (bl, t, m))
            out = []
            for k in [x[f] for x in t] + [x[f] for x in m if x[f] not in tm]:
                r = merge3(bm.get(k, ABSENT), tm.get(k, ABSENT), mm.get(k, ABSENT), path + [str(k)], pick)
                if r is not ABSENT:
                    out.append(r)
            return out
    return pick(path, t, m)


def _blank(v):
    """Missing, None, "", {} or []: shown as nothing, so a change from one blank to another isn't a change."""
    return v is ABSENT or v is None or (isinstance(v, (str, list, dict)) and not v)


def fmt(v, n=80):
    """A value, short and readable."""
    if v is ABSENT or v is None or v == "":
        return "empty"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return f"{v:g}" if isinstance(v, float) else str(v)
    if isinstance(v, str):
        return "“" + (v if len(v) <= n else v[:n - 1] + "…") + "”"
    if isinstance(v, list):
        return f"{len(v)} item{'' if len(v) == 1 else 's'}"
    if isinstance(v, dict):
        if not v:
            return "empty"
        s = json.dumps(v, ensure_ascii=False)
        return s if len(s) <= n else f"{len(v)} field{'' if len(v) == 1 else 's'}"
    return str(v)


def _states(con, jid, cur_rev, base_rev, sections, me):
    """Each section's value as of base_rev, walked back from the server's current value through the history, with
    this page's own later saves (me = (who, client)) left in. Returns ({section: value}, complete)."""
    if base_rev >= cur_rev:
        return {}, True
    lo = con.execute("SELECT MIN(rev_lo) FROM das_job_rev WHERE job_id=?", (jid,)).fetchone()[0]
    complete = lo is not None and lo <= base_rev + 1
    out = {}
    secs = list(sections)
    for i in range(0, len(secs), 500):
        part = secs[i:i + 500]
        for r in con.execute(f"SELECT section, who, client, before FROM das_job_rev WHERE job_id=? AND rev>? AND section IN "
                             f"({','.join('?' * len(part))}) ORDER BY rev DESC, id DESC", [jid, base_rev] + part):
            if me[1] and (r[1], r[2]) == me:
                continue  # this page's own save: never against itself
            out[r[0]] = _unpack(r[3])
    return out, complete


def check(con, jid, cur, cur_rev, patch, base_rev, who, client, need_rev=False, resolve=None, by=None):
    """The patch to apply: merged with what others saved since base_rev, or Refused. cur and patch map sections
    (":name", ":stage" and the data's keys) to values."""
    if base_rev is NO_REV or base_rev is None:
        if need_rev:
            raise Refused(428, {"error": "This page is older than the server. Reload it, then make the change again.", "reload": True})
        return patch  # DAStastic's own saves and the PC's scripts: section by section, as before
    if isinstance(base_rev, bool) or not isinstance(base_rev, int) or base_rev < 0 or base_rev > cur_rev:
        raise Refused(409, {"error": "That save names a revision this job never had. Reload the job, then make the change again.",
                            "reload": True, "rev": cur_rev})
    if base_rev == cur_rev:
        return patch
    me = (who, client or "")
    base, complete = _states(con, jid, cur_rev, base_rev, patch.keys(), me)
    resolve = resolve if isinstance(resolve, dict) else {}
    conflicts = []

    def pick(path, t, m):
        how = resolve.get(path[0])
        if how == "mine":
            return m
        if how != "theirs":
            conflicts.append({"path": path, "theirs": t, "mine": m})
        return t

    out = {}
    for s, m in patch.items():
        t = cur.get(s, ABSENT)
        if s in base:
            b = base[s]
        elif complete:
            b = t  # no one else changed it since
        else:  # the history that far back was pruned: only an equal value merges
            b = ABSENT if t != m else t
            if t != m:
                out[s] = pick([s], t, m)
                continue
        out[s] = merge3(b, t, m, [s], pick)
    if conflicts:
        secs = []
        for s in dict.fromkeys(c["path"][0] for c in conflicts):
            last = con.execute("SELECT who, ts, client FROM das_job_rev WHERE job_id=? AND section=? AND rev>? ORDER BY rev DESC LIMIT 1",
                               (jid, s, base_rev)).fetchone()
            # Run it for me saves under the page's client id + ":auto" (static/dasrev.js DASREV.auto): the dialog says it was the run
            secs.append({"key": s, "label": label(s), "by": (last[0] if last else "") or "someone", "at": last[1] if last else "",
                         "auto": bool(last and (last[2] or "").endswith(":auto")),
                         "paths": [{"path": " › ".join([label(s)] + c["path"][1:]), "theirs": fmt(c["theirs"]), "mine": fmt(c["mine"])}
                                   for c in conflicts if c["path"][0] == s][:12]})
        names = ", ".join(x["label"] for x in secs)
        raise Refused(409, {"error": f"Someone else changed {names} just now.", "conflict": True, "rev": cur_rev, "sections": secs,
                            "by": by})
    return out


# ---------------------------------------------------------------- history

# the newest revision of each job each page has drawn (GET /api/das/jobs/<id>?view=<the page's client id>, dasrev.js dasJobApi): a save is
# never folded into a revision another page was drawn from since, or that page's next save would be merged against the folded row's
# older value (review round 6: a false "Someone else changed Area" during Run it for me, and across pages a tester put back silently).
# A page's own draw doesn't stop its own saves folding (round 7: every view redraws after its save, so every save was its own History
# entry): _states skips that page's rows anyway. A page is its client id, and its patch and Run it for me ids (":patch", ":auto")
SEEN = {}


def _seen_key(con, jid):
    return (con.execute("PRAGMA database_list").fetchone()[2] or str(id(con)), jid)


def seen(con, jid, rev, client=""):
    pages = SEEN.setdefault(_seen_key(con, jid), {})
    p = str(client)[:40] if client not in (None, "", "1") else "?"  # an older page that says only view=1: anyone's
    pages[p] = max(pages.get(p, 0), rev or 0)


def _drawn_by_another(con, jid, rev, client):
    # only the very client that drew it is "mine" (review round 8): Run it for me's and a patch's saves (":auto", ":patch") folded into
    # a revision the page's views drew, so that page's next save was merged against the folded row's pre-run value, which _states
    # counts as someone else's (a lost edit, or a false "Run it for me changed AHJ")
    me = str(client or "")[:40]
    return any(r >= rev for p, r in SEEN.get(_seen_key(con, jid), {}).items() if p == "?" or p != me)


def record(con, jid, rev, who, client, changed, note=None, fold=True):
    """Write one revision: changed maps each section to (before, after). Folds into the last revision when it was the
    same person on the same page a moment ago (and nothing else was saved since, and no page was drawn from it)."""
    t = now()
    if note == "new job":  # a job id can be used again after a delete: a mark from the old job doesn't stop this one's folding
        SEEN.pop(_seen_key(con, jid), None)
    if fold and client and not note and not _drawn_by_another(con, jid, rev - 1, client):
        last = con.execute("SELECT id, section, who, client, ts, ts_lo, saves, rev, rev_lo, note FROM das_job_rev WHERE job_id=? "
                           "AND rev=(SELECT MAX(rev) FROM das_job_rev WHERE job_id=?)", (jid, jid)).fetchall()
        if last and last[0][7] == rev - 1 and all(r[2] == who and r[3] == client and not r[9] for r in last) and last[0][6] < FOLD_MAX:
            age = time.time() - time.mktime(time.strptime(last[0][4], "%Y-%m-%d %H:%M:%S"))
            span = time.time() - time.mktime(time.strptime(last[0][5] or last[0][4], "%Y-%m-%d %H:%M:%S"))
            if age <= FOLD_S and span <= FOLD_SPAN_S:
                have = {r[1]: r for r in last}
                lo, saves = last[0][8], last[0][6] + 1
                for s, (b, a) in changed.items():
                    pa, na = _pack(a)
                    if s in have:
                        con.execute("UPDATE das_job_rev SET after=?, bytes=length(COALESCE(before, ''))+?, ts=? WHERE id=?", (pa, na, t, have[s][0]))
                    else:  # unchanged through the folded saves: its value before this save is its value before them
                        pb, nb = _pack(b)
                        con.execute("INSERT INTO das_job_rev(job_id, rev, rev_lo, saves, ts, ts_lo, who, client, section, before, after, bytes) "
                                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (jid, rev, lo, saves, t, last[0][5] or last[0][4], who, client, s, pb, pa, nb + na))
                con.execute("UPDATE das_job_rev SET rev=?, saves=?, ts=? WHERE job_id=? AND rev=?", (rev, saves, t, jid, rev - 1))
                con.execute("DELETE FROM das_job_rev WHERE job_id=? AND rev=? AND before IS after", (jid, rev))  # A -> B -> A
                for r in con.execute("SELECT id, before, after FROM das_job_rev WHERE job_id=? AND rev=?", (jid, rev)).fetchall():
                    if r[1] is not None and r[2] is not None and _unpack(r[1]) == _unpack(r[2]):
                        con.execute("DELETE FROM das_job_rev WHERE id=?", (r[0],))
                return
    for s, (b, a) in changed.items():
        pb, nb = _pack(b)
        pa, na = _pack(a)
        con.execute("INSERT INTO das_job_rev(job_id, rev, rev_lo, saves, ts, ts_lo, who, client, section, before, after, bytes, note) "
                    "VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?)", (jid, rev, rev, t, t, who, client or "", s, pb, pa, nb + na, note))


def prune(con, jid):
    """Bounded history: never the newest KEEP_MIN revisions; older ones go once the job has more than MAX_REVS
    revisions or MAX_BYTES of history. Returns how many revisions went."""
    per = con.execute("SELECT rev, SUM(bytes) FROM das_job_rev WHERE job_id=? GROUP BY rev ORDER BY rev", (jid,)).fetchall()
    n, total = len(per), sum(r[1] or 0 for r in per)
    if n <= KEEP_MIN or (n <= MAX_REVS and total <= MAX_BYTES):
        return 0
    cut, gone = None, 0
    for rev, size in per[:n - KEEP_MIN]:
        if n - gone <= MAX_REVS and total <= MAX_BYTES:
            break
        cut, gone, total = rev, gone + 1, total - (size or 0)
    if cut is not None:
        con.execute("DELETE FROM das_job_rev WHERE job_id=? AND rev<=?", (jid, cut))
    return gone


def _flat(v, path, out):
    if isinstance(v, dict):
        for k, x in v.items():
            _flat(x, path + [str(k)], out)
    else:
        out[" › ".join(path)] = v
    return out


def describe(section, before, after, limit=12):
    """What changed in one section, in plain lines."""
    lines = []
    if _blank(before) and _blank(after):
        return lines
    if isinstance(before, list) or isinstance(after, list):
        bl = before if isinstance(before, list) else []
        al = after if isinstance(after, list) else []
        f = _key_field(bl, al)
        if f:
            bm, am = {x[f]: x for x in bl}, {x[f]: x for x in al}
            add = [k for k in am if k not in bm]
            rm = [k for k in bm if k not in am]
            if add:
                lines.append(f"added {', '.join(map(str, add[:8]))}{'…' if len(add) > 8 else ''}")
            if rm:
                lines.append(f"removed {', '.join(map(str, rm[:8]))}{'…' if len(rm) > 8 else ''}")
            for k in am:
                if k in bm and am[k] != bm[k]:
                    a, b = _flat(am[k], [], {}), _flat(bm[k], [], {})
                    keys = [x for x in dict.fromkeys(list(b) + list(a)) if a.get(x, ABSENT) != b.get(x, ABSENT)]
                    lines.append(f"{k}: " + "; ".join(f"{x} {fmt(b.get(x, ABSENT), 40)} → {fmt(a.get(x, ABSENT), 40)}" for x in keys[:3])
                                 + (f" and {len(keys) - 3} more" if len(keys) > 3 else ""))
        else:
            lines.append(f"{fmt(before)} → {fmt(after)}")
    elif isinstance(before, dict) or isinstance(after, dict):
        b = _flat(before if isinstance(before, dict) else {}, [], {})
        a = _flat(after if isinstance(after, dict) else {}, [], {})
        diff = [(k, b.get(k, ABSENT), a.get(k, ABSENT)) for k in dict.fromkeys(list(b) + list(a))
                if (b.get(k, ABSENT) != a.get(k, ABSENT) or type(b.get(k, ABSENT)) is not type(a.get(k, ABSENT)))
                and not (_blank(b.get(k, ABSENT)) and _blank(a.get(k, ABSENT)))]
        groups = {}
        for k, x, y in diff:
            groups.setdefault(k.split(" › ")[0] if " › " in k else k, []).append((k, x, y))
        many = len(diff) > limit
        for g, items in groups.items():
            if many and len(items) > 3:  # e.g. 25 grid squares: one line with the counts and the first few
                add = sum(1 for _, x, _y in items if x is ABSENT)
                gone = sum(1 for _, _x, y in items if y is ABSENT)
                parts = [f"{n} {w}" for n, w in ((add, "added"), (len(items) - add - gone, "changed"), (gone, "removed")) if n]
                ex = "; ".join(f"{k.split(' › ', 1)[-1]} {fmt(y, 30)}" for k, _x, y in items[:3])
                lines.append(f"{g}: {', '.join(parts)} ({ex}…)")
                continue
            for k, x, y in items:
                if isinstance(x, list) or isinstance(y, list):
                    sub = describe("", x, y, 2)
                    lines.append(f"{k}: {sub[0] if sub else 'changed'}")
                else:
                    lines.append(f"{k}: {fmt(x)} → {fmt(y)}")
    else:
        lines.append(f"{fmt(before)} → {fmt(after)}")
    if len(lines) > limit:
        lines = lines[:limit] + [f"and {len(lines) - limit} more"]
    return lines


def history(con, jid, before=None, limit=40):
    """The job's revisions, newest first, each with who, when and a readable change per section."""
    lim = max(1, min(int(limit or 40), 200))
    revs = [r[0] for r in con.execute("SELECT DISTINCT rev FROM das_job_rev WHERE job_id=?" + (" AND rev<?" if before else "") +
                                      " ORDER BY rev DESC LIMIT ?", (jid, int(before), lim + 1) if before else (jid, lim + 1))]
    more = len(revs) > lim
    revs = revs[:lim]
    items = []
    if revs:
        rows = con.execute(f"SELECT rev, rev_lo, saves, ts, ts_lo, who, section, before, after, note FROM das_job_rev WHERE job_id=? AND rev IN "
                           f"({','.join('?' * len(revs))}) ORDER BY rev DESC, id", [jid] + revs).fetchall()
        by = {}
        for r in rows:
            it = by.setdefault(r[0], {"rev": r[0], "rev_lo": r[1], "saves": r[2], "ts": r[3], "ts_lo": r[4], "who": r[5] or "", "note": r[9] or "",
                                      "sections": []})
            b, a = _unpack(r[7]), _unpack(r[8])
            lines = describe(r[6], b, a)
            if lines:
                it["sections"].append({"key": r[6], "label": label(r[6]), "lines": lines})
        items = [by[r] for r in revs if r in by]
    st = con.execute("SELECT COUNT(DISTINCT rev), COALESCE(SUM(bytes), 0), MIN(rev_lo) FROM das_job_rev WHERE job_id=?", (jid,)).fetchone()
    cur = con.execute("SELECT rev FROM das_job WHERE id=?", (jid,)).fetchone()
    return {"rev": cur[0] if cur else 0, "items": items, "more": more,
            "kept": {"revisions": st[0], "bytes": st[1], "oldest": st[2], "keep_min": KEEP_MIN, "max_revisions": MAX_REVS, "max_bytes": MAX_BYTES}}


def state_at(con, jid, cur, rev):
    """Every section as it was right after revision rev (walked back from cur). Raises LookupError when that
    revision isn't kept."""
    have = con.execute("SELECT 1 FROM das_job_rev WHERE job_id=? AND rev=? LIMIT 1", (jid, rev)).fetchone()
    if not have:
        raise LookupError(f"Revision {rev} isn't kept any more.")
    out = dict(cur)
    for r in con.execute("SELECT section, before FROM das_job_rev WHERE job_id=? AND rev>? ORDER BY rev DESC, id DESC", (jid, rev)):
        out[r[0]] = _unpack(r[1])
    return out


def restore_patch(con, jid, cur, rev, mode):
    """The patch that undoes revision rev (mode "undo": its sections back as they were before it) or puts the whole job
    back as it was right after it (mode "to"). The AHJ's review is never put back."""
    if mode == "undo":
        rows = con.execute("SELECT section, before FROM das_job_rev WHERE job_id=? AND rev=?", (jid, rev)).fetchall()
        if not rows:
            raise LookupError(f"Revision {rev} isn't kept any more.")
        patch = {r[0]: _unpack(r[1]) for r in rows}
    elif mode == "to":
        st = state_at(con, jid, cur, rev)
        patch = {s: v for s, v in st.items() if cur.get(s, ABSENT) != v}
    else:
        raise ValueError("Restore is undo (this change) or to (the job as it was then).")
    patch = {s: v for s, v in patch.items() if s not in RESERVED}
    if ":name" in patch and not isinstance(patch[":name"], str):
        patch.pop(":name")
    if ":stage" in patch and not isinstance(patch[":stage"], str):
        patch.pop(":stage")
    return patch


# ---------------------------------------------------------------- access

def level(con, jid, login, role):
    """What this login may do on the job: "owner" (admin, the PC), "edit", "review", "view" or None."""
    if role == "admin" or not login:
        return "owner"
    rows = dict(con.execute("SELECT who, level FROM das_access WHERE job_id=?", (jid,)).fetchall())
    lv = rows.get(login.strip().lower()) or (rows.get("*") if role != "ahj" else None)
    if not lv:
        return None
    if role == "ahj":
        return "review" if lv in ("review", "edit") else "view"
    if role == "view":
        return "review" if lv == "review" else "view"
    return lv if lv in LEVELS else "view"


def visible(con, login, role):
    """The ids of the jobs this login may open, or None for every job."""
    if role == "admin" or not login:
        return None
    key = login.strip().lower()
    q = "SELECT job_id FROM das_access WHERE who=?" if role == "ahj" else "SELECT job_id FROM das_access WHERE who=? OR who='*'"
    return {r[0] for r in con.execute(q, (key,))}


def access_list(con, jid):
    return [dict(zip(("who", "level", "added_by", "added_at"), r)) for r in
            con.execute("SELECT who, level, added_by, added_at FROM das_access WHERE job_id=? ORDER BY who='*' DESC, who", (jid,))]


def grant(con, jid, who, lv, by):
    """Put a login on the job at a level, or take it off (lv "none"). who is a login's name or "*" (the whole team)."""
    key = (who or "").strip().lower()
    if not key:
        raise ValueError("Who?")
    if lv == "none":
        con.execute("DELETE FROM das_access WHERE job_id=? AND who=?", (jid, key))
    else:
        if lv not in (("view", "edit") if key == "*" else LEVELS):
            raise ValueError("The whole team is view or edit." if key == "*" else "A level is view, review or edit.")
        con.execute("INSERT INTO das_access(job_id, who, level, added_by, added_at) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(job_id, who) DO UPDATE SET level=excluded.level, added_by=excluded.added_by, added_at=excluded.added_at",
                    (jid, key, lv, by, now()))
    con.commit()
    return access_list(con, jid)


def on_create(con, jid, creator):
    """A new job: shared with the whole team (as jobs always were), and with the team login that made it."""
    con.execute("INSERT OR IGNORE INTO das_access(job_id, who, level, added_by, added_at) VALUES(?,?,?,?,?)", (jid, "*", "edit", "DAStastic", now()))
    if creator:
        con.execute("INSERT OR IGNORE INTO das_access(job_id, who, level, added_by, added_at) VALUES(?,?,?,?,?)",
                    (jid, creator.strip().lower(), "edit", creator, now()))


def forget(con, jid):
    """A deleted job: its access list, share links and history go with it."""
    for t in TABLES:
        con.execute(f"DELETE FROM {t} WHERE job_id=?", (jid,))


# ---------------------------------------------------------------- share links

TOKEN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")


def _h(token):
    return hashlib.sha256(token.encode()).hexdigest()


def share_make(con, jid, by, days, label_=""):
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 0
    if not SHARE_DAYS[0] <= days <= SHARE_DAYS[1]:
        raise ValueError(f"A link lasts {SHARE_DAYS[0]} to {SHARE_DAYS[1]} days.")
    token = secrets.token_urlsafe(32)
    exp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() + days * 86400))
    con.execute("INSERT INTO das_share(job_id, token_hash, label, made_by, made_at, expires) VALUES(?,?,?,?,?,?)",
                (jid, _h(token), (label_ or "").strip()[:80], by, now(), exp))
    con.commit()
    return {"token": token, "expires": exp}


def share_find(con, token):
    """The job a live link opens, or None (unknown, expired or revoked)."""
    if not token or not TOKEN.match(token):
        return None
    r = con.execute("SELECT id, job_id, expires, revoked FROM das_share WHERE token_hash=?", (_h(token),)).fetchone()
    if not r or r[3] or r[2] < now():
        return None
    con.execute("UPDATE das_share SET last_used=?, uses=uses+1 WHERE id=?", (now(), r[0]))
    con.commit()
    return r[1]


def share_list(con, jid):
    t = now()
    return [{"id": r[0], "label": r[1] or "", "made_by": r[2], "made_at": r[3], "expires": r[4], "revoked": r[5], "last_used": r[6],
             "uses": r[7], "state": "revoked" if r[5] else "expired" if r[4] < t else "live"}
            for r in con.execute("SELECT id, label, made_by, made_at, expires, revoked, last_used, uses FROM das_share WHERE job_id=? ORDER BY id DESC",
                                 (jid,))]


def share_revoke(con, jid, sid):
    con.execute("UPDATE das_share SET revoked=? WHERE id=? AND job_id=? AND revoked IS NULL", (now(), sid, jid))
    con.commit()
    return share_list(con, jid)


# ---------------------------------------------------------------- the review view (AHJ logins, share links)

REVIEW_KEYS = ("address", "ahj", "code", "client", "booster_class", "accepted_on", "retest_due", "area_sqft", "construction", "lat", "lon")


def review_files(d, files):
    """The job's files a reviewer sees: the ones picked for review, or else the floor plans and any PDF report."""
    names = [f["name"] for f in files]
    picked = d.get("review_files")
    if isinstance(picked, list):
        return [n for n in names if n in picked]
    plans = {f.get("plan") for f in (d.get("floors") or []) if isinstance(f, dict)}
    sealed = {f["name"] for f in files if f.get("kind") == "sealed_report"}  # intake.py: its verify code is on file. A guessed kind never shows here
    return [n for n in names if n in plans or n in sealed or (n.lower().endswith(".pdf") and "report" in n.lower())]


def review_view(job, files):
    """What a reviewer or a share link sees: the structured job, not its money, notes, people or mail."""
    d = job.get("data") or {}
    rv = d.get("review") if isinstance(d.get("review"), dict) else {}
    return {"id": job["id"], "name": job["name"], "stage": job["stage"], "rev": job.get("rev", 0), "updated_at": job.get("updated_at"),
            **{k: d.get(k) for k in REVIEW_KEYS}, "profile": d.get("profile"), "testing": d.get("testing") or {},
            "floors": [{k: f.get(k) for k in ("name", "plan", "grids", "skip", "critical", "cols", "rows", "area_sqft") if k in f}
                       for f in (d.get("floors") or []) if isinstance(f, dict)],
            "grid": {k: v for k, v in (d.get("grid") or {}).items() if k in ("results", "critical", "channels", "inst")},
            "require": {k: v for k, v in (d.get("require") or {}).items() if k in ("critical", "other")},
            "review": {"status": rv.get("status") or "waiting", "thread": rv.get("thread") or []},
            "files": review_files(d, files)}


def review_add(rv, who, role, decision, comment):
    """One entry on the review thread: an AHJ's Accept / Return, or a comment from either side."""
    if decision not in ("accept", "return", "comment"):
        raise ValueError("A review is accept, return or comment.")
    comment = (comment or "").strip()[:4000]
    if decision == "return" and not comment:
        raise ValueError("Say what needs fixing.")
    if decision == "comment" and not comment:
        raise ValueError("Write the comment first.")
    rv = dict(rv or {})
    thread = list(rv.get("thread") or [])[-199:]
    thread.append({"ts": now(), "who": who, "role": role, "decision": decision, "comment": comment})
    rv["thread"] = thread
    if decision != "comment":
        rv.update(status="accepted" if decision == "accept" else "returned", by=who, at=thread[-1]["ts"])
    return rv
