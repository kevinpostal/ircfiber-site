<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Sidebar from './components/Sidebar.svelte';
  import ChatArea from './components/ChatArea.svelte';
  import MemberList from './components/MemberList.svelte';
  import BufferHeader from './components/BufferHeader.svelte';
  import NetworkForm from './components/NetworkForm.svelte';
  import JoinModal from './components/JoinModal.svelte';
  import BouncerDialog from './components/BouncerDialog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import ChannelContextMenu from './components/ChannelContextMenu.svelte';
  import ServerLogContextMenu from './components/ServerLogContextMenu.svelte';
  import Overlay from './components/Overlay.svelte';
  import NoticeOverlay from './components/NoticeOverlay.svelte';
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
    isUserDisconnected,
    isMessageUnseen, setLastSeenMessage, readBuffer, markAllAsRead,
    isTrackingUnread, dirtySeenEids
  } from './stores/ircStore.svelte';
  import { isIgnored } from './stores/preferences.svelte';
  import { connectWebSocket, requestSync, requestSwitchBuffer, disconnectWebSocket, sendJson, wsState } from './stores/wsConnection.svelte.ts';
  import { loadHistory, updateMembersCollapsed } from './stores/api';
  import { normalizeChannelName, isSkippedCommand, stripPrefix } from './lib/utils';
  import DropTarget from './components/DropTarget.svelte';
  import UploadDialog from './components/UploadDialog.svelte';
  import UploadsPanel from './components/UploadsPanel.svelte';
  import SnippetsPanel from './components/SnippetsPanel.svelte';
  import IrcArtPanel from './components/IrcArtPanel.svelte';
  import { startUploads, confirmDialog, cancelDialog } from './stores/uploadFlow.svelte';
  import { uploadState } from './stores/uploadStore.svelte';
  import { ircArtPanelOpen } from './stores/ircArtStore.svelte';
  import { notify } from './lib/notifications';
  import { startOnlineChecker } from './lib/onlineChecker';
  import { serverlogCollapsedMap, membersCollapsedMap, collapsedMap, archivedMap, hiddenChannelsMap, pinnedMap, inactiveCollapsedMap, networkOrder, suppressAnimations, globalPrefs, setFocusSeen, getFocusSeen, clearFocusSeen, clearBottomSeen, bufferPrefsMap, conversationsCollapsedMap, setShowMemberPrefixes, applyServerNotificationPrefs } from './stores/preferences.svelte';
  import { loadCachedMessages } from './stores/ircStore.svelte';
  import { updateRoute, getSettingsTabFromUrl, isSettingsUrl, navigateBackFromSettings, isShortcutsUrl, navigateBackFromShortcuts, isFileViewerUrl, getFileViewerIdFromUrl, navigateBackFromFileViewer, isPastebinUrl, getPastebinIdFromUrl, navigateBackFromPastebin } from './lib/routing';
  import { processIrcEvent, type AccumState } from './lib/messageHandler';
  import { isFiberServerDown } from './lib/fiberServer';
  import { enqueueMessage, setFlushFn, setBackfillFlushFn } from './lib/messageBatcher';
  import WelcomePage from './components/WelcomePage.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import ShortcutsPage from './components/ShortcutsPage.svelte';
  import FileViewerPage from './components/FileViewerPage.svelte';
  import PasteViewerPage from './components/PasteViewerPage.svelte';
  import ChannelSwitcher from './components/ChannelSwitcher.svelte';
  import LoadingSkeleton from './components/LoadingSkeleton.svelte';
  import LoginPage from './components/LoginPage.svelte';
import Dialog from './components/Dialog.svelte';

function withViewTransition(fn: () => void): void {
  try {
    const isTestEnv = typeof window !== 'undefined' && (
      (window as unknown as Record<string, unknown>).__vitest !== undefined ||
      (window as unknown as Record<string, unknown>).__playwright !== undefined ||
      (typeof navigator !== 'undefined' && (navigator as unknown as { webdriver?: boolean }).webdriver === true)
    );
    if (isTestEnv) { fn(); return; }
  } catch (_e) {}
  const doc = document as unknown as { startViewTransition?: (cb: () => void) => { finished: Promise<void>; ready: Promise<void> } };
  if (doc.startViewTransition) {
    try {
      const vt = doc.startViewTransition(fn);
      vt?.finished?.catch(() => {});
      vt?.ready?.catch(() => {});
      return;
    } catch (_e) {}
  }
  fn();
}

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
  try { localStorage.setItem(NETWORK_CACHE_KEY, JSON.stringify(data)); } catch (_e) {}
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

// IRCCloud session.isInitialized(): once sync + backlog have landed.
$effect(() => {
  if (syncReceived && backlogReady) ircState.bootComplete = true;
});

