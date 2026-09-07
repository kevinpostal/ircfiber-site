module ircfiber.web.admin.backups;

///
///
///
/// The k3s API on ubuntu-docker is dialled by IP literal (the gateway
/// container has no MagicDNS) against a k3s-CA-signed serving cert, so TLS
/// peer validation is off by default — same rationale and same default as
/// IRCFIBER_SIGNOZ_INSECURE. The tailnet hop is WireGuard-encrypted.
/// Secrets (the ServiceAccount token) never appear in logs or error strings.
///
/// Two facts shape this module: the k8s API cannot list files on the node and
/// keeps only 3 job histories, so archive inventory and durable run history
/// are *published by the jobs themselves* — the mongo job writes
/// `backup_runs` documents, the redis job LPUSHes `irc:backup:runs` — while
/// the gateway calls the k8s API only for live state and control
/// (CronJob/Job/Pod reads, manual Job creation, suspend patch, pod-log tail).
/// The page never restores and never deletes an archive.
///
///
/// Env:
///   IRCFIBER_K8S_API_URL    base URL of the k3s API.
///                           Default: https://100.94.116.56:6443
///   IRCFIBER_K8S_NAMESPACE  namespace holding the backup CronJobs.
///                           Default: ircfiber-prod
///   IRCFIBER_K8S_TOKEN      bearer token of the ircfiber-backup-admin
///                           ServiceAccount (file-backed in prod via
///                           IRCFIBER_K8S_TOKEN_FILE — never inline).
///   IRCFIBER_K8S_INSECURE   "0" disables TLS peer-validation skip.
///                           Default skipped (see above).
///

import std.algorithm : canFind, map, sort, startsWith;
import std.array : array, split;
import std.conv : to;
import std.datetime : Clock;
import std.datetime.systime : SysTime;
import std.string : strip, toLower;
import core.time : seconds;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.http.client : requestHTTP, HTTPMethod, HTTPClientSettings,
    HTTPClientRequest, HTTPClientResponse;
import vibe.stream.tls : TLSContext, TLSPeerValidationMode;
import vibe.stream.operations : readAll;
import vibe.core.log : logWarn, logInfo;
import vibe.data.json : Json, parseJsonString;
import vibe.data.bson : Bson;
import vibe.db.redis.redis : RedisReply;

import ircfiber.db.mongo : AppMongoConnection;
import ircfiber.env : envSecret;
import ircfiber.redis.protocol : RedisKeys;
import ircfiber.storage.redis : RedisStorage;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;

// ---------------------------------------------------------------------------
// Settings + error
// ---------------------------------------------------------------------------

/// Only these CronJobs may be inspected or driven through the admin API.
/// Without the allowlist the routes would be a generic remote job-creation
/// API pointed at the cluster.
immutable string[] BACKUP_CRONJOBS = ["ircfiber-mongo-backup", "ircfiber-redis-backup"];

/// k3s connection settings. All from env so no secret is committed.
struct BackupsSettings {
    string apiUrl = "https://100.94.116.56:6443";
    string ns = "ircfiber-prod";
    string token;
    bool insecure = true;

    bool configured() const {
        return apiUrl.length > 0 && token.length > 0;
    }
}

BackupsSettings loadBackupsSettings() {
    import std.process : environment;
    BackupsSettings st;
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
class BackupsError : Exception {
    int httpStatus;
    this(string msg, int status = 502) { super(msg); httpStatus = status; }
}

// ---------------------------------------------------------------------------
// k8s HTTP client
// ---------------------------------------------------------------------------

private HTTPClientSettings k8sHttpSettings(BackupsSettings st) {
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
/// text/plain, everything else JSON). Throws BackupsError — never leaks the
/// token into the message.
private string k8sRaw(BackupsSettings st, string method, string path,
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
                    logWarn("admin-backups: reading k3s %s %s failed: %s", method, path, e.msg);
                }
            },
            settings);
    } catch (Exception e) {
        logWarn("admin-backups: k3s %s %s failed: %s", method, path, e.msg);
        throw new BackupsError("k3s API unreachable at " ~ st.apiUrl
            ~ " (" ~ e.msg ~ "). Check the gateway tailnet route and IRCFIBER_K8S_* env.");
    }
    if (status == 0)
        throw new BackupsError("k3s API unreachable at " ~ st.apiUrl ~ " (no response).");
    if (status == 401 || status == 403) {
        logWarn("admin-backups: k3s rejected the gateway token (%d) for %s %s", status, method, path);
        throw new BackupsError("k3s rejected the gateway token — re-run "
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
        throw new BackupsError("k3s API " ~ status.to!string ~ ": " ~ detail, status);
    }
    return out_;
}

