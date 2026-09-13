# IRC Fiber — Ansible Deployment

Enterprise-grade Ansible playbooks for deploying [IRC Fiber](https://github.com/kevinpostal/IRC_FIBER) on a single Linux host (or multi-host, for adding additional engine servers) using Docker, with Tailscale as the private mesh between hosts and Caddy for public TLS.

> **Note for ansible-core 2.20 users:** the inventory directory is no longer auto-added to `ansible_search_path` (it used to be). All playbooks here use explicit `vars_files: ["{{ playbook_dir }}/../inventories/production/group_vars/vault.yml"]` to load the encrypted vault. If you're on an older ansible-core, this still works fine.

## Architecture

```
              public internet
                     │
                     │ :80 / :443
                     ▼
              ┌──────────────┐
              │    Caddy     │  (container, host network for cert renewal)
              │  reverse     │  auto-TLS via Let's Encrypt
              │   proxy      │
              └──────┬───────┘
                     │ docker network ircfiber_net
                     ▼
              ┌──────────────┐
              │  irc-fiber   │  (gateway: HTTP + WebSocket)
              │  /app/       │
              │  irc-fiber   │
              └──────┬───────┘
                     │ Tailscale (tailscale0)
              ┌──────┴───────────────────┐
              ▼                          ▼
       ┌────────────┐             ┌────────────┐
       │   redis    │             │   mongo    │  (network_mode: host,
       │ 7-alpine   │             │  mongo:7   │   bound to tailscale IP)
       └────────────┘             └────────────┘
                                          ▲
                                          │ Tailscale
                                   ┌──────┴──────────┐
                                   │  irc-fiber-engine│ (one or more hosts)
                                   │  /app/           │
                                   │  irc-fiber-engine│
                                   └──────────────────┘
```

The gateway and engine(s) reach Mongo/Redis exclusively over the Tailscale interface.
Caddy terminates public TLS in front of the gateway.

## Layout

```
deploy/
├── ansible.cfg
├── requirements.yml
├── inventories/production/
│   ├── hosts.ini
│   ├── group_vars/
│   │   ├── all.yml             # public defaults
│   │   ├── vault.yml           # ansible-vault encrypted secrets
│   │   └── vault.example.yml   # redacted template (safe to commit)
│   └── host_vars/              # per-host overrides (engine_id, bind_address)
├── playbooks/
│   ├── site.yml                # full stack
│   ├── docker.yml              # install Docker CE
│   ├── tailscale.yml           # install + auth Tailscale
│   ├── mongo.yml               # deploy Mongo only
│   ├── redis.yml               # deploy Redis only
│   ├── caddy.yml               # deploy Caddy only
│   ├── gateway.yml             # deploy gateway only
│   ├── engine.yml              # deploy engine(s) only — for new engine hosts
│   ├── cloudflare.yml          # manage CF DNS records pointing at backend host(s)
│   ├── sync-db-to-tailnet.yml  # one-shot sync of local Mongo + Redis → tailnet
│   ├── firewall.yml
│   ├── update.yml              # bump image, rolling restart
│   ├── backup.yml              # mongodump + redis snapshot
│   ├── restore.yml
│   ├── restart.yml             # restart any subset
│   ├── status.yml
│   ├── logs.yml
│   ├── healthcheck.yml
│   └── prune.yml
└── roles/                      # one role per component
```

## Prerequisites

- A Debian/Ubuntu LTS host (or VM on GCP / any other cloud).
- A DNS A/AAAA record for `ircfiber_domain` pointing at the host's public IP.
- A Tailscale account; create a reusable auth key tagged `tag:ircfiber` at <https://login.tailscale.com/admin/settings/keys>.
- A Docker registry (Docker Hub free tier, GitHub Container Registry, or private). Set `docker_registry_url` in `group_vars/all.yml`.
- An Ansible control machine (laptop, CI runner) with `ansible-core` ≥ 2.14. **The control node must be able to reach target hosts by their Tailscale name or 100.x.x.x IP** — either join the same tailnet, or run `tailscaled` locally with `--accept-routes`.

> **Important:** rename the Tailscale device to something stable (e.g. `ircfiber-prod-1`) before adding it to your inventory. The random `izt4n520nxas8w06c5zfc9z.tail544547.ts.net` names change whenever the host re-registers, and they leak your tailnet ID. Run `ssh root@HOST tailscale set --hostname=ircfiber-prod-1` once.

## First-time setup

```bash
# 1. Install collections
cd deploy
ansible-galaxy collection install -r requirements.yml

# 2. Edit non-sensitive defaults
$EDITOR inventories/production/group_vars/all.yml

# 3. Create the encrypted vault
cp inventories/production/group_vars/vault.example.yml \
   inventories/production/group_vars/vault.yml
$EDITOR inventories/production/group_vars/vault.yml   # fill in real values
ansible-vault encrypt inventories/production/group_vars/vault.yml

# 4. Rename the Tailscale device to a stable, human-readable name
#    (random MagicDNS names like 'izt4n520nxas8w06c5zfc9z.tail544547.ts.net'
#     change if the host ever re-registers, which would silently break
#     your inventory. Tailnet IDs also leak the org's Tailscale account.)
ssh root@<host> tailscale set --hostname=ircfiber-prod-1

# 5. Edit the inventory to use the new hostname
$EDITOR inventories/production/hosts.ini

# 6. Verify you can reach the host by its Tailscale name
#    (your control node must be on the same tailnet, or use the
#    100.x.x.x IP directly)
ssh deploy@ircfiber-prod-1    # should fail — user doesn't exist yet

# 7. Bootstrap: create the non-root 'deploy' user
#    IMPORTANT: use `-e ansible_user=root`, not `--user root`.
#    In ansible-core 2.20+, inventory's `ansible_user=deploy` overrides
#    the CLI `--user` flag, so the playbook would still try to connect
#    as `deploy` (who doesn't exist yet). `-e ansible_user=root` is the
#    only CLI override that has higher precedence than inventory.
ansible-playbook playbooks/bootstrap.yml -e ansible_user=root

# 8. Test connectivity as the deploy user
ansible ircfiber -m ping

# 9. Deploy everything
ansible-playbook playbooks/site.yml
```

### Adding a new engine host

Repeat the bootstrap for the new host, then add it to the inventory:

```bash
# On the new host
ssh root@newengine tailscale set --hostname=ircfiber-prod-2
ssh root@newengine    # or use the Tailscale IP

# From the control node
ansible-playbook playbooks/bootstrap.yml -e ansible_user=root -l ircfiber-prod-2

# Update the inventory
$EDITOR inventories/production/hosts.ini    # append to [ircfiber_engines]

# Deploy only the engine on the new host
ansible-playbook playbooks/engine.yml -l ircfiber-prod-2
```

The gateway sees the new engine register via heartbeat in <10s and starts
assigning networks to it. No gateway changes required.

## Day-to-day operations

```bash
# ── Code deploys ──────────────────────────────────────────────────────
# Fast incremental binary deploy (daily use):
make update                     # rsync + BuildKit → restart engine + gateway

# Engine deploys are hot swaps: the connection holder keeps every IRC socket,
# the old engine detaches on SIGTERM and the new one reattaches (no QUIT).
# See "Engine deploy (hot swap)" below and AGENTS.md Engine Lifecycle.

# Full image rebuild (Containerfile from scratch):
make update-full                # alias: make deploy

# Frontend / gateway-only deploys (engine untouched — no IRC disconnect):
make update-assets              # EPHEMERAL — pushes public/dist via docker exec
                                #  ~2-3s, no restart, survives `docker restart`
                                #  but LOST on `docker rm` / `docker compose up --force-recreate`
                                #  or host reboot. Use for quick iteration only.
make update-gateway             # PERSISTENT — rebuilds gateway image on host
                                #  then recreates ircfiber-gateway via Ansible.
                                #  Engine (ircfiber-engine-ovh) NOT restarted.
                                #  ~2-3 min first time, cached after. Survives
                                #  container recreate and host reboot. Use for
                                #  any frontend/assets change you want to keep.

# ── Component management ──────────────────────────────────────────────
# Deploy/redeploy a single component
ansible-playbook playbooks/mongo.yml
ansible-playbook playbooks/redis.yml
ansible-playbook playbooks/gateway.yml
ansible-playbook playbooks/caddy.yml
ansible-playbook playbooks/engine.yml
```

> **Gateway SPA gotcha (2026-08-09):** `public/` and `backend/views/index.dt`
> are **baked into the gateway image** at build time (`Containerfile`
> `COPY public/ ./public/`). `make update-assets` writes to the **running**
> container's writable layer via `docker exec tar` — it survives
> `docker restart` but is **discarded** on `docker rm -f ircfiber-gateway`
> or `docker compose up --force-recreate` / host reboot, reverting the SPA
> to the old image. `2026-08-09` incident: a frontend deploy via
> `update-assets` + manual `docker rm` + `compose up` wiped the new
> `main-S6NCrGWT.js` (BLCKND/SUPERNETS), leaving the SPA 404.
> **Fix:** `make update-assets` now also `rsync`s to
> `/opt/ircfiber-src/public/` on the host so the next image build has the
> assets, and `make update-gateway` was added for a persistent gateway-only
> deploy (frontend → rsync → `docker build --target runtime-gateway` →
> `ansible-playbook playbooks/gateway.yml` — engine untouched).


### Engine deploy (hot swap)

Every IRC TCP/SOCKS5/TLS socket is owned by a small, stable **connection
holder** container (`ircfiber-holder-<id>`, `roles/holder`) that relays
plaintext IRC to the engine over `unix:///run/ircfiber/holder.sock` on the
shared `ircfiber-holder-run-<id>` volume (rw on the holder, ro on the
engine). Recreating the engine container is therefore a **hot swap**: the
old engine detaches on SIGTERM (no QUIT), the holder buffers inbound lines
and auto-answers `PING` while no engine is attached, and the new engine
reattaches on boot — the IRC server sees one continuous session (same
signon time). Engine crashes (SIGKILL/OOM) survive the same way.

```bash
make -C ../.. ship-holder     # ONCE per host, and rarely: recreates the holder = full IRC reconnect
make -C ../.. ship-engine     # every engine deploy: hot swap, IRC sockets kept
make -C ../.. engine-status   # engine PID + holder --status (attached/open/detached)
make -C ../.. engine-decommission   # SIGINT: QUIT all, unregister, irc:shutdown, remove both containers
```

What `engine-deploy.yml` checks:
1. `pre_tasks`: the holder container is `healthy` (run `holder-deploy.yml`
   first) and records `irc-fiber-holder --list` as the pre-swap session set.
2. The engine role recreates only the engine (`stop_timeout: 30`; the detach
   budget is 10 s).
3. `post_tasks`: waits ≤ 90 s until `--status` shows `detached == 0` and
   `attached == open`, then asserts every pre-swap `open` session is still
   open with the same `id` and `connectedAtMs`.

Signals: engine **SIGTERM = detach** (hot swap), engine **SIGINT =
decommission** (QUIT every network, unregister, publish `irc:shutdown` so
the other engines/gateway reassign). Holder SIGTERM = QUIT every network
(`IRCFIBER_HOLDER_QUIT_MSG`).

Multi-engine: a swapping engine stays healthy in the shared registry for a
180 s grace (`hotswapAt`), so the gateway and the other engines never
reassign its networks mid-swap. Rollout order for the grace itself:
`make ship` (gateway) → `make ship-holder` → `make ship-engine`; afterwards
swap one engine at a time.

```bash
# Deploy/redeploy a single component

# Add a new engine host on a new VM
# 1. apt-install baseline; add to [ircfiber_engines] in hosts.ini
# 2. Bootstrap:
ansible-playbook playbooks/docker.yml   -l newengine.example.com
ansible-playbook playbooks/tailscale.yml -l newengine.example.com
ansible-playbook playbooks/engine.yml   -l newengine.example.com
# The gateway sees the new engine register in <10s (one heartbeat).

# Deploy a new build (from the ircfiber-infra root)
make -C ../.. ship            # gateway (blue/green);  make -C ../.. ship-engine  # engine

# Status & logs
ansible-playbook playbooks/status.yml
ansible-playbook playbooks/logs.yml -e component=gateway tail=200
ansible-playbook playbooks/healthcheck.yml

# Restart a component
ansible-playbook playbooks/restart.yml -e components=gateway,engine

# Backup / restore
ansible-playbook playbooks/backup.yml
ansible-playbook playbooks/restore.yml -e snapshot=mongo-20251201-120000.archive

# Prune old images (keeps 3 newest tags)
ansible-playbook playbooks/prune.yml
```

## Pre-flight validation

The SigNoz role runs a local ClickHouse config validator before
touching the host. This catches the class of bug that puts the
clickhouse container into a restart loop on the live server (e.g.
pool-size / mutation-defaults underflow) and would otherwise take
30+ minutes to surface as a 728 MB `err.log` filling the writable
layer.

```bash
# Run the validator directly (any time)
./deploy/test/signoz-config/test-clickhouse-config.sh

# Run the full regression suite against known-bad fixtures
./deploy/test/signoz-config/test-clickhouse-config-regressions.sh
```

See [`deploy/test/signoz-config/README.md`](test/signoz-config/README.md)
for the full rationale and what's tested.

## Secrets

All sensitive values live in `inventories/production/group_vars/vault.yml`, encrypted with `ansible-vault`. The `.example.yml` file is a redacted template committed for onboarding. The Ansible control node decrypts the vault at runtime with the password you set.

```bash
# Edit vault
ansible-vault edit inventories/production/group_vars/vault.yml

# Or use a password file
echo "my-vault-pass" > ~/.vault_pass.txt
chmod 600 ~/.vault_pass.txt
ansible-playbook playbooks/site.yml --vault-password-file ~/.vault_pass.txt
```

### Cloudflare DNS

If your public-facing domain is registered on Cloudflare, the `cloudflare` role can manage the A records for you so the domain resolves to the backend host's public IP (the same role that wires Let's Encrypt challenges to that host via Caddy).

