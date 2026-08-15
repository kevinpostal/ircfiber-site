<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj } from '../stores/ircStore.svelte';
  import { sendRaw, sendMessage } from '../stores/wsConnection.svelte.ts';
  import { ignoreList } from '../stores/preferences.svelte';
  import { getAvatarColor, stripPrefix } from '../lib/utils';
  import type { Member, ModeCategory, WhoisData } from '../types';

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

  // Smart edge-detection positioning with viewport clamping and 0-height guard
  $effect(() => {
    if (!menuEl) return;
    const doPosition = () => {
      const height = menuEl.offsetHeight;
      const width = menuEl.offsetWidth;
      if (height === 0 || width === 0) {
        requestAnimationFrame(doPosition);
        return;
      }
      const windowHeight = window.innerHeight;
      const windowWidth = window.innerWidth;
      const bottomPad = 25;
      const rightPad = 10;

      menuEl.classList.remove('contextMenu__top', 'contextMenu__bottom', 'contextMenu__left', 'contextMenu__right');

      let clampedY = y;
      if (clampedY < bottomPad) clampedY = bottomPad;
      const maxY = windowHeight - height - bottomPad;
      if (clampedY > maxY) {
        if (y - height - bottomPad >= bottomPad) {
          menuEl.classList.add('contextMenu__bottom');
          menuEl.style.top = 'auto';
          menuEl.style.bottom = (windowHeight - y) + 'px';
          const flippedTop = y - height;
          if (flippedTop < bottomPad) {
            menuEl.style.bottom = 'auto';
            menuEl.style.top = bottomPad + 'px';
            menuEl.classList.remove('contextMenu__bottom');
            menuEl.classList.add('contextMenu__top');
          }
        } else {
          menuEl.classList.add('contextMenu__top');
          menuEl.style.top = Math.max(bottomPad, maxY) + 'px';
          menuEl.style.bottom = 'auto';
        }
      } else {
        menuEl.classList.add('contextMenu__top');
        menuEl.style.top = clampedY + 'px';
        menuEl.style.bottom = 'auto';
      }

      let clampedX = x;
      if (clampedX < rightPad) clampedX = rightPad;
      const maxX = windowWidth - width - rightPad;
      if (clampedX > maxX) {
        if (x - width >= rightPad) {
          menuEl.classList.add('contextMenu__right');
          menuEl.style.left = 'auto';
          menuEl.style.right = (windowWidth - x) + 'px';
          const flippedLeft = x - width;
          if (flippedLeft < rightPad) {
            menuEl.style.right = 'auto';
            menuEl.style.left = rightPad + 'px';
            menuEl.classList.remove('contextMenu__right');
            menuEl.classList.add('contextMenu__left');
          }
        } else {
          menuEl.classList.add('contextMenu__left');
          menuEl.style.left = Math.max(rightPad, maxX) + 'px';
          menuEl.style.right = 'auto';
        }
      } else {
        menuEl.classList.add('contextMenu__left');
        menuEl.style.left = clampedX + 'px';
        menuEl.style.right = 'auto';
      }
    };
    doPosition();
  });

  function doWhois(): void {
    if (networkId) {
      const buf = ircState.activeBuffer.bufferName || displayNick;
      ircState.pendingWhois.set(displayNick.toLowerCase(), { networkId, bufferName: buf, ts: Date.now() });
      // IRCCloud-style: show cached whois immediately so the user gets
      // instant feedback even if the server is slow or the nick is only
      // known via the member list realname cache. The live WHOIS reply
      // (via App.svelte) will then refresh the overlay with fresh data.
      const m = member;
      const ident = m?.ident || '';
      const at = ident.indexOf('@');
      const u = at >= 0 ? ident.slice(0, at).split('!').pop() || ident.slice(0, at) : '';
      // ident may be "user@host" or "nick!user@host" - handle both
      let user = '';
      let host = '';
      if (ident.includes('@')) {
        const parts = ident.split('@');
        host = parts.pop() || '';
        const userPart = parts.join('@');
        // userPart may be "nick!user" or just "user"
        if (userPart.includes('!')) user = userPart.split('!').pop() || '';
        else user = userPart;
        if (!user && m?.ident) user = m.ident.split('@')[0].split('!').pop() || '';
      }
      const whoisData: WhoisData = {
        nick: displayNick,
        user: user || m?.ident?.split('@')[0]?.split('!').pop() || '',
        host: host || m?.ident?.split('@')[1] || '',
        realname: m?.realname || '',
        server: '',
        serverInfo: '',
        channels: [],
        idle: 0,
        signon: 0,
        account: m?.account || '',
        secure: false,
        away: m?.isAway ? (m.awayMessage || '') : '',
      };
      // Show overlay immediately with cached data (if any) so click always
      // produces visible feedback, fixing "only able to whois myself"
      // where server WHOIS for other nicks was delayed or coalesced.
      ircState.overlay.type = 'whois';
      ircState.overlay.data = whoisData;
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

  function doSend(): void {
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

  function submitMessage(e: SubmitEvent): void {
    e.preventDefault();
    doSend();
  }

  function handleSendClick(e: MouseEvent): void {
    e.preventDefault();
    doSend();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={menuEl} id="memberContextMenu" class="contextMenu userPopup"
     onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
  <div class="contextMenu__wrap">
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
          <span class="mode-label">{modeTitle}</span>
        {/if}
      </h3>
      {#if realname}
        <p class="info realname">{realname}</p>
      {/if}
      {#if ident}
        <p class="info hostmask">{ident}</p>
      {/if}
      {#if account}
        <p class="info account authed"><b>{account}</b></p>
      {/if}
      {#if isAway}
        <p class="info away">{awayMessage || 'Away'}</p>
      {/if}
    </div>
    <ul class="actions" style="display: block;">
      <!-- User info / discovery -->
      <li class="action-group-label">Info</li>
      <li><button class="contextMenu__item whois highlight" type="button" onclick={doWhois}><i class="fa-solid fa-address-card"></i>Whois</button></li>
      <li><button class="contextMenu__item open highlight" type="button" onclick={openDM}><i class="fa-solid fa-comment"></i>Open conversation</button></li>
      <li role="separator" class="action-divider"></li>

      <!-- Moderation -->
      {#if isChannel}
        <li class="action-group-label">Moderation</li>
        {#if hasOp}
          <li><button class="contextMenu__item deop" type="button" onclick={doDeop}><i class="fa-solid fa-shield"></i>Deop</button></li>
        {:else}
          <li><button class="contextMenu__item op" type="button" onclick={doOp}><i class="fa-solid fa-shield"></i>Op</button></li>
        {/if}
        {#if hasVoice}
          <li><button class="contextMenu__item devoice" type="button" onclick={doDevoice}><i class="fa-solid fa-microphone-slash"></i>Devoice</button></li>
        {:else}
          <li><button class="contextMenu__item voice" type="button" onclick={doVoice}><i class="fa-solid fa-microphone"></i>Voice</button></li>
        {/if}
        <li><button class="contextMenu__item kick danger" type="button" onclick={doKick}><i class="fa-solid fa-right-from-bracket"></i>Kick&hellip;</button></li>
        <li><button class="contextMenu__item ban danger" type="button" onclick={doBan}><i class="fa-solid fa-hammer"></i>Ban&hellip;</button></li>
        <li role="separator" class="action-divider"></li>
      {/if}

      <!-- Actions -->
      <li class="action-group-label">Actions</li>
      {#if isChannel}
        <li><button class="contextMenu__item invite" type="button" onclick={doInvite}><i class="fa-solid fa-user-plus"></i>Invite to a channel&hellip;</button></li>
      {/if}
      <li><button class="contextMenu__item ignore" type="button" onclick={doIgnore}><i class="fa-solid fa-ban"></i>Ignore&hellip;</button></li>

      <!-- Quick message -->
      <li role="separator" class="action-divider"></li>
      <li>
        <form class="form messageForm" onsubmit={submitMessage}>
          <div class="form-header">
            <i class="fa-solid fa-paper-plane"></i>
            <label for="contextMenuMessage">Send a message</label>
          </div>
          <div class="input-wrapper">
            <input class="input message" id="contextMenuMessage" placeholder="Type a message&hellip;" bind:value={messageValue} bind:this={messageInput} />
            <button class="send-btn" type="button" aria-label="Send" onclick={handleSendClick}><i class="fa-solid fa-arrow-right"></i></button>
          </div>
        </form>
      </li>
    </ul>
  </div>
</div>
