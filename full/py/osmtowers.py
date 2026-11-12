"""
OpenStreetMap's towers and masts, for the tower report (towerfuse.py; plan 11/10, section 1), through the Data desk.

What it asks for: masts, communication towers, water towers, and anything tagged communication:mobile_phone, in tiles
of 0.2 degrees. Each tile is kept in crowd.db (ext_point rows of source osm_towers, one ext_fetch row per ask) and asked
again only after 90 days. The FCC never registers a rooftop or a short mast, and OSM often has them: at Monroe NY the
AT&T rooftop Andy verified (eNB 812442) is a mast tagged communication:mobile_phone, 883 m from the site, with no FCC
registration within 2.6 km.

One server, one request at a time (the Data desk's one-route rule: das.py and tunnels.py ask three servers at once).
Every request goes through datadesk.fetchkit with DAStastic's own user agent, and every row through datadesk.clean's
"structures" profile: who edited a feature (user, uid, changeset) is never kept, and of its tags only what describes the
structure. A refusal (429, 406, 403...) files a Needs a person task and is never tried another way; after a 429 or 406
nothing is asked for 30 s. A refusal or an overloaded server (504) leaves the kept tiles in use, and the tower report
works without OSM at all.

Terms, read 2026-11-10 on the providers' own pages (reference/data_desk.json):
- OpenStreetMap data is under the ODbL: credit OpenStreetMap and say the data is under the ODbL
  (openstreetmap.org/copyright; osmfoundation.org/wiki/Licence/Attribution_Guidelines).
- The main Overpass server (wiki.openstreetmap.org/wiki/Overpass_API): under 10,000 queries and 1 GB a day, "divide those
  numbers by 100" for something set up to run regularly; no parallel requests; after a 429 or 406 pause 30 s; name the
  app in the User-Agent; "Commercial use should use self-hosted or paid Overpass servers". So a day here stops at 100
  requests, the source is off until a person switches it on (Data & updates: osm_towers), and a copy run for a customer
  needs a server of its own or a paid one (the setting osm_towers.server, https to a public host only: server_of; the
  public server is never asked from anything but Cody's own build).
- OpenStreetMap's towers fused with the crowd's carrier cells (OpenCelliD, CC BY-SA 4.0) stay on Cody's own build until
  counsel rules on mixing the ODbL and CC BY-SA (Cody 11/10): osm_towers is in build.PERSONAL_ONLY, so a sold copy (and a
  team login on Cody's) neither fetches nor reads these rows.
"""
import http.client
import ipaddress
import json
import math
import socket
import threading
import time
import urllib.parse

import build
import connectors
import geo
from datadesk import clean, fetchkit, persons

SOURCE = "osm_towers"
LAYER = "OpenStreetMap towers"
SERVER = "https://overpass-api.de/api/interpreter"  # the one server; a copy with its own or a paid one sets osm_towers.server
UA = "DAStastic/1.0 (DAS site survey; contact via omnyra.ai)"  # the wiki: name the app in the User-Agent
TILE_DEG = 0.2
KEEP_DAYS = 90
PER_DAY = 100   # the main server's 10,000 queries a day, divided by 100 for regular use (its wiki page, 11/10)
PAUSE_S = 30    # "If you receive an HTTP error code such as 429 or 406, pause for 30 seconds" (same page)
REACH_KM = 8    # the tower report reads OSM to 8 km (plan 11/10): a top-up asks for the tiles within it
WAIT_S = 90     # a request's own limit; the query asks the server for 60 s
ATTRIBUTION = "© OpenStreetMap contributors (ODbL)"
ENTRY = {"id": "overpass-api-openstreetmap", "name": "Overpass API (OpenStreetMap)", "url": "https://wiki.openstreetmap.org/wiki/Overpass_API",
         "terms": "OpenStreetMap data, ODbL: © OpenStreetMap contributors", "owner": "Cody"}
