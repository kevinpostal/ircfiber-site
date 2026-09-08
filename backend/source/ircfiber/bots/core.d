/**
 * `IrcBot` — the one IRC client skeleton every gateway bot runs on.
 *
 * FiberEye (`ircfiber.fibereye.bot`) and the #support bot
 * (`ircfiber.support.bot`) used to carry byte-identical copies of the
 * reconnect loop, the TLS session, the read loop, the paced `sendLine`,
 * the PING / 001 / 433 / NICK / ERROR handling, the OPER dance
 * (381 / 464 / 481 / 491), NickServ IDENTIFY + `MODE +B`, channel JOIN /
 * KICK-rejoin and the Redis sideband (heartbeat + control list). That
 * lives here once; a bot subclasses `IrcBot`, fills an `IrcBotConfig` and
 * overrides the hooks it needs.
 *
 * All IO is vibe.d fiber-aware (`connectTCP`, `waitForDataEx`,
 * `read(IOMode.once)`, `blpop`) — never `std.socket`.
 */
module ircfiber.bots.core;

import std.algorithm : min;
import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.string : indexOf, split, strip, toLower;
import std.typecons : Nullable, Tuple;
import std.uni : icmp;
import core.time : msecs, seconds, Duration;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.core.net : TCPConnection, connectTCP, WaitForDataStatus;
import vibe.core.stream : IOMode;
import vibe.core.sync : TaskMutex;
import vibe.data.json : Json, parseJsonString;
import vibe.stream.tls : TLSContextKind, TLSPeerValidationMode, TLSStream, TLSStreamState,
    createTLSContext, createTLSStream;

import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.format : clipBytes;
import ircfiber.web.admin.ircd : IrcLine, parseIrcLine;

/// Unix time in milliseconds; 0 when the clock is unavailable.
package(ircfiber) long nowMs() nothrow {
    try return Clock.currTime.toUnixTime!long * 1000;
    catch (Exception) return 0;
}

// ── environment helpers shared by the bots' `start*` functions ──────

/// `IRCFIBER_<botPrefix>_<key>`, then `IRCFIBER_<fallbackKey>` when
/// `fallbackKey` is non-empty, then `dflt`. Values are stripped; an empty
/// value falls through to the next candidate.
package(ircfiber) string botEnvStr(string botPrefix, string key, string fallbackKey, string dflt) {
    auto v = environment.get("IRCFIBER_" ~ botPrefix ~ "_" ~ key, "").strip();
    if (v.length) return v;
    if (fallbackKey.length) {
        v = environment.get("IRCFIBER_" ~ fallbackKey, "").strip();
        if (v.length) return v;
    }
    return dflt;
}

/// Same lookup chain as `botEnvStr`, parsed as a port; `dflt` on garbage.
package(ircfiber) ushort botEnvPort(string botPrefix, string key, string fallbackKey, ushort dflt) {
    try return botEnvStr(botPrefix, key, fallbackKey, dflt.to!string).to!ushort;
    catch (Exception) return dflt;
}

/// Same lookup chain as `botEnvStr`; `"1"` / `"true"` / `"yes"` → true.
package(ircfiber) bool botEnvFlag(string botPrefix, string key, string fallbackKey, bool dflt) {
    const v = botEnvStr(botPrefix, key, fallbackKey, dflt ? "1" : "0").toLower();
    return v == "1" || v == "true" || v == "yes";
}

/// Signed integer with the same lookup chain; `dflt` when unset or garbage.
package(ircfiber) long botEnvLong(string name, long dflt) {
    try {
        const raw = environment.get(name, "").strip();
        if (raw.length) return raw.to!long;
    } catch (Exception) {
    }
    return dflt;
}

/// Comma list. An explicitly empty value means "nothing", so only an
/// unset variable keeps `dflt` (the `"\0"` sentinel distinguishes the two).
package(ircfiber) string[] botEnvList(string name, string[] dflt) {
    const raw = environment.get(name, "\0");
    if (raw == "\0") return dflt;
    string[] items;
    foreach (c; raw.split(',')) {
        const s = c.strip();
        if (s.length) items ~= s;
    }
    return items;
}

/// Everything the skeleton needs; the subclass keeps its own settings.
struct IrcBotConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick;
    string username;
    string realname;
    /// "" = no IDENTIFY after 001.
    string nickservPassword;
    /// "" = never OPER.
    string operName;
    /// ditto
    string operPassword;
    /// Snomask letters (e.g. "cCqx") set with `MODE +s` once opered; "" = none.
    string snomasks;
    /// JOINed after ready; rejoined on KICK and on the `rejoin` control.
    string[] channels;
    string redisUrl = "redis://127.0.0.1:6379";
    /// Heartbeat JSON key (60 s TTL) and the control list the admin pages push to.
    string heartbeatKey;
    /// ditto
    string controlKey;
    /// Log-line prefix, e.g. "FiberEye" or "support bot".
    string logPrefix = "bot";
}

