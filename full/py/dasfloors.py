"""DAStastic: a job's floor list changed by operations the server applies to the job as it is at the save (review rounds 6 and 7).

Six rounds of review found one more way that writing the whole floor list from a page's copy lost a floor, or put one back, or
saved a list nobody made: the copy was older than the job, or two lists were merged by guesswork. Now every floor writer (Start's
answers and Build, Drop and Put it back, the Overview's count and its outline and NSI fills, the Grid test, Plans, Design's DXF plan,
Run it for me, History's Undo) sends what the press means, by floor name, and this works it out on the job as it is, inside the save's
own transaction:

  add {name, after?, before?, grids?, start?}    a floor, after or before another, else in its place by rank (B2, B1, 1, 2 ... PH)
  remove {name, if_unchanged_since?, confirm?}   only while it holds just what the person was shown (below)
  rename {from, to, if_unchanged_since?, confirm?}
  put_back {floor, after?, before?}              a floor dropped earlier, exactly as it was, beside the floor it followed
  set {name, set: {key: value}, was?: {key: value}}
                                                 keys on one floor (its grid, grid box, plan); null takes a key off. With was (the
                                                 value the person changed it from), refused when the job's value moved on since
  union / pull {name, key, values}               squares added to, or taken off, a floor's critical or skipped squares
  redivide {name, grids, cols, date, was?}       the floor's grid re-divided: every reading under it now moves to grid.redivided
  readings {rows: {"floor|square": [reading]}, critical?: {floor: [square]}, add?: [floor]}
                                                 an import: each row replaces that square's reading on the same channel, the
                                                 rest stay; floors in add are added; a row on a floor the job no longer has refuses it
  set_count {above?, below?} | {total}           floors 1..above and B1..Bbelow by name; or (total, the Overview's count) the
                                                 missing numbers added, lowest first, or the highest-numbered floors above ground,
                                                 then the deepest basements, taken off. Never a floor someone named; taking off
                                                 goes under the same rule as remove
  fill {above}                                   floors 1..above, only into an empty list (the outline, NSI, Run it for me)
  start_answers {answers?, if_answers?}          Start's floor answers onto guided.answers, and the names now on the list onto
                                                 guided.floors_made; with if_answers, only while the job's floor answers are those

A floor comes off (remove, rename, set_count) only when nothing on it would be lost unseen: when it has work on it (floor_work, the
same judgement as Start's Drop and the Overview's count) or changed since the revision the page drew it at, the save is refused with
what is on it now and, for a change, what changed, unless confirm names exactly that and nothing changed since the revision the
confirm was given against. All the operations of one save go together or not at all. The answer says, per operation, what it did; a
refusal says why, in words the page shows."""
import json
import re

GRIDS = 20  # static/das.js DAS.grids: a floor's grid squares unless it has its own
PLAIN_KEYS = {"name", "grids", "start", "cols", "plan", "plan_src", "skip", "critical", "gridbox"}
FLOOR_Q = ("floors_up", "floors_up_n", "floors_down", "floors_down_n")  # static/start.js FLOOR_Q
MEMBERSHIP = {"add", "remove", "rename", "put_back", "set_count", "fill", "redivide"}  # what a History note names; the rest fold
KEY_WORDS = {"plan": "its plan", "plan_src": "its plan", "skip": "its skipped squares", "critical": "its critical squares", "grids": "its grid",
             "cols": "its grid", "gridbox": "its grid box"}


def rank(name):
    """Where a floor goes in the list: basements below 1, then the floors above ground (readers.js floorRank, the common names)."""
    t = str(name).strip().upper()
    if re.fullmatch(r"\d{1,3}", t):
        return int(t)
    m = re.fullmatch(r"([BP])-?(\d{1,2})", t)
    if m:
        return -int(m.group(2)) if m.group(1) == "B" else -50 - int(m.group(2))
    return {"G": 0, "GF": 0, "GROUND": 0, "M": 1.5, "MEZZANINE": 1.5, "PH": 500, "PENTHOUSE": 500}.get(t)


