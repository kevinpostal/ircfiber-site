/**
 * One attached bouncer client (soju `bouncer-networks` model).
 *
 * The client authenticates with the IRC Fiber username and the account's
 * bouncer password (SASL PLAIN or `PASS [<identity>:]<password>`), picks a
 * network with `BOUNCER BIND` or the `<username>/<network>[@<clientid>]`
 * identity suffix, receives a synthesized registration burst built from
 * the engine's state snapshot (ZNC `CIRCNetwork::ClientConnected` /
 * `CChan::AttachUser`), then live traffic from the user's Redis event
 * channel. Everything it sends goes out through the owning engine's
 * command queue, exactly like the web UI. An unbound connection only
 * sees the `BOUNCER` command surface.
 *
 * Fiber layout per client (all on the listener thread):
 *   - `run()`      reader loop on the accepting fiber
 *   - writer task  drains `outbound` → socket (only writer)
 *   - subscriber   vibe.d RedisSubscriber task (own Redis connection)
 *   - keepalive    PING every 60 s idle, drop after 180 s silence
 */
module ircfiber.bnc.client;

import std.uuid : UUID, randomUUID, parseUUID;
import std.conv : to;
import std.datetime : Clock;
import std.digest : secureEqual;
import std.string : indexOf, split, strip, startsWith, join, toUpper, toLower;
import std.algorithm : canFind, max, min;
import std.uni : icmp;
import core.time : msecs, seconds, Duration;

import vibe.core.core : runTask, sleep, yield;
import vibe.core.task : Task;
import vibe.core.channel : Channel, createChannel;
import vibe.core.net : TCPConnection, WaitForDataStatus;
import vibe.core.stream : IOMode;
import vibe.core.log;
import vibe.stream.tls : TLSStream;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisSubscriber;

import ircfiber.storage.redis : RedisStorage;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.user : UserRepository;
import ircfiber.db.messages : MessageRepository;
import ircfiber.db.preferences : PreferencesRepository, clampBncPlaybackLines;
import ircfiber.storage.buffer : BufferManager;
import ircfiber.models.irc_event : IRCRawEvent;
import ircfiber.models.network : NetworkConfig, TLSMode;
import ircfiber.network_lifecycle : normalizeHost, provisionNetwork, updateOwnedNetwork, deleteOwnedNetwork;
import ircfiber.redis.protocol : RedisKeys, IRCCommand, NetworkStateSnapshot;
import ircfiber.api.websocket : loadNetworkStateSnapshot, routeEngineCommand;
import ircfiber.bnc.wire;
import ircfiber.bnc.format : FormatCtx, RecentOwn, formatEvent, formatChannelListEvent;
import ircfiber.bnc.control : BNC_EVENT_REVOKED, BNC_EVENT_KICK, BNC_EVENT_NETWORKS;

/// Shared services handed to every client by the listener.
struct BncContext {
    RedisStorage redis;
    ServerRegistry registry;
    NetworkRepository networkRepo;
    /// Bouncer password lookup (`users.bncToken`).
    UserRepository userRepo;
    MessageRepository messageRepo;
    /// Per-user settings (bouncer playback size).
    PreferencesRepository prefsRepo;
    /// Redis scrollback writer for the attach/detach status rows.
    BufferManager bufferManager;
    /// `:server` prefix and 001 host name.
    string sourceName;
    /// Redis URL for the per-client subscriber connection.
    string redisUrl;
    /// Protocol trace (every client/server line at info). Off unless the
    /// listener saw `IRCFIBER_BNC_TRACE=1` — high volume, for drop diagnosis.
    bool trace;
}

/// CAPs the bouncer offers (ZNC core set + soju bouncer-networks).
immutable string[] OFFERED_CAPS = [
    "server-time", "batch", "message-tags", "echo-message", "multi-prefix",
    "userhost-in-names", "away-notify", "account-notify", "account-tag",
    "extended-join", "invite-notify", "chghost", "cap-notify",
    "standard-replies", "setname", "draft/message-redaction",
    // On-demand history (soju-style). Clients that negotiate it get no
    // attach playback and pull what they need with CHATHISTORY.
    "draft/chathistory",
    // Account login (PLAIN only) and the multi-network surface.
    "sasl", "soju.im/bouncer-networks", "soju.im/bouncer-networks-notify",
];

/// File-backed bouncer MOTD (soju `motd` directive parity). Read fresh on
/// every bouncer-level connect, so editing the file or sending HUP (which
/// re-reads on next connect) updates it without a restart. Path from
/// `IRCFIBER_BNC_MOTD_PATH`, else `/config/bnc-motd`, else the built-in
/// inspircd welcome. TLS certs are already per-connection in listener.d.
private string[] loadBouncerMotd() {
    import std.process : environment;
    import std.file : exists, readText;
    import std.string : splitLines;
    string[] paths;
    try {
        auto env = environment.get("IRCFIBER_BNC_MOTD_PATH", "");
        if (env.length) paths ~= env;
    } catch (Exception) {}
    paths ~= "/config/bnc-motd";
    paths ~= "/etc/ircfiber/bnc-motd";
    foreach (p; paths) {
        try {
            if (p.length && exists(p)) {
                auto lines = readText(p).splitLines();
                if (lines.length) return lines;
            }
        } catch (Exception) {}
    }
    return [
        "  _____ _____ ____      ______ _           _",
        " |_   _/  ___|  _ \\    |  ___(_)         | |",
        "   | | \\ `--.| |_) |___| |_   _ _ __   __| |___",
        "   | |  `--. \\  _ <___|  _| | | '_ \\ / _` / __|",
        "  _| |_/\\__/ / |_) |  | |   | | | | | (_| \\__ \\",
        " |_____\\____/|____/   |_|   |_|_| |_|\\__,_|___/",
        "",
        "Welcome to IRC Fiber!",
        "",
        "irc.ircfiber.com — InspIRCd with Anope services.",
        "Enterprise-grade IRC for the IRC Fiber community.",
        "",
        "For support, contact: admin@ircfiber.com",
    ];
}

/// Largest `limit` honoured by CHATHISTORY; advertised in 005.
private enum int CHATHISTORY_MAX = 500;

private enum size_t MAX_LINE = 1024;
// Keepalive: PING after 45s idle, drop only after 10m silence.
// Previous 60s/180s was too aggressive for mobile/NAT and caused
// spurious "no clientid after 1h13m" drops when the client slept
// or hit a transient NAT timeout. 45s PING keeps NAT open, 10m
// dead timeout matches ZNC/IRCCloud and allows resume via clientid
// + cursor after a sleep. Anonymous (no clientid) connections also
// benefit — they have no cursor to resume but should survive short
// network blips without being reaped at 3m.
private enum long KEEPALIVE_IDLE_MS = 45_000;
private enum long DEAD_AFTER_MS = 600_000;
private enum long CURSOR_FLUSH_MS = 10_000;
private enum int REPLAY_LIMIT = 1000;
private enum size_t PENDING_LIVE_MAX = 500;
/// TTL of the admin-visible presence record; refreshed every keepalive tick (15 s).
private enum long PRESENCE_TTL_SECONDS = 60;

final class BncClient {
    private {
        TCPConnection conn;
        TLSStream tls;
        BncContext ctx;
        string peer;
        string src;

        Channel!string outbound;
        Task writerTask;
        Task keepaliveTask;
        bool closing;
        /// Why this connection is going down (quit, idle-timeout,
        /// remote-eof, read-error, write-failed, revoked, admin-kick,
        /// bad-password, line-too-long, wait-error). First reason wins so
        /// the teardown summary names the original cause, not a follow-on.
        string closeReason;
        /// Set when the password was revoked/regenerated: the cursor hash was
        /// deleted server-side and must not be re-created on detach.
        bool revoked;
        bool socketClosed;

        // Registration
        bool gotNick, gotUser, inCap, registered;
        /// `PASS` value, validated at registration (not on receipt).
        bool gotPass; string passRaw;
        /// `USER <username>` first param — the identity when PASS is bare.
        string userParam;
        /// Canonical `User.username` once authenticated.
        bool authed; string authUsername;
        /// Network selector from the identity suffix (slug / id / host) or "".
        string networkSel;
        /// `BOUNCER BIND <netid>` received before registration completed.
        string pendingBindId;
        /// Sent `AUTHENTICATE +`, waiting for the PLAIN payload.
        bool saslPlainPending;
        string clientNick = "*";
        bool[string] caps;
        bool cap302;

        // Attachment
        string sessionId;
        string userId;
        string networkId;
        string networkName;
        string clientId;
        string currentNick;
        string prefixChars = "~&@%+";
        uint seq;
        RecentOwn recentOwn;
        /// Last `state=` sent per network id for `-notify` clients; an
        /// engine retry loop emits DISCONNECT/CONNECTION_FAIL every cycle.
        string[string] lastNetState;

        // Live stream
        RedisStorage subRedis;
        RedisSubscriber subscriber;
        bool subscriberActive;
        bool liveReady;
        Json[] pendingLive;
        long cursor;
        long flushedCursor;
        long lastFlushMs;

        long lastRecvMs;
        long lastSendMs;
        long attachedAtMs;
        long linesIn;
        long linesOut;

        // soju-style detached channels (per-BNC-connection): PART with
        // reason "detach" hides the channel from this client without
        // parting upstream. Keyed lower-case channel name.
        bool[string] detachedChans;
    }

    this(TCPConnection conn, TLSStream tls, BncContext ctx) {
        this.conn = conn;
        this.tls = tls;
        this.ctx = ctx;
        this.src = ctx.sourceName;
        this.outbound = createChannel!string();
        this.sessionId = randomUUID().toString()[0 .. 8];
        try this.peer = conn.peerAddress; catch (Exception) this.peer = "?";
        const now = nowMs();
        lastRecvMs = now;
        lastSendMs = now;
    }