_ONE = threading.Lock()  # one request at a time, across every login and the updater
_PAUSE = {"until": 0.0, "why": ""}


def server_of(value, resolve=socket.getaddrinfo):
    """A hand-set osm_towers.server -> (url, None), or (None, why) when it can't be used: https to a public host only, never
    localhost, a loopback, private, link-local (169.254.169.254, the cloud metadata address) or reserved address, also after
    the name is looked up (fetchkit checks again on every request). Read as JSON or as plain text, so a URL written by hand
    without quotes works, and a bad value is said, never raised (it broke every top-up, review 11/10). Empty: (None, None)."""
    v = value
    if isinstance(v, str) and v.strip().startswith('"'):
        try:
            v = json.loads(v)
        except ValueError:
            pass
    if v in (None, ""):
        return None, None
    if not isinstance(v, str):
        return None, "osm_towers.server isn't a web address"
    v = v.strip()
    try:
        u = urllib.parse.urlsplit(v)
        host, _port = u.hostname, u.port
    except ValueError:
        return None, "osm_towers.server isn't a web address"
    if u.scheme != "https" or not host:
        return None, "osm_towers.server must be an https address"
    if u.username is not None or u.password is not None or "@" in u.netloc:  # "https://:@host/" has empty ones (round 2)
        return None, "osm_towers.server can't carry a name or password"
    if any(ch.isspace() or ord(ch) < 32 or ord(ch) == 127 for ch in v):  # urllib won't send them: every top-up was a 500
        return None, "osm_towers.server can't hold spaces or control characters"
    if u.query or u.fragment:  # fetch_tile adds ?data=, and a key in a query would go into the refusal's desk task
        return None, "osm_towers.server can't carry a query (?...): give the interpreter's address alone"
    h = host.rstrip(".").lower()
    if h == "localhost" or h.endswith((".localhost", ".local", ".internal", ".home.arpa")):
        return None, f"osm_towers.server names a local host ({host})"
    try:
        ipaddress.ip_address(h)
        literal = True
    except ValueError:
        literal = False
    if not fetchkit.public_host(h, resolve):
        return None, f"osm_towers.server isn't a public address ({host})" + ("" if literal else ", or its name doesn't resolve to one")
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path or "/", "", "")), None


def configured_server(con):
    """This copy's osm_towers.server from its main database, as server_of reads it: (url or None, why it can't be used)."""
    try:
        r = con.execute("SELECT v FROM setting WHERE k='osm_towers.server'").fetchone()
    except Exception:  # a database with no settings table
        return None, None
    return server_of(r[0] if r else None)


def tile_of(lat, lon):
    return (math.floor(lat / TILE_DEG + 1e-9), math.floor(lon / TILE_DEG + 1e-9))


def tile_box(t):
    """(south, west, north, east) of a tile."""
    return (round(t[0] * TILE_DEG, 6), round(t[1] * TILE_DEG, 6), round((t[0] + 1) * TILE_DEG, 6), round((t[1] + 1) * TILE_DEG, 6))


def tile_key(t):
    return f"tile {t[0]},{t[1]}"


def tiles_near(lat, lon, km):
    """Every tile a box of km around the point touches, nearest first."""
    s, n, w, e = geo.bbox(lat, lon, km / geo.MI_KM)
    a, b = tile_of(s, w), tile_of(n, e)
    out = [(i, j) for i in range(a[0], b[0] + 1) for j in range(a[1], b[1] + 1)]
    mid = lambda t: ((t[0] + 0.5) * TILE_DEG, (t[1] + 0.5) * TILE_DEG)  # noqa: E731
    return sorted(out, key=lambda t: geo.haversine_km(lat, lon, *mid(t)))


