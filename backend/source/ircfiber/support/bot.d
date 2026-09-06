/**
 * `#support` services bot (`FiberSupport`). Runs inside the gateway binary
 * but only in the process that sets `IRCFIBER_SUPPORT_BOT_ENABLED=1`
 * (prod: the dedicated `ircfiber-support-bot` container — same image as
 * the gateway, never a blue/green replica; local dev: the single gateway).
 *
 * It keeps one plaintext (or TLS) client connection to the ircd, joins the
 * support channel, announces every entry of the Redis outbox
 * (`RedisKeys.supportOutbox()`, fed by `ircfiber.support.events`) and
 * answers `!help`, `!issues [open|all]` and `!issue <n>`.
 *
 * All IO is vibe.d fiber-aware (`connectTCP`, `waitForDataEx`,
 * `read(IOMode.once)`, `blpop`) — never `std.socket`.
 *
 * Env:
 *   IRCFIBER_SUPPORT_BOT_ENABLED            "1"/"true" → run the bot (unset → disabled)
 *   IRCFIBER_SUPPORT_BOT_HOST               ircd host (default IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_SUPPORT_BOT_PORT               ircd port (default IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_SUPPORT_BOT_TLS                "1" → TLS client connection (default plaintext)
 *   IRCFIBER_SUPPORT_BOT_NICK               default FiberSupport
 *   IRCFIBER_SUPPORT_BOT_CHANNEL            default #support
 *   IRCFIBER_SUPPORT_BOT_NICKSERV_PASSWORD  optional; IDENTIFY after 001 when set.
 *                                           Prod sets only the _FILE form
 *                                           (ircfiber.env.envSecret).
 *   IRCFIBER_SUPPORT_BOT_PUBLIC_URL         default https://ircfiber.com (admin/feedback links)
 *   IRCFIBER_REDIS_URL                      outbox consumer connection
 */
module ircfiber.support.bot;

import std.algorithm : min;
import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.string : indexOf, strip;
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

import ircfiber.db.support_issues : SupportIssueRepository, SupportIssueRecord;
import ircfiber.env : envSecret;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.events : SupportEvent;
import ircfiber.support.format;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.ircd : IrcLine, parseIrcLine;

/// Bot settings, resolved once from the environment.
struct SupportBotConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick = "FiberSupport";
    string channel = "#support";
    string nickservPassword;
    string publicUrl = "https://ircfiber.com";
    string redisUrl = "redis://127.0.0.1:6379";
}

/// Starts the bot task when `IRCFIBER_SUPPORT_BOT_ENABLED` is set; no-op otherwise.
void startSupportBot() {
    if (!isEnvEnabled("IRCFIBER_SUPPORT_BOT_ENABLED")) {
        logInfo("Support bot disabled (IRCFIBER_SUPPORT_BOT_ENABLED unset)");
        return;
    }
    SupportBotConfig cfg;
    cfg.host = environment.get("IRCFIBER_SUPPORT_BOT_HOST",
        environment.get("IRCFIBER_IRCD_HOST", "")).strip();
    if (!cfg.host.length) cfg.host = "irc.ircfiber.com";
    try cfg.port = environment.get("IRCFIBER_SUPPORT_BOT_PORT",
        environment.get("IRCFIBER_IRCD_PORT", "6667")).strip().to!ushort;
    catch (Exception) cfg.port = 6667;
    cfg.tls = environment.get("IRCFIBER_SUPPORT_BOT_TLS", "0").strip() == "1";
    auto nick = environment.get("IRCFIBER_SUPPORT_BOT_NICK", "").strip();
    if (nick.length) cfg.nick = nick;
    auto channel = environment.get("IRCFIBER_SUPPORT_BOT_CHANNEL", "").strip();
    if (channel.length) cfg.channel = channel;
    // File-backed in prod so the bot's NickServ password is not readable
    // from `docker inspect ircfiber-support-bot`.
    cfg.nickservPassword = envSecret("IRCFIBER_SUPPORT_BOT_NICKSERV_PASSWORD", "");
    auto publicUrl = environment.get("IRCFIBER_SUPPORT_BOT_PUBLIC_URL", "").strip();
    if (publicUrl.length) cfg.publicUrl = publicUrl;
    cfg.redisUrl = environment.get("IRCFIBER_REDIS_URL", cfg.redisUrl);

    auto bot = new SupportBot(cfg);
    runTask(&bot.run);
    logInfo("Support bot starting: %s:%s (%s) nick=%s channel=%s nickserv=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick, cfg.channel,
        cfg.nickservPassword.length ? "yes" : "no");
}

