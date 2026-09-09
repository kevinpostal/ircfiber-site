/**
 * Emails.svelte — Deliver | Compose | Campaign.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import Emails from './Emails.svelte';
import * as ui from '/src/admin/stores/ui';
import { api, ApiError } from '/src/admin/lib/api-client';

const mockedGet = api.get as unknown as Mock;
const mockedPost = api.post as unknown as Mock;
const mockedToastOk = ui.toastSuccess as unknown as Mock;
const mockedToastErr = ui.toastError as unknown as Mock;
const mockedClipboard = () => (navigator.clipboard.writeText as unknown as Mock);

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) { super(m); this.status = s; }
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
    provider: 'sender', configured: true, tokenPresent: true,
    fromEmail: 'no-reply@ircfiber.com', fromName: 'IRC Fiber',
    publicUrl: 'https://ircfiber.com', verificationRequired: true,
    verificationSource: 'auto', ...(provider ?? {}),
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
  eventsTotal: 2, eventsPage: 0, eventsPageCount: 1, eventsLimit: 50,
  pending: [
    { id: PENDING_ID, username: 'mailadmin', email: 'mailadmin@example.test', createdAt: now - 600_000, ttlSeconds: 85_800 },
  ],
  cooldowns: [{ email: 'mailadmin@example.test', ttlSeconds: 42 }],
  ipCounters: [{ ip: '127.0.0.1', count: 3, ttlSeconds: 3400 }],
  redisError: '',
});

const pagedFixture = (servedPage: number) => ({
  ...overviewFixture(),
  events: [
    {
      atMs: now - 60_000 * (servedPage + 1), kind: 'signup_verification',
      toEmail: `page${servedPage}@example.test`, username: `user${servedPage}`,
      provider: 'resend', status: 'sent', error: '', durationMs: 200, sourceIp: '127.0.0.1',
    },
  ],
  eventsTotal: 120, eventsPage: servedPage, eventsPageCount: 3, eventsLimit: 50,
});

const jobFixture = () => ({
  id: 'job1', subject: 'News', role: '', q: '', scheduleAtMs: now,
  status: 'sending', createdBy: 'admin', createdAtMs: now - 1000,
  sent: 3, failed: 1, skipped: 0, total: 10,
});

function kpiValue(label: string): string {
  const labels = Array.from(document.querySelectorAll('div.uppercase'));
  const match = labels.find((el) => el.textContent?.trim() === label);
  return match?.parentElement?.querySelector('div.text-3xl')?.textContent?.trim() ?? '';
}

async function gotoCompose() {
  await page.getByRole('tab', { name: 'Compose' }).click();
  await expect.element(page.getByLabelText('Template')).toBeInTheDocument();
}

async function gotoCampaign() {
  await page.getByRole('tab', { name: 'Campaign' }).click();
  await expect.element(page.getByRole('button', { name: 'Preview audience' })).toBeInTheDocument();
}

async function composeTemplate() {
  await gotoCompose();
  await page.getByLabelText('Template').selectOptions('announcement');
}

async function campaignPreview() {
  await gotoCampaign();
  await page.getByLabelText('Search').fill('example');
  await page.getByRole('button', { name: 'Preview audience' }).click();
  await vi.waitFor(() =>
    expect(api.get).toHaveBeenCalledWith('/api/admin/emails/campaign/audience', { limit: 10, q: 'example' }));
  await expect.element(page.getByText('alice@example.test')).toBeInTheDocument();
}

async function walkToReview() {
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
}

const campaignPayload = (dryRun: boolean) => ({
  role: '', createdAfterMs: 0, createdBeforeMs: 0, q: 'example', all: false,
  subject: 'News from IRC Fiber',
  text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
  html: '', scheduleAtMs: expect.any(Number), dryRun,
});

describe('Emails.svelte — Deliver | Compose | Campaign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/emails')
        return Promise.resolve({ ...overviewFixture(), templates: templatesFixture() });
      if (path === '/api/admin/roles')
        return Promise.resolve({ roles: [{ name: 'admin' }, { name: 'user' }] });
      if (path === '/api/admin/emails/campaign/audience') return Promise.resolve(audienceFixture());
      if (path === '/api/admin/emails/campaigns') return Promise.resolve({ campaigns: [] });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === `/api/admin/emails/pending/${PENDING_ID}/revoke`)
        return Promise.resolve({ revoked: true, email: 'mailadmin@example.test' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
  });

  it('shows exactly the Deliver | Compose | Campaign tabs with Deliver active', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect.element(page.getByRole('tab', { name: 'Deliver' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'Compose' })).toBeInTheDocument();
    await expect.element(page.getByRole('tab', { name: 'Campaign' })).toBeInTheDocument();
    expect(document.body.textContent ?? '').toContain(
      'Transactional delivery, message authoring and bulk campaigns');
    expect(document.body.textContent ?? '').not.toContain('Delivery');
  });

  it("renders the failed send's provider error, the failure KPI and the Last-failure box", async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect
      .element(page.getByText(/HTTP 422 domain not verified/).first())
      .toBeInTheDocument();
    await vi.waitFor(() => expect(kpiValue('Failed (24 h)')).toBe('1'));
    expect(kpiValue('Sent (24 h)')).toBe('1');
    expect(kpiValue('Pending')).toBe('1');
    await expect.element(page.getByRole('alert').first()).toBeInTheDocument();
  });

  it('failed row expands to the full error with a Copy button wired to the clipboard', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('button', { name: 'Failed ▸' }).click();
    await expect.element(page.getByRole('button', { name: 'Copy', exact: true })).toBeInTheDocument();
    const pre = document.querySelector('pre.whitespace-pre-wrap');
    expect(pre?.textContent).toContain('sender.net rejected the message: HTTP 422 domain not verified');
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await vi.waitFor(() => expect(mockedClipboard()).toHaveBeenCalledWith(
      'sender.net rejected the message: HTTP 422 domain not verified'));
    expect(mockedToastOk).toHaveBeenCalledWith('Error copied');
  });

  it('search narrows the loaded page, chips filter by status, Clear filters resets', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect.element(page.getByText('probe@example.test')).toBeInTheDocument();
    await page.getByLabelText('Search').fill('422');
    await expect.element(page.getByText('Showing 1 of 2 on this page')).toBeInTheDocument();
    await page.getByLabelText('Search').fill('');
    await page.getByRole('button', { name: 'Failed', exact: true }).click();
    await expect.element(page.getByText('Showing 1 of 2 on this page')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Failed', exact: true }).click();
    await expect.element(page.getByText('Showing 2 of 2 on this page')).toBeInTheDocument();
    await page.getByLabelText('Search').fill('zzz-no-match');
    await expect.element(page.getByText('No matching sends')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect.element(page.getByText('Showing 2 of 2 on this page')).toBeInTheDocument();
  });

  it('hover copy buttons copy the address', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await page.getByRole('button', { name: 'Copy email' }).first().click();
    await vi.waitFor(() => expect(mockedClipboard()).toHaveBeenCalledWith('probe@example.test'));
    expect(mockedToastOk).toHaveBeenCalled();
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
      if (path === '/api/admin/emails/campaigns') return Promise.resolve({ campaigns: [] });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect.element(page.getByText('Not configured')).toBeInTheDocument();
    await page.getByText('Provider test').click();
    await expect.element(page.getByRole('button', { name: 'Send test' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('pages the send log without touching the rest of the payload', async () => {
    mockedGet.mockImplementation((path: string, query?: { page?: number }) => {
      if (path === '/api/admin/emails') return Promise.resolve(pagedFixture(query?.page ?? 0));
      if (path === '/api/admin/emails/campaigns') return Promise.resolve({ campaigns: [] });
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
    expect(kpiValue('Pending')).toBe('1');
    await page.getByRole('button', { name: 'Last page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 2, limit: 50 }));
    await expect.element(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('follows the gateway back when the log is trimmed under the page being read', async () => {
    mockedGet.mockImplementation((path: string, query?: { page?: number }) => {
      if (path === '/api/admin/emails/campaigns') return Promise.resolve({ campaigns: [] });
      if (path !== '/api/admin/emails') return Promise.reject(new Error('unexpected GET ' + path));
      const asked = query?.page ?? 0;
      return Promise.resolve({ ...pagedFixture(Math.min(asked, 1)), eventsTotal: 60, eventsPageCount: 2 });
    });
    render(Emails);
    await expect.element(page.getByText('page0@example.test')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Last page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 1, limit: 50 }));
    await expect.element(page.getByText('page1@example.test')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
  });
  it('Compose is a direct-send client: To first, Send, no mock or test-send fields', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCompose();
    await expect.element(page.getByRole('textbox', { name: 'To' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Send', exact: true })).toBeInTheDocument();
    const body = () => document.body.textContent ?? '';
    await vi.waitFor(() => expect(body()).toContain('Message'));
    expect(body()).not.toContain('Preview audience');
    expect(body()).not.toContain('Send now');
    expect(body()).not.toContain('Mock name');
    expect(body()).not.toContain('Test send');
    expect(document.querySelector('#mock-name')).toBeNull();
    expect(document.querySelector('#mock-email')).toBeNull();
    expect(document.querySelector('#campaign-test-email')).toBeNull();
    expect(document.querySelector('#campaign-q')).toBeNull();
    await expect.element(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  });

  it('Campaign has no textarea editors', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCampaign();
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });

  it('typing {{ opens the 3-item variable menu and Enter inserts at the caret', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCompose();
    await page.getByLabelText('Text').fill('Hi {{');
    await expect.element(page.getByRole('listbox', { name: 'Insert variable' })).toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: /{{username}}/ })).toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: /{{email}}/ })).toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: /{{unsubscribe_url}}/ })).toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('user.email');
    expect(body).not.toContain('confirmation_link');
    page.getByLabelText('Text').element().focus();
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() => expect(
      (document.getElementById('campaign-body') as HTMLTextAreaElement).value,
    ).toContain('{{username}}'));
  });
  it('Ctrl+Enter in Compose posts the direct send', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/send') return Promise.resolve({ sent: true, email: 'me@example.test' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await page.getByRole('textbox', { name: 'To' }).fill('me@example.test');
    const area = page.getByLabelText('Text').element();
    area.focus();
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/send', {
      toEmail: 'me@example.test',
      subject: 'News from IRC Fiber',
      text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
      html: '',
    });
    expect(mockedToastOk).toHaveBeenCalledWith('Email sent to me@example.test');
  });

  it('HTML typing substitutes the mock user into the sandboxed iframe', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCompose();
    await page.getByRole('button', { name: 'HTML', exact: true }).click();
    await page.getByLabelText('HTML').fill('<p>Hi {{username}}</p>');
    const frameSrc = () =>
      document.querySelector('iframe[title="HTML preview"]')?.getAttribute('srcdoc') ?? '';
    await vi.waitFor(() => expect(frameSrc()).toContain('<p>Hi subscriber</p>'));
    const sandbox =
      document.querySelector('iframe[title="HTML preview"]')?.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('Send POSTs the composed fields to the direct-send route, toasts and refetches', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/send') return Promise.resolve({ sent: true, email: 'me@example.test' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    const overviews = () =>
      mockedGet.mock.calls.filter((c: unknown[]) => (c as string[])[0] === '/api/admin/emails').length;
    const before = overviews();
    await composeTemplate();
    await page.getByRole('textbox', { name: 'To' }).fill('me@example.test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/send', {
      toEmail: 'me@example.test',
      subject: 'News from IRC Fiber',
      text: 'Hi {{username}},\n\nBody here.\n\nUnsubscribe: {{unsubscribe_url}}',
      html: '',
    });
    expect(mockedToastOk).toHaveBeenCalledWith('Email sent to me@example.test');
    expect(mockedToastErr).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(overviews()).toBeGreaterThan(before));
  });

  it('To drives the preview substitutions with a subscriber fallback', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCompose();
    await page.getByLabelText('Text').fill('Hi {{username}} <{{email}}>');
    await expect.element(page.getByText('Hi subscriber <subscriber@example.com>')).toBeInTheDocument();
    await page.getByRole('textbox', { name: 'To' }).fill('bob@example.test');
    await expect.element(page.getByText('Hi bob <bob@example.test>')).toBeInTheDocument();
  });

  it('a backend refusal surfaces inline and as a toast', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/send')
        return Promise.reject(new ApiError("That doesn't look like a valid email address.", 400));
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await page.getByRole('textbox', { name: 'To' }).fill('not-an-email');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await expect.element(page.getByText("That doesn't look like a valid email address.")).toBeInTheDocument();
    expect(mockedToastErr).toHaveBeenCalledWith("That doesn't look like a valid email address.");
    expect(mockedToastOk).not.toHaveBeenCalled();
  });

  it('Use in campaign hands the draft to wizard step 2 with an Edit back-link', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await page.getByRole('button', { name: 'Use in campaign →' }).click();
    await expect.element(page.getByText('News from IRC Fiber')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Edit in compose →' })).toBeInTheDocument();
    await page.getByRole('button', { name: 'Edit in compose →' }).click();
    await expect.element(page.getByLabelText('Template')).toBeInTheDocument();
  });

  it('wizard blocks Review until the audience preview is fresh, then walks to Review', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await gotoCampaign();
    await expect.element(page.getByRole('button', { name: '4. Review' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Next →' })).toBeDisabled();
    await campaignPreview();
    await walkToReview();
    await expect.element(page.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
  });

  it('dry run posts dryRun:true, shows counts and creates no job', async () => {
    mockedPost.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === '/api/admin/emails/campaigns' && body?.dryRun === true)
        return Promise.resolve({ dryRun: true, total: 2, skippedUnsubscribed: 1 });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await campaignPreview();
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByLabelText(/Dry run/).click();
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByRole('button', { name: 'Run dry run' }).click();
    await expect.element(page.getByText('Run a dry run?')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Run dry run' }).last().click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/campaigns', campaignPayload(true));
    expect(mockedToastOk).toHaveBeenCalledWith('Dry run: 2 addresses');
  });

  it('live send requires the typed subject match before posting the campaign', async () => {
    mockedPost.mockImplementation((path: string, body?: Record<string, unknown>) => {
      if (path === '/api/admin/emails/campaigns' && body?.dryRun === false)
        return Promise.resolve({ id: 'c1', status: 'scheduled', total: 2, scheduleAtMs: now });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await campaignPreview();
    await walkToReview();
    await page.getByRole('button', { name: 'Send now' }).click();
    await expect.element(page.getByText('Send this campaign?')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Send now' }).last()).toBeDisabled();
    await page.getByLabelText('Type to confirm').fill('wrong subject');
    await expect.element(page.getByRole('button', { name: 'Send now' }).last()).toBeDisabled();
    await page.getByLabelText('Type to confirm').fill('News from IRC Fiber');
    await expect.element(page.getByRole('button', { name: 'Send now' }).last()).toBeEnabled();
    await page.getByRole('button', { name: 'Send now' }).last().click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/admin/emails/campaigns', campaignPayload(false));
    expect(mockedToastOk).toHaveBeenCalledWith('Campaign scheduled');
  });

  it('an unfiltered send without the whole-audience confirm surfaces the backend refusal', async () => {
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/campaigns')
        return Promise.reject(new ApiError('Narrow the audience or confirm sending to everyone.', 400));
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await composeTemplate();
    await campaignPreview();
    await walkToReview();
    await page.getByRole('button', { name: 'Send now' }).click();
    await page.getByLabelText('Type to confirm').fill('News from IRC Fiber');
    await page.getByRole('button', { name: 'Send now' }).last().click();
    await expect
      .element(page.getByText('Narrow the audience or confirm sending to everyone.'))
      .toBeInTheDocument();
    expect(mockedToastErr).toHaveBeenCalled();
  });

  it('job row shows a progressbar with the sent fraction and Pause posts /:id/pause', async () => {
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/emails')
        return Promise.resolve({ ...overviewFixture(), templates: templatesFixture() });
      if (path === '/api/admin/roles') return Promise.resolve({ roles: [{ name: 'admin' }, { name: 'user' }] });
      if (path === '/api/admin/emails/campaign/audience') return Promise.resolve(audienceFixture());
      if (path === '/api/admin/emails/campaigns') return Promise.resolve({ campaigns: [jobFixture()] });
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation((path: string) => {
      if (path === '/api/admin/emails/campaigns/job1/pause')
        return Promise.resolve({ id: 'job1', status: 'paused' });
      return Promise.reject(new Error('unexpected POST ' + path));
    });
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await gotoCampaign();
    await expect.element(page.getByRole('progressbar', { name: 'Progress for News' })).toBeInTheDocument();
    await expect.element(page.getByText('3 / 10 sent · 1 failed · 0 skipped')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Pause' }).first().click();
    await expect.element(page.getByText('Pause "News"?')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Pause' }).last().click();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/admin/emails/campaigns/job1/pause'));
    expect(mockedToastOk).toHaveBeenCalledWith('Campaign paused');
  });

  it('/ focuses the Deliver search input', async () => {
    render(Emails);
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/admin/emails', { page: 0, limit: 50 }));
    await expect.element(page.getByLabelText('Search')).toBeInTheDocument();
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(document.getElementById('deliver-search')));
  });
});
