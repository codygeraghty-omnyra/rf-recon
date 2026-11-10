"""
Remote access: other people use the full PC version from anywhere. Tailscale Funnel publishes a public https link
that forwards to a second port on this PC (127.0.0.1:8790); everything arriving there must be signed in, and each
login has a role (below). Cody's own copy on localhost:8765 is untouched.

Logins live in DATA_DIR/remote_users.json as salted PBKDF2 hashes. Cody adds a person in Data & updates and the
password is shown once, for him to pass on. A session is a signed cookie tied to the login's salt, so removing a
person or giving them a new password ends their sessions at once.

A view login can't reach anything that writes (every POST) except leaving a note for Cody (notes.py: their own,
size-capped); full logins write too. Neither reaches the BLOCKED parts: the keys and update settings, TAK settings,
the field-pack folders, or the Signal ID Wiki catalog. An admin login is the owner and reaches everything.
The DAS course (course.py) is per login: the admin ticks who has it, and a view login may save its own progress there.
Ships come only from what is already streaming: their looks never start the stream on Cody's aisstream key.

On the 24/7 server (RF_RECON_PUBLIC_URL set, 11/2) this door is the only way in: the server's own https front forwards
to it, there is no Tailscale, and each login has a role. View: as above. Full: everything except the BLOCKED parts
(keys, updates, the kit, people). Admin (Cody): everything. The first admin is made on the server itself:
  python3 remote.py add "Cody" --role admin      (prints the password once)
"""
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = 8790
SESSION_S = 14 * 86400
COOKIE = "rfr_session"
LOCK_AFTER, LOCK_S = 8, 15 * 60  # wrong passwords per name before a 15-minute lock

BLOCKED = ("/api/settings", "/api/update/", "/api/tak/", "/api/fieldpack", "/api/net/", "/api/sigwiki/", "/api/artemis/", "/api/crowd/", "/api/remote", "/api/kit")
EMPTY = {"/api/sigwiki/match": {"candidates": []}, "/api/sigwiki/range": {"signals": []}}  # answered empty so pages carry on
OPEN = ("/static/theme/", "/remote/")  # the sign-in page's own look
NOTE_WRITE = re.compile(r"^/api/notes(/\d+/(file|sent))?$")  # a new note, its recordings / photos, and "emailed as report #N"

SERVER_URL = (os.environ.get("RF_RECON_PUBLIC_URL") or "").rstrip("/")  # set on the 24/7 server: always on, no Tailscale
# ahj (11/4): an AHJ or radio shop reviewer. It sees only the jobs shared with it by name (dashist.py access lists), in
# the review page, and can Accept or Return the report with a comment; nothing else in DAStastic answers it.
ROLES = ("view", "full", "admin", "ahj", "fetcher")
# a fetcher is a machine, not a person: the PC that fetches crowd data the server can't (crowdpull.py, ops/crowd_pull.py, 11/7).
# It reaches the pull routes and nothing else; made by that script, shown in the people list, removed like anyone
FETCHER_PATHS = {("GET", "/api/crowd/pull/queue"), ("GET", "/api/crowd/pull/status"), ("POST", "/api/crowd/pull/result")}
REVIEW_WRITE = re.compile(r"^/api/das/jobs/\d+/review$")  # a review decision or comment: checked per job (dashist.level)
AHJ_READ = re.compile(r"^(/review|/api/das/jobs|/api/das/jobs/\d+/(review|file))$")  # all an ahj login reaches, besides /static/
COURSE_SAVE = "/api/course/progress"  # a login's own progress in the DAS course: app.py checks the login has the course

ON = threading.local()  # ON.user is set while a remote request is being answered
_LOCK = threading.Lock()
_FAILS = {}
_DIR = None


def setup(data_dir):
    global _DIR
    _DIR = data_dir


def _path():
    return os.path.join(_DIR, "remote_users.json")


