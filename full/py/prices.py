"""
Online prices for DAS parts (Cody 11/3: "pull updates from multiple sources ... pricing, shipping, lead times
automatically"): what a distributor's own API says today about a part number: the unit price at the quantity needed
(from its price breaks), stock on hand, the lead time when there isn't enough, and the product page. Shipping isn't in
these APIs: it stays with each supplier's quote.

Sources, each with its own free key (Data & updates > Your API keys):
  Mouser    Search API, part number search (https://www.mouser.com/api-hub/)
  Digi-Key  Product Information API v4, client credentials (https://developer.digikey.com/)
Many DAS passives (RFS, Microlab, CommScope) are sold through RF distributors without APIs: their prices come from
the suppliers' price lists (imported, or re-read from a link on a schedule: das.refresh_price_lists).
"""
import json
import re
import time
import urllib.parse
import urllib.request

UA = "RF-Recon/2.0 (DAS parts pricing)"
TIMEOUT = 30


def _num(s):
    if s is None:
        return None
    m = re.search(r"-?\d[\d,]*\.?\d*", str(s))
    return float(m.group(0).replace(",", "")) if m else None


def price_for(breaks, qty):
    """The unit price at a quantity from price breaks [(break_qty, unit_price)]: the deepest break the quantity reaches
    (the first break when it reaches none)."""
    bs = sorted((q, p) for q, p in breaks if q is not None and p is not None)
    if not bs:
        return None
    hit = [p for q, p in bs if q <= (qty or 1)]
    return hit[-1] if hit else bs[0][1]


def lead_days_text(s):
    """'35 Days', '6 Weeks', '12 wks' -> days."""
    t = str(s or "")
    n = _num(t)
    if n is None:
        return None
    return n * 7 if re.search(r"wk|week", t, re.I) else n


def _json(req):
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def mouser(key, part, qty=1):
    """Mouser's exact part-number match: [{source, part, maker, unit_price, stock, lead_days, moq, url, breaks}]."""
    body = json.dumps({"SearchByPartRequest": {"mouserPartNumber": part, "partSearchOptions": "Exact"}}).encode()
    req = urllib.request.Request(f"https://api.mouser.com/api/v1/search/partnumber?apiKey={urllib.parse.quote(key)}", data=body,
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA})
    d = _json(req)
    errs = d.get("Errors") or []
    if errs:
        raise ValueError("Mouser: " + "; ".join(str(e.get("Message") or e) for e in errs)[:200])
    return parse_mouser(d, part, qty)


def parse_mouser(d, part, qty=1):
    out = []
    for p in ((d.get("SearchResults") or {}).get("Parts") or []):
        breaks = [(_num(b.get("Quantity")), _num(b.get("Price"))) for b in p.get("PriceBreaks") or []]
        stock = _num(p.get("AvailabilityInStock")) or _num(p.get("Availability")) or 0
        out.append({"source": "Mouser", "part": p.get("ManufacturerPartNumber") or part, "maker": p.get("Manufacturer") or "",
                    "unit_price": price_for(breaks, qty), "stock": stock, "lead_days": lead_days_text(p.get("LeadTime")),
                    "moq": _num(p.get("Min")), "url": p.get("ProductDetailUrl") or "", "breaks": breaks})
    return out


_DK = {}


def _digikey_token(cid, secret):
    t = _DK.get(cid)
    if t and t[1] > time.time() + 60:
        return t[0]
    req = urllib.request.Request("https://api.digikey.com/v1/oauth2/token", data=urllib.parse.urlencode(
        {"client_id": cid, "client_secret": secret, "grant_type": "client_credentials"}).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    d = _json(req)
    _DK[cid] = (d["access_token"], time.time() + float(d.get("expires_in") or 600))
    return d["access_token"]


def digikey(cid, secret, part, qty=1):
    """Digi-Key's product details for a part number: the same shape as mouser()."""
    tok = _digikey_token(cid, secret)
    req = urllib.request.Request(f"https://api.digikey.com/products/v4/search/{urllib.parse.quote(part, safe='')}/productdetails",
                                 headers={"Authorization": f"Bearer {tok}", "X-DIGIKEY-Client-Id": cid, "X-DIGIKEY-Locale-Currency": "USD",
                                          "Accept": "application/json", "User-Agent": UA})
    return parse_digikey(_json(req), part, qty)


def parse_digikey(d, part, qty=1):
    p = d.get("Product") or {}
    if not p:
        return []
    breaks = []
    for v in p.get("ProductVariations") or []:
        breaks += [(_num(b.get("BreakQuantity")), _num(b.get("UnitPrice"))) for b in v.get("StandardPricing") or []]
    lead = _num(p.get("ManufacturerLeadWeeks"))
    return [{"source": "Digi-Key", "part": p.get("ManufacturerProductNumber") or part, "maker": (p.get("Manufacturer") or {}).get("Name", ""),
             "unit_price": price_for(breaks, qty) if breaks else _num(p.get("UnitPrice")), "stock": _num(p.get("QuantityAvailable")) or 0,
             "lead_days": lead * 7 if lead is not None else None, "moq": None, "url": p.get("ProductUrl") or "", "breaks": breaks}]


def sources(creds):
    """The online sources this copy has keys for: [(name, lookup(part, qty))]."""
    out = []
    if creds.get("mouser_key"):
        out.append(("Mouser", lambda part, qty: mouser(creds["mouser_key"], part, qty)))
    if creds.get("digikey_id") and creds.get("digikey_secret"):
        out.append(("Digi-Key", lambda part, qty: digikey(creds["digikey_id"], creds["digikey_secret"], part, qty)))
    return out


def offers(creds, lines, lookups=None):
    """Every source's offer for each line ({key, part, qty}): the matching part's price at that quantity, whether
    there's stock for it (ships now) or its lead time. {source: {key: offer}} and the errors met."""
    got, errors = {}, []
    for name, look in (lookups if lookups is not None else sources(creds)):
        for ln in lines:
            if not ln.get("part"):
                continue
            try:
                hits = look(ln["part"], ln.get("qty") or 1)
            except Exception as e:  # one source or one part failing never stops the rest
                errors.append(f"{name} {ln['part']}: {str(e)[:120]}")
                continue
            want = re.sub(r"[^a-z0-9]", "", ln["part"].lower())
            hit = next((h for h in hits if re.sub(r"[^a-z0-9]", "", (h["part"] or "").lower()) == want), None)
            if hit and hit["unit_price"] is not None:
                q = ln.get("qty") or 1
                hit = {**hit, "lead_days": 0 if (hit["stock"] or 0) >= q else hit["lead_days"]}
                got.setdefault(name, {})[ln["key"]] = hit
    return got, errors
