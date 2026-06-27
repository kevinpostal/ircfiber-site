<script lang="ts">
  /**
   * Sessions page — active session table with search, stats, clear actions.
   * Fetches from /api/admin/sessions once on mount; no auto-polling.
   * Live relative-time updates via $effect timer.
   */
  import { onMount } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { relative } from '../lib/format';

  interface SessionEntry {
    sessionId: string;
    userId: string;
    username: string;
    clientIp: string;
    userAgent: string;
    createdAt: number;
    lastAccess: number;
    ttlSeconds: number;
    isCurrent: boolean;
    isAdmin: boolean;
    roles: string;
  }

  interface SessionsResponse {
    total: number;
    uniqueUsers: number;
    yourSessions: number;
    adminsOnline: number;
    idleCount: number;
    sessions: SessionEntry[];
  }

  let data = $state<SessionsResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let q = $state('');
  let now = $state(Date.now());

  // Live timer for relative-time display
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 1_000);
    return () => clearInterval(id);
  });

  onMount(() => fetchData());

  async function fetchData() {
    loading = true; error = null;
    try {
      data = await api.get<SessionsResponse>('/api/admin/sessions');
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  async function clearAll() {
    if (!confirm('Clear ALL sessions except your own? Every other user will be logged out.')) return;
    try {
      const res = await api.post<{ cleared: number }>('/api/admin/sessions/clear');
      toastSuccess(`Cleared ${res.cleared} sessions`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  async function clearUser(session: SessionEntry) {
    if (!confirm(`Clear all sessions for ${session.username}?`)) return;
    try {
      const res = await api.post<{ cleared: number }>(`/api/admin/sessions/clear/${session.userId}`);
      toastSuccess(`Cleared ${res.cleared} sessions for ${session.username}`);
      await fetchData();
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  // Search filter (client-side)
  const filtered = $derived.by(() => {
    if (!data?.sessions) return [];
    if (!q) return data.sessions;
    const lower = q.toLowerCase();
    return data.sessions.filter(
      (s) => s.username.toLowerCase().includes(lower)
        || s.userId.toLowerCase().includes(lower)
        || s.clientIp.toLowerCase().includes(lower)
    );
  });

  // Helper: format TTL
  function fmtTtl(s: number): string {
    if (s <= 0) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Helper: idle classification
  function idleClass(ms: number): string {
    if (ms < 60_000) return 'text-success';
    if (ms < 5 * 60_000) return 'text-text';
    if (ms < 60 * 60_000) return 'text-warn';
    return 'text-danger';
  }

  // Helper: session ID short display
  function shortSid(id: string): string {
    if (id.length > 12) return id.slice(0, 12) + '…';
    return id;
  }

  // Helper: detect IPv6 from address string
  function isIPv6(ip: string): boolean {
    return ip.includes(':');
  }
</script>

<PageHeader
  title="Active Sessions"
  subtitle="Live view of all logged-in users"
/>

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<!-- Stat cards -->
<div class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
  <KpiCard label="Active Sessions" value={data?.total ?? '—'} tone={data?.total ? 'success' : 'muted'} icon="🔑" loading={loading && !data} />
  <KpiCard label="Unique Users" value={data?.uniqueUsers ?? '—'} icon="👥" loading={loading && !data} />
  <KpiCard label="Your Sessions" value={data?.yourSessions ?? '—'} tone="info" icon="🖥️" loading={loading && !data} />
  <KpiCard label="Admins Online" value={data?.adminsOnline ?? '—'} tone={data?.adminsOnline ? 'info' : 'muted'} icon="⭐" loading={loading && !data} />
  <KpiCard label="Idle > 1h" value={data?.idleCount ?? '—'} tone={data?.idleCount ? 'warn' : 'success'} icon="💤" loading={loading && !data} />
</div>

<!-- Toolbar + Clear All -->
<Card>
  {#snippet actions()}
    <button
      type="button"
      onclick={clearAll}
      disabled={!data?.total}
      class="rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-30"
    >
      Clear All (except mine)
    </button>
  {/snippet}
  <div class="mb-4 flex items-center gap-2">
    <input
      type="search"
      bind:value={q}
      placeholder="Search username, IP, or user ID…"
      autocomplete="off"
      class="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder-muted focus:border-primary focus:outline-none"
    />
    {#if q}
      <button
        type="button"
        onclick={() => q = ''}
        class="rounded-md border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text hover:border-primary/40"
      >
        Clear
      </button>
    {/if}
  </div>

  <!-- Empty state -->
  {#if !loading && filtered.length === 0}
    {#if data?.sessions?.length === 0}
      <EmptyState icon="🔑" title="No active sessions" description="This is unusual — check if Redis is running." />
    {:else if q}
      <EmptyState icon="🔍" title="No sessions match" description={`"${q}" — try a partial username, IP, or user ID.`} />
    {/if}
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 pr-2 text-left font-semibold">User</th>
            <th class="py-2 px-2 text-left font-semibold">Session</th>
            <th class="py-2 px-2 text-left font-semibold hidden md:table-cell">IP Address</th>
            <th class="py-2 px-2 text-left font-semibold hidden lg:table-cell">Browser</th>
            <th class="py-2 px-2 text-left font-semibold hidden lg:table-cell">Created</th>
            <th class="py-2 px-2 text-left font-semibold">Last Activity</th>
            <th class="py-2 px-2 text-left font-semibold hidden lg:table-cell">Expires In</th>
            <th class="py-2 pl-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as s (s.sessionId)}
            {@const idleMs = s.lastAccess > 0 ? now - s.lastAccess : Infinity}
            <tr class="border-b border-border/40 hover:bg-surface/40 {s.isCurrent ? 'bg-primary/5' : ''}">
              <td class="py-3 pr-2">
                <div class="flex items-center gap-2.5">
                  <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-purple-400 text-xs font-bold text-bg">
                    {s.username.charAt(0).toUpperCase()}
                  </div>
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="font-semibold text-heading">{s.username}</span>
                      {#if s.isAdmin}
                        <StatusBadge label="admin" tone="primary" size="sm" dot={false} />
                      {/if}
                      {#if s.isCurrent}
                        <StatusBadge label="you" tone="info" size="sm" dot={false} />
                      {/if}
                    </div>
                    <div class="font-mono text-[11px] text-muted" title={s.userId}>
                      {s.userId.length > 16 ? s.userId.slice(0, 16) + '…' : s.userId}
                    </div>
                  </div>
                </div>
              </td>
              <td class="py-3 px-2">
                <span class="font-mono text-xs text-text" title={s.sessionId}>{shortSid(s.sessionId)}</span>
              </td>
              <td class="py-3 px-2 hidden md:table-cell">
                <span class="font-mono text-xs">{s.clientIp || '—'}</span>
                {#if s.clientIp && isIPv6(s.clientIp)}
                  <span class="ml-1 rounded bg-warn/15 px-1 py-0.5 text-[10px] font-medium text-warn">IPv6</span>
                {/if}
              </td>
              <td class="py-3 px-2 hidden lg:table-cell max-w-[260px] truncate" title={s.userAgent}>
                <span class="text-xs text-muted">{s.userAgent || 'unknown'}</span>
              </td>
              <td class="py-3 px-2 hidden lg:table-cell">
                <span class="text-xs text-muted">{s.createdAt > 0 ? new Date(s.createdAt).toLocaleString() : '—'}</span>
              </td>
              <td class="py-3 px-2">
                <div class="{idleClass(idleMs)}">
                  <span class="text-xs font-semibold">{s.lastAccess > 0 ? relative(s.lastAccess, now) : 'never'}</span>
                  <span class="block text-[10px] text-muted font-normal">{s.lastAccess > 0 ? new Date(s.lastAccess).toLocaleString() : ''}</span>
                </div>
              </td>
              <td class="py-3 px-2 hidden lg:table-cell">
                <div class="text-xs" title={`${((s.ttlSeconds * 100) / (14 * 24 * 60 * 60)).toFixed(0)}% of 14-day TTL`}>{fmtTtl(s.ttlSeconds)}</div>
              </td>
              <td class="py-3 pl-2 text-right whitespace-nowrap">
                {#if !s.isCurrent}
                  <button
                    type="button"
                    onclick={() => clearUser(s)}
                    class="rounded-md border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10"
                  >
                    Clear user
                  </button>
                {:else}
                  <span class="text-[11px] text-muted">current</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="mt-2 text-xs text-muted">{filtered.length} of {data?.total ?? 0} sessions</div>
  {/if}
</Card>