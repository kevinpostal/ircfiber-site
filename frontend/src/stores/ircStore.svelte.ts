import type { Network, Buffer, IRCMessage, ActiveBuffer, Member, ModeCategory, OverlayState, ContextMenuState, ConnectionState, RetryStatus, FailInfo } from '../types';
import { MODE_HIERARCHY } from '../types';
import { normalizeChannelName, getUserModePrefix, stripPrefix, naturalCompare, normaliseIdentifier } from '../lib/utils';
import { unreadMap, highlightMap, archivedMap, pinnedMap, hiddenChannelsMap, highlightWords, isIgnored, getLastSeen, setLastSeen, getBottomSeen, setBottomSeen, hideChannel, unhideChannel, networkOrder, conversationsCollapsedMap, getBufferPrefs } from './preferences.svelte';
import { archiveChannel as apiArchiveChannel, unarchiveChannel as apiUnarchiveChannel, normalizeMessage, reconnectNetwork } from './api';
import { sendRaw } from './wsConnection.svelte';
import { appendToProcessed, buildProcessedBuffer, prependReprocess, replaceInProcessedBuffer, type ProcessedBuffer } from '../lib/messageBuilder';
import { recentHighlightersCache } from '../lib/tabCompletion';

// ── Message history memory cap (Step 4a) ──
// JS-side FIFO cap: per-buffer soft limit to bound GC and cold
// preprocessMessages cost. Redis caps 5k/buffer and Mongo is infinite,
// but frontend never evicted — 10k rows caused jank. Cap at 5k keeps
// cold build ≤1ms (bench: preprocess 5k = 0.98ms median) while preserving
// the 200-row DOM window. Evicted history reloads via LoadMore
// beforeid pagination. WASM evaluated 2026-08-13 — DOM-bound, not adopted.
export const MAX_JS_MESSAGES = 5000;
// ── Not-in-channel dedup (404 ERR_CANNOTSENDTOCHAN) ───────────────────
// "No external channel messages (#chan)" floods when the user is not joined
// and keeps typing. We flip isJoined=false on the first 404 and suppress
// subsequent 404s for the same buffer for 30s (show once instead of spamming).
const NOT_IN_CHANNEL_COOLDOWN_MS = 30_000;
const lastNotInChannelAt = new Map<string, number>();
export function shouldSuppressNotInChannel(networkId: string, bufferName: string): boolean {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const last = lastNotInChannelAt.get(key);
  if (last !== undefined && Date.now() - last < NOT_IN_CHANNEL_COOLDOWN_MS) return true;
  lastNotInChannelAt.set(key, Date.now());
  return false;
}
export function clearNotInChannelDedup(networkId: string, bufferName: string): void {
  lastNotInChannelAt.delete(`${networkId}:${normalizeChannelName(bufferName)}`);
}
function isNotInChannelText(text: string): boolean {
  const t = (text || '').toLowerCase();
  return t.includes('no external') || t.includes('not on channel') || t.includes('cannot send to channel') || t.includes("you're not on that channel") || t.includes('you are not on that channel');
}


// ── Single reactive state object ──
export type SettingsTab = 'design' | 'account' | 'notifications' | 'chat' | 'advanced';

/** Tracks user-initiated disconnect per network so the sync handler never
 * overwrites the local 'disconnected' state back to 'connecting'/'connected'.
 * Set by markUserDisconnected() when the user clicks Disconnect, cleared by
 * clearUserDisconnected() when the user explicitly clicks Reconnect.
 * Unlike the old 10-second window, this guard is INDEFINITE — Disconnect
 * means "stop all reconnection attempts" until the user says otherwise.
 * Persisted to localStorage so it survives page refresh — on reload the
 * engine will see the network as disconnected and won't auto-reconnect
 * until the user clicks Connect/Rejoin. */
const DISCONNECTED_KEY = 'ircfiber:userDisconnected';
let _userDisconnectedLoaded = false;
function ensureDisconnectedLoaded(): void {
  if (_userDisconnectedLoaded) return;
  _userDisconnectedLoaded = true;
  try {
    const raw = localStorage.getItem(DISCONNECTED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number') userDisconnectedAt.set(k, v);
      }
    }
  } catch { /* ignore corrupt data */ }
}
function saveUserDisconnected(): void {
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of userDisconnectedAt) obj[k] = v;
    localStorage.setItem(DISCONNECTED_KEY, JSON.stringify(obj));
  } catch { /* storage full */ }
}
const userDisconnectedAt: Map<string, number> = new Map();
export function markUserDisconnected(networkId: string): void {
  ensureDisconnectedLoaded();
  userDisconnectedAt.set(networkId, Date.now());
  saveUserDisconnected();
}
export function clearUserDisconnected(networkId: string): void {
  ensureDisconnectedLoaded();
  userDisconnectedAt.delete(networkId);
  saveUserDisconnected();
}
export function isUserDisconnected(networkId: string): boolean {
  ensureDisconnectedLoaded();
  return userDisconnectedAt.has(networkId);
}

export const ircState = $state({
  networks: [] as Network[],
  activeBuffer: { networkId: null, bufferName: null } as ActiveBuffer,
  messages: {} as Record<string, IRCMessage[]>,
  // Incremental preprocessing cache (IRCCloud-style). Keyed by buffer
  // key (`networkId:bufferName`). Each entry holds the raw messages and
  // their already-grouped form so appending a single new PRIVMSG doesn't
  // re-group the full 10k-message buffer.
  processedMessages: {} as Record<string, IRCMessage[]>,
  me: null as { username: string; email: string } | null,
  wsConnected: false,
  focusLost: false,
  lastSeenMsgTime: null as number | null,
  optimisticMessages: new Map<string, IRCMessage>(),
  overlay: { type: null, data: null } as OverlayState,
  contextMenu: { visible: false, x: 0, y: 0, actions: [] } as ContextMenuState,
  showSettings: false,
  settingsTab: 'design' as SettingsTab,
  showShortcuts: false,
  // Nicks the user has explicitly requested WHOIS for (via /whois or the
  // user-popup "Whois" action). The server also sends automatic WHOIS
  // queries on JOIN to discover realnames (see ircfiber/irc/connection.d),
  // but those should NOT pop up the WHOIS overlay or inline block.
  // We store the originating buffer so the inline WHOIS_GROUP can be
  // appended to the right channel/query (IRCCloud shows WHOIS where you
  // typed /whois, not always in the active buffer at response time).
  pendingWhois: new Map<string, { networkId: string; bufferName: string; ts: number }>(),
  // was the earliest rendered message before the last backlog fetch. The
  // divider row renders immediately above it (BufferLogView.renderBacklogDivider).
  // Only one divider exists per buffer at a time; cleared on buffer switch
  // (IRCCloud re-renders the log fresh on select).
  backlogDivider: {} as Record<string, string>,
  // IRCCloud-style backlog discontinuity tracking: per-buffer record of the
  // earliest known eid and a timer. When prependMessages detects a gap
  // between the new batch's earliest eid and our cached earliest, we flag a
  // discontinuity so the UI can show "Load more backlog" even if the API
  // says there's nothing more.
  backlogDiscontinuity: {} as Record<string, { earliestEid: number; timer: ReturnType<typeof setTimeout> }>,
  // Monotonic counter incremented every time InputArea sends an outgoing
  // message (via requestForceScrollToBottom()). MessageList reads this
  // and snaps to bottom even when the user has scrolled up — IRCCloud
  // always scrolls to the user's own message so they can confirm what
  // they sent, regardless of scroll position. The counter (not a
  // boolean) ensures the same value incrementing again still triggers
  // a re-run if needed (e.g. multiple sends in the same micro-task).
  forceScrollToBottomNonce: 0,
  // Per-buffer typing state: bufferKey -> (nick -> timestamp of last TAGMSG)
  typing: {} as Record<string, Record<string, number>>,
  // Invalidation counter for typing displays. clearTyping tombstones via
  // a deep SET (the tracked path) and this counter is bumped on every
  // set/clear as belt-and-suspenders — consumers (InputArea) read it so
  // a display derived can never miss a typing-state change.
  typingVersion: 0,
  // IRCCloud-style "reorder mode": when true, the Sidebar enters drag-and-drop
  // reorder for the network list and suppresses normal click/collapse on
  // network headers. Toggled by the "Reorder Networks" / "Done" buttons.
  reorderMode: false,
  // W1-T08: temp_unavailable state per buffer. Keyed by `${networkId}:${bufferName}`.
  // expireAt = serverTs + countdownMs (unix ms). The UI computes remaining
  // = max(0, expireAt - Date.now()).
  tempUnavailable: {} as Record<string, { expireAt: number }>,
  // IRCCloud-style badge pulse: buffer keys that should briefly pulse their
  // unread badge on the next render (set when unread count increments,
  // auto-cleared after 300ms). The Sidebar reads this to add the .pulse class.
  pulseBuffers: new Set<string>(),
});

// E2E hooks for load-more verification
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__fiberIrcState = ircState;
  (window as unknown as Record<string, unknown>).__fiberBatchAppendMessages = batchAppendMessages;
}

// IRCCloud-style previous-buffer tracking: the buffer that was active before
// the current one. Used by archiveBuffer to select where focus goes.
let previousBuffer: { networkId: string | null; bufferName: string | null } = { networkId: null, bufferName: null };

// ── Pending nick changes (real-time NICK events vs. stale sync snapshots) ──
// The periodic /api/sync snapshot is taken on a timer (see ircStore:1138 comment
// for the `currentNick` guard that protects our own nick). Sync snapshots can
// be taken before a fresh /nick propagates to the engine, so overwriting
// `buf.users` blindly would revert nick changes in the members list even
// though `currentNick` (typing-area indicator) survives. We track old → new
// nick pairs here; the sync applies our local nick for any user that has a
// pending change, then clears the entry once the sync confirms the new nick.
// Keyed by `${networkId}:${bufferName}:${oldBareNick}`.
const pendingNickChanges: Map<string, { newNick: string; setAt: number }> = new Map();
/** Exported for test cleanup only — clears all pending nick change entries. */
export function clearPendingNickChanges(): void { pendingNickChanges.clear(); }
// Auto-clear stale pending entries after 60s in case a sync never confirms.
const PENDING_NICK_TTL_MS = 60_000;
// How long a /nick attempt stays pending before we give up on the echo
// and stop treating it as authoritative for self-detection. Generous
// enough to cover one engine snapshot cycle (10s) plus a slow IRC server
// echo on a flakey connection.
const PENDING_SELF_NICK_TTL_MS = 30_000;
// How long after a local nick change event the sync's currentNick is
// treated as potentially stale. Sync snapshots are taken every ~10s and
// may carry the old nick for up to one cycle after the engine processes
// the change. 2 × sync interval (20s) is enough for the engine to catch
// up even on a busy reactor.
const NICK_SYNC_COOLDOWN_MS = 20_000;

// ── W7-T02: orphan reconciliation guard ──
// The engine publishes its channelState snapshot every ~10s. A buffer
// missing from a single snapshot does NOT mean the user left — the
// snapshot can lag a JOIN that just propagated (e.g. immediately after
// an engine restart or during a busy reconnect window). Without a guard,
// the frontend flipped isJoined: true → false on the very next sync and
// surfaced a bogus Rejoin button in BufferHeader — exactly the symptom
// reported on `#superbowl` (SuperNets).
//
// ORPHAN_FLIP_THRESHOLD = 3 consecutive missed syncs (~30s) before we
// trust the orphan reconciliation enough to mark the channel as parted.
// At that point the engine has consistently omitted the channel across
// multiple sync cycles, which only happens for genuinely stale state.
const ORPHAN_FLIP_THRESHOLD = 3;

// ── W1-T08: tempUnavailable helpers ──
export function setTempUnavailable(networkId: string, bufferName: string, expireAt: number): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  ircState.tempUnavailable[key] = { expireAt };
}

export function clearTempUnavailable(networkId: string, bufferName: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  delete ircState.tempUnavailable[key];
}

export function getTempUnavailable(networkId: string, bufferName: string): { expireAt: number } | undefined {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  return ircState.tempUnavailable[key];
}

// ── Per-buffer input history (IRCCloud-style) ──
// Preserves unsent text across buffer switches. Not reactive — InputArea
// reads it on activeBuffer change.
export const bufferInputText = new Map<string, string>();

function inputKey(networkId: string, bufferName: string): string {
  return `${networkId}:${normalizeChannelName(bufferName)}`;
}

function sameMsg(a: IRCMessage, b: IRCMessage): boolean {
  if (a.eid != null && b.eid != null) return a.eid === b.eid;
  if (a.msgid && b.msgid) return a.msgid === b.msgid;
  return false;
}

export function setBufferInputText(networkId: string, bufferName: string, text: string): void {
  const key = inputKey(networkId, bufferName);
  if (text) bufferInputText.set(key, text);
  else bufferInputText.delete(key);
}

export function getBufferInputText(networkId: string, bufferName: string): string {
  return bufferInputText.get(inputKey(networkId, bufferName)) || '';
}
// Note: $derived cannot be exported directly. Export as functions for reactive reads.
export function getActiveNetwork(): Network | null {
  return ircState.networks.find(n => n.networkId === ircState.activeBuffer.networkId) ?? null;
}

export function getActiveBufferObj(): Buffer | null {
  return getActiveNetwork()?.buffers.find(b => b.name === ircState.activeBuffer.bufferName) ?? null;
}

export function getIsServerBuffer(): boolean {
  return ircState.activeBuffer.bufferName === '_server';
}

export function getTotalUnread(): number {
  return Object.values(unreadMap).reduce((sum, n) => sum + (n || 0), 0);
}

export function getHasHighlight(): boolean {
  return Object.values(highlightMap).some(v => v);
}

// ── Actions ──
export function setReorderMode(value: boolean): void {
  ircState.reorderMode = value;
}

export function setActiveBuffer(networkId: string, bufferName: string): void {
  // Only normalize channel names (starting with #). Nick-based query/DM
  // buffers must keep their original casing and must NOT get a '#' prepended,
  // otherwise a nick like "Zod" gets normalized to "#zod" and matches the
  // wrong buffer (e.g. the #Zod channel instead of a DM to user Zod).
  if (bufferName.startsWith('#')) {
    bufferName = normalizeChannelName(bufferName);
  }

  // Track previous buffer (IRCCloud-style) for archive focus selection
  const prevNetworkId = ircState.activeBuffer.networkId;
  const prevBufferName = ircState.activeBuffer.bufferName;
  const isBufferChange =
    prevNetworkId !== networkId || prevBufferName !== bufferName;
  if (prevNetworkId && prevBufferName && isBufferChange) {
    previousBuffer = { networkId: prevNetworkId, bufferName: prevBufferName };
  }

  ircState.activeBuffer.networkId = networkId;
  ircState.activeBuffer.bufferName = bufferName;
  // Any buffer switch (URL navigation, sidebar click, /join, nick click)
  // should snap MessageList to the bottom of the new buffer — the user
  // is going there to see what's new, not to land at scrollTop 0 of an
  // already-loaded buffer. We skip the _server view because the server
  // log is a fixed-content view where the user owns their scroll position
  // while inspecting connection history.
  if (isBufferChange && bufferName !== '_server') {
    requestForceScrollToBottom();
  }
  // Clear temp_unavailable on buffer switch (W1-T08)
  clearTempUnavailable(networkId, bufferName);
  // Auto-expand the Conversations section in the sidebar when switching
  // to a query/DM buffer — matches IRCCloud behavior.
  if (bufferName && !bufferName.startsWith('#') && bufferName !== '_server') {
    conversationsCollapsedMap[networkId] = false;
  }
  const key = `${networkId}:${bufferName}`;
  delete unreadMap[key];
  delete highlightMap[key];
  // IRCCloud re-renders the log fresh on buffer select — no stale divider.
  delete ircState.backlogDivider[key];
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) {
    let buf = net.buffers.find(b => b.name === bufferName);
    if (!buf) {
      // Auto-create buffer when navigating to a channel or query that doesn't
      // exist yet (e.g. joining a +R channel that rejected the JOIN, or
      // clicking a nick to open a query). This ensures the buffer shows in
      // the sidebar so the user can see error/reply messages. Channels are
      // marked isPhantom so the engine sync can adopt the real isJoined
      // value (instead of locking in our false guess) and we don't end up
      // with a channel sitting in the "Inactive" section forever.
      const isChannel = bufferName.startsWith('#');
      buf = {
        name: bufferName,
        type: isChannel ? 'channel' : 'query',
        isJoined: isChannel ? false : true,
        isPhantom: isChannel,
        unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
        topic: '', topicSetBy: '', topicSetAt: 0, users: [],
        lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      } as Buffer;
      net.buffers.push(buf);
      sortBuffers(net);
    } else {
      buf.unreadCount = 0; buf.highlight = false; buf.highlightCount = 0;
      // If we found the buffer it's no longer a placeholder — the user
      // is actively looking at it, so future JOIN/PART events should
      // drive isJoined from here on.
      if (buf.isPhantom) buf.isPhantom = false;
    }
  }
  ircState.lastSeenMsgTime = null;
  ircState.focusLost = false;
  // Mark all current messages as read when switching to a buffer
  const msgs = ircState.messages[key] ?? [];
  if (msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg.t) {
      setLastSeen(networkId, bufferName, lastMsg.t);
      setBottomSeen(networkId, bufferName, lastMsg.t);
      // Also set per-buffer state on the Buffer object
      const buf = net?.buffers.find(b => b.name === bufferName);
      if (buf) {
        buf.lastSeen = lastMsg.t;
        buf.bottomSeen = lastMsg.t;
      }
    }
  }
}

