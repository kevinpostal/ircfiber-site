import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import ConnectionStatus from './ConnectionStatus.svelte';
import { ircState } from '../stores/ircStore.svelte';
import { createNetwork, createBuffer } from '../test/factories';
import { reconnectNetwork, disconnectNetwork } from '/src/stores/api';
import { sendRaw } from '/src/stores/wsConnection.svelte.ts';
import {
  renderReason,
  renderSSLVerify,
  renderRetryCountdown,
  connectionWarnings,
} from '../lib/connectionWarnings';

// `ConnectionStatus` imports a handful of singletons. Mocking them out
// keeps each test deterministic and prevents the WS connection from
// trying to talk to a real backend during the suite. The mock MUST
// include every export that any transitively-imported module references
// (ircStore pulls in archiveChannel + normalizeMessage from api.ts),
// otherwise vite's resolver surfaces a "missing export" error during
// the test-file's transform pass.
vi.mock('/src/stores/wsConnection.svelte.ts', () => ({
  sendRaw: vi.fn(),
  requestSync: vi.fn(),
  setMaxEid: vi.fn(),
  requestSwitchBuffer: vi.fn(),
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  wsState: { value: 'disconnected' },
  maxEidTracker: { value: 0 },
}));

vi.mock('/src/stores/api', () => ({
  fetchMe: vi.fn(async () => ({ username: 'tester', email: 'tester@test.local' })),
  fetchHealth: vi.fn(async () => ({ status: 'healthy', services: {} })),
  loadHistory: vi.fn(async () => []),
  loadHistoryWithMeta: vi.fn(async () => ({ messages: [], backlog_size: 0, earliest_msgid: '', earliest_ts: 0, earliest_eid: 0, cache_size: 0 })),
  reconnectNetwork: vi.fn(async () => undefined),
  disconnectNetwork: vi.fn(async () => undefined),
  clearBacklog: vi.fn(async () => undefined),
  joinChannel: vi.fn(async () => undefined),
  addNetwork: vi.fn(async () => undefined),
  updateNetwork: vi.fn(async () => undefined),
  deleteNetwork: vi.fn(async () => undefined),
  archiveChannel: vi.fn(async () => undefined),
  unarchiveChannel: vi.fn(async () => undefined),
  updateServerlogCollapsed: vi.fn(async () => undefined),
  pinChannel: vi.fn(async () => undefined),
  unpinChannel: vi.fn(async () => undefined),
  updateCollapsed: vi.fn(async () => undefined),
  updateInactiveCollapsed: vi.fn(async () => undefined),
  updateNetworkOrder: vi.fn(async () => undefined),
  updateMembersCollapsed: vi.fn(async () => undefined),
  updateBufferPrefs: vi.fn(async () => undefined),
  normalizeMessage: vi.fn((m: unknown) => m),
}));

function pushNetwork(opts: Partial<Parameters<typeof createNetwork>[0]>) {
  const net = createNetwork({ networkId: 'net1', ...opts });
  net.buffers.push(createBuffer({ name: '#chan' }));
  ircState.networks.push(net);
  ircState.activeBuffer.networkId = 'net1';
  ircState.activeBuffer.bufferName = '#chan';
  flushSync();
  return net;
}