```bash
# 1. Create a scoped API token at https://dash.cloudflare.com/profile/api-tokens
#    Permission: Zone:DNS:Edit (scoped to the zone that owns the domain).
#    Copy the account ID from the dashboard sidebar on any zone page.

# 2. Store the token + account ID in the encrypted vault
ansible-vault edit inventories/production/group_vars/vault.yml
#   vault_cloudflare_api_token:    "cfat_..."
#   vault_cloudflare_account_id:   "1389bd41e95b9a1d98085904980be87f"

# 3. Tell the role which zone to manage and which public IP to point at
$EDITOR inventories/production/group_vars/all.yml
#   cloudflare_zone: "your-domain.com"
$EDITOR inventories/production/host_vars/<hostname>.yml
#   cloudflare_target_ip: "15.204.93.54"

# 4. Make sure the zone's nameservers are delegated to Cloudflare
#    (otherwise records created here won't resolve publicly).

# 5. Run (idempotent — safe to re-run)
ansible-playbook playbooks/cloudflare.yml

# Or let site.yml do it automatically as part of the full deploy.
```

The role manages apex (`@`) and `www` records by default; override `cloudflare_record_prefixes` in `group_vars/all.yml` (or set `cloudflare_records` directly per host) to manage a different set. Records other than `A` carry their content in `value`, and `solo: true` makes a record the only one of its name+type — required for SPF and DMARC, because the module keys TXT records on their value and would otherwise leave the old policy in place beside the new one (two SPF records at one name is a permerror, not a merge). `cloudflare_proxied: true` flips CF into "orange cloud" mode (CF proxies traffic and terminates TLS at the edge); `false` keeps CF as authoritative DNS only. TXT/MX records are always forced DNS-only, and `cloudflare_target_ip` is only required when the managed set actually contains an `A` record — `vps-efb4b52d` manages only mail records, since its apex and `www` are proxied and must not be pointed at the origin IP.

