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
 *  9. Users with no NickServ account are listed and can be given one: the
 *     suggested nick can be overridden, and a free nick can be registered
 *     for a user straight from the manage card.
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
const UNPROVISIONED = '/api/admin/ircd/nickserv/unprovisioned';
const CREATE = '/api/admin/ircd/nickserv/create';

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

/// `dave` never got a credential; `eve`'s username yields no legal nick, so
/// the admin has to type one.
const unprovisionedFixture = () => ({
  users: [
    {
      userId: 'u-4', username: 'dave', email: 'dave@example.com',
      networkId: 'n-4', hasNetwork: true, networkDisabled: false,
      suggestedNick: 'dave', skipReason: '',
    },
    {
      userId: 'u-5', username: 'eve.smith', email: 'eve@example.com',
      networkId: '', hasNetwork: false, networkDisabled: false,
      suggestedNick: '', skipReason: 'username is not a valid IRC nickname',
    },
  ],
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

/// Scoped to the inventory table: the page also renders the
/// users-without-an-account table.
function bodyRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="ns-accounts-rows"] tr'),
  ) as HTMLElement[];
}

function unprovRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="ns-unprovisioned-rows"] tr'),
  ) as HTMLElement[];
}

describe('NickServPanel.svelte — NickServ account management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS) return Promise.resolve(accountsFixture());
      if (path === ACCOUNT) return Promise.resolve(infoFixture());
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
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
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
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
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
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
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
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
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
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

  // ── linking a website user to a NickServ account ──────────────────────────
  // The Website-user column is derived from the account's saslUsername, so
  // these are the only paths that can actually create or remove that join.

  /// `nsvictim` is registered on IRC but owned by nobody.
  const unlinkedInfo = () => ({
    ...infoFixture(),
    nick: 'nsvictim',
    account: 'nsvictim',
    fields: { Account: 'nsvictim' },
    platform: null,
  });

  const USERS = '/api/admin/users';

  function mockUnlinked() {
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS) return Promise.resolve(accountsFixture());
      if (path === ACCOUNT) return Promise.resolve(unlinkedInfo());
      if (path === USERS)
        return Promise.resolve({ users: [{ id: 'u-9', username: 'bob', email: 'bob@example.com' }] });
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
  }

  /// Looks up `nsvictim` by name rather than clicking the first Manage button,
  /// which is `alice` — the account the component acts on is the one it looked
  /// up, so the row and the fixture have to agree.
  async function openUnlinked() {
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByLabelText('Nickname to look up').fill('nsvictim');
    await page.getByRole('button', { name: 'Look up' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'nsvictim' }));
  }

  it('links with a supplied password and does not rotate it', async () => {
    mockUnlinked();
    mockedPost.mockResolvedValue({
      nick: 'nsvictim', userId: 'u-9', username: 'bob', networkId: 'n-9',
      passwordRotated: false, previousAccount: '', takenFrom: '',
    });
    await openUnlinked();

    await page.getByLabelText('Search users to link').fill('bob');
    await page.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(USERS, { q: 'bob' }));
    await page.getByLabelText('Existing NickServ password').fill('hunter2hunter2hunter2');
    await page.getByRole('button', { name: 'Link account' }).click();

    // A supplied password must be verified, never rewritten: no `confirm`.
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/nickserv/link', {
        nick: 'nsvictim', userId: 'u-9', password: 'hunter2hunter2hunter2',
      }),
    );
  });

  it('a blank password confirms first, then shows the generated one once', async () => {
    mockUnlinked();
    mockedPost.mockResolvedValue({
      nick: 'nsvictim', userId: 'u-9', username: 'bob', networkId: 'n-9',
      passwordRotated: true, password: 'GeneratedPw012345678901', previousAccount: '', takenFrom: '',
    });
    await openUnlinked();
    await page.getByLabelText('Search users to link').fill('bob');
    await page.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(USERS, { q: 'bob' }));

    await page.getByRole('button', { name: 'Link account' }).click();
    await expect.element(page.getByText('Link and generate a new password?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Generate and link' }).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/nickserv/link', {
        nick: 'nsvictim', userId: 'u-9', confirm: true,
      }),
    );
    const shown = await vi.waitFor(() => {
      const el = document.querySelector('input[aria-label="New NickServ password"]');
      expect(el).toBeTruthy();
      return el as HTMLInputElement;
    });
    expect(shown.value).toBe('GeneratedPw012345678901');
  });

  it('offers to move an account that another user already holds', async () => {
    mockUnlinked();
    mockedPost.mockRejectedValueOnce(
      new ApiError('"nsvictim" is already linked to carol. Unlink that user first, or pass force to move the account.', 409),
    );
    await openUnlinked();
    await page.getByLabelText('Search users to link').fill('bob');
    await page.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(USERS, { q: 'bob' }));
    await page.getByLabelText('Existing NickServ password').fill('hunter2hunter2hunter2');
    await page.getByRole('button', { name: 'Link account' }).click();

    await expect.element(page.getByText(/already linked to carol/)).toBeInTheDocument();
    mockedPost.mockResolvedValue({
      nick: 'nsvictim', userId: 'u-9', username: 'bob', networkId: 'n-9',
      passwordRotated: false, previousAccount: '', takenFrom: 'carol',
    });
    await page.getByRole('button', { name: 'Move the account anyway' }).click();
    await vi.waitFor(() => {
      const forced = mockedPost.mock.calls.find(
        (c) => typeof c[1] === 'object' && c[1] !== null && 'force' in c[1],
      );
      expect(forced?.[1]).toMatchObject({ nick: 'nsvictim', userId: 'u-9', force: true });
    });
  });

  it('unlink posts nothing until the dialog is confirmed', async () => {
    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByRole('button', { name: 'Manage' }).first().click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'alice' }));
    mockedPost.mockResolvedValue({ username: 'alice', autoProvisionParkedHours: 24 });

    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await expect.element(page.getByText('Unlink this account from the user?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Unlink' }).last().click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/ircd/nickserv/unlink', {
        nick: 'alice', confirm: true,
      }),
    );
  });

  // ── creating an account for a user who has none ────────────────────────────
  // The inventory can only show accounts that exist, so these rows are the
  // only view of the users nobody owns a nick for — the sync gap.

  it('lists users with no NickServ account and creates one with the suggested nick', async () => {
    mockedPost.mockResolvedValue({ nick: 'dave', username: 'dave' });
    render(NickServPanel);
    await vi.waitFor(() => expect(unprovRows().length).toBe(2));
    expect(unprovRows()[0].textContent).toContain('dave');

    const before = mockedGet.mock.calls.filter((c) => c[0] === UNPROVISIONED).length;
    await page.getByTestId('ns-create-u-4').click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(CREATE, { userId: 'u-4', nick: 'dave' }),
    );
    // The list and the inventory both change, so both are re-read.
    await vi.waitFor(() => {
      expect(mockedGet.mock.calls.filter((c) => c[0] === UNPROVISIONED).length).toBeGreaterThan(
        before,
      );
      expect(mockedGet.mock.calls.filter((c) => c[0] === ACCOUNTS).length).toBeGreaterThan(1);
    });
  });

  /// `eve.smith` has no legal derived nick: creating would fail without one,
  /// so the button stays disabled until the admin types a nickname.
  it('requires a typed nick when none can be derived, and posts what was typed', async () => {
    mockedPost.mockResolvedValue({ nick: 'eve', username: 'eve.smith' });
    render(NickServPanel);
    await vi.waitFor(() => expect(unprovRows().length).toBe(2));

    const create = document.querySelector('[data-testid="ns-create-u-5"]') as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    await page.getByLabelText('Nickname for eve.smith').fill('eve');
    await vi.waitFor(() => {
      const el = document.querySelector('[data-testid="ns-create-u-5"]') as HTMLButtonElement;
      expect(el.disabled).toBe(false);
    });
    await page.getByTestId('ns-create-u-5').click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(CREATE, { userId: 'u-5', nick: 'eve' }),
    );
  });

  it('registers a free nickname for a user from the manage card', async () => {
    const free = { ...infoFixture(), nick: 'newguy', registered: false, fields: {}, lines: [], platform: null };
    mockedGet.mockImplementation((path: string) => {
      if (path === ACCOUNTS) return Promise.resolve(accountsFixture());
      if (path === ACCOUNT) return Promise.resolve(free);
      if (path === UNPROVISIONED) return Promise.resolve(unprovisionedFixture());
      if (path === USERS)
        return Promise.resolve({ users: [{ id: 'u-9', username: 'bob', email: 'bob@example.com' }] });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockResolvedValue({ nick: 'newguy', username: 'bob' });

    render(NickServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    await page.getByLabelText('Nickname to look up').fill('newguy');
    await page.getByRole('button', { name: 'Look up' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(ACCOUNT, { nick: 'newguy' }));
    await expect.element(page.getByText('Not registered')).toBeInTheDocument();

    await page.getByLabelText('Search users to create for').fill('bob');
    await page.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(USERS, { q: 'bob' }));
    await page.getByTestId('ns-create-for-user').click();

    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(CREATE, { userId: 'u-9', nick: 'newguy' }),
    );
  });

  /// A nick somebody already owns must not read as "provisioning failed":
  /// the endpoint names the remedy and the panel shows it.
  it("surfaces the server's refusal instead of silently doing nothing", async () => {
    mockedPost.mockRejectedValue(
      new ApiError('"dave" is already registered. Link it to dave instead of creating an account.', 409),
    );
    render(NickServPanel);
    await vi.waitFor(() => expect(unprovRows().length).toBe(2));
    await page.getByTestId('ns-create-u-4').click();
    await expect.element(page.getByText(/already registered\. Link it to dave/)).toBeInTheDocument();
    expect(unprovRows().length).toBe(2);
  });
});
