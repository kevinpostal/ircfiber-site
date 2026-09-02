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

// IRCCloud BufferLogView.checkFlush: the first message after ≥200 ms of
// quiet flushes immediately; anything arriving inside the next 200 ms is
// held and flushed together on the 200 ms tick. The batcher is module
// state, so every test starts by letting the previous cadence expire.
describe('messageBatcher — IRCCloud checkFlush cadence', () => {
  let flushes: { networkId: string; bufferName: string; msgs: IRCMessage[] }[];
  let flush: (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;
  // Monotonic fake clock across tests: `lastFlush` is module state, so each
  // test starts well past the previous test's last flush.
  let clock = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    clock += 60_000;
    vi.setSystemTime(clock);
    flushes = [];
    flush = vi.fn((networkId: string, bufferName: string, msgs: IRCMessage[]) => {
      flushes.push({ networkId, bufferName, msgs });
    });
    setFlushFn(flush);
  });

  afterEach(() => {
    vi.advanceTimersByTime(1000);
    clock += 1000;
    vi.useRealTimers();
  });

  it('flushes the first message of a quiet buffer immediately', () => {
    enqueueMessage('net1', '#chan', makeMsg('hello', 1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs).toHaveLength(1);
  });

  it('holds a burst arriving within 200 ms and flushes it on the next tick', () => {
    enqueueMessage('net1', '#chan', makeMsg('m0', 0));
    expect(flush).toHaveBeenCalledTimes(1);
    for (let i = 1; i < 50; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
    }
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(199);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flushes[1].msgs).toHaveLength(49);
  });

  it('a steady stream renders in ≤5 batches per second', () => {
    // One message every 10 ms for one second → 1 immediate + 5 ticks.
    for (let i = 0; i < 100; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
      vi.advanceTimersByTime(10);
    }
    // Drain the trailing tick.
    vi.advanceTimersByTime(200);
    expect(flush.mock.calls.length).toBeLessThanOrEqual(7);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(100);
  });

  it('a message after ≥200 ms of quiet flushes immediately again', () => {
    enqueueMessage('net1', '#chan', makeMsg('m1', 1));
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    enqueueMessage('net1', '#chan', makeMsg('m2', 2));
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flushes[1].msgs.map((m) => m.text)).toEqual(['m2']);
  });

  it('1000 messages in one tick: cap flushes of 200 plus the tick flush', () => {
    for (let i = 0; i < 1000; i++) {
      enqueueMessage('net1', '#chan', makeMsg(`m${i}`, i));
    }
    // 1 immediate, then the cap fires at every 200 queued.
    vi.advanceTimersByTime(200);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(1000);
    expect(flush.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('groups messages per buffer — one flushFn call per affected buffer per flush', () => {
    enqueueMessage('net1', '#chanA', makeMsg('a0', 0));
    for (let i = 1; i < 5; i++) {
      enqueueMessage('net1', '#chanA', makeMsg(`a${i}`, i));
      enqueueMessage('net1', '#chanB', makeMsg(`b${i}`, i));
    }
    vi.advanceTimersByTime(200);
    const byBuffer = new Map<string, number>();
    for (const f of flushes) byBuffer.set(f.bufferName, (byBuffer.get(f.bufferName) ?? 0) + f.msgs.length);
    expect(byBuffer.get('#chanA')).toBe(5);
    expect(byBuffer.get('#chanB')).toBe(4);
  });
});
