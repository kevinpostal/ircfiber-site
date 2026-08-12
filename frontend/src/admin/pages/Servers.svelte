<script lang="ts">
  /**
   * Servers page — engine grid, host routing, network assignments.
   * Fetches from /api/admin/servers every 5s when polling is enabled.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative, duration } from '../lib/format';

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
  }

  interface MullvadNode {
    id: string;
    label: string;
    host: string;
    port: number;
    socksUrl: string;
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



  // Compute derived stats
  const healthyCount = $derived(data?.engines.filter((e) => e.healthy).length ?? 0);
  const totalNetworks = $derived(data?.engines.reduce((sum, e) => sum + e.assignedNetworks.length, 0) ?? 0);
  const hostsWithCalc = $derived((data?.hosts ?? []).map((h) => {
    const cap = (data?.maxConnsPerHost ?? 5) * h.serverIds.length;
    const fillPct = cap > 0 ? Math.min((h.totalConns * 100) / cap, 100) : 0;
    return { ...h, cap, fillPct };
  }));

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
      const res = await api.post<{ networkId: string; serverId: string; scrubbed: boolean }>(
        `/api/admin/servers/assignments/${encodeURIComponent(networkId)}/delete`
      );
      toastSuccess(`Deleted ${label}${res.serverId ? ` (was on ${res.serverId})` : ''}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
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
  <KpiCard label="Total Engines" value={data?.engines.length ?? '—'} loading={loading && !data} icon="🖥️" />
  <KpiCard
    label="Healthy Engines"
    value={`${healthyCount}/${data?.engines.length ?? 0}`}
    tone={healthyCount === (data?.engines.length ?? 0) && (data?.engines.length ?? 0) > 0 ? 'success' : healthyCount > 0 ? 'warn' : 'danger'}
    loading={loading && !data}
    icon="❤️"
  />
  <KpiCard label="Max Conns / Host" value={data?.maxConnsPerHost ?? '—'} loading={loading && !data} icon="🔗" />
  <KpiCard label="Total Networks" value={totalNetworks} loading={loading && !data} icon="🌐" />
</div>

<!-- Engine Status -->
<Card title="Engine Status" subtitle={`${data?.engines.length ?? 0} engines registered`}>
  {#if data?.engines?.length}
    <div class="space-y-4">
      {#each data.engines as engine (engine.serverId)}
        {@const engCap = engine.maxConnections > 0 ? engine.maxConnections : 0}
        {@const pct = engCap > 0 ? Math.min((engine.assignedNetworks.length * 100) / engCap, 100) : 0}
        <div class="rounded-lg border border-border bg-surface/40">
          <div class="flex items-center gap-3 px-5 py-3">
            <span class="h-3 w-3 rounded-full {engine.healthy ? 'bg-success' : 'bg-danger'}"></span>
            <span class="font-semibold text-heading">{engine.serverId}</span>
            <StatusBadge
              label={engine.healthy ? 'Healthy' : 'Unhealthy'}
              tone={engine.healthy ? 'success' : 'danger'}
              size="sm"
            />
            <span class="ml-auto text-xs text-muted">{engine.bindAddress}:{engine.port}</span>
          </div>
          <div class="flex flex-wrap items-center gap-4 px-5 pb-3 text-xs text-muted">
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
            <span class="font-mono text-[11px]" title={engine.gitHash ?? ''}>
              {#if engine.gitShort}
                {engine.gitShort}
                {#if engine.gitBranch}<span class="text-muted"> ({engine.gitBranch})</span>{/if}
                {#if engine.version}<span class="text-muted"> v{engine.version}</span>{/if}
              {:else}
                <span class="text-muted">no version</span>
              {/if}
              {#if engine.buildTime}
                <span class="ml-1 text-muted">built {new Date(engine.buildTime).toLocaleString()}</span>
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
          <!-- Per-engine config inline -->
          <form
            id={`engine-config-${engine.serverId}`}
            class="flex flex-wrap items-end gap-3 border-t border-border px-5 py-3 text-xs"
            onsubmit={(e) => { e.preventDefault(); saveConfig(engine.serverId); }}
          >
            <div>
              <label class="block text-muted">Priority</label>
              <input type="number" name="priority" value={engine.priority}
                class="mt-0.5 w-16 rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
            </div>
            <div>
              <label class="block text-muted">Engine Cap</label>
              <input type="number" name="maxConnections" value={engine.maxConnections} min="0"
                class="mt-0.5 w-16 rounded border border-border bg-surface px-2 py-1 text-xs text-text" />
              <div class="text-[10px] text-muted">0 = unlimited</div>
            </div>
            <div>
              <label class="block text-muted">Fallback</label>
              <select name="fallbackOnly"
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
        </div>
      {/each}
    </div>
  {:else}
    <EmptyState icon="🖥️" title="No engines registered" description="Start an IRC engine to see it appear here." />
  {/if}
</Card>

<!-- Host Connection Routing -->
<Card title="Host Connection Routing" subtitle="Per-host capacity across engines">
  {#snippet actions()}
    <form id="routing-form" class="flex items-center gap-2 text-xs" onsubmit={(e) => { e.preventDefault(); saveRouting(); }}>
      <label class="text-muted">Cap:</label>
      <input type="number" name="maxConnsPerHost" value={data?.maxConnsPerHost ?? 5}
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
                    class="block h-full rounded-full {h.fillPct >= 100 ? 'bg-danger' : h.fillPct >= 75 ? 'bg-warn' : 'bg-success'}"
                    style="width: {h.fillPct}%"
                  ></span>
                </span>
                <span class="font-mono">{h.totalConns}/{h.cap}</span>
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

<!-- Network Assignments -->
  <Card title="Network Assignments" subtitle="Live routing table — one row per network bound to an engine">
    {#if data?.assignments?.length}
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 text-left font-semibold">Network</th>
            <th class="py-2 text-left font-semibold">IRC Nick</th>
            <th class="py-2 text-left font-semibold">Owner</th>
            <th class="py-2 text-left font-semibold">Server</th>
            <th class="py-2 text-left font-semibold">Egress</th>
            <th class="py-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each data.assignments as a (a.networkId)}
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
                  {#each mullvadPool as n (n.id)}
                    <option value={n.id}>{n.label.toUpperCase()} — {n.host}</option>
                  {/each}
                </select>
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
    {:else}
      <EmptyState icon="🌐" title="No networks assigned" description="No networks are currently bound to any engine." />
    {/if}
  </Card>
