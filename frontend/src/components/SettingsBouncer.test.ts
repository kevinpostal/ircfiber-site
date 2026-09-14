import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SettingsBouncer from './SettingsBouncer.svelte';

/**
 * Guards the reading of `/api/me/bouncer`: no password → only the Generate
 * action; after generating, the password input appears and every network
 * row shows the `<username>/<slug>` identity a legacy client needs; Revoke
 * is a two-click action. Also covers the enterprise surface the tab grew:
 * password metadata, per-network identity (ident/realname need a
 * reconnect), the access policy, device backlog resets and the event trail.
 */

let password: string | null;
let methods: string[];
let clientMethods: string[];
let disconnected: string[];
let sessionClients: Array<Record<string, unknown>>;
let identStored: string;
let detachedChannels: string[];
let devices: Array<Record<string, unknown>>;
let activity: Array<Record<string, unknown>>;
let requireTls: boolean;
/** Bodies sent to POST /api/me/bouncer/settings, in order. */
let settingsPatches: Array<Record<string, unknown>>;
/** Bodies sent to PUT /api/networks/:id, in order. */
let networkPatches: Array<Record<string, unknown>>;
/** clientIds passed to DELETE /api/me/bouncer/devices/:clientId. */
let devicesReset: string[];
/** networkIds passed to POST /api/networks/:id/reconnect. */
let reconnects: string[];

function sessionFixture() {
  const now = Date.now();
  return [
    { sid: 's1', networkId: 'n1', networkName: 'IRC Fiber', clientId: 'laptop', nick: 'tester', peer: '1.2.3.4', tls: true, caps: '', attachedAt: now - 60_000, lastRecvMs: now - 5_000, lastSendMs: now - 5_000, linesIn: 10, linesOut: 20, cursor: 42 },
    { sid: 's2', networkId: 'n1', networkName: 'IRC Fiber', clientId: '', nick: 'tester', peer: '5.6.7.8', tls: false, caps: '', attachedAt: now - 30_000, lastRecvMs: 0, lastSendMs: 0, linesIn: 0, linesOut: 0, cursor: 0 },
  ];
}

function payload() {
  return {
    enabled: true,
    host: 'bnc.test',
    port: 7000,
    tls: true,
    username: 'tester',
    password,
    passwordCreatedAt: password ? Date.UTC(2026, 8, 1) : 0,
    passwordLastUsedAt: password ? Date.now() - 60_000 : 0,
    passwordLastIp: password ? '203.0.113.9' : '',
    passwordLastClient: password ? 'laptop' : '',
    networks: [{
      id: 'n1', name: 'IRC Fiber', slug: 'irc-fiber', host: 'irc.ircfiber.com', port: 6697,
      nick: 'tester', ident: identStored, realName: 'Tester', managed: false,
      detached: detachedChannels, connected: true,
    }],
    playbackLines: 200,
    playbackMax: 1000,
    requireTls,
    allowedCidrs: [] as string[],
    maxClients: 0,
    maxClientsCeiling: 32,
    awayMessage: '',
    devices,
    activity,
  };
}

