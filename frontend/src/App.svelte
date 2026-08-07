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
    applyIsupportUpdate,
    updateChannelUsers, setMessages, prependMessages,
    setActiveBuffer, updateChannelTopic,
    appendMessage, batchAppendMessages,
    handleBuffersToDelete,
    isJoinPending, initiateRejoin,
    resetPendingState,
    isUserDisconnected
  } from './stores/ircStore.svelte';
  import { isIgnored } from './stores/preferences.svelte';
  import { connectWebSocket, requestSync, requestSwitchBuffer, disconnectWebSocket, sendJson, wsState } from './stores/wsConnection.svelte.ts';
  import { loadHistory, updateMembersCollapsed } from './stores/api';
  import { normalizeChannelName, isSkippedCommand, stripPrefix } from './lib/utils';
  import DropTarget from './components/DropTarget.svelte';
  import UploadDialog from './components/UploadDialog.svelte';
  import UploadsPanel from './components/UploadsPanel.svelte';
  import SnippetsPanel from './components/SnippetsPanel.svelte';
  import { startUploads, confirmDialog, cancelDialog } from './stores/uploadFlow.svelte';
  import { uploadState } from './stores/uploadStore.svelte';
  import { notify } from './lib/notifications';
  import { startOnlineChecker } from './lib/onlineChecker';
  import { serverlogCollapsedMap, membersCollapsedMap, collapsedMap, archivedMap, hiddenChannelsMap, pinnedMap, inactiveCollapsedMap, networkOrder, suppressAnimations, globalPrefs, setFocusSeen, setLastSeen, bufferPrefsMap, conversationsCollapsedMap, lastSeenMap } from './stores/preferences.svelte';
  import { loadCachedMessages } from './stores/ircStore.svelte';
  import { updateRoute, getSettingsTabFromUrl, isSettingsUrl, navigateBackFromSettings, isShortcutsUrl, navigateBackFromShortcuts } from './lib/routing';
  import { processIrcEvent, type AccumState } from './lib/messageHandler';
  import { enqueueMessage, setFlushFn } from './lib/messageBatcher';
import WelcomePage from './components/WelcomePage.svelte';
import SettingsPage from './components/SettingsPage.svelte';
import ShortcutsPage from './components/ShortcutsPage.svelte';
import ChannelSwitcher from './components/ChannelSwitcher.svelte';
import LoadingSkeleton from './components/LoadingSkeleton.svelte';
import LoginPage from './components/LoginPage.svelte';
import type { IRCMessage, Network, WhoisData, BanEntry, BanListData, Member, ConnectionState } from './types';