def floor_work(d, x):
    """What taking floor x off would lose, in words (static/start.js floorWork: tests/test_floor_ops.py keeps the two the same)."""
    if not x:
        return []
    d = d or {}
    name, out = x.get("name"), []

    def here(o):
        return any(str(k).split("|")[0] == name for k in (o or {}))
    design = d.get("design") or {}
    v = (design.get("floors") or {}).get(name)
    sub = ((design.get("sub") or {}).get("floors") or {}).get(name)
    if not re.fullmatch(r"B\d+|\d+", str(name)):
        out.append("a name someone gave it")
    if here((d.get("grid") or {}).get("results")):
        out.append("grid readings")
    if here((d.get("baseline") or {}).get("results")):
        out.append("baseline readings")
    if name in ((d.get("grid") or {}).get("redivided") or {}):
        out.append("a re-divided grid")
    if any(isinstance(w, dict) and w.get("name") == name for w in ((d.get("walk") or {}).get("floors") or [])):
        out.append("the walk test")
    if isinstance(v, dict) and ((v.get("antennas") or []) or (v.get("walls") or []) or v.get("width_ft") is not None):
        out.append("Design work")
    if sub is not None and sub != "" and not (isinstance(sub, dict) and not sub):
        out.append("the submittal's settings")
    if x.get("plan") or x.get("plan_src"):
        out.append("a plan")
    if x.get("skip"):
        out.append("skipped squares")
    if x.get("critical"):
        out.append("critical squares")
    if x.get("grids") != GRIDS or x.get("cols") is not None:
        out.append("its own grid")
    if x.get("gridbox"):
        out.append("a grid box")
    if any(k not in PLAIN_KEYS for k in x):
        out.append("settings")
    return out


def _named(d, name, section, sub="results"):
    """A section's records kept under a floor's name (grid readings "3|5", Design's floors["3"]), to tell what changed on a floor."""
    o = (d.get(section) or {}).get(sub) if sub else d.get(section)
    if section == "design":
        return ((d.get("design") or {}).get("floors") or {}).get(name)
    return {k: v for k, v in (o or {}).items() if str(k).split("|")[0] == name}


def floor_changes(then, was, now_d, x):
    """What changed on floor x since the copy `then` (where it was `was`), in words: its plan, its grid readings ..."""
    out = []
    for k in sorted(set(was) | set(x)):
        if k not in ("name", "start") and was.get(k) != x.get(k):
            out.append(KEY_WORDS.get(k, "its settings"))
    name = x.get("name")
    for section, words in (("grid", "its grid readings"), ("baseline", "its baseline readings"), ("design", "its Design work")):
        if _named(then, name, section) != _named(now_d, name, section):
            out.append(words)
    if [w for w in ((then.get("walk") or {}).get("floors") or []) if isinstance(w, dict) and w.get("name") == name] != \
            [w for w in ((now_d.get("walk") or {}).get("floors") or []) if isinstance(w, dict) and w.get("name") == name]:
        out.append("its walk test")
    return list(dict.fromkeys(out))


def _regridded(name, x, was):
    """A refusal when the floor's grid isn't the one the page drew (was: {grids, cols}), or None. Review round 8: a page drawn before
    another's Re-divide saved its 20-area readings, imports and marks onto the new 40-area squares, a different place on the floor."""
    if not isinstance(was, dict):
        return None
    moved = [k for k in ("grids", "cols") if k in was and x.get(k) != was[k]]
    if not moved:
        return None
    said = (f"Floor {name} was re-divided into {x.get('grids', GRIDS)} areas since this page was drawn: nothing was saved. The page now shows it as it is."
            if "grids" in moved else f"Floor {name}'s grid changed since this page was drawn: nothing was saved. The page now shows it as it is.")
    return {"name": name, "why": "moved", "what": [], "said": said}


def _words(xs):
    xs = list(xs)
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1] if xs else ""


def _ch_key(x):
    """A reading's channel (static/das.js chKey): a new reading replaces the square's one on the same channel."""
    return "|".join(str("" if x.get(k) is None else x.get(k)).strip().lower() for k in ("tech", "carrier", "freq", "pci"))


def _readings_of(r):
    """A square's readings (static/das.js readingsOf): its list, or the one old-style reading it holds."""
    if not isinstance(r, dict):
        return []
    if isinstance(r.get("readings"), list):
        return r["readings"]
    return [r] if any(r.get(k) not in (None, "") for k in ("dl", "daq", "sinr")) else []


