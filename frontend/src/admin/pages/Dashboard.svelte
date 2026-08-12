<script lang="ts">
  /**
   * Dashboard page — KPIs, host overview, recent activity, Mongo/Redis summary.
   * This is the main landing page. Polls /api/admin/dashboard every 5s.
   */
  import { onMount, onDestroy } from 'svelte';
  import { dashboard, dashboardError, dashboardLoading, fetchDashboard } from '../stores/dashboard';
  import { redisSummary, fetchRedisSummary } from '../stores/redis';
  import { mongoStatus, fetchMongoStatus } from '../stores/mongo';
  import { fiberConfig, fiberConfigError, fiberConfigLoading, fiberConfigSaving, fetchFiberConfig, setFiberEnabled } from '../stores/fiberConfig';
  import { startPolling } from '../stores/polling';
  import PageHeader from '../components/PageHeader.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import Card from '../components/Card.svelte';
  import VersionPanel from '../components/VersionPanel.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import { relative, percent, bytes, shortNumber } from '../lib/format';

  let stop: (() => void) | null = null;

  // Track last-fetched-at timestamps for the refresh indicator
  let lastFetchedAt = $state<number | null>(null);
  const setLastFetched = () => { lastFetchedAt = Date.now(); };

  onMount(() => {
    fetchFiberConfig();
    stop = startPolling(async () => {
      await Promise.all([
        fetchDashboard().then(setLastFetched),
        fetchRedisSummary(),
        fetchMongoStatus(),
        fetchFiberConfig(),
      ]);
    });
  });
  onDestroy(() => stop?.());

  let toggling = $state(false);
  async function toggleFiber() {
    if (!$fiberConfig || $fiberConfigSaving) return;
    toggling = true;
    try {
      await setFiberEnabled(!$fiberConfig.enabled);
    } finally {
      toggling = false;
    }
  }
</script>

<PageHeader
  title="Dashboard"
  subtitle="Real-time view of engines, sessions, MongoDB and Redis health"
/>

