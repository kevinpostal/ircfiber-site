import type { Network } from '../types';
import { sendRaw, sendMessage, requestSync } from '../stores/wsConnection.svelte.ts';
import { reconnectNetwork, disconnectNetwork } from '../stores/api';
import { setClearedAt, archivedMap, ignoreList, highlightWords } from '../stores/preferences.svelte';
import { ircState, setActiveBuffer, archiveBuffer } from '../stores/ircStore.svelte';
import { normalizeChannelName, generateLabel } from './utils';
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
  // Optimistic: update currentNick immediately so the UI reflects the change
  // before the server echoes back the NICK response.
  if (net) net.currentNick = args[0];
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
  ircState.pendingWhois.add(args[0].toLowerCase());
  sendRaw(networkId, 'WHOIS ' + args[0]);
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
  if (!ignoreList.includes(args[0])) ignoreList.push(args[0]);
});

registerSlash(['unignore'], (args) => {
  if (!args[0]) throw new Error('Usage: /unignore <usermask>');
  const idx = ignoreList.indexOf(args[0]);
  if (idx >= 0) ignoreList.splice(idx, 1);
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

registerSlash(['quit', 'disconnect'], (args, networkId) => {
  const reason = args.join(' ');
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
  const key = args[0] ? (args[1] || '') : '';
  if (!chan || !chan.startsWith('#')) throw new Error('Not in a channel');
  sendRaw(networkId, 'PART ' + chan);
  sendRaw(networkId, 'JOIN ' + chan + (key ? ' ' + key : ''));
});

registerSlash(['clear'], (_args, networkId, target) => {
  setClearedAt(networkId, target || '_server');
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
  const channels = net.buffers.filter(b => b.name !== '_server' && b.isJoined !== false);
  const delIdx = channels.findIndex(b => b.name === bufName);
  net.buffers.splice(net.buffers.indexOf(buf), 1);
  if (delIdx > 0) {
    setActiveBuffer(networkId, channels[delIdx - 1].name);
    updateRoute(networkId, channels[delIdx - 1].name);
  } else {
    setActiveBuffer(networkId, '_server');
    updateRoute(networkId, '_server');
  }
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
