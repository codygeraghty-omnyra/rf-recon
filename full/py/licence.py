"""
Whose copy of DAStastic this is (Cody 11/8: Andy Masur's Mobili-Fi copy for the 11/9 demo, "give it a license for now").

A licence is licence.json in the copy's data folder, written once when the copy is set up (ops/licensed_copy.py): who it's
licensed to, the contact, a licence number, the kind ("Demo" for now) and the dates. No file: Omnyra's own copy. Nothing
here enforces anything (the web version's code is public, so a key can't be checked: Cody 10/31, licence keys "for
later"); it says on screen whose copy it is.

It also carries the copy's look: the business's palette for the Phone window, and its website, whose Employee login comes
to this copy's /login.
"""
import json
import os
import re

FIELDS = ("id", "licensee", "contact", "email", "kind", "issued", "ends", "website", "palette")
_seen = {}


def path(data_dir):
    return os.path.join(data_dir, "licence.json")


def load(data_dir):
    """The copy's licence, or None for Omnyra's own copy. Read again only when the file changes."""
    p = path(data_dir)
    try:
        st = os.stat(p)
    except OSError:
        return None
    hit = _seen.get(p)
    if hit and hit[0] == st.st_mtime_ns:
        return hit[1]
    try:
        with open(p, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None
    d = {k: d.get(k) for k in FIELDS if d.get(k) not in (None, "")}
    pal = d.get("palette") or {}
    d["palette"] = {k: v for k, v in pal.items() if re.fullmatch(r"[a-z-]{2,20}", k) and re.fullmatch(r"#[0-9a-fA-F]{6}", str(v))}
    _seen[p] = (st.st_mtime_ns, d if d.get("licensee") else None)
    return _seen[p][1]


def save(data_dir, d):
    """Write the licence (ops/licensed_copy.py on the server). A licensee is needed."""
    d = {k: d.get(k) for k in FIELDS if d.get(k) not in (None, "")}
    if not d.get("licensee"):
        raise ValueError("A licence needs a licensee.")
    for k in ("issued", "ends"):
        if d.get(k) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d[k]):
            raise ValueError(f"{k} isn't a date (YYYY-MM-DD).")
    if d.get("website") and not re.fullmatch(r"https://[a-z0-9.-]+(/\S*)?", d["website"]):
        raise ValueError("website isn't an https address.")
    os.makedirs(data_dir, exist_ok=True)
    tmp = path(data_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=1)
    os.replace(tmp, path(data_dir))
    return load(data_dir)


def public(data_dir):
    """What the page shows: the licence as it is (it names a business and its contact, no secret)."""
    return load(data_dir)
