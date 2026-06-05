<script lang="ts">
  import { ircState } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection';

  interface Props {
    nick: string;
    x: number;
    y: number;
    onClose: () => void;
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onSendRaw?: (...args: any[]) => any;
  }
  let { nick, x, y, onClose, onSwitchBuffer, onSendRaw = sendRaw }: Props = $props();

  const isChannel = $derived(ircState.activeBuffer.bufferName?.startsWith('#') ?? false);
  const networkId = $derived(ircState.activeBuffer.networkId || '');

  function close(): void { ircState.contextMenu.visible = false; onClose(); }

  function doWhois(): void {
    if (networkId) onSendRaw(networkId, 'WHOIS ' + nick);
    close();
  }

  function openDM(): void {
    if (networkId) onSwitchBuffer(networkId, nick);
    close();
  }

  function doOp(): void {
    if (networkId) onSendRaw(networkId, `MODE ${ircState.activeBuffer.bufferName} +o ${nick}`);
    close();
  }
  function doDeop(): void {
    if (networkId) onSendRaw(networkId, `MODE ${ircState.activeBuffer.bufferName} -o ${nick}`);
    close();
  }
  function doVoice(): void {
    if (networkId) onSendRaw(networkId, `MODE ${ircState.activeBuffer.bufferName} +v ${nick}`);
    close();
  }
  function doDevoice(): void {
    if (networkId) onSendRaw(networkId, `MODE ${ircState.activeBuffer.bufferName} -v ${nick}`);
    close();
  }
  function doKick(): void {
    if (networkId) onSendRaw(networkId, `KICK ${ircState.activeBuffer.bufferName} ${nick}`);
    close();
  }
  function doBan(): void {
    if (networkId) onSendRaw(networkId, `MODE ${ircState.activeBuffer.bufferName} +b ${nick}!*@*`);
    close();
  }
</script>

<div class="userPopup contextMenu" style="left: {x}px; top: {y}px;">
  <div class="contextMenu__wrap">
    <div class="userPopup__header">
      <strong>{nick}</strong>
    </div>
    <ul class="actions">
      <li><button class="contextMenu__item" type="button" onclick={doWhois}>WHOIS</button></li>
      <li><button class="contextMenu__item" type="button" onclick={openDM}>Message</button></li>
      {#if isChannel}
        <li class="contextMenu__separator"></li>
        <li><button class="contextMenu__item" type="button" onclick={doOp}>Op</button></li>
        <li><button class="contextMenu__item" type="button" onclick={doDeop}>Deop</button></li>
        <li><button class="contextMenu__item" type="button" onclick={doVoice}>Voice</button></li>
        <li><button class="contextMenu__item" type="button" onclick={doDevoice}>Devoice</button></li>
        <li class="contextMenu__separator"></li>
        <li><button class="contextMenu__item" type="button" onclick={doKick}>Kick</button></li>
        <li><button class="contextMenu__item" type="button" onclick={doBan}>Ban</button></li>
      {/if}
    </ul>
  </div>
</div>
