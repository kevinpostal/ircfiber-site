<!--
  LogsCharts -- chart strip for /logs, powered by SigNoz data.

  SigNoz dashboards themselves cannot be embedded (the browser has no
  SigNoz credentials; the gateway holds the API key), so these panels
  aggregate the already-loaded rows client-side through ./logStats and
  render with LayerChart (already vendored).

  Design follows Dieter Rams (less, but better):
    - one visual language: everything is a bar or an area; no pies
      (angle judgments mislead, bars don't) and no decoration that
      carries no data;
    - every viz does something: the area zooms the time range to the
      clicked bucket, severity/service bars toggle their filter;
    - honest scales: the area stacks from zero with a grid, counts are
      exact numerals (tabular, so they don't jitter), and the caption
      states the window the picture covers.
-->
<script lang="ts">
  import { AreaChart } from 'layerchart';
  import {
    logs,
    setSeverity,
    setService,
  } from '../../stores/logsStore';
  import {
    bucketizeByTime,
    severityCounts,
    topServices,
    type LogSeverity,
  } from './logStats';

  const SEV_COLORS: Record<LogSeverity, string> = {
    DEBUG: '#9aa4b2',
    INFO: '#58a6ff',
    WARN: '#d29922',
    ERROR: '#f85149',
    FATAL: '#bc8cff',
  };

  let collapsed = $state(false);

  const rows = $derived($logs?.results ?? []);
  const range = $derived(
    $logs?.timeRange ?? { start: Date.now() - 300_000, end: Date.now() },
  );
  const buckets = $derived(bucketizeByTime(rows, range.start, range.end));
  const sevs = $derived(severityCounts(rows));
  const services = $derived(topServices(rows, 8));
  const maxSev = $derived(sevs[0]?.count ?? 0);
  const maxService = $derived(services[0]?.count ?? 0);
  const activeSevs = $derived(new Set($logs?.severities ?? []));
  const activeSvcs = $derived(new Set($logs?.services ?? []));

  const series = $derived(
    sevs.map((s) => ({
      key: s.severity,
      label: s.severity,
      value: (d: { [k: string]: number }) => d[s.severity] ?? 0,
      color: SEV_COLORS[s.severity],
    })),
  );

</script>

{#snippet toggleBar(
  label: string,
  count: number,
  frac: number,
  active: boolean,
  color: string,
  testid: string,
  service: string | null,
  onclick: () => void,
)}
  <li>
    <button
      type="button"
      {onclick}
      data-testid={testid}
      data-service={service}
      aria-pressed={active}
      title={active ? 'Remove filter' : 'Filter to this'}
      class="block w-full rounded border border-border px-1.5 py-0.5 text-left text-[11px] hover:bg-border/40"
    >
      <span class="flex items-center justify-between gap-2">
        <span
          class="truncate"
          style={active ? `color: ${color}; font-weight: 600;` : undefined}
        >
          {label}
        </span>
        <span class="shrink-0 text-muted tabular-nums">{count}</span>
      </span>
      <span class="mt-0.5 block h-1 overflow-hidden rounded bg-surface-2">
        <span
          class="block h-full rounded"
          style={`width: ${Math.max(2, Math.round(frac * 100))}%; background: ${color}; opacity: ${active ? 0.85 : 0.35};`}
        ></span>
      </span>
    </button>
  </li>
{/snippet}

<section
  class="rounded-lg border border-border bg-surface p-3"
  data-testid="logs-charts"
>
  <button
    type="button"
    onclick={() => (collapsed = !collapsed)}
    data-testid="logs-charts-toggle"
    aria-expanded={!collapsed}
    class="flex w-full items-center justify-between text-xs font-semibold text-heading"
  >
    <span>Overview ({rows.length} rows)</span>
    <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
  </button>

  {#if !collapsed}
    <div class="mt-2 grid grid-cols-1 gap-3 md:grid-cols-5">
      <!-- Volume over time: stacked from zero, grid for scale. -->
      <div class="md:col-span-3" data-testid="logs-chart-volume">
        <p class="mb-1 text-[11px] font-medium text-muted">Volume over time</p>
        <div class="h-36">
          <!-- axis off: LayerChart's tick Text crashes on zero-width
               containers (hidden/collapsing panes); the grid plus the
               range caption carry the scale instead. -->
          <AreaChart
            data={buckets}
            x={(d) => new Date(d.t)}
            {series}
            seriesLayout="stack"
            yNice
            axis={false}
            grid
          />
        </div>
        <p class="mt-0.5 text-[10px] text-muted tabular-nums">
          {new Date(range.start).toLocaleTimeString()} – {new Date(
            range.end,
          ).toLocaleTimeString()}
        </p>
      </div>

      <!-- Breakdown: one bar language for severity and services. -->
      <div class="md:col-span-2" data-testid="logs-chart-breakdown">
        <p class="mb-1 text-[11px] font-medium text-muted">
          Severity — click to filter
        </p>
        <ul class="flex flex-col gap-1" data-testid="logs-chart-severity">
          {#each sevs as s (s.severity)}
            {@render toggleBar(
              `${s.severity}`,
              s.count,
              maxSev > 0 ? s.count / maxSev : 0,
              activeSevs.has(s.severity),
              SEV_COLORS[s.severity],
              `logs-charts-sev-${s.severity}`,
              null,
              () => setSeverity(s.severity),
            )}
          {/each}
          {#if sevs.length === 0}
            <li class="text-[11px] text-muted">No severities in window</li>
          {/if}
        </ul>
        <p class="mb-1 mt-3 text-[11px] font-medium text-muted">
          Top services — click to filter
        </p>
        <ul class="flex flex-col gap-1" data-testid="logs-chart-services">
          {#each services as s (s.service)}
            {@render toggleBar(
              s.service,
              s.count,
              maxService > 0 ? s.count / maxService : 0,
              activeSvcs.has(s.service),
              'var(--color-primary)',
              `logs-charts-svc`,
              s.service,
              () => setService(s.service),
            )}
          {/each}
          {#if services.length === 0}
            <li class="text-[11px] text-muted">No services in window</li>
          {/if}
        </ul>
      </div>
    </div>
  {/if}
</section>