/// JSON k8s API call. Unparseable 2xx bodies become a BackupsError rather
/// than a 500 — the page's job is diagnosis.
private Json k8s(BackupsSettings st, string method, string path,
        string body_ = "", string contentType = "application/json") {
    auto raw = k8sRaw(st, method, path, body_, contentType);
    try return parseJsonString(raw.length ? raw : "null");
    catch (Exception e)
        throw new BackupsError("k3s API returned unparseable JSON for " ~ method ~ " " ~ path);
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — covered by unit tests)
// ---------------------------------------------------------------------------

/// "mongo" for a mongo archive or CronJob name, "redis" likewise, else "".
string backupKind(string name) {
    auto n = name.strip().toLower();
    if (n.startsWith("mongo-") || n.startsWith("ircfiber-mongo-")) return "mongo";
    if (n.startsWith("redis-") || n.startsWith("ircfiber-redis-")) return "redis";
    return "";
}

/// Next occurrence in ms of a daily `M H * * *` schedule (the only shape both
/// jobs use). -1 for anything else, which the UI renders as the raw
/// expression with no estimate. UTC: neither CronJob sets spec.timeZone.
long nextDailyRunMs(string schedule, long nowMs) {
    try {
        auto parts = schedule.strip().split(" ");
        if (parts.length != 5) return -1;
        if (parts[2] != "*" || parts[3] != "*" || parts[4] != "*") return -1;
        int minute = parts[0].to!int;
        int hour = parts[1].to!int;
        if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return -1;
        import std.datetime : DateTime, TimeOfDay, Date, UTC;
        import std.datetime.systime : SysTime;
        auto now = SysTime.fromUnixTime(nowMs / 1000, UTC());
        auto today = cast(Date) now;
        auto cand = SysTime(DateTime(today, TimeOfDay(hour, minute, 0)), UTC());
        if (cand.toUnixTime() * 1000 <= nowMs)
            cand += 86400.seconds;
        return cand.toUnixTime() * 1000;
    } catch (Exception) {
        return -1;
    }
}

/// RFC3339 (k8s `lastScheduleTime` / `startTime` / `creationTimestamp`) to
/// unix-ms, or -1 when absent/unparseable.
long parseK8sTimeMs(string rfc3339) {
    try {
        auto s = rfc3339.strip();
        if (s.length == 0) return -1;
        return SysTime.fromISOExtString(s).toUnixTime() * 1000;
    } catch (Exception) {
        return -1;
    }
}

/// Freshness precedence: a failed run newer than the last success wins over
/// a fresh success; never succeeded; over-30 h stale; else ok. 30 h = a daily
/// schedule plus the CronJob's own startingDeadlineSeconds (3600 s) plus
/// headroom.
string freshnessState(long lastSuccessMs, long lastRunStartedMs, string lastRunStatus, long nowMs) {
    if (lastRunStatus == "failed" && (lastSuccessMs <= 0 || lastRunStartedMs > lastSuccessMs))
        return "failed";
    if (lastSuccessMs <= 0) return "never";
    if (nowMs - lastSuccessMs > 30 * 3600_000L) return "late";
    return "ok";
}

private long jsonLong(Json v, long fallback = 0) {
    try {
        if (v.type == Json.Type.int_) return v.get!long;
        if (v.type == Json.Type.float_) return cast(long) v.get!double;
        if (v.type == Json.Type.string) return v.get!string.strip().to!long;
    } catch (Exception) {}
    return fallback;
}

private string jsonStr(Json v, string fallback = "") {
    try {
        if (v.type == Json.Type.string) return v.get!string;
        if (v.type == Json.Type.int_) return v.get!long.to!string;
        if (v.type == Json.Type.float_) return v.get!double.to!string;
        if (v.type == Json.Type.bool_) return v.get!bool ? "true" : "false";
    } catch (Exception) {}
    return fallback;
}

