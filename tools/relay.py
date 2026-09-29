#!/usr/bin/env python3
"""ASHEN OATH - LAN relay for the online duel (NET, role #2).

A tiny WebSocket relay (RFC 6455) on the Python standard library only: no pip, nothing
to install. Two players in one Wi-Fi network (or on a phone hotspot) connect to it by
room code; the relay just forwards text messages between the two members of a room.

Usage:  python tools/relay.py [--port 8790] [--host 0.0.0.0]
        (Windows: double-click START_ONLINE_HOST.cmd)
Then both players open the game locally (python serve_game.py -> http://127.0.0.1:8765),
choose "Онлайн-дуэль" -> "LAN" and type the IP printed below.

Protocol: ws://IP:8790/ws?room=CODE&role=host|guest&key=RANDOM
  relay -> client control messages: {"t":"_relay","ev":"hosted"|"peer_open"|"peer_close"|
                                      "no_room"|"full"|"room_taken"}
  everything else is forwarded verbatim to the other member of the room.
GET http://IP:8790/ answers "ASHEN relay OK" - handy to test the firewall from the guest.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import socket
import struct
import sys
import time
import urllib.parse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MSG = 256 * 1024
ROOM_ALPHABET = set("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")

rooms = {}   # code -> {"host": Conn|None, "guest": Conn|None, "hkey": str, "gkey": str, "t": float}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Conn:
    def __init__(self, reader, writer, room, role, key):
        self.r, self.w = reader, writer
        self.room, self.role, self.key = room, role, key
        self.closed = False
        self.lock = asyncio.Lock()
        self.last_rx = time.time()

    def stale(self):
        # игра шлёт ping каждые 0,5 с: молчит > 3 с — сокет «полуоткрыт» (ноутбук потерял Wi-Fi)
        return self.closed or time.time() - self.last_rx > 3.0

    async def send_text(self, text):
        if self.closed:
            return
        data = text.encode("utf-8")
        await self._send_frame(0x1, data)

    async def _send_frame(self, opcode, data):
        n = len(data)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
        try:
            async with self.lock:
                self.w.write(head + data)
                await self.w.drain()
        except (ConnectionError, OSError):
            self.closed = True

    async def control(self, ev, **extra):
        await self.send_text(json.dumps({"t": "_relay", "ev": ev, **extra}))

    async def close(self, code=1000):
        if self.closed:
            return
        try:
            await self._send_frame(0x8, struct.pack("!H", code))
        except Exception:
            pass
        self.closed = True
        try:
            self.w.close()
        except Exception:
            pass

    async def read_message(self):
        """Returns str for text/binary messages, None when the connection ends."""
        parts, first_op = [], None
        while True:
            try:
                h = await self.r.readexactly(2)
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                return None
            fin, op = h[0] & 0x80, h[0] & 0x0F
            masked, n = h[1] & 0x80, h[1] & 0x7F
            try:
                if n == 126:
                    n = struct.unpack("!H", await self.r.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", await self.r.readexactly(8))[0]
                if n > MAX_MSG:
                    await self.close(1009)
                    return None
                mask = await self.r.readexactly(4) if masked else b"\0\0\0\0"
                payload = bytearray(await self.r.readexactly(n))
            except (asyncio.IncompleteReadError, ConnectionError, OSError):
                return None
            if masked:
                for i in range(n):
                    payload[i] ^= mask[i & 3]
            if op == 0x8:          # close
                await self.close()
                return None
            if op == 0x9:          # ping -> pong
                await self._send_frame(0xA, bytes(payload))
                continue
            if op == 0xA:          # pong
                continue
            if op in (0x1, 0x2):
                first_op, parts = op, [bytes(payload)]
            elif op == 0x0 and first_op is not None:
                parts.append(bytes(payload))
            else:
                continue
            if fin:
                self.last_rx = time.time()
                return b"".join(parts).decode("utf-8", "replace")


def other(room, role):
    return room["guest"] if role == "host" else room["host"]


async def handshake(reader, writer):
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
    except Exception:
        return None
    lines = raw.decode("latin-1").split("\r\n")
    try:
        method, target, _ = lines[0].split(" ", 2)
    except ValueError:
        return None
    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    url = urllib.parse.urlsplit(target)
    if headers.get("upgrade", "").lower() != "websocket":
        if url.path == "/info":   # лобби хоста показывает IP для соперника
            body = json.dumps({"relay": "ASHEN", "ips": local_ips(), "port": writer.get_extra_info("sockname")[1], "rooms": len(rooms)}).encode()
            ctype = b"application/json"
        else:
            body = b"ASHEN relay OK\n"
            ctype = b"text/plain; charset=utf-8"
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: " + ctype + b"\r\n"
                     b"Access-Control-Allow-Origin: *\r\nContent-Length: " + str(len(body)).encode() +
                     b"\r\nConnection: close\r\n\r\n" + body)
        await writer.drain()
        writer.close()
        return None
    key = headers.get("sec-websocket-key", "")
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
    await writer.drain()
    q = urllib.parse.parse_qs(url.query)
    return (q.get("room", [""])[0].upper(), q.get("role", [""])[0], q.get("key", [""])[0][:40])


async def on_client(reader, writer):
    peer = writer.get_extra_info("peername")
    hs = await handshake(reader, writer)
    if not hs:
        return
    code, role, key = hs
    sock = writer.get_extra_info("socket")
    if sock is not None:
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
    c = Conn(reader, writer, code, role, key)
    if not (4 <= len(code) <= 5 and set(code) <= ROOM_ALPHABET) or role not in ("host", "guest"):
        await c.control("bad_request")
        await c.close(1008)
        return
    room = rooms.get(code)
    if role == "host":
        if room and room["host"] and not room["host"].stale() and room["hkey"] != key:
            await c.control("room_taken")
            await c.close()
            return
        if room is None:
            room = rooms[code] = {"host": None, "guest": None, "hkey": key, "gkey": "", "t": time.time()}
        old = room["host"]
        room["host"], room["hkey"] = c, key
        if old and old is not c:
            await old.close()
        await c.control("hosted", room=code)
        log("host  ", code, peer)
    else:
        if not room or not room["host"] or room["host"].closed:
            await c.control("no_room")
            await c.close()
            return
        g = room["guest"]
        if g and not g.stale() and room["gkey"] != key:
            await c.control("full")
            await c.close()
            return
        room["guest"], room["gkey"] = c, key
        if g and g is not c:
            await g.close()
        log("guest ", code, peer)
    o = other(room, role)
    if o and not o.closed:
        await o.control("peer_open")
        await c.control("peer_open")
    try:
        while True:
            msg = await c.read_message()
            if msg is None:
                break
            o = other(room, role)
            if o and not o.closed:
                await o.send_text(msg)
    finally:
        await c.close()
        if room.get(role) is c:
            room[role] = None
            o = other(room, role)
            if o and not o.closed:
                await o.control("peer_close")
        if not room["host"] and not room["guest"]:
            rooms.pop(code, None)
        log("left  ", code, role, peer)


def local_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))    # UDP connect: no packets are sent, only picks the route
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except OSError:
        pass
    return ips or ["127.0.0.1"]


async def main():
    try:
        sys.stdout.reconfigure(errors="replace")   # консоль Windows без UTF-8 не падает на кириллице
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="ASHEN OATH LAN relay")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()
    try:
        server = await asyncio.start_server(on_client, a.host, a.port)
    except OSError as e:
        print("Порт %d занят или недоступен: %s" % (a.port, e), flush=True)
        sys.exit(1)
    ips = local_ips()
    print("=" * 64)
    print(" ASHEN relay is running (онлайн-дуэль, режим LAN)")
    print(" IP этого ноутбука — продиктуйте его сопернику:")
    for ip in ips:
        print("     %s        (ws://%s:%d)" % (ip, ip, a.port))
    print(" Проверка с другого ноутбука: откройте http://%s:%d/ — должно быть «ASHEN relay OK»." % (ips[0], a.port))
    print(" Если не открывается — разрешите Python в брандмауэре (частная сеть) или раздайте")
    print(" интернет с телефона: в гостевых Wi-Fi устройства часто не видят друг друга.")
    print(" Окно не закрывайте, пока играете. Остановить: Ctrl+C.")
    print("=" * 64, flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