// Select the next buffer to focus after the current one is closed/deleted.
// Mirrors IRCCloud: previousBuffer first, then the channel above, then below,
// then the server buffer.
function selectNextBufferAfterClose(networkId: string, bufferName: string): { networkId: string; bufferName: string } {
  // Priority 1: IRCCloud-style previousBuffer (may be on another network).
  if (previousBuffer.networkId && previousBuffer.bufferName) {
    const prevKey = `${previousBuffer.networkId}:${previousBuffer.bufferName}`;
    if (!archivedMap[prevKey] && !hiddenChannelsMap[prevKey]) {
      const prevNet = ircState.networks.find(n => n.networkId === previousBuffer.networkId);
      if (prevNet) {
        const prevBuf = prevNet.buffers.find(b => b.name === previousBuffer.bufferName);
        if (prevBuf && prevBuf.isJoined !== false) {
          return { networkId: previousBuffer.networkId, bufferName: previousBuffer.bufferName };
        }
      }
    }
  }

  // Priority 2: channel above in the same network's visible list (IRCCloud's getPreviousBufferFromConnection).
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) {
    const visibleBuffers = net.buffers.filter(b =>
      b.name !== '_server' &&
      b.isJoined !== false &&
      !archivedMap[`${networkId}:${b.name}`] &&
      !hiddenChannelsMap[`${networkId}:${b.name}`]
    );

    const currentIdx = visibleBuffers.findIndex(b => b.name === bufferName);

    if (currentIdx > 0) {
      return { networkId, bufferName: visibleBuffers[currentIdx - 1].name };
    }

    if (currentIdx >= 0 && currentIdx < visibleBuffers.length - 1) {
      return { networkId, bufferName: visibleBuffers[currentIdx + 1].name };
    }
  }

  return { networkId, bufferName: '_server' };
}

// Archive a buffer and switch focus to the channel above (IRCCloud-compatible).
// Only changes focus if the archived buffer is the currently active buffer.
// Priority: previousBuffer > channel above > channel below > server buffer > other networks.
export function archiveBuffer(networkId: string, bufferName: string): void {
  bufferName = normalizeChannelName(bufferName);
  if (bufferName === '_server') return;

  const key = `${networkId}:${bufferName}`;
  if (archivedMap[key]) return;

  archivedMap[key] = true;

  // Persist to the server so it syncs cross-device and across tabs in real
  // time. On failure, roll back the local state.
  apiArchiveChannel(networkId, bufferName).catch((err) => {
    console.error('Archive failed:', err);
    delete archivedMap[key];
  });

  const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === bufferName;
  if (!isActive) return;

  const next = selectNextBufferAfterClose(networkId, bufferName);
  setActiveBuffer(next.networkId, next.bufferName);
}

// Restores an archived buffer. Removes it from the archive list and
// propagates the change to the server (which broadcasts to other tabs
// and devices).
export function unarchiveBuffer(networkId: string, bufferName: string): void {
  bufferName = normalizeChannelName(bufferName);
  const key = `${networkId}:${bufferName}`;
  if (!archivedMap[key]) return;

  delete archivedMap[key];

  apiUnarchiveChannel(networkId, bufferName).catch((err) => {
    console.error('Unarchive failed:', err);
    archivedMap[key] = true;
  });
}

// Delete a buffer permanently and move focus to the last active buffer
// (IRCCloud-compatible). Persistently hides the channel so it does not
// reappear on the next sync.
export function deleteBuffer(networkId: string, bufferName: string): void {
  bufferName = normalizeChannelName(bufferName);
  if (bufferName === '_server') return;

  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;

  // Decide where focus goes *before* removing the buffer, because the
  // visible-list fallback needs the deleted buffer's position to pick the
  // channel above/below it.
  const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === bufferName;
  const next = isActive ? selectNextBufferAfterClose(networkId, bufferName) : null;

  const idx = net.buffers.findIndex(b => b.name === bufferName);
  if (idx >= 0) net.buffers.splice(idx, 1);

  hideChannel(networkId, bufferName);

  if (!next) return;
  setActiveBuffer(next.networkId, next.bufferName);
}

// ── W1-T06: buffersToDelete wire + activeJoinList tracking ──

/** Tracks channels the user has actively joined this session.
 *  Keyed by `${networkId}:${bufferName}`. Cleared on PART/KICK for self.
 *  Used by `handleBuffersToDelete` to guard against deleting buffers the
 *  user just re-joined (the JOIN event may arrive after the sync + the
 *  buffersToDelete message during WS resume). */
export const activeJoinList: Set<string> = $state(new Set());

export function recordJoin(networkId: string, bufferName: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  activeJoinList.add(key);
}

export function clearActiveJoin(networkId: string, bufferName: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  activeJoinList.delete(key);
}

// ── W7-T01: pendingJoins dedup so URL navigation doesn't spam JOIN ──
//
// Tracks channels for which the frontend has issued a JOIN but has not yet
// seen the server echo. Keyed by `${networkId}:${bufferName}`. Cleared on
// JOIN for self, on JOIN failure numerics, and on explicit clear. The
// switchToBuffer helper consults this set before issuing a fresh JOIN.

export const pendingJoins: Set<string> = $state(new Set());

export function pendingJoinKey(networkId: string, bufferName: string): string {
  return `${networkId}:${normalizeChannelName(bufferName)}`;
}

export function isJoinPending(networkId: string, bufferName: string): boolean {
  return pendingJoins.has(pendingJoinKey(networkId, bufferName));
}

export function markJoinPending(networkId: string, bufferName: string): void {
  pendingJoins.add(pendingJoinKey(networkId, bufferName));
}

export function clearJoinPending(networkId: string, bufferName: string): void {
  pendingJoins.delete(pendingJoinKey(networkId, bufferName));
}

// ── W1-T01: initiateRejoin helper ──
//
// Single canonical entry point for all user-initiated JOIN attempts.
// Replaces divergent inline bodies in BufferHeader.rejoin,
// ChannelContextMenu.rejoin, /cycle|/hop|/rejoin slash, and
// maybeAutoJoinChannel. The full state-machine quartet (joinError=null,
// joinInFlight=true, pendingIsJoined=true, pendingConfirmations=2) plus
// markJoinPending + recordJoin + sendRaw('JOIN <name>') are set here so
// every rejoin entry point gets identical optimistic UX and identical
// sync-clobber protection.
//
// Idempotency: a JOIN already in flight for this buffer blocks a second
// issuance (mirrors maybeAutoJoinChannel's pre-helper guard at
// App.svelte:557). Self-nick pre-population (prePopulateOwnNick) makes
// the member panel include the user within one tick, even before the
// engine's JOIN echo and NAMES (353) responses arrive — the 353
// handler's in-place promotion at line 1696 then upgrades the bare nick
// to the prefixed form when services grant auto-op on JOIN.

/**
 * Add the current user's nick to buf.users so the member panel renders
 * "you" within one tick of click. Uses stripPrefix-safe dedup so the
 * 353 handler's in-place promotion at line 1696-1701 still works when
 * the server's NAMES reply arrives with a prefixed form (e.g. `@me`).
 */
function prePopulateOwnNick(buf: Buffer, currentNick: string): void {
  if (!buf.users) buf.users = [];
  const stripped = stripPrefix(currentNick);
  if (buf.users.some(u => stripPrefix(u.nick) === stripped)) return;
  buf.users.push({
    nick: currentNick, prefix: '', category: 'MEMBER',
    ident: '', realname: '', isAway: false, awayMessage: '',
    lastSpoke: 0, lastHighlighted: 0, account: '', isBot: false
  });
}

export interface InitiateRejoinOptions {
  /** When true, kick reconnectNetwork() if !network.connected.
   *  Defaults to false — only the BufferHeader Rejoin button wants to
   *  reconnect; context-menu / slash / URL-nav should let the existing
   *  connection-recovery paths handle that. */
  allowReconnect?: boolean;
}

/**
 * Issue a user-initiated JOIN for `bufferName` on `networkId`.
 *
 * Sets the full state-machine quartet (joinInFlight=true, joinError=null,
 * pendingIsJoined=true, pendingConfirmations=2) on the buffer, marks the
 * join as pending (dedup via isJoinPending), records it in activeJoinList
 * (buffersToDelete guard), pre-populates self-nick into buf.users, and
 * sends JOIN <bufferName>. Optional `opts.allowReconnect` kicks the
 * engine reconnect when the network is disconnected — only the
 * BufferHeader Rejoin button wants this; context-menu / slash / URL-nav
 * let the existing connection-recovery paths handle that.
 *
 * No-op when a JOIN is already in flight for this buffer (idempotent).
 */
export function initiateRejoin(
  networkId: string,
  bufferName: string,
  opts: InitiateRejoinOptions = {}
): void {
  const normalized = normalizeChannelName(bufferName);
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  let buf = net.buffers.find(b => b.name === normalized);

  // Idempotency: if a JOIN is already in flight for this buffer, the
  // existing pendingJoins entry blocks double-issuance. Mirrors
  // maybeAutoJoinChannel's guard at App.svelte:557.
  if (isJoinPending(networkId, normalized)) return;

  // If the buffer doesn't exist locally, create it so the sidebar
  // shows the channel immediately and the join-in-flight chip appears.
  // The JOIN echo from the engine will promote it to isJoined=true.
  if (!buf) {
    buf = {
      name: normalized, type: 'channel', isJoined: false,
      unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
      topic: '', topicSetBy: '', topicSetAt: 0, users: [],
      lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      lastSeen: null, bottomSeen: null, clearedAt: null, modeFlags: {},
      joinInFlight: true, pendingIsJoined: true, pendingConfirmations: 2, joinError: null,
    };
    net.buffers.push(buf);
    sortBuffers(net);
  }

  // Set the FULL state-machine quartet. This is the single source
  // of truth — every caller sets all four flags.
  buf.joinError = null;          // clear stale failure text
  buf.joinInFlight = true;       // drives BufferHeader chip + sidebar modifier
  buf.pendingIsJoined = true;    // belt-and-suspenders for WS-round-trip clobber
  buf.pendingConfirmations = 2;  // require TWO confirming syncs to clear
  // W1-T06: track user-initiated JOIN so buffersToDelete during WS
  // resume cannot reap this buffer.
  prePopulateOwnNick(buf, net.currentNick);
  markJoinPending(networkId, normalized);
  recordJoin(networkId, normalized);
  sendRaw(networkId, 'JOIN ' + normalized);

  if (opts.allowReconnect && !net.connected) {
    reconnectNetwork(networkId).catch(() => {});
  }
}

/**
 * Reset in-flight JOIN tracking when the WebSocket reconnects.
 *
 * When the WS drops between a JOIN command and its echo, two categories
 * of state can remain stuck:
 *
 * 1. `pendingJoins` — blocks `maybeAutoJoinChannel` via `isJoinPending`,
 *    preventing URL auto-join from ever sending another JOIN.
 * 2. `joinInFlight` / `pendingIsJoined` — buffer-level flags that
 *    prevent the sync from correcting `isJoined` (the orphan-reconciliation
 *    loop at updateNetworkFromSync skips buffers with `joinInFlight === true`).
 *
 * On reconnect the engine replays events via `?since=maxEid`, so stale
 * pending state must be cleared to avoid permanently blocking future joins.
 *
 * Does NOT clear `activeJoinList`: that set is a short-term guard against
 * `buffersToDelete` (sent during WS resume) and must survive the reconnect
 * window so freshly-joined buffers aren't deleted before the engine's sync
 * confirms their membership.
 *
 * Called from `App.svelte`'s `onOpen` WS callback before the first
 * sync arrives.
 */
export function resetPendingState(): void {
  pendingJoins.clear();
  for (const net of ircState.networks) {
    for (const buf of net.buffers) {
      buf.joinInFlight = false;
      buf.pendingIsJoined = undefined;
      buf.pendingConfirmations = undefined;
    }
  }
}

/** Handle `buffersToDelete` WS message from the engine.
 *  Gated behind `globalPrefs.featureFlags.buffersToDelete.enabled`.
 *  For each bid, guards against deleting channels the user recently joined
 *  (activeJoinList) or intentionally preserved (pinned/archived/hidden). */
export function handleBuffersToDelete(bidList: string[]): void {
  if (bidList.length === 0) return;

  const guardKeys = new Set<string>();
  // Build a lookup of guard-relevant keys
  for (const key of activeJoinList) guardKeys.add(key);
  for (const key of Object.keys(archivedMap)) if (archivedMap[key]) guardKeys.add(key);
  for (const key of Object.keys(pinnedMap)) if (pinnedMap[key]) guardKeys.add(key);
  for (const key of Object.keys(hiddenChannelsMap)) if (hiddenChannelsMap[key]) guardKeys.add(key);

  for (const bid of bidList) {
    // Parse `networkId:bufferName` from the bid string.
    // Format: "<networkId>:<bufferName>" (e.g. "a1b2c3:#foo")
    const colonIdx = bid.indexOf(':');
    if (colonIdx < 0) continue;
    const networkId = bid.slice(0, colonIdx);
    const bufferName = normalizeChannelName(bid.slice(colonIdx + 1));
    if (!networkId || !bufferName || bufferName === '_server') continue;

    // Guard: skip if the user just re-joined (JOIN event may be delayed)
    const key = `${networkId}:${bufferName}`;
    if (guardKeys.has(key)) continue;

    deleteBuffer(networkId, bufferName);
  }
}

export function prependMessage(networkId: string, bufferName: string, msg: IRCMessage): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];

  if (msg.eid && list.some((m: IRCMessage) => m.eid === msg.eid)) return;
  if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) return;

  list.unshift(msg);
  // FIFO cap: bound JS memory. If unshift pushes over limit, keep newest tail.
  const cappedPre = list.length > MAX_JS_MESSAGES ? list.slice(-MAX_JS_MESSAGES) : list;
  ircState.messages[key] = cappedPre;
  // Prepending shifts the head boundary; rebuild the processed buffer
  // from the prepended tail to keep the head group valid.
  ircState.processedMessages[key] = buildProcessedBuffer(cappedPre);
  markNetworkSeen(networkId);
}

