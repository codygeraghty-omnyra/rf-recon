"""
Suppliers' product pages into DAStastic's price history (Cody 11/8, "do this": pages anyone can see without logging in;
only sites whose robots.txt allows it and whose terms don't ban robots, Talley and Tessco first; slow, polite crawling at
night; prices are facts). Talley and Tessco were read 11/8 on their own pages: Talley's terms are terms of sale with no
clause on automated access and its robots.txt allows product pages (Crawl-delay 5); Tessco's terms allow its pages to be
used "as a shopping resource" and its robots.txt allows product pages.

How a night goes, per site:
- Only in the site's own quiet hours (01:30 to 05:00 where its servers are), at most PAGE_CAP pages a night, one page at
  a time, its robots.txt Crawl-delay apart (else RATE_S), robots.txt read fresh each night and honoured for every page.
- The parts DAStastic needs first (on a job's bill of materials, a request for quote, the starred standard parts), then
  the rest of the site's catalogue oldest-first, so the whole of it comes round in turn.
- The first refusal (401, 403, 429, 451, 503, a challenge page, a sign-in wall, robots.txt) stops that site for the night
  and files a "Needs a person" task (datadesk.persons); nothing is retried another way (fetchkit).
- Each price goes into the catalogue under "<supplier> (website)", so a firm's own price list for the same supplier (its
  account prices) is never overwritten, and into the part's dated price history; the same price again only moves "last
  seen".
- A business's licensed copy (licence.py) doesn't crawl: crawled prices stay in Omnyra's own copy until a lawyer has read
  the suppliers' terms (Cody 11/8: "Have Josh/Doug's lawyer maybe take a look").

Standard library only; fetches go through datadesk.fetchkit.
"""
import datetime
import html as htmllib
import json
import re
import threading
import time
import urllib.parse
import urllib.robotparser

UA = "DAStastic/1.0 (DAS parts pricing for its own buying; one page at a time, at night)"
PAGE_CAP = 500
RATE_S = 10
WINDOW = ((1, 30), (5, 0))  # the site's own local time
MAP_EVERY_DAYS = 7
SCHEMA = """
CREATE TABLE IF NOT EXISTS das_crawl(site TEXT NOT NULL, url TEXT NOT NULL, part TEXT, key TEXT, last_at TEXT, status TEXT, price REAL,
    PRIMARY KEY(site, url));
CREATE INDEX IF NOT EXISTS das_crawl_key ON das_crawl(site, key);
CREATE TABLE IF NOT EXISTS das_crawl_night(site TEXT NOT NULL, night TEXT NOT NULL, pages INTEGER, prices INTEGER, stopped TEXT,
    started_at TEXT, ended_at TEXT, PRIMARY KEY(site, night));
"""


def _text(s):
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def _money(s):
    m = re.search(r"\$?\s*([0-9][0-9,]*\.?[0-9]*)", s or "")
    return round(float(m.group(1).replace(",", "")), 4) if m else None


def read_talley(page, url=""):
    """Talley's product page: the main product block (its data-analytics, maker, maker's part number, description, price,
    suggested retail, unit, minimum and pack). None when the page isn't a product."""
    m = re.search(r'<fieldset class="cartable fullProduct"\s+data-analytics="([^"]*)"(.*?)</fieldset>', page, re.S)
    if not m:
        return None
    try:
        a = json.loads(htmllib.unescape(m.group(1)))
    except ValueError:
        a = {}
    body = m.group(2)
    g = lambda rx: (re.search(rx, body, re.S) or [None, ""])[1]  # noqa: E731
    maker = _text(g(r'<span class="prod-mfg">(.*?)</span>')).rstrip("| ").strip()
    part = _text(g(r'<span class="prod-num">(.*?)</span>'))
    price = a.get("price") if isinstance(a.get("price"), (int, float)) else _money(g(r'<span class="priceDisplay">(.*?)</span>'))
    if not part or price is None:
        return None
    unit = _text(g(r'<div class="unitMeasure">(.*?)</div>')) or a.get("item_variant") or "EA"
    return {"part": part, "maker": maker, "item": _text(g(r'<span class="prod-desc">(.*?)</span>')) or a.get("item_name") or "",
            "sku": a.get("item_id") or "", "price": float(price), "list_price": _money(g(r'<div class="suggRetail">.*?<span>(.*?)</span>')),
            "unit": unit.lower(), "min_qty": _money(g(r'class="defMinSell" value="([^"]*)"')),
            "pack": _money(g(r'class="defSellPkg" value="([^"]*)"')), "category": a.get("item_category") or "", "stock": None,
            "url": url}


