#!/usr/bin/env python3
"""Register and configure IRC Fiber's staff channels with Anope ChanServ.

Run by the ircd role after InspIRCd and Anope are up. Idempotent: every
run re-asserts the desired state and prints one status line per channel,
so Ansible can report `changed` only when something actually moved.

The channels themselves are created by InspIRCd's `permchannels` (+P), so
they always exist even when services are down. ChanServ ownership adds
what permchannels cannot: a founder, an access list, a mode lock that is
re-applied after any manual change, and topic retention.

Mode locks are also how chat history gets switched on: `+H <lines>:<age>`
(InspIRCd's chanhistory module) replays the last messages to anyone who
joins. permchannels' own `modes=` attribute cannot be used for this on an
existing network — `permchanneldb` writes the live modes back to
/inspircd/data/permchannels.conf and that file is included *before* the
config-defined <permchannels> tags, so the saved copy always wins. The
mode lock changes the live channel, which the db then persists.

Environment:
  IRCD_HOST            host to connect to (default 127.0.0.1)
  IRCD_PORT            port (default 6697)
  IRCD_TLS             1 = TLS (default 1; the admin oper is sslonly)
  IRCD_TLS_VERIFY      1 = verify the server certificate (default 1)
  IRCD_TLS_SNI         SNI/verification hostname (default irc.ircfiber.com)
  IRCD_NICK            nick to use (default = IRCD_ACCOUNT)
  IRCD_ACCOUNT         NickServ account that owns the channels
  IRCD_ACCOUNT_PASSWORD  its password (also the /OPER password)
  IRCD_ACCOUNT_EMAIL   e-mail used if the account must be registered
  IRCD_OPER_NAME       InspIRCd <oper name=...> to /OPER as
  IRCD_OPER_PASSWORD   its password
  IRCD_CHANNELS        JSON list of
                       {"channel","description","topic","history","modes"}
  IRCD_TIMEOUT         seconds to allow for the whole run (default 180)

Exit status is 0 only when every channel reached the desired state.
"""

from __future__ import annotations

import json
import os
import re
import socket
import ssl
import sys
import time

CRLF = "\r\n"


def log(msg: str) -> None:
    print(msg, flush=True)


class IrcError(RuntimeError):
    pass


class IrcSession:
    """Blocking line-oriented IRC client, just enough to drive services."""

    def __init__(self, host: str, port: int, use_tls: bool, verify: bool,
                 sni: str, deadline: float) -> None:
        self.deadline = deadline
        self.buf = b""
        self.lines: list[str] = []
        self.nick = ""
        raw = socket.create_connection((host, port), timeout=30)
        if use_tls:
            ctx = ssl.create_default_context()
            if not verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            self.sock: socket.socket = ctx.wrap_socket(raw, server_hostname=sni)
        else:
            self.sock = raw
        self.sock.settimeout(1.0)

    def close(self) -> None:
        try:
            self.send("QUIT :channel setup done")
            time.sleep(0.3)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def send(self, line: str) -> None:
        self.sock.sendall((line + CRLF).encode("utf-8", "replace"))

    def _pump(self) -> None:
        """Read whatever is available and answer PINGs."""
        try:
            chunk = self.sock.recv(65536)
        except (TimeoutError, socket.timeout):
            return
        except ssl.SSLWantReadError:
            return
        if not chunk:
            raise IrcError("connection closed by server")
        self.buf += chunk
        while b"\n" in self.buf:
            raw, self.buf = self.buf.split(b"\n", 1)
            line = raw.decode("utf-8", "replace").rstrip("\r")
            if not line:
                continue
            if line.startswith("PING "):
                self.send("PONG " + line[5:])
                continue
            if line.startswith("ERROR"):
                raise IrcError(line)
            self.lines.append(line)

    def collect(self, seconds: float) -> list[str]:
        """Drain lines for a fixed window (used after firing a command)."""
        out_from = len(self.lines)
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._check_deadline()
            self._pump()
        return self.lines[out_from:]

    def wait_for(self, pattern: re.Pattern[str], seconds: float) -> str | None:
        start = len(self.lines)
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self._check_deadline()
            self._pump()
            for line in self.lines[start:]:
                if pattern.search(line):
                    return line
            start = len(self.lines)
        return None

    def _check_deadline(self) -> None:
        if time.monotonic() > self.deadline:
            raise IrcError("timed out")


