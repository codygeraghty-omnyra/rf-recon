"""
The TAK team on RF Recon's own map (Cody 11/6: "ATAK actually in our map", the TAK layer he picked). ATAK, iTAK and WinTAK
share positions and markers as Cursor-on-Target over the local network's SA multicast, 239.2.3.1:6969, the channel
Push to ATAK already sends on (takpush.py). This listens there and keeps the latest event from each sender in memory:
who (callsign, team, role), where, and how fresh. Both encodings ATAK uses are read: TAK protocol version 0 (CoT XML)
and version 1 (protobuf, a 0xbf 0x01 0xbf header then a TakMessage).

PC only, and only while someone is looking: the map's "TAK team" layer switches it on and keeps it on by asking for the
feed; with no ask for IDLE_S it stops and the socket closes. Nothing is written to disk: people's positions live in memory
and go when they go stale or the listener stops. RF Recon's own markers (uid RFRecon.*) are left out. Packets are capped,
a DOCTYPE or ENTITY is refused, and one sender's flood is dropped past a rate.
"""
import socket
import struct
import threading
import time
import xml.etree.ElementTree as ET

import takpush

GROUP, PORT = "239.2.3.1", 6969
MAX_PACKET = 65536
MAX_KEEP = 2000           # senders kept at once
IDLE_S = 120              # no one asked for the feed this long: stop listening
STALE_GRACE_S = 300       # a stale event stays this long, shown as stale, then goes
RATE_PER_MIN = 600        # packets a minute from one address before the rest that minute are dropped

_lock = threading.Lock()
_state = {"run": None, "items": {}, "asked": 0.0, "error": "", "since": "", "count": 0}


