# ircfiber on k3s — wiring to Signoz

**Namespace strategy:** `signoz` stays separate (observability), `ircfiber` is new (app). They communicate via Kubernetes DNS `signoz-otel-collector.signoz.svc.cluster.local:4317/4318` — no same-namespace grouping needed. Rancher UI grouping via `project` label (`ircfiber` / `observability`) is cosmetic; actual access is via `NetworkPolicy` (default is `allow-all`, we add explicit policies for intent).

**What’s wired:**
- `ircfiber` namespace created (`kubernetes.io/metadata.name=ircfiber`, `project=ircfiber`); `signoz` labeled `project=observability`.
- `irc3` / `irc3-dev` patched: `OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector.signoz.svc.cluster.local:4318` (if irc3 image ignores it, it no-ops; logs still visible via synthetic).
- `ircfiber` demo loggers (`ircfiber-logger` + `ircfiber-engine-logger`) — `curlimages/curl` loops posting OTLP `logs`/`traces` every 15s/30s with `service.name=ircfiber-gateway/engine`, `IRCFIBER_OTEL_ENABLED=1`, `IRCFIBER_OTEL_ENDPOINT=http://signoz-otel-collector.signoz.svc.cluster.local:4318`.
- `NetworkPolicy` `allow-signoz-otel` (in `signoz`) ingress to the collector on 4317/4318/4319/4320/8888/13133 from `ircfiber,ircfiber-prod,irc3,irc3-dev,k8s-infra,tailscale,signoz` + `10.42.0.0/16` + tailnet `100.64.0.0/10`; `collector-egress-allow` (in `signoz`) collector egress incl. `signoz:4320` (OpAMP — without it the collector starts NO pipelines); `allow-egress-to-signoz` (in `ircfiber`) egress to `signoz`. k3s (kube-router) ENFORCES these — a missing source silently drops OTLP.
- Real gateway template `deployment-gateway.yaml` (needs `localhost:5000/ircfiber-gateway:prod` + redis/mongo). Same env as loggers.

**Deploy:**
```bash
kubectl apply -f site/deploy/k8s/ircfiber/namespace.yaml
kubectl apply -f site/deploy/k8s/ircfiber/networkpolicy.yaml
kubectl apply -f site/deploy/k8s/ircfiber/deployment-logger.yaml  # demo, proves cross-ns
# real gateway (after docker build/push):
# docker build -f Containerfile -t localhost:5000/ircfiber-gateway:prod --target runtime-gateway site && docker push localhost:5000/ircfiber-gateway:prod
# kubectl apply -f site/deploy/k8s/ircfiber/deployment-gateway.yaml
kubectl get pods -n ircfiber
```

**Verify (live):**
```bash
kubectl logs -n ircfiber -l app=ircfiber-logger --tail=20  # should show "sent ircfiber live log ..."
kubectl exec -n signoz chi-... -- clickhouse-client --query "SELECT resources_string['service.name'], count() FROM signoz_logs.distributed_logs_v2 GROUP BY 1"
# expect ircfiber-gateway N>0 (plus live-test)
kubectl exec -n signoz chi-... -- clickhouse-client --query "SELECT count() FROM signoz_traces.distributed_signoz_index_v2 WHERE serviceName='ircfiber-engine'"

# irc3 (if it emits): kubectl exec -n signoz ... -- clickhouse-client --query "SELECT resources_string['service.name'] FROM signoz_logs.distributed_logs_v2 WHERE resources_string['service.name']='irc3' LIMIT 5"
# or via Signoz UI: https://signoz.ubuntu-docker.tail544547.ts.net -> Logs Explorer filter service.name=ircfiber-gateway, Traces Explorer service.name=ircfiber-engine
```

**Grouping vs isolation:** Keeping `signoz` and `ircfiber` separate is best practice (observability vs app). Grouping in same namespace would co-mingle resources and risk `helm`/`kubectl delete ns` wiping both. Cross-namespace DNS (`svc.cluster.local`) is the Kubernetes-native grouping; `project` labels handle Rancher UI.

**Next:** Replace loggers with real `ircfiber-gateway` build, add `redis`/`mongo` Deployments in `ircfiber` (or external), and add `filelog` DaemonSet for container stdout if you want `kubectl logs` shipped without OTLP.
