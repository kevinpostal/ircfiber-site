/**
 * Bouncer TCP/TLS listener. Only a gateway process with `IRCFIBER_BNC_PORT`
 * set listens (prod: the dedicated `ircfiber-bnc` container; local dev:
 * the single gateway on plaintext 7000).
 *
 * Env:
 *   IRCFIBER_BNC_PORT         listen port (unset/0 → disabled)
 *   IRCFIBER_BNC_BIND         bind address (default 0.0.0.0)
 *   IRCFIBER_BNC_TLS_CERT     PEM chain; with IRCFIBER_BNC_TLS_KEY enables TLS
 *   IRCFIBER_BNC_TLS_KEY      PEM private key
 *   IRCFIBER_BNC_PUBLIC_HOST  `:server` prefix / 001 host (default bnc.ircfiber)
 *   IRCFIBER_REDIS_URL        per-client subscriber connections
 *   IRCFIBER_BNC_TRACE        "1" → log every client/server line at info
 *                             (PASS redacted). High volume; for drop diagnosis.
 *                             Needs a restart (read once at listen).
 */
module ircfiber.bnc.listener;

import std.process : environment;
import std.conv : to;
import vibe.core.net : TCPConnection, listenTCP;
import vibe.core.log;
import vibe.stream.tls : TLSContext, TLSContextKind, TLSStream, TLSStreamState,
    createTLSContext, createTLSStream;

import ircfiber.storage.redis : RedisStorage;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.messages : MessageRepository;
import ircfiber.db.preferences : PreferencesRepository;
import ircfiber.storage.buffer : BufferManager;
import ircfiber.bnc.client : BncClient, BncContext;

private __gshared BncContext g_ctx;
private __gshared string g_certPath;
private __gshared string g_keyPath;

/// Starts the listener when `IRCFIBER_BNC_PORT` is set; no-op otherwise.
void startBncListener(RedisStorage redis) {
    ushort port = 0;
    try port = cast(ushort) environment.get("IRCFIBER_BNC_PORT", "0").to!int;
    catch (Exception) port = 0;
    if (port == 0) {
        logInfo("BNC listener disabled (IRCFIBER_BNC_PORT unset)");
        return;
    }
    const bind = environment.get("IRCFIBER_BNC_BIND", "0.0.0.0");
    g_certPath = environment.get("IRCFIBER_BNC_TLS_CERT", "");
    g_keyPath = environment.get("IRCFIBER_BNC_TLS_KEY", "");
    const tlsEnabled = g_certPath.length && g_keyPath.length;
    if (!tlsEnabled) {
        g_certPath = "";
        g_keyPath = "";
        logWarn("BNC listener: no IRCFIBER_BNC_TLS_CERT/KEY — accepting PLAINTEXT connections on %s:%s", bind, port);
    }

    g_ctx.redis = redis;
    g_ctx.registry = new ServerRegistry(redis);
    g_ctx.networkRepo = new NetworkRepository();
    g_ctx.messageRepo = new MessageRepository();
    g_ctx.prefsRepo = new PreferencesRepository(redis);
    g_ctx.bufferManager = new BufferManager(redis);
    g_ctx.sourceName = environment.get("IRCFIBER_BNC_PUBLIC_HOST", "bnc.ircfiber");
    g_ctx.redisUrl = environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379");
    g_ctx.trace = environment.get("IRCFIBER_BNC_TRACE", "0") == "1";

    listenTCP(port, (TCPConnection c) @safe nothrow { onConnection(c); }, bind);
    logInfo("BNC listener on %s:%s (%s) as %s trace=%s", bind, port,
        tlsEnabled ? "TLS" : "plaintext", g_ctx.sourceName, g_ctx.trace ? "on" : "off");
}

private void onConnection(TCPConnection conn) @trusted nothrow {
    string peer;
    try peer = conn.peerAddress; catch (Exception) peer = "?";
    try {
        conn.tcpNoDelay = true;
        conn.keepAlive = true;
        TLSStream tls;
        if (g_certPath.length) {
            // Context per connection so Caddy's renewed cert files are
            // picked up without a restart.
            auto tctx = createTLSContext(TLSContextKind.server);
            tctx.useCertificateChainFile(g_certPath);
            tctx.usePrivateKeyFile(g_keyPath);
            try tls = createTLSStream(conn, tctx, TLSStreamState.accepting);
            catch (Exception e) {
                logWarn("bnc: TLS handshake failed from %s: %s", peer, e.msg);
                try conn.close(); catch (Exception) {}
                return;
            }
        }
        logInfo("bnc: accept from %s (%s)", peer, g_certPath.length ? "TLS" : "plaintext");
        auto client = new BncClient(conn, tls, g_ctx);
        client.run();
    } catch (Exception e) {
        logWarn("bnc: connection from %s failed: %s", peer, e.msg);
        try conn.close(); catch (Exception) {}
    }
}
