"""
BDA monitoring (lane D, 11/4; beat-ahead area 7 "Monitoring of installed BDAs"): a stdlib SNMP v1 / v2c trap receiver.
BUILT SWITCHED OFF. Nothing listens until an admin turns it on (a job's Overview > Monitoring > Switch on, saved as the
setting "snmp.monitor": {"on", "port" (default 1162, so no root is needed), "bind"}). Off, no socket is opened.

What it does when on: each trap (any maker: v1 Trap-PDU, v2c SNMPv2-Trap or InformRequest) is decoded here (BER by hand,
ITU-T X.690; PDUs per RFC 3416, v1 trap OIDs per RFC 3584 3.1), filed into the DAS job whose monitored BDA matches the
trap's source address (or the v1 agent address) or its community string, and tagged with one of the code's supervisory
signals (NFPA 1225 (2022) 18.14.1.2 and 18.3.2.1, IFC 2021 510.4.2.5) in the code's own words: from the BDA's own map
(trap or varbind OID -> signal, set in the panel), else the standard SNMP traps, else the words in the trap's text. A
trap it can't place shows its raw OID until someone maps it. A monitored BDA that sends nothing for its quiet hours
(default 24) is "not heard from". RF Recon never sends SNMP: no replies to informs, no GET, no SET (remote RF shut-off
is the licensee's, beat-ahead "needs others").

The server's firewall is not opened by this code: the admin opens UDP <port> from the buildings' addresses.
"""
import datetime
import hashlib
import ipaddress
import json
import re
import socket
import sqlite3
import threading

SETTING = "snmp.monitor"
DEFAULT = {"on": False, "port": 1162, "bind": "0.0.0.0"}
QUIET_HOURS = 24          # a monitored BDA silent this long is "not heard from" (each BDA can set its own)
MAX_PACKET = 16384        # a BDA's trap is a few hundred bytes; anything larger is dropped
RATE_PER_MIN = 120        # traps a minute from one address before the rest that minute are dropped
KEEP_UNMATCHED = 500      # traps no job claims: the newest this many are kept, to map a new BDA from
KEEP_PER_JOB = 5000       # traps kept per job

SCHEMA = """
CREATE TABLE IF NOT EXISTS bda_trap(id INTEGER PRIMARY KEY, ts TEXT, src TEXT, agent TEXT, community TEXT, version TEXT,
    pdu TEXT, trap_oid TEXT, varbinds TEXT, text TEXT, signal TEXT, state TEXT, job_id INTEGER, bda TEXT, how TEXT);
CREATE INDEX IF NOT EXISTS bda_trap_job ON bda_trap(job_id, bda, id);
"""

NFPA = "https://oci.georgia.gov/document/document/nfpa-1225-chapter-18/download"
IFC = "https://www.oswegofire.com/wp-content/uploads/2025/11/2021_ifc_510-Comm-Coverage.pdf"
OCSD = {"text": "The system shall be capable of providing SNMP based alarms to specified servers.",
        "section": "OCSD ERRCS Deployment Guidelines Rev 4.5 (8-4-2025), Appendix C 6.b.iii",
        "source": "https://ocsheriff.gov/sites/ocsd/files/2025-08/OCSD%20ERRCS%20Deployment%20Guidelines%20-REV%204.5%20%208-4-2025%202.pdf",
        "also": "OCSD's Appendix D requires each installation in the Response LINQ NOC under a service agreement the owner keeps: "
                "in Orange County this panel is an extra, not the monitoring OCSD approves."}
