import { describe, it, expect } from 'vitest';
import {
  classifyServerLog,
  groupServerLog,
  phaseToLabel,
  attemptDuration,
  formatDuration,
  numericBody,
  relativeOffset,
  isupportTokens,
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

  it('classifies 001/002/003 (RPL_WELCOME/YOURHOST/CREATED) as welcome', () => {
    expect(classifyServerLog(m({ command: '001' }))).toBe('welcome');
    expect(classifyServerLog(m({ command: '002' }))).toBe('welcome');
    expect(classifyServerLog(m({ command: '003' }))).toBe('welcome');
  });

  // 004 has no trailing at all; the row builder splits it into the
  // labelled Host / IRCd / User modes / Channel modes rows (IRCCloud's
  // server_myinfo split), so it classifies as a plain numeric.
  it('classifies RPL_MYINFO (004) as a numeric for the labelled split', () => {
    expect(classifyServerLog(m({ command: '004' }))).toBe('numeric');
  });

  // A WHOIS answer names its subject in a leading parameter, so these rows
  // rendered headless ("is logged in as", "End of /WHOIS list."). They feed
  // the WHOIS overlay instead — IRCCloud does the same via
  // `unrendered_messages`.
  it('drops the whole WHOIS / WHO family', () => {
    // 307 is RPL_WHOISREGNICK — SuperNETs ships "is keepin it 💯" there,
    // which leaked into the live log until the list covered it.
    for (const cmd of ['301', '275', '276', '307', '310', '311', '312', '313', '316', '317',
                       '318', '319', '320', '330', '335', '337', '338', '339', '352', '354',
                       '369', '378', '379', '615', '616', '617', '671', '672', '690']) {
      expect(classifyServerLog(m({ command: cmd }))).toBe('skip');
    }
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

  it('drops WHOIS/WHOX responses (311, 354, 671) to prevent SuperNets flood', () => {
    expect(classifyServerLog(m({ command: '311' }))).toBe('skip');
    expect(classifyServerLog(m({ command: '354' }))).toBe('skip');
    expect(classifyServerLog(m({ command: '671' }))).toBe('skip');
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

  it('collapses identical engine+holder phase events into a single attempt', () => {
    // Both the engine's direct-TCP path and the holder daemon emit a
    // full phase sequence for the same physical connect. Each event
    // gets a unique eid so the eid-based dedup never sees them.
    // Without the phase-text dedup we'd get two "Connected" cards
    // for what is actually one connection.
    const baseText = 'TCP connection established to irc.ircfiber.com:6697.';
    const messages = [
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tcp_open', text: baseText }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tcp_open', text: baseText }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tls', text: 'Starting TLS handshake...' }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tls', text: 'Starting TLS handshake...' }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'welcome', text: 'Connection registered as Zodiac.' }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'welcome', text: 'Connection registered as Zodiac.' }),
    ];
    const attempts = groupServerLog(messages);
    // One attempt with one of each phase (not two attempts with three
    // phases each, which is what we'd see without dedup).
    expect(attempts).toHaveLength(1);
    expect(attempts[0].phases.map((p) => p.phase)).toEqual(['tcp_open', 'tls', 'welcome']);
    expect(attempts[0].phases).toHaveLength(3);
  });

  it('keeps distinct phase events that share a timestamp but differ in text', () => {
    // The engine and the holder publish overlapping phase events with
    // different text ("TCP connection via holder..." vs "TCP connection
    // established..."). Both are real signals and should be preserved —
    // we collapse duplicates, not coincidental name overlaps.
    const messages = [
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tcp_open',
         text: 'TCP connection via holder to irc.ircfiber.com:6697' }),
      m({ t: 1782759326000, command: 'NOTICE', phase: 'tcp_open',
         text: 'TCP connection established to irc.ircfiber.com:6697.' }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].phases).toHaveLength(2);
  });

  it('dedups duplicate DISCONNECTED events from concurrent engine+holder', () => {
    // Both the engine and the holder publish a DISCONNECTED for the
    // same socket death — same timestamp, same text. Keep one.
    const messages = [
      m({ t: 1782759200000, command: 'DISCONNECTED',
         text: 'write failed: TLS stream error 40000001' }),
      m({ t: 1782759200000, command: 'DISCONNECTED',
         text: 'write failed: TLS stream error 40000001' }),
      m({ t: 1782759201000, command: 'NOTICE', phase: 'queued',
         text: 'Reconnect attempt scheduled in 14s' }),
      m({ t: 1782759201000, command: 'NOTICE', phase: 'queued',
         text: 'Reconnect attempt scheduled in 14s' }),
    ];
    const attempts = groupServerLog(messages);
    // Expect one disconnect chain + one queued attempt, not duplicates.
    const commands = attempts.flatMap((a) => a.phases.map((p) => p.command));
    expect(commands.filter((c) => c === 'DISCONNECTED')).toHaveLength(1);
    const phases = attempts.flatMap((a) => a.phases.map((p) => p.phase));
    expect(phases.filter((p) => p === 'queued')).toHaveLength(1);
  });

  it('does not dedup chat-shaped messages that share text naturally', () => {
    // A user can legitimately say "yes" twice. Without a phase tag,
    // the dedup must pass these through unchanged.
    const messages = [
      m({ command: 'PRIVMSG', nick: 'alice', text: 'yes', t: 1000 }),
      m({ command: 'PRIVMSG', nick: 'alice', text: 'yes', t: 1001 }),
    ];
    const result = groupServerLog(messages);
    // The numeric body / classification pipeline may absorb these into
    // a synthetic attempt, but they shouldn't be dropped — total event
    // count across all attempts must remain 2.
    const total = result.reduce((n, a) => n
      + a.phases.length + a.motd.length + a.welcome.length
      + a.cap.length + a.numeric.length + a.notices.length, 0);
    expect(total).toBe(2);
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

describe('reconnect supersede', () => {
  it('marks old connected card as superseded when a new reconnect starts', () => {
    // Simulate: connect → disconnect → reconnect. The dedup pass in
    // groupServerLog requires phase events to be >60s apart or have
    // different canonical text to survive dedup. We use queued vs resolving
    // as start phases (both are START_PHASES) with distinct text so the
    // second one survives the dedup window.
    let t = 1000;
    const next = (overrides: Partial<IRCMessage> = {}): IRCMessage =>
      m({ t: ++t, ...overrides });

    const events: IRCMessage[] = [
      // First connection: queued → connecting → ... → welcome
      next({ phase: 'queued', text: 'queued' }),
      next({ phase: 'connecting', text: 'Connecting to ircd:6667' }),
      next({ phase: 'tcp_open', text: 'TCP connection established' }),
      next({ phase: 'registering', text: 'Registering connection' }),
      next({ phase: 'caps', text: 'Negotiating capabilities' }),
      next({ command: 'NOTICE', nick: 'irc.ircfiber.com', text: '*** Looking up your hostname...' }),
      next({ phase: 'welcome', text: 'Welcome to the network' }),
      // DISCONNECTED
      next({ command: 'DISCONNECTED', text: 'Connection closed' }),
      // New reconnect: resolving fires (different from queued, same START set)
      next({ phase: 'resolving', text: 'resolve irc.ircfiber.com' }),
    ];

    const attempts = groupServerLog(events);
    // Should have exactly 1 visible card: the new connecting attempt
    const visible = attempts.filter(a => a.status !== 'superseded');
    expect(visible).toHaveLength(1);
    expect(visible[0].status).toBe('pending');
    expect(visible[0].phases[0].phase).toBe('resolving');
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
describe('isupportTokens', () => {
  it('takes the tokens between nick and the trailing boilerplate from params', () => {
    const msg = m({ command: '005', text: '', params: ['nick', 'CHANTYPES=#', 'NICKLEN=30', 'SAFELIST', ':are supported by this server'] });
    expect(isupportTokens(msg)).toEqual(['CHANTYPES=#', 'NICKLEN=30', 'SAFELIST']);
  });
  it('strips the boilerplate from a flattened text body', () => {
    const msg = m({ command: '005', text: 'CHANTYPES=# PREFIX=(ov)@+ are supported by this server' });
    expect(isupportTokens(msg)).toEqual(['CHANTYPES=#', 'PREFIX=(ov)@+']);
  });
});
describe('live connection flow (2026-09-02)', () => {
  it('a bare `connecting` after a completed connect opens a new card (engine restart, no DISCONNECTED)', () => {
    const messages = [
      m({ phase: 'connecting', text: 'first connect', t: 1000 }),
      m({ phase: 'tcp_open', text: 'tcp', t: 1100 }),
      m({ phase: 'welcome', text: 'first welcome', t: 1500 }),
      m({ command: '372', text: 'motd', t: 1600 }),
      // Engine restarted: no DISCONNECTED was ever published for the old socket.
      m({ phase: 'connecting', text: 'second connect', t: 5000 }),
      m({ phase: 'dns', text: 'Resolved host → 1 address', t: 5010 }),
      m({ phase: 'attempt', text: 'Trying 1.2.3.4:6697 via direct', t: 5011 }),
      m({ phase: 'tcp_open', text: 'tcp again', t: 5100 }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('success');
    expect(attempts[0].phases.map((p) => p.phase)).toEqual(['connecting', 'tcp_open', 'welcome']);
    expect(attempts[1].status).toBe('pending');
    expect(attempts[1].phases.map((p) => p.phase)).toEqual(['connecting', 'dns', 'attempt', 'tcp_open']);
  });

  it('`queued` → `connecting` stays one card; per-address failures do not end the attempt', () => {
    const messages = [
      m({ phase: 'queued', text: 'Reconnect attempt scheduled in 5s', t: 1000 }),
      m({ phase: 'connecting', text: 'Connecting to host', t: 6000 }),
      m({ phase: 'dns', text: 'Resolved', t: 6010 }),
      m({ phase: 'attempt', text: 'Trying a', t: 6011 }),
      m({ phase: 'attempt_fail', text: 'a: timed out after 10s', t: 16011 }),
      m({ phase: 'attempt', text: 'Trying b', t: 16012 }),
    ];
    const attempts = groupServerLog(messages);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('pending');
    expect(attempts[0].phases).toHaveLength(6);
  });

  it('relativeOffset renders ms / s / m offsets from the attempt start', () => {
    expect(relativeOffset(1000, 1000)).toBe('+0ms');
    expect(relativeOffset(1000, 1014)).toBe('+14ms');
    expect(relativeOffset(1000, 3450)).toBe('+2.45s');
    expect(relativeOffset(1000, 1000 + 125_000)).toBe('+2m05s');
    expect(relativeOffset(undefined, 5)).toBe('');
  });

  it('phaseToLabel knows the connect-progress phases', () => {
    expect(phaseToLabel('dns')).toBe('dns');
    expect(phaseToLabel('attempt')).toBe('try');
    expect(phaseToLabel('attempt_fail')).toBe('fail');
  });
});
