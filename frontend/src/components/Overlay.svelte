<script lang="ts">
  import { ircState, setActiveBuffer } from '../stores/ircStore.svelte';
  import { sendRaw } from '../stores/wsConnection';
  import { ignoreList } from '../stores/preferences.svelte';
  import { updateRoute } from '../lib/routing';
  import { parseIrcFormatting } from '../lib/ircFormatting';
  import type { WhoisData, BanListData, ChannelDeleteConfirmData, SetTopicData, InviteData, IgnoreListData } from '../types';

  let topicInput: HTMLTextAreaElement | null = $state(null);
  let topicValue: string = $state('');

  let inviteInput: HTMLInputElement | null = $state(null);
  let inviteNick: string = $state('');

  let pendingUnignores: Record<string, boolean> = $state({});

  // mIRC color palette (codes 0-15) — standard 16 colors
  const IRC_COLORS: { code: number; name: string; hex: string }[] = [
    { code: 0, name: 'White', hex: '#ffffff' },
    { code: 1, name: 'Black', hex: '#000000' },
    { code: 2, name: 'Navy', hex: '#00007f' },
    { code: 3, name: 'Green', hex: '#009300' },
    { code: 4, name: 'Red', hex: '#ff0000' },
    { code: 5, name: 'Maroon', hex: '#7f0000' },
    { code: 6, name: 'Purple', hex: '#9c009c' },
    { code: 7, name: 'Olive', hex: '#fc7f00' },
    { code: 8, name: 'Yellow', hex: '#ffff00' },
    { code: 9, name: 'Lime', hex: '#00fc00' },
    { code: 10, name: 'Teal', hex: '#009393' },
    { code: 11, name: 'Aqua', hex: '#00ffff' },
    { code: 12, name: 'Blue', hex: '#0000fc' },
    { code: 13, name: 'Fuchsia', hex: '#ff00ff' },
    { code: 14, name: 'Gray', hex: '#7f7f7f' },
    { code: 15, name: 'Silver', hex: '#d2d2d2' },
  ];

  function close(): void {
    if (ircState.overlay.type === 'ignore_list') {
      for (const mask of Object.keys(pendingUnignores)) {
        const idx = ignoreList.indexOf(mask);
        if (idx >= 0) ignoreList.splice(idx, 1);
      }
      for (const key of Object.keys(pendingUnignores)) delete pendingUnignores[key];
    }
    ircState.overlay.type = null;
    ircState.overlay.data = null;
  }

  function relativeTime(timestamp: number): string {
    if (!timestamp) return '';
    const now = Date.now();
    const diff = now - timestamp * 1000;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  }

  function fullDate(timestamp: number): string {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
  }

  function unban(mask: string): void {
    const data = ircState.overlay.data as BanListData;
    if (!data) return;
    sendRaw(data.networkId, 'MODE ' + data.channel + ' -b ' + mask);
    setTimeout(() => {
      sendRaw(data.networkId, 'MODE ' + data.channel + ' +b');
    }, 500);
  }

  function unignore(mask: string): void {
    pendingUnignores[mask] = true;
  }

  function reignore(mask: string): void {
    delete pendingUnignores[mask];
  }

  function isPendingUnignore(mask: string): boolean {
    return !!pendingUnignores[mask];
  }

  function confirmDelete(data: ChannelDeleteConfirmData): void {
    const { networkId, bufferName } = data;
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) {
      sendRaw(networkId, 'PART ' + bufferName);
      const channels = net.buffers.filter(b => b.name !== '_server' && b.isJoined !== false);
      const delIdx = channels.findIndex(b => b.name === bufferName);
      const idx = net.buffers.findIndex(b => b.name === bufferName);
      if (idx >= 0) net.buffers.splice(idx, 1);
      if (delIdx > 0) {
        setActiveBuffer(networkId, channels[delIdx - 1].name);
        updateRoute(networkId, channels[delIdx - 1].name);
      } else {
        setActiveBuffer(networkId, '_server');
        updateRoute(networkId, '_server');
      }
    }
    close();
  }

  function confirmSetTopic(data: SetTopicData): void {
    sendRaw(data.networkId, 'TOPIC ' + data.bufferName + ' :' + topicValue);
    close();
  }

  function onTopicKeydown(e: KeyboardEvent, data: SetTopicData): void {
    // Enter inserts newline (textarea is multi-line). Ctrl/Cmd+Enter submits.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      confirmSetTopic(data);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function confirmInvite(data: InviteData): void {
    const nick = inviteNick.trim();
    if (!nick) return;
    sendRaw(data.networkId, 'INVITE ' + nick + ' ' + data.bufferName);
    close();
  }

  function onInviteKeydown(e: KeyboardEvent, data: InviteData): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmInvite(data);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  /** Insert text at the current caret position in the textarea. */
  function insertAtCaret(text: string): void {
    if (!topicInput) return;
    const start = topicInput.selectionStart ?? topicValue.length;
    const end = topicInput.selectionEnd ?? topicValue.length;
    const before = topicValue.slice(0, start);
    const after = topicValue.slice(end);
    topicValue = before + text + after;
    requestAnimationFrame(() => {
      if (topicInput) {
        const pos = (before + text).length;
        topicInput.focus();
        topicInput.setSelectionRange(pos, pos);
      }
    });
  }

  function insertCode(code: number): void {
    insertAtCaret(String.fromCharCode(code));
  }

  function insertBold(): void { insertCode(0x02); }
  function insertItalic(): void { insertCode(0x1d); }
  function insertUnderline(): void { insertCode(0x1f); }
  function insertStrikethrough(): void { insertCode(0x1e); }
  function insertMonospace(): void { insertCode(0x11); }
  function insertReset(): void { insertCode(0x0f); }

  function insertColorPair(fg: number, bg: number | null = null): void {
    const text = bg === null ? String.fromCharCode(0x03) + String(fg) : String.fromCharCode(0x03) + String(fg) + ',' + String(bg);
    insertAtCaret(text);
  }

  // Seed the textarea value when the overlay opens
  $effect(() => {
    if (ircState.overlay.type === 'set_topic' && ircState.overlay.data) {
      const data = ircState.overlay.data as SetTopicData;
      topicValue = data.currentTopic;
    }
  });

  // Focus the textarea when mounted
  $effect(() => {
    if (ircState.overlay.type === 'set_topic' && topicInput) {
      topicInput.focus();
      // Place caret at the end rather than selecting all (so the user
      // doesn't accidentally overwrite the existing color codes).
      const len = topicInput.value.length;
      topicInput.setSelectionRange(len, len);
    }
  });

  // Live preview of how the topic will look once rendered
  function preview(): string {
    return parseIrcFormatting(topicValue);
  }

  // Focus the invite input when the invite overlay opens
  $effect(() => {
    if (ircState.overlay.type === 'invite' && inviteInput) {
      inviteInput.focus();
    }
  });

