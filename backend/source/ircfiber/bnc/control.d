module ircfiber.bnc.control;

/// Cross-process control messages for the bouncer.
///
/// Attached bouncer clients live in the `ircfiber-bnc` process while the
/// REST/admin API runs in `ircfiber-gateway`, so every "do something to a
/// client" action travels over the owner's `irc:events:<userId>` pub/sub
/// channel (which each client already subscribes to for live traffic).
/// Browsers ignore the unknown `type` values.

import vibe.core.log : logWarn;
import vibe.data.json : Json;

import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;

/// Event `type` sent when a bouncer password was revoked or regenerated
/// (or a network deleted): clients bound to `networkId` must drop; with an
/// empty `networkId` every client of the user drops.
enum string BNC_EVENT_REVOKED = "bnc_revoked";
/// Event `type` sent to disconnect one specific attached client (`sid`).
enum string BNC_EVENT_KICK = "bnc_kick";
/// Event `type` sent when a network was added, changed or removed, so
/// clients with `soju.im/bouncer-networks-notify` learn about it.
enum string BNC_EVENT_NETWORKS = "bnc_networks";

/// Tells attached bouncer clients of `networkId` (owned by `userId`) to
/// drop; `networkId == ""` drops every client of the user.
void publishBncRevoked(RedisStorage redis, string userId, string networkId) nothrow {
    try {
        redis.publish(RedisKeys.events(userId),
            Json(["type": Json(BNC_EVENT_REVOKED), "networkId": Json(networkId)]).toString());
    } catch (Exception e) {
        logWarn("bnc_revoked publish failed for %s: %s", networkId, e.msg);
    }
}

/// Announces a network add/change (`removed=false`) or delete to the
/// user's bouncer clients.
void publishBncNetworkChanged(RedisStorage redis, string userId, string networkId, bool removed) nothrow {
    try {
        redis.publish(RedisKeys.events(userId),
            Json(["type": Json(BNC_EVENT_NETWORKS), "networkId": Json(networkId),
                  "removed": Json(removed)]).toString());
    } catch (Exception e) {
        logWarn("bnc_networks publish failed for %s: %s", networkId, e.msg);
    }
}

/// Announces a connection-state change the engine does not emit itself
/// (user-initiated disconnect). `state` is `connected|connecting|disconnected`.
void publishBncNetworkState(RedisStorage redis, string userId, string networkId, string state) nothrow {
    try {
        redis.publish(RedisKeys.events(userId),
            Json(["type": Json(BNC_EVENT_NETWORKS), "networkId": Json(networkId),
                  "state": Json(state)]).toString());
    } catch (Exception e) {
        logWarn("bnc_networks state publish failed for %s: %s", networkId, e.msg);
    }
}

/// Disconnects the attached client with bouncer session id `sid` belonging
/// to `userId`. `reason` is shown to the client in the ERROR line.
void publishBncKick(RedisStorage redis, string userId, string sid, string reason) nothrow {
    try {
        redis.publish(RedisKeys.events(userId),
            Json(["type": Json(BNC_EVENT_KICK), "sid": Json(sid), "reason": Json(reason)]).toString());
    } catch (Exception e) {
        logWarn("bnc_kick publish failed for %s: %s", sid, e.msg);
    }
}
