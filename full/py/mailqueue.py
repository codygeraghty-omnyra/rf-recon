"""
Ready to send (Cody 11/4, "Ready-to-send queue"): emails RF Recon writes on its own and lines up for one click each:
follow-ups when a tagged email got no reply, retest reminders to the owner, plans requests for jobs with no plans,
and first emails to prospects queued from the Prospects list. Nothing leaves without the person's click (Send, or
Send all for a batch). Also the written emails for a job (status to the customer, access to the GC, scope to a
subcontractor, the design to the AHJ, the retest reminder, the plans request), for "Email about this job".
Items are worked out from the record each time, so they clear themselves once sent; a person can put one off
(snooze) or drop it (dismiss).

Lifecycle reminders (lane D 11/4): every dated lifecycle item (das.lifecycle: the annual retest, the five-year test, the
AHJ's report deadline and 13-month limit, the operational permit, licensee renewals, instrument calibration, the
tester's certificates) is offered 90 and 30 days before it's due, on the day, and every 30 days while it's overdue, to
the person it concerns (owner, licensee or our technician). One per window: an email with the same subject sent since
the window opened clears it. BDA alarms (snmpwatch.py) are offered to the owner while a monitored BDA has an open
alarm or has gone quiet.
"""
import datetime
import json
import re

import das
import dasmail

FOLLOW_DAYS = 5          # no reply this many days after the last email on a tag: a follow-up
FOLLOW_MAX = 1           # follow-ups per conversation (prospects: CAN-SPAM-polite, one)
PROSPECT_BATCH = 50      # first emails queued from the Prospects list at one go
SEND_PER_HOUR = 150      # Gmail and Workspace limit a mailbox to about 2,000 a day: RF Recon keeps well under
REMIND_DAYS = (90, 30)   # retest and lifecycle reminders this many days before an item is due, then on the day
RETEST_DAYS = REMIND_DAYS[0]  # (the annual retest's first reminder; one at 30 days until 11/4)
OVERDUE_EVERY = 30       # and again every this many days while it's overdue
# each lifecycle item's reminder: who it goes to (Overview › People roles, first with an email) and its group
LIFE_TO = {"quant5": (("owner",), "Lifecycle reminders"), "annual_ahj": (("owner",), "Lifecycle reminders"),
           "op_permit": (("owner",), "Lifecycle reminders"), "auth": (("agency",), "Lifecycle reminders"),
           "report": (("tech",), "Reports due to the AHJ"), "cal": (("tech",), "Calibration and certificates"),
           "cert": (("tech",), "Calibration and certificates"),
           # a carrier DAS (das.job_scope): consent renewals to our technician (or the carrier contact's email when the
           # job has one), the carrier's retest and the maintenance agreement to the owner
           "carrier_consent": (("tech",), "Lifecycle reminders"), "carrier_retest": (("owner",), "Lifecycle reminders"),
           "maintenance": (("owner",), "Lifecycle reminders")}
ROLE_WORD = {"owner": "building owner", "agency": "radio system owner (the licensee)", "tech": "technician (Our technician)"}
GROUP_ORDER = ("BDA alarms", "Follow-ups", "Retest reminders", "Reports due to the AHJ", "Lifecycle reminders",
               "Calibration and certificates", "Plans requests", "Prospects")

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


def template(con, job_id, tid, firm=None, acct_name="", due=None):
    """A written email for a job: {to, to_name, role, subject, body, topic}. Blank is subject + greeting + signature.
    due: the retest date when it isn't the job's retest_due (one computed from the lifecycle)."""
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
        due = due or d.get("retest_due") or "soon"
        subject = f"Annual emergency radio coverage retest due {due}: {j['name']}"
        body = (f"{hello}\n\nThe emergency responder radio coverage system at {where} is due its annual test on {due}, which "
                f"{d.get('ahj') or 'the fire code official'} requires (IFC 510.6 / NFPA 1225).\n\nCould you reply with a few dates "
                "that work for access to every floor, the roof and the equipment room? The test takes about a day for most "
                f"buildings, and you'll receive the report for the fire marshal afterwards.\n\nThank you,\n{sig}")
    return {"to": (c or {}).get("email") or "", "to_name": (c or {}).get("name") or "", "role": role, "subject": subject,
            "body": body, "topic": topic, "job_id": j["id"]}


