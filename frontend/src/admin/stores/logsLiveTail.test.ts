/**
 * logsLiveTail -- polling live tail over the gateway proxy.
 *
 * Mirrors the existing test patterns in this directory:
 *   - real timers with short `setTimeout` waits (the
 *     browser-playwright provider does not reliably honor
 *     vi.useFakeTimers -- see LogsToolbar.svelte.test.ts)
 *   - `vi.stubGlobal('fetch', ...)` so queryRange() resolves against a
 *     canned SigNoz envelope (the real fetch is non-configurable in
 *     vitest's playwright-browser mode)
 *   - `__resetForTesting()` in beforeEach to wipe module-scoped state
 *     (the static-import + browser cache combo makes
 *     `vi.resetModules()` unreliable -- see logsStore.test.ts)
 *   - `__setPollIntervalForTesting(50)` to shrink the 5s production
 *     cadence so interval tests finish in hundreds of ms
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import * as mod from './logsLiveTail';
import * as logs from './logsStore';
import { toasts } from './ui';

// ── Fetch mock ─────────────────────────────────────────────────────────────

function mockListResponse(list: unknown[], status = 200): Response {
  return new Response(JSON.stringify({ data: { A: { list } } }), {
    status,
  });
}

function row(ts: number, body: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: ts,
    severity_text: 'INFO',
    service_name: 'ircfiber-gateway',
    body,
    ...extra,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

// ── Lifecycle / setup ──────────────────────────────────────────────────────

function wait(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  mod.__resetForTesting();
  logs.__resetForTesting();
  toasts.set([]);
  mod.__setPollIntervalForTesting(50);
});

afterEach(() => {
  mod.__resetForTesting();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function lastRequestBody(): Record<string, any> {
  const calls = fetchSpy.mock.calls;
  const init = calls[calls.length - 1][1] as { body?: string };
  return JSON.parse(init.body ?? '{}') as Record<string, any>;
}

function expressionOf(body: Record<string, any>): string {
  return body.compositeQuery.queries[0].spec.filter.expression as string;
}

/** Wait until the tail reaches a status (throws on timeout so a stuck
 *  tail fails loudly instead of hanging the suite). */
