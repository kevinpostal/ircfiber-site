/**
 * Admin Emails page API — signup-verification delivery.
 *
 * One overview route (provider/configuration state, the mail send log with
 * 24h counts, the live pending-signup queue, the per-email cooldowns,
 * per-IP signup counters and the campaign template table) plus seven
 * actions: admin test send, per-pending resend and revoke, clearing either
 * throttle, and the bulk-campaign audience preview + send-now fan-out.
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

import ircfiber.mail : MailMessage, MailSettings, adminTestEmail, emailWellFormed,
    loadMailSettings, sendMail;
import ircfiber.mail_events : MailEvent, MailEventLog, mailCampaignLockKey, mailEventsCap, mailEventsWindow,
    mailTestLockKey, summarize;
import ircfiber.db.user : UserRepository;
import ircfiber.logs.events : LogEvent, pushLogEvent;
import ircfiber.models.user : User;
import ircfiber.signup : PendingSignup, campaignUnsubKey, campaignUnsubTtlSeconds, emailVerificationRequired,
    ipKey, newSignupToken, pendingKey, sentKey, unsubscribeLink, verificationEmail, verificationLink;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonError, jsonOk, queryString, readJsonBody;
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

/// GET /api/admin/emails?page&limit
///
/// `page` (0-based) and `limit` window the **send log only** — same
/// contract as the support list. Everything else in the payload is a full
/// snapshot, so the KPI counts stay stable while an operator pages.
///
/// The log itself is read whole (it is capped at `mailEventsCap`): the 24h
/// counts have to see every retained event, not just the page on screen.
package void apiEmailsOverview(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    int page = 0;
    int limit = 50;
    if (auto p = "page" in req.query) { try page = (*p).to!int; catch (Exception) {} }
    if (auto l = "limit" in req.query) { try limit = (*l).to!int; catch (Exception) {} }
    if (page < 0) page = 0;
    if (limit < 1) limit = 1;
    if (limit > mailEventsCap) limit = mailEventsCap;

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
    if (redisUp) events = new MailEventLog(redis).recent(mailEventsCap);
    const window = mailEventsWindow(events.length, page, limit);
    Json eventsJson = Json.emptyArray;
    foreach (const ref e; events[window.start .. window.end]) eventsJson ~= e.toJson();
    data["events"] = eventsJson;
    data["eventsTotal"] = Json(cast(long) events.length);
    data["eventsPage"] = Json(cast(long) window.page);
    data["eventsPageCount"] = Json(cast(long) window.pageCount);
    data["eventsLimit"] = Json(cast(long) limit);
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
    data["templates"] = campaignTemplatesJson();
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

// ────────────────────────────────────────────────────────────
// Bulk campaigns (Compose tab): filtered-segment send-now fan-out
// ────────────────────────────────────────────────────────────

/// Max recipients per send-now run. Matches the existing in-request bulk
/// precedent (`apiUsersBulkDelete` caps at 100 ids); 200 keeps the worst
/// case at ~200 sequential blocking POSTs ≈ under 2 minutes and the send
/// log's 500-cap intact. Audiences of 200–500 go out as repeated sends
/// with narrowed filters; true bulk over background jobs is follow-up work.
enum CAMPAIGN_MAX_RECIPIENTS = 200;

/// Backend-owned template table (the compose picker source). Placeholders
/// are exactly `{{username}}`, `{{email}}`, `{{unsubscribe_url}}`.
struct CampaignTemplate {
    string id;
    string subject;
    string text;
}

immutable CampaignTemplate[] campaignTemplates = [
    CampaignTemplate("support-reply",
        "Re: your support request",
        "Hi {{username}},\n"
        ~ "\n"
        ~ "Thanks for writing to IRC Fiber support. Reply to this message and an operator will pick it up.\n"
        ~ "\n"
        ~ "— IRC Fiber support"),
    CampaignTemplate("announcement",
        "News from IRC Fiber",
        "Hi {{username}},\n"
        ~ "\n"
        ~ "There is something new on IRC Fiber worth knowing about. Details follow in the next message.\n"
        ~ "\n"
        ~ "— The IRC Fiber team\n"
        ~ "\n"
        ~ "Unsubscribe: {{unsubscribe_url}}"),
    CampaignTemplate("account-notice",
        "A note about your IRC Fiber account",
        "Hi {{username}} ({{email}}),\n"
        ~ "\n"
        ~ "Something about your IRC Fiber account needs your attention. Sign in to review it.\n"
        ~ "\n"
        ~ "— The IRC Fiber team"),
];

private Json campaignTemplatesJson() @safe {
    Json arr = Json.emptyArray;
    foreach (const ref t; campaignTemplates) {
        Json j = Json.emptyObject;
        j["id"] = Json(t.id);
        j["subject"] = Json(t.subject);
        j["text"] = Json(t.text);
        arr ~= j;
    }
    return arr;
}

/// Replaces exactly `{{username}}`, `{{email}}`, `{{unsubscribe_url}}` —
/// no other keys, no recursion (a value containing `{{…}}` is emitted as-is;
/// single-pass scan, never re-scanned), empty username reads as `""`,
/// unknown `{{other}}` keys pass through untouched.
string substituteCampaign(string src, string username, string email, string unsubUrl) @safe pure {
    string out_;
    size_t i = 0;
    while (i < src.length) {
        if (i + 1 < src.length && src[i] == '{' && src[i + 1] == '{') {
            size_t j = i + 2;
            while (j + 1 < src.length && !(src[j] == '}' && src[j + 1] == '}')) j++;
            if (j + 1 >= src.length) { out_ ~= src[i .. $]; break; }
            auto key = src[i .. j + 2];
            if (key == "{{username}}") out_ ~= username;
            else if (key == "{{email}}") out_ ~= email;
            else if (key == "{{unsubscribe_url}}") out_ ~= unsubUrl;
            else out_ ~= key;
            i = j + 2;
        } else {
            out_ ~= src[i];
            i++;
        }
    }
    return out_;
}

/// Plain-text campaign body → html: escaped paragraphs (`\n\n` → `<p>`,
/// single `\n` → `<br>`), same pattern as `verificationEmail`.
private string campaignHtmlBody(string text) @safe {
    import std.array : join, split;
    import vibe.textfilter.html : htmlEscape;
    string[] paras;
    foreach (p; text.split("\n\n")) {
        string[] lines;
        foreach (l; p.split("\n"))
            lines ~= htmlEscape(l).idup;
        paras ~= "<p>" ~ lines.join("<br>") ~ "</p>";
    }
    return paras.join("");
}

private long queryMs(HTTPServerRequest req, string key) {
    try {
        const raw = queryString(req, key);
        if (raw.length == 0) return 0;
        return raw.to!long;
    } catch (Exception) {
        return 0;
    }
}

private long bodyLong(Json j, string key) {
    try {
        auto v = j[key];
        if (v.type == Json.Type.int_) return v.get!long;
        if (v.type == Json.Type.float_) return cast(long) v.get!double;
    } catch (Exception) {
    }
    return 0;
}

private bool bodyBool(Json j, string key) {
    try {
        auto v = j[key];
        if (v.type == Json.Type.bool_) return v.get!bool;
    } catch (Exception) {
    }
    return false;
}

/// GET /api/admin/emails/campaign/audience?role&createdAfter&createdBefore&q&limit=10
/// → `{total, sample: [{username, email, createdAt}]}`. Read-only, no throttle.
package void apiCampaignAudience(HTTPServerRequest req, HTTPServerResponse res) {
    const role = queryString(req, "role");
    const afterMs = queryMs(req, "createdAfter");
    const beforeMs = queryMs(req, "createdBefore");
    const q = queryString(req, "q");
    int limit = 10;
    try {
        const raw = queryString(req, "limit");
        if (raw.length > 0) limit = raw.to!int;
    } catch (Exception) {
    }
    if (limit < 1) limit = 1;
    if (limit > 20) limit = 20;

    long total = 0;
    User[] sample;
    try {
        auto repo = new UserRepository();
        total = repo.countCampaignAudience(role, afterMs, beforeMs, q);
        sample = repo.fetchCampaignAudience(role, afterMs, beforeMs, q, limit);
    } catch (Exception e) {
        logWarn("admin-emails: campaign audience read failed: %s", e.msg);
        jsonError(res, 503, "Could not read the audience. Try again shortly.");
        return;
    }
    Json rows = Json.emptyArray;
    foreach (const ref u; sample) {
        Json r = Json.emptyObject;
        r["username"] = Json(u.username);
        r["email"] = Json(u.email);
        r["createdAt"] = Json(u.createdAt.toUnixTime() * 1000L);
        rows ~= r;
    }
    Json data = Json.emptyObject;
    data["total"] = Json(total);
    data["sample"] = rows;
    jsonOk(res, data);
}

/// POST /api/admin/emails/campaign/send — body
/// `{role?, createdAfterMs?, createdBeforeMs?, q?, all?, subject, text}`.
/// Fans out server-side (one POST, never a client-side loop): per recipient
/// the subject/text are substituted, a single-use unsubscribe token is
/// minted, and `sendMail` runs in a per-recipient try/catch that never
/// breaks the loop.
package void apiCampaignSend(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    const role = bodyString(body_, "role");
    const afterMs = bodyLong(body_, "createdAfterMs");
    const beforeMs = bodyLong(body_, "createdBeforeMs");
    const q = bodyString(body_, "q");
    const all = bodyBool(body_, "all");
    const subject = bodyString(body_, "subject");
    const text = bodyString(body_, "text");

    if (subject.length == 0 || subject.length > 200) {
        jsonError(res, 400, "Subject must be 1–200 characters.");
        return;
    }
    if (text.length == 0 || text.length > 20000) {
        jsonError(res, 400, "Body must be 1–20000 characters.");
        return;
    }
    const narrowed = role.length > 0 || afterMs > 0 || beforeMs > 0 || q.length > 0;
    if (!narrowed && !all) {
        jsonError(res, 400, "Narrow the audience or confirm sending to everyone.");
        return;
    }

    // One send at a time globally: same SET NX EX + read-back-compare shape
    // as apiEmailsTest. Redis failure fails open (logWarn, continue).
    const marker = randomUUID().toString();
    try {
        auto db = redis.getDb();
        db.request!string("SET", mailCampaignLockKey(), marker, "NX", "EX", "60");
        if (db.get(mailCampaignLockKey()) != marker) {
            jsonError(res, 429, "A campaign send is already running. Please wait a minute.");
            return;
        }
    } catch (Exception e) {
        logWarn("admin-emails: campaign-send throttle failed: %s", e.msg);
    }

    auto mail = loadMailSettings();
    if (!mail.configured) {
        jsonError(res, 503, "No mail provider is configured.");
        return;
    }

    User[] audience;
    long total = 0, grandTotal = 0;
    try {
        auto repo = new UserRepository();
        total = repo.countCampaignAudience(role, afterMs, beforeMs, q);
        grandTotal = repo.countCampaignAudienceTotal(role, afterMs, beforeMs, q);
        if (total > CAMPAIGN_MAX_RECIPIENTS) {
            jsonError(res, 400, "That audience has " ~ total.to!string
                ~ " addresses; narrow the filters (max "
                ~ CAMPAIGN_MAX_RECIPIENTS.to!string ~ " per send).");
            return;
        }
        audience = repo.fetchCampaignAudience(role, afterMs, beforeMs, q, CAMPAIGN_MAX_RECIPIENTS);
    } catch (Exception e) {
        logWarn("admin-emails: campaign audience read failed: %s", e.msg);
        jsonError(res, 503, "Could not read the audience. Try again shortly.");
        return;
    }

    const ip = getClientIp(req);
    const actor = adminActor(req);
    const startedAll = MonoTime.currTime;
    auto eventLog = new MailEventLog(redis);
    long sent = 0, failed = 0;
    Json errorsJson = Json.emptyArray;
    void failOne(string email, string username, string msg) {
        failed++;
        errorsJson ~= Json(["email": Json(email), "error": Json(msg)]);
        MailEvent ev;
        ev.atMs = Clock.currTime.toUnixTime() * 1000L;
        ev.kind = "campaign";
        ev.toEmail = email;
        ev.username = username;
        ev.provider = mail.provider;
        ev.status = "failed";
        ev.error = msg;
        ev.sourceIp = ip;
        eventLog.recordQuiet(ev);
    }
    foreach (ref u; audience) {
        const started = MonoTime.currTime;
        if (!emailWellFormed(u.email)) {
            failOne(u.email, u.username, "That doesn't look like a valid email address.");
            continue;
        }
        // Single-use token minted only for addresses actually mailed in
        // this run. A Redis failure here fails THIS recipient (never send
        // a campaign mail whose unsubscribe link is dead).
        const token = newSignupToken();
        const unsubUrl = unsubscribeLink(publicUrl(), token);
        try
            redis.getDb().setEX(campaignUnsubKey(token), campaignUnsubTtlSeconds, u.email.toLower());
        catch (Exception e) {
            logWarn("admin-emails: campaign token store failed for %s: %s", u.email, e.msg);
            failOne(u.email, u.username, "Could not store the unsubscribe token. Try again shortly.");
            continue;
        }
        // No sleep: sequential blocking POSTs already pace this loop at a
        // few sends per second, under Resend's 10 req/s team limit.
        const subj = substituteCampaign(subject, u.username, u.email, unsubUrl);
        const txt = substituteCampaign(text, u.username, u.email, unsubUrl);
        MailMessage m;
        m.toEmail = u.email;
        m.subject = subj;
        m.text = txt;
        m.html = campaignHtmlBody(txt);
        m.listUnsubscribeUrl = unsubUrl;
        try {
            sendMail(mail, m);
            sent++;
            MailEvent ev;
            ev.atMs = Clock.currTime.toUnixTime() * 1000L;
            ev.kind = "campaign";
            ev.toEmail = u.email;
            ev.username = u.username;
            ev.provider = mail.provider;
            ev.status = "sent";
            ev.durationMs = (MonoTime.currTime - started).total!"msecs";
            ev.sourceIp = ip;
            eventLog.recordQuiet(ev);
        } catch (Exception e) {
            MailEvent ev;
            ev.atMs = Clock.currTime.toUnixTime() * 1000L;
            ev.kind = "campaign";
            ev.toEmail = u.email;
            ev.username = u.username;
            ev.provider = mail.provider;
            ev.status = "failed";
            ev.error = e.msg;
            ev.durationMs = (MonoTime.currTime - started).total!"msecs";
            ev.sourceIp = ip;
            eventLog.recordQuiet(ev);
            failed++;
            errorsJson ~= Json(["email": Json(u.email), "error": Json(e.msg)]);
        }
    }

    long skipped = grandTotal - total;
    if (skipped < 0) skipped = 0;
    const summary = "sent " ~ sent.to!string ~ " failed " ~ failed.to!string
        ~ " skipped " ~ skipped.to!string;
    LogEvent le;
    le.type = "mail";
    le.ts = Clock.currTime.toUnixTime() * 1000L;
    le.kind = "campaign_summary";
    le.username = actor;
    le.provider = mail.provider;
    le.status = failed == 0 ? "sent" : "failed";
    le.error = summary;
    le.durationMs = (MonoTime.currTime - startedAll).total!"msecs";
    le.ip = ip;
    pushLogEvent(redis, le);
    logInfo("admin-emails: %s ran a campaign: %s", actor, summary);

    Json data = Json.emptyObject;
    data["sent"] = Json(sent);
    data["failed"] = Json(failed);
    data["skippedUnsubscribed"] = Json(skipped);
    data["total"] = Json(total);
    data["errors"] = errorsJson;
    jsonOk(res, data);
}
