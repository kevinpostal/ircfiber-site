<script lang="ts">
  /**
   * ServerHost — per-host detail page showing all connections for an IRC host.
   * Route: /servers/host/:host — host comes from the hash router params.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { navigate } from '../lib/router';

  interface HostConnection {
    networkId: string;
    networkName: string;
    host: string;
    userId: string;
    username: string;
    serverId: string;
    connected: boolean;
    status: string;
    nick: string;
    isBanned: boolean;
    disabled: boolean;
  }

  interface HostDetailData {
    host: string;
    connections: HostConnection[];
    liveCount: number;
    serverCounts: Record<string, number>;
  }

  interface Props {
    host?: string;
  }
  let { host }: Props = $props();

  let data = $state<HostDetailData | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  onMount(() => loadHost());

  async function loadHost() {
    if (!host) return;
    loading = true; error = null;
    try {
      data = await api.get<HostDetailData>(`/api/admin/servers/host/${encodeURIComponent(host)}`);
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function disconnect(networkId: string, label: string) {
    if (!confirm(`Disconnect ${label} from ${host}?`)) return;
    try {
      await api.post(`/api/admin/servers/host/${encodeURIComponent(host!)}/disconnect/${networkId}`);
      toastSuccess(`Disconnected ${label}`);
      await loadHost();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function reconnect(networkId: string, label: string) {
    if (!confirm(`Re-enable ${label} on ${host}?`)) return;
    try {
      await api.post(`/api/admin/servers/host/${encodeURIComponent(host!)}/reconnect/${networkId}`);
      toastSuccess(`Reconnected ${label}`);
      await loadHost();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function deleteNetwork(networkId: string, label: string) {
    if (!confirm(`Permanently delete network ${label} for ${host}? This cannot be undone.`)) return;
    try {
      await api.post(`/api/admin/servers/host/${encodeURIComponent(host!)}/delete-network/${networkId}`);
      toastSuccess(`Deleted ${label}`);
      await loadHost();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }
</script>

{#if loading}
  <div class="flex h-64 items-center justify-center">
    <div class="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
  </div>
{:else if error}
  <PageHeader title="Server Host" subtitle="Error loading host" />
  <Card><div class="text-sm text-danger">{error}</div></Card>
{:else if data}
  <PageHeader title={`Host: ${host}`} subtitle="Per-host connection detail">
    {#snippet actions()}
      <a href="#/servers" class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:border-primary/40">← Back to Servers</a>
    {/snippet}
  </PageHeader>

  <div class="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
    <KpiCard label="Total Connections" value={data.connections.length} icon="🔌" />
    <KpiCard
      label="Connected"
      value={data.liveCount}
      tone={data.liveCount > 0 ? 'success' : 'muted'}
      icon="✅"
    />
    <KpiCard label="Engines Used" value={Object.keys(data.serverCounts).length} icon="🖥️" />
  </div>

  <Card title="Connections" subtitle={`${data.connections.length} network${data.connections.length === 1 ? '' : 's'} on ${host}`}>
    {#if data.connections.length === 0}
      <EmptyState icon="🔌" title="No connections" description={`No connections found for ${host}.`} />
    {:else}
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 text-left font-semibold">User</th>
            <th class="py-2 text-left font-semibold">Network</th>
            <th class="py-2 text-left font-semibold">Nick</th>
            <th class="py-2 text-left font-semibold">Status</th>
            <th class="py-2 text-left font-semibold">Engine</th>
            <th class="py-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each data.connections as c (c.networkId)}
            <tr class="border-b border-border/40 hover:bg-surface/40">
              <td class="py-2">
                <a href="#/users/{c.userId}" class="text-primary hover:underline font-medium">{c.username}</a>
              </td>
              <td class="py-2">
                <div class="font-medium text-text">{c.networkName}</div>
                <div class="font-mono text-[11px] text-muted">{c.host}</div>
              </td>
              <td class="py-2 font-mono text-text">{c.nick}</td>
              <td class="py-2">
                {#if c.isBanned}
                  <StatusBadge label="BANNED" tone="warn" size="sm" />
                {:else if c.disabled}
                  <span class="flex items-center gap-2">
                    <StatusBadge label="Disabled" tone="warn" size="sm" />
                    <button
                      type="button"
                      onclick={() => reconnect(c.networkId, `${c.username}/${c.networkName}`)}
                      class="rounded border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-text hover:border-primary/40"
                    >
                      Reconnect
                    </button>
                  </span>
                {:else if c.connected}
                  <span class="flex items-center gap-2">
                    <StatusBadge label="connected" tone="success" size="sm" />
                    <button
                      type="button"
                      onclick={() => disconnect(c.networkId, `${c.username}/${c.networkName}`)}
                      class="rounded border border-danger/30 px-2 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/10"
                    >
                      Disconnect
                    </button>
                  </span>
                {:else}
                  <StatusBadge label={c.status || 'offline'} tone="muted" size="sm" />
                {/if}
              </td>
              <td class="py-2">
                {#if c.isBanned}
                  <span class="text-xs text-warn">{c.serverId} (Z-Lined)</span>
                {:else if c.serverId !== 'unassigned'}
                  <a href="#/servers" class="text-primary hover:underline font-mono text-xs">{c.serverId}</a>
                {:else}
                  <span class="text-muted text-xs">unassigned</span>
                {/if}
              </td>
              <td class="py-2 text-right whitespace-nowrap">
                <button
                  type="button"
                  onclick={() => deleteNetwork(c.networkId, `${c.username}/${c.networkName}`)}
                  class="rounded border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
                >
                  Delete
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </Card>
{/if}