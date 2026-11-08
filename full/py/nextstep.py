"""
Next step and stage follow the file (Cody 11/6): one server function that reads a job's record and says what's done and what's
next, so the board, Start, the gates and Walk me through all read one answer.

read() gives every job a "standing" (das.job_row and das.list_jobs, computed each time, never saved):
  checks  what the record says about a step of the fault chart: True on file, False not on file, None it can't tell. These are the
          record checks Walk me through used to hold (static/dasguide.js): the guide reads them from here and walks the chart with them.
  needs   what the job's stage needs before it can leave: the gate's own list (codecheck.stage_needs). The gate stays in charge.
  move    the stage move the file supports, or None. Only a proposal: nothing here moves a stage. A person presses, and the press goes
          through the gate (dascode.js dasMoveStage), including its rule that what Run it for me chose (data.auto.open) doesn't count
          until a person says it looks right.
  next    the one next step: {text, sub, due, from}. What a person typed in next_step wins, and worked is what the file says underneath it.
  done    how much of this stage's record is on file, {on, of}.
  start   Start's four steps, done or not: stepDone moved here from start.js.
  retest  the annual or five-year retest, when one is open or has dates to propose (retest.py).

  walk    where the job stands in the chart: {tree, step, text, sub, end}. The same walk as Walk me through, on the same steps, so the board
          and the guide stop in one place, physical steps included. A stage move is the Move button beside it: the step stays what's next.
"""
import json
import os

import codecheck
import das
import retest


# ---------------------------------------------------------------- reading a job's data the way the page did
# These checks were written in JavaScript and have to give the same answer on any job (tests/test_nextstep.py holds that to the old
# table's own results): an empty list or object counts as there, 0 and "" don't, and a field of the wrong type reads as absent.

def _on(v):
    return not (v is None or v is False or v == "" or (isinstance(v, (int, float)) and not isinstance(v, bool) and v == 0))


def _g(o, *keys):
    for k in keys:
        o = o.get(k) if isinstance(o, dict) else None
    return o


def _len(v):
    return len(v) if isinstance(v, (list, str)) else 0


def _vals(o):
    return list(o.values()) if isinstance(o, dict) else o if isinstance(o, list) else []


def _some(o):
    return len(o) > 0 if isinstance(o, (dict, list, str)) else False


def _has(v):  # das.js has()
    return v is not None and v != ""


def _have(v):  # its absence means it isn't done
    return True if _on(v) else False


def _seen(v):  # its absence says nothing
    return True if _on(v) else None


def _test(d, tid):
    s = _g(d, "acceptance", "tests", tid, "status")
    return True if s == "pass" else False if s == "fail" else None


