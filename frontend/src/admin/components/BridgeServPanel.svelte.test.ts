/**
 * BridgeServPanel.svelte — Discord <-> IRC bridge management (IRCD page → BridgeServ).
 *
 * Pins behaviour, not markup:
 *  1. The add form POSTs exactly {channel, space, foreignChannel, suffix}
 *     built from the selected options.
 *  2. Choosing a guild triggers the channels fetch for that guild id and
 *     for no other guild.
 *  3. A 503 from the list endpoint renders the not-configured panel and
 *     issues no POST.
 *  4. Remove is inert until the typed confirmation is satisfied.
 *  5. A 502 surfaces the services reply text.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import BridgeServPanel from './BridgeServPanel.svelte';
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

const BRIDGES = '/api/admin/ircd/bridge/bridges';
const GUILDS = '/api/admin/ircd/bridge/guilds';
const CHANNELS = '/api/admin/ircd/bridge/channels';
const ADD = '/api/admin/ircd/bridge/add';
const SET = '/api/admin/ircd/bridge/set';
const DEL = '/api/admin/ircd/bridge/del';

const SPACE = '1085202042806607932';
const FOREIGN = '1085202042806607935';

const bridgesFixture = () => ({
  bridges: [
    {
      ircChannel: '#dmz',
      space: SPACE,
      channel: FOREIGN,
      suffix: '',
      network: 'discord',
      endpoint: true,
      reserved: 3,
    },
  ],
  raw: ['#dmz discord:1085202042806607932/1085202042806607935 Endpoint yes Reserved 3'],
  connected: true,
});

const guildsFixture = () => ({
  guilds: [
    { id: SPACE, name: 'Netcrave Communications' },
    { id: '999', name: 'Other Guild' },
  ],
});

const channelsFixture = (guild: string) => ({
  channels:
    guild === SPACE
      ? [{ id: FOREIGN, name: 'dmz' }]
      : [{ id: 'c-other', name: 'other-general' }],
});

function mockHealthy() {
  mockedGet.mockImplementation((path: string, query?: Record<string, string>) => {
    if (path === BRIDGES) return Promise.resolve(bridgesFixture());
    if (path === GUILDS) return Promise.resolve(guildsFixture());
    if (path === CHANNELS) return Promise.resolve(channelsFixture(String(query?.guild ?? '')));
    return Promise.reject(new Error('unexpected GET ' + path));
  });
  mockedPost.mockImplementation((path: string) => {
    if (path === ADD || path === SET) return Promise.resolve({ lines: ['Bridge added.'] });
    if (path === DEL) return Promise.resolve({ lines: ['Bridge removed.'] });
    return Promise.reject(new Error('unexpected POST ' + path));
  });
}

describe('BridgeServPanel.svelte — Discord bridge management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHealthy();
  });

  it('the add form POSTs exactly {channel, space, foreignChannel, suffix} from the selected options', async () => {
    render(BridgeServPanel);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(BRIDGES));
    await expect.element(page.getByRole('option', { name: 'Netcrave Communications' })).toBeInTheDocument();

    await page.getByLabelText('IRC channel').fill('#dmz');
    await page.getByLabelText('Discord guild').selectOptions(SPACE);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(CHANNELS, { guild: SPACE }));
    await expect.element(page.getByRole('option', { name: 'dmz' })).toBeInTheDocument();
    await page.getByLabelText('Discord channel').selectOptions(FOREIGN);
    await page.getByLabelText('Nick suffix').fill('-d');

    await page.getByRole('button', { name: 'Add bridge' }).click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(ADD, {
      channel: '#dmz',
      space: SPACE,
      foreignChannel: FOREIGN,
      suffix: '-d',
    }));
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost.mock.calls[0][1]).toEqual({
      channel: '#dmz',
      space: SPACE,
      foreignChannel: FOREIGN,
      suffix: '-d',
    });
  });

  it('choosing a guild triggers the channels fetch for that guild id and for no other guild', async () => {
    render(BridgeServPanel);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(GUILDS));

    await page.getByLabelText('Discord guild').selectOptions('999');
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(CHANNELS, { guild: '999' }));

    const channelCalls = mockedGet.mock.calls.filter((c) => c[0] === CHANNELS);
    expect(channelCalls.length).toBeGreaterThan(0);
    for (const c of channelCalls) expect(c[1]).toEqual({ guild: '999' });
  });

  it('a 503 from the list endpoint renders the not-configured panel and issues no POST', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === BRIDGES) {
        return Promise.reject(new ApiError('The Discord bridge is not configured', 503));
      }
      if (path === GUILDS) return Promise.resolve(guildsFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(BridgeServPanel);
    await expect
      .element(page.getByText('The Discord bridge is not configured'))
      .toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('remove is inert until the typed confirmation is satisfied', async () => {
    render(BridgeServPanel);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bridge-rows"] tr').length).toBe(1));

    await page.getByRole('button', { name: 'Remove #dmz' }).click();
    await expect.element(page.getByText('Remove this bridge?')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    // The dialog requires the exact channel name before its confirm enables,
    // so confirming without typing is impossible and posts nothing.
    const confirm = page
      .getByRole('button', { name: 'Remove bridge', exact: true })
      .element() as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();

    await page.getByLabelText('Type to confirm').fill('#dmz');
    await page.getByRole('button', { name: 'Remove bridge', exact: true }).click();
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(DEL, { channel: '#dmz' }),
    );
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('a 502 surfaces the services reply text', async () => {
    mockedPost.mockRejectedValueOnce(
      new ApiError('BridgeServ: ADD failed: no such guild', 502),
    );
    render(BridgeServPanel);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(BRIDGES));
    await page.getByLabelText('IRC channel').fill('#dmz');
    await page.getByLabelText('Discord guild').selectOptions(SPACE);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith(CHANNELS, { guild: SPACE }));
    await expect.element(page.getByRole('option', { name: 'dmz' })).toBeInTheDocument();
    await page.getByLabelText('Discord channel').selectOptions(FOREIGN);

    await page.getByRole('button', { name: 'Add bridge' }).click();
    await expect
      .element(page.getByText('BridgeServ: ADD failed: no such guild'))
      .toBeInTheDocument();
  });
});
