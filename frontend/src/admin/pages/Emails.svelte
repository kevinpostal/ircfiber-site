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
  import { fibereyeIpHref } from '../lib/ipIntelLink';
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
    /** Rows in the whole retained log, not in `events` (one page of it). */
    eventsTotal: number;
    eventsPage: number;
    eventsPageCount: number;
    eventsLimit: number;
    pending: PendingRow[];
    cooldowns: CooldownRow[];
    ipCounters: IpRow[];
    redisError: string;
    templates?: CampaignTemplate[];
  }

  let overview = $state<Overview | null>(null);
  let overviewError = $state<string | null>(null);
  let loading = $state(false);

  /// Send-log paging. Only the log is paged: every other section of the
  /// payload is a full snapshot, so the KPIs do not move while paging.
  const EVENTS_LIMIT = 50;
  let eventsPage = $state(0);

  let testEmail = $state('');
  let testing = $state(false);
  // A provider rejection is long and matters after the toast is gone.
  let testError = $state<string | null>(null);

  type Ask =
    | { action: 'test'; email: string }
    | { action: 'resend'; row: PendingRow }
    | { action: 'revoke'; row: PendingRow }
    | { action: 'campaign' };
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
      overview = await api.get<Overview>('/api/admin/emails', {
        page: eventsPage,
        limit: EVENTS_LIMIT,
      });
      // The log is a capped list: it can be trimmed below the page being
      // read, and the gateway then answers with the last page it has.
      if (overview.eventsPage !== eventsPage) eventsPage = overview.eventsPage;
    } catch (e) {
      overviewError = errMsg(e);
    } finally { loading = false; }
  }

  async function goToPage(p: number) {
    const last = Math.max(0, (overview?.eventsPageCount ?? 1) - 1);
    const next = Math.min(Math.max(0, p), last);
    if (next === eventsPage) return;
    eventsPage = next;
    await fetchOverview(false);
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
        : ask?.action === 'revoke' ? `Revoke the signup for ${ask.row.username}?`
          : ask?.action === 'campaign' ? 'Send this campaign?' : '');
  const askMessage = $derived(
    ask?.action === 'test'
      ? `A real message is sent to ${ask.email} through the configured provider.`
      : ask?.action === 'resend'
        ? `The same confirmation link is emailed again to ${ask.row.email}. The existing link keeps working.`
        : ask?.action === 'revoke'
          ? `The pending signup for ${ask.row.email} is dropped and its link stops working. The address can sign up again immediately.`
          : ask?.action === 'campaign'
            ? `Send "${subject}" to ${audienceCount} addresses from ${overview?.provider.fromName} <${overview?.provider.fromEmail}>? Every mail carries a List-Unsubscribe link. Sends as text${htmlBody.trim() ? ' + HTML' : ' only'}.`
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
      } else if (current.action === 'campaign') {
        sending = true;
        composeError = null;
        // This POST can run ~2 min at 200 recipients: a long timeout on
        // THIS call only, via the per-call option (no global change).
        const r = await api.post<SendResult>('/api/admin/emails/campaign/send', {
          role: fRole,
          createdAfterMs: dateToMs(fAfter, false),
          createdBeforeMs: dateToMs(fBefore, true),
          q: fQ.trim(),
          all: sendAll,
          subject,
          text: bodyText,
          html: htmlBody,
        }, { timeoutMs: 150_000 });
        sendResult = r;
        previewKey = null;
        toastSuccess(`Campaign sent to ${r.sent} addresses`);
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
      if (current.action === 'campaign') composeError = msg;
      toastError(msg);
    } finally {
      acting = false;
      testing = false;
      sending = false;
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

  let tab = $state<'delivery' | 'compose'>('delivery');

  interface CampaignTemplate { id: string; subject: string; text: string; }
  interface AudienceSample { username: string; email: string; createdAt: number; }
  interface Audience { total: number; sample: AudienceSample[]; }
  interface SendResult {
    sent: number; failed: number; skippedUnsubscribed: number; total: number;
    errors: { email: string; error: string }[];
  }

  let roleCatalog = $state<string[]>([]);
  let rolesLoaded = false;
  let fRole = $state('');
  let fAfter = $state('');
  let fBefore = $state('');
  let fQ = $state('');
  let sendAll = $state(false);
  let audience = $state<Audience | null>(null);
  let previewKey = $state<string | null>(null);
  let previewing = $state(false);
  let previewError = $state<string | null>(null);
  let templateId = $state('blank');
  let subject = $state('');
  let bodyText = $state('');
  // Author-supplied HTML starts blank and is cleared on template pick, so a
  // campaign never ships stale markup from an earlier draft.
  let htmlBody = $state('');
  let editTab = $state<'text' | 'html' | 'split'>('text');
  // Which editor receives variable inserts (last focused, text by default).
  let focusedEditor = $state<'text' | 'html'>('text');
  let textArea = $state<HTMLTextAreaElement | null>(null);
  let htmlArea = $state<HTMLTextAreaElement | null>(null);
  let campaignTestEmail = $state('');
  let campaignTesting = $state(false);
  let sending = $state(false);
  let composeError = $state<string | null>(null);
  let sendResult = $state<SendResult | null>(null);
  const templates = $derived<CampaignTemplate[]>(overview?.templates ?? []);
  const filterKey = $derived(JSON.stringify([fRole, fAfter, fBefore, fQ, sendAll]));
  /// Send stays disabled until a preview ran for the current filter set.
  const previewStale = $derived(previewKey === null || previewKey !== filterKey);
  const audienceCount = $derived(audience?.total ?? 0);

  function dateToMs(day: string, endOfDay: boolean): number {
    if (!day) return 0;
    const ms = Date.parse(day);
    if (Number.isNaN(ms)) return 0;
    return endOfDay ? ms + 86_399_999 : ms;
  }

  async function openCompose() {
    tab = 'compose';
    if (!rolesLoaded) {
      rolesLoaded = true;
      try {
        const data = await api.get<{ roles: { name: string }[] }>('/api/admin/roles');
        roleCatalog = (data.roles ?? []).map((r) => r.name);
      } catch {
        roleCatalog = [];
      }
    }
  }

  async function previewAudience() {
    if (previewing) return;
    previewing = true;
    previewError = null;
    try {
      const params: Record<string, string | number> = { limit: 10 };
      if (fRole) params.role = fRole;
      const afterMs = dateToMs(fAfter, false);
      const beforeMs = dateToMs(fBefore, true);
      if (afterMs > 0) params.createdAfter = afterMs;
      if (beforeMs > 0) params.createdBefore = beforeMs;
      if (fQ.trim()) params.q = fQ.trim();
      audience = await api.get<Audience>('/api/admin/emails/campaign/audience', params);
      previewKey = filterKey;
    } catch (e) {
      previewError = errMsg(e);
    } finally {
      previewing = false;
    }
  }

  // Human labels for the backend-owned template ids (unknown ids fall back
  // to the raw id in the picker).
  const TEMPLATE_LABELS: Record<string, string> = {
    blank: 'Blank',
    'support-reply': 'Support reply',
    announcement: 'Announcement',
    'account-notice': 'Account notice',
  };

  function pickTemplate(id: string) {
    templateId = id;
    const t = templates.find((x) => x.id === id);
    if (t) {
      subject = t.subject;
      bodyText = t.text;
    } else {
      subject = '';
      bodyText = '';
    }
    // Author HTML always starts blank: a picked template must never carry
    // markup drafted for an earlier campaign.
    htmlBody = '';
  }

  /// Live preview: server-side substitution is authoritative; this mirrors
  /// it with the first sample row (or neutral fallbacks) and a stand-in
  /// token, labeled as a preview below.
  function previewSubstitute(src: string): string {
    const first = audience?.sample[0];
    return src
      .replaceAll('{{username}}', first?.username ?? 'subscriber')
      .replaceAll('{{email}}', first?.email ?? 'subscriber@example.com')
      .replaceAll(
        '{{unsubscribe_url}}',
        `${overview?.provider.publicUrl ?? ''}/unsubscribe?token=preview`,
      );
  }
  const previewSubject = $derived(previewSubstitute(subject));
  const previewBody = $derived(previewSubstitute(bodyText));

  function escapeHtml(src: string): string {
    return src.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  /// Text → HTML fallback mirroring the gateway's `campaignHtmlBody`
  /// (escaped paragraphs, `\n\n` → `<p>`, single `\n` → `<br>`).
  function campaignHtmlFallback(src: string): string {
    return previewSubstitute(src)
      .split('\n\n')
      .map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`)
      .join('');
  }

  /// Sandboxed iframe source: author HTML when drafted, else the same
  /// auto-generated fallback the gateway sends. Never `allow-scripts` or
  /// `allow-same-origin`.
  const previewHtml = $derived(
    htmlBody.trim() ? previewSubstitute(htmlBody) : campaignHtmlFallback(bodyText),
  );

  type InsertToken = '{{username}}' | '{{email}}' | '{{unsubscribe_url}}';

  /// Appends a variable at the focused editor's caret (plain `setRangeText`,
  /// no new dep) and drops back to a blank template exactly like typing.
  function insertVar(token: InsertToken) {
    const el = focusedEditor === 'html' ? htmlArea : textArea;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(token, start, end, 'end');
    const caret = start + token.length;
    if (focusedEditor === 'html') htmlBody = el.value;
    else bodyText = el.value;
    templateId = 'blank';
    el.focus();
    el.setSelectionRange(caret, caret);
  }

  async function sendCampaignTest() {
    if (campaignTesting) return;
    campaignTesting = true;
    try {
      await api.post('/api/admin/emails/campaign/test', {
        toEmail: campaignTestEmail.trim(),
        subject,
        text: bodyText,
        html: htmlBody,
      });
      toastSuccess(`Campaign test sent to ${campaignTestEmail.trim()}`);
    } catch (e) {
      toastError(errMsg(e));
    } finally {
      campaignTesting = false;
    }
  }

  function confirmCampaign() {
    if (!audience || previewStale || sending) return;
    ask = { action: 'campaign' };
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

<div class="mb-4 flex gap-1 border-b border-border" role="tablist" aria-label="Emails sections">
  <button
    type="button"
    role="tab"
    aria-selected={tab === 'delivery'}
    onclick={() => { tab = 'delivery'; }}
    class="border-b-2 px-3 py-1.5 text-sm {tab === 'delivery' ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}"
  >
    Delivery
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={tab === 'compose'}
    onclick={() => void openCompose()}
    class="border-b-2 px-3 py-1.5 text-sm {tab === 'compose' ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}"
  >
    Compose
  </button>
</div>

{#if overviewError}
  <Card><p class="text-sm text-danger">{overviewError}</p></Card>
{:else if overview}
  {#if tab === 'delivery'}
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
      <h3 class="mb-3 text-sm font-semibold text-heading">Send log ({overview.eventsTotal})</h3>
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
                <th class="py-2 pr-4">Source IP</th>
                <th class="py-2 pr-4">Error</th>
              </tr>
            </thead>
            <tbody>
              {#each overview.events as e, i (`${e.atMs}-${i}`)}
                {@const srcLink = fibereyeIpHref(e.sourceIp)}
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
                  <td class="py-2 pr-4 font-mono">
                    {#if srcLink}
                      <a href={srcLink} class="text-primary hover:underline">{e.sourceIp}</a>
                    {:else}
                      <span class="text-muted">{e.sourceIp || '—'}</span>
                    {/if}
                  </td>
                  <td class="max-w-xs truncate py-2 pr-4 text-xs text-danger" title={e.error}>{e.error}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if overview.eventsPageCount > 1}
          <div
            class="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted"
            data-testid="send-log-pager"
          >
            <div>
              Showing {overview.eventsPage * overview.eventsLimit + 1}–{overview.eventsPage *
                overview.eventsLimit + overview.events.length} of {overview.eventsTotal}
            </div>
            <div class="flex items-center gap-1">
              <button
                type="button"
                aria-label="First page"
                onclick={() => goToPage(0)}
                disabled={overview.eventsPage === 0}
                class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
              >«</button>
              <button
                type="button"
                aria-label="Previous page"
                onclick={() => goToPage(eventsPage - 1)}
                disabled={overview.eventsPage === 0}
                class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
              >‹</button>
              <span class="px-2">{overview.eventsPage + 1} / {overview.eventsPageCount}</span>
              <button
                type="button"
                aria-label="Next page"
                onclick={() => goToPage(eventsPage + 1)}
                disabled={overview.eventsPage >= overview.eventsPageCount - 1}
                class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
              >›</button>
              <button
                type="button"
                aria-label="Last page"
                onclick={() => goToPage(overview.eventsPageCount - 1)}
                disabled={overview.eventsPage >= overview.eventsPageCount - 1}
                class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40"
              >»</button>
            </div>
          </div>
        {/if}
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
                  {@const counterLink = fibereyeIpHref(row.ip)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">
                      {#if counterLink}
                        <a href={counterLink} class="text-primary hover:underline">{row.ip}</a>
                      {:else}
                        <span>{row.ip}</span>
                      {/if}
                    </td>
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
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Audience</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label for="campaign-role" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Role</label>
          <select
            id="campaign-role"
            bind:value={fRole}
            class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          >
            <option value="">All roles</option>
            {#each roleCatalog as r (r)}
              <option value={r}>{r}</option>
            {/each}
          </select>
        </div>
        <div>
          <label for="campaign-after" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Created after</label>
          <input
            id="campaign-after"
            type="date"
            bind:value={fAfter}
            class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
        </div>
        <div>
          <label for="campaign-before" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Created before</label>
          <input
            id="campaign-before"
            type="date"
            bind:value={fBefore}
            class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
        </div>
        <div>
          <label for="campaign-q" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Search</label>
          <input
            id="campaign-q"
            type="search"
            bind:value={fQ}
            placeholder="username or email"
            class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onclick={() => void previewAudience()}
          disabled={previewing}
          class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
        >
          {previewing ? 'Previewing…' : 'Preview audience'}
        </button>
        <label class="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" bind:checked={sendAll} class="accent-primary" />
          Send to the whole audience
        </label>
      </div>
      {#if previewError}
        <p class="mt-2 text-xs text-danger">{previewError}</p>
      {/if}
      {#if audience}
        <p class="mt-3 text-sm">
          <span class="font-mono font-semibold">{audience.total}</span>
          <span class="text-muted"> {audience.total === 1 ? 'address' : 'addresses'}</span>
          {#if previewStale}
            <span class="ml-2 text-xs text-warn">Filters changed — preview again before sending.</span>
          {/if}
        </p>
        {#if audience.sample.length > 0}
          <div class="mt-2 overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-border text-xs uppercase tracking-wider text-muted">
                  <th class="py-2 pr-4">Username</th>
                  <th class="py-2 pr-4">Email</th>
                </tr>
              </thead>
              <tbody>
                {#each audience.sample as s (s.email)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{s.username}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{s.email}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </Card>

    <div class="mt-4">
      <Card>
        <h3 class="mb-3 text-sm font-semibold text-heading">Message</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label for="campaign-template" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Template</label>
            <select
              id="campaign-template"
              value={templateId}
              onchange={(e) => pickTemplate(e.currentTarget.value)}
              class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
            >
              <option value="blank">{TEMPLATE_LABELS.blank}</option>
              {#each templates as t (t.id)}
                <option value={t.id}>{TEMPLATE_LABELS[t.id] ?? t.id}</option>
              {/each}
            </select>
          </div>
          <div>
            <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">From</span>
            <p class="py-1 font-mono text-sm text-muted">{overview.provider.fromName} &lt;{overview.provider.fromEmail}&gt;</p>
          </div>
        </div>
        <div class="mt-3">
          <label for="campaign-subject" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Subject</label>
          <input
            id="campaign-subject"
            type="text"
            bind:value={subject}
            oninput={() => { templateId = 'blank'; }}
            placeholder="Subject (1–200 characters)"
            class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
        </div>
        <div class="mt-3">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Body</span>
          <div class="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Editor mode">
            <button
              type="button"
              onclick={() => { editTab = 'text'; }}
              aria-pressed={editTab === 'text'}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary"
            >Text</button>
            <button
              type="button"
              onclick={() => { editTab = 'html'; }}
              aria-pressed={editTab === 'html'}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary"
            >HTML</button>
            <button
              type="button"
              onclick={() => { editTab = 'split'; }}
              aria-pressed={editTab === 'split'}
              class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary"
            >Split</button>
            <span class="ml-1 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                title="Insert {'{{username}}'} at caret"
                onclick={() => insertVar('{{username}}')}
                class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40"
              >{'{{username}}'}</button>
              <button
                type="button"
                title="Insert {'{{email}}'} at caret"
                onclick={() => insertVar('{{email}}')}
                class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40"
              >{'{{email}}'}</button>
              <button
                type="button"
                title="Insert {'{{unsubscribe_url}}'} at caret"
                onclick={() => insertVar('{{unsubscribe_url}}')}
                class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40"
              >{'{{unsubscribe_url}}'}</button>
            </span>
          </div>
          <div class="grid gap-3 {editTab === 'split' ? 'sm:grid-cols-2' : ''}">
            {#if editTab !== 'html'}
              <div>
                <label for="campaign-body" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Text</label>
                <textarea
                  id="campaign-body"
                  bind:this={textArea}
                  bind:value={bodyText}
                  oninput={() => { templateId = 'blank'; }}
                  onfocus={() => { focusedEditor = 'text'; }}
                  rows={8}
                  placeholder="Body (1–20000 characters). Variables: {'{{username}}'} {'{{email}}'} {'{{unsubscribe_url}}'}"
                  class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-sm"
                ></textarea>
              </div>
            {/if}
            {#if editTab !== 'text'}
              <div>
                <label for="campaign-html" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">HTML</label>
                <textarea
                  id="campaign-html"
                  bind:this={htmlArea}
                  bind:value={htmlBody}
                  oninput={() => { templateId = 'blank'; }}
                  onfocus={() => { focusedEditor = 'html'; }}
                  rows={12}
                  placeholder="Optional HTML (1–50000 characters). Same variables; sent as-is, no escaping."
                  class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-sm"
                ></textarea>
              </div>
            {/if}
          </div>
        </div>
        {#if subject || bodyText || htmlBody}
          <div class="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2">
            <p class="mb-1 text-xs uppercase tracking-wider text-muted">Preview (first recipient, stand-in unsubscribe link)</p>
            <p class="text-sm font-semibold">{previewSubject || '—'}</p>
            <div class={editTab === 'text' ? 'mt-2 grid gap-3' : 'mt-2 grid gap-3 sm:grid-cols-2'}>
              <div>
                <p class="mb-1 text-xs uppercase tracking-wider text-muted">Text</p>
                <p class="whitespace-pre-wrap text-sm text-muted">{previewBody || '—'}</p>
              </div>
              <div>
                <p class="mb-1 text-xs uppercase tracking-wider text-muted">HTML</p>
                <div class="overflow-hidden rounded-md border border-border bg-white">
                  <iframe title="HTML preview" sandbox="" srcdoc={previewHtml} class="block h-56 w-full bg-white"></iframe>
                </div>
              </div>
            </div>
          </div>
        {/if}
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <label for="campaign-test-email" class="text-xs font-semibold uppercase tracking-wider text-muted">Test send</label>
          <input
            id="campaign-test-email"
            type="email"
            bind:value={campaignTestEmail}
            placeholder="you@example.com"
            class="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"
          />
          <button
            type="button"
            onclick={() => void sendCampaignTest()}
            disabled={campaignTesting || !overview?.provider.configured || !subject.trim() || (!bodyText.trim() && !htmlBody.trim())}
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
          >
            {campaignTesting ? 'Sending…' : 'Send test'}
          </button>
        </div>
        {#if composeError}
          <p class="mt-2 text-xs text-danger">{composeError}</p>
        {/if}
        <div class="mt-3">
          <button
            type="button"
            onclick={confirmCampaign}
            disabled={sending || !audience || previewStale || !subject.trim() || (!bodyText.trim() && !htmlBody.trim())}
            class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send campaign'}
          </button>
        </div>
      </Card>
    </div>

    {#if sendResult}
      <div class="mt-4">
        <Card>
          <h3 class="mb-2 text-sm font-semibold text-heading">Result</h3>
          <p class="text-sm">
            sent {sendResult.sent} · failed {sendResult.failed} · unsubscribed skipped {sendResult.skippedUnsubscribed}
          </p>
          {#if sendResult.errors.length > 0}
            <details class="mt-2">
              <summary class="cursor-pointer text-xs text-muted">{sendResult.errors.length} errors</summary>
              <ul class="mt-1 space-y-1 text-xs">
                {#each sendResult.errors as row (row.email)}
                  <li class="font-mono"><span class="text-danger">{row.email}</span> <span class="text-muted">{row.error}</span></li>
                {/each}
              </ul>
            </details>
          {/if}
        </Card>
      </div>
    {/if}
  {/if}
{:else}
  <Card><p class="text-sm text-muted">Loading…</p></Card>
{/if}

<ConfirmDialog
  open={ask !== null}
  title={askTitle}
  message={askMessage}
  confirmLabel={acting ? 'Working…' : ask?.action === 'test' ? 'Send test' : ask?.action === 'resend' ? 'Resend' : ask?.action === 'campaign' ? 'Send campaign' : 'Revoke'}
  cancelLabel="Cancel"
  tone={ask?.action === 'revoke' ? 'danger' : 'primary'}
  onConfirm={doConfirm}
  onCancel={() => { if (!acting) ask = null; }}
/>