/// One long-lived IRC client; reconnects forever with exponential backoff.
final class SupportBot {
    private enum MAX_LINE = 8192;
    private enum KEEPALIVE_AFTER_MS = 240_000;
    private enum DEAD_AFTER_MS = 300_000;
    private enum SEND_INTERVAL_MS = 1000;
    private enum IRC_LINE_MAX_BYTES = 510;
    private enum CMD_COOLDOWN_MS = 2000;
    private enum MAX_NICK_ATTEMPTS = 3;

    private SupportBotConfig cfg;
    private TCPConnection conn;
    private TLSStream tls;
    private bool haveConn;
    private bool socketClosed;
    private string nick;
    private int nickAttempts;
    private bool registered;
    private bool joined;
    private bool alive;
    private long lastRecvMs;
    private long lastSendMs;
    private TaskMutex sendMutex;
    private Task outboxTask;
    private long[string] lastCmdMs;
    private SupportIssueRepository repo;

    // ── status published to Redis for the admin IRCD page ──
    private string hostName;
    private long startedAtMs;
    private long connectedSinceMs;
    private long sessions;
    private long announcedCount;
    private string lastAnnouncement;
    private long lastAnnouncementAt;
    private long commandsAnswered;
    private string lastCommandText;
    private string lastCommandBy;
    private long lastCommandAt;
    private string lastError;
    private long lastErrorAt;
    /// Set by an admin `reconnect` command before the socket is closed so
    /// the session's exit is logged as intentional and retried at once.
    private string closeReason;

    this(SupportBotConfig cfg) {
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
        runTask(&sidebandLoop);
        Duration backoff = 1.seconds;
        while (true) {
            const startedAt = nowMs();
            try session();
            catch (Exception e) {
                const reason = closeReason.length ? closeReason : e.msg;
                try logWarn("support bot: %s", reason); catch (Exception) {}
                lastError = reason;
                lastErrorAt = nowMs();
            }
            if (nowMs() - startedAt > 60_000 || closeReason.length) backoff = 1.seconds;
            closeReason = "";
            try logInfo("support bot: reconnecting in %s", backoff); catch (Exception) {}
            try sleep(backoff); catch (Exception) {}
            backoff = min(backoff * 2, 60.seconds);
        }
    }

    // ── connection lifecycle ─────────────────────────────────────────

    private void session() {
        registered = false;
        joined = false;
        alive = true;
        nick = cfg.nick;
        nickAttempts = 0;
        tls = null;
        haveConn = false;
        socketClosed = false;
        lastSendMs = 0;
        sessions++;
        scope (exit) teardown();

        logInfo("support bot: connecting to %s:%s", cfg.host, cfg.port);
        conn = connectTCP(cfg.host, cfg.port, null, 0, 15.seconds);
        haveConn = true;
        connectedSinceMs = nowMs();
        conn.tcpNoDelay = true;
        conn.keepAlive = true;
        if (cfg.tls) {
            auto ctx = createTLSContext(TLSContextKind.client);
            // Same policy as the engine's IRC connections (self-signed
            // internal ircd certs); the bot never carries private data.
            ctx.peerValidationMode = TLSPeerValidationMode.none;
            tls = createTLSStream(conn, ctx, TLSStreamState.connecting, cfg.host);
        }
        lastRecvMs = nowMs();

        sendLine("NICK " ~ nick);
        sendLine("USER fibersupport 0 * :IRC Fiber support bot");

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
            case "433":
                if (registered) break;
                if (++nickAttempts >= MAX_NICK_ATTEMPTS) throw new Exception("nick unavailable");
                nick ~= "_";
                logWarn("support bot: nick in use, retrying as %s", nick);
                sendLine("NICK " ~ nick);
                break;
            case "NICK":
                if (l.params.length && icmp(nickOf(l.prefix), nick) == 0) nick = l.params[0];
                break;
            case "JOIN":
                if (l.params.length && icmp(nickOf(l.prefix), nick) == 0
                    && icmp(l.params[0], cfg.channel) == 0) {
                    joined = true;
                    logInfo("support bot: joined %s as %s", cfg.channel, nick);
                }
                break;
            case "KICK":
                if (l.params.length >= 2 && icmp(l.params[0], cfg.channel) == 0
                    && icmp(l.params[1], nick) == 0) {
                    joined = false;
                    logWarn("support bot: kicked from %s by %s — rejoining in 5s", cfg.channel, nickOf(l.prefix));
                    runTask(&rejoinLater);
                }
                break;
            case "PRIVMSG":
                if (l.params.length >= 2) onPrivmsg(l);
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
        logInfo("support bot: registered as %s", nick);
        if (cfg.nickservPassword.length)
            sendLine("PRIVMSG NickServ :IDENTIFY " ~ cfg.nick ~ " " ~ cfg.nickservPassword);
        sendLine("MODE " ~ nick ~ " +B");
        sendLine("JOIN " ~ cfg.channel);
        if (outboxTask == Task.init) outboxTask = runTask(&outboxLoop);
    }