/// One long-lived IRC client; reconnects forever with exponential backoff.
abstract class IrcBot {
    private enum MAX_LINE = 8192;
    private enum KEEPALIVE_AFTER_MS = 240_000;
    private enum DEAD_AFTER_MS = 300_000;
    private enum SEND_INTERVAL_MS = 1000;
    private enum IRC_LINE_MAX_BYTES = 510;
    private enum MAX_NICK_ATTEMPTS = 3;

    protected IrcBotConfig cfg;
    private TCPConnection conn;
    private TLSStream tls;
    private bool haveConn;
    private bool socketClosed;
    private string nick;
    private int nickAttempts;
    private bool registered;
    private bool opered;
    private bool readyDone;
    private bool alive;
    private long lastRecvMs;
    private long lastSendMs;
    private TaskMutex sendMutex;
    /// Lower-cased channel → currently in it.
    private bool[string] joinedChannels;

    // ── status published to Redis for the admin pages ──
    private string hostName;
    private long startedAtMs;
    private long connectedSinceMs;
    private long sessions;
    private string lastError;
    private long lastErrorAt;
    /// Set by an admin `reconnect` command (or `requestReconnect`) before
    /// the socket is closed so the session's exit is logged as intentional
    /// and retried at once.
    private string closeReason;

    this(IrcBotConfig cfg) {
        this.cfg = cfg;
        this.sendMutex = new TaskMutex;
    }

    // ── hooks (all default no-op) ────────────────────────────────────

    /// Once per process, at the top of `run()` (inside the bot's task).
    protected void onStart() {}
    /// Registered and the OPER question settled; the core JOINs `cfg.channels` afterwards.
    protected void onReady() {}
    /// A TCP session is up and NICK/USER have been sent.
    protected void onSessionStart() {}
    /// The session ended (any reason); state has been reset.
    protected void onSessionEnd() {}
    /// Called before the core's own cases; return true to consume the line.
    protected bool onLine(ref IrcLine l) { return false; }
    /// A NOTICE whose prefix carries no `!` (a server notice).
    protected void onServerNotice(string text) {}
    /// This bot JOINed `channel`.
    protected void onJoined(string channel) {}
    /// A control entry other than `reconnect` / `rejoin`.
    protected void onControl(string cmd, Json entry) {}
    /// Add bot-specific heartbeat fields. `side` is the sideband's own
    /// Redis connection, for fields that read Redis.
    protected void extendStatus(ref Json status, RedisStorage side) {}

    // ── state accessors for subclasses ───────────────────────────────

    protected final string currentNick() const { return nick.length ? nick : cfg.nick; }
    protected final bool isOpered() const { return opered; }
    protected final bool isRegistered() const { return registered; }
    protected final bool isAlive() const { return alive; }
    protected final bool isConnected() const { return haveConn && !socketClosed; }
    protected final long lastSendAtMs() const { return lastSendMs; }
    protected final bool joined(string channel) const {
        return (channel.toLower() in joinedChannels) !is null;
    }

    /// Reconnect loop: 1 s → 2 s → … → 60 s backoff, reset after a session
    /// that stayed up for more than a minute or when an admin asked for the
    /// reconnect. The Redis sideband (heartbeat + control) lives for the
    /// whole process, independent of the IRC session.
    final void run() nothrow {
        startedAtMs = nowMs();
        try hostName = environment.get("HOSTNAME", ""); catch (Exception) {}
        try onStart();
        catch (Exception e) {
            try logWarn("%s: onStart failed: %s", cfg.logPrefix, e.msg); catch (Exception) {}
        }
        if (cfg.heartbeatKey.length) runTask(&sidebandLoop);
        Duration backoff = 1.seconds;
        while (true) {
            const startedAt = nowMs();
            try session();
            catch (Exception e) {
                const reason = closeReason.length ? closeReason : e.msg;
                try logWarn("%s: %s", cfg.logPrefix, reason); catch (Exception) {}
                lastError = reason;
                lastErrorAt = nowMs();
            }
            if (nowMs() - startedAt > 60_000 || closeReason.length) backoff = 1.seconds;
            closeReason = "";
            try logInfo("%s: reconnecting in %s", cfg.logPrefix, backoff); catch (Exception) {}
            try sleep(backoff); catch (Exception) {}
            backoff = min(backoff * 2, 60.seconds);
        }
    }