async function waitForStatus(
  s: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed',
  timeoutMs = 3000,
): Promise<void> {
  const t0 = Date.now();
  while (get(mod.liveTailStatus) !== s) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for live-tail status ${s}`);
    }
    await wait(25);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('logsLiveTail: status writable contract', () => {
  it('initial status is idle', () => {
    expect(get(mod.liveTailStatus)).toBe('idle');
  });

  it('LiveTailStatus is a string literal union, not an enum', () => {
    const values: readonly mod.LiveTailStatus[] = [
      'idle',
      'connecting',
      'open',
      'reconnecting',
      'closed',
    ];
    expect(values).toEqual([
      'idle',
      'connecting',
      'open',
      'reconnecting',
      'closed',
    ]);
    mod.liveTailStatus.set('connecting');
    expect(get(mod.liveTailStatus)).toBe('connecting');
  });
});

describe('logsLiveTail: start polls the gateway proxy', () => {
  it('runs an immediate queryRange POST and opens on success', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([row(1_700_000_000_000, 'hello')])));
    mod.startLiveTail({});
    expect(get(mod.liveTailStatus)).toBe('connecting');
    await waitForStatus('open');

    expect(get(logs.logsLive)).toBe(true);
    mod.stopLiveTail();
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, { method: string }];
    expect(url).toBe('/api/admin/logs/query_range');
    expect(init.method).toBe('POST');
    expect(get(logs.logs).results).toHaveLength(1);
    expect(get(logs.logs).results[0]?.body).toBe('hello');
  });

  it('serializes the filter snapshot into builder clauses', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    mod.startLiveTail({
      query: 'boom',
      severities: ['ERROR'],
      services: ['ircfiber-engine'],
    });
    await wait(150);

    const expr = expressionOf(lastRequestBody());
    expect(expr).toContain(`severity_text IN ('ERROR')`);
    expect(expr).toContain(`service.name IN ('ircfiber-engine')`);
    expect(expr).toContain(`body CONTAINS 'boom'`);
  });

  it('second startLiveTail while open is a no-op (single interval)', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    mod.startLiveTail({});
    await waitForStatus('open');
    // A redundant start must not fire a second immediate poll: the
    // call count synchronously after the call is unchanged (an
    // interval tick cannot fire synchronously).
    const calls = fetchSpy.mock.calls.length;
    mod.startLiveTail({});
    expect(fetchSpy.mock.calls.length).toBe(calls);
    expect(get(mod.liveTailStatus)).toBe('open');
    mod.stopLiveTail();
  });
});

describe('logsLiveTail: interval re-poll + dedup', () => {
  it('appends new rows on each tick and skips already-seen ids', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockListResponse([row(100, 'first'), row(200, 'second')]),
    );
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        mockListResponse([row(100, 'first'), row(200, 'second'), row(300, 'third')]),
      ),
    );
    mod.startLiveTail({});
    await wait(300);
    const bodies = get(logs.logs).results.map((r) => r.body);
    expect(bodies).toContain('first');
    expect(bodies).toContain('second');
    expect(bodies).toContain('third');
    expect(bodies.filter((b) => b === 'first')).toHaveLength(1);
    expect(bodies.filter((b) => b === 'second')).toHaveLength(1);
  });

  it('skips rows older than the newest appended row even with unseen ids', async () => {
    fetchSpy.mockResolvedValueOnce(mockListResponse([row(500, 'new')]));
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        mockListResponse([row(400, 'late-duplicate'), row(600, 'next')]),
      ),
    );
    mod.startLiveTail({});
    await wait(300);
    const bodies = get(logs.logs).results.map((r) => r.body);
    expect(bodies).toContain('new');
    expect(bodies).toContain('next');
    expect(bodies).not.toContain('late-duplicate');
  });

  it('drops rows that fail the LogRow contract silently', async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        mockListResponse([
          row(100, 'ok'),
          { timestamp: 101, severity_text: 'NOPE', body: 'bad sev' },
          'not-an-object',
        ]),
      ),
    );
    mod.startLiveTail({});
    await wait(200);
    expect(get(logs.logs).results.map((r) => r.body)).toEqual(['ok']);
  });
});

describe('logsLiveTail: stopLiveTail() cleanup', () => {
  it('clears the interval and resets status to idle', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    mod.startLiveTail({});
    await wait(150);
    expect(get(mod.liveTailStatus)).toBe('open');

    mod.stopLiveTail();
    expect(get(mod.liveTailStatus)).toBe('idle');
    expect(get(logs.logsLive)).toBe(false);
    const calls = fetchSpy.mock.calls.length;
    await wait(200);
    // No further interval ticks after stop.
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it('is safe to call when already idle', () => {
    expect(() => mod.stopLiveTail()).not.toThrow();
    expect(get(mod.liveTailStatus)).toBe('idle');
  });
});

describe('logsLiveTail: failure counting + 10-failure cap', () => {
  it('a failed poll flips to reconnecting and recovers on the next success', async () => {
    // Fail everything first so the tail deterministically lands in
    // reconnecting (no later tick can succeed early and mask it).
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    mod.startLiveTail({});
    await waitForStatus('reconnecting');
    expect(get(mod.liveTailAttempt)).toBeGreaterThanOrEqual(1);

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([row(100, 'back')])));
    await waitForStatus('open');
    expect(get(mod.liveTailAttempt)).toBe(0);
    expect(get(logs.logs).results).toHaveLength(1);
    mod.stopLiveTail();
  });

  it('after 10 consecutive failures status becomes closed with an error', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    mod.startLiveTail({});
    // Immediate poll + 9 interval ticks at 50ms = 10 failures.
    await wait(800);
    expect(get(mod.liveTailStatus)).toBe('closed');
    expect(get(mod.liveTailError)).toContain('10 attempts');
    const callsAfterClose = fetchSpy.mock.calls.length;
    await wait(200);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterClose);
  });

  it('startLiveTail from closed resets the counter and retries', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    mod.startLiveTail({});
    await wait(800);
    expect(get(mod.liveTailStatus)).toBe('closed');

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    mod.startLiveTail({});
    await wait(150);
    expect(get(mod.liveTailStatus)).toBe('open');
    expect(get(mod.liveTailAttempt)).toBe(0);
    expect(get(mod.liveTailError)).toBeNull();
  });
});

describe('logsLiveTail: exponential backoff schedule (delayForAttempt)', () => {
  it('backoff schedule progresses 1s, 2s, 4s, 8s, 16s, 30s with +/-20% jitter', () => {
    const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    for (let n = 1; n <= 6; n++) {
      for (let i = 0; i < 25; i++) {
        const d = mod.delayForAttempt(n);
        expect(d).toBeGreaterThanOrEqual(Math.max(1_000, bases[n - 1]! * 0.8 - 1));
        expect(d).toBeLessThanOrEqual(bases[n - 1]! * 1.2 + 1);
      }
    }
    // Caps at 30s past the end of the table.
    expect(mod.delayForAttempt(99)).toBeLessThanOrEqual(30_000 * 1.2 + 1);
  });
});

describe('logsLiveTail: status -> wsReady mirroring', () => {
  it('drives logsStore.wsReady through the open / reconnecting / closed lifecycle', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    mod.startLiveTail({});
    await waitForStatus('reconnecting');
    expect(get(logs.wsReady)).toBe('reconnecting');

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    await waitForStatus('open');
    expect(get(logs.wsReady)).toBe('open');

    mod.stopLiveTail();
    expect(get(logs.wsReady)).toBe('closed');
  });
});

describe('logsLiveTail: isLiveTailActive() predicate', () => {
  it('returns true only for connecting/open/reconnecting', async () => {
    expect(mod.isLiveTailActive()).toBe(false);
    fetchSpy.mockImplementation(() => Promise.resolve(mockListResponse([])));
    mod.startLiveTail({});
    expect(mod.isLiveTailActive()).toBe(true);
    await wait(150);
    expect(mod.isLiveTailActive()).toBe(true);
    mod.stopLiveTail();
    expect(mod.isLiveTailActive()).toBe(false);
  });
});
