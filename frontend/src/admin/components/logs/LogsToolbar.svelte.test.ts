/**
 * LogsToolbar -- query bar + service multi-select + severity chips + time
 * picker + live toggle + copy-as-cURL export.
 *
 * Pattern follows App.test.ts: `render` from `vitest-browser-svelte`,
 * `page` + `userEvent` from `vitest/browser`, `flushSync` from `svelte`.
 * Real logsStore is used -- we reset it via the existing __resetForTesting
 * hook in beforeEach so each case starts from a known state, and we mock
 * `signoz.services` so the lazy-load path is observable.
 *
 * Timers: the browser-playwright provider does not reliably honor
 * vi.useFakeTimers (App.test.ts notes the same constraint for setInterval).
 * The toolbar's 200ms debounce is therefore tested with real timers and a
 * 250ms `setTimeout` wait, not with vi.advanceTimersByTime. This is the
 * same trade-off the rest of the suite makes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import { get } from 'svelte/store';
import { flushSync } from 'svelte';

import LogsToolbar from './LogsToolbar.svelte';
import * as store from '../../stores/logsStore';
import * as liveTail from '../../stores/logsLiveTail';
import { services as signozServices } from '/src/lib/signoz';

vi.mock('/src/lib/signoz', () => ({
  services: vi.fn(),
  queryRange: vi.fn(),
  fields: vi.fn(),
  fieldValues: vi.fn(),
  // currentUser() and wsUrl() are needed by logsLiveTail.startLiveTail's
  // openConnection() path. The real currentUser hits /api/v1/user; the
  // tests stub it to return a synthetic orgId so the WS URL can be
  // built without a real fetch.
  currentUser: vi.fn(async () => ({ data: { orgId: 'test-org' } })),
  wsUrl: vi.fn((orgId: string) => `/signoz/ws/logs/v5/${orgId}`),
  ApiError: class extends Error {
    readonly status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

// --- ui.ts side-effect observation (w3-t2) -------------------------------
// The toolbar imports `toastError` from `'../../stores/ui'`. In
// vitest's browser-mode runner, vi.mock for relative paths does NOT
// reliably override the toolbar's compiled import binding (the
// toolbar's runtime sees the real module, not our mock). To work
// around that we observe the side effect of the real toastError: it
// pushes a Toast record into the `toasts` writable. Tests assert on
// `get(toasts)` instead of spying on the function.
//
// We don't vi.mock the module at all so the toolbar's import resolves
// to the real implementation, and reading `toasts` from the real
// module reflects what was pushed.

// --- WebSocket stub (w3-t2) -----------------------------------------------
// The toolbar's wire-up effect calls the REAL startLiveTail (from
// logsLiveTail.ts), which constructs a `new WebSocket(...)` and waits
// for onopen/onmessage/onclose events. The native browser WebSocket in
// vitest's playwright mode would hit a real (failing) connection; we
// replace it with a no-op class that records construction calls so
// tests can assert "startLiveTail was called" via the side-effect on
// the liveTailStatus writable (it transitions to 'connecting' on call)
// without any network activity. Tests drive the WS lifecycle manually
// via `stub.fire('open' | 'message' | 'error' | 'close')`.
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  static lastInstance(): StubWebSocket | null {
    const all = StubWebSocket.instances;
    return all.length === 0 ? null : (all[all.length - 1] as StubWebSocket);
  }
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
    // The WS stays in the 'connecting' state by default. Tests can
    // call `fire('open')` / `fire('close')` / `fire('message', payload)`
    // on the instance to drive the production code's event handlers.
    // Auto-fire onclose was deliberately removed so the reconnect
    // cycle doesn't kick in mid-test; tests that need reconnect behavior
    // fire `close` explicitly.
  }
  fire(type: 'open' | 'message' | 'error' | 'close', payload?: unknown): void {
    if (type === 'open' && this.onopen) this.onopen(new Event('open'));
    else if (type === 'message' && this.onmessage)
      this.onmessage(new MessageEvent('message', { data: payload as string }));
    else if (type === 'error' && this.onerror) this.onerror(new Event('error'));
    else if (type === 'close' && this.onclose) this.onclose(new CloseEvent('close'));
  }
}
beforeEach(() => {
  StubWebSocket.instances = [];
  vi.stubGlobal('WebSocket', StubWebSocket);
});

// `signozServices` is the vi.fn() from the vi.mock factory above. The
// cast through `unknown` is necessary because the static import sees the
// real type (Promise<ServicesResponse>) while the test runtime sees the
// vi.fn() value -- vitest's hoisting of vi.mock above the import line
// is what makes this safe.
const mockedServices = signozServices as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Wipe localStorage and reset the store to a known baseline. The
  // store's __resetForTesting hook also resets the new wsReady /
  // wsLastAttemptAt writables that this toolbar depends on.
  window.localStorage.clear();
  store.__resetForTesting();
  // Reset the liveTail module's state via its __resetForTesting hook so
  // a stale 'closed' status from a prior case doesn't auto-flip the
  // toggle via the toolbar's permanent-error effect.
  liveTail.__resetForTesting();
  // Clear any StubWebSocket instances carried over from a prior test
  // (each beforeEach re-stubs the global above).
  StubWebSocket.instances = [];
  vi.stubGlobal('WebSocket', StubWebSocket);
  // Default services() mock: empty list, but resolves so the dropdown
  // transitions out of "Loading..." after the lazy-load fires.
  mockedServices.mockReset();
  mockedServices.mockResolvedValue({ data: [] });
  // Default clipboard: present + working. Individual cases override.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore the real clipboard so the next test's beforeEach can
  // redefine it. Some browser environments ship a read-only
  // `navigator.clipboard` getter; clearing the override via
  // configurable:true above is sufficient.
});

// ---------------------------------------------------------------------------
// Default render
// ---------------------------------------------------------------------------

describe('LogsToolbar -- default render', () => {
  it('mounts with the documented default state', async () => {
    render(LogsToolbar);
    const root = page.getByTestId('logs-toolbar');
    await expect.element(root).toBeInTheDocument();
    // Query input starts empty and reflects the store's default ('').
    const input = page.getByTestId('logs-query-input');
    await expect.element(input).toBeInTheDocument();
    expect((input.element() as HTMLInputElement).value).toBe('');
    // Severity row exists, copy-cURL button exists, live toggle exists.
    await expect.element(page.getByTestId('logs-severity-row')).toBeInTheDocument();
    await expect.element(page.getByTestId('logs-copy-curl')).toBeInTheDocument();
    await expect.element(page.getByTestId('logs-live-toggle')).toBeInTheDocument();
  });

  it('highlights WARN + ERROR severity chips by default', async () => {
    render(LogsToolbar);
    flushSync();
    const warn = page.getByTestId('logs-severity-WARN');
    const error = page.getByTestId('logs-severity-ERROR');
    const info = page.getByTestId('logs-severity-INFO');
    expect((warn.element() as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((error.element() as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((info.element() as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the 5m preset as active by default', async () => {
    render(LogsToolbar);
    flushSync();
    const m5 = page.getByTestId('logs-preset-5m');
    const h1 = page.getByTestId('logs-preset-1h');
    expect((m5.element() as HTMLButtonElement).className).toContain('font-semibold');
    expect((h1.element() as HTMLButtonElement).className).not.toContain('font-semibold');
  });

  it('does NOT fetch /api/v1/services on mount (lazy-load guard)', async () => {
    render(LogsToolbar);
    // No timer advance / no interaction -- services() must not have fired.
    expect(mockedServices).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Query input debounce
// ---------------------------------------------------------------------------

describe('LogsToolbar -- query input debounce', () => {
  it('updates store.query after the 200ms debounce, not synchronously', async () => {
    render(LogsToolbar);
    const input = page.getByTestId('logs-query-input').element() as HTMLInputElement;
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Within the debounce window, the store has not been committed yet.
    expect(get(store.logs).query).toBe('');
    await new Promise<void>((r) => setTimeout(r, 250));
    expect(get(store.logs).query).toBe('hello');
  });

  it('coalesces multiple keystrokes into one setQuery call (latest value wins)', async () => {
    render(LogsToolbar);
    const input = page.getByTestId('logs-query-input').element() as HTMLInputElement;
    for (const v of ['f', 'fo', 'foo']) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>((r) => setTimeout(r, 30));
    }
    // Each input fires the toolbar's debounce; only the last one within
    // 200ms survives. After waiting past the debounce, the store carries
    // the final value.
    await new Promise<void>((r) => setTimeout(r, 250));
    expect(get(store.logs).query).toBe('foo');
  });
});

// ---------------------------------------------------------------------------
// Severity chip toggles
// ---------------------------------------------------------------------------

describe('LogsToolbar -- severity chip toggles', () => {
  it('toggles a non-default severity on, then off', async () => {
    render(LogsToolbar);
    flushSync();
    const info = page.getByTestId('logs-severity-INFO');
    await userEvent.click(info.element());
    flushSync();
    expect(get(store.logs).severities).toContain('INFO');
    expect((info.element() as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    // Click again to remove.
    await userEvent.click(info.element());
    flushSync();
    expect(get(store.logs).severities).not.toContain('INFO');
    expect((info.element() as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles a default severity (WARN) off, leaving the other default (ERROR)', async () => {
    render(LogsToolbar);
    flushSync();
    const warn = page.getByTestId('logs-severity-WARN');
    await userEvent.click(warn.element());
    flushSync();
    const sevs = get(store.logs).severities;
    expect(sevs).not.toContain('WARN');
    expect(sevs).toContain('ERROR');
  });
});

// ---------------------------------------------------------------------------
// Time-range picker
// ---------------------------------------------------------------------------

describe('LogsToolbar -- time-range picker', () => {
  it('clicking 1h preset sets timeRange.label to 1h with the right span', async () => {
    render(LogsToolbar);
    flushSync();
    const before = Date.now();
    await userEvent.click(page.getByTestId('logs-preset-1h').element());
    flushSync();
    const tr = get(store.logs).timeRange;
    expect(tr.label).toBe('1h');
    // end should be near "now" and start should be 1h earlier (60 * 60_000).
    expect(tr.end).toBeGreaterThanOrEqual(before);
    expect(tr.end - tr.start).toBe(60 * 60_000);
  });

  it('clicking 5m preset sets timeRange.label to 5m with the right span', async () => {
    render(LogsToolbar);
    flushSync();
    await userEvent.click(page.getByTestId('logs-preset-5m').element());
    flushSync();
    const tr = get(store.logs).timeRange;
    expect(tr.label).toBe('5m');
    expect(tr.end - tr.start).toBe(5 * 60_000);
  });

  it('clicking the "..." button opens the custom datetime form', async () => {
    render(LogsToolbar);
    flushSync();
    await userEvent.click(page.getByTestId('logs-preset-custom').element());
    flushSync();
    await expect.element(page.getByTestId('logs-custom-form')).toBeInTheDocument();
  });

  it('custom form submit sets a timeRange with label=custom', async () => {
    render(LogsToolbar);
    flushSync();
    await userEvent.click(page.getByTestId('logs-preset-custom').element());
    flushSync();
    // datetime-local input values are "YYYY-MM-DDTHH:MM".
    const start = '2026-06-30T10:00';
    const end = '2026-06-30T11:30';
    const startEl = document.querySelector(
      '[data-testid="logs-custom-form"] input[aria-label="Start time"]',
    ) as HTMLInputElement;
    const endEl = document.querySelector(
      '[data-testid="logs-custom-form"] input[aria-label="End time"]',
    ) as HTMLInputElement;
    startEl.value = start;
    endEl.value = end;
    startEl.dispatchEvent(new Event('input', { bubbles: true }));
    endEl.dispatchEvent(new Event('input', { bubbles: true }));
    await userEvent.click(page.getByTestId('logs-custom-apply').element());
    flushSync();
    const tr = get(store.logs).timeRange;
    expect(tr.label).toBe('custom');
    expect(new Date(start).getTime()).toBe(tr.start);
    expect(new Date(end).getTime()).toBe(tr.end);
  });
});

// ---------------------------------------------------------------------------
// Live toggle + status badge
// ---------------------------------------------------------------------------

describe('LogsToolbar -- live toggle + status badge', () => {
  it('clicking the live toggle flips logsLive and shows the live-only row', async () => {
    render(LogsToolbar);
    flushSync();
    expect(get(store.logsLive)).toBe(false);
    // Pre-toggle: time presets are visible, live row is not.
    await expect.element(page.getByTestId('logs-preset-5m')).toBeInTheDocument();
    expect(page.getByTestId('logs-live-row').elements().length).toBe(0);
    await userEvent.click(page.getByTestId('logs-live-toggle').element());
    flushSync();
    expect(get(store.logsLive)).toBe(true);
    // Post-toggle: time presets are hidden, live row appears with the
    // "Stop live" button.
    expect(page.getByTestId('logs-preset-5m').elements().length).toBe(0);
    await expect.element(page.getByTestId('logs-live-row')).toBeInTheDocument();
    await expect.element(page.getByTestId('logs-stop-live')).toBeInTheDocument();
    // "Live since" pill replaces the time picker.
    await expect.element(page.getByTestId('logs-live-since')).toBeInTheDocument();
  });

  it('shows the "Live unavailable" pill when live=true and wsReady=closed', async () => {
    store.__resetForTesting();
    store.toggleLive(); // logsLive = true (triggers wire-up -> startLiveTail on mount)
    render(LogsToolbar);
    flushSync();
    // The wire-up effect's startLiveTail() sets wsReady to 'closed'
    // (via toWsReady('connecting')); that's the state we want to assert
    // on, so no override needed.
    await expect.element(page.getByTestId('live-status-pill')).toBeInTheDocument();
    const text = (page.getByTestId('live-status-pill').element() as HTMLElement).textContent ?? '';
    expect(text.trim()).toBe('Live unavailable');
  });

  it('shows the "Live" pill when live=true and wsReady=open', async () => {
    store.__resetForTesting();
    store.toggleLive(); // logsLive = true (triggers wire-up -> startLiveTail on mount)
    render(LogsToolbar);
    flushSync();
    // Override the wsReady state set by the wire-up effect so we can
    // observe the pill rendering for the 'open' branch.
    store.wsReady.set('open');
    flushSync();
    const pill = page.getByTestId('live-status-pill');
    const text = (pill.element() as HTMLElement).textContent ?? '';
    expect(text.trim()).toBe('Live');
  });

  it('shows the "Reconnecting" pill with attempt count when live=true and wsReady=reconnecting', async () => {
    store.__resetForTesting();
    store.toggleLive();
    render(LogsToolbar);
    flushSync();
    // Override the wire-up-set state for this assertion.
    store.wsReady.set('reconnecting');
    liveTail.liveTailAttempt.set(3);
    flushSync();
    const pill = page.getByTestId('live-status-pill');
    const text = (pill.element() as HTMLElement).textContent ?? '';
    expect(text.trim()).toBe('Reconnecting... (attempt 3)');
  });

  it('hides the status pill entirely when logsLive is false', async () => {
    store.__resetForTesting();
    store.wsReady.set('open'); // would render a pill if live=true
    render(LogsToolbar);
    flushSync();
    expect(page.getByTestId('logs-live-row').elements().length).toBe(0);
    expect(page.getByTestId('live-status-pill').elements().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Live toggle wire-up to logsLiveTail + auto-toggle on permanent failure
// (w3-t2)
// ---------------------------------------------------------------------------
//
// These tests verify the toolbar's two $effect blocks that bridge
// `logsLive` to the WS lifecycle:
//   - The wire-up effect: flips of `logsLive` (false -> true) call
//     `startLiveTail(filter)`; flips the other way (true -> false) call
//     `stopLiveTail()`.
//   - The auto-toggle effect: `liveTailStatus === 'closed'` while
//     `logsLive === true` flips the toggle back to false and surfaces a
//     toast via `toastError`.
//
// Verification strategy: because vi.mock with relative import paths is
// unreliable for Svelte components in the browser-mode vitest runner, we
// run the REAL startLiveTail / stopLiveTail / toastError (with the
// /src/lib/signoz mocks providing the orgId + wsUrl) and observe the
// SIDE EFFECTS:
//   - `liveTailStatus` becomes 'connecting' on startLiveTail().
//   - `liveTailStatus` becomes 'idle' on stopLiveTail().
//   - `StubWebSocket.instances` increments by one per startLiveTail().
//   - `toastError` pushes a Toast record onto the `toasts` writable.

describe('LogsToolbar -- live toggle wire-up to logsLiveTail (w3-t2)', () => {
  it('clicking the live toggle calls startLiveTail with a filter snapshot', async () => {
    render(LogsToolbar);
    flushSync();
    // Initial state: logsLive=false, no WS constructed.
    expect(get(store.logsLive)).toBe(false);
    expect(StubWebSocket.instances.length).toBe(0);
    // Flip the toggle -> wire-up effect should construct a WS (via
    // startLiveTail) and push a filter object that mirrors the store.
    await userEvent.click(page.getByTestId('logs-live-toggle').element());
    flushSync();
    expect(get(store.logsLive)).toBe(true);
    // startLiveTail constructed exactly one WebSocket against the mocked
    // wsUrl('/signoz/ws/logs/v5/test-org').
    expect(StubWebSocket.instances.length).toBe(1);
    expect(StubWebSocket.lastInstance()!.url).toMatch(
      /\/signoz\/ws\/logs\/v5\/test-org$/,
    );
    // Fire the onopen event so the WS layer runs its onopen handler,
    // which calls sendFilter() with the filter snapshot.
    StubWebSocket.lastInstance()!.fire('open');
    flushSync();
    // The WS sent the initial filter envelope via `send(...)` -- the
    // mock records it so we can assert the filter shape without parsing
    // the WS wire format.
    const sendCalls = StubWebSocket.lastInstance()!.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const envelope = JSON.parse(sendCalls[0]![0] as string) as {
      filter: string;
      severities: string[];
      services: string[];
    };
    expect(envelope).toEqual({
      filter: '',
      severities: ['WARN', 'ERROR'],
      services: [],
    });
  });

  it('toggling live off after on calls stopLiveTail (closes the WS)', async () => {
    render(LogsToolbar);
    flushSync();
    // Toggle on
    await userEvent.click(page.getByTestId('logs-live-toggle').element());
    flushSync();
    expect(StubWebSocket.instances.length).toBe(1);
    expect(get(liveTail.liveTailStatus)).toBe('connecting');
    // Toggle off -> wire-up effect calls stopLiveTail() which closes the
    // socket and resets status to 'idle'.
    await userEvent.click(page.getByTestId('logs-live-toggle').element());
    flushSync();
    expect(get(store.logsLive)).toBe(false);
    expect(get(liveTail.liveTailStatus)).toBe('idle');
    expect(StubWebSocket.lastInstance()!.close).toHaveBeenCalled();
  });

  it('hides the time-range picker while live is on', async () => {
    render(LogsToolbar);
    flushSync();
    // Pre-toggle: time presets are visible.
    await expect.element(page.getByTestId('logs-preset-5m')).toBeInTheDocument();
    await userEvent.click(page.getByTestId('logs-live-toggle').element());
    flushSync();
    // Post-toggle: time presets are hidden -- they're replaced by the
    // "Live since" pill in the same row.
    expect(page.getByTestId('logs-preset-5m').elements().length).toBe(0);
    expect(page.getByTestId('logs-preset-1h').elements().length).toBe(0);
    expect(page.getByTestId('logs-preset-custom').elements().length).toBe(0);
  });

  it('auto-toggles off and toasts on permanent error (liveTailStatus=closed while live=true)', async () => {
    // Set up the toolbar with logsLive=true (so the wire-up effect runs
    // startLiveTail on mount and the toolbar is "streaming"). Then,
    // AFTER mount, drive liveTailStatus to 'closed' to simulate the WS
    // layer hitting MAX_ATTEMPTS -- that's the trigger the auto-toggle
    // effect watches for.
    store.__resetForTesting();
    // Reset the toast stack so the assertion below sees only toasts
    // pushed by THIS test.
    const uiModule = await import('../../stores/ui');
    uiModule.toasts.set([]);
    store.toggleLive(); // logsLive = true
    render(LogsToolbar);
    flushSync();
    // The wire-up effect ran startLiveTail() on mount, which resets
    // liveTailError to null and liveTailStatus to 'connecting'. Override
    // BOTH now to simulate the WS layer hitting MAX_ATTEMPTS:
    liveTail.liveTailError.set('Live tail unavailable after 10 attempts');
    liveTail.liveTailStatus.set('closed');
    flushSync();
    // The auto-toggle effect should have flipped logsLive back to false
    // (via toggleLive) and called toastError with the error message.
    expect(get(store.logsLive)).toBe(false);
    // The cascade: toggleLive() flipping logsLive to false fires the
    // wire-up effect, which calls stopLiveTail() (real) -> resets
    // liveTailStatus to 'idle'.
    expect(get(liveTail.liveTailStatus)).toBe('idle');
    // The toastError side effect: a Toast with the error message and
    // kind='error' was pushed onto the toasts writable.
    const toasts = get(uiModule.toasts);
    expect(toasts.length).toBeGreaterThanOrEqual(1);
    expect(toasts[toasts.length - 1]!.kind).toBe('error');
    expect(toasts[toasts.length - 1]!.message).toBe(
      'Live tail unavailable after 10 attempts',
    );
    expect(toasts[toasts.length - 1]!.ttlMs).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// Service multi-select (lazy-load + diff)
// ---------------------------------------------------------------------------

describe('LogsToolbar -- service multi-select', () => {
  it('fetches services on first click and renders them as <option> entries', async () => {
    mockedServices.mockResolvedValue({
      data: ['irc-fiber-gateway', 'irc-fiber-engine', 'signoz-otel-collector'],
    });
    render(LogsToolbar);
    flushSync();
    // No fetch on mount.
    expect(mockedServices).not.toHaveBeenCalled();
    // Click the select to trigger the lazy load.
    const select = page.getByTestId('logs-services-select').element() as HTMLSelectElement;
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Wait for the microtask chain (services() is async) to flush.
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    expect(mockedServices).toHaveBeenCalledTimes(1);
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).toContain('irc-fiber-gateway');
    expect(options).toContain('irc-fiber-engine');
    expect(options).toContain('signoz-otel-collector');
  });

  it('does not refetch services on subsequent opens (servicesLoaded guard)', async () => {
    mockedServices.mockResolvedValue({ data: ['a'] });
    render(LogsToolbar);
    const select = page.getByTestId('logs-services-select').element() as HTMLSelectElement;
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise<void>((r) => setTimeout(r, 30));
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(mockedServices).toHaveBeenCalledTimes(1);
  });

  it('selecting a service writes to store.services and renders a chip', async () => {
    mockedServices.mockResolvedValue({ data: ['gateway', 'engine'] });
    render(LogsToolbar);
    flushSync();
    // Prime the lazy load.
    const select = page.getByTestId('logs-services-select').element() as HTMLSelectElement;
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise<void>((r) => setTimeout(r, 30));
    flushSync();
    // Simulate the user picking an option via the multi-select control.
    // The native control uses .selected on <option> elements which the
    // browser populates when the user Ctrl+clicks. We mirror that here
    // by directly toggling the option and dispatching change.
    const target = Array.from(select.querySelectorAll('option')).find(
      (o) => o.value === 'gateway',
    ) as HTMLOptionElement | undefined;
    expect(target).toBeTruthy();
    target!.selected = true;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(get(store.logs).services).toContain('gateway');
    const activeRow = page.getByTestId('logs-services-active');
    await expect.element(activeRow).toBeInTheDocument();
    expect((activeRow.element() as HTMLElement).textContent ?? '').toContain('gateway');
  });
});

// ---------------------------------------------------------------------------
// Copy as cURL
// ---------------------------------------------------------------------------

describe('LogsToolbar -- copy as cURL', () => {
  // Helper: stub the store with a lastQueryBody so the copy path has
  // something concrete to serialize.
  function seedLastQueryBody(): void {
    store.logs.update((s) => ({
      ...s,
      lastQueryBody: {
        start: 1_700_000_000_000,
        end: 1_700_000_060_000,
        requestType: 'raw',
        schemaVersion: 'v1',
        compositeQuery: {
          queryType: 'builder',
          panelType: 'list',
          queries: [
            {
              type: 'builder_query',
              spec: {
                name: 'A',
                signal: 'logs',
                stepInterval: null,
                filter: { expression: "severity_text IN ('ERROR')" },
              },
            },
          ],
        },
      },
    }));
  }

  it('writes a curl -sS -X POST command with the rendered body to the clipboard', async () => {
    seedLastQueryBody();
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeSpy },
      configurable: true,
      writable: true,
    });
    render(LogsToolbar);
    flushSync();
    await userEvent.click(page.getByTestId('logs-copy-curl').element());
    // The toolbar awaits the clipboard write before flipping copyState
    // to 'copied' -- wait a microtask for the promise to resolve.
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const cmd = writeSpy.mock.calls[0]![0] as string;
    expect(cmd).toMatch(/^curl -sS -X POST 'https?:\/\/[^/]+\/api\/v5\/query_range'/);
    expect(cmd).toContain("-H 'Content-Type: application/json'");
    expect(cmd).toContain('-d \'');
    expect(cmd).toContain('"severity_text IN');
    // No auth header line -- the browser must never see SIGNOZ-API-KEY.
    expect(cmd).not.toMatch(/Authorization/i);
    expect(cmd).not.toMatch(/SIGNOZ-API-KEY/i);
    expect(cmd).not.toMatch(/x-api-key/i);
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    seedLastQueryBody();
    // Strip the clipboard API entirely.
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const execSpy = vi.fn().mockReturnValue(true);
    // document.execCommand('copy') is on the legacy Document interface.
    // Some test envs already stub it; otherwise we monkey-patch.
    const origExec = document.execCommand?.bind(document);
    document.execCommand = execSpy as unknown as typeof document.execCommand;
    render(LogsToolbar);
    flushSync();
    await userEvent.click(page.getByTestId('logs-copy-curl').element());
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(execSpy).toHaveBeenCalledWith('copy');
    // Restore for the next test.
    if (origExec) document.execCommand = origExec as typeof document.execCommand;
  });

  it('recovers via the textarea+execCommand fallback when clipboard.writeText rejects', async () => {
    seedLastQueryBody();
    const writeSpy = vi.fn().mockRejectedValue(new Error('clipboard blocked'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeSpy },
      configurable: true,
      writable: true,
    });
    const execSpy = vi.fn().mockReturnValue(true);
    const origExec = document.execCommand?.bind(document);
    document.execCommand = execSpy as unknown as typeof document.execCommand;
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(LogsToolbar);
    flushSync();
    // The toolbar's writeClipboard() catches the rejection and falls
    // through to the textarea+execCommand path. The onCopyCurl click
    // handler therefore resolves without an exception -- no toast,
    // no thrown promise, no console.error noise for the user.
    await userEvent.click(page.getByTestId('logs-copy-curl').element());
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).toHaveBeenCalledWith('copy');
    expect(consoleErr).not.toHaveBeenCalled();
    if (origExec) document.execCommand = origExec as typeof document.execCommand;
  });
});