export function appendMessage(networkId: string, bufferName: string, msg: IRCMessage): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  if (msg.label && ircState.optimisticMessages.has(msg.label)) {
    ircState.optimisticMessages.delete(msg.label);
    const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
    if (idx >= 0) {
      const optimistic = list[idx];
      list[idx] = msg;
      ircState.messages[key] = list;
      // Swap the stale optimistic entry for the server echo in O(n) —
      // no full preprocessMessages call. The old code rebuilt the entire
      // processed cache on every echo, which made typing 10 messages in a
      // row lag visibly (10 × preprocessMessages(N) ≈ 10× render-blocking
      // work for every buffer that was already populated).
      const replaced = ircState.processedMessages[key]
        ? replaceInProcessedBuffer(ircState.processedMessages[key], optimistic, msg)
        : null;
      ircState.processedMessages[key] = replaced ?? buildProcessedBuffer(list);
      return;
    }
  }

  // Edit-echo label match: when sendEditMessage re-uses the original
  // label, the echo arrives with that same label but the optimistic
  // entry was already consumed by the first echo. Replace in-place.
  if (msg.label) {
    const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
    if (idx >= 0) {
      const optimistic = list[idx];
      list[idx] = msg;
      ircState.messages[key] = list;
      const replaced = ircState.processedMessages[key]
        ? replaceInProcessedBuffer(ircState.processedMessages[key], optimistic, msg)
        : null;
      ircState.processedMessages[key] = replaced ?? buildProcessedBuffer(list);
      return;
    }
  }

  // Self-echo fallback: server echo without label — match optimistic
  // by text content to avoid duplicate when labeled-response is absent.
  // Also triggers for unlabeled self messages even if `msg.selfEcho` is
  // missing (e.g. server without echo-message cap tags, or synthetic race).
  const netForSelf = ircState.networks.find(n => n.networkId === networkId);
  const curNick = netForSelf?.currentNick || netForSelf?.nick || '';
  const isSelf = !!msg.nick && !!curNick && msg.nick.toLowerCase() === curNick.toLowerCase() && msg.command === 'PRIVMSG';
  if (msg.selfEcho || isSelf) {
    for (const [optLabel, optMsg] of ircState.optimisticMessages) {
      // Compare nicks case-insensitively: the IRC server's echo may use
      // a different casing (e.g. "Zod") than the local currentNick
      // ("zod"), causing the strict equality to miss the match.
      // Also trim trailing \r that the IRC parser may leave on the echo
      // (e.g. "https://youtu.be/..." vs "https://youtu.be/...\r").
      const optText = (optMsg.text ?? '').trim();
      const echoText = (msg.text ?? '').trim();
      if (optText === echoText && optMsg.nick.toLowerCase() === msg.nick.toLowerCase() && optMsg.command === 'PRIVMSG') {
        ircState.optimisticMessages.delete(optLabel);
        const idx = list.findIndex((m: IRCMessage) => m.label === optLabel);
        if (idx >= 0) {
          const optimistic = list[idx];
          // row, causing a visible flicker + double entrance animation.
          if (!msg.label) msg.label = optLabel;
          list[idx] = msg;
          ircState.messages[key] = list;
          const replaced = ircState.processedMessages[key]
            ? replaceInProcessedBuffer(ircState.processedMessages[key], optimistic, msg)
            : null;
          ircState.processedMessages[key] = replaced ?? buildProcessedBuffer(list);
          return;
        }
      }
    }
    // Synthetic+echo race: when echo-message is absent the engine emits a
    // synthetic with label=optLabel; when labeled-response is also absent
    // the server echo arrives WITHOUT a label (selfEcho, no le). The
    // synthetic already consumed the optimistic map, so the loop above
    // finds nothing. Without this fallback the echo would be appended as
    // a second copy. Search the live list for the synthetic we just
    // placed (same nick+trimmed text, same command) and replace it.
    // This is the #zod duplicate (user sees 2 rows for 1 send).
    const echoTrim = (msg.text ?? '').trim();
    const echoNickLower = (msg.nick ?? '').toLowerCase();
    // Walk backwards — the synthetic is at the tail for this buffer.
    for (let i = list.length - 1; i >= 0; i--) {
      const existing = list[i];
      if ((existing.text ?? '').trim() === echoTrim && (existing.nick ?? '').toLowerCase() === echoNickLower && existing.command === msg.command) {
        // Guard: only replace if the existing entry is recent and looks
        // like a pending/optimistic row (has a label but no eid/msgid yet,
        // or was created within 30s). Without this, a user who legitimately
        // sends the same text twice would have the second send swallowed.
        const isPendingLike = !!existing.label && !existing.eid && !existing.msgid;
        const isRecent = !existing.t || (Date.now() - existing.t) < 30_000;
        if (!isPendingLike && !isRecent) continue;
        const optimistic = existing;
        if (!msg.label && existing.label) msg.label = existing.label;
        if (existing.label) ircState.optimisticMessages.delete(existing.label);
        list[i] = msg;
        ircState.messages[key] = list;
        const replaced = ircState.processedMessages[key]
          ? replaceInProcessedBuffer(ircState.processedMessages[key], optimistic, msg)
          : null;
        ircState.processedMessages[key] = replaced ?? buildProcessedBuffer(list);
        return;
      }
    }
  }

  if (msg.eid && list.some((m: IRCMessage) => m.eid === msg.eid)) return;
  if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) return;

  // Final self-echo dedup: even if `isSelf` was false (curNick not found), a
  // pending optimistic anywhere in the tail with same text/nick is almost certainly
  // the same send. This catches the #zod double where the echo arrives
  // without `se` and curNick lookup fails due to timing, or where an
  // intervening server notice pushes the optimistic off the tail.
  for (let i = list.length - 1; i >= 0; i--) {
    const cand = list[i];
    if (cand.label && !cand.eid && !cand.msgid && (cand.text ?? '').trim() === (msg.text ?? '').trim() && (cand.nick ?? '').toLowerCase() === (msg.nick ?? '').toLowerCase() && cand.command === msg.command && Math.abs((cand.t || 0) - (msg.t || 0)) < 30000) {
      if (!msg.label && cand.label) msg.label = cand.label;
      if (cand.label) ircState.optimisticMessages.delete(cand.label);
      list[i] = msg;
      ircState.messages[key] = list;
      const replaced = ircState.processedMessages[key] ? replaceInProcessedBuffer(ircState.processedMessages[key], cand, msg) : null;
      ircState.processedMessages[key] = replaced ?? buildProcessedBuffer(list);
      return;
    }
  }

  // Sorted insert for burst determinism: if the new msg is older than the
  // tail (e.g. WS batch delivered out-of-order), insert at the correct
  // position rather than blindly pushing. In the common case tail is
  // newest, so this is a single comparison + push.
  if (list.length > 0) {
    const tail = list[list.length - 1];
    if (compareMessages(tail, msg) > 0) {
      // Out-of-order — find insertion point (binary-ish linear scan from tail
      // is cheap because burst reorders are local and the buffer is capped).
      let idx = list.length - 1;
      while (idx > 0 && compareMessages(list[idx - 1], msg) > 0) idx--;
      list.splice(idx, 0, msg);
      ircState.messages[key] = list;
      ircState.processedMessages[key] = buildProcessedBuffer(list);
      const normBuf2 = normalizeChannelName(bufferName);
      const isActive2 = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf2;
      const isChatMessage2 = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
      const isUnread2 = isChatMessage2 && (!isActive2 || ircState.focusLost);
      if (isUnread2) incrementUnread(networkId, bufferName, msg);
      markNetworkSeen(networkId);
      return;
    }
  }
  list.push(msg);
  ircState.messages[key] = list;

  // Incremental preprocessing: only regroup the new tail (and the
  // previous tail group, if any, in case it merges with the new message).
  if (ircState.processedMessages[key]) {
    ircState.processedMessages[key] = appendToProcessed(
      ircState.processedMessages[key],
      [msg],
    );
  }
  // FIFO cap: bound JS memory + cold preprocess.
  if (ircState.messages[key].length > MAX_JS_MESSAGES) {
    const capped = ircState.messages[key].slice(-MAX_JS_MESSAGES);
    ircState.messages[key] = capped;
    ircState.processedMessages[key] = buildProcessedBuffer(capped);
  }

  const normBuf = normalizeChannelName(bufferName);
  const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf;
  const isChatMessage = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
  const isUnread = isChatMessage && (!isActive || ircState.focusLost);
  if (isUnread) {
    incrementUnread(networkId, bufferName, msg);
  }
  markNetworkSeen(networkId);
}

// IRCCloud-style batch append: processes multiple messages for the same
// buffer at once so Svelte only triggers a single reactive update instead
// of one per message. The batcher already collects messages over 200ms,
// but the per-message state assignment still caused N reactive ticks per
// flush. This eliminates the jitter when a large backlog arrives.
// Burst-order guard: live messages that arrive in the same millisecond
// (ascii art pasted as 10 PRIVMSGs with identical server-time) must
// render in eid order, not arrival order. History (REST + prependMessages)
// already sorts by t→eid; the live path was trusting arrival order, which
// races under WS batching. One shared comparator keeps every insertion
// deterministic.
function compareMessages(a: IRCMessage, b: IRCMessage): number {
  const ta = a.t ?? 0;
  const tb = b.t ?? 0;
  if (ta !== tb) return ta - tb;
  if (a.eid != null && b.eid != null) return a.eid - b.eid;
  if (a.eid != null) return -1;
  if (b.eid != null) return 1;
  return (a.msgid ?? '').localeCompare(b.msgid ?? '');
}

export function batchAppendMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  // Deterministic burst order: ascii art lines share the same t, so
  // arrival order must not decide render order. Sort once so the
  // pending list and processed buffer are always t→eid stable.
  if (msgs.length > 1) msgs = [...msgs].sort(compareMessages);
  if (msgs.length === 0) return;

  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  const seenEids = new Set<number>();
  const seenMsgids = new Set<string>();
  for (const m of list) {
    if (m.eid != null) seenEids.add(m.eid);
    if (m.msgid) seenMsgids.add(m.msgid);
  }
  const pending: IRCMessage[] = [];
  const newForProcessed: IRCMessage[] = [];
  let addedUnread = 0;
  let addedHighlights = 0;
  let hasChat = false;
  let replacedEdit = false;
  const netForBatchHl = ircState.networks.find(n => n.networkId === networkId) ?? null;
  for (const msg of msgs) {
    if (msg.label && ircState.optimisticMessages.has(msg.label)) {
      ircState.optimisticMessages.delete(msg.label);
      const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
      if (idx >= 0) {
        list[idx] = msg;
        replacedEdit = true;
        continue;
      }
    }
    if (msg.label) {
      const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
      if (idx >= 0) {
        list[idx] = msg;
        replacedEdit = true;
        continue;
      }
    }
    // Self-echo fallback: when echo-message is active but labeled-response
    // is not, the server echo arrives without a label. The optimistic
    // message has a label but the echo doesn't — match by text content
    // so we don't end up with both the optimistic and the echo.
    // Also handle self messages even when `se` tag is missing.
    const netForSelfBatch = ircState.networks.find(n => n.networkId === networkId);
    const curNickBatch = netForSelfBatch?.currentNick || netForSelfBatch?.nick || '';
    const isSelfBatch = !!msg.nick && !!curNickBatch && msg.nick.toLowerCase() === curNickBatch.toLowerCase() && msg.command === 'PRIVMSG';
    if (msg.selfEcho || isSelfBatch) {
      // Search optimistic messages for one with matching text content.
      // Compare nicks case-insensitively and trim trailing \r that the
      // IRC parser may leave on the echo (e.g. "https://..." vs "...\r").
      let foundOptLabel: string | null = null;
      for (const [optLabel, optMsg] of ircState.optimisticMessages) {
        const optText = (optMsg.text ?? '').trim();
        const echoText = (msg.text ?? '').trim();
        if (optText === echoText && optMsg.nick.toLowerCase() === msg.nick.toLowerCase() && optMsg.command === 'PRIVMSG') {
          foundOptLabel = optLabel;
          break;
        }
      }
      if (foundOptLabel) {
        ircState.optimisticMessages.delete(foundOptLabel);
        const idx = list.findIndex((m: IRCMessage) => m.label === foundOptLabel);
        if (idx >= 0) {
          if (!msg.label) msg.label = foundOptLabel;
          list[idx] = msg;
          replacedEdit = true;
          continue;
        }
      }
      // Synthetic+echo race fallback (same as appendMessage): synthetic
      // already consumed optimisticMessages, so the loop above finds nothing
      // and the unlabeled echo would be appended as a duplicate. Walk the
      // live list tail for a pending-like entry with same trimmed text.
      const echoTrim = (msg.text ?? '').trim();
      const echoNickLower = (msg.nick ?? '').toLowerCase();
      let replacedByListSearch = false;
      for (let i = list.length - 1; i >= 0; i--) {
        const existing = list[i];
        if ((existing.text ?? '').trim() === echoTrim && (existing.nick ?? '').toLowerCase() === echoNickLower && existing.command === msg.command) {
          const isPendingLike = !!existing.label && !existing.eid && !existing.msgid;
          const isRecent = !existing.t || (Date.now() - existing.t) < 30_000;
          if (!isPendingLike && !isRecent) continue;
          if (!msg.label && existing.label) msg.label = existing.label;
          if (existing.label) ircState.optimisticMessages.delete(existing.label);
          list[i] = msg;
          replacedEdit = true;
          replacedByListSearch = true;
          break;
        }
      }
      if (replacedByListSearch) continue;
    }
    // Dedup against the existing list AND against earlier messages in
    // the same batch (eid/msgid could collide within a burst if the
    // server replays the same event). Must check BOTH eid and msgid
    // even when eid is present — history can return the same msgid
    // with two different eids (e.g. 65ZsMF… appeared as 225503 and
    // 223472 in #superbowl), which the old else-if missed and
    // rendered twice. Without the within-batch check the same eid
    // can reach the {#each} twice and Svelte throws each_key_duplicate.
    if ((msg.eid != null && seenEids.has(msg.eid)) || (msg.msgid && seenMsgids.has(msg.msgid))) continue;
    if (msg.eid != null) seenEids.add(msg.eid);
    if (msg.msgid) seenMsgids.add(msg.msgid);
    // Final fallback: pending optimistic with same text/nick anywhere in
    // list, even when isSelf was false (curNick mismatch or no se tag).
    let replacedByFallback = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const cand = list[i];
      if (cand.label && !cand.eid && !cand.msgid && (cand.text ?? '').trim() === (msg.text ?? '').trim() && (cand.nick ?? '').toLowerCase() === (msg.nick ?? '').toLowerCase() && cand.command === msg.command && Math.abs((cand.t || 0) - (msg.t || 0)) < 30000) {
        if (!msg.label && cand.label) msg.label = cand.label;
        if (cand.label) ircState.optimisticMessages.delete(cand.label);
        replacedEdit = true;
        replacedByFallback = true;
        break;
      }
    }
    if (replacedByFallback) continue;
    list.push(msg);
    pending.push(msg);
    newForProcessed.push(msg);
    // Aggregate unread + highlight for the batch instead of per-message
    // mutation. Without this, 50 incoming messages trigger 50 separate
    // Svelte reactive ticks on the Sidebar's buffer items, which is
    // most of the perceived "line by line trickle" delay.
    const isChatMessage = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
    if (isChatMessage) {
      hasChat = true;
      const track = shouldTrackUnread(networkId, bufferName);
      if (track) {
        const normBuf = normalizeChannelName(bufferName);
        const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf;
        if (!isActive || ircState.focusLost) addedUnread++;
        const isHl = !!msg.highlight || (netForBatchHl ? checkHighlight(msg, netForBatchHl) : false);
        if (isHl) {
          addedHighlights++;
          msg.highlight = true;
        }
      }
    }
  }

  // If the sorted burst is older than the tail (out-of-order WS delivery),
  // merge-sort the tail instead of appending — keeps ascii art line order
  // stable even when the gateway batch raced. Common case is already sorted,
  // so this is a single comparison.
  if (pending.length > 0 && list.length > pending.length) {
    const tailBeforeBatch = list[list.length - pending.length - 1];
    if (tailBeforeBatch && compareMessages(tailBeforeBatch, pending[0]) > 0) {
      // pending was interleaved — re-sort the whole window. Pending is
      // sorted and the existing prefix is sorted, so a full sort is just
      // the burst reorder fix; cost is O(N log N) but N≤5k and this path
      // fires rarely (only on genuine out-of-order delivery).
      const merged = [...list];
      merged.sort(compareMessages);
      // Dedup again by eid/msgid after the sort (reorder could expose dups
      // that the earlier within-batch dedup missed due to insertion order).
      const seen2 = new Set<number>();
      const msgids2 = new Set<string>();
      const dedupedMerged: IRCMessage[] = [];
      for (const m of merged) {
        if ((m.eid != null && seen2.has(m.eid)) || (m.msgid && msgids2.has(m.msgid))) continue;
        if (m.eid != null) seen2.add(m.eid);
        if (m.msgid) msgids2.add(m.msgid);
        dedupedMerged.push(m);
      }
      list.length = 0;
      list.push(...dedupedMerged);
      // Rebuild pending/newForProcessed to match the deduped sorted tail
      pending.length = 0;
      newForProcessed.length = 0;
      for (const m of dedupedMerged.slice(-dedupedMerged.length)) {
        // we don't need to recompute pending perfectly — the incremental
        // path below will be replaced by a full rebuild when list was
        // re-sorted.
      }
      // Force full rebuild in the processed step below
      replacedEdit = true;
    }
  }
  // Single state assignment triggers one reactive update for the batch
  ircState.messages[key] = list;
  // Edit replacement: the message text changed in-place — rebuild the
  // processed cache entirely since the existing grouping may need to
  // reflect the updated text.
  if (replacedEdit) {
    ircState.processedMessages[key] = buildProcessedBuffer(list);
  }

  // Incremental preprocessing: only regroup the new tail (and the
  // previous tail group, if any, in case it merges with the new
  // messages).  This is the per-message append equivalent of IRCCloud's
  // BufferFormatter incremental update — O(new batch + boundary) instead
  // of O(buffer size).
  if (!replacedEdit && newForProcessed.length > 0) {
    if (ircState.processedMessages[key]) {
      ircState.processedMessages[key] = appendToProcessed(
        ircState.processedMessages[key],
        newForProcessed,
      );
    } else {
      // Cold start: build the cache from the current raw list.  This
      // is the only place we pay O(buffer size) once.
      ircState.processedMessages[key] = buildProcessedBuffer(list);
    }
  }

  // Batch the unread-count updates: write unreadMap once and buf.unreadCount
  // once instead of per-message. This is the single biggest win for
  // perceived speed when 50+ messages arrive at once.
  // Respect per-buffer mute / showUnread: muted buffers never accumulate
  // unread or highlight counts, matching the expectation that "mute all
  // notifications" on a channel hides the sidebar badge.
  if ((addedUnread > 0 || addedHighlights > 0) && shouldTrackUnread(networkId, bufferName)) {
    const net = ircState.networks.find(n => n.networkId === networkId);
    const buf = net?.buffers.find(b => b.name === normalizeChannelName(bufferName));
    if (addedUnread > 0) {
      unreadMap[key] = (unreadMap[key] ?? 0) + addedUnread;
      if (buf) buf.unreadCount = (buf.unreadCount ?? 0) + addedUnread;
    }
    if (addedHighlights > 0) {
      highlightMap[key] = true;
      if (buf) {
        buf.highlight = true;
        buf.highlightCount = (buf.highlightCount ?? 0) + addedHighlights;
      }
    }
    if (net && buf && (addedUnread > 0 || addedHighlights > 0)) {
      ircState.pulseBuffers.add(key);
      setTimeout(() => ircState.pulseBuffers.delete(key), 300);
    }
    for (const m of pending) if (m.highlight && m.nick) recordHighlight(networkId, bufferName, m.nick);
  }

  // Fallback highlight check for messages where network was not available during aggregation.
  if (pending.length > 0 && hasChat) {
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) {
      for (const msg of pending) {
        const isChatMessage = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
        if (isChatMessage && !msg.highlight && checkHighlight(msg, net)) {
          msg.highlight = true;
          if (msg.nick) recordHighlight(networkId, bufferName, msg.nick);
          if (shouldTrackUnread(networkId, bufferName)) {
            const k = `${networkId}:${normalizeChannelName(bufferName)}`;
            const b = net.buffers.find(bb => bb.name === normalizeChannelName(bufferName));
            if (b) b.highlight = true;
            highlightMap[k] = true;
            if (b) b.highlightCount = (b.highlightCount ?? 0) + 1;
          }
        } else if (isChatMessage && msg.highlight && msg.nick) {
          // Already counted above, just ensure recent highlighters.
        }
      }
    }
  }
  // FIFO cap: bound JS memory + cold preprocess (5k cold = 0.98ms median). Keeps 200-row window intact.
  if (ircState.messages[key] && ircState.messages[key].length > MAX_JS_MESSAGES) {
    const capped = ircState.messages[key].slice(-MAX_JS_MESSAGES);
    ircState.messages[key] = capped;
    ircState.processedMessages[key] = buildProcessedBuffer(capped);
  }

  markNetworkSeen(networkId);
}

