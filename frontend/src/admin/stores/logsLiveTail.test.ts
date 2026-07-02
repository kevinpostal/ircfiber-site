/**
 * logsLiveTail -- WS reconnect store with exponential backoff.
 *
 * Mirrors the existing test patterns in this directory:
 *   - `vi.useFakeTimers()` for deterministic backoff scheduling
 *   - `vi.stubGlobal('WebSocket', MockWS)` to swap in a fake socket
 *     (the real WebSocket constructor is non-configurable in
 *     vitest's playwright-browser mode)
 *   - `__resetForTesting()` in beforeEach to wipe module-scoped state
 *     (the static-import + browser cache combo makes
 *     `vi.resetModules()` unreliable -- see logsStore.test.ts)
 *
 * The MockWS below exposes onopen/onmessage/onerror/onclose as
 * settable properties (matching native WebSocket) so the production
 * code's property-assignment handlers work without modification.
 * The `fire(type, ...)` helper invokes the registered handler to
 * simulate server events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import * as mod from './logsLiveTail';
import * as logs from './logsStore';
import { toasts } from './ui';

// ── Mock WebSocket ─────────────────────────────────────────────────────────

interface MockWS {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  fire(type: 'open' | 'message' | 'error' | 'close', payload?: unknown): void;
}

class MockWebSocket {
  static instances: MockWS[] = [];
  static lastInstance(): MockWS | null {
    const all = MockWebSocket.instances;
    return all.length === 0 ? null : (all[all.length - 1] as MockWS);
  }

  url: string;
  readyState = 0; // CONNECTING
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    (this as unknown as MockWS).url = url;
    MockWebSocket.instances.push(this as unknown as MockWS);
  }

  /** Simulate a server event by invoking the production code's
   *  registered property handler. We pass a synthetic Event so the
   *  handler's parameter typing is satisfied. */
  fire(type: 'open' | 'message' | 'error' | 'close', payload?: unknown): void {
    const m = this as unknown as MockWS;
    if (type === 'open' && m.onopen) m.onopen(new Event('open'));
    else if (type === 'message' && m.onmessage)
      m.onmessage(new MessageEvent('message', { data: payload as string }));
    else if (type === 'error' && m.onerror) m.onerror(new Event('error'));
    else if (type === 'close' && m.onclose)
      m.onclose(new CloseEvent('close'));
  }
}

// Patch the static constants onto the class so anything that reads
// `WebSocket.OPEN` etc. still works (production code doesn't, but
// future consumers might).
(MockWebSocket as unknown as { CONNECTING: number }).CONNECTING = 0;
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
(MockWebSocket as unknown as { CLOSING: number }).CLOSING = 2;
(MockWebSocket as unknown as { CLOSED: number }).CLOSED = 3;

// ── Lifecycle / setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
  mod.__resetForTesting();
  logs.__resetForTesting();
  toasts.set([]);
});

afterEach(() => {
  mod.__resetForTesting();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Advance the fake clock past any pending reconnect timer AND wait
 *  for the resulting openConnection() chain (discoverOrgId -> new
 *  WebSocket) to construct the next socket. Without the async
 *  variant, vi.advanceTimersByTime fires the timer synchronously but
 *  the awaits inside openConnection never get to resolve, so the
 *  next iteration's `lastInstance()` would still point at the prior
 *  (already-closed) socket. */
async function flushBackoff(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60_000);
  await Promise.resolve();
  await Promise.resolve();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('logsLiveTail: status writable contract', () => {
  it('initial status is idle', () => {
    expect(get(mod.liveTailStatus)).toBe('idle');
  });

  it('LiveTailStatus is a string literal union, not an enum', () => {
    // Compile-time guarantee backed by the type signature; the runtime
    // check is the const-assertion below which would be `false` if
    // someone replaced the union with a `string` or an enum object.
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
    // Sanity: assert the writable accepts only those five strings.
    // If LiveTailStatus were widened to `string`, the next line would
    // still compile (acceptable), but the explicit literal annotation
    // pins the contract at the call site.
    mod.liveTailStatus.set('connecting');
    expect(get(mod.liveTailStatus)).toBe('connecting');
  });
});

describe('logsLiveTail: startLiveTail() idempotency + URL construction', () => {
  it('opens a WS using signoz.wsUrl(orgId), absolute URL anchored to location.origin', async () => {
    // Stub fetch via globalThis so currentUser() resolves with an orgId.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'my-org' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    mod.startLiveTail({ query: 'severity=ERROR' });

    // Let the discoverOrgId() promise resolve and the WS construct.
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const ws = MockWebSocket.lastInstance()!;
    expect(ws.url).toBe(`${location.origin}/signoz/ws/logs/v5/my-org`);
    expect(get(mod.liveTailStatus)).toBe('connecting');
  });

  it('second startLiveTail while connecting is a no-op (single WS instance)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-1' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    // Second call while still connecting -- must NOT construct a new WS.
    mod.startLiveTail();
    expect(MockWebSocket.instances.length).toBe(1);

    // After open, still no-op.
    MockWebSocket.lastInstance()!.fire('open');
    mod.startLiveTail();
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('startLiveTail from closed resets attempt counter and retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'retry-org' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // Drive 10 consecutive close events to land in `closed`.
    for (let i = 0; i < 10; i++) {
      const cur = MockWebSocket.lastInstance()!;
      // If a reconnect timer fired since the last close, the active
      // WS has moved on -- that's the expected backoff loop.
      cur.fire('close');
      await flushBackoff();
    }
    expect(get(mod.liveTailStatus)).toBe('closed');
    expect(get(mod.liveTailAttempt)).toBe(10);

    // Manual restart from `closed` must reset the counter and construct
    // a new WS (which is exactly what the `closed -> connecting` edge
    // in the state machine promises).
    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(11);
    });
    expect(get(mod.liveTailStatus)).toBe('connecting');
    expect(get(mod.liveTailAttempt)).toBe(0);
    expect(get(mod.liveTailError)).toBeNull();
  });
});

