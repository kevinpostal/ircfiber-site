/**
 * FiberEye — the connection-intelligence bot.
 *
 * A second opered IRC connection (separate nick, separate oper class from
 * `FiberLogs`) that runs inside the same gateway image but only in the
 * process that sets `IRCFIBER_FIBEREYE_ENABLED=1` (prod: the dedicated
 * `ircfiber-fibereye` container).
 *
 * It joins no channel and sends no PRIVMSG. Everything it does is:
 *   - subscribe to snomasks `+s +cqx` and persist every connect and quit
 *     to Mongo (`ircfiber.fibereye.store`);
 *   - count connects, distinct nicks and short sessions per IP group in
 *     Redis sorted sets, and ask `ircfiber.fibereye.rules` for a verdict;
 *   - place a timed `ZLINE` when a rule trips *and* enforcement is armed
 *     (`fibereye:armed` = "1", flipped from the admin page — the bot ships
 *     disarmed and merely records what it would have done);
 *   - confirm its own placements with a periodic `STATS Z` sweep, because
 *     InspIRCd answers a successful `ZLINE` with silence.
 *
 * It is deliberately *not* the code that removes a Z-line: releases happen
 * in the web process over the dashboard-oper session
 * (`ircfiber.web.admin.ircd.removeXlineNow`), which is where both the
 * admin Release button and the public `/unban` page live.
 *
 * All IO is vibe.d fiber-aware (`connectTCP`, `waitForDataEx`,
 * `read(IOMode.once)`, `blpop`) — never `std.socket`.
 *
 * Env:
 *   IRCFIBER_FIBEREYE_ENABLED              "1"/"true" → run (unset → disabled)
 *   IRCFIBER_FIBEREYE_HOST                 ircd host (default IRCFIBER_LOGS_BOT_HOST,
 *                                          then IRCFIBER_IRCD_HOST, then irc.ircfiber.com)
 *   IRCFIBER_FIBEREYE_PORT                 ircd port (default IRCFIBER_LOGS_BOT_PORT,
 *                                          then IRCFIBER_IRCD_PORT, then 6667)
 *   IRCFIBER_FIBEREYE_TLS                  "1" → TLS client connection
 *   IRCFIBER_FIBEREYE_NICK                 default FiberEye
 *   IRCFIBER_FIBEREYE_NICKSERV_PASSWORD    optional (also _FILE); IDENTIFY after 001
 *   IRCFIBER_FIBEREYE_OPER                 oper account; unset → no OPER, so no
 *                                          notices and no bans
 *   IRCFIBER_FIBEREYE_OPER_PASSWORD        oper password (also _FILE)
 *   IRCFIBER_FIBEREYE_IGNORE_CLASSES       comma list of connect classes never counted
 *                                          (default ircfiber-engine,ircfiber-engine-v6,
 *                                          localhost,localhost-v6; empty ignores nothing)
 *   IRCFIBER_FIBEREYE_EXEMPT_IPS           comma list of IP groups never counted
 *   IRCFIBER_FIBEREYE_WINDOW               counting window, seconds (default 60)
 *   IRCFIBER_FIBEREYE_CONNECT_THRESHOLD    connects per window (default 10)
 *   IRCFIBER_FIBEREYE_NICK_THRESHOLD       distinct nicks per window (default 6)
 *   IRCFIBER_FIBEREYE_CHURN_THRESHOLD      short sessions per window (default 6)
 *   IRCFIBER_FIBEREYE_SHORT_MS             what counts as short (default 20000)
 *   IRCFIBER_FIBEREYE_BAN_SECONDS          first-strike ban duration (default 3600)
 *   IRCFIBER_FIBEREYE_RETENTION_DAYS       session TTL, days (default 90; see store.d)
 *   IRCFIBER_PUBLIC_URL                    appeal link base (default https://ircfiber.com)
 *   IRCFIBER_REDIS_URL                     counters, heartbeat and control
 */
module ircfiber.fibereye.bot;

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

import ircfiber.env : envSecret;
import ircfiber.fibereye.events;
import ircfiber.fibereye.format;
import ircfiber.fibereye.rules;
import ircfiber.fibereye.store;
import ircfiber.logs.geo : cachedGeo;
import ircfiber.services.accounts : generateServicesPassword;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.format : clipBytes;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.ircd : IrcLine, XLine, parseIrcLine, parseStatsXLine;

