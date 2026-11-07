"""
RF Recon mail threads (Cody 11/4): every email RF Recon sends carries a tag in its subject, so the reply files itself:

  [RFR Q12.2]               request for quote 12, supplier 2      → the quote is read in (sheet or typed prices)
  [RFR P-1a2b3c4d]          a DAS prospect                         → replied / do not contact (CAN-SPAM)
  [RFR J7 PLANS]            job 7, building plans request          → PDFs into the job's files
  [RFR J7 CONSENT WQIF866]  job 7, licensee consent letter         → signed copy into the job's files, noted, offered on Needs you
  [RFR J7 AHJ]              job 7, AHJ question, submittal, report → into the job's files and log, offered on Needs you
  [RFR J7 MAIL]             job 7, anything else                   → into the job's files and log

A reply is acted on only when it comes from the address the message went to (or the same domain); anything else is
held for the person to look at. Nothing is ever sent from here without the person pressing Send. Standard library only.

A consent or AHJ reply never changes the job's consent or Code check by itself. Reading yes or no from free text can be wrong, so
it makes an offer: the form filled in, a line on the board's Needs you, one press by a person ("a reply's offer", below).
"""
import email.utils
import hashlib
import json
import os
import re
import time

import codecheck
import das
import intake
import dashist
import keystore
import mailbox

SCHEMA = das.MAIL_SCHEMA  # created with the other DAS tables (das.SCHEMA)
TOPICS = ("PLANS", "CONSENT", "AHJ", "MAIL")
OPT_OUT = re.compile(r"\b(unsubscribe|remove me|take me off|no thanks|no thank you|not interested|do not (?:contact|email)|don'?t (?:contact|email)|stop (?:emailing|contacting))\b", re.I)


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- tags

def prospect_hash(pid):
    return hashlib.sha1(str(pid).encode()).hexdigest()[:8]


def rfq_tag(rid, idx):
    return f"Q{int(rid)}.{int(idx)}"


def prospect_tag(pid):
    return f"P-{prospect_hash(pid)}"


def job_tag(jid, topic="MAIL", extra=""):
    topic = topic.upper() if topic.upper() in TOPICS else "MAIL"
    extra = re.sub(r"[^A-Za-z0-9-]", "", extra or "")[:20]
    return f"J{int(jid)} {topic}" + (f" {extra.upper()}" if extra else "")


def subject_with(tag, subject):
    s = re.sub(r"\s*\[RFR [^\]]*\]", "", subject or "").strip()
    return f"{s} [RFR {tag}]"


def parse_tag(t):
    t = (t or "").strip()
    m = re.fullmatch(r"Q(\d+)\.(\d+)", t)
    if m:
        return {"kind": "rfq", "rfq_id": int(m.group(1)), "sup": int(m.group(2))}
    m = re.fullmatch(r"P-([0-9a-f]{8})", t)
    if m:
        return {"kind": "prospect", "hash": m.group(1)}
    m = re.fullmatch(r"J(\d+) ([A-Z]+)(?: ([A-Z0-9-]{1,20}))?", t)
    if m and m.group(2) in TOPICS:
        return {"kind": "job", "job_id": int(m.group(1)), "topic": m.group(2), "extra": m.group(3) or ""}
    return None


# ---------------------------------------------------------------- accounts (the key store, per login)

def account(data_dir, login, with_password=False):
    a = (keystore.load(data_dir, "mail") or {}).get(login or "local")
    if not a:
        return None
    return a if with_password else {k: v for k, v in a.items() if k != "password"}


def save_account(data_dir, login, a):
    every = keystore.load(data_dir, "mail") or {}
    old = every.get(login or "local") or {}
    if not a.get("password"):
        a["password"] = old.get("password")
    if not a.get("password"):
        raise ValueError("Enter the app password.")
    every[login or "local"] = a
    keystore.save(data_dir, every, "mail")


def delete_account(data_dir, login):
    every = keystore.load(data_dir, "mail") or {}
    every.pop(login or "local", None)
    keystore.save(data_dir, every, "mail")


def logins(data_dir):
    return sorted((keystore.load(data_dir, "mail") or {}).keys())


