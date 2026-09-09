<script lang="ts">
  /**
   * InvitesPanel — `!adduser` invite + provisioned-account management
   * (IRCD page → Invites).
   *
   * Two cards, two data paths:
   *   1. "Pending invites" lists unredeemed 24h single-use invite tokens
   *      (`/api/admin/ircd/invites`). Row ids are `sha256(token)[0..16]` —
   *      the bearer token never leaves the gateway, so there is deliberately
   *      no copy-link button here: the link was PM'd to the nick holder, and
   *      an oper relays it from their own DM when delivery failed.
   *   2. "Provisioned accounts" lists every site account `!adduser` created
   *      (`/api/admin/ircd/provisioned`, `provisionedFrom = nickserv:<acct>`).
   *
   * Revoking an invite kills the link immediately; redeeming or expiry needs
   * no action. Nothing here touches NickServ accounts — that stays in the
   * NickServ tab.
   */
  import { onMount } from 'svelte';
  import Card from './Card.svelte';
  import EmptyState from './EmptyState.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';

  interface Invite {
    id: string; nick: string; invitedBy: string;
    createdAt: number; ttlSecs: number;
  }
  interface Provisioned {
    username: string; email: string; provisionedFrom: string;
    signupIp: string; createdAt: number;
  }

  let invites = $state<Invite[]>([]);
  let invitesError = $state<string | null>(null);
  let invitesLoading = $state(false);
  let provisioned = $state<Provisioned[]>([]);
  let provError = $state<string | null>(null);
  let provLoading = $state(false);
  let revoking = $state('');
  let confirmId = $state<string | null>(null);

  onMount(() => {
    void fetchInvites();
    void fetchProvisioned();
  });

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchInvites() {
    invitesLoading = true; invitesError = null;
    try {
      const r = await api.get<{ invites: Invite[] }>('/api/admin/ircd/invites');
      invites = r.invites ?? [];
    } catch (e) {
      invitesError = errMsg(e);
    } finally { invitesLoading = false; }
  }

  async function fetchProvisioned() {
    provLoading = true; provError = null;
    try {
      const r = await api.get<{ users: Provisioned[] }>('/api/admin/ircd/provisioned');
      provisioned = r.users ?? [];
    } catch (e) {
      provError = errMsg(e);
    } finally { provLoading = false; }
  }

  function fmtDate(ts: number): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  }

  function fmtTtl(secs: number): string {
    if (secs < 0) return 'expired';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m left`;
    if (m > 0) return `${m}m left`;
    return `${secs}s left`;
  }

  async function revoke(id: string) {
    confirmId = null;
    revoking = id;
    try {
      const r = await api.post<{ revoked: boolean }>('/api/admin/ircd/invites/revoke', { id });
      toastSuccess(r.revoked ? 'Invite revoked.' : 'Invite was already gone.');
      await fetchInvites();
    } catch (e) {
      toastError(errMsg(e));
    } finally { revoking = ''; }
  }

  const inputCls =
    'rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text placeholder-muted focus:border-primary focus:outline-none';
  const btnDanger =
    'rounded-md bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger/90 disabled:opacity-50';
</script>

<Card>
  <div class="mb-3 flex items-center justify-between">
    <div>
      <h3 class="text-sm font-semibold text-heading">Pending invites</h3>
      <p class="text-xs text-muted">Unredeemed <code>!adduser</code> signup links — single use, 24h expiry.</p>
    </div>
    <button type="button" class={inputCls} onclick={() => void fetchInvites()} disabled={invitesLoading}>
      {invitesLoading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>
  {#if invitesError}
    <p class="text-sm text-danger">{invitesError}</p>
  {:else if invitesLoading && invites.length === 0}
    <p class="text-sm text-muted">Loading…</p>
  {:else if invites.length === 0}
    <EmptyState title="No pending invites" hint="Run !adduser <nick> for a nick with no NickServ account to mint one." />
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead>
          <tr class="border-b border-border text-xs text-muted">
            <th class="py-2 pr-3 font-medium">Nick</th>
            <th class="py-2 pr-3 font-medium">Invited by</th>
            <th class="py-2 pr-3 font-medium">Created</th>
            <th class="py-2 pr-3 font-medium">Expires</th>
            <th class="py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {#each invites as inv (inv.id)}
            <tr class="border-b border-border/50 transition-opacity {revoking === inv.id ? 'opacity-40' : ''}">
              <td class="py-2 pr-3 font-medium text-heading">{inv.nick}</td>
              <td class="py-2 pr-3 text-text">{inv.invitedBy}</td>
              <td class="py-2 pr-3 text-muted">{fmtDate(inv.createdAt)}</td>
              <td class="py-2 pr-3 text-muted">{fmtTtl(inv.ttlSecs)}</td>
              <td class="py-2 text-right">
                <button
                  type="button"
                  class={btnDanger}
                  disabled={revoking === inv.id}
                  onclick={() => { confirmId = inv.id; }}
                >
                  {revoking === inv.id ? 'Revoking…' : 'Revoke'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Card>

<div class="mt-4">
  <Card>
    <div class="mb-3 flex items-center justify-between">
      <div>
        <h3 class="text-sm font-semibold text-heading">Provisioned accounts</h3>
        <p class="text-xs text-muted">Site accounts created by <code>!adduser</code> from a NickServ account.</p>
      </div>
      <button type="button" class={inputCls} onclick={() => void fetchProvisioned()} disabled={provLoading}>
        {provLoading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    {#if provError}
      <p class="text-sm text-danger">{provError}</p>
    {:else if provLoading && provisioned.length === 0}
      <p class="text-sm text-muted">Loading…</p>
    {:else if provisioned.length === 0}
      <EmptyState title="No provisioned accounts" hint="Nothing imported via !adduser yet." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-border text-xs text-muted">
              <th class="py-2 pr-3 font-medium">Username</th>
              <th class="py-2 pr-3 font-medium">Email</th>
              <th class="py-2 pr-3 font-medium">From</th>
              <th class="py-2 pr-3 font-medium">Signup IP</th>
              <th class="py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {#each provisioned as u (u.username)}
              <tr class="border-b border-border/50">
                <td class="py-2 pr-3 font-medium text-heading">{u.username}</td>
                <td class="py-2 pr-3 text-text">{u.email}</td>
                <td class="py-2 pr-3 text-muted">{u.provisionedFrom}</td>
                <td class="py-2 pr-3 text-muted">{u.signupIp}</td>
                <td class="py-2 text-muted">{fmtDate(u.createdAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
</div>

<ConfirmDialog
  open={confirmId !== null}
  title="Revoke invite"
  message="The signup link dies immediately. The nick holder will need a new !adduser to get back in."
  confirmLabel="Revoke"
  onConfirm={() => confirmId !== null && revoke(confirmId)}
  onCancel={() => { confirmId = null; }}
/>
