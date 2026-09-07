/**
 * Admin JSON API for MOTD templates (`/api/admin/motd`) and the two ways
 * they reach users:
 *
 *  - Redis mirror (`RedisKeys.motdTemplates`): rewritten after every edit;
 *    the engine reads it on each connect to irc.ircfiber.com and serves a
 *    random enabled template in place of the ircd's 372 lines (per-connect
 *    randomness for everyone connecting through IRC Fiber).
 *  - IRCd rotation: a random enabled template is rendered into the ircd's
 *    `motd` file (the conf dir is bind-mounted into the gateway) and the
 *    ircd is REHASHed, so clients connecting straight to the ircd also
 *    cycle through the set. Runs on every edit and hourly
 *    (`startMotdRotation`); InspIRCd caches the file per rehash, so this is
 *    the finest rotation the ircd itself supports.
 */
module ircfiber.web.admin.motd;

import std.conv : to;
import std.datetime : Clock;
import std.file : exists, isDir, write, rename, remove;
import std.path : buildPath, dirName;
import std.random : uniform;
import std.string : strip;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;

import ircfiber.db.motd_templates : MotdTemplateRepository, MotdTemplateRecord,
    motdTemplatesToJson, validateMotdBody, seedDefaultMotdTemplates;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;
import ircfiber.web.admin.ircd : loadIrcdSettings, rehashIrcdNow;

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

/// Redis key holding `{id,name,at}` of the template currently in the ircd
/// file; shared across gateway instances so the hourly timer rotates once.
private immutable string MOTD_CURRENT_KEY = "irc:config:motdCurrent";
/// Hourly rotation cadence.
private immutable long MOTD_ROTATION_MS = 3_600_000;

private User currentAdmin(HTTPServerRequest req) {
    if (auto p = "user" in req.context) return (*p).get!User;
    return User.init;
}

private string jsonStr(Json j, string key) {
    auto v = j[key];
    return v.type == Json.Type.string ? v.get!string : "";
}

/// Rewrites the Redis mirror from Mongo. Best effort: a Redis outage must
/// not fail the admin edit (Mongo is the source of truth).
public void publishMotdTemplates(RedisStorage redis, MotdTemplateRepository repo) {
    try {
        redis.getDb().set(RedisKeys.motdTemplates(), motdTemplatesToJson(repo.all()));
    } catch (Exception e) {
        logWarn("motd: failed to publish templates to Redis: %s", e.msg);
    }
}

/// What the ircd is currently serving, as recorded by the last rotation.
private Json currentJson(RedisStorage redis) {
    try {
        auto raw = redis.getDb().get(MOTD_CURRENT_KEY);
        if (raw.length) return parseJsonString(raw);
    } catch (Exception) {}
    return Json(null);
}

/// Path of the ircd MOTD file inside the gateway container. `motd.d/` is
/// the one conf subdir mounted read-write (roles/gateway/tasks/container.yml).
private string motdFilePath() {
    return buildPath(loadIrcdSettings().confDir, "motd.d", "motd");
}

/// Renders `t` into the ircd MOTD file and REHASHes. Returns "" on success
/// or the failure reason. The file is written atomically (rename) so a
/// rehash racing the write never loads a half-written MOTD.
private string rotateTo(RedisStorage redis, MotdTemplateRecord t) {
    auto path = motdFilePath();
    auto dir = dirName(path);
    if (!exists(dir) || !isDir(dir)) return "ircd MOTD dir " ~ dir ~ " is not mounted";
    auto tmp = path ~ ".tmp";
    try {
        string text;
        foreach (l; t.lines()) text ~= l ~ "\n";
        write(tmp, text);
        rename(tmp, path);
    } catch (Exception e) {
        try if (exists(tmp)) remove(tmp); catch (Exception) {}
        return "cannot write " ~ path ~ ": " ~ e.msg;
    }
    try {
        rehashIrcdNow();
    } catch (Exception e) {
        return "MOTD file written but REHASH failed: " ~ e.msg;
    }
    try {
        Json cur = Json.emptyObject;
        cur["id"] = Json(t.id);
        cur["name"] = Json(t.name);
        cur["at"] = Json(nowMs());
        redis.getDb().set(MOTD_CURRENT_KEY, cur.toString());
    } catch (Exception e) {
        logWarn("motd: rotated but failed to record current template: %s", e.msg);
    }
    logInfo("motd: ircd now serves template '%s' (%s)", t.name, t.id);
    return "";
}

