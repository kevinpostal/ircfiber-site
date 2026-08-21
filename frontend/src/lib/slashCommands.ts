import type { Network } from '../types';
import { sendRaw, sendMessage, requestSync } from '../stores/wsConnection.svelte.ts';
import { reconnectNetwork, disconnectNetwork, clearBacklog } from '../stores/api';
import { setClearedAt, archivedMap, ignoreList, highlightWords, rebuildIgnoreMap } from '../stores/preferences.svelte';
import { ircState, setActiveBuffer, archiveBuffer, deleteBuffer, markUserDisconnected, getActiveNetwork, initiateRejoin, pruneMessagesBefore, clearMessageCache } from '../stores/ircStore.svelte';
import { normalizeChannelName, generateLabel, stripPrefix } from './utils';
import { updateRoute } from './routing';

export type SlashHandler = (args: string[], networkId: string, target: string, network: Network | null) => void;

const commands = new Map<string, SlashHandler>();

export function registerSlash(names: string[], handler: SlashHandler): void {
  for (const name of names) commands.set(name.toLowerCase(), handler);
}

export function getSlashHandler(name: string): SlashHandler | undefined {
  return commands.get(name.toLowerCase());
}

// ── All commands ──

registerSlash(['nick'], (args, networkId, _target, net) => {
  if (!args[0]) throw new Error('Usage: /nick <nickname>');
  if (net) {
    const oldNick = net.currentNick || net.nick || '';
    const newNick = args[0];
    net.pendingSelfNickChange = { oldNick, newNick, setAt: Date.now() };
    net.currentNick = newNick;
    net.currentNickUpdatedAt = Date.now();
    // IRCCloud-style OPTIMISTIC member list update: rename EVERY matching
    // entry in ALL buffers immediately, before the engine even sees the
    // /nick command. This makes the sidebar update INSTANTLY on Enter,
    // not ~10s later when the you_nickchange event finishes its MongoDB
    // + Redis pub/sub round-trip through the engine event processor.
    for (const buf of net.buffers) {
      if (buf.users) {
        for (const u of buf.users) {
          if (stripPrefix(u.nick) === oldNick) {
            u.nick = (u.prefix || '') + newNick;
          }
        }
      }
    }
  }
  sendRaw(networkId, 'NICK ' + args[0]);
});

registerSlash(['topic'], (args, networkId, target) => {
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'TOPIC ' + target + (args.length ? ' :' + args.join(' ') : ''));
});

registerSlash(['away'], (args, networkId, _target, net) => {
  const msg = args.length ? args.join(' ') : 'Away';
  sendRaw(networkId, 'AWAY :' + msg);
  if (net) {
    net.isAway = true;
    net.awayMessage = msg;
  }
});

registerSlash(['back'], (_args, networkId, _target, net) => {
  sendRaw(networkId, 'AWAY');
  if (net) {
    net.isAway = false;
    net.awayMessage = '';
  }
});

registerSlash(['invite'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /invite <nickname>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'INVITE ' + args[0] + ' ' + target);
});

registerSlash(['whois', 'wi'], (args, networkId) => {
  if (!args[0]) throw new Error('Usage: /whois <nickname>');
  const buf = ircState.activeBuffer.bufferName || args[0];
  const nick = args[0];
  ircState.pendingWhois.set(nick.toLowerCase(), { networkId, bufferName: buf, ts: Date.now() });
  // Show immediate loading overlay so /whois always gives feedback
  ircState.overlay.type = 'whois';
  ircState.overlay.data = {
    nick: nick,
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
  } as any;
  sendRaw(networkId, 'WHOIS ' + nick);
});

registerSlash(['ignore'], (args, networkId) => {
  if (!args[0]) {
    const net = ircState.networks.find(n => n.networkId === networkId);
    ircState.overlay = {
      type: 'ignore_list',
      data: { networkId, networkName: net?.name || '' },
    };
    return;
  }
  if (!ignoreList.includes(args[0])) {
    ignoreList.push(args[0]);
    rebuildIgnoreMap();
  }
});

