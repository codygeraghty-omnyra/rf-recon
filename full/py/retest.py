"""
Retest rollover (Cody 11/6): when a job's annual or five-year test comes due, the retest opens itself as a test pass on that job, and when
it's done its dates are proposed from the sealed report and the report sent. A filed date is a legal record, so a date only changes when a
person presses it. A date a person typed wins: it ends the proposal. The first acceptance is never written to: not its dates, its tests, its
walk or its sealed reports.

The pass opens by being worked out, not by being written. state() reads it from the lifecycle dates (das.lifecycle) every time, and the Walk
page shows it as the pass being walked (daswalk.js wkRetestOpen). It lands in data.walk with the first reading. So a job nobody has touched
hasn't changed: a save doesn't happen behind anyone, a look-only login sees the same thing, and the acceptance report's seal still reads
unchanged. Floors, squares and the critical list are the job's own, so they carry by themselves.

What counts as done is what the sealed report holds, not what its name says. A seal counts for this retest when its grid has readings
dated inside the retest. It proposes a date only if the report reads PASS and every tested square was tested this time: a square still
holding last year's reading would otherwise pass this year's test. The date is the day of the last reading, not the day of the seal. A
person can still type any date on the Lifecycle panel; held only says why nothing was proposed.
"""
import json
import re
import time
from datetime import date, datetime, timedelta

import das

KIND = {"annual": ("Annual test", ("annual_last",)), "five_year": ("Five-year retest", ("quant5_last", "annual_last"))}
LABEL = {"annual_last": "Last annual test", "quant5_last": "Last five-year retest", "report_filed": "Report filed with the AHJ"}
HAS_VALUE = ("dl", "daq", "sinr", "ul", "ul_daq", "rsrp", "rsrq")


# ---------------------------------------------------------------- what a reading is worth

