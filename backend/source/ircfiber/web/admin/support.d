/**
 * Admin JSON API for Help & Feedback reports (`/api/admin/support/issues`)
 * and the #support services bot (`/api/admin/support/bot`).
 *
 * Triage (status / priority / assignee), two-way conversation with the
 * reporter (public replies) plus admin-only internal notes, and hard
 * delete. Every user-visible change is announced in #support through the
 * Redis outbox (`ircfiber.support.events`); internal notes never are.
 *
 * The bot runs in its own container, so its state reaches the admin
 * (IRCD page) through the heartbeat it publishes to Redis and admin actions
 * travel back through the control list — see `ircfiber.support.bot`.
 */
module ircfiber.web.admin.support;

import std.algorithm : canFind;
import std.conv : to;
import std.datetime : Clock;
import std.string : strip;
import std.uuid : UUID, parseUUID, randomUUID;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.auth : isAdmin;
import ircfiber.db.user : UserRepository;
import ircfiber.db.support_issues : SupportIssueRepository, SupportIssueRecord, SupportComment,
    SupportAdminFilter, supportStatuses;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.events : SupportEvent, pushSupportEvent;
import ircfiber.support.json : supportIssueToJson, sanitizeLine, isValidStatus, isValidPriority;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

private string jsonStr(Json j, string key) {
    auto v = j[key];
    return v.type == Json.Type.string ? v.get!string : "";
}

private User currentAdmin(HTTPServerRequest req) {
    if (auto p = "user" in req.context) return (*p).get!User;
    return User.init;
}

/// Admin detail payload: full issue incl. internal notes and diagnostics,
/// plus the reporter's e-mail (looked up live; "" when the user is gone).
private Json detailJson(const SupportIssueRecord r) {
    auto j = supportIssueToJson(r, true, true);
    string email;
    try {
        auto u = new UserRepository().findById(parseUUID(r.userId.idup));
        email = u.email;
    } catch (Exception) {}
    j["reporterEmail"] = Json(email);
    return j;
}

private Json countsJson(long[string] counts) {
    Json c = Json.emptyObject;
    foreach (s; supportStatuses) c[s] = Json(counts.get(s, 0));
    return c;
}

/// GET /api/admin/support/issues?page&limit&status&kind&q&assignee
///
/// `status`: `all` → every status; a valid status → that one; absent or
/// anything else → the active set (open + in_progress).
package void apiSupportIssuesList(HTTPServerRequest req, HTTPServerResponse res) {
    int page = 0;
    int limit = 50;
    if (auto p = "page" in req.query) { try page = (*p).to!int; catch (Exception) {} }
    if (auto l = "limit" in req.query) { try limit = (*l).to!int; catch (Exception) {} }
    if (page < 0) page = 0;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    SupportAdminFilter f;
    const status = req.query.get("status", "");
    if (status == "all") f.statuses = [];
    else if (isValidStatus(status)) f.statuses = [status];
    else f.statuses = ["open", "in_progress"];
    f.kind = req.query.get("kind", "");
    auto q = req.query.get("q", "").strip();
    if (q.length > 100) q = q[0 .. 100];
    f.q = q;
    f.assigneeId = req.query.get("assignee", "");

    auto repo = new SupportIssueRepository();
    auto rows = repo.pageAdmin(f, page * limit, limit);
    const total = repo.countAdmin(f);

    Json[] arr;
    foreach (ref r; rows) {
        auto j = supportIssueToJson(r, true, false);
        j.remove("comments");
        arr ~= j;
    }
    Json data = Json.emptyObject;
    data["issues"] = Json(arr);
    data["total"] = Json(total);
    data["page"] = Json(page);
    data["limit"] = Json(limit);
    data["counts"] = countsJson(repo.countByStatus());
    jsonOk(res, data);
}

/// GET /api/admin/support/issues/:id
package void apiSupportIssueDetail(HTTPServerRequest req, HTTPServerResponse res) {
    auto repo = new SupportIssueRepository();
    auto r = repo.getById(req.params["id"]);
    if (r.id.length == 0) { jsonError(res, 404, "not found"); return; }
    jsonOk(res, detailJson(r));
}

