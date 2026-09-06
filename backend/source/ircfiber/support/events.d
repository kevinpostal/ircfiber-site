/**
 * Support-issue announcements: gateway → #support bot transport.
 *
 * Every user-visible change to a support issue (new report, status change,
 * public comment) is serialized as a `SupportEvent` and RPUSHed onto the
 * Redis list `RedisKeys.supportOutbox()`. The bot (`ircfiber.support.bot`)
 * BLPOPs the list and formats one IRC line per event. The list is FIFO,
 * survives bot restarts and is trimmed to the newest 1000 entries so a
 * long bot outage cannot grow it without bound.
 */
module ircfiber.support.events;

import vibe.data.json : Json;
import vibe.core.log;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.redis.protocol : RedisKeys;

/// Maximum number of queued announcements kept when the bot is away.
enum SUPPORT_OUTBOX_MAX = 1000;

/// One announcement. Never carries the report body, e-mail or diagnostics —
/// only what may be shown in a public channel.
struct SupportEvent {
    /// "issue_created" | "status_changed" | "comment_added" | "notice"
    /// (free text from the admin IRCD page; `title` carries the text).
    string type;
    /// Issue id (UUID string) — used for the admin deep link.
    string issueId;
    /// Human issue number.
    long number;
    /// Issue kind wire value.
    string kind;
    /// Issue title (untruncated; the bot truncates for IRC).
    string title;
    /// Status after the action.
    string status;
    /// Priority after the action.
    string priority;
    /// Username performing the action ("" for issue_created).
    string actor;
    /// Reporter username.
    string reporter;
    /// The actor acted from the admin pane.
    bool actorIsAdmin;
    /// A reporter follow-up reopened a resolved/closed issue.
    bool reopened;
    /// Event timestamp (unix ms).
    long ts;

    /// Serializes to Json.
    Json toJson() const {
        return Json([
            "type": Json(type), "issueId": Json(issueId), "number": Json(number),
            "kind": Json(kind), "title": Json(title), "status": Json(status),
            "priority": Json(priority), "actor": Json(actor), "reporter": Json(reporter),
            "actorIsAdmin": Json(actorIsAdmin), "reopened": Json(reopened), "ts": Json(ts),
        ]);
    }

    /// Deserializes from Json; missing or mistyped fields keep their init value.
    static SupportEvent fromJson(Json j) {
        SupportEvent ev;
        if (j.type != Json.Type.object) return ev;
        ev.type = j["type"].opt!string;
        ev.issueId = j["issueId"].opt!string;
        ev.number = j["number"].opt!long;
        ev.kind = j["kind"].opt!string;
        ev.title = j["title"].opt!string;
        ev.status = j["status"].opt!string;
        ev.priority = j["priority"].opt!string;
        ev.actor = j["actor"].opt!string;
        ev.reporter = j["reporter"].opt!string;
        ev.actorIsAdmin = j["actorIsAdmin"].opt!bool;
        ev.reopened = j["reopened"].opt!bool;
        ev.ts = j["ts"].opt!long;
        return ev;
    }
}

/// Queues `ev` for the #support bot: RPUSH + LTRIM to the newest
/// `SUPPORT_OUTBOX_MAX`. Announcing is best-effort — failures are logged,
/// never thrown, so a Redis hiccup cannot fail the HTTP request that
/// already persisted the issue.
void pushSupportEvent(RedisStorage redis, SupportEvent ev) @trusted {
    if (redis is null) return;
    try {
        auto db = redis.getDb();
        const key = RedisKeys.supportOutbox();
        db.rpush(key, ev.toJson().toString());
        db.ltrim(key, -SUPPORT_OUTBOX_MAX, -1);
    } catch (Exception e) {
        logWarn("support outbox push failed (%s #%d): %s", ev.type, ev.number, e.msg);
    }
}
