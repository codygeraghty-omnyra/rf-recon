"""The Data desk in DAStastic (Cody 11/8): the portable kit (datadesk/) wired to the app.

- sources(): the one registry over reference/data_sources.json, static/research/permit_sources.json and
  reference/data_desk.json, with cadence from the updater's own intervals.
- watch(): each source as the updater sees it now: on or off, fresh, stale (older than twice its cadence), failed, or
  waiting for a key, with its last good update and the updater's own why.
- sync(): files the "Needs a person" tasks the registry and the updater show: a key a source needs and doesn't have, a
  source the provider refused (401, 403, 429, 451, 503, a challenge or sign-in page), and the hand-written tasks in the
  desk file (RepeaterBook's permission). A task marked done is re-tested here: it closes only when the source's next run
  succeeds after it was marked, and goes back on the list if that run fails.
- view(): what Data & updates shows, and what Josh's morning update and Needs you count.
"""
import datetime
import os
import re

from datadesk import persons, registry

HERE = os.path.dirname(os.path.abspath(__file__))
CAT = os.path.join(HERE, "reference", "data_sources.json")
PERMITS = os.path.join(HERE, "static", "research", "permit_sources.json")
DESK = os.path.join(HERE, "reference", "data_desk.json")
REFUSAL = re.compile(r"\b(401|403|429|451|503)\b|forbidden|unauthori[sz]ed|refus|captcha|challenge|rate.?limit|too many requests|sign.?in page",
                     re.I)
KEY_STEPS = ["Open the link and make an account, or sign in to yours.", "Copy the key from the page the link names.",
             "Paste it in Data & updates, Your API keys, and press Save keys. Then press Done here: DAStastic tries the source again."]


_CACHE = {"key": None, "val": None}


def sources():
    """The registry, read again only when one of its three files changed (a view of Data & updates reads it each time)."""
    import copy
    import updater
    key = tuple(os.path.getmtime(p) if os.path.exists(p) else 0 for p in (CAT, PERMITS, DESK))
    if _CACHE["key"] != key:
        _CACHE["val"], _CACHE["key"] = registry.load(CAT, PERMITS, DESK, {k: v[2] for k, v in updater.SOURCES.items()}), key
    return copy.deepcopy(_CACHE["val"])


def _t(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "")[:19])
    except ValueError:
        return None


def watch(snapshot, srcs=None, now=None):
    """One line per registry source the app fetches: route, access, owner, state, last good, age and the updater's why."""
    now = now or datetime.datetime.now()
    ups = (snapshot or {}).get("sources") or {}
    out = []
    for s in srcs or sources():
        st = [dict(ups[u], id=u) for u in s["updater"] if u in ups]
        if not st:
            continue
        on = [x for x in st if x.get("enabled")]
        last = max((t for t in (_t(x.get("last_updated")) for x in st) if t), default=None)
        age_h = round((now - last).total_seconds() / 3600, 1) if last else None
        need = any(x["access"].get("needs_key") and not x["access"].get("key_saved") for x in on)
        failed = [x for x in on if x.get("failed") or x.get("state") == "error"]
        if not on:
            state = "off"
        elif need:
            state = "needs a key"
        elif failed:
            state = "failed"
        elif s["cadence_h"] and age_h is not None and age_h > 2 * s["cadence_h"]:
            state = "stale"
        elif last is None:
            state = "never fetched"
        else:
            state = "fresh"
        out.append({"id": s["id"], "name": s["name"], "route": s["route"], "access": s["access"], "owner": s["owner"],
                    "cadence_h": s["cadence_h"], "updater": s["updater"], "state": state,
                    "last_good": last.isoformat(timespec="minutes") if last else None, "age_h": age_h,
                    "message": "; ".join(f"{x['id']}: {x.get('message')}" for x in failed if x.get("message"))[:300],
                    "why": next((x.get("why") for x in on if x.get("why")), ""),
                    "signup": next((x["access"].get("signup") or x["access"].get("url") for x in st if x["access"].get("signup") or x["access"].get("url")), s["url"]),
                    "where_key": next((x["access"].get("where_key") for x in st if x["access"].get("where_key")), ""),
                    "_last": last})
    return out


def sync(con, snapshot, srcs=None, now=None):
    """File the tasks the sources show, and re-test the ones marked done. Returns {"filed", "closed", "reopened"}."""
    persons.ensure(con)
    srcs = srcs or sources()
    rows = watch(snapshot, srcs, now)
    by_id = {s["id"]: s for s in srcs}
    filed = closed = reopened = 0
    for w in rows:
        s = by_id[w["id"]]
        if w["state"] == "needs a key":
            persons.file(con, s, "key", f"{s['name']} is switched on but has no key saved, so it can't download.", link=w["signup"],
                         steps=KEY_STEPS, enter="the API key" + (f" ({w['where_key']})" if w["where_key"] else ""),
                         key_goes="Data & updates, Your API keys", count=False)
            filed += 1
        elif w["state"] == "failed" and REFUSAL.search(w["message"] or ""):
            persons.file(con, s, "refused", f"{s['name']} refused DAStastic's request, so its data isn't updating.", link=s["url"],
                         steps=persons.STEPS_REFUSED, detail=w["message"], count=False)
            filed += 1
    for s in srcs:  # the hand-written ones in the desk file
        if s.get("person_task"):
            kind = "paid" if s["access"] == "paid" else "permission" if s["access"] == "form" else "sign-up"
            persons.file(con, s, kind, s["person_task"], link=s["url"], steps=[s["person_task"]], detail=s.get("note", ""), count=False, once=True)
    w_by = {w["id"]: w for w in rows}
    for t in persons.open_tasks(con):  # done: closes when a run after it succeeded; back on the list if one failed
        if t["status"] != "done" or t["source_id"] not in w_by:
            continue
        w, done = w_by[t["source_id"]], _t(t["done_at"])
        if w["_last"] and done and w["_last"] > done and w["state"] in ("fresh", "stale"):
            persons.retest(con, t["id"], lambda w=w: (True, f"updated {w['last_good']}"))
            closed += 1
        elif w["state"] in ("failed", "needs a key") and done and (now or datetime.datetime.now()) - done > datetime.timedelta(minutes=10):
            persons.retest(con, t["id"], lambda w=w: (False, w["message"] or w["why"] or w["state"]))
            reopened += 1
    return {"filed": filed, "closed": closed, "reopened": reopened}


def view(con, snapshot):
    srcs = sources()
    s = sync(con, snapshot, srcs)
    rows = [{k: v for k, v in w.items() if k != "_last"} for w in watch(snapshot, srcs)]
    return {"sources": rows, "tasks": persons.open_tasks(con), "summary": persons.summary(con), "problems": registry.problems(srcs, DESK),
            "counts": {k: sum(1 for w in rows if w["state"] == k) for k in ("fresh", "stale", "failed", "needs a key", "never fetched", "off")},
            "sync": s}
