"""
The licences a DAS job relies on, watched across FCC data refreshes (R1 #2), and the other licensees inside the
booster's passbands (R1 #7, 47 CFR 90.219(b)(1)).

Change watch. The job's licences are the call signs in its pre-survey channel plan and ticks, plus any licensee whose
consent the job tracks. The first time a job is checked, each one's FCC facts are snapshotted (status, licensee,
expiry, downlink and uplink channels, sites, modes), with the base and fixed stations of other licensees inside the
plan's passbands nearby. After every FCC data build the current facts are compared with the snapshot; what changed is
kept with the job (data.lic_watch), with what it means for the job's stage, and shows in the job and on the board's
"Needs you" until it's marked handled or a new baseline is taken.

Everything is read from the licence tables (tx, tx_history); nothing is guessed. The snapshot lives in the job's own
data, so it is backed up and exported with the job.
"""
import json
import re
import time

import geo

KEEP_KEYS = ("snapshot", "findings", "ack", "checked_built_at", "checked_at")
STATUS = {"A": "Active", "C": "Cancelled", "E": "Expired", "T": "Terminated", "L": "Pending legal status", "P": "Parent licence cancelled"}
SOON_DAYS = 90
NEAR_MI = 15.0  # the pre-survey's default reach
CLASS_A_KHZ = 75.0  # Class A: each passband 75 kHz or less (47 CFR 90.7)
POST_INSTALL = ("Install", "Commission", "Acceptance", "In service")
ESMR = (862.0, 869.0)  # commercial ESMR inside the 800 MHz downlink span: kept out of a public safety booster
FIRSTNET = ((758.0, 768.0), (788.0, 798.0))

now = lambda: time.strftime("%Y-%m-%d %H:%M")


def _norm(s):
    return re.sub(r"[^A-Z0-9]+", " ", (s or "").upper()).strip()


def licensee_key(name):
    return _norm(name)[:120]


def _iso(d):
    """FCC dates are MM/DD/YYYY; kept as YYYY-MM-DD."""
    m = re.match(r"^(\d\d)/(\d\d)/(\d{4})$", (d or "").strip())
    return f"{m.group(3)}-{m.group(1)}-{m.group(2)}" if m else (d or "")


def _f(x):
    try:
        return round(float(x), 5)
    except (TypeError, ValueError):
        return None


def built_at(con):
    try:
        r = con.execute("SELECT v FROM meta WHERE k='built_at'").fetchone()
        return r[0] if r else None
    except Exception:
        return None


# ---------------------------------------------------------------- what the job relies on

def plan_of(d):
    return [p for p in ((d.get("presurvey") or {}).get("plan") or []) if isinstance(p, dict) and p.get("call_sign")]


def calls_of(d):
    """The call signs a job relies on: its channel plan, its ticked systems, and the licensees whose consent it tracks."""
    out = {p["call_sign"].upper() for p in plan_of(d)}
    out |= {c.upper() for c in ((d.get("presurvey") or {}).get("include") or []) if isinstance(c, str)}
    for c in (d.get("consents") or {}).values():
        if isinstance(c, dict):
            out |= {x.upper() for x in c.get("calls") or [] if isinstance(x, str)}
    return sorted(x for x in out if x)


def plan_channels(d):
    """{call: (downlinks, uplinks)} from the saved plan."""
    out = {}
    for p in plan_of(d):
        dn, up = out.setdefault(p["call_sign"].upper(), (set(), set()))
        f = _f(p.get("downlink_mhz"))
        if f:
            dn.add(f)
        for u in str(p.get("uplink_mhz") or "").split():
            if _f(u):
                up.add(_f(u))
    return out


def spans_of(d):
    """Each passband the booster must pass: the lowest to the highest planned channel per band, downlink and uplink
    apart (a booster filters each direction on its own: 800 MHz is 851-869 down and 806-824 up, not 806-869). Spans
    of one band that overlap (VHF / UHF simplex, talk-around) are one."""
    import das
    by = {}
    for dn, up in plan_channels(d).values():
        for way, fs in (("down", dn), ("up", up)):
            for f in fs:
                by.setdefault((das.band_of(f), way), set()).add(f)
    spans = []
    for (band, way), fs in sorted(by.items(), key=lambda x: min(x[1])):
        x = {"band": band, "dir": way, "lo": min(fs), "hi": max(fs), "channels": sorted(fs)}
        same = next((s for s in spans if s["band"] == band and s["lo"] <= x["hi"] and x["lo"] <= s["hi"]), None)
        if same:
            same.update(lo=min(same["lo"], x["lo"]), hi=max(same["hi"], x["hi"]), channels=sorted(set(same["channels"]) | fs),
                        dir=same["dir"] if same["dir"] == way else "down + up")
        else:
            spans.append(x)
    return spans