    private static string formatDuration(long secs) @safe {
        if (secs < 60) return secs.to!string ~ "s";
        if (secs < 3600) return (secs / 60).to!string ~ "m " ~ (secs % 60).to!string ~ "s";
        if (secs < 86_400) return (secs / 3600).to!string ~ "h " ~ ((secs % 3600) / 60).to!string ~ "m";
        return (secs / 86_400).to!string ~ "d " ~ ((secs % 86_400) / 3600).to!string ~ "h";
    }

    private static long nowMs() @safe {
        return Clock.currTime.toUnixTime!long * 1000;
    }

    // ── I/O ──────────────────────────────────────────────────────────

    /// Queues one line for the writer task. Safe from any fiber.
    private void send(string line) nothrow {
        if (closing) return;
        traceLine("S>", line);
        try outbound.put(line);
        catch (Exception) {}
    }

    /// Records why this connection is going down. Nothrow so the writer
    /// task can use it; string slice assignment never allocates.
    private void markClosing(string reason) nothrow {
        if (!closeReason.length) closeReason = reason;
        closing = true;
    }

    /// One protocol-trace line (server-bound "C>", client-bound "S>").
    /// Only when the listener enabled `IRCFIBER_BNC_TRACE`.
    private void traceLine(string dir, string line) nothrow {
        if (!ctx.trace) return;
        try logInfo("bnc: trace sid=%s %s %s", sessionId, dir, line);
        catch (Exception) {}
    }

    private void writeLine(string line) {
        auto bytes = cast(const(ubyte)[])(line ~ "\r\n");
        if (tls !is null) { tls.write(bytes); tls.flush(); }
        else { conn.write(bytes); conn.flush(); }
        lastSendMs = nowMs();
        linesOut++;
    }

    private void writerLoop() nothrow {
        try {
            string line;
            size_t n;
            while (outbound.tryConsumeOne(line)) {
                try writeLine(line);
                catch (Exception e) {
                    try logWarn("bnc: sid=%s write failed for %s: %s", sessionId, peer, e.msg);
                    catch (Exception) {}
                    markClosing("write-failed");
                    closeSocket();
                    break;
                }
                if (++n % 100 == 0) {
                    try yield(); catch (Exception) {}
                }
            }
        } catch (Exception e) {
            try logWarn("bnc: sid=%s writer loop error for %s: %s", sessionId, peer, e.msg);
            catch (Exception) {}
        }
    }

    private void closeSocket() nothrow {
        if (socketClosed) return;
        socketClosed = true;
        if (tls !is null) {
            try tls.finalize(); catch (Exception) {}
        }
        try conn.close(); catch (Exception) {}
    }

    /// Reader loop; returns when the client is gone. Child tasks are
    /// joined before returning.
    void run() {
        writerTask = runTask(&writerLoop);
        scope(exit) teardown();

        ubyte[4096] buf;
        string partial;
        while (!closing) {
            bool ready;
            try {
                ready = tls !is null ? tls.dataAvailableForRead : conn.dataAvailableForRead;
                if (!ready) {
                    final switch (conn.waitForDataEx(5.seconds)) {
                        case WaitForDataStatus.dataAvailable: ready = true; break;
                        case WaitForDataStatus.timeout: break;
                        case WaitForDataStatus.noMoreData: markClosing("remote-eof"); break;
                    }
                }
            } catch (Exception e) {
                logWarn("bnc: sid=%s wait failed for %s: %s", sessionId, peer, e.msg);
                markClosing("wait-error");
                break;
            }
            if (closing) break;
            if (!ready) { checkTimeouts(); continue; }

            size_t n;
            try n = tls !is null ? tls.read(buf[], IOMode.once) : conn.read(buf[], IOMode.once);
            catch (Exception e) {
                logInfo("bnc: sid=%s read ended for %s: %s", sessionId, peer, e.msg);
                markClosing("read-error");
                break;
            }
            if (n == 0) {
                if (!conn.connected) {
                    logInfo("bnc: sid=%s EOF from %s", sessionId, peer);
                    markClosing("remote-eof");
                    break;
                }
                continue;
            }
            lastRecvMs = nowMs();
            partial ~= cast(string) buf[0 .. n].idup;
            ptrdiff_t idx;
            while (!closing && (idx = partial.indexOf("\n")) >= 0) {
                auto line = partial[0 .. idx];
                partial = partial[idx + 1 .. $];
                if (line.length && line[$ - 1] == '\r') line = line[0 .. $ - 1];
                if (!line.length) continue;
                linesIn++;
                if (line.length > MAX_LINE) {
                    logWarn("bnc: sid=%s line too long (%d bytes) from %s", sessionId, line.length, peer);
                    send("ERROR :Closing link: Too long raw line");
                    markClosing("line-too-long");
                    break;
                }
                try handleLine(line);
                catch (Exception e) {
                    logWarn("bnc: handleLine failed for %s (%s): %s", peer, line.length > 64 ? line[0 .. 64] : line, e.msg);
                }
            }
            if (partial.length > MAX_LINE) {
                logWarn("bnc: sid=%s partial line too long (%d bytes) from %s", sessionId, partial.length, peer);
                send("ERROR :Closing link: Too long raw line");
                markClosing("line-too-long");
            }
        }
    }

    private void checkTimeouts() {
        const now = nowMs();
        if (now - lastRecvMs > DEAD_AFTER_MS) {
            logWarn("bnc: sid=%s idle timeout user=%s client=%s peer=%s idleRecv=%ss idleSend=%ss linesIn=%d linesOut=%d",
                sessionId, userId.length ? userId : "-", clientId.length ? clientId : "-",
                peer, (now - lastRecvMs) / 1000, (now - lastSendMs) / 1000, linesIn, linesOut);
            send("ERROR :Closing link: Timeout");
            markClosing("idle-timeout");
            return;
        }
        if (registered && now - lastRecvMs > KEEPALIVE_IDLE_MS && now - lastSendMs > KEEPALIVE_IDLE_MS) {
            logDebug("bnc: sid=%s PING (idle %ss)", sessionId, (now - lastRecvMs) / 1000);
            send("PING :" ~ src);
        }
    }

    // ── Admin presence (irc:bnc:client:<sid>) ────────────────────────

    /// Publishes this attachment for the admin bouncer page. Short TTL so a
    /// crashed bnc process leaves no ghosts; refreshed by `keepaliveLoop`.
    private void writePresence() nothrow {
        if (!registered || closing) return;
        try {
            string[] capList = caps.keys;
            auto j = Json.emptyObject;
            j["sid"] = sessionId;
            j["userId"] = userId;
            j["username"] = authUsername;
            j["networkId"] = networkId;
            j["networkName"] = networkName;
            j["clientId"] = clientId;
            j["nick"] = currentNick;
            j["peer"] = peer;
            j["tls"] = tls !is null;
            j["caps"] = Json(capList.length ? capList.join(",") : "");
            j["attachedAt"] = attachedAtMs;
            j["lastRecvMs"] = lastRecvMs;
            j["lastSendMs"] = lastSendMs;
            j["cursor"] = cursor;
            j["linesIn"] = linesIn;
            j["linesOut"] = linesOut;
            ctx.redis.setJson(RedisKeys.bncClient(sessionId), j, PRESENCE_TTL_SECONDS);
            ctx.redis.getDb().sadd(RedisKeys.bncClients(), sessionId);
        } catch (Exception e) {
            logDebug("bnc: presence write failed for %s: %s", sessionId, e.msg);
        }
    }

    private void clearPresence() nothrow {
        if (!registered) return;
        try {
            ctx.redis.getDb().srem(RedisKeys.bncClients(), sessionId);
            ctx.redis.del(RedisKeys.bncClient(sessionId));
        } catch (Exception e) {
            logDebug("bnc: presence clear failed for %s: %s", sessionId, e.msg);
        }
    }

    /// Writes a `*status` NOTICE into the network's server log (Redis
    /// scrollback + Mongo + live stream), exactly like an engine event, so
    /// the web app shows who attached through the bouncer instead of the
    /// blank MODE/ISON reply rows clients used to leave behind.
    private void emitStatusEvent(string text) nothrow {
        try {
            auto serverId = ctx.registry.getServerForNetwork(networkId);
            if (!serverId.length) return;
            auto ev = IRCRawEvent(networkName, "NOTICE");
            ev.networkId = networkId;
            ev.nick = "*status";
            ev.hostmask = "bnc@" ~ src;
            ev.prefix = "*status!bnc@" ~ src;
            ev.text = text;
            ev.setParams([currentNick.length ? currentNick : clientNick, text]);
            ev.eid = ctx.redis.incr(RedisKeys.globalEid());
            ctx.bufferManager.appendIRCEvent(ev, serverId);
            try ctx.messageRepo.appendIRCEvent(ev, serverId);
            catch (Exception e) logWarn("bnc: status row Mongo write failed: %s", e.msg);
            auto json = ev.toCompactJson();
            json["y"] = "irc_event";
            json["serverId"] = serverId;
            auto msg = json.toString();
            ctx.redis.publish(RedisKeys.events(userId), msg);
            auto streamKey = RedisKeys.userStream(userId);
            ctx.redis.getDb().lpush(streamKey, msg);
            ctx.redis.getDb().ltrim(streamKey, 0, 999);
        } catch (Exception e) {
            logWarn("bnc: status event failed for %s: %s", networkId, e.msg);
        }
    }

    private string clientDescription() const {
        import std.array : join;
        string d = "from " ~ peer ~ (tls !is null ? " (TLS)" : " (plaintext)");
        d ~= clientId.length ? ", client \"" ~ clientId ~ "\"" : ", no clientid";
        return d;
    }

