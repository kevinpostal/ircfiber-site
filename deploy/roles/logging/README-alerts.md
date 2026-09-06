# SigNoz alert rules for IRC Fiber

Declarative alert rules in `roles/logging/files/alerts/*.json`, applied by
`playbooks/signoz-alerts.yml`.

## Why this exists

On **2026-09-06** a `make deploy-blue` compiled D **on** the prod VPS
(4 vCPU / 7.565 GiB). Memory fell to 117 MB available, load hit 45, dockerd
stopped answering, and ircfiber.com went down. **Nothing alerted.** The operator
found out by loading the site in a browser.

SigNoz was already deployed on `ubuntu-docker`, already scraping hostmetrics,
already receiving logs/traces/metrics from the OVH stack, and the gateway env
already carried `IRCFIBER_SIGNOZ_URL` / `IRCFIBER_SIGNOZ_API_KEY`. The gap was
never collection plumbing — no rule existed to turn "the host is dying" into a
notification. These files are that rule set.

The build now happens on `ubuntu-docker` (`BUILD_HOST` in `site/Makefile.site`),
so the *cause* is fixed. This is the detector for the next unrelated cause.

## The rules

Applied in filename order; the `alert` field is the idempotency key.

| # | File | Fires when | Default threshold | Window | Sev | On by default |
|---|---|---|---|---|---|---|
| 1 | `10-host-memory-available-low.json` | `system.linux.memory.available` below threshold for the whole window | **700 MiB** (`734003200` bytes) | 5m | critical | yes¹ |
| 2 | `11-host-load-sustained-high.json` | `system.cpu.load_average.5m` above threshold for the whole window | **6** (host has 4 vCPU) | 5m | critical | yes¹ |
| 3 | `12-host-filesystem-usage-high.json` | `system.filesystem.utilization` above threshold at least once, grouped by mountpoint, tmpfs excluded | **0.85** (= 85%) | 15m | warning | yes¹ |
| 4 | `20-container-restart-loop.json` | more than N gateway boot banners in container stdout | **2 boots** | 10m | critical | yes |
| 5 | `21-container-restarts-increasing.json` | `container.restarts` increases, grouped by container | **2 restarts** | 10m | critical | **no** — needs `docker_stats` |
| 6 | `22-ircfiber-container-silent.json` | total log volume from the prod host drops below 1 record | **< 1 record** | 10m | critical | yes |
| 7 | `30-gateway-signal-absent.json` | no log records from `service.name=ircfiber-gateway` | **< 1 record** | 15m | warning | yes |
| 8 | `31-public-endpoint-probe-failing.json` | fewer than one `httpcheck.status` 200 for `https://ircfiber.com/health` | **< 1 success** | 3m | critical | **no** — needs `httpcheck` |
| 9 | `40-engine-heartbeat-stale.json` | fewer than one `ircfiber.registration.timeout_networks` data point for `serverId=ovh` | **< 1 point** | 3m | critical | yes |

