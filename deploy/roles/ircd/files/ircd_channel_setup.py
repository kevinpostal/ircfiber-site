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

A channel marked {"bot": true} additionally gets the network's own
BotServ bot (IRCD_SERVICES_BOT, "FiberServ" in the role defaults) sitting
in it with fantasy commands on — the same ChanServ machinery reached as
`op nick in the channel instead of /msg ChanServ OP #chan nick. BotServ's
`defaults = "greet fantasy"` only applies to channels at registration
time, so fantasy is asserted here for the staff channels, which were
registered before any bot existed.

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
  IRCD_ACCOUNT_DISPLAY  NickServ group display to converge on
                       (default = IRCD_ACCOUNT)
  IRCD_OPER_NAME       InspIRCd <oper name=...> to /OPER as
  IRCD_OPER_PASSWORD   its password
  IRCD_CHANNELS        JSON list of
                       {"channel","description","topic","history","modes"}
  IRCD_CHANNEL_ACCESS  JSON {"qop":[..],"sop":[..],"aop":[..],
                       "hop":[..],"vop":[..]} of NickServ accounts
  IRCD_CHANNEL_AUTOVOICE  JSON ["v:account:*", ...] autoop (+w) entries to
                       keep on the channel
  IRCD_SERVICES_BOT    JSON {"nick","ident","host","realname"} for the
                       BotServ bot assigned to channels marked
                       {"bot": true}; {} or unset creates no bot
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


# XOP tiers, highest first. Each name is both the ChanServ command that
# grants it and the level string `ACCESS LIST` prints back: QOP +q
# (owner), SOP +a (admin), AOP +o, HOP +h, VOP +v.
XOP_TIERS = ("QOP", "SOP", "AOP", "HOP", "VOP")


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


def account_registered(session: IrcSession, account: str) -> bool:
    """True when NickServ knows the account.

    NickServ STATUS answers with a numeric code, not prose, so INFO is
    the only reply that distinguishes "no such account" reliably.
    """
    reply = service_reply(session, "NickServ", f"INFO {account}", 4.0)
    return not matches(reply, "isn't registered", "is not registered")


def ensure_account(session: IrcSession, account: str, password: str,
                   email: str) -> None:
    """IDENTIFY when the account exists, REGISTER it when it does not."""
    if account_registered(session, account):
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


def require_accounts(session: IrcSession, access: dict) -> None:
    """Fail the run when any account in the access list is unregistered.

    ChanServ answers an ADD for an unknown account with "isn't
    registered", which would surface halfway through the channel loop and
    leave some channels synced and some not. One INFO per distinct name
    up front turns a typo in ircd_channel_access into an immediate error
    that lists every bad name at once.
    """
    names: list[str] = []
    seen: set[str] = set()
    for tier in XOP_TIERS:
        for name in access.get(tier.lower()) or []:
            if name.lower() in seen:
                continue
            seen.add(name.lower())
            names.append(name)
    missing = [n for n in names if not account_registered(session, n)]
    if missing:
        raise IrcError("not registered with NickServ, cannot be given "
                       f"channel access: {', '.join(missing)}")


def group_and_display(session: IrcSession, account: str, display: str,
                      password: str) -> bool:
    """Converge the account's NickServ group display. True when changed.

    The display is what ChanServ INFO prints as Founder and what Anope
    resolves its oper{} blocks against, so this is what makes the network
    read as owned by a person instead of by "admin". Grouping a nick
    requires *being* it, which the deploy usually cannot do because the
    human is connected under that nick — that case defers to the next run
    rather than failing, since nothing else depends on it.
    """
    if not display or display.lower() == account.lower():
        return False

    # `GLIST <nick>` headers its list with the group's *current* display
    # (`List of nicknames in the group of <display>:`) and then prints one
    # nick per row. The bare `GLIST` answers "List of nicknames in your
    # group:" instead, naming nothing — which would make every run re-set
    # the display and report `changed` forever. Passing an alias of our
    # own account needs no privilege (Anope only checks nickserv/list when
    # the nick belongs to someone else).
    current = ""
    grouped = False
    for line in service_reply(session, "NickServ", f"GLIST {account}", 4.0):
        text = clean(line).strip()
        header = re.search(r"group of (\S+?):?$", text, re.I)
        if header:
            current = header.group(1)
            continue
        tokens = text.split()
        if tokens and tokens[0].lower() == display.lower():
            grouped = True
    if not current:
        raise IrcError(f"NickServ GLIST {account} named no group display: "
                       "cannot tell whether the rename is needed")
    if current.lower() == display.lower():
        return False

    if not grouped:
        original = session.nick
        session.send(f"NICK {display}")
        answer = session.wait_for(
            re.compile(rf"\s433\s+\S+\s+{re.escape(display)}\s"
                       rf"|^:{re.escape(original)}!\S+\sNICK\s", re.I), 6.0)
        if answer is None:
            raise IrcError(f"no reply to NICK {display} from the server")
        if " 433 " in answer:
            log(f"display {account} -> {display} deferred: the nick is in "
                f"use. From the client holding it run `/msg NickServ GROUP "
                f"{account} <password>` then `/msg NickServ SET DISPLAY "
                f"{display}`; otherwise the next deploy retries")
            return False
        session.nick = display
        reply = service_reply(session, "NickServ",
                              f"GROUP {account} {password}", 6.0)
        if not matches(reply, "you are now in the group of",
                       "you are already a member of the group of"):
            raise IrcError(f"NickServ GROUP {account} failed: {reply}")
        set_display(session, display)
        # session.nick is what setup_channel puts in its SAMODE line, so
        # the rename has to be undone; identification survives it.
        session.send(f"NICK {original}")
        session.nick = original
        session.collect(0.5)
    else:
        set_display(session, display)
    log(f"display {account} -> {display}")
    return True


