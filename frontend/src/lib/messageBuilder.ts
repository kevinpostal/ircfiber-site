import type { IRCMessage, JoinPartGroupMessage, DiscoGroupMessage } from '../types';
import { isJoinPartLike, isDisconnectLike, escapeHtml, stripPrefix } from './utils';

/**
 * Group consecutive MOTD lines (372) into a single MOTD_GROUP message.
 */
export function groupMOTDLines(messages: IRCMessage[]): IRCMessage[] {
  const result: IRCMessage[] = [];
  let motdLines: string[] = [];
  let motdHead: IRCMessage | null = null;

  for (const msg of messages) {
    if (msg.command === '372' || msg.command === '375') {
      if (!motdHead) motdHead = msg;
      motdLines.push(msg.text || '');
    } else {
      if (motdLines.length > 0 && motdHead) {
        result.push({
          ...motdHead,
          command: 'MOTD_GROUP',
          lines: motdLines,
          text: motdLines.join('\n'),
        });
        motdLines = [];
        motdHead = null;
      }
      result.push(msg);
    }
  }
  // Flush remaining
  if (motdLines.length > 0 && motdHead) {
    result.push({
      ...motdHead,
      command: 'MOTD_GROUP',
      lines: motdLines,
      text: motdLines.join('\n'),
    });
  }
  return result;
}

/**
 * Group consecutive join/part/quit/nick/chghost events into collapsible groups.
 * Implements nipped-out / popped-in detection.
 */
export function groupJoinPartEvents(messages: IRCMessage[]): IRCMessage[] {
  const result: IRCMessage[] = [];
  let jpBuffer: IRCMessage[] = [];

  function flushJoinPartGroup(): void {
    if (jpBuffer.length === 0) return;
    if (jpBuffer.length === 1) {
      result.push(jpBuffer[0]);
    } else {
      result.push(buildJoinPartGroup(jpBuffer));
    }
    jpBuffer = [];
  }

  for (const msg of messages) {
    if (isJoinPartLike(msg.command)) {
      jpBuffer.push(msg);
    } else {
      flushJoinPartGroup();
      result.push(msg);
    }
  }
  flushJoinPartGroup();
  return result;
}

interface NickState {
  counter: number;
  lastAction: string;
  hasJoined: boolean;
  hasParted: boolean;
  hostmask: string;
  oldNick?: string;
  newNick?: string;
}

function formatModeText(evt: IRCMessage): string {
  const params = evt.params || [];
  const modeStr = params[1] || evt.text || '';
  if (params.length > 2) {
    return `${modeStr} ${params.slice(2).join(' ')}`;
  }
  return modeStr;
}

