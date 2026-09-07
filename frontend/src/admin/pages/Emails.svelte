<script lang="ts">
  /**
   * Emails page — signup-verification delivery: provider/configuration
   * state, the gateway's own send log with 24h counts, the live
   * pending-signup queue with Resend/Revoke, and the two signup throttles
   * (per-email cooldown, per-IP hourly counter) with Clear.
   *
   * Backed by /api/admin/emails/*. A pending row is addressed by an opaque
   * id (sha256 of the verification token), never by the token itself: the
   * token is the credential that creates the account.
   */
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '../components/PageHeader.svelte';
  import Card from '../components/Card.svelte';
  import KpiCard from '../components/KpiCard.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import StatusBadge from '../components/StatusBadge.svelte';
  import ConfirmDialog from '../components/ConfirmDialog.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { duration, relative } from '../lib/format';

  interface ProviderState {
    provider: string;
    configured: boolean;
    tokenPresent: boolean;
    fromEmail: string;
    fromName: string;
    publicUrl: string;
    verificationRequired: boolean;
    verificationSource: string;
  }
  interface Stats {
    sent24h: number; failed24h: number;
    sentWindow: number; failedWindow: number; windowSize: number;
    lastSentAt: number; lastFailedAt: number; lastError: string;
  }
  interface SendEvent {
    atMs: number; kind: string; toEmail: string; username: string;
    provider: string; status: string; error: string; durationMs: number;
    sourceIp: string;
  }
  interface PendingRow {
    id: string; username: string; email: string;
    createdAt: number; ttlSeconds: number;
  }
  interface CooldownRow { email: string; ttlSeconds: number; }
  interface IpRow { ip: string; count: number; ttlSeconds: number; }
  interface Overview {
    provider: ProviderState;
    stats: Stats;
    events: SendEvent[];
    pending: PendingRow[];
    cooldowns: CooldownRow[];
    ipCounters: IpRow[];
    redisError: string;
  }

  let overview = $state<Overview | null>(null);
  let overviewError = $state<string | null>(null);
  let loading = $state(false);

  let testEmail = $state('');
  let testing = $state(false);
  // A provider rejection is long and matters after the toast is gone.
  let testError = $state<string | null>(null);

  type Ask =
    | { action: 'test'; email: string }
    | { action: 'resend'; row: PendingRow }
    | { action: 'revoke'; row: PendingRow };
  let ask = $state<Ask | null>(null);
  let acting = $state(false);

  let stop: (() => void) | null = null;
  onMount(() => {
    stop = startPolling(
      async () => { await fetchOverview(false); },
      { intervalMs: 30_000 },
    );
  });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchOverview(spinner: boolean = overview === null) {
    if (spinner) loading = true;
    overviewError = null;
    try {
      overview = await api.get<Overview>('/api/admin/emails');
    } catch (e) {
      overviewError = errMsg(e);
    } finally { loading = false; }
  }

  // Verification required with no configured provider is the state where
  // every signup answers 503, so it reads as an error, not a warning.
  const providerTone = $derived.by((): 'success' | 'warn' | 'danger' | 'muted' => {
    const p = overview?.provider;
    if (!p) return 'muted';
    if (!p.verificationRequired) return 'warn';
    return p.configured ? 'success' : 'danger';
  });
  const providerLabel = $derived.by(() => {
    const p = overview?.provider;
    if (!p) return '—';
    if (!p.verificationRequired) return 'Verification off';
    return p.configured ? 'Configured' : 'Not configured';
  });

  function confirmTest() {
    if (!testEmail || testing) return;
    ask = { action: 'test', email: testEmail };
  }
  function confirmResend(row: PendingRow) { ask = { action: 'resend', row }; }
  function confirmRevoke(row: PendingRow) { ask = { action: 'revoke', row }; }

  const askTitle = $derived(
    ask?.action === 'test' ? 'Send a test email?'
      : ask?.action === 'resend' ? `Resend the link to ${ask.row.email}?`
        : ask?.action === 'revoke' ? `Revoke the signup for ${ask.row.username}?` : '');
  const askMessage = $derived(
    ask?.action === 'test'
      ? `A real message is sent to ${ask.email} through the configured provider.`
      : ask?.action === 'resend'
        ? `The same confirmation link is emailed again to ${ask.row.email}. The existing link keeps working.`
        : ask?.action === 'revoke'
          ? `The pending signup for ${ask.row.email} is dropped and its link stops working. The address can sign up again immediately.`
          : '');

  async function doConfirm() {
    if (!ask || acting) return;
    const current = ask;
    acting = true;
    try {
      if (current.action === 'test') {
        testing = true;
        testError = null;
        const r = await api.post<{ email: string }>('/api/admin/emails/test', { email: current.email });
        toastSuccess(`Test email sent to ${r.email}`);
      } else if (current.action === 'resend') {
        const r = await api.post<{ email: string }>(
          `/api/admin/emails/pending/${current.row.id}/resend`);
        toastSuccess(`Confirmation link resent to ${r.email}`);
      } else {
        const r = await api.post<{ email: string }>(
          `/api/admin/emails/pending/${current.row.id}/revoke`);
        toastSuccess(`Revoked the pending signup for ${r.email}`);
      }
      ask = null;
      await fetchOverview(false);
    } catch (e) {
      const msg = errMsg(e);
      if (current.action === 'test') testError = msg;
      toastError(msg);
    } finally {
      acting = false;
      testing = false;
    }
  }

  async function clearCooldown(email: string) {
    try {
      await api.post('/api/admin/emails/cooldown/clear', { email });
      toastSuccess(`Cleared the resend cooldown for ${email}`);
      await fetchOverview(false);
    } catch (e) {
      toastError(errMsg(e));
    }
  }

  async function clearIpLimit(ip: string) {
    try {
      await api.post('/api/admin/emails/ip-limit/clear', { ip });
      toastSuccess(`Cleared the hourly signup limit for ${ip}`);
      await fetchOverview(false);
    } catch (e) {
      toastError(errMsg(e));
    }
  }