beforeEach(() => {
  password = null;
  methods = [];
  clientMethods = [];
  disconnected = [];
  sessionClients = [];
  identStored = '';
  detachedChannels = [];
  devices = [];
  activity = [];
  requireTls = false;
  settingsPatches = [];
  networkPatches = [];
  devicesReset = [];
  reconnects = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.includes('/me/bouncer/settings')) {
      settingsPatches.push(body);
      if (typeof body.requireTls === 'boolean') requireTls = body.requireTls;
      return new Response(JSON.stringify({
        prefVersion: 2,
        playbackLines: typeof body.playbackLines === 'number' ? body.playbackLines : 200,
        playbackMax: 1000,
        requireTls,
        allowedCidrs: Array.isArray(body.allowedCidrs) ? body.allowedCidrs : [],
        maxClients: typeof body.maxClients === 'number' ? body.maxClients : 0,
        maxClientsCeiling: 32,
        awayMessage: typeof body.awayMessage === 'string' ? body.awayMessage : '',
      }), { status: 200 });
    }
    if (url.includes('/me/bouncer/devices/')) {
      const cid = decodeURIComponent(url.split('/devices/')[1] ?? '');
      devicesReset.push(cid);
      devices = devices.filter((d) => d.id !== cid);
      return new Response(null, { status: 204 });
    }
    if (url.includes('/networks/') && url.endsWith('/reconnect')) {
      reconnects.push(url.split('/networks/')[1]?.replace('/reconnect', '') ?? '');
      return new Response(null, { status: 204 });
    }
    if (url.includes('/networks/') && (init?.method ?? 'GET') === 'PUT') {
      networkPatches.push(body);
      if (typeof body.ident === 'string') identStored = body.ident;
      return new Response(JSON.stringify({ id: 'n1' }), { status: 200 });
    }
    if (url.includes('/me/bouncer/clients')) {
      const method = init?.method ?? 'GET';
      clientMethods.push(method);
      if (method === 'POST') {
        const sid = url.split('/clients/')[1]?.split('/')[0] ?? '';
        disconnected.push(decodeURIComponent(sid));
        sessionClients = sessionClients.filter((c) => c.sid !== decodeURIComponent(sid));
        return new Response(JSON.stringify({ disconnected: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ clients: sessionClients, now: Date.now() }), { status: 200 });
    }
    if (url.includes('/me/bouncer')) {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') password = 'tok';
      if (method === 'DELETE') { password = null; return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify(payload()), { status: 200 });
    }
    return realFetch(input as RequestInfo, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsBouncer', () => {
  it('offers Generate password before one exists, then shows it and the per-network identities', async () => {
    render(SettingsBouncer);
    await expect.element(page.getByRole('button', { name: 'Generate password' })).toBeInTheDocument();
    expect(document.querySelector('input[aria-label="Bouncer password"]')).toBeNull();
    await expect.element(page.getByLabelText('Bouncer username', { exact: true })).toHaveValue('tester');

    await userEvent.click(page.getByRole('button', { name: 'Generate password' }));
    await expect.element(page.getByLabelText('Bouncer password')).toHaveValue('tok');
    expect(methods).toEqual(['GET', 'POST']);
    await expect.element(page.getByLabelText('Bouncer username for IRC Fiber')).toHaveValue('tester/irc-fiber');
  });

  it('revokes only on the second click', async () => {
    password = 'tok';
    render(SettingsBouncer);
    await expect.element(page.getByLabelText('Bouncer password')).toHaveValue('tok');
    await userEvent.click(page.getByRole('button', { name: 'Revoke' }));
    expect(methods).toEqual(['GET']);
    await userEvent.click(page.getByRole('button', { name: 'Click again to revoke' }));
    await expect.element(page.getByRole('button', { name: 'Generate password' })).toBeInTheDocument();
    expect(methods).toEqual(['GET', 'DELETE', 'GET']);
  });

  it('lists active sessions once a password exists, hiding the section before that', async () => {
    sessionClients = sessionFixture();
    render(SettingsBouncer);
    await expect.element(page.getByRole('button', { name: 'Generate password' })).toBeInTheDocument();
    expect(document.querySelector('[data-testid="bnc-session-row"]')).toBeNull();
    expect(clientMethods).toEqual([]);

    await userEvent.click(page.getByRole('button', { name: 'Generate password' }));
    await expect.element(page.getByLabelText('Bouncer password')).toHaveValue('tok');
    await vi.waitFor(() => expect(clientMethods).toEqual(['GET']));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-session-row"]').length).toBe(2));
    expect(document.body.textContent).toContain('laptop');
    expect(document.body.textContent).toContain('1.2.3.4');
    expect(document.body.textContent).toContain('IRC Fiber');
  });

  it('disconnects only on the second click, then refreshes the list', async () => {
    password = 'tok';
    sessionClients = sessionFixture();
    render(SettingsBouncer);
    await userEvent.click(page.getByRole('button', { name: 'Disconnect' }).first());
    expect(disconnected).toEqual([]);
    await userEvent.click(page.getByRole('button', { name: 'Click again to disconnect' }));
    await vi.waitFor(() => expect(disconnected).toEqual(['s1']));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-session-row"]').length).toBe(1));
    expect(document.body.textContent).not.toContain('1.2.3.4');
  });

  it('shows when the password was created and last used', async () => {
    password = 'tok';
    render(SettingsBouncer);
    const meta = page.getByTestId('bnc-password-meta');
    await expect.element(meta).toBeInTheDocument();
    const text = (await meta.element()).textContent ?? '';
    expect(text).toContain('Created');
    expect(text).toContain('2026');
    expect(text).toContain('203.0.113.9');
    expect(text).toContain('laptop');
  });

  it('saves a network identity and offers Reconnect only when ident changed', async () => {
    password = 'tok';
    render(SettingsBouncer);
    await userEvent.click(page.getByRole('button', { name: 'Identity' }));
    const ident = page.getByLabelText('Ident');
    await expect.element(ident).toBeInTheDocument();
    await userEvent.fill(ident, 'zod');
    await userEvent.click(page.getByRole('button', { name: 'Save', exact: true }));
    await vi.waitFor(() => expect(networkPatches).toEqual([{ nick: 'tester', ident: 'zod', realName: 'Tester' }]));
    await expect.element(page.getByRole('button', { name: 'Reconnect now' })).toBeInTheDocument();

    await userEvent.click(page.getByRole('button', { name: 'Reconnect now' }));
    await vi.waitFor(() => expect(reconnects).toEqual(['n1']));
  });

  it('leaves Reconnect hidden when only the nick changed', async () => {
    password = 'tok';
    render(SettingsBouncer);
    await userEvent.click(page.getByRole('button', { name: 'Identity' }));
    const nick = page.getByLabelText('Nick', { exact: true });
    await expect.element(nick).toBeInTheDocument();
    await userEvent.fill(nick, 'zodiac');
    await userEvent.click(page.getByRole('button', { name: 'Save', exact: true }));
    await vi.waitFor(() => expect(networkPatches).toEqual([{ nick: 'zodiac', ident: '', realName: 'Tester' }]));
    expect(document.body.textContent).not.toContain('Reconnect now');
  });

  it('persists the TLS requirement through the bouncer settings endpoint', async () => {
    password = 'tok';
    render(SettingsBouncer);
    const toggle = page.getByLabelText('Require TLS');
    await expect.element(toggle).toBeInTheDocument();
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(settingsPatches).toEqual([{ requireTls: true }]));
    await expect.element(page.getByLabelText('Require TLS')).toBeChecked();
  });

  it('resets a device backlog only on the second click', async () => {
    password = 'tok';
    devices = [{
      id: 'laptop', clientId: 'laptop', anonymous: false, online: true,
      networks: [{ networkId: 'n1', networkName: 'IRC Fiber', cursor: 4242 }],
    }];
    render(SettingsBouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-device-row"]').length).toBe(1));
    expect(document.body.textContent).toContain('4242');
    await userEvent.click(page.getByRole('button', { name: 'Reset backlog' }));
    expect(devicesReset).toEqual([]);
    await userEvent.click(page.getByRole('button', { name: 'Click again to reset' }));
    await vi.waitFor(() => expect(devicesReset).toEqual(['laptop']));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-device-row"]').length).toBe(0));
  });

  it('renders the event trail, newest first', async () => {
    password = 'tok';
    const now = Date.now();
    activity = [
      { t: now - 60_000, event: 'attach', reason: 'clientid', ip: '198.51.100.7', clientId: 'laptop', networkName: 'IRC Fiber', tls: true },
      { t: now - 120_000, event: 'reject', reason: 'cidr-denied', ip: '198.51.100.9', clientId: '', networkName: '', tls: false },
    ];
    render(SettingsBouncer);
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="bnc-activity-row"]').length).toBe(2));
    const rows = document.querySelectorAll('[data-testid="bnc-activity-row"]');
    expect(rows[0].textContent).toContain('attached');
    expect(rows[0].textContent).toContain('198.51.100.7');
    expect(rows[1].textContent).toContain('refused');
    expect(rows[1].textContent).toContain('cidr-denied');
  });
});
