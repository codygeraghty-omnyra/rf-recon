"""
The firm register (automation idea 1, 11/6): instruments, certificates and credentials kept once and offered to every job.

  rows, save_item   the Equipment and people list (das_firm_item): an instrument with its calibration and certificate, a person with
                    their licences and certificates
  pick              a press on a job: copies a row onto the job's own fields. Everything that reads an instrument or a tester reads those
                    fields, as it always did, so nothing downstream knows the register exists
  fold              calibration and credential reminders, one per instrument or person, however many jobs carry them
  cert_offer        what the drop spot can do with a calibration certificate, on a press (intake.py)

A job's copy is a copy. The register never writes into a job on its own: a report has to keep what was true on its date, and an instrument
added here changes no job. A job's row and a register row are the same instrument when their serial says so, as a reading names an instrument
by what's written on it. There's no id link: a job's file can move to another server, where an id would be someone else's instrument.

A reading is judged by its instrument's calibration (das.js calOf), and it names the instrument by model and serial. So a job that takes a
newer calibration from here keeps the one before it in that row's prior, if it has readings taken with it, and calOf judges each reading
by the calibration in force when it was taken. A pick never rewrites a row's model or serial, and never moves a job back to an older date.

"Firm" means this server's whole team for now: the app has logins with roles, no firm. The list is shared by everyone signed in here.
"""
import datetime
import json
import os
import re
import shutil
import sqlite3

import das
import dashist

INSTRUMENT, PERSON = "instrument", "person"
INSTRUMENT_FIELDS = ("cal", "expires", "note")
PERSON_FIELDS = ("email", "phone", "grol", "nicet", "nicet_expires", "mfr_expires", "b03_expires")
CREDS = ("grol", "nicet", "nicet_expires", "mfr_expires", "b03_expires")  # the job's own keys, in data.testing
DOC_KINDS = {"b03": "B-03 certificate", "operator_cert": "Operator certificate"}  # intake.py KINDS: the AHJ's packet list counts them in Files by kind
FILE_TYPES = ("pdf", "jpeg", "png", "webp", "gif", "heic")
FOLDS = ("cal", "cert")  # the lifecycle items that fold


def _key(s):
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def _words(s):
    return {w for w in re.split(r"[^a-z0-9]+", _key(s)) if len(w) >= 3}


def same_instrument(model_a, serial_a, model_b, serial_b):
    """A serial decides, whatever the model was typed as. A short serial ("9") needs a word of the model to agree as well."""
    a, b = _key(serial_a), _key(serial_b)
    if a or b:
        return a == b and (len(a) >= 5 or bool(_words(model_a) & _words(model_b)))
    return _key(model_a) == _key(model_b)


def _item(r):
    return {**json.loads(r["data"] or "{}"), "id": r["id"], "kind": r["kind"], "name": r["name"], "serial": r["serial"], "by": r["by"], "updated_at": r["updated_at"]}


def rows(con, kind=None):
    try:
        got = con.execute("SELECT * FROM das_firm_item ORDER BY name COLLATE NOCASE, serial COLLATE NOCASE").fetchall()
    except sqlite3.Error:  # a test's bare database
        return []
    return [_item(r) for r in got if not kind or r["kind"] == kind]


def get(con, iid):
    try:
        r = con.execute("SELECT * FROM das_firm_item WHERE id=?", (int(iid),)).fetchone()
    except (TypeError, ValueError):
        r = None
    if not r:
        raise LookupError("That's no longer on the list. Reload to see the current one.")
    return _item(r)


def find_instrument(items, model="", serial=""):
    return next((x for x in items if same_instrument(model, serial, x["name"], x["serial"])), None)


def find_person(items, name):
    return next((x for x in items if _key(name) and _key(x["name"]) == _key(name)), None)


def _date(v, word):
    t = str(v or "").strip()[:10]
    if t and not das._day(t):
        raise ValueError(f"{word} isn't a date.")
    return t


