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
  import ServerLogContextMenu from './components/ServerLogContextMenu.svelte';
  import Overlay from './components/Overlay.svelte';
  import NotificationBadge from './components/NotificationBadge.svelte';
  import UserPopup from './components/UserPopup.svelte';
  import {
    ircState, getActiveNetwork, getActiveBufferObj,
    updateNetworkFromSync, handleConnect,
    updateChannelUsers, setMessages, prependMessages,
    setActiveBuffer, updateChannelTopic,
    appendMessage, batchAppendMessages
  } from './stores/ircStore.svelte';
  import { isIgnored } from './stores/preferences.svelte';
  import { connectWebSocket, requestSync, requestSwitchBuffer, disconnectWebSocket, wsState } from './stores/wsConnection.svelte.ts';
  import { loadHistory, fetchMe, updateMembersCollapsed } from './stores/api';
  import { normalizeChannelName, isSkippedCommand, stripPrefix } from './lib/utils';
  import DropTarget from './components/DropTarget.svelte';
  import UploadDialog from './components/UploadDialog.svelte';
  import UploadsPanel from './components/UploadsPanel.svelte';
  import SnippetsPanel from './components/SnippetsPanel.svelte';
  import { startUploads, confirmDialog, cancelDialog } from './stores/uploadFlow.svelte';
  import { uploadState } from './stores/uploadStore.svelte';
  import { notify } from './lib/notifications';
  import { membersCollapsedMap, archivedMap, hiddenChannelsMap, pinnedMap, suppressAnimations, globalPrefs } from './stores/preferences.svelte';
  import { loadCachedMessages } from './stores/ircStore.svelte';
  import { updateRoute, getSettingsTabFromUrl, isSettingsUrl, navigateBackFromSettings } from './lib/routing';
  import { processIrcEvent, type AccumState } from './lib/messageHandler';
  import { enqueueMessage, setFlushFn } from './lib/messageBatcher';
  import WelcomePage from './components/WelcomePage.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import type { IRCMessage, Network, WhoisData, BanEntry, BanListData, Member } from './types';

  let showNetworkForm: boolean = $state(false);
  let showJoinModal: boolean = $state(false);
  let networkFormMode: 'add' | 'edit' = $state('add');
  let localMsgIdCounter = 0;
  let editNetworkId: string | null = $state(null);
  let channelMenu: { x: number; y: number } | null = $state(null);

  let userPopup: { nick: string; member?: Member | null; x: number; y: number } | null = $state(null);

  let whoisAcc: Partial<WhoisData> | null = null;
  let banAcc: BanEntry[] = [];
  let banTargetChannel = '';
  let locallyInitiated = false;
  const accum: AccumState = {
    get whoisAcc() { return whoisAcc; },
    set whoisAcc(v) { whoisAcc = v as Partial<WhoisData> | null; },
    get banAcc() { return banAcc; },
    set banAcc(v: BanEntry[]) { banAcc = v; },
    get banTargetChannel() { return banTargetChannel; },
    set banTargetChannel(v: string) { banTargetChannel = v; },
  };

  let hasMembers = $derived(
    ircState.activeBuffer.bufferName !== null &&
    ircState.activeBuffer.bufferName !== '_server' &&
    getActiveBufferObj()?.type === 'channel' &&
    getActiveBufferObj()?.isJoined !== false
  );

  // $derived (not local $state) so it reactively tracks both the active
  // buffer AND any update to membersCollapsedMap (including those coming
  // from the cross-tab storage event handler).
  const memberPanelOpen = $derived(
    !membersCollapsedMap[`${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`]
  );

  // Narrow-screen (mobile) drawer state, IRCCloud-style: the buffer
  // sidebar and member list become slide-over drawers. Ephemeral and
  // never persisted, unlike membersCollapsedMap — a phone toggling the
  // member overlay must not collapse the panel on a desktop session.
  let isNarrow = $state(false);
  let sidebarDrawerOpen = $state(false);
  let mobileMembersOpen = $state(false);

  $effect(() => {
    const mq = window.matchMedia('(max-width: 800px)');
    const apply = () => {
      isNarrow = mq.matches;
      if (!mq.matches) {
        sidebarDrawerOpen = false;
        mobileMembersOpen = false;
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  });

  function closeDrawers(): void {
    sidebarDrawerOpen = false;
    mobileMembersOpen = false;
  }

  function toggleMemberPanel(): void {
    if (isNarrow) {
      mobileMembersOpen = !mobileMembersOpen;
      return;
    }
    const key = `${ircState.activeBuffer.networkId}:${ircState.activeBuffer.bufferName}`;
    const next = !membersCollapsedMap[key];
    membersCollapsedMap[key] = next;
    locallyInitiated = true;
    updateMembersCollapsed(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName, next)
      .catch((err) => console.error('Failed to sync members collapsed:', err));
  }

  $effect(() => {
    if (ircState.showSettings) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName) updateRoute(networkId, bufferName);
  });

  // Auto-select first network's server buffer when networks exist but none is active
  $effect(() => {
    if (ircState.showSettings) return;
    if (!ircState.activeBuffer.networkId && !ircState.activeBuffer.bufferName && ircState.networks.length > 0) {
      const firstNet = ircState.networks[0];
      if (firstNet) {
        setActiveBuffer(firstNet.networkId, '_server');
        updateRoute(firstNet.networkId, '_server');
      }
    }
  });

  // Apply global settings to the DOM
  $effect(() => {
    const app = document.getElementById('app');
    if (!app) return;
    const val = globalPrefs;

    // Font size
    app.style.fontSize = val.fontSize + 'px';

    // Monospace font
    app.classList.toggle('font-mono', val.monospaceFont);

    // Compact mode
    app.classList.toggle('compact', val.compactMode || val.messageLayout === 'compact');

    // Sidebar left
    app.classList.toggle('sidebar-left', val.sidebarLeft);

    // Theme
    app.classList.remove('midnight-theme');
    if (val.theme === 'midnight') app.classList.add('midnight-theme');
  });

  // Inject custom CSS
  $effect(() => {
    const css = globalPrefs.customCSS;
    let el = document.getElementById('custom-settings-css');
    if (css) {
      if (!el) {
        el = document.createElement('style');
        el.id = 'custom-settings-css';
        document.head.appendChild(el);
      }
      el.textContent = css;
    } else {
      if (el) el.remove();
    }
  });

  let syncInterval: ReturnType<typeof setInterval>;

  onMount(async () => {
    // Set up IRCCloud-style message batcher (200ms flush)
    setFlushFn((networkId, bufferName, msgs) => {
      // IRCCloud batchAppend: push all messages into the state in a single
      // reactive update so Svelte only triggers one render pass per flush
      // instead of one per message.
      batchAppendMessages(networkId, bufferName, msgs);
    });
    try {
      const user = await fetchMe();
      ircState.me = user;
      // Merge server-side pins into local pinnedMap so cross-device
      // pin state is picked up on page load. Keys explicitly unpinned
      // (set to false) are not overridden. Stale true values that are
      // no longer on the server are removed so unpinning persists.
      if (user.pinnedChannels) {
        for (const key of Object.keys(pinnedMap)) {
          if (pinnedMap[key] === true && !user.pinnedChannels.includes(key)) {
            delete pinnedMap[key];
          }
        }
        for (const key of user.pinnedChannels) {
          if (pinnedMap[key] !== false) {
            pinnedMap[key] = true;
          }
        }
      }
      if (user.archivedChannels) {
        for (const key of Object.keys(archivedMap)) {
          if (archivedMap[key] === true && !user.archivedChannels.includes(key)) {
            delete archivedMap[key];
          }
        }
        for (const key of user.archivedChannels) {
          if (archivedMap[key] !== false) {
            archivedMap[key] = true;
          }
        }
      }
      if (user.membersCollapsed) {
        for (const key of Object.keys(membersCollapsedMap)) {
          if (!(key in user.membersCollapsed)) delete membersCollapsedMap[key];
        }
        for (const [key, value] of Object.entries(user.membersCollapsed)) {
          if (value === true) membersCollapsedMap[key] = true;
        }
      }
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
      if (ircState.showSettings) {
        ircState.showSettings = false;
        navigateBackFromSettings();
        return;
      }
      if (ircState.overlay.type) { ircState.overlay.type = null; ircState.overlay.data = null; }
      if (ircState.contextMenu.visible) { ircState.contextMenu.visible = false; }
      if (showNetworkForm) { showNetworkForm = false; }
      if (showJoinModal) { showJoinModal = false; }
      if (uploadState.dialog) { cancelDialog(); }
      if (uploadState.panelOpen) { uploadState.panelOpen = false; }
      if (uploadState.pastebinPanelOpen) { uploadState.pastebinPanelOpen = false; }
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
      const key = `${networkId}:${normalizeChannelName(bufferName)}`;
      const existing = ircState.messages[key] ?? [];
      // Show cached messages immediately while we fetch fresh data
      let cached: IRCMessage[] | null = null;
      if (existing.length === 0) {
        cached = loadCachedMessages(networkId, bufferName);
        if (cached && cached.length > 0) {
          setMessages(networkId, bufferName, cached);
        }
      }
      // On first load for a buffer, ask the gateway to push a
      // CHATHISTORY LATEST to the engine so the local buffer gets
      // backfilled from upstream. The response is whatever's already
      // in the local buffer at the time of read; a few hundred ms later
      // a subsequent load will see the freshly-persisted batch messages.
      const msgs = await loadHistory(networkId, bufferName, {
        // IRCCloud renders the last batchSize=200 messages on buffer open
        // (BufferLogView.render → messages.last(this.scroll.batchSize)).
        count: 200,
        fetchFromUpstream: true,
        fetchCommand: 'LATEST',
      });
      // Overwrite only if the buffer was empty or still pointing at cache
      if (existing.length === 0 || ircState.messages[key] === cached) {
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
        selectLastActiveBuffer((obj.networks || []) as Network[]);
      } else if (obj.type === 'irc_event' || obj.y === 'irc_event') {
        processEvent(obj);
      } else if (obj.type === 'pref_update') {
        handlePrefUpdate(obj);
      }
    }
  }

  function handlePrefUpdate(data: Record<string, unknown>): void {
    const key = data.key as string;
    if (key === 'pinned') {
      const channels = (data.value as string[]) ?? [];
      // Sync server-side pins into local pinnedMap. Stale true values
      // that are no longer on the server are removed so unpinning
      // propagates to all connected tabs/devices in real time.
      for (const k of Object.keys(pinnedMap)) {
        if (pinnedMap[k] === true && !channels.includes(k)) {
          delete pinnedMap[k];
        }
      }
      for (const k of channels) {
        if (pinnedMap[k] !== false) {
          pinnedMap[k] = true;
        }
      }
    } else if (key === 'archived') {
      const channels = (data.value as string[]) ?? [];
      // Same real-time sync pattern as pinned channels.
      for (const k of Object.keys(archivedMap)) {
        if (archivedMap[k] === true && !channels.includes(k)) {
          delete archivedMap[k];
        }
      }
      for (const k of channels) {
        if (archivedMap[k] !== false) {
          archivedMap[k] = true;
        }
      }
    } else if (key === 'membersCollapsed') {
      if (!locallyInitiated) {
        suppressAnimations();
      }
      locallyInitiated = false;
      const collapsed = (data.value as Record<string, boolean>) ?? {};
      for (const k of Object.keys(membersCollapsedMap)) {
        if (!(k in collapsed)) delete membersCollapsedMap[k];
      }
      for (const [k, v] of Object.entries(collapsed)) {
        if (v === true) membersCollapsedMap[k] = true;
      }
    }
  }

  function processEvent(data: Record<string, unknown>): void {
    const counter = { value: localMsgIdCounter };
    const result = processIrcEvent(data, counter, accum, { switchToBuffer }, enqueueMessage);
    localMsgIdCounter = counter.value;
    if (result.whoisData) {
      ircState.overlay.type = 'whois';
      ircState.overlay.data = result.whoisData as WhoisData;
    }
    if (result.banListData) {
      ircState.overlay.type = 'banlist';
      ircState.overlay.data = result.banListData as BanListData;
    }
  }

  function checkRoute(): void {
    const path = window.location.pathname;
    const settingsTab = getSettingsTabFromUrl();
    if (settingsTab) {
      ircState.showSettings = true;
      ircState.settingsTab = settingsTab;
      return;
    }
    ircState.showSettings = false;
    const m = path.match(/^\/irc\/([^\/]+)(?:\/(channel|messages)\/([^\/]+))?\/?$/);
    if (!m) return;
    const netName = decodeURIComponent(m[1]);
    const type = m[2];
    const target = m[3] ? decodeURIComponent(m[3]) : '';
    const net = ircState.networks.find(n => n.name === netName || n.name.toLowerCase() === netName.toLowerCase());
    if (!net) {
      // Networks may still be loading from the initial sync. If we have
      // no networks yet, leave the URL alone so the sync handler's
      // checkRoute can pick it up once the network arrives. Only redirect
      // when we have networks but the requested one is genuinely missing
      // (e.g. the network was deleted).
      if (ircState.networks.length > 0) {
        window.history.replaceState({}, '', '/');
        document.cookie = 'lastVisited=; path=/; expires=Thu, 01 Jan 1971 00:00:00 GMT';
      }
      return;
    }
    let bufferName = '_server';
    if (type === 'channel') bufferName = target.startsWith('#') ? target : '#' + target;
    else if (type === 'messages') bufferName = target;
    switchToBuffer(net.networkId, bufferName);
  }

  function selectLastActiveBuffer(syncNetworks: Network[]): void {
    if (ircState.showSettings) return;
    if (ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName) return;
    for (const net of syncNetworks) {
      if (!net.connected) continue;
      const lastBuf = net.lastActiveBuffer;
      if (lastBuf) {
        const key = `${net.networkId}:${lastBuf}`;
        const bufExists = net.buffers.some(b => b.name === lastBuf) && !archivedMap[key] && !hiddenChannelsMap[key];
        if (bufExists) {
          setActiveBuffer(net.networkId, lastBuf);
          requestSwitchBuffer(net.networkId, lastBuf);
          void loadBufferHistory(net.networkId, lastBuf);
          return;
        }
      }
      setActiveBuffer(net.networkId, '_server');
      requestSwitchBuffer(net.networkId, '_server');
      void loadBufferHistory(net.networkId, '_server');
      return;
    }
  }

  function navigateToBuffer(networkId: string, bufferName: string): void {
    switchToBuffer(networkId, bufferName);
    closeDrawers();
  }

  function handleNickClick(nick: string, event: MouseEvent, member?: Member | null): void {
    event.preventDefault();
    event.stopPropagation();
    userPopup = { nick, member: member ?? null, x: event.clientX, y: event.clientY };
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
  function openNetworkOptions(networkId: string, e: MouseEvent): void {
    navigateToBuffer(networkId, '_server');
    openChannelMenu(e);
  }
  function closeChannelMenu(): void {
    channelMenu = null;
  }
</script>

<NotificationBadge />

<DropTarget onFilesDropped={(result, opts) => startUploads(result.accepted, { networkId: ircState.activeBuffer.networkId ?? '', buffer: ircState.activeBuffer.bufferName ?? '', immediate: opts.immediate })} />

{#if ircState.contextMenu.visible}
  <ContextMenu />
{/if}

{#if userPopup}
  <UserPopup nick={userPopup.nick} member={userPopup.member} x={userPopup.x} y={userPopup.y}
             onClose={closeUserPopup}
             onSwitchBuffer={navigateToBuffer} />
{/if}

{#if ircState.overlay.type}
  <Overlay />
{/if}

{#if showNetworkForm}
  <div class="overlay-backdrop" onclick={() => showNetworkForm = false} role="presentation"></div>
  <div class="overlay-panel centered network-form-panel" role="dialog" aria-modal="true"
       aria-label={networkFormMode === 'add' ? 'Join a new network' : 'Edit network'}>
    <button class="overlay-close" onclick={() => showNetworkForm = false} aria-label="Close">&times;</button>
    <NetworkForm mode={networkFormMode} networkId={editNetworkId} onClose={() => showNetworkForm = false} />
  </div>
{/if}

{#if showJoinModal}
  <div class="overlay-backdrop" onclick={() => showJoinModal = false} role="presentation"></div>
  <div class="overlay-panel centered" role="dialog" aria-modal="true" aria-label="Join a channel">
    <JoinModal onClose={() => showJoinModal = false} />
  </div>
{/if}

{#if uploadState.dialog}
  <UploadDialog
    onConfirm={(data) => confirmDialog(data)}
    onCancel={() => cancelDialog()} />
{/if}

{#if channelMenu}
  {@const activeBuf = getActiveBufferObj()}
  {#if activeBuf}
    {#if activeBuf.name === '_server'}
      <ServerLogContextMenu
        x={channelMenu.x}
        y={channelMenu.y}
        anchorRight={true}
        buf={activeBuf}
        onClose={closeChannelMenu}
        onJoinChannel={() => { closeChannelMenu(); showJoinModal = true; }}
        onEditNetwork={() => { closeChannelMenu(); networkFormMode = 'edit'; editNetworkId = ircState.activeBuffer.networkId; showNetworkForm = true; }}
      />
    {:else}
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
{/if}

<div id="wrap" class:has-members={hasMembers && !ircState.showSettings} class:members-collapsed={hasMembers && !memberPanelOpen && !ircState.showSettings} class:sidebar-open={sidebarDrawerOpen} class:mobile-members-open={mobileMembersOpen}>
  <div class="main-area">
    {#if ircState.showSettings}
      <SettingsPage />
    {:else if ircState.networks.length === 0}
      <WelcomePage />
    {:else}
      <BufferHeader
        onAddNetwork={() => { networkFormMode = 'add'; editNetworkId = null; showNetworkForm = true; }}
        onEditNetwork={() => { networkFormMode = 'edit'; editNetworkId = ircState.activeBuffer.networkId; showNetworkForm = true; }}
        onJoinChannel={openChannelMenu}
        onToggleMembers={toggleMemberPanel}
        onToggleSidebar={() => sidebarDrawerOpen = !sidebarDrawerOpen}
        memberPanelOpen={isNarrow ? mobileMembersOpen : memberPanelOpen}
      />
      <div class="content-row">
        <main class="chat-container" role="main">
          <ChatArea onNickClick={handleNickClick} />
        </main>
        {#if hasMembers}
          <aside id="member-sidebar" class="show">
            <MemberList onNickClick={handleNickClick} />
          </aside>
        {/if}
      </div>
    {/if}
    {#if uploadState.panelOpen && !ircState.showSettings && ircState.networks.length > 0}
      <UploadsPanel onClose={() => uploadState.panelOpen = false} />
    {/if}
    {#if uploadState.pastebinPanelOpen && !ircState.showSettings && ircState.networks.length > 0}
      <SnippetsPanel onClose={() => uploadState.pastebinPanelOpen = false} />
    {/if}
  </div>
  {#if isNarrow && (sidebarDrawerOpen || mobileMembersOpen)}
    <div class="drawer-backdrop" onclick={closeDrawers} role="presentation"></div>
  {/if}
  <aside id="sidebar">
    <Sidebar onSwitchBuffer={navigateToBuffer}
             onAddNetwork={() => { networkFormMode = 'add'; showNetworkForm = true; }}
             onNetworkOptions={openNetworkOptions}
             onJoinChannel={(networkId) => { showJoinModal = true; }} />
  </aside>
</div>
