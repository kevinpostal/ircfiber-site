/**
 * ipinfo.io geo/ASN lookups, cached in Redis.
 *
 * Two endpoints, two callers:
 *
 *   - `lookupGeo` — Core (`/<ip>/json`), for the #staff log bot. One HTTP
 *     GET per never-before-seen IP; the raw answer is cached under
 *     `logsGeoKey(ip)` for `IRCFIBER_LOGS_GEO_TTL` seconds (7 days by
 *     default). The presence of that key is also what "first sighting"
 *     means: the first connect from an IP gets the full geo report, later
 *     connects only a compact `known IP (City, CC)` suffix.
 *   - `lookupAsn` — Lite (`api.ipinfo.io/lite/<ip>`), for the admin Mullvad
 *     page's ISP/ASN column. Cached under its own key so it can never
 *     consume the marker above.
 *
 * All IO is vibe.d fiber-aware (`requestHTTP`) — never `std.net.curl` or
 * a shelled-out `curl`, which would block the bot's IRC read loop.
 *
 * Env:
 *   IRCFIBER_IPINFO_TOKEN(_FILE)  ipinfo.io API token; unset → no lookups
 *                                 (lines render `geo unavailable`)
 *   IRCFIBER_IPINFO_URL           default https://ipinfo.io
 *   IRCFIBER_IPINFO_LITE_URL      default https://api.ipinfo.io/lite
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
import ircfiber.logs.format : AsnInfo, GeoInfo, isPrivateIp;
import ircfiber.storage.redis : RedisStorage;

/// Resolved ipinfo.io settings.
struct GeoSettings {
    string token;
    string baseUrl = "https://ipinfo.io";
    /// Lite endpoint base. A separate host *and* a separate plan: the basic
    /// token this deployment holds can read `/lite/<ip>` (`asn`, `as_name`,
    /// `as_domain`) but not `ipinfo.io/AS<n>/json`, which answers
    /// *Token does not have access to this API*.
    string liteUrl = "https://api.ipinfo.io/lite";
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
    auto lite = environment.get("IRCFIBER_IPINFO_LITE_URL", "").strip();
    if (lite.length) {
        while (lite.length && lite[$ - 1] == '/') lite = lite[0 .. $ - 1];
        s.liteUrl = lite;
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

/// Cache-only geo: reads `logsGeoKey(ip)` and never issues an HTTP
/// request, so it cannot consume the first-sighting marker `lookupGeo`
/// owns. Returns `GeoInfo.init` when the IP has not been looked up yet.
///
/// FiberEye uses this instead of `lookupGeo`: whichever bot performed the
/// lookup would set the cache key and thereby make the other one report
/// `firstSighting = false`, silently dropping the `↳ <ip> · <geo detail>`
/// follow-up line from the #staff announcement. Only the #staff bot ever
/// spends an ipinfo request.
GeoInfo cachedGeo(RedisStorage redis, string ip) {
    GeoInfo none;
    const addr = ip.strip();
    if (redis is null || !addr.length || isPrivateIp(addr)) return none;
    try {
        auto cached = redis.getJson(logsGeoKey(addr));
        if (cached.type != Json.Type.object) return none;
        auto g = geoFromIpinfoJson(cached, addr);
        g.cached = true;
        return g;
    } catch (Exception e) {
        logWarn("FiberEye: geo cache read failed for %s: %s", addr, e.msg);
        return none;
    }
}

/// Cache key for a Lite ASN answer. Deliberately NOT `logsGeoKey`: the
/// presence of that key is the #staff bot's "first sighting" marker, so
/// warming it from the admin Mullvad page would silently drop the full geo
/// report from the next connect announcement for the same IP — the reason
/// FiberEye reads through `cachedGeo` instead of looking anything up.
string ipinfoAsnKey(string ip) @safe pure { return "irc:ipinfo:asn:" ~ ip; }

/// Maps a Lite payload — `{"ip":…,"asn":"AS39351","as_name":"31173
/// Services AB","as_domain":"31173.se","country_code":"NL",…}` — onto
/// `AsnInfo`. An absent field stays empty, never "unknown".
AsnInfo asnFromLiteJson(Json j) {
    AsnInfo a;
    if (j.type != Json.Type.object) return a;
    string getStr(string k) {
        auto v = j[k];
        return v.type == Json.Type.string ? v.get!string.strip() : "";
    }
    a.asn = getStr("asn");
    a.name = getStr("as_name");
    a.domain = getStr("as_domain");
    a.ok = a.asn.length > 0 || a.name.length > 0;
    return a;
}

/// ASN and operator (ISP) behind `ip`, from the Lite endpoint, cached in
/// Redis under `ipinfoAsnKey` for the geo TTL — an address changes operator
/// far more rarely than it changes user, so 7 days is conservative.
///
/// Returns `AsnInfo.init` with no token configured, for an empty or private
/// address, and on any HTTP/parse failure; the caller then falls back to
/// `asnFromOrg` over the Core endpoint's `org` string. Never throws.
AsnInfo lookupAsn(RedisStorage redis, const GeoSettings s, string ip) {
    AsnInfo none;
    const addr = ip.strip();
    if (!addr.length || isPrivateIp(addr)) return none;

    const key = ipinfoAsnKey(addr);
    if (redis !is null) {
        try {
            auto cached = redis.getJson(key);
            if (cached.type == Json.Type.object) {
                auto hit = asnFromLiteJson(cached);
                if (hit.ok) return hit;
            }
        } catch (Exception e) {
            logWarn("ipinfo: asn cache read failed for %s: %s", addr, e.msg);
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
        requestHTTP(s.liteUrl ~ "/" ~ addr,
            (scope HTTPClientRequest req) {
                req.method = HTTPMethod.GET;
                req.headers["Authorization"] = "Bearer " ~ s.token;
                req.headers["Accept"] = "application/json";
                req.headers["Connection"] = "close";
            },
            (scope HTTPClientResponse res) {
                status = res.statusCode;
                try body_ = cast(string) res.bodyReader.readAll();
                catch (Exception e) logWarn("ipinfo: reading asn response failed: %s", e.msg);
            },
            settings);
        if (status < 200 || status >= 300) {
            logWarn("ipinfo: asn lookup for %s returned HTTP %s", addr, status);
            return none;
        }
        payload = parseJsonString(body_);
    } catch (Exception e) {
        logWarn("ipinfo: asn lookup for %s failed: %s", addr, e.msg);
        return none;
    }

    auto a = asnFromLiteJson(payload);
    if (!a.ok) {
        logWarn("ipinfo: asn answer for %s carried no asn/as_name", addr);
        return none;
    }
    // Cache the raw answer, not the struct: a later field mapping change
    // then applies to already-cached IPs too.
    if (redis !is null) {
        try redis.setJson(key, payload, s.ttlSeconds);
        catch (Exception e) logWarn("ipinfo: asn cache write failed for %s: %s", addr, e.msg);
    }
    return a;
}
