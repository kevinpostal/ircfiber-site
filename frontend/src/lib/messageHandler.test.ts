import { describe, it, expect, beforeEach } from 'vitest';
import { untrack } from 'svelte';
import { shouldBypassBatcher, unpackEvent, processIrcEvent } from './messageHandler';
import type { IRCMessage } from '../types';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer, createMessage } from '../test/factories';

function makeMsg(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    id: 'id-1',
    t: 1000,
    command: 'PRIVMSG',
    nick: 'alice',
    text: 'hello',
    ...overrides,
  };
}

describe('shouldBypassBatcher', () => {
  it('returns true for server-log NOTICE (no nick, in _server)', () => {
    const msg = makeMsg({
      command: 'NOTICE',
      nick: '',
      text: 'Connecting to irc.example.org:6697...',
      phase: 'connecting',
    });
    expect(shouldBypassBatcher(msg, '_server')).toBe(true);
  });

  it('returns true for chat NOTICE (with nick, in _server)', () => {
    // The _server buffer is low-volume by nature. Service notices (NickServ,
    // ChanServ) should render immediately, not wait for the batcher.
    const msg = makeMsg({
      command: 'NOTICE',
      nick: 'NickServ',
      text: 'Password accepted',
    });
    expect(shouldBypassBatcher(msg, '_server')).toBe(true);
  });

  it('returns false for server-log NOTICE in any other buffer', () => {
    // Only the _server buffer bypasses the batcher. Channel buffers use
    // the normal batched path for chat coalescing.
    const msg = makeMsg({
      command: 'NOTICE',
      nick: '',
      text: 'foo',
    });
    expect(shouldBypassBatcher(msg, '#general')).toBe(false);
  });

  it('returns true for PRIVMSG in _server — everything in _server bypasses', () => {
    const msg = makeMsg({ command: 'PRIVMSG', text: 'hello' });
    expect(shouldBypassBatcher(msg, '_server')).toBe(true);
  });

  it('returns true for any command in _server', () => {
    expect(shouldBypassBatcher(makeMsg({ command: 'CONNECT', nick: '' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: 'DISCONNECT', nick: '' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: 'CONNECTED', nick: '' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: 'DISCONNECTED', nick: '' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: 'JOIN', nick: '' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: 'PART', nick: '' }), '_server')).toBe(true);
  });
});

describe('unpackEvent — phase tag extraction', () => {
  it('extracts phase from data.phase (compact wire format)', () => {
    const evt = unpackEvent(
      { c: 'NOTICE', x: 'TLS handshake complete', network: 'libera', phase: 'tls_done' },
      { value: 0 },
    );
    expect(evt.phase).toBe('tls_done');
  });

  it('extracts phase from data.tags.phase (long-form / replay)', () => {
    const evt = unpackEvent(
      {
        command: 'NOTICE',
        text: 'Connection registered',
        network: 'libera',
        tags: { phase: 'welcome' },
      },
      { value: 0 },
    );
    expect(evt.phase).toBe('welcome');
  });

  it('prefers data.phase over data.tags.phase when both are present', () => {
    const evt = unpackEvent(
      {
        c: 'NOTICE',
        x: 'msg',
        phase: 'tcp_open',
        tags: { phase: 'should-be-ignored' },
      },
      { value: 0 },
    );
    expect(evt.phase).toBe('tcp_open');
  });

  it('returns undefined when no phase is present', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'hello', network: 'libera' },
      { value: 0 },
    );
    expect(evt.phase).toBeUndefined();
  });
});

describe('unpackEvent — account-tag and remote-edit fields', () => {
  it('maps data.a to account (compact wire format)', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'hello', network: 'libera', a: 'alice123' },
      { value: 0 },
    );
    expect(evt.account).toBe('alice123');
  });

  it('falls back to data.tags.account (long-form / replay)', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'hello', network: 'libera', tags: { account: 'alice123' } },
      { value: 0 },
    );
    expect(evt.account).toBe('alice123');
  });

  it('leaves account undefined when no tag is present', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'hello', network: 'libera' },
      { value: 0 },
    );
    expect(evt.account).toBeUndefined();
  });

  it('maps data.eo to editOf (remote draft/edit-message)', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'fixed', network: 'libera', l: 'lbl-1', eo: 'lbl-1' },
      { value: 0 },
    );
    expect(evt.label).toBe('lbl-1');
    expect(evt.editOf).toBe('lbl-1');
  });

  it('leaves editOf undefined for ordinary messages', () => {
    const evt = unpackEvent(
      { c: 'PRIVMSG', n: 'alice', x: 'hello', network: 'libera' },
      { value: 0 },
    );
    expect(evt.editOf).toBeUndefined();
  });
});

