"""Makers and grantees on the FCC's prohibited-entity lists (Cody 11/8): where DAStastic shows equipment (a BOM line,
the parts catalogue, an FCC ID lookup, a booster from FCC grants), a maker on these lists says so.

Two sources, both the FCC's own:
- reference/prohibited_entities.json: the consolidated list under 47 CFR 2.902 (the FCC Covered List with the Commerce
  Entity and Military End-User lists, DHS's UFLPA list, the NDAA 1260H and 5949 lists, Treasury's NS-CMIC list and the
  foreign adversaries), 3,735 entries as of 2026-11-08, downloaded by a person (tools/prohibited_list.py).
- COVERED below: the FCC Covered List's own wording and scope, from the FCC's public notice DA 26-1181 (30 Oct 2026,
  Appendix A), with Hytera's subsidiaries the earlier BOM check knew (Norsat, Sinclair: FINDINGS 15).

Two strengths, so a common name isn't called prohibited on a guess:
- "listed": a Covered List maker or its known subsidiary, matched by name in any text. Said plainly.
- "same name": a maker or grantee whose whole name (or one of the entry's other names) is exactly an entry's on the
  other lists, after company suffixes are set aside. Said as a match to check: the list, country, date and the Federal
  Register citation, and "check it's the same company before buying".
Countries (the foreign adversaries) and categories (routers, power inverters...) are never matched as names. The list
is read once and kept; a match is a dictionary lookup.
"""
import csv
import io
import json
import os
import re
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
LIST_FILE = os.path.join(HERE, "reference", "prohibited_entities.json")
DA_26_1181 = "https://docs.fcc.gov/public/attachments/DA-26-1181A1.pdf"

# The Covered List makers whose equipment DAStastic can meet, with DA 26-1181's scope (Appendix A, 30 Oct 2026)
COVERED = [
    {"name": "Huawei", "pattern": r"\bhuawei\b", "since": "2021-03-12",
     "scope": "telecommunications equipment produced or provided by Huawei Technologies Company"},
    {"name": "ZTE", "pattern": r"\bzte\b", "since": "2021-03-12",
     "scope": "telecommunications equipment produced or provided by ZTE Corporation"},
    {"name": "Hytera", "pattern": r"\b(hytera|norsat|sinclair technologies|sinclair)\b", "since": "2021-03-12",
     "scope": "video surveillance and telecommunications equipment of Hytera Communications Corporation (and its subsidiaries; "
              "Norsat and its Sinclair Technologies division are Hytera's) used for public safety, security of government "
              "facilities, physical security surveillance of critical infrastructure and other national security purposes. "
              "DA 26-635 (June 2026) bars importing or marketing previously authorized Hytera gear for those uses; whether a "
              "passive part is caught isn't settled"},
    {"name": "Hikvision", "pattern": r"\bhikvision\b", "since": "2021-03-12",
     "scope": "video surveillance and telecommunications equipment of Hangzhou Hikvision Digital Technology Company, for "
              "public safety and security uses"},
    {"name": "Dahua", "pattern": r"\bdahua\b", "since": "2021-03-12",
     "scope": "video surveillance and telecommunications equipment of Dahua Technology Company, for public safety and "
              "security uses"},
    {"name": "Kaspersky", "pattern": r"\bkaspersky\b", "since": "2022-03-25",
     "scope": "information security products and services of Kaspersky Lab and its affiliates"},
]
CATEGORIES = [
    {"kind": "router", "pattern": r"\b(router|gateway|lte modem|cellular modem|m2m modem)\b", "since": "2026-03-23",
     "text": "Foreign-produced routers are on the FCC Covered List since 23 Mar 2026, except models with a Conditional Approval "
             "(DA 26-1181 Appendix B lists them, with end dates). Check where this one is made and whether its model is approved."},
    {"kind": "inverter", "pattern": r"\b(power )?inverter\b", "since": "2026-07-28",
     "text": "Foreign-produced power inverters are on the FCC Covered List since 28 Jul 2026 (updated 20 Aug 2026), except "
             "those with a Conditional Approval. Check where this one is made."},
]
SUFFIXES = {"co", "company", "corp", "corporation", "inc", "incorporated", "ltd", "limited", "llc", "lp", "plc", "jsc", "ojsc",
            "pjsc", "cjsc", "ooo", "oao", "zao", "ao", "pao", "gmbh", "ag", "sa", "srl", "bv", "nv", "pte", "pty", "kk",
            "the", "and", "of", "group"}
_lock = threading.Lock()
_index = None


def norm(name):
    """A company name for comparison: lower case, no punctuation, no company suffixes ('Hytera Communications Co., Ltd.'
    and 'Hytera Communications' compare equal)."""
    words = re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).split()
    while words and words[-1] in SUFFIXES:
        words.pop()
    while words and words[0] in ("the",):
        words.pop(0)
    return " ".join(words)