/// Normalises one published run record: drops unknown fields, coerces the
/// numeric fields, defaults status to "unknown". Returns Json.undefined for
/// a record without a kind, so a malformed publish is skipped rather than
/// crashing the page.
Json normalizeRun(Json raw) {
    try {
        if (raw.type != Json.Type.object) return Json.undefined;
        string kind = jsonStr(raw["kind"]);
        if (kind.length == 0) return Json.undefined;
        auto o = Json.emptyObject;
        o["kind"] = Json(kind);
        o["status"] = Json(jsonStr(raw["status"], "unknown"));
        o["stage"] = Json(jsonStr(raw["stage"]));
        o["startedAt"] = Json(jsonLong(raw["startedAt"]));
        o["finishedAt"] = Json(jsonLong(raw["finishedAt"]));
        o["durationMs"] = Json(jsonLong(raw["durationMs"]));
        o["file"] = Json(jsonStr(raw["file"]));
        o["bytes"] = Json(jsonLong(raw["bytes"]));
        o["node"] = Json(jsonStr(raw["node"]));
        o["message"] = Json(jsonStr(raw["message"]));
        if (raw["snapshots"].type == Json.Type.array)
            o["snapshots"] = raw["snapshots"];
        else
            o["snapshots"] = Json.emptyArray;
        if (raw["volume"].type == Json.Type.object)
            o["volume"] = raw["volume"];
        else
            o["volume"] = Json.emptyObject;
        return o;
    } catch (Exception) {
        return Json.undefined;
    }
}

// ---------------------------------------------------------------------------
// Run history (degrades to empty list + error string, never throws)
// ---------------------------------------------------------------------------

private struct RunHistory {
    Json[] runs;
    string error;
}

private RunHistory readMongoRuns() {
    RunHistory h;
    try {
        if (!AppMongoConnection.isConnected()) {
            h.error = "MongoDB not connected";
            return h;
        }
        Bson sort = Bson.emptyObject;
        sort["startedAt"] = Bson(cast(long) -1);
        auto docs = AppMongoConnection.safeFind("backup_runs",
            Bson.emptyObject, Bson.emptyObject, sort, 20, 2000);
        if (docs !is null) foreach (d; docs) {
            Json rec;
            try rec = normalizeRun(d.toJson());
            catch (Exception) { continue; }
            if (rec.type != Json.Type.undefined) h.runs ~= rec;
        }
    } catch (Exception e) {
        h.error = e.msg;
    }
    return h;
}

private RunHistory readRedisRuns(RedisStorage redis) {
    RunHistory h;
    try {
        auto db = redis.getDb();
        auto reply = db.request!(RedisReply!string)("LRANGE", RedisKeys.backupRuns(), "0", "19");
        foreach (r; reply) {
            Json rec;
            try rec = normalizeRun(parseJsonString(r));
            catch (Exception) { continue; }
            if (rec.type != Json.Type.undefined) h.runs ~= rec;
        }
    } catch (Exception e) {
        h.error = e.msg;
    }
    return h;
}

// ---------------------------------------------------------------------------
// k8s state helpers
// ---------------------------------------------------------------------------

private string k8sStr(Json v, string key) {
    try {
        auto f = v[key];
        if (f.type == Json.Type.string) return f.get!string;
    } catch (Exception) {}
    return "";
}

private bool jobFailed(Json job) {
    try {
        foreach (ref c; job["status"]["conditions"]) {
            if (c["type"].type == Json.Type.string && c["type"].get!string == "Failed"
                && c["status"].type == Json.Type.string && c["status"].get!string == "True")
                return true;
        }
    } catch (Exception) {}
    return false;
}

private bool jobComplete(Json job) {
    try {
        foreach (ref c; job["status"]["conditions"]) {
            if (c["type"].type == Json.Type.string && c["type"].get!string == "Complete"
                && c["status"].type == Json.Type.string && c["status"].get!string == "True")
                return true;
        }
    } catch (Exception) {}
    return false;
}

private long jobStartMs(Json job) {
    long t = -1;
    try t = parseK8sTimeMs(k8sStr(job["status"], "startTime"));
    catch (Exception) {}
    if (t <= 0) {
        try t = parseK8sTimeMs(k8sStr(job["metadata"], "creationTimestamp"));
        catch (Exception) {}
    }
    return t;
}

private bool jobActive(Json job) {
    if (jobFailed(job) || jobComplete(job)) return false;
    try {
        if (k8sStr(job["status"], "completionTime").length > 0) return false;
    } catch (Exception) {}
    return jobStartMs(job) > 0;
}