describe('query case convergence (nickserv vs NickServ)', () => {
  beforeEach(() => {
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    ircState.messages = {};
  });

  function runIncoming(data: Record<string, unknown>) {
    const appended: Array<{ networkId: string; bufferName: string; msg: IRCMessage }> = [];
    processIrcEvent(
      data,
      { value: 0 },
      { whoisAcc: null, whoisAccs: new Map(), banAcc: [], banTargetChannel: '' },
      { switchToBuffer: () => {} },
      (networkId, bufferName, msg) => {
        appended.push({ networkId, bufferName, msg });
      },
    );
    return appended;
  }

  it('routes a server-case reply into the typed buffer and adopts its case', () => {
    // The reported bug: `/msg nickserv` opens `nickserv`, the reply from
    // `NickServ` opens a second conversation. Expect one buffer, renamed
    // to the server case, with the reply filed under the folded key.
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: 'nickserv', type: 'query', isJoined: true }));
    ircState.networks.push(net);
    ircState.messages['n1:nickserv'] = [createMessage({ nick: 'me', text: 'identify hunter2', t: 1000 })];
    ircState.activeBuffer.networkId = 'n1';
    ircState.activeBuffer.bufferName = 'nickserv';

    const appended = runIncoming({
      command: 'PRIVMSG', nick: 'NickServ', text: 'Password accepted',
      channel: 'NickServ', nid: 'n1', t: 2000,
    });

    const queries = net.buffers.filter((b) => b.type === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].name).toBe('NickServ');
    expect(appended).toHaveLength(1);
    expect(appended[0].bufferName).toBe('nickserv');
    expect(untrack(() => ircState.activeBuffer.bufferName)).toBe('NickServ');
  });

  it('does not rename the buffer on our own echo', () => {
    // Echoes carry the typed target, not the server case — adopting them
    // would rename away from the authoritative case on every send.
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: 'NickServ', type: 'query', isJoined: true }));
    ircState.networks.push(net);

    runIncoming({
      command: 'PRIVMSG', nick: 'me', text: 'identify hunter2',
      channel: 'nickserv', nid: 'n1', t: 2000, se: '1',
    });

    const queries = net.buffers.filter((b) => b.type === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].name).toBe('NickServ');
  });

  it('renames the query when the counterparty changes nick (bob -> robert)', () => {
    // IRCCloud rename model end to end: the NICK event carries old in
    // `nick` and new in params — one buffer, history preserved, no twin.
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: 'bob', type: 'query', isJoined: true }));
    ircState.networks.push(net);
    ircState.messages['n1:bob'] = [createMessage({ nick: 'bob', text: 'hey', t: 1000 })];
    ircState.activeBuffer.networkId = 'n1';
    ircState.activeBuffer.bufferName = 'bob';

    runIncoming({ command: 'NICK', nick: 'bob', params: ['robert'], nid: 'n1', t: 2000 });

    const queries = net.buffers.filter((b) => b.type === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].name).toBe('robert');
    expect(ircState.messages['n1:robert']).toHaveLength(1);
    expect(ircState.messages['n1:bob']).toBeUndefined();
    expect(untrack(() => ircState.activeBuffer.bufferName)).toBe('robert');
  });

  it('ignores our own NICK (you_nickchange owns self)', () => {
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: 'alice', type: 'query', isJoined: true }));
    ircState.networks.push(net);

    runIncoming({ command: 'NICK', nick: 'me', params: ['me2'], nid: 'n1', t: 2000 });

    expect(net.buffers.map((b) => b.name)).toEqual(['alice']);
  });

  it('a duplicate NICK (per-channel re-broadcast) is a no-op', () => {
    const net = createNetwork({ networkId: 'n1', currentNick: 'me' });
    net.buffers.push(createBuffer({ name: 'bob', type: 'query', isJoined: true }));
    ircState.networks.push(net);

    const evt = { command: 'NICK', nick: 'bob', params: ['robert'], nid: 'n1', t: 2000 };
    runIncoming(evt);
    runIncoming({ ...evt, channel: '#shared' });

    const queries = net.buffers.filter((b) => b.type === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0].name).toBe('robert');
  });
});