    private void teardown() {
        closing = true;
        stopSubscriber();
        if (!revoked) flushCursor(true);
        clearPresence();
        if (registered && networkId.length) {
            const secs = (nowMs() - attachedAtMs) / 1000;
            emitStatusEvent("Bouncer client disconnected " ~ clientDescription()
                ~ " after " ~ formatDuration(secs) ~ (revoked ? " (password revoked)" : ""));
        }
        // Let the writer drain queued lines (e.g. the ERROR) briefly.
        try outbound.close(); catch (Exception) {}
        int waited = 0;
        while (writerTask.running && waited < 40) { sleep(50.msecs); waited++; }
        closeSocket();
        try writerTask.join(); catch (Exception) {}
        if (keepaliveTask != Task.init) { try keepaliveTask.join(); catch (Exception) {} }
        {
            // One summary line per connection at info so drops are always
            // diagnosable: the reason names the original cause (first wins),
            // idleRecv/idleSend show how silent it was before going down.
            const now = nowMs();
            logInfo("bnc: closed sid=%s reason=%s reg=%s user=%s network=%s client=%s nick=%s peer=%s tls=%s dur=%ss in=%d out=%d idleRecv=%ss idleSend=%ss",
                sessionId, closeReason.length ? closeReason : "unknown",
                registered ? "yes" : "no",
                userId.length ? userId : "-", networkId.length ? networkId : "-",
                clientId.length ? clientId : "-", displayNick(), peer, tls !is null,
                registered ? (now - attachedAtMs) / 1000 : 0, linesIn, linesOut,
                (now - lastRecvMs) / 1000, (now - lastSendMs) / 1000);
        }
    }

    // ── Registration ─────────────────────────────────────────────────

    private void status(string text) {
        send(formatLine(null, "*status!bnc@" ~ src, "NOTICE", [displayNick(), text]));
    }

    private string displayNick() const {
        return currentNick.length ? currentNick : clientNick;
    }

    private void numeric(string code, string[] params) {
        send(formatLine(null, src, code, [displayNick()] ~ params));
    }

    private void handleLine(string line) {
        auto pl = parseClientLine(line);
        if (!pl.command.length) return;
        traceLine("C>", pl.command == "PASS" ? "PASS <redacted>" : line);
        switch (pl.command) {
            case "PING":
                send("PONG :" ~ (pl.params.length ? pl.params[0] : src));
                return;
            case "PONG":
                return;
            case "QUIT":
                logInfo("bnc: sid=%s QUIT from %s (%s)", sessionId, displayNick(), peer);
                markClosing("quit");
                return;
            case "CAP":
                handleCap(pl.params);
                return;
            default:
                break;
        }
        if (registered) { handleClientLine(pl); return; }

        switch (pl.command) {
            case "PASS":
                if (!pl.params.length) { numeric("461", ["PASS", "Not enough parameters"]); return; }
                passRaw = pl.params[0];
                gotPass = true;
                tryRegister();
                break;
            case "NICK":
                if (!pl.params.length) { numeric("431", ["No nickname given"]); return; }
                clientNick = pl.params[0];
                gotNick = true;
                tryRegister();
                break;
            case "USER":
                userParam = pl.params.length ? pl.params[0] : "";
                gotUser = true;
                tryRegister();
                break;
            case "AUTHENTICATE":
                handleAuthenticate(pl.params.length ? pl.params[0] : "");
                break;
            case "BOUNCER": {
                const sub = pl.params.length ? pl.params[0].toUpper() : "";
                if (sub == "BIND") {
                    if (pl.params.length < 2 || !pl.params[1].length) {
                        send(formatLine(null, src, "FAIL", ["BOUNCER", "INVALID_NETID", "BIND", "*", "Network not found"]));
                        return;
                    }
                    pendingBindId = pl.params[1];
                } else {
                    send(formatLine(null, src, "FAIL", ["BOUNCER", "ACCOUNT_REQUIRED", sub.length ? sub : "*", "Authentication required"]));
                }
                break;
            }
            default:
                // Anything else before registration is ignored.
                break;
        }
    }

    /// Pre-registration SASL PLAIN. Failure leaves the connection open so
    /// the client can retry or fall back to PASS.
    private void handleAuthenticate(string param) {
        if (!has("sasl")) { numeric("904", ["SASL authentication failed"]); return; }
        if (saslPlainPending) {
            saslPlainPending = false;
            if (param == "*") { numeric("906", ["SASL authentication aborted"]); return; }
            auto p = parseSaslPlain(param);
            if (!p.ok || !authenticate(parseBncIdentity(p.authcid), p.password)) {
                numeric("904", ["SASL authentication failed"]);
                return;
            }
            numeric("900", [displayNick() ~ "!" ~ authUsername ~ "@" ~ src, authUsername,
                "You are now logged in as " ~ authUsername]);
            numeric("903", ["SASL authentication successful"]);
            return;
        }
        if (param.toUpper() == "PLAIN") {
            send("AUTHENTICATE +");
            saslPlainPending = true;
            return;
        }
        numeric("908", ["PLAIN", "are available SASL mechanisms"]);
        numeric("904", ["SASL authentication failed"]);
    }

    private void handleCap(string[] params) {
        if (!params.length) return;
        const sub = params[0].toUpper();
        string arg = params.length > 1 ? params[1] : "";
        switch (sub) {
            case "LS":
                inCap = true;
                int ver = 0;
                try ver = arg.length ? arg.to!int : 0; catch (Exception) {}
                cap302 = ver >= 302;
                string[] offered;
                foreach (c; OFFERED_CAPS) offered ~= (c == "sasl" && cap302) ? "sasl=PLAIN" : c;
                send(formatLine(null, src, "CAP", [displayNick(), "LS", offered.join(" ")]));
                break;
            case "REQ": {
                inCap = true;
                bool ok = true;
                string[] add, del;
                foreach (tok; arg.split(" ")) {
                    if (!tok.length) continue;
                    if (tok.startsWith("-")) {
                        const name = tok[1 .. $];
                        if (!OFFERED_CAPS.canFind(name)) { ok = false; break; }
                        del ~= name;
                    } else {
                        if (!OFFERED_CAPS.canFind(tok)) { ok = false; break; }
                        add ~= tok;
                    }
                }
                if (ok) {
                    foreach (n; add) caps[n] = true;
                    foreach (n; del) caps.remove(n);
                }
                send(formatLine(null, src, "CAP", [displayNick(), ok ? "ACK" : "NAK", arg]));
                break;
            }
            case "LIST":
                send(formatLine(null, src, "CAP", [displayNick(), "LIST", caps.keys.join(" ")]));
                break;
            case "END":
                inCap = false;
                tryRegister();
                break;
            default:
                numeric("410", [sub.length ? sub : "*", "Invalid CAP command"]);
                break;
        }
    }

    /// Looks the identity up and checks the bouncer password. On success
    /// sets `userId`, `authUsername`, `clientId` and `networkSel`.
    private bool authenticate(BncIdentity id, string token) {
        if (!id.ok || !token.length) return false;
        auto u = ctx.userRepo.findByUsernameCI(id.username);
        if (u.id == UUID.init) return false;
        auto stored = ctx.userRepo.getBncToken(u.id);
        if (!stored.length || stored.length != token.length
            || !secureEqual(cast(const(ubyte)[]) stored, cast(const(ubyte)[]) token)) return false;
        userId = u.id.toString();
        authUsername = u.username;
        clientId = id.clientId;
        networkSel = id.network;
        authed = true;
        return true;
    }

    private void tryRegister() {
        if (inCap || registered || !gotNick || !gotUser) return;
        if (!authed) {
            if (!gotPass) {
                numeric("464", ["Password required"]);
                send("ERROR :Closing link: Password required");
                markClosing("no-password");
                return;
            }
            auto p = parseBncPass(passRaw);
            auto ident = p.hasIdentity ? p.identity : parseBncIdentity(userParam);
            if (!p.ok || !authenticate(ident, p.token)) {
                numeric("464", ["Invalid username or bouncer password"]);
                send("ERROR :Closing link: Invalid password");
                markClosing("bad-password");
                return;
            }
        }
        if (!resolveBinding()) return;
        attach();
    }

    private NetworkConfig[] userNetworks() {
        try return ctx.networkRepo.findByUserId(parseUUID(userId.idup));
        catch (Exception e) {
            logWarn("bnc: sid=%s network list failed for %s: %s", sessionId, userId, e.msg);
            return null;
        }
    }

    private static string slugList(NetworkConfig[] nets) {
        string[] slugs;
        foreach (ref n; nets) slugs ~= networkSlug(n.name);
        return slugs.length ? slugs.join(", ") : "none";
    }

    /// Picks the network for this connection: `BOUNCER BIND`, then the
    /// identity suffix, then the ZNC convenience of a lone network for
    /// clients without `bouncer-networks`. Returns false after sending the
    /// error and closing.
    private bool resolveBinding() {
        auto nets = userNetworks();
        NetworkConfig chosen;
        if (pendingBindId.length) {
            foreach (ref cfg; nets) if (cfg.id.toString() == pendingBindId) { chosen = cfg; break; }
            if (chosen.id == UUID.init) {
                send(formatLine(null, src, "FAIL", ["BOUNCER", "INVALID_NETID", "BIND", pendingBindId, "Network not found"]));
                send("ERROR :Closing link: Unknown network");
                markClosing("bad-bind");
                return false;
            }
        } else if (networkSel.length) {
            const wantSlug = networkSlug(networkSel);
            foreach (ref cfg; nets) if (cfg.id.toString() == networkSel) { chosen = cfg; break; }
            if (chosen.id == UUID.init && wantSlug.length)
                foreach (ref cfg; nets) if (networkSlug(cfg.name) == wantSlug) { chosen = cfg; break; }
            if (chosen.id == UUID.init)
                foreach (ref cfg; nets) if (icmp(cfg.host, networkSel) == 0) { chosen = cfg; break; }
            if (chosen.id == UUID.init) {
                send("ERROR :Closing link: Unknown network \"" ~ networkSel ~ "\" — yours: " ~ slugList(nets));
                markClosing("bad-network");
                return false;
            }
        } else if (!has("soju.im/bouncer-networks") && nets.length == 1) {
            chosen = nets[0];
        }
        if (chosen.id != UUID.init) {
            networkId = chosen.id.toString();
            networkName = chosen.name;
        }
        return true;
    }

