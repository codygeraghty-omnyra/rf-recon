"""One polite client for every outside source (Data desk step 2).

- One user agent per tool (the caller names itself), https only, public addresses only, a size cap on every answer.
- Conditional requests: the ETag and Last-Modified a source last sent go back with the next request, so an unchanged
  file comes back as 304 and nothing is downloaded.
- Retries only where the server may simply have stumbled: a timeout, a dropped connection, 500, 502 or 504, at most
  twice more with a growing wait, to the same address by the same route.
- A refusal stops: 401, 403, 429, 451, 503, a challenge page (a captcha or "are you a robot"), a sign-in wall, or
  robots.txt. Refused is raised with what a person needs to know, and the caller files it as a person task. Nothing here
  ever tries again through another address, proxy, cloud, browser or user agent: a refusal is an answer, not an obstacle
  (Cody 11/5, no bot-check bypass).
- A bounded crawl for a site whose robots.txt and terms allow it: same host and path prefix, a page cap, a wait between
  pages, robots.txt honoured, stopped by the first refusal.

Standard library only; nothing here imports DAStastic.
"""
import ipaddress
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser

REFUSALS = {401: "asks for a key or a sign-in", 403: "refused this client", 429: "says to slow down (rate limited)",
            451: "refused for legal reasons", 503: "is unavailable or checking for a person"}
RETRY = (500, 502, 504)
CHALLENGE = re.compile(rb"cf-browser-verification|challenge-platform|cf-chl-|g-recaptcha|h-captcha|hcaptcha|captcha|are you a robot|"
                       rb"verify you are (a )?human|just a moment\.\.\.|attention required|access denied|unusual traffic", re.I)
LOGIN = re.compile(rb"<input[^>]+type=[\"']?password|<form[^>]+(log ?in|sign ?in)", re.I)


class Refused(Exception):
    """The source said no. why: a short reason; status: the HTTP status (0 for a challenge page, a sign-in wall or
    robots.txt); retry_after: what the source asked for, if anything. Never retried by another route."""
    def __init__(self, url, why, status=0, retry_after=None):
        super().__init__(f"{urllib.parse.urlsplit(url).netloc} {why}")
        self.url, self.why, self.status, self.retry_after = url, why, status, retry_after


class Failed(Exception):
    """The source couldn't be reached after the retries (a timeout, a dropped connection, a server error)."""


class TooBig(Exception):
    pass


class Response:
    def __init__(self, url, status, body, headers, not_modified=False):
        self.url, self.status, self.body, self.headers, self.not_modified = url, status, body, headers, not_modified

    def text(self, enc="utf-8"):
        return self.body.decode(enc, "replace")


def public_host(host, resolve=socket.getaddrinfo):
    """True when every address the host resolves to is public (no loopback, private, link-local or reserved)."""
    try:
        addrs = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            addrs = [ipaddress.ip_address(a[4][0].split("%")[0]) for a in resolve(host, 443, proto=socket.IPPROTO_TCP)]
        except (OSError, ValueError):
            return False
    return bool(addrs) and all(a.is_global for a in addrs)


class _CheckedRedirect(urllib.request.HTTPRedirectHandler):
    """Every redirect is checked like the first address (https, public): a server could answer 302 to
    http://169.254.169.254/ or a loopback port and the request went there (review 11/10 round 2). check raises
    ValueError, which stops the request before the next hop is asked."""

    def __init__(self, check):
        super().__init__()
        self.check = check

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def https_public(url, resolve=socket.getaddrinfo):
    """ValueError unless url is https to a public host (Fetcher._check's rule)."""
    u = urllib.parse.urlsplit(url)
    if u.scheme != "https" or not u.hostname:
        raise ValueError(f"https only: {url[:100]}")
    if not public_host(u.hostname, resolve):
        raise ValueError(f"not a public address: {u.hostname}")


def _urlopen(req, timeout, check=https_public):
    """The real network: (status, headers, a file-like body). HTTPError answers come back as answers, not exceptions.
    check(url): run on every redirect's address before it's followed, https to a public host by default."""
    try:
        r = urllib.request.build_opener(_CheckedRedirect(check)).open(req, timeout=timeout)
        return r.status, dict(r.headers.items()), r
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers.items()) if e.headers else {}, e