/// Bot settings, resolved once from the environment.
struct FiberEyeConfig {
    string host;
    ushort port = 6667;
    bool tls;
    string nick = "FiberEye";
    string nickservPassword;
    string operName;
    string operPassword;
    /// Connect classes never counted and never banned. `localhost-v6` is
    /// in this list on purpose even though the #staff bot's default list
    /// omits it: banning the ircd's own healthcheck source is the
    /// documented self-Z-line trap.
    string[] ignoreClasses = ["ircfiber-engine", "ircfiber-engine-v6", "localhost", "localhost-v6"];
    /// IP groups that are persisted but never counted or banned.
    string[] exemptIps;
    Thresholds thresholds;
    string publicBase = "https://ircfiber.com";
    string redisUrl = "redis://127.0.0.1:6379";
}

private long envLong(string name, long fallback) {
    try {
        const raw = environment.get(name, "").strip();
        if (raw.length) return raw.to!long;
    } catch (Exception) {
    }
    return fallback;
}

private string[] envList(string name, string[] fallback) {
    // An explicitly empty value means "nothing", so only an unset variable
    // keeps the defaults — same "\0" sentinel as the #staff bot.
    const raw = environment.get(name, "\0");
    if (raw == "\0") return fallback;
    string[] items;
    foreach (c; raw.split(',')) {
        const s = c.strip();
        if (s.length) items ~= s;
    }
    return items;
}

/// Starts the bot task when `IRCFIBER_FIBEREYE_ENABLED` is set; no-op otherwise.
void startFiberEye() {
    if (!isEnvEnabled("IRCFIBER_FIBEREYE_ENABLED")) {
        logInfo("FiberEye disabled (IRCFIBER_FIBEREYE_ENABLED unset)");
        return;
    }
    FiberEyeConfig cfg;
    cfg.host = environment.get("IRCFIBER_FIBEREYE_HOST",
        environment.get("IRCFIBER_LOGS_BOT_HOST",
            environment.get("IRCFIBER_IRCD_HOST", ""))).strip();
    if (!cfg.host.length) cfg.host = "irc.ircfiber.com";
    try cfg.port = environment.get("IRCFIBER_FIBEREYE_PORT",
        environment.get("IRCFIBER_LOGS_BOT_PORT",
            environment.get("IRCFIBER_IRCD_PORT", "6667"))).strip().to!ushort;
    catch (Exception) cfg.port = 6667;
    cfg.tls = environment.get("IRCFIBER_FIBEREYE_TLS", "0").strip() == "1";
    auto nick = environment.get("IRCFIBER_FIBEREYE_NICK", "").strip();
    if (nick.length) cfg.nick = nick;
    // File-backed in prod so the credentials are not readable from
    // `docker inspect ircfiber-fibereye`.
    cfg.nickservPassword = envSecret("IRCFIBER_FIBEREYE_NICKSERV_PASSWORD", "");
    cfg.operName = environment.get("IRCFIBER_FIBEREYE_OPER", "").strip();
    cfg.operPassword = envSecret("IRCFIBER_FIBEREYE_OPER_PASSWORD", "");
    cfg.ignoreClasses = envList("IRCFIBER_FIBEREYE_IGNORE_CLASSES", cfg.ignoreClasses);
    cfg.exemptIps = envList("IRCFIBER_FIBEREYE_EXEMPT_IPS", null);
    cfg.thresholds.windowSeconds = envLong("IRCFIBER_FIBEREYE_WINDOW", 60);
    cfg.thresholds.connects = envLong("IRCFIBER_FIBEREYE_CONNECT_THRESHOLD", 10);
    cfg.thresholds.nicks = envLong("IRCFIBER_FIBEREYE_NICK_THRESHOLD", 6);
    cfg.thresholds.churn = envLong("IRCFIBER_FIBEREYE_CHURN_THRESHOLD", 6);
    cfg.thresholds.shortMs = envLong("IRCFIBER_FIBEREYE_SHORT_MS", 20_000);
    cfg.thresholds.banSeconds = envLong("IRCFIBER_FIBEREYE_BAN_SECONDS", 3_600);
    if (cfg.thresholds.windowSeconds <= 0) cfg.thresholds.windowSeconds = 60;
    auto base = environment.get("IRCFIBER_PUBLIC_URL", "https://ircfiber.com").strip();
    while (base.length && base[$ - 1] == '/') base = base[0 .. $ - 1];
    if (base.length) cfg.publicBase = base;
    cfg.redisUrl = environment.get("IRCFIBER_REDIS_URL", cfg.redisUrl);

    auto bot = new FiberEyeBot(cfg);
    runTask(&bot.run);
    logInfo("FiberEye starting: %s:%s (%s) nick=%s oper=%s window=%ss "
        ~ "connects=%s nicks=%s churn=%s ban=%ss ignore=%s exempt=%s",
        cfg.host, cfg.port, cfg.tls ? "TLS" : "plaintext", cfg.nick,
        cfg.operName.length ? cfg.operName : "none",
        cfg.thresholds.windowSeconds, cfg.thresholds.connects, cfg.thresholds.nicks,
        cfg.thresholds.churn, cfg.thresholds.banSeconds, cfg.ignoreClasses, cfg.exemptIps);
}

