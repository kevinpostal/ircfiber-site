<script lang="ts">
  /**
   * Logs — embedded SigNoz UI.
   * Caddy reverse-proxies ircfiber.com/signoz/* to the signoz-signoz
   * container on ircfiber_logging, injecting the EDITOR service-account
   * SIGNOZ-API-KEY header so the browser never sees SigNoz auth.
   * See deploy/roles/caddy/templates/Caddyfile.j2 and
   * deploy/roles/signoz_mcp/tasks/main.yml.
   */
</script>

<div class="flex h-full flex-col">
  <div class="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
    <div>
      <h1 class="text-lg font-semibold text-text">Logs (SigNoz)</h1>
      <p class="text-xs text-muted">Aggregated via OpenTelemetry · stored in ClickHouse</p>
    </div>
    <a
      href="/signoz/logs"
      target="_blank"
      rel="noopener"
      class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border/40"
    >
      Open in new tab ↗
    </a>
  </div>

  <div class="flex-1 overflow-hidden bg-surface-2">
    <iframe
      src="/signoz/logs"
      class="h-full w-full border-0"
      title="IRC Fiber logs"
      allow="fullscreen"
    ></iframe>
  </div>
</div>
