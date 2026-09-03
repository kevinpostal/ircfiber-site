module ircfiber.web.admin.logs;

///
// Gateway-side SigNoz query proxy for the admin Logs page.
//
// The browser used to call SigNoz directly through same-origin Caddy
// `/api/v1..5/*` routes, but that path is fragile: the Caddy block only
// renders when `/etc/ircfiber/signoz-mcp/.api_key` exists on the edge
// host, and the key it injects belongs to the retired local-docker
// SigNoz, not the k8s one. When the block is absent the browser gets a
// gateway 404 and the Logs page is dead with a misleading error.
//
// These endpoints keep the SigNoz query API (same request/response
// shapes the frontend already parses) but move the hop server-side:
// the gateway reaches the k8s SigNoz over the tailnet and holds the
// API key, so the browser needs nothing but its admin session.
//
// Env:
//   IRCFIBER_SIGNOZ_URL       base URL of the SigNoz query service.
//                             Default: https://signoz.ubuntu-docker.tail544547.ts.net
//                             IP literals work (see HOST override); the
//                             gateway container has no MagicDNS.
//   IRCFIBER_SIGNOZ_HOST      Host header override for IP-literal URLs
//                             behind SNI-routed ingress. Empty = URL host.
//   IRCFIBER_SIGNOZ_API_KEY   value of the SIGNOZ-API-KEY header.
//                             Empty = no auth header (queries 401).
//   IRCFIBER_SIGNOZ_INSECURE  "1" -> skip TLS peer validation. Needed
//                             while Traefik serves its default
//                             self-signed cert; tailnet transport is
//                             still WireGuard-encrypted.
// Secrets (API key) never appear in logs or error strings.
//

import std.conv : to;
import std.string : strip;
import core.time : seconds;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.http.client : requestHTTP, HTTPMethod, HTTPClientSettings,
    HTTPClientRequest, HTTPClientResponse;
import vibe.stream.tls : TLSContext, TLSPeerValidationMode;
import vibe.stream.operations : readAll;
import vibe.core.log : logWarn, logInfo;
import vibe.data.json : Json, parseJsonString;

import ircfiber.web.admin.helpers : jsonError;

/// SigNoz connection settings. All from env so no secret is committed.
struct SignozSettings {
    string url = "https://signoz.ubuntu-docker.tail544547.ts.net";
    string hostHeader;
    string apiKey;
    bool insecure;

    bool configured() const {
        return url.length > 0;
    }
}

SignozSettings loadSignozSettings() {
    import std.process : environment;
    SignozSettings st;
    try {
        auto u = environment.get("IRCFIBER_SIGNOZ_URL", "");
        if (u.length) st.url = u;
        st.hostHeader = environment.get("IRCFIBER_SIGNOZ_HOST", "");
        st.apiKey = environment.get("IRCFIBER_SIGNOZ_API_KEY", "");
        st.insecure = environment.get("IRCFIBER_SIGNOZ_INSECURE", "0") == "1";
    } catch (Exception) {}
    return st;
}

/// Forwards one SigNoz API call and mirrors the response back.
/// Transport failures and 401s become actionable gateway errors; every
/// other status passes through byte-identical so the frontend keeps
/// parsing the SigNoz envelope it knows. When `reshape` is set, a 200
/// JSON body is converted via reshapeQueryRange first (v0.138 envelope
/// into the legacy list shape); unparseable bodies pass through.
package void proxySignoz(HTTPServerResponse res, string method, string path, string body_, bool reshape = false) {
    auto st = loadSignozSettings();
    if (!st.configured()) {
        jsonError(res, 503, "SigNoz query API not configured (IRCFIBER_SIGNOZ_URL)");
        return;
    }
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 30.seconds;
    if (st.insecure) {
        // Traefik serves its default self-signed cert for the SigNoz
        // host. The peerValidationMode setter is neither @safe nor
        // nothrow, so the @safe nothrow delegate needs a @trusted
        // shutter plus an explicit cast (delegate-to-delegate casts
        // are legal; the shutter body only flips one validated field).
        void delegate(TLSContext) @trusted nothrow setup =
            (TLSContext ctx) @trusted nothrow {
                try ctx.peerValidationMode = TLSPeerValidationMode.none;
                catch (Exception) {}
            };
        settings.tlsContextSetup = cast(typeof(settings.tlsContextSetup)) setup;
    }

    string target = st.url.strip();
    while (target.length && target[$ - 1] == '/') target = target[0 .. $ - 1];
    target ~= path;

    int status = 0;
    ubyte[] payload;
    try {
        requestHTTP(target,
            (scope HTTPClientRequest r) {
                r.method = method == "POST" ? HTTPMethod.POST : HTTPMethod.GET;
                r.headers["Accept"] = "application/json";
                if (st.hostHeader.length) r.headers["Host"] = st.hostHeader;
                if (st.apiKey.length) r.headers["SIGNOZ-API-KEY"] = st.apiKey;
                if (method == "POST") {
                    r.headers["Content-Type"] = "application/json";
                    r.bodyWriter.write(cast(const(ubyte)[]) body_);
                }
            },
            (scope HTTPClientResponse remoteRes) {
                status = remoteRes.statusCode;
                try payload = remoteRes.bodyReader.readAll();
                catch (Exception e) {
                    logWarn("admin-logs: reading SigNoz %s failed: %s", path, e.msg);
                }
            },
            settings);
    } catch (Exception e) {
        logWarn("admin-logs: SigNoz %s %s failed: %s", method, path, e.msg);
        jsonError(res, 502,
            "SigNoz unreachable at " ~ st.url
            ~ " (" ~ e.msg ~ "). Check the gateway tailnet route and IRCFIBER_SIGNOZ_* env.");
        return;
    }
    if (status == 0) {
        jsonError(res, 502, "SigNoz unreachable at " ~ st.url ~ " (no response).");
        return;
    }
    if (status == 401) {
        logWarn("admin-logs: SigNoz rejected the API key (401) for %s", path);
        jsonError(res, 502,
            "SigNoz rejected the API key (401). Mint one in SigNoz -> Settings -> API Keys "
            ~ "and set vault_signoz_api_key, then redeploy the gateway.");
        return;
    }
    string out_ = cast(string) payload;
    if (reshape && status == 200 && payload.length) {
        try out_ = reshapeQueryRange(parseJsonString(out_)).toString();
        catch (Exception e) {
            logWarn("admin-logs: reshape failed for %s, passing through: %s", path, e.msg);
        }
    }
    res.statusCode = status;
    res.headers["Content-Type"] = "application/json; charset=utf-8";
    res.bodyWriter.write(cast(const(ubyte)[]) out_);
}

