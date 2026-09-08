<script lang="ts">
  /**
   * FiberEyeBotCard — the connection-watch bot (FiberEye) as seen from the
   * FiberEye page. Reads the heartbeat the bot publishes to Redis through
   * GET /api/admin/fibereye and queues a reconnect that the bot picks up
   * from its control list. Polls on its own so it stays live even when the
   * page around it is showing a stale table.
   */
  import { onMount, onDestroy } from 'svelte';
  import Card from './Card.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { api, ApiError } from '../lib/api-client';
  import { toastSuccess, toastError } from '../stores/ui';
  import { startPolling } from '../stores/polling';
  import { relative } from '../lib/format';

  interface FiberEyeThresholds {
    windowSeconds: number; connects: number; nicks: number;
    churn: number; shortMs: number; banSeconds: number;
  }
  interface FiberEyeHeartbeat {
    nick: string; configuredNick: string; host: string; port: number; tls: boolean;
    connected: boolean; registered: boolean; opered: boolean;
    startedAt: number; connectedSince: number; sessions: number;
    lastRecvAt: number; lastSendAt: number;
    armed: boolean;
    connectsSeen: number; connectsIgnored: number; quitsSeen: number; sessionsOpen: number;
    bansPlaced: number; bansObserved: number; activeZlines: number;
    accountLookups: number; geoFilled: number;
    lastError: string; lastErrorAt: number; hostname: string; pid: number; updatedAt: number;
    thresholds: FiberEyeThresholds;
    ignoreClasses: string[];
    exemptIps: string[];
  }
  interface FiberEyeStatus {
    bot: FiberEyeHeartbeat | null;
    alive: boolean;
    heartbeatAgeMs: number;
    runsInThisProcess: boolean;
    expectedNick: string;
    armed: boolean;
  }

  interface Props { intervalMs?: number; }
  let { intervalMs = 15_000 }: Props = $props();

  let data = $state<FiberEyeStatus | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const hb = $derived(data?.bot ?? null);
  const nick = $derived(hb?.nick || data?.expectedNick || 'FiberEye');
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

  async function reconnect() {
    busy = true;
    try {
      await api.post('/api/admin/fibereye/reconnect');
      toastSuccess(`Asked ${nick} to reconnect`);
      setTimeout(() => void fetchStatus(), 6_000);
    } catch (e) {
      toastError(errMsg(e));
    } finally { busy = false; }
  }

  function since(ms: number | undefined): string {
    return ms && ms > 0 ? relative(ms) : '—';
  }
</script>

<Card title="Connection watch bot" subtitle={`${nick} records every connect and quit and places the Z-lines`}>
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
      <div class="flex justify-between gap-4"><dt class="text-muted">Connects seen</dt><dd class="font-mono">{hb ? hb.connectsSeen : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.connectsIgnored} ignored</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Quits seen</dt><dd class="font-mono">{hb ? hb.quitsSeen : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.sessionsOpen} open</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Bans placed</dt><dd class="font-mono">{hb ? hb.bansPlaced : '—'}{#if hb}<span class="ml-1 text-xs text-muted">· {hb.bansObserved} observed</span>{/if}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Z-lines on the ircd</dt><dd class="font-mono">{hb ? hb.activeZlines : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Enrichment</dt><dd class="font-mono text-xs">{hb ? `${hb.accountLookups} accounts · ${hb.geoFilled} geo` : '—'}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Enforcement</dt><dd class="font-mono text-xs">{hb ? (hb.armed ? 'armed' : 'disarmed') : '—'}{#if data?.runsInThisProcess}<span class="ml-1 text-muted">· this process</span>{/if}</dd></div>
    </dl>
  </div>

  <div class="mt-4 border-t border-border pt-3 text-xs text-muted">
    {#if hb}
      <span class="font-mono">
        window {hb.thresholds.windowSeconds}s · {hb.thresholds.connects} connects ·
        {hb.thresholds.nicks} nicks · {hb.thresholds.churn} short sessions under
        {Math.round(hb.thresholds.shortMs / 1000)}s · first ban {hb.thresholds.banSeconds}s
      </span>
      {#if hb.ignoreClasses.length > 0}
        <div class="mt-1 font-mono">ignored classes: {hb.ignoreClasses.join(', ')}</div>
      {/if}
      {#if hb.exemptIps.length > 0}
        <div class="mt-1 font-mono">exempt: {hb.exemptIps.join(', ')}</div>
      {/if}
    {:else}
      Thresholds are reported by the bot's heartbeat; none has been published yet.
    {/if}
  </div>

  <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
    <button type="button" onclick={() => void reconnect()} disabled={busy || !data?.alive}
      class="rounded-md border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 disabled:opacity-50">
      Reconnect
    </button>
    <span class="text-xs text-muted">Drops and re-establishes the watch connection; a few seconds of connects go unrecorded.</span>
  </div>
</Card>