export function checkHighlight(msg: IRCMessage, net: Network): boolean {
  if (!msg.text || !msg.nick) return false;
  const text = msg.text.toLowerCase();
  const myNick = (net.currentNick || net.nick || '').toLowerCase();

  if (myNick && text.includes(myNick)) return true;

  for (const word of highlightWords) {
    if (text.includes(word.toLowerCase())) return true;
  }

  return false;
}

export function recordHighlight(networkId: string, bufferName: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = recentHighlightersCache.get(key) ?? [];
  const filtered = list.filter(n => n !== nick);
  // Prepend (most recent first), max 10
  filtered.unshift(nick);
  recentHighlightersCache.set(key, filtered.slice(0, 10));
}

function shouldTrackUnread(networkId: string, bufferName: string): boolean {
  const prefs = getBufferPrefs(networkId, bufferName);
  if (prefs.mute) return false;
  if (prefs.showUnread === false) return false;
  return true;
}

export function incrementUnread(networkId: string, bufferName: string, msg: IRCMessage): void {
  if (!shouldTrackUnread(networkId, bufferName)) return;
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net || bufferName === '_server') return;

  unreadMap[key] = (unreadMap[key] ?? 0) + 1;
  const buf = net.buffers.find(b => b.name === normalizeChannelName(bufferName));
  if (buf) {
    buf.unreadCount = (buf.unreadCount ?? 0) + 1;
  }

  if (checkHighlight(msg, net)) {
    highlightMap[key] = true;
    if (buf) {
      buf.highlight = true;
      buf.highlightCount = (buf.highlightCount ?? 0) + 1;
    }
    msg.highlight = true;
    if (msg.nick) recordHighlight(networkId, bufferName, msg.nick);
  }

  // Badge pulse animation
  ircState.pulseBuffers.add(key);
  setTimeout(() => ircState.pulseBuffers.delete(key), 300);
}
// Each TAGMSG from a nick resets a 6.5s heartbeat. The UI reads the
// timestamp and hides the indicator when the window expires. Entries
// are lazily cleaned up on read.

export function setTyping(networkId: string, channel: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(channel)}`;
  if (!ircState.typing[key]) ircState.typing[key] = {};
  ircState.typing[key][nick] = Date.now();
  ircState.typingVersion++;
}

/**
 * Increment the forceScrollToBottom nonce. Call from any code path that
 * wants the active buffer's MessageList to snap to the bottom even when
 * the user has scrolled up — IRCCloud always scrolls to the user's own
 * message so they can confirm what they sent, regardless of scroll
 * position. The nonce (not a boolean) ensures repeated calls always
 * trigger the reactive effect.
 */
export function requestForceScrollToBottom(): void {
  ircState.forceScrollToBottomNonce = ircState.forceScrollToBottomNonce + 1;
}

export function clearTyping(networkId: string, channel: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(channel)}`;
  const typing = ircState.typing[key];
  // Tombstone instead of delete: Svelte 5's proxy tracking reliably
  // invalidates on a deep property SET (the same path setTyping uses —
  // proven to re-render the indicator), but `delete` + shallow-reassign
  // is NOT reliably tracked, which left "X is typing" stuck on screen
  // after a `done` TAGMSG. ts=0 is filtered out by getTypersForBuffer's
  // 6.5s window, so the tombstone is invisible to consumers.
  if (typing && nick in typing) {
    typing[nick] = 0;
    ircState.typingVersion++;
  }
}

export function getTypersForBuffer(networkId: string, channel: string): string[] {
  const key = `${networkId}:${normalizeChannelName(channel)}`;
  const typing = ircState.typing[key];
  if (!typing) return [];
  const now = Date.now();
  const result: string[] = [];
  for (const [nick, ts] of Object.entries(typing)) {
    if (now - ts < 6500) result.push(nick);
  }
  return result;
}

// ── Last-sent message tracking (for edit-message Ctrl/Cmd+Up) ──
export interface LastSentInfo {
  eid?: number;
  msgid?: string;
  label: string;
  body: string;
}

/** Per-buffer record of the last message the user sent. Keyed by
 *  `${networkId}:${normalizeChannelName(bufferName)}`.
 *  Used by Ctrl/Cmd+Up in InputArea to prefill the edit input. */
export const lastSentMessages = $state<Record<string, LastSentInfo>>({});

export function recordSentMessage(networkId: string, bufferName: string, info: LastSentInfo): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  lastSentMessages[key] = info;
}

export function lastSentMessageForBuffer(buffer: ActiveBuffer): LastSentInfo | null {
  if (!buffer.networkId || !buffer.bufferName) return null;
  const key = `${buffer.networkId}:${normalizeChannelName(buffer.bufferName)}`;
  return lastSentMessages[key] ?? null;
}

// ── SessionStorage message cache ──
// Keeps a copy of the last-seen messages per buffer so that revisiting a
// channel URL (e.g. after a refresh) shows history instantly while the
// REST API call fetches fresh data in the background.

const CACHE_PREFIX = 'ircfiber:msgcache:';

function saveMessageCache(key: string, msgs: IRCMessage[]): void {
  if (msgs.length === 0) return;
  try {
    const trimmed = msgs.slice(-100);
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(trimmed));
  } catch { /* storage full or unavailable */ }
}

export function clearMessageCache(networkId: string, bufferName: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  try {
    sessionStorage.removeItem(CACHE_PREFIX + key);
  } catch { /* ignore */ }
}

export function loadCachedMessages(networkId: string, bufferName: string): IRCMessage[] | null {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const msgs = JSON.parse(raw) as IRCMessage[];
    return Array.isArray(msgs) ? msgs : null;
  } catch { return null; }
}
export function setMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  // Dedup within the incoming batch — history can contain the same
  // msgid twice with different eids (e.g. 65ZsMF… as 225503 and
  // 223472). The old setMessages stored both and rendered twice.
  const seenEids = new Set<number>();
  const seenMsgids = new Set<string>();
  const deduped: IRCMessage[] = [];
  for (const m of msgs) {
    if ((m.eid != null && seenEids.has(m.eid)) || (m.msgid && seenMsgids.has(m.msgid))) continue;
    if (m.eid != null) seenEids.add(m.eid);
    if (m.msgid) seenMsgids.add(m.msgid);
    deduped.push(m);
  }
  // FIFO cap: keep only the newest MAX_JS_MESSAGES (bounds GC + cold preprocess to ≤1ms for 5k).
  const capped = deduped.length > MAX_JS_MESSAGES ? deduped.slice(-MAX_JS_MESSAGES) : deduped;
  ircState.messages[key] = capped;
  ircState.processedMessages[key] = buildProcessedBuffer(capped);
  saveMessageCache(key, capped);
  markNetworkSeen(networkId);
}

export function pruneMessagesBefore(networkId: string, bufferName: string, beforeTs: number): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const existing = ircState.messages[key];
  if (!existing || existing.length === 0) return;
  const kept = existing.filter(m => (m.t ?? 0) >= beforeTs);
  ircState.messages[key] = kept;
  ircState.processedMessages[key] = buildProcessedBuffer(kept);
}

export function prependMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const existing = ircState.messages[key] ?? [];

  // Dedupe against existing messages AND within the new batch. eid is the
  // primary key (IRCCloud-style: every event gets a global sequential
  // eid). msgid and timestamp fallbacks handle legacy messages stored
  // without eid. The within-batch dedup matters because the server can
  // return the same message twice (eid collision) when a backlog fetch
  // overlaps with already-replayed events — without it, duplicate keys
  // reach the {#each} and Svelte throws each_key_duplicate.
  const eidSet = new Set<number>();
  const dedupKeys = new Set<string>();
  for (const m of existing) {
    if (m.eid != null) eidSet.add(m.eid);
    if (m.msgid) dedupKeys.add(m.msgid);
    else if (m.t) dedupKeys.add(`!${m.t}:${m.nick ?? ''}:${m.command ?? ''}:${(m.text || '').slice(0, 80)}`);
  }
  // Self-echo dedup for batch-tagged echoes: events inside an in-flight
  // CHATHISTORY batch carry batch=chathistory and are routed here (the
  // backfill path) instead of appendMessage. A batch fetched right after
  // the user sends can contain the echo of that send (the engine tags it
  // in connection.d activeBatchType == "chathistory"). The optimistic row
  // is already in `existing` — replace it in place instead of appending a
  // second copy. Matches by label (labeled-response echoes the label back)
  // or by text+nick+command within 30s against a pending optimistic.
  for (const m of msgs) {
    if (m.eid == null && !m.msgid) continue; // only echo-shaped entries replace
    let matchIdx = -1;
    if (m.label) {
      matchIdx = existing.findIndex(e => e.label === m.label);
    } else {
      const mText = (m.text ?? '').trim();
      const mNick = (m.nick ?? '').toLowerCase();
      for (let i = existing.length - 1; i >= 0; i--) {
        const e = existing[i];
        if (e.label && !e.eid && !e.msgid &&
            (e.text ?? '').trim() === mText &&
            (e.nick ?? '').toLowerCase() === mNick &&
            e.command === m.command &&
            Math.abs((e.t ?? 0) - (m.t ?? 0)) < 30000) {
          matchIdx = i;
          break;
        }
      }
    }
    if (matchIdx >= 0) {
      const pending = existing[matchIdx];
      if (!m.label && pending.label) m.label = pending.label;
      if (pending.label) ircState.optimisticMessages.delete(pending.label);
      existing[matchIdx] = m;
      // Claim the echo's identity so the dedup loop below skips it.
      if (m.eid != null) eidSet.add(m.eid);
      if (m.msgid) dedupKeys.add(m.msgid);
    }
  }

  const filtered: IRCMessage[] = [];
  for (const m of msgs) {
    if ((m.eid != null && eidSet.has(m.eid)) || (m.msgid && dedupKeys.has(m.msgid))) continue;
    if (m.eid != null) eidSet.add(m.eid);
    if (m.msgid) {
      dedupKeys.add(m.msgid);
    } else if (m.t) {
      const k = `!${m.t}:${m.nick ?? ''}:${m.command ?? ''}:${(m.text || '').slice(0, 80)}`;
      if (dedupKeys.has(k)) continue;
      dedupKeys.add(k);
    }
    filtered.push(m);
  }
  if (filtered.length > 0) {
    const boundary = existing.find(m => m.eid != null || m.msgid || m.t);
    if (boundary) {
      setBacklogDivider(networkId, bufferName, boundary.eid != null ? `e:${boundary.eid}` : (boundary.msgid || `t:${boundary.t}`));
    }
  }

  // Sort by TIMESTAMP first: chat order must be chronological. Eids are
  // NOT guaranteed monotonic with time (an engine eid-counter reset can
  // stamp low eids on recent messages), so sorting by eid scrambles the
  // conversation once older history is prepended. Tie-break equal
  // timestamps by eid, then msgid, so pages with shared timestamps stay
  // deterministic. For eid-monotonic channels this yields the same order
  // as the old eid sort.
  const merged = [...filtered, ...existing].sort((a, b) => {
    const ta = a.t ?? 0;
    const tb = b.t ?? 0;
    if (ta !== tb) return ta - tb;
    if (a.eid != null && b.eid != null) return a.eid - b.eid;
    return (a.msgid ?? '').localeCompare(b.msgid ?? '');
  });
  // FIFO cap: if prepend pushes over limit, keep newest MAX_JS_MESSAGES. Bounds prependReprocess (≤1ms for 5k).
  let finalMessages = merged;
  let finalProcessed: IRCMessage[];
  if (merged.length > MAX_JS_MESSAGES) {
    finalMessages = merged.slice(-MAX_JS_MESSAGES);
    finalProcessed = buildProcessedBuffer(finalMessages);
  } else {
    // Prepending changes the head boundary in ways that can't be fixed
    // incrementally — fall back to a full pass on the merged raw array.
    finalProcessed = prependReprocess(existing, filtered);
  }
  ircState.messages[key] = finalMessages;
  ircState.processedMessages[key] = finalProcessed;
  markNetworkSeen(networkId);
}
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__fiberPrependMessages = prependMessages;
}

// Marks are sequence-prefixed (`<seq>|<msgid or t:ts>`) so every fetch or
// "mark changed", and a stale-looking mark would strand the user at
// scrollTop 0 where the browser fires no further scroll events.
let backlogDividerSeq = 0;
export function setBacklogDivider(networkId: string, bufferName: string, itemKey: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  ircState.backlogDivider[key] = `${++backlogDividerSeq}|${itemKey}`;
}

// ── Read-tracking helpers (IRCCloud-style lastSeen / bottomSeen) ──

export function isMessageUnseen(msg: IRCMessage, networkId: string, bufferName: string): boolean {
  const lastSeen = getLastSeen(networkId, bufferName);
  if (lastSeen === null) return true;
  return (msg.t || 0) > lastSeen;
}

export function getLastSeenMessage(networkId: string, bufferName: string): IRCMessage | null {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  const lastSeen = getLastSeen(networkId, bufferName);
  if (lastSeen === null || list.length === 0) return null;
  // Find the newest message at or before lastSeen
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i].t || 0) <= lastSeen) return list[i];
  }
  return list[0];
}

export function countMessagesBetween(networkId: string, bufferName: string, startMsg?: IRCMessage | null, endMsg?: IRCMessage | null): number {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  if (list.length === 0) return 0;
  const startIdx = startMsg ? list.findIndex(m => sameMsg(m, startMsg)) : 0;
  const endIdx = endMsg ? list.findIndex(m => sameMsg(m, endMsg)) : list.length - 1;
  if (startIdx < 0 || endIdx < 0) return 0;
  return Math.max(0, endIdx - startIdx);
}

function isImportantMessage(msg: IRCMessage): boolean {
  // Skip status/join/part/numeric replies — only count actual chat
  if (msg.command === 'PRIVMSG' || msg.type === 'action') return true;
  if (msg.command === 'JOIN' || msg.command === 'PART' || msg.command === 'QUIT') return false;
  if (msg.command === 'NICK' || msg.command === 'CHGHOST') return false;
  if (/^\d{3}$/.test(msg.command)) return false;
  if (msg.command === 'MODE' || msg.command === 'TOPIC' || msg.command === 'KICK') return false;
  if (msg.command === 'JOINPART_GROUP') return false;
  return true;
}

export function countImportantMessagesBetween(networkId: string, bufferName: string, startMsg?: IRCMessage | null, endMsg?: IRCMessage | null): number {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  if (list.length === 0) return 0;
  const startIdx = startMsg ? list.findIndex(m => sameMsg(m, startMsg)) : 0;
  const endIdx = endMsg ? list.findIndex(m => sameMsg(m, endMsg)) : list.length - 1;
  if (startIdx < 0 || endIdx < 0) return 0;
  let count = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    if (isImportantMessage(list[i])) count++;
  }
  return count;
}

export function clearUnseenHighlightsAfter(networkId: string, bufferName: string, msg: IRCMessage): number {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  const msgIdx = list.findIndex(m => sameMsg(m, msg));
  if (msgIdx < 0) return 0;
  let remainder = 0;
  for (let i = msgIdx + 1; i < list.length; i++) {
    if (list[i].highlight) remainder++;
  }
  // Only clear highlights for this buffer if nothing remains after the boundary
  if (remainder === 0) {
    delete highlightMap[key];
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) {
      const buf = net.buffers.find(b => b.name === normalizeChannelName(bufferName));
      if (buf) buf.highlight = false;
    }
  }
  return remainder;
}

export function unseenHighlightCountAfter(networkId: string, bufferName: string, msg?: IRCMessage | null): number {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  if (list.length === 0) return 0;
  const startIdx = msg ? list.findIndex(m => sameMsg(m, msg)) : -1;
  const start = startIdx >= 0 ? startIdx + 1 : 0;
  let count = 0;
  for (let i = start; i < list.length; i++) {
    if (list[i].highlight) count++;
  }
  return count;
}

export function updateBottomSeen(networkId: string, bufferName: string, msg: IRCMessage): boolean {
  const current = getBottomSeen(networkId, bufferName);
  const ts = msg.t || 0;
  if (current === null || ts > current) {
    setBottomSeen(networkId, bufferName, ts);
    return true;
  }
  return false;
}

function normalizeUser(user: string | Member): Member {
  if (typeof user === 'string') {
    // Keep the prefix in `nick` so the operator status indicator is
    // preserved through snapshot round-trips. The 353 (RPL_NAMREPLY)
    // handler stores nick with prefix too; the prior implementation
    // stripped it here, which dropped the operator status on hard
    // refresh and made users appear without their @/+/% prefix in
    // the member list. The `prefix` field is still set so
    // sorting/grouping by ModeCategory keeps working.
    const bang = user.indexOf('!');
    const identEJ = bang > 0 ? user.slice(bang + 1).split('@')[0] : '';
    const mode = getUserModePrefix(user);
    return {
      nick: user,
      prefix: mode.prefix,
      category: mode.category,
      ident: identEJ, realname: '', isAway: false, awayMessage: '',
      lastSpoke: 0, lastHighlighted: 0, account: ''
    };
  }
  return user;
}