class _Job:
    """The floors being worked on, the job's other data as it is, and the job as it was at a revision a page drew."""

    def __init__(self, data, then):
        self.data, self.then = data, then
        self.fl = json.loads(json.dumps(data.get("floors") if isinstance(data.get("floors"), list) else []))
        self.grid = None  # the grid section, once an operation changes it
        self._then = {}

    def now(self):
        return {**self.data, "floors": self.fl, **({"grid": self.grid} if self.grid is not None else {})}

    def find(self, name):
        return next((i for i, x in enumerate(self.fl) if isinstance(x, dict) and x.get("name") == name), -1)

    def at(self, rev):
        if rev not in self._then:
            self._then[rev] = self.then(rev)
        return self._then[rev]

    def grid_now(self):
        if self.grid is None:
            self.grid = json.loads(json.dumps(self.data.get("grid") or {}))
        return self.grid

    def place(self, x, after=None, before=None):
        i = self.find(after) if after is not None else -1
        if i >= 0:
            self.fl.insert(i + 1, x)
            return
        i = self.find(before) if before is not None else -1
        if i >= 0:
            self.fl.insert(i, x)
            return
        r = rank(x.get("name"))
        if r is not None:
            for i, y in enumerate(self.fl):
                ry = rank(y.get("name")) if isinstance(y, dict) else None
                if ry is not None and ry > r:
                    self.fl.insert(i, x)
                    return
        self.fl.append(x)

    def off_ok(self, name, since, confirm, as_was=False):
        """None when floor `name` may come off; else a refusal: what is on it now, what changed, and why it is asked. A confirm
        counts only when it names what is on the floor now and nothing changed since the revision it was given against (review
        round 7: a plan replaced since, or antennas added beside walls, matched the confirm's "a plan" or "Design work" by kind)."""
        x = self.fl[self.find(name)]
        now_d = self.now()
        now = floor_work(now_d, x)
        changed, added, what_changed = False, False, []
        if since is not None:
            then = self.at(since)
            if then is None:
                changed = True
            else:
                was = next((y for y in (then.get("floors") or []) if isinstance(y, dict) and y.get("name") == name), None)
                added = was is None
                if not added:
                    what_changed = floor_changes(then, was, now_d, x)
                changed = added or bool(what_changed)
        if (not now or as_was) and not changed:  # as_was: what it had at since doesn't count (History's Undo of the revision that added it)
            return None
        if confirm is not None and not changed and sorted(confirm) == sorted(now):
            return None
        has = f", and has {_words(now)}" if now else ""
        if added:
            said = f"Floor {name} was added since this page was drawn{has}."
        elif changed:
            said = f"Floor {name} changed since this page was drawn" + (f" ({_words(what_changed)})" if what_changed else "") + f"{has}."
        else:
            said = f"Floor {name} has {_words(now)}."
        return {"name": name, "why": "changed" if changed else "work", "what": now, "changed": what_changed, "said": said}


def _count_plan(J, op):
    """set_count's floors to take off and to add, by name, on the list as it is."""
    names = [str(x.get("name")) for x in J.fl if isinstance(x, dict)]
    num = sorted((int(n) for n in names if re.fullmatch(r"\d+", n)), reverse=True)
    bas = sorted((int(n[1:]) for n in names if re.fullmatch(r"B\d+", n)), reverse=True)
    if op.get("total") is not None:  # the Overview's count: how many floors, by name (review round 7: by 1..above it added a blank
        # floor 4 when 1, 2, 3, 5, 6 went to 4, and a count up from a copy drawn before someone's count down reached neither count)
        n = max(0, min(220, int(op["total"])))
        more = n - len(names)
        if more >= 0:
            have, add, k = set(names), [], 1
            while len(add) < more and k <= 400:
                if str(k) not in have:
                    add.append(str(k))
                k += 1
            return [], add, None
        order = [str(v) for v in num] + [f"B{v}" for v in bas]
        if len(order) < -more:
            return None, None, "The floors left have names someone gave them (Ground, Mezzanine): take those off by name, on the Grid test or in Start's answers."
        return order[:-more], [], None
    want = {}
    for key, pre in (("above", ""), ("below", "B")):
        if op.get(key) is not None:
            want[pre] = max(0, min(200 if key == "above" else 20, int(op[key])))
    off = [n for n in names if (m := re.fullmatch(r"(B?)(\d+)", n)) and m.group(1) in want and int(m.group(2)) > want[m.group(1)]]
    add = [f"{pre}{i}" for pre, n in want.items() for i in range(1, n + 1) if f"{pre}{i}" not in names]
    return off, add, None


