import { describe, it, expect } from 'vitest';
import {
  groupMOTDLines,
  groupJoinPartEvents,
  groupDisconnectEvents,
  preprocessMessages,
} from './messageBuilder';
import type { IRCMessage } from '../types';

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
