<script lang="ts">
  /**
   * Bouncer page — live attached IRC clients ("Connect with another
   * client…") and the accounts (networks) that have a bouncer password.
   *
   * Polls /api/admin/bnc every 5 s. Clients are presence records the bnc
   * process refreshes every 15 s (60 s TTL), so a row disappears at most a
   * minute after a client vanishes without a clean QUIT.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import RefreshIndicator from '../components/RefreshIndicator.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative, duration } from '../lib/format';

  interface BncClient {
    sid: string;
    userId: string;
    username: string;
    networkId: string;
    networkName: string;
    clientId: string;
    nick: string;
    peer: string;
    tls: boolean;
    caps: string;
    attachedAt: number;
    lastRecvMs: number;
    lastSendMs: number;
    cursor: number;
    linesIn: number;
    linesOut: number;
    presenceTtl: number;
  }
  interface BncSeen {
    clientId: string;
    cursor: number;
    online: boolean;
  }
  interface BncAccount {
    networkId: string;
    networkName: string;
    host: string;
    nick: string;
    disabled: boolean;
    userId: string;
    username: string;
    attached: number;
    seen: BncSeen[];
  }
  interface BncResponse {
    listener: { enabled: boolean; host: string; port: number; tls: boolean };
    stats: { attachedClients: number; accounts: number; usersOnline: number; seenCursors: number; serverTime: number };
    clients: BncClient[];
    accounts: BncAccount[];
  }

  let data = $state<BncResponse | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let lastFetchedAt = $state<number | null>(null);
  let q = $state('');
  let now = $state(Date.now());
  let busy = $state<Record<string, boolean>>({});

  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 1_000);
    return () => clearInterval(id);
  });

  let stop: (() => void) | null = null;
  onMount(() => {
    stop = startPolling(async () => {
      await fetchData();
      lastFetchedAt = Date.now();
    });
  });
  onDestroy(() => stop?.());

  async function fetchData() {
    loading = true; error = null;
    try {
      data = await api.get<BncResponse>('/api/admin/bnc');
    } catch (e) {
      error = e instanceof ApiError ? e.message : (e as Error).message;
    } finally { loading = false; }
  }

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function kick(c: BncClient) {
    if (!confirm(`Disconnect ${c.username}'s client "${c.clientId || c.nick}" (${c.peer}) from ${c.networkName}?\n\nThe client can reconnect immediately with the same password.`)) return;
    busy[c.sid] = true;
    try {
      await api.post(`/api/admin/bnc/clients/${encodeURIComponent(c.sid)}/kick`, { reason: 'Disconnected by administrator' });
      toastSuccess(`Kicked ${c.username} (${c.clientId || c.nick})`);
      await fetchData();
    } catch (e) { toastError(errMsg(e)); }
    finally { delete busy[c.sid]; }
  }

  async function revoke(a: BncAccount) {
    if (!confirm(`Revoke the bouncer password for ${a.username}'s network "${a.networkName}"?\n\n${a.attached} attached client(s) will be disconnected and every replay cursor dropped. The user must generate a new password from the web app to reconnect.`)) return;
    busy[a.networkId] = true;
    try {
      await api.post(`/api/admin/bnc/networks/${encodeURIComponent(a.networkId)}/revoke`);
      toastSuccess(`Revoked bouncer password for ${a.networkName}`);
      await fetchData();
    } catch (e) { toastError(errMsg(e)); }
    finally { delete busy[a.networkId]; }
  }

  async function clearSeen(a: BncAccount) {
    if (!confirm(`Forget all ${a.seen.length} replay cursor(s) for "${a.networkName}"?\n\nAttached clients keep running; each clientid's next reconnect starts from "now" instead of replaying missed messages.`)) return;
    try {
      await api.post(`/api/admin/bnc/networks/${encodeURIComponent(a.networkId)}/seen/clear`);
      toastSuccess(`Cleared replay cursors for ${a.networkName}`);
      await fetchData();
    } catch (e) { toastError(errMsg(e)); }
  }

  async function forgetSeen(a: BncAccount, s: BncSeen) {
    try {
      await api.post(`/api/admin/bnc/networks/${encodeURIComponent(a.networkId)}/seen/${encodeURIComponent(s.clientId)}/forget`);
      toastSuccess(`Forgot cursor for ${s.clientId}`);
      await fetchData();
    } catch (e) { toastError(errMsg(e)); }
  }

  const filteredClients = $derived.by(() => {
    if (!data?.clients) return [];
    if (!q) return data.clients;
    const l = q.toLowerCase();
    return data.clients.filter((c) =>
      c.username.toLowerCase().includes(l) || c.networkName.toLowerCase().includes(l)
      || c.clientId.toLowerCase().includes(l) || c.nick.toLowerCase().includes(l)
      || c.peer.toLowerCase().includes(l) || c.userId.toLowerCase().includes(l));
  });

  const filteredAccounts = $derived.by(() => {
    if (!data?.accounts) return [];
    if (!q) return data.accounts;
    const l = q.toLowerCase();
    return data.accounts.filter((a) =>
      a.username.toLowerCase().includes(l) || a.networkName.toLowerCase().includes(l)
      || a.host.toLowerCase().includes(l) || a.userId.toLowerCase().includes(l)
      || a.seen.some((s) => s.clientId.toLowerCase().includes(l)));
  });

  function idleClass(ms: number): string {
    if (ms < 60_000) return 'text-success';
    if (ms < 5 * 60_000) return 'text-text';
    return 'text-warn';
  }

  function capList(caps: string): string[] {
    return caps ? caps.split(',').filter(Boolean) : [];
  }
</script>

<PageHeader title="Bouncer" subtitle="Third-party IRC clients attached via “Connect with another client…”">
  {#snippet actions()}
    <RefreshIndicator {lastFetchedAt} {loading} />
  {/snippet}
</PageHeader>

{#if error}
  <Card class="mb-4">
    <div class="text-sm text-danger">{error}</div>
  </Card>
{/if}

<div class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
  <KpiCard label="Attached Clients" value={data?.stats.attachedClients ?? '—'} tone={data?.stats.attachedClients ? 'success' : 'muted'} icon="🔌" loading={loading && !data} />
  <KpiCard label="Users Online" value={data?.stats.usersOnline ?? '—'} icon="👥" loading={loading && !data} />
  <KpiCard label="Accounts" value={data?.stats.accounts ?? '—'} hint="networks with a bouncer password" tone="info" icon="🔐" loading={loading && !data} />
  <KpiCard label="Replay Cursors" value={data?.stats.seenCursors ?? '—'} hint="clientids with a tracked position" icon="⏪" loading={loading && !data} />
  <KpiCard
    label="Listener"
    value={data ? (data.listener.enabled ? `:${data.listener.port}` : 'off') : '—'}
    hint={data?.listener.enabled ? `${data.listener.host} · ${data.listener.tls ? 'TLS' : 'plaintext'}` : 'IRCFIBER_BNC_PUBLIC_HOST unset'}
    tone={data?.listener.enabled ? 'success' : 'warn'}
    icon="📡"
    loading={loading && !data}
  />
</div>

<Card title="Attached Clients" subtitle="Live connections to the bouncer — refreshed by each client every 15 s" class="mb-6">
  <div class="mb-4 flex items-center gap-2">
    <input
      type="search"
      bind:value={q}
      placeholder="Search user, network, clientid, nick, or peer…"
      autocomplete="off"
      class="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder-muted focus:border-primary focus:outline-none"
    />
    {#if q}
      <button type="button" onclick={() => q = ''} class="rounded-md border border-border bg-surface px-2.5 py-2 text-xs font-medium text-text hover:border-primary/40">Clear</button>
    {/if}
  </div>

  {#if !loading && filteredClients.length === 0}
    {#if (data?.clients?.length ?? 0) === 0}
      <EmptyState icon="🔌" title="No clients attached" description="Nobody is connected through the bouncer right now." />
    {:else}
      <EmptyState icon="🔍" title="No clients match" description={`"${q}" — try a username, network, clientid, or IP.`} />
    {/if}
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm" data-testid="bnc-clients">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 pr-2 text-left font-semibold">User</th>
            <th class="py-2 px-2 text-left font-semibold">Network</th>
            <th class="py-2 px-2 text-left font-semibold">Client</th>
            <th class="py-2 px-2 text-left font-semibold hidden md:table-cell">Peer</th>
            <th class="py-2 px-2 text-left font-semibold hidden lg:table-cell">Caps</th>
            <th class="py-2 px-2 text-left font-semibold">Attached</th>
            <th class="py-2 px-2 text-left font-semibold">Last Activity</th>
            <th class="py-2 px-2 text-right font-semibold hidden lg:table-cell">In / Out</th>
            <th class="py-2 px-2 text-right font-semibold hidden lg:table-cell">Cursor</th>
            <th class="py-2 pl-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredClients as c (c.sid)}
            {@const lastMs = Math.max(c.lastRecvMs, c.lastSendMs)}
            {@const idleMs = lastMs > 0 ? now - lastMs : Infinity}
            <tr class="border-b border-border/40 hover:bg-surface/40" data-testid="bnc-client-row">
              <td class="py-3 pr-2">
                <div class="flex items-center gap-2.5">
                  <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-purple-400 text-xs font-bold text-bg">
                    {c.username.charAt(0).toUpperCase()}
                  </div>
                  <div class="min-w-0">
                    <a href={`#/users/${c.userId}`} class="font-semibold text-heading hover:text-primary">{c.username}</a>
                    <div class="font-mono text-[11px] text-muted" title={c.userId}>{c.userId.slice(0, 16)}…</div>
                  </div>
                </div>
              </td>
              <td class="py-3 px-2">
                <div class="font-medium text-text">{c.networkName}</div>
                <div class="font-mono text-[11px] text-muted">as {c.nick}</div>
              </td>
              <td class="py-3 px-2">
                {#if c.clientId}
                  <span class="font-mono text-xs text-text" title="bnc@{c.clientId}:… — replay tracked">{c.clientId}</span>
                {:else}
                  <span class="text-xs text-muted" title="bnc:… — no clientid, no replay on reconnect">anonymous</span>
                {/if}
                <div class="font-mono text-[10px] text-muted" title="bouncer session id">{c.sid}</div>
              </td>
              <td class="py-3 px-2 hidden md:table-cell">
                <span class="font-mono text-xs">{c.peer}</span>
                <StatusBadge label={c.tls ? 'tls' : 'plain'} tone={c.tls ? 'success' : 'warn'} size="sm" dot={false} />
              </td>
              <td class="py-3 px-2 hidden lg:table-cell max-w-[260px]">
                <div class="flex flex-wrap gap-1">
                  {#each capList(c.caps) as cap}
                    <span class="rounded bg-surface px-1 py-0.5 font-mono text-[10px] text-muted">{cap}</span>
                  {/each}
                  {#if capList(c.caps).length === 0}<span class="text-[11px] text-muted">none</span>{/if}
                </div>
              </td>
              <td class="py-3 px-2">
                <span class="text-xs font-semibold">{c.attachedAt > 0 ? duration(now - c.attachedAt) : '—'}</span>
                <span class="block text-[10px] text-muted">{c.attachedAt > 0 ? new Date(c.attachedAt).toLocaleString() : ''}</span>
              </td>
              <td class="py-3 px-2">
                <div class={idleClass(idleMs)}>
                  <span class="text-xs font-semibold">{lastMs > 0 ? relative(lastMs, now) : 'never'}</span>
                  {#if c.presenceTtl >= 0 && c.presenceTtl < 20}
                    <span class="block text-[10px] text-warn">presence expiring ({c.presenceTtl}s)</span>
                  {/if}
                </div>
              </td>
              <td class="py-3 px-2 text-right font-mono text-xs hidden lg:table-cell">{c.linesIn} / {c.linesOut}</td>
              <td class="py-3 px-2 text-right font-mono text-xs hidden lg:table-cell" title="last eid delivered">{c.cursor || '—'}</td>
              <td class="py-3 pl-2 text-right whitespace-nowrap">
                <button
                  type="button"
                  onclick={() => kick(c)}
                  disabled={!!busy[c.sid]}
                  title="Send ERROR and close this client's socket"
                  class="rounded-md border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  Kick
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="mt-2 text-xs text-muted">{filteredClients.length} of {data?.clients.length ?? 0} clients</div>
  {/if}
</Card>

<Card title="Accounts" subtitle="Networks with a bouncer password set — the user's own “Connect with another client…” dialog">
  {#if !loading && filteredAccounts.length === 0}
    {#if (data?.accounts?.length ?? 0) === 0}
      <EmptyState icon="🔐" title="No bouncer passwords" description="No user has generated a bouncer password yet." />
    {:else}
      <EmptyState icon="🔍" title="No accounts match" description={`"${q}" — try a username, network, host, or clientid.`} />
    {/if}
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm" data-testid="bnc-accounts">
        <thead class="text-xs uppercase tracking-wider text-muted">
          <tr class="border-b border-border">
            <th class="py-2 pr-2 text-left font-semibold">User</th>
            <th class="py-2 px-2 text-left font-semibold">Network</th>
            <th class="py-2 px-2 text-left font-semibold hidden md:table-cell">Host</th>
            <th class="py-2 px-2 text-left font-semibold">Attached</th>
            <th class="py-2 px-2 text-left font-semibold">Replay cursors</th>
            <th class="py-2 pl-2 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredAccounts as a (a.networkId)}
            <tr class="border-b border-border/40 hover:bg-surface/40" data-testid="bnc-account-row">
              <td class="py-3 pr-2">
                <a href={`#/users/${a.userId}`} class="font-semibold text-heading hover:text-primary">{a.username}</a>
                <div class="font-mono text-[11px] text-muted" title={a.userId}>{a.userId.slice(0, 16)}…</div>
              </td>
              <td class="py-3 px-2">
                <div class="flex items-center gap-1.5">
                  <span class="font-medium text-text">{a.networkName}</span>
                  {#if a.disabled}<StatusBadge label="disabled" tone="muted" size="sm" dot={false} />{/if}
                </div>
                <div class="font-mono text-[11px] text-muted" title={a.networkId}>{a.nick} · {a.networkId.slice(0, 8)}…</div>
              </td>
              <td class="py-3 px-2 hidden md:table-cell font-mono text-xs">{a.host}</td>
              <td class="py-3 px-2">
                <StatusBadge label={String(a.attached)} tone={a.attached > 0 ? 'success' : 'muted'} size="sm" />
              </td>
              <td class="py-3 px-2">
                {#if a.seen.length === 0}
                  <span class="text-xs text-muted">none</span>
                {:else}
                  <div class="flex flex-wrap gap-1">
                    {#each a.seen as s (s.clientId)}
                      <span class="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px]" title="last eid delivered to {s.clientId}: {s.cursor}">
                        <span class="h-1.5 w-1.5 rounded-full {s.online ? 'bg-success' : 'bg-muted'}"></span>
                        {s.clientId}
                        <span class="text-muted">@{s.cursor}</span>
                        <button type="button" onclick={() => forgetSeen(a, s)} title="Forget this cursor" class="ml-0.5 text-muted hover:text-danger" aria-label={`Forget cursor for ${s.clientId}`}>×</button>
                      </span>
                    {/each}
                  </div>
                {/if}
              </td>
              <td class="py-3 pl-2 text-right whitespace-nowrap">
                <button
                  type="button"
                  onclick={() => clearSeen(a)}
                  disabled={a.seen.length === 0}
                  title="Drop every replay cursor for this network"
                  class="mr-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-text hover:border-primary/40 disabled:opacity-30"
                >
                  Clear replay
                </button>
                <button
                  type="button"
                  onclick={() => revoke(a)}
                  disabled={!!busy[a.networkId]}
                  title="Remove the password and disconnect attached clients"
                  class="rounded-md border border-danger/30 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                >
                  Revoke
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="mt-2 text-xs text-muted">{filteredAccounts.length} of {data?.accounts.length ?? 0} accounts</div>
  {/if}
</Card>