def record_checks(d):
    """What the record can say about a step: True on file, False not on file, None it can't tell. The chart's steps are physical as
    often as not, and those have no entry here. Keys are chart.step in static/dasfi_data.js; the sweep checks each one still exists."""
    d = d if isinstance(d, dict) else {}
    ck, cell, plan = _g(d, "checks"), _g(d, "cellular"), _g(d, "presurvey", "plan")
    plan = plan if _on(plan) else []
    open_ = _g(d, "auto", "open")
    opened = lambda k: isinstance(open_, (list, str)) and k in open_  # Run it for me chose it, and nobody's looked yet
    consents, approvals = _vals(_g(d, "consents")), _vals(_g(cell, "approvals"))
    asked = any(_on(_g(c, "status")) and _g(c, "status") != "not asked" for c in consents)
    out_to = any(_on(_g(a, "asked")) or _on(_g(a, "consent")) for a in approvals)
    read = _some(_g(d, "grid", "results"))
    floors = d.get("floors") if isinstance(d.get("floors"), list) else []
    bom = d.get("bom") if isinstance(d.get("bom"), list) else []
    insts = _g(d, "testing", "instruments")
    cal = any(_on(_g(x, "cal")) for x in insts) if isinstance(insts, list) else False
    accepted = _on(_g(ck, "accepted_on")) or _on(d.get("accepted_on"))
    booster = d.get("booster_class")
    class_b = isinstance(booster, str) and booster.startswith("Class B")
    every_given = None
    if consents and all(_g(c, "status") in ("given", "not needed") for c in consents):
        every_given = True
    every_letter = True if approvals and all(_on(_g(a, "consent")) for a in approvals) else None
    include = _g(d, "presurvey", "include")
    tests = {k: _test(d, t) for k, t in {"R5e.c": "noise_floor", "R5e.e": "isolation", "R5e.f": "gain", "R5e.g": "oscillation", "R5e.h": "donor_level", "R5e.i": "two_radio",
                                         "R5c.b": "noise_floor", "R5c.c": "isolation", "R5c.e": "gain", "R5c.f": "oscillation", "R5c.g": "donor_level", "R5c.h": "two_radio"}.items()}
    return {"R1.a": _have(_on(d.get("address")) and d.get("area_sqft")), "R1.b": _have(d.get("lat") is not None),
            "R1.c": False if not _on(d.get("ahj")) or opened("ahj") else _seen(_g(d, "code_check", "confirmed_on")),
            "R2e.a": _have(_on(d.get("building")) or _on(d.get("nsi"))), "R2e.b": _have(_len(include) or _len(plan)), "R2e.f": _have(_len(plan) and not opened("plan")),
            "R2e.g": _have(d.get("profile")), "R2e.h": _have(asked), "R2e.k": _have(read),
            "R2c.b": _seen(_some(_g(cell, "donor"))), "R2c.e": _have(any(_on(_g(a, "path")) for a in approvals)), "R2c.f": _have(out_to), "R2c.f1": _seen(out_to), "R2c.g": _have(read),
            "R3e.a": _have(any(_on(f) and _on(_g(f, "plan")) for f in floors)), "R3e.b": _seen(_some(_g(d, "design", "bands"))), "R3e.g": _have(len(bom)),
            "R3e.i": _seen(_on(_g(ck, "design_ok")) and _g(ck, "permit")), "R3c.f2": _seen(_g(ck, "permit")), "R4e.a": _have(_g(ck, "permit")), "R4e.i": _have(_g(ck, "monitoring")),
            "R5e.a": every_given, "R5e.b1": _have(_g(ck, "fcc_reg")) if class_b else None, "R5e.b": class_b if _on(booster) else None,
            "R5c.a": every_letter, **tests,
            "R6e.a": cal, "R6c.a": cal, "R6e.e": _have(read), "R6c.b": _have(read), "R6e.k2": _seen(accepted), "R6e.l": _seen(accepted)}


# ---------------------------------------------------------------- Start's four steps (stepDone moved here from static/start.js)
# start.js WALK: the building walk's questions, by key. Change both together (tests/test_nextstep.py)
WALK_KEYS = ("access_all", "plans", "contact", "he_room", "he_power", "he_ground", "he_panel", "riser", "rated", "roof_access", "donor_mount", "roof_path", "photos")
START_STEPS = ("discovery", "survey", "design", "ahj")
DAS_GRIDS = 20  # static/das.js DAS.grids


def _walk_left(d):
    a = _g(d, "guided", "answers")
    a = a if isinstance(a, dict) else {}
    return [k for k in WALK_KEYS if not _on(a.get(k)) or (a.get(k) == "No" and not str(a.get(f"{k}_note") or "").strip())]


def _is_cell(x):
    return bool((_has(x.get("tech")) and das.CELL_TECH.search(str(x.get("tech")))) or _has(x.get("rsrp")) or _has(x.get("rsrq")))


def _not_counted(d, r):
    """das.js notCounted of a square's deciding reading: it has a reading, and none was taken with an instrument that counts."""
    if not isinstance(r, dict):
        return False
    if isinstance(r.get("readings"), list):
        lmr = [x for x in r["readings"] if isinstance(x, dict) and not _is_cell(x) and any(_has(x.get(k)) for k in ("dl", "daq", "sinr"))]
        return bool(lmr) and not any(retest.counts(d, x) for x in lmr)
    return any(_has(r.get(k)) for k in ("dl", "daq", "sinr", "ul", "ul_daq")) and not retest.counts(d, r)


def _uncounted(d):
    """start.js gridFails().uncounted: squares whose readings don't count yet."""
    res, n = _g(d, "grid", "results"), 0
    res = res if isinstance(res, dict) else {}
    for f in d.get("floors") if isinstance(d.get("floors"), list) else []:
        if not isinstance(f, dict):
            continue
        skip = set(f.get("skip") or [])
        n += sum(1 for g in range(1, int(f.get("grids") or DAS_GRIDS) + 1) if g not in skip and _not_counted(d, res.get(f"{f.get('name')}|{g}")))
    return n


