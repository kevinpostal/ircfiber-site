/**
 * Servers.svelte — admin page that lists engines, host capacity, and
 * per-network assignments on every engine.
 *
 * This test guards the fix for the orphan-network delete gap: the main
 * #/servers page used to offer only "Disconnect / Reassign / Remove",
 * none of which actually removed a stale empty-string entry that lived
 * in the engine's assignedNetworks array (e.g. one that had survived a
 * code-path regression before any Mongo record existed for it). The fix
 * adds a "Delete" button backed by POST /api/admin/servers/assignments/
 * :networkId/delete, plus a ghost-row case for empty networkIds that
 * walks every server record and strips matching ids.
 *
 * Coverage:
 *  1. Renders a "Delete" button per assignment row.
 *  2. The Delete button calls POST /api/admin/servers/assignments/<id>/delete.
 *  3. Ghost rows (empty networkId) still render a Delete button so
 *     operators can scrub the orphan from the engine's server record.
 *  4. A second confirm is required (the operator must type the network
 *     label back) — a regression here would silently turn Delete into
 *     a one-click data-loss button.
 *  5. A failed delete surfaces the API error as a toast instead of
 *     silently swallowing it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Servers from './Servers.svelte';
import * as ui from '/src/admin/stores/ui';
import { api, ApiError } from '/src/admin/lib/api-client';

// `api.get` / `api.post` are the vi.fn() instances from the mock factory
// below. Cast through `unknown` because the static import sees the real
// generic type (Promise<T>) but the test runtime sees the vi.fn() value.
// vitest's hoisting of vi.mock above the import line makes this safe.
// Same pattern as src/admin/components/logs/LogsToolbar.svelte.test.ts.
const mockedGet       = api.get                       as unknown as ReturnType<typeof vi.fn>;
const mockedPost      = api.post                      as unknown as ReturnType<typeof vi.fn>;
const mockedToastOk   = ui.toastSuccess               as unknown as ReturnType<typeof vi.fn>;
const mockedToastErr  = ui.toastError                 as unknown as ReturnType<typeof vi.fn>;

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

vi.mock('/src/admin/stores/polling', () => ({
  // Always run the fetcher once immediately so the page renders data
  // without depending on the global pollingEnabled toggle (which would
  // otherwise leave the test fixture empty).
  startPolling: vi.fn((fetcher: () => unknown) => {
    void fetcher();
    return () => {};
  }),
}));

const baseFixture = (overrides: Partial<typeof fixture> = {}) => ({
  engines: [
    {
      serverId: 'ovh',
      bindAddress: '0.0.0.0',
      port: 8091,
      priority: 0,
      maxConnections: 0,
      fallbackOnly: false,
      assignedNetworks: [
        '8b508634-400d-4298-9d2b-6f27e1813272',
        'aacbda67-e965-4033-b7bc-d7a86ffe11cd',
      ],
      healthy: true,
      lastHeartbeat: 1784671020000,
      ageSeconds: 12,
    },
  ],
  hosts: [{ host: 'irc.ircfiber.com', totalConns: 2, serverIds: ['ovh'] }],
  assignments: [
    {
      networkId: '8b508634-400d-4298-9d2b-6f27e1813272',
      serverId: 'ovh',
      networkName: 'IRC Fiber',
      networkHost: 'irc.ircfiber.com',
      userId: 'b520ad9d-cc0c-4613-847f-5c114ee7443f',
      username: 'Zodiac',
      nick: 'Zodiac',
    },
    {
      networkId: 'aacbda67-e965-4033-b7bc-d7a86ffe11cd',
      serverId: 'ovh',
      networkName: 'IRC Fiber (faggy)',
      networkHost: 'irc.ircfiber.com',
      userId: '6094cdc3-e06b-4d6d-afd2-e8528ec162be',
      username: 'faggy',
      nick: 'faggy_6094',
    },
  ],
  maxConnsPerHost: 5,
  ...overrides,
});

describe('Servers.svelte — Delete button (orphan-network fix)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockResolvedValue(baseFixture());
    mockedPost.mockResolvedValue({ serverId: 'ovh', scrubbed: true });
  });

  it('renders a Delete button on every assignment row', async () => {
    render(Servers);
    // Wait for fetchData to resolve
    await vi.waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/admin/servers');
    });
    const deleteButtons = page.getByRole('button', { name: 'Delete' });
    await expect.element(deleteButtons.first()).toBeInTheDocument();
  });

  it('Delete button calls POST /api/admin/servers/assignments/delete/<id> with the network id', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('IRC Fiber');
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    const firstDelete = page.getByRole('button', { name: 'Delete' }).first();
    await firstDelete.click();

    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/api/admin/servers/assignments/delete?networkId=8b508634-400d-4298-9d2b-6f27e1813272',
        undefined
      );
    });
    confirmSpy.mockRestore();
    promptSpy.mockRestore();
  });

  it('does not call delete when the operator cancels the first confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const promptSpy = vi.spyOn(window, 'prompt');
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    const firstDelete = page.getByRole('button', { name: 'Delete' }).first();
    await firstDelete.click();

    expect(api.post).not.toHaveBeenCalled();
    expect(promptSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
    promptSpy.mockRestore();
  });

  it('does not call delete when the typed label does not match (typo protection)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('WRONG LABEL');
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    const firstDelete = page.getByRole('button', { name: 'Delete' }).first();
    await firstDelete.click();

    // The api.post delete endpoint should NOT have been called; the toast
    // should explain the abort. This guards against a one-click delete.
    const deleteCalls = mockedPost.mock.calls.filter(([url]) =>
      String(url).endsWith('/delete')
    );
    expect(deleteCalls).toHaveLength(0);
    expect(ui.toastError).toHaveBeenCalledWith(
      expect.stringContaining('label did not match')
    );
    confirmSpy.mockRestore();
    promptSpy.mockRestore();
  });

  it('surfaces API errors via toast instead of silently swallowing them', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('IRC Fiber');
    mockedPost.mockRejectedValueOnce(new ApiError('engine busy', 503));
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    const firstDelete = page.getByRole('button', { name: 'Delete' }).first();
    await firstDelete.click();

    await vi.waitFor(() => {
      expect(ui.toastError).toHaveBeenCalledWith(expect.stringContaining('engine busy'));
    });
    confirmSpy.mockRestore();
    promptSpy.mockRestore();
  });

  it('Delete button still renders for ghost rows (empty networkId) so operators can scrub orphans', async () => {
    // Simulate the live bug: the engine's assignedNetworks array has an
    // empty-string entry that surfaces in the SPA table as a row with
    // empty networkName / networkHost / userId.
    mockedGet.mockReset();
    mockedGet.mockResolvedValue(
      baseFixture({
        assignments: [
          {
            networkId: '',
            serverId: 'ovh',
            networkName: '',
            networkHost: '',
            userId: '',
            username: '',
            nick: '',
          },
          ...baseFixture().assignments,
        ],
      })
    );
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    // Give Svelte's reactive render a tick to flush the new data.
    await new Promise((r) => setTimeout(r, 50));

    const deleteButtons = page.getByRole('button', { name: 'Delete' });
    // 1 ghost row + 2 real assignments = 3 Delete buttons
    expect(deleteButtons.elements().length).toBeGreaterThanOrEqual(3);
  });

  it('ghost-row Delete uses a scrubbed-from-server-records prompt (no Mongo to delete)', async () => {
    mockedGet.mockResolvedValue(
      baseFixture({
        assignments: [
          {
            networkId: '',
            serverId: 'ovh',
            networkName: '(ghost row)',
            networkHost: '',
            userId: '',
            username: '',
            nick: '',
          },
        ],
      })
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('(ghost row)');
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());

    const firstDelete = page.getByRole('button', { name: 'Delete' }).first();
    await firstDelete.click();

    // The confirm copy should explain this is a server-record scrub, not
    // a Mongo delete — guards against confusion if the operator copies
    // the prompt text into a runbook.
    const confirmArgs = confirmSpy.mock.calls[0]?.[0] ?? '';
    expect(confirmArgs.toLowerCase()).toContain('scrub');
    expect(confirmArgs.toLowerCase()).toMatch(/ghost|orphan|server record/);

    // The API should still be called with the empty networkId so the
    // backend walks every server's assignedNetworks array and strips
    await vi.waitFor(() => {
      const calls = mockedPost.mock.calls.filter(([url]) =>
        String(url) === '/api/admin/servers/assignments/delete'
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe('/api/admin/servers/assignments/delete');
      expect(calls[0]?.[1]).toEqual({ networkId: '' });
    });
  });
});

describe('Servers.svelte — holder info (connection holder)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const holderEngine = {
    serverId: 'ovh',
    bindAddress: '0.0.0.0',
    port: 8091,
    priority: 0,
    maxConnections: 0,
    fallbackOnly: false,
    assignedNetworks: ['8b508634-400d-4298-9d2b-6f27e1813272'],
    healthy: true,
    lastHeartbeat: Date.now(),
    ageSeconds: 3,
    hotswapAt: 0,
    hotswapActive: false,
    holderVersion: '99608b9a6e9e',
    holderPid: 7,
    holderOpen: 18,
    holderAttached: 17,
    holderDetached: 1,
  };

  it('renders the holder build, pid and session counts for an engine', async () => {
    mockedGet.mockResolvedValue(baseFixture({ engines: [holderEngine] }));
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByText(/99608b9/)).toBeInTheDocument();
    await expect.element(page.getByText(/18 open \/ 17 attached/)).toBeInTheDocument();
    await expect.element(page.getByText(/1 detached/)).toBeInTheDocument();
  });

  it('shows a HOT SWAP badge while the engine is detached for a hot swap', async () => {
    mockedGet.mockResolvedValue(
      baseFixture({ engines: [{ ...holderEngine, hotswapActive: true, hotswapAt: Date.now() }] })
    );
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByText('HOT SWAP', { exact: true })).toBeInTheDocument();
  });

  it('renders a dash placeholder when the engine predates the holder', async () => {
    mockedGet.mockResolvedValue(baseFixture());
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByText('Holder: —')).toBeInTheDocument();
  });
});

describe('Servers.svelte — per-engine collapsible groups', () => {
  const hetiEngine = {
    serverId: 'heti',
    bindAddress: '0.0.0.0',
    port: 8092,
    priority: 5,
    maxConnections: 10,
    fallbackOnly: false,
    assignedNetworks: ['c9d1a2b3-0000-4000-8000-aaaaaaaaaaaa'],
    healthy: false,
    lastHeartbeat: 1784671020000,
    ageSeconds: 30,
  };
  const hetiAssignment = {
    networkId: 'c9d1a2b3-0000-4000-8000-aaaaaaaaaaaa',
    serverId: 'heti',
    networkName: 'Heti Net',
    networkHost: 'irc.example.org',
    userId: '11111111-2222-4333-8444-555555555555',
    username: 'hetiuser',
    nick: 'HetiNick',
  };
  const twoEngineFixture = () =>
    baseFixture({
      engines: [...baseFixture().engines, hetiEngine],
      assignments: [...baseFixture().assignments, hetiAssignment],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockedGet.mockResolvedValue(twoEngineFixture());
    mockedPost.mockResolvedValue({});
  });

  it('renders one toggle per engine with network counts in the header', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByTestId('server-group-toggle-ovh')).toBeInTheDocument();
    await expect.element(page.getByTestId('server-group-toggle-heti')).toBeInTheDocument();
    // ovh holds 2 networks with no engine cap; heti holds 1 of a 10-cap.
    await expect.element(page.getByText('2 networks · 2/∞ conns')).toBeInTheDocument();
    await expect.element(page.getByText('1 networks · 1/10 conns')).toBeInTheDocument();
  });

  it('opens the first healthy group by default and keeps the rest collapsed', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByTestId('server-group-body-ovh')).toBeInTheDocument();
    expect(page.getByTestId('server-group-body-heti').elements().length).toBe(0);
  });

  it('clicking a toggle hides/shows its body and flips aria-expanded', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    const toggle = page.getByTestId('server-group-toggle-heti').first();
    await expect.element(toggle).toBeInTheDocument();
    expect(document.querySelector('[data-testid="server-group-toggle-heti"]')?.getAttribute('aria-expanded')).toBe('false');

    await toggle.click();
    await expect.element(page.getByTestId('server-group-body-heti')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="server-group-toggle-heti"]')?.getAttribute('aria-expanded')).toBe('true');

    await toggle.click();
    expect(page.getByTestId('server-group-body-heti').elements().length).toBe(0);
    expect(document.querySelector('[data-testid="server-group-toggle-heti"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a collapsed engine\u2019s assignments out of the DOM (grouping proof)', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    // heti starts collapsed: its nick is nowhere in the document, while
    // the open ovh group's rows render.
    await expect.element(page.getByTestId('server-group-body-ovh')).toBeInTheDocument();
    expect(page.getByText('HetiNick').elements().length).toBe(0);
    await expect.element(page.getByText('faggy_6094')).toBeInTheDocument();

    // Expanding heti mounts its rows.
    await page.getByTestId('server-group-toggle-heti').first().click();
    await expect.element(page.getByText('HetiNick')).toBeInTheDocument();
  });

  it('Expand all / Collapse all flip every group and persist the fold state', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByTestId('server-group-body-ovh')).toBeInTheDocument();
    await page.getByTestId('servers-expand-all').click();
    await expect.element(page.getByTestId('server-group-body-heti')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('admin:servers:expanded') ?? '{}').heti).toBe(true);

    await page.getByTestId('servers-collapse-all').click();
    expect(page.getByTestId('server-group-body-ovh').elements().length).toBe(0);
    expect(page.getByTestId('server-group-body-heti').elements().length).toBe(0);
    await expect.element(page.getByText('0 of 2 open')).toBeInTheDocument();
  });

  it('renders orphan assignments in an Unassigned group instead of dropping them', async () => {
    mockedGet.mockResolvedValue(
      baseFixture({
        assignments: [
          ...baseFixture().assignments,
          {
            networkId: 'dddddddd-0000-4000-8000-aaaaaaaaaaaa',
            serverId: 'gone-engine',
            networkName: 'Orphan Net',
            networkHost: 'irc.example.org',
            userId: '',
            username: '',
            nick: '',
          },
        ],
      })
    );
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await expect.element(page.getByTestId('server-group-toggle-unassigned')).toBeInTheDocument();
    // Unassigned defaults closed — expanding reveals the orphan row.
    expect(page.getByText('Orphan Net').elements().length).toBe(0);
    await page.getByTestId('server-group-toggle-unassigned').first().click();
    await expect.element(page.getByText('Orphan Net')).toBeInTheDocument();
  });
});

describe('Servers.svelte — group by IRC network + pagination', () => {
  const hetiEngine = {
    serverId: 'heti',
    bindAddress: '0.0.0.0',
    port: 8092,
    priority: 5,
    maxConnections: 10,
    fallbackOnly: false,
    assignedNetworks: ['c9d1a2b3-0000-4000-8000-aaaaaaaaaaaa'],
    healthy: false,
    lastHeartbeat: 1784671020000,
    ageSeconds: 30,
  };
  const hetiAssignment = {
    networkId: 'c9d1a2b3-0000-4000-8000-aaaaaaaaaaaa',
    serverId: 'heti',
    networkName: 'Heti Net',
    networkHost: 'irc.example.org',
    userId: '11111111-2222-4333-8444-555555555555',
    username: 'hetiuser',
    nick: 'HetiNick',
  };
  const twoEngineFixture = () =>
    baseFixture({
      engines: [...baseFixture().engines, hetiEngine],
      assignments: [...baseFixture().assignments, hetiAssignment],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockedGet.mockResolvedValue(twoEngineFixture());
    mockedPost.mockResolvedValue({});
  });

  it('switching to Network view groups connections by IRC host', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await page.getByTestId('servers-groupby-network').click();

    // Engine toggles are gone; host groups take their place.
    expect(page.getByTestId('server-group-toggle-ovh').elements().length).toBe(0);
    await expect.element(page.getByTestId('server-group-toggle-net:irc.ircfiber.com')).toBeInTheDocument();
    await expect.element(page.getByTestId('server-group-toggle-net:irc.example.org')).toBeInTheDocument();
    // First host group (irc.example.org sorts first) opens by default.
    await expect.element(page.getByText('HetiNick')).toBeInTheDocument();
    await page.getByTestId('servers-expand-all').click();
    await expect.element(page.getByText('faggy_6094')).toBeInTheDocument();
    expect(localStorage.getItem('admin:servers:groupBy')).toBe('network');
  });

  it('network view shows the owning engine per row across engines', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    await page.getByTestId('servers-groupby-network').click();
    await page.getByTestId('servers-expand-all').click();

    // heti row carries its engine badge; ovh rows carry theirs.
    await expect.element(page.getByText('HetiNick')).toBeInTheDocument();
    await expect.element(page.getByText('faggy_6094')).toBeInTheDocument();
    await expect.element(page.getByText('1 networks · on heti')).toBeInTheDocument();
    await expect.element(page.getByText('2 networks · on ovh')).toBeInTheDocument();
  });

  it('paginates an engine group past 25 connections', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      networkId: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
      serverId: 'ovh',
      networkName: `Bulk ${i}`,
      networkHost: 'irc.ircfiber.com',
      userId: '',
      username: '',
      nick: `bulk-nick-${String(i).padStart(2, '0')}`,
    }));
    mockedGet.mockResolvedValue(
      baseFixture({
        engines: [{ ...baseFixture().engines[0], assignedNetworks: many.map((m) => m.networkId) }],
        assignments: many,
      })
    );
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));

    await expect.element(page.getByText('Page 1 of 2 · 30 connections')).toBeInTheDocument();
    await expect.element(page.getByText('bulk-nick-00')).toBeInTheDocument();
    expect(page.getByText('bulk-nick-29').elements().length).toBe(0);

    await page.getByTestId('servers-page-next-ovh').click();
    await expect.element(page.getByText('Page 2 of 2 · 30 connections')).toBeInTheDocument();
    await expect.element(page.getByText('bulk-nick-29')).toBeInTheDocument();
    expect(page.getByText('bulk-nick-00').elements().length).toBe(0);

    await page.getByTestId('servers-page-prev-ovh').click();
    await expect.element(page.getByText('bulk-nick-00')).toBeInTheDocument();
  });

  it('does not render a pager for small groups', async () => {
    render(Servers);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/servers'));
    expect(page.getByTestId('servers-page-next-ovh').elements().length).toBe(0);
    expect(page.getByTestId('servers-page-label-ovh').elements().length).toBe(0);
  });
});
