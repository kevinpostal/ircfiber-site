<script lang="ts">
  /**
   * Replication Monitor — Mongo rs0 + Redis global-keys / shake.
   * Polls /api/admin/replication every 5s. Shows whether the k8s
   * secondary is in sync with OVH primary and whether redis-shake
   * is healthy. Replaces manual mongosh/redis-cli checks.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { replication, replicationError, replicationLoading, fetchReplication } from '../stores/replication';
  import { startPolling } from '../stores/polling';
  import { bytes, shortNumber } from '../lib/format';

  let stop: (() => void) | null = null;
  let lastFetchedAt = $state<number | null>(null);

  onMount(() => {
    stop = startPolling(async () => {
      await fetchReplication(true);
      lastFetchedAt = Date.now();
    });
  });
  onDestroy(() => stop?.());

  function stateTone(s: string): 'success' | 'warn' | 'danger' | 'muted' {
    if (s === 'PRIMARY') return 'success';
    if (s === 'SECONDARY') return 'success';
    if (s === 'STARTUP2') return 'warn';
    if (s === 'RECOVERING') return 'warn';
    if (s === 'ARBITER') return 'muted';
    if (s === 'DOWN' || s === '(not reachable/healthy)') return 'danger';
    return 'muted';
  }

  function healthTone(h: number): 'success' | 'danger' {
    return h === 1 ? 'success' : 'danger';
  }

  function overallTone(s: string): 'success' | 'warn' | 'danger' {
    if (s === 'in-sync') return 'success';
    if (s === 'partial') return 'warn';
    return 'danger';
  }

  function formatOptime(v: unknown): string {
    if (v == null) return '—';
    // BSON date comes as {$date: ...} or ISO string
    if (typeof v === 'string') {
      try {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d.toLocaleString();
      } catch (_) {}
      return String(v).slice(0, 24);
    }
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      if ('$date' in o) {
        const inner = o['$date'];
        if (typeof inner === 'string') {
          try { const d = new Date(inner); if (!isNaN(d.getTime())) return d.toLocaleString(); } catch (_) {}
          return String(inner).slice(0, 24);
        }
        if (typeof inner === 'number') {
          try { const d = new Date(inner); if (!isNaN(d.getTime())) return d.toLocaleString(); } catch (_) {}
          return String(inner);
        }
      }
      // optime: {ts: {$timestamp: {t, i}}}
      if ('ts' in o) return formatOptime(o['ts']);
      if ('$timestamp' in o) {
        const t = (o['$timestamp'] as Record<string, unknown>)?.['t'];
        if (typeof t === 'number') return new Date(t * 1000).toLocaleString();
      }
    }
    return String(v).slice(0, 24);
  }
</script>

<PageHeader
  title="Replication"
  subtitle="MongoDB rs0 + Redis global-keys sync — live view of k8s secondary vs OVH primary"
>
  {#snippet actions()}
    <button onclick={() => fetchReplication(true)} class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">
      Refresh
    </button>
  {/snippet}
</PageHeader>

{#if $replicationError}
  <Card class="mb-4">
    <div class="text-sm text-danger">Failed to load replication status: {$replicationError}</div>
  </Card>
{/if}

<!-- Overall -->
<div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
  <KpiCard
    label="Overall"
    value={$replication?.overall.status ?? '—'}
    tone={overallTone($replication?.overall.status ?? '')}
    icon="🔗"
    loading={$replicationLoading && !$replication}
  />
  <KpiCard
    label="Mongo"
    value={$replication?.mongo.hasPrimary ? `${$replication.mongo.healthyCount ?? 0}/${$replication.mongo.memberCount ?? 0} healthy` : 'no primary'}
    tone={$replication?.overall.mongoOk ? 'success' : 'danger'}
    icon="🍃"
    loading={$replicationLoading && !$replication}
  />
  <KpiCard
    label="Redis"
    value={$replication?.redis.connected ? 'connected' : 'offline'}
    tone={$replication?.overall.redisOk ? 'success' : 'danger'}
    icon="🔴"
    loading={$replicationLoading && !$replication}
  />
</div>

{#if $replication}
  <!-- Mongo -->
  <Card class="mb-6" title="MongoDB Replica Set" subtitle={$replication.mongo.replicaSet ? `rs0 — ${$replication.mongo.replicaSet}` : $replication.mongo.singleNode ? 'Single node (no replica set)' : 'Replica set'}>
    {#if !$replication.mongo.connected}
      <EmptyState icon="⚠️" title="Not connected" description="Gateway cannot reach MongoDB" />
    {:else if $replication.mongo.replicaSetError}
      <div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        {$replication.mongo.replicaSetError}
      </div>
    {:else}
      <div class="mb-3 flex flex-wrap gap-2 text-xs">
        <span class="rounded-full border border-border px-2.5 py-1">Primary: <span class="font-mono font-medium">{$replication.mongo.primary ?? '—'}</span></span>
        <span class="rounded-full border border-border px-2.5 py-1">Members: {$replication.mongo.memberCount ?? 0}</span>
        <span class="rounded-full border border-border px-2.5 py-1">Healthy: {$replication.mongo.healthyCount ?? 0}</span>
        <span class="rounded-full border border-border px-2.5 py-1">Secondaries: {$replication.mongo.secondaryCount ?? 0}</span>
        {#if $replication.mongo.dbName}<span class="rounded-full border border-border px-2.5 py-1">DB: {$replication.mongo.dbName}</span>{/if}
      </div>

      {#if $replication.mongo.members?.length}
        <div class="overflow-auto rounded-md border border-border">
          <table class="w-full text-sm">
            <thead class="bg-surface text-xs uppercase tracking-wider text-muted">
              <tr class="border-b border-border">
                <th class="px-3 py-2 text-left font-semibold">Member</th>
                <th class="px-3 py-2 text-left font-semibold">State</th>
                <th class="px-3 py-2 text-center font-semibold">Health</th>
                <th class="px-3 py-2 text-right font-semibold">Uptime</th>
                <th class="px-3 py-2 text-left font-semibold">Sync Source</th>
                <th class="px-3 py-2 text-left font-semibold">Optime</th>
                <th class="px-3 py-2 text-left font-semibold">Info</th>
              </tr>
            </thead>
            <tbody>
              {#each $replication.mongo.members as m (m.name)}
                <tr class="border-b border-border/40 hover:bg-surface/40">
                  <td class="px-3 py-2 font-mono text-xs">{m.name}</td>
                  <td class="px-3 py-2"><StatusBadge label={m.stateStr} tone={stateTone(m.stateStr)} size="sm" /></td>
                  <td class="px-3 py-2 text-center"><StatusBadge label={String(m.health)} tone={healthTone(m.health)} size="sm" /></td>
                  <td class="px-3 py-2 text-right text-muted">{m.uptime != null ? `${Math.floor(m.uptime)}s` : '—'}</td>
                  <td class="px-3 py-2 font-mono text-xs text-muted">{m.syncSourceHost ?? '—'}</td>
                  <td class="px-3 py-2 font-mono text-[11px] text-muted">{formatOptime((m as Record<string, unknown>).optimeDate ?? (m as Record<string, unknown>).optime ?? null)}</td>
                  <td class="px-3 py-2 text-xs text-muted">{m.infoMessage ?? ''}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      {#if $replication.mongo.serverStatus}
        <div class="mt-4 grid grid-cols-2 gap-3 text-xs">
          <div class="rounded-md border border-border bg-bg p-3">
            <div class="mb-1 text-[11px] uppercase tracking-wider text-muted">Version</div>
            <div class="font-mono text-sm">{($replication.mongo.serverStatus as Record<string, unknown>).version as string ?? '—'}</div>
          </div>
          <div class="rounded-md border border-border bg-bg p-3">
            <div class="mb-1 text-[11px] uppercase tracking-wider text-muted">Uptime</div>
            <div class="font-mono text-sm">{($replication.mongo.serverStatus as Record<string, unknown>).uptime as string ?? '—'}s</div>
          </div>
        </div>
      {/if}
    {/if}
  </Card>

  <!-- Redis -->
  <Card class="mb-6" title="Redis" subtitle="Local redis.ircfiber.svc.cluster.local + global-keys">
    {#if !$replication.redis.connected}
      <EmptyState icon="⚠️" title="Not connected" description="Gateway cannot reach Redis" />
    {:else}
      <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Role</div>
          <div class="font-mono text-sm">{($replication.redis.replication as Record<string, unknown>)?.role as string ?? '—'}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">DB size</div>
          <div class="font-mono text-sm">{$replication.redis.dbsize ?? '—'}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Version</div>
          <div class="font-mono text-sm">{($replication.redis.server as Record<string, unknown>)?.redis_version as string ?? '—'}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Memory</div>
          <div class="font-mono text-sm">{($replication.redis.memory as Record<string, unknown>)?.used_memory_human as string ?? '—'}</div>
        </div>
      </div>

      {#if $replication.redis.replication}
        <div class="mb-3 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs">
          <div class="mb-1 text-[11px] uppercase tracking-wider text-muted">Replication INFO</div>
          {#each Object.entries($replication.redis.replication as Record<string, unknown>) as [k, v]}
            <div class="flex justify-between gap-4 py-1"><span class="text-muted">{k}</span><span>{String(v)}</span></div>
          {/each}
        </div>
      {/if}

      <div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Assignments</div>
          <div class="font-mono text-sm">{$replication.redis.globalKeys?.assignments ?? '—'}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Servers</div>
          <div class="font-mono text-sm">{$replication.redis.globalKeys?.servers ?? '—'}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Global EID</div>
          <div class="font-mono text-xs">{($replication.redis.globalKeys?.globalEid ?? '—').toString().slice(0, 20)}</div>
        </div>
        <div class="rounded-md border border-border bg-bg p-3">
          <div class="text-[11px] uppercase tracking-wider text-muted">Protocol</div>
          <div class="font-mono text-sm">{$replication.redis.globalKeys?.protocolVersion ?? '—'}</div>
        </div>
      </div>

      {#if $replication.redis.shake}
        <div class="rounded-md border {($replication.redis.shake as Record<string, unknown>).status === 'paused' ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-bg'} p-3 text-xs">
          <div class="mb-1 font-medium">redis-shake: {($replication.redis.shake as Record<string, unknown>).status as string}</div>
          <div class="text-muted">{($replication.redis.shake as Record<string, unknown>).reason as string}</div>
          <div class="mt-2 flex flex-wrap gap-1">
            {#each (($replication.redis.shake as Record<string, unknown>).allowlist as unknown as string[]) ?? [] as k}
              <span class="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[11px]">{k}</span>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </Card>

  <div class="text-xs text-muted">
    Last fetched: {lastFetchedAt ? new Date(lastFetchedAt).toLocaleTimeString() : '—'} · Polls every 5s
  </div>
{/if}
