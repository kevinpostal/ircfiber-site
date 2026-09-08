/**
 * Durable-ish log of transactional mail sends, for the admin Emails page.
 *
 * Nothing else records a send: `ircfiber.mail` only logs a line, so a
 * provider rejection (bad DMARC, unverified sender domain) is invisible to
 * an operator once the request is gone. Every send site (signup
 * verification, admin test send, admin resend) writes one MailEvent here.
 *
 * Storage is a capped Redis list (`irc:mail:events`, newest first, 500
 * entries, 30-day TTL): no Mongo collection is introduced. The keys live
 * here rather than in ircfiber.redis.protocol because `common/` exists as
 * three byte-identical vendored copies and nothing outside the gateway
 * reads them.
 *
 * `summarize` is pure and unit-tested in tests/signup_test.d; the Redis
 * parts need a live server and are covered by the live verification flow.
 */
module ircfiber.mail_events;

import std.conv : to;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.db.redis.redis : RedisDatabase, RedisReply;

import ircfiber.storage.redis : RedisStorage;
import ircfiber.logs.events : LogEvent, pushLogEvent;

/// LTRIM window: how many send attempts stay readable.
enum mailEventsCap = 500;
enum mailEventTtlSeconds = 30 * 24 * 3600;

string mailEventsKey() @safe pure {
    return "irc:mail:events";
}

string mailTestLockKey() @safe pure {
    return "irc:mail:test:lock";
}

private string jsonStr(Json j, string key) @safe {
    try {
        auto v = j[key];
        if (v.type == Json.Type.string) return v.get!string;
        return "";
    } catch (Exception) {
        return "";
    }
}

private long jsonLong(Json j, string key) @safe {
    try {
        auto v = j[key];
        if (v.type == Json.Type.int_) return v.get!long;
        if (v.type == Json.Type.float_) return cast(long) v.get!double;
        return 0;
    } catch (Exception) {
        return 0;
    }
}

/// One send attempt. `error` is the provider's own message on failure (the
/// API token never reaches it — ircfiber.mail keeps it out of exceptions).
struct MailEvent {
    long atMs;          /// unix ms
    string kind;        /// "signup_verification" | "admin_test"
    string toEmail;
    string username;    /// "" for admin_test
    string provider;    /// MailSettings.provider at send time
    string status;      /// "sent" | "failed"
    string error;
    long durationMs;
    string sourceIp;    /// signup client IP, or admin client IP for admin_test

    /// All nine keys, always present.
    Json toJson() const @safe {
        Json j = Json.emptyObject;
        j["atMs"] = Json(atMs);
        j["kind"] = Json(kind);
        j["toEmail"] = Json(toEmail);
        j["username"] = Json(username);
        j["provider"] = Json(provider);
        j["status"] = Json(status);
        j["error"] = Json(error);
        j["durationMs"] = Json(durationMs);
        j["sourceIp"] = Json(sourceIp);
        return j;
    }

    /// Tolerant: a missing or wrongly typed key reads as "" / 0 rather
    /// than throwing, so one bad entry cannot break the page.
    static MailEvent fromJson(Json j) @safe {
        MailEvent e;
        e.atMs = jsonLong(j, "atMs");
        e.kind = jsonStr(j, "kind");
        e.toEmail = jsonStr(j, "toEmail");
        e.username = jsonStr(j, "username");
        e.provider = jsonStr(j, "provider");
        e.status = jsonStr(j, "status");
        e.error = jsonStr(j, "error");
        e.durationMs = jsonLong(j, "durationMs");
        e.sourceIp = jsonStr(j, "sourceIp");
        return e;
    }
}

/// Counts over whatever window the caller read, plus the 24h slice.
struct MailStats {
    long sent24h;
    long failed24h;
    long sentWindow;
    long failedWindow;
    long windowSize;
    long lastSentAtMs;
    long lastFailedAtMs;
    string lastError;   /// error of the newest failed event in the window

    Json toJson() const @safe {
        Json j = Json.emptyObject;
        j["sent24h"] = Json(sent24h);
        j["failed24h"] = Json(failed24h);
        j["sentWindow"] = Json(sentWindow);
        j["failedWindow"] = Json(failedWindow);
        j["windowSize"] = Json(windowSize);
        j["lastSentAt"] = Json(lastSentAtMs);
        j["lastFailedAt"] = Json(lastFailedAtMs);
        j["lastError"] = Json(lastError);
        return j;
    }
}