def service_reply(session: IrcSession, service: str, command: str,
                  seconds: float = 4.0) -> list[str]:
    """PRIVMSG a service and return the NOTICE text it sends back."""
    session.send(f"PRIVMSG {service} :{command}")
    prefix = f":{service}!"
    out = []
    for line in session.collect(seconds):
        if line.lower().startswith(prefix.lower()) and " NOTICE " in line:
            text = line.split(" :", 1)[1] if " :" in line else ""
            out.append(text)
    return out


# mIRC formatting codes services wrap around nicks/channels in replies.
FORMATTING = re.compile(r"[\x02\x0f\x11\x16\x1d\x1e\x1f]|\x03(\d{1,2}(,\d{1,2})?)?")


def clean(text: str) -> str:
    return FORMATTING.sub("", text)


def matches(replies: list[str], *needles: str) -> bool:
    blob = clean(" ".join(replies)).lower()
    return any(n.lower() in blob for n in needles)


def wait_for_services(session: IrcSession, seconds: float = 120.0) -> None:
    """Block until Anope has finished bursting NickServ and ChanServ.

    The ircd is up long before services link, and after a services restart
    the uplink is retried every 30 s. WHOIS is the cheap probe: 311 means
    the pseudo-client exists, 401 means it does not yet. Grepping the
    container log instead only works right after a restart — on a host
    that has been up for days the sync line has long scrolled off.
    """
    end = time.monotonic() + seconds
    while True:
        session.send("WHOIS ChanServ")
        answer = session.wait_for(re.compile(r"\s(311|401)\s+\S+\s+ChanServ\s", re.I), 6.0)
        if answer and " 311 " in answer:
            return
        if time.monotonic() > end:
            raise IrcError("ChanServ never appeared — services are not linked")
        time.sleep(5)


def ensure_account(session: IrcSession, account: str, password: str,
                   email: str) -> None:
    """IDENTIFY when the account exists, REGISTER it when it does not."""
    # NickServ STATUS answers with a numeric code, not prose, so INFO is
    # the only reply that distinguishes "no such account" reliably.
    info = service_reply(session, "NickServ", f"INFO {account}", 4.0)
    registered = not matches(info, "isn't registered", "is not registered")

    if registered:
        reply = service_reply(session, "NickServ",
                              f"IDENTIFY {account} {password}", 6.0)
        if not matches(reply, "password accepted", "you are now identified",
                       "you are already identified"):
            raise IrcError(f"NickServ IDENTIFY for {account} failed: {reply}")
        log(f"account {account}: identified")
        return

    # ns_register enforces <nickserv:regdelay>; retry until it lapses.
    deadline = time.monotonic() + 120
    while True:
        reply = service_reply(session, "NickServ",
                              f"REGISTER {password} {email}", 6.0)
        if matches(reply, "registered under your account", "is now registered",
                   "registered.", "you are now identified"):
            log(f"account {account}: REGISTERED")
            return
        if matches(reply, "already registered"):
            reply = service_reply(session, "NickServ",
                                  f"IDENTIFY {account} {password}", 6.0)
            if not matches(reply, "password accepted",
                           "you are now identified",
                           "you are already identified"):
                raise IrcError(
                    f"NickServ IDENTIFY for {account} failed: {reply}")
            log(f"account {account}: identified")
            return
        if time.monotonic() > deadline:
            raise IrcError(f"NickServ REGISTER for {account} failed: {reply}")
        time.sleep(5)


def chan_info(session: IrcSession, channel: str) -> dict[str, str]:
    """Parse `ChanServ INFO` into {founder, mode lock, options, ...}."""
    out: dict[str, str] = {}
    replies = service_reply(session, "ChanServ", f"INFO {channel}", 4.0)
    if matches(replies, "isn't registered", "is not registered"):
        return out
    out["_registered"] = "yes"
    for line in replies:
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        out[key.strip().lower()] = value.strip()
    return out


def desired_mlock(spec: dict) -> tuple[str, str]:
    """Return (modes, params) for the channel's mode lock.

    `+P` (permanent) is part of the lock rather than left to InspIRCd's
    permchannels because permchannels only seeds channels when the module
    loads: a channel that already exists — say, because a bot joined it
    between deploys — is skipped forever and silently never becomes
    permanent. That is exactly how #support ended up as an ordinary
    channel. As a mode lock, ChanServ reasserts it on every sync.
    """
    modes = spec.get("modes") or "nt"
    params = ""
    if spec.get("permanent", True):
        modes += "P"
    history = spec.get("history") or ""
    if history:
        modes += "H"
        params = " " + history
    return modes, params


