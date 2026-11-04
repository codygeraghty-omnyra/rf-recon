"""
RF Recon's link to a person's own mailbox (Cody 11/4: send and receive from inside RF Recon, agnostic of the mail
provider, least set-up). IMAP to read, SMTP to send, with an app password the person makes at their provider. Each
login has its own mailbox (kept in the key store, never in a database or returned to the page).

What it reads: only messages whose subject carries an RF Recon tag "[RFR ...]" (IMAP SEARCH SUBJECT), in the inbox
or a folder/label the person picks; BODY.PEEK, so nothing is marked read; by UID, so nothing is read twice.
What it sends: only what the person presses Send on, from their own address; a copy goes to their Sent folder when
the provider doesn't keep one itself (Gmail does), so it shows in their mail app on phone, tablet and PC.

Standard library only. The IMAP/SMTP connections are made by factories so the tests run against fakes.
"""
import email
import email.policy
import email.utils
import html as _html
import imaplib
import json
import os
import re
import smtplib
import ssl
import time
import urllib.parse
import urllib.request
from email.message import EmailMessage

TAG_RE = re.compile(r"\[RFR ([^\]]{1,60})\]")
MAX_ATTACH = 25 * 1024 * 1024

# provider by address domain: imap host, port, smtp host, port, "ssl" | "starttls", keeps sent mail itself, note
PRESETS = {
    "gmail": ("imap.gmail.com", 993, "smtp.gmail.com", 465, "ssl", True,
              "Gmail / Google Workspace: turn on 2-Step Verification, then make an app password (myaccount.google.com › Security › App passwords). A Workspace admin can switch app passwords off."),
    "yahoo": ("imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 465, "ssl", True,
              "Yahoo: Account security › Generate app password."),
    "aol": ("imap.aol.com", 993, "smtp.aol.com", 465, "ssl", True, "AOL: Account security › Generate app password."),
    "icloud": ("imap.mail.me.com", 993, "smtp.mail.me.com", 587, "starttls", False,
               "iCloud: appleid.apple.com › Sign-In and Security › App-Specific Passwords. Use your @icloud.com address to sign in."),
    "zoho": ("imap.zoho.com", 993, "smtp.zoho.com", 465, "ssl", False, "Zoho: My Account › Security › App Passwords (IMAP must be on in Mail settings)."),
    "fastmail": ("imap.fastmail.com", 993, "smtp.fastmail.com", 465, "ssl", False, "Fastmail: Settings › Privacy & Security › App passwords."),
    "gmx": ("imap.gmx.com", 993, "mail.gmx.com", 587, "starttls", False, "GMX: turn on IMAP/POP in settings; your normal password or an app password."),
    "microsoft": (None, None, None, None, None, False,
                  "Outlook.com and Microsoft 365 no longer accept app passwords for mail: they need Microsoft's own sign-in, which RF Recon doesn't have yet. Forward tagged replies to a mailbox that does, or use Open in my mail."),
}
DOMAINS = {"gmail.com": "gmail", "googlemail.com": "gmail", "yahoo.com": "yahoo", "ymail.com": "yahoo", "aol.com": "aol",
           "icloud.com": "icloud", "me.com": "icloud", "mac.com": "icloud", "zoho.com": "zoho", "zohomail.com": "zoho",
           "fastmail.com": "fastmail", "fastmail.fm": "fastmail", "gmx.com": "gmx", "gmx.us": "gmx",
           "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft"}
MX_HINTS = [("google.com", "gmail"), ("googlemail.com", "gmail"), ("outlook.com", "microsoft"), ("office365", "microsoft"),
            ("yahoodns", "yahoo"), ("zoho", "zoho"), ("messagingengine.com", "fastmail"), ("icloud.com", "icloud"),
            ("me.com", "icloud"), ("gmx", "gmx")]


def mx_hosts(domain, fetch=None):
    """The domain's mail servers, by DNS over HTTPS (the standard library has no MX lookup)."""
    url = f"https://dns.google/resolve?name={urllib.parse.quote(domain)}&type=MX"
    try:
        raw = fetch(url) if fetch else urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "RF-Recon/2.0"}), timeout=10).read()
        return [a.get("data", "").split()[-1].rstrip(".").lower() for a in json.loads(raw).get("Answer") or [] if a.get("type") == 15]
    except Exception:
        return []


def guess(address, fetch=None):
    """{provider, imap_host, imap_port, smtp_host, smtp_port, smtp_mode, saves_sent, how} for an address; a custom
    domain (a company's own) is recognised by its MX records (Google Workspace, Microsoft 365, Zoho...)."""
    dom = (address or "").rsplit("@", 1)[-1].strip().lower()
    key = DOMAINS.get(dom)
    if not key and dom:
        for host in mx_hosts(dom, fetch):
            key = next((k for hint, k in MX_HINTS if hint in host), None)
            if key:
                break
    if not key:
        return {"provider": "other", "imap_host": f"imap.{dom}" if dom else "", "imap_port": 993, "smtp_host": f"smtp.{dom}" if dom else "",
                "smtp_port": 465, "smtp_mode": "ssl", "saves_sent": False,
                "how": "Your provider's IMAP and SMTP settings and an app password (or your mail password if it allows IMAP)."}
    ih, ip, sh, sp, mode, saves, how = PRESETS[key]
    return {"provider": key, "imap_host": ih, "imap_port": ip, "smtp_host": sh, "smtp_port": sp, "smtp_mode": mode,
            "saves_sent": saves, "how": how}