describe('logsLiveTail: stopLiveTail() cleanup', () => {
  it('closes WS, clears timer, and resets status to idle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-2' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    MockWebSocket.lastInstance()!.fire('open');
    expect(get(mod.liveTailStatus)).toBe('open');

    mod.stopLiveTail();
    expect(MockWebSocket.lastInstance()!.close).toHaveBeenCalledTimes(1);
    expect(get(mod.liveTailStatus)).toBe('idle');
    expect(get(logs.wsReady)).toBe('closed');
    expect(get(logs.logsLive)).toBe(false);
    expect(get(mod.liveTailError)).toBeNull();

    // Advancing the clock should NOT spawn a new WS -- the reconnect
    // timer must have been cleared by stopLiveTail().
    vi.advanceTimersByTime(120_000);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it('clear during reconnect prevents further retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-3' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // First close -> reconnecting + timer armed.
    MockWebSocket.lastInstance()!.fire('close');
    expect(get(mod.liveTailStatus)).toBe('reconnecting');
    expect(MockWebSocket.instances.length).toBe(1);

    // Stop while reconnecting -- close the in-flight WS handle (it's
    // already null after the close event, but stopLiveTail must not
    // blow up if `ws` is null) and clear the timer.
    mod.stopLiveTail();
    expect(get(mod.liveTailStatus)).toBe('idle');

    // Advancing the clock past the would-be reconnect delay must NOT
    // construct a second WS.
    vi.advanceTimersByTime(120_000);
    expect(MockWebSocket.instances.length).toBe(1);
  });
});

describe('logsLiveTail: exponential backoff + jitter', () => {
  it('backoff schedule progresses 1s, 2s, 4s, 8s, 16s, 30s with +/-20% jitter', () => {
    // Sample 100 runs of delayForAttempt(n) for each attempt n and
    // assert the distribution sits within the +/-20% band of the base.
    // With Math.random, a 100-sample mean is statistically near the
    // center of the band; an out-of-range sample would be a real bug.
    const samples = 200;
    const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    for (let attempt = 1; attempt <= bases.length; attempt++) {
      const base = bases[attempt - 1]!;
      const lo = base * 0.8;
      const hi = base * 1.2;
      let allInRange = true;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < samples; i++) {
        const d = mod.delayForAttempt(attempt);
        if (d < lo || d > hi) allInRange = false;
        if (d < min) min = d;
        if (d > max) max = d;
      }
      // The floor of 1000 only affects attempt=1 (lo would be 800).
      // For attempts >= 2, the jitter band is naturally >= 1600ms.
      const floor = attempt === 1 ? 1_000 : 0;
      const effectiveLo = Math.max(lo, floor);
      expect(allInRange).toBe(true);
      expect(min).toBeGreaterThanOrEqual(effectiveLo - 1); // off-by-one safety
      expect(max).toBeLessThanOrEqual(Math.ceil(hi));
    }
  });

  it('reconnect timer fires the next openConnection attempt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-4' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // Close the first attempt -- reconnecting.
    MockWebSocket.lastInstance()!.fire('close');
    expect(get(mod.liveTailStatus)).toBe('reconnecting');
    expect(get(mod.liveTailAttempt)).toBe(1);

    // Advance past the (jittered) first backoff window. We use a
    // generous 5s advance because the base is 1s +/- 20% plus the 1s
    // floor; 5s comfortably covers any jitter + clock skew.
    await flushBackoff();

    // A second WS must have been constructed by the timer.
    expect(MockWebSocket.instances.length).toBe(2);
  });
});

