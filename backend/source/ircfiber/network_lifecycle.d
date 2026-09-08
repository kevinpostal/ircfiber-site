/**
 * Creating, updating and deleting a user's network, in one place.
 *
 * Two surfaces mutate networks: the REST API (`/api/networks`) and the
 * bouncer's `BOUNCER ADDNETWORK/CHANGENETWORK/DELNETWORK`. Both must save
 * the document, keep the per-user Redis cache honest, tell the owning
 * engine, and notify attached bouncer clients — so the sequence lives here
 * rather than being copied into the bnc process.
 */
module ircfiber.network_lifecycle;

import std.algorithm : canFind, countUntil;
import std.datetime : Clock;
import std.string : strip, indexOf, lastIndexOf;
import std.uuid : UUID;

import vibe.core.log;

import ircfiber.account_deletion : purgeNetworkRuntimeState;
import ircfiber.bnc.control : publishBncNetworkChanged, publishBncRevoked;
import ircfiber.db.network : NetworkRepository;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.models.network : NetworkConfig;
import ircfiber.redis.protocol : ControlMessage, RedisKeys;
import ircfiber.storage.redis : RedisStorage;

/// Strips a scheme, path, port and IPv6 brackets from a user-typed host.
string normalizeHost(string host) @safe pure {
    host = host.strip();
    auto schemeSep = host.indexOf("://");
    if (schemeSep >= 0) {
        host = host[schemeSep + 3 .. $];
        auto slash = host.indexOf("/");
        if (slash >= 0) host = host[0 .. slash];
        auto bracketClose = host.indexOf("]");
        if (bracketClose >= 0) {
            auto open = host.indexOf("[");
            if (open >= 0) host = host[open .. bracketClose + 1];
            else host = host[0 .. bracketClose + 1];
        } else {
            auto colon = host.lastIndexOf(":");
            if (colon >= 0) {
                auto after = host[colon + 1 .. $];
                bool allDigits = after.length > 0;
                foreach (c; after) if (c < '0' || c > '9') { allDigits = false; break; }
                bool looksLikeIPv6 = host.canFind("::") || host.countUntil(":") != host.lastIndexOf(":");
                if (allDigits && !looksLikeIPv6) host = host[0 .. colon];
            }
        }
        host = host.strip();
    }
    if (host.length >= 2 && host[0] == '[') {
        auto close = host.indexOf("]");
        if (close > 0) return host[1 .. close];
    }
    return host;
}

private long nowMs() {
    return Clock.currTime.toUnixTime!long * 1000;
}

/// Saves a new network, assigns it to a healthy engine and pushes
/// `addNetwork`. Returns the server id, or "" when no engine is healthy
/// (the document is still saved, matching what REST always did).
string provisionNetwork(ref NetworkConfig cfg, UUID ownerId, NetworkRepository repo,
                        RedisStorage redis, ServerRegistry registry) {
    repo.save(cfg, ownerId);
    redis.del(RedisKeys.userNetworks(ownerId.toString()));

    string serverId = registry.assignNetwork(cfg.id.toString());
    if (serverId.length == 0) {
        logError("Failed to assign network to server — no healthy connection servers");
        return "";
    }

    auto msg = ControlMessage("addNetwork", cfg.id.toString(), ownerId.toString(), cfg.toJson());
    msg.timestampMs = nowMs();
    redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    publishBncNetworkChanged(redis, ownerId.toString(), cfg.id.toString(), false);
    return serverId;
}

/// Saves an edited network and pushes `updateConfig` (or `reconnectNetwork`
/// when the egress pin changed — the live socket is bound to the old exit).
/// Returns the server id, or "" when no engine is healthy.
string updateOwnedNetwork(ref NetworkConfig cfg, UUID ownerId, bool egressChanged,
                          NetworkRepository repo, RedisStorage redis, ServerRegistry registry) {
    repo.save(cfg, ownerId);
    redis.del(RedisKeys.userNetworks(ownerId.toString()));

    auto serverId = registry.getServerForNetwork(cfg.id.toString());
    if (serverId.length == 0) serverId = registry.assignNetwork(cfg.id.toString());
    if (serverId.length == 0) {
        logError("Cannot update network %s — no healthy connection servers", cfg.id);
        return "";
    }

    auto msg = egressChanged
        ? ControlMessage("reconnectNetwork", cfg.id.toString(), ownerId.toString(), cfg.toJson())
        : ControlMessage("updateConfig", cfg.id.toString(), "", cfg.toJson());
    msg.timestampMs = nowMs();
    redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    publishBncNetworkChanged(redis, ownerId.toString(), cfg.id.toString(), false);
    return serverId;
}

/// Tears the network down everywhere: engine socket, Redis runtime state,
/// the Mongo document, the user cache, bouncer replay cursors; then drops
/// every bouncer client bound to it and notifies the rest.
void deleteOwnedNetwork(UUID id, UUID ownerId, NetworkRepository repo,
                        RedisStorage redis, ServerRegistry registry) {
    purgeNetworkRuntimeState(id, redis, registry);
    repo.deleteById(id);
    if (ownerId != UUID.init)
        redis.del(RedisKeys.userNetworks(ownerId.toString()));
    redis.del(RedisKeys.bncSeen(id.toString()));
    if (ownerId != UUID.init) {
        publishBncRevoked(redis, ownerId.toString(), id.toString());
        publishBncNetworkChanged(redis, ownerId.toString(), id.toString(), true);
    }
}