    private bool has(string cap) const nothrow {
        return (cap in caps) !is null;
    }

    private FormatCtx formatCtx() {
        FormatCtx f;
        f.src = src;
        f.nick = currentNick;
        f.networkName = networkName;
        f.sessionId = sessionId;
        f.caps = caps;
        f.prefixChars = prefixChars;
        f.recentOwn = &recentOwn;
        return f;
    }

    // ── Attach (ZNC ClientConnected / AttachUser) ────────────────────

    private void attach() {
        registered = true;
        // Subscribe first so nothing published during the burst is lost;
        // events are parked in `pendingLive` until the replay cursor is known.
        startSubscriber();
        if (networkId.length == 0) { attachUnbound(); return; }

        auto serverId = ctx.registry.getServerForNetwork(networkId);
        auto snap = loadNetworkStateSnapshot(ctx.redis, ctx.registry, networkId);
        currentNick = snap.currentNick.length ? snap.currentNick : clientNick;
        if (auto pfx = "PREFIX" in snap.isupport) prefixChars = prefixCharsFromIsupport(*pfx);

        string chanModes = "ov";
        if (auto cm = "CHANMODES" in snap.isupport) {
            string letters;
            foreach (ch; *cm) if (ch != ',') letters ~= ch;
            if (letters.length) chanModes = letters;
        }

        sendWelcome(chanModes);
        {
            string[] toks;
            foreach (k, v; snap.isupport) {
                // The bouncer answers CHATHISTORY itself; hide the upstream's tokens.
                if (k == "CHATHISTORY" || k == "draft/CHATHISTORY" || k == "MSGREFTYPES") continue;
                toks ~= v.length ? k ~ "=" ~ v : k;
            }
            toks ~= "CHATHISTORY=" ~ CHATHISTORY_MAX.to!string;
            toks ~= "MSGREFTYPES=timestamp,msgid";
            // Clients without bouncer-networks ignore the unknown token.
            toks ~= "BOUNCER_NETID=" ~ networkId;
            foreach (i; 0 .. (toks.length + 12) / 13) {
                auto slice = toks[i * 13 .. min(toks.length, (i + 1) * 13)];
                send(formatLine(null, src, "005", [clientNick] ~ slice ~ ["are supported by this server"]));
            }
        }
        // Network-attached: don't fake the upstream; let /MOTD fetch the
        // real server MOTD via the engine (handleClientLine routes "MOTD"
        // as raw -> engine -> ircd -> 372/376 live).
        send(formatLine(null, src, "422", [clientNick, "MOTD File is missing - Use /MOTD to read the message of the day from " ~ networkName]));
        if (has("soju.im/bouncer-networks-notify")) sendNetworkList();
        if (clientNick != currentNick) {
            send(formatLine(null, clientNick ~ "!" ~ clientNick ~ "@" ~ src, "NICK", [currentNick]));
        }
        if (snap.isAway) numeric("306", ["You have been marked as being away"]);

        if (!snap.connected) {
            status("Not connected to " ~ networkName ~ (snap.status.length ? " (" ~ snap.status ~ ")" : ""));
        } else {
            dumpChannels(snap);
        }

        auto historySeen = sendHistory(serverId, snap);
        liveReady = true;
        auto parked = pendingLive;
        pendingLive = null;
        // Dedupe IRC live park (Redis events) vs MongoDB history (missed+playback).
        // Both may contain the same eid/m during the attach window; without this
        // the client renders every history row twice.
        foreach (ev; parked) {
            if (ev.type != Json.Type.object) continue;
            string hkey;
            if (ev["ch"].type == Json.Type.string) hkey = ev["ch"].get!string;
            if (!hkey.length && ev["n"].type == Json.Type.string) hkey = ev["n"].get!string;
            if (hkey.length) {
                const dk = hkey.toLower() ~ "\0" ~ dedupeKey(ev);
                if (dk in historySeen) continue;
            }
            // Also respect the cursor check inside deliverLive, but the
            // historySeen filter covers the IRC-vs-Mongo overlap that the
            // cursor alone misses (different codepaths, same eid).
            deliverLive(ev);
        }
        flushCursor(true);

        attachedAtMs = nowMs();
        writePresence();
        {
            string[] capList = caps.keys;
            import std.algorithm : sort;
            sort(capList);
            emitStatusEvent("Bouncer client connected " ~ clientDescription()
                ~ (capList.length ? ", caps: " ~ capList.join(" ") : ", no caps"));
        }
        keepaliveTask = runTask(&keepaliveLoop);
        logInfo("bnc: attached sid=%s user=%s network=%s client=%s nick=%s peer=%s caps=%s",
            sessionId, userId, networkId, clientId.length ? clientId : "-", currentNick, peer, caps.keys.join(","));
    }

    private void sendWelcome(string chanModes) {
        send(formatLine(null, src, "001", [clientNick, "Welcome to the IRC Fiber bouncer, " ~ clientNick]));
        send(formatLine(null, src, "002", [clientNick, "Your host is " ~ src ~ ", running IRC Fiber"]));
        send(formatLine(null, src, "003", [clientNick, "This server was created for you"]));
        send(formatLine(null, src, "004", [clientNick, src, "irc-fiber-bnc", "iw", chanModes]));
    }

    /// Bouncer-level registration (soju "no network" connection): the
    /// bouncer MOTD from IRCFIBER_BNC_MOTD_PATH (re-read per connection so
    /// editing the file needs no restart), no 005, no channels — only the
    /// BOUNCER command surface until the client binds on a new connection.
    private void attachUnbound() {
        currentNick = clientNick;
        sendWelcome("");
        send(formatLine(null, src, "375", [clientNick, "- " ~ src ~ " Message of the Day -"]));
        foreach (line; loadBouncerMotd())
            send(formatLine(null, src, "372", [clientNick, "- " ~ line]));
        send(formatLine(null, src, "376", [clientNick, "End of /MOTD command"]));
        if (has("soju.im/bouncer-networks-notify")) sendNetworkList();
        status("Not bound to a network — use BOUNCER BIND, or connect with username "
            ~ authUsername ~ "/<network>. Your networks: " ~ slugList(userNetworks()));
        liveReady = true;
        pendingLive = null;
        attachedAtMs = nowMs();
        writePresence();
        keepaliveTask = runTask(&keepaliveLoop);
        logInfo("bnc: attached sid=%s user=%s network=- client=%s nick=%s peer=%s caps=%s",
            sessionId, userId, clientId.length ? clientId : "-", currentNick, peer, caps.keys.join(","));
    }

    // ── soju.im/bouncer-networks ─────────────────────────────────────

    /// Attribute pairs for one network, spec names: name host port tls
    /// nickname realname [state].
    private string[2][] networkAttrs(ref const NetworkConfig cfg, bool withState = true) {
        string[2][] pairs = [
            ["name", cfg.name],
            ["host", cfg.host],
            ["port", cfg.port.to!string],
            ["tls", cfg.tls == TLSMode.disabled ? "0" : "1"],
            ["nickname", cfg.nick],
            ["realname", cfg.realName],
        ];
        if (withState) {
            auto snap = loadNetworkStateSnapshot(ctx.redis, ctx.registry, cfg.id.toString());
            const st = snap.connected ? "connected"
                : (snap.status == "connecting" ? "connecting" : "disconnected");
            lastNetState[cfg.id.toString()] = st;
            pairs ~= ["state", st];
        }
        return pairs;
    }

    private void sendBouncerNetwork(string netid, string attrsOrStar, string batchRef = "") {
        string[string] tags;
        if (batchRef.length) tags["batch"] = batchRef;
        send(formatLine(tags, src, "BOUNCER", ["NETWORK", netid, attrsOrStar]));
    }

    /// `LISTNETWORKS` body and the initial list for `-notify` clients.
    private void sendNetworkList() {
        auto nets = userNetworks();
        string batchRef;
        if (has("batch")) {
            batchRef = "bn" ~ (++seq).to!string;
            send(formatLine(null, src, "BATCH", ["+" ~ batchRef, "soju.im/bouncer-networks"]));
        }
        foreach (ref cfg; nets)
            sendBouncerNetwork(cfg.id.toString(), formatBouncerAttrs(networkAttrs(cfg)), batchRef);
        if (batchRef.length) send(formatLine(null, src, "BATCH", ["-" ~ batchRef]));
    }

    private void bouncerFail(string code, string[] params, string text) {
        send(formatLine(null, src, "FAIL", ["BOUNCER", code] ~ params ~ [text]));
    }

    /// Loads a network the authenticated user owns; `UUID.init` id (after
    /// the FAIL reply) when unknown or someone else's.
    private NetworkConfig ownedNetwork(string sub, string netid) {
        NetworkConfig none;
        UUID id;
        try id = parseUUID(netid.idup);
        catch (Exception) { bouncerFail("INVALID_NETID", [sub, netid], "Network not found"); return none; }
        auto info = ctx.networkRepo.findByIdWithUser(id);
        if (info.config.id == UUID.init || (info.userId != UUID.init && info.userId.toString() != userId)) {
            bouncerFail("INVALID_NETID", [sub, netid], "Network not found");
            return none;
        }
        return info.config;
    }

    /// Attribute keys a client may set; `username`/`state` are read-only.
    private static immutable string[] WRITABLE_ATTRS = ["name", "host", "port", "tls", "nickname", "realname", "pass"];

