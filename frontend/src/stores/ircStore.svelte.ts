import type { Network, Buffer, IRCMessage, ActiveBuffer, Member, ModeCategory, OverlayState, ContextMenuState, ConnectionState } from '../types';
import { MODE_HIERARCHY } from '../types';
import { normalizeChannelName, getUserModePrefix, stripPrefix, naturalCompare } from '../lib/utils';
import { unreadMap, highlightMap, archivedMap, pinnedMap, hiddenChannelsMap, highlightWords, isIgnored, getLastSeen, setLastSeen, getBottomSeen, setBottomSeen, hideChannel, unhideChannel } from './preferences.svelte';
import { archiveChannel as apiArchiveChannel, unarchiveChannel as apiUnarchiveChannel } from './api';
import { appendToProcessed, buildProcessedBuffer, prependReprocess, type ProcessedBuffer } from '../lib/messageBuilder';

// ── Single reactive state object ──
export type SettingsTab = 'design' | 'account' | 'notifications' | 'chat';

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
  // Per-buffer typing state: bufferKey -> (nick -> timestamp of last TAGMSG)
  typing: {} as Record<string, Record<string, number>>,
});

// IRCCloud-style previous-buffer tracking: the buffer that was active before
// the current one. Used by archiveBuffer to select where focus goes.
let previousBuffer: { networkId: string | null; bufferName: string | null } = { networkId: null, bufferName: null };

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
export function setActiveBuffer(networkId: string, bufferName: string): void {
  bufferName = normalizeChannelName(bufferName);

  // Track previous buffer (IRCCloud-style) for archive focus selection
  const prevNetworkId = ircState.activeBuffer.networkId;
  const prevBufferName = ircState.activeBuffer.bufferName;
  if (prevNetworkId && prevBufferName && (prevNetworkId !== networkId || prevBufferName !== bufferName)) {
    previousBuffer = { networkId: prevNetworkId, bufferName: prevBufferName };
  }

  ircState.activeBuffer.networkId = networkId;
  ircState.activeBuffer.bufferName = bufferName;
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
      return;
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

  for (const msg of msgs) {
    if (msg.label && ircState.optimisticMessages.has(msg.label)) {
      ircState.optimisticMessages.delete(msg.label);
      const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
      if (idx >= 0) {
        list[idx] = msg;
        continue;
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

  // Incremental preprocessing: only regroup the new tail (and the
  // previous tail group, if any, in case it merges with the new
  // messages).  This is the per-message append equivalent of IRCCloud's
  // BufferFormatter incremental update — O(new batch + boundary) instead
  // of O(buffer size).
  if (newForProcessed.length > 0) {
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
        }
      }
    }
  }
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
    const mode = getUserModePrefix(user);
    return {
      nick: user,
      prefix: mode.prefix,
      category: mode.category,
      ident: '', realname: '', isAway: false, awayMessage: '',
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

      Object.assign(existing, {
        name: net.name, host: net.host, port: net.port,
        tls: net.tls, nick: net.nick,
        realName: net.realName, connected: net.connected,
        status: net.status, connectionState
      });
      // Don't blindly overwrite currentNick from sync — the IRC NICK event
      // handler is the authoritative source for nick changes. Sync snapshots
      // are taken on a timer and may contain the old nick for a few seconds
      // after a /nick, which would clobber the optimistic UI update. Only
      // adopt the sync value if we don't have one locally yet (initial load).
      if (!existing.currentNick && net.currentNick) {
        existing.currentNick = net.currentNick;
      }
      for (const incomingBuf of net.buffers) {
        incomingBuf.name = normalizeChannelName(incomingBuf.name);
        // Skip channels the user has explicitly deleted — the server still
        // re-includes them in sync (they're in partedChannels), but the UI
        // should keep them hidden.
        if (hiddenChannelsMap[`${existing.networkId}:${incomingBuf.name}`]) continue;
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
          const seen = new Set<string>();
          const deduped: Member[] = [];
          for (const u of incomingBuf.users) {
            const bare = stripPrefix(u.nick);
            if (bare && !seen.has(bare)) {
              seen.add(bare);
              deduped.push(u);
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
          // Copy incoming buffer properties except isJoined (IRC events are
          // authoritative). EXCEPTION: if the existing buffer is a phantom
          // (auto-created by setActiveBuffer() when the user navigated to a
          // channel that didn't exist locally), the sync is the first
          // authoritative signal we have — adopt its isJoined and clear the
          // phantom flag. Without this, a user who navigates to a channel
          // they ARE in would see it locked in "Inactive" forever.
          existingBuf.name = incomingBuf.name;
          existingBuf.type = incomingBuf.type;
          existingBuf.topic = incomingBuf.topic;
          existingBuf.topicSetBy = incomingBuf.topicSetBy;
          existingBuf.topicSetAt = incomingBuf.topicSetAt;
          existingBuf.users = incomingBuf.users;
          existingBuf.isPinned = incomingBuf.isPinned;
          existingBuf.isArchived = incomingBuf.isArchived;
          existingBuf.lastSeenMsgTime = incomingBuf.lastSeenMsgTime;
          existingBuf.firstUnseenMsgIndex = incomingBuf.firstUnseenMsgIndex;
          existingBuf.unreadCount = Math.max(localUnread, remoteUnread);
          existingBuf.highlight = localHighlight || remoteHighlight;
          if (existingBuf.isPhantom) {
            existingBuf.isJoined = incomingBuf.isJoined;
            existingBuf.isPhantom = false;
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
      // IRCCloud-style: sync now includes message history in the buffer
      // objects (sourced from Redis scrollback on the server).  Pull it
      // out and feed setMessages so the chat area renders without waiting
      // for a separate REST API round-trip.
      // NOTE: we iterate net.buffers (the incoming sync data), NOT
      // existing.buffers.  The individual property assignments above
      // copy topic/users/status etc. but do NOT copy 'messages' since
      // the Buffer interface doesn't declare that transient field.
      // The incoming objects from the JSON deserialization still carry it.
      for (const buf of net.buffers) {
        const msgs = (buf as Buffer & { messages?: IRCMessage[] }).messages;
        if (msgs && msgs.length > 0) {
          const key = `${existing.networkId}:${buf.name}`;
          if (!ircState.messages[key] || ircState.messages[key].length === 0) {
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
      for (const buf of net.buffers) {
        const msgs = (buf as Buffer & { messages?: IRCMessage[] }).messages;
        if (msgs && msgs.length > 0) {
          const key = `${net.networkId}:${buf.name}`;
          if (!ircState.messages[key] || ircState.messages[key].length === 0) {
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
  if (cmd === '001' || cmd === 'CONNECT') {
    net.connected = true;
    net.connectionState = 'connected';
    net.disconnectReason = '';
  } else if (cmd === 'DISCONNECT') {
    net.connected = false;
    net.connectionState = 'disconnected';
    if (text) net.disconnectReason = text;
  }
}

export function updateChannelUsers(networkId: string, bufferName: string, cmd: string, nick: string, params?: string[], prefix?: string): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  const normalized = normalizeChannelName(bufferName);
  let buf = net.buffers.find(b => b.name === normalized);

  // Auto-create buffer when the current user joins a channel.
  // Handles joins from external clients, rejoin after mode changes, etc.
  if (!buf && cmd === 'JOIN' && nick === net.currentNick) {
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
      if (!buf.users.some(u => stripPrefix(u.nick) === stripped)) {
        const mode = getUserModePrefix(n);
        buf.users.push({
          nick: n, prefix: mode.prefix, category: mode.category,
          ident: '', realname: '', isAway: false, awayMessage: '',
          lastSpoke: 0, lastHighlighted: 0, account: ''
        });
      }
    }
  } else if (cmd === 'JOIN' && nick === net.currentNick) {
    buf.isJoined = true;
    // JOIN for self is authoritative — the buffer is no longer a phantom
    // even if it was auto-created by setActiveBuffer before the JOIN
    // event reached us.
    if (buf.isPhantom) buf.isPhantom = false;
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
      buf.users.push({
        nick, prefix: '', category: 'MEMBER',
        ident, realname: '', isAway: false, awayMessage: '',
        lastSpoke: 0, lastHighlighted: 0, account: '', isBot
      });
    }
  } else if (cmd === 'PART' && nick === net.currentNick) {
    buf.isJoined = false;
  } else if ((cmd === 'PART' || cmd === 'QUIT') && nick) {
    buf.users = buf.users.filter(u => stripPrefix(u.nick) !== nick);
  } else if (cmd === 'KICK' && params && params[1]) {
    if (params[1] === net.currentNick) buf.isJoined = false;
    else buf.users = buf.users.filter(u => stripPrefix(u.nick) !== params[1]);
  } else if (cmd === 'NICK' && nick && params && params.length > 0) {
    const newNick = params[params.length - 1];
    for (const u of buf.users) {
      if (stripPrefix(u.nick) === nick) {
        u.nick = u.prefix + newNick;
        break;
      }
    }
    if (nick === net.currentNick) {
      net.currentNick = newNick;
    }
  } else if (cmd === 'MODE' && params && params.length >= 2) {
    const modeStr = params[0];
    const targets = params.slice(1);
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
}

export { isIgnored };
