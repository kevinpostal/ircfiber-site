import type { Network, Buffer, IRCMessage, ActiveBuffer, Member, ModeCategory, OverlayState, ContextMenuState, ConnectionState } from '../types';
import { MODE_HIERARCHY } from '../types';
import { normalizeChannelName, getUserModePrefix, stripPrefix, naturalCompare } from '../lib/utils';
import { unreadMap, highlightMap, archivedMap, pinnedMap, hiddenChannelsMap, highlightWords, isIgnored, getLastSeen, setLastSeen, getBottomSeen, setBottomSeen, hideChannel, unhideChannel, networkOrder, conversationsCollapsedMap } from './preferences.svelte';
import { archiveChannel as apiArchiveChannel, unarchiveChannel as apiUnarchiveChannel, normalizeMessage, reconnectNetwork } from './api';
import { sendRaw } from './wsConnection.svelte';
import { appendToProcessed, buildProcessedBuffer, prependReprocess, type ProcessedBuffer } from '../lib/messageBuilder';
import { recentHighlightersCache } from '../lib/tabCompletion';

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
  // but those should NOT pop up the WHOIS overlay. App.svelte consumes
  // this set to gate the overlay. Entries are removed when the matching
  // WHOIS completes (318) or fails (401).
  pendingWhois: new Set<string>(),
  // IRCCloud backlogDivider: per-buffer marker identifying the message that
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
  // Per-buffer typing state: bufferKey -> (nick -> timestamp of last TAGMSG)
  typing: {} as Record<string, Record<string, number>>,
  // IRCCloud-style "reorder mode": when true, the Sidebar enters drag-and-drop
  // reorder for the network list and suppresses normal click/collapse on
  // network headers. Toggled by the "Reorder Networks" / "Done" buttons.
  reorderMode: false,
  // W1-T08: temp_unavailable state per buffer. Keyed by `${networkId}:${bufferName}`.
  // expireAt = serverTs + countdownMs (unix ms). The UI computes remaining
  // = max(0, expireAt - Date.now()).
  tempUnavailable: {} as Record<string, { expireAt: number }>,
});

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
// Auto-clear stale pending entries after 60s in case a sync never confirms.
const PENDING_NICK_TTL_MS = 60_000;

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
  if (prevNetworkId && prevBufferName && (prevNetworkId !== networkId || prevBufferName !== bufferName)) {
    previousBuffer = { networkId: prevNetworkId, bufferName: prevBufferName };
  }

  ircState.activeBuffer.networkId = networkId;
  ircState.activeBuffer.bufferName = bufferName;
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
  const buf = net.buffers.find(b => b.name === normalized);

  // Idempotency: if a JOIN is already in flight for this buffer, the
  // existing pendingJoins entry blocks double-issuance. Mirrors
  // maybeAutoJoinChannel's guard at App.svelte:557.
  if (isJoinPending(networkId, normalized)) return;

  // Set the FULL state-machine quartet. This is the single source
  // of truth — every caller sets all four flags.
  if (buf) {
    buf.joinError = null;          // clear stale failure text
    buf.joinInFlight = true;       // drives BufferHeader chip + sidebar modifier
    buf.pendingIsJoined = true;    // belt-and-suspenders for WS-round-trip clobber
    buf.pendingConfirmations = 2;  // require TWO confirming syncs to clear
    // W1-T06: track user-initiated JOIN so buffersToDelete during WS
    // resume cannot reap this buffer.
    prePopulateOwnNick(buf, net.currentNick);
  }
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
  ircState.messages[key] = list;
  // Prepending shifts the head boundary; rebuild the processed buffer
  // from the prepended tail to keep the head group valid.
  ircState.processedMessages[key] = buildProcessedBuffer(list);
  markNetworkSeen(networkId);
}

