"""
Prospect watch (automation idea 10): say which areas matter, and a new building permit or certificate of occupancy there lands as a lead on the
board's Needs you, without anyone opening Prospects and filtering. Make a job then carries what's known into the job, so nobody types it twice.

  area   das_watch, one login's. A person presses Watch this area: a place someone only looked at never starts one (app.py prospects.recent is
         that list, and it's shared by everyone).
  check  after each permits update (updater.py), and once when an area is first watched. It reads what's already kept and fetches nothing. A lead
         is a permit dated in the last FRESH_DAYS that this login hasn't had: the date is what keeps a dataset switched on later from landing as two
         years of "new". Each lead is what Prospects would show: a listed building with that trigger, or a new building no list has yet.
  terms  each permit dataset keeps its own terms (static/research/permit_sources.json). Only a dataset read as open for commercial use makes leads.
         One a person switched on whose terms aren't clearly open stays what it was, a trigger in the Prospects list, and the area says how many
         were held back. What's fetched doesn't change: the columns naming people are still never asked for, so a permit-only lead has no contact.
  mail   nothing is sent. A lead with an email has its first email written and waiting in Mail, Ready to send (mailqueue.queue_prospects) for a press.
         A lead with no email is only a line to call about.

A lead's row is a copy of the prospect row with its trigger and RF need, so it reads the same after the permit has aged out. Standard library only.
"""
import json
import re
import sqlite3
import time

import das
import permits
import prospects

KINDS = ("new_building", "co_issued", "major_alteration", "addition")  # a trigger worth a line. ERCES work already permitted means someone has the job
FRESH_DAYS = 45    # the weekly pull, its overlap, and a city that publishes late
AREA_MAX = 40      # new leads for one area in one check: the rest are still fresh next time
ROWS = 5000        # buildings read for one area
AREAS = 12         # areas per login
NEED_RANK = {"short": 0, "close": 1, "unknown": 2, "ok": 3}
KEEP = ("id", "kind", "name", "address", "city", "state", "zip", "lat", "lon", "precision", "phone", "website", "email", "email_source", "contact_name", "contact_title",
        "size_label", "detail", "source", "approach", "priority", "dist_mi", "permits", "trigger")
KIND_WORD = {"school_k12": "Public school", "school_private": "Private school", "college": "College", "hospital": "Hospital", "nursing_home": "Nursing home",
             "under_construction": "Under construction", "tunnel": "Tunnel", **prospects.OV_KIND_LABEL}
GRIDS = 20         # squares on a floor (das.js DAS.grids, NFPA 1225 ch. 18)


def terms_ok(src):
    """A dataset whose own terms were read as open, commercial use included. Switching one on in Data & updates is a person's call about the Trigger column: it says nothing about leads."""
    return bool(src.get("open")) and src.get("commercial_use") == "allowed"


def sources(settings=None, states=None):
    """(datasets that may make leads, datasets switched on that may not)."""
    regs, ok, held = permits.sources(), [], []
    for sid in permits.enabled(settings, states):
        (ok if terms_ok(regs.get(sid) or {}) else held).append(sid)
    return ok, held


# ---------------------------------------------------------------- areas

def _area(r):
    return {k: r[k] for k in ("id", "label", "lat", "lon", "radius", "at", "checked", "permits", "held_back")}


def areas(con, login):
    return [_area(r) for r in con.execute("SELECT * FROM das_watch WHERE login=? ORDER BY id", (login,))]


