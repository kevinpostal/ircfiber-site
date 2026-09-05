#!/usr/bin/env python3
"""Minimal SOCKS5 CONNECT proxy — local egress slot fixture.

Stands in for a Mullvad tailscale sidecar's SOCKS5 port so the engine's
slot/retarget/lock path can be exercised without a tailnet or a Mullvad
device license (the location side is faked by `tailscale-shim` next to
this file). Verification fixture only — nothing in production uses it.

Usage: socks5.py <port> [tag]
"""
import selectors
import socket
import sys
import threading

PORT = int(sys.argv[1])
TAG = sys.argv[2] if len(sys.argv) > 2 else "slot"


def pump(a, b):
    sel = selectors.DefaultSelector()
    sel.register(a, selectors.EVENT_READ, b)
    sel.register(b, selectors.EVENT_READ, a)
    try:
        while True:
            for key, _ in sel.select(timeout=300):
                data = key.fileobj.recv(65536)
                if not data:
                    return
                key.data.sendall(data)
    except OSError:
        return
    finally:
        for s in (a, b):
            try:
                s.close()
            except OSError:
                pass


def handle(conn):
    try:
        greet = conn.recv(262)
        if not greet or greet[0] != 5:
            conn.close()
            return
        conn.sendall(b"\x05\x00")  # no auth
        hdr = conn.recv(4)
        if len(hdr) < 4 or hdr[1] != 1:  # CONNECT only
            conn.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            conn.close()
            return
        atyp = hdr[3]
        if atyp == 1:
            host = socket.inet_ntoa(conn.recv(4))
        elif atyp == 3:
            n = conn.recv(1)[0]
            host = conn.recv(n).decode()
        elif atyp == 4:
            host = socket.inet_ntop(socket.AF_INET6, conn.recv(16))
        else:
            conn.sendall(b"\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00")
            conn.close()
            return
        port = int.from_bytes(conn.recv(2), "big")
        print(f"[{TAG}] CONNECT {host}:{port}", flush=True)
        try:
            remote = socket.create_connection((host, port), timeout=10)
        except OSError as e:
            print(f"[{TAG}] FAIL {host}:{port} {e}", flush=True)
            conn.sendall(b"\x05\x05\x00\x01\x00\x00\x00\x00\x00\x00")
            conn.close()
            return
        conn.sendall(b"\x05\x00\x00\x01" + socket.inet_aton("0.0.0.0") + (0).to_bytes(2, "big"))
        pump(conn, remote)
    except Exception as e:  # noqa: BLE001 - fixture, never crash the listener
        print(f"[{TAG}] error {e}", flush=True)
        try:
            conn.close()
        except OSError:
            pass


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", PORT))
srv.listen(64)
print(f"[{TAG}] socks5 ready on :{PORT}", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
