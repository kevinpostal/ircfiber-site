<script lang="ts">
  /**
   * KpiCard — large numeric value + label + optional trend pill + icon slot.
   * Used on the dashboard for "Total Users", "Healthy Engines", etc.
   * Renders as <a> when href is provided, otherwise <div>.
   */
  interface Props {
    label: string;
    value: string | number;
    trend?: { value: number; positive?: boolean };
    tone?: 'default' | 'muted' | 'success' | 'warn' | 'danger' | 'info';
    icon?: string;
    href?: string;
    hint?: string;
    loading?: boolean;
  }
  let { label, value, trend, tone = 'default', icon, href, hint, loading = false }: Props = $props();

  const toneClasses: Record<string, string> = {
    default: 'text-heading',
    muted: 'text-muted',
    success: 'text-success',
    warn: 'text-warn',
    danger: 'text-danger',
    info: 'text-info',
  };
  const toneClass = $derived(toneClasses[tone] ?? toneClasses.default);
  const isLoading = $derived(Boolean(loading));
  const trendUp = $derived(trend ? (trend.positive ?? (trend.value >= 0)) : false);
  const trendValue = $derived(trend ? trend.value : 0);
</script>

{#if href}
  <a
    {href}
    class="block rounded-lg border border-border bg-surface-2 p-5 transition hover:border-primary/40 hover:bg-surface-2/80 cursor-pointer"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div class="mt-2 text-3xl font-bold {toneClass}">
          {#if isLoading}
            <span class="inline-block h-9 w-24 animate-pulse rounded bg-border"></span>
          {:else}
            {value}
          {/if}
        </div>
        {#if hint}
          <div class="mt-1 text-xs text-muted">{hint}</div>
        {/if}
      </div>
      {#if icon}
        <div class="text-2xl text-muted">{icon}</div>
      {/if}
    </div>
    {#if trend}
      <div class="mt-3 flex items-center gap-1 text-xs {trendUp ? 'text-success' : 'text-danger'}">
        <span>{trendUp ? '↑' : '↓'}</span>
        <span>{Math.abs(trendValue).toFixed(1)}%</span>
        <span class="text-muted">vs last period</span>
      </div>
    {/if}
  </a>
{:else}
  <div class="block rounded-lg border border-border bg-surface-2 p-5 cursor-default">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-xs font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div class="mt-2 text-3xl font-bold {toneClass}">
          {#if isLoading}
            <span class="inline-block h-9 w-24 animate-pulse rounded bg-border"></span>
          {:else}
            {value}
          {/if}
        </div>
        {#if hint}
          <div class="mt-1 text-xs text-muted">{hint}</div>
        {/if}
      </div>
      {#if icon}
        <div class="text-2xl text-muted">{icon}</div>
      {/if}
    </div>
    {#if trend}
      <div class="mt-3 flex items-center gap-1 text-xs {trendUp ? 'text-success' : 'text-danger'}">
        <span>{trendUp ? '↑' : '↓'}</span>
        <span>{Math.abs(trendValue).toFixed(1)}%</span>
        <span class="text-muted">vs last period</span>
      </div>
    {/if}
  </div>
{/if}