# the code's supervisory signals, in its words (NFPA 1225-2022 18.14.1.2; oscillation 18.3.2.1), with the IFC 2021 item
SIGNALS = [
    {"key": "signal_source", "label": "Signal source malfunction", "section": "NFPA 1225 18.14.1.2(2)(a)",
     "ifc": "IFC 2021 510.4.2.5(3): malfunction of the donor antenna(s)"},
    {"key": "rf_device", "label": "Active RF-emitting device failure", "section": "NFPA 1225 18.14.1.2(2)(b)",
     "ifc": "IFC 2021 510.4.2.5(4): failure of active RF-emitting device(s)"},
    {"key": "low_battery", "label": "Low-battery capacity indication when 70 percent of the 12-hour operating capacity has been depleted",
     "section": "NFPA 1225 18.14.1.2(2)(c)", "ifc": "IFC 2021 510.4.2.5(5): low-battery capacity at 70-percent reduction of operating capacity"},
    {"key": "component", "label": "Active system component failure", "section": "NFPA 1225 18.14.1.2(2)(d)",
     "ifc": "IFC 2021 510.4.2.5(6): failure of critical system components"},
    {"key": "ac_power", "label": "Loss of normal ac power", "section": "NFPA 1225 18.14.1.2(3)(a)",
     "ifc": "IFC 2021 510.4.2.5(1): loss of normal AC power supply"},
    {"key": "charger", "label": "Failure of battery charger", "section": "NFPA 1225 18.14.1.2(3)(b)",
     "ifc": "IFC 2021 510.4.2.5(2): system battery charger(s) failure"},
    {"key": "link", "label": "Communications link between the fire alarm system and the ERCES", "section": "NFPA 1225 18.14.1.2(4)",
     "ifc": "IFC 2021 510.4.2.5(7): the communications link between the fire alarm system and the system"},
    {"key": "oscillation", "label": "Oscillation detected by a signal booster", "section": "NFPA 1225 18.3.2.1",
     "ifc": "IFC 2021 510.4.2.5(8): oscillation of active RF-emitting device(s)"},
]
SIG = {s["key"]: s for s in SIGNALS}
# no MIB, so a trap is placed by the words its maker put in it (first match wins: the specific before the general).
# The words come from makers' alarm lists (Westell PS51080-SNMP: PLL, isolation, PA shutdown, power failure, antenna
# VSWR, manual amp off; Comba and Bird manuals); a BDA whose traps say nothing readable is mapped by OID in the panel
WORDS = [
    ("link", r"fire[\s_-]*alarm|\bfacp\b|fire[\s_-]*panel"),
    ("charger", r"charg"),
    ("low_battery", r"batt(ery)?[\s_-]*(low|capacity|deplet)|low[\s_-]*batt"),
    ("ac_power", r"\bac\b|\bmains\b|power[\s_-]*(fail|loss|lost|outage|down)|utility[\s_-]*power|on[\s_-]*battery"),
    ("oscillation", r"oscillat|isolation"),
    ("signal_source", r"donor|vswr|return[\s_-]*loss|antenna|no[\s_-]*(input|signal)|input[\s_-]*(signal|level|power)[\s_-]*(low|loss|lost)"),
    ("rf_device", r"\bpa\b|power[\s_-]*amp|amplifier|\bamp\b|\bpll\b|synth|lo[\s_-]*unlock|over[\s_-]*(power|drive)|output[\s_-]*power|rf[\s_-]*(fail|off|shut)|shut[\s_-]*down"),
    ("component", r"fib(er|re)|optic|remote[\s_-]*unit|\bru\b|module|temperature|over[\s_-]*temp|\bfan\b|hardware|component|door|tamper|comm(unication)?s?[\s_-]*(fail|loss|lost)"),
]
CLEAR = r"\b(clear(ed)?|normal|restored|recover(ed|y)?|resolved|ok)\b|alarm[\s_-]*off"
STD = {"1.3.6.1.6.3.1.1.5.1": "restarted (coldStart)", "1.3.6.1.6.3.1.1.5.2": "restarted (warmStart)",
       "1.3.6.1.6.3.1.1.5.3": "a network interface went down (linkDown)", "1.3.6.1.6.3.1.1.5.4": "a network interface came up (linkUp)",
       "1.3.6.1.6.3.1.1.5.5": "a request with the wrong community (authenticationFailure)"}
UPTIME_OID, TRAPOID_OID = "1.3.6.1.2.1.1.3.0", "1.3.6.1.6.3.1.1.4.1.0"

_conf = {"get": None, "set": None, "db": None, "mem": dict(DEFAULT)}
RUN = None        # the receiver while it runs
LAST_ERROR = ""   # why it isn't running, when it should be


