"""
Find a building's public contact email from its own website (DAS Prospects, Cody 11/4: "the public lists rarely
include an email address"). On a press, never in bulk: the home page and up to four of its own contact, about,
staff, directory or facilities pages, robots.txt honoured, public addresses only (das._public_url), 1 MB a page.

Returns the addresses found, best first: the site's own domain ahead of others, and role addresses that fit DAS
outreach (facilities, operations, engineering, info, contact) ahead of personal ones. What a page publishes as its
contact address is what's returned; nothing is guessed or made up.
"""
import html
import re
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

UA = "RF-Recon/2.0 (finds a building's published contact address for one person's outreach)"
PAGE_MAX = 1024 * 1024
EMAIL = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}")
GOOD_PAGE = re.compile(r"contact|about|staff|directory|facilit|operation|administrat|leadership|team|department|maintenance|engineering|security", re.I)
ROLE_RANK = [(re.compile(r"facilit|plant|maint|engineer|operations|ops@|building|property|manag|chief"), 6),
             (re.compile(r"safety|security|fire|it@|telecom|technology"), 5),
             (re.compile(r"^(info|contact|hello|office|admin|frontdesk|reception|general|inquir)"), 4),
             (re.compile(r"sales|events|booking|marketing|reserv"), 2),
             (re.compile(r"noreply|no-reply|donotreply|privacy|abuse|webmaster|example\.|sentry|wixpress|godaddy|\.png|\.jpg"), -99)]


def _robots(base, fetch):
    rp = urllib.robotparser.RobotFileParser()
    try:
        rp.parse(fetch(urllib.parse.urljoin(base, "/robots.txt")).decode("utf-8", "replace").splitlines())
    except Exception:
        rp.parse([])  # no robots.txt (or it can't be read): nothing is disallowed
    return rp


def _default_fetch(url):
    import das
    das._public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.5"})
    with urllib.request.build_opener(das._NoRedirect).open(req, timeout=15) as r:
        return r.read(PAGE_MAX)


def _deobfuscate(text):
    t = html.unescape(text)
    t = re.sub(r"\s*[\[\(\{]\s*at\s*[\]\)\}]\s*", "@", t, flags=re.I)
    t = re.sub(r"\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*", ".", t, flags=re.I)
    return t


def _cfemail(hexs):
    """Cloudflare's email protection: the first byte is the key."""
    try:
        b = bytes.fromhex(hexs)
        return "".join(chr(c ^ b[0]) for c in b[1:])
    except ValueError:
        return ""


def emails_in(page, url):
    text = page.decode("utf-8", "replace")
    found = {}
    for m in re.finditer(r"""mailto:([^"'?>\s]+)""", text, re.I):
        found.setdefault(urllib.parse.unquote(m.group(1)).strip().lower(), "mailto")
    for m in re.finditer(r"""data-cfemail=["']([0-9a-fA-F]+)["']""", text):
        e = _cfemail(m.group(1))
        if EMAIL.fullmatch(e or ""):
            found.setdefault(e.lower(), "protected")
    for m in EMAIL.finditer(_deobfuscate(re.sub(r"<[^>]+>", " ", text))):
        found.setdefault(m.group(0).strip(".").lower(), "text")
    return {e: (how, url) for e, how in found.items() if EMAIL.fullmatch(e)}


def links_in(page, base):
    text = page.decode("utf-8", "replace")
    host = urllib.parse.urlparse(base).hostname or ""
    out = []
    for m in re.finditer(r"""<a\b[^>]*href=["']([^"'#]+)["'][^>]*>(.*?)</a>""", text, re.I | re.S):
        u = urllib.parse.urljoin(base, m.group(1).strip())
        label = re.sub(r"<[^>]+>", " ", m.group(2))
        if urllib.parse.urlparse(u).hostname == host and u.startswith(("http://", "https://")) and (GOOD_PAGE.search(u) or GOOD_PAGE.search(label)):
            score = 3 if re.search(r"contact", u + label, re.I) else 2 if re.search(r"facilit|staff|directory", u + label, re.I) else 1
            out.append((score, u))
    seen, best = set(), []
    for _, u in sorted(out, key=lambda x: -x[0]):
        if u not in seen:
            seen.add(u)
            best.append(u)
    return best


def _rank(email, site_host):
    local, _, domain = email.partition("@")
    s = 0
    host = (site_host or "").lower().removeprefix("www.")
    if host and (domain == host or domain.endswith("." + host) or host.endswith("." + domain)):
        s += 10
    for rx, pts in ROLE_RANK:
        if rx.search(email):
            s += pts
            break
    if re.fullmatch(r"[a-z]+\.[a-z]+|[a-z]\.?[a-z]{3,}", local):  # a person's own address: fine, after the role ones
        s += 1
    return s


REFUSED = (401, 403, 429, 451, 503)  # a site saying no, or asking a person to prove they're one: the answer, never something to get round
CHALLENGE = re.compile(rb"cf-browser-verification|challenge-platform|captcha|are you a robot|access denied", re.I)


def find(website, fetch=None, max_pages=5):
    """{emails: [{email, page, how, score}], pages: [urls read], skipped: [urls robots.txt keeps out], refused: [urls that said no]}. A site that
    refuses (or answers with a check for people) is asked nothing more: its refusal stands."""
    fetch = fetch or _default_fetch
    if not website:
        raise ValueError("This building has no website in the list. Call the number shown, or add their address by hand.")
    base = website if re.match(r"https?://", website, re.I) else "http://" + website
    host = urllib.parse.urlparse(base).hostname or ""
    rp = _robots(base, fetch)
    todo, read, skipped, got, refused = [base], [], [], {}, []
    while todo and len(read) < max_pages:
        u = todo.pop(0)
        if u in read:
            continue
        if not rp.can_fetch(UA, u):
            skipped.append(u)
            continue
        try:
            page = fetch(u)
        except urllib.error.HTTPError as e:
            read.append(u)
            if e.code in REFUSED:
                refused.append(u)
                break
            continue
        except Exception:
            read.append(u)
            continue
        if isinstance(page, bytes) and CHALLENGE.search(page[:20000]):
            read.append(u)
            refused.append(u)
            break
        read.append(u)
        for e, v in emails_in(page, u).items():
            got.setdefault(e, v)
        if len(read) == 1:
            todo += [x for x in links_in(page, u) if x not in todo][:max_pages - 1]
    out = sorted(({"email": e, "how": how, "page": page, "score": _rank(e, host)} for e, (how, page) in got.items()),
                 key=lambda x: -x["score"])
    return {"emails": [x for x in out if x["score"] > -50][:8], "pages": read, "skipped": skipped, "refused": refused}
