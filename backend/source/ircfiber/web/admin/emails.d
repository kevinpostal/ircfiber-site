/**
 * Admin Emails page API — signup-verification delivery.
 *
 * One overview route (provider/configuration state, the mail send log with
 * 24h counts, the live pending-signup queue, the per-email cooldowns and
 * per-IP signup counters) plus five actions: admin test send, per-pending
 * resend and revoke, and clearing either throttle.
 *
 * Pending rows are identified by `sha256(token)[0..16]`, never by the token
 * itself: POST /verify with a token creates that account and signs the
 * poster in, so a token must never leave the gateway twice. Action routes
 * re-SCAN `signup:pending:*` and match on the hash — the pending set is
 * bounded by the 10/hour/IP limit and a 24h TTL, and the overview already
 * scans it, so no index is added.
 */
module ircfiber.web.admin.emails;

import std.algorithm.sorting : sort;
import std.conv : to;
import std.digest : toHexString;
import std.digest.sha : sha256Of;
import std.process : environment;
import std.string : strip, toLower;
import std.uuid : randomUUID;
import std.datetime : Clock;
import core.time : MonoTime;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.mail : MailSettings, adminTestEmail, emailWellFormed,
    loadMailSettings, sendMail;
import ircfiber.mail_events : MailEvent, MailEventLog, mailTestLockKey, summarize;
import ircfiber.models.user : User;
import ircfiber.signup : PendingSignup, emailVerificationRequired, ipKey, pendingKey,
    sentKey, verificationEmail, verificationLink;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, readJsonBody;
import ircfiber.web.common : getClientIp;

private enum pendingPrefix = "signup:pending:";
private enum sentPrefix = "signup:sent:";
private enum ipPrefix = "signup:ip:";

/// Same default as registerPostVerified — a resent link must be identical
/// to the one already in the signer's inbox.
private string publicUrl() {
    return environment.get("IRCFIBER_PUBLIC_URL", "https://ircfiber.com");
}

/// Who is acting. `adminWrap` runs `requireAuth`, so `context["user"]` is
/// set; the session id is only a fallback.
private string adminActor(HTTPServerRequest req) {
    try {
        auto u = req.context["user"].get!User;
        if (u.username.length > 0) return u.username;
    } catch (Exception) {
    }
    try {
        if (req.session) return req.session.get("sessionUserId", "");
    } catch (Exception) {
    }
    return "?";
}

private string bodyString(Json j, string key) {
    try {
        auto v = j[key];
        if (v.type == Json.Type.string) return v.get!string.strip();
    } catch (Exception) {
    }
    return "";
}

/// Prefix-anchored key sweep, capped. `KEYS` (not `SCAN`, and not the
/// RedisStorage.scanKeys helper): a SCAN cursor reply is a nested
/// multi-bulk that desynchronises the pooled connection when read flat —
/// it returns garbage keys or blocks on the trailing read. Same reasoning
/// and the same `db.keys` idiom as storage/buffer.d clearNetworkBuffers
/// and account_deletion.d. The `signup:*` keyspaces are tiny (bounded by
/// the 10/hour/IP signup limit, a 60s cooldown and a 24h TTL).
private string[] keysMatching(RedisStorage redis, string pattern, size_t cap = 500) {
    string[] keys;
    try {
        foreach (k; redis.getDb().keys(pattern)) {
            keys ~= () @trusted { return cast(string) k.idup; }();
            if (keys.length >= cap) break;
        }
    } catch (Exception e) {
        logWarn("admin-emails: listing %s failed: %s", pattern, e.msg);
        throw e;
    }
    return keys;
}

/// Row identity for the pending queue: the token never leaves the gateway.
private string pendingRowId(string token) {
    return sha256Of(token).toHexString.idup.toLower[0 .. 16];
}

private struct PendingRow {
    string token;
    PendingSignup record;
    long ttlSeconds;
    bool found;
}