registerSlash(['unignore'], (args) => {
  if (!args[0]) throw new Error('Usage: /unignore <usermask>');
  const idx = ignoreList.indexOf(args[0]);
  if (idx >= 0) {
    ignoreList.splice(idx, 1);
    rebuildIgnoreMap();
  }
});

registerSlash(['op'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /op <nickname>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' +o ' + args[0]);
});

registerSlash(['deop'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /deop <nickname>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' -o ' + args[0]);
});

registerSlash(['voice'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /voice <nickname>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' +v ' + args[0]);
});

registerSlash(['devoice'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /devoice <nickname>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' -v ' + args[0]);
});

registerSlash(['kick'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /kick <nickname> [reason]');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  const reason = args.slice(1).join(' ');
  sendRaw(networkId, 'KICK ' + target + ' ' + args[0] + (reason ? ' :' + reason : ''));
});

registerSlash(['ban'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /ban <banmask>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' +b ' + args[0]);
});

registerSlash(['unban'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /unban <banmask>');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'MODE ' + target + ' -b ' + args[0]);
});

registerSlash(['kickban', 'kb'], (args, networkId, target) => {
  if (!args[0]) throw new Error('Usage: /kickban <nickname> [reason]');
  if (!target?.startsWith('#')) throw new Error('Not in a channel');
  const reason = args.slice(1).join(' ');
  sendRaw(networkId, 'MODE ' + target + ' +b ' + args[0] + '!*@*');
  sendRaw(networkId, 'KICK ' + target + ' ' + args[0] + (reason ? ' :' + reason : ''));
});

registerSlash(['banlist', 'bans'], (args, networkId, target) => {
  const chan = args[0] ? normalizeChannelName(args[0]) : target;
  if (!chan || !chan.startsWith('#')) throw new Error('Not in a channel');
  // Track pending so the 368 reply actually shows the overlay (see App.svelte)
  ircState.pendingBanList.set(`${networkId}:${chan}`, { networkId, ts: Date.now() });
  sendRaw(networkId, 'MODE ' + chan + ' +b');
});

registerSlash(['raw', 'quote'], (args, networkId) => {
  if (!args.length) throw new Error('Usage: /raw <command>');
  sendRaw(networkId, args.join(' '));
});

registerSlash(['umode'], (args, networkId, _target, net) => {
  const nick = net?.currentNick || net?.nick;
  if (!nick) throw new Error('Not connected');
  sendRaw(networkId, 'MODE ' + nick + (args.length ? ' ' + args.join(' ') : ''));
});

registerSlash(['msg'], (args, networkId, _target, net) => {
  if (args.length < 2) throw new Error('Usage: /msg <nick> <message>');
  const target = args[0];
  const text = args.slice(1).join(' ');
  const activeNet = net || ircState.networks.find(n => n.networkId === networkId);
  if (activeNet) {
    // Switch to or create the query buffer so the user sees the conversation
    setActiveBuffer(activeNet.networkId, target);
  }
  sendRaw(networkId, 'PRIVMSG ' + target + ' :' + text);
});

registerSlash(['query'], (args, networkId) => {
  if (!args[0]) throw new Error('Usage: /query <nick>');
  setActiveBuffer(networkId, args[0]);
});

registerSlash(['quit', 'disconnect'], (args, networkId) => {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net && net.host === 'irc.ircfiber.com') {
    throw new Error('The IRC Fiber server cannot be disconnected');
  }
  const reason = args.join(' ');
  markUserDisconnected(networkId);
  void disconnectNetwork(networkId, reason);
});

registerSlash(['part', 'leave', 'pa', 'p', 'l'], (args, networkId, target) => {
  const chan = args[0] ? normalizeChannelName(args[0]) : target;
  const reason = args[0] ? args.slice(1).join(' ') : args.join(' ');
  if (!chan || !chan.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'PART ' + chan + (reason ? ' :' + reason : ''));
  // Optimistically mark as parted — the server echo will confirm it
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) {
    const buf = net.buffers.find(b => b.name === chan);
    if (buf) buf.isJoined = false;
  }
});

