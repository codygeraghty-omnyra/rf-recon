"""One registry for every outside source (Data desk step 1).

The lists that already describe the sources stay as they are and keep working: a catalogue (DAStastic's
reference/data_sources.json: name, url, key, cost, terms, status, the updater ids it covers) and a permit-dataset list
(static/research/permit_sources.json: id, terms_url, licence, rate limit, personal fields). The desk's own fields sit in
an overlay (reference/data_desk.json), keyed by source id, and load() merges the three. A field the overlay doesn't set
is worked out from what the lists say, and the source's "derived" list names each one worked out that way, so a person
can see what was decided by hand and what was guessed.

Desk fields:
  route          server | pc | import | git: where it is fetched. pc only where the key holder's own machine is the
                 permitted client (WiGLE's personal key); git (a scheduled runner) only for open data, never to get
                 round a provider's cloud block: a runner is a cloud machine too.
  access         open | key | sign-in | form | paid
  crawl          {"allowed", "robots", "rate_s", "page_cap"}: a bounded crawl only where robots and the terms allow it
  scrub          the cleaning profile its rows go through (clean.py)
  cadence_h      how often it's fetched
  owner          who handles its person tasks: Cody, or Josh for anything paid or contractual
  terms_checked  {"date", "url"}: when its terms were last read on the provider's own page, and where
  quota          {"per_day", ...}: the provider's allowance, when it has one

Standard library only; nothing here imports DAStastic.
"""
import json
import os
import re

ROUTES = ("server", "pc", "import", "git")
ACCESS = ("open", "key", "sign-in", "form", "paid")
FIELDS = ("route", "access", "crawl", "scrub", "cadence_h", "owner", "terms_checked", "quota")
CRAWL_DEFAULT = {"allowed": False, "robots": True, "rate_s": 2.0, "page_cap": 0}
UPDATE_H = {"hourly": 1, "daily": 24, "weekly": 168, "monthly": 720, "quarterly": 2160, "yearly": 8760}


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")[:60]