# ---------------------------------------------------------------- connections (factories, so tests use fakes)

def _ctx():
    return ssl.create_default_context()


def _fake(kind):
    """Test copies only: RF_RECON_MAIL_FAKE=<folder> makes a mailbox of a folder (tests/fake_mail.py)."""
    root = os.environ.get("RF_RECON_MAIL_FAKE")
    if not root:
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location("fake_mail", os.path.join(os.path.dirname(os.path.abspath(__file__)), "tests", "fake_mail.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return lambda acct: (mod.IMAP if kind == "imap" else mod.SMTP)(root)


def imap_connect(acct, factory=None):
    factory = factory or _fake("imap")
    if factory:
        m = factory(acct)
    else:
        m = imaplib.IMAP4_SSL(acct["imap_host"], int(acct.get("imap_port") or 993), ssl_context=_ctx(), timeout=30)
    m.login(acct["user"], acct["password"])
    return m


def smtp_connect(acct, factory=None):
    factory = factory or _fake("smtp")
    if factory:
        s = factory(acct)
    elif (acct.get("smtp_mode") or "ssl") == "starttls":
        s = smtplib.SMTP(acct["smtp_host"], int(acct.get("smtp_port") or 587), timeout=30)
        s.starttls(context=_ctx())
    else:
        s = smtplib.SMTP_SSL(acct["smtp_host"], int(acct.get("smtp_port") or 465), context=_ctx(), timeout=30)
    s.login(acct["user"], acct["password"])
    return s


def friendly(e):
    """A connection error in words a person can act on."""
    t = str(e)
    if isinstance(e, (imaplib.IMAP4.error, smtplib.SMTPAuthenticationError)) or re.search(r"AUTHENTICATIONFAILED|Invalid credentials|535|534|authentication", t, re.I):
        return "The mailbox refused the sign-in: check the address and use an app password (your normal password usually won't work)."
    if re.search(r"getaddrinfo|Name or service|nodename", t):
        return "That mail server name doesn't exist: check the IMAP/SMTP host."
    if re.search(r"timed out|timeout", t, re.I):
        return "The mail server didn't answer in time."
    return t[:200] or type(e).__name__


def test(acct, imap_factory=None, smtp_factory=None):
    """Sign in to both sides; returns {"imap": None|error, "smtp": None|error, "folders": [...]}."""
    out = {"imap": None, "smtp": None, "folders": []}
    try:
        m = imap_connect(acct, imap_factory)
        try:
            out["folders"] = folders(m)
        finally:
            _bye(m)
    except Exception as e:
        out["imap"] = friendly(e)
    try:
        s = smtp_connect(acct, smtp_factory)
        _quit(s)
    except Exception as e:
        out["smtp"] = friendly(e)
    return out


def _bye(m):
    try:
        m.logout()
    except Exception:
        pass  # already gone: nothing to close


def _quit(s):
    try:
        s.quit()
    except Exception:
        pass  # already gone: nothing to close


_LIST_RE = re.compile(r'\((?P<flags>[^)]*)\) "(?P<sep>[^"]*)" (?P<name>.+)')


def folders(m):
    """[{name, flags}] from IMAP LIST (RFC 6154 special-use flags such as \\Sent when the server gives them)."""
    typ, data = m.list()
    out = []
    for raw in data or []:
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        mo = _LIST_RE.match(line)
        if mo:
            out.append({"name": mo.group("name").strip().strip('"'), "flags": mo.group("flags")})
    return out


def sent_folder(m):
    fs = folders(m)
    for f in fs:
        if "\\Sent" in f["flags"]:
            return f["name"]
    for name in ("Sent", "Sent Messages", "Sent Items", "INBOX.Sent", "[Gmail]/Sent Mail"):
        if any(f["name"] == name for f in fs):
            return name
    return None


# ---------------------------------------------------------------- sending

def build(acct, to, subject, text, html=None, attachments=(), in_reply_to=None, references=None, cc=None):
    msg = EmailMessage()
    msg["From"] = email.utils.formataddr((acct.get("name") or "", acct["address"]))
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=acct["address"].rsplit("@", 1)[-1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = references or in_reply_to
    msg["X-Mailer"] = "RF Recon"
    msg.set_content(text or "")
    if html:
        msg.add_alternative(html, subtype="html")
    total = 0
    for name, data, ctype in attachments:
        total += len(data)
        if total > MAX_ATTACH:
            raise ValueError("The attachments are over 25 MB together: most mail servers refuse that.")
        main, _, sub = (ctype or "application/octet-stream").partition("/")
        msg.add_attachment(data, maintype=main, subtype=sub or "octet-stream", filename=name)
    return msg


def send(acct, msg, imap_factory=None, smtp_factory=None):
    """Send through the person's SMTP; then file a copy in their Sent folder unless the provider keeps one itself.
    Returns {"message_id", "sent_copy": True|False|None}."""
    s = smtp_connect(acct, smtp_factory)
    try:
        s.send_message(msg)
    finally:
        _quit(s)
    copied = None
    if not acct.get("saves_sent"):
        try:
            m = imap_connect(acct, imap_factory)
            try:
                box = sent_folder(m)
                if box:
                    m.append(_q(box), "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
                    copied = True
                else:
                    copied = False
            finally:
                _bye(m)
        except Exception:
            copied = False  # sent; only the copy in Sent failed
    return {"message_id": msg["Message-ID"], "sent_copy": copied}


def _q(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


# ---------------------------------------------------------------- reading

def fetch_tagged(acct, folder="INBOX", after_uid=0, uidvalidity=None, imap_factory=None, limit=200):
    """New messages carrying an RF Recon tag in the folder, after after_uid (a changed UIDVALIDITY starts over).
    Returns {"uidvalidity", "last_uid", "messages": [parsed...]}. Read with BODY.PEEK: nothing is marked read."""
    m = imap_connect(acct, imap_factory)
    try:
        typ, data = m.select(_q(folder or "INBOX"), readonly=True)
        if typ != "OK":
            raise ValueError(f"No folder called {folder!r} in this mailbox.")
        uv = _uidvalidity(m)
        start = int(after_uid or 0) if (uidvalidity is None or str(uv) == str(uidvalidity)) else 0
        typ, data = m.uid("SEARCH", None, "SUBJECT", '"[RFR "')
        uids = sorted(int(x) for x in (data[0] or b"").split() if int(x) > start)[:limit]
        out = []
        for uid in uids:
            typ, parts = m.uid("FETCH", str(uid), "(BODY.PEEK[])")
            raw = next((p[1] for p in parts or [] if isinstance(p, tuple) and len(p) > 1), None)
            if raw:
                pm = parse(raw)
                pm["uid"] = uid
                if pm["tags"]:
                    out.append(pm)
        return {"uidvalidity": uv, "last_uid": max(uids) if uids else start, "messages": out}
    finally:
        _bye(m)


def _uidvalidity(m):
    try:
        typ, data = m.response("UIDVALIDITY")
        if data and data[0]:
            return int(data[0])
    except Exception:
        pass  # the server didn't say: treat as unchanged
    return None


def _text(part):
    try:
        return part.get_content()
    except Exception:
        return (part.get_payload(decode=True) or b"").decode(part.get_content_charset() or "utf-8", "replace")


def html_to_text(h):
    h = re.sub(r"(?is)<(script|style).*?</\1>", " ", h or "")
    h = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", h)
    h = re.sub(r"(?i)</t[dh]>", "\t", h)
    return re.sub(r"[ \t]+\n", "\n", _html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def strip_quoted(text):
    """The new part of a reply: up to the "On ... wrote:" line or the first quoted block."""
    lines = (text or "").splitlines()
    out = []
    for ln in lines:
        if re.match(r"^\s*On .{5,200} wrote:\s*$", ln) or re.match(r"^-{2,}\s*Original Message", ln, re.I) or re.match(r"^From: .+", ln) and out:
            break
        if ln.startswith(">"):
            continue
        out.append(ln)
    return "\n".join(out).strip()


def parse(raw):
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    text, html_body, atts = "", "", []
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        fname = part.get_filename()
        if fname or disp == "attachment":
            data = part.get_payload(decode=True) or b""
            if len(data) <= MAX_ATTACH:
                atts.append({"name": fname or "attachment", "type": part.get_content_type(), "data": data})
        elif part.get_content_type() == "text/plain" and not text:
            text = _text(part)
        elif part.get_content_type() == "text/html" and not html_body:
            html_body = _text(part)
    if not text and html_body:
        text = html_to_text(html_body)
    subject = str(msg.get("Subject") or "")
    return {"message_id": str(msg.get("Message-ID") or "").strip(), "in_reply_to": str(msg.get("In-Reply-To") or "").strip(),
            "references": str(msg.get("References") or "").strip(), "from": email.utils.parseaddr(str(msg.get("From") or ""))[1].lower(),
            "from_name": email.utils.parseaddr(str(msg.get("From") or ""))[0], "to": str(msg.get("To") or ""),
            "subject": subject, "date": str(msg.get("Date") or ""), "text": text, "new_text": strip_quoted(text),
            "attachments": atts, "tags": TAG_RE.findall(subject)}
