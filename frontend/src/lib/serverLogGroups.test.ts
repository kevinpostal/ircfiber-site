import { describe, it, expect } from 'vitest';
import {
  classifyServerLog,
  groupServerLog,
  phaseToLabel,
  attemptDuration,
  formatDuration,
  numericBody,
} from './serverLogGroups';
import type { IRCMessage } from '../types';

let counter = 0;
function m(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    id: `m-${++counter}`,
    command: 'NOTICE',
    nick: '',
    text: 'msg',
    t: 1000 + counter,
    ...overrides,
  };
}

describe('classifyServerLog', () => {
  it('classifies engine phase events as phase', () => {
    expect(classifyServerLog(m({ phase: 'connecting' }))).toBe('phase');
    expect(classifyServerLog(m({ phase: 'welcome' }))).toBe('phase');
    expect(classifyServerLog(m({ phase: 'tls_done' }))).toBe('phase');
  });

  it('classifies 372/375/376 numerics as MOTD', () => {
    expect(classifyServerLog(m({ command: '375' }))).toBe('motd');
    expect(classifyServerLog(m({ command: '372' }))).toBe('motd');
    expect(classifyServerLog(m({ command: '376' }))).toBe('motd');
  });

  it('classifies 005 (RPL_ISUPPORT) as cap', () => {
    expect(classifyServerLog(m({ command: '005' }))).toBe('cap');
  });

  it('classifies 001/002/003/004 (RPL_WELCOME/YOURHOST/CREATED/MYINFO) as welcome', () => {
    expect(classifyServerLog(m({ command: '001' }))).toBe('welcome');
    expect(classifyServerLog(m({ command: '002' }))).toBe('welcome');
    expect(classifyServerLog(m({ command: '003' }))).toBe('welcome');
    expect(classifyServerLog(m({ command: '004' }))).toBe('welcome');
  });

  it('classifies raw NOTICEs (no phase) as notice', () => {
    expect(classifyServerLog(m({ command: 'NOTICE', nick: 'irc.ircfiber.com' }))).toBe('notice');
  });

  it('classifies synthetic CONNECT/DISCONNECT as lifecycle', () => {
    expect(classifyServerLog(m({ command: 'CONNECT' }))).toBe('lifecycle');
    expect(classifyServerLog(m({ command: 'DISCONNECT' }))).toBe('lifecycle');
    expect(classifyServerLog(m({ command: 'CONNECTED' }))).toBe('lifecycle');
    expect(classifyServerLog(m({ command: 'DISCONNECTED' }))).toBe('lifecycle');
  });

  it('drops PING/PONG/ERROR', () => {
    expect(classifyServerLog(m({ command: 'PING' }))).toBe('skip');
    expect(classifyServerLog(m({ command: 'PONG' }))).toBe('skip');
    expect(classifyServerLog(m({ command: 'ERROR' }))).toBe('skip');
  });

  it('falls back to notice for unknown commands', () => {
    expect(classifyServerLog(m({ command: 'SOMETHING' }))).toBe('notice');
  });
});

