/**
 * System.svelte — admin System page (host metrics + Docker containers).
 *
 * Coverage:
 *  1. Full snapshot: the CPU / Memory / Disk KPI values render and the
 *     container table has exactly one row per container.
 *  2. available:false renders the collector's reason and no filesystem
 *     table (the macOS-dev / mounts-not-deployed path).
 *  3. The gateway's own row has Stop/Restart disabled; a normal
 *     ircfiber-redis row has them enabled.
 *  4. Confirming Restart on ircfiber-redis POSTs exactly
 *     /api/admin/system/containers/ircfiber-redis/restart.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import System from './System.svelte';
import * as ui from '/src/admin/stores/ui';
import { api } from '/src/admin/lib/api-client';

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
  // RefreshIndicator reads this one; a vi.fn() alone breaks Svelte's
  // store contract (it must return an unsubscriber).
  pollingEnabled: {
    subscribe: (run: (v: boolean) => void) => {
      run(true);
      return () => {};
    },
    update: vi.fn(),
  },
}));

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => {
    void fetcher();
    return () => {};
  }),
}));

const now = Date.now();

const snapshotFixture = (over: Record<string, unknown> = {}) => ({
  available: true,
  reason: '',
  collectedAtMs: now,
  statsSource: 'cgroup2',
  dockerError: '',
  networkSource: 'host',
  host: {
    hostname: 'vps-efb4b52d', kernel: '7.0.0-31-generic', os: 'Ubuntu 22.04.5 LTS',
    ncpu: 4, uptimeSeconds: 486_000, dockerVersion: '29.7.2',
    containersRunning: 2, containersTotal: 3, images: 24,
  },
  cpu: {
    percent: 12.4, userPercent: 6.1, systemPercent: 3.0, iowaitPercent: 0.4,
    stealPercent: 0.1, load1: 0.31, load5: 0.42, load15: 0.47, load1PerCpu: 0.0775,
    procsRunnable: 1, procsTotal: 785,
  },
  memory: {
    totalBytes: 8_122_298_368, usedBytes: 1_860_485_120, availableBytes: 6_261_813_248,
    percent: 22.9, swapTotalBytes: 0, swapUsedBytes: 0, swapPercent: 0,
  },
  filesystems: [
    {
      device: '/dev/sda1', mountPoint: '/', fsType: 'ext4',
      totalBytes: 82_531_053_568, usedBytes: 50_344_038_400,
      freeBytes: 28_000_000_000, percent: 61.0,
    },
    {
      device: '/dev/sda15', mountPoint: '/boot/efi', fsType: 'vfat',
      totalBytes: 109_051_904, usedBytes: 6_291_456, freeBytes: 102_760_448, percent: 5.8,
    },
  ],
  network: [
    {
      name: 'ens3', rxBytes: 277_067_228, txBytes: 569_286_456,
      rxBytesPerSec: 12_345, txBytesPerSec: 23_456,
      rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0,
    },
  ],
  disks: [
    { name: 'sda', readBytesPerSec: 0, writeBytesPerSec: 98_304, readsPerSec: 0, writesPerSec: 4.2 },
  ],
  containers: [
    {
      id: '5586bbedf4e5', name: 'ircfiber-gateway', image: 'ircfiber/gateway:2026.09.13-abc1234',
      state: 'running', status: 'Up 2 hours (healthy)', health: 'healthy',
      createdAtMs: now - 7_200_000, ports: ['0.0.0.0:8090→8090/tcp'],
      cpuPercent: 3.4, memBytes: 268_435_456, memLimitBytes: 1_073_741_824,
      memPercent: 25.0, pids: 42,
      self: true, controllable: false, controlReason: 'this gateway container',
    },
    {
      id: '044f1a1fb346', name: 'ircfiber-redis', image: 'redis:7-alpine',
      state: 'running', status: 'Up 3 days', health: '',
      createdAtMs: now - 259_200_000, ports: ['6379/tcp'],
      cpuPercent: 0.9, memBytes: 103_325_696, memLimitBytes: -1,
      memPercent: 1.3, pids: 6,
      self: false, controllable: true, controlReason: '',
    },
    {
      id: 'aa11bb22cc33', name: 'tailscale-mullvad-ch', image: 'tailscale/tailscale:stable',
      state: 'exited', status: 'Exited (0) 2 days ago', health: '',
      createdAtMs: now - 500_000_000, ports: [],
      cpuPercent: null, memBytes: null, memLimitBytes: -1,
      memPercent: null, pids: null,
      self: false, controllable: true, controlReason: '',
    },
  ],
  history: [
    { atMs: now - 10_000, cpuPercent: 10.0, memPercent: 22.0, rxBytesPerSec: 10_000, txBytesPerSec: 20_000 },
    { atMs: now - 5_000, cpuPercent: 11.5, memPercent: 22.5, rxBytesPerSec: 11_000, txBytesPerSec: 21_000 },
    { atMs: now, cpuPercent: 12.4, memPercent: 22.9, rxBytesPerSec: 12_345, txBytesPerSec: 23_456 },
  ],
  ...over,
});

describe('System.svelte — host metrics + container control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/system') return Promise.resolve(snapshotFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/system/containers/ircfiber-redis/restart')
        return Promise.resolve({ name: 'ircfiber-redis', action: 'restart', ok: true });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
  });

  it('renders the CPU/Memory/Disk KPIs and one row per container', async () => {
    render(System);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/system'));

    // CPU KPI rounds to whole percent, with the load/vCPU hint (the Trend
    // card labels the same value, hence .first()) …
    await expect.element(page.getByText('12%', { exact: true }).first()).toBeInTheDocument();
    await expect.element(page.getByText('load 0.31 · 4 vCPU')).toBeInTheDocument();
    // … memory shows used / total …
    await expect.element(page.getByText('1.73 GB / 7.56 GB')).toBeInTheDocument();
    // … and the root filesystem drives the Disk KPI.
    await expect.element(page.getByText('61.0%', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('26.08 GB free')).toBeInTheDocument();

    // One table row per container in the snapshot.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="container-row"]').length).toBe(3);
    });
    // A container without cgroup stats renders em dashes, not zeroes.
    await expect.element(page.getByText('tailscale-mullvad-ch')).toBeInTheDocument();
  });

  it('unavailable host metrics render the reason and no filesystem table', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/system')
        return Promise.resolve(snapshotFixture({
          available: false,
          reason: 'host /proc is not mounted into this container '
            + '(see site/deploy/roles/gateway/tasks/container.yml)',
          filesystems: [],
          containers: [],
        }));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(System);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/system'));
    await expect.element(page.getByText(/host \/proc is not mounted/)).toBeInTheDocument();
    expect(document.querySelector('[data-testid="filesystems-table"]')).toBeNull();
    expect(document.querySelector('[data-testid="containers-table"]')).toBeNull();
  });

  it('disables Stop/Restart on the gateway itself but not on ircfiber-redis', async () => {
    render(System);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="container-row"]').length).toBe(3);
    });
    await expect.element(page.getByRole('button', { name: 'Stop ircfiber-gateway' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Restart ircfiber-gateway' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Stop ircfiber-redis' })).toBeEnabled();
    await expect.element(page.getByRole('button', { name: 'Restart ircfiber-redis' })).toBeEnabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('confirming Restart on ircfiber-redis posts exactly that container path', async () => {
    render(System);
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="container-row"]').length).toBe(3);
    });
    await page.getByRole('button', { name: 'Restart ircfiber-redis' }).click();
    // Redis is load-bearing, so the dialog demands the name typed out.
    await expect.element(page.getByText(/is load-bearing/)).toBeInTheDocument();
    await page.getByRole('textbox', { name: 'Type to confirm' }).fill('ircfiber-redis');
    // The dialog's own button is the one whose accessible name is just "Restart".
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/admin/system/containers/ircfiber-redis/restart');
    });
    expect(mockedToastOk).toHaveBeenCalled();
    expect(mockedToastErr).not.toHaveBeenCalled();
  });
});