    /// Applies `attrs` onto `cfg`. Returns false after a FAIL reply.
    private bool applyNetworkAttrs(string sub, string netidParam, ref NetworkConfig cfg, string[string] attrs) {
        foreach (k, v; attrs) {
            if (k == "username" || k == "state") {
                bouncerFail("READ_ONLY_ATTRIBUTE", [sub, netidParam, k], "Read-only attribute");
                return false;
            }
            if (!WRITABLE_ATTRS.canFind(k)) {
                bouncerFail("UNKNOWN_ATTRIBUTE", [sub, netidParam, k], "Unknown attribute");
                return false;
            }
        }
        if (auto v = "tls" in attrs) {
            if (*v == "1") cfg.tls = TLSMode.required;
            else if (*v == "0") cfg.tls = TLSMode.disabled;
            else { bouncerFail("INVALID_ATTRIBUTE", [sub, netidParam, "tls"], "tls must be 0 or 1"); return false; }
        }
        if (auto v = "host" in attrs) {
            cfg.host = normalizeHost(*v);
            if (!cfg.host.length) { bouncerFail("INVALID_ATTRIBUTE", [sub, netidParam, "host"], "Invalid host"); return false; }
        }
        if (auto v = "port" in attrs) {
            int port = 0;
            try port = (*v).to!int; catch (Exception) port = 0;
            if (port <= 0 || port > 65_535) { bouncerFail("INVALID_ATTRIBUTE", [sub, netidParam, "port"], "Invalid port"); return false; }
            cfg.port = cast(ushort) port;
        }
        if (auto v = "name" in attrs) if ((*v).strip().length) cfg.name = (*v).strip();
        if (auto v = "nickname" in attrs) if ((*v).strip().length) cfg.nick = (*v).strip();
        if (auto v = "realname" in attrs) cfg.realName = *v;
        if (auto v = "pass" in attrs) cfg.serverPass = *v;
        return true;
    }

    /// Post-registration `BOUNCER` dispatcher. Works unbound.
    private void handleBouncer(string[] p) {
        const sub = p.length ? p[0].toUpper() : "";
        switch (sub) {
            case "LISTNETWORKS":
                sendNetworkList();
                return;
            case "BIND":
                bouncerFail("REGISTRATION_IS_COMPLETED", ["BIND"], "Cannot bind to a network after registration");
                return;
            case "ADDNETWORK": {
                auto attrs = parseBouncerAttrs(p.length > 1 ? p[1] : "");
                if ("host" !in attrs) { bouncerFail("NEED_ATTRIBUTE", ["ADDNETWORK", "host"], "Missing required attribute"); return; }
                NetworkConfig cfg;
                cfg.id = randomUUID();
                cfg.tls = TLSMode.required;
                cfg.autoJoinChannels = [];
                if (!applyNetworkAttrs("ADDNETWORK", "*", cfg, attrs)) return;
                if ("port" !in attrs) cfg.port = cfg.tls == TLSMode.disabled ? 6667 : 6697;
                if (!cfg.name.length) cfg.name = cfg.host;
                if (!cfg.nick.length) cfg.nick = authUsername;
                if (!cfg.realName.length) cfg.realName = cfg.nick;
                auto serverId = provisionNetwork(cfg, parseUUID(userId.idup), ctx.networkRepo, ctx.redis, ctx.registry);
                if (!serverId.length) { bouncerFail("TEMPORARILY_UNAVAILABLE", ["ADDNETWORK"], "No healthy connection servers available"); return; }
                send(formatLine(null, src, "BOUNCER", ["ADDNETWORK", cfg.id.toString()]));
                return;
            }
            case "CHANGENETWORK": {
                if (p.length < 2) { bouncerFail("INVALID_NETID", ["CHANGENETWORK", "*"], "Network not found"); return; }
                auto cfg = ownedNetwork("CHANGENETWORK", p[1]);
                if (cfg.id == UUID.init) return;
                auto attrs = parseBouncerAttrs(p.length > 2 ? p[2] : "");
                if (!attrs.length) { bouncerFail("NEED_ATTRIBUTE", ["CHANGENETWORK", "*"], "No attributes"); return; }
                if (!applyNetworkAttrs("CHANGENETWORK", p[1], cfg, attrs)) return;
                auto serverId = updateOwnedNetwork(cfg, parseUUID(userId.idup), false, ctx.networkRepo, ctx.redis, ctx.registry);
                if (!serverId.length) { bouncerFail("TEMPORARILY_UNAVAILABLE", ["CHANGENETWORK", p[1]], "No healthy connection servers available"); return; }
                send(formatLine(null, src, "BOUNCER", ["CHANGENETWORK", p[1]]));
                return;
            }
            case "DELNETWORK": {
                if (p.length < 2) { bouncerFail("INVALID_NETID", ["DELNETWORK", "*"], "Network not found"); return; }
                auto cfg = ownedNetwork("DELNETWORK", p[1]);
                if (cfg.id == UUID.init) return;
                if (cfg.systemManaged) { bouncerFail("READ_ONLY_NETWORK", ["DELNETWORK", p[1]], "This network is provisioned by IRC Fiber"); return; }
                deleteOwnedNetwork(cfg.id, parseUUID(userId.idup), ctx.networkRepo, ctx.redis, ctx.registry);
                send(formatLine(null, src, "BOUNCER", ["DELNETWORK", p[1]]));
                return;
            }
            default:
                bouncerFail("UNKNOWN_COMMAND", [sub.length ? sub : "*"], "Unknown subcommand");
                return;
        }
    }

    private void dumpChannels(ref NetworkStateSnapshot snap) {
        if (snap.buffers.type != Json.Type.array) return;
        string selfMask;
        string[][string] users;
        if (snap.users.type == Json.Type.object) {
            foreach (string k, v; snap.users) {
                string[] arr;
                if (v.type == Json.Type.array) foreach (item; v) if (item.type == Json.Type.string) arr ~= item.get!string;
                users[k] = arr;
                if (!selfMask.length) {
                    foreach (tok; arr) {
                        if (tok.canFind('!') && icmp(stripPrefix(tok, prefixChars), currentNick) == 0) {
                            size_t p = 0;
                            while (p < tok.length && prefixChars.canFind(tok[p])) p++;
                            selfMask = tok[p .. $];
                            break;
                        }
                    }
                }
            }
        }
        if (!selfMask.length) selfMask = currentNick ~ "!" ~ currentNick ~ "@" ~ src;

        const multi = has("multi-prefix");
        const uh = has("userhost-in-names");
        uint n = 0;
        foreach (buf; snap.buffers) {
            if (buf.type != Json.Type.object) continue;
            if (buf["type"].type != Json.Type.string || buf["type"].get!string != "channel") continue;
            if (buf["isJoined"].type != Json.Type.bool_ || !buf["isJoined"].get!bool) continue;
            const chan = buf["name"].type == Json.Type.string ? buf["name"].get!string : "";
            if (!chan.length) continue;

            if (has("extended-join")) send(formatLine(null, selfMask, "JOIN", [chan, "*", currentNick]));
            else send(formatLine(null, selfMask, "JOIN", [chan]));

            if (snap.topics.type == Json.Type.object) {
                auto t = chan in snap.topics;
                if (t !is null && t.type == Json.Type.string && t.get!string.length)
                    numeric("332", [chan, t.get!string]);
            }
            string[] toks;
            if (auto u = chan in users) {
                // The engine keeps both the bare JOIN entry and the
                // userhost-in-names entry for the same nick; collapse them.
                size_t[string] seen;
                foreach (tok; *u) {
                    auto adapted = adaptNameToken(tok, multi, uh, prefixChars);
                    auto key = stripPrefix(adapted, prefixChars).toLower();
                    if (auto idx = key in seen) {
                        if (adapted.length > toks[*idx].length) toks[*idx] = adapted;
                        continue;
                    }
                    seen[key] = toks.length;
                    toks ~= adapted;
                }
            }
            foreach (line; chunkNames(":" ~ src ~ " 353 " ~ currentNick ~ " = " ~ chan ~ " :", toks)) send(line);
            numeric("366", [chan, "End of /NAMES list."]);
            if (++n % 20 == 0) yield();
        }
    }

    // ── Backlog replay ───────────────────────────────────────────────

    private long readGlobalEid() {
        try {
            auto s = ctx.redis.getDb().get!string(RedisKeys.globalEid());
            return s.length ? s.to!long : 0;
        } catch (Exception) { return 0; }
    }

    /// Messages this clientid missed since its last visit (updates `cursor`).
    /// Empty for anonymous clients and for a clientid's first attach.
    // Set by fetchMissed: true when this clientid had prior bncSeen state.
    // sendHistory uses it to decide playback vs missed-only without a
    // second Redis read (which races the previous connection's teardown
    // flush when reconnecting within ~2s).
    bool hadPriorBncSeen = false;

    // Effective cursor key: named clientid when present, else per-nick
    // fallback so anonymous (`bnc:<token>` with no @clientid, e.g. Zodih4x)
    // still gets missed-only on reconnect instead of full 408 replay.
    // Nick is lower-cased (IRC nicks are case-insensitive).
    private string cursorKey() {
        if (clientId.length) return clientId;
        try {
            string n = currentNick.length ? currentNick : clientNick;
            n = n.strip().toLower();
            if (n.length && n != "*") return "anon:" ~ n;
        } catch (Exception) {}
        return "";
    }