describe('groupServerLog', () => {
  it('returns empty array for empty input', () => {
    expect(groupServerLog([])).toEqual([]);
  });

  it('groups a full attempt from connecting through welcome', () => {
    const messages = [
      m({ phase: 'connecting', text: 'Connecting to irc.example.org:6697...' }),
      m({ phase: 'tcp_open', text: 'TCP connection established' }),
      m({ phase: 'tls', text: 'TLS handshake in progress' }),
      m({ phase: 'tls_done', text: 'TLS handshake complete' }),
      m({ phase: 'registering', text: 'Sending NICK/USER' }),
      m({ phase: 'caps', text: 'Capability negotiation' }),
      m({ phase: 'sasl', text: 'SASL authentication' }),
      m({ phase: 'welcome', text: 'Connection registered as Bob' }),
      m({ command: '375', text: ':- example.org Message of the Day -' }),
      m({ command: '372', text: ':- Welcome to the network' }),
      m({ command: '376', text: ':End of MOTD command' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    const a = attempts[0];
    expect(a.status).toBe('success');
    expect(a.phases).toHaveLength(8);
    expect(a.motd).toHaveLength(3);
    expect(a.cap).toHaveLength(0);
    expect(a.notices).toHaveLength(0);
    expect(a.end).not.toBeNull();
  });

  it('splits two attempts at DISCONNECT', () => {
    const messages = [
      m({ phase: 'connecting', text: 'first connect' }),
      m({ phase: 'welcome', text: 'first welcome' }),
      m({ command: 'DISCONNECT', text: 'connection lost' }),
      m({ phase: 'connecting', text: 'reconnecting' }),
      m({ phase: 'welcome', text: 'second welcome' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(2);
    // First attempt reached welcome, then was disconnected — status flips
    // to disconnected because the attempt terminated abnormally even
    // though the connection succeeded at one point.
    expect(attempts[0].status).toBe('disconnected');
    expect(attempts[1].status).toBe('success');
    expect(attempts[0].phases.map((p) => p.text)).toEqual(['first connect', 'first welcome', 'connection lost']);
    expect(attempts[1].phases.map((p) => p.text)).toEqual(['reconnecting', 'second welcome']);
  });

  it('marks attempt as error when phase=error appears', () => {
    const messages = [
      m({ phase: 'connecting', text: 'connecting' }),
      m({ phase: 'error', text: 'TLS handshake failed: certificate verify' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('error');
    expect(attempts[0].end).not.toBeNull();
  });

  it('marks attempt as disconnected on DISCONNECT mid-flight', () => {
    const messages = [
      m({ phase: 'connecting', text: 'connecting' }),
      m({ command: 'DISCONNECT', text: 'you disconnected' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('disconnected');
  });

  it('leaves an in-flight attempt with status=pending', () => {
    const messages = [
      m({ phase: 'connecting', text: 'connecting' }),
      m({ phase: 'tcp_open', text: 'tcp open' }),
      m({ phase: 'tls', text: 'tls in progress' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('pending');
    expect(attempts[0].end).toBeNull();
  });

  it('buckets MOTD numerics into the motd array', () => {
    const messages = [
      m({ phase: 'welcome', text: 'welcome' }),
      m({ command: '375', text: 'MOTD start' }),
      m({ command: '372', text: 'line 1' }),
      m({ command: '372', text: 'line 2' }),
      m({ command: '376', text: 'end of motd' }),
    ];
    const a = groupServerLog(messages)[0];
    expect(a.motd).toHaveLength(4); // 375 + 372×2 + 376
  });

  it('buckets RPL_ISUPPORT into the cap array', () => {
    const messages = [
      m({ phase: 'caps', text: 'caps' }),
      m({ phase: 'welcome', text: 'welcome' }),
      m({ command: '005', text: 'CHANTYPES=# EXCEPTS INVEX CHANMODES' }),
    ];
    const a = groupServerLog(messages)[0];
    expect(a.cap).toHaveLength(1);
    expect(a.cap[0].text).toContain('CHANTYPES');
  });

  it('buckets raw server NOTICEs (hostname-as-nick) into notices', () => {
    const messages = [
      m({ phase: 'connecting', text: 'connecting' }),
      m({ command: 'NOTICE', nick: 'irc.example.org', text: '*** Looking up your hostname...' }),
      m({ command: 'NOTICE', nick: 'irc.example.org', text: '*** Found your hostname' }),
      m({ phase: 'welcome', text: 'welcome' }),
    ];
    const a = groupServerLog(messages)[0];
    expect(a.notices).toHaveLength(2);
    expect(a.notices[0].nick).toBe('irc.example.org');
  });

  it('drops PING/PONG entirely', () => {
    const messages = [
      m({ phase: 'connecting' }),
      m({ command: 'PING', text: ':server' }),
      m({ command: 'PONG', text: ':server' }),
      m({ phase: 'welcome' }),
    ];
    const a = groupServerLog(messages)[0];
    expect(a.phases).toHaveLength(2);
  });

  it('absorbs pre-attempt chatter into the first real attempt, discarding the synthetic one', () => {
    const messages = [
      m({ command: 'NOTICE', nick: 'irc.example.org', text: 'pre-connection notice' }),
      m({ phase: 'connecting' }),
      m({ phase: 'welcome' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    // Pre-attempt notice ended up in the real attempt's notices bucket
    expect(attempts[0].notices).toHaveLength(1);
    expect(attempts[0].status).toBe('success');
    expect(attempts[0].phases.map(p => p.phase)).toEqual(['connecting', 'welcome']);
  });

  it('uses synthetic CONNECT to start an attempt when no phase tags are present', () => {
    const messages = [
      m({ command: 'CONNECT', text: 'Connected to irc.example.org' }),
      m({ command: 'DISCONNECT', text: 'You disconnected' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].phases.map((p) => p.command)).toEqual(['CONNECT', 'DISCONNECT']);
    expect(attempts[0].status).toBe('disconnected');
  });
});

describe('phaseToLabel', () => {
  it('returns short labels for engine phases', () => {
    expect(phaseToLabel('queued')).toBe('queued');
    expect(phaseToLabel('resolving')).toBe('dns');
    expect(phaseToLabel('connecting')).toBe('connect');
    expect(phaseToLabel('tcp_open')).toBe('tcp');
    expect(phaseToLabel('tls')).toBe('tls');
    expect(phaseToLabel('tls_done')).toBe('tls ✓');
    expect(phaseToLabel('registering')).toBe('register');
    expect(phaseToLabel('caps')).toBe('caps');
    expect(phaseToLabel('sasl')).toBe('sasl');
    expect(phaseToLabel('welcome')).toBe('ready');
    expect(phaseToLabel('info')).toBe('info');
    expect(phaseToLabel('warn')).toBe('warn');
    expect(phaseToLabel('error')).toBe('error');
  });

  it('returns the raw phase name for unknown phases', () => {
    expect(phaseToLabel('mystery')).toBe('mystery');
  });
});

describe('attemptDuration', () => {
  it('returns the duration from start to end in ms', () => {
    const messages = [
      m({ phase: 'connecting', t: 1000 }),
      m({ phase: 'tls', t: 1200 }),
      m({ phase: 'welcome', t: 1450 }),
    ];
    const a = groupServerLog(messages)[0];
    expect(attemptDuration(a)).toBe(450);
  });

  it('returns the duration from start to last event when still pending', () => {
    const messages = [
      m({ phase: 'connecting', t: 2000 }),
      m({ phase: 'tcp_open', t: 2050 }),
    ];
    const a = groupServerLog(messages)[0];
    expect(attemptDuration(a)).toBe(50);
  });

  it('returns null when there is no usable timestamp', () => {
    const a = groupServerLog([m({ phase: 'connecting' })])[0];
    a.start.t = undefined;
    expect(attemptDuration(a)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('renders sub-second durations in ms', () => {
    expect(formatDuration(250)).toBe('250ms');
  });
  it('renders sub-minute durations in seconds with one decimal', () => {
    expect(formatDuration(1234)).toBe('1.2s');
  });
  it('renders minute+ durations as XmSS', () => {
    expect(formatDuration(75_000)).toBe('1m15s');
  });
});

describe('numericBody', () => {
  it('prefers msg.text', () => {
    expect(numericBody(m({ command: '005', text: 'CAPS HERE' }))).toBe('CAPS HERE');
  });
  it('falls back to the last param when text is missing', () => {
    expect(numericBody(m({ command: '005', text: '', params: ['nick', ':CAPS HERE'] }))).toBe('CAPS HERE');
  });
  it('falls back to joining all params when no colon-prefixed tail', () => {
    expect(numericBody(m({ command: '005', text: '', params: ['nick', 'token1', 'token2'] }))).toBe('nick token1 token2');
  });
});