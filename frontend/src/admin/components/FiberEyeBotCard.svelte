<script lang="ts">
  /**
   * FiberEyeBotCard — the connection-watch bot (FiberEye), which is also
   * the #staff announcer. Reads the heartbeat the bot publishes to Redis
   * through GET /api/admin/fibereye and queues reconnect / rejoin commands
   * the bot picks up from its control list; "Announce" pushes a notice
   * onto the #staff outbox. Polls on its own so it stays live even when
   * the page around it is showing a stale table.
   */
  import { onMount, onDestroy } from 'svelte';
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative } from '../lib/format';

  interface FiberEyeRuleSet {
    windowSeconds: number;
    connects: number; connectsEnabled: boolean;
    nicks: number; nicksEnabled: boolean;
    churn: number; churnEnabled: boolean;
    shortMs: number; banSeconds: number;
    ignoreClasses: string[]; exemptIps: string[];
    updatedAtMs: number; updatedBy: string;
  }
  interface FiberEyeHeartbeat {
    nick: string; configuredNick: string; host: string; port: number; tls: boolean;
    channel?: string; joined?: boolean;
    connected: boolean; registered: boolean; opered: boolean;
    startedAt: number; connectedSince: number; sessions: number;
    lastRecvAt: number; lastSendAt: number;
    armed: boolean;
    connectsSeen: number; connectsIgnored: number; quitsSeen: number; sessionsOpen: number;
    bansPlaced: number; bansObserved: number; activeZlines: number;
    accountLookups: number;
    announced: number; lastAnnouncement: string; lastAnnouncementAt: number;
    intelLookups: number; intelFailures: number; intelSources: string[];
    lastError: string; lastErrorAt: number; hostname: string; pid: number; updatedAt: number;
    /// The rules actually in force, which may be an admin override.
    rules: FiberEyeRuleSet;
    /// What the deploy's env asked for; the Reset target.
    rulesDeployed: FiberEyeRuleSet;
    rulesSource: 'override' | 'deployed';
  }
  interface FiberEyeStatus {
    bot: FiberEyeHeartbeat | null;
    alive: boolean;
    heartbeatAgeMs: number;
    runsInThisProcess: boolean;
    expectedNick: string;
    expectedChannel?: string;
    outboxDepth?: number;
    controlDepth?: number;
    armed: boolean;
  }

  interface Props { intervalMs?: number; }
  let { intervalMs = 15_000 }: Props = $props();

  let data = $state<FiberEyeStatus | null>(null);
  let error = $state<string | null>(null);
  let busy = $state<'' | 'reconnect' | 'rejoin' | 'announce'>('');
  let notice = $state('');

  const hb = $derived(data?.bot ?? null);
  const nick = $derived(hb?.nick || data?.expectedNick || 'FiberEye');
  const channel = $derived(hb?.channel || data?.expectedChannel || '#staff');
  const botState = $derived.by(() => {
    if (!data) return { label: 'Loading', tone: 'muted' as const };
    if (!data.alive || !hb) return { label: 'Offline', tone: 'danger' as const };
    // An un-opered FiberEye receives no connect/quit notices and cannot
    // ZLINE — the whole subsystem is inert, and that has to be visible
    // rather than inferred from counters stuck at zero.
    if (hb.registered && !hb.opered) {
      return { label: 'Connected, not opered — no notices, no bans', tone: 'warn' as const };
    }
    if (hb.opered) return { label: 'Watching', tone: 'success' as const };
    if (hb.connected) return { label: 'Registering', tone: 'warn' as const };
    return { label: 'Reconnecting', tone: 'warn' as const };
  });

  let stop: (() => void) | null = null;
  onMount(() => { stop = startPolling(fetchStatus, { intervalMs }); });
  onDestroy(() => stop?.());

  function errMsg(e: unknown): string {
    return e instanceof ApiError ? e.message : (e as Error).message;
  }

  async function fetchStatus() {
    try {
      data = await api.get<FiberEyeStatus>('/api/admin/fibereye');
      error = null;
    } catch (e) {
      error = errMsg(e);
    }
  }

  async function control(cmd: 'rejoin' | 'reconnect') {
    busy = cmd;
    try {
      await api.post(`/api/admin/fibereye/${cmd}`);
      toastSuccess(cmd === 'rejoin' ? `Asked ${nick} to rejoin ${channel}` : `Asked ${nick} to reconnect`);
      setTimeout(() => void fetchStatus(), 6_000);
    } catch (e) {
      toastError(errMsg(e));
    } finally { busy = ''; }
  }

  async function announce(e: Event) {
    e.preventDefault();
    const text = notice.trim();
    if (!text) return;
    busy = 'announce';
    try {
      await api.post('/api/admin/fibereye/announce', { text });
      toastSuccess(`Queued for ${channel}`);
      notice = '';
      setTimeout(() => void fetchStatus(), 3_000);
    } catch (err) {
      toastError(errMsg(err));
    } finally { busy = ''; }
  }

  function since(ms: number | undefined): string {
    return ms && ms > 0 ? relative(ms) : '—';
  }
</script>

