"""
Ready to send (Cody 11/4, "Ready-to-send queue"): emails RF Recon writes on its own and lines up for one click each:
follow-ups when a tagged email got no reply, retest reminders to the owner, plans requests for jobs with no plans,
and first emails to prospects queued from the Prospects list. Nothing leaves without the person's click (Send, or
Send all for a batch). Also the written emails for a job (status to the customer, access to the GC, scope to a
subcontractor, the design to the AHJ, the retest reminder, the plans request), for "Email about this job".
Items are worked out from the record each time, so they clear themselves once sent; a person can put one off
(snooze) or drop it (dismiss).
"""
import datetime
import json
import re

import das
import dasmail

FOLLOW_DAYS = 5          # no reply this many days after the last email on a tag: a follow-up
FOLLOW_MAX = 1           # follow-ups per conversation (prospects: CAN-SPAM-polite, one)
RETEST_DAYS = 30         # the annual retest reminder, this many days before it's due (and when overdue)
PROSPECT_BATCH = 50      # first emails queued from the Prospects list at one go
SEND_PER_HOUR = 150      # Gmail and Workspace limit a mailbox to about 2,000 a day: RF Recon keeps well under

SCHEMA = """
CREATE TABLE IF NOT EXISTS das_mail_queue(login TEXT, key TEXT, state TEXT, until TEXT, data TEXT, ts TEXT,
    PRIMARY KEY(login, key));
"""
TOPIC_ASK = {
    "Q": "Could you send your prices (or fill in the quote sheet and send it back) when you can?",
    "PLANS": "Could you send the floor plans when you have a moment? A reply with the PDFs attached is all we need.",
    "CONSENT": "Could you let us know whether you consent, or what you need from us to decide?",
    "AHJ": "Is there anything you need from us for the review?",
    "MAIL": "Just checking this reached you.",
    "P": "Would a short call be useful? If not, reply \"no thanks\" and we won't write again.",
}
TEMPLATES = [  # (id, label, who it goes to, in order)
    ("blank", "Write it yourself", ("owner", "gc", "ahj")),
    ("status", "Status update to the customer", ("owner",)),
    ("gc_access", "Access and schedule (general contractor)", ("gc",)),
    ("sub_scope", "Scope and price (subcontractor)", ("sub",)),
    ("ahj_design", "The design to the AHJ for review", ("ahj",)),
    ("plans", "Ask for the floor plans", ("owner", "gc")),
    ("retest", "Book the annual retest (owner)", ("owner",)),
]


def ensure(con):
    con.executescript(SCHEMA)


def _now():
    return datetime.datetime.now()


def _days_since(ts, now=None):
    try:
        return ((now or _now()) - datetime.datetime.fromisoformat(str(ts)[:19])).days
    except ValueError:
        return 0


def _strip_tag(s):
    return re.sub(r"\s*\[RFR [^\]]*\]", "", s or "").strip()


def _first(name):
    n = (name or "").strip()
    return n.split()[0] if n and "@" not in n else ""


def _sig(job_data, contacts, firm, acct_name=""):
    """Who signs: the job's technician, else the firm's contact, else the mailbox's name."""
    tech = contacts.get(str(((job_data or {}).get("contacts") or {}).get("tech")))
    if tech and tech.get("name"):
        return "\n".join(x for x in (tech.get("name"), tech.get("org") or firm.get("name"), tech.get("phone")) if x)
    return "\n".join(x for x in (firm.get("contact") or acct_name, firm.get("name"), firm.get("phone")) if x)


def _person(job_data, contacts, roles):
    for r in roles:
        c = contacts.get(str(((job_data or {}).get("contacts") or {}).get(r)))
        if c and c.get("email"):
            return c, r
    return None, None


