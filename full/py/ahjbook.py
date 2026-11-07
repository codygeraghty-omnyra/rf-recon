"""
The AHJ book (automation idea 4, 11/6): what one job learned about a jurisdiction, offered on the next job there.

A confirmed Code check (codecheck.confirm) writes one entry per job: the code, edition, amendment, policy, who has the final say,
what they told us, who confirmed it, when, and on which job. A later job in the same place, or with the same AHJ, is offered it.

It never clears the Code check gate. The product's rule is that the AHJ's answer governs this building (codecheck.AUTHORITY), so a
copied record decides nothing: use() fills the answers a job has blank and can't write confirmed_by or confirmed_on, which are not in
ANSWERS, so the job stays "started" and the gate keeps asking until a person records who at the AHJ confirmed it for this job. Nothing
applies an entry by itself: Run it for me doesn't, and only a press reaches use().

Where a job is (keys_of). A Census place from the pin, else the county when the pin is in no incorporated place (a census-designated
place's name is added, so a job with only a typed address can still meet it). A job with no pin lookup has the typed city. A mailing
city isn't added beside a pin's answer: unincorporated Fairfax County mails as "Fairfax, VA", and that isn't the City of Fairfax.
The job's named AHJ is the other key, for a county fire marshal who covers towns with their own names.

An entry reads as old past OLD_MONTHS, or once the state's row has moved since it was confirmed. Twelve months is a rule of thumb, not a
code: model codes turn over every three years, and a local amendment can change any day.

"Firm" means this server's whole team for now: the app has logins with roles, no firm. A login sees every entry, as one team's notes,
but a job it can't open is "another job", never its name.
"""
import datetime
import json
import re
import sqlite3
import time

import das
import dashist

ANSWERS = ("code", "edition", "amendment", "policy", "final_say", "radio_shop", "third_party", "stages", "read_url", "read_note", "note")
OLD_MONTHS = 12
GENERIC = {"fire", "marshal", "marshals", "department", "dept", "office", "the", "of", "rescue", "prevention", "bureau", "division", "services", "service",
           "county", "city", "town", "village", "township", "state", "and", "chief", "code", "official", "ahj"}


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def _ahj_key(name):
    """A generic name ("Fire Marshal") says nothing about where: it gets no key."""
    n = _norm(name)
    return f"a:{n}" if set(n.split()) - GENERIC else ""


def keys_of(job, where, typed):
    """The keys a job answers to, and how to say where it is: (keys, state, place words, county words). See the module note."""
    d, w, t = job.get("data") or {}, where or {}, typed or {}
    state = w.get("state") or t.get("state") or ""
    place, county, keys = w.get("place") or "", w.get("county") or "", []
    if w.get("state"):
        if place:
            keys.append(f"p:{state}|{_norm(w.get('place_base') or place)}")
        else:
            if county:
                keys.append(f"c:{state}|{_norm(w.get('county_base') or county)}")
            if w.get("cdp"):
                keys.append(f"p:{state}|{_norm(w.get('cdp_base') or w['cdp'])}")
    elif t.get("city") and state:
        place = t["city"]
        keys.append(f"p:{state}|{_norm(place)}")
    a = _ahj_key(d.get("ahj"))
    if a:
        keys.append(a)
    return keys, state, place, county


def _where_words(place, county, state):
    return ", ".join(x for x in (place or county, state) if x)


def _months(on, today):
    a = das._day(on)
    if not a:
        return None
    return max(0, (today.year - a.year) * 12 + today.month - a.month - (today.day < a.day))


def _age(on, today):
    m = _months(on, today)
    if m is None:
        return ""
    if m < 1:
        return "less than a month ago"
    if m < 24:
        return f"{m} month{'' if m == 1 else 's'} ago"
    return f"{m // 12} years ago"


def _names(con):
    return dict(con.execute("SELECT id, name FROM das_job").fetchall())


