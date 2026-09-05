#!/usr/bin/env python3
"""Minimal ircd that reproduces the SuperNETs JOIN rules the engine has to survive.

  1. any JOIN inside the first GRACE seconds after connect is answered with
     `421 <nick> JOIN :You must be connected for at least 5 seconds before you
     can use this command` and the channel is dropped;
  2. at most one JOIN *command* is processed per RATE seconds — extra commands
     in a burst are dropped silently, which is what made a per-channel retry
     land only the first channel on prod.

A client that survives both ends up in every channel it asked for.
"""
import socket, threading, time, sys

GRACE = 5.0
RATE = 2.0
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 16690
HOST_NAME = 'throttle.test'
joined_log = []
def client(conn, addr):
    try:
        _client(conn, addr)
    except Exception as e:
        import traceback
        print('[ircd] client thread died: %r' % (e,), flush=True)
        traceback.print_exc()

def _client(conn, addr):
    print('[ircd] connection from %s' % (addr,), flush=True)
    conn.settimeout(120)
    f = conn.makefile('rwb', buffering=0)
    def send(line):
        f.write((line + '\r\n').encode())
    t0 = time.time()
    nick = None
    registered = False
    last_join_cmd = 0.0
    while True:
        try:
            raw = f.readline()
        except Exception:
            break
        if not raw:
            break
        line = raw.decode('utf-8', 'replace').strip()
        if not line:
            continue
        parts = line.split(' ')
        cmd = parts[0].upper()
        if cmd == 'NICK':
            nick = parts[1] if len(parts) > 1 else 'x'
        elif cmd == 'USER':
            pass
        elif cmd == 'PING':
            send(':%s PONG %s :%s' % (HOST_NAME, HOST_NAME, parts[1] if len(parts) > 1 else ''))
        elif cmd == 'CAP':
            if len(parts) > 1 and parts[1].upper() == 'LS':
                send(':%s CAP * LS :' % HOST_NAME)
            elif len(parts) > 1 and parts[1].upper() == 'END':
                pass
        elif cmd == 'JOIN':
            now = time.time()
            if now - t0 < GRACE:
                send(':%s 421 %s JOIN :You must be connected for at least %d seconds '
                     'before you can use this command' % (HOST_NAME, nick, int(GRACE)))
                continue
            if now - last_join_cmd < RATE:
                # Silently dropped, exactly like the observed rate limit.
                print('[ircd] dropped burst JOIN: %s' % line, flush=True)
                continue
            last_join_cmd = now
            for chan in parts[1].split(','):
                chan = chan.strip()
                if not chan:
                    continue
                joined_log.append(chan)
                send(':%s!u@h JOIN :%s' % (nick, chan))
                send(':%s 353 %s = %s :%s' % (HOST_NAME, nick, chan, nick))
                send(':%s 366 %s %s :End of /NAMES list' % (HOST_NAME, nick, chan))
                print('[ircd] joined %s' % chan, flush=True)
        elif cmd == 'QUIT':
            break
        elif cmd == 'WHOIS':
            who = parts[1] if len(parts) > 1 else nick
            # Verbatim shapes from irc.supernets.org: the subject nick is a
            # LEADING parameter, so a trailing-only renderer loses it.
            send(':%s 311 %s %s ~%s host.example * :%s' % (HOST_NAME, nick, who, who, who))
            send(':%s 320 %s %s :is keepin it 100' % (HOST_NAME, nick, who))
            send(':%s 330 %s %s %s :is logged in as' % (HOST_NAME, nick, who, who))
            send(':%s 318 %s %s :End of /WHOIS list.' % (HOST_NAME, nick, who))
        if nick and not registered:
            registered = True
            send(':%s 001 %s :Welcome' % (HOST_NAME, nick))
            send(':%s 002 %s :Your host is hidden, running version DangerousIRCd-6.6.6' % (HOST_NAME, nick))
            send(':%s 003 %s :This server was created Fri Apr 1 1990' % (HOST_NAME, nick))
            # 004 has NO trailing at all — it used to render as a raw
            # parameter dump in the server log.
            send(':%s 004 %s %s DangerousIRCd-6.6.6 UnrealIRCd-6.1.10 diopqrstxzBDGHIRSTZ'
                 % (HOST_NAME, nick, HOST_NAME))
            send(':%s 005 %s CHANTYPES=# CHANLIMIT=#:10 TARGMAX=JOIN: :are supported' % (HOST_NAME, nick))
            # LUSERS: the count lives in a leading parameter.
            send(':%s 251 %s :There are 1000000 users and 0 invisible on 5000 servers' % (HOST_NAME, nick))
            send(':%s 252 %s 5000 :operator(s) online' % (HOST_NAME, nick))
            send(':%s 253 %s 2 :unknown connection(s)' % (HOST_NAME, nick))
            send(':%s 254 %s 1000000 :channels formed' % (HOST_NAME, nick))
            send(':%s 255 %s :I have 5000 clients and 5000 servers' % (HOST_NAME, nick))
            send(':%s 265 %s 1000000 1000000 :Current local users 1000000, max 1000000' % (HOST_NAME, nick))
            send(':%s 396 %s 5C17EEA5:5AA1AD86:1905531:IP :is now your displayed host' % (HOST_NAME, nick))
            send(':%s 376 %s :End of MOTD' % (HOST_NAME, nick))
    try:
        conn.close()
    except Exception:
        pass

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
# 0.0.0.0: inside a container Docker forwards to eth0, never to loopback.
s.bind(('0.0.0.0', PORT))
s.listen(5)
print('[ircd] listening on %d (grace=%.0fs, one JOIN command per %.0fs)' % (PORT, GRACE, RATE), flush=True)
while True:
    conn, addr = s.accept()
    threading.Thread(target=client, args=(conn, addr), daemon=True).start()