private string sanitizeAnnotation(string raw) {
    string o;
    foreach (c; raw) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')
            o ~= c;
        if (o.length >= 63) break;
    }
    return o;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// GET /api/admin/backups — merged CronJob state + published run history +
/// snapshot inventory. Always 200: when the k8s control plane is unreachable
/// jobs is [] and control carries the error, so a dead control plane never
/// hides the history that explains it.
void apiBackupsOverview(HTTPServerRequest req, HTTPServerResponse res, RedisStorage redis) {
    auto st = loadBackupsSettings();
    long nowMs = Clock.currTime.toUnixTime() * 1000L;

    Json jobs = Json.emptyArray;
    bool controlAvailable = st.configured();
    string controlError = st.configured()
        ? ""
        : "k3s API not configured (IRCFIBER_K8S_API_URL / IRCFIBER_K8S_TOKEN_FILE)";

    if (st.configured()) {
        try {
            auto cronList = k8s(st, "GET",
                "/apis/batch/v1/namespaces/" ~ st.ns ~ "/cronjobs");
            auto jobList = k8s(st, "GET",
                "/apis/batch/v1/namespaces/" ~ st.ns ~ "/jobs");

            Json[] jobItems;
            try foreach (ref j; jobList["items"]) jobItems ~= j;
            catch (Exception) {}

            foreach (name; BACKUP_CRONJOBS) {
                Json cj = Json.undefined;
                try foreach (ref c; cronList["items"]) {
                    string n = "";
                    try n = c["metadata"]["name"].get!string;
                    catch (Exception) {}
                    if (n == name) { cj = c; break; }
                } catch (Exception) {}
                if (cj.type == Json.Type.undefined) continue;

                string schedule = "";
                bool suspended = false;
                try schedule = cj["spec"]["schedule"].get!string;
                catch (Exception) {}
                try suspended = cj["spec"]["suspend"].type == Json.Type.bool_
                    ? cj["spec"]["suspend"].get!bool : false;
                catch (Exception) {}

                long lastScheduleMs = -1, lastSuccessMs = -1;
                try lastScheduleMs = parseK8sTimeMs(k8sStr(cj["status"], "lastScheduleTime"));
                catch (Exception) {}
                try lastSuccessMs = parseK8sTimeMs(k8sStr(cj["status"], "lastSuccessfulTime"));
                catch (Exception) {}

                Json active = Json.emptyArray;
                long lastRunStartedMs = -1;
                string lastRunStatus = "";
                string prefix = name ~ "-";
                foreach (ref j; jobItems) {
                    string jn = "";
                    try jn = j["metadata"]["name"].get!string;
                    catch (Exception) {}
                    if (!jn.startsWith(prefix)) continue;
                    long s = jobStartMs(j);
                    if (jobActive(j)) {
                        auto a = Json.emptyObject;
                        a["name"] = Json(jn);
                        a["startTime"] = Json(s);
                        active ~= a;
                    }
                    if (s > lastRunStartedMs) {
                        lastRunStartedMs = s;
                        lastRunStatus = jobFailed(j) ? "failed"
                            : jobComplete(j) ? "ok" : "running";
                    }
                }

                string state = freshnessState(lastSuccessMs, lastRunStartedMs, lastRunStatus, nowMs);
                long nextRun = suspended ? -1 : nextDailyRunMs(schedule, nowMs);

                auto e = Json.emptyObject;
                e["name"] = Json(name);
                e["kind"] = Json(backupKind(name));
                e["schedule"] = Json(schedule);
                e["suspended"] = Json(suspended);
                e["lastScheduleTime"] = Json(lastScheduleMs);
                e["lastSuccessTime"] = Json(lastSuccessMs);
                e["nextRunAt"] = Json(nextRun);
                e["state"] = Json(state);
                e["active"] = active;
                jobs ~= e;
            }
        } catch (BackupsError e) {
            jobs = Json.emptyArray;
            controlAvailable = false;
            controlError = e.msg;
        } catch (Exception e) {
            jobs = Json.emptyArray;
            controlAvailable = false;
            controlError = e.msg;
        }
    }

    auto mongoH = readMongoRuns();
    auto redisH = readRedisRuns(redis);
    Json[] all = mongoH.runs ~ redisH.runs;
    all.sort!((a, b) {
        long sa = 0, sb = 0;
        try sa = a["startedAt"].get!long;
        catch (Exception) {}
        try sb = b["startedAt"].get!long;
        catch (Exception) {}
        return sa > sb;
    });
    if (all.length > 40) all = all[0 .. 40];

    // Snapshots/volume come from the newest run record that carries them —
    // either job's record inventories the whole directory.
    Json snapshots = Json.emptyArray;
    Json volume = Json.emptyObject;
    long capturedAt = 0;
    foreach (ref r; all) {
        try {
            if (r["snapshots"].type == Json.Type.array && r["snapshots"].length > 0) {
                Json[] snaps;
                foreach (ref s; r["snapshots"]) {
                    string n = jsonStr(s["name"]);
                    if (n.length == 0) continue;
                    auto se = Json.emptyObject;
                    se["name"] = Json(n);
                    se["kind"] = Json(backupKind(n));
                    se["bytes"] = Json(jsonLong(s["bytes"]));
                    // The jobs publish mtime as `stat -c %Y` seconds; the UI
                    // works in unix-ms. Values below 1e12 must be seconds.
                    long mt = jsonLong(s["mtime"]);
                    if (mt > 0 && mt < 1_000_000_000_000L) mt *= 1000;
                    se["mtime"] = Json(mt);
                    snaps ~= se;
                }
                // Newest first by mtime so the table reads top-down.
                snaps.sort!((a, b) {
                    long ma = 0, mb = 0;
                    try ma = a["mtime"].get!long;
                    catch (Exception) {}
                    try mb = b["mtime"].get!long;
                    catch (Exception) {}
                    return ma > mb;
                });
                snapshots = Json(snaps);
                volume = r["volume"];
                try capturedAt = r["finishedAt"].get!long;
                catch (Exception) {}
                break;
            }
        } catch (Exception) {}
    }

    // Worst state across jobs: failed > never > late > ok.
    string overall = "ok";
    int rank(string s) {
        switch (s) {
            case "failed": return 3;
            case "never": return 2;
            case "late": return 1;
            default: return 0;
        }
    }
    int best = 0;
    try foreach (ref j; jobs) {
        int r = rank(jsonStr(j["state"]));
        if (r > best) { best = r; overall = jsonStr(j["state"], "ok"); }
    } catch (Exception) {}
    if (jobs.length == 0 && !controlAvailable) overall = "ok";

    auto data = Json.emptyObject;
    data["jobs"] = jobs;
    data["runs"] = Json(all);
    data["snapshots"] = snapshots;
    data["volume"] = volume;
    try volume["capturedAt"] = Json(capturedAt);
    catch (Exception) {}
    auto control = Json.emptyObject;
    control["available"] = Json(controlAvailable);
    control["error"] = Json(controlError);
    data["control"] = control;
    auto history = Json.emptyObject;
    history["mongoError"] = Json(mongoH.error);
    history["redisError"] = Json(redisH.error);
    data["history"] = history;
    data["overall"] = Json(overall);
    jsonOk(res, data);
}

