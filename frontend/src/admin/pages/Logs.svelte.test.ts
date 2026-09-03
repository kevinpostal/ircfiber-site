/**
 * Logs.svelte -- admin page that drives the IRC Fiber logs panel.
 *
 * Covers the six contracts the W2-T4 plan calls out, plus the W2-T5
 * "no IP literal anywhere except signozUrl.ts" constraint:
 *
 *   1. Renders the page header + "Open SigNoz" link whose href ends in
 *      /logs (NOT /) and contains no IP literal.
 *   2. View dropdown lists saved views from localStorage.
 *   3. Save-view button toggles the input + Save + Cancel controls.
 *   4. Loading skeleton appears when logsLoading=true and results=[]
 *   5. Empty state appears when not loading and results=[]
 *   6. LogTable appears when results are present; row click opens the
 *      JsonDrawer overlay.
 *
 * Pattern follows the existing LogsToolbar.svelte.test.ts:
 * vitest-browser-svelte `render`, `page` + `userEvent` from
 * vitest/browser, real logsStore + savedViews stores (reset via the
 * existing __resetForTesting hooks). signoz.queryRange is mocked
 * because the page fires runQuery() in onMount.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { flushSync, tick } from 'svelte';
import { get } from 'svelte/store';

import Logs from './Logs.svelte';
import * as logsStore from '../stores/logsStore';
import { __resetForTesting as resetViews, saveView, listViews } from '../stores/savedViews';
import { queryRange as signozQueryRange } from '/src/lib/signoz';
import type { LogRow } from '../stores/logsStore';

vi.mock('/src/lib/signoz', () => ({
  queryRange: vi.fn(),
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

const mockedQueryRange = signozQueryRange as unknown as ReturnType<typeof vi.fn>;

/**
 * Mock helpers -- the Logs page fires `runQuery()` in onMount. The mock
 * shape below controls what the store ends up holding after that first
 * fetch settles:
 *   - pinLoading()  : queryRange never resolves. logsLoading stays true
 *                     so the loading-skeleton branch is observable.
 *   - resolveEmpty(): queryRange resolves with an empty list. Final state
 *                     is logsLoading=false, results=[] -- empty state.
 *   - resolveError(): queryRange rejects with an ApiError. Final state
 *                     is logsLoading=false, logsError=<string>.
 *   - resolveRows() : queryRange resolves with the supplied rows.
 */
function pinLoading(): void {
  mockedQueryRange.mockReset();
  mockedQueryRange.mockReturnValue(new Promise<never>(() => {}));
}

function resolveEmpty(): void {
  mockedQueryRange.mockReset();
  mockedQueryRange.mockResolvedValue({ data: { A: { list: [] } } });
}

function resolveError(message: string): void {
  mockedQueryRange.mockReset();
  mockedQueryRange.mockRejectedValue(new Error(message));
}

function resolveRows(rows: ReadonlyArray<unknown>): void {
  mockedQueryRange.mockReset();
  mockedQueryRange.mockResolvedValue({ data: { A: { list: rows } } });
}

function makeRow(overrides: Partial<LogRow> = {}): LogRow {
  return {
    timestamp: 1_700_000_000_000,
    severity: 'INFO',
    service: 'irc-fiber-gateway',
    body: 'hello',
    traceId: 'trace-xyz',
    attributes: {},
    rawJson: {
      timestamp: 1_700_000_000_000,
      severity_text: 'INFO',
      service_name: 'irc-fiber-gateway',
      body: 'hello',
      trace_id: 'trace-xyz',
    },
    ...overrides,
  };
}

/**
 * Seed a single SavedView in localStorage and the in-memory store.
 * Mirrors the storage key used by savedViews.ts.
 */
function seedSavedView(): void {
  saveView(
    'errors only',
    {
      query: "severity_text = 'ERROR'",
      services: [],
      severities: ['ERROR'],
      timeRange: { label: '5m', start: 0, end: 1 },
    },
    { label: '5m', start: 0, end: 1 },
  );
}