def read_tessco(page, url=""):
    """Tessco's product page: its schema.org Product (maker's part number, brand, price, stock)."""
    for b in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try:
            j = json.loads(b)
        except ValueError:
            continue
        for p in (j if isinstance(j, list) else j.get("@graph") or [j]):
            if not isinstance(p, dict) or p.get("@type") != "Product":
                continue
            o = p.get("offers") or {}
            o = o[0] if isinstance(o, list) and o else o
            price = o.get("price") if isinstance(o, dict) else None
            try:
                price = float(price)
            except (TypeError, ValueError):
                continue
            stock = str((o or {}).get("availability") or "").rsplit("/", 1)[-1]
            brand = p.get("brand") or {}
            return {"part": (p.get("mpn") or "").strip(), "maker": (brand.get("name") if isinstance(brand, dict) else str(brand)) or "",
                    "item": p.get("name") or "", "sku": str(p.get("sku") or ""), "price": price, "list_price": None, "unit": "ea",
                    "min_qty": None, "pack": None, "category": str(p.get("category") or ""),
                    "stock": {"InStock": "in stock", "OutOfStock": "out of stock", "BackOrder": "on back order",
                              "PreOrder": "on pre-order", "LimitedAvailability": "limited"}.get(stock, stock.lower()), "url": url}
    return None


SITES = {
    "talley": {"name": "Talley (Rexel USA)", "supplier": "Talley (website)", "base": "https://www.talleycom.com",
               "sitemap": "https://www.talleycom.com/sitemap.xml", "product": r"^https://www\.talleycom\.com/product/[^/?#]+$",
               "tz": "America/Los_Angeles", "utc_std": -8, "read": read_talley, "source": "talley-product-pages",
               "part_in_url": True},
    "tessco": {"name": "Tessco", "supplier": "Tessco (website)", "base": "https://www.tessco.com",
               "sitemap": "https://www.tessco.com/sitemap.xml", "product": r"^https://www\.tessco\.com/product/[^?#]+--\d+$",
               "tz": "America/New_York", "utc_std": -5, "read": read_tessco, "source": "tessco-product-pages", "part_in_url": False},
}


def ensure(con):
    con.executescript(SCHEMA)


def norm(p):
    return re.sub(r"[^a-z0-9]", "", str(p or "").lower())


def site_now(site, now=None):
    """The site's own local time (zoneinfo where there is one; else its standard offset)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo(SITES[site]["tz"]))
    except Exception:
        return now.astimezone(datetime.timezone(datetime.timedelta(hours=SITES[site]["utc_std"])))


def in_window(site, now=None):
    t = site_now(site, now)
    (h0, m0), (h1, m1) = WINDOW
    return (h0, m0) <= (t.hour, t.minute) < (h1, m1)


def night_of(site, now=None):
    return site_now(site, now).strftime("%Y-%m-%d")


def wanted(con):
    """The parts DAStastic needs prices for first: on a job's bill of materials, a request for quote, the standard parts."""
    out = set()
    for (data,) in con.execute("SELECT data FROM das_job"):
        try:
            out.update(norm(x.get("part")) for x in (json.loads(data or "{}").get("bom") or []) if isinstance(x, dict))
        except ValueError:
            pass
    for (lines,) in con.execute("SELECT lines FROM das_rfq WHERE status IS NULL OR status<>'closed'"):
        try:
            out.update(norm(x.get("part")) for x in json.loads(lines or "[]") if isinstance(x, dict))
        except ValueError:
            pass
    out.update(norm(p) for (p,) in con.execute("SELECT part FROM das_part WHERE standard=1"))
    return {p for p in out if len(p) >= 5}


