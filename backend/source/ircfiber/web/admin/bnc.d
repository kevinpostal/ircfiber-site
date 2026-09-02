module ircfiber.web.admin.bnc;

/// Admin JSON API for the bouncer ("Connect with another client…").
///
/// Two kinds of rows:
///   * clients  — live attachments: the `irc:bnc:clients` set of session ids
///                and the `irc:bnc:client:<sid>` presence records the bnc
///                process refreshes every 15 s;
///   * accounts — every network that has a bouncer password (Mongo
///                `bncToken`), joined with its owner, its attached clients
///                and the per-clientid replay cursors (`irc:bnc:seen:<net>`).
/// Actions cross the process boundary via `ircfiber.bnc.control`.

import std.algorithm : sort, canFind;
import std.conv : to;
import std.datetime : Clock;
import std.process : environment;
import std.uuid : UUID, parseUUID;

import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json, parseJsonString;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.bnc.control : publishBncKick, publishBncRevoked;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.user : UserRepository;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;

/// One attached client as stored by `BncClient.writePresence`.
private struct ClientRow {
    string sid, userId, networkId, networkName, clientId, nick, peer, caps;
    bool tls;
    long attachedAt, lastRecvMs, lastSendMs, cursor, linesIn, linesOut;
    /// TTL left on the presence key; stale rows (< 0) are dropped.
    long ttlSeconds;
}

private ClientRow[] loadClients(RedisStorage redis) {
    ClientRow[] rows;
    string[] sids;
    try {
        foreach (sid; redis.getDb().smembers(RedisKeys.bncClients())) sids ~= sid;
    } catch (Exception e) {
        logWarn("apiBncOverview: SMEMBERS failed: %s", e.msg);
        return rows;
    }
    foreach (sid; sids) {
        const key = RedisKeys.bncClient(sid);
        Json j;
        try j = redis.getJson(key);
        catch (Exception) continue;
        if (j.type != Json.Type.object) {
            // Record expired (bnc process died without a clean detach): prune the index.
            try redis.getDb().srem(RedisKeys.bncClients(), sid); catch (Exception) {}
            continue;
        }
        {
            ClientRow c;
            static string str(Json j, string k) {
                return j[k].type == Json.Type.string ? j[k].get!string : "";
            }
            static long num(Json j, string k) {
                if (j[k].type == Json.Type.int_) return j[k].get!long;
                if (j[k].type == Json.Type.float_) return cast(long) j[k].get!double;
                return 0;
            }
            c.sid = str(j, "sid");
            c.userId = str(j, "userId");
            c.networkId = str(j, "networkId");
            c.networkName = str(j, "networkName");
            c.clientId = str(j, "clientId");
            c.nick = str(j, "nick");
            c.peer = str(j, "peer");
            c.caps = str(j, "caps");
            c.tls = j["tls"].type == Json.Type.bool_ && j["tls"].get!bool;
            c.attachedAt = num(j, "attachedAt");
            c.lastRecvMs = num(j, "lastRecvMs");
            c.lastSendMs = num(j, "lastSendMs");
            c.cursor = num(j, "cursor");
            c.linesIn = num(j, "linesIn");
            c.linesOut = num(j, "linesOut");
            try c.ttlSeconds = redis.getDb().ttl(key);
            catch (Exception) c.ttlSeconds = -1;
            if (!c.sid.length || !c.userId.length) continue;
            rows ~= c;
        }
    }
    sort!((a, b) => a.attachedAt > b.attachedAt)(rows);
    return rows;
}

private Json clientJson(const ref ClientRow c, string username) {
    auto j = Json.emptyObject;
    j["sid"] = c.sid;
    j["userId"] = c.userId;
    j["username"] = username;
    j["networkId"] = c.networkId;
    j["networkName"] = c.networkName;
    j["clientId"] = c.clientId;
    j["nick"] = c.nick;
    j["peer"] = c.peer;
    j["tls"] = c.tls;
    j["caps"] = c.caps;
    j["attachedAt"] = c.attachedAt;
    j["lastRecvMs"] = c.lastRecvMs;
    j["lastSendMs"] = c.lastSendMs;
    j["cursor"] = c.cursor;
    j["linesIn"] = c.linesIn;
    j["linesOut"] = c.linesOut;
    j["presenceTtl"] = c.ttlSeconds;
    return j;
}

/// Resolves usernames once per distinct user id.
private string[string] usernamesFor(string[] userIds) {
    string[string] names;
    auto users = new UserRepository();
    foreach (uid; userIds) {
        if (uid in names) continue;
        try {
            // `.idup`: vibe.d's parseUUID aliases (and can blank) the source slice.
            auto u = users.findById(parseUUID(uid.idup));
            names[uid] = u.username.length ? u.username : "unknown";
        } catch (Exception) {
            names[uid] = "unknown";
        }
    }
    return names;
}