def window(left):
    """The reminder window a due date is in, from the days left: (name, days from the due date it opened), or None
    before the first one. 90 and 30 days out, on the day, then every OVERDUE_EVERY days while overdue."""
    if left is None or left > REMIND_DAYS[0]:
        return None
    if left > REMIND_DAYS[1]:
        return str(REMIND_DAYS[0]), -REMIND_DAYS[0]
    if left > 0:
        return str(REMIND_DAYS[1]), -REMIND_DAYS[1]
    if left == 0:
        return "0", 0
    n = (-left) // OVERDUE_EVERY
    return f"over{n}", n * OVERDUE_EVERY


def _when(due, left):
    return f"overdue since {due} ({-left} days)" if left < 0 else "due today" if left == 0 else f"due {due} (in {left} days)"


def _sent_since(rows, start, match):
    """An email on this job sent on or after start (a date) whose subject (tag stripped) passes match."""
    return any(r["direction"] == "out" and str(r["ts"])[:10] >= start and match(_strip_tag(r["subject"])) for r in rows or [])


def _life_mail(j, x, contacts, firm, acct_name):
    """The written reminder for one lifecycle item: (to contact, role, subject, body)."""
    d = j["data"] or {}
    roles = LIFE_TO[x["key"]][0]
    c, role = _person(d, contacts, roles)
    em = re.search(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", x.get("contact") or "") if x["key"] == "carrier_consent" else None
    if em:  # the carrier's own contact, from its approval on the job
        c, role = {"email": em.group(0), "name": ""}, "carrier"
    where = f"{j['name']}{', ' + d['address'] if d.get('address') else ''}"
    hello = f"Hello{(' ' + _first(c.get('name'))) if c and _first(c.get('name')) else ''},"
    sig = _sig(d, contacts, firm, acct_name)
    due, late, k, src = x["due"], (x["days"] or 0) < 0, x["key"], x["source"]
    is_due = "was due" if late else "is due"
    ahj = d.get("ahj") or "the fire code official"
    dates = ("Could you reply with a few dates that work for access to every floor, the roof and the equipment room? "
             "You'll receive the report for the fire marshal afterwards.")
    if k == "quant5":
        subject = f"Five-year emergency radio coverage test due {due}: {j['name']}"
        body = (f"{hello}\n\nThe emergency responder radio coverage system at {where} {is_due} its five-year full test on "
                f"{due}.\n\nThe rule: {src}\n\n{dates}\n\nThank you,\n{sig}")
    elif k == "annual_ahj":
        subject = f"{x.get('ahj')} annual report deadline {due}: {j['name']}"
        body = (f"{hello}\n\n{x['label']}. For {where} ({x['note']}) the next test has to be done and its report filed by "
                f"{due}.\n\nThe rule: {src}\n\n{dates}\n\nThank you,\n{sig}")
    elif k == "op_permit":
        subject = f"ERCES operational permit expires {due}: {j['name']}"
        body = (f"{hello}\n\nThe operational permit for the emergency responder radio coverage system at {where} "
                f"{'expired' if late else 'expires'} on {due}. {ahj} renews it. Would you like us to file the renewal?"
                f"\n\nThank you,\n{sig}")
    elif k == "auth":
        subject = f"Retransmission authorization renewal due {due}: {j['name']}"
        body = (f"{hello}\n\nThe authorization to retransmit your radio system with the signal booster at {where}"
                f"{' (granted ' + x['done'] + ')' if x.get('done') else ''} {is_due} for renewal on {due}. What do you need "
                f"from us to renew it?\n\nThank you,\n{sig}")
    elif k == "report":
        subject = f"Test report due to {x.get('ahj')} by {due}: {j['name']}"
        body = (f"{hello}\n\nThe test report for {where} ({x['note']}) {is_due} to {x.get('ahj')} by {due}.\n\nThe rule: {src}"
                f"\n\nOnce it's filed, enter the filing date on the job (Overview, Lifecycle, Report filed) and this reminder "
                f"stops.\n\n{sig}")
    elif k == "cal":
        subject = f"Calibration runs out {due}: {x.get('instrument')}"
        body = (f"{hello}\n\nThe calibration of the {x.get('instrument')}, used on {where}, {'ran' if late else 'runs'} out on "
                f"{due} ({x['note']}). Readings taken with it after that date don't count toward pass or fail, and the AHJ "
                f"report lists each instrument's calibration date. Book its calibration before the next test.\n\n{sig}")
    elif k == "carrier_consent":
        car = x.get("carrier") or "the carrier"
        subject = f"{car} consent renewal due {due}: {j['name']}"
        body = (f"{hello}\n\nThe {car} consent to retransmit its bands with the signal booster at {where} ({x['note']}) "
                f"{is_due} for renewal on {due}. The booster may run only with the carrier's consent (47 CFR 20.21(c)). "
                f"{'Could you send the renewal, or tell us what you need from us for it?' if role == 'carrier' else 'Ask ' + car + (' (' + x['contact'] + ')' if x.get('contact') else '') + ' for the renewal before then.'}"
                f"\n\n{'Thank you,' + chr(10) if role == 'carrier' else ''}{sig}")
    elif k == "carrier_retest":
        car = x.get("carrier") or "The carrier"
        subject = f"{car} retest of the in-building cellular system due {due}: {j['name']}"
        body = (f"{hello}\n\n{car}'s terms call for a retest of the in-building cellular system at {where} by {due}.\n\n"
                f"{dates.replace(' for the fire marshal', '')}\n\nThank you,\n{sig}")
    elif k == "maintenance":
        subject = f"Maintenance agreement renewal {due}: {j['name']}"
        body = (f"{hello}\n\nThe maintenance agreement for the in-building coverage system at {where} "
                f"{'ran out' if late else 'runs out'} on {due}. Would you like to renew it?\n\nThank you,\n{sig}")
    else:  # cert
        subject = f"{x.get('cert')} expires {due}: {x.get('tester') or 'tester'}"
        body = (f"{hello}\n\nThe {x.get('cert')} for {x.get('tester') or 'the tester'} {'expired' if late else 'expires'} on "
                f"{due}. AHJs check the tester's credentials on each report ({src}). Renew it before the next test at "
                f"{where}.\n\n{sig}")
    return c, role, subject, body


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
        life = das.lifecycle(d, j["stage"], now.date()) if j["stage"] != "Closed" else []
        # 2. the annual retest: 90 and 30 days before it's due, on the day, and every 30 days while overdue; an email
        #    about the retest sent since the window opened (this queue's or one written by hand) clears it
        annual = next((x for x in life if x["key"] == "annual"), {})
        due = d.get("retest_due") or annual.get("due")
        if due and j["stage"] != "Closed" and das.job_scope(d)["ps"]:  # a carrier-only DAS has no IFC annual test
            try:
                left = (datetime.date.fromisoformat(str(due)[:10]) - now.date()).days
            except ValueError:
                left = None
            win = window(left)
            if win:
                start = (datetime.date.fromisoformat(str(due)[:10]) + datetime.timedelta(days=win[1])).isoformat()
                asked = _sent_since(sent_topics.get(jid), start, lambda s: "retest" in s.lower())
                key = f"retest:{jid}:{due}:{win[0]}"
                if not asked and _live(st, key, now):
                    t = template(con, jid, "retest", firm, acct_name, due=str(due)[:10])
                    out.append({"key": key, "group": "Retest reminders", "kind": "job", "refs": {"job_id": jid, "topic": "MAIL"},
                                "to": t["to"], "to_name": t["to_name"], "subject": t["subject"], "body": t["body"], "job_id": jid,
                                "why": f"{j['name']}: the annual test is {_when(due, left)}",
                                "blocked": "" if t["to"] else "No building owner with an email on this job (Overview › People)."})
        # 2b. every other dated lifecycle item, to the person it concerns, in the same windows
        for x in life:
            if x["key"] not in LIFE_TO or not x["due"] or x["state"] == "done":
                continue
            win = window(x["days"])
            if not win:
                continue
            c, role, subject, body = _life_mail(j, x, contacts, firm, acct_name)
            start = (datetime.date.fromisoformat(x["due"]) + datetime.timedelta(days=win[1])).isoformat()
            key = f"life:{jid}:{x['id']}:{x['due']}:{win[0]}"
            if _sent_since(sent_topics.get(jid), start, lambda s, subject=subject: s == subject) or not _live(st, key, now):
                continue
            roles = LIFE_TO[x["key"]][0]
            out.append({"key": key, "group": LIFE_TO[x["key"]][1], "kind": "job", "refs": {"job_id": jid, "topic": "MAIL"},
                        "to": (c or {}).get("email") or "", "to_name": (c or {}).get("name") or "", "subject": subject,
                        "body": body, "job_id": jid, "life": x["id"],
                        "why": f"{j['name']}: {x['label']}, {_when(x['due'], x['days'])}"
                               + (f" ({x['ahj']} rule)" if x.get("ahj") else ""),
                        "blocked": "" if c else f"No {ROLE_WORD[roles[0]]} with an email on this job (Overview › People)."})
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
    # 5. BDA alarms and BDAs gone quiet (snmpwatch.py), only while monitoring is switched on
    try:
        import snmpwatch
        out += [x for x in snmpwatch.queue_items(con, jobs, contacts, firm, acct_name, now) if _live(st, x["key"], now)]
    except ImportError:  # the web version has no monitoring
        pass
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
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