def _locs(xml):
    return [htmllib.unescape(u).strip() for u in re.findall(r"<loc>\s*([^<]+?)\s*</loc>", xml)]


def map_site(con, site, fetcher, rp, log=print):
    """The site's product pages from its sitemap (a sitemap index's product sitemaps too), into the crawl list: new ones
    added, nothing removed. Returns how many it lists."""
    cfg = SITES[site]
    rx = re.compile(cfg["product"])
    seen, todo, maps = set(), [cfg["sitemap"]], 0
    while todo and maps < 40:
        u = todo.pop(0)
        if u in seen or not rp.can_fetch(UA, u):
            continue
        seen.add(u)
        maps += 1
        xml = fetcher.get(u, accept="application/xml,text/xml,*/*", conditional=False).text()
        locs = _locs(xml)
        if "<sitemapindex" in xml[:2000]:
            todo += [x for x in locs if re.search(r"(?i)product", x)] or locs
            continue
        rows = [(site, x, x.rsplit("/", 1)[-1] if cfg["part_in_url"] else "", norm(x.rsplit("/", 1)[-1]) if cfg["part_in_url"] else "")
                for x in locs if rx.match(x)]
        con.executemany("INSERT OR IGNORE INTO das_crawl(site, url, part, key) VALUES(?,?,?,?)", rows)
        con.commit()
        if maps > 1:
            fetcher.sleep(max(2, crawl_delay(rp)))
    n = con.execute("SELECT COUNT(*) FROM das_crawl WHERE site=?", (site,)).fetchone()[0]
    con.execute("INSERT OR REPLACE INTO das_crawl(site, url, status, last_at) VALUES(?, '#sitemap', 'mapped', ?)",
                (site, datetime.datetime.now().strftime("%Y-%m-%d %H:%M")))
    con.commit()
    log(f"{cfg['name']}: {n - 1:,} product pages listed")
    return n - 1


def crawl_delay(rp):
    try:
        d = rp.crawl_delay(UA) or rp.crawl_delay("*")
    except Exception:
        d = None
    return max(float(d or 0), 1.0) if d else RATE_S