def area_of(d):
    lat, lon = d.get("lat"), d.get("lon")
    if lat is None or lon is None:
        return None
    try:
        r = float((d.get("presurvey") or {}).get("radius") or NEAR_MI)
    except (TypeError, ValueError):
        r = NEAR_MI
    return {"lat": float(lat), "lon": float(lon), "radius_mi": max(1.0, min(60.0, r))}


# ---------------------------------------------------------------- the FCC facts for one licence

def facts(con, call):
    """One call sign's facts from the licence table (the active licence when it has several), or a "missing" record
    with when the history last saw it."""
    rows = con.execute("SELECT usi, status, licensee, expired_date, service, station_class, freq_mhz, lat, lon, mode "
                       "FROM tx WHERE call_sign=?", (call,)).fetchall()
    if not rows:
        last = con.execute("SELECT MAX(last_seen), MAX(licensee) FROM tx_history WHERE call_sign=?", (call,)).fetchone() \
            if con.execute("SELECT 1 FROM sqlite_master WHERE name='tx_history'").fetchone() else (None, None)
        return {"call": call, "missing": True, "last_seen": last[0], "licensee": last[1]}
    best = max({(r[0], r[1]) for r in rows}, key=lambda u: (u[1] == "A", u[0]))
    mine = [r for r in rows if r[0] == best[0]]
    cls = lambda r, p: (r[5] or "").upper().startswith(p)
    return {"call": call, "usi": best[0], "status": best[1], "licensee": mine[0][2] or "", "expires": _iso(mine[0][3]),
            "service": mine[0][4] or "",
            "down": sorted({_f(r[6]) for r in mine if r[6] and (cls(r, "FB") or cls(r, "FX"))}),
            "mob": sorted({_f(r[6]) for r in mine if r[6] and cls(r, "MO")}),
            "sites": sorted({f"{r[7]:.4f},{r[8]:.4f}" for r in mine if r[7] is not None and r[8] is not None and (cls(r, "FB") or cls(r, "FX"))}),
            "modes": sorted({r[9] for r in mine if r[9]})}


# ---------------------------------------------------------------- other licensees in the passbands

def neighbours(con, area, spans, exclude=(), class_a_khz=CLASS_A_KHZ):
    """Base and fixed stations of other licensees within the area whose frequencies fall inside a passband span,
    grouped by licensee: what a Class B (wideband) booster would pass, and which a Class A one (75 kHz around each
    planned channel) would pass too."""
    if not area or not spans:
        return []
    s, n, w, e = geo.bbox(area["lat"], area["lon"], area["radius_mi"])
    lim = area["radius_mi"] * geo.MI_KM
    half_a = class_a_khz / 2000.0
    planned = sorted({f for x in spans for f in x["channels"]})
    where = " OR ".join("(freq_mhz BETWEEN ? AND ?)" for _ in spans)
    args = [s, n, w, e] + [v for x in spans for v in (x["lo"] - 0.00625, x["hi"] + 0.00625)]
    rows = con.execute("SELECT call_sign, usi, licensee, freq_mhz, lat, lon, service, category, service_name FROM tx "
                       "WHERE status='A' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND "
                       "(station_class LIKE 'FB%' OR station_class LIKE 'FX%') AND (" + where + ")", args).fetchall()
    skip = {c.upper() for c in exclude}
    by = {}
    for r in rows:
        call = (r[0] or "").upper()
        if call in skip:
            continue
        d = geo.haversine_km(area["lat"], area["lon"], r[4], r[5])
        if d > lim:
            continue
        f = _f(r[3])
        near = min((abs(f - p) for p in planned), default=99)
        k = licensee_key(r[2]) or call
        x = by.setdefault(k, {"key": k, "licensee": r[2] or call, "calls": set(), "freqs": set(), "nearest_mi": None,
                              "class_a": False, "co_channel": False, "adjacent": False, "esmr": False, "firstnet": False,
                              "services": set(), "category": r[7] or "", "usi": {}, "by_call": {}})
        x["calls"].add(call)
        x["by_call"].setdefault(call, set()).add(_f(r[3]))
        x["usi"][call] = r[1]
        x["freqs"].add(f)
        x["services"].add(r[8] or r[6] or "")
        mi = round(d / geo.MI_KM, 2)
        x["nearest_mi"] = mi if x["nearest_mi"] is None else min(x["nearest_mi"], mi)
        x["class_a"] |= near <= half_a
        x["co_channel"] |= near < 0.003
        x["adjacent"] |= 0.003 <= near <= 0.0125
        x["esmr"] |= ESMR[0] <= f <= ESMR[1]
        x["firstnet"] |= any(lo <= f <= hi for lo, hi in FIRSTNET)
    out = []
    for x in by.values():
        x.update(calls=sorted(x["calls"]), freqs=sorted(x["freqs"]), services=sorted(s for s in x["services"] if s),
                 by_call={c: sorted(v) for c, v in x["by_call"].items()})
        out.append(x)
    out.sort(key=lambda x: (not x["co_channel"], not x["class_a"], x["nearest_mi"] or 0))
    return out


