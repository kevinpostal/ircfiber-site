<script lang="ts">
  /**
   * RefreshIndicator — animated pulse + last-fetched-ago.
   * Shows whether polling is active and how stale the data is.
   */
  import { pollingEnabled } from '../stores/ui';
  import { relative } from '../lib/format';
  interface Props {
    lastFetchedAt?: number | null;
    loading?: boolean;
  }
  let { lastFetchedAt = null, loading = false }: Props = $props();

  function toggle() {
    pollingEnabled.update((v) => !v);
  }

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 5_000);
    return () => clearInterval(id);
  });
</script>

<button
  type="button"
  onclick={toggle}
  class="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text transition hover:border-primary/40"
  title={$pollingEnabled ? 'Pause auto-refresh' : 'Resume auto-refresh'}
>
  {#if $pollingEnabled}
    {#if loading}
      <span class="h-2 w-2 animate-spin rounded-full border border-primary border-t-transparent"></span>
    {:else}
      <span class="relative flex h-2 w-2">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75"></span>
        <span class="relative inline-flex h-2 w-2 rounded-full bg-success"></span>
      </span>
    {/if}
    <span class="text-success">Live</span>
  {:else}
    <span class="h-2 w-2 rounded-full bg-muted"></span>
    <span class="text-muted">Paused</span>
  {/if}
  {#if lastFetchedAt}
    <span class="text-muted">· {relative(lastFetchedAt, now)}</span>
  {/if}
</button>