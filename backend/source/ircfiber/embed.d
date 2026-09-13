module ircfiber.embed;

import std.algorithm : canFind;
import std.array : appender, join;
import std.datetime : Clock;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;

import ircfiber.storage.redis : RedisStorage;

/// The origin grammar lives in a storage-free module so it can be tested on
/// its own; re-exported here so callers need only one import.
public import ircfiber.embed_origin : EMBED_ORIGINS_MAX, frameAncestors,
    normalizeOrigin, originAuthority, validateEmbedOrigins;

/// Redis key holding the JSON array of origins allowed to iframe the site.
/// Empty/missing → embedding is refused outright (`X-Frame-Options: DENY` +
/// `frame-ancestors 'none'`). Managed from the admin Embedding page.
immutable string EMBED_ORIGINS_KEY = "irc:config:embedOrigins";

/// How long a loaded allowlist is reused before Redis is consulted again.
/// The hot path (`frameHeadersFor`, the CSRF gate) runs on every request;
/// without this each request would cost a Redis round trip. Writes through
/// `setEmbedOrigins` refresh the cache immediately, so the window only
/// matters for a change made by another gateway replica.
enum long EMBED_CACHE_TTL_MS = 5_000;

private {
    import core.sync.mutex : Mutex;

    __gshared Mutex g_lock;
    __gshared string[] g_origins;
    __gshared long g_loadedAtMs = 0;
    __gshared bool g_loaded = false;
    __gshared RedisStorage g_redis;

    shared static this() {
        g_lock = new Mutex;
    }

    long nowMs() @trusted {
        return Clock.currTime.toUnixTime() * 1000L;
    }
}

/// Registers the Redis handle the cached lookups read through. Called once
/// from `app.d` at startup; without it `cachedEmbedOrigins` returns an empty
/// list, which fails closed (embedding blocked).
void initEmbedConfig(RedisStorage redis) @trusted {
    synchronized (g_lock) {
        g_redis = redis;
        g_loaded = false;
        g_loadedAtMs = 0;
    }
}

/// Reads the allowlist straight from Redis. Invalid or unparseable content
/// yields an empty list (fail closed) rather than throwing.
string[] loadEmbedOrigins(RedisStorage redis) @trusted {
    try {
        auto raw = redis.getDb().get(EMBED_ORIGINS_KEY);
        if (raw.length == 0) return null;
        auto parsed = parseJsonString(raw);
        if (parsed.type != Json.Type.array) return null;
        auto out_ = appender!(string[]);
        foreach (entry; parsed.get!(Json[])) {
            if (entry.type != Json.Type.string) continue;
            auto norm = normalizeOrigin(entry.get!string);
            if (norm.length > 0 && !out_.data.canFind(norm)) out_ ~= norm;
            if (out_.data.length >= EMBED_ORIGINS_MAX) break;
        }
        return out_.data;
    } catch (Exception e) {
        logWarn("loadEmbedOrigins failed: %s", e.msg);
        return null;
    }
}

/// Persists the allowlist and refreshes the process cache. Entries are
/// expected to be pre-validated by `validateEmbedOrigins`.
void setEmbedOrigins(RedisStorage redis, string[] origins) @trusted {
    Json arr = Json.emptyArray;
    foreach (o; origins) arr ~= Json(o);
    try {
        redis.getDb().set(EMBED_ORIGINS_KEY, arr.toString());
    } catch (Exception e) {
        logWarn("setEmbedOrigins failed: %s", e.msg);
        throw e;
    }
    synchronized (g_lock) {
        g_origins = origins.dup;
        g_loadedAtMs = nowMs();
        g_loaded = true;
    }
    logInfo("embed: allowlist now [%s]", origins.join(", "));
}

/// Cached allowlist for per-request use. Refreshes at most every
/// `EMBED_CACHE_TTL_MS`.
string[] cachedEmbedOrigins() @trusted {
    RedisStorage redis;
    synchronized (g_lock) {
        if (g_loaded && nowMs() - g_loadedAtMs < EMBED_CACHE_TTL_MS)
            return g_origins;
        redis = g_redis;
    }
    if (redis is null) return null;
    auto fresh = loadEmbedOrigins(redis);
    synchronized (g_lock) {
        g_origins = fresh;
        g_loadedAtMs = nowMs();
        g_loaded = true;
        return g_origins;
    }
}

/// True when at least one partner origin may embed the site. Drives the
/// `SameSite=None` session cookie: without a cross-site embed there is no
/// reason to weaken the cookie.
bool embeddingEnabled() @trusted {
    return cachedEmbedOrigins().length > 0;
}
