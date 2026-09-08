/**
 * Backup run announcements: gateway → #staff bot transport.
 *
 * The k3s backup CronJobs publish one run record per run (mongo job →
 * Mongo `backup_runs`, redis job → Redis list `irc:backup:runs`), consumed
 * by the admin Backups page. This module polls the same two sources every
 * 60 s and pushes one `backup` LogEvent per completed run onto the logs
 * outbox (`ircfiber.logs.events`), so FiberEye announces it in #staff.
 *
 * Single-instance gate: the loop only starts where
 * `IRCFIBER_FIBEREYE_ENABLED` is set (prod: the `ircfiber-fibereye`
 * container; local dev: the single gateway), so blue/green replicas never
 * double-announce. Announced run ids live in a Redis SET
 * (`backupAnnounceKey()`); a DB hiccup is logged and retried next poll,
 * never fatal to the gateway.
 *
 * `backupAnnounceKey`, `backupDedupId` and `buildBackupEvent` are @safe
 * with no Redis/Mongo/clock dependencies so they link into the
 * `logs-format-test` config. (They are not `pure`: vibe.data.json's
 * accessors are @trusted but not pure, so a pure attribute would not
 * compile — the IO-free property is what matters.)
 */
module ircfiber.logs.backup_announce;

import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import core.time : seconds;

import vibe.core.core : runTask, sleep;
import vibe.core.log : logInfo, logWarn;
import vibe.data.bson : Bson;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisReply;

import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.logs.events : LogEvent, pushLogEvent;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.backups : normalizeRun;

/// Redis SET of already-announced dedup ids.
string backupAnnounceKey() @safe pure nothrow { return "irc:logs:backup:announced"; }

/// Poll interval between backup source scans.
enum BACKUP_ANNOUNCE_INTERVAL_SECS = 60;
/// Runs older than this are never announced (catch-up guard after an outage).
enum BACKUP_ANNOUNCE_MAX_AGE_MS = 48 * 3600_000L;
/// Announced ids are kept 3 days — well past the max-age window.
enum BACKUP_ANNOUNCE_DEDUP_TTL_SECS = 259_200;

private string fieldStr(const Json run, string key) @safe nothrow {
    try {
        auto v = run[key];
        if (v.type == Json.Type.string) return v.get!string;
    } catch (Exception) {}
    return "";
}

private long fieldLong(const Json run, string key) @safe nothrow {
    try {
        auto v = run[key];
        if (v.type == Json.Type.int_) return v.get!long;
        if (v.type == Json.Type.float_) return cast(long) v.get!double;
    } catch (Exception) {}
    return 0;
}

/// Stable id for a `normalizeRun`-shaped run: `kind:startedAt:file`.
string backupDedupId(Json run) @safe {
    return fieldStr(run, "kind") ~ ":" ~ fieldLong(run, "startedAt").to!string
        ~ ":" ~ fieldStr(run, "file");
}

/// Maps a `normalizeRun`-shaped run to its outbox event. Normalization
/// happens at the poll site, not here.
LogEvent buildBackupEvent(Json run) @safe {
    LogEvent ev;
    ev.type = "backup";
    const startedAt = fieldLong(run, "startedAt");
    const finishedAt = fieldLong(run, "finishedAt");
    ev.ts = finishedAt > 0 ? finishedAt : startedAt;
    ev.kind = fieldStr(run, "kind");
    ev.status = fieldStr(run, "status");
    ev.stage = fieldStr(run, "stage");
    ev.file = fieldStr(run, "file");
    ev.fileBytes = fieldLong(run, "bytes");
    ev.durationMs = fieldLong(run, "durationMs");
    const msg = fieldStr(run, "message");
    ev.error = msg;
    ev.text = msg;
    return ev;
}

/// Starts the announce fiber when `IRCFIBER_FIBEREYE_ENABLED` is set;
/// no-op otherwise.
void startBackupAnnounceLoop() {
    if (!isEnvEnabled("IRCFIBER_FIBEREYE_ENABLED")) {
        logInfo("Backup announce disabled (IRCFIBER_FIBEREYE_ENABLED unset)");
        return;
    }
    runTask(&backupAnnounceLoop);
    logInfo("Backup announce loop starting (%ds poll of backup_runs + irc:backup:runs)",
        BACKUP_ANNOUNCE_INTERVAL_SECS);
}

private void backupAnnounceLoop() nothrow {
    RedisStorage redis;
    while (true) {
        try pollBackupsOnce(redis);
        catch (Exception e) {
            try logWarn("backup announce: poll failed: %s", e.msg);
            catch (Exception) {}
        }
        try sleep(BACKUP_ANNOUNCE_INTERVAL_SECS.seconds);
        catch (Exception) {}
    }
}

private void pollBackupsOnce(ref RedisStorage redis) {
    if (redis is null) {
        try {
            auto r = new RedisStorage();
            r.connectFromUrl(environment.get("IRCFIBER_REDIS_URL", "redis://127.0.0.1:6379"));
            redis = r;
        } catch (Exception e) {
            logWarn("backup announce: redis unavailable, mongo-only this poll: %s", e.msg);
        }
    }
    const now = Clock.currTime.toUnixTime!long * 1000;
    Json[] runs;
    // Mongo source — independent of redis: a redis hiccup still announces
    // mongo runs.
    try {
        Bson sort = Bson.emptyObject;
        sort["startedAt"] = Bson(cast(long) -1);
        foreach (d; AppMongoConnection.safeFind("backup_runs",
                Bson.emptyObject, Bson.emptyObject, sort, 10, 2000)) {
            try {
                auto rec = normalizeRun(d.toJson());
                if (rec.type != Json.Type.undefined) runs ~= rec;
            } catch (Exception e) {
                logWarn("backup announce: skipping unparsable mongo run: %s", e.msg);
            }
        }
    } catch (Exception e) {
        logWarn("backup announce: mongo poll failed, redis-only this poll: %s", e.msg);
    }
    // Redis source — independent of mongo.
    if (redis !is null) {
        try {
            auto reply = redis.getDb().request!(RedisReply!string)(
                "LRANGE", RedisKeys.backupRuns(), "0", "9");
            foreach (raw; reply) {
                try {
                    auto rec = normalizeRun(parseJsonString(raw));
                    if (rec.type != Json.Type.undefined) runs ~= rec;
                } catch (Exception e) {
                    logWarn("backup announce: skipping unparsable redis run: %s", e.msg);
                }
            }
        } catch (Exception e) {
            logWarn("backup announce: redis poll failed: %s", e.msg);
            redis = null; // reconnect next poll
        }
    }
    if (redis is null) return;
    foreach (run; runs) {
        try announceRun(redis, run, now);
        catch (Exception e) { logWarn("backup announce: run skipped: %s", e.msg); }
    }
}

private void announceRun(RedisStorage redis, Json run, long now) {
    // Malformed publish: the Backups page skips kind-less records, and
    // normalizeRun defaults a missing status to "unknown".
    if (fieldStr(run, "status") == "unknown" && fieldStr(run, "stage").length == 0) return;
    // Catch-up guard: never announce runs older than 48 h.
    if (now - fieldLong(run, "startedAt") > BACKUP_ANNOUNCE_MAX_AGE_MS) return;
    const id = backupDedupId(run);
    auto db = redis.getDb();
    if (db.request!long("SISMEMBER", backupAnnounceKey(), id) != 0) return;
    pushLogEvent(redis, buildBackupEvent(run));
    db.sadd(backupAnnounceKey(), id);
    db.expire(backupAnnounceKey(), BACKUP_ANNOUNCE_DEDUP_TTL_SECS);
}