def save_item(con, b, who=None):
    """Add a row, or change one (id given). Sent fields replace, the rest stay. The same instrument or person twice is refused: the list keeps each one once."""
    b = b or {}
    old = get(con, b["id"]) if b.get("id") else {}
    kind = old.get("kind") or b.get("kind")
    if kind not in (INSTRUMENT, PERSON):
        raise ValueError("Is it an instrument or a person?")
    name = str(b.get("name", old.get("name")) or "").strip()[:160]
    serial = str(b.get("serial", old.get("serial")) or "").strip()[:80] if kind == INSTRUMENT else ""
    if not name:
        raise ValueError("Give it a name first." if kind == PERSON else "Give the model first.")
    d = {k: v for k, v in old.items() if k not in ("id", "kind", "name", "serial", "by", "updated_at")}
    for k in INSTRUMENT_FIELDS if kind == INSTRUMENT else PERSON_FIELDS:
        if k in b:
            d[k] = _date(b[k], {"cal": "Calibrated", "expires": "Runs out"}.get(k, "That")) if k in ("cal", "expires") or k.endswith("_expires") else str(b[k] or "").strip()[:300]
    if kind == INSTRUMENT and d.get("cal") and d.get("expires") and d["expires"] < d["cal"]:
        raise ValueError("It can't run out before it was calibrated.")
    if d.get("email") and not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,24}", d["email"]):
        raise ValueError("That isn't an email address.")
    for x in rows(con, kind):
        if x["id"] != old.get("id") and (same_instrument(name, serial, x["name"], x["serial"]) if kind == INSTRUMENT else _key(name) == _key(x["name"])):
            raise ValueError(f"{x['name']}{' ' + x['serial'] if x['serial'] else ''} is already on the list.")
    t, by = das.now(), who or dashist.who_now()
    if old:
        con.execute("UPDATE das_firm_item SET name=?, serial=?, data=?, by=?, updated_at=? WHERE id=?", (name, serial, json.dumps(d), by, t, old["id"]))
        iid = old["id"]
    else:
        iid = con.execute("INSERT INTO das_firm_item(kind, name, serial, data, by, created_at, updated_at) VALUES(?,?,?,?,?,?,?)", (kind, name, serial, json.dumps(d), by, t, t)).lastrowid
    con.commit()
    return get(con, iid)


def delete_item(con, iid):
    """Off the list. Jobs that used it keep their copies, and its files stay on disk."""
    it = get(con, iid)
    con.execute("DELETE FROM das_firm_item WHERE id=?", (it["id"],))
    con.commit()
    return {"ok": True}


# ---------------------------------------------------------------- files
def file_dir(iid, create=True):
    d = os.path.join(das.DAS_DIR, "_firm", f"{int(iid):05d}")
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def file_path(iid, name):
    d = file_dir(iid, create=False)
    p = os.path.realpath(os.path.join(d, das.safe_name(os.path.basename(name or ""))))
    if not p.startswith(os.path.realpath(d) + os.sep):
        raise ValueError("Bad file name.")
    return p


def _free(iid, name):
    d, stem = file_dir(iid), das.safe_name(name)
    base, ext = os.path.splitext(stem)
    n, p = 1, os.path.join(d, stem)
    while os.path.exists(p):
        n += 1
        p = os.path.join(d, f"{base} ({n}){ext}")
    return p


def _check_file(name, head, size):
    import intake
    if size > das.SPEC_MAX:
        raise ValueError("That file is over 30 MB.")
    if intake.sniff(head) not in FILE_TYPES or not intake._safe_to_serve(name):
        raise ValueError("A certificate has to be a PDF or a picture.")


def _attach(con, it, saved, doc, who):
    d = {}
    if it["kind"] == INSTRUMENT:
        d["cert"] = saved
    else:
        d["docs"] = [*(it.get("docs") or []), {"file": saved, "kind": doc if doc in DOC_KINDS else "operator_cert"}]
    _merge(con, it, d, who)


def _merge(con, it, put, who=None):
    keep = {k: v for k, v in it.items() if k not in ("id", "kind", "name", "serial", "by", "updated_at")}
    con.execute("UPDATE das_firm_item SET data=?, by=?, updated_at=? WHERE id=?", (json.dumps({**keep, **put}), who or dashist.who_now(), das.now(), it["id"]))
    con.commit()


