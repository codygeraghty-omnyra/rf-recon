"""
Code check and stage gates (Cody 11/5: "we want the most functionality", "make the biggest version first").

Code check answers, for a job's address: which fire code applies, can an ERCES be required here at all, what we already
hold on this jurisdiction, and who at the AHJ confirmed it and when. Nothing here decides for the AHJ: the state table
(static/research/state_rules.json) is a lead with each row's reading level, and a job isn't checked until a person records
who confirmed it. No national list of local adoptions exists, and the municipal code sites don't allow robots (ICC's terms
cover General Code and American Legal), so DAStastic fetches none of them: links() prepares searches a person clicks.

Stage gates: Joe 11/5, "the only way a checklist works it is it's enforced". A move forward is refused until what the stage
needs is on file. A person can move anyway by giving a reason, which goes in the job's log, because a real job can arrive
half way through. An example job and a move back or to Closed are never gated. Each gate names the step that fixes it.
"""
import json
import os
import re
import time
import urllib.parse

import das

RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "state_rules.json")
_rules = None

# Joe 11/5: say it stronger. The AHJ's authority is final, not a role description
AUTHORITY = ("The AHJ has the final say on this building. What's in the adopted code, they enforce. What isn't, they can "
             "still ask for. Get their answer in writing before you design to it.")
LAND_NOTE = "On state, federal or tribal land the local code may not apply: ask the owner who their fire code official is."
QUESTIONS = ["Which fire code and edition do you enforce, and what have you amended?",
             "Do you have a written policy or guideline for emergency responder radio coverage (ERCES, BDA)?",
             "Who makes the final call on this, and how do we appeal a decision?",
             "Who runs the radio system here, and who at that agency approves a booster?",
             "Do you need a third-party tester, or a particular test tool?",
             "At which stages of the job do you want to be involved?"]
FIELDS = ("code", "edition", "amendment", "policy", "final_say", "radio_shop", "third_party", "stages", "read_url", "read_note", "confirmed_by", "confirmed_on", "how", "note")
# never "not required": the panel says what we read, and that the AHJ hasn't confirmed it (the 11/5 trial's wording rule)
READING = {"no_mandate": "On what we read, no state agency or local government here can require a system.",
           "local": "On what we read, nothing statewide requires a system. It depends on the local code.",
           "discretion": "On what we read, the state's code has exceptions, or leaves it to the fire official.",
           "required": "On what we read, the state's code requires a system, unless an exception applies.",
           "unknown": "We found no state rule either way."}
COMMISSION_TESTS = ("noise_floor", "isolation", "gain", "oscillation", "donor_level", "two_radio")


def rules():
    global _rules
    if _rules is None:
        try:
            with open(RULES_FILE, encoding="utf-8") as fh:
                _rules = json.load(fh)
        except (OSError, ValueError):  # no table on this copy: every state reads "unknown", and a save still goes through
            _rules = {"states": {}}
    return _rules


def state_row(state):
    return rules()["states"].get((state or "").strip().upper())


def level(state):
    """How far the state's rule reaches. "unknown" for a state with no row: list rows can carry a bad or blank one."""
    return (state_row(state) or {}).get("level") or "unknown"


def status(d):
    """Not started, started (something written down), or confirmed (a person and a date). Only confirmed clears the gate."""
    c = (d or {}).get("code_check") or {}
    if (c.get("confirmed_by") or "").strip() and (c.get("confirmed_on") or "").strip():
        return "confirmed"
    return "started" if any((c.get(k) or "").strip() for k in FIELDS) else "not started"


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def links(place, county, state, website=""):
    """Searches and places to look. A person clicks these: DAStastic doesn't fetch them. A platform link is a guess at the
    address, and many cities aren't on that platform, so it can come up empty."""
    r = state_row(state) or {}
    name, st = r.get("name") or state or "", (state or "").lower()
    who = place or county or name
    g = lambda q: "https://www.google.com/search?q=" + urllib.parse.quote(q)
    out = [{"step": "State", "label": f"{name} fire marshal", "url": r.get("fire_marshal") or "https://www.firemarshals.org/State-Fire-Marshals"},
           {"step": "Amendment", "label": "Search for the local amendment", "url": g(f'"{who}" {name} fire code amendment "510" emergency responder radio coverage')},
           {"step": "Amendment", "label": "Search the municipal code", "url": g(f'{who} {name} municipal code fire code chapter')}]
    if place:
        s = _slug(re.sub(r"^City of ", "", place))
        out += [{"step": "Amendment", "label": "Municode", "url": f"https://library.municode.com/{st}/{s}", "guess": True},
                {"step": "Amendment", "label": "American Legal", "url": f"https://codelibrary.amlegal.com/codes/{s}/latest/overview", "guess": True},
                {"step": "Amendment", "label": "Code Publishing", "url": f"https://{s}.municipal.codes/", "guess": True},
                {"step": "Amendment", "label": "Municipal Code Online", "url": f"https://{s}.municipalcodeonline.com/", "guess": True}]
    out.append({"step": "Guideline", "label": "Search for the fire department's guideline", "url": g(f'{who} fire department ERCES OR BDA OR "radio coverage" guideline OR standard')})
    if website:
        out.append({"step": "Guideline", "label": "The department's website", "url": website if re.match(r"^https?:", website, re.I) else "https://" + website})
    out.append({"step": "Edition", "label": "ICC adoption map (state level)", "url": "https://www.iccsafe.org/about/overview/international-code-adoptions/"})
    return out