def template(con, job_id, tid, firm=None, acct_name=""):
    """A written email for a job: {to, to_name, role, subject, body, topic}. Blank is subject + greeting + signature."""
    firm = firm or {}
    j = das.job_row(con, int(job_id))
    if not j:
        raise LookupError("No such job.")
    t = next((x for x in TEMPLATES if x[0] == tid), None)
    if not t:
        raise ValueError("No such kind of email.")
    d, contacts = j["data"] or {}, {str(c["id"]): c for c in das.list_contacts(con)}
    c, role = _person(d, contacts, t[2])
    where = f"{j['name']}{', ' + d['address'] if d.get('address') else ''}"
    hello = f"Hello{(' ' + _first(c.get('name'))) if c and _first(c.get('name')) else ''},"
    sig = _sig(d, contacts, firm, acct_name)
    floors = len(d.get("floors") or [])
    topic, subject = "MAIL", where
    if tid == "blank":
        body = f"{hello}\n\n\n\n{sig}"
    elif tid == "status":
        nxt = f" Next: {d['next_step']}{' (by ' + d['due'] + ')' if d.get('due') else ''}." if d.get("next_step") else ""
        subject = f"Update: emergency radio coverage at {where}"
        body = (f"{hello}\n\nAn update on the emergency responder radio coverage (ERCES) at {where}: the job is at the "
                f"{j['stage']} stage.{nxt}\n\nIf there's anything you need from us, reply to this email.\n\nThank you,\n{sig}")
    elif tid == "gc_access":
        subject = f"Access and schedule for the ERCES work at {where}"
        body = (f"{hello}\n\nWe're scheduling the emergency responder radio coverage (ERCES) work at {where}. Could you confirm:\n"
                "- site access times, and who lets us in\n- when ceilings close on each floor (cable goes in before)\n"
                "- a place to store materials\n- roof access for the donor antenna\n"
                "- the electrician for the dedicated circuit in the equipment room\n\n"
                f"A reply with dates is all we need.\n\nThank you,\n{sig}")
    elif tid == "sub_scope":
        subject = f"Price request: ERCES cable and antenna installation at {where}"
        body = (f"{hello}\n\nWe'd like your price to install the emergency responder radio coverage (ERCES) cabling and antennas "
                f"at {where}{f' ({floors} floors)' if floors else ''}: coax and fiber pulls per the design, plenum-rated where "
                "required, labelled at both ends, antennas and splitters mounted, installed to NFPA 1225 and NEC 820.\n\n"
                f"Could you reply with your price, crew size and earliest start{' (we need it done by ' + d['due'] + ')' if d.get('due') else ''}?"
                f" The design files can follow.\n\nThank you,\n{sig}")
    elif tid == "ahj_design":
        topic, subject = "AHJ", f"ERCES design for review: {where}"
        body = (f"{hello}\n\nAttached is the emergency responder radio coverage (ERCES) design for {where} for your review: the "
                "link budget, system diagram, materials and their spec sheets. Please let us know of anything you need before "
                f"approval and the permit.\n\nThank you,\n{sig}")
    elif tid == "plans":
        topic, subject = "PLANS", f"Floor plans for {where}"
        body = (f"{hello}\n\nWe're designing the emergency responder radio coverage (ERCES) for {where}. Could you send the floor "
                "plans for every floor, as PDFs (architectural plans with walls, ideally the CAD-exported PDFs rather than scans), "
                f"and the roof plan if there is one?\n\nA reply to this email with the files attached is all we need.\n\nThank you,\n{sig}")
    elif tid == "retest":
        due = d.get("retest_due") or "soon"
        subject = f"Annual emergency radio coverage retest due {due}: {j['name']}"
        body = (f"{hello}\n\nThe emergency responder radio coverage system at {where} is due its annual test on {due}, which "
                f"{d.get('ahj') or 'the fire code official'} requires (IFC 510.6 / NFPA 1225).\n\nCould you reply with a few dates "
                "that work for access to every floor, the roof and the equipment room? The test takes about a day for most "
                f"buildings, and you'll receive the report for the fire marshal afterwards.\n\nThank you,\n{sig}")
    return {"to": (c or {}).get("email") or "", "to_name": (c or {}).get("name") or "", "role": role, "subject": subject,
            "body": body, "topic": topic, "job_id": j["id"]}


def _state(con, login):
    ensure(con)
    return {r["key"]: dict(r) for r in con.execute("SELECT * FROM das_mail_queue WHERE login=?", (login,))}


def _live(st, key, now):
    s = st.get(key)
    if not s:
        return True
    if s["state"] == "dismissed":
        return False
    if s["state"] == "snoozed":
        return not s["until"] or s["until"] <= now.isoformat()[:10]
    return True


