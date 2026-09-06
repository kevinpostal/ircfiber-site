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

## Anope XML-RPC (website account registration)

- `ircfiber-services` loads `m_httpd` + `m_xmlrpc` + `m_xmlrpc_main` and
  listens on `{{ ircd_services_rpc_port }}` (8080) **inside** the container.
  The container publishes no ports, so only `ircfiber_net` can reach it.
  m_xmlrpc has no authentication of its own — never publish this port.
- The gateway (`ircfiber.services.accounts`) uses it to run
  `NickServ REGISTER <generated-pw> <email>` for every website account on
  signup and on the first login of an existing account, then stores the
  password as the user's SASL PLAIN credential on the IRC Fiber network and
  pushes `reconnectNetwork` so the live session authenticates. The account
  name is the username, falling back to `<username>_<4 hex>` then
  `<username>_2…_9` when the nick is already registered.
- Endpoint wiring: `IRCFIBER_ANOPE_RPC_URL` /
  `IRCFIBER_ANOPE_RPC_TIMEOUT` in the gateway env. Set
  `ircd_services_rpc_enabled: false` to turn the listener and the
  auto-registration off; the gateway then logs "Anope RPC not configured"
  and skips provisioning. Adding/removing the modules needs a services
  **restart**, not a rehash — the ircd role handler already does that.
- **Hijack guard (security-critical).** `ns_register` finishes with
  `u->Identify(na)` for whoever is online as the target nick, so registering
  a nick a stranger holds logs *them* into the brand-new account. Verified on
  2.0.20: the squatter's own socket received
  `900 … :You are now logged in as probesquat` plus `MODE +r`. The gateway
  therefore registers a nick only when either (a) our engine currently holds
  exactly that nick — nicks are unique, so it must be our session — or
  (b) Anope's `user` method reports no live session on it. `NickServ STATUS`
  is **not** usable here: it reports identification, so an online
  *unregistered* nick answers `0` exactly like an offline one. The oracle for
  (a) is the engine's `NetworkStateSnapshot.currentNick`; when the engine has
  not connected yet and somebody holds the nick, provisioning defers
  (`ProvisionOutcome.deferred`, no skip key) and retries on the next login.
- Guard keys (Redis): `irc:services:lock:<userId>` (SET NX EX 60,
  single-flight across gateway replicas), `irc:services:skip:<userId>`
  (24h give-up marker whose value is the user-facing reason) and
  `irc:services:retry:<userId>` (60s throttle on the self-service retry).
- User-visible state comes from `GET /api/me/irc-account`:
  `ready` | `pending` (in flight, retries itself) | `unavailable` (skip key
  set; its text is shown as the reason, with a Retry button that
  `POST`s `/api/me/irc-account/retry`) | `none` (no IRC Fiber network).
  Deleting the skip key by hand has the same effect as the Retry button.
- **Signup-time availability gate.** `/register` rejects a username that
  `NickServ INFO` reports as registered (`Account:` line) or as a service bot
  (`is part of this Network's Services`), because the username *is* the user's
  nick and account name. It fails **open**: an unreachable or disabled Anope
  logs `register: could not verify IRC availability of <name>` and lets the
  signup through, where the fallback chain takes over — signup never depends
  on services being up. Kill switch: `IRCFIBER_SIGNUP_NICK_CHECK=0`
  (`ircd_signup_nick_check: false`). The check is budgeted to 4s.
- Username uniqueness is checked **case-insensitively**
  (`UserRepository.findByUsernameCI`) because IRC nicks are: `Alice` and
  `alice` are one identity on the network and must not become two accounts.
  ASCII folding only; the rfc1459 `[]\`↔`{}|` equivalence is caught by the
  Anope gate above.
- Emails are rejected at signup if they contain whitespace or control
  characters, and every value interpolated into a services command passes
  `isSafeServicesArg` first — services commands are space-delimited, so an
  unsanitised argument injects extra parameters into what Anope runs.
- Every generated credential is proved with `checkAuthentication` (the same
  path SASL PLAIN takes) **before** it is persisted or shown, and is written
  to `irc:services:pending:<userId>` (24h) *before* `REGISTER`. If the gateway
  dies between registering and saving, the next run adopts that record
  instead of orphaning the user's nick under a password nobody knows; a
  record that no longer authenticates is discarded.
- Anope flushes `anope.db` every `updatetimeout` (5m); a services restart
  within that window can lose a just-created account. No action needed —
  the user's next login re-provisions it.
- Manual probe from a container on `ircfiber_net`:
  `POST http://services:8080/xmlrpc`, `Content-Type: text/xml`, body
  `<?xml version="1.0"?><methodCall><methodName>command</methodName><params>`
  `<param><value><string>NickServ</string></value></param>` … one `<string>`
  per positional argument. Replies are XML-escaped **twice**
  (`&amp;#xA;` is one newline, `&amp;qt;` is `>`).

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