<Card title="Connection watch bot" subtitle={`${nick} records every connect and quit, places the Z-lines and announces in ${channel}`}>
  {#snippet actions()}
    <StatusBadge label={botState.label} tone={botState.tone} />
  {/snippet}

  {#if error}
    <p class="mb-3 text-sm text-danger">{error}</p>
  {/if}

  <div class="grid gap-4 md:grid-cols-2">
    <dl class="space-y-1 text-sm">
      <div class="flex justify-between gap-4"><dt class="text-muted">Nick</dt><dd class="font-mono">{nick}{#if hb && hb.nick !== hb.configuredNick}<span class="ml-1 text-xs text-warn">(wanted {hb.configuredNick})</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Server</dt><dd class="font-mono text-xs">{hb ? `${hb.host}:${hb.port}${hb.tls ? ' (TLS)' : ''}` : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Connected</dt><dd class="font-mono text-xs">{hb?.connected ? since(hb.connectedSince) : '—'}{#if hb && hb.sessions > 1}<span class="ml-1 text-muted">· session {hb.sessions}</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Process up</dt><dd class="font-mono text-xs">{since(hb?.startedAt)}{#if hb?.hostname}<span class="ml-1 text-muted">· {hb.hostname}</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Heartbeat</dt><dd class="font-mono text-xs">{data && data.heartbeatAgeMs >= 0 ? `${Math.round(data.heartbeatAgeMs / 1000)}s ago` : 'none'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last disconnect</dt><dd class="text-right text-xs {hb?.lastError ? 'text-warn' : 'text-muted'}">{hb?.lastError ? `${hb.lastError} · ${since(hb.lastErrorAt)}` : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">{channel}</dt><dd class="font-mono text-xs {hb && !hb.joined ? 'text-warn' : ''}">{hb ? (hb.joined ? `In ${channel}` : `Not in ${channel}`) : '—'}</dd></div>
    </dl>
    <dl class="space-y-1 text-sm">
      <div class="flex justify-between gap-4"><dt class="text-muted">Connects seen</dt><dd class="font-mono">{hb ? hb.connectsSeen : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.connectsIgnored} ignored</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Quits seen</dt><dd class="font-mono">{hb ? hb.quitsSeen : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.sessionsOpen} open</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Bans placed</dt><dd class="font-mono">{hb ? hb.bansPlaced : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.bansObserved} observed</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Z-lines on the ircd</dt><dd class="font-mono">{hb ? hb.activeZlines : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Enrichment</dt><dd class="font-mono text-xs">{hb ? `${hb.accountLookups} accounts · ${hb.intelLookups ?? 0} intel` : '—'}{#if hb && (hb.intelFailures ?? 0) > 0}<span class="ml-1 text-warn">· {hb.intelFailures} degraded</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Announced</dt><dd class="font-mono">{hb ? hb.announced ?? 0 : '—'}{#if data && (data.outboxDepth ?? -1) >= 0}<span class="ml-1 text-xs {data.outboxDepth! > 0 ? 'text-warn' : 'text-muted'}">· {data.outboxDepth} queued</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last line</dt><dd class="min-w-0 truncate text-right text-xs" title={hb?.lastAnnouncement}>{hb?.lastAnnouncement ? `${hb.lastAnnouncement} · ${since(hb.lastAnnouncementAt)}` : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Enforcement</dt><dd class="font-mono text-xs">{hb ? (hb.armed ? 'armed' : 'disarmed') : '—'}{#if data?.runsInThisProcess}<span class="ml-1 text-muted">· this process</span>{/if}</dd></div>
    </dl>
  </div>

  <div class="mt-4 border-t border-border pt-3 text-xs text-muted">
    {#if hb}
      <span class="font-mono">
        window {hb.rules.windowSeconds}s ·
        {hb.rules.connectsEnabled ? `${hb.rules.connects} connects` : 'connects off'} ·
        {hb.rules.nicksEnabled ? `${hb.rules.nicks} nicks` : 'nicks off'} ·
        {hb.rules.churnEnabled
          ? `${hb.rules.churn} short sessions under ${Math.round(hb.rules.shortMs / 1000)}s`
          : 'short sessions off'} ·
        first ban {hb.rules.banSeconds}s
        {#if hb.rulesSource === 'override'}<span class="ml-1 text-info">· custom</span>{/if}
      </span>
      {#if hb.rules.ignoreClasses.length > 0}
        <div class="mt-1 font-mono">ignored classes: {hb.rules.ignoreClasses.join(', ')}</div>
      {/if}
      {#if hb.rules.exemptIps.length > 0}
        <div class="mt-1 font-mono">exempt: {hb.rules.exemptIps.join(', ')}</div>
      {/if}
      {#if hb.intelSources?.length}
        <div class="mt-1 font-mono">intel sources: {hb.intelSources.join(', ')}</div>
      {/if}
    {:else}
      Rules are reported by the bot's heartbeat; none has been published yet.
    {/if}
  </div>

  <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
    <button type="button" onclick={() => void control('rejoin')} disabled={busy !== '' || !data?.alive}
      class="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text hover:border-primary/40 disabled:opacity-50">
      Rejoin {channel}
    </button>
    <button type="button" onclick={() => void control('reconnect')} disabled={busy !== '' || !data?.alive}
      class="rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50">
      Reconnect
    </button>
    <form onsubmit={announce} class="ml-auto flex min-w-[280px] flex-1 items-center gap-2">
      <input id="fiberEyeNotice" type="text" bind:value={notice} maxlength="300" placeholder="Announce in {channel} (e.g. maintenance in 10 min)"
        class="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text focus:border-primary focus:outline-none" />
      <button type="submit" disabled={busy !== '' || !notice.trim()}
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        Announce
      </button>
    </form>
  </div>
  <p class="mt-2 text-xs text-muted">Reconnect drops and re-establishes the watch connection; a few seconds of connects go unrecorded and announcements stay queued.</p>
</Card>
