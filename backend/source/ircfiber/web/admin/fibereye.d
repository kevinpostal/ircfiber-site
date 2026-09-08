/**
 * Admin JSON API for FiberEye (`/api/admin/fibereye*`).
 *
 * FiberEye runs in its own container, so its live state reaches the admin
 * page through the heartbeat it publishes to Redis, and admin actions
 * travel back through its control list — same shape as the #staff log bot
 * (`ircfiber.web.admin.logs_bot`). The persisted sessions/IPs/bans come
 * straight out of Mongo through `ircfiber.fibereye.store`.
 *
 * Two things deliberately do *not* go through the bot:
 *   - arming enforcement is a Redis key (`fibereye:armed`), not a command,
 *     so it survives a bot restart and is readable by anything;
 *   - releasing a Z-line runs here, over the dashboard-oper session
 *     (`removeXlineNow`), because the web process is the one that holds a
 *     ZLINE-capable oper session. Any oper may remove any X-line.
 */
module ircfiber.web.admin.fibereye;

import std.datetime : Clock;
import std.process : environment;
import std.string : strip, toLower;
import std.conv : to;

import vibe.core.log : logInfo, logWarn;
import vibe.data.bson;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.fibereye.events : fiberEyeArmedKey, fiberEyeBotKey, fiberEyeControlKey;
import ircfiber.fibereye.format : ipGroup, zlineMatches;
import ircfiber.fibereye.rules : isAutoPlacedZline;
import ircfiber.fibereye.store;
import ircfiber.models.user : User;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.helpers : jsonOk, jsonError, queryString, readJsonBody;
import ircfiber.web.admin.ircd : IrcdError, XLine, listXlinesNow, removeXlineNow;

/// Heartbeats older than this are reported as dead even if the key has not
/// expired yet (the bot refreshes every ≤5 s with a 60 s TTL).
private enum FIBEREYE_STALE_MS = 60_000;
/// Newest sessions consulted for an IP's distinct nick/account rollup.
/// The IP document deliberately stores no nick array — a nick-rotating bot
/// would grow it without bound.
private enum IP_DETAIL_SESSIONS = 200;

private long nowMs() { return Clock.currTime.toUnixTime!long * 1000; }

private User currentAdmin(HTTPServerRequest req) {
    if (auto p = "user" in req.context) return (*p).get!User;
    return User.init;
}

private int queryInt(HTTPServerRequest req, string key, int fallback) {
    try {
        const raw = queryString(req, key, "");
        if (raw.length) return raw.to!int;
    } catch (Exception) {
    }
    return fallback;
}

/// `page` (from 0) and `limit` (default 50, clamped to 200) — same paging
/// contract as the admin uploads list.
private void paging(HTTPServerRequest req, out int page, out int limit, out int offset) {
    page = queryInt(req, "page", 0);
    if (page < 0) page = 0;
    limit = queryInt(req, "limit", 50);
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;
    offset = page * limit;
}

/// Escapes every regex metacharacter so a search term is matched
/// literally: `q` is embedded in a Mongo `$regex`, and an unescaped `(`
/// from user input would either error or match far more than intended.
private string escapeRegex(string s) {
    string out_;
    foreach (char c; s) {
        switch (c) {
            case '\\': case '^': case '$': case '.': case '|': case '?':
            case '*': case '+': case '(': case ')': case '[': case ']':
            case '{': case '}': case '/':
                out_ ~= '\\';
                out_ ~= c;
                break;
            default:
                out_ ~= c;
        }
    }
    return out_;
}

private Bson caseInsensitiveLike(string field, string term) {
    return Bson([field: Bson(["$regex": Bson(escapeRegex(term)), "$options": Bson("i")])]);
}

