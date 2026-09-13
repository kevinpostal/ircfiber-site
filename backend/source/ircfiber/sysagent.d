module ircfiber.sysagent;

/// The host-telemetry sidecar: `ircfiber-sysagent`.
///
/// WHY THIS PROCESS EXISTS
/// ----------------------
/// The System page needs the host's `/proc` and `/sys` and the Docker Engine
/// socket. Until 2026-09-13 those were mounted straight into
/// `ircfiber-gateway` — the process that terminates public HTTP, WebSockets
/// and the bouncer's TLS port, as uid 0. A security review of that shape
/// found two unacceptable consequences:
///
///   * `/var/run/docker.sock` is a root-equivalent control plane with no
///     per-verb authorization. The backend only ever calls four endpoints,
///     but the socket does not know that: any RCE or arbitrary-write bug
///     anywhere in the gateway becomes `POST /containers/create` with
///     `Binds:["/:/mnt"], Privileged:true` — i.e. host root.
///   * `/proc:/host/proc:ro` plus `/:/host/root:ro` hand that same process
///     every sibling container's resolved environment
///     (`/var/lib/docker/containers/*/config.v2.json`), the Caddy TLS private
///     keys, `/var/lib/tailscale/tailscaled.state` and `/etc/shadow`. And
///     `:ro` is not containment: `/host/proc/1/root/...` resolves into pid 1's
///     read-WRITE mount namespace, so `/host/proc/1/root/etc/cron.d/` was
///     writable from a container the deploy described as read-only.
///
/// So collection moved here. This process:
///   * holds the socket and the host mounts,
///   * has no published port and lives only on the internal docker network,
///   * carries no other credential — exactly one secret file is bind-mounted,
///     its own bearer token (`IRCFIBER_SYSAGENT_TOKEN_FILE`),
///   * never touches Redis, Mongo, the IRC stack or any vibe session, and
///   * enforces the allowlist, the self-protection and the stop-protection
///     itself (`ircfiber.sysmetrics.resolveControl`).
///
/// The gateway is a *client* (see `ircfiber.web.admin.system`). A fully
/// compromised gateway therefore gains exactly this API: read host metrics,
/// read the log tail of an allowlisted container, and start/restart/stop
/// (minus the protected set) an allowlisted container. It cannot create a
/// container, cannot exec into one, and cannot read a host file.
///
/// Started by the same binary: `IRCFIBER_SYSAGENT=1` selects this mode in
/// `app.d` before any storage is initialised, so the agent image needs no
/// database credentials at all.

import std.conv : to;
import std.digest : secureEqual;
import std.string : strip;

import vibe.core.core : runApplication;
import vibe.core.log;
import vibe.data.json : Json;
import vibe.http.router : URLRouter;
import vibe.http.server : HTTPServerRequest, HTTPServerResponse, HTTPServerSettings,
    listenHTTP;

import ircfiber.env : envSecret;
import ircfiber.sysmetrics : ContainerSample, SysSnapshot, containerAction,
    containerLogs, sysSnapshot;

/// Port the agent listens on inside its container. Never published.
private ushort agentPort() {
    import std.process : environment;
    try return environment.get("IRCFIBER_SYSAGENT_PORT", "8099").strip().to!ushort;
    catch (Exception) return 8099;
}

/// True when this process was started as the telemetry sidecar.
bool sysAgentMode() {
    import std.process : environment;
    try return environment.get("IRCFIBER_SYSAGENT", "").strip() == "1";
    catch (Exception) return false;
}

/// Runs the agent and never returns. Refuses to start without a token: an
/// unauthenticated container-control API on the docker network would be a
/// worse hole than the mounts it replaces, so this fails closed.
int runSysAgent() {
    auto token = envSecret("IRCFIBER_SYSAGENT_TOKEN", "").strip();
    if (token.length < 32) {
        logError("sysagent: refusing to start — IRCFIBER_SYSAGENT_TOKEN(_FILE) "
            ~ "is missing or shorter than 32 chars. This API controls containers; "
            ~ "it is never served unauthenticated.");
        return 2;
    }
    gToken = token;

    auto router = new URLRouter;
    router.get("/healthz", &healthz);
    router.get("/sys/snapshot", &snapshot);
    router.get("/sys/containers/:name/logs", &logs);
    router.post("/sys/containers/:name/:action", &action);

    auto settings = new HTTPServerSettings;
    settings.port = agentPort();
    // The docker network address only. There is no path from the internet:
    // Caddy does not know this container and no port is published.
    settings.bindAddresses = ["0.0.0.0"];
    settings.serverString = "irc-fiber-sysagent";
    listenHTTP(settings, router);
    logInfo("sysagent: listening on :%s — docker socket + host /proc holder, "
        ~ "token-gated, no published port", settings.port);
    // Warm the collector so the first admin request already has data.
    sysSnapshot();
    return runApplication();
}

private __gshared string gToken;

