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
    return [{"name": u["name"], "added": u.get("added"), "last": u.get("last"), "role": u.get("role") or "view", "course": _has_course(u)} for u in _load().values()]


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


def add(name, role=None):
    """Add a person (or give them a new password; their role stays unless one is given). Returns the password: shown
    once, never stored."""
    name = (name or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._@'-]{1,39}", name):
        raise ValueError("Use a name of 2 to 40 letters, numbers, spaces or . _ @ ' -")
    if role is not None and role not in ROLES:
        raise ValueError(f"A role is one of: {', '.join(ROLES)}.")
    pw = "-".join(secrets.token_urlsafe(6) for _ in range(2))
    salt = secrets.token_hex(16)
    with _LOCK:
        us = _load()
        old = us.get(name.lower(), {})
        us[name.lower()] = {"name": name, "salt": salt, "hash": _hash(pw, salt), "added": old.get("added") or time.strftime("%Y-%m-%d %H:%M"),
                            "last": old.get("last"), "role": role or old.get("role") or "view", **({"course": old["course"]} if "course" in old else {})}
        _save(us)
    return pw


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
    payload = f"{key}|{int(now + SESSION_S)}|{u['salt'][:12]}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload.encode()).decode() + "." + sig


def user_of(cookie_header):
    """The signed-in person's name, or None."""
    m = re.search(rf"(?:^|;\s*){COOKIE}=([A-Za-z0-9_=-]+)\.([0-9a-f]{{64}})", cookie_header or "")
    if not m:
        return None
    try:
        payload = base64.urlsafe_b64decode(m.group(1)).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest(), m.group(2)):
        return None
    key, exp, salt = (payload.split("|") + ["", "", ""])[:3]
    u = _load().get(key)
    if not u or not exp.isdigit() or int(exp) < time.time() or u["salt"][:12] != salt:
        return None
    if not u.get("last") or u["last"] < time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - 300)):
        with _LOCK:  # when they were last here, written at most every 5 minutes
            us = _load()
            if key in us:
                us[key]["last"] = time.strftime("%Y-%m-%d %H:%M")
                _save(us)
    return u["name"]


def cookie(value, secure, clear=False):
    return (f"{COOKIE}={'' if clear else value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={0 if clear else SESSION_S}"
            + ("; Secure" if secure else ""))


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
    """Whether the handler reads what was sent: a note (anyone signed in), a review (checked per job), and every change
    a full or admin login makes that isn't refused."""
    if refused(method, path, role):
        return False
    return note_write(method, path) and role != "ahj" or bool(REVIEW_WRITE.match(path)) and method == "POST" or method == "POST" and path == COURSE_SAVE or writer(role)


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


def login_page(msg="", name=""):
    err = f'<p class="err">{html.escape(msg)}</p>' if msg else ""
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
</style></head><body><main>
<h1>DAStastic <b>BETA</b></h1><p class="sub">{"Sign in to DAStastic." if SERVER_URL else "Cody's DAStastic, view and search only."}</p>
<form method="post" action="/remote/login">
<label for="n">Name</label><input id="n" name="name" autocomplete="username" required value="{html.escape(name)}" {'' if name else 'autofocus'}>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required {'autofocus' if name else ''}>
<button type="submit">Sign in</button>{err}</form>
<p class="foot">No login? Ask Cody for one.</p></main></body></html>"""


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