def channel_modes(session: IrcSession, channel: str) -> tuple[str, str]:
    """Live channel modes from RPL_CHANNELMODEIS, as (letters, params).

    `324 <me> #chan +ntPH 50:1w` — the mode letters carry no leading `+`
    in the return value so callers can just test membership.
    """
    session.send(f"MODE {channel}")
    line = session.wait_for(
        re.compile(rf"\s324\s+\S+\s+{re.escape(channel)}\s", re.I), 8.0)
    if not line:
        return "", ""
    tail = line.split(channel, 1)[1].strip()
    if tail.startswith(":"):
        tail = tail[1:].strip()
    parts = tail.split()
    if not parts:
        return "", ""
    letters = parts[0].lstrip("+")
    return letters, " ".join(p.lstrip(":") for p in parts[1:])


def setup_channel(session: IrcSession, spec: dict, account: str) -> bool:
    """Bring one channel to the desired state. Returns True when changed."""
    channel = spec["channel"]
    changed = False

    session.send(f"JOIN {channel}")
    topic_line = session.wait_for(
        re.compile(rf"\s(?:332|331)\s+\S+\s+{re.escape(channel)}\s", re.I), 8.0)
    current_topic = ""
    if topic_line and " 332 " in topic_line and " :" in topic_line:
        current_topic = topic_line.split(" :", 1)[1]

    info = chan_info(session, channel)
    if not info.get("_registered"):
        # cs_register requires channel operator status on an existing
        # channel; permchannels means nobody is opped on join, so take
        # ops with the oper SAMODE override first.
        session.send(f"SAMODE {channel} +o {session.nick}")
        session.collect(1.5)
        description = spec.get("description") or spec.get("topic") or channel
        reply = service_reply(session, "ChanServ",
                              f"REGISTER {channel} {description}", 6.0)
        if not matches(reply, "registered under your account"):
            raise IrcError(f"ChanServ REGISTER {channel} failed: {reply}")
        log(f"{channel}: REGISTERED to {account}")
        changed = True
        info = chan_info(session, channel)

    founder = info.get("founder", "")
    if founder and founder.lower() != account.lower():
        raise IrcError(
            f"{channel} is registered to {founder}, not {account} — "
            "refusing to take it over")

    # Mode lock, then the live channel. These are two different things and
    # only the second one actually makes history work: after a channel is
    # destroyed and recreated Anope re-applies the lock, but was observed
    # restoring only the parameterless modes — leaving a channel whose lock
    # says `+ntPH 50:1w` while the channel itself is a bare `+ntP`.
    modes, params = desired_mlock(spec)
    want_lock = f"+{modes}{params}"
    have_lock = info.get("mode lock", "")
    if have_lock.split() != want_lock.split():
        reply = service_reply(session, "ChanServ",
                              f"MODE {channel} LOCK ADD {want_lock}", 5.0)
        if matches(reply, "unknown", "invalid", "not a valid"):
            raise IrcError(f"ChanServ MODE LOCK {channel} failed: {reply}")
        log(f"{channel}: mode lock {have_lock or '(none)'} -> {want_lock}")
        changed = True

    live_modes, live_params = channel_modes(session, channel)
    missing = [m for m in modes if m not in live_modes]
    if params.strip() and params.strip() not in live_params:
        missing.append(params.strip())
    if missing:
        # Repairing this needs all three steps, in order.
        #
        # With <inspircd3:use_server_side_mlock> the ircd enforces a copy
        # of the lock that Anope pushes it, and for a mode with a
        # parameter that copy can arrive without one — which InspIRCd
        # records as "locked OFF". The channel then answers every attempt
        # to set +H with numeric 742 ("Mode cannot be changed as it has
        # been locked off by services"), including ChanServ's own, so the
        # lock and the channel disagree forever. Deleting the lock clears
        # the ircd's copy (the parameter is required here or ChanServ
        # replies "Missing parameter for mode H"), SAMODE then applies the
        # modes as an oper, and re-adding restores enforcement.
        service_reply(session, "ChanServ",
                      f"MODE {channel} LOCK DEL {want_lock}", 4.0)
        session.send(f"SAMODE {channel} +{modes}{params}")
        session.collect(1.5)
        service_reply(session, "ChanServ",
                      f"MODE {channel} LOCK ADD {want_lock}", 4.0)
        live_modes, live_params = channel_modes(session, channel)
        still = [m for m in modes if m not in live_modes]
        if params.strip() and params.strip() not in live_params:
            still.append(params.strip())
        if still:
            raise IrcError(
                f"{channel} is +{live_modes} {live_params}, still missing "
                f"{''.join(still)} after relocking {want_lock}")
        log(f"{channel}: channel modes -> +{live_modes} {live_params}".rstrip())
        changed = True

    # Channel options: (command, name Anope prints in INFO's `Options:`
    # line, whether it should be on, phrase ChanServ confirms with). All
    # three parts vary per option — KEEPTOPIC shows up as "Topic
    # retention", cs_secure as "Security", and NOEXPIRE answers "will not
    # expire" rather than "is now on" — and matching the INFO name is what
    # keeps the run idempotent instead of re-setting on every deploy.
    #
    # SECURE is turned off rather than merely left out of the chanserv
    # module's `defaults`: that directive only applies to channels at
    # registration time, so it would never reach one already registered.
    options = info.get("options", "").lower()
    wanted = [
        ("KEEPTOPIC", "topic retention", True, "is now on"),
        ("SECUREOPS", "secure ops", True, "is now on"),
        ("NOEXPIRE", "no expire", True, "will not expire"),
        ("SECURE", "security", False, "is now off"),
    ]
    for command, needle, want_on, confirmation in wanted:
        if (needle in options) == want_on:
            continue
        value = "ON" if want_on else "OFF"
        # Anope's grammar is `SET <option> <channel> <value>`. With the
        # channel first ChanServ answers "Syntax: SET option channel
        # parameters" and changes nothing — so anything but the explicit
        # confirmation has to be treated as a failure.
        reply = service_reply(session, "ChanServ",
                              f"SET {command} {channel} {value}", 4.0)
        if not matches(reply, confirmation):
            raise IrcError(
                f"ChanServ SET {command} {channel} {value} failed: {reply}")
        log(f"{channel}: {command} {value}")
        changed = True

    topic = spec.get("topic") or ""
    if topic and topic != current_topic:
        service_reply(session, "ChanServ", f"TOPIC {channel} {topic}", 4.0)
        log(f"{channel}: topic updated")
        changed = True

    session.send(f"PART {channel} :setup complete")
    session.collect(0.5)
    return changed