export function sortBuffers(net: Network): void {
  net.buffers.sort((a, b) => {
    if (a.name === '_server') return -1;
    if (b.name === '_server') return 1;
    return naturalCompare(a.name, b.name);
  });
}

/**
 * Wire-only fields the engine ships on WS sync snapshots beyond the
 * Buffer/Network interfaces (websocket.d:performStateDump). `accounts`,
 * `idents` and `realnames` are network-wide caches (extended-join +
 * WHOIS/311) keyed by BARE nick; channel buffers additionally carry
 * per-buffer subsets (`chan["realnames"]` etc.) keyed by the exact raw
 * nick form used in `chan["users"]` (mode prefix + optional userhost).
 */
export interface SyncNetwork extends Network {
  /** Backend `id` field, mapped to the frontend `networkId`. */
  id?: string;
  accounts?: Record<string, string>;
  idents?: Record<string, string>;
  realnames?: Record<string, string>;
}

export interface SyncBuffer extends Buffer {
  realnames?: Record<string, string>;
  accounts?: Record<string, string>;
  idents?: Record<string, string>;
}

/**
 * Fill member account/ident/realname from the engine's sync caches.
 * The network-wide caches are keyed by bare nick while m.nick may carry
 * a mode prefix and/or userhost, so try the exact key first (the
 * per-buffer subsets use the raw form), then the bare form. Only fills
 * fields the member doesn't already have — live extended-join JOINs set
 * realname directly and must not be clobbered by a stale sync.
 */
function enrichMembersFromSync(
  users: Member[],
  caches: {
    accounts?: Record<string, string>;
    idents?: Record<string, string>;
    realnames?: Record<string, string>;
    bufRealnames?: Record<string, string>;
  }
): void {
  // Helper for case-insensitive lookup — IRC nicks are case-insensitive
  // per RFC 1459, and the engine may store "AShapiro" vs "ashapiro"
  // depending on extended-join vs WHOIS. Try exact then lowercase.
  const findCI = (map: Record<string, string> | undefined, key: string): string | undefined => {
    if (!map) return undefined;
    if (map[key] !== undefined) return map[key];
    const low = key.toLowerCase();
    // Fast path: direct lowercase key
    if (map[low] !== undefined) return map[low];
    // Fallback: scan for case-insensitive match (covers "AShapiro" stored as "AShapiro" but looked up as "ashapiro")
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === low) return map[k];
    }
    return undefined;
  };
  for (const m of users) {
    const bare = stripPrefix(m.nick);
    if (caches.accounts && !m.account) {
      const acct = findCI(caches.accounts, m.nick) ?? findCI(caches.accounts, bare);
      if (acct) m.account = acct;
    }
    if (caches.idents && !m.ident) {
      const id = findCI(caches.idents, m.nick) ?? findCI(caches.idents, bare);
      if (id) m.ident = id;
    }
    if (caches.realnames && !m.realname) {
      const rn = (caches.bufRealnames ? (findCI(caches.bufRealnames, m.nick) ?? findCI(caches.bufRealnames, bare)) : undefined)
              ?? findCI(caches.realnames, bare)
              ?? findCI(caches.realnames, m.nick);
      if (rn && rn.toLowerCase() !== bare.toLowerCase()) m.realname = rn;
    }
  }
}

