<!--
  LogsToolbar -- query bar + service multi-select + severity chips + time
  picker + live toggle + copy-as-cURL export.

  Layout (left -> right):
    [query input]  [time picker presets + custom]  [Live toggle]  [Copy cURL]
    [severity chips row]
    [services multi-select + active service chips]

  When `logsLive === true`:
    - The time-range presets are hidden, replaced with a "Live · <since>" pill
    - A connection-status badge appears (Live / Reconnecting / Disconnected)
      driven by `wsReady` + `wsLastAttemptAt` (driven by w3-t1, the WS task)
    - A "Stop live" button flips `logsLive` off
    - The custom datetime form is hidden (irrelevant while streaming)

  Controlled / uncontrolled mix: local state (queryText, customStart/End,
  servicesLoaded) is the source of truth for *input* ergonomics; the store
  (logsStore) is the source of truth for the *committed* query. Query input
  is debounced 200ms before calling setQuery, matching logsStore's own
  debounce so a single keystroke burst collapses to one refetch.

  Security note (cURL export): the command omits any Authorization /
  SIGNOZ-API-KEY header. The browser never sees the SigNoz key -- the
  gateway holds it server-side (see backend/source/ircfiber/web/admin/logs.d).
  Any change that adds a header here is a security regression.
-->
<script lang="ts">
  import {
    logs,
    logsLoading,
    logsError,
    logsLive,
    wsReady,
    wsLastAttemptAt,
    setQuery,
    setService,
    setSeverity,
    setTimeRange,
    toggleLive,
    resetFilters,
    runQuery,
  } from '../../stores/logsStore';
  import type { TimeRange } from '../../stores/logsStore';
  import {
    startLiveTail,
    stopLiveTail,
    liveTailStatus,
    liveTailAttempt,
    liveTailError,
  } from '../../stores/logsLiveTail';
  import { toastError } from '../../stores/ui';
  import { relative } from '../../lib/format';

  // --- Local UI state ----------------------------------------------------
  // Mirrored from `$logs.query` on store change so external mutations
  // (e.g. resetFilters(), savedView load) update the input. setQuery()
  // is the debounced sink; typing only flips `queryText` and waits.
  let queryText = $state('');
  let servicesOpen = $state(false);
  // Service options are derived from the loaded rows: the installed
  // SigNoz (v0.138) has no services catalogue endpoint, so the
  // dropdown lists the distinct service names seen in the current
  // result set (alpha-sorted). Active filter values are unioned in so
  // a selected service never vanishes when a new query returns no
  // rows for it.
  let serviceNames = $derived.by(() => {
    const seen = new Set<string>();
    for (const r of $logs?.results ?? []) {
      if (r.service) seen.add(r.service);
    }
    for (const s of $logs?.services ?? []) seen.add(s);
    return [...seen].sort((a, b) => a.localeCompare(b));
  });
  let customRangeOpen = $state(false);
  let customStart = $state('');
  let customEnd = $state('');
  let copyState = $state<'idle' | 'copied'>('idle');
  // Tick `now` once a second while live mode is on so the "last attempt"
  // elapsed time stays fresh without a full second re-render cost in the
  // default (non-live) layout.
  let now = $state(Date.now());

  // --- Bind store -> local -----------------------------------------------
  // $logs is a store auto-subscription; reading it inside $effect tracks
  // the value. We only push store -> input, never input -> store, so the
  // input is "uncontrolled" until the user types (avoiding a feedback
  // loop with setQuery -> debounce -> runQuery).
  $effect(() => {
    queryText = $logs?.query ?? '';
  });

  // Tick "now" once a second while live mode is on.
  $effect(() => {
    if (!$logsLive) return;
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  // --- Query input (debounced) ------------------------------------------
  let queryDebounce: ReturnType<typeof setTimeout> | null = null;
  function onQueryInput(e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    queryText = v;
    if (queryDebounce) clearTimeout(queryDebounce);
    queryDebounce = setTimeout(() => {
      queryDebounce = null;
      setQuery(v);
    }, 200);
  }

  // --- Severity chips ---------------------------------------------------
  const SEVERITIES: ReadonlyArray<string> = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  function onSeverityClick(sev: string): void {
    setSeverity(sev);
  }

  // --- Services multi-select -------------------------------------------
  // The native <select multiple> approach is mandated by the plan
  // ("do_not_reinvestigate: dropdown UI library -- use native <select
  // multiple> + custom chip overlay"). Options are the derived
  // `serviceNames` above, so opening the dropdown is synchronous and
  // never fetches.
  function openServices(): void {
    servicesOpen = true;
  }

  function onServiceChange(e: Event): void {
    const sel = e.currentTarget as HTMLSelectElement;
    const selected = Array.from(sel.selectedOptions).map((o) => o.value);
    const current = $logs?.services ?? [];
    // Diff: remove services no longer in selected, add newly selected.
    // setService() is the toggle primitive, so calling it for each
    // diff element flips membership atomically. Order doesn't matter
    // because logsStore rebuilds the array via Set.
    for (const s of current) {
      if (!selected.includes(s)) setService(s);
    }
    for (const s of selected) {
      if (!current.includes(s)) setService(s);
    }
  }

  // --- Time-range picker -----------------------------------------------
  const PRESET_MINUTES: Record<TimeRange['label'], number> = {
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '3h': 180,
    '24h': 1440,
    'custom': 0, // never used via the preset path; custom uses onCustomSubmit
  };
  function setPreset(label: TimeRange['label']): void {
    if (label === 'custom') {
      // Toggling the form is the only thing the 'custom' preset does
      // when triggered from a button -- the actual time range is set
      // when the user submits the form.
      customRangeOpen = !customRangeOpen;
      return;
    }
    const minutes = PRESET_MINUTES[label];
    const end = Date.now();
    const start = end - minutes * 60_000;
    setTimeRange({ label, start, end });
    customRangeOpen = false;
  }
  function onCustomSubmit(e: SubmitEvent): void {
    e.preventDefault();
    if (!customStart || !customEnd) return;
    const start = new Date(customStart).getTime();
    const end = new Date(customEnd).getTime();
    if (!isFinite(start) || !isFinite(end) || end <= start) return;
    setTimeRange({ label: 'custom', start, end });
    customRangeOpen = false;
  }

  // --- Live toggle ------------------------------------------------------
  function onLiveToggle(): void {
    toggleLive();
  }

  // --- Live toggle wire-up ----------------------------------------------
  // Connect the toolbar's `logsLive` flag to the polling tail lifecycle:
  // `startLiveTail()` snapshots the current filter and polls the gateway
  // proxy every 5s, `stopLiveTail()` clears the interval. The `wasLive` flag tracks
  // the previous value so we only fire on transitions (not on every
  // reactive read of the store -- which would be a no-op anyway, but
  // would still call into the WS layer spuriously on mount).
  let wasLive = false;
  $effect(() => {
    const live = $logsLive;
    if (live && !wasLive) {
      // Best-effort snapshot of the current filter. The live-tail
      // backend may ignore any fields it does not understand; only
      // `query / services / severities / timeRange` are forwarded.
      const state = $logs;
      const filter = state
        ? {
            query: state.query,
            services: state.services,
            severities: state.severities,
            timeRange: state.timeRange,
          }
        : undefined;
      startLiveTail(filter);
    } else if (!live && wasLive) {
      stopLiveTail();
    }
    wasLive = live;
  });

  // Auto-toggle off + toast on permanent failure. When the polling
  // tail hits MAX_ATTEMPTS and flips status to 'closed', we surface the
  // error to the operator and pull the switch back. The wire-up effect
  // above will then call `stopLiveTail()` as a cascade of `toggleLive()`
  // flipping `logsLive` to false.
  $effect(() => {
    const status = $liveTailStatus;
    if (status === 'closed' && $logsLive) {
      toggleLive();
      toastError($liveTailError ?? 'Live tail unavailable', 6000);
    }
  });

  // --- Copy as cURL -----------------------------------------------------
  // SECURITY: This command intentionally has NO Authorization /
  // x-api-key / SIGNOZ-API-KEY header. The browser never sees the
  // SigNoz key -- the gateway holds it server-side.
  // NOTE: the pasted command replays against the gateway proxy, which
  // requires the admin session cookie. Run it with the browser's cookies
  // (e.g. via DevTools "copy as cURL" on a live request) or add
  // --cookie with a valid admin session.
  // The single-quote escaping (\\' -> \') is sufficient for the JSON
  // payload we produce because JSON.stringify wraps all keys/strings
  // in double quotes -- the only way a single quote can land inside
  // the body is via the user's query string, and we already escape
  // that in logsStore's escapeFilterString. Belt-and-suspenders here
  // in case future filter formats change.
  function buildCurl(): string {
    const body = ($logs?.lastQueryBody ?? {}) as unknown;
    const url = new URL('/api/admin/logs/query_range', location.origin).href;
    const json = JSON.stringify(body).replace(/'/g, "\\'");
    return [
      `curl -sS -X POST '${url}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${json}'`,
    ].join('\n');
  }

  async function writeClipboard(text: string): Promise<boolean> {
    // Prefer the modern async Clipboard API. Fall back to a hidden
    // textarea + execCommand in test / older-browser environments.
    // Never throw -- a copy failure is a non-fatal UI gesture.
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to the textarea path
    }
    try {
      if (typeof document === 'undefined') return false;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        const ok = document.execCommand('copy');
        return ok;
      } finally {
        document.body.removeChild(ta);
      }
    } catch {
      return false;
    }
  }

  async function onCopyCurl(): Promise<void> {
    const cmd = buildCurl();
    try {
      await writeClipboard(cmd);
      copyState = 'copied';
      setTimeout(() => {
        copyState = 'idle';
      }, 1500);
    } catch (e) {
      // Swallow -- the toolbar should never throw from a UI gesture.
      // We don't pop a toast because "Copy as cURL" is best-effort;
      // the operator can always re-paste the command from the response
      // body in the dev tools.
      // eslint-disable-next-line no-console
      console.error('Copy as cURL failed:', e);
    }
  }
</script>

<div
  class="flex flex-col gap-3 border-b border-border bg-surface p-4"
  data-testid="logs-toolbar"
>
  <!-- Row 1: query input + time picker + live + copy cURL -->
  <div class="flex items-center gap-2">
    <input
      type="search"
      value={queryText}
      oninput={onQueryInput}
      placeholder="severity_text = 'ERROR' AND body CONTAINS '...'"
      aria-label="Query"
      data-testid="logs-query-input"
      class="flex-1 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-text focus:ring-1 focus:ring-primary focus:outline-none"
    />

    {#if $logsLive}
      <span
        class="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary"
        data-testid="logs-live-since"
      >
        Live &middot; since {relative($logs?.timeRange?.start, now)}
      </span>
    {:else}
      {#each ['5m', '15m', '1h', '3h', '24h'] as preset}
        <button
          type="button"
          onclick={() => setPreset(preset as TimeRange['label'])}
          class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-muted hover:bg-border/40"
          class:text-text={$logs?.timeRange?.label === preset}
          class:font-semibold={$logs?.timeRange?.label === preset}
          data-testid="logs-preset-{preset}"
        >{preset}</button>
      {/each}
      <button
        type="button"
        onclick={() => setPreset('custom')}
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs hover:bg-border/40"
        class:text-text={$logs?.timeRange?.label === 'custom'}
        class:text-muted={$logs?.timeRange?.label !== 'custom'}
        class:font-semibold={$logs?.timeRange?.label === 'custom'}
        data-testid="logs-preset-custom"
        aria-label="Custom time range"
      >&hellip;</button>
    {/if}

    <button
      type="button"
      onclick={onLiveToggle}
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
      class:text-primary={$logsLive}
      class:text-muted={!$logsLive}
      data-testid="logs-live-toggle"
    >{$logsLive ? '\u25CF Live' : '\u25CB Live off'}</button>

    <button
      type="button"
      onclick={onCopyCurl}
      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text hover:bg-border/40 disabled:opacity-50"
      disabled={copyState === 'copied'}
      data-testid="logs-copy-curl"
    >{copyState === 'copied' ? '\u2713 Copied' : 'Copy as cURL'}</button>
  </div>

  <!-- Row 2: severity chips -->
  <div class="flex items-center gap-2 text-xs" data-testid="logs-severity-row">
    <span class="text-muted">Severity:</span>
    {#each SEVERITIES as sev}
      {@const active = ($logs?.severities ?? []).includes(sev)}
      <button
        type="button"
        onclick={() => onSeverityClick(sev)}
        aria-pressed={active}
        class="rounded-full border px-2 py-0.5 transition-colors"
        class:bg-primary={active}
        class:text-bg={active}
        class:border-primary={active}
        class:border-border={!active}
        class:text-muted={!active}
        data-testid="logs-severity-{sev}"
      >{sev}</button>
    {/each}
    {#if $logsLoading}
      <span class="text-muted" data-testid="logs-loading-pill">Loading&hellip;</span>
    {/if}
    {#if $logsError}
      <span class="rounded-full bg-danger/10 px-2 py-0.5 text-danger" data-testid="logs-error-pill">
        {$logsError}
      </span>
    {/if}
  </div>

  <!-- Row 3: services multi-select + active service chips -->
  <div class="flex items-center gap-2 text-xs" data-testid="logs-services-row">
    <span class="text-muted">Services:</span>
    <select
      multiple
      size="4"
      onclick={openServices}
      onchange={onServiceChange}
      aria-label="Services"
      data-testid="logs-services-select"
      class="max-w-xs rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text"
    >
      {#each serviceNames as name}
        <option value={name} selected={($logs?.services ?? []).includes(name)}>
          {name}
        </option>
      {/each}
    </select>
    {#if ($logs?.services ?? []).length > 0}
      <div class="flex flex-wrap gap-1" data-testid="logs-services-active">
        {#each $logs.services as svc}
          <span class="rounded bg-primary/20 px-2 py-0.5 text-xs text-primary">
            {svc}
          </span>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Row 4 (live only): status pill + stop live -->
  {#if $logsLive}
    <div class="flex items-center gap-2 text-xs" data-testid="logs-live-row">
      <span
        class="rounded-full border px-2 py-0.5"
        class:border-success={$wsReady === 'open'}
        class:text-success={$wsReady === 'open'}
        class:border-warn={$wsReady === 'reconnecting'}
        class:text-warn={$wsReady === 'reconnecting'}
        class:border-danger={$wsReady === 'closed'}
        class:text-danger={$wsReady === 'closed'}
        data-testid="live-status-pill"
      >
        {#if $wsReady === 'open'}
          Live
        {:else if $wsReady === 'reconnecting'}
          Reconnecting... (attempt {$liveTailAttempt})
        {:else if $wsReady === 'closed'}
          Live unavailable
        {/if}
      </span>
      <button
        type="button"
        onclick={onLiveToggle}
        class="text-xs text-muted hover:underline"
        data-testid="logs-stop-live"
      >Stop live</button>
    </div>
  {/if}

  <!-- Row 5 (custom range, only when not live and form is open) -->
  {#if customRangeOpen && !$logsLive}
    <form
      onsubmit={onCustomSubmit}
      class="flex items-center gap-2 text-xs"
      data-testid="logs-custom-form"
    >
      <input
        type="datetime-local"
        bind:value={customStart}
        aria-label="Start time"
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
      />
      <span class="text-muted">to</span>
      <input
        type="datetime-local"
        bind:value={customEnd}
        aria-label="End time"
        class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text"
      />
      <button
        type="submit"
        class="rounded bg-primary px-3 py-1 text-xs text-bg"
        data-testid="logs-custom-apply"
      >Apply</button>
    </form>
  {/if}
</div>
