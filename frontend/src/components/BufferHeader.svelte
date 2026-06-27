<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer, markUserDisconnected, getTempUnavailable } from '../stores/ircStore.svelte';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import { autolinkHtml } from '../lib/autolinker';
  import { archivedMap } from '../stores/preferences.svelte';

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
  const memberCount = $derived(activeBufferObj?.users?.length ?? 0);
  const isChannel = $derived(ircState.activeBuffer.bufferName?.startsWith('#') ?? false);
  const connected = $derived(activeNetwork?.connected ?? false);
  const isConnecting = $derived(activeNetwork?.connectionState === 'connecting');
  const isJoined = $derived(activeBufferObj?.isJoined !== false);
  const isArchived = $derived(!!archivedMap[`${activeNetwork?.networkId}:${activeBufferObj?.name}`]);

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
        import('../stores/ircStore.svelte.ts').then(mod => {
          mod.appendMessage(net.networkId, '_server', {
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
          } as import('../types').IRCMessage);
        });
      } else {
        net.connectionState = 'connecting';
        setActiveBuffer(net.networkId, '_server');
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
    sendRaw(activeNetwork.networkId, 'JOIN ' + activeBufferObj.name);
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

<div class="bufferstatus">
  <div class="status bufferHead">
    <h2 class="bufferHeading{!isJoined ? ' bufferHeadingCollapsed' : ''}">
      {#if ircState.activeBuffer.bufferName && !ircState.activeBuffer.bufferName.startsWith('#') && ircState.activeBuffer.bufferName !== '_server'}
        <span class="bufferlabel label" id="current-channel">Conversation with {channelName}</span>
        <span class="realname" id="conversation-realname">{activeBufferObj?.name}</span>
      {:else}
        <span class="bufferlabel label" id="current-channel">{channelName}</span>
      {/if}
      {#if topic}
        <span class="topic" id="channel-topic">{@html autolinkHtml(parseIrcFormatting(topic))}</span>
      {/if}
    </h2>
    {#if tempUnavailableRemaining > 0}
      <div class="temp-unavailable-chip">Server busy — retry in {tempUnavailableRemaining}s</div>
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
        <button class="bufferOptions fa fa-cog" type="button"
                title="Options" aria-label="Options"
                aria-expanded="false" aria-haspopup="true"
                onclick={(e) => onJoinChannel(e)}></button>
      </p>
    {:else if isChannel}
      <nav class="bufferControls" aria-label="Channel controls">
        <span class="totalMemberCount memberToggle" id="member-count" role="button" tabindex="0" title="Members list" aria-label="Members list" aria-expanded={memberPanelOpen} onclick={onToggleMembers} onkeydown={(e) => e.key === 'Enter' && onToggleMembers()}><i class="fa fa-list-ul"></i><span>{memberCount}</span></span>
        <button class="bufferOptions fa fa-cog" type="button"
                title="Options" aria-label="Options"
                onclick={(e) => onJoinChannel(e)}></button>
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
        <button class="bufferOptions fa fa-cog" type="button"
                title="Options" aria-label="Options"
                onclick={(e) => onJoinChannel(e)}></button>
      </p>
    {:else}
      <p class="buttons">
        <button class="rejoin" type="button" onclick={onEditNetwork}>Edit</button>
        <button class="archive" type="button" onclick={handleConnectionAction} disabled={busy}>
          {connected || isConnecting ? 'Disconnect' : (activeNetwork?.disconnectReason ? 'Reconnect' : 'Connect')}
        </button>
        <button class="bufferOptions fa fa-cog" type="button"
                title="Options" aria-label="Options"
                onclick={(e) => onJoinChannel(e)}></button>
      </p>
    {/if}
    <button class="sidebarToggle fa fa-bars" type="button"
            title="Channel list" aria-label="Toggle channel list"
            onclick={() => onToggleSidebar?.()}></button>
  </div>
</div>