export function updateNetworkFromSync(incoming: SyncNetwork[]): void {
  for (const rawNet of incoming) {
    // Map backend `id` field to frontend `networkId`
    const net = rawNet;
    if (!net.networkId && rawNet.id) {
      net.networkId = rawNet.id;
    }

    const existing = ircState.networks.find(n => n.networkId === net.networkId);
    // The sync itself is fresh activity for the network — refresh the
    // stale marker so a steady-state boot or restart doesn't briefly
    // flash "stale" on every server before traffic resumes.
    if (existing) existing.lastSeenAt = Date.now();
    else net.lastSeenAt = Date.now();
    if (existing) {
      // Map backend status to frontend ConnectionState so the UI reflects
      // the actual engine state (e.g. "connecting" right after restart).
      const connectionState: ConnectionState =
        net.status === 'connecting' ? 'connecting' :
        net.connected             ? 'connected'   :
                                     'disconnected';

      // Clear any stale disconnect reason from a previous session/event.
      // The sync is the authoritative snapshot from the server — if the
      // engine says it's trying to connect (status=connecting), the old
      // "Connection closed unexpectedly" no longer applies.
      if (connectionState !== 'disconnected') {
        existing.disconnectReason = '';
      }

      // Don't overwrite connected/connectionState from the sync when the
      // live event-driven state already says connected.  The engine's sync
      // snapshot lags behind real-time IRC events: 001 (RPL_WELCOME) fires
      // immediately and sets connected=true, but the engine doesn't report
      // connected=true in its snapshot until AFTER performRegistration()
      // returns (post-MOTD).  During this window the sync would downgrade
      // the live state back to disconnected, causing the red "Click to
      // reconnect" banner to appear while MOTD lines are still arriving.
      //
      // Similarly, the periodic snapshotter (10s interval) may still report
      // status=connecting after the engine has already connected, which
      // would overwrite the live connected state back to "Connecting...".
      //
      // Only adopt the sync's connection values if they're genuinely new
      // (not just slower) — i.e. the sync says disconnected/connecting
      // but the live state already confirms connected.
      const liveState = existing.connectionState;
      const isLiveConnected = existing.connected;
      const syncIsNew =
        connectionState === 'disconnected'
          ? isLiveConnected
            // Live says connected but sync says disconnected — this could
            // be the race window.  Only downgrade if the sync has come
            // back multiple times (the engine gives up), or if the live
            // state has had time to settle.  For now, trust the live event-
            // driven state over the periodic snapshot during handshake.
            ? false
            : liveState !== connectionState
          : connectionState === 'connecting' && isLiveConnected
            // Live says connected but sync says connecting — stale
            // snapshot from before the engine finished registration.
            ? false
            : liveState !== connectionState;

      // Always sync metadata fields — these don't race with live events.
      existing.name = net.name;
      existing.host = net.host;
      existing.port = net.port;
      existing.tls = net.tls;
      existing.nick = net.nick;
      existing.realName = net.realName;
      // Network-wide realname cache (nick → realname) from the engine's
      // `netObj["realnames"]`. Keep it on the Network object so message
      // rows can show a real name for nicks NOT in the active buffer's
      // member list (PM counterparts, users who left the channel, and
      // history rows) — see MessageRow's fallback lookup.
      // Merge rather than overwrite: a sync with empty realnames (e.g.
      // snapshot before WHOIS) must not clear previously learned names.
      if (net.realnames !== undefined) {
        if (!existing.realnames) existing.realnames = {};
        // Only merge if incoming has entries; empty incoming keeps existing
        if (Object.keys(net.realnames).length > 0) {
          existing.realnames = { ...existing.realnames, ...net.realnames };
        } else if (Object.keys(existing.realnames).length === 0) {
          existing.realnames = net.realnames;
        }
      }
      existing.sasl = net.sasl;
      existing.saslUsername = net.saslUsername;
      // Don't overwrite saslPassword from sync if empty — the API may
      // mask it for security (returning empty string on edits). Preserve
      // what the user already set locally.
      if (net.saslPassword) existing.saslPassword = net.saslPassword;
      if (net.autoJoinChannels !== undefined) existing.autoJoinChannels = net.autoJoinChannels;
      if (net.autoJoinDelaySeconds !== undefined) existing.autoJoinDelaySeconds = net.autoJoinDelaySeconds;
      existing.status = net.status;
      // systemManaged is a server-side flag we don't expect to change
      // during a session; only adopt it from sync if we don't have a
      // value yet (initial load). Treat undefined/missing as false.
      if (net.systemManaged !== undefined) existing.systemManaged = net.systemManaged;
      if ((net as any).disabled !== undefined) (existing as any).disabled = (net as any).disabled;

      // considers it active (gated by `hasRetryStatus` in protocol.d).
      // Presence adopts the new value; absence (the sync-omitted
      // case) means the engine considers the network healthy and the
      // local value must be cleared — the on-store counterpart to the
      // engine's zero-valued `backoff.reset()` emit. Delegate to the
      // shared apply* helper so the dual-clear semantics (TG5: clear
      // BOTH retryStatus AND failInfo on null-status) live in one
      // place. Mirrors the engine-emitted CONNECTION_RETRY_STATUS
      // event's identical null payload.
      if (rawNet.retryStatus && typeof rawNet.retryStatus === 'object') {
        existing.retryStatus = rawNet.retryStatus as RetryStatus;
        // Presence of retryStatus on the sync means the engine thinks
        // we're mid-retry — keep any prior failInfo (rare but
        // legitimate: the engine might emit a retryStatus AFTER the
        // failInfo from the same cycle landed).
      } else {
        applyRetryStatus(existing.networkId, null);
      }
      // failInfo adoption: only when shipped on the wire (no implicit
      // clear — see the new-network branch for the rationale; absent
      // here means "engine hasn't shipped yet" not "engine cleared it").
      if (rawNet.failInfo && typeof rawNet.failInfo === 'object') {
        existing.failInfo = rawNet.failInfo as FailInfo;
      }

      // Connection state: only overwrite from sync when it represents
      // genuinely new info, not when the sync is just slower than live
      // IRC events (the race window described above).
        if (syncIsNew) {
          // If the user clicked Disconnect, suppress sync overwrites to
          // 'connected' INDEFINITELY — until the user explicitly clicks
          // Reconnect (which calls clearUserDisconnected).  The engine
          // snapshot can race the control message, or the periodic
          // snapshotter can overwrite the disconnect snapshot before the
          // consumer processes the control message, and we must not flash
          // the UI back to "connected" while the user wants to stay
          // disconnected.  'connecting' is NOT suppressed: if the engine
          // reports it (e.g. during an exponential-backoff reconnect
          // window) the user needs to see "Disconnect" so they can cancel
          // the pending attempt.
          if (!userDisconnectedAt.has(existing.networkId)
              || connectionState === 'disconnected') {
            existing.connected = net.connected;
            existing.connectionState = connectionState;
          }
          } else if (connectionState === 'connecting' && !isLiveConnected
              && !userDisconnectedAt.has(existing.networkId)) {
        // The sync confirms connection is in progress — this is new info
        // that live events haven't provided yet (001 hasn't fired, or the
        // engine is between attempts in its backoff loop). Show it so the
        // user gets a "Disconnect" button to cancel the pending reconnect.
        // If the user has explicitly disconnected (userDisconnectedAt set),
        // suppress this — they don't want to see "Connecting" cards and the
        // synthetic attempt in ServerLogTimeline would create a ghost card.
        existing.connectionState = connectionState;
      }
      // Don't blindly overwrite currentNick from sync — the IRC NICK event
      // handler is the authoritative source for nick changes. Sync snapshots
      // are taken on a timer and may contain the old nick for a few seconds
      // after a /nick, which would clobber the optimistic UI update. Only
      // adopt the sync value if we don't have one locally yet (initial load),
      // or while a /nick attempt is in flight (track via pendingSelfNickChange).
      if (!existing.currentNick && net.currentNick) {
        existing.currentNick = net.currentNick;
      } else if (existing.pendingSelfNickChange && existing.currentNick && net.currentNick) {
        // While a /nick is in flight, prefer the engine's authoritative
        // currentNick ONCE it has caught up to the new value (case-insensitive
        // per IRC RFC 1459). Before that, the sync value will be the old
        // nick and we keep the optimistic local value to avoid flicker.
        if (normaliseIdentifier(existing.currentNick) === normaliseIdentifier(net.currentNick)) {
          // Engine agrees — clear the pending tracker, we are in sync.
          existing.pendingSelfNickChange = undefined;
          existing.currentNickUpdatedAt = Date.now();
        }
      } else if (existing.currentNick && net.currentNick
          && normaliseIdentifier(existing.currentNick) !== normaliseIdentifier(net.currentNick)
          && existing.currentNickUpdatedAt && Date.now() - existing.currentNickUpdatedAt < NICK_SYNC_COOLDOWN_MS) {
        // The you_nickchange live event has already cleared pendingSelfNickChange
        // and set currentNick, but the periodic sync snapshot was taken before
        // the engine processed the nick change. The sync still carries the old
        // nick. Keep our event-driven value — the sync will catch up on the
        // next cycle when the engine's snapshot reflects the change.
        // Don't overwrite.
      } else if (existing.currentNick && net.currentNick
          && normaliseIdentifier(existing.currentNick) !== normaliseIdentifier(net.currentNick)) {
        // Sync has a different currentNick than our local value and either
        // we never tracked a recent change or the cooldown has expired.
        // Adopt the sync value — the nick was changed from another client
        // or services (NickServ/Ghost), or we're reconciling after a
        // reload where the sync is the authoritative source.
        existing.currentNick = net.currentNick;
      }

      // Snapshot existing member activity before sync overwrites users.
      // The backend resets lastSpoke/lastHighlighted to 0 on reconnect,
      // which would break tab-completion sort (most recent speaker).
      // Keyed by `<networkId>:<bufferName>:<nick>` for per-member lookup.
      const savedActivity = new Map<string, { lastSpoke: number; lastHighlighted: number }>();
      for (const buf of existing.buffers) {
        for (const m of buf.users || []) {
          savedActivity.set(`${existing.networkId}:${buf.name}:${m.nick}`, {
            lastSpoke: m.lastSpoke ?? 0,
            lastHighlighted: m.lastHighlighted ?? 0,
          });
        }
      }

      // Track which local buffers were touched by this sync, so we can
      // reconcile orphan channels below.
      const syncedBufferNames = new Set<string>();
      for (const incomingBuf of net.buffers) {
        // Only normalize channel names (starting with #). Query/DM buffers
        // use the raw nick as the buffer name and must not get '#' prepended.
        if (incomingBuf.name.startsWith('#')) {
          incomingBuf.name = normalizeChannelName(incomingBuf.name);
        }
        // Skip channels the user has explicitly deleted — the server still
        // re-includes them in sync (they're in partedChannels), but the UI
        // should keep them hidden.
        if (hiddenChannelsMap[`${existing.networkId}:${incomingBuf.name}`]) continue;
        syncedBufferNames.add(incomingBuf.name);
        // Convert string users to Member objects from backend sync,
        // then deduplicate by stripped nick. The D backend may briefly
        // include the same user twice (bare nick from our own handler
        // + prefixed/hosted form from RPL_NAMREPLY 353), and older
        // snapshots stored in Redis can also contain duplicates from
        // the previous broken behavior. Either form would crash
        // Svelte's keyed each block in MemberList with each_key_duplicate.
        if (incomingBuf.users && incomingBuf.users.length > 0) {
          if (typeof incomingBuf.users[0] === 'string') {
            const asStrings = incomingBuf.users as unknown as string[];
            incomingBuf.users = asStrings.map(normalizeUser);
          }
          // Dedup by stripped nick, preferring the BARE form (no host suffix)
          // when one exists, so the channel roster doesn't keep a stale
          // `nick!user@host` entry alongside the bare one after a NICK
          // change. We still prefer a prefixed form (e.g. `@user`) over a
          // bare form so services-granted op status survives the snapshot
          // round-trip.
          const seen = new Map<string, number>();  // bareNick -> index in deduped
          const deduped: Member[] = [];
          for (const u of incomingBuf.users) {
            const bare = stripPrefix(u.nick);
            if (!bare) continue;
            const existing = seen.get(bare);
            if (existing === undefined) {
              seen.set(bare, deduped.length);
              deduped.push(u);
            } else {
              const existingU = deduped[existing];
              const existingHasPrefix = existingU.prefix && existingU.prefix.length > 0;
              const thisHasPrefix = u.prefix && u.prefix.length > 0;
              const existingHasHost = existingU.nick.includes('!');
              const thisHasHost = u.nick.includes('!');
              if (thisHasPrefix && !existingHasPrefix) {
                // Promote bare → prefixed (e.g. services op arrived).
                deduped[existing] = u;
              } else if (!thisHasHost && existingHasHost) {
                // Prefer the bare entry over a stale host-bearing entry.
                deduped[existing] = u;
              }
            }
          }
          if (deduped.length !== incomingBuf.users.length) {
            incomingBuf.users = deduped;
          }
        }
        const existingBuf = existing.buffers.find(b => b.name === incomingBuf.name);
        if (existingBuf) {
          // Preserve local unread/highlight state across syncs.
          // The backend doesn't know the client-side "active buffer" or scroll
          // position, so its unreadCount is stale and would clobber the
          // local indicator every few seconds. Only adopt the backend's count
          // if it's higher (the user truly has more unread messages than we
          // knew about) or if we have no local state yet.
          const localUnread = existingBuf.unreadCount ?? 0;
          const localHighlight = existingBuf.highlight ?? false;
          const remoteUnread = incomingBuf.unreadCount ?? 0;
          const remoteHighlight = incomingBuf.highlight ?? false;
          // Copy incoming buffer properties.  For isJoined we use a
          // pending-change guard: after a live JOIN/PART/KICK event for self,
          // updateChannelUsers sets pendingIsJoined to the event direction.
          // The periodic sync snapshot is authoritative but lags behind live
          // events by up to ~10s.  When a pending change exists we only adopt
          // the sync's isJoined if it CONFIRMS the event direction — a
          // contradicting value came from a snapshot taken before the event
          // propagated to the engine and must not clobber the live state.
          // Once the sync confirms, the guard is cleared.
          existingBuf.name = incomingBuf.name;
          existingBuf.type = incomingBuf.type;
          existingBuf.topic = incomingBuf.topic;
          existingBuf.topicSetBy = incomingBuf.topicSetBy;
          existingBuf.topicSetAt = incomingBuf.topicSetAt;
          // Apply any pending nick changes from live NICK events BEFORE
          // assigning the incoming users array. We rebuild a fresh array
          // with the pending nick patches applied, so the assignment below
          // is a single mutation that Svelte's $state proxy will pick up
          // uniformly. Sync snapshots can be taken before the engine sees
          // the nick change, which would otherwise revert our members list
          // to the old nick even though `currentNick` (the typing-area
          // indicator) is already updated. Mirror the same guard applied
          // to currentNick above (line 1138). We also clear pending
          // entries once the sync catches up with the new nick.
          const now = Date.now();
          const bufKey = `${existing.networkId}:${incomingBuf.name}`;
          const patchedUsers: Member[] = [];
          for (const m of incomingBuf.users) {
            const bare = stripPrefix(m.nick);
            const pendingKey = `${bufKey}:${bare}`;
            const pending = pendingNickChanges.get(pendingKey);
            if (pending) {
              if (pending.setAt + PENDING_NICK_TTL_MS < now) {
                // Stale — drop and accept whatever the sync says.
                pendingNickChanges.delete(pendingKey);
                patchedUsers.push(m);
              } else {
                // The incoming nick matches our pre-change nick (the sync
                // hasn't caught up yet). Patch with the live new nick.
                patchedUsers.push({ ...m, nick: (m.prefix || '') + pending.newNick });
              }
            } else {
              patchedUsers.push(m);
            }
          }
          // Clear any pending entries for this buffer that the sync has
          // caught up with — i.e. the sync now reports the new nick.
          for (const [k, v] of pendingNickChanges) {
            if (!k.startsWith(bufKey + ':')) continue;
            if (v.setAt + PENDING_NICK_TTL_MS < now) {
              pendingNickChanges.delete(k);
              continue;
            }
            if (patchedUsers.some(u => stripPrefix(u.nick) === stripPrefix(v.newNick))) {
              pendingNickChanges.delete(k);
            }
          }
          existingBuf.users = patchedUsers;
          // IRCCloud-style: ensure the current user's nick is present in
          // the member list whenever the buffer is genuinely joined. The
          // engine's RPL_NAMREPLY (353) doesn't always include self (some
          // IRCds omit it, and channelUsers snapshot can race the JOIN
          // echo), so a stale sync would otherwise permanently drop the
          // self-nick from the roster — surfacing as "I'm not in the
          // member list even though the channel header says I'm joined".
          //
          // Guard: only re-add when isJoined === true. A PART/KICK for self
          // already sets isJoined=false (line 2110/2122) and the orphan
          // reconciliation loop keeps it false once the engine confirms,
          // so we won't resurrect a ghost nick in a parted channel.
          if (existingBuf.isJoined === true && existing.currentNick) {
            const selfBare = stripPrefix(existing.currentNick);
            if (!existingBuf.users.some(u => stripPrefix(u.nick) === selfBare)) {
              existingBuf.users.push({
                nick: existing.currentNick, prefix: '', category: 'MEMBER',
                ident: '', realname: '', isAway: false, awayMessage: '',
                lastSpoke: 0, lastHighlighted: 0, account: '',
              });
            }
          }
          // Enrich members with extended-join data from the network-level
          // accounts/idents/realnames caches the engine ships as extra
          // fields on the sync payload (websocket.d:performStateDump).
          enrichMembersFromSync(existingBuf.users, {
            accounts: rawNet.accounts,
            idents: rawNet.idents,
            realnames: rawNet.realnames,
            bufRealnames: (incomingBuf as SyncBuffer).realnames,
          });
          // Re-apply saved member activity that the incoming sync wiped out.
          for (const m of existingBuf.users) {
            const key = `${existing.networkId}:${existingBuf.name}:${m.nick}`;
            const saved = savedActivity.get(key);
            if (saved) {
              if (m.lastSpoke === 0 && saved.lastSpoke > 0) m.lastSpoke = saved.lastSpoke;
              if (m.lastHighlighted === 0 && saved.lastHighlighted > 0) m.lastHighlighted = saved.lastHighlighted;
            }
          }
          existingBuf.isPinned = incomingBuf.isPinned;
          existingBuf.isArchived = incomingBuf.isArchived;
          existingBuf.lastSeenMsgTime = incomingBuf.lastSeenMsgTime;
          existingBuf.firstUnseenMsgIndex = incomingBuf.firstUnseenMsgIndex;
          existingBuf.unreadCount = Math.max(localUnread, remoteUnread);
          existingBuf.highlight = localHighlight || remoteHighlight;
          const incomingJoined = incomingBuf.isJoined;
          const pending = existingBuf.pendingIsJoined;
          const joinInFlight = existingBuf.joinInFlight === true;
          // W7-T01: if a JOIN is in-flight from URL navigation, treat it as
          // pending=true. The engine sync snapshot often races the JOIN and
          // reports isJoined=false before the JOIN event reaches us; without
          // this guard the snapshot would clobber the user-initiated join.
          const effectivePending = joinInFlight ? true : pending;
          // W7-T03: if the engine confirms we're joined AND we have an
          // in-flight JOIN attempt, the JOIN already succeeded server-side.
          // Adopt isJoined=true and clear the in-flight flags — otherwise
          // joinInFlight stays stuck true forever (the JOIN echo only fires
          // when the server processes our JOIN; some IRCds return
          // ERR_USERONCHANNEL 443 instead, or the echo never reaches us
          // because the user was already joined before the WS reconnected).
          // This caused a persistent "Rejoin" button on #superbowl even
          // though the user was actually in the channel.
          if (joinInFlight && incomingJoined === true) {
            existingBuf.isJoined = true;
            existingBuf.isPhantom = false;
            existingBuf.joinInFlight = false;
            existingBuf.pendingIsJoined = undefined;
            existingBuf.pendingConfirmations = undefined;
          } else if (existingBuf.isPhantom) {
            // Phantom buffers have no event-driven state — adopt blindly,
            // but only if no JOIN is in-flight from URL nav (handled above).
            existingBuf.isJoined = incomingJoined;
            existingBuf.isPhantom = false;
          } else if (effectivePending === undefined) {
            // No pending event-driven change — sync is authoritative
            existingBuf.isJoined = incomingJoined;
          } else if (effectivePending !== incomingJoined) {
            // Pending event contradicts sync — keep the event state (sync
            // snapshot was taken before the JOIN/PART/KICK propagated)
          } else {
            // Sync confirms the pending event direction. Require TWO
            // consecutive confirming syncs before clearing the guard, so a
            // single stale sync (snapshot taken before JOIN propagated to
            // channelState) can't clobber isJoined back to false.
            // Counter starts at 2 (set in updateChannelUsers), decrements
            // here on each confirm, clears when it hits 0.
            // Start at 2 when explicitly set (JOIN handler sets this value
            // for extra safety), default to 1 when undefined (PART handler
            // clears pendingConfirmations, so only 1 confirm needed).
            const c = existingBuf.pendingConfirmations ?? 1;
            if (c <= 1) {
              existingBuf.pendingIsJoined = undefined;
              existingBuf.pendingConfirmations = undefined;
            } else {
              existingBuf.pendingConfirmations = c - 1;
            }
          }

          // Keep the preferences-map (used by getTotalUnread / getHasHighlight
          // for the title bar and favicon) in sync with the resolved value.
          const mapKey = `${existing.networkId}:${incomingBuf.name}`;
          unreadMap[mapKey] = existingBuf.unreadCount;
          if (existingBuf.highlight) highlightMap[mapKey] = true;
          else delete highlightMap[mapKey];
          // W7-T02: the channel appeared in this sync — reset the missed-sync
          // counter so a fresh streak of misses starts from zero. (Only
          // runs for buffers that were already in existing.buffers; newly
          // added buffers default to undefined → 0 via `?? 0` in the
          // orphan loop below.)
          existingBuf.syncMissedCount = 0;
        } else {
          existing.buffers.push(incomingBuf);
        }
      }
      // Reconcile orphan channels: buffers that were in existing.buffers but
      // NOT in the incoming sync. These are channels the engine no longer
      // tracks (not in channelState nor partedChannels) — the user is no
      // longer joined. Without this, a stale isJoined:true would persist
      // and block auto-join on URL navigation (maybeAutoJoinChannel's guard
      // at App.svelte:545 would skip the JOIN).
      //
      // W7-T02: BUT the engine's channelState snapshot lags behind live
      // JOIN events by up to one snapshot cycle (~10s). A single missed
      // sync must NOT flip isJoined — that surfaced the bogus "Rejoin"
      // button on `#superbowl` (the engine snapshot didn't yet include
      // the freshly-joined channel). We now:
      //   1. Increment `syncMissedCount` each time the buffer is missing
      //   2. Skip the flip entirely if the buffer has ANY local message
      //      ever — the user has demonstrably been in this channel, so
      //      the engine snapshot is just stale (engine restart, network
      //      glitch, handoff race, joined from another client, etc).
      //      Without this, a channel the user is actively chatting in
      //      drops into "Inactive" the moment they go quiet for a few
      //      minutes (the original 5-minute activity window let this
      //      flip fire during lurking / idle tabs).
      //   3. Only flip isJoined: true → false once the buffer has been
      //      missing for ORPHAN_FLIP_THRESHOLD consecutive syncs (~30s)
      //      AND the buffer has never had any local message — empty
      //      buffers have no signal to prefer over the engine, so we
      //      trust the engine in that case. PART/KICK for self already
      //      clears isJoined directly via updateChannelUsers, so this
      //      guard doesn't hide a genuine leave from the same IRC
      //      connection.
      for (const buf of existing.buffers) {
        if (buf.name === '_server') continue;
        if (buf.isJoined !== true) continue;
        if (syncedBufferNames.has(buf.name)) continue;
        // If a JOIN is in-flight, don't clobber it — the user explicitly
        // wants to join.
        if (buf.joinInFlight === true) continue;
        buf.syncMissedCount = (buf.syncMissedCount ?? 0) + 1;
        // Activity guard: if the buffer has ANY local message (ever), the
        // user has demonstrably been in this channel — the engine snapshot
        // is just stale (lost track after a restart, network glitch,
        // handoff race, etc). Don't flip — without this guard the user
        // sees a bogus "Rejoin" button and the channel drops into the
        // Inactive section even though they're still chatting in the room.
        // The original guard only checked the last 5 minutes, which let
        // the flip happen during quiet periods (lurking, idle tabs).
        // The user-initiated PART/KICK for self already clears isJoined
        // directly (see updateChannelUsers), so this guard doesn't hide
        // a genuine leave.
        const bufKey = `${existing.networkId}:${buf.name}`;
        const localMsgs = ircState.messages[bufKey];
        if (localMsgs && localMsgs.length > 0) continue;
        // Only flip after the threshold is reached. Otherwise just hold
        // the counter and wait for the next sync — the engine snapshot
        // will likely catch up on its own.
        if (buf.syncMissedCount < ORPHAN_FLIP_THRESHOLD) continue;
        buf.isJoined = false;
        buf.pendingIsJoined = undefined;
        buf.pendingConfirmations = undefined;
      }
      // Remove phantom buffers that were auto-created from URL navigation
      // but never appeared in the engine's sync data. These are channels
      // that don't exist on this network — keeping them in the sidebar
      // (even under "Inactive") is confusing. Phantoms use a lower
      // threshold (1 sync) than orphan channels (3 syncs) because the
      // sync arrives within milliseconds — if it doesn't include the
      // phantom, the channel genuinely doesn't exist on this network.
      for (const buf of existing.buffers) {
        if (!buf.isPhantom) continue;
        if (syncedBufferNames.has(buf.name)) continue;
        if (buf.joinInFlight === true) continue;
        buf.syncMissedCount = (buf.syncMissedCount ?? 0) + 1;
        if (buf.syncMissedCount < 1) continue;
        existing.buffers = existing.buffers.filter(b => b !== buf);
      }
      // IRCCloud-style: sync now includes message history in the buffer
      // objects (sourced from Redis scrollback on the server).  Pull it
      // out and feed setMessages so the chat area renders without waiting
      // for a separate REST API round-trip.
      // NOTE: we iterate net.buffers (the incoming sync data), NOT
      // existing.buffers.  The individual property assignments above
      // copy topic/users/status etc. but do NOT copy 'messages' since
      // the Buffer interface doesn't declare that transient field.
      // The incoming objects from the JSON deserialization still carry it.
      //
      // The sync payload uses the engine's wire-format keys (`x` for text,
      // `c` for command, etc.) because it's a verbatim slice of the Redis
      // scrollback JSON. Feed each entry through normalizeMessage so the
      // frontend sees IRCMessage-shaped objects — without this, server-log
      // phase events render with empty bodies in ServerLogCard (the field
      // name `text` is never set; only `x` survives the JSON trip).
      for (const buf of net.buffers) {
        const rawMsgs = (buf as Buffer & { messages?: IRCMessage[] }).messages;
        if (rawMsgs && rawMsgs.length > 0) {
          const key = `${existing.networkId}:${buf.name}`;
          if (!ircState.messages[key] || ircState.messages[key].length === 0) {
            const msgs = rawMsgs.map((m) => normalizeMessage(m as unknown as Record<string, unknown>));
            setMessages(existing.networkId, buf.name, msgs);
            // Force-scroll the active buffer when its initial messages arrive
            // from the sync — the buffer-switch force-scroll (in setActiveBuffer)
            // often fires before messages are loaded, landing at scrollTop=0.
            // Without this re-trigger the user lands partway through history
            // instead of at the very bottom.
            const active = ircState.activeBuffer;
            if (active.networkId === existing.networkId && active.bufferName === buf.name) {
              requestForceScrollToBottom();
            }
          }
          delete (buf as Buffer & { messages?: IRCMessage[] }).messages;
        }
      }
      // Drop any locally-tracked buffers the user has since hidden so the
      // buffer list stays in sync with hiddenChannelsMap across refreshes.
      existing.buffers = existing.buffers.filter(
        b => b.name === '_server' || !hiddenChannelsMap[`${existing.networkId}:${b.name}`]
      );
      // Defensive dedup: if the same channel ended up in `existing.buffers`
      // twice (e.g. an old phantom from setActiveBuffer() + a real buffer
      // created by a JOIN event arriving in the same tick, before the
      // engine's snapshot caught up), merge them. Prefer the buffer that
      // reports isJoined: true; otherwise prefer the phantom (it has the
      // user's local unread/highlight state we just preserved). Without
      // this, a single channel can render in both the active and
      // "Inactive" sidebar sections simultaneously.
      {
        const seen = new Map<string, Buffer>();
        for (const buf of existing.buffers) {
          const prev = seen.get(buf.name);
          if (!prev) {
            buf.isPhantom = false;
            seen.set(buf.name, buf);
            continue;
          }
          const joined = buf.isJoined !== false ? buf : prev;
          const other = joined === buf ? prev : buf;
          const merged: Buffer = { ...other, ...joined };
          merged.unreadCount = Math.max(other.unreadCount ?? 0, joined.unreadCount ?? 0);
          merged.highlight = (other.highlight ?? false) || (joined.highlight ?? false);
          merged.isPhantom = false;
          Object.assign(other, merged);
          joined.isPhantom = false;
          seen.set(buf.name, joined);
        }
        existing.buffers = Array.from(seen.values());
      }
    } else {
      net.buffers = net.buffers
        .filter(b => !hiddenChannelsMap[`${net.networkId}:${normalizeChannelName(b.name)}`])
        .map(b => {
          const buf = { ...b, name: normalizeChannelName(b.name) } as Buffer;
          if (buf.users && buf.users.length > 0 && typeof buf.users[0] === 'string') {
            buf.users = (buf.users as unknown as string[]).map(normalizeUser);
          }
          // First sync after boot: fill account/ident/realname so history
          // renders the real name immediately instead of waiting for the
          // next periodic sync (the existing-network branch re-applies
          // this enrichment on every sync).
          enrichMembersFromSync(buf.users, {
            accounts: rawNet.accounts,
            idents: rawNet.idents,
            realnames: rawNet.realnames,
            bufRealnames: (b as SyncBuffer).realnames,
          });
          return buf;
        })
        // Defensive dedup: the sync payload may contain the same channel
        // with different casings (e.g. "#foo" and "#FOO"), which normalize
        // to identical names. Without dedup, duplicate buffer names reach
        // the sidebar's keyed {#each} and Svelte throws each_key_duplicate.
        .filter((buf, i, arr) => arr.findIndex(b => b.name === buf.name) === i);
      if (!net.buffers.some(b => b.name === '_server')) {
        net.buffers.unshift({
          name: '_server', type: 'server', isJoined: true,
          unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
          topic: '', topicSetBy: '', topicSetAt: 0, users: [],
          lastSeenMsgTime: null, firstUnseenMsgIndex: null
        } as Buffer);
      }
      net.awayNicks = net.awayNicks ?? new Set();
      net.capabilities = net.capabilities ?? new Set();
      net.isupport = net.isupport ?? {};
      // Mirror the engine's parsed ISUPPORT map (every key=value or
      // bare flag the server advertised in its 005 stream). The engine
      // sends this both in the initial WS sync payload AND in a
      // dedicated `ISUPPORT` event as the 005 stream completes, so the
      // categorised "Server features" panel can render from structured
      // data instead of having to re-parse raw 005 message text.
      if (typeof rawNet.isupport === 'object' && rawNet.isupport !== null) {
        const raw = rawNet.isupport as Record<string, string>;
        const old = net.isupport ?? {};
        const oldKeys = Object.keys(old);
        const newKeys = Object.keys(raw);
        const same =
          oldKeys.length === newKeys.length &&
          newKeys.every(k => old[k] === raw[k]) &&
          oldKeys.every(k => raw[k] === old[k]);
        if (!same) net.isupport = { ...raw };
      }

      // W2-T02: sync payload ships `retryStatus` only when the engine
      // considers it active (gated by `hasRetryStatus` in protocol.d).
      // Presence adopts the new value; absence (the sync-omitted
      // case) means the engine considers the network healthy and the
      // local value must be cleared — the on-store counterpart to the
      // engine's zero-valued `backoff.reset()` emit. Mirror the
      // ISUPPORT branch above so future readers can scan the two
      // side by side and see the same shape.
      if (rawNet.retryStatus && typeof rawNet.retryStatus === 'object') {
        net.retryStatus = rawNet.retryStatus as RetryStatus;
      } else {
        // Engine intentionally omitted retryStatus. Clear locally too
        // — a stale `attemptCount: N` would otherwise survive a
        // successful reconnect until the next CONNECTION_RETRY_STATUS
        // arrived (which is post-reconnect, not on the same wire
        // frame). Also clear failInfo for the same reason: a
        // successful reconnect should never carry a stale
        // "Disconnected: ..." line. applyRetryStatus's null-clear
        // path handles both fields atomically (TG5 invariant).
        applyRetryStatus(net.networkId, null);
      }
      // failInfo has no engine-omits-vs-presents gate; if it was
      // shipped in the sync, adopt the latest. We DON'T auto-clear
      // here because absent == "engine just sent an empty failInfo"
      // which is indistinguishable from "engine hasn't shipped yet".
      // The CONNECTION_FAIL event path is the authoritative clear.
      if (rawNet.failInfo && typeof rawNet.failInfo === 'object') {
        net.failInfo = rawNet.failInfo as FailInfo;
      }

      // Defense-in-depth C (frontend fallback): if the engine's
      // `channelUsersMap` lists a channel that didn't make it into
      // `net.buffers` (engine-side channelState drift — JOIN
      // self-echo dropped, 353 still arrived), synthesise a
      // joined=true buffer entry for it so the user sees the
      // members list and the correct joined status instead of a
      // Rejoin button on an empty room. The orphan reconciliation
      // loop above would otherwise leave this buffer with
      // isJoined=false and no users, because it's not in
      // syncedBufferNames and has no local messages.
      //
      // We ONLY adopt here when (a) the engine had names for the
      // channel, (b) no existing buffer (joined OR phantom) exists
      // for it, and (c) the network is currently connected — i.e.
      // the IRC server actually believes we're in this room. PART /
      // KICK for self already removes the channel from
      // channelUsers, so adopting from this map is safe even on a
      // racing self-leave.
      const channelUsersMap = (rawNet as any).channelUsersMap as
        Record<string, string[]> | undefined;
      if (channelUsersMap && net.connected) {
        const haveNames = new Set(Object.keys(channelUsersMap));
        // Drop empties so we don't synthesise a "phantom joined" buffer
        // for a channel whose NAMES reply was empty (rare but legal).
        for (const k of [...haveNames]) {
          if (!channelUsersMap[k] || channelUsersMap[k].length === 0)
            haveNames.delete(k);
        }
        for (const chanName of haveNames) {
          const normalized = chanName.startsWith('#')
            ? normalizeChannelName(chanName) : chanName;
          // `existing` may be undefined on the very first sync for
          // this network (we haven't built a local copy yet). Skip
          // the local-buffer dedup in that case — the incoming
          // `net.buffers` check below already protects against
          // duplicates that the engine itself shipped twice.
          if (existing && existing.buffers.some(b => b.name === normalized))
            continue;
          if (net.buffers.some(b => b.name === normalized)) continue;
          // Convert string[] into Member[] via the existing pipeline
          // so the member panel renders with the correct prefix /
          // category / dedup. normalizeUser is defined in this file
          // and handles the bare `nick!user@host` userhost-in-names
          // format the engine emits.
          const stringUsers = channelUsersMap[chanName];
          const memberUsers = stringUsers.map(u =>
            typeof u === 'string'
              ? (normalizeUser as unknown as (x: string) => Member)(u)
              : (u as Member)
          );
          net.buffers.push({
            name: normalized,
            type: 'channel',
            isJoined: true,
            isPhantom: false,
            unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
            topic: '', topicSetBy: '', topicSetAt: 0,
            users: memberUsers,
            lastSeenMsgTime: null, firstUnseenMsgIndex: null,
          } as Buffer);
        }
        // Re-sort by IRCCloud convention now that we've inserted new
        // channels out-of-order.
        sortBuffers(net);
      }
      // Make sure currentNick is present in every synthesised
      // channel's member list — the engine's RPL_NAMREPLY doesn't
      // always include self (some IRCds omit it). Mirrors the
      // existingBuf.isJoined===true re-add block at line 1590 so a
      // hand-synthesised buffer from channelUsersMap also includes
      // the current user, even if the NAMES reply dropped us.
      if (net.connected && net.currentNick) {
        const selfBare = stripPrefix(net.currentNick);
        for (const buf of net.buffers) {
          if (buf.name === '_server') continue;
          if (buf.isJoined !== true) continue;
          if (!buf.users) buf.users = [];
          if (!buf.users.some(u => stripPrefix(u.nick) === selfBare)) {
            buf.users.push({
              nick: net.currentNick, prefix: '', category: 'MEMBER',
              ident: '', realname: '', isAway: false, awayMessage: '',
              lastSpoke: 0, lastHighlighted: 0, account: '',
            });
          }
        }
      }
      net.connectionState =
        net.status === 'connecting' ? 'connecting' :
        net.connected               ? 'connected'   :
                                      'disconnected';

      // IRCCloud-style: pull message history out of the buffer objects
      // and into ircState.messages (avoids duplicating + eliminates the
      // REST API round-trip for boot).
      //
      // Sync `messages[]` arrives in the engine's wire-format keys (`x`
      // for text, `c` for command, etc.) — a verbatim slice of the Redis
      // scrollback JSON. normalizeMessage() translates it into the
      // IRCMessage shape used everywhere else in the frontend so phase
      // events surface their `text` body (without this, ServerLogCard
      // would render phase chips but `msg.text === undefined` and the
      // timeline body shows `&nbsp;`).
      for (const buf of net.buffers) {
        const rawMsgs = (buf as Buffer & { messages?: IRCMessage[] }).messages;
        if (rawMsgs && rawMsgs.length > 0) {
          const key = `${net.networkId}:${buf.name}`;
          if (!ircState.messages[key] || ircState.messages[key].length === 0) {
            const msgs = rawMsgs.map((m) => normalizeMessage(m as unknown as Record<string, unknown>));
            setMessages(net.networkId, buf.name, msgs);
            const active = ircState.activeBuffer;
            if (active.networkId === net.networkId && active.bufferName === buf.name) {
              requestForceScrollToBottom();
            }
          }
          delete (buf as Buffer & { messages?: IRCMessage[] }).messages;
        }
      }

      ircState.networks.push(net);
    }
  }

  // Defensive dedup: if two networks ended up with the same networkId
  // (e.g. a sync race with a locally-created network before the backend
  // assigned an id), merge them. Duplicate ids crash Svelte's keyed each
  // block in the Sidebar.
  {
    const seen = new Map<string, Network>();
    for (const net of ircState.networks) {
      const id = net.networkId;
      const prev = seen.get(id);
      if (!prev) {
        seen.set(id, net);
        continue;
      }
      const merged: Network = { ...prev, ...net };
      Object.assign(prev, merged);
      seen.set(id, prev);
    }
    ircState.networks.splice(0, ircState.networks.length, ...Array.from(seen.values()));
  }

  // Apply user-defined sidebar order. Items in `networkOrder` come first in
  // that order; items not in the list (e.g. a freshly-added network) are
  // appended at the end in their current (engine-emitted) order. Uses a
  // stable sort so the relative order of unknown networks is preserved.
  if (networkOrder.length > 0) {
    const orderIndex = new Map<string, number>();
    networkOrder.forEach((id, i) => orderIndex.set(id, i));
    ircState.networks.sort((a, b) => {
      const ai = orderIndex.get(a.networkId);
      const bi = orderIndex.get(b.networkId);
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return 0;
    });
  }

  // Sync persisted pin state to buffer objects
  for (const net of ircState.networks) {
    for (const buf of net.buffers) {
      const key = `${net.networkId}:${buf.name}`;
      buf.isPinned = pinnedMap[key] === true;
    }
  }

  // IRCCloud-style: maintain alphabetical order for all buffer lists
  for (const net of ircState.networks) {
    sortBuffers(net);
  }
}