    Json[] fetchMissed(string serverId) {
        const globalEid = readGlobalEid();
        hadPriorBncSeen = false;
        string ckey = cursorKey();
        if (!ckey.length) { cursor = globalEid; return null; }

        string seenStr;
        try seenStr = ctx.redis.getDb().hget!string(RedisKeys.bncSeen(networkId), ckey);
        catch (Exception) {}
        long seen = 0;
        if (seenStr.length) { try seen = seenStr.to!long; catch (Exception) seen = 0; }
        if (seen <= 0) {
            // First connect of this cursor key: nothing was ever delivered.
            cursor = globalEid;
            return null;
        }
        hadPriorBncSeen = true;
        cursor = seen;
        if (!serverId.length) { cursor = max(cursor, globalEid); return null; }

        Json[] events;
        try events = ctx.messageRepo.getAfterEidForNetwork(serverId, networkId, seen, REPLAY_LIMIT);
        catch (Exception e) {
            logWarn("bnc: backlog fetch failed for %s: %s", networkId, e.msg);
            cursor = max(cursor, globalEid);
            return null;
        }
        foreach (ev; events) {
            if (ev.type != Json.Type.object) continue;
            // Everything fetched (kept or not) is now "seen".
            if (ev["eid"].type == Json.Type.int_) cursor = max(cursor, ev["eid"].get!long);
        }
        // Timestamp of the cursor row: backfill copies of already-seen
        // messages have fresh eids but old timestamps. Anything batched at
        // or before it is old history (skip); anything newer is genuinely
        // missed — even when mis-tagged with a batch marker. Unknown (-1)
        // keeps the old skip-all-batched behaviour.
        long seenTs = -1;
        try seenTs = ctx.messageRepo.timestampOfEid(serverId, networkId, seen);
        catch (Exception e) logWarn("bnc: cursor timestamp lookup failed for %s: %s", networkId, e.msg);
        if (seenTs == 0) seenTs = -1;
        auto keep = filterMissedRows(events, seenTs);
        if (events.length < REPLAY_LIMIT) cursor = max(cursor, globalEid);
        return keep;
    }

    private alias isChatRow = isBncChatRow;
    // Single source of truth lives in ircfiber.bnc.wire (unit-tested):
    // the msgid identifies one upstream message across live + backfill
    // copies, so it keys before the per-store eid.
    private alias dedupeKey = bncRowKey;

    /// Buffers whose history the attached client may see: joined channels
    /// and private-message queries from the engine snapshot.
    private static string[] historyBuffers(ref NetworkStateSnapshot snap) {
        string[] names;
        if (snap.buffers.type != Json.Type.array) return names;
        foreach (buf; snap.buffers) {
            if (buf.type != Json.Type.object) continue;
            const type = buf["type"].type == Json.Type.string ? buf["type"].get!string : "";
            const name = buf["name"].type == Json.Type.string ? buf["name"].get!string : "";
            if (!name.length) continue;
            if (type == "channel") {
                if (buf["isJoined"].type == Json.Type.bool_ && buf["isJoined"].get!bool) names ~= name;
            } else if (type == "query") {
                names ~= name;
            }
        }
        return names;
    }

    /// ZNC-style playback: the newest N chat rows of every buffer.
    private Json[] fetchPlayback(string serverId, ref NetworkStateSnapshot snap) {
        int n = 0;
        try n = clampBncPlaybackLines(ctx.prefsRepo.load(UUID(userId)).bncPlaybackLines);
        catch (Exception e) { logWarn("bnc: prefs load failed for %s: %s", userId, e.msg); }
        if (n <= 0) return null;
        Json[] rows;
        uint i = 0;
        foreach (name; historyBuffers(snap)) {
            Json[] evs;
            try evs = ctx.messageRepo.getWindow(serverId, networkId, name, 0, 0, n, true);
            catch (Exception e) { logWarn("bnc: playback fetch failed for %s/%s: %s", networkId, name, e.msg); continue; }
            foreach (ev; evs) if (isChatRow(ev)) rows ~= ev;
            if (++i % 10 == 0) yield();
        }
        logInfo("bnc: playback user=%s network=%s server=%s buffers=%d lines=%d rows=%d",
            userId, networkId, serverId, i, n, rows.length);
        return rows;
    }

    private static long rowTime(ref Json ev) {
        return ev["t"].type == Json.Type.int_ ? ev["t"].get!long : 0;
    }
    private static long rowEid(ref Json ev) {
        return ev["eid"].type == Json.Type.int_ ? ev["eid"].get!long : 0;
    }

    /// Attach history: what a named client missed, merged with the
    /// playback buffer for clients that cannot page with CHATHISTORY.
    /// Returns the dedup keys that were actually sent so the live
    /// `pendingLive` park (IRC history vs MongoDB history) can be
    /// deduped against it.
    private bool[string] sendHistory(string serverId, ref NetworkStateSnapshot snap) {
        auto rows = fetchMissed(serverId);
        // Playback must only go to first-connect clients — otherwise every
        // reconnect replays the same newest N per buffer (verified live:
        // same clientid got 590 total / 408 PRIVMSG twice). Missed (eid >
        // prior seen) already covers what arrived while away; playback rows
        // often lack eid (old backlog) so eid-filtering can't be trusted.
        // Rule: cursor key (clientid or anon:nick) with prior bncSeen gets
        // missed-only; first connect gets full playback.
        if (!has("draft/chathistory") && serverId.length) {
            if (!hadPriorBncSeen) {
                rows ~= fetchPlayback(serverId, snap);
            }
        }
        if (!rows.length) return null;

        // Merge per buffer, dedupe, oldest first.
        Json[][string] groups;
        string[] order;
        bool[string] seen;
        foreach (ev; rows) {
            string key;
            if (ev["ch"].type == Json.Type.string) key = ev["ch"].get!string;
            if (!key.length && ev["n"].type == Json.Type.string) key = ev["n"].get!string;
            if (!key.length) continue;
            const dk = key.toLower() ~ "\0" ~ dedupeKey(ev);
            if (dk in seen) continue;
            seen[dk] = true;
            if (key !in groups) order ~= key;
            groups[key] ~= ev;
        }
        import std.algorithm : sort;
        foreach (target; order) {
            auto evs = groups[target];
            sort!((a, b) => rowTime(a) != rowTime(b) ? rowTime(a) < rowTime(b) : rowEid(a) < rowEid(b))(evs);
            sendHistoryBatch(target, evs);
        }
        return seen;
    }

    /// Emits `evs` for `target` as a `chathistory` batch (plain lines
    /// without the `batch` cap). Clients without `server-time` get ZNC's
    /// `[HH:MM:SS]` text prefix so the replay is not mistaken for live chat.
    private void sendHistoryBatch(string target, Json[] evs) {
        auto f = formatCtx();
        const prefixTime = !has("server-time");
        string batchRef;
        if (has("batch")) {
            batchRef = randomUUID().toString()[0 .. 8];
            send(formatLine(null, src, "BATCH", ["+" ~ batchRef, "chathistory", target]));
        }
        uint n = 0;
        foreach (ev; evs) {
            if (prefixTime) {
                const t = rowTime(ev);
                if (t > 0) {
                    const pfx = playbackTimePrefix(t);
                    if (ev["x"].type == Json.Type.string) ev["x"] = pfx ~ ev["x"].get!string;
                    if (ev["p"].type == Json.Type.array && ev["p"].length >= 2 && ev["p"][1].type == Json.Type.string)
                        ev["p"][1] = pfx ~ ev["p"][1].get!string;
                }
            }
            auto line = formatEvent(ev, f);
            if (!line.length) continue;
            if (batchRef.length) {
                line = line.startsWith("@") ? "@batch=" ~ batchRef ~ ";" ~ line[1 .. $]
                                            : "@batch=" ~ batchRef ~ " " ~ line;
            }
            send(line);
            if (++n % 50 == 0) yield();
        }
        if (batchRef.length) send(formatLine(null, src, "BATCH", ["-" ~ batchRef]));
    }

    // ── IRCv3 CHATHISTORY ────────────────────────────────────────────

    private void historyFail(string code, string[] params, string text) {
        send(formatLine(null, src, "FAIL", ["CHATHISTORY", code] ~ params ~ [text]));
    }

    /// Resolves a reference to a unix-ms timestamp. `*` → 0 (unbounded);
    /// unknown msgid → -1.
    private long resolveRef(string serverId, string target, HistoryRef r) {
        final switch (r.kind) {
            case "*": return 0;
            case "timestamp": return r.ts;
            case "msgid":
                long ts = 0;
                try ts = ctx.messageRepo.timestampOfMsgid(serverId, networkId, target, r.msgid);
                catch (Exception) {}
                return ts > 0 ? ts : -1;
            case "": return -1;
        }
    }

    private static int parseLimit(string s) {
        int n = 0;
        try n = s.to!int; catch (Exception) n = 0;
        if (n <= 0) return 0;
        return n > CHATHISTORY_MAX ? CHATHISTORY_MAX : n;
    }