def set_display(session: IrcSession, display: str) -> None:
    reply = service_reply(session, "NickServ", f"SET DISPLAY {display}", 4.0)
    if not matches(reply, "the new display is now"):
        raise IrcError(f"NickServ SET DISPLAY {display} failed: {reply}")


def info_fields(replies: list[str]) -> dict[str, str]:
    """An Anope `INFO` reply as {lower-cased label: value}.

    Every service prints INFO through the same InfoFormatter — one
    `Label: value` NOTICE per field — so this reads ChanServ's Founder /
    Mode lock / Options and BotServ's Bot nick / Options alike.
    """
    out: dict[str, str] = {}
    for line in replies:
        text = clean(line)
        if ":" not in text:
            continue
        key, _, value = text.partition(":")
        out[key.strip().lower()] = value.strip()
    return out


def chan_info(session: IrcSession, channel: str) -> dict[str, str]:
    """Parse `ChanServ INFO` into {founder, mode lock, options, ...}."""
    replies = service_reply(session, "ChanServ", f"INFO {channel}", 4.0)
    if matches(replies, "isn't registered", "is not registered"):
        return {}
    out = info_fields(replies)
    out["_registered"] = "yes"
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


def access_list(session: IrcSession, channel: str) -> dict[str, str]:
    """{lower-cased mask: level} from `ChanServ ACCESS {channel} LIST`.

    Parsed by shape rather than by prose: Anope's ListFormatter prints
    `Number | Level | Mask | By | Last seen`, where Level is the xop tier
    (SOP, AOP, ...) for an xop entry and a bare number for a cs_access
    one. Keeping only rows whose first column is a number skips the
    header, the "list is empty" line and any trailing prose without
    depending on translated text.
    """
    out: dict[str, str] = {}
    replies = service_reply(session, "ChanServ", f"ACCESS {channel} LIST", 5.0)
    for line in replies:
        tokens = clean(line).split()
        if len(tokens) < 3 or not tokens[0].isdigit():
            continue
        out[tokens[2].lower()] = tokens[1].upper()
    return out


