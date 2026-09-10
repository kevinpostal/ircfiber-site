/**
 * FiberEyeRulesCard.svelte — the editable FiberEye ban rules.
 *
 * Coverage:
 *  1. The fetched rule set renders, and the badge names whether the deploy's
 *     values or an admin override are in force.
 *  2. Switching a rule off posts `churnEnabled:false` with the threshold
 *     UNCHANGED — the whole point of the per-rule flags is that turning a
 *     rule off does not destroy its value.
 *  3. A 400 carrying several reasons shows all of them and leaves Save
 *     enabled, so one pass fixes everything.
 *  4. Reset is behind the confirmation and only then posts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import FiberEyeRulesCard from './FiberEyeRulesCard.svelte';
import { api, ApiError } from '/src/admin/lib/api-client';

vi.mock('/src/admin/lib/api-client', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {
    readonly status: number;
    readonly errors: string[];
    constructor(m: string, s: number, errors: string[] = []) {
      super(m);
      this.status = s;
      this.errors = errors;
    }
  },
}));

vi.mock('/src/admin/stores/ui', () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

// The card polls through startPolling; run the fetcher once, synchronously,
// so tests are deterministic and no timer outlives them.
vi.mock('/src/admin/stores/polling', () => ({
  startPolling: vi.fn((fetcher: () => void | Promise<void>) => { void fetcher(); return () => {}; }),
}));

const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const ruleSet = (over: Record<string, unknown> = {}) => ({
  windowSeconds: 60,
  connects: 10, connectsEnabled: true,
  nicks: 6, nicksEnabled: true,
  churn: 6, churnEnabled: true,
  shortMs: 20_000, banSeconds: 3_600,
  ignoreClasses: ['ircfiber-engine'],
  exemptIps: ['76.32.236.21'],
  exemptNicks: [],
  ...over,
});

const bounds = {
  windowMin: 5, windowMax: 3_600, countMin: 2, countMax: 100_000,
  shortMsMin: 1_000, shortMsMax: 600_000,
  banSecondsMin: 60, banSecondsMax: 2_592_000, listMax: 64,
};

const payload = (over: Record<string, unknown> = {}) => ({
  effective: ruleSet(),
  deployed: ruleSet(),
  stored: null,
  source: 'deployed',
  bounds,
  audit: [],
  ...over,
});

describe('FiberEyeRulesCard.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockResolvedValue(payload());
    mockedPost.mockResolvedValue(payload());
  });

  it('renders the rules in force and badges where they came from', async () => {
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Deployed defaults', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('In force', { exact: true })).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith('/api/admin/fibereye/rules');

    const connects = page.getByRole('spinbutton').nth(1);
    await expect.element(connects).toHaveValue(10);
    // The escalation the ban duration implies, spelled out.
    await expect.element(page.getByText('1st strike 1h · 2nd 24h · 3rd+ 168h')).toBeInTheDocument();
  });

  it('badges an admin override', async () => {
    const stored = ruleSet({ connects: 4, updatedAtMs: 1_700_000_000_000, updatedBy: 'ruleadmin' });
    mockedGet.mockResolvedValue(payload({ stored, effective: stored, source: 'override' }));
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Custom rules', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText(/Last changed by ruleadmin/)).toBeInTheDocument();
  });

  it('reports a stored change the bot has not picked up yet', async () => {
    // Stored newer than what the heartbeat reports: the save has not reached
    // the running bot, which is exactly what this indicator exists to show.
    mockedGet.mockResolvedValue(payload({
      stored: ruleSet({ updatedAtMs: 2_000 }),
      effective: ruleSet({ updatedAtMs: 1_000 }),
      source: 'override',
    }));
    render(FiberEyeRulesCard);
    await expect.element(
      page.getByText('Pending — the bot picks up changes within 5s'),
    ).toBeInTheDocument();
  });

  it('switching a rule off keeps its threshold', async () => {
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Deployed defaults', { exact: true })).toBeInTheDocument();

    // Session churn is the third checkbox (connect flood, nick churn, then it).
    await page.getByRole('checkbox').nth(2).click();
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();

    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const [path, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/admin/fibereye/rules');
    expect(body.churnEnabled).toBe(false);
    expect(body.churn).toBe(6);
    expect(body.connectsEnabled).toBe(true);
  });

  it('shows every reason a save was refused and stays saveable', async () => {
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Deployed defaults', { exact: true })).toBeInTheDocument();
    mockedPost.mockRejectedValue(new ApiError('window must be between 5 and 3600 seconds', 400, [
      'window must be between 5 and 3600 seconds',
      'connect threshold must be between 2 and 100000',
    ]));

    await page.getByRole('checkbox').nth(2).click();
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();

    await expect.element(page.getByText('window must be between 5 and 3600 seconds')).toBeInTheDocument();
    await expect.element(page.getByText('connect threshold must be between 2 and 100000')).toBeInTheDocument();
    // The form keeps the rejected edit so it can be corrected and re-sent.
    await expect.element(page.getByRole('button', { name: 'Save rules', exact: true })).toBeEnabled();
  });

  it('resets to the deployed baseline only after confirming', async () => {
    mockedGet.mockResolvedValue(payload({
      stored: ruleSet({ connects: 4, updatedAtMs: 2_000, updatedBy: 'ruleadmin' }),
      effective: ruleSet({ connects: 4, updatedAtMs: 2_000, updatedBy: 'ruleadmin' }),
      source: 'override',
    }));
    render(FiberEyeRulesCard);
    await page.getByRole('button', { name: 'Reset to deployed', exact: true }).click();

    await expect.element(page.getByText('Reset the ban rules?')).toBeInTheDocument();
    expect(mockedPost).not.toHaveBeenCalled();
    // The dialog names the values that come back.
    await expect.element(page.getByText(/window 60s, 10 connects/)).toBeInTheDocument();

    await page.getByRole('button', { name: 'Reset to deployed', exact: true }).nth(1).click();
    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/api/admin/fibereye/rules/reset'));
  });

  it('refuses a glob exemption client-side, before the server sees it', async () => {
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Deployed defaults', { exact: true })).toBeInTheDocument();

    await page.getByLabelText('Add to Exempt addresses').fill('*');
    await page.getByRole('button', { name: 'Add', exact: true }).nth(1).click();
    await expect.element(
      page.getByText('No globs, spaces or commas — an exempt address can never be banned.'),
    ).toBeInTheDocument();
  });

  it('saves a nick exemption and refuses a catch-all client-side', async () => {
    render(FiberEyeRulesCard);
    await expect.element(page.getByText('Deployed defaults', { exact: true })).toBeInTheDocument();

    await page.getByLabelText('Add to Exempt nicks').fill('*');
    await page.getByRole('button', { name: 'Add', exact: true }).nth(2).click();
    await expect.element(
      page.getByText('Needs at least two non-wildcard characters — a bare * would exempt everyone.'),
    ).toBeInTheDocument();
    expect(mockedPost).not.toHaveBeenCalled();

    await page.getByLabelText('Add to Exempt nicks').fill('p34c3*');
    await page.getByRole('button', { name: 'Add', exact: true }).nth(2).click();
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();

    await vi.waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const [, body] = mockedPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.exemptNicks).toEqual(['p34c3*']);
    // The untouched lists round-trip unchanged.
    expect(body.exemptIps).toEqual(['76.32.236.21']);
  });
});