beforeEach(() => {
  ircState.networks.length = 0;
  ircState.activeBuffer.networkId = null;
  ircState.activeBuffer.bufferName = null;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ConnectionStatus — banner states (W3-T01)', () => {
  it('renders Away state with click-to-come-back text', async () => {
    pushNetwork({ isAway: true, connected: true });
    render(ConnectionStatus);
    await expect.element(page.getByText('Away')).toBeInTheDocument();
    await expect.element(page.getByText(/Click to come back/)).toBeInTheDocument();
  });

  it('renders Connecting to <host> when state=connecting', async () => {
    pushNetwork({ connected: false, connectionState: 'connecting', host: 'irc.example.com' });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Connecting to irc\.example\.com/)).toBeInTheDocument();
  });

  it('renders "Reconnecting to <host>" when connecting after a prior disconnect', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'connecting',
      host: 'irc.example.com',
      disconnectReason: 'Connection reset',
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Reconnecting to irc\.example\.com/)).toBeInTheDocument();
  });

  it('renders "Failed to connect - <reason>" when failInfo.type=connecting_failed', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: { type: 'connecting_failed', reason: 'Connection refused' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Failed to connect - Connection refused/)).toBeInTheDocument();
  });

  it('renders "Disconnected - Killed: <reason>" when failInfo.type=killed', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: { type: 'killed', killedReason: 'K-lined: spamming' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Disconnected - Killed:.*K-lined: spamming/)).toBeInTheDocument();
  });

  it('renders SSL verify error banner when failInfo.sslVerifyError present', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: {
        type: 'ssl_certificate_error',
        sslVerifyError: { type: 'CERT_HAS_EXPIRED', error: 'server certificate expired on 2026-01-01' },
      },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Strict transport security error:/)).toBeInTheDocument();
    await expect.element(page.getByText(/CERT_HAS_EXPIRED:.*2026-01-01/)).toBeInTheDocument();
  });

  it('renders "Connections to this server have been blocked" when failInfo.type=connection_blocked', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: { type: 'connection_blocked' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Connections to this server have been blocked/)).toBeInTheDocument();
  });

  it('renders "Disconnected: <reason>" via renderReason when failInfo.type=socket_closed', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: { type: 'socket_closed', reason: 'econnreset' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Disconnected: Connection reset by peer/)).toBeInTheDocument();
  });

  it('renders generic Disconnected banner when no failInfo', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'Network unreachable',
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Disconnected: Network unreachable/)).toBeInTheDocument();
  });

  it('renders Gave up retrying suffix when failInfo.reason=gave_up_retrying', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      disconnectReason: 'gave_up_retrying',
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Gave up retrying/)).toBeInTheDocument();
  });

  it('renders Reconnecting in <N>s... (<ordinal> attempt) with live countdown ticks', async () => {
    vi.useFakeTimers();
    const base = Date.now();
    vi.setSystemTime(base);
    pushNetwork({
      connected: false,
      connectionState: 'waiting_to_retry',
      retryStatus: { attemptCount: 3, nextRetryAtMs: base + 12_000, delayMs: 12_000 },
    });

    render(ConnectionStatus);
    // Initial render — should show 12s remaining on the 3rd attempt
    await expect.element(page.getByText(/Reconnecting in 12s/)).toBeInTheDocument();
    await expect.element(page.getByText(/3rd attempt/)).toBeInTheDocument();

    // Advance 5 seconds — countdown should tick to 7
    vi.advanceTimersByTime(5_000);
    flushSync();
    await expect.element(page.getByText(/Reconnecting in 7s/)).toBeInTheDocument();
  });

  it('hides banner entirely when fully connected and not away', async () => {
    pushNetwork({ connected: true, connectionState: 'connected', isAway: false });
    render(ConnectionStatus);
    const cell = document.querySelector('.connectionstatuscell');
    // Either the cell is hidden (.show not applied) or empty
    expect(cell?.classList.contains('show')).toBeFalsy();
  });
});

describe('ConnectionStatus — inline warnings (W3-T01)', () => {
  it('shows "SSL on plaintext port" warning when ssl + port 6667', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      host: 'irc.example.com',
      port: 6667,
      tls: 'required',
      disconnectReason: 'Connection refused',
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/trying to connect via SSL on port 6667/)).toBeInTheDocument();
  });

  it('shows "hostname looks invalid" warning for localhost', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      host: 'localhost',
      port: 6667,
      tls: 'required',
      disconnectReason: 'Connection refused',
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/hostname looks invalid: localhost/)).toBeInTheDocument();
  });

  it('appends "Check your host, port and ssl settings" CTA when failed', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      failInfo: { type: 'connecting_failed', reason: 'Connection refused' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Check your host, port and ssl settings/)).toBeInTheDocument();
  });

  it('does not append CTA during normal connecting (no fail yet)', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'connecting',
      host: 'irc.example.com',
      port: 6697,
      tls: 'required',
    });
    render(ConnectionStatus);
    // No CTA on a fresh attempt
    expect(page.getByText(/Check your host, port and ssl settings/).query()).toBeNull();
  });
});

describe('ConnectionStatus — button behaviour (W3-T01)', () => {
  it('shows "Click to reconnect" by default', async () => {
    pushNetwork({ connected: false, connectionState: 'disconnected', disconnectReason: 'lost' });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Click to reconnect/)).toBeInTheDocument();
  });

  it('shows "Click to disconnect" when badRetry=true', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      badRetry: true,
      failInfo: { type: 'connection_blocked' },
    });
    render(ConnectionStatus);
    await expect.element(page.getByText(/Click to disconnect/)).toBeInTheDocument();
  });

  it('calls reconnect on click when not badRetry', async () => {
    pushNetwork({ connected: false, connectionState: 'disconnected', disconnectReason: 'lost' });
    render(ConnectionStatus);
    await page.getByText(/Click to reconnect/).click();
    expect(reconnectNetwork).toHaveBeenCalledWith('net1');
  });

  it('calls disconnect on click when badRetry', async () => {
    pushNetwork({
      connected: false,
      connectionState: 'disconnected',
      badRetry: true,
      failInfo: { type: 'connection_blocked' },
    });
    render(ConnectionStatus);
    await page.getByText(/Click to disconnect/).click();
    expect(disconnectNetwork).toHaveBeenCalledWith('net1', expect.any(String));
  });

  it('calls sendRaw(AWAY) on Away click', async () => {
    pushNetwork({ isAway: true, connected: true });
    render(ConnectionStatus);
    await page.getByText('Away').click();
    expect(sendRaw).toHaveBeenCalledWith('net1', 'AWAY');
  });
});