/// Liveness only: no data, no auth, so the container healthcheck needs no
/// credential of its own.
private void healthz(HTTPServerRequest, HTTPServerResponse res) {
    res.writeBody("ok", "text/plain; charset=utf-8");
}

/// Constant-time bearer check. Returns false and writes 401 when absent or
/// wrong; the reason is never echoed back.
private bool authorized(HTTPServerRequest req, HTTPServerResponse res) {
    string presented;
    try {
        auto h = req.headers.get("Authorization", "");
        if (h.length > 7 && h[0 .. 7] == "Bearer ") presented = h[7 .. $].strip();
    } catch (Exception) {}
    const ok = presented.length == gToken.length && presented.length > 0
        && secureEqual(cast(const(ubyte)[]) presented, cast(const(ubyte)[]) gToken);
    if (!ok) {
        logWarn("sysagent: rejected unauthenticated %s %s", req.method, req.requestPath);
        res.statusCode = 401;
        res.writeBody(`{"ok":false,"error":"unauthorized"}`, "application/json; charset=utf-8");
        return false;
    }
    return true;
}

private void writeJson(HTTPServerResponse res, int status, Json payload) {
    res.statusCode = status;
    res.writeBody(payload.toString(), "application/json; charset=utf-8");
}

private void writeError(HTTPServerResponse res, int status, string message) {
    Json j = Json.emptyObject;
    j["ok"] = Json(false);
    j["error"] = Json(message);
    writeJson(res, status, j);
}

private void snapshot(HTTPServerRequest req, HTTPServerResponse res) {
    if (!authorized(req, res)) return;
    try {
        writeJson(res, 200, snapshotToJson(sysSnapshot()));
    } catch (Exception e) {
        logWarn("sysagent: snapshot failed: %s", e.msg);
        writeError(res, 500, e.msg);
    }
}

private void logs(HTTPServerRequest req, HTTPServerResponse res) {
    if (!authorized(req, res)) return;
    auto name = req.params["name"];
    long tail = 200;
    try {
        auto raw = req.query.get("tail", "200").strip();
        if (raw.length > 0) tail = raw.to!long;
    } catch (Exception) {}
    if (tail < 1) tail = 1;
    if (tail > 2000) tail = 2000;

    auto r = containerLogs(name, cast(int) tail);
    if (!r.ok) {
        writeError(res, r.httpStatus, r.message);
        return;
    }
    Json j = Json.emptyObject;
    j["name"] = Json(name);
    j["tail"] = Json(tail);
    j["text"] = Json(r.text);
    writeJson(res, 200, j);
}

private void action(HTTPServerRequest req, HTTPServerResponse res) {
    if (!authorized(req, res)) return;
    auto name = req.params["name"];
    auto act = req.params["action"];
    // The actor's identity is the gateway's audit line; the agent records
    // what it was asked to do and by which caller address, with the
    // percent-decoded name stripped of control characters so a forged
    // newline cannot fabricate a second log record.
    auto r = containerAction(name, act);
    if (!r.ok) {
        logWarn("sysagent: refused %s %s from %s: %s",
            logSafe(act), logSafe(name), req.peer, r.message);
        writeError(res, r.httpStatus, r.message);
        return;
    }
    logInfo("sysagent: %s %s accepted from %s", logSafe(act), logSafe(name), req.peer);
    Json j = Json.emptyObject;
    j["ok"] = Json(true);
    j["name"] = Json(name);
    j["action"] = Json(act);
    writeJson(res, 200, j);
}

/// Re-exported from `ircfiber.sysmetrics` so the agent, the gateway client
/// and the unit tests all sanitize request-supplied values the same way.
public import ircfiber.sysmetrics : logSafe;

