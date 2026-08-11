import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTyping, clearTyping, getTypersForBuffer, ircState } from './ircStore.svelte';
import { processIrcEvent } from '../lib/messageHandler';

describe('typing state management', () => {
  beforeEach(() => {
    // Reset typing state
    ircState.typing = {};
  });

  it('setTyping records a nick with a timestamp', () => {
    setTyping('net1', '#chan', 'Alice');
    const key = 'net1:#chan';
    expect(ircState.typing[key]).toBeDefined();
    expect(ircState.typing[key]['Alice']).toBeGreaterThan(0);
  });

  it('getTypersForBuffer returns typing nicks', () => {
    setTyping('net1', '#chan', 'Alice');
    const typers = getTypersForBuffer('net1', '#chan');
    expect(typers).toEqual(['Alice']);
  });

  it('returns multiple typing nicks grouped together', () => {
    setTyping('net1', '#chan', 'Alice');
    setTyping('net1', '#chan', 'Bob');
    setTyping('net1', '#chan', 'Charlie');
    const typers = getTypersForBuffer('net1', '#chan');
    expect(typers).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('clearTyping removes a nick', () => {
    setTyping('net1', '#chan', 'Alice');
    setTyping('net1', '#chan', 'Bob');
    clearTyping('net1', '#chan', 'Alice');
    const typers = getTypersForBuffer('net1', '#chan');
    expect(typers).toEqual(['Bob']);
  });

  it('clearTyping on non-typing nick does nothing', () => {
    setTyping('net1', '#chan', 'Alice');
    clearTyping('net1', '#chan', 'NonExistent');
    const typers = getTypersForBuffer('net1', '#chan');
    expect(typers).toEqual(['Alice']);
  });

  it('excludes stale nicks older than 6.5s', () => {
    const now = Date.now();
    setTyping('net1', '#chan', 'Alice');
    // Manually set Bob's timestamp to 7s ago
    const key = 'net1:#chan';
    ircState.typing[key]['Bob'] = now - 7000;
    const typers = getTypersForBuffer('net1', '#chan');
    expect(typers).toEqual(['Alice']);
  });

  it('is scoped to buffer — different buffers have separate state', () => {
    setTyping('net1', '#chan', 'Alice');
    setTyping('net1', '#other', 'Bob');
    expect(getTypersForBuffer('net1', '#chan')).toEqual(['Alice']);
    expect(getTypersForBuffer('net1', '#other')).toEqual(['Bob']);
  });

  it('is scoped to network — same channel different network', () => {
    setTyping('net1', '#chan', 'Alice');
    setTyping('net2', '#chan', 'Bob');
    expect(getTypersForBuffer('net1', '#chan')).toEqual(['Alice']);
    expect(getTypersForBuffer('net2', '#chan')).toEqual(['Bob']);
  });
});

describe('TAGMSG → setTyping integration', () => {
  it('setTyping is scoped by normalized channel key', () => {
    setTyping('net1', '#scroll', 'Alice');
    setTyping('net1', '#superbowl', 'Bob');

    const scrollTypers = getTypersForBuffer('net1', '#scroll');
    const superbowlTypers = getTypersForBuffer('net1', '#superbowl');

    expect(scrollTypers).toEqual(['Alice']);
    expect(superbowlTypers).toEqual(['Bob']);
    expect(scrollTypers).not.toContain('Bob');
  });

  it('normalized channel names resolve to same key', () => {
    setTyping('net1', '#Chan', 'Alice');
    setTyping('net1', '#chan', 'Bob'); // same buffer, different casing
    const typers = getTypersForBuffer('net1', '#Chan');
    // Both Alie and Bob are in the same buffer
    expect(typers).toContain('Alice');
    expect(typers).toContain('Bob');
  });
});

describe('TAGMSG → processIrcEvent dispatch (active vs done)', () => {
  function tagmsg(payload: Record<string, unknown>): void {
    processIrcEvent(
      { network: 'net1', nid: 'net1', c: 'TAGMSG', ch: '#chan', n: 'Alice', ...payload },
      { value: 0 },
      {} as never,
      { switchToBuffer: () => {} },
    );
  }

  beforeEach(() => {
    ircState.typing = {};
    ircState.networks.length = 0;
    ircState.networks.push({ networkId: 'net1', name: 'Net One', buffers: [] } as never);
  });

  it('TAGMSG with typing=active sets the nick', () => {
    tagmsg({ typing: 'active' });
    expect(getTypersForBuffer('net1', '#chan')).toEqual(['Alice']);
  });

  it('TAGMSG with typing=done clears the nick immediately', () => {
    // Regression: every TAGMSG used to call setTyping, so a `done`
    // refreshed the 6.5s heartbeat instead of clearing it — the
    // indicator stayed up long after the other client stopped typing.
    setTyping('net1', '#chan', 'Alice');
    tagmsg({ typing: 'done' });
    expect(getTypersForBuffer('net1', '#chan')).toEqual([]);
  });

  it('TAGMSG done via long-form data.tags[+typing] also clears', () => {
    setTyping('net1', '#chan', 'Alice');
    tagmsg({ tags: { '+typing': 'done' } });
    expect(getTypersForBuffer('net1', '#chan')).toEqual([]);
  });

  it('TAGMSG without a typing tag falls back to setTyping (back-compat)', () => {
    // Pre-engine-change TAGMSG payloads carry no typing field; keep the
    // old behavior (treat as active) so older engine builds still work.
    tagmsg({});
    expect(getTypersForBuffer('net1', '#chan')).toEqual(['Alice']);
  });
});
