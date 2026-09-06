<script lang="ts">
  /**
   * NickServPanel — Anope/NickServ account management (IRCD page → NickServ).
   *
   * Two cards, two data paths:
   *   1. "Accounts" is the whole inventory, read from Anope's flatfile on the
   *      gateway (`/api/admin/ircd/nickserv/accounts`). It is up to five
   *      minutes stale — Anope only flushes anope.db every `updatetimeout` —
   *      so the header states the "as of" time. Filtering and paging are
   *      client-side: the list is already loaded, so a request per keystroke
   *      would buy nothing.
   *   2. "Manage account" is live `NickServ INFO` over XML-RPC and is
   *      therefore authoritative over the table. Every successful action
   *      re-runs the lookup and refreshes the table.
   *
   * Accounts owned by a website user are annotated with that user, because
   * suspending/dropping/resetting one of those also changes what the engine
   * authenticates with.
   */
  import { onMount } from 'svelte';
  import Card from './Card.svelte';
  import EmptyState from './EmptyState.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError, toastInfo } from '../stores/ui';

  interface NsAccount {
    nick: string; account: string; email: string;
    registeredAt: number; lastSeenAt: number; lastUsermask: string; lastRealName: string;
    suspended: boolean; suspendedBy: string; suspendReason: string;
    suspendedAt: number; suspendExpiresAt: number;
    userId: string; username: string; userEmail: string;
    networkId: string; networkNick: string; networkDisabled: boolean;
  }
  /// How provisioning itself is going. `pendingOrphans`, `skipMarkers` and
  /// `unprovisioned` are `-1` when the gateway could not read that source.
  interface NsProvisioning {
    outcomes: Record<string, number>;
    lastOutcome: string; lastOutcomeAt: number;
    pendingOrphans: number; skipMarkers: number; unprovisioned: number;
  }
  interface NsAccountsResponse {
    available: boolean; reason: string; asOf: number; accounts: NsAccount[];
    provisioning?: NsProvisioning;
  }
  interface NsPlatform { userId: string; username: string; networkId: string; }
  interface NsInfo {
    nick: string; registered: boolean; account: string; realName: string;
    fields: Record<string, string>; lines: string[]; platform: NsPlatform | null;
  }

  let accounts = $state<NsAccount[]>([]);
  let available = $state(true);
  let reason = $state('');
  let asOf = $state(0);
  let listError = $state<string | null>(null);
  let listLoading = $state(false);
  let provisioning = $state<NsProvisioning | null>(null);

  let filter = $state('');
  let page = $state(1);
  const pageSize = 25;

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.nick.toLowerCase().includes(q) ||
        a.account.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q),
    );
  });
  const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));
  $effect(() => { void filter; page = 1; });
  $effect(() => { if (page > totalPages) page = totalPages; });

  let lookupNick = $state('');
  let infoNick = $state('');
  let info = $state<NsInfo | null>(null);
  let infoError = $state<string | null>(null);
  let infoLoading = $state(false);
  let actionError = $state<string | null>(null);
  /// Which action is in flight, so only its button shows "Loading…".
  let acting = $state('');

  let showSuspend = $state(false);
  let suspendReason = $state('');
  let suspendExpiry = $state('');
  let newPassword = $state('');
  let passwordSynced = $state(true);
  let confirmDrop = $state(false);
  let confirmReset = $state(false);

  /// `ns_info` emits labels in a fixed order; anything Anope adds later is
  /// appended rather than dropped. The suspension labels are the ones
  /// 2.0.20 actually renders (`ns_suspend`'s `show` list names options, not
  /// labels), so they group with `Suspended` instead of trailing the list.
  const fieldOrder = [
    'Account', 'Email address', 'Registered', 'Last seen', 'Last seen address',
    'Online from', 'Suspended', 'Suspended by', 'Suspend reason', 'Suspended on',
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
  /// The backend reports a count it could not read as -1, because rendering a
  /// Redis failure as "0 orphans" would be the exact false all-clear this
  /// section exists to prevent.
  function fmtCount(n: number): string {
    return n < 0 ? 'unknown' : String(n);
  }
  /// Only outcomes that actually happened: a wall of zeroes hides the one
  /// number that matters. An empty list is itself the signal that the
  /// provisioner has never run.
  const outcomeRows = $derived.by(() => {
    const o = provisioning?.outcomes ?? {};
    return Object.entries(o).filter(([, count]) => count > 0);
  });
  const badOutcomes = ['failed', 'collisionExhausted', 'nickUnavailable'];
  function outcomeClass(name: string): string {
    if (badOutcomes.includes(name)) return 'text-danger';
    if (name === 'deferred') return 'text-amber-500';
    return 'text-muted';
  }

  onMount(() => { void loadAccounts(); });

  async function loadAccounts() {
    listLoading = true;
    listError = null;
    try {
      const r = await api.get<NsAccountsResponse>('/api/admin/ircd/nickserv/accounts');
      accounts = r.accounts ?? [];
      available = r.available;
      reason = r.reason ?? '';
      asOf = r.asOf ?? 0;
      provisioning = r.provisioning ?? null;
    } catch (e) {
      listError = errMsg(e);
    } finally {
      listLoading = false;
    }
  }

  async function lookup(nick: string) {
    const n = nick.trim();
    if (!n) return;
    // Switching accounts must never leave the previous password on screen.
    if (n.toLowerCase() !== infoNick.toLowerCase()) newPassword = '';
    infoNick = n;
    lookupNick = n;
    infoLoading = true;
    infoError = null;
    actionError = null;
    showSuspend = false;
    try {
      info = await api.get<NsInfo>('/api/admin/ircd/nickserv/account', { nick: n });
    } catch (e) {
      info = null;
      infoError = errMsg(e);
    } finally {
      infoLoading = false;
    }
  }

  /// The table is stale by construction, so refresh both after every action.
  async function afterAction(nick: string) {
    await lookup(nick);
    await loadAccounts();
  }

  async function suspend() {
    const nick = infoNick;
    const r = suspendReason.trim();
    if (!r) { toastError('A reason is required.'); return; }
    acting = 'suspend';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/nickserv/suspend', {
        nick, reason: r, expiry: suspendExpiry.trim(),
      });
      toastSuccess('Suspended ' + nick);
      suspendReason = '';
      suspendExpiry = '';
      await afterAction(nick);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function unsuspend() {
    const nick = infoNick;
    acting = 'unsuspend';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/nickserv/unsuspend', { nick });
      toastSuccess('Unsuspended ' + nick);
      await afterAction(nick);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function logout() {
    const nick = infoNick;
    acting = 'logout';
    actionError = null;
    try {
      await api.post('/api/admin/ircd/nickserv/logout', { nick });
      toastSuccess('Logged out ' + nick);
      await afterAction(nick);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function resetPassword() {
    const nick = infoNick;
    confirmReset = false;
    acting = 'password';
    actionError = null;
    try {
      const r = await api.post<{ nick: string; password: string; platformSynced: boolean }>(
        '/api/admin/ircd/nickserv/password', { nick, confirm: true },
      );
      // Refresh first: `lookup` clears the password only when the nick changes,
      // so the credential survives and is rendered once below.
      await afterAction(nick);
      newPassword = r.password;
      passwordSynced = r.platformSynced;
      toastSuccess('New password for ' + nick);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function drop() {
    const nick = infoNick;
    confirmDrop = false;
    acting = 'drop';
    actionError = null;
    try {
      const r = await api.post<{ nick: string; dropped: boolean; reprovisioning: boolean }>(
        '/api/admin/ircd/nickserv/drop', { nick, confirm: true },
      );
      toastSuccess('Dropped ' + nick);
      if (r.reprovisioning) toastInfo('A replacement account is being provisioned for the owner.');
      info = null;
      infoNick = '';
      lookupNick = '';
      newPassword = '';
      await loadAccounts();
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(newPassword);
      toastSuccess('Password copied');
    } catch {
      toastError('Could not copy to the clipboard.');
    }
  }

  const btn = 'rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40';
  const input =
    'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder-muted focus:border-primary focus:outline-none';
</script>

<!--
  Provisioning health, above the inventory because it answers the question the
  table cannot: whether website users are getting NickServ accounts at all.
  Prod ran with zero of ten users provisioned and the only trace was a log
  line nobody read.
-->
{#if provisioning}
  <Card class="mb-4">
    <h3 class="text-sm font-semibold text-heading">Provisioning</h3>
    <p class="mt-0.5 text-xs text-muted">
      Signup and every login run the NickServ provisioner. A transport failure sets no skip
      marker, so it retries forever without complaining — these counters are where that shows.
    </p>

    <div class="mt-3 grid gap-4 sm:grid-cols-3">
      <div>
        <div
          data-testid="ns-pending-orphans"
          class="text-xl font-semibold {provisioning.pendingOrphans > 0
            ? 'text-danger'
            : 'text-heading'}"
        >
          {fmtCount(provisioning.pendingOrphans)}
        </div>
        <div
          class="text-xs font-medium {provisioning.pendingOrphans > 0
            ? 'text-danger'
            : 'text-muted'}"
        >
          orphan pending credentials
        </div>
        <p class="mt-0.5 text-xs text-muted">
          Generated but never stored. Each one is a user locked out of their own nick.
        </p>
      </div>

      <div>
        <div
          data-testid="ns-unprovisioned"
          class="text-xl font-semibold {provisioning.unprovisioned > 0
            ? 'text-amber-500'
            : 'text-heading'}"
        >
          {fmtCount(provisioning.unprovisioned)}
        </div>
        <div
          class="text-xs font-medium {provisioning.unprovisioned > 0
            ? 'text-amber-500'
            : 'text-muted'}"
        >
          users without a NickServ credential
        </div>
        <p class="mt-0.5 text-xs text-muted">
          Their irc.ircfiber.com network has no SASL account, so nobody owns their nick.
        </p>
      </div>

      <div>
        <div data-testid="ns-skip-markers" class="text-xl font-semibold text-heading">
          {fmtCount(provisioning.skipMarkers)}
        </div>
        <div class="text-xs font-medium text-muted">users skipped for 24h</div>
        <p class="mt-0.5 text-xs text-muted">
          Provisioning gave up on these after a permanent refusal; it retries after the marker
          expires.
        </p>
      </div>
    </div>

    <div class="mt-3 border-t border-border pt-3 text-xs text-muted">
      {#if outcomeRows.length}
        <div class="flex flex-wrap items-center gap-2" data-testid="ns-outcomes">
          {#each outcomeRows as [name, count] (name)}
            <span class="rounded border border-border px-1.5 py-0.5 font-mono {outcomeClass(name)}">
              {name} {count}
            </span>
          {/each}
        </div>
      {:else}
        <p data-testid="ns-outcomes">No provisioning attempt has been recorded yet.</p>
      {/if}
      {#if provisioning.lastOutcome}
        <p class="mt-2">
          Last attempt: <span class="font-mono {outcomeClass(provisioning.lastOutcome)}"
            >{provisioning.lastOutcome}</span
          >
          {provisioning.lastOutcomeAt ? `· ${fmtTime(provisioning.lastOutcomeAt)}` : ''}
        </p>
      {/if}
    </div>
  </Card>
{/if}

<Card>
  <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
    <div>
      <h3 class="text-sm font-semibold text-heading">Accounts ({accounts.length})</h3>
      <p class="mt-0.5 text-xs text-muted">
        {asOf
          ? `inventory as of ${new Date(asOf * 1000).toLocaleTimeString()} — `
          : ''}Anope flushes anope.db every 5 minutes
      </p>
    </div>
    <button type="button" onclick={() => void loadAccounts()} class={btn}>
      {listLoading ? 'Loading…' : 'Refresh'}
    </button>
  </div>

  {#if !available}
    <p class="mb-3 text-xs text-amber-500">{reason} · Showing IRC Fiber accounts only.</p>
  {/if}

  <div class="mb-3 flex items-center gap-2">
    <input
      type="search"
      bind:value={filter}
      placeholder="Filter by nick, account, email or website user…"
      aria-label="Filter NickServ accounts"
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
      title="No accounts"
      hint={accounts.length ? 'No account matches this filter.' : 'No NickServ accounts were found.'}
    />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
            <th class="py-2 pr-4">Nick</th>
            <th class="py-2 pr-4">Account</th>
            <th class="py-2 pr-4">Website user</th>
            <th class="py-2 pr-4">Email</th>
            <th class="py-2 pr-4">Registered</th>
            <th class="py-2 pr-4">Last seen</th>
            <th class="py-2 pr-4">State</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each paged as a}
            <tr class="border-b border-border/50 last:border-0">
              <td class="py-2 pr-4 font-mono font-semibold">{a.nick}</td>
              <td class="py-2 pr-4 font-mono text-muted">{a.account || '—'}</td>
              <td class="py-2 pr-4">
                {#if a.userId}
                  <a href="#/users/{a.userId}" class="text-primary hover:underline">
                    {a.username || 'unknown'}
                  </a>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td class="max-w-[14rem] truncate py-2 pr-4 text-muted">{a.email || '—'}</td>
              <td class="py-2 pr-4 text-xs text-muted">{fmtTime(a.registeredAt)}</td>
              <td class="py-2 pr-4 text-xs text-muted">{fmtTime(a.lastSeenAt)}</td>
              <td class="py-2 pr-4 text-xs">
                {#if a.suspended}
                  <span class="font-semibold text-danger">Suspended</span>
                {:else if a.networkDisabled}
                  <span class="text-muted">network disabled</span>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
                {#if a.networkNick && a.networkNick !== a.account}
                  <span
                    class="ml-1 text-amber-500"
                    title="Network nick differs from the services account"
                  >
                    ≠ {a.networkNick}
                  </span>
                {/if}
              </td>
              <td class="py-2 text-right">
                <button type="button" onclick={() => void lookup(a.nick)} class={btn}>Manage</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div
      class="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted"
    >
      <div>{filtered.length} accounts • page {page} of {totalPages}</div>
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
    <h3 class="text-sm font-semibold text-heading">Manage account</h3>
    {#if info?.fields.Suspended}
      <span class="rounded bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">
        Suspended
      </span>
    {/if}
    <span class="text-xs text-muted">Live NickServ INFO — authoritative over the table above</span>
  </div>

  <form
    class="mb-3 flex flex-wrap items-center gap-2"
    onsubmit={(e) => { e.preventDefault(); void lookup(lookupNick); }}
  >
    <input
      type="text"
      bind:value={lookupNick}
      placeholder="nickname"
      aria-label="Nickname to look up"
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
    <EmptyState title="Not registered" hint="This nickname is free." />
  {:else if info}
    <dl class="text-sm">
      {#each orderedFields as [label, value]}
        <div class="flex justify-between gap-4 border-b border-border/40 py-1">
          <dt class="text-muted">{label}</dt>
          <dd class="font-mono text-xs">{value}</dd>
        </div>
      {/each}
      {#if info.platform}
        <div class="flex justify-between gap-4 py-1">
          <dt class="text-muted">Website user</dt>
          <dd>
            <a href="#/users/{info.platform.userId}" class="text-primary hover:underline">
              {info.platform.username || 'unknown'}
            </a>
          </dd>
        </div>
      {/if}
    </dl>

    <details class="mt-3">
      <summary class="cursor-pointer text-xs text-muted">Raw NickServ reply</summary>
      <pre
        class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-text">{info.lines.join('\n')}</pre>
    </details>

    <div class="mt-4 flex flex-wrap gap-2">
      <button type="button" onclick={() => (showSuspend = !showSuspend)} class={btn}>Suspend</button>
      <button type="button" onclick={() => void unsuspend()} class={btn}>
        {acting === 'unsuspend' ? 'Loading…' : 'Unsuspend'}
      </button>
      <button type="button" onclick={() => (confirmReset = true)} class={btn}>
        {acting === 'password' ? 'Loading…' : 'Reset password'}
      </button>
      <button type="button" onclick={() => void logout()} class={btn}>
        {acting === 'logout' ? 'Loading…' : 'Force logout'}
      </button>
      <button
        type="button"
        onclick={() => (confirmDrop = true)}
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
          {acting === 'suspend' ? 'Loading…' : 'Suspend account'}
        </button>
      </form>
    {/if}

    {#if newPassword}
      <div class="mt-4 rounded-md border border-warn/40 bg-warn/5 p-3">
        <p class="text-xs text-muted">Shown once — copy it now.</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <input
            readonly
            value={newPassword}
            aria-label="New NickServ password"
            class="w-full max-w-[280px] font-mono {input}"
          />
          <button type="button" onclick={() => void copyPassword()} class={btn}>Copy</button>
        </div>
        {#if !passwordSynced}
          <p class="mt-2 text-xs text-amber-500">
            Not an IRC Fiber account — hand this password to the owner yourself.
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</Card>

<ConfirmDialog
  open={confirmReset}
  tone="warn"
  title="Reset the NickServ password?"
  message={`A new password is generated for ${infoNick}. If it belongs to an IRC Fiber user their session reconnects with the new credential.`}
  confirmLabel="Generate new password"
  onConfirm={resetPassword}
  onCancel={() => (confirmReset = false)}
/>
<ConfirmDialog
  open={confirmDrop}
  tone="danger"
  title="Drop this NickServ account?"
  message={`${infoNick} is deleted from services and the nickname becomes free. This cannot be undone.`}
  confirmLabel="Drop account"
  onConfirm={drop}
  onCancel={() => (confirmDrop = false)}
/>
