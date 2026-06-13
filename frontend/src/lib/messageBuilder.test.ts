import { describe, it, expect } from 'vitest';
import {
  groupMOTDLines,
  groupJoinPartEvents,
  groupDisconnectEvents,
  preprocessMessages,
  appendToProcessed,
  prependReprocess,
  buildProcessedBuffer,
} from './messageBuilder';
import type { IRCMessage, JoinPartGroupMessage } from '../types';

describe('groupMOTDLines', () => {
  it('leaves single MOTD line as-is', () => {
    const messages: IRCMessage[] = [
      { command: '372', text: '- Welcome to the server' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupMOTDLines(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('MOTD_GROUP');
    expect(result[0].lines).toEqual(['- Welcome to the server']);
  });

  it('groups multiple consecutive MOTD lines', () => {
    const messages: IRCMessage[] = [
      { command: '375', text: '- server Message of the Day' },
      { command: '372', text: '- Line 1' },
      { command: '372', text: '- Line 2' },
      { command: '372', text: '- Line 3' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupMOTDLines(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('MOTD_GROUP');
    expect(result[0].lines).toEqual([
      '- server Message of the Day',
      '- Line 1',
      '- Line 2',
      '- Line 3',
    ]);
    expect(result[1].command).toBe('PRIVMSG');
  });

  it('groups 375 and 372 together', () => {
    const messages: IRCMessage[] = [
      { command: '375', text: 'Start of MOTD' },
      { command: '372', text: 'MOTD content' },
    ];
    const result = groupMOTDLines(messages);
    expect(result[0].command).toBe('MOTD_GROUP');
    expect(result[0].lines).toEqual(['Start of MOTD', 'MOTD content']);
  });

  it('handles non-MOTD messages untouched', () => {
    const messages: IRCMessage[] = [
      { command: 'PRIVMSG', text: 'hello' },
      { command: 'NOTICE', text: 'notice' },
    ];
    const result = groupMOTDLines(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('PRIVMSG');
    expect(result[1].command).toBe('NOTICE');
  });

  it('flushes remaining MOTD at end of array', () => {
    const messages: IRCMessage[] = [
      { command: 'PRIVMSG', text: 'hello' },
      { command: '372', text: '- trailing MOTD' },
    ];
    const result = groupMOTDLines(messages);
    expect(result).toHaveLength(2);
    expect(result[1].command).toBe('MOTD_GROUP');
    expect(result[1].lines).toEqual(['- trailing MOTD']);
  });
});

describe('groupJoinPartEvents', () => {
  it('leaves single join/part as-is', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('JOIN');
  });

  it('leaves a single NICK as-is (no grouped widget to avoid scroll-capture)', () => {
    // A lone NICK must stay as a regular row, not wrapped in
    // JOINPART_GROUP with role="button" + tabindex="0", because that
    // makes the scroll container lose focus and prevents scrolling up
    // to trigger LoadMore.
    const messages: IRCMessage[] = [
      { command: 'NICK', nick: 'alice', prefix: 'alice!user@host', params: ['newalice'] },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('NICK');
  });

  it('groups multiple consecutive join/part events', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'JOIN', nick: 'bob', prefix: 'bob!user@host' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('JOINPART_GROUP');
    expect(result[0].events).toHaveLength(2);
  });

  it('groups JOIN, PART, QUIT, NICK, CHGHOST together', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'PART', nick: 'bob', prefix: 'bob!user@host', text: 'leaving' },
      { command: 'QUIT', nick: 'charlie', prefix: 'charlie!user@host', text: 'bye' },
      { command: 'NICK', nick: 'dave', prefix: 'dave!user@host', params: ['newdave'] },
      { command: 'CHGHOST', nick: 'eve', prefix: 'eve!user@host' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('JOINPART_GROUP');
    expect(result[0].events).toHaveLength(5);
  });

  it('groups AWAY events together', () => {
    const messages: IRCMessage[] = [
      { command: 'AWAY', nick: 'acidvegas', prefix: 'acidvegas!user@host', text: 'I am away' },
      { command: 'AWAY', nick: 'frodo', prefix: 'frodo!user@host', text: 'Auto-away' },
      { command: 'AWAY', nick: 'acidvegas', prefix: 'acidvegas!user@host', text: 'I am away' },
      { command: 'AWAY', nick: 'Anarcee', prefix: 'Anarcee!user@host', text: 'Auto-away' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('JOINPART_GROUP');
    expect(result[0].events).toHaveLength(4);
    const grouped = result[0] as any;
    // Should list all unique nicks once, not repeat
    expect(grouped.sentences).toContain('acidvegas');
    expect(grouped.sentences).toContain('frodo');
    expect(grouped.sentences).toContain('Anarcee');
    expect(grouped.sentences).toContain('are away');
  });

  it('groups AWAY back events (empty text) as is back', () => {
    const messages: IRCMessage[] = [
      { command: 'AWAY', nick: 'alice', prefix: 'alice!user@host', text: 'AFK' },
      { command: 'AWAY', nick: 'alice', prefix: 'alice!user@host', text: '' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(1);
    const grouped = result[0] as any;
    // The final state for alice is "is back"
    expect(grouped.sentences).toContain('back');
  });

  it('groups AWAY with same reason into one phrase', () => {
    const messages: IRCMessage[] = [
      { command: 'AWAY', nick: 'alice', prefix: 'alice!user@host', text: 'AFK' },
      { command: 'AWAY', nick: 'bob', prefix: 'bob!user@host', text: 'AFK' },
    ];
    const result = groupJoinPartEvents(messages);
    const grouped = result[0] as any;
    expect(grouped.sentences).toContain('alice');
    expect(grouped.sentences).toContain('bob');
    expect(grouped.sentences).toContain('are away: ');
    expect(grouped.sentences).toContain('AFK');
  });

  it('detects nipped out (join then part)', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'PART', nick: 'alice', prefix: 'alice!user@host', text: 'leaving' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as { sentences: string };
    expect(group.sentences).toContain('nipped out');
  });

  it('detects popped in (part then join)', () => {
    const messages: IRCMessage[] = [
      { command: 'PART', nick: 'alice', prefix: 'alice!user@host', text: 'leaving' },
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as { sentences: string };
    expect(group.sentences).toContain('popped in');
  });

  it('handles nick change within join/part group', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'NICK', nick: 'alice', prefix: 'alice!user@host', params: ['alice_new'] },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as { sentences: string };
    expect(group.sentences).toContain('alice');
    expect(group.sentences).toContain('alice_new');
  });

  it('handles MODE events within join/part group', () => {
    const messages: IRCMessage[] = [
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'MODE', params: ['#channel', '+o', 'alice'] },
    ];
    const result = groupJoinPartEvents(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as { sentences: string };
    expect(group.sentences).toContain('Channel mode');
  });
});

describe('groupDisconnectEvents', () => {
  it('leaves single disconnect as-is', () => {
    const messages: IRCMessage[] = [
      { command: 'DISCONNECT', text: 'Connection closed' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupDisconnectEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('DISCONNECT');
  });

  it('groups multiple consecutive disconnect events', () => {
    const messages: IRCMessage[] = [
      { command: 'DISCONNECT', text: 'Connection closed' },
      { command: 'ERROR', text: 'Connection reset' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = groupDisconnectEvents(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('DISCO_GROUP');
    expect(result[0].events).toHaveLength(2);
  });

  it('groups disconnect-like text messages', () => {
    const messages: IRCMessage[] = [
      { command: 'NOTICE', text: 'Failed to connect to server' },
      { command: 'NOTICE', text: 'Retrying...' },
    ];
    const result = groupDisconnectEvents(messages);
    // Only messages with "failed to connect" are disconnect-like
    expect(result[0].command).toBe('NOTICE');
  });

  it('counts repeated disconnect messages', () => {
    const messages: IRCMessage[] = [
      { command: 'DISCONNECT', text: 'Connection closed' },
      { command: 'DISCONNECT', text: 'Connection closed' },
    ];
    const result = groupDisconnectEvents(messages);
    expect(result).toHaveLength(1);
    const group = result[0] as { sentences: string };
    expect(group.sentences).toContain('(x2)');
  });
});

describe('preprocessMessages', () => {
  it('processes all types in pipeline', () => {
    const messages: IRCMessage[] = [
      { command: '375', text: 'MOTD start' },
      { command: '372', text: 'MOTD line' },
      { command: 'JOIN', nick: 'alice', prefix: 'alice!user@host' },
      { command: 'JOIN', nick: 'bob', prefix: 'bob!user@host' },
      { command: 'DISCONNECT', text: 'Connection closed' },
      { command: 'ERROR', text: 'Connection reset' },
      { command: 'PRIVMSG', text: 'hello' },
    ];
    const result = preprocessMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0].command).toBe('MOTD_GROUP');
    expect(result[1].command).toBe('JOINPART_GROUP');
    expect(result[2].command).toBe('DISCO_GROUP');
    expect(result[3].command).toBe('PRIVMSG');
  });

  it('returns empty array for empty input', () => {
    const result = preprocessMessages([]);
    expect(result).toHaveLength(0);
  });

  it('passes through plain chat messages untouched', () => {
    const messages: IRCMessage[] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'hello world' },
      { command: 'NOTICE', text: 'server notice' },
    ];
    const result = preprocessMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].command).toBe('PRIVMSG');
    expect(result[1].command).toBe('NOTICE');
  });
});

describe('appendToProcessed', () => {
  function privmsg(text: string, nick = 'alice'): IRCMessage {
    return { command: 'PRIVMSG', nick, text, t: text.length };
  }

  it('returns the same array when no new messages are appended', () => {
    const prev = buildProcessedBuffer([privmsg('hi')]);
    const next = appendToProcessed(prev, []);
    expect(next).toBe(prev);
  });

  it('appends PRIVMSGs to PRIVMSGs without regrouping (no group tail)', () => {
    const prev = buildProcessedBuffer([privmsg('a'), privmsg('b')]);
    const next = appendToProcessed(prev, [privmsg('c')]);
    expect(next).toHaveLength(3);
    expect(next[2].command).toBe('PRIVMSG');
    expect((next[2] as any).text).toBe('c');
  });

  it('matches the full preprocess output for a 10k PRIVMSG buffer + 100 appends', () => {
    const initial: IRCMessage[] = [];
    for (let i = 0; i < 10000; i++) initial.push(privmsg(`msg ${i}`));
    const built = buildProcessedBuffer(initial);
    // Append a small batch incrementally and confirm it matches a full
    // re-preprocess of the merged array.
    const append: IRCMessage[] = [];
    for (let i = 0; i < 100; i++) append.push(privmsg(`msg ${10000 + i}`));
    const incremental = appendToProcessed(built, append);
    const full = buildProcessedBuffer(initial.concat(append));
    expect(incremental).toHaveLength(full.length);
    for (let i = 0; i < full.length; i++) {
      expect(incremental[i].command).toBe(full[i].command);
    }
  });

  it('merges a new JOIN into a trailing JOINPART_GROUP', () => {
    const prev = buildProcessedBuffer([
      { command: 'JOIN', nick: 'alice', prefix: 'a!u@h' },
      { command: 'JOIN', nick: 'bob', prefix: 'b!u@h' },
    ]);
    // prev tail is a JOINPART_GROUP.  Appending another JOIN should
    // re-merge into the same group.
    const next = appendToProcessed(prev, [
      { command: 'JOIN', nick: 'carol', prefix: 'c!u@h' },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].command).toBe('JOINPART_GROUP');
    expect((next[0] as any).events).toHaveLength(3);
  });

  it('splits a trailing JOINPART_GROUP when a non-join event arrives', () => {
    const prev = buildProcessedBuffer([
      { command: 'JOIN', nick: 'alice', prefix: 'a!u@h' },
      { command: 'JOIN', nick: 'bob', prefix: 'b!u@h' },
    ]);
    // prev tail is a JOINPART_GROUP.  Appending a PRIVMSG should
    // re-emit the group and then add the PRIVMSG.
    const next = appendToProcessed(prev, [privmsg('hello')]);
    expect(next).toHaveLength(2);
    expect(next[0].command).toBe('JOINPART_GROUP');
    expect(next[1].command).toBe('PRIVMSG');
  });

  it('groups consecutive MOTD lines that follow another MOTD_GROUP', () => {
    const prev = buildProcessedBuffer([
      { command: '375', text: 'Start of MOTD' },
      { command: '372', text: 'Line 1' },
    ]);
    const next = appendToProcessed(prev, [
      { command: '372', text: 'Line 2' },
      { command: '372', text: 'Line 3' },
    ]);
    expect(next).toHaveLength(1);
    expect(next[0].command).toBe('MOTD_GROUP');
    expect((next[0] as any).lines).toEqual(['Start of MOTD', 'Line 1', 'Line 2', 'Line 3']);
  });

  it('appending an empty array to a large buffer is O(1)', () => {
    const initial: IRCMessage[] = [];
    for (let i = 0; i < 10000; i++) initial.push(privmsg(`m${i}`));
    const built = buildProcessedBuffer(initial);
    const t0 = performance.now();
    const next = appendToProcessed(built, []);
    const dt = performance.now() - t0;
    expect(next).toBe(built);
    // Should be essentially instant.
    expect(dt).toBeLessThan(5);
  });
});

describe('prependReprocess', () => {
  it('merges prepended messages with existing and re-preprocesses', () => {
    const existing: IRCMessage[] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'old', t: 2 },
    ];
    const prepended: IRCMessage[] = [
      { command: 'PRIVMSG', nick: 'bob', text: 'newer', t: 1 },
    ];
    const result = prependReprocess(existing, prepended);
    expect(result).toHaveLength(2);
    expect((result[0] as any).text).toBe('newer');
    expect((result[1] as any).text).toBe('old');
  });

  it('dedupes by eid across the merged array', () => {
    const existing: IRCMessage[] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'dup', t: 1, eid: 42 },
    ];
    const prepended: IRCMessage[] = [
      { command: 'PRIVMSG', nick: 'alice', text: 'dup', t: 1, eid: 42 },
    ];
    const result = prependReprocess(existing, prepended);
    expect(result).toHaveLength(1);
  });
});