/// POST /api/admin/support/issues/:id — body `{status?, priority?, assigneeId?}`.
/// Omitted fields keep their value. A status change is announced in #support.
package void apiSupportIssueUpdate(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new SupportIssueRepository();
    auto r = repo.getById(req.params["id"]);
    if (r.id.length == 0) { jsonError(res, 404, "not found"); return; }

    auto body_ = readJsonBody(req);
    if (body_.type != Json.Type.object) { jsonError(res, 400, "invalid body"); return; }

    string status = r.status;
    if (body_["status"].type == Json.Type.string) {
        status = body_["status"].get!string;
        if (!isValidStatus(status)) { jsonError(res, 400, "invalid status"); return; }
    }
    string priority = r.priority;
    if (body_["priority"].type == Json.Type.string) {
        priority = body_["priority"].get!string;
        if (!isValidPriority(priority)) { jsonError(res, 400, "invalid priority"); return; }
    }
    string assigneeId = r.assigneeId;
    string assigneeUsername = r.assigneeUsername;
    if (body_["assigneeId"].type == Json.Type.string) {
        assigneeId = body_["assigneeId"].get!string.strip();
        if (assigneeId.length == 0) {
            assigneeUsername = "";
        } else {
            User u;
            // .idup: parseUUID consumes an lvalue string (see vibe-d-parseuuid-idup).
            try u = new UserRepository().findById(parseUUID(assigneeId.idup));
            catch (Exception) {}
            if (!isAdmin(u)) { jsonError(res, 400, "assignee must be an admin"); return; }
            assigneeUsername = u.username;
        }
    }

    const now = nowMs();
    const bool finished = status == "resolved" || status == "closed";
    long resolvedAt = r.resolvedAt;
    if (finished && resolvedAt == 0) resolvedAt = now;
    else if (!finished) resolvedAt = 0;

    if (!repo.updateTriage(r.id, status, priority, assigneeId, assigneeUsername, now, resolvedAt)) {
        jsonError(res, 404, "not found");
        return;
    }
    auto admin = currentAdmin(req);
    logInfo("Admin %s updated support issue #%d: status=%s priority=%s assignee=%s",
        admin.username, r.number, status, priority, assigneeUsername.length ? assigneeUsername : "-");

    if (status != r.status) {
        SupportEvent ev;
        ev.type = "status_changed";
        ev.issueId = r.id;
        ev.number = r.number;
        ev.kind = r.kind;
        ev.title = r.title;
        ev.status = status;
        ev.priority = priority;
        ev.actor = admin.username;
        ev.reporter = r.reporterUsername;
        ev.actorIsAdmin = true;
        ev.ts = now;
        pushSupportEvent(redis, ev);
    }
    jsonOk(res, detailJson(repo.getById(r.id)));
}

/// POST /api/admin/support/issues/:id/comments — body `{body, internal}`.
/// Public replies are announced in #support; internal notes are not.
package void apiSupportIssueComment(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new SupportIssueRepository();
    auto r = repo.getById(req.params["id"]);
    if (r.id.length == 0) { jsonError(res, 404, "not found"); return; }

    auto body_ = readJsonBody(req);
    const text = body_.type == Json.Type.object ? jsonStr(body_, "body").strip() : "";
    if (text.length < 1 || text.length > 5000) {
        jsonError(res, 400, "comment must be 1–5000 characters");
        return;
    }
    const bool internal = body_["internal"].type == Json.Type.bool_ && body_["internal"].get!bool;

    auto admin = currentAdmin(req);
    const now = nowMs();
    SupportComment c;
    c.id = randomUUID().toString();
    c.authorId = admin.id.toString();
    c.authorName = admin.username;
    c.fromAdmin = true;
    c.internal = internal;
    c.body_ = text;
    c.createdAt = now;
    if (!repo.appendComment(r.id, c, now, "", r.resolvedAt)) {
        jsonError(res, 404, "not found");
        return;
    }

    if (!internal) {
        SupportEvent ev;
        ev.type = "comment_added";
        ev.issueId = r.id;
        ev.number = r.number;
        ev.kind = r.kind;
        ev.title = r.title;
        ev.status = r.status;
        ev.priority = r.priority;
        ev.actor = admin.username;
        ev.reporter = r.reporterUsername;
        ev.actorIsAdmin = true;
        ev.ts = now;
        pushSupportEvent(redis, ev);
    }
    jsonOk(res, detailJson(repo.getById(r.id)));
}

/// POST /api/admin/support/issues/:id/delete — permanent removal.
package void apiSupportIssueDelete(HTTPServerRequest req, HTTPServerResponse res) {
    auto repo = new SupportIssueRepository();
    const id = req.params["id"];
    auto r = repo.getById(id);
    if (r.id.length && repo.hardDelete(id)) {
        auto admin = currentAdmin(req);
        logInfo("Admin %s deleted support issue #%d", admin.username, r.number);
    }
    Json data = Json.emptyObject;
    data["deletedId"] = Json(id);
    jsonOk(res, data);
}

