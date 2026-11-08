"""
DAStastic sends for you (Cody 11/8, Josh approved): job email through Amazon SES for a person who can't connect their own
mailbox. Microsoft 365 and Outlook take no app passwords for mail any more (Andy's mobili-fi.com is Microsoft 365), and a
Google Workspace admin can switch app passwords off.

How one email goes:
- From "<their name> via DAStastic" <noreply@omnyra.ai> (the server's from_address; Cody 11/8: the client sites'
  sender, verified in SES with DKIM), sent through SES's SMTP door with SMTP credentials made from the mailer's key.
- Reply-To: the person's own address, then DAStastic's reply address for that login (r.<token>@dastastic.omnyra.ai). A reply sent to the From
  instead goes to omnyra.ai's own mail, as with the client sites (a From on the reply domain would file it: _sender_of).
  A reply reaches the person's inbox and DAStastic, which files it on the job by the [RFR ...] tag in the subject, the same
  way a reply read from a mailbox is filed (dasmail.route).
- Bcc the person, so every email they send is in their own inbox too.
- Prospect first emails don't go this way unless the server's settings say so: they are cold email, and a run of bounces
  or complaints pauses SES for every domain the AWS account sends for.

How a reply comes back: SES receives mail for the reply domain, dastastic.omnyra.ai (an MX record), scans it for spam and viruses, and writes
it to an S3 bucket under the prefix. check() reads the bucket every 5 minutes (app.py mail_loop) with a SigV4-signed
request, drops what failed the scan, isn't for a known login's reply address or carries no tag, files the rest, sends the
person a copy when the reply didn't already go to them, and deletes each message it has handled.

The settings are a sealed file beside the keys (keystore kind "ses"), written on the server by ops/ses_setup.py: the
mailer's key never passes through a page, a log or this PC's disk. public() is all the page sees.

Test copies (RF_RECON_MAIL_FAKE=<folder>): sending writes to <folder>/outbox like the mailbox fake, and the bucket is
<folder>/ses-in/*.eml. Standard library only.
"""
import base64
import datetime
import email
import email.policy
import email.utils
import hashlib
import hmac
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import dasmail
import keystore
import mailbox

KIND = "ses"
NEEDED = ("access_key_id", "secret_access_key", "from_address", "reply_domain", "bucket")
MAX_RAW = 40 * 1024 * 1024  # SES receives messages up to 40 MB
STATE_LOGIN = "DAStastic"   # das_mail_state row for the bucket's last check
VIA_NAME = "via DAStastic"


# ---------------------------------------------------------------- settings

def _clean(c):
    c = dict(c or {})
    c.setdefault("region", "us-east-1")
    c.setdefault("prefix", "in/")
    return c


def config(data_dir):
    """The server's SES settings, or None when they aren't all there."""
    c = _clean(keystore.load(data_dir, KIND))
    return c if all(c.get(k) for k in NEEDED) else None


def save_config(data_dir, c):
    """Write the settings (ops/ses_setup.py, on the server). A reply salt is made once and kept: it names each login's reply
    address, so changing it would orphan the replies to every email already sent."""
    old = keystore.load(data_dir, KIND) or {}
    c = _clean(dict(old, **{k: v for k, v in (c or {}).items() if v not in (None, "")}))
    c["reply_salt"] = old.get("reply_salt") or c.get("reply_salt") or secrets.token_hex(16)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", c.get("bucket") or ""):
        raise ValueError("The bucket name must be lower-case letters, digits and hyphens (no dots: the address is checked by TLS).")
    for k in ("from_address",):
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,24}", c.get(k) or ""):
            raise ValueError(f"{k} isn't an email address.")
    if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,24}", c.get("reply_domain") or ""):
        raise ValueError("reply_domain isn't a domain.")
    keystore.save(data_dir, c, KIND)
    return public_of(c)


def public_of(c):
    c = c or {}
    return {"ready": all(c.get(k) for k in NEEDED), "from": c.get("from_address") or "", "reply_domain": c.get("reply_domain") or "",
            "prospects": bool(c.get("prospects"))}


def public(data_dir):
    """What the page may know: whether it's ready, the From address, and whether prospect emails may use it. Never a key."""
    return public_of(config(data_dir))