def watch(con, login, lat, lon, radius, label=""):
    """Start watching a spot, or change the one already there. Returns the area."""
    try:
        lat, lon = float(lat), float(lon)
        radius = min(50.0, max(1.0, float(radius or 10)))
    except (TypeError, ValueError):
        raise ValueError("Pick where to watch first.") from None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Pick where to watch first.")
    label = re.sub(r"\s+", " ", str(label or "")).strip()[:80] or f"{lat:.3f}, {lon:.3f}"
    have = areas(con, login)
    same = next((a for a in have if round(a["lat"], 2) == round(lat, 2) and round(a["lon"], 2) == round(lon, 2)), None)
    if same:
        con.execute("UPDATE das_watch SET radius=?, label=? WHERE id=?", (radius, label, same["id"]))
        aid = same["id"]
    else:
        if len(have) >= AREAS:
            raise ValueError(f"{AREAS} areas is the most one login can watch. Stop watching one first.")
        aid = con.execute("INSERT INTO das_watch(login, label, lat, lon, radius, at) VALUES(?,?,?,?,?,?)", (login, label, lat, lon, radius, das.now())).lastrowid
    con.commit()
    return aid


def _unqueue(con, login, pids):
    """A lead that's gone takes its waiting first email with it."""
    if not pids:
        return
    import mailqueue
    for p in pids:
        mailqueue.put_off(con, login, f"prospect:{p}", 0)


def unwatch(con, login, aid):
    """Stop watching. Its waiting leads go with it; one made a job or turned down stays on record, so it doesn't come back."""
    _unqueue(con, login, [r[0] for r in con.execute("SELECT pid FROM das_lead WHERE login=? AND watch_id=? AND state='new' AND queued=1", (login, aid))])
    con.execute("DELETE FROM das_lead WHERE login=? AND watch_id=? AND state='new'", (login, aid))
    con.execute("DELETE FROM das_watch WHERE login=? AND id=?", (login, aid))
    con.commit()


# ---------------------------------------------------------------- the check

def _when(p):
    return max(p.get("co_date") or "", p.get("issued") or "", p.get("filed") or "")


def _fresh(perms, today):
    cut = time.strftime("%Y-%m-%d", time.gmtime(time.mktime(time.strptime(today, "%Y-%m-%d")) - FRESH_DAYS * 86400))
    return [p for p in perms if p["kind"] in KINDS and _when(p) >= cut]


def _rank(r):
    t, n = r.get("trigger") or {}, r.get("need") or {}
    step = 0 if t.get("kind") == "new_building" and not t.get("co_date") else 1 if t.get("new") else 2
    return NEED_RANK.get(n.get("ps"), 2), step, r.get("dist_mi") or 0


def _found(con, data_dir, a, ok, today):
    """The buildings with a fresh trigger in an area, as Prospects would show them. -> (rows, permits read)."""
    lat, lon, radius = a["lat"], a["lon"], a["radius"]
    perms = permits.near(data_dir, lat, lon, radius + .2, ok) if ok else []
    permits.link_cos(perms)  # before the date cut: a new building's old permit takes the date of its new CO
    fresh = _fresh(perms, today)
    if not fresh:
        return [], len(perms)
    rows = prospects.near(data_dir, lat, lon, radius, None, "", ROWS)
    rows, extra = permits.attach(data_dir, rows, lat, lon, radius, ok, True, today, perms=fresh)
    hits = list(extra)
    for r in rows:
        t = r.get("trigger")
        if not t or t.get("minor"):
            continue
        if t.get("near_m") is None:
            hits.append(r)
        elif t.get("new"):  # a neighbour's permit, matched by distance only: its own new building, not this one's news
            own = permits.as_prospect(data_dir, f"permit:{t['source']}:{t['permit_id']}")
            if own:
                hits.append(dict(own, dist_mi=r.get("dist_mi")))
    seen, out = set(), []
    for r in hits:
        if r["id"] not in seen:
            seen.add(r["id"])
            out.append(r)
    return prospects.permit_finish(das.with_pipeline(con, out)), len(perms)


def _need(con, data_dir, rows, a):
    """RF need for the new leads: an estimate, and a lead lands without one rather than not landing."""
    try:
        import need
        got = need.for_rows(con, data_dir, rows, {"lat": a["lat"], "lon": a["lon"], "radius": a["radius"]})["need"]
    except Exception as e:  # noqa: BLE001  no licence data on this copy, or a load that failed
        print(f"Note: RF need not worked out for the watch ({e})", flush=True)
        return
    for r in rows:
        n = got.get(r["id"])
        if n:
            r["need"] = {k: n.get(k) for k in ("ps", "margin_db", "ps_why", "nsi") if n.get(k) is not None}


