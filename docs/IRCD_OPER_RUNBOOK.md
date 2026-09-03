# IRC Fiber — IRCd Oper Runbook (InspIRCd 4 + Anope 2)

One page for day-to-day network operation. Canonical config lives in
`site/deploy/roles/ircd/`; all deploys run from `site/deploy/`.

## Connections

- Public: `irc.ircfiber.com:6697` (TLS, LE cert) and `:6667` (plaintext).
- Internal: Anope links to `ircd:7000` (never published to the host).
- Engine multiplexes every platform user through the Docker subnet with no
  clone limits and no throttling — never apply session/clone discipline to
  that range; discipline belongs on direct public connections only.

## Oper accounts

- Human admin: `/OPER admin <vault_ircd_oper_password>` (TLS-only,
  NetAdmin class). Doubles as Anope Services Root, but only after the nick
  `admin` is registered with NickServ and identified.
- Dashboard (gateway admin UI, least privilege: REHASH + G/K/Z-LINE + STATS,
  host-locked to the Docker network): credential is
  `vault_ircd_dashboard_password`, used via `IRCFIBER_IRCD_OPER_PASSWORD`.
- GlobalOp/Helper tiers exist in `opers.conf.j2` for future staff; no
  accounts materialized yet — add an `<oper>` entry of the right type when
  staff grows, never widen Dashboard.

## Common actions

```sh
# Rehash config only (no disconnects — safe anytime):
docker kill --signal=HUP ircfiber-ircd
# Full restart (disconnects everyone — announce first):
make deploy-restart COMP=ircd   # per the ircd role handlers; or restart
                                # the ircfiber-ircd container on the host
# Check served TLS cert (expect LE chain, far-future expiry):
openssl s_client -connect irc.ircfiber.com:6697 \
  -servername irc.ircfiber.com </dev/null | openssl x509 -noout -issuer -dates
```

- G/K/Z-LINE management works from either the admin oper or the Dashboard
  credential (`GLINE`, `KLINE`, `ZLINE`, `STATS g/k/z`).
- Services Root pairing after a fresh deploy: register `admin` with
  NickServ, `/msg NickServ IDENTIFY admin <pw>`, then `/OPER`.

## TLS renewal

- Caddy renews the LE cert automatically. Daily at 03:17 host time,
  `ircfiber-ircd-tls-sync` copies a changed cert/key into
  `/etc/ircfiber/ircd/` (uid 10000, 0640) and SIGHUPs ircd.
- If the sync script ever reports "not yet issued", deploy the caddy role
  first with `irc.ircfiber.com` in `caddy_acme_hosts` and port 80 reachable,
  then re-run the ircd playbook.

## Logs

- InspIRCd: container stdout (`docker logs ircfiber-ircd`), shipped to
  SigNoz via fluent-bit; level is `ircd_log_level` (`normal` in prod).
- Anope: `services.log` under `/anope/logs` plus admin actions to globops.
- Oper activity (all G/K/Z-LINE, rehash, services admin) must be visible in
  one of the above — if an action leaves no trace, that is a bug.

## Rollback

- Config-only change misbehaves: revert the role/host_vars change,
  re-render, `docker kill --signal=HUP ircfiber-ircd`.
- Bad TLS cutover: set `ircd_tls_mode: "selfsigned"` in host_vars, re-run
  the ircd playbook (entrypoint cert boots the server immediately).
- Vault/secret rotation: `ansible-vault edit
  inventories/production/group_vars/vault.yml` from `site/deploy/`;
  never commit plaintext secrets.