def query(t):
    """Overpass QL for one tile: tags and a centre for each feature, never who edited it (no "out meta")."""
    s, w, n, e = tile_box(t)
    bb = f"({s},{w},{n},{e})"
    return (f'[out:json][timeout:60];(nwr["man_made"="mast"]{bb};nwr["man_made"="communications_tower"]{bb};'
            f'nwr["man_made"="tower"]["tower:type"="communication"]{bb};nwr["man_made"="water_tower"]{bb};'
            f'nwr["communication:mobile_phone"]{bb};);out tags center qt;')


NOT_RADIO = {"lighting", "siren", "monitoring", "observation", "cooling", "bell_tower", "minaret", "defensive", "climbing", "watchtower",
             "clock", "transmission_line", "hose", "pylon"}


def kind_of(tags):
    """What a feature is, in a word the report can show, or None when it isn't a radio structure (a lighting mast)."""
    mm, tt = tags.get("man_made") or "", tags.get("tower:type") or ""
    comm = tt == "communication" or any(k.startswith("communication:") and v not in ("no", "") for k, v in tags.items())
    if str(tags.get("disused") or "").lower() == "yes" or str(tags.get("abandoned") or "").lower() == "yes":
        return None
    if mm == "water_tower":
        return "water tower"
    if tt and tt in NOT_RADIO and not comm:
        return None
    if mm in ("mast", "tower", "communications_tower", "antenna"):
        return mm.replace("_", " ")
    if comm:
        return "rooftop" if tags.get("building") else "structure"
    return None


def parse(data):
    """An Overpass answer -> rows for the cleaner: id, lat, lon, kind, tags (and an editor's details if a server sent them,
    which the cleaner drops)."""
    rows = []
    for el in (data or {}).get("elements") or []:
        tags = el.get("tags") or {}
        kind = kind_of(tags)
        if not kind or el.get("type") not in ("node", "way", "relation"):
            continue
        c = el.get("center") or {}
        row = {"id": f"{el['type']}/{el.get('id')}", "lat": el.get("lat", c.get("lat")), "lon": el.get("lon", c.get("lon")), "kind": kind, "tags": tags}
        for k in ("user", "uid", "changeset"):
            if k in el:
                row[k] = el[k]
        rows.append(row)
    return rows


def _since(days):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - days * 86400))


def kept_at(crowd, t, days=KEEP_DAYS):
    """When this tile last came in whole within `days`, or None."""
    r = crowd.execute("SELECT MAX(fetched_at) FROM ext_fetch WHERE source=? AND message=? AND fetched_at>=?", (SOURCE, tile_key(t), _since(days))).fetchone()
    return r[0] if r else None


def requests_today(crowd):
    r = crowd.execute("SELECT COALESCE(SUM(requests), 0) FROM ext_fetch WHERE source=? AND fetched_at LIKE ?", (SOURCE, time.strftime("%Y-%m-%d") + "%")).fetchone()
    return int(r[0] or 0)


