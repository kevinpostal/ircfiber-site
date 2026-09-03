/**
 * logsStore -- query state + debounced fetch for the admin Logs panel.
 *
 * Pattern mirrors dashboard.test.ts / savedViews.test.ts: named writables
 * imported from the source, `vi.spyOn(globalThis, 'fetch')` for the HTTP
 * surface, `vi.useFakeTimers()` for the 200ms debounce. Tests run under
 * the `client` vitest project (chromium, fileParallelism:false) so the
 * module-scoped store + persistence subscription do not bleed across
 * cases -- `resetFilters()` in beforeEach wipes state, `localStorage.clear`
 * wipes persistence, and the persistence-round-trip case uses the
 * `mod = await import(...)` pattern savedViews.test.ts established:
 *
 *   In browser mode Vite caches the module URL, so `vi.resetModules()`
 *   alone is not enough -- we also append a cache-busting query string
 *   to force re-evaluation. Without it, `await import('./logsStore')`
 *   returns the same instance as the static top-of-file import, and the
 *   restore-on-init test would observe the OLD state.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import * as store from './logsStore';
import type { LogsState, TimeRange } from './logsStore';

const PERSIST_KEY = 'ircfiber:admin:logs:lastQuery';

/**
 * Build a Response carrying the JSON body the SigNoz v5 envelope expects.
 * Using new Response keeps statusText + body parsing honest for signoz.ts.
 */
function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Flush pending microtasks so an awaited fetch spy resolution propagates
 * through signoz.ts's `await res.text()` + JSON.parse + store updates.
 * Five ticks is more than enough for the chain; we don't advance the
 * fake clock so the 15s request timeout in signoz.ts stays dormant.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  store.resetFilters();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Default state --------------------------------------------------------

describe('logsStore -- default state', () => {
  it('exports logs with the documented initial shape', () => {
    const s: LogsState = get(store.logs);
    expect(s.query).toBe('');
    expect(s.services).toEqual([]);
    expect(s.severities).toEqual([...store.DEFAULT_SEVERITIES]);
    expect(s.timeRange.label).toBe('5m');
    expect(typeof s.timeRange.start).toBe('number');
    expect(typeof s.timeRange.end).toBe('number');
    expect(s.timeRange.end).toBeGreaterThan(s.timeRange.start);
    expect(s.results).toEqual([]);
    expect(s.totalRows).toBe(0);
    expect(s.expandedRowIds.size).toBe(0);
    expect(s.lastQueryBody).toBeNull();
  });

  it('logsLoading / logsError / logsLive are false / null / false', () => {
    expect(get(store.logsLoading)).toBe(false);
    expect(get(store.logsError)).toBeNull();
    expect(get(store.logsLive)).toBe(false);
  });
});

// --- setQuery + debounce --------------------------------------------------

