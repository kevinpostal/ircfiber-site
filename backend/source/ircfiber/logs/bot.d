/**
 * `#staff` operations-log bot (`FiberLogs`). Runs inside the gateway binary
 * but only in the process that sets `IRCFIBER_LOGS_BOT_ENABLED=1`
 * (prod: the dedicated `ircfiber-logs-bot` container — same image as the
 * gateway, never a blue/green replica; local dev: the single gateway).
 *
 * It keeps one client connection to the ircd, OPERs (the only capability
 * that oper grants it is receiving connect server notices), joins the
 * oper-only `#staff` channel and announces every entry of the Redis outbox
 * (`logsOutboxKey()`, fed by `ircfiber.logs.events`): website signups,
 * outbound email and client connects.
 *
 * The bot is also a *producer*: its own IRC session is where connect
 * events come from. A parsed `*** Client connecting …` server notice is
 * pushed onto the same outbox rather than announced directly, so queueing,
 * retry and the one-line-per-second pacing have exactly one implementation.
 *
 * All IO is vibe.d fiber-aware (`connectTCP`, `waitForDataEx`,
 * `read(IOMode.once)`, `blpop`, `requestHTTP`) — never `std.socket`.
 *
 * Env:
 *   IRCFIBER_LOGS_BOT_ENABLED             "1"/"true" → run the bot (unset → disabled)
 *   IRCFIBER_LOGS_BOT_HOST                ircd host (default IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_LOGS_BOT_PORT                ircd port (default IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_LOGS_BOT_TLS                 "1" → TLS client connection (default plaintext)
 *   IRCFIBER_LOGS_BOT_NICK                default FiberLogs
 *   IRCFIBER_LOGS_BOT_CHANNEL             default #staff
 *   IRCFIBER_LOGS_BOT_NICKSERV_PASSWORD   optional; IDENTIFY after 001 when set.
 *                                         Prod sets only the _FILE form
 *                                         (ircfiber.env.envSecret).
 *   IRCFIBER_LOGS_BOT_OPER                oper account name; unset → no OPER,
 *                                         therefore no connect notices
 *   IRCFIBER_LOGS_BOT_OPER_PASSWORD       oper password (also _FILE)
 *   IRCFIBER_LOGS_BOT_IGNORE_CLASSES      comma list of connect classes not announced
 *                                         (default ircfiber-engine,ircfiber-engine-v6,localhost;
 *                                         empty string ignores nothing)
 *   IRCFIBER_IPINFO_TOKEN(_FILE), IRCFIBER_IPINFO_URL, IRCFIBER_IPINFO_TIMEOUT,
 *   IRCFIBER_LOGS_GEO_TTL                 see ircfiber.logs.geo
 *   IRCFIBER_REDIS_URL                    outbox connection
 */
module ircfiber.logs.bot;

import std.algorithm : min;
import std.array : array;
import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.string : indexOf, split, strip;
import std.typecons : Nullable, Tuple;
import std.uni : icmp;
import core.time : msecs, seconds, Duration;

import vibe.core.core : runTask, sleep;
import vibe.core.log;
import vibe.core.net : TCPConnection, connectTCP, WaitForDataStatus;
import vibe.core.stream : IOMode;
import vibe.core.sync : TaskMutex;
import vibe.core.task : Task;
import vibe.data.json : Json, parseJsonString;
import vibe.stream.tls : TLSContextKind, TLSPeerValidationMode, TLSStream, TLSStreamState,
    createTLSContext, createTLSStream;

import ircfiber.env : envSecret;
import ircfiber.logs.events : LogEvent, logsBotKey, logsControlKey, logsOutboxKey, pushLogEvent;
import ircfiber.logs.format;
import ircfiber.logs.geo : GeoSettings, lookupGeo, loadGeoSettings;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.format : clipBytes;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.ircd : IrcLine, parseIrcLine;

/// Bot settings, resolved once from the environment.
struct LogsBotConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick = "FiberLogs";
    string channel = "#staff";
    string nickservPassword;
    string operName;
    string operPassword;
    /// Connect classes whose connects are not announced. The engine
    /// multiplexes every platform user through container IPs (useless geo)
    /// and loopback is the ircd's own healthcheck.
    string[] ignoreClasses = ["ircfiber-engine", "ircfiber-engine-v6", "localhost"];
    string redisUrl = "redis://127.0.0.1:6379";
}

