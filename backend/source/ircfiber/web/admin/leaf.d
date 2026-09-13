module ircfiber.web.admin.leaf;

/// Admin "K8s leaf" page: drive the k3s InspIRCd leaf (k8s.ircfiber.com) on
/// and off, and prove the cluster and hub sides are healthy before starting
/// it.
///
/// The leaf's k3s Deployment replica count is the single source of truth for
/// "on": 1 = the pod runs, 0 = off. The hub only DECLARES the `<link>` — its
/// `<autoconnect>` is gone (roles/ircd/templates/custom.conf.j2), because a
/// 16s retry against an evicted pod turned every failure into a network-wide
/// `REMOTELINK … Connection closed` snotice on every linked network. This
/// module is the only dialer: a CONNECT on Start plus a once-a-minute
/// reconcile (`startLeafSupervisor`).
///
/// Stop unlinks with SQUIT *before* scaling to zero, so peers see one clean
/// netsplit for a declared server instead of a lost-connection snotice.
///
/// Env (all defaulted — nothing new is required in roles/gateway's env.j2):
///   IRCFIBER_K8S_LEAF_SERVER      leaf server name.  Default: k8s.ircfiber.com
///   IRCFIBER_K8S_LEAF_DEPLOYMENT  Deployment name.   Default: ircfiber-ircd-k8s
///   IRCFIBER_K8S_LEAF_NODE        node to preflight. Default: ubuntu-docker
/// The k3s connection itself comes from IRCFIBER_K8S_* (web.admin.k8s).

import std.algorithm : canFind, map, sort;
import std.array : array, join, split;
import std.conv : to;
import std.datetime : dur;
import std.string : strip, splitLines;
import core.time : seconds;

import vibe.http.server : HTTPServerRequest, HTTPServerResponse;
import vibe.core.log : logInfo, logWarn;
import vibe.data.json : Json;

import ircfiber.models.user : User;
import ircfiber.web.admin.helpers : jsonOk, jsonError, readJsonBody;
import ircfiber.web.admin.k8s : K8sSettings, loadK8sSettings, K8sError, k8sRaw,
    k8sJson, parseK8sTimeMs;
import ircfiber.web.admin.ircd : ConfLink, ConnectResult, IrcdClient, IrcdError,
    configuredLinks, connectLink, liveLinkNames, loadIrcdSettings, squitLink,
    wellFormedServerName, withIrcd, withIrcdSession;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

struct LeafSettings {
    string serverName = "k8s.ircfiber.com";
    string deployment = "ircfiber-ircd-k8s";
    string node = "ubuntu-docker";
}

LeafSettings loadLeafSettings() {
    import std.process : environment;
    LeafSettings s;
    try {
        auto n = environment.get("IRCFIBER_K8S_LEAF_SERVER", "").strip();
        if (n.length) s.serverName = n;
        auto d = environment.get("IRCFIBER_K8S_LEAF_DEPLOYMENT", "").strip();
        if (d.length) s.deployment = d;
        auto k = environment.get("IRCFIBER_K8S_LEAF_NODE", "").strip();
        if (k.length) s.node = k;
    } catch (Exception) {}
    return s;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — covered by tests/leaf_test.d)
// ---------------------------------------------------------------------------

struct DeploymentState {
    bool exists;
    long desired;
    long ready;
    long updated;
    string image;
    /// status of the `Available` condition ("True"/"False"/""), not a bool:
    /// "no condition yet" and "explicitly unavailable" are different states.
    string availableCondition;
    string message;
}

private long jsonLong(Json v, long fallback = 0) {
    switch (v.type) {
        case Json.Type.int_: return v.get!long;
        case Json.Type.float_: return cast(long) v.get!double;
        case Json.Type.string:
            try return v.get!string.to!long;
            catch (Exception) return fallback;
        default: return fallback;
    }
}

private string jsonStr(Json v, string fallback = "") {
    return v.type == Json.Type.string ? v.get!string : fallback;
}

private Json jsonField(Json obj, string key) {
    if (obj.type != Json.Type.object) return Json.init;
    auto p = key in obj;
    return p is null ? Json.init : *p;
}

