<script lang="ts">
  /**
   * System page — the sysadmin view of the host this gateway runs on:
   * CPU / memory / disk / network KPIs with 5-minute sparklines, the real
   * filesystems, per-interface throughput, host disk I/O, and every Docker
   * container with its CPU/memory, a log tail and Start / Stop / Restart.
   *
   * Backed by /api/admin/system (collected in-process from /host/proc,
   * /host/sys, /host/root and the Docker socket — see
   * site/backend/source/ircfiber/sysmetrics.d). Those mounts only exist on
   * the admin-serving replicas, so a gateway without them renders the
   * "host /proc is not mounted" banner instead of fake zeroes.
   *
   * The in-page history is a 5-minute ring that resets on every blue/green
   * swap; durable trends live in SigNoz (linked in the header).
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import RefreshIndicator from '../components/RefreshIndicator.svelte';
  import { ApiError } from '../lib/api-client';
  import { bytes, duration, percent, truncate } from '../lib/format';
  import { TAILNET_SIGNOZ_URL } from '../lib/signozUrl';
  import { startPolling } from '../stores/polling';
  import { toastSuccess, toastError } from '../stores/ui';
  import {
    system, systemLoading, systemError,
    fetchSystem, containerAction, containerLogs,
    type ContainerActionName, type SystemContainer,
  } from '../stores/system';

  /** Restarting any of these disconnects IRC users or takes the site down,
   *  so their confirmation demands the container name typed out. */
  const CRITICAL = [
    'ircfiber-ircd', 'ircfiber-services', 'ircfiber-mongo',
    'ircfiber-redis', 'ircfiber-caddy', 'ircfiber-holder-ovh',
  ];

  let lastFetchedAt = $state<number | null>(null);
  let stop: (() => void) | null = null;

  onMount(() => {
    stop = startPolling(async () => {
      await fetchSystem(true);
      lastFetchedAt = Date.now();
    });
  });
  onDestroy(() => stop?.());

  // Filters (page-local, no store)
  let filter = $state('');
  let runningOnly = $state(false);

  // Pending state change awaiting confirmation
  type Ask = { action: ContainerActionName; name: string };
  let ask = $state<Ask | null>(null);

  // Log drawer
  let logsFor = $state<string | null>(null);
  let logsText = $state('');
  let logsTail = $state(200);
  let logsLoading = $state(false);
  let logsError = $state<string | null>(null);

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  /** Shared severity ramp for every percentage on the page. */
  function tone(pct: number): 'default' | 'warn' | 'danger' {
    return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'default';
  }
  function barClass(pct: number): string {
    return pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warn' : 'bg-success';
  }

  function stateTone(c: SystemContainer): 'success' | 'warn' | 'danger' | 'muted' {
    if (c.state === 'running') {
      if (c.health === 'unhealthy') return 'danger';
      if (c.health === 'starting') return 'warn';
      return 'success';
    }
    if (c.state === 'restarting' || c.state === 'created' || c.state === 'paused') return 'warn';
    if (c.state === 'exited' || c.state === 'dead') return 'danger';
    return 'muted';
  }

  const rootFs = $derived($system?.filesystems.find((f) => f.mountPoint === '/') ?? null);
  const netRx = $derived(($system?.network ?? []).reduce((a, n) => a + n.rxBytesPerSec, 0));
  const netTx = $derived(($system?.network ?? []).reduce((a, n) => a + n.txBytesPerSec, 0));
  const history = $derived($system?.history ?? []);

  const rows = $derived.by(() => {
    const all = $system?.containers ?? [];
    const q = filter.trim().toLowerCase();
    return all
      .filter((c) => !runningOnly || c.state === 'running')
      .filter((c) => q === ''
        || c.name.toLowerCase().includes(q)
        || c.image.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const ra = a.state === 'running' ? 0 : 1;
        const rb = b.state === 'running' ? 0 : 1;
        return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
      });
  });

  function confirmAction(c: SystemContainer, action: ContainerActionName) {
    if (!c.controllable) return;
    ask = { action, name: c.name };
  }

  async function doAction() {
    if (!ask) return;
    const { action, name } = ask;
    try {
      await containerAction(name, action);
      ask = null;
      toastSuccess(`${action} ${name} accepted`);
      await fetchSystem(true);
      lastFetchedAt = Date.now();
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  async function openLogs(name: string) {
    logsFor = name;
    logsText = '';
    await loadLogs();
  }

  async function loadLogs() {
    if (!logsFor) return;
    logsLoading = true;
    logsError = null;
    try {
      logsText = await containerLogs(logsFor, logsTail);
    } catch (e) {
      logsError = errMsg(e);
    } finally {
      logsLoading = false;
    }
  }

  async function setTail(n: number) {
    logsTail = n;
    await loadLogs();
  }
</script>

<PageHeader title="System" subtitle="Host resources and Docker containers">
  {#snippet actions()}
    <RefreshIndicator {lastFetchedAt} loading={$systemLoading} />
    <a
      href={TAILNET_SIGNOZ_URL}
      target="_blank"
      rel="noopener"
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text hover:border-primary/40"
      title="In-page history is the last 5 minutes only; SigNoz keeps 30 days of hostmetrics"
    >SigNoz ↗</a>
  {/snippet}
</PageHeader>

{#if $systemError}
  <Card class="mb-6">
    <p class="text-sm text-danger">{$systemError}</p>
  </Card>
{/if}

{#if !$system || $system.collectedAtMs === 0}
  <!-- The collector starts on the first request, so exactly one poll sees
       an empty snapshot before data lands. -->
  <Card class="mb-6">
    <p class="text-sm text-muted">Collecting the first sample…</p>
  </Card>
{:else if !$system.available}
  <Card title="Host metrics unavailable" class="mb-6">
    <p class="text-sm text-warn">{$system.reason}</p>
  </Card>
{:else}
  <div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
    <KpiCard
      label="CPU"
      value={`${$system.cpu.percent.toFixed(0)}%`}
      tone={tone($system.cpu.percent)}
      hint={`load ${$system.cpu.load1.toFixed(2)} · ${$system.host.ncpu} vCPU`}
      icon="🧮"
    />
    <KpiCard
      label="Memory"
      value={`${bytes($system.memory.usedBytes)} / ${bytes($system.memory.totalBytes)}`}
      tone={tone($system.memory.percent)}
      hint={percent($system.memory.usedBytes, $system.memory.totalBytes)}
      icon="🧠"
    />
    <KpiCard
      label="Disk /"
      value={rootFs ? percent(rootFs.usedBytes, rootFs.totalBytes) : '—'}
      tone={tone(rootFs?.percent ?? 0)}
      hint={rootFs ? `${bytes(rootFs.freeBytes)} free` : 'no root filesystem row'}
      icon="💽"
    />
    <KpiCard
      label="Network"
      value={`↓ ${bytes(netRx)}/s ↑ ${bytes(netTx)}/s`}
      hint={`${$system.network.length} interface${$system.network.length === 1 ? '' : 's'}`}
      icon="🌐"
    />
  </div>

  <p class="mb-6 text-xs text-muted">
    {$system.host.hostname || 'unknown host'} · {$system.host.os || 'unknown OS'} ·
    kernel {$system.host.kernel || '—'} · Docker {$system.host.dockerVersion || '—'} ·
    up {duration($system.host.uptimeSeconds * 1000)} ·
    {$system.cpu.procsRunnable}/{$system.cpu.procsTotal} procs runnable
    {#if $system.memory.swapTotalBytes > 0}
      · swap {bytes($system.memory.swapUsedBytes)} / {bytes($system.memory.swapTotalBytes)}
    {/if}
  </p>

  <Card title="Trend" subtitle="Last 5 minutes" class="mb-6">
    {#if history.length < 2}
      <p class="text-sm text-muted">Collecting samples — the trend fills in over the first minute.</p>
    {:else}
      <div class="grid gap-4 md:grid-cols-3">
        <div>
          <div class="mb-1 flex items-baseline justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted">CPU</span>
            <span class="text-sm font-semibold text-heading">{$system.cpu.percent.toFixed(0)}%</span>
          </div>
          <div class="text-primary">
            <Sparkline values={history.map((h) => h.cpuPercent)} width={240} height={40} strokeWidth={2} />
          </div>
        </div>
        <div>
          <div class="mb-1 flex items-baseline justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted">Memory</span>
            <span class="text-sm font-semibold text-heading">{$system.memory.percent.toFixed(0)}%</span>
          </div>
          <div class="text-info">
            <Sparkline values={history.map((h) => h.memPercent)} width={240} height={40} strokeWidth={2} />
          </div>
        </div>
        <div>
          <div class="mb-1 flex items-baseline justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-muted">Network</span>
            <span class="text-sm font-semibold text-heading">{bytes(netRx + netTx)}/s</span>
          </div>
          <div class="text-success">
            <Sparkline
              values={history.map((h) => h.rxBytesPerSec + h.txBytesPerSec)}
              width={240} height={40} strokeWidth={2}
            />
          </div>
        </div>
      </div>
    {/if}
  </Card>

  <Card title="Filesystems" class="mb-6">
    {#if $system.filesystems.length === 0}
      <p class="text-sm text-muted">No real filesystems reported (every mount was an overlay or pseudo-fs).</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm" data-testid="filesystems-table">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4 text-left">Device</th>
              <th class="py-2 pr-4 text-left">Mount</th>
              <th class="py-2 pr-4 text-left">Type</th>
              <th class="py-2 pr-4 text-left">Size</th>
              <th class="py-2 pr-4 text-left">Used</th>
              <th class="py-2 pr-4 text-left">Free</th>
              <th class="py-2 text-left">Usage</th>
            </tr>
          </thead>
          <tbody>
            {#each $system.filesystems as f (f.mountPoint)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono text-xs">{f.device}</td>
                <td class="py-2 pr-4 font-mono">{f.mountPoint}</td>
                <td class="py-2 pr-4 text-muted">{f.fsType}</td>
                <td class="py-2 pr-4 font-mono">{bytes(f.totalBytes)}</td>
                <td class="py-2 pr-4 font-mono">{bytes(f.usedBytes)}</td>
                <td class="py-2 pr-4 font-mono">{bytes(f.freeBytes)}</td>
                <td class="py-2">
                  <div class="flex items-center gap-2">
                    <div class="h-1.5 w-24 rounded bg-surface-2">
                      <div class="h-1.5 rounded {barClass(f.percent)}" style="width:{Math.min(100, f.percent)}%"></div>
                    </div>
                    <span class="font-mono text-xs">{f.percent.toFixed(0)}%</span>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <Card
    title="Network"
    subtitle={$system.networkSource === 'container'
      ? 'Counters are this gateway container’s own namespace, not the host’s — the /host/proc/1/net/dev read fell back.'
      : undefined}
    class="mb-6"
  >
    {#if $system.network.length === 0}
      <EmptyState title="No interfaces" description="Every interface was loopback or a docker bridge." icon="🌐" />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4 text-left">Interface</th>
              <th class="py-2 pr-4 text-left">↓/s</th>
              <th class="py-2 pr-4 text-left">↑/s</th>
              <th class="py-2 pr-4 text-left">rx total</th>
              <th class="py-2 pr-4 text-left">tx total</th>
              <th class="py-2 pr-4 text-left">Errors</th>
              <th class="py-2 text-left">Dropped</th>
            </tr>
          </thead>
          <tbody>
            {#each $system.network as n (n.name)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono">{n.name}</td>
                <td class="py-2 pr-4 font-mono">{bytes(n.rxBytesPerSec)}</td>
                <td class="py-2 pr-4 font-mono">{bytes(n.txBytesPerSec)}</td>
                <td class="py-2 pr-4 font-mono text-muted">{bytes(n.rxBytes)}</td>
                <td class="py-2 pr-4 font-mono text-muted">{bytes(n.txBytes)}</td>
                <td class="py-2 pr-4 font-mono {n.rxErrors + n.txErrors > 0 ? 'text-warn' : 'text-muted'}">
                  {n.rxErrors} / {n.txErrors}
                </td>
                <td class="py-2 font-mono {n.rxDropped + n.txDropped > 0 ? 'text-warn' : 'text-muted'}">
                  {n.rxDropped} / {n.txDropped}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  {#if $system.disks.length > 0}
    <Card title="Disk I/O" class="mb-6">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4 text-left">Device</th>
              <th class="py-2 pr-4 text-left">Read/s</th>
              <th class="py-2 pr-4 text-left">Write/s</th>
              <th class="py-2 pr-4 text-left">Reads/s</th>
              <th class="py-2 text-left">Writes/s</th>
            </tr>
          </thead>
          <tbody>
            {#each $system.disks as d (d.name)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono">{d.name}</td>
                <td class="py-2 pr-4 font-mono">{bytes(d.readBytesPerSec)}</td>
                <td class="py-2 pr-4 font-mono">{bytes(d.writeBytesPerSec)}</td>
                <td class="py-2 pr-4 font-mono text-muted">{d.readsPerSec.toFixed(1)}</td>
                <td class="py-2 font-mono text-muted">{d.writesPerSec.toFixed(1)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}

  {#if $system.dockerError}
    <p class="mb-2 text-xs text-warn" data-testid="docker-error">
      Docker socket: {$system.dockerError}
    </p>
  {/if}

  <Card
    title="Containers"
    subtitle="{$system.host.containersRunning}/{$system.host.containersTotal} running{$system.statsSource === 'none' ? ' · per-container CPU/memory unavailable (no cgroup v2 files)' : ''}"
  >
    {#snippet actions()}
      <input
        type="text"
        bind:value={filter}
        placeholder="Filter name or image"
        aria-label="Filter containers"
        class="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs"
        autocomplete="off"
      />
      <label class="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" bind:checked={runningOnly} />
        Running only
      </label>
    {/snippet}

    {#if rows.length === 0}
      {#if $system.containers.length === 0 && !$system.dockerError}
        <EmptyState title="No containers" description="The Docker daemon reported an empty container list." icon="📦" />
      {:else}
        <p class="text-sm text-muted">No container matches the filter.</p>
      {/if}
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-sm" data-testid="containers-table">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4 text-left">State</th>
              <th class="py-2 pr-4 text-left">Name</th>
              <th class="py-2 pr-4 text-left">Image</th>
              <th class="py-2 pr-4 text-left">Status</th>
              <th class="py-2 pr-4 text-left">CPU</th>
              <th class="py-2 pr-4 text-left">Memory</th>
              <th class="py-2 pr-4 text-left">PIDs</th>
              <th class="py-2 pr-4 text-left">Ports</th>
              <th class="py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as c (c.name)}
              <tr class="border-b border-border/50 last:border-0" data-testid="container-row">
                <td class="py-2 pr-4">
                  <StatusBadge
                    label={c.health ? `${c.state} · ${c.health}` : c.state}
                    tone={stateTone(c)}
                    size="sm"
                  />
                </td>
                <td class="py-2 pr-4 font-mono">
                  {c.name}
                  {#if c.self}
                    <span class="ml-1 rounded bg-border px-1.5 py-0.5 text-[10px] font-semibold text-muted">self</span>
                  {/if}
                </td>
                <td class="py-2 pr-4 font-mono text-xs text-muted" title={c.image}>{truncate(c.image, 38)}</td>
                <td class="py-2 pr-4 text-xs text-muted">{c.status}</td>
                <td class="py-2 pr-4 font-mono">
                  {c.cpuPercent == null ? '—' : `${c.cpuPercent.toFixed(1)}%`}
                </td>
                <td class="py-2 pr-4">
                  {#if c.memBytes == null}
                    <span class="font-mono">—</span>
                  {:else}
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-xs">
                        {bytes(c.memBytes)}{c.memLimitBytes > 0 ? ` / ${bytes(c.memLimitBytes)}` : ''}
                      </span>
                      {#if c.memPercent != null}
                        <div class="h-1.5 w-16 rounded bg-surface-2">
                          <div class="h-1.5 rounded {barClass(c.memPercent)}" style="width:{Math.min(100, c.memPercent)}%"></div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </td>
                <td class="py-2 pr-4 font-mono text-muted">{c.pids == null ? '—' : c.pids}</td>
                <td class="py-2 pr-4 font-mono text-[11px] text-muted">
                  {c.ports.length > 0 ? c.ports.join(' ') : '—'}
                </td>
                <td class="py-2">
                  <div class="flex items-center gap-1.5">
                    {#if c.state === 'running'}
                      <button
                        type="button"
                        class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
                        disabled={!c.controllable}
                        title={c.controlReason}
                        aria-label={`Stop ${c.name}`}
                        onclick={() => confirmAction(c, 'stop')}
                      >Stop</button>
                      <button
                        type="button"
                        class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
                        disabled={!c.controllable}
                        title={c.controlReason}
                        aria-label={`Restart ${c.name}`}
                        onclick={() => confirmAction(c, 'restart')}
                      >Restart</button>
                    {:else}
                      <button
                        type="button"
                        class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
                        disabled={!c.controllable}
                        title={c.controlReason}
                        aria-label={`Start ${c.name}`}
                        onclick={() => confirmAction(c, 'start')}
                      >Start</button>
                    {/if}
                    <button
                      type="button"
                      class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border"
                      aria-label={`Logs for ${c.name}`}
                      onclick={() => openLogs(c.name)}
                    >Logs</button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
{/if}

{#if logsFor}
  <div
    class="fixed right-0 top-0 z-40 flex h-full w-full max-w-2xl flex-col border-l border-border bg-surface shadow-2xl"
    role="dialog"
    aria-modal="false"
    aria-label={`Logs for ${logsFor}`}
    data-testid="logs-drawer"
  >
    <div class="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
      <div class="min-w-0">
        <h2 class="truncate text-sm font-semibold text-heading">Logs · {logsFor}</h2>
        <p class="text-xs text-muted">stdout + stderr, timestamped, last {logsTail} lines</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#each [200, 1000, 2000] as n (n)}
          <button
            type="button"
            class="rounded-md border px-2 py-1 text-xs font-medium {logsTail === n ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-surface-2 text-text hover:bg-border'}"
            onclick={() => setTail(n)}
          >{n}</button>
        {/each}
        <button
          type="button"
          class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border"
          onclick={loadLogs}
        >Refresh</button>
        <button
          type="button"
          class="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text hover:bg-border"
          aria-label="Close logs"
          onclick={() => { logsFor = null; logsText = ''; logsError = null; }}
        >Close</button>
      </div>
    </div>
    <div class="flex-1 overflow-auto p-4">
      {#if logsLoading}
        <p class="text-sm text-muted">Reading…</p>
      {:else if logsError}
        <p class="text-sm text-danger">{logsError}</p>
      {:else if logsText.length === 0}
        <p class="text-sm text-muted">No output.</p>
      {:else}
        <pre class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text">{logsText}</pre>
      {/if}
    </div>
  </div>
{/if}

<ConfirmDialog
  open={ask !== null}
  title={ask ? `${ask.action[0].toUpperCase()}${ask.action.slice(1)} ${ask.name}?` : ''}
  message={ask
    ? (CRITICAL.includes(ask.name)
      ? `${ask.name} is load-bearing: a ${ask.action} disconnects IRC users or takes the site down. Type the container name to confirm.`
      : `${ask.action} container ${ask.name} on the host now?`)
    : ''}
  confirmLabel={ask ? `${ask.action[0].toUpperCase()}${ask.action.slice(1)}` : 'Confirm'}
  tone="danger"
  requireText={ask && CRITICAL.includes(ask.name) ? ask.name : undefined}
  onConfirm={doAction}
  onCancel={() => (ask = null)}
/>