/// Starts the bot task when `IRCFIBER_LOGS_BOT_ENABLED` is set; no-op otherwise.
void startLogsBot() {
    if (!isEnvEnabled("IRCFIBER_LOGS_BOT_ENABLED")) {
        logInfo("Logs bot disabled (IRCFIBER_LOGS_BOT_ENABLED unset)");
        return;
    }
    LogsBotConfig cfg;
    cfg.host = environment.get("IRCFIBER_LOGS_BOT_HOST",
        environment.get("IRCFIBER_IRCD_HOST", "")).strip();
    if (!cfg.host.length) cfg.host = "irc.ircfiber.com";
    try cfg.port = environment.get("IRCFIBER_LOGS_BOT_PORT",
        environment.get("IRCFIBER_IRCD_PORT", "6667")).strip().to!ushort;
    catch (Exception) cfg.port = 6667;
    cfg.tls = environment.get("IRCFIBER_LOGS_BOT_TLS", "0").strip() == "1";
    auto nick = environment.get("IRCFIBER_LOGS_BOT_NICK", "").strip();
    if (nick.length) cfg.nick = nick;
    auto channel = environment.get("IRCFIBER_LOGS_BOT_CHANNEL", "").strip();
    if (channel.length) cfg.channel = channel;
    // File-backed in prod so the bot's passwords are not readable from
    // `docker inspect ircfiber-logs-bot`.
    cfg.nickservPassword = envSecret("IRCFIBER_LOGS_BOT_NICKSERV_PASSWORD", "");
    cfg.operName = environment.get("IRCFIBER_LOGS_BOT_OPER", "").strip();
    cfg.operPassword = envSecret("IRCFIBER_LOGS_BOT_OPER_PASSWORD", "");
    // An explicitly empty value means "ignore nothing", so only an unset
    // variable keeps the defaults.
    auto ignore = environment.get("IRCFIBER_LOGS_BOT_IGNORE_CLASSES", "\0");
    if (ignore != "\0") {
        string[] classes;
        foreach (c; ignore.split(',')) {
            const s = c.strip();
            if (s.length) classes ~= s;
        }
        cfg.ignoreClasses = classes;
    }
    cfg.redisUrl = environment.get("IRCFIBER_REDIS_URL", cfg.redisUrl);

    auto bot = new LogsBot(cfg);
    runTask(&bot.run);
    logInfo("Logs bot starting: %s:%s (%s) nick=%s channel=%s oper=%s nickserv=%s ignore=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick, cfg.channel,
        cfg.operName.length ? cfg.operName : "none",
        cfg.nickservPassword.length ? "yes" : "no", cfg.ignoreClasses);
}

/// One long-lived IRC client; reconnects forever with exponential backoff.
final class LogsBot {
    private enum MAX_LINE = 8192;
    private enum KEEPALIVE_AFTER_MS = 240_000;
    private enum DEAD_AFTER_MS = 300_000;
    private enum SEND_INTERVAL_MS = 1000;
    private enum IRC_LINE_MAX_BYTES = 510;
    private enum MAX_NICK_ATTEMPTS = 3;

    private LogsBotConfig cfg;
    private GeoSettings geoSettings;
    private TCPConnection conn;
    private TLSStream tls;
    private bool haveConn;
    private bool socketClosed;
    private string nick;
    private int nickAttempts;
    private bool registered;
    private bool joined;
    private bool opered;
    private bool readyDone;
    private bool alive;
    private long lastRecvMs;
    private long lastSendMs;
    private TaskMutex sendMutex;
    private Task outboxTask;
    /// Producer connection owned by the reader fiber (the outbox consumer
    /// and the sideband loop each own their own).
    private RedisStorage pushRedis;

    // ── status published to Redis for the admin IRCD page ──
    private string hostName;
    private long startedAtMs;
    private long connectedSinceMs;
    private long sessions;
    private long announcedCount;
    private string lastAnnouncement;
    private long lastAnnouncementAt;
    private long connectsSeen;
    private long connectsIgnored;
    private long geoLookups;
    private long geoFailures;
    private string lastError;
    private long lastErrorAt;
    /// Set by an admin `reconnect` command before the socket is closed so
    /// the session's exit is logged as intentional and retried at once.
    private string closeReason;

    this(LogsBotConfig cfg) {
        this.cfg = cfg;
        this.sendMutex = new TaskMutex;
    }

    private static long nowMs() nothrow {
        try return Clock.currTime.toUnixTime!long * 1000;
        catch (Exception) return 0;
    }