/// Deployment → replica counts, image and the Available condition.
/// `spec.replicas` absent means 1 in k8s' own defaulting, but the manifest
/// deliberately omits the field and the API server always reports the
/// effective value, so an absent field here means "unknown" → 0.
DeploymentState deploymentState(Json deploy) {
    DeploymentState d;
    if (deploy.type != Json.Type.object) return d;
    auto spec = jsonField(deploy, "spec");
    auto status = jsonField(deploy, "status");
    if (spec.type != Json.Type.object && status.type != Json.Type.object) return d;
    d.exists = true;
    d.desired = jsonLong(jsonField(spec, "replicas"));
    d.ready = jsonLong(jsonField(status, "readyReplicas"));
    d.updated = jsonLong(jsonField(status, "updatedReplicas"));
    auto containers = jsonField(jsonField(jsonField(spec, "template"), "spec"), "containers");
    if (containers.type == Json.Type.array && containers.length > 0)
        d.image = jsonStr(jsonField(containers[0], "image"));
    auto conds = jsonField(status, "conditions");
    if (conds.type == Json.Type.array)
        foreach (c; conds) {
            if (jsonStr(jsonField(c, "type")) != "Available") continue;
            d.availableCondition = jsonStr(jsonField(c, "status"));
            d.message = jsonStr(jsonField(c, "message"));
            break;
        }
    return d;
}

struct PodState {
    string name;
    string phase;
    bool ready;
    long restarts;
    long startedAtMs;
    string message;
}

/// Newest pod of the leaf's label selector. `Recreate` strategy means there
/// is normally one, but an evicted pod lingers next to its replacement, and
/// the newest is the one whose state the operator is waiting on.
PodState podState(Json podList) {
    PodState best;
    auto items = jsonField(podList, "items");
    if (items.type != Json.Type.array) return best;
    bool have = false;
    foreach (item; items) {
        auto status = jsonField(item, "status");
        PodState p;
        p.name = jsonStr(jsonField(jsonField(item, "metadata"), "name"));
        p.phase = jsonStr(jsonField(status, "phase"));
        p.startedAtMs = parseK8sTimeMs(jsonStr(jsonField(status, "startTime")));
        auto cs = jsonField(status, "containerStatuses");
        if (cs.type == Json.Type.array && cs.length > 0) {
            p.ready = jsonField(cs[0], "ready").type == Json.Type.bool_
                ? jsonField(cs[0], "ready").get!bool : false;
            p.restarts = jsonLong(jsonField(cs[0], "restartCount"));
            auto waiting = jsonField(jsonField(cs[0], "state"), "waiting");
            auto terminated = jsonField(jsonField(cs[0], "state"), "terminated");
            if (waiting.type == Json.Type.object)
                p.message = podStateMessage(waiting);
            else if (terminated.type == Json.Type.object)
                p.message = podStateMessage(terminated);
        }
        if (p.message.length == 0) {
            auto reason = jsonStr(jsonField(status, "reason"));
            auto msg = jsonStr(jsonField(status, "message"));
            if (reason.length && msg.length) p.message = reason ~ ": " ~ msg;
            else if (reason.length) p.message = reason;
            else p.message = msg;
        }
        if (!have || p.startedAtMs > best.startedAtMs) { best = p; have = true; }
    }
    return best;
}

/// "ImagePullBackOff: Back-off pulling image …" — reason and message of a
/// container state, whichever of the two the kubelet filled in.
private string podStateMessage(Json state) {
    auto reason = jsonStr(jsonField(state, "reason"));
    auto msg = jsonStr(jsonField(state, "message"));
    if (reason.length && msg.length) return reason ~ ": " ~ msg;
    return reason.length ? reason : msg;
}

struct NodeState {
    bool found;
    bool ready;
    bool diskPressure;
    bool memoryPressure;
    bool pidPressure;
    bool unschedulable;
    /// `node.kubernetes.io/disk-pressure:NoSchedule` still on the node. The
    /// taint outlives the condition, and the leaf tolerates it, so it is a
    /// warning about a disk that was recently full — never a hard fail.
    bool diskPressureTaint;
}

