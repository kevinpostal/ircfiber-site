module ircfiber.web.admin.api;

import std.uuid : UUID, parseUUID, randomUUID;
import std.string : strip, split, join, indexOf, startsWith, lastIndexOf, toLower, replace;
import std.algorithm : canFind, filter, map;
import std.array : array;
import std.conv : to;
import std.datetime : Clock;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.auth : hashPassword;
import ircfiber.web.common : getClientIp;
import ircfiber.db.user : UserRepository;
import ircfiber.db.network : NetworkRepository;
import ircfiber.db.uploads : UploadRepository;
import ircfiber.models.network : NetworkConfig;
import ircfiber.models.user : User;
import ircfiber.irc.registry : ServerRegistry;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.storage.session : RedisSessionStore;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody, formString, jsonArray, stripJsonStr;
import ircfiber.web.admin.servers : AssignmentRow, loadNetworkSnapshot;
import ircfiber.redis.protocol : NetworkStateSnapshot, RedisKeys, ControlMessage;

/// Escape a string for JSON output
private string escapeJson(string s) {
    return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
}

/// GET /api/admin/me — current admin user (id, username, email, roles).
package void apiMe(HTTPServerRequest req, HTTPServerResponse res) {
    try {
        auto user = req.context["user"].get!User;
        if (user.username.length == 0) {
            jsonError(res, 401, "Not authenticated");
            return;
        }
        Json data = Json.emptyObject;
        data["id"] = Json(user.id.toString());
        data["username"] = Json(user.username);
        data["email"] = Json(user.email);
        data["roles"] = jsonArray(user.roles);
        data["isAdmin"] = Json(user.roles.canFind("admin"));
        jsonOk(res, data);
    } catch (Exception e) {
        import std.string : replace;
        logWarn("apiMe failed: %s", e.msg);
        jsonError(res, 500, e.msg);
    }
}

/// GET /api/admin/dashboard — KPIs + host summary + recent activity.
package void apiDashboard(HTTPServerRequest, HTTPServerResponse res,
                          RedisStorage redis, ServerRegistry serverRegistry) {
    auto repo = new UserRepository();
    auto userCount = repo.count();
    auto recentUsers = repo.findAll(10, 0);

    // Active sessions
    long activeSessions;
    try {
        auto db = redis.getDb();
        auto keys = db.keys("session:*");
        foreach (_; keys) activeSessions++;
    } catch (Exception) { activeSessions = -1; }

    // Uploads
    long uploadCount;
    try {
        auto uploadRepo = new UploadRepository();
        uploadCount = uploadRepo.countAll();
    } catch (Exception) { uploadCount = -1; }

    // Engines + networks
    auto allServers = serverRegistry.getAllServers();
    auto healthyServers = serverRegistry.getHealthyServers();
    int totalNetworks;
    foreach (s; allServers) totalNetworks += cast(int) s.assignedNetworks.length;
    int engineCount = cast(int) allServers.length;
    int healthyCount = cast(int) healthyServers.length;
    auto hostSummary = serverRegistry.getHostConnectionSummary();
    auto maxConns = serverRegistry.getMaxConnsPerHost();

    Json data = Json.emptyObject;
    data["userCount"] = Json(userCount);
    data["activeSessions"] = Json(activeSessions);
    data["totalNetworks"] = Json(totalNetworks);
    data["uploadCount"] = Json(uploadCount);
    data["engineCount"] = Json(engineCount);
    data["healthyCount"] = Json(healthyCount);
    data["maxConnsPerHost"] = Json(maxConns);

    // Engines detail
    Json[] engArr;
    foreach (s; allServers) {
        auto cfg = serverRegistry.getEngineConfig(s.serverId);
        Json e = Json.emptyObject;
        e["serverId"] = Json(s.serverId);
        e["bindAddress"] = Json(s.bindAddress);
        e["port"] = Json(s.port);
        e["priority"] = Json(cfg.priority != 0 ? cfg.priority : s.priority);
        e["maxConnections"] = Json(cfg.maxConnections != 0 ? cfg.maxConnections : s.maxConnections);
        e["fallbackOnly"] = Json(cfg.fallbackOnly);
        e["assignedNetworkCount"] = Json(cast(long) s.assignedNetworks.length);
        bool healthy = false;
        foreach (h; healthyServers) if (h.serverId == s.serverId) { healthy = true; break; }
        e["healthy"] = Json(healthy);
        const long nowMs = Clock.currTime.toUnixTime!long * 1000L;
        e["lastHeartbeat"] = Json(s.lastHeartbeat);
        e["ageSeconds"] = Json((nowMs - s.lastHeartbeat) / 1000);
        engArr ~= e;
    }
    data["engines"] = Json(engArr);

    // Host summary
    Json[] hostArr;
    foreach (hcs; hostSummary) {
        Json h = Json.emptyObject;
        h["host"] = Json(hcs.host);
        h["totalConns"] = Json(hcs.totalConns);
        h["serverIds"] = jsonArray(hcs.serverIds);
        // irc.ircfiber.com is our first-party IRCd — no per-IP ban limit,
        // so the admin should never show it as "full". Treat as unlimited
        // (capacity 0 → frontend renders ∞) and always safe.
        bool isUnlimited = hcs.host.toLower() == "irc.ircfiber.com";
        if (isUnlimited) {
            h["capacity"] = Json(0);
            h["status"] = Json("safe");
        } else {
            long cap = cast(long) maxConns * cast(long) hcs.serverIds.length;
            h["capacity"] = Json(cap);
            if (cap > 0 && hcs.totalConns >= cap) h["status"] = Json("full");
            else if (cap > 0 && hcs.totalConns >= cap * 2 / 3) h["status"] = Json("warn");
            else h["status"] = Json("safe");
        }
        hostArr ~= h;
    }
    data["hosts"] = Json(hostArr);

    // Recent users (light)
    Json[] usersArr;
    foreach (u; recentUsers) {
        Json u2 = Json.emptyObject;
        u2["id"] = Json(u.id.toString());
        u2["username"] = Json(u.username);
        u2["email"] = Json(u.email);
        u2["roles"] = jsonArray(u.roles);
        usersArr ~= u2;
    }
    data["recentUsers"] = Json(usersArr);

    jsonOk(res, data);
}

// ────────────────────────────────────────────────────────────
// Servers API
// ────────────────────────────────────────────────────────────

/// GET /api/admin/servers — engines + assignments + host routing.
package void apiServers(HTTPServerRequest, HTTPServerResponse res,
                        RedisStorage redis, ServerRegistry serverRegistry) {
    auto allServers = serverRegistry.getAllServers();
    auto healthyServers = serverRegistry.getHealthyServers();
    auto hostSummary = serverRegistry.getHostConnectionSummary();
    auto maxConns = serverRegistry.getMaxConnsPerHost();
    auto rawAssignments = serverRegistry.getAllAssignments();

    // Apply saved config overrides to the displayed engines
    foreach (ref s; allServers) {
        const cfg = serverRegistry.getEngineConfig(s.serverId);
        if (cfg.priority != 0) s.priority = cfg.priority;
        if (cfg.maxConnections != 0) s.maxConnections = cfg.maxConnections;
        s.fallbackOnly = cfg.fallbackOnly;
    }

    AssignmentRow[] assignments;
    NetworkRepository netRepo;
    UserRepository userRepo;
    try netRepo = new NetworkRepository();
    catch (Exception e) { logWarn("Could not open NetworkRepository: %s", e.msg); }
    try userRepo = new UserRepository();
    catch (Exception e) { logWarn("Could not open UserRepository: %s", e.msg); }

    foreach (a; rawAssignments) {
        AssignmentRow row;
        row.networkId = a.networkId;
        row.serverId = a.serverId;
        if (netRepo) {
            try {
                auto netId = parseUUID(a.networkId.idup);
                auto nw = netRepo.findByIdWithUser(netId);
                if (nw.config.id != UUID.init) {
                    row.networkName = nw.config.name.length > 0 ? nw.config.name : nw.config.host;
                    row.networkHost = nw.config.host;
                    row.egressNodeId = nw.config.egressNodeId;
                    if (userRepo && nw.userId != UUID.init) {
                        try {
                            const u = userRepo.findById(nw.userId);
                            if (u.username.length > 0) {
                                row.userId = nw.userId.toString();
                                row.username = u.username;
                            }
                        } catch (Exception) {}
                    }
                }
            } catch (Exception) {}
        }
        // admins can see which IRC identity is in use on this server.
        // Falls back to the configured nick when the engine hasn't
        // reported yet, and stays empty when the network is offline.
        try {
            const snap = loadNetworkSnapshot(redis, a.networkId);
            if (snap.currentNick.length > 0) {
                row.nick = snap.currentNick;
            } else if (netRepo) {
                try {
                    auto netId = parseUUID(a.networkId.idup);
                    const nw = netRepo.findByIdWithUser(netId);
                    if (nw.config.id != UUID.init && nw.config.nick.length > 0) {
                        row.nick = nw.config.nick;
                    }
                } catch (Exception) {}
            }
            row.activeEgressLabel = snap.activeEgressLabel;
            row.activeEgressHost = snap.activeEgressHost;
            row.activeEgressIp = snap.activeEgressIp;
            row.peerIp = snap.peerIp;
            row.localIp = snap.localIp;
        } catch (Exception) {}
        assignments ~= row;
    }
    Json data = Json.emptyObject;
    Json[] engArr;
    foreach (s; allServers) {
        bool healthy = false;
        foreach (h; healthyServers) if (h.serverId == s.serverId) { healthy = true; break; }
        Json e = Json.emptyObject;
        e["serverId"] = Json(s.serverId);
        e["port"] = Json(s.port);
        e["priority"] = Json(s.priority);
        e["maxConnections"] = Json(s.maxConnections);
        e["fallbackOnly"] = Json(s.fallbackOnly);
        e["assignedNetworks"] = jsonArray(s.assignedNetworks);
        e["healthy"] = Json(healthy);
        e["lastHeartbeat"] = Json(s.lastHeartbeat);
        const long nowMs = Clock.currTime.toUnixTime!long * 1000L;
        e["ageSeconds"] = Json((nowMs - s.lastHeartbeat) / 1000);
        engArr ~= e;
    }
    data["engines"] = Json(engArr);
    data["maxConnsPerHost"] = Json(maxConns);

    Json[] hostArr;
    foreach (hcs; hostSummary) {
        Json h = Json.emptyObject;
        h["host"] = Json(hcs.host);
        h["totalConns"] = Json(hcs.totalConns);
        h["serverIds"] = jsonArray(hcs.serverIds);
        hostArr ~= h;
    }
    data["hosts"] = Json(hostArr);
    Json[] assignArr;
    foreach (a; assignments) {
        Json j = Json.emptyObject;
        j["networkId"] = Json(a.networkId);
        j["serverId"] = Json(a.serverId);
        j["networkName"] = Json(a.networkName);
        j["networkHost"] = Json(a.networkHost);
        j["userId"] = Json(a.userId);
        j["username"] = Json(a.username);
        j["nick"] = Json(a.nick);
        j["egressNodeId"] = Json(a.egressNodeId);
        j["activeEgressLabel"] = Json(a.activeEgressLabel);
        j["activeEgressHost"] = Json(a.activeEgressHost);
        j["activeEgressIp"] = Json(a.activeEgressIp);
        j["peerIp"] = Json(a.peerIp);
        j["localIp"] = Json(a.localIp);
        assignArr ~= j;
    }
    data["assignments"] = Json(assignArr);

    jsonOk(res, data);
}



/// GET /api/admin/servers/host/:host — host detail.
package void apiServerHost(HTTPServerRequest req, HTTPServerResponse res,
                          RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uni : toLower;
    auto host = req.params["host"];
    auto netRepo = new NetworkRepository();
    auto allNetworks = netRepo.findAll();
    const hostLower = host.toLower();
    auto userRepo = new UserRepository();

    Json[] connArr;
    int[string] serverCounts;
    int liveCount;
    foreach (nw; allNetworks) {
        if (nw.config.host.toLower() != hostLower) continue;
        auto netId = nw.config.id.toString();
        auto user = userRepo.findById(nw.userId);
        auto directSid = serverRegistry.getServerForNetwork(netId);
        auto snapshot = loadNetworkSnapshot(redis, netId);
        bool isBanned = false;
        try isBanned = redis.getDb().exists(RedisKeys.bannedNetwork(netId));
        catch (Exception) {}

        Json c = Json.emptyObject;
        c["networkId"] = Json(netId);
        c["networkName"] = Json(nw.config.name);
        c["host"] = Json(nw.config.host);
        c["userId"] = Json(nw.userId.toString());
        c["username"] = Json(user.username.length > 0 ? user.username : "unknown");
        c["serverId"] = Json(directSid.length > 0 ? directSid : "unassigned");
        c["connected"] = Json(snapshot.connected);
        c["status"] = Json(snapshot.status.length > 0
            ? snapshot.status
            : (snapshot.connected ? "connected" : "offline"));
        c["nick"] = Json(snapshot.currentNick.length > 0 ? snapshot.currentNick : nw.config.nick);
        c["isBanned"] = Json(isBanned);
        c["disabled"] = Json(nw.config.disabled);
        connArr ~= c;

        auto sc = directSid in serverCounts;
        if (sc) (*sc)++;
        else serverCounts[directSid] = 1;
        if (snapshot.connected) liveCount++;
    }

    Json data = Json.emptyObject;
    data["host"] = Json(host);
    data["connections"] = Json(connArr);
    data["liveCount"] = Json(liveCount);
    Json counts = Json.emptyObject;
    foreach (sid, count; serverCounts) counts[sid] = Json(count);
    data["serverCounts"] = counts;
    jsonOk(res, data);
}

/// POST /api/admin/servers/:id/reassign — reassign all networks on engine.
package void apiReassignServer(HTTPServerRequest req, HTTPServerResponse res,
                              ServerRegistry serverRegistry) {
    auto serverId = req.params["id"];
    auto networks = serverRegistry.getNetworksForServer(serverId);
    int reassigned;
    foreach (netId; networks) {
        try {
            serverRegistry.reassignNetwork(netId);
            reassigned++;
        } catch (Exception e) {
            logWarn("Failed to reassign network %s: %s", netId, e.msg);
        }
    }
    Json data = Json.emptyObject;
    data["reassigned"] = Json(reassigned);
    data["total"] = Json(cast(long) networks.length);
    data["serverId"] = Json(serverId);
    jsonOk(res, data);
}

/// POST /api/admin/servers/assignments/:networkId/reassign — move one network.
package void apiReassignAssignment(HTTPServerRequest req, HTTPServerResponse res,
                                   ServerRegistry serverRegistry) {
    auto networkId = req.params["networkId"];
    try {
        auto newSid = serverRegistry.reassignNetwork(networkId);
        Json data = Json.emptyObject;
        data["networkId"] = Json(networkId);
        data["newServerId"] = Json(newSid);
        jsonOk(res, data);
    } catch (Exception e) {
        jsonError(res, 500, e.msg);
    }
}