def _design_left(d):
    """start.js designChecks, every line of it: how many are still open."""
    bom = d.get("bom") if isinstance(d.get("bom"), list) else []
    floors = d.get("floors") if isinstance(d.get("floors"), list) else []
    named, priced = sum(1 for x in bom if _on(_g(x, "part"))), sum(1 for x in bom if _has(_g(x, "price")))
    budget = _some(_g(d, "design", "bands")) or _len(_g(d, "design", "cell_bands")) > 0
    done = [bool(floors), budget, bool(bom), bool(bom) and named == len(bom), bool(bom) and priced == len(bom)]
    if das.job_scope(d)["ps"]:
        done.append(_some(d.get("consents")))
    return done.count(False)


def start_steps(d, stage):
    """Start's four steps. A job begun in Start reads as it always did: an answer a person gave. A job begun on the DAS tab has no answers
    to give, so its record answers instead (it used to open at step 1 with its work ignored)."""
    guided, order = _on(d.get("guided")), das.STAGES.index(stage) if stage in das.STAGES else 0
    measured = _some(_g(d, "grid", "results")) and not _uncounted(d)
    if guided:
        discovery, survey = _on(_g(d, "guided", "discovery")), measured and not _walk_left(d)
    else:
        discovery = _len(_g(d, "presurvey", "plan")) > 0 or _len(_g(d, "presurvey", "include")) > 0 or order >= das.STAGES.index("Design")
        survey = measured or order >= das.STAGES.index("Install")
    done = {"discovery": bool(discovery), "survey": bool(survey), "design": _design_left(d) == 0, "ahj": _on(_g(d, "guided", "done", "ahj"))}
    skips = _g(d, "guided", "skips")
    clear = {k: done[k] or _on(_g(skips, k)) for k in START_STEPS}
    return {"guided": guided, "done": done, "clear": clear, "step": next((k for k in START_STEPS if not clear[k]), "ahj")}


# ---------------------------------------------------------------- what's next
# The steps the record can see, stage by stage, in the chart's order. A chart step is done when its check says so or, where the record
# can't tell, when a person answered it in Walk me through. A "gate:" step is done when the gate stops asking for it.
STEPS = {
    "Lead": (("R1.a", "Get the address and the floor area", "overview", ""), ("gate:pin",), ("gate:ahj",), ("gate:code",)),
    "Pre-survey": (("R2e.a", "Look up the building", "overview", "ps"), ("R2e.b", "Run the Pre-survey", "presurvey", "ps"), ("gate:plan",), ("gate:profile",), ("gate:asked",),
                   ("R2e.k", "Walk the building", "grid", "ps"), ("gate:donor",), ("gate:approvals",), ("R2c.f", "Send each carrier's consent request", "presurvey", "cell"),
                   ("R2c.g", "Walk the building", "grid", "cell")),
    "Design": (("R3e.a", "Load a plan for every floor", "plans", "ps"), ("R3e.b", "Draw walls and place antennas", "design", "ps"), ("R3e.g", "Build the bill of materials", "materials", "ps"),
               ("gate:design_ok",), ("gate:permit",)),
    "Install": (("R4e.a", "Get the AHJ permit on file", "overview", "ps"), ("gate:monitoring",)),
    "Commission": (("gate:consent",), ("gate:fcc_reg",), ("gate:commission",)),
    "Acceptance": (("R6e.a", "Check every instrument is calibrated", "overview", "ps"), ("R6c.a", "Check your scanner is calibrated", "overview", "cell"),
                   ("R6e.e", "Walk the grid", "grid", "ps"), ("R6c.b", "Walk the building", "grid", "cell"), ("gate:accepted",)),
}
SAY = {"pin": "Put the pin on the building", "ahj": "Name the AHJ", "code": "Get someone at the AHJ to confirm the code", "plan": "Save the channel plan",
       "profile": "Pick the AHJ's requirements", "asked": "Ask the licensees for consent", "donor": "Read each carrier on the roof", "approvals": "Pick an approval path for each carrier",
       "design_ok": "Get the design approved and enter the date", "permit": "Get the AHJ permit and enter the date", "monitoring": "Connect monitoring to the fire alarm panel and enter the date",
       "consent": "Get licensee consent and enter the date", "fcc_reg": "File the FCC registration for the Class B booster and enter the date", "accepted": "Get the AHJ's acceptance and enter the date"}
SAY_OPEN = {"ahj": "Check the AHJ DAStastic filled in", "plan": "Check the channel plan DAStastic filled in"}  # Run it for me chose it (data.auto.open)
NOTHING_TO_READ = {"Install": ("Build it, and test each section as you go", "pim")}  # a stage whose gate has nothing to look at on this job


