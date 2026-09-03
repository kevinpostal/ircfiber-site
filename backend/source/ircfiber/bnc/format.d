/**
 * Turns the engine's compact event JSON (`IRCRawEvent.toCompactJson`,
 * keys `c px p t m i n hm x ch l se phase batch typing`) into a line for an
 * attached bouncer client, honouring the client's negotiated caps.
 *
 * Rules mirror ZNC `CClient::PutClient` + goshuirc/bnc's cap filters.
 * No I/O; exercised by `tests/bnc_wire_test.d`.
 */
module ircfiber.bnc.format;

import std.uni : icmp;
import std.string : startsWith;
import std.algorithm : canFind;
import vibe.data.json : Json;
import ircfiber.bnc.wire : formatLine, serverTimeTag, adaptNameToken;

/// Small ring of (target, text, sentAtMs) for messages this client sent
/// without `echo-message`: the engine's unlabeled server echo (when the
/// engine has echo-message but not labeled-response) is dropped once.
struct RecentOwn {
    private struct Entry { string target; string text; long ms; }
    private Entry[32] ring;
    private size_t next;
    /// Last `*status` disconnect notice; the engine emits DISCONNECTED
    /// twice per drop (data-loop exit + connection-loop catch), so the
    /// second one within 5 s is suppressed.
    long lastDisconnectMs;

    /// Remembers a sent message.
    void push(string target, string text, long nowMs) @safe nothrow {
        ring[next] = Entry(target, text, nowMs);
        next = (next + 1) % ring.length;
    }

    /// Removes and reports a matching entry younger than 10 s.
    bool consume(string target, string text, long nowMs) @safe nothrow {
        foreach (ref e; ring) {
            if (e.ms == 0) continue;
            if (nowMs - e.ms > 10_000) { e = Entry.init; continue; }
            if (e.text == text && icmp(e.target, target) == 0) {
                e = Entry.init;
                return true;
            }
        }
        return false;
    }
}

/// Everything `formatEvent` needs to know about the attached client.
struct FormatCtx {
    /// `:server` prefix / bouncer host name.
    string src;
    /// The client's current nick (engine session nick).
    string nick;
    /// Human network name for `*status` notices.
    string networkName;
    /// Random per-attachment id; labels are `bnc-<sessionId>-<seq>`.
    string sessionId;
    /// Acked CAPs.
    bool[string] caps;
    /// ISUPPORT PREFIX chars (default `~&@%+`).
    string prefixChars = "~&@%+";
    /// Echo-suppression ring (may be null in tests).
    RecentOwn* recentOwn;
    /// Clock override for tests (0 → `Clock.currTime`).
    long nowMs;

    bool has(string cap) const @safe nothrow { return (cap in caps) !is null; }
}

private immutable string[] DROP_COMMANDS = [
    "001", "002", "003", "004", "375", "372", "376", "422",
    "CONNECTION_FAIL", "CONNECTION_RETRY_STATUS", "ISUPPORT", "temp_unavailable",
    "idle", "CONNECTED", "network_isupport",
];

private immutable string[] FORWARD_COMMANDS = [
    "PRIVMSG", "NOTICE", "JOIN", "PART", "QUIT", "KICK", "NICK", "MODE", "TOPIC",
    "INVITE", "AWAY", "ACCOUNT", "CHGHOST", "TAGMSG", "WALLOPS",
    "SETNAME", "REDACT", "FAIL", "WARN", "NOTE",
    // Not "ERROR": the upstream `ERROR :Closing link` belongs to the engine's
    // connection, a client receiving it would drop its bouncer session (ZNC
    // swallows it too). The drop surfaces as the `*status` notice below.
];

private string str(const Json ev, string key) @safe {
    if (auto v = key in ev) {
        if (v.type == Json.Type.string) return v.get!string;
    }
    return "";
}

private bool isNumeric(string c) @safe pure nothrow @nogc {
    if (c.length != 3) return false;
    foreach (ch; c) if (ch < '0' || ch > '9') return false;
    return true;
}

private long currentMs() @safe {
    import std.datetime : Clock;
    return Clock.currTime.toUnixTime!long * 1000;
}