describe('logsStore -- setQuery and debounce', () => {
  it('setQuery updates the query field synchronously (before debounce fires)', () => {
    store.setQuery('hello');
    expect(get(store.logs).query).toBe('hello');
  });

  it('setQuery does not trigger a fetch within the 200ms debounce window', () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setQuery('hello');
    vi.advanceTimersByTime(100);
    expect(spy).not.toHaveBeenCalled();
  });

  it('coalesces multiple setQuery calls within 200ms into a single fetch', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setQuery('f');
    vi.advanceTimersByTime(50);
    store.setQuery('fo');
    vi.advanceTimersByTime(50);
    store.setQuery('foo');
    // Total 100ms since first setQuery, 0ms since last -- debounce window not exhausted.
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
    // Body uses the latest query value, not an intermediate one.
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.compositeQuery.queries[0].spec.filter.expression).toContain("body CONTAINS 'foo'");
  });

  it('hits POST /api/admin/logs/query_range with the current start/end and filter', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setQuery('hello');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/admin/logs/query_range');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.start).toBe(get(store.logs).timeRange.start);
    expect(body.end).toBe(get(store.logs).timeRange.end);
    expect(body.compositeQuery.queryType).toBe('builder');
    expect(body.compositeQuery.panelType).toBe('list');
    expect(body.requestType).toBe('raw');
    expect(body.compositeQuery.queries[0].type).toBe('builder_query');
    expect(body.compositeQuery.queries[0].spec.signal).toBe('logs');
    expect(body.compositeQuery.queries[0].spec.name).toBe('A');
  });

  it('includes severity_text IN clause for the active severities', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setSeverity('INFO');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    const expr: string = body.compositeQuery.queries[0].spec.filter.expression;
    // Severities preserve Set insertion order: defaults are [WARN, ERROR],
    // toggling INFO on appends it. The exact order isn't part of the
    // contract -- only the membership is.
    expect(expr).toMatch(/severity_text IN \('WARN','ERROR','INFO'\)/);
    expect(expr).toContain("severity_text IN (");
    expect(expr).toContain("'WARN'");
    expect(expr).toContain("'ERROR'");
    expect(expr).toContain("'INFO'");
  });

  it('includes service.name IN clause when services are selected', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setService('irc-fiber-engine');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    const expr: string = body.compositeQuery.queries[0].spec.filter.expression;
    expect(expr).toContain("service.name IN ('irc-fiber-engine')");
  });

  it('emits an empty filter expression when query, services, severities are all empty', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    // Drain the default severities back to empty via the toggle API.
    store.resetFilters();
    store.setSeverity(null); // resets to DEFAULT_SEVERITIES
    store.setSeverity('WARN');
    store.setSeverity('ERROR');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.compositeQuery.queries[0].spec.filter.expression).toBe('');
  });
});

// --- runQuery() immediate path --------------------------------------------

describe('logsStore -- runQuery immediate fetch', () => {
  it('runQuery fires immediately without waiting for the debounce window', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    await store.runQuery();
    expect(spy).toHaveBeenCalledTimes(1);
    // No timer advance was needed -- debounce is for setQuery, not runQuery.
  });

  it('runQuery skips any pending debounced refetch scheduled by setQuery', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setQuery('hello'); // schedules a debounced refetch
    await store.runQuery(); // fires now and clears the pending debounce
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500); // past where the debounce would have fired
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stores the request body in lastQueryBody for "copy as cURL"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse({ status: 'success', data: { A: { list: [] } } }),
    );
    await store.runQuery();
    const body = get(store.logs).lastQueryBody;
    expect(body).not.toBeNull();
    expect((body as { start: number }).start).toBe(get(store.logs).timeRange.start);
  });
});

// --- Success / error mapping ----------------------------------------------

describe('logsStore -- success and error mapping', () => {
  it('populates results with parsed LogRows on success', async () => {
    const row = {
      timestamp: 1_700_000_000_000,
      severity_text: 'INFO',
      service_name: 'irc-fiber-gateway',
      body: 'hello world',
      trace_id: 'abc123',
      attributes: { foo: 'bar' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse({ status: 'success', data: { A: { list: [row] } } }),
    );
    await store.runQuery();
    const results = get(store.logs).results;
    expect(results).toHaveLength(1);
    expect(results[0]!.body).toBe('hello world');
    expect(results[0]!.service).toBe('irc-fiber-gateway');
    expect(results[0]!.severity).toBe('INFO');
    expect(results[0]!.timestamp).toBe(1_700_000_000_000);
    expect(results[0]!.traceId).toBe('abc123');
    expect(results[0]!.attributes).toEqual({ foo: 'bar' });
    expect(results[0]!.rawJson).toMatchObject(row);
    expect(get(store.logs).totalRows).toBe(1);
    expect(get(store.logsLoading)).toBe(false);
    expect(get(store.logsError)).toBeNull();
  });

  it('reports the ApiError message in logsError on failure', async () => {
    // Force an error by mocking fetch to reject with an Error containing a
    // message -- signoz.ts wraps non-TimeoutError throws in ApiError with
    // the original message preserved.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    await store.runQuery();
    expect(get(store.logsError)).toBe('boom');
    expect(get(store.logsLoading)).toBe(false);
    expect(get(store.logs).results).toEqual([]);
  });

  it('clears a stale logsError at the start of a new runQuery', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('first'));
    await store.runQuery();
    expect(get(store.logsError)).toBe('first');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeResponse({ status: 'success', data: { A: { list: [] } } }),
    );
    await store.runQuery();
    expect(get(store.logsError)).toBeNull();
  });
});