def _load():
    try:
        with open(_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save(users):
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(users, fh, indent=1)
    os.replace(tmp, _path())


def _secret():
    fp = os.path.join(_DIR, "remote_secret")
    with _LOCK:
        if not os.path.exists(fp):
            with open(fp, "w") as fh:
                fh.write(secrets.token_hex(32))
        with open(fp) as fh:
            return fh.read().strip().encode()


def _hash(pw, salt):
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()


def active():
    """Remote access is on once at least one person can sign in."""
    return bool(_load())


def users():
    return [{"name": u["name"], "added": u.get("added"), "last": u.get("last"), "role": u.get("role") or "view", "course": _has_course(u),
             "ends": u.get("ends") or "", "ended": ended(u), "google": u.get("google") or "", "google_first": u.get("google_first") or ""}
            for u in _load().values()]


def role_of(name):
    u = _load().get((name or "").strip().lower())
    return (u.get("role") or "view") if u else None


def _has_course(u):
    role = u.get("role") or "view"
    return role != "ahj" and bool(u.get("course", role == "admin"))  # an admin starts ticked until someone unticks them


def has_course(name):
    """Whether this login has the DAS course: as ticked in Data & updates. An AHJ login never does."""
    u = _load().get((name or "").strip().lower())
    return bool(u) and _has_course(u)


def set_course(name, on):
    with _LOCK:
        us = _load()
        u = us.get((name or "").strip().lower())
        if u is None:
            raise LookupError("No one by that name.")
        if u.get("role") == "ahj":
            raise ValueError("An AHJ login sees only the reports shared with it.")
        u["course"] = bool(on)
        _save(us)


def _ends(ends):
    """A login's last day (Cody 11/7 item 9: a temporary account for an inspector or a watcher): "YYYY-MM-DD", today or later,
    or "" for none."""
    ends = (ends or "").strip()
    if not ends:
        return ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", ends):
        raise ValueError("A last day is a date: YYYY-MM-DD.")
    try:
        time.strptime(ends, "%Y-%m-%d")
    except ValueError:
        raise ValueError("A last day is a date: YYYY-MM-DD.") from None
    if ends < time.strftime("%Y-%m-%d"):
        raise ValueError("A last day can't be in the past: use End now to end a login today.")
    return ends


def ended(u):
    """Whether a login's last day has passed (it works through the whole of its last day)."""
    return bool(u.get("ends")) and time.strftime("%Y-%m-%d") > u["ends"]


# --- Admins only (Cody 11/9: "make me the only one with access at the moment", then "add that to the github and the
# server for admins only", Andy's licensed copy first). While admins_only.json is in the data folder, only an admin login
# signs in or stays signed in; every other login (full, view, ahj, fetcher) is turned away and keeps its password, role and
# Google link for when it comes off (ops/licensed_copy.py --do admins_only_on / admins_only_off). The file being there is
# what counts, whatever it holds, so a damaged file still keeps the copy closed. Share links and the public verify page
# are their own switches (dashist.py, das.public_verify_on), not logins: this doesn't touch them.
ADMINS_ONLY_FILE = "admins_only.json"


def admins_only():
    return bool(_DIR) and os.path.exists(os.path.join(_DIR, ADMINS_ONLY_FILE))


def shut_out(u):
    """Whether this login is kept out right now by admins_only (any role but admin, while it's on)."""
    return (u.get("role") or "view") != "admin" and admins_only()


ADMINS_ONLY_SAY = "This DAStastic is open to admins only for now. Ask Cody when it opens again."


def add(name, role=None, ends=None):
    """Add a person (or give them a new password; their role and last day stay unless given). Returns the password: shown
    once, never stored. ends: a last day ("YYYY-MM-DD"), "" for none, None to keep what they had."""
    name = (name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._@'-]{1,39}", name):
        raise ValueError("Use a name of 2 to 40 letters, numbers, spaces or . _ @ ' -")
    if role is not None and role not in ROLES:
        raise ValueError(f"A role is one of: {', '.join(ROLES)}.")
    if ends is not None:
        ends = _ends(ends)
    pw = "-".join(secrets.token_urlsafe(6) for _ in range(2))
    salt = secrets.token_hex(16)
    with _LOCK:
        us = _load()
        old = us.get(name.lower(), {})
        keep_ends = old.get("ends", "") if ends is None else ends
        us[name.lower()] = {"name": name, "salt": salt, "hash": _hash(pw, salt), "added": old.get("added") or time.strftime("%Y-%m-%d %H:%M"),
                            "last": old.get("last"), "role": role or old.get("role") or "view", **({"course": old["course"]} if "course" in old else {}),
                            **({"ends": keep_ends} if keep_ends else {}),
                            **{k: old[k] for k in ("google", "google_first") if old.get(k)}}  # a new password keeps the Google link
        _save(us)
    return pw


def set_ends(name, ends):
    """Give a login a last day, take it away (""), or end it now ("now": its last day was yesterday). An admin can't end
    the last admin."""
    with _LOCK:
        us = _load()
        u = us.get((name or "").strip().lower())
        if u is None:
            raise LookupError("No one by that name.")
        if ends == "now":
            if u.get("role") == "admin" and sum(1 for x in us.values() if x.get("role") == "admin" and not ended(x)) == 1:
                raise ValueError("That's the last admin: make someone else admin first.")
            u["ends"] = time.strftime("%Y-%m-%d", time.localtime(time.time() - 86400))
        else:
            e = _ends(ends)
            if e:
                u["ends"] = e
            else:
                u.pop("ends", None)
        _save(us)


def set_role(name, role):
    if role not in ROLES:
        raise ValueError(f"A role is one of: {', '.join(ROLES)}.")
    with _LOCK:
        us = _load()
        u = us.get((name or "").strip().lower())
        if u is None:
            raise LookupError("No one by that name.")
        if u.get("role") == "admin" and role != "admin" and sum(1 for x in us.values() if x.get("role") == "admin") == 1:
            raise ValueError("That's the last admin: make someone else admin first.")
        u["role"] = role
        _save(us)


def remove(name):
    with _LOCK:
        us = _load()
        key = (name or "").strip().lower()
        if key in us and us[key].get("role") == "admin" and sum(1 for x in us.values() if x.get("role") == "admin") == 1:
            raise ValueError("That's the last admin: make someone else admin first.")
        if us.pop(key, None) is None:
            raise LookupError("No one by that name.")
        _save(us)


def check(name, pw):
    """The session cookie for a right name and password; raises ValueError with what to tell the person."""
    key, now = (name or "").strip().lower(), time.time()
    with _LOCK:
        fails = [t for t in _FAILS.get(key, []) if now - t < LOCK_S]
        _FAILS[key] = fails
        if len(fails) >= LOCK_AFTER:
            raise ValueError("Too many tries. Wait 15 minutes, or ask Cody for a new password.")
    u = _load().get(key)
    if not u or not hmac.compare_digest(_hash(pw or "", u["salt"]), u["hash"]):
        with _LOCK:
            _FAILS.setdefault(key, []).append(now)
        raise ValueError("That name and password don't match.")
    with _LOCK:
        _FAILS.pop(key, None)
    if ended(u):  # said only to someone with the right password
        raise ValueError(f"This login ended on {u['ends']}. Ask Cody if you need it again.")
    if shut_out(u):  # the same: a wrong password never learns the copy is admins only
        raise ValueError(ADMINS_ONLY_SAY)
    return _session(key, u)


def _session(key, u):
    """A signed session cookie value for this login (a password or a Google sign-in): ends with its salt, so a new password
    ends it."""
    payload = f"{key}|{int(time.time() + SESSION_S)}|{u['salt'][:12]}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload.encode()).decode() + "." + sig


# --- Google sign-in (Cody 11/7 item 8: "Add Google OAuth sign-in - configure for Andy, Joe Geraghty, and Josh Trigg ...
# keep normal log in too"). The OAuth client (Google Cloud project "dastastic", Testing mode, its test users the only ones
# Google lets through) is google_oauth.json in the data folder, put there by ops/google_oauth_to_server.py. A Google address
# signs in only as the login the admin linked it to (People and logins); passwords keep working. Google refuses sign-in inside
# an app's own web view, so DAStastic for Android keeps the password.
GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = os.environ.get("DAST_GOOGLE_TOKEN_URL") or "https://oauth2.googleapis.com/token"  # tests point it at a stand-in
GOOGLE_ISS = ("accounts.google.com", "https://accounts.google.com")
STATE_COOKIE, STATE_S = "rfr_gstate", 600


def google_conf():
    try:
        with open(os.path.join(_DIR, "google_oauth.json"), encoding="utf-8") as fh:
            c = json.load(fh)
        return c if c.get("client_id") and c.get("client_secret") and c.get("redirect_uris") else None
    except (OSError, ValueError, TypeError):
        return None


def google_on():
    return google_conf() is not None


def google_start():
    """Where to send the browser, and the state cookie that proves the answer comes back to the same browser."""
    c = google_conf()
    if not c:
        raise ValueError("Google sign-in isn't set up on this server.")
    state = secrets.token_urlsafe(24)
    exp = int(time.time() + STATE_S)
    sig = hmac.new(_secret(), f"g|{state}|{exp}".encode(), hashlib.sha256).hexdigest()
    q = urllib.parse.urlencode({"client_id": c["client_id"], "redirect_uri": c["redirect_uris"][0], "response_type": "code",
                                "scope": "openid email profile", "state": state, "prompt": "select_account"})
    return f"{GOOGLE_AUTH}?{q}", f"{state}.{exp}.{sig}"


def _state_ok(state, cookie_value):
    m = re.fullmatch(r"([A-Za-z0-9_-]{20,64})\.(\d{9,12})\.([0-9a-f]{64})", cookie_value or "")
    if not m or not state or not hmac.compare_digest(m.group(1), state) or int(m.group(2)) < time.time():
        return False
    good = hmac.new(_secret(), f"g|{m.group(1)}|{m.group(2)}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(good, m.group(3))


def _google_email(code):
    """Swap the code for Google's ID token, server to server over TLS (so its signature needn't be checked: Google's OpenID
    guide), and check what it says: our client, Google, not expired, a verified address."""
    c = google_conf()
    body = urllib.parse.urlencode({"code": code, "client_id": c["client_id"], "client_secret": c["client_secret"],
                                   "redirect_uri": c["redirect_uris"][0], "grant_type": "authorization_code"}).encode()
    req = urllib.request.Request(GOOGLE_TOKEN, body, {"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            tok = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise ValueError(f"Google didn't accept the sign-in (HTTP {e.code}). Try again.") from None
    except (OSError, ValueError):
        raise ValueError("Google couldn't be reached. Try again, or sign in with your password.") from None
    parts = (tok.get("id_token") or "").split(".")
    if len(parts) != 3:
        raise ValueError("Google's answer had no sign-in in it. Try again.")
    try:
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except (ValueError, UnicodeDecodeError):
        raise ValueError("Google's answer couldn't be read. Try again.") from None
    if claims.get("aud") != c["client_id"] or claims.get("iss") not in GOOGLE_ISS or int(claims.get("exp") or 0) < time.time():
        raise ValueError("That sign-in wasn't for DAStastic. Try again.")
    if claims.get("email_verified") not in (True, "true") or not claims.get("email"):
        raise ValueError("Google hasn't verified that address. Sign in with your password.")
    return claims["email"].strip().lower(), claims.get("name") or ""


def google_finish(code, state, state_cookie):
    """The session cookie for the login a Google address is linked to; raises ValueError with what to tell the person.
    The first Google sign-in of each login is kept (google_first), for the admin."""
    if not _state_ok(state, state_cookie):
        raise ValueError("That sign-in started somewhere else or took too long. Press Sign in with Google again.")
    email, _gname = _google_email(code)
    with _LOCK:
        us = _load()
        key, u = next(((k, x) for k, x in us.items() if (x.get("google") or "").lower() == email), (None, None))
        if u is None:
            raise ValueError(f"{email} isn't linked to a DAStastic login. Ask Cody to link it, or sign in with your password.")
        if ended(u):
            raise ValueError(f"This login ended on {u['ends']}. Ask Cody if you need it again.")
        if shut_out(u):
            raise ValueError(ADMINS_ONLY_SAY)
        if not u.get("google_first"):
            u["google_first"] = time.strftime("%Y-%m-%d %H:%M")
        u["last"] = time.strftime("%Y-%m-%d %H:%M")
        _save(us)
    return _session(key, u)


def set_google(name, email):
    """Link a login to a Google address ("" unlinks it). One address, one login."""
    email = (email or "").strip().lower()
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("That isn't an email address.")
    with _LOCK:
        us = _load()
        key = (name or "").strip().lower()
        u = us.get(key)
        if u is None:
            raise LookupError("No one by that name.")
        if u.get("role") == "fetcher":
            raise ValueError("The PC fetcher is a machine: it has no Google account.")
        other = next((x["name"] for k, x in us.items() if k != key and (x.get("google") or "").lower() == email and email), None)
        if other:
            raise ValueError(f"{email} is already linked to {other}.")
        if email:
            u["google"] = email
        else:
            u.pop("google", None)
        _save(us)


MIN_PW = 10  # a password a person picks for themselves (made ones are 17 random characters)


def change_password(name, current, new):
    """A signed-in person's own new password (Cody 11/7: "change own password"). The current one first: a wrong one counts
    toward the same 8-try lock as signing in. The new one: 10 to 200 characters, not their name, not the current one. Every
    other session of theirs ends (the salt changes) and this one gets a new cookie value, returned."""
    key = (name or "").strip().lower()
    try:
        check(name, current or "")
    except ValueError as e:
        raise ValueError("That isn't your current password." if "don't match" in str(e) else str(e)) from None
    new = new or ""
    if len(new) < MIN_PW:
        raise ValueError(f"Use at least {MIN_PW} characters.")
    if len(new) > 200:
        raise ValueError("Use at most 200 characters.")
    if new.strip().lower() == key:
        raise ValueError("Use something other than your name.")
    if new == current:
        raise ValueError("That's the password you have now.")
    salt = secrets.token_hex(16)
    with _LOCK:
        us = _load()
        u = us.get(key)
        if u is None:
            raise LookupError("No one by that name.")
        u["salt"], u["hash"], u["changed"] = salt, _hash(new, salt), time.strftime("%Y-%m-%d %H:%M")
        _save(us)
    return check(name, new)


def user_of(cookie_header):
    """The signed-in person's name, or None. Every login cookie sent is tried in turn: a copy shown in a frame can be sent two
    (the dash's partitioned one and the top-level one, frame_ancestors), and the first may be out of date."""
    for m in re.finditer(rf"(?:^|;\s*){COOKIE}=([A-Za-z0-9_=-]+)\.([0-9a-f]{{64}})", cookie_header or ""):
        name = _session_user(m)
        if name:
            return name
    return None


def _session_user(m):
    """The name for one login cookie (a match of user_of's pattern), or None."""
    try:
        payload = base64.urlsafe_b64decode(m.group(1)).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest(), m.group(2)):
        return None
    key, exp, salt = (payload.split("|") + ["", "", ""])[:3]
    u = _load().get(key)
    if not u or not exp.isdigit() or int(exp) < time.time() or u["salt"][:12] != salt or ended(u):  # an ended login's sessions end too
        return None
    if shut_out(u):  # admins only: a session made before it came on ends now too
        return None
    if not u.get("last") or u["last"] < time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - 300)):
        with _LOCK:  # when they were last here, written at most every 5 minutes
            us = _load()
            if key in us:
                us[key]["last"] = time.strftime("%Y-%m-%d %H:%M")
                _save(us)
    return u["name"]


# --- Shown inside DaDougieDash (Cody 11/9: "embed it in the dash", Andy's licensed copy first; "take the Omnyra gate off but
# keep the firewall/router/switch"). frame.json in the data folder names the pages that may show this copy in a frame:
#   {"ancestors": ["http://127.0.0.1:8796", "http://localhost:8796"]}
# With no file (every copy but the ones it's put on: ops/licensed_copy.py --do frame_on) nothing changes. With it:
#   - its pages say Content-Security-Policy: frame-ancestors 'self' and those addresses (X-Frame-Options: DENY stays, for
#     a browser that doesn't read frame-ancestors; a stored file opened inline gets app.opened_safely's walled-off policy
#     in this one's place, so it can't be framed at all);
#   - the login cookie comes twice over https: the usual SameSite=Lax one, and a Partitioned, SameSite=None one, so a login
#     made inside the frame sticks (a partitioned cookie counts only under the top-level site it was set in: the dash);
#   - another site's request goes on only as a page load, and a change must come from this copy's own pages: SameSite=Lax
#     was what stopped another site's form, and the second cookie doesn't (app.py RemoteH.from_here).
FRAME_FILE = "frame.json"
_ANCESTOR = re.compile(r"https?://[a-z0-9.-]+(:\d{1,5})?")  # whole entry only (fullmatch): a trailing newline never passes


def frame_ancestors():
    """The addresses allowed to frame this copy (frame.json), each a bare scheme://host[:port]; [] when it's off."""
    if not _DIR:
        return []
    try:
        with open(os.path.join(_DIR, FRAME_FILE), encoding="utf-8") as fh:
            got = json.load(fh).get("ancestors") or []
    except (OSError, ValueError, AttributeError):
        return []
    return [a for a in got if isinstance(a, str) and _ANCESTOR.fullmatch(a)] if isinstance(got, list) else []


def cookie(value, secure, clear=False):
    """The login cookie's Set-Cookie value, or two of them (a list) on a copy shown in a frame, over https."""
    head, age = f"{COOKIE}={'' if clear else value}; Path=/; HttpOnly; ", f"Max-Age={0 if clear else SESSION_S}"
    lax = head + "SameSite=Lax; " + age + ("; Secure" if secure else "")
    if not (secure and frame_ancestors()):
        return lax
    return [lax, head + "SameSite=None; Secure; Partitioned; " + age]


TAILSCALE = next((p for p in (shutil.which("tailscale"), r"C:\Program Files\Tailscale\tailscale.exe") if p and os.path.exists(p)), None)


def _ts(*args):
    r = subprocess.run([TAILSCALE, *args], capture_output=True, text=True, timeout=20,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def link():
    """The public link: Tailscale on this PC, its https name, and whether Funnel sends it here. On the server: its address."""
    if SERVER_URL:
        return {"installed": True, "state": "Running", "url": SERVER_URL, "on": True, "server": True}
    if not TAILSCALE:
        return {"installed": False}
    try:
        st = json.loads(_ts("status", "--json")[1] or "{}")
        fn = json.loads(_ts("funnel", "status", "--json")[1] or "{}")
    except (OSError, ValueError, subprocess.SubprocessError):
        return {"installed": True, "state": "not running"}
    dns = ((st.get("Self") or {}).get("DNSName") or "").rstrip(".")
    proxied = json.dumps(fn.get("Web") or {})
    return {"installed": True, "state": st.get("BackendState"), "url": f"https://{dns}" if dns else None,
            "on": any((fn.get("AllowFunnel") or {}).values()) and f"127.0.0.1:{PORT}" in proxied}


def set_link(on):
    """Turn the public link on (Funnel -> this PC's remote port, kept across restarts) or off."""
    if SERVER_URL:
        raise ValueError("This is the server: its link is always on.")
    if not TAILSCALE:
        raise ValueError("Tailscale isn't installed on this PC.")
    code, out = _ts("funnel", "--bg", f"http://127.0.0.1:{PORT}") if on else _ts("funnel", "reset")
    if code:
        raise ValueError(out.strip()[-400:] or "Tailscale refused.")
    return link()


def note_write(method, path):
    return method == "POST" and bool(NOTE_WRITE.match(path))


def writer(role):
    return role in ("full", "admin")


def reads_body(method, path, role):
    """Whether the handler reads what was sent: a note (anyone signed in), a review (checked per job), the PC fetcher's rows
    (its one route that takes a body), and every change a full or admin login makes that isn't refused."""
    if refused(method, path, role):
        return False
    # the fetcher: 11/7 its first post arrived empty (the door drained it), so the server saw no source and answered 500
    return note_write(method, path) and role != "ahj" or bool(REVIEW_WRITE.match(path)) and method == "POST" or method == "POST" and path == COURSE_SAVE \
        or role == "fetcher" and method == "POST" or writer(role)


def refused(method, path, role="view"):
    """Why a remote person can't do this, or None when they can."""
    if role == "admin":
        return None
    if role == "fetcher":
        return None if (method, path) in FETCHER_PATHS else "A fetcher login only brings crowd data to the server."
    if role == "ahj":  # the review page and the jobs shared with it, nothing else
        if method == "GET" and (AHJ_READ.match(path) or path.startswith("/static/")):
            return None
        if method == "POST" and REVIEW_WRITE.match(path):
            return None
        return "An AHJ login sees only the reports shared with it."
    if method == "POST" and REVIEW_WRITE.match(path):
        return None  # a comment or a review: the job's access list says who may (app.py das_route)
    if method == "POST" and path == COURSE_SAVE:
        return None  # their own progress: app.py checks they have the course
    if method != "GET" and not note_write(method, path) and not writer(role):
        return "Your login is view only." if SERVER_URL else "View only: changes are made on Cody's PC."
    if path.startswith(BLOCKED):
        return "That part of DAStastic is for the admin." if SERVER_URL else "That part of DAStastic stays on Cody's PC."
    return None


# installable as an app (Chrome, Edge, Android, iPhone "Add to Home Screen"): the manifest and icons are open to anyone,
# so the sign-in page installs too; the service worker caches nothing (every answer comes fresh from the server)
SW_JS = b"self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});"
APP_HEAD = ('<link rel="manifest" href="/static/app/manifest.webmanifest"><meta name="theme-color" content="#12110f">'
            '<link rel="apple-touch-icon" href="/static/app/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes">'
            '<script>if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});</script>')


def _licence():
    try:
        import licence
        return licence.load(_DIR) if _DIR else None
    except Exception:  # the sign-in page never fails on a bad licence file
        return None


def login_page(msg="", name="", google=False):
    """google: show Sign in with Google (set up on this server, and not inside DAStastic for Android, whose web view Google
    refuses)."""
    err = f'<p class="err">{html.escape(msg)}</p>' if msg else ""
    lic = _licence()  # a business's own copy says whose it is (licence.py)
    whose = f"{html.escape(lic['licensee'])}'s DAStastic" if lic else ""
    gbtn = ('<div class="or"><span>or</span></div><a class="gbtn" href="/remote/google"><svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">'
            '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/>'
            '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.5z"/>'
            '<path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/>'
            '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/>'
            '</svg>Sign in with Google</a>') if google else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · DAStastic (beta)</title>{APP_HEAD}
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{{color-scheme:dark;--ink:#f3ece6;--dim:#b9aea6;--accent:#f0a37a;--line:rgba(255,255,255,.14)}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;font:15px/1.5 Urbanist,system-ui,sans-serif;color:var(--ink);
  background:radial-gradient(1200px 700px at 80% 10%,#5a3b2b 0,transparent 60%),radial-gradient(900px 600px at 10% 90%,#2b2f3d 0,transparent 60%),#17140f}}
main{{width:100%;max-width:380px;padding:28px 26px;border-radius:22px;border:1px solid var(--line);
  background:rgba(30,26,22,.62);backdrop-filter:blur(18px) saturate(1.2);box-shadow:0 20px 60px rgba(0,0,0,.45)}}
h1{{margin:0 0 2px;font-size:22px;letter-spacing:.04em}} h1 b{{color:var(--accent)}}
.sub{{margin:0 0 18px;color:var(--dim)}}
label{{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px}}
input{{width:100%;padding:11px 14px;border-radius:12px;border:1px solid var(--line);background:rgba(0,0,0,.28);color:var(--ink);font:inherit}}
input:focus{{outline:2px solid var(--accent);outline-offset:1px}}
button{{margin-top:18px;width:100%;padding:11px;border:0;border-radius:999px;background:var(--accent);color:#2a160c;font:600 15px Urbanist,system-ui,sans-serif;cursor:pointer;
  transition:filter .2s ease}}
button:hover{{filter:brightness(1.08)}}
.err{{margin:12px 0 0;padding:9px 12px;border-radius:10px;background:rgba(220,80,60,.18);border:1px solid rgba(220,80,60,.4)}}
.foot{{margin:16px 0 0;color:var(--dim);font-size:13px}}
.or{{display:flex;align-items:center;gap:10px;margin:16px 0 0;color:var(--dim);font-size:13px}} .or::before,.or::after{{content:"";flex:1;border-top:1px solid var(--line)}}
.gbtn{{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;padding:10px;border-radius:999px;background:#fff;color:#1f1f1f;
  font:600 15px Urbanist,system-ui,sans-serif;text-decoration:none;transition:filter .2s ease}} .gbtn:hover{{filter:brightness(.95)}}
</style></head><body><main>
<h1>DAStastic <b>BETA</b></h1><p class="sub">{f"Sign in to {whose}." if whose else "Sign in to DAStastic." if SERVER_URL else "Cody's DAStastic, view and search only."}</p>
<form method="post" action="/remote/login">
<label for="n">Name</label><input id="n" name="name" autocomplete="username" required value="{html.escape(name)}" {'' if name else 'autofocus'}>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required {'autofocus' if name else ''}>
<button type="submit">Sign in</button>{err}</form>{gbtn}
<p class="foot">No login? Ask Cody for one. Forgot your password? {"Sign in with Google, or ask" if google else "Ask"} Cody for a new one.</p></main></body></html>"""


if __name__ == "__main__":  # on the server: make or reset a login without the web page (the first admin)
    import argparse
    import uls_import
    ap = argparse.ArgumentParser(description="DAStastic logins")
    ap.add_argument("action", choices=("add", "list", "role", "remove"))
    ap.add_argument("name", nargs="?")
    ap.add_argument("--role", choices=ROLES)
    a = ap.parse_args()
    setup(uls_import.DATA_DIR)
    if a.action == "list":
        for u in users():
            print(f"{u['name']}\t{u['role']}\tadded {u['added']}\tlast {u['last'] or 'not yet'}")
    elif a.action == "add":
        print(f"Password for {a.name.strip()} ({a.role or role_of(a.name) or 'view'}), shown once: {add(a.name, a.role)}")
    elif a.action == "role":
        set_role(a.name, a.role)
        print(f"{a.name} is now {a.role}.")
    else:
        remove(a.name)
        print(f"{a.name} can't sign in any more.")