/// Picks a random enabled template (never the one currently served when
/// there is a choice) and rotates the ircd to it. Returns "" on success.
package string rotateRandom(RedisStorage redis, MotdTemplateRepository repo) {
    auto pool = repo.enabled();
    if (pool.length == 0) return "no enabled templates";
    auto cur = currentJson(redis);
    string curId = cur.type == Json.Type.object ? jsonStr(cur, "id") : "";
    if (pool.length > 1 && curId.length) {
        MotdTemplateRecord[] others;
        foreach (t; pool) if (t.id != curId) others ~= t;
        if (others.length) pool = others;
    }
    return rotateTo(redis, pool[uniform(0, pool.length)]);
}

/// Everything a write does after Mongo: mirror to Redis, rotate the ircd.
/// Returns the rotation error ("" when it went through) for the response.
private string afterWrite(RedisStorage redis, MotdTemplateRepository repo) {
    publishMotdTemplates(redis, repo);
    return rotateRandom(redis, repo);
}

private Json listJson(RedisStorage redis, MotdTemplateRepository repo, string rotationError) {
    Json data = Json.emptyObject;
    Json arr = Json.emptyArray;
    foreach (t; repo.all()) arr ~= t.toJson();
    data["templates"] = arr;
    Json rot = Json.emptyObject;
    rot["current"] = currentJson(redis);
    rot["file"] = Json(motdFilePath());
    rot["intervalMs"] = Json(MOTD_ROTATION_MS);
    rot["error"] = Json(rotationError);
    data["rotation"] = rot;
    return data;
}

/// GET /api/admin/motd — every template plus the ircd rotation state.
/// Seeds the launch defaults into an empty collection.
package void apiMotdList(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    if (seedDefaultMotdTemplates(repo) > 0) publishMotdTemplates(redis, repo);
    jsonOk(res, listJson(redis, repo, ""));
}

/// Reads and validates `{name, body, enabled?, sortOrder?}`; "" on success.
private string readTemplateBody(HTTPServerRequest req, ref MotdTemplateRecord r) {
    auto j = readJsonBody(req);
    if (j.type != Json.Type.object) return "invalid body";
    auto name = jsonStr(j, "name").strip;
    if (name.length == 0) return "name is required";
    if (name.length > 80) return "name is too long";
    auto body_ = jsonStr(j, "body");
    auto why = validateMotdBody(body_);
    if (why.length) return why;
    r.name = name;
    r.body_ = body_;
    if (j["enabled"].type == Json.Type.bool_) r.enabled = j["enabled"].get!bool;
    if (j["sortOrder"].type == Json.Type.int_) r.sortOrder = j["sortOrder"].get!long;
    if (j["recipe"].type == Json.Type.string) r.recipe = j["recipe"].get!string;
    if (j["group"].type == Json.Type.string) r.group = jsonStr(j, "group").strip;
    if (r.recipe.length > 64_000) return "recipe is too large";
    if (r.group.length > 80) return "group is too long";
    return "";
}

/// POST /api/admin/motd — create. Body `{name, body, enabled=true, sortOrder?}`.
package void apiMotdCreate(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    MotdTemplateRecord r;
    r.enabled = true;
    r.sortOrder = (repo.count() + 1) * 10;
    auto why = readTemplateBody(req, r);
    if (why.length) { jsonError(res, 400, why); return; }
    r = repo.insert(r);
    logInfo("Admin %s created MOTD template '%s'", currentAdmin(req).username, r.name);
    jsonOk(res, listJson(redis, repo, afterWrite(redis, repo)));
}

/// POST /api/admin/motd/:id — replace name/body/enabled/sortOrder.
package void apiMotdUpdate(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    auto r = repo.getById(req.params["id"]);
    if (r.id.length == 0) { jsonError(res, 404, "not found"); return; }
    auto why = readTemplateBody(req, r);
    if (why.length) { jsonError(res, 400, why); return; }
    repo.update(r.id, r.name, r.body_, r.enabled, r.sortOrder, r.recipe, r.group);
    logInfo("Admin %s updated MOTD template '%s'", currentAdmin(req).username, r.name);
    jsonOk(res, listJson(redis, repo, afterWrite(redis, repo)));
}

