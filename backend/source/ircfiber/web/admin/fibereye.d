/**
 * Admin JSON API for FiberEye (`/api/admin/fibereye*`).
 *
 * FiberEye runs in its own container, so its live state reaches the admin
 * page through the heartbeat it publishes to Redis, and admin actions
 * travel back through its control list. The persisted sessions/IPs/bans
 * come straight out of Mongo through `ircfiber.fibereye.store`; the IP
 * intelligence record through `ircfiber.ipintel.store`.
 *
 * FiberEye is also the `#staff` announcer, so the announce / rejoin
 * actions that used to belong to the retired FiberLogs bot live here.
 *
 * Two things deliberately do *not* go through the bot:
 *   - arming enforcement is a Redis key (`fibereye:armed`), not a command,
 *     so it survives a bot restart and is readable by anything;
 *   - releasing a Z-line runs here, over the dashboard-oper session
 *     (`removeXlineNow`), because the web process is the one that holds a
 *     ZLINE-capable oper session. Any oper may remove any X-line.
 */
module ircfiber.web.admin.fibereye;

import std.process : environment;
import std.string : split, strip, toLower;
import std.conv : to;

import vibe.core.log : logInfo, logWarn;
import vibe.data.bson;
import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.bots.core : nowMs;

import ircfiber.fibereye.events : fiberEyeArmedKey, fiberEyeBotKey, fiberEyeControlKey,
    fiberEyeRulesKey;
import ircfiber.fibereye.format : ipGroup, zlineMatches;
import ircfiber.fibereye.rules : isAutoPlacedZline, RULE_WINDOW_MIN, RULE_WINDOW_MAX,
    RULE_COUNT_MIN, RULE_COUNT_MAX, RULE_SHORT_MS_MIN, RULE_SHORT_MS_MAX,
    RULE_BAN_SECONDS_MIN, RULE_BAN_SECONDS_MAX;
import ircfiber.fibereye.ruleset : RuleSet, RULE_LIST_MAX, summarizeRuleChange, validateRuleSet;
import ircfiber.fibereye.store;
import ircfiber.ipintel.record : IpIntel;
import ircfiber.ipintel.service : IpIntelService, LookupMode, loadIpIntelSettings;
import ircfiber.ipintel.store : IpIntelStore;
import ircfiber.logs.events : LogEvent, logsOutboxKey, pushLogEvent;
import ircfiber.logs.format : isPrivateIp;
import ircfiber.models.user : User;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.support.json : sanitizeLine;
import ircfiber.tracing : isEnvEnabled;
import ircfiber.web.admin.helpers : jsonOk, jsonError, queryString, readJsonBody;
import ircfiber.web.admin.ircd : IrcdError, XLine, listXlinesNow, removeXlineNow;
import ircfiber.web.admin.ircd : loadIrcdSettings, parseConfTag;

