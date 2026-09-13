/**
 * Dashboard.svelte — the admin landing page's Redis and MongoDB summary cards.
 *
 * Guards two honesty bugs found while chasing the "dashboard shows nothing"
 * report on prod:
 *  1. Redis uptime was rendered with `relative(uptimeSeconds * 1000)`, i.e. a
 *     duration fed to an absolute-timestamp formatter — a 9-day-old Redis
 *     printed "20699d ago". It must read as an elapsed duration.
 *  2. Prod's Mongo app user cannot run `serverStatus` (no clusterMonitor
 *     role), so the gateway returns `serverStatusError` and the card silently
 *     showed em dashes for Version/Connections. The refusal must be visible.
 *
 * Fetching is out of scope here (stores are set directly and `startPolling`
 * is inert) — the poll/pause contract lives in stores/polling.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';

import Dashboard from './Dashboard.svelte';
import { redisSummary } from '/src/admin/stores/redis';
import { mongoStatus } from '/src/admin/stores/mongo';
import { dashboard } from '/src/admin/stores/dashboard';

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  pollingEnabled: { subscribe: (run: (v: boolean) => void) => { run(true); return () => {}; }, set: vi.fn(), update: vi.fn() },
}));

// Inert: this suite asserts rendering of store data, not the fetch loop.
vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn(() => () => {}),
}));

const SERVER_STATUS_REFUSAL =
  'command failed: not authorized on ircfiber to execute command { serverStatus: 1, $db: "ircfiber" }';

beforeEach(() => {
  dashboard.set(null);
  redisSummary.set({ version: '7.4.10', uptimeSeconds: 815_519, usedMemoryHuman: '194.50M', connectedClients: 152 });
  mongoStatus.set({ connected: true, dbName: 'ircfiber', dbStats: { collections: 15, objects: 2_415_392, dataSize: 1_788_902_830 } });
});

describe('Dashboard summary cards', () => {
  it('shows Redis uptime as an elapsed duration, not a timestamp', async () => {
    render(Dashboard);

    const card = document.body.textContent ?? '';
    expect(card).toContain('9d 10h');
    expect(card).not.toContain('ago');
  });

  it('explains a missing serverStatus instead of showing bare em dashes', async () => {
    mongoStatus.update((s) => ({ ...s!, serverStatusError: SERVER_STATUS_REFUSAL }));
    render(Dashboard);

    const text = document.body.textContent ?? '';
    expect(text).toContain('serverStatus');
    expect(text).toContain('not authorized on ircfiber');
    // dbStats-derived figures still render alongside the warning.
    expect(text).toContain('2.4m');
  });

  it('drops the serverStatus warning once the command is permitted', async () => {
    mongoStatus.update((s) => ({
      ...s!,
      serverStatus: { version: '8.0.4', connections: { current: 24, available: 838 } },
    }));
    render(Dashboard);

    const text = document.body.textContent ?? '';
    expect(text).toContain('8.0.4');
    expect(text).toContain('24 / 838 avail');
    expect(text).not.toContain('serverStatus');
  });
});
