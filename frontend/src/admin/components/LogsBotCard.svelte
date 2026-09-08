<script lang="ts">
  /**
   * LogsBotCard — the #staff operations-log bot (FiberLogs) as seen from
   * the IRCD page. Reads the heartbeat the bot publishes to Redis through
   * GET /api/admin/logs-bot and queues admin actions (rejoin, reconnect,
   * announce) that the bot picks up from its control list. Polls on its
   * own so it works in both the configured and the "not configured" IRCD
   * branches.
   */
  import { onMount, onDestroy } from 'svelte';
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative } from '../lib/format';

  interface LogsBotHeartbeat {
    nick: string; configuredNick: string; channel: string; host: string; port: number; tls: boolean;
    connected: boolean; registered: boolean; joined: boolean; opered: boolean;
    startedAt: number; connectedSince: number; sessions: number; lastRecvAt: number; lastSendAt: number;
    announced: number; lastAnnouncement: string; lastAnnouncementAt: number;
    connectsSeen: number; connectsIgnored: number;
    geoLookups: number; geoFailures: number; geoConfigured: boolean;
    lastError: string; lastErrorAt: number; hostname: string; pid: number; updatedAt: number;
  }
  interface LogsBotResponse {
    status: LogsBotHeartbeat | null;
    alive: boolean;
    heartbeatAgeMs: number;
    outboxDepth: number;
    controlDepth: number;
    expectedNick: string;
    expectedChannel: string;
    runsInThisProcess: boolean;
  }

  interface Props { intervalMs?: number; }
  let { intervalMs = 15_000 }: Props = $props();

  let data = $state<LogsBotResponse | null>(null);
  let error = $state<string | null>(null);
  let busy = $state<'' | 'rejoin' | 'reconnect' | 'announce'>('');
  let notice = $state('');

  const hb = $derived(data?.status ?? null);
  const nick = $derived(hb?.nick || data?.expectedNick || 'FiberLogs');
  const channel = $derived(hb?.channel || data?.expectedChannel || '#staff');
  const botState = $derived.by(() => {
    if (!data) return { label: 'Loading', tone: 'muted' as const };
    if (!data.alive || !hb) return { label: 'Offline', tone: 'danger' as const };
    // An un-opered bot receives no connect notices at all — that has to be
    // visible, not inferred from a connect counter stuck at zero.
    if (hb.joined && !hb.opered) return { label: `In ${hb.channel}, not opered`, tone: 'warn' as const };
    if (hb.joined) return { label: `In ${hb.channel}`, tone: 'success' as const };
    if (hb.registered) return { label: 'Connected, not in channel', tone: 'warn' as const };
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
      data = await api.get<LogsBotResponse>('/api/admin/logs-bot');
      error = null;
    } catch (e) {
      error = errMsg(e);
    }
  }

  async function control(cmd: 'rejoin' | 'reconnect') {
    if (cmd === 'reconnect' && !confirm(`Reconnect ${nick}? It leaves ${channel} for a few seconds.`)) return;
    busy = cmd;
    try {
      await api.post(`/api/admin/logs-bot/${cmd}`);
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
      await api.post('/api/admin/logs-bot/announce', { text });
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

<Card title="Log bot" subtitle={`${nick} reports signups, outbound email and IRCd connects in ${channel}`}>
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
    </dl>
    <dl class="space-y-1 text-sm">
      <div class="flex justify-between gap-4"><dt class="text-muted">Announced</dt><dd class="font-mono">{hb ? hb.announced : '—'} <span class="text-xs text-muted">this process</span></dd></div>
      <div class="flex justify-between gap-4"><dt class="shrink-0 text-muted">Last line</dt><dd class="min-w-0 truncate text-right text-xs" title={hb?.lastAnnouncement}>{hb?.lastAnnouncement ? `${hb.lastAnnouncement} · ${since(hb.lastAnnouncementAt)}` : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Connects seen</dt><dd class="font-mono">{hb ? hb.connectsSeen : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.connectsIgnored} ignored</span>{/if}</dd></div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Geo lookups</dt>
        <dd class="font-mono">{hb ? hb.geoLookups : '—'}{#if hb}<span class="ml-1 text-xs {hb.geoFailures > 0 ? 'text-warn' : 'text-muted'}">· {hb.geoFailures} failed</span>{/if}{#if hb && !hb.geoConfigured}<span class="ml-1 text-xs text-warn">· geo token missing</span>{/if}</dd>
      </div>
      <div class="flex justify-between gap-4">
        <dt class="text-muted">Outbox</dt>
        <dd class="font-mono {data && data.outboxDepth > 0 ? 'text-warn' : ''}">{data && data.outboxDepth >= 0 ? data.outboxDepth : '—'} <span class="text-xs text-muted">queued</span></dd>
      </div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Pending commands</dt><dd class="font-mono">{data && data.controlDepth >= 0 ? data.controlDepth : '—'}</dd></div>
    </dl>
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
      <input id="logsBotNotice" type="text" bind:value={notice} maxlength="300" placeholder="Announce in {channel} (e.g. maintenance in 10 min)"
        class="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text focus:border-primary focus:outline-none" />
      <button type="submit" disabled={busy !== '' || !notice.trim()}
        class="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:bg-primary/90 disabled:opacity-50">
        Announce
      </button>
    </form>
  </div>
</Card>