### Outbound mail (signup verification)

`IRCFIBER_EMAIL_VERIFICATION=1` makes a new account unusable until the user clicks the link in a verification e-mail, so a broken mail path blocks *all* signups. `backend/source/ircfiber/mail.d` speaks three providers, selected by `IRCFIBER_MAIL_PROVIDER`:

| provider | endpoint | credential | accepted when |
|---|---|---|---|
| `resend` (default) | `POST https://api.resend.com/emails` | `IRCFIBER_RESEND_API_KEY_FILE` ← `vault_resend_api_key` | 2xx with an `id` |
| `sender` | `POST https://api.sender.net/v2/message/send` | `IRCFIBER_SENDER_API_TOKEN_FILE` ← `vault_sender_api_token` | 2xx with `success: true` |
| `log` | — | — | always (local dev: logs the link) |

Only the selected provider's credential is read, so both can stay in the vault across a switch. Anything else — including unset — is unconfigured and every send throws, which surfaces as a 503 from `/api/register` while verification is on.

**Both HTTP providers refuse to send until the sending domain's DNS is complete**, and the message names the missing record. Resend answers `HTTP 403 The <domain> domain is not verified` until its DKIM/SPF records (shown in its dashboard when the domain is added; a full-access API key can read them from `GET /domains`) exist — add them to `cloudflare_records` in `host_vars/<host>.yml` and run `ansible-playbook playbooks/cloudflare.yml`. A send-only key cannot manage domains: `GET /domains` answers `401 restricted_api_key`.