/// POST /api/admin/logs/query_range — SigNoz v5 builder query, proxied.
void apiLogsQueryRange(HTTPServerRequest req, HTTPServerResponse res) {
    string body_;
    try body_ = cast(string) req.bodyReader.readAll();
    catch (Exception e) {
        jsonError(res, 400, "Could not read request body: " ~ e.msg);
        return;
    }
    logInfo("admin-logs: query_range (%d bytes)", body_.length);
    proxySignoz(res, "POST", "/api/v5/query_range", sanitizeQueryBody(body_), true);
}

/// Reshapes one v0.138 raw row into the legacy list item the admin UI
/// parses (`timestamp_nano`/`severity_text`/`service_name`/`body`/
/// `trace_id`/`attributes`). Unknown shapes pass through untouched so a
/// future SigNoz change degrades to unparsed rows, not a 500.
Json reshapeRow(Json row) {
    auto d = row["data"];
    if (d.type != Json.Type.object) return row;
    auto o = Json.emptyObject;
    if (d["severity_text"].type == Json.Type.string)
        o["severity_text"] = d["severity_text"];
    if (d["body"].type == Json.Type.string)
        o["body"] = d["body"];
    if (d["trace_id"].type == Json.Type.string && d["trace_id"].get!string.length)
        o["trace_id"] = d["trace_id"];
    // Nanoseconds since epoch; the UI divides timestamp_nano by 1e6.
    if (d["timestamp"].type == Json.Type.int_)
        o["timestamp_nano"] = d["timestamp"];
    auto rs = d["resources_string"];
    if (rs.type == Json.Type.object
        && rs["service.name"].type == Json.Type.string)
        o["service_name"] = rs["service.name"];
    auto attrs = Json.emptyObject;
    foreach (group; ["attributes_string", "attributes_number", "attributes_bool"]) {
        auto g = d[group];
        if (g.type == Json.Type.object)
            foreach (string ak, av; g) attrs[ak] = av;
    }
    if (rs.type == Json.Type.object)
        foreach (string rk, rv; rs) attrs[rk] = rv;
    o["attributes"] = attrs;
    return o;
}

/// Converts a v0.138 query_range success envelope
/// (`data.data.results[{queryName, rows:[{data...}]}]`) into the legacy
/// shape the admin UI parses (`data.<name>.list`). Anything unexpected
/// passes through untouched.
Json reshapeQueryRange(Json v) {
    try {
        auto results = v["data"]["data"]["results"];
        if (results.type != Json.Type.array) return v;
        auto out_ = Json.emptyObject;
        foreach (ref r; results) {
            string name = "A";
            if (r["queryName"].type == Json.Type.string
                && r["queryName"].get!string.length)
                name = r["queryName"].get!string;
            auto list = Json.emptyArray;
            if (r["rows"].type == Json.Type.array)
                foreach (ref row; r["rows"]) list ~= reshapeRow(row);
            auto q = Json.emptyObject;
            q["queryName"] = Json(name);
            q["list"] = list;
            out_[name] = q;
        }
        auto res = Json.emptyObject;
        res["status"] = v["status"].type != Json.Type.undefined
            ? v["status"] : Json("success");
        res["data"] = out_;
        return res;
    } catch (Exception) {
        return v;
    }
}

/// Drops top-level compositeQuery fields the installed SigNoz rejects
/// (v0.138: `queryType`/`panelType` — valid fields are just `queries`).
/// Unparseable bodies forward untouched; SigNoz then 400s with its own
/// message, which the UI surfaces.
string sanitizeQueryBody(string raw) {
    try {
        auto v = parseJsonString(raw);
        auto cq = v["compositeQuery"];
        if (cq.type == Json.Type.object) {
            if (cq["queryType"].type != Json.Type.undefined)
                cq.remove("queryType");
            if (cq["panelType"].type != Json.Type.undefined)
                cq.remove("panelType");
        }
        return v.toString();
    } catch (Exception) {
        return raw;
    }
}
