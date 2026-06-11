import type { Network, Buffer, IRCMessage, ActiveBuffer, Member, ModeCategory, OverlayState, ContextMenuState } from '../types';
import { MODE_HIERARCHY } from '../types';
import { normalizeChannelName, getUserModePrefix, stripPrefix, naturalCompare } from '../lib/utils';
import { unreadMap, highlightMap, archivedMap, pinnedMap, hiddenChannelsMap, highlightWords, isIgnored, getLastSeen, setLastSeen, getBottomSeen, setBottomSeen } from './preferences.svelte';
import { archiveChannel as apiArchiveChannel, unarchiveChannel as apiUnarchiveChannel } from './api';

// ── Single reactive state object ──
export type SettingsTab = 'design' | 'account' | 'notifications' | 'chat';

export const ircState = $state({
  networks: [] as Network[],
  activeBuffer: { networkId: null, bufferName: null } as ActiveBuffer,
  messages: {} as Record<string, IRCMessage[]>,
  me: null as { username: string; email: string } | null,
  wsConnected: false,
  focusLost: false,
  lastSeenMsgTime: null as number | null,
  optimisticMessages: new Map<string, IRCMessage>(),
  overlay: { type: null, data: null } as OverlayState,
  contextMenu: { visible: false, x: 0, y: 0, actions: [] } as ContextMenuState,
  showSettings: false,
  settingsTab: 'design' as SettingsTab,
  // IRCCloud backlogDivider: per-buffer marker identifying the message that
  // was the earliest rendered message before the last backlog fetch. The
  // divider row renders immediately above it (BufferLogView.renderBacklogDivider).
  // Only one divider exists per buffer at a time; cleared on buffer switch
  // (IRCCloud re-renders the log fresh on select).
  backlogDivider: {} as Record<string, string>,
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
      // the sidebar so the user can see error/reply messages.
      const isChannel = bufferName.startsWith('#');
      buf = {
        name: bufferName,
        type: isChannel ? 'channel' : 'query',
        isJoined: isChannel ? false : true,
        unreadCount: 0, highlight: false, isPinned: false, isArchived: false,
        topic: '', topicSetBy: '', topicSetAt: 0, users: [],
        lastSeenMsgTime: null, firstUnseenMsgIndex: null,
      } as Buffer;
      net.buffers.push(buf);
      sortBuffers(net);
    } else {
      buf.unreadCount = 0; buf.highlight = false; buf.highlightCount = 0;
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

  // Priority 1: IRCCloud-style previousBuffer
  if (previousBuffer.networkId && previousBuffer.bufferName) {
    const prevKey = `${previousBuffer.networkId}:${previousBuffer.bufferName}`;
    if (!archivedMap[prevKey]) {
      const prevNet = ircState.networks.find(n => n.networkId === previousBuffer.networkId);
      if (prevNet) {
        const prevBuf = prevNet.buffers.find(b => b.name === previousBuffer.bufferName);
        if (prevBuf && prevBuf.isJoined !== false) {
          setActiveBuffer(previousBuffer.networkId, previousBuffer.bufferName);
          return;
        }
      }
    }
  }

  // Priority 2: channel above in the same network's visible list (IRCCloud's getPreviousBufferFromConnection)
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) {
    const visibleBuffers = net.buffers.filter(b =>
      b.name !== '_server' &&
      b.isJoined !== false &&
      !archivedMap[`${networkId}:${b.name}`]
    );

    const currentIdx = visibleBuffers.findIndex(b => b.name === bufferName);

    if (currentIdx > 0) {
      setActiveBuffer(networkId, visibleBuffers[currentIdx - 1].name);
      return;
    }

    if (currentIdx < visibleBuffers.length - 1) {
      setActiveBuffer(networkId, visibleBuffers[currentIdx + 1].name);
      return;
    }

    setActiveBuffer(networkId, '_server');
    return;
  }
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

export function prependMessage(networkId: string, bufferName: string, msg: IRCMessage): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key] ?? [];

  if (msg.eid && list.some((m: IRCMessage) => m.eid === msg.eid)) return;
  if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) return;

  list.unshift(msg);
  ircState.messages[key] = list;
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
  const pending: IRCMessage[] = [];

  for (const msg of msgs) {
    if (msg.label && ircState.optimisticMessages.has(msg.label)) {
      ircState.optimisticMessages.delete(msg.label);
      const idx = list.findIndex((m: IRCMessage) => m.label === msg.label);
      if (idx >= 0) {
        list[idx] = msg;
        continue;
      }
    }
    if (msg.eid && list.some((m: IRCMessage) => m.eid === msg.eid)) continue;
    if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) continue;
    list.push(msg);
    pending.push(msg);
  }

  // Single state assignment triggers one reactive update for the batch
  ircState.messages[key] = list;

  // Update unread counts per message (these are independent state writes
  // but don't affect the message list reactivity)
  if (pending.length > 0) {
    const normBuf = normalizeChannelName(bufferName);
    const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf;
    for (const msg of pending) {
      const isChatMessage = msg.command === 'PRIVMSG' || (msg.command === 'NOTICE' && !!msg.nick);
      const isUnread = isChatMessage && (!isActive || ircState.focusLost);
      if (isUnread) {
        incrementUnread(networkId, bufferName, msg);
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
  saveMessageCache(key, msgs);
}

export function prependMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const existing = ircState.messages[key] ?? [];

  // Dedupe against existing messages. eid is the primary key (IRCCloud-
  // style: every event gets a global sequential eid). msgid and timestamp
  // fallbacks handle legacy messages stored without eid.
  const eidSet = new Set<number>();
  const dedupKeys = new Set<string>();
  for (const m of existing) {
    if (m.eid != null) {
      eidSet.add(m.eid);
    } else if (m.msgid) {
      dedupKeys.add(m.msgid);
    } else if (m.t) {
      dedupKeys.add(`!${m.t}:${(m.text || '').slice(0, 80)}`);
    }
  }
  const filtered = msgs.filter(m => {
    if (m.eid != null) return !eidSet.has(m.eid);
    if (m.msgid) return !dedupKeys.has(m.msgid);
    if (m.t) return !dedupKeys.has(`!${m.t}:${(m.text || '').slice(0, 80)}`);
    return true;
  });

  if (filtered.length > 0) {
    const boundary = existing.find(m => m.eid != null || m.msgid || m.t);
    if (boundary) {
      setBacklogDivider(networkId, bufferName, boundary.eid != null ? `e:${boundary.eid}` : (boundary.msgid || `t:${boundary.t}`));
    }
  }

  ircState.messages[key] = [...filtered, ...existing].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
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
      Object.assign(existing, {
        name: net.name, host: net.host, port: net.port,
        tls: net.tls, verifyTls: net.verifyTls, nick: net.nick,
        realName: net.realName, connected: net.connected,
        status: net.status
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
          const localIsJoined = existingBuf.isJoined;
          const remoteUnread = incomingBuf.unreadCount ?? 0;
          const remoteHighlight = incomingBuf.highlight ?? false;
          // Copy incoming buffer properties except isJoined (IRC events are authoritative)
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
      // Drop any locally-tracked buffers the user has since hidden so the
      // buffer list stays in sync with hiddenChannelsMap across refreshes.
      existing.buffers = existing.buffers.filter(
        b => b.name === '_server' || !hiddenChannelsMap[`${existing.networkId}:${b.name}`]
      );
    } else {
      net.buffers = net.buffers
        .filter(b => !hiddenChannelsMap[`${net.networkId}:${normalizeChannelName(b.name)}`])
        .map(b => {
          const buf = { ...b, name: normalizeChannelName(b.name) } as Buffer;
          if (buf.users && buf.users.length > 0 && typeof buf.users[0] === 'string') {
            buf.users = (buf.users as unknown as string[]).map(normalizeUser);
          }
          return buf;
        });
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
      net.connectionState = net.connected ? 'connected' : 'disconnected';
      ircState.networks.push(net);
    }
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

export function updateChannelUsers(networkId: string, bufferName: string, cmd: string, nick: string, params?: string[]): void {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (!net) return;
  const normalized = normalizeChannelName(bufferName);
  let buf = net.buffers.find(b => b.name === normalized);

  // Auto-create buffer when the current user joins a channel.
  // Handles joins from external clients, rejoin after mode changes, etc.
  if (!buf && cmd === 'JOIN' && nick === net.currentNick) {
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
  } else if (cmd === 'JOIN' && nick && nick !== net.currentNick) {
    const stripped = stripPrefix(nick);
    if (!buf.users.some(u => stripPrefix(u.nick) === stripped)) {
      buf.users.push({
        nick, prefix: '', category: 'MEMBER',
        ident: '', realname: '', isAway: false, awayMessage: '',
        lastSpoke: 0, lastHighlighted: 0, account: ''
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
