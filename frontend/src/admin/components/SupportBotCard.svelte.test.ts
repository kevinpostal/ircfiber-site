/**
 * SupportBotCard.svelte — the #support services bot on the IRCD page.
 *
 * Coverage:
 *  1. A fresh heartbeat renders "In #support" with the bot's counters; the
 *     control buttons are enabled and Rejoin queues the command.
 *  2. No heartbeat renders Offline with controls disabled (a queued command
 *     would never be consumed).
 *  3. Announce posts the trimmed text and clears the field.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import SupportBotCard from './SupportBotCard.svelte';
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
  nick: 'FiberSupport', configuredNick: 'FiberSupport', channel: '#support', host: 'ircd', port: 6667, tls: false,
  publicUrl: 'https://ircfiber.com', connected: true, registered: true, joined: true,
  startedAt: Date.now() - 3_600_000, connectedSince: Date.now() - 600_000, sessions: 1,
  lastRecvAt: Date.now() - 1000, lastSendAt: Date.now() - 2000,
  announced: 7, lastAnnouncement: 'New issue #12 [bug] "Upload dialog freezes" — reported by zodiac', lastAnnouncementAt: Date.now() - 60_000,
  commandsAnswered: 3, lastCommand: '!issues', lastCommandBy: 'zodiac', lastCommandAt: Date.now() - 120_000,
  lastError: '', lastErrorAt: 0, hostname: 'ircfiber-support-bot', pid: 1, updatedAt: Date.now() - 2000,
  ...over,
});

const online = () => ({
  status: heartbeat(), alive: true, heartbeatAgeMs: 2000, outboxDepth: 0, controlDepth: 0,
  expectedNick: 'FiberSupport', expectedChannel: '#support', runsInThisProcess: false,
});

const offline = () => ({
  status: null, alive: false, heartbeatAgeMs: -1, outboxDepth: 4, controlDepth: 0,
  expectedNick: 'FiberSupport', expectedChannel: '#support', runsInThisProcess: false,
});

describe('SupportBotCard.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({});
  });

  it('renders a live bot and queues a rejoin', async () => {
    mockedGet.mockResolvedValue(online());
    render(SupportBotCard);
    await expect.element(page.getByText('In #support', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('ircfiber-support-bot')).toBeInTheDocument();
    await expect.element(page.getByText(/New issue #12/)).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/support/bot');
    await page.getByRole('button', { name: 'Rejoin #support' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/support/bot/rejoin'));
  });

  it('shows Offline with disabled controls when there is no heartbeat', async () => {
    mockedGet.mockResolvedValue(offline());
    render(SupportBotCard);
    await expect.element(page.getByText('Offline', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Rejoin #support' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Reconnect' })).toBeDisabled();
    // Queued announcements still count even while the bot is away.
    await expect.element(page.getByText('4 queued')).toBeInTheDocument();
  });

  it('posts an announcement and clears the field', async () => {
    mockedGet.mockResolvedValue(online());
    render(SupportBotCard);
    await expect.element(page.getByText('In #support', { exact: true })).toBeInTheDocument();
    const input = page.getByPlaceholder(/Announce in #support/);
    await input.fill('  Maintenance in 10 minutes  ');
    await page.getByRole('button', { name: 'Announce' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/support/bot/announce', { text: 'Maintenance in 10 minutes' }));
    await expect.element(input).toHaveValue('');
  });
});