// --- cancelQuery ----------------------------------------------------------

describe('logsStore -- cancelQuery', () => {
  it('aborts the in-flight request via the AbortSignal passed to fetch', async () => {
    let capturedSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: unknown, init?: RequestInit) => {
      capturedSignal = (init?.signal as AbortSignal | undefined) ?? null;
      // Reject on abort so the awaited runQuery settles.
      return new Promise<Response>((_resolve, reject) => {
        if (capturedSignal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    const p = store.runQuery();
    await flushMicrotasks();
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);
    store.cancelQuery();
    expect(capturedSignal!.aborted).toBe(true);
    await p;
    expect(get(store.logsLoading)).toBe(false);
    // Aborted runs do NOT surface as logsError -- silent cancel.
    expect(get(store.logsError)).toBeNull();
  });

  it('cancels a pending debounced refetch', () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setQuery('hello'); // schedules 200ms debounce
    store.cancelQuery(); // clears it
    vi.advanceTimersByTime(500);
    expect(spy).not.toHaveBeenCalled();
  });
});

// --- Severity / service toggles ------------------------------------------

describe('logsStore -- severity toggle (multi-select)', () => {
  it('toggles a severity on, then off', () => {
    store.setSeverity('INFO');
    expect(get(store.logs).severities).toContain('INFO');
    store.setSeverity('INFO');
    expect(get(store.logs).severities).not.toContain('INFO');
  });

  it('null resets to the DEFAULT_SEVERITIES array', () => {
    store.setSeverity('INFO');
    store.setSeverity(null);
    expect(get(store.logs).severities).toEqual([...store.DEFAULT_SEVERITIES]);
  });

  it('setSeverity triggers a debounced refetch after 200ms', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setSeverity('INFO');
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('logsStore -- service toggle (multi-select)', () => {
  it('toggles a service name in and out of the array', () => {
    store.setService('irc-fiber-engine');
    expect(get(store.logs).services).toEqual(['irc-fiber-engine']);
    store.setService('irc-fiber-engine');
    expect(get(store.logs).services).toEqual([]);
  });

  it('null / empty clears the services array', () => {
    store.setService('a');
    store.setService('b');
    expect(get(store.logs).services).toEqual(['a', 'b']);
    store.setService(null);
    expect(get(store.logs).services).toEqual([]);
  });
});

// --- setTimeRange ---------------------------------------------------------

describe('logsStore -- setTimeRange', () => {
  it('updates the time range synchronously', () => {
    const range: TimeRange = { label: '1h', start: 1_000, end: 2_000 };
    store.setTimeRange(range);
    expect(get(store.logs).timeRange).toEqual(range);
  });

  it('triggers a debounced refetch after 200ms', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse({ status: 'success', data: { A: { list: [] } } }));
    store.setTimeRange({ label: '3h', start: 100, end: 200 });
    vi.advanceTimersByTime(200);
    await flushMicrotasks();
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0]! as [unknown, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.start).toBe(100);
    expect(body.end).toBe(200);
  });
});

// --- toggleLive + toggleExpandedRow --------------------------------------

describe('logsStore -- toggleLive', () => {
  it('flips logsLive between false and true', () => {
    expect(get(store.logsLive)).toBe(false);
    store.toggleLive();
    expect(get(store.logsLive)).toBe(true);
    store.toggleLive();
    expect(get(store.logsLive)).toBe(false);
  });
});

describe('logsStore -- toggleExpandedRow', () => {
  it('adds the id to expandedRowIds, then removes it on the second call', () => {
    store.toggleExpandedRow('row-1');
    expect(get(store.logs).expandedRowIds.has('row-1')).toBe(true);
    store.toggleExpandedRow('row-1');
    expect(get(store.logs).expandedRowIds.has('row-1')).toBe(false);
  });

  it('toggles multiple ids independently', () => {
    store.toggleExpandedRow('row-1');
    store.toggleExpandedRow('row-2');
    expect(get(store.logs).expandedRowIds.has('row-1')).toBe(true);
    expect(get(store.logs).expandedRowIds.has('row-2')).toBe(true);
    store.toggleExpandedRow('row-1');
    expect(get(store.logs).expandedRowIds.has('row-1')).toBe(false);
    expect(get(store.logs).expandedRowIds.has('row-2')).toBe(true);
  });
});

// --- resetFilters ---------------------------------------------------------

describe('logsStore -- resetFilters', () => {
  it('restores query, services, severities, timeRange to defaults', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse({ status: 'success', data: { A: { list: [] } } }),
    );
    store.setQuery('something');
    store.setService('svc');
    store.setSeverity('DEBUG');
    store.setTimeRange({ label: '24h', start: 1, end: 2 });
    store.toggleExpandedRow('row-x');
    await store.runQuery();
    store.resetFilters();
    const s = get(store.logs);
    expect(s.query).toBe('');
    expect(s.services).toEqual([]);
    expect(s.severities).toEqual([...store.DEFAULT_SEVERITIES]);
    expect(s.timeRange.label).toBe('5m');
    expect(s.expandedRowIds.size).toBe(0);
    expect(s.lastQueryBody).toBeNull();
  });

  it('persists the default lastQuery to localStorage under the envelope key', () => {
    store.setQuery('junk');
    store.resetFilters();
    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(parsed.query).toBe('');
    expect(parsed.services).toEqual([]);
    expect(parsed.severities).toEqual([...store.DEFAULT_SEVERITIES]);
    expect((parsed.timeRange as { label: string }).label).toBe('5m');
  });
});