    // ── connection lifecycle ─────────────────────────────────────────

    private void session() {
        registered = false;
        opered = false;
        readyDone = false;
        alive = true;
        nick = cfg.nick;
        nickAttempts = 0;
        tls = null;
        haveConn = false;
        socketClosed = false;
        lastSendMs = 0;
        joinedChannels = null;
        sessions++;
        scope (exit) teardown();

        logInfo("%s: connecting to %s:%s", cfg.logPrefix, cfg.host, cfg.port);
        conn = connectTCP(cfg.host, cfg.port, null, 0, 15.seconds);
        haveConn = true;
        connectedSinceMs = nowMs();
        conn.tcpNoDelay = true;
        conn.keepAlive = true;
        if (cfg.tls) {
            auto ctx = createTLSContext(TLSContextKind.client);
            // Same policy as the engine's IRC connections (self-signed
            // internal ircd certs).
            ctx.peerValidationMode = TLSPeerValidationMode.none;
            tls = createTLSStream(conn, ctx, TLSStreamState.connecting, cfg.host);
        }
        lastRecvMs = nowMs();

        sendLine("NICK " ~ nick);
        sendLine("USER " ~ cfg.username ~ " 0 * :" ~ cfg.realname);
        onSessionStart();

        ubyte[4096] buf;
        string partial;
        while (true) {
            bool ready = tls !is null ? tls.dataAvailableForRead : conn.dataAvailableForRead;
            if (!ready) {
                final switch (conn.waitForDataEx(30.seconds)) {
                    case WaitForDataStatus.dataAvailable: ready = true; break;
                    case WaitForDataStatus.timeout: break;
                    case WaitForDataStatus.noMoreData: throw new Exception("connection closed by server");
                }
            }
            if (!ready) { checkIdle(); continue; }

            const n = tls !is null ? tls.read(buf[], IOMode.once) : conn.read(buf[], IOMode.once);
            if (n == 0) {
                if (!conn.connected) throw new Exception("EOF from server");
                continue;
            }
            lastRecvMs = nowMs();
            partial ~= cast(string) buf[0 .. n].idup;
            ptrdiff_t idx;
            while ((idx = partial.indexOf("\n")) >= 0) {
                auto line = partial[0 .. idx];
                partial = partial[idx + 1 .. $];
                if (line.length && line[$ - 1] == '\r') line = line[0 .. $ - 1];
                if (!line.length) continue;
                handleLine(line);
            }
            if (partial.length > MAX_LINE) throw new Exception("over-long line from server");
        }
    }

    private void closeSocket() nothrow {
        if (socketClosed) return;
        socketClosed = true;
        if (tls !is null) {
            try tls.finalize(); catch (Exception) {}
            tls = null;
        }
        if (haveConn) {
            try conn.close(); catch (Exception) {}
        }
    }

    private void teardown() nothrow {
        alive = false;
        registered = false;
        opered = false;
        readyDone = false;
        connectedSinceMs = 0;
        joinedChannels = null;
        closeSocket();
        haveConn = false;
        try onSessionEnd();
        catch (Exception e) {
            try logWarn("%s: onSessionEnd failed: %s", cfg.logPrefix, e.msg); catch (Exception) {}
        }
    }

    private void checkIdle() {
        const idle = nowMs() - lastRecvMs;
        if (idle > DEAD_AFTER_MS) throw new Exception("ping timeout (" ~ (idle / 1000).to!string ~ "s silent)");
        if (idle > KEEPALIVE_AFTER_MS && nowMs() - lastSendMs > 30_000) sendLine("PING :keepalive");
    }

    /// Writes one line. Serialized across fibers (reader + the bot's own
    /// tasks), paced to one line per second, clipped to 510 bytes.
    protected final void sendLine(string line) {
        synchronized (sendMutex) {
            const wait = SEND_INTERVAL_MS - (nowMs() - lastSendMs);
            if (wait > 0) sleep(wait.msecs);
            if (line.length > IRC_LINE_MAX_BYTES) line = clipBytes(line, IRC_LINE_MAX_BYTES);
            auto bytes = cast(const(ubyte)[])(line ~ "\r\n");
            if (tls !is null) { tls.write(bytes); tls.flush(); }
            else { conn.write(bytes); conn.flush(); }
            lastSendMs = nowMs();
        }
    }

    protected final void say(string target, const string[] lines) {
        foreach (l; lines) sendLine("PRIVMSG " ~ target ~ " :" ~ l);
    }