def order(con, site, need, cap):
    """Tonight's pages: the parts DAStastic needs first (not read in the last day), then the oldest-read of the rest."""
    month_ago = (datetime.datetime.now() - datetime.timedelta(days=30)).strftime("%Y-%m-%d %H:%M")
    rows = con.execute("SELECT url, key, last_at FROM das_crawl WHERE site=? AND url<>'#sitemap' AND NOT (COALESCE(status,'')='not available' AND COALESCE(last_at,'')>?)",
                       (site, month_ago)).fetchall()
    day_ago = (datetime.datetime.now() - datetime.timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
    hot = [r[0] for r in rows if r[1] and any(r[1].endswith(p) for p in need) and (r[2] or "") < day_ago]
    fresh = (datetime.datetime.now() - datetime.timedelta(hours=20)).strftime("%Y-%m-%d %H:%M")
    rest = [r[0] for r in sorted(rows, key=lambda r: r[2] or "") if r[0] not in set(hot) and (r[2] or "") < fresh]  # not twice a night
    return (hot + rest)[:cap]


def keep(con, site, got, at, das):
    """One page's price into the catalogue and its history. Returns True when a new price was kept."""
    cfg = SITES[site]
    sup, part = cfg["supplier"], got["part"]
    key = das._part_key(part, got["item"])
    con.execute("""INSERT INTO das_part(supplier, key, part, item, maker, unit, price, updated_at) VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(supplier, key) DO UPDATE SET item=COALESCE(NULLIF(excluded.item,''), item),
                   maker=COALESCE(NULLIF(excluded.maker,''), maker), unit=COALESCE(NULLIF(excluded.unit,''), unit),
                   price=excluded.price, updated_at=excluded.updated_at""",
                (sup, key, part, got["item"], got["maker"], got["unit"], got["price"], at))
    kept = das._keep_price(con, sup, key, part, got["price"], at, f"website {urllib.parse.urlsplit(got['url']).hostname}")
    con.execute("UPDATE das_crawl SET part=?, key=?, last_at=?, status=?, price=? WHERE site=? AND url=?",
                (part, norm(part), at, got.get("stock") or "read", got["price"], site, got["url"]))
    return kept


def night(con, site, fetcher, das, persons=None, registry_entry=None, now=None, cap=PAGE_CAP, log=print, stop=None):
    """One site's night: robots read fresh, the sitemap mapped once a week, then up to cap pages. Returns a summary."""
    cfg = SITES[site]
    ensure(con)
    when = night_of(site, now)
    done = con.execute("SELECT pages, stopped FROM das_crawl_night WHERE site=? AND night=?", (site, when)).fetchone()
    if done and (done[1] or (done[0] or 0) >= cap):
        return {"site": site, "pages": 0, "note": "tonight's pages are done"}
    from datadesk import fetchkit
    started = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    pages = prices = 0
    stopped = ""
    try:
        r = fetcher.get(cfg["base"] + "/robots.txt", accept="text/plain", conditional=False)
        rp = urllib.robotparser.RobotFileParser()
        rp.parse(r.text().splitlines())
        rate = crawl_delay(rp)
        mapped = con.execute("SELECT last_at FROM das_crawl WHERE site=? AND url='#sitemap'", (site,)).fetchone()
        if not mapped or (mapped[0] or "") < (datetime.datetime.now() - datetime.timedelta(days=MAP_EVERY_DAYS)).strftime("%Y-%m-%d %H:%M"):
            fetcher.sleep(rate)
            map_site(con, site, fetcher, rp, log)
        left = cap - ((done[0] or 0) if done else 0)
        for url in order(con, site, wanted(con), left):
            if stop and stop():
                stopped = "stopped by a person"
                break
            if now is None and not in_window(site):  # a real night ends with its window (a test passes its own time)
                stopped = "the night window ended"
                break
            if not rp.can_fetch(UA, url):
                con.execute("UPDATE das_crawl SET status='robots: no', last_at=? WHERE site=? AND url=?", (started, site, url))
                continue
            fetcher.sleep(rate)
            try:
                page = fetcher.get(url, accept="text/html", conditional=False, expect_html=True)
            except fetchkit.Failed as e:
                con.execute("UPDATE das_crawl SET status=?, last_at=? WHERE site=? AND url=?", (f"failed: {str(e)[:80]}", started, site, url))
                continue
            pages += 1
            got = cfg["read"](page.text(), url)
            at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
            if got:
                prices += 1 if keep(con, site, dict(got, url=url), at, das) else 0
            else:  # a product the site no longer sells (still in its sitemap) waits a month before it's read again
                gone = re.search(r"(?i)<title>[^<]*(not available|no longer available|discontinued)", page.text()[:20000])
                con.execute("UPDATE das_crawl SET status=?, last_at=? WHERE site=? AND url=?",
                            ("not available" if gone else "no price on the page", at, site, url))
            con.commit()
    except fetchkit.Refused as e:
        stopped = f"refused: {e.why}"
        if persons and registry_entry:
            persons.from_refusal(con, registry_entry, e, f"{cfg['name']} refused DAStastic's nightly price reading; it stopped for the night.")
    con.execute("""INSERT INTO das_crawl_night(site, night, pages, prices, stopped, started_at, ended_at) VALUES(?,?,?,?,?,?,?)
                   ON CONFLICT(site, night) DO UPDATE SET pages=pages+excluded.pages, prices=prices+excluded.prices,
                   stopped=COALESCE(NULLIF(excluded.stopped,''), stopped), ended_at=excluded.ended_at""",
                (site, when, pages, prices, stopped, started, datetime.datetime.now().strftime("%Y-%m-%d %H:%M")))
    con.commit()
    return {"site": site, "pages": pages, "new_prices": prices, "stopped": stopped}


_running = {}
_lock = threading.Lock()


def start_due(connect, data_dir, das, log=print, now=None, cap=PAGE_CAP):
    """The updater's hourly call: for each site whose night window is open and whose night isn't done, a crawler thread
    (one per site, never two). Returns at once with what it started and why the others didn't."""
    import licence
    if licence.load(data_dir):
        return {"started": [], "note": "a licensed copy doesn't crawl (crawled prices stay in Omnyra's own copy)"}
    from datadesk import fetchkit, persons
    started, waiting = [], []
    for site in SITES:
        if not in_window(site, now):
            t = site_now(site, now)
            waiting.append(f"{SITES[site]['name']} at 1:30 AM its time (now {t:%I:%M %p})")
            continue
        with _lock:
            if _running.get(site):
                waiting.append(f"{SITES[site]['name']} already reading")
                continue
            _running[site] = True

        def go(site=site):
            con = connect()
            try:
                entry = {"id": SITES[site]["source"], "name": f"{SITES[site]['name']} product pages", "owner": "Cody"}
                r = night(con, site, fetchkit.Fetcher(UA, max_bytes=8 * 1024 * 1024), das, persons, entry, log=log)
                log(f"{SITES[site]['name']}: {r.get('pages', 0)} pages, {r.get('new_prices', 0)} new prices" + (f"; {r['stopped']}" if r.get("stopped") else ""))
            except Exception as e:
                log(f"{SITES[site]['name']}: {str(e)[:200]}")
            finally:
                con.close()
                with _lock:
                    _running.pop(site, None)
        threading.Thread(target=go, daemon=True, name=f"partcrawl-{site}").start()
        started.append(SITES[site]["name"])
    return {"started": started, "waiting": waiting}


def seen_for(con, part):
    """What this copy last read on each supplier's own site for a part: {supplier id: {price, unit, at, url}}."""
    k = norm(part)
    if len(k) < 3:
        return {}
    ensure(con)
    out = {}
    for site, cfg in SITES.items():
        r = con.execute("SELECT url, price, last_at, status FROM das_crawl WHERE site=? AND key=? AND price IS NOT NULL ORDER BY last_at DESC LIMIT 1",
                        (site, k)).fetchone()
        if r:
            u = con.execute("SELECT unit FROM das_part WHERE supplier=? AND lower(part)=lower(?)", (cfg["supplier"], part)).fetchone()
            out[site] = {"price": r[1], "at": (r[2] or "")[:10], "url": r[0], "stock": r[3] if r[3] not in ("read", None) else "",
                         "unit": (u[0] if u else "") or ""}
    return out


def summary(con):
    """What the price reading has: per site, the pages listed and read, the last night's pages and when."""
    ensure(con)
    out = []
    for site, cfg in SITES.items():
        listed = con.execute("SELECT COUNT(*) FROM das_crawl WHERE site=? AND url<>'#sitemap'", (site,)).fetchone()[0]
        read = con.execute("SELECT COUNT(*) FROM das_crawl WHERE site=? AND url<>'#sitemap' AND price IS NOT NULL", (site,)).fetchone()[0]
        last = con.execute("SELECT night, pages, prices, stopped FROM das_crawl_night WHERE site=? ORDER BY night DESC LIMIT 1", (site,)).fetchone()
        out.append({"site": site, "name": cfg["name"], "listed": listed, "priced": read,
                    "last_night": dict(zip(("night", "pages", "new_prices", "stopped"), last)) if last else None})
    return out