def _gate_keys(d, stage):
    """What the gate can ask for at this stage on a job like this one: a blank job's list, so a need that's been met still counts as a step done."""
    scope = das.job_scope(d)
    said = "Both" if scope["ps"] and scope["cell"] else "Cellular" if scope["cell"] else "Public safety radio"
    return {n["key"] for n in codecheck.stage_needs({"guided": {"answers": {"scope": said}}, "booster_class": d.get("booster_class")}, stage)}


def _steps(d, stage, checks, needs):
    """This stage's steps as [(key, words, tab, done)], in order."""
    scope, asked, gated = das.job_scope(d), {n["key"]: n for n in needs}, _gate_keys(d, stage)
    answers = _g(d, "guide", "answers")
    answers = answers if isinstance(answers, dict) else {}
    out = []
    for s in STEPS.get(stage, ()):
        if s[0].startswith("gate:"):
            k = s[0][5:]
            n = asked.get(k)
            if n:
                said = SAY_OPEN.get(k) if codecheck._open(d, k) else SAY.get(k)
                out.append((k, said or f"Finish {n['text'][0].lower()}{n['text'][1:]}", n["sub"], False))
            elif k in gated:
                out.append((k, SAY.get(k, k), "overview", True))
            continue
        key, words, sub, only = s
        if only and not scope[only]:
            continue
        v, a = checks.get(key), answers.get(key)
        told = isinstance(a, dict) and a.get("a") not in (None, "", "No", False)
        out.append((key, words, sub, v is True or (v is None and told)))
    return out


def propose_move(job):
    """The next stage, when the file supports it: the gate asks for nothing, and it had something to ask for. A stage the record can't read
    (a cellular job's Install) proposes nothing. Never past In service: closing a job is a person's idea."""
    d, stage = job.get("data") or {}, job.get("stage")
    if d.get("example") or stage not in das.STAGES or stage in ("In service", "Closed") or not _gate_keys(d, stage):
        return None
    to = das.STAGES[das.STAGES.index(stage) + 1]
    return None if codecheck.gate(job, to) else {"to": to, "text": f"Ready for {to}: move it"}


def _life_next(items):
    """In service: the next date the system owes. Overdue and due first, then the nearest ahead."""
    dated = [x for x in items or [] if x.get("due") and x.get("state") in ("overdue", "due", "ok")]
    if not dated:
        return None
    x = min(dated, key=lambda i: (i["state"] == "ok", i["due"]))
    return {"text": f"{x['label']}: {'was due' if x['state'] == 'overdue' else 'due'} {x['due']}", "sub": "overview", "due": x["due"]}


# ---------------------------------------------------------------- the walk through the chart
# One answer to "what's next": this is Walk me through's walk (static/dasguide.js said, after, walk), on the chart's own steps, so the board
# stops where the guide does. tests/guide_walk_check.mjs runs the guide's code beside this over the same jobs. The chart is written out by
# tools/build_fi_steps.mjs, because static/dasfi_data.js is code, and a test fails if the two drift.

CHART_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "research", "das_fi_steps.json")
SUB = {"Overview": "overview", "Pre-survey": "presurvey", "Plans": "plans", "Requirements": "require", "Design": "design", "Materials": "materials", "Commissioning": "commission",
       "Grid test": "grid", "Screening": "screen", "Report": "report", "Files": "files", "Log": "log", "Existing system": "audit"}  # static/dasfi.js SUB
_chart = None
NOTHING = object()


def chart():
    global _chart
    if _chart is None:
        try:
            with open(CHART_FILE, encoding="utf-8") as fh:
                _chart = json.load(fh)
        except (OSError, ValueError):  # no chart on this copy: the board falls back on the stage's own list
            _chart = {"trees": [], "faults": []}
        _chart["ids"] = set(_chart["faults"]) | {t["id"] for t in _chart["trees"]}
    return _chart


def trees_for(stage, d):
    """The charts for a stage on a job like this one (dasguide.js trees)."""
    n, scope = das.STAGES.index(stage) + 1 if stage in das.STAGES else 1, das.job_scope(d)
    return [t for t in chart()["trees"] if t["stage"] == n and (t["scope"] == "both" or (t["scope"] == "e" and scope["ps"]) or (t["scope"] == "c" and scope["cell"]))]


def _said(t, n, d, checks):
    key = f"{t['id']}.{n['id']}"
    v = checks.get(key)
    if v is not None:
        return v
    answers = _g(d, "guide", "answers")
    a = answers.get(key) if isinstance(answers, dict) else None
    return a.get("a") if isinstance(a, dict) else NOTHING


