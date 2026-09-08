/**
 * FiberEye.svelte — the connection-watch page.
 *
 * Coverage:
 *  1. A disarmed payload badges "Observing" and lists the would-ban
 *     candidates; Arm goes through the confirmation before it posts.
 *  2. A session row shows nick/account/IP, and an unclosed session reads
 *     "open" rather than a 0 duration.
 *  3. The search box refetches with `q` after its 200 ms debounce.
 *
 * Timers: the browser-playwright provider does not reliably honor
 * vi.useFakeTimers (see the note at the top of LogsToolbar.svelte.test.ts),
 * so the 200 ms debounce runs on the real clock and the test polls for the
 * refetch it triggers instead of sleeping for a fixed duration.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import FiberEye from './FiberEye.svelte';
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

// The page and its bot card both poll through startPolling; run each
// fetcher once, synchronously, so no timer outlives the test.
vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => void | Promise<void>) => { void fetcher(); return () => {}; }),
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const heartbeat = {
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
};

const candidate = {
  id: 'ban-1', mask: '2603:8001:98f0:1530::/64', ipGroup: '2603:8001:98f0:1530::/64',
  type: 'zline', rule: 'connect_flood',
  reason: 'FiberEye: connection flood from your address. Appeal: https://ircfiber.com/unban/abc',
  durationSeconds: 3600, placedAtMs: Date.now() - 120_000, expiresAtMs: Date.now() + 3_480_000,
  strikes: 1, observeOnly: true, placed: false, placeError: '',
  releasedAtMs: 0, releasedBy: '',
  evidence: { connects: 14, nicks: 7, shortSessions: 9, windowSeconds: 60 },
  state: 'observed',
};

const overview = (over: Record<string, unknown> = {}) => ({
  armed: false,
  bot: heartbeat,
  alive: true,
  heartbeatAgeMs: 2000,
  runsInThisProcess: false,
  expectedNick: 'FiberEye',
  counters: {
    connects24h: 128, quits24h: 121, uniqueIps24h: 37, sessionsOpen: 3,
    bansActive: 0, bansObserved24h: 2, releases24h: 0,
  },
  candidates: [candidate],
  recentBans: [candidate],
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 'sess-1', ts: Date.now() - 30_000, nick: 'mtddnsz7', ident: '~mtddnsz7',
  host: 'cloak.ircfiber.com', ip: '76.32.236.21', ipGroup: '76.32.236.21', ipVersion: 4,
  realname: 'Windows 11 user', connClass: 'main', port: 6697, tls: true, account: 'zeta',
  quitTs: 0, quitReason: '', durationMs: 0,
  geoCity: 'Dallas', geoRegion: 'Texas', geoCountry: 'US', geoOrg: 'AS7018 AT&T',
  geoTimezone: 'America/Chicago', geoPrivacy: '', geoPending: false,
  ...over,
});

const paged = (rows: unknown[]) => ({ rows, total: rows.length, page: 0, limit: 50 });

/** Routes every endpoint the page (and its nested bot card) fetches. */
function routeGet(sessions: unknown[] = [session()]) {
  mockedGet.mockImplementation((path: string) => {
    if (path === '/api/admin/fibereye') return Promise.resolve(overview());
    if (path === '/api/admin/fibereye/sessions') return Promise.resolve(paged(sessions));
    if (path === '/api/admin/fibereye/ips') return Promise.resolve(paged([]));
    if (path === '/api/admin/fibereye/bans') return Promise.resolve(paged([candidate]));
    return Promise.resolve({});
  });
}

describe('FiberEye.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPost.mockResolvedValue({ armed: true });
  });

  it('renders the observing state with its candidates and arms after confirming', async () => {
    routeGet();
    render(FiberEye);
    await expect.element(page.getByText('Observing', { exact: true })).toBeInTheDocument();
    // The would-ban candidate the disarmed rule engine recorded.
    await expect.element(page.getByText('2603:8001:98f0:1530::/64', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('connect_flood', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('14 connects · 7 nicks · 9 short / 60s')).toBeInTheDocument();

    await page.getByRole('button', { name: 'Arm enforcement', exact: true }).click();
    // Arming is behind the confirmation: nothing is posted until it is taken.
    await expect.element(page.getByText('Arm FiberEye enforcement?')).toBeInTheDocument();
    expect(mockedPost).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Arm', exact: true }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith(
      '/api/admin/fibereye/arm', { armed: true }));
  });

  it('renders an open session row', async () => {
    routeGet([
      session(),
      session({
        id: 'sess-2', nick: 'cstestrjbdp_', account: '',
        ip: '76.32.236.22', ipGroup: '76.32.236.22',
        quitTs: Date.now() - 5_000, durationMs: 4_000,
      }),
    ]);
    render(FiberEye);
    await expect.element(page.getByText('mtddnsz7', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('zeta', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('76.32.236.21', { exact: true })).toBeInTheDocument();
    // quitTs === 0 must read "open", not a zero duration.
    await expect.element(page.getByText('open', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('4s', { exact: true })).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith(
      '/api/admin/fibereye/sessions', { page: 0, limit: 50, q: undefined });
  });

  it('refetches with q after the search debounce', async () => {
    routeGet();
    render(FiberEye);
    await expect.element(page.getByText('mtddnsz7', { exact: true })).toBeInTheDocument();

    await page.getByPlaceholder(/Search nick/).fill('76.32');
    // Real timers: the playwright provider ignores vi.useFakeTimers, so the
    // 200 ms debounce is awaited by polling for the refetch it causes rather
    // than by sleeping for a guessed duration.
    await vi.waitFor(
      () => expect(mockedGet).toHaveBeenCalledWith(
        '/api/admin/fibereye/sessions', { page: 0, limit: 50, q: '76.32' }),
      { timeout: 2_000, interval: 25 },
    );
  });
});