describe('connectionWarnings helpers (W3-T01)', () => {
  describe('renderReason', () => {
    it('translates econnrefused to "Connection refused"', () => {
      expect(renderReason('econnrefused')).toBe('Connection refused');
    });
    it('translates tls_alert to "TLS handshake failed"', () => {
      expect(renderReason('tls_alert')).toBe('TLS handshake failed');
    });
    it('passes unknown reasons through verbatim', () => {
      expect(renderReason('weird thing')).toBe('weird thing');
    });
    it('returns empty for empty/null/undefined', () => {
      expect(renderReason('')).toBe('');
      expect(renderReason(null)).toBe('');
      expect(renderReason(undefined)).toBe('');
    });
  });

  describe('renderSSLVerify', () => {
    it('formats "<type>: <error>"', () => {
      expect(renderSSLVerify({ type: 'CERT_HAS_EXPIRED', error: 'expired on 2026-01-01' }))
        .toBe('CERT_HAS_EXPIRED: expired on 2026-01-01');
    });
    it('falls back to just type when error missing', () => {
      expect(renderSSLVerify({ type: 'TLSV1_ALERT', error: '' })).toBe('TLSV1_ALERT');
    });
    it('returns generic message when null', () => {
      expect(renderSSLVerify(null)).toBe('TLS verification failed');
    });
  });

  describe('renderRetryCountdown', () => {
    it('formats "Reconnecting in Ns... (Nth attempt)" with ordinals', () => {
      const now = 1000;
      expect(renderRetryCountdown({ attemptCount: 1, nextRetryAtMs: 11_000, delayMs: 10_000 }, now))
        .toBe('Reconnecting in 10s… (1st attempt)');
      expect(renderRetryCountdown({ attemptCount: 2, nextRetryAtMs: 11_000, delayMs: 10_000 }, now))
        .toBe('Reconnecting in 10s… (2nd attempt)');
      expect(renderRetryCountdown({ attemptCount: 3, nextRetryAtMs: 11_000, delayMs: 10_000 }, now))
        .toBe('Reconnecting in 10s… (3rd attempt)');
      expect(renderRetryCountdown({ attemptCount: 11, nextRetryAtMs: 11_000, delayMs: 10_000 }, now))
        .toBe('Reconnecting in 10s… (11th attempt)');
    });
    it('clamps to 0s when nextRetryAtMs is in the past', () => {
      expect(renderRetryCountdown({ attemptCount: 1, nextRetryAtMs: 0, delayMs: 1000 }, 5000))
        .toBe('Reconnecting in 0s… (1st attempt)');
    });
    it('returns empty for missing retryStatus', () => {
      expect(renderRetryCountdown(null)).toBe('');
      expect(renderRetryCountdown(undefined)).toBe('');
    });
  });

  describe('connectionWarnings', () => {
    it('warns about SSL on plaintext port 6667', () => {
      expect(connectionWarnings('irc.example.com', 6667, true)).toContain(
        "You're trying to connect via SSL on port 6667",
      );
    });
    it('warns about localhost-style hosts', () => {
      expect(connectionWarnings('localhost', 6667, false)).toContain(
        'Your hostname looks invalid: localhost',
      );
      expect(connectionWarnings('127.0.0.1', 6667, false)).toContain(
        'Your hostname looks invalid: 127.0.0.1',
      );
      expect(connectionWarnings('192.168.1.5', 6667, false)).toContain(
        'Your hostname looks invalid: 192.168.1.5',
      );
    });
    it('does not warn for a normal hostname', () => {
      const w = connectionWarnings('irc.libera.chat', 6697, true);
      expect(w.some((m) => m.includes('localhost'))).toBe(false);
      expect(w.some((m) => m.includes('SSL on port'))).toBe(false);
    });
    it('appends CTA only when includeConfigCta=true', () => {
      expect(connectionWarnings('irc.example.com', 6697, false)).not.toContain(
        'Check your host, port and ssl settings',
      );
      expect(connectionWarnings('irc.example.com', 6697, false, { includeConfigCta: true })).toContain(
        'Check your host, port and ssl settings',
      );
    });
  });
});