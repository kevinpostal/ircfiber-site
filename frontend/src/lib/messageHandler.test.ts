import { describe, it, expect } from 'vitest';
import { shouldBypassBatcher, unpackEvent } from './messageHandler';
import type { IRCMessage } from '../types';

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