def items(con, login, firm=None, acct_name="", now=None):
    """Everything ready to send for this login, newest reason first: [{key, group, why, kind, refs, to, to_name,
    subject, body, in_reply_to, blocked}]."""
    firm, now = firm or {}, now or _now()
    st, out = _state(con, login), []
    contacts = {str(c["id"]): c for c in das.list_contacts(con)}
    jobs = {j["id"]: j for j in (das.job_row(con, r["id"]) for r in con.execute("SELECT id FROM das_job"))}

    # 1. follow-ups: the last email on a tag got no reply in FOLLOW_DAYS
    rows = con.execute("SELECT * FROM das_mail WHERE login=? ORDER BY id", (login,)).fetchall()
    by_tag = {}
    for r in rows:
        by_tag.setdefault(r["tag"], []).append(dict(r))
    for tag, ms in by_tag.items():
        outs = [m for m in ms if m["direction"] == "out"]
        if not outs or any(m["direction"] == "in" for m in ms if m["id"] > outs[0]["id"]):
            continue
        last = outs[-1]
        if len(outs) > FOLLOW_MAX or _days_since(last["ts"], now) < FOLLOW_DAYS:
            continue
        p = dasmail.parse_tag(tag) or {}
        if p.get("kind") == "prospect":
            s = con.execute("SELECT status FROM das_prospect WHERE id=?", (last["prospect_id"],)).fetchone()
            if s and s["status"] in ("do not contact", "replied", "not interested", "won", "meeting"):
                continue
        key = f"follow:{tag}:{last['id']}"
        if not _live(st, key, now):
            continue
        topic = "Q" if p.get("kind") == "rfq" else "P" if p.get("kind") == "prospect" else (p.get("topic") or "MAIL")
        j = jobs.get(last["job_id"]) if last["job_id"] else None
        name = next((c["name"] for c in contacts.values() if (c.get("email") or "").lower() == last["counterpart"]), "")
        sig = _sig((j or {}).get("data"), contacts, firm, acct_name)
        body = (f"Hello{(' ' + _first(name)) if _first(name) else ''},\n\nFollowing up on my email of {str(last['ts'])[:10]} about "
                f"\"{_strip_tag(last['subject'])}\". {TOPIC_ASK.get(topic, TOPIC_ASK['MAIL'])}\n\nThank you,\n{sig}")
        if topic == "P" and firm.get("address"):
            body += f"\n{firm['address']}"
        kind = "rfq" if p.get("kind") == "rfq" else "prospect" if p.get("kind") == "prospect" else "job"
        refs = ({"rfq_id": last["rfq_id"], "supplier": last["supplier"]} if kind == "rfq"
                else {"prospect_id": last["prospect_id"]} if kind == "prospect"
                else {"job_id": last["job_id"], "topic": p.get("topic") or "MAIL", "extra": p.get("extra") or ""})
        out.append({"key": key, "group": "Follow-ups", "kind": kind, "refs": refs, "to": last["counterpart"], "to_name": name,
                    "why": f"No reply to \"{_strip_tag(last['subject'])}\" since {str(last['ts'])[:10]} ({_days_since(last['ts'], now)} days)",
                    "subject": "Re: " + _strip_tag(last["subject"]), "body": body, "in_reply_to": last["message_id"],
                    "job_id": last["job_id"], "blocked": "" if topic != "P" or firm.get("address") else
                    "Add your firm's mailing address (Prospects › Firm details): US law (CAN-SPAM) requires it."})

    sent_topics = {}
    for r in rows:
        if r["direction"] == "out" and r["job_id"]:
            sent_topics.setdefault(r["job_id"], []).append(r)
    for jid, j in jobs.items():
        d = j["data"] or {}
        # 2. the annual retest: RETEST_DAYS before it's due, and when overdue; not if one was asked in the last 45 days
        due = d.get("retest_due")
        if due:
            try:
                left = (datetime.date.fromisoformat(str(due)[:10]) - now.date()).days
            except ValueError:
                left = None
            asked = any("retest" in (r["subject"] or "").lower() and _days_since(r["ts"], now) < 45 for r in sent_topics.get(jid, []))
            key = f"retest:{jid}:{due}"
            if left is not None and left <= RETEST_DAYS and not asked and _live(st, key, now):
                t = template(con, jid, "retest", firm, acct_name)
                out.append({"key": key, "group": "Retest reminders", "kind": "job", "refs": {"job_id": jid, "topic": "MAIL"},
                            "to": t["to"], "to_name": t["to_name"], "subject": t["subject"], "body": t["body"], "job_id": jid,
                            "why": f"{j['name']}: the annual test is {'overdue since' if left < 0 else 'due'} {due}"
                                   + ("" if left < 0 else f" (in {left} days)"),
                            "blocked": "" if t["to"] else "No building owner with an email on this job (Overview › People)."})
        # 3. plans: an early job with no floor plans and no plans request yet
        has_plan = any((f or {}).get("plan") for f in (d.get("floors") or []))
        asked_plans = any((r["tag"] or "").endswith(" PLANS") for r in sent_topics.get(jid, []))
        key = f"plans:{jid}"
        if j["stage"] in ("Lead", "Pre-survey", "Design") and not has_plan and not asked_plans and _live(st, key, now):
            t = template(con, jid, "plans", firm, acct_name)
            out.append({"key": key, "group": "Plans requests", "kind": "job", "refs": {"job_id": jid, "topic": "PLANS"},
                        "to": t["to"], "to_name": t["to_name"], "subject": t["subject"], "body": t["body"], "job_id": jid,
                        "why": f"{j['name']} ({j['stage']}) has no floor plans yet",
                        "blocked": "" if t["to"] else "No owner or general contractor with an email on this job (Overview › People)."})

    # 4. first emails to prospects queued from the Prospects list
    for key, s in st.items():
        if not key.startswith("prospect:") or s["state"] not in ("planned",) and not (s["state"] == "snoozed" and _live(st, key, now)):
            continue
        pid = key.split(":", 1)[1]
        row = json.loads(s["data"] or "{}")
        pr = con.execute("SELECT status, email FROM das_prospect WHERE id=?", (pid,)).fetchone()
        if pr and (pr["status"] or "new") != "new":
            continue  # written to, replied or asked not to be contacted: it leaves the queue
        email = (pr["email"] if pr and pr["email"] else row.get("email")) or ""
        e = das.prospect_email({**row, "email": email}, firm)
        out.append({"key": key, "group": "Prospects", "kind": "prospect", "refs": {"prospect_id": pid}, "to": email,
                    "to_name": row.get("contact_name") or "", "subject": e["subject"], "body": e["body"], "job_id": None,
                    "why": f"{row.get('name') or pid}: queued from Prospects{(' (' + row['kind_label'] + ')') if row.get('kind_label') else ''}",
                    "blocked": "Add your firm's mailing address (Prospects › Firm details): US law (CAN-SPAM) requires it." if not firm.get("address")
                    else "" if email else "No email for this building: Find email, or call."})
    order = {"Follow-ups": 0, "Retest reminders": 1, "Plans requests": 2, "Prospects": 3}
    out.sort(key=lambda x: (order.get(x["group"], 9), x["why"]))
    return out