def save_upload(con, iid, name, data, doc="", who=None):
    """A certificate for a row. It's kept with the row, and copied to a job's Files when the row is picked there."""
    it = get(con, iid)
    _check_file(name, data[:4096], len(data))
    p = _free(it["id"], name)
    with open(p + ".part", "wb") as fh:
        fh.write(data)
    os.replace(p + ".part", p)
    _attach(con, it, os.path.basename(p), doc, who)
    return get(con, iid)


def _copy_in(con, job, it, fname, kind):
    """A row's certificate into the job's Files, once: the same bytes already there aren't saved twice. -> the name on the job, or ""."""
    import intake
    if not fname:
        return ""
    src = file_path(it["id"], fname)
    if not os.path.isfile(src):
        return ""
    jid, sha = job["id"], intake._sha_of(src)
    saved = intake.on_job(con, jid, job["name"], sha, os.path.getsize(src)) or das.save_path(jid, job["name"], fname, src)
    con.execute("INSERT OR REPLACE INTO das_file(job_id, name, sha256, kind, source, intake_id, at) VALUES(?,?,?,?,?,?,?)", (jid, saved, sha, kind, "register", None, das.now()))
    con.commit()
    return saved


# ---------------------------------------------------------------- onto a job
def _has_readings(d, key):
    """Any reading on the job taken with this instrument. Grid results, walk passes and baselines all name it the same way; grid.inst is
    only what's picked for the next reading."""
    g = dict(d.get("grid") or {})
    g.pop("inst", None)
    return f'"inst": {json.dumps(key)}' in json.dumps({**d, "grid": g})


def _pick_instrument(con, job, it, who):
    d = job["data"] or {}
    T = dict(d.get("testing") or {})
    insts = [dict(i) if isinstance(i, dict) else i for i in T.get("instruments") or []]
    name = " ".join(x for x in (it["name"], it["serial"]) if x)
    row = next((i for i in insts if isinstance(i, dict) and same_instrument(i.get("model"), i.get("serial"), it["name"], it["serial"])), None)
    if row is None:
        cert = _copy_in(con, job, it, it.get("cert"), "cal_cert")
        row = {"model": it["name"], "serial": it["serial"], "cal": it.get("cal") or "", **({"expires": it["expires"]} if it.get("expires") else {}), **({"cert": cert} if cert else {})}
        insts.append(row)
        say = f"{name} is on this job."
    else:
        have, new = das._day(row.get("cal")), das._day(it.get("cal"))
        if new and have and new < have:
            say = f"{name} was already on this job, with a newer calibration than the list. The job keeps its own."
        elif new and new != have:
            if _has_readings(d, f"{row.get('model')}|{row.get('serial') or ''}"):
                row["prior"] = [*(row.get("prior") or []), {k: row.get(k) or "" for k in ("cal", "expires", "cert")}]
                say = f"{name} now shows the calibration of {it['cal']}. Readings already taken keep the calibration they were taken under."
            else:
                say = f"{name} now shows the calibration of {it['cal']}."
            row.update(cal=it["cal"], expires=it.get("expires") or "")
            row.pop("cert", None)
            cert = _copy_in(con, job, it, it.get("cert"), "cal_cert")
            if cert:
                row["cert"] = cert
        else:  # the same calibration: only what the job has blank
            say = f"{name} was already on this job."
            if it.get("expires") and not row.get("expires"):
                row["expires"] = it["expires"]
            if it.get("cert") and not row.get("cert"):
                cert = _copy_in(con, job, it, it["cert"], "cal_cert")
                if cert:
                    row["cert"] = cert
    T["instruments"] = insts
    return T, say, f"{row.get('model')}|{row.get('serial') or ''}"


def _pick_person(con, job, it, who):
    T = dict((job["data"] or {}).get("testing") or {})
    same = _key(T.get("tester")) == _key(it["name"])
    for k in CREDS:
        v = it.get(k) or ""
        if not same:
            T[k] = v  # another person: the last tester's numbers can't stay under this name
        elif k.endswith("_expires"):
            T[k] = max(T.get(k) or "", v)
        elif v and not T.get(k):
            T[k] = v
    T["tester"] = T.get("tester") if same else it["name"]
    for doc in it.get("docs") or []:
        _copy_in(con, job, it, doc.get("file"), doc.get("kind") or "operator_cert")
    return T, f"{it['name']} is the tester on this job.", ""


