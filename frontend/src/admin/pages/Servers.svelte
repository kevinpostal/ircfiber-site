<script lang="ts">
  /**
   * Servers page — engine grid, host routing, network assignments.
   * Fetches from /api/admin/servers every 5s when polling is enabled.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import ServerGroup from '../components/ServerGroup.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative, duration } from '../lib/format';
  import { fibereyeIpHref, ipFamily } from '../lib/ipIntelLink';

  interface Engine {
    serverId: string;
    bindAddress: string;
    port: number;
    priority: number;
    maxConnections: number;
    fallbackOnly: boolean;
    assignedNetworks: string[];
    healthy: boolean;
    lastHeartbeat: number;
    ageSeconds: number;
    /** Unix ms of the engine's hot-swap detach stamp (0 = none). */
    hotswapAt?: number;
    /** True while the engine is detached for a hot swap (sessions held). */
    hotswapActive?: boolean;
    /** Holder build short hash; absent = pre-holder engine, no data. */
    holderVersion?: string;
    holderPid?: number;
    holderOpen?: number;
    holderAttached?: number;
    holderDetached?: number;
  }

  interface HostEntry {
    host: string;
    totalConns: number;
    serverIds: string[];
  }

  interface AssignmentEntry {
    networkId: string;
    serverId: string;
    networkName: string;
    networkHost: string;
    userId: string;
    username: string;
    nick: string;
    egressNodeId: string;
    activeEgressLabel: string;
    activeEgressHost: string;
    activeEgressIp: string;
    peerIp: string;
    localIp: string;
  }

  interface MullvadNode {
    id: string;
    label: string;
    host: string;
    port: number;
    socksUrl: string;
    ip: string;
    /** Current exit location — the value an egress pin now carries. Absent
     *  on a static slot whose location the engine cannot read. */
    locationId?: string;
    city?: string;
    country?: string;
  }
  interface ServersResponse {
    engines: Engine[];
    hosts: HostEntry[];
    assignments: AssignmentEntry[];
    maxConnsPerHost: number;
  }

  let data = $state<ServersResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let lastFetchedAt = $state<number | null>(null);
  let mullvadPool = $state<MullvadNode[]>([]);

  // Inline editing — which engine has its config form expanded
  let editingConfig = $state<Record<string, boolean>>({});

  let stop: (() => void) | null = null;

  onMount(() => {
    stop = startPolling(async () => {
      await fetchData();
      await fetchMullvad();
      lastFetchedAt = Date.now();
    });
  });
  onDestroy(() => stop?.());

  async function fetchData() {
    loading = true; error = null;
    try {
      data = await api.get<ServersResponse>('/api/admin/servers');
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function fetchMullvad() {
    try {
      const r = await api.get<{ pool: MullvadNode[] }>('/api/admin/mullvad/status');
      mullvadPool = r.pool ?? [];
    } catch {}
  }



  async function setEgress(networkId: string, label: string, egressNodeId: string) {
    try {
      await api.post(`/api/admin/networks/${encodeURIComponent(networkId)}/egress`, { egressNodeId });
      toastSuccess(`${label} egress → ${egressNodeId || 'Random'}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }



  // Compute derived stats — irc.ircfiber.com is unlimited (first-party, no per-IP cap)
  const healthyCount = $derived(data?.engines.filter((e) => e.healthy).length ?? 0);
  const totalNetworks = $derived(data?.engines.reduce((sum, e) => sum + e.assignedNetworks.length, 0) ?? 0);
  const hostsWithCalc = $derived((data?.hosts ?? []).map((h) => {
    const isUnlimited = h.host.toLowerCase() === 'irc.ircfiber.com';
    if (isUnlimited) return { ...h, cap: 0, fillPct: 0, isUnlimited: true as const };
    const cap = (data?.maxConnsPerHost ?? 5) * h.serverIds.length;
    const fillPct = cap > 0 ? Math.min((h.totalConns * 100) / cap, 100) : 0;
    return { ...h, cap, fillPct, isUnlimited: false as const };
  }));
  // Ghost rows (empty networkId) stay in their engine's group: grouping
  // keys off serverId, never networkId.
  const assignmentsByServer = $derived.by(() => {
    const m = new Map<string, AssignmentEntry[]>();
    for (const a of data?.assignments ?? []) {
      const key = a.serverId || 'unassigned';
      const list = m.get(key);
      if (list) list.push(a);
      else m.set(key, [a]);
    }
    return m;
  });
  // Deterministic order so groups don't jump on each 5 s poll.
  const orderedEngines = $derived([...(data?.engines ?? [])].sort((x, y) =>
    Number(y.healthy) - Number(x.healthy) || x.serverId.localeCompare(y.serverId),
  ));
  // Entries whose serverId matches no engine (or is empty) render as a
  // final Unassigned group instead of being dropped — never silently hide
  // networks.
  const orphanAssignments = $derived((data?.assignments ?? []).filter((a) => {
    const sid = a.serverId || 'unassigned';
    if (sid === 'unassigned') return true;
    return !(data?.engines ?? []).some((e) => e.serverId === sid);
  }));
  function groupRows(sid: string): AssignmentEntry[] {
    return assignmentsByServer.get(sid) ?? [];
  }
  function connText(e: Engine): string {
    return e.maxConnections > 0
      ? `${e.assignedNetworks.length}/${e.maxConnections} conns`
      : `${e.assignedNetworks.length}/∞ conns`;
  }
  // Alternate grouping: by IRC network (networkHost) instead of engine.
  // Persisted; defaults to engine view.
  const GROUP_BY_KEY = 'admin:servers:groupBy';
  function loadGroupBy(): 'engine' | 'network' {
    try {
      return localStorage.getItem(GROUP_BY_KEY) === 'network' ? 'network' : 'engine';
    } catch {
      return 'engine';
    }
  }
  let groupBy = $state<'engine' | 'network'>(loadGroupBy());
  function setGroupBy(mode: 'engine' | 'network') {
    groupBy = mode;
    try {
      localStorage.setItem(GROUP_BY_KEY, mode);
    } catch {
      // Shared-kiosk / private-mode admin: view stays session-only.
    }
  }
  function engineById(sid: string): Engine | undefined {
    return (data?.engines ?? []).find((e) => e.serverId === sid);
  }
  const assignmentsByHost = $derived.by(() => {
    const m = new Map<string, AssignmentEntry[]>();
    for (const a of data?.assignments ?? []) {
      const key = a.networkHost || '(unknown)';
      const list = m.get(key);
      if (list) list.push(a);
      else m.set(key, [a]);
    }
    return m;
  });
  // Deterministic order so groups don't jump on each 5 s poll.
  const orderedNetHosts = $derived([...assignmentsByHost.keys()].sort((a, b) => a.localeCompare(b)));
  function netGroupKey(host: string): string {
    return `net:${host}`;
  }
  function netEngines(rows: AssignmentEntry[]): string[] {
    return [...new Set(rows.map((a) => a.serverId || 'unassigned'))].sort((a, b) => a.localeCompare(b));
  }
  function netHealthy(rows: AssignmentEntry[]): boolean {
    return rows.every((a) => engineById(a.serverId)?.healthy ?? true);
  }

  // Per-group pagination: page index per group key, session-only.
  const PAGE_SIZE = 25;
  let pages = $state<Record<string, number>>({});
  function pageOf(key: string, total: number): number {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const p = pages[key] ?? 0;
    return Math.min(Math.max(p, 0), totalPages - 1);
  }
  function gotoPage(key: string, total: number, p: number) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pages[key] = Math.min(Math.max(p, 0), totalPages - 1);
  }

  // Collapse state: local, persisted, poll-safe. Never reset on fetchData.
  const EXPANDED_KEY = 'admin:servers:expanded';
  function loadExpanded(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, boolean>;
      }
      return {};
    } catch {
      return {};
    }
  }
  let expanded = $state<Record<string, boolean>>(loadExpanded());
  function persistExpanded() {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
    } catch {
      // Shared-kiosk / private-mode admin: folds stay session-only.
    }
  }
  // First healthy (else first) engine open by default in engine view.
  const defaultOpenId = $derived(
    (data?.engines ?? []).find((e) => e.healthy)?.serverId
      ?? data?.engines?.[0]?.serverId
      ?? null,
  );
  // All group keys in the current view (expand/collapse-all scope).
  const groupKeys = $derived(
    groupBy === 'engine'
      ? [...(data?.engines ?? []).map((e) => e.serverId), ...(orphanAssignments.length > 0 ? ['unassigned'] : [])]
      : orderedNetHosts.map(netGroupKey),
  );
  // First healthy engine (else first engine / first network) open by
  // default; Unassigned closed.
  const defaultOpenKey = $derived<string | null>(
    groupBy === 'engine'
      ? (defaultOpenId)
      : (orderedNetHosts.length > 0 ? netGroupKey(orderedNetHosts[0]) : null),
  );
  function isOpen(key: string): boolean {
    const stored = expanded[key];
    if (typeof stored === 'boolean') return stored;
    if (key === 'unassigned') return false;
    return key === defaultOpenKey;
  }
  function toggle(key: string) {
    expanded[key] = !isOpen(key);
    persistExpanded();
  }
  function expandAll() {
    for (const k of groupKeys) expanded[k] = true;
    persistExpanded();
  }
  function collapseAll() {
    for (const k of groupKeys) expanded[k] = false;
    persistExpanded();
  }
  const totalGroups = $derived(groupKeys.length);
  const openCount = $derived(groupKeys.filter((k) => isOpen(k)).length);
  async function reassignAll(sid: string, count: number) {
    if (!confirm(`Reassign all ${count} networks from ${sid}?`)) return;
    try {
      const res = await api.post<{ reassigned: number }>(`/api/admin/servers/${sid}/reassign`);
      toastSuccess(`Reassigned ${res.reassigned} networks`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function saveConfig(sid: string) {
    const form = document.getElementById(`engine-config-${sid}`) as HTMLFormElement;
    if (!form) return;
    const fd = new FormData(form);
    try {
      await api.post(`/api/admin/servers/${sid}/config`, {
        priority: parseInt(fd.get('priority') as string) || 0,
        maxConnections: parseInt(fd.get('maxConnections') as string) || 0,
        fallbackOnly: fd.get('fallbackOnly') === 'true',
      });
      toastSuccess(`Updated config for ${sid}`);
      editingConfig[sid] = false;
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function reassignAssignment(networkId: string, label: string, from: string) {
    if (!confirm(`Reassign network ${label} from ${from} to a different engine?`)) return;
    try {
      const res = await api.post<{ newServerId: string }>(`/api/admin/servers/assignments/${networkId}/reassign`);
      toastSuccess(`Reassigned ${label} to ${res.newServerId}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function disconnectAssignment(networkId: string, host: string, label: string) {
    if (!confirm(`Disconnect ${label} from ${host}? The connection will be closed but the network config is kept.`)) return;
    try {
      await api.post(`/api/admin/servers/host/${encodeURIComponent(host)}/disconnect/${networkId}`);
      toastSuccess(`Disconnected ${label}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function removeAssignment(networkId: string, label: string) {
    if (!confirm(`Remove assignment for ${label}? The gateway will re-route on the next message.`)) return;
    try {
      await api.post(`/api/admin/servers/assignments/${networkId}/remove`);
      toastSuccess(`Removed assignment for ${label}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function deleteAssignment(networkId: string, label: string) {
    // Two-stage confirm: the first confirm asks whether the operator
    // really wants a destructive full-delete (Mongo + Redis + engine
    // stop). The second confirm demands they type the network label
    // back — a typo on a destructive action would be expensive to
    // reverse (lost scrollback, lost auto-join list, lost SASL creds).
    const isOrphanRow = !networkId || networkId.length === 0;
    const firstPrompt = isOrphanRow
      ? `Remove the ghost row "${label}" from the engine's assignment table? This scrubs the orphan entry from the engine's server record (no Mongo record to delete, no engine client to stop).`
      : `Permanently delete network "${label}"? This stops the engine client, scrubs Redis state (scrollback, lease, fail counter), and removes the MongoDB config. The user must re-add the network to bring it back.`;
    if (!confirm(firstPrompt)) return;
    const typed = prompt(`Type the network label "${label}" to confirm deletion:`);
    if (typed !== label) {
      toastError('Delete aborted — label did not match.');
      return;
    }
    try {
      const url = networkId
        ? `/api/admin/servers/assignments/delete?networkId=${encodeURIComponent(networkId)}`
        : `/api/admin/servers/assignments/delete`;
      const body = networkId ? undefined : ({ networkId } as any);
      const res = await api.post<{ networkId: string; serverId: string; scrubbed: boolean }>(url, body as any);
      toastSuccess(`Deleted ${label}${res.serverId ? ` (was on ${res.serverId})` : ''}`);
      await fetchData();
    } catch (e) {
      toastError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function saveRouting() {
    const form = document.getElementById('routing-form') as HTMLFormElement;
    if (!form) return;
    const fd = new FormData(form);
    const val = parseInt(fd.get('maxConnsPerHost') as string) || 0;
    if (val <= 0) { toastError('Must be > 0'); return; }
    try {
      await api.post('/api/admin/routing', { maxConnsPerHost: val });
      toastSuccess(`Max conns per host set to ${val}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }
</script>

<PageHeader
  title="Servers &amp; Routing"
  subtitle="IRC engines, host capacity, network assignments"
/>

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<!-- KPIs -->
<div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
  <KpiCard label="Total Engines" value={data?.engines.length ?? '—'} loading={loading && !data} />
  <KpiCard
    label="Healthy Engines"
    value={`${healthyCount}/${data?.engines.length ?? 0}`}
    tone={healthyCount === (data?.engines.length ?? 0) && (data?.engines.length ?? 0) > 0 ? 'success' : healthyCount > 0 ? 'warn' : 'danger'}
    loading={loading && !data}
  />
  <KpiCard label="Max Conns / Host" value={data?.maxConnsPerHost ?? '—'} loading={loading && !data} />
  <KpiCard label="Total Networks" value={totalNetworks} loading={loading && !data} />
</div>

<!-- Server groups: one collapsible group per engine (header = health +
     name + counts; body = engine detail + that engine's networks) -->
{#snippet assignmentTable(rows: AssignmentEntry[], pageKey: string)}
  {#if rows.length}
    {@const page = pageOf(pageKey, rows.length)}
    {@const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))}
    {@const start = page * PAGE_SIZE}
    {@const pageRows = rows.slice(start, start + PAGE_SIZE)}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">Network</th>
          <th class="py-2 text-left font-semibold">IRC Nick</th>
          <th class="py-2 text-left font-semibold">Owner</th>
          <th class="py-2 text-left font-semibold">Server</th>
          <th class="py-2 text-left font-semibold">Pinned Egress</th>
          <th class="py-2 text-left font-semibold">Active Egress</th>
          <th class="py-2 text-right font-semibold">Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each pageRows as a, i (a.networkId || 'ghost-' + (start + i))}
          {@const label = a.networkName || a.networkHost || '(unnamed)'}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2">
              <div class="font-medium text-heading">{label}</div>
              {#if a.networkHost && a.networkHost !== label}
                <div class="font-mono text-[11px] text-muted">{a.networkHost}</div>
              {/if}
              <div class="font-mono text-[10px] text-muted opacity-70">{a.networkId}</div>
            </td>
            <td class="py-2">
              {#if a.nick}
                <span class="font-mono text-xs text-text">{a.nick}</span>
              {:else}
                <span class="text-[11px] text-muted">offline</span>
              {/if}
            </td>
            <td class="py-2">
              {#if a.username}
                <a href="#/users/{a.userId}" class="text-primary hover:underline">{a.username}</a>
              {:else}
                <span class="text-muted text-xs">orphan</span>
              {/if}
            </td>
            <td class="py-2">
              <StatusBadge label={a.serverId} tone="info" size="sm" />
            </td>
            <td class="py-2">
              <select
                class="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text"
                value={a.egressNodeId || ''}
                onchange={(e) => setEgress(a.networkId, label, (e.target as HTMLSelectElement).value)}
              >
                <option value="">Random</option>
                {#each mullvadPool.filter((n) => !!n.locationId) as n (n.id)}
                  <option value={n.locationId}>
                    {n.city ? `${n.city}, ${n.country}` : n.locationId}
                  </option>
                {/each}
              </select>
            </td>
            <td class="py-2">
              {#if a.activeEgressLabel}
                <div class="flex flex-col gap-0.5" title="{a.activeEgressHost}{a.activeEgressIp ? ' / ' + a.activeEgressIp : ''}">
                  <span class="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-[11px] font-semibold text-success border border-success/20">
                    <span class="h-2 w-2 rounded-full bg-success"></span>
                    {a.activeEgressLabel.toUpperCase()}
                  </span>
                  <span class="font-mono text-[10px] leading-tight text-muted">{a.activeEgressHost}</span>
                  {#if a.activeEgressIp}
                    {@const egressLink = fibereyeIpHref(a.activeEgressIp)}
                    {#if egressLink}
                      <a href={egressLink} class="font-mono text-[10px] leading-tight text-primary hover:underline">{a.activeEgressIp}</a>
                    {:else}
                      <span class="font-mono text-[10px] leading-tight text-muted">{a.activeEgressIp}</span>
                    {/if}
                  {/if}
                </div>
              {:else}
                <div class="flex flex-col gap-0.5">
                  <span class="inline-flex items-center gap-1">
                    <span class="inline-flex items-center gap-1 rounded bg-border px-1.5 py-0.5 text-[11px] font-medium text-muted border border-border" title="Direct — no Mullvad SOCKS, host IP">
                      <span class="h-2 w-2 rounded-full bg-muted"></span>
                      direct
                    </span>
                    {#if a.peerIp}
                      <span
                        class="rounded px-1.5 py-0.5 text-[10px] font-semibold border {ipFamily(a.peerIp) === 'IPv6' ? 'bg-success/10 text-success border-success/20' : 'bg-warn/10 text-warn border-warn/20'}"
                        title={ipFamily(a.peerIp) === 'IPv6' ? 'Connected over IPv6 (AAAA record won the Happy Eyeballs race)' : 'Connected over IPv4 — server has no AAAA record or IPv6 lost the race'}
                      >{ipFamily(a.peerIp)}</span>
                    {/if}
                  </span>
                  {#if a.peerIp}
                    {@const peerLink = fibereyeIpHref(a.peerIp)}
                    {#if peerLink}
                      <a href={peerLink} class="font-mono text-[10px] leading-tight text-primary hover:underline" title="Remote IRC server address">→ {a.peerIp}</a>
                    {:else}
                      <span class="font-mono text-[10px] leading-tight text-muted" title="Remote IRC server address">→ {a.peerIp}</span>
                    {/if}
                  {/if}
                  {#if a.localIp}
                    {@const localLink = fibereyeIpHref(a.localIp)}
                    {#if localLink}
                      <a href={localLink} class="font-mono text-[10px] leading-tight text-primary hover:underline" title="Local source address (per-user IPv6 bind, or the shared host/NAT66 address)">← {a.localIp}</a>
                    {:else}
                      <span class="font-mono text-[10px] leading-tight text-muted" title="Local source address (per-user IPv6 bind, or the shared host/NAT66 address)">← {a.localIp}</span>
                    {/if}
                  {/if}
                </div>
              {/if}
            </td>
            <td class="py-2 text-right whitespace-nowrap">
              {#if a.networkHost}
                <button
                  type="button"
                  onclick={() => disconnectAssignment(a.networkId, a.networkHost, label)}
                  class="rounded border border-warn/30 px-2 py-1 text-[11px] font-medium text-warn hover:bg-warn/10"
                >
                  Disconnect
                </button>
              {/if}
              <button
                type="button"
                onclick={() => reassignAssignment(a.networkId, label, a.serverId)}
                class="ml-1 rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text hover:border-primary/40"
              >
                Reassign
              </button>
              <button
                type="button"
                onclick={() => removeAssignment(a.networkId, label)}
                class="ml-1 rounded border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
              >
                Remove
              </button>
              <button
                type="button"
                onclick={() => deleteAssignment(a.networkId, label)}
                class="ml-1 rounded border border-danger/60 bg-danger/10 px-2 py-1 text-[11px] font-semibold text-danger hover:bg-danger/20"
                title={a.networkId ? 'Permanently delete network config + engine client + Redis state' : 'Scrub ghost row from engine assignedNetworks'}
              >
                Delete
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if totalPages > 1}
      <div class="mt-2 flex items-center gap-3 text-xs text-muted">
        <button
          type="button"
          data-testid="servers-page-prev-{pageKey}"
          onclick={() => gotoPage(pageKey, rows.length, page - 1)}
          disabled={page === 0}
          class="font-medium text-primary hover:underline disabled:text-muted disabled:no-underline"
        >
          ← Prev
        </button>
        <span data-testid="servers-page-label-{pageKey}">Page {page + 1} of {totalPages} · {rows.length} connections</span>
        <button
          type="button"
          data-testid="servers-page-next-{pageKey}"
          onclick={() => gotoPage(pageKey, rows.length, page + 1)}
          disabled={page >= totalPages - 1}
          class="font-medium text-primary hover:underline disabled:text-muted disabled:no-underline"
        >
          Next →
        </button>
      </div>
    {/if}
  {:else}
    <p class="text-xs text-muted">No connections in this group.</p>
  {/if}
{/snippet}

<div class="mb-3 flex items-center gap-3 text-xs">
  <span class="text-muted">Group by:</span>
  <button
    type="button"
    data-testid="servers-groupby-engine"
    aria-pressed={groupBy === 'engine'}
    onclick={() => setGroupBy('engine')}
    class="font-medium {groupBy === 'engine' ? 'text-heading underline' : 'text-primary hover:underline'}"
  >
    Engine
  </button>
  <button
    type="button"
    data-testid="servers-groupby-network"
    aria-pressed={groupBy === 'network'}
    onclick={() => setGroupBy('network')}
    class="font-medium {groupBy === 'network' ? 'text-heading underline' : 'text-primary hover:underline'}"
  >
    Network
  </button>
  <span class="text-border">|</span>
  <button
    type="button"
    data-testid="servers-expand-all"
    onclick={expandAll}
    class="font-medium text-primary hover:underline"
  >
    Expand all
  </button>
  <button
    type="button"
    data-testid="servers-collapse-all"
    onclick={collapseAll}
    class="font-medium text-primary hover:underline"
  >
    Collapse all
  </button>
  <span class="ml-auto text-muted">{openCount} of {totalGroups} open</span>
</div>

{#if groupBy === 'engine'}
{#if orderedEngines.length || orphanAssignments.length}
  <div class="space-y-4">
    {#each orderedEngines as engine (engine.serverId)}
      {@const engCap = engine.maxConnections > 0 ? engine.maxConnections : 0}
      {@const pct = engCap > 0 ? Math.min((engine.assignedNetworks.length * 100) / engCap, 100) : 0}
      {@const rows = groupRows(engine.serverId)}
      <ServerGroup
        serverId={engine.serverId}
        healthy={engine.healthy}
        hotswapActive={engine.hotswapActive}
        networkCount={rows.length}
        connText={connText(engine)}
        open={isOpen(engine.serverId)}
        onToggle={() => toggle(engine.serverId)}
      >
        {#snippet meta()}
          <div class="flex flex-wrap items-center gap-4 text-xs text-muted">
            <span class="font-mono">{engine.bindAddress}:{engine.port}</span>
            <span class="whitespace-nowrap">
              Engine load:
              <span class="ml-1 inline-flex items-center gap-1">
                <span class="h-2 w-20 rounded-full bg-border">
                  <span
                    class="block h-full rounded-full transition-all {pct >= 100 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-success'}"
                    style="width: {pct}%"
                  ></span>
                </span>
                <span class="font-mono text-text">{engine.assignedNetworks.length}{engCap > 0 ? `/${engCap}` : ''}</span>
              </span>
            </span>
            <span class="text-muted">{engCap > 0 ? 'engine cap' : 'no engine cap'}</span>
            <span>Priority: <strong class="text-text">{engine.priority}</strong></span>
            {#if engine.fallbackOnly}
              <StatusBadge label="FALLBACK" tone="warn" size="sm" />
            {/if}
            <span>
              Last heartbeat:
              <strong class="text-text">{duration(engine.ageSeconds * 1000)} ago</strong>
            </span>
            {#if engine.holderVersion}
              <span
                class="font-mono text-[11px]"
                title="Holder process {engine.holderPid ?? '—'} serving {engine.serverId}"
              >
                <span class="font-medium text-muted">Holder:</span>
                {engine.holderVersion.slice(0, 7)} · pid {engine.holderPid ?? '—'} · {engine.holderOpen ?? 0} open / {engine.holderAttached ?? 0} attached{#if (engine.holderDetached ?? 0) > 0}<span class="text-warn"> · {engine.holderDetached} detached</span>{/if}
              </span>
            {:else}
              <span class="text-muted">Holder: —</span>
            {/if}
            <span class="font-mono text-[11px]" title="Full hash: {engine.gitHash ?? ''}">
              {#if engine.gitShort}
                <span class="font-medium text-muted">Commit:</span> {engine.gitShort}
                {#if engine.gitBranch}<span class="text-muted"> ({engine.gitBranch})</span>{/if}
                <span class="text-muted"> · {engine.gitDescribe ?? ''}</span>
                {#if engine.version}<span class="text-muted"> · v{engine.version}</span>{/if}
              {:else}
                <span class="text-muted">no version</span>
              {/if}
              {#if engine.buildTime}
                <span class="ml-2 font-medium text-muted">Built:</span> <span class="text-muted">{new Date(engine.buildTime).toLocaleString()}</span>
              {/if}
            </span>
            {#if engine.assignedNetworks.length > 0}
              <button
                type="button"
                onclick={() => reassignAll(engine.serverId, engine.assignedNetworks.length)}
                class="ml-auto rounded-md border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
              >
                Reassign All
              </button>
            {/if}
          </div>
        {/snippet}
        <form
          id={`engine-config-${engine.serverId}`}
          class="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3 text-xs"
          onsubmit={(e) => { e.preventDefault(); saveConfig(engine.serverId); }}
        >
          <div>
            <label for="priority" class="block text-muted">Priority</label>
            <input id="priority" type="number" name="priority" value={engine.priority}
              class="mt-0.5 w-16 rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
          </div>
          <div>
            <label for="maxConnections" class="block text-muted">Engine Cap</label>
            <input id="maxConnections" type="number" name="maxConnections" value={engine.maxConnections} min="0"
              class="mt-0.5 w-16 rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
            <div class="text-[10px] text-muted">0 = unlimited</div>
          </div>
          <div>
            <label for="fallbackOnly" class="block text-muted">Fallback</label>
            <select id="fallbackOnly" name="fallbackOnly"
              class="mt-0.5 rounded border border-border bg-surface px-2 py-1 text-xs text-text">
              <option value="false" selected={!engine.fallbackOnly}>No</option>
              <option value="true" selected={engine.fallbackOnly}>Yes</option>
            </select>
          </div>
          <button type="submit"
            class="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90">
            Save
          </button>
        </form>
        <div class="mt-3 border-t border-border pt-3">
          {@render assignmentTable(rows, engine.serverId)}
        </div>
      </ServerGroup>
    {/each}
    {#if orphanAssignments.length}
      <ServerGroup
        serverId="unassigned"
        title="Unassigned / orphaned"
        healthy={false}
        statusLabel="Orphaned"
        statusTone="warn"
        networkCount={orphanAssignments.length}
        connText="orphaned"
        open={isOpen('unassigned')}
        onToggle={() => toggle('unassigned')}
      >
        {@render assignmentTable(orphanAssignments, 'unassigned')}
      </ServerGroup>
    {/if}
  </div>
{:else}
  <EmptyState icon="🖥️" title="No engines registered" description="Start an IRC engine to see it appear here." />
{/if}
{:else}
  {#if orderedNetHosts.length}
    <div class="space-y-4">
      {#each orderedNetHosts as host (host)}
        {@const nrows = assignmentsByHost.get(host) ?? []}
        {@const engs = netEngines(nrows)}
        {@const nkey = netGroupKey(host)}
        <ServerGroup
          serverId={nkey}
          title={host}
          healthy={netHealthy(nrows)}
          statusLabel={engs.length === 1 ? engs[0] : `${engs.length} engines`}
          statusTone="info"
          networkCount={nrows.length}
          connText={engs.length === 1 ? `on ${engs[0]}` : `across ${engs.length} engines`}
          open={isOpen(nkey)}
          onToggle={() => toggle(nkey)}
        >
          {@render assignmentTable(nrows, nkey)}
        </ServerGroup>
      {/each}
    </div>
  {:else}
    <p class="text-xs text-muted">No connections assigned.</p>
  {/if}
{/if}

<!-- Host Connection Routing -->
<Card title="Host Connection Routing" subtitle="Per-host capacity across engines">
  {#snippet actions()}
    <form id="routing-form" class="flex items-center gap-2 text-xs" onsubmit={(e) => { e.preventDefault(); saveRouting(); }}>
      <label for="maxConnsPerHost" class="text-muted">Cap:</label>
      <input id="maxConnsPerHost" type="number" name="maxConnsPerHost" value={data?.maxConnsPerHost ?? 5}
        class="w-16 rounded border border-border bg-surface px-2 py-1 text-center text-xs text-text" />
      <button type="submit" class="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-fg hover:bg-primary/90">
        Set
      </button>
    </form>
  {/snippet}
  {#if data?.hosts?.length}
    <table class="w-full text-sm">
      <thead class="text-xs uppercase tracking-wider text-muted">
        <tr class="border-b border-border">
          <th class="py-2 text-left font-semibold">IRC Host</th>
          <th class="py-2 text-right font-semibold">Total Connections</th>
          <th class="py-2 text-center font-semibold">Servers</th>
          <th class="py-2 text-right font-semibold">Status</th>
        </tr>
      </thead>
      <tbody>
        {#each hostsWithCalc as h (h.host)}
          <tr class="border-b border-border/40 hover:bg-surface/40">
            <td class="py-2">
              <a href="#/servers/host/{h.host}" class="font-mono text-primary hover:underline">{h.host}</a>
            </td>
            <td class="py-2 text-right font-semibold text-text">{h.totalConns}</td>
            <td class="py-2 text-center text-muted">{h.serverIds.length}</td>
            <td class="py-2 text-right">
              <span class="inline-flex items-center gap-1 text-xs">
                <span class="h-2 w-20 rounded-full bg-border">
                  <span
                    class="block h-full rounded-full {h.isUnlimited ? 'bg-success' : h.fillPct >= 100 ? 'bg-danger' : h.fillPct >= 75 ? 'bg-warn' : 'bg-success'}"
                    style="width: {h.isUnlimited ? 0 : h.fillPct}%"
                  ></span>
                </span>
                <span class="font-mono">{h.isUnlimited ? `${h.totalConns}/∞` : `${h.totalConns}/${h.cap}`}</span>
                {#if h.isUnlimited}<span class="ml-1 text-[10px] text-success">unlimited</span>{/if}
              </span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <EmptyState icon="🔗" title="No hosts" description="No IRC host routing data yet." />
  {/if}
</Card>
