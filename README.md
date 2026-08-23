# ircfiber-site — Gateway + Web Client

Frontend and gateway for IRC Fiber. Svelte 5 SPA served by a D/vibe.d gateway. Part of the IRC Fiber superproject.

![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00)
![Vite](https://img.shields.io/badge/Vite-6-646CFF)
![D vibe.d](https://img.shields.io/badge/D-vibe.d-8B0000)

## What this is

- **Gateway** (`backend/`): HTTP + WebSocket, auth, sessions, admin API, serves `public/dist`
- **Web client** (`frontend/`): Svelte 5 + Vite, IRCCloud-inspired, live updates over WS
- **Shared** (`common/` duplicated from `ircfiber-common`, drift guard `scripts/check-common-drift.sh`)

Engine is separate: `kevinpostal/ircfiber-engine`.

## Quick start

```bash
git clone https://github.com/kevinpostal/ircfiber-site.git
cd ircfiber-site
./scripts/generate-version.sh
# frontend
npm --prefix frontend ci
npm --prefix frontend run build   # or npm --prefix frontend run dev -- --host
# backend
dub --root=common build
dub --root=backend build
# run (needs redis + mongo)
./backend/irc-fiber --config config/dev.conf
open http://localhost:8090
```

### Docker

```bash
docker compose up -d          # gateway + redis + mongo + ircd (uses Containerfile.site)
docker compose logs -f gateway
```

`Containerfile.site` stages: `base` → `builder-common` → `builder-backend` → `frontend-builder` → `runtime-gateway`. Never compiles `engine/`.

## Project structure

```
ircfiber-site/
 frontend/src/{components,lib,stores,styles}  # Svelte 5
 frontend/wasm-img2irc/                       # WASM image pipeline (optional)
 backend/source/ircfiber/{api,web,auth}      # vibe.d
 backend/views/                               # Diet templates
 common/source/ircfiber/{redis,models,db}     # duplicated, see common/README.md
 public/dist/                                 # Vite output
 Containerfile.site + Makefile.site + docker-compose.yml
 deploy/playbooks/deploy-site.yml             # ansible, src_root=/opt/ircfiber-site
```

## Configuration

```bash
cp .env.example .env
# set FIBER_PASSWORD, IRCFIBER_REDIS_URL, etc.
cp deploy/inventories/production/group_vars/vault.example.yml deploy/inventories/production/group_vars/vault.yml
ansible-vault edit deploy/inventories/production/group_vars/vault.yml  # set vault_ircfiber_admin_password
```

`deploy/inventories/production/group_vars/all/vars.yml` uses `{{ vault_ircfiber_admin_password }}` — no hardcoded default.

## Deployment

```bash
ansible-playbook deploy/playbooks/deploy-site.yml -l vps-efb4b52d
# builds Containerfile.site --target runtime-gateway, restarts ircfiber-gateway only (engine PID untouched)
```

## Testing

```bash
npm --prefix frontend test
npm --prefix frontend run test:watch
dub --root=common test
dub --root=backend test
./scripts/check-common-drift.sh --fetch  # must be ✓
```

## License

MIT
