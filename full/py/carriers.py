"""One name per carrier. The filter research of 11/5 found four rules that disagreed: provenance.carrier_key, das.carrier_name,
carrierName in dascell.js and BRANDS in spectrum.py. A customer's search missed 5 of 7 AT&T towers because "New Cingular" didn't
read as AT&T. CARRIER_RULES in static/dascell.js keeps the same list (tests/test_carriers.py checks the two agree).

A name is a filter's convenience, never a claim about the air: a tower's owner isn't who's on it, and a licence isn't proof a
block is in use. The page keeps the record's own name and says which field the carrier came from."""
import re

RULES = (("FirstNet", r"first\s*net|first responder network"),
         ("T-Mobile", r"\bt-?\s?mobile|\bsprint|nextel|clearwire|metropcs|powertel|omnipoint|voicestream"),
         ("Verizon", r"verizon|cellco|new york smsa|gte mobilnet|bell atlantic mobile|airtouch"),
         ("AT&T", r"at&t|\batt\b|cingular|bellsouth|ameritech"),
         ("UScellular", r"united states cellular|us\s?cellular"),
         ("Dish / Boost", r"\bdish\b|\bboost\b|echostar"))
# Dish's bidding shells: plain words that name a carrier only on a market licence. On a licensee in general they'd be wrong
# ("Parker Board of Education", "Northstar Towers").
SHELLS = (("Dish / Boost", r"manifest wireless|american aws-3|northstar|snr wireless|gamma acquisition|parker b"),)
_rules = [(n, re.compile(p, re.I)) for n, p in RULES]
_shells = [(n, re.compile(p, re.I)) for n, p in SHELLS]
_seen = {}


def name_of(text, shells=False, remember=True):
    """The carrier a name belongs to, or None when it isn't plainly a carrier's. remember=False for text a request sent (the
    tower report's carriers=): kept, it grew the memo without bound, 9 MB for 20 requests of 3,000 names (review 11/10)."""
    key = (text, shells)
    if key in _seen:
        return _seen[key]
    got = next((n for n, p in (_rules + _shells if shells else _rules) if p.search(text or "")), None)
    if remember:
        _seen[key] = got
    return got
