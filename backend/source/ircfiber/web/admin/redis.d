module ircfiber.web.admin.redis;

import std.string : strip, splitLines, indexOf;
import std.algorithm : canFind;
import std.array : split;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logWarn;
import vibe.data.json : Json;

import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, queryString, jsonArray;

/// GET /api/admin/redis/info — full INFO document with sections.
package void apiRedisInfo(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    Json data = Json.emptyObject;
    try {
        data["info"] = redis.infoJson();
        data["dbsize"] = Json(redis.dbsizeSafe());
    } catch (Exception e) {
        data["error"] = Json(e.msg);
    }
    jsonOk(res, data);
}

/// GET /api/admin/redis/summary — small dashboard card.
package void apiRedisSummary(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    Json data = Json.emptyObject;
    try {
        auto info = redis.infoJson();
        // Server
        if ("Server" in info) {
            auto s = info["Server"];
            if ("redis_version" in s) data["version"] = s["redis_version"];
            if ("uptime_in_seconds" in s) data["uptimeSeconds"] = s["uptime_in_seconds"];
            if ("os" in s) data["os"] = s["os"];
        }
        // Clients
        if ("Clients" in info) {
            auto c = info["Clients"];
            if ("connected_clients" in c) data["connectedClients"] = c["connected_clients"];
        }
        // Memory
        if ("Memory" in info) {
            auto m = info["Memory"];
            if ("used_memory" in m) data["usedMemory"] = m["used_memory"];
            if ("used_memory_human" in m) data["usedMemoryHuman"] = m["used_memory_human"];
            if ("used_memory_peak" in m) data["usedMemoryPeak"] = m["used_memory_peak"];
            if ("used_memory_peak_human" in m) data["usedMemoryPeakHuman"] = m["used_memory_peak_human"];
        }
        // Stats
        if ("Stats" in info) {
            auto s = info["Stats"];
            if ("total_connections_received" in s) data["totalConnections"] = s["total_connections_received"];
            if ("total_commands_processed" in s) data["totalCommandsProcessed"] = s["total_commands_processed"];
            if ("instantaneous_ops_per_sec" in s) data["opsPerSec"] = s["instantaneous_ops_per_sec"];
            if ("keyspace_hits" in s) data["keyspaceHits"] = s["keyspace_hits"];
            if ("keyspace_misses" in s) data["keyspaceMisses"] = s["keyspace_misses"];
            // Compute hit ratio
            try {
                long hits = 0, misses = 0;
                if ("keyspace_hits" in s) hits = s["keyspace_hits"].get!long;
                if ("keyspace_misses" in s) misses = s["keyspace_misses"].get!long;
                if (hits + misses > 0) {
                    double ratio = cast(double) hits / cast(double)(hits + misses);
                    data["hitRatio"] = Json(ratio);
                }
            } catch (Exception) {}
        }
        // Keyspace
        if ("Keyspace" in info) {
            data["keyspace"] = info["Keyspace"];
        }
        data["dbsize"] = Json(redis.dbsizeSafe());
    } catch (Exception e) {
        data["error"] = Json(e.msg);
    }
    jsonOk(res, data);
}

/// GET /api/admin/redis/keys?cursor=...&match=...&count=...
package void apiRedisKeys(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    import std.conv : to;
    // GET route: the parameters live in the query string. `formString`
    // reads `req.form`, which is empty for a GET, so it silently pinned
    // every request to match="*" / cursor="0" (no filter, no paging).
    auto match = queryString(req, "match", "*");
    if (match.length == 0) match = "*";
    long count = 100;
    if (auto c = "count" in req.query) {
        try count = (*c).to!long;
        catch (Exception) {}
    }
    if (count < 1) count = 1;
    if (count > 1000) count = 1000;
    auto cursor = queryString(req, "cursor", "0");
    if (cursor.length == 0) cursor = "0";

    try {
        auto result = redis.scanKeys(cursor, match, count);
        Json data = Json.emptyObject;
        data["cursor"] = Json(result.cursor);
        data["keys"] = jsonArray(result.keys);
        data["match"] = Json(match);
        data["count"] = Json(count);
        // Enrich each key with type + ttl
        Json[] enriched;
        foreach (k; result.keys) {
            Json e = Json.emptyObject;
            e["key"] = Json(k);
            e["meta"] = redis.keyMeta(k);
            enriched ~= e;
        }
        data["entries"] = Json(enriched);
        jsonOk(res, data);
    } catch (Exception e) {
        logWarn("apiRedisKeys failed: %s", e.msg);
        jsonError(res, 500, e.msg);
    }
}

/// GET /api/admin/redis/keys/:key — type/ttl/memory/sample.
package void apiRedisKeyDetail(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto key = req.params["key"];
    Json data = Json.emptyObject;
    data["key"] = Json(key);
    try {
        data["meta"] = redis.keyMeta(key);
        data["sample"] = Json(redis.keySample(key, 1024));
    } catch (Exception e) {
        data["error"] = Json(e.msg);
    }
    jsonOk(res, data);
}

/// GET /api/admin/redis/slowlog — most recent slow entries.
package void apiRedisSlowlog(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    import std.conv : to;
    long count = 50;
    if (auto c = "count" in req.query) {
        try count = (*c).to!long;
        catch (Exception) {}
    }
    if (count < 1) count = 1;
    if (count > 500) count = 500;

    Json data = Json.emptyObject;
    data["count"] = Json(count);
    try {
        // `redis.slowlog` returns parsed entries: the reply's nested command
        // arrays are flattened server-side (see storage/redis.d), because a
        // flat read of them desynchronises the pooled connection.
        Json[] arr;
        foreach (e; redis.slowlog(count)) {
            Json entry = Json.emptyObject;
            entry["id"] = Json(e.id);
            entry["timestampMs"] = Json(e.timestampMs);
            entry["durationMicros"] = Json(e.durationMicros);
            entry["command"] = jsonArray(e.command);
            arr ~= entry;
        }
        data["entries"] = Json(arr);
        data["entryCount"] = Json(cast(long) arr.length);
        jsonOk(res, data);
    } catch (Exception e) {
        logWarn("apiRedisSlowlog failed: %s", e.msg);
        data["error"] = Json(e.msg);
        jsonOk(res, data);
    }
}

/// GET /api/admin/redis/pubsub — active channels.
package void apiRedisPubsub(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    Json data = Json.emptyObject;
    try {
        auto pattern = queryString(req, "pattern", "*");
        if (pattern.length == 0) pattern = "*";
        data["channels"] = jsonArray(redis.pubsubChannels(pattern));
    } catch (Exception e) {
        data["error"] = Json(e.msg);
    }
    jsonOk(res, data);
}

/// GET /api/admin/redis/clients — CLIENT LIST (truncated).
package void apiRedisClients(HTTPServerRequest, HTTPServerResponse res, RedisStorage redis) {
    try {
        auto raw = redis.clientList();
        Json data = Json.emptyObject;
        Json[] parsed;
        foreach (line; raw.splitLines()) {
            if (line.length == 0) continue;
            Json entry = Json.emptyObject;
            foreach (pair; line.split(' ')) {
                auto eq = pair.indexOf('=');
                if (eq > 0) {
                    auto k = pair[0 .. eq];
                    auto v = pair[eq + 1 .. $];
                    entry[k] = Json(v);
                }
            }
            parsed ~= entry;
        }
        data["clients"] = Json(parsed);
        data["raw"] = Json(raw);
        jsonOk(res, data);
    } catch (Exception e) {
        logWarn("apiRedisClients failed: %s", e.msg);
        jsonError(res, 500, e.msg);
    }
}