export function handleConnect(cmd: string, networkId: string, text?: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  if (cmd === '001' || cmd === 'CONNECT' || cmd === 'CONNECTED') {
    net.connected = true;
    net.connectionState = 'connected';
    net.disconnectReason = '';
  } else if (cmd === 'DISCONNECT' || cmd === 'DISCONNECTED') {
    net.connected = false;
    net.connectionState = 'disconnected';
    if (text) net.disconnectReason = text;
  }
  // Any connect/disconnect event is fresh activity for the network —
  // update lastSeenAt so the stale indicator clears promptly.
  markNetworkSeen(networkId);
}

/**
 * Apply a freshly-received ISUPPORT map to the network. Sent by the
 * engine as a dedicated synthetic event when the 005 reply stream
 * finishes — see `IRCRawEvent.makeIsupport` in
 * `source/ircfiber/models/irc_event.d`. Each entry is `{key=value}` or
 * `{key}` (bare flag); the WS payload is a JSON object whose keys are
 * the upper-cased ISUPPORT tokens and whose values are wire-format
 * values (empty string for bare flags).
 *
 * Empty value means "bare flag" — the server sent `KNOCK` not
 * `KNOCK=something`. `CategorizedFeature.isFlag` in
 * `lib/isupportCategorize.ts` is what downstream consumers should
 * inspect to distinguish.
 */
export function applyIsupportUpdate(
  networkId: string,
  raw: Record<string, string>,
): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  const old = net.isupport ?? {};
  const oldKeys = Object.keys(old);
  const newKeys = Object.keys(raw);
  const same =
    oldKeys.length === newKeys.length &&
    newKeys.every(k => old[k] === raw[k]) &&
    oldKeys.every(k => raw[k] === old[k]);
  if (same) return;
  net.isupport = { ...raw };
  markNetworkSeen(networkId);
}
/**
 * W2-T02: apply the engine's `CONNECTION_RETRY_STATUS` event payload
 * to a network's `retryStatus` field. The engine emits this event at
 * every reconnect-loop cycle (see source/ircfiber/irc/connection.d
 * around line 1595) AND at every `backoff.reset()` site with all-zero
 * arguments so the frontend can clear both `net.retryStatus` AND
 * `net.failInfo` in one shot (per plan W1-T01 B3 / TG5).
 *
 * Critical invariant (TG5): a `null` status CLEARs BOTH `retryStatus`
 * AND `failInfo`. Without the dual-clear, a successful reconnect
 * following a fail cycle would leave a stale "Disconnected: ..."
 * line on the banner even after the connection came back. The
 * dispatch boundary in messageHandler.ts converts the engine's
 * zero-valued payload (`{attemptCount:0, nextRetryAtMs:0, delayMs:0}`)
 * to a literal `null` before calling this function.
 */
export function applyRetryStatus(
  networkId: string,
  status: RetryStatus | null,
): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  net.retryStatus = status;
  if (!status) {
    // Same recovery path as the engine's `backoff.reset()` site — a
    // cleared retry implies "we are no longer in a failure cycle".
    // Wipe failInfo too so the banner stops showing "Disconnected: ..."
    // copy on the next render.
    net.failInfo = null;
  }
  markNetworkSeen(networkId);
}

/**
 * W2-T02: apply the engine's `CONNECTION_FAIL` event payload to a
 * network's `failInfo` field. The engine emits this event at the
 * disconnect path (see source/ircfiber/irc/connection.d around line
 * 1422-1431 and `IRCRawEvent.makeConnectionFail` in
 * source/ircfiber/models/irc_event.d). The legacy `disconnectReason`
 * string is still set elsewhere for back-compat — new code reads
 * `failInfo` first.
 *
 * Note: this function DOES NOT touch `net.retryStatus`. A
 * CONNECTION_FAIL can arrive while the engine is mid-backoff (the
 * fail reason just landed; the retry schedule hasn't been cancelled
 * yet). Clearing belongs to the engine's NEXT `backoff.reset()`
 * emit, which calls `applyRetryStatus(networkId, null)` and triggers
 * the dual-clear path above. Splitting the two keeps the dispatch
 * order canonical: one event → one store function.
 */
export function applyFail(
  networkId: string,
  failInfo: FailInfo,
): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  net.failInfo = failInfo;
  markNetworkSeen(networkId);
}

