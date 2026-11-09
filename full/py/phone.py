"""
The Phone window (Cody 11/8, for the Mobili-Fi demo on 11/9): texts and calls from inside DAStastic, through Omnyra's
Twilio account and its Omnyra SDR Platform campaign (Omnyra AI brand, approved; Josh 10/05: texts Omnyra sends to staff
go through it; the service's id is in the server's settings, ops/phone_setup.py). Cody 11/8: "build it and add it to the Omnyra
SDR campaign for the demo", from the number the service already has.

How it works
- A text goes through the messaging service from the line (a number in the service's pool), so the campaign's
  registration covers it, and it starts with "<business> via Omnyra:" as Josh's rule for that campaign says.
- Texts and calls go only to the numbers on the server's demo list (allow). The campaign carries staff and demo traffic,
  never anyone's customers, and the line's other traffic never shows here: a thread with a number off the list isn't read.
- Threads and calls are read from Twilio's own logs for the line, read only. No webhook is changed, so the number keeps
  answering wherever it answers now.
- Calls go "via my cell": Twilio rings the person's cell from the line; when they answer it dials the other number with
  the line as caller ID (TwiML inline, so no page of ours has to answer Twilio). A PC needs no microphone. Their cell
  must be on the list too.
- The AI receptionist is shown, not set up (Cody: "not configured, just to show off for the demo"), and Email opens Gmail.

The settings are a sealed file beside the keys (keystore kind "phone"), written on the server by ops/phone_setup.py: the
Twilio key never passes through a page, a log or this PC's disk. public() is all the page sees.

Test copies (RF_RECON_PHONE_FAKE=<folder>, or RF_RECON_MAIL_FAKE's folder/phone): Twilio is a JSON file in the folder,
sends are added to it and nothing leaves the PC. Standard library only.
"""
import base64
import datetime
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape, quoteattr

import keystore

KIND = "phone"
NEEDED = ("account_sid", "key_sid", "key_secret", "service_sid", "line")
API = "https://api.twilio.com/2010-04-01"
MAX_TEXT = 640  # four segments: a demo text, not a newsletter
RING_S = 18     # how long the cell rings: under most carriers' voicemail, so a missed call isn't bridged into voicemail
CACHE_S = 5
_cache, _lock = {}, threading.Lock()


# ---------------------------------------------------------------- numbers

def e164(n):
    """+1XXXXXXXXXX for a US number however it's typed; another country's number kept as +digits; "" when it isn't one."""
    s = str(n or "").strip()
    d = re.sub(r"\D", "", s)
    if s.startswith("+") and 8 <= len(d) <= 15:
        return "+" + d
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return "+1" + d if len(d) == 10 and d[0] not in "01" else ""


def pretty(n):
    d = re.sub(r"\D", "", n or "")
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    return f"({d[:3]}) {d[3:6]}-{d[6:]}" if len(d) == 10 else (n or "")


# ---------------------------------------------------------------- settings

def _fake_root():
    root = os.environ.get("RF_RECON_PHONE_FAKE")
    if root:
        return root
    mail = os.environ.get("RF_RECON_MAIL_FAKE")
    return os.path.join(mail, "phone") if mail else None


FAKE_CONF = {"account_sid": "ACfake", "key_sid": "SKfake", "key_secret": "fake", "service_sid": "MG" + "0" * 32,
             "line": "+19105550142", "allow": ["+19105550101", "+19105550102", "+16125550123"]}


def _clean(c):
    c = dict(c or {})
    c["line"] = e164(c.get("line"))
    c["allow"] = sorted({e164(n) for n in (c.get("allow") or []) if e164(n)})
    c["cells"] = {k.lower(): e164(v) for k, v in (c.get("cells") or {}).items() if e164(v)}
    return c


def config(data_dir):
    """The copy's phone settings, or None when they aren't all there. The business texts are signed with is the
    settings' own, else the copy's licensee (licence.py), else DAStastic."""
    if _fake_root():
        saved = keystore.load(data_dir, KIND) or {}
        c = _clean(dict(FAKE_CONF, cells=saved.get("cells") or {}))
    else:
        c = _clean(keystore.load(data_dir, KIND))
        if not all(c.get(k) for k in NEEDED):
            return None
    if not c.get("business"):
        import licence
        c["business"] = (licence.load(data_dir) or {}).get("licensee") or "DAStastic"
    return c


def save_config(data_dir, c):
    """Write the settings (ops/phone_setup.py, on the server). What's given replaces what's there; the rest is kept."""
    old = keystore.load(data_dir, KIND) or {}
    c = _clean(dict(old, **{k: v for k, v in (c or {}).items() if v not in (None, "")}))
    if c.get("account_sid") and not re.fullmatch(r"AC[0-9a-f]{32}", c["account_sid"]):
        raise ValueError("account_sid isn't a Twilio account id (AC + 32 hex).")
    if c.get("key_sid") and not re.fullmatch(r"(SK|AC)[0-9a-f]{32}", c["key_sid"]):
        raise ValueError("key_sid isn't a Twilio API key id (SK + 32 hex).")
    if c.get("service_sid") and not re.fullmatch(r"MG[0-9a-f]{32}", c["service_sid"]):
        raise ValueError("service_sid isn't a messaging service id (MG + 32 hex).")
    if not c.get("line"):
        raise ValueError("line isn't a phone number.")
    keystore.save(data_dir, c, KIND)
    return public_of(c)


