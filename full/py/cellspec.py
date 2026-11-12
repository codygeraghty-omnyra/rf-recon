"""
Channel numbers for a licensed block, by technology: what a site of a given kind could be radiating, worked out from
the MHz a carrier holds in the county (spectrum.py) and the 3GPP / TIA channel plans. Licensed, never measured: a
licence says what a carrier may transmit here, not which of these this site has on the air. Only a scan says that.

  LTE   EARFCN       3GPP TS 36.101 table 5.7.3-1: N = N_offs + 10 (F - F_low), 100 kHz raster
  NR    NR-ARFCN     3GPP TS 38.104 table 5.4.2.1-1: global raster, 5 kHz below 3 GHz, 15 kHz to 24.25 GHz, 60 kHz above
  UMTS  UARFCN       3GPP TS 25.101 table 5.1/5.2: N = 5 (F - F_offset), 200 kHz raster, a 5 MHz carrier
  GSM   ARFCN        3GPP TS 45.005 2: GSM 850 128-251, PCS 1900 512-810, 200 kHz
  CDMA  channel      TIA-97 band classes 0 (800) and 1 (PCS)

Every range here is the channel numbers that fall inside the block's edges.

The other way, a channel heard to its band (band_of, 11/10): DAStastic's one converter. The tower report, the cell
sites, the capture readers (sigid's earfcn_to_dl_mhz and nrarfcn_to_mhz are thin wrappers over it) and the survey use
it; static/sigmeta.js mirrors it as sigMetaParts.bandOf, and tests/test_bandof.py checks the two give the same answers
and that DAStastic for Android's own table (RadioBridge.lteBand) agrees for the bands it lists. Standard library only.
"""
import math
import re

# band, DL MHz, N_offs DL, UL MHz, N_offs UL (UL None: downlink only; TDD: UL is the DL span)
LTE = [
    ("B2", (1930, 1990), 600, (1850, 1910), 18600),
    ("B4", (2110, 2155), 1950, (1710, 1755), 19950),
    ("B5", (869, 894), 2400, (824, 849), 20400),
    ("B12", (729, 746), 5010, (699, 716), 23010),
    ("B13", (746, 756), 5180, (777, 787), 23180),
    ("B14", (758, 768), 5280, (788, 798), 23280),
    ("B17", (734, 746), 5730, (704, 716), 23730),
    ("B25", (1930, 1995), 8040, (1850, 1915), 26040),
    ("B26", (859, 894), 8690, (814, 849), 26690),
    ("B29", (717, 728), 9660, None, None),
    ("B30", (2350, 2360), 9770, (2305, 2315), 27660),
    ("B41", (2496, 2690), 39650, "TDD", None),
    ("B48", (3550, 3700), 55240, "TDD", None),
    ("B66", (2110, 2200), 66436, (1710, 1780), 131972),
    ("B70", (1995, 2020), 68336, (1695, 1710), 132972),
    ("B71", (617, 652), 68586, (663, 698), 133122),
    ("B85", (728, 746), 70366, (698, 716), 134002),
]
# band, DL MHz, UL MHz (TDD: same span)
NR = [
    ("n2", (1930, 1990), (1850, 1910)), ("n5", (869, 894), (824, 849)), ("n12", (729, 746), (699, 716)),
    ("n14", (758, 768), (788, 798)), ("n25", (1930, 1995), (1850, 1915)), ("n26", (859, 894), (814, 849)),
    ("n29", (717, 728), None), ("n30", (2350, 2360), (2305, 2315)), ("n41", (2496, 2690), "TDD"),
    ("n48", (3550, 3700), "TDD"), ("n66", (2110, 2200), (1710, 1780)), ("n70", (1995, 2020), (1695, 1710)),
    ("n71", (617, 652), (663, 698)), ("n77", (3300, 4200), "TDD"), ("n258", (24250, 27500), "TDD"),
    ("n260", (37000, 40000), "TDD"), ("n261", (27500, 28350), "TDD"),
]
# band, DL MHz, DL offset, UL MHz, UL offset
UMTS = [("Band II", (1930, 1990), 0, (1850, 1910), 0), ("Band IV", (2110, 2155), 1805, (1710, 1755), 1450),
        ("Band V", (869, 894), 0, (824, 849), 0)]