export function updateChannelUsers(networkId: string, bufferName: string, cmd: string, nick: string, params?: string[], prefix?: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  // All channel-user mutations (NAMES, JOIN, PART, MODE, etc.) are
  // evidence the network is still alive — refresh the stale marker.
  markNetworkSeen(networkId);
  const normalized = normalizeChannelName(bufferName);
  let buf = net.buffers.find(b => b.name === normalized);

  // Auto-create buffer when the current user joins a channel.
  // Handles joins from external clients, rejoin after mode changes, etc.
  const joinNick = stripPrefix(nick);
  if (!buf && cmd === 'JOIN' && joinNick === net.currentNick) {
    // If this channel was previously hidden (deleted from sidebar), unhide it
    // so it shows up again automatically. Without this, the user would have to
    // manually /join to bring it back even after re-joining from another client.
    const hiddenKey = `${networkId}:${normalized}`;
    if (hiddenChannelsMap[hiddenKey]) {
      unhideChannel(networkId, normalized);
    }
    buf = {
      name: normalized, type: 'channel', isJoined: true,
      unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
      topic: '', topicSetBy: '', topicSetAt: 0, users: [],
      lastSeenMsgTime: Date.now(), firstUnseenMsgIndex: null,
    };
    net.buffers.push(buf);
    sortBuffers(net);
    // W1-T06: track user-initiated JOIN (auto-created buffer path)
    recordJoin(networkId, normalized);
  }

  // you_nickchange is a network-level event (IRCCloud-style). Handle it
  // BEFORE the buffer check so it updates currentNick and ALL buffers'
  // member lists even when targeting _server (which has no users array).
  if (cmd === 'you_nickchange' && params && params.length >= 2) {
    const newNick = params[params.length - 1];
    const oldNick = params[0];
    net.currentNick = newNick;
    net.currentNickUpdatedAt = Date.now();
    net.pendingSelfNickChange = undefined;
    for (const b of net.buffers) {
      if (b.users) {
        for (const u of b.users) {
          if (stripPrefix(u.nick) === oldNick) {
            const oldBare = stripPrefix(u.nick);
            u.nick = u.prefix + newNick;
            pendingNickChanges.set(`${networkId}:${b.name}:${oldBare}`, { newNick, setAt: Date.now() });
          }
        }
      }
    }
    return;
  }

  if (!buf) return;
  if (!buf.users) buf.users = [];

  // Defensive dedup: remove any duplicate entries by stripped nick.
  // The backend can briefly include the same user twice (bare nick +
  // prefixed+hostmask form) during stale sync snapshots, which would
  // otherwise crash MemberList's keyed each block with each_key_duplicate.
  const seen = new Set<string>();
  const deduped: Member[] = [];
  for (const u of buf.users) {
    const bare = stripPrefix(u.nick);
    if (bare && !seen.has(bare)) {
      seen.add(bare);
      deduped.push(u);
    }
  }
  if (deduped.length !== buf.users.length) {
    buf.users = deduped;
  }

  if (cmd === '353' && params) {
    const nicks = params[params.length - 1]?.split(' ') ?? [];
    for (const n of nicks) {
      if (!n) continue;
      const stripped = stripPrefix(n);
      const mode = getUserModePrefix(n);
      // userhost-in-names: nick!user@host — extract ident
      const bang = n.indexOf('!');
      const identEJ = bang > 0 ? n.slice(bang + 1).split('@')[0] : '';
      // Find an existing entry by stripped nick. If found, PROMOTE it to
      // the prefixed form (in place) so the operator status survives
      // even when the JOIN handler raced ahead with a bare-nick entry.
      // Without this in-place promotion, services that auto-op a user
      // on JOIN leave the bare entry in place and the prefixed form
      // gets dropped, hiding the op indicator in the member list.
      const existing = buf.users.find(u => stripPrefix(u.nick) === stripped);
      // Realname from the engine's network-wide cache (populated from
      // extended-join / WHOIS 311; shipped on every WS sync). NAMES
      // itself doesn't carry a realname, so without this the member
      // would stay bare until the next sync enrichment runs.
      const cachedRealname = net.realnames?.[stripped] ?? '';
      const sensibleRealname = cachedRealname && cachedRealname !== stripped ? cachedRealname : '';
      if (existing) {
        if (existing.nick !== n) existing.nick = n;
        if (!existing.prefix) existing.prefix = mode.prefix;
        if (existing.category === 'MEMBER' || !existing.category) existing.category = mode.category;
        if (identEJ && !existing.ident) existing.ident = identEJ;
        if (sensibleRealname && !existing.realname) existing.realname = sensibleRealname;
      } else {
        buf.users.push({
          nick: n, prefix: mode.prefix, category: mode.category,
          ident: identEJ, realname: sensibleRealname, isAway: false, awayMessage: '',
          lastSpoke: 0, lastHighlighted: 0, account: ''
        });
      }
    }
  } else if (cmd === 'JOIN' && joinNick === net.currentNick) {
    buf.isJoined = true;
    // JOIN for self is authoritative — the buffer is no longer a phantom
    // even if it was auto-created by setActiveBuffer before the JOIN
    // event reached us.
    if (buf.isPhantom) buf.isPhantom = false;
    // Add our nick to the userlist so the current user always appears in
    // the member panel, even if the IRC server omits us from RPL_NAMREPLY
    // (353).  The 353 handler at line 1437 dedups by stripped nick, so
    // adding here early is safe.
    if (!buf.users) buf.users = [];
    if (!buf.users.some(u => stripPrefix(u.nick) === net.currentNick)) {
      buf.users.push({
        nick: net.currentNick, prefix: '', category: 'MEMBER',
        ident: '', realname: '', isAway: false, awayMessage: '',
        lastSpoke: 0, lastHighlighted: 0, account: ''
      });
    }
    // Mark pending so the next sync doesn't overwrite with a stale
    // snapshot taken before the JOIN propagated to the engine.
    buf.pendingIsJoined = true;
    buf.pendingConfirmations = 2;
    buf.joinInFlight = false;
    buf.joinError = null;
    // W7-T01: clear the pendingJoins dedup so future URL navigations to
    // this channel can re-issue JOIN if the user later parts.
    clearJoinPending(networkId, normalized);
    clearNotInChannelDedup(networkId, normalized);
    // W1-T06: track user-initiated JOIN (existing buffer path)
    recordJoin(networkId, normalized);
  } else if (cmd === '404') {
    // ERR_CANNOTSENDTOCHAN — "No external channel messages" etc.
    // This is the spam the user reported on #superbowl. The engine forwards
    // it as a normal 404 event; we detect the not-in-channel phrasing and
    // flip isJoined=false so the BufferHeader's Rejoin/Archive banner
    // appears at the top. The message itself is deduped in messageHandler
    // (show once per 30s). Moderated (+m) channels also use 404 but say
    // "You need voice" — we only flip when the text matches not-in-channel.
    const text = (params && params.length >= 2 ? params[params.length - 1] : '') || '';
    // params for 404 is [yourNick, #channel, reason]; the channel is
    // params[1]. We already resolved bufferName→normalized, but verify
    // the param channel matches before flipping (defense-in-depth).
    const targetChan = params && params.length >= 2 ? normalizeChannelName(params[1] || '') : normalized;
    if (targetChan !== normalized) {
      // Channel mismatch — don't flip a different buffer. Still allow the
      // message to be appended (messageHandler will route by event.channel).
    } else if (isNotInChannelText(text)) {
      if (buf.isJoined) {
        buf.isJoined = false;
        buf.joinInFlight = false;
        buf.pendingIsJoined = undefined;
        buf.pendingConfirmations = undefined;
        buf.joinError = null;
        clearJoinPending(networkId, normalized);
        clearActiveJoin(networkId, normalized);
      }
    }
  } else if (
    cmd === '471' || cmd === '473' || cmd === '474' ||
    cmd === '475' || cmd === '477' || cmd === '405' ||
    cmd === '437' || cmd === '442' || cmd === '443' ||
    cmd === '476' || cmd === '484' || cmd === '403' ||
    cmd === '470'
  ) {
    // JOIN failure numerics — clear the in-flight flag, surface the error
    // in the BufferHeader, and keep the buffer in the sidebar so the user
    // can see the reason + retry. Maps RFC 2812 §4.2.1 / common IRCd
    // extensions to human-readable joinError codes the UI understands.
    const codeMap: Record<string, 'full' | 'invite-only' | 'banned' | 'key-required' | 'unknown'> = {
      '471': 'full',           // ERR_CHANNELISFULL
      '473': 'invite-only',    // ERR_INVITEONLYCHAN
      '474': 'banned',         // ERR_BANNEDFROMCHAN
      '475': 'key-required',   // ERR_BADCHANNELKEY
      '477': 'unknown',        // ERR_NEEDREGGEDNICK
      '405': 'unknown',        // ERR_TOOMANYCHANNELS
      '437': 'unknown',        // ERR_UNAVAILRESOURCE (RFC 2812 §5 / common IRCd extension)
      '442': 'unknown',        // ERR_NOTONCHANNEL
      '443': 'unknown',        // ERR_USERONCHANNEL — user is already in channel
      '476': 'unknown',        // ERR_BADCHANMASK (RFC 2812 §5)
      '484': 'unknown',        // ERR_RESTRICTED (RFC 2812 §5)
      '403': 'unknown',        // ERR_NOSUCHCHANNEL
      '470': 'unknown',        // ERR_LINKCHANNEL — forwarding to another channel (e.g. #superbowl → #blackhole)
    };
    if (buf) {
      // 443 (ERR_USERONCHANNEL) means the user IS already in the channel —
      // treat it as a successful join, not an error. Set the pending guard
      // so the next sync doesn't clobber isJoined back to false.
      if (cmd === '443') {
        buf.isJoined = true;
        buf.joinError = null;
        buf.joinInFlight = false;
        buf.pendingIsJoined = true;
        buf.pendingConfirmations = 2;
      } else {
        buf.joinError = codeMap[cmd] ?? 'unknown';
        buf.joinInFlight = false;
        buf.isJoined = false;
        buf.pendingIsJoined = undefined;
        buf.pendingConfirmations = undefined;
      }
    }
    clearJoinPending(networkId, normalized);
    clearActiveJoin(networkId, normalized);
  } else if (cmd === 'JOIN' && nick && nick !== net.currentNick) {
    const stripped = stripPrefix(nick);
    if (!buf.users.some(u => stripPrefix(u.nick) === stripped)) {
      // Capture the userhost from the prefix so we can populate `ident`
      // and the IRCCloud-style `isBot` flag from the host suffix without
      // waiting for a separate WHO/WHOIS. Members added later via NAMES
      // get filled in by the same heuristic (see PRIVMSG handler / the
      // `isBotNick` helper in MessageRow.svelte).
      const ident = prefix && prefix.includes('!')
        ? prefix.slice(prefix.indexOf('!') + 1)
        : '';
      const host = ident.includes('@') ? ident.slice(ident.lastIndexOf('@') + 1) : '';
      const isBot = !!host && /(^|\.)bot(\.|$)/i.test(host);
      // extended-join: params = [channel, account, realname]
      const acct = params && params.length >= 3 ? params[1] : '';
      const realnameEJ = params && params.length >= 3 ? params[2] : '';
      // Fall back to the engine's network-wide realname cache when the
      // server didn't negotiate extended-join (the engine learns it via
      // a follow-up WHOIS/311 and ships it on the next sync — using the
      // cache here shows it without waiting for that round-trip).
      const cachedRealname = net.realnames?.[nick] ?? '';
      const realname =
        realnameEJ && realnameEJ !== nick
          ? realnameEJ
          : cachedRealname && cachedRealname !== nick ? cachedRealname : '';
      buf.users.push({
        nick, prefix: '', category: 'MEMBER',
        ident, realname, isAway: false, awayMessage: '',
        lastSpoke: 0, lastHighlighted: 0, account: acct, isBot
      });
    }
  } else if (cmd === 'PART' && nick === net.currentNick) {
    buf.isJoined = false;
    buf.pendingIsJoined = false;
    buf.pendingConfirmations = undefined;
    buf.joinInFlight = false;
    // W1-T06: clear activeJoin tracking on self-PART
    clearActiveJoin(networkId, normalized);
    clearJoinPending(networkId, normalized);
  } else if ((cmd === 'PART' || cmd === 'QUIT') && nick) {
    buf.users = buf.users.filter(u => stripPrefix(u.nick) !== nick);
  } else if (cmd === 'KICK' && params && params[1]) {
    if (params[1] === net.currentNick) {
      buf.isJoined = false;
      buf.pendingIsJoined = false;
      buf.pendingConfirmations = undefined;
      buf.joinInFlight = false;
      // W1-T06: clear activeJoin tracking on self-KICK
      clearActiveJoin(networkId, normalized);
      clearJoinPending(networkId, normalized);
    } else buf.users = buf.users.filter(u => stripPrefix(u.nick) !== params[1]);
  } else if (cmd === 'NICK' && nick && params && params.length > 0) {
    const newNick = params[params.length - 1];
    // Mutate EVERY entry that matches the old nick. The same user can
    // appear twice in buf.users — once as a bare entry (added by the JOIN
    // echo), once with the host attached (added by 353 with
    // userhost-in-names, or by WHO). Without this loop, only one entry
    // gets renamed and the other lingers as a stale duplicate in the
    // member list, which the user sees as "the old nick is still in
    // the sidebar".
    for (const u of buf.users) {
      if (stripPrefix(u.nick) === nick) {
        // Capture the OLD bare nick before mutating u.nick — the pending
        // entry must be keyed by the pre-change nick so a stale sync
        // snapshot (which still reports the old nick) can find and apply
        // our local change.
        const oldBare = stripPrefix(u.nick);
        u.nick = u.prefix + newNick;
        const key = `${networkId}:${normalized}:${oldBare}`;
        pendingNickChanges.set(key, { newNick, setAt: Date.now() });
        // No break — continue mutating every matching entry.
      }
    }
    // Self-detection: prefer the pending self-nick-change tracker set by
    // /nick, the nick-edit form, or the input-area nick click. The plain
    // `nick === net.currentNick` fallback is exact-only and misses two
    // real-world cases:
    //   1. Local /nick optimistically sets currentNick to the NEW value,
    //      so the echo's `nick` (the OLD value) never matches currentNick
    //      even though the change is unambiguously ours.
    //   2. IRC nick comparison is casemap-aware (RFC 1459), so a /nick
    //      that only differs in case ("alice" → "Alice") wouldn't match
    //      either.
    // The tracker remembers the pre-change nick exactly so we can match
    // either side without ambiguity.
    const pending = net.pendingSelfNickChange;
    if (pending && Date.now() - pending.setAt < PENDING_SELF_NICK_TTL_MS) {
      const nickMatches = normaliseIdentifier(nick) === normaliseIdentifier(pending.oldNick);
      const newMatches = normaliseIdentifier(newNick) === normaliseIdentifier(pending.newNick);
      if (nickMatches && newMatches) {
        net.currentNick = newNick;
        net.currentNickUpdatedAt = Date.now();
        net.pendingSelfNickChange = undefined;
      } else if (nickMatches && !newMatches) {
        // Server applied a different nick than what we asked for
        // (e.g. normalised a casing variant). Trust the server's value.
        net.currentNick = newNick;
        net.currentNickUpdatedAt = Date.now();
        net.pendingSelfNickChange = undefined;
      }
    } else if (normaliseIdentifier(nick) === normaliseIdentifier(net.currentNick)) {
      // Server-initiated or other-source change that matches our current
      // nick (no pending tracker because we didn't initiate it).
      net.currentNick = newNick;
      net.currentNickUpdatedAt = Date.now();
    }
  } else if (cmd === '433' || cmd === '432') {
    // ERR_NICKNAMEINUSE / ERR_ERRONEUSNICKNAME — the server rejected a
    // /nick we just sent. The engine logs and reverts its sessionNick
    // (see source/ircfiber/irc/connection.d); the frontend mirrors that
    // by reverting the optimistic currentNick. Without this, the input
    // area keeps showing the rejected nick until the next sync — and on
    // reload, the sync reveals the user's actual still-`Zodiac_` nick,
    // making the change look like it never happened at all.
    const pending = net.pendingSelfNickChange;
    if (pending) {
      net.currentNick = pending.oldNick;
      net.currentNickUpdatedAt = Date.now();
      net.pendingSelfNickChange = undefined;
    }
  } else if (cmd === 'MODE' && params && params.length >= 2) {
    // IRC wire format: MODE <target> <modes> [<mode-params>...]
    //   - Channel mode: MODE #chan +oo alice bob        → params = ['#chan', '+oo', 'alice', 'bob']
    //   - User mode:    MODE nick :+i                   → params = ['nick', '+i']
    // params[0] is the target (channel or nick); the mode string is params[1].
    // The previous implementation incorrectly read params[0] as the mode string,
    // which produced wrong results on every channel MODE event (and could even
    // assign a wrong role if the channel name happened to contain 'a' or 'o').
    const target = params[0];
    const modeStr = params[1];
    // Channel MODE events have a target starting with '#' or '&' AND at least
    // 3 params (mode + ≥1 target). Anything else is a user-mode change that
    const isChannelMode =
      params.length >= 3 &&
      (target.startsWith('#') || target.startsWith('&') || target.startsWith('!') || target.startsWith('+'));
    if (isChannelMode) {
      const targets = params.slice(2);
      let adding = true;
      let targetIdx = 0;
      for (const ch of modeStr) {
        if (ch === '+') { adding = true; continue; }
        if (ch === '-') { adding = false; continue; }
        if ('oOaAhvq'.includes(ch) && targetIdx < targets.length) {
          const targetNick = targets[targetIdx++];
          const member = buf.users.find(u => stripPrefix(u.nick) === targetNick);
          const prefixMap: Record<string, { prefix: string; category: ModeCategory }> = {
            'q': { prefix: '~', category: 'OWNER' },
            'a': { prefix: '&', category: 'ADMIN' },
            'o': { prefix: '@', category: 'OP' },
            'O': { prefix: '@', category: 'OPER' },
            'h': { prefix: '%', category: 'HALFOP' },
            'v': { prefix: '+', category: 'VOICED' },
          };
          const pm = prefixMap[ch];
          if (member && adding && pm) {
            member.prefix = pm.prefix;
            member.category = pm.category;
            member.nick = pm.prefix + stripPrefix(member.nick);
          } else if (member && !adding) {
            member.prefix = '';
            member.category = 'MEMBER';
            member.nick = stripPrefix(member.nick);
          } else if (!member && adding && pm) {
            // MODE arrived before the user was in the list (or user joined via services). Add them so the new prefix is visible immediately.
            buf.users.push({
              nick: pm.prefix + targetNick,
              prefix: pm.prefix,
              category: pm.category,
              ident: '',
              realname: '',
              isAway: false,
              awayMessage: '',
              lastSpoke: 0,
              lastHighlighted: 0,
              account: ''
            });
          }
        }
      }
      // Channel mode flags (IRCCloud-style CSS classes)
      if (!buf.modeFlags) buf.modeFlags = {};
      const channelModeMap: Record<string, keyof typeof buf.modeFlags> = {
        's': 'secret', 'p': 'private', 'm': 'moderated',
        'i': 'inviteOnly', 'k': 'password', 't': 'topicControl',
        'n': 'noExternal', 'l': 'limited',
      };
      for (const ch of modeStr) {
        if (ch === '+' || ch === '-') continue;
        const flag = channelModeMap[ch];
        if (flag && !'oOaAhvq'.includes(ch)) {
          buf.modeFlags[flag] = adding;
        }
      }
    }
  }
}

export function getSortedMembers(): Map<ModeCategory, Member[]> {
  const result = new Map<ModeCategory, Member[]>();
  const activeBufferObj = getActiveBufferObj();
  if (!activeBufferObj?.users) return result;

  for (const cat of MODE_HIERARCHY) {
    const members = activeBufferObj.users
      .filter(u => u.category === cat)
      .sort((a, b) => naturalCompare(stripPrefix(a.nick), stripPrefix(b.nick)));
    if (members.length > 0) {
      result.set(cat, members);
    }
  }
  return result;
}

export function updateChannelTopic(networkId: string, bufferName: string, topic: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  const buf = net.buffers.find(b => b.name === normalizeChannelName(bufferName));
  if (buf) {
    buf.topic = topic;
    buf.topicSetAt = Date.now();
  }
  markNetworkSeen(networkId);
}

// ── W3-T01a: Archive-names client cache ──
let archiveNamesCache: Record<string, string[]> | null = null;
let archiveNamesCacheTime = 0;

export async function fetchArchiveNames(): Promise<Record<string, string[]>> {
  if (archiveNamesCache && (Date.now() - archiveNamesCacheTime) < 300_000) {
    return archiveNamesCache;  // 5-minute TTL
  }
  const { fetchArchiveNames: apiFetch } = await import('./api');
  const resp = await apiFetch();
  archiveNamesCache = resp.archives;
  archiveNamesCacheTime = Date.now();
  return archiveNamesCache;
}

export { isIgnored };

// ── Stale-network detection ──
//
// Marks networks as recently-seen whenever anything happens on them
// (WS message, buffer update, channel state change, etc.). The UI
// uses `isNetworkStale` to flag networks whose connection has gone
// silent past a threshold, so the user knows which networks might
// have dropped without scrolling through their server log.
//
// `markNetworkSeen` is intentionally a no-op when the networkId
// isn't found (it may have been removed mid-flight, e.g. by a sync
// race) so callers can fire-and-forget from every handler without
// worrying about races.

/** Default staleness threshold: 5 minutes. */
export const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function markNetworkSeen(networkId: string): void {
  if (!networkId) return;
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  net.lastSeenAt = Date.now();
}

export function isNetworkStale(
  network: { lastSeenAt?: number | null },
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): boolean {
  if (!network || !network.lastSeenAt) return false;
  return Date.now() - network.lastSeenAt > thresholdMs;
}
