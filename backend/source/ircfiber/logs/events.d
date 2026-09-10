/**
 * Operations-log announcements: gateway → #staff bot transport.
 *
 * Every website signup, every outbound email and every client connect to
 * the ircd is serialized as a `LogEvent` and RPUSHed onto the Redis list
 * `logsOutboxKey()`. FiberEye (`ircfiber.fibereye.bot`) BLPOPs the list,
 * attaches the IP-intelligence record and formats one or two IRC lines
 * per event. The list is FIFO, survives bot restarts and is trimmed to the
 * newest `LOGS_OUTBOX_MAX` entries so a long bot outage cannot grow it
 * without bound.
 *
 * The keys live here rather than in `ircfiber.redis.protocol` (the
 * triple-vendored `common/`) for the same reason `ircfiber.mail_events`
 * keeps its own: they are site-backend-private and adding them to
 * `RedisKeys` would mean editing three byte-identical copies for keys the
 * engine never touches.
 */
module ircfiber.logs.events;

import vibe.data.json : Json;
import vibe.core.log;
import ircfiber.storage.redis : RedisStorage;

/// Maximum number of queued announcements kept when the bot is away.
enum LOGS_OUTBOX_MAX = 1000;

/// FIFO of pending announcements (producers RPUSH, FiberEye BLPOPs).
string logsOutboxKey() @safe pure nothrow { return "irc:logs:outbox"; }

/// One announcement. `#staff` is oper-only (`+O`), so unlike the #support
/// bot these lines deliberately carry full IPs and e-mail addresses.
struct LogEvent {
    /// "signup" | "mail" | "irc_connect" | "notice" | "backup"
    string type;
    /// Event timestamp (unix ms).
    long ts;
    /// Account username (signup, mail, "" when unknown).
    string username;
    /// E-mail address (signup, mail).
    string email;
    /// Source IP (signup, mail, irc_connect) — geo-enriched by the bot.
    string ip;
    /// Mail kind: "signup_verification" | "password_reset" | "admin_test" | …
    string kind;
    /// Mail provider: "resend" | "sender" | "log".
    string provider;
    /// Mail status: "sent" | "failed".
    string status;
    /// Mail failure text.
    string error;
    /// Mail send duration.
    long durationMs;
    /// irc_connect: nick!ident@host of the connecting client.
    string nick;
    /// ditto
    string ident;
    /// ditto
    string host;
    /// irc_connect: GECOS.
    string realname;
    /// irc_connect: the ircd connect class the client landed in.
    string connClass;
    /// irc_connect: server port the client used.
    long port;
    /// "notice": admin username that queued the line.
    string actor;
    /// "notice": free text.
    string text;
    /// "backup": the CronJob stage at publish ("done" on success, otherwise the failed stage).
    string stage;
    /// "backup": archive basename, e.g. "mongo-20260907-031700.archive.gz".
    string file;
    /// "backup": archive bytes.
    long fileBytes;

    /// Serializes to Json.
    Json toJson() const {
        return Json([
            "type": Json(type), "ts": Json(ts),
            "username": Json(username), "email": Json(email), "ip": Json(ip),
            "kind": Json(kind), "provider": Json(provider), "status": Json(status),
            "error": Json(error), "durationMs": Json(durationMs),
            "nick": Json(nick), "ident": Json(ident), "host": Json(host),
            "realname": Json(realname), "connClass": Json(connClass), "port": Json(port),
            "actor": Json(actor), "text": Json(text),
            "stage": Json(stage), "file": Json(file), "fileBytes": Json(fileBytes),
        ]);
    }

    /// Deserializes from Json; missing or mistyped fields keep their init value.
    static LogEvent fromJson(Json j) {
        LogEvent ev;
        if (j.type != Json.Type.object) return ev;
        ev.type = j["type"].opt!string;
        ev.ts = j["ts"].opt!long;
        ev.username = j["username"].opt!string;
        ev.email = j["email"].opt!string;
        ev.ip = j["ip"].opt!string;
        ev.kind = j["kind"].opt!string;
        ev.provider = j["provider"].opt!string;
        ev.status = j["status"].opt!string;
        ev.error = j["error"].opt!string;
        ev.durationMs = j["durationMs"].opt!long;
        ev.nick = j["nick"].opt!string;
        ev.ident = j["ident"].opt!string;
        ev.host = j["host"].opt!string;
        ev.realname = j["realname"].opt!string;
        ev.connClass = j["connClass"].opt!string;
        ev.port = j["port"].opt!long;
        ev.actor = j["actor"].opt!string;
        ev.text = j["text"].opt!string;
        ev.stage = j["stage"].opt!string;
        ev.file = j["file"].opt!string;
        ev.fileBytes = j["fileBytes"].opt!long;
        return ev;
    }
}

/// Queues `ev` for FiberEye's #staff announcer: RPUSH + LTRIM to the newest
/// `LOGS_OUTBOX_MAX`. Announcing is best-effort — failures are logged,
/// never thrown, so a Redis hiccup cannot fail the HTTP request that
/// already created the account, nor the bot's own IRC read loop.
void pushLogEvent(RedisStorage redis, LogEvent ev) @trusted {
    if (redis is null) return;
    try {
        auto db = redis.getDb();
        const key = logsOutboxKey();
        db.rpush(key, ev.toJson().toString());
        db.ltrim(key, -LOGS_OUTBOX_MAX, -1);
    } catch (Exception e) {
        logWarn("logs outbox push failed (%s): %s", ev.type, e.msg);
    }
}