private Json sessionJson(const SessionRecord r) {
    auto o = Json.emptyObject;
    o["id"] = Json(r.id);
    o["ts"] = Json(r.ts);
    o["nick"] = Json(r.nick);
    o["ident"] = Json(r.ident);
    o["host"] = Json(r.host);
    o["ip"] = Json(r.ip);
    o["ipGroup"] = Json(r.ipGroup);
    o["ipVersion"] = Json(r.ipVersion);
    o["realname"] = Json(r.realname);
    o["connClass"] = Json(r.connClass);
    o["port"] = Json(r.port);
    o["tls"] = Json(r.tls);
    o["account"] = Json(r.account);
    o["quitTs"] = Json(r.quitTs);
    o["quitReason"] = Json(r.quitReason);
    o["durationMs"] = Json(r.durationMs);
    o["geoCity"] = Json(r.geoCity);
    o["geoRegion"] = Json(r.geoRegion);
    o["geoCountry"] = Json(r.geoCountry);
    o["geoOrg"] = Json(r.geoOrg);
    o["geoTimezone"] = Json(r.geoTimezone);
    o["geoPrivacy"] = Json(r.geoPrivacy);
    o["geoPending"] = Json(r.geoPending);
    return o;
}

private Json ipJson(const IpRecord r) {
    auto o = Json.emptyObject;
    o["ipGroup"] = Json(r.ipGroup);
    o["ip"] = Json(r.ip);
    o["ipVersion"] = Json(r.ipVersion);
    o["firstSeen"] = Json(r.firstSeen);
    o["lastSeen"] = Json(r.lastSeen);
    o["connects"] = Json(r.connects);
    o["shortSessions"] = Json(r.shortSessions);
    o["lastNick"] = Json(r.lastNick);
    o["lastAccount"] = Json(r.lastAccount);
    o["lastRealname"] = Json(r.lastRealname);
    o["lastClass"] = Json(r.lastClass);
    o["geoCity"] = Json(r.geoCity);
    o["geoRegion"] = Json(r.geoRegion);
    o["geoCountry"] = Json(r.geoCountry);
    o["geoOrg"] = Json(r.geoOrg);
    o["geoTimezone"] = Json(r.geoTimezone);
    o["geoPrivacy"] = Json(r.geoPrivacy);
    o["geoPending"] = Json(r.geoPending);
    o["strikes"] = Json(r.strikes);
    o["bannedUntil"] = Json(r.bannedUntil);
    o["lastBanId"] = Json(r.lastBanId);
    return o;
}

private Json banJson(const BanRecord b) {
    auto o = Json.emptyObject;
    o["id"] = Json(b.id);
    o["mask"] = Json(b.mask);
    o["ipGroup"] = Json(b.ipGroup);
    o["type"] = Json(b.type);
    o["rule"] = Json(b.rule);
    o["reason"] = Json(b.reason);
    o["durationSeconds"] = Json(b.durationSeconds);
    o["placedAtMs"] = Json(b.placedAtMs);
    o["expiresAtMs"] = Json(b.expiresAtMs);
    o["strikes"] = Json(b.strikes);
    o["observeOnly"] = Json(b.observeOnly);
    o["placed"] = Json(b.placed);
    o["placeError"] = Json(b.placeError);
    o["releasedAtMs"] = Json(b.releasedAtMs);
    o["releasedBy"] = Json(b.releasedBy);
    auto ev = Json.emptyObject;
    ev["connects"] = Json(b.evidence.connects);
    ev["nicks"] = Json(b.evidence.nicks);
    ev["shortSessions"] = Json(b.evidence.shortSessions);
    ev["windowSeconds"] = Json(b.evidence.windowSeconds);
    o["evidence"] = ev;
    // What the UI badges: observed → active → released/expired.
    const now = nowMs();
    string state;
    if (b.observeOnly) state = "observed";
    else if (b.releasedAtMs > 0) state = "released";
    else if (b.expiresAtMs <= now) state = "expired";
    else state = "active";
    o["state"] = Json(state);
    return o;
}

private Json xlineJson(const XLine x) {
    auto o = Json.emptyObject;
    o["mask"] = Json(x.mask);
    // Numeric 210 reports the set time in unix SECONDS, but every other
    // timestamp in this API is unix ms (`ts`, `placedAtMs`, `lastSeen`, …).
    // Converting here keeps the payload internally consistent instead of
    // leaving one seconds field for each caller to trip over.
    o["setAtMs"] = Json(x.setAt * 1000);
    o["durationSecs"] = Json(x.durationSecs);
    o["setter"] = Json(x.setter);
    o["reason"] = Json(x.reason);
    o["autoPlaced"] = Json(isAutoPlacedZline(x.reason));
    return o;
}