function buildJoinPartGroup(events: IRCMessage[]): JoinPartGroupMessage {
  const nickStates = new Map<string, NickState>();
  const modeEvents: IRCMessage[] = [];

  for (const evt of events) {
    if (evt.command === 'MODE') {
      modeEvents.push(evt);
      continue;
    }

    const nick = stripPrefix(evt.nick || '');
    if (!nick) continue;

    if (evt.command === 'NICK' && evt.params?.length) {
      const newNick = evt.params[evt.params.length - 1];
      const state = nickStates.get(nick);
      if (state) {
        nickStates.delete(nick);
        state.oldNick = nick;
        state.newNick = newNick;
        state.lastAction = 'NICK';
        nickStates.set(newNick, state);
      } else {
        nickStates.set(newNick, {
          counter: 0, lastAction: 'NICK',
          hasJoined: false, hasParted: false,
          hostmask: evt.prefix || '', oldNick: nick, newNick
        });
      }
      continue;
    }

    let state = nickStates.get(nick);
    if (!state) {
      state = { counter: 0, lastAction: '', hasJoined: false, hasParted: false, hostmask: evt.prefix || '' };
      nickStates.set(nick, state);
    }

    state.lastAction = evt.command;
    state.hostmask = evt.prefix || state.hostmask;

    if (evt.command === 'JOIN') {
      state.counter++;
      state.hasJoined = true;
    } else if (evt.command === 'PART' || evt.command === 'QUIT') {
      state.counter--;
      state.hasParted = true;
    }
  }

  // Build sentences
  const joined: string[] = [];
  const parted: string[] = [];
  const quit: string[] = [];
  const nippedOut: string[] = [];
  const poppedIn: string[] = [];
  const nickchanged: string[] = [];

  for (const [nick, state] of nickStates) {
    if (state.lastAction === 'NICK' && state.oldNick) {
      nickchanged.push(`${state.oldNick} &rarr; <span class="bufferLink user link">${escapeHtml(nick)}</span>`);
    } else if (state.hasJoined && state.hasParted) {
      if (state.counter > 0) {
        poppedIn.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
      } else if (state.counter < 0) {
        nippedOut.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
      } else {
        if (state.lastAction === 'JOIN') {
          poppedIn.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
        } else {
          nippedOut.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
        }
      }
    } else if (state.counter > 0) {
      joined.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
    } else if (state.lastAction === 'QUIT') {
      quit.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
    } else if (state.counter < 0) {
      parted.push(`<span class="bufferLink user link">${escapeHtml(nick)}</span>`);
    }
  }

  const sentences: string[] = [];
  if (joined.length) sentences.push(`<span class="prefix">&#x2192;</span> ${joined.join(', ')} joined`);
  if (parted.length) sentences.push(`<span class="prefix">&#x2190;</span> ${parted.join(', ')} left`);
  if (quit.length) sentences.push(`<span class="prefix">&#x21D0;</span> ${quit.join(', ')} quit`);
  if (poppedIn.length) sentences.push(`<span class="prefix">&#x2194;</span> ${poppedIn.join(', ')} popped in`);
  if (nippedOut.length) sentences.push(`<span class="prefix">&#x2194;</span> ${nippedOut.join(', ')} nipped out`);
  if (nickchanged.length) sentences.push(`<span class="prefix">&#x2194;</span> ${nickchanged.join(', ')}`);
  for (const me of modeEvents) {
    sentences.push(`<span class="prefix">&#x2699;</span> Channel mode: <b>${escapeHtml(formatModeText(me))}</b>`);
  }

  // IRCCloud uses &nbsp;&nbsp; between sentences and &nbsp;&nbsp;•&nbsp;&nbsp; for the bullet
  const sentenceHtml = sentences.length === 1
    ? sentences[0] + '&nbsp;&nbsp;'
    : sentences.map((s, i) => i === 0 ? s + '&nbsp;&nbsp;' : '<span class="bullet">&nbsp;&nbsp;&#x2022;&nbsp;&nbsp;</span>' + s + '&nbsp;&nbsp;').join('');

  return {
    ...events[0],
    command: 'JOINPART_GROUP',
    events: events.map(e => ({ msg: e, type: 'msg' as const })),
    expanded: false,
    sentences: sentenceHtml,
  } as JoinPartGroupMessage;
}

/**
 * Group consecutive disconnect/error events.
 */
export function groupDisconnectEvents(messages: IRCMessage[]): IRCMessage[] {
  const result: IRCMessage[] = [];
  let discoBuffer: IRCMessage[] = [];

  function flushDiscoGroup(): void {
    if (discoBuffer.length === 0) return;
    if (discoBuffer.length === 1) {
      result.push(discoBuffer[0]);
    } else {
      result.push(buildDiscoGroup(discoBuffer));
    }
    discoBuffer = [];
  }

  for (const msg of messages) {
    if (isDisconnectLike(msg.command, msg.text)) {
      discoBuffer.push(msg);
    } else {
      flushDiscoGroup();
      result.push(msg);
    }
  }
  flushDiscoGroup();
  return result;
}

function buildDiscoGroup(events: IRCMessage[]): DiscoGroupMessage {
  const counts = new Map<string, number>();
  for (const evt of events) {
    const msg = evt.text || 'Disconnected';
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const [msg, count] of counts) {
    parts.push(count > 1 ? `${escapeHtml(msg)} (x${count})` : escapeHtml(msg));
  }

  return {
    ...events[0],
    command: 'DISCO_GROUP',
    events,
    expanded: false,
    sentences: `<span class="prefix">&#x21D0;</span> ${parts.join(', ')}`,
  } as DiscoGroupMessage;
}

/**
 * Full message preprocessing pipeline.
 */
export function preprocessMessages(messages: IRCMessage[]): IRCMessage[] {
  let result = groupMOTDLines(messages);
  result = groupJoinPartEvents(result);
  result = groupDisconnectEvents(result);
  return result;
}