/// Re-SCANs and matches on `pendingRowId`. `found` is false when the token
/// expired, was used, or was revoked.
private PendingRow findPending(RedisStorage redis, string id) {
    PendingRow row;
    if (id.length == 0) return row;
    auto db = redis.getDb();
    foreach (key; keysMatching(redis, pendingPrefix ~ "*")) {
        if (key.length <= pendingPrefix.length) continue;
        const token = key[pendingPrefix.length .. $];
        if (pendingRowId(token) != id) continue;
        try {
            const raw = db.get(key);
            if (raw.length == 0) return row;
            row.record = PendingSignup.fromJson(parseJsonString(raw));
            row.token = token;
            row.ttlSeconds = db.ttl(key);
            row.found = true;
        } catch (Exception e) {
            logWarn("admin-emails: pending record %s is unreadable: %s", key, e.msg);
        }
        return row;
    }
    return row;
}

private Json providerJson(const MailSettings mail) {
    const raw = environment.get("IRCFIBER_EMAIL_VERIFICATION", "").strip().toLower();
    const fromEnv = raw == "0" || raw == "1" || raw == "true" || raw == "false";
    Json p = Json.emptyObject;
    p["provider"] = Json(mail.provider);
    p["configured"] = Json(mail.configured);
    p["tokenPresent"] = Json(mail.apiToken.length > 0);
    p["fromEmail"] = Json(mail.fromEmail);
    p["fromName"] = Json(mail.fromName);
    p["publicUrl"] = Json(publicUrl());
    p["verificationRequired"] = Json(emailVerificationRequired(mail));
    p["verificationSource"] = Json(fromEnv ? "env" : "auto");
    return p;
}

/// Records one attempt; never throws (see MailEventLog.record).
private void recordSend(RedisStorage redis, string kind, string toEmail, string username,
        const MailSettings mail, string sourceIp, MonoTime started, string error) {
    MailEvent ev;
    ev.atMs = Clock.currTime.toUnixTime() * 1000L;
    ev.kind = kind;
    ev.toEmail = toEmail;
    ev.username = username;
    ev.provider = mail.provider;
    ev.status = error.length == 0 ? "sent" : "failed";
    ev.error = error;
    ev.durationMs = (MonoTime.currTime - started).total!"msecs";
    ev.sourceIp = sourceIp;
    new MailEventLog(redis).record(ev);
}

