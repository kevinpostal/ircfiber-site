import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ApiError,
  queryRange,
  type QueryRangeRequest,
} from './signoz';

/**
 * Shared helper: build a Response-like object with the given status/body
 * without going through the network. Using `new Response(...)` keeps the
 * parsed body, statusText, and headers honest, which is what `signoz.ts`
 * actually inspects.
 */
function mockResponse(init: {
  status?: number;
  statusText?: string;
  body?: unknown;
  bodyText?: string;
}): Response {
  const status = init.status ?? 200;
  const statusText =
    init.statusText ?? (status === 200 ? 'OK' : '');
  const text =
    init.bodyText !== undefined
      ? init.bodyText
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : '';
  return new Response(text, { status, statusText });
}

/**
 * Await a promise that is expected to reject with an ApiError. Verifies
 * the shape: instance, status, and message.
 */
async function expectApiError(
  promise: Promise<unknown>,
  expected: { message: string; status: number },
): Promise<void> {
  const err = (await promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (e: unknown) => e,
  )) as unknown;
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(expected.status);
  expect((err as Error).message).toBe(expected.message);
}

/**
 * A builder-style payload resembling what logsStore will send when
 * fetching recent error logs from a single service. Kept small for
 * legibility; the test still asserts the JSON body byte-for-byte.
 */
const sampleRequest: QueryRangeRequest = {
  start: 1_700_000_000_000,
  end: 1_700_000_060_000,
  requestType: 'time_series',
  compositeQuery: {
    queryType: 'builder',
    panelType: 'graph',
    queries: [
      {
        type: 'builder_query',
        spec: {
          name: 'A',
          signal: 'logs',
          stepInterval: 60,
          filter: { expression: 'service.name = "ircfiber-gateway"' },
          aggregations: [{ expression: 'count()' }],
        },
      },
    ],
  },
};

/**
 * CASE the assertion helper: the underlying fetch options look like the
 * shape `signoz.ts` actually constructs, without leaking implementation
 * details.
 */
interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  };
}

function inspectFetchCall(spy: ReturnType<typeof vi.fn>): FetchCall {
  const [url, init] = spy.mock.calls[0] as [string, FetchCall['init']];
  return { url, init };
}

describe('signoz', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('queryRange', () => {
    it('sends POST /api/admin/logs/query_range with JSON body and returns the parsed response', async () => {
      const body = {
        status: 'success',
        data: {
          A: {
            queryName: 'A',
            series: [
              [1_700_000_000_000, 5],
              [1_700_000_060_000, 6],
            ],
          },
        },
      };
      fetchSpy.mockResolvedValueOnce(mockResponse({ status: 200, body }));

      const result = await queryRange(sampleRequest);

      // Return shape: typed fields accessible, unknown passthrough intact.
      expect(result.status).toBe('success');
      expect(result.data?.A.queryName).toBe('A');
      expect(result.data?.A.series).toEqual(body.data.A.series);

      // Outgoing call: method, URL, headers, body.
      const call = inspectFetchCall(fetchSpy);
      expect(call.url).toBe('/api/admin/logs/query_range');
      expect(call.init.method).toBe('POST');
      expect(call.init.headers['Content-Type']).toBe('application/json');
      expect(call.init.headers.Accept).toBe('application/json');
      expect(call.init.body).toBe(JSON.stringify(sampleRequest));

      // Hard requirement: NO SIGNOZ-API-KEY or Authorization headers.
      for (const [k, v] of Object.entries(call.init.headers)) {
        const lk = k.toLowerCase();
        const lv = v.toLowerCase();
        expect(lk).not.toBe('signoz-api-key');
        expect(lk).not.toBe('authorization');
        expect(lk).not.toBe('x-api-key');
        expect(lv).not.toContain('signoz');
      }
    });

    it('forwards opts.signal - aborting the external controller also aborts the fetch', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: 200, body: { data: {} } }),
      );
      const external = new AbortController();

      await queryRange(sampleRequest, { signal: external.signal });

      const call = inspectFetchCall(fetchSpy);
      // The AbortSignal passed to fetch is connected to (but distinct
      // from) the external controller. We assert the link is established.
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.init.signal.aborted).toBe(false);
      external.abort();
      expect(call.init.signal.aborted).toBe(true);
    });

    it('throws ApiError(401, "Unauthorized") on a 401 with {error: "Unauthorized"}', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: 401, body: { error: 'Unauthorized' } }),
      );
      await expectApiError(queryRange(sampleRequest), {
        message: 'Unauthorized',
        status: 401,
      });
    });

    it('extracts {error: "database exploded"} on a 500 and uses it as the message', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: 500, body: { error: 'database exploded' } }),
      );
      await expectApiError(queryRange(sampleRequest), {
        message: 'database exploded',
        status: 500,
      });
    });

    it('falls back to res.statusText when a 500 body is non-JSON HTML', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          status: 500,
          statusText: 'Internal Server Error',
          bodyText: '<html><body>nginx 500</body></html>',
        }),
      );
      await expectApiError(queryRange(sampleRequest), {
        message: 'Internal Server Error',
        status: 500,
      });
    });

    it('throws ApiError(0, "<err.message>") when fetch rejects with a network error', async () => {
      fetchSpy.mockImplementationOnce(() =>
        Promise.reject(new TypeError('fetch failed')),
      );
      await expectApiError(queryRange(sampleRequest), {
        message: 'fetch failed',
        status: 0,
      });
    });

    it('throws ApiError(0, "Request timed out") when fetch outlasts timeoutMs', async () => {
      // The mock fetch honors the AbortSignal: when signoz.ts's inner
      // AbortController fires (because the 5ms timeout elapsed), the fetch
      // promise rejects with the abort reason -- which is a DOMException
      // with name='TimeoutError' (set by signoz.ts itself). That trips
      // signoz.ts's catch block, which converts it to ApiError(0,
      // 'Request timed out'). A naive `() => new Promise(() => {})` mock
      // would never reject -- a real fetch honors abort, this fake does too.
      fetchSpy.mockImplementationOnce(
        (_url: unknown, init: { signal?: AbortSignal } | undefined) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) {
              reject(
                signal.reason ?? new DOMException('Aborted', 'AbortError'),
              );
              return;
            }
            signal.addEventListener('abort', () => {
              reject(
                signal.reason ?? new DOMException('Aborted', 'AbortError'),
              );
            });
          }),
      );

      await expectApiError(queryRange(sampleRequest, { timeoutMs: 5 }), {
        message: 'Request timed out',
        status: 0,
      });
    });

    it('does NOT time out when fetch settles well before timeoutMs', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: 200, body: { data: {} } }),
      );
      const r = await queryRange(sampleRequest, { timeoutMs: 15_000 });
      expect(r).toEqual({ data: {} });
    });
  });

  describe('gateway transport', () => {
    it('sends the admin session cookie (same-origin credentials)', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ status: 200, body: { data: {} } }),
      );
      await queryRange(sampleRequest);
      const call = inspectFetchCall(fetchSpy);
      // The gateway proxy requires the admin session: without the
      // cookie every call 401s at requireAuth.
      expect((call.init as { credentials?: string }).credentials).toBe(
        'same-origin',
      );
    });
  });
});
