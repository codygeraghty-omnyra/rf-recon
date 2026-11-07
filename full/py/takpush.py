"""
Push to ATAK: RF Recon's markers go straight into ATAK, iTAK and WinTAK as Cursor-on-Target (CoT) events, over the
local network's SA multicast (239.2.3.1:6969, which TAK apps listen on out of the box) and, when one is set, to a TAK
Server (plain TCP streaming, usually port 8087). Each marker keeps the same uid, so pushing again moves and updates it
instead of adding a copy. WinTAK on this PC is opened when it's installed.

Only RF Recon's own events go out (uid RFRecon.*, one event each, size-capped, no DOCTYPE), so the server can't be used
to relay anything else. Anyone on the same network running a TAK app sees what is pushed.
"""
import glob
import os
import re
import socket
import subprocess

MULTICAST = "239.2.3.1:6969"
MAX_EVENTS = 3000
_EVENT = re.compile(r'^\s*(<\?xml[^>]*\?>\s*)?<event\s[^>]*\buid="RFRecon\.[^"<>]{1,120}"[^>]*>.*</event>\s*$', re.S)


def check(events):
    if not isinstance(events, list) or not events:
        raise ValueError("Nothing to push: search an area first.")
    if len(events) > MAX_EVENTS:
        raise ValueError(f"At most {MAX_EVENTS:,} markers a push: narrow the search or the filters.")
    out = []
    for e in events:
        if not isinstance(e, str) or len(e) > 60000 or "<!DOCTYPE" in e.upper() or e.count("<event") != 1 or not _EVENT.match(e):
            raise ValueError("That isn't an RF Recon marker; only RF Recon's own CoT events are pushed.")
        out.append(e.encode("utf-8"))
    return out


def addr(s, default_port):
    host, _, port = (s or "").strip().rpartition(":")
    if not host:
        host, port = port, default_port
    if not re.match(r"^[A-Za-z0-9.-]{1,253}$", host):
        raise ValueError(f"'{s}' isn't a host name or address.")
    return host, int(port or default_port)


def local_ipv4():
    ips = {"127.0.0.1"}  # loopback: WinTAK on this PC
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ips)


def send_multicast(events, group=MULTICAST):
    """Every event to the SA multicast group on each of this PC's networks (Wi-Fi, Ethernet, a phone tether)."""
    host, port = addr(group, 6969)
    used = []
    for ip in local_ipv4():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        try:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)  # this network only, never routed further
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(ip))
            for e in events:
                s.sendto(e, (host, port))
            used.append(ip)
        except OSError:
            pass
        finally:
            s.close()
    return used


def send_server(events, server):
    host, port = addr(server, 8087)
    with socket.create_connection((host, port), timeout=8) as s:
        s.sendall(b"".join(events))
    return f"{host}:{port}"


def wintak():
    """Open WinTAK when it's installed on this PC; returns its path, or None."""
    for pattern in (r"C:\Program Files\WinTAK*\WinTak.exe", r"C:\Program Files (x86)\WinTAK*\WinTak.exe",
                    os.path.expandvars(r"%LOCALAPPDATA%\Programs\WinTAK*\WinTak.exe")):
        for exe in glob.glob(pattern):
            subprocess.Popen([exe], close_fds=True)
            return exe
    return None


def push(events, cfg, open_wintak=True):
    data = check(events)
    out = {"sent": len(data), "via": [], "errors": []}
    if cfg.get("multicast", True):
        used = send_multicast(data, cfg.get("group") or MULTICAST)
        if used:
            out["via"].append(f"this network's TAK multicast {cfg.get('group') or MULTICAST}")
        else:
            out["errors"].append("No network to send the multicast on.")
    if cfg.get("server"):
        try:
            out["via"].append("TAK Server " + send_server(data, cfg["server"]))
        except OSError as e:
            out["errors"].append(f"TAK Server {cfg['server']}: {e}")
    out["wintak"] = wintak() if open_wintak else None
    return out
