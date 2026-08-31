# SigNoz on k3s (ubuntu@ubuntu-docker) — deploy runbook

Single-node k3s v1.36.3 (k3s + Traefik `traefik.io/ingress-controller` + `local-path` default StorageClass).
Namespace: `signoz` (Rancher-compatible, `phase: Active`).

## Chart pin

- Helm repo: `signoz` https://charts.signoz.io
- Chart: `signoz/signoz` **0.138.0** (app `v0.138.0`) — installed 2026-08-25 rev 4 `deployed`.
  - Original pin intended `0.131.0` (app `v0.131.1`) for `clickhouse 25.8` / `otel-collector 0.144.5`
  - Chart forces `clickhouse/clickhouse-server:25.12.5` and `signoz-otel-collector:v0.144.8` — accepted per plan fallback
  - `otelCollector` image `signoz/signoz-otel-collector:v0.144.8`
- Recorded in `values.yaml` header and here; `Chart.lock` not required (helm repo pin via `--version`).

## Values

- `values.yaml` is single source of truth for sizing on single-node k3s:
  - `global.storageClass: local-path` (only provisioner, `WaitForFirstConsumer`)
  - `clickhouse.persistence.storageClass: local-path`, `size: 20Gi` (~30d logs, host 934G free), `resources: 500m/2Gi → 2000m/4Gi`
  - `clickhouse.zookeeper.enabled: true` (fallback — chart requires ZK for `ReplicatedMergeTree` even with `shardsCount:1`; initial `false` failed with `Cannot use any of provided ZooKeeper nodes` code 999)
    - ZK PVC: `local-path` `5Gi` single replica (`statefulset/signoz-zookeeper` 1/1)
  - `signoz` (query-service + frontend merged on `:8080`): `500m/1Gi → 1000m/1Gi`
  - `signoz.ingress.enabled: true`, `className: traefik`, `annotations: web,websecure + router.tls true`, `host: signoz.ubuntu-docker.tail544547.ts.net` port `8080`, `tls: []` (Traefik default cert; no `ClusterIssuer`)
  - `otelCollector.enabled: true`, `replicaCount: 1`, `resources: 100m/200Mi → 500m/500Mi` (default config, OTLP `4317`/`4318` only; `filelog` DaemonSet deferred — see below)
  - `JWT` via `signoz.env.SIGNOZ_JWT_SECRET: ircfiber-signoz-dev-jwt-secret-change-in-prod-9e3a7f2b` (reuse `site/deploy/roles/logging/defaults/main.yml`)
  - Deviation notes in `values.yaml` header for keys absent in chart `0.138.0` (`global.env` etc.)

## Install

```bash
# On ubuntu@ubuntu-docker
ssh ubuntu@ubuntu-docker
helm repo add signoz https://charts.signoz.io  # already added
helm repo update
# Namespace already created via kubectl
kubectl create namespace signoz --dry-run=client -o yaml | kubectl apply -f -

# Install (pin chart version)
helm upgrade --install signoz signoz/signoz -n signoz \
  -f /path/to/site/deploy/k8s/signoz/values.yaml \
  --version 0.138.0 \
  --set clickhouse.persistence.storageClass=local-path \
  --wait --timeout 15m

# Fallback if helm hook pre-upgrade (migrator) fails due to ZK:
# 1. Ensure ZK enabled (see values.yaml zookeeper.enabled: true)
# 2. Manual ZK apply if helm didn't create sts (rare):
#    helm template signoz signoz/signoz --version 0.138.0 -n signoz -f values.yaml > /tmp/tmpl.yaml && kubectl apply -f /tmp/tmpl.yaml
# 3. Delete failed migrator job then retry upgrade:
#    kubectl delete job -n signoz signoz-telemetrystore-migrator
#    helm upgrade --install signoz signoz/signoz -n signoz -f values.yaml --version 0.138.0

# Verify
kubectl get pods -n signoz   # expect chi-clickhouse 1/1, signoz 1/1, otel-collector 1/1, zookeeper 1/1, migrator Completed
kubectl get pvc -n signoz    # data-volumeclaim-template 20Gi local-path Bound, data-signoz-zookeeper-0 5Gi Bound, signoz-db 1Gi Bound
helm status -n signoz signoz
helm list -n signoz

# Ingress fallback (only if chart ingress disabled/misconfigured)
kubectl apply -f site/deploy/k8s/signoz/ingress.yaml
kubectl get ingress -n signoz signoz -o yaml
# Health via Host header (Tailscale MagicDNS):
curl -k -H "Host: signoz.ubuntu-docker.tail544547.ts.net" https://ubuntu-docker.tail544547.ts.net/api/v1/health  # {"status":"ok"}
kubectl exec -n signoz signoz-0 -- wget -qO- http://localhost:8080/api/v1/health  # {"status":"ok"}
```