# ---------------------------------------------------------------- BER (ITU-T X.690), only what SNMP v1 / v2c uses
class BerError(ValueError):
    pass


def _tlv(b, i):
    if i + 2 > len(b):
        raise BerError("cut short")
    tag, n = b[i], b[i + 1]
    i += 2
    if tag & 0x1F == 0x1F:
        raise BerError("multi-byte tags aren't SNMP")
    if n & 0x80:
        k = n & 0x7F
        if k == 0 or k > 4 or i + k > len(b):
            raise BerError("bad length")
        n = int.from_bytes(b[i:i + k], "big")
        i += k
    if i + n > len(b):
        raise BerError("cut short")
    return tag, b[i:i + n], i + n


def _items(b):
    out, i = [], 0
    while i < len(b):
        tag, v, i = _tlv(b, i)
        out.append((tag, v))
        if len(out) > 500:
            raise BerError("too many values")
    return out


def _int(v):
    if not v or len(v) > 9:
        raise BerError("bad integer")
    return int.from_bytes(v, "big", signed=True)


def _uint(v):
    if not v or len(v) > 9:
        raise BerError("bad number")
    return int.from_bytes(v, "big")


def _oid(v):
    if not v or v[-1] & 0x80 or len(v) > 256:
        raise BerError("bad OID")
    subs, cur = [], 0
    for c in v:
        cur = (cur << 7) | (c & 0x7F)
        if not c & 0x80:
            subs.append(cur)
            cur = 0
    x = min(subs[0] // 40, 2)
    return ".".join(str(n) for n in [x, subs[0] - 40 * x] + subs[1:])


def _text(v):
    try:
        s = v.decode("utf-8")
        if all(c.isprintable() or c in "\t\r\n" for c in s):
            return s
    except UnicodeDecodeError:
        pass
    return "0x" + v.hex()[:256]


def _value(tag, v):
    if tag == 0x02:
        return "int", _int(v)
    if tag == 0x04:
        return "str", _text(v)
    if tag == 0x05:
        return "null", None
    if tag == 0x06:
        return "oid", _oid(v)
    if tag == 0x40:
        if len(v) != 4:
            raise BerError("bad IpAddress")
        return "ip", ".".join(str(x) for x in v)
    if tag in (0x41, 0x42, 0x46):
        return "count", _uint(v)
    if tag == 0x43:
        return "ticks", _uint(v)
    if tag in (0x80, 0x81, 0x82):
        return "none", None
    return "raw", v.hex()[:256]


def _varbinds(b):
    out = []
    for tag, vb in _items(b):
        if tag != 0x30:
            raise BerError("bad varbind")
        f = _items(vb)
        if len(f) != 2 or f[0][0] != 0x06:
            raise BerError("bad varbind")
        out.append([_oid(f[0][1]), *_value(*f[1])])
    return out


def decode(packet):
    """An SNMP v1 trap, v2c trap or v2c inform -> {version, community, pdu, trap_oid, agent, uptime, varbinds
    [[oid, type, value]]}. Raises BerError for anything else (v3 included: it is not read)."""
    if len(packet) > MAX_PACKET:
        raise BerError("too large")
    tag, msg, _ = _tlv(packet, 0)
    if tag != 0x30:
        raise BerError("not an SNMP message")
    parts = _items(msg)
    if len(parts) < 3 or parts[0][0] != 0x02:
        raise BerError("not an SNMP message")
    ver = _int(parts[0][1])
    if ver == 3:
        raise BerError("SNMPv3 isn't read: set the BDA to v2c traps")
    if ver not in (0, 1) or parts[1][0] != 0x04:
        raise BerError("not SNMP v1 or v2c")
    community = parts[1][1].decode("utf-8", "replace")
    ptag, pdu = parts[2]
    f = _items(pdu)
    if ver == 0 and ptag == 0xA4:  # RFC 1157 Trap-PDU
        if len(f) != 6 or f[0][0] != 0x06 or f[1][0] != 0x40 or f[5][0] != 0x30:
            raise BerError("bad v1 trap")
        ent, gen, spec = _oid(f[0][1]), _int(f[2][1]), _int(f[3][1])
        trap_oid = f"1.3.6.1.6.3.1.1.5.{gen + 1}" if 0 <= gen <= 5 else f"{ent}.0.{spec}"  # RFC 3584 3.1
        return {"version": "v1", "community": community, "pdu": "trap", "trap_oid": trap_oid, "enterprise": ent,
                "agent": _value(0x40, f[1][1])[1], "uptime": _uint(f[4][1]), "varbinds": _varbinds(f[5][1])}
    if ver == 1 and ptag in (0xA7, 0xA6):  # RFC 3416 SNMPv2-Trap-PDU / InformRequest-PDU
        if len(f) != 4 or f[3][0] != 0x30:
            raise BerError("bad v2c trap")
        vbs = _varbinds(f[3][1])
        up = next((v[2] for v in vbs if v[0] == UPTIME_OID), None)
        trap_oid = next((v[2] for v in vbs if v[0] == TRAPOID_OID and v[1] == "oid"), None)
        if not trap_oid:
            raise BerError("v2c trap without snmpTrapOID.0")
        return {"version": "v2c", "community": community, "pdu": "inform" if ptag == 0xA6 else "trap", "trap_oid": trap_oid,
                "agent": None, "uptime": up, "varbinds": [v for v in vbs if v[0] not in (UPTIME_OID, TRAPOID_OID)]}
    raise BerError(f"not a trap (PDU 0x{ptag:02x})")


# ---------------------------------------------------------------- what a trap means
def trap_text(trap):
    """The readable words in a trap: its string values."""
    return " | ".join(str(v[2]) for v in trap.get("varbinds") or [] if v[1] == "str" and not str(v[2]).startswith("0x"))[:1000]


def classify(trap, bmap=None):
    """(signal key or None, state) for a trap. state: "alarm", "clear", "info" (a standard trap, or mapped as info),
    "ignored" or "unmapped". The BDA's own map wins (an OID -> "<signal>", "<signal>:clear", "info" or "ignore",
    matched against the trap OID and each varbind OID, longest prefix first), then the standard traps, then words."""
    oids = [trap.get("trap_oid") or ""] + [v[0] for v in trap.get("varbinds") or []]
    for pre in sorted(bmap or {}, key=len, reverse=True):
        if any(o == pre or o.startswith(pre + ".") for o in oids if o):
            sig, _, st = str(bmap[pre]).partition(":")
            if sig == "info":
                return None, "info"
            if sig == "ignore":
                return None, "ignored"
            if sig in SIG:
                return sig, "clear" if st == "clear" else "alarm"
    if trap.get("trap_oid") in STD:
        return None, "info"
    text = trap_text(trap)
    for key, rx in WORDS:
        if re.search(rx, text, re.I):
            return key, "clear" if re.search(CLEAR, text, re.I) else "alarm"
    return None, "unmapped"


def _in(addr, spec):
    spec = str(spec or "").strip()
    if not addr or not spec:
        return False
    try:
        return ipaddress.ip_address(addr) in ipaddress.ip_network(spec, strict=False)
    except ValueError:
        return addr == spec


def targets(con):
    """Every monitored BDA: [(job_id, job name, bda dict)] from the jobs' data["monitor"]["bdas"]."""
    out = []
    for r in con.execute("SELECT id, name, stage, data FROM das_job WHERE data LIKE '%\"monitor\"%'"):
        try:
            d = json.loads(r[3] or "{}")
        except ValueError:
            continue
        for b in ((d.get("monitor") or {}).get("bdas") or []):
            if isinstance(b, dict) and b.get("id"):
                out.append((r[0], r[1], b))
    return out


def match(tgts, src, agent, community):
    """The monitored BDA a trap came from: (job_id, bda, how) or (None, None, ""). The source address (or the v1 agent
    address; an address can be a range, a.b.c.0/24) and the community each count; a shared community ("public",
    "private") never matches on its own."""
    best, score = (None, None, ""), 0
    for jid, _, b in tgts:
        by_addr = _in(src, b.get("address")) or _in(agent, b.get("address"))
        com = str(b.get("community") or "")
        by_com = bool(com) and com == community and com.lower() not in ("public", "private")
        s = (2 if by_addr else 0) + (1 if by_com else 0)
        if s > score:
            how = " and ".join(x for x in ("source address" if by_addr else "", "community" if by_com else "") if x)
            best, score = (jid, b, how), s
    return best


def _now():
    return datetime.datetime.now()


def _ts(t=None):
    return (t or _now()).strftime("%Y-%m-%d %H:%M:%S")


def ensure(con):
    con.executescript(SCHEMA)


def file_trap(con, trap, src, now=None):
    """File one decoded trap: match it to a job's BDA, tag it, keep it. Returns the stored row as a dict."""
    jid, b, how = match(targets(con), src, trap.get("agent"), trap.get("community") or "")
    sig, state = classify(trap, (b or {}).get("map"))
    row = {"ts": _ts(now), "src": src, "agent": trap.get("agent"), "community": trap.get("community"), "version": trap["version"],
           "pdu": trap["pdu"], "trap_oid": trap["trap_oid"], "varbinds": json.dumps(trap["varbinds"])[:8000],
           "text": trap_text(trap), "signal": sig, "state": state, "job_id": jid, "bda": (b or {}).get("id"), "how": how}
    cur = con.execute(f"INSERT INTO bda_trap({','.join(row)}) VALUES({','.join('?' * len(row))})", list(row.values()))
    if cur.lastrowid % 100 == 0:
        prune(con)
    con.commit()
    return {**row, "id": cur.lastrowid}


def file_packet(con, data, src, now=None):
    """Decode and file one UDP datagram; None (and nothing kept) when it isn't an SNMP v1 / v2c trap."""
    try:
        trap = decode(data)
    except BerError:
        return None
    return file_trap(con, trap, src, now)


def prune(con):
    con.execute("DELETE FROM bda_trap WHERE job_id IS NULL AND id NOT IN (SELECT id FROM bda_trap WHERE job_id IS NULL "
                "ORDER BY id DESC LIMIT ?)", (KEEP_UNMATCHED,))
    for (jid,) in con.execute("SELECT job_id FROM bda_trap WHERE job_id IS NOT NULL GROUP BY job_id HAVING COUNT(*) > ?",
                              (KEEP_PER_JOB,)).fetchall():
        con.execute("DELETE FROM bda_trap WHERE job_id=? AND id NOT IN (SELECT id FROM bda_trap WHERE job_id=? ORDER BY id "
                    "DESC LIMIT ?)", (jid, jid, KEEP_PER_JOB))


def reclassify(con, job_id, bdas):
    """Tag a job's kept traps again with its BDAs' current maps (after someone maps an OID)."""
    maps = {b.get("id"): b.get("map") or {} for b in bdas or []}
    n = 0
    for r in con.execute("SELECT id, trap_oid, varbinds, bda FROM bda_trap WHERE job_id=?", (job_id,)).fetchall():
        trap = {"trap_oid": r[1], "varbinds": json.loads(r[2] or "[]")}
        sig, state = classify(trap, maps.get(r[3]))
        con.execute("UPDATE bda_trap SET signal=?, state=? WHERE id=?", (sig, state, r[0]))
        n += 1
    con.commit()
    return n


# ---------------------------------------------------------------- the receiver (only while switched on)
class Receiver:
    def __init__(self, db_path, bind, port):
        self.db_path, self.bind, self.port = db_path, bind, int(port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.sock.bind((bind, self.port))  # OSError when the port is taken or needs root: the caller says so
        except OSError:
            self.sock.close()
            raise
        self.sock.settimeout(1.0)
        self.port = self.sock.getsockname()[1]
        self.stop_ev = threading.Event()
        self.counts = {"filed": 0, "not_snmp": 0, "dropped": 0, "errors": 0}
        self.last_error, self.started = "", _ts()
        self._rate = {}
        self.thread = threading.Thread(target=self.run, name="snmpwatch", daemon=True)
        self.thread.start()

    def _allow(self, src):
        minute = int(_now().timestamp() // 60)
        m, n = self._rate.get(src, (minute, 0))
        n = n + 1 if m == minute else 1
        self._rate[src] = (minute, n)
        if len(self._rate) > 5000:
            self._rate = {k: v for k, v in self._rate.items() if v[0] == minute}
        return n <= RATE_PER_MIN

    def run(self):
        con = sqlite3.connect(self.db_path, timeout=60)
        con.row_factory = sqlite3.Row
        try:
            ensure(con)
            while not self.stop_ev.is_set():
                try:
                    data, addr = self.sock.recvfrom(65535)
                except socket.timeout:
                    continue
                except OSError:
                    break
                if not self._allow(addr[0]):
                    self.counts["dropped"] += 1
                    continue
                try:
                    r = file_packet(con, data, addr[0])
                    self.counts["filed" if r else "not_snmp"] += 1
                except (sqlite3.Error, ValueError, TypeError) as e:  # one bad trap never stops the receiver
                    self.counts["errors"] += 1
                    self.last_error = f"{type(e).__name__}: {str(e)[:200]}"
        finally:
            con.close()
            self.sock.close()

    def stop(self):
        self.stop_ev.set()
        self.thread.join(timeout=3)


def settings():
    s = (_conf["get"](SETTING, None) if _conf["get"] else _conf["mem"]) or {}
    out = dict(DEFAULT, **{k: v for k, v in s.items() if k in DEFAULT})
    out["on"] = bool(out["on"])
    return out


def save_settings(s):
    if _conf["set"]:
        _conf["set"](SETTING, s)
    else:
        _conf["mem"] = dict(s)


def apply(db_path=None):
    """Start or stop the receiver to match the setting. Returns the status."""
    global RUN, LAST_ERROR
    s, db_path = settings(), db_path or _conf["db"]
    want = s["on"] and db_path
    if RUN and (not want or (RUN.bind, RUN.port) != (s["bind"], int(s["port"]))):
        RUN.stop()
        RUN = None
    LAST_ERROR = ""
    if want and not RUN:
        try:
            RUN = Receiver(db_path, s["bind"], s["port"])
        except OSError as e:
            LAST_ERROR = f"Can't listen on UDP {s['bind']}:{s['port']}: {e.strerror or e}. Pick another port (1024 and up need no root)."
    return status()


def boot(db_path, get_setting=None, set_setting=None):
    """At start-up (app.py init): remember where things are; start the receiver only when switched on."""
    _conf.update({"db": db_path, "get": get_setting, "set": set_setting})
    con = sqlite3.connect(db_path)
    try:
        ensure(con)
    finally:
        con.close()
    if settings()["on"]:
        apply(db_path)


def status():
    s = settings()
    return {"settings": s, "running": bool(RUN), "listening": f"{RUN.bind}:{RUN.port}" if RUN else "",
            "counts": RUN.counts if RUN else {}, "since": RUN.started if RUN else "", "error": LAST_ERROR or (RUN.last_error if RUN else ""),
            "signals": SIGNALS, "ocsd": OCSD, "quiet_hours": QUIET_HOURS,
            "firewall": f"Open UDP {s['port']} on the server's firewall, from each building's address only. This copy "
                        "never opens it."}


# ---------------------------------------------------------------- per job: what each BDA said, what's open, who's quiet
def _hours_since(ts, now):
    try:
        return (now - datetime.datetime.fromisoformat(str(ts)[:19])).total_seconds() / 3600
    except ValueError:
        return None


def job_status(con, job_id, bdas, now=None, on=None):
    """[{bda..., last, quiet, open [{signal, label, section, ifc, since, text}], count}] for a job's monitored BDAs."""
    now, on = now or _now(), settings()["on"] if on is None else on
    ensure(con)
    out = []
    for b in bdas or []:
        if not isinstance(b, dict) or not b.get("id"):
            continue
        last = con.execute("SELECT MAX(ts) FROM bda_trap WHERE job_id=? AND bda=?", (job_id, b["id"])).fetchone()[0]
        n = con.execute("SELECT COUNT(*) FROM bda_trap WHERE job_id=? AND bda=?", (job_id, b["id"])).fetchone()[0]
        seen, opened = set(), []
        for r in con.execute("SELECT signal, state, ts, text, trap_oid FROM bda_trap WHERE job_id=? AND bda=? AND signal IS NOT NULL "
                             "AND state IN ('alarm','clear') ORDER BY id DESC", (job_id, b["id"])):
            if r[0] in seen:
                continue
            seen.add(r[0])
            if r[1] == "alarm":
                s = SIG.get(r[0], {})
                opened.append({"signal": r[0], "label": s.get("label", r[0]), "section": s.get("section", ""), "ifc": s.get("ifc", ""),
                               "since": r[2], "text": r[3], "trap_oid": r[4]})
        try:
            hours = float(b.get("quiet_hours") or QUIET_HOURS)
        except ValueError:
            hours = QUIET_HOURS
        since = last or b.get("added")
        h = _hours_since(since, now) if since else None
        out.append({**{k: b.get(k) for k in ("id", "name", "address", "community", "added")}, "quiet_hours": hours, "last": last,
                    "count": n, "open": opened, "quiet": bool(on and h is not None and h > hours), "hours_quiet": round(h, 1) if h is not None else None})
    return out


def recent(con, job_id, limit=40):
    ensure(con)
    return [dict(r) for r in con.execute("SELECT id, ts, src, community, version, pdu, trap_oid, text, signal, state, bda, how "
                                         "FROM bda_trap WHERE job_id=? ORDER BY id DESC LIMIT ?", (job_id, limit))]


def board(con, now=None):
    """Lines for the DAS board's Needs you: {job_id: [text]} while monitoring is on."""
    if not settings()["on"]:
        return {}
    out, by_job = {}, {}
    for jid, _, b in targets(con):
        by_job.setdefault(jid, []).append(b)
    for jid, bdas in by_job.items():
        for b in job_status(con, jid, bdas, now, True):
            for a in b["open"]:
                out.setdefault(jid, []).append(f"BDA alarm, {b['name'] or 'BDA'}: {a['label']} ({a['section']}) since {a['since'][:16]}")
            if b["quiet"]:
                out.setdefault(jid, []).append(f"{b['name'] or 'BDA'} not heard from in {int(b['quiet_hours'])} hours"
                                               + (f" (last trap {b['last'][:16]})" if b["last"] else " (no trap yet)"))
    return out


def queue_items(con, jobs, contacts, firm, acct_name, now=None):
    """Ready to send (mailqueue.py): one email to the owner per job with open alarms or a quiet BDA, while switched on."""
    if not settings()["on"]:
        return []
    import das
    import mailqueue
    now, out = now or _now(), []
    for jid, j in jobs.items():
        d = j["data"] or {}
        bdas = (d.get("monitor") or {}).get("bdas") or []
        if not bdas or j["stage"] == "Closed":
            continue
        st = job_status(con, jid, bdas, now, True)
        lines = [f"- {b['name'] or 'BDA'}: {a['label']} ({a['section']}), since {a['since'][:16]}" for b in st for a in b["open"]]
        lines += [f"- {b['name'] or 'BDA'}: not heard from in {int(b['quiet_hours'])} hours"
                  + (f" (last report {b['last'][:16]})" if b["last"] else "") for b in st if b["quiet"]]
        if not lines:
            continue
        c, _ = mailqueue._person(d, contacts, ("owner",))
        where = f"{j['name']}{', ' + d['address'] if d.get('address') else ''}"
        subject = f"Radio coverage system alarm: {j['name']}"
        hello = f"Hello{(' ' + mailqueue._first(c.get('name'))) if c and mailqueue._first(c.get('name')) else ''},"
        _, rule, _ = das.ahj_rule(d)
        imp = (rule or {}).get("impaired")
        body = (f"{hello}\n\nThe emergency responder radio coverage system at {where} reports:\n" + "\n".join(lines)
                + "\n\nThese are supervisory signals the fire code requires the system to send (NFPA 1225 18.14.1.2). "
                "Could you let us know when we can get in to check it?"
                + (f"\n\n{imp['text']} ({imp['section']})" if imp else "")
                + f"\n\nThank you,\n{mailqueue._sig(d, contacts, firm, acct_name)}")
        key = "bda:%s:%s" % (jid, hashlib.sha1("\n".join(lines).encode()).hexdigest()[:12])
        first = min([a["since"] for b in st for a in b["open"]] or [_ts(now)])[:10]
        sent = con.execute("SELECT subject FROM das_mail WHERE job_id=? AND direction='out' AND substr(ts,1,10)>=?", (jid, first)).fetchall()
        if any(mailqueue._strip_tag(r[0]) == subject for r in sent):
            continue
        out.append({"key": key, "group": "BDA alarms", "kind": "job", "refs": {"job_id": jid, "topic": "MAIL"},
                    "to": (c or {}).get("email") or "", "to_name": (c or {}).get("name") or "", "subject": subject, "body": body,
                    "job_id": jid, "why": f"{j['name']}: " + "; ".join(x[2:] for x in lines)[:300],
                    "blocked": "" if c else "No building owner with an email on this job (Overview › People)."})
    return out


# ---------------------------------------------------------------- the API (app.py das_route hands /api/das/monitor* here)
def _admin():
    try:
        import remote
        return not getattr(remote.ON, "user", None)  # the PC's own window and an admin login; a remote non-admin has a user
    except ImportError:
        return True


def handle(con, method, p, qs, body_json):
    """(status, body) for /api/das/monitor (status and settings), /api/das/monitor/board and /api/das/monitor/jobs/<id>."""
    ensure(con)
    if p == "/api/das/monitor":
        return 200, {**status(), "admin": _admin()}
    if p == "/api/das/monitor/settings" and method == "POST":
        if not _admin():
            return 403, {"error": "Monitoring is switched on and off by the admin."}
        d, s = body_json() or {}, settings()
        if "port" in d:
            try:
                port = int(d["port"])
            except (TypeError, ValueError):
                port = 0
            if not 1 <= port <= 65535:
                return 400, {"error": "A port is a number from 1 to 65535 (1024 and up need no root)."}
            s["port"] = port
        if "bind" in d:
            try:
                ipaddress.ip_address(str(d["bind"]))
            except ValueError:
                return 400, {"error": "Listen on is an IP address: 0.0.0.0 for every interface, 127.0.0.1 for this machine only."}
            s["bind"] = str(d["bind"])
        if "on" in d:
            s["on"] = bool(d["on"])
        save_settings(s)
        return 200, {**apply(), "admin": True}
    if p == "/api/das/monitor/board":
        return 200, {"on": settings()["on"], "jobs": board(con)}
    m = re.match(r"^/api/das/monitor/jobs/(\d+)(?:/(\w+))?$", p)
    if m:
        jid = int(m.group(1))
        if m.group(2) == "forget" and method == "POST":  # a job's kept traps, gone (before deleting a test job)
            if not _admin():
                return 403, {"error": "Only the admin deletes kept traps."}
            n = con.execute("DELETE FROM bda_trap WHERE job_id=?", (jid,)).rowcount
            con.commit()
            return 200, {"ok": True, "n": n}
        r = con.execute("SELECT data FROM das_job WHERE id=?", (jid,)).fetchone()
        if not r:
            return 404, {"error": f"Job {jid} was deleted. Reload to see the current jobs."}
        bdas = (json.loads(r[0] or "{}").get("monitor") or {}).get("bdas") or []
        if m.group(2) == "reclassify" and method == "POST":
            return 200, {"ok": True, "n": reclassify(con, jid, bdas)}
        if m.group(2) is None:
            return 200, {"on": settings()["on"], "running": bool(RUN), "bdas": job_status(con, jid, bdas), "recent": recent(con, jid)}
    if p == "/api/das/monitor/unmatched":  # traps no job claims: to set a new BDA's address or community from
        return 200, {"traps": [dict(x) for x in con.execute("SELECT id, ts, src, agent, community, version, trap_oid, text FROM bda_trap "
                                                             "WHERE job_id IS NULL ORDER BY id DESC LIMIT 30")] if _admin() else []}
    return 404, {"error": "No such monitoring request."}
