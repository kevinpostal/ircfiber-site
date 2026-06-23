<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj } from '../stores/ircStore.svelte';
  import { sendRaw, sendMessage } from '../stores/wsConnection.svelte.ts';
  import { ignoreList } from '../stores/preferences.svelte';
  import { getAvatarColor, stripPrefix } from '../lib/utils';
  import type { Member, ModeCategory } from '../types';

  interface Props {
    nick: string;
    member?: Member | null;
    x: number;
    y: number;
    onClose: () => void;
    onSwitchBuffer: (networkId: string, bufferName: string) => void;
    onSendRaw?: (...args: any[]) => any;
    onSendMessage?: (...args: any[]) => any;
  }
  let { nick, member = null, x, y, onClose, onSwitchBuffer, onSendRaw = sendRaw, onSendMessage = sendMessage }: Props = $props();

  const isChannel = $derived(ircState.activeBuffer.bufferName?.startsWith('#') ?? false);
  const networkId = $derived(ircState.activeBuffer.networkId || '');
  const network = $derived(getActiveNetwork());
  const buffer = $derived(getActiveBufferObj());
  const isConnected = $derived(network?.connected ?? false);

  const displayNick = $derived(stripPrefix(member?.nick ?? nick));
  const avatarColor = $derived(getAvatarColor(displayNick));
  const avatarLetter = $derived(displayNick.charAt(0).toUpperCase());

  const modePrefix = $derived(member?.prefix ?? '');
  const modeClass = $derived.by(() => {
    if (!member?.prefix) return '';
    const map: Record<string, string> = { '!': 'mode_OPER', '~': 'mode_OWNER', '&': 'mode_ADMIN', '@': 'mode_OP', '%': 'mode_HALFOP', '+': 'mode_VOICED' };
    return map[member.prefix] ?? '';
  });
  const modeTitle = $derived.by(() => {
    if (!member?.category || member.category === 'MEMBER') return '';
    const titles: Record<ModeCategory, string> = { OPER: 'IRC Operator', OWNER: 'Owner', ADMIN: 'Admin', OP: 'Op', HALFOP: 'Halfop', VOICED: 'Voiced', MEMBER: '' };
    return titles[member.category] ?? '';
  });

  const ident = $derived(member?.ident ?? '');
  const realname = $derived(member?.realname ?? '');
  const account = $derived(member?.account ?? '');
  const isAway = $derived(member?.isAway ?? false);
  const awayMessage = $derived(member?.awayMessage ?? '');

  const hasOp = $derived(modePrefix === '@' || modePrefix === '~' || modePrefix === '&' || modePrefix === '!');
  const hasVoice = $derived(modePrefix === '+');

  let menuEl: HTMLDivElement;
  let messageValue: string = $state('');
  let messageInput: HTMLInputElement | null = $state(null);

  function close(): void { onClose(); }

  // Auto-focus the message input when the popup opens so the user
  // can type immediately without clicking into the tiny input field.
  // Without this, the Enter key goes to the main compose textarea and
  // the message gets sent to the channel instead of the user.
  $effect(() => {
    if (messageInput) {
      messageInput.focus();
    }
  });

  // Smart edge-detection positioning
  $effect(() => {
    if (!menuEl) return;
    const height = menuEl.offsetHeight;
    const width = menuEl.offsetWidth;
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    const bottomPad = 25;

    menuEl.classList.remove('contextMenu__top', 'contextMenu__bottom', 'contextMenu__left', 'contextMenu__right');

    const maxY = windowHeight - height - bottomPad;
    if (y > maxY) {
      menuEl.classList.add('contextMenu__bottom');
      menuEl.style.top = 'auto';
      menuEl.style.bottom = (windowHeight - y) + 'px';
    } else {
      menuEl.classList.add('contextMenu__top');
      menuEl.style.top = y + 'px';
      menuEl.style.bottom = 'auto';
    }

    const maxX = windowWidth - width - 10;
    if (x > maxX) {
      menuEl.classList.add('contextMenu__right');
      menuEl.style.left = 'auto';
      menuEl.style.right = (windowWidth - x) + 'px';
    } else {
      menuEl.classList.add('contextMenu__left');
      menuEl.style.left = x + 'px';
      menuEl.style.right = 'auto';
    }
  });

  function doWhois(): void {
    if (networkId) {
      ircState.pendingWhois.add(displayNick.toLowerCase());
      onSendRaw(networkId, 'WHOIS ' + displayNick);
    }
    close();
  }

  function openDM(): void {
    if (networkId) onSwitchBuffer(networkId, displayNick);
    close();
  }

  function doInvite(): void {
    if (networkId && buffer?.name) {
      const channel = prompt('Invite ' + displayNick + ' to channel:');
      if (channel) onSendRaw(networkId, 'INVITE ' + displayNick + ' ' + channel);
    }
    close();
  }

  function doIgnore(): void {
    const mask = '*!*@' + (ident || displayNick + '!*@*');
    const input = prompt('Ignore mask:', mask);
    if (input && !ignoreList.includes(input)) {
      ignoreList.push(input);
    }
    close();
  }

  function doOp(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `MODE ${buffer.name} +o ${displayNick}`);
    close();
  }
  function doDeop(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `MODE ${buffer.name} -o ${displayNick}`);
    close();
  }
  function doVoice(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `MODE ${buffer.name} +v ${displayNick}`);
    close();
  }
  function doDevoice(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `MODE ${buffer.name} -v ${displayNick}`);
    close();
  }
  function doKick(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `KICK ${buffer.name} ${displayNick}`);
    close();
  }
  function doBan(): void {
    if (networkId && buffer?.name) onSendRaw(networkId, `MODE ${buffer.name} +b ${displayNick}!*@*`);
    close();
  }

  function submitMessage(e: SubmitEvent): void {
    e.preventDefault();
    const text = messageValue.trim();
    if (text && networkId) {
      // Open a DM/query buffer so the user sees the conversation in the
      // sidebar and message list — like IRCCloud does. The buffer is
      // created automatically by switchToBuffer when the target is a
      // nick (not a channel).
      onSwitchBuffer(networkId, displayNick);
      // Send the private message using sendMessage (cmd: 'msg') so the
      // engine persists it in MongoDB and it survives page reloads.
      // Using sendRaw (cmd: 'raw') would send the PRIVMSG to the IRC
      // server without storing it — the message would disappear on reload.
      onSendMessage(networkId, displayNick, text);
    }
    messageValue = '';
    close();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={menuEl} id="memberContextMenu" class="contextMenu userPopup"
     onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
  <div class="contextMenu__wrap" style="max-height: none;">
    <div class="userContext">
      <h3 class="title">
        <span class="avatar letterAvatar" style:background-color={avatarColor}>
          <span role="presentation">{avatarLetter}</span>
        </span>
        {#if modePrefix}
          <span title={modeTitle} class="mode_prefix mode_symbol {modeClass}">{modePrefix}</span>
          <span title={modeTitle} class="mode_prefix mode_pill {modeClass}">&bull;</span>
        {/if}
        <span role="button" tabindex="0" class="buffer bufferLink memberContextMenu__titleLink {modeClass} user link"
              title={displayNick} onclick={openDM} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDM(); } }}>{displayNick}</span>
        {#if modeTitle}
          <span class="mode-label">({modeTitle})</span>
        {/if}
      </h3>
      {#if realname}
        <p class="info realname">{realname}</p>
      {/if}
      {#if ident}
        <p class="info hostmask">{ident}</p>
      {/if}
      {#if account}
        <p class="info account authed">Logged in as: <b>{account}</b></p>
      {/if}
      {#if isAway}
        <p class="info away">Away: {awayMessage || '(no message)'}</p>
      {/if}
    </div>
    <ul class="actions" style="display: block;">
      <li><button class="contextMenu__item whois" type="button" onclick={doWhois}>Whois</button></li>
      <li><button class="contextMenu__item open" type="button" onclick={openDM}>Open</button></li>
      {#if isChannel}
        <li><button class="contextMenu__item invite" type="button" onclick={doInvite}>Invite to a channel&hellip;</button></li>
      {/if}
      <li><button class="contextMenu__item ignore" type="button" onclick={doIgnore}>Ignore&hellip;</button></li>
      {#if isChannel}
        {#if hasOp}
          <li><button class="contextMenu__item deop" type="button" onclick={doDeop}>Deop</button></li>
        {:else}
          <li><button class="contextMenu__item op" type="button" onclick={doOp}>Op</button></li>
        {/if}
        {#if hasVoice}
          <li><button class="contextMenu__item devoice" type="button" onclick={doDevoice}>Devoice</button></li>
        {:else}
          <li><button class="contextMenu__item voice" type="button" onclick={doVoice}>Voice</button></li>
        {/if}
        <li><button class="contextMenu__item kick" type="button" onclick={doKick}>Kick&hellip;</button></li>
        <li class="modAction"><button class="contextMenu__item ban" type="button" onclick={doBan}>Ban&hellip;</button></li>
      {/if}
      <li>
        <form class="form messageForm" onsubmit={submitMessage}>
          <p><label for="contextMenuMessage">Send a message:</label></p>
          <input class="input message" id="contextMenuMessage" bind:value={messageValue} bind:this={messageInput} />
        </form>
      </li>
    </ul>
  </div>
</div>
