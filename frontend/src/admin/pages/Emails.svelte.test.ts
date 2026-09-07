/**
 * Emails.svelte — admin Emails page (signup verification delivery).
 *
 * Coverage:
 *  1. Overview fixture with one failed send: the provider's rejection text
 *     renders and the Failed (24 h) KPI shows 1.
 *  2. Revoke on the pending row + confirm posts exactly
 *     /api/admin/emails/pending/<id>/revoke and toasts success.
 *  3. Verification required with no provider: the Not configured badge
 *     renders and Send test is disabled.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import Emails from './Emails.svelte';
import * as ui from '/src/admin/stores/ui';
import { api } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as Mock;
const mockedPost = api.post as unknown as Mock;
const mockedToastOk = ui.toastSuccess as unknown as Mock;
const mockedToastErr = ui.toastError as unknown as Mock;

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
  pollingEnabled: { subscribe: vi.fn() },
}));

vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => unknown) => {
    void fetcher();
    return () => {};
  }),
}));

const now = Date.now();
const PENDING_ID = '0123456789abcdef';

const overviewFixture = (provider?: Partial<Record<string, unknown>>) => ({
  provider: {
    provider: 'sender',
    configured: true,
    tokenPresent: true,
    fromEmail: 'no-reply@ircfiber.com',
    fromName: 'IRC Fiber',
    publicUrl: 'https://ircfiber.com',
    verificationRequired: true,
    verificationSource: 'auto',
    ...(provider ?? {}),
  },
  stats: {
    sent24h: 1, failed24h: 1, sentWindow: 1, failedWindow: 1, windowSize: 2,
    lastSentAt: now - 600_000, lastFailedAt: now - 300_000,
    lastError: 'sender.net rejected the message: HTTP 422 domain not verified',
  },
  events: [
    {
      atMs: now - 300_000, kind: 'admin_test', toEmail: 'probe@example.test', username: '',
      provider: 'sender', status: 'failed',
      error: 'sender.net rejected the message: HTTP 422 domain not verified',
      durationMs: 380, sourceIp: '10.0.0.9',
    },
    {
      atMs: now - 600_000, kind: 'signup_verification', toEmail: 'mailadmin@example.test',
      username: 'mailadmin', provider: 'sender', status: 'sent', error: '',
      durationMs: 210, sourceIp: '127.0.0.1',
    },
  ],
  pending: [
    {
      id: PENDING_ID, username: 'mailadmin', email: 'mailadmin@example.test',
      createdAt: now - 600_000, ttlSeconds: 85_800,
    },
  ],
  cooldowns: [{ email: 'mailadmin@example.test', ttlSeconds: 42 }],
  ipCounters: [{ ip: '127.0.0.1', count: 3, ttlSeconds: 3400 }],
  redisError: '',
});

function kpiValue(label: string): string {
  const labels = Array.from(document.querySelectorAll('div.uppercase'));
  const match = labels.find((el) => el.textContent?.trim() === label);
  return match?.parentElement?.querySelector('div.text-3xl')?.textContent?.trim() ?? '';
}

describe('Emails.svelte — signup verification delivery page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/emails') return Promise.resolve(overviewFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === `/api/admin/emails/pending/${PENDING_ID}/revoke`)
        return Promise.resolve({ revoked: true, email: 'mailadmin@example.test' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
  });

  it("renders the failed send's provider error and the failure KPI", async () => {
    render(Emails);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/emails'));
    await expect
      .element(page.getByText(/HTTP 422 domain not verified/).first())
      .toBeInTheDocument();
    await vi.waitFor(() => expect(kpiValue('Failed (24 h)')).toBe('1'));
    expect(kpiValue('Sent (24 h)')).toBe('1');
    expect(kpiValue('Pending')).toBe('1');
  });

  it('Revoke on the pending row confirms then POSTs that row id', async () => {
    render(Emails);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/emails'));
    await page.getByRole('button', { name: 'Revoke' }).first().click();
    await expect.element(page.getByText(/Revoke the signup for mailadmin\?/)).toBeInTheDocument();
    await page.getByRole('button', { name: 'Revoke' }).last().click();
    await vi.waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(`/api/admin/emails/pending/${PENDING_ID}/revoke`);
    });
    expect(mockedToastOk).toHaveBeenCalled();
    expect(mockedToastErr).not.toHaveBeenCalled();
  });

  it('verification required with no provider shows Not configured and blocks the test send', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/emails')
        return Promise.resolve(overviewFixture({
          provider: '', configured: false, tokenPresent: false, verificationRequired: true,
        }));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(Emails);
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/emails'));
    await expect.element(page.getByText('Not configured')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Send test' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