def team_vis(con):
    """The jobs this login may open, or None for every job: as app.py's team() and dashist.visible read it."""
    who = dashist.team_user()
    if not who:
        return None
    import remote
    return dashist.visible(con, who, remote.role_of(who) or "view")


def _public(r, names, vis, today, seen_now=None):
    """One entry as a page sees it. A job this login can't open has no name here."""
    answers = json.loads(r["answers"] or "{}")
    jid, m = r["job_id"], _months(r["confirmed_on"], today)
    can = jid in names and (vis is None or jid in vis)
    gone = jid not in names and vis is None
    moved = bool(seen_now and r["rule_seen"] and seen_now != r["rule_seen"])
    return {"id": r["id"], "where": _where_words(r["place"], r["county"], r["state"]), "ahj": r["ahj"] or "", "answers": answers, "confirmed_by": r["confirmed_by"] or "",
            "confirmed_on": r["confirmed_on"] or "", "how": r["how"] or "", "job_id": jid if can else None,
            "job": names[jid] if can else (f"{r['job_name']} (since deleted)" if gone else "another job"),
            "age": _age(r["confirmed_on"], today), "months": m, "old": m is None or m >= OLD_MONTHS, "moved": moved}


def _seen_of(state):
    import codecheck
    row = codecheck.state_row(state)
    return codecheck._seen(row) if row else ""


def offers(con, job, data_dir=None, fetch=None, vis=None, today=None):
    """What the book holds for this job, newest confirmation first. Its own entry isn't offered back to it."""
    import codecheck
    today = today or datetime.date.today()
    where, typed = codecheck.where_of(job, data_dir, fetch)
    mine, state, _, _ = keys_of(job, where, typed)
    if not mine:
        return []
    names, out = _names(con), []
    rows = con.execute("SELECT * FROM das_ahj_book WHERE job_id<>? ORDER BY confirmed_on DESC, id DESC", (job["id"],)).fetchall()
    for r in rows:
        have = set(json.loads(r["keys"] or "[]")) & set(mine)
        if not have:
            continue
        if not any(k[0] in "pc" for k in have) and state and r["state"] and state != r["state"]:
            continue  # one AHJ name in two states: two jurisdictions
        e = _public(r, names, vis, today, _seen_of(r["state"]))
        e["match"] = "place" if any(k[0] in "pc" for k in have) else "ahj"
        out.append(e)
    return out


def listing(con, vis=None, today=None):
    """Every entry, for the Equipment and people screen."""
    today = today or datetime.date.today()
    names = _names(con)
    rows = con.execute("SELECT * FROM das_ahj_book ORDER BY state, place, county, confirmed_on DESC").fetchall()
    return [_public(r, names, vis, today, _seen_of(r["state"])) for r in rows]


def keep(con, job, data_dir=None, fetch=None):
    """Called on every Code check save. A confirmed job's answers go in the book, or replace what it had there. A job that no longer
    says it's confirmed takes its entry back, so the book can't claim what the job doesn't. An example job and a confirmation with no
    answers keep nothing."""
    import codecheck
    d = job.get("data") or {}
    c = d.get("code_check") or {}
    answers = {k: str(c.get(k) or "").strip() for k in ANSWERS if str(c.get(k) or "").strip()}
    if d.get("example") or codecheck.status(d) != "confirmed" or not answers:
        con.execute("DELETE FROM das_ahj_book WHERE job_id=?", (job["id"],))
        con.commit()
        return None
    where, typed = codecheck.where_of(job, data_dir, fetch)
    keys, state, place, county = keys_of(job, where, typed)
    if not keys:
        return None  # nowhere to offer it: no pin, no city, no AHJ named
    con.execute("""INSERT INTO das_ahj_book(job_id, job_name, state, place, county, ahj, keys, answers, confirmed_by, confirmed_on, how, rule_seen, by, updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(job_id) DO UPDATE SET job_name=excluded.job_name, state=excluded.state, place=excluded.place, county=excluded.county, ahj=excluded.ahj,
                   keys=excluded.keys, answers=excluded.answers, confirmed_by=excluded.confirmed_by, confirmed_on=excluded.confirmed_on, how=excluded.how,
                   rule_seen=excluded.rule_seen, by=excluded.by, updated_at=excluded.updated_at""",
                (job["id"], job.get("name"), state, place, county, d.get("ahj") or "", json.dumps(keys), json.dumps(answers), c["confirmed_by"].strip(), c["confirmed_on"].strip(),
                 c.get("how") or "", c.get("rule_seen") or "", dashist.who_now(), das.now()))
    con.commit()
    return keys


