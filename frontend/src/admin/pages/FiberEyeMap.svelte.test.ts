/**
 * FiberEyeMap.svelte — the geographic view of FiberEye's observed IP groups.
 *
 * Coverage:
 *  1. The page loads the default 24 h window, plots one marker per cluster,
 *     and clicking a marker lists that cell's IP groups with links into
 *     /fibereye/ip/:group.
 *  2. A preset click refetches with the *token* only — the contract that
 *     keeps the window resolution on the server clock.
 *
 * Timers: the browser-playwright provider does not reliably honor
 * vi.useFakeTimers (see the note at the top of LogsToolbar.svelte.test.ts),
 * so refetches are awaited by polling on the real clock.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import FiberEyeMap from './FiberEyeMap.svelte';
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

// Run the fetcher once, synchronously, so no 60 s timer outlives the test.
vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => void | Promise<void>) => { void fetcher(); return () => {}; }),
}));

const mockedGet = vi.mocked(api.get);

const sample = (over: Record<string, unknown> = {}) => ({
  ipGroup: '2603:8001:98f0:1530::/64', ip: '2603:8001:98f0:1530::1', ipVersion: 6,
  connects: 96, lastTs: Date.now() - 60_000,
  nick: 'mtddnsz7', account: 'zeta', connClass: 'main',
  city: 'Frankfurt am Main', region: 'Hesse', country: 'DE',
  org: 'AS24940 Hetzner Online GmbH', asn: 'AS24940', flags: 'vpn(Mullvad)', risk: 78,
  bannedUntil: 0, strikes: 0, geoPending: false,
  ...over,
});

const payload = (range = '24h') => ({
  range,
  start: Date.now() - 86_400_000,
  end: Date.now(),
  summary: { sessions: 430, groups: 14, returned: 14, located: 12, unlocated: 2, truncated: 0 },
  clusters: [
    {
      lat: 50.1, lon: 8.7, city: 'Frankfurt am Main', region: 'Hesse', country: 'DE',
      topOrg: 'AS24940 Hetzner Online GmbH',
      groups: 12, connects: 430, lastTs: Date.now() - 60_000, banned: 0, flagged: 5,
      samples: [sample()],
    },
    {
      lat: -33.9, lon: 151.2, city: 'Sydney', region: 'New South Wales', country: 'AU',
      topOrg: 'AS4764 Aussie Broadband',
      groups: 2, connects: 40, lastTs: Date.now() - 600_000, banned: 1, flagged: 0,
      samples: [sample({ ipGroup: '203.0.113.9', ip: '203.0.113.9', ipVersion: 4, nick: 'syd', connects: 21 })],
    },
  ],
  countries: [
    { country: 'DE', groups: 12, connects: 430, banned: 0 },
    { country: '??', groups: 2, connects: 40, banned: 1 },
  ],
});

describe('FiberEyeMap.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation(() => Promise.resolve(payload()));
  });

  it('loads the 24h window, plots a marker per cluster and opens the cell on click', async () => {
    render(FiberEyeMap);

    expect(mockedGet).toHaveBeenCalledWith('/api/admin/fibereye/map', { range: '24h' });
    // The country rollup proves the payload rendered, including the "??"
    // bucket for groups with no country.
    await expect.element(page.getByText('DE', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('??', { exact: true })).toBeInTheDocument();

    // One marker per cluster; clicking the busiest one lists its IP groups.
    await expect.element(page.getByTestId('eyemap-cluster-1')).toBeInTheDocument();
    await page.getByTestId('eyemap-cluster-0').click();
    const link = page.getByRole('link', { name: '2603:8001:98f0:1530::/64' });
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute(
      'href', '#/fibereye/ip/' + encodeURIComponent('2603:8001:98f0:1530::/64'));
    await expect.element(page.getByText('mtddnsz7', { exact: true })).toBeInTheDocument();
  });

  it('sends only the token when a preset is picked, leaving the bounds to the server', async () => {
    render(FiberEyeMap);
    await expect.element(page.getByTestId('eyemap-cluster-0')).toBeInTheDocument();

    await page.getByTestId('eyemap-preset-7d').click();
    await vi.waitFor(
      () => expect(mockedGet).toHaveBeenCalledWith('/api/admin/fibereye/map', { range: '7d' }),
      { timeout: 2_000, interval: 25 },
    );
  });
});