    private void rejoinLater() nothrow {
        try {
            sleep(5.seconds);
            if (alive && registered && !joined) sendLine("JOIN " ~ cfg.channel);
        } catch (Exception e) {
            try logWarn("support bot: rejoin failed: %s", e.msg); catch (Exception) {}
        }
    }

    private void onPrivmsg(IrcLine l) {
        const target = l.params[0];
        const text = l.params[1];
        if (!text.length || text[0] != '!') return;   // also skips CTCP (\x01)
        const toChannel = icmp(target, cfg.channel) == 0;
        const toMe = icmp(target, nick) == 0;
        if (!toChannel && !toMe) return;
        const sender = nickOf(l.prefix);
        if (!sender.length) return;

        auto cmd = parseBotCommand(text);
        if (cmd.name != "help" && cmd.name != "issues" && cmd.name != "issue") return;

        const now = nowMs();
        if (auto p = sender in lastCmdMs) if (now - *p < CMD_COOLDOWN_MS) return;
        if (lastCmdMs.length > 1000) lastCmdMs.clear();
        lastCmdMs[sender] = now;

        const replyTo = toChannel ? cfg.channel : sender;
        string[] reply;
        switch (cmd.name) {
            case "help":
                reply = formatHelp(cfg.publicUrl);
                break;
            case "issues":
                reply = cmd.ok ? issuesSummary(cmd.arg) : [SUPPORT_USAGE];
                break;
            case "issue":
                reply = cmd.ok ? issueDetail(cmd.arg) : [SUPPORT_USAGE];
                break;
            default:
                return;
        }
        say(replyTo, reply);
        commandsAnswered++;
        lastCommandText = text;
        lastCommandBy = sender;
        lastCommandAt = now;
    }

    private SupportIssueRepository repository() {
        if (repo is null) repo = new SupportIssueRepository();
        return repo;
    }

    private string[] issuesSummary(string arg) {
        try {
            auto r = repository();
            auto counts = r.countByStatus();
            auto recent = r.recent(arg == "all" ? [] : ["open", "in_progress"], SUPPORT_SUMMARY_ROWS);
            return formatIssuesSummary(counts, recent, nowMs(), cfg.publicUrl);
        } catch (Exception e) {
            logWarn("support bot: !issues failed: %s", e.msg);
            return ["Support database unavailable — try again later"];
        }
    }

    private string[] issueDetail(string arg) {
        long n;
        try n = arg.to!long; catch (Exception) return [SUPPORT_USAGE];
        try {
            auto rec = repository().getByNumber(n);
            if (rec.id.length == 0) return ["No issue #" ~ n.to!string];
            return formatIssueDetail(rec, nowMs(), cfg.publicUrl);
        } catch (Exception e) {
            logWarn("support bot: !issue failed: %s", e.msg);
            return ["Support database unavailable — try again later"];
        }
    }

    // ── outbox consumer ──────────────────────────────────────────────

    /// Drains `RedisKeys.supportOutbox()` while connected and joined. On a
    /// send failure the entry goes back to the head of the list and the
    /// loop ends; the next session starts a fresh consumer.
    private void outboxLoop() nothrow {
        RedisStorage redis;
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(cfg.redisUrl);
            const key = RedisKeys.supportOutbox();
            while (alive) {
                if (!joined) { sleep(1.seconds); continue; }
                Nullable!(Tuple!(string, string)) popped;
                try popped = redis.getDb().blpop!string(key, 5);
                catch (Exception e) {
                    logWarn("support bot: outbox BLPOP failed: %s", e.msg);
                    sleep(5.seconds);
                    continue;
                }
                if (popped.isNull) continue;
                const raw = popped.get[1];
                SupportEvent ev;
                try ev = SupportEvent.fromJson(parseJsonString(raw));
                catch (Exception e) {
                    logWarn("support bot: dropping malformed outbox entry: %s", e.msg);
                    continue;
                }
                auto lines = formatSupportEvent(ev, cfg.publicUrl);
                if (!lines.length) {
                    logWarn("support bot: dropping outbox entry of unknown type %s", ev.type);
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
                logInfo("support bot: announced %s #%d", ev.type, ev.number);
            }
        } catch (Exception e) {
            try logWarn("support bot: outbox loop ended: %s", e.msg); catch (Exception) {}
        }
        if (redis !is null) redis.close();
    }

