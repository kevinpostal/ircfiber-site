/**
 * FiberEyeBotCard.svelte — the connection-watch bot on the FiberEye page.
 *
 * Coverage:
 *  1. An un-opered heartbeat is flagged: FiberEye then sees no notices and
 *     cannot place a Z-line, so the whole subsystem is inert.
 *  2. Reconnect queues the control command the bot consumes.
 *  3. A rule switched off reads as off instead of printing a threshold that
 *     is no longer enforced.
 *  4. The #staff announcer role: the joined state is shown, Rejoin and
 *     Announce hit the FiberEye routes (FiberLogs is retired).
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
  channel: '#staff', joined: true,
  connected: true, registered: true, opered: true,
  startedAt: Date.now() - 3_600_000, connectedSince: Date.now() - 600_000, sessions: 1,
  lastRecvAt: Date.now() - 1000, lastSendAt: Date.now() - 2000,
  armed: false,
  connectsSeen: 41, connectsIgnored: 6, quitsSeen: 38, sessionsOpen: 3,
  bansPlaced: 0, bansObserved: 2, activeZlines: 0,
  accountLookups: 5,
  announced: 12, lastAnnouncement: 'IRC connect: alice!~a@h (203.0.113.7) · class main', lastAnnouncementAt: Date.now() - 30_000,
  intelLookups: 7, intelFailures: 1, intelSources: ['proxycheck', 'ripestat_prefix', 'rdap', 'sfs'],
  lastError: '', lastErrorAt: 0, hostname: 'ircfiber-fibereye', pid: 1, updatedAt: Date.now() - 2000,
  rules: {
    windowSeconds: 60, connects: 10, connectsEnabled: true,
    nicks: 6, nicksEnabled: true, churn: 6, churnEnabled: true,
    shortMs: 20_000, banSeconds: 3_600,
    ignoreClasses: ['ircfiber-engine', 'localhost'], exemptIps: [],
    updatedAtMs: 0, updatedBy: '',
  },
  rulesDeployed: {
    windowSeconds: 60, connects: 10, connectsEnabled: true,
    nicks: 6, nicksEnabled: true, churn: 6, churnEnabled: true,
    shortMs: 20_000, banSeconds: 3_600,
    ignoreClasses: ['ircfiber-engine', 'localhost'], exemptIps: [],
    updatedAtMs: 0, updatedBy: '',
  },
  rulesSource: 'deployed',
  ...over,
});

const status = (over: Record<string, unknown> = {}) => ({
  bot: heartbeat(over), alive: true, heartbeatAgeMs: 2000, runsInThisProcess: false,
  expectedNick: 'FiberEye', expectedChannel: '#staff', outboxDepth: 0, controlDepth: 0, armed: false,
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

  it('reads a disabled rule as off rather than printing its threshold', async () => {
    mockedGet.mockResolvedValue(status({
      rules: {
        windowSeconds: 60, connects: 4, connectsEnabled: true,
        nicks: 6, nicksEnabled: true, churn: 6, churnEnabled: false,
        shortMs: 20_000, banSeconds: 3_600,
        ignoreClasses: [], exemptIps: ['203.0.113.7'],
        updatedAtMs: 1_700_000_000_000, updatedBy: 'ruleadmin',
      },
      rulesSource: 'override',
    }));
    render(FiberEyeBotCard);
    await expect.element(page.getByText('short sessions off')).toBeInTheDocument();
    await expect.element(page.getByText('4 connects')).toBeInTheDocument();
    await expect.element(page.getByText('exempt: 203.0.113.7')).toBeInTheDocument();
  });

  it('shows the #staff state and drives rejoin and announce through the FiberEye routes', async () => {
    mockedGet.mockResolvedValue(status());
    render(FiberEyeBotCard);
    await expect.element(page.getByText('In #staff', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText(/IRC connect: alice/)).toBeInTheDocument();
    await expect.element(page.getByText('· 1 degraded')).toBeInTheDocument();
    await expect.element(page.getByText(/intel sources: proxycheck, ripestat_prefix/)).toBeInTheDocument();
    await page.getByRole('button', { name: 'Rejoin #staff' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/fibereye/rejoin'));
    const input = page.getByPlaceholder(/Announce in #staff/);
    await input.fill('  Maintenance in 10 minutes  ');
    await page.getByRole('button', { name: 'Announce' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/fibereye/announce', { text: 'Maintenance in 10 minutes' }));
    await expect.element(input).toHaveValue('');
  });

  it('warns when the bot is not in #staff', async () => {
    mockedGet.mockResolvedValue(status({ joined: false }));
    render(FiberEyeBotCard);
    await expect.element(page.getByText('Not in #staff', { exact: true })).toBeInTheDocument();
  });
});