def public_of(c, login=None):
    """What the page may know: whether it's ready, the line, the demo list, the business name and the person's own cell.
    Never a key."""
    c = c or {}
    return {"ready": bool(c and all(c.get(k) for k in NEEDED)), "line": c.get("line") or "", "allow": c.get("allow") or [],
            "business": c.get("business") or "", "cell": (c.get("cells") or {}).get((login or "").lower(), ""),
            "fake": bool(_fake_root())}


def public(data_dir, login=None):
    return public_of(config(data_dir), login)


def set_cell(data_dir, login, cell):
    """The person's own cell, for calls via their cell. It has to be on the demo list: a call rings it."""
    c = config(data_dir)
    if not c:
        raise ValueError("The phone isn't set up on this copy.")
    n = e164(cell)
    if cell and not n:
        raise ValueError("That isn't a phone number.")
    if n and n not in c["allow"]:
        raise ValueError("That number isn't on this copy's demo list, so DAStastic won't ring it. Ask Cody to add it.")
    saved = keystore.load(data_dir, KIND) or {}
    cells = {k: v for k, v in (saved.get("cells") or {}).items() if k != (login or "").lower()}
    if n:
        cells[(login or "").lower()] = n
    keystore.save(data_dir, dict(saved, cells=cells), KIND)
    return n


# ---------------------------------------------------------------- Twilio

def _auth(c):
    return "Basic " + base64.b64encode(f"{c['key_sid']}:{c['key_secret']}".encode()).decode()


def _http(c, method, path, form=None, query=None):
    url = f"{API}/Accounts/{c['account_sid']}/{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, body, {"Authorization": _auth(c), "Accept": "application/json",
                                             **({"Content-Type": "application/x-www-form-urlencoded"} if body else {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read() or b"{}").get("message") or ""
        except ValueError:
            msg = ""
        raise RuntimeError(f"Twilio said no (HTTP {e.code}){': ' + msg if msg else ''}") from None
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"Twilio didn't answer: {getattr(e, 'reason', e)}") from None


class Fake:
    """Twilio as a JSON file (test copies and tests): {"messages": [...], "calls": [...]}, newest last."""

    def __init__(self, root):
        self.path = os.path.join(root, "twilio.json")
        os.makedirs(root, exist_ok=True)

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {"messages": [], "calls": []}

    def _save(self, d):
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(d, fh, indent=1)

    def __call__(self, c, method, path, form=None, query=None):
        d = self._load()
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
        if path == "Messages.json" and method == "POST":
            m = {"sid": f"SMfake{len(d['messages']):04d}", "from": form.get("From") or c["line"], "to": form["To"], "body": form["Body"],
                 "direction": "outbound-api", "status": "delivered", "date_created": now, "messaging_service_sid": form.get("MessagingServiceSid")}
            d["messages"].append(m)
            self._save(d)
            return m
        if path == "Calls.json" and method == "POST":
            k = {"sid": f"CAfake{len(d['calls']):04d}", "from": form["From"], "to": form["To"], "direction": "outbound-api",
                 "status": "queued", "duration": "0", "start_time": now, "date_created": now, "twiml": form.get("Twiml")}
            d["calls"].append(k)
            m = re.search(r"<Number>([^<]+)</Number>", form.get("Twiml") or "")
            if m:  # the leg Twilio dials once the cell answers
                d["calls"].append(dict(k, sid=k["sid"] + "d", to=m.group(1), direction="outbound-dial", parent_call_sid=k["sid"]))
            self._save(d)
            return k
        rows = d["messages" if path == "Messages.json" else "calls"]
        q = query or {}
        rows = [r for r in rows if (not q.get("To") or r["to"] == q["To"]) and (not q.get("From") or r["from"] == q["From"])]
        return {"messages" if path == "Messages.json" else "calls": list(reversed(rows))[: int(q.get("PageSize") or 50)]}


def _caller(fetch=None):
    if fetch:
        return fetch
    root = _fake_root()
    return Fake(root) if root else _http


def _when(s):
    """Twilio's RFC 2822 time as ISO 8601 UTC ("" when there's none)."""
    if not s:
        return ""
    try:
        return datetime.datetime.strptime(s, "%a, %d %b %Y %H:%M:%S %z").astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return ""


def _cached(key, make):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_S:
            return hit[1]
    v = make()
    with _lock:
        _cache[key] = (time.time(), v)
    return v


def forget():
    with _lock:
        _cache.clear()