/// Heartbeats older than this are reported as dead even if the key has not
/// expired yet (the bot refreshes every ≤5 s with a 60 s TTL).
private enum FIBEREYE_STALE_MS = 60_000;
/// Newest sessions consulted for an IP's distinct nick/account rollup.
/// The IP document deliberately stores no nick array — a nick-rotating bot
/// would grow it without bound.
private enum IP_DETAIL_SESSIONS = 200;

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
    o["geoPending"] = Json(r.geoPending);
    o["intelAsn"] = Json(r.intelAsn);
    o["intelFlags"] = Json(r.intelFlags);
    o["intelOperator"] = Json(r.intelOperator);
    o["intelPrefix"] = Json(r.intelPrefix);
    o["intelRisk"] = Json(r.intelRisk);
    o["intelAt"] = Json(r.intelAt);
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
    o["geoPending"] = Json(r.geoPending);
    o["intelAsn"] = Json(r.intelAsn);
    o["intelFlags"] = Json(r.intelFlags);
    o["intelOperator"] = Json(r.intelOperator);
    o["intelPrefix"] = Json(r.intelPrefix);
    o["intelRisk"] = Json(r.intelRisk);
    o["intelAt"] = Json(r.intelAt);
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
    data["expectedNick"] = Json(nick.length ? nick : "FIBEREYE");
    auto channel = environment.get("IRCFIBER_FIBEREYE_CHANNEL", "").strip();
    data["expectedChannel"] = Json(channel.length ? channel : "#staff");
    // The `#staff` announcement queue and the admin control list.
    long outboxDepth = -1, controlDepth = -1;
    try outboxDepth = redis.getDb().llen(logsOutboxKey()); catch (Exception) {}
    try controlDepth = redis.getDb().llen(fiberEyeControlKey()); catch (Exception) {}
    data["outboxDepth"] = Json(outboxDepth);
    data["controlDepth"] = Json(controlDepth);

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

    // The canonical IP-intelligence record for the exact address, plus
    // which sources this deployment can run (so the page can explain a
    // missing field). Stored under the exact IP, not the group.
    const exactIp = found.isNull || !found.get.ip.length ? raw.strip() : found.get.ip;
    Json intel = Json(null);
    try {
        bool have;
        auto rec = new IpIntelStore().get(exactIp, have);
        if (have) intel = rec.toJson();
    } catch (Exception e) {
        logWarn("FiberEye admin: ipintel read failed for %s: %s", exactIp, e.msg);
    }
    data["intel"] = intel;
    auto srcs = Json.emptyArray;
    foreach (s; new IpIntelService(redis, null, loadIpIntelSettings()).activeSources()) srcs ~= Json(s);
    data["intelSources"] = srcs;
    jsonOk(res, data);
}

/// POST /api/admin/fibereye/ip/deep — body `{ip}`; refetches every
/// source and adds Shodan InternetDB (non-commercial: manual use only).
/// Answers `{intel}` with the fresh record.
package void apiFiberEyeIpDeep(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    const ip = body_.type == Json.Type.object ? body_["ip"].opt!string.strip() : "";
    if (!ip.length || isPrivateIp(ip)) { jsonError(res, 400, "a public IP address is required."); return; }
    IpIntelStore store;
    try store = new IpIntelStore();
    catch (Exception e) { jsonError(res, 502, "Mongo unavailable: " ~ e.msg); return; }
    auto admin = currentAdmin(req);
    auto rec = new IpIntelService(redis, store, loadIpIntelSettings()).lookup(ip, LookupMode.deep);
    logInfo("Admin %s ran a deep IP lookup for %s (%s degraded)", admin.username, ip, rec.degraded.length);
    auto data = Json.emptyObject;
    data["intel"] = rec.toJson();
    jsonOk(res, data);
}

/// GET /api/admin/fibereye/ip/batch?ips=<csv> — cached-only chip data for
/// table rows. Parses `ips`, dedupes, caps at 50 entries (400 over cap: one
/// wide table must not fan out per-row lookups without bound). Private
/// addresses answer `{ip, bogon: true}` with no lookup; the rest go through
/// `IpIntelService.lookup(ip, LookupMode.cached)`, which never makes a
/// network call and never burns quota counters. Each entry carries the
/// denormalized chip fields `sessionJson`/`ipJson` already expose — no new
/// JSON keys. (The literal `…/fibereye/ips?ips=` path is the paged list
/// endpoint, so batch lives beside the other single-IP routes instead.)
package void apiFiberEyeIpBatch(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const raw = queryString(req, "ips", "");
    string[] ips;
    bool[string] seen;
    foreach (part; raw.split(',')) {
        const ip = part.strip();
        if (!ip.length || (ip in seen)) continue;
        seen[ip] = true;
        ips ~= ip;
    }
    if (ips.length > 50) { jsonError(res, 400, "at most 50 IPs per request."); return; }
    IpIntelStore store;
    try store = new IpIntelStore();
    catch (Exception) { store = null; }
    auto svc = new IpIntelService(redis, store, loadIpIntelSettings());
    auto results = Json.emptyArray;
    foreach (ip; ips) {
        auto o = Json.emptyObject;
        o["ip"] = Json(ip);
        if (isPrivateIp(ip)) { o["bogon"] = Json(true); results ~= o; continue; }
        o["bogon"] = Json(false);
        IpIntel rec;
        try rec = svc.lookup(ip, LookupMode.cached);
        catch (Exception e) {
            logWarn("FiberEye admin: batch lookup failed for %s: %s", ip, e.msg);
            results ~= o;
            continue;
        }
        o["geoCity"] = Json(rec.geo.city);
        o["geoRegion"] = Json(rec.geo.region);
        o["geoCountry"] = Json(rec.geo.countryCode);
        o["geoOrg"] = Json(rec.network.org);
        o["intelFlags"] = Json(rec.flagsLabel());
        o["intelRisk"] = Json(rec.reputation.riskScore);
        o["geoPending"] = Json(false);
        results ~= o;
    }
    auto data = Json.emptyObject;
    data["results"] = results;
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
    // Arming shares the rule history the page shows: "who turned it on"
    // belongs in the same list as "who lowered the threshold".
    RuleAudit entry;
    entry.atMs = nowMs();
    entry.actor = admin.username;
    entry.action = armed ? "arm" : "disarm";
    entry.summary = armed ? "enforcement armed" : "enforcement disarmed";
    (new FiberEyeStore()).insertAudit(entry);
    auto data = Json.emptyObject;
    data["armed"] = Json(armed);
    jsonOk(res, data);
}

