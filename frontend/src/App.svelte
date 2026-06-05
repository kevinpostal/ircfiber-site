<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ChatArea from './components/ChatArea.svelte';
  import MemberList from './components/MemberList.svelte';
  import BufferHeader from './components/BufferHeader.svelte';
  import NetworkForm from './components/NetworkForm.svelte';
  import JoinModal from './components/JoinModal.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import ChannelContextMenu from './components/ChannelContextMenu.svelte';
  import Overlay from './components/Overlay.svelte';
  import NotificationBadge from './components/NotificationBadge.svelte';
  import UserPopup from './components/UserPopup.svelte';
  import {
    ircState, getActiveNetwork, getActiveBufferObj,
    updateNetworkFromSync, appendMessage, handleConnect,
    updateChannelUsers, setMessages, prependMessages,
    setActiveBuffer, updateChannelTopic, trimMessagesIfNeeded
  } from './stores/ircStore.svelte';
  import { isIgnored } from './stores/preferences.svelte';
  import { connectWebSocket, requestSync, requestSwitchBuffer, disconnectWebSocket } from './stores/wsConnection';
  import { loadHistory, fetchMe } from './stores/api';
  import { normalizeChannelName, isSkippedCommand, stripPrefix } from './lib/utils';
  import { notify } from './lib/notifications';
  import { membersCollapsedMap } from './stores/preferences.svelte';
  import { updateRoute } from './lib/routing';
  import type { IRCMessage, Network, WhoisData, BanEntry } from './types';

  let showNetworkForm: boolean = $state(false);
  let showJoinModal: boolean = $state(false);
  let networkFormMode: 'add' | 'edit' = $state('add');
  let localMsgIdCounter = 0;
  let editNetworkId: string | null = $state(null);
  let channelMenu: { x: number; y: number } | null = $state(null);

  let userPopup: { nick: string; x: number; y: number } | null = $state(null);

  let whoisAcc: Partial<WhoisData> | null = null;
  let banAcc: BanEntry[] = [];
  let banTargetChannel = '';

  let hasMembers = $derived(
    ircState.activeBuffer.bufferName !== null &&
    ircState.activeBuffer.bufferName !== '_server' &&
    getActiveBufferObj()?.type === 'channel'
  );

  let memberPanelOpen: boolean = $state(true);

  $effect(() => {
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    memberPanelOpen = !membersCollapsedMap[key];
  });

  function toggleMemberPanel(): void {
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const next = !membersCollapsedMap[key];
    membersCollapsedMap[key] = next;
  }

  $effect(() => {
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName) updateRoute(networkId, bufferName);
  });

  let syncInterval: ReturnType<typeof setInterval>;

  onMount(async () => {
    try {
      const user = await fetchMe();
      ircState.me = user;
    } catch (e) {
      console.error('Failed to fetch user:', e);
    }

    connectWebSocket(
      handleWsMessage,
      () => {
        ircState.wsConnected = true;
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(requestSync, 10000);
      },
      () => {
        ircState.wsConnected = false;
      }
    );

    window.addEventListener('popstate', checkRoute);
    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('keydown', handleGlobalKeyboard);
    document.addEventListener('click', handleDocumentClick);

    checkRoute();
  });

  onDestroy(() => {
    clearInterval(syncInterval);
    disconnectWebSocket();
    window.removeEventListener('popstate', checkRoute);
    document.removeEventListener('visibilitychange', handleVisibility);
    document.removeEventListener('keydown', handleGlobalKeyboard);
    document.removeEventListener('click', handleDocumentClick);
  });

  function handleVisibility(): void {
    if (document.hidden) {
      ircState.focusLost = true;
      const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
      const list = ircState.messages[key] ?? [];
      if (list.length > 0) {
        ircState.lastSeenMsgTime = list[list.length - 1].t ?? Date.now();
      }
    } else {
      ircState.focusLost = false;
    }
  }

  function handleDocumentClick(e: MouseEvent): void {
    if (userPopup) {
      const target = e.target as HTMLElement;
      if (!target.closest('.userPopup') && !target.closest('.bufferLink') && !target.closest('.member-entry')) {
        userPopup = null;
      }
    }
  }

  function handleGlobalKeyboard(e: KeyboardEvent): void {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      switchAdjacentBuffer(e.key === 'ArrowUp' ? -1 : 1);
    }
    if (e.key === 'Escape') {
      if (ircState.overlay.type) { ircState.overlay.type = null; ircState.overlay.data = null; }
      if (ircState.contextMenu.visible) { ircState.contextMenu.visible = false; }
      if (showNetworkForm) { showNetworkForm = false; }
      if (showJoinModal) { showJoinModal = false; }
      if (userPopup) { userPopup = null; }
    }
  }

  function switchAdjacentBuffer(direction: number): void {
    const flat = computeFlatBuffers();
    const currentIdx = flat.findIndex(f =>
      f.networkId === ircState.activeBuffer.networkId && f.bufferName === ircState.activeBuffer.bufferName
    );
    if (currentIdx < 0) return;
    const newIdx = Math.max(0, Math.min(flat.length - 1, currentIdx + direction));
    const target = flat[newIdx];
    switchToBuffer(target.networkId, target.bufferName);
  }

  function computeFlatBuffers(): { networkId: string; bufferName: string }[] {
    const flat: { networkId: string; bufferName: string }[] = [];
    for (const net of ircState.networks) {
      flat.push({ networkId: net.networkId, bufferName: '_server' });
      for (const buf of net.buffers) {
        if (buf.name !== '_server' && buf.isJoined !== false) {
          flat.push({ networkId: net.networkId, bufferName: buf.name });
        }
      }
    }
    return flat;
  }

  function switchToBuffer(networkId: string, bufferName: string): void {
    const isSameBuffer =
      ircState.activeBuffer.networkId === networkId &&
      ircState.activeBuffer.bufferName === normalizeChannelName(bufferName);
    setActiveBuffer(networkId, bufferName);
    requestSwitchBuffer(networkId, bufferName);
    updateRoute(networkId, bufferName);
    if (!isSameBuffer) {
      void loadBufferHistory(networkId, bufferName);
    }
  }

  async function loadBufferHistory(networkId: string, bufferName: string): Promise<void> {
    try {
      // On first load for a buffer, ask the gateway to push a
      // CHATHISTORY LATEST to the engine so the local buffer gets
      // backfilled from upstream. The response is whatever's already
      // in the local buffer at the time of read; a few hundred ms later
      // a subsequent load will see the freshly-persisted batch messages.
      const msgs = await loadHistory(networkId, bufferName, {
        count: 100,
        fetchFromUpstream: true,
        fetchCommand: 'LATEST',
      });
      // Only populate an empty buffer. If the buffer already has messages
      // (e.g. from a previous visit or websocket backfill) we must not
      // overwrite them, otherwise switching buffers mid-session can discard
      // already-loaded history and show fewer messages than a fresh page load.
      const key = `${networkId}:${normalizeChannelName(bufferName)}`;
      const existing = ircState.messages[key] ?? [];
      if (existing.length === 0) {
        setMessages(networkId, bufferName, msgs);
      }
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }

  function handleWsMessage(data: unknown): void {
    if (Array.isArray(data)) {
      for (const item of data) processEvent(item as Record<string, unknown>);
    } else {
      const obj = data as Record<string, unknown>;
      if (obj.type === 'sync') {
        updateNetworkFromSync((obj.networks || []) as Network[]);
        checkRoute();
      } else if (obj.type === 'irc_event' || obj.y === 'irc_event') {
        processEvent(obj);
      }
    }
  }

  function processEvent(data: Record<string, unknown>): void {
    const cmd = (data.command || data.c || '') as string;
    const networkName = (data.network || '') as string;
    const channel = normalizeChannelName((data.channel || data.ch || '_server') as string);

    const msg: IRCMessage = {
      id: ((data.id as string) || (data.i as string) || `w${++localMsgIdCounter}`) as string,
      timestamp: ((data.timestamp as string) || (data.t ? new Date(data.t as number).toISOString() : null)) as string,
      nick: ((data.nick as string) || (data.n as string) || '') as string,
      text: ((data.text as string) || (data.x as string) || '') as string,
      command: cmd,
      params: ((data.params as string[]) || (data.p as string[]) || []) as string[],
      prefix: ((data.prefix as string) || (data.px as string) || '') as string,
      msgid: ((data.msgid as string) || (data.m as string) || '') as string,
      label: ((data.label as string) || (data.l as string) || '') as string,
      t: data.t as number,
      type: data.type as string | undefined,
    };

    const net = ircState.networks.find(n => n.name === networkName);
    if (!net) return;
    const networkId = net.networkId;

    if (msg.nick && isIgnored(msg.nick)) return;

    if (/^3(11|312|313|317|319|330)$/.test(cmd)) {
      if (!whoisAcc || whoisAcc.nick !== msg.params?.[0]) {
        whoisAcc = { nick: msg.params?.[0] || '' };
      }
      accumulateWhois(cmd, msg.params || [], msg.text || '');
    } else if (cmd === '318') {
      if (whoisAcc) {
        ircState.overlay.type = 'whois';
        ircState.overlay.data = whoisAcc as WhoisData;
        whoisAcc = null;
      }
    }

    if (cmd === '367' && msg.params) {
      banAcc.push({
        mask: msg.params[1] || '',
        setBy: msg.params[2] || '',
        setAt: parseInt(msg.params[3] || '0', 10),
      });
      banTargetChannel = msg.params[0] || '';
    } else if (cmd === '368') {
      ircState.overlay.type = 'banlist';
      ircState.overlay.data = [...banAcc];
      banAcc = [];
      banTargetChannel = '';
    }

    handleConnect(cmd, networkId, msg.text);
    updateChannelUsers(networkId, channel, cmd, msg.nick || '', msg.params);

    if (cmd === '332' && msg.text) {
      updateChannelTopic(networkId, channel, msg.text);
    } else if (cmd === 'TOPIC' && msg.text) {
      updateChannelTopic(networkId, channel, msg.text);
    }

    if (cmd === 'PRIVMSG' && msg.nick) {
      const bufObj = net.buffers.find(b => b.name === channel);
      if (bufObj?.users) {
        const u = bufObj.users.find(x => stripPrefix(x.nick) === msg.nick);
        if (u) u.lastSpoke = msg.t ?? Date.now();
      }
    }

    if (!isSkippedCommand(cmd)) {
      appendMessage(networkId, channel, msg);
      trimMessagesIfNeeded(networkId, channel);

      if (msg.highlight && (ircState.activeBuffer.networkId !== networkId || ircState.activeBuffer.bufferName !== channel)) {
        notify({
          tag: `${networkId}:${channel}:${msg.msgid || msg.t}`,
          title: `${msg.nick} in ${channel}`,
          body: msg.text || '',
          onClick: () => switchToBuffer(networkId, channel),
        });
      }
    }
  }

  function accumulateWhois(cmd: string, params: string[], text: string): void {
    if (!whoisAcc) return;
    switch (cmd) {
      case '311':
        whoisAcc.nick = params[0];
        whoisAcc.user = params[1];
        whoisAcc.host = params[2];
        whoisAcc.realname = text;
        break;
      case '312':
        whoisAcc.server = params[1];
        whoisAcc.serverInfo = text;
        break;
      case '317':
        whoisAcc.idle = parseInt(params[1] || '0', 10);
        whoisAcc.signon = parseInt(params[2] || '0', 10);
        break;
      case '319':
        whoisAcc.channels = text.split(' ').filter(Boolean);
        break;
      case '330':
        whoisAcc.account = params[1];
        break;
    }
  }

  function checkRoute(): void {
    const path = window.location.pathname;
    const m = path.match(/^\/irc\/([^\/]+)(?:\/(channel|messages)\/([^\/]+))?\/?$/);
    if (!m) return;
    const netName = decodeURIComponent(m[1]);
    const type = m[2];
    const target = m[3] ? decodeURIComponent(m[3]) : '';
    const net = ircState.networks.find(n => n.name === netName || n.name.toLowerCase() === netName.toLowerCase());
    if (!net) return;
    let bufferName = '_server';
    if (type === 'channel') bufferName = target.startsWith('#') ? target : '#' + target;
    else if (type === 'messages') bufferName = target;
    switchToBuffer(net.networkId, bufferName);
  }

  function navigateToBuffer(networkId: string, bufferName: string): void {
    switchToBuffer(networkId, bufferName);
  }

  function handleNickClick(nick: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    userPopup = { nick, x: event.clientX, y: event.clientY };
  }

  function closeUserPopup(): void {
    userPopup = null;
  }

  function openChannelMenu(e?: MouseEvent): void {
    if (!e) {
      channelMenu = { x: 240, y: 80 };
      return;
    }
    const btn = e.currentTarget as HTMLElement | null;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      channelMenu = {
        x: rect.left + rect.width,
        y: rect.top + rect.height + 9,
      };
    } else {
      channelMenu = { x: e.clientX, y: e.clientY };
    }
  }
  function closeChannelMenu(): void {
    channelMenu = null;
  }