# LTE bands a phone or scanner can report that no US licence block names, for band_of only (LTE above stays the US
# licensing table): B46 is LAA, carriers' LTE in the unlicensed 5 GHz band; the rest are heard abroad, and DAStastic for
# Android's table lists them. Same columns as LTE (3GPP TS 36.101 table 5.7.3-1)
LTE_HEARD = [
    ("B1", (2110, 2170), 0, (1920, 1980), 18000),
    ("B3", (1805, 1880), 1200, (1710, 1785), 19200),
    ("B7", (2620, 2690), 2750, (2500, 2570), 20750),
    ("B8", (925, 960), 3450, (880, 915), 21450),
    ("B20", (791, 821), 6150, (832, 862), 24150),
    ("B38", (2570, 2620), 37750, "TDD", None),
    ("B46", (5150, 5925), 46790, "TDD", None),
]
# where NR bands overlap (one NR-ARFCN raster for every band), the one a US network uses first; the others are named in
# "also". 3550-3700 MHz is CBRS (n48) or n77, which spans it: settled later by the carrier's licensed blocks (plan 11/10)
NR_FIRST = ("n71", "n29", "n12", "n14", "n5", "n2", "n25", "n66", "n70", "n30", "n41", "n48", "n77", "n258", "n261", "n260", "n26")
NR_CARRIER_FIRST = {"T-Mobile": ("n25",)}  # T-Mobile's PCS is n25 (it holds the G block); AT&T's and Verizon's is n2


def _overlap(a, b):
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return (lo, hi) if hi > lo else None


def earfcn(n_offs, f_low, f):
    return n_offs + round(10 * (f - f_low))


def nr_arfcn(f):
    if f < 3000:
        return round(f / 0.005)
    if f < 24250:
        return 600000 + round((f - 3000) / 0.015)
    return 2016667 + round((f - 24250) / 0.06)


def _span(dl, ul, tdd=False):
    return {"dl_mhz": list(dl), "ul_mhz": list(dl) if tdd else list(ul) if ul else None}


def lte(dl, ul):
    """Every LTE band this block sits in, with its EARFCN range each way."""
    out = []
    for band, bdl, nd, bul, nu in LTE:
        o = _overlap(dl, bdl)
        if not o:
            continue
        r = {"band": band, "kind": "EARFCN", **_span(o, None, bul == "TDD"), "dl": [earfcn(nd, bdl[0], o[0]), earfcn(nd, bdl[0], o[1]) - 1]}
        if bul == "TDD":
            r.update(ul=r["dl"], tdd=True)
        elif bul and ul:
            u = _overlap(ul, bul)
            if u:
                r.update(ul_mhz=list(u), ul=[earfcn(nu, bul[0], u[0]), earfcn(nu, bul[0], u[1]) - 1])
        elif bul is None:
            r["sdl"] = True  # downlink only
        out.append(r)
    return out


def nr(dl, ul):
    out = []
    for band, bdl, bul in NR:
        o = _overlap(dl, bdl)
        if not o:
            continue
        r = {"band": band, "kind": "NR-ARFCN", **_span(o, None, bul == "TDD"), "dl": [nr_arfcn(o[0]), nr_arfcn(o[1])]}
        if bul == "TDD":
            r.update(ul=r["dl"], tdd=True)
        elif bul and ul:
            u = _overlap(ul, bul)
            if u:
                r.update(ul_mhz=list(u), ul=[nr_arfcn(u[0]), nr_arfcn(u[1])])
        elif bul is None:
            r["sdl"] = True
        out.append(r)
    return out


