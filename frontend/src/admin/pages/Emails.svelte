<script lang="ts">
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
  interface CampaignJob {
    id: string; subject: string; role: string; q: string;
    scheduleAtMs: number; status: string; createdBy: string; createdAtMs: number;
    sent: number; failed: number; skipped: number; total: number;
  }

  let overview = $state<Overview | null>(null);
  let overviewError = $state<string | null>(null);
  let loading = $state(false);
  const EVENTS_LIMIT = 50;
  let eventsPage = $state(0);
  let testEmail = $state('');
  let testing = $state(false);
  let testError = $state<string | null>(null);

  type Ask =
    | { action: 'test'; email: string }
    | { action: 'resend'; row: PendingRow }
    | { action: 'revoke'; row: PendingRow }
    | { action: 'campaignDry' }
    | { action: 'campaignLive' }
    | { action: 'jobPause'; job: CampaignJob }
    | { action: 'jobResume'; job: CampaignJob }
    | { action: 'jobCancel'; job: CampaignJob };
  let ask = $state<Ask | null>(null);
  let acting = $state(false);
  let stop: (() => void) | null = null;

  onMount(() => {
    stop = startPolling(async () => {
      if (tab !== 'compose') {
        await fetchOverview(false);
        await fetchCampaigns();
      }
    }, { intervalMs: 30_000 });
  });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchOverview(spinner: boolean = overview === null) {
    if (spinner) loading = true;
    overviewError = null;
    try {
      overview = await api.get<Overview>('/api/admin/emails', { page: eventsPage, limit: EVENTS_LIMIT });
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

  let tab = $state<'deliver' | 'compose' | 'campaign'>('deliver');
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
  let htmlBody = $state('');
  let editTab = $state<'text' | 'html' | 'split'>('text');
  let focusedEditor = $state<'text' | 'html'>('text');
  let textArea = $state<HTMLTextAreaElement | null>(null);
  let htmlArea = $state<HTMLTextAreaElement | null>(null);
  let toEmail = $state('');
  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let campaignBusy = $state(false);
  let campaignError = $state<string | null>(null);
  let campaignNotice = $state<string | null>(null);
  let dryRunResult = $state<{ total: number; skipped: number } | null>(null);
  let campaigns = $state<CampaignJob[]>([]);
  let campaignsError = $state<string | null>(null);
  let selectedJobId = $state<string | null>(null);
  let jobDetail = $state<SendResult | null>(null);
  let jobDetailLoading = $state(false);
  let wizardStep = $state<1 | 2 | 3 | 4>(1);
  let schedDate = $state('');
  let dryRunChoice = $state<boolean | null>(null);
  const templates = $derived<CampaignTemplate[]>(overview?.templates ?? []);
  const filterKey = $derived(JSON.stringify([fRole, fAfter, fBefore, fQ, sendAll]));
  const previewStale = $derived(previewKey === null || previewKey !== filterKey);
  const audienceCount = $derived(audience?.total ?? 0);
  const dryRun = $derived(dryRunChoice ?? audienceCount > 50);
  let varMenu = $state<{ field: 'text' | 'html' } | null>(null);
  let varMenuIndex = $state(0);
  const VAR_ITEMS = [
    { token: '{{username}}', desc: 'subscriber name' },
    { token: '{{email}}', desc: 'address' },
    { token: '{{unsubscribe_url}}', desc: 'per-recipient unsubscribe link' },
  ] as const;
  type InsertToken = typeof VAR_ITEMS[number]['token'];
  // Drafts persist the message only, never `toEmail`: a stale recipient is a mis-send risk.
  const DRAFT_KEY = 'emails.compose.draft.v1';
  let draftStatus = $state<'Unsaved' | 'Saving…' | 'Saved'>('Unsaved');
  let draftSavedAt = $state('');
  let draftLoaded = $state(false);
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let logQuery = $state('');
  let showFailed = $state(true);
  let showSent = $state(true);
  let expandedKey = $state<string | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  const filteredEvents = $derived((overview?.events ?? []).filter((e) => {
    const isSent = e.status === 'sent';
    if (isSent && !showSent) return false;
    if (!isSent && !showFailed) return false;
    const q = logQuery.trim().toLowerCase();
    if (!q) return true;
    return [e.toEmail, e.sourceIp, e.kind, e.username, e.error]
      .some((v) => (v ?? '').toLowerCase().includes(q));
  }));

  const askTitle = $derived(
    ask?.action === 'test' ? 'Send a test email?'
      : ask?.action === 'resend' ? `Resend the link to ${ask.row.email}?`
        : ask?.action === 'revoke' ? `Revoke the signup for ${ask.row.username}?`
          : ask?.action === 'campaignDry' ? 'Run a dry run?'
            : ask?.action === 'campaignLive' ? 'Send this campaign?'
              : ask?.action === 'jobPause' ? `Pause "${ask.job.subject}"?`
                : ask?.action === 'jobResume' ? `Resume "${ask.job.subject}"?`
                  : ask?.action === 'jobCancel' ? `Cancel "${ask.job.subject}"?` : '');
  const askMessage = $derived(
    ask?.action === 'test' ? `A real message is sent to ${ask.email} through the configured provider.`
      : ask?.action === 'resend' ? `The same confirmation link is emailed again to ${ask.row.email}. The existing link keeps working.`
        : ask?.action === 'revoke' ? `The pending signup for ${ask.row.email} is dropped and its link stops working. The address can sign up again immediately.`
          : ask?.action === 'campaignDry' ? `Validate "${subject}" against ${audienceCount} addresses without sending anything.`
            : ask?.action === 'campaignLive' ? `Send "${subject}" to ${audienceCount} addresses from ${overview?.provider.fromName} <${overview?.provider.fromEmail}>? Every mail carries a List-Unsubscribe link. Sends as text${htmlBody.trim() ? ' + HTML' : ' only'}.`
              : ask?.action === 'jobPause' ? 'Sending stops after the current batch. You can resume it later.'
                : ask?.action === 'jobResume' ? 'Sending continues from where it stopped.'
                  : ask?.action === 'jobCancel' ? 'The campaign stops and cannot be resumed.' : '');
  const askConfirmLabel = $derived(
    acting ? 'Working…'
      : ask?.action === 'test' ? 'Send test'
        : ask?.action === 'resend' ? 'Resend'
          : ask?.action === 'revoke' ? 'Revoke'
            : ask?.action === 'campaignDry' ? 'Run dry run'
              : ask?.action === 'campaignLive' ? (schedDate ? 'Schedule campaign' : 'Send now')
                : ask?.action === 'jobPause' ? 'Pause'
                  : ask?.action === 'jobResume' ? 'Resume'
                    : ask?.action === 'jobCancel' ? 'Cancel' : 'Confirm');

  function campaignPayload(dry: boolean) {
    return {
      role: fRole,
      createdAfterMs: dateToMs(fAfter, false),
      createdBeforeMs: dateToMs(fBefore, true),
      q: fQ.trim(),
      all: sendAll,
      subject,
      text: bodyText,
      html: htmlBody,
      scheduleAtMs: schedDate ? Date.parse(schedDate) : Date.now(),
      dryRun: dry,
    };
  }

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
      } else if (current.action === 'campaignDry') {
        campaignBusy = true;
        campaignError = null;
        const r = await api.post<{ dryRun: boolean; total: number; skippedUnsubscribed: number }>('/api/admin/emails/campaigns', campaignPayload(true));
        dryRunResult = { total: r.total, skipped: r.skippedUnsubscribed };
        toastSuccess(`Dry run: ${r.total} addresses`);
      } else if (current.action === 'campaignLive') {
        campaignBusy = true;
        campaignError = null;
        const r = await api.post<{ id: string; status: string; total: number; scheduleAtMs: number }>('/api/admin/emails/campaigns', campaignPayload(false));
        campaignNotice = `Campaign ${r.status} (${r.total} addresses)`;
        toastSuccess(r.status === 'scheduled' ? 'Campaign scheduled' : 'Campaign sending');
        await fetchCampaigns();
      } else if (current.action === 'jobPause' || current.action === 'jobResume' || current.action === 'jobCancel') {
        const op = current.action === 'jobPause' ? 'pause' : current.action === 'jobResume' ? 'resume' : 'cancel';
        const past = op === 'pause' ? 'paused' : op === 'resume' ? 'resumed' : 'cancelled';
        await api.post<{ id: string; status: string }>(`/api/admin/emails/campaigns/${current.job.id}/${op}`);
        toastSuccess(`Campaign ${past}`);
        await fetchCampaigns();
      } else if (current.action === 'resend') {
        const r = await api.post<{ email: string }>(`/api/admin/emails/pending/${current.row.id}/resend`);
        toastSuccess(`Confirmation link resent to ${r.email}`);
      } else {
        const r = await api.post<{ email: string }>(`/api/admin/emails/pending/${current.row.id}/revoke`);
        toastSuccess(`Revoked the pending signup for ${r.email}`);
      }
      ask = null;
      await fetchOverview(false);
    } catch (e) {
      const msg = errMsg(e);
      if (current.action === 'test') testError = msg;
      if (current.action === 'campaignDry' || current.action === 'campaignLive') campaignError = msg;
      toastError(msg);
    } finally {
      acting = false;
      testing = false;
      campaignBusy = false;
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label} copied`);
    } catch {
      toastError('Could not copy to the clipboard.');
    }
  }

  async function clearCooldown(email: string) {
    try {
      await api.post('/api/admin/emails/cooldown/clear', { email });
      toastSuccess(`Cleared the resend cooldown for ${email}`);
      await fetchOverview(false);
    } catch (e) { toastError(errMsg(e)); }
  }

  async function clearIpLimit(ip: string) {
    try {
      await api.post('/api/admin/emails/ip-limit/clear', { ip });
      toastSuccess(`Cleared the hourly signup limit for ${ip}`);
      await fetchOverview(false);
    } catch (e) { toastError(errMsg(e)); }
  }

  function onChip(which: 'failed' | 'sent') {
    if (showFailed && showSent) {
      if (which === 'failed') showSent = false;
      else showFailed = false;
    } else if (which === 'failed') {
      if (showFailed) { showSent = true; }
      else { showFailed = true; showSent = false; }
    } else {
      if (showSent) { showFailed = true; }
      else { showSent = true; showFailed = false; }
    }
  }

  function clearLogFilters() {
    logQuery = '';
    showFailed = true;
    showSent = true;
  }

  onMount(() => {
    try {
      if (window.matchMedia('(min-width: 1024px)').matches) editTab = 'split';
    } catch { /* keep text default */ }
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as { subject?: string; bodyText?: string; htmlBody?: string; templateId?: string };
        if (!subject && !bodyText && !htmlBody && (d.subject || d.bodyText || d.htmlBody)) {
          subject = d.subject ?? '';
          bodyText = d.bodyText ?? '';
          htmlBody = d.htmlBody ?? '';
          templateId = d.templateId ?? 'blank';
          draftStatus = 'Saved';
        }
      }
    } catch { /* start blank */ }
    draftLoaded = true;
  });

  $effect(() => {
    const snap = { subject, bodyText, htmlBody, templateId };
    if (!draftLoaded) return;
    if (!snap.subject && !snap.bodyText && !snap.htmlBody) return;
    draftStatus = 'Saving…';
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...snap, savedAt: Date.now() }));
        const d = new Date();
        draftSavedAt = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        draftStatus = 'Saved';
      } catch { draftStatus = 'Unsaved'; }
    }, 800);
    return () => { if (draftTimer) clearTimeout(draftTimer); };
  });
  $effect(() => {
    const active = tab === 'campaign' && campaigns.some(
      (j) => j.status === 'scheduled' || j.status === 'sending' || j.status === 'paused');
    if (!active) return;
    const t = setInterval(() => { void fetchCampaigns(); }, 5000);
    return () => clearInterval(t);
  });

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    subject = '';
    bodyText = '';
    htmlBody = '';
    templateId = 'blank';
    draftStatus = 'Unsaved';
    draftSavedAt = '';
  }

  function dateToMs(day: string, endOfDay: boolean): number {
    if (!day) return 0;
    const ms = Date.parse(day);
    if (Number.isNaN(ms)) return 0;
    return endOfDay ? ms + 86_399_999 : ms;
  }

  async function ensureRoles() {
    if (rolesLoaded) return;
    rolesLoaded = true;
    try {
      const data = await api.get<{ roles: { name: string }[] }>('/api/admin/roles');
      roleCatalog = (data.roles ?? []).map((r) => r.name);
    } catch { roleCatalog = []; }
  }

  async function openCompose() { tab = 'compose'; await ensureRoles(); }
  async function openCampaign() { tab = 'campaign'; await ensureRoles(); }

  async function fetchCampaigns() {
    try {
      const r = await api.get<{ campaigns: CampaignJob[] }>('/api/admin/emails/campaigns');
      campaigns = r.campaigns ?? [];
      campaignsError = null;
    } catch (e) { campaignsError = errMsg(e); }
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
    } catch (e) { previewError = errMsg(e); }
    finally { previewing = false; }
  }

  const TEMPLATE_LABELS: Record<string, string> = {
    blank: 'Blank',
    'support-reply': 'Support reply',
    announcement: 'Announcement',
    'account-notice': 'Account notice',
  };

  function pickTemplate(id: string) {
    templateId = id;
    const t = templates.find((x) => x.id === id);
    if (t) { subject = t.subject; bodyText = t.text; }
    else { subject = ''; bodyText = ''; }
    htmlBody = '';
  }
  function previewSubstitute(src: string): string {
    const trimmed = toEmail.trim();
    const at = trimmed.indexOf('@');
    const name = at > 0 ? trimmed.slice(0, at) : 'subscriber';
    const mail = trimmed || 'subscriber@example.com';
    return src
      .replaceAll('{{username}}', name)
      .replaceAll('{{email}}', mail)
      .replaceAll('{{unsubscribe_url}}', `${overview?.provider.publicUrl ?? ''}/unsubscribe?token=preview`);
  }
  const previewSubject = $derived(previewSubstitute(subject));
  const previewBody = $derived(previewSubstitute(bodyText));

  function escapeHtml(src: string): string {
    return src.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function campaignHtmlFallback(src: string): string {
    return previewSubstitute(src).split('\n\n')
      .map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`).join('');
  }

  const previewHtml = $derived(htmlBody.trim() ? previewSubstitute(htmlBody) : campaignHtmlFallback(bodyText));

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
    varMenu = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }

  function handleEditorInput(field: 'text' | 'html', e: Event) {
    templateId = 'blank';
    const el = e.currentTarget as HTMLTextAreaElement;
    const pos = el.selectionStart ?? el.value.length;
    if (pos >= 2 && el.value.slice(pos - 2, pos) === '{{') {
      varMenu = { field };
      varMenuIndex = 0;
    }
  }

  function handleEditorKey(field: 'text' | 'html', e: KeyboardEvent) {
    if (!varMenu || varMenu.field !== field) return;
    if (e.key === 'Escape') varMenu = null;
    else if (e.key === 'Enter') { e.preventDefault(); insertVar(VAR_ITEMS[varMenuIndex].token); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); varMenuIndex = (varMenuIndex + 1) % VAR_ITEMS.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); varMenuIndex = (varMenuIndex + VAR_ITEMS.length - 1) % VAR_ITEMS.length; }
  }

  const sendDisabled = $derived(sending || !overview?.provider.configured || !composeValid || !toEmail.trim());

  async function sendDirect() {
    if (sending || sendDisabled) return;
    sending = true;
    sendError = null;
    try {
      const r = await api.post<{ sent: boolean; email: string }>('/api/admin/emails/send', {
        toEmail: toEmail.trim(),
        subject,
        text: bodyText,
        html: htmlBody,
      });
      toastSuccess(`Email sent to ${r.email}`);
      await fetchOverview(false);
    } catch (e) {
      sendError = errMsg(e);
      toastError(sendError);
    } finally { sending = false; }
  }

  function useInCampaign() { tab = 'campaign'; wizardStep = 2; }
  const step1Valid = $derived(!previewStale && !!audience);
  const step2Valid = $derived(!!subject.trim() && !!(bodyText.trim() || htmlBody.trim()));
  function gotoStep(s: 1 | 2 | 3 | 4) { if (s < wizardStep) wizardStep = s; }
  function wizardNext() {
    if (wizardStep === 1 && step1Valid) wizardStep = 2;
    else if (wizardStep === 2 && step2Valid) wizardStep = 3;
    else if (wizardStep === 3) wizardStep = 4;
  }
  function wizardBack() { if (wizardStep > 1) wizardStep = ((wizardStep - 1) as 1 | 2 | 3); }
  const step4Disabled = $derived(campaignBusy || !audience || previewStale || !step2Valid);
  function confirmCampaignSend() {
    if (step4Disabled) return;
    ask = dryRun ? { action: 'campaignDry' } : { action: 'campaignLive' };
  }
  const jobTone = (status: string): 'success' | 'warn' | 'danger' | 'info' | 'muted' | 'primary' =>
    status === 'done' ? 'success' : status === 'failed' ? 'danger'
      : status === 'paused' ? 'warn' : status === 'cancelled' ? 'muted'
        : status === 'sending' ? 'primary' : 'info';

  async function selectJob(job: CampaignJob) {
    selectedJobId = job.id;
    jobDetail = null;
    jobDetailLoading = true;
    try {
      const r = await api.get<CampaignJob & { errors: { email: string; error: string }[] }>(`/api/admin/emails/campaigns/${job.id}`);
      jobDetail = { sent: r.sent, failed: r.failed, skippedUnsubscribed: r.skipped, total: r.total, errors: r.errors ?? [] };
    } catch (e) { toastError(errMsg(e)); }
    finally { jobDetailLoading = false; }
  }

  function handleKeys(e: KeyboardEvent) {
    if (ask) return;
    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && tab === 'deliver' && !inField) {
      e.preventDefault();
      searchInput?.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && tab === 'compose') {
      if (!sendDisabled) void sendDirect();
    }
  }