/// GET /api/admin/fibereye — the page's overview: arm state, bot
/// heartbeat, 24 h counters, disarmed candidates and recent bans.
package void apiFiberEyeOverview(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    bool armed;
    try armed = redis.getDb().get(fiberEyeArmedKey()) == "1";
    catch (Exception) {}

    Json bot = Json(null);
    try bot = redis.getJson(fiberEyeBotKey());
    catch (Exception) {}
    bool alive;
    long ageMs = -1;
    if (bot.type == Json.Type.object) {
        const updatedAt = bot["updatedAt"].opt!long;
        ageMs = updatedAt > 0 ? nowMs() - updatedAt : -1;
        alive = ageMs >= 0 && ageMs <= FIBEREYE_STALE_MS;
    } else {
        bot = Json(null);
    }

    auto data = Json.emptyObject;
    data["armed"] = Json(armed);
    data["bot"] = bot;
    data["alive"] = Json(alive);
    data["heartbeatAgeMs"] = Json(ageMs);
    data["runsInThisProcess"] = Json(isEnvEnabled("IRCFIBER_FIBEREYE_ENABLED"));
    // What this deployment expects, so the page can name the bot before
    // its first heartbeat.
    auto nick = environment.get("IRCFIBER_FIBEREYE_NICK", "").strip();
    data["expectedNick"] = Json(nick.length ? nick : "FiberEye");

    auto store = new FiberEyeStore();
    const since = nowMs() - 86_400_000;
    auto counters = Json.emptyObject;
    counters["connects24h"] = Json(store.countSessionsSince(since));
    counters["quits24h"] = Json(store.countQuitsSince(since));
    counters["uniqueIps24h"] = Json(store.countIpsSeenSince(since));
    counters["sessionsOpen"] = Json(store.countOpenSessions());
    counters["bansActive"] = Json(store.countBans(Bson([
        "observeOnly": Bson(false),
        "releasedAtMs": Bson(0L),
        "expiresAtMs": Bson(["$gt": Bson(nowMs())]),
    ])));
    counters["bansObserved24h"] = Json(store.countBans(Bson([
        "observeOnly": Bson(true),
        "placedAtMs": Bson(["$gte": Bson(since)]),
    ])));
    counters["releases24h"] = Json(store.countBans(Bson([
        "releasedBy": Bson("self-service"),
        "releasedAtMs": Bson(["$gte": Bson(since)]),
    ])));
    data["counters"] = counters;

    long total;
    auto candidates = Json.emptyArray;
    foreach (b; store.pageBans("observed", 0, 20, total)) candidates ~= banJson(b);
    data["candidates"] = candidates;
    auto recent = Json.emptyArray;
    foreach (b; store.pageBans("all", 0, 20, total)) recent ~= banJson(b);
    data["recentBans"] = recent;
    jsonOk(res, data);
}

/// GET /api/admin/fibereye/sessions?q=&ip=&nick=&account=&openOnly=&page=&limit=
package void apiFiberEyeSessions(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    int page, limit, offset;
    paging(req, page, limit, offset);
    Bson[] clauses;
    const ip = queryString(req, "ip", "");
    if (ip.length) {
        // An exact address and its group are both accepted, so a link from
        // the IP table works whichever the caller has.
        clauses ~= Bson(["$or": Bson([
            Bson(["ip": Bson(ip)]),
            Bson(["ipGroup": Bson(ipGroup(ip))]),
        ])]);
    }
    const nick = queryString(req, "nick", "");
    if (nick.length) clauses ~= caseInsensitiveLike("nick", nick);
    const account = queryString(req, "account", "");
    if (account.length) clauses ~= caseInsensitiveLike("account", account);
    const openOnly = queryString(req, "openOnly", "").toLower();
    if (openOnly == "1" || openOnly == "true") clauses ~= Bson(["quitTs": Bson(0L)]);
    const q = queryString(req, "q", "");
    if (q.length) {
        Bson[] any;
        foreach (field; ["nick", "ident", "ip", "realname", "account"])
            any ~= caseInsensitiveLike(field, q);
        clauses ~= Bson(["$or": Bson(any)]);
    }
    Bson filter = clauses.length ? Bson(["$and": Bson(clauses)]) : Bson.emptyObject;

    auto store = new FiberEyeStore();
    long total;
    auto rows = Json.emptyArray;
    foreach (r; store.pageSessions(filter, offset, limit, total)) rows ~= sessionJson(r);
    auto data = Json.emptyObject;
    data["rows"] = rows;
    data["total"] = Json(total);
    data["page"] = Json(page);
    data["limit"] = Json(limit);
    jsonOk(res, data);
}