def umts(dl, ul):
    """A 5 MHz carrier: its centre sits at least 2.4 MHz inside each edge (25.101's ranges), so a block under 5 MHz holds none."""
    out = []
    for band, bdl, od, bul, ou in UMTS:
        o = _overlap(dl, bdl)
        if not o or o[1] - o[0] < 5:
            continue
        r = {"band": band, "kind": "UARFCN", **_span(o, None), "dl": [math.ceil(round(5 * (o[0] + 2.4 - od), 6)), math.floor(round(5 * (o[1] - 2.4 - od), 6))]}
        u = _overlap(ul, bul) if ul else None
        if u and u[1] - u[0] >= 5:
            r.update(ul_mhz=list(u), ul=[math.ceil(round(5 * (u[0] + 2.4 - ou), 6)), math.floor(round(5 * (u[1] - 2.4 - ou), 6))])
        out.append(r)
    return out


def gsm(dl, ul):
    out = []
    for band, bdl, first, last, dl0, gap in (("GSM 850", (869, 894), 128, 251, 869.2, 45), ("PCS 1900", (1930, 1990), 512, 810, 1930.2, 80)):
        o = _overlap(dl, bdl)
        if not o:
            continue
        a = max(first, first + int(-(-(o[0] + 0.1 - dl0) // 0.2)))  # a 200 kHz carrier, centre 100 kHz inside the edge
        b = min(last, first + int((o[1] - 0.1 - dl0) // 0.2))
        if b < a:
            continue
        out.append({"band": band, "kind": "ARFCN", "dl_mhz": list(o), "ul_mhz": [round(o[0] - gap, 3), round(o[1] - gap, 3)], "dl": [a, b], "ul": [a, b],
                    "same": True})  # GSM numbers a duplex pair once
    return out


def cdma(dl, ul):
    out = []
    for band, bdl, f0, step, last in (("BC0 (800)", (869, 894), 870.0, 0.03, 799), ("BC1 (PCS)", (1930, 1990), 1930.0, 0.05, 1199)):
        o = _overlap(dl, bdl)
        if not o:
            continue
        a, b = max(0 if f0 > 1000 else 1, int(-(-(o[0] - f0) // step))), min(last, int((o[1] - f0) // step))
        if b < a:
            continue
        out.append({"band": band, "kind": "CDMA channel", "dl_mhz": list(o), "ul_mhz": [round(o[0] - (bdl[0] - (824 if f0 < 1000 else 1850)), 3), round(o[1] - (bdl[0] - (824 if f0 < 1000 else 1850)), 3)],
                    "dl": [a, b], "ul": [a, b], "same": True})
    return out


BY_RADIO = {"LTE": lte, "NR": nr, "UMTS": umts, "WCDMA": umts, "GSM": gsm, "CDMA": cdma}


# ---------------------------------------------------------------- a channel heard -> its band (the one converter, 11/10)
# Integer arithmetic, then one division: Python and JavaScript then give the very same MHz (tests/test_bandof.py)

_CHAN = re.compile(r"[ \t]*([0-9]+)(\.0*)?[ \t]*")  # a whole channel number, as text or a number ("650", 650, 650.0)


def _int(chan):
    m = None if chan is None or isinstance(chan, bool) else _CHAN.fullmatch(str(chan))
    return int(m.group(1)) if m else None


def earfcn_dl_mhz(n):
    """An LTE downlink EARFCN -> (band, downlink MHz), or None outside every band DAStastic knows. 0 is None too: WiGLE's app
    writes 0 for an EARFCN the phone didn't report, and 36.101 never puts a carrier there (a band's first 7 channel numbers
    are unused), so it read as a false B1 at 2110 MHz (review 11/10)."""
    n = _int(n)
    if n is None or n == 0:
        return None
    for band, dl, n_offs, _ul, _nu in LTE + LTE_HEARD:
        if n_offs <= n < n_offs + 10 * (dl[1] - dl[0]):
            return band, (dl[0] * 10 + n - n_offs) / 10
    return None


def nrarfcn_mhz(n):
    """An NR-ARFCN -> MHz on the global raster (3GPP TS 38.104 table 5.4.2.1-1), any band. None outside the raster."""
    n = _int(n)
    if n is None:
        return None
    if n < 600000:
        return n * 5 / 1000
    if n < 2016667:
        return (3000000 + 15 * (n - 600000)) / 1000
    if n <= 3279165:
        return (24250080 + 60 * (n - 2016667)) / 1000
    return None


def band_of(tech, chan, carrier=None):
    """The band a heard channel is in: tech "LTE" with a downlink EARFCN, or "NR" with an NR-ARFCN. Returns
    {"tech", "band", "num", "chan", "kind", "dl_mhz", "also", "note"} or None when it's in no band DAStastic knows.
    LTE channel numbers belong to one band each; NR's raster is shared, so an overlap names the band a US network uses
    first and lists the others in "also" (carrier settles n2 / n25; n48 / n77 waits for the licensed blocks)."""
    t = str(tech or "").upper()
    t = "NR" if "NR" in t or "5G" in t else "LTE" if "LTE" in t or "4G" in t else t
    n = _int(chan)
    if n is None:
        return None
    if t == "LTE":
        hit = earfcn_dl_mhz(n)
        if not hit:
            return None
        band, mhz = hit
        heard = band in {b[0] for b in LTE_HEARD}
        return {"tech": "LTE", "band": band, "num": int(band[1:]), "chan": n, "kind": "EARFCN", "dl_mhz": mhz, "also": [],
                "note": "LAA: LTE in the unlicensed 5 GHz band" if band == "B46" else "not a US band" if heard else ""}
    if t == "NR":
        mhz = nrarfcn_mhz(n)
        if mhz is None:
            return None
        hits = [b for b, dl, _ul in NR if dl[0] <= mhz < dl[1]]
        if not hits:
            return None
        first = NR_CARRIER_FIRST.get(brand_of_operator(carrier), ()) + NR_FIRST
        hits.sort(key=lambda b: first.index(b) if b in first else len(first))
        band = hits[0]
        note = ("CBRS (n48), or n77 where a phone reports it so: the carrier's licensed blocks settle it" if band == "n48" and "n77" in hits
                else "PCS: n2 (AT&T, Verizon) or n25 (T-Mobile)" if {"n2", "n25"} <= set(hits) else "")
        return {"tech": "NR", "band": band, "num": int(band[1:]), "chan": n, "kind": "NR-ARFCN", "dl_mhz": mhz, "also": hits[1:], "note": note}
    return None


def earfcn_band(n):
    """An LTE downlink EARFCN -> its band name ("B66"), or None."""
    b = band_of("LTE", n)
    return b["band"] if b else None


def nrarfcn_band(n, carrier=None):
    """An NR-ARFCN -> its band name ("n77"), or None."""
    b = band_of("NR", n, carrier)
    return b["band"] if b else None


def channels(radio, dl, ul):
    """dl, ul: one (lo, hi) MHz span each, or None. A list of {band, kind, dl_mhz, ul_mhz, dl: [first, last], ul}."""
    f = BY_RADIO.get((radio or "").upper())
    if not f or not dl:
        return []
    return f(tuple(dl), tuple(ul) if ul else None)


def brand_of_operator(op):
    """cells.py's operator names to spectrum.py's brands: Sprint's licences are T-Mobile's now."""
    op = (op or "").replace(" (ex-Sprint)", "")
    return {"AT&T": "AT&T", "FirstNet (AT&T)": "AT&T", "T-Mobile": "T-Mobile", "Verizon": "Verizon", "Dish / Boost": "DISH"}.get(op, op)


def licensed_for(spec, operator, radio):
    """Each block this site's carrier holds in the county, with the channel numbers a site of this kind could use in it."""
    want = brand_of_operator(operator)
    out = []
    for c in (spec or {}).get("carriers") or []:
        if c.get("brand") != want:
            continue
        for b in c.get("bands") or []:
            for blk in b.get("blocks") or []:
                for i, dl in enumerate(blk.get("dl") or []):
                    ul = (blk.get("ul") or [None] * (i + 1))[i] if i < len(blk.get("ul") or []) else None
                    ch = channels(radio, dl, ul)
                    if ch:
                        out.append({"band": b.get("band"), "rf": b.get("rf"), "block": blk.get("block"), "calls": blk.get("calls") or [],
                                    "dl_mhz": dl, "ul_mhz": ul, "tdd": bool(b.get("tdd")), "channels": ch})
    return out