def main() -> int:
    host = os.environ.get("IRCD_HOST", "127.0.0.1")
    port = int(os.environ.get("IRCD_PORT", "6697"))
    use_tls = os.environ.get("IRCD_TLS", "1") == "1"
    verify = os.environ.get("IRCD_TLS_VERIFY", "1") == "1"
    sni = os.environ.get("IRCD_TLS_SNI", "irc.ircfiber.com")
    account = os.environ["IRCD_ACCOUNT"]
    nick = os.environ.get("IRCD_NICK") or account
    password = os.environ["IRCD_ACCOUNT_PASSWORD"]
    email = os.environ.get("IRCD_ACCOUNT_EMAIL", f"{account}@{sni}")
    oper_name = os.environ["IRCD_OPER_NAME"]
    oper_password = os.environ["IRCD_OPER_PASSWORD"]
    channels = json.loads(os.environ["IRCD_CHANNELS"])
    deadline = time.monotonic() + float(os.environ.get("IRCD_TIMEOUT", "180"))

    session = IrcSession(host, port, use_tls, verify, sni, deadline)
    changed = False
    try:
        session.nick = nick
        session.send(f"NICK {nick}")
        session.send(f"USER {account} 0 * :IRC Fiber channel setup")
        welcome = session.wait_for(re.compile(r"\s001\s"), 45.0)
        if not welcome:
            raise IrcError("no RPL_WELCOME from the server")

        wait_for_services(session)

        ensure_account(session, account, password, email)

        session.send(f"OPER {oper_name} {oper_password}")
        opered = session.wait_for(re.compile(r"\s(381|491|464)\s"), 10.0)
        if not opered or " 381 " not in opered:
            raise IrcError(f"OPER {oper_name} failed: {opered}")
        log(f"opered as {oper_name}")

        for spec in channels:
            if setup_channel(session, spec, account):
                changed = True
            else:
                log(f"{spec['channel']}: already configured")

        if changed:
            # db_flatfile only writes on <options:updatetimeout> (5m) or a
            # clean shutdown, so everything above lives in Anope's memory
            # until then. A container restart inside that window silently
            # reverts the whole run — force the write instead of hoping.
            reply = service_reply(session, "OperServ", "UPDATE", 6.0)
            if not matches(reply, "updating databases", "databases updated"):
                raise IrcError(f"OperServ UPDATE failed: {reply}")
            log("databases flushed to disk")
    except (IrcError, OSError) as exc:
        log(f"FAILED: {exc}")
        session.close()
        return 1

    session.close()
    log("CHANGED" if changed else "UNCHANGED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