// IRCCloud-style: cache network IDs + names so we can eager-load message
// history from the URL before the WebSocket opens.  Stored as an array of
// { networkId, name } pairs — updated after every successful sync.
interface CachedNetwork { networkId: string; name: string; }
const NETWORK_CACHE_KEY = 'ircfiber:networkcache';
function readCachedNetworks(): CachedNetwork[] {
  try {
    const raw = localStorage.getItem(NETWORK_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function writeCachedNetworks(networks: { networkId: string; name: string }[]): void {
  const data = networks.map(n => ({ networkId: n.networkId, name: n.name }));
  try { localStorage.setItem(NETWORK_CACHE_KEY, JSON.stringify(data)); } catch {}
}

// Read once at module load — synchronous localStorage, < 0.1 ms.
const cachedNetworks: CachedNetwork[] = readCachedNetworks();
const cachedNetworkNames: string[] = cachedNetworks.map(n => n.name);
const hasCachedNetworks: boolean = cachedNetworks.length > 0;

// Since the sync WS message now includes message history in the buffer
// objects (server reads from Redis scrollback), we no longer need a
// separate REST API call at module init.  backlogReady flips to true when
// sync arrives (which includes the history), eliminating the 3.5s REST
// round-trip that previously gated the spinner.
//
// We still track which networkId the URL targets so we can pre-route
// immediately when networks/sync arrive (avoiding the brief UI flicker).
let preloadNetId: string | null = null;
let preloadBufName: string | null = null;
if (hasCachedNetworks) {
  const path = window.location.pathname;
  const m = path.match(/^\/irc\/([^\/]+)(?:\/(?:channel|messages)\/([^\/]+))?\/?$/);
  if (m) {
    const cached = cachedNetworks.find(n => n.name === m[1]);
    if (cached) {
      preloadNetId = cached.networkId;
      preloadBufName = m[2] || '_server';
    }
  }
}

// Tracks whether the first sync has been received.  Used to fall back to
// WelcomePage when the cache says "yes networks" but the server says
// "no networks" (networks deleted on another device, account reset, etc.).
let syncReceived: boolean = $state(false);

// IRCCloud backlog_complete equivalent: set to true when the message
// history REST call resolves (either from the eager preload above or
// from loadBufferHistory during boot).  The .mainSpin spinner stays
// visible until BOTH syncReceived AND backlogReady are true, matching
// IRCCloud's pattern where doneLoading() fires only after all backlog
// is processed.
let backlogReady: boolean = $state(!preloadNetId);  // false if preload pending

// IRCCloud loading guard: true while the boot spinner should be visible.
// Matches IRCCloud's doneLoading() — the spinner stays until the state
// sync (syncReceived) AND message backlog (backlogReady) are both done.
const isBootLoading: boolean = $derived(
  (ircState.networks.length === 0 && hasCachedNetworks && !syncReceived) ||
  (ircState.networks.length > 0 && (!syncReceived || !backlogReady))
);

let showNetworkForm: boolean = $state(false);
  let showJoinModal: boolean = $state(false);
  let channelSwitcherOpen: boolean = $state(false);
  let networkFormMode: 'add' | 'edit' = $state('add');
  let localMsgIdCounter = 0;
  let editNetworkId: string | null = $state(null);
  let channelMenu: { x: number; y: number } | null = $state(null);

  let userPopup: { nick: string; member?: Member | null; x: number; y: number } | null = $state(null);

  let whoisAcc: Partial<WhoisData> | null = null;
  let whoisAccs: Map<string, Partial<WhoisData>> = new Map();
  let banAcc: BanEntry[] = [];
  let banTargetChannel = '';
  let locallyInitiated = false;
  const accum: AccumState = {
    get whoisAcc() { return whoisAcc; },
    set whoisAcc(v) { whoisAcc = v as Partial<WhoisData> | null; },
    get whoisAccs() { return whoisAccs; },
    set whoisAccs(v) { whoisAccs = v as Map<string, Partial<WhoisData>>; },
    get banAcc() { return banAcc; },
    set banAcc(v: BanEntry[]) { banAcc = v; },
    get banTargetChannel() { return banTargetChannel; },
    set banTargetChannel(v: string) { banTargetChannel = v; },
  };

  let hasMembers = $derived(
    ircState.activeBuffer.bufferName !== null &&
    ircState.activeBuffer.bufferName !== '_server' &&
    getActiveBufferObj()?.type === 'channel' &&
    getActiveBufferObj()?.isJoined === true
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
    updateMembersCollapsed(ircState.activeBuffer.networkId!, ircState.activeBuffer.bufferName!, next)
      .catch((err) => console.error('Failed to sync members collapsed:', err));
  }

  $effect(() => {
    if (ircState.showSettings || ircState.showShortcuts) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName) updateRoute(networkId, bufferName);
  });

  // Auto-select first network's server buffer when networks exist but none is active
  $effect(() => {
    if (ircState.showSettings || ircState.showShortcuts) return;
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
    app.classList.remove('midnight-theme', 'theme-midnight', 'theme-dusk', 'theme-tropic', 'theme-emerald', 'theme-sand', 'theme-orchid');
    if (val.theme === 'midnight') {
      app.classList.add('midnight-theme', 'theme-midnight');
    } else if (val.theme !== 'dark') {
      app.classList.add('theme-' + val.theme);
    }
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

  // IRCCloud-style body CSS class transitions — mirror the classes IRCCloud
  // uses to control visibility of the loading spinner and status bar.
  // - 'connecting' : WebSocket has not yet opened
  // - 'loading'    : WS open but no networks data received yet
  // - 'init'       : networks loaded, UI is interactive
  $effect(() => {
    const body = document.body;
    body.classList.remove('connecting', 'loading', 'init');
    if (!ircState.wsConnected) {
      body.classList.add('connecting');
    } else if (ircState.networks.length === 0) {
      body.classList.add('loading');
    } else {
      body.classList.add('init');
      performance.mark('ui-visible');
    }
  });

  let syncInterval: ReturnType<typeof setInterval>;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  // Heartbeat timer lifecycle: start/stop based on feature flag + WS state.
  // Runs as a $effect so toggling the flag mid-session restarts the timer.
  $effect(() => {
    if (globalPrefs.featureFlags.heartbeat.enabled && ircState.wsConnected) {
      startHeartbeatTimer();
    } else {
      stopHeartbeatTimer();
    }
  });

  // ── Authentication gate ────────────────────────────────────────
  // IRCCloud boots the SPA unconditionally and overlays a centered
  // login modal (#noAuth) on top of the chat shell whenever the
  // session is missing. We mirror that here: probe /api/me at boot,
  // and if it returns 401 we render the chat UI behind the LoginPage
  // overlay and defer the WebSocket connection until sign-in succeeds.
  //
  // Tri-state:
  //   null  → still probing (initial bootstrap)
  //   true  → authenticated, normal flow
  //   false → not authenticated, LoginPage overlay shown
  let isAuthenticated: boolean | null = $state(null);

  function startHeartbeatTimer(): void {
    if (!globalPrefs.featureFlags.heartbeat.enabled) return;
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const seenEids: Record<string, Record<string, number>> = {};
      for (const [key, ts] of Object.entries(lastSeenMap)) {
        const [networkId, ...bufParts] = key.split(':');
        const bufferName = bufParts.join(':');
        if (!networkId || !bufferName) continue;
        if (!seenEids[networkId]) seenEids[networkId] = {};
        seenEids[networkId][bufferName] = ts;
      }
      sendJson({ type: 'heartbeat', seenEids });
    }, 10000);
  }

  function stopHeartbeatTimer(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  function startWebSocket(): void {
    performance.mark('ws-connect-start');
    connectWebSocket(
      handleWsMessage,
      () => {
        // W7-T01: clear stale in-flight JOIN state from the previous
        // WS session so that (a) pendingJoins doesn't block fresh
        // auto-joins via maybeAutoJoinChannel, and (b) stuck
        // joinInFlight/pendingIsJoined flags don't prevent the sync
        // from correcting isJoined on orphan channels.
        resetPendingState();
        ircState.wsConnected = true;
        performance.mark('ws-open');
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(requestSync, 10000);
        startHeartbeatTimer();
      },
      () => {
        ircState.wsConnected = false;
        stopHeartbeatTimer();
      }
    );
  }

  async function probeAuth(): Promise<boolean> {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      return r.ok;
    } catch {
      return false;
    }
  }

  async function checkAuth(): Promise<void> {
    const ok = await probeAuth();
    isAuthenticated = ok;
    if (ok) {
      startWebSocket();
    } else {
      // Don't open a WebSocket for an unauthenticated visitor — the
      // server would reject with 1008 anyway, but skipping avoids an
      // immediate reconnect storm and console noise.
      ircState.wsConnected = false;
    }
  }

  function handleAuthenticated(): void {
    // LoginPage just completed a successful sign-in / sign-up. Flip
    // the gate, kick off the WebSocket, and let the existing boot
    // path take over (handleWsMessage → handleStatUser / networks /
    // sync → selectLastActiveBuffer → first paint).
    isAuthenticated = true;
    startWebSocket();
  }

  onMount(() => {
    // Set up IRCCloud-style message batcher (200ms flush)
    setFlushFn((networkId, bufferName, msgs) => {
      batchAppendMessages(networkId, bufferName, msgs);
    });

    startOnlineChecker();
    window.addEventListener('popstate', checkRoute);
    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('keydown', handleGlobalKeyboard);
    document.addEventListener('click', handleDocumentClick);

    // Defer the WS connection until we know whether the visitor has a
    // valid session. /api/me is a single HTTP round-trip and runs in
    // parallel with the rest of the SPA boot.
    void checkAuth();

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
      // IRCCloud-style: track the last visible message when the tab
      // regains focus so unread counts can be computed from this point.
      const nid = ircState.activeBuffer.networkId;
      const buf = ircState.activeBuffer.bufferName;
      if (nid && buf) {
        const list = ircState.messages[`${nid}:${buf}`] ?? [];
        if (list.length > 0) {
          setFocusSeen(nid, buf, list[list.length - 1].t ?? Date.now());
        }
      }
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
    // Cmd/Ctrl+Shift+K - quick-switch channel
    // Svelte 5's compiler strips parens around `||` inside `&&` chains,
    // which would turn `(a||b) && c && d` into `a || b && c && d` (wrong
    // precedence). Bind the modifier check to a const first so the emitted
    // JS preserves grouping.
    const cmdOrCtrl = e.metaKey || e.ctrlKey;
    if (cmdOrCtrl && e.shiftKey && e.key === 'k') {
      e.preventDefault();
      channelSwitcherOpen = true;
      return;
    }
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      if (!target || (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA' && target.isContentEditable !== true)) {
        e.preventDefault();
        ircState.showShortcuts = true;
        history.pushState({ shortcuts: true }, '', '/?/shortcuts');
      }
    }
    if (e.key === 'Escape') {
      if (channelSwitcherOpen) {
        channelSwitcherOpen = false;
        return;
      }
      if (ircState.showSettings) {
        ircState.showSettings = false;
        navigateBackFromSettings();
        return;
      }
      if (ircState.showShortcuts) {
        ircState.showShortcuts = false;
        navigateBackFromShortcuts();
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
    setLastSeen(networkId, bufferName, Date.now());
    maybeAutoJoinChannel(networkId, bufferName);
    if (!isSameBuffer) {
      // IRCCloud-style: skip the REST round-trip during boot — the sync
      // message will deliver messages via WebSocket.  After sync arrives
      // (or for explicit user-initiated switches), loadBufferHistory
      // will only fetch if messages are missing.
      if (syncReceived) {
        void loadBufferHistory(networkId, bufferName);
      }
    }
  }

  // W7-T01: when the user navigates to a channel URL (or picks an inactive
  // channel from the sidebar) that they're not currently joined to, issue a
  // JOIN automatically. Improves on IRCCloud (which never auto-joins from
  // URL nav — users have to click "Join") by closing the gap between
  // "I navigated here" and "I'm actually in the room".
  //
  // Skip for:
  //   - non-channel buffers (DMs, server log) — no IRC JOIN concept
  //   - already-joined channels — no work to do
  //   - disconnected networks — engine can't join yet; the user will see
  //     the Rejoin button once reconnect happens
  //   - already-pending joins — dedup via pendingJoins Set so re-renders
  //     (selectLastActiveBuffer firing repeatedly, etc.) don't spam JOIN
  function maybeAutoJoinChannel(networkId: string, bufferName: string): void {
    if (!bufferName || !bufferName.startsWith('#')) return;
    const normalized = normalizeChannelName(bufferName);
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (!net) return;
    const buf = net.buffers.find(b => b.name === normalized);
    // Already joined — nothing to do.
    if (buf && buf.isJoined === true && buf.joinError == null) return;
    // Network not connected — JOIN would fail. Leave as-is; the user can
    // hit Rejoin once the network reconnects.
    if (!net.connected) return;
    // Dedup: if a JOIN is already in-flight for this buffer, don't re-send.
    if (isJoinPending(networkId, normalized)) return;

    // W1-T01: delegate to the canonical rejoin helper. allowReconnect=false
    // — URL nav must NOT kick reconnectNetwork() (would race the engine's
    // connection-recovery paths). The helper sets the full state-machine
    // quartet, calls markJoinPending+recordJoin, pre-populates self-nick, and
    // sends JOIN. The isJoinPending guard above prevents double-issuance.
    initiateRejoin(networkId, normalized, { allowReconnect: false });
  }

  async function loadBufferHistory(networkId: string, bufferName: string): Promise<void> {
    try {
      const key = `${networkId}:${normalizeChannelName(bufferName)}`;
      const existing = ircState.messages[key] ?? [];
      const isServerLog = bufferName === '_server';
      // IRCCloud-style: if sync already delivered messages for this buffer,
      // skip the REST round-trip entirely — EXCEPT for the _server buffer
      // where the sync only includes the latest 50 messages, which causes
      // MOTD, welcome, and connection-phase events to disappear on refresh.
      // The REST API returns up to 200 messages with the full history.
      if (existing.length > 0 && !isServerLog) {
        // Messages already loaded from sync — nothing more to fetch.
        return;
      }
      // Show cached messages immediately while we fetch fresh data
      let cached: IRCMessage[] | null = null;
      cached = loadCachedMessages(networkId, bufferName);
      if (cached && cached.length > 0) {
        setMessages(networkId, bufferName, cached);
      }
      // Cold start: fetch from REST.  This shouldn't normally happen since
      // sync includes scrollback, but covers the case where the user opens
      // a channel that wasn't in the sync (e.g. mid-session join).
      performance.mark('history-api-start');
      const msgs = await loadHistory(networkId, bufferName, {
        // IRCCloud renders the last batchSize=200 messages on buffer open
        // (BufferLogView.render → messages.last(this.scroll.batchSize)).
        count: 200,
        fetchFromUpstream: false,
        fetchCommand: 'LATEST',
      });
      performance.mark('history-api-end');
      if (isServerLog && existing.length > 0) {
        // Merge REST history with existing sync messages.  The sync provides
        // the most recent 50 messages; the REST provides up to 200.  Merge
        // older history before the sync snapshot, deduping by eid so recent
        // live events (arrived via batchAppendMessages while the REST call
        // was in flight) are not overwritten.
        prependMessages(networkId, bufferName, msgs);
      } else if (existing.length === 0 || ircState.messages[key] === cached) {
        setMessages(networkId, bufferName, msgs);
      }
      backlogReady = true;  // IRCCloud backlog_complete equivalent
      performance.mark('backlog-ready');
    } catch (e) {
      console.error('Failed to load history:', e);
    }
  }

  function handleWsMessage(data: unknown): void {
    if (Array.isArray(data)) {
      for (const item of data) processEvent(item as Record<string, unknown>);
    } else {
      const obj = data as Record<string, unknown>;
      if (obj.type === 'stat_user') {
        // IRCCloud-style: user data arrives via WebSocket, no REST /api/me needed
        handleStatUser(obj);
      } else if (obj.type === 'networks') {
        // IRCCloud-style: lightweight network list (names + IDs) sent before
        // the full state dump — populates sidebar instantly with real names
        handleNetworks(obj);
      } else if (obj.type === 'sync') {
        const isBootSync = (obj.cmd === undefined);
        performance.mark(isBootSync ? 'sync-boot' : 'sync-poll');
        // Dismiss the spinner immediately — the sync JSON has already
        // been received and parsed, so `updateNetworkFromSync` runs
        // synchronously below (typically < 50ms for small users).
        // Hiding the spinner now makes the connection feel instant;
        // the sidebar populates from `handleNetworks`'s skeletons in
        // the same tick. IRCCloud does the same: spinner → UI yields
        // as soon as the sync payload arrives, before processing.
        if (isBootSync) {
          backlogReady = true;
          performance.mark('backlog-ready');
        }
        syncReceived = true;
        updateNetworkFromSync((obj.networks || []) as Network[]);
        // IRCCloud-style: persist the network names so the next page load
        // skips the WelcomePage and renders a loading skeleton with real
        // network names while the WebSocket sync fills in fresh state.
        writeCachedNetworks(ircState.networks);
        checkRoute();
        selectLastActiveBuffer((obj.networks || []) as Network[]);
        // Load the full _server history from REST on BOOT sync so MOTD/
        // welcome events survive page refresh. On periodic syncs (every
        // 10s) skip to avoid re-fetching and flashing "Fetching more…".
        // For channel/query buffers we skip — the sync already provided
        // fresh messages.
        if (isBootSync && ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName) {
          const ab = ircState.activeBuffer;
          const isServer = ab.bufferName === '_server';
          const key = `${ab.networkId!}:${normalizeChannelName(ab.bufferName!)}`;
          const hasMsgs = ircState.messages[key] && ircState.messages[key].length > 0;
          if (!hasMsgs || isServer) {
            void loadBufferHistory(ab.networkId!, ab.bufferName!);
          }
        }
      } else if (obj.type === 'irc_event' || obj.y === 'irc_event') {
        processEvent(obj);
      } else if (obj.type === 'pref_update') {
        handlePrefUpdate(obj);
      } else if (obj.type === 'heartbeat_echo') {
        handleHeartbeat(obj);
      } else if (obj.type === 'buffersToDelete') {
        if (globalPrefs.featureFlags.buffersToDelete.enabled) {
          handleBuffersToDelete(obj.bid as string[]);
        }
      }
    }
  }

  // IRCCloud-style: handle stat_user message — sets user identity + preferences
  // Equivalent to IRCCloud's Session.messageHandlers.stat_user
  function handleStatUser(obj: Record<string, unknown>): void {
    performance.mark('stat_user');
    ircState.me = {
      username: (obj.username as string) || '',
      email: (obj.email as string) || '',
    };
    mergePreferences(obj);
  }

  // Monotonic counter returned by the engine's prefsRepo.save() and
  // surfaced in the stat_user boot payload (and every pref_update
  // broadcast). The frontend's mergePreferences() uses it as a
  // last-write-wins tiebreaker: a stale stat_user with a lower counter
  // must not clobber a newer local cache. Module-local instead of on
  // ircState because ircStore.svelte.ts is owned by another task —
  // see docs/PREF_VERSION.md for the full design.
  let lastServerPrefVersion = $state(0);

  // IRCCloud-style: handle networks message — populates the sidebar immediately
  // with real network names before the full state dump arrives
  function handleNetworks(obj: Record<string, unknown>): void {
    performance.mark('networks');
    const items = (obj.items || []) as Array<{ networkId: string; name: string }>;
    if (items.length === 0) return;

    // Pre-populate ircState.networks with skeleton Network objects so the
    // sidebar renders network names immediately.  The subsequent sync
    // message fills in buffers, users, topics, and connection status via
    // Object.assign (matching on networkId).
    const skeletons = items.map(item => ({
      networkId: item.networkId,
      name: item.name,
      host: '',
      port: 0,
      tls: 'enabled' as string,
      nick: '',
      realName: '',
      currentNick: '',
      connected: false,
      // If the user explicitly disconnected this network, show 'disconnected'
      // instead of 'connecting' — otherwise a WebSocket reconnect (e.g. gateway
      // restart, deploy) would flash the UI back to "Connecting" for networks
      // the user intentionally stopped.
      connectionState: (isUserDisconnected(item.networkId) ? 'disconnected' : 'connecting') as ConnectionState,
      status: isUserDisconnected(item.networkId) ? 'disconnected' : 'connecting',
      disconnectReason: isUserDisconnected(item.networkId) ? 'You disconnected' : '',
      isAway: false,
      awayMessage: '',
      buffers: [{
        name: '_server', type: 'server' as const, isJoined: true,
        unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
        topic: '', topicSetBy: '', topicSetAt: 0, users: [],
        lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      }],
      awayNicks: new Set(),
      capabilities: new Set(),
      isupport: {},
      chanTypes: '#',
    }));
    ircState.networks = skeletons as unknown as Network[];

    // Cache the network names for the next page load
    writeCachedNetworks(ircState.networks);

    // Route to the correct buffer based on the URL (e.g. /irc/irc.supernets.org)
    // or auto-select the first network's server buffer
    checkRoute();
    if (!ircState.activeBuffer.networkId && ircState.networks.length > 0) {
      setActiveBuffer(ircState.networks[0].networkId, '_server');
    }
  }

  // W1-T03: handle heartbeat_echo — engine publishes ONE batched event
  // per network per 30s with bid[] (buffer names) + lastSeen map. We merge
  // every (cid, bid) pair into lastSeenMap in a single batched mutation so
  // the sidebar's unread/highlight state doesn't flicker per-entry.
  //
  // Gated behind globalPrefs.featureFlags.heartbeat.enabled (W0-T01) so
  // Wave 1 ships with this disabled. The engine still emits the events —
  // they're just dropped at the handler — so flipping the flag live in
  // the Settings UI takes effect on the next heartbeat tick.
  function handleHeartbeat(obj: Record<string, unknown>): void {
    if (!globalPrefs.featureFlags.heartbeat.enabled) return;
    const cid = obj.cid;
    const bid = obj.bid;
    const lastSeen = obj.lastSeen;
    if (typeof cid !== 'string' || !Array.isArray(bid) || !lastSeen || typeof lastSeen !== 'object') return;

    // Collect every (cid:bid, ts) update first, then apply in one pass.
    // Iterating Svelte 5's $state proxy keys in a tight loop and writing
    // them back triggers N reactive notifications; doing it from a
    // single pre-built key list keeps the notification count at one.
    // (Svelte 5 batches consecutive writes within the same microtask,
    // but the explicit single-pass loop is the contract this test pins.)
    for (let i = 0; i < bid.length; i++) {
      const bufName = bid[i];
      if (typeof bufName !== 'string') continue;
      const ts = (lastSeen as Record<string, unknown>)[bufName];
      if (typeof ts !== 'number') continue;
      const key = `${cid}:${normalizeChannelName(bufName)}`;
      lastSeenMap[key] = ts;
    }
  }

  // Merge server-side preferences into local reactive maps.
  // Called from both handleStatUser (WS boot) and handlePrefUpdate (real-time sync).
  function mergePreferences(obj: Record<string, unknown>): void {
    // Last-write-wins: skip the merge when our local cache is newer
    // than the incoming stat_user payload. The server bumps prefVersion
    // on every prefsRepo.save(), so a strictly-greater server value is
    // the only safe signal that this payload supersedes local state.
    // Strict-greater (not >=) prevents an echo of the same counter
    // from re-applying an already-merged update. localPrefVersion=0
    // on first boot, so the initial seed always passes through.
    const serverPrefVersion = typeof obj.prefVersion === 'number' ? obj.prefVersion : 0;
    if (lastServerPrefVersion > 0 && serverPrefVersion <= lastServerPrefVersion) {
      return;
    }
    lastServerPrefVersion = serverPrefVersion;

    const user = obj;
    if (user.pinnedChannels) {
      const list = user.pinnedChannels as string[];
      for (const key of Object.keys(pinnedMap)) {
        if (pinnedMap[key] === true && !list.includes(key)) delete pinnedMap[key];
      }
      for (const key of list) {
        if (pinnedMap[key] !== false) pinnedMap[key] = true;
      }
    }
    if (user.archivedChannels) {
      const list = user.archivedChannels as string[];
      for (const key of Object.keys(archivedMap)) {
        if (archivedMap[key] === true && !list.includes(key)) delete archivedMap[key];
      }
      for (const key of list) {
        if (archivedMap[key] !== false) archivedMap[key] = true;
      }
    }
    if (user.serverlogCollapsed) {
      // Additive-only merge: the server may lag behind (stale stat_user
      // cached by the gateway) or be out of sync with another device.
      // Deleting local keys causes a visible flicker — cards that were
      // collapsed correctly from localStorage snap expanded when the
      // delete loop runs, then snap collapsed again on the next render.
      // The pref_update WS handler handles cross-tab/device sync; the
      // initial stat_user is purely a seed for first-time visitors.
      const slc = user.serverlogCollapsed as Record<string, boolean>;
      for (const [key, value] of Object.entries(slc)) {
        if (value === true) serverlogCollapsedMap[key] = true;
      }
    }
    if (user.membersCollapsed) {
      // Additive-only merge: mirrors the serverlogCollapsed pattern at
      // App.svelte:650-661. The server may lag behind (stale stat_user
      // cached by the gateway) or be out of sync with another device.
      // Deleting local keys that are missing from the server payload
      // causes a visible flicker — the sidebar would briefly snap to
      // the server's view, then snap back to the locally-collapsed
      // view on the next render. The pref_update WS handler is the
      // authoritative path for cross-tab/device sync; this merge is
      // only the boot-time seed.
      const collapsed = user.membersCollapsed as Record<string, boolean>;
      for (const [key, value] of Object.entries(collapsed)) {
        if (value === true) membersCollapsedMap[key] = true;
      }
    }
    if (user.collapsed) {
      // Additive-only merge: see membersCollapsed comment above and
      // serverlogCollapsed pattern at App.svelte:650-661. Same reason:
      // delete-then-add on boot would visibly flicker the sidebar
      // network groupings (collapsed → expanded → collapsed) because
      // localStorage-backed collapses are the user's source of truth
      // until a pref_update explicitly toggles them off.
      const col = user.collapsed as Record<string, boolean>;
      for (const [key, value] of Object.entries(col)) {
        if (value === true) collapsedMap[key] = true;
      }
    }
    if (user.inactiveCollapsed) {
      // Additive-only merge: see membersCollapsed comment above and
      // serverlogCollapsed pattern at App.svelte:650-661. Same reason:
      // delete-then-add on boot would visibly flicker the inactive
      // (disconnected) network groupings on page refresh.
      const ic = user.inactiveCollapsed as Record<string, boolean>;
      for (const [key, value] of Object.entries(ic)) {
        if (value === true) inactiveCollapsedMap[key] = true;
      }
    }
    if (user.conversationsCollapsed) {
      // Additive-only merge: see serverlogCollapsed comment at
      // App.svelte:650-661. Same flicker rationale: a stale or empty
      // stat_user payload must NOT wipe the user's localStorage-backed
      // conversation-grouping collapses. The pref_update WS handler is
      // the authoritative path for cross-tab/device sync; this seed is
      // only used on first boot. Mirrors the existing
      // inactiveCollapsed / collapsed / membersCollapsed patterns.
      const col = user.conversationsCollapsed as Record<string, boolean>;
      for (const [key, value] of Object.entries(col)) {
        if (value === true) conversationsCollapsedMap[key] = true;
      }
    }
    if (user.networkOrder) {
      const order = user.networkOrder as string[];
      networkOrder.length = 0;
      networkOrder.push(...order);
      // Re-sort the network list to reflect the boot-time order. Without
      // this, the sidebar would render in engine-emitted order on first
      // paint and snap to the user's order on the next sync.
      ircState.networks.sort((a, b) => {
        const ai = order.indexOf(a.networkId);
        const bi = order.indexOf(b.networkId);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
    }
    if (user.bufferPrefs) {
      const serverPrefs = user.bufferPrefs as Record<string, Record<string, boolean>>;
      // Merge server-side buffer prefs into the local bufferPrefsMap.
      // Local overrides from this session take priority - we only merge
      // keys not already present locally.
      for (const [key, prefs] of Object.entries(serverPrefs)) {
        if (!(key in bufferPrefsMap)) {
          bufferPrefsMap[key] = prefs;
        } else {
          // Merge individual fields that the local doesn't have
          const existing = bufferPrefsMap[key];
          for (const [k, v] of Object.entries(prefs)) {
            if (!(k in existing)) {
              (existing as Record<string, boolean>)[k] = v as boolean;
            }
          }
        }
      }
    }
  }

  function handlePrefUpdate(data: Record<string, unknown>): void {
    // Track the latest server prefVersion we have observed. Without
    // this, a later stale stat_user with a lower counter could
    // overwrite a pref_update we just applied. Mirrors the gate at
    // the top of mergePreferences above.
    const updatePrefVersion = typeof data.prefVersion === 'number' ? data.prefVersion : 0;
    if (updatePrefVersion > lastServerPrefVersion) {
      lastServerPrefVersion = updatePrefVersion;
    }

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
    } else if (key === 'serverlogCollapsed') {
      // Additive-only merge: keys are keyed by per-attempt event IDs that
      // change every boot, so cross-device "delete when key missing"
      // semantics would wipe the user's locally-collapsed entries and
      // cause a visible flicker (cards snap expanded, then collapsed) on
      // every refresh. The mergePreferences boot path already adds
      // server-true values, so this path is only needed for cross-tab
      // sync where the user just collapsed a card in another tab.
      // Mirrors the serverlogCollapsed pattern in mergePreferences at
      // App.svelte:650-661.
      const slc = (data.value as Record<string, boolean>) ?? {};
      for (const [k, v] of Object.entries(slc)) {
        if (v === true) serverlogCollapsedMap[k] = true;
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
    } else if (key === 'collapsed') {
      const col = (data.value as Record<string, boolean>) ?? {};
      for (const k of Object.keys(collapsedMap)) {
        if (!(k in col)) delete collapsedMap[k];
      }
      for (const [k, v] of Object.entries(col)) {
        if (v === true) collapsedMap[k] = true;
      }
    } else if (key === 'inactiveCollapsed') {
      const ic = (data.value as Record<string, boolean>) ?? {};
      for (const k of Object.keys(inactiveCollapsedMap)) {
        if (!(k in ic)) delete inactiveCollapsedMap[k];
      }
      for (const [k, v] of Object.entries(ic)) {
        if (v === true) inactiveCollapsedMap[k] = true;
      }
    } else if (key === 'conversationsCollapsed') {
      // Real-time cross-tab/device sync for per-network conversation
      // grouping collapses (the sidebar Conversations header toggle).
      // Mirrors the inactiveCollapsed pattern at App.svelte:801-808 —
      // server is authoritative on pref_update so we delete locally
      // stale entries to keep tabs consistent. Boot-time seeding is
      // additive-only in mergePreferences above.
      const collapsed = (data.value as Record<string, boolean>) ?? {};
      for (const k of Object.keys(conversationsCollapsedMap)) {
        if (!(k in collapsed)) delete conversationsCollapsedMap[k];
      }
      for (const [k, v] of Object.entries(collapsed)) {
        if (v === true) conversationsCollapsedMap[k] = true;
      }
    } else if (key === 'networkOrder') {
      // Real-time sync from another tab/device: apply the new order to
      // ircState.networks so the sidebar updates immediately, mirroring
      // how the boot payload does it.
      const order = ((data.value as string[]) ?? []).slice();
      networkOrder.length = 0;
      networkOrder.push(...order);
      ircState.networks.sort((a, b) => {
        const ai = order.indexOf(a.networkId);
        const bi = order.indexOf(b.networkId);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return 0;
      });
    } else if (key === 'bufferPrefs') {
      // Real-time sync of per-buffer prefs from another tab/device
      const serverPrefs = (data.value as Record<string, Record<string, boolean>>) ?? {};
      for (const [k, v] of Object.entries(serverPrefs)) {
        bufferPrefsMap[k] = { ...(bufferPrefsMap[k] ?? {}), ...v };
      }
      // Remove keys that were deleted (empty object -> removed on server)
      for (const key of Object.keys(bufferPrefsMap)) {
        if (!(key in serverPrefs)) {
          delete bufferPrefsMap[key];
        }
      }
    }
  }

  function processEvent(data: Record<string, unknown>): void {
    const counter = { value: localMsgIdCounter };
    const result = processIrcEvent(data, counter, accum, { switchToBuffer }, enqueueMessage);
    localMsgIdCounter = counter.value;

    // When a network connects (001 or CONNECT event), retry auto-join for
    // the currently active channel buffer.  maybeAutoJoinChannel may have
    // been called earlier when the network was disconnected and returned
    // at the !net.connected guard — now that the network is up, we need
    // to attempt the JOIN again.
    const cmd = data.c as string || data.command as string || '';
    if (cmd === '001' || cmd === 'CONNECT' || cmd === 'CONNECTED') {
      // Use nid (UUID from compact JSON) or network (name) as fallback.
      // nid is preferred since maybeAutoJoinChannel looks up by networkId.
      let netId = data.nid as string;
      if (!netId) {
        // Fallback: resolve network name → UUID so the retry-join works
        // even when the engine's compact JSON doesn't include nid.
        const netName = data.network as string;
        if (netName) {
          const found = ircState.networks.find(n => n.name === netName);
          if (found) netId = found.networkId;
        }
      }
      if (netId) {
        // Retry auto-join for the active channel buffer (if any)
        if (ircState.activeBuffer.bufferName) {
          maybeAutoJoinChannel(netId, ircState.activeBuffer.bufferName);
        }
        // Auto-collapse the previous disconnect card in the server log so
        // the new connection events are immediately visible without having
        // to scroll past a tall "Disconnected" card.  Walk backwards
        // from the end of the server buffer (CONNECT is the most recent
        // entry; the DISCONNECT we want to collapse is just before it).
        // Tries both eid and msgid key formats (matching ServerLogCard's
        // collapsedKey derivation).
        const serverKey = `${netId}:_server`;
        const serverMsgs = ircState.messages[serverKey] ?? [];
        for (let i = serverMsgs.length - 1; i >= 0; i--) {
          const m = serverMsgs[i];
          const isDisco = m.command === 'DISCONNECT' ||
                          m.command === 'DISCO_GROUP' ||
                          m.command === 'ERROR';
          if (!isDisco) continue;
          let collapseKey = '';
          if (m.eid) {
            collapseKey = `${netId}:${m.eid}`;
          } else if (m.msgid) {
            collapseKey = `${netId}:msgid:${m.msgid}`;
          }
          if (collapseKey) {
            serverlogCollapsedMap[collapseKey] = true;
          }
          break;
        }
      }
    }
    // When DISCONNECT fires, auto-collapse the most recent CONNECTED card
    // so the timeline doesn't accumulate expanded cards side by side.
    if (cmd === 'DISCONNECT' || cmd === 'DISCONNECTED') {
      let netId = data.nid as string;
      if (!netId) {
        const netName = data.network as string;
        if (netName) {
          const found = ircState.networks.find(n => n.name === netName);
          if (found) netId = found.networkId;
        }
      }
      if (netId) {
        const serverKey = `${netId}:_server`;
        const serverMsgs = ircState.messages[serverKey] ?? [];
        for (let i = serverMsgs.length - 1; i >= 0; i--) {
          const m = serverMsgs[i];
          const isConnected = m.command === 'CONNECT' || m.command === 'CONNECTED' || m.command === '001';
          if (!isConnected) continue;
          let collapseKey = '';
          if (m.eid) {
            collapseKey = `${netId}:${m.eid}`;
          } else if (m.msgid) {
            collapseKey = `${netId}:msgid:${m.msgid}`;
          }
          if (collapseKey) {
            serverlogCollapsedMap[collapseKey] = true;
          }
          break;
        }
      }
    }
    if (result.whoisData) {
      // Only pop the WHOIS overlay when the user explicitly requested it.
      // The server also issues automatic WHOIS queries on JOIN to populate
      // realnames (see ircfiber/irc/connection.d); those responses must not
      // interrupt the user with a modal.
      const nickKey = (result.whoisData.nick || '').toLowerCase();
      const pending = nickKey ? ircState.pendingWhois.get(nickKey) : undefined;
      if (nickKey && pending) {
        ircState.pendingWhois.delete(nickKey);
        ircState.overlay.type = 'whois';
        ircState.overlay.data = result.whoisData as WhoisData;
      }
    }
    if (result.whoisFailedNick) {
      const fk = result.whoisFailedNick.toLowerCase();
      const pend = ircState.pendingWhois.get(fk);
      ircState.pendingWhois.delete(fk);
      if (pend) {
        ircState.overlay.type = 'whois';
        ircState.overlay.data = {
          nick: result.whoisFailedNick,
          user: '',
          host: '',
          realname: '',
          server: '',
          serverInfo: '',
          channels: [],
          idle: 0,
          signon: 0,
          account: '',
          secure: false,
          away: '',
          operator: false,
        } as WhoisData;
        (ircState.overlay.data as any).whoisFailed = true;
      }
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
      ircState.showShortcuts = false;
      return;
    }
    if (isShortcutsUrl()) {
      ircState.showShortcuts = true;
      ircState.showSettings = false;
      return;
    }
    ircState.showSettings = false;
    ircState.showShortcuts = false;
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

    // When navigating to a channel via URL, the user is explicitly asking
    // to see that channel.  The engine sync + live IRC events are the only
    // authorities for isJoined — see the pendingIsJoined guard in
    // updateNetworkFromSync which prevents stale sync snapshots from
    // clobbering a recent JOIN.  A phantom buffer (auto-created below by
    // switchToBuffer when no buffer exists locally) starts with
    // isJoined=false and is corrected on the next sync.
    switchToBuffer(net.networkId, bufferName);
  }

  function selectLastActiveBuffer(syncNetworks: Network[]): void {
    if (ircState.showSettings || ircState.showShortcuts) return;
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

{#if channelSwitcherOpen}
  <ChannelSwitcher onClose={() => channelSwitcherOpen = false} scope="all" />
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

<div id="wrap" class:has-members={hasMembers && !ircState.showSettings} class:members-collapsed={hasMembers && !memberPanelOpen && !ircState.showSettings} class:sidebar-open={sidebarDrawerOpen} class:mobile-members-open={mobileMembersOpen} class:has-sidebar={ircState.showSettings || ircState.showShortcuts || !isBootLoading} class:unauthenticated={isAuthenticated === false}>
  <div class="main-area">
    {#if ircState.showSettings}
      <SettingsPage />
    {:else if ircState.showShortcuts}
      <ShortcutsPage />
    {:else if isBootLoading}
      <LoadingSkeleton networkNames={cachedNetworkNames} />
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
        <div class="chat-column">
          <main class="chat-container">
            <ChatArea onNickClick={handleNickClick} />
          </main>
        </div>
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
  {#if !isBootLoading}
  <aside id="sidebar">
    <Sidebar onSwitchBuffer={navigateToBuffer}
             onAddNetwork={() => { networkFormMode = 'add'; showNetworkForm = true; }}
             onNetworkOptions={openNetworkOptions}
             onJoinChannel={(networkId) => { showJoinModal = true; }} />
  </aside>
  {/if}
</div>

<!-- IRCCloud-style #noAuth overlay: rendered last so it paints on top
     of the chat shell. Visible only while isAuthenticated === false
     (i.e. /api/me returned 401 at boot or LoginPage just kicked off). -->
{#if isAuthenticated === false}
  <LoginPage onAuthenticated={handleAuthenticated} />
{/if}
