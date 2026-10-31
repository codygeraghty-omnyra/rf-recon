"""
Ships (AIS, live) from aisstream.io: a WebSocket stream of AIS position and static reports for a box on the map.
The key stays on this PC (aisstream allows server-side use only). The stream runs only while the map's Ships layer is
asking for it, and stops by itself a few minutes after the last ask, so a phone tether isn't left streaming.
Standard library only: a minimal WebSocket client (TLS, masked client frames, ping / pong, fragments).
"""
import base64
import json
import os
import socket
import ssl
import struct
import threading
import time

URL_HOST, URL_PATH = "stream.aisstream.io", "/v0/stream"
IDLE_STOP_S = 180       # no map has asked for ships this long: disconnect
KEEP_S = 30 * 60        # ships not heard from in this long drop off
STATE = {"box": None, "ships": {}, "status": "off", "error": None, "since": None, "last_ask": 0.0, "messages": 0, "thread": None}
LOCK = threading.Lock()


class WebSocket:
    def __init__(self, host, path, timeout=20):
        raw = socket.create_connection((host, 443), timeout=timeout)
        self.s = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: RF-Recon/2.0\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.s.recv(4096)
            if not chunk:
                raise ConnectionError("aisstream closed the connection during the handshake")
            head += chunk
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise ConnectionError(f"aisstream refused the stream: {status.decode('latin-1')}")
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("aisstream closed the stream")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, payload):
        head = bytes([0x80 | opcode])
        n = len(payload)
        head += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x80 | 127]) + struct.pack(">Q", n))
        mask = os.urandom(4)  # a client's frames are always masked
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send_text(self, text):
        self._send(0x1, text.encode("utf-8"))

    def recv(self):
        """The next text or binary message (pings answered, fragments joined)."""
        parts = []
        while True:
            b1, b2 = self._read(2)
            fin, op, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x9:
                self._send(0xA, data)
                continue
            if op == 0x8:
                raise ConnectionError("aisstream ended the stream")
            if op in (0x1, 0x2, 0x0):
                parts.append(data)
                if fin:
                    return b"".join(parts)

    def close(self):
        try:
            self._send(0x8, b"")
            self.s.close()
        except OSError:
            pass


def _apply(msg):
    meta, body = msg.get("MetaData") or {}, msg.get("Message") or {}
    mmsi = meta.get("MMSI")
    if not mmsi:
        return
    with LOCK:
        sh = STATE["ships"].setdefault(mmsi, {"mmsi": mmsi})
        sh["name"] = (meta.get("ShipName") or sh.get("name") or "").strip()
        if meta.get("latitude") is not None:
            sh["lat"], sh["lon"] = meta["latitude"], meta["longitude"]
        sh["seen"] = time.time()
        sh["time_utc"] = meta.get("time_utc")
        kind = msg.get("MessageType")
        rep = body.get(kind) or {}
        if kind in ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"):
            sh.update(sog=rep.get("Sog"), cog=rep.get("Cog"), heading=rep.get("TrueHeading"), nav=rep.get("NavigationalStatus"),
                      cls="B" if "ClassB" in kind else "A")
        elif kind == "ShipStaticData":
            dim = rep.get("Dimension") or {}
            sh.update(callsign=(rep.get("CallSign") or "").strip(), type=rep.get("Type"), destination=(rep.get("Destination") or "").strip(),
                      imo=rep.get("ImoNumber"), length_m=(dim.get("A") or 0) + (dim.get("B") or 0) or None)
        STATE["messages"] += 1


def _run(key):
    backoff = 2
    while True:
        with LOCK:
            box, idle = STATE["box"], time.time() - STATE["last_ask"] > IDLE_STOP_S
        if idle or not box:
            with LOCK:
                STATE.update(status="off", thread=None)
            return
        ws = None
        try:
            ws = WebSocket(URL_HOST, URL_PATH)
            sent_box = box
            ws.send_text(json.dumps({"APIKey": key, "BoundingBoxes": [[[box[0], box[2]], [box[1], box[3]]]],
                                     "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]}))
            with LOCK:
                STATE.update(status="streaming", error=None, since=time.strftime("%H:%M:%S"))
            backoff = 2
            ws.s.settimeout(30)
            while True:
                try:
                    data = ws.recv()
                    m = json.loads(data)
                    if isinstance(m, dict) and m.get("error"):
                        raise ConnectionError(str(m["error"]))
                    _apply(m)
                except socket.timeout:
                    pass
                with LOCK:
                    box, idle = STATE["box"], time.time() - STATE["last_ask"] > IDLE_STOP_S
                if idle:
                    break
                if box != sent_box:  # the map moved: change the subscription on the same connection
                    ws.send_text(json.dumps({"APIKey": key, "BoundingBoxes": [[[box[0], box[2]], [box[1], box[3]]]],
                                             "FilterMessageTypes": ["PositionReport", "StandardClassBPositionReport", "ShipStaticData"]}))
                    sent_box = box
        except (OSError, ConnectionError, ValueError) as e:
            with LOCK:
                STATE.update(status="reconnecting", error=str(e)[:200])
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        finally:
            if ws:
                ws.close()


def known(s, n, w, e):
    """The ships already streamed into a box, without starting or moving the stream (remote viewers)."""
    now = time.time()
    with LOCK:
        out = [dict(v, age_s=int(now - v["seen"])) for v in STATE["ships"].values()
               if v.get("lat") is not None and now - v.get("seen", 0) <= KEEP_S and s <= v["lat"] <= n and w <= v["lon"] <= e]
        return {"ships": out, "status": STATE["status"] if STATE["thread"] else "idle", "error": None, "since": STATE["since"],
                "messages": STATE["messages"], "note": "Ships show here while Cody's RF Recon is streaming this area."}


def ships(s, n, w, e, key):
    """Ask for the ships in a box: (re)starts or retargets the stream, returns what is known there."""
    if not key:
        return {"ships": [], "status": "no key", "error": "Add your aisstream key (Data & updates, Your API keys)."}
    pad_lat, pad_lon = (n - s) * 0.25, (e - w) * 0.25
    want = (round(s - pad_lat, 3), round(n + pad_lat, 3), round(w - pad_lon, 3), round(e + pad_lon, 3))
    now = time.time()
    with LOCK:
        STATE["last_ask"] = now
        box = STATE["box"]
        if not box or s < box[0] or n > box[1] or w < box[2] or e > box[3]:
            STATE["box"] = want
        for k in [k for k, v in STATE["ships"].items() if now - v.get("seen", 0) > KEEP_S]:
            del STATE["ships"][k]
        out = [dict(v, age_s=int(now - v["seen"])) for v in STATE["ships"].values()
               if v.get("lat") is not None and s <= v["lat"] <= n and w <= v["lon"] <= e]
        start = STATE["thread"] is None
        if start:
            STATE.update(status="connecting", thread=threading.Thread(target=_run, args=(key,), daemon=True))
            STATE["thread"].start()
        return {"ships": out, "status": STATE["status"], "error": STATE["error"], "since": STATE["since"], "messages": STATE["messages"]}
