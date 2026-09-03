/**
 * Single source of truth for the tailnet SigNoz UI URL.
 *
 * The IRC Fiber admin SPA offers a deep link into the full SigNoz UI
 * (saved views, pivots, anomalies) via /logs. The URL is rendered in
 * the Logs page header and on per-row "open in SigNoz" links.
 *
 * Operationally this is the k8s SigNoz ingress over the tailnet
 * (see deploy/k8s/signoz/ingress.yaml). It needs Tailscale MagicDNS
 * on the client (e.g. the operator's tailnet-joined laptop) -- the
 * old 198.51.100.1:3003 Caddy listener is gone. If the ingress
 * host changes, update this file AND the ingress manifest.
 */

export const TAILNET_SIGNOZ_URL =
  'https://signoz.ubuntu-docker.tail544547.ts.net';
export const TAILNET_SIGNOZ_LOGS_URL = `${TAILNET_SIGNOZ_URL}/logs`;