def _queue(con, login, rows):
    """First emails for the leads that have an address: written and waiting, sent only on a press."""
    if not rows:
        return 0
    try:
        import mailqueue
    except ImportError:  # the web version has no mail
        return 0
    return mailqueue.queue_prospects(con, login, [dict(r, kind_label=KIND_WORD.get(r.get("kind"), "")) for r in rows])["queued"]


def check(con, data_dir, settings=None, states=None, login=None, aid=None, today=None):
    """Look at the kept permits for every area (login and aid narrow it). Fetches nothing and sends nothing. -> {new, queued, areas, held_back}."""
    today = today or time.strftime("%Y-%m-%d")
    ok, held = sources(settings, states)
    sql, args = "SELECT * FROM das_watch WHERE 1=1", []
    if login is not None:
        sql, args = sql + " AND login=?", args + [login]
    if aid is not None:
        sql, args = sql + " AND id=?", args + [aid]
    total = {"new": 0, "queued": 0, "areas": 0, "held_back": 0}
    for a in [dict(r) for r in con.execute(sql, args).fetchall()]:
        rows, read = _found(con, data_dir, a, ok, today)
        have = {r[0] for r in con.execute("SELECT pid FROM das_lead WHERE login=?", (a["login"],))}
        new = [r for r in rows if r["id"] not in have and (r.get("status") or "new") == "new" and not r.get("job_id")]
        _need(con, data_dir, new[:AREA_MAX * 3], a)
        new = sorted(new, key=_rank)[:AREA_MAX]
        queued = _queue(con, a["login"], [r for r in new if r.get("email")])
        said = {r["id"] for r in new if r.get("email")} if queued else set()
        for r in new:
            row = {k: r.get(k) for k in KEEP if r.get(k) not in (None, "")}
            row.update(need=r.get("need"), kind_label=KIND_WORD.get(r.get("kind"), r.get("kind") or ""))
            con.execute("INSERT OR IGNORE INTO das_lead(login, pid, watch_id, state, at, queued, row) VALUES(?,?,?,?,?,?,?)",
                        (a["login"], r["id"], a["id"], "new", das.now(), 1 if r["id"] in said else 0, json.dumps(row)))
        back = len(_fresh(permits.near(data_dir, a["lat"], a["lon"], a["radius"] + .2, held), today)) if held else 0
        con.execute("UPDATE das_watch SET checked=?, permits=?, held_back=? WHERE id=?", (das.now(), read, back, a["id"]))
        con.commit()
        total.update(new=total["new"] + len(new), queued=total["queued"] + queued, areas=total["areas"] + 1, held_back=total["held_back"] + back)
    return total


def after_refresh(db_path, data_dir, settings=None, states=None):
    """The check, on its own connection, for the updater's thread."""
    con = sqlite3.connect(db_path, timeout=60)
    con.row_factory = sqlite3.Row
    try:
        return check(con, data_dir, settings, states)
    except sqlite3.OperationalError as e:
        if "no such table" in str(e):  # a copy older than these tables: they come at the next start
            return {"new": 0, "queued": 0, "areas": 0, "held_back": 0}
        raise
    finally:
        con.close()


# ---------------------------------------------------------------- what the page sees