/// One long-lived IRC client; reconnects forever with exponential backoff.
final class FiberEyeBot {
    private enum MAX_LINE = 8192;
    private enum KEEPALIVE_AFTER_MS = 240_000;
    private enum DEAD_AFTER_MS = 300_000;
    private enum SEND_INTERVAL_MS = 1000;
    private enum IRC_LINE_MAX_BYTES = 510;
    private enum MAX_NICK_ATTEMPTS = 3;
    private enum STATS_INTERVAL = 60;
    private enum GEO_INTERVAL = 60;
    /// Open-session map cap. A flood must not grow it without bound; the
    /// oldest insertion is evicted, which only costs a `durationMs` on a
    /// session that has been open longer than 20 000 others.
    private enum MAX_OPEN_SESSIONS = 20_000;

    private FiberEyeConfig cfg;
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
    /// Redis connection owned by the reader fiber (each loop owns its own).
    private RedisStorage redis;
    private FiberEyeStore store;

    /// nick\0ip → open session id, so a quit can close its own row.
    private string[string] openSessions;
    /// Insertion order of `openSessions`, for bounded eviction.
    private string[] openOrder;
    /// Connect time per open session id, so a quit computes its duration
    /// without a Mongo read on the IRC read loop.
    private long[string] openedAt;
    /// Last WHOIS send, for the account-enrichment throttle.
    private long lastWhoisMs;

    /// Masks the ircd currently lists in `STATS Z`, refreshed by the sweep.
    private bool[string] activeZlines;
    private XLine[string] pendingStats;
    private bool statsLoopStarted;
    private bool geoLoopStarted;

    // ── status published to Redis for the admin FiberEye page ──
    private string hostName;
    private long startedAtMs;
    private long connectedSinceMs;
    private long sessions;
    private long connectsSeen;
    private long connectsIgnored;
    private long quitsSeen;
    private long bansPlaced;
    private long bansObserved;
    private long accountLookups;
    private long geoFilled;
    private string lastError;
    private long lastErrorAt;
    /// Set by an admin `reconnect` command before the socket is closed so
    /// the session's exit is logged as intentional and retried at once.
    private string closeReason;

