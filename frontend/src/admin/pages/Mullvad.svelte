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
    testIrcThroughProxy,
    mullvadIrcTesting,
    mullvadIrcResults,
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
  let ircTesting = $state($mullvadIrcTesting);
  $effect(() => { ircTesting = $mullvadIrcTesting; });
  let ircResults = $state($mullvadIrcResults);
  $effect(() => { ircResults = $mullvadIrcResults; });

  let liveTab = $state('all');
  let expandedUsage = $state<Record<string, boolean>>({});
  let showAssocAll = $state<Record<string, boolean>>({});
  let restartAsk = $state<string | null>(null);
  let egressAsk = $state<{ serverId: string; label: string } | null>(null);
  let clearAsk = $state<string | null>(null);
  let egressPick = $state<Record<string, string>>({});
  /// Per-slot target city for the "swap exit" control, keyed by slot label.
  let exitPick = $state<Record<string, string>>({});
  // `affected` carries the live-connection count so the confirm can say what
  // the move costs; `force` is set once the operator has agreed to it.
  let exitAsk = $state<{ label: string; locationId: string; affected: number } | null>(null);
  /// Host the "Test IRC" probe dials through each slot. Defaults to the
  /// first-party ircd; an operator chasing a Z-line points it at the network
  /// that is refusing them.
  let ircProbeHost = $state('irc.ircfiber.com');
  /// Shown by the "Add exit" dialog — slots are provisioned at deploy time.
  let showAddExit = $state(false);
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
    const slot = (data?.pool ?? []).find((p) => p.label === label);
    exitAsk = { label, locationId, affected: slot?.activeConns ?? 0 };
  }
  async function confirmSwapExit() {
    if (!exitAsk) return;
    const { label, locationId, affected } = exitAsk;
    try {
      // A slot carrying connections needs the operator's explicit override —
      // the server refuses the unforced call with 409 + needsForce.
      await swapSlotExit(label, locationId, affected > 0);
      toastSuccess(
        affected > 0
          ? `Slot ${label} → ${cityName(locationId)} — ${affected} connection${affected === 1 ? '' : 's'} reconnecting`
          : `Slot ${label} → ${cityName(locationId)} — switching…`
      );
      exitPick[label] = '';
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      exitAsk = null;
    }
  }

  async function doIrcTest(label: string) {
    try {
      // The field takes `host` or `host:port` — a network on a non-standard
      // plain port (or a local fixture ircd) is the common case when an
      // operator is chasing a blocked exit.
      const raw = (ircProbeHost || '').trim();
      const colon = raw.lastIndexOf(':');
      const host = colon > 0 ? raw.slice(0, colon) : raw;
      const port = colon > 0 ? Number(raw.slice(colon + 1)) : undefined;
      const res = await testIrcThroughProxy(label, host || undefined,
        Number.isFinite(port) && port ? port : undefined);
      if (res.registered) {
        toastSuccess(`${label}: IRC OK via ${res.serverName || res.host} (${res.ms} ms)`);
      } else {
        toastError(`${label}: ${res.error || 'IRC unreachable'}`);
      }
    } catch (e) {
      toastError((e as Error).message);
    }
  }

  let stop: (() => void) | null = null;

  const healthyCount = $derived((data?.pool ?? []).filter((p) => p.healthy).length);
  /// Slots am.i.mullvad.net confirmed are exiting through a Mullvad relay.
  /// This is the licence check: a healthy slot that reports false is going
  /// out on the host's own IP, which means the tailnet Mullvad grant or a
  /// licence seat is missing for that device.
  const mullvadVerified = $derived((data?.pool ?? []).filter((p) => p.mullvadExit === true).length);
  /// Suggests the next free single-letter-ish slot name for the add-exit
  /// runbook, so the operator does not have to guess one that is unused.
  const nextSlotLabel = $derived.by(() => {
    const used = new Set((data?.pool ?? []).map((p) => p.label));
    for (const c of ['de2', 'nl', 'se', 'uk', 'fr', 'ca', 'jp', 'au']) if (!used.has(c)) return c;
    return `slot${(data?.pool?.length ?? 0) + 1}`;
  });
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
    <button
      type="button"
      onclick={() => (showAddExit = true)}
      class="ml-2 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface"
    >
      Add exit…
    </button>
  {/snippet}