def listing(con, data_dir, login, settings=None, states=None, auto=False):
    """A login's areas and its waiting leads, strongest need first. A lead that's been written to, turned down or made a job leaves by itself, whoever did it."""
    rows = [dict(r) for r in con.execute("SELECT l.*, w.label FROM das_lead l LEFT JOIN das_watch w ON w.id=l.watch_id WHERE l.login=? AND l.state='new'", (login,))]
    st = {}
    ids = [r["pid"] for r in rows]
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        st.update({r["id"]: r for r in con.execute(f"SELECT id, status, job_id FROM das_prospect WHERE id IN ({','.join('?' * len(part))})", part)})
    jobs = {r[0] for r in con.execute("SELECT id FROM das_job")}
    leads = []
    for r in rows:
        p = st.get(r["pid"])
        if p and ((p["status"] or "new") != "new" or p["job_id"] in jobs):
            continue
        x = json.loads(r["row"] or "{}")
        leads.append(dict(x, id=r["pid"], area=r["label"] or "", at=r["at"], queued=bool(r["queued"])))
    leads.sort(key=_rank)
    ok, held = sources(settings, states)
    return {"areas": areas(con, login), "leads": leads, "sources": len(ok), "held_sources": len(held), "pulled": permits.last_pull(data_dir, ok), "auto": bool(auto)}


def drop(con, login, pid):
    """Not for us: it leaves the list and doesn't come back, and a first email waiting for it goes too. The building's own status in Prospects isn't touched."""
    _unqueue(con, login, [r[0] for r in con.execute("SELECT pid FROM das_lead WHERE login=? AND pid=? AND state='new' AND queued=1", (login, pid))])
    con.execute("UPDATE das_lead SET state='gone', done_at=? WHERE login=? AND pid=?", (das.now(), login, pid))
    con.commit()
    return {"ok": True}


def route(con, method, p, data_dir, login, settings, states, body, auto=False):
    """/api/das/leads. (answer) body() reads what was sent."""
    if p == "/api/das/leads" and method == "GET":
        return listing(con, data_dir, login, settings, states, auto)
    if method != "POST":
        raise ValueError("Use POST.")
    d = body()
    if p == "/api/das/leads/watch":
        aid = watch(con, login, d.get("lat"), d.get("lon"), d.get("radius"), d.get("label"))
        return {**check(con, data_dir, settings, states, login, aid), **listing(con, data_dir, login, settings, states, auto), "area": aid}
    if p == "/api/das/leads/unwatch":
        unwatch(con, login, int(d.get("id") or 0))
        return listing(con, data_dir, login, settings, states, auto)
    if p == "/api/das/leads/drop":
        drop(con, login, str(d.get("pid") or ""))
        return listing(con, data_dir, login, settings, states, auto)
    raise LookupError("No such page.")


# ---------------------------------------------------------------- Make a job

def kept(con, pid):
    """The newest copy of a lead's row, whoever's it was, or None."""
    r = con.execute("SELECT row FROM das_lead WHERE pid=? ORDER BY at DESC LIMIT 1", (pid,)).fetchone()
    return json.loads(r[0] or "{}") if r else None


def made_job(con, pid):
    con.execute("UPDATE das_lead SET state='job', done_at=? WHERE pid=? AND state='new'", (das.now(), pid))
    con.commit()


def _trigger(data_dir, pid, row, settings, states):
    """The building's permit, for a row that came without one (the Prospects list keeps it on the page). A neighbour's permit isn't this building's fact."""
    if row.get("lat") is None:
        return None
    try:
        rows = prospects.with_permits(data_dir, [dict(row, id=pid)], row["lat"], row["lon"], .3, [row.get("kind")], settings, states)
    except (sqlite3.Error, ValueError):
        return None
    t = next((r.get("trigger") for r in rows if r.get("id") == pid), None)
    return t if t and not t.get("minor") and t.get("near_m") is None else None


def _contact(con, row):
    """The building's listed contact in Contacts, reused when it's there (das.import_contacts' rule: same email, or same name and organisation). None when the list has no way to reach anyone."""
    name, org = (row.get("contact_name") or "").strip(), (row.get("name") or "").strip()
    phone, email = (row.get("phone") or "").strip(), (row.get("email") or "").strip()
    if not (name or phone or email):
        return None
    for c in das.list_contacts(con):
        if email and (c["email"] or "").strip().lower() == email.lower():
            return c["id"]
        if (c["name"] or "").strip().lower() == name.lower() and (c["org"] or "").strip().lower() == org.lower():
            return c["id"]
    return das.save_contact(con, {"name": name, "org": org, "role": row.get("contact_title") or "Building contact", "phone": phone, "email": email,
                                  "notes": " ".join(x for x in ("From prospects.", row.get("website"), row.get("email_source") and f"Email from {row['email_source']}") if x)})["id"]


