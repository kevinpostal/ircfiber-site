<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer } from '../stores/ircStore.svelte';
  import { reconnectNetwork, disconnectNetwork } from '../stores/api';
  import { parseIrcFormatting } from '../lib/ircFormatting';

  interface Props {
    onAddNetwork: () => void;
    onEditNetwork: () => void;
    onJoinChannel: (e?: MouseEvent) => void;
    onToggleMembers: () => void;
  }
  let { onEditNetwork, onJoinChannel, onToggleMembers }: Props = $props();

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
    <div class="serverHeading">
      <h2 class="channel-name" id="current-channel">{channelName}</h2>
      <p class="channel-host" id="channel-host">
        {#if activeNetwork}{activeNetwork.host}:{activeNetwork.port}{/if}
      </p>
      <div class="channel-identity">
        <span class="identity-item">
          <span class="identity-label">Nick:</span>
          <span class="identity-value" id="network-nick">{activeNetwork?.currentNick || activeNetwork?.nick || ''}</span>
        </span>
        <span class="identity-item">
          <span class="identity-label">Server:</span>
          <span class="identity-value" id="network-realname">{activeNetwork?.name || ''}</span>
        </span>
      </div>
    </div>
    <nav class="bufferControls" aria-label="Channel controls">
      <span class="ws-status" id="ws-status"></span>
      <button class="btn-primary" type="button" onclick={onEditNetwork}>Edit</button>
      <button class="btn-secondary" type="button" onclick={handleConnectionAction} disabled={busy}>
        {connected ? 'Disconnect' : (activeNetwork?.disconnectReason ? 'Reconnect' : 'Connect')}
      </button>
      {#if isChannel}
        <button class="btn-secondary btn-icon-only" type="button"
                id="member-count-btn" aria-label="Toggle member list"
                onclick={onToggleMembers}>
          <span class="count" id="member-count">{memberCount}</span>
          <span>members</span>
        </button>
      {/if}
      <button class="bufferOptions fa fa-cog" type="button"
              title="Options" aria-label="Options"
              onclick={(e) => onJoinChannel(e)}></button>
    </nav>
  </div>
  {#if topic}
    <div class="channel-topic" id="channel-topic">{@html parseIrcFormatting(topic)}</div>
  {/if}
</div>
