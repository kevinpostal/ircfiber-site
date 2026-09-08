#!/usr/bin/env bash
# verify-motd.sh — prove an admin save/pin is what the ircd actually serves.
#
# Chain under test (runs ON the VPS, needs docker + python3):
#   admin save/pin -> Redis (motdPinned / motdCurrent / motdTemplates mirror)
#                  -> /etc/ircfiber/ircd/motd.d/motd (+ REHASH)
#                  -> live 372 numerics on irc.ircfiber.com:6697
#
# Note what this does NOT check: the IRC Fiber web client does not read the
# ircd file — the engine serves a random enabled template per connect (or
# the pinned one while a pin is set). Use the pin when you need the web
# client and native clients to agree.
#
# Usage: ssh root@<vps> 'bash -s' < site/scripts/verify-motd.sh
set -u
REDIS=ircfiber-redis
MOTD_FILE=/etc/ircfiber/ircd/motd.d/motd
IRCD_HOST=irc.ircfiber.com
IRCD_PORT=6697
VERBOSE=${VERBOSE:-0}

fail=0
say() { printf '%s\n' "$*"; }
die() { say "FAIL: $*"; exit 1; }

command -v docker >/dev/null || die "docker not found (run on the VPS)"
command -v python3 >/dev/null || die "python3 not found"
[ -f "$MOTD_FILE" ] || die "ircd MOTD file missing: $MOTD_FILE"

PINNED=$(docker exec "$REDIS" redis-cli --raw get irc:config:motdPinned 2>/dev/null || true)
CURRENT_JSON=$(docker exec "$REDIS" redis-cli --raw get irc:config:motdCurrent 2>/dev/null || true)
MIRROR_JSON=$(docker exec "$REDIS" redis-cli --raw get irc:config:motdTemplates 2>/dev/null || true)
[ -n "$MIRROR_JSON" ] || die "Redis mirror irc:config:motdTemplates is empty (save once from admin first)"

export PINNED CURRENT_JSON MIRROR_JSON MOTD_FILE IRCD_HOST IRCD_PORT VERBOSE
python3 - <<'EOF'
import json, os, socket, ssl, sys, time

def lines(s):
    # Content lines: trailing whitespace per line is insignificant, and
    # blank edges are too (the template may start/end with one; InspIRCd
    # frames the MOTD with empty 372s on the wire).
    ls = [l.rstrip() for l in s.replace('\r', '').split('\n')]
    while ls and ls[0] == '': ls.pop(0)
    while ls and ls[-1] == '': ls.pop()
    return ls

fails = []
def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), '-', name, detail)
    if not ok:
        fails.append(name)

try:
    mirror = json.loads(os.environ['MIRROR_JSON'])
except Exception as e:
    print('FAIL - Redis mirror is not valid JSON', e); sys.exit(1)
by_id = {t.get('id'): t for t in mirror if t.get('id')}
pinned = (os.environ.get('PINNED') or '').strip()
try:
    cur = json.loads(os.environ.get('CURRENT_JSON') or 'null')
except Exception:
    cur = None
cur_id = cur.get('id') if isinstance(cur, dict) else None

print(f'mirror: {len(mirror)} enabled template(s); pinned={pinned or "(none)"}; '
      f'ircd current={cur.get("name") if isinstance(cur, dict) else None}')

expected_id = pinned or cur_id
expected = by_id.get(expected_id) if expected_id else None
if expected_id and not expected:
    check('expected template is in the mirror', False, f'id={expected_id}')
    expected_lines = None
else:
    check('expected template is in the mirror', True, (expected or {}).get('name', '(none — nothing rotated yet)'))
    expected_lines = lines(expected['body']) if expected else None

with open(os.environ['MOTD_FILE'], encoding='utf-8', errors='replace') as f:
    file_lines = lines(f.read())
print(f'ircd file: {len(file_lines)} line(s)')

# Live MOTD straight from the ircd (bypasses the engine entirely).
nick = f'motdchk{os.getpid() % 10000:04d}'
served = None
try:
    raw = socket.create_connection((os.environ['IRCD_HOST'], int(os.environ['IRCD_PORT'])), timeout=15)
    s = ssl.create_default_context().wrap_socket(raw, server_hostname=os.environ['IRCD_HOST'])
    s.settimeout(20)
    s.sendall(f'NICK {nick}\r\nUSER {nick} 0 * :motd verify\r\n'.encode())
    buf, got375, done, t0 = '', False, False, time.time()
    while time.time() - t0 < 25 and not done:
        try:
            chunk = s.recv(65536).decode('utf-8', 'replace')
        except socket.timeout:
            break
        if not chunk:
            break
        buf += chunk
        while '\n' in buf:
            line, buf = buf.split('\n', 1)
            line = line.rstrip('\r')
            if ' 375 ' in line:
                got375 = True
                served = []
            elif ' 372 ' in line and got375:
                rest = line.split(' 372 ', 1)[1]
                served.append(rest.split(' :', 1)[1] if ' :' in rest else '')
            elif ' 376 ' in line or ' 422 ' in line:
                done = True
                break
    try:
        s.sendall(b'QUIT :verify done\r\n')
    except OSError:
        pass
    s.close()
except Exception as e:
    check('ircd connection', False, str(e))
    served = None

if served is None:
    check('ircd served a MOTD', False)
else:
    # InspIRCd frames the file content with empty 372s; compare content.
    served = lines('\n'.join(served))
    print(f'ircd served: {len(served)} 372 content line(s)')
    check('ircd served a MOTD', True)
    if expected_lines is not None:
        if served == expected_lines:
            check(f"ircd serves admin's {'pinned' if pinned else 'current'} template", True,
                  (expected or {}).get('name', ''))
        else:
            i = next((i for i, (a, b) in enumerate(zip(served, expected_lines)) if a != b),
                     min(len(served), len(expected_lines)))
            detail = f'line {i}: served={served[i:i+1]!r} expected={expected_lines[i:i+1]!r}'
            check(f"ircd serves admin's {'pinned' if pinned else 'current'} template", False, detail)
    # File vs wire must always agree (same rehash generation).
    if served == file_lines:
        check('ircd file matches served 372s', True)
    else:
        check('ircd file matches served 372s', False, 'file changed without REHASH?')
if os.environ.get('VERBOSE') == '1':
    print('--- file lines ---')
    print('\n'.join(f'{i}:{l}' for i, l in enumerate(file_lines)))
    print('--- served lines ---')
    print('\n'.join(f'{i}:{l}' for i, l in enumerate(served or [])))
    print('--- expected lines ---')
    print('\n'.join(f'{i}:{l}' for i, l in enumerate(expected_lines or [])))

sys.exit(1 if fails else 0)
EOF
rc=$?
[ $rc -eq 0 ] && say "verify-motd: ALL CHECKS PASSED" || { say "verify-motd: FAILURES PRESENT"; exit 1; }