<!-- IRC Fiber auto-connect toggle -->
<Card class="mb-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <div class="text-sm font-medium">IRC Fiber auto-connect</div>
      <div class="text-xs text-muted-foreground">
        {#if $fiberConfigLoading && !$fiberConfig}
          Loading…
        {:else if $fiberConfig}
          irc.ircfiber.com — {$fiberConfig.fiberNetworkCount} networks
          ({$fiberConfig.disabledCount} disabled)
          {#if !$fiberConfig.enabled}
            <span class="ml-2 text-amber-500">disabled — hidden from sidebar & not provisioned for new users</span>
          {:else}
            <span class="ml-2 text-green-600">enabled</span>
          {/if}
        {:else}
          —
        {/if}
        {#if $fiberConfigError}
          <span class="ml-2 text-danger">{$fiberConfigError}</span>
        {/if}
      </div>
    </div>
    <button
      class="adm-btn {($fiberConfig?.enabled ?? true) ? 'adm-btn-primary' : ''}"
      disabled={$fiberConfigSaving || toggling || $fiberConfigLoading}
      onclick={toggleFiber}
    >
      {#if $fiberConfigSaving || toggling}
        Saving…
      {:else if $fiberConfig?.enabled}
        Disable
      {:else}
        Enable
      {/if}
    </button>
  </div>
  {#if $fiberConfig && !$fiberConfig.enabled}
    <div class="mt-2 text-xs text-muted-foreground">
      When disabled, the Fiber server is hidden from the sidebar (via <code>isFiberServerDown</code>) and new users will not get an auto-provisioned irc.ircfiber.com network. Existing Fiber networks were bulk-disabled on toggle.
    </div>
  {/if}
</Card>

{#if $dashboardError}
  <Card class="mb-4">
    <div class="text-sm text-danger">Failed to load dashboard: {$dashboardError}</div>
  </Card>
{/if}

<div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
  <KpiCard
    label="Users"
    value={$dashboard?.userCount ?? '—'}
    icon="👥"
    loading={$dashboardLoading && !$dashboard}
  />
  <KpiCard
    label="Active Sessions"
    value={$dashboard?.activeSessions ?? '—'}
    tone={($dashboard?.activeSessions ?? 0) > 0 ? 'success' : 'muted'}
    icon="🔑"
    loading={$dashboardLoading && !$dashboard}
  />
  <KpiCard
    label="Connected Networks"
    value={$dashboard?.totalNetworks ?? '—'}
    icon="🌐"
    loading={$dashboardLoading && !$dashboard}
  />
  <KpiCard
    label="Healthy Engines"
    value={`${$dashboard?.healthyCount ?? '—'}/${$dashboard?.engineCount ?? '—'}`}
    tone={$dashboard?.healthyCount === $dashboard?.engineCount && ($dashboard?.engineCount ?? 0) > 0 ? 'success' : ($dashboard?.healthyCount ?? 0) > 0 ? 'warn' : 'danger'}
    icon="🖥️"
    loading={$dashboardLoading && !$dashboard}
  />
</div>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
  <!-- MongoDB summary card -->
  <Card title="MongoDB" subtitle="Connected via vibe.d">
    {#snippet actions()}
      <a href="#/mongo" class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">View monitor →</a>
    {/snippet}
    {#if !$mongoStatus}
      <div class="flex h-32 items-center justify-center">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
      </div>
    {:else if !$mongoStatus.connected}
      <EmptyState icon="⚠️" title="Not connected" description={$mongoStatus.error ?? 'Connection unavailable'} />
    {:else}
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between"><dt class="text-muted">Database</dt><dd class="font-mono">{$mongoStatus.dbName}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Version</dt><dd>{$mongoStatus.serverStatus?.version ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Collections</dt><dd>{$mongoStatus.dbStats?.collections ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Documents</dt><dd>{shortNumber($mongoStatus.dbStats?.objects ?? null)}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Data size</dt><dd>{bytes($mongoStatus.dbStats?.dataSize ?? null)}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Connections</dt><dd>
          {$mongoStatus.serverStatus?.connections?.current ?? '—'} / {$mongoStatus.serverStatus?.connections?.available ?? '—'} avail
        </dd></div>
      </dl>
    {/if}
  </Card>

  <!-- Redis summary card -->
  <Card title="Redis" subtitle="Sessions, buffers, routing">
    {#snippet actions()}
      <a href="#/redis" class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">View monitor →</a>
    {/snippet}
    {#if !$redisSummary}
      <div class="flex h-32 items-center justify-center">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
      </div>
    {:else}
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between"><dt class="text-muted">Version</dt><dd>{$redisSummary.version ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Uptime</dt><dd>{$redisSummary.uptimeSeconds != null ? relative($redisSummary.uptimeSeconds * 1000, Date.now() - 1000) : '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Used memory</dt><dd>{$redisSummary.usedMemoryHuman ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Connected clients</dt><dd>{$redisSummary.connectedClients ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Ops / sec</dt><dd>{$redisSummary.opsPerSec ?? '—'}</dd></div>
        <div class="flex justify-between"><dt class="text-muted">Hit ratio</dt><dd>
          {#if $redisSummary.hitRatio != null}
            {percent(($redisSummary.hitRatio * 100), 100)}
          {:else}—{/if}
        </dd></div>
        <div class="flex justify-between"><dt class="text-muted">Keys (db0)</dt><dd>{$redisSummary.dbsize ?? '—'}</dd></div>
      </dl>
    {/if}
  </Card>

  <!-- Engines overview -->
  <Card title="Engines" subtitle="{($dashboard?.healthyCount ?? 0)} of {$dashboard?.engineCount ?? 0} healthy">
    {#if !$dashboard?.engines?.length}
      <EmptyState icon="🖥️" title="No engines registered" description="Start an IRC engine to see it appear here." />
    {:else}
      <ul class="space-y-3">
        {#each $dashboard.engines as engine (engine.serverId)}
          <li class="flex items-center gap-3">
            <span class="h-2 w-2 rounded-full {engine.healthy ? 'bg-success' : 'bg-danger'}"></span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-mono text-sm text-text">{engine.serverId}</div>
              <div class="text-xs text-muted">{engine.bindAddress}:{engine.port}</div>
            </div>
            <StatusBadge
              label="{engine.assignedNetworkCount} nets"
              tone={engine.healthy ? 'success' : 'danger'}
              size="sm"
            />
          </li>
        {/each}
      </ul>
    {/if}
  </Card>
</div>

<!-- Hosts overview -->
{#if $dashboard?.hosts?.length}
  <div class="mt-6">
    <Card title="IRC Host Connections" subtitle="Per-host connection counts across engines">
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 text-left font-semibold">Host</th>
            <th class="py-2 text-right font-semibold">Connections</th>
            <th class="py-2 text-right font-semibold">Capacity</th>
            <th class="py-2 text-right font-semibold">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each $dashboard.hosts as host (host.host)}
            <tr class="border-b border-border/40 hover:bg-surface/40">
              <td class="py-2 font-mono">{host.host} {#if host.host.toLowerCase() === 'irc.ircfiber.com'}<span class="ml-1 text-[10px] text-success">unlimited</span>{/if}</td>
              <td class="py-2 text-right">{host.totalConns}</td>
              <td class="py-2 text-right text-muted">{host.host.toLowerCase() === 'irc.ircfiber.com' ? `${host.totalConns}/∞` : `${host.totalConns}/${host.capacity}`}</td>
              <td class="py-2 text-right">
                <StatusBadge
                  label={host.status === 'full' ? 'Full' : host.status === 'warn' ? 'Warn' : 'Safe'}
                  tone={host.status === 'full' ? 'danger' : host.status === 'warn' ? 'warn' : 'success'}
                  size="sm"
                />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>
  </div>
{/if}

<!-- Recent users -->
{#if $dashboard?.recentUsers?.length}
  <div class="mt-6">
    <Card title="Recent Users" subtitle="Newest signups">
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 text-left font-semibold">Username</th>
            <th class="py-2 text-left font-semibold">Email</th>
            <th class="py-2 text-left font-semibold">Roles</th>
            <th class="py-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each $dashboard.recentUsers as u (u.id)}
            <tr class="border-b border-border/40 hover:bg-surface/40">
              <td class="py-2 font-medium text-text">{u.username}</td>
              <td class="py-2 text-muted">{u.email}</td>
              <td class="py-2">
                <div class="flex flex-wrap gap-1">
                  {#each u.roles as role}
                    <StatusBadge label={role} tone={role === 'admin' ? 'primary' : 'muted'} size="sm" />
                  {/each}
                </div>
              </td>
              <td class="py-2 text-right">
                <a href="#/users/{u.id}" class="text-xs text-primary hover:underline">View →</a>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </Card>
  </div>
{/if}
<div class="mt-6">
  <VersionPanel />
</div>