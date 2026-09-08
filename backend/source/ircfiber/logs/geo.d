/**
 * ipinfo.io geo/ASN lookups for the #staff log bot, cached in Redis.
 *
 * One HTTP GET per never-before-seen IP; the raw answer is cached under
 * `logsGeoKey(ip)` for `IRCFIBER_LOGS_GEO_TTL` seconds (7 days by
 * default). The presence of that key is also what "first sighting" means:
 * the first connect from an IP gets the full geo report, later connects
 * only a compact `known IP (City, CC)` suffix.
 *
 * All IO is vibe.d fiber-aware (`requestHTTP`) — never `std.net.curl` or
 * a shelled-out `curl`, which would block the bot's IRC read loop.
 *
 * Env:
 *   IRCFIBER_IPINFO_TOKEN(_FILE)  ipinfo.io API token; unset → no lookups
 *                                 (lines render `geo unavailable`)
 *   IRCFIBER_IPINFO_URL           default https://ipinfo.io
 *   IRCFIBER_IPINFO_TIMEOUT       connect/read timeout, seconds (default 5)
 *   IRCFIBER_LOGS_GEO_TTL         cache TTL, seconds (default 604800)
 */
module ircfiber.logs.geo;

import std.conv : to;
import std.process : environment;
import std.string : strip;
import core.time : seconds;

import vibe.core.log;
import vibe.data.json : Json, parseJsonString;
import vibe.http.client : HTTPClientRequest, HTTPClientResponse, HTTPClientSettings, requestHTTP;
import vibe.http.common : HTTPMethod;
import vibe.stream.operations : readAll;

import ircfiber.env : envSecret;
import ircfiber.logs.events : logsGeoKey;
import ircfiber.logs.format : GeoInfo, isPrivateIp;
import ircfiber.storage.redis : RedisStorage;

/// Resolved ipinfo.io settings.
struct GeoSettings {
    string token;
    string baseUrl = "https://ipinfo.io";
    int timeoutSeconds = 5;
    long ttlSeconds = 604_800;
}

/// Reads `GeoSettings` from the environment (token via `envSecret`, so the
/// `_FILE` form used in prod wins over an inline value).
GeoSettings loadGeoSettings() {
    GeoSettings s;
    s.token = envSecret("IRCFIBER_IPINFO_TOKEN", "").strip();
    auto url = environment.get("IRCFIBER_IPINFO_URL", "").strip();
    if (url.length) {
        while (url.length && url[$ - 1] == '/') url = url[0 .. $ - 1];
        s.baseUrl = url;
    }
    try {
        auto t = environment.get("IRCFIBER_IPINFO_TIMEOUT", "").strip();
        if (t.length) s.timeoutSeconds = t.to!int;
    } catch (Exception) {}
    if (s.timeoutSeconds <= 0) s.timeoutSeconds = 5;
    try {
        auto ttl = environment.get("IRCFIBER_LOGS_GEO_TTL", "").strip();
        if (ttl.length) s.ttlSeconds = ttl.to!long;
    } catch (Exception) {}
    if (s.ttlSeconds <= 0) s.ttlSeconds = 604_800;
    return s;
}

/// Maps an ipinfo.io payload onto `GeoInfo`. Tolerates the free tier
/// (no `privacy` object, `latitude`/`longitude` instead of `loc`); an
/// absent field renders nothing, never "unknown".
GeoInfo geoFromIpinfoJson(Json j, string ip) {
    GeoInfo g;
    g.ip = ip;
    if (j.type != Json.Type.object) return g;
    string getStr(string k) {
        auto v = j[k];
        return v.type == Json.Type.string ? v.get!string.strip() : "";
    }
    g.city = getStr("city");
    g.region = getStr("region");
    g.country = getStr("country");
    g.org = getStr("org");
    if (!g.org.length) g.org = getStr("asn");
    g.timezone = getStr("timezone");
    g.postal = getStr("postal");
    g.hostname = getStr("hostname");
    g.loc = getStr("loc");
    if (!g.loc.length) {
        const lat = getStr("latitude");
        const lon = getStr("longitude");
        if (lat.length && lon.length) g.loc = lat ~ "," ~ lon;
    }
    auto priv = j["privacy"];
    if (priv.type == Json.Type.object) {
        string flags;
        foreach (name; ["vpn", "proxy", "tor", "hosting", "relay"]) {
            auto v = priv[name];
            if (v.type == Json.Type.bool_ && v.get!bool) {
                if (flags.length) flags ~= "+";
                flags ~= name;
            }
        }
        g.privacyFlags = flags;
    }
    g.ok = g.city.length > 0 || g.country.length > 0 || g.org.length > 0;
    return g;
}

/// Looks `ip` up, preferring the Redis cache. `firstSighting` is true only
/// when this call performed the lookup and cached it — i.e. the IP had not
/// been seen in the last TTL. Private, empty and unparsable addresses cost
/// nothing and return `GeoInfo.init`. Never throws.
GeoInfo lookupGeo(RedisStorage redis, const GeoSettings s, string ip, out bool firstSighting) {
    firstSighting = false;
    GeoInfo none;
    const addr = ip.strip();
    if (!addr.length || isPrivateIp(addr)) return none;

    const key = logsGeoKey(addr);
    if (redis !is null) {
        try {
            auto cached = redis.getJson(key);
            if (cached.type == Json.Type.object) {
                auto g = geoFromIpinfoJson(cached, addr);
                g.cached = true;
                return g;
            }
        } catch (Exception e) {
            logWarn("logs bot: geo cache read failed for %s: %s", addr, e.msg);
        }
    }

    if (!s.token.length) return none;

    Json payload = Json(null);
    int status = 0;
    try {
        auto settings = new HTTPClientSettings;
        settings.connectTimeout = s.timeoutSeconds.seconds;
        settings.readTimeout = s.timeoutSeconds.seconds;
        string body_;
        requestHTTP(s.baseUrl ~ "/" ~ addr ~ "/json",
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.GET;
                req.headers["Authorization"] = "Bearer " ~ s.token;
                req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try body_ = cast(string) res.bodyReader.readAll();
                catch (Exception e) logWarn("logs bot: reading ipinfo response failed: %s", e.msg);
            },
            settings);
        if (status < 200 || status >= 300) {
            logWarn("logs bot: ipinfo lookup for %s returned HTTP %s", addr, status);
            return none;
        }
        payload = parseJsonString(body_);
    } catch (Exception e) {
        logWarn("logs bot: ipinfo lookup for %s failed: %s", addr, e.msg);
        return none;
    }

    auto g = geoFromIpinfoJson(payload, addr);
    if (!g.ok) {
        logWarn("logs bot: ipinfo answer for %s carried no city/country/org", addr);
        return none;
    }
    // Cache the raw answer, not our struct: a later field mapping change
    // then applies to already-cached IPs too.
    if (redis !is null) {
        try redis.setJson(key, payload, s.ttlSeconds);
        catch (Exception e) logWarn("logs bot: geo cache write failed for %s: %s", addr, e.msg);
    }
    firstSighting = true;
    return g;
}