def _after(n, v):
    if n.get("opts"):
        return next((o["to"] for o in n["opts"] if o["l"] == v), None)
    if n["k"] == "test":
        return n.get("yes") if v is True or v == "Yes" else n.get("no") if v is False or v == "No" else None
    return None if v is False else n.get("next")


def walk(t, d, checks):
    """From a chart's first step, as far as the record and the saved answers can say: (the step it stops at, whether that's the chart's end).
    It stops at a step nobody can answer yet, at a failed check (the fault chart takes over), and at the end."""
    by, seen, at = {n["id"]: n for n in t["nodes"]}, set(), t["start"]
    while at and at in by and at not in seen:
        seen.add(at)
        n = by[at]
        if n["k"] == "done":
            return n, True
        v = _said(t, n, d, checks)
        if v is NOTHING:
            return n, False
        to = _after(n, v)
        if not to or to in chart()["ids"]:
            return n, False
        at = to
    return by.get(at) or by[t["start"]], False


def _place(n):
    """The tab a step happens on (dasguide.js placeOf), or None. The rest, the board's Open takes to the job."""
    at = n.get("at") or ""
    if at.startswith("Job > "):
        return SUB.get(at[6:].split(",")[0].strip())
    return "materials" if at.startswith("Parts, job Materials") else "overview" if at.startswith("Top of this page") else "pim" if at.startswith("PIM") else None


def pick_up(stage, d, checks):
    """Where this job stands in its stage's charts: the first one not finished, else the last. The one answer the board and the guide read."""
    rows = [(t, *walk(t, d, checks)) for t in trees_for(stage, d)]
    if not rows:
        return None
    t, n, end = next((r for r in rows if not r[2]), rows[-1])
    return {"tree": t["id"], "step": n["id"], "text": n["t"], "sub": _place(n), "end": end, "title": t.get("title")}


def worked_out(job, steps, move, rt, at=None):
    """The next step from the file alone: a retest's dates or its next step first, then where the walk through the chart stops, so the board says
    what the guide says. In service has no line to walk: its chart asks what brought you here, so what's next is the date the system owes."""
    if rt and rt.get("next"):
        return {**rt["next"], "due": rt.get("due"), "key": "retest"}
    stage = job.get("stage")
    if stage == "In service":
        return _life_next(job.get("lifecycle"))
    if at and not at["end"]:
        return {"text": at["text"], "sub": at["sub"] or "overview", "key": f"{at['tree']}.{at['step']}"}
    if move:
        return {"text": move["text"], "sub": "overview", "key": "move"}
    hit = next((s for s in steps if not s[3]), None)
    if hit:
        return {"text": hit[1], "sub": hit[2], "key": hit[0]}
    if stage in NOTHING_TO_READ:
        return dict(zip(("text", "sub"), NOTHING_TO_READ[stage]), key="work")
    return None


def read(con, job):
    d, stage = job.get("data") or {}, job.get("stage")
    checks, needs = record_checks(d), codecheck.stage_needs(d, stage)
    steps, rt = _steps(d, stage, checks, needs), retest.state(con, job)
    if rt and rt.get("due") and stage == "In service":  # the chart's first question there: an open retest answers it
        checks["R7e.a"] = "Five-year retest" if rt.get("kind") == "five_year" else "Annual test due"
    move, at = propose_move(job), pick_up(stage, d, checks)
    worked = None if stage == "Closed" else worked_out(job, steps, move, rt, at)
    typed = str(d.get("next_step") or "").strip()
    nxt = {"text": typed, "from": "typed", "due": d.get("due") or None} if typed else ({**worked, "from": "file"} if worked else None)
    return {"next": nxt, "worked": worked, "move": move, "needs": needs, "checks": checks, "walk": at, "done": {"on": sum(1 for s in steps if s[3]), "of": len(steps)},
            "start": start_steps(d, stage), "retest": rt}


def brief(s):
    """A job's standing on the board: everything but the per-step checks."""
    return {k: v for k, v in s.items() if k not in ("checks", "walk")}


def safe(con, job):
    """Never stops a job or the board drawing: said in the answer instead (the board shows it, the guide reads no checks)."""
    try:
        return read(con, job)
    except Exception as e:  # a job's data of a shape nothing expected: the job still opens
        return {"next": None, "worked": None, "move": None, "needs": [], "checks": {}, "done": {"on": 0, "of": 0}, "start": None, "retest": None, "error": f"{type(e).__name__}: {e}"[:120]}