// ── #support services bot ─────────────────────────────────────────

/// Heartbeats older than this are reported as dead even if the key has
/// not expired yet (the bot refreshes every ≤5 s with a 60 s TTL).
private enum SUPPORT_BOT_STALE_MS = 60_000;

/// GET /api/admin/support/bot — last heartbeat published by the bot
/// process plus queue depths. `alive` is false when there is no fresh
/// heartbeat (bot container down or Redis unreachable from it).
package void apiSupportBotStatus(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    import std.process : environment;
    Json status = Json(null);
    try status = redis.getJson(RedisKeys.supportBot());
    catch (Exception) {}
    bool alive = false;
    long ageMs = -1;
    if (status.type == Json.Type.object) {
        const updatedAt = status["updatedAt"].opt!long;
        ageMs = updatedAt > 0 ? nowMs() - updatedAt : -1;
        alive = ageMs >= 0 && ageMs <= SUPPORT_BOT_STALE_MS;
    } else {
        status = Json(null);
    }
    long outboxDepth = -1, controlDepth = -1;
    try outboxDepth = redis.getDb().llen(RedisKeys.supportOutbox()); catch (Exception) {}
    try controlDepth = redis.getDb().llen(RedisKeys.supportBotControl()); catch (Exception) {}

    auto data = Json.emptyObject;
    data["status"] = status;
    data["alive"] = Json(alive);
    data["heartbeatAgeMs"] = Json(ageMs);
    data["outboxDepth"] = Json(outboxDepth);
    data["controlDepth"] = Json(controlDepth);
    // What this deployment expects, so the page can name the bot even
    // before its first heartbeat.
    auto nick = environment.get("IRCFIBER_SUPPORT_BOT_NICK", "").strip();
    auto channel = environment.get("IRCFIBER_SUPPORT_BOT_CHANNEL", "").strip();
    data["expectedNick"] = Json(nick.length ? nick : "FIBERSUPPORT");
    data["expectedChannel"] = Json(channel.length ? channel : "#support");
    data["runsInThisProcess"] = Json(isEnvEnabled("IRCFIBER_SUPPORT_BOT_ENABLED"));
    jsonOk(res, data);
}

/// Queues `cmd` for the bot; it drops commands older than 60 s, so a
/// request made while the bot is down does not fire on its next start.
private void queueBotCommand(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis, string cmd) {
    auto admin = currentAdmin(req);
    auto entry = Json([
        "cmd": Json(cmd), "by": Json(admin.username), "ts": Json(nowMs()),
    ]);
    try {
        auto db = redis.getDb();
        db.rpush(RedisKeys.supportBotControl(), entry.toString());
        db.ltrim(RedisKeys.supportBotControl(), -20, -1);
    } catch (Exception e) {
        jsonError(res, 502, "Redis unavailable: " ~ e.msg);
        return;
    }
    logInfo("Admin %s queued support bot command %s", admin.username, cmd);
    auto data = Json.emptyObject;
    data["queued"] = Json(cmd);
    jsonOk(res, data);
}

/// POST /api/admin/support/bot/reconnect — drop and re-establish the IRC session.
package void apiSupportBotReconnect(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueBotCommand(req, res, redis, "reconnect");
}

/// POST /api/admin/support/bot/rejoin — re-send JOIN for the support channel.
package void apiSupportBotRejoin(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueBotCommand(req, res, redis, "rejoin");
}

/// POST /api/admin/support/bot/announce — body `{text}`; the bot says
/// `Notice from <admin>: <text>` in the support channel (via the outbox,
/// so it is delivered once the bot is back if it is currently away).
package void apiSupportBotAnnounce(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    const text = body_.type == Json.Type.object ? sanitizeLine(jsonStr(body_, "text")) : "";
    if (text.length < 1 || text.length > 300) {
        jsonError(res, 400, "text must be 1–300 characters");
        return;
    }
    auto admin = currentAdmin(req);
    SupportEvent ev;
    ev.type = "notice";
    ev.title = text;
    ev.actor = admin.username;
    ev.actorIsAdmin = true;
    ev.ts = nowMs();
    pushSupportEvent(redis, ev);
    logInfo("Admin %s queued #support notice (%d chars)", admin.username, text.length);
    auto data = Json.emptyObject;
    data["queued"] = Json(true);
    data["text"] = Json(text);
    jsonOk(res, data);
}