def apply(data, ops, then):
    """Work ops out on the job's data as it is now. then(rev) gives the job's data as of a revision (or None when the history that far
    back is gone). Returns (sections to save, per-op results, refusals, a note for the job's History)."""
    if not isinstance(ops, list) or not ops:
        raise ValueError("Which floor change?")
    J, results, refused, said = _Job(data, then), [], [], []
    guided = None
    backs = []  # put_back operations in a row: each placed once the floor it sits beside is there (review round 6: in order, a basement
    # put back before the one it followed went in at its old place)

    def flush_backs():
        while backs:
            placed = False
            for b in list(backs):
                f, after, before = b
                if (after is not None and J.find(after) >= 0) or (before is not None and J.find(before) >= 0):
                    J.place(f, after if after is not None and J.find(after) >= 0 else None, before)
                    backs.remove(b)
                    placed = True
            if not placed:
                f, after, before = backs.pop(0)
                J.place(f)

    def gone(name):
        return {"name": name, "why": "gone", "what": [], "said": f"Floor {name} isn't on the job any more: it was taken off since this page was drawn."}
    for k, op in enumerate(ops):
        if not isinstance(op, dict):
            raise ValueError("A floor change is an object.")
        kind = op.get("op")
        if kind != "put_back":
            flush_backs()

        def refuse(r):
            refused.append({"op": k, **r})
        if kind == "add":
            name = str(op.get("name") or "").strip()
            if not name:
                raise ValueError("Which floor to add?")
            if J.find(name) >= 0:
                results.append({"op": k, "done": False, "said": f"Floor {name} is on the job already."})
                continue
            x = {"name": name, "grids": int(op.get("grids") or GRIDS)}
            if op.get("start"):
                x["start"] = True
            J.place(x, op.get("after"), op.get("before"))
            results.append({"op": k, "done": True})
            said.append(f"floor {name} added")
        elif kind == "remove":
            name = str(op.get("name") or "")
            if J.find(name) < 0:
                results.append({"op": k, "done": False, "said": f"Floor {name} is off the job already."})
                continue
            r = J.off_ok(name, op.get("if_unchanged_since"), op.get("confirm"), bool(op.get("as_was")) and op.get("if_unchanged_since") is not None)
            if r:
                refuse(r)
                continue
            J.fl.pop(J.find(name))
            results.append({"op": k, "done": True})
            said.append(f"floor {name} taken off")
        elif kind == "rename":
            a, b = str(op.get("from") or ""), str(op.get("to") or "").strip()
            if not b:
                raise ValueError("Rename the floor to what?")
            if J.find(a) < 0:
                refuse(gone(a))
                continue
            if J.find(b) >= 0:
                refuse({"name": b, "why": "taken", "what": [], "said": f"The job has a floor {b} already."})
                continue
            r = J.off_ok(a, op.get("if_unchanged_since"), op.get("confirm"))
            if r and r["why"] == "changed":
                refuse(r)
                continue
            J.fl[J.find(a)]["name"] = b
            results.append({"op": k, "done": True})
            said.append(f"floor {a} renamed {b}")
        elif kind == "put_back":
            f = op.get("floor")
            if not isinstance(f, dict) or not str(f.get("name") or "").strip():
                raise ValueError("Which floor to put back?")
            if J.find(f["name"]) >= 0 or any(b[0]["name"] == f["name"] for b in backs):
                results.append({"op": k, "done": False, "said": f"Floor {f['name']} is on the job already."})
                continue
            backs.append((json.loads(json.dumps(f)), op.get("after"), op.get("before")))
            results.append({"op": k, "done": True})
            said.append(f"floor {f['name']} put back")
        elif kind in ("set", "union", "pull", "redivide"):
            name = str(op.get("name") or "")
            i = J.find(name)
            if i < 0:
                refuse(gone(name))
                continue
            x = J.fl[i]
            moved = [key for key, v in (op.get("was") or {}).items() if x.get(key) != v]
            rg = _regridded(name, x, op.get("was")) if kind in ("union", "pull") else None
            if rg:  # a square mark from a page drawn on another grid (round 8)
                refuse(rg)
                continue
            if moved:  # the value the person changed it from isn't the job's any more (review round 7: a grid box dragged by one page
                # was put back by another's Rotate, last writer winning on Squares and Columns)
                refuse({"name": name, "why": "moved", "what": [], "said": f"Floor {name}'s {_words(dict.fromkeys(KEY_WORDS.get(m, m).replace('its ', '') for m in moved))} "
                        f"changed since this page was drawn, so this wasn't saved. The page now shows it as it is."})
                continue
            if kind == "set":
                for key, v in (op.get("set") or {}).items():
                    if key == "name":
                        raise ValueError("A floor's name changes with rename.")
                    if v is None:
                        x.pop(key, None)
                    else:
                        x[key] = v
            elif kind in ("union", "pull"):
                key = str(op.get("key") or "")
                if key not in ("critical", "skip"):
                    raise ValueError("Add to or take off a floor's critical or skipped squares.")
                have, vals = list(x.get(key) or []), list(op.get("values") or [])
                x[key] = sorted(have + [v for v in vals if v not in have], key=lambda v: (not isinstance(v, int), v if isinstance(v, int) else str(v))) \
                    if kind == "union" else [v for v in have if v not in vals]
            else:  # the 40-area retest (IFC 510.5.4): the readings under this floor now move with the old grid, on the job as it is (round 7:
                # a reading another tester entered just before the re-divide landed stayed as a new square's)
                g = J.grid_now()
                res = dict(g.get("results") or {})
                old = {kk: vv for kk, vv in res.items() if str(kk).split("|")[0] == name}
                for kk in old:
                    del res[kk]
                g["results"] = res
                g["redivided"] = {**(g.get("redivided") or {}), name: {"date": op.get("date") or "", "grids": x.get("grids", GRIDS), "cols": x.get("cols"), "results": old}}
                x.update({"grids": int(op.get("grids") or 40), "cols": int(op.get("cols") or 8), "skip": [], "critical": []})
                said.append(f"floor {name} re-divided")
            results.append({"op": k, "done": True})
        elif kind == "readings":
            for name in op.get("add") or []:
                if J.find(str(name)) < 0:
                    J.place({"name": str(name), "grids": GRIDS})
                    said.append(f"floor {name} added")
            rows, crit, put = op.get("rows") or {}, op.get("critical") or {}, op.get("put") or {}
            missing = sorted({str(kk).split("|")[0] for kk in list(rows) + list(put)} | {str(f) for f in crit}, key=str)
            missing = [f for f in missing if J.find(f) < 0]
            to = str(op.get("to") or "")
            if missing:  # review round 7: the import was refused whole with only "isn't on the job any more", or saved readings under a
                # floor the job no longer had, where no Grid test floor and no report shows them. Round 8: rows with no Floor column were
                # going to the floor the person had open; the words say so, and the page keeps that floor for Import again
                if to in missing and len(missing) == 1:
                    said = (f"The rows with no Floor were going to floor {to}, which was taken off this job since the Grid test was drawn, so nothing "
                            f"was imported. Import again to add floor {to} back with them.")
                elif put and not rows:
                    said = f"Floor {_words(missing)} was taken off this job since the Grid test was drawn: nothing was saved."
                else:
                    said = (f"Floor{'' if len(missing) == 1 else 's'} {_words(missing)} {'was' if len(missing) == 1 else 'were'} taken off this job since "
                            "the Grid test was drawn, so nothing was imported. The Grid test now shows the job as it is: import again to add them back "
                            "with their readings.")
                refuse({"name": missing[0], "why": "gone", "what": [], "said": said})
                continue
            # each floor's grid as the page drew it (was: {floor: {grids, cols}}): readings for 20 areas don't land on 40 (round 8)
            rg = next((r for r in (_regridded(f, J.fl[J.find(f)], w) for f, w in (op.get("was") or {}).items() if J.find(str(f)) >= 0) if r), None)
            if rg:
                refuse(rg)
                continue
            g = J.grid_now()
            res = dict(g.get("results") or {})
            # a square typed on the Grid test (Save, Delete, Clear): its readings as the page made them, only while the square still holds
            # what the page drew (from), so another tester's reading saved since isn't written over
            for kk, v in put.items():
                if not isinstance(v, dict) or "to" not in v:
                    raise ValueError("A square's readings go as {from, to}.")
                if (res.get(kk) if kk in res else None) != v.get("from"):
                    refuse({"name": str(kk).split("|")[0], "why": "moved", "what": [], "said": f"Square {str(kk).replace('|', '-')} changed since this page was drawn: nothing was saved. The page now shows it as it is."})
                    break
                if v["to"]:
                    res[kk] = {"readings": list(v["to"])}
                else:
                    res.pop(kk, None)
            if refused and refused[-1]["op"] == k:
                continue
            for kk, new in rows.items():
                keys = {_ch_key(r) for r in new}
                res[kk] = {"readings": [r for r in _readings_of(res.get(kk)) if _ch_key(r) not in keys] + list(new)}
            g["results"] = res
            for f, squares in crit.items():
                x = J.fl[J.find(str(f))]
                have = list(x.get("critical") or [])
                x["critical"] = have + [v for v in squares if v not in have]
            results.append({"op": k, "done": True, "squares": len(rows)})
        elif kind in ("set_count", "fill"):
            if kind == "fill" and J.fl:
                results.append({"op": k, "done": False, "said": "The job has floors already."})
                continue
            off, add, why = _count_plan(J, op)
            if why:
                refuse({"name": "", "why": "named", "what": [], "said": why})
                continue
            confirm = op.get("confirm") or {}
            bad = [r for r in (J.off_ok(nm, op.get("if_unchanged_since"), confirm.get(nm)) for nm in off) if r]
            if bad:
                for r in bad:
                    refuse(r)
                continue
            for nm in off:
                J.fl.pop(J.find(nm))
            for nm in add:
                J.place({"name": nm, "grids": GRIDS, **({"start": True} if op.get("start") else {})})
            results.append({"op": k, "done": bool(off or add), "off": off, "added": add})
            if off:
                said.append(f"floor{'' if len(off) == 1 else 's'} {_words(off)} taken off")
            if add:
                said.append(f"floor{'' if len(add) == 1 else 's'} {_words(add)} added")
        elif kind == "start_answers":
            g = dict(data.get("guided") or {}) if guided is None else guided
            now = {q: (g.get("answers") or {}).get(q, "") or "" for q in FLOOR_Q}
            want = op.get("if_answers")
            if isinstance(want, dict) and any((want.get(q) or "") != now[q] for q in FLOOR_Q):
                results.append({"op": k, "done": False, "said": "The job's floor answers changed since."})
                continue
            if isinstance(op.get("answers"), dict):  # without answers: only floors_made, the names now on the list
                g["answers"] = {**(g.get("answers") or {}), **{q: op["answers"].get(q, "") or "" for q in FLOOR_Q}}
            g["floors_made"] = True  # the names on the list once every operation is done
            guided = g
            results.append({"op": k, "done": True})
        else:
            raise ValueError(f"Unknown floor change {kind!r}.")
    flush_backs()
    if refused:
        return {}, results, refused, ""
    out = {}
    if J.fl != (data.get("floors") if isinstance(data.get("floors"), list) else []):
        out["floors"] = J.fl
    if J.grid is not None and J.grid != (data.get("grid") or {}):
        out["grid"] = J.grid
    if guided is not None:
        if guided.get("floors_made") is True:
            guided["floors_made"] = [x.get("name") for x in J.fl if isinstance(x, dict)]
        if guided != (data.get("guided") or {}):
            out["guided"] = guided
    # a History note only for a change to which floors there are (review round 7: a note on every square toggled kept them from
    # folding, so each was its own entry); keys on a floor and readings fold like any save
    return out, results, [], "floors: " + "; ".join(dict.fromkeys(said)) if said else ""