def sync_access(session: IrcSession, channel: str, access: dict) -> bool:
    """Put every listed account on its tier. Returns True when changed.

    One ADD also *moves* an account between tiers — cs_xop drops any
    existing entry for the same resolved mask before inserting — so no
    DEL step is needed. Additive on purpose: entries nobody listed
    (hand-granted ops, hostmask entries) are left alone.
    """
    changed = False
    current = access_list(session, channel)
    for tier in XOP_TIERS:
        for name in access.get(tier.lower()) or []:
            if current.get(name.lower()) == tier:
                continue
            reply = service_reply(session, "ChanServ",
                                  f"{tier} {channel} ADD {name}", 4.0)
            if not matches(reply, "added to"):
                raise IrcError(
                    f"ChanServ {tier} {channel} ADD {name} failed: {reply}")
            log(f"{channel}: {tier} += {name}")
            changed = True
    return changed


def autovoice_list(session: IrcSession, channel: str) -> set[str]:
    """Live +w (autoop) entries on the channel.

    InspIRCd answers `MODE #chan w` with one `910 <me> <chan> <entry>
    <setter> :<ts>` per entry plus a trailing 911. Parsed positionally —
    entry is the token after the channel — so no prose matching.
    """
    out: set[str] = set()
    session.send(f"MODE {channel} w")
    for line in session.collect(2.0):
        tokens = clean(line).split()
        if (len(tokens) >= 6 and tokens[1] == "910"
                and tokens[3].lower() == channel.lower()):
            out.add(tokens[4])
    return out


def sync_autovoice(session: IrcSession, channel: str,
                   entries: list) -> bool:
    """Keep every wanted +w entry on the channel. True when changed.

    `v:account:*` voices any NickServ-identified user on join and nobody
    else (proved on a throwaway channel: identified got `+v`, stranger got
    nothing). Applied with SAMODE — the script is opered but not opped in
    the channel, same reason the mode-lock repair uses SAMODE — and verified
    by re-listing, because SAMODE answers nothing on success. Additive:
    entries nobody listed (a hand-added `o:` grant) are left alone.
    """
    changed = False
    current = autovoice_list(session, channel)
    for entry in entries or []:
        if entry in current:
            continue
        session.send(f"SAMODE {channel} +w {entry}")
        session.collect(1.5)
        if entry not in autovoice_list(session, channel):
            raise IrcError(
                f"SAMODE {channel} +w {entry} did not stick")
        log(f"{channel}: +w += {entry}")
        changed = True
    return changed


def ensure_services_bot(session: IrcSession, bot: dict) -> bool:
    """Create the network's BotServ bot, or converge its mask. True when
    changed.

    `BOT ADD` is the only way a bot comes into existence — loading the
    botserv module creates none — and Anope Q-lines the nick as it does
    so. When the bot is already there, `BOT CHANGE` to the *same* nick
    lets Anope do the comparison: it answers "the old information is the
    same" when nothing moved, so an ident/host/realname edit converges
    without this script having to parse (and translate) `BOT INFO`.
    Keeping the nick keeps the Q-line and every channel assignment.

    Refuses rather than works around a nick that a NickServ account or a
    live user already holds: Anope answers "already registered" / "is
    currently in use", and both mean the deploy's idea of the bot's
    identity is wrong.
    """
    nick = bot["nick"]
    ident = bot.get("ident") or "services"
    host = bot.get("host") or "services.host"
    real = bot.get("realname") or nick
    reply = service_reply(session, "BotServ",
                          f"BOT ADD {nick} {ident} {host} {real}", 5.0)
    if matches(reply, "added to the bot list"):
        log(f"BotServ: created {nick}!{ident}@{host} ({real})")
        return True
    if not matches(reply, "already exists"):
        raise IrcError(f"BotServ BOT ADD {nick} failed: {reply}")
    reply = service_reply(
        session, "BotServ",
        f"BOT CHANGE {nick} {nick} {ident} {host} {real}", 5.0)
    if matches(reply, "same as the new information"):
        return False
    if not matches(reply, "has been changed to"):
        raise IrcError(f"BotServ BOT CHANGE {nick} failed: {reply}")
    log(f"BotServ: {nick} -> {nick}!{ident}@{host} ({real})")
    return True