export function appendMessage(networkId: string, bufferName: string, msg: IRCMessage): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];

  if (msg.label && ircState.optimisticMessages.has(msg.label)) {
    ircState.optimisticMessages.delete(msg.label);
    const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
    if (idx >= 0) {
      list[idx] = msg;
      ircState.messages[key] = list;
      // Rebuild the processed cache so the echo replaces the stale
      // optimistic entry — otherwise the cache diverges from the raw
      // array and the optimistic can reappear on re-render.
      ircState.processedMessages[key] = buildProcessedBuffer(list);
      return;
    }
  }

  // Edit-echo label match: when sendEditMessage re-uses the original
  // label, the echo arrives with that same label but the optimistic
  // entry was already consumed by the first echo. Replace in-place.
  if (msg.label) {
    const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
    if (idx >= 0) {
      list[idx] = msg;
      ircState.messages[key] = list;
      // Rebuild processed cache since the message text changed in-place
      ircState.processedMessages[key] = buildProcessedBuffer(list);
      return;
    }
  }

  // Self-echo fallback: server echo without label — match optimistic
  // by text content to avoid duplicate when labeled-response is absent.
  if (msg.selfEcho) {
    for (const [optLabel, optMsg] of ircState.optimisticMessages) {
      // Compare nicks case-insensitively: the IRC server's echo may use
      // a different casing (e.g. "Zod") than the local currentNick
      // ("zod"), causing the strict equality to miss the match.
      if (optMsg.text === msg.text && optMsg.nick.toLowerCase() === msg.nick.toLowerCase() && optMsg.command === 'PRIVMSG') {
        ircState.optimisticMessages.delete(optLabel);
        const idx = list.findIndex((m: IRCMessage) => m.label === optLabel);
        if (idx >= 0) {
          list[idx] = msg;
          ircState.messages[key] = list;
          ircState.processedMessages[key] = buildProcessedBuffer(list);
          return;
        }
      }
    }
  }

  if (msg.eid && list.some((m: IRCMessage) => m.eid === msg.eid)) return;
  if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) return;

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
export function batchAppendMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  if (msgs.length === 0) return;

  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];
  // Build a Set of eids/msgids already in the buffer so dedup is O(1)
  // per new message instead of O(n) with list.some().  Without this, a
  // burst of 200 messages appended to a 200-message list is 40,000 ops.
  const seenEids = new Set<number>();
  const seenMsgids = new Set<string>();
  for (const m of list) {
    if (m.eid != null) seenEids.add(m.eid);
    else if (m.msgid) seenMsgids.add(m.msgid);
  }
  const pending: IRCMessage[] = [];
  const newForProcessed: IRCMessage[] = [];
  let addedUnread = 0;
  let hasHighlight = false;
  let hasChat = false;
  let replacedEdit = false;

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
    // Edit-echo label match: same label as an existing message but the
    // optimistic entry was consumed by the original echo. Replace in-place.
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
    if (msg.selfEcho) {
      // Search optimistic messages for one with matching text content.
      // Compare nicks case-insensitively: the IRC server's echo may use
      // different casing than the local currentNick.
      let foundOptLabel: string | null = null;
      for (const [optLabel, optMsg] of ircState.optimisticMessages) {
        if (optMsg.text === msg.text && optMsg.nick.toLowerCase() === msg.nick.toLowerCase() && optMsg.command === 'PRIVMSG') {
          foundOptLabel = optLabel;
          break;
        }
      }
      if (foundOptLabel) {
        ircState.optimisticMessages.delete(foundOptLabel);
        const idx = list.findIndex((m: IRCMessage) => m.label === foundOptLabel);
        if (idx >= 0) {
          list[idx] = msg;
          replacedEdit = true;
          continue;
        }
      }
    }
    // Dedup against the existing list AND against earlier messages in
    // the same batch (eid/msgid could collide within a burst if the
    // server replays the same event). Without the within-batch check
    // the same eid can reach the {#each} twice and Svelte throws
    // each_key_duplicate.
    if (msg.eid != null) {
      if (seenEids.has(msg.eid)) continue;
      seenEids.add(msg.eid);
    } else if (msg.msgid) {
      if (seenMsgids.has(msg.msgid)) continue;
      seenMsgids.add(msg.msgid);
    }
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
      const normBuf = normalizeChannelName(bufferName);
      const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf;
      if (!isActive || ircState.focusLost) addedUnread++;
      if (msg.highlight) hasHighlight = true;
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
  if (addedUnread > 0 || hasHighlight) {
    const net = ircState.networks.find(n => n.networkId === networkId);
    const buf = net?.buffers.find(b => b.name === normalizeChannelName(bufferName));
    if (addedUnread > 0) {
      unreadMap[key] = (unreadMap[key] ?? 0) + addedUnread;
      if (buf) buf.unreadCount = (buf.unreadCount ?? 0) + addedUnread;
    }
    if (hasHighlight) {
      highlightMap[key] = true;
      if (buf) {
        buf.highlight = true;
        buf.highlightCount = (buf.highlightCount ?? 0) + 1;
      }
    }
  }

  // Per-message processing for things that can't be batched (highlight
  // tag check uses regex on message text + nick).
  if (pending.length > 0 && hasChat) {
    const net = ircState.networks.find(n => n.networkId === networkId);
    if (net) {
      for (const msg of pending) {
        const isChatMessage = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
        if (isChatMessage && checkHighlight(msg, net)) {
          msg.highlight = true;
          if (msg.nick) recordHighlight(networkId, bufferName, msg.nick);
        }
      }
    }
  }

  markNetworkSeen(networkId);
}