// ── ban rules ────────────────────────────────────────────────────────

/// The bot's heartbeat, or `Json(null)` when there is none.
private Json heartbeat(RedisStorage redis) {
    try {
        auto j = redis.getJson(fiberEyeBotKey());
        if (j.type == Json.Type.object) return j;
    } catch (Exception) {
    }
    return Json(null);
}

/// What the deploy asked for. The web process has no FiberEye env, so the
/// only source for the env baseline is the heartbeat the bot publishes;
/// without one, the built-in defaults are the honest answer.
private RuleSet deployedBaseline(Json bot) {
    RuleSet builtin;
    if (bot.type == Json.Type.object && bot["rulesDeployed"].type == Json.Type.object)
        return RuleSet.fromJson(bot["rulesDeployed"], builtin);
    return builtin;
}

/// The rule set actually in force according to the last heartbeat.
private RuleSet effectiveRules(Json bot, const RuleSet fallback) {
    if (bot.type == Json.Type.object && bot["rules"].type == Json.Type.object)
        return RuleSet.fromJson(bot["rules"], fallback);
    return cast(RuleSet) fallback;
}

private Json auditJson(const RuleAudit a) {
    auto o = Json.emptyObject;
    o["id"] = Json(a.id);
    o["atMs"] = Json(a.atMs);
    o["actor"] = Json(a.actor);
    o["action"] = Json(a.action);
    o["summary"] = Json(a.summary);
    return o;
}

/// The payload all three rule endpoints answer with, so the UI always
/// replaces its whole state from the response of whatever it just did.
private Json rulesPayload(RedisStorage redis, FiberEyeStore store) {
    auto bot = heartbeat(redis);
    auto data = Json.emptyObject;
    data["effective"] = (bot.type == Json.Type.object && bot["rules"].type == Json.Type.object)
        ? bot["rules"] : Json(null);
    data["deployed"] = (bot.type == Json.Type.object && bot["rulesDeployed"].type == Json.Type.object)
        ? bot["rulesDeployed"] : Json(null);
    string source = "unknown";
    if (bot.type == Json.Type.object) {
        const s = bot["rulesSource"].opt!string;
        if (s.length) source = s;
    }
    data["source"] = Json(source);

    auto stored = store.loadRules();
    if (stored.isNull) data["stored"] = Json(null);
    else {
        auto storedJson = stored.get.toJson();
        data["stored"] = storedJson;
        // Self-heal a lost mirror: Mongo is the source of truth, so a
        // Redis wipe must not quietly leave the bot on the baseline
        // while the page still shows a stored override.
        try {
            if (redis.getJson(fiberEyeRulesKey()).type != Json.Type.object) {
                redis.setJson(fiberEyeRulesKey(), storedJson);
                logInfo("FiberEye: republished the rules mirror from Mongo");
            }
        } catch (Exception e) {
            logWarn("FiberEye admin: cannot republish the rules mirror: %s", e.msg);
        }
    }

    auto bounds = Json.emptyObject;
    bounds["windowMin"] = Json(cast(long) RULE_WINDOW_MIN);
    bounds["windowMax"] = Json(cast(long) RULE_WINDOW_MAX);
    bounds["countMin"] = Json(cast(long) RULE_COUNT_MIN);
    bounds["countMax"] = Json(cast(long) RULE_COUNT_MAX);
    bounds["shortMsMin"] = Json(cast(long) RULE_SHORT_MS_MIN);
    bounds["shortMsMax"] = Json(cast(long) RULE_SHORT_MS_MAX);
    bounds["banSecondsMin"] = Json(cast(long) RULE_BAN_SECONDS_MIN);
    bounds["banSecondsMax"] = Json(cast(long) RULE_BAN_SECONDS_MAX);
    bounds["listMax"] = Json(cast(long) RULE_LIST_MAX);
    data["bounds"] = bounds;

    auto audit = Json.emptyArray;
    foreach (a; store.recentAudit(20)) audit ~= auditJson(a);
    data["audit"] = audit;
    return data;
}