/// POST /api/admin/backups/:name/run — creates one manual Job from the
/// CronJob's jobTemplate. 400 outside the allowlist; 409 while a run is
/// already in flight (concurrencyPolicy Forbid would silently never start a
/// second one).
void apiBackupsRun(HTTPServerRequest req, HTTPServerResponse res) {
    string name = "";
    try name = req.params["name"];
    catch (Exception) {}
    if (!BACKUP_CRONJOBS.canFind(name)) {
        jsonError(res, 400, "Unknown backup job");
        return;
    }
    auto st = loadBackupsSettings();
    if (!st.configured()) {
        jsonError(res, 503,
            "k3s API not configured (IRCFIBER_K8S_API_URL / IRCFIBER_K8S_TOKEN_FILE)");
        return;
    }
    try {
        auto jobList = k8s(st, "GET",
            "/apis/batch/v1/namespaces/" ~ st.ns ~ "/jobs");
        string prefix = name ~ "-";
        try foreach (ref j; jobList["items"]) {
            string jn = "";
            try jn = j["metadata"]["name"].get!string;
            catch (Exception) {}
            if (jn.startsWith(prefix) && jobActive(j)) {
                jsonError(res, 409, "a run is already in flight");
                return;
            }
        } catch (Exception e) {
            // Non-iteration errors (missing items) fall through to the GET
            // below failing loudly; iteration-shape issues are ignored.
            if (jobList["items"].type != Json.Type.undefined) throw e;
        }

        auto cj = k8s(st, "GET",
            "/apis/batch/v1/namespaces/" ~ st.ns ~ "/cronjobs/" ~ name);
        Json tmplSpec;
        try tmplSpec = cj["spec"]["jobTemplate"]["spec"];
        catch (Exception)
            throw new BackupsError("CronJob " ~ name ~ " has no jobTemplate.spec");

        // Manual jobs carry no owner reference, so
        // successfulJobsHistoryLimit never reaps them — the TTL does.
        tmplSpec["ttlSecondsAfterFinished"] = Json(86400);

        string by = "";
        try {
            import ircfiber.models.user : User;
            auto u = req.context["user"].get!User;
            by = sanitizeAnnotation(u.username);
        } catch (Exception) {}

        long nowSecs = Clock.currTime.toUnixTime();
        string jobName = name ~ "-manual-" ~ nowSecs.to!string;

        auto meta = Json.emptyObject;
        meta["name"] = Json(jobName);
        auto ann = Json.emptyObject;
        ann["cronjob.kubernetes.io/instantiate"] = Json("manual");
        if (by.length) ann["ircfiber.io/triggered-by"] = Json(by);
        meta["annotations"] = ann;
        auto labels = Json.emptyObject;
        labels["component"] = Json("backup");
        labels["app.kubernetes.io/part-of"] = Json("ircfiber");
        labels["ircfiber.io/manual"] = Json("true");
        meta["labels"] = labels;

        auto body_ = Json.emptyObject;
        body_["apiVersion"] = Json("batch/v1");
        body_["kind"] = Json("Job");
        body_["metadata"] = meta;
        body_["spec"] = tmplSpec;

        auto created = k8s(st, "POST",
            "/apis/batch/v1/namespaces/" ~ st.ns ~ "/jobs", body_.toString());
        string createdName = jobName;
        try createdName = created["metadata"]["name"].get!string;
        catch (Exception) {}
        logInfo("admin-backups: manual run %s triggered by %s",
            createdName, by.length ? by : "unknown");
        auto data = Json.emptyObject;
        data["job"] = Json(createdName);
        jsonOk(res, data);
    } catch (BackupsError e) {
        jsonError(res, e.httpStatus, e.msg);
    } catch (Exception e) {
        logWarn("admin-backups: run %s failed: %s", name, e.msg);
        jsonError(res, 500, e.msg);
    }
}