    this(FiberEyeConfig cfg) {
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
        try {
            redis = new RedisStorage();
            redis.connectFromUrl(cfg.redisUrl);
        } catch (Exception e) {
            redis = null;
            try logWarn("FiberEye: Redis unavailable: %s", e.msg); catch (Exception) {}
        }
        try store = new FiberEyeStore();
        catch (Exception e) {
            store = null;
            try logWarn("FiberEye: Mongo unavailable: %s", e.msg); catch (Exception) {}
        }
        runTask(&sidebandLoop);
        Duration backoff = 1.seconds;
        while (true) {
            const startedAt = nowMs();
            try session();
            catch (Exception e) {
                const reason = closeReason.length ? closeReason : e.msg;
                try logWarn("FiberEye: %s", reason); catch (Exception) {}
                lastError = reason;
                lastErrorAt = nowMs();
            }
            if (nowMs() - startedAt > 60_000 || closeReason.length) backoff = 1.seconds;
            closeReason = "";
            try logInfo("FiberEye: reconnecting in %s", backoff); catch (Exception) {}
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
        sessions++;
        scope (exit) teardown();

        logInfo("FiberEye: connecting to %s:%s", cfg.host, cfg.port);
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
        sendLine("USER fibereye 0 * :IRC Fiber connection watch");

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
        closeSocket();
        haveConn = false;
    }

    private void checkIdle() {
        const idle = nowMs() - lastRecvMs;
        if (idle > DEAD_AFTER_MS) throw new Exception("ping timeout (" ~ (idle / 1000).to!string ~ "s silent)");
        if (idle > KEEPALIVE_AFTER_MS && nowMs() - lastSendMs > 30_000) sendLine("PING :keepalive");
    }

    /// Writes one line. Serialized across fibers (reader + sweeps + the
    /// enforce task), paced to one line per second, clipped to 510 bytes.
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
                logInfo("FiberEye: opered as %s", cfg.operName);
                becomeReady();
                break;
            case "464":   // ERR_PASSWDMISMATCH
            case "481":   // ERR_NOPRIVILEGES
            case "491":   // ERR_NOOPERHOST
                if (registered && !opered) {
                    logWarn("FiberEye: OPER refused (%s %s) — no connect notices and no bans",
                        l.command, l.params.length ? l.params[$ - 1] : "");
                    becomeReady();
                }
                break;
            case "433":
                if (registered) break;
                if (++nickAttempts >= MAX_NICK_ATTEMPTS) throw new Exception("nick unavailable");
                nick ~= "_";
                logWarn("FiberEye: nick in use, retrying as %s", nick);
                sendLine("NICK " ~ nick);
                break;
            case "NICK":
                if (l.params.length && icmp(nickOf(l.prefix), nick) == 0) nick = l.params[0];
                break;
            case "NOTICE":
                // Only server notices carry connect/quit reports; a user
                // prefix contains '!'.
                if (l.params.length >= 2 && l.prefix.indexOf('!') < 0) onServerNotice(l.params[$ - 1]);
                break;
            case "330":   // RPL_WHOISACCOUNT — [me, nick, account, "is logged in as"]
                if (l.params.length >= 3) onWhoisAccount(l.params[1], l.params[2]);
                break;
            case "210":   // one X-line row of a STATS sweep
                {
                    XLine x;
                    if (parseStatsXLine(l, x) && x.type == "Z") pendingStats[x.mask] = x;
                }
                break;
            case "219":   // RPL_ENDOFSTATS — the sweep is complete
                onStatsComplete();
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
        logInfo("FiberEye: registered as %s", nick);
        if (cfg.nickservPassword.length)
            sendLine("PRIVMSG NickServ :IDENTIFY " ~ cfg.nick ~ " " ~ cfg.nickservPassword);
        sendLine("MODE " ~ nick ~ " +B");
        if (cfg.operName.length && cfg.operPassword.length) {
            // Snomasks (and therefore everything this bot does) wait for
            // 381 or an OPER refusal, so the rest lives in becomeReady().
            sendLine("OPER " ~ cfg.operName ~ " " ~ cfg.operPassword);
            return;
        }
        logWarn("FiberEye: no oper credentials — no connect notices and no bans");
        becomeReady();
    }

    /// Everything that must happen once the oper question is settled.
    /// FiberEye joins no channel: `+s +cqx` is its entire subscription
    /// (`c` connects, `q` local quits, `x` X-line notices).
    private void becomeReady() {
        if (readyDone) return;
        readyDone = true;
        if (opered) {
            sendLine("MODE " ~ nick ~ " +s +cqx");
            if (!statsLoopStarted) { statsLoopStarted = true; runTask(&statsLoop); }
        }
        if (!geoLoopStarted) { geoLoopStarted = true; runTask(&geoLoop); }
    }

    // ── connect / quit observation ───────────────────────────────────

    private static string openKey(string nick_, string ip) {
        return nick_.toLower() ~ "\0" ~ ip;
    }

    private void rememberOpen(string key, string id, long ts) {
        if (!(key in openSessions)) {
            openOrder ~= key;
            if (openOrder.length > MAX_OPEN_SESSIONS) {
                const evict = openOrder[0];
                openOrder = openOrder[1 .. $];
                if (auto old = evict in openSessions) {
                    openedAt.remove(*old);
                    openSessions.remove(evict);
                }
            }
        }
        openSessions[key] = id;
        openedAt[id] = ts;
    }

    /// A server notice: a connect notice (snomask `c`), a local quit
    /// notice (`q`), or an X-line notice (`x`, logged only — placements are
    /// confirmed by the `STATS Z` sweep, which is the only truthful oracle
    /// from inside a read loop).
    private void onServerNotice(string text) {
        auto c = parseConnectNotice(text);
        if (c.ok) { onConnect(c); return; }
        auto q = parseQuitNotice(text);
        if (q.ok) { onQuit(q); return; }
        const t = text.strip();
        if (t.indexOf("Z-line") >= 0 || t.indexOf("Z:line") >= 0 || t.indexOf("ZLINE") >= 0)
            logInfo("FiberEye: xline notice: %s", t);
    }