    // ── Redis sideband: heartbeat for the admin IRCD page + control ──

    /// Snapshot published under `RedisKeys.supportBot()` (60 s TTL).
    private Json statusJson() {
        import std.process : thisProcessID;
        auto j = Json.emptyObject;
        j["nick"] = Json(nick.length ? nick : cfg.nick);
        j["configuredNick"] = Json(cfg.nick);
        j["channel"] = Json(cfg.channel);
        j["host"] = Json(cfg.host);
        j["port"] = Json(cast(int) cfg.port);
        j["tls"] = Json(cfg.tls);
        j["publicUrl"] = Json(cfg.publicUrl);
        j["connected"] = Json(haveConn && !socketClosed);
        j["registered"] = Json(registered);
        j["joined"] = Json(joined);
        j["startedAt"] = Json(startedAtMs);
        j["connectedSince"] = Json(connectedSinceMs);
        j["sessions"] = Json(sessions);
        j["lastRecvAt"] = Json(lastRecvMs);
        j["lastSendAt"] = Json(lastSendMs);
        j["announced"] = Json(announcedCount);
        j["lastAnnouncement"] = Json(lastAnnouncement);
        j["lastAnnouncementAt"] = Json(lastAnnouncementAt);
        j["commandsAnswered"] = Json(commandsAnswered);
        j["lastCommand"] = Json(lastCommandText);
        j["lastCommandBy"] = Json(lastCommandBy);
        j["lastCommandAt"] = Json(lastCommandAt);
        j["lastError"] = Json(lastError);
        j["lastErrorAt"] = Json(lastErrorAt);
        j["hostname"] = Json(hostName);
        j["pid"] = Json(cast(long) thisProcessID);
        j["updatedAt"] = Json(nowMs());
        return j;
    }

    /// Process-lifetime task: every ≤5 s it refreshes the heartbeat and
    /// drains one admin command from `RedisKeys.supportBotControl()`. Redis
    /// outages only pause it; it reconnects and keeps going.
    private void sidebandLoop() nothrow {
        while (true) {
            RedisStorage redis;
            try {
                redis = new RedisStorage();
                redis.connectFromUrl(cfg.redisUrl);
                const key = RedisKeys.supportBotControl();
                while (true) {
                    redis.setJson(RedisKeys.supportBot(), statusJson(), 60);
                    Nullable!(Tuple!(string, string)) popped;
                    popped = redis.getDb().blpop!string(key, 5);
                    if (popped.isNull) continue;
                    handleControl(popped.get[1]);
                }
            } catch (Exception e) {
                try logWarn("support bot: sideband loop error: %s", e.msg); catch (Exception) {}
            }
            if (redis !is null) redis.close();
            try sleep(5.seconds); catch (Exception) {}
        }
    }

    private void handleControl(string raw) {
        Json j;
        try j = parseJsonString(raw);
        catch (Exception e) {
            logWarn("support bot: dropping malformed control entry: %s", e.msg);
            return;
        }
        if (j.type != Json.Type.object) return;
        const cmd = j["cmd"].opt!string;
        const by = j["by"].opt!string;
        const ts = j["ts"].opt!long;
        if (nowMs() - ts > 60_000) {
            logInfo("support bot: dropping stale control command %s from %s", cmd, by);
            return;
        }
        switch (cmd) {
            case "reconnect":
                if (!haveConn || socketClosed) {
                    logInfo("support bot: reconnect requested by %s while disconnected — the reconnect loop is already retrying", by);
                    return;
                }
                closeReason = "reconnect requested by " ~ (by.length ? by : "admin");
                logInfo("support bot: %s — closing connection", closeReason);
                closeSocket();
                break;
            case "rejoin":
                if (!registered) {
                    logInfo("support bot: rejoin requested by %s while not registered — ignored", by);
                    return;
                }
                // Keep `joined` as-is: a server does not echo JOIN for a channel
                // we are already in, and the outbox pauses while `joined` is false.
                // A real re-join (after a kick) is confirmed by the JOIN echo.
                logInfo("support bot: rejoin %s requested by %s", cfg.channel, by);
                try sendLine("JOIN " ~ cfg.channel);
                catch (Exception e) logWarn("support bot: rejoin failed: %s", e.msg);
                break;
            default:
                logWarn("support bot: unknown control command %s from %s", cmd, by);
                break;
        }
    }
}
