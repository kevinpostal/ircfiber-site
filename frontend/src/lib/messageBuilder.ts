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
 *
 * A single event is left as-is (no grouped widget).  NICK events are an
 * exception — we also leave them as-is because wrapping a single row in a
 * `<div role="button" tabindex="0">` (from JOINPART_GROUP) makes the
 * scroll container unfocusable via scroll-by-space and can capture touch
 * events, preventing the user from scrolling up to trigger LoadMore.
 * Multiple consecutive NICK events ARE grouped (they become 2+ events).
 */
export function groupJoinPartEvents(messages: IRCMessage[]): IRCMessage[] {
  const result: IRCMessage[] = [];
  let jpBuffer: IRCMessage[] = [];

  function flushJoinPartGroup(): void {
    if (jpBuffer.length === 0) return;
    if (jpBuffer.length === 1) {
      result.push(jpBuffer[0]);
    } else {
      // Sort events by timestamp so the oldest event is first. This
      // ensures the grouped message's `t` (from events[0]) is the
      // oldest in the group, and that the group is placed at the
      // position of the oldest event in chronological order — not at
      // the bottom of the list if messages happened to be received
      // out of order.
      const sorted = [...jpBuffer].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      result.push(buildJoinPartGroup(sorted));
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
  const awayEvents: { nick: string; reason: string; isBack: boolean }[] = [];

  for (const evt of events) {
    if (evt.command === 'MODE') {
      modeEvents.push(evt);
      continue;
    }

    if (evt.command === 'AWAY') {
      const nick = stripPrefix(evt.nick || '');
      if (!nick) continue;
      const reason = evt.text || '';
      awayEvents.push({ nick, reason, isBack: !reason });
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
      // IRCCloud-style: "oldNick → newNick" with only the new nick as a
      // clickable bufferLink. The old nick is plain text.
      nickchanged.push(`${escapeHtml(state.oldNick)} <span class="prefix">&rarr;</span> <span class="bufferLink user link" data-name="${escapeHtml(nick)}">${escapeHtml(nick)}</span>`);
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
  if (nickchanged.length) sentences.push(nickchanged.join(', '));
  for (const me of modeEvents) {
    sentences.push(`<span class="prefix">&#x2699;</span> Channel mode: <b>${escapeHtml(formatModeText(me))}</b>`);
  }
  // Group AWAY events: list all unique nicks going away / coming back
  if (awayEvents.length) {
    const awayNicksSet = new Set<string>();
    const backNicksSet = new Set<string>();
    let commonReason = '';
    let allSameReason = true;
    for (const a of awayEvents) {
      if (a.isBack) {
        backNicksSet.add(a.nick);
      } else {
        awayNicksSet.add(a.nick);
        if (!commonReason) {
          commonReason = a.reason;
        } else if (commonReason !== a.reason) {
          allSameReason = false;
        }
      }
    }
    if (awayNicksSet.size) {
      const nicksHtml = [...awayNicksSet]
        .map(n => `<span class="bufferLink user link">${escapeHtml(n)}</span>`)
        .join(', ');
      const verb = awayNicksSet.size === 1 ? 'is away' : 'are away';
      if (allSameReason && commonReason) {
        const title = escapeHtml(commonReason);
        sentences.push(
          `<span class="prefix">&#x2691;</span> ${nicksHtml} ${verb}: <span class="awayReason" title="${title}">${title}</span>`
        );
      } else {
        sentences.push(`<span class="prefix">&#x2691;</span> ${nicksHtml} ${verb}`);
      }
    }
    if (backNicksSet.size) {
      const nicksHtml = [...backNicksSet]
        .map(n => `<span class="bufferLink user link">${escapeHtml(n)}</span>`)
        .join(', ');
      const verb = backNicksSet.size === 1 ? 'is back' : 'are back';
      sentences.push(`<span class="prefix">&#x2691;</span> ${nicksHtml} ${verb}`);
    }
  }

  // Join sentences with a thin bullet separator (spacing handled by CSS)
  const sentenceHtml = sentences.map((s, i) => {
    if (i === 0) return s + '\u00A0';
    return '<span class="bullet">\u2022</span>' + s;
  }).join('') + '\u00A0';

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
