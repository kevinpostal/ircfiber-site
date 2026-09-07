/**
 * Backups.svelte — admin Backups page (k3s CronJob state + published history).
 *
 * Coverage:
 *  1. Overview fixture (mongo ok, redis failed): renders the failed job's
 *     badge and its message, plus the snapshot rows.
 *  2. Clicking Run now on the mongo card and confirming posts exactly
 *     /api/admin/backups/ircfiber-mongo-backup/run and toasts success.
 *  3. With control unavailable: warning strip shows, both buttons disabled.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Backups from './Backups.svelte';
import * as ui from '/src/admin/stores/ui';
import { api, ApiError } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>;
const mockedToastOk = ui.toastSuccess as unknown as ReturnType<typeof vi.fn>;
const mockedToastErr = ui.toastError as unknown as ReturnType<typeof vi.fn>;

vi.mock('/src/admin/lib/api-client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  pollingEnabled: { subscribe: vi.fn() },
}));

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => {
    void fetcher();
    return () => {};
  }),
}));

const now = Date.now();

const overviewFixture = (control: { available: boolean; error: string }) => ({
  jobs: [
    {
      name: 'ircfiber-mongo-backup', kind: 'mongo', schedule: '17 3 * * *',
      suspended: false, lastScheduleTime: now - 3600_000, lastSuccessTime: now - 3600_000,
      nextRunAt: now + 20 * 3600_000, state: 'ok', active: [],
    },
    {
      name: 'ircfiber-redis-backup', kind: 'redis', schedule: '37 3 * * *',
      suspended: false, lastScheduleTime: now - 1800_000, lastSuccessTime: now - 25 * 3600_000,
      nextRunAt: now + 21 * 3600_000, state: 'failed', active: [],
    },
  ],
  runs: [
    {
      kind: 'redis', status: 'failed', stage: 'dump', startedAt: now - 1800_000,
      finishedAt: now - 1700_000, durationMs: 100_000, file: 'redis-20260907-021628.rdb',
      bytes: 9639469, node: 'ubuntu-docker', message: 'connection refused on dump',
    },
    {
      kind: 'mongo', status: 'ok', stage: 'done', startedAt: now - 3600_000,
      finishedAt: now - 3500_000, durationMs: 100_000, file: 'mongo-20260907-031701.archive.gz',
      bytes: 66742833, node: 'ubuntu-docker', message: '',
    },
  ],
  snapshots: [
    { name: 'mongo-20260907-031701.archive.gz', kind: 'mongo', bytes: 66742833, mtime: now - 3600_000 },
    { name: 'redis-20260907-021628.rdb', kind: 'redis', bytes: 9639469, mtime: now - 1800_000 },
  ],
  volume: { totalBytes: 409600000000, usedBytes: 40960000000, availBytes: 368640000000, capturedAt: now - 1700_000 },
  control,
  history: { mongoError: '', redisError: '' },
  overall: 'failed',
});

describe('Backups.svelte — backups overview page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/backups')
        return Promise.resolve(overviewFixture({ available: true, error: '' }));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/backups/ircfiber-mongo-backup/run')
        return Promise.resolve({ job: 'ircfiber-mongo-backup-manual-1788751000' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
  });

  it('renders the failed job badge, its message and the snapshot rows', async () => {
    render(Backups);
    await vi.waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/admin/backups');
    });
    // Redis card shows the failed state …
    await expect.element(page.getByText('ircfiber-redis-backup')).toBeInTheDocument();
    // … the failed run's stage + message are rendered red …
    await expect.element(page.getByText(/connection refused on dump/)).toBeInTheDocument();
    // … and both snapshot rows are listed (the filename also appears in the
    // runs table, so scope by the Snapshots heading count + first match).
    await expect.element(page.getByText('Snapshots (2)')).toBeInTheDocument();
    await expect.element(page.getByText('mongo-20260907-031701.archive.gz').first()).toBeInTheDocument();
    await expect.element(page.getByText('redis-20260907-021628.rdb').first()).toBeInTheDocument();
  });

  it('Run now on the mongo card confirms then POSTs the mongo run path', async () => {
    render(Backups);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/backups'));
    // First Run now button = mongo card (jobs render in overview order).
    await page.getByRole('button', { name: 'Run now' }).first().click();
    // Confirm dialog names the job …
    await expect.element(page.getByText(/Run ircfiber-mongo-backup now/)).toBeInTheDocument();
    // … confirming (the dialog's Run now, last in DOM order) posts exactly the mongo path.
    await page.getByRole('button', { name: 'Run now' }).last().click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/admin/backups/ircfiber-mongo-backup/run');
    });
    expect(mockedToastOk).toHaveBeenCalled();
    expect(mockedToastErr).not.toHaveBeenCalled();
  });

  it('control unavailable shows the warning strip and disables both buttons', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/backups')
        return Promise.resolve(
          overviewFixture({ available: false, error: 'k3s rejected the gateway token' }));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(Backups);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/backups'));
    await expect.element(page.getByText(/Control plane unavailable/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Run now' }).first()).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Suspend' }).first()).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
