import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isFiberServer, isFiberServerDown } from './fiberServer';
import type { Network } from '../types';

const { mockIsUserDisconnected } = vi.hoisted(() => ({
  mockIsUserDisconnected: vi.fn(() => false),
}));
vi.mock('../stores/ircStore.svelte', () => ({
  isUserDisconnected: mockIsUserDisconnected,
}));
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
  };
  return { ...base, ...overrides };
}

describe('isFiberServer', () => {
  it('identifies fiber server by host and systemManaged', () => {
    expect(isFiberServer(makeNet({ host: 'irc.ircfiber.com', systemManaged: true }))).toBe(true);
    expect(isFiberServer(makeNet({ host: 'irc.ircfiber.com', systemManaged: false }))).toBe(false);
    expect(isFiberServer(makeNet({ host: 'irc.libera.chat', systemManaged: true }))).toBe(false);
    expect(isFiberServer(makeNet({ host: 'irc.libera.chat', systemManaged: false }))).toBe(false);
  });
});

describe('isFiberServerDown', () => {
  beforeEach(() => {
    mockIsUserDisconnected.mockReturnValue(false);
  });

  it('hides fiber when not connected and retrying', () => {
    const net = makeNet({
      connected: false,
      connectionState: 'waiting_to_retry',
      status: 'waiting_to_retry',
      retryStatus: { attemptCount: 3, nextRetryAtMs: Date.now() + 14000, delayMs: 14000 },
      failInfo: { type: 'connecting_failed', reason: 'Failed to connect', killedReason: '', sslVerifyError: null, ip: '' },
    });
    expect(isFiberServerDown(net)).toBe(true);
  });

  it('hides fiber when TLS fail', () => {
    const net = makeNet({
      connected: false,
      disconnectReason: 'TLS handshake failed',
      failInfo: { type: 'connecting_failed', reason: 'tls_fail', killedReason: '', sslVerifyError: null, ip: '' },
    });
    expect(isFiberServerDown(net)).toBe(true);
  });

  it('shows fiber when connected', () => {
    const net = makeNet({ connected: true, connectionState: 'connected', status: 'connected' });
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('shows fiber when user explicitly disconnected', () => {
    mockIsUserDisconnected.mockReturnValue(true);
    const net = makeNet({ connected: false, disconnectReason: 'You disconnected' });
    expect(isFiberServerDown(net)).toBe(false);
    mockIsUserDisconnected.mockReturnValue(false);
  });

  it('does not hide user networks', () => {
    const net = makeNet({
      host: 'irc.libera.chat',
      systemManaged: false,
      connected: false,
      disconnectReason: 'Failed to connect',
    });
    expect(isFiberServerDown(net)).toBe(false);
  });

  it('hides fiber on DNS timeout', () => {
    const net = makeNet({
      connected: false,
      disconnectReason: 'DNS resolution failed for irc.ircfiber.com',
    });
    expect(isFiberServerDown(net)).toBe(true);
  });

  it('shows fiber when no failure evidence but recently seen', () => {
    const net = makeNet({
      connected: false,
      connectionState: 'disconnected',
      status: 'disconnected',
      disconnectReason: '',
      retryStatus: null,
      failInfo: null,
      lastSeenAt: Date.now(),
    });
    expect(isFiberServerDown(net)).toBe(true);
  });
});
