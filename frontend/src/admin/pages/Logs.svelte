<script lang="ts">
  /**
   * Logs — embedded Grafana dashboard for the logging stack.
   * Routes to /grafana/* on the main site, which is proxied to the
   * Grafana container by Caddy (see deploy/roles/logging).
   */
</script>

<div class="flex h-full flex-col">
  <div class="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
    <div>
      <h1 class="text-lg font-semibold text-text">Logs (Grafana)</h1>
      <p class="text-xs text-muted">Aggregated by Loki · scraped by Promtail</p>
    </div>
    <a
      href="/grafana/explore?orgId=1"
      target="_blank"
      rel="noopener"
      class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border/40"
    >
      Open in new tab ↗
    </a>
  </div>

  <div class="flex-1 overflow-hidden bg-surface-2">
    <!-- Caddy proxies /grafana/* to ircfiber-grafana:3000 with the path stripped. -->
    <iframe
      src="/grafana/d/ircfiber-all-logs/ircfiber-all-logs?kiosk"
      class="h-full w-full border-0"
      title="IRC Fiber logs"
      allow="fullscreen"
    ></iframe>
  </div>
</div>