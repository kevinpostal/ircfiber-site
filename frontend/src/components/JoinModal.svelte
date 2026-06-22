<script lang="ts">
  import { ircState, setActiveBuffer, getActiveNetwork, sortBuffers } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection.svelte.ts';
  import { reconnectNetwork } from '../stores/api';
  import { normalizeChannelName } from '../lib/utils';
  import { updateRoute } from '../lib/routing';

  interface Props {
    onClose: () => void;
    onSendRaw?: (...args: any[]) => any;
  }
  let { onClose, onSendRaw = sendRaw }: Props = $props();

  let channel = $state('');
  let key = $state('');
  let showKey = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  const network = $derived(getActiveNetwork());
  const networkLabel = $derived(network ? `${network.name} (${network.host}:${network.port})` : '');

  $effect(() => {
    if (inputEl) {
      inputEl.focus();
    }
  });

  function handleSubmit(e?: Event): void {
    e?.preventDefault();
    if (!channel || !ircState.activeBuffer.networkId) return;
    const networkId = ircState.activeBuffer.networkId;
    const chan = normalizeChannelName(channel);
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net && !net.connected) {
      net.connectionState = 'connecting';
      net.connected = true;
      setActiveBuffer(networkId, '_server');
      updateRoute(networkId, '_server');
      reconnectNetwork(networkId);
    }
    if (net && !net.buffers.some(b => b.name === chan)) {
      net.buffers.push({
        name: chan, type: 'channel', isJoined: false,
        unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
        topic: '', topicSetBy: '', topicSetAt: 0, users: [],
        lastSeenMsgTime: Date.now(), firstUnseenMsgIndex: null,
      });
      sortBuffers(net);
    }
    onSendRaw(networkId, 'JOIN ' + chan + (key ? ' ' + key : ''));
    setActiveBuffer(networkId, chan);
    updateRoute(networkId, chan);
    onClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="overlay_prompt overlay_class_connection_nick_prompt" role="presentation">
  <div class="overlayHead">
    <span class="buffer bufferLink">{networkLabel}</span>
  </div>
  <div class="overlay">
    <form onsubmit={handleSubmit}>
      <p class="content">Which channel do you want to join?</p>
      <p class="form">
        <input
          class="input prompt"
          type="text"
          bind:this={inputEl}
          bind:value={channel}
          onkeydown={onKeydown}
          placeholder="#channel"
          required
          aria-label="#channel"
        />
      </p>
      {#if showKey}
        <p class="form">
          <input
            class="input prompt"
            type="text"
            bind:value={key}
            onkeydown={onKeydown}
            placeholder="Channel key (optional)"
            aria-label="Channel key"
          />
        </p>
      {/if}
      <p class="buttons">
        <button type="button" class="confirm action" onclick={() => handleSubmit()}><span>OK</span></button>
        <button type="button" class="close" onclick={onClose}><span>Cancel</span></button>
      </p>
    </form>
  </div>
</div>
