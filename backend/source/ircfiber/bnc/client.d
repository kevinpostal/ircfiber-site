/**
 * One attached bouncer client (IRCCloud "Connect with another client…").
 *
 * The client registers with `PASS bnc[@clientid]:<token>`, receives a
 * synthesized registration burst built from the engine's state snapshot
 * (ZNC `CIRCNetwork::ClientConnected` / `CChan::AttachUser`), then live
 * traffic from the user's Redis event channel. Everything it sends goes
 * out through the owning engine's command queue, exactly like the web UI.
 *
 * Fiber layout per client (all on the listener thread):
 *   - `run()`      reader loop on the accepting fiber
 *   - writer task  drains `outbound` → socket (only writer)
 *   - subscriber   vibe.d RedisSubscriber task (own Redis connection)
 *   - keepalive    PING every 60 s idle, drop after 180 s silence
 */
module ircfiber.bnc.client;

import std.uuid : UUID, randomUUID;
import std.conv : to;
import std.datetime : Clock;
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
import ircfiber.db.messages : MessageRepository;
import ircfiber.db.preferences : PreferencesRepository, clampBncPlaybackLines;
import ircfiber.storage.buffer : BufferManager;
import ircfiber.models.irc_event : IRCRawEvent;
import ircfiber.redis.protocol : RedisKeys, IRCCommand, NetworkStateSnapshot;
import ircfiber.api.websocket : loadNetworkStateSnapshot, routeEngineCommand;
import ircfiber.bnc.wire;
import ircfiber.bnc.format : FormatCtx, RecentOwn, formatEvent;
import ircfiber.bnc.control : BNC_EVENT_REVOKED, BNC_EVENT_KICK;

/// Shared services handed to every client by the listener.
struct BncContext {
    RedisStorage redis;
    ServerRegistry registry;
    NetworkRepository networkRepo;
    MessageRepository messageRepo;
    /// Per-user settings (bouncer playback size).
    PreferencesRepository prefsRepo;
    /// Redis scrollback writer for the attach/detach status rows.
    BufferManager bufferManager;
    /// `:server` prefix and 001 host name.
    string sourceName;
    /// Redis URL for the per-client subscriber connection.
    string redisUrl;
}