    /// Reconnect loop: 1 s → 2 s → … → 60 s backoff, reset after a session
    /// that stayed up for more than a minute or when an admin asked for the
    /// reconnect. The Redis sideband (heartbeat + control) lives for the
    /// whole process, independent of the IRC session.
    void run() nothrow {
        startedAtMs = nowMs();
        try hostName = environment.get("HOSTNAME", ""); catch (Exception) {}
        try geoSettings = loadGeoSettings();
        catch (Exception e) {
            try logWarn("logs bot: geo settings unavailable: %s", e.msg); catch (Exception) {}
        }
        try {
            pushRedis = new RedisStorage();
            pushRedis.connectFromUrl(cfg.redisUrl);
        } catch (Exception e) {
            pushRedis = null;
            try logWarn("logs bot: producer Redis unavailable: %s", e.msg); catch (Exception) {}
        }
        runTask(&sidebandLoop);
        Duration backoff = 1.seconds;
        while (true) {
            const startedAt = nowMs();
            try session();
            catch (Exception e) {
                const reason = closeReason.length ? closeReason : e.msg;
                try logWarn("logs bot: %s", reason); catch (Exception) {}
                lastError = reason;
                lastErrorAt = nowMs();
            }
            if (nowMs() - startedAt > 60_000 || closeReason.length) backoff = 1.seconds;
            closeReason = "";
            try logInfo("logs bot: reconnecting in %s", backoff); catch (Exception) {}
            try sleep(backoff); catch (Exception) {}
            backoff = min(backoff * 2, 60.seconds);
        }
    }

    // ── connection lifecycle ─────────────────────────────────────────

    private void session() {
        registered = false;
        joined = false;
        opered = false;
        readyDone = false;
        alive = true;
        nick = cfg.nick;
        nickAttempts = 0;
        tls = null;
        haveConn = false;
        socketClosed = false;
        lastSendMs = 0;
        sessions++;
        scope (exit) teardown();

        logInfo("logs bot: connecting to %s:%s", cfg.host, cfg.port);
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
        sendLine("USER fiberlogs 0 * :IRC Fiber log bot");

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
        joined = false;
        registered = false;
        opered = false;
        readyDone = false;
        connectedSinceMs = 0;
        closeSocket();
        haveConn = false;
        if (outboxTask != Task.init) {
            try outboxTask.join(); catch (Exception) {}
            outboxTask = Task.init;
        }
    }

    private void checkIdle() {
        const idle = nowMs() - lastRecvMs;
        if (idle > DEAD_AFTER_MS) throw new Exception("ping timeout (" ~ (idle / 1000).to!string ~ "s silent)");
        if (idle > KEEPALIVE_AFTER_MS && nowMs() - lastSendMs > 30_000) sendLine("PING :keepalive");
    }