def pick(con, job, body, who=None):
    """A press: this row, onto this job's own fields. inst: the instrument's key on the job, as a reading names it."""
    it = get(con, (body or {}).get("id"))
    T, say, key = (_pick_instrument if it["kind"] == INSTRUMENT else _pick_person)(con, job, it, who)
    saved = das.save_job(con, {"data": {"testing": T}, "rev": job["rev"]}, job["id"], who=who, note_=f"From the register: {it['name']}")
    return {"job": saved, "say": say, "inst": key}


# ---------------------------------------------------------------- the list
def listing(con, vis=None, brief=False):
    """The Equipment and people screen. Which jobs carry a row, and what jobs carry that isn't on the list yet, only from jobs this login can open.
    brief: the rows alone, for a job's picker."""
    insts, people = rows(con, INSTRUMENT), rows(con, PERSON)
    out = {"instruments": insts, "people": people}
    if brief:
        return out
    for x in insts + people:
        x["jobs"] = []
    seen_i, seen_p = {}, {}
    for r in con.execute("SELECT id, name, stage, data FROM das_job ORDER BY id").fetchall():
        d = json.loads(r["data"] or "{}")
        if d.get("example") or (vis is not None and r["id"] not in vis):
            continue
        T = d.get("testing") or {}
        for i in T.get("instruments") or []:
            if not isinstance(i, dict) or not i.get("model"):
                continue
            hit = find_instrument(insts, i.get("model"), i.get("serial"))
            if hit:
                hit["jobs"].append({"id": r["id"], "name": r["name"], "stage": r["stage"], "old": (i.get("cal") or "") < (hit.get("cal") or "")})
                continue
            s = seen_i.setdefault(_ident(i.get("model"), i.get("serial"), ""), {"model": i["model"], "serial": i.get("serial") or "", "cal": "", "expires": "", "jobs": 0})
            s["jobs"] += 1
            if (i.get("cal") or "") >= s["cal"]:
                s.update(cal=i.get("cal") or "", expires=i.get("expires") or "")
        who = str(T.get("tester") or "").strip()
        if who:
            hit = find_person(people, who)
            if hit:
                hit["jobs"].append({"id": r["id"], "name": r["name"], "stage": r["stage"], "old": False})
                continue
            s = seen_p.setdefault(_key(who), {"name": who, "jobs": 0})
            s["jobs"] += 1
            s.update({k: T[k] for k in CREDS if T.get(k)})
    out["seen"] = {"instruments": list(seen_i.values()), "people": list(seen_p.values())}
    return out


# ---------------------------------------------------------------- one reminder per instrument or person
def _ident(model, serial, due):
    """Who a reminder is about, with no register row to say. A serial, or a model and its date: two units of one model with no serial
    may be two instruments, so they fold only if their dates agree."""
    s = _key(serial)
    if s:
        return f"s:{s}" if len(s) >= 5 else f"s:{s}|{_key(model)}"
    return f"m:{_key(model)}|{due}"


def _state(days):
    return "overdue" if days < 0 else "due" if days <= das.LIFE_SOON_DAYS else "ok"


def _cal_due(x, reg):
    """When this job's instrument really runs out: the register's date when it holds this calibration or a later one."""
    if reg:
        c, done = das._day(reg.get("cal")), das._day(x.get("done"))
        if c and (not done or c >= done):
            e = das._day(reg.get("expires"))
            if e:
                return e, c
            if not done or c > done:
                return das._add_months(c, x.get("cal_months") or das.CAL_MONTHS), c
    return das._day(x["due"]), None


