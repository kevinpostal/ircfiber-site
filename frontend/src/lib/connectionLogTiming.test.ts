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

describe('batcher — connection log burst patterns', () => {
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

  it('batches a full MOTD burst (40 messages) in a single tick into one flush', () => {
    // When all MOTD lines arrive in the same tick (same WS frame), they
    // coalesce into one batch — fast path.
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

    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flushes[0].msgs).toHaveLength(39);
  });

  it('flushes a realistic 50-msg connection log as a single batch when all arrive in one tick', () => {
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

    vi.advanceTimersByTime(0);
    expect(flush).toHaveBeenCalledTimes(1);
    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(50);
  });

  it('flushes each tick as its own batch when MOTD messages arrive in separate ticks — THE SLOW PATH', () => {
    // This simulates the real IRC server behavior: MOTD lines arrive as
    // individual TCP packets → individual WS frames → each one is its
    // own batcher flush → visible "line by line" trickle in the DOM.
    enqueueMessage('net1', '_server', makeMsg({ command: '375', text: 'MOTD start' }));
    vi.advanceTimersByTime(0);
    expect(flushes).toHaveLength(1);

    for (let i = 0; i < 5; i++) {
      enqueueMessage('net1', '_server', makeMsg({ command: '372', text: `Line ${i + 1}` }));
      vi.advanceTimersByTime(0);
    }
    expect(flushes).toHaveLength(6);

    enqueueMessage('net1', '_server', makeMsg({ command: '376', text: 'MOTD end' }));
    vi.advanceTimersByTime(0);
    expect(flushes).toHaveLength(7);

    const total = flushes.reduce((sum, f) => sum + f.msgs.length, 0);
    expect(total).toBe(7);
  });
});
