<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer, getBufferInputText, setBufferInputText, sortBuffers } from '../stores/ircStore.svelte';
  import { sendMessage, sendRaw } from '../stores/wsConnection.svelte.ts';
  import { reconnectNetwork } from '../stores/api';
  import { getSlashHandler } from '../lib/slashCommands';
  import { TabCompletionEngine } from '../lib/tabCompletion';
  import { InputHistory } from '../lib/inputHistory';
  import { generateLabel, getAvatarColor, normalizeChannelName } from '../lib/utils';
  import { startUploads, setDeps } from '../stores/uploadFlow.svelte';
  import { uploadState, ringState, aggregateProgress } from '../stores/uploadStore.svelte';
  import { dataURIToBlob } from '../lib/upload';
  import UploadMenu from './UploadMenu.svelte';
  import PastebinDialog from './PastebinDialog.svelte';
  import { MESSAGE_LENGTH_TRIGGER } from '../lib/messageSplitter';
  import { appendToProcessed, buildProcessedBuffer } from '../lib/messageBuilder';
  import { getPastebinDisablePrompt } from '../stores/preferences.svelte';
  import { updateRoute } from '../lib/routing';
  import { tick } from 'svelte';
  import type { IRCMessage } from '../types';

  // Side-effect import: registers the <emoji-picker> custom element.
  // The picker + its data are lazy-loaded only when first opened (see toggleEmoji).
  import 'emoji-picker-element';

  interface Props {
    onSendMessage?: (...args: any[]) => any;
    onSendRaw?: (...args: any[]) => any;
  }
  let { onSendMessage = sendMessage, onSendRaw = sendRaw }: Props = $props();

  let textarea: HTMLTextAreaElement;
  let inputValue = $state('');
  let uploadMenuOpen = $state(false);
  const tabEngine = new TabCompletionEngine();

  let now = $state(new Date());
  $effect(() => {
    const interval = setInterval(() => { now = new Date(); }, 1000);
    return () => clearInterval(interval);
  });
  const timeStr = $derived(now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  const timeTitle = $derived(now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  const history = new InputHistory();
  let isTabbing = $state(false);

  const activeNetwork = $derived(getActiveNetwork());
  const myNick = $derived.by(() => {
    const net = ircState.networks.find(n => n.networkId === ircState.activeBuffer.networkId);
    return net?.currentNick || net?.nick || '';
  });
  const avatarColor = $derived(getAvatarColor(myNick));
  const initial = $derived(myNick ? myNick.charAt(0).toUpperCase() : '?');

  $effect(() => {
    setDeps({
      getInputText: () => inputValue,
      clearInput: () => { inputValue = ''; void autoResizeAfterClear(); },
    });
  });

  // IRCCloud-style per-buffer input history: save current text when
  // switching away, restore it when switching back.
  let lastBufferKey = '';
  const currentBufferKey = $derived(
    ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName
      ? `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`
      : ''
  );
  $effect(() => {
    const newKey = currentBufferKey;
    // Save old buffer's text before switching
    if (lastBufferKey && lastBufferKey !== newKey) {
      const [nid, bname] = lastBufferKey.split(/:(.+)/);
      setBufferInputText(nid, bname, inputValue);
    }
    // Restore new buffer's text
    if (newKey && newKey !== lastBufferKey) {
      const [nid, bname] = newKey.split(/:(.+)/);
      inputValue = getBufferInputText(nid, bname);
    }
    lastBufferKey = newKey || lastBufferKey;
  });

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      e.preventDefault();
      handleTabCompletion(e.shiftKey ? -1 : 1);
      return;
    }

    if (isTabbing && e.key !== 'Tab') {
      tabEngine.reset();
      isTabbing = false;
    }

    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey) {
      if (InputHistory.isMultiline(inputValue)) return;
      const entry = history.getEarlier(inputValue);
      if (entry !== undefined) {
        e.preventDefault();
        inputValue = entry;
        requestAnimationFrame(() => {
          if (textarea) textarea.selectionStart = textarea.selectionEnd = inputValue.length;
        });
      }
      return;
    }

    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
      if (InputHistory.isMultiline(inputValue)) return;
      const entry = history.getLater();
      if (entry !== undefined) {
        e.preventDefault();
        inputValue = entry;
      }
      return;
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      history.resetIndex();
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
      return;
    }
  }

  function handleTabCompletion(direction: 1 | -1): void {
    const activeBufObj = getActiveBufferObj();
    if (!activeBufObj || !activeNetwork) return;

    if (!isTabbing) {
      const members = activeBufObj.users || [];
      const bufferNames = activeNetwork.buffers.map(b => b.name).filter(n => n !== '_server');
      const candidates = tabEngine.getCandidates(
        inputValue,
        textarea?.selectionStart ?? inputValue.length,
        members,
        bufferNames,
        myNick
      );
      if (candidates.length === 0) return;
      tabEngine.setCandidates(candidates);
      isTabbing = true;
    }

    const candidate = tabEngine.cycle(direction);
    if (candidate) {
      const result = tabEngine.apply(inputValue, candidate);
      inputValue = result.text;
      requestAnimationFrame(() => {
        if (textarea) textarea.selectionStart = textarea.selectionEnd = result.cursor;
      });
    }
  }

  function ensureConnected(): void {
    if (!activeNetwork || activeNetwork.connected) return;
    activeNetwork.connectionState = 'connecting';
    activeNetwork.connected = true;
    setActiveBuffer(activeNetwork.networkId, '_server');
    updateRoute(activeNetwork.networkId, '_server');
    reconnectNetwork(activeNetwork.networkId);
  }

  async function handleSend(): Promise<void> {
    const text = inputValue.trim();
    if (!text || !ircState.activeBuffer.networkId) return;

    const networkId = ircState.activeBuffer.networkId;
    const target = ircState.activeBuffer.bufferName || '';

    history.push(text);

    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (cmd === 'join' || cmd === 'j') {
        ensureConnected();
        const channel = args[0];
        const key = args[1];
        if (channel) {
          const chan = normalizeChannelName(channel);
          const net = ircState.networks.find(n => n.networkId === networkId);
          if (net && !net.buffers.some(b => b.name === chan)) {
            net.buffers.push({
              name: chan, type: 'channel', isJoined: true,
              unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
              topic: '', topicSetBy: '', topicSetAt: 0, users: [],
              lastSeenMsgTime: Date.now(), firstUnseenMsgIndex: null,
            });
            sortBuffers(net);
          }
          onSendRaw(networkId, 'JOIN ' + chan + (key ? ' ' + key : ''));
          setActiveBuffer(networkId, chan);
          updateRoute(networkId, chan);
        }
        inputValue = '';
        void autoResizeAfterClear();
        return;
      }

      if (cmd === 'msg' || cmd === 'query') {
        ensureConnected();
        const msgTarget = args[0];
        const msgText = args.slice(1).join(' ');
        if (msgTarget && msgText) {
          onSendMessage(networkId, msgTarget, msgText);
        }
        inputValue = '';
        void autoResizeAfterClear();
        return;
      }

      const handler = getSlashHandler(cmd);
      if (handler) {
        try {
          handler(args, networkId, target, activeNetwork);
        } catch (e: unknown) {
          const err = e as Error;
          console.error('Slash command error:', err.message);
        }
      } else {
        ensureConnected();
        onSendRaw(networkId, text.slice(1));
      }
    } else {
      ensureConnected();

      // IRCCloud-style: large/multi-line messages pop a confirmation dialog
      // offering to post a snippet to a pastebin or send as multiple
      // messages.  Triggered when the message has a newline or exceeds
      // MESSAGE_LENGTH_TRIGGER (1080 chars, ~3 lines of text).
      if (!getPastebinDisablePrompt() && shouldPromptPastebin(text)) {
        pastebinOpen = true;
        pastebinText = text;
        pastebinNetworkId = networkId;
        pastebinTarget = target;
        // Don't clear the input yet — if the user cancels from the dialog
        // we want their text preserved.  clear() happens after the dialog
        // dismisses (via the 'close'/'sent' events).
        return;
      }

      const label = generateLabel();
      onSendMessage(networkId, target, text, label);

      const optimistic: IRCMessage = {
        timestamp: new Date().toISOString(),
        t: Date.now(),
        nick: myNick,
        text,
        command: 'PRIVMSG',
        label,
      };
      ircState.optimisticMessages.set(label, optimistic);
      const key = `${networkId}:${target}`;
      const list = ircState.messages[key] ?? [];
      list.push(optimistic);
      ircState.messages[key] = list;
      // Keep the processed cache in sync so MessageList renders the optimistic row immediately.
      if (ircState.processedMessages[key]) {
        ircState.processedMessages[key] = appendToProcessed(ircState.processedMessages[key], [optimistic]);
      } else {
        ircState.processedMessages[key] = buildProcessedBuffer(list);
      }
    }

    inputValue = '';
    void autoResizeAfterClear();
  }

  // IRCCloud parity: shouldPaste — newline OR >1080 chars.
  function shouldPromptPastebin(text: string): boolean {
    return text.indexOf('\n') !== -1 || text.length > MESSAGE_LENGTH_TRIGGER;
  }

  let pastebinOpen = $state(false);
  let pastebinText = $state('');
  let pastebinNetworkId = $state('');
  let pastebinTarget = $state('');

  function onPastebinClose() {
    pastebinOpen = false;
    // User cancelled from the dialog: restore the text to the input.
    inputValue = pastebinText;
    void autoResizeAfterClear();
  }

  function onPastebinSent() {
    pastebinOpen = false;
    inputValue = '';
    void autoResizeAfterClear();
  }

  function autoResize(): void {
    if (!textarea) return;
    textarea.style.height = 'auto';
    // Clamp to the CSS max-height (200px) so the inline style never holds
    // a value the browser immediately discards — that's the "messes with
    // the CSS" the user reported.
    const cs = getComputedStyle(textarea);
    const max = parseInt(cs.maxHeight, 10) || Infinity;
    const target = Math.min(textarea.scrollHeight, max);
    textarea.style.height = target + 'px';
  }

  // After clearing the input we have to wait for Svelte to flush the
  // bind:value update to the DOM, otherwise scrollHeight is computed from
  // the OLD value and the textarea stays expanded.
  async function autoResizeAfterClear(): Promise<void> {
    await tick();
    autoResize();
  }

  function handleInput(): void {
    autoResize();
  }

  function handleNickClick(): void {
    if (!activeNetwork) return;
    const newNick = prompt('Change nickname:', myNick);
    if (newNick && newNick !== myNick) {
      // Optimistic: update the displayed nick immediately
      activeNetwork.currentNick = newNick;
      onSendRaw(activeNetwork.networkId, 'NICK ' + newNick);
    }
  }

  // Emoji picker state — the <emoji-picker> web component is registered
  // by the side-effect import above. We just toggle visibility.
  let emojiOpen = $state(false);
  let emojiPicker: HTMLElement | null = $state(null);
  let emojiButton: HTMLDivElement | null = $state(null);

  async function toggleEmoji(): Promise<void> {
    emojiOpen = !emojiOpen;
    if (emojiOpen) {
      // Wait for the {#if} block to render the element, then wire the event.
      await Promise.resolve();
      const el = document.querySelector('#emoji-popover emoji-picker') as HTMLElement | null;
      if (el && el !== emojiPicker) {
        emojiPicker = el;
        el.addEventListener('emoji-click', onEmojiClick as EventListener);
      }
    }
  }

  function onEmojiClick(ev: Event): void {
    const detail = (ev as CustomEvent).detail;
    const unicode: string | undefined = detail?.unicode;
    if (unicode) {
      insertAtCursor(unicode);
      textarea?.focus();
    }
    // Close the picker after the user picks an emoji
    emojiOpen = false;
  }

  function insertAtCursor(text: string): void {
    if (!textarea) return;
    const start = textarea.selectionStart ?? inputValue.length;
    const end = textarea.selectionEnd ?? inputValue.length;
    inputValue = inputValue.slice(0, start) + text + inputValue.slice(end);
    // Move caret to after the inserted text on next tick
    queueMicrotask(() => {
      const pos = start + text.length;
      textarea!.setSelectionRange(pos, pos);
      autoResize();
    });
  }

  function handlePaste(e: ClipboardEvent): void {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      } else if (item.kind === 'string' && item.type === 'text/plain') {
        item.getAsString((value) => {
          const blob = dataURIToBlob(value);
          if (blob) {
            startUploads([blob], { networkId: ircState.activeBuffer.networkId ?? '', buffer: ircState.activeBuffer.bufferName ?? '' });
          }
        });
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      startUploads(files, { networkId: ircState.activeBuffer.networkId ?? '', buffer: ircState.activeBuffer.bufferName ?? '' });
    }
  }

  function handleDocumentClick(ev: MouseEvent): void {
    if (!emojiOpen) return;
    const target = ev.target as Node;
    // Click on the emoji button itself → let the button's onclick toggle it
    if (emojiButton?.contains(target)) return;
    // Clicks inside the picker (including its shadow DOM) should not close it
    if (emojiPicker) {
      const path = ev.composedPath();
      if (path.includes(emojiPicker) || emojiPicker.contains(target)) return;
    }
    emojiOpen = false;
  }

  $effect(() => {
    if (typeof document === 'undefined') return;
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  });
</script>

