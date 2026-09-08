/**
 * LogsBotCard.svelte — the #staff operations-log bot on the IRCD page.
 *
 * Coverage:
 *  1. A fresh heartbeat renders "In #staff" with the connect/geo counters;
 *     the control buttons are enabled and Rejoin queues the command.
 *  2. No heartbeat renders Offline with controls disabled (a queued command
 *     would never be consumed).
 *  3. A joined-but-not-opered bot is flagged: it silently sees no connects.
 *  4. Announce posts the trimmed text and clears the field.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import LogsBotCard from './LogsBotCard.svelte';
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
  nick: 'FiberLogs', configuredNick: 'FiberLogs', channel: '#staff', host: 'ircd', port: 6667, tls: false,
  connected: true, registered: true, joined: true, opered: true,
  startedAt: Date.now() - 3_600_000, connectedSince: Date.now() - 600_000, sessions: 1,
  lastRecvAt: Date.now() - 1000, lastSendAt: Date.now() - 2000,
  announced: 12, lastAnnouncement: 'IRC connect: alice!~alice@host.example (203.0.113.7) · class main', lastAnnouncementAt: Date.now() - 60_000,
  connectsSeen: 9, connectsIgnored: 4, geoLookups: 6, geoFailures: 1, geoConfigured: true,
  lastError: '', lastErrorAt: 0, hostname: 'ircfiber-logs-bot', pid: 1, updatedAt: Date.now() - 2000,
  ...over,
});

const online = (over: Record<string, unknown> = {}) => ({
  status: heartbeat(over), alive: true, heartbeatAgeMs: 2000, outboxDepth: 0, controlDepth: 0,
  expectedNick: 'FiberLogs', expectedChannel: '#staff', runsInThisProcess: false,
});

const offline = () => ({
  status: null, alive: false, heartbeatAgeMs: -1, outboxDepth: 3, controlDepth: 0,
  expectedNick: 'FiberLogs', expectedChannel: '#staff', runsInThisProcess: false,
});

describe('LogsBotCard.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({});
  });

  it('renders a live bot with its counters and queues a rejoin', async () => {
    mockedGet.mockResolvedValue(online());
    render(LogsBotCard);
    await expect.element(page.getByText('In #staff', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('ircfiber-logs-bot')).toBeInTheDocument();
    await expect.element(page.getByText('· 4 ignored')).toBeInTheDocument();
    await expect.element(page.getByText('· 1 failed')).toBeInTheDocument();
    await expect.element(page.getByText(/IRC connect: alice/)).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/logs-bot');
    await page.getByRole('button', { name: 'Rejoin #staff' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/logs-bot/rejoin'));
  });

  it('shows Offline with disabled controls when there is no heartbeat', async () => {
    mockedGet.mockResolvedValue(offline());
    render(LogsBotCard);
    await expect.element(page.getByText('Offline', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Rejoin #staff' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    // Queued announcements still count even while the bot is away.
    await expect.element(page.getByText('3 queued')).toBeInTheDocument();
  });

  it('flags a joined bot that failed to oper, and a missing geo token', async () => {
    mockedGet.mockResolvedValue(online({ opered: false, geoConfigured: false }));
    render(LogsBotCard);
    await expect.element(page.getByText('In #staff, not opered', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('· geo token missing')).toBeInTheDocument();
  });

  it('posts an announcement and clears the field', async () => {
    mockedGet.mockResolvedValue(online());
    render(LogsBotCard);
    await expect.element(page.getByText('In #staff', { exact: true })).toBeInTheDocument();
    const input = page.getByPlaceholder(/Announce in #staff/);
    await input.fill('  Maintenance in 10 minutes  ');
    await page.getByRole('button', { name: 'Announce' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/logs-bot/announce', { text: 'Maintenance in 10 minutes' }));
    await expect.element(input).toHaveValue('');
  });
});