def store(crowd, t, rows, fetched_at):
    """A tile's clean rows in place of what the tile had: a feature gone from OSM goes from here too."""
    key = tile_key(t)
    out = [(SOURCE, LAYER, r["id"], r["lat"], r["lon"], r["kind"], " · ".join(x for x in (r["tags"].get("name"), r["tags"].get("operator")) if x) or r["kind"],
            None, None, None, r["kind"], "", "", "", json.dumps({"osm": r["id"], "tags": r["tags"], "tile": key, "source": r.get("_source")}), fetched_at, ATTRIBUTION)
           for r in rows]
    if out:
        connectors.upsert(crowd, out)
    ids = {r["id"] for r in rows}
    s, w, n, e = tile_box(t)
    gone = []
    for pid, ext, det in crowd.execute("SELECT id, ext_id, details FROM ext_point WHERE source=? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                                       (SOURCE, s - 0.1, n + 0.1, w - 0.1, e + 0.1)).fetchall():
        try:
            mine = json.loads(det or "{}").get("tile") == key
        except ValueError:
            mine = False
        if mine and ext not in ids:
            gone.append((pid,))
    if gone:
        crowd.executemany("DELETE FROM ext_point WHERE id=?", gone)
        crowd.commit()
    return len(out), len(gone)


def fetch_tile(crowd, t, fetcher, server=SERVER):
    """One tile from the server: {"rows", "gone", "quarantined", "scrubbed"}. Raises fetchkit.Refused / Failed / TooBig,
    or Failed when the server answered with a runtime error instead of data."""
    url = server + "?" + urllib.parse.urlencode({"data": query(t)})
    resp = fetcher.get(url, accept="application/json", conditional=False)
    try:
        data = json.loads(resp.text())
    except ValueError:
        raise fetchkit.Failed(f"{urllib.parse.urlsplit(server).netloc}: an answer that isn't JSON")
    # Overpass always sends an object with "elements": anything else ({"error": "quota exceeded"} from a gateway, [] or
    # null from a proxy) emptied the tile as "gone from OSM" and kept it 90 days, or was a 500 (review 11/10 round 2)
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        raise fetchkit.Failed(f"{urllib.parse.urlsplit(server).netloc}: an answer that isn't Overpass's (no elements)")
    remark = str(data.get("remark") or "")
    if "error" in remark.lower() or "timed out" in remark.lower():  # Overpass's 200 with a runtime error: a partial answer
        raise fetchkit.Failed(f"{urllib.parse.urlsplit(server).netloc}: {remark[:120]}")
    now = time.strftime("%Y-%m-%d %H:%M")
    cleaned = clean.run(parse(data), "structures", ENTRY, now)
    n, gone = store(crowd, t, cleaned["kept"], now)
    return {"rows": n, "gone": gone, "quarantined": len(cleaned["quarantined"]), "scrubbed": cleaned["scrubbed"]}


def fetch_near(crowd, lat, lon, km=REACH_KM, con=None, fetcher=None, server=None):
    """The tiles within km of a point that aren't kept from the last 90 days, nearest first, one request at a time.
    {"tiles", "kept", "fetched", "rows", "requests", "stopped", "held"}: stopped says why it asked no more, and the kept
    copy stands in; held names it in a word (refused, failed, budget, pause, busy). con: the main database, for a
    refusal's Needs a person task."""
    server = server or SERVER
    tiles = tiles_near(lat, lon, km)
    out = {"tiles": len(tiles), "kept": 0, "fetched": 0, "rows": 0, "requests": 0, "stopped": None, "held": None,
           "server": urllib.parse.urlsplit(server).netloc}
    if not build.allowed(SOURCE):  # Cody's own build only until counsel rules (build.PERSONAL_ONLY)
        out.update(stopped="OpenStreetMap towers aren't in this build: " + build.PERSONAL_ONLY[SOURCE], held="terms")
        return out
    if server == SERVER and not build.personal_now():  # the public server's terms: commercial use needs its own or a paid server
        out.update(stopped="the public Overpass server is for Cody's own build only: this copy needs its own or a paid one (osm_towers.server)",
                   held="terms")
        return out
    todo = [t for t in tiles if not kept_at(crowd, t)]
    out["kept"] = len(tiles) - len(todo)
    if not todo:
        return out
    if not _ONE.acquire(timeout=WAIT_S):
        out.update(stopped="another OpenStreetMap request is still running: the kept copy is used", held="busy")
        return out
    try:
        f = fetcher or fetchkit.Fetcher(UA, max_bytes=20 * 1024 * 1024, timeout=WAIT_S, tries=1)  # a 504 is a busy server: not asked again now
        for t in todo:
            if kept_at(crowd, t):  # kept while this call waited its turn (two top-ups at one place asked every tile twice, review 11/10)
                out["kept"] += 1
                continue
            if time.time() < _PAUSE["until"]:
                out.update(stopped=f"the server asked DAStastic to wait ({_PAUSE['why']}): the kept copy is used", held="pause")
                break
            if requests_today(crowd) >= PER_DAY:
                out.update(stopped=f"today's {PER_DAY} OpenStreetMap requests are used: the kept copy is used", held="budget")
                break
            s, w, n, e = tile_box(t)
            mid = ((s + n) / 2, (w + e) / 2)
            before = len(f.requests)
            try:
                got = fetch_tile(crowd, t, f, server)
            except fetchkit.Refused as ex:
                spent = max(1, len(f.requests) - before)
                connectors.log_fetch(crowd, SOURCE, *mid, None, 0, f"refused {tile_key(t)}: {ex.why}", requests=spent)
                out["requests"] += spent
                if ex.status in (429, 406):
                    wait = PAUSE_S
                    try:
                        wait = max(PAUSE_S, int(ex.retry_after or 0))
                    except ValueError:
                        pass
                    _PAUSE.update(until=time.time() + wait, why=f"HTTP {ex.status}")
                if con is not None:
                    persons.ensure(con)
                    persons.from_refusal(con, ENTRY, ex, "OpenStreetMap's towers and masts for the tower report (osmtowers.py).")
                out.update(stopped=f"{out['server']} {ex.why}" + (f" (HTTP {ex.status})" if ex.status else "") + ": the kept copy is used",
                           held="refused")
                break
            # http.client's own errors aren't OSErrors: an answer cut off mid-chunk (IncompleteRead), an address it won't
            # send (InvalidURL); they escaped as a 500 with the request never counted (review 11/10 round 2)
            except (fetchkit.Failed, fetchkit.TooBig, ValueError, OSError, http.client.HTTPException) as ex:
                spent = max(1, len(f.requests) - before)
                connectors.log_fetch(crowd, SOURCE, *mid, None, 0, f"failed {tile_key(t)}: {clean.scrub_text(str(ex))[:160]}", requests=spent)
                out["requests"] += spent
                out.update(stopped=f"{out['server']} didn't answer ({clean.scrub_text(str(ex))[:120]}): the kept copy is used", held="failed")
                break
            spent = max(1, len(f.requests) - before)
            connectors.log_fetch(crowd, SOURCE, *mid, None, got["rows"], tile_key(t), requests=spent)
            out["requests"] += spent
            out["fetched"] += 1
            out["rows"] += got["rows"]
    finally:
        _ONE.release()
    return out


def rows_near(crowd, lat, lon, km=REACH_KM):
    """The kept OSM structures within km of a point: [{"id", "lat", "lon", "kind", "tags", "fetched", "dist_km"}], nearest first."""
    s, n, w, e = geo.bbox(lat, lon, km / geo.MI_KM)
    out = []
    try:
        rows = crowd.execute("SELECT ext_id, lat, lon, kind, details, fetched_at FROM ext_point WHERE source=? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                             (SOURCE, s, n, w, e)).fetchall()
    except Exception:  # a crowd database from before OSM towers: nothing kept
        return []
    for ext, la, lo, kind, det, at in rows:
        d = geo.haversine_km(lat, lon, la, lo)
        if d > km:
            continue
        try:
            tags = json.loads(det or "{}").get("tags") or {}
        except ValueError:
            tags = {}
        # the kind from the tags as they are now: the upsert never rewrites the kind column, so a feature re-tagged in OSM
        # (a mast that became a water tower) kept its first kind, type and weight (review 11/10)
        out.append({"id": ext, "lat": la, "lon": lo, "kind": kind_of(tags) or kind, "tags": tags, "fetched": at, "dist_km": d})
    return sorted(out, key=lambda r: r["dist_km"])


def fetch_area(crowd, lat, lon, radius_mi, con=None, fetcher=None, server=None):
    """The updater's run for a mission area (updater.py, source osm_towers): its tiles, to 20 miles at most."""
    return fetch_near(crowd, lat, lon, min(float(radius_mi or 5), 20.0) * geo.MI_KM, con=con, fetcher=fetcher, server=server)
