module ircfiber.web.admin.k8s;

/// Shared k3s API client for the admin pages (Backups, K8s leaf).
///
/// The k3s API on ubuntu-docker is dialled by IP literal (the gateway
/// container has no MagicDNS) against a k3s-CA-signed serving cert, so TLS
/// peer validation is off by default — same rationale and same default as
/// IRCFIBER_SIGNOZ_INSECURE. The tailnet hop is WireGuard-encrypted.
/// Secrets (the ServiceAccount token) never appear in logs or error strings.
///
/// One ServiceAccount backs every caller: `ircfiber-backup-admin`
/// (site/deploy/k8s/ircfiber-prod/rbac-backup-admin.yaml). Its verbs are
/// read-only except `patch` on CronJob suspend, `create` on Jobs and `patch`
/// on `deployments/scale` — no `delete` anywhere.
///
/// Env:
///   IRCFIBER_K8S_API_URL    base URL of the k3s API.
///                           Default: https://100.94.116.56:6443
///   IRCFIBER_K8S_NAMESPACE  namespace holding the workloads.
///                           Default: ircfiber-prod
///   IRCFIBER_K8S_TOKEN      bearer token of the ircfiber-backup-admin
///                           ServiceAccount (file-backed in prod via
///                           IRCFIBER_K8S_TOKEN_FILE — never inline).
///   IRCFIBER_K8S_INSECURE   "0" disables TLS peer-validation skip.
///                           Default skipped (see above).

import std.conv : to;
import std.string : strip;
import core.time : seconds;

import vibe.http.client : requestHTTP, HTTPMethod, HTTPClientSettings,
    HTTPClientRequest, HTTPClientResponse;
import vibe.stream.tls : TLSContext, TLSPeerValidationMode;
import vibe.stream.operations : readAll;
import vibe.core.log : logWarn;
import vibe.data.json : Json, parseJsonString;

import ircfiber.env : envSecret;

/// k3s connection settings. All from env so no secret is committed.
struct K8sSettings {
    string apiUrl = "https://100.94.116.56:6443";
    string ns = "ircfiber-prod";
    string token;
    bool insecure = true;

    bool configured() const {
        return apiUrl.length > 0 && token.length > 0;
    }
}

K8sSettings loadK8sSettings() {
    import std.process : environment;
    K8sSettings st;
    try {
        auto u = environment.get("IRCFIBER_K8S_API_URL", "");
        if (u.length) st.apiUrl = u;
        auto n = environment.get("IRCFIBER_K8S_NAMESPACE", "");
        if (n.length) st.ns = n;
        // ServiceAccount token: file-backed in prod
        // (IRCFIBER_K8S_TOKEN_FILE), never inline in the container env.
        st.token = envSecret("IRCFIBER_K8S_TOKEN", "");
        st.insecure = environment.get("IRCFIBER_K8S_INSECURE", "1") != "0";
    } catch (Exception) {}
    return st;
}

/// Always safe to surface to admins (never contains the token).
class K8sError : Exception {
    int httpStatus;
    this(string msg, int status = 502) { super(msg); httpStatus = status; }
}

private HTTPClientSettings k8sHttpSettings(K8sSettings st) {
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 10.seconds;
    settings.readTimeout = 20.seconds;
    if (st.insecure) {
        // IP-literal URL against a k3s-CA-signed cert. The
        // peerValidationMode setter is neither @safe nor nothrow, so the
        // @safe nothrow delegate needs a @trusted shutter plus an explicit
        // cast (delegate-to-delegate casts are legal; the shutter body only
        // flips one validated field).
        void delegate(TLSContext) @trusted nothrow setup =
            (TLSContext ctx) @trusted nothrow {
                try ctx.peerValidationMode = TLSPeerValidationMode.none;
                catch (Exception) {}
            };
        settings.tlsContextSetup = cast(typeof(settings.tlsContextSetup)) setup;
    }
    return settings;
}

/// Raw k8s API call. Returns the response body as a string (pod logs are
/// text/plain, everything else JSON). Throws K8sError — never leaks the
/// token into the message.
string k8sRaw(K8sSettings st, string method, string path,
        string body_ = "", string contentType = "application/json") {
    auto settings = k8sHttpSettings(st);
    string target = st.apiUrl.strip();
    while (target.length && target[$ - 1] == '/') target = target[0 .. $ - 1];
    target ~= path;

    HTTPMethod vm;
    switch (method) {
        case "POST": vm = HTTPMethod.POST; break;
        case "PATCH": vm = HTTPMethod.PATCH; break;
        case "PUT": vm = HTTPMethod.PUT; break;
        case "DELETE": vm = HTTPMethod.DELETE; break;
        default: vm = HTTPMethod.GET; break;
    }

    int status = 0;
    ubyte[] payload;
    try {
        requestHTTP(target,
            (scope HTTPClientRequest r) {
                r.method = vm;
                r.headers["Authorization"] = "Bearer " ~ st.token;
                r.headers["Accept"] = "application/json";
                if (method == "POST" || method == "PATCH" || method == "PUT") {
                    r.headers["Content-Type"] = contentType;
                    r.bodyWriter.write(cast(const(ubyte)[]) body_);
                }
            },
            (scope HTTPClientResponse remoteRes) {
                status = remoteRes.statusCode;
                try payload = remoteRes.bodyReader.readAll();
                catch (Exception e) {
                    logWarn("admin-k8s: reading k3s %s %s failed: %s", method, path, e.msg);
                }
            },
            settings);
    } catch (Exception e) {
        logWarn("admin-k8s: k3s %s %s failed: %s", method, path, e.msg);
        throw new K8sError("k3s API unreachable at " ~ st.apiUrl
            ~ " (" ~ e.msg ~ "). Check the gateway tailnet route and IRCFIBER_K8S_* env.");
    }
    if (status == 0)
        throw new K8sError("k3s API unreachable at " ~ st.apiUrl ~ " (no response).");
    if (status == 401 || status == 403) {
        logWarn("admin-k8s: k3s rejected the gateway token (%d) for %s %s", status, method, path);
        throw new K8sError("k3s rejected the gateway token — re-run "
            ~ "`make -f Makefile.k8s k8s-prod-backups-token` and update `vault_k3s_backup_token`");
    }
    string out_ = cast(string) payload;
    if (status < 200 || status >= 300) {
        string detail = out_;
        try {
            auto v = parseJsonString(out_);
            if (v["message"].type == Json.Type.string)
                detail = v["message"].get!string;
        } catch (Exception) {}
        throw new K8sError("k3s API " ~ status.to!string ~ ": " ~ detail, status);
    }
    return out_;
}

/// JSON k8s API call. Unparseable 2xx bodies become a K8sError rather
/// than a 500 — the pages' job is diagnosis.
Json k8sJson(K8sSettings st, string method, string path,
        string body_ = "", string contentType = "application/json") {
    auto raw = k8sRaw(st, method, path, body_, contentType);
    try return parseJsonString(raw.length ? raw : "null");
    catch (Exception e)
        throw new K8sError("k3s API returned unparseable JSON for " ~ method ~ " " ~ path);
}

/// RFC3339 (k8s `lastScheduleTime` / `startTime` / `creationTimestamp`) to
/// unix-ms, or -1 when absent/unparseable. k8s stamps are always UTC.
long parseK8sTimeMs(string rfc3339) {
    import std.datetime.systime : SysTime;
    try {
        auto s = rfc3339.strip();
        if (s.length == 0) return -1;
        return SysTime.fromISOExtString(s).toUnixTime() * 1000;
    } catch (Exception) {
        return -1;
    }
}