¹ The host-metric rules are enabled but **have no data source on the prod host
yet** — see [Prerequisites](#prerequisites). They carry `alertOnAbsent: true`,
so until that is fixed they fire as *no data*, which is deliberate: the
2026-09-06 failure mode was silence, and silence must be loud.

Every threshold and duration is a commented variable in
`playbooks/signoz-alerts.yml` (`signoz_alert_*`), overridable per rule through
`signoz_alert_tuning`, which is keyed by the rule's `alert` name.

### How each incident symptom maps to a rule

| Incident symptom | Rule |
|---|---|
| 117 MB available of 7.565 GiB | 1 |
| load 45 on 4 vCPU | 2 |
| 81% root filesystem, 27 GB BuildKit cache | 3 |
| dockerd stopped answering → every container silent | 6 |
| ircfiber.com down, only noticed in a browser | 8 (7 as backstop) |
| admin dashboard "Healthy Engines 0/1" | 9 |
| container crash-looping / unhealthy | 4 (today), 5 (exact counter) |

## Applying

```bash
cd site/deploy

# 1. Offline dry run — assembles every payload, writes them to
#    /tmp/ircfiber-signoz-alerts/, sends nothing, reads no credential.
ansible-playbook playbooks/signoz-alerts.yml -e signoz_alerts_render_only=true

# 2. Apply. The API key comes from
#    inventories/production/group_vars/all/vault.yml (vault_signoz_api_key),
#    which the playbook loads explicitly.
ansible-playbook playbooks/signoz-alerts.yml

# 3. With a notification channel, once one exists (see OPEN QUESTION).
ansible-playbook playbooks/signoz-alerts.yml \
  -e '{"signoz_alert_channels":["ircfiber-oncall"]}'
```

The playbook runs on `localhost` and talks only to the k3s SigNoz over
Tailscale. **It never touches the prod host**, so it is safe to run mid-incident.

Re-runs are idempotent: it `GET`s `/api/v1/rules`, builds a name → id map, then
`PUT`s `/api/v1/rules/<id>` for a name that already exists and `POST`s
`/api/v1/rules` for a new one. It also refuses to proceed if two files declare
the same `alert` name, since that name is the only key it has.

### Credential

`vault_signoz_api_key` — the same service-account key the gateway already uses
for its `/api/admin/logs/*` proxy (`IRCFIBER_SIGNOZ_API_KEY` in
`roles/gateway/templates/env.j2`). Mint it in SigNoz → Settings → API Keys and
store it with `ansible-vault edit
inventories/production/group_vars/all/vault.yml`. Never pass it with `-e`: it
lands in shell history and in the Ansible log.

Fallback: `vault_signoz_admin_password` → `POST /api/v2/sessions/email_password`
→ JWT, exactly as `roles/signoz_dashboards` does.

## OPEN QUESTION — the notification channel

**`signoz_alert_channels` defaults to `[]` and nothing pages anyone.**

With no channel, SigNoz still evaluates every rule and shows firing alerts in
the UI (`https://signoz.ubuntu-docker.tail544547.ts.net/alerts`) — but that is a
dashboard you have to look at, which is the same failure mode as the incident.

The operator must decide **one** of:

| Option | Cost | Notes |
|---|---|---|
| Slack / Discord webhook | free | SigNoz has a first-class Slack channel type; a Discord webhook works via the generic webhook type |
| Email (SMTP) | needs an SMTP relay | SigNoz needs SMTP env on the `signoz` deployment; the chart values do not set it today |
| Generic webhook | free | e.g. into the existing `ircfiber-support-bot` so alerts land in IRC |
| PagerDuty / Opsgenie | paid | overkill for a single-host deployment |

Given there is already an IRC bot on the box, a **generic webhook into the
support bot → a channel message** is the lowest-friction option that reaches a
human where they already are; Slack is the least work if a workspace exists.

Once chosen:

1. Create the channel in SigNoz → Settings → Alert Channels and note its
   **name** (the rules reference channels by name, not id).
2. Set it durably in `inventories/production/group_vars/all/vars.yml`:
   ```yaml
   signoz_alert_channels: ["ircfiber-oncall"]
   ```
3. Re-run the playbook. It rewrites `preferredChannels` on every rule.

The playbook prints a reminder after every apply while the list is empty.

## Prerequisites

The prod host ships **logs, traces and application metrics** today, but **no
host or container metrics**: `roles/logging/templates/otel-collector-config.yaml.j2`
declares `receivers: [otlp]` only and acts as a pure forwarder, and the
`hostmetrics` receiver in `k8s/signoz/values.yaml` scrapes **ubuntu-docker**
(`root_path: /hostfs` inside the k3s collector pod), not OVH.

So rules 1–3 and 5 have no data source until a receiver is added. Rules 4, 6, 7
and 9 work with what ships today.

None of the snippets below are applied by this playbook — they change files
owned by other roles.

### Host metrics (rules 1, 2, 3)

Add to the `receivers:` block of
`roles/logging/templates/otel-collector-config.yaml.j2`, and add `hostmetrics`
to the `metrics` pipeline's `receivers` list:

```yaml
  hostmetrics:
    collection_interval: 60s
    root_path: /hostfs          # requires a read-only / mount on the container
    scrapers:
      cpu: {}
      load: {}                  # system.cpu.load_average.{1m,5m,15m}  -> rule 2
      memory: {}                # system.linux.memory.available        -> rule 1
      filesystem: {}            # system.filesystem.utilization        -> rule 3
      disk: {}
      network: {}
```

Two things must line up or the rules will not match:

- the collector container needs `/:/hostfs:ro` (and `--pid=host` is not required
  for these scrapers);
- the resource attribute `host.name` must be **`ovh-prod`**, which is the value
  the rules filter on and the value `resource/ovh` already stamps onto OVH
  **logs**. The `metrics/ovh` pipeline in `k8s/signoz/values.yaml` deliberately
  has no `resource/ovh` processor, so set it at the source, e.g.
  `OTEL_RESOURCE_ATTRIBUTES=host.name=ovh-prod,deployment.environment=production`
  on the OVH collector, or add a `resourcedetection`/`resource` processor there.
  Alternatively override the filter without touching the files:
  `-e signoz_alert_host_name=<whatever host.name actually is>`.

### Container restarts and health (rule 5)

```yaml
  docker_stats:
    endpoint: unix:///var/run/docker.sock
    collection_interval: 30s
    metrics:
      container.restarts:
        enabled: true           # cumulative; rule 5 alerts on `increase`
      container.uptime:
        enabled: true           # resets alongside a restart
```

The collector then needs the docker socket mounted (fluent-bit already has the
container log directory, not the socket). Then:

```bash
ansible-playbook playbooks/signoz-alerts.yml -e signoz_alert_enable_docker_stats=true
```

An **unhealthy** container shows up here rather than as its own metric: under
`restart: unless-stopped` a failing healthcheck produces repeated
`container.restarts` increments, and `container.uptime` sawtooths. Rule 4 sees
the same thing today from the boot banner in stdout.

### External endpoint probe (rule 8)

Add to `otelCollector.config.receivers` in `k8s/signoz/values.yaml` — on
**ubuntu-docker**, deliberately *not* on the prod host, so the probe survives
the prod host wedging:

```yaml
      httpcheck:
        collection_interval: 30s
        targets:
          - endpoint: https://ircfiber.com/health
            method: GET
```

and `httpcheck` to the `metrics` pipeline receivers. Then:

```bash
ansible-playbook playbooks/signoz-alerts.yml -e signoz_alert_enable_endpoint_probe=true
```

Note the probe reaches ircfiber.com over the public internet via Cloudflare, so
it also covers Caddy, cloudflared and TLS — not just the gateway.

## UNVERIFIED: the request shape

The rule JSON follows the SigNoz threshold-rule schema, but **it has not been
sent to the running SigNoz** (chart `signoz/signoz` 0.138.0, app `v0.138.0`).
The alerts API has changed shape across releases and this repo has no captured
`POST /api/v1/rules` request to copy from. Dry-run first.

Shape choices made, all version-sensitive:

- `POST/PUT /api/v1/rules` with `ruleType: "threshold_rule"` and
  `alertType: "METRIC_BASED_ALERT" | "LOGS_BASED_ALERT"`.
- `condition.op` `"1"` = above, `"2"` = below; `condition.matchType` `"1"` = at
  least once, `"2"` = all the times, `"3"` = on average, `"4"` = in total.
- `condition.compositeQuery.builderQueries` as a **map** keyed `"A"`.
- Both `filter.expression` (newer string form, mirrored) **and**
  `filters.items` (classic structured form) are sent, since builds differ in
  which one they read. They express the same predicate, so whichever wins gives
  the same result.
- `having: {"expression": ""}` (object form, matching this repo's working
  dashboard JSON) rather than the older `having: []`.
- `panelType: "graph"` rather than `"time_series"`.
- `condition.alertOnAbsent` / `condition.absentFor` (minutes) for the
  no-data-is-the-alert rules.

### If the API rejects a payload

The failing rule name is printed by the final assertion. Grab the assembled
payload from the dry-run directory and send exactly one, to see the server's own
error message:

```bash
ansible-playbook playbooks/signoz-alerts.yml -e signoz_alerts_render_only=true
KEY=$(ansible-vault view inventories/production/group_vars/all/vault.yml \
      | awk '/^vault_signoz_api_key:/{print $2}' | tr -d '"')
curl -ksS -X POST https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/rules \
  -H "SIGNOZ-API-KEY: $KEY" -H 'Content-Type: application/json' \
  --data @/tmp/ircfiber-signoz-alerts/ircfiber-engine-heartbeat-stale.json
```

Then fix the shape across all nine files at once. `having` is pretty-printed
across lines, so this is a JSON rewrite rather than a `sed`:

```bash
cd roles/logging/files/alerts
python3 - <<'PY'
import glob, json
for f in glob.glob("*.json"):
    d = json.load(open(f))
    cq = d["condition"]["compositeQuery"]
    # older builds want a list for `having`
    cq["builderQueries"]["A"]["having"] = []
    # older builds name the panel type differently
    cq["panelType"] = "time_series"
    json.dump(d, open(f, "w"), indent=2, ensure_ascii=False)
    open(f, "a").write("\n")
PY
```

Some builds expect a **list** of builder queries rather than the keyed map used
here; that is a structural change, so compare against a rule exported from the
running instance:

```bash
curl -ksS https://signoz.ubuntu-docker.tail544547.ts.net/api/v1/rules \
  -H "SIGNOZ-API-KEY: $KEY" | jq '.data[0]'
```

The fastest ground truth is always to create one throwaway rule in the SigNoz UI
and `GET /api/v1/rules` to see the exact shape that build produces.

## Local checks (no network, no ansible)

```bash
cd site/deploy
for f in roles/logging/files/alerts/*.json; do python3 -m json.tool "$f" >/dev/null || echo "BAD $f"; done
python3 -c "import yaml; yaml.safe_load(open('playbooks/signoz-alerts.yml')); print('playbook parses')"
```

## Constraints worth knowing before editing

- **No Jinja braces in the rule JSON.** Ansible re-templates string values when
  a variable is dereferenced, so a SigNoz legend like `{{service.name}}` would
  explode as an undefined Ansible variable. Legends are plain text; grouping
  still labels the series. The playbook has a comment saying so at the slurp.
- **`hosts: localhost` is the implicit host** and does not inherit
  `inventories/production/group_vars`, which is why the playbook loads
  `group_vars/all/vars.yml` and `vault.yml` with `include_vars` — after the
  dry-run exit, so the offline render needs no vault password.
- **`serverId` in rule 9 is `ovh`**, matching `ircfiber_engine_id: "ovh"` in
  `host_vars/ircfiber-prod-1.yml`. A second engine means copying that file and
  changing the filter value; the rule is per-engine on purpose, since "one
  engine of two is dead" must still fire.
- **Rule 9 depends on `IRCFIBER_OTEL_ENABLED=1`** (set in
  `host_vars/ircfiber-prod-1.yml`). If application metrics are ever turned off,
  that rule goes permanently absent — which it will report, since it counts data
  points rather than reading a value.

## Related

- `roles/signoz_dashboards/` — dashboards, same endpoint and credential pattern.
- `roles/signoz_alerts/` — an **older, stale** alert role: it hardcodes the dead
  `100.126.197.92:3003` endpoint, `POST`s without an id (so re-runs cannot
  update), and its `alert_rules.yml` carries unrendered `{{ }}` placeholders.
  Prefer this playbook; retire that role once these rules are confirmed live.
- `roles/logging/tasks/deploy-alerts.yml` — gated by `deploy_signoz_alerts`
  (default false) and reads that same stale `alert_rules.yml`. Leave it off.