def passband(con, d):
    """The passband licensees for a job: the chosen systems' licensees and every other licensee whose base or fixed
    stations near the building fall inside a band the booster passes. Each with whether a Class A or a Class B booster
    passes it (and so needs its consent, 47 CFR 90.219(b)(1)) and the consent status the job keeps."""
    area, spans = area_of(d), spans_of(d)
    plan = plan_of(d)
    cons = d.get("consents") or {}
    chosen = {}
    for p in plan:
        k = licensee_key(p.get("system")) or p["call_sign"].upper()
        x = chosen.setdefault(k, {"key": k, "licensee": p.get("system") or p["call_sign"], "calls": set(), "freqs": set()})
        x["calls"].add(p["call_sign"].upper())
        if _f(p.get("downlink_mhz")):
            x["freqs"].add(_f(p.get("downlink_mhz")))
    rows = []
    for x in chosen.values():
        rows.append({"key": x["key"], "licensee": x["licensee"], "calls": sorted(x["calls"]), "freqs": sorted(x["freqs"]), "by_call": {},
                     "chosen": True, "class_a": True, "class_b": True, "nearest_mi": None, "co_channel": False, "adjacent": False,
                     "esmr": False, "firstnet": False, "services": [], "category": ""})
    others = neighbours(con, area, spans, exclude={c for x in chosen.values() for c in x["calls"]}) if area else []
    for x in others:
        x.pop("usi", None)
        if x["key"] in chosen:  # another licence of a chosen licensee: its consent is the same letter
            c = next(r for r in rows if r["key"] == x["key"])
            c["calls"] = sorted(set(c["calls"]) | set(x["calls"]))
            c["also_freqs"] = x["freqs"]
            c["by_call"] = x["by_call"]
            continue
        rows.append({**x, "chosen": False, "class_b": not x["esmr"]})
    for r in rows:
        c = cons.get(r["key"]) or {}
        r["consent"] = {"status": c.get("status") or "not asked", "date": c.get("date") or "", "note": c.get("note") or ""}
    bands = []
    for sp in spans:
        inside = [r for r in rows if not r["chosen"] and any(sp["lo"] - 0.00625 <= f <= sp["hi"] + 0.00625 for f in r["freqs"])]
        bands.append({**sp, "others": len(inside), "others_class_a": sum(1 for r in inside if r["class_a"])})
    return {"bands": bands, "licensees": rows, "area": area, "built_at": built_at(con),
            "source": "FCC ULS base and fixed stations (tx), active licences" + (f", data of {built_at(con)}" if built_at(con) else "")}


# ---------------------------------------------------------------- snapshot and compare

def snapshot(con, d, keep=None):
    """The job's licences as the FCC data has them now. keep: an older snapshot whose facts stay the baseline for
    the call signs it already had (a ticked system added later gets its own baseline from today)."""
    calls = calls_of(d)
    old = {x["call"]: x for x in (keep or {}).get("calls") or []}
    area, spans = area_of(d), spans_of(d)
    same_spans = keep and keep.get("spans") == [[s["lo"], s["hi"]] for s in spans] and keep.get("area") == area
    nb = (keep or {}).get("neighbours") if same_spans else None
    if nb is None:
        nb = [{"key": x["key"], "licensee": x["licensee"], "calls": x["calls"]} for x in neighbours(con, area, spans, exclude=calls)]
    return {"built_at": (old and keep.get("built_at")) or built_at(con), "taken_at": (keep or {}).get("taken_at") or now(),
            "calls": [old.get(c) or {**facts(con, c), "since": built_at(con)} for c in calls],
            "area": area, "spans": [[s["lo"], s["hi"]] for s in spans], "neighbours": nb,
            "neighbours_since": (keep or {}).get("neighbours_since") if same_spans else built_at(con)}


