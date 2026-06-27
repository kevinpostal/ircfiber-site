import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enqueueMessage, setFlushFn } from './messageBatcher';
import type { IRCMessage } from '../types';

function makeMsg(text: string, t: number): IRCMessage {
  return {
    id: `id-${t}`,
    t,
    command: 'PRIVMSG',
    nick: 'alice',
    text,
  } as IRCMessage;
}

describe('messageBatcher — fastest-possible flush', () => {
  let flushes: { networkId: string; bufferName: string; msgs: IRCMessage[] }[];
  let flush: (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    flushes = [];
    flush = vi.fn((networkId: string, bufferName: string, msgs: IRCMessage[]) => {
      flushes.push({ networkId, bufferName, msgs });
    });
    setFlushFn(flush);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes a single message on the next macrotask (0ms debounce)', () => {
    enqueueMessage('net1', '#chan', makeMsg('hello', 1));
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs).toHaveLength(1);
  });

  it('batches a burst of messages arriving in the same tick into one flush', () => {
    for (let i = 0; i < 50; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
    }
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs).toHaveLength(50);
  });

  it('each new tick gets its own batch (no extension on burst)', () => {
    // With 0ms debounce, each message arriving in a new tick is its own
    // batch. The timer doesn't extend — M2's arrival doesn't push M1's
    // deadline forward.
    enqueueMessage('net1', '#chan', makeMsg('m1', 1));
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs.map((m) => m.text)).toEqual(['m1']);

    enqueueMessage('net1', '#chan', makeMsg('m2', 2));
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flushes[1].msgs.map((m) => m.text)).toEqual(['m2']);
  });

  it('1000 messages arriving in a single tick render in 5 cap-flushes of 200', () => {
    for (let i = 0; i < 1000; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
    }
    // The cap fires at the 200th message, then again at 400, 600, 800, 1000.
    // All 1000 should be flushed in synchronous cap-triggers.
    expect(flush).toHaveBeenCalledTimes(5);
    const totalFlushed = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(totalFlushed).toBe(1000);
  });

  it('groups messages per buffer — one flushFn call per affected buffer', () => {
    for (let i = 0; i < 5; i++) {
      enqueueMessage('net1', '#chanA', makeMsg(`a${i}`, i));
      enqueueMessage('net1', '#chanB', makeMsg(`b${i}`, i));
    }
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(2);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(10);
  });

  it('O(1) cap check: 500 messages flush via cap (200, 400) + trailing 100 on timer', () => {
    for (let i = 0; i < 500; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
    }
    // First 200 flush via cap, next 200 flush via cap, last 100 wait for timer.
    expect(flush).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(3);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(500);
  });
});
