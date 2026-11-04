"""
The DAS job's licence and site checks, served under /api/das/x/ (app.py das_route hands these paths here):

  GET  /api/das/x/contacts?calls=A,B        each licence's own licensee and contact (ulscontacts.py)
  GET  /api/das/x/passband/<job>            licensees inside the booster's passbands, with consent status (daswatch.py)
  POST /api/das/x/consent/<job>             {key, licensee, calls, status, date, note}: one licensee's consent
  GET  /api/das/x/watch/<job>[?force=1]     the licence change watch, checked now (daswatch.py)
  POST /api/das/x/watch/<job>/ack           {key, on}: a change marked handled (or not)
  POST /api/das/x/watch/<job>/baseline      today's FCC data as the new baseline
  GET  /api/das/x/audit/<job>               the existing-system audit (dasaudit.py)
  GET  /api/das/x/ahj/<job>                 fire departments covering the address (ahj.py)
  POST /api/das/x/ahj/refresh               download the USFA registry (about 12 MB)
  GET  /api/das/x/tunnels?lat&lon&radius_m  road and rail tunnels near a point (tunnels.py)
  POST /api/das/x/tunnels/prospects         {lat, lon, radius}: tunnels into the prospect list
"""
import re

import das
import dasaudit
import daswatch
import ulscontacts
import uls_import

CONSENT_STATUS = ("not asked", "asked", "given", "refused", "not needed")


def _num(qs, k, d=None):
    try:
        return float(qs.get(k, [""])[0])
    except (TypeError, ValueError):
        return d


def board(con, jid, d, stage):
    """Every "Needs you" line from these checks for one job (the board's list, das.list_jobs)."""
    out = []
    try:
        out += daswatch.board(con, jid, d, stage)
    except Exception as e:  # never stops the board drawing; said in its line instead
        out.append({"text": f"licence watch couldn't run: {str(e)[:80]}", "url": "", "source": ""})
    try:
        out += dasaudit.board(d, stage)
    except Exception as e:
        out.append({"text": f"existing system audit couldn't run: {str(e)[:80]}", "url": "", "source": ""})
    return out


def _job(con, jid):
    j = das.job_row(con, jid)
    if j is None:
        raise LookupError(f"Job {jid} was deleted. Reload to see the current jobs.")
    return j


def route(con, method, p, qs, body):
    """(status, answer) for a /api/das/x/ path. body() reads the posted JSON."""
    m = re.match(r"^/api/das/x/(\w+)(?:/(\d+))?(?:/(\w+))?$", p)
    if not m:
        raise LookupError("No such page.")
    what, jid, sub = m.group(1), int(m.group(2)) if m.group(2) else None, m.group(3)
    if what == "contacts":
        calls = [c for c in (qs.get("calls", [""])[0] or "").split(",") if c]
        return 200, {"contacts": ulscontacts.for_calls(con, calls[:300]), "kept": ulscontacts.has_table(con),
                     "note": "From the FCC's own licence records. The contact is often a consulting engineer or a radio shop, not the agency."}
    if what == "passband" and jid:
        j = _job(con, jid)
        return 200, daswatch.passband(con, j["data"])
    if what == "consent" and jid and method == "POST":
        j, d = _job(con, jid), body()
        key = daswatch.licensee_key(d.get("key") or d.get("licensee"))
        if not key:
            raise ValueError("Which licensee?")
        st = d.get("status") or "not asked"
        if st not in CONSENT_STATUS:
            raise ValueError(f"Consent status is one of: {', '.join(CONSENT_STATUS)}.")
        cons = dict(j["data"].get("consents") or {})
        cur = dict(cons.get(key) or {})
        cur.update(licensee=d.get("licensee") or cur.get("licensee") or key, status=st,
                   calls=sorted({c.upper() for c in (d.get("calls") or cur.get("calls") or []) if isinstance(c, str)}))
        for k in ("date", "note"):
            if k in d:
                cur[k] = (d.get(k) or "").strip()[:300]
        cons[key] = cur
        return 200, das.save_job(con, {"data": {"consents": cons}}, jid)
    if what == "watch" and jid:
        j = _job(con, jid)
        if method == "POST" and sub == "ack":
            d = body()
            w = daswatch.ack(con, jid, j["data"], str(d.get("key") or ""), d.get("on", True) is not False)
        elif method == "POST" and sub == "baseline":
            w = daswatch.baseline(con, jid, j["data"])
        else:
            w = daswatch.check(con, jid, j["data"], j["stage"], force=qs.get("force", [""])[0] == "1")
        return 200, {**{k: w.get(k) for k in daswatch.KEEP_KEYS}, "built_at": daswatch.built_at(con), "calls": daswatch.calls_of(j["data"]),
                     "open": daswatch.open_items(w)}
    if what == "audit" and jid:
        j = _job(con, jid)
        return 200, dasaudit.audit(j["data"], j["stage"])
    if what == "ahj" and jid:
        import ahj
        j = _job(con, jid)
        if j["data"].get("lat") is None:
            raise ValueError("Set the building's location first.")
        try:
            return 200, ahj.lookup(uls_import.DATA_DIR, float(j["data"]["lat"]), float(j["data"]["lon"]), j["data"].get("address") or "")
        except LookupError as e:
            return 404, {"error": str(e), "status": ahj.status(uls_import.DATA_DIR), "page": ahj.SOURCE["page"], "license": ahj.SOURCE["license"]}
    if what == "tunnels" and jid is None and sub is None:
        import tunnels
        lat, lon = _num(qs, "lat"), _num(qs, "lon")
        if lat is None or lon is None:
            raise ValueError("Where? lat and lon.")
        return 200, tunnels.near(lat, lon, _num(qs, "radius_m", 400), fresh=qs.get("fresh", [""])[0] == "1")
    raise LookupError("No such page.")


def route_named(con, method, p, qs, body):
    """The two POSTs whose path ends in a word, not a job number."""
    if p == "/api/das/x/ahj/refresh" and method == "POST":
        import ahj
        r = ahj.refresh(uls_import.DATA_DIR)
        return 200, {**r, **ahj.status(uls_import.DATA_DIR)}
    if p == "/api/das/x/tunnels/prospects" and method == "POST":
        import tunnels
        d = body()
        n = tunnels.to_prospects(uls_import.DATA_DIR, float(d.get("lat")), float(d.get("lon")), float(d.get("radius") or 3))
        return 200, {"tunnels": n}
    return None


def handle(con, method, p, qs, body):
    """The entry point app.py calls: (status, answer)."""
    return route_named(con, method, p, qs, body) or route(con, method, p, qs, body)
