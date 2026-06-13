import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTyping, clearTyping, getTypersForBuffer, ircState } from './ircStore.svelte';

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
