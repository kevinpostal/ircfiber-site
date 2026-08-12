import { describe, expect, it } from 'vitest';
import { isFiberServer, isFiberServerDown } from './fiberServer';
import type { Network } from '../types';

function makeNet(overrides: Partial<Network> = {}): Network {
  const base: Network = {
    name: 'IRC Fiber',
    host: 'irc.ircfiber.com',
    port: 6697,
    tls: 'required',
    nick: 'tester',
    realName: 'tester',
    currentNick: 'tester',
    sasl: 'none',
    saslUsername: '',
    saslPassword: '',
    connected: false,
    connecting: false,
    connectionState: 'disconnected',
    status: 'disconnected',
    disconnectReason: '',
    isAway: false,
    awayMessage: '',
    buffers: [],
    awayNicks: new Set<string>(),
    capabilities: new Set<string>(),
    isupport: {},
    chanTypes: '#',
    systemManaged: true,
    lastSeenAt: Date.now(),
    networkId: 'fiber-net-id',
  } as unknown as Network;
  return { ...base, ...overrides } as Network;
}

describe('isFiberServer', () => {
  it('identifies fiber server by host and systemManaged', () => {
    expect(isFiberServer(makeNet())).toBe(true);
    expect(isFiberServer(makeNet({ host: 'irc.libera.chat', systemManaged: false } as Partial<Network>))).toBe(false);
    expect(isFiberServer(makeNet({ host: 'irc.ircfiber.com', systemManaged: false } as Partial<Network>))).toBe(false);
    expect(isFiberServer(makeNet({ host: 'irc.libera.chat', systemManaged: true } as Partial<Network>))).toBe(false);
  });
});

describe('isFiberServerDown', () => {
  it('never hides fiber on disconnect (removed auto-hide)', () => {
    const net = makeNet({ connected: false, disabled: true } as Partial<Network>);
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('never hides fiber when retrying', () => {
    const net = makeNet({
      connected: false,
      connectionState: 'waiting_to_retry',
      status: 'waiting_to_retry',
      retryStatus: { attemptCount: 3, nextRetryAtMs: Date.now() + 14000, delayMs: 14000 },
      failInfo: { type: 'connecting_failed', reason: 'Failed to connect', killedReason: '', sslVerifyError: null, ip: '' },
    } as Partial<Network>);
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('never hides fiber even when disabled via admin (visible with reconnect affordance)', () => {
    const net = makeNet({ connected: false, disabled: true } as Partial<Network>);
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('does not hide non-fiber networks', () => {
    const net = makeNet({ host: 'irc.libera.chat', systemManaged: false, connected: false } as Partial<Network>);
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('shows fiber when connected', () => {
    const net = makeNet({ connected: true, connectionState: 'connected', status: 'connected' } as Partial<Network>);
    expect(isFiberServerDown(net)).toBe(false);
  });
});