NodeState nodeState(Json node) {
    NodeState n;
    if (node.type != Json.Type.object) return n;
    auto status = jsonField(node, "status");
    auto spec = jsonField(node, "spec");
    if (status.type != Json.Type.object && spec.type != Json.Type.object) return n;
    n.found = true;
    auto conds = jsonField(status, "conditions");
    if (conds.type == Json.Type.array)
        foreach (c; conds) {
            auto t = jsonStr(jsonField(c, "type"));
            const on = jsonStr(jsonField(c, "status")) == "True";
            switch (t) {
                case "Ready": n.ready = on; break;
                case "DiskPressure": n.diskPressure = on; break;
                case "MemoryPressure": n.memoryPressure = on; break;
                case "PIDPressure": n.pidPressure = on; break;
                default: break;
            }
        }
    auto unsched = jsonField(spec, "unschedulable");
    if (unsched.type == Json.Type.bool_) n.unschedulable = unsched.get!bool;
    auto taints = jsonField(spec, "taints");
    if (taints.type == Json.Type.array)
        foreach (t; taints)
            if (jsonStr(jsonField(t, "key")) == "node.kubernetes.io/disk-pressure")
                n.diskPressureTaint = true;
    return n;
}

/// The page's four-state summary. `desired == 0 && linked` is degraded, not
/// off: the hub still holds a link to a server k8s says should not run.
string leafState(DeploymentState d, bool linked) {
    if (!d.exists) return "degraded";
    if (d.desired == 0) return linked ? "degraded" : "off";
    if (d.ready == 0) return "starting";
    return linked ? "on" : "degraded";
}

struct LeafCheck {
    string id;
    string label;
    string status;  // "pass" | "warn" | "fail"
    string detail;
}

/// Preflight verdict: warnings never block a start, failures do.
bool preflightOk(LeafCheck[] checks) {
    foreach (c; checks)
        if (c.status == "fail") return false;
    return true;
}

// ---------------------------------------------------------------------------
// k8s calls
// ---------------------------------------------------------------------------

private string deployPath(K8sSettings k, LeafSettings l) {
    return "/apis/apps/v1/namespaces/" ~ k.ns ~ "/deployments/" ~ l.deployment;
}

private Json readDeployment(K8sSettings k, LeafSettings l) {
    return k8sJson(k, "GET", deployPath(k, l));
}

private Json readPods(K8sSettings k, LeafSettings l) {
    return k8sJson(k, "GET", "/api/v1/namespaces/" ~ k.ns
        ~ "/pods?labelSelector=app%3D" ~ l.deployment);
}

private Json readNode(K8sSettings k, LeafSettings l) {
    return k8sJson(k, "GET", "/api/v1/nodes/" ~ l.node);
}

/// Merge-patch the scale subresource. `deployments/scale` patch is the one
/// write verb the gateway token holds on workloads (rbac-backup-admin.yaml).
private void scaleLeaf(K8sSettings k, LeafSettings l, int replicas) {
    k8sRaw(k, "PATCH", deployPath(k, l) ~ "/scale",
        `{"spec":{"replicas":` ~ replicas.to!string ~ `}}`,
        "application/merge-patch+json");
}