/// POST /api/admin/backups/:name/suspend — flips spec.suspend via merge
/// patch. Body {"suspend": true|false}; a missing/non-bool field is 400.
/// Note: suspension is break-glass cluster-side state — re-applying
/// cronjob-backup.yaml resets it to the manifest value.
void apiBackupsSuspend(HTTPServerRequest req, HTTPServerResponse res) {
    string name = "";
    try name = req.params["name"];
    catch (Exception) {}
    if (!BACKUP_CRONJOBS.canFind(name)) {
        jsonError(res, 400, "Unknown backup job");
        return;
    }
    auto st = loadBackupsSettings();
    if (!st.configured()) {
        jsonError(res, 503,
            "k3s API not configured (IRCFIBER_K8S_API_URL / IRCFIBER_K8S_TOKEN_FILE)");
        return;
    }
    auto body_ = readJsonBody(req);
    bool suspend;
    try {
        if (body_["suspend"].type != Json.Type.bool_) {
            jsonError(res, 400, "Body must be {\"suspend\": true|false}");
            return;
        }
        suspend = body_["suspend"].get!bool;
    } catch (Exception) {
        jsonError(res, 400, "Body must be {\"suspend\": true|false}");
        return;
    }
    try {
        auto patch = Json.emptyObject;
        auto spec = Json.emptyObject;
        spec["suspend"] = Json(suspend);
        patch["spec"] = spec;
        auto updated = k8s(st, "PATCH",
            "/apis/batch/v1/namespaces/" ~ st.ns ~ "/cronjobs/" ~ name,
            patch.toString(), "application/merge-patch+json");
        bool nowSuspended = suspend;
        try {
            if (updated["spec"]["suspend"].type == Json.Type.bool_)
                nowSuspended = updated["spec"]["suspend"].get!bool;
        } catch (Exception) {}
        logInfo("admin-backups: %s suspend=%s", name, nowSuspended ? "true" : "false");
        auto data = Json.emptyObject;
        data["name"] = Json(name);
        data["suspended"] = Json(nowSuspended);
        jsonOk(res, data);
    } catch (BackupsError e) {
        jsonError(res, e.httpStatus, e.msg);
    } catch (Exception e) {
        logWarn("admin-backups: suspend %s failed: %s", name, e.msg);
        jsonError(res, 500, e.msg);
    }
}

