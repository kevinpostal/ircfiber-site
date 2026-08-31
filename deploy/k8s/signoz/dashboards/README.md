# SigNoz Dashboards — k3s (ubuntu-docker)

Pre-built **New Relic-style** dashboards for IRC Fiber. Source JSON lives in
`site/deploy/roles/signoz_dashboards/files/` and is pushed to **k3s Signoz**
at `https://signoz.ubuntu-docker.tail544547.ts.net`, not the stale
`100.126.197.92:3003` (old local docker Signoz on colima).

## Files

```
site/deploy/roles/signoz_dashboards/files/
  01_overview.json        — landing: golden signals, host, recent errors/traces (17 widgets)
  02_infrastructure.json  — USE method: host + containers (11 widgets)
  03_services.json        — service inventory: throughput / error rate / latency (2 widgets)
```

All three carry tags `ircfiber` + `newrelic` and query `service.name` (logs/metrics).

```
ls site/deploy/roles/signoz_dashboards/files/*.json
cat site/deploy/roles/signoz_dashboards/files/03_services.json | jq .widgets[1].query
```

## Endpoint

| Env | URL | Notes |
|-----|-----|-------|
| **k3s Ingress (default)** | `https://signoz.ubuntu-docker.tail544547.ts.net` | Traefik `web,websecure` + TLS, Tailscale MagicDNS. Ansible default (`signoz_api_url`). |
| k8s-internal | `http://signoz.signoz.svc.cluster.local:8080` | ClusterIP, no TLS, fastest for `kubectl exec` pods. |
| OTel (VPS → k3s) | `http://100.94.116.56:4318` | Direct Tailscale IP, no TLS/DNS (see `host_vars/ircfiber-prod-1.yml`). |
| **STALE — do not use** | `http://100.126.197.92:3003` | Old local docker Signoz on colima. |
| **STALE — do not use** | `http://signoz:8080` | Old docker-compose service name. |

Role defaults: `site/deploy/roles/signoz_dashboards/defaults/main.yml`
(`signoz_api_url: https://signoz.ubuntu-docker.tail544547.ts.net`,
`signoz_api_validate_certs: false` for Traefik default cert).

## Import via Ansible (preferred)

```bash
cd site/deploy

# API-key path (create key: SigNoz UI → Settings → API Keys → Create)
ansible-playbook playbooks/signoz_dashboards.yml -e vault_signoz_api_key=YOUR_KEY

# Password path (vault_signoz_admin_password in inventories/production/group_vars/all/vault.yml)
ansible-playbook playbooks/signoz_dashboards.yml

# Ad-hoc password override
ansible-playbook playbooks/signoz_dashboards.yml -e 'vault_signoz_admin_password=YOUR_PASSWORD'

# Custom endpoint (e.g. in-cluster debug)
ansible-playbook playbooks/signoz_dashboards.yml -e signoz_api_url=http://signoz.signoz.svc.cluster.local:8080
```

Playbook: `site/deploy/playbooks/signoz_dashboards.yml` (`hosts: localhost`, `connection: local`).
Role: `site/deploy/roles/signoz_dashboards/` — idempotent by-title `POST` or `PUT`.

Do **not** run against `100.126.197.92` — that targets the local colima Signoz, not k3s.

## Manual import (curl — when vault key missing)

```bash
cd site/deploy

# 1. Get JWT via password login
JWT=$(curl -sk https://signoz.ubuntu-docker.tail544547.ts.net/api/v2/sessions/email_password \
  -H 'Content-Type: application/json' \
  -d '{"email":"kevindpostal@gmail.com","password":"YOUR_PASSWORD","orgId":"019f1235-79b1-787f-b4a9-370824295f2f"}' \
  | jq -r .data.accessToken)
echo ${#JWT}  # should be >100

# 2. Push one dashboard
curl -k https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards \
  -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  --data @roles/signoz_dashboards/files/01_overview.json | jq .

# 3. Or push all three
for f in roles/signoz_dashboards/files/*.json; do
  echo "→ $f"
  curl -sk https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards \
    -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
    --data @"$f" | jq -r '.status // .data.title // .'
done

# 4. Idempotent update (PUT if title exists)
# List existing to build title→id map:
curl -sk https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards \
  -H "Authorization: Bearer $JWT" | jq '.data[] | {title, id}'
# Then PUT to /api/v1/dashboards/<id>:
# curl -k -X PUT https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards/<ID> \
#   -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
#   --data @roles/signoz_dashboards/files/01_overview.json
```

API-key variant (no JWT fetch):

```bash
API_KEY=your-service-account-key
curl -k https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  --data @roles/signoz_dashboards/files/01_overview.json | jq .
```

In-cluster curl (from a pod in `signoz` ns, no TLS):

```bash
kubectl exec -n signoz deploy/signoz -- wget -qO- http://localhost:8080/api/v1/health
# Dashboards API via ClusterIP:
kubectl run curl --rm -i --restart=Never --image=curlimages/curl -- \
  curl -s http://signoz.signoz.svc.cluster.local:8080/api/v1/dashboards \
  -H "Authorization: Bearer $JWT" | jq .
```

## Verify

```bash
# API health
curl -k https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/health  # {"status":"ok"}

# List dashboards (after push)
curl -sk https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/dashboards \
  -H "Authorization: Bearer $JWT" | jq '.data[] | .title'
# Expected:
# "IRC Fiber — Overview"
# "IRC Fiber — Infrastructure"
# "IRC Fiber — Services Inventory"

# UI
open https://signoz.ubuntu-docker.tail544547.ts.net/dashboard
# Login: kevindpostal@gmail.com / vault_signoz_admin_password
# Dashboards → filter tag:ircfiber
```

## Troubleshooting

- `curl: (7) Failed to connect` → Tailscale not connected (`tailscale status`), or Ingress not ready (`kubectl get ingress -n signoz signoz`).
- `401 Unauthorized` → expired JWT (re-fetch) or wrong `orgId` (`019f1235-79b1-787f-b4a9-370824295f2f`).
- `validate_certs: false` required — Traefik uses default cert, not LE (no `ClusterIssuer` on ubuntu-docker).
- If k3s Signoz was reinstalled, `signoz-0` pod restarts → wait `kubectl get pods -n signoz` shows `1/1` before pushing.