def _list(fs):
    fs = list(fs)
    return ", ".join(f"{f:.5f}".rstrip("0").rstrip(".") for f in fs[:8]) + (f" and {len(fs) - 8} more" if len(fs) > 8 else "")


def _diff_f(a, b):
    """Frequencies in a and not in b (to 10 Hz)."""
    bb = {round(x, 5) for x in b}
    return sorted(x for x in a if round(x, 5) not in bb)


def compare(con, d, snap, stage, today=None):
    """What changed since the snapshot, as findings: {key, kind, call, severity, what, why, source}."""
    post = stage in POST_INSTALL
    today = today or time.strftime("%Y-%m-%d")
    src = f"FCC ULS data of {built_at(con) or '?'} against the job's snapshot of the FCC data of {snap.get('built_at') or '?'}"
    out = []

    usi = {}

    def add(kind, call, sev, what, why, key=""):
        u = usi.get(call)
        out.append({"key": f"{kind}|{call}|{key}", "kind": kind, "call": call, "severity": sev, "what": what, "why": why,
                    "source": src, "url": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={u}" if u
                    else "https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp"})
    donor = {k.upper(): (v or {}).get("site") for k, v in ((d.get("presurvey") or {}).get("terrain") or {}).items() if isinstance(v, dict)}
    plan = plan_channels(d)
    for s in snap.get("calls") or []:
        call = s["call"]
        c = facts(con, call)
        usi[call] = c.get("usi") or s.get("usi")
        who = c.get("licensee") or s.get("licensee") or ""
        name = f"{call} ({who})" if who else call
        if s.get("missing"):
            if not c.get("missing"):
                add("back", call, "low", f"{name} is in the FCC data again.", "Check its channels against the plan.")
            continue
        if c.get("missing"):
            add("gone", call, "high", f"{name} is no longer in the FCC data" + (f" (last seen {c['last_seen'][:10]})." if c.get("last_seen") else "."),
                "The booster may pass channels nobody is licensed on now. Ask the agency where the system moved, retune and retest: the consent was for this licence."
                if post else "Ask the agency what replaced it before the design and filter order; the consent letter must name the current licence.")
            continue
        if c["status"] != "A" and s.get("status") == "A":
            add("status", call, "high", f"{name} is now {STATUS.get(c['status'], c['status'])} in the FCC data.",
                "Nobody holds these channels now: ask the agency what replaced them, then retune the booster and retest. A consent from a lapsed licence doesn't cover the new one."
                if post else "Ask the agency what replaced it before the design; take its channels off the plan or move them to the new licence.")
        if licensee_key(c["licensee"]) != licensee_key(s.get("licensee")) and s.get("licensee"):
            add("renamed", call, "medium", f"{call}'s licensee is now {c['licensee']} (was {s['licensee']}).",
                "Consent letters, the AHJ report and the radio system owner contact should name the current licensee; a new holder gives its own consent (47 CFR 90.219(b)(1)).",
                licensee_key(c["licensee"]))
        gone, new = _diff_f(s.get("down") or [], c["down"]), _diff_f(c["down"], s.get("down") or [])
        if gone:
            add("down-", call, "high", f"Downlink channels dropped from {name}: {_list(gone)} MHz.",
                "A Class A filter on a dropped channel passes nothing, and if the agency moved them the radios won't work inside on the new ones: retune and retest."
                if post else "Take them off the channel plan (Pre-survey: untick and tick the system again) before the design and filter order.", _list(gone))
        if new:
            add("down+", call, "medium" if post else "low", f"New downlink channels on {name}: {_list(new)} MHz.",
                "A Class A booster doesn't pass them until it's retuned; a Class B one passes them only inside its passband. Radios on them may not work inside: retune and retest."
                if post else "Add them to the plan (Pre-survey: untick and tick the system again) if the AHJ wants them carried.", _list(new))
        gone_u, new_u = _diff_f(s.get("mob") or [], c["mob"]), _diff_f(c["mob"], s.get("mob") or [])
        if gone_u or new_u:
            add("up", call, "medium", f"Uplink (radio transmit) channels on {name} changed:"
                + (f" dropped {_list(gone_u)} MHz" if gone_u else "") + (";" if gone_u and new_u else "") + (f" added {_list(new_u)} MHz" if new_u else "") + ".",
                "The booster's uplink filters must match the radios' transmit channels: retune and retest the uplink." if post
                else "Check the plan's uplink column against the licence.", _list(gone_u) + "/" + _list(new_u))
        gs = sorted(set(s.get("sites") or []) - set(c["sites"]))
        ns = sorted(set(c["sites"]) - set(s.get("sites") or []))
        dsite = donor.get(call)
        dsite = f"{float(dsite.split(',')[0]):.4f},{float(dsite.split(',')[1]):.4f}" if dsite and "," in dsite else None
        if dsite and dsite in gs:
            add("donor", call, "high", f"The donor site this job aims at for {call} ({dsite}) is gone from the licence.",
                "Re-aim the donor antenna at a site still on the air and retest the donor level (Pre-survey: Terrain paths, Donor aiming sheet).", dsite)
            gs = [x for x in gs if x != dsite]
        if gs:
            add("sites-", call, "medium", f"{len(gs)} site{'s' if len(gs) != 1 else ''} gone from {name}: {', '.join(gs[:4])}{'…' if len(gs) > 4 else ''}.",
                "If the donor antenna points at one of them, re-aim it at a site still on the air and retest the donor level.", ";".join(gs))
        if ns:
            add("sites+", call, "low", f"{len(ns)} new site{'s' if len(ns) != 1 else ''} on {name}: {', '.join(ns[:4])}{'…' if len(ns) > 4 else ''}.",
                "A closer or stronger site changes the donor level and can add simulcast delay: check the donor reading.", ";".join(ns))
        if (s.get("modes") or []) != c["modes"] and c["modes"]:
            add("mode", call, "medium", f"Mode on {name} changed: {' / '.join(s.get('modes') or ['none on file'])} → {' / '.join(c['modes'])}.",
                "A booster set up for the old mode may need other settings (P25 Phase 2 TDMA needs per-timeslot gain control): check the booster and retest audio quality (DAQ)."
                if post else "Plan the booster and the acceptance test for the new mode.", "/".join(c["modes"]))
        exp = c.get("expires") or ""
        if c["status"] == "A" and re.match(r"^\d{4}-\d\d-\d\d$", exp):
            days = (time.mktime(time.strptime(exp, "%Y-%m-%d")) - time.mktime(time.strptime(today, "%Y-%m-%d"))) / 86400
            if days <= SOON_DAYS:
                add("expires", call, "medium" if days < 0 else "low",
                    f"{name} {'expired' if days < 0 else 'expires'} {exp}" + (" in the FCC data, still marked active." if days < 0 else "."),
                    "If the licensee doesn't renew it, the channels go and the consent goes with them.", exp)
        # the plan's channels the licence doesn't hold (a plan built from older data, or typed), not already reported
        pdn = plan.get(call, (set(), set()))[0]
        odd = _diff_f(_diff_f(sorted(pdn), c["down"]), gone)
        if odd:
            add("plan", call, "medium", f"The channel plan has {call} downlink channels the licence doesn't hold: {_list(odd)} MHz.",
                "Rebuild the plan from the Pre-survey (untick and tick the system) so the filters and the report match the licence.", _list(odd))
    # new licensees inside the passbands near the building
    area, spans = area_of(d), spans_of(d)
    if area and spans and snap.get("neighbours") is not None and [[x["lo"], x["hi"]] for x in spans] == snap.get("spans") and area == snap.get("area"):
        had = {x["key"] for x in snap["neighbours"]}
        cls = (d.get("booster_class") or "Class A (channelized)")
        for x in neighbours(con, area, spans, exclude=calls_of(d)):
            if x["key"] in had:
                continue
            on = "on a job channel" if x["co_channel"] else "next to a job channel" if x["adjacent"] else "inside the booster's passband"
            usi[",".join(x["calls"])] = x["usi"].get(x["calls"][0])
            add("neighbour", ",".join(x["calls"]), "high" if x["co_channel"] else "medium",
                f"New licensee {on}: {x['licensee']} ({', '.join(x['calls'][:3])}; {_list(x['freqs'])} MHz; {x['nearest_mi']} mi away).",
                ("A Class B booster passes it, so 47 CFR 90.219(b)(1) needs its consent too, and its signal adds to the booster's load."
                 if cls.startswith("Class B") or not x["class_a"] else
                 "It falls inside a Class A channel filter: its consent is needed and its signal adds to the booster's load.")
                + (" On a job channel it can also interfere: check for co-channel noise at the donor." if x["co_channel"] else ""), x["key"])
    return out


