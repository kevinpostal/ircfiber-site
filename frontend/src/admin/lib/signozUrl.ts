/**
 * Single source of truth for the tailnet SigNoz listener URL.
 *
 * The IRC Fiber admin SPA offers a deep link into the full SigNoz UI
 * (saved views, pivots, anomalies) via /signoz/logs. The listener URL
 * is rendered in the Logs page header.
 *
 * Operationally, this lives on the deploy-managed Tailscale-only
 * listener (see deploy/roles/caddy/templates/Caddyfile.j2:174-184)
 * and is owned by ircfiber-caddy. If the listener IP/port changes,
 * update this file AND the Caddyfile.
 *
 * For local dev, the SigNoz URL is the VITE_SIGNOZ_URL env var (see
 * vite.config.ts). This file is INTENTIONALLY only the tailnet URL
 * because that one is configuration, not per-environment.
 */

export const TAILNET_SIGNOZ_URL = 'http://198.51.100.1:3003';
export const TAILNET_SIGNOZ_LOGS_URL = `${TAILNET_SIGNOZ_URL}/logs`;