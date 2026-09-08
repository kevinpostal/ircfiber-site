/**
 * Admin JSON API for MOTD templates (`/api/admin/motd`): Mongo is the
 * source of truth and every edit rewrites the ircd's `motd.d/pool`
 * (`writePool`), from which the ircd's motdpool module draws one block per
 * connect with per-user `{placeholders}` from `motd.d/profiles`
 * (motd_profiles.d). No REHASH, no rotation, no Redis mirror — the ircd is
 * the only MOTD renderer.
 */
module ircfiber.web.admin.motd;

import std.conv : to;
import std.file : exists, isDir, write, rename, remove;
import std.path : buildPath, dirName;
import std.string : strip, replace;
import std.array : join;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.db.motd_templates : MotdTemplateRepository, MotdTemplateRecord,
    validateMotdBody, seedDefaultMotdTemplates;
import ircfiber.models.user : User;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;
import ircfiber.web.admin.ircd : loadIrcdSettings;
import ircfiber.web.admin.motd_profiles : motdProfilesPath, motdProfileCount;

/// Blocks in the last successful pool write (0 until one happens); shown in
/// the admin UI as the size of the set the ircd draws from.
private __gshared long motdPoolBlocks = 0;

private User currentAdmin(HTTPServerRequest req) {
    if (auto p = "user" in req.context) return (*p).get!User;
    return User.init;
}

private string jsonStr(Json j, string key) {
    auto v = j[key];
    return v.type == Json.Type.string ? v.get!string : "";
}

/// Path of the ircd MOTD pool inside the gateway container. `motd.d/` is
/// the one conf subdir mounted read-write (roles/gateway/tasks/container.yml).
package string motdPoolPath() {
    return buildPath(loadIrcdSettings().confDir, "motd.d", "pool");
}

/// Atomic write (tmp + rename) of `text` to `path`, so the ircd's periodic
/// re-read never sees a half-written file. "" on success or the reason.
/// Afterwards the file is chowned to the ircd's uid/gid (10000, the
/// `--uid/--gid` our Containerfile.ircd builds with and the owner of the
/// conf dir): the gateway runs as root, and every `ReadFile` open of a
/// root-owned file logs a "Possible configuration error" ownership warning
/// — 4 lines a minute once pool + profiles both exist. A failed chown is
/// ignored: the file stays world-readable and the ircd serves it anyway.
package string writeIrcdFile(string path, string text) {
    import core.sys.posix.unistd : chown;
    import std.string : toStringz;
    auto dir = dirName(path);
    if (!exists(dir) || !isDir(dir)) return "ircd MOTD dir " ~ dir ~ " is not mounted";
    auto tmp = path ~ ".tmp";
    try {
        write(tmp, text);
        rename(tmp, path);
    } catch (Exception e) {
        try if (exists(tmp)) remove(tmp); catch (Exception) {}
        return "cannot write " ~ path ~ ": " ~ e.msg;
    }
    try chown(path.toStringz, 10000, 10000); catch (Exception) {}
    return "";
}

/// Id of the admin-pinned template ("" when none).
private string pinnedId(RedisStorage redis) {
    try { return redis.getDb().get(RedisKeys.motdPinned()); } catch (Exception) { return ""; }
}

private void setPinned(RedisStorage redis, string id) {
    try {
        if (id.length) redis.getDb().set(RedisKeys.motdPinned(), id);
        else redis.getDb().del(RedisKeys.motdPinned());
    } catch (Exception e) {
        logWarn("motd: failed to update pinned template: %s", e.msg);
    }
}

/// Block id the pool carries for a template: the UUID without hyphens (32
/// chars, inside the module's [A-Za-z0-9_-]{1,32} header rule). A profile
/// record that pins a block (`motd=`) must use the same form.
package string poolBlockId(string templateId) {
    return templateId.replace("-", "");
}