    /// Closes the socket so the reconnect loop retries at once; `reason`
    /// is what the session's exit is logged as.
    protected final void requestReconnect(string reason) {
        closeReason = reason;
        logInfo("%s: %s — closing connection", cfg.logPrefix, reason);
        closeSocket();
    }

    // ── inbound protocol ─────────────────────────────────────────────

    private static string nickOf(string prefix) @safe pure {
        auto bang = prefix.indexOf('!');
        return bang >= 0 ? prefix[0 .. bang] : prefix;
    }

    private bool isMe(string prefix) {
        return icmp(nickOf(prefix), nick) == 0;
    }

    private bool isMyChannel(string channel) {
        foreach (c; cfg.channels) if (icmp(c, channel) == 0) return true;
        return false;
    }

    private void handleLine(string raw) {
        auto l = parseIrcLine(raw);
        if (!l.valid) return;
        if (onLine(l)) return;
        switch (l.command) {
            case "PING":
                sendLine("PONG :" ~ (l.params.length ? l.params[$ - 1] : ""));
                break;
            case "001":
                onWelcome(l);
                break;
            case "381":   // RPL_YOUREOPER
                opered = true;
                logInfo("%s: opered as %s", cfg.logPrefix, cfg.operName);
                becomeReady();
                break;
            case "464":   // ERR_PASSWDMISMATCH
            case "481":   // ERR_NOPRIVILEGES
            case "491":   // ERR_NOOPERHOST
                if (registered && !opered) {
                    logWarn("%s: OPER refused (%s %s)", cfg.logPrefix,
                        l.command, l.params.length ? l.params[$ - 1] : "");
                    becomeReady();
                }
                break;
            case "433":
                if (registered) break;
                if (++nickAttempts >= MAX_NICK_ATTEMPTS) throw new Exception("nick unavailable");
                nick ~= "_";
                logWarn("%s: nick in use, retrying as %s", cfg.logPrefix, nick);
                sendLine("NICK " ~ nick);
                break;
            case "NICK":
                if (l.params.length && isMe(l.prefix)) nick = l.params[0];
                break;
            case "JOIN":
                if (l.params.length && isMe(l.prefix) && isMyChannel(l.params[0])) {
                    joinedChannels[l.params[0].toLower()] = true;
                    logInfo("%s: joined %s as %s", cfg.logPrefix, l.params[0], nick);
                    onJoined(l.params[0]);
                }
                break;
            case "471": case "473": case "474": case "475": case "476": case "477":
            case "519": case "520":
                // Channel rejected the JOIN (`#staff` is +O — an un-opered
                // bot cannot enter).
                if (l.params.length >= 2 && isMyChannel(l.params[$ - 2]))
                    logWarn("%s: cannot join %s (%s %s)", cfg.logPrefix,
                        l.params[$ - 2], l.command, l.params[$ - 1]);
                break;
            case "KICK":
                if (l.params.length >= 2 && isMyChannel(l.params[0]) && icmp(l.params[1], nick) == 0) {
                    joinedChannels.remove(l.params[0].toLower());
                    logWarn("%s: kicked from %s by %s — rejoining in 5s", cfg.logPrefix,
                        l.params[0], nickOf(l.prefix));
                    runTask(&rejoinLater, l.params[0]);
                }
                break;
            case "NOTICE":
                // Only server notices carry connect/quit reports; a user
                // prefix contains '!'.
                if (l.params.length >= 2 && l.prefix.indexOf('!') < 0) onServerNotice(l.params[$ - 1]);
                break;
            case "ERROR":
                throw new Exception("server ERROR: " ~ (l.params.length ? l.params[$ - 1] : ""));
            default:
                break;
        }
    }

    private void onWelcome(IrcLine l) {
        registered = true;
        if (l.params.length && l.params[0].length) nick = l.params[0];
        logInfo("%s: registered as %s", cfg.logPrefix, nick);
        if (cfg.nickservPassword.length)
            sendLine("PRIVMSG NickServ :IDENTIFY " ~ cfg.nick ~ " " ~ cfg.nickservPassword);
        sendLine("MODE " ~ nick ~ " +B");
        if (cfg.operName.length && cfg.operPassword.length) {
            // Snomasks and +O channels wait for 381 or an OPER refusal, so
            // the rest of the startup lives in becomeReady().
            sendLine("OPER " ~ cfg.operName ~ " " ~ cfg.operPassword);
            return;
        }
        logWarn("%s: no oper credentials — running un-opered", cfg.logPrefix);
        becomeReady();
    }