/// Last `lines` log lines of the newest leaf pod, or an empty array when
/// there is no pod / the log is unreadable. Diagnosis only — never fatal.
private string[] podLogTail(K8sSettings k, LeafSettings l, string podName, int lines = 40) {
    if (podName.length == 0) return null;
    try {
        auto text = k8sRaw(k, "GET", "/api/v1/namespaces/" ~ k.ns ~ "/pods/"
            ~ podName ~ "/log?container=inspircd&tailLines=" ~ lines.to!string);
        string[] out_;
        foreach (line; text.splitLines()) if (line.strip().length) out_ ~= line;
        return out_;
    } catch (Exception e) {
        logWarn("admin-leaf: pod log %s unreadable: %s", podName, e.msg);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

private Json deploymentJson(DeploymentState d) {
    auto o = Json.emptyObject;
    o["exists"] = Json(d.exists);
    o["desired"] = Json(d.desired);
    o["ready"] = Json(d.ready);
    o["updated"] = Json(d.updated);
    o["image"] = Json(d.image);
    o["available"] = Json(d.availableCondition);
    o["message"] = Json(d.message);
    return o;
}

private Json podJson(PodState p) {
    auto o = Json.emptyObject;
    o["name"] = Json(p.name);
    o["phase"] = Json(p.phase);
    o["ready"] = Json(p.ready);
    o["restarts"] = Json(p.restarts);
    o["startedAtMs"] = Json(p.startedAtMs);
    o["message"] = Json(p.message);
    return o;
}

private Json nodeJson(NodeState n) {
    auto o = Json.emptyObject;
    o["found"] = Json(n.found);
    o["ready"] = Json(n.ready);
    o["diskPressure"] = Json(n.diskPressure);
    o["memoryPressure"] = Json(n.memoryPressure);
    o["pidPressure"] = Json(n.pidPressure);
    o["unschedulable"] = Json(n.unschedulable);
    o["diskPressureTaint"] = Json(n.diskPressureTaint);
    return o;
}

/// The leaf's `<link>` tag as declared in the gateway-visible conf dir.
/// `present` false means the hub does not declare the link at all (deploy
/// roles/ircd), or this container has no conf mount (the bnc/support-bot
/// sidecars run the same image without it).
private ConfLink leafConfLink(string serverName, out bool present) {
    import std.string : toLower;
    present = false;
    ConfLink out_;
    try {
        foreach (c; configuredLinks(loadIrcdSettings().confDir))
            if (c.name.toLower() == serverName.toLower()) {
                present = true;
                return c;
            }
    } catch (Exception) {}
    return out_;
}

private Json linkJson(string serverName) {
    bool present;
    auto c = leafConfLink(serverName, present);
    auto o = Json.emptyObject;
    o["present"] = Json(present);
    o["ipaddr"] = Json(c.ipaddr);
    o["port"] = Json(c.port);
    o["autoconnect"] = Json(c.autoconnect);
    return o;
}

/// Everything the page shows, from k8s + the live LINKS view. `k8sConfigured`
/// false still answers 200 with the IRC-side fields filled, so the page
/// explains the missing token instead of erroring.
private Json leafStatusJson(K8sSettings k, LeafSettings l, bool linked) {
    DeploymentState d;
    PodState p;
    NodeState n;
    string k8sError = "";
    if (k.configured()) {
        try {
            d = deploymentState(readDeployment(k, l));
            p = podState(readPods(k, l));
            n = nodeState(readNode(k, l));
        } catch (K8sError e) {
            k8sError = e.msg;
        }
    }
    auto data = Json.emptyObject;
    data["name"] = Json(l.serverName);
    data["state"] = Json(k.configured() && k8sError.length == 0
        ? leafState(d, linked) : "degraded");
    data["linked"] = Json(linked);
    data["k8sConfigured"] = Json(k.configured());
    data["k8sError"] = Json(k8sError);
    data["deployment"] = deploymentJson(d);
    data["pod"] = podJson(p);
    data["node"] = nodeJson(n);
    data["link"] = linkJson(l.serverName);
    return data;
}

/// GET /api/admin/ircd/leaf
package void apiLeafStatus(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower;
    auto l = loadLeafSettings();
    auto k = loadK8sSettings();
    withIrcd(req, res, (client) {
        const linked = (l.serverName.toLower() in liveLinkNames(client)) !is null;
        jsonOk(res, leafStatusJson(k, l, linked));
    });
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/// TCP reachability of the leaf's link listener from the gateway. The hub
/// shares this host's tailnet route, so a success is evidence the path
/// exists — it is NOT proof the hub itself can link (that needs the CAPAB
/// exchange, which only CONNECT performs).
private bool probeLeafPort(string host, ushort port, out string err) {
    import vibe.core.net : connectTCP;
    err = "";
    try {
        auto conn = connectTCP(host, port, null, 0, 5.seconds);
        try conn.close(); catch (Exception) {}
        return true;
    } catch (Exception e) {
        err = e.msg;
        return false;
    }
}

/// The five checks the page runs before Start. Order is fixed: cluster
/// reachability, node health, workload, hub declaration, network path.
private LeafCheck[] leafPreflight(K8sSettings k, LeafSettings l) {
    LeafCheck[] checks;
    DeploymentState d;
    NodeState n;
    bool haveDeploy = false;

    if (!k.configured()) {
        checks ~= LeafCheck("k8s-api", "k3s API reachable", "fail",
            "IRCFIBER_K8S_TOKEN/IRCFIBER_K8S_API_URL are not set on the gateway, "
            ~ "so the leaf cannot be scaled. Deploy roles/gateway.");
    } else {
        string apiErr = "";
        try {
            d = deploymentState(readDeployment(k, l));
            haveDeploy = true;
        } catch (K8sError e) {
            apiErr = e.msg;
        }
        if (apiErr.length)
            checks ~= LeafCheck("k8s-api", "k3s API reachable", "fail", apiErr);
        else
            checks ~= LeafCheck("k8s-api", "k3s API reachable", "pass",
                k.apiUrl ~ " answered for namespace " ~ k.ns ~ ".");
    }

    // Node: cluster-scoped read (ClusterRole ircfiber-gateway-node-reader).
    if (!k.configured()) {
        checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "fail",
            "No k3s credentials — node conditions unknown.");
    } else {
        try {
            n = nodeState(readNode(k, l));
            if (!n.found) {
                checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "fail",
                    "Node " ~ l.node ~ " was not found in the cluster.");
            } else {
                string[] bad;
                if (!n.ready) bad ~= "Ready is not True";
                if (n.diskPressure) bad ~= "DiskPressure";
                if (n.memoryPressure) bad ~= "MemoryPressure";
                if (n.pidPressure) bad ~= "PIDPressure";
                if (bad.length)
                    checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "fail",
                        l.node ~ ": " ~ bad.join(", ")
                        ~ ". Starting the leaf now means the kubelet evicts the pod as "
                        ~ "fast as it is created.");
                else if (n.unschedulable)
                    checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "warn",
                        l.node ~ " is cordoned (spec.unschedulable): conditions are clean "
                        ~ "but no new pod will be scheduled until it is uncordoned.");
                else if (n.diskPressureTaint)
                    checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "warn",
                        l.node ~ " still carries node.kubernetes.io/disk-pressure:NoSchedule "
                        ~ "while its conditions are clean. The leaf tolerates the taint, "
                        ~ "but the node's disk was recently full.");
                else
                    checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "pass",
                        l.node ~ ": Ready, no disk/memory/PID pressure.");
            }
        } catch (K8sError e) {
            checks ~= LeafCheck("node", "Node " ~ l.node ~ " healthy", "fail", e.msg);
        }
    }

    // Deployment: exists and carries a resolvable image.
    if (!haveDeploy) {
        checks ~= LeafCheck("deployment", "Deployment " ~ l.deployment ~ " ready to scale",
            "fail", "Deployment " ~ l.deployment ~ " could not be read — run "
            ~ "`make deploy-ircd-k8s` to apply it.");
    } else if (!d.exists) {
        checks ~= LeafCheck("deployment", "Deployment " ~ l.deployment ~ " ready to scale",
            "fail", "Deployment " ~ l.deployment ~ " does not exist in namespace "
            ~ k.ns ~ " — run `make deploy-ircd-k8s`.");
    } else if (d.image.length == 0) {
        checks ~= LeafCheck("deployment", "Deployment " ~ l.deployment ~ " ready to scale",
            "fail", "The Deployment's first container has no image set.");
    } else if (d.desired >= 1) {
        checks ~= LeafCheck("deployment", "Deployment " ~ l.deployment ~ " ready to scale",
            "warn", "the leaf is already scheduled (spec.replicas=" ~ d.desired.to!string
            ~ ", ready=" ~ d.ready.to!string ~ "). Start will re-issue CONNECT.");
    } else {
        checks ~= LeafCheck("deployment", "Deployment " ~ l.deployment ~ " ready to scale",
            "pass", "image " ~ d.image ~ ", currently scaled to 0.");
    }

    // Hub declaration: read from the conf dir bind-mounted into this
    // container. Sidecars on the same image have no mount → warn, not fail.
    bool present;
    auto conf = leafConfLink(l.serverName, present);
    bool confReadable = false;
    {
        import std.file : exists;
        import std.path : buildPath;
        try confReadable = exists(buildPath(loadIrcdSettings().confDir, "custom.conf"));
        catch (Exception) { confReadable = false; }
    }
    if (!confReadable)
        checks ~= LeafCheck("hub-link", "Hub declares <link> " ~ l.serverName, "warn",
            "custom.conf is not readable here (the hub's conf dir is not mounted into "
            ~ "this container), so the declaration cannot be checked from this gateway.");
    else if (!present)
        checks ~= LeafCheck("hub-link", "Hub declares <link> " ~ l.serverName, "fail",
            "No <link name=\"" ~ l.serverName ~ "\"> in the hub's config — run "
            ~ "`make deploy-ircd` so the hub declares the link, then rehash.");
    else if (conf.autoconnect)
        checks ~= LeafCheck("hub-link", "Hub declares <link> " ~ l.serverName, "warn",
            "the <link> is declared but still has <autoconnect>: remove it (the "
            ~ "supervisor dials, two dialers race and a failed dial storms every "
            ~ "peer with REMOTELINK snotices every 16s).");
    else
        checks ~= LeafCheck("hub-link", "Hub declares <link> " ~ l.serverName, "pass",
            "<link " ~ (conf.ipaddr.length ? conf.ipaddr : "?") ~ ":"
            ~ (conf.port.length ? conf.port : "?") ~ "> declared, no autoconnect.");

    // Network path: only meaningful once a pod is listening.
    string host = conf.ipaddr.length ? conf.ipaddr : "100.94.116.56";
    ushort port = 7001;
    if (conf.port.length) {
        try port = conf.port.to!ushort;
        catch (Exception) { port = 7001; }
    }
    const where = host ~ ":" ~ port.to!string;
    string probeErr;
    const reachable = probeLeafPort(host, port, probeErr);
    if (reachable)
        checks ~= LeafCheck("leaf-port", "Link listener " ~ where ~ " reachable", "pass",
            "TCP connect succeeded from the gateway. The hub shares this host's "
            ~ "tailnet route, so the path exists — the CAPAB exchange is still only "
            ~ "proven by an actual CONNECT.");
    else if (haveDeploy && d.ready >= 1)
        checks ~= LeafCheck("leaf-port", "Link listener " ~ where ~ " reachable", "fail",
            "the leaf pod reports ready but " ~ where ~ " does not accept a connection ("
            ~ probeErr ~ "). Check the hostPort/hostIP mapping and the tailnet route.");
    else
        checks ~= LeafCheck("leaf-port", "Link listener " ~ where ~ " reachable", "warn",
            "no connection to " ~ where ~ " — expected while the leaf is off; it is "
            ~ "the pod that binds this port.");

    return checks;
}