/// POST /api/admin/motd/:id/delete
package void apiMotdDelete(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    const id = req.params["id"];
    auto r = repo.getById(id);
    if (r.id.length == 0) { jsonError(res, 404, "not found"); return; }
    repo.remove(id);
    logInfo("Admin %s deleted MOTD template '%s'", currentAdmin(req).username, r.name);
    jsonOk(res, listJson(redis, repo, afterWrite(redis, repo)));
}

/// POST /api/admin/motd/batch — body `{group, recipe, items:[{name, body,
/// enabled?}]}`: replaces every template in `group` with `items` (variants
/// the builder generated from one recipe), then mirrors + rotates once.
/// One round-trip instead of N deletes + M creates each REHASHing the ircd.
package void apiMotdBatch(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    auto j = readJsonBody(req);
    if (j.type != Json.Type.object) { jsonError(res, 400, "invalid body"); return; }
    auto group = jsonStr(j, "group").strip;
    if (group.length == 0 || group.length > 80) { jsonError(res, 400, "group is required"); return; }
    auto recipe = jsonStr(j, "recipe");
    if (recipe.length > 64_000) { jsonError(res, 400, "recipe is too large"); return; }
    auto items = j["items"];
    if (items.type != Json.Type.array || items.length == 0 || items.length > 50) {
        jsonError(res, 400, "items must hold 1–50 templates");
        return;
    }
    MotdTemplateRecord[] records;
    foreach (i; 0 .. items.length) {
        auto item = items[i];
        if (item.type != Json.Type.object) { jsonError(res, 400, "invalid item"); return; }
        MotdTemplateRecord r;
        r.name = jsonStr(item, "name").strip;
        if (r.name.length == 0 || r.name.length > 80) { jsonError(res, 400, "item " ~ (i + 1).to!string ~ ": name is required"); return; }
        r.body_ = jsonStr(item, "body");
        auto why = validateMotdBody(r.body_);
        if (why.length) { jsonError(res, 400, "item " ~ (i + 1).to!string ~ ": " ~ why); return; }
        r.enabled = item["enabled"].type == Json.Type.bool_ ? item["enabled"].get!bool : true;
        r.recipe = recipe;
        r.group = group;
        records ~= r;
    }
    auto removed = repo.removeGroup(group);
    auto base = (repo.count() + 1) * 10;
    foreach (i, ref r; records) { r.sortOrder = base + i * 10; r = repo.insert(r); }
    logInfo("Admin %s regenerated MOTD group '%s': %d removed, %d created",
        currentAdmin(req).username, group, removed, records.length);
    jsonOk(res, listJson(redis, repo, afterWrite(redis, repo)));
}
/// POST /api/admin/motd/rotate — body `{id?}`: rotate the ircd to that
/// template, or to a random enabled one when omitted.
package void apiMotdRotate(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    auto j = readJsonBody(req);
    string err;
    auto id = j.type == Json.Type.object ? jsonStr(j, "id") : "";
    if (id.length) {
        auto t = repo.getById(id);
        if (t.id.length == 0) { jsonError(res, 404, "not found"); return; }
        err = rotateTo(redis, t);
    } else {
        err = rotateRandom(redis, repo);
    }
    if (err.length) { jsonError(res, 502, err); return; }
    jsonOk(res, listJson(redis, repo, ""));
}

/// Hourly ircd rotation, started once at gateway boot on the main thread
/// (the oper session used by REHASH is main-thread state). Skips when
/// another gateway instance rotated within the last interval, so a
/// blue/green pair does not double the cadence. Also refreshes the Redis
/// mirror so a Redis flush cannot silently disable per-connect MOTDs.
public void startMotdRotation(RedisStorage redis) {
    import vibe.core.core : setTimer;
    import core.time : minutes;
    setTimer(10.minutes, () @trusted nothrow {
        try {
            auto repo = new MotdTemplateRepository();
            publishMotdTemplates(redis, repo);
            auto cur = currentJson(redis);
            long at = cur.type == Json.Type.object && cur["at"].type == Json.Type.int_ ? cur["at"].get!long : 0;
            if (nowMs() - at < MOTD_ROTATION_MS - 60_000) return;
            auto err = rotateRandom(redis, repo);
            if (err.length) logWarn("motd: hourly rotation skipped: %s", err);
        } catch (Exception e) {
            logWarn("motd: rotation timer failed: %s", e.msg);
        }
    }, true);
}