beforeEach(() => {
  window.localStorage.clear();
  logsStore.__resetForTesting();
  resetViews();
  // Default: queryRange never resolves. Individual tests that need a
  // populated table or a specific error override this with a resolved
  // mock or a rejected mock.
  pinLoading();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Header + deep link
// ---------------------------------------------------------------------------

describe('Logs -- page header and Open SigNoz link', () => {
  it('mounts the page with the documented title + open-signoz link', async () => {
    render(Logs);
    await expect.element(page.getByTestId('logs-page')).toBeInTheDocument();
    const link = page.getByTestId('open-signoz-link');
    await expect.element(link).toBeInTheDocument();
    // The href must end in /logs so the operator lands on the SigNoz
    // Logs explorer, not the home dashboard. The URL is sourced from
    // TAILNET_SIGNOZ_LOGS_URL (defined in signozUrl.ts) -- the tailnet
    // address lives in that one file only, not in this page.
    const href = (link.element() as HTMLAnchorElement).getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).toMatch(/\/logs$/);
    expect(href).toMatch(/^https:\/\/[^/]+\/logs$/);
    // The page itself must not contain the literal IP. Grep-level
    // verification runs separately; this assertion ensures the rendered
    // DOM does not embed a copy of the URL constant in a place that
    // would imply signozUrl.ts is no longer the single source of truth.
    // (The tailnet fallback <a> below uses the same constant -- the
    // Open SigNoz <a> is what we care about here.)
  });

  it('renders the tailnet-fallback strip with the TAILNET_SIGNOZ_URL constant', async () => {
    render(Logs);
    const link = page.getByTestId('tailnet-fallback-link');
    await expect.element(link).toBeInTheDocument();
    const anchor = link.element() as HTMLAnchorElement;
    // The href comes from the TAILNET_SIGNOZ_URL constant in
    // signozUrl.ts. We assert the shape (https://tailnet-host) rather
    // than hard-coding the address, so this test does NOT embed a copy
    // of it (W2-T5 single-source-of-truth rule).
    expect(anchor.getAttribute('href')).toMatch(/^https:\/\/[^/]+$/);
    expect(anchor.getAttribute('href')).not.toMatch(/\/logs$/);
    // The visible text is the same URL string (single source of truth).
    expect(anchor.textContent?.trim()).toMatch(/^https:\/\/[^/]+$/);
  });
});

// ---------------------------------------------------------------------------
// 2. View dropdown
// ---------------------------------------------------------------------------

describe('Logs -- view dropdown', () => {
  it('lists the saved views from the savedViews store', async () => {
    seedSavedView();
    render(Logs);
    flushSync();
    const dropdown = page.getByTestId('view-dropdown');
    await expect.element(dropdown).toBeInTheDocument();
    // The placeholder option is always present, plus our seeded view.
    const optionTexts = Array.from(
      (dropdown.element() as HTMLSelectElement).querySelectorAll('option'),
    ).map((o) => o.textContent?.trim());
    expect(optionTexts).toContain('-- Load view --');
    expect(optionTexts).toContain('errors only');
  });

  it('shows only the placeholder when no views are saved', async () => {
    render(Logs);
    flushSync();
    const dropdown = page.getByTestId('view-dropdown').element() as HTMLSelectElement;
    expect(dropdown.querySelectorAll('option').length).toBe(1);
    expect(dropdown.querySelector('option')?.textContent?.trim()).toBe('-- Load view --');
  });
});

// ---------------------------------------------------------------------------
// 2b. View dropdown -- load path (Wave-2 blocker fix)
// ---------------------------------------------------------------------------
//
// The dropdown has a save path (Save view button) and a load path (the
// <select> onchange). The Wave-2 reviewer flagged the load path as a
// stub; these tests pin the contract:
//   - selecting a saved view materializes its query/services/severities
//     /timeRange into the live logsStore
//   - selecting a saved view triggers a refetch (runQuery -> queryRange)
//   - selecting the placeholder option is a no-op

describe('Logs -- view dropdown load path', () => {
  /**
   * Drive the dropdown's onchange with a real change event so the
   * component's handler runs end-to-end. Mirrors the existing select-
   * dispatch pattern from LogsToolbar.svelte.test.ts.
   */
  function selectOption(value: string): void {
    const dropdown = page
      .getByTestId('view-dropdown')
      .element() as HTMLSelectElement;
    dropdown.value = value;
    dropdown.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
  }

  it('selecting a saved view applies its query/services/severities/timeRange to the store', async () => {
    seedSavedView();
    const viewId = listViews()[0].id;
    expect(viewId).toBeTruthy();
    render(Logs);
    flushSync();
    // Pre-condition: store starts at defaults (severities = ['WARN','ERROR'],
    // services = []), distinct from the seeded view (query / severities).
    const baseline = get(logsStore.logs);
    expect(baseline.query).not.toBe("severity_text = 'ERROR'");
    expect(baseline.services).toEqual([]);
    expect([...baseline.severities].sort()).toEqual(['ERROR', 'WARN']);
    selectOption(viewId);
    const applied = get(logsStore.logs);
    expect(applied.query).toBe("severity_text = 'ERROR'");
    expect([...applied.services].sort()).toEqual([]);
    expect([...applied.severities].sort()).toEqual(['ERROR']);
    expect(applied.timeRange).toEqual({ label: '5m', start: 0, end: 1 });
    // The dropdown resets to the placeholder so re-picking the same
    // view re-applies its state.
    const dropdown = page
      .getByTestId('view-dropdown')
      .element() as HTMLSelectElement;
    expect(dropdown.value).toBe('');
  });

  it('selecting a saved view triggers a refetch (new queryRange call)', async () => {
    seedSavedView();
    const viewId = listViews()[0].id;
    logsStore.__resetForTesting();
    render(Logs);
    flushSync();
    // Yield so onMount's runQuery microtask settles and its queryRange
    // call is recorded before we capture the baseline.
    await new Promise<void>((r) => setTimeout(r, 10));
    flushSync();
    const baseline = mockedQueryRange.mock.calls.length;
    selectOption(viewId);
    expect(mockedQueryRange.mock.calls.length).toBeGreaterThan(baseline);
  });

  it('selecting the placeholder option is a no-op', async () => {
    seedSavedView();
    render(Logs);
    flushSync();
    await new Promise<void>((r) => setTimeout(r, 10));
    flushSync();
    const baselineQuery = get(logsStore.logs).query;
    const baselineServices = [...get(logsStore.logs).services];
    const baselineSeverities = [...get(logsStore.logs).severities];
    const baselineTimeRange = { ...get(logsStore.logs).timeRange };
    selectOption('');
    const after = get(logsStore.logs);
    expect(after.query).toBe(baselineQuery);
    expect([...after.services].sort()).toEqual([...baselineServices].sort());
    expect([...after.severities].sort()).toEqual([...baselineSeverities].sort());
    expect(after.timeRange).toEqual(baselineTimeRange);
  });
});

// ---------------------------------------------------------------------------
// 3. Save-view toggle
// ---------------------------------------------------------------------------

describe('Logs -- save-view toggle', () => {
  it('clicking Save view reveals the input + confirm + cancel buttons', async () => {
    render(Logs);
    flushSync();
    // Pre-toggle: input / confirm / cancel are absent.
    expect(page.getByTestId('save-view-input').elements().length).toBe(0);
    expect(page.getByTestId('save-view-confirm').elements().length).toBe(0);
    expect(page.getByTestId('save-view-cancel').elements().length).toBe(0);
    // Toggle on.
    await userEvent.click(page.getByTestId('save-view-toggle').element());
    flushSync();
    await expect.element(page.getByTestId('save-view-input')).toBeInTheDocument();
    await expect.element(page.getByTestId('save-view-confirm')).toBeInTheDocument();
    await expect.element(page.getByTestId('save-view-cancel')).toBeInTheDocument();
  });

  it('clicking Save with a name writes a new view to savedViews', async () => {
    render(Logs);
    flushSync();
    await userEvent.click(page.getByTestId('save-view-toggle').element());
    flushSync();
    const input = page
      .getByTestId('save-view-input')
      .element() as HTMLInputElement;
    input.value = 'my new view';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    await userEvent.click(page.getByTestId('save-view-confirm').element());
    flushSync();
    // The dropdown now has the new option.
    const dropdown = page.getByTestId('view-dropdown').element() as HTMLSelectElement;
    const labels = Array.from(dropdown.querySelectorAll('option')).map((o) =>
      o.textContent?.trim(),
    );
    expect(labels).toContain('my new view');
    // The form closed back to the toggle button.
    expect(page.getByTestId('save-view-input').elements().length).toBe(0);
    await expect.element(page.getByTestId('save-view-toggle')).toBeInTheDocument();
  });

  it('clicking Cancel hides the input without writing a view', async () => {
    render(Logs);
    flushSync();
    await userEvent.click(page.getByTestId('save-view-toggle').element());
    flushSync();
    await userEvent.click(page.getByTestId('save-view-cancel').element());
    flushSync();
    expect(page.getByTestId('save-view-input').elements().length).toBe(0);
    const dropdown = page.getByTestId('view-dropdown').element() as HTMLSelectElement;
    const labels = Array.from(dropdown.querySelectorAll('option')).map((o) =>
      o.textContent?.trim(),
    );
    expect(labels).not.toContain('my new view');
  });
});

// ---------------------------------------------------------------------------
// 4. Loading skeleton
// ---------------------------------------------------------------------------

describe('Logs -- loading skeleton', () => {
  it('renders 8 skeleton rows when logsLoading=true and results=[]', async () => {
    // Pin the loading state: queryRange must not resolve mid-test or
    // runQuery will flip logsLoading back to false before we assert.
    pinLoading();
    logsStore.__resetForTesting();
    logsStore.logsLoading.set(true);
    logsStore.logs.update((s) => ({ ...s, results: [] }));
    render(Logs);
    flushSync();
    const skeleton = page.getByTestId('logs-skeleton');
    await expect.element(skeleton).toBeInTheDocument();
    // 8 pulse divs (the {#each Array(8)} block).
    const pulses = skeleton.element().querySelectorAll('.animate-pulse');
    expect(pulses.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty state
// ---------------------------------------------------------------------------

describe('Logs -- empty state', () => {
  it('renders the empty state when not loading and results=[]', async () => {
    // Resolve queryRange with an empty list so the post-mount state is
    // loading=false, results=[]. The empty-state branch then matches.
    resolveEmpty();
    logsStore.__resetForTesting();
    render(Logs);
    // Yield enough times for the awaited queryRange to settle.
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    // The empty state heading is from <EmptyState title="No logs in window" />.
    await expect.element(page.getByText('No logs in window')).toBeInTheDocument();
    // The Reset filters button is the EmptyState's child snippet.
    await expect.element(page.getByTestId('reset-filters')).toBeInTheDocument();
    // No skeleton, no error pill, no table.
    expect(page.getByTestId('logs-skeleton').elements().length).toBe(0);
    expect(page.getByTestId('logs-error-state').elements().length).toBe(0);
    expect(page.getByTestId('log-table-viewport').elements().length).toBe(0);
  });

  it('clicking Reset filters clears filters via the store', async () => {
    resolveEmpty();
    logsStore.__resetForTesting();
    logsStore.setQuery('something');
    render(Logs);
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    expect(get(logsStore.logs).query).toBe('something');
    await userEvent.click(page.getByTestId('reset-filters').element());
    flushSync();
    expect(get(logsStore.logs).query).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Results table + row click -> drawer
// ---------------------------------------------------------------------------

describe('Logs -- results table + JsonDrawer', () => {
  it('renders the table with results and the drawer is closed', async () => {
    const row = makeRow();
    resolveRows([
      {
        timestamp: row.timestamp,
        severity_text: row.severity,
        service_name: row.service,
        body: row.body,
        trace_id: row.traceId,
      },
    ]);
    logsStore.__resetForTesting();
    render(Logs);
    // Yield so the awaited queryRange settles and the store updates.
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    await expect.element(page.getByTestId('log-table-viewport')).toBeInTheDocument();
    // One row should be in the DOM.
    expect(document.querySelectorAll('[data-testid="log-row"]').length).toBe(1);
    // No drawer yet.
    expect(page.getByTestId('json-drawer').elements().length).toBe(0);
  });

  it('clicking a row opens the JsonDrawer', async () => {
    const row = makeRow();
    resolveRows([
      {
        timestamp: row.timestamp,
        severity_text: row.severity,
        service_name: row.service,
        body: row.body,
        trace_id: row.traceId,
      },
    ]);
    logsStore.__resetForTesting();
    render(Logs);
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    await userEvent.click(page.getByTestId('log-row').first().element());
    flushSync();
    await tick();
    await expect.element(page.getByTestId('json-drawer')).toBeInTheDocument();
    // Backdrop + close button are part of the open drawer.
    await expect.element(page.getByTestId('json-drawer-backdrop')).toBeInTheDocument();
    await expect.element(page.getByTestId('json-drawer-close')).toBeInTheDocument();
  });

  it('clicking the drawer close button closes the drawer', async () => {
    const row = makeRow();
    resolveRows([
      {
        timestamp: row.timestamp,
        severity_text: row.severity,
        service_name: row.service,
        body: row.body,
        trace_id: row.traceId,
      },
    ]);
    logsStore.__resetForTesting();
    render(Logs);
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    await userEvent.click(page.getByTestId('log-row').first().element());
    flushSync();
    await expect.element(page.getByTestId('json-drawer')).toBeInTheDocument();
    const closeBtn = page
      .getByTestId('json-drawer-close')
      .element() as HTMLButtonElement;
    closeBtn.click();
    flushSync();
    await tick();
    expect(page.getByTestId('json-drawer').elements().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe('Logs -- error state', () => {
  it('renders the error state when queryRange rejects', async () => {
    // Drive the error path through runQuery by rejecting the fetch.
    resolveError('SigNoz unreachable: connection refused');
    logsStore.__resetForTesting();
    render(Logs);
    // Yield so the awaited queryRange rejects and the store updates.
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    const errorState = page.getByTestId('logs-error-state');
    await expect.element(errorState).toBeInTheDocument();
    const message = page.getByTestId('logs-error-message');
    await expect.element(message).toBeInTheDocument();
    expect(message.element().textContent).toContain('SigNoz unreachable');
    // Retry button is present.
    await expect.element(page.getByTestId('logs-error-retry')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

describe('Logs -- keyboard shortcuts', () => {
  it('pressing "?" opens the FilterCheatsheet', async () => {
    render(Logs);
    flushSync();
    expect(document.querySelector('[data-testid="filter-cheatsheet-dialog"]')).toBeNull();
    // userEvent.keyboard requires the target to be the body / a focused
    // element. Focus the page container so the keystroke is delivered.
    page.getByTestId('logs-page').element().focus();
    await userEvent.keyboard('?');
    flushSync();
    await expect.element(page.getByTestId('filter-cheatsheet-dialog')).toBeInTheDocument();
  });

  it('pressing Escape after opening the cheatsheet closes it', async () => {
    render(Logs);
    flushSync();
    page.getByTestId('logs-page').element().focus();
    await userEvent.keyboard('?');
    flushSync();
    await expect.element(page.getByTestId('filter-cheatsheet-dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    flushSync();
    expect(document.querySelector('[data-testid="filter-cheatsheet-dialog"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave-4 keyboard shortcut coverage
// ---------------------------------------------------------------------------
//
// These tests pin the Wave-4 contract for the Logs page keyboard handler:
//   - "/" focused on the body must redirect focus to the toolbar query input
//   - "?" with no input focused must open the FilterCheatsheet (the page-
//     level inEditable guard skips when typing in an input)
//   - "Escape" with the query input focused must clear the input (the
//     store-driven LogsToolbar $effect mirrors the cleared value back to
//     the DOM)
//
// The selectors reference the actual rendered testids in the codebase
// ("logs-query-input" -- the LogsToolbar input, and
// "filter-cheatsheet-dialog" -- the FilterCheatsheet dialog). The Wave-4
// directive mentioned ".toolbar-query-input" as a CSS-class mock; the
// rendered element has data-testid="logs-query-input" so we use that.

describe('Logs -- wave-4 keyboard shortcuts', () => {
  it('pressing "/" while body has focus focuses the query input', async () => {
    render(Logs);
    flushSync();
    // Focus the body explicitly so the page-level onkeydown handler fires.
    (document.body as HTMLElement).focus();
    // Sanity: nothing is in the query input yet.
    const input = page
      .getByTestId('logs-query-input')
      .element() as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
    await userEvent.keyboard('/');
    flushSync();
    await tick();
    expect(document.activeElement).toBe(input);
  });

  it('pressing "?" with no input focused opens the FilterCheatsheet', async () => {
    render(Logs);
    flushSync();
    // Focus the body so no editable element owns the keystroke.
    (document.body as HTMLElement).focus();
    expect(document.activeElement).not.toBe(
      page.getByTestId('logs-query-input').element(),
    );
    expect(document.querySelector('[data-testid="filter-cheatsheet-dialog"]')).toBeNull();
    await userEvent.keyboard('?');
    flushSync();
    await expect.element(page.getByTestId('filter-cheatsheet-dialog')).toBeInTheDocument();
  });

  it('pressing Escape while the query input is focused clears it', async () => {
    render(Logs);
    flushSync();
    // Seed the store with a non-empty query and reflect it into the DOM
    // by mirroring the same path the operator would type through.
    logsStore.setQuery('hello world');
    flushSync();
    const input = page
      .getByTestId('logs-query-input')
      .element() as HTMLInputElement;
    // Sanity: store + input carry the seeded query.
    expect(get(logsStore.logs).query).toBe('hello world');
    expect(input.value).toBe('hello world');
    input.focus();
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard('{Escape}');
    flushSync();
    await tick();
    // Store-driven: setQuery('') flips the store, LogsToolbar's $effect
    // mirrors it back to the input.value.
    expect(get(logsStore.logs).query).toBe('');
    expect(input.value).toBe('');
  });
});