def fold(con, lines, today=None):
    """lines: [(job, lifecycle item)], items in FOLDS. -> one group per instrument or person: {ident, reg, lines, item}, item a lifecycle item
    carrying the soonest date any of its jobs has to meet. Jobs on different dates stay one reminder, on the soonest: an AHJ's shorter calibration
    months make that job's date the real one. The register's newer date beats a job's old copy."""
    today = today or datetime.date.today()
    insts, people, groups = rows(con, INSTRUMENT), rows(con, PERSON), {}
    for j, x in lines:
        cal_on = None
        if x["key"] == "cal":
            reg = find_instrument(insts, x.get("model"), x.get("serial"))
            ident = f"i{reg['id']}" if reg else _ident(x.get("model"), x.get("serial"), x["due"])
            due, cal_on = _cal_due(x, reg)
        else:
            k, who = x.get("cert_key"), x.get("tester") or ""
            reg = find_person(people, who)
            ident = f"p{reg['id']}:{k}" if reg else f"t:{_key(who)}:{k}" if _key(who) else f"j{j['id']}:{k}"
            e = das._day((reg or {}).get(f"{k}_expires"))
            due = max(e, das._day(x["due"])) if e else das._day(x["due"])
        g = groups.setdefault(ident, {"ident": ident, "reg": reg, "lines": []})
        g["lines"].append((j, x, due, cal_on))
    out = []
    for g in groups.values():
        g["lines"].sort(key=lambda t: (t[2], t[0]["id"]))
        j, x, due, cal_on = g["lines"][0]
        days = (due - today).days
        item = {**x, "due": due.isoformat(), "days": days, "state": _state(days)}
        if cal_on:
            item.update(done=cal_on.isoformat(), note=f"calibrated {cal_on.isoformat()}")
        out.append({"ident": g["ident"], "reg": g["reg"], "item": item, "jobs": [t[0] for t in sorted(g["lines"], key=lambda t: t[0]["id"])], "lines": g["lines"]})
    return out


def _unused(con, used, today):
    """Rows on no open job: their own date, so an instrument between jobs still gets its reminder, on the board. Its email has no job to file under."""
    out = []
    for it in rows(con):
        if it["kind"] == INSTRUMENT:
            if it["id"] in used:
                continue
            c = das._day(it.get("cal"))
            if not c:
                continue
            nm = " ".join(x for x in (it["name"], f"(serial {it['serial']})" if it["serial"] else "") if x)
            due = das._day(it.get("expires")) or das._add_months(c, das.CAL_MONTHS)
            days, src = (due - today).days, das.LIFE_SOURCES["cal"]
            out.append({"reg": it, "item": {"key": "cal", "id": f"firm:{it['id']}", "label": f"Calibration runs out: {nm}", "due": due.isoformat(), "days": days, "state": _state(days),
                                            "source": src[0], "url": src[1], "note": f"calibrated {c.isoformat()}"}})
        else:
            for k, lbl in das.LIFE_CERTS:
                e = das._day(it.get(f"{k}_expires"))
                if e and f"{it['id']}:{k}" not in used:
                    days, src = (e - today).days, das.LIFE_SOURCES[k]
                    out.append({"reg": it, "item": {"key": "cert", "id": f"firm:{it['id']}:{k}", "label": f"{lbl} expires: {it['name']}", "due": e.isoformat(), "days": days, "state": _state(days),
                                                    "source": src[0], "url": src[1], "note": ""}})
    return out


def board(con, jobs, today=None):
    """The board's Needs you, for the jobs this login can see (das.list_jobs rows): one line per instrument or person, soonest first in the page's own order."""
    today = today or datetime.date.today()
    lines = [(j, x) for j in jobs if j.get("stage") != "Closed" for x in j.get("lifecycle") or [] if x.get("key") in FOLDS and x.get("due")]
    groups, out, used = fold(con, lines, today), [], set()
    for g in groups:
        reg = g["reg"]
        if reg:
            used.add(reg["id"] if reg["kind"] == INSTRUMENT else f"{reg['id']}:{g['item'].get('cert_key')}")
        if g["item"]["state"] != "ok":
            out.append({"item": g["item"], "jobs": [{"id": j["id"], "name": j["name"], "stage": j["stage"]} for j in g["jobs"]], "firm_id": reg["id"] if reg else None})
    out += [{"item": u["item"], "jobs": [], "firm_id": u["reg"]["id"]} for u in _unused(con, used, today) if u["item"]["state"] != "ok"]
    return out


