<script lang="ts">
  import { getActiveNetwork, setActiveBuffer } from '../stores/ircStore.svelte';
  import { sendRaw, requestSync } from '../stores/wsConnection.svelte.ts';
  import { reconnectNetwork } from '../stores/api';

  interface Props {
    onSendRaw?: (...args: any[]) => any;
    onReconnect?: (...args: any[]) => any;
  }
  let { onSendRaw = sendRaw, onReconnect = reconnectNetwork }: Props = $props();

  const activeNetwork = $derived(getActiveNetwork());
  const isAway = $derived(activeNetwork?.isAway ?? false);
  const isDisconnected = $derived(activeNetwork ? !activeNetwork.connected : false);
  const isConnecting = $derived(activeNetwork?.connectionState === 'connecting');
  const disconnectReason = $derived(activeNetwork?.disconnectReason || '');
  const isReconnecting = $derived(isConnecting && disconnectReason.length > 0);
  const showStatus = $derived(isAway || isConnecting || (isDisconnected && !isConnecting));

  function handleBack(e: MouseEvent): void {
    e.preventDefault();
    if (!activeNetwork) return;
    onSendRaw(activeNetwork.networkId, 'AWAY');
  }

  async function handleReconnect(e: MouseEvent): Promise<void> {
    e.preventDefault();
    if (!activeNetwork) return;
    activeNetwork.connectionState = 'connecting';
    setActiveBuffer(activeNetwork.networkId, '_server');
    try {
      await onReconnect(activeNetwork.networkId);
      requestSync();
    } catch (err) { console.error(err); }
  }
</script>

<div class="connectionstatuscell" class:show={showStatus}>
  {#if isAway}
    <div class="connectionStatus connectionStatus--show away">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <a class="back" href="/" role="button" onclick={handleBack}>
        Away
        <span class="back">Click to come back (or type /back)</span>
      </a>
    </div>
  {/if}

  {#if isConnecting}
    <div class="connectionStatus connectionStatus--show connecting">
      <span class="connecting-msg">
        {#if isReconnecting}
          Reconnecting to {activeNetwork?.host || 'server'}&hellip;
        {:else}
          Connecting to {activeNetwork?.host || 'server'}&hellip;
        {/if}
      </span>
    </div>
  {/if}

  {#if isDisconnected && !isConnecting}
    <div class="connectionStatus connectionStatus--show reconnect">
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <a class="reconnect" href="/" role="button" onclick={handleReconnect}>
        <span class="reconnect">Click to reconnect (or type /reconnect)</span>
        {#if disconnectReason}
          <span class="disconnect-reason">{disconnectReason}</span>
        {/if}
      </a>
    </div>
  {/if}
</div>
