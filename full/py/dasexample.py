"""
A completed example job's history (DAS › Add example jobs, static/dasexample.js): the people on the job, the supplier
quotes compared, the licensees' consent, the dated log and the mail that went back and forth, as a finished job has
them. The job itself (its data) comes from static/das_examples/*-complete.json through the ordinary job API; this adds
the parts that live in their own tables.

Everything here is fictional and marked as an example: contacts, suppliers and mail use .example addresses only
(RFC 2606: they can never reach anyone), every message is recorded as already sent or received, and nothing is sent.
It acts only on a job whose data says it's a completed example, once.
"""
import json
import os
import re
import time

import das
import dasmail

EXAMPLE_DOMAIN = re.compile(r"@[a-z0-9.-]+\.example$", re.I)
CONTACT_FIELDS = ("name", "org", "role", "phone", "email", "notes")


def _addr_ok(a):
    return bool(EXAMPLE_DOMAIN.search((a or "").strip()))


def _ts(s, default):
    s = (s or "").strip()
    return s if re.match(r"^\d{4}-\d\d-\d\d( \d\d:\d\d(:\d\d)?)?$", s) else default


def seed(con, jid, d, login):
    """d: the example file's "seed": {contacts: {role: contact}, suppliers: [..], rfq: {..}, consent: {..}, log: [..],
    mail: [..], files: {name: "YYYY-MM-DD HH:MM"}}. Returns what was added."""
    j = das.job_row(con, jid)
    if not j:
        raise LookupError(f"Job {jid} was deleted.")
    data = j["data"] or {}
    if not data.get("example_complete"):
        raise ValueError("Only a completed example job takes an example history.")
    if data.get("example_seeded"):
        raise ValueError("This example job already has its history.")
    d = d or {}
    out = {"contacts": 0, "quotes": 0, "consents": 0, "log": 0, "mail": 0}
    patch = {"example_seeded": time.strftime("%Y-%m-%d")}

    # people: the same contact (by email) is used again, never doubled
    have = {(c.get("email") or "").lower(): c for c in das.list_contacts(con)}
    roles = {}
    for role, c in (d.get("contacts") or {}).items():
        if role not in ("ahj", "owner", "agency", "gc", "sub", "tech") or not _addr_ok(c.get("email")):
            continue
        cur = have.get(c["email"].lower()) or das.save_contact(con, {k: str(c.get(k) or "")[:300] for k in CONTACT_FIELDS})
        have[c["email"].lower()] = cur
        roles[role] = cur["id"]
        out["contacts"] += 1
    if roles:
        patch["contacts"] = {**(data.get("contacts") or {}), **roles}

    # every licensee the booster passes (the copy's FCC data decides who that is) gets a status: the chosen systems'
    # licensee as cs["chosen"] says, any other as cs["others"] says (an example never claims a real third party consented)
    cs = d.get("consent")
    if cs and (data.get("presurvey") or {}).get("plan"):
        try:
            import daswatch
            pb = daswatch.passband(con, data)
            cls_b = (data.get("booster_class") or "").startswith("Class B")
            cons = dict(data.get("consents") or {})
            for x in pb.get("licensees") or []:
                if not (x.get("chosen") or (x.get("class_b") if cls_b else x.get("class_a"))) or x.get("esmr") and not x.get("chosen"):
                    continue
                if (cons.get(x["key"]) or {}).get("status") in ("given", "not needed"):
                    continue
                how = cs.get("chosen" if x.get("chosen") else "others") or {}
                if how.get("status") not in ("given", "not needed", "asked"):
                    continue
                cons[x["key"]] = {"licensee": x.get("licensee") or x["key"], "status": how["status"],
                                  "calls": sorted(x.get("calls") or []), "date": how.get("date") or "", "note": (how.get("note") or "")[:300]}
                out["consents"] += 1
            patch["consents"] = cons
        except Exception as e:  # no FCC data on this copy: the chosen systems' consent in the job's data stands
            out["consent_error"] = str(e)[:200]
    das.save_job(con, {"data": patch}, jid)

    # suppliers and the request for quote, with each supplier's quote and its dates
    for s in d.get("suppliers") or []:
        if s.get("name") and _addr_ok(s.get("email")):
            das.save_supplier(con, {k: s.get(k) or "" for k in ("name", "email", "phone", "website", "contact", "notes")})
    rq, rid = d.get("rfq"), None
    if rq and rq.get("suppliers"):
        q = das.create_rfq(con, jid, das.job_row(con, jid), rq["suppliers"], rq.get("need_by", ""), rq.get("ship_to", ""), rq.get("notes", ""))
        rid = q["id"]
        for sup, x in (rq.get("quotes") or {}).items():
            das.save_quote(con, rid, sup, {"lines": x.get("lines") or {}, "terms": x.get("terms") or {}})
            con.execute("UPDATE das_rfq_supplier SET sent_at=?, received_at=? WHERE rfq_id=? AND supplier=?",
                        ((x.get("terms") or {}).get("sent_at"), x.get("received_at"), rid, sup))
            con.execute("UPDATE das_quote SET updated_at=? WHERE rfq_id=? AND supplier=?", (x.get("received_at") or das.now(), rid, sup))
            out["quotes"] += 1
        made = _ts(rq.get("created_at"), das.now())
        con.execute("UPDATE das_rfq SET created_at=?, updated_at=?, status=? WHERE id=?", (made, _ts(rq.get("updated_at"), made), rq.get("status") or "open", rid))
        out["rfq_id"] = rid

    # the mail: each message recorded as sent or received on its date, filed under the job (or the request for quote)
    for i, m in enumerate(d.get("mail") or []):
        if not _addr_ok(m.get("counterpart")):
            continue
        sup = m.get("supplier")
        if sup and rid:
            idx = (rq.get("suppliers") or []).index(sup) + 1 if sup in (rq.get("suppliers") or []) else 1
            tag, kind, refs = dasmail.rfq_tag(rid, idx), "rfq", {"rfq_id": rid, "supplier": sup, "job_id": None}
        else:
            tag, kind, refs = dasmail.job_tag(jid, m.get("topic") or "MAIL", m.get("extra") or ""), "job", {"job_id": jid}
        atts = [{"name": a, "type": "application/pdf" if a.lower().endswith(".pdf") else "application/octet-stream", "size": 0, "saved": a}
                for a in m.get("attachments") or []]
        con.execute("""INSERT OR IGNORE INTO das_mail(login, direction, tag, kind, job_id, rfq_id, supplier, prospect_id, counterpart,
                       counterpart_name, subject, body, attachments, message_id, in_reply_to, status, result, ts)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (login, "in" if m.get("direction") == "in" else "out", tag, kind, refs.get("job_id"), refs.get("rfq_id"), refs.get("supplier"),
                     None, m["counterpart"].lower(), (m.get("counterpart_name") or "")[:120] or None,
                     dasmail.subject_with(tag, m.get("subject") or "")[:500], (m.get("body") or "")[:20000], json.dumps(atts),
                     f"<example-j{jid}-{i}@rf-recon.example>", f"<example-j{jid}-{i - 1}@rf-recon.example>" if m.get("direction") == "in" and i else None,
                     m.get("status") or ("applied" if m.get("direction") == "in" else "sent"), (m.get("result") or "")[:500] or None,
                     _ts(m.get("ts"), das.now())))
        out["mail"] += 1

    # the log, in date order, in place of the lines the set-up itself wrote today
    rows = sorted(d.get("log") or [], key=lambda x: x.get("ts") or "")
    if rows:
        con.execute("DELETE FROM das_log WHERE job_id=?", (jid,))
        for x in rows:
            con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                        (jid, _ts(x.get("ts"), das.now()), (x.get("kind") or "note")[:20], (x.get("detail") or "")[:2000]))
            out["log"] += 1
        con.execute("UPDATE das_job SET created_at=? WHERE id=?", (_ts(rows[0].get("ts"), das.now()), jid))
    con.commit()

    # the BDA's alarm traps from the supervisory tests at commissioning, each one cleared (Overview › Monitoring). The
    # address is a documentation one (RFC 5737) and the OIDs the documentation enterprise (RFC 5612): nothing real
    bdas = {b.get("id"): b for b in ((data.get("monitor") or {}).get("bdas") or []) if isinstance(b, dict)}
    if d.get("traps") and bdas:
        import snmpwatch
        snmpwatch.ensure(con)
        for t in d["traps"]:
            b = bdas.get(t.get("bda")) or next(iter(bdas.values()))
            text, oid = str(t.get("text") or "")[:300], str(t.get("oid") or "")[:120]
            vb = [[oid + ".1", "str", text]]
            sig, state = snmpwatch.classify({"trap_oid": oid, "varbinds": vb}, b.get("map"))
            con.execute("INSERT INTO bda_trap(ts, src, agent, community, version, pdu, trap_oid, varbinds, text, signal, state, job_id, bda, how) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (_ts(t.get("ts"), das.now()), b.get("address") or "", None, b.get("community") or "", "v2c", "trap",
                         oid, json.dumps(vb), text, sig, state, jid, b["id"], "source address and community"))
            out["traps"] = out.get("traps", 0) + 1
        con.commit()

    # the report sealed as printed on its day (Report › Print as final): the shipped code when it's free on this copy,
    # else a new one; the seal holds the job's data as it is now, so the example reads sealed and unchanged since
    sl = d.get("seal")
    if sl and sl.get("text"):
        das._seal_table(con)
        code = das.seal_code_norm(sl.get("code") or "")
        if not re.fullmatch(r"[0-9A-Z]{4}-[0-9A-Z]{4}", code) or con.execute("SELECT 1 FROM das_seal WHERE code=?", (code,)).fetchone():
            code = das.seal_report(con, jid, sl["text"], sl.get("title"), sl.get("result"), sl.get("by") or "")["code"]
            con.execute("DELETE FROM das_log WHERE job_id=? AND kind='sealed' AND ts>?", (jid, rows[-1]["ts"] if rows else ""))
        else:
            job = das.job_row(con, jid)
            jd = das._canon(das.seal_data(job["data"]))
            con.execute("INSERT INTO das_seal(code, job_id, at, by, title, result, sha256, job_sha256, job_updated, job_data, content) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (code, jid, "", sl.get("by") or "", str(sl.get("title") or "")[:300], str(sl.get("result") or "")[:80],
                         das._sha(sl["text"]), das._sha(jd), job.get("updated_at") or "", jd, sl["text"]))
        con.execute("UPDATE das_seal SET at=? WHERE code=?", (_ts(sl.get("at"), das.now()), code))
        con.commit()
        out["seal"] = code

    # files keep the date they came in
    for name, ts in (d.get("files") or {}).items():
        try:
            t = time.mktime(time.strptime(_ts(ts, "")[:16], "%Y-%m-%d %H:%M"))
            os.utime(das.file_path(jid, j["name"], name), (t, t))
        except (OSError, ValueError, OverflowError):
            pass  # a file this copy doesn't have, or a store without file times (the web version)
    return out
