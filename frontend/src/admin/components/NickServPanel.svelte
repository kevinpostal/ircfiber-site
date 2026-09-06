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
   *
   * The Ownership column states how each account was tied to a person, so
   * drift between Anope and Mongo is visible instead of inferred: most
   * accounts predate credential linking, and dropping one nobody can be
   * traced to is the one irreversible mistake here. Nothing on this page
   * drops an account in bulk — the per-account Drop button stays the only
   * way, deliberately.
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
    /// How the gateway tied this account to a person: an Anope oper block
    /// (`staff`), a saslUsername credential (`linked`), a matching account
    /// email with no credential (`email`), or nothing at all (`unowned`).
    /// Optional because a gateway older than this field answers without it,
    /// and a row nobody can classify must not read as unowned — prod has an
    /// unowned account whose owner was seen online on IRC.
    ownership?: 'staff' | 'linked' | 'email' | 'unowned';
    /// The person behind `ownership`; '' when unknown. Carries the matched
    /// user for `email` rows, where `userId`/`username` are empty because no
    /// credential links them.
    ownerUsername?: string;
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
    unownedCount?: number;
  }
  interface NsPlatform { userId: string; username: string; networkId: string; }
  interface NsInfo {
    nick: string; registered: boolean; account: string; realName: string;
    fields: Record<string, string>; lines: string[]; platform: NsPlatform | null;
  }
  interface UserRow { id: string; username: string; email: string; }
  interface NsLinkResult {
    nick: string; userId: string; username: string; networkId: string;
    passwordRotated: boolean; password?: string;
    previousAccount: string; takenFrom: string;
  }
  /// A website user whose nick no NickServ account owns. `suggestedNick` is
  /// the candidate the automatic provisioner would try first ('' when the
  /// username cannot yield a legal nick); `skipReason` is why it stopped.
  interface NsUnprovisioned {
    userId: string; username: string; email: string;
    networkId: string; hasNetwork: boolean; networkDisabled: boolean;
    suggestedNick: string; skipReason: string;
  }

  let accounts = $state<NsAccount[]>([]);
  let available = $state(true);
  let reason = $state('');
  let asOf = $state(0);
  let listError = $state<string | null>(null);
  let listLoading = $state(false);
  let provisioning = $state<NsProvisioning | null>(null);
  let unprovisioned = $state<NsUnprovisioned[]>([]);
  let unprovLoading = $state(false);
  let unprovError = $state<string | null>(null);
  /// Per-row nick override, keyed by userId; absent means the suggestion.
  let nickDraft = $state<Record<string, string>>({});
  /// Which create is in flight: a userId for a table row, 'lookup' for the
  /// manage card's free-nick form.
  let creating = $state('');

  let filter = $state('');
  /// Narrows the table to accounts no platform user can be tied to — the only
  /// rows where Drop has nobody to ask first. Off by default: it hides most of
  /// the inventory.
  let onlyUnowned = $state(false);
  /// How many rows the gateway itself classified as unowned, or null when it
  /// does not report ownership at all (older gateway). 0 is a real answer and
  /// must still be shown, so absence cannot be spelled as a number.
  let unownedCount = $state<number | null>(null);
  let page = $state(1);
  const pageSize = 25;

  /// Whether this response carries ownership at all. Drives the badge and the
  /// filter row: an older gateway sends neither, and inventing "unowned" for
  /// every row would turn silence into an accusation.
  const hasOwnership = $derived(accounts.some((a) => !!a.ownership));

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    let rows = accounts;
    if (onlyUnowned && hasOwnership) rows = rows.filter((a) => a.ownership === 'unowned');
    if (!q) return rows;
    return rows.filter(
      (a) =>
        a.nick.toLowerCase().includes(q) ||
        a.account.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        (a.ownerUsername ?? '').toLowerCase().includes(q),
    );
  });
  const totalPages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const paged = $derived(filtered.slice((page - 1) * pageSize, page * pageSize));
  $effect(() => { void filter; void onlyUnowned; page = 1; });
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

  // Linking a website user to this NickServ account. The join the table shows
  // is derived from the user's saslUsername, so "linking" means writing a
  // credential that actually authenticates — hence the two modes below.
  let linkQuery = $state('');
  let linkResults = $state<UserRow[]>([]);
  let linkUserId = $state('');
  let linkPassword = $state('');
  let linkSearching = $state(false);
  let linkConflict = $state<string | null>(null);
  let confirmLinkRotate = $state(false);
  let confirmUnlink = $state(false);
  // The selected user's name, for the confirmations. Both dialogs used to
  // name only the NickServ account, and the account is whichever row's
  // Manage was pressed — one row off in a table where `sq` sits directly
  // above `TL` is enough to rotate the wrong person's password. Naming both
  // sides makes a mis-click visible before it is confirmed.
  const linkTargetName = $derived(
    linkResults.find((u) => u.id === linkUserId)?.username ?? ''
  );

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
  /// Ownership evidence, one badge per state. The wording states the evidence
  /// rather than a verdict: `email` is a probable owner with no credential
  /// (13 of Anope's accounts predate saslUsername linking), while `unowned`
  /// is the only state where Drop destroys a nick with nobody to ask — one
  /// such account's owner was seen online on IRC — so it alone reads as a
  /// warning. `staff` holds an oper block and is never a drop candidate.
  const ownershipBadges = {
    staff: {
      label: 'Staff',
      title: 'Holds an Anope oper block — never dropped.',
      tone: 'bg-surface-2 text-muted',
    },
    linked: {
      label: 'Linked',
      title: "Credential stored on this user's IRC Fiber network.",
      tone: 'bg-surface-2 text-muted',
    },
    email: {
      label: 'Same email',
      title: "Registered under this user's account email; not linked as a credential.",
      tone: 'bg-warn/5 text-amber-500',
    },
    unowned: {
      label: 'No platform user',
      title:
        'No IRC Fiber account matches this NickServ account. Dropping it deletes a nick that may still be in use.',
      tone: 'bg-danger/10 text-danger',
    },
  } as const;

  onMount(() => {
    void loadAccounts();
    void loadUnprovisioned();
  });

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
      unownedCount = typeof r.unownedCount === 'number' ? r.unownedCount : null;
    } catch (e) {
      listError = errMsg(e);
    } finally {
      listLoading = false;
    }
  }

  async function loadUnprovisioned() {
    unprovLoading = true;
    unprovError = null;
    try {
      const r = await api.get<{ users: NsUnprovisioned[] }>(
        '/api/admin/ircd/nickserv/unprovisioned',
      );
      unprovisioned = r.users ?? [];
    } catch (e) {
      unprovError = errMsg(e);
    } finally {
      unprovLoading = false;
    }
  }

  function nickFor(u: NsUnprovisioned): string {
    return nickDraft[u.userId] ?? u.suggestedNick;
  }

  /**
   * Register a NickServ account for a website user and store it as their SASL
   * credential. An empty `nick` lets the server walk the same candidate list
   * signup uses, so the response — not the request — names the account.
   */
  async function createAccount(userId: string, nick: string, from: 'list' | 'lookup') {
    if (!userId) {
      toastError('Pick a website user first.');
      return;
    }
    creating = from === 'lookup' ? 'lookup' : userId;
    if (from === 'lookup') actionError = null;
    else unprovError = null;
    try {
      const r = await api.post<{ nick: string; username: string }>(
        '/api/admin/ircd/nickserv/create',
        nick ? { userId, nick } : { userId },
      );
      toastSuccess(`Created ${r.nick} for ${r.username}`);
      await loadUnprovisioned();
      await loadAccounts();
      // The manage card is live INFO, so re-read it: the nick it is showing as
      // free is registered now.
      if (infoNick && r.nick.toLowerCase() === infoNick.toLowerCase()) await lookup(r.nick);
    } catch (e) {
      const msg = errMsg(e);
      if (from === 'lookup') actionError = msg;
      else unprovError = msg;
      toastError(msg);
    } finally {
      creating = '';
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

  /// The table is stale by construction, so refresh every view after an
  /// action: suspending, dropping or unlinking all change who is unsynced.
  async function afterAction(nick: string) {
    await lookup(nick);
    await loadAccounts();
    await loadUnprovisioned();
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
      await loadUnprovisioned();
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

  async function searchUsers() {
    linkSearching = true;
    actionError = null;
    try {
      const q = linkQuery.trim();
      const r = await api.get<{ users: UserRow[] }>('/api/admin/users', q ? { q } : undefined);
      linkResults = r.users ?? [];
      // Preselect when the search leaves exactly one candidate; with several,
      // force an explicit choice rather than guessing at the right person.
      linkUserId = linkResults.length === 1 ? linkResults[0].id : '';
    } catch (e) {
      actionError = errMsg(e);
      linkResults = [];
    } finally {
      linkSearching = false;
    }
  }

  /// `force` moves the account off whoever currently holds it.
  async function link(force = false) {
    const nick = infoNick;
    if (!linkUserId) {
      toastError('Pick a website user first.');
      return;
    }
    const pw = linkPassword.trim();
    confirmLinkRotate = false;
    acting = 'link';
    actionError = null;
    linkConflict = null;
    try {
      const r = await api.post<NsLinkResult>('/api/admin/ircd/nickserv/link', {
        nick,
        userId: linkUserId,
        // A supplied password is only verified; no password means generate one,
        // which rotates the account's and therefore needs confirmation.
        ...(pw ? { password: pw } : { confirm: true }),
        ...(force ? { force: true } : {}),
      });
      toastSuccess(`Linked ${nick} to ${r.username}`);
      if (r.takenFrom) toastInfo(`Moved the account away from ${r.takenFrom}.`);
      linkPassword = '';
      linkQuery = '';
      linkResults = [];
      linkUserId = '';
      // Refresh first: lookup() only clears the password when the nick changes,
      // so a generated credential survives and renders once below.
      await afterAction(nick);
      if (r.passwordRotated && r.password) {
        newPassword = r.password;
        passwordSynced = true;
      }
    } catch (e) {
      actionError = errMsg(e);
      // 409 means another user holds it; offer the move instead of dead-ending.
      // The conflict box carries the message *and* the remedy, so hand it over
      // rather than also rendering it in the generic error line.
      if (e instanceof ApiError && e.status === 409) {
        linkConflict = actionError;
        actionError = null;
      }
      toastError(linkConflict ?? errMsg(e));
    } finally {
      acting = '';
    }
  }

  async function unlink() {
    const nick = infoNick;
    confirmUnlink = false;
    acting = 'unlink';
    actionError = null;
    try {
      const r = await api.post<{ username: string; autoProvisionParkedHours: number }>(
        '/api/admin/ircd/nickserv/unlink', { nick, confirm: true },
      );
      toastSuccess(`Unlinked ${nick} from ${r.username}`);
      toastInfo(
        `Auto-provisioning is parked for ${r.autoProvisionParkedHours}h so the next login ` +
        'does not mint a replacement account.',
      );
      await afterAction(nick);
    } catch (e) {
      actionError = errMsg(e);
      toastError(actionError);
    } finally {
      acting = '';
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

<!--
  Users with no NickServ account, above the inventory because the inventory
  can only list accounts that exist: this is the only view that shows the
  users the network holds no identity for, and the only place to fix it.
  Creating one here is the manual form of what signup does automatically.
-->
<Card class="mb-4">
  <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
    <div>
      <h3 class="text-sm font-semibold text-heading">
        Users without a NickServ account ({unprovisioned.length})
      </h3>
      <p class="mt-0.5 text-xs text-muted">
        Nobody owns their nick, so anyone on IRC can take it. Creating an account registers it and
        stores it as the user's SASL credential — their session reconnects identified. The
        generated password is not shown; use Reset password below for one the owner can type.
      </p>
    </div>
    <button type="button" onclick={() => void loadUnprovisioned()} class={btn}>
      {unprovLoading ? 'Loading…' : 'Refresh'}
    </button>
  </div>

  {#if unprovError}
    <p class="mb-3 text-sm text-danger">{unprovError}</p>
  {/if}

  {#if unprovisioned.length === 0}
    <EmptyState
      title="Every user has a NickServ account"
      hint={unprovError ? 'The list could not be read.' : 'Nothing to sync.'}
    />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
            <th class="py-2 pr-4">Website user</th>
            <th class="py-2 pr-4">Email</th>
            <th class="py-2 pr-4">Nickname to register</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody data-testid="ns-unprovisioned-rows">
          {#each unprovisioned as u (u.userId)}
            <tr class="border-b border-border/50 last:border-0">
              <td class="py-2 pr-4">
                <a href="#/users/{u.userId}" class="text-primary hover:underline">{u.username}</a>
                {#if u.networkDisabled}
                  <div class="text-xs text-amber-500">
                    their irc.ircfiber.com network is disabled — enable it first
                  </div>
                {:else if !u.hasNetwork}
                  <div class="text-xs text-muted">no Fiber network yet — one is created</div>
                {/if}
                {#if u.skipReason}
                  <div class="text-xs text-amber-500" title="Auto-provisioning parked for 24h">
                    provisioning gave up: {u.skipReason}
                  </div>
                {/if}
              </td>
              <td class="max-w-[14rem] truncate py-2 pr-4 text-muted">{u.email || '—'}</td>
              <td class="py-2 pr-4">
                <input
                  value={nickFor(u)}
                  oninput={(e) => (nickDraft[u.userId] = e.currentTarget.value)}
                  placeholder="nickname"
                  aria-label="Nickname for {u.username}"
                  class="w-full max-w-[180px] font-mono {input}"
                />
                {#if !u.suggestedNick}
                  <div class="text-xs text-amber-500">
                    no legal nick can be derived from this username — type one
                  </div>
                {/if}
              </td>
              <td class="py-2 text-right">
                <button
                  type="button"
                  data-testid="ns-create-{u.userId}"
                  disabled={!nickFor(u).trim() || creating === u.userId}
                  onclick={() => void createAccount(u.userId, nickFor(u).trim(), 'list')}
                  class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-40"
                >
                  {creating === u.userId ? 'Creating…' : 'Create account'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

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

  <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
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
    <!--
      Ownership is only offered when the gateway reports it: without the field
      every row would match "no platform user" and the filter would lie.
    -->
    {#if hasOwnership}
      <label class="flex items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          bind:checked={onlyUnowned}
          aria-label="Only accounts with no platform user"
        />
        Only accounts with no platform user
      </label>
      {#if unownedCount !== null}
        <span
          data-testid="ns-unowned-count"
          class="rounded px-2 py-0.5 text-xs font-semibold {unownedCount > 0
            ? 'bg-danger/10 text-danger'
            : 'bg-surface-2 text-muted'}"
        >
          {unownedCount}
        </span>
      {/if}
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
            {#if hasOwnership}
              <th class="py-2 pr-4">Ownership</th>
            {/if}
            <th class="py-2 pr-4">Email</th>
            <th class="py-2 pr-4">Registered</th>
            <th class="py-2 pr-4">Last seen</th>
            <th class="py-2 pr-4">State</th>
            <th class="py-2"></th>
          </tr>
        </thead>
        <tbody data-testid="ns-accounts-rows">
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
              {#if hasOwnership}
                <td class="py-2 pr-4">
                  {#if a.ownership}
                    {@const badge = ownershipBadges[a.ownership]}
                    <span
                      data-testid="ns-ownership-{a.nick}"
                      title={badge.title}
                      class="whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold {badge.tone}"
                    >
                      {badge.label}
                    </span>
                    <!--
                      An `email` match has no credential, so the Website-user
                      column above is empty for it; the matched user is only
                      visible here.
                    -->
                    {#if a.ownership === 'email' && a.ownerUsername}
                      <div class="mt-0.5 text-xs text-muted">{a.ownerUsername}</div>
                    {/if}
                  {:else}
                    <span class="text-muted">—</span>
                  {/if}
                </td>
              {/if}
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
    <EmptyState
      title="Not registered"
      hint="This nickname is free — register it for a website user below."
    />
    <!--
      The other way into creation: an admin who already knows which nick they
      want types it here. The table above only offers each user's suggested
      nick, which is the wrong tool when the account name is the decision.
    -->
    <div class="mt-3 border-t border-border/40 pt-3">
      <h4 class="text-xs font-semibold text-heading">Register this nick for an IRC Fiber user</h4>
      <p class="mt-0.5 text-xs text-muted">
        Registers <span class="font-mono">{infoNick}</span> with NickServ and stores it as that
        user's SASL credential, so their session identifies with it. The generated password is not
        shown — use Reset password afterwards if the owner needs one they can type.
      </p>
      <form
        class="mt-2 flex flex-wrap items-center gap-2"
        onsubmit={(e) => { e.preventDefault(); void searchUsers(); }}
      >
        <input
          type="search"
          bind:value={linkQuery}
          placeholder="Search users by name or email…"
          aria-label="Search users to create for"
          class="w-full max-w-[260px] {input}"
        />
        <button type="submit" class={btn}>{linkSearching ? 'Searching…' : 'Search'}</button>
      </form>
      {#if linkResults.length > 0}
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <select
            bind:value={linkUserId}
            aria-label="Website user to create for"
            class="max-w-[320px] {input}"
          >
            <option value="">Select a user…</option>
            {#each linkResults as u}
              <option value={u.id}>{u.username} · {u.email}</option>
            {/each}
          </select>
          <button
            type="button"
            data-testid="ns-create-for-user"
            onclick={() => void createAccount(linkUserId, infoNick, 'lookup')}
            class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
          >
            {creating === 'lookup' ? 'Creating…' : 'Create account'}
          </button>
        </div>
      {:else if linkQuery && !linkSearching}
        <p class="mt-2 text-xs text-muted">No users matched.</p>
      {/if}
    </div>
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

    <!--
      Link / unlink. The Website user row above is derived from the account's
      saslUsername, so this is the only place the join can actually be created:
      it writes a proven credential onto the user's irc.ircfiber.com network.
    -->
    {#if info.platform}
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <span class="text-xs text-muted">
          Linked to <span class="font-semibold text-text">{info.platform.username}</span>
        </span>
        <button
          type="button"
          data-testid="ns-unlink"
          onclick={() => (confirmUnlink = true)}
          class="rounded-md border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-danger/10"
        >
          {acting === 'unlink' ? 'Loading…' : 'Unlink'}
        </button>
      </div>
    {:else}
      <div class="mt-3 border-t border-border/40 pt-3">
        <h4 class="text-xs font-semibold text-heading">
          Link <span class="font-mono">{infoNick}</span> to an IRC Fiber user
        </h4>
        <p class="mt-0.5 text-xs text-muted">
          Writes this account as the user's SASL credential and reconnects their session. Leave
          the password blank to generate a new one; supply the existing password to link without
          changing it.
        </p>
        <form
          class="mt-2 flex flex-wrap items-center gap-2"
          onsubmit={(e) => { e.preventDefault(); void searchUsers(); }}
        >
          <input
            type="search"
            bind:value={linkQuery}
            placeholder="Search users by name or email…"
            aria-label="Search users to link"
            class="w-full max-w-[260px] {input}"
          />
          <button type="submit" class={btn}>{linkSearching ? 'Searching…' : 'Search'}</button>
        </form>
        {#if linkResults.length > 0}
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <select
              bind:value={linkUserId}
              aria-label="Website user to link"
              class="max-w-[320px] {input}"
            >
              <option value="">Select a user…</option>
              {#each linkResults as u}
                <option value={u.id}>{u.username} · {u.email}</option>
              {/each}
            </select>
            <input
              bind:value={linkPassword}
              type="password"
              placeholder="existing password (optional)"
              aria-label="Existing NickServ password"
              class="w-full max-w-[220px] font-mono {input}"
            />
            <button
              type="button"
              data-testid="ns-link"
              onclick={() => (linkPassword.trim() ? void link() : (confirmLinkRotate = true))}
              class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90"
            >
              {acting === 'link' ? 'Loading…' : 'Link account'}
            </button>
          </div>
        {:else if linkQuery && !linkSearching}
          <p class="mt-2 text-xs text-muted">No users matched.</p>
        {/if}
        {#if linkConflict}
          <div class="mt-2 rounded-md border border-warn/40 bg-warn/5 p-2">
            <p class="text-xs text-danger">{linkConflict}</p>
            <button
              type="button"
              data-testid="ns-link-force"
              onclick={() => void link(true)}
              class="mt-2 {btn}"
            >
              Move the account anyway
            </button>
          </div>
        {/if}
      </div>
    {/if}

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
<ConfirmDialog
  open={confirmLinkRotate}
  tone="warn"
  title={`Link ${infoNick} and generate a new password?`}
  message={`${infoNick} becomes ${linkTargetName || 'the selected user'}'s SASL credential. No existing password was supplied, so a new one is generated for ${infoNick} and shown once: anyone using the old password — including ${infoNick}'s owner — stops being able to identify. Cancel and supply the existing password to link without changing it.`}
  confirmLabel="Generate and link"
  onConfirm={() => link()}
  onCancel={() => (confirmLinkRotate = false)}
/>
<ConfirmDialog
  open={confirmUnlink}
  tone="danger"
  title="Unlink this account from the user?"
  message={`${infoNick} stays registered on services, but stops being ${info?.platform?.username ?? 'the user'}'s SASL credential and their session reconnects unauthenticated. Auto-provisioning is parked for 24h so the next login does not mint a replacement.`}
  confirmLabel="Unlink"
  onConfirm={unlink}
  onCancel={() => (confirmUnlink = false)}
/>