    private void handleChatHistory(string[] p) {
        if (!p.length) { historyFail("NEED_MORE_PARAMS", [], "Missing subcommand"); return; }
        const sub = p[0].toUpper();
        auto serverId = ctx.registry.getServerForNetwork(networkId);

        if (sub == "TARGETS") {
            if (p.length < 4) { historyFail("NEED_MORE_PARAMS", [sub], "Need two timestamps and a limit"); return; }
            auto r1 = parseHistoryRef(p[1]);
            auto r2 = parseHistoryRef(p[2]);
            if (!r1.ok || !r2.ok || r1.kind == "msgid" || r2.kind == "msgid") {
                historyFail("INVALID_PARAMS", [sub], "TARGETS takes timestamp references");
                return;
            }
            const limit = parseLimit(p[3]);
            if (!limit) { historyFail("INVALID_PARAMS", [sub], "Invalid limit"); return; }
            long lo = min(r1.ts, r2.ts), hi = max(r1.ts, r2.ts);
            if (r1.kind == "*" || r2.kind == "*") { lo = r1.kind == "*" ? r2.ts : r1.ts; hi = 0; if (r1.kind == "*" && r2.kind == "*") lo = 0; }
            auto snap = loadNetworkStateSnapshot(ctx.redis, ctx.registry, networkId);
            struct T { string name; long ts; }
            T[] found;
            foreach (name; historyBuffers(snap)) {
                long ts = 0;
                try ts = ctx.messageRepo.latestTimestamp(serverId, networkId, name, lo, hi);
                catch (Exception) {}
                if (ts > 0) found ~= T(name, ts);
            }
            import std.algorithm : sort;
            sort!((a, b) => a.ts < b.ts)(found);
            if (found.length > limit) found = found[0 .. limit];
            string batchRef;
            if (has("batch")) {
                batchRef = randomUUID().toString()[0 .. 8];
                send(formatLine(null, src, "BATCH", ["+" ~ batchRef, "draft/chathistory-targets"]));
            }
            foreach (t; found) {
                auto line = formatLine(null, src, "CHATHISTORY", ["TARGETS", t.name, serverTimeTag(t.ts)]);
                if (batchRef.length) line = "@batch=" ~ batchRef ~ " " ~ line;
                send(line);
            }
            if (batchRef.length) send(formatLine(null, src, "BATCH", ["-" ~ batchRef]));
            return;
        }

        const needed = sub == "BETWEEN" ? 5 : 4;
        if (p.length < needed) { historyFail("NEED_MORE_PARAMS", [sub], "Not enough parameters"); return; }
        const target = p[1];
        if (!target.length || target.startsWith("*")) { historyFail("INVALID_TARGET", [sub, target], "Unknown target"); return; }
        const limit = parseLimit(p[needed - 1]);
        if (!limit) { historyFail("INVALID_PARAMS", [sub, target], "Invalid limit"); return; }

        auto r1 = parseHistoryRef(p[2]);
        if (!r1.ok) { historyFail("INVALID_PARAMS", [sub, target, p[2]], "Invalid message reference"); return; }
        const ts1 = resolveRef(serverId, target, r1);
        if (ts1 < 0) { historyFail("INVALID_PARAMS", [sub, target, p[2]], "Unknown msgid"); return; }

        Json[] rows;
        try {
            switch (sub) {
                case "LATEST":
                    rows = ctx.messageRepo.getWindow(serverId, networkId, target, ts1, 0, limit, true);
                    break;
                case "BEFORE":
                    if (r1.kind == "*") { historyFail("INVALID_PARAMS", [sub, target, p[2]], "BEFORE needs a reference"); return; }
                    rows = ctx.messageRepo.getWindow(serverId, networkId, target, 0, ts1, limit, true);
                    break;
                case "AFTER":
                    if (r1.kind == "*") { historyFail("INVALID_PARAMS", [sub, target, p[2]], "AFTER needs a reference"); return; }
                    rows = ctx.messageRepo.getWindow(serverId, networkId, target, ts1, 0, limit, false);
                    break;
                case "AROUND": {
                    if (r1.kind == "*") { historyFail("INVALID_PARAMS", [sub, target, p[2]], "AROUND needs a reference"); return; }
                    const half = limit / 2;
                    rows = ctx.messageRepo.getWindow(serverId, networkId, target, 0, ts1, half, true)
                         ~ ctx.messageRepo.getWindow(serverId, networkId, target, ts1 - 1, 0, limit - half, false);
                    break;
                }
                case "BETWEEN": {
                    auto r2 = parseHistoryRef(p[3]);
                    if (!r2.ok) { historyFail("INVALID_PARAMS", [sub, target, p[3]], "Invalid message reference"); return; }
                    const ts2 = resolveRef(serverId, target, r2);
                    if (ts2 < 0) { historyFail("INVALID_PARAMS", [sub, target, p[3]], "Unknown msgid"); return; }
                    // Direction follows the order of the references (spec).
                    if (ts2 == 0 || (ts1 != 0 && ts1 < ts2))
                        rows = ctx.messageRepo.getWindow(serverId, networkId, target, ts1, ts2, limit, false);
                    else
                        rows = ctx.messageRepo.getWindow(serverId, networkId, target, ts2, ts1, limit, true);
                    break;
                }
                default:
                    historyFail("INVALID_PARAMS", [sub], "Unknown subcommand");
                    return;
            }
        } catch (Exception e) {
            logWarn("bnc: CHATHISTORY %s %s failed: %s", sub, target, e.msg);
            historyFail("MESSAGE_ERROR", [sub, target], "History lookup failed");
            return;
        }

        Json[] keep;
        bool[string] seen;
        foreach (ev; rows) {
            if (!isChatRow(ev)) continue;
            const dk = dedupeKey(ev);
            if (dk in seen) continue;
            seen[dk] = true;
            keep ~= ev;
        }
        import std.algorithm : sort;
        sort!((a, b) => rowTime(a) != rowTime(b) ? rowTime(a) < rowTime(b) : rowEid(a) < rowEid(b))(keep);
        sendHistoryBatch(target, keep);
    }

    private void flushCursor(bool force) {
        if (!networkId.length) return;
        string ckey = cursorKey();
        if (!ckey.length) return;
        if (cursor <= flushedCursor) return;
        const now = nowMs();
        if (!force && now - lastFlushMs < CURSOR_FLUSH_MS) return;
        try {
            ctx.redis.hset(RedisKeys.bncSeen(networkId), ckey, cursor.to!string);
            flushedCursor = cursor;
            lastFlushMs = now;
        } catch (Exception e) {
            logWarn("bnc: cursor flush failed for %s/%s: %s", networkId, ckey, e.msg);
        }
    }

    // ── Live stream ──────────────────────────────────────────────────

    private void startSubscriber() {
        subRedis = new RedisStorage();
        subRedis.connectFromUrl(ctx.redisUrl);
        subscriber = subRedis.getClient.createSubscriber();
        subscriber.subscribe(RedisKeys.events(userId));
        subscriberActive = true;
        uint calls = 0;
        subscriber.listen((string _, string msg) @safe nothrow {
            try {
                onRedisMessage(msg);
                if (++calls % 100 == 0) { yield(); sleep(1.msecs); }
            } catch (Exception e) {
                logWarn("bnc: subscriber callback failed: %s", e.msg);
            }
        }, Duration.zero);
    }

    private void stopSubscriber() {
        if (!subscriberActive) return;
        subscriberActive = false;
        try subscriber.bstop(); catch (Exception) {}
        if (subRedis !is null) { subRedis.close(); subRedis = null; }
    }

    private void onRedisMessage(string msg) @trusted {
        if (closing) return;
        Json ev;
        try ev = parseJsonString(msg);
        catch (Exception) return;
        if (ev.type != Json.Type.object) return;
        const type = ev["type"].type == Json.Type.string ? ev["type"].get!string : "";
        if (type == BNC_EVENT_REVOKED) {
            const nid = ev["networkId"].type == Json.Type.string ? ev["networkId"].get!string : "";
            if (nid.length == 0 || nid == networkId) {
                revoked = true;
                logInfo("bnc: sid=%s password revoked, closing", sessionId);
                send("ERROR :Closing link: Bouncer password revoked");
                markClosing("revoked");
            }
            return;
        }
        if (type == BNC_EVENT_KICK) {
            const sid = ev["sid"].type == Json.Type.string ? ev["sid"].get!string : "";
            if (sid == sessionId) {
                const reason = ev["reason"].type == Json.Type.string && ev["reason"].get!string.length
                    ? ev["reason"].get!string : "Disconnected by administrator";
                logInfo("bnc: admin kick user=%s network=%s sid=%s reason=%s", userId, networkId, sid, reason);
                send("ERROR :Closing link: " ~ reason);
                markClosing("admin-kick");
            }
            return;
        }
        if (type == BNC_EVENT_NETWORKS) {
            if (!has("soju.im/bouncer-networks-notify")) return;
            const id = ev["networkId"].type == Json.Type.string ? ev["networkId"].get!string : "";
            if (!id.length) return;
            if (ev["removed"].type == Json.Type.bool_ && ev["removed"].get!bool) {
                sendBouncerNetwork(id, "*");
                return;
            }
            if (ev["state"].type == Json.Type.string) {
                const st = ev["state"].get!string;
                if (st.length && lastNetState.get(id, "") != st) {
                    lastNetState[id] = st;
                    sendBouncerNetwork(id, "state=" ~ st);
                }
                return;
            }
            NetworkConfig cfg;
            try cfg = ctx.networkRepo.findById(parseUUID(id.idup)); catch (Exception) {}
            if (cfg.id == UUID.init) return;
            sendBouncerNetwork(id, formatBouncerAttrs(networkAttrs(cfg)));
            return;
        }
        const nid = ev["nid"].type == Json.Type.string ? ev["nid"].get!string : "";
        if (has("soju.im/bouncer-networks-notify") && nid.length
            && ev["c"].type == Json.Type.string) {
            // The engine marks success with 001 / the `welcome` server-log
            // phase, an attempt with the `connecting` phase or a retry
            // status, and failure with DISCONNECTED / CONNECTION_FAIL.
            string st;
            const phase = ev["phase"].type == Json.Type.string ? ev["phase"].get!string : "";
            switch (ev["c"].get!string) {
                case "001", "CONNECTED": st = "connected"; break;
                case "CONNECTION_RETRY_STATUS":
                    // All-zero `rs` is the "retry cleared" form sent after a
                    // successful connect; only a scheduled attempt is connecting.
                    if (ev["rs"].type == Json.Type.object && ev["rs"]["attemptCount"].type == Json.Type.int_
                        && ev["rs"]["attemptCount"].get!long > 0) st = "connecting";
                    break;
                case "DISCONNECT", "DISCONNECTED", "CONNECTION_FAIL": st = "disconnected"; break;
                case "NOTICE":
                    if (phase == "welcome") st = "connected";
                    else if (phase == "connecting" || phase == "queued") st = "connecting";
                    break;
                default: break;
            }
            if (st.length && lastNetState.get(nid, "") != st) {
                lastNetState[nid] = st;
                sendBouncerNetwork(nid, "state=" ~ st);
            }
        }
        if (nid != networkId) return;
        if (!liveReady) {
            if (pendingLive.length < PENDING_LIVE_MAX) pendingLive ~= ev;
            return;
        }
        deliverLive(ev);
    }