    private void onConnect(ConnectNotice c) {
        if (classIgnored(c.connClass, cfg.ignoreClasses)) {
            connectsIgnored++;
            return;
        }
        connectsSeen++;
        // Mutable: `runTask` copies its arguments into the task's own
        // storage and cannot assign through a `const` type.
        string group = ipGroup(c.ip);

        SessionRecord r;
        r.ts = nowMs();
        r.nick = c.nick;
        r.ident = c.ident;
        r.host = c.host;
        r.ip = c.ip;
        r.realname = c.realname;
        r.connClass = c.connClass;
        r.port = c.port;
        r.tls = c.port == 6697;
        r.ipGroup = group;
        r.ipVersion = c.ip.indexOf(':') >= 0 ? 6 : 4;
        r.geoPending = true;

        string id;
        if (store !is null) {
            id = store.insertSession(r);
            r.id = id;
            store.upsertIp(r);
        }
        if (id.length) rememberOpen(openKey(c.nick, c.ip), id, r.ts);

        // A trusted-subnet container address must never be banned: that
        // would take the whole platform offline. Persist it, count nothing.
        if (isPrivateIp(c.ip) || exempt(group)) return;

        Observation o;
        o.windowSeconds = cfg.thresholds.windowSeconds;
        if (!countConnect(group, c.nick, r.ts, o)) return;
        const v = evaluate(o, cfg.thresholds);
        if (!v.trip) {
            // Account enrichment is best-effort and must never compete
            // with an enforcement line for the 1-line-per-second budget,
            // so at most one WHOIS every 5 s and never for a tripping
            // group. A flood's nicks stay unenriched, which is fine.
            if (opered && id.length && r.ts - lastWhoisMs >= 5_000) {
                lastWhoisMs = r.ts;
                sendLine("WHOIS " ~ c.nick);
            }
            return;
        }
        // Never enforce inline: `enforceBan` writes Mongo and sleeps
        // between the ZLINE and its confirming sweep, and the read loop
        // must keep draining server notices while that happens.
        string rule = v.rule;
        runTask(&enforceTask, group, rule,
            BanEvidence(o.connects, o.nicks, o.churn, o.windowSeconds));
    }

    /// `runTask` entry point for enforcement — a named nothrow method so
    /// a Mongo or IRC failure inside it can never escape into the task
    /// scheduler.
    private void enforceTask(string group, string rule, BanEvidence ev) nothrow {
        try enforceBan(group, rule, ev);
        catch (Exception e) {
            try logWarn("FiberEye: enforcement failed for %s: %s", group, e.msg);
            catch (Exception) {}
        }
    }

    private void onQuit(QuitNotice q) {
        quitsSeen++;
        const key = openKey(q.nick, q.ip);
        auto found = key in openSessions;
        if (found is null) return;
        const id = *found;
        openSessions.remove(key);
        const ts = nowMs();
        long duration;
        if (store !is null) {
            // The connect timestamp is the row's own `ts`; reading it back
            // is one findOne, so instead the duration is derived from the
            // session map's insertion time when available.
            auto opened = openedAt.get(id, 0L);
            duration = opened > 0 ? ts - opened : 0;
            store.closeSession(id, ts, q.reason, duration);
        }
        openedAt.remove(id);
        if (duration > 0 && duration < cfg.thresholds.shortMs) {
            const group = ipGroup(q.ip);
            if (!isPrivateIp(q.ip) && !exempt(group)) {
                countChurn(group, ts);
                if (store !is null) store.bumpShortSession(group);
            }
        }
    }


    private bool exempt(string group) {
        foreach (e; cfg.exemptIps) if (e == group) return true;
        return false;
    }

    private void onWhoisAccount(string who, string account) {
        if (!account.length) return;
        accountLookups++;
        // The map key needs the IP, which a 330 does not carry, so the
        // newest open session for this nick is the one that gets it.
        foreach (key, id; openSessions) {
            const sep = key.indexOf('\0');
            if (sep < 0) continue;
            if (icmp(key[0 .. sep], who) != 0) continue;
            if (store !is null) {
                store.setSessionAccount(id, account);
                const ipPart = key[sep + 1 .. $];
                store.setIpAccount(ipGroup(ipPart), account);
            }
            return;
        }
    }

