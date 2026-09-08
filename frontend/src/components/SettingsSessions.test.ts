import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import SettingsSessions from './SettingsSessions.svelte';

/**
 * What these guard is the reading of the payload: a login row per browser,
 * its tabs nested underneath, the two different "this is you" markers (the
 * requesting browser vs. the requesting tab), and a failure that says why
 * instead of rendering an empty table.
 */

const NOW = 1_800_000_000_000;
let requests: string[];
let deletes: string[];
let respond: () => Response;
let revokeStatus: () => Response;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    total: 2,
    liveClients: 2,
    sessions: [
      {
        ref: 'aaaaaaaaaaaa',
        createdAt: NOW - 3_600_000,
        lastAccess: NOW - 3_600_000,
        expiresAt: 0,
        clientIp: '203.0.113.9',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.0 Safari/605.1',
        current: false,
        clientCount: 0,
        clients: []
      },
      {
        ref: 'bbbbbbbbbbbb',
        createdAt: NOW - 7 * 86_400_000,
        lastAccess: NOW - 30_000,
        expiresAt: NOW + 90 * 86_400_000,
        clientIp: '2a02:6ea0:fe00:1::e025',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        current: true,
        clientCount: 2,
        clients: [
          {
            ref: 'cccccccccccc',
            connectedAt: NOW - 60_000,
            clientIp: '2603:8001:98f0:1530::1304',
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/152.0.0.0 Safari/537.36',
            current: true
          },
          {
            ref: 'dddddddddddd',
            connectedAt: NOW - 7_200_000,
            clientIp: '198.51.100.7',
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0',
            current: false
          }
        ]
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  requests = [];
  deletes = [];
  respond = () => new Response(JSON.stringify(payload()), { status: 200 });
  revokeStatus = () => new Response(JSON.stringify({ revoked: true, clientsDropped: 0 }), { status: 200 });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('/me/sessions')) {
      if ((init?.method ?? 'GET') === 'DELETE') {
        deletes.push(url);
        return revokeStatus();
      }
      requests.push(url);
      return respond();
    }
    return realFetch(input as RequestInfo, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SettingsSessions', () => {
  it('lists each login with its IP and a readable user agent', async () => {
    render(SettingsSessions);
    await expect.element(page.getByText('2a02:6ea0:fe00:1::e025')).toBeInTheDocument();
    await expect.element(page.getByText('Chrome 152 on macOS').first()).toBeInTheDocument();
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();
    await expect.element(page.getByText('Safari 18 on iOS 18')).toBeInTheDocument();
    // A session Redis could not date renders as "never", not as epoch 0.
    await expect.element(page.getByText('never')).toBeInTheDocument();
  });

  it('nests the live clients under their login and marks the asking tab', async () => {
    const { container } = render(SettingsSessions);
    await expect.element(page.getByText('Firefox 131 on Linux')).toBeInTheDocument();

    const bodies = container.querySelectorAll('tbody');
    expect(bodies.length).toBe(2);
    // Newest login first; the desktop login owns both client rows.
    expect(bodies[0].querySelectorAll('.settings-sessions-client').length).toBe(0);
    expect(bodies[1].querySelectorAll('.settings-sessions-client').length).toBe(2);

    const clients = bodies[1].querySelectorAll('.settings-sessions-client');
    expect(clients[0].querySelector('.settings-sessions-badge')?.textContent).toBe('Current');
    expect(clients[1].querySelector('.settings-sessions-badge')).toBeNull();
    // The requesting browser is flagged separately from the requesting tab.
    expect(bodies[1].querySelector('.settings-sessions-session .settings-sessions-badge')?.textContent)
      .toBe('This browser');
    expect(bodies[0].querySelector('.settings-sessions-session .settings-sessions-badge')).toBeNull();
  });

  it('shows the client-count column, not a bare zero, for a login with no tabs', async () => {
    const { container } = render(SettingsSessions);
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();
    const counts = container.querySelectorAll('.settings-sessions-session .settings-sessions-count');
    expect(counts[0].textContent?.trim()).toBe('—');
    expect(counts[1].textContent?.trim()).toBe('2');
  });

  it('refetches on Refresh', async () => {
    render(SettingsSessions);
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();
    expect(requests.length).toBe(1);
    await userEvent.click(page.getByRole('button', { name: 'Refresh' }));
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();
    expect(requests.length).toBe(2);
  });

  it('revokes another browser only after a confirm, then reloads', async () => {
    render(SettingsSessions);
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();

    // The current browser cannot be revoked — only the other session offers it.
    const buttons = page.getByRole('button', { name: 'Revoke' });
    expect(await buttons.all()).toHaveLength(1);

    await userEvent.click(buttons.first());
    // Arming alone must not touch the server.
    expect(deletes).toEqual([]);

    await userEvent.click(page.getByRole('button', { name: 'Confirm' }));
    await expect.element(page.getByText('Signed that browser out.')).toBeInTheDocument();
    // The ref of the row, never a session id, and the list is re-read.
    expect(deletes).toEqual(['/api/me/sessions/aaaaaaaaaaaa']);
    expect(requests.length).toBe(2);
  });

  it('keeps the row and shows why when the server refuses', async () => {
    revokeStatus = () => new Response(JSON.stringify({ error: 'That session no longer exists' }), { status: 404 });
    render(SettingsSessions);
    await expect.element(page.getByText('203.0.113.9')).toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: 'Revoke' }).first());
    await userEvent.click(page.getByRole('button', { name: 'Confirm' }));
    await expect.element(page.getByText('That session no longer exists')).toBeInTheDocument();
    expect(requests.length).toBe(1);
  });

  it("surfaces the server's reason when the list cannot be read", async () => {
    respond = () => new Response(JSON.stringify({ error: 'Session store unavailable' }), { status: 503 });
    render(SettingsSessions);
    await expect.element(page.getByText('Session store unavailable')).toBeInTheDocument();
  });
});