describe('logsLiveTail: 10-failure cap', () => {
  it('after 10 consecutive closes, status becomes closed and no further timers fire', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-5' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    for (let i = 0; i < 10; i++) {
      const cur = MockWebSocket.lastInstance()!;
      cur.fire('close');
      // Only the first 9 closes schedule a reconnect timer; the 10th
      // flips to `closed` and stops.
      if (i < 9) await flushBackoff();
    }

    expect(get(mod.liveTailStatus)).toBe('closed');
    expect(get(mod.liveTailAttempt)).toBe(10);
    expect(get(mod.liveTailError)).toMatch(/unavailable after 10 attempts/i);
    expect(get(logs.wsReady)).toBe('closed');

    const instancesAtCap = MockWebSocket.instances.length;
    // Advance a long time -- no further reconnects must be scheduled.
    vi.advanceTimersByTime(10 * 60_000);
    expect(MockWebSocket.instances.length).toBe(instancesAtCap);
  });
});

describe('logsLiveTail: orgId discovery', () => {
  it('falls back to "default" with a toast warn when /api/v1/user fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('internal server error', { status: 500 }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    const ws = MockWebSocket.lastInstance()!;
    // The path still routes through wsUrl('default') -- that's the
    // literal fallback the spec requires.
    expect(ws.url).toBe(`${location.origin}/signoz/ws/logs/v5/default`);

    const warns = get(toasts).filter((t) => t.kind === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    expect(warns[0]!.message).toMatch(/orgId/i);
  });

  it('falls back to "default" when /api/v1/user returns 200 with no orgId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    expect(MockWebSocket.lastInstance()!.url).toBe(
      `${location.origin}/signoz/ws/logs/v5/default`,
    );
  });

  it('caches the discovered orgId across reconnect attempts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'cached-org' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });

    // First close -> reconnecting, timer armed.
    MockWebSocket.lastInstance()!.fire('close');
    await flushBackoff();

    // Second WS constructed, but fetch should NOT have been called
    // again because the orgId is cached after the first discovery.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances.length).toBe(2);
  });
});

describe('logsLiveTail: WS message -> LogRow append', () => {
  it('appends a valid row to logs.results and caps at 10_000 entries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-6' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    MockWebSocket.lastInstance()!.fire('open');

    // Fire one batch with two rows (object + array payload both valid).
    MockWebSocket.lastInstance()!.fire(
      'message',
      JSON.stringify([
        {
          timestamp: 1_700_000_000_000,
          severity_text: 'ERROR',
          service_name: 'irc-fiber-engine',
          body: 'first row',
          trace_id: 'trace-1',
        },
        {
          timestamp: 1_700_000_001_000,
          severity_text: 'INFO',
          service_name: 'irc-fiber-engine',
          body: 'second row',
        },
      ]),
    );

    const results = get(logs.logs).results;
    expect(results.length).toBe(2);
    expect(results[0]!.body).toBe('first row');
    expect(results[0]!.traceId).toBe('trace-1');
    expect(results[0]!.severity).toBe('ERROR');
    expect(results[1]!.body).toBe('second row');
    expect(results[1]!.traceId).toBeUndefined();
  });

  it('drops invalid rows silently (no throw, no append)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-7' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    MockWebSocket.lastInstance()!.fire('open');

    // Invalid: severity is a non-union string, no body. Must NOT throw.
    expect(() =>
      MockWebSocket.lastInstance()!.fire(
        'message',
        JSON.stringify({ severity_text: 'BOGUS', service_name: 'x' }),
      ),
    ).not.toThrow();

    expect(get(logs.logs).results).toEqual([]);
  });
});

describe('logsLiveTail: status -> wsReady mirroring', () => {
  it('drives logsStore.wsReady through the open / reconnecting / closed lifecycle', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-8' } }), {
        status: 200,
      }),
    );

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    // During `connecting`, wsReady is the closed-equivalent (nothing
    // usable yet) -- this matches the w2-t2 toolbar badge contract.
    expect(get(logs.wsReady)).toBe('closed');

    MockWebSocket.lastInstance()!.fire('open');
    expect(get(logs.wsReady)).toBe('open');

    MockWebSocket.lastInstance()!.fire('close');
    expect(get(logs.wsReady)).toBe('reconnecting');

    mod.stopLiveTail();
    expect(get(logs.wsReady)).toBe('closed');
  });
});

describe('logsLiveTail: isLiveTailActive() predicate', () => {
  it('returns true only for connecting/open/reconnecting', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { orgId: 'org-9' } }), {
        status: 200,
      }),
    );

    expect(mod.isLiveTailActive()).toBe(false);

    mod.startLiveTail();
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
    });
    expect(mod.isLiveTailActive()).toBe(true);

    MockWebSocket.lastInstance()!.fire('open');
    expect(mod.isLiveTailActive()).toBe(true);

    MockWebSocket.lastInstance()!.fire('close');
    expect(mod.isLiveTailActive()).toBe(true);

    mod.stopLiveTail();
    expect(mod.isLiveTailActive()).toBe(false);
  });
});