def _floors(n):
    return [{"name": str(i + 1), "grids": GRIDS} for i in range(min(200, int(n)))]


def job_data(con, data_dir, pid, row, settings=None, states=None, given=None):
    """What Make a job puts on the new job: address, pin, the building's size, its contact, and the lead's facts in data.lead with their source and terms."""
    given = given if isinstance(given, dict) else {}
    r = {**(kept(con, pid) or {}), **{k: v for k, v in row.items() if v not in (None, "")}}
    r.setdefault("approach", prospects.permit_finish(das.with_pipeline(con, [dict(r, id=pid)]))[0].get("approach"))
    t = r.get("trigger") or _trigger(data_dir, pid, r, settings, states) or {}
    need = given.get("need") if isinstance(given.get("need"), dict) and given["need"].get("ps") else r.get("need")
    need = {k: need.get(k) for k in ("ps", "margin_db", "ps_why") if need.get(k) is not None} if need else None
    nsi = None
    try:
        import need as needmod
        nsi = needmod.kept_nsi(data_dir, [pid]).get(pid)
    except (ImportError, sqlite3.Error, OSError):
        pass
    tenant = "a business inside" in (r.get("detail") or "")  # the listed phone is a tenant's, not the building's: a fact to keep, not an owner to name
    permit_only = pid.startswith("permit:")
    lead = {"pid": pid, "at": das.now(), "kind": r.get("kind"), "kind_label": r.get("kind_label") or KIND_WORD.get(r.get("kind"), r.get("kind") or ""), "name": r.get("name"),
            "detail": r.get("detail"), "size": r.get("size_label"), "approach": r.get("approach"), "phone": r.get("phone"), "website": r.get("website"), "email": r.get("email"),
            "email_source": r.get("email_source"), "contact_name": r.get("contact_name"), "contact_title": r.get("contact_title"), "need": need}
    if t:
        lead["trigger"] = {k: t.get(k) for k in ("label", "kind", "new", "permit_id", "status", "desc", "filed", "issued", "final", "co_date", "address", "sqft", "bldg_sqft", "floors", "use_group",
                                                 "value_usd", "why", "url", "dataset_url", "source", "source_name", "publisher", "license", "attribution", "place")}
        lead["terms_open"] = terms_ok(permits.sources().get(t.get("source")) or {})
    d = {"lat": r.get("lat"), "lon": r.get("lon"), "address": ", ".join(x for x in (r.get("address"), r.get("city"), r.get("state"), r.get("zip")) if x), "lead": {k: v for k, v in lead.items() if v not in (None, "")},
         "notes": f"From prospects ({r.get('source') or ''}): {r.get('phone') or ''} {r.get('website') or ''}".strip()}
    if t:  # the permit's number and what it is. Its dollar value stays in data.lead, which nothing printed reads
        d["notes"] += f"\nPermit {t.get('permit_id')}: {t.get('label')}. {t.get('url') or ''}".rstrip()
    if not permit_only and not tenant:
        d["client"] = r.get("name")
    size = re.search(r"(\d+) floors", r.get("size_label") or "")
    floors = t.get("floors") or (int(size.group(1)) if size else None) or (nsi or {}).get("stories")
    if floors and floors >= 1:
        d["floors"] = _floors(floors)
    area = t.get("bldg_sqft") or (t.get("sqft") if t.get("new") else None) or (nsi or {}).get("sqft")
    if area:
        d["area_sqft"] = area
    if nsi:
        d["nsi"] = nsi
    cid = None if tenant else _contact(con, r)
    if cid:
        d["contacts"] = {"owner": cid}
    return d