def messages(c, fetch=None, most=100):
    """The line's texts with numbers on the demo list, newest first."""
    call = _caller(fetch)
    allow = set(c["allow"])

    def make():
        rows = {}
        for q in ({"To": c["line"]}, {"From": c["line"]}):
            for m in call(c, "GET", "Messages.json", query=dict(q, PageSize=most)).get("messages") or []:
                out = m.get("from") == c["line"]
                other = m.get("to") if out else m.get("from")
                if other in allow:
                    rows[m["sid"]] = {"sid": m["sid"], "other": other, "dir": "out" if out else "in", "body": m.get("body") or "",
                                      "status": m.get("status") or "", "at": _when(m.get("date_sent") or m.get("date_created")),
                                      "error": m.get("error_code") or None}
        return sorted(rows.values(), key=lambda r: r["at"], reverse=True)
    return _cached(("m", c["account_sid"], c["line"]), make)


def threads(c, fetch=None):
    """One row per number: the last text, how many came in since the last one sent."""
    out = {}
    for m in messages(c, fetch):
        t = out.setdefault(m["other"], {"other": m["other"], "last": m, "count": 0, "unread": 0, "_sent": False})
        t["count"] += 1
        if m["dir"] == "out":
            t["_sent"] = True
        elif not t["_sent"]:
            t["unread"] += 1
    for t in out.values():
        t.pop("_sent")
    return sorted(out.values(), key=lambda t: t["last"]["at"], reverse=True)


def thread(c, number, fetch=None):
    n = e164(number)
    return sorted((m for m in messages(c, fetch) if m["other"] == n), key=lambda m: m["at"])


def calls(c, fetch=None, most=50):
    """The line's calls with numbers on the demo list, newest first. A call via a cell is two legs: the leg to the
    person's own cell is the bridge (no parent), so the row is the leg to the other number (its child)."""
    call = _caller(fetch)
    allow, cells = set(c["allow"]), set((c.get("cells") or {}).values())

    def make():
        rows = {}
        for q in ({"To": c["line"]}, {"From": c["line"]}):
            for k in call(c, "GET", "Calls.json", query=dict(q, PageSize=most)).get("calls") or []:
                out = k.get("from") == c["line"]
                other = k.get("to") if out else k.get("from")
                if other not in allow or out and other in cells and not k.get("parent_call_sid"):
                    continue  # the leg that rang the person's own cell: the bridge, not the call
                st = k.get("status") or ""
                rows[k["sid"]] = {"sid": k["sid"], "other": other, "dir": "out" if out else "in",
                                  "status": "answered" if st == "completed" and int(k.get("duration") or 0) > 0 else
                                  ("missed" if not out and st in ("no-answer", "busy", "canceled", "failed") else st),
                                  "seconds": int(k.get("duration") or 0), "at": _when(k.get("start_time") or k.get("date_created"))}
        return sorted(rows.values(), key=lambda r: r["at"], reverse=True)
    return _cached(("c", c["account_sid"], c["line"]), make)


# ---------------------------------------------------------------- sending

def _check_to(c, to):
    n = e164(to)
    if not n:
        raise ValueError("That isn't a phone number.")
    if n not in c["allow"]:
        raise ValueError("That number isn't on this copy's demo list: the Omnyra SDR campaign carries staff and demo texts only. "
                         "Ask Cody to add it.")
    return n


def prefix(c):
    return f"{c.get('business') or 'DAStastic'} via Omnyra: "


def send_text(c, to, body, fetch=None):
    n = _check_to(c, to)
    body = (body or "").strip()
    if not body:
        raise ValueError("Nothing to send.")
    text = prefix(c) + body
    if len(text) > MAX_TEXT:
        raise ValueError(f"That's too long for a text ({len(text)} characters; {MAX_TEXT} at most).")
    m = _caller(fetch)(c, "POST", "Messages.json", form={"To": n, "From": c["line"], "MessagingServiceSid": c["service_sid"], "Body": text})
    forget()
    return {"sid": m.get("sid"), "status": m.get("status"), "to": n}


def call_twiml(c, to):
    """What Twilio does when the person answers their cell: says who it's calling, then dials with the line as caller ID."""
    say = f"DAStastic call to {' '.join(re.sub(r'[^0-9]', '', to)[-10:])}. Connecting."
    return (f'<Response><Say voice="Polly.Joanna">{escape(say)}</Say>'
            f'<Dial callerId={quoteattr(c["line"])} timeout="30" answerOnBridge="true"><Number>{escape(to)}</Number></Dial></Response>')


def call_via_cell(c, login, to, fetch=None):
    n = _check_to(c, to)
    cell = (c.get("cells") or {}).get((login or "").lower())
    if not cell:
        raise ValueError("Save your cell first (Keypad): Twilio rings it, then dials the number.")
    if cell == n:
        raise ValueError("That's your own cell.")
    k = _caller(fetch)(c, "POST", "Calls.json", form={"To": cell, "From": c["line"], "Twiml": call_twiml(c, n), "Timeout": RING_S})
    forget()
    return {"sid": k.get("sid"), "status": k.get("status"), "cell": cell, "to": n}