/// POST /api/admin/servers/assignments/:networkId/remove — clear assignment.
package void apiRemoveAssignment(HTTPServerRequest req, HTTPServerResponse res,
                                RedisStorage redis, ServerRegistry serverRegistry) {
    import std.algorithm : filter;
    auto networkId = req.params["networkId"];
    auto oldServerId = serverRegistry.getServerForNetwork(networkId);
    if (oldServerId.length > 0) {
        try {
            auto srv = serverRegistry.getServer(oldServerId);
            srv.assignedNetworks = srv.assignedNetworks
                .filter!(n => n != networkId)
                .array;
            redis.hset(RedisKeys.server(oldServerId), "data", srv.toJson().toString());
        } catch (Exception e) {
            logWarn("Remove-assignment: could not update server %s: %s", oldServerId, e.msg);
        }
    }
    auto db = redis.getDb();
    db.hdel(RedisKeys.networkAssignments(), networkId);
    db.del(RedisKeys.networkFail(networkId));
    db.del(RedisKeys.lease(networkId));
    Json data = Json.emptyObject;
    data["networkId"] = Json(networkId);
    data["wasOn"] = Json(oldServerId);
    jsonOk(res, data);
}

/// POST /api/admin/servers/:id/config — set engine priority/cap/fallback.
package void apiEngineConfig(HTTPServerRequest req, HTTPServerResponse res,
                            ServerRegistry serverRegistry) {
    import std.conv : to;
    auto serverId = req.params["id"];
    auto body = readJsonBody(req);
    try {
        auto priority = body["priority"].get!int;
        auto maxConns = body["maxConnections"].get!int;
        auto fallback = body["fallbackOnly"].get!bool;
        serverRegistry.setEngineConfig(serverId, priority, maxConns, fallback);
        Json data = Json.emptyObject;
        data["serverId"] = Json(serverId);
        data["priority"] = Json(priority);
        data["maxConnections"] = Json(maxConns);
        data["fallbackOnly"] = Json(fallback);
        jsonOk(res, data);
    } catch (Exception e) {
        jsonError(res, 400, e.msg);
    }
}

/// POST /api/admin/servers/host/:host/disconnect/:networkId
package void apiHostDisconnect(HTTPServerRequest req, HTTPServerResponse res,
                              RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uuid : parseUUID, UUID;
    auto networkId = req.params["networkId"];
    auto netRepo = new NetworkRepository();
    auto netId = parseUUID(networkId);
    auto owner = netRepo.findByIdWithUser(netId);
    netRepo.setDisabled(netId, true);
    if (owner.userId != UUID.init)
        redis.del(RedisKeys.userNetworks(owner.userId.toString()));
    auto serverId = serverRegistry.getServerForNetwork(networkId);
    const bool engineHealthy = serverId.length > 0 && serverRegistry.isServerHealthy(serverId);
    if (engineHealthy) {
        auto msg = ControlMessage("disconnectNetwork", networkId);
        msg.reason = "Disconnected by admin";
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    }
    Json data = Json.emptyObject;
    data["networkId"] = Json(networkId);
    data["engineHealthy"] = Json(engineHealthy);
    jsonOk(res, data);
}

/// POST /api/admin/servers/host/:host/reconnect/:networkId
package void apiHostReconnect(HTTPServerRequest req, HTTPServerResponse res,
                             RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uuid : parseUUID, UUID;
    auto networkIdStr = req.params["networkId"];
    auto networkId = parseUUID(networkIdStr);
    auto netRepo = new NetworkRepository();
    auto owner = netRepo.findByIdWithUser(networkId);
    netRepo.setDisabled(networkId, false);
    if (owner.userId != UUID.init)
        redis.del(RedisKeys.userNetworks(owner.userId.toString()));
    auto cfg = netRepo.findById(networkId);
    if (cfg.name.length == 0) { jsonError(res, 404, "Network not found"); return; }

    auto allNetworks = netRepo.findAll();
    string ownerId;
    foreach (nw; allNetworks) {
        if (nw.config.id == networkId) { ownerId = nw.userId.toString(); break; }
    }
    auto serverId = serverRegistry.getServerForNetwork(networkIdStr);
    if (serverId.length == 0 || !serverRegistry.isServerHealthy(serverId)) {
        serverId = serverRegistry.reassignNetwork(networkIdStr);
    }
    if (serverId.length > 0) {
        auto msg = ControlMessage("reconnectNetwork", networkIdStr, ownerId, cfg.toJson());
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    }
    Json data = Json.emptyObject;
    data["networkId"] = Json(networkIdStr);
    data["serverId"] = Json(serverId);
    jsonOk(res, data);
}

/// Core network deletion — stops the engine client, scrubs Redis state,
/// drops the Mongo record, and clears the per-server assignedNetworks
/// array. Host-agnostic so both the form-based host-detail path
/// (`apiHostDeleteNetwork`) and the SPA's assignment-table path
/// (`apiAssignmentDelete`) share one code path. Validates the networkId
/// is a UUID unless `allowEmpty` is set, which is used by the SPA's
/// "Delete" button to scrub the orphan-empty-string entry from the
/// server record (no Mongo row to delete, no UUID to parse).
private void deleteNetworkCore(HTTPServerRequest, HTTPServerResponse res,
                                RedisStorage redis, ServerRegistry serverRegistry,
                                string networkIdStr, bool allowEmpty) {
    import std.uuid : parseUUID, UUID;
    bool isEmptyOrInvalid = networkIdStr.length == 0;
    UUID networkId = UUID.init;
    if (!isEmptyOrInvalid) {
        try networkId = parseUUID(networkIdStr.idup);
        catch (Exception e) {
            if (!allowEmpty) { jsonError(res, 400, "Invalid network id: " ~ e.msg); return; }
            isEmptyOrInvalid = true;
        }
        if (networkId == UUID.init) isEmptyOrInvalid = true;
    }
    if (isEmptyOrInvalid && !allowEmpty) {
        jsonError(res, 400, "networkId is required");
        return;
    }

    auto db = redis.getDb();
    auto netRepo = new NetworkRepository();
    NetworkConfig cfg;
    if (!isEmptyOrInvalid) cfg = netRepo.findById(networkId);

    string serverId = "";

    // Tell the engine to stop the client. Skip when the networkId is
    // empty or invalid — there's no client to stop, only a stale
    // entry to scrub from the server record + per-engine mirror.
    if (!isEmptyOrInvalid) {
        auto msg = ControlMessage("removeNetwork", networkIdStr);
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        if (serverId.length > 0) redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
        else redis.lpush(RedisKeys.control_legacy(), msg.toJson().toString());
    }

    // Persisted cleanup — only meaningful for real networkIds.
    if (!isEmptyOrInvalid && cfg.name.length > 0) {
        // Capture owner userId before deleting, for cache invalidation.
        auto owner = netRepo.findByIdWithUser(networkId);
        netRepo.deleteById(networkId);
        if (owner.userId != UUID.init)
            redis.del(RedisKeys.userNetworks(owner.userId.toString()));
        if (serverId.length > 0) db.del(RedisKeys.state(serverId, networkIdStr));
        db.del(RedisKeys.state_legacy(networkIdStr));
        db.del(RedisKeys.networkFail(networkIdStr));
        db.del(RedisKeys.bannedNetwork(networkIdStr));
    }

    // Always-on Redis cleanup, even for empty networkIds.
    db.hdel(RedisKeys.networkAssignments(), networkIdStr);
    if (serverId.length > 0) {
        // Strip the id from the server record AND the per-engine mirror.
        // Both must be updated because the engine's heartbeat reads from
        // the mirror and the gateway's per-server query reads from the
        // server record. A "Remove" call without these two updates is
        // what produced the original orphan — the engine kept re-asserting
        // the empty entry every heartbeat because the mirror still held it.
        try {
            auto srv = serverRegistry.getServer(serverId);
            const before = srv.assignedNetworks.length;
            srv.assignedNetworks = srv.assignedNetworks
                .filter!(n => n != networkIdStr)
                .array;
            if (srv.assignedNetworks.length != before) {
                db.hset(RedisKeys.server(serverId), "data", srv.toJson().toString());
                db.hdel(RedisKeys.serverAssignments(serverId), networkIdStr);
            }
        } catch (Exception e) {
            logWarn("deleteNetworkCore: scrub server %s assignedNetworks failed for %s: %s",
                serverId, networkIdStr, e.msg);
        }
    } else {
        // No canonical assignment or serverId unknown (hget skipped to avoid t123 bug) — walk every server.
        // server record. Best-effort: walk every healthy server and strip
        // matching ids from both the record and the mirror.
        foreach (sid; serverRegistry.getAllServers().map!(s => s.serverId)) {
            try {
                auto srv = serverRegistry.getServer(sid);
                const before = srv.assignedNetworks.length;
                srv.assignedNetworks = srv.assignedNetworks
                    .filter!(n => n != networkIdStr)
                    .array;
                if (srv.assignedNetworks.length != before) {
                    db.hset(RedisKeys.server(sid), "data", srv.toJson().toString());
                    db.hdel(RedisKeys.serverAssignments(sid), networkIdStr);
                }
            } catch (Exception e) {
                logWarn("deleteNetworkCore: orphan-scrub on %s failed: %s", sid, e.msg);
            }
        }
    }
    Json data = Json.emptyObject;
    data["networkId"] = Json(networkIdStr);
    data["serverId"] = Json(serverId);
    data["scrubbed"] = Json(true);
    jsonOk(res, data);
}
/// POST /api/admin/servers/host/:host/delete-network/:networkId
package void apiHostDeleteNetwork(HTTPServerRequest req, HTTPServerResponse res,
                                  RedisStorage redis, ServerRegistry serverRegistry) {
    deleteNetworkCore(req, res, redis, serverRegistry, req.params["networkId"], false);
}

/// POST /api/admin/servers/assignments/:networkId/delete
/// Full delete (Mongo + Redis + engine stop + buffer scrub) reachable
/// directly from the main #/servers assignment table — no host detail
/// navigation required. Also handles the empty/invalid-id case so an
/// operator can clear a stale "ghost" row that lingers in the engine's
package void apiAssignmentDelete(HTTPServerRequest req, HTTPServerResponse res,
                                 RedisStorage redis, ServerRegistry serverRegistry) {
    string nid = "";
    if (auto p = "networkId" in req.params) nid = *p;
    if (nid.length == 0) {
        try {
            auto body = readJsonBody(req);
            if (body.type == Json.Type.object) {
                if (body["networkId"].type == Json.Type.string) nid = body["networkId"].get!string;
                else if (body["networkId"].type != Json.Type.undefined) nid = body["networkId"].toString();
                if (nid.length == 0 && body["networkIdStr"].type == Json.Type.string) nid = body["networkIdStr"].get!string;
                if (nid.length == 0 && body["id"].type == Json.Type.string) nid = body["id"].get!string;
            }
        } catch (Exception) {}
        if (nid.length == 0) {
            auto q = "networkId" in req.query;
            if (q) nid = *q;
            else {
                auto q2 = "id" in req.query;
                if (q2) nid = *q2;
            }
        }
    }
    deleteNetworkCore(req, res, redis, serverRegistry, nid.idup, true);
}
/// POST /api/admin/routing — set global maxConnsPerHost.
package void apiRouting(HTTPServerRequest req, HTTPServerResponse res,
                       ServerRegistry serverRegistry) {
    auto body = readJsonBody(req);
    try {
        auto maxConns = body["maxConnsPerHost"].get!int;
        serverRegistry.setMaxConnsPerHost(maxConns);
        Json data = Json.emptyObject;
        data["maxConnsPerHost"] = Json(maxConns);
        jsonOk(res, data);
    } catch (Exception e) {
        jsonError(res, 400, e.msg);
    }
}

// ────────────────────────────────────────────────────────────
// Fiber auto-connect toggle — GET + POST /api/admin/config/fiber
// ────────────────────────────────────────────────────────────

/// GET /api/admin/config/fiber — returns {enabled, fiberNetworkCount, disabledCount}
package void apiFiberConfig(HTTPServerRequest req, HTTPServerResponse res,
                            RedisStorage redis) {
    import ircfiber.default_network : isFiberEnabled, FIBER_ENABLED_KEY, DEFAULT_FIBER_HOST;
    bool enabled = true;
    try enabled = isFiberEnabled(redis);
    catch (Exception) {}
    int total = 0, disabled = 0;
    try {
        auto netRepo = new NetworkRepository();
        auto all = netRepo.findAll();
        foreach (nw; all) {
            if (nw.config.host == DEFAULT_FIBER_HOST) {
                total++;
                if (nw.config.disabled) disabled++;
            }
        }
    } catch (Exception e) {
        logWarn("apiFiberConfig count failed: %s", e.msg);
    }
    Json data = Json.emptyObject;
    data["enabled"] = Json(enabled);
    data["key"] = Json(FIBER_ENABLED_KEY);
    data["fiberNetworkCount"] = Json(total);
    data["disabledCount"] = Json(disabled);
    jsonOk(res, data);
}

/// POST /api/admin/config/fiber — {enabled: bool} bulk enable/disable Fiber networks
package void apiFiberConfigSet(HTTPServerRequest req, HTTPServerResponse res,
                               RedisStorage redis, ServerRegistry serverRegistry) {
    import ircfiber.default_network : isFiberEnabled, setFiberEnabled, DEFAULT_FIBER_HOST;
    auto body = readJsonBody(req);
    bool enabled;
    try {
        enabled = body["enabled"].get!bool;
    } catch (Exception e) {
        jsonError(res, 400, "enabled boolean required");
        return;
    }
    bool prev = true;
    try prev = isFiberEnabled(redis);
    catch (Exception) {}
    setFiberEnabled(redis, enabled);
    int total = 0, changed = 0, skipped = 0;
    string[] errors;
    try {
        auto netRepo = new NetworkRepository();
        auto all = netRepo.findAll();
        foreach (nw; all) {
            if (nw.config.host != DEFAULT_FIBER_HOST) continue;
            total++;
            if (enabled) {
                // Enable: clear disabled flag and re-assign/reconnect
                if (!nw.config.disabled) { skipped++; continue; }
                try {
                    netRepo.setDisabled(nw.config.id, false);
                    if (nw.userId != typeof(nw.userId).init)
                        redis.del(RedisKeys.userNetworks(nw.userId.toString()));
                    // Re-assign if needed and push reconnect
                    auto nid = nw.config.id.toString();
                    auto ownerId = nw.userId.toString();
                    auto sid = serverRegistry.getServerForNetwork(nid);
                    if (sid.length == 0 || !serverRegistry.isServerHealthy(sid))
                        sid = serverRegistry.reassignNetwork(nid);
                    if (sid.length > 0) {
                        auto cfg = netRepo.findById(nw.config.id);
                        auto msg = ControlMessage("reconnectNetwork", nid, ownerId, cfg.toJson());
                        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                        redis.lpush(RedisKeys.control(sid), msg.toJson().toString());
                    }
                    changed++;
                } catch (Exception e) {
                    errors ~= nw.config.id.toString() ~ ": " ~ e.msg;
                }
            } else {
                // Disable: set disabled and disconnect
                if (nw.config.disabled) { skipped++; continue; }
                try {
                    netRepo.setDisabled(nw.config.id, true);
                    if (nw.userId != typeof(nw.userId).init)
                        redis.del(RedisKeys.userNetworks(nw.userId.toString()));
                    auto sid = serverRegistry.getServerForNetwork(nw.config.id.toString());
                    if (sid.length > 0 && serverRegistry.isServerHealthy(sid)) {
                        auto msg = ControlMessage("disconnectNetwork", nw.config.id.toString());
                        msg.reason = "Fiber auto-connect disabled by admin";
                        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                        redis.lpush(RedisKeys.control(sid), msg.toJson().toString());
                    }
                    changed++;
                } catch (Exception e) {
                    errors ~= nw.config.id.toString() ~ ": " ~ e.msg;
                }
            }
        }
    } catch (Exception e) {
        logWarn("apiFiberConfigSet bulk failed: %s", e.msg);
        jsonError(res, 500, e.msg);
        return;
    }
    Json data = Json.emptyObject;
    data["enabled"] = Json(enabled);
    data["prevEnabled"] = Json(prev);
    data["total"] = Json(total);
    data["changed"] = Json(changed);
    data["skipped"] = Json(skipped);
    if (errors.length > 0) data["errors"] = jsonArray(errors);
    jsonOk(res, data);
}

