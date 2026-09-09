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
import { api, ApiError } from '/src/admin/lib/api-client';

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

const templatesFixture = () => ([
  {
    id: 'announcement',
    subject: 'News from IRC Fiber',
    text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
  },
  {
    id: 'account-notice',
    subject: 'A note about your account',
    text: 'Hi {{username}} ({{email}})',
  },
]);

const audienceFixture = () => ({
  total: 2,
  sample: [
    { username: 'alice', email: 'alice@example.test', createdAt: now - 100_000 },
    { username: 'bob', email: 'bob@example.test', createdAt: now - 200_000 },
  ],
});
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
  eventsTotal: 2,
  eventsPage: 0,
  eventsPageCount: 1,
  eventsLimit: 50,
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

/// A 120-row log at 50/page. Each page carries one identifiable row so the
/// table can be asserted on without counting.
const pagedFixture = (servedPage: number) => ({
  ...overviewFixture(),
  events: [
    {
      atMs: now - 60_000 * (servedPage + 1), kind: 'signup_verification',
      toEmail: `page${servedPage}@example.test`, username: `user${servedPage}`,
      provider: 'resend', status: 'sent', error: '', durationMs: 200, sourceIp: '127.0.0.1',
    },
  ],
  eventsTotal: 120,
  eventsPage: servedPage,
  eventsPageCount: 3,
  eventsLimit: 50,
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
      if (path === '/api/admin/emails')
        return Promise.resolve({ ...overviewFixture(), templates: templatesFixture() });
      if (path === '/api/admin/roles')
        return Promise.resolve({ roles: [{ name: 'admin' }, { name: 'user' }] });
      if (path === '/api/admin/emails/campaign/audience') return Promise.resolve(audienceFixture());
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
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect
      .element(page.getByText(/HTTP 422 domain not verified/).first())
      .toBeInTheDocument();
    await vi.waitFor(() => expect(kpiValue('Failed (24 h)')).toBe('1'));
    expect(kpiValue('Sent (24 h)')).toBe('1');
    expect(kpiValue('Pending')).toBe('1');
  });

  it('Revoke on the pending row confirms then POSTs that row id', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
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
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect.element(page.getByText('Not configured')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Send test' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('pages the send log without touching the rest of the payload', async () => {
    mockedGet.mockImplementation((path: string, query?: { page?: number }) => {
      if (path === '/api/admin/emails') return Promise.resolve(pagedFixture(query?.page ?? 0));
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(Emails);
    await expect.element(page.getByText('page0@example.test')).toBeInTheDocument();
    await expect.element(page.getByText(/Showing 1–1 of 120/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await page.getByRole('button', { name: 'Next page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 1, limit: 50 }));
    await expect.element(page.getByText('page1@example.test')).toBeInTheDocument();
    await expect.element(page.getByText(/Showing 51–51 of 120/)).toBeInTheDocument();
    // Pending/KPI sections are a full snapshot on every page.
    expect(kpiValue('Pending')).toBe('1');

    await page.getByRole('button', { name: 'Last page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 2, limit: 50 }));
    await expect.element(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('follows the gateway back when the log is trimmed under the page being read', async () => {
    // Asked for page 2, answered with page 1: the capped log shrank. The
    // pager must land there instead of asking for the vanished page again.
    mockedGet.mockImplementation((path: string, query?: { page?: number }) => {
      if (path !== '/api/admin/emails') return Promise.reject(new Error('unexpected GET ' + path));
      const asked = query?.page ?? 0;
      return Promise.resolve({
        ...pagedFixture(Math.min(asked, 1)),
        eventsTotal: 60,
        eventsPageCount: 2,
      });
    });
    render(Emails);
    await expect.element(page.getByText('page0@example.test')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Last page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 1, limit: 50 }));
    await expect.element(page.getByText('page1@example.test')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    // Previous still moves: the local page followed the served one.
    await page.getByRole('button', { name: 'Previous page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
  });

  it('Compose preview shows the audience count and sample, then enables Send', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('tab', { name: 'Compose' }).click();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/admin/roles'));
    // No preview for the current filters yet: Send stays disabled.
    await expect.element(page.getByRole('button', { name: 'Send campaign' })).toBeDisabled();
    await page.getByLabelText('Search').fill('example');
    await page.getByRole('button', { name: 'Preview audience' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails/campaign/audience', {
        limit: 10, q: 'example',
      }));
    await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
    await expect.element(page.getByText('bob@example.test')).toBeInTheDocument();
    await page.getByLabelText('Template').selectOptions('announcement');
    await expect.element(page.getByRole('button', { name: 'Send campaign' })).toBeEnabled();
  });

  it('Send posts the raw fields once, renders the summary and re-fetches the log', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/campaign/send')
        return Promise.resolve({
          sent: 2, failed: 0, skippedUnsubscribed: 1, total: 2, errors: [],
        });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('tab', { name: 'Compose' }).click();
    await page.getByLabelText('Search').fill('example');
    await page.getByRole('button', { name: 'Preview audience' }).click();
    await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
    await page.getByLabelText('Template').selectOptions('announcement');
    await page.getByRole('button', { name: 'Send campaign' }).first().click();
    await expect.element(page.getByText('Send this campaign?')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Send campaign' }).last().click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/campaign/send', {
      role: '',
      createdAfterMs: 0,
      createdBeforeMs: 0,
      q: 'example',
      all: false,
      subject: 'News from IRC Fiber',
      text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
      html: '',
    }, { timeoutMs: 150_000 });
    expect(mockedToastOk).toHaveBeenCalled();
    // The campaign rows land in the send log: the overview is re-fetched.
    await vi.waitFor(() => {
      const overviews = mockedGet.mock.calls.filter((c) => c[0] === '/api/admin/emails');
      expect(overviews.length).toBeGreaterThan(1);
    });
  });

  it('an unfiltered send without the whole-audience confirm surfaces the backend refusal', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/campaign/send')
        return Promise.reject(
          new ApiError('Narrow the audience or confirm sending to everyone.', 400));
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('tab', { name: 'Compose' }).click();
    await page.getByRole('button', { name: 'Preview audience' }).click();
    await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
    await page.getByLabelText('Template').selectOptions('announcement');
    await page.getByRole('button', { name: 'Send campaign' }).first().click();
    await page.getByRole('button', { name: 'Send campaign' }).last().click();
    await expect
      .element(page.getByText('Narrow the audience or confirm sending to everyone.'))
      .toBeInTheDocument();
    expect(mockedToastErr).toHaveBeenCalled();
  });

  it('HTML tab typing substitutes the first recipient into the sandboxed iframe', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('tab', { name: 'Compose' }).click();
    await page.getByLabelText('Search').fill('example');
    await page.getByRole('button', { name: 'Preview audience' }).click();
    await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
    await page.getByLabelText('Template').selectOptions('announcement');
    // Picking a template clears author HTML: the iframe falls back to the
    // substituted text body until HTML is drafted.
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    await page.getByLabelText('HTML').fill('<p>Hi {{username}}</p>');
    const frameSrc = () =>
      document.querySelector('iframe[title="HTML preview"]')?.getAttribute('srcdoc') ?? '';
    await vi.waitFor(() => expect(frameSrc()).toContain('<p>Hi alice</p>'));
    const sandbox =
      document.querySelector('iframe[title="HTML preview"]')?.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('Send test POSTs the composed fields to the campaign test route and toasts', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/campaign/test')
        return Promise.resolve({ sent: true });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('tab', { name: 'Compose' }).click();
    await page.getByLabelText('Search').fill('example');
    await page.getByRole('button', { name: 'Preview audience' }).click();
    await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
    await page.getByLabelText('Template').selectOptions('announcement');
    await page.getByLabelText('Test send').fill('me@example.test');
    await page.getByRole('button', { name: 'Send test' }).click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/campaign/test', {
      toEmail: 'me@example.test',
      subject: 'News from IRC Fiber',
      text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
      html: '',
    });
    expect(mockedToastOk).toHaveBeenCalledWith('Campaign test sent to me@example.test');
    expect(mockedToastErr).not.toHaveBeenCalled();
  });
});
