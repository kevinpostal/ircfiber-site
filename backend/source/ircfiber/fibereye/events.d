/**
 * FiberEye Redis keys and the small payloads that live in Redis.
 *
 * FiberEye is the connection-intelligence bot: it observes every ircd
 * connect and quit through its own opered connection, persists them to
 * Mongo (`ircfiber.fibereye.store`) and places timed Z-lines when a rule
 * in `ircfiber.fibereye.rules` trips.
 *
 * The keys live here rather than in `ircfiber.redis.protocol` (the
 * triple-vendored `common/`) for the same reason `ircfiber.logs.events`
 * keeps its own: they are site-backend-private and adding them to
 * `RedisKeys` would mean editing three byte-identical copies for keys the
 * engine never touches.
 *
 * This module deliberately imports nothing but `vibe.data.json` — no
 * Redis, no Mongo, no clock — so it links into the pure test
 * configuration (`fibereye-test`) alongside `format.d` and `rules.d`.
 */
module ircfiber.fibereye.events;

import vibe.data.json : Json;

/// Bot heartbeat published for the admin FiberEye page (60 s TTL).
string fiberEyeBotKey() @safe pure nothrow { return "fibereye:bot"; }
/// Admin → bot control commands (reconnect / stats).
string fiberEyeControlKey() @safe pure nothrow { return "fibereye:bot:control"; }
/// Enforcement switch: `"1"` arms, anything else (including a missing
/// key) leaves FiberEye observing. A Redis wipe therefore fails safe.
string fiberEyeArmedKey() @safe pure nothrow { return "fibereye:armed"; }

/// Sorted set of connects in the current window for one IP group
/// (score = unix ms, member = `<ms>:<nick>` so repeats never collapse).
string fiberEyeConnKey(string g) @safe pure { return "fibereye:conn:" ~ g; }
/// Sorted set of distinct lowercased nicks in the current window.
string fiberEyeNickKey(string g) @safe pure { return "fibereye:nicks:" ~ g; }
/// Sorted set of sessions shorter than `Thresholds.shortMs`.
string fiberEyeChurnKey(string g) @safe pure { return "fibereye:churn:" ~ g; }
/// Strike counter per IP group (7 day TTL from the first strike).
string fiberEyeStrikeKey(string g) @safe pure { return "fibereye:strikes:" ~ g; }
/// One appeal token → `Appeal` JSON, TTL = ban duration + 1 day.
string fiberEyeAppealKey(string tok) @safe pure { return "fibereye:appeal:" ~ tok; }
/// Self-service unban attempts from one client IP (86 400 s TTL).
string fiberEyeReleaseIpKey(string i) @safe pure { return "fibereye:release:ip:" ~ i; }
/// Successful self-service releases for one IP group (604 800 s TTL).
string fiberEyeReleaseGrpKey(string g) @safe pure { return "fibereye:release:group:" ~ g; }

/// One appeal token's payload, stored under `fiberEyeAppealKey(token)`.
///
/// The token is the only thing the banned visitor carries (it is embedded
/// in the Z-line reason), so everything the unban page needs to lift the
/// ban without a Mongo query on an untrusted parameter lives here.
struct Appeal {
    /// The Z-line mask exactly as sent to the ircd.
    string mask;
    /// The IP group the ban was computed for (equals `mask` today).
    string ipGroup;
    /// `fibereye_bans._id` of the row to mark released.
    string banId;
    /// The ban reason text, for display on the appeal page.
    string reason;
    /// When the ban was placed (unix ms).
    long placedAtMs;
    /// When the ircd will expire it on its own (unix ms).
    long expiresAtMs;

    /// Serializes to Json.
    Json toJson() const {
        return Json([
            "mask": Json(mask), "ipGroup": Json(ipGroup), "banId": Json(banId),
            "reason": Json(reason), "placedAtMs": Json(placedAtMs),
            "expiresAtMs": Json(expiresAtMs),
        ]);
    }

    /// Deserializes from Json; missing or mistyped fields keep their init value.
    static Appeal fromJson(Json j) {
        Appeal a;
        if (j.type != Json.Type.object) return a;
        a.mask = j["mask"].opt!string;
        a.ipGroup = j["ipGroup"].opt!string;
        a.banId = j["banId"].opt!string;
        a.reason = j["reason"].opt!string;
        a.placedAtMs = j["placedAtMs"].opt!long;
        a.expiresAtMs = j["expiresAtMs"].opt!long;
        return a;
    }
}