def check(con, jid, d, stage, force=False):
    """Snapshot the job's licences (the first time, or for call signs added since), compare with the current FCC data,
    keep the result with the job and return the watch."""
    w = dict(d.get("lic_watch") or {})
    b = built_at(con)
    calls = calls_of(d)
    if not calls or b is None:
        return w
    snap = w.get("snapshot")
    spans = [[s["lo"], s["hi"]] for s in spans_of(d)]
    if not snap or [x["call"] for x in snap.get("calls") or []] != calls or snap.get("spans") != spans or snap.get("area") != area_of(d):
        w["snapshot"] = snap = snapshot(con, d, snap)
    elif not force and w.get("checked_built_at") == b and "findings" in w:
        return w
    old = {f["key"]: f for f in w.get("findings") or []}
    found = compare(con, d, snap, stage)
    for f in found:
        f["first_seen"] = (old.get(f["key"]) or {}).get("first_seen") or now()
    w.update(findings=found, checked_built_at=b, checked_at=now())
    _store(con, jid, w)
    fresh = [f for f in found if f["key"] not in old]
    if fresh:
        con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                    (jid, time.strftime("%Y-%m-%d %H:%M:%S"), "licence watch",
                     (f"{len(fresh)} FCC licence change{'s' if len(fresh) != 1 else ''}: " + "; ".join(f["what"] for f in fresh[:3]))[:500]))
        con.commit()
    return w