private Json preflightJson(LeafCheck[] checks) {
    auto arr = Json.emptyArray;
    foreach (c; checks) {
        auto o = Json.emptyObject;
        o["id"] = Json(c.id);
        o["label"] = Json(c.label);
        o["status"] = Json(c.status);
        o["detail"] = Json(c.detail);
        arr ~= o;
    }
    auto data = Json.emptyObject;
    data["ok"] = Json(preflightOk(checks));
    data["checks"] = arr;
    return data;
}

/// GET /api/admin/ircd/leaf/preflight
package void apiLeafPreflight(HTTPServerRequest req, HTTPServerResponse res) {
    auto l = loadLeafSettings();
    auto k = loadK8sSettings();
    jsonOk(res, preflightJson(leafPreflight(k, l)));
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------

private string adminName(HTTPServerRequest req) {
    try {
        auto u = req.context["user"].get!User;
        return u.username.length ? u.username : "?";
    } catch (Exception) {
        return "?";
    }
}

/// Failed check ids, comma-joined, for the 409 body. The page already holds
/// the full check list from its own preflight call, so the error carries ids.
private string failedIds(LeafCheck[] checks) {
    string[] ids;
    foreach (c; checks) if (c.status == "fail") ids ~= c.id;
    return ids.join(", ");
}

/// POST /api/admin/ircd/leaf/start {force?}
///
/// Preflight → scale to 1 → wait for a ready pod → CONNECT. The IRC leg runs
/// on a private oper session, never the shared one: the ready-wait is up to
/// 120s and the shared session serves the rest of the admin page meanwhile.
package void apiLeafStart(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower;
    import vibe.core.core : sleep;
    import std.datetime : Clock;

    auto body = readJsonBody(req);
    bool force = false;
    if (body.type == Json.Type.object) {
        auto f = "force" in body;
        if (f !is null && f.type == Json.Type.bool_) force = f.get!bool;
    }
    auto l = loadLeafSettings();
    auto k = loadK8sSettings();
    if (!wellFormedServerName(l.serverName)) {
        jsonError(res, 500, "IRCFIBER_K8S_LEAF_SERVER is not a well-formed server name.");
        return;
    }

    auto checks = leafPreflight(k, l);
    if (!preflightOk(checks) && !force) {
        jsonError(res, 409, "Preflight failed: " ~ failedIds(checks)
            ~ " — re-run the checks or start with force.");
        return;
    }

    const startedMs = Clock.currTime.stdTime / 10_000;
    DeploymentState d;
    PodState p;
    try {
        scaleLeaf(k, l, 1);
        // 2s poll, 120s budget: image pull on a cold node is the slow case.
        bool ready = false;
        foreach (attempt; 0 .. 60) {
            sleep(dur!"msecs"(2000));
            d = deploymentState(readDeployment(k, l));
            if (d.ready >= 1) { ready = true; break; }
        }
        p = podState(readPods(k, l));
        if (!ready) {
            auto tail = podLogTail(k, l, p.name);
            logWarn("admin-leaf: %s did not become ready in 120s (phase %s: %s); log tail: %s",
                l.deployment, p.phase, p.message, tail.length ? tail[$ - 1] : "(empty)");
            jsonError(res, 504, "Leaf pod did not become ready in 120s (phase "
                ~ (p.phase.length ? p.phase : "unknown") ~ ": "
                ~ (p.message.length ? p.message : "no pod message")
                ~ "). The Deployment is still scaled to 1, so the ReplicaSet keeps "
                ~ "recreating the pod — press Stop to scale it back to 0.");
            return;
        }
    } catch (K8sError e) {
        jsonError(res, e.httpStatus, e.msg);
        return;
    }

    // Own session: a 120s scale-wait must never park the shared one, and the
    // CONNECT itself is a few seconds.
    bool linked = false;
    string notice = "";
    try {
        auto client = new IrcdClient(loadIrcdSettings());
        scope (exit) client.close();
        auto r = connectLink(client, l.serverName);
        if (r.denied) {
            jsonError(res, 403, "The dashboard oper may not CONNECT. Deploy roles/ircd "
                ~ "(opers.conf grants CONNECT to the Dashboard class) and rehash.");
            return;
        }
        notice = r.notice;
        linked = r.linked;
    } catch (IrcdError e) {
        jsonError(res, e.httpStatus, e.msg);
        return;
    } catch (Exception e) {
        logWarn("admin-leaf: CONNECT %s failed: %s", l.serverName, e.msg);
        jsonError(res, 502, "The leaf pod is ready but the CONNECT failed: " ~ e.msg);
        return;
    }

    logInfo("Admin leaf start by %s (linked=%s)", adminName(req), linked);
    auto data = Json.emptyObject;
    data["linked"] = Json(linked);
    data["notice"] = Json(notice);
    data["elapsedMs"] = Json(Clock.currTime.stdTime / 10_000 - startedMs);
    data["state"] = Json(leafState(d, linked));
    if (!linked) {
        // This is where a CAPAB/link-password failure shows up.
        auto tail = podLogTail(k, l, p.name);
        auto arr = Json.emptyArray;
        foreach (line; tail) arr ~= Json(line);
        data["podLogTail"] = arr;
    }
    jsonOk(res, data);
}

/// POST /api/admin/ircd/leaf/stop {reason?}
///
/// SQUIT first, then scale to 0: killing the pod without unlinking makes
/// every peer print a lost-connection snotice instead of a clean netsplit.
package void apiLeafStop(HTTPServerRequest req, HTTPServerResponse res) {
    import std.string : toLower;

    auto body = readJsonBody(req);
    string reason = "Leaf stopped from the admin dashboard";
    if (body.type == Json.Type.object) {
        auto r = "reason" in body;
        if (r !is null && r.type == Json.Type.string) {
            auto given = r.get!string.strip();
            if (given.length) {
                if (given.length > 120) {
                    jsonError(res, 400, "reason must be at most 120 characters.");
                    return;
                }
                foreach (c; given)
                    if (c < 0x20 || c == 0x7f) {
                        jsonError(res, 400, "reason must not contain control characters.");
                        return;
                    }
                reason = given;
            }
        }
    }

    auto l = loadLeafSettings();
    auto k = loadK8sSettings();
    if (!wellFormedServerName(l.serverName)) {
        jsonError(res, 500, "IRCFIBER_K8S_LEAF_SERVER is not a well-formed server name.");
        return;
    }
    if (!k.configured()) {
        jsonError(res, 503, "k3s credentials are not configured on the gateway, so the "
            ~ "leaf Deployment cannot be scaled down. Deploy roles/gateway.");
        return;
    }

    bool linked = false;
    string notice = "";
    try {
        auto client = new IrcdClient(loadIrcdSettings());
        scope (exit) client.close();
        linked = (l.serverName.toLower() in liveLinkNames(client)) !is null;
        if (linked) notice = squitLink(client, l.serverName, reason);
    } catch (IrcdError e) {
        if (e.httpStatus == 403) {
            jsonError(res, 403, "The dashboard oper may not SQUIT. Deploy roles/ircd "
                ~ "(opers.conf grants SQUIT to the Dashboard class) and rehash.");
            return;
        }
        jsonError(res, e.httpStatus, e.msg);
        return;
    } catch (Exception e) {
        logWarn("admin-leaf: SQUIT %s failed: %s", l.serverName, e.msg);
        jsonError(res, 502, "SQUIT failed: " ~ e.msg);
        return;
    }

    try scaleLeaf(k, l, 0);
    catch (K8sError e) {
        jsonError(res, e.httpStatus, e.msg);
        return;
    }

    logInfo("Admin leaf stop by %s (was linked=%s, reason=%s)", adminName(req), linked, reason);
    // Post-SQUIT the link is gone; the Deployment reports 0 desired within
    // the same request, so the page can render the final state immediately.
    auto data = leafStatusJson(k, l, false);
    data["notice"] = Json(notice);
    jsonOk(res, data);
}

// ---------------------------------------------------------------------------
// Reconcile supervisor
// ---------------------------------------------------------------------------

/// Replaces the hub's removed `<autoconnect>`: once a minute, if the leaf's
/// Deployment wants a pod AND that pod is ready AND the server is absent from
/// LINKS, issue one CONNECT. Nothing is dialled while `spec.replicas == 0`,
/// which is the entire point — an unreachable leaf produces no retry traffic
/// and therefore no REMOTELINK snotice storm on peer networks.
///
/// During a blue/green swap two gateway replicas run this timer. A redundant
/// CONNECT for an already-linked server is answered by InspIRCd with a
/// harmless "already exists" notice, so no cross-container lock is needed.
///
/// Disabled unless this container is the admin gateway: the bnc, support-bot
/// and fibereye sidecars run the same image without the hub's conf dir
/// mounted, and that mount is the test.
public void startLeafSupervisor() {
    import vibe.core.core : setTimer;
    import std.file : exists;
    import std.path : buildPath;

    auto k = loadK8sSettings();
    auto ircd = loadIrcdSettings();
    string why = "";
    if (!k.configured()) why = "no k3s credentials (IRCFIBER_K8S_TOKEN)";
    else if (!ircd.configured()) why = "no ircd oper credentials";
    else {
        bool confMounted = false;
        try confMounted = exists(buildPath(ircd.confDir, "custom.conf"));
        catch (Exception) { confMounted = false; }
        if (!confMounted)
            why = "ircd conf dir " ~ ircd.confDir ~ " is not mounted (not the admin gateway)";
    }
    if (why.length) {
        logInfo("leaf supervisor: disabled (%s)", why);
        return;
    }

    auto l = loadLeafSettings();
    logInfo("leaf supervisor: reconciling %s every 60s (no hub autoconnect)", l.serverName);
    setTimer(60.seconds, () @trusted nothrow {
        try leafSupervisorTick();
        catch (Exception e) {
            try logWarn("leaf supervisor: tick failed: %s", e.msg);
            catch (Exception) {}
        }
    }, true);
}

/// One reconcile pass. Never throws out of the timer (the caller catches);
/// a single CONNECT per tick is the rate limit.
private void leafSupervisorTick() {
    import std.string : toLower;
    auto l = loadLeafSettings();
    auto k = loadK8sSettings();
    if (!k.configured()) return;

    auto d = deploymentState(readDeployment(k, l));
    if (!d.exists || d.desired < 1 || d.ready < 1) return;

    withIrcdSession((client) {
        if ((l.serverName.toLower() in liveLinkNames(client)) !is null) return;
        auto r = connectLink(client, l.serverName, 1);
        if (r.denied) {
            logWarn("leaf supervisor: CONNECT %s denied (oper class lacks CONNECT)",
                l.serverName);
            return;
        }
        logInfo("leaf supervisor: CONNECT %s (linked=%s, notice=%s)",
            l.serverName, r.linked, r.notice);
    });
}