def _read(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _first_date(s):
    m = re.search(r"\b(20\d\d-\d\d-\d\d)\b", str(s or ""))
    return m.group(1) if m else None


def derive_access(entry):
    """open | key | sign-in | paid, from a catalogue entry's key and cost columns (paid wins, then sign-in, then key)."""
    key, cost = str(entry.get("key") or "").lower(), str(entry.get("cost") or "").lower()
    if "$" in cost or "premium" in cost or re.search(r"\bpaid\b", cost):
        return "paid"
    if key.startswith("none") or key in ("", "n/a"):
        return "open"
    if re.search(r"\b(key|token)\b", key) and not re.search(r"oauth", key):  # "free key with an account": a key, got once
        return "key"
    if re.search(r"account|sign[ -]?in|oauth|log ?in", key):
        return "sign-in"
    return "key"


def _catalogue(cat, intervals):
    when = _first_date(cat.get("_about"))
    out = []
    for e in cat.get("sources") or []:
        ups = e.get("updater") or []
        access = derive_access(e)
        cadence = next((intervals[u] for u in ups if u in intervals), None)
        out.append({"id": slug(e["name"]), "name": e["name"], "kind": "catalogue", "url": e.get("url") or "", "updater": ups,
                    "status": e.get("status") or "", "terms": e.get("terms") or "", "signup": e.get("signup") or "",
                    "where_key": e.get("where_key") or "", "keys": e.get("keys") or [],
                    "_derive": {"route": "server", "access": access, "crawl": dict(CRAWL_DEFAULT), "scrub": "default",
                                "cadence_h": cadence, "owner": "Josh" if access == "paid" else "Cody",
                                "terms_checked": {"date": when, "url": e.get("url") or ""}, "quota": {}}})
    return out


def _permits(reg):
    when = _first_date(reg.get("updated"))
    out = []
    for p in reg.get("sources") or []:
        out.append({"id": f"permit:{p['id']}", "name": p.get("name") or p["id"], "kind": "permit", "url": p.get("portal_url") or "",
                    "updater": [], "status": "on by default" if p.get("enabled_default") else "off by default",
                    "terms": p.get("license") or "", "personal_fields": p.get("personal_fields") or [],
                    "_derive": {"route": "server", "access": "open", "crawl": dict(CRAWL_DEFAULT), "scrub": "permit",
                                "cadence_h": UPDATE_H.get(str(p.get("update") or "").lower()), "owner": "Cody",
                                "terms_checked": {"date": when, "url": p.get("terms_url") or p.get("license_url") or ""},
                                "quota": {"note": p["rate_limit"]} if p.get("rate_limit") else {}}})
    return out


def load(catalog_path, permits_path=None, overlay_path=None, intervals=None):
    """Every source with every desk field. intervals: {updater id: hours} from the app's own updater, so cadence follows
    what the app really does."""
    intervals = intervals or {}
    srcs = _catalogue(_read(catalog_path), intervals) + _permits(_read(permits_path))
    over = (_read(overlay_path).get("sources") or {})
    by_id = {s["id"]: s for s in srcs}
    for sid, o in over.items():  # a source only the desk knows yet (a new one on its way in): it names itself
        if sid not in by_id and o.get("name"):
            s = {"id": sid, "name": o["name"], "kind": "desk", "url": o.get("url") or "", "updater": o.get("updater") or [],
                 "status": o.get("status") or "not in the app yet", "terms": o.get("terms") or "",
                 "_derive": {"route": "server", "access": "open", "crawl": dict(CRAWL_DEFAULT), "scrub": "default", "cadence_h": None,
                             "owner": "Cody", "terms_checked": {"date": None, "url": o.get("url") or ""}, "quota": {}}}
            srcs.append(s)
            by_id[sid] = s
    for s in srcs:
        d, o = s.pop("_derive"), over.get(s["id"]) or {}
        s["derived"] = [f for f in FIELDS if f not in o]
        for f in FIELDS:
            v = o.get(f, d[f])
            s[f] = dict(d[f], **v) if f == "crawl" and isinstance(v, dict) else v
        for k in ("why", "note", "person_task"):
            if o.get(k):
                s[k] = o[k]
    return srcs


def problems(sources, overlay_path=None, today=None, stale_days=180):
    """What a person should fix in the registry: bad values, a pc or git route without its reason, paid work not with
    Josh, terms never checked or not checked in stale_days, ids used twice, overlay entries that match nothing."""
    out, seen = [], set()
    for s in sources:
        sid = s["id"]
        if sid in seen:
            out.append(f"{sid}: the id is used twice")
        seen.add(sid)
        if s["route"] not in ROUTES:
            out.append(f"{sid}: route {s['route']!r} isn't one of {', '.join(ROUTES)}")
        if s["access"] not in ACCESS:
            out.append(f"{sid}: access {s['access']!r} isn't one of {', '.join(ACCESS)}")
        if s["route"] in ("pc", "git") and not s.get("why"):
            out.append(f"{sid}: route {s['route']} needs a why (whose machine is the permitted client, or why open data needs a runner)")
        if s["route"] == "git" and s["access"] != "open":
            out.append(f"{sid}: route git is for open data only")
        if s["access"] == "paid" and s["owner"] != "Josh":
            out.append(f"{sid}: paid, so its person tasks go to Josh")
        crawl = s["crawl"] or {}
        if crawl.get("allowed") and (not crawl.get("robots") or not crawl.get("page_cap") or (crawl.get("rate_s") or 0) < 1):
            out.append(f"{sid}: a crawl must honour robots.txt, cap its pages and wait at least 1 s between pages")
        date = (s.get("terms_checked") or {}).get("date")
        if in_use(s) and not (s.get("terms_checked") or {}).get("url"):
            out.append(f"{sid}: in use with no terms page recorded")
        if not date:
            out.append(f"{sid}: terms never checked on the provider's own page")
        elif today and _days(date, today) > stale_days:
            out.append(f"{sid}: terms last checked {date}, over {stale_days} days ago")
    over = (_read(overlay_path).get("sources") or {}) if overlay_path else {}
    out += [f"{k}: in the desk file but in no list, and no name of its own" for k in over if k not in seen]
    return out


def _days(a, b):
    import datetime
    return (datetime.date.fromisoformat(b[:10]) - datetime.date.fromisoformat(a[:10])).days


def in_use(s):
    return bool(re.match(r"(?i)in dastastic|on by default", s.get("status") or ""))


def credits(sources):
    """Attribution lines for the sources in use: name, terms or licence, link."""
    live = [s for s in sources if in_use(s)]
    return [{"name": s["name"], "terms": s.get("terms") or "", "url": s.get("url") or ""} for s in sorted(live, key=lambda s: s["name"].lower())]
