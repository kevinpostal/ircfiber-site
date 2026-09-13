module ircfiber.web.admin.system;

/// Admin System page API — host CPU/memory/disk/network plus the Docker
/// containers on this host.
///
/// All collection lives in `ircfiber.sysmetrics` (a background thread, no
/// vibe types); this module is only the HTTP edge and the one place that
/// knows vibe's `Json`. The payload shape below is mirrored field for field
/// by `site/frontend/src/admin/stores/system.ts`.
///
/// Actions are gated in the collector, not here: the gateway's own
/// container can never be stopped or restarted, and only
/// `ircfiber-*` / `tailscale-mullvad-*` names are controllable.

import std.conv : to;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.sysmetrics : SysSnapshot, containerAction, containerLogs, sysSnapshot;
import ircfiber.web.admin.helpers : jsonError, jsonOk, queryString;

/// GET /api/admin/system — one snapshot of host + containers.
package void apiSystemOverview(HTTPServerRequest, HTTPServerResponse res) {
    try {
        jsonOk(res, snapshotToJson(sysSnapshot()));
    } catch (Exception e) {
        logWarn("apiSystemOverview failed: %s", e.msg);
        jsonError(res, 500, e.msg);
    }
}

/// POST /api/admin/system/containers/:name/:action — start|stop|restart.
package void apiSystemContainerAction(HTTPServerRequest req, HTTPServerResponse res) {
    auto name = req.params["name"];
    auto action = req.params["action"];
    if (action != "start" && action != "stop" && action != "restart") {
        jsonError(res, 400, "unknown action: " ~ action);
        return;
    }
    auto r = containerAction(name, action);
    if (!r.ok) {
        logWarn("Admin %s container %s refused: %s", action, name, r.message);
        jsonError(res, r.httpStatus, r.message);
        return;
    }
    logInfo("Admin %s container %s", action, name);
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
    try {
        auto text = containerLogs(name, cast(int) tail);
        Json data = Json.emptyObject;
        data["name"] = Json(name);
        data["tail"] = Json(tail);
        data["text"] = Json(text);
        jsonOk(res, data);
    } catch (Exception e) {
        logWarn("apiSystemContainerLogs(%s) failed: %s", name, e.msg);
        jsonError(res, 503, e.msg);
    }
}

/// Snapshot → the exact JSON the System page parses.
private Json snapshotToJson(SysSnapshot s) {
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
    foreach (c; s.containers) {
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
        e["controlReason"] = Json(c.controlReason);
        contArr ~= e;
    }
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