def account_from(d, old=None):
    """A mailbox account from the form: the address picks the provider's settings, anything typed wins."""
    addr = mailbox.clean_address(d.get("address"))  # a paste's invisible characters made a good address "not an address" (11/4)
    if not addr:
        raise ValueError("Enter your email address.")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}", addr):
        raise ValueError(f"“{addr}” isn't an email address RF Recon can use: check it, or type it in rather than paste it.")
    g = mailbox.guess(addr)
    if g["provider"] == "microsoft" and not d.get("imap_host"):
        raise ValueError(g["how"])
    a = {"address": addr, "name": (d.get("name") or "").strip()[:80], "user": (mailbox.clean_address(d.get("user")) if "@" in (d.get("user") or "") else (d.get("user") or "").strip()) or addr,
         "password": (d.get("password") or "").strip(), "provider": g["provider"],
         "imap_host": (d.get("imap_host") or g["imap_host"] or "").strip(), "imap_port": int(d.get("imap_port") or g["imap_port"] or 993),
         "smtp_host": (d.get("smtp_host") or g["smtp_host"] or "").strip(), "smtp_port": int(d.get("smtp_port") or g["smtp_port"] or 465),
         "smtp_mode": d.get("smtp_mode") or g["smtp_mode"] or "ssl", "saves_sent": bool(g["saves_sent"]),
         "folder": (d.get("folder") or "INBOX").strip() or "INBOX"}
    # Google and Yahoo show an app password as four groups of four ("abcd efgh ijkl mnop"): sign in with it joined
    if re.fullmatch(r"[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){3}", a["password"]):
        a["password"] = a["password"].replace(" ", "")
    if old and not a["password"]:
        a["password"] = old.get("password") or ""
    if not a["password"]:
        raise ValueError("Paste the app password from your provider (for Google: myaccount.google.com/apppasswords), then press Connect and test.")
    return a


# ---------------------------------------------------------------- outbound

def record_out(con, login, tag, to, subject, body, message_id, refs=None, attachments=()):
    p = parse_tag(tag) or {}
    refs = refs or {}
    con.execute("""INSERT OR IGNORE INTO das_mail(login, direction, tag, kind, job_id, rfq_id, supplier, prospect_id, counterpart, subject,
                   body, attachments, message_id, status, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (login, "out", tag, p.get("kind"), refs.get("job_id") or p.get("job_id"), refs.get("rfq_id") or p.get("rfq_id"),
                 refs.get("supplier"), refs.get("prospect_id"), (to or "").lower(), subject, (body or "")[:20000],
                 json.dumps(list(attachments)), message_id, "sent", now()))
    con.commit()


def after_send(con, tag, refs):
    """What sending means for the record it belongs to: a request marked sent, a prospect marked contacted."""
    p = parse_tag(tag) or {}
    if p.get("kind") == "rfq" and refs.get("supplier"):
        das.save_quote(con, p["rfq_id"], refs["supplier"], {"terms": {"sent_at": now()[:16]}})
    elif p.get("kind") == "prospect" and refs.get("prospect_id"):
        cur = con.execute("SELECT status FROM das_prospect WHERE id=?", (refs["prospect_id"],)).fetchone()
        if not cur or (cur["status"] or "new") == "new":
            das.set_prospect(con, refs["prospect_id"], {"status": "contacted"})
    jid = refs.get("job_id") or p.get("job_id")
    if jid and con.execute("SELECT 1 FROM das_job WHERE id=?", (jid,)).fetchone():
        das.note(con, jid, f"Email sent [RFR {tag}] to {refs.get('to', '')}")


# ---------------------------------------------------------------- inbound

def _domain(a):
    return (a or "").rsplit("@", 1)[-1].lower()


def _trusted(con, tag, sender, extra=()):
    """The reply comes from an address this tag's mail went to (or the same domain)."""
    to = {r[0] for r in con.execute("SELECT counterpart FROM das_mail WHERE tag=? AND direction='out'", (tag,))}
    to |= {x.lower() for x in extra if x}
    addrs = {a.strip() for t in to for a in re.split(r"[,;\s]+", t or "") if "@" in a}
    return sender in addrs or _domain(sender) in {_domain(a) for a in addrs}


_MONEY = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+(?:\.\d{1,4})?)")
_NUM = re.compile(r"(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d{1,4})?|\d+\.\d{1,4})(?![\w.])")
_LEAD = re.compile(r"(\d+)\s*(?:-|to)?\s*(\d+)?\s*(business days?|days?|wks?|weeks?)", re.I)