/// GET /api/admin/emails
package void apiEmailsOverview(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto mail = loadMailSettings();
    Json data = Json.emptyObject;
    data["provider"] = providerJson(mail);

    string redisError;
    bool redisUp = true;
    try
        redis.getDb().request!string("PING");
    catch (Exception e) {
        redisUp = false;
        redisError = "Redis is unreachable (" ~ e.msg ~ ")";
        logWarn("admin-emails: redis ping failed: %s", e.msg);
    }

    MailEvent[] events;
    if (redisUp) events = new MailEventLog(redis).recent(100);
    Json eventsJson = Json.emptyArray;
    foreach (const ref e; events) eventsJson ~= e.toJson();
    data["events"] = eventsJson;
    data["stats"] = summarize(events, Clock.currTime.toUnixTime() * 1000L).toJson();

    struct PendingOut {
        string id, username, email;
        long createdAtMs, ttlSeconds;
    }

    PendingOut[] pending;
    struct ThrottleOut {
        string label;
        long count, ttlSeconds;
    }

    ThrottleOut[] cooldowns;
    ThrottleOut[] ipCounters;

    if (redisUp) {
        auto db = redis.getDb();
        try {
            foreach (key; keysMatching(redis, pendingPrefix ~ "*")) {
                if (key.length <= pendingPrefix.length) continue;
                try {
                    const raw = db.get(key);
                    if (raw.length == 0) continue;
                    auto p = PendingSignup.fromJson(parseJsonString(raw));
                    PendingOut o;
                    o.id = pendingRowId(key[pendingPrefix.length .. $]);
                    o.username = p.username;
                    o.email = p.email;
                    o.createdAtMs = p.createdAt * 1000L;   // the record stores unix seconds
                    o.ttlSeconds = db.ttl(key);
                    pending ~= o;
                } catch (Exception e) {
                    logWarn("admin-emails: skipping unreadable pending record %s: %s", key, e.msg);
                }
            }
            sort!((a, b) => a.createdAtMs > b.createdAtMs)(pending);
        } catch (Exception e) {
            logWarn("admin-emails: reading the pending queue failed: %s", e.msg);
            pending = null;
            if (redisError.length == 0) redisError = "The pending queue could not be read (" ~ e.msg ~ ")";
        }

        try {
            foreach (key; keysMatching(redis, sentPrefix ~ "*")) {
                if (key.length <= sentPrefix.length) continue;
                ThrottleOut o;
                o.label = key[sentPrefix.length .. $];
                o.ttlSeconds = db.ttl(key);
                cooldowns ~= o;
            }
            sort!((a, b) => a.ttlSeconds > b.ttlSeconds)(cooldowns);
        } catch (Exception e) {
            logWarn("admin-emails: reading email cooldowns failed: %s", e.msg);
            cooldowns = null;
            if (redisError.length == 0) redisError = "The email cooldowns could not be read (" ~ e.msg ~ ")";
        }

        try {
            foreach (key; keysMatching(redis, ipPrefix ~ "*")) {
                if (key.length <= ipPrefix.length) continue;
                ThrottleOut o;
                o.label = key[ipPrefix.length .. $];
                try o.count = db.get(key).to!long;
                catch (Exception) o.count = 0;
                o.ttlSeconds = db.ttl(key);
                ipCounters ~= o;
            }
            sort!((a, b) => a.count > b.count)(ipCounters);
        } catch (Exception e) {
            logWarn("admin-emails: reading per-IP signup counters failed: %s", e.msg);
            ipCounters = null;
            if (redisError.length == 0) redisError = "The per-IP counters could not be read (" ~ e.msg ~ ")";
        }
    }

    Json pendingJson = Json.emptyArray;
    foreach (const ref o; pending) {
        Json j = Json.emptyObject;
        j["id"] = Json(o.id);
        j["username"] = Json(o.username);
        j["email"] = Json(o.email);
        j["createdAt"] = Json(o.createdAtMs);
        j["ttlSeconds"] = Json(o.ttlSeconds);
        pendingJson ~= j;
    }
    data["pending"] = pendingJson;

    Json cooldownsJson = Json.emptyArray;
    foreach (const ref o; cooldowns) {
        Json j = Json.emptyObject;
        j["email"] = Json(o.label);
        j["ttlSeconds"] = Json(o.ttlSeconds);
        cooldownsJson ~= j;
    }
    data["cooldowns"] = cooldownsJson;

    Json ipJson = Json.emptyArray;
    foreach (const ref o; ipCounters) {
        Json j = Json.emptyObject;
        j["ip"] = Json(o.label);
        j["count"] = Json(o.count);
        j["ttlSeconds"] = Json(o.ttlSeconds);
        ipJson ~= j;
    }
    data["ipCounters"] = ipJson;
    data["redisError"] = Json(redisError);
    jsonOk(res, data);
}

/// POST /api/admin/emails/test — body {"email":"..."}. Really sends: the
/// provider's own rejection text is the whole point.
package void apiEmailsTest(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const email = bodyString(readJsonBody(req), "email");
    if (email.length == 0) {
        jsonError(res, 400, "An email address is required.");
        return;
    }
    if (!emailWellFormed(email)) {
        jsonError(res, 400, "That doesn't look like a valid email address.");
        return;
    }

    // One per minute globally. The read-back must compare a value only this
    // request could have written: SET NX with a constant marker looks
    // identical whether we won or lost the race.
    const marker = randomUUID().toString();
    try {
        auto db = redis.getDb();
        db.request!string("SET", mailTestLockKey(), marker, "NX", "EX", "60");
        if (db.get(mailTestLockKey()) != marker) {
            jsonError(res, 429, "Please wait a minute between test sends.");
            return;
        }
    } catch (Exception e) {
        logWarn("admin-emails: test-send throttle failed: %s", e.msg);   // fail open
    }

    auto mail = loadMailSettings();
    if (!mail.configured) {
        jsonError(res, 503, "No mail provider is configured.");
        return;
    }

    const ip = getClientIp(req);
    const started = MonoTime.currTime;
    try
        sendMail(mail, adminTestEmail(email));
    catch (Exception e) {
        recordSend(redis, "admin_test", email, "", mail, ip, started, e.msg);
        logWarn("admin-emails: %s test send to %s failed: %s", adminActor(req), email, e.msg);
        jsonError(res, 502, e.msg);
        return;
    }
    recordSend(redis, "admin_test", email, "", mail, ip, started, "");
    logInfo("admin-emails: %s sent a test email to %s via %s", adminActor(req), email, mail.provider);
    Json data = Json.emptyObject;
    data["sent"] = Json(true);
    data["email"] = Json(email);
    data["provider"] = Json(mail.provider);
    jsonOk(res, data);
}