def seed(con):
    """Jobs confirmed before the book began. From what's on this machine only: the place lookups already kept, and the typed address."""
    import uls_import

    def offline(url):
        raise OSError("not looked up while starting")

    try:
        rows = con.execute("""SELECT id, name, stage, data FROM das_job WHERE data LIKE '%confirmed_on%'
                              AND id NOT IN (SELECT job_id FROM das_ahj_book)""").fetchall()
    except sqlite3.Error:  # a test's bare database
        return
    import codecheck
    for r in rows:
        job = {"id": r[0], "name": r[1], "stage": r[2], "data": json.loads(r[3] or "{}")}
        if codecheck.status(job["data"]) == "confirmed":
            keep(con, job, uls_import.DATA_DIR, offline)


def use(con, job, entry, who=None, vis=None):
    """A person pressed Use these answers. It fills what this job has blank, never over what's there, and never who confirmed it: the
    job stays started, so the gate still asks. The job remembers where the words came from."""
    import codecheck
    d = job.get("data") or {}
    if codecheck.status(d) == "confirmed":
        raise ValueError("This job is already confirmed, so nothing was changed.")
    r = con.execute("SELECT * FROM das_ahj_book WHERE id=?", (int(entry),)).fetchone()
    if not r:
        raise LookupError("That entry has left the book.")
    src = json.loads(r["answers"] or "{}")
    cur = dict(d.get("code_check") or {})
    filled = {}
    for k in ANSWERS:
        if str(src.get(k) or "").strip() and not str(cur.get(k) or "").strip():
            cur[k] = filled[k] = str(src[k]).strip()[:1000]
    names = _names(con)
    can = r["job_id"] in names and (vis is None or r["job_id"] in vis)
    cur["book"] = {"entry": r["id"], "by": r["confirmed_by"], "on": r["confirmed_on"], "job": names[r["job_id"]] if can else "another job",
                   "at": time.strftime("%Y-%m-%d"), "who": who or dashist.who_now(), "filled": filled}
    return das.save_job(con, {"data": {"code_check": cur}}, job["id"], who=who, note_=f"AHJ book: {len(filled)} answers filled from {r['confirmed_on']}. Not confirmed for this job")


def undo(con, job, who=None):
    """Takes the book's answers back out, each only if it still says what the book put there."""
    d = job.get("data") or {}
    cur = dict(d.get("code_check") or {})
    b = cur.pop("book", None)
    if not b:
        return job
    for k, v in (b.get("filled") or {}).items():
        if cur.get(k) == v:
            cur.pop(k, None)
    return das.save_job(con, {"data": {"code_check": cur}}, job["id"], who=who, note_="AHJ book: answers taken back out")


def remove(con, entry, vis=None):
    """A person takes an entry out. It comes back if the job it came from is confirmed again."""
    r = con.execute("SELECT job_id FROM das_ahj_book WHERE id=?", (int(entry),)).fetchone()
    if not r:
        raise LookupError("That entry has already left the book.")
    if vis is not None and r[0] not in vis and r[0] in _names(con):
        raise dashist.NotAllowed("That entry came from a job you can't open.")
    con.execute("DELETE FROM das_ahj_book WHERE id=?", (int(entry),))
    con.commit()
    return {"ok": True}