def reading(state):
    """Our reading of a state, in a line for the card and the draft. A lead, labelled as one."""
    r = state_row(state)
    if not r:
        return ""
    c = r.get("fire_code") or {}
    code = " ".join(x for x in (c.get("base"), f"({c.get('edition')})" if c.get("edition") else "") if x)
    return f"{r['name']}: {code}. {READING[r['level']]}"


def draft(job, state=""):
    """The email a person reads, changes and sends. Our reading goes in so the AHJ only has to correct it. Nothing sends
    without a click (dasmail.py)."""
    d = job.get("data") or {}
    addr = d.get("address") or job.get("name") or "this building"
    lines = ["Hello,", "", f"We're looking at in-building emergency responder radio coverage at {addr}. Before we design anything, we'd like to confirm what you require."]
    if state_row(state):
        lines += ["", f"Our reading, which may be wrong: {reading(state)} Is that right for this building?"]
    lines += ["", "Could you tell us:", ""]
    lines += [f"{i}. {q}" for i, q in enumerate(QUESTIONS, 1)]
    lines += ["", "If you have a policy or a checklist, a copy is all we need. Thank you."]
    return {"subject": f"Radio coverage requirements for {addr}", "body": "\n".join(lines)}


def where_of(job, data_dir, fetch=None):
    """(the Census answer for the pin or None, what the typed address says). No data_dir: the typed address only."""
    import ahj
    d = job.get("data") or {}
    where = None
    if data_dir and d.get("lat") is not None:
        try:
            where = ahj.place_of(float(d["lat"]), float(d["lon"]), data_dir, fetch)
        except Exception:  # no network, or the Census service is down: the typed address still names the state
            where = None
    return where, ahj.parse_address(d.get("address") or "")


def plan(job, data_dir, fetch=None):
    """Everything the Code check card shows. A place lookup that fails still gives the state from the typed address."""
    d = job.get("data") or {}
    where, typed = where_of(job, data_dir, fetch)
    state = (where or {}).get("state") or typed.get("state") or ""
    place, county = (where or {}).get("place") or typed.get("city") or "", (where or {}).get("county") or ""
    guess = ((d.get("ahj_guess") or {}).get("list") or [{}])[0] if d.get("ahj_guess") else {}
    r, cc = state_row(state), d.get("code_check") or {}
    stale = bool(r and cc.get("rule_seen") and cc["rule_seen"] != _seen(r))  # the state row moved since the AHJ confirmed
    return {"state": state, "place": place, "county": county, "rule": r, "links": links(place, county, state, guess.get("website") or ""),
            "questions": QUESTIONS, "draft": draft(job, state), "authority": AUTHORITY, "land": LAND_NOTE, "check": cc, "status": status(d), "reading": reading(state), "says": READING[r["level"]] if r else "",
            "tribal": (where or {}).get("tribal") or "", "stale": stale, "checked": rules().get("checked"), "labels": rules().get("labels")}


def _seen(r):
    return f"{r['level']}|{(r.get('fire_code') or {}).get('edition')}"


def confirm(con, job, body, data_dir=None, fetch=None):
    """Saves what the AHJ said. Only these fields, each cut to a sane length. A confirmed answer also goes in the AHJ book
    (ahjbook.py), where the next job there is offered it. The book never comes back through here on its own."""
    cur = dict((job.get("data") or {}).get("code_check") or {})
    for k in FIELDS:
        if k in (body or {}):
            cur[k] = str(body.get(k) or "").strip()[:1000]
    if (cur.get("confirmed_by") or "").strip() and not (cur.get("confirmed_on") or "").strip():
        cur["confirmed_on"] = time.strftime("%Y-%m-%d")
    r = state_row((body or {}).get("state"))
    if r and (cur.get("confirmed_on") or "").strip():
        cur["rule_seen"] = _seen(r)
    saved = das.save_job(con, {"data": {"code_check": cur}}, job["id"])
    import ahjbook
    ahjbook.keep(con, saved, data_dir, fetch)
    return saved


