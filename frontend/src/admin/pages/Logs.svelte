<!--
  Logs.svelte -- admin page that drives the IRC Fiber logs panel.

  W2-T4 of plan 20260630-admin-signoz-logs-panel. Composes:

    - <PageHeader>           -- title + "Open SigNoz" deep link
    - tailnet-fallback strip -- single link to the Tailscale listener
                              (the rendered URL is intentionally the
                              /logs deep link, NOT just "/", so the
                              operator lands in the SigNoz Logs explorer
                              instead of the home dashboard)
    - view dropdown + save-view -- persisted via savedViews store
    - <LogsToolbar>          -- query input + filters + time + live + cURL
    - <Card> + state machine  -- skeleton | error | empty | <LogTable>
    - <JsonDrawer> overlay    -- row click opens raw JSON
    - <FilterCheatsheet>      -- `?` opens, `Esc` closes

  Source of truth for the deep link is signozUrl.ts -- this file
  imports the constants and never inlines the IP literal.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import LogsToolbar from '../components/logs/LogsToolbar.svelte';
  import LogTable from '../components/logs/LogTable.svelte';
  import JsonDrawer from '../components/logs/JsonDrawer.svelte';
  import FilterCheatsheet from '../components/logs/FilterCheatsheet.svelte';
  import { TAILNET_SIGNOZ_LOGS_URL, TAILNET_SIGNOZ_URL } from '../lib/signozUrl';
  import {
    logs,
    logsLoading,
    logsError,
    runQuery,
    resetFilters,
    toggleExpandedRow,
    setQuery,
    setService,
    setSeverity,
    setTimeRange,
    cancelQuery,
  } from '../stores/logsStore';
  import type { LogRow, TimeRange } from '../stores/logsStore';
  import { getRowId } from '../components/logs/rowId';
  import { views, saveView, loadView } from '../stores/savedViews';
  import { toastError } from '../stores/ui';

  // --- Drawer state (row under inspection + its screen anchor) ----------
  // JsonDrawer is an overlay; the anchor rect lets it snap to the clicked
  // row's screen position with a clamp so it never overflows the viewport.
  let drawerRow = $state<LogRow | null>(null);
  let drawerAnchor = $state<DOMRect | null>(null);

  // --- Cheatsheet toggle ----------------------------------------------
  // Bound via `bind:open` so the dialog's own Escape / backdrop handlers
  // can flip it closed without a callback prop.
  let cheatsheetOpen = $state(false);

  // --- Save-view form -------------------------------------------------
  // Toggle the input vs the button so the toolbar row stays compact.
  let saveViewOpen = $state(false);
  let saveViewName = $state('');

  // --- Initial fetch --------------------------------------------------
  // Always kick a query on mount so the operator sees results without
  // having to click anything. If the store already restored a recent
  // query from localStorage, that's what fires.
  onMount(() => {
    void runQuery();
  });

  // --- Error-toast translation ----------------------------------------
  // The raw error string from logsStore is informative for the inline
  // error state, but operators care about two specific signals, both
  // of which now come from the gateway proxy (the browser never talks
  // to SigNoz itself):
  //   1. rejected API key -- the gateway's IRCFIBER_SIGNOZ_API_KEY is
  //      missing or rotated; mint one in SigNoz -> Settings -> API Keys,
  //      set vault_signoz_api_key, and redeploy the gateway.
  //   2. unreachable -- the gateway cannot reach the SigNoz query API
  //      over the tailnet; check IRCFIBER_SIGNOZ_URL/HOST and the
  //      tailnet route from the VPS.
  $effect(() => {
    const err = $logsError;
    if (!err) return;
    const lower = err.toLowerCase();
    if (lower.includes('api key') || lower.includes('401')) {
      toastError(
        'SigNoz rejected the API key - mint one in SigNoz Settings and redeploy the gateway',
        6000,
      );
    } else if (lower.includes('unreachable')) {
      toastError(
        'SigNoz unreachable from the gateway - check IRCFIBER_SIGNOZ_* env and tailnet',
        6000,
      );
    }
  });

  // --- Row click -> drawer toggle -------------------------------------
  // LogTable calls onToggle(id, rect) on every click. We look the row
  // back up from the store (so the drawer has the latest snapshot,
  // not a stale closure capture) and flip expandedRowIds so the row's
  // highlight ring stays in sync with the drawer's open/close state.
  function onToggleRow(rowId: string, anchorRect: DOMRect | null): void {
    const rows = $logs?.results ?? [];
    const found = rows.find((r) => getRowId(r) === rowId);
    if (found && !$logs?.expandedRowIds?.has(rowId)) {
      drawerRow = found;
      drawerAnchor = anchorRect;
    } else {
      drawerRow = null;
      drawerAnchor = null;
    }
    toggleExpandedRow(rowId);
  }

  function closeDrawer(): void {
    drawerRow = null;
    drawerAnchor = null;
  }

  // --- Save view commit ----------------------------------------------
  // saveView is idempotent by name (savedViews.ts): same name = update
  // in place + bumped updatedAt, not a duplicate entry.
  function onSaveViewClick(): void {
    const name = saveViewName.trim();
    if (!name || !$logs) return;
    // LogsViewSnapshot includes the timeRange alongside query/services/
    // severities -- the snapshot is self-contained so it round-trips
    // through localStorage without losing the operator's time window.
    saveView(
      name,
      {
        query: $logs.query,
        services: [...($logs.services ?? [])],
        severities: [...($logs.severities ?? [])],
        timeRange: { ...$logs.timeRange },
      },
      { ...$logs.timeRange },
    );
    saveViewName = '';
    saveViewOpen = false;
  }

  // --- Load view commit ----------------------------------------------
  // Applies a saved SavedView's snapshot to the live logsStore. Wired
  // to the <select data-testid="view-dropdown"> onchange handler below.
  //
  // Service / severity application is toggle-style because the store's
  // setService/setSeverity are toggle mutators -- we reset to a known
  // baseline first, then toggle each saved value on. For services the
  // baseline is `[]` (setService(null) clears); for severities the
  // baseline is DEFAULT_SEVERITIES (setSeverity(null) resets), so we
  // diff the desired set against the current set and toggle only the
  // values that need to change. Otherwise a saved view of ['FATAL']
  // would leave WARN/ERROR in the filter alongside FATAL.
  function onLoadViewChange(id: string): void {
    if (!id) return;
    let v: ReturnType<typeof loadView>;
    try {
      v = loadView(id);
    } catch {
      return;
    }
    cancelQuery();
    setQuery(v.query?.query ?? '');
    setService(null);
    for (const svc of v.query?.services ?? []) setService(svc);
    const currentSev = new Set(get(logs).severities);
    const desiredSev = new Set(v.query?.severities ?? []);
    for (const sev of currentSev) {
      if (!desiredSev.has(sev)) setSeverity(sev);
    }
    for (const sev of desiredSev) {
      if (!currentSev.has(sev)) setSeverity(sev);
    }
    if (v.timeRange) setTimeRange(v.timeRange as TimeRange);
    // Manual kick so the operator gets immediate UI feedback even
    // though the setters already scheduled a debounced refetch.
    void runQuery();
  }

  // --- Keyboard shortcuts --------------------------------------------
  //   ?  -- open the FilterCheatsheet
  //   /  -- focus the toolbar query input
  //   Esc-- close drawer first, then cheatsheet
  // Skipped while typing in an input/textarea/select so the keystrokes
  // never hijack the user's actual typing.
  function onKeydown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const inEditable =
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      target?.isContentEditable === true;
    if (e.key === '?' && !inEditable) {
      e.preventDefault();
      cheatsheetOpen = true;
    } else if (e.key === 'Escape') {
      if (drawerRow) {
        closeDrawer();
      } else if (cheatsheetOpen) {
        cheatsheetOpen = false;
      } else {
        // Clear the query input when it has focus and is non-empty. The
        // LogsToolbar $effect mirrors the store back to the input value,
        // so setQuery('') is enough -- no manual DOM mutation needed.
        const queryInput = document.querySelector<HTMLInputElement>(
          '[data-testid="logs-query-input"]',
        );
        if (
          queryInput &&
          document.activeElement === queryInput &&
          ($logs?.query ?? '') !== ''
        ) {
          e.preventDefault();
          setQuery('');
        }
      }
    } else if (e.key === '/' && !inEditable) {
      e.preventDefault();
      const queryInput = document.querySelector<HTMLInputElement>(
        '[data-testid="logs-query-input"]',
      );
      queryInput?.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col" data-testid="logs-page">
  <PageHeader title="Logs (SigNoz)" subtitle="Aggregated via OpenTelemetry - stored in ClickHouse">
    {#snippet actions()}
      <a
        href={TAILNET_SIGNOZ_LOGS_URL}
        target="_blank"
        rel="noopener"
        data-testid="open-signoz-link"
        class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium text-text hover:bg-border/40"
      >
        Open SigNoz
      </a>
    {/snippet}
  </PageHeader>

  <div class="flex items-center gap-2 border-b border-border bg-surface px-4 py-2 text-xs text-muted">
    <span>Tailnet fallback:</span>
    <a
      href={TAILNET_SIGNOZ_URL}
      target="_blank"
      rel="noopener"
      data-testid="tailnet-fallback-link"
      class="text-accent underline"
    >
      {TAILNET_SIGNOZ_URL}
    </a>
  </div>

  <div class="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
    <label class="text-xs text-muted" for="logs-view-dropdown">View:</label>
    <select
      id="logs-view-dropdown"
      data-testid="view-dropdown"
      onchange={(e) => {
        // Load path materializes the selected SavedView into the live
        // logsStore (query/services/severities/timeRange) and kicks a
        // refetch. The select is reset to its placeholder afterward so
        // re-picking the same view re-applies its state.
        const select = e.currentTarget as HTMLSelectElement;
        const id = select.value;
        if (!id) return;
        onLoadViewChange(id);
        select.value = '';
      }}
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
    >
      <option value="">-- Load view --</option>
      {#each $views as v (v.id)}
        <option value={v.id}>{v.name}</option>
      {/each}
    </select>

    {#if saveViewOpen}
      <input
        bind:value={saveViewName}
        placeholder="Name this view"
        data-testid="save-view-input"
        aria-label="Save view name"
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
      />
      <button
        type="button"
        onclick={onSaveViewClick}
        data-testid="save-view-confirm"
        class="rounded bg-accent px-2 py-1 text-xs text-bg"
      >
        Save
      </button>
      <button
        type="button"
        onclick={() => {
          saveViewOpen = false;
          saveViewName = '';
        }}
        data-testid="save-view-cancel"
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text hover:bg-border/40"
      >
        Cancel
      </button>
    {:else}
      <button
        type="button"
        onclick={() => {
          saveViewOpen = true;
        }}
        data-testid="save-view-toggle"
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text hover:bg-border/40"
      >
        Save view
      </button>
    {/if}
  </div>

  <LogsToolbar />

  <div class="flex-1 overflow-hidden">
    <Card>
      {#if $logsLoading && ($logs?.results?.length ?? 0) === 0}
        <div class="flex flex-col gap-1 p-2" data-testid="logs-skeleton">
          {#each Array(8) as _, i (i)}
            <div class="h-8 animate-pulse rounded bg-surface-2"></div>
          {/each}
        </div>
      {:else if $logsError}
        <div
          class="flex flex-col items-center gap-2 p-6 text-center"
          data-testid="logs-error-state"
        >
          <p class="text-sm text-danger" data-testid="logs-error-message">{$logsError}</p>
          <button
            type="button"
            onclick={() => {
              void runQuery();
            }}
            data-testid="logs-error-retry"
            class="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-border/40"
          >
            Retry
          </button>
        </div>
      {:else if ($logs?.results?.length ?? 0) === 0}
        <EmptyState
          title="No logs in window"
          description="Try widening the time range or removing filters."
        >
          {#snippet children()}
            <button
              type="button"
              onclick={() => resetFilters()}
              data-testid="reset-filters"
              class="rounded border border-border bg-surface-2 px-3 py-1.5 text-xs text-text hover:bg-border/40"
            >
              Reset filters
            </button>
          {/snippet}
        </EmptyState>
      {:else}
        <LogTable
          rows={$logs?.results ?? []}
          expandedIds={$logs?.expandedRowIds ?? new Set<string>()}
          onToggle={onToggleRow}
        />
      {/if}
    </Card>
  </div>
</div>

<JsonDrawer row={drawerRow} anchorRect={drawerAnchor} onClose={closeDrawer} />
<FilterCheatsheet bind:open={cheatsheetOpen} />