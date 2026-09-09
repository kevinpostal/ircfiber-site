import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SettingsBouncer from './SettingsBouncer.svelte';

/**
 * Guards the reading of `/api/me/bouncer`: no password → only the Generate
 * action; after generating, the password input appears and every network
 * row shows the `<username>/<slug>` identity a legacy client needs; Revoke
 * is a two-click action.
 */

let password: string | null;
let methods: string[];
let clientMethods: string[];
let disconnected: string[];
let sessionClients: Array<Record<string, unknown>>;

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
    networks: [{ id: 'n1', name: 'IRC Fiber', slug: 'irc-fiber', host: 'irc.ircfiber.com', port: 6697, connected: true }],
    playbackLines: 200,
    playbackMax: 1000,
  };
}

beforeEach(() => {
  password = null;
  methods = [];
  clientMethods = [];
  disconnected = [];
  sessionClients = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
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
});