/// GET /api/admin/fibereye/ips?q=&sort=lastSeen|connects&state=all|banned|observed&page=&limit=
package void apiFiberEyeIps(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    int page, limit, offset;
    paging(req, page, limit, offset);
    Bson[] clauses;
    const state = queryString(req, "state", "all");
    if (state == "banned") clauses ~= Bson(["bannedUntil": Bson(["$gt": Bson(nowMs())])]);
    else if (state == "observed") clauses ~= Bson(["strikes": Bson(["$gt": Bson(0L)])]);
    const q = queryString(req, "q", "");
    if (q.length) {
        Bson[] any;
        any ~= caseInsensitiveLike("_id", q);
        foreach (field; ["ip", "lastNick", "lastAccount", "lastRealname", "geoCity",
                "geoCountry", "geoOrg"])
            any ~= caseInsensitiveLike(field, q);
        clauses ~= Bson(["$or": Bson(any)]);
    }
    Bson filter = clauses.length ? Bson(["$and": Bson(clauses)]) : Bson.emptyObject;

    auto store = new FiberEyeStore();
    long total;
    auto rows = Json.emptyArray;
    const sort = queryString(req, "sort", "lastSeen");
    foreach (r; store.pageIps(filter, sort, offset, limit, total)) rows ~= ipJson(r);
    auto data = Json.emptyObject;
    data["rows"] = rows;
    data["total"] = Json(total);
    data["page"] = Json(page);
    data["limit"] = Json(limit);
    jsonOk(res, data);
}

/// GET /api/admin/fibereye/ip?ip=<group or address> — one IP group's
/// rollup, its distinct nicks/accounts, its ban history, its newest
/// sessions and the live `STATS Z` entry (or null).
package void apiFiberEyeIp(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const raw = queryString(req, "ip", "");
    if (!raw.length) { jsonError(res, 400, "ip is required."); return; }
    const group = ipGroup(raw);

    auto store = new FiberEyeStore();
    auto data = Json.emptyObject;
    data["ip"] = Json(group);
    auto found = store.findIp(group);
    data["rollup"] = found.isNull ? Json(null) : ipJson(found.get);

    auto sessions = Json.emptyArray;
    bool[string] nicks, accounts;
    auto recent = store.sessionsForGroup(group, IP_DETAIL_SESSIONS);
    foreach (i, r; recent) {
        if (i < 100) sessions ~= sessionJson(r);
        if (r.nick.length) nicks[r.nick] = true;
        if (r.account.length) accounts[r.account] = true;
    }
    data["sessions"] = sessions;
    auto nickArr = Json.emptyArray;
    foreach (n, _; nicks) nickArr ~= Json(n);
    data["distinctNicks"] = nickArr;
    auto accArr = Json.emptyArray;
    foreach (a, _; accounts) accArr ~= Json(a);
    data["distinctAccounts"] = accArr;

    auto bans = Json.emptyArray;
    foreach (b; store.bansForGroup(group, 50)) bans ~= banJson(b);
    data["bans"] = bans;

    // The live ircd view: what is actually in force right now, which may
    // differ from the ban documents (an oper may have removed it by hand).
    Json zline = Json(null);
    try {
        foreach (x; listXlinesNow("zline")) {
            if (x.mask != group && !zlineMatches(x.mask, found.isNull ? group : found.get.ip))
                continue;
            zline = xlineJson(x);
            break;
        }
    } catch (IrcdError e) {
        logWarn("FiberEye admin: STATS Z unavailable: %s", e.msg);
    } catch (Exception e) {
        logWarn("FiberEye admin: STATS Z failed: %s", e.msg);
    }
    data["zline"] = zline;
    jsonOk(res, data);
}

