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

/// Event `type` sent when a network's bouncer password was revoked or
/// regenerated: every client attached to `networkId` must drop.
enum string BNC_EVENT_REVOKED = "bnc_revoked";
/// Event `type` sent to disconnect one specific attached client (`sid`).
enum string BNC_EVENT_KICK = "bnc_kick";

/// Tells attached bouncer clients of `networkId` (owned by `userId`) to drop.
void publishBncRevoked(RedisStorage redis, string userId, string networkId) nothrow {
    try {
        redis.publish(RedisKeys.events(userId),
            Json(["type": Json(BNC_EVENT_REVOKED), "networkId": Json(networkId)]).toString());
    } catch (Exception e) {
        logWarn("bnc_revoked publish failed for %s: %s", networkId, e.msg);
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
