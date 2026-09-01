module ircfiber.web.admin.replication;

import std.algorithm : canFind;
import std.string : toLower;
import std.datetime : Clock;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logWarn;
import vibe.data.json : Json;
import vibe.data.bson : Bson;

import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, jsonArray;
package void apiReplicationStatus(HTTPServerRequest, HTTPServerResponse res,
                                 RedisStorage redis) {
    Json data = Json.emptyObject;
    data["timestamp"] = Json(Clock.currTime.toUnixTime!long * 1000L);

    // ── Mongo ───────────────────────────────────────────────────────
    Json mongo = Json.emptyObject;
    bool mongoConnected = false;
    try {
        mongoConnected = AppMongoConnection.isConnected();
    } catch (Exception e) {
        mongo["error"] = Json(e.msg);
    }
    mongo["connected"] = Json(mongoConnected);
    mongo["dbName"] = Json(mongoConnected ? AppMongoConnection.name() : "");

    if (mongoConnected) {
        // Try replica set status
        try {
            // Use runCommand with Bson for replSetGetStatus
            Bson cmd = Bson.emptyObject;
            cmd["replSetGetStatus"] = Bson(1);
            auto result = AppMongoConnection.runCommand(cmd);
            auto j = result.toJson();

            // j has: ok, set, date, myState, members[]
            if ("set" in j) mongo["replicaSet"] = j["set"];
            if ("myState" in j) mongo["myState"] = j["myState"];
            if ("date" in j) mongo["date"] = j["date"];

            Json[] members;
            long primaryOptimeMs = -1;
            string primaryName = "";
            if (j["members"].type == Json.Type.array) {
                foreach (m; j["members"]) {
                    Json mm = Json.emptyObject;
                    // name, health, state, stateStr, uptime, optimeDate, lastHeartbeat, syncSourceHost
                    if ("name" in m) mm["name"] = m["name"];
                    if ("health" in m) mm["health"] = m["health"];
                    if ("state" in m) mm["state"] = m["state"];
                    if ("stateStr" in m) mm["stateStr"] = m["stateStr"];
                    if ("uptime" in m) mm["uptime"] = m["uptime"];
                    if ("optimeDate" in m) {
                        mm["optimeDate"] = m["optimeDate"];
                        // Try to capture optime as ms for lag calc
                        try {
                            // optimeDate may be string or Json with $date
                            // Keep raw for frontend to parse
                        } catch (Exception) {}
                    }
                    if ("optime" in m) mm["optime"] = m["optime"];
                    if ("lastHeartbeat" in m) mm["lastHeartbeat"] = m["lastHeartbeat"];
                    if ("lastHeartbeatRecv" in m) mm["lastHeartbeatRecv"] = m["lastHeartbeatRecv"];
                    if ("syncSourceHost" in m) mm["syncSourceHost"] = m["syncSourceHost"];
                    if ("syncSourceId" in m) mm["syncSourceId"] = m["syncSourceId"];
                    if ("infoMessage" in m) mm["infoMessage"] = m["infoMessage"];

                    // Track primary optime for lag
                    bool isPrimary = false;
                    if ("stateStr" in m) {
                        try { isPrimary = m["stateStr"].get!string == "PRIMARY"; } catch (Exception) {}
                    }
                    if (isPrimary) {
                        primaryName = m["name"].get!string;
                        // Try to extract optimeDate ms
                        try {
                            if ("optimeDate" in m) {
                                auto od = m["optimeDate"];
                                // Handle {"$date": ...} form
                                if (od.type == Json.Type.object && "$date" in od) {
                                    // Could be string or long
                                    auto inner = od["$date"];
                                    if (inner.type == Json.Type.string) {
                                        // ISO string, skip lag calc, frontend will handle
                                    } else if (inner.type == Json.Type.int_) {
                                        primaryOptimeMs = inner.get!long;
                                    }
                                } else if (od.type == Json.Type.string) {
                                    // ISO, skip
                                }
                            }
                            if ("optime" in m && m["optime"].type == Json.Type.object) {
                                auto op = m["optime"];
                                if ("ts" in op && op["ts"].type == Json.Type.object) {
                                    auto ts = op["ts"];
                                    if ("$timestamp" in ts) {
                                        auto t = ts["$timestamp"];
                                        if ("t" in t) primaryOptimeMs = t["t"].get!long * 1000;
                                    }
                                }
                            }
                        } catch (Exception) {}
                    }
                    members ~= mm;
                }
            }
            mongo["members"] = Json(members);
            mongo["primary"] = Json(primaryName);
            mongo["memberCount"] = Json(cast(long) members.length);

            // Compute lag if we have optimes
            // For simplicity, frontend will compute lag from optimeDate strings if needed.
            // We also try to compute heartbeat lag
            long healthyCount = 0;
            long secondaryCount = 0;
            foreach (m; members) {
                bool healthy = false;
                try { healthy = m["health"].get!int == 1; } catch (Exception) {}
                if (healthy) healthyCount++;
                try {
                    if (m["stateStr"].get!string == "SECONDARY") secondaryCount++;
                } catch (Exception) {}
            }
            mongo["healthyCount"] = Json(healthyCount);
            mongo["secondaryCount"] = Json(secondaryCount);

            // Overall mongo health: PRIMARY exists and at least one SECONDARY healthy
            bool hasPrimary = primaryName.length > 0;
            mongo["hasPrimary"] = Json(hasPrimary);
            mongo["isReplicaSet"] = Json(true);

            // Lag estimation: use max(secondary uptime? no). Instead use replication lag via optime
            // If we couldn't parse optime, leave lag as null
            if (primaryOptimeMs >= 0) mongo["primaryOptimeMs"] = Json(primaryOptimeMs);

        } catch (Exception e) {
            // Not in replica set or not authorized
            string msg = e.msg;
            mongo["replicaSetError"] = Json(msg);
            // Detect "not running with --replSet" or "no replset config"
            string low = msg.toLower();
            if (canFind(low, "noreplicationenabled") || canFind(low, "not running with --replset") || canFind(low, "no replset") || canFind(low, "noreplset")) {
                mongo["isReplicaSet"] = Json(false);
                mongo["singleNode"] = Json(true);
            } else if (canFind(low, "unauthorized") || canFind(low, "not authorized")) {
                mongo["authError"] = Json(true);
                mongo["isReplicaSet"] = Json(true);
            } else {
                mongo["isReplicaSet"] = Json(false);
            }
        }
        // Also include basic serverStatus/dbStats for context
        try {
            auto ss = AppMongoConnection.serverStatusSubset();
            mongo["serverStatus"] = ss.toJson();
        } catch (Exception e) {
            mongo["serverStatusError"] = Json(e.msg);
        }
        try {
            auto stats = AppMongoConnection.dbStats();
            mongo["dbStats"] = stats.toJson();
        } catch (Exception e) {
            mongo["dbStatsError"] = Json(e.msg);
        }
    }
    data["mongo"] = mongo;

    // ── Redis ───────────────────────────────────────────────────────
    Json redisJ = Json.emptyObject;
    bool redisConnected = false;
    try {
        // Try a simple ping via dbsize
        auto dbsz = redis.dbsizeSafe();
        redisConnected = dbsz >= 0;
        redisJ["connected"] = Json(redisConnected);
        redisJ["dbsize"] = Json(dbsz);
    } catch (Exception e) {
        redisJ["connected"] = Json(false);
        redisJ["error"] = Json(e.msg);
        redisConnected = false;
    }

    if (redisConnected) {
        try {
            auto info = redis.infoJson();
            // Extract replication section if present
            if ("Replication" in info) {
                redisJ["replication"] = info["Replication"];
            } else {
                redisJ["replication"] = Json.emptyObject;
            }
            // Also include Server, Memory, Stats for quick view
            if ("Server" in info) redisJ["server"] = info["Server"];
            if ("Memory" in info) redisJ["memory"] = info["Memory"];
            if ("Stats" in info) redisJ["stats"] = info["Stats"];
            if ("Clients" in info) redisJ["clients"] = info["Clients"];
            // Keyspace
            if ("Keyspace" in info) redisJ["keyspace"] = info["Keyspace"];

            // Global keys counts (the only keys shake should replicate)
            try {
                auto db = redis.getDb();
                // Use HLEN/SCARD/GET where applicable
                long assignments = -1, servers = -1;
                string globalEid = "";
                string protocolVersion = "";
                try { assignments = db.request!long("HLEN", "irc:assignments"); } catch (Exception) {}
                try { servers = db.request!long("SCARD", "irc:servers"); } catch (Exception) {}
                try { globalEid = db.request!string("GET", "irc:global_eid"); } catch (Exception) {}
                try { protocolVersion = db.request!string("GET", "irc:protocol:version"); } catch (Exception) {}

                Json g = Json.emptyObject;
                g["assignments"] = Json(assignments);
                g["servers"] = Json(servers);
                g["globalEid"] = Json(globalEid);
                g["protocolVersion"] = Json(protocolVersion);
                redisJ["globalKeys"] = g;
            } catch (Exception e) {
                redisJ["globalKeysError"] = Json(e.msg);
            }

            // Local ephemeral counts (for context, not replicated)
            try {
                auto db = redis.getDb();
                // Count scrollback keys via SCAN
                long scrollback = -1, dedup = -1, state = -1;
                // Use SCAN count via our helper would be slower; just use DBSIZE as proxy
                // For now, report dbsize and note split
                redisJ["ephemeralNote"] = Json("scrollback:* / dedup:* / irc:state:* are per-engine ephemeral and intentionally not replicated via shake");
            } catch (Exception) {}

        } catch (Exception e) {
            redisJ["infoError"] = Json(e.msg);
        }

        // Shake detection — we can't directly query shake, but we can infer:
        // If local redis is not OVH (100.94.72.103) and globalKeys match OVH's view,
        // shake is working. For now, report config-based status.
        Json shake = Json.emptyObject;
        // Detect if this gateway is k8s (has local redis) vs OVH (direct)
        // We report that shake is expected when running in k8s with hostNetwork mongo
        // but current deployment is scaled to 0 due to writer error (see logs).
        // Frontend will show "paused" when shake not running.
        try {
            // Check if shake deployment exists via env hint
            // We use a simple heuristic: if mongo isReplicaSet and redis is local, shake should be running
            bool expectShake = mongoConnected && redisConnected;
            shake["expected"] = Json(expectShake);
            shake["status"] = Json("paused");
            shake["reason"] = Json("redis-shake scaled to 0 - global keys currently per-cluster; unidirectional OVH->k8s will be re-enabled after image fix");
            shake["allowlist"] = jsonArray(["irc:servers", "irc:assignments", "irc:global_eid", "irc:protocol:version"]);
        } catch (Exception e) {
            shake["error"] = Json(e.msg);
        }
        redisJ["shake"] = shake;
    }
    data["redis"] = redisJ;

    // ── Overall ─────────────────────────────────────────────────────
    Json overall = Json.emptyObject;
    bool mongoOk = false;
    bool redisOk = false;
    try {
        mongoOk = mongo["hasPrimary"].type == Json.Type.bool_ ? mongo["hasPrimary"].get!bool : false;
        // Also require at least one healthy secondary if replicaSet
        if (mongoOk && "secondaryCount" in mongo) {
            long sec = 0;
            try { sec = mongo["secondaryCount"].get!long; } catch (Exception) {}
            // For our setup, 1 primary + 1 secondary is healthy
            mongoOk = mongoOk && sec >= 1;
        }
    } catch (Exception) {}
    try {
        redisOk = redisJ["connected"].type == Json.Type.bool_ ? redisJ["connected"].get!bool : false;
    } catch (Exception) {}

    overall["mongoOk"] = Json(mongoOk);
    overall["redisOk"] = Json(redisOk);
    overall["inSync"] = Json(mongoOk && redisOk);
    if (mongoOk && redisOk) overall["status"] = Json("in-sync");
    else if (!mongoOk && !redisOk) overall["status"] = Json("degraded");
    else overall["status"] = Json("partial");

    data["overall"] = overall;

    jsonOk(res, data);
}
