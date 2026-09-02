/**
 * Bouncer.svelte — admin page for attached third-party IRC clients and
 * the networks that have a bouncer password.
 *
 * Coverage:
 *  1. Renders one row per attached client and per account from /api/admin/bnc.
 *  2. Kick posts to /api/admin/bnc/clients/<sid>/kick after confirm, and
 *     not at all when the operator cancels.
 *  3. Revoke posts to /api/admin/bnc/networks/<id>/revoke.
 *  4. API failures surface as an error toast.
 *  5. Empty states render when nothing is attached / no passwords exist.
 */
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Bouncer from './Bouncer.svelte';
import * as ui from '/src/admin/stores/ui';
import { api, ApiError } from '/src/admin/lib/api-client';

const mockedGet  = api.get  as unknown as Mock;
const mockedPost = api.post as unknown as Mock;

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
  // RefreshIndicator subscribes via `$pollingEnabled`; a real store shape
  // keeps Svelte's auto-subscription happy.
  pollingEnabled: { subscribe: (run: (v: boolean) => void) => { run(true); return () => {}; }, set: vi.fn(), update: vi.fn() },
}));

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => { void fetcher(); return () => {}; }),
}));

const NET = 'c737654e-75a6-4012-90ff-9d19eedbe533';
const USER = 'b520ad9d-cc0c-4613-847f-5c114ee7443f';

const fixture = () => ({
  listener: { enabled: true, host: 'bnc.ircfiber.com', port: 7000, tls: true },
  stats: { attachedClients: 2, accounts: 1, usersOnline: 1, seenCursors: 1, serverTime: Date.now() },
  clients: [
    {
      sid: 'a1b2c3d4', userId: USER, username: 'zodiac', networkId: NET, networkName: 'IRC Fiber',
      clientId: 'laptop', nick: 'zodiac', peer: '203.0.113.9:51234', tls: true,
      caps: 'server-time,batch', attachedAt: Date.now() - 60_000, lastRecvMs: Date.now() - 2_000,
      lastSendMs: Date.now() - 1_000, cursor: 4242, linesIn: 12, linesOut: 340, presenceTtl: 55,
    },
    {
      sid: 'e5f6a7b8', userId: USER, username: 'zodiac', networkId: NET, networkName: 'IRC Fiber',
      clientId: '', nick: 'zodiac', peer: '198.51.100.4:40001', tls: true,
      caps: '', attachedAt: Date.now() - 5_000, lastRecvMs: Date.now() - 500,
      lastSendMs: Date.now() - 500, cursor: 4242, linesIn: 3, linesOut: 40, presenceTtl: 58,
    },
  ],
  accounts: [
    {
      networkId: NET, networkName: 'IRC Fiber', host: 'irc.ircfiber.com', nick: 'zodiac', disabled: false,
      userId: USER, username: 'zodiac', attached: 2,
      seen: [{ clientId: 'laptop', cursor: 4242, online: true }],
    },
  ],
});

describe('Bouncer.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockResolvedValue(fixture());
    mockedPost.mockResolvedValue({ ok: true });
  });

  it('renders attached clients and accounts from /api/admin/bnc', async () => {
    render(Bouncer);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/bnc'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="bnc-client-row"]').length).toBe(2);
      expect(document.querySelectorAll('[data-testid="bnc-account-row"]').length).toBe(1);
    });
    expect(document.body.textContent).toContain('laptop');
    expect(document.body.textContent).toContain('anonymous');
    expect(document.body.textContent).toContain('bnc.ircfiber.com · TLS');
  });

  it('Kick posts to /api/admin/bnc/clients/<sid>/kick after confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(Bouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-client-row"]').length).toBe(2));
    await page.getByRole('button', { name: 'Kick' }).first().click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/api/admin/bnc/clients/a1b2c3d4/kick', { reason: 'Disconnected by administrator' });
    });
    expect(ui.toastSuccess).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('does nothing when the operator cancels the kick confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(Bouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-client-row"]').length).toBe(2));
    await page.getByRole('button', { name: 'Kick' }).first().click();
    expect(api.post).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Revoke posts to /api/admin/bnc/networks/<id>/revoke', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(Bouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-account-row"]').length).toBe(1));
    await page.getByRole('button', { name: 'Revoke' }).click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(`/api/admin/bnc/networks/${NET}/revoke`);
    });
    confirmSpy.mockRestore();
  });

  it('surfaces API errors as an error toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockedPost.mockRejectedValueOnce(new ApiError('client gone', 404));
    render(Bouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-client-row"]').length).toBe(2));
    await page.getByRole('button', { name: 'Kick' }).first().click();
    await vi.waitFor(() => expect(ui.toastError).toHaveBeenCalledWith(expect.stringContaining('client gone')));
    confirmSpy.mockRestore();
  });

  it('renders empty states when nothing is attached and no passwords exist', async () => {
    mockedGet.mockResolvedValue({ ...fixture(), stats: { attachedClients: 0, accounts: 0, usersOnline: 0, seenCursors: 0, serverTime: 0 }, clients: [], accounts: [] });
    render(Bouncer);
    await vi.waitFor(() => expect(document.body.textContent).toContain('No clients attached'));
    expect(document.body.textContent).toContain('No bouncer passwords');
  });
});
