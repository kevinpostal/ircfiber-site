module ircfiber.web.admin.system;

/// Admin System page API — the gateway side, which is a *client only*.
///
/// The gateway deliberately holds no Docker socket and no host mount. All
/// collection and all container control live in the `ircfiber-sysagent`
/// sidecar (`ircfiber.sysagent`), reachable only on the internal docker
/// network and gated by a bearer token. These three handlers authenticate
/// the admin, then forward to the agent and pass its answer through.
///
/// Consequences of that split, all deliberate:
///   * An RCE in this process cannot open the Docker API, cannot read a host
///     file, and cannot escalate to host root. It can only make the same
///     three calls this file makes — and the agent re-checks the allowlist,
///     the self-protection and the stop-protection on every one of them.
///   * The agent's JSON is forwarded verbatim, so the payload shape has a
///     single definition (`ircfiber.sysagent.snapshotToJson`).
///   * `requestHTTP` is fiber-aware, so a 20 s container restart no longer
///     parks the event-loop thread the way a `std.process.execute` did.

import std.conv : to;
import std.string : strip;
import core.time : seconds;

import vibe.data.json : Json;
import vibe.core.log : logInfo, logWarn;
import vibe.http.client : HTTPClientRequest, HTTPClientResponse, HTTPClientSettings,
    requestHTTP;
import vibe.http.common : HTTPMethod;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse;

import ircfiber.env : envSecret;
import ircfiber.sysagent : logSafe, snapshotToJson;
import ircfiber.sysmetrics : SysSnapshot;
import ircfiber.web.admin.helpers : jsonError, jsonOk, queryString;

/// Where the sidecar lives and the token that opens it. Both come from the
/// deploy (`roles/gateway/templates/env.j2`); the token is a file secret, so
/// `docker inspect ircfiber-gateway` shows a path, never the value.
private struct AgentConfig {
    string url;
    string token;
    bool configured() const {
        return url.length > 0 && token.length > 0;
    }
}

private AgentConfig agentConfig() {
    import std.process : environment;
    AgentConfig c;
    try c.url = environment.get("IRCFIBER_SYSAGENT_URL", "").strip();
    catch (Exception) {}
    while (c.url.length > 0 && c.url[$ - 1] == '/') c.url = c.url[0 .. $ - 1];
    c.token = envSecret("IRCFIBER_SYSAGENT_TOKEN", "").strip();
    return c;
}

private struct AgentReply {
    int status;
    Json payload;
    /// Transport-level failure (agent down, unconfigured, unparseable).
    string transportError;
}

/// One call to the sidecar. Read timeout exceeds the agent's own 20 s Docker
/// budget so a slow `stop` surfaces as the agent's status, not as a timeout.
private AgentReply callAgent(HTTPMethod method, string path) {
    AgentReply out_;
    auto cfg = agentConfig();
    if (!cfg.configured) {
        out_.status = 503;
        out_.transportError = "system agent not configured "
            ~ "(IRCFIBER_SYSAGENT_URL / IRCFIBER_SYSAGENT_TOKEN_FILE)";
        return out_;
    }
    auto settings = new HTTPClientSettings;
    settings.connectTimeout = 5.seconds;
    settings.readTimeout = 30.seconds;
    try {
        requestHTTP(cfg.url ~ path,
            (scope HTTPClientRequest req) {
                req.method = method;
                req.headers["Authorization"] = "Bearer " ~ cfg.token;
                if (method != HTTPMethod.GET) req.writeBody(cast(const(ubyte)[]) "");
            },
            (scope HTTPClientResponse res) {
                out_.status = res.statusCode;
                try out_.payload = res.readJson();
                catch (Exception e) {
                    out_.transportError = "unreadable system agent response: " ~ e.msg;
                }
            },
            settings);
    } catch (Exception e) {
        out_.status = 503;
        out_.transportError = "system agent unreachable: " ~ e.msg;
    }
    return out_;
}

/// Error text the agent returned, or the transport failure.
private string agentError(AgentReply r) {
    if (r.transportError.length > 0) return r.transportError;
    try {
        if (r.payload.type == Json.Type.object && "error" in r.payload)
            return r.payload["error"].get!string;
    } catch (Exception) {}
    return "system agent returned HTTP " ~ r.status.to!string;
}

/// GET /api/admin/system — one snapshot of host + containers.
package void apiSystemOverview(HTTPServerRequest, HTTPServerResponse res) {
    auto r = callAgent(HTTPMethod.GET, "/sys/snapshot");
    if (r.status == 200 && r.transportError.length == 0) {
        jsonOk(res, r.payload);
        return;
    }
    // A missing or broken agent is a degraded page, not a 500: the snapshot
    // shape still renders, carrying the reason in the banner the
    // mounts-not-deployed path already uses.
    logWarn("apiSystemOverview: %s", agentError(r));
    SysSnapshot degraded;
    degraded.collectedAtMs = nowMs();
    degraded.reason = agentError(r);
    jsonOk(res, snapshotToJson(degraded));
}