</script>

{#if ircState.overlay.type}
  <div class="overlay-backdrop" onclick={close} role="presentation"></div>
  <div class="overlay-panel" class:topic-prompt={ircState.overlay.type === 'set_topic'} class:invite-prompt={ircState.overlay.type === 'invite'} class:centered={ircState.overlay.type === 'channel_delete_confirm' || ircState.overlay.type === 'set_topic' || ircState.overlay.type === 'invite'} role="dialog" aria-modal="true">
    <button class="overlay-close" class:hidden={ircState.overlay.type === 'channel_delete_confirm' || ircState.overlay.type === 'set_topic' || ircState.overlay.type === 'invite'} onclick={close} aria-label="Close">&times;</button>

    {#if ircState.overlay.type === 'whois' && ircState.overlay.data}
      {@const w = ircState.overlay.data as WhoisData}
      <h2>WHOIS: {w.nick}</h2>
      <dl class="whois-info">
        <dt>User</dt><dd>{w.user}@{w.host}</dd>
        <dt>Real name</dt><dd>{w.realname}</dd>
        <dt>Server</dt><dd>{w.server} ({w.serverInfo})</dd>
        {#if w.account}<dt>Account</dt><dd>{w.account}</dd>{/if}
        {#if w.channels && w.channels.length > 0}<dt>Channels</dt><dd>{w.channels.join(' ')}</dd>{/if}
        {#if w.idle > 0}<dt>Idle</dt><dd>{w.idle} seconds</dd>{/if}
        {#if w.secure}<dt>Secure</dt><dd>Yes (TLS)</dd>{/if}
        {#if w.away}<dt>Away</dt><dd>{w.away}</dd>{/if}
        {#if w.signon > 0}
          <dt>Signed on</dt><dd>{new Date(w.signon * 1000).toLocaleString()}</dd>
        {/if}
      </dl>
    {:else if ircState.overlay.type === 'banlist' && ircState.overlay.data}
      {@const data = ircState.overlay.data as BanListData}
      <div class="overlay-header">
        <h2>Ban list for <a href="/" class="buffer bufferLink channel" title={data.channel} onclick={(e) => { e.preventDefault(); close(); updateRoute(data.networkId, data.channel); }}>{data.channel}</a></h2>
        <button class="overlay-done" onclick={close} style="margin-right: 32px;">Done</button>
      </div>
      {#if data.bans.length === 0}
        <p class="no-data">No bans in effect.</p>
      {:else}
        <table cellspacing="0" class="overlayTable banlist-table">
          <thead>
            <tr>
              <th class="data_ban_list">Ban mask</th>
              <th class="data_ban_list">Set by</th>
              <th class="data_ban_list">When</th>
              <th class="data_ban_list">Remove</th>
            </tr>
          </thead>
          <tbody>
            {#each data.bans as ban, i}
              <tr class={i % 2 === 0 ? 'odd' : 'even'}>
                <td class="data_ban_list">{ban.mask}</td>
                <td class="data_ban_list">{ban.setBy}</td>
                <td class="data_ban_list"><span title={fullDate(ban.setAt)}>{relativeTime(ban.setAt)}</span></td>
                <td class="data_ban_list"><a href="" class="unban" title="Unban {ban.mask}" data-mask={ban.mask} onclick={(e) => { e.preventDefault(); unban(ban.mask); }}>x</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if ircState.overlay.type === 'ignore_list' && ircState.overlay.data}
      {@const d = ircState.overlay.data as IgnoreListData}
      <div class="overlay-header">
        <h2>Ignore list for {d.networkName}</h2>
        <button class="overlay-done" onclick={close} style="margin-right: 32px;">Done</button>
      </div>
      {#if ignoreList.length === 0}
        <p class="no-data">You're not ignoring anyone at the moment. You can ignore people from a menu by clicking their nickname or by using <kbd>/ignore</kbd></p>
      {:else}
        <table cellspacing="0" class="overlayTable ignorelist-table">
          <thead>
            <tr>
              <th class="data_ignore_list">Usermask</th>
            </tr>
          </thead>
          <tbody>
            {#each ignoreList as mask, i}
              {@const unignored = !!pendingUnignores[mask]}
              <tr class={(i % 2 === 0 ? 'odd' : 'even') + (unignored ? ' unignored' : '')} data-mask={mask}>
                <td class="data_ignore_list">
                  <a href="" class={unignored ? 'undounignore' : 'unignore'} title={unignored ? 'Re-ignore ' + mask : 'Unignore ' + mask} data-mask={mask} onclick={(e) => {
                    e.preventDefault();
                    if (pendingUnignores[mask]) {
                      delete pendingUnignores[mask];
                    } else {
                      pendingUnignores[mask] = true;
                    }
                  }}>{unignored ? 'undo' : 'x'}</a>
                  <span class={unignored ? 'unignored' : ''}>{mask}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if ircState.overlay.type === 'channel_delete_confirm' && ircState.overlay.data}
      {@const d = ircState.overlay.data as ChannelDeleteConfirmData}
      <div class="overlay_prompt overlay_class_channel_delete_confirm">
        <div class="overlayHead">
          <span class="buffer bufferLink">{d.networkName} ({d.networkHost})</span>
        </div>
        <div class="overlay">
          <p class="content">Are you sure you want to delete your history for {d.bufferName}</p>
          <p class="buttons">
            <button class="confirm delete" onclick={() => confirmDelete(d)}><span>OK</span></button>
            <button type="button" class="close" onclick={close}><span>Cancel</span></button>
          </p>
        </div>
      </div>
    {:else if ircState.overlay.type === 'set_topic' && ircState.overlay.data}
      {@const d = ircState.overlay.data as SetTopicData}
      <div class="overlay_prompt overlay_class_channel_topic_prompt">
        <div class="overlayHead">
          <span class="buffer bufferLink">{d.networkName} ({d.networkHost})</span>
        </div>
        <div class="overlay">
          <p class="content">Set the topic for {d.bufferName} ({topicValue.length} chars)</p>

          <div class="topic-toolbar" role="toolbar" aria-label="IRC formatting">
            <button type="button" class="fmt-btn" title="Bold (Ctrl+B)" onclick={insertBold}><b>B</b></button>
            <button type="button" class="fmt-btn" title="Italic" onclick={insertItalic}><i>I</i></button>
            <button type="button" class="fmt-btn" title="Underline" onclick={insertUnderline}><u>U</u></button>
            <button type="button" class="fmt-btn" title="Strikethrough" onclick={insertStrikethrough}><s>S</s></button>
            <button type="button" class="fmt-btn" title="Monospace" onclick={insertMonospace}><code>M</code></button>
            <button type="button" class="fmt-btn" title="Reset formatting" onclick={insertReset}>↺</button>
            <span class="fmt-sep"></span>
            <details class="fmt-color-picker">
              <summary title="Insert color">🎨 Color</summary>
              <div class="fmt-color-grid">
                {#each IRC_COLORS as c}
                  <button
                    type="button"
                    class="fmt-color-swatch"
                    style:background-color={c.hex}
                    title={c.name}
                    aria-label={`Color ${c.name}`}
                    onclick={() => insertColorPair(c.code)}
                  ></button>
                {/each}
              </div>
            </details>
          </div>

          <p class="form">
            <textarea
              class="input prompt"
              bind:this={topicInput}
              bind:value={topicValue}
              onkeydown={(e) => onTopicKeydown(e, d)}
              aria-label="Channel topic"
              rows="4"
              placeholder="#channel topic — use the toolbar above to add color/formatting"
              spellcheck="false"
            ></textarea>
          </p>

          {#if topicValue.length > 0}
            <div class="topic-preview">
              <div class="topic-preview-label">Preview</div>
              <div class="topic-preview-content">{@html preview()}</div>
            </div>
          {/if}

          <p class="buttons">
            <button type="button" class="confirm action" onclick={() => confirmSetTopic(d)}><span>OK</span></button>
             <button type="button" class="close" onclick={close}><span>Cancel</span></button>
          </p>
          <p class="hint">Ctrl/⌘+Enter to save · Esc to cancel</p>
        </div>
      </div>
    {:else if ircState.overlay.type === 'invite' && ircState.overlay.data}
      {@const d = ircState.overlay.data as InviteData}
      <div class="overlay_prompt overlay_class_channel_invite_prompt">
        <div class="overlayHead">
          <span class="buffer bufferLink" title={d.networkName}>{d.networkName} ({d.networkHost}:{d.networkPort})</span>
        </div>
        <div class="overlay">
          <p class="content">
            Invite someone to join {d.bufferName}.
          </p>
          <p class="form">
            <input
              class="input prompt"
              type="text"
              bind:this={inviteInput}
              bind:value={inviteNick}
              onkeydown={(e) => onInviteKeydown(e, d)}
              placeholder="Nickname"
              aria-label="Nickname to invite"
            />
          </p>
          <p class="buttons">
            <button type="button" class="confirm action" onclick={() => confirmInvite(d)}><span>OK</span></button>
            <button type="button" class="close" onclick={close}><span>Cancel</span></button>
          </p>
          <p class="hint">Enter to send · Esc to cancel</p>
        </div>
      </div>
    {/if}
  </div>
{/if}