/// GET /api/admin/backups/:name/logs — tail (≤200 lines) of the newest job's
/// pod log for failure triage. No job yet → 404; job present but pod already
/// reaped → 404 with that distinction in the message.
void apiBackupsLogs(HTTPServerRequest req, HTTPServerResponse res) {
    string name = "";
    try name = req.params["name"];
    catch (Exception) {}
    if (!BACKUP_CRONJOBS.canFind(name)) {
        jsonError(res, 400, "Unknown backup job");
        return;
    }
    auto st = loadBackupsSettings();
    if (!st.configured()) {
        jsonError(res, 503,
            "k3s API not configured (IRCFIBER_K8S_API_URL / IRCFIBER_K8S_TOKEN_FILE)");
        return;
    }
    try {
        auto jobList = k8s(st, "GET",
            "/apis/batch/v1/namespaces/" ~ st.ns ~ "/jobs");
        string prefix = name ~ "-";
        string bestJob = "";
        long bestStart = -1;
        try foreach (ref j; jobList["items"]) {
            string jn = "";
            try jn = j["metadata"]["name"].get!string;
            catch (Exception) {}
            if (!jn.startsWith(prefix)) continue;
            long s = jobStartMs(j);
            if (s > bestStart) { bestStart = s; bestJob = jn; }
        } catch (Exception) {}
        if (bestJob.length == 0) {
            jsonError(res, 404, "No job has run yet for " ~ name);
            return;
        }

        // Jobs are matched by name prefix, not by label: the committed
        // jobTemplate carries no metadata.labels, so controller-created jobs
        // have no component=backup label to select on.
        import std.uri : encodeComponent;
        Json pods = Json.undefined;
        try {
            pods = k8s(st, "GET", "/api/v1/namespaces/" ~ st.ns ~ "/pods"
                ~ "?labelSelector=batch.kubernetes.io%2Fjob-name%3D" ~ encodeComponent(bestJob));
        } catch (BackupsError e) {
            throw e;
        } catch (Exception e) {
            throw new BackupsError(e.msg);
        }
        bool empty = true;
        try empty = pods["items"].type != Json.Type.array || pods["items"].length == 0;
        catch (Exception) {}
        if (empty) {
            // Legacy selector retry before giving up.
            try {
                pods = k8s(st, "GET", "/api/v1/namespaces/" ~ st.ns ~ "/pods"
                    ~ "?labelSelector=job-name%3D" ~ encodeComponent(bestJob));
                empty = pods["items"].type != Json.Type.array || pods["items"].length == 0;
            } catch (Exception) {}
        }
        string podName = "";
        if (!empty) {
            try podName = pods["items"][0]["metadata"]["name"].get!string;
            catch (Exception) {}
        }
        if (podName.length == 0) {
            jsonError(res, 404, "Job " ~ bestJob
                ~ " has no pod — it was already reaped by the history limit");
            return;
        }
        string logText;
        try {
            logText = k8sRaw(st, "GET", "/api/v1/namespaces/" ~ st.ns
                ~ "/pods/" ~ encodeComponent(podName) ~ "/log?tailLines=200");
        } catch (BackupsError e) {
            if (e.httpStatus == 404)
                throw new BackupsError("Pod " ~ podName ~ " for job " ~ bestJob
                    ~ " is gone — it was already reaped by the history limit", 404);
            throw e;
        }
        auto data = Json.emptyObject;
        data["job"] = Json(bestJob);
        data["pod"] = Json(podName);
        data["log"] = Json(logText);
        jsonOk(res, data);
    } catch (BackupsError e) {
        jsonError(res, e.httpStatus, e.msg);
    } catch (Exception e) {
        logWarn("admin-backups: logs %s failed: %s", name, e.msg);
        jsonError(res, 500, e.msg);
    }
}