class Fetcher:
    """fetcher = Fetcher("DAStastic data desk (+https://...)"); fetcher.get(url) -> Response, or raises Refused / Failed /
    TooBig. validators: a dict-like {url: {"etag", "modified"}} kept between runs. opener, resolve and sleep are for tests."""

    def __init__(self, user_agent, max_bytes=50 * 1024 * 1024, timeout=60, validators=None, opener=None, resolve=None,
                 sleep=time.sleep, tries=3):
        if not user_agent or len(user_agent) < 8:
            raise ValueError("Name the tool in the user agent.")
        self.ua, self.max_bytes, self.timeout, self.tries = user_agent, max_bytes, timeout, tries
        self.validators = validators if validators is not None else {}
        self.opener, self.sleep = opener or _urlopen, sleep
        self.resolve = resolve or socket.getaddrinfo
        self.requests = []  # every request made, (method, url): what a test or a log can count

    def _check(self, url):
        https_public(url, self.resolve)

    def get(self, url, accept="*/*", headers=None, conditional=True, expect_html=False):
        self._check(url)
        h = {"User-Agent": self.ua, "Accept": accept, **(headers or {})}
        v = (self.validators.get(url) or {}) if conditional else {}
        if v.get("etag"):
            h["If-None-Match"] = v["etag"]
        if v.get("modified"):
            h["If-Modified-Since"] = v["modified"]
        last = None
        for k in range(self.tries):
            if k:
                self.sleep(5 * k)
            self.requests.append(("GET", url))
            try:
                status, rh, fh = self.opener(urllib.request.Request(url, headers=h), self.timeout)
            except (TimeoutError, socket.timeout, ConnectionError, urllib.error.URLError, OSError) as e:
                last = f"{type(e).__name__}"
                continue
            rh = {k.lower(): v for k, v in (rh or {}).items()}
            if status in REFUSALS:
                raise Refused(url, REFUSALS[status], status, rh.get("retry-after"))
            if status in RETRY:
                last = f"HTTP {status}"
                continue
            if status == 304:
                return Response(url, 304, b"", rh, not_modified=True)
            if status >= 400:
                raise Refused(url, f"answered {status}", status)
            body = fh.read(self.max_bytes + 1)
            if len(body) > self.max_bytes:
                raise TooBig(f"{urllib.parse.urlsplit(url).netloc}: over {self.max_bytes // (1024 * 1024)} MB")
            ctype = rh.get("content-type", "")
            html = "html" in ctype or body[:200].lstrip().lower().startswith((b"<!doctype html", b"<html"))
            if html and CHALLENGE.search(body[:30000]):
                raise Refused(url, "answered with a challenge page (a check for a person)")
            if html and not expect_html:
                raise Refused(url, "answered with a web page instead of data (often a sign-in wall)" if LOGIN.search(body[:30000])
                              else "answered with a web page instead of data")
            final = getattr(fh, "url", None) or url  # sent somewhere else: to a sign-in page is a wall
            if final != url and re.search(r"(?i)/(log-?in|sign-?in|auth|sso|session)\b", urllib.parse.urlsplit(final).path):
                raise Refused(url, "sent the request to a sign-in page")
            if conditional and (rh.get("etag") or rh.get("last-modified")):
                self.validators[url] = {"etag": rh.get("etag"), "modified": rh.get("last-modified")}
            return Response(url, status, body, rh)
        raise Failed(f"{urllib.parse.urlsplit(url).netloc}: {last} after {self.tries} tries")

    # ---- a bounded crawl
    def robots(self, base):
        rp = urllib.robotparser.RobotFileParser()
        try:
            r = self.get(urllib.parse.urljoin(base, "/robots.txt"), accept="text/plain", conditional=False)
            rp.parse(r.text().splitlines())
        except (Refused, Failed, TooBig, ValueError):
            rp.parse([])  # no robots.txt, or it can't be read: the crawl still keeps to its page cap and wait
        return rp

    def crawl(self, start, page_cap, rate_s=2.0, prefix=None):
        """Pages from start on the same host under prefix (default: start's path), breadth first, at most page_cap pages,
        rate_s seconds apart, robots.txt honoured. Yields Response; the first refusal stops the crawl (Refused raised)."""
        if page_cap < 1 or rate_s < 1:
            raise ValueError("a crawl needs a page cap and at least 1 s between pages")
        su = urllib.parse.urlsplit(start)
        prefix = prefix or (su.path.rsplit("/", 1)[0] + "/")
        rp = self.robots(f"{su.scheme}://{su.netloc}/")
        queue, seen, n = [start], {start}, 0
        while queue and n < page_cap:
            url = queue.pop(0)
            if not rp.can_fetch(self.ua, url):
                if n == 0:
                    raise Refused(url, "keeps this page out in its robots.txt")
                continue
            if n:
                self.sleep(rate_s)
            r = self.get(url, accept="text/html,*/*", expect_html=True, conditional=False)
            n += 1
            yield r
            for href in re.findall(rb"""href=["']([^"'#]+)""", r.body[:2_000_000]):
                nxt = urllib.parse.urljoin(url, href.decode("utf-8", "replace"))
                nu = urllib.parse.urlsplit(nxt)
                if nu.netloc == su.netloc and nu.scheme == "https" and nu.path.startswith(prefix) and nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
