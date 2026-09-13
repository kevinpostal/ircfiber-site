module leaf_test;

///
/// Unit tests for the admin K8s-leaf pure helpers
/// (ircfiber.web.admin.leaf). No k8s and no ircd needed:
///   dub --root=backend build --config=leaf-test && ./backend/leaf-test
///

import std.stdio : writeln, writefln;

import vibe.data.json : Json, parseJsonString;

import ircfiber.web.admin.leaf : DeploymentState, NodeState, PodState, LeafCheck,
    deploymentState, nodeState, podState, leafState, preflightOk;

private int failures;

private void check(bool cond, string what, string file = __FILE__, size_t line = __LINE__) {
    if (cond) return;
    failures++;
    writefln("FAIL %s:%d — %s", file, line, what);
}

/// "off" only when k8s wants no pod AND the hub holds no link: a link to a
/// server k8s says should not run is the state an operator must see.
private void testLeafState() {
    DeploymentState d;
    d.exists = true;

    d.desired = 0; d.ready = 0;
    check(leafState(d, false) == "off", "0 replicas, unlinked is off");
    check(leafState(d, true) == "degraded", "0 replicas but linked is degraded");

    d.desired = 1; d.ready = 0;
    check(leafState(d, false) == "starting", "1 desired, 0 ready is starting");
    check(leafState(d, true) == "starting", "ready trumps linked while starting");

    d.ready = 1;
    check(leafState(d, false) == "degraded", "pod ready but not linked is degraded");
    check(leafState(d, true) == "on", "ready and linked is on");

    DeploymentState missing;
    check(leafState(missing, false) == "degraded", "missing deployment is degraded");
    check(leafState(missing, true) == "degraded", "missing deployment stays degraded");
}

/// A scaled-up Deployment whose pod never became ready: `readyReplicas` is
/// absent from the status (k8s omits zero), so "ready" must read 0, not the
/// desired count.
private void testDeploymentState() {
    auto j = parseJsonString(`{
        "spec": {
            "replicas": 1,
            "template": {"spec": {"containers": [
                {"name": "inspircd", "image": "ghcr.io/kevinpostal/irc-fiber-ircd@sha256:abc"}
            ]}}
        },
        "status": {
            "replicas": 1,
            "updatedReplicas": 1,
            "unavailableReplicas": 1,
            "conditions": [
                {"type": "Progressing", "status": "True", "message": "rolling"},
                {"type": "Available", "status": "False",
                 "message": "Deployment does not have minimum availability."}
            ]
        }
    }`);
    auto d = deploymentState(j);
    check(d.exists, "deployment exists");
    check(d.desired == 1, "desired is 1");
    check(d.ready == 0, "absent readyReplicas is 0");
    check(d.updated == 1, "updated is 1");
    check(d.image == "ghcr.io/kevinpostal/irc-fiber-ircd@sha256:abc", "image parsed");
    check(d.availableCondition == "False", "Available condition picked, not Progressing");
    check(d.message == "Deployment does not have minimum availability.", "condition message kept");

    check(!deploymentState(parseJsonString(`null`)).exists, "null json is no deployment");
    check(!deploymentState(parseJsonString(`{"kind":"Status","code":404}`)).exists,
        "a 404 Status body is no deployment");
}

/// Node in the state that caused the original outage: DiskPressure True, the
/// NoSchedule taint present, still Ready.
private void testNodeState() {
    auto j = parseJsonString(`{
        "spec": {"taints": [
            {"key": "node.kubernetes.io/disk-pressure", "effect": "NoSchedule"}
        ]},
        "status": {"conditions": [
            {"type": "MemoryPressure", "status": "False"},
            {"type": "DiskPressure", "status": "True"},
            {"type": "PIDPressure", "status": "False"},
            {"type": "Ready", "status": "True"}
        ]}
    }`);
    auto n = nodeState(j);
    check(n.found, "node found");
    check(n.ready, "node Ready True");
    check(n.diskPressure, "DiskPressure True");
    check(n.diskPressureTaint, "disk-pressure taint seen");
    check(!n.memoryPressure && !n.pidPressure, "other pressures False");
    check(!n.unschedulable, "not cordoned");

    auto clean = nodeState(parseJsonString(`{
        "spec": {"unschedulable": true},
        "status": {"conditions": [{"type": "Ready", "status": "True"}]}
    }`));
    check(clean.unschedulable, "cordon read from spec.unschedulable");
    check(!clean.diskPressureTaint, "no taint on a clean node");
    check(!nodeState(parseJsonString(`null`)).found, "null json is no node");
}

/// Two pods coexist while an evicted one lingers next to its replacement;
/// the page must describe the newest.
private void testPodState() {
    auto j = parseJsonString(`{"items": [
        {
            "metadata": {"name": "ircfiber-ircd-k8s-old"},
            "status": {
                "phase": "Failed", "reason": "Evicted",
                "message": "The node was low on resource: ephemeral-storage.",
                "startTime": "2026-09-13T10:00:00Z",
                "containerStatuses": [{"ready": false, "restartCount": 0,
                    "state": {"terminated": {"reason": "ContainerStatusUnknown"}}}]
            }
        },
        {
            "metadata": {"name": "ircfiber-ircd-k8s-new"},
            "status": {
                "phase": "Running",
                "startTime": "2026-09-13T21:30:00Z",
                "containerStatuses": [{"ready": true, "restartCount": 3, "state": {"running": {}}}]
            }
        }
    ]}`);
    auto p = podState(j);
    check(p.name == "ircfiber-ircd-k8s-new", "newest pod by startTime wins");
    check(p.phase == "Running", "phase from the newest pod");
    check(p.ready, "ready from containerStatuses[0]");
    check(p.restarts == 3, "restart count reported");
    check(p.startedAtMs > 0, "startTime parsed");

    auto pulling = podState(parseJsonString(`{"items": [{
        "metadata": {"name": "ircfiber-ircd-k8s-pull"},
        "status": {"phase": "Pending", "startTime": "2026-09-13T21:30:00Z",
            "containerStatuses": [{"ready": false, "restartCount": 0, "state": {"waiting": {
                "reason": "ImagePullBackOff",
                "message": "Back-off pulling image \"ghcr.io/x:doesnotexist\""}}}]}
    }]}`));
    check(pulling.message == "ImagePullBackOff: Back-off pulling image "
        ~ `"ghcr.io/x:doesnotexist"`, "waiting reason+message surfaced");
    check(!pulling.ready, "pulling pod not ready");

    check(podState(parseJsonString(`{"items": []}`)).name.length == 0, "no pods is empty");
}

/// Warnings inform, failures block.
private void testPreflightOk() {
    LeafCheck[] allPass = [
        LeafCheck("k8s-api", "k3s API", "pass", ""),
        LeafCheck("node", "node", "pass", "")
    ];
    check(preflightOk(allPass), "all pass is ok");

    LeafCheck[] warned = allPass ~ LeafCheck("leaf-port", "listener", "warn", "leaf is off");
    check(preflightOk(warned), "warnings do not block");

    LeafCheck[] failed = warned ~ LeafCheck("node", "node", "fail", "DiskPressure");
    check(!preflightOk(failed), "one fail blocks");
    check(preflightOk([]), "no checks is vacuously ok");
}

void main() {
    testLeafState();
    testDeploymentState();
    testNodeState();
    testPodState();
    testPreflightOk();
    if (failures == 0) writeln("leaf-test: all checks passed");
    else writefln("leaf-test: %d FAILURES", failures);
    import core.stdc.stdlib : exit;
    if (failures != 0) exit(1);
}
