import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import FeedbackPage from './FeedbackPage.svelte';
import { ircState } from '../stores/ircStore.svelte';
import type { Network } from '../types';
import { submitSupportIssue, fetchMySupportIssues, addSupportIssueComment, type SupportIssueEntry } from '../stores/api';

// vi.mock is hoisted above every other statement, so the factory must not
// reference a module-level const — it is spelled out twice on purpose
// (the component imports '../stores/api'; ircStore resolves '/src/stores/api').
vi.mock('/src/stores/api', () => ({
  normalizeMessage: vi.fn((m: unknown) => m),
  archiveChannel: vi.fn(async () => {}),
  unarchiveChannel: vi.fn(async () => {}),
  reconnectNetwork: vi.fn(async () => {}),
  fetchMe: vi.fn(async () => ({ username: 'tester' })),
  joinChannel: vi.fn(async () => {}),
  submitSupportIssue: vi.fn(async () => ({})),
  fetchMySupportIssues: vi.fn(async () => ({ issues: [], total: 0 })),
  fetchSupportIssue: vi.fn(async () => ({})),
  addSupportIssueComment: vi.fn(async () => ({})),
}));
vi.mock('../stores/api', () => ({
  normalizeMessage: vi.fn((m: unknown) => m),
  archiveChannel: vi.fn(async () => {}),
  unarchiveChannel: vi.fn(async () => {}),
  reconnectNetwork: vi.fn(async () => {}),
  fetchMe: vi.fn(async () => ({ username: 'tester' })),
  joinChannel: vi.fn(async () => {}),
  submitSupportIssue: vi.fn(async () => ({})),
  fetchMySupportIssues: vi.fn(async () => ({ issues: [], total: 0 })),
  fetchSupportIssue: vi.fn(async () => ({})),
  addSupportIssueComment: vi.fn(async () => ({})),
}));
vi.mock('../lib/upload', () => ({ uploadFile: vi.fn() }));

function issue(overrides: Partial<SupportIssueEntry> = {}): SupportIssueEntry {
  return {
    id: 's1', number: 7, kind: 'bug', title: 'Upload dialog freezes', body: 'It freezes when I drop a PNG.',
    status: 'open', priority: 'normal', reporterUsername: 'tester', assigneeUsername: '',
    attachments: [], comments: [], commentCount: 0,
    createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, resolvedAt: 0,
    ...overrides,
  };
}

describe('FeedbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ircState.showFeedback = true;
    ircState.networks.length = 0;
    ircState.activeBuffer.networkId = null;
    ircState.activeBuffer.bufferName = null;
    vi.mocked(fetchMySupportIssues).mockResolvedValue({ issues: [], total: 0 });
    vi.mocked(submitSupportIssue).mockResolvedValue(issue());
  });

  it('validates locally before submitting', async () => {
    render(FeedbackPage);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect.element(page.getByText('title must be 3–120 characters')).toBeInTheDocument();
    expect(submitSupportIssue).not.toHaveBeenCalled();
  });

  it('submits a report with diagnostics and lists it under Your reports', async () => {
    render(FeedbackPage);
    await expect.element(page.getByText("You haven't submitted any reports yet.")).toBeInTheDocument();
    await page.getByPlaceholder('Short summary').fill('Upload dialog freezes');
    await page.getByPlaceholder('What happened? What did you expect? Steps to reproduce.').fill('It freezes when I drop a PNG.');
    await page.getByRole('button', { name: 'Send report' }).click();

    await vi.waitFor(() => expect(submitSupportIssue).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(submitSupportIssue).mock.calls[0][0];
    expect(arg.kind).toBe('bug');
    expect(arg.title).toBe('Upload dialog freezes');
    expect(arg.attachments).toEqual([]);
    expect(arg.context?.appVersion).toBeDefined();
    expect(arg.context?.viewport).toMatch(/^\d+x\d+$/);

    await expect.element(page.getByText(/report #7 submitted/)).toBeInTheDocument();
    await expect.element(page.getByText('#7', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /Upload dialog freezes/ })).toBeInTheDocument();
  });

  it('omits diagnostics when the checkbox is unchecked', async () => {
    render(FeedbackPage);
    await page.getByRole('checkbox').click();
    await page.getByPlaceholder('Short summary').fill('No diagnostics please');
    await page.getByPlaceholder('What happened? What did you expect? Steps to reproduce.').fill('Long enough description.');
    await page.getByRole('button', { name: 'Send report' }).click();
    await vi.waitFor(() => expect(submitSupportIssue).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitSupportIssue).mock.calls[0][0].context).toBeUndefined();
  });

  it('shows a Resolved pill and posts a reply on an existing report', async () => {
    const resolved = issue({ status: 'resolved', resolvedAt: Date.now() - 1000, comments: [
      { id: 'c1', authorName: 'kevin', fromAdmin: true, internal: false, body: 'Fixed in the last deploy.', createdAt: Date.now() - 30_000 },
    ], commentCount: 1 });
    vi.mocked(fetchMySupportIssues).mockResolvedValue({ issues: [resolved], total: 1 });
    vi.mocked(addSupportIssueComment).mockResolvedValue(issue({ ...resolved, status: 'open', resolvedAt: 0, comments: [
      ...resolved.comments,
      { id: 'c2', authorName: 'tester', fromAdmin: false, internal: false, body: 'Still broken for me', createdAt: Date.now() },
    ], commentCount: 2 }));

    render(FeedbackPage);
    await expect.element(page.getByText('Resolved', { exact: true })).toBeInTheDocument();
    await page.getByRole('button', { name: /Upload dialog freezes/ }).click();
    await expect.element(page.getByText('Fixed in the last deploy.')).toBeInTheDocument();
    await expect.element(page.getByText('(admin)')).toBeInTheDocument();

    await page.getByPlaceholder('Still a problem? Replying reopens this report.').fill('Still broken for me');
    await page.getByRole('button', { name: 'Reply' }).click();
    await vi.waitFor(() => expect(addSupportIssueComment).toHaveBeenCalledWith('s1', 'Still broken for me'));
    await expect.element(page.getByText('Still broken for me', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('Open', { exact: true })).toBeInTheDocument();
  });

  it('closes on Escape and returns to the active buffer', async () => {
    // A network must exist so navigateBackFromFeedback pushes history
    // instead of hard-navigating the test page to '/'.
    const net: Network = { networkId: 'n1', name: 'Local', host: 'irc.local', connected: true, channels: [] } as unknown as Network;
    ircState.networks.push(net);
    ircState.activeBuffer.networkId = 'n1';
    ircState.activeBuffer.bufferName = '#chan';
    render(FeedbackPage);
    await userEvent.keyboard('{Escape}');
    expect(ircState.showFeedback).toBe(false);
    expect(window.location.pathname).toBe('/irc/Local/channel/%23chan');
  });
});