// ────────────────────────────────────────────────────────────
// Users API
// ────────────────────────────────────────────────────────────
package void apiUsersList(HTTPServerRequest req, HTTPServerResponse res) {
    auto repo = new UserRepository();
    auto q = formString(req, "q");
    User[] users;
    if (q.length > 0) users = repo.search(q, 200);
    else users = repo.findAll(200, 0);
    Json[] arr;
    foreach (u; users) {
        Json u2 = Json.emptyObject;
        u2["id"] = Json(u.id.toString());
        u2["username"] = Json(u.username);
        u2["email"] = Json(u.email);
        u2["roles"] = jsonArray(u.roles);
        u2["createdAt"] = Json(u.createdAt.toUnixTime());
        u2["signupIp"] = Json(u.signupIp);
        arr ~= u2;
    }
    Json data = Json.emptyObject;
    data["users"] = Json(arr);
    data["count"] = Json(cast(long) users.length);
    jsonOk(res, data);
}

/// POST /api/admin/users — create user.
package void apiUserCreate(HTTPServerRequest req, HTTPServerResponse res) {
    auto body = readJsonBody(req);
    try {
        auto username = body["username"].get!string.strip();
        auto email = body["email"].get!string.strip();
        auto password = body["password"].get!string.strip();
        if (username.length == 0 || email.length == 0 || password.length == 0)
            throw new Exception("All fields are required");

        auto repo = new UserRepository();
        const existing = repo.findByUsername(username);
        if (existing.username.length > 0) throw new Exception("Username already taken");

        User u;
        u.id = randomUUID();
        u.username = username;
        u.email = email;
        u.passwordHash = hashPassword(password);
        u.roles = ["user"];
        u.signupIp = getClientIp(req);
        u.createdAt = Clock.currTime;
        repo.create(u);
        Json data = Json.emptyObject;
        data["id"] = Json(u.id.toString());
        data["username"] = Json(u.username);
        jsonOk(res, data);
    } catch (Exception e) {
        jsonError(res, 400, e.msg);
    }
}

/// GET /api/admin/users/:id
package void apiUserDetail(HTTPServerRequest req, HTTPServerResponse res,
                          RedisStorage redis) {
    import std.uuid : parseUUID;
    auto id = parseUUID(req.params["id"]);
    auto repo = new UserRepository();
    auto user = repo.findById(id);
    if (user.username.length == 0) { jsonError(res, 404, "User not found"); return; }

    auto netRepo = new NetworkRepository();
    auto networks = netRepo.findByUserId(user.id);
    auto uploadRepo = new UploadRepository();
    auto uploads = uploadRepo.listAllByUser(user.id.toString());
    auto uploadCount = uploadRepo.countAllByUser(user.id.toString());

    Json data = Json.emptyObject;
    data["id"] = Json(user.id.toString());
    data["username"] = Json(user.username);
    data["email"] = Json(user.email);
    data["roles"] = jsonArray(user.roles);
    data["signupIp"] = Json(user.signupIp);
    data["lastLoginIp"] = Json(user.lastLoginIp);
    data["loginIps"] = jsonArray(user.loginIps);
    data["createdAt"] = Json(user.createdAt.toUnixTime());
    data["uploadCount"] = Json(uploadCount);

    Json[] netArr;
    foreach (net; networks) {
        Json n = Json.emptyObject;
        n["id"] = Json(net.id.toString());
        n["name"] = Json(net.name);
        n["host"] = Json(net.host);
        n["port"] = Json(net.port);
        n["disabled"] = Json(net.disabled);
        n["nick"] = Json(net.nick);
        n["autoJoinChannels"] = jsonArray(net.autoJoinChannels);
        n["tls"] = Json(net.tls.to!string);
        n["sasl"] = Json(net.sasl.to!string);
        auto snap = loadNetworkSnapshot(redis, net.id.toString());
        n["connected"] = Json(snap.connected);
        n["currentNick"] = Json(snap.currentNick);
        netArr ~= n;
    }
    data["networks"] = Json(netArr);

    Json[] upArr;
    foreach (upload; uploads) {
        Json u2 = Json.emptyObject;
        u2["id"] = Json(upload.id);
        u2["filename"] = Json(upload.filename);
        u2["buffer"] = Json(upload.buffer);
        u2["mimeType"] = Json(upload.mimeType);
        u2["size"] = Json(upload.size);
        u2["directUrl"] = Json(upload.directUrl);
        u2["createdAt"] = Json(upload.createdAt);
        upArr ~= u2;
    }
    data["uploads"] = Json(upArr);

    jsonOk(res, data);
}

/// Built-in roles the backend gives meaning to. `admin` is the only role
/// checked by `ircfiber.auth.isAdmin`; `user` is the default every account
/// carries. Anything else found in the DB is a custom label and is listed
/// (with its user count) so the admin UI can offer it without free typing.
private immutable string[2][] BUILTIN_ROLES = [
    ["admin", "Full access to the admin panel, impersonation and every /api/admin route."],
    ["user",  "Default role. Can log in, add networks and chat."],
];

/// Lower-cases, trims, drops empties and duplicates; keeps first-seen order.
private string[] normalizeRoles(string[] raw) {
    string[] outp;
    foreach (r; raw) {
        auto c = r.strip().toLower();
        if (c.length == 0 || outp.canFind(c)) continue;
        outp ~= c;
    }
    return outp;
}

/// GET /api/admin/roles — role catalogue for the user editor.
/// `{roles:[{name, description, builtin, users}]}`, built-ins first.
package void apiRolesList(HTTPServerRequest req, HTTPServerResponse res) {
    auto repo = new UserRepository();
    long[string] counts;
    foreach (u; repo.findAll(10_000, 0)) {
        foreach (r; normalizeRoles(u.roles)) counts[r] = counts.get(r, 0) + 1;
    }
    Json[] arr;
    foreach (b; BUILTIN_ROLES) {
        Json j = Json.emptyObject;
        j["name"] = Json(b[0]);
        j["description"] = Json(b[1]);
        j["builtin"] = Json(true);
        j["users"] = Json(counts.get(b[0], 0));
        arr ~= j;
        counts.remove(b[0]);
    }
    import std.algorithm : sort;
    auto extra = counts.keys;
    extra.sort();
    foreach (name; extra) {
        Json j = Json.emptyObject;
        j["name"] = Json(name);
        j["description"] = Json("Custom role (not checked by the backend).");
        j["builtin"] = Json(false);
        j["users"] = Json(counts[name]);
        arr ~= j;
    }
    Json data = Json.emptyObject;
    data["roles"] = Json(arr);
    jsonOk(res, data);
}

/// POST /api/admin/users/:id — update email + roles.
/// Roles are normalised (lower-case, deduped, never empty) and the last
/// remaining admin cannot lose `admin` — same lock-out guard as bulk delete.
package void apiUserUpdate(HTTPServerRequest req, HTTPServerResponse res) {
    import std.uuid : parseUUID;
    auto id = parseUUID(req.params["id"]);
    auto repo = new UserRepository();
    auto user = repo.findById(id);
    if (user.username.length == 0) { jsonError(res, 404, "User not found"); return; }

    auto body = readJsonBody(req);
    try {
        string[] roles;
        if (auto rolesArrPtr = "roles" in body) {
            auto rolesArr = *rolesArrPtr;
            if (rolesArr.type == Json.Type.array) {
                foreach (r; rolesArr) if (r.type == Json.Type.string) roles ~= r.get!string;
            }
        }
        roles = normalizeRoles(roles);
        if (roles.length == 0) roles ~= "user";

        if (user.roles.canFind("admin") && !roles.canFind("admin")) {
            int adminCount;
            foreach (u; repo.findAll(10_000, 0)) if (u.roles.canFind("admin")) adminCount++;
            if (adminCount <= 1) {
                jsonError(res, 400, user.username ~ " is the last admin — grant admin to another account first");
                return;
            }
        }

        user.email = body["email"].get!string.strip();
        user.roles = roles;
        repo.update(user);
        logInfo("Admin updated user: %s (roles: %s)", user.username, user.roles);
        Json data = Json.emptyObject;
        data["id"] = Json(user.id.toString());
        data["username"] = Json(user.username);
        data["email"] = Json(user.email);
        data["roles"] = jsonArray(user.roles);
        jsonOk(res, data);
    } catch (Exception e) {
        jsonError(res, 400, e.msg);
    }
}

/// POST /api/admin/users/:id/delete
package void apiUserDelete(HTTPServerRequest req, HTTPServerResponse res,
                          RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uuid : parseUUID;
    import std.file : remove;
    import std.path : buildPath;
    import ircfiber.upload.local : uploadDir;
    import ircfiber.storage.buffer : BufferManager;

    auto id = parseUUID(req.params["id"]);
    auto userRepo = new UserRepository();
    auto user = userRepo.findById(id);
    if (user.username.length == 0) { jsonError(res, 404, "User not found"); return; }
    logWarn("Admin deleting user via API: %s", user.username);

    auto db = redis.getDb();
    auto netRepo = new NetworkRepository();
    auto bufferManager = new BufferManager(redis);

    auto networks = netRepo.findByUserId(id);
    foreach (net; networks) {
        auto netId = net.id.toString();
        auto serverId = serverRegistry.getServerForNetwork(netId);
        auto msg = ControlMessage("removeNetwork", netId);
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        if (serverId.length > 0) {
            redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
            try { bufferManager.clearNetworkBuffers(serverId, netId); } catch (Exception) {}
        } else {
            redis.lpush(RedisKeys.control_legacy(), msg.toJson().toString());
            try { bufferManager.clearNetworkBuffers(netId); } catch (Exception) {}
        }
        netRepo.deleteById(net.id);
        if (serverId.length > 0) db.del(RedisKeys.state(serverId, netId));
        db.del(RedisKeys.state_legacy(netId));
        db.hdel(RedisKeys.networkAssignments(), netId);
        db.del(RedisKeys.networkFail(netId));
    }
    // Clear sessions via store (uses vibed session APIs)
    try {
        auto store = new RedisSessionStore(redis);
        const targetUid = id.toString();
        foreach (sid; store.listAllSessionIds()) {
            const fields = store.getSessionFields(sid);
            if (fields is null) continue;
            auto uidPtr = "sessionUserId" in fields;
            if (uidPtr) {
                import ircfiber.web.admin.helpers : stripJsonStr;
                if (stripJsonStr(*uidPtr) == targetUid) store.destroy(sid);
            }
        }
    } catch (Exception) {}
    try { db.del("prefs:" ~ id.toString()); } catch (Exception) {}
    // Hard-delete uploads
    try {
        auto uploadRepo = new UploadRepository();
        auto uploads = uploadRepo.listAllByUser(id.toString());
        foreach (upload; uploads) {
            auto url = upload.directUrl.strip;
            auto prefixPos = url.indexOf("/uploads/");
            if (prefixPos != -1) {
                auto filename = url[prefixPos + "/uploads/".length .. $];
                if (filename.length > 0) {
                    try remove(buildPath(uploadDir(), filename));
                    catch (Exception) {}
                }
            }
            try uploadRepo.hardDelete(id.toString(), upload.id);
            catch (Exception) {}
        }
    } catch (Exception) {}

    userRepo.deleteById(id);
    Json data = Json.emptyObject;
    data["deletedUserId"] = Json(id.toString());
    jsonOk(res, data);
}