def sync_services_bot(session: IrcSession, channel: str, spec: dict,
                      bot: dict) -> bool:
    """Assign or unassign the services bot on one channel. True when
    changed.

    `bot: true` puts it in the channel and turns fantasy commands on;
    dropping the flag takes it back out. Unassign only ever removes *our*
    bot — one somebody assigned by hand is left alone, the same additive
    rule the access list and the autovoice list follow.

    Fantasy is set explicitly instead of relying on the botserv module's
    `defaults = "greet fantasy"`: those apply when a channel is
    registered, and the staff channels predate the bot. Note it still
    only works for users with channel access (Anope requires the
    FANTASIA privilege), so `+w v:account:*` voice alone does not grant
    it — the founder and the access list get it, passers-by do not.
    """
    if not bot:
        return False
    nick = bot["nick"]
    info = info_fields(service_reply(session, "BotServ",
                                     f"INFO {channel}", 4.0))
    # "not assigned yet" when the channel has no bot.
    assigned = info.get("bot nick", "")

    if not spec.get("bot"):
        if assigned.lower() != nick.lower():
            return False
        reply = service_reply(session, "BotServ", f"UNASSIGN {channel}", 4.0)
        if not matches(reply, "no bot assigned"):
            raise IrcError(f"BotServ UNASSIGN {channel} failed: {reply}")
        log(f"{channel}: unassigned {nick}")
        return True

    changed = False
    if assigned.lower() != nick.lower():
        reply = service_reply(session, "BotServ",
                              f"ASSIGN {channel} {nick}", 5.0)
        if not matches(reply, "has been assigned to"):
            raise IrcError(
                f"BotServ ASSIGN {channel} {nick} failed: {reply}")
        log(f"{channel}: assigned {nick}")
        changed = True

    if "fantasy" not in info.get("options", "").lower():
        reply = service_reply(session, "BotServ",
                              f"SET FANTASY {channel} ON", 4.0)
        if not matches(reply, "fantasy mode is now on"):
            raise IrcError(
                f"BotServ SET FANTASY {channel} ON failed: {reply}")
        log(f"{channel}: fantasy commands ON")
        changed = True
    return changed


def setup_channel(session: IrcSession, spec: dict, account: str,
                  display: str, access: dict, autovoice: list,
                  bot: dict) -> bool:
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

    # ChanServ INFO prints the founder's *group display*, so both the
    # account name and its display are acceptable — they are the same
    # account, and which one INFO shows depends on whether the rename in
    # group_and_display has landed yet.
    founder = info.get("founder", "")
    owners = {account.lower(), (display or account).lower()}
    if founder and founder.lower() not in owners:
        raise IrcError(
            f"{channel} is registered to {founder}, not "
            f"{' / '.join(sorted(owners))} — refusing to take it over")

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

    # While still in the channel: cs_statusupdate re-applies status modes
    # to members when their access changes, so anyone online gets their
    # prefix immediately instead of on next join.
    if sync_access(session, channel, access):
        changed = True

    # Auto-voice list, same place for the same reason: it only exists on
    # the live channel (Anope's mode lock cannot hold list modes), so a
    # recreation wipes it and the next run must put it back.
    if sync_autovoice(session, channel, autovoice):
        changed = True

    # The services bot last, because ASSIGN is what makes it join: by the
    # time it arrives the channel is fully configured.
    if sync_services_bot(session, channel, spec, bot):
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
    display = os.environ.get("IRCD_ACCOUNT_DISPLAY") or account
    access = json.loads(os.environ.get("IRCD_CHANNEL_ACCESS") or "{}")
    autovoice = json.loads(os.environ.get("IRCD_CHANNEL_AUTOVOICE") or "[]")
    services_bot = json.loads(os.environ.get("IRCD_SERVICES_BOT") or "{}")
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

        require_accounts(session, access)
        if group_and_display(session, account, display, password):
            changed = True

        # One BOT ADD covers the whole run; the per-channel step only
        # assigns it. Skipped entirely when no channel asks for a bot, so
        # a host with ircd_services_bot: {} never creates one.
        if services_bot and any(c.get("bot") for c in channels):
            if ensure_services_bot(session, services_bot):
                changed = True

        for spec in channels:
            if setup_channel(session, spec, account, display, access,
                             autovoice, services_bot):
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
