/**
 * NickServPanel.svelte — Anope account management (IRCD page → NickServ).
 *
 * Coverage:
 *  1. The Accounts table renders the inventory, including an account with no
 *     website owner (the case a Mongo-only list would miss).
 *  2. The filter narrows the rendered rows client-side — no extra request.
 *  3. `available: false` explains itself and still lists the Mongo-only rows.
 *  4. A lookup renders the live INFO fields.
 *  5. Suspend posts {nick, reason, expiry} and re-runs the lookup.
 *  6. Drop posts nothing until the confirm dialog is confirmed.
 *  7. Anope's 403 refusal is rendered in the manage card.
 *  8. Provisioning faults (orphan pending credentials, users with no
 *     credential) are called out; a healthy provisioner raises no alarm; an
 *     unreadable count reads "unknown" rather than a reassuring zero.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import NickServPanel from './NickServPanel.svelte';
import { api, ApiError } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;
const mockedPost = api.post as unknown as ReturnType<typeof vi.fn>;

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
}));

const ACCOUNTS = '/api/admin/ircd/nickserv/accounts';
const ACCOUNT = '/api/admin/ircd/nickserv/account';

const nsAccount = (over: Record<string, unknown> = {}) => ({
  nick: 'alice',
  account: 'alice',
  email: 'alice@example.com',
  registeredAt: 1788600000,
  lastSeenAt: 1788680000,
  lastUsermask: 'alice@host',
  lastRealName: 'Alice',
  suspended: false,
  suspendedBy: '',
  suspendReason: '',
  suspendedAt: 0,
  suspendExpiresAt: 0,
  userId: 'u-1',
  username: 'alice',
  userEmail: 'alice@example.com',
  networkId: 'n-1',
  networkNick: 'alice',
  networkDisabled: false,
  ...over,
});

/// A healthy provisioner: nothing pending, nobody without a credential.
const provisioningFixture = (over: Record<string, unknown> = {}) => ({
  outcomes: {
    disabled: 0,
    skipped: 0,
    alreadyProvisioned: 4,
    registered: 12,
    nickUnavailable: 0,
    deferred: 0,
    collisionExhausted: 0,
    failed: 0,
  },
  lastOutcome: 'registered',
  lastOutcomeAt: 1788681000,
  pendingOrphans: 0,
  skipMarkers: 0,
  unprovisioned: 0,
  ...over,
});

/// `nsvictim` was registered on IRC only: no website user, no network.
const accountsFixture = () => ({
  available: true,
  reason: '',
  asOf: 1788681000,
  accounts: [
    nsAccount(),
    nsAccount({
      nick: 'nsvictim',
      account: 'nsvictim',
      email: '',
      userId: '',
      username: '',
      userEmail: '',
      networkId: '',
      networkNick: '',
    }),
  ],
  provisioning: provisioningFixture(),
});

const infoFixture = () => ({
  nick: 'alice',
  registered: true,
  account: 'alice',
  realName: 'alice',
  fields: {
    Account: 'alice',
    'Email address': 'info@example.com',
    Registered: 'Sep 06 08:54:09 2026 UTC (now)',
  },
  lines: ['alice is alice', '          Account: alice'],
  platform: { userId: 'u-1', username: 'alice', networkId: 'n-1' },
});

function bodyRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[];
}

describe('NickServPanel.svelte — NickServ account management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS) return Promise.resolve(accountsFixture());
      if (path === ACCOUNT) return Promise.resolve(infoFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockResolvedValue({});
  });

  it('lists the inventory, including an account with no website user', async () => {
    render(NickServPanel);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNTS));
    await expect.element(page.getByText('nsvictim').first()).toBeInTheDocument();

    const victim = bodyRows().find((r) => r.textContent?.includes('nsvictim'));
    expect(victim).toBeTruthy();
    // Column 3 is "Website user": an IRC-only account has none.
    expect(victim!.children[2].textContent?.trim()).toBe('—');
    const owned = bodyRows().find((r) => r.textContent?.includes('alice'));
    expect(owned!.children[2].textContent?.trim()).toBe('alice');
  });

  it('filters client-side without issuing another request', async () => {
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    const before = mockedGet.mock.calls.length;

    await page.getByLabelText('Filter NickServ accounts').fill('victim');
    await vi.waitFor(() => expect(bodyRows().length).toBe(1));
    expect(bodyRows()[0].textContent).toContain('nsvictim');
    expect(mockedGet.mock.calls.length).toBe(before);
  });

  it('explains an unavailable inventory and still lists the IRC Fiber rows', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS)
        return Promise.resolve({
          available: false,
          reason: 'anope.db not found at /nonexistent/anope.db',
          asOf: 0,
          accounts: [nsAccount({ nick: 'nsplat', account: 'nsplat', username: 'platuser' })],
        });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(NickServPanel);
    await expect
      .element(page.getByText(/anope\.db not found at \/nonexistent\/anope\.db/))
      .toBeInTheDocument();
    await expect.element(page.getByText(/Showing IRC Fiber accounts only/)).toBeInTheDocument();
    await vi.waitFor(() => expect(bodyRows().length).toBe(1));
    expect(bodyRows()[0].textContent).toContain('nsplat');
  });

  it('a lookup renders the live INFO fields', async () => {
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByRole('button', { name: 'Manage' }).first().click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'alice' }));
    await expect.element(page.getByText('Email address')).toBeInTheDocument();
    await expect.element(page.getByText('info@example.com')).toBeInTheDocument();
  });

  it('Suspend posts the reason and expiry, then re-runs the lookup', async () => {
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByRole('button', { name: 'Manage' }).first().click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'alice' }));

    // Substring name matching would also hit "Unsuspend".
    await page.getByRole('button', { name: 'Suspend', exact: true }).click();
    await page.getByLabelText('Suspend reason').fill('abuse test');
    await page.getByLabelText('Suspend expiry').fill('30d');
    await page.getByRole('button', { name: 'Suspend account' }).click();

    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/nickserv/suspend', {
        nick: 'alice',
        reason: 'abuse test',
        expiry: '30d',
      }),
    );
    // The table is up to five minutes stale, so both views must refresh.
    await vi.waitFor(() => {
      const lookups = mockedGet.mock.calls.filter((c) => c[0] === ACCOUNT);
      expect(lookups.length).toBeGreaterThan(1);
    });
  });

  it('Drop posts nothing until the confirm dialog is confirmed', async () => {
    mockedPost.mockResolvedValue({ nick: 'alice', dropped: true, reprovisioning: true });
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByRole('button', { name: 'Manage' }).first().click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'alice' }));

    await page.getByRole('button', { name: 'Drop', exact: true }).click();
    await expect.element(page.getByText('Drop this NickServ account?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Drop account' }).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/nickserv/drop', {
        nick: 'alice',
        confirm: true,
      }),
    );
  });

  it("renders Anope's privilege refusal in the manage card", async () => {
    const refusal =
      'Anope refused the command: the services oper account "nsvictim" has no privileges.';
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS) return Promise.resolve(accountsFixture());
      if (path === ACCOUNT) return Promise.reject(new ApiError(refusal, 403));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByRole('button', { name: 'Manage' }).first().click();
    await expect.element(page.getByText(new RegExp('has no privileges'))).toBeInTheDocument();
  });

  /// The regression this panel exists for: prod had ten users with no
  /// credential and one orphan pending record, and every log looked quiet.
  it('calls out orphan pending credentials and unprovisioned users', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS)
        return Promise.resolve({
          ...accountsFixture(),
          provisioning: provisioningFixture({
            outcomes: { registered: 0, failed: 23 },
            lastOutcome: 'failed',
            pendingOrphans: 1,
            unprovisioned: 10,
          }),
        });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(NickServPanel);

    const orphans = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="ns-pending-orphans"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(orphans.textContent?.trim()).toBe('1');
    expect(orphans.className).toContain('text-danger');
    await expect.element(page.getByText(/orphan pending credentials/)).toBeInTheDocument();

    const unprovisioned = document.querySelector('[data-testid="ns-unprovisioned"]') as HTMLElement;
    expect(unprovisioned.textContent?.trim()).toBe('10');
    expect(unprovisioned.className).toContain('text-amber-500');

    // A total would not say what went wrong; the failing outcome is named.
    await expect.element(page.getByText(/failed 23/)).toBeInTheDocument();
    await expect.element(page.getByText(/Last attempt/)).toBeInTheDocument();
  });

  it('raises no alarm when provisioning is healthy', async () => {
    render(NickServPanel);

    const orphans = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="ns-pending-orphans"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(orphans.textContent?.trim()).toBe('0');
    expect(orphans.className).not.toContain('text-danger');

    const unprovisioned = document.querySelector('[data-testid="ns-unprovisioned"]') as HTMLElement;
    expect(unprovisioned.textContent?.trim()).toBe('0');
    expect(unprovisioned.className).not.toContain('text-amber-500');
    await expect.element(page.getByText(/registered 12/)).toBeInTheDocument();
  });

  /// -1 means the gateway could not read Redis or Mongo. Rendering that as
  /// "0" would be a false all-clear.
  it('renders an unreadable count as unknown, not zero', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS)
        return Promise.resolve({
          ...accountsFixture(),
          provisioning: provisioningFixture({ pendingOrphans: -1, unprovisioned: -1 }),
        });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(NickServPanel);

    const orphans = await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="ns-pending-orphans"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(orphans.textContent?.trim()).toBe('unknown');
    expect(orphans.className).not.toContain('text-danger');
  });
});
