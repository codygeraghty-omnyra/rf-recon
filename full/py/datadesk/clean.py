"""Clean and scrub (Data desk step 5): every route's rows go through one pipeline.

  validate    required fields, coordinates on Earth (and in the US when the profile says so), frequencies in a radio range
  normalise   call signs upper case without spaces, names with single spaces, kHz and GHz to MHz
  dedupe      the source's own id; points of one kind within ~100 m of each other
  scrub       personal fields dropped before anything is stored (the profile's list plus the source's own)
  provenance  each kept row says where it came from: source, licence, link, when fetched
  quarantine  a row that fails is kept aside with why ("Needs a look"), never dropped without a word

scrub_text() takes anything that looks like a key, token or password out of text bound for a log or an error message.

Standard library only; nothing here imports DAStastic.
"""
import math
import re

PROFILES = {
    "default": {"required": [], "point": False, "us": False, "freq": None, "id": None, "near_m": 0, "personal": []},
    "points": {"required": ["lat", "lon"], "point": True, "us": False, "freq": None, "id": "id", "near_m": 100, "personal": []},
    "us_points": {"required": ["lat", "lon"], "point": True, "us": True, "freq": None, "id": "id", "near_m": 100, "personal": []},
    # a registry's own records (signal booster registrations): each needs its id, and two at one spot are two (one per floor)
    "registrations": {"required": ["id", "lat", "lon"], "point": True, "us": True, "freq": None, "id": "id", "near_m": 0, "personal": []},
    "frequencies": {"required": ["freq_mhz"], "point": False, "us": False, "freq": "freq_mhz", "id": "id", "near_m": 0, "personal": []},
    "permit": {"required": [], "point": False, "us": True, "freq": None, "id": "permit_id", "near_m": 0,
               "personal": ["owner", "owner_name", "applicant", "applicant_name", "contractor_phone", "phone", "email", "contact"]},
}
US_BOX = (17.5, -180.0, 72.0, -64.0)  # the states and territories, roughly: a coordinate outside is a swapped or broken one
FREQ_RANGE = (0.003, 300000.0)  # 3 kHz to 300 GHz, in MHz


def _num(v):
    try:
        f = float(str(v).strip())
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def mhz(v, unit=None):
    """A frequency in MHz from a number with or without a unit ("851.0125", "460 kHz", "2.4 GHz")."""
    s = str(v or "").strip().lower().replace(",", "")
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)\s*(hz|khz|mhz|ghz)?", s)
    if not m:
        return None
    f, u = float(m.group(1)), (m.group(2) or (unit or "mhz").lower())
    return {"hz": f / 1e6, "khz": f / 1e3, "mhz": f, "ghz": f * 1e3}[u]


def callsign(v):
    s = re.sub(r"[^A-Za-z0-9]", "", str(v or "")).upper()
    return s or None


def name(v):
    s = re.sub(r"\s+", " ", str(v or "")).strip()
    return s or None


def metres(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def run(rows, profile, source, fetched_at, kind_field="kind"):
    """{"kept": [...], "quarantined": [{"row", "why"}], "dupes": n, "scrubbed": [fields dropped]}.
    profile: a name in PROFILES or a dict like one. source: a registry entry (id, name, terms, url, personal_fields)."""
    p = dict(PROFILES["default"], **(PROFILES[profile] if isinstance(profile, str) else profile))
    personal = {f.lower() for f in p["personal"] + list(source.get("personal_fields") or [])}
    kept, quarantined, scrubbed, dupes = [], [], set(), 0
    seen_ids, cells = set(), {}
    for raw in rows:
        r = {k: v for k, v in dict(raw).items()}
        for k in list(r):
            if k.lower() in personal:
                r.pop(k)
                scrubbed.add(k)
        why = []
        for f in p["required"]:
            if r.get(f) in (None, ""):
                why.append(f"no {f}")
        if p["point"] and not why:
            lat, lon = _num(r.get("lat")), _num(r.get("lon"))
            if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                why.append("coordinates aren't on Earth")
            elif p["us"] and not (US_BOX[0] <= lat <= US_BOX[2] and US_BOX[1] <= lon <= US_BOX[3]):
                why.append("coordinates outside the US (swapped latitude and longitude?)")
            else:
                r["lat"], r["lon"] = round(lat, 6), round(lon, 6)
        if p["freq"] and not why:
            f = mhz(r.get(p["freq"]), r.get("unit"))
            if f is None or not (FREQ_RANGE[0] <= f <= FREQ_RANGE[1]):
                why.append(f"frequency {r.get(p['freq'])!r} isn't a radio frequency")
            else:
                r[p["freq"]] = round(f, 6)
                r.pop("unit", None)
        for k in ("call_sign", "callsign"):
            if k in r:
                r[k] = callsign(r[k])
        for k in ("name", "licensee", "title"):
            if k in r and isinstance(r[k], str):
                r[k] = name(r[k])
        if why:
            quarantined.append({"row": r, "why": "; ".join(why)})
            continue
        rid = r.get(p["id"]) if p["id"] else None
        if rid not in (None, ""):
            if rid in seen_ids:
                dupes += 1
                continue
            seen_ids.add(rid)
        elif p["near_m"] and p["point"]:
            key = (r.get(kind_field), round(r["lat"], 2), round(r["lon"], 2))  # ~1 km cells: compare within and beside
            near = [c for dk in (-1, 0, 1) for dl in (-1, 0, 1)
                    for c in cells.get((key[0], round(key[1] + dk * 0.01, 2), round(key[2] + dl * 0.01, 2)), [])]
            if any(metres((r["lat"], r["lon"]), c) <= p["near_m"] for c in near):
                dupes += 1
                continue
            cells.setdefault(key, []).append((r["lat"], r["lon"]))
        r["_source"] = {"id": source["id"], "name": source.get("name") or source["id"], "licence": source.get("terms") or "",
                        "url": source.get("url") or "", "fetched": fetched_at}
        kept.append(r)
    return {"kept": kept, "quarantined": quarantined, "dupes": dupes, "scrubbed": sorted(scrubbed)}


_SECRET = [
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), "[aws key id]"),
    (re.compile(r"(?i)(api[_-]?key|token|secret|password|passwd|pwd|auth|signature|sig|key)=([^&\s\"']{6,})"), r"\1=[hidden]"),
    (re.compile(r"(?i)(authorization:\s*)(\S+\s+)?\S{8,}"), r"\1[hidden]"),
    (re.compile(r"(?i)\b(bearer|basic|sso-key)\s+[A-Za-z0-9._~+/:=-]{8,}"), r"\1 [hidden]"),
    (re.compile(r"\b[A-Za-z0-9+/]{40}\b"), "[hidden 40]"),
    (re.compile(r"\b[0-9a-f]{32,}\b", re.I), "[hidden hex]"),
]


def scrub_text(s):
    """Text for a log or an error, with anything key-, token- or password-shaped taken out."""
    s = str(s or "")
    for rx, rep in _SECRET:
        s = rx.sub(rep, s)
    return s
