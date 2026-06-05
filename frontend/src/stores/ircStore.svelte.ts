import type { Network, Buffer, IRCMessage, ActiveBuffer, Member, ModeCategory, OverlayState, ContextMenuState } from '../types';
import { MODE_HIERARCHY } from '../types';
import { normalizeChannelName, getUserModePrefix, stripPrefix, naturalCompare } from '../lib/utils';
import { unreadMap, highlightMap, archivedMap, pinnedMap, highlightWords, isIgnored, getLastSeen, setLastSeen, getBottomSeen, setBottomSeen } from './preferences.svelte';

// ── Single reactive state object ──
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
});

// ── Derived state (read-only computed) ──
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
  ircState.activeBuffer.networkId = networkId;
  ircState.activeBuffer.bufferName = bufferName;
  const key = `${networkId}:${bufferName}`;
  delete unreadMap[key];
  delete highlightMap[key];
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) {
    const buf = net.buffers.find(b => b.name === bufferName);
    if (buf) { buf.unreadCount = 0; buf.highlight = false; }
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
    }
  }
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

  if (msg.msgid && list.some((m: IRCMessage) => m.msgid === msg.msgid)) return;

  list.push(msg);
  ircState.messages[key] = list;

  const normBuf = normalizeChannelName(bufferName);
  const isActive = ircState.activeBuffer.networkId === networkId && ircState.activeBuffer.bufferName === normBuf;
  const lastSeen = getLastSeen(networkId, bufferName);
  // Only count as unread if:
  // 1. Buffer is not active, OR
  // 2. Buffer is active but message is after lastSeen (tab was in background)
  const isUnread = !isActive || (lastSeen !== null && (msg.t || 0) > lastSeen);
  if (isUnread) {
    incrementUnread(networkId, bufferName, msg);
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
    if (buf) buf.highlight = true;
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

export function setMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  ircState.messages[key] = msgs;
}

export function prependMessages(networkId: string, bufferName: string, msgs: IRCMessage[]): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const existing = ircState.messages[key] ?? [];
  ircState.messages[key] = [...msgs, ...existing];
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
  const startIdx = startMsg ? list.findIndex(m => m.msgid === startMsg.msgid && m.msgid) : 0;
  const endIdx = endMsg ? list.findIndex(m => m.msgid === endMsg.msgid && m.msgid) : list.length - 1;
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
  const startIdx = startMsg ? list.findIndex(m => m.msgid === startMsg.msgid && m.msgid) : 0;
  const endIdx = endMsg ? list.findIndex(m => m.msgid === endMsg.msgid && m.msgid) : list.length - 1;
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
  const msgIdx = list.findIndex(m => m.msgid === msg.msgid && m.msgid);
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
  const startIdx = msg ? list.findIndex(m => m.msgid === msg.msgid && m.msgid) : -1;
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

const MAX_MESSAGES = 350;
const TRIM_TO = 200;

export function trimMessagesIfNeeded(networkId: string, bufferName: string): void {
  const key = `${networkId}:${normalizeChannelName(bufferName)}`;
  const list = ircState.messages[key];
  if (!list || list.length <= MAX_MESSAGES) return;
  ircState.messages[key] = list.slice(list.length - TRIM_TO);
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
        status: net.status, currentNick: net.currentNick
      });
      for (const incomingBuf of net.buffers) {
        incomingBuf.name = normalizeChannelName(incomingBuf.name);
        // Convert string users to Member objects from backend sync
        if (incomingBuf.users && incomingBuf.users.length > 0 && typeof incomingBuf.users[0] === 'string') {
          incomingBuf.users = (incomingBuf.users as unknown as string[]).map(normalizeUser);
        }
        const existingBuf = existing.buffers.find(b => b.name === incomingBuf.name);
        if (existingBuf) {
          Object.assign(existingBuf, incomingBuf);
        } else {
          existing.buffers.push(incomingBuf);
        }
      }
    } else {
      net.buffers = net.buffers.map(b => {
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
  const buf = net.buffers.find(b => b.name === normalizeChannelName(bufferName));
  if (!buf) return;
  if (!buf.users) buf.users = [];

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
