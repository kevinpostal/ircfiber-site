<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection';
  import { getActiveNetwork } from '../stores/ircStore.svelte';
  import { normalizeChannelName } from '../lib/utils';

  interface Props { 
    onClose: () => void;
    onSendRaw?: (...args: any[]) => any;
  }
  let { onClose, onSendRaw = sendRaw }: Props = $props();

  let channel = $state('');
  let key = $state('');
  let needsKey = $state(true);

  const network = $derived(getActiveNetwork());
  const networkLabel = $derived(network ? `${network.name} (${network.host}:${network.port})` : '');

  function handleSubmit(e: Event): void {
    e.preventDefault();
    if (!channel || !ircState.activeBuffer.networkId) return;
    const networkId = ircState.activeBuffer.networkId;
    const chan = normalizeChannelName(channel);
    const joinCmd = 'JOIN ' + channel + (key ? ' ' + key : '');
    onSendRaw(networkId, joinCmd);
    setActiveBuffer(networkId, chan);
    onClose();
  }
</script>

<div class="overlaycontainer" role="dialog" aria-label="Join a channel">
  <button type="button" class="close" aria-label="Close" onclick={onClose}>
    <span></span>
  </button>
  <div class="overlaycontents">
    <div class="overlay_prompt">
      <div class="overlayHead">
        <span class="buffer bufferLink">{networkLabel}</span>
      </div>
      <div class="overlay">
        <form onsubmit={handleSubmit}>
          <p class="content">Which channel do you want to join?</p>
          <p class="form">
            <input class="input prompt" type="text" bind:value={channel} placeholder="#channel" required autofocus />
          </p>
          {#if needsKey}
            <p class="form">
              <input class="input prompt" type="text" bind:value={key} placeholder="Channel key (optional)" />
            </p>
          {/if}
          <p class="buttons">
            <button type="submit" class="confirm action"><span>OK</span></button>
            <button type="button" class="close" onclick={onClose}><span>Cancel</span></button>
          </p>
        </form>
      </div>
    </div>
  </div>
</div>