registerSlash(['me'], (args, networkId, target, _net) => {
  if (!args.length) throw new Error('Usage: /me <message>');
  if (!target) throw new Error('No target');
  const text = '\x01ACTION ' + args.join(' ') + '\x01';
  const label = generateLabel();
  sendMessage(networkId, target, text, label);
});

registerSlash(['cycle', 'hop', 'rejoin'], (args, networkId, target) => {
  const chan = args[0] ? normalizeChannelName(args[0]) : target;
  // Key extraction is preserved (key variable intentionally unused for now)
  // so future enhancement can pass the key into a future key-aware helper.
  const key = args[0] ? (args[1] || '') : '';
  if (!chan || !chan.startsWith('#')) throw new Error('Not in a channel');
  // W1-T01: drop the PART-before-JOIN (was sendRaw(PART) + sendRaw(JOIN));
  // PART clobbered isJoined mid-flow and broke the optimistic Joining chip.
  // Match IRCCloud semantics — /cycle is "just rejoin".
  initiateRejoin(networkId, chan, { allowReconnect: false });
});

registerSlash(['clear'], async (_args, networkId, target) => {
  const buf = target || '_server';
  setClearedAt(networkId, buf);
  try {
    await clearBacklog(networkId, buf);
    clearMessageCache(networkId, buf);
    pruneMessagesBefore(networkId, buf, Date.now());
  } catch (err) {
    console.error('[slash /clear] API failed (UI filter still applied):', err);
  }
});

registerSlash(['archive', 'close', 'wc', 'a'], (_args, networkId, target) => {
  if (!target || target === '_server') throw new Error('Cannot archive server buffer');
  archiveBuffer(networkId, target);
});

registerSlash(['unarchive'], (args, networkId) => {
  if (!args[0]) throw new Error('Usage: /unarchive <#channel>');
  const chan = normalizeChannelName(args[0]);
  delete archivedMap[`${networkId}:${chan}`];
});

registerSlash(['delete', 'wd', 'rm'], (args, networkId, target, net) => {
  if (!net) return;
  const bufName = args[0] ? normalizeChannelName(args[0]) : target;
  if (!bufName || bufName === '_server') throw new Error('Cannot delete server buffer');
  const buf = net.buffers.find(b => b.name === bufName);
  if (!buf) throw new Error('No such buffer: ' + bufName);
  if (buf.isJoined !== false) {
    sendRaw(networkId, 'PART ' + bufName);
  }
  deleteBuffer(networkId, bufName);
  updateRoute(networkId, ircState.activeBuffer.bufferName ?? '_server');
});

registerSlash(['reconnect'], (_args, networkId) => {
  const net = ircState.networks.find(n => n.networkId === networkId);
  if (net) net.connectionState = 'connecting';
  void reconnectNetwork(networkId);
  requestSync();
});

registerSlash(['highlight', 'hilight'], (args) => {
  if (!args.length) {
    throw new Error(highlightWords.length ? 'Highlight words: ' + highlightWords.join(', ') : 'No custom highlight words');
  }
  for (const w of args) {
    const lower = w.toLowerCase();
    if (!highlightWords.includes(lower)) highlightWords.push(lower);
  }
});

registerSlash(['unhighlight', 'unhilight', 'dehighlight', 'dehilight'], (args) => {
  if (!args.length) throw new Error('Usage: /unhighlight <word>');
  for (const w of args) {
    const lower = w.toLowerCase();
    const idx = highlightWords.indexOf(lower);
    if (idx >= 0) highlightWords.splice(idx, 1);
  }
});

registerSlash(['notice'], (args, networkId) => {
  if (args.length < 2) throw new Error('Usage: /notice <target> <message>');
  sendRaw(networkId, 'NOTICE ' + args[0] + ' :' + args.slice(1).join(' '));
});