/// Writes the ircd pool: every enabled template as one `#id:`-headed block
/// separated by `%%` lines — or, while a template is pinned (and still
/// enabled), only that block, which is what makes "pinned" mean "everyone
/// sees this one". Returns "" on success or the failure reason.
public string writePool(RedisStorage redis, MotdTemplateRepository repo) {
    auto pool = repo.enabled();
    if (pool.length == 0) return "no enabled templates";
    auto pin = pinnedId(redis);
    if (pin.length) {
        MotdTemplateRecord[] only;
        foreach (t; pool) if (t.id == pin) only ~= t;
        if (only.length) pool = only;
        else setPinned(redis, ""); // Pinned template deleted or disabled: the pin is void.
    }
    // Joined, not terminated: a final "\n" would read as one empty line at
    // the end of the last block.
    string[] rows;
    foreach (i, t; pool) {
        if (i) rows ~= "%%";
        rows ~= "#id: " ~ poolBlockId(t.id);
        rows ~= t.lines();
    }
    auto text = rows.join("\n");
    auto err = writeIrcdFile(motdPoolPath(), text);
    if (err.length) return err;
    motdPoolBlocks = pool.length;
    logInfo("motd: ircd pool holds %d template(s)%s", pool.length, pin.length ? " (pinned)" : "");
    return "";
}

/// Everything a write does after Mongo: rewrite the pool. Returns the pool
/// error ("" when it went through) for the response.
private string afterWrite(RedisStorage redis, MotdTemplateRepository repo) {
    return writePool(redis, repo);
}

private Json listJson(RedisStorage redis, MotdTemplateRepository repo, string poolError) {
    Json data = Json.emptyObject;
    Json arr = Json.emptyArray;
    foreach (t; repo.all()) arr ~= t.toJson();
    data["templates"] = arr;
    Json rot = Json.emptyObject;
    rot["pinnedId"] = Json(pinnedId(redis));
    rot["poolFile"] = Json(motdPoolPath());
    rot["profilesFile"] = Json(motdProfilesPath());
    rot["blocks"] = Json(motdPoolBlocks);
    rot["profiles"] = Json(motdProfileCount());
    rot["error"] = Json(poolError);
    data["rotation"] = rot;
    return data;
}

/// GET /api/admin/motd — every template plus the ircd pool state.
/// Seeds the launch defaults into an empty collection.
package void apiMotdList(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    seedDefaultMotdTemplates(repo);
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
/// the builder generated from one recipe), then mirrors + writes the pool
/// once. One round-trip instead of N deletes + M creates.
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
/// POST /api/admin/motd/:id/pin — serve this template to everyone: the
/// engine picks it on every connect and the ircd pool holds only it until
/// unpin.
package void apiMotdPin(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    auto t = repo.getById(req.params["id"]);
    if (t.id.length == 0) { jsonError(res, 404, "not found"); return; }
    if (!t.enabled) { jsonError(res, 400, "enable the template before pinning it"); return; }
    setPinned(redis, t.id);
    logInfo("Admin %s pinned MOTD template '%s'", currentAdmin(req).username, t.name);
    jsonOk(res, listJson(redis, repo, writePool(redis, repo)));
}

/// POST /api/admin/motd/unpin — back to a random template per connect.
package void apiMotdUnpin(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    setPinned(redis, "");
    logInfo("Admin %s unpinned the MOTD template", currentAdmin(req).username);
    jsonOk(res, listJson(redis, repo, writePool(redis, repo)));
}

/// POST /api/admin/motd/rotate — rewrite the ircd pool from current state
/// (pinned → that one block, else every enabled template). The recovery
/// action when a write failed or the file was lost; 502 when it fails again.
package void apiMotdRotate(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new MotdTemplateRepository();
    auto err = writePool(redis, repo);
    if (err.length) { jsonError(res, 502, err); return; }
    jsonOk(res, listJson(redis, repo, ""));
}