# ---------------------------------------------------------------- reading one packet
def _iso(s):
    """A CoT time (2026-11-06T19:30:00.000Z, UTC) -> epoch seconds, or None."""
    from datetime import datetime, timezone
    try:
        return datetime.strptime(str(s).strip()[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        return None


def _f(x):
    try:
        v = float(x)
        return v if v == v and abs(v) < 1e7 else None
    except (TypeError, ValueError):
        return None


def parse_xml(data):
    """CoT XML (TAK protocol version 0) -> an item dict, or None."""
    if len(data) > MAX_PACKET:
        return None
    text = data.decode("utf-8", "replace")
    up = text.upper()
    if "<!DOCTYPE" in up or "<!ENTITY" in up:
        return None
    try:
        e = ET.fromstring(text)
    except ET.ParseError:
        return None
    if e.tag != "event":
        return None
    p = e.find("point")
    if p is None:
        return None
    d = e.find("detail")
    c = d.find("contact") if d is not None else None
    g = d.find("__group") if d is not None else None
    r = d.find("remarks") if d is not None else None
    return _item(e.get("uid"), e.get("type"), e.get("how"), _iso(e.get("time")), _iso(e.get("stale")), _f(p.get("lat")), _f(p.get("lon")),
                 _f(p.get("hae")), _f(p.get("ce")), c.get("callsign") if c is not None else None,
                 g.get("name") if g is not None else None, g.get("role") if g is not None else None,
                 (r.text or "") if r is not None else "")


# protobuf (TAK protocol version 1): only the fields this needs. TakMessage{2: CotEvent}; CotEvent{1 type, 5 uid, 6 sendTime,
# 8 staleTime (ms), 9 how, 10 lat, 11 lon, 12 hae, 13 ce (doubles), 15 Detail}; Detail{1 xmlDetail, 2 Contact{2 callsign},
# 3 Group{1 name, 2 role}}
def _varint(b, i):
    out = shift = 0
    while True:
        if i >= len(b) or shift > 63:
            raise ValueError("bad varint")
        c = b[i]
        i += 1
        out |= (c & 0x7F) << shift
        if not c & 0x80:
            return out, i
        shift += 7


def _fields(b):
    """{field number: [values]}: bytes for length-delimited, int for varint, float for 64-bit."""
    out, i = {}, 0
    while i < len(b):
        key, i = _varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 1:
            if i + 8 > len(b):
                raise ValueError("cut short")
            v, i = struct.unpack("<d", b[i:i + 8])[0], i + 8
        elif wt == 2:
            n, i = _varint(b, i)
            if i + n > len(b):
                raise ValueError("cut short")
            v, i = b[i:i + n], i + n
        elif wt == 5:
            if i + 4 > len(b):
                raise ValueError("cut short")
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError("bad wire type")
        out.setdefault(num, []).append(v)
        if sum(len(x) for x in out.values()) > 400:
            raise ValueError("too many fields")
    return out


def parse_proto(data):
    """TAK protocol version 1 (protobuf after 0xbf 0x01 0xbf) -> an item dict, or None."""
    if len(data) > MAX_PACKET or data[:3] != b"\xbf\x01\xbf":
        return None
    try:
        m = _fields(data[3:])
        ev = _fields((m.get(2) or [b""])[0])
        s = lambda F, k: (F.get(k) or [b""])[0].decode("utf-8", "replace") if isinstance((F.get(k) or [b""])[0], bytes) else None
        num = lambda F, k: (F.get(k) or [None])[0]
        det = _fields((ev.get(15) or [b""])[0])
        con = _fields((det.get(2) or [b""])[0])
        grp = _fields((det.get(3) or [b""])[0])
        ms = lambda v: v / 1000 if isinstance(v, int) else None
        return _item(s(ev, 5), s(ev, 1), s(ev, 9), ms(num(ev, 6)), ms(num(ev, 8)), _f(num(ev, 10)), _f(num(ev, 11)), _f(num(ev, 12)),
                     _f(num(ev, 13)), s(con, 2), s(grp, 1), s(grp, 2), "")
    except (ValueError, IndexError, struct.error):
        return None


def _item(uid, typ, how, t, stale, lat, lon, hae, ce, callsign, group, role, remarks):
    uid = str(uid or "")[:120]
    if not uid or uid.startswith("RFRecon.") or lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:
        return None
    typ = str(typ or "")[:40]
    kind = "team" if typ.startswith("a-f-G-U-C") or typ.startswith("a-f-G-E") or typ == "a-f-G" else "marker" if typ.startswith(("b-m-p", "a-")) else "other"
    return {"uid": uid, "type": typ, "how": str(how or "")[:8], "time": t, "stale": stale, "lat": round(lat, 7), "lon": round(lon, 7),
            "hae": hae, "ce": ce if ce is not None and ce < 9e6 else None, "callsign": str(callsign or "")[:60], "group": str(group or "")[:30],
            "role": str(role or "")[:30], "remarks": str(remarks or "")[:200], "kind": kind}


def parse(data):
    return parse_proto(data) if data[:1] == b"\xbf" else parse_xml(data)


def keep(item, now=None, src=""):
    """File one item: the latest from each sender wins."""
    if not item:
        return False
    now = now or time.time()
    with _lock:
        it = _state["items"]
        if item["uid"] not in it and len(it) >= MAX_KEEP:
            oldest = min(it, key=lambda k: it[k]["seen"])
            del it[oldest]
        it[item["uid"]] = {**item, "seen": now, "src": src}
        _state["count"] += 1
    return True


def feed(now=None):
    """What the map draws: every fresh or recently stale item, newest first, with its age; the stale-long-gone dropped."""
    now = now or time.time()
    with _lock:
        it = _state["items"]
        for k in [k for k, v in it.items() if (v.get("stale") or v["seen"] + 600) + STALE_GRACE_S < now]:
            del it[k]
        out = [{**{k: v for k, v in x.items() if k != "src"}, "age_s": round(now - x["seen"]), "is_stale": bool(x.get("stale") and x["stale"] < now)}
               for x in it.values()]
    return sorted(out, key=lambda x: x["age_s"])


# ---------------------------------------------------------------- the listener (PC only, while asked)
class Listener:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.sock.bind(("", PORT))
        except OSError:
            self.sock.close()
            raise
        self.joined = []
        for ip in takpush.local_ipv4():
            try:
                self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, socket.inet_aton(GROUP) + socket.inet_aton(ip))
                self.joined.append(ip)
            except OSError:
                pass
        self.sock.settimeout(1.0)
        self.stop_ev, self.rate = threading.Event(), {}
        self.thread = threading.Thread(target=self.run, name="takwatch", daemon=True)
        self.thread.start()

    def _allow(self, src):
        minute = int(time.time() // 60)
        m, n = self.rate.get(src, (minute, 0))
        n = n + 1 if m == minute else 1
        self.rate[src] = (minute, n)
        if len(self.rate) > 2000:
            self.rate = {k: v for k, v in self.rate.items() if v[0] == minute}
        return n <= RATE_PER_MIN

    def run(self):
        try:
            while not self.stop_ev.is_set():
                if time.time() - _state["asked"] > IDLE_S:
                    break
                try:
                    data, addr = self.sock.recvfrom(MAX_PACKET + 1)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if len(data) <= MAX_PACKET and self._allow(addr[0]):
                    keep(parse(data), src=addr[0])
        finally:
            self.sock.close()
            with _lock:
                if _state["run"] is self:
                    _state["run"] = None

    def stop(self):
        self.stop_ev.set()
        self.thread.join(timeout=3)


def ask(now=None):
    """The map asked for the feed: listen if not already (PC only), and say what's heard."""
    _state["asked"] = now or time.time()
    with _lock:
        run = _state["run"]
    if not run:
        try:
            run = Listener()
            with _lock:
                _state["run"], _state["error"], _state["since"] = run, "", time.strftime("%H:%M")
        except OSError as e:
            _state["error"] = f"Can't listen on UDP {PORT}: {e.strerror or e}. Another TAK app on this PC may hold it; WinTAK and RF Recon can't both."
    with _lock:
        r = _state["run"]
        return {"listening": bool(r), "networks": len(r.joined) if r else 0, "since": _state["since"], "error": _state["error"], "heard": _state["count"]}


def stop():
    with _lock:
        run, _state["run"] = _state["run"], None
    if run:
        run.stop()
    with _lock:
        _state["items"].clear()