# ---------------------------------------------------------------- the drop spot
def _rank(cal, due):
    return (cal or "", due or "")


def cert_offer(con, it):
    """What Intake can offer for a calibration certificate, or None. Nothing happens until a person presses it."""
    f = it["facts"]
    if it["kind"] != "cal_cert" or not f.get("serial") or it["status"] in ("refused", "reading", "unpacked", "dropped"):
        return None
    if f.get("registered"):
        return {"state": "done", "serial": f["serial"]}
    reg = next((x for x in rows(con, INSTRUMENT) if _key(x["serial"]) == _key(f["serial"])), None)
    base = {"serial": f["serial"], "cal": f.get("cal") or "", "due": f.get("due") or "", "model": f.get("model") or ""}
    if not reg:
        return {**base, "state": "new"}
    base["match"] = {"id": reg["id"], "name": reg["name"], "cal": reg.get("cal") or "", "expires": reg.get("expires") or ""}
    a, b = _rank(f.get("cal"), f.get("due")), _rank(reg.get("cal"), reg.get("expires"))
    if not a[0] and not a[1]:
        return None  # no date on it: nothing to say about this instrument
    return {**base, "state": "newer" if a > b else "same" if a == b else "older"}


def from_cert(con, it, src, model="", who=None):
    """A press in Intake: what the certificate says, onto the register. Dates only go forward. src: the file, wherever it is now. -> an undo step."""
    f = it["facts"]
    offer = cert_offer(con, it)
    if not offer or offer["state"] in ("done", "same", "older"):
        raise ValueError("There's nothing to update from this certificate.")
    if offer["state"] == "new":
        name = str(model or f.get("model") or "").strip()
        if not name:
            raise ValueError("Say what the instrument is first.")
        reg = save_item(con, {"kind": INSTRUMENT, "name": name, "serial": f["serial"], "cal": f.get("cal") or "", "expires": f.get("due") or ""}, who)
        before = None
    else:
        reg = get(con, offer["match"]["id"])
        before = {k: reg.get(k) or "" for k in ("cal", "expires", "cert")}
        reg = save_item(con, {"id": reg["id"], "cal": f.get("cal") or reg.get("cal") or "", "expires": f.get("due") or ""}, who)
    if src and os.path.isfile(src) and it["size"] <= das.SPEC_MAX:
        import intake
        if intake._safe_to_serve(it["name"]):
            p = _free(reg["id"], it["name"])
            shutil.copyfile(src, p)
            _attach(con, reg, os.path.basename(p), "", who)
            reg = get(con, reg["id"])
    return {"op": "firm", "id": reg["id"], "before": before, "stamp": reg["updated_at"]}


def undo_cert(con, op):
    """That press taken back, unless someone has changed the row since. -> what to tell them, or None."""
    r = con.execute("SELECT * FROM das_firm_item WHERE id=?", (op["id"],)).fetchone()
    if not r:
        return None
    it = _item(r)
    if r["updated_at"] != op["stamp"]:
        return f"{it['name']} was changed on the register since, so it stays"
    if op["before"] is None:
        con.execute("DELETE FROM das_firm_item WHERE id=?", (op["id"],))
    else:
        keep = {k: v for k, v in it.items() if k not in ("id", "kind", "name", "serial", "by", "updated_at")}
        con.execute("UPDATE das_firm_item SET data=?, updated_at=? WHERE id=?", (json.dumps({**keep, **op["before"]}), das.now(), op["id"]))
    con.commit()
    return None


def route(con, method, p, qs, body, raw, vis, who):
    """/api/das/register. (status, answer). The file download is app.py's: it needs its headers."""
    arg = lambda k: (qs.get(k) or [""])[0]  # noqa: E731
    if p == "/api/das/register":
        return 200, listing(con, vis, arg("brief") == "1") if method == "GET" else save_item(con, body(), who)
    m = re.match(r"^/api/das/register/(\d+)/(delete|file)$", p)
    if m and method == "POST":
        if m.group(2) == "delete":
            return 200, delete_item(con, int(m.group(1)))
        return 200, save_upload(con, int(m.group(1)), arg("name"), raw(), arg("doc"), who)
    raise LookupError("No such page.")
