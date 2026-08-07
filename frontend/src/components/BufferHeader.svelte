<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer, markUserDisconnected, clearUserDisconnected, getTempUnavailable, initiateRejoin, appendMessage } from '../stores/ircStore.svelte';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml } from '../lib/autolinker';
  import { normalizeChannelName } from '../lib/utils';
  import { archivedMap, serverlogCollapsedMap } from '../stores/preferences.svelte';
  import { groupServerLog, getServerLogCollapsedKey } from '../lib/serverLogGroups';

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
  // Server-log buffer detection — used to scope the fiber-brand restyle
  // (channel-name uses Space Grotesk, status pill mirrors the homepage's
  // topbar LED, buttons use fiber hairline borders). Outside the _server
  // view BufferHeader still looks like a normal channel header so the
  // rest of the app is unchanged.
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

  async function handleConnectionAction(): Promise<void> {
    if (!activeNetwork || busy) return;
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

        // Collapse all existing server-log cards so only the new
        // connection attempt (which will get a fresh eid) stays expanded.
        const serverMessages = ircState.messages[`${net.networkId}:_server`] ?? [];
        for (const attempt of groupServerLog(serverMessages)) {
          const key = getServerLogCollapsedKey(attempt, net.networkId);
          if (key) serverlogCollapsedMap[key] = true;
        }

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
    <h2 class="bufferHeading{!isJoined ? ' bufferHeadingCollapsed' : ''}">
      {#if ircState.activeBuffer.bufferName && !ircState.activeBuffer.bufferName.startsWith('#') && ircState.activeBuffer.bufferName !== '_server'}
        <span class="bufferlabel label" id="current-channel">Conversation with {channelName}</span>
        <span class="realname" id="conversation-realname">{conversationRealname}</span>
      {:else}
        <span class="bufferlabel label bufferlabel--fiber" id="current-channel">
          {#if isServerBuffer}
            <span class="status-led"
                  class:status-led--connected={connected}
                  class:status-led--connecting={isConnecting}
                  class:status-led--disconnected={!connected && !isConnecting}
                  aria-hidden="true"></span>
          {/if}
          {channelName}
        </span>
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
        <button class="archive fiber-btn" type="button" onclick={handleConnectionAction} disabled={busy}>
          {connected || isConnecting ? 'Disconnect' : (activeNetwork?.disconnectReason ? 'Reconnect' : 'Connect')}
        </button>
        <button class="bufferOptions fiber-btn" type="button" title="Options" aria-label="Options" onclick={(e) => onJoinChannel(e)}><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1A1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.92 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></button>
      </p>
    {/if}
    <button class="sidebarToggle" type="button" title="Channel list" aria-label="Toggle channel list" onclick={() => onToggleSidebar?.()}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
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
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display, var(--font-sans, sans-serif));
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fiber-snow, #ecf2f8);
    font-size: 15px;
  }

  /* Connection status LED — mirrors the homepage's .status-pill .led.
     Color follows status; pending state pulses with a cyan glow. */
  :global(.bufferstatus--fiber) .status-led {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fiber-mist, #4d5867);
    box-shadow: none;
    flex-shrink: 0;
    transition: background-color 200ms ease, box-shadow 200ms ease;
  }
  :global(.bufferstatus--fiber) .status-led--connected {
    background: var(--fiber-signal, #34d399);
    box-shadow: 0 0 8px rgba(52, 211, 153, 0.45);
  }
  :global(.bufferstatus--fiber) .status-led--connecting {
    background: var(--fiber-blue, #67e8f9);
    box-shadow: 0 0 8px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
    animation: bufferstatus-led-pulse 2.4s ease-in-out infinite;
  }
  :global(.bufferstatus--fiber) .status-led--disconnected {
    background: var(--fiber-mist, #4d5867);
    box-shadow: none;
  }
  @keyframes bufferstatus-led-pulse {
    0%, 100% {
      box-shadow: 0 0 6px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
      opacity: 1;
    }
    50% {
      box-shadow: 0 0 14px var(--fiber-blue-glow, rgba(103, 232, 249, 0.35));
      opacity: 0.65;
    }
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