def _stamp(s):
    """A moment in seconds, or None. A date alone counts from the start of that day."""
    try:
        return datetime.fromisoformat(str(s or "").strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _when(s):
    """The day a reading was taken, where this server is: a page's clock writes UTC, which after 7 PM Eastern is tomorrow."""
    t = _stamp(s)
    return datetime.fromtimestamp(t).date() if t is not None else das._day(s)


def inst_state(i, at=None):
    """static/das.js instState: can an instrument's readings count at a moment. (ok, why). A certificate's own expiry beats the 12-month rule."""
    at = time.time() if at is None else at
    cal, exp = _stamp(i.get("cal")), _stamp(f"{i.get('expires') or ''}T23:59:59")
    if cal is None:
        return False, "no calibration date"
    if exp is not None:
        return (False, f"certificate expired {i['expires']}") if at > exp else (True, f"calibrated {i.get('cal')}, certificate to {i['expires']}")
    if at - cal > das.CAL_MONTHS * 30.44 * 86400:
        return False, f"calibration over {das.CAL_MONTHS} months old"
    return True, f"calibrated {i.get('cal')}"


def inst_at(i, at):
    """static/das.js instAt: the calibration in force when a reading was taken. A job that took a newer calibration keeps the earlier
    ones (i["prior"], dasfirm.py), and a reading stands on its own, so a newer certificate can't change an old reading's result."""
    prior, cal = i.get("prior") or [], _stamp(i.get("cal"))
    if not prior or at is None or cal is None or not at < cal:
        return i
    when = [(_stamp(x.get("cal")), x) for x in prior]
    earlier = [(t, x) for t, x in when if t is not None and t <= at]
    return max(earlier, key=lambda y: y[0])[1] if earlier else prior[-1]


def _inst_key(i):
    return f"{i.get('model')}|{i.get('serial') or ''}"  # static/das.js instKey


def _inst_list(d):
    t = d.get("testing") if isinstance(d.get("testing"), dict) else {}
    return [i for i in t.get("instruments") or [] if isinstance(i, dict)]


def counts(d, r):
    """static/das.js calOf(d, r).ok for a reading that has a value: taken with an instrument on the job, in date when it was taken."""
    if r.get("inst") == "uncal":
        return False
    i = next((x for x in _inst_list(d) if _inst_key(x) == r.get("inst")), None)
    at = _stamp(r.get("time"))
    return bool(i) and inst_state(inst_at(i, at), at)[0]


def _readings(r):
    if not isinstance(r, dict):
        return []
    rs = r["readings"] if isinstance(r.get("readings"), list) else [r]
    return [x for x in rs if isinstance(x, dict) and any(x.get(k) not in (None, "") for k in HAS_VALUE)]


def _test_days(d, since):
    """What a job's grid holds from this retest: the days of its readings from since on, and how many tested squares have none."""
    grid = d.get("grid") if isinstance(d.get("grid"), dict) else {}
    res = grid.get("results") if isinstance(grid.get("results"), dict) else {}
    skip = {f"{f.get('name')}|{g}" for f in d.get("floors") or [] if isinstance(f, dict) for g in f.get("skip") or []}
    days, old = [], 0
    for key, r in res.items():
        rs = _readings(r)
        if not rs or key in skip:
            continue
        new = [w for w in (_when(x.get("time")) for x in rs) if w and w >= since]
        if new:
            days += new
        else:
            old += 1
    return days, old


# ---------------------------------------------------------------- the pass

def _passes(d):
    w = d.get("walk") if isinstance(d.get("walk"), dict) else {}
    return [p for p in w.get("passes") or [] if isinstance(p, dict) and p.get("id") and p.get("kind") in KIND]


def _due(items):
    """Which retest is due, the five-year first: in a fifth year it's the fuller test, and the annual is due the same day."""
    by = {x["key"]: x for x in items or [] if x.get("key") in ("annual", "quant5") and x.get("state") in ("due", "overdue") and x.get("due")}
    return ("five_year", by["quant5"]) if "quant5" in by else ("annual", by["annual"]) if "annual" in by else (None, None)


def _pick(d, kind, item):
    """The pass for this retest: (pass, the day its window opened, opened by itself). One a person already made counts, whatever year they
    typed. With nothing due, the newest retest pass: its report can still go out after its date is set."""
    passes = _passes(d)
    if not item:
        return (passes[-1], None, False) if passes else (None, None, False)
    due = das._day(item["due"])
    opens = due - timedelta(days=das.LIFE_SOON_DAYS)
    base, n = f"{kind}-{due.year}", 2
    for p in reversed(passes):
        made = das._day(p.get("made"))
        if (p["kind"] == kind or kind == "annual") and (made >= opens if made else p["id"] == base):
            return p, opens, False
    want, taken = base, {p["id"] for p in passes}
    while want in taken:  # a test done early in the window can leave this year's name on last time's pass
        want, n = f"{base}-{n}", n + 1
    return {"id": want, "kind": kind, "year": due.year}, opens, True


def _name(p):
    return f"{KIND[p['kind']][0]}{' ' + str(p['year']) if p.get('year') else ''}"


def _points(d, pid):
    w = d.get("walk") if isinstance(d.get("walk"), dict) else {}
    return sum(1 for f in w.get("floors") or [] if isinstance(f, dict) for x in f.get("pts") or [] if isinstance(x, dict) and x.get("pass") == pid)


def _offered(d, pid):
    """The instruments the last test used, and whether each still counts today: the walk stays on them until a person picks another."""
    w = d.get("walk") if isinstance(d.get("walk"), dict) else {}
    used = [x.get("inst") for f in w.get("floors") or [] if isinstance(f, dict) for x in f.get("pts") or [] if isinstance(x, dict) and x.get("pass") != pid]
    grid = d.get("grid") if isinstance(d.get("grid"), dict) else {}
    keys = list(dict.fromkeys(k for k in used + [grid.get("inst")] if k and k != "uncal"))
    out = []
    for k in keys:
        i = next((x for x in _inst_list(d) if _inst_key(x) == k), None)
        if i:
            ok, why = inst_state(i)
            out.append({"name": " ".join(str(x) for x in (i.get("model"), i.get("serial")) if x), "ok": ok, "why": why})
    return out[:4]


# ---------------------------------------------------------------- done: the seal and the report sent

def _sealed(con, jid, since):
    """The newest seal holding readings from this retest: {code, at, result, days, old}, or None. A reprint of the acceptance report has none."""
    das._seal_table(con)
    for r in con.execute("SELECT code, at, result, job_data FROM das_seal WHERE job_id=? AND at>=? ORDER BY at DESC, rowid DESC LIMIT 8", (jid, since.isoformat())).fetchall():
        days, old = _test_days(json.loads(r["job_data"] or "{}"), since)
        if days:
            return {"code": r["code"], "at": r["at"], "result": r["result"] or "", "day": max(days), "old": old}
    return None


def _sent(con, jid, after):
    """The report going to the AHJ: mail tagged [RFR J<job> AHJ] with a PDF, sent after the seal. One tag carries everything to the AHJ, so the
    word report tells it from the design submittal and the Code check question."""
    for r in con.execute("SELECT ts, subject, attachments FROM das_mail WHERE job_id=? AND direction='out' AND tag=? AND ts>=? ORDER BY ts DESC",
                         (jid, f"J{int(jid)} AHJ", after)).fetchall():
        names = [str(a) for a in json.loads(r["attachments"] or "[]")]
        if any(n.lower().endswith(".pdf") for n in names) and re.search(r"report", r["subject"] or "", re.I):
            return {"at": r["ts"], "day": r["ts"][:10]}
    return None


def _no_line(key, day, pid):
    return f"Not taken: {LABEL[key]} {day} for {pid}"


def _said_no(con, jid):
    return {r[0] for r in con.execute("SELECT detail FROM das_log WHERE job_id=? AND kind='retest_no'", (jid,))}


def state(con, job, today=None):
    """Where a job's retest stands, or None when there isn't one to speak of. open: the pass opened by itself and hasn't been saved."""
    d, stage, jid = job.get("data") or {}, job.get("stage"), job.get("id")
    if d.get("example") or stage == "Closed":
        return None
    items = job.get("lifecycle")
    if items is None:
        items = das.lifecycle(d, stage, today)
    kind, item = _due(items)
    p, opens, opened = _pick(d, kind, item)
    if not p:
        return None
    made = das._day(p.get("made"))
    since = min([x for x in (made, opens) if x] or [date(int(p.get("year") or (today or date.today()).year), 1, 1)])
    life = d.get("life") if isinstance(d.get("life"), dict) else {}
    settled = lambda k: (das._day(life.get(k)) or date.min) >= since  # a date a person set wins
    keys = [k for k in KIND[p["kind"]][1] if not settled(k)]
    if not item and not keys and settled("report_filed"):
        return None
    name, seal, sent, held = _name(p), _sealed(con, jid, since), None, ""
    proposals = []
    if seal:
        res = seal["result"].strip().upper()
        day = min(seal["day"], das._day(seal["at"]) or seal["day"]).isoformat()
        if res == "FAIL":
            held = "The sealed report reads FAIL, so no date is proposed. Fix it, test again and seal again."
        elif res != "PASS":
            held = "The sealed report isn't complete, so no date is proposed. Finish the test and seal again."
        elif seal["old"]:
            held = f"{seal['old']} square{'' if seal['old'] == 1 else 's'} in the sealed report still {'holds' if seal['old'] == 1 else 'hold'} a reading from before this test, so no date is proposed. Test {'it' if seal['old'] == 1 else 'them'} and seal again."
        else:
            proposals = [{"key": k, "label": LABEL[k], "date": day, "from": f"sealed report {seal['code']}"} for k in keys]
        sent = _sent(con, jid, seal["at"])
        if sent and not settled("report_filed"):
            proposals.append({"key": "report_filed", "label": LABEL["report_filed"], "date": sent["day"], "from": "the email to the AHJ"})
    if proposals:
        no = _said_no(con, jid)
        proposals = [x for x in proposals if _no_line(x["key"], x["date"], p["id"]) not in no]
    if not item and not proposals and not held:
        return None
    walked = _points(d, p["id"]) or len(_test_days(d, since)[0])  # a walk's points, or a typed test's readings: a walk rolls up into the squares, so never both
    if proposals:
        nxt = {"text": f"{name}: set the date{'' if len(proposals) == 1 else 's'} it proposes", "sub": "overview"}
    elif held:
        nxt = {"text": f"{name}: the sealed report can't set the dates yet", "sub": "report"}
    elif not item:
        nxt = None
    elif seal:
        nxt = {"text": f"Send the {name} report to the AHJ", "sub": "report"} if not sent else None
    elif walked:
        nxt = {"text": f"Finish {name}, then seal its report", "sub": "report"}
    else:
        nxt = {"text": f"Walk the building for {name}", "sub": "grid"}
    return {"id": p["id"], "kind": p["kind"], "year": p.get("year"), "name": name, "open": opened, "due": (item or {}).get("due"), "days": (item or {}).get("days"),
            "state": (item or {}).get("state"), "since": since.isoformat(), "walked": walked, "offered": _offered(d, p["id"]),
            "sealed": {k: seal[k] for k in ("code", "at", "result")} if seal else None, "sent": sent, "held": held, "proposals": proposals, "next": nxt}


def press(con, job, b, today=None):
    """A person's press on a proposed date. {take: key, date?} sets it, and a date they changed is theirs. {no: key} turns it down: it goes in
    the job's log, and that date isn't offered again. Only what's on offer can be pressed, so the acceptance date can't be reached from here."""
    b, d, jid = b or {}, job.get("data") or {}, job["id"]
    st = state(con, job, today) or {}
    key = str(b.get("take") or b.get("no") or "")
    prop = next((x for x in st.get("proposals") or [] if x["key"] == key), None)
    if not prop:
        raise ValueError("That date isn't waiting on this job any more. Reload to see where it stands.")
    if b.get("no"):
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, das.now(), "retest_no", _no_line(key, prop["date"], st["id"])))
        con.commit()
        return das.job_row(con, jid)
    day = das._day(b.get("date") or prop["date"])
    if not day:
        raise ValueError("That isn't a date.")
    if day > (today or date.today()) + timedelta(days=1):
        raise ValueError("That date is in the future.")
    patch = {"life": {**(d.get("life") if isinstance(d.get("life"), dict) else {}), key: day.isoformat()}}
    if key == "annual_last":  # as the Lifecycle panel does: retest_due feeds the board and the owner's reminder (das.js dasLifeWire)
        accepted = das._day(d.get("accepted_on") or (d.get("checks") or {}).get("accepted_on"))
        patch["retest_due"] = das._add_months(max(x for x in (accepted, day) if x), 12).isoformat()
    das.save_job(con, {"data": patch}, jid)
    return das.note(con, jid, f"{st['name']}: {prop['label']} set to {day.isoformat()} by a person's press, proposed from {prop['from']}")
