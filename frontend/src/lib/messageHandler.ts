import type { IRCMessage, Network, WhoisData, BanEntry, BanListData } from '../types';
import { ircState, handleConnect, updateChannelUsers,
         updateChannelTopic, appendMessage, trimMessagesIfNeeded } from '../stores/ircStore.svelte';
import { isIgnored } from '../stores/preferences.svelte';
import { normalizeChannelName, stripPrefix, isSkippedCommand } from './utils';
import { notify } from './notifications';
import { enqueueMessage } from './messageBatcher';

/** Message append strategy: immediate or batched (IRCCloud-style). */
export type AppendFn = (networkId: string, bufferName: string, msg: IRCMessage) => void;

const defaultAppend: AppendFn = (networkId, bufferName, msg) => {
  appendMessage(networkId, bufferName, msg);
  trimMessagesIfNeeded(networkId, bufferName);
};

// ── Message handler registry ──
// Extracted from App.svelte so command handling is testable independently
// from the component tree. Pattern mirrors IRCCloud's messageHandlers map.

/**
 * Unpack a compact WebSocket message into a typed IRCMessage.
 */
export function unpackEvent(
  data: Record<string, unknown>,
  localMsgIdCounter: { value: number },
): IRCMessage {
  const cmd = (data.command || data.c || '') as string;
  return {
    id: ((data.id as string) || (data.i as string) || `w${++localMsgIdCounter.value}`) as string,
    timestamp: ((data.timestamp as string) || (data.t ? new Date(data.t as number).toISOString() : null)) as string,
    nick: ((data.nick as string) || (data.n as string) || '') as string,
    text: ((data.text as string) || (data.x as string) || '') as string,
    command: cmd,
    params: ((data.params as string[]) || (data.p as string[]) || []) as string[],
    prefix: ((data.prefix as string) || (data.px as string) || '') as string,
    msgid: ((data.msgid as string) || (data.m as string) || '') as string,
    label: ((data.label as string) || (data.l as string) || '') as string,
    t: data.t as number,
    type: data.type as string | undefined,
  };
}

/**
 * Callbacks for side effects the handler can't perform on its own.
 */
export interface HandlerCallbacks {
  switchToBuffer: (networkId: string, bufName: string) => void;
}

/**
 * Mutable accumulator state for ban/whois tracking.
 */
export interface AccumState {
  whoisAcc: Partial<WhoisData> | null;
  banAcc: BanEntry[];
  banTargetChannel: string;
}

/**
 * Process a single IRC event. Handles network lookup, whois/ban accumulation,
 * channel state updates, topic, lastSpoke, and message append/notify.
 */
export function processIrcEvent(
  data: Record<string, unknown>,
  localMsgIdCounter: { value: number },
  accum: AccumState,
  cb: HandlerCallbacks,
  append: AppendFn = defaultAppend,
): {
  /** Set if a whois just completed (set overlay to 'whois'). */
  whoisData?: WhoisData;
  /** Set if a ban list just completed. */
  banListData?: BanListData;
} {
  const msg = unpackEvent(data, localMsgIdCounter);
  const cmd = msg.command;
  const networkName = (data.network || '') as string;
  const channel = normalizeChannelName((data.channel || data.ch || '_server') as string);

  const net = ircState.networks.find(n => n.name === networkName);
  if (!net) return {};
  const networkId = net.networkId;

  // Ignore check
  if (msg.nick && isIgnored(msg.nick)) return {};

  const result: { whoisData?: WhoisData; banListData?: BanListData } = {};

  // ── Whois accumulation ──
  if (/^3(11|312|313|317|319|330)$/.test(cmd)) {
    if (!accum.whoisAcc || accum.whoisAcc.nick !== msg.params?.[0]) {
      accum.whoisAcc = { nick: msg.params?.[0] || '' };
    }
    accumulateWhois(accum, cmd, msg.params || [], msg.text || '');
  } else if (cmd === '318' && accum.whoisAcc) {
    result.whoisData = { ...accum.whoisAcc } as WhoisData;
    accum.whoisAcc = null;
  }

  // ── Ban list accumulation ──
  if (cmd === '367' && msg.params) {
    accum.banAcc.push({
      mask: msg.params[2] || '',
      setBy: msg.params[3] || '',
      setAt: parseInt(msg.params[4] || '0', 10),
    });
    accum.banTargetChannel = msg.params[1] || '';
  } else if (cmd === '368') {
    result.banListData = {
      networkId,
      channel: accum.banTargetChannel,
      bans: [...accum.banAcc],
    };
    accum.banAcc = [];
    accum.banTargetChannel = '';
  }

  // ── Connection state ──
  handleConnect(cmd, networkId, msg.text);

  // ── Channel users ──
  updateChannelUsers(networkId, channel, cmd, msg.nick || '', msg.params);

  // ── Topic ──
  if (cmd === '332' && msg.text) {
    updateChannelTopic(networkId, channel, msg.text);
  } else if (cmd === 'TOPIC' && msg.text) {
    updateChannelTopic(networkId, channel, msg.text);
  }

  // ── lastSpoke tracking ──
  if (cmd === 'PRIVMSG' && msg.nick) {
    const bufObj = net.buffers.find(b => b.name === channel);
    if (bufObj?.users) {
      const u = bufObj.users.find(x => stripPrefix(x.nick) === msg.nick);
      if (u) u.lastSpoke = msg.t ?? Date.now();
    }
  }

  // ── Message append + notification ──
  if (!isSkippedCommand(cmd)) {
    append(networkId, channel, msg);

    if (msg.highlight && (ircState.activeBuffer.networkId !== networkId || ircState.activeBuffer.bufferName !== channel)) {
      notify({
        tag: `${networkId}:${channel}:${msg.msgid || msg.t}`,
        title: `${msg.nick} in ${channel}`,
        body: msg.text || '',
        onClick: () => cb.switchToBuffer(networkId, channel),
      });
    }
  }

  return result;
}

// ── Whois helpers ──

function accumulateWhois(accum: AccumState, cmd: string, params: string[], text: string): void {
  if (!accum.whoisAcc) return;
  switch (cmd) {
    case '311':
      accum.whoisAcc.nick = params[0];
      accum.whoisAcc.user = params[1];
      accum.whoisAcc.host = params[2];
      accum.whoisAcc.realname = text;
      break;
    case '312':
      accum.whoisAcc.server = params[1];
      accum.whoisAcc.serverInfo = text;
      break;
    case '317':
      accum.whoisAcc.idle = parseInt(params[1] || '0', 10);
      accum.whoisAcc.signon = parseInt(params[2] || '0', 10);
      break;
    case '319':
      accum.whoisAcc.channels = text.split(' ').filter(Boolean);
      break;
    case '330':
      accum.whoisAcc.account = params[1];
      break;
  }
}