</PageHeader>

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<!-- KPIs -->
<div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-5">
  <KpiCard label="Total proxies" value={data?.pool?.length ?? '—'} loading={loading && !data} icon="🛡️" />
  <KpiCard label="Healthy" value={healthyCount} loading={loading && !data} icon="✅" tone={data && healthyCount < (data?.pool?.length ?? 0) ? 'warn' : 'success'} />
  <KpiCard
    label="Mullvad verified"
    value={data ? `${mullvadVerified}/${data?.pool?.length ?? 0}` : '—'}
    loading={loading && !data}
    icon="🔐"
    tone={data && mullvadVerified < (data?.pool?.length ?? 0) ? 'warn' : 'success'}
  />
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
    <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <label class="text-muted" for="mullvad-irc-probe-host">Test IRC target</label>
      <input
        id="mullvad-irc-probe-host"
        class="w-56 rounded border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text"
        bind:value={ircProbeHost}
        placeholder="irc.ircfiber.com or host:port"
      />
      <span class="text-muted">
        port 6667 · each “Test IRC” dials this host through that slot and registers for real,
        so a Z-lined or blocked exit shows up as a failure instead of “healthy”.
      </span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted">
            <th class="px-3 py-2">Exit location</th>
            <th class="px-3 py-2">Container</th>
            <th class="px-3 py-2">SOCKS URL</th>
            <th class="px-3 py-2">Resolved IP</th>
            <th class="px-3 py-2">Exit IP</th>
            <th class="px-3 py-2">Mullvad</th>
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
                {#if p.mullvadExit === true}
                  <StatusBadge label="Mullvad" tone="success" size="sm" />
                  {#if p.mullvadHostname}<div class="mt-1 font-mono text-[10px] text-muted">{p.mullvadHostname}</div>{/if}
                {:else if p.healthy}
                  <StatusBadge label="not Mullvad" tone="danger" size="sm" />
                  <div class="mt-1 max-w-[18ch] text-[10px] text-muted"
                       title="am.i.mullvad.net says this traffic did not leave through a Mullvad relay — the tailnet grant or a licence seat is missing for this device">
                    {p.organization || 'host uplink'}
                  </div>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
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
                      disabled={swapping.has(p.label) || p.state === 'retargeting'}
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
                      disabled={!exitPick[p.label] || swapping.has(p.label) || p.state === 'retargeting'}
                      title={(p.activeConns ?? 0) > 0
                        ? `Carrying ${p.activeConns} live connection(s) — they reconnect through the new city`
                        : 'Move this exit to another Mullvad city'}
                    >
                      {swapping.has(p.label) || p.state === 'retargeting' ? 'Switching…' : 'Swap'}
                    </button>
                  </div>
                  {#if (p.activeConns ?? 0) > 0}
                    <div class="mt-1 text-[10px] text-muted">
                      in use by {p.activeConns} connection{p.activeConns === 1 ? '' : 's'} — they reconnect on the new exit
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
                    onclick={() => doIrcTest(p.label)}
                    class="rounded border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium hover:border-primary/40 disabled:opacity-50"
                    disabled={ircTesting.has(p.label)}
                    title={`SOCKS5 + real NICK/USER registration against ${ircProbeHost} through this exit`}
                  >
                    {ircTesting.has(p.label) ? 'Dialing…' : 'Test IRC'}
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
                {#if ircResults[p.label]}
                  {@const r = ircResults[p.label]}
                  <div class="mt-1 text-[10px] {r.registered ? 'text-success' : 'text-danger'}"
                       title={r.welcome || r.error}>
                    {r.registered
                      ? `IRC ok · ${r.serverName || r.host} · ${r.ms} ms`
                      : `IRC failed · ${(r.error || '').slice(0, 60)}`}
                  </div>
                {/if}
              </td>
            </tr>
            <!-- per-proxy usage collapsed row -->
            <tr class="border-b border-border/30 bg-bg/30">
              <td colspan="10" class="px-3 py-2">
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
  title={exitAsk && exitAsk.affected > 0 ? 'Move an exit that is in use?' : 'Move this exit?'}
  message={exitAsk
    ? (exitAsk.affected > 0
        ? `Move slot ${exitAsk.label} to ${cityName(exitAsk.locationId)}? ${exitAsk.affected} live IRC connection${exitAsk.affected === 1 ? '' : 's'} ${exitAsk.affected === 1 ? 'rides' : 'ride'} this exit — they are reconnected through ${cityName(exitAsk.locationId)} immediately (a few seconds of downtime each) instead of stalling on a path the sidecar no longer uses.`
        : `Move slot ${exitAsk.label} to ${cityName(exitAsk.locationId)}? The sidecar's exit node is retargeted in place and the slot is idle, so no IRC connection is touched.`)
    : ''}
  confirmLabel={exitAsk && exitAsk.affected > 0 ? 'Move and reconnect' : 'Move exit'}
  tone={exitAsk && exitAsk.affected > 0 ? 'warn' : 'primary'}
  onConfirm={confirmSwapExit}
  onCancel={() => (exitAsk = null)}
/>

<!-- Add exit: slots are deploy-provisioned, so this is a runbook, not a
     button that pretends to create a container. The gateway has no docker
     socket on purpose (see engine deploy role) and the Mullvad add-on grants
     exit-node access per DEVICE, so a new sidecar also needs a free seat. -->
{#if showAddExit}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
       role="presentation"
       onclick={() => (showAddExit = false)}>
    <div class="w-full max-w-2xl rounded-lg border border-border bg-surface shadow-2xl"
         role="dialog" aria-modal="true" aria-labelledby="add-exit-title"
         tabindex="-1"
         onkeydown={(e) => { if (e.key === 'Escape') showAddExit = false; }}
         onclick={(e) => e.stopPropagation()}>
      <div class="border-b border-border px-5 py-4">
        <h2 id="add-exit-title" class="text-base font-semibold text-heading">Add an exit</h2>
      </div>
      <div class="space-y-3 px-5 py-4 text-sm text-text">
        <p>
          You usually do not need one: each of the {data?.pool?.length ?? 0} slots can be moved to
          any of the {data?.locations?.length ?? 0} Mullvad cities with <b>Swap</b> above, live.
          Add a slot only to run more cities <i>at the same time</i>.
        </p>
        <p class="text-muted">
          A slot is a tailscale sidecar container on the engine host plus a shared
          control volume — created by the deploy, not from here (the gateway has no
          docker socket by design). Each sidecar also consumes one Mullvad
          <b>device</b> seat on the tailnet add-on; when the seats run out the new
          sidecar comes up healthy but exits on the host's own IP, which the
          <b>Mullvad</b> column above will show as “not Mullvad”.
        </p>
        <div>
          <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
            1 · add the slot to both inventories
          </div>
          <pre class="overflow-x-auto rounded border border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed">{`# site/deploy/inventories/production/host_vars/vps-efb4b52d.yml
# engine/deploy/inventories/production/group_vars/all/vars.yml   (keep identical)
mullvad_sidecars:
${(data?.pool ?? []).map((p) => `  - { name: "${p.label}", exit_node: "<relay tailnet IP>", port: 1055 }`).join('\n')}
  - { name: "${nextSlotLabel}", exit_node: "<relay tailnet IP>", port: 1055 }`}</pre>
        </div>
        <div>
          <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
            2 · deploy the engine (recreates the container set)
          </div>
          <pre class="overflow-x-auto rounded border border-border bg-bg px-3 py-2 font-mono text-[11px]">cd engine/deploy &amp;&amp; ansible-playbook playbooks/deploy-engine.yml -l vps-efb4b52d</pre>
        </div>
        <div>
          <div class="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">
            3 · confirm the licence covers it
          </div>
          <p class="text-muted">
            Come back here and hit <b>Test all</b>: the new slot must show
            <b>Mullvad</b> (green) — that is am.i.mullvad.net confirming the traffic
            left through a Mullvad relay. Then <b>Test IRC</b> proves it can actually
            reach an ircd. “not Mullvad” means the tailnet ACL grant
            (<code>nodeAttrs: mullvad</code>) or a device seat is missing.
          </p>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
        <button type="button"
                class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-medium hover:bg-border"
                onclick={() => (showAddExit = false)}>Close</button>
      </div>
    </div>
  </div>
{/if}
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
