"""
Online prices for DAS parts (Cody 11/3: "pull updates from multiple sources ... pricing, shipping, lead times
automatically"): what a distributor's own API says today about a part number: the unit price at the quantity needed
(from its price breaks), stock on hand, the lead time when there isn't enough, and the product page. Shipping isn't in
these APIs: it stays with each supplier's quote.

Sources, each with its own free key (Data & updates > Your API keys):
  Mouser    Search API, part number search (https://www.mouser.com/api-hub/)
  Digi-Key  Product Information API v4, client credentials (https://developer.digikey.com/)
  Newark    element14 Product Search API, manuPartNum search, store www.newark.com (https://partner.element14.com/)
  Arrow     Pricing & Availability (itemservice v4 search/token), login + key (https://developers.arrow.com/)
Their answers are shown live and never kept as price history: their terms bar a database (Digi-Key, Mouser, element14)
and caching past 48 hours (Arrow, element14), so an online quote lasts a day (das.drop_old_online; Cody 11/8: "do
whatever is legal"). Each answer is labelled with its source, never mixed with another's.
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


def element14(key, part, qty=1, store="www.newark.com"):
    """element14's manufacturer part number search (Newark in the US; Farnell is store uk.farnell.com): the same shape as
    mouser()."""
    q = urllib.parse.urlencode({"term": f"manuPartNum:{part}", "storeInfo.id": store, "resultsSettings.offset": 0,
                                "resultsSettings.numberOfResults": 10, "resultsSettings.responseGroup": "medium",
                                "callInfo.responseDataFormat": "JSON", "callInfo.apiKey": key})
    req = urllib.request.Request(f"https://api.element14.com/catalog/products?{q}", headers={"Accept": "application/json", "User-Agent": UA})
    return parse_element14(_json(req), part, qty, store)


def parse_element14(d, part, qty=1, store="www.newark.com"):
    wrap = next((v for k, v in (d or {}).items() if k.endswith("SearchReturn") and isinstance(v, dict)), {})
    out = []
    for p in wrap.get("products") or []:
        breaks = [(_num(b.get("from")), _num(b.get("cost"))) for b in p.get("prices") or []]
        st = p.get("stock") or {}
        lead = _num(st.get("leastLeadTime"))
        sku = p.get("sku") or ""
        out.append({"source": "Newark" if "newark" in store else "Farnell", "part": p.get("translatedManufacturerPartNumber") or part,
                    "maker": p.get("brandName") or p.get("vendorName") or "", "unit_price": price_for(breaks, qty),
                    "stock": _num(st.get("level")) or _num(p.get("inv")) or 0, "lead_days": lead, "moq": None,
                    "url": f"https://{store}/search?st={urllib.parse.quote(sku)}" if sku else "", "breaks": breaks})
    return out


def arrow(login, key, part, qty=1):
    """Arrow's Pricing & Availability search by part number (itemservice v4): the same shape as mouser(), one offer per
    Arrow source that prices the part."""
    q = urllib.parse.urlencode({"login": login, "apikey": key, "search_token": part, "rows": 10})
    req = urllib.request.Request(f"https://api.arrow.com/itemservice/v4/en/search/token?{q}", headers={"Accept": "application/json", "User-Agent": UA})
    return parse_arrow(_json(req), part, qty)


def _res(rs, *kinds):
    return next((r.get("uri") for k in kinds for r in rs or [] if r.get("type") == k and r.get("uri")), "")


def parse_arrow(d, part, qty=1):
    out = []
    for blk in ((d or {}).get("itemserviceresult") or {}).get("data") or []:
        for p in blk.get("PartList") or []:
            purl = _res(p.get("resources"), "cloud_part_detail", "part_detail")
            for site in ((p.get("InvOrg") or {}).get("webSites") or []):
                for src in site.get("sources") or []:
                    if (src.get("currency") or "USD") != "USD":
                        continue
                    for sp in src.get("sourceParts") or []:
                        breaks = [(_num(b.get("minQty")), _num(b.get("price"))) for b in ((sp.get("Prices") or {}).get("resaleList") or [])]
                        if not breaks:
                            continue
                        weeks = _num(sp.get("arrowLeadTime")) or _num(sp.get("mfrLeadTime"))
                        out.append({"source": "Arrow", "part": p.get("partNum") or part, "maker": (p.get("manufacturer") or {}).get("mfrName", ""),
                                    "unit_price": price_for(breaks, qty), "stock": sum(_num(a.get("fohQty")) or 0 for a in sp.get("Availability") or []),
                                    "lead_days": weeks * 7 if weeks else None, "moq": _num(sp.get("minimumOrderQuantity")),
                                    "url": _res(sp.get("resources"), "detail") or purl, "breaks": breaks})
    return out


def sources(creds):
    """The online sources this copy has keys for: [(name, lookup(part, qty))]."""
    out = []
    if creds.get("mouser_key"):
        out.append(("Mouser", lambda part, qty: mouser(creds["mouser_key"], part, qty)))
    if creds.get("digikey_id") and creds.get("digikey_secret"):
        out.append(("Digi-Key", lambda part, qty: digikey(creds["digikey_id"], creds["digikey_secret"], part, qty)))
    if creds.get("element14_key"):
        out.append(("Newark", lambda part, qty: element14(creds["element14_key"], part, qty)))
    if creds.get("arrow_login") and creds.get("arrow_key"):
        out.append(("Arrow", lambda part, qty: arrow(creds["arrow_login"], creds["arrow_key"], part, qty)))
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