# ---------------------------------------------------------------- SES SMTP credentials and SigV4

def smtp_password(secret_access_key, region):
    """The SES SMTP password for an IAM key, as AWS documents it (version 4): HMAC-SHA256 down a fixed date, the region,
    "ses", "aws4_request" and "SendRawEmail", with the version byte 0x04 in front, base64."""
    sig = ("AWS4" + secret_access_key).encode()
    for part in ("11111111", region, "ses", "aws4_request", "SendRawEmail"):
        sig = hmac.new(sig, part.encode(), hashlib.sha256).digest()
    return base64.b64encode(bytes([0x04]) + sig).decode()


def smtp_account(c):
    acct = {"smtp_host": f"email-smtp.{c['region']}.amazonaws.com", "smtp_port": 465, "smtp_mode": "ssl",
            "user": c["access_key_id"], "password": smtp_password(c["secret_access_key"], c["region"])}
    if os.environ.get("RF_RECON_MAIL_FAKE"):
        acct["password"] = "app-pw"  # test copies only: the folder mailbox signs in with this (tests/fake_mail.py)
    return acct


def _enc(s):
    return urllib.parse.quote(str(s), safe="-_.~")


def sign(method, url, region, service, key_id, secret, payload=b"", headers=None, now=None):
    """AWS Signature Version 4 headers for one request (host, x-amz-date, and x-amz-content-sha256 for S3, then
    Authorization). The URL's path must already be encoded as it is sent."""
    u = urllib.parse.urlsplit(url)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz = now.strftime("%Y%m%dT%H%M%SZ")
    day = amz[:8]
    ph = hashlib.sha256(payload or b"").hexdigest()
    h = {k.lower(): " ".join(str(v).split()) for k, v in (headers or {}).items()}
    h["host"], h["x-amz-date"] = u.netloc, amz
    if service == "s3":
        h["x-amz-content-sha256"] = ph
    names = sorted(h)
    query = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True)))
    creq = "\n".join([method, u.path or "/", query, "".join(f"{k}:{h[k]}\n" for k in names), ";".join(names), ph])
    scope = f"{day}/{region}/{service}/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(creq.encode()).hexdigest()])
    k = ("AWS4" + secret).encode()
    for part in (day, region, service, "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    h["authorization"] = (f"AWS4-HMAC-SHA256 Credential={key_id}/{scope}, SignedHeaders={';'.join(names)}, "
                          f"Signature={hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()}")
    return h


# ---------------------------------------------------------------- sending

def token(c, login):
    d = hmac.new(c["reply_salt"].encode(), (login or "local").encode(), hashlib.sha256).digest()
    return base64.b32encode(d).decode()[:12].lower()


def reply_address(c, login):
    return f"r.{token(c, login)}@{c['reply_domain']}"


def build(c, login, person, to, subject, text, attachments=(), in_reply_to=None, cc=None):
    """One email from DAStastic for a person: From "<name> via DAStastic", Reply-To them and DAStastic, Bcc them."""
    name = (person.get("name") or "").strip()
    msg = mailbox.build({"name": f"{name} {VIA_NAME}" if name else "DAStastic", "address": c["from_address"]}, to, subject, text,
                        attachments=attachments, in_reply_to=in_reply_to, cc=cc)
    msg["Reply-To"] = ", ".join([email.utils.formataddr((name, person["address"])),
                                 email.utils.formataddr(("DAStastic (files your reply)", reply_address(c, login)))])
    msg["Bcc"] = person["address"]
    if c.get("configuration_set"):
        msg["X-SES-CONFIGURATION-SET"] = c["configuration_set"]
    return msg


def send(c, msg, smtp_factory=None):
    """Send through SES's SMTP door. smtplib sends the Bcc and leaves its header off what the recipients get."""
    s = mailbox.smtp_connect(smtp_account(c), smtp_factory)
    try:
        s.send_message(msg)
    finally:
        mailbox._quit(s)
    return {"message_id": msg["Message-ID"], "sent_copy": "bcc"}


# ---------------------------------------------------------------- the reply bucket