    // ── window counters ──────────────────────────────────────────────

    /// Adds this connect to the group's sorted sets, trims them to the
    /// window and reads the three counts back. False when Redis is
    /// unavailable — no counters means no verdict, which fails safe.
    private bool countConnect(string group, string nick_, long ts, ref Observation o) {
        if (redis is null) return false;
        const windowMs = cfg.thresholds.windowSeconds * 1000;
        const cutoff = ts - windowMs;
        const ttl = cfg.thresholds.windowSeconds * 4;
        try {
            auto db = redis.getDb();
            const ck = fiberEyeConnKey(group);
            const nk = fiberEyeNickKey(group);
            const hk = fiberEyeChurnKey(group);
            // Score is the connect instant; the member carries the nick so
            // two connects in the same millisecond never collapse into one.
            db.zadd(ck, ts, ts.to!string ~ ":" ~ nick_);
            db.zremRangeByScore(ck, 0.0, cast(double) cutoff);
            db.expire(ck, ttl);
            o.connects = db.zcard(ck);
            db.zadd(nk, ts, nick_.toLower());
            db.zremRangeByScore(nk, 0.0, cast(double) cutoff);
            db.expire(nk, ttl);
            o.nicks = db.zcard(nk);
            db.zremRangeByScore(hk, 0.0, cast(double) cutoff);
            o.churn = db.zcard(hk);
            return true;
        } catch (Exception e) {
            logWarn("FiberEye: window counters failed for %s: %s", group, e.msg);
            return false;
        }
    }

    private void countChurn(string group, long ts) {
        if (redis is null) return;
        try {
            auto db = redis.getDb();
            const hk = fiberEyeChurnKey(group);
            db.zadd(hk, ts, ts.to!string);
            db.expire(hk, cfg.thresholds.windowSeconds * 4);
        } catch (Exception e) {
            logWarn("FiberEye: churn counter failed for %s: %s", group, e.msg);
        }
    }

    // ── enforcement ──────────────────────────────────────────────────

    private bool armedOn(RedisStorage r) {
        if (r is null) return false;
        try return r.getDb().get(fiberEyeArmedKey()) == "1";
        catch (Exception e) {
            // A Redis wipe or outage must not arm enforcement.
            logWarn("FiberEye: cannot read the arm flag: %s", e.msg);
            return false;
        }
    }

    /// Records a verdict and, when armed, places the Z-line.
    private void enforceBan(string group, string rule, BanEvidence ev) {
        if (store is null) return;
        const now = nowMs();
        // A continuing flood must not create one ban row per connect.
        if (!store.activeBanForGroup(group, now).isNull) return;

        const isArmed = armedOn(redis);
        long strikes = 1;
        if (redis !is null) {
            try {
                auto db = redis.getDb();
                const sk = fiberEyeStrikeKey(group);
                strikes = db.incr(sk);
                if (strikes == 1) db.expire(sk, 604_800);
            } catch (Exception e) {
                logWarn("FiberEye: strike counter failed for %s: %s", group, e.msg);
                strikes = 1;
            }
        }
        const seconds_ = banDurationFor(strikes, cfg.thresholds.banSeconds);
        const token = generateServicesPassword(40);
        const appealUrl = cfg.publicBase ~ "/unban/" ~ token;

        BanRecord b;
        b.mask = group;
        b.ipGroup = group;
        b.type = "zline";
        b.rule = rule;
        b.reason = banReason(rule, appealUrl);
        b.durationSeconds = seconds_;
        b.placedAtMs = now;
        b.expiresAtMs = now + seconds_ * 1000;
        b.strikes = strikes;
        b.token = token;
        b.observeOnly = !isArmed;
        b.evidence = ev;
        if (!isArmed) b.placeError = "";
        else if (!cfg.operName.length || !opered) b.placeError = "not opered";
        const banId = store.insertBan(b);

        if (!isArmed) {
            bansObserved++;
            store.setIpBan(group, 0, banId, strikes);
            logInfo("FiberEye: would ban %s (%s, strike %s, %ss) — enforcement disarmed",
                group, rule, strikes, seconds_);
            return;
        }
        if (!cfg.operName.length || !opered) {
            logWarn("FiberEye: %s tripped %s but the bot is not opered — no ZLINE placed",
                group, rule);
            store.setIpBan(group, 0, banId, strikes);
            return;
        }

        Appeal appeal;
        appeal.mask = b.mask;
        appeal.ipGroup = group;
        appeal.banId = banId;
        appeal.reason = b.reason;
        appeal.placedAtMs = b.placedAtMs;
        appeal.expiresAtMs = b.expiresAtMs;
        if (redis !is null)
            redis.setJson(fiberEyeAppealKey(token), appeal.toJson(), seconds_ + 86_400);

        sendLine("ZLINE " ~ b.mask ~ " " ~ seconds_.to!string ~ " :" ~ b.reason);
        bansPlaced++;
        store.setIpBan(group, b.expiresAtMs, banId, strikes);
        logInfo("FiberEye: ZLINE %s for %ss (%s, strike %s)", b.mask, seconds_, rule, strikes);
        // InspIRCd answers a successful ZLINE with silence, so the sweep is
        // what flips `placed`.
        sleep(3.seconds);
        sendLine("STATS Z");
    }

