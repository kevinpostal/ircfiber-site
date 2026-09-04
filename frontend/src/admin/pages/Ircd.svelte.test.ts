/**
 * Ircd.svelte — admin IRCD management page.
 *
 * Coverage:
 *  1. Overview tab renders server KPIs from GET /api/admin/ircd/status.
 *  2. Rehash button confirms, then POSTs /api/admin/ircd/rehash.
 *  3. Cancelling the confirm skips the POST.
 *  4. Channels tab lists channels from GET /api/admin/ircd/channels.
 *  5. Logs tab queries the SigNoz proxy filtered to the ircd services.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Ircd from './Ircd.svelte';
import * as ui from '/src/admin/stores/ui';
import { api, ApiError } from '/src/admin/lib/api-client';
import { queryRange as signozQueryRange } from '/src/lib/signoz';

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
  pollingEnabled: { subscribe: vi.fn() },
}));

vi.mock('/src/lib/signoz', () => ({
  queryRange: vi.fn(),
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const mockedQueryRange = signozQueryRange as unknown as ReturnType<typeof vi.fn>;

const logsFixture = () => ({
  status: 'success',
  data: {
    A: {
      queryName: 'A',
      list: [
        {
          timestamp_nano: 1756947655000000000,
          service_name: 'ircfiber-ircd',
          severity_text: 'INFO',
          body: 'LINK: Connection to irc.netcrave.chat started',
        },
      ],
    },
  },
});

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => {
    void fetcher();
    return () => {};
  }),
}));

const statusFixture = () => ({
  server: 'irc.ircfiber.com',
  version: 'InspIRCd-4',
  versionComment: 'IRC Fiber',
  uptime: 'Server up 3 days, 01:02:03',
  maxConnections: 'Highest connection count: 12 (12 clients)',
  users: {
    users: 10, invisible: 0, opers: 1, unknown: 0, channels: 2,
    local: 10, localMax: 64, global: 10, globalMax: 64,
  },
  motd: ['Welcome to IRC Fiber'],
});

const channelsFixture = () => ({
  channels: [
    { name: '#ircfiber', users: 7, modes: 'nt', topic: 'Welcome' },
    { name: '#welcome', users: 3, modes: 'nt', topic: '' },
  ],
});

const bansFixture = () => ({ glines: [], klines: [], zlines: [] });

describe('Ircd.svelte — IRCD management page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/ircd/status') return Promise.resolve(statusFixture());
      if (path === '/api/admin/ircd/channels') return Promise.resolve(channelsFixture());
      if (path === '/api/admin/ircd/bans') return Promise.resolve(bansFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockResolvedValue({ rehashed: 'inspircd.conf' });
  });

  it('renders overview KPIs from the status endpoint', async () => {
    render(Ircd);
    await vi.waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/status');
    });
    await expect.element(page.getByText('irc.ircfiber.com')).toBeInTheDocument();
  });

  it('Rehash confirms then POSTs /api/admin/ircd/rehash', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(Ircd);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/status'));
    await page.getByRole('button', { name: 'Rehash' }).first().click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/rehash');
    });
    expect(mockedToastOk).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('cancelling the rehash confirm skips the POST', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(Ircd);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/status'));
    await page.getByRole('button', { name: 'Rehash' }).first().click();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.post).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Channels tab lists channels from the channels endpoint', async () => {
    render(Ircd);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/status'));
    await page.getByRole('button', { name: /Channels/ }).first().click();
    await vi.waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/channels');
    });
    await expect.element(page.getByText('#ircfiber')).toBeInTheDocument();
  });

  it('Logs tab queries SigNoz filtered to the ircd services', async () => {
    mockedQueryRange.mockResolvedValue(logsFixture());
    render(Ircd);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/ircd/status'));
    await page.getByRole('button', { name: 'Logs' }).first().click();
    await vi.waitFor(() => expect(mockedQueryRange).toHaveBeenCalled());
    const body = mockedQueryRange.mock.calls[0][0] as {
      compositeQuery: { queries: { spec: { filter: { expression: string } } }[] };
    };
    const expr = body.compositeQuery.queries[0].spec.filter.expression;
    expect(expr).toContain(`service.name IN ('ircfiber-ircd','ircfiber-services')`);
    await expect.element(page.getByText(/Connection to irc\.netcrave\.chat started/)).toBeInTheDocument();
  });
});
