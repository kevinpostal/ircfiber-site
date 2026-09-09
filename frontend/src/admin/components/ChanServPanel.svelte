<script lang="ts">
  /**
   * ChanServPanel — Anope/ChanServ channel management (IRCD page → ChanServ).
   *
   * Three cards, two data paths — the same split NickServPanel uses:
   *   1. "Channels" is the whole registered-channel inventory, read from
   *      Anope's flatfile on the gateway
   *      (`/api/admin/ircd/chanserv/channels`). It is up to five minutes
   *      stale — Anope only flushes anope.db every `updatetimeout` — so the
   *      header states the "as of" time. Filtering and paging are
   *      client-side: the list is already loaded.
   *   2. "Manage channel" is live `ChanServ INFO` + `ACCESS … LIST` over
   *      XML-RPC and is therefore authoritative over the table. Every
   *      successful action re-runs the lookup and refreshes the table.
   *   3. "Register a channel" founds a new registration. `REGISTER` always
   *      founds on the calling account (the services oper), so a named
   *      founder is applied by a following transfer; the gateway reports a
   *      failed transfer as `founderSet:false` on an otherwise successful
   *      registration, which is surfaced here as a warning toast rather than
   *      being swallowed.
   *
   * A channel's founder is a NickServ account, and when that account is a
   * website user's SASL credential the row links that user: dropping or
   * transferring the channel changes what that person controls.
   */
  import { onMount } from 'svelte';
  import Card from './Card.svelte';
  import EmptyState from './EmptyState.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';

  interface CsChannel {
    name: string; founder: string; successor: string; description: string;
    registeredAt: number; lastUsedAt: number;
    lastTopic: string; lastTopicSetter: string; lastTopicAt: number;
    bot: string; accessCount: number;
    noExpire: boolean; isPrivate: boolean; persistent: boolean;
    suspended: boolean; suspendedBy: string; suspendReason: string;
    suspendedAt: number; suspendExpiresAt: number;
    founderUserId: string; founderUsername: string; founderNetworkId: string;
  }
  interface CsChannelsResponse {
    available: boolean; reason: string; asOf: number;
    channels: CsChannel[]; suspendedCount: number;
  }
  interface CsAccessEntry { number: number; level: string; mask: string; }
  interface CsPlatform { userId: string; username: string; networkId: string; }
  interface CsInfo {
    channel: string; registered: boolean;
    founder: string; successor: string; description: string; suspended: boolean;
    fields: Record<string, string>; lines: string[];
    access: CsAccessEntry[]; accessError: string;
    platform: CsPlatform | null;
  }
  /// The register response: `founderSet` is false when the channel exists but
  /// the requested founder could not be given it.
  interface CsRegisterResult {
    channel: string; registered: boolean; founder: string;
    founderSet: boolean; founderError: string;
  }

  let channels = $state<CsChannel[]>([]);
  let available = $state(true);
  let reason = $state('');
  let asOf = $state(0);
  let suspendedCount = $state(0);
  let listError = $state<string | null>(null);
  let listLoading = $state(false);

  let filter = $state('');
  let page = $state(1);
  const pageSize = 25;

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return channels;
    return channels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.founder.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.founderUsername.toLowerCase().includes(q),
    );
  });
  const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));
  $effect(() => { void filter; page = 1; });
  $effect(() => { if (page > totalPages) page = totalPages; });

  let lookupChannel = $state('');
  let infoChannel = $state('');
  let info = $state<CsInfo | null>(null);
  let infoError = $state<string | null>(null);
  let infoLoading = $state(false);
  let actionError = $state<string | null>(null);
  /// Which action is in flight, so only its button shows "Loading…".
  let acting = $state('');
  /// Which channel the running drop is for, so only the row that started it
  /// dims and cannot be pressed again.
  let droppingChannel = $state('');

  let showSuspend = $state(false);
  let suspendReason = $state('');
  let suspendExpiry = $state('');
  /// The channel a Drop is being confirmed for, null when none is pending:
  /// either the manage card's channel or the table row whose Drop was
  /// pressed. One channel at a time by construction — no multi-select.
  let dropTarget = $state<string | null>(null);

  let founderDraft = $state('');
  let confirmFounder = $state(false);

  let accessTier = $state('SOP');
  let accessEntry = $state('');

  let regChannel = $state('');
  let regDescription = $state('');
  let regFounder = $state('');

  /// `cs_info` emits labels in a fixed order; anything Anope adds later is
  /// appended rather than dropped. The suspension labels are the ones 2.0.20
  /// actually renders (verified against 2.0.20 over XML-RPC) — `cs_suspend`'s
  /// `show` list names options, not labels — so they group with `Suspended`
  /// instead of trailing the list.
  const fieldOrder = [
    'Founder', 'Successor', 'Description', 'Registered', 'Last used',
    'Ban type', 'Mode lock', 'Options', 'Last topic', 'Topic set by',
    'Suspended', 'Suspended by', 'Suspend reason', 'Suspended on',
    'Suspension expires',
  ];
  const orderedFields = $derived.by(() => {
    const f = info?.fields ?? {};
    const rows: [string, string][] = [];
    for (const k of fieldOrder) if (k in f) rows.push([k, f[k]]);
    for (const k of Object.keys(f)) if (!fieldOrder.includes(k)) rows.push([k, f[k]]);
    return rows;
  });

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }
  function fmtTime(unix: number): string {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  }

  async function loadChannels() {
    listLoading = true;
    listError = null;
    try {
      const r = await api.get<CsChannelsResponse>('/api/admin/ircd/chanserv/channels');
      channels = r.channels ?? [];
      available = r.available;
      reason = r.reason ?? '';
      asOf = r.asOf ?? 0;
      suspendedCount = r.suspendedCount ?? 0;
    } catch (e) {
      listError = errMsg(e);
    } finally {
      listLoading = false;
    }
  }

  async function lookup(channel: string) {
    const c = channel.trim();
    if (!c) return;
    infoChannel = c;
    lookupChannel = c;
    infoLoading = true;
    infoError = null;
    actionError = null;
    showSuspend = false;
    try {
      info = await api.get<CsInfo>('/api/admin/ircd/chanserv/channel', { channel: c });
    } catch (e) {
      info = null;
      infoError = errMsg(e);
    } finally {
      infoLoading = false;
    }
  }

  /// The table is stale by construction, so refresh both views after an
  /// action: suspending, dropping and transferring all change a row.
  async function afterAction(channel: string) {
    await lookup(channel);
    await loadChannels();
  }

  async function suspend() {
    const channel = infoChannel;
    const r = suspendReason.trim();
    if (!r) { toastError('A reason is required.'); return; }
    acting = 'suspend';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/suspend', {
        channel, reason: r, expiry: suspendExpiry.trim(),
      });
      toastSuccess('Suspended ' + channel);
      suspendReason = '';
      suspendExpiry = '';
      showSuspend = false;
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function unsuspend() {
    const channel = infoChannel;
    acting = 'unsuspend';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/unsuspend', { channel });
      toastSuccess('Unsuspended ' + channel);
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function drop() {
    const channel = dropTarget ?? infoChannel;
    dropTarget = null;
    if (!channel) return;
    acting = 'drop';
    droppingChannel = channel;
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/drop', { channel, confirm: true });
      toastSuccess('Dropped ' + channel);
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
      droppingChannel = '';
    }
  }

  async function setFounder() {
    confirmFounder = false;
    const channel = infoChannel;
    const founder = founderDraft.trim();
    if (!founder) { toastError('Name the new founder account.'); return; }
    acting = 'founder';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/founder', {
        channel, founder, confirm: true,
      });
      toastSuccess(`${channel} now belongs to ${founder}`);
      founderDraft = '';
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function addAccess() {
    const channel = infoChannel;
    const entry = accessEntry.trim();
    if (!entry) { toastError('Name an account or mask.'); return; }
    acting = 'access-add';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/access', {
        channel, tier: accessTier, entry,
      });
      toastSuccess(`${entry} added to the ${channel} ${accessTier} list`);
      accessEntry = '';
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function removeAccess(entry: string) {
    const channel = infoChannel;
    acting = 'access-del-' + entry;
    actionError = null;
    try {
      await api.post('/api/admin/ircd/chanserv/access/delete', { channel, entry });
      toastSuccess(`${entry} removed from ${channel}`);
      await afterAction(channel);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  /**
   * Register a channel. A blank founder leaves the services account as
   * founder, which the form says. `founderSet:false` means the channel is
   * registered but still owned by the services account — a partially applied
   * register that must never be silent, so it raises an error toast while the
   * registration itself is still reported as the success it is.
   */
  async function registerChannel() {
    const channel = regChannel.trim();
    if (!channel) { toastError('Name the channel to register.'); return; }
    const description = regDescription.trim();
    const founder = regFounder.trim();
    acting = 'register';
    actionError = null;
    try {
      const r = await api.post<CsRegisterResult>('/api/admin/ircd/chanserv/register', {
        channel,
        ...(description ? { description } : {}),
        ...(founder ? { founder } : {}),
      });
      toastSuccess(`Registered ${channel} for ${r.founder}`);
      if (r.founderSet === false) {
        actionError = r.founderError;
        toastError(r.founderError);
      }
      regChannel = '';
      regDescription = '';
      regFounder = '';
      await lookup(channel);
      await loadChannels();
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  onMount(() => {
    void loadChannels();
  });

  const btn = 'rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40';
  const input =
    'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder-muted focus:border-primary focus:outline-none';
</script>

<Card class="mb-4">
  <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
    <div>
      <h3 class="text-sm font-semibold text-heading">Channels ({channels.length})</h3>
      <p class="mt-0.5 text-xs text-muted">
        Registered channels as of {fmtTime(asOf)} · up to 5 minutes stale
      </p>
    </div>
    <div class="flex items-center gap-2">
      {#if suspendedCount > 0}
        <span
          data-testid="cs-suspended-count"
          class="rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger"
        >
          {suspendedCount} suspended
        </span>
      {/if}
      <button type="button" onclick={() => void loadChannels()} class={btn}>
        {listLoading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if !available}
    <p class="mb-3 text-xs text-amber-500">{reason}</p>
  {/if}

  <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
    <input
      type="search"
      bind:value={filter}
      placeholder="Filter by channel, founder or description…"
      aria-label="Filter registered channels"
      class="w-full max-w-[360px] {input}"
    />
    {#if filter}
      <button type="button" onclick={() => (filter = '')} class="text-xs text-muted hover:text-text">
        Clear
      </button>
    {/if}
  </div>

  {#if listError}
    <p class="text-sm text-danger">{listError}</p>
  {:else if filtered.length === 0}
    <EmptyState
      title="No channels"
      description={channels.length
        ? 'No channel matches this filter.'
        : available
          ? 'No channel is registered with ChanServ.'
          : 'The channel inventory could not be read.'}
    />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
            <th class="py-2 pr-4">Channel</th>
            <th class="py-2 pr-4">Founder</th>
            <th class="py-2 pr-4">Website user</th>
            <th class="py-2 pr-4">Access</th>
            <th class="py-2 pr-4">Registered</th>
            <th class="py-2 pr-4">Last used</th>
            <th class="py-2 pr-4">State</th>
            <th class="py-2 text-right"></th>
          </tr>
        </thead>
        <tbody data-testid="cs-channels-rows">
          {#each paged as c}
            <tr
              class="border-b border-border/50 transition-opacity last:border-0 {droppingChannel ===
              c.name
                ? 'opacity-40'
                : ''}"
            >
              <td class="py-2 pr-4 font-mono font-semibold">{c.name}</td>
              <td class="py-2 pr-4 font-mono">{c.founder || '—'}</td>
              <td class="py-2 pr-4">
                {#if c.founderUserId && c.founderUsername}
                  <a class="text-primary hover:underline" href="#/users/{c.founderUserId}">
                    {c.founderUsername}
                  </a>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td class="py-2 pr-4 tabular-nums">{c.accessCount}</td>
              <td class="py-2 pr-4 text-xs text-muted">{fmtTime(c.registeredAt)}</td>
              <td class="py-2 pr-4 text-xs text-muted">{fmtTime(c.lastUsedAt)}</td>
              <td class="py-2 pr-4">
                <div class="flex flex-wrap items-center gap-1">
                  {#if c.suspended}
                    <span
                      data-testid="cs-suspended-{c.name}"
                      title={c.suspendReason}
                      class="whitespace-nowrap rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger"
                    >
                      Suspended
                    </span>
                  {/if}
                  {#if c.noExpire}
                    <span class="whitespace-nowrap rounded bg-surface-2 px-2 py-0.5 text-xs text-muted">
                      No expire
                    </span>
                  {/if}
                  {#if c.persistent}
                    <span class="whitespace-nowrap rounded bg-surface-2 px-2 py-0.5 text-xs text-muted">
                      Persistent
                    </span>
                  {/if}
                </div>
              </td>
              <td class="py-2 text-right">
                <div class="flex items-center justify-end gap-1">
                  <button type="button" class={btn} onclick={() => void lookup(c.name)}>
                    Manage
                  </button>
                  <button
                    type="button"
                    data-testid="cs-drop-{c.name}"
                    aria-label="Drop {c.name}"
                    disabled={acting === 'drop' && droppingChannel === c.name}
                    onclick={() => (dropTarget = c.name)}
                    class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {acting === 'drop' && droppingChannel === c.name ? 'Loading…' : 'Drop'}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div
      class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted"
    >
      <div>{filtered.length} channels • page {page} of {totalPages}</div>
      <div class="flex items-center gap-1">
        <button
          onclick={() => (page = 1)}
          disabled={page === 1}
          class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
        >«</button>
        <button
          onclick={() => (page = Math.max(1, page - 1))}
          disabled={page === 1}
          class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
        >‹</button>
        <span class="px-2">{page} / {totalPages}</span>
        <button
          onclick={() => (page = Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
        >›</button>
        <button
          onclick={() => (page = totalPages)}
          disabled={page === totalPages}
          class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
        >»</button>
      </div>
    </div>
  {/if}
</Card>

<Card class="mt-4">
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <h3 class="text-sm font-semibold text-heading">Manage channel</h3>
    {#if info?.suspended}
      <span class="rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
        Suspended
      </span>
    {/if}
    <span class="text-xs text-muted">Live ChanServ INFO — authoritative over the table above</span>
  </div>

  <form
    class="mb-3 flex flex-wrap items-center gap-2"
    onsubmit={(e) => { e.preventDefault(); void lookup(lookupChannel); }}
  >
    <input
      type="text"
      bind:value={lookupChannel}
      placeholder="#channel"
      aria-label="Channel to manage"
      class="w-full max-w-[220px] font-mono {input}"
    />
    <button type="submit" class={btn}>{infoLoading ? 'Loading…' : 'Look up'}</button>
  </form>

  {#if infoError}
    <p class="text-sm text-danger">{infoError}</p>
  {/if}
  {#if actionError}
    <p class="text-sm text-danger">{actionError}</p>
  {/if}

  {#if info && !info.registered}
    <p class="text-sm text-muted">Not registered.</p>
  {:else if info}
    <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[180px_1fr]">
      {#each orderedFields as [label, value] (label)}
        <dt class="text-xs uppercase tracking-wider text-muted">{label}</dt>
        <dd class="break-words">{value}</dd>
      {/each}
    </dl>

    <div class="mt-4">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted">Access list</h4>
      {#if info.accessError}
        <p class="mt-1 text-xs text-amber-500">{info.accessError}</p>
      {/if}
      {#if info.access.length === 0}
        <p class="mt-1 text-sm text-muted">No access entry — only the founder controls it.</p>
      {:else}
        <div class="mt-2 overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">Number</th>
                <th class="py-2 pr-4">Level</th>
                <th class="py-2 pr-4">Mask</th>
                <th class="py-2 text-right"></th>
              </tr>
            </thead>
            <tbody data-testid="cs-access-rows">
              {#each info.access as a (a.mask)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 tabular-nums">{a.number}</td>
                  <td class="py-2 pr-4 font-mono">{a.level}</td>
                  <td class="py-2 pr-4 font-mono">{a.mask}</td>
                  <td class="py-2 text-right">
                    <button
                      type="button"
                      data-testid="cs-access-del-{a.mask}"
                      aria-label="Remove {a.mask}"
                      onclick={() => void removeAccess(a.mask)}
                      class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
                    >
                      {acting === 'access-del-' + a.mask ? 'Loading…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <select bind:value={accessTier} aria-label="Access level" class={input}>
          <option value="QOP">QOP</option>
          <option value="SOP">SOP</option>
          <option value="AOP">AOP</option>
          <option value="HOP">HOP</option>
          <option value="VOP">VOP</option>
        </select>
        <input
          bind:value={accessEntry}
          placeholder="account or mask"
          aria-label="Account or mask"
          class="max-w-[240px] font-mono {input}"
        />
        <button type="button" onclick={() => void addAccess()} class={btn}>
          {acting === 'access-add' ? 'Loading…' : 'Add access'}
        </button>
      </div>
    </div>

    <div class="mt-4">
      <h4 class="text-xs font-semibold uppercase tracking-wider text-muted">Founder</h4>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <input
          bind:value={founderDraft}
          placeholder="account"
          aria-label="New founder account"
          class="max-w-[240px] font-mono {input}"
        />
        <button type="button" onclick={() => (confirmFounder = true)} class={btn}>
          {acting === 'founder' ? 'Loading…' : 'Transfer founder'}
        </button>
        {#if info.platform}
          <span class="text-xs text-muted">
            Currently owned by website user
            <a class="text-primary hover:underline" href="#/users/{info.platform.userId}">
              {info.platform.username}
            </a>
          </span>
        {/if}
      </div>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <button type="button" onclick={() => (showSuspend = !showSuspend)} class={btn}>Suspend</button>
      <button type="button" onclick={() => void unsuspend()} class={btn}>
        {acting === 'unsuspend' ? 'Loading…' : 'Unsuspend'}
      </button>
      <button
        type="button"
        onclick={() => (dropTarget = infoChannel)}
        class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
      >
        {acting === 'drop' ? 'Loading…' : 'Drop'}
      </button>
    </div>

    {#if showSuspend}
      <form
        class="mt-3 grid gap-2 sm:grid-cols-[1fr_120px_auto]"
        onsubmit={(e) => { e.preventDefault(); void suspend(); }}
      >
        <input
          bind:value={suspendReason}
          placeholder="Reason (required)"
          aria-label="Suspend reason"
          class={input}
        />
        <input
          bind:value={suspendExpiry}
          placeholder="30d"
          aria-label="Suspend expiry"
          class="font-mono {input}"
        />
        <button
          type="submit"
          class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
        >
          {acting === 'suspend' ? 'Loading…' : 'Suspend channel'}
        </button>
      </form>
    {/if}

    <details class="mt-3">
      <summary class="cursor-pointer text-xs text-muted">Raw ChanServ reply</summary>
      <pre
        class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-text">{info.lines.join('\n')}</pre>
    </details>
  {/if}
</Card>

<Card class="mt-4">
  <h3 class="text-sm font-semibold text-heading">Register a channel</h3>
  <p class="mt-0.5 text-xs text-muted">
    ChanServ founds the channel on the services account, then hands it to the founder named below.
    Leave the founder blank to keep the services account as founder.
  </p>
  <form
    class="mt-3 flex flex-wrap items-center gap-2"
    onsubmit={(e) => { e.preventDefault(); void registerChannel(); }}
  >
    <input
      bind:value={regChannel}
      placeholder="#channel"
      aria-label="Channel to register"
      class="max-w-[200px] font-mono {input}"
    />
    <input
      bind:value={regDescription}
      placeholder="Description (optional)"
      aria-label="Channel description"
      class="w-full max-w-[320px] {input}"
    />
    <input
      bind:value={regFounder}
      placeholder="Founder account (optional)"
      aria-label="Founder account"
      class="max-w-[220px] font-mono {input}"
    />
    <button
      type="submit"
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
    >
      {acting === 'register' ? 'Loading…' : 'Register channel'}
    </button>
  </form>
</Card>

<ConfirmDialog
  open={dropTarget !== null}
  tone="danger"
  title="Drop this channel registration?"
  message={`${dropTarget ?? ''} loses its founder, access list, mode lock and settings. The channel itself stays on the ircd but stops being managed. This cannot be undone.`}
  confirmLabel="Drop registration"
  onConfirm={drop}
  onCancel={() => (dropTarget = null)}
/>
<ConfirmDialog
  open={confirmFounder}
  tone="warn"
  title={`Transfer ${infoChannel} to a new founder?`}
  message={`${founderDraft.trim() || 'The named account'} gains full control of ${infoChannel}; the previous founder keeps only whatever access entry they hold.`}
  confirmLabel="Transfer founder"
  onConfirm={setFounder}
  onCancel={() => (confirmFounder = false)}
/>