/// POST /api/admin/system/containers/:name/:action — start|stop|restart.
///
/// The agent is the enforcement point; this rejects an unknown verb early so
/// a typo never reaches it, and records who asked.
package void apiSystemContainerAction(HTTPServerRequest req, HTTPServerResponse res) {
    auto name = req.params["name"];
    auto action = req.params["action"];
    if (action != "start" && action != "stop" && action != "restart") {
        jsonError(res, 400, "unknown action: " ~ logSafe(action));
        return;
    }
    auto r = callAgent(HTTPMethod.POST,
        "/sys/containers/" ~ urlEncodeSegment(name) ~ "/" ~ action);
    if (r.status != 200 || r.transportError.length > 0) {
        // Audit both outcomes, with the identity of the admin who asked and
        // the request-supplied name stripped of control characters (the
        // router percent-decodes it, so a raw %0A would forge a log record).
        logWarn("admin %s: %s %s refused (%s): %s", actorOf(req),
            logSafe(action), logSafe(name), r.status, agentError(r));
        jsonError(res, r.status == 200 ? 503 : r.status, agentError(r));
        return;
    }
    logInfo("admin %s: %s container %s", actorOf(req), logSafe(action), logSafe(name));
    Json data = Json.emptyObject;
    data["name"] = Json(name);
    data["action"] = Json(action);
    data["ok"] = Json(true);
    jsonOk(res, data);
}

/// GET /api/admin/system/containers/:name/logs?tail=200 — demuxed tail.
package void apiSystemContainerLogs(HTTPServerRequest req, HTTPServerResponse res) {
    auto name = req.params["name"];
    long tail = 200;
    try tail = queryString(req, "tail", "200").to!long;
    catch (Exception) {}
    if (tail < 1) tail = 1;
    if (tail > 2000) tail = 2000;

    auto r = callAgent(HTTPMethod.GET, "/sys/containers/" ~ urlEncodeSegment(name)
        ~ "/logs?tail=" ~ tail.to!string);
    if (r.status != 200 || r.transportError.length > 0) {
        logWarn("admin %s: logs %s refused (%s): %s", actorOf(req),
            logSafe(name), r.status, agentError(r));
        jsonError(res, r.status == 200 ? 503 : r.status, agentError(r));
        return;
    }
    jsonOk(res, r.payload);
}

// ---------------------------------------------------------------------------
// Shared client for the Mullvad page
//
// The Mullvad sidecars are Docker containers too, and the gateway has no
// socket any more, so those handlers go through the same agent — one Docker
// client for the whole backend, one enforcement point.
// ---------------------------------------------------------------------------

/// Mirrors `ircfiber.sysmetrics.ActionResult` so `api.d` needs no second
/// shape for the same three fields.
package struct AgentActionOutcome {
    bool ok;
    int httpStatus;
    string message;
}

/// `state`/`status` of one container as the agent's inventory sees it.
/// False when the container is absent or the agent cannot be reached, with
/// the reason in `status` — the Mullvad page renders it verbatim.
package bool agentContainerState(string name, out string state, out string status) {
    state = "unknown";
    status = "";
    auto r = callAgent(HTTPMethod.GET, "/sys/snapshot");
    if (r.status != 200 || r.transportError.length > 0) {
        status = agentError(r);
        return false;
    }
    try {
        if (r.payload.type != Json.Type.object) return false;
        if ("containers" in r.payload) {
            foreach (c; r.payload["containers"]) {
                if (c["name"].get!string != name) continue;
                state = c["state"].get!string;
                status = c["status"].get!string;
                return true;
            }
        }
        if ("collectedAtMs" in r.payload && r.payload["collectedAtMs"].to!long == 0) {
            status = "inventory not collected yet";
            return false;
        }
        if ("dockerError" in r.payload) {
            auto de = r.payload["dockerError"].get!string;
            if (de.length > 0) {
                status = "docker unavailable";
                return false;
            }
        }
    } catch (Exception e) {
        status = "unreadable system agent response: " ~ e.msg;
        return false;
    }
    state = "missing";
    return false;
}

/// start | stop | restart through the agent. The agent re-derives the
/// allowlist, the self-protection and the stop-protection, so a compromised
/// gateway cannot widen what this reaches.
package AgentActionOutcome agentContainerAction(string name, string action) {
    AgentActionOutcome out_;
    auto r = callAgent(HTTPMethod.POST,
        "/sys/containers/" ~ urlEncodeSegment(name) ~ "/" ~ action);
    if (r.status == 200 && r.transportError.length == 0) {
        out_.ok = true;
        out_.httpStatus = 200;
        out_.message = action ~ " accepted";
        return out_;
    }
    out_.httpStatus = r.status == 200 ? 503 : r.status;
    out_.message = agentError(r);
    return out_;
}

/// Who is acting, for the audit line. The admin surface is session-gated, so
/// there is always a session; the username is what an incident review needs,
/// the IP is what ties it to a device.
private string actorOf(HTTPServerRequest req) {
    import ircfiber.web.common : getClientIp;
    string user = "unknown";
    try {
        if (req.session && req.session.isKeySet("username")) {
            import ircfiber.web.admin.helpers : stripJsonStr;
            user = stripJsonStr(req.session.get!string("username"));
        }
    } catch (Exception) {}
    string ip;
    try ip = getClientIp(req);
    catch (Exception) {}
    return logSafe(user) ~ "@" ~ (ip.length ? ip : "?");
}

/// Percent-encodes one path segment. The name came out of the router already
/// decoded, and it is about to go back into a URL — anything unusual must not
/// change the agent's route.
private string urlEncodeSegment(string raw) {
    import std.array : appender;
    import std.format : format;
    auto app = appender!string();
    foreach (char ch; raw) {
        const bool safe = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
            || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.'
            || ch == '~';
        if (safe) app.put(ch);
        else app.put(format("%%%02X", cast(ubyte) ch));
    }
    return app.data;
}

private long nowMs() {
    import std.datetime : Clock;
    return Clock.currTime.toUnixTime!long * 1000;
}