/// Pure. `nowMs` is the clock; the window is whatever the caller read.
MailStats summarize(const MailEvent[] events, long nowMs) @safe {
    MailStats s;
    s.windowSize = cast(long) events.length;
    const cutoff = nowMs - 86_400_000L;
    bool sawFailure = false, sawSent = false;
    foreach (const ref e; events) {
        if (e.status == "failed") {
            s.failedWindow++;
            if (e.atMs >= cutoff) s.failed24h++;
            // Events arrive newest-first, so a tie keeps the earlier row.
            if (!sawFailure || e.atMs > s.lastFailedAtMs) {
                s.lastFailedAtMs = e.atMs;
                s.lastError = e.error;
                sawFailure = true;
            }
        } else if (e.status == "sent") {
            s.sentWindow++;
            if (e.atMs >= cutoff) s.sent24h++;
            if (!sawSent || e.atMs > s.lastSentAtMs) {
                s.lastSentAtMs = e.atMs;
                sawSent = true;
            }
        }
    }
    return s;
}

/// Half-open slice `[start, end)` of a newest-first log for a 0-based
/// `page` of `limit` rows, plus the page actually served.
///
/// Pure. A page past the end clamps to the last one instead of answering
/// with an empty slice: the log is a capped list that gets trimmed under a
/// reader's feet, and a reader sitting on page 9 when the log shrinks to
/// four pages must see rows, not what looks like data loss.
struct MailEventWindow {
    size_t start;
    size_t end;
    int page;        /// the page actually served, after clamping
    int pageCount;   /// 0 when the log is empty
}

MailEventWindow mailEventsWindow(size_t total, int page, int limit) @safe pure nothrow @nogc {
    MailEventWindow w;
    if (limit < 1) limit = 1;
    if (total == 0) return w;
    w.pageCount = cast(int)((total + limit - 1) / limit);
    w.page = page < 0 ? 0 : (page >= w.pageCount ? w.pageCount - 1 : page);
    w.start = cast(size_t) w.page * cast(size_t) limit;
    w.end = w.start + cast(size_t) limit;
    if (w.end > total) w.end = total;
    return w;
}

/// Capped Redis list, newest first.
final class MailEventLog {
    private RedisStorage redis;

    this(RedisStorage redis) {
        this.redis = redis;
    }

    private RedisDatabase db() @trusted {
        return redis.getDb();
    }

    /// LPUSH + LTRIM + EXPIRE, then announce in #staff. Never throws: an
    /// unrecordable event must not fail the send it describes.
    void record(MailEvent e) {
        try {
            auto d = db();
            d.request!string("LPUSH", mailEventsKey(), e.toJson().toString());
            d.request!string("LTRIM", mailEventsKey(), "0", (mailEventsCap - 1).to!string);
            d.expire(mailEventsKey(), mailEventTtlSeconds);
        } catch (Exception ex) {
            logWarn("mail-events: recording %s send to %s failed: %s", e.status, e.toEmail, ex.msg);
        }
        // This is the choke point every sendMail caller already passes
        // through on success and on failure, so the #staff feed is fed
        // here rather than at the three send sites.
        LogEvent le;
        le.type = "mail";
        le.ts = e.atMs;
        le.kind = e.kind;
        le.email = e.toEmail;
        le.username = e.username;
        le.provider = e.provider;
        le.status = e.status;
        le.error = e.error;
        le.durationMs = e.durationMs;
        le.ip = e.sourceIp;
        pushLogEvent(this.redis, le);
    }

    /// Newest first (LRANGE order). Unparseable entries are skipped;
    /// a Redis failure degrades to an empty log rather than a 500.
    MailEvent[] recent(long limit = 100) {
        if (limit < 1) return null;
        MailEvent[] out_;
        try {
            auto reply = db().request!(RedisReply!string)("LRANGE", mailEventsKey(),
                "0", (limit - 1).to!string);
            foreach (raw; reply) {
                try out_ ~= MailEvent.fromJson(parseJsonString(raw));
                catch (Exception ex)
                    logWarn("mail-events: skipping unparseable entry: %s", ex.msg);
            }
        } catch (Exception ex) {
            logWarn("mail-events: reading the send log failed: %s", ex.msg);
            return null;
        }
        return out_;
    }
}
