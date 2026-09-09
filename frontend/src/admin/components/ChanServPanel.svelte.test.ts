/**
 * ChanServPanel.svelte — Anope channel management (IRCD page → ChanServ).
 *
 * Coverage:
 *  1. The Channels table renders the inventory and links the founder's
 *     website user, with '—' for a channel nobody on the site owns.
 *  2. The filter narrows the rendered rows client-side — no extra request.
 *  3. `available: false` explains itself.
 *  4. Manage fetches the live INFO and renders its fields and access rows.
 *  5. Suspend posts {channel, reason, expiry} and re-runs the lookup.
 *  6. Drop posts nothing until the confirm dialog is confirmed, then once.
 *  7. Access can be added and a listed entry removed.
 *  8. Register posts the channel, description and founder.
 *  9. A 409 from register is rendered instead of failing silently.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import ChanServPanel from './ChanServPanel.svelte';
import { api, ApiError } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as Mock;
const mockedPost = api.post as unknown as Mock;

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

const CHANNELS = '/api/admin/ircd/chanserv/channels';
const CHANNEL = '/api/admin/ircd/chanserv/channel';
const SUSPEND = '/api/admin/ircd/chanserv/suspend';
const DROP = '/api/admin/ircd/chanserv/drop';
const ACCESS = '/api/admin/ircd/chanserv/access';
const ACCESS_DEL = '/api/admin/ircd/chanserv/access/delete';
const REGISTER = '/api/admin/ircd/chanserv/register';

const csChannel = (over: Record<string, unknown> = {}) => ({
  name: '#staff',
  founder: 'Zodiac',
  successor: '',
  description: 'IRC Fiber staff log feed',
  registeredAt: 1788491709,
  lastUsedAt: 1788855122,
  lastTopic: 'IRC Fiber operations log',
  lastTopicSetter: 'admin',
  lastTopicAt: 1788676622,
  bot: 'ChanServ',
  accessCount: 2,
  noExpire: true,
  isPrivate: false,
  persistent: true,
  suspended: false,
  suspendedBy: '',
  suspendReason: '',
  suspendedAt: 0,
  suspendExpiresAt: 0,
  founderUserId: 'u-1',
  founderUsername: 'zodiac',
  founderNetworkId: 'n-1',
  ...over,
});

/// `#dmz` was registered on IRC only: its founder is no website user.
const channelsFixture = () => ({
  available: true,
  reason: '',
  asOf: 1788681000,
  suspendedCount: 0,
  channels: [
    csChannel(),
    csChannel({
      name: '#dmz',
      founder: 'sq',
      description: 'the land where roarie comes from',
      accessCount: 0,
      noExpire: false,
      persistent: false,
      founderUserId: '',
      founderUsername: '',
      founderNetworkId: '',
    }),
  ],
});

const infoFixture = () => ({
  channel: '#staff',
  registered: true,
  founder: 'Zodiac',
  successor: '',
  description: 'IRC Fiber staff log feed',
  suspended: false,
  fields: {
    Founder: 'Zodiac',
    Description: 'IRC Fiber staff log feed',
    'Mode lock': '+ntOPH 200:1w',
  },
  lines: ['Information for channel #staff:', '     Founder: Zodiac'],
  access: [
    { number: 1, level: 'SOP', mask: 'sq' },
    { number: 2, level: 'HOP', mask: 'FiberEye' },
  ],
  accessError: '',
  platform: { userId: 'u-1', username: 'zodiac', networkId: 'n-1' },
});

function bodyRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="cs-channels-rows"] tr'),
  ) as HTMLElement[];
}

function accessRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('[data-testid="cs-access-rows"] tr'),
  ) as HTMLElement[];
}

async function manageStaff() {
  await vi.waitFor(() => expect(bodyRows().length).toBe(2));
  const staff = bodyRows().find((r) => r.textContent?.includes('#staff'))!;
  await (staff.querySelector('button') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(CHANNEL, { channel: '#staff' }));
}

describe('ChanServPanel.svelte — ChanServ channel management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === CHANNELS) return Promise.resolve(channelsFixture());
      if (path === CHANNEL) return Promise.resolve(infoFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockResolvedValue({});
  });

  it('lists the inventory and links the founder website user', async () => {
    render(ChanServPanel);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(CHANNELS));
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));

    const staff = bodyRows().find((r) => r.textContent?.includes('#staff'))!;
    // Column 3 is "Website user".
    expect(staff.children[2].querySelector('a')?.getAttribute('href')).toBe('#/users/u-1');
    expect(staff.children[2].textContent?.trim()).toBe('zodiac');

    const dmz = bodyRows().find((r) => r.textContent?.includes('#dmz'))!;
    expect(dmz.children[2].textContent?.trim()).toBe('—');
  });

  it('filters client-side without issuing another request', async () => {
    render(ChanServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));
    const before = mockedGet.mock.calls.length;

    await page.getByLabelText('Filter registered channels').fill('dmz');
    await vi.waitFor(() => expect(bodyRows().length).toBe(1));
    expect(bodyRows()[0].textContent).toContain('#dmz');
    expect(mockedGet.mock.calls.length).toBe(before);
  });

  it('explains an unavailable inventory', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === CHANNELS)
        return Promise.resolve({
          available: false,
          reason: 'anope.db not found at /nonexistent/anope.db',
          asOf: 0,
          suspendedCount: 0,
          channels: [],
        });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(ChanServPanel);
    await expect
      .element(page.getByText(/anope\.db not found at \/nonexistent\/anope\.db/))
      .toBeInTheDocument();
  });

  it('Manage renders the live INFO fields and the access list', async () => {
    render(ChanServPanel);
    await manageStaff();
    await expect.element(page.getByText('Mode lock')).toBeInTheDocument();
    await expect.element(page.getByText('+ntOPH 200:1w')).toBeInTheDocument();
    await vi.waitFor(() => expect(accessRows().length).toBe(2));
    expect(accessRows()[0].textContent).toContain('SOP');
    expect(accessRows()[1].textContent).toContain('FiberEye');
  });

  it('Suspend posts the reason and expiry, then re-runs the lookup', async () => {
    render(ChanServPanel);
    await manageStaff();

    // Substring name matching would also hit "Unsuspend".
    await page.getByRole('button', { name: 'Suspend', exact: true }).click();
    await page.getByLabelText('Suspend reason').fill('spam');
    await page.getByLabelText('Suspend expiry').fill('30d');
    await page.getByRole('button', { name: 'Suspend channel' }).click();

    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(SUSPEND, {
        channel: '#staff',
        reason: 'spam',
        expiry: '30d',
      }),
    );
    // The table is up to five minutes stale, so the live view must refresh.
    await vi.waitFor(() => {
      const lookups = mockedGet.mock.calls.filter((c) => c[0] === CHANNEL);
      expect(lookups.length).toBeGreaterThan(1);
    });
  });

  it('Drop posts nothing until the confirm dialog is confirmed', async () => {
    mockedPost.mockResolvedValue({ channel: '#staff', dropped: true });
    render(ChanServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));

    const staff = bodyRows().find((r) => r.textContent?.includes('#staff'))!;
    await (staff.querySelector('[data-testid="cs-drop-#staff"]') as HTMLButtonElement).click();
    await expect.element(page.getByText('Drop this channel registration?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await page.getByRole('button', { name: 'Drop registration' }).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(DROP, { channel: '#staff', confirm: true }),
    );
    expect(mockedPost.mock.calls.filter((c) => c[0] === DROP).length).toBe(1);
  });

  it('adds an access entry and removes a listed one', async () => {
    render(ChanServPanel);
    await manageStaff();

    await page.getByLabelText('Account or mask').fill('alice');
    await page.getByRole('button', { name: 'Add access' }).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(ACCESS, {
        channel: '#staff',
        tier: 'SOP',
        entry: 'alice',
      }),
    );

    const row = accessRows().find((r) => r.textContent?.includes('sq'))!;
    await (row.querySelector('[data-testid="cs-access-del-sq"]') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(ACCESS_DEL, { channel: '#staff', entry: 'sq' }),
    );
  });

  it('Register posts the channel, description and founder', async () => {
    mockedPost.mockResolvedValue({
      channel: '#new',
      registered: true,
      founder: 'alice',
      founderSet: true,
      founderError: '',
    });
    render(ChanServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));

    await page.getByLabelText('Channel to register').fill('#new');
    await page.getByLabelText('Channel description').fill('hello world');
    await page.getByLabelText('Founder account').fill('alice');
    await page.getByRole('button', { name: 'Register channel' }).click();

    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(REGISTER, {
        channel: '#new',
        description: 'hello world',
        founder: 'alice',
      }),
    );
  });

  it("renders ChanServ's refusal when the channel is already registered", async () => {
    mockedPost.mockRejectedValue(new ApiError('Channel #new is already registered!', 409));
    render(ChanServPanel);
    await vi.waitFor(() => expect(bodyRows().length).toBe(2));

    await page.getByLabelText('Channel to register').fill('#new');
    await page.getByRole('button', { name: 'Register channel' }).click();
    await expect.element(page.getByText(/is already registered!/)).toBeInTheDocument();
  });
});
