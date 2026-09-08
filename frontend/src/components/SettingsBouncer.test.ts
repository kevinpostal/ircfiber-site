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
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
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
});