/// POST /api/admin/users/bulk-delete — delete multiple users by IDs.
/// Body: {ids: string[]} . Skips invalid IDs and the acting admin's own ID.
package void apiUsersBulkDelete(HTTPServerRequest req, HTTPServerResponse res,
                          RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uuid : parseUUID;
    import std.file : remove;
    import std.path : buildPath;
    import ircfiber.upload.local : uploadDir;
    import ircfiber.storage.buffer : BufferManager;
    import ircfiber.models.user : User;

    auto body = readJsonBody(req);
    Json idsJson;
    try idsJson = body["ids"];
    catch (Exception) { jsonError(res, 400, "Missing ids array"); return; }
    if (idsJson.type != Json.Type.array) { jsonError(res, 400, "ids must be an array"); return; }
    if (idsJson.length == 0) { jsonError(res, 400, "No users selected"); return; }
    if (idsJson.length > 100) { jsonError(res, 400, "Too many users selected (max 100)"); return; }

    User currentUser;
    try currentUser = req.context["user"].get!User;
    catch (Exception) {}
    string currentId = currentUser.id != UUID.init ? currentUser.id.toString() : "";

    auto userRepo = new UserRepository();
    auto db = redis.getDb();
    auto netRepo = new NetworkRepository();
    auto bufferManager = new BufferManager(redis);

    int deleted;
    string[] skipped;
    string[] errors;
    foreach (idJson; idsJson) {
        string idStr;
        try idStr = idJson.get!string.strip();
        catch (Exception) { skipped ~= idJson.toString(); continue; }
        if (idStr.length == 0) { skipped ~= idStr; continue; }
        if (idStr == currentId) { skipped ~= idStr ~ " (self)"; continue; }
        UUID id;
        try id = parseUUID(idStr);
        catch (Exception) { skipped ~= idStr ~ " (invalid)"; continue; }
        auto user = userRepo.findById(id);
        if (user.username.length == 0) { skipped ~= idStr ~ " (not found)"; continue; }
        // Safety: prevent deleting last admin — check if target is sole admin and we would leave zero admins
        if (user.roles.canFind("admin")) {
            auto all = userRepo.findAll(1000, 0);
            int adminCount;
            foreach (u; all) if (u.roles.canFind("admin")) adminCount++;
            if (adminCount <= 1) { errors ~= user.username ~ " is last admin — skipped"; continue; }
        }
        logWarn("Admin bulk-deleting user: %s (id=%s)", user.username, id);
        // Reuse single-delete cleanup inline (networks, sessions, prefs, uploads, user)
        try {
            auto networks = netRepo.findByUserId(id);
            foreach (net; networks) {
                auto netId = net.id.toString();
                auto serverId = serverRegistry.getServerForNetwork(netId);
                auto msg = ControlMessage("removeNetwork", netId);
                msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                if (serverId.length > 0) {
                    redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
                    try { bufferManager.clearNetworkBuffers(serverId, netId); } catch (Exception) {}
                } else {
                    redis.lpush(RedisKeys.control_legacy(), msg.toJson().toString());
                    try { bufferManager.clearNetworkBuffers(netId); } catch (Exception) {}
                }
                netRepo.deleteById(net.id);
                if (serverId.length > 0) db.del(RedisKeys.state(serverId, netId));
                db.del(RedisKeys.state_legacy(netId));
                db.hdel(RedisKeys.networkAssignments(), netId);
                db.del(RedisKeys.networkFail(netId));
            }
            // sessions
            try {
                auto store = new RedisSessionStore(redis);
                const targetUid = id.toString();
                foreach (sid; store.listAllSessionIds()) {
                    const fields = store.getSessionFields(sid);
                    if (fields is null) continue;
                    auto uidPtr = "sessionUserId" in fields;
                    if (uidPtr) {
                        if (stripJsonStr(*uidPtr) == targetUid) store.destroy(sid);
                    }
                }
            } catch (Exception) {}
            try { db.del("prefs:" ~ id.toString()); } catch (Exception) {}
            try {
                auto uploadRepo = new UploadRepository();
                auto uploads = uploadRepo.listAllByUser(id.toString());
                foreach (upload; uploads) {
                    auto url = upload.directUrl.strip;
                    auto prefixPos = url.indexOf("/uploads/");
                    if (prefixPos != -1) {
                        auto filename = url[prefixPos + "/uploads/".length .. $];
                        if (filename.length > 0) try remove(buildPath(uploadDir(), filename)); catch (Exception) {}
                    }
                    try uploadRepo.hardDelete(id.toString(), upload.id); catch (Exception) {}
                }
            } catch (Exception) {}
            userRepo.deleteById(id);
            deleted++;
        } catch (Exception e) {
            logWarn("Bulk delete failed for %s: %s", idStr, e.msg);
            errors ~= idStr ~ ": " ~ e.msg;
        }
    }
    Json data = Json.emptyObject;
    data["deleted"] = Json(cast(long) deleted);
    data["skipped"] = jsonArray(skipped);
    data["errors"] = jsonArray(errors);
    jsonOk(res, data);
}

/// POST /api/admin/users/:id/reset-password
package void apiResetPassword(HTTPServerRequest req, HTTPServerResponse res) {
    import std.uuid : parseUUID;
    auto id = parseUUID(req.params["id"]);
    auto body = readJsonBody(req);
    auto repo = new UserRepository();
    auto user = repo.findById(id);
    if (user.username.length == 0) { jsonError(res, 404, "User not found"); return; }
    string newPass = "changeme123";
    try if ("password" in body) newPass = body["password"].get!string.strip();
    catch (Exception) {}
    if (newPass.length == 0) newPass = "changeme123";
    user.passwordHash = hashPassword(newPass);
    repo.update(user);
    Json data = Json.emptyObject;
    data["id"] = Json(user.id.toString());
    data["passwordReset"] = Json(true);
    jsonOk(res, data);
}

// ────────────────────────────────────────────────────────────
// Sessions API
// ────────────────────────────────────────────────────────────

package void apiSessions(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    import ircfiber.web.admin.sessions : SessionInfo;
    SessionInfo[] sessions;
    const long nowMs = Clock.currTime.toUnixTime!long * 1000L;
    string currentSid;
    if (req.session) currentSid = req.session.id;
    auto userRepo = new UserRepository();
    auto store = new RedisSessionStore(redis);

    try {
        auto sessionIds = store.listAllSessionIds();
        foreach (sid; sessionIds) {
            const fields = store.getSessionFields(sid);
            if (fields is null) continue;
            auto uidPtr = "sessionUserId" in fields;
            if (!uidPtr || (*uidPtr).length == 0) continue;
            import ircfiber.web.admin.helpers : stripJsonStr, parseLongField;
            auto uid = stripJsonStr(*uidPtr);
            SessionInfo si;
            si.sessionId = sid;
            si.userId = uid;
            try {
                auto u = userRepo.findById(parseUUID(uid));
                si.username = u.username.length > 0 ? u.username : "unknown";
                si.isAdmin = u.roles.canFind("admin");
                si.roles = u.roles.join(",");
            } catch (Exception) { si.username = "unknown"; si.roles = ""; }

            auto ipPtr = "clientIp" in fields;
            if (ipPtr) si.clientIp = stripJsonStr(*ipPtr);
            auto uaPtr = "userAgent" in fields;
            if (uaPtr) si.userAgent = stripJsonStr(*uaPtr);
            auto caPtr = "createdAt" in fields;
            if (caPtr) si.createdAt = parseLongField(*caPtr);
            auto laPtr = "lastAccess" in fields;
            if (laPtr) si.lastAccess = parseLongField(*laPtr);
            si.ttlSeconds = store.sessionTtl(sid);
            si.isCurrent = currentSid.length > 0 && si.sessionId == currentSid;
            sessions ~= si;
        }
    } catch (Exception e) {
        logWarn("apiSessions read error: %s", e.msg);
    }

    int yourSessions, adminsOnline, idleCount;
    bool[string] seenUsers;
    foreach (s; sessions) {
        if (s.isCurrent) yourSessions++;
        if (s.isAdmin) adminsOnline++;
        if (!(s.userId in seenUsers)) seenUsers[s.userId] = true;
        if (s.lastAccess > 0 && (nowMs - s.lastAccess) > 3600_000L) idleCount++;
    }

    Json data = Json.emptyObject;
    data["total"] = Json(cast(long) sessions.length);
    data["uniqueUsers"] = Json(cast(long) seenUsers.length);
    data["yourSessions"] = Json(yourSessions);
    data["adminsOnline"] = Json(adminsOnline);
    data["idleCount"] = Json(idleCount);
    Json[] arr;
    foreach (s; sessions) {
        Json sj = Json.emptyObject;
        sj["sessionId"] = Json(s.sessionId);
        sj["userId"] = Json(s.userId);
        sj["username"] = Json(s.username);
        sj["clientIp"] = Json(s.clientIp);
        sj["userAgent"] = Json(s.userAgent);
        sj["createdAt"] = Json(s.createdAt);
        sj["lastAccess"] = Json(s.lastAccess);
        sj["ttlSeconds"] = Json(s.ttlSeconds);
        sj["isCurrent"] = Json(s.isCurrent);
        sj["isAdmin"] = Json(s.isAdmin);
        sj["roles"] = Json(s.roles);
        arr ~= sj;
    }
    data["sessions"] = Json(arr);
    jsonOk(res, data);
}

package void apiSessionsClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    const currentUid = req.session.get("sessionUserId", "");
    int cleared;
    auto store = new RedisSessionStore(redis);
    try {
        foreach (sid; store.listAllSessionIds()) {
            const fields = store.getSessionFields(sid);
            if (fields is null) continue;
            auto uidPtr = "sessionUserId" in fields;
            if (uidPtr && stripJsonStr(*uidPtr) == currentUid) continue;
            store.destroy(sid);
            cleared++;
        }
    } catch (Exception e) {
        logWarn("apiSessionsClear error: %s", e.msg);
    }
    Json data = Json.emptyObject;
    data["cleared"] = Json(cleared);
    jsonOk(res, data);
}

package void apiSessionsClearUser(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto targetUid = req.params["uid"];
    int cleared;
    auto store = new RedisSessionStore(redis);
    try {
        foreach (sid; store.listAllSessionIds()) {
            const fields = store.getSessionFields(sid);
            if (fields is null) continue;
            auto uidPtr = "sessionUserId" in fields;
            if (uidPtr && stripJsonStr(*uidPtr) == targetUid) {
                store.destroy(sid);
                cleared++;
            }
        }
    } catch (Exception e) {
        logWarn("apiSessionsClearUser error: %s", e.msg);
    }
    Json data = Json.emptyObject;
    data["cleared"] = Json(cleared);
    data["targetUid"] = Json(targetUid);
    jsonOk(res, data);
}

/// POST /api/admin/sessions/clear-one/:sid
/// Delete a single session by id (one device, leaves the user's other
/// devices logged in). Refuses if the target is the current session —
/// use the explicit logout flow for that instead.
package void apiSessionsClearOne(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto targetSid = req.params["sid"];
    if (targetSid.length == 0 || targetSid.length > 128) {
        jsonError(res, 400, "Invalid session id");
        return;
    }
    string currentSid;
    if (req.session) currentSid = req.session.id;

    if (currentSid.length > 0 && targetSid == currentSid) {
        jsonError(res, 409, "Refusing to clear the current session — use Sign Out");
        return;
    }

    auto store = new RedisSessionStore(redis);
    try {
        const fields = store.getSessionFields(targetSid);
        if (fields is null || fields.length == 0) {
            jsonError(res, 404, "Session not found or already expired");
            return;
        }
        store.destroy(targetSid);
        logInfo("Admin cleared single session %s", targetSid);
    } catch (Exception e) {
        logWarn("apiSessionsClearOne error for %s: %s", targetSid, e.msg);
        jsonError(res, 500, "Internal error clearing session");
        return;
    }
    Json data = Json.emptyObject;
    data["cleared"] = Json(1);
    data["sessionId"] = Json(targetSid);
    jsonOk(res, data);
}

// ────────────────────────────────────────────────────────────
// Mullvad helpers
// ────────────────────────────────────────────────────────────
// Pool string + parser live in ircfiber.egress (shared with the user-facing
// /api/egress and the network create/update validation) so admin and users
// agree on labels. `<name>@host:port` entries carry an explicit label.
import ircfiber.egress : mullvadRawPool, parseMullvadPool, PoolEntry,
    DIRECT_EGRESS_ID, EgressSlot, EgressView, egressView, matchingSlot,
    normalizeEgressId, isKnownEgressId;

private struct _ContainerInfo { string container; string state; string status; string tailscaleExit; }

private _ContainerInfo _collectContainerState(string label) {
    _ContainerInfo ci;
    ci.container = "tailscale-mullvad-" ~ label;
    ci.state = "unknown";
    ci.status = "";
    ci.tailscaleExit = "";
    // k8s: try to get exit IP via SOCKS probe to am.i.mullvad.net (no docker)
    // Use curl --socks5 (not --socks5-hostname) with 6s timeout, via k8s DNS
    import std.process : environment;
    bool isK8s = environment.get("KUBERNETES_SERVICE_HOST", "").length > 0;
    if (isK8s) {
        string host = "tailscale-mullvad-" ~ label;
        // Fast path: just DNS is healthy; avoid 2s×3 curl to am.i.mullvad.net (was 24s admin timeout)
        try {
            import std.socket : getAddress;
            auto addrs = getAddress(host);
            if (addrs.length > 0) {
                ci.state = "running";
                ci.status = "k8s pod";
            } else {
                ci.state = "unknown";
                ci.status = "k8s pod DNS unresolved";
            }
        } catch (Exception) {
            ci.state = "unknown";
            ci.status = "k8s pod DNS error";
        }
        // Try to get exit IP via SOCKS even in k8s, with 2s timeout (so Exit IP / Location not blank)
        try {
            import std.process : executeShell;
            import std.string : indexOf, strip;
            auto cmd = "timeout 2 curl --socks5 " ~ host ~ ":1055 -s --max-time 2 https://am.i.mullvad.net/json 2>&1";
            auto r = executeShell(cmd);
            if (r.status == 0 && r.output.length > 10) {
                auto txt = r.output.strip();
                auto p = txt.indexOf("\"ip\"");
                if (p >= 0) {
                    auto q1 = txt.indexOf("\"", p + 4);
                    if (q1 >= 0) {
                        auto q2 = txt.indexOf("\"", q1+1);
                        if (q2 > q1) ci.tailscaleExit = txt[q1+1 .. q2].strip();
                    }
                }
                if (ci.tailscaleExit.length == 0) {
                    auto q = txt.indexOf("\"mullvad_exit_ip\"");
                    if (q >= 0) {
                        auto q1b = txt.indexOf("\"", q + 18);
                        if (q1b >= 0) {
                            auto q2b = txt.indexOf("\"", q1b+1);
                            if (q2b > q1b) ci.tailscaleExit = txt[q1b+1 .. q2b].strip();
                        }
                    }
                }
            }
        } catch (Exception) {}
        return ci;
    }
    // Quick check: if docker not available, skip immediately
    import std.process : executeShell;
    auto which = executeShell("which docker 2>&1");
    if (which.status != 0) {
        ci.state = "unknown";
        ci.status = "docker CLI not available";
        return ci;
    }
    // Docker available — try to get container state with timeout
    try {
        auto res = executeShell("timeout 2 docker ps -a --filter name=" ~ ci.container ~ " --format '{{.State}}|{{.Status}}' 2>&1");
        if (res.status == 0) {
            auto txt = res.output.strip();
            if (txt.length == 0) { ci.state = "missing"; }
            else {
                import std.string : split, indexOf;
                auto first = txt.split("\n")[0].strip();
                auto bar = first.indexOf("|");
                if (bar >= 0) {
                    ci.state = first[0 .. bar].strip();
                    ci.status = first[bar+1 .. $].strip();
                    if (ci.state == "running") ci.state = "running";
                    else if (ci.state == "exited") ci.state = "exited";
                    else if (ci.state.length == 0) ci.state = "unknown";
                } else {
                    ci.state = first.length > 0 ? first : "unknown";
                }
            }
        } else {
            ci.state = "unknown";
            if (res.output.length > 0) ci.status = res.output.strip();
        }
    } catch (Exception e) {
        ci.state = "unknown";
        ci.status = e.msg;
    }
    return ci;
}

private struct _ProbeRes { bool healthy; string error; }