def _store(con, jid, w):
    """Only data.lic_watch is written (json_set), so a save of the job's other fields at the same moment isn't lost."""
    con.execute("UPDATE das_job SET data=json_set(COALESCE(data,'{}'), '$.lic_watch', json(?)) WHERE id=?", (json.dumps(w), jid))
    con.commit()


def baseline(con, jid, d):
    """Take today's FCC data as the new baseline: every change so far counts as handled."""
    w = dict(d.get("lic_watch") or {})
    w["snapshot"] = snapshot(con, d)
    w.update(findings=[], checked_built_at=built_at(con), checked_at=now(), ack={})
    _store(con, jid, w)
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)",
                (jid, time.strftime("%Y-%m-%d %H:%M:%S"), "licence watch", f"new baseline: FCC data of {built_at(con)}"))
    con.commit()
    return w


def ack(con, jid, d, key, on=True):
    w = dict(d.get("lic_watch") or {})
    a = dict(w.get("ack") or {})
    if on:
        a[key] = now()
    else:
        a.pop(key, None)
    w["ack"] = a
    _store(con, jid, w)
    return w


def open_items(w):
    a = w.get("ack") or {}
    return [f for f in w.get("findings") or [] if f["key"] not in a]


def board(con, jid, d, stage):
    """The job's open licence changes as "Needs you" lines, checked again when the FCC data is newer than the last
    check. Never raises: a copy with no FCC data just has none."""
    if stage == "Closed" or not calls_of(d):
        return []
    try:
        w = check(con, jid, d, stage)
    except Exception:
        w = d.get("lic_watch") or {}  # no licence table on this copy, or it's being rebuilt: the last result stands
    rank = {"high": 0, "medium": 1, "low": 2}
    items = sorted((f for f in open_items(w) if f["severity"] in ("high", "medium")), key=lambda f: rank[f["severity"]])
    return [{"text": "FCC licence change: " + f["what"].rstrip("."), "url": f["url"], "source": f["source"], "key": f["key"],
             "severity": f["severity"]} for f in items[:4]]


def run_all(db_path, log=print):
    """After an FCC data build: check every open job that relies on licences. Returns the jobs with new findings."""
    import sqlite3
    con = sqlite3.connect(db_path, timeout=60)
    con.row_factory = sqlite3.Row
    n = 0
    try:
        for r in con.execute("SELECT id, stage, data FROM das_job").fetchall():
            if r["stage"] == "Closed":
                continue
            d = json.loads(r["data"] or "{}")
            if not calls_of(d):
                continue
            before = {f["key"] for f in (d.get("lic_watch") or {}).get("findings") or []}
            w = check(con, r["id"], d, r["stage"])
            n += bool({f["key"] for f in w.get("findings") or []} - before)
    finally:
        con.close()
    if n:
        log(f"licence watch: {n} job{'s' if n != 1 else ''} with new FCC changes")
    return n