</script>

<PageHeader
  title="Emails"
  subtitle="Signup verification delivery — provider, send log and pending queue"
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void fetchOverview(true)}
      disabled={loading}
      class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  {/snippet}
</PageHeader>

{#if overviewError}
  <Card><p class="text-sm text-danger">{overviewError}</p></Card>
{:else if overview}
  <Card>
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold text-heading">Provider</h3>
      <StatusBadge label={providerLabel} tone={providerTone} size="sm" />
    </div>
    <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Provider</dt>
        <dd class="font-mono">{overview.provider.provider || '—'}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">API token</dt>
        <dd class="font-mono">{overview.provider.tokenPresent ? 'present' : 'not set'}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">From</dt>
        <dd class="font-mono">{overview.provider.fromName} &lt;{overview.provider.fromEmail}&gt;</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Public URL</dt>
        <dd class="font-mono">{overview.provider.publicUrl}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Verification</dt>
        <dd class="font-mono">
          {overview.provider.verificationRequired ? 'required' : 'off'} ({overview.provider.verificationSource})
        </dd>
      </div>
    </dl>

    <div class="mt-4 border-t border-border pt-3">
      <div class="flex flex-wrap items-center gap-2">
        <input
          type="email"
          bind:value={testEmail}
          placeholder="you@example.com"
          class="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
        />
        <button
          type="button"
          onclick={confirmTest}
          disabled={testing || !testEmail}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
        >
          {testing ? 'Sending…' : 'Send test'}
        </button>
        <span class="text-xs text-muted">Sends a real message through the provider.</span>
      </div>
      {#if testError}
        <p class="mt-2 text-xs text-danger">{testError}</p>
      {/if}
    </div>
  </Card>

  <div class="mb-4 mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
    <KpiCard label="Sent (24 h)" value={overview.stats.sent24h} {loading} />
    <KpiCard label="Failed (24 h)" value={overview.stats.failed24h} {loading} />
    <KpiCard label="Pending" value={overview.pending.length} {loading} />
    <KpiCard label="Cooldowns" value={overview.cooldowns.length} {loading} />
  </div>

  {#if overview.stats.lastError}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">
      Last failure: {overview.stats.lastError} ({relative(overview.stats.lastFailedAt)})
    </div>
  {/if}

  {#if overview.redisError}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">
      {overview.redisError} — the pending queue and throttle tables below may be incomplete.
    </div>
  {/if}

  <Card>
    <h3 class="mb-3 text-sm font-semibold text-heading">Pending signups ({overview.pending.length})</h3>
    {#if overview.pending.length === 0}
      <EmptyState title="No pending signups" description="Nobody is waiting on a confirmation link." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
              <th class="py-2 pr-4">Username</th>
              <th class="py-2 pr-4">Email</th>
              <th class="py-2 pr-4">Created</th>
              <th class="py-2 pr-4">Expires in</th>
              <th class="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#each overview.pending as p (p.id)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono">{p.username}</td>
                <td class="py-2 pr-4 font-mono text-muted">{p.email}</td>
                <td class="py-2 pr-4 font-mono text-muted">{relative(p.createdAt)}</td>
                <td class="py-2 pr-4 font-mono">{duration(p.ttlSeconds * 1000)}</td>
                <td class="py-2 text-right">
                  <button
                    type="button"
                    onclick={() => confirmResend(p)}
                    class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                  >
                    Resend
                  </button>
                  <button
                    type="button"
                    onclick={() => confirmRevoke(p)}
                    class="ml-2 rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:border-danger"
                  >
                    Revoke
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
      <h3 class="mb-3 text-sm font-semibold text-heading">Send log ({overview.events.length})</h3>
      {#if overview.events.length === 0}
        <EmptyState
          title="No sends recorded"
          description="No verification email has been sent since the log was last trimmed."
        />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                <th class="py-2 pr-4">When</th>
                <th class="py-2 pr-4">Status</th>
                <th class="py-2 pr-4">Kind</th>
                <th class="py-2 pr-4">To</th>
                <th class="py-2 pr-4">User</th>
                <th class="py-2 pr-4">Provider</th>
                <th class="py-2 pr-4">Took</th>
                <th class="py-2 pr-4">Error</th>
              </tr>
            </thead>
            <tbody>
              {#each overview.events as e, i (`${e.atMs}-${i}`)}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono text-muted">{relative(e.atMs)}</td>
                  <td class="py-2 pr-4">
                    <StatusBadge label={e.status} tone={e.status === 'sent' ? 'success' : 'danger'} size="sm" />
                  </td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.kind}</td>
                  <td class="py-2 pr-4 font-mono">{e.toEmail}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.username || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.provider || '—'}</td>
                  <td class="py-2 pr-4 font-mono">{duration(e.durationMs)}</td>
                  <td class="max-w-xs truncate py-2 pr-4 text-xs text-danger" title={e.error}>{e.error}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Card>
  </div>

  <div class="mt-4">
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Throttles</h3>
      <div class="grid gap-6 md:grid-cols-2">
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-muted">
            Resend cooldowns ({overview.cooldowns.length})
          </h4>
          {#if overview.cooldowns.length === 0}
            <p class="text-sm text-muted">No address is on cooldown.</p>
          {:else}
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th class="py-2 pr-4">Email</th>
                  <th class="py-2 pr-4">Expires in</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each overview.cooldowns as c (c.email)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{c.email}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{duration(c.ttlSeconds * 1000)}</td>
                    <td class="py-2 text-right">
                      <button
                        type="button"
                        onclick={() => void clearCooldown(c.email)}
                        class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-muted">
            Signups per IP ({overview.ipCounters.length})
          </h4>
          {#if overview.ipCounters.length === 0}
            <p class="text-sm text-muted">No signup attempts in the current hour.</p>
          {:else}
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th class="py-2 pr-4">IP</th>
                  <th class="py-2 pr-4">Signups this hour</th>
                  <th class="py-2 pr-4">Expires in</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {#each overview.ipCounters as row (row.ip)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{row.ip}</td>
                    <td class="py-2 pr-4 font-mono">{row.count}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{duration(row.ttlSeconds * 1000)}</td>
                    <td class="py-2 text-right">
                      <button
                        type="button"
                        onclick={() => void clearIpLimit(row.ip)}
                        class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40"
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </div>
    </Card>
  </div>
{:else}
  <Card><p class="text-sm text-muted">Loading…</p></Card>
{/if}

<ConfirmDialog
  open={ask !== null}
  title={askTitle}
  message={askMessage}
  confirmLabel={acting ? 'Working…' : ask?.action === 'test' ? 'Send test' : ask?.action === 'resend' ? 'Resend' : 'Revoke'}
  cancelLabel="Cancel"
  tone={ask?.action === 'revoke' ? 'danger' : 'primary'}
  onConfirm={doConfirm}
  onCancel={() => { if (!acting) ask = null; }}
/>