def _need(key, text, sub):
    return {"key": key, "text": text, "sub": sub}


def _open(d, key):
    """Run it for me chose this for someone (dasauto.js): it doesn't count until a person says it looks right, so a guess can't clear a gate."""
    return key in ((d.get("auto") or {}).get("open") or [])


def stage_needs(d, stage):
    """What must be on file to leave a stage. Only what DAStastic can see: a stage's other work is in the fault chart."""
    d = d or {}
    ck, scope = d.get("checks") or {}, das.job_scope(d)
    ps, cell = scope["ps"], scope["cell"]
    out = []
    if stage == "Lead":
        if d.get("lat") is None:
            out.append(_need("pin", "The building's pin", "overview"))
        if not (d.get("ahj") or "").strip():
            out.append(_need("ahj", "The AHJ named", "overview"))
        elif _open(d, "ahj"):
            out.append(_need("ahj", "The AHJ DAStastic filled in: check it", "overview"))
        if status(d) != "confirmed":
            out.append(_need("code", "Code check: who at the AHJ confirmed the code, and when", "overview"))
    elif stage == "Pre-survey":
        if ps:
            if not (d.get("presurvey") or {}).get("plan"):
                out.append(_need("plan", "A saved channel plan", "presurvey"))
            elif _open(d, "plan"):
                out.append(_need("plan", "The channel plan DAStastic filled in: check it", "presurvey"))
            if not d.get("profile"):
                out.append(_need("profile", "The AHJ's requirements picked", "require"))
            if not any((c or {}).get("status") not in (None, "", "not asked") for c in (d.get("consents") or {}).values()):
                out.append(_need("asked", "Consent asked of the licensees", "presurvey"))
        if cell:
            C = d.get("cellular") or {}
            if not C.get("donor"):
                out.append(_need("donor", "A rooftop reading for each carrier", "presurvey"))
            if not C.get("approvals"):
                out.append(_need("approvals", "An approval path for each carrier", "presurvey"))
    elif stage == "Design":
        if not ck.get("design_ok"):
            out.append(_need("design_ok", "Design approved: date on file", "overview"))
        if not ck.get("permit"):
            out.append(_need("permit", "AHJ permit: date on file", "overview"))
    elif stage == "Install":
        if ps and not ck.get("monitoring"):
            out.append(_need("monitoring", "Monitoring connected to the fire alarm panel: date on file", "overview"))
    elif stage == "Commission":
        tests = (d.get("acceptance") or {}).get("tests") or {}
        bad = [k for k in COMMISSION_TESTS if (tests.get(k) or {}).get("status") != "pass"]
        if bad:
            out.append(_need("commission", f"Commissioning: {len(bad)} of {len(COMMISSION_TESTS)} steps not passed", "commission"))
        if ps and not ck.get("consent"):
            out.append(_need("consent", "Licensee consent: date on file", "overview"))
        if ps and (d.get("booster_class") or "").startswith("Class B") and not ck.get("fcc_reg"):
            out.append(_need("fcc_reg", "FCC registration for a Class B booster: date on file", "overview"))
    elif stage == "Acceptance":
        if not (ck.get("accepted_on") or d.get("accepted_on")):
            out.append(_need("accepted", "The AHJ's acceptance: date on file", "overview"))
    return out


def gate(job, to):
    """What's missing to move a job to stage to: every stage it would leave. Empty when nothing stops it."""
    d, frm = job.get("data") or {}, job.get("stage")
    if d.get("example") or to == "Closed" or to not in das.STAGES or frm not in das.STAGES:
        return []
    a, b = das.STAGES.index(frm), das.STAGES.index(to)
    if b <= a:
        return []
    return [dict(n, stage=s) for s in das.STAGES[a:b] for n in stage_needs(d, s)]


def gate_save(con, job, body):
    """Called on a page's save. Refuses a gated move with what's missing, or logs the reason given for moving anyway."""
    to = (body or {}).get("stage")
    if not to or to == job.get("stage"):
        return
    miss = gate(job, to)
    if not miss:
        return
    why = str((body or {}).pop("gate_reason", "") or "").strip()[:500]
    if not why:
        raise ValueError(f"Not moved to {to}. Still needed: " + "; ".join(n["text"] for n in miss) + ".")
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                (job["id"], das.now(), "gate", f"Moved to {to} without: {'; '.join(n['text'] for n in miss)}. Reason: {why}"[:2000]))
    con.commit()
