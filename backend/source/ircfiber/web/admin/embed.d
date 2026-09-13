module ircfiber.web.admin.embed;

import vibe.data.json : Json;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.embed : EMBED_ORIGINS_KEY, EMBED_ORIGINS_MAX, loadEmbedOrigins,
    setEmbedOrigins, validateEmbedOrigins;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonArray, jsonError, jsonOk, readJsonBody;

/// GET /api/admin/config/embed-origins — {origins, key, max}
package void apiEmbedOrigins(HTTPServerRequest req, HTTPServerResponse res,
                             RedisStorage redis) {
    Json data = Json.emptyObject;
    data["origins"] = jsonArray(loadEmbedOrigins(redis));
    data["key"] = Json(EMBED_ORIGINS_KEY);
    data["max"] = Json(cast(long) EMBED_ORIGINS_MAX);
    jsonOk(res, data);
}

/// POST /api/admin/config/embed-origins — {origins: string[]} → {origins, count}
package void apiEmbedOriginsSet(HTTPServerRequest req, HTTPServerResponse res,
                                RedisStorage redis) {
    auto body = readJsonBody(req);
    string[] submitted;
    try {
        auto arr = body["origins"];
        if (arr.type != Json.Type.array) throw new Exception("origins array required");
        foreach (entry; arr.get!(Json[])) {
            if (entry.type != Json.Type.string) throw new Exception("origins must be strings");
            submitted ~= entry.get!string;
        }
    } catch (Exception e) {
        jsonError(res, 400, "origins array required");
        return;
    }

    string[] accepted;
    auto errors = validateEmbedOrigins(submitted, accepted);
    if (errors.length > 0) {
        // Same shape the FiberEye rules editor renders: a headline plus one
        // message per rejected entry.
        res.statusCode = 400;
        res.headers["Content-Type"] = "application/json; charset=utf-8";
        auto payload = Json.emptyObject;
        payload["ok"] = Json(false);
        payload["error"] = Json("one or more origins were rejected");
        payload["errors"] = jsonArray(errors);
        res.writeBody(payload.toString());
        return;
    }

    try {
        setEmbedOrigins(redis, accepted);
    } catch (Exception e) {
        jsonError(res, 502, "could not save allowlist: " ~ e.msg);
        return;
    }

    Json data = Json.emptyObject;
    data["origins"] = jsonArray(accepted);
    data["count"] = Json(cast(long) accepted.length);
    jsonOk(res, data);
}