    /// Everything that must happen once the oper question is settled:
    /// snomasks (only when opered), the subclass hook, JOINs.
    private void becomeReady() {
        if (readyDone) return;
        readyDone = true;
        if (opered && cfg.snomasks.length) sendLine("MODE " ~ nick ~ " +s +" ~ cfg.snomasks);
        onReady();
        foreach (c; cfg.channels) sendLine("JOIN " ~ c);
    }

    private void rejoinLater(string channel) nothrow {
        try {
            sleep(5.seconds);
            if (alive && registered && !joined(channel)) sendLine("JOIN " ~ channel);
        } catch (Exception e) {
            try logWarn("%s: rejoin failed: %s", cfg.logPrefix, e.msg); catch (Exception) {}
        }
    }

    // ── Redis sideband: heartbeat for the admin pages + control ──────

    /// Snapshot published under `cfg.heartbeatKey` (60 s TTL).
    private Json statusJson(RedisStorage side) {
        import std.process : thisProcessID;
        auto j = Json.emptyObject;
        j["nick"] = Json(currentNick());
        j["configuredNick"] = Json(cfg.nick);
        if (cfg.channels.length) j["channel"] = Json(cfg.channels[0]);
        j["host"] = Json(cfg.host);
        j["port"] = Json(cast(int) cfg.port);
        j["tls"] = Json(cfg.tls);
        j["connected"] = Json(haveConn && !socketClosed);
        j["registered"] = Json(registered);
        if (cfg.channels.length) j["joined"] = Json(joined(cfg.channels[0]));
        j["opered"] = Json(opered);
        j["startedAt"] = Json(startedAtMs);
        j["connectedSince"] = Json(connectedSinceMs);
        j["sessions"] = Json(sessions);
        j["lastRecvAt"] = Json(lastRecvMs);
        j["lastSendAt"] = Json(lastSendMs);
        j["lastError"] = Json(lastError);
        j["lastErrorAt"] = Json(lastErrorAt);
        j["hostname"] = Json(hostName);
        j["pid"] = Json(cast(long) thisProcessID);
        j["updatedAt"] = Json(nowMs());
        extendStatus(j, side);
        return j;
    }

    /// Process-lifetime task: every ≤5 s it refreshes the heartbeat and
    /// drains one admin command from `cfg.controlKey`. Redis outages only
    /// pause it; it reconnects and keeps going.
    private void sidebandLoop() nothrow {
        while (true) {
            RedisStorage side;
            try {
                side = new RedisStorage();
                side.connectFromUrl(cfg.redisUrl);
                while (true) {
                    side.setJson(cfg.heartbeatKey, statusJson(side), 60);
                    if (!cfg.controlKey.length) { sleep(5.seconds); continue; }
                    Nullable!(Tuple!(string, string)) popped;
                    popped = side.getDb().blpop!string(cfg.controlKey, 5);
                    if (popped.isNull) continue;
                    handleControl(popped.get[1]);
                }
            } catch (Exception e) {
                try logWarn("%s: sideband loop error: %s", cfg.logPrefix, e.msg); catch (Exception) {}
            }
            if (side !is null) side.close();
            try sleep(5.seconds); catch (Exception) {}
        }
    }

    private void handleControl(string raw) {
        Json j;
        try j = parseJsonString(raw);
        catch (Exception e) {
            logWarn("%s: dropping malformed control entry: %s", cfg.logPrefix, e.msg);
            return;
        }
        if (j.type != Json.Type.object) return;
        const cmd = j["cmd"].opt!string;
        const by = j["by"].opt!string;
        const ts = j["ts"].opt!long;
        if (nowMs() - ts > 60_000) {
            logInfo("%s: dropping stale control command %s from %s", cfg.logPrefix, cmd, by);
            return;
        }
        switch (cmd) {
            case "reconnect":
                if (!haveConn || socketClosed) {
                    logInfo("%s: reconnect requested by %s while disconnected — "
                        ~ "the reconnect loop is already retrying", cfg.logPrefix, by);
                    return;
                }
                requestReconnect("reconnect requested by " ~ (by.length ? by : "admin"));
                break;
            case "rejoin":
                if (!registered) {
                    logInfo("%s: rejoin requested by %s while not registered — ignored", cfg.logPrefix, by);
                    return;
                }
                foreach (c; cfg.channels) {
                    logInfo("%s: rejoin %s requested by %s", cfg.logPrefix, c, by);
                    try sendLine("JOIN " ~ c);
                    catch (Exception e) logWarn("%s: rejoin failed: %s", cfg.logPrefix, e.msg);
                }
                break;
            default:
                onControl(cmd, j);
                break;
        }
    }
}