/// Snapshot → the exact JSON the admin System page parses. The gateway
/// forwards this body verbatim, so this is the one definition of the
/// payload shape (mirrored by `frontend/src/admin/stores/system.ts`).
Json snapshotToJson(SysSnapshot s) {
    Json root = Json.emptyObject;
    root["available"]     = Json(s.available);
    root["reason"]        = Json(s.reason);
    root["collectedAtMs"] = Json(s.collectedAtMs);
    root["statsSource"]   = Json(s.statsSource);
    root["dockerError"]   = Json(s.dockerError);
    root["networkSource"] = Json(s.networkSource);

    Json host = Json.emptyObject;
    host["hostname"]          = Json(s.host.hostname);
    host["kernel"]            = Json(s.host.kernel);
    host["os"]                = Json(s.host.os);
    host["ncpu"]              = Json(cast(long) s.host.ncpu);
    host["uptimeSeconds"]     = Json(s.host.uptimeSeconds);
    host["dockerVersion"]     = Json(s.host.dockerVersion);
    host["containersRunning"] = Json(s.host.containersRunning);
    host["containersTotal"]   = Json(s.host.containersTotal);
    host["images"]            = Json(s.host.images);
    root["host"] = host;

    Json cpu = Json.emptyObject;
    cpu["percent"]       = Json(s.cpu.percent);
    cpu["userPercent"]   = Json(s.cpu.userPercent);
    cpu["systemPercent"] = Json(s.cpu.systemPercent);
    cpu["iowaitPercent"] = Json(s.cpu.iowaitPercent);
    cpu["stealPercent"]  = Json(s.cpu.stealPercent);
    cpu["load1"]         = Json(s.cpu.load1);
    cpu["load5"]         = Json(s.cpu.load5);
    cpu["load15"]        = Json(s.cpu.load15);
    cpu["load1PerCpu"]   = Json(s.cpu.load1PerCpu);
    cpu["procsRunnable"] = Json(s.cpu.procsRunnable);
    cpu["procsTotal"]    = Json(s.cpu.procsTotal);
    root["cpu"] = cpu;

    Json mem = Json.emptyObject;
    mem["totalBytes"]     = Json(s.memory.totalBytes);
    mem["usedBytes"]      = Json(s.memory.usedBytes);
    mem["availableBytes"] = Json(s.memory.availableBytes);
    mem["percent"]        = Json(s.memory.percent);
    mem["swapTotalBytes"] = Json(s.memory.swapTotalBytes);
    mem["swapUsedBytes"]  = Json(s.memory.swapUsedBytes);
    mem["swapPercent"]    = Json(s.memory.swapPercent);
    root["memory"] = mem;

    Json fsArr = Json.emptyArray;
    foreach (f; s.filesystems) {
        Json e = Json.emptyObject;
        e["device"]     = Json(f.device);
        e["mountPoint"] = Json(f.mountPoint);
        e["fsType"]     = Json(f.fsType);
        e["totalBytes"] = Json(f.totalBytes);
        e["usedBytes"]  = Json(f.usedBytes);
        e["freeBytes"]  = Json(f.freeBytes);
        e["percent"]    = Json(f.percent);
        fsArr ~= e;
    }
    root["filesystems"] = fsArr;

    Json netArr = Json.emptyArray;
    foreach (n; s.network) {
        Json e = Json.emptyObject;
        e["name"]          = Json(n.name);
        e["rxBytes"]       = Json(n.rxBytes);
        e["txBytes"]       = Json(n.txBytes);
        e["rxBytesPerSec"] = Json(n.rxBytesPerSec);
        e["txBytesPerSec"] = Json(n.txBytesPerSec);
        e["rxErrors"]      = Json(n.rxErrors);
        e["txErrors"]      = Json(n.txErrors);
        e["rxDropped"]     = Json(n.rxDropped);
        e["txDropped"]     = Json(n.txDropped);
        netArr ~= e;
    }
    root["network"] = netArr;

    Json diskArr = Json.emptyArray;
    foreach (d; s.disks) {
        Json e = Json.emptyObject;
        e["name"]             = Json(d.name);
        e["readBytesPerSec"]  = Json(d.readBytesPerSec);
        e["writeBytesPerSec"] = Json(d.writeBytesPerSec);
        e["readsPerSec"]      = Json(d.readsPerSec);
        e["writesPerSec"]     = Json(d.writesPerSec);
        diskArr ~= e;
    }
    root["disks"] = diskArr;

    Json contArr = Json.emptyArray;
    foreach (c; s.containers) contArr ~= containerToJson(c);
    root["containers"] = contArr;

    Json histArr = Json.emptyArray;
    foreach (h; s.history) {
        Json e = Json.emptyObject;
        e["atMs"]          = Json(h.atMs);
        e["cpuPercent"]    = Json(h.cpuPercent);
        e["memPercent"]    = Json(h.memPercent);
        e["rxBytesPerSec"] = Json(h.rxBytesPerSec);
        e["txBytesPerSec"] = Json(h.txBytesPerSec);
        histArr ~= e;
    }
    root["history"] = histArr;

    return root;
}

private Json containerToJson(ContainerSample c) {
    Json e = Json.emptyObject;
    e["id"]          = Json(c.id);
    e["name"]        = Json(c.name);
    e["image"]       = Json(c.image);
    e["state"]       = Json(c.state);
    e["status"]      = Json(c.status);
    e["health"]      = Json(c.health);
    e["createdAtMs"] = Json(c.createdAtMs);
    Json ports = Json.emptyArray;
    foreach (p; c.ports) ports ~= Json(p);
    e["ports"] = ports;
    // Absent cgroup stats publish as null, never as a misleading 0.
    e["cpuPercent"]    = c.hasStats ? Json(c.cpuPercent) : Json(null);
    e["memBytes"]      = c.hasStats ? Json(c.memBytes) : Json(null);
    e["memLimitBytes"] = Json(c.memLimitBytes);
    e["memPercent"]    = c.hasStats ? Json(c.memPercent) : Json(null);
    e["pids"]          = c.hasStats ? Json(c.pids) : Json(null);
    e["self"]          = Json(c.self);
    e["controllable"]  = Json(c.controllable);
    e["stopProtected"] = Json(c.stopProtected);
    e["controlReason"] = Json(c.controlReason);
    return e;
}