def _load():
    global _index
    with _lock:
        if _index is not None:
            return _index
        idx, meta = {}, {}
        try:
            with open(current_path(), encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, ValueError):
            doc = {"rows": []}
        meta = {"as_of": doc.get("as_of"), "page": doc.get("page"), "entries": len(doc.get("rows") or [])}
        for name, aka, lists, country, added, cite in doc.get("rows") or []:
            if any(lst.startswith("Foreign Adversaries") for lst in lists) or name.lower().startswith(("foreign-produced", "all equipment")):
                continue  # countries and categories are never names
            entry = {"name": name, "lists": lists, "country": country, "added": added, "cite": cite}
            for n in [name] + [a for a in aka if len(a) >= 4]:
                k = norm(n)
                if len(k) >= 4:
                    idx.setdefault(k, []).append(entry)
        _index = {"names": idx, "meta": meta, "covered": [dict(c, rx=re.compile(c["pattern"], re.I)) for c in COVERED],
                  "categories": [dict(c, rx=re.compile(c["pattern"], re.I)) for c in CATEGORIES]}
        return _index


def about():
    """The list's date and size, for the page that shows a match."""
    return dict(_load()["meta"], notice=DA_26_1181)


def covered(text):
    """The Covered List makers named anywhere in text: [{"name", "since", "scope", "strength": "listed"}]."""
    out, t = [], text or ""
    for c in _load()["covered"]:
        if c["rx"].search(t):
            out.append({"name": c["name"], "since": c["since"], "scope": c["scope"], "strength": "listed",
                        "source": "FCC Covered List (DA 26-1181, 30 Oct 2026)", "url": DA_26_1181})
    return out


def same_name(name):
    """Entries on the consolidated list whose name (or other name) is exactly this maker's, suffixes aside:
    [{"name", "lists", "country", "added", "cite", "strength": "same name"}]. Empty for a blank or very short name."""
    k = norm(name)
    if len(k) < 4:
        return []
    return [dict(e, strength="same name") for e in _load()["names"].get(k, [])]


def category(text):
    """A Covered List category the text describes (a router, a power inverter): [{"kind", "since", "text"}]."""
    t = text or ""
    return [{"kind": c["kind"], "since": c["since"], "text": c["text"], "url": DA_26_1181} for c in _load()["categories"] if c["rx"].search(t)]


def check(maker=None, text=None):
    """Everything to say about one piece of equipment: {"listed": [...], "same_name": [...], "category": [...]}, each
    empty when there's nothing; a Covered List maker isn't repeated as a same-name match."""
    listed = covered(" ".join(x for x in (maker, text) if x))
    names = {c["name"].lower() for c in listed}
    same = [e for e in same_name(maker) if not any(n in e["name"].lower() for n in names)] if maker else []
    return {"listed": listed, "same_name": same, "category": category(text) if text else []}


# ---------------------------------------------------------------- the FCC's CSV, as a person downloads it (tools/prohibited_list.py, Intake)
PAGE = "https://www.fcc.gov/engineering-technology/prohibited-entities-list"
COLS = ["Entity Name", "Also Known As", "Source List", "Country", "Date Added", "FR Citation"]


def parse_list(text):
    """[[name, [aka...], [lists...], country, date_added, cite]] from the FCC's CSV; refuses anything else."""
    rows = list(csv.reader(io.StringIO(text.replace("�", "§"))))
    if not rows or [c.strip() for c in rows[0][:len(COLS)]] != COLS:
        raise ValueError("not the FCC's prohibited entities list: header " + ", ".join(COLS))
    out = []
    for r in rows[1:]:
        r = [c.strip() for c in r[:len(COLS)]] + [""] * (len(COLS) - len(r[:len(COLS)]))
        name, aka, lists, country, added, cite = r
        if not name:
            continue
        out.append([name, [a.strip() for a in aka.split(";") if a.strip()], [x.strip() for x in lists.split(";") if x.strip()],
                    country, added, cite])
    if len(out) < 1000:
        raise ValueError(f"only {len(out)} entities read: not the whole list")
    return out


def list_doc(rows, as_of):
    return {"source": "FCC consolidated list of prohibited entities (47 CFR 2.902)", "page": PAGE, "as_of": as_of,
            "terms": "US government public data", "columns": ["name", "aka", "lists", "country", "added", "cite"], "rows": rows}


def imported_path():
    """Where an imported list is kept: the data folder, which a deploy never touches (Intake, Cody 11/8)."""
    import uls_import
    return os.path.join(uls_import.DATA_DIR, "reference", "prohibited_entities.json")


def _date_of(path):
    try:
        with open(path, encoding="utf-8") as fh:
            m = re.search(r'"as_of":"(\d{4}-\d{2}-\d{2})"', fh.read(4000))
        return m.group(1) if m else ""
    except OSError:
        return ""


def current_path():
    """The list read: an imported one (Intake) when it's newer than the one shipped with the app, else the shipped one."""
    try:
        p = imported_path()
    except Exception:
        return LIST_FILE
    return p if os.path.exists(p) and _date_of(p) > _date_of(LIST_FILE) else LIST_FILE


def save_import(doc):
    """Keep an imported list (newer than what's here, or refused) and make it the one read."""
    global _index
    have = _date_of(current_path())
    if (doc.get("as_of") or "") < have:
        raise ValueError(f"This list is as of {doc.get('as_of')}; DAStastic already has the one as of {have}.")
    p = imported_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p + ".part", "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")
    os.replace(p + ".part", p)
    with _lock:
        _index = None  # read again on the next check
    return p