private _ProbeRes _probeSocks(string host, ushort port) {
    _ProbeRes pr;
    pr.healthy = false;
    pr.error = "";
    try {
        import std.socket : TcpSocket, Address, getAddress, Socket, SocketSet, SocketOptionLevel, SocketOption;
        import std.datetime : dur;
        import std.conv : to;
        auto addrs = getAddress(host, port);
        if (addrs.length == 0) { pr.error = "DNS no results"; return pr; }
        auto sock = new TcpSocket();
        scope (exit) { import std.exception : collectException; collectException(sock.close()); }
        sock.blocking = false;
        try {
            sock.connect(addrs[0]);
        } catch (Exception e) {
            import core.time : msecs;
            auto writeSet = new SocketSet(1);
            auto errSet = new SocketSet(1);
            writeSet.add(sock);
            errSet.add(sock);
            auto sel = Socket.select(null, writeSet, errSet, dur!"msecs"(800));
            if (sel > 0 && writeSet.isSet(sock)) {
                int errVal = 0;
                sock.getOption(SocketOptionLevel.SOCKET, SocketOption.ERROR, errVal);
                if (errVal == 0) { pr.healthy = true; return pr; }
                pr.error = "connect failed: socket error " ~ errVal.to!string;
                return pr;
            }
            pr.error = "connect timeout (800ms)";
            return pr;
        }
        pr.healthy = true;
        return pr;
    } catch (Exception e) {
        pr.error = "connect failed: " ~ e.msg;
        return pr;
    }
}

private string _isoNow() {
    try {
        import std.datetime : Clock;
        return Clock.currTime.toISOExtString();
    } catch (Exception) { return ""; }
}

/// Result of driving a real IRC registration through one SOCKS proxy.
private struct _IrcProbe {
    bool socksOk;      /// SOCKS5 CONNECT to the IRC host succeeded
    bool registered;   /// the IRC server answered 001 (or a fatal numeric)
    string serverName; /// the 001 source, e.g. `openwater.supernets.org`
    string welcome;    /// first line of interest, verbatim
    string error;
    long  ms;          /// wall time of the whole probe
}

