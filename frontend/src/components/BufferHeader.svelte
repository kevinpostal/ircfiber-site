<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer } from '../stores/ircStore.svelte';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { parseIrcFormatting } from '../lib/ircFormatting';

  interface Props {
    onAddNetwork: () => void;
    onEditNetwork: () => void;
    onJoinChannel: (e?: MouseEvent) => void;
    onToggleMembers: () => void;
    memberPanelOpen: boolean;
  }
  let { onEditNetwork, onJoinChannel, onToggleMembers, memberPanelOpen }: Props = $props();

  const activeNetwork = $derived(getActiveNetwork());
  const activeBufferObj = $derived(getActiveBufferObj());
  const channelName = $derived(activeBufferObj?.name || ircState.activeBuffer.bufferName || '\u2014');
  const topic = $derived(activeBufferObj?.topic || '');
  const memberCount = $derived(activeBufferObj?.users?.length ?? 0);
  const isChannel = $derived(ircState.activeBuffer.bufferName?.startsWith('#') ?? false);
  const connected = $derived(activeNetwork?.connected ?? false);

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
</script>

<div class="bufferstatus">
  <div class="bufferHead">
    <h2 class="channel-name" id="current-channel">{channelName}</h2>
    {#if topic}
      <span class="topic" id="channel-topic">{@html parseIrcFormatting(topic)}</span>
    {/if}
    <nav class="bufferControls" aria-label="Channel controls">
      <span class="ws-status" id="ws-status"></span>
      <button class="btn-primary" type="button" onclick={onEditNetwork}>Edit</button>
      <button class="btn-secondary" type="button" onclick={handleConnectionAction} disabled={busy}>
        {connected ? 'Disconnect' : (activeNetwork?.disconnectReason ? 'Reconnect' : 'Connect')}
      </button>
      {#if isChannel}
        <span class="totalMemberCount memberToggle" id="member-count" role="button" tabindex="0" title="Members list" aria-label="Members list" aria-expanded={memberPanelOpen} onclick={onToggleMembers} onkeydown={(e) => e.key === 'Enter' && onToggleMembers()}><i class="fa fa-list-ul"></i><span>{memberCount}</span></span>
      {/if}
      <button class="bufferOptions fa fa-cog" type="button"
              title="Options" aria-label="Options"
              onclick={(e) => onJoinChannel(e)}></button>
    </nav>
  </div>
</div>