## Logs (k8s pod logs)

Current chart `0.138.0` `otelCollector` is Deployment with default OTLP `4317`/`4318` only — no `filelog` DaemonSet.
Filelog tail for `/var/log/pods/*/*/*.log` (containerd CRI) is **deferred** to a future k8s-infra DaemonSet.
Verification for filelog is therefore:

- `kubectl logs -n signoz -l app.kubernetes.io/component=otel-collector -c collector | head` shows `filelog` receiver **absent** (expected; note deviation)
- Synthetic test `kubectl run logtest ...` (busybox echo `signoz-k8s-test`) will **not** appear in SigNoz Logs explorer until filelog DaemonSet is added — document as follow-up.

Planned filelog mounts (when DaemonSet added):

- `hostPath: /var/log/pods` → `mountPath: /var/log/pods:ro`
- `hostPath: /var/log/containers` → `/var/log/containers:ro`
- `hostPath: /var/lib/rancher/k3s/agent/containerd` if needed (`ls /var/log/pods | head` during install)
- Exclude `signoz*`/`clickhouse*`/`otel-collector*` to avoid loop (mirrors docker `exclude_path`).

## App wiring (OTel)

- **k3s-hosted apps** (`irc3` in `irc3` ns; future `ircfiber-gateway`):
  ```bash
  kubectl set env deploy/irc3 -n irc3 OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector.signoz.svc.cluster.local:4318
  # or for D tracing.d: IRCFIBER_OTEL_ENABLED=1 IRCFIBER_OTEL_ENDPOINT=http://signoz-otel-collector.signoz:4318
  # D code appends /v1/traces and /v1/metrics in site/backend/source/app.d:otelTracesEp — do NOT set suffix manually
  ```
  Keep `IRCFIBER_OTEL_ENABLED=0` by default; enable per-deployment after collector health verified (`kubectl logs -n signoz -l app.kubernetes.io/component=otel-collector | grep -i traces` no error).

- **Docker-hosted gateway/engine** (vps-efb4b52d or colima):
  - Inside k3s network: `IRCFIBER_OTEL_ENDPOINT=http://signoz-otel-collector.signoz.svc.cluster.local:4318`
  - Outside k3s: `http://host.docker.internal:4318` with `hostPort` or Traefik TCP router (`ubuntu-docker.tail544547.ts.net:443`); default Service `ClusterIP` only — external docker requires `hostPort: 4318` or Ingress.

## Rollback

```bash
helm rollback -n signoz signoz 1    # rollback to previous revision
kubectl delete ns signoz --wait    # removes all (PVCs remain Delete reclaimPolicy)
kubectl delete pvc --all -n signoz # explicit if needed (data-* 20Gi, signoz-db)
```

## Verification (per plan)

- Namespace: `kubectl get ns signoz -o yaml` → `phase: Active`
- Pods: `kubectl get pods -n signoz` → `clickhouse-0 1/1`, `signoz 1/1`, `otel-collector 1/1`, `zookeeper 1/1`, `migrator Completed`
- PVC: `kubectl get pvc -n signoz` → `data-volumeclaim-template-chi... 20Gi local-path Bound`
- Helm: `helm list -n signoz && helm status -n signoz signoz` → `STATUS: deployed`, chart `0.138.0`
- Ingress/UI: `curl -k -H "Host: signoz.ubuntu-docker.tail544547.ts.net" https://ubuntu-docker.tail544547.ts.net/api/v1/health` → `{"status":"ok"}`; browser `https://signoz.ubuntu-docker.tail544547.ts.net` → login
- Resource headroom: `kubectl top nodes` memory <85% (host 125Gi, SigNoz ~6Gi + existing ~8Gi <15Gi), `df -h` disk <70% (44% used, 930G avail)
