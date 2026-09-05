import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enqueueMessage, setFlushFn } from './messageBatcher';
import { shouldBypassBatcher } from './messageHandler';
import type { IRCMessage } from '../types';

function makeMsg(overrides: Partial<IRCMessage> = {}): IRCMessage {
  return {
    id: `id-${Math.random()}`,
    t: Date.now(),
    command: 'NOTICE',
    nick: '',
    text: '',
    ...overrides,
  };
}

describe('shouldBypassBatcher — connection log messages', () => {
  it('phase events (NOTICE-shaped, no nick) bypass the batcher', () => {
    // ✓ Phase events bypass — they're engine-emitted NOTICE without a nick
    expect(shouldBypassBatcher(makeMsg({ command: 'NOTICE', phase: 'connecting' }), '_server')).toBe(true);
  });

  it('MOTD messages (375/372/376) bypass the batcher — FIXED', () => {
    expect(shouldBypassBatcher(makeMsg({ command: '375' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '372' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '376' }), '_server')).toBe(true);
  });

  it('welcome banner messages (001-004) bypass the batcher — FIXED', () => {
    expect(shouldBypassBatcher(makeMsg({ command: '001' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '002' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '003' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '004' }), '_server')).toBe(true);
  });

  it('ISUPPORT (005) bypasses the batcher — FIXED', () => {
    expect(shouldBypassBatcher(makeMsg({ command: '005' }), '_server')).toBe(true);
  });

  it('other connection numerics bypass the batcher — FIXED', () => {
    expect(shouldBypassBatcher(makeMsg({ command: '251' }), '_server')).toBe(true);
    expect(shouldBypassBatcher(makeMsg({ command: '265' }), '_server')).toBe(true);
  });

  it('lets chat NOTICE with a nick through — _server is low-volume', () => {
    expect(shouldBypassBatcher(makeMsg({ command: 'NOTICE', nick: 'NickServ' }), '_server')).toBe(true);
  });

  it('lets PRIVMSG through — _server is low-volume', () => {
    expect(shouldBypassBatcher(makeMsg({ command: 'PRIVMSG', nick: 'alice' }), '_server')).toBe(true);
  });
});

// IRCCloud BufferLogView.checkFlush cadence (see messageBatcher.test.ts):
// the first message after ≥200 ms of quiet flushes immediately, everything
// arriving inside the next 200 ms is held and flushed on that tick. The
// batcher keeps `lastFlush` in module state, so each test starts on a fresh
// stretch of the fake clock.
describe('batcher — connection log burst patterns', () => {
  let flushes: { networkId: string; bufferName: string; msgs: IRCMessage[] }[];
  let flush: (networkId: string, bufferName: string, msgs: IRCMessage[]) => void;
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

  it('renders a 39-line MOTD burst as two batches, not 39 renders', () => {
    const msgs: IRCMessage[] = [
      makeMsg({ command: '375', text: 'MOTD start' }),
    ];
    for (let i = 0; i < 37; i++) {
      msgs.push(makeMsg({ command: '372', text: `Line ${i + 1}` }));
    }
    msgs.push(makeMsg({ command: '376', text: 'End of MOTD' }));

    for (const msg of msgs) {
      enqueueMessage('net1', '_server', msg);
    }

    // First line paints at once; the other 38 land on the 200 ms tick.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flushes[1].msgs).toHaveLength(38);
  });

  it('renders a realistic 50-msg connection log in two batches', () => {
    const phases = [
      'queued', 'resolving', 'connecting', 'tcp_open', 'tls',
      'tls_done', 'registering', 'caps', 'sasl', 'welcome',
    ];
    for (const ph of phases) {
      enqueueMessage('net1', '_server', makeMsg({ command: 'NOTICE', phase: ph, text: ph }));
    }
    enqueueMessage('net1', '_server', makeMsg({ command: 'NOTICE', text: 'Looking up hostname' }));
    enqueueMessage('net1', '_server', makeMsg({ command: 'NOTICE', text: 'Found hostname' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '001', text: 'Welcome' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '002', text: 'Your host' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '003', text: 'Created' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '004', text: 'MyInfo' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '005', text: 'CHANTYPES=#' }));
    enqueueMessage('net1', '_server', makeMsg({ command: '375', text: 'MOTD start' }));
    for (let i = 0; i < 31; i++) {
      enqueueMessage('net1', '_server', makeMsg({ command: '372', text: `Line ${i + 1}` }));
    }
    enqueueMessage('net1', '_server', makeMsg({ command: '376', text: 'MOTD end' }));

    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(2);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(50);
  });

  it('flushes each line on its own when MOTD trickles in slower than the tick', () => {
    // Real servers can dribble MOTD lines out one TCP packet at a time.
    // Anything ≥200 ms apart is its own batch — nothing is held back.
    enqueueMessage('net1', '_server', makeMsg({ command: '375', text: 'MOTD start' }));
    expect(flushes).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(200);
      enqueueMessage('net1', '_server', makeMsg({ command: '372', text: `Line ${i + 1}` }));
    }
    expect(flushes).toHaveLength(6);

    vi.advanceTimersByTime(200);
    enqueueMessage('net1', '_server', makeMsg({ command: '376', text: 'MOTD end' }));
    expect(flushes).toHaveLength(7);

    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(7);
  });
});