    // ── STATS Z sweep and reconciliation ─────────────────────────────

    private void statsLoop() nothrow {
        while (true) {
            try {
                sleep(STATS_INTERVAL.seconds);
                if (!alive || !opered) continue;
                sendLine("STATS Z");
            } catch (Exception e) {
                try logWarn("FiberEye: stats sweep failed: %s", e.msg); catch (Exception) {}
                try sleep(5.seconds); catch (Exception) {}
            }
        }
    }

    /// Swaps the accumulated `210` rows in, then reconciles both ways:
    /// unconfirmed bans that are now listed become `placed`, and standing
    /// bans the ircd no longer lists are recorded as gone so the admin page
    /// never shows a ban that is not in force.
    private void onStatsComplete() {
        bool[string] active;
        foreach (mask, _; pendingStats) active[mask] = true;
        activeZlines = active;
        pendingStats = null;
        if (store is null) return;
        const now = nowMs();
        foreach (b; store.standingBans(now)) {
            const listed = (b.mask in activeZlines) !is null;
            if (listed && !b.placed) {
                store.markBanPlaced(b.id, true, "");
                logInfo("FiberEye: ZLINE %s confirmed by STATS Z", b.mask);
            } else if (!listed && b.placed) {
                store.markBanReleased(b.id, now, "expired-or-removed");
                store.setIpBan(b.ipGroup, 0, b.id, b.strikes);
                logInfo("FiberEye: ZLINE %s is gone from the ircd — marking released", b.mask);
            }
        }
    }

    // ── geo backfill ─────────────────────────────────────────────────

    /// Cache-only geo backfill. FiberEye never performs an ipinfo lookup:
    /// `lookupGeo` sets the "first sighting" marker the #staff bot's
    /// `↳ <ip> · <geo detail>` follow-up line depends on, and whichever bot
    /// won the race would steal it. The #staff bot warms the cache within a
    /// second of the same connect, so this normally fills on its first
    /// pass; with FiberLogs off, geo simply stays pending and the UI shows
    /// an em dash.
    private void geoLoop() nothrow {
        while (true) {
            try {
                sleep(GEO_INTERVAL.seconds);
                if (store is null || redis is null) continue;
                foreach (ip; store.pendingGeoIps(20)) {
                    const addr = ip.ip.length ? ip.ip : ip.ipGroup;
                    auto g = cachedGeo(redis, addr);
                    if (!g.ok) continue;
                    store.setIpGeo(ip.ipGroup, g);
                    store.fillGroupGeo(ip.ipGroup, g);
                    geoFilled++;
                }
            } catch (Exception e) {
                try logWarn("FiberEye: geo backfill failed: %s", e.msg); catch (Exception) {}
                try sleep(5.seconds); catch (Exception) {}
            }
        }
    }

    // ── Redis sideband: heartbeat for the admin page + control ───────

