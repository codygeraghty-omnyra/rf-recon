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
  GET  /api/das/x/code/<job>                the Code check: state rule, searches, questions, draft email (codecheck.py)
  POST /api/das/x/code/<job>                what the AHJ confirmed, who and when
  POST /api/das/x/book/<job>                {id}: a person takes an AHJ book entry's answers. The job stays unconfirmed (ahjbook.py)
  POST /api/das/x/book/<job>/undo           those answers taken back out
  POST /api/das/x/reply/<job>               {id}: a reply on Needs you, to read. {id, done}: closed once it's been pressed (dasmail.py)
  GET  /api/das/x/gate/<job>?to=Stage       what a move to that stage still needs
  POST /api/das/x/retest/<job>              {take: key, date?} a person sets a proposed retest date; {no: key} turns it down (retest.py)
  GET  /api/das/x/tunnels?lat&lon&radius_m  road and rail tunnels near a point (tunnels.py)
  POST /api/das/x/tunnels/prospects         {lat, lon, radius}: tunnels into the prospect list
"""
import re
import sys

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
    if sys.platform != "emscripten":  # the web version has no mail: its modules don't load there (app.py mail_route)
        try:
            import dasmail
            out += dasmail.board(con, jid, d, stage)  # consent and AHJ replies waiting on a press
        except Exception as e:
            out.append({"text": f"email replies couldn't be read: {str(e)[:80]}", "url": "", "source": ""})
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
        _job(con, jid)
        d = body()
        key = daswatch.licensee_key(d.get("key") or d.get("licensee"))
        if not key:
            raise ValueError("Which licensee?")
        if d.get("status") and d["status"] not in CONSENT_STATUS:
            raise ValueError(f"Consent status is one of: {', '.join(CONSENT_STATUS)}.")

        def work(data):
            # judged on the job as it is, in the save's own transaction (review round 6, then round 7: read before it, a Mark given
            # landing at the same moment was still lost): only this licensee's record changes
            cons = dict(data.get("consents") or {})
            cur = dict(cons.get(key) or {})
            # a consent email's "asked" never goes over an answer saved since the list was drawn (only_if_unasked), and an edit with no
            # status (a date changed in the passband table) keeps the status the job has
            if d.get("only_if_unasked") and cur.get("status") in ("given", "refused", "not needed"):
                return {}
            # was: the status the person's table showed when they changed it (review round 6). When the job's is another now, nothing
            # changes and the page is told
            was = d.get("was")
            if was is not None and (cur.get("status") or "not asked") != was:
                raise ValueError(f"{cur.get('licensee') or key} is {cur.get('status') or 'not asked'}"
                                 f"{' (' + cur['date'] + ')' if cur.get('date') else ''} now, saved since this table was drawn: nothing was changed.")
            st = d.get("status") or cur.get("status") or "not asked"
            cur.update(licensee=d.get("licensee") or cur.get("licensee") or key, status=st,
                       calls=sorted({c.upper() for c in (d.get("calls") or cur.get("calls") or []) if isinstance(c, str)}))
            for k in ("date", "note"):
                if k in d:
                    cur[k] = (d.get(k) or "").strip()[:300]
            cons[key] = cur
            return {"consents": cons}
        return 200, das.save_job(con, {"data": {}}, jid, work=work)
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
    if what == "here" and jid:  # the building, who responds and the nearest stations, from open data (deskpoint.py, Cody 11/8)
        import deskpoint
        j = _job(con, jid)
        if j["data"].get("lat") is None:
            raise ValueError("Set the building's location first.")
        return 200, deskpoint.lookup(con, float(j["data"]["lat"]), float(j["data"]["lon"]))
    if what == "towair" and jid:  # does the donor mast need FAA notice and FCC registration (towair.py, Cody 11/8)
        import terrain
        import towair
        j = _job(con, jid)
        if j["data"].get("lat") is None:
            raise ValueError("Set the building's location first.")
        if not con.execute("SELECT 1 FROM sqlite_master WHERE name='faa_airport'").fetchone():
            raise LookupError("The FAA's airport list isn't on this copy yet: Data & updates, FAA aviation, Update now.")
        bldg = float((qs.get("bldg_m") or [0])[0] or 0)
        mast = float((qs.get("mast_m") or [3])[0] or 0)
        if not 0 < bldg + mast < 700:
            raise ValueError("Give the building's height and the mast's, in metres.")
        lat, lon = float(j["data"]["lat"]), float(j["data"]["lon"])
        ground = terrain.elevation(lat, lon)
        if ground is None:
            raise ValueError("The ground elevation there couldn't be read (terrain tiles need a connection once).")
        return 200, dict(towair.check(con, lat, lon, ground, bldg + mast), bldg_m=bldg, mast_m=mast, ground_m=round(ground, 1))
    if what == "bcast" and jid:  # FM and TV stations strong at the building, from the FCC's Contours API (bcastcover.py, Cody 11/8)
        import bcastcover
        j = _job(con, jid)
        if j["data"].get("lat") is None:
            raise ValueError("Set the building's location first.")
        return 200, bcastcover.lookup(con, float(j["data"]["lat"]), float(j["data"]["lon"]))
    if what == "code" and jid:
        import codecheck
        j = _job(con, jid)
        if method == "POST":
            return 200, codecheck.confirm(con, j, body(), uls_import.DATA_DIR)
        import ahjbook
        return 200, {**codecheck.plan(j, uls_import.DATA_DIR), "book": ahjbook.offers(con, j, uls_import.DATA_DIR, vis=ahjbook.team_vis(con))}
    if what == "book" and jid and method == "POST":
        import ahjbook
        j = _job(con, jid)
        return 200, ahjbook.undo(con, j) if sub == "undo" else ahjbook.use(con, j, body().get("id"), vis=ahjbook.team_vis(con))
    if what == "gate" and jid:
        import codecheck
        return 200, {"needs": codecheck.gate(_job(con, jid), (qs.get("to") or [""])[0])}
    if what == "retest" and jid and method == "POST":  # app.py das_route gates a POST here on edit
        import retest
        return 200, retest.press(con, _job(con, jid), body())
    if what == "reply" and jid and method == "POST":  # POST to read it too: a look-only or AHJ login gets neither (app.py das_route gates POST on edit)
        import dasmail
        _job(con, jid)
        d = body()
        return 200, dasmail.reply_done(con, jid, d.get("id"), d["done"]) if d.get("done") else dasmail.reply_text(con, jid, d.get("id"))
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