<div class="bufferinputcell">
  <div class="nickinputcell">
    <div class="nickinput">
      <div class="nickcell">
        <span class="buffernick" onclick={handleNickClick} title="Click to change nick">
          <span class="avatar letterAvatar letterAvatar--self" id="input-avatar"
                style="background-color: {avatarColor}">{initial}</span>
          <span class="nick" id="input-nick">{myNick}</span>
        </span>
      </div>
      <div class="inputcell">
        <form class="input" id="compose" role="form" aria-label="Send message"
              onsubmit={(e) => { e.preventDefault(); void handleSend(); }}>
          <textarea
            bind:this={textarea}
            bind:value={inputValue}
            id="compose-input"
            name="text"
            placeholder="Type a message..."
            autocomplete="off"
            rows="1"
            aria-label="Message input"
            spellcheck="true"
            onkeydown={handleKeyDown}
            oninput={handleInput}
            onpaste={handlePaste}
          ></textarea>
        </form>
      </div>
      <div class="lockcell"><i class="fa-solid fa-lock" title="Password protected" aria-hidden="true"></i></div>
      <div class="emojicell" bind:this={emojiButton} role="button" tabindex="0"
           aria-label="Pick an emoji" aria-expanded={emojiOpen} aria-haspopup="dialog"
           title="Pick an emoji"
           onclick={toggleEmoji}
           onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggleEmoji(); } }}>
        <i class="fa-regular fa-face-smile" aria-hidden="true"></i>
      </div>
      <div class="uploadcell {ringState()}" class:engaged={uploadState.active.length > 0}
           role="button" tabindex="0" aria-label="Uploads" title="Uploads"
           onclick={() => { uploadMenuOpen = !uploadMenuOpen; }}
           onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); uploadMenuOpen = !uploadMenuOpen; } }}>
        {#if uploadState.active.length > 0}
          <span class="radialProgress" style="--pct: {aggregateProgress()}"></span>
        {:else}
          <i class="fa-regular fa-copy" aria-hidden="true"></i>
        {/if}
      </div>
      {#if uploadMenuOpen}
        <div class="uploadMenuAnchor">
          <UploadMenu onClose={() => { uploadMenuOpen = false; }} />
        </div>
      {/if}
    </div>
  </div>
  <PastebinDialog
    open={pastebinOpen}
    text={pastebinText}
    networkId={pastebinNetworkId}
    target={pastebinTarget}
    onclose={onPastebinClose}
    onsent={onPastebinSent}
  />
  <div class="timestampcell" id="timeContainer" title={timeTitle}>{timeStr}</div>
  {#if emojiOpen}
    <div id="emoji-popover" class="emoji-popover" role="dialog" aria-label="Emoji picker">
      <emoji-picker class="dark"></emoji-picker>
    </div>
  {/if}
</div>