/// CAPs the bouncer offers (ZNC core set).
immutable string[] OFFERED_CAPS = [
    "server-time", "batch", "message-tags", "echo-message", "multi-prefix",
    "userhost-in-names", "away-notify", "account-notify", "extended-join",
    "invite-notify", "chghost", "cap-notify",
    // On-demand history (soju-style). Clients that negotiate it get no
    // attach playback and pull what they need with CHATHISTORY.
    "draft/chathistory",
];

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
        /// Set when the password was revoked/regenerated: the cursor hash was
        /// deleted server-side and must not be re-created on detach.
        bool revoked;
        bool socketClosed;

        // Registration
        bool gotPass, gotNick, gotUser, inCap, registered;
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
        try outbound.put(line);
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
                    logDebug("bnc: write failed for %s: %s", peer, e.msg);
                    closing = true;
                    closeSocket();
                    break;
                }
                if (++n % 100 == 0) {
                    try yield(); catch (Exception) {}
                }
            }
        } catch (Exception e) {
            logDebug("bnc: writer loop error for %s: %s", peer, e.msg);
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
                        case WaitForDataStatus.noMoreData: closing = true; break;
                    }
                }
            } catch (Exception e) {
                logDebug("bnc: wait failed for %s: %s", peer, e.msg);
                break;
            }
            if (closing) break;
            if (!ready) { checkTimeouts(); continue; }

            size_t n;
            try n = tls !is null ? tls.read(buf[], IOMode.once) : conn.read(buf[], IOMode.once);
            catch (Exception e) {
                logDebug("bnc: read ended for %s: %s", peer, e.msg);
                break;
            }
            if (n == 0) {
                if (!conn.connected) break;
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
                    send("ERROR :Closing link: Too long raw line");
                    closing = true;
                    break;
                }
                try handleLine(line);
                catch (Exception e) {
                    logWarn("bnc: handleLine failed for %s (%s): %s", peer, line.length > 64 ? line[0 .. 64] : line, e.msg);
                }
            }
            if (partial.length > MAX_LINE) {
                send("ERROR :Closing link: Too long raw line");
                closing = true;
            }
        }
    }

    private void checkTimeouts() {
        const now = nowMs();
        if (now - lastRecvMs > DEAD_AFTER_MS) {
            send("ERROR :Closing link: Timeout");
            closing = true;
            return;
        }
        if (registered && now - lastRecvMs > KEEPALIVE_IDLE_MS && now - lastSendMs > KEEPALIVE_IDLE_MS) {
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
        if (registered) {
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
        if (registered) {
            logInfo("bnc: detached user=%s network=%s client=%s peer=%s", userId, networkId,
                clientId.length ? clientId : "-", peer);
        } else {
            logDebug("bnc: unregistered client gone peer=%s", peer);
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
        switch (pl.command) {
            case "PING":
                send("PONG :" ~ (pl.params.length ? pl.params[0] : src));
                return;
            case "PONG":
                return;
            case "QUIT":
                closing = true;
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
                handlePass(pl.params[0]);
                break;
            case "NICK":
                if (!pl.params.length) { numeric("431", ["No nickname given"]); return; }
                clientNick = pl.params[0];
                gotNick = true;
                tryRegister();
                break;
            case "USER":
                gotUser = true;
                if (!gotPass) {
                    numeric("464", ["Password required"]);
                    send(formatLine(null, src, "NOTICE", [displayNick(),
                        "*** Set your server password to bnc:<password> (or bnc@<clientid>:<password>)"]));
                }
                tryRegister();
                break;
            default:
                // Anything else before registration is ignored.
                break;
        }
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
                send(formatLine(null, src, "CAP", [displayNick(), "LS", OFFERED_CAPS.join(" ")]));
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

    private void handlePass(string raw) {
        auto p = parseBncPass(raw);
        if (!p.ok) {
            numeric("464", ["Password must be bnc:<password> or bnc@<clientid>:<password>"]);
            send("ERROR :Closing link: Invalid password format");
            closing = true;
            return;
        }
        auto info = ctx.networkRepo.findByBncToken(p.token);
        if (info.config.id == UUID.init) {
            numeric("464", ["Invalid password"]);
            send("ERROR :Closing link: Invalid password");
            closing = true;
            return;
        }
        userId = info.userId.toString();
        networkId = info.config.id.toString();
        networkName = info.config.name;
        clientId = p.clientId;
        gotPass = true;
        tryRegister();
    }

    private void tryRegister() {
        if (gotPass && gotNick && gotUser && !inCap && !registered) attach();
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

        send(formatLine(null, src, "001", [clientNick, "Welcome to the IRC Fiber bouncer, " ~ clientNick]));
        send(formatLine(null, src, "002", [clientNick, "Your host is " ~ src ~ ", running IRC Fiber"]));
        send(formatLine(null, src, "003", [clientNick, "This server was created for you"]));
        send(formatLine(null, src, "004", [clientNick, src, "irc-fiber-bnc", "iw", chanModes]));
        {
            string[] toks;
            foreach (k, v; snap.isupport) {
                // The bouncer answers CHATHISTORY itself; hide the upstream's tokens.
                if (k == "CHATHISTORY" || k == "draft/CHATHISTORY" || k == "MSGREFTYPES") continue;
                toks ~= v.length ? k ~ "=" ~ v : k;
            }
            toks ~= "CHATHISTORY=" ~ CHATHISTORY_MAX.to!string;
            toks ~= "MSGREFTYPES=timestamp,msgid";
            foreach (i; 0 .. (toks.length + 12) / 13) {
                auto slice = toks[i * 13 .. min(toks.length, (i + 1) * 13)];
                send(formatLine(null, src, "005", [clientNick] ~ slice ~ ["are supported by this server"]));
            }
        }
        send(formatLine(null, src, "375", [clientNick, "- " ~ src ~ " Message of the Day -"]));
        foreach (line; [
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
            "",
            "Register your nickname with NickServ to protect it:",
            "    /msg NickServ REGISTER <password> [email]",
            "    /msg NickServ HELP",
            "",
            "Register a channel you founded:",
            "    /msg ChanServ REGISTER #channel",
            "",
            "To join a channel:",
            "    /join #channelname",
            "",
            "Rules:",
            "  1. Be respectful to other users.",
            "  2. No spam, flooding, or abuse.",
            "  3. Follow the network operator instructions.",
        ]) send(formatLine(null, src, "372", [clientNick, "- " ~ line]));
        send(formatLine(null, src, "376", [clientNick, "End of /MOTD command"]));
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
        logInfo("bnc: attached user=%s network=%s client=%s nick=%s peer=%s caps=%s",
            userId, networkId, clientId.length ? clientId : "-", currentNick, peer, caps.keys.join(","));
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
    private Json[] fetchMissed(string serverId) {
        const globalEid = readGlobalEid();
        if (!clientId.length) { cursor = globalEid; return null; }

        string seenStr;
        try seenStr = ctx.redis.getDb().hget!string(RedisKeys.bncSeen(networkId), clientId);
        catch (Exception) {}
        long seen = 0;
        if (seenStr.length) { try seen = seenStr.to!long; catch (Exception) seen = 0; }
        if (seen <= 0) {
            // First connect of this clientid: nothing was ever delivered.
            cursor = globalEid;
            return null;
        }
        cursor = seen;
        if (!serverId.length) { cursor = max(cursor, globalEid); return null; }

        Json[] events;
        try events = ctx.messageRepo.getAfterEidForNetwork(serverId, networkId, seen, REPLAY_LIMIT);
        catch (Exception e) {
            logWarn("bnc: backlog fetch failed for %s: %s", networkId, e.msg);
            cursor = max(cursor, globalEid);
            return null;
        }
        Json[] keep;
        foreach (ev; events) {
            if (ev.type != Json.Type.object) continue;
            // Everything fetched (kept or not) is now "seen".
            if (ev["eid"].type == Json.Type.int_) cursor = max(cursor, ev["eid"].get!long);
            if (!isChatRow(ev)) continue;
            // chathistory-fetched rows have new eids but old timestamps; they
            // belong to playback, not to "what you missed".
            if (ev["batch"].type != Json.Type.undefined) continue;
            keep ~= ev;
        }
        if (events.length < REPLAY_LIMIT) cursor = max(cursor, globalEid);
        return keep;
    }

    private static bool isChatRow(ref Json ev) {
        if (ev.type != Json.Type.object) return false;
        const c = ev["c"].type == Json.Type.string ? ev["c"].get!string : "";
        if (c != "PRIVMSG" && c != "NOTICE") return false;
        return ev["phase"].type == Json.Type.undefined;
    }

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

    private static string dedupeKey(ref Json ev) {
        if (ev["eid"].type == Json.Type.int_ && ev["eid"].get!long > 0) return "e" ~ ev["eid"].get!long.to!string;
        if (ev["m"].type == Json.Type.string && ev["m"].get!string.length) return "m" ~ ev["m"].get!string;
        return "t" ~ ev["t"].toString() ~ "|" ~ ev["n"].toString() ~ "|" ~ ev["x"].toString();
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
        if (!has("draft/chathistory") && serverId.length) rows ~= fetchPlayback(serverId, snap);
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
        if (!clientId.length || !networkId.length) return;
        if (cursor <= flushedCursor) return;
        const now = nowMs();
        if (!force && now - lastFlushMs < CURSOR_FLUSH_MS) return;
        try {
            ctx.redis.hset(RedisKeys.bncSeen(networkId), clientId, cursor.to!string);
            flushedCursor = cursor;
            lastFlushMs = now;
        } catch (Exception e) {
            logWarn("bnc: cursor flush failed for %s/%s: %s", networkId, clientId, e.msg);
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
            if (nid == networkId) {
                revoked = true;
                send("ERROR :Closing link: Bouncer password revoked");
                closing = true;
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
                closing = true;
            }
            return;
        }
        const nid = ev["nid"].type == Json.Type.string ? ev["nid"].get!string : "";
        if (nid != networkId) return;
        if (!liveReady) {
            if (pendingLive.length < PENDING_LIVE_MAX) pendingLive ~= ev;
            return;
        }
        deliverLive(ev);
    }

    private void deliverLive(Json ev) {
        long eid = 0;
        if (ev["eid"].type == Json.Type.int_) eid = ev["eid"].get!long;
        if (eid > 0 && eid <= cursor) return;
        auto f = formatCtx();
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
            case "CHATHISTORY":
                // Served from our own store; works even while the engine is down.
                handleChatHistory(pl.params);
                return;
            default:
                break;
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
            foreach (chan; pl.params[0].split(",")) {
                if (!chan.length) continue;
                auto cmd = IRCCommand("part", chan, "");
                cmd.timestampMs = now;
                routeEngineCommand(ctx.redis, networkId, serverId, cmd);
            }
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