export function incrementUnread(networkId: string, bufferName: string, msg: IRCMessage): void {
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

// ── Recent highlighters tracking (Tab completion cycling) ──

export function recordHighlight(networkId: string, bufferName: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = recentHighlightersCache.get(key) ?? [];
  // De-dupe: remove existing occurrence if present
  const filtered = list.filter(n => n !== nick);
  // Prepend (most recent first), max 10
  filtered.unshift(nick);
  recentHighlightersCache.set(key, filtered.slice(0, 10));
}

// ── Typing indicators (IRCCloud-style TAGMSG) ──
// Each TAGMSG from a nick resets a 6.5s heartbeat. The UI reads the
// timestamp and hides the indicator when the window expires. Entries
// are lazily cleaned up on read.

export function setTyping(networkId: string, channel: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(channel)}`;
  if (!ircState.typing[key]) ircState.typing[key] = {};
  ircState.typing[key][nick] = Date.now();
}

export function clearTyping(networkId: string, channel: string, nick: string): void {
  const key = `${networkId}:${normalizeChannelName(channel)}`;
  if (ircState.typing[key]) {
    delete ircState.typing[key][nick];
    ircState.typing = { ...ircState.typing };
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
  ircState.messages[key] = msgs;
  ircState.processedMessages[key] = buildProcessedBuffer(msgs);
  saveMessageCache(key, msgs);
  markNetworkSeen(networkId);
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
    else if (m.msgid) dedupKeys.add(m.msgid);
    else if (m.t) dedupKeys.add(`!${m.t}:${(m.text || '').slice(0, 80)}`);
  }
  const filtered: IRCMessage[] = [];
  for (const m of msgs) {
    if (m.eid != null) {
      if (eidSet.has(m.eid)) continue;
      eidSet.add(m.eid);
    } else if (m.msgid) {
      if (dedupKeys.has(m.msgid)) continue;
      dedupKeys.add(m.msgid);
    } else if (m.t) {
      const k = `!${m.t}:${(m.text || '').slice(0, 80)}`;
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

  const merged = [...filtered, ...existing].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  ircState.messages[key] = merged;
  // Prepending changes the head boundary in ways that can't be fixed
  // incrementally — fall back to a full pass on the merged raw array.
  ircState.processedMessages[key] = prependReprocess(existing, filtered);
  markNetworkSeen(networkId);
}

// Marks are sequence-prefixed (`<seq>|<msgid or t:ts>`) so every fetch or
// in-memory reveal produces a UNIQUE mark even when boundary messages lack
// msgids and share timestamps — the divider-scroll choreography keys off
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

export function updateNetworkFromSync(incoming: Network[]): void {
  for (const rawNet of incoming as (Network & { id?: string })[]) {
    // Map backend `id` field to frontend `networkId`
    const net = rawNet as Network;
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
      existing.sasl = net.sasl;
      existing.saslUsername = net.saslUsername;
      // Don't overwrite saslPassword from sync if empty — the API may
      // mask it for security (returning empty string on edits). Preserve
      // what the user already set locally.
      if (net.saslPassword) existing.saslPassword = net.saslPassword;
      existing.status = net.status;
      // systemManaged is a server-side flag we don't expect to change
      // during a session; only adopt it from sync if we don't have a
      // value yet (initial load). Treat undefined/missing as false.
      if (net.systemManaged !== undefined) existing.systemManaged = net.systemManaged;

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
          if (!(connectionState === 'connected' && userDisconnectedAt.has(existing.networkId))) {
            existing.connected = net.connected;
            existing.connectionState = connectionState;
          }
          } else if (connectionState === 'connecting' && !isLiveConnected) {
        // The sync confirms connection is in progress — this is new info
        // that live events haven't provided yet (001 hasn't fired, or the
        // engine is between attempts in its backoff loop). Show it so the
        // user gets a "Disconnect" button to cancel the pending reconnect.
        existing.connectionState = connectionState;
      }
      // Don't blindly overwrite currentNick from sync — the IRC NICK event
      // handler is the authoritative source for nick changes. Sync snapshots
      // are taken on a timer and may contain the old nick for a few seconds
      // after a /nick, which would clobber the optimistic UI update. Only
      // adopt the sync value if we don't have one locally yet (initial load).
      if (!existing.currentNick && net.currentNick) {
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
          // Dedup by stripped nick, preferring the entry WITH an IRC
          // prefix over a bare nick, so that a services-granted op survives
          // the snapshot round-trip even when the engine's channelUsers
          // briefly contains both "user" and "@user" (a known race between
          // the JOIN handler and the 353/WHO dedup).
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
              // Prefer the entry with a prefix if this one has it and
              // the existing one doesn't, or if the existing one's nick
              // is shorter (bare), replace it.
              const existingU = deduped[existing];
              const existingHasPrefix = existingU.prefix && existingU.prefix.length > 0;
              const thisHasPrefix = u.prefix && u.prefix.length > 0;
              if (thisHasPrefix && !existingHasPrefix) {
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
          // Ensure the self-nick survives the sync even when the engine's
          // channelUsers snapshot doesn't include it yet (race between JOIN
          // echo and NAMES/353 response). Without this, the user disappears
          // from the member list until the next periodic snapshot.
          if (existingBuf.isJoined && existing.currentNick) {
            const selfBare = stripPrefix(existing.currentNick);
            if (!existingBuf.users.some(u => stripPrefix(u.nick) === selfBare)) {
              existingBuf.users.push({
                nick: existing.currentNick, prefix: '', category: 'MEMBER',
                ident: '', realname: '', isAway: false, awayMessage: '',
                lastSpoke: 0, lastHighlighted: 0, account: '',
              });
            }
          }
          // Enrich members with extended-join data from network-level
          // accounts/idents/realnames caches (sync JSON carries these as
          // extra fields beyond the Buffer/Network interface).
          const syncAccounts = (rawNet as any).accounts as Record<string, string> | undefined;
          const syncIdents = (rawNet as any).idents as Record<string, string> | undefined;
          if (syncAccounts || syncIdents) {
            for (const m of existingBuf.users) {
              if (syncAccounts && !m.account) {
                const acct = syncAccounts[m.nick];
                if (acct) m.account = acct;
              }
              if (syncIdents && !m.ident) {
                const id = syncIdents[m.nick];
                if (id) m.ident = id;
              }
            }
          }
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
          // W7-T01: if a JOIN is in-flight from URL navigation, treat it as
          // pending=true. The engine sync snapshot often races the JOIN and
          // reports isJoined=false before the JOIN event reaches us; without
          // this guard the snapshot would clobber the user-initiated join.
          const effectivePending =
            existingBuf.joinInFlight === true ? true : pending;
          if (existingBuf.isPhantom) {
            // Phantom buffers have no event-driven state — adopt blindly,
            // but only if no JOIN is in-flight from URL nav.
            if (existingBuf.joinInFlight !== true) {
              existingBuf.isJoined = incomingJoined;
              existingBuf.isPhantom = false;
            }
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
            const c = existingBuf.pendingConfirmations ?? 2;
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
        } else {
          existing.buffers.push(incomingBuf);
        }
      }
      // Reconcile orphan channels: buffers that were in existing.buffers but
      // NOT in the incoming sync.  These are channels the engine no longer
      // tracks (not in channelState nor partedChannels) — the user is no
      // longer joined.  Without this, a stale isJoined:true would persist
      // and block auto-join on URL navigation (maybeAutoJoinChannel's guard
      // at App.svelte:545 would skip the JOIN).
      for (const buf of existing.buffers) {
        if (buf.name === '_server') continue;
        if (buf.isJoined !== true) continue;
        if (syncedBufferNames.has(buf.name)) continue;
        // If a JOIN is in-flight, don't clobber it — the user explicitly
        // wants to join.
        if (buf.joinInFlight === true) continue;
        buf.isJoined = false;
        buf.pendingIsJoined = undefined;
        buf.pendingConfirmations = undefined;
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
      net.chanTypes = net.chanTypes ?? '#';
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
      if (existing) {
        if (existing.nick !== n) existing.nick = n;
        if (!existing.prefix) existing.prefix = mode.prefix;
        if (existing.category === 'MEMBER' || !existing.category) existing.category = mode.category;
        if (identEJ && !existing.ident) existing.ident = identEJ;
      } else {
        buf.users.push({
          nick: n, prefix: mode.prefix, category: mode.category,
          ident: identEJ, realname: '', isAway: false, awayMessage: '',
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
    // W1-T06: track user-initiated JOIN (existing buffer path)
    recordJoin(networkId, normalized);
  } else if (
    cmd === '471' || cmd === '473' || cmd === '474' ||
    cmd === '475' || cmd === '477' || cmd === '405' ||
    cmd === '437' || cmd === '442' || cmd === '443' ||
    cmd === '476' || cmd === '484' || cmd === '403'
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
      buf.users.push({
        nick, prefix: '', category: 'MEMBER',
        ident, realname: realnameEJ || '', isAway: false, awayMessage: '',
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
        break;
      }
    }
    if (nick === net.currentNick) {
      net.currentNick = newNick;
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
    // doesn't affect the channel user list.
    const isChannelMode =
      params.length >= 3 &&
      (target.startsWith('#') || target.startsWith('&'));
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
          if (member && adding) {
            const prefixMap: Record<string, { prefix: string; category: ModeCategory }> = {
              'q': { prefix: '~', category: 'OWNER' },
              'a': { prefix: '&', category: 'ADMIN' },
              'o': { prefix: '@', category: 'OP' },
              'O': { prefix: '@', category: 'OPER' },
              'h': { prefix: '%', category: 'HALFOP' },
              'v': { prefix: '+', category: 'VOICED' },
            };
            const pm = prefixMap[ch];
            if (pm) {
              member.prefix = pm.prefix;
              member.category = pm.category;
              member.nick = pm.prefix + stripPrefix(member.nick);
            }
          } else if (member && !adding) {
            member.prefix = '';
            member.category = 'MEMBER';
            member.nick = stripPrefix(member.nick);
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