/// GET /api/admin/bnc
package void apiBncOverview(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto clients = loadClients(redis);
    auto networks = new NetworkRepository();
    auto accounts = networks.listWithBncToken();

    string[] uids;
    foreach (c; clients) uids ~= c.userId;
    foreach (a; accounts) uids ~= a.userId.toString();
    auto names = usernamesFor(uids);

    int[string] attachedPerNetwork;
    foreach (c; clients) attachedPerNetwork[c.networkId]++;

    auto clientsArr = Json.emptyArray;
    foreach (ref c; clients) clientsArr ~= clientJson(c, names.get(c.userId, "unknown"));

    auto accountsArr = Json.emptyArray;
    const nowMs = Clock.currTime.toUnixTime!long * 1000;
    int seenTotal = 0;
    foreach (a; accounts) {
        const nid = a.config.id.toString();
        auto j = Json.emptyObject;
        j["networkId"] = nid;
        j["networkName"] = a.config.name;
        j["host"] = a.config.host;
        j["nick"] = a.config.nick;
        j["disabled"] = a.config.disabled;
        j["userId"] = a.userId.toString();
        j["username"] = names.get(a.userId.toString(), "unknown");
        j["attached"] = attachedPerNetwork.get(nid, 0);
        auto seen = Json.emptyArray;
        try {
            foreach (cid, cur; redis.hgetAll(RedisKeys.bncSeen(nid))) {
                auto s = Json.emptyObject;
                s["clientId"] = cid;
                long eid = 0;
                try eid = cur.to!long; catch (Exception) {}
                s["cursor"] = eid;
                bool online = false;
                foreach (c; clients) if (c.networkId == nid && c.clientId == cid) { online = true; break; }
                s["online"] = online;
                seen ~= s;
                seenTotal++;
            }
        } catch (Exception e) {
            logWarn("apiBncOverview: seen hash read failed for %s: %s", nid, e.msg);
        }
        j["seen"] = seen;
        accountsArr ~= j;
    }

    bool[string] userSet;
    foreach (c; clients) userSet[c.userId] = true;

    auto listener = Json.emptyObject;
    const host = environment.get("IRCFIBER_BNC_PUBLIC_HOST", "");
    int port = 7000;
    try port = environment.get("IRCFIBER_BNC_PUBLIC_PORT", "7000").to!int; catch (Exception) {}
    listener["enabled"] = host.length > 0;
    listener["host"] = host;
    listener["port"] = port;
    listener["tls"] = environment.get("IRCFIBER_BNC_PUBLIC_TLS", "1") == "1";

    auto stats = Json.emptyObject;
    stats["attachedClients"] = cast(long) clients.length;
    stats["accounts"] = cast(long) accounts.length;
    stats["usersOnline"] = cast(long) userSet.length;
    stats["seenCursors"] = seenTotal;
    stats["serverTime"] = nowMs;

    auto data = Json.emptyObject;
    data["listener"] = listener;
    data["stats"] = stats;
    data["clients"] = clientsArr;
    data["accounts"] = accountsArr;
    jsonOk(res, data);
}

/// POST /api/admin/bnc/clients/:sid/kick  body: {reason?}
package void apiBncKick(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const sid = req.params["sid"].idup;
    Json j;
    try j = redis.getJson(RedisKeys.bncClient(sid));
    catch (Exception) {}
    if (j.type != Json.Type.object || j["userId"].type != Json.Type.string) {
        jsonError(res, 404, "No attached client with that session id");
        return;
    }
    string reason = "Disconnected by administrator";
    auto body = readJsonBody(req);
    if (body.type == Json.Type.object && body["reason"].type == Json.Type.string && body["reason"].get!string.length)
        reason = body["reason"].get!string;
    publishBncKick(redis, j["userId"].get!string, sid, reason);
    logInfo("Admin kicked bnc client sid=%s user=%s", sid, j["userId"].get!string);
    auto out_ = Json.emptyObject;
    out_["sid"] = sid;
    jsonOk(res, out_);
}

/// Loads a network by `:id`; writes a 404 and returns false when unknown.
private bool loadNetwork(HTTPServerRequest req, HTTPServerResponse res, NetworkRepository repo,
                         out UUID id, out UUID ownerId) {
    try id = parseUUID(req.params["id"].idup);
    catch (Exception) {
        jsonError(res, 400, "Invalid network id");
        return false;
    }
    auto info = repo.findByIdWithUser(id);
    if (info.config.name.length == 0) {
        jsonError(res, 404, "Network not found");
        return false;
    }
    ownerId = info.userId;
    return true;
}

/// POST /api/admin/bnc/networks/:id/revoke — clears the password, drops
/// replay cursors, disconnects attached clients (same as the user's own revoke).
package void apiBncRevoke(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new NetworkRepository();
    UUID id, owner;
    if (!loadNetwork(req, res, repo, id, owner)) return;
    repo.setBncToken(id, "");
    redis.del(RedisKeys.bncSeen(id.toString()));
    if (owner != UUID.init) publishBncRevoked(redis, owner.toString(), id.toString());
    logInfo("Admin revoked bnc password for network %s (owner %s)", id.toString(), owner.toString());
    auto out_ = Json.emptyObject;
    out_["networkId"] = id.toString();
    jsonOk(res, out_);
}

/// POST /api/admin/bnc/networks/:id/seen/clear — forget every clientid's
/// replay cursor (next reconnect of each client replays nothing).
package void apiBncSeenClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new NetworkRepository();
    UUID id, owner;
    if (!loadNetwork(req, res, repo, id, owner)) return;
    redis.del(RedisKeys.bncSeen(id.toString()));
    auto out_ = Json.emptyObject;
    out_["networkId"] = id.toString();
    jsonOk(res, out_);
}

/// POST /api/admin/bnc/networks/:id/seen/:clientId/forget — drop one cursor.
package void apiBncSeenForget(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto repo = new NetworkRepository();
    UUID id, owner;
    if (!loadNetwork(req, res, repo, id, owner)) return;
    const cid = req.params["clientId"].idup;
    if (!cid.length) { jsonError(res, 400, "clientId required"); return; }
    try redis.getDb().hdel(RedisKeys.bncSeen(id.toString()), cid);
    catch (Exception e) { jsonError(res, 500, "hdel failed: " ~ e.msg); return; }
    auto out_ = Json.emptyObject;
    out_["networkId"] = id.toString();
    out_["clientId"] = cid;
    jsonOk(res, out_);
}
