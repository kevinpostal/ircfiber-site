/**
 * SupportDetail.svelte — admin triage view for one Help & Feedback report.
 *
 * Coverage:
 *  1. Renders title, both comments and marks the admin-only one as Internal.
 *  2. Changing status + Save POSTs the full triage payload.
 *  3. A note posted with the internal checkbox is sent as `{ body, internal: true }`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import SupportDetail from './SupportDetail.svelte';
import { api } from '/src/admin/lib/api-client';
import { adminUser } from '/src/admin/stores/auth';

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
}));

vi.mock('/src/admin/lib/router', () => ({ navigate: vi.fn() }));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const issueFixture = () => ({
  id: 's1',
  number: 12,
  kind: 'bug',
  title: 'Upload dialog freezes',
  body: 'Dropping a PNG onto the composer freezes the tab.',
  status: 'open',
  priority: 'normal',
  reporterUsername: 'zodiac',
  userId: 'u1',
  reporterEmail: 'z@example.com',
  assigneeId: '',
  assigneeUsername: '',
  attachments: ['https://ircfiber.com/uploads/shot.png'],
  comments: [
    { id: 'c1', authorName: 'zodiac', fromAdmin: false, internal: false, body: 'Still happening today', createdAt: 1_765_000_000_000 },
    { id: 'c2', authorName: 'root', fromAdmin: true, internal: true, body: 'Repro on staging, looks like the worker', createdAt: 1_765_000_000_500 },
  ],
  commentCount: 2,
  context: { appVersion: 'v0.3.0-1', userAgent: 'Mozilla/5.0', url: 'https://ircfiber.com/irc/x', networkId: '', bufferName: '#chan', viewport: '1440x900' },
  createdAt: 1_765_000_000_000,
  updatedAt: 1_765_000_000_500,
  resolvedAt: 0,
});

const usersFixture = () => ({
  users: [
    { id: 'me', username: 'root', roles: ['admin', 'user'] },
    { id: 'u1', username: 'zodiac', roles: ['user'] },
  ],
  count: 2,
});

describe('SupportDetail.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminUser.set({ id: 'me', username: 'root', email: 'r@x', roles: ['admin', 'user'], isAdmin: true });
    mockedGet.mockImplementation((path: string) => {
      if (path === '/api/admin/support/issues/s1') return Promise.resolve(issueFixture());
      if (path === '/api/admin/users') return Promise.resolve(usersFixture());
      return Promise.reject(new Error('unexpected GET ' + path));
    });
    mockedPost.mockImplementation(() => Promise.resolve(issueFixture()));
  });

  it('renders the report, both comments and the Internal badge on the admin note', async () => {
    render(SupportDetail, { props: { issueId: 's1' } });
    await expect.element(page.getByRole('heading', { name: '#12 Upload dialog freezes' })).toBeInTheDocument();
    await expect.element(page.getByText('Still happening today')).toBeInTheDocument();
    await expect.element(page.getByText('Repro on staging, looks like the worker')).toBeInTheDocument();
    await expect.element(page.getByText('Internal', { exact: true })).toBeInTheDocument();
    expect(document.querySelectorAll('li.border-l-warn').length).toBe(1);
    await expect.element(page.getByText('z@example.com')).toBeInTheDocument();
    await expect.element(page.getByText('1440x900')).toBeInTheDocument();
    // Assignee options come from the admin-role users only.
    await vi.waitFor(() => {
      const opts = [...document.querySelectorAll<HTMLOptionElement>('#assignee option')].map((o) => o.textContent);
      expect(opts).toEqual(['Unassigned', 'root']);
    });
  });

  it('selecting resolved and saving posts the triage payload', async () => {
    render(SupportDetail, { props: { issueId: 's1' } });
    await expect.element(page.getByRole('heading', { name: '#12 Upload dialog freezes' })).toBeInTheDocument();
    await page.getByLabelText('Status').selectOptions('resolved');
    await page.getByRole('button', { name: 'Save' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/support/issues/s1', { status: 'resolved', priority: 'normal', assigneeId: '' }));
  });

  it('posts an internal note with the checkbox set', async () => {
    render(SupportDetail, { props: { issueId: 's1' } });
    await expect.element(page.getByRole('heading', { name: '#12 Upload dialog freezes' })).toBeInTheDocument();
    await page.getByLabelText('Reply').fill('note');
    await page.getByRole('checkbox', { name: /Internal note/ }).click();
    await page.getByRole('button', { name: 'Add note' }).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/support/issues/s1/comments', { body: 'note', internal: true }));
  });
});
