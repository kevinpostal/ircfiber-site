<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, archiveBuffer } from '../stores/ircStore.svelte';
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

  async function handleConnectionAction(): Promise<void> {
    if (!activeNetwork || busy) return;
    const net = activeNetwork;
    busy = true;
    try {
      if (connected) {
        await disconnectNetwork(net.networkId);
        net.connected = false;
        net.connectionState = 'disconnected';
        net.disconnectReason = 'You disconnected';
      } else {
        net.connected = true;
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
    activeBufferObj.isJoined = true;
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
      <span class="bufferlabel label" id="current-channel">{channelName}</span>
      {#if topic}
        <span class="topic" id="channel-topic">{@html autolinkHtml(parseIrcFormatting(topic))}</span>
      {/if}
    </h2>
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