    /// Snapshot published under `fiberEyeBotKey()` (60 s TTL). The arm
    /// flag is read through the caller's own Redis connection so the
    /// sideband fiber never shares a request with the reader fiber.
    private Json statusJson(RedisStorage side) {
        import std.process : thisProcessID;
        auto j = Json.emptyObject;
        j["nick"] = Json(nick.length ? nick : cfg.nick);
        j["configuredNick"] = Json(cfg.nick);
        j["host"] = Json(cfg.host);
        j["port"] = Json(cast(int) cfg.port);
        j["tls"] = Json(cfg.tls);
        j["connected"] = Json(haveConn && !socketClosed);
        j["registered"] = Json(registered);
        j["opered"] = Json(opered);
        j["startedAt"] = Json(startedAtMs);
        j["connectedSince"] = Json(connectedSinceMs);
        j["sessions"] = Json(sessions);
        j["lastRecvAt"] = Json(lastRecvMs);
        j["lastSendAt"] = Json(lastSendMs);
        j["armed"] = Json(armedOn(side));
        j["connectsSeen"] = Json(connectsSeen);
        j["connectsIgnored"] = Json(connectsIgnored);
        j["quitsSeen"] = Json(quitsSeen);
        j["sessionsOpen"] = Json(cast(long) openSessions.length);
        j["bansPlaced"] = Json(bansPlaced);
        j["bansObserved"] = Json(bansObserved);
        j["activeZlines"] = Json(cast(long) activeZlines.length);
        j["accountLookups"] = Json(accountLookups);
        j["geoFilled"] = Json(geoFilled);
        j["lastError"] = Json(lastError);
        j["lastErrorAt"] = Json(lastErrorAt);
        j["hostname"] = Json(hostName);
        j["pid"] = Json(cast(long) thisProcessID);
        j["updatedAt"] = Json(nowMs());
        auto t = Json.emptyObject;
        t["windowSeconds"] = Json(cfg.thresholds.windowSeconds);
        t["connects"] = Json(cfg.thresholds.connects);
        t["nicks"] = Json(cfg.thresholds.nicks);
        t["churn"] = Json(cfg.thresholds.churn);
        t["shortMs"] = Json(cfg.thresholds.shortMs);
        t["banSeconds"] = Json(cfg.thresholds.banSeconds);
        j["thresholds"] = t;
        auto ignore = Json.emptyArray;
        foreach (c; cfg.ignoreClasses) ignore ~= Json(c);
        j["ignoreClasses"] = ignore;
        auto exemptJson = Json.emptyArray;
        foreach (e; cfg.exemptIps) exemptJson ~= Json(e);
        j["exemptIps"] = exemptJson;
        return j;
    }


    /// Process-lifetime task: every ≤5 s it refreshes the heartbeat and
    /// drains one admin command from `fiberEyeControlKey()`. Redis outages
    /// only pause it; it reconnects and keeps going.
    private void sidebandLoop() nothrow {
        while (true) {
            RedisStorage side;
            try {
                side = new RedisStorage();
                side.connectFromUrl(cfg.redisUrl);
                const key = fiberEyeControlKey();
                while (true) {
                    side.setJson(fiberEyeBotKey(), statusJson(side), 60);
                    Nullable!(Tuple!(string, string)) popped;
                    popped = side.getDb().blpop!string(key, 5);
                    if (popped.isNull) continue;
                    handleControl(popped.get[1]);
                }
            } catch (Exception e) {
                try logWarn("FiberEye: sideband loop error: %s", e.msg); catch (Exception) {}
            }
            if (side !is null) side.close();
            try sleep(5.seconds); catch (Exception) {}
        }
    }

    private void handleControl(string raw) {
        Json j;
        try j = parseJsonString(raw);
        catch (Exception e) {
            logWarn("FiberEye: dropping malformed control entry: %s", e.msg);
            return;
        }
        if (j.type != Json.Type.object) return;
        const cmd = j["cmd"].opt!string;
        const by = j["by"].opt!string;
        const ts = j["ts"].opt!long;
        if (nowMs() - ts > 60_000) {
            logInfo("FiberEye: dropping stale control command %s from %s", cmd, by);
            return;
        }
        switch (cmd) {
            case "reconnect":
                if (!haveConn || socketClosed) {
                    logInfo("FiberEye: reconnect requested by %s while disconnected — "
                        ~ "the reconnect loop is already retrying", by);
                    return;
                }
                closeReason = "reconnect requested by " ~ (by.length ? by : "admin");
                logInfo("FiberEye: %s — closing connection", closeReason);
                closeSocket();
                break;
            case "stats":
                if (!opered) {
                    logInfo("FiberEye: stats requested by %s while not opered — ignored", by);
                    return;
                }
                logInfo("FiberEye: STATS Z sweep requested by %s", by);
                try sendLine("STATS Z");
                catch (Exception e) logWarn("FiberEye: stats sweep failed: %s", e.msg);
                break;
            default:
                logWarn("FiberEye: unknown control command %s from %s", cmd, by);
                break;
        }
    }
}
