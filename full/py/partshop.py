"""Where to shop for a DAS part (Cody 11/8: "just ranking sites over all having the customers pick your high ranked
ones"; "just say whose website you should look at").

reference/das_suppliers.json ranks every DAS supplier the data scout found by one overall score from public facts about
each (tools/das_suppliers.py, reasons kept with the score). A copy's people tick the suppliers they buy from (the setting
das.shop.picked); for a BOM line, Where to look lists the picked suppliers that carry that kind of part, best first, then
the best of the rest, each with a link that opens a search of that supplier's own site for the part. DAStastic copies no
price or page from any supplier for this: a person sees the prices on the supplier's own site.

Standard library only.
"""
import json
import os
import re
from urllib.parse import quote_plus

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "reference", "das_suppliers.json")
PICKED = "das.shop.picked"
_doc = {}

# A BOM line's words -> the kind of part (tools/das_suppliers.py KIND_OF groups the suppliers the same way). First match wins.
LINE_KINDS = [
    ("bda", r"\b(bda|bi-?directional|repeater|class [ab]|part 90|erces|public safety (booster|amplifier))\b"),
    ("cellbooster", r"\b(booster|cel-?fi|cellular amplifier|signal amplifier)\b"),  # a consumer (Part 20) cell booster
    ("bda", r"\b(amplifier|signal source)\b"),
    ("das", r"\b(head-?end|remote unit|das (master|remote)|fiber das|master unit|dmu|dru)\b"),
    ("passive", r"\b(splitters?|couplers?|taps?|tappers?|hybrids?|combiners?|diplexers?|duplexers?|filters?|attenuators?|loads?|"
                r"terminations?|dividers?|circulators?|isolators?)\b"),
    ("power", r"\b(battery|batteries|ups|bbu|power supply|rectifier|charger)\b"),
    ("alarm", r"\b(annunciator|alarm|fire panel|supervision|dry contact)\b"),
    ("surge", r"\b(surge|lightning|arrest[oe]r|grounding|polyphaser)\b"),
    ("enclosure", r"\b(enclosure|nema|cabinet|rack|box)\b"),
    ("antenna", r"\b(antenna|omni|yagi|dome|directional|donor)\b"),
    ("mounting", r"\b(bracket|clamp|hanger|strut|pipe mount|mounting kit)\b"),
    ("fiber", r"\b(fiber|fibre|singlemode|single-mode|multimode|lc/apc|sc/apc|patch cord)\b"),
    ("test", r"\b(analy[sz]er|scanner|pim tester|power meter|site master|test)\b"),
    ("connector", r"\b(connector|adapter|n-?type|n male|n female|4\.3-?10|din|sma|jumper)\b"),
    ("coax", r"\b(coax|cable|plenum|riser|heliax|lmr|1/2|7/8|feeder)\b"),
]
CAT_KINDS = {"cable": "coax", "connector": "connector", "antenna": "antenna", "donor antenna": "antenna", "tool": "test"}
PS_LINE = re.compile(r"(?i)\b(public safety|ps|erces|ul ?2524|part 90|700/800|800/900|class [ab]|annunciator|2-hour|fire)\b")


def load():
    """The ranked list (read once; again when the file changes)."""
    try:
        st = os.stat(PATH).st_mtime_ns
    except OSError:
        return {"suppliers": [], "kinds": []}
    if _doc.get("at") != st:
        with open(PATH, encoding="utf-8") as fh:
            _doc.update(at=st, doc=json.load(fh))
    return _doc["doc"]


def kind_of(line):
    """The kind of part a BOM line is: its words first (a "Component" says nothing), then its category."""
    words = " ".join(str(line.get(k) or "") for k in ("item", "part", "note")).lower()
    for k, rx in LINE_KINDS:
        if re.search(rx, words):
            return k
    return CAT_KINDS.get(str(line.get("cat") or "").strip().lower(), "")


def search_url(s, line):
    """A search of the supplier's own site for the part, in the person's own browser: the part number when there is one,
    else the item's words."""
    what = (line.get("part") or "").strip()
    q = f'"{what}"' if what else " ".join(str(line.get("item") or "").split()[:8])
    if (line.get("maker") or "").strip() and what:
        q += f" {line['maker'].strip()}"
    return f"https://www.google.com/search?q={quote_plus(('site:' + s['host'] + ' ' if s.get('host') else '') + q)}"


def ranked(picked=(), kind="", q=""):
    """Every supplier, best score first, with whether this copy picked it; narrowed to a kind and a search."""
    picked, ql = set(picked or ()), (q or "").strip().lower()
    out = []
    for s in load()["suppliers"]:
        if kind and kind not in s["kinds"]:
            continue
        if ql and ql not in " ".join([s["name"], s["brands"], " ".join(s["categories"]), s["country"]]).lower():
            continue
        out.append(dict(s, picked=s["id"] in picked))
    return out


def where_to_look(line, picked=(), n=8, seen=None):
    """For one BOM line: the picked suppliers that carry its kind, best first, then the best of the rest up to n, each
    with its site search, and what this copy last read on that supplier's own site for the part (seen: partcrawl.seen_for).
    {kind, sites}."""
    seen = seen or {}
    k = kind_of(line)
    picked = set(picked or ())
    pool = [s for s in load()["suppliers"] if not k or k in s["kinds"]]
    if PS_LINE.search(" ".join(str(line.get(x) or "") for x in ("cat", "item", "part", "note"))):
        pool.sort(key=lambda s: (not s.get("ps"), s["rank"]))  # a public safety line: suppliers with public safety lines first
    mine = [s for s in pool if s["id"] in picked]
    rest = [s for s in pool if s["id"] not in picked]
    sites = []
    for s in (mine + rest)[: max(n, len(mine))]:
        sites.append({"id": s["id"], "name": s["name"], "rank": s["rank"], "score": s["score"], "kind": s["kind"], "country": s["country"],
                      "prices": s["prices"], "public_safety": bool(s.get("ps")), "flag": s.get("flag", ""), "site": s["site"], "picked": s["id"] in picked,
                      "seen": seen.get(s["id"]),
                      "search": search_url(s, line)})
    return {"kind": k, "sites": sites}


def pick(get_setting, set_setting, sid, on, con=None):
    """Tick or untick a supplier for this copy. A ticked one also becomes a supplier in the DAS list (name and website, for
    requests for quote), added only when it isn't there; unticking removes nothing from that list."""
    s = next((x for x in load()["suppliers"] if x["id"] == sid), None)
    if not s:
        raise ValueError("No such supplier.")
    cur = [x for x in (get_setting(PICKED, []) or []) if x != sid]
    if on:
        cur.append(sid)
        if con is not None:
            con.execute("INSERT OR IGNORE INTO das_supplier(name, website) VALUES(?,?)", (s["name"], s["site"]))
            con.commit()
    set_setting(PICKED, cur)
    return cur