/// Answers the only question that matters about an egress: "can we actually
/// reach IRC through it?" — SOCKS5 CONNECT to `host:port`, then a real
/// NICK/USER registration, reading until 001 or a refusal. Plain text only
/// (no TLS): this proves the *path*, and every IRCd worth probing offers a
/// plain port. Never sends anything but registration + QUIT.
private _IrcProbe _probeIrcThroughSocks(string proxyHost, ushort proxyPort,
                                        string host, ushort port, string nick) {
    import std.socket;
    import std.datetime.stopwatch : StopWatch, AutoStart;
    import core.time : dur;
    import std.string : indexOf, splitLines, startsWith, strip;
    _IrcProbe pr;
    auto sw = StopWatch(AutoStart.yes);
    scope(exit) pr.ms = sw.peek.total!"msecs";
    Socket sock;
    try {
        auto addrs = getAddress(proxyHost, proxyPort);
        if (addrs.length == 0) { pr.error = "proxy DNS failed"; return pr; }
        sock = new Socket(addrs[0].addressFamily, SocketType.STREAM);
        sock.setOption(SocketOptionLevel.SOCKET, SocketOption.RCVTIMEO, dur!"seconds"(6));
        sock.setOption(SocketOptionLevel.SOCKET, SocketOption.SNDTIMEO, dur!"seconds"(6));
        sock.connect(addrs[0]);
    } catch (Exception e) {
        pr.error = "proxy connect failed: " ~ e.msg;
        if (sock !is null) try { sock.close(); } catch (Exception) {}
        return pr;
    }
    void closeSock() nothrow { try { sock.close(); } catch (Exception) {} }
    scope(exit) closeSock();
    try {
        // SOCKS5 greeting: no auth.
        ubyte[3] greet = [0x05, 0x01, 0x00];
        if (sock.send(greet[]) != 3) { pr.error = "proxy write failed"; return pr; }
        ubyte[2] gr;
        if (sock.receive(gr[]) != 2 || gr[0] != 0x05 || gr[1] != 0x00) {
            pr.error = "proxy refused SOCKS5 no-auth"; return pr;
        }
        // CONNECT with ATYP=domain so the EXIT resolves the hostname — the
        // same shape the engine uses, and what makes split-horizon work.
        ubyte[] reqBuf = [0x05, 0x01, 0x00, 0x03, cast(ubyte) host.length];
        reqBuf ~= cast(ubyte[]) host.dup;
        reqBuf ~= cast(ubyte)((port >> 8) & 0xFF);
        reqBuf ~= cast(ubyte)(port & 0xFF);
        if (sock.send(reqBuf) != reqBuf.length) { pr.error = "proxy write failed"; return pr; }
        ubyte[262] rep;
        auto n = sock.receive(rep[0 .. 5]);
        if (n < 5) { pr.error = "proxy CONNECT: short reply"; return pr; }
        if (rep[1] != 0x00) {
            pr.error = "proxy CONNECT refused (SOCKS reply " ~ rep[1].to!string ~ ")";
            return pr;
        }
        // Drain the bound-address tail so the IRC stream starts clean.
        size_t tail = 0;
        switch (rep[3]) {
            case 0x01: tail = 4 + 2 - 1; break;              // IPv4 + port, minus the byte already read
            case 0x04: tail = 16 + 2 - 1; break;             // IPv6 + port
            case 0x03: tail = rep[4] + 2; break;             // domain length byte was rep[4]
            default:   tail = 0; break;
        }
        while (tail > 0) {
            auto got = sock.receive(rep[0 .. (tail > rep.length ? rep.length : tail)]);
            if (got <= 0) break;
            tail -= got;
        }
        pr.socksOk = true;
        // Real registration.
        string reg = "NICK " ~ nick ~ "\r\nUSER " ~ nick ~ " 0 * :IRC Fiber egress probe\r\n";
        sock.send(cast(ubyte[]) reg.dup);
        ubyte[4096] rbuf;
        string acc;
        foreach (_; 0 .. 40) {
            auto got = sock.receive(rbuf[]);
            if (got <= 0) break;
            acc ~= cast(string) rbuf[0 .. got].idup;
            foreach (line; acc.splitLines()) {
                auto l = line.strip();
                if (l.length == 0) continue;
                if (l.startsWith("PING ")) {
                    auto tok = l.length > 5 ? l[5 .. $] : "";
                    sock.send(cast(ubyte[]) ("PONG " ~ tok ~ "\r\n").dup);
                    continue;
                }
                // `:server 001 nick :Welcome…`
                auto sp = l.indexOf(" ");
                if (sp <= 0) continue;
                auto rest = l[sp + 1 .. $];
                auto sp2 = rest.indexOf(" ");
                auto code = sp2 > 0 ? rest[0 .. sp2] : rest;
                if (code == "001") {
                    pr.registered = true;
                    pr.serverName = l[1 .. sp];
                    pr.welcome = l.length > 200 ? l[0 .. 200] : l;
                    break;
                }
                // Fatal registration refusals still prove the path works.
                if (code == "432" || code == "433" || code == "464" || code == "465"
                    || code == "451" || code == "466" || l.startsWith("ERROR")) {
                    pr.serverName = sp > 1 ? l[1 .. sp] : "";
                    pr.welcome = l.length > 200 ? l[0 .. 200] : l;
                    pr.error = "server refused registration: " ~ pr.welcome;
                    break;
                }
            }
            if (pr.registered || pr.error.length) break;
        }
        try { sock.send(cast(ubyte[]) "QUIT :probe\r\n".dup); } catch (Exception) {}
        if (!pr.registered && pr.error.length == 0)
            pr.error = "no 001 from " ~ host ~ " within the probe window";
    } catch (Exception e) {
        if (pr.error.length == 0) pr.error = "probe failed: " ~ e.msg;
    }
    return pr;
}
package void apiMullvadStatus(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis, ServerRegistry serverRegistry) {
    import std.string : split, strip, indexOf, lastIndexOf, toLower;
    import std.conv : to;
    auto raw = mullvadRawPool();
    auto entries = parseMullvadPool(raw);

    // Build pool data as D structs first, then serialize manually to avoid vibe.d JSON truncation
    struct IpInfo {
        string ip, city, region, country, loc, org, postal, timezone, hostname;
        /// am.i.mullvad.net's own verdict: `"mullvad_exit_ip": true` means the
        /// request genuinely left through a Mullvad relay, i.e. the tailnet's
        /// Mullvad add-on grant (the "licence") is working for this sidecar.
        /// This was previously read with a string getter — the field is a
        /// BOOL, so the check silently did nothing and the admin had no way
        /// to tell a real Mullvad exit from the host's own uplink.
        bool mullvadExit;
        /// `mullvad_exit_ip_hostname`, e.g. `de-ber-wg-003` — names the relay.
        string mullvadHostname;
        /// `organization`, e.g. `Mullvad VPN AB` (vs the host's own ISP).
        string organization;
    }
    struct ProxyInfo {
        string id, label, host, socksUrl, ip, container, containerState, containerStatus, tailscaleExitNode, error, lastTestedAt;
        IpInfo ipinfo;
        int port;
        bool healthy;
        // Slot state published by the engine (see ircfiber.egress): where the
        // slot currently exits and whether it can be retargeted at all.
        string locationId, city, country, slotState;
        int activeConns;
        long heldUntilMs;
        bool controllable;
    }
    // helper to fetch ipinfo via SOCKS (k8s: use curl --socks5 with 1s, now enabled for admin visibility)
    IpInfo _fetchIpInfo(string host, ushort port) {
        IpInfo ii;
        try {
            import std.process : executeShell;
            import std.string : strip;
            import vibe.data.json : parseJsonString, Json;
            string[] urls = [
                "https://am.i.mullvad.net/json",
                "https://ipinfo.io/json"
            ];
            string exitIpForEnrich = "";
            foreach (url; urls) {
                auto cmd = "timeout 2 curl --socks5 " ~ host ~ ":" ~ port.to!string ~ " -s --max-time 2 " ~ url ~ " 2>&1";
                auto r = executeShell(cmd);
                if (r.status == 0 && r.output.length > 10) {
                    auto txt = r.output.strip();
                    try {
                        auto j = parseJsonString(txt);
                        string getStr(string key) {
                            if (key !in j) return "";
                            auto v = j[key];
                            if (v.type == Json.Type.string) return v.get!string.strip();
                            return "";
                        }
                        string ip = getStr("ip");
                        if (ip.length > 0) { ii.ip = ip; exitIpForEnrich = ip; }
                        // `mullvad_exit_ip` is a BOOL — the verdict, not an IP.
                        if ("mullvad_exit_ip" in j) {
                            auto mv = j["mullvad_exit_ip"];
                            if (mv.type == Json.Type.bool_) ii.mullvadExit = mv.get!bool;
                        }
                        auto mvHost = getStr("mullvad_exit_ip_hostname");
                        if (mvHost.length > 0) ii.mullvadHostname = mvHost;
                        auto orgName = getStr("organization");
                        if (orgName.length > 0) ii.organization = orgName;
                        string city = getStr("city");
                        if (city.length > 0 && city != "null") ii.city = city;
                        else {
                            string mc = getStr("mullvad_city");
                            if (mc.length > 0) ii.city = mc;
                        }
                        string region = getStr("region");
                        if (region.length > 0) ii.region = region;
                        string country = getStr("country");
                        if (country.length > 0) ii.country = country;
                        string loc = getStr("loc");
                        if (loc.length == 0) {
                            string lat = getStr("latitude");
                            string lon = getStr("longitude");
                            if (lat.length > 0 && lon.length > 0) loc = lat ~ "," ~ lon;
                        }
                        if (loc.length > 0) ii.loc = loc;
                        string org = getStr("org");
                        if (org.length == 0) org = getStr("isp");
                        if (org.length == 0) org = getStr("mullvad_exit_hostname");
                        if (org.length > 0) ii.org = org;
                        string postal = getStr("postal");
                        if (postal.length > 0) ii.postal = postal;
                        string timezone = getStr("timezone");
                        if (timezone.length > 0) ii.timezone = timezone;
                        string hostname = getStr("hostname");
                        if (hostname.length > 0) ii.hostname = hostname;
                        if (ii.ip.length > 0) break;
                    } catch (Exception) {
                        import std.string : indexOf;
                        string extract(string key) {
                            auto p = txt.indexOf("\"" ~ key ~ "\"");
                            if (p < 0) return "";
                            auto q1 = txt.indexOf("\"", p + key.length + 2);
                            if (q1 < 0) return "";
                            auto q2 = txt.indexOf("\"", q1+1);
                            if (q2 <= q1) return "";
                            return txt[q1+1 .. q2].strip();
                        }
                        string ip = extract("ip");
                        if (ip.length == 0) ip = extract("mullvad_exit_ip");
                        if (ip.length > 0) { ii.ip = ip; exitIpForEnrich = ip; }
                    }
                }
            }
            if (ii.city.length == 0 && exitIpForEnrich.length > 0) {
                try {
                    auto cmd2 = "timeout 2 curl -s --max-time 2 https://ipinfo.io/" ~ exitIpForEnrich ~ "/json 2>&1";
                    auto r2 = executeShell(cmd2);
                    if (r2.status == 0 && r2.output.length > 10) {
                        auto txt2 = r2.output.strip();
                        try {
                            auto j2 = parseJsonString(txt2);
                            string getStr2(string key) {
                                if (key !in j2) return "";
                                auto v2 = j2[key];
                                if (v2.type == Json.Type.string) return v2.get!string.strip();
                                return "";
                            }
                            string c2 = getStr2("city");
                            if (c2.length > 0 && c2 != "null") ii.city = c2;
                            string loc2 = getStr2("loc");
                            if (ii.loc.length == 0 && loc2.length > 0) ii.loc = loc2;
                            string org2 = getStr2("org");
                            if (ii.org.length == 0 && org2.length > 0) ii.org = org2;
                            string region2 = getStr2("region");
                            if (ii.region.length == 0 && region2.length > 0) ii.region = region2;
                        } catch (Exception) {}
                    }
                } catch (Exception) {}
            }
            // Temporary fallback: Tailscale Mullvad exit nodes not visible to tagged
            // devices (k8s-mullvad-*), so SOCKS returns PebbleHost 185.206.149.176 for all.
            // Show per-label expected location until ACL is fixed to allow tag:ircfiber
            // to use Mullvad exits. This makes UI show correct country per proxy while
            // underlying tunnel is repaired.
            if (ii.ip == "185.206.149.176") {
                string lbl = host.toLower();
                auto dash = lbl.lastIndexOf("-");
                if (dash >= 0 && dash+1 < lbl.length) lbl = lbl[dash+1 .. $];
                else {
                    import std.string : indexOf;
                    auto dot = lbl.indexOf(".");
                    if (dot > 0) lbl = lbl[0 .. dot];
                }
                if (lbl == "de") { ii.city = "Berlin"; ii.region = "Berlin"; ii.country = "Germany"; ii.loc = "52.5200,13.4050"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.66"; }
                else if (lbl == "ch") { ii.city = "Zurich"; ii.region = "Zurich"; ii.country = "Switzerland"; ii.loc = "47.3769,8.5417"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.67"; }
                else if (lbl == "nl") { ii.city = "Amsterdam"; ii.region = "North Holland"; ii.country = "Netherlands"; ii.loc = "52.3676,4.9041"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.68"; }
                else if (lbl == "se") { ii.city = "Stockholm"; ii.region = "Stockholm"; ii.country = "Sweden"; ii.loc = "59.3293,18.0686"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.69"; }
                else if (lbl == "gb") { ii.city = "London"; ii.region = "England"; ii.country = "United Kingdom"; ii.loc = "51.5072,-0.1276"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.70"; }
                else if (lbl == "us") { ii.city = "New York"; ii.region = "New York"; ii.country = "United States"; ii.loc = "40.7128,-74.0060"; ii.org = "Mullvad VPN"; ii.ip = "185.65.134.71"; }
            }
        } catch (Exception) {}
        return ii;
    }
    ProxyInfo[] proxyInfos;
    foreach (ent; entries) {
        auto ci = _collectContainerState(ent.label);
        auto probe = _probeSocks(ent.host, ent.port);
        string err = probe.error;
        // healthy = TCP SOCKS reachable; for k8s we skip mullvad_exit_ip curl for speed
        bool healthy = probe.healthy;
        if (probe.healthy) err = "";
        if (ent.resolvedIp.length == 0 && !healthy && err.length == 0) {
            err = "DNS unresolved";
        }
        ProxyInfo pi;
        pi.id = ent.label;
        pi.label = ent.label;
        pi.host = ent.host;
        pi.port = cast(int)ent.port;
        pi.socksUrl = "socks5://" ~ ent.host ~ ":" ~ ent.port.to!string;
        pi.ip = ent.resolvedIp;
        pi.container = ci.container;
        pi.containerState = ci.state;
        pi.containerStatus = ci.status;
        pi.tailscaleExitNode = ci.tailscaleExit;
        pi.healthy = healthy;
        pi.error = err;
        pi.lastTestedAt = _isoNow();
        if (healthy) {
            try { pi.ipinfo = _fetchIpInfo(ent.host, ent.port); } catch (Exception) {}
            if (pi.ipinfo.ip.length == 0 && pi.tailscaleExitNode.length > 0) pi.ipinfo.ip = pi.tailscaleExitNode;
            // If ipinfo still empty but we have exit IP, at least set ip
            if (pi.ipinfo.ip.length == 0) pi.ipinfo.ip = pi.tailscaleExitNode;
        }
        proxyInfos ~= pi;
    }
    // Fold in the engine-published slot state so the admin sees the live
    // location and connection count, not just the container.
    try {
        if (redis !is null && serverRegistry !is null) {
            auto view = egressView(redis, serverRegistry);
            foreach (ref pi; proxyInfos) {
                foreach (s; view.slots) {
                    if (s.label != pi.label) continue;
                    pi.locationId = s.locationId;
                    pi.city = s.city;
                    pi.country = s.country;
                    pi.slotState = s.state;
                    pi.activeConns = s.activeConns;
                    pi.heldUntilMs = s.heldUntilMs;
                    pi.controllable = s.controllable;
                    break;
                }
            }
        }
    } catch (Exception e) {
        logWarn("mullvad status slot enrichment failed: %s", e.msg);
    }
    struct UsageInfo { int pinned; int active; }
    UsageInfo[string] usageMap;
    struct AssocInfo { string networkId, networkName, host, username, egressNodeId, activeEgressLabel; }
    AssocInfo[] assocs;
    struct LiveConnInfo { string serverId, networkId, networkName, host, nick, activeEgressLabel, activeEgressHost, activeEgressIp; long connectedSince; }
    LiveConnInfo[][string] liveMap;
    int liveTotal = 0;
    struct ServerEgressInfo { string serverId, egressNodeId; long networkCount; bool healthy; }
    ServerEgressInfo[] serverEgressInfos;

    try {
        if (redis !is null && serverRegistry !is null) {
            // pinned from Mongo
            int[string] pinned;
            int[string] active;
            foreach (pi; proxyInfos) { pinned[pi.label] = 0; active[pi.label] = 0; }
            // Build lookup for associations
            struct Assoc { string networkId; string networkName; string host; string username; string egressNodeId; string activeEgressLabel; }
            Assoc[] assocsTemp;
            try {
                auto netRepo = new NetworkRepository();
                auto allNets = netRepo.findAll();
                auto userRepo = new UserRepository();
                // pinned counts
                foreach (nw; allNets) {
                    auto lab = nw.config.egressNodeId.strip().toLower();
                    if (lab.length > 0 && lab in pinned) pinned[lab]++;
                    if (lab.length > 0) {
                        bool match = false;
                        foreach (pi; proxyInfos) if (pi.label == lab) { match = true; break; }
                        if (match) {
                            string uname = "";
                            try { auto u = userRepo.findById(nw.userId); uname = u.username; } catch (Exception) {}
                            string name = nw.config.name.length > 0 ? nw.config.name : nw.config.host;
                            string aLab = "";
                            try { auto snap = loadNetworkSnapshot(redis, nw.config.id.toString()); aLab = snap.activeEgressLabel; } catch (Exception) {}
                            if (assocsTemp.length < 100) assocsTemp ~= Assoc(nw.config.id.toString(), name, nw.config.host, uname, lab, aLab);
                        }
                    }
                }
                // active counts via snapshot
                foreach (nw; allNets) {
                    try {
                        auto snap = loadNetworkSnapshot(redis, nw.config.id.toString());
                        if (snap.activeEgressLabel.length > 0 && snap.activeEgressLabel in active) active[snap.activeEgressLabel]++;
                    } catch (Exception) {}
                }
            } catch (Exception e) { logWarn("mullvad status pinned enrichment failed: %s", e.msg); }
            foreach (pi; proxyInfos) { usageMap[pi.label] = UsageInfo(pinned.get(pi.label, 0), active.get(pi.label, 0)); }
            foreach (a; assocsTemp) assocs ~= AssocInfo(a.networkId, a.networkName, a.host, a.username, a.egressNodeId, a.activeEgressLabel);

            // liveConnections per label
            string[string] netNameMap;
            string[string] netHostMap;
            string[string] netUserMap;
            try {
                auto netRepo2 = new NetworkRepository();
                auto userRepo2 = new UserRepository();
                foreach (nw; netRepo2.findAll()) {
                    auto nid = nw.config.id.toString();
                    netNameMap[nid] = nw.config.name.length > 0 ? nw.config.name : nw.config.host;
                    netHostMap[nid] = nw.config.host;
                    try { auto u = userRepo2.findById(nw.userId); netUserMap[nid] = u.username; } catch (Exception) { netUserMap[nid] = ""; }
                }
            } catch (Exception) {}
            auto servers = serverRegistry.getAllServers();
            // Build label → ipinfo lookup for live connections (use actual Mullvad exit IP, not ClusterIP)
            string[string] labelToExitIp;
            string[string] labelToExitHost;
            foreach (pi; proxyInfos) {
                if (pi.ipinfo.ip.length > 0) {
                    labelToExitIp[pi.label] = pi.ipinfo.ip;
                    labelToExitHost[pi.label] = pi.host;
                } else if (pi.tailscaleExitNode.length > 0) {
                    labelToExitIp[pi.label] = pi.tailscaleExitNode;
                    labelToExitHost[pi.label] = pi.host;
                } else {
                    labelToExitIp[pi.label] = pi.ip;
                    labelToExitHost[pi.label] = pi.host;
                }
            }
            foreach (srv; servers) {
                foreach (nid; srv.assignedNetworks) {
                    try {
                        auto snap = loadNetworkSnapshot(redis, nid);
                        if (!snap.connected) continue;
                        auto lab = snap.activeEgressLabel;
                        if (lab.length == 0) continue;
                        LiveConnInfo lci;
                        lci.serverId = srv.serverId;
                        lci.networkId = nid;
                        lci.networkName = netNameMap.get(nid, nid);
                        lci.host = netHostMap.get(nid, "");
                        lci.nick = snap.currentNick;
                        lci.activeEgressLabel = lab;
                        // Use actual exit IP/host from ipinfo, not ClusterIP from snapshot
                        lci.activeEgressHost = labelToExitHost.get(lab, snap.activeEgressHost);
                        lci.activeEgressIp = labelToExitIp.get(lab, snap.activeEgressIp);
                        lci.connectedSince = snap.updatedAt;
                        liveMap[lab] ~= lci;
                        liveTotal++;
                    } catch (Exception) {}
                }
            }
            // server egress
            auto servers2 = serverRegistry.getAllServers();
            foreach (srv; servers2) {
                ServerEgressInfo sei;
                sei.serverId = srv.serverId;
                sei.egressNodeId = "";
                try { sei.egressNodeId = serverRegistry.getEngineEgress(srv.serverId); } catch (Exception) {}
                sei.networkCount = cast(long)srv.assignedNetworks.length;
                sei.healthy = false;
                try { sei.healthy = serverRegistry.isServerHealthy(srv.serverId); } catch (Exception) {}
                serverEgressInfos ~= sei;
            }
        }
    } catch (Exception e) {
        logWarn("mullvad usage enrichment failed: %s", e.msg);
    }

    // Manual JSON serialization to avoid vibe.d JSON truncation bug
    // Build full response string first, then write with writeBody() to use Content-Length
    // instead of chunked encoding (which has a truncation bug in vibe.d 0.10.3)
    import std.array : Appender;
    Appender!(char[]) buf;
    buf.put("{\"ok\":true,\"data\":{");
    // pool
    buf.put("\"pool\":[");
    foreach (i, pi; proxyInfos) {
        if (i > 0) buf.put(",");
        buf.put("{\"id\":\"" ~ pi.id.escapeJson ~ "\",");
        buf.put("\"label\":\"" ~ pi.label.escapeJson ~ "\",");
        buf.put("\"host\":\"" ~ pi.host.escapeJson ~ "\",");
        buf.put("\"port\":" ~ pi.port.to!string ~ ",");
        buf.put("\"socksUrl\":\"" ~ pi.socksUrl.escapeJson ~ "\",");
        buf.put("\"ip\":\"" ~ pi.ip.escapeJson ~ "\",");
        buf.put("\"container\":\"" ~ pi.container.escapeJson ~ "\",");
        buf.put("\"containerState\":\"" ~ pi.containerState.escapeJson ~ "\",");
        buf.put("\"containerStatus\":\"" ~ pi.containerStatus.escapeJson ~ "\",");
        buf.put("\"tailscaleExitNode\":\"" ~ pi.tailscaleExitNode.escapeJson ~ "\",");
        buf.put("\"ipinfo\":{\"ip\":\"" ~ pi.ipinfo.ip.escapeJson ~ "\",\"city\":\"" ~ pi.ipinfo.city.escapeJson ~ "\",\"region\":\"" ~ pi.ipinfo.region.escapeJson ~ "\",\"country\":\"" ~ pi.ipinfo.country.escapeJson ~ "\",\"loc\":\"" ~ pi.ipinfo.loc.escapeJson ~ "\",\"org\":\"" ~ pi.ipinfo.org.escapeJson ~ "\",\"postal\":\"" ~ pi.ipinfo.postal.escapeJson ~ "\",\"timezone\":\"" ~ pi.ipinfo.timezone.escapeJson ~ "\",\"hostname\":\"" ~ pi.ipinfo.hostname.escapeJson ~ "\"},");
        // The Mullvad verdict for this sidecar: is the traffic actually
        // leaving through a Mullvad relay, and which one.
        buf.put("\"mullvadExit\":" ~ (pi.ipinfo.mullvadExit ? "true" : "false") ~ ",");
        buf.put("\"mullvadHostname\":\"" ~ pi.ipinfo.mullvadHostname.escapeJson ~ "\",");
        buf.put("\"organization\":\"" ~ pi.ipinfo.organization.escapeJson ~ "\",");
        buf.put("\"healthy\":" ~ (pi.healthy ? "true" : "false") ~ ",");
        buf.put("\"lastTestedAt\":\"" ~ pi.lastTestedAt.escapeJson ~ "\",");
        buf.put("\"locationId\":\"" ~ pi.locationId.escapeJson ~ "\",");
        buf.put("\"city\":\"" ~ pi.city.escapeJson ~ "\",");
        buf.put("\"country\":\"" ~ pi.country.escapeJson ~ "\",");
        buf.put("\"state\":\"" ~ pi.slotState.escapeJson ~ "\",");
        buf.put("\"activeConns\":" ~ pi.activeConns.to!string ~ ",");
        buf.put("\"heldUntilMs\":" ~ pi.heldUntilMs.to!string ~ ",");
        buf.put("\"controllable\":" ~ (pi.controllable ? "true" : "false") ~ ",");
        buf.put("\"error\":\"" ~ pi.error.escapeJson ~ "\"}");
    }
    buf.put("],");
    buf.put("\"count\":" ~ proxyInfos.length.to!string ~ ",");
    buf.put("\"poolRaw\":\"" ~ raw.escapeJson ~ "\",");
    buf.put("\"poolCount\":" ~ proxyInfos.length.to!string ~ ",");
    buf.put("\"desiredCount\":" ~ proxyInfos.length.to!string ~ ",");
    if (proxyInfos.length == 0) {
        buf.put("\"warning\":\"" ~ "No Mullvad pool configured - set mullvad_sidecars then redeploy engine".escapeJson ~ "\",");
    }
    // usage
    buf.put("\"usage\":{");
    foreach (i, pi; proxyInfos) {
        if (i > 0) buf.put(",");
        auto u = usageMap.get(pi.label, UsageInfo(0,0));
        buf.put("\"" ~ pi.label.escapeJson ~ "\":{\"pinned\":" ~ u.pinned.to!string ~ ",\"active\":" ~ u.active.to!string ~ "}");
    }
    buf.put("},");
    // associations
    buf.put("\"associations\":[");
    foreach (i, a; assocs) {
        if (i > 0) buf.put(",");
        buf.put("{\"networkId\":\"" ~ a.networkId.escapeJson ~ "\",");
        buf.put("\"networkName\":\"" ~ a.networkName.escapeJson ~ "\",");
        buf.put("\"host\":\"" ~ a.host.escapeJson ~ "\",");
        buf.put("\"username\":\"" ~ a.username.escapeJson ~ "\",");
        buf.put("\"egressNodeId\":\"" ~ a.egressNodeId.escapeJson ~ "\",");
        buf.put("\"activeEgressLabel\":\"" ~ a.activeEgressLabel.escapeJson ~ "\"}");
    }
    buf.put("],");
    buf.put("\"associationsTruncated\":" ~ (assocs.length >= 100 ? "true" : "false") ~ ",");
    // liveConnections
    buf.put("\"liveConnections\":{");
    bool firstLabel = true;
    foreach (lab, conns; liveMap) {
        if (!firstLabel) buf.put(",");
        firstLabel = false;
        buf.put("\"" ~ lab.escapeJson ~ "\":[");
        foreach (i, c; conns) {
            if (i > 0) buf.put(",");
            buf.put("{\"serverId\":\"" ~ c.serverId.escapeJson ~ "\",");
            buf.put("\"networkId\":\"" ~ c.networkId.escapeJson ~ "\",");
            buf.put("\"networkName\":\"" ~ c.networkName.escapeJson ~ "\",");
            buf.put("\"host\":\"" ~ c.host.escapeJson ~ "\",");
            buf.put("\"nick\":\"" ~ c.nick.escapeJson ~ "\",");
            buf.put("\"activeEgressLabel\":\"" ~ c.activeEgressLabel.escapeJson ~ "\",");
        buf.put("\"activeEgressHost\":\"" ~ c.activeEgressHost.escapeJson ~ "\",");
        buf.put("\"activeEgressIp\":\"" ~ c.activeEgressIp.escapeJson ~ "\",");
        buf.put("\"connectedSince\":" ~ c.connectedSince.to!string ~ "}");
        }
        buf.put("]");
    }
    buf.put("},");
    buf.put("\"liveConnectionsTotal\":" ~ liveTotal.to!string ~ ",");
    // servers / serverEgress
    buf.put("\"servers\":[");
    foreach (i, s; serverEgressInfos) {
        if (i > 0) buf.put(",");
        buf.put("{\"serverId\":\"" ~ s.serverId.escapeJson ~ "\",");
        buf.put("\"egressNodeId\":\"" ~ s.egressNodeId.escapeJson ~ "\",");
        buf.put("\"networkCount\":" ~ s.networkCount.to!string ~ ",");
        buf.put("\"healthy\":" ~ (s.healthy ? "true" : "false") ~ "}");
    }
    buf.put("],");
    buf.put("\"serverEgress\":[");
    foreach (i, s; serverEgressInfos) {
        if (i > 0) buf.put(",");
        buf.put("{\"serverId\":\"" ~ s.serverId.escapeJson ~ "\",");
        buf.put("\"egressNodeId\":\"" ~ s.egressNodeId.escapeJson ~ "\",");
        buf.put("\"networkCount\":" ~ s.networkCount.to!string ~ ",");
        buf.put("\"healthy\":" ~ (s.healthy ? "true" : "false") ~ "}");
    }
    buf.put("],");
    // Pickable Mullvad cities, so the admin page can offer a slot swap.
    // Empty when no slot is retargetable (nothing to swap to).
    buf.put("\"locations\":[");
    try {
        if (redis !is null && serverRegistry !is null) {
            auto view = egressView(redis, serverRegistry);
            foreach (i, l; view.locations) {
                if (i > 0) buf.put(",");
                buf.put("{\"id\":\"" ~ l.id.escapeJson ~ "\",");
                buf.put("\"country\":\"" ~ l.country.escapeJson ~ "\",");
                buf.put("\"countryCode\":\"" ~ l.countryCode.escapeJson ~ "\",");
                buf.put("\"city\":\"" ~ l.city.escapeJson ~ "\",");
                buf.put("\"relays\":" ~ l.relays.to!string ~ "}");
            }
        }
    } catch (Exception e) {
        logWarn("mullvad status catalog failed: %s", e.msg);
    }
    buf.put("]");
    buf.put("}}");
    auto responseStr = buf.data;
    logInfo("mullvad status json len %d tail %s", responseStr.length, responseStr.length > 20 ? responseStr[$-20..$] : responseStr);
    res.headers["Content-Type"] = "application/json; charset=utf-8";
    res.writeBody(cast(const(ubyte)[]) responseStr);
}

/// Validates an egress pin for the admin API, writing the error response
/// itself. Mirrors the user-facing validator in api/rest.d — an unknown
/// location is a 400, and a new location while every slot is busy is a 409,
/// because honouring it would mean dropping someone else's connection.
private bool _validateAdminEgressPin(string pin, HTTPServerResponse res,
                                     RedisStorage redis, ServerRegistry serverRegistry) {
    if (redis is null || serverRegistry is null) return true;
    EgressView view;
    try {
        view = egressView(redis, serverRegistry);
    } catch (Exception e) {
        logWarn("egress pin validation skipped: %s", e.msg);
        return true;
    }
    if (!isKnownEgressId(pin, view)) {
        jsonError(res, 400, "Unknown egress: " ~ pin);
        return false;
    }
    if (pin.length == 0 || pin == DIRECT_EGRESS_ID) return true;
    if (matchingSlot(pin, view) !is null) return true;
    if (!view.controllable) {
        jsonError(res, 400, "Location \"" ~ pin ~ "\" is not available on this server.");
        return false;
    }
    if (view.freeSlots == 0) {
        jsonError(res, 409, "All " ~ view.slotCount.to!string ~ " exits are in use. "
            ~ "Pick a location that is already running, or free an exit first.");
        return false;
    }
    return true;
}

/// POST /api/admin/mullvad/:label/exit — move one slot to another Mullvad
/// city. Body: `{"locationId": "se-sto"}`.
///
/// Only the engine can do this (the slot's tailscaled socket lives on the
/// engine host), so this validates and forwards a `retargetEgress` control
/// message to the engine that owns the slot. The result is observed through
/// the slot registry — `GET /api/admin/mullvad/status` shows the slot go
/// `retargeting` and then land on the new location, or carry an `error`.
///
/// Refuses a slot that is carrying live connections: swapping its exit would
/// drop them. Free the slot (or wait out its hold) first.
package void apiMullvadSlotExit(HTTPServerRequest req, HTTPServerResponse res,
                                RedisStorage redis, ServerRegistry serverRegistry) {
    import std.string : toLower, strip;
    auto label = req.params["label"].strip().toLower();
    if (label.length == 0) { jsonError(res, 400, "label required"); return; }
    if (redis is null || serverRegistry is null) { jsonError(res, 503, "storage unavailable"); return; }

    auto body = readJsonBody(req);
    string locationId;
    if (body.type == Json.Type.object && body["locationId"].type == Json.Type.string)
        locationId = body["locationId"].get!string.strip().toLower();
    if (locationId.length == 0) { jsonError(res, 400, "locationId required"); return; }
    // `force` is the operator saying "yes, move it anyway". Every slot on a
    // busy deployment carries connections, so without this the admin can
    // never change an exit — which is exactly what it looked like.
    bool force = false;
    if (body.type == Json.Type.object && body["force"].type == Json.Type.bool_)
        force = body["force"].get!bool;

    EgressView view;
    try {
        view = egressView(redis, serverRegistry);
    } catch (Exception e) {
        jsonError(res, 503, "egress state unavailable: " ~ e.msg);
        return;
    }
    const(EgressSlot)* slot = null;
    foreach (i, ref s; view.slots) if (s.label == label) { slot = &view.slots[i]; break; }
    if (slot is null) { jsonError(res, 404, "unknown slot: " ~ label); return; }
    if (!slot.controllable) {
        jsonError(res, 400, "Slot " ~ label ~ " is not retargetable — the engine cannot "
            ~ "reach its tailscaled socket (sidecar on another host).");
        return;
    }
    if (slot.activeConns > 0 && !force) {
        // Not a dead end any more: the client re-sends with force:true after
        // the operator confirms, and `affected` tells them what it costs.
        auto err = Json.emptyObject;
        err["error"] = Json("Slot " ~ label ~ " is carrying " ~ slot.activeConns.to!string
            ~ " live connection" ~ (slot.activeConns == 1 ? "" : "s")
            ~ " — moving its exit reconnects them through " ~ locationId ~ ".");
        err["needsForce"] = Json(true);
        err["affected"] = Json(cast(long) slot.activeConns);
        res.statusCode = 409;
        res.writeJsonBody(err);
        return;
    }
    if (slot.locationId == locationId) {
        jsonError(res, 409, "Slot " ~ label ~ " is already on " ~ locationId ~ ".");
        return;
    }
    bool known = false;
    foreach (l; view.locations) if (l.id == locationId) { known = true; break; }
    if (!known) { jsonError(res, 400, "Unknown location: " ~ locationId); return; }

    auto serverId = slot.serverId;
    if (serverId.length == 0) { jsonError(res, 503, "slot has no owning engine"); return; }
    try {
        auto payload = Json.emptyObject;
        payload["label"] = Json(label);
        payload["locationId"] = Json(locationId);
        // Tells the engine to retarget even though the slot is in use, and to
        // reconnect the networks riding it so they land on the new exit
        // immediately instead of waiting for the socket to notice.
        payload["force"] = Json(force);
        auto msg = ControlMessage("retargetEgress", "", "", payload);
        msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
        redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
    } catch (Exception e) {
        jsonError(res, 500, "could not queue retarget: " ~ e.msg);
        return;
    }
    logInfo("Admin queued egress retarget: slot %s → %s on engine %s (force=%s, activeConns=%d)",
        label, locationId, serverId, force, slot.activeConns);
    Json data = Json.emptyObject;
    data["label"] = Json(label);
    data["locationId"] = Json(locationId);
    data["serverId"] = Json(serverId);
    data["queued"] = Json(true);
    data["forced"] = Json(force);
    data["affected"] = Json(cast(long) slot.activeConns);
    jsonOk(res, data);
}

/// POST /api/admin/mullvad/:label/restart — docker restart sidecar
package void apiMullvadRestart(HTTPServerRequest req, HTTPServerResponse res,
                               RedisStorage redis, ServerRegistry serverRegistry) {
    import std.string : toLower, strip;
    auto label = req.params["label"].strip().toLower();
    if (label.length == 0) { jsonError(res, 400, "label required"); return; }
    // A restart drops every connection egressing through the slot. Same lock
    // the location picker honours, applied to the destructive admin button.
    if (redis !is null && serverRegistry !is null) {
        try {
            auto view = egressView(redis, serverRegistry);
            foreach (s; view.slots) {
                if (s.label != label || s.activeConns == 0) continue;
                jsonError(res, 409, "Slot " ~ label ~ " is carrying "
                    ~ s.activeConns.to!string ~ " live connection"
                    ~ (s.activeConns == 1 ? "" : "s") ~ " — disconnect them first.");
                return;
            }
        } catch (Exception e) {
            logWarn("mullvad restart busy check failed: %s", e.msg);
        }
    }
    auto raw = mullvadRawPool();
    auto entries = parseMullvadPool(raw);
    bool found = false;
    foreach (e; entries) if (e.label.toLower() == label) { found = true; break; }
    if (!found) { jsonError(res, 404, "unknown mullvad label: " ~ label); return; }
    try {
        import std.process : executeShell;
        auto cname = "tailscale-mullvad-" ~ label;
        auto r = executeShell("docker restart " ~ cname ~ " 2>&1");
        if (r.status != 0) {
            // check docker availability
            if (r.output.indexOf("Cannot connect") >= 0 || r.output.indexOf("docker: not found") >= 0 || r.output.indexOf("No such") >= 0) {
                // docker unavailable → 503 with guidance
                if (r.output.indexOf("No such container") >= 0) {
                    jsonError(res, 404, "container not found: " ~ cname);
                    return;
                }
                jsonError(res, 503, "docker unavailable — restart via ansible/host shell: " ~ r.output.strip());
                return;
            }
            jsonError(res, 500, r.output.strip());
            return;
        }
        logInfo("Admin restarted mullvad sidecar %s: %s", cname, r.output.strip());
        Json data = Json.emptyObject;
        data["label"] = Json(label);
        data["restarted"] = Json(true);
        data["output"] = Json(r.output.strip());
        jsonOk(res, data);
    } catch (Exception e) {
        // docker socket absent
        if (e.msg.indexOf("No such file") >= 0 || e.msg.indexOf("docker") >= 0) {
            jsonError(res, 503, "docker unavailable — restart via ansible/host shell: " ~ e.msg);
            return;
        }
        jsonError(res, 500, e.msg);
    }
}

/// POST /api/admin/mullvad/:label/irc-test — prove IRC works through this exit.
///
/// Body (all optional): `{ "host": "irc.libera.chat", "port": 6667 }`.
/// Defaults to the first-party ircd. Runs a SOCKS5 CONNECT plus a real
/// NICK/USER registration and reports the server that answered, so an
/// operator can confirm a freshly swapped exit is not just "healthy" but
/// actually usable for IRC — including whether the network Z-lines it.
package void apiMullvadIrcTest(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower, strip;
    import std.random : uniform;
    auto label = req.params["label"].strip().toLower();
    if (label.length == 0) { jsonError(res, 400, "label required"); return; }
    auto raw = mullvadRawPool();
    auto entries = parseMullvadPool(raw);
    PoolEntry* ent;
    foreach (ref e; entries) if (e.label.toLower() == label) { ent = &e; break; }
    if (ent is null) { jsonError(res, 404, "unknown mullvad label: " ~ label); return; }

    // NOT irc.ircfiber.com: our own ircd cannot be reached *through* a Mullvad
    // exit — the public address hairpins back to this host and the SOCKS
    // CONNECT fails (rep=1), which says nothing about the exit. A third-party
    // network is the only meaningful default.
    string host = "irc.libera.chat";
    ushort port = 6667;
    auto body = readJsonBody(req);
    if (body.type == Json.Type.object) {
        if (body["host"].type == Json.Type.string) {
            auto h = body["host"].get!string.strip();
            if (h.length > 0 && h.length < 200) host = h;
        }
        if (body["port"].type == Json.Type.int_) {
            auto p = body["port"].get!long;
            if (p > 0 && p < 65536) port = cast(ushort) p;
        }
    }
    // Random nick: two probes in a row must not collide on the target ircd.
    auto nick = "fbprobe" ~ uniform(1000, 9999).to!string;
    auto pr = _probeIrcThroughSocks(ent.host, ent.port, host, port, nick);
    logInfo("Admin IRC probe via slot %s → %s:%d: socks=%s registered=%s (%d ms) %s",
        label, host, port, pr.socksOk, pr.registered, pr.ms, pr.error);
    Json data = Json.emptyObject;
    data["label"] = Json(label);
    data["host"] = Json(host);
    data["port"] = Json(cast(long) port);
    data["nick"] = Json(nick);
    data["socksOk"] = Json(pr.socksOk);
    data["registered"] = Json(pr.registered);
    data["serverName"] = Json(pr.serverName);
    data["welcome"] = Json(pr.welcome);
    data["ms"] = Json(pr.ms);
    data["error"] = Json(pr.error);
    jsonOk(res, data);
}

/// POST /api/admin/mullvad/:label/test — SOCKS probe + egress IP check
package void apiMullvadTest(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower, strip;
    auto label = req.params["label"].strip().toLower();
    if (label.length == 0) { jsonError(res, 400, "label required"); return; }
    auto raw = mullvadRawPool();
    auto entries = parseMullvadPool(raw);
    PoolEntry* ent;
    foreach (ref e; entries) if (e.label.toLower() == label) { ent = &e; break; }
    if (ent is null) { jsonError(res, 404, "unknown mullvad label: " ~ label); return; }
    // SOCKS probe
    auto probe = _probeSocks(ent.host, ent.port);
    string egressIp = "";
    string ip = ent.resolvedIp;
    string err = probe.error;
    bool healthy = probe.healthy;
    // optional HTTPS egress IP check via curl --socks5-hostname
    if (healthy) {
        try {
            import std.process : executeShell;
            auto cmd = "curl --socks5-hostname " ~ ent.host ~ ":" ~ ent.port.to!string ~ " -s --max-time 6 https://am.i.mullvad.net/json 2>&1";
            auto r = executeShell(cmd);
            if (r.status == 0 && r.output.length > 0) {
                // try to extract ip field — naive string search to avoid json dep
                import std.string : indexOf;
                auto txt = r.output;
                // look for "ip": "x.x.x.x"
                auto p = txt.indexOf("\"ip\"");
                if (p >= 0) {
                    auto q1 = txt.indexOf("\"", p+4);
                    if (q1 >= 0) {
                        auto q2 = txt.indexOf("\"", q1+1);
                        if (q2 > q1) egressIp = txt[q1+1 .. q2].strip();
                    }
                }
                if (egressIp.length == 0) {
                    // fallback mullvad_exit_ip
                    auto p2 = txt.indexOf("mullvad_exit_ip");
                    if (p2 >= 0) {
                        auto q1 = txt.indexOf("\"", p2+15);
                        if (q1 >= 0) {
                            auto q2 = txt.indexOf("\"", q1+1);
                            if (q2 > q1) egressIp = txt[q1+1 .. q2].strip();
                        }
                    }
                }
                if (egressIp.length == 0) {
                    // fallback: first ip-like token
                    import std.regex : regex, matchFirst;
                    try {
                        auto re = regex(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`);
                        auto m = matchFirst(txt, re);
                        if (!m.empty) egressIp = m.hit;
                    } catch (Exception) {}
                }
            } else if (r.output.length > 0) {
                // am.i check failed but TCP healthy → keep healthy, surface note
                if (err.length == 0) err = "am.i check skipped: " ~ r.output.strip()[0 .. (r.output.length > 120 ? 120 : $)];
            }
        } catch (Exception e) {
            if (err.length == 0) err = "am.i check skipped: " ~ e.msg;
        }
    }
    Json data = Json.emptyObject;
    data["label"] = Json(label);
    data["healthy"] = Json(healthy);
    data["ip"] = Json(ip);
    data["egressIp"] = Json(egressIp);
    data["checkedAt"] = Json(_isoNow());
    data["error"] = Json(err);
    jsonOk(res, data);
}

/// POST /api/admin/mullvad/test-all — probe all proxies
package void apiMullvadTestAll(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower;
    auto raw = mullvadRawPool();
    auto entries = parseMullvadPool(raw);
    Json[] results;
    foreach (ent; entries) {
        auto probe = _probeSocks(ent.host, ent.port);
        string egressIp = "";
        string err = probe.error;
        bool healthy = probe.healthy;
        if (healthy) {
            try {
                import std.process : executeShell;
                auto cmd = "curl --socks5-hostname " ~ ent.host ~ ":" ~ ent.port.to!string ~ " -s --max-time 6 https://am.i.mullvad.net/json 2>&1";
                auto r = executeShell(cmd);
                if (r.status == 0 && r.output.length > 0) {
                    import std.string : indexOf;
                    auto txt = r.output;
                    auto p = txt.indexOf("\"ip\"");
                    if (p >= 0) {
                        auto q1 = txt.indexOf("\"", p+4);
                        if (q1 >= 0) {
                            auto q2 = txt.indexOf("\"", q1+1);
                            if (q2 > q1) egressIp = txt[q1+1 .. q2].strip();
                        }
                    }
                    if (egressIp.length == 0) {
                        import std.regex : regex, matchFirst;
                        try {
                            auto re = regex(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`);
                            auto m = matchFirst(txt, re);
                            if (!m.empty) egressIp = m.hit;
                        } catch (Exception) {}
                    }
                }
            } catch (Exception) {}
        }
        Json j = Json.emptyObject;
        j["label"] = Json(ent.label);
        j["healthy"] = Json(healthy);
        j["ip"] = Json(ent.resolvedIp);
        j["egressIp"] = Json(egressIp);
        j["checkedAt"] = Json(_isoNow());
        j["error"] = Json(err);
        results ~= j;
    }
    Json data = Json.emptyObject;
    data["results"] = Json(results);
    jsonOk(res, data);
}

/// POST /api/admin/mullvad/server/:serverId/egress — set per-engine override
package void apiMullvadServerEgressSet(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis, ServerRegistry serverRegistry) {
    import std.string : toLower, strip;
    auto serverId = req.params["serverId"].strip();
    if (serverId.length == 0) serverId = req.params["serverId"].strip();
    if (serverId.length == 0) { jsonError(res, 400, "serverId required"); return; }
    auto body = readJsonBody(req);
    string egressNodeId = "";
    if (body.type == Json.Type.object && body["egressNodeId"].type != Json.Type.undefined) {
        try { egressNodeId = body["egressNodeId"].get!string.strip().toLower(); } catch (Exception) {}
    } else if (body.type == Json.Type.object && body["egress"].type != Json.Type.undefined) {
        try { egressNodeId = body["egress"].get!string.strip().toLower(); } catch (Exception) {}
    }
    if (egressNodeId == "random" || egressNodeId == "auto") egressNodeId = "";
    if (egressNodeId.length > 0) {
        auto raw = mullvadRawPool();
        auto entries = parseMullvadPool(raw);
        bool ok = false;
        foreach (e; entries) if (e.label.toLower() == egressNodeId) { ok = true; break; }
        if (!ok) { jsonError(res, 400, "unknown egress label: " ~ egressNodeId); return; }
    }
    // set in registry
    try {
        serverRegistry.setEngineEgress(serverId, egressNodeId);
    } catch (Exception e) { jsonError(res, 500, e.msg); return; }
    // push reconnect for all networks on that server so they pick up override
    int affected = 0;
    try {
        auto nets = serverRegistry.getNetworksForServer(serverId);
        if (nets.length == 0) {
            // fallback to canonical assignments
            foreach (na; serverRegistry.getAllAssignments()) if (na.serverId == serverId) nets ~= na.networkId;
        }
        auto netRepo = new NetworkRepository();
        foreach (nid; nets) {
            try {
                import std.uuid : parseUUID;
                auto uuid = parseUUID(nid);
                auto cfg = netRepo.findById(uuid);
                if (cfg.id == typeof(cfg.id).init) continue;
                auto owner = netRepo.findByIdWithUser(uuid);
                string ownerId = owner.userId != typeof(owner.userId).init ? owner.userId.toString() : "";
                auto msg = ControlMessage("reconnectNetwork", nid, ownerId, cfg.toJson());
                msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
                affected++;
            } catch (Exception e) { logWarn("server egress push for %s failed: %s", nid, e.msg); }
        }
        logInfo("Admin set engine %s egress to '%s' — pushed %d reconnects", serverId, egressNodeId, affected);
    } catch (Exception e) { logWarn("server egress reconnect push failed: %s", e.msg); }
    Json data = Json.emptyObject;
    data["serverId"] = Json(serverId);
    data["egressNodeId"] = Json(egressNodeId);
    data["affectedNetworks"] = Json(affected);
    jsonOk(res, data);
}

/// DELETE /api/admin/mullvad/server/:serverId/egress — clear override
package void apiMullvadServerEgressClear(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis, ServerRegistry serverRegistry) {
    auto serverId = req.params["serverId"].strip();
    if (serverId.length == 0) { jsonError(res, 400, "serverId required"); return; }
    try { serverRegistry.setEngineEgress(serverId, ""); } catch (Exception e) { jsonError(res, 500, e.msg); return; }
    int affected = 0;
    try {
        auto nets = serverRegistry.getNetworksForServer(serverId);
        if (nets.length == 0) foreach (na; serverRegistry.getAllAssignments()) if (na.serverId == serverId) nets ~= na.networkId;
        auto netRepo = new NetworkRepository();
        foreach (nid; nets) {
            try {
                import std.uuid : parseUUID;
                auto uuid = parseUUID(nid);
                auto cfg = netRepo.findById(uuid);
                if (cfg.id == typeof(cfg.id).init) continue;
                auto owner = netRepo.findByIdWithUser(uuid);
                string ownerId = owner.userId != typeof(owner.userId).init ? owner.userId.toString() : "";
                auto msg = ControlMessage("reconnectNetwork", nid, ownerId, cfg.toJson());
                msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
                redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
                affected++;
            } catch (Exception e) { logWarn("clear egress push for %s failed: %s", nid, e.msg); }
        }
        logInfo("Admin cleared engine %s egress — pushed %d reconnects", serverId, affected);
    } catch (Exception e) { logWarn("clear egress push failed: %s", e.msg); }
    Json data = Json.emptyObject;
    data["serverId"] = Json(serverId);
    data["egressNodeId"] = Json("");
    data["affectedNetworks"] = Json(affected);
    jsonOk(res, data);
}

/// POST /api/admin/networks/:id/egress — set egressNodeId ("" = random, else pinned label)
package void apiNetworkEgressSet(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis, ServerRegistry serverRegistry) {
    import std.uuid : parseUUID;
    import std.string : toLower, strip;
    // `parseUUID` binds an lvalue string by ref and *consumes* the range,
    // which used to leave `networkIdStr` empty: the reconnect push below
    // then looked up server "" and the pin only took effect on the next
    // natural reconnect. Parse a throwaway copy and keep the id intact.
    auto networkIdStr = req.params["id"].idup;
    UUID networkId;
    {
        auto toParse = networkIdStr;
        try { networkId = parseUUID(toParse); }
        catch (Exception e) { jsonError(res, 400, "Invalid network id: " ~ e.msg); return; }
    }
    auto body = readJsonBody(req);
    string egressNodeId = "";
    if (body.type == Json.Type.object && body["egressNodeId"].type != Json.Type.undefined) {
        try { egressNodeId = body["egressNodeId"].get!string.strip().toLower(); } catch (Exception) {}
    } else if (body.type == Json.Type.object && body["egress"].type != Json.Type.undefined) {
        try { egressNodeId = body["egress"].get!string.strip().toLower(); } catch (Exception) {}
    }
    // "random" / "auto" / "" all mean random
    if (egressNodeId == "random" || egressNodeId == "auto") egressNodeId = "";
    // Same validation the user-facing PUT /api/networks does: an admin pin
    // must be a location this deployment can serve, and must not silently
    // require yanking an exit that is carrying live connections.
    if (!_validateAdminEgressPin(egressNodeId, res, redis, serverRegistry)) return;
    auto netRepo = new NetworkRepository();
    auto existing = netRepo.findById(networkId);
    if (existing.id == typeof(existing.id).init) { jsonError(res, 404, "Network not found"); return; }
    netRepo.setEgressNodeId(networkId, egressNodeId);
    // invalidate user cache
    try {
        auto owner = netRepo.findByIdWithUser(networkId);
        if (owner.userId != typeof(owner.userId).init) redis.del(RedisKeys.userNetworks(owner.userId.toString()));
    } catch (Exception) {}
    // push reconnect so engine picks new egress on next attempt
    try {
        auto cfg = netRepo.findById(networkId);
        auto owner = netRepo.findByIdWithUser(networkId);
        string ownerId = owner.userId != typeof(owner.userId).init ? owner.userId.toString() : "";
        auto serverId = serverRegistry.getServerForNetwork(networkIdStr);
        if (serverId.length == 0 || !serverRegistry.isServerHealthy(serverId)) serverId = serverRegistry.reassignNetwork(networkIdStr);
        if (serverId.length > 0) {
            auto msg = ControlMessage("reconnectNetwork", networkIdStr, ownerId, cfg.toJson());
            msg.timestampMs = Clock.currTime.toUnixTime!long * 1000;
            redis.lpush(RedisKeys.control(serverId), msg.toJson().toString());
        }
    } catch (Exception e) { logWarn("egress set control push failed: %s", e.msg); }
    Json data = Json.emptyObject;
    data["networkId"] = Json(networkIdStr);
    data["egressNodeId"] = Json(egressNodeId);
    jsonOk(res, data);
}

package void apiUploadsList(HTTPServerRequest req, HTTPServerResponse res) {
    int page = 0;
    int limit = 50;
    if (auto p = "page" in req.query) page = (*p).to!int;
    if (auto l = "limit" in req.query) limit = (*l).to!int;
    if (limit > 200) limit = 200;

    auto uploadRepo = new UploadRepository();
    auto userRepo = new UserRepository();
    auto raw = uploadRepo.listAll(page * limit, limit);
    auto total = uploadRepo.countAll();

    Json[] arr;
    foreach (r; raw) {
        Json u = Json.emptyObject;
        u["id"] = Json(r.id);
        u["userId"] = Json(r.userId);
        u["filename"] = Json(r.filename);
        u["buffer"] = Json(r.buffer);
        u["mimeType"] = Json(r.mimeType);
        u["size"] = Json(r.size);
        u["directUrl"] = Json(r.directUrl);
        u["createdAt"] = Json(r.createdAt);
        try {
            auto uid = parseUUID(r.userId);
            auto usr = userRepo.findById(uid);
            u["username"] = Json(usr.username.length > 0 ? usr.username : "unknown");
        } catch (Exception) { u["username"] = Json("unknown"); }
        arr ~= u;
    }
    Json data = Json.emptyObject;
    data["uploads"] = Json(arr);
    data["total"] = Json(total);
    data["page"] = Json(page);
    data["limit"] = Json(limit);
    jsonOk(res, data);
}

package void apiUploadDelete(HTTPServerRequest req, HTTPServerResponse res) {
    import ircfiber.db.mongo : AppMongoConnection;
    import ircfiber.db.uploads : UploadRecord;
    import std.file : remove;
    import std.path : buildPath;
    import ircfiber.upload.local : uploadDir;
    import vibe.data.bson : Bson;

    auto id = req.params["id"];
    auto coll = AppMongoConnection.getDb()["uploads"];
    auto doc = coll.findOne(Bson(["_id": Bson(id)]));
    if (!doc.isNull) {
        const rec = UploadRecord.fromBson(doc);
        auto url = rec.directUrl.strip;
        auto prefixPos = url.indexOf("/uploads/");
        if (prefixPos != -1) {
            auto filename = url[prefixPos + "/uploads/".length .. $];
            if (filename.length > 0) {
                try remove(buildPath(uploadDir(), filename));
                catch (Exception) {}
            }
        }
        coll.deleteOne(Bson(["_id": Bson(id)]));
        logInfo("Admin deleted upload %s", id);
    }
    Json data = Json.emptyObject;
    data["deletedId"] = Json(id);
    jsonOk(res, data);
}