/// POST /api/admin/emails/pending/:id/resend — same token, so a link the
/// signer already has keeps working. Deliberately ignores the signer-facing
/// 60s cooldown and leaves the TTL alone.
package void apiEmailsPendingResend(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const id = req.params.get("id", "");
    auto row = findPending(redis, id);
    if (!row.found) {
        jsonError(res, 404, "That pending signup is no longer waiting (expired, used, or revoked).");
        return;
    }
    auto mail = loadMailSettings();
    if (!mail.configured) {
        jsonError(res, 503, "No mail provider is configured.");
        return;
    }
    const link = verificationLink(publicUrl(), row.token);
    const ip = getClientIp(req);
    const started = MonoTime.currTime;
    try
        sendMail(mail, verificationEmail(row.record.username, row.record.email, link));
    catch (Exception e) {
        // Unlike signup's first send, an earlier link may already be in the
        // signer's inbox: keep the pending key.
        recordSend(redis, "signup_verification", row.record.email, row.record.username,
            mail, ip, started, e.msg);
        logWarn("admin-emails: %s resend to %s failed: %s", adminActor(req), row.record.email, e.msg);
        jsonError(res, 502, e.msg);
        return;
    }
    recordSend(redis, "signup_verification", row.record.email, row.record.username,
        mail, ip, started, "");
    logInfo("admin-emails: %s resent the confirmation link for %s (%s)",
        adminActor(req), row.record.username, row.record.email);
    Json data = Json.emptyObject;
    data["sent"] = Json(true);
    data["email"] = Json(row.record.email);
    data["username"] = Json(row.record.username);
    jsonOk(res, data);
}

/// POST /api/admin/emails/pending/:id/revoke — drops the pending record and
/// the per-email cooldown so the signer can start over immediately.
package void apiEmailsPendingRevoke(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const id = req.params.get("id", "");
    auto row = findPending(redis, id);
    if (!row.found) {
        jsonError(res, 404, "That pending signup is no longer waiting (expired, used, or revoked).");
        return;
    }
    try {
        auto db = redis.getDb();
        db.del(pendingKey(row.token));
        db.del(sentKey(row.record.email.toLower()));
    } catch (Exception e) {
        logWarn("admin-emails: revoking the pending signup for %s failed: %s", row.record.email, e.msg);
        jsonError(res, 503, "Could not revoke that pending signup. Try again shortly.");
        return;
    }
    logInfo("admin-emails: %s revoked the pending signup for %s (%s)",
        adminActor(req), row.record.username, row.record.email);
    Json data = Json.emptyObject;
    data["revoked"] = Json(true);
    data["email"] = Json(row.record.email);
    jsonOk(res, data);
}

/// POST /api/admin/emails/cooldown/clear — body {"email":"..."}.
package void apiEmailsCooldownClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const email = bodyString(readJsonBody(req), "email");
    if (email.length == 0) {
        jsonError(res, 400, "An email address is required.");
        return;
    }
    try
        redis.getDb().del(sentKey(email.toLower()));
    catch (Exception e) {
        logWarn("admin-emails: clearing the cooldown for %s failed: %s", email, e.msg);
        jsonError(res, 503, "Could not clear that cooldown. Try again shortly.");
        return;
    }
    logInfo("admin-emails: %s cleared the resend cooldown for %s", adminActor(req), email);
    Json data = Json.emptyObject;
    data["cleared"] = Json(true);
    data["email"] = Json(email);
    jsonOk(res, data);
}

/// POST /api/admin/emails/ip-limit/clear — body {"ip":"..."}.
package void apiEmailsIpLimitClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const ip = bodyString(readJsonBody(req), "ip");
    if (ip.length == 0) {
        jsonError(res, 400, "An IP address is required.");
        return;
    }
    try
        redis.getDb().del(ipKey(ip));
    catch (Exception e) {
        logWarn("admin-emails: clearing the signup limit for %s failed: %s", ip, e.msg);
        jsonError(res, 503, "Could not clear that signup limit. Try again shortly.");
        return;
    }
    logInfo("admin-emails: %s cleared the hourly signup limit for %s", adminActor(req), ip);
    Json data = Json.emptyObject;
    data["cleared"] = Json(true);
    data["ip"] = Json(ip);
    jsonOk(res, data);
}
