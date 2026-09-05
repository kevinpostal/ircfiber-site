<script lang="ts">
  /**
   * Mullvad page — SOCKS sidecars health, pool, per-network egress, live connections, server override.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { toastSuccess, toastError } from '../stores/ui';
  import {
    mullvadStatus,
    mullvadLoading,
    mullvadError,
    mullvadTesting,
    mullvadRestarting,
    mullvadSwapping,
    fetchMullvadStatus,
    testProxy,
    testAll,
    restartProxy,
    swapSlotExit,
    setServerEgress,
    clearServerEgress,
  } from '../stores/mullvad';
  import type { MullvadLiveConn } from '../stores/mullvad';

  let data = $state($mullvadStatus);
  let loading = $state($mullvadLoading);
  let error = $state($mullvadError);
  let testing = $state($mullvadTesting);
  let restarting = $state($mullvadRestarting);

  // keep local synced
  $effect(() => { data = $mullvadStatus; });
  $effect(() => { loading = $mullvadLoading; });
  $effect(() => { error = $mullvadError; });
  $effect(() => { testing = $mullvadTesting; });
  $effect(() => { restarting = $mullvadRestarting; });
  let swapping = $state($mullvadSwapping);
  $effect(() => { swapping = $mullvadSwapping; });

  let liveTab = $state('all');
  let expandedUsage = $state<Record<string, boolean>>({});
  let showAssocAll = $state<Record<string, boolean>>({});
  let restartAsk = $state<string | null>(null);
  let egressAsk = $state<{ serverId: string; label: string } | null>(null);
  let clearAsk = $state<string | null>(null);
  let egressPick = $state<Record<string, string>>({});
  /// Per-slot target city for the "swap exit" control, keyed by slot label.
  let exitPick = $state<Record<string, string>>({});
  let exitAsk = $state<{ label: string; locationId: string } | null>(null);
  /// Catalog grouped by country for the swap <select>.
  const locationGroups = $derived.by(() => {
    const groups: { country: string; cities: { id: string; city: string }[] }[] = [];
    for (const loc of data?.locations ?? []) {
      const last = groups[groups.length - 1];
      if (last && last.country === loc.country) last.cities.push({ id: loc.id, city: loc.city });
      else groups.push({ country: loc.country, cities: [{ id: loc.id, city: loc.city }] });
    }
    return groups;
  });
  const cityName = (id: string) => data?.locations?.find((l) => l.id === id)?.city ?? id;

  async function doSwapExit(label: string) {
    const locationId = exitPick[label] ?? '';
    if (!locationId) return;
    exitAsk = { label, locationId };
  }
  async function confirmSwapExit() {
    if (!exitAsk) return;
    const { label, locationId } = exitAsk;
    try {
      await swapSlotExit(label, locationId);
      toastSuccess(`Slot ${label} → ${cityName(locationId)} — switching…`);
      exitPick[label] = '';
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      exitAsk = null;
    }
  }

  let stop: (() => void) | null = null;

  const healthyCount = $derived((data?.pool ?? []).filter((p) => p.healthy).length);
  const sumPinned = $derived(
    data?.usage ? Object.values(data.usage).reduce((a, b) => a + (b.pinned ?? 0), 0) : 0
  );
  const sumActive = $derived(
    data?.usage ? Object.values(data.usage).reduce((a, b) => a + (b.active ?? 0), 0) : 0
  );

  const liveFlat = $derived(() => {
    const lc = data?.liveConnections;
    if (!lc) return [];
    if (liveTab === 'all') {
      const all: MullvadLiveConn[] = [];
      for (const arr of Object.values(lc)) if (Array.isArray(arr)) all.push(...arr);
      return all;
    }
    return (lc[liveTab] ?? []) as MullvadLiveConn[];
  });

  function containerTone(s: string): 'success' | 'warn' | 'danger' | 'muted' {
    if (s === 'running') return 'success';
    if (s === 'exited') return 'danger';
    if (s === 'missing') return 'warn';
    return 'muted';
  }

  onMount(() => {
    fetchMullvadStatus();
    const id = setInterval(() => fetchMullvadStatus(), 15000);
    return () => clearInterval(id);
  });

  async function doTest(label: string) {
    try {
      await testProxy(label);
      toastSuccess(`Test ${label}: updated`);
    } catch (e) {
      toastError((e as Error).message);
    }
  }
  async function doTestAll() {
    try {
      await testAll();
      toastSuccess('All proxies tested');
    } catch (e) {
      toastError((e as Error).message);
    }
  }
  async function doRestart(label: string) {
    try {
      await restartProxy(label);
      toastSuccess(`Restarted ${label}`);
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      restartAsk = null;
    }
  }
  async function doSetEgress(serverId: string) {
    const label = egressPick[serverId] ?? '';
    if (!label) return;
    egressAsk = { serverId, label };
  }
  async function confirmSetEgress() {
    if (!egressAsk) return;
    try {
      await setServerEgress(egressAsk.serverId, egressAsk.label);
      toastSuccess(`Engine ${egressAsk.serverId} → ${egressAsk.label || 'random'}`);
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      egressAsk = null;
    }
  }
  async function confirmClear(serverId: string) {
    try {
      await clearServerEgress(serverId);
      toastSuccess(`Cleared egress for ${serverId}`);
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      clearAsk = null;
    }
  }
</script>

<PageHeader title="Mullvad" subtitle="SOCKS sidecars — health, pool, per-network egress">
  {#snippet actions()}
    <button
      onclick={() => fetchMullvadStatus(true)}
      class="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:border-primary/40"
      disabled={loading}
    >
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
    <button
      onclick={doTestAll}
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50"
      disabled={loading || !data?.pool?.length}
    >
      Test all
    </button>
  {/snippet}
</PageHeader>

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<!-- KPIs -->
<div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
  <KpiCard label="Total proxies" value={data?.pool?.length ?? '—'} loading={loading && !data} icon="🛡️" />
  <KpiCard label="Healthy" value={healthyCount} loading={loading && !data} icon="✅" tone={data && healthyCount < (data?.pool?.length ?? 0) ? 'warn' : 'success'} />
  <KpiCard label="Pinned networks" value={sumPinned} loading={loading && !data} icon="📌" />
  <KpiCard label="Active connections" value={sumActive} loading={loading && !data} icon="🔌" />
</div>

{#if data?.warning}
  <Card class="mb-4">
    <div class="rounded-md bg-warn/10 px-3 py-2 text-sm text-warn">⚠️ {data?.warning}</div>
  </Card>
{/if}

<!-- Pool table -->
<Card title="Proxy Pool" subtitle="{data?.pool?.length ?? 0} sidecars · {data?.poolRaw || '—'}" class="mb-6">
  {#if !data?.pool?.length}
    <EmptyState icon="🛡️" title="No pool configured" description="Add mullvad_sidecars and redeploy engine. Pool is driven by IRCFIBER_MULLVAD_POOL env / /etc/ircfiber/engine/env-ovh." />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted">
            <th class="px-3 py-2">Exit location</th>
            <th class="px-3 py-2">Container</th>
            <th class="px-3 py-2">SOCKS URL</th>
            <th class="px-3 py-2">Resolved IP</th>
            <th class="px-3 py-2">Exit IP</th>
            <th class="px-3 py-2">Location / ISP</th>
            <th class="px-3 py-2">Healthy</th>
            <th class="px-3 py-2">Swap exit</th>
            <th class="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each data?.pool ?? [] as p}
            <tr class="border-b border-border/50 hover:bg-surface">
              <td class="px-3 py-2 text-xs">
                <div class="font-medium">{p.city ? `${p.city}, ${p.country}` : p.label.toUpperCase()}</div>
                <div class="mt-1 flex items-center gap-1">
                  {#if (p.activeConns ?? 0) > 0}
                    <StatusBadge label={`in use — ${p.activeConns}`} tone="primary" size="sm" />
                  {:else}
                    <StatusBadge label="idle" tone="muted" size="sm" />
                  {/if}
                  {#if p.state === 'retargeting'}<StatusBadge label="switching" tone="warn" size="sm" />{/if}
                  {#if p.controllable === false}<StatusBadge label="static" tone="muted" size="sm" />{/if}
                </div>
                <div class="mt-1 font-mono text-[10px] text-muted">{p.locationId || p.label}</div>
              </td>
              <td class="px-3 py-2">
                <div class="font-mono text-xs">{p.container}</div>
                <div class="mt-1"><StatusBadge label={p.containerState} tone={containerTone(p.containerState)} size="sm" /></div>
                {#if p.containerStatus}<div class="mt-1 text-[10px] text-muted">{p.containerStatus.slice(0, 80)}</div>{/if}
              </td>
              <td class="px-3 py-2 font-mono text-xs">{p.socksUrl}</td>
              <td class="px-3 py-2 font-mono text-xs">{p.ip || '—'}</td>
              <td class="px-3 py-2 font-mono text-xs">{p?.tailscaleExitNode || p?.ipinfo?.ip || '—'}</td>
              <td class="px-3 py-2 text-xs">
                {#if p?.ipinfo?.city || p?.ipinfo?.country || p?.ipinfo?.loc || p?.ipinfo?.org}
                  <div class="font-medium">{p?.ipinfo?.city || p?.ipinfo?.loc?.split(',')[0] || '—'}{p?.ipinfo?.region ? `, ${p?.ipinfo?.region}` : ''} {p?.ipinfo?.country ? `(${p?.ipinfo?.country})` : ''}</div>
                  <div class="text-[10px] text-muted">{p?.ipinfo?.org || '—'}</div>
                  {#if p?.ipinfo?.loc && p?.ipinfo?.city && p?.ipinfo?.loc !== p?.ipinfo?.city}<div class="text-[10px] text-muted">{p?.ipinfo?.loc}</div>{:else if p?.ipinfo?.loc && !p?.ipinfo?.city}<div class="text-[10px] text-muted">{p?.ipinfo?.loc}</div>{/if}
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td class="px-3 py-2">
                <StatusBadge label={p.healthy ? 'healthy' : 'unhealthy'} tone={p.healthy ? 'success' : 'danger'} size="sm" />
                {#if p.error}<div class="mt-1 max-w-[20ch] truncate text-[10px] text-danger" title={p.error}>{p.error.slice(0, 60)}</div>{/if}
              </td>
              <td class="px-3 py-2">
                {#if p.controllable === false}
                  <span class="text-[11px] text-muted" title="The engine cannot reach this sidecar's tailscaled socket">
                    not retargetable
                  </span>
                {:else if (data?.locations?.length ?? 0) === 0}
                  <span class="text-[11px] text-muted">no catalog</span>
                {:else}
                  <div class="flex items-center gap-1.5">
                    <select
                      class="max-w-[13rem] rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text"
                      bind:value={exitPick[p.label]}
                      disabled={(p.activeConns ?? 0) > 0 || swapping.has(p.label) || p.state === 'retargeting'}
                    >
                      <option value="">Move to…</option>
                      {#each locationGroups as g (g.country)}
                        <optgroup label={g.country}>
                          {#each g.cities as c (c.id)}
                            <option value={c.id} disabled={c.id === p.locationId}>
                              {c.city}{c.id === p.locationId ? ' (current)' : ''}
                            </option>
                          {/each}
                        </optgroup>
                      {/each}
                    </select>
                    <button
                      onclick={() => doSwapExit(p.label)}
                      class="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium hover:border-primary/40 disabled:opacity-50"
                      disabled={!exitPick[p.label] || (p.activeConns ?? 0) > 0 || swapping.has(p.label) || p.state === 'retargeting'}
                      title={(p.activeConns ?? 0) > 0
                        ? `Carrying ${p.activeConns} live connection(s) — swapping would drop them`
                        : 'Move this exit to another Mullvad city'}
                    >
                      {swapping.has(p.label) || p.state === 'retargeting' ? 'Switching…' : 'Swap'}
                    </button>
                  </div>
                  {#if (p.activeConns ?? 0) > 0}
                    <div class="mt-1 text-[10px] text-muted">
                      in use by {p.activeConns} connection{p.activeConns === 1 ? '' : 's'} — free it first
                    </div>
                  {/if}
                {/if}
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center gap-1.5">
                  <button
                    onclick={() => doTest(p.label)}
                    class="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium hover:border-primary/40 disabled:opacity-50"
                    disabled={testing.has(p.label)}
                  >
                    {testing.has(p.label) ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    onclick={() => (restartAsk = p.label)}
                    class="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium hover:border-danger/40 disabled:opacity-50"
                    disabled={restarting.has(p.label) || (p.activeConns ?? 0) > 0}
                    title={(p.activeConns ?? 0) > 0
                      ? `Carrying ${p.activeConns} live connection(s) — disconnect them first`
                      : 'Restart the sidecar container'}
                  >
                    {restarting.has(p.label) ? 'Restarting…' : 'Restart'}
                  </button>
                </div>
              </td>
            </tr>
            <!-- per-proxy usage collapsed row -->
            <tr class="border-b border-border/30 bg-bg/30">
              <td colspan="9" class="px-3 py-2">
                <button
                  onclick={() => (expandedUsage[p.label] = !expandedUsage[p.label])}
                  class="text-[11px] font-medium text-primary hover:underline"
                >
                  {expandedUsage[p.label] ? 'Hide usage' : 'Show usage'} — pinned {data.usage?.[p.label]?.pinned ?? 0}, active {data.usage?.[p.label]?.active ?? 0}
                </button>
                {#if expandedUsage[p.label]}
                  {@const assocAll = data.associations?.filter((a) => a.egressNodeId === p.label || a.activeEgressLabel === p.label) ?? []}
                  {@const showAll = showAssocAll[p.label] ?? false}
                  {@const list = showAll ? assocAll : assocAll.slice(0, 20)}
                  <div class="mt-2">
                    {#if list.length === 0}
                      <div class="text-xs text-muted">No networks pinned to {p.label}</div>
                    {:else}
                      <table class="w-full text-xs">
                        <thead>
                          <tr class="text-left text-[10px] uppercase tracking-wider text-muted">
                            <th class="py-1 pr-2">Network</th>
                            <th class="py-1 pr-2">Host</th>
                            <th class="py-1 pr-2">User</th>
                            <th class="py-1 pr-2">Pinned</th>
                            <th class="py-1 pr-2">Active</th>
                          </tr>
                        </thead>
                        <tbody>
                          {#each list as a}
                            <tr class="border-t border-border/30">
                              <td class="py-1 pr-2 font-medium"><a href="#/servers" class="text-primary hover:underline">{a.networkName}</a></td>
                              <td class="py-1 pr-2 font-mono">{a.host}</td>
                              <td class="py-1 pr-2">{a.username || '—'}</td>
                              <td class="py-1 pr-2">{a.egressNodeId || '—'}</td>
                              <td class="py-1 pr-2">{a.activeEgressLabel || '—'}</td>
                            </tr>
                          {/each}
                        </tbody>
                      </table>
                      {#if assocAll.length > 20}
                        <button
                          onclick={() => (showAssocAll[p.label] = !showAssocAll[p.label])}
                          class="mt-2 text-[11px] text-primary hover:underline"
                        >
                          {showAll ? 'Show less' : `Show all (${assocAll.length})`}
                        </button>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

<!-- Live Connections -->
<Card title="Live Connections" subtitle="{data?.liveConnectionsTotal ?? 0} active IRC sessions across engines" class="mb-6">
  {#snippet actions()}
    <div class="flex items-center gap-1">
      <button
        onclick={() => (liveTab = 'all')}
        class="rounded px-2 py-1 text-xs {liveTab === 'all' ? 'bg-primary text-primary-fg' : 'border border-border bg-surface-2'}"
      >
        All
      </button>
      {#each data?.pool ?? [] as p}
        <button
          onclick={() => (liveTab = p.label)}
          class="rounded px-2 py-1 text-xs {liveTab === p.label ? 'bg-primary text-primary-fg' : 'border border-border bg-surface-2'}"
        >
          {p.label}
        </button>
      {/each}
    </div>
  {/snippet}
  {#if !data}
    <div class="text-sm text-muted">Loading…</div>
  {:else if (liveFlat() ?? []).length === 0}
    <EmptyState icon="🔌" title="No live connections on this proxy" description="Start a network pinned to this exit or wait for an engine to connect." />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted">
            <th class="px-3 py-2">Engine</th>
            <th class="px-3 py-2">Network</th>
            <th class="px-3 py-2">Host</th>
            <th class="px-3 py-2">Nick</th>
            <th class="px-3 py-2">Proxy</th>
            <th class="px-3 py-2">Exit IP</th>
            <th class="px-3 py-2">Location / ISP</th>
            <th class="px-3 py-2">Connected Since</th>
          </tr>
        </thead>
        <tbody>
          {#each (liveFlat() ?? []) as c}
            {@const p = data?.pool.find((x) => x.label === c?.activeEgressLabel)}
            <tr class="border-b border-border/50 hover:bg-surface">
              <td class="px-3 py-2 font-mono text-xs">{c?.serverId || '—'}</td>
              <td class="px-3 py-2"><a href="#/servers" class="text-primary hover:underline">{c?.networkName || '—'}</a></td>
              <td class="px-3 py-2 font-mono text-xs">{c?.host || '—'}</td>
              <td class="px-3 py-2 font-mono text-xs">{c?.nick || '—'}</td>
              <td class="px-3 py-2 font-mono text-xs">{c?.activeEgressLabel || '—'} <span class="text-muted">({c?.activeEgressHost || '—'})</span></td>
              <td class="px-3 py-2 font-mono text-xs">{c?.activeEgressIp || p?.ipinfo?.ip || p?.tailscaleExitNode || '—'}</td>
              <td class="px-3 py-2 text-xs">
                {#if p?.ipinfo?.city || p?.ipinfo?.country || p?.ipinfo?.loc}
                  <div>{p?.ipinfo?.city || p?.ipinfo?.loc?.split(',')[0] || '—'}{p?.ipinfo?.region ? `, ${p?.ipinfo?.region}` : ''} {p?.ipinfo?.country ? `(${p?.ipinfo?.country})` : ''}</div>
                  <div class="text-[10px] text-muted">{p?.ipinfo?.org || '—'}</div>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td class="px-3 py-2 text-xs">{c?.connectedSince ? new Date(c.connectedSince).toLocaleString() : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

<!-- Server Egress Override -->
<Card title="Server Egress Override" subtitle="Per-engine proxy pin (overrides network egressNodeId)" class="mb-6">
  {#if !data?.servers?.length}
    <EmptyState icon="🖥️" title="No engines" description="No IRC engines registered yet." />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted">
            <th class="px-3 py-2">Engine ID</th>
            <th class="px-3 py-2">Current Override</th>
            <th class="px-3 py-2">Networks on Engine</th>
            <th class="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each data?.servers ?? [] as s}
            <tr class="border-b border-border/50 hover:bg-surface">
              <td class="px-3 py-2 font-mono text-xs">{s?.serverId || '—'}</td>
              <td class="px-3 py-2">
                {#if s?.egressNodeId}
                  <StatusBadge label={s.egressNodeId} tone="primary" size="sm" />
                {:else}
                  <StatusBadge label="— random" tone="muted" size="sm" />
                {/if}
              </td>
              <td class="px-3 py-2">{s?.networkCount ?? '—'}</td>
              <td class="px-3 py-2">
                <div class="flex items-center gap-1.5">
                  <select
                    bind:value={egressPick[s?.serverId ?? '']}
                    class="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
                    disabled={!data?.pool?.length}
                  >
                    <option value="">— pick —</option>
                    {#each data?.pool ?? [] as p}
                      <option value={p?.label ?? ''}>{p?.label ?? '—'} ({p?.host ?? '—'})</option>
                    {/each}
                  </select>
                  <button
                    onclick={() => doSetEgress(s?.serverId ?? '')}
                    class="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-fg disabled:opacity-50"
                    disabled={!egressPick[s?.serverId ?? '']}
                  >
                    Set
                  </button>
                  {#if s?.egressNodeId}
                    <button
                      onclick={() => (clearAsk = s?.serverId ?? '')}
                      class="rounded border border-border bg-surface-2 px-2 py-1 text-xs hover:border-danger/40"
                    >
                      Clear
                    </button>
                  {/if}
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if !data?.pool?.length}
      <div class="mt-2 text-xs text-muted">Pool empty — add sidecars before overriding.</div>
    {/if}
  {/if}
</Card>

<!-- Swap exit confirm -->
<ConfirmDialog
  open={exitAsk !== null}
  title="Move this exit?"
  message={exitAsk
    ? `Move slot ${exitAsk.label} to ${cityName(exitAsk.locationId)}? The sidecar's exit node is retargeted in place — the slot is idle, so no IRC connection is dropped. New connections pinned to the old city will land elsewhere until an exit is moved back.`
    : ''}
  confirmLabel="Move exit"
  tone="primary"
  onConfirm={confirmSwapExit}
  onCancel={() => (exitAsk = null)}
/>
<!-- Restart confirm -->
<ConfirmDialog
  open={restartAsk !== null}
  title="Restart sidecar?"
  message={restartAsk ? `Restart tailscale-mullvad-${restartAsk}? Brief egress blip (~2s) — IRC connections on this exit will reconnect.` : ''}
  confirmLabel="Restart"
  tone="warn"
  onConfirm={() => restartAsk && doRestart(restartAsk)}
  onCancel={() => (restartAsk = null)}
/>
<ConfirmDialog
  open={egressAsk !== null}
  title="Change server egress?"
  message={egressAsk ? `Pin engine ${egressAsk.serverId} to ${egressAsk.label}? Affected networks will reconnect to pick up the new exit.` : ''}
  confirmLabel="Pin"
  tone="primary"
  onConfirm={confirmSetEgress}
  onCancel={() => (egressAsk = null)}
/>
<ConfirmDialog
  open={clearAsk !== null}
  title="Clear server egress?"
  message={clearAsk ? `Clear egress override for ${clearAsk}? Networks will fall back to random/pool selection.` : ''}
  confirmLabel="Clear"
  tone="danger"
  onConfirm={() => clearAsk && confirmClear(clearAsk)}
  onCancel={() => (clearAsk = null)}
/>