def queue_prospects(con, login, rows):
    """First emails for these prospects (rows from the Prospects list), at most PROSPECT_BATCH at a go."""
    ensure(con)
    n = 0
    for r in (rows or [])[:PROSPECT_BATCH]:
        pid = str(r.get("id") or "")
        if not pid:
            continue
        s = con.execute("SELECT status FROM das_prospect WHERE id=?", (pid,)).fetchone()
        if s and (s["status"] or "new") != "new":
            continue
        keep = {k: r.get(k) for k in ("id", "name", "kind", "kind_label", "email", "contact_name", "address", "city", "state")}
        con.execute("INSERT OR REPLACE INTO das_mail_queue(login, key, state, until, data, ts) VALUES(?,?,?,?,?,?)",
                    (login, f"prospect:{pid}", "planned", None, json.dumps(keep), _now().isoformat()[:19]))
        n += 1
    con.commit()
    return {"queued": n, "max": PROSPECT_BATCH}


def put_off(con, login, key, days=None):
    """Snooze an item for days (default 7), or dismiss it for good (days=0)."""
    ensure(con)
    old = con.execute("SELECT data FROM das_mail_queue WHERE login=? AND key=?", (login, key)).fetchone()
    if days == 0:
        state, until = "dismissed", None
    else:
        state, until = "snoozed", (_now().date() + datetime.timedelta(days=int(days or 7))).isoformat()
    con.execute("INSERT OR REPLACE INTO das_mail_queue(login, key, state, until, data, ts) VALUES(?,?,?,?,?,?)",
                (login, key, state, until, old["data"] if old else None, _now().isoformat()[:19]))
    con.commit()
    return {"ok": True, "state": state, "until": until}


def sent_last_hour(con, login):
    since = (_now() - datetime.timedelta(hours=1)).isoformat()[:19]
    return con.execute("SELECT COUNT(*) FROM das_mail WHERE login=? AND direction='out' AND ts>=?", (login, since)).fetchone()[0]
