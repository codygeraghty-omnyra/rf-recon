"""
One colour scale for every signal map (11/10), the server's copy of static/rfscale.js: the same tables and the same colours,
for pictures the server draws (the outdoor heat map's PNG and KMZ when it moves onto this scale, survey exports). Red weak,
amber on the pass line, green good; pass lines from a job's cellular profile, else the Common preset (RSRP -95 dBm below
3.3 GHz, -100 dBm from 3.3 GHz, SINR 5 dB). tests/test_rfscale.py checks these tables against rfscale.js line for line and
that both give the same colours. Standard library only.
"""
import math

# where a reading sits against its pass line, in spans: -1 a full span weaker, 0 on the line, 1 a full span stronger
STOPS = ((-1, (142, 27, 27)), (-0.000001, (229, 83, 75)), (0, (250, 178, 25)), (0.3333333333333333, (166, 212, 106)), (1, (47, 163, 95)))
SMOOTH = ((-1, (229, 83, 75)), (0, (250, 178, 25)), (1, (47, 163, 95)))   # no pass line: the lowest to the highest reading
DIFF = ((-1, (207, 34, 46)), (0, (245, 245, 245)), (1, (31, 111, 235)))  # a change: worse red, the same white, better blue
METRICS = {"rsrp": {"span": 15, "unit": " dBm", "dig": 0}, "rsrq": {"span": 6, "unit": " dB", "dig": 0}, "sinr": {"span": 8, "unit": " dB", "dig": 0},
           "dl": {"span": 15, "unit": " dBm", "dig": 0}, "ul": {"span": 15, "unit": " dBm", "dig": 0}, "daq": {"span": 1.5, "unit": "", "dig": 1}}
COMMON = {"rsrp": -95, "rsrp_hi": -100, "sinr": 5}  # dascell.js CELL_PRESETS.common
BEST = ("#E69F00", "#56B4E9", "#009E73", "#0072B2", "#D55E00", "#CC79A7")  # best server, colour-blind safe on a map (rfscale.js)
OTHER = "#8c959f"
HATCH = {"angle": 45, "gap": 6, "width": 1.5, "ink": "rgba(20,20,20,0.55)"}


def _round(x):
    """JavaScript's Math.round (halves up), not Python's round (halves to even), so both sides give the same colour."""
    return int(math.floor(x + 0.5))


def ramp(t, stops=STOPS):
    """t (-1 to 1) along a table of stops -> (r, g, b), worked exactly as rfscale.js does."""
    t = max(-1, min(1, t))
    for i in range(1, len(stops)):
        if t <= stops[i][0]:
            (t0, c0), (t1, c1) = stops[i - 1], stops[i]
            k = (t - t0) / (t1 - t0) if t1 > t0 else 0
            return tuple(_round(c + (c1[j] - c) * k) for j, c in enumerate(c0))
    return tuple(stops[-1][1])


def rgb(v, sc):
    """A reading against its scale: {"thr", "span"} (a pass line) or {"thr": None, "lo", "hi"} (none: lowest to highest)."""
    if sc.get("thr") is not None:
        return ramp((v - sc["thr"]) / sc["span"], STOPS)
    lo, hi = sc["lo"], sc["hi"]
    return ramp((v - lo) / (hi - lo) * 2 - 1 if hi > lo else 0, SMOOTH)


def diff(dv, span):
    return ramp(dv / span, DIFF)


def passes(v, sc):
    return None if sc.get("thr") is None else v >= sc["thr"]


def hex_of(c):
    return "#" + "".join(f"{x:02x}" for x in c)


INK = {"fail": hex_of(STOPS[1][1]), "amber": hex_of(STOPS[2][1]), "pass": hex_of(STOPS[4][1])}


def pass_line(metric, carrier=None, layer="lo", profile=None):
    """A cellular pass line: the job's profile (dascell.js cellProfile's shape) or Common. RSRQ has none."""
    p = profile or COMMON
    if metric == "rsrp":
        if layer == "hi":
            for v in ((p.get("hi_by") or {}).get(carrier), p.get("rsrp_hi"), p.get("rsrp")):
                if v is not None:
                    return v
            return None
        return p.get("rsrp")
    if metric == "sinr":
        return p.get("sinr")
    return None


def scale(metric, thr, vals=(), what=""):
    m = METRICS.get(metric) or METRICS["rsrp"]
    if thr is None or not math.isfinite(float(thr)):
        v = [x for x in vals if x is not None and math.isfinite(x)]
        return {"thr": None, "lo": min(v) if v else 0, "hi": max(v) if v else 1, "unit": m["unit"], "what": what}
    return {"thr": float(thr), "span": m["span"], "unit": m["unit"], "what": what}


def best_colours(keys):
    """Each site its colour, the most readings first; a seventh site and on is OTHER (rfscale.js bestColours)."""
    return {k: BEST[i] if i < len(BEST) else OTHER for i, k in enumerate(keys)}