def _flat(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _price(s):
    return float(s.replace(",", ""))


def parse_prices(text, lines):
    """Typed prices in a supplier's reply, line by line: {key: {unit_price, lead_days}}, plus shipping and lead time
    for the whole order. A line counts only when it names the part number (or the full description) and a price."""
    body = [ln for ln in (text or "").splitlines() if ln.strip()]
    found, terms = {}, {}
    for ln in lines:
        keys = [k for k in (_flat(ln.get("part")), _flat(ln.get("item"))) if k and len(k) >= 4]
        for row in body:
            fr = _flat(row)
            if not any(k in fr for k in keys):
                continue
            row_wo = row
            if ln.get("part"):
                row_wo = re.sub(re.escape(ln["part"]), " ", row, flags=re.I)
            money = [_price(m) for m in _MONEY.findall(row_wo)] or [_price(m) for m in _NUM.findall(row_wo)]
            if not money:
                continue
            unit = money[0]
            qty = float(ln.get("qty") or 0)
            if len(money) >= 2 and qty and abs(money[1] - money[0] * qty) < 0.02 * max(1, money[1]):
                unit = money[0]
            elif len(money) >= 2 and qty and abs(money[0] - money[1] * qty) < 0.02 * max(1, money[0]):
                unit = money[1]
            x = {"unit_price": round(unit, 4)}
            lm = _LEAD.search(row_wo)
            if lm:
                n = int(lm.group(2) or lm.group(1))
                x["lead_days"] = n * 7 if lm.group(3).lower().startswith("w") else n
            elif re.search(r"\b(in stock|stock)\b", row_wo, re.I):
                x["lead_days"] = 0
            found[ln["key"]] = x
            break
    for row in body:
        if re.search(r"\b(shipping|freight|delivery)\b", row, re.I):
            m = _MONEY.search(row)
            if m and "ship_cost" not in terms:
                terms["ship_cost"] = _price(m.group(1))
            lm = _LEAD.search(row)
            if lm and "ship_days" not in terms:
                n = int(lm.group(2) or lm.group(1))
                terms["ship_days"] = n * 7 if lm.group(3).lower().startswith("w") else n
        vm = re.search(r"(?:valid|good|holds?)\s+(?:until|through|thru|for)\s+(\d{4}-\d\d-\d\d|\d{1,2}/\d{1,2}/\d{2,4}|\d+\s+days)", row, re.I)
        if vm and "valid_until" not in terms:
            terms["valid_until"] = vm.group(1)
    return {"lines": found, "terms": terms}


def _store_in(con, login, msg, tag, kind, status, result, refs=None, proposal=None):
    refs = refs or {}
    con.execute("""INSERT OR IGNORE INTO das_mail(login, direction, tag, kind, job_id, rfq_id, supplier, prospect_id, counterpart, subject,
                   body, attachments, message_id, in_reply_to, status, result, proposal, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (login, "in", tag, kind, refs.get("job_id"), refs.get("rfq_id"), refs.get("supplier"), refs.get("prospect_id"),
                 msg["from"], msg["subject"][:500], (msg.get("new_text") or msg.get("text") or "")[:20000],
                 json.dumps([{"name": a["name"], "type": a["type"], "size": len(a["data"]), "saved": a.get("saved")} for a in msg["attachments"]]),
                 msg.get("message_id") or f"<uid{msg.get('uid')}@{login}>", msg.get("in_reply_to"), status, result,
                 json.dumps(proposal) if proposal else None, now()))
    if msg.get("from_name"):  # "Jane Smith <jane@...>": the name, for saving the sender as a contact
        try:
            con.execute("UPDATE das_mail SET counterpart_name=? WHERE login=? AND message_id=? AND counterpart_name IS NULL",
                        (msg["from_name"][:120], login, msg.get("message_id") or f"<uid{msg.get('uid')}@{login}>"))
        except Exception:
            pass  # a table older than the column
    con.commit()


def seen(con, login, message_id):
    return bool(message_id and con.execute("SELECT 1 FROM das_mail WHERE login=? AND message_id=?", (login, message_id)).fetchone())


def _save_atts(con, jid, msg, only=None):
    j = das.job_row(con, jid)
    if not j:
        return []
    out = []
    for a in msg["attachments"]:
        if only and not re.search(only, a["name"], re.I):
            continue
        a["saved"] = (intake.from_mail(con, jid, a["name"], a["data"], msg.get("from") or "") if intake.MAIL_SCAN
                      else das.save_file(jid, j["name"], a["name"], a["data"]))
        if a["saved"]:  # refused: it's on the Intake list with why, and not in Files
            out.append(a["saved"])
    return out


def route(con, login, msg):
    """File one tagged message. Returns {"status", "result"}; never raises for a message it can't place."""
    if seen(con, login, msg.get("message_id")):
        return {"status": "seen", "result": "already filed"}
    for raw in msg["tags"]:
        tag = raw.strip()
        p = parse_tag(tag)
        if not p:
            continue
        try:
            if p["kind"] == "rfq":
                return _route_rfq(con, login, msg, tag, p)
            if p["kind"] == "prospect":
                return _route_prospect(con, login, msg, tag, p)
            return _route_job(con, login, msg, tag, p)
        except Exception as e:  # a reply we can't act on is still kept, with why
            _store_in(con, login, msg, tag, p["kind"], "error", f"{type(e).__name__}: {str(e)[:200]}")
            return {"status": "error", "result": str(e)[:200]}
    _store_in(con, login, msg, (msg["tags"] or [""])[0], None, "held", "tag not recognised")
    return {"status": "held", "result": "tag not recognised"}


def _route_rfq(con, login, msg, tag, p):
    q = das.get_rfq(con, p["rfq_id"])
    sups = q["suppliers"]
    if not (1 <= p["sup"] <= len(sups)):
        raise LookupError("That request has no such supplier.")
    sup = sups[p["sup"] - 1]
    srow = con.execute("SELECT email FROM das_supplier WHERE name=?", (sup,)).fetchone()
    refs = {"rfq_id": q["id"], "supplier": sup, "job_id": q.get("job_id")}
    if not _trusted(con, tag, msg["from"], [srow["email"] if srow else ""]):
        _save_atts(con, q.get("job_id"), msg) if q.get("job_id") else None
        _store_in(con, login, msg, tag, "rfq", "held", f"from {msg['from']}, not {sup}'s address: look before using it", refs)
        return {"status": "held", "result": f"not from {sup}'s address"}
    imported = []
    for a in msg["attachments"]:
        if re.search(r"\.(csv|tsv|txt|xlsx|json)$", a["name"], re.I):
            try:
                r = das.import_quote(con, q["id"], sup, a["name"], a["data"])
                imported.append(f"{a['name']}: {r['imported']['lines']} line(s)")
            except ValueError as e:
                imported.append(f"{a['name']}: not read ({str(e)[:80]})")
    if q.get("job_id"):
        _save_atts(con, q["job_id"], msg)
    prop = parse_prices(msg.get("new_text") or msg.get("text"), q["lines"])
    if any("line(s)" in x for x in imported):
        if prop["terms"]:
            das.save_quote(con, q["id"], sup, {"lines": {}, "terms": prop["terms"]})
        res = "quote sheet read in: " + "; ".join(imported)
        _store_in(con, login, msg, tag, "rfq", "applied", res, refs)
        return {"status": "applied", "result": res}
    if prop["lines"] or prop["terms"]:
        res = f"{len(prop['lines'])} of {len(q['lines'])} lines priced in the email: press Apply to use them"
        _store_in(con, login, msg, tag, "rfq", "proposal", res, refs, prop)
        return {"status": "proposal", "result": res}
    das.save_quote(con, q["id"], sup, {"lines": {}, "terms": {"received_at": None}})
    res = "reply with no prices found: read it" + (f" ({'; '.join(imported)})" if imported else "")
    _store_in(con, login, msg, tag, "rfq", "reply", res, refs)
    return {"status": "reply", "result": res}


def apply_proposal(con, mail_id):
    r = con.execute("SELECT * FROM das_mail WHERE id=?", (mail_id,)).fetchone()
    if not r or not r["proposal"] or r["kind"] != "rfq":  # a job reply's offer goes through Needs you: it has no prices
        raise LookupError("No prices to apply on that email.")
    prop = json.loads(r["proposal"])
    das.save_quote(con, r["rfq_id"], r["supplier"], {"lines": prop.get("lines") or {}, "terms": prop.get("terms") or {}})
    con.execute("UPDATE das_mail SET status='applied', result=? WHERE id=?", ((r["result"] or "") + " · applied", mail_id))
    con.commit()
    return das.get_rfq(con, r["rfq_id"])


def _route_prospect(con, login, msg, tag, p):
    out = con.execute("SELECT prospect_id, counterpart FROM das_mail WHERE tag=? AND direction='out' ORDER BY id DESC", (tag,)).fetchone()
    if not out:
        _store_in(con, login, msg, tag, "prospect", "held", "no email of ours with this tag")
        return {"status": "held", "result": "no email of ours with this tag"}
    pid = out["prospect_id"]
    refs = {"prospect_id": pid}
    if not _trusted(con, tag, msg["from"]):
        _store_in(con, login, msg, tag, "prospect", "held", f"from {msg['from']}, not the address we wrote to", refs)
        return {"status": "held", "result": "not from the address we wrote to"}
    text = msg.get("new_text") or msg.get("text") or ""
    if OPT_OUT.search(text) or OPT_OUT.search(msg["subject"]):
        das.set_prospect(con, pid, {"status": "do not contact"})
        res = "asked not to be contacted: marked Do not contact"
    else:
        cur = con.execute("SELECT status FROM das_prospect WHERE id=?", (pid,)).fetchone()
        if not cur or (cur["status"] or "new") in ("new", "contacted"):
            das.set_prospect(con, pid, {"status": "replied"})
        res = "replied"
    _store_in(con, login, msg, tag, "prospect", "applied", res, refs)
    return {"status": "applied", "result": res}


def _route_job(con, login, msg, tag, p):
    jid = p["job_id"]
    if not das.job_row(con, jid):
        _store_in(con, login, msg, tag, "job", "held", "that job was deleted")
        return {"status": "held", "result": "that job was deleted"}
    refs = {"job_id": jid}
    trusted = _trusted(con, tag, msg["from"])
    saved = _save_atts(con, jid, msg)
    what = {"PLANS": "plans", "CONSENT": f"consent reply{(' for ' + p['extra']) if p['extra'] else ''}", "AHJ": "AHJ reply", "MAIL": "reply"}[p["topic"]]
    res = f"{what} from {msg['from']}" + (f": {len(saved)} file(s) in the job's files ({', '.join(saved[:4])})" if saved else ": no attachments")
    das.note(con, jid, f"Email [RFR {tag}] {res}" + ("" if trusted else " (not from an address we wrote to: check it)"))
    if p["topic"] == "CONSENT" and trusted:
        j = das.job_row(con, jid)
        data = j["data"]
        cr = data.get("consent_replies") or {}
        cr[p["extra"] or msg["from"]] = {"from": msg["from"], "at": now()[:10], "files": saved}
        das.save_job(con, {"data": {"consent_replies": cr}}, jid)
    offer = _offer(con, jid, tag, p, msg, trusted)
    status = "held" if not trusted else "offer" if offer else "applied"
    _store_in(con, login, msg, tag, "job", status, res, refs, offer)
    return {"status": status, "result": res}


# ---------------------------------------------------------------- a reply's offer
# Each consent or AHJ reply fills the form and shows on Needs you, the way typed prices wait for Apply. It never decides: a person
# reads it and presses. The press saves through the page's own routes (dasx.js: /api/das/x/consent, /api/das/x/code), so the stage
# gate, the job's one list of emails and Walk me through see it with nothing further. What's kept here is what the reply offered
# (the proposal column) and whether it's been dealt with. A line also goes when the job's own record gets there first.

_AUTO = re.compile(r"\s*(automatic reply|auto[- ]?reply|auto[- ]?response|out of (the )?office|undeliverable|undelivered|delivery (status|failure|has failed)|mail delivery|returned mail)\b", re.I)
_NEG = (r"(?:can ?not|can'?t|could ?not|couldn'?t|won'?t|will not|would not|wouldn'?t|do not|don'?t|does not|doesn'?t|did not|didn'?t|"
        r"are not|aren'?t|is not|isn'?t|am not|must not|may not|unable to|not able to|not willing to|not prepared to|not in a position to)")
# "no objection" and its like say no but mean yes: taken out before the words below are looked for
_NOT_A_NO = re.compile(r"\bno\s+(?:\w+\s+)?(?:objections?|issues?|problems?|concerns?|worries)\b|(?:\bnot|n'?t|\bnever)\s+(?:\w+\s+)?(?:object|oppose|opposed|mind)\b|"
                       r"\bno reason to (?:refuse|deny|object)\b", re.I)
_REFUSED = re.compile(rf"\b{_NEG}\s+(?:\w+\s+){{0,3}}?(?:consent|agree|allow|approve|authori[sz]e|grant|permit|give|provide|sign|support|accept)\w*|"
                      r"\b(?:declin|refus|reject|withh[eo]ld|withdr[ae]w)\w*|\bden(?:y|ied|ies|ial)\b|\bobject(?:s|ed|ions?)?\b|\boppose[sd]?\b|\bno consent\b|"
                      r"\bnot\s+(?:be\s+)?(?:approved|granted|authori[sz]ed|permitted|allowed|acceptable|agreed)\b|\bnot (?:at this time|yet)\b|\bhold off\b|"
                      r"^\s*(?:no|nope)(?:[.,!;:]|\s*$)", re.I | re.M)
# a yes in so many words. Beside a no ("we consent, but we can't sign until Monday") it reads both ways: the line then offers only Read it
_SAID_YES = re.compile(r"\b(?:we|i)\s+(?:hereby\s+|do\s+)?(?:consent|approve|agree|authori[sz]e|grant)\b|\bconsent\s+(?:is\s+|was\s+|has been\s+|hereby\s+)?(?:granted|given|approved)\b|"
                       r"(?<!not )\bapproved\b|\bgo ahead\b", re.I)
# an AHJ's answers are full of "we do not allow": only saying it won't answer, or that it isn't theirs to answer, is a refusal
_AHJ_REFUSED = re.compile(rf"\b{_NEG}\s+(?:\w+\s+){{0,2}}?(?:confirm|answer|advise|comment|respond|say|tell)\w*|"
                          r"\b(?:not|outside|out)\s+(?:of\s+|in\s+|within\s+|under\s+)?(?:our|my|this office'?s?)\s+(?:jurisdiction|authority|area)\b", re.I)
WORDS_DONE = {"given": "marked given", "refused": "marked refused", "confirmed": "Code check marked confirmed", "cleared": "nothing to mark"}


def reads_as_refusal(text):
    return bool(_REFUSED.search(_NOT_A_NO.sub(" ", text or "")))


def reads_both_ways(text):
    return reads_as_refusal(text) and bool(_SAID_YES.search(text or ""))


def reads_as_ahj_refusal(text):
    return bool(_AHJ_REFUSED.search(text or ""))


def _written_on(msg):
    """The day the reply was written, from its Date line, or today when that can't be read: a mailbox read late doesn't move the date."""
    try:
        return email.utils.parsedate_to_datetime(msg.get("date") or "").strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return now()[:10]


def _licensee(d, call):
    """Whose licence a consent tag's call sign is: the row the send left, else the channel plan. {} when neither says; the press
    then looks in the job's passband list (dasx.js)."""
    import daswatch
    for key, c in (d.get("consents") or {}).items():
        if call and call in (c.get("calls") or []):
            return {"key": key, "licensee": c.get("licensee") or key, "calls": c.get("calls")}
    for s in (d.get("presurvey") or {}).get("plan") or []:
        if call and (s.get("call_sign") or "").upper() == call:
            return {"key": daswatch.licensee_key(s.get("system")) or call, "licensee": s.get("system") or call, "calls": [call]}
    return {}


def _name_of(con, msg):
    """Who at the AHJ: the name they're saved under, else the name on the email, else the address."""
    c = next((c for c in das.list_contacts(con) if (c.get("email") or "").lower() == msg["from"]), {})
    return c.get("name") or (msg.get("from_name") or "")[:120] or msg["from"]


def _ahj_about(con, tag, msg):
    """One tag carries every email to the AHJ: the Code check's question, the design for review, the test report. A reply answers the
    one it replies to, so only the question's reply fills the Code check. "" for the question."""
    was = con.execute("SELECT subject FROM das_mail WHERE tag=? AND direction='out' AND message_id=?", (tag, msg.get("in_reply_to") or "")).fetchone()
    s = was["subject"] if was else msg["subject"]
    return "the design" if re.search(r"ERCES design\b", s, re.I) else "the test report" if re.search(r"ERCES (?:acceptance|annual|five-year) test report", s, re.I) else ""


def _offer(con, jid, tag, p, msg, trusted):
    """What a reply offers: the form filled in, or None for a topic with no form. line: the presses on the Needs you line. reader: the
    presses once it's been read, for when the reading was wrong. An untrusted sender gets neither."""
    if p["topic"] not in ("CONSENT", "AHJ"):
        return None
    d, text = das.job_row(con, jid)["data"], msg.get("new_text") or msg.get("text") or ""
    auto = bool(_AUTO.match(msg["subject"]))
    o = {"trusted": trusted, "from": msg["from"], "who": msg.get("from_name") or msg["from"], "date": _written_on(msg), "auto": auto, "refusal": False}
    if p["topic"] == "CONSENT":
        o["both"] = not auto and reads_both_ways(text)
        o["refusal"] = not auto and not o["both"] and reads_as_refusal(text)
        extra = p["extra"]
        if extra and not re.search(r"\d", extra):  # a call sign always has a digit; a carrier's tag is its name (dascell.js dasCellConsentMail)
            o.update(kind="carrier", carrier=das.carrier_name(extra), line=[] if o["refusal"] else ["given"], reader=["given"])  # its table has a consent date, no refused
        else:
            o.update(kind="consent", call=extra, line=[] if o["refusal"] else ["given"], reader=["given", "refused"], **_licensee(d, extra))  # a refusal is word matching: it can be wrong, so that press comes after reading it
        if o["both"]:
            o["line"] = []
    else:
        about = _ahj_about(con, tag, msg)
        if about or codecheck.status(d) == "confirmed":
            o.update(kind="read", about=about, line=[], reader=[])
        else:
            o["refusal"] = not auto and reads_as_ahj_refusal(text)
            o.update(kind="code", confirmed_by=_name_of(con, msg), confirmed_on=o["date"], how="email", line=[] if o["refusal"] else ["confirmed"], reader=["confirmed"])
    if auto:
        o["line"] = []
    if not trusted:
        o["line"], o["reader"] = [], []
    return o


def _settled(o, d):
    """The job's own record has got there: someone set it in the Pre-survey or typed the Code check. A reply that disagrees with the
    record stays up, because that's news, and so does one that came after a refusal was marked."""
    if o["kind"] == "consent":
        c = (d.get("consents") or {}).get(o.get("key")) or {}
        st = c.get("status")
        return not o["refusal"] if st == "given" else (o["refusal"] or o["date"] <= (c.get("date") or "")) if st == "refused" else st == "not needed"
    if o["kind"] == "carrier":
        return not o["refusal"] and bool((((d.get("cellular") or {}).get("approvals") or {}).get(o["carrier"]) or {}).get("consent"))
    return o["kind"] == "code" and codecheck.status(d) == "confirmed"


def _line(o, d):
    name = o.get("licensee") or o.get("carrier") or o["who"]
    no = ": reads as a refusal"
    if not o["trusted"]:
        on = "the AHJ email" if o["kind"] in ("code", "read") else f"the consent email for {o.get('carrier') or o.get('call') or 'this job'}"
        return f"Reply from {o['from']} on {on}: we didn't write to them" + (". It reads as a refusal" if o["refusal"] else "")
    if o["auto"]:
        return f"{name} sent an automatic reply, not an answer"
    if o["kind"] == "read":
        return f"{o['who']} replied{' about ' + o['about'] if o.get('about') else ''}: read it"
    if o["kind"] == "code":
        return "AHJ replied" + (no if o["refusal"] else f": confirmed by {o['confirmed_by']}, {o['confirmed_on']}, by {o['how']}?")
    if o.get("both"):
        return f"{name} replied: reads both ways"
    if not o["refusal"]:
        return f"{name} replied: consent?"
    given = o["kind"] == "consent" and ((d.get("consents") or {}).get(o.get("key")) or {}).get("status") == "given"
    return f"{name} replied{no}" + (", and the job has it as given" if given else "")


def board(con, jid, d, stage):
    """The job's replies nobody has dealt with, as Needs you lines (dasx.py board). Every reply on the job, whoever's mailbox it came to:
    the board already shows only the jobs a login can open. Mail older than this has no offer, so it makes no line."""
    if stage == "Closed":
        return []
    out, shown = [], set()
    for r in con.execute("""SELECT id, message_id, proposal FROM das_mail WHERE job_id=? AND direction='in' AND kind='job'
                            AND status IN ('offer','held') AND proposal IS NOT NULL ORDER BY id DESC""", (jid,)).fetchall():
        o = json.loads(r["proposal"])
        if r["message_id"] in shown or o.get("closed") or _settled(o, d):
            continue
        shown.add(r["message_id"])  # one reply copied to two people's mailboxes is one line
        out.append({"text": _line(o, d), "url": "", "source": "", "reply": {**o, "id": r["id"]}})
    return out


def _reply(con, jid, mail_id):
    r = con.execute("SELECT * FROM das_mail WHERE id=? AND job_id=? AND direction='in' AND proposal IS NOT NULL", (mail_id, jid)).fetchone()
    if not r:
        raise LookupError("That reply isn't on this job.")
    return r


def reply_text(con, jid, mail_id):
    """Read it: the words as they came, and what was filed from them."""
    r = _reply(con, jid, mail_id)
    return {"id": r["id"], "from": r["counterpart"], "name": r["counterpart_name"] or "", "subject": r["subject"], "ts": r["ts"], "body": r["body"] or "",
            "files": [a["saved"] for a in json.loads(r["attachments"] or "[]") if a.get("saved")]}


def reply_done(con, jid, mail_id, how):
    """Closes a reply once the press has saved through the page's own route, or when there was nothing to mark. It can only say what the
    reply offered. Pressed twice, or from two tabs: the second does nothing."""
    r = _reply(con, jid, mail_id)
    o = json.loads(r["proposal"])
    if how not in WORDS_DONE or how != "cleared" and how not in o.get("reader", []):
        raise ValueError("That reply can't be marked that way.")
    if o.get("closed"):
        return {"ok": True}
    o["closed"] = {"how": how, "at": now(), "by": dashist.who_now()}
    con.execute("UPDATE das_mail SET status=?, result=?, proposal=? WHERE id=?", ("held" if r["status"] == "held" else "applied",
                f"{r['result'] or ''} · {WORDS_DONE[how]}", json.dumps(o), r["id"]))
    con.commit()
    das.note(con, jid, f"Reply from {r['counterpart']} of {o['date']}: {WORDS_DONE[how]}")
    return {"ok": True}


# ---------------------------------------------------------------- checking a mailbox

def check(con, data_dir, login, imap_factory=None):
    """Read the login's new tagged mail and file each message. Returns {"new", "filed": [...], "error"}."""
    a = account(data_dir, login, with_password=True)
    if not a:
        return {"new": 0, "filed": [], "error": "no mailbox connected"}
    folder = a.get("folder") or "INBOX"
    st = con.execute("SELECT * FROM das_mail_state WHERE login=? AND folder=?", (login, folder)).fetchone()
    try:
        got = mailbox.fetch_tagged(a, folder, (st["last_uid"] if st else 0) or 0, st["uidvalidity"] if st else None, imap_factory=imap_factory)
    except Exception as e:
        err = mailbox.friendly(e)
        con.execute("INSERT OR REPLACE INTO das_mail_state VALUES(?,?,?,?,?,?)", (login, folder, st["uidvalidity"] if st else None,
                    st["last_uid"] if st else 0, now(), err))
        con.commit()
        return {"new": 0, "filed": [], "error": err}
    filed = []
    for m in got["messages"]:
        if m["from"] == (a.get("address") or "").lower():
            continue  # our own sent copy (a Sent folder picked, or a cc to self)
        r = route(con, login, m)
        if r["status"] != "seen":
            filed.append({"subject": m["subject"], "from": m["from"], **r})
    con.execute("INSERT OR REPLACE INTO das_mail_state VALUES(?,?,?,?,?,?)",
                (login, folder, str(got["uidvalidity"]) if got["uidvalidity"] is not None else None, got["last_uid"], now(), None))
    con.commit()
    return {"new": len(filed), "filed": filed, "error": None}


def state(con, login):
    r = con.execute("SELECT * FROM das_mail_state WHERE login=? ORDER BY last_check DESC", (login,)).fetchone()
    return dict(r) if r else None


ROLE_LABEL = {"ahj": "AHJ / fire marshal", "owner": "Building owner", "agency": "Radio system owner", "gc": "General contractor",
              "sub": "Subcontractor", "tech": "Our technician"}


def people(con, login, job_id=None):
    """Who can be picked as a recipient (Cody 11/4: pick from RF Recon's contacts, not type addresses): the job's people
    by role first, then every contact and supplier with an email, then anyone who replied by mail and isn't saved yet."""
    out, seen = [], set()

    def add(email, name, org="", role="", source=""):
        e = mailbox.clean_address(email).lower()
        if not e or "@" not in e or e in seen:
            return
        seen.add(e)
        out.append({"email": e, "name": (name or "").strip(), "org": (org or "").strip(), "role": role, "source": source})

    contacts = {str(c["id"]): c for c in das.list_contacts(con)}
    if job_id is not None:
        j = das.job_row(con, int(job_id))
        for role, cid in (((j or {}).get("data") or {}).get("contacts") or {}).items():
            c = contacts.get(str(cid))
            if c and c.get("email"):
                add(c["email"], c["name"], c["org"], ROLE_LABEL.get(role, role), "job")
    for c in contacts.values():
        if c.get("email"):
            add(c["email"], c["name"], c["org"], c.get("role") or "", "contact")
    try:
        for s in con.execute("SELECT name, email FROM das_supplier WHERE email IS NOT NULL AND email <> '' ORDER BY name"):
            add(s["email"], "", s["name"], "Supplier", "supplier")
    except Exception:
        pass  # a copy without the supplier table yet
    q = "SELECT counterpart, MAX(COALESCE(counterpart_name, '')) n, MAX(job_id) j FROM das_mail WHERE login=? AND direction='in'"
    args = [login]
    if job_id is not None:
        q += " AND job_id=?"
        args.append(int(job_id))
    try:
        for r in con.execute(q + " GROUP BY counterpart ORDER BY MAX(ts) DESC LIMIT 50", args):
            add(r["counterpart"], r["n"], "", "Replied by email", "replied")
    except Exception:
        pass  # before the counterpart_name column (das.migrate adds it)
    return out


def threads(con, login, tag=None, job_id=None, rfq_id=None, prospect_id=None, limit=200):
    where, args = ["login=?"], [login]
    for col, v in (("tag", tag), ("job_id", job_id), ("rfq_id", rfq_id), ("prospect_id", prospect_id)):
        if v is not None:
            where.append(f"{col}=?")
            args.append(v)
    rows = con.execute(f"SELECT * FROM das_mail WHERE {' AND '.join(where)} ORDER BY ts DESC, id DESC LIMIT ?", args + [int(limit)]).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["attachments"] = json.loads(d["attachments"] or "[]")
        d["proposal"] = json.loads(d["proposal"]) if d.get("proposal") else None
        out.append(d)
    return out