    /// Writes one line. Serialized across fibers (reader + outbox), paced to
    /// one line per second, clipped to 510 bytes.
    private void sendLine(string line) {
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

    private void say(string target, const string[] lines) {
        foreach (l; lines) sendLine("PRIVMSG " ~ target ~ " :" ~ l);
    }

    // ── inbound protocol ─────────────────────────────────────────────

    private static string nickOf(string prefix) @safe pure {
        auto bang = prefix.indexOf('!');
        return bang >= 0 ? prefix[0 .. bang] : prefix;
    }

    private void handleLine(string raw) {
        auto l = parseIrcLine(raw);
        if (!l.valid) return;
        switch (l.command) {
            case "PING":
                sendLine("PONG :" ~ (l.params.length ? l.params[$ - 1] : ""));
                break;
            case "001":
                onWelcome(l);
                break;
            case "381":   // RPL_YOUREOPER
                opered = true;
                logInfo("logs bot: opered as %s", cfg.operName);
                becomeReady();
                break;
            case "464":   // ERR_PASSWDMISMATCH
            case "481":   // ERR_NOPRIVILEGES
            case "491":   // ERR_NOOPERHOST
                if (registered && !opered) {
                    logWarn("logs bot: OPER refused (%s %s) — connect notices unavailable",
                        l.command, l.params.length ? l.params[$ - 1] : "");
                    becomeReady();
                }
                break;
            case "433":
                if (registered) break;
                if (++nickAttempts >= MAX_NICK_ATTEMPTS) throw new Exception("nick unavailable");
                nick ~= "_";
                logWarn("logs bot: nick in use, retrying as %s", nick);
                sendLine("NICK " ~ nick);
                break;
            case "NICK":
                if (l.params.length && icmp(nickOf(l.prefix), nick) == 0) nick = l.params[0];
                break;
            case "JOIN":
                if (l.params.length && icmp(nickOf(l.prefix), nick) == 0
                    && icmp(l.params[0], cfg.channel) == 0) {
                    joined = true;
                    logInfo("logs bot: joined %s as %s", cfg.channel, nick);
                }
                break;
            case "471": case "473": case "474": case "475": case "476": case "477":
            case "519": case "520":
                // Channel rejected the JOIN (`#staff` is +O — an un-opered
                // bot cannot enter). The outbox simply stays queued.
                if (l.params.length >= 2 && icmp(l.params[$ - 2], cfg.channel) == 0)
                    logWarn("logs bot: cannot join %s (%s %s) — announcements stay queued",
                        cfg.channel, l.command, l.params[$ - 1]);
                break;
            case "KICK":
                if (l.params.length >= 2 && icmp(l.params[0], cfg.channel) == 0
                    && icmp(l.params[1], nick) == 0) {
                    joined = false;
                    logWarn("logs bot: kicked from %s by %s — rejoining in 5s", cfg.channel, nickOf(l.prefix));
                    runTask(&rejoinLater);
                }
                break;
            case "NOTICE":
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
        logInfo("logs bot: registered as %s", nick);
        if (cfg.nickservPassword.length)
            sendLine("PRIVMSG NickServ :IDENTIFY " ~ cfg.nick ~ " " ~ cfg.nickservPassword);
        sendLine("MODE " ~ nick ~ " +B");
        if (cfg.operName.length && cfg.operPassword.length) {
            // `#staff` is +O: the JOIN has to wait for 381 (or an OPER
            // refusal), so the rest of the startup lives in becomeReady().
            sendLine("OPER " ~ cfg.operName ~ " " ~ cfg.operPassword);
            return;
        }
        logWarn("logs bot: no oper credentials — connect notices unavailable");
        becomeReady();
    }

    /// Everything that must happen once the oper question is settled:
    /// snomasks (only when opered), JOIN, outbox consumer.
    private void becomeReady() {
        if (readyDone) return;
        readyDone = true;
        if (opered) sendLine("MODE " ~ nick ~ " +s +cC");
        sendLine("JOIN " ~ cfg.channel);
        if (outboxTask == Task.init) outboxTask = runTask(&outboxLoop);
    }

    private void rejoinLater() nothrow {
        try {
            sleep(5.seconds);
            if (alive && registered && !joined) sendLine("JOIN " ~ cfg.channel);
        } catch (Exception e) {
            try logWarn("logs bot: rejoin failed: %s", e.msg); catch (Exception) {}
        }
    }

    /// A server notice: the only ones that matter are connect notices
    /// (snomask `c`), which become `irc_connect` outbox entries.
    private void onServerNotice(string text) {
        auto c = parseConnectNotice(text);
        if (!c.ok) return;
        if (classIgnored(c.connClass, cfg.ignoreClasses)) {
            connectsIgnored++;
            return;
        }
        connectsSeen++;
        LogEvent ev;
        ev.type = "irc_connect";
        ev.ts = nowMs();
        ev.nick = c.nick;
        ev.ident = c.ident;
        ev.host = c.host;
        ev.ip = c.ip;
        ev.realname = c.realname;
        ev.connClass = c.connClass;
        ev.port = c.port;
        pushLogEvent(pushRedis, ev);
    }

    // ── outbox consumer ──────────────────────────────────────────────

    /// Drains `logsOutboxKey()` while connected and joined. On a send
    /// failure the entry goes back to the head of the list and the loop
    /// ends; the next session starts a fresh consumer.
    private void outboxLoop() nothrow {
        RedisStorage redis;
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(cfg.redisUrl);
            const key = logsOutboxKey();
            while (alive) {
                if (!joined) { sleep(1.seconds); continue; }
                Nullable!(Tuple!(string, string)) popped;
                try popped = redis.getDb().blpop!string(key, 5);
                catch (Exception e) {
                    logWarn("logs bot: outbox BLPOP failed: %s", e.msg);
                    sleep(5.seconds);
                    continue;
                }
                if (popped.isNull) continue;
                const raw = popped.get[1];
                LogEvent ev;
                try ev = LogEvent.fromJson(parseJsonString(raw));
                catch (Exception e) {
                    logWarn("logs bot: dropping malformed outbox entry: %s", e.msg);
                    continue;
                }
                GeoInfo geo;
                bool first = false;
                if ((ev.type == "signup" || ev.type == "irc_connect")
                    && ev.ip.strip().length && !isPrivateIp(ev.ip)) {
                    geo = lookupGeo(redis, geoSettings, ev.ip, first);
                    geoLookups++;
                    if (!geo.ok) geoFailures++;
                }
                auto lines = formatLogEvent(ev, geo, first);
                if (!lines.length) {
                    logWarn("logs bot: dropping outbox entry of unknown type %s", ev.type);
                    continue;
                }
                try say(cfg.channel, lines);
                catch (Exception e) {
                    try redis.getDb().lpush(key, raw); catch (Exception) {}
                    throw e;
                }
                announcedCount++;
                lastAnnouncement = lines[0];
                lastAnnouncementAt = nowMs();
                logInfo("logs bot: announced %s", ev.type);
            }
        } catch (Exception e) {
            try logWarn("logs bot: outbox loop ended: %s", e.msg); catch (Exception) {}
        }
        if (redis !is null) redis.close();
    }

    // ── Redis sideband: heartbeat for the admin IRCD page + control ──

    /// Snapshot published under `logsBotKey()` (60 s TTL).
    private Json statusJson() {
        import std.process : thisProcessID;
        auto j = Json.emptyObject;
        j["nick"] = Json(nick.length ? nick : cfg.nick);
        j["configuredNick"] = Json(cfg.nick);
        j["channel"] = Json(cfg.channel);
        j["host"] = Json(cfg.host);
        j["port"] = Json(cast(int) cfg.port);
        j["tls"] = Json(cfg.tls);
        j["connected"] = Json(haveConn && !socketClosed);
        j["registered"] = Json(registered);
        j["joined"] = Json(joined);
        j["opered"] = Json(opered);
        j["startedAt"] = Json(startedAtMs);
        j["connectedSince"] = Json(connectedSinceMs);
        j["sessions"] = Json(sessions);
        j["lastRecvAt"] = Json(lastRecvMs);
        j["lastSendAt"] = Json(lastSendMs);
        j["announced"] = Json(announcedCount);
        j["lastAnnouncement"] = Json(lastAnnouncement);
        j["lastAnnouncementAt"] = Json(lastAnnouncementAt);
        j["connectsSeen"] = Json(connectsSeen);
        j["connectsIgnored"] = Json(connectsIgnored);
        j["geoLookups"] = Json(geoLookups);
        j["geoFailures"] = Json(geoFailures);
        j["geoConfigured"] = Json(geoSettings.token.length > 0);
        j["lastError"] = Json(lastError);
        j["lastErrorAt"] = Json(lastErrorAt);
        j["hostname"] = Json(hostName);
        j["pid"] = Json(cast(long) thisProcessID);
        j["updatedAt"] = Json(nowMs());
        return j;
    }

    /// Process-lifetime task: every ≤5 s it refreshes the heartbeat and
    /// drains one admin command from `logsControlKey()`. Redis outages only
    /// pause it; it reconnects and keeps going.
    private void sidebandLoop() nothrow {
        while (true) {
            RedisStorage redis;
            try {
                redis = new RedisStorage();
                redis.connectFromUrl(cfg.redisUrl);
                const key = logsControlKey();
                while (true) {
                    redis.setJson(logsBotKey(), statusJson(), 60);
                    Nullable!(Tuple!(string, string)) popped;
                    popped = redis.getDb().blpop!string(key, 5);
                    if (popped.isNull) continue;
                    handleControl(popped.get[1]);
                }
            } catch (Exception e) {
                try logWarn("logs bot: sideband loop error: %s", e.msg); catch (Exception) {}
            }
            if (redis !is null) redis.close();
            try sleep(5.seconds); catch (Exception) {}
        }
    }

    private void handleControl(string raw) {
        Json j;
        try j = parseJsonString(raw);
        catch (Exception e) {
            logWarn("logs bot: dropping malformed control entry: %s", e.msg);
            return;
        }
        if (j.type != Json.Type.object) return;
        const cmd = j["cmd"].opt!string;
        const by = j["by"].opt!string;
        const ts = j["ts"].opt!long;
        if (nowMs() - ts > 60_000) {
            logInfo("logs bot: dropping stale control command %s from %s", cmd, by);
            return;
        }
        switch (cmd) {
            case "reconnect":
                if (!haveConn || socketClosed) {
                    logInfo("logs bot: reconnect requested by %s while disconnected — the reconnect loop is already retrying", by);
                    return;
                }
                closeReason = "reconnect requested by " ~ (by.length ? by : "admin");
                logInfo("logs bot: %s — closing connection", closeReason);
                closeSocket();
                break;
            case "rejoin":
                if (!registered) {
                    logInfo("logs bot: rejoin requested by %s while not registered — ignored", by);
                    return;
                }
                logInfo("logs bot: rejoin %s requested by %s", cfg.channel, by);
                try sendLine("JOIN " ~ cfg.channel);
                catch (Exception e) logWarn("logs bot: rejoin failed: %s", e.msg);
                break;
            default:
                logWarn("logs bot: unknown control command %s from %s", cmd, by);
                break;
        }
    }
}