let showNetworkForm: boolean = $state(false);
  let showJoinModal: boolean = $state(false);
  let joinModalNetworkId: string | null = $state(null);
  let showBouncerDialog: boolean = $state(false);
  let bouncerNetworkId: string | null = $state(null);
  $effect(() => { (window as any).__channelMenu = channelMenu; (window as any).__editNetworkId = editNetworkId; (window as any).__showNetworkForm = showNetworkForm; });
  $effect(() => { (window as any).__showNetworkForm = showNetworkForm; (window as any).__editNetworkId = editNetworkId; (window as any).__networkFormMode = networkFormMode; });
  let channelSwitcherOpen: boolean = $state(false);
  let networkFormMode: 'add' | 'edit' = $state('add');
  let localMsgIdCounter = 0;
  let editNetworkId: string | null = $state(null);
  let channelMenu: { x: number; y: number; networkId: string; bufferName: string } | null = $state(null);

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
  let sidebarCollapsed = $state(false);
  onMount(() => {
    try { sidebarCollapsed = localStorage.getItem('ircfiber.sidebarCollapsed') === '1'; } catch {}
  });
  $effect(() => {
    try { localStorage.setItem('ircfiber.sidebarCollapsed', sidebarCollapsed ? '1' : '0'); } catch {}
  });

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

  const hasOpenDialog = $derived(!!ircState.overlay.type || showNetworkForm || showJoinModal || showBouncerDialog || !!uploadState.dialog || !!userPopup || !!channelMenu);
  let wrapEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    if (!wrapEl) return;
    const el = wrapEl as unknown as { inert?: boolean };
    try { el.inert = hasOpenDialog; } catch (_e) {}
    if (hasOpenDialog) wrapEl.setAttribute('inert', '');
    else wrapEl.removeAttribute('inert');
  });

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

  function toggleSidebar(): void {
    if (isNarrow) {
      sidebarDrawerOpen = !sidebarDrawerOpen;
    } else {
      sidebarCollapsed = !sidebarCollapsed;
    }
  }

  $effect(() => {
    if (ircState.showSettings || ircState.showShortcuts || isPastebinUrl() || isFileViewerUrl() || fileViewerId !== null || pasteViewerId !== null) return;
    const { networkId, bufferName } = ircState.activeBuffer;
    if (networkId && bufferName) updateRoute(networkId, bufferName);
  });

  // Auto-select first network's server buffer when networks exist but none is active
  // Skip the IRC Fiber system network when it's down — it should not be
  // the default landing page for /irc/. Pick the first *visible* network
  // (host !== '' ensures we have full sync data, not just the skeleton
  // from the `networks` WS message which lacks host/systemManaged).
  $effect(() => {
    if (ircState.showSettings || ircState.showShortcuts || isPastebinUrl() || isFileViewerUrl() || fileViewerId !== null || pasteViewerId !== null) return;
    if (!ircState.activeBuffer.networkId && !ircState.activeBuffer.bufferName && ircState.networks.length > 0) {
      const candidates = ircState.networks.filter(n => n.host && !isFiberServerDown(n as any));
      const firstNet = candidates.length > 0 ? candidates[0] : null;
      // Only auto-select once we have real sync data (host populated).
      // The skeleton phase (host === '') would incorrectly pick the Fiber
      // network even when it's down because isFiberServerDown can't detect
      // it without host/systemManaged. Defer to selectLastActiveBuffer
      // which runs after the full sync.
      if (!firstNet) return;
      setActiveBuffer(firstNet.networkId, '_server');
      updateRoute(firstNet.networkId, '_server');
    }
  });

  // If the active buffer is the Fiber server while it's down, bounce to
  // the next visible network. This handles the case where /irc/ initially
  // landed on Fiber (e.g. before the sync had host/systemManaged to
  // detect isDown, or via a stale lastVisited cookie).
  $effect(() => {
    if (ircState.showSettings || ircState.showShortcuts || isPastebinUrl() || isFileViewerUrl() || fileViewerId !== null || pasteViewerId !== null) return;
    const activeId = ircState.activeBuffer.networkId;
    const activeBuf = ircState.activeBuffer.bufferName;
    if (!activeId || !activeBuf) return;
    const net = ircState.networks.find(n => n.networkId === activeId);
    if (!net) return;
    if (!isFiberServerDown(net as any)) return;
    // Only auto-bounce for the Fiber server buffer itself; don't yank the
    // user out of a Fiber channel they explicitly navigated to.
    if (activeBuf !== '_server') return;
    const next = ircState.networks.find(n => n.host && !isFiberServerDown(n as any));
    if (!next) return;
    // bounce
    setActiveBuffer(next.networkId, '_server');
    updateRoute(next.networkId, '_server');
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
  let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;

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
  // File viewer overlay — mirrors settings/shortcuts routing via ?/view=
  let fileViewerId: string | null = $state(getFileViewerIdFromUrl());
  let pasteViewerId: string | null = $state(getPastebinIdFromUrl());
  function syncFileViewer(): void {
    fileViewerId = getFileViewerIdFromUrl();
  }
  function syncPasteViewer(): void {
    pasteViewerId = getPastebinIdFromUrl();
  }
  function syncViewers(): void {
    syncFileViewer();
    syncPasteViewer();
  }

  // IRCCloud heartbeat (rEXR): every 2 s, if any buffer's lastSeen changed
  // since the last send, POST the dirty `seenEids` and clear them. Sent
  // over the WS as `cmd:"heartbeat"`; the gateway persists and echoes.
  function scheduleSendState(): void {
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(sendState, 2000);
  }

  function sendState(): void {
    heartbeatTimeout = undefined;
    if (Object.keys(dirtySeenEids).length > 0 && ircState.wsConnected) {
      const seenEids: Record<string, Record<string, number>> = {};
      for (const nid of Object.keys(dirtySeenEids)) {
        seenEids[nid] = { ...dirtySeenEids[nid] };
        delete dirtySeenEids[nid];
      }
      sendJson({ cmd: 'heartbeat', seenEids });
    }
    scheduleSendState();
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
        scheduleSendState();
      },
      () => {
        ircState.wsConnected = false;
        if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = undefined; }
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
    // E2E hook: let Playwright inject a fake NOTICE/PRIVMSG and verify the overlay+batcher pipeline.
    // Mirrors __fiberAddNotice (NoticeOverlay) and __fiberIrcState (ircStore) for e2e.
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__fiberProcessIrcEvent = (data: Record<string, unknown>) => processEvent(data);
    }
    // Set up IRCCloud-style message batcher (200ms flush)
    setFlushFn((networkId, bufferName, msgs) => {
      batchAppendMessages(networkId, bufferName, msgs);
    });
    setBackfillFlushFn((networkId, bufferName, msgs) => {
      prependMessages(networkId, bufferName, msgs);
    });
    startOnlineChecker();
    // Keep viewer overlays in sync when routing helpers call history.pushState/replaceState
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);
    history.pushState = ((...args: any[]) => { (origPushState as any)(...args); syncViewers(); }) as any;
    history.replaceState = ((...args: any[]) => { (origReplaceState as any)(...args); syncViewers(); }) as any;
    window.addEventListener('popstate', checkRoute);
    document.addEventListener('keydown', handleGlobalKeyboard);
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    setFocused(document.hasFocus());

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
    window.removeEventListener('blur', handleWindowBlur);
    window.removeEventListener('focus', handleWindowFocus);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    document.removeEventListener('keydown', handleGlobalKeyboard);
    document.removeEventListener('click', handleDocumentClick);
  });

  function handleVisibility(): void {
    setFocused(!document.hidden && document.hasFocus());
  }

  // IRCCloud session.setFocused + buffer view focusChange: on blur lock
  // focusSeen (and drop bottomSeen when at bottom); on focus unlock it.
  // The read trigger then re-evaluates with userScrolled=false.
  function setFocused(focused: boolean): void {
    ircState.focusLost = !focused;
    const nid = ircState.activeBuffer.networkId;
    const buf = ircState.activeBuffer.bufferName;
    if (nid && buf && buf !== '_server') {
      if (focused) {
        clearFocusSeen(nid, buf);
      } else {
        const container = document.getElementById('messages');
        const atBottom = !!container && container.scrollHeight - (container.offsetHeight + Math.ceil(container.scrollTop)) <= 1;
        if (atBottom) clearBottomSeen(nid, buf);
        if (getFocusSeen(nid, buf) === null) {
          const list = ircState.messages[`${nid}:${buf}`] ?? [];
          const ts = list.length > 0 ? (list[list.length - 1].t ?? Date.now()) : Date.now();
          setFocusSeen(nid, buf, ts);
          ircState.lastSeenMsgTime = ts;
        }
      }
    }
    ircState.scrollChangeHook?.(false);
  }
  function handleWindowBlur(): void { setFocused(false); }
  function handleWindowFocus(): void { setFocused(true); }

  function handleDocumentClick(e: MouseEvent): void {
    if (userPopup) {
      const target = e.target as HTMLElement;
      if (!target.closest('.userPopup') && !target.closest('.bufferLink') && !target.closest('.member-entry')) {
        userPopup = null;
      }
    }
  }

  function handleGlobalKeyboard(e: KeyboardEvent): void {
    // If the compose input already handled ArrowUp/Down for history/scroll,
    // don't also switch buffers (plain Arrow is handled in InputArea with
    // stopPropagation, but Alt+Arrow bubbles — respect defaultPrevented).
    if (e.defaultPrevented) return;
    // Svelte 5 strips the parens around `(ArrowUp || ArrowDown)` inside an
    // `&&` chain; bind the key check to a const so grouping is preserved.
    // IRCCloud never scrolls the log from arrow keys (docKeyDown focuses the
    // composer instead); only the Alt/Alt+Shift buffer navigation remains.
    const isArrowKey = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (e.altKey && !e.ctrlKey && !e.metaKey && isArrowKey) {
      e.preventDefault();
      if (e.shiftKey) selectAdjacentUnreadBuffer(e.key === 'ArrowUp' ? -1 : 1);
      else switchAdjacentBuffer(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
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
      if (pasteViewerId) { navigateBackFromPastebin(); return; }
      if (fileViewerId) { navigateBackFromFileViewer(); return; }
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
      let closedSomething = false;
      if (ircState.overlay.type) { ircState.overlay.type = null; ircState.overlay.data = null; closedSomething = true; }
      if (ircState.contextMenu.visible) { ircState.contextMenu.visible = false; closedSomething = true; }
      if (showNetworkForm) { showNetworkForm = false; closedSomething = true; }
      if (showJoinModal) { showJoinModal = false; closedSomething = true; }
      if (showBouncerDialog) { showBouncerDialog = false; bouncerNetworkId = null; closedSomething = true; }
      if (uploadState.dialog) { cancelDialog(); closedSomething = true; }
      if (uploadState.panelOpen) { uploadState.panelOpen = false; closedSomething = true; }
      if (uploadState.pastebinPanelOpen) { uploadState.pastebinPanelOpen = false; closedSomething = true; }
      if (userPopup) { userPopup = null; closedSomething = true; }
      // IRCCloud docKeyDown: with nothing open, Esc marks the current
      // buffer read; Shift+Esc marks every buffer read.
      if (!closedSomething) {
        if (e.shiftKey) markAllAsRead();
        else if (ircState.activeBuffer.networkId && ircState.activeBuffer.bufferName && ircState.activeBuffer.bufferName !== '_server') {
          readBuffer(ircState.activeBuffer.networkId, ircState.activeBuffer.bufferName);
        }
      }
    }
    // IRCCloud parity: typing anywhere focuses the compose input
    // (http://127.0.0.1:8090/irc/Supernets/channel/superbowl). If the
    // active buffer has a compose box and no input is focused, printable
    // keys auto-focus #compose-input so the character lands there.
    // Mobile: skip — keyboard would pop on every key and hide the chat
    // (IRCCloud mobile also requires an explicit tap). Detect coarse/touch
    // not just narrow width (tests run narrow on desktop).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const isMobileForTyping = typeof window !== 'undefined' && (
        window.matchMedia('(pointer: coarse)').matches ||
        (window.matchMedia('(max-width: 800px)').matches && (('ontouchstart' in window) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)))
      );
      if (isMobileForTyping) return;
      const target = e.target as HTMLElement | null;
      const isTypingTarget = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.tagName === 'SELECT'
      );
      if (isTypingTarget) return;
      // Don't steal when any modal/overlay is open
      if (channelSwitcherOpen || ircState.showSettings || ircState.showShortcuts ||
          ircState.overlay.type || showNetworkForm || showJoinModal || showBouncerDialog ||
          ircState.contextMenu.visible || !!userPopup) return;
      if (ircState.activeBuffer.bufferName === '_server') return;
      const compose = document.getElementById('compose-input') as HTMLTextAreaElement | null;
      if (compose && document.activeElement !== compose) {
        compose.focus();
        // Don't preventDefault — let the browser deliver this same keystroke
        // to the newly focused input. Focusing synchronously during keydown
        // makes the subsequent input event target the compose box.
      }
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

  // IRCCloud selectPreviousUnreadBuffer / selectNextUnreadBuffer: walk the
  // sidebar order (skipping children of collapsed networks) from the
  // active buffer, wrapping, to the first buffer in `unseenBuffers`.
  function selectAdjacentUnreadBuffer(direction: number): void {
    const flat = computeSidebarOrder();
    if (flat.length === 0) return;
    const currentIdx = flat.findIndex(f =>
      f.networkId === ircState.activeBuffer.networkId && f.bufferName === ircState.activeBuffer.bufferName
    );
    const start = currentIdx < 0 ? (direction > 0 ? -1 : flat.length) : currentIdx;
    for (let step = 1; step <= flat.length; step++) {
      const i = (start + direction * step + flat.length * step) % flat.length;
      const cand = flat[i];
      const net = ircState.networks.find(n => n.networkId === cand.networkId);
      const buf = net?.buffers.find(b => b.name === cand.bufferName);
      if (!buf || !buf.unseen) continue;
      if (!isTrackingUnread(cand.networkId, cand.bufferName) && buf.unseenHighlights.length === 0) continue;
      switchToBuffer(cand.networkId, cand.bufferName);
      return;
    }
  }

  function computeSidebarOrder(): { networkId: string; bufferName: string }[] {
    const nets = [...ircState.networks].sort((a, b) => {
      const ia = networkOrder.indexOf(a.networkId);
      const ib = networkOrder.indexOf(b.networkId);
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });
    const flat: { networkId: string; bufferName: string }[] = [];
    for (const net of nets) {
      flat.push({ networkId: net.networkId, bufferName: '_server' });
      if (collapsedMap[net.networkId]) continue;
      for (const buf of net.buffers) {
        if (buf.name === '_server') continue;
        if (hiddenChannelsMap[`${net.networkId}:${buf.name}`]) continue;
        flat.push({ networkId: net.networkId, bufferName: buf.name });
      }
    }
    return flat;
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
    withViewTransition(() => {
      const isSameBuffer =
        ircState.activeBuffer.networkId === networkId &&
        ircState.activeBuffer.bufferName === normalizeChannelName(bufferName);
      setActiveBuffer(networkId, bufferName);
      requestSwitchBuffer(networkId, bufferName);
      updateRoute(networkId, bufferName);
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
    });
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
    const key = `${networkId}:${normalizeChannelName(bufferName)}`;
    try {
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
      let hadCached = false;
      cached = loadCachedMessages(networkId, bufferName);
      if (cached && cached.length > 0 && existing.length === 0) {
        setMessages(networkId, bufferName, cached);
        hadCached = true;
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
      // History merges now go through the backfill batcher (enqueueMessage
      // with isBackfill=true) so a concurrent CHATHISTORY BATCH (also via
      // the backfill queue, 0ms timer) coalesces into a single
      // prependMessages() flush. Previously loadBufferHistory called
      // setMessages/prependMessages directly while the CHATHISTORY BATCH
      // arrived via the batcher 0ms later — two separate renders, visible
      // as "IRC history then server messages" flicker. Coalescing makes the
      // initial paint atomic.
      const queueHistory = (list: IRCMessage[]) => {
        for (const m of list) enqueueMessage(networkId, bufferName, m, true);
      };
      let queued = false;
      if (isServerLog && existing.length > 0) {
        // Merge REST history with existing sync messages.  The sync provides
        // the most recent 50 messages; the REST provides up to 200.  Merge
        // older history before the sync snapshot, deduping by eid so recent
        // live events (arrived via batchAppendMessages while the REST call
        // was in flight) are not overwritten.
        if (msgs.length > 0) { queueHistory(msgs); queued = true; }
      } else if (hadCached) {
        // We already showed cached history (instant paint). REST is the
        // source of truth for older backlog, but it must NOT overwrite the
        // tail — the cached array may contain optimistic messages (label
        // without eid) that haven't been persisted to Redis yet. Replacing
        // via setMessages would flicker and make the user's recent sends
        // disappear until the echo arrives. Merge via backfill queue
        // which dedups by eid/msgid and preserves the tail.
        if (msgs.length > 0) { queueHistory(msgs); queued = true; }
        // If REST is empty (no history), keep the cached messages as-is —
        // don't clear the buffer.
      } else if (existing.length === 0) {
        const current = ircState.messages[key] ?? [];
        if (current.length === 0) {
          // No cached and no sync arrived in the meantime — use REST.
          // Queue as backfill so a concurrent CHATHISTORY BATCH (150ms) merges
          // atomically instead of flashing "REST then CHATHISTORY".
          if (msgs.length > 0) { queueHistory(msgs); queued = true; }
        } else {
          // A sync or live batch arrived while REST was in flight.
          // Merge older REST history without clobbering the new tail.
          if (msgs.length > 0) { queueHistory(msgs); queued = true; }
        }
      }
      // Keep spinner until coalesced backfill flush (150ms debounce) completes
      // and MessageList has laid out (clientHeight > 0) and snapped to
      // bottom — prevents subtle flash where flex container is 0-height
      // before first paint at /irc/Supernets/channel/superbowl.
      if (queued) {
        await new Promise(r => setTimeout(r, 220));
        // Extra rAF + layout poll: ensure #messages has been laid out
        // (isBootLoading -> ChatArea mount is async; without this the
        // first synchronous snap lands at scrollTop 0 and the rAF snap
        // flashes from top to bottom).
        for (let i = 0; i < 6; i++) {
          const el = document.getElementById('messages') as HTMLDivElement | null;
          if (el && el.clientHeight > 0 && el.scrollHeight > 0) break;
          await new Promise(r => requestAnimationFrame(() => r(null)));
        }
        await new Promise(r => requestAnimationFrame(() => r(null)));
      }
      // Mark history as loaded even when REST returned no messages, so
      // MessageList's hasHistoryLoaded (ircState.messages[key] !== undefined)
      // flips true and the empty hint can render truthfully after load.
      // Without this, a truly empty channel would stay undefined forever,
      // hiding the empty hint, while a populated channel would correctly
      // remain hidden during the fetch (no flash).
      if (ircState.messages[key] === undefined) {
        if (msgs.length === 0) {
          setMessages(networkId, bufferName, []);
        } else if (!queued) {
          setMessages(networkId, bufferName, msgs);
        }
      }
      backlogReady = true;  // IRCCloud backlog_complete equivalent
      performance.mark('backlog-ready');
    } catch (e) {
      console.error('Failed to load history:', e);
      // Ensure boot spinner doesn't hang forever and MessageList doesn't
      // stay in indefinite loading state.
      if (ircState.messages[key] === undefined) setMessages(networkId, bufferName, []);
      backlogReady = true;
    }
  }

  // Debug: expose ircState for member list inspection
  if (typeof window !== 'undefined') (window as any).ircState = ircState;
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
            // Defer backlogReady until history batch coalesces (150ms debounce)
            // so spinner hides *after* REST + CHATHISTORY merge, not before —
            // prevents "older then recent" flash at /irc/Supernets/channel/superbowl.
            void loadBufferHistory(ab.networkId!, ab.bufferName!);
          } else {
            // History already in sync — safe to hide spinner immediately
            backlogReady = true;
            performance.mark('backlog-ready');
          }
        } else if (isBootSync) {
          // Boot sync with no active buffer (WelcomePage) — no history to wait for
          backlogReady = true;
          performance.mark('backlog-ready');
        }
      } else if (obj.type === 'irc_event' || obj.y === 'irc_event') {
        processEvent(obj);
      } else if (obj.type === 'pref_update') {
        handlePrefUpdate(obj);
      } else if (obj.type === 'heartbeat_echo') {
        handleHeartbeatEcho(obj);
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
        unseen: false, unseenCount: 0, unseenHighlights: [], isPinned: false, isArchived: false,
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
      // Same filter as the $effect above — don't pick the Fiber server
      // when it's down, and don't pick skeletons (host === '').
      const cand = ircState.networks.filter(n => n.host && !isFiberServerDown(n as any));
      const pick = cand.length > 0 ? cand[0] : null;
      if (pick) setActiveBuffer(pick.networkId, '_server');
    }
  }

  // IRCCloud heartbeat_echo: the gateway fans out every changed
  // `seenEids[cid][bid]` to all of the user's sessions; apply advance-only.
  function handleHeartbeatEcho(obj: Record<string, unknown>): void {
    const seen = obj.seenEids;
    if (!seen || typeof seen !== 'object') return;
    for (const [nid, bufs] of Object.entries(seen as Record<string, unknown>)) {
      if (!bufs || typeof bufs !== 'object') continue;
      for (const [name, t] of Object.entries(bufs as Record<string, unknown>)) {
        if (typeof t !== 'number') continue;
        if (isMessageUnseen({ t } as IRCMessage, nid, name)) setLastSeenMessage(nid, name, t);
      }
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
      // Server is authoritative for bufferPrefs (including notifyAll/mute).
      // Normalize channel part of the key (IRC channels are case-insensitive)
      // and overwrite local fields so a refresh correctly restores the dropdown
      // check state even if localStorage was stale or debounced.
      const normalizeKey = (k: string) => {
        const idx = k.indexOf(':');
        if (idx === -1) return k;
        return k.slice(0, idx) + ':' + normalizeChannelName(k.slice(idx + 1));
      };
      for (const [rawKey, prefs] of Object.entries(serverPrefs)) {
        const key = normalizeKey(rawKey);
        const existing = bufferPrefsMap[key] ?? {};
        bufferPrefsMap[key] = { ...existing, ...prefs } as Record<string, boolean>;
      }
    }
    if (typeof user.showMemberPrefixes === 'boolean') {
      setShowMemberPrefixes(user.showMemberPrefixes as boolean);
    }
    // Global notification prefs — additive boot seed, authoritative via applyServerNotificationPrefs
    const notifPatch: Record<string, boolean> = {};
    if (typeof user.desktopNotifications === 'boolean') notifPatch.desktopNotifications = user.desktopNotifications as boolean;
    if (typeof user.notificationSound === 'boolean') notifPatch.notificationSound = user.notificationSound as boolean;
    if (typeof user.autoDismissNotifs === 'boolean') notifPatch.autoDismissNotifs = user.autoDismissNotifs as boolean;
    if (typeof user.muteAll === 'boolean') notifPatch.muteAll = user.muteAll as boolean;
    if (Object.keys(notifPatch).length > 0) {
      applyServerNotificationPrefs(notifPatch, serverPrefVersion);
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
      // Real-time sync of per-buffer prefs from another tab/device.
      // Normalize server keys so "#TEST" and "#test" collide.
      const rawPrefs = (data.value as Record<string, Record<string, boolean>>) ?? {};
      const normalizeKey = (k: string) => {
        const idx = k.indexOf(':');
        if (idx === -1) return k;
        return k.slice(0, idx) + ':' + normalizeChannelName(k.slice(idx + 1));
      };
      const serverPrefs: Record<string, Record<string, boolean>> = {};
      for (const [rk, v] of Object.entries(rawPrefs)) serverPrefs[normalizeKey(rk)] = v;
      for (const [k, v] of Object.entries(serverPrefs)) {
        bufferPrefsMap[k] = { ...(bufferPrefsMap[k] ?? {}), ...v };
      }
      // Remove keys that were deleted (empty object -> removed on server)
      for (const k of Object.keys(bufferPrefsMap)) {
        if (!(k in serverPrefs)) {
          delete bufferPrefsMap[k];
        }
      }
    } else if (key === 'showMemberPrefixes') {
      const v = data.value as boolean;
      if (typeof v === 'boolean') setShowMemberPrefixes(v);
    } else if (key === 'notificationPrefs') {
      const v = data.value as Record<string, boolean>;
      if (v && typeof v === 'object') {
        applyServerNotificationPrefs(v, updatePrefVersion || (typeof data.prefVersion === 'number' ? data.prefVersion as number : 0));
      }
    } else if (key === 'desktopNotifications' || key === 'notificationSound' || key === 'autoDismissNotifs' || key === 'muteAll') {
      const v = data.value as boolean;
      if (typeof v === 'boolean') {
        applyServerNotificationPrefs({ [key]: v } as Record<string, boolean>, updatePrefVersion);
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
        // Retry auto-join for the active channel buffer ONLY if the
        // active buffer belongs to the network that just connected.
        // Without this guard, viewing #tclmafia on GangNet while
        // Supernets connects would incorrectly JOIN #tclmafia on
        // Supernets (cross-network pollution). See
        // irc.supernets.org autoJoinChannels=["#tclmafia"] bug.
        if (ircState.activeBuffer.bufferName && ircState.activeBuffer.networkId === netId) {
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
      const d = result.banListData as BanListData;
      const key = `${d.networkId}:${d.channel}`;
      const pending = ircState.pendingBanList.get(key);
      // Only show the overlay if the user explicitly requested this ban list
      // (via the context menu or /banlist). Otherwise this 368 is from
      // history replay on refresh and should not pop a dialog.
      // Expire the pending entry after 30s or after use.
      const isRecent = pending ? Date.now() - pending.ts < 30_000 : false;
      if (pending && isRecent) {
        ircState.pendingBanList.delete(key);
        ircState.overlay.type = 'banlist';
        ircState.overlay.data = d;
      } else if (pending) {
        ircState.pendingBanList.delete(key);
      }
    }
  }

  function checkRoute(): void {
    syncViewers();
    if (isPastebinUrl()) {
      ircState.showSettings = false;
      ircState.showShortcuts = false;
      return;
    }
    // File viewer overlay takes precedence — don't treat as buffer route
    if (isFileViewerUrl()) {
      ircState.showSettings = false;
      ircState.showShortcuts = false;
      return;
    }
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
    if (path === '/irc' || path === '/irc/') {
      if (ircState.networks.length === 0) return;
      const visible = ircState.networks.filter(n => (n as any).host && !isFiberServerDown(n as any));
      const first = visible[0] ?? ircState.networks.find(n => (n as any).host && !isFiberServerDown(n as any));
      if (first) {
        switchToBuffer(first.networkId, '_server');
      } else {
        window.history.replaceState({}, '', '/');
        document.cookie = 'lastVisited=; path=/; expires=Thu, 01 Jan 1971 00:00:00 GMT';
      }
      return;
    }
    const m = path.match(/^\/irc\/([^\/]+)(?:\/(channel|messages)\/([^\/]+))?\/?$/);
    if (!m) return;
    const netName = decodeURIComponent(m[1]);
    const type = m[2];
    const target = m[3] ? decodeURIComponent(m[3]) : '';
    const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const net = ircState.networks.find(n => n.name === netName || n.name.toLowerCase() === netName.toLowerCase() || normalize(n.name) === normalize(netName));
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
    // to see that channel.  The engine sync + live IRC events are the only
    // authorities for isJoined — see the pendingIsJoined guard in
    // updateNetworkFromSync which prevents stale sync snapshots from
    // clobbering a recent JOIN.  A phantom buffer (auto-created below by
    // switchToBuffer when no buffer exists locally) starts with
    // isJoined=false and is corrected on the next sync.
    switchToBuffer(net.networkId, bufferName);
  }

  function selectLastActiveBuffer(syncNetworks: Network[]): void {

    if (ircState.showSettings || ircState.showShortcuts || isPastebinUrl() || isFileViewerUrl() || fileViewerId !== null || pasteViewerId !== null) return;
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
    // No connected network — fallback to first visible (non-Fiber-down)
    // so /irc/ doesn't land on the Fiber server when it's down.
    const fallback = syncNetworks.find(n => (n as any).host && !isFiberServerDown(n as any));
    if (fallback) {
      setActiveBuffer(fallback.networkId, '_server');
      requestSwitchBuffer(fallback.networkId, '_server');
      void loadBufferHistory(fallback.networkId, '_server');
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
    const fallbackNetworkId = ircState.activeBuffer.networkId ?? '';
    const fallbackBufferName = ircState.activeBuffer.bufferName ?? '_server';
    if (!e) {
      channelMenu = { x: 240, y: 80, networkId: fallbackNetworkId, bufferName: fallbackBufferName };
      return;
    }
    const btn = e.currentTarget as HTMLElement | null;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      channelMenu = {
        x: rect.left + rect.width,
        y: rect.top + rect.height + 9,
        networkId: fallbackNetworkId,
        bufferName: fallbackBufferName,
      };
    } else {
      channelMenu = { x: e.clientX, y: e.clientY, networkId: fallbackNetworkId, bufferName: fallbackBufferName };
    }
  }
  function openNetworkOptions(networkId: string, e: MouseEvent): void {
    const btn = e.currentTarget as HTMLElement | null;
    if (btn) {
      const rect = btn.getBoundingClientRect();
      channelMenu = {
        x: rect.left + rect.width,
        y: rect.top + rect.height + 9,
        networkId,
        bufferName: '_server',
      };
    } else {
      channelMenu = { x: e.clientX, y: e.clientY, networkId, bufferName: '_server' };
    }
  }
  function closeChannelMenu(): void {
    channelMenu = null;
  }
</script>
<NotificationBadge />
<NoticeOverlay />

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

<Dialog open={showNetworkForm} onClose={() => showNetworkForm = false} label={networkFormMode === 'add' ? 'Join a new network' : 'Edit network'} centered class="overlay-panel network-form-panel">
  <NetworkForm mode={networkFormMode} networkId={editNetworkId} onClose={() => showNetworkForm = false} />
</Dialog>

<Dialog open={showJoinModal} onClose={() => { showJoinModal = false; joinModalNetworkId = null; }} label="Join a channel" centered class="overlay-panel">
  <JoinModal networkId={joinModalNetworkId} onClose={() => { showJoinModal = false; joinModalNetworkId = null; }} />
</Dialog>

<Dialog open={showBouncerDialog} onClose={() => { showBouncerDialog = false; bouncerNetworkId = null; }} label="Connect with another client" centered class="overlay-panel">
  <BouncerDialog networkId={bouncerNetworkId} onClose={() => { showBouncerDialog = false; bouncerNetworkId = null; }} />
</Dialog>

{#if uploadState.dialog}
  <UploadDialog
    onConfirm={(data) => confirmDialog(data)}
    onCancel={() => cancelDialog()} />
{/if}

{#if channelMenu}
  {@const capturedNetworkId = channelMenu.networkId}
  {@const capturedBufferName = channelMenu.bufferName}
  {@const menuNetwork = ircState.networks.find(n => n.networkId === capturedNetworkId)}
  {@const menuBuf = menuNetwork?.buffers.find(b => b.name === capturedBufferName) ?? (capturedBufferName === '_server' && menuNetwork ? { name: '_server', type: 'server' as const, isJoined: true, unseen: false, unseenCount: 0, unseenHighlights: [], isPinned: false, isArchived: false, topic: '', topicSetBy: '', topicSetAt: 0, users: [], lastSeenMsgTime: null, firstUnseenMsgIndex: null } as any : null)}
  {#if menuNetwork && menuBuf}
    {#if menuBuf.name === '_server'}
      <ServerLogContextMenu
        x={channelMenu.x}
        y={channelMenu.y}
        anchorRight={true}
        buf={menuBuf}
        networkId={capturedNetworkId}
        onClose={closeChannelMenu}
        onJoinChannel={() => { const nid = channelMenu?.networkId; joinModalNetworkId = nid ?? null; showJoinModal = true; closeChannelMenu(); }}
        onEditNetwork={() => { (window as any).__testChannelMenuAtClick = channelMenu ? {networkId: channelMenu.networkId, bufferName: channelMenu.bufferName} : null; const nid = channelMenu?.networkId; (window as any).__testNidAtClick = nid; networkFormMode = 'edit'; editNetworkId = nid ?? null; showNetworkForm = true; closeChannelMenu(); }}
        onBouncer={() => { bouncerNetworkId = channelMenu?.networkId ?? null; showBouncerDialog = true; closeChannelMenu(); }}
      />
    {:else}
      <ChannelContextMenu
        x={channelMenu.x}
        y={channelMenu.y}
        anchorRight={true}
        buf={menuBuf}
        networkId={capturedNetworkId}
        onClose={closeChannelMenu}
        onToggleMembers={toggleMemberPanel}
        memberPanelOpen={memberPanelOpen}
      />
    {/if}
  {/if}
{/if}

<div bind:this={wrapEl} id="wrap" class:has-members={hasMembers && !ircState.showSettings} class:members-collapsed={hasMembers && !memberPanelOpen && !ircState.showSettings} class:sidebar-open={sidebarDrawerOpen} class:mobile-members-open={mobileMembersOpen} class:has-sidebar={ircState.showSettings || ircState.showShortcuts || !isBootLoading} class:unauthenticated={isAuthenticated === false} class:sidebar-collapsed={sidebarCollapsed && !isNarrow}>
  <div class="main-area">
    {#if pasteViewerId !== null}
      <PasteViewerPage id={pasteViewerId} onClose={() => { syncViewers(); navigateBackFromPastebin(); }} />
    {:else if fileViewerId !== null}
      <FileViewerPage id={fileViewerId} onClose={() => { syncFileViewer(); navigateBackFromFileViewer(); }} />
    {:else if ircState.showSettings}
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
        onToggleSidebar={toggleSidebar}
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
    {#if uploadState.panelOpen && !ircState.showSettings && !isShortcutsUrl() && fileViewerId === null && pasteViewerId === null && ircState.networks.length > 0}
      <UploadsPanel onClose={() => uploadState.panelOpen = false} />
    {/if}
    {#if uploadState.pastebinPanelOpen && !ircState.showSettings && !isShortcutsUrl() && fileViewerId === null && pasteViewerId === null && ircState.networks.length > 0}
      <SnippetsPanel onClose={() => uploadState.pastebinPanelOpen = false} />
    {/if}
    {#if ircArtPanelOpen.value && !ircState.showSettings && fileViewerId === null && pasteViewerId === null}
      <IrcArtPanel onClose={() => ircArtPanelOpen.value = false} />
    {/if}
  </div>
  {#if isNarrow && (sidebarDrawerOpen || mobileMembersOpen)}
    <div class="drawer-backdrop" onclick={closeDrawers} role="presentation"></div>
  {/if}
  {#if !isBootLoading && fileViewerId === null && pasteViewerId === null}
  <aside id="sidebar" class:collapsed={sidebarCollapsed && !isNarrow}>
    <Sidebar isCollapsed={sidebarCollapsed && !isNarrow}
             onToggleCollapsed={() => sidebarCollapsed = !sidebarCollapsed}
             onSwitchBuffer={navigateToBuffer}
             onAddNetwork={() => { networkFormMode = 'add'; showNetworkForm = true; }}
             onNetworkOptions={openNetworkOptions}
             onJoinChannel={(networkId) => { joinModalNetworkId = networkId; showJoinModal = true; }} />
  </aside>
  {/if}
</div>
<!-- IRCCloud-style #noAuth overlay: rendered last so it paints on top
     of the chat shell. Visible only while isAuthenticated === false
     (i.e. /api/me returned 401 at boot or LoginPage just kicked off).
     Exception: paste/file viewers are public (branded) — don't obscure them. -->
{#if isAuthenticated === false && !isPastebinUrl() && !isFileViewerUrl() && fileViewerId === null && pasteViewerId === null}
  <LoginPage onAuthenticated={handleAuthenticated} />
{/if}
