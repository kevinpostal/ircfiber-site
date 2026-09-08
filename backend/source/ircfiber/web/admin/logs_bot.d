/**
 * Admin JSON API for the #staff log bot (`/api/admin/logs-bot`).
 *
 * The bot runs in its own container, so its state reaches the admin (IRCD
 * page) through the heartbeat it publishes to Redis and admin actions
 * travel back through the control list — see `ircfiber.logs.bot`.
 *
 * The routes are `/api/admin/logs-bot*` rather than `/api/admin/logs/bot*`:
 * `/api/admin/logs/…` already belongs to the SigNoz log proxy, where a
 * `bot` segment would read as one of its sub-resources.
 */
module ircfiber.web.admin.logs_bot;

import std.datetime : Clock;
import std.process : environment;
import std.string : strip;

import vibe.core.log : logInfo;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.logs.events : LogEvent, logsBotKey, logsControlKey, logsOutboxKey, pushLogEvent;
import ircfiber.models.user : User;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.json : sanitizeLine;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;

/// Heartbeats older than this are reported as dead even if the key has not
/// expired yet (the bot refreshes every ≤5 s with a 60 s TTL).
private enum LOGS_BOT_STALE_MS = 60_000;

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

private string jsonStr(Json j, string key) {
    auto v = j[key];
    return v.type == Json.Type.string ? v.get!string : "";
}

private User currentAdmin(HTTPServerRequest req) {
    if (auto p = "user" in req.context) return (*p).get!User;
    return User.init;
}

/// GET /api/admin/logs-bot — last heartbeat published by the bot process
/// plus queue depths. `alive` is false when there is no fresh heartbeat
/// (bot container down or Redis unreachable from it).
package void apiLogsBotStatus(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    Json status = Json(null);
    try status = redis.getJson(logsBotKey());
    catch (Exception) {}
    bool alive = false;
    long ageMs = -1;
    if (status.type == Json.Type.object) {
        const updatedAt = status["updatedAt"].opt!long;
        ageMs = updatedAt > 0 ? nowMs() - updatedAt : -1;
        alive = ageMs >= 0 && ageMs <= LOGS_BOT_STALE_MS;
    } else {
        status = Json(null);
    }
    long outboxDepth = -1, controlDepth = -1;
    try outboxDepth = redis.getDb().llen(logsOutboxKey()); catch (Exception) {}
    try controlDepth = redis.getDb().llen(logsControlKey()); catch (Exception) {}

    auto data = Json.emptyObject;
    data["status"] = status;
    data["alive"] = Json(alive);
    data["heartbeatAgeMs"] = Json(ageMs);
    data["outboxDepth"] = Json(outboxDepth);
    data["controlDepth"] = Json(controlDepth);
    // What this deployment expects, so the page can name the bot even
    // before its first heartbeat.
    auto nick = environment.get("IRCFIBER_LOGS_BOT_NICK", "").strip();
    auto channel = environment.get("IRCFIBER_LOGS_BOT_CHANNEL", "").strip();
    data["expectedNick"] = Json(nick.length ? nick : "FiberLogs");
    data["expectedChannel"] = Json(channel.length ? channel : "#staff");
    data["runsInThisProcess"] = Json(isEnvEnabled("IRCFIBER_LOGS_BOT_ENABLED"));
    jsonOk(res, data);
}

/// Queues `cmd` for the bot; it drops commands older than 60 s, so a
/// request made while the bot is down does not fire on its next start.
private void queueLogsBotCommand(HTTPServerRequest req, HTTPServerResponse res,
                                 RedisStorage redis, string cmd) {
    auto admin = currentAdmin(req);
    auto entry = Json([
        "cmd": Json(cmd), "by": Json(admin.username), "ts": Json(nowMs()),
    ]);
    try {
        auto db = redis.getDb();
        db.rpush(logsControlKey(), entry.toString());
        db.ltrim(logsControlKey(), -20, -1);
    } catch (Exception e) {
        jsonError(res, 502, "Redis unavailable: " ~ e.msg);
        return;
    }
    logInfo("Admin %s queued logs bot command %s", admin.username, cmd);
    auto data = Json.emptyObject;
    data["queued"] = Json(cmd);
    jsonOk(res, data);
}

/// POST /api/admin/logs-bot/reconnect — drop and re-establish the IRC session.
package void apiLogsBotReconnect(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueLogsBotCommand(req, res, redis, "reconnect");
}

/// POST /api/admin/logs-bot/rejoin — re-send JOIN for the staff channel.
package void apiLogsBotRejoin(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueLogsBotCommand(req, res, redis, "rejoin");
}

/// POST /api/admin/logs-bot/announce — body `{text}`; the bot says
/// `Notice from <admin>: <text>` in the staff channel (via the outbox, so
/// it is delivered once the bot is back if it is currently away).
package void apiLogsBotAnnounce(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    const text = body_.type == Json.Type.object ? sanitizeLine(jsonStr(body_, "text")) : "";
    if (text.length < 1 || text.length > 300) {
        jsonError(res, 400, "text must be 1–300 characters");
        return;
    }
    auto admin = currentAdmin(req);
    LogEvent ev;
    ev.type = "notice";
    ev.text = text;
    ev.actor = admin.username;
    ev.ts = nowMs();
    pushLogEvent(redis, ev);
    logInfo("Admin %s queued #staff notice (%d chars)", admin.username, text.length);
    auto data = Json.emptyObject;
    data["queued"] = Json(true);
    data["text"] = Json(text);
    jsonOk(res, data);
}