/// GET /api/admin/fibereye/rules — what is in force, what the deploy
/// asked for, what an admin stored, the bounds the UI enforces and the
/// recent history.
package void apiFiberEyeRulesGet(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto store = new FiberEyeStore();
    jsonOk(res, rulesPayload(redis, store));
}

/// POST /api/admin/fibereye/rules — body is the canonical RuleSet JSON.
/// `updatedAtMs`/`updatedBy` from the body are ignored and set here.
package void apiFiberEyeRulesSet(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    if (body_.type != Json.Type.object) {
        jsonError(res, 400, "A rule set object is required.");
        return;
    }
    auto admin = currentAdmin(req);
    auto store = new FiberEyeStore();
    auto bot = heartbeat(redis);
    const baseline = deployedBaseline(bot);

    auto next = RuleSet.fromJson(body_, baseline);
    next.updatedAtMs = nowMs();
    next.updatedBy = admin.username;

    auto errs = validateRuleSet(next);
    if (errs.length) {
        // `jsonError` carries one string, but the form wants every reason
        // at once, so this one case writes the envelope directly.
        auto payload = Json.emptyObject;
        payload["ok"] = Json(false);
        payload["error"] = Json(errs[0]);
        auto list = Json.emptyArray;
        foreach (e; errs) list ~= Json(e);
        payload["errors"] = list;
        res.headers["Content-Type"] = "application/json; charset=utf-8";
        res.statusCode = 400;
        res.writeBody(payload.toString());
        return;
    }

    auto storedBefore = store.loadRules();
    const previous = storedBefore.isNull ? effectiveRules(bot, baseline) : storedBefore.get;

    store.saveRules(next);
    try redis.setJson(fiberEyeRulesKey(), next.toJson());
    catch (Exception e) {
        // Stored but not mirrored: the bot is still on the old rules until
        // the next GET republishes, so say so instead of reporting success.
        logWarn("FiberEye admin: rules stored but the mirror failed: %s", e.msg);
        jsonError(res, 502, "Rules stored, but Redis is unavailable so the bot has not picked them up.");
        return;
    }

    const summary = summarizeRuleChange(previous, next);
    RuleAudit a;
    a.atMs = next.updatedAtMs;
    a.actor = admin.username;
    a.action = "rules_update";
    a.summary = summary.length ? summary : "no effective change";
    a.before = previous.toJson().toString();
    a.after = next.toJson().toString();
    store.insertAudit(a);
    logInfo("FiberEye: rules updated by %s (%s)", admin.username, a.summary);

    jsonOk(res, rulesPayload(redis, store));
}

/// POST /api/admin/fibereye/rules/reset — drop the override so the
/// deployed baseline takes over again within one sideband tick.
package void apiFiberEyeRulesReset(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto admin = currentAdmin(req);
    auto store = new FiberEyeStore();
    auto bot = heartbeat(redis);
    const baseline = deployedBaseline(bot);
    auto storedBefore = store.loadRules();
    const previous = storedBefore.isNull ? effectiveRules(bot, baseline) : storedBefore.get;

    store.clearRules();
    try redis.getDb().del(fiberEyeRulesKey());
    catch (Exception e) {
        logWarn("FiberEye admin: cannot delete the rules mirror: %s", e.msg);
        jsonError(res, 502, "Override cleared in the database, but Redis is unavailable so the bot still has it.");
        return;
    }

    const summary = summarizeRuleChange(previous, baseline);
    RuleAudit a;
    a.atMs = nowMs();
    a.actor = admin.username;
    a.action = "rules_reset";
    a.summary = summary.length ? summary : "restored the deployed baseline";
    a.before = previous.toJson().toString();
    a.after = baseline.toJson().toString();
    store.insertAudit(a);
    logInfo("FiberEye: rules reset to the deployed baseline by %s (%s)", admin.username, a.summary);

    jsonOk(res, rulesPayload(redis, store));
}

