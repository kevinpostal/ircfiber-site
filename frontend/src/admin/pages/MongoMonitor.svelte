<script lang="ts">
  /**
   * MongoDB Monitor — connection status, db stats, serverStatus subset,
   * collections table, sandboxed query runner.
   *
   * Polls /api/admin/mongo/status + /api/admin/mongo/collections every 5s.
   * The collections list + query tool are user-driven (manual fetch).
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import {
    mongoStatus, mongoCollections, mongoError, mongoLoading,
    fetchMongoStatus, fetchMongoCollections,
    type MongoCollection,
  } from '../stores/mongo';
  import { startPolling } from '../stores/polling';
  import { api, ApiError } from '../lib/api-client';
  import { filterLooksSafe, MONGO_LIMITS } from '../lib/safety';
  import { bytes, shortNumber } from '../lib/format';
  import { toastError, toastSuccess } from '../stores/ui';

  let stop: (() => void) | null = null;
  let lastFetchedAt = $state<number | null>(null);

  // Sandbox query state
  let qCollection = $state('');
  let qFilter = $state('{}');
  let qLimit = $state(MONGO_LIMITS.defaultLimit);
  let qMaxTimeMs = $state(MONGO_LIMITS.defaultMaxTimeMs);
  let qResults = $state<any[] | null>(null);
  let qRunning = $state(false);
  let qError = $state<string | null>(null);

  const safetyCheck = $derived.by(() => {
    try {
      const parsed = JSON.parse(qFilter || '{}');
      return filterLooksSafe(parsed);
    } catch {
      return { ok: false, reason: 'Invalid JSON' };
    }
  });

  async function runQuery() {
    if (!qCollection) { qError = 'Pick a collection first'; return; }
    if (!safetyCheck.ok) { qError = safetyCheck.reason ?? 'Filter unsafe'; return; }
    qRunning = true; qError = null; qResults = null;
    try {
      const parsed = JSON.parse(qFilter || '{}');
      const res = await api.post<{ results: any[] }>('/api/admin/mongo/query', {
        collection: qCollection,
        filter: parsed,
        limit: qLimit,
        maxTimeMs: qMaxTimeMs,
      });
      qResults = res.results ?? [];
      toastSuccess(`Returned ${qResults.length} docs from ${qCollection}`);
    } catch (e) {
      qError = e instanceof ApiError ? e.message : (e as Error).message;
      toastError(qError);
    } finally {
      qRunning = false;
    }
  }

  async function loadCollections() {
    await fetchMongoCollections(true);
  }

  onMount(() => {
    stop = startPolling(async () => {
      await fetchMongoStatus();
      await loadCollections();
      lastFetchedAt = Date.now();
    });
  });
  onDestroy(() => stop?.());

  // Sorted collections list (largest first by size)
  const sortedCollections = $derived.by(() =>
    [...($mongoCollections ?? [])].sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
  );
</script>

<PageHeader
  title="MongoDB Monitor"
  subtitle="Connection status, database stats, collection inventory, sandboxed query runner"
>
  {#snippet actions()}
    <button onclick={() => { fetchMongoStatus(true); loadCollections(); }} class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">
      Refresh
    </button>
  {/snippet}
</PageHeader>

{#if $mongoError}
  <Card class="mb-4">
    <div class="text-sm text-danger">{$mongoError}</div>
  </Card>
{/if}

<!-- Status / KPI grid -->
<div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
  <KpiCard
    label="Connection"
    value={$mongoStatus?.connected ? 'Connected' : 'Down'}
    tone={$mongoStatus?.connected ? 'success' : 'danger'}
    icon="🔌"
  />
  <KpiCard
    label="Database"
    value={$mongoStatus?.dbName ?? '—'}
    icon="🗄️"
  />
  <KpiCard
    label="Server Version"
    value={$mongoStatus?.serverStatus?.version ?? '—'}
    icon="🏷️"
  />
  <KpiCard
    label="Connections"
    value={$mongoStatus?.serverStatus?.connections ? `${$mongoStatus.serverStatus.connections.current}/${$mongoStatus.serverStatus.connections.available}` : '—'}
    icon="🔗"
  />
</div>

<!-- Stats row -->
<div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
  <Card title="Database Stats">
    <dl class="space-y-2 text-sm">
      <div class="flex justify-between"><dt class="text-muted">Collections</dt><dd>{$mongoStatus?.dbStats?.collections ?? '—'}</dd></div>
      <div class="flex justify-between"><dt class="text-muted">Indexes</dt><dd>{$mongoStatus?.dbStats?.indexes ?? '—'}</dd></div>
      <div class="flex justify-between"><dt class="text-muted">Documents</dt><dd>{shortNumber($mongoStatus?.dbStats?.objects ?? null)}</dd></div>
      <div class="flex justify-between"><dt class="text-muted">Data size</dt><dd>{bytes($mongoStatus?.dbStats?.dataSize ?? null)}</dd></div>
      <div class="flex justify-between"><dt class="text-muted">Storage</dt><dd>{bytes($mongoStatus?.dbStats?.storageSize ?? null)}</dd></div>
      <div class="flex justify-between"><dt class="text-muted">Avg object</dt><dd>{bytes($mongoStatus?.dbStats?.avgObjSize ?? null)}</dd></div>
    </dl>
  </Card>

  <Card title="Opcounters" subtitle="Since server start">
    {#if $mongoStatus?.serverStatus?.opcounters}
      <dl class="space-y-2 text-sm">
        {#each Object.entries($mongoStatus.serverStatus.opcounters) as [op, count]}
          <div class="flex justify-between">
            <dt class="text-muted">{op}</dt>
            <dd class="font-mono">{shortNumber(count as number)}</dd>
          </div>
        {/each}
      </dl>
    {:else}
      <EmptyState icon="📊" title="No opcounter data" />
    {/if}
  </Card>

  <Card title="Memory">
    {#if $mongoStatus?.serverStatus?.mem}
      {@const mem = $mongoStatus.serverStatus.mem}
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between"><dt class="text-muted">Resident</dt><dd>{bytes((mem.resident ?? 0) * 1024 * 1024)}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Virtual</dt><dd>{bytes((mem.virtual ?? 0) * 1024 * 1024)}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Mapped</dt><dd>{bytes((mem.mapped ?? 0) * 1024 * 1024)}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Uptime</dt><dd>{$mongoStatus.serverStatus.uptime != null ? `${Math.floor($mongoStatus.serverStatus.uptime / 3600)}h ${Math.floor(($mongoStatus.serverStatus.uptime % 3600) / 60)}m` : '—'}</dd></div>
      </dl>
    {:else}
      <EmptyState icon="💾" title="No memory data" />
    {/if}
  </Card>
</div>

<!-- Collections table -->
<Card title="Collections" subtitle="{sortedCollections.length} collections, sorted by size">
  {#if sortedCollections.length === 0}
    <EmptyState icon="📂" title="No collections" description="MongoDB has no collections in this database." />
  {:else}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">Name</th>
          <th class="py-2 text-right font-semibold">Documents</th>
          <th class="py-2 text-right font-semibold">Size</th>
          <th class="py-2 text-right font-semibold">Storage</th>
          <th class="py-2 text-right font-semibold">Indexes</th>
        </tr>
      </thead>
      <tbody>
        {#each sortedCollections as coll (coll.name)}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2 font-mono">{coll.name}</td>
            <td class="py-2 text-right">{shortNumber(coll.count)}</td>
            <td class="py-2 text-right text-muted">{bytes(coll.size)}</td>
            <td class="py-2 text-right text-muted">{bytes(coll.storageSize ?? null)}</td>
            <td class="py-2 text-right text-muted">{coll.indexes ?? '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Card>

<!-- Sandboxed query runner -->
<Card
  class="mt-6"
  title="Query Runner"
  subtitle="Read-only · limit ≤ 100 · maxTimeMS ≤ 10000 · $where/$function/$lookup blocked"
>
  <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
    <div class="md:col-span-2">
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Collection</label>
      <select bind:value={qCollection} class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none">
        <option value="">— select —</option>
        {#each sortedCollections as c}
          <option value={c.name}>{c.name}</option>
        {/each}
      </select>
    </div>
    <div>
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Limit</label>
      <input type="number" bind:value={qLimit} min="1" max={MONGO_LIMITS.maxLimit} class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
    </div>
    <div>
      <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Max time (ms)</label>
      <input type="number" bind:value={qMaxTimeMs} min="1" max={MONGO_LIMITS.maxTimeMs} class="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-primary focus:outline-none" />
    </div>
  </div>
  <div class="mt-3">
    <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Filter (JSON)</label>
    <textarea bind:value={qFilter} rows="3" class="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-text focus:border-primary focus:outline-none"></textarea>
    <div class="mt-1 text-xs">
      {#if safetyCheck.ok}
        <span class="text-success">✓ Filter looks safe</span>
      {:else}
        <span class="text-danger">✕ {safetyCheck.reason}</span>
      {/if}
    </div>
  </div>
  <div class="mt-3 flex items-center gap-2">
    <button
      type="button"
      onclick={runQuery}
      disabled={qRunning || !safetyCheck.ok || !qCollection}
      class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
    >
      {qRunning ? 'Running…' : 'Run query'}
    </button>
    {#if qError}
      <span class="text-sm text-danger">{qError}</span>
    {/if}
  </div>
  {#if qResults}
    <div class="mt-4">
      <div class="mb-2 text-xs text-muted">{qResults.length} document{qResults.length === 1 ? '' : 's'}</div>
      <pre class="max-h-96 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs text-text">{JSON.stringify(qResults, null, 2)}</pre>
    </div>
  {/if}
</Card>