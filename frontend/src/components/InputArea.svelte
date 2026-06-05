<script lang="ts">
  import { ircState, getActiveNetwork, getActiveBufferObj, setActiveBuffer } from '../stores/ircStore.svelte';
  import { sendMessage, sendRaw } from '../stores/wsConnection';
  import { reconnectNetwork } from '../stores/api';
  import { getSlashHandler } from '../lib/slashCommands';
  import { TabCompletionEngine } from '../lib/tabCompletion';
  import { InputHistory } from '../lib/inputHistory';
  import { generateLabel, getAvatarColor, normalizeChannelName } from '../lib/utils';
  import { updateRoute } from '../lib/routing';
  import type { IRCMessage } from '../types';

  interface Props {
    onSendMessage?: (...args: any[]) => any;
    onSendRaw?: (...args: any[]) => any;
  }
  let { onSendMessage = sendMessage, onSendRaw = sendRaw }: Props = $props();

  let textarea: HTMLTextAreaElement;
  let inputValue = $state('');
  const tabEngine = new TabCompletionEngine();
  const history = new InputHistory();
  let isTabbing = $state(false);

  const activeNetwork = $derived(getActiveNetwork());
  const myNick = $derived(activeNetwork?.currentNick || activeNetwork?.nick || '');
  const avatarColor = $derived(getAvatarColor(myNick));
  const initial = $derived(myNick ? myNick.charAt(0).toUpperCase() : '?');

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
          }
          onSendRaw(networkId, 'JOIN ' + channel + (key ? ' ' + key : ''));
          setActiveBuffer(networkId, chan);
          updateRoute(networkId, chan);
        }
        inputValue = '';
        autoResize();
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
        autoResize();
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
    }

    inputValue = '';
    autoResize();
  }

  function autoResize(): void {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function handleInput(): void {
    autoResize();
  }
</script>

<div class="bufferinputcell">
  <div class="nickinputcell">
    <div class="nickinput">
      <div class="nickcell">
        <span class="buffernick">
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
          ></textarea>
        </form>
      </div>
    </div>
  </div>
</div>
