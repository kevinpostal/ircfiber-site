<script lang="ts">
  /**
   * ServerGroup — one collapsible group per engine server on admin#/servers.
   * Shell classes copied from Card.svelte (not extended); collapse idiom
   * copied from LogsCharts.svelte (button + aria-expanded + ▸/▾ + {#if} unmount).
   */
  import type { Snippet } from 'svelte';
  import StatusBadge from './StatusBadge.svelte';

  interface Props {
    serverId: string;
    healthy: boolean;
    hotswapActive?: boolean;
    networkCount: number;
    connText: string;
    open: boolean;
    onToggle: () => void;
    children?: Snippet;
    meta?: Snippet;
    statusLabel?: string;
    statusTone?: 'success' | 'danger' | 'warn' | 'info';
    title?: string;
  }
  let {
    serverId,
    healthy,
    hotswapActive = false,
    networkCount,
    connText,
    open,
    onToggle,
    children,
    meta,
    statusLabel,
    statusTone,
    title,
  }: Props = $props();
</script>

<section class="rounded-lg border border-border bg-surface-2 overflow-hidden">
  <button
    type="button"
    aria-expanded={open}
    data-testid="server-group-toggle-{serverId}"
    onclick={onToggle}
    class="flex w-full items-center gap-3 px-5 py-3 text-left"
  >
    <span aria-hidden="true" class="text-muted">{open ? '▾' : '▸'}</span>
    <span class="h-3 w-3 shrink-0 rounded-full {healthy ? 'bg-success' : 'bg-danger'}"></span>
    <span class="font-semibold text-heading">{title ?? serverId}</span>
    <StatusBadge
      label={statusLabel ?? (healthy ? 'Healthy' : 'Unhealthy')}
      tone={statusTone ?? (healthy ? 'success' : 'danger')}
      size="sm"
    />
    {#if hotswapActive}
      <StatusBadge label="HOT SWAP" tone="warn" size="sm" />
    {/if}
    <span class="ml-auto shrink-0 text-xs text-muted">{networkCount} networks · {connText}</span>
  </button>
  {#if open}
    <div class="border-t border-border px-5 py-4" data-testid="server-group-body-{serverId}">
      {#if meta}
        {@render meta()}
      {/if}
      {#if children}
        {@render children()}
      {/if}
    </div>
  {/if}
</section>
