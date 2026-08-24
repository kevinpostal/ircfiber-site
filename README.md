# ircfiber-site — Gateway + Web Client

**Svelte 5 SPA + D/vibe.d gateway for IRC Fiber.** Serves the web UI, handles auth/sessions, and fans events from Redis. Portfolio analog for **Django + React** at scale.

<p align="center">
  <a href="https://github.com/kevinpostal/irc-fiber">
    <img src="https://github.com/kevinpostal/irc-fiber/releases/download/v0.3.0-demo/irc-fiber-final-minimal.gif" width="800" alt="IRC Fiber demo — splash → #autism 5s → #zod 5s" />
  </a>
</p>

![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00)
![Vite](https://img.shields.io/badge/Vite-6-646CFF)
![D vibe.d](https://img.shields.io/badge/D-vibe.d-8B0000)
![Docker](https://img.shields.io/badge/Docker-BuildKit-2496ED)
![Ansible](https://img.shields.io/badge/Ansible-decoupled-E00)

## Why this matters for hiring

At **National Services Group** I built `Django`/`DRF` gateways for 6 brands (50K+ users) and at **Walmart** I worked on `OPUS` (millions). This gateway is the same pattern in `D` — replace `vibe.d` with `Django`, keep the contract:

* **HTTP/WS + Auth:** `backend/source/ircfiber/api/{rest,websocket,session,auth}.d` — login, sessions (Redis 14d), `Diet` templates, static `public/dist`. Same as `Django` + `DRF` + `Celery` + `Redis` I shipped.
* **Frontend:** `frontend/src/{components,lib,stores}` — `Svelte 5` runes, `Vite`, `TypeScript`, `SCSS`, WebSocket stores (`ircStore`, `preferences`). Maps 1:1 to `React` hooks I used at **AMP Agency** (LinkedIn, Amazon, FX) and **Woven** (85M+ monthly).
* **Ops:** `Containerfile.site` (`base` → `builder-common` → `builder-backend` → `frontend-builder` → `runtime-gateway`) **never compiles `engine/`** — site deploys via `ansible-playbook deploy-site.yml -l vps-efb4b52d` without restarting `engine` PID 7.

Part of [kevinpostal/irc-fiber](https://github.com/kevinpostal/irc-fiber) superproject — `git clone --recursive` gets `site` + `engine` + `common`.

## Quick start

```bash
git clone https://github.com/kevinpostal/ircfiber-site.git
cd ircfiber-site
./scripts/generate-version.sh
# frontend
npm --prefix frontend ci && npm --prefix frontend run build  # or dev -- --host
# backend
dub --root=common build && dub --root=backend build
./backend/irc-fiber --config config/dev.conf  # → http://localhost:8090
```

### Docker

```bash
docker compose up -d          # gateway + redis + mongo + ircd (Containerfile.site)
docker compose logs -f gateway
```

## Structure

```
ircfiber-site/
 frontend/src/{components,lib,stores,styles}  # Svelte 5 + Vite
 frontend/wasm-img2irc/                       # WASM image → IRC art (optional)
 backend/source/ircfiber/{api,web,auth,upload} # vibe.d REST/WS
 backend/views/                               # Diet templates
 common/source/ircfiber/{redis,models,db,storage} # duplicated, see ircfiber-common
 public/dist/                                 # Vite output
 Containerfile.site + Makefile.site + docker-compose.yml
 deploy/playbooks/deploy-site.yml             # src_root=/opt/ircfiber-site, no engine touch
```

## Configuration

```bash
cp .env.example .env  # FIBER_PASSWORD, REDIS/MONGO URLs
cp deploy/inventories/production/group_vars/vault.example.yml deploy/inventories/production/group_vars/vault.yml
# with 1Password:
op inject -i vault.example.yml -o vault.yml && op read "op://IRC Fiber/vault/password" > deploy/.vault_pass.txt
# or Codespaces: set ANSIBLE_VAULT_PASSWORD secret → postCreate writes .vault_pass.txt
ansible-vault edit deploy/inventories/production/group_vars/vault.yml
```

`all/vars.yml` uses `{{ vault_ircfiber_admin_password }}` — no hardcoded default. `hosts.ini` is gitignored (`hosts.ini.example` committed).

## Deployment

Decoupled — site never restarts engine:

```bash
ansible-playbook deploy/playbooks/deploy-site.yml -l vps-efb4b52d
# BuildKit --target runtime-gateway, GIT_HASH injection, restarts ircfiber-gateway only
```

Host: `vps-efb4b52d` → `/opt/ircfiber-site` (`Containerfile.site`), `/opt/ircfiber-engine` separate.

## Testing

```bash
npm --prefix frontend test          # Vitest lib + client (Playwright)
npm --prefix frontend run test:watch
dub --root=common test && dub --root=backend test
./scripts/check-common-drift.sh --fetch  # common in sync?
```

## Links

* Superproject: [kevinpostal/irc-fiber](https://github.com/kevinpostal/irc-fiber) (1 clone)
* Engine: [kevinpostal/ircfiber-engine](https://github.com/kevinpostal/ircfiber-engine)
* Common: [kevinpostal/ircfiber-common](https://github.com/kevinpostal/ircfiber-common)
* Live: [ircfiber.com](https://ircfiber.com)

## License

MIT
