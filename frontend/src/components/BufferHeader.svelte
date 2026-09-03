<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer, markUserDisconnected, clearUserDisconnected, getTempUnavailable, initiateRejoin, appendMessage } from '../stores/ircStore.svelte';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml } from '../lib/autolinker';
  import { archivedMap } from '../stores/preferences.svelte';
  import { groupServerLog, phaseToLabel } from '../lib/serverLogGroups';
  import { FAIL_TYPES } from '../lib/connectionWarnings';
  import { isFiberServer } from '../lib/fiberServer';
  import LiveElapsed from './LiveElapsed.svelte';

  interface Props {
    onAddNetwork: () => void;
    onEditNetwork: () => void;
    onJoinChannel: (e?: MouseEvent) => void;
    onToggleMembers: () => void;
    onToggleSidebar?: () => void;
    memberPanelOpen: boolean;
  }
  let { onEditNetwork, onJoinChannel, onToggleMembers, onToggleSidebar, memberPanelOpen }: Props = $props();

  const activeNetwork = $derived(getActiveNetwork());
  const activeBufferObj = $derived(getActiveBufferObj());
  const channelName = $derived(
    ircState.activeBuffer.bufferName === '_server'
      ? (activeNetwork?.name || ircState.activeBuffer.bufferName)
      : (activeBufferObj?.name || ircState.activeBuffer.bufferName || '\u2014')
  );
  const topic = $derived(activeBufferObj?.topic || '');
  // IRCCloud shows the counterpart's real name under the "Conversation
  // with <nick>" line in a PM. Query buffers have no member list, so look
  // it up in the engine's network-wide realname cache (WS sync
  // `realnames`, bare-nick keyed); fall back to the nick when unknown.
  const conversationRealname = $derived(
    activeNetwork?.realnames?.[activeBufferObj?.name ?? ''] ?? activeBufferObj?.name ?? ''
  );
  const memberCount = $derived(activeBufferObj?.users?.length ?? 0);
  const isChannel = $derived(ircState.activeBuffer.bufferName?.startsWith('#') ?? false);
  const connected = $derived(activeNetwork?.connected ?? false);
  const isConnecting = $derived(activeNetwork?.connectionState === 'connecting');
  const isFiber = $derived(activeNetwork ? isFiberServer(activeNetwork) : false);
  // Server-log buffer detection — used to scope the fiber-brand restyle
  // (network name uses Space Grotesk, live status pill + kv after it,
  // buttons use fiber hairline borders). Outside the _server view
  // BufferHeader still looks like a normal channel header so the rest of
  // the app is unchanged.
  const isServerBuffer = $derived(ircState.activeBuffer.bufferName === '_server');
  const isJoined = $derived(activeBufferObj?.isJoined === true);
  const isArchived = $derived(!!archivedMap[`${activeNetwork?.networkId}:${activeBufferObj?.name}`]);
  // W7-T01: distinguish "in the process of joining" from "decidedly not joined".
  // joinInFlight is set when switchToBuffer issues a JOIN (URL nav, sidebar
  // click on inactive channel) and is cleared by the JOIN self echo.
  const isJoining = $derived(!!activeBufferObj?.joinInFlight);
  // W7-T01: surface the reason a previous JOIN failed (471/473/474/475/etc.)
  // so the user knows whether to retry, ask for an invite, or move on.
  const joinErrorCode = $derived(activeBufferObj?.joinError ?? null);
  const joinErrorText = $derived.by(() => {
    switch (joinErrorCode) {
      case 'invite-only':  return 'Invite-only channel';
      case 'banned':       return 'You are banned from this channel';
      case 'key-required': return 'Channel key required';
      case 'full':         return 'Channel is full';
      default:             return joinErrorCode ? 'Cannot join channel' : '';
    }
  });

  let busy: boolean = $state(false);

  // W1-T08: 1-second tick for temp_unavailable countdown
  let now: number = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(interval);
  });

  const tempUnavailableEntry = $derived.by(() => {
    if (!activeNetwork || !activeBufferObj) return null;
    return getTempUnavailable(activeNetwork.networkId, activeBufferObj.name) ?? null;
  });

  const tempUnavailableRemaining = $derived.by(() => {
    const entry = tempUnavailableEntry;
    if (!entry) return 0;
    return Math.max(0, Math.floor((entry.expireAt - now) / 1000));
  });

  // ── Server-buffer live pill (mockup: docs/mockups/server-log-irccloud.html)
  // Text is driven by connectionState; the tickers (uptime / elapsed /
  // retry countdown) live in LiveElapsed so only that text node re-renders.
  type PillKind = 'connected' | 'busy' | 'retry' | 'failed' | 'off';
  const pillKind: PillKind = $derived.by(() => {
    if (!activeNetwork) return 'off';
    if (connected) return 'connected';
    const s = activeNetwork.connectionState;
    if (s === 'connecting' || s === 'queued' || s === 'ip_retry') return 'busy';
    if (s === 'waiting_to_retry') return 'retry';
    if (activeNetwork.failInfo) return 'failed';
    return 'off';
  });
  const serverMessages = $derived(
    activeNetwork && isServerBuffer ? (ircState.messages[`${activeNetwork.networkId}:_server`] ?? []) : []
  );
  // Newest engine phase while connecting — the pill's "Connecting · <step>".
  const connectingPhase = $derived.by(() => {
    if (pillKind !== 'busy') return '';
    for (let i = serverMessages.length - 1; i >= 0; i--) {
      const p = serverMessages[i].phase;
      if (p) return phaseToLabel(p);
    }
    return '';
  });
  // Start of the in-flight attempt — the pill's "<elapsed>s elapsed".
  const attemptStartMs = $derived.by(() => {
    if (pillKind !== 'busy') return null;
    const attempts = groupServerLog(serverMessages);
    const last = attempts[attempts.length - 1];
    return last?.start.t ?? null;
  });
  const joinedChannelCount = $derived(
    activeNetwork?.buffers.filter(b => b.type === 'channel' && b.isJoined === true).length ?? 0
  );
  const lastError = $derived(activeNetwork?.failInfo?.reason || activeNetwork?.disconnectReason || '');
  const failLabel = $derived.by(() => {
    const fail = activeNetwork?.failInfo;
    if (!fail) return '';
    if (fail.sslVerifyError || fail.type === FAIL_TYPES.SSL_CERTIFICATE_ERROR) return 'TLS';
    switch (fail.type) {
      case FAIL_TYPES.KILLED:             return 'Killed';
      case FAIL_TYPES.CONNECTION_BLOCKED: return 'Blocked';
      case FAIL_TYPES.CONNECTING_FAILED:  return 'Connect';
      case FAIL_TYPES.SOCKET_CLOSED:      return 'Socket closed';
      default:                            return fail.type;
    }
  });
  const retryAtMs = $derived(activeNetwork?.retryStatus?.nextRetryAtMs ?? 0);
  const attemptCount = $derived(activeNetwork?.retryStatus?.attemptCount ?? 0);

  function formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}h ${mm}m` : mm ? `${mm}m ${ss}s` : `${ss}s`;
  }
  function formatElapsedSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  // LiveElapsed with since=0 hands us the wall clock; count down to retryAtMs.
  function formatRetryCountdown(nowMs: number): string {
    return `${Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000))}s`;
  }

  async function handleConnectionAction(): Promise<void> {
    if (!activeNetwork || busy) return;
    if (isFiber) {
      if (connected || isConnecting) return;
    }
    const net = activeNetwork;
    busy = true;
    try {
      if (connected || isConnecting) {
        markUserDisconnected(net.networkId);
        await disconnectNetwork(net.networkId);
        net.connected = false;
        net.connectionState = 'disconnected';
        net.disconnectReason = 'You disconnected';
        // Push a synthetic DISCONNECT event into the _server buffer so the
        // server log card updates immediately. Goes through `appendMessage`
        // which dedups consecutive DISCONNECT/DISCONNECTED lifecycle events
        // so we don't get duplicates when the engine also emits one.
        appendMessage(net.networkId, '_server', {
          command: 'DISCONNECT',
          nick: '',
          text: 'You disconnected',
          t: Date.now(),
          id: `sys-${Date.now()}`,
          timestamp: new Date().toISOString(),
          params: [],
          prefix: '',
          msgid: '',
          label: '',
        });
      } else {
        // User clicked Reconnect — clear the indefinite disconnect guard
        // so the sync's 'connected' state can update the UI again.
        clearUserDisconnected(net.networkId);

        net.connectionState = 'connecting';
        setActiveBuffer(net.networkId, '_server');

        // Push a synthetic `phase=queued` event into the _server buffer so
        // the new "Connecting to" card appears instantly — without this, the
        // user clicks Connect/Reconnect and sees the page sit empty for the
        // 200-2000ms it takes for the engine to send its first phase event
        // back over the WebSocket. The real `queued` phase event from the
        // engine (with the same canonical text) will dedup against this
        // synthetic one in groupServerLog.dedupPhaseEvents, and any later
        // `resolving`/`connecting`/`tcp_open`/`tls` events merge into the
        // same attempt via START_PHASES grouping. We omit `eid` so the
        // synthetic can't collide with real engine eids and so the collapse
        // key falls through to the unique `id` below — same pattern as the
        // synthetic DISCONNECT above.
        appendMessage(net.networkId, '_server', {
          command: 'NOTICE',
          nick: '',
          phase: 'queued',
          text: `Connecting to ${net.host || 'server'}:${net.port || 6667}...`,
          t: Date.now(),
          id: `opt-${Date.now()}`,
          timestamp: new Date().toISOString(),
          params: [],
          prefix: '',
          msgid: '',
          label: '',
        });

        await reconnectNetwork(net.networkId);
      }
    } catch (e) {
      console.error(e);
    } finally {
      busy = false;
    }
  }

  function rejoin(): void {
    if (!activeNetwork || !activeBufferObj?.name) return;
    // W1-T01: delegate to the canonical rejoin helper. allowReconnect=true
    // preserves the disconnect-then-JOIN behavior: on a disconnected network,
    // the helper kicks reconnectNetwork() so the engine re-establishes the
    // IRC session and flushes the queued JOIN once registration completes.
    initiateRejoin(activeNetwork.networkId, activeBufferObj.name, { allowReconnect: true });
  }

  function archive(): void {
    if (!activeNetwork || !activeBufferObj?.name) return;
    archiveBuffer(activeNetwork.networkId, activeBufferObj.name);
  }

  function unarchive(): void {
    if (!activeNetwork || !activeBufferObj?.name) return;
    delete archivedMap[`${activeNetwork.networkId}:${activeBufferObj.name}`];
  }
</script>

<div class="bufferstatus" class:bufferstatus--fiber={isServerBuffer}>
  <div class="status bufferHead">
    <button class="sidebarToggle" type="button" title="Toggle sidebar" aria-label="Toggle sidebar" onclick={() => onToggleSidebar?.()}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
    <h2 class="bufferHeading{!isJoined ? ' bufferHeadingCollapsed' : ''}">
      {#if ircState.activeBuffer.bufferName && !ircState.activeBuffer.bufferName.startsWith('#') && ircState.activeBuffer.bufferName !== '_server'}
        <span class="bufferlabel label" id="current-channel">Conversation with {channelName}</span>
        <span class="realname" id="conversation-realname">{conversationRealname}</span>
      {:else}
        <span class="bufferlabel label bufferlabel--fiber" id="current-channel">{channelName}</span>
        {#if isServerBuffer && activeNetwork}
          <span class="pill" class:busy={pillKind === 'busy'} class:off={pillKind !== 'connected' && pillKind !== 'busy'}
                data-testid="server-pill" data-state={pillKind} role="status" aria-live="polite">
            <span class="dot" aria-hidden="true"></span>
            <span class="pill-text">
              {#if pillKind === 'connected'}
                Connected{#if activeNetwork.connectedAtMs != null}<span class="sep">{' · '}</span><LiveElapsed since={activeNetwork.connectedAtMs} format={formatUptime} />{/if}
              {:else if pillKind === 'busy'}
                Connecting{#if connectingPhase}<span class="sep">{' · '}</span>{connectingPhase}{/if}
              {:else if pillKind === 'retry'}
                Disconnected{#if retryAtMs > 0}<span class="sep">{' · '}</span>retry in <LiveElapsed since={0} format={formatRetryCountdown} />{/if}
              {:else if pillKind === 'failed'}
                Failed<span class="sep">{' · '}</span>{failLabel}
              {:else}
                Disconnected
              {/if}
            </span>
          </span>
          <span class="kv" data-testid="server-kv">
            {#if pillKind === 'connected'}
              {#if activeNetwork.lagMs != null}lag <b>{activeNetwork.lagMs} ms</b>{' · '}{/if}{#if activeNetwork.egressLabel}egress <b>{activeNetwork.egressLabel}</b>{' · '}{/if}{joinedChannelCount} {joinedChannelCount === 1 ? 'channel' : 'channels'}
            {:else if pillKind === 'busy'}
              {#if attemptStartMs != null}<b><LiveElapsed since={attemptStartMs} format={formatElapsedSeconds} interval={100} /></b>{' elapsed · '}{/if}{activeNetwork.host}:{activeNetwork.port}{#if activeNetwork.egressLabel}{' via '}<b>{activeNetwork.egressLabel}</b>{/if}
            {:else if pillKind === 'retry'}
              {#if lastError}last error <b>{lastError}</b>{/if}
            {:else if pillKind === 'failed'}
              {#if lastError}last error <b>{lastError}</b>{/if}{#if lastError && attemptCount > 0}{' · '}{/if}{#if attemptCount > 0}{attemptCount} {attemptCount === 1 ? 'attempt' : 'attempts'}{/if}
            {/if}
          </span>
        {/if}
      {/if}
      {#if topic}
        <span class="topic" id="channel-topic">{@html autolinkHtml(parseIrcFormatting(topic))}</span>
      {/if}
    </h2>
    {#if tempUnavailableRemaining > 0}
      <div class="temp-unavailable-chip">Server busy — retry in {tempUnavailableRemaining}s</div>
    {/if}
    {#if isChannel && isJoining}
      <div class="join-inflight-chip" role="status" aria-live="polite">
        <span class="join-spinner" aria-hidden="true"></span>
        Joining {channelName}…
      </div>
    {:else if isChannel && joinErrorCode && !isJoined}
      <div class="join-error-chip" role="alert">
        <span class="join-error-text">{joinErrorText}</span>
        <button class="rejoin" type="button" onclick={rejoin}><span>Retry</span></button>
      </div>
    {/if}
    {#if isChannel && (!isJoined || isArchived)}
      <p class="buttons">
        {#if !isJoined}
          <button class="rejoin" onclick={rejoin}><span>Rejoin</span></button>
        {/if}
        {#if isArchived}
          <button class="unarchive" onclick={unarchive}><span>Unarchive</span></button>
        {:else}
          <button class="archive" onclick={archive}><span>Archive</span></button>
        {/if}
        <button class="bufferOptions fa fa-cog" type="button" title="Options" aria-label="Options" aria-expanded="false" aria-controls="channelContextMenu" aria-haspopup="true" onclick={(e) => onJoinChannel(e)}></button>
      </p>
    {:else if isChannel}
      <nav class="bufferControls" aria-label="Channel controls">
        <span class="totalMemberCount memberToggle" id="member-count" role="button" tabindex="0" title="Members list" aria-label="Members list" aria-expanded={memberPanelOpen} onclick={onToggleMembers} onkeydown={(e) => e.key === 'Enter' && onToggleMembers()}><i class="fa fa-list-ul"></i><span>{memberCount}</span></span>
        <button class="bufferOptions fa fa-cog" type="button" title="Options" aria-label="Options" aria-expanded="false" aria-controls="channelContextMenu" aria-haspopup="true" onclick={(e) => onJoinChannel(e)}></button>
      </nav>
    {:else if ircState.activeBuffer.bufferName && !ircState.activeBuffer.bufferName.startsWith('#') && ircState.activeBuffer.bufferName !== '_server'}
      <p class="buttons">
        {#if isArchived}
          <button class="unarchive" onclick={unarchive}><span>Unarchive</span></button>
        {:else}
          <button class="archive" onclick={archive}><span>Archive</span></button>
        {/if}
        <button class="whois" type="button"
                onclick={() => { if (activeNetwork) sendRaw(activeNetwork.networkId, 'WHOIS ' + ircState.activeBuffer.bufferName); }}>
          <span>Whois</span>
        </button>
        <button class="bufferOptions fa fa-cog" type="button" title="Options" aria-label="Options" aria-expanded="false" aria-controls="channelContextMenu" aria-haspopup="true" onclick={(e) => onJoinChannel(e)}></button>
      </p>
    {:else}
      <p class="buttons" class:buttons--fiber={isServerBuffer}>
        <button class="rejoin fiber-btn" type="button" onclick={onEditNetwork}>Edit</button>
        <button class="archive fiber-btn" type="button" onclick={handleConnectionAction} disabled={busy || (isFiber ? (connected || isConnecting) : false)}>
          {connected || isConnecting ? 'Disconnect' : (activeNetwork?.disconnectReason ? 'Reconnect' : 'Connect')}
        </button>
        <button class="bufferOptions fiber-btn" type="button" title="Options" aria-label="Options" onclick={(e) => onJoinChannel(e)}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1A1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.92 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
      </p>
    {/if}
  </div>
</div>

<style>
  /* ── Server-log buffer header — fiber brand restyle ─────────────
     Scoped to the _server view only via .bufferstatus--fiber (applied
     when isServerBuffer is true). Other buffers keep the existing
     GitHub-dark IRCCloud theme. */

  /* Fiber-styled channel name (network name on the server log) — uses
     Space Grotesk + fiber-snow, matching the homepage's brand font. */
  :global(.bufferstatus--fiber) .bufferlabel--fiber {
    display: inline-block;
    margin-right: 8px;
    font-family: var(--font-display, var(--font-sans, sans-serif));
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fiber-snow, #ecf2f8);
    font-size: 15px;
  }

  /* Live status pill + kv — mockup `.pill` / `.kv` on Fiber tokens.
     The pill's dot colour follows state; `.busy` pulses. */
  :global(.bufferstatus--fiber) .pill {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    vertical-align: middle;
    font-family: var(--font-sans, sans-serif);
    font-size: 12px;
    line-height: 16px;
    padding: 1px 8px 1px 6px;
    border-radius: 10px;
    border: 1px solid var(--fiber-line-2, #232c38);
    color: var(--fiber-cloud, #c8d2dd);
    white-space: nowrap;
  }
  :global(.bufferstatus--fiber) .pill .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fiber-signal, #34d399);
    flex-shrink: 0;
  }
  :global(.bufferstatus--fiber) .pill.busy .dot {
    background: var(--fiber-blue, #67e8f9);
    animation: bufferstatus-pulse 1s infinite;
  }
  :global(.bufferstatus--fiber) .pill.off .dot {
    background: var(--fiber-stop, #f87171);
  }
  :global(.bufferstatus--fiber) .pill .sep {
    color: var(--fiber-mist, #4d5867);
  }
  :global(.bufferstatus--fiber) .kv {
    margin-left: 8px;
    font-family: var(--font-sans, sans-serif);
    font-size: 12px;
    color: var(--fiber-mist, #4d5867);
    vertical-align: middle;
    white-space: nowrap;
  }
  :global(.bufferstatus--fiber) .kv b {
    color: var(--fiber-fog, #8b96a4);
    font-weight: 500;
  }
  @keyframes bufferstatus-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  /* Fiber-themed button row — hairline cyan accent borders + cyan hover
     glow, matching the homepage's .topbar-cta / .btn-ghost aesthetic.
     Buttons all share the same 26px min-height + box-sizing so the
     text buttons (Edit / Disconnect) and the 28px-square cog icon are
     vertically aligned regardless of font-size or padding. The `<p>`
     default 1em top/bottom margin is zeroed out so the row sits flush
     with the h2 baseline. */
  :global(.bufferstatus--fiber) .buttons--fiber {
    display: flex;
    gap: 6px;
    align-items: center;
    margin: 0;
    padding: 0;
    line-height: 1;
  }
  :global(.bufferstatus--fiber) .fiber-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-height: 26px;
    padding: 0 12px;
    background: transparent;
    border: 1px solid var(--fiber-line-2, #232c38);
    border-radius: 4px;
    color: var(--fiber-cloud, #c8d2dd);
    font: 500 12px/1 var(--font-sans, sans-serif);
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease,
                box-shadow 120ms ease, background-color 120ms ease;
  }
  :global(.bufferstatus--fiber) .fiber-btn:hover {
    border-color: var(--fiber-blue, #67e8f9);
    color: var(--fiber-blue, #67e8f9);
    box-shadow: 0 0 0 1px var(--fiber-blue-soft, rgba(103, 232, 249, 0.08));
  }
  :global(.bufferstatus--fiber) .fiber-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  :global(.bufferstatus--fiber) .fiber-btn.bufferOptions {
    width: 28px;
    min-height: 28px;
    padding: 0;
    font-size: 13px;
    line-height: 1;
  }
</style>