def inverse(before, after, since=None, confirm=None):
    """The floor operations that undo one revision's change to the floors (History's Undo, review round 7: it wrote the whole list
    back from history over floors added since, with their plans): floors it added come off under remove's rule, floors it took off
    go back beside the floors they followed, and keys it changed on a floor go back where they still hold what it set."""
    B = before if isinstance(before, list) else []
    A = after if isinstance(after, list) else []
    bn, an = [x.get("name") for x in B if isinstance(x, dict)], [x.get("name") for x in A if isinstance(x, dict)]
    ops, confirm = [], confirm or {}
    for x in A:
        if isinstance(x, dict) and x.get("name") not in bn:
            ops.append({"op": "remove", "name": x["name"], "if_unchanged_since": since, "as_was": True, **({"confirm": confirm[x["name"]]} if x["name"] in confirm else {})})
    for i, x in enumerate(B):
        if isinstance(x, dict) and x.get("name") not in an:
            ops.append({"op": "put_back", "floor": x, "after": bn[i - 1] if i else None, "before": bn[i + 1] if i + 1 < len(bn) else None})
    for x in B:
        y = next((z for z in A if isinstance(z, dict) and isinstance(x, dict) and z.get("name") == x.get("name")), None)
        if y is not None and y != x:
            keys = sorted((set(x) | set(y)) - {"name"})
            ops.append({"op": "set", "name": x["name"], "set": {k: x.get(k) for k in keys if x.get(k) != y.get(k)},
                        "was": {k: y.get(k) for k in keys if x.get(k) != y.get(k)}})
    return ops