/// Formats one event for the client; returns `""` when it must not be sent.
string formatEvent(Json ev, FormatCtx c) @trusted {
    if (ev.type != Json.Type.object) return "";
    if (str(ev, "phase").length) return "";
    const cmd = str(ev, "c");
    if (!cmd.length) return "";
    if (DROP_COMMANDS.canFind(cmd)) return "";

    string[] params;
    if (auto p = "p" in ev) {
        if (p.type == Json.Type.array) {
            foreach (v; *p) params ~= v.type == Json.Type.string ? v.get!string : v.toString();
        }
    }
    const ch = str(ev, "ch");
    const nick = str(ev, "n");
    const text = str(ev, "x");

    // Status-line notices from the bouncer itself.
    if (cmd == "DISCONNECT" || cmd == "DISCONNECTED") {
        const now = c.nowMs ? c.nowMs : currentMs();
        if (c.recentOwn !is null) {
            if (now - c.recentOwn.lastDisconnectMs < 5_000) return "";
            c.recentOwn.lastDisconnectMs = now;
        }
        return formatLine(null, "*status!bnc@" ~ c.src, "NOTICE",
            [c.nick, "Disconnected from " ~ c.networkName ~ (text.length ? ": " ~ text : "")]);
    }

    // Cap-gated commands.
    if (cmd == "TAGMSG" && !c.has("message-tags")) return "";
    if (cmd == "AWAY" && !c.has("away-notify")) return "";
    if (cmd == "ACCOUNT" && !c.has("account-notify")) return "";
    if (cmd == "CHGHOST" && !c.has("chghost")) return "";
    if (cmd == "SETNAME" && !c.has("setname")) return "";
    if (cmd == "REDACT" && !c.has("draft/message-redaction")) return "";
    if (cmd == "INVITE" && !c.has("invite-notify")
        && !(params.length && icmp(params[0], c.nick) == 0)) return "";

    // The engine republishes QUIT/NICK/CHGHOST once per affected channel with
    // `ch` set; only the original (no channel) goes to the client.
    if ((cmd == "QUIT" || cmd == "NICK" || cmd == "CHGHOST") && ch.length) return "";

    if (!isNumeric(cmd) && !FORWARD_COMMANDS.canFind(cmd)) return "";

    // Own PRIVMSG/NOTICE echo handling.
    if (cmd == "PRIVMSG" || cmd == "NOTICE") {
        const own = str(ev, "se") == "true" || (nick.length && icmp(nick, c.nick) == 0);
        if (own) {
            const label = str(ev, "l");
            if (label.startsWith("bnc-" ~ c.sessionId ~ "-")) {
                if (!c.has("echo-message")) return "";
            } else if (!c.has("echo-message") && c.recentOwn !is null) {
                const target = params.length ? params[0] : ch;
                const now = c.nowMs ? c.nowMs : currentMs();
                if (c.recentOwn.consume(target, text, now)) return "";
            }
        }
    }

    string[string] tags;
    if (c.has("server-time")) {
        if (auto t = "t" in ev) {
            if (t.type == Json.Type.int_) tags["time"] = serverTimeTag(t.get!long);
        }
    }
    if (c.has("message-tags")) {
        const m = str(ev, "m");
        if (m.length && m != str(ev, "i")) tags["msgid"] = m;
        const typing = str(ev, "typing");
        if (typing.length) tags["+typing"] = typing;
    }
    if (c.has("account-tag")) {
        const a = str(ev, "a");
        if (a.length) tags["account"] = a;
    }

    string prefix = str(ev, "px");
    if (!prefix.length && nick.length) {
        const hm = str(ev, "hm");
        prefix = hm.length ? nick ~ "!" ~ hm : nick;
    }
    if (!prefix.length && isNumeric(cmd)) prefix = c.src;

    if (!params.length) {
        // Synthetic self echo carries only ch/x.
        if (ch.length) params = text.length ? [ch, text] : [ch];
        else if (text.length) params = [text];
    }

    if (cmd == "JOIN" && params.length == 3 && !c.has("extended-join")) params = params[0 .. 1];
    if (cmd == "353" && params.length >= 4) {
        import std.string : split, join;
        string[] adapted;
        foreach (tok; params[3].split(" ")) {
            if (tok.length) adapted ~= adaptNameToken(tok, c.has("multi-prefix"), c.has("userhost-in-names"), c.prefixChars);
        }
        params[3] = adapted.join(" ");
    }

    return formatLine(tags, prefix, cmd, params);
}