def _http(method, url, headers, body=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(MAX_RAW + 1)
    except urllib.error.HTTPError as e:
        return e.code, e.read(4096)


def _fake_fetch(root):
    """Test copies: the bucket is <root>/ses-in, answering the same REST shapes S3 does."""
    box = os.path.join(root, "ses-in")
    os.makedirs(box, exist_ok=True)

    def fetch(method, url, headers, body=None):
        u = urllib.parse.urlsplit(url)
        key = urllib.parse.unquote(u.path.lstrip("/"))
        if method == "GET" and not key:
            q = dict(urllib.parse.parse_qsl(u.query))
            pre = q.get("prefix", "")
            keys = sorted(f for f in os.listdir(box) if f.endswith(".eml"))
            items = "".join(f"<Contents><Key>{pre}{f}</Key><Size>{os.path.getsize(os.path.join(box, f))}</Size></Contents>" for f in keys)
            return 200, f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{items}</ListBucketResult>'.encode()
        name = os.path.basename(key)
        p = os.path.join(box, name)
        if not os.path.isfile(p):
            return 404, b"<Error><Code>NoSuchKey</Code></Error>"
        if method == "GET":
            with open(p, "rb") as fh:
                return 200, fh.read()
        if method == "DELETE":
            os.remove(p)
            return 204, b""
        return 405, b""
    return fetch


def _fetcher(fetch):
    if fetch:
        return fetch
    root = os.environ.get("RF_RECON_MAIL_FAKE")
    return _fake_fetch(root) if root else _http


def _s3(c, method, key="", query=None, fetch=None):
    path = "/" + urllib.parse.quote(key, safe="/-_.~")
    qs = "&".join(f"{_enc(k)}={_enc(v)}" for k, v in sorted((query or {}).items()))
    url = f"https://{c['bucket']}.s3.{c['region']}.amazonaws.com{path}" + (f"?{qs}" if qs else "")
    h = sign(method, url, c["region"], "s3", c["access_key_id"], c["secret_access_key"])
    return _fetcher(fetch)(method, url, h)


def list_keys(c, fetch=None, limit=50):
    st, body = _s3(c, "GET", query={"list-type": "2", "prefix": c["prefix"], "max-keys": str(limit)}, fetch=fetch)
    if st != 200:
        raise RuntimeError(f"the reply bucket answered {st} to a list")
    ns = {"s": "http://s3.amazonaws.com/doc/2006-03-01/"}
    root = ET.fromstring(body)
    return [(e.findtext("s:Key", namespaces=ns), int(e.findtext("s:Size", "0", namespaces=ns) or 0)) for e in root.findall("s:Contents", ns)]


def get(c, key, fetch=None):
    st, body = _s3(c, "GET", key, fetch=fetch)
    if st != 200:
        raise RuntimeError(f"the reply bucket answered {st} to a read")
    return body


def delete(c, key, fetch=None):
    st, _ = _s3(c, "DELETE", key, fetch=fetch)
    if st not in (200, 204):
        raise RuntimeError(f"the reply bucket answered {st} to a delete")


# ---------------------------------------------------------------- filing the replies

def people(data_dir):
    """Each login that has DAStastic send for it: {login: account}."""
    out = {}
    for login in dasmail.logins(data_dir):
        a = dasmail.account(data_dir, login)
        if a and a.get("via") == "dastastic":
            out[login] = a
    return out


def _recipients(em):
    got = email.utils.getaddresses([str(v) for h in ("To", "Cc", "Delivered-To", "X-Original-To") for v in em.get_all(h, [])])
    for v in em.get_all("Received", []):  # the envelope recipient: "for <r.x@reply...>"
        got += [("", a) for a in re.findall(r"\bfor\s+<([^<>\s]+@[^<>\s]+)>", str(v))]
    return {a.lower() for _, a in got if "@" in a}


def check(con, data_dir, fetch=None, smtp_factory=None, limit=50):
    """Read the reply bucket once: file each tagged reply under the login its address names, send the person a copy when
    the reply didn't reach them, delete what was handled. Returns {"new", "filed", "dropped", "error"}."""
    c = config(data_dir)
    if not c:
        return {"new": 0, "filed": [], "dropped": [], "error": "DAStastic's own sending isn't set up on this server."}
    ppl = people(data_dir)
    by_addr = {reply_address(c, login).lower(): login for login in ppl}
    filed, dropped, err = [], [], None
    try:
        keys = list_keys(c, fetch, limit)
    except Exception as e:
        keys, err = [], f"{type(e).__name__}: {str(e)[:160]}"
    for key, size in keys:
        if not key or key.endswith("/") or key.endswith("AMAZON_SES_SETUP_NOTIFICATION"):
            if key and key.endswith("AMAZON_SES_SETUP_NOTIFICATION"):
                _quiet_delete(c, key, fetch)
            continue
        try:
            raw = get(c, key, fetch) if size <= MAX_RAW else b""
        except Exception as e:  # left in the bucket for the next check
            err = f"{type(e).__name__}: {str(e)[:160]}"
            continue
        why = None
        em = email.message_from_bytes(raw, policy=email.policy.default) if raw else None
        login = None
        if em is None:
            why = "too big or empty"
        elif any(str(em.get(h, "")).strip().upper() == "FAIL" for h in ("X-SES-Spam-Verdict", "X-SES-Virus-Verdict")):
            why = "failed SES's spam or virus scan"
        else:
            rcpt = _recipients(em)
            login = next((by_addr[a] for a in rcpt if a in by_addr), None)
            m = mailbox.parse(raw)
            if not login and c["from_address"].lower() in rcpt:  # answered to the From, not the Reply-To: whoever sent that tag
                login = _sender_of(con, m["tags"], ppl)
            if not login:
                why = "not to a DAStastic reply address in use"
            elif not m["tags"]:
                why = "no [RFR ...] tag in the subject"
            elif m["from"] in (c["from_address"].lower(), (ppl[login].get("address") or "").lower()):
                why = "sent by DAStastic or the person themselves"
            else:
                r = dasmail.route(con, login, m)
                if r["status"] != "seen":
                    filed.append({"login": login, "subject": m["subject"], "from": m["from"], **r})
                    if (ppl[login].get("address") or "").lower() not in rcpt:
                        try:
                            _copy_to_person(c, login, ppl[login], m, raw, r, smtp_factory)
                        except Exception as e:  # filed; only the copy failed
                            err = f"copy to {login}: {type(e).__name__}"
        if why:
            dropped.append({"key": key, "why": why})
        _quiet_delete(c, key, fetch)
    con.execute("INSERT OR REPLACE INTO das_mail_state VALUES(?,?,?,?,?,?)",
                (STATE_LOGIN, f"s3:{c['bucket']}", None, 0, dasmail.now(), err))
    con.commit()
    return {"new": len(filed), "filed": filed, "dropped": dropped, "error": err}


def _sender_of(con, tags, ppl):
    """A reply to the shared From address: the login DAStastic last sent that tag for (its own sending only)."""
    for t in tags:
        for r in con.execute("SELECT login FROM das_mail WHERE direction='out' AND tag=? ORDER BY id DESC", (t.strip(),)):
            if r["login"] in ppl:
                return r["login"]
    return None


def _quiet_delete(c, key, fetch):
    try:
        delete(c, key, fetch)
    except Exception:
        pass  # read again next time; filing is idempotent (dasmail.seen)


def _copy_to_person(c, login, person, m, raw, r, smtp_factory=None):
    """The reply came only to DAStastic (their mail app used just the second Reply-To): send the person a copy."""
    body = (f"A reply from {m['from_name'] or m['from']} <{m['from']}> came to DAStastic and was filed ({r['result']}).\n"
            f"The message is attached as it arrived.\n\n{m['new_text'] or m['text']}")
    msg = mailbox.build({"name": "DAStastic", "address": c["from_address"]}, person["address"], f"Fwd: {m['subject']}", body,
                        attachments=[("reply.eml", raw, "application/octet-stream")])
    msg["Reply-To"] = email.utils.formataddr((m["from_name"] or "", m["from"]))
    send(c, msg, smtp_factory)


def state(con, data_dir):
    c = config(data_dir)
    if not c:
        return None
    r = con.execute("SELECT * FROM das_mail_state WHERE login=? AND folder=?", (STATE_LOGIN, f"s3:{c['bucket']}")).fetchone()
    return dict(r) if r else None
