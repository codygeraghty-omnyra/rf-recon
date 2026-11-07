"""
Shipping estimates for DAS supplier quotes (Cody 11/4: "freight quotes are still typed in from each supplier's
answer"). From each supplier's ship-from address to the request's ship-to, for the parts' weights, through Shippo's
rate API (one key covers UPS, FedEx, USPS and the carriers on the account; rating creates no label and costs
nothing; a test key's calls are free: docs.goshippo.com). The cheapest and the fastest rate are kept on the quote as
an estimate, marked as one, and never over a shipping price the supplier gave.

Parcels: the parts' weights (das_part.weight_lb; a part with none is named, not guessed) packed into boxes of up to
50 lb (18 x 12 x 12 in). Over 150 lb in all is freight (LTL), which parcel rates don't cover: said so, not priced.
"""
import json
import math
import re
import urllib.request

API = "https://api.goshippo.com/shipments/"
BOX = {"length": "18", "width": "12", "height": "12", "distance_unit": "in"}
BOX_MAX_LB = 50.0
PARCEL_MAX_LB = 150.0
STATES = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
             "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU".split())


def parse_address(text):
    """'1 Main St, Arlington, VA 22201' (or with line breaks) -> Shippo's fields. Needs at least a ZIP."""
    t = re.sub(r"\s+", " ", (text or "").replace("\n", ", ")).strip(" ,")
    m = re.search(r"(?:,\s*|\s)([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA?|United States))?$", t)
    if not m or m.group(1).upper() not in STATES:
        z = re.search(r"\b(\d{5})(?:-\d{4})?\b", t)
        if not z:
            raise ValueError(f"No ZIP code in the address: {text!r}")
        return {"zip": z.group(1), "country": "US", "street1": "", "city": "", "state": ""}
    head = [x.strip() for x in t[:m.start()].split(",") if x.strip()]
    return {"street1": ", ".join(head[:-1]) if len(head) > 1 else (head[0] if head and re.match(r"\d", head[0]) else ""),
            "city": head[-1] if head and not (len(head) == 1 and re.match(r"\d", head[0])) else "",
            "state": m.group(1).upper(), "zip": m.group(2), "country": "US"}


def parcels(lines, weight_of):
    """(parcels, total_lb, missing): lines are the request's lines (key, qty, part, item); weight_of(key) -> lb or None."""
    total, missing = 0.0, []
    for ln in lines:
        w = weight_of(ln["key"])
        if w is None:
            missing.append(ln.get("part") or ln.get("item") or ln["key"])
            continue
        total += float(w) * float(ln.get("qty") or 0)
    if total <= 0:
        return [], 0.0, missing
    n = max(1, math.ceil(total / BOX_MAX_LB))
    each = round(total / n, 2)
    return [dict(BOX, weight=f"{each:g}", mass_unit="lb") for _ in range(n)], round(total, 2), missing


def _addr(a, name):
    out = {"name": name[:60] or "Shipper", "country": a.get("country") or "US", "zip": a["zip"]}
    for k in ("street1", "city", "state"):
        if a.get(k):
            out[k] = a[k]
    return out


def shippo_rates(token, frm, to, boxes, fetch=None):
    """Every rate Shippo returns for the shipment: [{provider, service, amount, currency, days, terms}], cheapest first."""
    body = json.dumps({"address_from": frm, "address_to": to, "parcels": boxes, "async": False}).encode()
    if fetch:
        data = fetch(body)
    else:
        req = urllib.request.Request(API, data=body, method="POST",
                                     headers={"Authorization": f"ShippoToken {token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read())
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"Shippo answered {e.code}: {msg}") from None
    rates = []
    for r in data.get("rates") or []:
        try:
            amt = float(r.get("amount"))
        except (TypeError, ValueError):
            continue
        sl = r.get("servicelevel") or {}
        rates.append({"provider": r.get("provider") or "", "service": sl.get("name") or sl.get("token") or "",
                      "amount": amt, "currency": r.get("currency") or "USD", "days": r.get("estimated_days"),
                      "terms": r.get("duration_terms") or ""})
    if not rates:
        notes = "; ".join(str(m.get("text") or m) for m in (data.get("messages") or [])[:3])
        raise RuntimeError("Shippo gave no rates" + (f": {notes}" if notes else " for these addresses and parcels."))
    return sorted(rates, key=lambda r: r["amount"])


def pick(rates):
    """The cheapest rate and the fastest one (by days, then price)."""
    cheap = rates[0]
    timed = [r for r in rates if r["days"] is not None]
    fast = min(timed, key=lambda r: (r["days"], r["amount"])) if timed else None
    return cheap, fast