// --- Persistence round-trip -----------------------------------------------

describe('logsStore -- persistence round-trip', () => {
  it('writes lastQuery to localStorage on every state change', () => {
    store.setQuery('hello world');
    store.setService('my-svc');
    store.setSeverity('INFO');
    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(parsed.query).toBe('hello world');
    expect(parsed.services).toEqual(['my-svc']);
    expect(parsed.severities).toContain('INFO');
  });

  it('does NOT persist results / lastQueryBody / expandedRowIds / totalRows', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse({ status: 'success', data: { A: { list: [] } } }),
    );
    await store.runQuery();
    // After a fetch, lastQueryBody is populated but should still be excluded.
    const raw = window.localStorage.getItem(PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('results');
    expect(parsed).not.toHaveProperty('lastQueryBody');
    expect(parsed).not.toHaveProperty('expandedRowIds');
    expect(parsed).not.toHaveProperty('totalRows');
  });

  it('restores the seeded lastQuery on store init (via __resetForTesting)', () => {
    // Seed localStorage AFTER clearing it, then call the test-only reset
    // hook that re-runs initialState() against the fresh payload. The
    // hook mirrors savedViews.ts's __resetForTesting pattern and is the
    // only deterministic way to test "restore on init" in vitest's
    // browser mode (vi.resetModules alone returns the same cached module
    // instance as the static import).
    const seeded = {
      query: 'restored query',
      services: ['restored-svc'],
      severities: ['ERROR'],
      timeRange: { label: '1h', start: 1_700_000_000_000, end: 1_700_000_060_000 },
    };
    window.localStorage.setItem(PERSIST_KEY, JSON.stringify(seeded));
    store.__resetForTesting();
    const restored = get(store.logs);
    expect(restored.query).toBe('restored query');
    expect(restored.services).toEqual(['restored-svc']);
    expect(restored.severities).toEqual(['ERROR']);
    expect(restored.timeRange).toEqual(seeded.timeRange);
    // Volatile fields are NEVER restored, even if a future payload
    // accidentally carried them through.
    expect(restored.results).toEqual([]);
    expect(restored.lastQueryBody).toBeNull();
    expect(restored.expandedRowIds.size).toBe(0);
    expect(restored.totalRows).toBe(0);
  });
});