/// GET /api/admin/fibereye/bans?state=active|observed|released|all&page=&limit=
package void apiFiberEyeBans(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    int page, limit, offset;
    paging(req, page, limit, offset);
    const state = queryString(req, "state", "all");
    auto store = new FiberEyeStore();
    long total;
    auto rows = Json.emptyArray;
    foreach (b; store.pageBans(state, offset, limit, total)) rows ~= banJson(b);
    auto data = Json.emptyObject;
    data["rows"] = rows;
    data["total"] = Json(total);
    data["page"] = Json(page);
    data["limit"] = Json(limit);
    data["state"] = Json(state);
    jsonOk(res, data);
}

/// POST /api/admin/fibereye/arm — body `{armed: bool}`. Enforcement is a
/// Redis key rather than a bot command so it survives a bot restart and a
/// missing key means disarmed.
package void apiFiberEyeArm(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    if (body_.type != Json.Type.object || body_["armed"].type != Json.Type.bool_) {
        jsonError(res, 400, "armed must be true or false.");
        return;
    }
    const armed = body_["armed"].get!bool;
    auto admin = currentAdmin(req);
    try redis.getDb().set(fiberEyeArmedKey(), armed ? "1" : "0");
    catch (Exception e) {
        jsonError(res, 502, "Redis unavailable: " ~ e.msg);
        return;
    }
    logInfo("FiberEye enforcement %s by %s", armed ? "ARMED" : "disarmed", admin.username);
    auto data = Json.emptyObject;
    data["armed"] = Json(armed);
    jsonOk(res, data);
}

/// POST /api/admin/fibereye/bans/release — body `{banId}`. Removes the
/// Z-line over the dashboard-oper session, then records who lifted it.
package void apiFiberEyeBanRelease(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    string banId;
    if (body_.type == Json.Type.object && body_["banId"].type == Json.Type.string)
        banId = body_["banId"].get!string.strip();
    if (!banId.length) { jsonError(res, 400, "banId is required."); return; }

    auto store = new FiberEyeStore();
    auto lookup = store.findBanById(banId);
    if (lookup.isNull) { jsonError(res, 404, "No such ban."); return; }
    const ban = lookup.get;
    if (ban.releasedAtMs > 0) { jsonError(res, 409, "That ban was already released."); return; }

    auto admin = currentAdmin(req);
    if (!ban.observeOnly) {
        try removeXlineNow("zline", ban.mask);
        catch (IrcdError e) {
            jsonError(res, e.httpStatus, e.msg);
            return;
        } catch (Exception e) {
            logWarn("FiberEye admin: release of %s failed: %s", ban.mask, e.msg);
            jsonError(res, 502, "IRCd operation failed.");
            return;
        }
    }
    const now = nowMs();
    store.markBanReleased(banId, now, admin.username);
    store.setIpBan(ban.ipGroup, 0, banId, ban.strikes);
    logInfo("FiberEye: %s released %s (%s)", admin.username, ban.mask,
        ban.observeOnly ? "observed candidate" : "zline");
    auto data = Json.emptyObject;
    data["released"] = Json(ban.mask);
    data["observeOnly"] = Json(ban.observeOnly);
    jsonOk(res, data);
}

/// POST /api/admin/fibereye/reconnect — drop and re-establish the bot's
/// IRC session. The bot drops commands older than 60 s, so a request made
/// while it is down does not fire on its next start.
package void apiFiberEyeReconnect(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto admin = currentAdmin(req);
    auto entry = Json([
        "cmd": Json("reconnect"), "by": Json(admin.username), "ts": Json(nowMs()),
    ]);
    try {
        auto db = redis.getDb();
        db.rpush(fiberEyeControlKey(), entry.toString());
        db.ltrim(fiberEyeControlKey(), -20, -1);
    } catch (Exception e) {
        jsonError(res, 502, "Redis unavailable: " ~ e.msg);
        return;
    }
    logInfo("Admin %s queued FiberEye command reconnect", admin.username);
    auto data = Json.emptyObject;
    data["queued"] = Json("reconnect");
    jsonOk(res, data);
}