sender.net additionally requires DMARC, and answers `HTTP 400 The domain … does not have a DMARC policy` without it. It publishes what it wants:

```bash
ssh <host> 'sudo docker exec ircfiber-gateway sh -lc '"'"'T=$(cat /etc/ircfiber/gateway/secrets/sender_api_token); \
  curl -s https://api.sender.net/v2/domains -H "Authorization: Bearer $T"'"'"''
# spf_verified / dkim_verified / dmarc are its per-check state,
# merged_spf_record is the SPF string it wants, expected_dkim_value the DKIM target.
```

The live set lives in `host_vars/vps-efb4b52d.yml` as `cloudflare_records` (five records, all `solo: true`): apex SPF, `resend._domainkey` TXT (Resend's DKIM public key), `send` TXT + `send` MX (the SES bounce/return-path subdomain Resend puts in `Return-Path:`), and a `_dmarc` TXT policy (`p=none`, relaxed alignment). The apex SPF carries **both** includes — `v=spf1 include:_spf.mx.cloudflare.net include:amazonses.com ~all` — because Cloudflare Email Routing's include only covers inbound forwarding: a message that ever leaves with a bare `@ircfiber.com` envelope sender (region change, direct SES/SMTP send, origin-generated bounce) would otherwise softfail SPF and lean entirely on DKIM to satisfy DMARC. Both includes are flat `ip4:` lists, so the record costs 2 of the 10 permitted DNS lookups. The sender.net-era `include:sendersrv.com` / `sender._domainkey` records are gone with that provider.

Verify with **one** real send before declaring it fixed:

```bash
# One real send. Read the key on the host (the container user cannot read the
# 0400 secret file), and send to a real inbox: Resend answers HTTP 422 for
# RFC-reserved recipients such as you@example.org (2026-09-07: a signup with
# an @example.com address failed exactly this way while the provider was
# healthy).
ssh <host> 'K=$(sudo cat /etc/ircfiber/gateway/secrets/resend_api_key); \
  curl -s -w "\nHTTP %{http_code}\n" -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
    -d "{\"from\":\"IRC Fiber <no-reply@ircfiber.com>\",\"to\":[\"admin@ircfiber.com\"],\"subject\":\"probe\",\"text\":\"probe\"}"'
```

Do **not** loop that probe while waiting for DNS. A retry every two minutes got the sender.net account suspended for "suspicious activity" (HTTP 403, then 401 on every send) even though each request was a legitimate API call; a provider's resolver can cache the old negative answer for the zone's negative TTL (1800 s on `ircfiber.com`), so wait that out and re-check the provider's own domain state instead of re-sending.

### Bouncer (`bnc.<domain>:7000`, Settings → Bouncer)

The gateway image also contains the soju-style bouncer listener; it only listens in a process that has `IRCFIBER_BNC_PORT` set, which the `gateway` role gives to the dedicated `ircfiber-bnc` container (`bnc_enabled`, `bnc_public_host`, `bnc_public_port` in `group_vars/all/vars.yml`). TLS terminates in that container using the Let's Encrypt cert Caddy obtains for `bnc_public_host`, read from the Caddy data volume on every connection, so renewals need no restart. One credential per account: the IRC Fiber username plus a bouncer password generated in **Settings → Bouncer** (stored as `users.bncToken`). Clients that speak `soju.im/bouncer-networks` (Goguma, senpai, gamja, Halloy) log in with SASL PLAIN or `PASS <password>` and see every network via `BOUNCER LISTNETWORKS` / `BIND`; legacy clients pick one network per connection with the ZNC-style identity `<username>/<network-slug>[@<clientid>]` as the `USER` name or as `PASS <identity>:<password>`. Per-network bouncer passwords no longer exist — `NetworkRepository` strips any stale `networks.bncToken` at startup, so after the first deploy of this version every bouncer user must generate a new password (announce in `#ircfiber`).

Enable it on a host by adding `bnc_public_host` to `caddy_extra_serve_hosts` and a **DNS-only** `bnc` A record to `cloudflare_records` (raw TCP cannot be orange-clouded — see `host_vars/ircfiber-prod-1.yml`), then run in this order:

```bash
ansible-playbook playbooks/cloudflare.yml   # bnc.<domain> A record
ansible-playbook playbooks/caddy.yml        # obtains the LE cert; wait for
#   docker exec ircfiber-caddy ls /data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/bnc.<domain>/
ansible-playbook playbooks/firewall.yml     # opens firewall_extra_tcp_ports (7000)
ansible-playbook playbooks/gateway.yml      # (re)creates ircfiber-bnc; not part of blue/green
openssl s_client -connect bnc.<domain>:7000 -servername bnc.<domain> </dev/null | head
```

If Caddy stores the cert elsewhere, point `bnc_tls_cert_path` / `bnc_tls_key_path` at the discovered files in host_vars.

### Support bot (`FIBERSUPPORT` in `#support` + `#ircfiber`, Help & Feedback)

The gateway image also contains the `#support` services bot; it only runs in a process that has `IRCFIBER_SUPPORT_BOT_ENABLED=1`, which the `gateway` role gives to the dedicated `ircfiber-support-bot` container (`support_bot_enabled`, `support_bot_nick`, `support_bot_channel`, `support_bot_public_url` in `group_vars/all/vars.yml`; the blue/green replicas never set it). The bot connects plaintext to the ircd docker alias (`IRCFIBER_IRCD_HOST`/`PORT` from the gateway env), sets `+B`, joins every channel in `support_bot_channel` (`#support,#ircfiber`, both permanent channels from `ircd_permanent_channels`; the FIRST entry is the announcement channel) and announces every Help & Feedback report, status change and public reply that the gateway queues on the Redis list `irc:support:outbox`. It also answers `!help`, `!issues [open|all]` and `!issue <n>` for anyone, and — past the WHOIS-313 oper gate, `!help admin` lists them — files and triages issues from IRC: `!new <title> [| details]` (kind `task`), `!bug <title> [| details]`, `!done <n>`, `!close <n>`, `!reopen <n>`, `!prio <n> <low|normal|high|urgent>`, `!note <n> <text>` (internal, never announced), plus the services commands `!adduser <nick>` and `!nsinfo <nick>`. Filing and status changes are acknowledged by the `#support` announcement itself. Lines never contain the report body, e-mail or diagnostics.

The bot is visible from the admin **IRCD** page (Overview → *Services bot* card, and its container logs in the Logs tab): every ≤5 s it publishes a heartbeat to the Redis key `irc:support:bot` (60 s TTL — no heartbeat = **Offline**) with nick, channel, session age, last disconnect reason, announcement/command counters and the outbox depth. The card's **Rejoin** / **Reconnect** buttons push `{cmd, by, ts}` onto `irc:support:bot:control` (consumed by the bot, ignored after 60 s), and **Announce** queues a `Notice from <admin>: …` line through the normal outbox, so it is delivered when the bot is back if it is currently away. All of this works from any gateway replica; only the bot container needs `IRCFIBER_SUPPORT_BOT_ENABLED`.

`vault_support_bot_nickserv_password` is the NickServ password of the bot nick; the bot sends `IDENTIFY` after 001 when it is set (leave it empty to skip — on a nick collision the bot runs as `FIBERSUPPORT_`). Roll out in this order:

```bash
ansible-playbook playbooks/ircd.yml                      # adds #support to the permanent channels (rehash, sockets stay up)
# register the bot nick once, from the prod host (Anope: usemail=no, no confirmation needed):
ssh <host> 'sudo docker run --rm --network ircfiber_net busybox sh -c \
  "(printf \"NICK FIBERSUPPORT\\r\\nUSER fibersupport 0 * :bot\\r\\n\"; sleep 4; \
    printf \"PRIVMSG NickServ :REGISTER <vault_support_bot_nickserv_password> support@<domain>\\r\\n\"; sleep 4; \
    printf \"QUIT\\r\\n\") | nc ircd 6667"'          # expect the NickServ "registered" notice
ansible-playbook playbooks/gateway.yml -t support-bot     # (re)creates ircfiber-support-bot; not part of blue/green
docker logs ircfiber-support-bot | grep 'joined #support' # then file a report at https://<domain>/?/feedback and watch #support
```

### Connection watch and `#staff` announcer (`FIBEREYE`, IP intelligence, automatic flood bans, `/unban`)

`FIBEREYE` is an *opered* IRC connection out of the same gateway image; it runs only where `IRCFIBER_FIBEREYE_ENABLED=1`, which the `gateway` role gives to the dedicated `ircfiber-fibereye` container (`fibereye_*` in `group_vars/all/vars.yml`). It absorbed the former `FiberLogs` bot: the `ircfiber-logs-bot` container, the `fiberlogs` oper and the `logs_bot_*` variables are gone, and `gateway.yml -t fibereye` removes a leftover logs-bot container. FiberEye does four things:

- **Persist every connect and quit** into Mongo (`fibereye_sessions`, `fibereye_ips`, `fibereye_bans`): nick, ident, cloaked host, real IP, GECOS, connect class, port, TLS, NickServ account (from numeric `330`), the session duration once the quit arrives, and the display fields of the IP intelligence record below. Sessions age out after 90 days through a TTL index on `tsAt`; changing `IRCFIBER_FIBEREYE_RETENTION_DAYS` on a live deployment needs `db.fibereye_sessions.dropIndex("tsAt_1")` first (same for `ipintel_records` and `lastSeenAt_1`), because MongoDB refuses to re-create a TTL index with a different expiry (the role logs the conflict rather than failing).
- **Assemble the IP intelligence record** (`backend/source/ircfiber/ipintel`, spec in `docs/IP_INTEL.md`) for every public connect: one async fan-out per never-before-seen address over proxycheck.io, ipinfo (`vault_ipinfo_token`), RIPEstat (prefix/ASN, RPKI, abuse contact), RDAP (registry, netname, allocation), StopForumSpam, DroneBL, EFnet RBL and the hourly Tor bulk exit list, plus ipapi.is and IPHub when their keys are set. Anonymiser flags are a **vote** — ≥2 agreeing sources or the Tor exit set confirm one; a single voter is stored as unconfirmed — and every field carries its source, fetch time and TTL. Raw answers cache 7 d (flags/geo), 24 h (reputation) or 30 d (registry) under `irc:ipintel:<src>:<ip>`, the assembled record 1 h under `irc:ipintel:v1:<ip>` and permanently in Mongo `ipintel_records`, so a known IP costs zero vendor requests. Daily caps per source live in Redis (`irc:ipintel:quota:*`, override with `IRCFIBER_IPINTEL_CAP_<SRC>`). Shodan InternetDB (non-commercial) runs only for the manual **Deep lookup** on the admin IP page.
- **Announce the Redis outbox in `#staff`** (`irc:logs:outbox`, fed by `ircfiber.logs.events`): every website signup, every outbound e-mail, every client connect (`nick!ident@host`, real IP, connect class, port, GECOS, then `↳ <ip> · City, Region, CC · AS<n> <name> · vpn(Mullvad)+hosting · risk 73 · prefix … · timezone` the first time an address is seen and `known IP (City, CC) · N sessions` after that), admin notices and backup runs. Because those lines carry full IPs and addresses, `#staff` is **oper-only**: `ircd_permanent_channels` gives it `+O` (`modes: "ntO"`, mode-locked `+ntOP` by `ircd_channel_setup.py`) and the bot must OPER before it can join. Connect classes in `fibereye_ignore_classes` are neither announced nor counted.
- **Evaluate three flood rules per IP group** — the exact address for IPv4, the `/64` for IPv6, because the observed flood rotates addresses inside one `/64` — over a rolling window: too many connects (`fibereye_connect_threshold`), too many distinct nicks (`fibereye_nick_threshold`), too many sessions shorter than `fibereye_short_ms` (`fibereye_churn_threshold`). A trip places a timed **Z-line** with an escalating duration (`fibereye_ban_seconds`, then ×24, then ×168). Classes in `fibereye_ignore_classes` and private addresses are never counted and never banned — `localhost-v6` is in that list on purpose, because Z-lining the ircd's own healthcheck source takes the whole platform offline. The announced BGP prefix is stored and displayed but **never** used for banning: a Z-line on a prefix would ban a whole ISP.

It opers as `ircd_fibereye_oper_name` (`fibereye`), whose `EyeWatch` class in `opers.conf.j2` grants exactly **`ZLINE` and `STATS`** plus `privs="servers/auspex"` and umode `+s` with snomasks `c`/`C`/`q`/`x`, host-locked to the Docker network. No `KILL`, no `GLINE`, no `KLINE`, no `REHASH`: seeing connects and placing a Z-line is the entire job, so a leak of that credential buys nothing else. The one priv is not optional — `commands="STATS"` alone lets the oper issue the command while the restricted STATS letters stay gated, so `STATS Z` answers `Stats 'Z' denied` (verified on InspIRCd 4.11.0) and FiberEye could place a Z-line but never see one, leaving every placement unconfirmed and every standing ban reconciled away as already gone. It is the same read-only visibility the `Dashboard` class needs. *Removing* a Z-line is deliberately not its capability — the admin Release button and the public unban page both go through the existing dashboard-oper session in the web process, and any oper may remove any X-line. `STATS Z` every 60 s is what confirms a placement actually landed (the ircd answers `ZLINE` with silence) and what reconciles bans the ircd has already expired.

The admin page is **`#/fibereye`**: a heartbeat card on `fibereye:bot` (60 s TTL — no heartbeat = **Offline**; connected but un-opered is badged *not opered*, which means no notices and no bans; *Not in #staff* means announcements stay queued), KPI counters, and searchable Sessions / IPs / Bans tables with a per-IP detail page that renders the whole record — Network, Geo, Classification with the voter table, Reputation, Provenance — and the **Deep lookup** button. The same card on **`#/ircd`** carries **Rejoin #staff** / **Reconnect** / **Announce** (`/api/admin/fibereye/{rejoin,reconnect,announce}`, through `fibereye:bot:control` and the outbox). The admin Mullvad page's ISP/ASN column reads the same record for each egress slot (prefix, RPKI, flags). FiberEye **ships disarmed**: enforcement is gated by the Redis key `fibereye:armed`, a missing key means disarmed, and the page's **Arm** button is the only thing that sets it. Until it is armed every trip is written as an `observeOnly` ban row — a "would ban" candidate — and no Z-line is placed. Arm only after reading real candidates and retuning the thresholds.

Banned users get an appeal URL in the ban reason and lift the ban themselves at **`/unban`** (`/unban/<token>` from the reason, or tokenless from the banned address itself) after a Cloudflare Turnstile challenge — `vault_turnstile_site_key` / `vault_turnstile_secret` in the shared gateway env, rate-limited to 3 attempts per address per day and 2 successful releases per group per week. The page only ever lifts a Z-line whose reason starts with the literal `FIBEREYE:`, which is why the `<connectban banmessage>` in `modules.conf.j2` carries the same prefix (that tag is also retuned here: `threshold="8"`, `banduration="5m"`, `ipv6cidr="64"` — the stock 32 is why the flood sailed through, and the key is `banduration`, not `duration`, which InspIRCd 4 ignores silently and falls back to a **6 hour** ban). A Z-line an oper set by hand is never touched.

Rollout (each step idempotent):

```bash
ansible-playbook playbooks/ircd.yml -t ircdconf             # EyeWatch oper (snomasks cCqx), fiberlogs oper removed, #staff permchannel, retuned connectban (SIGHUP rehash, nobody dropped)
ansible-playbook playbooks/ircd.yml -t chanserv             # register + mode-lock #staff
ansible-playbook playbooks/fibereye-nick.yml                # register the bot nick once (Anope: usemail=no)
make ship                                                   # the image that carries the bot code and the /unban page
ansible-playbook playbooks/gateway.yml -t fibereye,logs-bot # (re)creates ircfiber-fibereye with the intel key files, removes ircfiber-logs-bot; not part of blue/green
docker logs ircfiber-fibereye | grep -E 'opered|joined #staff|ipintel sources'
docker exec ircfiber-redis redis-cli get fibereye:bot       # opered:true, joined:true, channel:"#staff", intelSources:[…]
docker exec ircfiber-redis redis-cli scard irc:ipintel:torexits   # ≥ 1000 once the first hourly refresh ran
```

`vault_ircd_fibereye_oper_password` is **not** optional — the ircd role asserts it, so a missing value fails the play before anything is rendered. `vault_fibereye_nickserv_password` is optional (empty skips `IDENTIFY`; on a collision the bot runs as `FIBEREYE_`), and so is the Turnstile pair — without it `/unban` says self-service unban is not configured and releases nothing, which is the safe direction. The intel keys are optional too: `vault_ipinfo_token` owns the geo fields; without `vault_proxycheck_key` proxycheck runs keyless at 100 lookups/day; without `vault_ipapi_is_key` / `vault_iphub_key` those voters are skipped (`degraded: ipapi_is:nokey`), so a flag needs proxycheck plus the Tor exit set to confirm. The vendor accounts are registered to `vault_ipintel_email` (the ops@ mailbox).

#### Real IPs for web sessions (`WEBIRC`, the `ircfiber-web` connect class)

The engine sends `WEBIRC <vault_ircd_webirc_password> ircfiber <ip> <ip>` on every connection to `irc.ircfiber.com` (env `IRCFIBER_IRCD_WEBIRC_PASSWORD`, plumbed from the same vault value the ircd role hashes into `<gateway type="webirc">`), so the ircd sees each web user's own browser address instead of the engine's docker address — the gateway records it at every websocket handshake in `irc:webirc:ip:<userId>` (30 d TTL) and the engine reads it at connect time, never sending `WEBIRC` to any other host or for a non-public address (`isPublicUnicast`: a forged `X-Forwarded-For` can at most claim another public address, never `127.0.0.1`/`172.30.0.9`; honouring `CF-Connecting-IP` only from Cloudflare peers is a separate change). Operational consequences: web users' cloaked hosts change from a cloak of the engine address to a cloak of their own address (`<cloak method="hmac-sha256-addr">`), so any channel ban or `*!*@<old engine cloak>` mask stops matching — re-check `ircd_permanent_channels` mode-locks and standing bans before the deploy. FiberEye now sees web sessions under class `ircfiber-web` from real IPs; leave `fibereye_ignore_classes` unchanged, since ignoring the new class would stop the `fibereye_ips` rollups that feed `motd.d/profiles`, and enforcement stays gated by the `fibereye:armed` Redis key with no threshold change (the engine holds one connection per user per network, so a browser reload produces no connect churn). `connectban` now applies to web users' own addresses — intended; if a legitimate user is banned by it, raise `<connectban threshold>` rather than turning `useconnectban` off for the web class. Rollback is engine-only: blank `IRCFIBER_IRCD_WEBIRC_PASSWORD` and restart, and every connection logs `webirc_skipped reason=no-password` and lands in the engine classes as before (cloaks revert, so the ban-mask caveat applies in reverse).

### Channel services bot (`FIBERSERV` in `#ircfiber` and `#support`)

`FIBERSERV` is an Anope **BotServ** pseudo-client, not a container: `roles/ircd/files/ircd_channel_setup.py` runs `BOT ADD` once and `ASSIGN` for every channel in `ircd_permanent_channels` marked `bot: true`, so the bot list is deploy state rather than something an oper typed once. It is defined by `ircd_services_bot` (`nick`, `ident`, `host`, `realname`) in `roles/ircd/defaults/main.yml`; `inspircd.conf.j2` also reserves the nick with `<badnick>` so it stays unsquattable while services are down (Anope Q-lines it too, but only while it is running).

In the channel it holds `&` (botserv `botmodes = "ao"`) and `minusers = 0` keeps it there when the channel empties. It fronts the whole ChanServ command set through fantasy commands prefixed with a **backtick** (`` `help ``, `` `voice nick ``, `` `topic … ``, `` `kick nick `` — the prefix is the `fantasy` module block in `services.conf.j2`, chosen so it collides with neither `FIBERSUPPORT`'s `!` commands nor a sentence starting with `.`). ChanServ itself is unchanged and still answers `/msg ChanServ` network-wide; this is only the branded in-channel face of it.

Two behaviours worth knowing before someone reports them as bugs: fantasy commands need channel *access* (Anope's `FANTASIA` privilege), so the founder and `ircd_channel_access` can drive the bot and a passer-by with `+v` from `ircd_channel_autovoice` cannot; and `` `op <nick> `` on a user with no access is undone immediately, because the staff channels run with ChanServ `SECUREOPS` on. Use `` `voice `` for regulars, or add the account to `ircd_channel_access`.

```bash
ansible-playbook playbooks/ircd.yml -t chanserv    # BOT ADD + ASSIGN + fantasy; idempotent, prints one line per change
# expect on a first run:  BotServ: created FIBERSERV!services@services.host (IRC Fiber Channel Services)
#                         #ircfiber: assigned FIBERSERV
```

Renaming the bot (`ircd_services_bot.nick`) is a `BOT ADD` of a new nick, not a rename — Anope keeps the old bot until it is deleted by hand (`/msg BotServ BOT DEL <oldnick>`), and the old `<badnick>` reservation disappears from the rendered config on the next `playbooks/ircd.yml` run. Changing only `ident`/`host`/`realname` converges in place via `BOT CHANGE`. Dropping `bot: true` from a channel unassigns the bot from it; `ircd_services_bot: {}` creates no bot at all.

## Tailscale ACL recommendation

In the Tailscale admin console → ACLs, restrict the `ircfiber` tag to:

```jsonc
{
  "acls": [
    { "action": "accept", "src": ["tag:ircfiber"], "dst": ["tag:ircfiber:6379", "tag:ircfiber:27017", "tag:ircfiber:8091"] }
  ],
  "tagOwners": { "tag:ircfiber": ["autogroup:admin"] }
}
```

This ensures even if a host is compromised, it can only reach Redis/Mongo/engine-admin on other ircfiber-tagged devices, not the broader tailnet.

## Customizing

All knobs are in `inventories/production/group_vars/all.yml`. Override per host with `inventories/production/host_vars/<hostname>.yml`.

## CI: ansible-lint

```bash
pip install ansible-lint
ansible-lint
```

## License

MIT — same as IRC Fiber.
