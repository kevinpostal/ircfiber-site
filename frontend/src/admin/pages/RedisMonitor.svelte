<script lang="ts">
  /**
   * Redis Monitor — INFO summary, key browser (SCAN), slowlog, pubsub.
   * Polls /api/admin/redis/summary every 5s. Key browser + slowlog are manual.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import {
    redisSummary, redisError, redisLoading,
    fetchRedisSummary, scanRedisKeys, fetchRedisKey, fetchSlowlog, fetchPubsubChannels, fetchClients,
    type KeyScan, type SlowLog,
  } from '../stores/redis';
  import { startPolling } from '../stores/polling';
  import { bytes, percent, duration, relative } from '../lib/format';

  let stop: (() => void) | null = null;
  let lastFetchedAt = $state<number | null>(null);

  // Memory time-series (sample every fetch for sparkline)
  let memoryHistory = $state<number[]>([]);
  let opsHistory = $state<number[]>([]);
  const MAX_HISTORY = 60;

  // Key browser state
  let match = $state('*');
  let scan = $state<KeyScan | null>(null);
  let scanning = $state(false);
  let cursor = $state('0');
  let selectedKey = $state<string | null>(null);
  let keyDetail = $state<any | null>(null);

  // Slowlog
  let slowlog = $state<SlowLog | null>(null);
  let loadingSlow = $state(false);

  // Pubsub
  let pubsubChannels = $state<string[]>([]);
  // Clients
  let clients = $state<any[]>([]);

  async function loadSummary() {
    await fetchRedisSummary();
    lastFetchedAt = Date.now();
    if ($redisSummary?.usedMemory != null) {
      memoryHistory = [...memoryHistory, $redisSummary.usedMemory].slice(-MAX_HISTORY);
    }
    if ($redisSummary?.opsPerSec != null) {
      opsHistory = [...opsHistory, $redisSummary.opsPerSec].slice(-MAX_HISTORY);
    }
  }

  async function doScan(resetCursor = true) {
    if (resetCursor) cursor = '0';
    scanning = true;
    const res = await scanRedisKeys({ cursor, match, count: 100 });
    scanning = false;
    if (res) { scan = res; cursor = res.cursor; }
  }

  async function openKey(key: string) {
    selectedKey = key;
    keyDetail = null;
    const res = await fetchRedisKey(key);
    if (res) keyDetail = res;
  }

  async function loadSlowlog() {
    loadingSlow = true;
    slowlog = await fetchSlowlog(50);
    loadingSlow = false;
  }

  async function loadPubsub() {
    const res = await fetchPubsubChannels('*');
    pubsubChannels = res?.channels ?? [];
  }

  async function loadClients() {
    const res = await fetchClients();
    clients = res?.clients ?? [];
  }

  onMount(() => {
    stop = startPolling(loadSummary, { intervalMs: 5_000 });
    loadSlowlog();
    loadPubsub();
    loadClients();
    doScan(true);
  });
  onDestroy(() => stop?.());
</script>

<PageHeader
  title="Redis Monitor"
  subtitle="Live INFO summary, SCAN-based key browser, SLOWLOG, pub/sub, client list"
>
  {#snippet actions()}
    <button onclick={() => { loadSummary(); doScan(true); loadSlowlog(); loadPubsub(); loadClients(); }} class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">
      Refresh all
    </button>
  {/snippet}
</PageHeader>

{#if $redisError}
  <Card class="mb-4">
    <div class="text-sm text-danger">{$redisError}</div>
  </Card>
{/if}

<!-- Summary KPIs -->
<div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
  <KpiCard
    label="Version"
    value={$redisSummary?.version ?? '—'}
    icon="🏷️"
    loading={$redisLoading && !$redisSummary}
  />
  <KpiCard
    label="Used Memory"
    value={$redisSummary?.usedMemoryHuman ?? '—'}
    tone="info"
    icon="💾"
  />
  <KpiCard
    label="Connected Clients"
    value={$redisSummary?.connectedClients ?? '—'}
    tone={($redisSummary?.connectedClients ?? 0) > 50 ? 'warn' : 'success'}
    icon="🔌"
  />
  <KpiCard
    label="Ops / sec"
    value={$redisSummary?.opsPerSec ?? '—'}
    tone="info"
    icon="⚡"
  />
</div>

<!-- Time-series row -->
<div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
  <Card title="Memory" subtitle="Last {memoryHistory.length} samples">
    <div class="flex items-center justify-between gap-3">
      <div class="text-2xl font-bold text-heading">{$redisSummary?.usedMemoryHuman ?? '—'}</div>
      <div class="text-info">
        <Sparkline values={memoryHistory} width={200} height={40} stroke="currentColor" strokeWidth={2} />
      </div>
    </div>
    <div class="mt-2 text-xs text-muted">Peak: {$redisSummary?.usedMemoryPeakHuman ?? '—'}</div>
  </Card>

  <Card title="Operations" subtitle="Commands processed / sec">
    <div class="flex items-center justify-between gap-3">
      <div class="text-2xl font-bold text-heading">{$redisSummary?.opsPerSec ?? '—'}</div>
      <div class="text-success">
        <Sparkline values={opsHistory} width={200} height={40} stroke="currentColor" strokeWidth={2} />
      </div>
    </div>
    <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-muted">
      <div>Total: {$redisSummary?.totalCommandsProcessed ?? '—'}</div>
      <div>Connections: {$redisSummary?.totalConnections ?? '—'}</div>
    </div>
  </Card>
</div>

<!-- Hit ratio + keyspace -->
<div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
  <Card title="Hit Ratio" subtitle="cache_hits / (cache_hits + cache_misses)">
    <div class="text-3xl font-bold {$redisSummary?.hitRatio != null && $redisSummary.hitRatio > 0.9 ? 'text-success' : $redisSummary?.hitRatio != null && $redisSummary.hitRatio > 0.7 ? 'text-warn' : 'text-danger'}">
      {$redisSummary?.hitRatio != null ? percent($redisSummary.hitRatio * 100, 100) : '—'}
    </div>
    <dl class="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
      <div><dt>Hits</dt><dd class="font-mono text-text">{$redisSummary?.keyspaceHits ?? '—'}</dd></div>
      <div><dt>Misses</dt><dd class="font-mono text-text">{$redisSummary?.keyspaceMisses ?? '—'}</dd></div>
    </dl>
  </Card>

  <Card title="Keyspace">
    {#if $redisSummary?.keyspace}
      <dl class="space-y-1 text-sm">
        {#each Object.entries($redisSummary.keyspace) as [db, info]}
          <div class="flex justify-between font-mono text-xs">
            <dt class="text-muted">{db}</dt>
            <dd class="text-text">{info}</dd>
          </div>
        {/each}
      </dl>
    {:else}
      <EmptyState icon="🗝️" title="No keyspace info" />
    {/if}
  </Card>
</div>

<!-- Key browser -->
<Card class="mb-6" title="Key Browser" subtitle="SCAN-based, no KEYS — safe for production">
  <div class="mb-3 flex items-center gap-2">
    <input
      type="text"
      bind:value={match}
      onkeydown={(e) => e.key === 'Enter' && doScan(true)}
      placeholder="MATCH pattern, e.g. irc:* or session:*"
      class="flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text placeholder-muted focus:border-primary focus:outline-none"
    />
    <button onclick={() => doScan(true)} disabled={scanning} class="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
      {scanning ? 'Scanning…' : 'Scan'}
    </button>
    {#if scan && cursor !== '0'}
      <button onclick={() => doScan(false)} disabled={scanning} class="rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-50">
        Next →
      </button>
    {/if}
  </div>

  {#if scan?.entries?.length}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">Key</th>
          <th class="py-2 text-left font-semibold">Type</th>
          <th class="py-2 text-right font-semibold">TTL</th>
          <th class="py-2 text-right font-semibold">Memory</th>
        </tr>
      </thead>
      <tbody>
        {#each scan.entries as entry (entry.key)}
          <tr class="border-b border-border/40 hover:bg-surface/40 cursor-pointer" onclick={() => openKey(entry.key)}>
            <td class="py-2 font-mono">{entry.key}</td>
            <td class="py-2"><StatusBadge label={entry.meta.type} tone="primary" size="sm" /></td>
            <td class="py-2 text-right font-mono text-muted">{entry.meta.ttl >= 0 ? `${entry.meta.ttl}s` : '—'}</td>
            <td class="py-2 text-right font-mono text-muted">{entry.meta.memory > 0 ? bytes(entry.meta.memory) : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="mt-2 text-xs text-muted">Cursor: <code class="font-mono">{cursor}</code> · {scan.entries.length} keys in this batch</div>
  {:else if scan}
    <EmptyState icon="🔍" title="No keys match" description={`Pattern "${match}" returned 0 results.`} />
  {/if}
</Card>

{#if keyDetail}
  <Card class="mb-6" title="Key: {selectedKey}" subtitle="{keyDetail.meta?.type} · TTL {keyDetail.meta?.ttl}s · {bytes(keyDetail.meta?.memory ?? 0)}">
    <pre class="max-h-64 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs text-text">{keyDetail.sample || '(empty)'}</pre>
  </Card>
{/if}

<!-- Slowlog + Pubsub + Clients -->
<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
  <Card title="SLOWLOG" subtitle="Top {slowlog?.entries?.length ?? 0} slow commands">
    {#snippet actions()}
      <button onclick={loadSlowlog} class="rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-medium text-text hover:border-primary/40">Reload</button>
    {/snippet}
    {#if loadingSlow}
      <div class="flex h-32 items-center justify-center"><div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div></div>
    {:else if !slowlog?.entries?.length}
      <EmptyState icon="🐇" title="No slow commands" />
    {:else}
      <ul class="space-y-2">
        {#each slowlog.entries as entry (entry.id)}
          <li class="border-l-2 border-warn pl-3 text-xs">
            <div class="font-mono text-text">{entry.command?.join(' ') ?? '(?)'}</div>
            <div class="text-muted">{entry.durationMicros}μs · {relative(entry.timestampMs ?? 0)}</div>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>

  <Card title="Pub/Sub Channels" subtitle="Active subscriptions">
    {#snippet actions()}
      <button onclick={loadPubsub} class="rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-medium text-text hover:border-primary/40">Reload</button>
    {/snippet}
    {#if pubsubChannels.length === 0}
      <EmptyState icon="📡" title="No channels" />
    {:else}
      <ul class="space-y-1 font-mono text-xs">
        {#each pubsubChannels as ch}
          <li class="rounded bg-surface px-2 py-1 text-text">{ch}</li>
        {/each}
      </ul>
    {/if}
  </Card>

  <Card title="CLIENT LIST" subtitle="First 100 entries">
    {#snippet actions()}
      <button onclick={loadClients} class="rounded-md border border-border bg-surface px-2.5 py-1 text-[10px] font-medium text-text hover:border-primary/40">Reload</button>
    {/snippet}
    {#if clients.length === 0}
      <EmptyState icon="👥" title="No clients" />
    {:else}
      <ul class="space-y-1 font-mono text-xs">
        {#each clients.slice(0, 10) as c}
          {@const addr = c.addr ?? '?'}
          <li class="rounded bg-surface px-2 py-1 text-text">
            <span class="text-primary">{addr}</span>
            {#if c.cmd}<span class="text-muted"> · {c.cmd}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if clients.length > 10}
        <div class="mt-2 text-xs text-muted">+{clients.length - 10} more</div>
      {/if}
    {/if}
  </Card>
</div>