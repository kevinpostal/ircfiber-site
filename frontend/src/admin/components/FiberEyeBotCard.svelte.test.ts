/**
 * FiberEyeBotCard.svelte — the connection-watch bot on the FiberEye page.
 *
 * Coverage:
 *  1. An un-opered heartbeat is flagged: FiberEye then sees no notices and
 *     cannot place a Z-line, so the whole subsystem is inert.
 *  2. Reconnect queues the control command the bot consumes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import FiberEyeBotCard from './FiberEyeBotCard.svelte';
import { api } from '/src/admin/lib/api-client';

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// The card polls through startPolling; run the fetcher once, synchronously,
// so tests are deterministic and never leave a timer behind.
vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => void | Promise<void>) => { void fetcher(); return () => {}; }),
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const heartbeat = (over: Record<string, unknown> = {}) => ({
  nick: 'FiberEye', configuredNick: 'FiberEye', host: 'ircd', port: 6667, tls: false,
  connected: true, registered: true, opered: true,
  startedAt: Date.now() - 3_600_000, connectedSince: Date.now() - 600_000, sessions: 1,
  lastRecvAt: Date.now() - 1000, lastSendAt: Date.now() - 2000,
  armed: false,
  connectsSeen: 41, connectsIgnored: 6, quitsSeen: 38, sessionsOpen: 3,
  bansPlaced: 0, bansObserved: 2, activeZlines: 0,
  accountLookups: 5, geoFilled: 4,
  lastError: '', lastErrorAt: 0, hostname: 'ircfiber-fibereye', pid: 1, updatedAt: Date.now() - 2000,
  thresholds: { windowSeconds: 60, connects: 10, nicks: 6, churn: 6, shortMs: 20_000, banSeconds: 3_600 },
  ignoreClasses: ['ircfiber-engine', 'localhost'],
  exemptIps: [],
  ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  bot: heartbeat(over), alive: true, heartbeatAgeMs: 2000, runsInThisProcess: false,
  expectedNick: 'FiberEye', armed: false,
});

describe('FiberEyeBotCard.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({});
  });

  it('flags a connected bot that failed to oper', async () => {
    mockedGet.mockResolvedValue(status({ opered: false }));
    render(FiberEyeBotCard);
    await expect.element(
      page.getByText('Connected, not opered — no notices, no bans', { exact: true }),
    ).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/fibereye');
  });

  it('queues a reconnect for the watch connection', async () => {
    mockedGet.mockResolvedValue(status());
    render(FiberEyeBotCard);
    await expect.element(page.getByText('Watching', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('· 6 ignored')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/fibereye/reconnect'));
  });
});