    // BouncerServ (soju service.go parity): HELP, VERSION and a
    // human-readable network list; management goes through BOUNCER.
    private void handleBouncerServ(string text) {
        auto parts = text.strip().split(" ");
        string sub = parts.length ? parts[0].toLower() : "help";
        void reply(string line) {
            send(formatLine(null, "BouncerServ!bouncerserv@" ~ src, "NOTICE", [displayNick(), line]));
        }
        if (sub == "help") {
            foreach (line; [
                "BouncerServ commands: HELP VERSION NETWORK",
                "HELP — this help",
                "VERSION — bouncer version",
                "NETWORK LIST — your networks and the username that binds each one",
                "PART #chan detach — detach (keep backlog, stop live)",
            ]) reply(line);
        } else if (sub == "version") {
            reply("IRC Fiber bouncer 0.4.0 (bouncer-networks)");
        } else if (sub == "network" || sub == "networks") {
            auto nets = userNetworks();
            if (!nets.length) reply("No networks yet — BOUNCER ADDNETWORK host=<server> or add one on the website");
            foreach (ref cfg; nets) {
                const slug = networkSlug(cfg.name);
                string state;
                foreach (p; networkAttrs(cfg)) if (p[0] == "state") state = p[1];
                reply(slug ~ " — " ~ cfg.name ~ " " ~ cfg.host ~ ":" ~ cfg.port.to!string
                    ~ " [" ~ state ~ "]  (username " ~ authUsername ~ "/" ~ slug ~ ")");
            }
            reply("BOUNCER ADDNETWORK/DELNETWORK or the website Settings → Bouncer page manage networks");
        } else {
            reply("Unknown command " ~ sub ~ " (try HELP)");
        }
    }

    // Admin broadcast (soju: /notice $<hostname> / $*). Publishes on the
    // user's event channel so every BNC connection for every user gets it
    // via onRedisMessage; non-admins get 481. Admin check is best-effort:
    // prefsRepo marks admins, else fall back to denying $* but allowing
    // $self-host for the sender's own network.
    private void handleAdminBroadcast(string target, string text) {
        bool isAdmin = false;
        try {
            auto prefs = ctx.prefsRepo.load(UUID(userId));
            // PreferencesRepository stores admin flag; fall back to false
            // if the field doesn't exist in this build.
            static if (__traits(hasMember, typeof(prefs), "isAdmin"))
                isAdmin = prefs.isAdmin;
        } catch (Exception) {}
        if (!isAdmin) { numeric("481", ["Permission Denied - You're not an IRC operator"]); return; }
        try {
            auto ev = Json.emptyObject;
            ev["type"] = "bouncer_broadcast";
            ev["text"] = text;
            ev["from"] = displayNick();
            // Fan out to this user's channel; gateway subscribers for other
            // users pick it up via the wildcard admin channel below.
            ctx.redis.publish(RedisKeys.events(userId), ev.toString());
            ctx.redis.publish("irc:admin:broadcast", ev.toString());
        } catch (Exception e) { logWarn("bnc: broadcast failed: %s", e.msg); }
        status("Broadcast sent to " ~ target);
    }

    private void deliverLive(Json ev) {
        long eid = 0;
        if (ev["eid"].type == Json.Type.int_) eid = ev["eid"].get!long;
        if (eid > 0 && eid <= cursor) return;
        // soju detached: skip live traffic for detached channels on this
        // connection (backlog/history still available via CHATHISTORY).
        try {
            string ch = "";
            if (ev["ch"].type == Json.Type.string) ch = ev["ch"].get!string;
            else if (ev["target"].type == Json.Type.string) ch = ev["target"].get!string;
            if (ch.length && (ch.toLower() in detachedChans)) {
                if (eid > cursor) cursor = eid;
                flushCursor(false);
                return;
            }
            // Admin broadcast fanout
            if (ev["type"].type == Json.Type.string && ev["type"].get!string == "bouncer_broadcast") {
                string txt = ev["text"].type == Json.Type.string ? ev["text"].get!string : "";
                string from = ev["from"].type == Json.Type.string ? ev["from"].get!string : "admin";
                if (txt.length) send(formatLine(null, from ~ "!admin@" ~ src, "NOTICE", [displayNick(), "[broadcast] " ~ txt]));
                if (eid > cursor) cursor = eid;
                flushCursor(false);
                return;
            }
        } catch (Exception) {}
        auto f = formatCtx();
        // /LIST reply chunks are synthetic; re-expand them into 321/322/323.
        if (ev["c"].type == Json.Type.string && ev["c"].get!string == "CHANNEL_LIST") {
            foreach (l; formatChannelListEvent(ev, f)) send(l);
            if (eid > cursor) cursor = eid;
            flushCursor(false);
            return;
        }
        auto line = formatEvent(ev, f);
        if (line.length) send(line);
        // Track the engine's nick changes for us.
        if (ev["c"].type == Json.Type.string && ev["c"].get!string == "NICK"
            && ev["ch"].type == Json.Type.undefined
            && ev["n"].type == Json.Type.string && icmp(ev["n"].get!string, currentNick) == 0
            && ev["p"].type == Json.Type.array && ev["p"].length && ev["p"][0].type == Json.Type.string) {
            currentNick = ev["p"][0].get!string;
        }
        if (eid > cursor) cursor = eid;
        flushCursor(false);
    }

    private void keepaliveLoop() nothrow {
        try {
            while (!closing) {
                sleep(15.seconds);
                if (closing) break;
                checkTimeouts();
                writePresence();
            }
        } catch (Exception) {}
    }

    // ── Client → engine ──────────────────────────────────────────────

    private void handleClientLine(ref ParsedLine pl) {
        switch (pl.command) {
            case "PASS", "USER":
                return;
            case "AUTHENTICATE":
                numeric("904", ["SASL not available"]);
                return;
            case "BOUNCER":
                handleBouncer(pl.params);
                return;
            case "CHATHISTORY":
                // Served from our own store; works even while the engine is down.
                handleChatHistory(pl.params);
                return;
            default:
                break;
        }
        // BouncerServ is answered locally (soju service.go parity) — before
        // the generic PRIVMSG path so `/msg BouncerServ` never reaches the
        // engine, and before the unbound gate so it works without a network.
        if ((pl.command == "PRIVMSG" || pl.command == "NOTICE") && pl.params.length >= 2
            && icmp(pl.params[0], "BouncerServ") == 0) {
            handleBouncerServ(pl.params[1]);
            return;
        }
        if (networkId.length == 0) {
            numeric("421", [pl.command, "Not bound to a network — BOUNCER BIND <netid> or username " ~ authUsername ~ "/<network>"]);
            return;
        }

        auto serverId = ctx.registry.getServerForNetwork(networkId);
        if (!serverId.length || !ctx.registry.isServerHealthy(serverId)) {
            status("No healthy engine for " ~ networkName);
            return;
        }
        const now = nowMs();

        if (pl.command == "PRIVMSG") {
            if (pl.params.length < 2) { numeric("461", ["PRIVMSG", "Not enough parameters"]); return; }
            const text = pl.params[1];
            foreach (target; pl.params[0].split(",")) {
                if (!target.length) continue;
                if (target.startsWith("*")) {
                    status("No bouncer commands are available");
                    continue;
                }
                auto cmd = IRCCommand("msg", target, text);
                cmd.timestampMs = now;
                cmd.label = "bnc-" ~ sessionId ~ "-" ~ (++seq).to!string;
                if (!has("echo-message")) recentOwn.push(target, text, now);
                routeEngineCommand(ctx.redis, networkId, serverId, cmd);
            }
            return;
        }
        if (pl.command == "PART") {
            if (!pl.params.length) { numeric("461", ["PART", "Not enough parameters"]); return; }
            // soju parity: PART with reason "detach" (case-insensitive)
            // detaches instead of leaving — channel stays joined upstream
            // with backlog kept, but this BNC connection stops getting
            // live traffic for it. JOIN re-attaches.
            string reason = pl.params.length > 1 ? pl.params[1] : "";
            if (reason.strip().toLower() == "detach") {
                foreach (chan; pl.params[0].split(",")) {
                    if (!chan.length) continue;
                    detachedChans[chan.toLower()] = true;
                }
                status("Detached " ~ pl.params[0] ~ " (backlog kept, use /JOIN to re-attach)");
                return;
            }
            foreach (chan; pl.params[0].split(",")) {
                if (!chan.length) continue;
                // Re-attach if it was detached before
                detachedChans.remove(chan.toLower());
                auto cmd = IRCCommand("part", chan, "");
                cmd.timestampMs = now;
                routeEngineCommand(ctx.redis, networkId, serverId, cmd);
            }
            return;
        }
        if (pl.command == "JOIN") {
            // Re-attach detached channels on JOIN
            if (pl.params.length) {
                foreach (chan; pl.params[0].split(",")) {
                    if (!chan.length) continue;
                    auto key = chan.toLower();
                    // Strip leading : if present (JOIN :#ch)
                    if (key.length && key[0] == ':') key = key[1 .. $];
                    detachedChans.remove(key);
                }
            }
            // Fall through to raw forwarding below
        }
        // Admin broadcast: /NOTICE $<host|*> text (soju: NOTICE $host).
        // Only admins may broadcast; non-admins get 481.
        if ((pl.command == "PRIVMSG" || pl.command == "NOTICE") && pl.params.length >= 2
            && pl.params[0].length > 1 && pl.params[0][0] == '$') {
            handleAdminBroadcast(pl.params[0], pl.params[1]);
            return;
        }
        // Everything else goes out verbatim (minus tags/prefix), the same
        // path the web JoinModal uses (`sendRaw`).
        string raw = pl.withoutTags;
        if (raw.startsWith(":")) {
            const sp = raw.indexOf(" ");
            raw = sp < 0 ? "" : raw[sp + 1 .. $].strip();
        }
        if (!raw.length) return;
        auto cmd = IRCCommand("raw", "", raw);
        cmd.timestampMs = now;
        routeEngineCommand(ctx.redis, networkId, serverId, cmd);
    }
}