/// GET /api/admin/fibereye/ircd-rules — the ircd's own first line of
/// defence, read-only, so every ban rule is visible in one place. These
/// tags are ansible-rendered deploy artifacts; changing them needs a
/// config render plus a rehash, which is why nothing here writes.
///
/// Answers 200 with `available:false` and a reason when the file is not
/// readable, so the panel degrades instead of failing the page.
package void apiFiberEyeIrcdRules(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    import std.file : exists, isFile, readText;
    import std.path : buildPath;

    auto settings = loadIrcdSettings();
    const path = buildPath(settings.confDir, "modules.conf");
    auto data = Json.emptyObject;
    data["path"] = Json(path);

    if (!exists(path) || !isFile(path)) {
        data["available"] = Json(false);
        data["reason"] = Json("The ircd config dir is not mounted into the gateway (" ~ path ~ ").");
        jsonOk(res, data);
        return;
    }
    string text;
    try text = readText(path);
    catch (Exception e) {
        logWarn("FiberEye admin: cannot read %s: %s", path, e.msg);
        data["available"] = Json(false);
        data["reason"] = Json("The ircd config file could not be read.");
        jsonOk(res, data);
        return;
    }

    static Json tagJson(string[string] attrs) {
        auto o = Json.emptyObject;
        foreach (k, v; attrs) o[k] = Json(v);
        return o;
    }
    auto connectban = parseConfTag(text, "connectban");
    auto connflood = parseConfTag(text, "connflood");
    data["available"] = Json(connectban.length > 0 || connflood.length > 0);
    data["connectban"] = tagJson(connectban);
    data["connflood"] = tagJson(connflood);
    if (!connectban.length && !connflood.length)
        data["reason"] = Json("No <connectban> or <connflood> tag is present in " ~ path ~ ".");
    else data["reason"] = Json("");
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

/// Queues `cmd` for the bot; it drops commands older than 60 s, so a
/// request made while the bot is down does not fire on its next start.
private void queueFiberEyeCommand(HTTPServerRequest req, HTTPServerResponse res,
                                  RedisStorage redis, string cmd) {
    auto admin = currentAdmin(req);
    auto entry = Json([
        "cmd": Json(cmd), "by": Json(admin.username), "ts": Json(nowMs()),
    ]);
    try {
        auto db = redis.getDb();
        db.rpush(fiberEyeControlKey(), entry.toString());
        db.ltrim(fiberEyeControlKey(), -20, -1);
    } catch (Exception e) {
        jsonError(res, 502, "Redis unavailable: " ~ e.msg);
        return;
    }
    logInfo("Admin %s queued FiberEye command %s", admin.username, cmd);
    auto data = Json.emptyObject;
    data["queued"] = Json(cmd);
    jsonOk(res, data);
}

/// POST /api/admin/fibereye/reconnect — drop and re-establish the bot's IRC session.
package void apiFiberEyeReconnect(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueFiberEyeCommand(req, res, redis, "reconnect");
}

/// POST /api/admin/fibereye/rejoin — re-send JOIN for `#staff`.
package void apiFiberEyeRejoin(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    queueFiberEyeCommand(req, res, redis, "rejoin");
}

/// POST /api/admin/fibereye/announce — body `{text}`; the bot says
/// `Notice from <admin>: <text>` in `#staff` (via the outbox, so it is
/// delivered once the bot is back if it is currently away).
package void apiFiberEyeAnnounce(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto body_ = readJsonBody(req);
    const text = body_.type == Json.Type.object ? sanitizeLine(body_["text"].opt!string) : "";
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