</script>

<svelte:window onkeydown={handleKeys} />

<PageHeader title="Emails" subtitle="Transactional delivery, message authoring and bulk campaigns">
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

<div class="mb-1 flex gap-1 border-b border-border" role="tablist" aria-label="Emails sections">
  <button type="button" role="tab" aria-selected={tab === 'deliver'} onclick={() => { tab = 'deliver'; }} class="border-b-2 px-3 py-1.5 text-sm {tab === 'deliver' ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}">Deliver</button>
  <button type="button" role="tab" aria-selected={tab === 'compose'} onclick={() => void openCompose()} class="border-b-2 px-3 py-1.5 text-sm {tab === 'compose' ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}">Compose</button>
  <button type="button" role="tab" aria-selected={tab === 'campaign'} onclick={() => void openCampaign()} class="border-b-2 px-3 py-1.5 text-sm {tab === 'campaign' ? 'border-primary text-text' : 'border-transparent text-muted hover:text-text'}">Campaign</button>
</div>
<p class="mb-4 mt-1 text-xs text-muted">Press / to focus search; Ctrl or Cmd plus Enter sends the email.</p>

{#if overviewError}
  <Card><p class="text-sm text-danger">{overviewError}</p></Card>
{:else if overview}
  {#if tab === 'deliver'}
  <Card>
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-sm font-semibold text-heading">Provider</h3>
      <StatusBadge label={providerLabel} tone={providerTone} size="sm" />
    </div>
    <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      <div class="flex justify-between gap-4"><dt class="text-muted">Provider</dt><dd class="font-mono">{overview.provider.provider || '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">API token</dt><dd class="font-mono">{overview.provider.tokenPresent ? 'present' : 'not set'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">From</dt><dd class="font-mono">{overview.provider.fromName} &lt;{overview.provider.fromEmail}&gt;</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Public URL</dt><dd class="font-mono">{overview.provider.publicUrl}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Verification</dt><dd class="font-mono">{overview.provider.verificationRequired ? 'required' : 'off'} ({overview.provider.verificationSource})</dd></div>
    </dl>
    <details class="mt-4 border-t border-border pt-3">
      <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wider text-muted">Provider test</summary>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <input type="email" bind:value={testEmail} placeholder="you@example.com" class="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        <button type="button" onclick={confirmTest} disabled={testing || !testEmail} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40">{testing ? 'Sending…' : 'Send test'}</button>
        <span class="text-xs text-muted">Sends a real message through the provider.</span>
      </div>
      {#if testError}<p class="mt-2 text-xs text-danger">{testError}</p>{/if}
    </details>
  </Card>

  <div class="mb-4 mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
    <KpiCard label="Sent (24 h)" value={overview.stats.sent24h} {loading} />
    <KpiCard label="Failed (24 h)" value={overview.stats.failed24h} {loading} />
    <KpiCard label="Pending" value={overview.pending.length} {loading} />
  </div>

  {#if overview.stats.lastError}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">Last failure: {overview.stats.lastError} ({relative(overview.stats.lastFailedAt)})</div>
  {/if}
  {#if overview.redisError}
    <div class="mb-4 rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-text" role="alert">{overview.redisError} — the pending queue and throttle tables below may be incomplete.</div>
  {/if}

  <Card>
    <h3 class="mb-3 text-sm font-semibold text-heading">Pending signups ({overview.pending.length})</h3>
    {#if overview.pending.length === 0}
      <EmptyState title="No pending signups" description="Nobody is waiting on a confirmation link." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead><tr class="border-b border-border text-xs uppercase tracking-wider text-muted"><th class="py-2 pr-4">Username</th><th class="py-2 pr-4">Email</th><th class="py-2 pr-4">Created</th><th class="py-2 pr-4">Expires in</th><th class="py-2"></th></tr></thead>
          <tbody>
            {#each overview.pending as p (p.id)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 font-mono">{p.username}</td>
                <td class="py-2 pr-4 font-mono text-muted">{p.email}</td>
                <td class="py-2 pr-4 font-mono text-muted">{relative(p.createdAt)}</td>
                <td class="py-2 pr-4 font-mono">{duration(p.ttlSeconds * 1000)}</td>
                <td class="py-2 text-right">
                  <button type="button" onclick={() => confirmResend(p)} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Resend</button>
                  <button type="button" onclick={() => confirmRevoke(p)} class="ml-2 rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:border-danger">Revoke</button>
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
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <label for="deliver-search" class="text-xs font-semibold uppercase tracking-wider text-muted">Search</label>
        <input id="deliver-search" type="search" bind:this={searchInput} bind:value={logQuery} placeholder="email, IP, kind, user or error" class="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        <button type="button" aria-pressed={showFailed} onclick={() => onChip('failed')} class="rounded-full border px-2.5 py-1 text-xs {showFailed ? 'border-primary text-primary' : 'border-border text-muted hover:text-text'}">Failed</button>
        <button type="button" aria-pressed={showSent} onclick={() => onChip('sent')} class="rounded-full border px-2.5 py-1 text-xs {showSent ? 'border-primary text-primary' : 'border-border text-muted hover:text-text'}">Sent</button>
        <span class="text-xs text-muted">Showing {filteredEvents.length} of {overview.events.length} on this page</span>
      </div>
      {#if overview.events.length === 0}
        <EmptyState title="No sends recorded" description="No verification email has been sent since the log was last trimmed." />
      {:else if filteredEvents.length === 0}
        <EmptyState title="No matching sends" description="No rows on this page match the current search and filters.">
          {#snippet children()}
            <button type="button" onclick={clearLogFilters} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Clear filters</button>
          {/snippet}
        </EmptyState>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead><tr class="border-b border-border text-xs uppercase tracking-wider text-muted"><th class="py-2 pr-4">When</th><th class="py-2 pr-4">Status</th><th class="py-2 pr-4">Kind</th><th class="py-2 pr-4">To</th><th class="py-2 pr-4">User</th><th class="py-2 pr-4">Provider</th><th class="py-2 pr-4">Took</th><th class="py-2 pr-4">Source IP</th><th class="py-2 pr-4">Error</th></tr></thead>
            <tbody>
              {#each filteredEvents as e, i (`${e.atMs}-${i}`)}
                {@const srcLink = fibereyeIpHref(e.sourceIp)}
                {@const key = `${e.atMs}-${i}`}
                <tr class="border-b border-border/50 last:border-0">
                  <td class="py-2 pr-4 font-mono text-muted">{relative(e.atMs)}</td>
                  <td class="py-2 pr-4">
                    <StatusBadge label={e.status} tone={e.status === 'sent' ? 'success' : 'danger'} size="sm" />
                    {#if e.status !== 'sent'}
                      <button type="button" onclick={() => { expandedKey = expandedKey === key ? null : key; }} aria-expanded={expandedKey === key} class="ml-2 rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-xs hover:border-primary/40">{expandedKey === key ? 'Failed ▾' : 'Failed ▸'}</button>
                    {/if}
                  </td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.kind}</td>
                  <td class="py-2 pr-4 font-mono">
                    <span class="group inline-flex items-center gap-1"><span>{e.toEmail}</span><button type="button" aria-label="Copy email" title="Copy email" onclick={() => void copyText(e.toEmail, 'Email')} class="rounded px-1 text-muted opacity-0 hover:text-text group-hover:opacity-100 focus:opacity-100">⧉</button></span>
                  </td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.username || '—'}</td>
                  <td class="py-2 pr-4 font-mono text-muted">{e.provider || '—'}</td>
                  <td class="py-2 pr-4 font-mono">{duration(e.durationMs)}</td>
                  <td class="py-2 pr-4 font-mono">
                    <span class="group inline-flex items-center gap-1">
                      {#if srcLink}<a href={srcLink} class="text-primary hover:underline">{e.sourceIp}</a>{:else}<span class="text-muted">{e.sourceIp || '—'}</span>{/if}
                      {#if e.sourceIp}<button type="button" aria-label="Copy IP" title="Copy IP" onclick={() => void copyText(e.sourceIp, 'IP')} class="rounded px-1 text-muted opacity-0 hover:text-text group-hover:opacity-100 focus:opacity-100">⧉</button>{/if}
                    </span>
                  </td>
                  <td class="max-w-xs truncate py-2 pr-4 text-xs text-danger">{e.error}</td>
                </tr>
                {#if e.status !== 'sent' && expandedKey === key}
                  <tr class="border-b border-border/50">
                    <td colspan={9} class="bg-surface-2/50 px-3 py-2">
                      <div class="flex items-start justify-between gap-2">
                        <pre class="whitespace-pre-wrap font-mono text-xs text-danger">{e.error || '—'}</pre>
                        <button type="button" onclick={() => void copyText(e.error, 'Error')} class="shrink-0 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Copy</button>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if overview.eventsPageCount > 1}
          <div class="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs text-muted" data-testid="send-log-pager">
            <div>Showing {overview.eventsPage * overview.eventsLimit + 1}–{overview.eventsPage * overview.eventsLimit + overview.events.length} of {overview.eventsTotal}</div>
            <div class="flex items-center gap-1">
              <button type="button" aria-label="First page" onclick={() => goToPage(0)} disabled={overview.eventsPage === 0} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">«</button>
              <button type="button" aria-label="Previous page" onclick={() => goToPage(eventsPage - 1)} disabled={overview.eventsPage === 0} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">‹</button>
              <span class="px-2">{overview.eventsPage + 1} / {overview.eventsPageCount}</span>
              <button type="button" aria-label="Next page" onclick={() => goToPage(eventsPage + 1)} disabled={overview.eventsPage >= overview.eventsPageCount - 1} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">›</button>
              <button type="button" aria-label="Last page" onclick={() => goToPage(overview.eventsPageCount - 1)} disabled={overview.eventsPage >= overview.eventsPageCount - 1} class="rounded border border-border bg-surface px-2 py-1 hover:bg-surface-2 disabled:opacity-40">»</button>
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
          <h4 class="mb-2 text-xs uppercase tracking-wider text-muted">Resend cooldowns ({overview.cooldowns.length})</h4>
          {#if overview.cooldowns.length === 0}
            <p class="text-sm text-muted">No address is on cooldown.</p>
          {:else}
            <table class="w-full text-left text-sm">
              <thead><tr class="border-b border-border text-xs uppercase tracking-wider text-muted"><th class="py-2 pr-4">Email</th><th class="py-2 pr-4">Expires in</th><th class="py-2"></th></tr></thead>
              <tbody>
                {#each overview.cooldowns as c (c.email)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{c.email}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{duration(c.ttlSeconds * 1000)}</td>
                    <td class="py-2 text-right"><button type="button" onclick={() => void clearCooldown(c.email)} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Clear</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
        <div>
          <h4 class="mb-2 text-xs uppercase tracking-wider text-muted">Signups per IP ({overview.ipCounters.length})</h4>
          {#if overview.ipCounters.length === 0}
            <p class="text-sm text-muted">No signup attempts in the current hour.</p>
          {:else}
            <table class="w-full text-left text-sm">
              <thead><tr class="border-b border-border text-xs uppercase tracking-wider text-muted"><th class="py-2 pr-4">IP</th><th class="py-2 pr-4">Signups this hour</th><th class="py-2 pr-4">Expires in</th><th class="py-2"></th></tr></thead>
              <tbody>
                {#each overview.ipCounters as row (row.ip)}
                  {@const counterLink = fibereyeIpHref(row.ip)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2 pr-4 font-mono">{#if counterLink}<a href={counterLink} class="text-primary hover:underline">{row.ip}</a>{:else}<span>{row.ip}</span>{/if}</td>
                    <td class="py-2 pr-4 font-mono">{row.count}</td>
                    <td class="py-2 pr-4 font-mono text-muted">{duration(row.ttlSeconds * 1000)}</td>
                    <td class="py-2 text-right"><button type="button" onclick={() => void clearIpLimit(row.ip)} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Clear</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </div>
    </Card>
  </div>
  {:else if tab === 'compose'}
  <div class="grid gap-4 lg:grid-cols-2">
    <Card>
      <div class="mb-3 flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-heading">Message</h3>
        <div class="flex items-center gap-2">
          <span class="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{draftStatus === 'Saved' && draftSavedAt ? `Saved ${draftSavedAt}` : draftStatus}</span>
          <button type="button" onclick={clearDraft} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Clear</button>
        </div>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label for="campaign-template" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Template</label>
          <select id="campaign-template" value={templateId} onchange={(e) => pickTemplate(e.currentTarget.value)} class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm">
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
        <label for="compose-to" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">To</label>
        <input id="compose-to" type="email" bind:value={toEmail} placeholder="name@example.com" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
      </div>
      <div class="mt-3">
        <label for="campaign-subject" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Subject</label>
        <input id="campaign-subject" type="text" bind:value={subject} oninput={() => { templateId = 'blank'; }} placeholder="Subject (1–200 characters)" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
      </div>
      <div class="mt-3">
        <span class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Body</span>
        <div class="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Editor mode">
          <button type="button" onclick={() => { editTab = 'text'; }} aria-pressed={editTab === 'text'} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary">Text</button>
          <button type="button" onclick={() => { editTab = 'html'; }} aria-pressed={editTab === 'html'} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary">HTML</button>
          <button type="button" onclick={() => { editTab = 'split'; }} aria-pressed={editTab === 'split'} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 aria-pressed:border-primary aria-pressed:text-primary">Split</button>
          <span class="ml-1 flex flex-wrap items-center gap-1.5">
            <button type="button" title="Insert username at caret" onclick={() => insertVar('{{username}}')} class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40">{'{{username}}'}</button>
            <button type="button" title="Insert email at caret" onclick={() => insertVar('{{email}}')} class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40">{'{{email}}'}</button>
            <button type="button" title="Insert unsubscribe url at caret" onclick={() => insertVar('{{unsubscribe_url}}')} class="rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs hover:border-primary/40">{'{{unsubscribe_url}}'}</button>
          </span>
        </div>
        <div class="grid gap-3 {editTab === 'split' ? 'sm:grid-cols-2' : ''}">
          {#if editTab !== 'html'}
            <div class="relative">
              <label for="campaign-body" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Text</label>
              <textarea id="campaign-body" bind:this={textArea} bind:value={bodyText} oninput={(e) => handleEditorInput('text', e)} onkeydown={(e) => handleEditorKey('text', e)} onfocus={() => { focusedEditor = 'text'; }} rows={8} placeholder="Body (1–20000 characters). Variables: username, email, unsubscribe url" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-sm"></textarea>
              {#if varMenu?.field === 'text'}
                <div class="absolute z-10 mt-1 w-72 rounded-md border border-border bg-surface shadow-lg" role="listbox" aria-label="Insert variable">
                  {#each VAR_ITEMS as item, idx (item.token)}
                    <button type="button" role="option" aria-selected={idx === varMenuIndex} onmouseenter={() => { varMenuIndex = idx; }} onclick={() => insertVar(item.token)} class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2 {idx === varMenuIndex ? 'bg-surface-2' : ''}"><span class="font-mono">{item.token}</span><span class="text-muted">{item.desc}</span></button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          {#if editTab !== 'text'}
            <div class="relative">
              <label for="campaign-html" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">HTML</label>
              <textarea id="campaign-html" bind:this={htmlArea} bind:value={htmlBody} oninput={(e) => handleEditorInput('html', e)} onkeydown={(e) => handleEditorKey('html', e)} onfocus={() => { focusedEditor = 'html'; }} rows={12} placeholder="Optional HTML (1–50000 characters). Same variables; sent as-is, no escaping." class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 font-mono text-sm"></textarea>
              {#if varMenu?.field === 'html'}
                <div class="absolute z-10 mt-1 w-72 rounded-md border border-border bg-surface shadow-lg" role="listbox" aria-label="Insert variable">
                  {#each VAR_ITEMS as item, idx (item.token)}
                    <button type="button" role="option" aria-selected={idx === varMenuIndex} onmouseenter={() => { varMenuIndex = idx; }} onclick={() => insertVar(item.token)} class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2 {idx === varMenuIndex ? 'bg-surface-2' : ''}"><span class="font-mono">{item.token}</span><span class="text-muted">{item.desc}</span></button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
      <div class="mt-3">
        <button type="button" onclick={useInCampaign} disabled={!composeValid} class="rounded-md border border-primary/40 bg-surface-2 px-2.5 py-1 text-xs hover:border-primary disabled:opacity-40">Use in campaign →</button>
      </div>
    </Card>

    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Preview</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label for="mock-name" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Mock name</label>
          <input id="mock-name" type="text" bind:value={mockName} oninput={() => { mockTouched = true; }} placeholder="subscriber" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        </div>
        <div>
          <label for="mock-email" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Mock email</label>
          <input id="mock-email" type="email" bind:value={mockEmail} oninput={() => { mockTouched = true; }} placeholder="subscriber@example.com" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        </div>
      </div>
      {#if subject || bodyText || htmlBody}
        <div class="mt-3 rounded-md border border-border bg-surface-2 px-3 py-2">
          <p class="mb-1 text-xs uppercase tracking-wider text-muted">Preview (mock user, stand-in unsubscribe link)</p>
          <p class="text-sm font-semibold">{previewSubject || '—'}</p>
          <div class="mt-2 grid gap-3">
            <div><p class="mb-1 text-xs uppercase tracking-wider text-muted">Text</p><p class="whitespace-pre-wrap text-sm text-muted">{previewBody || '—'}</p></div>
            <div><p class="mb-1 text-xs uppercase tracking-wider text-muted">HTML</p><div class="overflow-hidden rounded-md border border-border bg-white"><iframe title="HTML preview" sandbox="" srcdoc={previewHtml} class="block h-56 w-full bg-white"></iframe></div></div>
          </div>
        </div>
      {/if}
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <label for="campaign-test-email" class="text-xs font-semibold uppercase tracking-wider text-muted">Test send</label>
        <input id="campaign-test-email" type="email" bind:value={campaignTestEmail} placeholder="you@example.com" class="w-64 rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        <button type="button" onclick={() => void sendCampaignTest()} disabled={testSendDisabled} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40">{campaignTesting ? 'Sending…' : 'Send test'}</button>
      </div>
      {#if !testEmailEffective}<p class="mt-2 text-xs text-warn">Enter a test address.</p>{/if}
    </Card>
  </div>
  {:else}
  <Card>
    <div class="mb-4 flex flex-wrap items-center gap-1" role="group" aria-label="Campaign steps">
      {#each [{ n: 1, label: 'Audience' }, { n: 2, label: 'Design' }, { n: 3, label: 'Schedule' }, { n: 4, label: 'Review' }] as s (s.n)}
        <button type="button" onclick={() => gotoStep(s.n as 1 | 2 | 3 | 4)} disabled={s.n > wizardStep} aria-current={wizardStep === s.n ? 'step' : undefined} class="rounded-md border px-2.5 py-1 text-xs {wizardStep === s.n ? 'border-primary text-text' : 'border-border text-muted hover:text-text disabled:opacity-40'}">{s.n}. {s.label}</button>
        {#if s.n < 4}<span class="text-muted">→</span>{/if}
      {/each}
    </div>

    {#if wizardStep === 1}
      <h3 class="mb-3 text-sm font-semibold text-heading">Audience</h3>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label for="campaign-role" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Role</label>
          <select id="campaign-role" bind:value={fRole} class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm"><option value="">All roles</option>{#each roleCatalog as r (r)}<option value={r}>{r}</option>{/each}</select>
        </div>
        <div>
          <label for="campaign-after" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Created after</label>
          <input id="campaign-after" type="date" bind:value={fAfter} class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        </div>
        <div>
          <label for="campaign-before" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Created before</label>
          <input id="campaign-before" type="date" bind:value={fBefore} class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        </div>
        <div>
          <label for="campaign-q" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Search</label>
          <input id="campaign-q" type="search" bind:value={fQ} placeholder="username or email" class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onclick={() => void previewAudience()} disabled={previewing} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40">{previewing ? 'Previewing…' : 'Preview audience'}</button>
        <label class="flex items-center gap-2 text-xs text-muted"><input type="checkbox" bind:checked={sendAll} class="accent-primary" />Send to the whole audience</label>
      </div>
      {#if previewError}<p class="mt-2 text-xs text-danger">{previewError}</p>{/if}
      {#if audience}
        <p class="mt-3 text-sm"><span class="font-mono font-semibold">{audience.total}</span><span class="text-muted"> {audience.total === 1 ? 'address' : 'addresses'}</span>{#if previewStale}<span class="ml-2 text-xs text-warn">Filters changed — preview again before sending.</span>{/if}</p>
        {#if audience.sample.length > 0}
          <div class="mt-2 overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead><tr class="border-b border-border text-xs uppercase tracking-wider text-muted"><th class="py-2 pr-4">Username</th><th class="py-2 pr-4">Email</th></tr></thead>
              <tbody>{#each audience.sample as s (s.email)}<tr class="border-b border-border/50 last:border-0"><td class="py-2 pr-4 font-mono">{s.username}</td><td class="py-2 pr-4 font-mono text-muted">{s.email}</td></tr>{/each}</tbody>
            </table>
          </div>
        {/if}
      {/if}
      <div class="mt-4 flex justify-end"><button type="button" onclick={wizardNext} disabled={!step1Valid} class="rounded-md border border-primary/40 bg-surface-2 px-2.5 py-1 text-xs hover:border-primary disabled:opacity-40">Next →</button></div>
    {:else if wizardStep === 2}
      <h3 class="mb-3 text-sm font-semibold text-heading">Design</h3>
      {#if step2Valid}
        <dl class="grid gap-x-6 gap-y-2 text-sm">
          <div class="flex justify-between gap-4"><dt class="text-muted">Subject</dt><dd class="font-mono">{subject}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">Text</dt><dd class="max-w-md truncate font-mono text-muted">{bodyText || '—'}</dd></div>
          <div class="flex justify-between gap-4"><dt class="text-muted">HTML</dt><dd class="max-w-md truncate font-mono text-muted">{htmlBody ? `${htmlBody.slice(0, 200)}${htmlBody.length > 200 ? '…' : ''}` : 'auto-generated from text'}</dd></div>
        </dl>
      {:else}
        <p class="text-sm text-muted">No message yet — author one in Compose first.</p>
      {/if}
      <div class="mt-3 flex flex-wrap items-center gap-2"><button type="button" onclick={() => { tab = 'compose'; }} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Edit in compose →</button></div>
      <div class="mt-4 flex justify-between">
        <button type="button" onclick={wizardBack} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">← Back</button>
        <button type="button" onclick={wizardNext} disabled={!step2Valid} class="rounded-md border border-primary/40 bg-surface-2 px-2.5 py-1 text-xs hover:border-primary disabled:opacity-40">Next →</button>
      </div>
    {:else if wizardStep === 3}
      <h3 class="mb-3 text-sm font-semibold text-heading">Schedule</h3>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label for="campaign-schedule" class="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Schedule</label>
          <input id="campaign-schedule" type="datetime-local" bind:value={schedDate} class="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1 text-sm" />
          <p class="mt-1 text-xs text-muted">Empty means send now.</p>
        </div>
        <div class="flex items-end pb-1">
          <label class="flex items-center gap-2 text-sm"><input id="campaign-dryrun" type="checkbox" checked={dryRun} onchange={(e) => { dryRunChoice = e.currentTarget.checked; }} class="accent-primary" />Dry run (validate only, send nothing)</label>
        </div>
      </div>
      <div class="mt-4 flex justify-between">
        <button type="button" onclick={wizardBack} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">← Back</button>
        <button type="button" onclick={wizardNext} class="rounded-md border border-primary/40 bg-surface-2 px-2.5 py-1 text-xs hover:border-primary disabled:opacity-40">Next →</button>
      </div>
    {:else}
      <h3 class="mb-3 text-sm font-semibold text-heading">Review</h3>
      <dl class="grid gap-x-6 gap-y-2 text-sm">
        <div class="flex justify-between gap-4"><dt class="text-muted">Audience</dt><dd class="font-mono">{audienceCount} {audienceCount === 1 ? 'address' : 'addresses'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Subject</dt><dd class="font-mono">{subject || '—'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Schedule</dt><dd class="font-mono text-muted">{schedDate ? schedDate : 'Send now'}</dd></div>
        <div class="flex justify-between gap-4"><dt class="text-muted">Mode</dt><dd class="font-mono text-muted">{dryRun ? 'Dry run (no mail is sent)' : 'Live send'}</dd></div>
      </dl>
      {#if previewStale}<p class="mt-2 text-xs text-warn">Filters changed — preview again before sending.</p>{/if}
      {#if campaignError}<p class="mt-2 text-xs text-danger">{campaignError}</p>{/if}
      {#if dryRunResult}<p class="mt-2 text-sm">Dry run: <span class="font-mono font-semibold">{dryRunResult.total}</span> addresses · {dryRunResult.skipped} unsubscribed skipped</p>{/if}
      {#if campaignNotice}<p class="mt-2 text-sm text-muted">{campaignNotice}</p>{/if}
      <div class="mt-4 flex justify-between">
        <button type="button" onclick={wizardBack} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">← Back</button>
        <button type="button" onclick={confirmCampaignSend} disabled={step4Disabled} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-40">{campaignBusy ? 'Working…' : dryRun ? 'Run dry run' : schedDate ? 'Schedule campaign' : 'Send now'}</button>
      </div>
    {/if}
  </Card>

  <div class="mt-4">
    <Card>
      <h3 class="mb-3 text-sm font-semibold text-heading">Campaigns ({campaigns.length})</h3>
      {#if campaignsError}
        <p class="text-xs text-danger">{campaignsError}</p>
      {:else if campaigns.length === 0}
        <EmptyState title="No campaigns" description="Scheduled and sent campaigns appear here with live progress." />
      {:else}
        <ul class="space-y-3">
          {#each campaigns as job (job.id)}
            {@const done = job.sent + job.failed}
            <li class="rounded-md border border-border px-3 py-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onclick={() => void selectJob(job)} class="text-left text-sm font-semibold hover:text-primary" aria-label={`View ${job.subject}`}>{job.subject}</button>
                <StatusBadge label={job.status} tone={jobTone(job.status)} size="sm" />
              </div>
              <div role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={job.total} aria-label={`Progress for ${job.subject}`} class="mt-2 flex h-2 w-full overflow-hidden rounded bg-border">
                <div class="bg-primary" style="width: {job.total > 0 ? (job.sent / job.total) * 100 : 0}%"></div>
                {#if job.failed > 0}<div class="bg-danger" style="width: {job.total > 0 ? (job.failed / job.total) * 100 : 0}%"></div>{/if}
              </div>
              <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p class="text-xs text-muted">{job.sent} / {job.total} sent · {job.failed} failed · {job.skipped} skipped</p>
                <div class="flex items-center gap-1">
                  {#if job.status === 'scheduled' || job.status === 'sending'}<button type="button" onclick={() => { ask = { action: 'jobPause', job }; }} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Pause</button>{/if}
                  {#if job.status === 'paused'}<button type="button" onclick={() => { ask = { action: 'jobResume', job }; }} class="rounded-md border border-border bg-surface-2 px-2.5 py-1 text-xs hover:border-primary/40">Resume</button>{/if}
                  {#if job.status === 'scheduled' || job.status === 'sending' || job.status === 'paused'}<button type="button" onclick={() => { ask = { action: 'jobCancel', job }; }} class="rounded-md border border-danger/40 bg-surface-2 px-2.5 py-1 text-xs text-danger hover:border-danger">Cancel</button>{/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>

  {#if selectedJobId && (jobDetail || jobDetailLoading)}
    <div class="mt-4">
      <Card>
        <h3 class="mb-2 text-sm font-semibold text-heading">Result</h3>
        {#if jobDetailLoading}
          <p class="text-sm text-muted">Loading…</p>
        {:else if jobDetail}
          <p class="text-sm">sent {jobDetail.sent} · failed {jobDetail.failed} · unsubscribed skipped {jobDetail.skippedUnsubscribed}</p>
          {#if jobDetail.errors.length > 0}
            <details class="mt-2"><summary class="cursor-pointer text-xs text-muted">{jobDetail.errors.length} errors</summary>
              <ul class="mt-1 space-y-1 text-xs">{#each jobDetail.errors as row (row.email)}<li class="font-mono"><span class="text-danger">{row.email}</span> <span class="text-muted">{row.error}</span></li>{/each}</ul>
            </details>
          {/if}
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
  confirmLabel={askConfirmLabel}
  cancelLabel="Cancel"
  tone={ask?.action === 'revoke' || ask?.action === 'jobCancel' ? 'danger' : ask?.action === 'jobPause' ? 'warn' : 'primary'}
  requireText={ask?.action === 'campaignLive' ? subject : undefined}
  onConfirm={doConfirm}
  onCancel={() => { if (!acting) ask = null; }}
/>
