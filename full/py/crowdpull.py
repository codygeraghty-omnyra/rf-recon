"""
Crowd data the server can't fetch itself, fetched by a PC and kept on the server (Cody 11/7: "you can pull data with pc and push to
the server too ... just dont store it on the pc, store where everyone can get if my pc is off or disconnected").

WiGLE refuses the AWS server's address (HTTP 401; the same key works from Cody's PC). So when the server is asked for WiGLE (the
crowd button for a pin, or the scheduled refresh of a mission's area) and WiGLE refuses it, the request goes into this queue
instead of failing. ops/crowd_pull.py on the PC signs in as a "fetcher" login (remote.py: that role reaches only the two pull
routes), takes the queue, fetches each area from WiGLE with the PC's own key, and posts the rows here. They are stored exactly as
a server fetch would store them (connectors.upsert: history kept, provenance tagged) and the PC keeps nothing. With the PC off,
requests wait here and the app says so.
"""
import json
import time

SOURCES = ("wigle",)        # what the PC fetcher may bring; nothing else is accepted
MAX_ROWS = 20000            # one post
ROW_LEN = 17                # connectors' ext_point row: source, layer, ext_id, lat, lon, kind, label, freq_mhz, freq_in_mhz, dbm,
                            # mode, sig_type, first_seen, last_seen, details, fetched_at, attribution
SCHEMA = """
CREATE TABLE IF NOT EXISTS crowd_queue(id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
    radius_mi REAL NOT NULL, kinds TEXT, asked_at TEXT, asked_by TEXT, state TEXT NOT NULL DEFAULT 'waiting', taken_at TEXT,
    done_at TEXT, rows INTEGER, message TEXT);
CREATE INDEX IF NOT EXISTS crowd_queue_state ON crowd_queue(state, id);
"""


def _now():
    return time.strftime("%Y-%m-%d %H:%M")


def ensure(con):
    con.executescript(SCHEMA)


def refused(err):
    """Whether this error is the source refusing us (an address or key it won't serve), as WiGLE does the server: queue it."""
    code = getattr(err, "code", None)
    text = str(err).lower()
    return code in (401, 403) or "401" in text or "403" in text or "unauthorized" in text or "forbidden" in text or "refused" in text


def enqueue(con, source, lat, lon, radius_mi, kinds=None, who=""):
    """One area to fetch. The same area still waiting (to about 100 m and the same radius) isn't queued twice. Returns its id."""
    ensure(con)
    if source not in SOURCES:
        raise ValueError(f"{source} isn't fetched by the PC")
    lat, lon, radius_mi = round(float(lat), 3), round(float(lon), 3), round(float(radius_mi), 1)
    row = con.execute("SELECT id FROM crowd_queue WHERE state IN ('waiting','taken') AND source=? AND lat=? AND lon=? AND radius_mi=?",
                      (source, lat, lon, radius_mi)).fetchone()
    if row:
        return row[0]
    cur = con.execute("INSERT INTO crowd_queue(source, lat, lon, radius_mi, kinds, asked_at, asked_by) VALUES(?,?,?,?,?,?,?)",
                      (source, lat, lon, radius_mi, json.dumps(list(kinds or ())), _now(), who or ""))
    con.commit()
    return cur.lastrowid


def pending(con, limit=20):
    """What the PC should fetch now: waiting requests, and taken ones the PC never answered within an hour (it went off)."""
    ensure(con)
    hour_ago = time.strftime("%Y-%m-%d %H:%M", time.localtime(time.time() - 3600))
    rows = con.execute("SELECT id, source, lat, lon, radius_mi, kinds FROM crowd_queue WHERE state='waiting' OR (state='taken' AND taken_at < ?) "
                       "ORDER BY id LIMIT ?", (hour_ago, int(limit))).fetchall()
    ids = [r[0] for r in rows]
    if ids:
        con.execute(f"UPDATE crowd_queue SET state='taken', taken_at=? WHERE id IN ({','.join('?' * len(ids))})", (_now(), *ids))
        con.commit()
    return [{"id": r[0], "source": r[1], "lat": r[2], "lon": r[3], "radius_mi": r[4], "kinds": json.loads(r[5] or "[]")} for r in rows]


def _check_rows(source, rows):
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError(f"rows must be a list of at most {MAX_ROWS:,}")
    out = []
    for r in rows:
        if not isinstance(r, list) or len(r) != ROW_LEN or r[0] != source:
            raise ValueError("a row isn't a crowd point from that source")
        lat, lon = r[3], r[4]
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("a row's position isn't a position")
        if any(x is not None and not isinstance(x, (str, int, float)) for x in r) or len(json.dumps(r)) > 20000:
            raise ValueError("a row holds something that isn't plain text or a number, or is too big")
        out.append(tuple(r))
    return out


def accept(con, qid, source, rows, lat=None, lon=None, radius_mi=None, message="ok"):
    """The PC's answer for one queued area (qid), or rows it fetched unasked (qid None, with the area they cover). Stored as a server
    fetch would be. Returns how many rows."""
    import connectors
    ensure(con)
    if source not in SOURCES:
        raise ValueError(f"{source} isn't fetched by the PC")
    q = None
    if qid is not None:
        q = con.execute("SELECT source, lat, lon, radius_mi FROM crowd_queue WHERE id=?", (int(qid),)).fetchone()
        if not q or q[0] != source:
            raise LookupError("no such request")
        lat, lon, radius_mi = q[1], q[2], q[3]
    if lat is None or lon is None or radius_mi is None:
        raise ValueError("rows sent unasked need the area they cover")
    good = _check_rows(source, rows)
    if good:
        connectors.upsert(con, good)
    connectors.log_fetch(con, source, float(lat), float(lon), float(radius_mi), len(good), f"{message}, from the PC fetcher"[:200])
    if q:
        con.execute("UPDATE crowd_queue SET state='done', done_at=?, rows=?, message=? WHERE id=?", (_now(), len(good), message[:200], int(qid)))
        con.commit()
    return len(good)


def failed(con, qid, message):
    """The PC tried and the source refused it too: kept as failed with why, never retried by itself."""
    ensure(con)
    con.execute("UPDATE crowd_queue SET state='failed', done_at=?, message=? WHERE id=?", (_now(), str(message)[:300], int(qid)))
    con.commit()


def status(con):
    """For the app: how many wait, and when the PC last brought something."""
    ensure(con)
    waiting = con.execute("SELECT COUNT(*) FROM crowd_queue WHERE state IN ('waiting','taken')").fetchone()[0]
    last = con.execute("SELECT MAX(done_at) FROM crowd_queue WHERE state='done'").fetchone()[0]
    seen = con.execute("SELECT MAX(fetched_at) FROM ext_fetch WHERE message LIKE '%from the PC fetcher%'").fetchone()[0] if \
        con.execute("SELECT 1 FROM sqlite_master WHERE name='ext_fetch'").fetchone() else None
    return {"waiting": waiting, "last_done": last, "last_pc": seen}


def queued_message(n_waiting):
    return (f"WiGLE won't answer the server, so this went to the PC fetcher ({n_waiting} waiting). It's fetched the next time Cody's "
            "PC is on, usually within 15 minutes, and stays on the server after.")