</script>

<NotificationBadge />

{#if ircState.contextMenu.visible}
  <ContextMenu />
{/if}

{#if userPopup}
  <UserPopup nick={userPopup.nick} x={userPopup.x} y={userPopup.y}
             onClose={closeUserPopup}
             onSwitchBuffer={navigateToBuffer} />
{/if}

{#if ircState.overlay.type}
  <Overlay />
{/if}

{#if showNetworkForm}
  <NetworkForm mode={networkFormMode} networkId={editNetworkId} onClose={() => showNetworkForm = false} />
{/if}

{#if showJoinModal}
  <JoinModal onClose={() => showJoinModal = false} />
{/if}

{#if channelMenu}
  {@const activeBuf = getActiveBufferObj()}
  {#if activeBuf}
    <ChannelContextMenu
      x={channelMenu.x}
      y={channelMenu.y}
      anchorRight={true}
      buf={activeBuf}
      onClose={closeChannelMenu}
      onToggleMembers={toggleMemberPanel}
      memberPanelOpen={memberPanelOpen}
    />
  {/if}
{/if}

<div id="wrap" class:has-members={hasMembers} class:members-collapsed={hasMembers && !memberPanelOpen}>
  <BufferHeader
    onAddNetwork={() => { networkFormMode = 'add'; editNetworkId = null; showNetworkForm = true; }}
    onEditNetwork={() => { networkFormMode = 'edit'; editNetworkId = ircState.activeBuffer.networkId; showNetworkForm = true; }}
    onJoinChannel={openChannelMenu}
    onToggleMembers={toggleMemberPanel}
    {memberPanelOpen}
  />
  <main class="chat-container" role="main">
    <ChatArea onNickClick={handleNickClick} />
  </main>
  {#if hasMembers}
    <aside id="member-sidebar" class="show">
      <MemberList onNickClick={handleNickClick} />
    </aside>
  {/if}
  <aside id="sidebar">
    <Sidebar onSwitchBuffer={navigateToBuffer}
             onAddNetwork={() => { networkFormMode = 'add'; showNetworkForm = true; }} />
  </aside>
</div>
